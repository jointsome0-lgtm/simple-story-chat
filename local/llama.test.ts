import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlama } from './llama.ts';
import { loadModelConfig, modelBaseUrl } from './config.ts';
import { ModelError } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest } from './model.ts';

// The request body fields these tests read.
type SentBody = { messages: unknown; chat_template_kwargs: { enable_thinking: unknown }; response_format?: unknown; id_slot?: unknown };
type Answer = (init: RequestInit) => Response | Promise<Response>;
type Provider = ReturnType<typeof createLlama>;

const config = { provider: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536, temperature: 0.8 };
const request = (): ModelRequest => ({ system: 'Синтетические правила.', messages: [
  { role: 'user', content: 'Синтетический сид.' }, { role: 'user', content: 'Память.' },
  { role: 'assistant', content: '2026-08-02 20:00\n\nСцена.' }, { role: 'user', content: 'Дальше.' },
], maxOutputTokens: 4096 });
// A caller far below its limit may send a request on its own estimate (ModelRequest `trustEstimate`): the count is a
// round trip of its own, and the server reports the real number while it generates.
const trusted = (estimatedInputTokens?: number): ModelRequest => ({ ...request(), estimatedInputTokens, trustEstimate: true });
const chunk = (delta: object, finish: string | null = null) => ({ model: config.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number) => new Response('PRIVATE_RAW_ERROR', { status });
const sse = (body: ReadableStream) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
function stream(items: object[], { split = false, done = true } = {}) {
  const encoded = new TextEncoder().encode(items.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  return sse(new ReadableStream({ start(controller) {
    if (split) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoded);
    controller.close();
  } }));
}
// A finished scene whose last chunk reports the usage; `last` adds to that chunk or replaces its usage.
const finished = (last: object = {}, finish = 'stop'): Answer => () => stream([chunk({ content: 'Готово.' }, finish), { choices: [], usage, ...last }]);
// A fake llama-server: `count` answers the exact count and `answer` every other call. The calls are kept by stage.
function fixture(answer = finished(), count: Answer = () => json({ input_tokens: 120 }),
  { contextTokens = config.contextTokens, timeoutMs }: { contextTokens?: number; timeoutMs?: number } = {}) {
  const calls: { stage: string; body: SentBody | null; init: RequestInit }[] = [];
  const provider = createLlama({ ...config, contextTokens, timeoutMs }, { fetch: async (url, init) => {
    const path = new URL(url).pathname;
    const stage = path.endsWith('/input_tokens') ? 'count' : path.endsWith('/completions') ? 'generate' : 'health';
    // The provider sends JSON text.
    calls.push({ stage, body: init.body ? JSON.parse(init.body as string) : null, init });
    return (stage === 'count' ? count : answer)(init);
  } });
  return { provider, calls, stages: () => calls.map(call => call.stage) };
}
// The rejection has these fields and carries none of the server's raw text.
const rejects = (pending: Promise<unknown>, expected: Partial<ModelError>, label: string) => assert.rejects(pending, (error: ModelError) => {
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, error[key as keyof ModelError]])), expected, label);
  assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE/, label);
  return true;
}, label);

