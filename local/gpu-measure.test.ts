import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { active, addSeed, beginJob, commitTurn, emptyLibrary, history, newStory } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { makeRequest } from './prompt.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';
import { THRESHOLDS, verdictOf, decide, measureCall, cacheState, withoutPromptCache, buildWorkload,
  summaries, measureAgentTurn, closePhase, measurementPlan, smokeOutcome, expectCache, recordCards, serverCard } from './gpu-measure.ts';
import type { Call, Phase, Report, Vram, WorkCase } from './gpu-measure.ts';
import { startFakeLlama } from './fake-llama.ts';

const request: ModelRequest = { system: 'Synthetic timing test.', messages: [{ role: 'user', content: 'Continue.' }], maxOutputTokens: 1000 };
const result = (over: Partial<GenerationResult> = {}): GenerationResult => ({ text: '2026-09-20 21:00\n\nSynthetic scene.', finishReason: 'stop',
  usage: { inputTokens: 4000, cachedInputTokens: 3990, outputTokens: 100, totalTokens: 4100 }, ...over });

test('the first nonempty delta has its own clock, before completion, and both queue waits are observed', async () => {
  let now = 100;
  const provider: Provider = {
    async countInput(seen, controls) {
      assert.equal(seen, request);
      now += 10; controls?.onStart?.(); now += 15;
      return 4000;
    },
    async generate(seen, controls) {
      assert.equal(seen, request);
      now += 20; controls?.onStart?.();
      now += 3; controls?.onText?.('');
      now += 7; controls?.onText?.('2026');
      now += 5; controls?.onText?.('-09-20');
      now += 25;
      return result({ timings: { promptMs: 6, predictedTokens: 100, predictedMs: 20 } });
    },
  };
  const { call } = await measureCall(provider, request, { label: 'clock', now: () => now });
  assert.deepEqual([call.countMs, call.countQueueMs, call.queueMs, call.elapsedMs, call.totalRequestMs], [25, 10, 30, 40, 85]);
  assert.deepEqual([call.firstTextFromStartMs, call.firstTextFromRequestMs], [10, 55]);
  assert.equal(call.decodeTokensPerSecond, 5000);
  assert.equal(call.unattributedMs, 14);
  assert.equal('transportMs' in call, false);
  assert.equal('text' in call, false);
});

test('a completed response cannot invent a dispatch time, first text, count or missing server timers', async () => {
  let now = 0;
  const { call } = await measureCall({ async generate() { now = 30; return result({ timings: { predictedTokens: 100 } }); } },
    request, { label: 'unknown', now: () => now });
  for (const key of ['countMs', 'countedInputTokens', 'queueMs', 'elapsedMs', 'firstTextFromStartMs',
    'firstTextFromRequestMs', 'decodeTokensPerSecond', 'unattributedMs'] as const) assert.equal(call[key], null, key);
  assert.equal(call.totalRequestMs, 30);
  assert.equal(call.cacheObserved, 'unknown');
});

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

test('forcing cold prefill changes only the generation body and preserves the original request', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const cold = withoutPromptCache(async (url, init) => { seen.push({ url, init }); return new Response(); });
  const signal = new AbortController().signal;
  const init = { method: 'POST', body: JSON.stringify({ cache_prompt: true, id_slot: 2, stream: true }), signal };
  await cold('http://localhost/v1/chat/completions', init);
  await cold('http://localhost/v1/chat/completions/input_tokens', init);
  await cold('http://localhost/props', init);
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { cache_prompt: false, id_slot: 2, stream: true });
  assert.equal(seen[0].init.signal, signal);
  assert.equal(seen[1].init, init);
  assert.equal(seen[2].init, init);
  assert.equal(JSON.parse(init.body).cache_prompt, true);
});

