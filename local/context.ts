import { UserError } from '../lib/library.ts';
import type { Branch, Library, RequestStamp } from '../lib/library.ts';
import { contextParts, makeRequest, storyNarration } from './prompt.ts';
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

// The message the bot sends for "continue on your own", in the language of the story (story-text.ts).
export const continueInput = (state: Library, storyId: string) => storyNarration(state, storyId).continueStory;
const CLI_RESERVE = 4096;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Missing keys, including null and undefined, are simply not found.
const own = <T>(object: Record<string, T> | undefined, key: string | null | undefined) =>
  object && Object.hasOwn(object, key as string) ? object[key as string] : undefined;
// UTF-8 bytes over four is the ratio the bot was tuned on, and it stays that for Latin, Cyrillic and Hangul text. A Han
// or kana character takes three bytes but about one token, so it counts as four. Measured on 19 September 2026 against
// provider-reported input tokens, bytes per token: en 4.9, ru 5.7, ko 4.3, ja 3.9, zh 3.6 on Gemma 4 31B and
// 5.0 / 5.8 / 4.0 / 3.3 / 3.3 on gpt-5.4-mini. Without the correction a Japanese or Chinese story reaches the
// compaction threshold about a fifth of a window late, that is, after the context is already full.
const CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{3ffff}]/gu;
export const estimateTokens = (text: string) =>
  Math.ceil((Buffer.byteLength(text, 'utf8') + (text.match(CJK) ?? []).length) / 4);
const requestText = (request: ModelRequest) => request.system + JSON.stringify({ messages: request.messages });
const measure = (messages: ChatMessage[]): Measure => {
  const text = messages.length ? JSON.stringify(messages) : '';
  // Component sizes are approximate; live input usage is checked separately.
  return { bytes: Buffer.byteLength(text, 'utf8'), estimatedTokens: estimateTokens(text) };
};
const sum = (a: Measure, b: Measure): Measure => ({ bytes: a.bytes + b.bytes, estimatedTokens: a.estimatedTokens + b.estimatedTokens });

export function requestBudget(request: ModelRequest, contextTokens: number) {
  const input = JSON.stringify({ messages: request.messages });
  const inputBytes = Buffer.byteLength(request.system + input, 'utf8');
  const inputTokens = count(request.estimatedInputTokens) ?? estimateTokens(requestText(request)) + CLI_RESERVE;
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
    // The delta is a scene or two, so the plain byte ratio is close enough even where the script is denser.
    return { tokens: Math.max(0, Math.ceil(measured + (stamp.inputBytes - previous.inputBytes) / 4)), source: 'usage' };
  }
  return { tokens: estimateTokens(requestText(request)) + CLI_RESERVE, source: 'bytes' };
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
  const request = makeRequest(state, { ...ref, input: continueInput(state, storyId) }, config.maxOutputTokens);
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
