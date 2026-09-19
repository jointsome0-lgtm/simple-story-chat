import type { Usage } from '../lib/library.ts';
import type { ModelConfig } from './config.ts';
import { createClaude } from './claude.ts';
import { createCodex } from './codex.ts';
import { createLlama, createOpenAI } from './llama.ts';
import { createBudget, channelFor, capsFor } from './budget.ts';
import { resolve } from 'node:path';

// One ledger for every probe on this computer; *.sqlite is ignored by Git.
export const BUDGET_PATH = resolve(import.meta.dirname, '..', 'eval-usage.sqlite');

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type ModelRequest = {
  system: string; messages: ChatMessage[]; maxOutputTokens: number;
  purpose?: 'memory'; outputSchema?: object; estimatedInputTokens?: number;
};
export type Controls = { signal?: AbortSignal };
export type GenerateControls = Controls & {
  onText?: (delta: string) => unknown; inputLimitTokens?: number; onQueued?: () => void; onStart?: () => void;
};
// Server-side counts and durations of one request, as llama-server reports them. For logs only; never stored.
export type Timings = Partial<Record<'cacheTokens' | 'promptTokens' | 'promptMs' | 'predictedTokens' | 'predictedMs'
  | 'draftTokens' | 'draftAcceptedTokens', number>>;
export type GenerationResult = {
  text: string; finishReason: 'stop' | 'length'; usage?: Usage | null; timings?: Timings; streamResultMismatch?: boolean;
};
export type Provider = {
  generate(request: ModelRequest, controls?: GenerateControls): Promise<GenerationResult>;
  countInput?(request: ModelRequest, controls?: Controls): Promise<number>;
  // Only a provider that can verify its server has `check`; the CLI providers have none.
  check?(controls?: Controls): Promise<unknown>;
  // A shared model (local/scheduler.ts) keeps its slot for one operation's calls until `end`.
  openTurn?(): Provider & { end(): void };
};

export function createModel(config: ModelConfig & { dbPath: string }): Provider {
  if (config.provider === 'claude-code') return createClaude(config);
  if (config.provider === 'codex-cli') return createCodex(config);
  if (config.provider === 'llama-cpp') return createLlama(config);
  if (config.provider === 'openai-compatible') {
    const channel = channelFor(config.baseUrl!, config.model);
    return createOpenAI(config, { budget: createBudget(BUDGET_PATH, channel, capsFor(channel, config.budget)) });
  }
  throw new Error('Unsupported model provider');
}
