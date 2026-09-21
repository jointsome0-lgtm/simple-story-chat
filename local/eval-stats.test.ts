import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keyBalance, pooled, familyWeighted, clusters, bootstrap, dedupe, onCurrentKey, readCorpus, readEventLog, summarize } from './eval-stats.ts';
import type { Cell, KeySet } from './eval-stats.ts';

// Two synthetic scenarios, so that the arithmetic can be checked by hand and no fixture of the suite is involved.
const keys = new Map<string, KeySet>([
  ['alpha', { memory: new Map([['a1', '1'], ['a2', '2'], ['a3', 'yes'], ['a4', 'no']]),
    scene: new Map([['t1a', 'yes'], ['t1b', 'yes'], ['t2a', 'no']]),
    trapOf: new Map([['t1a', 't1'], ['t1b', 't1'], ['t2a', 't2']]) }],
  ['beta', { memory: new Map([['b1', 'no'], ['b2', 'no']]), scene: new Map(), trapOf: new Map() }],
]);
const cell = (fields: Partial<Cell>): Cell => ({ run: 'r', source: 'events', model: 'M', scenario: 'alpha', mode: 'plain',
  instrument: 'memory', passed: 0, total: 0, ...fields });

test('the answer key alone fixes what a model that never reads the story scores', () => {
  assert.deepEqual(keyBalance(['yes', 'yes', 'yes', 'no']),
    { keys: 4, byExpected: { yes: 3, no: 1 }, constantYes: 0.75, constantNo: 0.25, silence: 0, bestConstant: 0.75 });
  // Exact answers: no constant string scores at all, and `unknown` earns nothing unless the key says so.
  assert.deepEqual(keyBalance(['54', '2026-09-05', 'unknown']),
    { keys: 3, byExpected: { number: 1, other: 1, unknown: 1 }, constantYes: 0, constantNo: 0, silence: 1 / 3, bestConstant: 1 / 3 });
  assert.deepEqual(keyBalance([]).bestConstant, 0);
});

test('pooling across scenarios gives the longer one more votes than family weighting does', () => {
  const cells = [cell({ scenario: 'alpha', passed: 3, total: 12 }), cell({ scenario: 'beta', passed: 3, total: 3 })];
  assert.equal(pooled(cells), 6 / 15);
  assert.equal(familyWeighted(cells), (3 / 12 + 1) / 2);
  assert.equal(pooled([]), null);
  assert.equal(familyWeighted([]), null);
});

test('a cluster is one item over the runs, and a trap passes only when all its questions do', () => {
  const items = (outcome: Record<string, boolean>) => Object.entries(outcome).map(([key, pass]) => ({ key, pass }));
  const cells = [
    cell({ run: 'r1', instrument: 'scene', items: items({ t1a: true, t1b: false, t2a: true }) }),
    cell({ run: 'r2', instrument: 'scene', items: items({ t1a: true, t1b: true, t2a: true }) }),
  ];
  assert.deepEqual(clusters(cells, key => key), [
    { key: 't1b', runs: 2, passed: 1, rate: 0.5 },
    { key: 't1a', runs: 2, passed: 2, rate: 1, flag: 'always' },
    { key: 't2a', runs: 2, passed: 2, rate: 1, flag: 'always' },
  ]);
  const trapOf = new Map([...keys.get('alpha')!.trapOf]);
  assert.deepEqual(clusters(cells, key => trapOf.get(key)!), [
    { key: 't1', runs: 2, passed: 1, rate: 0.5 },
    { key: 't2', runs: 2, passed: 2, rate: 1, flag: 'always' },
  ]);
});

