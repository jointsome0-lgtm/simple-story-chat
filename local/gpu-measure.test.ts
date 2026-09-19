import test from 'node:test';
import assert from 'node:assert/strict';
import { THRESHOLDS, verdictOf, decide } from './gpu-measure.ts';
import type { Call, Phase, Report } from './gpu-measure.ts';

// A synthetic report: the numbers are the ones a measurement would write, never anybody's text.
const call = (over: Partial<Call> = {}): Call => ({ label: 'tester_scene', waitMs: 0, elapsedMs: 10000,
  finishReason: 'stop', inputTokens: 40000, cachedInputTokens: 39990, outputTokens: 500, tokensPerSecond: 50,
  transportMs: 0, formatFailed: false, timings: { cacheTokens: 39990, promptTokens: 10, promptMs: 100,
    predictedTokens: 500, predictedMs: 10000 }, ...over });
// A loaded phase always carries some work beside the tester; without it the checks that compare the two phases
// answer nothing, which `an idle load` below asserts.
const phase = (over: Partial<Phase> = {}): Phase => ({ seconds: 100, tester: [call(), call()],
  agent: [call({ label: 'agent_scene' })], probes: { completed: 1, preempted: 0 },
  usefulOutputTokens: 1000, usefulTokensPerHour: 36000, ...over });
const make = (over: Partial<Report> = {}): Report => ({ profile: '96k-3', startedAt: '2026-09-20T18:00:00.000Z',
  model: 'synthetic', temperature: 0.8, draft: false, server: { slots: 3, contextTokens: 98304 },
  bot: { slots: 3, poolTokens: 98304, sharedCache: true, contextTokens: 65536, maxOutputTokens: 4096,
    quietMs: 60000, readSeconds: 30, historyTokens: null },
  phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 90000 }) },
  vram: { samples: 3, totalMiB: 32768, usedMiBMax: 30000, freeMiBMin: 2768 }, ...over });
const of = (run: Report, id: number) => verdictOf(run).find(check => check.id === id)!;

test('a sound profile passes every threshold the owner set', () => {
  const checks = verdictOf(make());
  assert.deepEqual(checks.map(check => check.verdict), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(of(make(), 3).measured, '2.5x');
});

test('too little free video memory at the peak fails, and an unread card is unknown, never a pass', () => {
  assert.equal(of(make({ vram: { samples: 2, totalMiB: 32768, usedMiBMax: 32000, freeMiBMin: 768 } }), 1).verdict, 'fail');
  assert.equal(of(make({ vram: { samples: 0, totalMiB: null, usedMiBMax: null, freeMiBMin: null } }), 1).verdict, 'unknown');
});

test('the tester\'s cache is judged against the previous scene with the agreed tolerance', () => {
  const kept = make({ phases: { solo: phase(), loaded: phase({ tester: [
    call({ inputTokens: 40000 }), call({ inputTokens: 41000, cachedInputTokens: 40000 - THRESHOLDS.cacheToleranceTokens })] }) } });
  assert.equal(of(kept, 2).verdict, 'pass');
  const lost = make({ phases: { solo: phase(), loaded: phase({ tester: [
    call({ inputTokens: 40000 }), call({ inputTokens: 41000, cachedInputTokens: 0 })] }) } });
  assert.equal(of(lost, 2).verdict, 'fail');
  // Derived, not spelled out: the tolerance is the owner's to change, and the arithmetic is what this pins down.
  assert.equal(of(lost, 2).measured, `${THRESHOLDS.cacheToleranceTokens - 40000} tokens of margin`);
});

test('parallel lanes are refused below the throughput gain and a slowed scene or a long wait fails on its own', () => {
  assert.equal(of(make({ phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 39600 }) } }), 3).verdict, 'fail');
  // Check 4 is absolute: what the person sits through, whatever the same scene costs on an idle card.
  const slow = make({ phases: { solo: phase({ tester: [call({ elapsedMs: 10000 })] }),
    loaded: phase({ tester: [call({ elapsedMs: 16000 })], usefulTokensPerHour: 90000 }) } });
  assert.equal(of(slow, 4).verdict, 'fail');
  assert.equal(of(slow, 4).measured, '16 s');
  const quick = make({ phases: { solo: phase({ tester: [call({ elapsedMs: 1000 })] }),
    loaded: phase({ tester: [call({ elapsedMs: 6600 })], usefulTokensPerHour: 90000 }) } });
  assert.equal(of(quick, 4).verdict, 'pass');
  const waited = make({ phases: { solo: phase(), loaded: phase({ tester: [call({ waitMs: 121000 })] }) } });
  assert.equal(of(waited, 5).verdict, 'fail');
  assert.ok(of(make({ phases: { solo: phase(), loaded: phase({ tester: [call({ waitMs: 119000 })] }) } }), 5).verdict === 'pass');
});