test('cold and warm labels require both server cache and prefill counters', () => {
  assert.equal(cacheState({ cacheTokens: 0, promptTokens: 4000 }, 4000), 'cold');
  assert.equal(cacheState({ cacheTokens: 3990, promptTokens: 10 }, 4000), 'warm');
  assert.equal(cacheState({ cacheTokens: 1000, promptTokens: 3000 }, 4000), 'mixed');
  assert.equal(cacheState({ cacheTokens: 3990 }, 4000), 'unknown');
  assert.equal(cacheState({ cacheTokens: 3990, promptTokens: 10 }, null), 'unknown');
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

test('history sizing counts actual makeRequest messages and repeats whole frozen scenes', async () => {
  const source = frozen();
  const seen: ModelRequest[] = [];
  const work = await buildWorkload(source, 2400, 1000, async value => {
    seen.push(value); return 1000 + value.messages.length * 100;
  });
  assert.equal(work.inputTokens, 2400);
  assert.equal(work.sceneCount, 6);
  assert.ok(seen.length > 2);
  assert.deepEqual(work.request, makeRequest(work.state, work.state.job!, 1000));
  const before = active(source), after = active(work.state);
  const originals = history(before.story, before.branch.head);
  const copied = history(after.story, after.branch.head);
  assert.deepEqual(copied.map(node => node.text), Array.from({ length: 6 }, (_, i) => originals[i % 2].text));
  assert.equal(history(before.story, before.branch.head).length, 2);
  assert.deepEqual(work.outputCharacters, { min: originals[0].text.length, max: originals[0].text.length });
  assert.deepEqual(work.previousRequest, makeRequest(work.state,
    { ...work.state.job!, head: copied.at(-1)!.parent, input: copied.at(-1)!.input }, 1000));
  assert.equal(work.previousInputTokens, 2200);
  assert.equal(work.prefixTokens, 2200);
  // The previous request wraps the last action with the narrator rule; the next stores the raw action and a scene.
  assert.notEqual(work.previousRequest.messages.at(-1)!.content, work.request.messages.at(-3)!.content);
});

test('all three checked-in frozen fixtures render through the ordinary prompt path', async () => {
  for (const name of ['battle', 'chess', 'dance']) {
    const state = (JSON.parse(readFileSync(new URL(`../examples/frozen/${name}.json`, import.meta.url), 'utf8')) as { state: Library }).state;
    // A deterministic fake server count exercises the builder; it is not a claimed token count for these fixtures.
    const work = await buildWorkload(state, 4000, 4096, async value => Math.ceil(JSON.stringify(value).length / 4));
    assert.ok(work.inputTokens <= 4000);
    assert.ok(work.sceneCount > 0);
    assert.ok(work.outputCharacters.min > 1000);
    assert.deepEqual(work.request, makeRequest(work.state, work.state.job!, 4096));
  }
});

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

test('useful compaction tokens require a valid next scene that consumed the validated increment', async () => {
  const phase = emptyPhase();
  await measureAgentTurn(agentProvider(), frozen(6), options, call => phase.agent.push(call));
  assert.deepEqual(phase.agent.map(call => [call.label, call.formatFailed, call.useful]),
    [['agent_compaction', false, true], ['agent_scene', false, true]]);
  closePhase(phase, 100);
  assert.equal(phase.usefulOutputTokens, 200);
  assert.equal(phase.usefulTokensPerHour, 7200);
});

test('abandoned extraction and malformed scenes contribute no useful tokens', async () => {
  const phase = emptyPhase();
  await assert.rejects(measureAgentTurn(agentProvider(async () => { throw new Error('cancelled'); }), frozen(6), options,
    call => phase.agent.push(call)), /cancelled/);
  closePhase(phase, 100);
  assert.equal(phase.agent.length, 1);
  assert.equal(phase.usefulOutputTokens, 0);
  await measureAgentTurn(agentProvider(async () => result({ text: 'broken' })), frozen(6), options, call => phase.agent.push(call));
  closePhase(phase, 100);
  assert.equal(phase.usefulOutputTokens, 0);
  assert.equal(phase.agent.at(-1)!.formatFailed, true);
});

test('missing usage stays unknown when useful work was completed', () => {
  const phase = emptyPhase();
  phase.tester.push(call({ useful: true, outputTokens: null }));
  closePhase(phase, 100);
  assert.equal(phase.usefulOutputTokens, null);
  assert.equal(phase.usefulTokensPerHour, null);
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
  vram: { samples: 3, card: 0, cards: [{ index: 0, totalMiB: 32768, usedMiBMax: 30000, freeMiBMin: 2768 }] }, ...over });
const of = (run: Report, id: number) => verdictOf(run).find(check => check.id === id)!;

test('a complete representative workload passes the agreed thresholds without adding latency or decode budgets', () => {
  assert.deepEqual(verdictOf(make()).map(check => check.verdict), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(of(make(), 3).measured, '2.5x');
  assert.deepEqual(THRESHOLDS, { freeVramMiB: 1024, cacheToleranceTokens: 256, throughputGain: 1.2,
    sceneSecondsUnderLoad: 10, waitSeconds: 120, draftSpeedup: 1.2 });
});

test('legacy, incomplete, unconfirmed-cold and short-scene runs cannot pass as representative workloads', () => {
  const legacy = make({ workload: undefined });
  const partial = make({ phases: { solo: phase(), loaded: phase({ complete: false }) } });
  const short = make({ phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ representative: false, outputCharacters: 100 })] }) } });
  const unconfirmed = make({ phases: { solo: phase({ tester: [call({ cacheIntent: 'cold' }), call()] }), loaded: phase() } });
  const missing = make({ phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ cacheObserved: 'unknown' })] }) } });
  for (const run of [legacy, partial, short, unconfirmed, missing]) {
    assert.deepEqual(verdictOf(run).slice(1).map(check => check.verdict), ['unknown', 'unknown', 'unknown', 'unknown']);
    assert.equal(decide([run]).pool.take, null);
  }
});

