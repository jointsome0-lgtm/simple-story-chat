import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { active, addSeed, beginJob, commitTurn, emptyLibrary, history, newStory } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { makeRequest } from './prompt.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';
import { THRESHOLDS, verdictOf, decide, measureCall, cacheState, withoutPromptCache, buildWorkload,
  summaries, measureAgentTurn, closePhase } from './gpu-measure.ts';
import type { Call, Phase, Report, WorkCase } from './gpu-measure.ts';

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
  workload: { version: 2, fingerprint: 'same-work', cases: [cell], coldRuns: 1, warmRuns: 1,
    compactAtTokens: 44000, keepScenes: 4, memoryMode: 'plain' },
  phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 90000 }) },
  vram: { samples: 3, totalMiB: 32768, usedMiBMax: 30000, freeMiBMin: 2768 }, ...over });
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

test('a slow cold series cannot hide behind more fast warm samples', () => {
  const tester = [coldCall(), call({ elapsedMs: 2000 }), call({ elapsedMs: 2000 }), call({ elapsedMs: 2000 })];
  tester[0].elapsedMs = 16000;
  const run = make({ workload: { ...make().workload!, warmRuns: 3 },
    phases: { solo: phase({ tester: structuredClone(tester) }), loaded: phase({ tester }) } });
  assert.equal(of(run, 4).verdict, 'fail');
  assert.equal(of(run, 4).measured, '16 s');
  const rows = summaries(tester);
  assert.equal(rows.find(row => row.group.endsWith(':cold'))!.n, 1);
  assert.deepEqual(rows.find(row => row.group.endsWith(':warm'))!.metrics.elapsedMs, { n: 3, median: 2000, max: 2000 });
});

test('queue, useful throughput and memory thresholds still reject their own failures', () => {
  const waited = make({ phases: { solo: phase(), loaded: phase({ tester: [coldCall(), call({ queueMs: 121000 })] }) } });
  assert.equal(of(waited, 5).verdict, 'fail');
  assert.equal(of(make({ phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 39600 }) } }), 3).verdict, 'fail');
  assert.equal(of(make({ vram: { samples: 1, totalMiB: 32768, usedMiBMax: 32000, freeMiBMin: 768 } }), 1).verdict, 'fail');
  assert.equal(of(make({ vram: { samples: 0, totalMiB: null, usedMiBMax: null, freeMiBMin: null } }), 1).verdict, 'unknown');
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
    vram: { samples: 0, totalMiB: null, usedMiBMax: null, freeMiBMin: null } });
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
    vram: { samples: 2, totalMiB: 32768, usedMiBMax: 32100, freeMiBMin: 668 } });
  assert.equal(decide([plain, short]).together.verdict, 'fail');
  assert.equal(decide([plain, short]).pool.note, 'take the pool without the draft model');
  const series = (draft: boolean): Report => make({ draft, profile: draft ? 'mtp' : 'plain',
    workload: { ...make().workload!, warmRuns: 2 }, phases: {
      solo: phase({ tester: [coldCall(), call(), call({ decodeTokensPerSecond: null })] }), loaded: phase() } });
  assert.equal(decide([series(false), series(true)]).draft.verdict, 'unknown');
});
