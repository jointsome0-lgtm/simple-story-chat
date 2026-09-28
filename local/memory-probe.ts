// Replay only frozen synthetic scenes. All inference goes through the running
// bot's background queue; this process never opens its database or starts GPU.
// With --direct the configured provider is called from this process instead, without the bot.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { loadConfig, loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import { createLlama } from './llama.ts';
import { createBackgroundClient } from './background.ts';
import { compactBranch } from './generation.ts';
import { member, safeErrorDetails } from './model-error.ts';
import type { ModelRequest } from './model.ts';
import { Store } from './store.ts';
import type { ProbeNode } from './story-probe.ts';
import { contextParts, makeRequest, normalizeScene } from './prompt.ts';
import { addSeed, newStory, beginJob, commitTurn, active, context, history, emptyLibrary } from '../lib/library.ts';
import type { Library, Usage } from '../lib/library.ts';
import { loadScenario } from './scenarios.ts';

// One memory mode of the replay; `state` is the library saved after the last completed step.
export type ModeReport = {
  preemptions: number; compactions: { afterTurn: number }[]; through: number; state?: Library;
  // Compactions repeated after an invalid memory, as the owner repeats /compact in the bot. Sources and checkpoints are kept.
  compactionRetries?: number;
  // `stated` is set for a numeric answer of two digits or more: whether the number stands in the memory message or in
  // the scenes kept as text. A sum stated nowhere had to be added at recall; a stated one that failed is a reading miss.
  answers?: { key: string; expected: string; actual: unknown; pass: boolean; stated?: 'memory' | 'scenes' | 'none' }[]; recallUsage?: Usage | null;
  // Set when the recall thought (RECALL_THINKING).
  recallThinking?: boolean;
  // With --traps: one scene per continuity trap, each written from the same final state and never committed.
  // local/scene-judge.ts adds the verdicts.
  traps?: TrapScene[];
  verdicts?: { key: string; expected: string; actual: unknown; pass: boolean }[];
  error?: string; completedAt?: string;
};
// `then`: the scene written over the trap's scene, or the code of the failure that left it unwritten.
type TrapScene = { key: string; text: string; truncated: boolean; then?: { text: string; truncated: boolean } | { error: string } };
// The report written by this probe; a resumed run trusts what an earlier run wrote.
// `recallFrom`: the replay whose saved memories this run's recall read again (RECALL_FROM); such a run compacts nothing.
export type ReplayReport = {
  scenario: string; sourceHash: string; model: string; startedAt: string; scope: string; recallFrom?: string;
  modes: { plain?: ModeReport; sgr?: ModeReport; full?: ModeReport }; completedAt?: string;
};
// Evidence written by story-probe.ts; only its scenario, seed and scene inputs are checked.
type Evidence = { report?: { scenario?: string }; state: Library };
// A recall answer after the list check; an entry that is not an object fails with a TypeError.
type Answer = { key?: unknown; value?: unknown };
// Codes are read from ModelError, Node or SQLite errors, which use strings; a deadline abort is recognized before that.
type Failure = { code?: string };

process.umask(0o077);
const RECALL_OUTPUT_TOKENS = 8192;
// RECALL_THINKING=true lets the recall think, so that the reader is measured apart from its memory (docs/eval.md#reader).
// The reasoning counts against the output limit, which grows to 16384, the limit the thinking compactions of 2026-09-27
// had. Off by default, as the scenes are. No SIMPLE_CHAT_ prefix, as MEMORY_THINKING has none: the eval passes none to
// its probes.
const RECALL_THINKING_TOKENS = 8192;
const thinkingSetting = process.env.RECALL_THINKING || 'false';
if (!['true', 'false'].includes(thinkingSetting)) throw new Error('Invalid RECALL_THINKING');
const recallThinking = thinkingSetting === 'true';
// A control for one measurement, removed after it: RECALL_ROOM=true gives a recall that does not think the thinking
// recall's output limit, so that OpenRouter picks among the same endpoints for both.
const recallRoom = process.env.RECALL_ROOM === 'true';
const { values } = parseArgs({ options: { source: { type: 'string' }, resume: { type: 'string' },
  minutes: { type: 'string', default: '15' }, direct: { type: 'boolean', default: false }, mode: { type: 'string' },
  traps: { type: 'boolean', default: false }, pack: { type: 'string' }, lab: { type: 'string' } } });
