// One scene from a prefix: the model continues a walk from the scenes it is given (the gold tree's path to a node)
// with one more step, as the bot's narrator. Two uses: the writer that grows the gold tree sees the whole prefix as
// text, and a model under test replays the prefix through its own memory compaction first, as the bot would. With a
// repair in the task the writer rewrites a rejected scene without the findings against it. Writes a walk-shaped
// report, so that local/walk-judge.ts reads the new scene against the seed and the prefix. Prints metadata only.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import type { ModelRequest } from './model.ts';
import { compactBranch } from './generation.ts';
import { member, safeErrorDetails } from './model-error.ts';
import { Store } from './store.ts';
import { makeRequest, normalizeScene, storyNarration } from './prompt.ts';
import { continueInput } from './context.ts';
import { addSeed, newStory, beginJob, commitTurn, active, history } from '../lib/library.ts';
import { loadWalk } from './scenarios.ts';
import { compactsAfter } from './walk-panel.ts';
import type { Step, Contradiction } from './walk-panel.ts';
import type { WalkReport } from './walk-probe.ts';

// The task file: the prefix (the scenes on the path from the seed), the step to write, and for a repair the rejected
// text with the findings the council confirmed against it.
export type TaskFile = { prefix: Step[]; step: string; repair?: { text: string; findings: Contradiction[] } };
type Failure = { code?: string; transportCode?: string };

process.umask(0o077);
const { values } = parseArgs({ options: { scenario: { type: 'string' }, pack: { type: 'string' }, task: { type: 'string' }, out: { type: 'string' },
  compact: { type: 'boolean', default: false }, from: { type: 'string' }, minutes: { type: 'string', default: '30' } } });