test('configuration allows tunnel or authenticated HTTPS, rejects unsafe/ambiguous endpoints', async () => {
  for (const url of ['http://example.com', 'http://127.0.0.1:8080/v1', 'https://user:pass@example.com', 'https://example.com?key=x', 'file:///tmp/model']) {
    assert.throws(() => modelBaseUrl(url), url);
  }
  const load = (env: Record<string, string>) => loadModelConfig('/nonexistent-simple-chat-config',
    { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:8080', ...env });
  const c = load({});
  assert.deepEqual([c.provider, c.compactAtTokens, c.memoryMode, load({ SIMPLE_CHAT_MEMORY_MODE: 'sgr' }).memoryMode], ['llama-cpp', 44000, 'plain', 'sgr']);
  assert.equal(load({ SIMPLE_CHAT_BASE_URL: 'https://example.com', SIMPLE_CHAT_API_KEY: 'synthetic-key' }).apiKey, 'synthetic-key');
  // One slot unless a pool is named, and isolated slots by default: each holds one request's context. A shared cache
  // (`--kv-unified`) is at least one request's context, and the bot must ask for it in so many words.
  for (const [label, env, pool] of [
    ['one slot by default', {}, [1, 65536, false]],
    ['isolated slots', { SIMPLE_CHAT_GPU_SLOTS: '3', SIMPLE_CHAT_POOL_TOKENS: '98304' }, [3, 65536, false]],
    ['a shared cache', { SIMPLE_CHAT_GPU_SLOTS: '3', SIMPLE_CHAT_GPU_KV_UNIFIED: 'true', SIMPLE_CHAT_POOL_TOKENS: '98304' }, [3, 98304, true]],
    ['a shared cache smaller than one request', { SIMPLE_CHAT_GPU_SLOTS: '3', SIMPLE_CHAT_GPU_KV_UNIFIED: 'true', SIMPLE_CHAT_POOL_TOKENS: '32768' }, null],
    ['a shared cache asked for in other words', { SIMPLE_CHAT_GPU_KV_UNIFIED: 'yes' }, null],
    ['more slots than a pool may have', { SIMPLE_CHAT_GPU_SLOTS: '9' }, null],
    ['a memory mode that does not exist', { SIMPLE_CHAT_MEMORY_MODE: 'other' }, null],
    ['remote HTTPS without a key', { SIMPLE_CHAT_BASE_URL: 'https://example.com' }, null],
  ] as const) {
    if (!pool) assert.throws(() => load(env), label);
    else { const loaded = load(env); assert.deepEqual([loaded.slots, loaded.poolTokens, loaded.sharedCache], pool, label); }
  }
  // Startup then holds the server at that root to the configuration: the selected alias, one request's context in each
  // slot and the slot count. A shared pool is larger than that and the API does not report it, so a server that
  // reports only one slot's room is accepted.
  for (const [label, id, n_ctx, total_slots, slots, code] of [
    ['another alias', 'wrong', 65536, 1, 1, 'unexpected_model'],
    ['a slot smaller than one request', 'test-model', 32768, 1, 1, 'context_limit'],
    ['a slot the bot did not ask for', 'test-model', 65536, 2, 1, 'unexpected_slots'],
    ['the configured server', 'test-model', 65536, 1, 1, null],
    ['a pool whose slot is smaller than one request', 'test-model', 32768, 3, 3, 'context_limit'],
    ['a pool that reports one slot\'s room', 'test-model', 65536, 3, 3, null],
    ['a pool that reports its shared cache', 'test-model', 98304, 3, 3, null],
  ] as const) {
    const provider = createLlama(config, { slots, fetch: async url => new URL(url).pathname === '/v1/models'
      ? json({ data: [{ id }] }) : json({ default_generation_settings: { n_ctx }, total_slots }) });
    if (code) await assert.rejects(provider.check(), { code }, label);
    else assert.deepEqual(await provider.check(), { model: 'test-model', contextTokens: n_ctx, slots }, label);
  }
});

const outputSchema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string' } } },
  required: ['facts'], additionalProperties: false };
const timings = { cache_n: 100, prompt_n: 20, prompt_ms: 41.6, prompt_per_second: 480.7, predicted_n: 8,
  predicted_ms: 250.4, draft_n: -1, draft_n_accepted: 'x' };
const whole = ['count', 'generate'];
// A request, its controls and what the server answers; whether the caller counts it first; the calls it makes, and
// either the refusal or what the result shows.
type Case = { label: string; request?: ModelRequest; controls?: GenerateControls; answer?: Answer; count?: Answer; contextTokens?: number;
  countFirst?: boolean; stages: string[]; error?: Partial<ModelError>; check?: (result: GenerationResult, bodies: (SentBody | null)[]) => void };
const cases: Case[] = [
  // Counting and generation send one body: the system prompt first, consecutive user turns joined, no thinking, and for
  // a scene no schema and no slot.
  { label: 'a scene counted before it is generated', countFirst: true, stages: whole, check: (result, [count, sent]) => {
    assert.deepEqual(count, sent);
    assert.deepEqual(sent!.messages, [{ role: 'system', content: request().system },
      { role: 'user', content: 'Синтетический сид.\n\nПамять.' }, ...request().messages.slice(2)]);
    assert.deepEqual([sent!.chat_template_kwargs.enable_thinking, 'response_format' in sent!, 'id_slot' in sent!, 'timings' in result],
      [false, false, false, false]);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8, cachedInputTokens: 100, reasoningCharacters: 0, totalTokens: 128 });
  } },
  { label: 'a memory request with its schema', request: { ...request(), outputSchema, purpose: 'memory' }, countFirst: true, stages: whole,
    check: (_, bodies) => assert.deepEqual(bodies.map(body => body!.response_format), Array(2).fill({ type: 'json_object', schema: outputSchema })) },
  { label: 'timings of the last chunk', answer: finished({ timings }), stages: whole,
    check: result => assert.deepEqual(result.timings, { cacheTokens: 100, promptTokens: 20, promptMs: 42, predictedTokens: 8, predictedMs: 250 }) },
  // In a pool the slot goes with them: a cache count says little without the cache it was counted in.
  { label: 'a pool\'s slot', controls: { slot: 2 }, answer: finished({ timings }), stages: whole,
    check: (result, [, sent]) => assert.deepEqual([sent!.id_slot, result.timings!.slot], [2, 2]) },
  { label: 'a length finish without output usage', answer: () => stream([chunk({ content: 'Начало сцены.' }, 'length')]), stages: whole,
    check: result => assert.deepEqual([result.finishReason, result.usage!.inputTokens, result.usage!.outputTokens], ['length', 120, null]) },
  // The server counted 120 where the estimate said 100: that is no mismatch, and its count is the usage.
  { label: 'a trusted estimate', request: trusted(100), stages: ['generate'],
    check: result => assert.deepEqual([result.usage!.inputTokens, result.usage!.totalTokens], [120, 128]) },
  // Only an estimate that is a count is trusted: none, zero or a fraction is counted first as before.
  ...[undefined, 0, 99.5].map(estimate => ({ label: `a trusted request whose estimate is ${estimate ?? 'missing'}`, request: trusted(estimate), stages: whole })),
  { label: 'an estimate the count puts over the caller\'s limit', request: { ...request(), estimatedInputTokens: 1 },
    controls: { inputLimitTokens: 119 }, stages: ['count'], error: { code: 'context_limit' } },
  { label: 'a count over what the context leaves for the output', contextTokens: 4215, stages: ['count'], error: { code: 'context_limit' } },
  { label: 'a server that counts otherwise', answer: finished({ usage: { ...usage, prompt_tokens: 121 } }), stages: whole, error: { code: 'unexpected_context' } },
  // A caller that asks for the count gets it, trusted or not, and generation then holds the server to it.
  { label: 'a trusted request its caller counted', request: trusted(100), countFirst: true,
    answer: finished({ usage: { ...usage, prompt_tokens: 121 } }), stages: whole, error: { code: 'unexpected_context' } },
  ...['stop', 'length'].map(finish => ({ label: `a trusted request the server counts over the limit, ${finish}`, request: trusted(30000),
    controls: { inputLimitTokens: 53999 }, answer: finished({ usage: { ...usage, prompt_tokens: 54000 } }, finish), stages: ['generate'],
    error: { code: 'context_limit' } })),
  // Without the server's count nothing says the request fitted.
  { label: 'a trusted request the server does not count', request: trusted(100), answer: () => stream([chunk({ content: 'Текст.' }, 'stop')]),
    stages: ['generate'], error: { code: 'usage_unavailable' } },
  // An estimate over the limit is refused before anything is sent, as a count over it is.
  { label: 'a trusted estimate over the limit', request: trusted(54000), controls: { inputLimitTokens: 53999 }, stages: [], error: { code: 'context_limit' } },
  // llama-server started with --no-context-shift answers a prompt as long as its context with 400, before generating.
  // A trusted request then makes the count it skipped; unless that count is over the limit, the refusal stands as it came.
  ...([['over the limit', () => json({ input_tokens: 70000 }), 'context_limit'], ['within it', undefined, 'provider_failed'],
    ['failed too', () => refusal(500), 'provider_failed']] as const).map(([what, count, code]): Case => ({ label: `a trusted request refused, its count ${what}`,
    request: trusted(30000), answer: () => refusal(400), count, stages: ['generate', 'count'], error: { code, phase: 'generate', httpStatus: 400 } })),
  // A request counted before it was sent is not counted again.
  { label: 'a counted request refused', answer: () => refusal(400), stages: whole, error: { code: 'provider_failed', phase: 'generate', httpStatus: 400 } },
];

