// Read-only statistics over finished eval and probe reports: what the saved runs can and cannot tell apart.
// It calls no model, changes no file and reads only synthetic material. Nothing here is on the improve-loop freeze
// list, and it needs no change to local/eval.ts or to any fixture.
// Where the corpus lives: `npm run eval` writes its summary to a mkdtemp eval.json (eval.ts:234) and every replay to a
// mkdtemp directory holding report.json (memory-probe.ts:87), both under the system temporary directory, so the corpus
// is lost whenever /tmp is cleared. logs/eval.jsonl outlives it and is read as a second, coarser source: it keeps the
// per-cell counts of every run but not the per-question keys, so it feeds the scores and not the cluster table.
// One run leaves the same cell in all three places, so `summarize` deduplicates before it counts anything.
import { parseArgs } from 'node:util';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ReplayReport } from './memory-probe.ts';
import { loadScenario, packScenarios } from './scenarios.ts';

// The two instruments: the fixed memory questions after the replay, and the judged continuity traps.
export type Instrument = 'memory' | 'scene';
export type Item = { key: string; pass: boolean; expected?: string; actual?: string | null };
// One scored cell of one saved run: one model, one scenario, one memory mode, one instrument. `items` is present only
// when the source kept the per-question outcome. `error` marks a cell that eval.ts pools into the headline as 0/N.
export type Cell = { run: string; source: 'report' | 'summary' | 'events'; model: string; scenario: string; mode: string;
  instrument: Instrument; passed: number; total: number; error?: string; truncated?: number; items?: Item[] };
// The fixed answers of one scenario by key, and which trap each judged question belongs to.
export type KeySet = { memory: Map<string, string>; scene: Map<string, string>; trapOf: Map<string, string> };

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const round = (value: number | null) => value === null ? null : Math.round(value * 10000) / 10000;

// The score eval.ts reports: one fraction over the pooled numerators and denominators of every scenario.
export const pooled = (cells: Cell[]): number | null => {
  const total = sum(cells.map(cell => cell.total));
  return total ? sum(cells.map(cell => cell.passed)) / total : null;
};
// The same cells with one vote per story. eval.ts:217-220 pools across scenarios, so dance's 13 checks outweigh
// chess's 7 in every historical score; this averages the scenario rates instead.
export const familyWeighted = (cells: Cell[]): number | null => {
  const rates = [...new Set(cells.map(cell => cell.scenario))].sort()
    .map(name => pooled(cells.filter(cell => cell.scenario === name))).filter(rate => rate !== null);
  return rates.length ? sum(rates) / rates.length : null;
};

export type Balance = { keys: number; byExpected: Record<string, number>; constantYes: number; constantNo: number; silence: number; bestConstant: number };
// What a model that never reads the story scores: it answers `yes` to everything, or `no`, or `unknown`.
// The answer key alone decides, so this is computed without any run.
export function keyBalance(expected: string[]): Balance {
  const classOf = (value: string) => value === 'yes' || value === 'no' || value === 'unknown' ? value : /^-?\d+$/.test(value) ? 'number' : 'other';
  const byExpected: Record<string, number> = {};
  for (const value of expected) byExpected[classOf(value)] = (byExpected[classOf(value)] ?? 0) + 1;
  const share = (name: string) => expected.length ? (byExpected[name] ?? 0) / expected.length : 0;
  const [constantYes, constantNo, silence] = [share('yes'), share('no'), share('unknown')];
  return { keys: expected.length, byExpected, constantYes, constantNo, silence, bestConstant: Math.max(constantYes, constantNo, silence) };
}