test('a cold response where warm reuse was requested fails cache retention, with the existing tolerance', () => {
  const missed = { ...coldCall(), cacheIntent: 'warm' as const };
  const run = make({ phases: { solo: phase(), loaded: phase({ tester: [coldCall(), missed] }) } });
  assert.equal(of(run, 2).verdict, 'fail');
  assert.equal(of(run, 2).measured, `${THRESHOLDS.cacheToleranceTokens - 4000} tokens of margin`);
});

test('cold prefill is reported separately and cannot redefine the agreed warm-scene budget', () => {
  const tester = [coldCall(), call({ elapsedMs: 2000 }), call({ elapsedMs: 2000 }), call({ elapsedMs: 2000 })];
  tester[0].elapsedMs = 16000;
  const run = make({ workload: { ...make().workload!, warmRuns: 3 },
    phases: { solo: phase({ tester: structuredClone(tester) }), loaded: phase({ tester }) } });
  assert.equal(of(run, 4).verdict, 'pass');
  assert.equal(of(run, 4).measured, '2 s');
  const rows = summaries(tester);
  assert.equal(rows.find(row => row.group.endsWith(':cold'))!.n, 1);
  assert.deepEqual(rows.find(row => row.group.endsWith(':warm'))!.metrics.elapsedMs, { n: 3, median: 2000, max: 2000 });
  tester[1].elapsedMs = tester[2].elapsedMs = tester[3].elapsedMs = 16000;
  assert.equal(of(run, 4).verdict, 'fail');
  assert.equal(of(run, 4).measured, '16 s');
});

test('queue, useful throughput and memory thresholds still reject their own failures', () => {
  const waited = make({ phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ queueMs: 121000 })] }) } });
  assert.equal(of(waited, 5).verdict, 'fail');
  assert.equal(of(make({ phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 39600 }) } }), 3).verdict, 'fail');
  assert.equal(of(make({ vram: { samples: 1, card: 0, cards: [{ index: 0, totalMiB: 32768, usedMiBMax: 32000, freeMiBMin: 768 }] } }), 1).verdict, 'fail');
  assert.equal(of(make({ vram: { samples: 0, card: null, cards: [] } }), 1).verdict, 'unknown');
  const idle = make({ phases: { solo: phase(), loaded: phase({ agent: [], probes: { completed: 0, preempted: 3 } }) } });
  assert.deepEqual(verdictOf(idle).slice(1, 4).map(check => check.verdict), ['unknown', 'unknown', 'unknown']);
});