test('the bootstrap resamples cells, not questions, and repeats itself under one seed', () => {
  const mean = (sample: number[][]) => sample[0].reduce((total, value) => total + value, 0) / sample[0].length;
  assert.deepEqual(bootstrap([[1, 1, 1, 1]], mean, { samples: 200, seed: 1 }), { low: 1, high: 1 });
  const half = bootstrap([Array.from({ length: 40 }, (_, index) => index % 2)], mean, { samples: 500, seed: 1 })!;
  assert.ok(half.low > 0.2 && half.low < 0.5 && half.high > 0.5 && half.high < 0.8, JSON.stringify(half));
  assert.deepEqual(bootstrap([[0, 1, 1]], mean, { samples: 200, seed: 1 }), bootstrap([[0, 1, 1]], mean, { samples: 200, seed: 1 }));
  assert.notDeepEqual(bootstrap([[0, 1, 1]], mean, { samples: 200, seed: 1 }), bootstrap([[0, 1, 1]], mean, { samples: 200, seed: 2 }));
  // The worst of two models keeps each model's own number of cells and draws only that model's cells. A statistic
  // that reports the shape and the contents it was handed is what separates this from resampling the seven together:
  // a pooled resample would hand over other group sizes, and would move a 1 into the group that has none.
  const shape = (sample: number[][]) => sample[0].length + 100 * sample[1].length + (sample[0].includes(1) ? 1000 : 0);
  assert.deepEqual(bootstrap([[0, 0, 0, 0, 0], [1, 1]], shape, { samples: 200, seed: 3 }), { low: 205, high: 205 });
  const worst = (sample: number[][]) => Math.min(...sample.map(group => group.reduce((total, value) => total + value, 0) / group.length));
  assert.deepEqual(bootstrap([[1, 1], [0, 0]], worst, { samples: 100, seed: 3 }), { low: 0, high: 0 });
  assert.equal(bootstrap([[]], mean, { samples: 10, seed: 1 }), null);
});

test('one run saved in three places is one cell, not three', () => {
  // The probe directory, the eval.json summary and the event log all hold the same 3/4 of one run; only the log holds
  // the 1/4 of the second run. Counting the copies would weigh run one three times and narrow every interval.
  const copy = (source: Cell['source']) => cell({ run: source, source, passed: 3, total: 4 });
  const second = cell({ run: 'log', source: 'events', passed: 1, total: 4 });
  const once = dedupe([copy('report'), copy('summary'), copy('events'), second]);
  assert.deepEqual([once.cells.map(one => one.source), once.dropped], [['report', 'events'], 2]);
  assert.equal(pooled(once.cells), 0.5);
  // Two runs that scored alike are two cells when one source holds both: only copies across sources are dropped.
  assert.equal(dedupe([second, second]).dropped, 0);
  // The log holding two runs of one score and the probe directory holding one of them is two cells, and the one that
  // keeps the per-question answers is the one kept.
  assert.deepEqual(dedupe([copy('events'), copy('report'), copy('events')]).cells.map(one => one.source), ['events', 'report']);
  // A different count, a different mode or a different failure code is a different cell.
  assert.equal(dedupe([copy('report'), cell({ source: 'summary', passed: 3, total: 4, error: 'rate_limited' })]).dropped, 0);
  const stats = summarize([copy('report'), copy('summary'), copy('events'), second], keys, { samples: 100, seed: 1 });
  assert.deepEqual([stats.corpus.cells, stats.corpus.duplicatesDropped, stats.scores['memory/plain']!.all.pooled], [2, 2, 0.5]);
});

