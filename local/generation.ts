import type { Fact, Job, Library, SceneNode, Usage } from '../lib/library.ts';
import { context, jobTarget, commitMemory, saveCheckpoint } from '../lib/library.ts';
import type { CompactionStatus } from './compact-view.ts';
import { makeRequest } from './prompt.ts';
import type { ContextConfig } from './context.ts';
import { estimateRequest, requestBudget } from './context.ts';
import type { ErrorDetails, Log } from './model-error.ts';
import { ModelError, errorCode, safeErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { summaryRequest, supplementRequest, parseMemory, inspectMemory } from './memory.ts';
import { seedLanguage } from './story-text.ts';
import type { Store } from './store.ts';
import type { Prepared } from './prepare.ts';

// Only the configuration fields generation reads; the bot and probes pass their full configuration.
export type GenerationConfig = ContextConfig & { memoryMode?: 'plain' | 'sgr'; repairCoverage?: boolean };
// Compaction does not read the model or provider name.
type CompactionConfig = Omit<GenerationConfig, 'model' | 'provider'>;
// `prepared`: extraction results computed ahead (local/prepare.ts), taken for an identical request.
type Operation<Config = GenerationConfig> = {
  store: Store; userId: string; jobId: string; provider: Provider; config: Config; signal?: AbortSignal; prepared?: Prepared;
};
type Report = (status: CompactionStatus) => void;
// Checkpoint labels a compaction writes into the library. The bot passes them in the user's interface language;
// probes and the eval keep the Russian defaults.
export type CompactionLabels = { beforeCompaction: string; afterCompaction: string };
const LABELS: CompactionLabels = { beforeCompaction: 'До сжатия', afterCompaction: 'После сжатия' };
// Sizes and counts of a compaction and of its current model request. They go to the technical log; none is text.
type Numbers = Required<Pick<ErrorDetails, 'sceneCount' | 'repairSceneCount' | 'requestBytes' | 'outputCharacters'>>
  & Pick<ErrorDetails, 'inputBytesBefore' | 'inputBytesAfter'>;
type RecordEvent = (event: string, details?: ErrorDetails) => void;
// Thrown values are not checked: ModelError carries these fields, other errors lack them.
type Failure = { operation?: string; code?: string | number; memoryReason?: string };

// The input size from which a scene request compacts the branch first.
export const compactionThreshold = (config: ContextConfig) => Math.min(config.compactAtTokens ?? 54000, config.contextTokens - config.maxOutputTokens);

// A promise that rejects with `cancelled` as soon as the signal aborts, whether or not the promise settles.
function until<T>(promise: Promise<T>, signal: AbortSignal | undefined) {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ModelError('cancelled'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); resolve(value); }, reject);
  });
}

// Both automatic and explicit compaction use the same persisted job lock.
function loadTarget(store: Store, userId: string, jobId: string, signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new ModelError('cancelled');
  const state = store.read(userId);
  const target = jobTarget(state, jobId);
  if (!target) throw new ModelError('cancelled');
  return { state, ...target };
}

export async function compactBranch(options: Operation<CompactionConfig> & { onProgress?: Report; log?: Log; automatic?: boolean; labels?: CompactionLabels }) {
  const { signal, onProgress = () => {}, log = () => {}, automatic = false } = options;
  const report = (progress: CompactionStatus) => {
    if (!signal?.aborted) { try { onProgress(progress); } catch {} }
  };
  const started = Date.now();
  const numbers: Numbers = { sceneCount: 0, repairSceneCount: 0, requestBytes: 0, outputCharacters: 0 };
  const details = () => ({ automatic, ...numbers, elapsedMs: Date.now() - started });
  // An automatic compaction that succeeds has no other row in the log; a manual one is logged here the same way.
  const record: RecordEvent = (event, extra) => log(event, undefined, { ...details(), ...extra });
  try { return await extractAndSave({ ...options, report, numbers, record }); }
  catch (error) {
    const failure = error as Failure;
    // No response bodies, source identifiers or story text enter diagnostics. The caller logs the failure once, so
    // the numbers travel on the error. Its own details win: a supplement that fails coverage counts its own scenes.
    Object.assign(failure, details(), safeErrorDetails(failure));
    failure.operation = 'compact';
    report({ stage: failure.code === 'cancelled' ? 'cancelled' : 'failed', reason: failure.memoryReason ?? failure.code });
    throw error;
  }
}