test('profile selection compares equal workloads and still takes the faster sound pool', () => {
  const one = make({ profile: 'one', bot: { ...make().bot, slots: 1 } });
  const five = make({ profile: 'five', bot: { ...make().bot, slots: 5 }, phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 120000 }) } });
  assert.deepEqual(decide([one, make(), five]).pool, { take: 'five', over: 'one', note: 'take the pool' });
  const other = { ...five, workload: { ...five.workload!, fingerprint: 'different-fixture-or-cadence' } };
  assert.equal(decide([one, make(), other]).pool.take, null);
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

test('the failed combined profile remains visible without replacing a measured draft pair', () => {
  const plain = make({ profile: 'one', bot: { ...make().bot, slots: 1 } });
  const fast = make({ profile: 'one-mtp', draft: true, bot: { ...make().bot, slots: 1 }, phases: {
    solo: phase({ tester: [{ ...coldCall(), decodeTokensPerSecond: 100 }, call({ decodeTokensPerSecond: 100 })] }), loaded: phase() } });
  const failed = make({ profile: 'pool-mtp', draft: true, error: 'gpu_server_unreachable', phases: {},
    vram: { samples: 0, card: null, cards: [] } });
  const answer = decide([failed, plain, fast, make()]);
  assert.equal(answer.draft.verdict, 'pass');
  assert.equal(answer.draft.measured, '2x');
  assert.equal(answer.together.verdict, 'unknown');
  assert.equal(answer.together.measured, 'measurement incomplete (gpu_server_unreachable)');
  assert.equal(answer.pool.take, '96k-3');
});

test('a measured memory shortage rejects the combined profile; an incomplete warm series decides no speed-up', () => {
  const plain = make();
  const short = make({ profile: 'pool-mtp', draft: true,
    vram: { samples: 2, card: 0, cards: [{ index: 0, totalMiB: 32768, usedMiBMax: 32100, freeMiBMin: 668 }] } });
  assert.equal(decide([plain, short]).together.verdict, 'fail');
  assert.equal(decide([plain, short]).pool.note, 'take the pool without the draft model');
  const series = (draft: boolean): Report => make({ draft, profile: draft ? 'mtp' : 'plain',
    workload: { ...make().workload!, warmRuns: 2 }, phases: {
      solo: phase({ tester: [coldCall(), call(), call({ decodeTokensPerSecond: null })] }), loaded: phase() } });
  assert.equal(decide([series(false), series(true)]).draft.verdict, 'unknown');
});

test('long complete scenes remain representative, while short or truncated scenes cannot validate a profile', async () => {
  const measure = (text: string, finishReason: 'stop' | 'length' = 'stop') => measureCall({ async generate(_request, controls) {
    controls?.onStart?.(); return result({ text, finishReason });
  } }, request, { label: 'length', range: { min: 100, max: 200 } });
  const text = '2026-09-20 21:00\n\n' + 'Synthetic. '.repeat(50);
  assert.equal((await measure(text)).call.representative, true);
  assert.equal((await measure(text)).call.formatFailed, false);
  assert.equal((await measure('2026-09-20 21:00\n\nShort.')).call.representative, false);
  assert.equal((await measure(text, 'length')).call.formatFailed, true);
});

test('the default plan leaves room for setup and cold prefill, and an overfull plan is rejected before model work', () => {
  const plan = measurementPlan({ cases: 3, coldRuns: 2, warmRuns: 1, readSeconds: 15, minutes: 30 });
  assert.deepEqual(plan, { calls: 48, readingSeconds: 360, callReserveSeconds: 480,
    plannedSeconds: 840, budgetSeconds: 1800, maximumPlannedSeconds: 1260, fits: true });
  assert.equal(measurementPlan({ cases: 3, coldRuns: 2, warmRuns: 3, readSeconds: 30, minutes: 30 }).fits, false);
  assert.equal(measurementPlan({ cases: 9, coldRuns: 2, warmRuns: 1, readSeconds: 15, minutes: 30 }).fits, false);
  assert.equal(measurementPlan({ cases: 1, coldRuns: 1, warmRuns: 1, readSeconds: 0, minutes: 2, smoke: true }).calls, 2);
});

