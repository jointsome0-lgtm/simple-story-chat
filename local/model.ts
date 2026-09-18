import type { Usage } from '../lib/library.ts';
import type { ModelConfig } from './config.ts';
import { createClaude } from './claude.ts';
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
export type GenerationResult = { text: string; finishReason: 'stop' | 'length'; usage?: Usage | null; streamResultMismatch?: boolean };
export type Provider = {
  generate(request: ModelRequest, controls?: GenerateControls): Promise<GenerationResult>;
  countInput?(request: ModelRequest, controls?: Controls): Promise<number>;
  // A scheduled provider always has `check`, which returns undefined if the provider has none.
  check?(controls?: Controls): Promise<unknown> | undefined;
};

export function createModel(config: ModelConfig & { dbPath: string }): Provider {
  if (config.provider === 'claude-code') return createClaude(config);
  if (config.provider === 'llama-cpp') return createLlama(config);
  if (config.provider === 'openai-compatible') {
    const channel = channelFor(config.baseUrl!, config.model);
    return createOpenAI(config, { budget: createBudget(BUDGET_PATH, channel, capsFor(channel, config.budget)) });
  }
  throw new Error('Unsupported model provider');
}