const minutes = Number(values.minutes);
// --lab is research, not the meter: every trap scene is written once per variant and sample. A variant is a text added
// to the end of the last message, so all of them share the prompt prefix and an own GPU pays the prefill once per trap.
// The file is { "samples": n, "variants": [{ "key": "base", "tail": "" }, ...] }; each pair gets its own report
// under lab/ in the shape scene-judge.ts reads.
// "parallel" is how many scenes are requested at once; it pays off when the server has as many slots.
// "only" names the traps to write, so that samples go to the traps that tell variants apart.
// "many" asks for all samples of a variant in one request. It is off by default: on the pinned llama-server such a request
// failed with a context error once another slot held an earlier sequence, although the same requests pass one by one.
type Lab = { samples: number; parallel?: number; only?: string[]; many?: boolean; variants: { key: string; tail: string }[] };
const lab: Lab | null = values.lab ? JSON.parse(readFileSync(resolve(values.lab), 'utf8')) : null;
if (lab && (!Number.isInteger(lab.samples) || lab.samples < 1 || lab.samples > 10 || ![1, 2, 3, 4, 5, 6, 7, 8].includes(lab.parallel ?? 1) || (lab.only !== undefined && !(Array.isArray(lab.only) && lab.only.every(key => typeof key === 'string'))) || !Array.isArray(lab.variants) || !lab.variants.length
    || !lab.variants.every(variant => /^[a-z][a-z0-9-]{0,23}$/.test(variant?.key) && typeof variant.tail === 'string' && variant.tail.length <= 2000))) throw new Error('Invalid --lab file');
if (!values.source || !Number.isInteger(minutes) || minutes < 1 || minutes > (lab ? 600 : 30)) throw new Error('Use --source synthetic-evidence.json [--resume directory] [--minutes 1..30] [--direct] [--mode plain|sgr|full] [--traps] [--pack directory] [--lab variants.json]');
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
const llamaLab = values.direct && lab && config.provider === 'llama-cpp' ? createLlama(config, { slots: lab.parallel ?? 1 }) : null;
const labClient = lab?.many && lab.samples <= (lab.parallel ?? 1) ? llamaLab : null;
const direct = !values.direct ? null : llamaLab ?? createModel(config);
const directory = values.resume ? resolve(values.resume) : mkdtempSync(join(tmpdir(), `simple-chat-memory-${scenario}-`));
const sourceHash = createHash('sha256').update(input).digest('hex');
const report: ReplayReport = values.resume ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  : { scenario, sourceHash, model: config.model, startedAt: new Date().toISOString(),
    scope: 'Paired replay of identical frozen synthetic scenes, three compactions, four retained scenes; not a 44K quality test.', modes: {} };
if (report.sourceHash !== sourceHash || report.model !== config.model || report.scenario !== scenario) throw new Error('Resume mismatch');
// RECALL_FROM names finished replays of the same frozen scenes by their probe directories, comma-separated. The one of
// this scenario gives each mode the final state it saved, memories and all, and only the recall is asked again, in a
// directory of its own: two readers compared over the same memories, with nothing compacted again.
const earlier = process.env.RECALL_FROM?.split(',').map(path => resolve(path))
  .map(path => ({ path, report: JSON.parse(readFileSync(join(path, 'report.json'), 'utf8')) as ReplayReport }))
  .filter(run => run.report.scenario === scenario);
