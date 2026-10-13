import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSeed, beginJob, commitTurn, emptyLibrary, newStory } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';
import { THRESHOLDS, verdictOf, decide, measureCall,
  measureAgentTurn, closePhase, recordCards, serverCard } from './gpu-measure.ts';
import type { Call, Phase, Report, Vram, WorkCase } from './gpu-measure.ts';
import { startFakeLlama, REHEARSAL_OUTPUT_TOKENS } from './fake-llama.ts';

const request: ModelRequest = { system: 'Synthetic timing test.', messages: [{ role: 'user', content: 'Continue.' }], maxOutputTokens: 1000 };
const result = (over: Partial<GenerationResult> = {}): GenerationResult => ({ text: '2026-09-20 21:00\n\nSynthetic scene.', finishReason: 'stop',
  usage: { inputTokens: 4000, cachedInputTokens: 3990, outputTokens: 100, totalTokens: 4100 }, ...over });

test('input count is a real admission bound and cancellation reaches a running stream', async () => {
  let generated = false;
  await assert.rejects(measureCall({ async countInput() { return 4001; }, async generate() { generated = true; return result(); } },
    request, { label: 'too_big', inputLimitTokens: 4000 }), { code: 'context_limit' });
  assert.equal(generated, false);
  const stop = new AbortController();
  const running = measureCall({ generate(_request, controls) {
    controls?.onStart?.();
    return new Promise((_resolve, reject) => controls?.signal?.addEventListener('abort', () => reject(controls.signal?.reason), { once: true }));
  } }, request, { label: 'cancelled', signal: stop.signal });
  stop.abort(new Error('bounded_test'));
  await assert.rejects(running, /bounded_test/);
});

function frozen(count = 2): Library {
  const state = emptyLibrary();
  const seed = addSeed(state, 'Synthetic island\n2026-09-20 21:00\nMara watches a lighthouse.');
  newStory(state, seed.id);
  for (let i = 0; i < count; i++) {
    const job = beginJob(state, `Synthetic action ${i}.`, i);
    commitTurn(state, job.id, `2026-09-20 21:00\n\nScene ${i}. ${'The light crossed the water. '.repeat(30)}`);
  }
  return state;
}

const emptyPhase = (): Phase => ({ seconds: 0, tester: [], agent: [], probes: { completed: 0, preempted: 0 },
  usefulOutputTokens: null, usefulTokensPerHour: null });
const options = { keepScenes: 2, memoryMode: 'plain' as const, maxOutputTokens: 1000, contextTokens: 65536,
  range: { min: 20, max: 1000 } };
function agentProvider(scene: () => Promise<GenerationResult> = async () => result()): Provider {
  return { async countInput(_request, controls) { controls?.onStart?.(); return 1000; },
    async generate(value, controls) {
      controls?.onStart?.();
      if (value.purpose !== 'memory') {
        // The following scene must actually contain the committed increment.
        assert.ok(value.messages.some(message => message.content.includes('The bell rang.')));
        return scene();
      }
      const input = JSON.parse(value.messages[0].content) as { newScenes: { id: string }[] };
      return result({ text: JSON.stringify({ facts: input.newScenes.map(node => ({ kind: 'event', at: '2026-09-20 21:00',
        text: 'The bell rang.', source: [node.id] })) }) });
    } };
}

test('only a valid scene using committed memory contributes useful tokens; missing usage stays unknown', async () => {
  for (const outcome of ['complete', 'cancelled', 'malformed', 'truncated', 'unknown_usage'] as const) {
    const phase = emptyPhase();
    const running = measureAgentTurn(agentProvider(async () => {
      if (outcome === 'cancelled') throw new Error('cancelled');
      return result(outcome === 'malformed' ? { text: 'broken' } : outcome === 'truncated' ? { finishReason: 'length' } : outcome === 'unknown_usage' ? { usage: undefined } : {});
    }), frozen(6), options, call => phase.agent.push(call));
    if (outcome === 'cancelled') await assert.rejects(running, /cancelled/);
    else await running;
    closePhase(phase, 100);
    const expected = { complete: 200, cancelled: 0, malformed: 0, truncated: 0, unknown_usage: null }[outcome];
    assert.equal(phase.usefulOutputTokens, expected, outcome);
    assert.equal(phase.usefulTokensPerHour, expected === null ? null : expected * 36, outcome);
  }
});