async function extractAndSave({ store, userId, jobId, provider, config, signal, prepared, report, numbers, record, labels = LABELS }: Operation<CompactionConfig> & {
  report: Report; numbers: Numbers; record: RecordEvent; labels?: CompactionLabels;
}) {
  const load = () => loadTarget(store, userId, jobId, signal);
  const target = load();
  // The story's own language, from its seed: a memory increment is written for the narrator to read.
  const lang = seedLanguage(target.seed);
  let nodes = context(target.story, target.branch).recent.slice(0, -(config.keepScenes ?? 4));
  if (!nodes.length) throw new ModelError('nothing_to_compact');
  for (let attempt = 0; attempt < 8; attempt++) {
    load();
    Object.assign(numbers, { sceneCount: nodes.length, repairSceneCount: 0 });
    const progress = (stage: CompactionStatus['stage']) => report({ stage, scenes: nodes.length, keptScenes: config.keepScenes ?? 4,
      outputCharacters: numbers.outputCharacters, repairScenes: numbers.repairSceneCount });
    const extract = async (subset: SceneNode[], request = summaryRequest(target, subset, config.memoryMode)) => {
      Object.assign(numbers, { requestBytes: requestBudget(request, config.contextTokens).inputBytes, outputCharacters: 0 });
      // One row before each model request and one after it. A request that fails has its row written by the caller.
      record('compaction_request_started');
      progress('extracting');
      // A result prepared while the person read; if its run failed, the model is asked now.
      const ahead = prepared?.take(request);
      const early = ahead && await until(ahead.catch(() => null), signal);
      if (early) {
        numbers.outputCharacters = early.text.length;
        record('compaction_request_prepared', { inputTokens: early.usage?.inputTokens ?? undefined, outputTokens: early.usage?.outputTokens ?? undefined });
        return early;
      }
      const asked = Date.now();
      let waitMs: number | undefined;
      const result = await provider.generate(request, { signal,
        onQueued: () => progress('queued'), onStart: () => { waitMs = Date.now() - asked; progress('extracting'); },
        onText: delta => { numbers.outputCharacters += delta.length; progress('extracting'); },
      });
      record('compaction_request_completed', { ...result.timings, waitMs,
        inputTokens: result.usage?.inputTokens ?? undefined, outputTokens: result.usage?.outputTokens ?? undefined });
      return result;
    };
    let result: GenerationResult;
    try {
      result = await extract(nodes);
    } catch (error) {
      if (errorCode(error) !== 'context_limit' || nodes.length === 1) throw error;
      nodes = nodes.slice(0, Math.ceil(nodes.length / 2));
      continue;
    }
    load();
    progress('validating');
    if (config.repairCoverage && (config.memoryMode ?? 'plain') === 'plain') {
      const draft = inspectMemory(result, nodes, 'plain', lang);
      if (draft.missingSceneIds.length) {
        const missing = new Set(draft.missingSceneIds);
        const subset = nodes.filter(node => missing.has(node.id));
        numbers.repairSceneCount = subset.length;
        // One supplement, solely for omitted scenes. Never invent coverage or
        // save partial memory; validate the supplement and combined result.
        const repair = await extract(subset, supplementRequest(target, nodes, draft));
        load();
        progress('validating');
        const extra = parseMemory(repair, subset, 'plain', lang);
        const positions = new Map(nodes.map((node, index) => [node.id, index]));
        // A fact covering an entire transition belongs after its latest source;
        // putting it at the first source can precede an intermediate correction.
        // Every source has been checked to be one of these scenes.
        const order = (fact: Fact) => Math.max(...fact.source.map(id => positions.get(id)!));
        const facts = [...draft.delta.facts, ...extra.facts].sort((a, b) => order(a) - order(b));
        result = { text: JSON.stringify({ facts }), finishReason: 'stop',
          usage: combinedUsage(result.usage, repair.usage) };
      }
    }
    const delta = parseMemory(result, nodes, config.memoryMode ?? 'plain', lang);
    const covered = nodes.map(node => node.id);
    progress('saving');
    const saved = store.mutate(userId, state => {
      if (signal?.aborted) return false;
      const current = jobTarget(state, jobId);
      if (!current) return false;
      // Reject a summary that increases prompt size. The trial is private and
      // leaves both the real memory and the original archived scenes intact.
      const trial = structuredClone(state);
      const before = requestBudget(makeRequest(state, current.job, config.maxOutputTokens), config.contextTokens).inputBytes;
      commitMemory(trial, jobId, covered, delta);
      // The trial keeps the job: commitMemory has just found it there.
      const after = requestBudget(makeRequest(trial, trial.job!, config.maxOutputTokens), config.contextTokens).inputBytes;
      Object.assign(numbers, { inputBytesBefore: before, inputBytesAfter: after });
      if (after >= before) throw new ModelError('memory_not_smaller');
      saveCheckpoint(state, current.story, current.branch, labels.beforeCompaction, 'pre-compaction');
      commitMemory(state, jobId, covered, delta, labels.afterCompaction);
      // commitMemory has just set the branch memory.
      const memory = current.story.memories[current.branch.memory!];
      memory.method = config.memoryMode ?? 'plain';
      if (numbers.repairSceneCount) memory.repairScenes = numbers.repairSceneCount;
      if (result.usage) memory.usage = result.usage;
      return memory;
    });
    if (!saved) throw new ModelError('cancelled');
    record('memory_compacted', { factCount: delta.facts.length });
    report({ stage: 'done', scenes: nodes.length, keptScenes: config.keepScenes ?? 4, facts: delta.facts.length, repairScenes: numbers.repairSceneCount });
    return { scenes: nodes.length, facts: delta.facts.length, ...(result.usage ? { usage: result.usage } : {}) };
  }
  throw new ModelError('context_limit');
}