test('a failed cell is pooled into the headline as zero, and the same score without those cells is far higher', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-stats-test-'));
  // The tool searches the temporary directory by default, so a leftover fixture here would enter a later real run.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The directory names are the ones the two writers create (memory-probe.ts:87, eval.ts:234); no other name is read.
  const probe = join(directory, 'simple-chat-memory-alpha-1');
  mkdirSync(probe);
  // The shape memory-probe.ts writes: per-question outcomes, and the verdicts scene-judge.ts wrote back.
  writeFileSync(join(probe, 'report.json'), JSON.stringify({
    scenario: 'alpha', sourceHash: 'x', model: 'M1', startedAt: 'now', scope: 'synthetic',
    modes: { plain: { preemptions: 0, compactions: [], through: 4, completedAt: 'now',
      answers: [['a1', true], ['a2', false], ['a3', true], ['a4', true]].map(([key, pass]) => ({ key, expected: keys.get('alpha')!.memory.get(key as string), actual: '', pass })),
      traps: [{ key: 't1', text: '', truncated: false }, { key: 't2', text: '', truncated: true }],
      verdicts: [{ key: 't1a', expected: 'yes', actual: 'yes', pass: true }, { key: 't1b', expected: 'yes', actual: 'no', pass: false },
        { key: 't2a', expected: 'no', actual: 'no', pass: true }] } }, completedAt: 'now' }));
  // The shape eval.ts writes: counts and failed keys, without the judge's own answers.
  mkdirSync(join(directory, 'simple-chat-eval-1'));
  writeFileSync(join(directory, 'simple-chat-eval-1', 'eval.json'), JSON.stringify({ at: 'now', scenarios: ['alpha', 'beta'],
    models: { M1: { plain: 0.5, cells: {
      alpha: { plain: { passed: 2, total: 4, failedKeys: ['a2', 'a4'], scene: { passed: 1, total: 3, failedKeys: ['t1b', 't2a'] } } },
      beta: { plain: { passed: 0, total: 2, failedKeys: ['b1', 'b2'], error: 'unsupported_server' } } } } } }));
  // A GPU measurement report is not a scored cell, and neither is a probe directory whose run wrote no mode.
  mkdirSync(join(directory, 'measurements-pool-3'));
  writeFileSync(join(directory, 'measurements-pool-3', 'report.json'), JSON.stringify({ profile: 'pool-3', cells: [] }));
  mkdirSync(join(directory, 'simple-chat-memory-beta-1'));
  writeFileSync(join(directory, 'simple-chat-memory-beta-1', 'report.json'), JSON.stringify({ scenario: 'beta',
    sourceHash: 'x', model: 'M1', startedAt: 'now', scope: 'synthetic', modes: {} }));
  // memory-probe.ts:149 writes one lab/<variant>-<sample>/report.json per variant and sample of the same trap, in the
  // shape the judge reads. Judging them is the designed p_flip measurement, and the samples of one trap are not runs
  // of the suite: judged or not, a lab batch is never read.
  mkdirSync(join(probe, 'lab', 'base-1'), { recursive: true });
  writeFileSync(join(probe, 'lab', 'base-1', 'report.json'), JSON.stringify({ scenario: 'alpha', model: 'M1',
    modes: { plain: { traps: [{ key: 't1', text: '', truncated: false }],
      verdicts: [{ key: 't1a', expected: 'yes', actual: 'no', pass: false }, { key: 't1b', expected: 'yes', actual: 'no', pass: false }] } } }));

  const corpus = readCorpus([directory], keys);
  assert.deepEqual([corpus.reports, corpus.summaries], [1, 1]);
  assert.deepEqual(corpus.paths.sort(), [join(probe, 'report.json'), join(directory, 'simple-chat-eval-1', 'eval.json')].sort());
  const stats = summarize(corpus.cells, keys, { samples: 200, seed: 1 });
  assert.deepEqual(stats.corpus.bySource, { report: 2, summary: 3, events: 0 });

  const memory = stats.scores['memory/plain']!;
  // Three cells: 3/4 and 2/4 on alpha, and beta's 0/2, which failed before it answered anything.
  assert.deepEqual(memory.all, { pooled: 0.5, family: 0.3125, cells: 3, passed: 5, total: 10 });
  assert.deepEqual(memory.withoutFailures, { pooled: 0.625, family: 0.625, cells: 2, passed: 5, total: 8 });
  assert.deepEqual(memory.failures, { cells: 1, cellShare: 0.3333, questionShare: 0.2, byCode: { unsupported_server: 1 }, truncatedScenes: 0 });
  // Every cell was scored against the key the fixtures hold now, so the current-key score is the pooled one.
  assert.deepEqual(memory.onCurrentKey, { pooled: 0.5, family: 0.3125, cells: 3, passed: 5, total: 10,
    baseline: { keys: 10, byExpected: { number: 4, yes: 2, no: 4 }, constantYes: 0.2, constantNo: 0.4, silence: 0, bestConstant: 0.4 } });
  assert.deepEqual(memory.offKey, { cells: 0, noFixture: 0, modelsWithoutCurrentKey: [] });
  // The baseline is the one of the cells it is printed beside: alpha is answered twice and beta once, so "no" takes
  // 4 of the 10 answers asked — not the half it takes of the six keys the two fixtures hold.
  assert.deepEqual(memory.headline, { pooledWorstModel: 0.5, familyWeightedWorstModel: 0.3125, pooledWorstModelWithoutFailures: 0.625,
    pooledWorstModelOnCurrentKey: 0.5, baselineBestConstant: 0.4, baselineBestConstantFamily: 0.625 });
  assert.equal(stats.answerKey.memory.constantNo, 0.5);
  assert.equal(memory.perModel.M1.pooled, 0.5);

  const scene = stats.scores['scene/plain']!;
  assert.deepEqual(scene.all, { pooled: 0.5, family: 0.5, cells: 2, passed: 3, total: 6 });
  assert.equal(scene.failures.truncatedScenes, 1);
  // The key of the suite, not its scores: constant "yes" would take two of the three trap questions.
  assert.deepEqual(stats.answerKey.scene, { keys: 3, byExpected: { yes: 2, no: 1 }, constantYes: 2 / 3, constantNo: 1 / 3, silence: 0, bestConstant: 2 / 3 });

  // The judge's own three answers are the rate; the three the summary only allows to be derived are counted apart.
  assert.deepEqual(stats.judge, { verdicts: 6, answered: 3, yesRate: 0.3333, derived: 3, derivedYesRate: 0.6667 });
  // beta's checks are absent: its only cell failed before the model answered, so b1 and b2 were never asked.
  assert.deepEqual(stats.clusters.checks.table, [
    { key: 'a2', runs: 2, passed: 0, rate: 0, flag: 'never' },
    { key: 'a4', runs: 2, passed: 1, rate: 0.5 },
    { key: 'a1', runs: 2, passed: 2, rate: 1, flag: 'always' },
    { key: 'a3', runs: 2, passed: 2, rate: 1, flag: 'always' },
  ]);
  assert.deepEqual(stats.clusters.traps.table, [
    { key: 't1', runs: 2, passed: 0, rate: 0, flag: 'never' },
    { key: 't2', runs: 2, passed: 1, rate: 0.5 },
  ]);
  assert.deepEqual([stats.clusters.checks.never, stats.clusters.checks.always, stats.clusters.checks.live], [1, 2, 1]);
});