const cell: WorkCase = { id: 'synthetic-4000', fixture: 'synthetic', fixtureSha256: 'fixture', requestSha256: 'request',
  targetTokens: 4000, inputTokens: 4000, sceneCount: 6, outputCharacters: { min: 1000, max: 3000 } };
function call(over: Partial<Call> = {}): Call {
  return { label: 'tester_scene', waitMs: 0, queueMs: 0, countMs: 10, countQueueMs: 0, elapsedMs: 10000,
    totalRequestMs: 10010, firstTextFromStartMs: 100, firstTextFromRequestMs: 110, finishReason: 'stop',
    inputTokens: 4000, countedInputTokens: 4000, cachedInputTokens: 3990, outputTokens: 500, outputCharacters: 2000,
    tokensPerSecond: 50, decodeTokensPerSecond: 50, unattributedMs: 0, formatFailed: false, representative: true, useful: true,
    caseId: cell.id, cycle: 0, cacheIntent: 'warm', cacheObserved: 'warm',
    timings: { cacheTokens: 3990, promptTokens: 10, promptMs: 100, predictedTokens: 500, predictedMs: 10000 }, ...over };
}
const coldCall = () => call({ cacheIntent: 'cold', cacheObserved: 'cold', cachedInputTokens: 0,
  timings: { cacheTokens: 0, promptTokens: 4000, promptMs: 100, predictedTokens: 500, predictedMs: 10000 } });
const phase = (over: Partial<Phase> = {}): Phase => ({ seconds: 100, tester: [coldCall(), call()],
  agent: [call({ label: 'agent_scene' })], probes: { completed: 1, preempted: 0 },
  usefulOutputTokens: 1000, usefulTokensPerHour: 36000, complete: true, ...over });
const make = (over: Partial<Report> = {}): Report => ({ profile: '96k-3', startedAt: '2026-09-20T18:00:00.000Z',
  model: 'synthetic', temperature: 0.8, draft: false, server: { slots: 3, contextTokens: 98304 },
  bot: { slots: 3, poolTokens: 98304, sharedCache: true, contextTokens: 65536, maxOutputTokens: 4096,
    quietMs: 60000, readSeconds: 30, historyTokens: null },
  workload: { version: 3, fingerprint: 'same-work', cases: [cell], coldRuns: 1, warmRuns: 1, nextTurns: false,
    compactAtTokens: 44000, keepScenes: 4, memoryMode: 'plain' },
  phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 90000 }) },
  vram: { samples: 3, card: 0, cards: [{ index: 0, totalMiB: 32768, usedMiBMax: 30000, freeMiBMin: 2768, server: true }] }, ...over });
const of = (run: Report, id: number) => verdictOf(run).find(check => check.id === id)!;

test('profile decisions require representative evidence and reject measured budget failures', () => {
  assert.ok(verdictOf(make()).every(check => check.verdict === 'pass'));
  const cases: [string, Partial<Report>, number, string][] = [
    ['legacy', { workload: undefined }, 2, 'unknown'],
    ['incomplete', { phases: { solo: phase(), loaded: phase({ complete: false }) } }, 2, 'unknown'],
    ['short scene', { phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ representative: false })] }) } }, 4, 'unknown'],
    ['unconfirmed cold', { phases: { solo: phase({ tester: [call({ cacheIntent: 'cold' }), call()] }), loaded: phase() } }, 2, 'unknown'],
    ['unknown reuse', { phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ cacheObserved: 'unknown' })] }) } }, 2, 'unknown'],
    ['lost cache', { phases: { solo: phase(), loaded: phase({ tester: [coldCall(), { ...coldCall(), cacheIntent: 'warm' }] }) } }, 2, 'fail'],
    ['queue bound', { phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ queueMs: 121000 })] }) } }, 5, 'fail'],
    ['no throughput gain', { phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 39600 }) } }, 3, 'fail'],
    ['missing memory', { vram: { samples: 0, card: null, cards: [] } }, 1, 'unknown'],
    ['idle rehearsal', { phases: { solo: phase(), loaded: phase({ agent: [], probes: { completed: 0, preempted: 3 } }) } }, 3, 'unknown'],
  ];
  for (const [label, override, id, expected] of cases) {
    const report = make(override);
    assert.equal(of(report, id).verdict, expected, label);
    assert.equal(decide([report]).pool.take, null, label);
  }
  const one = make({ profile: 'one', bot: { ...make().bot, slots: 1 } });
  assert.equal(decide([one, make()]).pool.take, '96k-3');
  assert.equal(decide([one, make({ workload: { ...make().workload!, fingerprint: 'other' } })]).pool.take, null);
  const combined = make({ draft: true, vram: { samples: 1, card: 0,
    cards: [{ index: 0, totalMiB: 32768, usedMiBMax: 32100, freeMiBMin: 668, server: true }] } });
  assert.equal(decide([make(), combined]).together.verdict, 'fail');
});