export type Cluster = { key: string; runs: number; passed: number; rate: number; flag?: 'never' | 'always' };
// A cluster is one item over the saved runs: one check, or one trap with all its questions. A trap counts as passed in
// a run only when every question of it passed, which is how a reader would read it. Items that never or always pass
// carry no information about a change, whatever their rate does to the headline.
export function clusters(cells: Cell[], keyOf: (key: string) => string): Cluster[] {
  const counts = new Map<string, { runs: number; passed: number }>();
  for (const cell of cells) {
    const groups = new Map<string, boolean>();
    for (const item of cell.items ?? []) groups.set(keyOf(item.key), (groups.get(keyOf(item.key)) ?? true) && item.pass);
    for (const [name, pass] of groups) {
      const row = counts.get(name) ?? { runs: 0, passed: 0 };
      counts.set(name, { runs: row.runs + 1, passed: row.passed + (pass ? 1 : 0) });
    }
  }
  return [...counts].map(([key, { runs, passed }]) => ({ key, runs, passed, rate: round(passed / runs)!,
    ...(passed === 0 ? { flag: 'never' as const } : passed === runs ? { flag: 'always' as const } : {}) }))
    .sort((left, right) => left.rate - right.rate || left.key.localeCompare(right.key));
}

// Seeded so that two runs of this tool over one corpus print the same interval, as a reported number must.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let state = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  state = (state + Math.imul(state ^ (state >>> 7), 61 | state)) ^ state;
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};
// The cluster is the cell, not the question: every question of a cell came out of one replay of one story by one
// model, so questions inside a cell are not independent draws and a question-level interval would be far too narrow.
// Groups are resampled apart, so a statistic over several models keeps each model's number of cells.
export function bootstrap<T>(groups: T[][], statistic: (sample: T[][]) => number | null,
  { samples = 2000, seed = 1 }: { samples?: number; seed?: number } = {}): { low: number; high: number } | null {
  if (!groups.length || groups.some(group => !group.length) || sum(groups.map(group => group.length)) < 2) return null;
  const random = mulberry32(seed);
  const values: number[] = [];
  for (let draw = 0; draw < samples; draw++) {
    const resampled = groups.map(group => Array.from({ length: group.length }, () => group[Math.floor(random() * group.length)]));
    const value = statistic(resampled);
    if (value !== null) values.push(value);
  }
  if (!values.length) return null;
  values.sort((left, right) => left - right);
  const at = (quantile: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(quantile * (values.length - 1))))];
  return { low: round(at(0.025))!, high: round(at(0.975))! };
}

// A cell that scored 0/N because a call failed. eval.ts:139-152 pools it into the headline like any other cell, which
// is why a saved sceneScore can read 0.36 while every question the judge actually saw passed. Such a cell holds no
// observation: in a summary cell every key lands in `failedKeys`, so reading its items back would report the judge
// answering the opposite of the key for questions it never saw, and every check of the scenario as failing a run.
const broken = (cell: Cell) => cell.error !== undefined && cell.passed === 0;

// Which answer key a cell was scored against. The fixtures change between runs — the battle trap set was judged with
// 5, then 14, then 15 questions — and cells of different versions are not one population, nor comparable to a baseline
// computed from today's key. `null`: the scenario's fixture is not on this machine, so the version cannot be told.
export const onCurrentKey = (cell: Cell, keys: Map<string, KeySet>): boolean | null => {
  const size = keys.get(cell.scenario)?.[cell.instrument].size;
  return size ? cell.total === size : null;
};

const SOURCES = ['report', 'summary', 'events'] as const;
// One eval run leaves the same cell in up to three places: the probe's report.json, the eval.json summary and a line
// in logs/eval.jsonl. Nothing links the three — eval.ts strips the probe directory from every logged event
// (eval.ts:98) and the summary never names it — so copies are recognised by what they hold: model, scenario, mode,
// instrument, counts and error code. A source holding that cell twice saw two runs of it, so the count kept is the
// largest one source holds, not the sum; within one source nothing is ever dropped. Two runs that scored alike and
// survived in different places therefore count once, which loses a run rather than inventing two — and inventing two
// is the costly error here, since it would narrow every interval by a factor the corpus did not earn.
export function dedupe(cells: Cell[]): { cells: Cell[]; dropped: number } {
  const signature = (cell: Cell) => [cell.model, cell.scenario, cell.mode, cell.instrument, cell.passed, cell.total, cell.error ?? ''].join('\u0000');
  const counts = new Map<string, Map<Cell['source'], number>>();
  for (const cell of cells) {
    const row = counts.get(signature(cell)) ?? new Map<Cell['source'], number>();
    row.set(cell.source, (row.get(cell.source) ?? 0) + 1);
    counts.set(signature(cell), row);
  }
  // That many cells are then taken from the richest sources first: report.json keeps the judge's own answers, the
  // summary only the failed keys, the event log neither, and the cluster table needs the answers.
  const budgets = new Map([...counts].map(([key, row]) => {
    let left = Math.max(...SOURCES.map(source => row.get(source) ?? 0));
    return [key, new Map(SOURCES.map(source => {
      const take = Math.min(row.get(source) ?? 0, left);
      left -= take;
      return [source, take];
    }))];
  }));
  const kept = cells.filter(cell => {
    const budget = budgets.get(signature(cell))!;
    const left = budget.get(cell.source)!;
    if (!left) return false;
    budget.set(cell.source, left - 1);
    return true;
  });
  return { cells: kept, dropped: cells.length - kept.length };
}

