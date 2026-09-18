import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI } from './llama.ts';
import { loadConfig, loadModelConfig, apiBaseUrl } from './config.ts';
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

test('one request under the API root, without llama.cpp fields; the provider count replaces the estimate', async () => {
  // As OpenRouter streams it: the closing usage chunk repeats the finish reason with an empty delta.
  const f = fixture(() => stream([chunk({ reasoning: 'Рассуждение.' }), chunk({ content: 'Готово.' }, 'stop'),
    { ...chunk({ content: '', role: 'assistant' }, 'stop'), usage: { prompt_tokens: 140, completion_tokens: 8 } }]));
  const result = await f.provider.generate({ ...request(), estimatedInputTokens: 100, outputSchema: { type: 'object' } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal((f.calls[0].options.headers as { Authorization: string }).Authorization, 'Bearer synthetic-key');
  assert.deepEqual(Object.keys(f.calls[0].body!).sort(), ['max_tokens', 'messages', 'model', 'reasoning', 'response_format', 'stream', 'stream_options', 'temperature']);
  assert.deepEqual(f.calls[0].body!.reasoning, { enabled: false });
  assert.deepEqual(f.calls[0].body!.response_format, { type: 'json_object' });
  assert.equal('countInput' in f.provider, false);
  assert.deepEqual(result.usage, { inputTokens: 140, outputTokens: 8, cachedInputTokens: null,
    reasoningCharacters: 'Рассуждение.'.length, totalTokens: 148 });
});

test('OpenAI gets max_completion_tokens and its default sampling', async () => {
  const f = fixture(() => stream([chunk({ content: 'Готово.' }, 'stop'), { choices: [], usage: { prompt_tokens: 140, completion_tokens: 8 } }]),
    { baseUrl: 'https://api.openai.com/v1/', model: 'gpt-5.4-mini' });
  await f.provider.generate(request());
  assert.equal(f.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(f.calls[0].body!.max_completion_tokens, 4096);
  assert.equal('max_tokens' in f.calls[0].body!, false);
  assert.equal('temperature' in f.calls[0].body!, false);
  assert.equal('reasoning' in f.calls[0].body!, false);
});

test('an oversized estimate is rejected before the request; a missing or oversized provider count rejects the result', async () => {
  const over = fixture(() => stream([]));
  await assert.rejects(over.provider.generate({ ...request(), estimatedInputTokens: 61441 }), code('context_limit'));
  assert.equal(over.calls.length, 0);
  const silent = fixture(() => stream([chunk({ content: 'Готово.' }, 'stop')]));
  await assert.rejects(silent.provider.generate(request()), code('usage_unavailable'));
  const late = fixture(() => stream([chunk({ content: 'Готово.' }, 'stop'), { choices: [], usage: { prompt_tokens: 61441, completion_tokens: 8 } }]));
  await assert.rejects(late.provider.generate(request()), code('context_limit'));
});

test('HTTP failures become safe codes and the health check looks the model up', async () => {
  await assert.rejects(fixture(() => new Response('secret', { status: 429 })).provider.generate(request()),
    (error: ModelError) => error.code === 'rate_limited' && error.httpStatus === 429 && error.phase === 'generate');
  await assert.rejects(fixture(() => new Response('secret', { status: 401 })).provider.generate(request()), code('unauthorized'));
  const f = fixture(() => json({ data: [{ id: config.model }] }));
  assert.deepEqual(await f.provider.check(), { model: config.model });
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/models');
  await assert.rejects(fixture(() => json({ data: [{ id: 'other' }] })).provider.check(), code('unexpected_model'));
});

test('configuration: an HTTPS API root with a key and a model, for probes only', () => {
  assert.equal(apiBaseUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
  for (const url of [undefined, 'http://openrouter.ai/api/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=1']) {
    assert.throws(() => apiBaseUrl(url));
  }
  const env = { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: 'https://openrouter.ai/api/v1',
    SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_MODEL: config.model };
  const loaded = loadModelConfig('/nonexistent-simple-chat-config', env);
  assert.equal(loaded.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(loaded.compactAtTokens, 44000);
  assert.throws(() => loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_API_KEY: '' }));
  assert.throws(() => loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_MODEL: '' }));
  assert.throws(() => loadConfig('/nonexistent-simple-chat-config', { ...env, TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1' }),
    /synthetic probes only/);
});