test('a report.json another tool left in the temporary directory is not a run of this suite', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-stats-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // The default root is the whole temporary directory, which this machine shares with everything else that runs on
  // it; a fixture of another tool has the same shape and would move the worst-model headline.
  const report = JSON.stringify({ scenario: 'alpha', sourceHash: 'x', model: 'STRAY', startedAt: 'now', scope: 'synthetic',
    completedAt: 'now', modes: { plain: { preemptions: 0, compactions: [], through: 4, completedAt: 'now',
      answers: [{ key: 'a1', expected: '1', actual: 'no', pass: false }] } } });
  for (const name of ['versus-1', 'lab-2']) { mkdirSync(join(directory, name)); writeFileSync(join(directory, name, 'report.json'), report); }
  mkdirSync(join(directory, 'kept'));
  writeFileSync(join(directory, 'kept', 'eval.json'), JSON.stringify({ at: 'now',
    models: { STRAY: { cells: { alpha: { plain: { passed: 0, total: 4, failedKeys: [] } } } } } }));
  assert.deepEqual(readCorpus([directory], keys), { cells: [], reports: 0, summaries: 0, paths: [] });
  // The two writers name the directory they create, and what they wrote is read and named in the output.
  mkdirSync(join(directory, 'simple-chat-memory-alpha-9'));
  writeFileSync(join(directory, 'simple-chat-memory-alpha-9', 'report.json'), report);
  const corpus = readCorpus([directory], keys);
  assert.deepEqual([corpus.reports, corpus.summaries, corpus.paths],
    [1, 0, [join(directory, 'simple-chat-memory-alpha-9', 'report.json')]]);
});

test('a cell that failed before the model answered is pooled into the score and left out of everything else', () => {
  const keyed = (instrument: 'memory' | 'scene') => [...keys.get('alpha')![instrument]].map(([key, expected]) => ({ key, pass: false, expected }));
  // What eval.ts writes when the provider refused the key: no model and no judge was reached, and every question of
  // the scenario lands in failedKeys, from which the items are read back.
  const cells = [cell({ source: 'summary', passed: 0, total: 4, error: 'unauthorized', items: keyed('memory') }),
    cell({ source: 'summary', instrument: 'scene', passed: 0, total: 3, error: 'no_scenes', items: keyed('scene') })];
  const stats = summarize(cells, keys, { samples: 50, seed: 1 });
  // The score keeps them, because eval.ts pools them into the headline and the tool reports what eval.ts reports.
  assert.deepEqual([stats.scores['memory/plain']!.all.pooled, stats.scores['memory/plain']!.failures.cells], [0, 1]);
  assert.equal(stats.scores['memory/plain']!.withoutFailures.pooled, null);
  // The judge never answered, and no check or trap lost a run it was asked.
  assert.deepEqual(stats.judge, { verdicts: 0, answered: 0, yesRate: null, derived: 0, derivedYesRate: null });
  assert.deepEqual([stats.clusters.checks.table, stats.clusters.traps.table, stats.clusters.checks.never], [[], [], 0]);
});

