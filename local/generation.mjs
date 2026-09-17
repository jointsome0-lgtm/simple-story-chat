import { context, jobTarget, commitMemory, saveCheckpoint } from '../lib/library.js';
import { makeRequest } from './prompt.mjs';
import { estimateRequest, requestBudget } from './context.mjs';
import { ModelError } from './model-error.mjs';
import { summaryRequest, supplementRequest, parseMemory, inspectMemory } from './memory.mjs';

// Both automatic and explicit compaction use the same persisted job lock.
function loadTarget(store, userId, jobId, signal) {
  if (signal?.aborted) throw new ModelError('cancelled');
  const state = store.read(userId);
  const target = jobTarget(state, jobId);
  if (!target) throw new ModelError('cancelled');
  return { state, ...target };
}

export async function compactBranch(options) {
  const { signal, onProgress = () => {} } = options;
  const report = progress => {
    if (!signal?.aborted) { try { onProgress(progress); } catch {} }
  };
  try { return await extractAndSave({ ...options, report }); }
  catch (error) {
    // No response bodies, source identifiers or story text enter diagnostics.
    error.operation = 'compact';
    report({ stage: error.code === 'cancelled' ? 'cancelled' : 'failed', reason: error.memoryReason ?? error.code });
    throw error;
  }
}

async function extractAndSave({ store, userId, jobId, provider, config, signal, report }) {
  const load = () => loadTarget(store, userId, jobId, signal);
  const target = load();
  let nodes = context(target.story, target.branch).recent.slice(0, -(config.keepScenes ?? 4));
  if (!nodes.length) throw new ModelError('nothing_to_compact');
  for (let attempt = 0; attempt < 8; attempt++) {
    load();
    let outputCharacters = 0;
    let repairScenes = 0;
    const progress = stage => report({ stage, scenes: nodes.length, keptScenes: config.keepScenes ?? 4, outputCharacters, repairScenes });
    const extract = (subset, request = summaryRequest(target, subset, config.memoryMode)) => {
      outputCharacters = 0;
      progress('extracting');
      return provider.generate(request, { signal,
        onQueued: () => progress('queued'), onStart: () => progress('extracting'),
        onText: delta => { outputCharacters += delta.length; progress('extracting'); },
      });
    };
    let result;
    try {
      result = await extract(nodes);
    } catch (error) {
      if (error.code !== 'context_limit' || nodes.length === 1) throw error;
      nodes = nodes.slice(0, Math.ceil(nodes.length / 2));
      continue;
    }
    load();
    progress('validating');
    if (config.repairCoverage && (config.memoryMode ?? 'plain') === 'plain') {
      const draft = inspectMemory(result, nodes);
      if (draft.missingSceneIds.length) {
        const missing = new Set(draft.missingSceneIds);
        const subset = nodes.filter(node => missing.has(node.id));
        repairScenes = subset.length;
        // One supplement, solely for omitted scenes. Never invent coverage or
        // save partial memory; validate the supplement and combined result.
        const repair = await extract(subset, supplementRequest(target, nodes, draft));
        load();
        progress('validating');
        const extra = parseMemory(repair, subset);
        const positions = new Map(nodes.map((node, index) => [node.id, index]));
        // A fact covering an entire transition belongs after its latest source;
        // putting it at the first source can precede an intermediate correction.
        const order = fact => Math.max(...fact.source.map(id => positions.get(id)));
        const facts = [...draft.delta.facts, ...extra.facts].sort((a, b) => order(a) - order(b));
        result = { text: JSON.stringify({ facts }), finishReason: 'stop',
          usage: combinedUsage(result.usage, repair.usage) };
      }
    }
    const delta = parseMemory(result, nodes, config.memoryMode);
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
      const after = requestBudget(makeRequest(trial, trial.job, config.maxOutputTokens), config.contextTokens).inputBytes;
      if (after >= before) throw new ModelError('memory_not_smaller');
      saveCheckpoint(state, current.story, current.branch, 'До сжатия', 'pre-compaction');
      commitMemory(state, jobId, covered, delta);
      const memory = current.story.memories[current.branch.memory];
      memory.method = config.memoryMode ?? 'plain';
      if (repairScenes) memory.repairScenes = repairScenes;
      if (result.usage) memory.usage = result.usage;
      return memory;
    });
    if (!saved) throw new ModelError('cancelled');
    report({ stage: 'done', scenes: nodes.length, keptScenes: config.keepScenes ?? 4, facts: delta.facts.length, repairScenes });
    return { scenes: nodes.length, facts: delta.facts.length, ...(result.usage ? { usage: result.usage } : {}) };
  }
  throw new ModelError('context_limit');
}

function combinedUsage(first, second) {
  if (!first || !second) return undefined;
  return Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningCharacters'].map(key =>
    [key, Number.isSafeInteger(first[key]) && Number.isSafeInteger(second[key]) ? first[key] + second[key] : null]));
}

// A cancelled or replaced job cannot commit a late scene or memory increment.
export async function generateScene({ store, userId, jobId, provider, config, signal, preview = () => async () => {}, onProgress }) {
  const load = () => loadTarget(store, userId, jobId, signal);
  const storyRequest = target => {
    const request = makeRequest(target.state, target.job, config.maxOutputTokens);
    request.estimatedInputTokens = estimateRequest(target.state, target.job, request, config).tokens;
    return request;
  };
  for (let pass = 0; pass <= 4; pass++) {
    const target = load();
    const request = storyRequest(target);
    if (provider.countInput) request.estimatedInputTokens = await provider.countInput(request, { signal });
    const threshold = Math.min(config.compactAtTokens ?? 54000, config.contextTokens - config.maxOutputTokens);
    if (request.estimatedInputTokens < threshold) {
      try {
        const result = await provider.generate(request, {
          signal, inputLimitTokens: threshold - 1, onText: preview(target.state, target.job, request),
        });
        load();
        if (result.usage?.inputTokens >= threshold) throw new ModelError('context_limit');
        return { result, request };
      } catch (error) {
        // A live input count can correct the estimate before any text is shown.
        if (error.code !== 'context_limit') throw error;
      }
    }
    if (pass === 4) throw new ModelError('context_limit');
    try { await compactBranch({ store, userId, jobId, provider, config, signal, onProgress }); }
    catch (error) {
      if (error.code === 'nothing_to_compact') throw new ModelError('context_limit');
      throw error;
    }
  }
}