test('smoke requires exactly one confirmed cold and warm call; missing timings or cache reuse fail', () => {
  assert.deepEqual(smokeOutcome([coldCall(), call()]), { passed: true, cold: 'cold', warm: 'warm' });
  assert.equal(smokeOutcome([coldCall(), { ...coldCall(), cacheIntent: 'warm' }]).passed, false);
  assert.equal(smokeOutcome([coldCall(), call({ cacheObserved: 'unknown' })]).passed, false);
  assert.equal(smokeOutcome([coldCall()]).passed, false);
  assert.equal(smokeOutcome([coldCall(), call(), call()]).passed, false);
});

test('a next turn retains its counted common prefix while pre-filling a new action and scene', () => {
  const next = call({ cacheObserved: 'mixed', timings: { cacheTokens: 3010, promptTokens: 990 }, elapsedMs: 30000 });
  expectCache(next, 'next', 3000);
  assert.equal(next.expectedPromptTokens, 1000);
  assert.equal(next.cacheMatched, true);
  const primer = { ...coldCall(), cacheIntent: 'prime' as const, countedInputTokens: 3300 };
  const nextPhase = () => phase({ tester: [coldCall(), call(), next], primers: [primer] });
  const run = make({ workload: { ...make().workload!, nextTurns: true,
    cases: [{ ...cell, prefixTokens: 3000, previousInputTokens: 3300 }] },
    phases: { solo: nextPhase(), loaded: nextPhase() } });
  assert.equal(of(run, 2).verdict, 'pass');
  // The added-prefill latency stays visible and separate from the existing warm replay gate.
  assert.equal(of(run, 4).verdict, 'pass');
  assert.equal(summaries(run.phases.loaded!.tester).find(row => row.group.endsWith(':next'))!.metrics.elapsedMs.median, 30000);
  next.timings = { cacheTokens: 0, promptTokens: 4000 };
  next.cacheObserved = 'cold';
  expectCache(next, 'next', 3000);
  assert.equal(next.cacheMatched, false);
  assert.equal(of(run, 2).verdict, 'fail');
  next.timings = { cacheTokens: 3990, promptTokens: 10 };
  next.cacheObserved = 'warm';
  expectCache(next, 'next', 3000);
  assert.equal(of(run, 2).verdict, 'unknown');
  primer.cacheObserved = 'unknown';
  assert.equal(of(run, 2).verdict, 'unknown');
});