test('cells of a retired answer key are kept out of the score the baseline is printed beside', () => {
  // alpha has four checks today; OLD was scored when it had two, so its cells belong to another suite.
  const old = cell({ model: 'OLD', run: 'r1', passed: 0, total: 2 });
  const now = cell({ model: 'NEW', run: 'r2', passed: 2, total: 4 });
  const stats = summarize([old, now], keys, { samples: 100, seed: 1 });
  const section = stats.scores['memory/plain']!;
  assert.deepEqual(section.all, { pooled: 0.3333, family: 0.3333, cells: 2, passed: 2, total: 6 });
  assert.deepEqual([section.onCurrentKey.cells, section.onCurrentKey.pooled], [1, 0.5]);
  // The worst model over the whole corpus is one with no cell on today's key at all, which the section names.
  assert.deepEqual([section.headline.pooledWorstModel, section.headline.pooledWorstModelOnCurrentKey], [0, 0.5]);
  assert.deepEqual(section.offKey, { cells: 1, noFixture: 0, modelsWithoutCurrentKey: ['OLD'] });
  // Only alpha is answered here, so the baseline is alpha's own, not the "no" half of the two fixtures together.
  assert.deepEqual([section.headline.baselineBestConstant, stats.answerKey.memory.bestConstant], [0.25, 0.5]);
  assert.deepEqual(stats.keyVersions['memory/alpha'], { current: 4, cellsByTotal: { 2: 1, 4: 1 } });
  // A scenario whose fixture is not on this machine has no key version and no baseline of its own.
  const packed = summarize([cell({ scenario: 'gamma', passed: 5, total: 12 })], keys, { samples: 50, seed: 1 });
  assert.deepEqual([packed.corpus.withoutFixture, packed.keyVersions['memory/gamma']!.current], [['gamma'], null]);
  assert.deepEqual(packed.scores['memory/plain']!.offKey, { cells: 1, noFixture: 1, modelsWithoutCurrentKey: ['M'] });
  assert.equal(packed.scores['memory/plain']!.headline.baselineBestConstant, null);
});

test('a saved run is read with the number of questions it was asked, not with today\'s', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-stats-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // alpha holds four checks and three trap questions today. This directory was kept from a day when it had two and
  // one, and the model and the judge answered every one of them: a perfect run, not a run that lost the rest.
  const probe = join(directory, 'simple-chat-memory-alpha-7');
  mkdirSync(probe);
  writeFileSync(join(probe, 'report.json'), JSON.stringify({ scenario: 'alpha', sourceHash: 'x', model: 'OLD',
    startedAt: 'now', scope: 'synthetic', completedAt: 'now', modes: { plain: { preemptions: 0, compactions: [], through: 2,
      completedAt: 'now', answers: [{ key: 'a1', expected: '1', actual: '1', pass: true }, { key: 'a2', expected: '2', actual: '2', pass: true }],
      traps: [{ key: 't1', text: '', truncated: false }],
      verdicts: [{ key: 't1a', expected: 'yes', actual: 'yes', pass: true }] } } }));
  // A mode that answered nothing is the 0/N cell eval.ts:139 pools, and there N is the fixture of today.
  mkdirSync(join(directory, 'simple-chat-memory-beta-7'));
  writeFileSync(join(directory, 'simple-chat-memory-beta-7', 'report.json'), JSON.stringify({ scenario: 'beta',
    sourceHash: 'x', model: 'OLD', startedAt: 'now', scope: 'synthetic',
    modes: { plain: { preemptions: 0, compactions: [], through: 0, error: 'unauthorized' } } }));
  const { cells } = readCorpus([directory], keys);
  assert.deepEqual(cells.map(one => [one.scenario, one.instrument, one.passed, one.total, onCurrentKey(one, keys)]),
    [['alpha', 'memory', 2, 2, false], ['alpha', 'scene', 1, 1, false], ['beta', 'memory', 0, 2, true]]);
  const stats = summarize(cells, keys, { samples: 50, seed: 1 });
  // Both alpha cells belong to a retired suite, which the section and the key versions say rather than hide.
  assert.deepEqual(stats.keyVersions['memory/alpha'], { current: 4, cellsByTotal: { 2: 1 } });
  assert.deepEqual(stats.scores['memory/plain']!.offKey, { cells: 1, noFixture: 0, modelsWithoutCurrentKey: [] });
  assert.deepEqual([stats.scores['memory/plain']!.onCurrentKey.cells, stats.scores['scene/plain']!.onCurrentKey.cells], [1, 0]);
  assert.equal(stats.scores['scene/plain']!.all.pooled, 1);
});

