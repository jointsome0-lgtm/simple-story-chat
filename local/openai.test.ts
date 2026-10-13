import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI } from './llama.ts';
import type { ModelError } from './model-error.ts';
import type { ModelRequest } from './model.ts';

// The request body fields these tests read.
type SentBody = { [field: string]: unknown };

const config = { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-4-31b-it:free', contextTokens: 65536, temperature: 0.8, apiKey: 'synthetic-key' };
const request = (): ModelRequest => ({ system: 'Синтетические правила.', messages: [
  { role: 'user', content: 'Синтетический сид.' }, { role: 'assistant', content: 'Сцена.' }, { role: 'user', content: 'Дальше.' },
], maxOutputTokens: 4096 });
const chunk = (delta: object, finish: string | null = null) => ({ model: 'provider/other-name', choices: [{ index: 0, delta, finish_reason: finish }] });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function stream(items: object[]) {
  // OpenRouter sends SSE comments while the model is queued.
  const text = ': OPENROUTER PROCESSING\n\n' + items.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(text), { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(respond: () => Response, overrides: Partial<typeof config> = {}) {
  const calls: { url: string; body: SentBody | null; options: RequestInit }[] = [];
  const fetch = async (url: string, options: RequestInit) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body as string) : null, options });
    return respond();
  };
  return { calls, provider: createOpenAI({ ...config, ...overrides }, { fetch }) };
}
const code = (expected: string) => (error: ModelError) => error.code === expected;
const answer = chunk({ content: 'Готово.' }, 'stop'), usage = { prompt_tokens: 140, completion_tokens: 8 };

test('one request under the API root, without llama.cpp fields; OpenAI gets max_completion_tokens and its default sampling', async () => {
  const shared = { messages: ['system', 'user', 'assistant', 'user'], stream: true, stream_options: { include_usage: true } };
  const reply = (schema: object) => ({ type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } });
  const text = (lengths: object) => ({ type: 'object', properties: { text: { type: 'string', ...lengths, enum: ['a'] } } });
  const hosts: [string, Partial<typeof config>, object, string, SentBody][] = [
    // OpenRouter routes only to an endpoint that enforces the schema, and its reasoning is off.
    ['OpenRouter', {}, { type: 'object' }, 'https://openrouter.ai/api/v1/chat/completions', { ...shared, model: config.model, max_tokens: 4096,
      temperature: 0.8, reasoning: { enabled: false }, response_format: reply({ type: 'object' }), provider: { require_parameters: true } }],
    // OpenAI's strict mode refuses string lengths.
    ['OpenAI', { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5.4-mini' }, text({ minLength: 1, maxLength: 9 }), 'https://api.openai.com/v1/chat/completions',
      { ...shared, model: 'gpt-5.4-mini', max_completion_tokens: 4096, response_format: reply(text({})) }],
  ];
  for (const [label, overrides, outputSchema, url, body] of hosts) {
    const f = fixture(() => stream([answer, { choices: [], usage }]), overrides);
    await f.provider.generate({ ...request(), outputSchema });
    assert.equal(f.calls.length, 1, label);
    assert.equal(f.calls[0].url, url, label);
    assert.equal((f.calls[0].options.headers as { Authorization: string }).Authorization, 'Bearer synthetic-key', label);
    assert.deepEqual({ ...f.calls[0].body, messages: (f.calls[0].body!.messages as { role: string }[]).map(m => m.role) }, body, label);
    assert.equal('countInput' in f.provider, false, label);
  }
});

test('the provider count replaces the estimate: an oversized estimate is rejected before the request, a missing or oversized count rejects the result', async () => {
  const runs: [string, object[], number | undefined, number, string | object][] = [
    // As OpenRouter streams it: reasoning apart, and the closing usage chunk repeats the finish reason with an empty delta.
    ['a counted answer', [chunk({ reasoning: 'Рассуждение.' }), answer, { ...chunk({ content: '', role: 'assistant' }, 'stop'), usage }], 100, 1,
      { inputTokens: 140, outputTokens: 8, cachedInputTokens: null, reasoningCharacters: 'Рассуждение.'.length, totalTokens: 148 }],
    ['an estimate over the limit', [], 61441, 0, 'context_limit'],
    ['no count', [answer], undefined, 1, 'usage_unavailable'],
    ['a count over the limit', [answer, { choices: [], usage: { ...usage, prompt_tokens: 61441 } }], undefined, 1, 'context_limit'],
  ];
  for (const [label, items, estimatedInputTokens, calls, outcome] of runs) {
    const f = fixture(() => stream(items));
    const generated = f.provider.generate({ ...request(), estimatedInputTokens });
    if (typeof outcome === 'string') await assert.rejects(generated, code(outcome), label);
    else assert.deepEqual((await generated).usage, outcome, label);
    assert.equal(f.calls.length, calls, label);
  }
});

// The HTTP layer is llama.cpp's too (llama.ts), as is the SSE reader of the tests above: these cases outlive that adapter.
test('HTTP failures become safe codes and the health check looks the model up', async () => {
  for (const [status, expected] of [[429, 'rate_limited'], [401, 'unauthorized']] as const) {
    await assert.rejects(fixture(() => new Response('secret', { status })).provider.generate(request()), (error: ModelError) =>
      error.code === expected && error.httpStatus === status && error.phase === 'generate' && !error.message.includes('secret'), `HTTP ${status}`);
  }
  const f = fixture(() => json({ data: [{ id: config.model }] }));
  assert.deepEqual(await f.provider.check(), { model: config.model });
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/models');
  await assert.rejects(fixture(() => json({ data: [{ id: 'other' }] })).provider.check(), code('unexpected_model'));
});