if (earlier && (earlier.length !== 1 || values.resume || values.traps || lab || earlier[0].report.sourceHash !== sourceHash
  || earlier[0].report.model !== config.model || modes.some(mode => !earlier[0].report.modes[mode]?.completedAt))) {
  throw new Error('RECALL_FROM names one finished replay of this scenario, model and mode, for a new run without --traps or --lab');
}
if (earlier) report.recallFrom = earlier[0].path;
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
    // Background work is served only with GPU control, so the status includes its snapshot. A card that is pausing
    // takes no probe, and its queue refuses one at once (local/gpu.ts), so the run ends here instead of spending its
    // retries in a moment. Any other retry waits in the bot's queue.
    const state = await client.check({ signal: deadline }) as { gpu: { status: string } };
    if (member(['draining', 'stopping', 'paused'], state.gpu.status)) throw Object.assign(new Error(), { code: 'gpu_paused' });
    try { return await client.generate(request, { signal: deadline }); }
    catch (error) {
      const failure = error as Failure;
      if (!member(['background_preempted', 'background_unavailable'], failure.code)) throw error;
      current!.preemptions++;
      save();
      progress({ event: 'yielded', code: failure.code });
    }
  }
  throw Object.assign(new Error(), { code: 'retry_limit' });
} };
const store = new Store(':memory:');
progress({ event: 'started', scenario, directory, model: config.model, ...(recallThinking ? { recallThinking } : {}), ...(recallRoom ? { recallRoom } : {}), ...(earlier ? { reread: true } : {}) });
try {
  await (direct ? direct.check?.({ signal: deadline }) : client.check({ signal: deadline }));
  for (const memoryMode of modes) {
    const saved = earlier?.[0].report.modes[memoryMode];
    current = report.modes[memoryMode] ??= { preemptions: 0, compactions: [], through: saved?.through ?? 0, ...(saved ? { state: saved.state } : {}) };
    if (current.completedAt) continue;
    delete current.error;
    store.mutate('synthetic', state => {
      if (current!.state) { Object.assign(state, current!.state); state.job = null; }
      else { for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]; Object.assign(state, emptyLibrary());
        newStory(state, addSeed(state, fixture.seed).id); }
    });
    const persist = () => { current!.state = store.read('synthetic'); save(); };
    // One uncommitted scene per trap: the real narrator request, as the bot builds it for a player's message.
    // One report per variant and sample, holding only what the judge reads.
    const labScenes: Record<string, NonNullable<ModeReport['traps']>> = {};
    const saveLab = (name: string) => {
      mkdirSync(join(directory, 'lab', name), { recursive: true });
      writeFileSync(join(directory, 'lab', name, 'report.json'), JSON.stringify({ scenario, model: config.model, modes: { [memoryMode]: { traps: labScenes[name] } } }, null, 2));
    };
    // `then`: the trap's scene is committed in a copy of the story, as the bot commits a scene, and the next one is written
    // over it; the replayed story keeps neither. The trap's scene is saved before this request, and a failure of it is
    // recorded on `then` alone, so that the other traps do not depend on it; the judge fails its questions.
    const writeThen = async (trap: typeof fixture.traps[number], saved: TrapScene) => {
      const copy = structuredClone(store.read('synthetic'));
      let event;
      try {
        const turn = beginJob(copy, trap.input ?? fixture.turns[trap.afterTurn!], 0);
        const story = copy.stories[turn.storyId];
        commitTurn(copy, turn.id, normalizeScene(saved.text, story.nodes[turn.head as string]?.time ?? copy.seeds[story.seedId].startTime));
        const written = await provider.generate(makeRequest(copy, beginJob(copy, trap.then!.input, 0), config.maxOutputTokens));
        saved.then = { text: written.text, truncated: written.finishReason !== 'stop' };
        event = { characters: written.text.length, truncated: saved.then.truncated };
      } catch (error) {
        if (deadline.aborted) throw error;
        const code = (error as Failure).code;
        saved.then = { error: /^[a-z_]{1,40}$/.test(code ?? '') ? code! : 'probe_failed' };
        event = { code: saved.then.error, ...safeErrorDetails(error) };
      }
      persist(); progress({ event: 'trap_scene', mode: memoryMode, then: true, ...event });
    };
    const writeTraps = async (after: number | undefined) => {
      for (const trap of values.traps ? fixture.traps : []) {
        if (trap.afterTurn !== after || (lab?.only && !lab.only.includes(trap.key))) continue;
        // A resumed run writes the `then` scene an earlier run left missing over the scene that run saved.
        const done = current!.traps?.find(written => written.key === trap.key);
        if (done) { if (trap.then && !lab && !done.truncated && !done.then) await writeThen(trap, done); continue; }
        const turn = store.mutate('synthetic', state => beginJob(state, trap.input ?? fixture.turns[trap.afterTurn!], 0));
        let scene;
        try {
          // On an own server one request returns all samples of a variant: the prompt is read once and the samples
          // share its cache cells.
          const state = store.read('synthetic');
          const variants = [...(lab?.variants ?? [])];
          let first: { text: string; finishReason: 'stop' | 'length' } | undefined;
          const writeNext = async (): Promise<void> => {
            const variant = variants.shift();
            if (!variant) return;
            const request = makeRequest(state, turn, config.maxOutputTokens);
            const last = request.messages.at(-1)!;
            if (variant.tail) last.content = `${last.content}\n\n${variant.tail}`;
            const written = labClient ? await labClient.generateMany(request, lab!.samples, { signal: deadline })
              : await Promise.all(Array.from({ length: lab!.samples }, () => provider.generate({ ...request })));
            written.forEach((result, index) => {
              const name = `${variant.key}-${index + 1}`;
              (labScenes[name] ??= []).push({ key: trap.key, text: result.text, truncated: result.finishReason !== 'stop' });
              saveLab(name); progress({ event: 'lab_scene', variant: variant.key, sample: index + 1, characters: result.text.length, truncated: result.finishReason !== 'stop' });
            });
            if (!variant.tail) first ??= written[0];
            return writeNext();
          };
          // One several-samples request at a time: two of them at once fail on the pinned llama-server with a
          // context error, although each fits alone.
          await Promise.all(Array.from({ length: !lab ? 0 : labClient ? 1 : Math.max(1, Math.floor((lab.parallel ?? 1) / lab.samples)) }, writeNext));
          // A variant with an empty tail is the ordinary request, so its first sample is the trap scene of the report.
          scene = first ?? await provider.generate(makeRequest(store.read('synthetic'), turn, config.maxOutputTokens));
        }
        finally { store.mutate('synthetic', state => { state.job = null; }); }
        const saved: TrapScene = { key: trap.key, text: scene.text, truncated: scene.finishReason !== 'stop' };
        (current!.traps ??= []).push(saved);
        persist(); progress({ event: 'trap_scene', mode: memoryMode, characters: scene.text.length, truncated: saved.truncated });
        if (trap.then && !lab && !saved.truncated) await writeThen(trap, saved);
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
    // The answer is a short JSON, but a model that reasons in text before its structured answer needs the room for
    // that text: through the Claude CLI the cap is the run's whole output, and a run that exceeds it ends as an error
    // rather than a truncation. At 1024 that was every Haiku recall and every CLI reader of `hospital` (log, 09-22).
    const request = makeRequest(store.read('synthetic'), job, RECALL_OUTPUT_TOKENS + (recallThinking || recallRoom ? RECALL_THINKING_TOKENS : 0));
    request.system = 'Ответь на проверочные вопросы только по переданной истории и её памяти. Соблюдай заданный формат, не достраивай неизвестное.';
    request.purpose = 'memory';
    if (recallThinking) request.thinking = true;
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
    // No model reads this: the number is looked up in the text the recall request carried, digit groups joined.
    const parts = contextParts(store.read('synthetic'), job);
    const digits = (messages: { content: string }[]) => messages.map(message => message.content).join('\n').replace(/(?<=\d)[\s\u00a0\u202f](?=\d{3}\b)/g, '');
    const [inMemory, inScenes] = [digits(parts.memory), digits(parts.tail)];
    const stands = (text: string, value: string) => new RegExp(`(?<![\\d.,:-])${value}(?![\\d:-])`).test(text);
    current.answers = questions.map(([key, , expected]) => {
      const actual = (parsed.answers as Answer[]).find(a => a.key === key)?.value;
      const stated = /^\d{2,}$/.test(expected) ? { stated: stands(inMemory, expected) ? 'memory' as const : stands(inScenes, expected) ? 'scenes' as const : 'none' as const } : {};
      return { key, expected, actual, pass: typeof actual === 'string' && actual.trim() === expected, ...stated };
    });
    current.recallUsage = result.usage;
    if (recallThinking) current.recallThinking = true;
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