test('a summary written against a suite of another size invents no answer and no cluster row', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-stats-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // A summary keeps the failed keys, not the asked ones, so its items are read back from the fixture — which is the
  // same suite only when it is the same size. alpha had two checks and two trap questions on the day of this run.
  mkdirSync(join(directory, 'simple-chat-eval-7'));
  writeFileSync(join(directory, 'simple-chat-eval-7', 'eval.json'), JSON.stringify({ at: 'now', models: { OLD: { cells: {
    alpha: { plain: { passed: 1, total: 2, failedKeys: ['a2'], scene: { passed: 1, total: 2, failedKeys: ['t1b'] } } } } } } }));
  const stats = summarize(readCorpus([directory], keys).cells, keys, { samples: 50, seed: 1 });
  // The counts are still the cell's own; a3, a4 and t2a were never asked and are not answers of that run.
  assert.deepEqual([stats.corpus.cells, stats.corpus.withItems], [2, 0]);
  assert.deepEqual(stats.judge, { verdicts: 0, answered: 0, yesRate: null, derived: 0, derivedYesRate: null });
  assert.deepEqual([stats.clusters.checks.table, stats.clusters.questions.table, stats.clusters.traps.table], [[], [], []]);
  assert.deepEqual([stats.scores['memory/plain']!.all.passed, stats.scores['scene/plain']!.offKey.cells], [1, 1]);
});

test('a question the judge never saw is not an answer of the judge', () => {
  const cells = [cell({ instrument: 'scene', passed: 1, total: 3, items: [
    { key: 't1a', expected: 'yes', actual: 'yes', pass: true },
    { key: 't1b', expected: 'yes', actual: null, pass: false },
    { key: 't2a', expected: 'no', actual: null, pass: false }] })];
  assert.deepEqual(summarize(cells, keys, { samples: 50, seed: 1 }).judge,
    { verdicts: 3, answered: 1, yesRate: 1, derived: 0, derivedYesRate: null });
  // The same run saved as a summary keeps no trap list, so scene-judge.ts:38 failing t1b and t2a without a call
  // cannot be told from a judge that answered them: those two are derived, and the rate is not theirs.
  const summary = [cell({ source: 'summary', instrument: 'scene', passed: 1, total: 3, items: [
    { key: 't1a', expected: 'yes', pass: true }, { key: 't1b', expected: 'yes', pass: false },
    { key: 't2a', expected: 'no', pass: false }] })];
  assert.deepEqual(summarize(summary, keys, { samples: 50, seed: 1 }).judge,
    { verdicts: 3, answered: 0, yesRate: null, derived: 3, derivedYesRate: 0.6667 });
});

test('the event log keeps the cells of a run after the temporary directories are gone', () => {
  const log = [
    { event: 'run_started', models: ['M1'], scenarios: ['alpha'] },
    { event: 'mode_complete', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 3, total: 4 },
    { event: 'trap_scene', model: 'M1', scenario: 'alpha', mode: 'plain', truncated: true },
    { event: 'judged', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 2, total: 3 },
    // A mode that failed answers nothing; eval.ts scores that cell 0/N with the checks of the scenario as N.
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'sgr', code: 'invalid_memory' },
    // A failure after the mode completed is a retry inside the run, not a second cell.
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'plain', code: 'rate_limited' },
    { event: 'run_started', models: ['M1'], scenarios: ['alpha'] },
    { event: 'mode_complete', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 4, total: 4 },
    // `eval judge` compares judges on the scenes of a finished run and tags them with the scenario name "judge".
    { event: 'judged', model: 'M2', scenario: 'judge', mode: 'plain', passed: 1, total: 9 },
  ].map(line => JSON.stringify(line)).join('\n') + '\nnot json\n';
  const { cells, lines, runs } = readEventLog(log);
  assert.deepEqual([lines, runs], [9, 2]);
  assert.deepEqual(cells.map(({ run, scenario, mode, instrument, passed, total, error, truncated }) =>
    ({ run, scenario, mode, instrument, passed, total, error, truncated })), [
    { run: 'run-1', scenario: 'alpha', mode: 'plain', instrument: 'memory', passed: 3, total: 4, error: undefined, truncated: undefined },
    { run: 'run-1', scenario: 'alpha', mode: 'plain', instrument: 'scene', passed: 2, total: 3, error: undefined, truncated: 1 },
    { run: 'run-2', scenario: 'alpha', mode: 'plain', instrument: 'memory', passed: 4, total: 4, error: undefined, truncated: undefined },
    { run: 'run-1', scenario: 'alpha', mode: 'sgr', instrument: 'memory', passed: 0, total: 4, error: 'invalid_memory', truncated: undefined },
  ]);
  // Counts only: the log never held the keys, so the cluster table stays empty and says so.
  assert.equal(summarize(cells, keys, { samples: 50, seed: 1 }).clusters.checks.runs, 0);
});

