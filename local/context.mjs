import { UserError } from '../lib/library.js';
import { contextParts, makeRequest } from './prompt.mjs';
import { createHash } from 'node:crypto';

export const CONTINUE = 'Продолжай историю самостоятельно с текущего места.';
const CLI_RESERVE = 4096;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const own = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined;
const measure = messages => {
  const bytes = messages.length ? Buffer.byteLength(JSON.stringify(messages), 'utf8') : 0;
  // Component sizes are approximate; live input usage is checked separately.
  return { bytes, estimatedTokens: Math.ceil(bytes / 4) };
};
const sum = (a, b) => ({ bytes: a.bytes + b.bytes, estimatedTokens: a.estimatedTokens + b.estimatedTokens });

export function requestBudget(request, contextTokens) {
  const input = JSON.stringify({ messages: request.messages });
  const inputBytes = Buffer.byteLength(request.system + input, 'utf8');
  const inputTokens = count(request.estimatedInputTokens) ?? Math.ceil(inputBytes / 4) + CLI_RESERVE;
  const limitTokens = Math.max(0, contextTokens - request.maxOutputTokens);
  return { input, inputBytes, inputTokens, limitTokens, remainingTokens: Math.max(0, limitTokens - inputTokens) };
}

export function requestStamp(request, model, memory, provider = 'claude-code') {
  return { model, memory, provider, inputBytes: requestBudget(request, 0).inputBytes,
    systemHash: createHash('sha256').update(request.system).digest('hex') };
}

export function estimateRequest(state, point, request, config) {
  const stamp = requestStamp(request, config.model, point.memory, config.provider);
  const node = own(state.stories[point.storyId]?.nodes, point.head);
  const previous = node?.requestContext;
  const measured = count(node?.usage?.inputTokens);
  if (measured !== null && count(previous?.inputBytes) !== null && previous.model === stamp.model
      && (previous.provider ?? 'claude-code') === stamp.provider
      && previous.memory === stamp.memory && previous.systemHash === stamp.systemHash) {
    // The previous measured input includes CLI overhead. Only the changed text
    // needs estimating; never carry this anchor across a compaction or model.
    return { tokens: Math.max(0, Math.ceil(measured + (stamp.inputBytes - previous.inputBytes) / 4)), source: 'usage' };
  }
  return { tokens: Math.ceil(stamp.inputBytes / 4) + CLI_RESERVE, source: 'bytes' };
}

export function contextStats(state, config, selection = {}) {
  const storyId = selection.storyId ?? state.active?.storyId;
  const story = own(state.stories, storyId);
  const checkpointId = selection.checkpointId ?? null;
  const checkpoint = checkpointId ? own(story?.checkpoints, checkpointId) : null;
  const branchId = checkpoint ? checkpoint.branchId : selection.branchId ?? state.active?.branchId;
  const point = checkpoint || own(story?.branches, branchId);
  if (!story || !point || (checkpointId && !checkpoint)) throw new UserError('Выбери историю или чекпоинт через /seeds.');
  const ref = { storyId, head: point.head, memory: point.memory };
  const parts = contextParts(state, ref);
  const seed = measure(parts.seed);
  const memory = { ...measure(parts.memory), count: parts.memoryCount };
  const tail = { ...measure(parts.tail), count: parts.sceneCount };
  const prefix = sum(seed, memory);
  const request = makeRequest(state, { ...ref, input: CONTINUE }, config.maxOutputTokens);
  const estimate = estimateRequest(state, ref, request, config);
  request.estimatedInputTokens = estimate.tokens;
  const budget = requestBudget(request, config.contextTokens);
  const node = own(story.nodes, point.head);
  const inputTokens = count(node?.usage?.inputTokens);
  const outputTokens = count(node?.usage?.outputTokens);
  const lastRequest = inputTokens === null && outputTokens === null ? null : {
    inputTokens, outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
  };
  return {
    scope: checkpointId ? 'checkpoint' : 'current',
    label: checkpoint ? checkpoint.label : point.name,
    storyId, branchId, checkpointId, model: config.model,
    limitTokens: config.contextTokens, reserveTokens: config.maxOutputTokens,
    seed, memory, prefix, tail, snapshot: sum(prefix, tail),
    request: { bytes: budget.inputBytes, estimatedTokens: estimate.tokens, estimateSource: estimate.source },
    budget: { inputTokens: budget.inputTokens, limitTokens: budget.limitTokens, remainingTokens: budget.remainingTokens },
    compaction: { thresholdTokens: config.compactAtTokens ?? 54000, keepScenes: config.keepScenes ?? 4 },
    lastRequest,
  };
}