// ——— reading the corpus ———

const itemsFromFailed = (keys: Map<string, string> | undefined, failed: string[]): Item[] | undefined =>
  keys?.size ? [...keys].map(([key, expected]) => ({ key, pass: !failed.includes(key), expected })) : undefined;

// A memory-probe directory: report.json holds the per-question outcome of every mode, and the trap scenes with the
// verdicts scene-judge.ts wrote back into it.
function cellsFromReport(path: string, report: ReplayReport, keys: Map<string, KeySet>): Cell[] {
  const cells: Cell[] = [];
  const key = keys.get(report.scenario);
  for (const [mode, result] of Object.entries(report.modes)) {
    if (!result) continue;
    const common = { run: path, source: 'report' as const, model: report.model, scenario: report.scenario, mode };
    const answers = result.answers ?? [];
    if (answers.length || result.error || result.completedAt) cells.push({ ...common, instrument: 'memory',
      passed: answers.filter(answer => answer.pass).length, total: Math.max(answers.length, key?.memory.size ?? 0),
      items: answers.map(answer => ({ key: answer.key, pass: answer.pass, expected: answer.expected, actual: typeof answer.actual === 'string' ? answer.actual : null })),
      ...(result.completedAt ? {} : { error: result.error ?? 'probe_failed' }) });
    const verdicts = result.verdicts ?? [];
    // Without verdicts a scene cell exists only when the replay finished and the judge then failed. A lab/ directory
    // holds trap scenes of an unfinished research batch and is not a judged cell.
    if (!verdicts.length && !(result.completedAt && result.traps?.length)) continue;
    cells.push({ ...common, instrument: 'scene', passed: verdicts.filter(verdict => verdict.pass).length,
      total: Math.max(verdicts.length, key?.scene.size ?? 0),
      truncated: result.traps?.filter(trap => trap.truncated).length ?? 0,
      items: verdicts.map(verdict => ({ key: verdict.key, pass: verdict.pass, expected: verdict.expected, actual: typeof verdict.actual === 'string' ? verdict.actual : null })),
      ...(verdicts.length ? {} : { error: 'no_scenes' }) });
  }
  return cells;
}

// The eval.json summary: the same cells after eval.ts scored them, with the failed keys but not the judge's answers.
type Summary = { at?: string; models?: Record<string, { cells?: Record<string, Record<string, {
  passed?: number; total?: number; error?: string; failedKeys?: string[];
  scene?: { passed?: number; total?: number; error?: string; failedKeys?: string[] } }>> }> };
function cellsFromSummary(path: string, summary: Summary, keys: Map<string, KeySet>): Cell[] {
  const cells: Cell[] = [];
  for (const [model, entry] of Object.entries(summary.models ?? {})) {
    for (const [scenario, modes] of Object.entries(entry.cells ?? {})) {
      const key = keys.get(scenario);
      for (const [mode, cell] of Object.entries(modes)) {
        const common = { run: path, source: 'summary' as const, model, scenario, mode };
        cells.push({ ...common, instrument: 'memory', passed: cell.passed ?? 0, total: cell.total ?? 0,
          items: itemsFromFailed(key?.memory, cell.failedKeys ?? []), ...(cell.error ? { error: cell.error } : {}) });
        if (cell.scene) cells.push({ ...common, instrument: 'scene', passed: cell.scene.passed ?? 0, total: cell.scene.total ?? 0,
          items: itemsFromFailed(key?.scene, cell.scene.failedKeys ?? []), ...(cell.scene.error ? { error: cell.scene.error } : {}) });
      }
    }
  }
  return cells;
}