test('a request is counted and reserved before it is sent, and the server\'s stream is held to that count', async () => {
  for (const c of cases) {
    const f = fixture(c.answer, c.count, { contextTokens: c.contextTokens });
    const r = c.request ?? request();
    if (c.countFirst) assert.equal(await f.provider.countInput(r), 120, c.label);
    const pending = f.provider.generate(r, c.controls);
    if (c.error) await rejects(pending, c.error, c.label);
    else { const result = await pending; c.check?.(result, f.calls.map(call => call.body)); }
    assert.deepEqual(f.stages(), c.stages, c.label);
  }
});

// createOpenAI shares this handling with llama.cpp: these are the cases to keep for it when llama.cpp is removed.
const waitForAbort: Answer = init => new Promise((_resolve, reject) => {
  init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});
const socket = (code: string) => new TypeError('PRIVATE_ERROR', { cause: Object.assign(new Error('PRIVATE_CAUSE'), { code }) });
const broken = (code: string): Answer => () => sse(new ReadableStream({ start(controller) { controller.error(socket(code)); } }));
// An external abort while the count is in flight.
const abortedWith = (reason?: unknown) => (provider: Provider) => {
  const controller = new AbortController();
  const pending = provider.generate(request(), { signal: controller.signal });
  controller.abort(reason);
  return pending;
};
type Failure = { label: string; error: Partial<ModelError>; answer?: Answer; count?: Answer; timeoutMs?: number; stages?: string[];
  act?: (provider: Provider) => Promise<unknown> };
