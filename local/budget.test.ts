import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBudget, channelFor, capsFor, readUsage } from './budget.ts';
import { createOpenAI } from './llama.ts';
import type { ModelError } from './model-error.ts';

const ledger = () => join(mkdtempSync(join(tmpdir(), 'simple-chat-budget-')), 'usage.sqlite');
const code = (expected: string) => (error: ModelError) => error.code === expected;

test('free channels have default caps under the allowance; billed channels stay closed until a cap is set', () => {
  assert.equal(channelFor('https://openrouter.ai/api/v1', 'google/gemma-4-31b-it:free'), 'openrouter-free');
  assert.equal(channelFor('https://openrouter.ai/api/v1', 'google/gemma-4-31b-it'), 'openrouter-paid');
  assert.equal(channelFor('https://api.openai.com/v1', 'gpt-5.4-mini'), 'openai-small');
  assert.equal(channelFor('https://api.openai.com/v1', 'gpt-5.4'), 'openai-large');
  assert.equal(channelFor('https://api.openai.com/v1', 'gpt-5.4-pro'), 'openai-paid');
  assert.equal(channelFor('https://api.cerebras.ai/v1', 'gpt-oss-120b'), 'cerebras');
  assert.equal(channelFor('https://api.groq.com/openai/v1', 'openai/gpt-oss-120b'), 'groq');
  assert.equal(channelFor('https://api.mistral.ai/v1', 'mistral-large-2512'), 'mistral');
  assert.equal(channelFor('https://example.com/v1', 'any'), 'other');
  assert.deepEqual(capsFor('openrouter-free'), { requests: 900 });
  assert.deepEqual(capsFor('openai-small'), { tokens: 2_250_000 });
  assert.deepEqual(capsFor('openai-paid'), { requests: 0, tokens: 0 });
  assert.deepEqual(capsFor('openrouter-paid', { tokens: 5_000_000 }), { tokens: 5_000_000 });
  assert.deepEqual(capsFor('openrouter-free', { requests: 100 }), { requests: 100 });
});

test('the ledger reserves an estimate, settles to the real count and is shared between budgets', () => {
  const path = ledger();
  const first = createBudget(path, 'openai-small', { tokens: 1000 });
  first.begin(600).settle(300);
  assert.deepEqual(readUsage(path).map(({ channel, requests, tokens }) => ({ channel, requests, tokens })), [{ channel: 'openai-small', requests: 1, tokens: 300 }]);
  const second = createBudget(path, 'openai-small', { tokens: 1000 });
  second.begin(600); // fails later: the reservation stays
  assert.throws(() => first.begin(200), code('budget_exceeded'));
  assert.equal(readUsage(path)[0].tokens, 900);
  assert.equal(readUsage(path)[0].requests, 2);
  const requests = createBudget(path, 'openrouter-free', { requests: 1 });
  requests.begin(10).settle(10);
  assert.throws(() => requests.begin(10), code('budget_exceeded'));
  assert.throws(() => createBudget(path, 'openai-paid', capsFor('openai-paid')).begin(1), code('budget_exceeded'));
});

test('the adapter asks the budget before sending and records provider usage', async () => {
  const path = ledger();
  let sent = 0;
  const fetch = async () => { sent++; return new Response(new TextEncoder().encode(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Готово.' }, finish_reason: 'stop' }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 140, completion_tokens: 60 } })}\n\ndata: [DONE]\n\n`), { headers: { 'Content-Type': 'text/event-stream' } }); };
  const provider = createOpenAI({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', contextTokens: 65536, apiKey: 'synthetic-key' },
    { fetch, budget: createBudget(path, 'openai-small', { tokens: 5000 }) });
  const request = { system: 'Синтетические правила.', messages: [{ role: 'user' as const, content: 'Дальше.' }], maxOutputTokens: 4096 };
  await provider.generate(request);
  assert.equal(readUsage(path)[0].tokens, 200);
  // A request reserves its input estimate plus the whole output limit: 400 used + 1000 + 4096 is over 5000.
  await provider.generate(request);
  await assert.rejects(provider.generate({ ...request, estimatedInputTokens: 1000 }), code('budget_exceeded'));
  assert.equal(sent, 2);
});