// The search walks itself rather than passing `recursive` to readdirSync, because the default root is the whole
// temporary directory and one unreadable subdirectory there would end the walk.
function* find(root: string, depth: number): Generator<string> {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isFile() && (entry.name === 'report.json' || entry.name === 'eval.json')) yield join(root, entry.name);
    else if (entry.isDirectory() && !entry.isSymbolicLink() && depth > 0) yield* find(join(root, entry.name), depth - 1);
  }
}

export function readCorpus(roots: string[], keys: Map<string, KeySet>, depth = 4): { cells: Cell[]; reports: number; summaries: number } {
  const cells: Cell[] = [];
  let [reports, summaries] = [0, 0];
  for (const root of roots) {
    for (const path of find(root, depth)) {
      let data: (ReplayReport & Summary) | null = null;
      try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
      // A GPU measurement report has neither shape, and a lab/ directory has the replay shape but nothing scored in
      // it; both are counted only if they yield a cell, so the source counts say how much was actually read.
      const found = data?.modes && data.model ? cellsFromReport(path, data, keys) : data?.models ? cellsFromSummary(path, data, keys) : [];
      if (!found.length) continue;
      if (data!.modes) reports++; else summaries++;
      cells.push(...found);
    }
  }
  return { cells, reports, summaries };
}

type Event = { event?: string; model?: string; scenario?: string; mode?: string; code?: string; passed?: number; total?: number; truncated?: boolean };
// logs/eval.jsonl, the only source that survives a cleared temporary directory. `mode_complete` and `judged` carry the
// counts of a cell; a mode that ends in `deferred_or_failed` without a `mode_complete` is the 0/N cell eval.ts pools.
// A scene cell cannot be reconstructed here: a missing `judged` means either a failure or a run without --judge.
export function readEventLog(text: string): { cells: Cell[]; lines: number; runs: number } {
  const events: (Event & { run: string; attempt: number })[] = [];
  let run = 0;
  let lines = 0;
  // `eval ceiling` and `eval judge` record no `run_started` (eval.ts:191-205), so their events inherit the run counter
  // of whatever ran before and two ceiling invocations share a run id. Every probe opens with `started`
  // (memory-probe.ts:131), which is the boundary of one invocation and so of one cell.
  const attempts = new Map<string, number>();
  const attemptOf = (event: Event) => `${event.model}\u0000${event.scenario}\u0000${event.mode}`;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event: Event;
    try { event = JSON.parse(line) as Event; } catch { continue; }
    lines++;
    if (event.event === 'run_started') run++;
    if (event.event === 'started') attempts.set(attemptOf(event), (attempts.get(attemptOf(event)) ?? 0) + 1);
    // `eval judge` re-judges the scenes of a finished run to compare judges or wordings and tags every line with the
    // scenario name "judge" (eval.ts:205). Those cells score a different instrument and are not part of any suite.
    if (event.scenario !== 'judge') events.push({ ...event, run: `run-${run}`, attempt: attempts.get(attemptOf(event)) ?? 0 });
  }
  const cells: Cell[] = [];
  const complete = new Set<string>();
  const totals = new Map<string, number>();
  const name = (event: { run: string; attempt: number; model?: string; scenario?: string; mode?: string }) =>
    `${event.run}\u0000${event.attempt}\u0000${event.model}\u0000${event.scenario}\u0000${event.mode}`;
  const truncations = new Map<string, number>();
  for (const event of events) {
    if (event.event === 'trap_scene' && event.truncated) truncations.set(name(event), (truncations.get(name(event)) ?? 0) + 1);
  }
  for (const event of events) {
    if (!event.model || !event.scenario || !event.mode || event.passed === undefined || event.total === undefined) continue;
    const instrument = event.event === 'mode_complete' ? 'memory' as const : event.event === 'judged' ? 'scene' as const : null;
    if (!instrument) continue;
    if (instrument === 'memory') complete.add(name(event));
    totals.set(`${instrument}\u0000${event.scenario}`, event.total);
    cells.push({ run: event.run, source: 'events', model: event.model, scenario: event.scenario, mode: event.mode,
      instrument, passed: event.passed, total: event.total, ...(instrument === 'scene' ? { truncated: truncations.get(name(event)) ?? 0 } : {}) });
  }
  const failed = new Set<string>();
  for (const event of events) {
    if (event.event !== 'deferred_or_failed' || !event.model || !event.scenario || !event.mode) continue;
    // Within one probe invocation a failure after the mode completed is a retry, not a second cell; a later
    // invocation of the same model, scenario and mode is its own cell even when no `run_started` separates them.
    if (complete.has(name(event)) || failed.has(name(event))) continue;
    failed.add(name(event));
    // The fixture count is not in the log; the count the same scenario reported when it finished is.
    cells.push({ run: event.run, source: 'events', model: event.model, scenario: event.scenario, mode: event.mode,
      instrument: 'memory', passed: 0, total: totals.get(`memory\u0000${event.scenario}`) ?? 0, error: event.code ?? 'probe_failed' });
  }
  return { cells, lines, runs: run };
}

