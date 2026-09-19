import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlama } from './llama.ts';
import { loadModelConfig, modelBaseUrl } from './config.ts';
import type { ModelError } from './model-error.ts';
import type { ModelRequest } from './model.ts';

// The request body fields these tests read.
type SentBody = { messages: unknown; chat_template_kwargs: { enable_thinking: unknown }; response_format?: unknown };
type Respond = (path: string, body: SentBody | null, options: RequestInit) => Response;

const config = { provider: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536, temperature: 0.8 };
const request = (): ModelRequest => ({ system: 'Синтетические правила.', messages: [
  { role: 'user', content: 'Синтетический сид.' }, { role: 'user', content: 'Память.' },
  { role: 'assistant', content: '2026-08-02 20:00\n\nСцена.' }, { role: 'user', content: 'Дальше.' },
], maxOutputTokens: 4096 });
const chunk = (delta: object, finish: string | null = null) => ({ model: config.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function stream(items: object[], { split = false, done = true } = {}) {
  const encoded = new TextEncoder().encode(items.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoded);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture(respond: Respond = () => stream([chunk({ content: 'Готово.' }, 'stop'), { choices: [], usage }])) {
  const calls: { path: string; body: SentBody | null; options: RequestInit }[] = [];
  const fetch = async (url: string, options: RequestInit) => {
    // The provider sends JSON text.
    const body: SentBody | null = options.body ? JSON.parse(options.body as string) : null;
    const path = new URL(url).pathname;
    calls.push({ path, body, options });
    if (path.endsWith('/input_tokens')) return json({ input_tokens: 120 });
    return respond(path, body, options);
  };
  return { calls, provider: createLlama(config, { fetch }) };
}

test('exact count and generation share a body; fragmented UTF-8 and reasoning remain separate', async () => {
  const f = fixture(() => stream([chunk({ reasoning_content: 'Скрытое рассуждение.' }),
    chunk({ content: 'Привет, ' }), chunk({ content: 'мир 🌊.' }, 'stop'), { choices: [], usage }], { split: true }));
  const r = request();
  const parts: string[] = [];
  assert.equal(await f.provider.countInput(r), 120);
  const result = await f.provider.generate(r, { onText: async value => parts.push(value) });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  assert.deepEqual(f.calls[0].body!.messages, [{ role: 'system', content: r.system },
    { role: 'user', content: 'Синтетический сид.\n\nПамять.' }, ...r.messages.slice(2)]);
  assert.equal(f.calls[1].body!.chat_template_kwargs.enable_thinking, false);
  assert.equal(f.calls[1].options.redirect, 'error');
  assert.equal(parts.join(''), 'Привет, мир 🌊.');
  assert.equal(result.text, parts.join(''));
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8, cachedInputTokens: 100,
    reasoningCharacters: 'Скрытое рассуждение.'.length, totalTokens: 128 });
});

test('llama-server timings of the last chunk become rounded counts; malformed ones are dropped', async () => {
  const timings = { cache_n: 100, prompt_n: 20, prompt_ms: 41.6, prompt_per_second: 480.7, predicted_n: 8,
    predicted_ms: 250.4, draft_n: -1, draft_n_accepted: 'x' };
  const f = fixture(() => stream([chunk({ content: 'Готово.' }, 'stop'), { choices: [], usage, timings }]));
  const result = await f.provider.generate(request());
  assert.deepEqual(result.timings, { cacheTokens: 100, promptTokens: 20, promptMs: 42, predictedTokens: 8, predictedMs: 250 });
  assert.equal('timings' in await fixture().provider.generate(request()), false);
});

test('input/output reservation rejects before generating, even when an estimate says it fits', async () => {
  const f = fixture();
  await assert.rejects(f.provider.generate({ ...request(), estimatedInputTokens: 1 }, { inputLimitTokens: 119 }), { code: 'context_limit' });
  assert.equal(f.calls.length, 1);
  const small = createLlama({ ...config, contextTokens: 4215 }, { fetch: async () => json({ input_tokens: 120 }) });
  await assert.rejects(small.generate(request()), { code: 'context_limit' });
});

test('schema-constrained requests keep the same schema for counting and generation; scenes stay free-form', async () => {
  const f = fixture();
  const outputSchema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } },
    required: ['facts'], additionalProperties: false };
  const r: ModelRequest = { ...request(), outputSchema, purpose: 'memory' };
  await f.provider.countInput(r);
  await f.provider.generate(r);
  assert.deepEqual(f.calls[0].body!.response_format, { type: 'json_object', schema: outputSchema });
  assert.deepEqual(f.calls[1].body!.response_format, f.calls[0].body!.response_format);
  await f.provider.generate(request());
  assert.equal(f.calls.at(-1)!.body!.response_format, undefined);
});

