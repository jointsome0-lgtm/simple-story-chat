import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudget, channelFor, capsFor, readUsage } from './budget.ts';
import type { Caps } from './budget.ts';
import { createOpenAI } from './llama.ts';
import type { ModelError } from './model-error.ts';

const ledger = () => join(mkdtempSync(join(tmpdir(), 'simple-chat-budget-')), 'usage.sqlite');
const code = (expected: string) => (error: ModelError) => error.code === expected;
const usage = (path: string) => readUsage(path).map(({ channel, requests, tokens }) => ({ channel, requests, tokens }));

test('the ledger reserves an estimate, settles to the real count and is shared between budgets', () => {
  const path = ledger();
  const first = createBudget(path, 'openai-small', { tokens: 1000 });
  first.begin(600).settle(300);
  assert.deepEqual(usage(path), [{ channel: 'openai-small', requests: 1, tokens: 300 }]);
  createBudget(path, 'openai-small', { tokens: 1000 }).begin(600); // fails later: the reservation stays
  assert.throws(() => first.begin(200), code('budget_exceeded'));
  assert.deepEqual(usage(path), [{ channel: 'openai-small', requests: 2, tokens: 900 }]);
  const requests = createBudget(path, 'openrouter-free', { requests: 1 });
  requests.begin(10).settle(10);
  assert.throws(() => requests.begin(10), code('budget_exceeded'));
});

// A hosted API's channel and daily cap, as model.ts wires them into the adapter: a free channel's default stays a
// tenth under its allowance, and a billed one is closed until a cap is set by hand.
const OR = 'https://openrouter.ai/api/v1', OA = 'https://api.openai.com/v1', gemma = 'google/gemma-4-31b-it', closed = { requests: 0, tokens: 0 };
const channels: [string, string, string, Caps, Caps?][] = [
  [OR, `${gemma}:free`, 'openrouter-free', { requests: 900 }], [OR, `${gemma}:free`, 'openrouter-free', { requests: 100 }, { requests: 100 }],
  [OR, gemma, 'openrouter-paid', closed], [OR, gemma, 'openrouter-paid', { tokens: 5_000_000 }, { tokens: 5_000_000 }],
  [OA, 'gpt-5.4-mini', 'openai-small', { tokens: 2_250_000 }], [OA, 'gpt-5.4', 'openai-large', { tokens: 225_000 }],
  [OA, 'gpt-5.4-pro', 'openai-paid', closed], ['https://api.cerebras.ai/v1', 'gpt-oss-120b', 'cerebras', { tokens: 900_000 }],
  ['https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', 'groq', { requests: 900, tokens: 180_000 }],
  ['https://api.mistral.ai/v1', 'mistral-large-2512', 'mistral', { tokens: 500_000 }], ['https://example.com/v1', 'any', 'other', closed],
];

test('the adapter asks the budget before sending and records provider usage', async () => {
  let sent = 0;
  const fetch = async () => { sent++; return new Response(new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Готово.' }, finish_reason: 'stop' }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 140, completion_tokens: 60 } })}\n\ndata: [DONE]\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }); };
  const request = { system: 'Синтетические правила.', messages: [{ role: 'user' as const, content: 'Дальше.' }], maxOutputTokens: 4096 };
  const adapter = (path: string, baseUrl: string, model: string, channel: string, caps: Caps) =>
    createOpenAI({ baseUrl, model, contextTokens: 65536, apiKey: 'synthetic-key' }, { fetch, budget: createBudget(path, channel, caps) });
  for (const [baseUrl, model, channel, caps, override] of channels) {
    const label = `${channel} ${JSON.stringify(override ?? {})}`, path = ledger(), before = sent, shut = caps === closed;
    assert.equal(channelFor(baseUrl, model), channel, label);
    assert.deepEqual(capsFor(channel, override), caps, label);
    const generated = adapter(path, baseUrl, model, channel, capsFor(channel, override)).generate(request);
    await (shut ? assert.rejects(generated, code('budget_exceeded'), label) : generated);
    assert.equal(sent - before, shut ? 0 : 1, label);
    assert.deepEqual(usage(path), shut ? [] : [{ channel, requests: 1, tokens: 200 }], label);
  }
  // A request reserves its input estimate plus the whole output limit, and settles to what the provider counted:
  // 200 used, then 400; then 400 + 1000 + 4096 is over 5000, and nothing is sent.
  const path = ledger(), before = sent, provider = adapter(path, OA, 'gpt-5.4-mini', 'openai-small', { tokens: 5000 });
  await provider.generate(request);
  assert.equal(readUsage(path)[0].tokens, 200);
  await provider.generate(request);
  await assert.rejects(provider.generate({ ...request, estimatedInputTokens: 1000 }), code('budget_exceeded'));
  assert.equal(sent - before, 2);
});