test('two probe invocations of one scenario are two cells even when no run_started separates them', () => {
  // `eval ceiling` and `eval judge` record no run_started (eval.ts:191-205), so their events carry the run counter of
  // whatever ran before; two ceiling invocations of the same model and scenario share it. Each probe opens with
  // `started`, which is the boundary of one cell.
  const log = [
    { event: 'run_started', models: ['M1'], scenarios: ['alpha'] },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'plain' },
    { event: 'mode_complete', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 3, total: 4 },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'full' },
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'full', code: 'rate_limited' },
    // A second failure inside the same invocation is a retry of it, not another cell.
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'full', code: 'rate_limited' },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'full' },
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'full', code: 'server_error' },
  ].map(line => JSON.stringify(line)).join('\n');
  const { cells } = readEventLog(log);
  assert.deepEqual(cells.filter(one => one.mode === 'full').map(one => [one.error, one.passed, one.total]),
    [['rate_limited', 0, 4], ['server_error', 0, 4]]);
});

test('the memory probe and the judge of one cell are two invocations of one slot', () => {
  // What `eval --judge` writes for one model, scenario and mode: memory-probe.ts:131 opens with `started`, writes the
  // trap scenes and completes the mode, and eval.ts:147 then runs scene-judge.ts under the same tags, which opens
  // with a `started` of its own (scene-judge.ts:32). The scenes belong to the cell the judge reports.
  const log = [
    { event: 'run_started', models: ['M1'], scenarios: ['alpha'] },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'plain' },
    { event: 'trap_scene', model: 'M1', scenario: 'alpha', mode: 'plain', truncated: true },
    { event: 'trap_scene', model: 'M1', scenario: 'alpha', mode: 'plain', truncated: false },
    { event: 'mode_complete', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 4, total: 4 },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'plain' },
    { event: 'judged', model: 'M1', scenario: 'alpha', mode: 'plain', passed: 2, total: 3 },
    // The same sequence in sgr, where the judge failed after the mode had completed. That is a judged cell nobody
    // judged, not a memory cell of 0/4: counting it would lower the headline and report a failure that never happened.
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'sgr' },
    { event: 'mode_complete', model: 'M1', scenario: 'alpha', mode: 'sgr', passed: 3, total: 4 },
    { event: 'started', model: 'M1', scenario: 'alpha', mode: 'sgr' },
    { event: 'trap_judged', model: 'M1', scenario: 'alpha', mode: 'sgr' },
    { event: 'deferred_or_failed', model: 'M1', scenario: 'alpha', mode: 'sgr', code: 'rate_limited' },
  ].map(line => JSON.stringify(line)).join('\n');
  const { cells } = readEventLog(log);
  assert.deepEqual(cells.map(one => [one.mode, one.instrument, one.passed, one.total, one.truncated, one.error]), [
    ['plain', 'memory', 4, 4, undefined, undefined],
    ['plain', 'scene', 2, 3, 1, undefined],
    ['sgr', 'memory', 3, 4, undefined, undefined],
  ]);
  const stats = summarize(cells, keys, { samples: 50, seed: 1 });
  assert.deepEqual([stats.scores['memory/plain']!.all.pooled, stats.scores['memory/plain']!.failures.cells], [1, 0]);
  assert.equal(stats.scores['scene/plain']!.failures.truncatedScenes, 1);
});