// Every usage field gets a value: a sum where both counts are safe integers, otherwise null.
function combinedUsage(first: Usage | null | undefined, second: Usage | null | undefined) {
  if (!first || !second) return undefined;
  return Object.fromEntries((['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningCharacters'] as const).map(key =>
    [key, Number.isSafeInteger(first[key]) && Number.isSafeInteger(second[key]) ? first[key]! + second[key]! : null])) as Usage;
}

// A cancelled or replaced job cannot commit a late scene or memory increment.
export async function generateScene({ store, userId, jobId, provider, config, signal, prepared, preview = () => async () => {}, onProgress, log, labels }: Operation & {
  preview?: (state: Library, job: Job, request: ModelRequest) => GenerateControls['onText']; onProgress?: Report; log?: Log; labels?: CompactionLabels;
}) {
  const load = () => loadTarget(store, userId, jobId, signal);
  const storyRequest = (target: ReturnType<typeof load>) => {
    const request = makeRequest(target.state, target.job, config.maxOutputTokens);
    request.estimatedInputTokens = estimateRequest(target.state, target.job, request, config).tokens;
    return request;
  };
  prepared?.keep(load().job);
  for (let pass = 0; pass <= 4; pass++) {
    const target = load();
    const request = storyRequest(target);
    const counting = Date.now();
    if (provider.countInput) request.estimatedInputTokens = await provider.countInput(request, { signal });
    const countMs = provider.countInput ? Date.now() - counting : undefined;
    const threshold = compactionThreshold(config);
    // storyRequest has set the estimate.
    if (request.estimatedInputTokens! < threshold) {
      try {
        const asked = Date.now();
        let waitMs: number | undefined;
        const result = await provider.generate(request, {
          signal, inputLimitTokens: threshold - 1, onText: preview(target.state, target.job, request),
          onStart: () => { waitMs = Date.now() - asked; },
        });
        // Counts and durations only: where the time of a scene went (queue, token count, prefill, decoding).
        log?.('scene_request_completed', undefined, { ...result.timings, waitMs, countMs, elapsedMs: Date.now() - asked,
          inputTokens: result.usage?.inputTokens ?? undefined, outputTokens: result.usage?.outputTokens ?? undefined });
        load();
        // The threshold is above a non-negative estimate here, so a missing count never reaches it.
        if ((result.usage?.inputTokens ?? 0) >= threshold) throw new ModelError('context_limit');
        return { result, request };
      } catch (error) {
        // A live input count can correct the estimate before any text is shown.
        if (errorCode(error) !== 'context_limit') throw error;
      }
    }
    if (pass === 4) throw new ModelError('context_limit');
    try { await compactBranch({ store, userId, jobId, provider, config, signal, prepared, onProgress, log, labels, automatic: true }); }
    catch (error) {
      if (errorCode(error) === 'nothing_to_compact') throw new ModelError('context_limit');
      throw error;
    }
  }
  // Not reached: the last pass returns or throws.
  throw new ModelError('context_limit');
}
