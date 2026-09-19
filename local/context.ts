import { UserError } from '../lib/library.ts';
import type { Branch, Library, RequestStamp } from '../lib/library.ts';
import { contextParts, makeRequest } from './prompt.ts';
import type { StoryPoint } from './prompt.ts';
import type { ChatMessage, ModelRequest } from './model.ts';
import { createHash } from 'node:crypto';

// Only the fields these helpers read; bot and probes pass their full model configuration.
export type ContextConfig = {
  model: string; provider?: string; maxOutputTokens: number; contextTokens: number; compactAtTokens?: number; keepScenes?: number;
};
export type ContextSelection = { storyId?: string; branchId?: string; checkpointId?: string };
export type ContextStats = ReturnType<typeof contextStats>;
type Measure = { bytes: number; estimatedTokens: number };

export const CONTINUE = 'Продолжай историю самостоятельно с текущего места.';
const CLI_RESERVE = 4096;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Missing keys, including null and undefined, are simply not found.
const own = <T>(object: Record<string, T> | undefined, key: string | null | undefined) =>
  object && Object.hasOwn(object, key as string) ? object[key as string] : undefined;
const measure = (messages: ChatMessage[]): Measure => {
  const bytes = messages.length ? Buffer.byteLength(JSON.stringify(messages), 'utf8') : 0;
  // Component sizes are approximate; live input usage is checked separately.
  return { bytes, estimatedTokens: Math.ceil(bytes / 4) };
};
const sum = (a: Measure, b: Measure): Measure => ({ bytes: a.bytes + b.bytes, estimatedTokens: a.estimatedTokens + b.estimatedTokens });

export function requestBudget(request: ModelRequest, contextTokens: number) {
  const input = JSON.stringify({ messages: request.messages });
  const inputBytes = Buffer.byteLength(request.system + input, 'utf8');
  const inputTokens = count(request.estimatedInputTokens) ?? Math.ceil(inputBytes / 4) + CLI_RESERVE;
  const limitTokens = Math.max(0, contextTokens - request.maxOutputTokens);
  return { input, inputBytes, inputTokens, limitTokens, remainingTokens: Math.max(0, limitTokens - inputTokens) };
}

export function requestStamp(request: ModelRequest, model: string, memory: string | null, provider = 'claude-code'): RequestStamp {
  return { model, memory, provider, inputBytes: requestBudget(request, 0).inputBytes,
    systemHash: createHash('sha256').update(request.system).digest('hex') };
}

export function estimateRequest(state: Library, point: StoryPoint, request: ModelRequest, config: Pick<ContextConfig, 'model' | 'provider'>) {
  const stamp = requestStamp(request, config.model, point.memory, config.provider);
  const node = own(state.stories[point.storyId]?.nodes, point.head);
  const previous = node?.requestContext;
  const measured = count(node?.usage?.inputTokens);
  if (measured !== null && previous && count(previous.inputBytes) !== null && previous.model === stamp.model
      && (previous.provider ?? 'claude-code') === stamp.provider
      && previous.memory === stamp.memory && previous.systemHash === stamp.systemHash) {
    // The previous measured input includes CLI overhead. Only the changed text
    // needs estimating; never carry this anchor across a compaction or model.
    return { tokens: Math.max(0, Math.ceil(measured + (stamp.inputBytes - previous.inputBytes) / 4)), source: 'usage' };
  }
  return { tokens: Math.ceil(stamp.inputBytes / 4) + CLI_RESERVE, source: 'bytes' };
}

export function contextStats(state: Library, config: ContextConfig, selection: ContextSelection = {}) {
  const storyId = selection.storyId ?? state.active?.storyId;
  const story = own(state.stories, storyId);
  const checkpointId = selection.checkpointId ?? null;
  const checkpoint = checkpointId ? own(story?.checkpoints, checkpointId) : null;
  const branchId = checkpoint ? checkpoint.branchId : selection.branchId ?? state.active?.branchId;
  const point = checkpoint || own(story?.branches, branchId);
  if (storyId === undefined || !story || !point || (checkpointId && !checkpoint)) throw new UserError('Выбери историю или чекпоинт через /seeds.', 'pickStory');
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
    // Without a checkpoint the point is the selected branch.
    label: checkpoint ? checkpoint.label : (point as Branch).name,
    storyId, branchId, checkpointId, model: config.model,
    limitTokens: config.contextTokens, reserveTokens: config.maxOutputTokens,
    seed, memory, prefix, tail, snapshot: sum(prefix, tail),
    request: { bytes: budget.inputBytes, estimatedTokens: estimate.tokens, estimateSource: estimate.source },
    budget: { inputTokens: budget.inputTokens, limitTokens: budget.limitTokens, remainingTokens: budget.remainingTokens },
    compaction: { thresholdTokens: config.compactAtTokens ?? 54000, keepScenes: config.keepScenes ?? 4 },
    lastRequest,
  };
}