test('a load that never ran leaves the comparisons unknown instead of passing them', () => {
  const idle = make({ phases: { solo: phase(), loaded: phase({ agent: [], probes: { completed: 0, preempted: 3 },
    usefulTokensPerHour: 90000 }) } });
  assert.deepEqual(verdictOf(idle).filter(check => [2, 3, 4].includes(check.id)).map(check => check.verdict),
    ['unknown', 'unknown', 'unknown']);
  assert.equal(of(idle, 2).measured, 'nothing ran beside the tester');
  assert.equal(decide([idle]).pool.take, null);
});

test('the decision takes the fastest sound pool and names the single slot it beats', () => {
  const one = make({ profile: '96k-1', bot: { ...make().bot, slots: 1 },
    phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 40000 }) } });
  const three = make({ profile: '96k-3' });
  const five = make({ profile: '96k-5', bot: { ...make().bot, slots: 5 },
    phases: { solo: phase(), loaded: phase({ usefulTokensPerHour: 120000 }) } });
  const decision = decide([one, three, five]);
  assert.equal(decision.pool.take, '96k-5');
  assert.equal(decision.pool.over, '96k-1');
});

test('a pool that fails a threshold of its own is not taken, however much work it does', () => {
  const greedy = make({ profile: '96k-5', bot: { ...make().bot, slots: 5 },
    phases: { solo: phase(), loaded: phase({ tester: [call({ waitMs: 300000 })], usefulTokensPerHour: 200000 }) } });
  const decision = decide([make({ profile: '96k-3' }), greedy]);
  assert.equal(decision.pool.take, '96k-3');
});

test('the draft model needs both the speed-up and an unbroken format, and one profile alone decides nothing', () => {
  // The speed is read off the server's timings, not the wall clock, so that is what these profiles vary. The
  // baseline call writes 500 tokens in 10 s, which is 50 a second.
  const at = (tokensPerSecond: number, over: Partial<Call> = {}) => call({ ...over,
    timings: { cacheTokens: 39990, promptTokens: 10, promptMs: 100,
      predictedTokens: 500, predictedMs: Math.round(500 / tokensPerSecond * 1000) } });
  const plain = make({ profile: '96k-3' });
  const fast = make({ profile: '96k-3-mtp', draft: true,
    phases: { solo: phase({ tester: [at(65)] }), loaded: phase({ usefulTokensPerHour: 90000 }) } });
  assert.equal(decide([plain, fast]).draft.verdict, 'pass');
  const broken = make({ profile: '96k-3-mtp', draft: true,
    phases: { solo: phase({ tester: [at(65, { formatFailed: true })] }), loaded: phase() } });
  assert.equal(decide([plain, broken]).draft.verdict, 'fail');
  const slow = make({ profile: '96k-3-mtp', draft: true,
    phases: { solo: phase({ tester: [at(55)] }), loaded: phase() } });
  assert.equal(decide([plain, slow]).draft.verdict, 'fail');
  assert.equal(decide([plain]).draft.verdict, 'unknown');
});

test('when the pool and the draft model do not fit together, the pool is kept', () => {
  const plain = make({ profile: '96k-3' });
  const both = make({ profile: '96k-3-mtp', draft: true,
    phases: { solo: phase({ tester: [call({ tokensPerSecond: 70 })] }), loaded: phase({ usefulTokensPerHour: 90000 }) },
    vram: { samples: 3, totalMiB: 32768, usedMiBMax: 32100, freeMiBMin: 668 } });
  const decision = decide([plain, both]);
  assert.equal(decision.together.verdict, 'fail');
  assert.equal(decision.pool.take, '96k-3');
  assert.equal(decision.pool.note, 'take the pool without the draft model');
});