const minutes = Number(values.minutes);
if (!values.scenario || !values.task || !values.out || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('Use --scenario name --task file --out directory [--pack directory] [--compact] [--from report.json] [--minutes 1..180]');
const fixture = await loadWalk(values.scenario, values.pack);
const task = JSON.parse(readFileSync(resolve(values.task), 'utf8')) as TaskFile;
if (!Array.isArray(task.prefix) || typeof task.step !== 'string' || task.prefix.some((s, i) => s.turn !== i + 1 || typeof s.text !== 'string' || typeof s.input !== 'string')) throw new Error('Invalid task file');
const config = { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') };
const model = createModel(config);
const directory = resolve(values.out);
mkdirSync(directory, { recursive: true });
const turn = task.prefix.length + 1;
const report: WalkReport & { task: { turn: number; repair: boolean; compact: boolean } } = { scenario: fixture.name, model: config.model, provider: config.provider, startedAt: new Date().toISOString(),
  seed: fixture.seed, authors: fixture.authors, steps: task.prefix.map(s => ({ ...s, truncated: false, ms: 0 })), compactions: [], task: { turn, repair: !!task.repair, compact: values.compact } };
const deadline = AbortSignal.timeout(minutes * 60000);
const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
const store = new Store(':memory:');
const provider = { async generate(request: ModelRequest) {
  for (let attempt = 0; ; attempt++) {
    try { return await model.generate(request, { signal: deadline }); }
    catch (error) {
      const failure = error as Failure;
      if (attempt === 19 || (failure.code !== 'rate_limited' && !(failure.code === 'provider_failed' && failure.transportCode))) throw error;
      progress({ event: 'yielded', code: failure.code });
      await wait(30000, undefined, { signal: deadline });
    }
  }
} };
// --from continues from the library an earlier task of the same model left: the scenes it holds must be the start of
// this prefix, and its memory of them is reused, the compaction being the same request either way.
const earlier = values.from ? JSON.parse(readFileSync(resolve(values.from), 'utf8')) as WalkReport : null;
if (earlier && (!earlier.state || earlier.seed !== fixture.seed || earlier.model !== config.model || earlier.provider !== config.provider)) throw new Error('--from mismatch');
store.mutate('synthetic', state => {
  if (earlier?.state) { Object.assign(state, earlier.state); state.job = null; }
  else newStory(state, addSeed(state, fixture.seed).id);
});
const held = store.read('synthetic');
const done = earlier ? history(active(held).story, active(held).branch.head) : [];
if (done.length > task.prefix.length || done.some((node, i) => node.text !== task.prefix[i].text || node.input !== task.prefix[i].input)) throw new Error('--from mismatch');
report.compactions = earlier?.compactions.filter(c => c.afterTurn <= done.length) ?? [];
progress({ event: 'started', scenario: fixture.name, directory, model: config.model, turn, repair: !!task.repair, compact: values.compact, reused: done.length });
try {
  await model.check?.({ signal: deadline });
  // The prefix is replayed into the library as the bot's own scenes. With --compact the model under test compacts on
  // the walk's schedule, so the new scene is written from its memory; without it the whole prefix stays as text.
  for (let index = done.length; index < task.prefix.length; index++) {
    if (values.compact && compactsAfter(index) && !report.compactions.some(c => c.afterTurn === index)) {
      const started = Date.now();
      let metrics;
      for (let attempt = 0; ; attempt++) {
        const job = store.mutate('synthetic', state => beginJob(state, 'Сжать.', Date.now()));
        try {
          metrics = await compactBranch({ store, userId: 'synthetic', jobId: job.id, provider, config: { ...config, keepScenes: 4 }, signal: deadline,
            log: (event, _code, details) => progress({ event, ...safeErrorDetails(details) }) });
          break;
        } catch (error) {
          if ((error as Failure).code !== 'invalid_memory' || attempt === 2) throw error;
          store.mutate('synthetic', state => { state.job = null; });
          report.compactionRetries = (report.compactionRetries ?? 0) + 1;
          progress({ event: 'compaction_retry', ...safeErrorDetails(error) });
        }
      }
      store.mutate('synthetic', state => { state.job = null; });
      const metric = { afterTurn: index, ms: Date.now() - started, ...metrics };
      report.compactions.push(metric); progress({ event: 'compacted', ...metric });
    }
    const given = task.prefix[index];
    store.mutate('synthetic', state => { const job = beginJob(state, given.input, Date.now()); commitTurn(state, job.id, given.text, false); });
  }
  // The library after the prefix, with the memory the model built over it, is what a later task of the same model
  // continues from; the new scene is not in it.
  report.state = store.read('synthetic'); save();
  const step = task.step;
  const kind = step ? 'intervention' as const : 'continue' as const;
  const job = store.mutate('synthetic', state => {
    const { story, branch } = active(state);
    return beginJob(state, step || (branch.head ? continueInput(state, story.id) : storyNarration(state, story.id).startStory), Date.now());
  });
  const request = makeRequest(store.read('synthetic'), job, config.maxOutputTokens);
  if (task.repair) {
    // The editor's note goes after the narrator's rule, at the end of the request, where the rule itself was measured
    // to work; the findings are quoted so the writer sees what to avoid, and the rejected text so it does not repeat it.
    const lines = task.repair.findings.map((f, i) => `${i + 1}. Сейчас: «${f.now}» — раньше (${f.where}): «${f.before}»`);
    const last = request.messages.at(-1)!;
    last.content += `\n\nУказание редактора (не часть истории, в тексте сцены не упоминай): прежняя версия этой сцены отклонена за противоречия с сидом и предыдущими сценами. Напиши сцену на этот же шаг заново: без этих противоречий и без новых, не повторяя прежний текст дословно.\nПротиворечия прежней версии:\n${lines.join('\n')}\n\nПрежняя версия:\n${task.repair.text}`;
  }
  const started = Date.now();
  let result;
  for (let attempt = 0; ; attempt++) {
    result = await provider.generate(request);
    if (result.text.trim()) break;
    if (attempt === 2) throw Object.assign(new Error(), { code: 'empty_scene' });
    report.sceneRetries = (report.sceneRetries ?? 0) + 1; progress({ event: 'scene_retry', turn });
  }
  const truncated = result.finishReason === 'length';
  const text = store.mutate('synthetic', state => {
    const { seed, story } = active(state);
    const scene = normalizeScene(result.text, story.nodes[job.head as string]?.time ?? seed.startTime);
    commitTurn(state, job.id, scene, truncated);
    return scene;
  });
  report.steps.push({ turn, kind, input: job.input, text, truncated, ms: Date.now() - started });
  report.completedAt = new Date().toISOString(); save();
  progress({ event: 'scene', turn, kind, ms: Date.now() - started, characters: text.length, truncated, ...result.usage });
  progress({ event: 'complete', directory, scenes: report.steps.length, truncated: truncated ? 1 : 0 });
} catch (error) {
  const failure = error as Failure;
  const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
  report.error = code;
  const errorName = member(['SyntaxError', 'TypeError', 'RangeError'], (error as Error)?.name) ? (error as Error).name : undefined;
  save(); progress({ event: 'deferred_or_failed', code, errorName, ...safeErrorDetails(error), directory }); process.exitCode = 1;
} finally { store.close(); }
