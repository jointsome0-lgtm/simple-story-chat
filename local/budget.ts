// Daily caps for hosted APIs. Every hosted request passes the adapter, so the cap lives there; the ledger is a
// SQLite file because parallel probes share it. It holds a day, a channel name and two counters, never any text.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ModelError } from './model-error.ts';

export type Caps = { requests?: number | undefined; tokens?: number | undefined };
export type Budget = {
  // Counts the request and reserves its estimated tokens, or throws budget_exceeded before anything is sent.
  begin(estimatedTokens: number): { settle(actualTokens: number): void };
};

// The models OpenAI's shared-traffic offer covers, as of 2026-09-18. Any other model there is billed.
const OPENAI_LARGE = ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3'];
const OPENAI_SMALL = ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini', 'o3-mini', 'o4-mini'];
// Defaults stay a tenth under the free allowance: 1000 requests, 2.5M tokens and 250K tokens a day.
// A billed channel is closed until its cap is set by hand.
const DEFAULTS: { [channel: string]: Caps } = {
  'openrouter-free': { requests: 900 }, 'openai-small': { tokens: 2_250_000 }, 'openai-large': { tokens: 225_000 },
  // Free plans as of 2026-09-18, per model: Cerebras 1M tokens a day; Groq 1000 requests and 200K tokens a day.
  // One channel per host is stricter than the provider's per-model limits.
  cerebras: { tokens: 900_000 }, groq: { requests: 900, tokens: 180_000 },
  // Mistral's Free plan includes $10 of API usage a month and bills nothing beyond it while pay-as-you-go is off.
  // The daily cap only spreads that allowance over the month.
  mistral: { tokens: 500_000 },
};

export function channelFor(baseUrl: string, model: string): string {
  const host = new URL(baseUrl).hostname;
  if (host === 'openrouter.ai') return model.endsWith(':free') ? 'openrouter-free' : 'openrouter-paid';
  if (host === 'api.openai.com') return OPENAI_SMALL.includes(model) ? 'openai-small' : OPENAI_LARGE.includes(model) ? 'openai-large' : 'openai-paid';
  if (host === 'api.cerebras.ai') return 'cerebras';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'api.mistral.ai') return 'mistral';
  return 'other';
}

export function capsFor(channel: string, override: Caps = {}): Caps {
  const caps = { ...DEFAULTS[channel] };
  if (override.requests !== undefined) caps.requests = override.requests;
  if (override.tokens !== undefined) caps.tokens = override.tokens;
  return Object.keys(caps).length ? caps : { requests: 0, tokens: 0 };
}

const today = () => new Date().toISOString().slice(0, 10); // both providers reset at 00:00 UTC

function open(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: 10000 });
  db.exec('CREATE TABLE IF NOT EXISTS usage (day TEXT, channel TEXT, requests INTEGER NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (day, channel))');
  return db;
}

export function createBudget(path: string, channel: string, caps: Caps): Budget {
  const add = (requests: number, tokens: number, check: boolean) => {
    const db = open(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      const day = today();
      const used = db.prepare('SELECT requests, tokens FROM usage WHERE day = ? AND channel = ?').get(day, channel) as { requests: number; tokens: number } | undefined;
      const next = { requests: (used?.requests ?? 0) + requests, tokens: Math.max(0, (used?.tokens ?? 0) + tokens) };
      if (check && ((caps.requests !== undefined && next.requests > caps.requests) || (caps.tokens !== undefined && next.tokens > caps.tokens))) {
        db.exec('ROLLBACK');
        throw new ModelError('budget_exceeded');
      }
      db.prepare('INSERT INTO usage VALUES (?, ?, ?, ?) ON CONFLICT (day, channel) DO UPDATE SET requests = excluded.requests, tokens = excluded.tokens')
        .run(day, channel, next.requests, next.tokens);
      db.exec('COMMIT');
    } finally { db.close(); }
  };
  return { begin(estimatedTokens) {
    const reserved = Math.ceil(estimatedTokens);
    add(1, reserved, true);
    let settled = false;
    // A request that fails keeps its reservation: whether the provider counted it is unknown.
    return { settle(actualTokens) { if (!settled) { settled = true; add(0, actualTokens - reserved, false); } } };
  } };
}

export function readUsage(path: string): { day: string; channel: string; requests: number; tokens: number }[] {
  const db = open(path);
  try { return db.prepare('SELECT day, channel, requests, tokens FROM usage WHERE day = ? ORDER BY channel').all(today()) as ReturnType<typeof readUsage>; }
  finally { db.close(); }
}