test('draft speed needs the same request series and configuration, with complete server timing samples', () => {
  const plain = make();
  const fast = make({ profile: 'mtp', draft: true, phases: { solo: phase({ tester: [
    { ...coldCall(), decodeTokensPerSecond: 65 }, call({ decodeTokensPerSecond: 65 })] }), loaded: phase() } });
  assert.equal(decide([plain, fast]).draft.verdict, 'pass');
  assert.equal(decide([plain, fast]).draft.measured, '1.3x');
  assert.equal(decide([plain, { ...fast, workload: { ...fast.workload!, fingerprint: 'different' } }]).draft.verdict, 'unknown');
  assert.equal(decide([plain, { ...fast, bot: { ...fast.bot, poolTokens: 131072 } }]).draft.verdict, 'unknown');
  const missing = structuredClone(fast);
  missing.phases.solo!.tester[1].decodeTokensPerSecond = null;
  assert.equal(decide([plain, missing]).draft.verdict, 'unknown');
  const broken = structuredClone(fast);
  broken.phases.solo!.tester[1].formatFailed = true;
  assert.equal(decide([plain, broken]).draft.verdict, 'fail');
});

test('the smoke CLI saves its failed cache receipt and exits unsuccessfully', { timeout: 15000 }, async t => {
  // A fresh cwd and explicit environment prevent reading any workspace configuration. Only this loopback fake is used.
  const directory = mkdtempSync(join(tmpdir(), 'gpu-measure-smoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const caches: boolean[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as
      { cache_prompt: boolean; messages: { content: string }[] } : null;
    const send = (value: object) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (incoming.url === '/v1/models') return send({ data: [{ id: 'synthetic' }] });
    if (incoming.url === '/props') return send({ total_slots: 1, default_generation_settings: { n_ctx: 65536 } });
    const input = Math.ceil(body!.messages.reduce((sum, message) => sum + message.content.length, 0) / 4);
    if (incoming.url?.endsWith('/input_tokens')) return send({ input_tokens: input });
    assert.equal(incoming.url, '/v1/chat/completions');
    caches.push(body!.cache_prompt);
    const cached = 0;
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ model: 'synthetic', choices: [{ index: 0,
      delta: { content: '2026-09-20 21:00\n\n' + 'Синтетическая сцена. '.repeat(120) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: input, completion_tokens: 500, prompt_tokens_details: { cached_tokens: cached } },
      timings: { cache_n: cached, prompt_n: input - cached, prompt_ms: 20, predicted_n: 500, predicted_ms: 500 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const mode = ['--smoke'];
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gpu-measure.ts', import.meta.url)), ...mode, '--no-vram', '--out', directory], {
    cwd: directory, env: { PATH: dirname(process.execPath), SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_MODEL: 'synthetic',
      SIMPLE_CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, SIMPLE_CHAT_MODEL_TIMEOUT_MS: '10000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 1, stderr);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.deepEqual(caches, [false, true]);
  assert.deepEqual(saved.smoke, { passed: false, cold: 'cold', warm: 'cold' });
  assert.equal(saved.plan!.calls, 2);

});

const snapshot = (used: [number, number], pids: [number[], number[]] = [[], []]) => ({
  gpus: [0, 1].map(index => ({ index, pids: pids[index], memoryUsedMiB: used[index],
    memoryFreeMiB: 32607 - used[index] - 498, memoryTotalMiB: 32607 })),
  processes: { llamaServer: [{ pid: 108 }], sshd: {} } });

test('memory verdicts use the tightest attributed card, retain peaks, and keep unknown readings unknown', () => {
  for (const [label, pids, expectedCard, verdict] of [
    ['server on the roomy card', [[7000], [108]], 1, 'pass'],
    ['server split across cards', [[108], [108]], 0, 'fail'],
    ['no attribution', [[], []], null, 'unknown'],
  ] as [string, [number[], number[]], number | null, string][]) {
    const vram: Vram = { samples: 0, card: null, cards: [] };
    recordCards(vram, snapshot([31000, 12000], pids));
    recordCards(vram, snapshot([32000, 11000], pids));
    assert.equal(vram.card, expectedCard, label);
    assert.deepEqual(vram.cards.map(card => [card.usedMiBMax, card.freeMiBMin]), [[32000, 109], [12000, 20109]], label);
    assert.equal(of(make({ vram }), 1).verdict, verdict, label);
  }
  const unread: Vram = { samples: 0, card: null, cards: [] };
  recordCards(unread, { gpus: [snapshot([12000, 0]).gpus[0], { index: 1, pids: [108] }],
    processes: { llamaServer: [{ pid: 108 }], sshd: {} } });
  assert.equal(unread.card, 1);
  assert.equal(of(make({ vram: unread }), 1).verdict, 'unknown');
  const manual: Vram = { samples: 0, card: null, cards: [] };
  recordCards(manual, snapshot([31000, 12000]), 1);
  assert.equal(manual.card, 1);
  const driver: Vram = { samples: 0, card: null, cards: [] };
  recordCards(driver, snapshot([31000, 12000], [[7000], [108]]), 0);
  assert.equal(driver.card, 1, 'driver attribution wins over an explicit card');
  const legacy = make({ vram: { samples: 4, totalMiB: 32768, usedMiBMax: 32000, freeMiBMin: 768 } as unknown as Vram });
  assert.deepEqual(serverCard(legacy), { index: null, freeMiBMin: 768 });
  assert.equal(of(legacy, 1).verdict, 'fail');
});

// A whole measurement against local/fake-llama.ts: a loopback server with a real per-slot prefix cache, a slot that
// serves one request at a time and generation that takes the time it reports. This is the rehearsal the rented card
// does not pay for; the inline fake above answers about `cache_prompt` alone and cannot confirm a next-turn prefix.
const measurer = fileURLToPath(new URL('./gpu-measure.ts', import.meta.url));
const runMeasurer = (args: string[], environment: NodeJS.ProcessEnv, directory: string) => {
  const child = spawn(process.execPath, [measurer, ...args, '--out', directory],
    { cwd: directory, env: { PATH: dirname(process.execPath), ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, ended: new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  }) };
};

test('the whole plan runs against a fake server whose cache is real, and its cache verdicts follow it', { timeout: 60000 }, async t => {
  // An answer at least as long as the shortest frozen scene, or the replay is not representative and decides nothing.
  const fake = await startFakeLlama({ model: 'synthetic', slots: 3, contextTokens: 65536, outputTokens: REHEARSAL_OUTPUT_TOKENS,
    promptMsPerToken: 0.02, predictMsPerToken: 1, realTime: true });
  t.after(() => fake.close());
  const directory = mkdtempSync(join(tmpdir(), 'gpu-measure-fake-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_MODEL: 'synthetic',
    SIMPLE_CHAT_BASE_URL: fake.baseUrl, SIMPLE_CHAT_GPU_SLOTS: '3', SIMPLE_CHAT_MODEL_TIMEOUT_MS: '30000' };

  const smoke = runMeasurer(['--smoke', '--no-vram'], environment, directory);
  t.after(() => smoke.child.kill());
  const first = await smoke.ended;
  assert.equal(first.code, 0, first.stderr);
  const smoked = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.deepEqual(smoked.smoke, { passed: true, cold: 'cold', warm: 'warm' });

  const plan = runMeasurer(['--profile', 'fake-pool', '--history-tokens', '4000', '--cold-runs', '1', '--scenes', '1',
    '--read-seconds', '0', '--minutes', '2', '--no-vram'], environment, directory);
  t.after(() => plan.child.kill());
  const second = await plan.ended;
  assert.equal(second.code, 0, second.stderr);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.equal(saved.error, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /Синтетический ответ замера|The light crossed the water|The bell rang/);
  // The rehearsal ran the configuration the bot runs on this server: isolated slots, one whole context each.
  assert.deepEqual([saved.bot.sharedCache, saved.bot.slots, saved.bot.poolTokens], [false, 3, 65536]);
  for (const phase of [saved.phases.solo!, saved.phases.loaded!]) {
    assert.equal(phase.complete, true);
    assert.deepEqual(phase.tester.map(call => call.cacheIntent), ['cold', 'warm', 'next']);
    // Every intent is confirmed against a cache that really behaves that way, prefix by prefix. The next turn
    // re-reads its new action and scene and keeps the rest, which is what the counted prefix predicted.
    assert.deepEqual(phase.tester.map(call => call.cacheObserved), ['cold', 'warm', 'mixed']);
    assert.deepEqual(phase.tester.map(call => call.cacheMatched), [true, true, true]);
    assert.ok(phase.tester[2].timings!.promptTokens! > THRESHOLDS.cacheToleranceTokens, 'the next turn pre-fills');
    assert.ok(phase.tester.every(call => call.representative), 'scenes as long as the frozen fixture');
  }
  // The loaded phase really had work beside the tester, so its four verdicts are answers rather than 'unknown'.
  assert.ok(saved.phases.loaded!.agent.length > 0 && saved.phases.loaded!.probes.completed > 0);
  // And that work is a whole agent turn: a compaction the bot could parse, then the scene that uses the smaller
  // memory. A server that answered the memory schema with prose would fail every compaction, and the rehearsal
  // would measure a plan that never compacts, which is half the work the loaded phase is about.
  const agent = saved.phases.loaded!.agent;
  assert.ok(agent.some(call => call.label === 'agent_compaction' && call.useful), 'a compaction a scene went on to use');
  assert.ok(agent.some(call => call.label === 'agent_scene' && call.useful), JSON.stringify(agent.map(call => call.label)));
  assert.deepEqual(second.stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string })
    .filter(event => event.event === 'agent_call_failed'), []);
  const checks = verdictOf(saved);
  assert.equal(checks.find(check => check.id === 2)!.verdict, 'pass');
  assert.ok(checks.slice(1).every(check => check.verdict !== 'unknown'), JSON.stringify(checks));
  assert.equal(checks.find(check => check.id === 1)!.measured, 'not read');
});

test('video memory is sampled per card through one SSH session, and the card is the one llama-server holds', { timeout: 120000 }, async t => {
  const fake = await startFakeLlama({ model: 'synthetic', slots: 1, contextTokens: 65536, outputTokens: REHEARSAL_OUTPUT_TOKENS,
    promptMsPerToken: 0.02, predictMsPerToken: 1, realTime: true });
  t.after(() => fake.close());
  const directory = mkdtempSync(join(tmpdir(), 'gpu-measure-vram-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A stand-in for ssh that lives as long as the session it stands for: it records the session and the remote
  // command, then keeps printing what the remote script prints, one line every 60 ms, until it is killed. The
  // shebang is this very Node, because the measurer's PATH holds nothing else. Card 0 is nearly full and card 1
  // holds llama-server: a measurer that kept one number for the machine, or believed the `--card 0` given below,
  // would report the image model's shortage as this server's.
  const sessions = join(directory, 'sessions'), asked = join(directory, 'asked');
  const card = (index: number, pids: number[], used: number, free: number) =>
    ({ index, pids, memoryUsedMiB: used, memoryFreeMiB: free, memoryTotalMiB: 32607 });
  const snapshotLine = (free: number) => JSON.stringify({ at: '2026-09-21T10:00:00+00:00',
    gpus: [card(0, [7000], 31000, 700), card(1, [108], 32607 - free - 498, free)],
    processes: { llamaServer: [{ pid: 108 }], sshd: {} } });
  writeFileSync(join(directory, 'ssh'), [`#!${process.execPath}`,
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.SESSIONS, 'session\\n');",
    'fs.writeFileSync(process.env.ASKED, process.argv[process.argv.length - 1]);',
    'process.stdin.resume();',
    'let printed = 0;',
    // The card fills up while the profile runs: only a session that is still delivering sees the tighter reading.
    `setInterval(() => process.stdout.write((printed++ < 2 ? '${snapshotLine(20000)}' : '${snapshotLine(3000)}') + '\\n'), 60);`,
    ''].join('\n'));
  chmodSync(join(directory, 'ssh'), 0o700);

  const run = runMeasurer(['--smoke', '--vram-seconds', '1', '--card', '0'], { SIMPLE_CHAT_PROVIDER: 'llama-cpp',
    SIMPLE_CHAT_MODEL: 'synthetic', SIMPLE_CHAT_BASE_URL: fake.baseUrl, SIMPLE_CHAT_MODEL_TIMEOUT_MS: '30000',
    SIMPLE_CHAT_GPU_SSH_HOST: 'synthetic-host', SESSIONS: sessions, ASKED: asked,
    PATH: `${directory}:${dirname(process.execPath)}` }, directory);
  t.after(() => run.child.kill());
  const { code, stdout, stderr } = await run.ended;
  assert.equal(code, 0, stderr);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.ok(saved.vram.samples >= 3, `the cards were read ${saved.vram.samples} times`);
  assert.equal(saved.vram.card, 1);
  // The later, tighter reading of card 1 is the one kept, so the session was still delivering while the plan ran.
  assert.deepEqual(saved.vram.cards, [
    { index: 0, totalMiB: 32607, usedMiBMax: 31000, freeMiBMin: 700, server: false },
    { index: 1, totalMiB: 32607, usedMiBMax: 29109, freeMiBMin: 3000, server: true }]);
  assert.deepEqual(verdictOf(saved)[0], { id: 1, name: 'video memory at the peak', verdict: 'pass',
    measured: '3000 MiB free on card 1', threshold: '>= 1024 MiB' });
  // The hand-given card is contradicted by the driver's own attribution, and the operator is told so.
  const events = stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string; named?: number; card?: number });
  assert.deepEqual(events.filter(event => event.event === 'vram_card_mismatch'), [{ event: 'vram_card_mismatch', named: 0, card: 1 }]);
  // One login for the whole run: a session per sample was what the bot was backed off from
  // (docs/knowledge/gpu-measurements.md#ssh-failures). The session asks for the cards and the processes on them, and
  // for no server events.
  assert.equal(readFileSync(sessions, 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(asked, 'utf8'), 'python3 - --events 0 --every 1 --parts gpus,processes');
});

test('a sampler that cannot reach the instance says so while the block is still paid for', { timeout: 120000 }, async t => {
  const fake = await startFakeLlama({ model: 'synthetic', slots: 1, contextTokens: 65536, outputTokens: REHEARSAL_OUTPUT_TOKENS,
    promptMsPerToken: 0.02, predictMsPerToken: 1, realTime: true });
  t.after(() => fake.close());
  const directory = mkdtempSync(join(tmpdir(), 'gpu-measure-nossh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // An ssh that fails the way one with no route does: a message on standard error and status 255. The profile is
  // not lost because the cards cannot be read, but the operator hears it now rather than from `unknown` at the end.
  const sessions = join(directory, 'sessions');
  writeFileSync(join(directory, 'ssh'), [`#!${process.execPath}`,
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.SESSIONS, 'session\\n');",
    "process.stderr.write('ssh: connect to host PRIVATE_HOST port 40022: Connection timed out\\n');",
    'process.exit(255);', ''].join('\n'));
  chmodSync(join(directory, 'ssh'), 0o700);

  const run = runMeasurer(['--smoke', '--vram-seconds', '1'], { SIMPLE_CHAT_PROVIDER: 'llama-cpp',
    SIMPLE_CHAT_MODEL: 'synthetic', SIMPLE_CHAT_BASE_URL: fake.baseUrl, SIMPLE_CHAT_MODEL_TIMEOUT_MS: '30000',
    SIMPLE_CHAT_GPU_SSH_HOST: 'synthetic-host', SESSIONS: sessions,
    PATH: `${directory}:${dirname(process.execPath)}` }, directory);
  t.after(() => run.child.kill());
  const { code, stdout, stderr } = await run.ended;
  assert.equal(code, 0, stderr);
  assert.deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string })
    .filter(event => event.event === 'vram_sample_failed'),
  [{ event: 'vram_sample_failed', code: 'ssh_failed', reading: 'ssh_unreachable', failures: 1 }]);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.deepEqual([saved.vram.samples, saved.vram.card, saved.vram.cards], [0, null, []]);
  // One attempt in a run this short: a sampler that logged in again every couple of seconds would be the pile-up
  // on sshd the bot itself was backed off from (docs/knowledge/gpu-measurements.md#ssh-failures).
  assert.equal(readFileSync(sessions, 'utf8').trim().split('\n').length, 1);
  assert.doesNotMatch(stdout, /PRIVATE/);
});