const failures: Failure[] = [
  { label: 'a stream that ends without [DONE]', answer: () => stream([chunk({ content: 'Обрыв.' })], { done: false }), error: { code: 'incomplete_stream' } },
  { label: 'a stream that ends without a finish', answer: () => stream([chunk({ content: 'Обрыв.' })]), error: { code: 'incomplete_stream' } },
  { label: 'a tool call', answer: () => stream([chunk({ tool_calls: [{ id: 'x' }] })]), error: { code: 'unexpected_tools' } },
  { label: 'a tool_calls finish', answer: () => stream([chunk({ content: 'Текст.' }, 'tool_calls')]), error: { code: 'invalid_stream' } },
  { label: 'an error event', answer: () => stream([{ error: { message: 'PRIVATE_RAW_ERROR' } }]), error: { code: 'invalid_stream' } },
  // A failed call is not retried, and its body is not read.
  ...([[401, 'unauthorized'], [429, 'rate_limited'], [503, 'model_unavailable'], [404, 'unsupported_server']] as const).map(([status, code]): Failure =>
    ({ label: `${status} on the count`, count: () => refusal(status), stages: ['count'], error: { code, httpStatus: status, phase: 'count_input' } })),
  { label: '500 on generation', answer: () => refusal(500), stages: whole, error: { code: 'provider_failed', httpStatus: 500, phase: 'generate' } },
  // A socket code the log knows is kept and any other is `other`, whether the socket fails before the stream or in it.
  ...(['ECONNRESET', 'PRIVATE_CODE'] as const).flatMap(code => [false, true].map((during): Failure => ({
    label: `${code} ${during ? 'in' : 'before'} the stream`, answer: during ? broken(code) : () => { throw socket(code); },
    error: { code: 'provider_failed', phase: 'generate', transportCode: code === 'ECONNRESET' ? code : 'other' } }))),
  // An external abort is `cancelled` whatever its reason, and only a deadline is a `timeout`. The call in flight ends.
  { label: 'abort() without a reason', count: waitForAbort, act: abortedWith(), stages: ['count'], error: { code: 'cancelled' } },
  { label: 'abort(ModelError(\'cancelled\'))', count: waitForAbort, act: abortedWith(new ModelError('cancelled')), stages: ['count'], error: { code: 'cancelled' } },
  { label: 'abort(ModelError(\'background_preempted\'))', count: waitForAbort, act: abortedWith(new ModelError('background_preempted')),
    stages: ['count'], error: { code: 'cancelled' } },
  { label: 'an external AbortSignal.timeout', count: waitForAbort, act: provider => provider.generate(request(), { signal: AbortSignal.timeout(10) }),
    stages: ['count'], error: { code: 'timeout' } },
  { label: 'its own deadline', count: waitForAbort, timeoutMs: 10, stages: ['count'], error: { code: 'timeout' } },
  { label: 'a health check past its AbortSignal.timeout', answer: waitForAbort, act: provider => provider.check({ signal: AbortSignal.timeout(10) }),
    stages: ['health'], error: { code: 'timeout', phase: 'health' } },
];

test('HTTP, SSE and abort handling shared with the hosted adapter: split bytes decode, and every failure ends in a safe code', async t => {
  // AbortSignal.timeout does not keep Node alive.
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
  // A stream split into single bytes: no character is cut, and reasoning is counted apart from the text.
  const f = fixture(() => stream([chunk({ reasoning_content: 'Скрытое рассуждение.' }), chunk({ content: 'Привет, ' }),
    chunk({ content: 'мир 🌊.' }, 'stop'), { choices: [], usage }], { split: true }));
  const parts: string[] = [];
  const result = await f.provider.generate(request(), { onText: async value => parts.push(value) });
  assert.deepEqual([parts.join(''), result.text], ['Привет, мир 🌊.', 'Привет, мир 🌊.']);
  assert.equal(result.usage!.reasoningCharacters, 'Скрытое рассуждение.'.length);
  // No redirect is followed.
  assert.deepEqual(f.calls.map(call => call.init.redirect), ['error', 'error']);
  for (const { label, error, answer, count, timeoutMs, stages, act = (provider: Provider) => provider.generate(request()) } of failures) {
    const g = fixture(answer, count, { timeoutMs });
    await rejects(act(g.provider), error, label);
    if (stages) assert.deepEqual(g.stages(), stages, label);
  }
});
