// Replay only frozen synthetic scenes. All inference goes through the running
// bot's background queue; this process never opens its database or starts GPU.
// With --direct the configured provider is called from this process instead, without the bot.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { loadConfig, loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import { createBackgroundClient } from './background.ts';
import { compactBranch } from './generation.ts';
import { member, safeErrorDetails } from './model-error.ts';
import type { ModelRequest } from './model.ts';
import { Store } from './store.ts';
import type { ProbeNode } from './story-probe.ts';
import { contextParts, makeRequest } from './prompt.ts';
import { addSeed, newStory, beginJob, commitTurn, active, context, history, emptyLibrary } from '../lib/library.ts';
import type { Library, Usage } from '../lib/library.ts';
import { loadScenario } from './scenarios.ts';

// One memory mode of the replay; `state` is the library saved after the last completed step.
export type ModeReport = {
  preemptions: number; compactions: { afterTurn: number }[]; through: number; state?: Library;
  // Compactions repeated after an invalid memory, as the owner repeats /compact in the bot. Sources and checkpoints are kept.
  compactionRetries?: number;
  answers?: { key: string; expected: string; actual: unknown; pass: boolean }[]; recallUsage?: Usage | null;
  // With --traps: one scene per continuity trap, each written from the same final state and never committed.
  // local/scene-judge.ts adds the verdicts.
  traps?: { key: string; text: string; truncated: boolean }[];
  verdicts?: { key: string; expected: string; actual: unknown; pass: boolean }[];
  error?: string; completedAt?: string;
};
// The report written by this probe; a resumed run trusts what an earlier run wrote.
export type ReplayReport = {
  scenario: string; sourceHash: string; model: string; startedAt: string; scope: string;
  modes: { plain?: ModeReport; sgr?: ModeReport; full?: ModeReport }; completedAt?: string;
};
// Evidence written by story-probe.ts; only its scenario, seed and scene inputs are checked.
type Evidence = { report?: { scenario?: string }; state: Library };
// A recall answer after the list check; an entry that is not an object fails with a TypeError.
type Answer = { key?: unknown; value?: unknown };
// Codes are read from ModelError, Node or SQLite errors, which use strings; a deadline abort is recognized before that.
type Failure = { code?: string };

process.umask(0o077);
const { values } = parseArgs({ options: { source: { type: 'string' }, resume: { type: 'string' },
  minutes: { type: 'string', default: '15' }, direct: { type: 'boolean', default: false }, mode: { type: 'string' },
  traps: { type: 'boolean', default: false }, pack: { type: 'string' } } });