test('EOF, tools, invalid finishes and changed token counts cannot commit a scene', async () => {
  const cases: [Respond, string][] = [
    [() => stream([chunk({ content: 'Обрыв.' })], { done: false }), 'incomplete_stream'],
    [() => stream([chunk({ content: 'Обрыв.' })]), 'incomplete_stream'],
    [() => stream([chunk({ tool_calls: [{ id: 'x' }] })]), 'unexpected_tools'],
    [() => stream([chunk({ content: 'Текст.' }, 'tool_calls')]), 'invalid_stream'],
    [() => stream([chunk({ content: 'Текст.' }, 'stop'), { choices: [], usage: { ...usage, prompt_tokens: 121 } }]), 'unexpected_context'],
    [() => stream([{ error: { message: 'PRIVATE_RAW_ERROR' } }]), 'invalid_stream'],
  ];
  for (const [respond, code] of cases) await assert.rejects(fixture(respond).provider.generate(request()), { code });
});

test('length finishes remain marked, missing output usage remains unknown', async () => {
  const f = fixture(() => stream([chunk({ content: 'Начало сцены.' }, 'length')]));
  const result = await f.provider.generate(request());
  assert.equal(result.finishReason, 'length');
  assert.equal(result.usage!.inputTokens, 120);
  assert.equal(result.usage!.outputTokens, null);
});

test('HTTP failure returns a safe code without retries or raw error disclosure', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [429, 'rate_limited'], [503, 'model_unavailable'], [404, 'unsupported_server']] as const) {
    let calls = 0;
    const provider = createLlama(config, { fetch: async () => { calls++; return new Response('PRIVATE_RAW_ERROR', { status }); } });
    await assert.rejects(provider.generate(request()), { code, message: code, httpStatus: status, phase: 'count_input' });
    assert.equal(calls, 1);
  }
});

test('generation HTTP failures preserve their stage and status without reading the error body', async () => {
  const f = fixture(path => path.endsWith('/input_tokens') ? json({ input_tokens: 120 })
    : new Response('PRIVATE_RAW_ERROR', { status: 500 }));
  await assert.rejects(f.provider.generate(request()), (error: ModelError) => {
    assert.equal(error.code, 'provider_failed');
    assert.equal(error.phase, 'generate');
    assert.equal(error.httpStatus, 500);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE_RAW_ERROR/);
    return true;
  });
});

test('transport failures keep known socket codes or other, including response stream failures', async () => {
  for (const duringStream of [false, true]) for (const code of ['ECONNRESET', 'PRIVATE_CODE']) {
    const failure = new TypeError('PRIVATE_ERROR', { cause: Object.assign(new Error('PRIVATE_CAUSE'), { code }) });
    const f = fixture(path => {
      if (path.endsWith('/input_tokens')) return json({ input_tokens: 120 });
      if (!duringStream) throw failure;
      return new Response(new ReadableStream({ start(controller) { controller.error(failure); } }),
        { headers: { 'Content-Type': 'text/event-stream' } });
    });
    await assert.rejects(f.provider.generate(request()), (error: ModelError) => {
      assert.equal(error.code, 'provider_failed');
      assert.equal(error.phase, 'generate');
      assert.equal(error.transportCode, code === 'ECONNRESET' ? code : 'other');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});

test('cancellation and timeout close the in-flight request', async () => {
  const waitForAbort = async (_: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  });
  const controller = new AbortController();
  const provider = createLlama(config, { fetch: waitForAbort });
  const pending = provider.generate(request(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  const timer = setTimeout(() => {}, 1000); // AbortSignal.timeout does not keep Node alive.
  try {
    await assert.rejects(createLlama({ ...config, timeoutMs: 10 }, { fetch: waitForAbort }).generate(request()), { code: 'timeout' });
    await assert.rejects(provider.check({ signal: AbortSignal.timeout(10) }), { code: 'timeout', phase: 'health' });
  }
  finally { clearTimeout(timer); }
});

test('startup checks the selected alias, context per slot and slot count', async () => {
  for (const [model, n_ctx, total_slots, code] of [
    ['wrong', 65536, 1, 'unexpected_model'], ['test-model', 32768, 1, 'context_limit'],
    ['test-model', 65536, 2, 'unexpected_slots'], ['test-model', 65536, 1, null],
  ] as const) {
    const f = fixture(path => path === '/v1/models' ? json({ data: [{ id: model }] })
      : json({ default_generation_settings: { n_ctx }, total_slots }));
    if (code) await assert.rejects(f.provider.check(), { code });
    else assert.equal((await f.provider.check()).contextTokens, 65536);
  }
});

test('configuration allows tunnel or authenticated HTTPS, rejects unsafe/ambiguous endpoints', () => {
  for (const url of ['http://example.com', 'http://127.0.0.1:8080/v1', 'https://user:pass@example.com', 'https://example.com?key=x', 'file:///tmp/model']) {
    assert.throws(() => modelBaseUrl(url));
  }
  const env = { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:8080' };
  const c = loadModelConfig('/nonexistent-simple-chat-config', env);
  assert.equal(c.provider, 'llama-cpp');
  assert.equal(c.compactAtTokens, 44000);
  assert.equal(c.memoryMode, 'plain');
  assert.equal(loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_MEMORY_MODE: 'sgr' }).memoryMode, 'sgr');
  assert.throws(() => loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_MEMORY_MODE: 'other' }));
  assert.throws(() => loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_BASE_URL: 'https://example.com' }));
  assert.equal(loadModelConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_BASE_URL: 'https://example.com', SIMPLE_CHAT_API_KEY: 'synthetic-key' }).apiKey, 'synthetic-key');
});