// ——— the report ———

export function summarize(input: Cell[], keys: Map<string, KeySet>, options: { samples?: number; seed?: number } = {}) {
  const { cells, dropped } = dedupe(input);
  const modes = [...new Set(cells.map(cell => cell.mode))].sort();
  const models = [...new Set(cells.map(cell => cell.model))].sort();
  const instruments: Instrument[] = ['memory', 'scene'];
  const expectedOf = (instrument: Instrument) => [...keys.values()].flatMap(key => [...key[instrument].values()]);
  // The key of every scenario whose fixture is on this machine; a pack that is not decides nothing here. This
  // describes the suite, not any population of cells: the baseline a score is compared against is the one below.
  const balance = Object.fromEntries(instruments.map(instrument => [instrument, keyBalance(expectedOf(instrument))]));
  // What a constant answer scores on exactly the cells a score is computed over: every cell brings its own scenario's
  // key once, so the baseline is weighted the way the score beside it is. Only a population restricted to the current
  // key can have one — a cell of a retired key, or of a pack this machine does not hold, brings the wrong answers or
  // none at all.
  const baselineOf = (population: Cell[], instrument: Instrument) =>
    keyBalance(population.flatMap(cell => [...(keys.get(cell.scenario)?.[instrument].values() ?? [])]));
  // The same constant read with one vote per story, to sit beside the family-weighted score.
  const familyBaseline = (population: Cell[], instrument: Instrument) => {
    const perScenario = [...new Set(population.map(cell => cell.scenario))]
      .map(name => baselineOf(population.filter(cell => cell.scenario === name), instrument));
    const mean = (pick: (row: Balance) => number) => sum(perScenario.map(pick)) / perScenario.length;
    return perScenario.length ? Math.max(mean(row => row.constantYes), mean(row => row.constantNo), mean(row => row.silence)) : null;
  };

  const scoreOf = (subset: Cell[]) => ({ pooled: round(pooled(subset)), family: round(familyWeighted(subset)), cells: subset.length,
    passed: sum(subset.map(cell => cell.passed)), total: sum(subset.map(cell => cell.total)) });
  const section = (instrument: Instrument, mode: string) => {
    const scoped = cells.filter(cell => cell.instrument === instrument && cell.mode === mode);
    if (!scoped.length) return null;
    const perModel = models.map(model => [model, scoped.filter(cell => cell.model === model)] as const).filter(([, list]) => list.length);
    const clean = scoped.filter(cell => !broken(cell));
    // The only population that is one population: cells scored against the key the fixture holds today.
    const current = scoped.filter(cell => onCurrentKey(cell, keys) === true);
    const worst = (subset: Cell[][]) => {
      const rates = subset.map(list => pooled(list)).filter(rate => rate !== null);
      return rates.length ? Math.min(...rates) : null;
    };
    const worstFamily = (subset: Cell[][]) => {
      const rates = subset.map(list => familyWeighted(list)).filter(rate => rate !== null);
      return rates.length ? Math.min(...rates) : null;
    };
    const groups = perModel.map(([, list]) => list);
    const cleanGroups = perModel.map(([, list]) => list.filter(cell => !broken(cell))).filter(list => list.length);
    const currentGroups = perModel.map(([, list]) => list.filter(cell => onCurrentKey(cell, keys) === true)).filter(list => list.length);
    return {
      // The headline eval.ts prints, and the same number with the failed cells left out, with one vote per story, and
      // over today's key alone. Only the last one is comparable to the baseline, which is why they are printed
      // together: a model whose every cell is of a retired key wins the first three by answering an easier suite.
      headline: { pooledWorstModel: round(worst(groups)), familyWeightedWorstModel: round(worstFamily(groups)),
        pooledWorstModelWithoutFailures: round(worst(cleanGroups)), pooledWorstModelOnCurrentKey: round(worst(currentGroups)),
        baselineBestConstant: current.length ? round(baselineOf(current, instrument).bestConstant) : null,
        baselineBestConstantFamily: round(familyBaseline(current, instrument)) },
      confidence: { pooledWorstModel: bootstrap(groups, worst, options), familyWeightedWorstModel: bootstrap(groups, worstFamily, options),
        pooledWorstModelOnCurrentKey: bootstrap(currentGroups, worst, options) },
      all: scoreOf(scoped), withoutFailures: scoreOf(clean),
      onCurrentKey: { ...scoreOf(current), baseline: baselineOf(current, instrument) },
      // What the current-key score had to leave out, and which models it leaves without a number at all.
      offKey: { cells: scoped.length - current.length, noFixture: scoped.filter(cell => onCurrentKey(cell, keys) === null).length,
        modelsWithoutCurrentKey: perModel.map(([model]) => model).filter(model => !current.some(cell => cell.model === model)) },
      perModel: Object.fromEntries(perModel.map(([model, list]) => [model, { ...scoreOf(list),
        onCurrentKey: scoreOf(list.filter(cell => onCurrentKey(cell, keys) === true)),
        confidence: bootstrap([list], sample => pooled(sample[0]), options) }])),
      failures: { cells: scoped.filter(broken).length, cellShare: round(scoped.filter(broken).length / scoped.length),
        questionShare: round(sum(scoped.filter(broken).map(cell => cell.total)) / (sum(scoped.map(cell => cell.total)) || 1)),
        byCode: Object.fromEntries([...new Set(scoped.filter(broken).map(cell => cell.error!))].sort()
          .map(code => [code, scoped.filter(cell => broken(cell) && cell.error === code).length])),
        truncatedScenes: sum(scoped.map(cell => cell.truncated ?? 0)) },
    };
  };

  // The scores pool a failed cell as 0/N because eval.ts does. The judge rate and the cluster tables say what was
  // seen, so they read observed cells only: the items of a failed summary cell are read back from its failed keys and
  // would otherwise count as the judge answering questions nobody asked, and as every check of the scenario losing a
  // run.
  const observed = cells.filter(cell => !broken(cell));
  // The judge answers yes or no, so a verdict that was not stored is still known: a passed question was answered with
  // its own expected answer, a failed one with the other. Questions the judge never saw are left out.
  const verdicts = observed.filter(cell => cell.instrument === 'scene').flatMap(cell => cell.items ?? []);
  const answered = verdicts.filter(item => item.actual !== null);
  const saidYes = answered.filter(item => item.actual === 'yes' || (item.actual === undefined && (item.pass ? item.expected === 'yes' : item.expected === 'no')));

  const clusterTable = (instrument: Instrument, keyOf: (key: string) => string) => {
    const scoped = observed.filter(cell => cell.instrument === instrument && cell.items?.length);
    const table = clusters(scoped, keyOf);
    return { runs: scoped.length, items: table.length, never: table.filter(row => row.flag === 'never').length,
      always: table.filter(row => row.flag === 'always').length,
      live: table.filter(row => row.flag === undefined && row.rate >= 0.2 && row.rate <= 0.8).length, table };
  };
  const trapOf = new Map([...keys.values()].flatMap(key => [...key.trapOf]));
  const scenarios = [...new Set(cells.map(cell => cell.scenario))].sort();
  // How many answer keys each scenario name covers in the corpus, so that a mixed population is visible rather than
  // implied by the gap between the pooled and the current-key score.
  const keyVersions = Object.fromEntries(instruments.flatMap(instrument => scenarios
    .map(name => [name, cells.filter(cell => cell.instrument === instrument && cell.scenario === name)] as const)
    .filter(([, list]) => list.length).map(([name, list]) => [`${instrument}/${name}`, {
      current: keys.get(name)?.[instrument].size ?? null,
      cellsByTotal: Object.fromEntries([...new Set(list.map(cell => cell.total))].sort((left, right) => left - right)
        .map(total => [total, list.filter(cell => cell.total === total).length])) }])));
  return {
    corpus: { cells: cells.length, runs: new Set(cells.map(cell => cell.run)).size, models, scenarios,
      modes, withItems: cells.filter(cell => cell.items?.length).length, bySource: Object.fromEntries(SOURCES
        .map(source => [source, cells.filter(cell => cell.source === source).length])),
      // Cells of one run that the other sources held too, and the scenarios whose key is not on this machine.
      duplicatesDropped: dropped, withoutFixture: scenarios.filter(name => !keys.has(name)),
      byScenario: Object.fromEntries(scenarios.map(name => [name, cells.filter(cell => cell.scenario === name).length])) },
    answerKey: balance,
    keyVersions,
    judge: { verdicts: verdicts.length, answered: answered.length, yesRate: answered.length ? round(saidYes.length / answered.length) : null },
    scores: Object.fromEntries(instruments.flatMap(instrument => modes.map(mode => [`${instrument}/${mode}`, section(instrument, mode)]))
      .filter(([, value]) => value !== null)),
    clusters: { checks: clusterTable('memory', key => key), traps: clusterTable('scene', key => trapOf.get(key) ?? key),
      questions: clusterTable('scene', key => key) },
  };
}