const minutes = Number(values.minutes);
if (!values.source || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new Error('Use --source synthetic-evidence.json [--resume directory] [--minutes 1..30] [--direct] [--mode plain|sgr|full] [--traps] [--pack directory]');
// `full` never compacts: the questions are asked over the whole story. A strong model that fails them there shows
// that the frozen scenes contradict the fixed answers.
if (values.mode !== undefined && values.mode !== 'plain' && values.mode !== 'sgr' && values.mode !== 'full') throw new Error('Unknown memory mode');
// One failed mode ends the run, so eval replays each mode on its own.
const modes = values.mode ? [values.mode] as const : ['plain', 'sgr'] as const;
const input = readFileSync(resolve(values.source), 'utf8');
const frozen: Evidence = JSON.parse(input);
// The loader refuses a name that is not a built-in scenario or a scenario of the pack.
const scenario = String(frozen.report?.scenario);
const fixture = await loadScenario(scenario, values.pack);
const source = active(frozen.state);
if (`${source.seed.title}\n${source.seed.startTime}\n${source.seed.text}` !== fixture.seed) throw new Error('Synthetic seed mismatch');
const scenes = (history(source.story, source.branch.head) as ProbeNode[]).filter(n => n.probeTurn <= fixture.turns.length);
if (scenes.length !== fixture.turns.length || scenes.some((n, i) => n.input !== fixture.turns[i])) throw new Error('Synthetic input mismatch');
const config = values.direct ? { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') } : loadConfig();
const client = createBackgroundClient({ socketPath: config.dbPath + '.model.sock', model: config.model });
const direct = values.direct ? createModel(config) : null;
const directory = values.resume ? resolve(values.resume) : mkdtempSync(join(tmpdir(), `simple-chat-memory-${scenario}-`));
const sourceHash = createHash('sha256').update(input).digest('hex');
const report: ReplayReport = values.resume ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  : { scenario, sourceHash, model: config.model, startedAt: new Date().toISOString(),
    scope: 'Paired replay of identical frozen synthetic scenes, three compactions, four retained scenes; not a 44K quality test.', modes: {} };
if (report.sourceHash !== sourceHash || report.model !== config.model || report.scenario !== scenario) throw new Error('Resume mismatch');
const deadline = AbortSignal.timeout(minutes * 60000);
// Each line has its time, so a compaction here can be matched with the bot log and the GPU snapshots.
const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
// Set at the start of each mode, before the store or the provider uses it.
let current: ModeReport | undefined;
const provider = { async generate(request: ModelRequest) {
  for (let attempt = 0; direct && attempt < 20; attempt++) {
    try { return await direct.generate(request, { signal: deadline }); }
    catch (error) {
      // A dropped connection is retried like a busy upstream; any other failure ends the mode.
      const failure = error as Failure & { transportCode?: string };
      if (failure.code !== 'rate_limited' && !(failure.code === 'provider_failed' && failure.transportCode)) throw error;
      current!.preemptions++;
      save();
      progress({ event: 'yielded', code: failure.code });
      // A hosted free model allows 20 requests a minute, and its upstream is often busy for minutes.
      await wait(30000, undefined, { signal: deadline });
    }
  }
  for (let attempt = 0; !direct && attempt < 20; attempt++) {
    deadline.throwIfAborted();
    // Background work is served only with GPU control, so the status includes its snapshot.
    const state = await client.check({ signal: deadline }) as { gpu: { status: string } };
    if (state.gpu.status === 'paused') throw Object.assign(new Error(), { code: 'gpu_paused' });
    try { return await client.generate(request, { signal: deadline }); }
    catch (error) {
      const failure = error as Failure;
      if (!member(['background_preempted', 'background_unavailable'], failure.code)) throw error;
      current!.preemptions++;
      save();
      progress({ event: 'yielded', code: failure.code });
      // The scheduler enforces its quiet period. No immediate GPU retry here.
    }
  }
  throw Object.assign(new Error(), { code: 'retry_limit' });
} };
const store = new Store(':memory:');
progress({ event: 'started', scenario, directory, model: config.model });
try {
  await (direct ? direct.check?.({ signal: deadline }) : client.check({ signal: deadline }));
  for (const memoryMode of modes) {
    current = report.modes[memoryMode] ??= { preemptions: 0, compactions: [], through: 0 };
    if (current.completedAt) continue;
    delete current.error;
    store.mutate('synthetic', state => {
      if (current!.state) { Object.assign(state, current!.state); state.job = null; }
      else { for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]; Object.assign(state, emptyLibrary());
        newStory(state, addSeed(state, fixture.seed).id); }
    });
    const persist = () => { current!.state = store.read('synthetic'); save(); };
    // One uncommitted scene per trap: the real narrator request, as the bot builds it for a player's message.
    const writeTraps = async (after: number | undefined) => {
      for (const trap of values.traps ? fixture.traps : []) {
        if (trap.afterTurn !== after || current!.traps?.some(done => done.key === trap.key)) continue;
        const turn = store.mutate('synthetic', state => beginJob(state, trap.input ?? fixture.turns[trap.afterTurn!], 0));
        let scene;
        try { scene = await provider.generate(makeRequest(store.read('synthetic'), turn, config.maxOutputTokens)); }
        finally { store.mutate('synthetic', state => { state.job = null; }); }
        (current!.traps ??= []).push({ key: trap.key, text: scene.text, truncated: scene.finishReason !== 'stop' });
        persist(); progress({ event: 'trap_scene', mode: memoryMode, characters: scene.text.length, truncated: scene.finishReason !== 'stop' });
      }
    };
    for (let index = current.through; index <= scenes.length; index++) {
      if (memoryMode !== 'full' && [7, 11, 15].includes(index) && !current.compactions.some(c => c.afterTurn === index)) {
        const started = Date.now();
        let metrics;
        for (let attempt = 0; ; attempt++) {
          const job = store.mutate('synthetic', state => beginJob(state, 'Сжать.', 0));
          // The same rows the bot writes for a compaction: one per model request and one for the saved memory.
          try {
            metrics = await compactBranch({ store, userId: 'synthetic', jobId: job.id, provider,
              config: { ...config, memoryMode, keepScenes: 4 }, signal: deadline,
              log: (event, _code, details) => progress({ event, mode: memoryMode, ...safeErrorDetails(details) }) });
            break;
          } catch (error) {
            if ((error as Failure).code !== 'invalid_memory' || attempt === 2) throw error;
            store.mutate('synthetic', state => { state.job = null; });
            current.compactionRetries = (current.compactionRetries ?? 0) + 1;
            progress({ event: 'compaction_retry', mode: memoryMode, ...safeErrorDetails(error) });
          }
        }
        store.mutate('synthetic', state => { state.job = null; });
        const state = store.read('synthetic');
        const { story, branch } = active(state);
        // compactBranch has just saved a memory version.
        const memory = context(story, branch).memories.at(-1)!;
        const text = contextParts(state, { ...branch, storyId: story.id }).memory[0].content;
        const metric = { afterTurn: index, ms: Date.now() - started, ...metrics,
          incrementJsonBytes: Buffer.byteLength(JSON.stringify(memory.delta)),
          accumulatedPromptBytes: Buffer.byteLength(text), evidence: memory.delta.sgr?.evidence.length ?? 0,
          conflicts: memory.delta.sgr?.conflicts.length ?? 0 };
        current.compactions.push(metric); persist(); progress({ event: 'compacted', mode: memoryMode, ...metric });
      }
      if (index === scenes.length) break;
      await writeTraps(index);
      store.mutate('synthetic', state => {
        const job = beginJob(state, scenes[index].input, index);
        commitTurn(state, job.id, scenes[index].text);
      });
      current.through = index + 1; persist();
    }
    const questions = fixture.checks;
    const job = store.mutate('synthetic', state => beginJob(state,
      'Проверка памяти, не продолжай историю. Верни JSON {"answers":[{"key":"ключ", "value":"точный ответ строкой"}]}. Без пояснений и единиц, если вопрос требует число. Неизвестное пометь unknown.\n'
        + questions.map(([key, question]) => `${key}: ${question}`).join('\n'), 0));
    const request = makeRequest(store.read('synthetic'), job, 1024);
    request.system = 'Ответь на проверочные вопросы только по переданной истории и её памяти. Соблюдай заданный формат, не достраивай неизвестное.';
    request.purpose = 'memory';
    request.outputSchema = { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: {
      type: 'array', minItems: questions.length, maxItems: questions.length, items: { type: 'object', required: ['key', 'value'], additionalProperties: false,
        properties: { key: { type: 'string', enum: questions.map(q => q[0]) }, value: { type: 'string' } } } } } };
    const result = await provider.generate(request);
    if (result.finishReason !== 'stop') throw Object.assign(new Error(), { code: 'truncated_recall' });
    // A reply that is not a JSON object fails with a TypeError when its answers are read.
    // Without a JSON mode Haiku wraps the answer in one Markdown code block, as it does for memory; see memory.ts.
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(result.text.trim());
    const parsed: { answers?: unknown } = JSON.parse(fenced ? fenced[1] : result.text);
    if (!Array.isArray(parsed.answers) || parsed.answers.length !== questions.length || new Set((parsed.answers as Answer[]).map(a => a.key)).size !== questions.length) {
      throw Object.assign(new Error(), { code: 'invalid_recall' });
    }
    current.answers = questions.map(([key, , expected]) => {
      const actual = (parsed.answers as Answer[]).find(a => a.key === key)?.value;
      return { key, expected, actual, pass: typeof actual === 'string' && actual.trim() === expected };
    });
    current.recallUsage = result.usage;
    store.mutate('synthetic', state => { state.job = null; });
    await writeTraps(undefined);
    current.completedAt = new Date().toISOString();
    store.mutate('synthetic', state => { state.job = null; }); persist();
    progress({ event: 'mode_complete', mode: memoryMode, passed: current.answers.filter(a => a.pass).length, total: questions.length });
  }
  report.completedAt = new Date().toISOString(); save(); progress({ event: 'complete', directory });
} catch (error) {
  const failure = error as Failure;
  const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
  if (current) current.error = code;
  // A failed compaction carries its sizes and counts on the error.
  // An uncoded failure is a JavaScript error of this probe; its class tells a bad reply format from a bug.
  const errorName = member(['SyntaxError', 'TypeError', 'RangeError'], (error as Error)?.name) ? (error as Error).name : undefined;
  save(); progress({ event: 'deferred_or_failed', code, errorName, ...safeErrorDetails(error), directory }); process.exitCode = 1;
} finally { store.close(); }
