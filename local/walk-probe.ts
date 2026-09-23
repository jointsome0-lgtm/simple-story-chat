// The walk: the model under test writes a story from the seed on its own, one scene per step, with the bot's memory
// compaction on the replay's schedule. A step is either the bot's own continue signal or the author's intervention,
// which the narrator receives as a player's message. Nothing is checked here; local/walk-judge.ts reads every scene
// afterwards. Reads model config, never the bot database. Prints metadata only.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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
import { addSeed, newStory, beginJob, commitTurn, active, saveCheckpoint } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { loadWalk } from './scenarios.ts';
import { compactsAfter } from './walk-panel.ts';
import type { Step } from './walk-panel.ts';

export type WalkStep = Step & { truncated: boolean; ms: number };
// The report written by this probe; a resumed run trusts what an earlier run wrote. `state` is the library after the
// last completed step, so a judge can be given the memory the narrator saw as well as the scenes.
export type WalkReport = {
  scenario: string; model: string; provider: string; startedAt: string; seed: string; authors: string[];
  steps: WalkStep[]; compactions: { afterTurn: number; ms: number }[]; compactionRetries?: number; sceneRetries?: number;
  state?: Library; error?: string; completedAt?: string;
};
// Codes are read from ModelError, Node or SQLite errors, which use strings; a deadline abort is recognized before that.
type Failure = { code?: string; transportCode?: string };

process.umask(0o077);
const { values } = parseArgs({ options: { scenario: { type: 'string' }, pack: { type: 'string' }, resume: { type: 'string' },
  minutes: { type: 'string', default: '60' } } });
const minutes = Number(values.minutes);
if (!values.scenario || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('Use --scenario name [--pack directory] [--resume directory] [--minutes 1..180]');
// The loader refuses a name that is not a built-in walk or a walk of the pack.
const fixture = await loadWalk(values.scenario, values.pack);
const config = { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') };
const model = createModel(config);
const directory = values.resume ? resolve(values.resume) : mkdtempSync(join(tmpdir(), `simple-chat-walk-${fixture.name}-`));
const report: WalkReport = values.resume ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  : { scenario: fixture.name, model: config.model, provider: config.provider, startedAt: new Date().toISOString(), seed: fixture.seed,
    authors: fixture.authors, steps: [], compactions: [] };
if (report.scenario !== fixture.name || report.model !== config.model || report.provider !== config.provider || report.seed !== fixture.seed) throw new Error('Resume mismatch');
delete report.error;
const deadline = AbortSignal.timeout(minutes * 60000);
const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
const store = new Store(':memory:');
// A busy upstream or a dropped connection is waited out, as the replay does; any other failure ends the walk.
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
store.mutate('synthetic', state => {
  if (report.state) { Object.assign(state, report.state); state.job = null; }
  else newStory(state, addSeed(state, fixture.seed).id);
});
const persist = () => { report.state = store.read('synthetic'); save(); };
progress({ event: values.resume ? 'resumed' : 'started', scenario: fixture.name, directory, model: config.model, steps: fixture.steps.length, through: report.steps.length });
try {
  await model.check?.({ signal: deadline });
  for (let index = report.steps.length; index < fixture.steps.length; index++) {
    // After scene 7 and every fourth scene after it the older scenes are compacted into memory; four stay as text.
    if (compactsAfter(index) && !report.compactions.some(c => c.afterTurn === index)) {
      const started = Date.now();
      let metrics;
      // An invalid memory is asked again up to three times, as the owner repeats /compact in the bot.
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
      report.compactions.push(metric); persist(); progress({ event: 'compacted', ...metric });
    }
    const turn = index + 1;
    const step = fixture.steps[index];
    const kind = step ? 'intervention' as const : 'continue' as const;
    // The empty step is what the bot sends for /continue: the start of the story before the first scene, the continue
    // signal after it. The author's intervention goes in as a player's message, with the same narrator rule.
    const job = store.mutate('synthetic', state => {
      const { story, branch } = active(state);
      return beginJob(state, step || (branch.head ? continueInput(state, story.id) : storyNarration(state, story.id).startStory), Date.now());
    });
    const started = Date.now();
    let result;
    // An empty reply is asked again, up to three times; in the bot the player would send the turn again.
    for (let attempt = 0; ; attempt++) {
      result = await provider.generate(makeRequest(store.read('synthetic'), job, config.maxOutputTokens));
      if (result.text.trim()) break;
      if (attempt === 2) throw Object.assign(new Error(), { code: 'empty_scene' });
      report.sceneRetries = (report.sceneRetries ?? 0) + 1; progress({ event: 'scene_retry', turn });
    }
    const truncated = result.finishReason === 'length';
    const text = store.mutate('synthetic', state => {
      const { seed, story } = active(state);
      // A null head (no scenes yet) is never a node id, so the seed start time is used, as the bot does.
      const scene = normalizeScene(result.text, story.nodes[job.head as string]?.time ?? seed.startTime);
      const ref = commitTurn(state, job.id, scene, truncated)!;
      Object.assign(story.nodes[ref.nodeId], { usage: result.usage ?? null, probeTurn: turn });
      saveCheckpoint(state, story, active(state).branch, `Сцена ${turn}`, 'scene');
      return scene;
    });
    report.steps.push({ turn, kind, input: job.input, text, truncated, ms: Date.now() - started });
    persist(); progress({ event: 'scene', turn, kind, ms: Date.now() - started, characters: text.length, truncated, ...result.usage });
  }
  report.completedAt = new Date().toISOString(); save();
  progress({ event: 'complete', directory, scenes: report.steps.length, truncated: report.steps.filter(s => s.truncated).length });
} catch (error) {
  const failure = error as Failure;
  const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
  report.error = code;
  // An uncoded failure is a JavaScript error of this probe; its class tells a bad reply format from a bug.
  const errorName = member(['SyntaxError', 'TypeError', 'RangeError'], (error as Error)?.name) ? (error as Error).name : undefined;
  save(); progress({ event: 'deferred_or_failed', code, errorName, ...safeErrorDetails(error), directory }); process.exitCode = 1;
} finally { store.close(); }