for (const [smoke, reuse] of [[true, true], [true, false], [false, true]]) test(
  `${smoke ? 'smoke' : 'measurement'} CLI observes fake-server cache behavior (${reuse})`, { timeout: 15000 }, async t => {
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
    const cached = reuse && body!.cache_prompt ? input - 10 : 0;
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
  const mode = smoke ? ['--smoke'] : ['--profile', 'fake-normal', '--history-tokens', '4000', '--cold-runs', '1',
    '--scenes', '1', '--read-seconds', '0', '--minutes', '2'];
  const child = spawn(process.execPath, [fileURLToPath(new URL('./gpu-measure.ts', import.meta.url)), ...mode, '--no-vram', '--out', directory], {
    cwd: directory, env: { PATH: dirname(process.execPath), SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_MODEL: 'synthetic',
      SIMPLE_CHAT_BASE_URL: `http://127.0.0.1:${address.port}`, SIMPLE_CHAT_MODEL_TIMEOUT_MS: '10000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, reuse ? 0 : 1, stderr);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.equal(saved.plan!.budgetSeconds, 120);
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { event: string; cacheObserved?: string });
  if (smoke) {
    assert.deepEqual(caches, [false, true]);
    assert.deepEqual(saved.smoke, { passed: reuse, cold: 'cold', warm: reuse ? 'warm' : 'cold' });
    assert.equal(saved.plan!.calls, 2);
    assert.equal(saved.phases.loaded, undefined);
    assert.deepEqual(rows.filter(row => row.event === 'call_measured').map(row => row.cacheObserved), ['cold', reuse ? 'warm' : 'cold']);
  } else {
    assert.deepEqual(caches, [false, true, false, true, false, true, false, true]);
    assert.equal(saved.plan!.calls, 8);
    assert.equal(saved.smoke, undefined);
    for (const part of [saved.phases.solo!, saved.phases.loaded!]) {
      assert.equal(part.complete, true);
      assert.deepEqual(part.tester.map(call => call.cacheIntent), ['cold', 'warm', 'next']);
      assert.equal(part.primers!.length, 1);
      assert.ok(part.tester[2].expectedPromptTokens! > THRESHOLDS.cacheToleranceTokens);
      // This fake reports best-case reuse even on a changed prompt. The CLI must expose the missing next prefill.
      assert.equal(part.tester[2].cacheMatched, false);
    }
    assert.equal(of(saved, 2).verdict, 'unknown');
  }
});

const snapshot = (used: [number, number], pids: [number[], number[]] = [[], []]) => ({
  gpus: [0, 1].map(index => ({ index, pids: pids[index], memoryUsedMiB: used[index],
    memoryFreeMiB: 32607 - used[index] - 498, memoryTotalMiB: 32607 })),
  processes: { llamaServer: [{ pid: 108 }], sshd: {} } });

test('each card keeps its own memory, read as free rather than derived, and llama-server names the card', () => {
  const vram: Vram = { samples: 0, card: null, cards: [] };
  recordCards(vram, snapshot([28394, 12000], [[7000], [108]]));
  recordCards(vram, snapshot([30000, 11000], [[7000], [108]]));
  // The driver's reserve is in neither used nor total: 32607 - 30000 = 2607, while the card reports 2109 free.
  assert.deepEqual(vram.cards, [
    { index: 0, totalMiB: 32607, usedMiBMax: 30000, freeMiBMin: 2109 },
    { index: 1, totalMiB: 32607, usedMiBMax: 12000, freeMiBMin: 20109 }]);
  assert.equal(vram.samples, 2);
  // The card the verdicts are about is the one llama-server computes on, not the first one read.
  assert.equal(vram.card, 1);
  assert.equal(serverCard({ vram } as Report)!.freeMiBMin, 20109);

  // A driver too old to report free memory is still read; an operator who named a card keeps it.
  const old: Vram = { samples: 0, card: 0, cards: [] };
  const seen = snapshot([28394, 12000], [[7000], [108]]);
  recordCards(old, { gpus: seen.gpus.map(gpu => ({ ...gpu, memoryFreeMiB: undefined })), processes: seen.processes });
  assert.deepEqual([old.card, old.cards[0].freeMiBMin], [0, 32607 - 28394]);

  // Several cards and no process attributed to any of them: no card is named, and check 1 says so rather than
  // reporting about whichever card was read first.
  const unattributed: Vram = { samples: 0, card: null, cards: [] };
  recordCards(unattributed, snapshot([28394, 12000]));
  assert.equal(unattributed.card, null);
  assert.equal(serverCard({ vram: unattributed } as Report), null);
  // One card leaves nothing to choose between, even before the server appears on it.
  const single: Vram = { samples: 0, card: null, cards: [] };
  const one = snapshot([28394, 12000]);
  recordCards(single, { gpus: one.gpus.slice(0, 1), processes: { llamaServer: [], sshd: {} } });
  assert.equal(single.card, 0);
});

test('a report written before memory was recorded per card is still judged, without a card number', () => {
  // The owner's `measurements/` holds these, and docs/gpu.md tells the operator to run `--decide` over them.
  const legacy = make({ vram: { samples: 4, totalMiB: 32768, usedMiBMax: 32000, freeMiBMin: 768 } as unknown as Vram });
  assert.deepEqual(serverCard(legacy), { index: null, freeMiBMin: 768 });
  assert.deepEqual([of(legacy, 1).verdict, of(legacy, 1).measured], ['fail', '768 MiB free']);
  assert.equal(of(make({ vram: { samples: 0 } as unknown as Vram }), 1).verdict, 'unknown');
  assert.deepEqual(decide([legacy]).profiles[0].checks[0].verdict, 'fail');
  // The new shape names the card it read.
  assert.equal(of(make(), 1).measured, '2768 MiB free on card 0');
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
  const fake = await startFakeLlama({ model: 'synthetic', slots: 3, contextTokens: 65536, outputTokens: 520,
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
  const checks = verdictOf(saved);
  assert.equal(checks.find(check => check.id === 2)!.verdict, 'pass');
  assert.ok(checks.slice(1).every(check => check.verdict !== 'unknown'), JSON.stringify(checks));
  assert.equal(checks.find(check => check.id === 1)!.measured, 'not read');
});

test('video memory is sampled per card through one SSH session, and the card is the one llama-server holds', { timeout: 60000 }, async t => {
  const fake = await startFakeLlama({ model: 'synthetic', slots: 1, contextTokens: 65536, outputTokens: 520,
    promptMsPerToken: 0.02, predictMsPerToken: 1, realTime: true });
  t.after(() => fake.close());
  const directory = mkdtempSync(join(tmpdir(), 'gpu-measure-vram-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A stand-in for ssh that records every session it is asked for and prints what the remote script prints. Card 0
  // is nearly full and card 1 holds llama-server: a measurer that kept one number for the machine, or defaulted to
  // card 0, would report the other card's shortage as this server's.
  const sessions = join(directory, 'sessions');
  const line = JSON.stringify({ at: '2026-09-21T10:00:00+00:00',
    gpus: [{ index: 0, pids: [7000], memoryUsedMiB: 31000, memoryFreeMiB: 700, memoryTotalMiB: 32607 },
      { index: 1, pids: [108], memoryUsedMiB: 12000, memoryFreeMiB: 20000, memoryTotalMiB: 32607 }],
    processes: { llamaServer: [{ pid: 108 }], sshd: {} } });
  writeFileSync(join(directory, 'ssh'), ['#!/bin/sh', 'echo session >> "$SESSIONS"', 'cat > /dev/null &',
    'i=0', 'while [ $i -lt 40 ]; do', `  printf '%s\\n' '${line}'`, '  i=$((i+1))', '  sleep 0.3', 'done', ''].join('\n'));
  chmodSync(join(directory, 'ssh'), 0o700);

  const run = runMeasurer(['--smoke', '--vram-seconds', '1'], { SIMPLE_CHAT_PROVIDER: 'llama-cpp',
    SIMPLE_CHAT_MODEL: 'synthetic', SIMPLE_CHAT_BASE_URL: fake.baseUrl, SIMPLE_CHAT_MODEL_TIMEOUT_MS: '30000',
    SIMPLE_CHAT_GPU_SSH_HOST: 'synthetic-host', SESSIONS: sessions, PATH: `${directory}:${dirname(process.execPath)}` }, directory);
  t.after(() => run.child.kill());
  const { code, stderr } = await run.ended;
  assert.equal(code, 0, stderr);
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) as Report;
  assert.ok(saved.vram.samples > 0, 'the cards were read');
  assert.equal(saved.vram.card, 1);
  assert.deepEqual(saved.vram.cards, [
    { index: 0, totalMiB: 32607, usedMiBMax: 31000, freeMiBMin: 700 },
    { index: 1, totalMiB: 32607, usedMiBMax: 12000, freeMiBMin: 20000 }]);
  assert.deepEqual(verdictOf(saved)[0], { id: 1, name: 'video memory at the peak', verdict: 'pass',
    measured: '20000 MiB free on card 1', threshold: '>= 1024 MiB' });
  // One login for the whole run: a session per sample was what the bot was backed off from (docs/gpu.md).
  assert.equal(readFileSync(sessions, 'utf8').trim().split('\n').length, 1);
});
