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
// `trustEstimate`: the caller's estimate is far enough below its limit that a provider which counts input exactly
// may send the request without counting it first (local/llama.ts); the count the server reports while generating
// still decides whether the result stands.
export type ModelRequest = {
  system: string; messages: ChatMessage[]; maxOutputTokens: number;
  purpose?: 'memory'; outputSchema?: object; estimatedInputTokens?: number; trustEstimate?: boolean;
};
// `onWait`: a shared model's queue reports how many calls are ahead of this one, each time the number changes.
// `onStart`: the call has left a shared model's queue and runs.
export type Controls = { signal?: AbortSignal; onWait?: (ahead: number) => void; onStart?: () => void };
// `slot`: the llama.cpp slot a pooled scheduler places the call in (`id_slot`), so its cache stays with its owner.
export type GenerateControls = Controls & {
  onText?: (delta: string) => unknown; inputLimitTokens?: number; onQueued?: () => void; slot?: number;
};
// Server-side counts and durations of one request, as llama-server reports them, and the pool slot it ran in. For logs
// only; never stored.
export type Timings = Partial<Record<'cacheTokens' | 'promptTokens' | 'promptMs' | 'predictedTokens' | 'predictedMs'
  | 'draftTokens' | 'draftAcceptedTokens' | 'slot', number>>;
export type GenerationResult = {
  text: string; finishReason: 'stop' | 'length'; usage?: Usage | null; timings?: Timings; streamResultMismatch?: boolean;
};
// `holder`: whose work the turn is (a user id). `yields`: work done ahead of need (local/prepare.ts), which ends as soon as
// anybody else's call arrives, but which its holder's own turns wait for. `sharesPrefix`: work done ahead of need that
// continues its holder's own last request rather than ask with a prompt of its own, so it belongs in the slot where that
// prefix is cached and gives way to its holder's next turn as well; it yields whether or not `yields` is set.
export type TurnOptions = { holder?: string; yields?: boolean; sharesPrefix?: boolean };
export type Provider = {
  generate(request: ModelRequest, controls?: GenerateControls): Promise<GenerationResult>;
  countInput?(request: ModelRequest, controls?: Controls): Promise<number>;
  // Only a provider that can verify its server has `check`; the CLI providers have none.
  check?(controls?: Controls): Promise<unknown>;
  // A shared model (local/scheduler.ts) keeps its slot for one operation's calls until `end`.
  openTurn?(options?: TurnOptions): Provider & { end(): void };
};

export function createModel(config: ModelConfig & { dbPath: string }): Provider {
  if (config.provider === 'claude-code') return createClaude(config);
  if (config.provider === 'codex-cli') return createCodex(config);
  if (config.provider === 'llama-cpp') return createLlama(config, { slots: config.slots });
  if (config.provider === 'openai-compatible') {
    const channel = channelFor(config.baseUrl!, config.model);
    return createOpenAI(config, { budget: createBudget(BUDGET_PATH, channel, capsFor(channel, config.budget)) });
  }
  throw new Error('Unsupported model provider');
}
