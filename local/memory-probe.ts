// Replay only frozen synthetic scenes. All inference goes through the running
// bot's background queue; this process never opens its database or starts GPU.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.ts';
import { createBackgroundClient } from './background.ts';
import { compactBranch } from './generation.ts';
import { member, safeErrorDetails } from './model-error.ts';
import type { ModelRequest } from './model.ts';
import { Store } from './store.ts';
import type { ProbeNode } from './story-probe.ts';
import { contextParts, makeRequest } from './prompt.ts';
import { addSeed, newStory, beginJob, commitTurn, active, context, history, emptyLibrary } from '../lib/library.ts';
import type { Library, Usage } from '../lib/library.ts';
import { checks } from '../examples/memory-checks.ts';

// One memory mode of the replay; `state` is the library saved after the last completed step.
export type ModeReport = {
  preemptions: number; compactions: { afterTurn: number }[]; through: number; state?: Library;
  answers?: { key: string; expected: string; actual: unknown; pass: boolean }[]; recallUsage?: Usage | null;
  error?: string; completedAt?: string;
};
// The report written by this probe; a resumed run trusts what an earlier run wrote.
export type ReplayReport = {
  scenario: string; sourceHash: string; model: string; startedAt: string; scope: string;
  modes: { plain?: ModeReport; sgr?: ModeReport }; completedAt?: string;
};
// Evidence written by story-probe.ts; only its scenario, seed and scene inputs are checked.
type Evidence = { report?: { scenario?: string }; state: Library };
// Every scenario module has the same exports as this one.
type Scenario = typeof import('../examples/battle-probe.ts');
// A recall answer after the list check; an entry that is not an object fails with a TypeError.
type Answer = { key?: unknown; value?: unknown };
// Codes are read from ModelError, Node or SQLite errors, which use strings; a deadline abort is recognized before that.
type Failure = { code?: string };

process.umask(0o077);
const { values } = parseArgs({ options: { source: { type: 'string' }, resume: { type: 'string' },
  minutes: { type: 'string', default: '15' } } });
const minutes = Number(values.minutes);
if (!values.source || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new Error('Use --source synthetic-evidence.json [--resume directory] [--minutes 1..30]');
const input = readFileSync(resolve(values.source), 'utf8');
const frozen: Evidence = JSON.parse(input);
// Checked on the next line: a missing scenario is looked up as "undefined", which is not a fixture.
const scenario = frozen.report?.scenario as keyof typeof checks;
if (!Object.hasOwn(checks, scenario)) throw new Error('Not a synthetic scenario');
const fixture: Scenario = await import(`../examples/${scenario}-probe.ts`);
const source = active(frozen.state);
if (`${source.seed.title}\n${source.seed.startTime}\n${source.seed.text}` !== fixture.seed) throw new Error('Synthetic seed mismatch');
const scenes = (history(source.story, source.branch.head) as ProbeNode[]).filter(n => n.probeTurn <= fixture.turns.length);
if (scenes.length !== fixture.turns.length || scenes.some((n, i) => n.input !== fixture.turns[i])) throw new Error('Synthetic input mismatch');
const config = loadConfig();
const client = createBackgroundClient({ socketPath: config.dbPath + '.model.sock', model: config.model });
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
  for (let attempt = 0; attempt < 20; attempt++) {
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
  await client.check({ signal: deadline });
  for (const memoryMode of ['plain', 'sgr'] as const) {
    current = report.modes[memoryMode] ??= { preemptions: 0, compactions: [], through: 0 };
    if (current.completedAt) continue;
    delete current.error;
    store.mutate('synthetic', state => {
      if (current!.state) { Object.assign(state, current!.state); state.job = null; }
      else { for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]; Object.assign(state, emptyLibrary());
        newStory(state, addSeed(state, fixture.seed).id); }
    });
    const persist = () => { current!.state = store.read('synthetic'); save(); };
    for (let index = current.through; index <= scenes.length; index++) {
      if ([7, 11, 15].includes(index) && !current.compactions.some(c => c.afterTurn === index)) {
        const job = store.mutate('synthetic', state => beginJob(state, 'Сжать.', 0));
        const started = Date.now();
        // The same rows the bot writes for a compaction: one per model request and one for the saved memory.
        const metrics = await compactBranch({ store, userId: 'synthetic', jobId: job.id, provider,
          config: { ...config, memoryMode, keepScenes: 4 }, signal: deadline,
          log: (event, _code, details) => progress({ event, mode: memoryMode, ...safeErrorDetails(details) }) });
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
      store.mutate('synthetic', state => {
        const job = beginJob(state, scenes[index].input, index);
        commitTurn(state, job.id, scenes[index].text);
      });
      current.through = index + 1; persist();
    }
    const questions = checks[scenario];
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
    const parsed: { answers?: unknown } = JSON.parse(result.text);
    if (!Array.isArray(parsed.answers) || parsed.answers.length !== questions.length || new Set((parsed.answers as Answer[]).map(a => a.key)).size !== questions.length) {
      throw Object.assign(new Error(), { code: 'invalid_recall' });
    }
    current.answers = questions.map(([key, , expected]) => {
      const actual = (parsed.answers as Answer[]).find(a => a.key === key)?.value;
      return { key, expected, actual, pass: typeof actual === 'string' && actual.trim() === expected };
    });
    current.recallUsage = result.usage;
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
  save(); progress({ event: 'deferred_or_failed', code, ...safeErrorDetails(error), directory }); process.exitCode = 1;
} finally { store.close(); }