// The fixed answers of every scenario this machine has, so that a cell holding only failed keys can be read back.
export async function loadKeys(names: string[], pack?: string): Promise<Map<string, KeySet>> {
  const keys = new Map<string, KeySet>();
  for (const name of names) {
    let fixture;
    try { fixture = await loadScenario(name, pack); } catch { continue; }
    keys.set(name, { memory: new Map(fixture.checks.map(([key, , expected]) => [key, expected])),
      scene: new Map(fixture.traps.flatMap(trap => trap.questions.map(([key, , expected]) => [key, expected]))),
      trapOf: new Map(fixture.traps.flatMap(trap => trap.questions.map(([key]) => [key, trap.key]))) });
  }
  return keys;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { reports: { type: 'string' }, events: { type: 'string' }, pack: { type: 'string' },
    scenarios: { type: 'string' }, samples: { type: 'string', default: '2000' }, seed: { type: 'string', default: '1' } } });
  const root = resolve(import.meta.dirname, '..');
  const samples = Number(values.samples);
  const seed = Number(values.seed);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100000 || !Number.isInteger(seed)) throw new Error('Use --samples 1..100000 --seed <integer>');
  // Both writers use mkdtemp under the system temporary directory, so that is where a finished run is by default.
  const roots = (values.reports ?? tmpdir()).split(',').filter(Boolean).map(entry => resolve(entry));
  const events = values.events === 'none' ? null : resolve(values.events ?? join(root, 'logs', 'eval.jsonl'));
  const names = values.scenarios?.split(',').filter(Boolean) ?? (values.pack ? packScenarios(resolve(values.pack)) : ['battle', 'chess', 'dance']);
  const keys = await loadKeys(names, values.pack ? resolve(values.pack) : undefined);
  const corpus = readCorpus(roots, keys);
  const log = events && existsSync(events) ? readEventLog(readFileSync(events, 'utf8')) : { cells: [], lines: 0, runs: 0 };
  const stats = summarize([...corpus.cells, ...log.cells], keys, { samples, seed });
  console.log(JSON.stringify({ sources: { roots, reportDirectories: corpus.reports, evalSummaries: corpus.summaries,
    eventLog: events && existsSync(events) ? { lines: log.lines, runs: log.runs } : null,
    fixtures: [...keys.keys()], seed, samples }, ...stats }, null, 2));
}
