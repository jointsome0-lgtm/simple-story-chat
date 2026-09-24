import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { codeFor, createServing, readerScope, workOf } from './serving.ts';
import { gpuConfig, loadAgentConfig, loadConfig, loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import { createScheduler } from './scheduler.ts';
import type { ModelError } from './model-error.ts';
import { safeErrorDetails, unavailable } from './model-error.ts';
import type { ModelRequest } from './model.ts';

type Sent = { path: string; method: string; headers: Headers; body: { [field: string]: unknown } | null; options: RequestInit };
type Respond = (path: string, sent: Sent) => Response;

const config = { baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536, apiKey: 'synthetic-key', temperature: 0.8 };
const state = { contract: '2', boot_id: 'synthetic-boot', status: 'ready', model: 'test-model', context_tokens: 65536, drain_generation: 0 };
const models = { object: 'list', data: [{ id: 'other-model', object: 'model', max_model_len: 65536 }, { id: 'test-model', object: 'model', max_model_len: 65536 }] };
const request = (): ModelRequest => ({ system: 'Синтетические правила.', messages: [
  { role: 'user', content: 'Синтетический сид.' }, { role: 'user', content: 'Память.' },
  { role: 'assistant', content: '2026-08-02 20:00\n\nСцена.' }, { role: 'user', content: 'Дальше.' },
], maxOutputTokens: 4096 });
// A caller far below its limit sends on its estimate (ModelRequest `trustEstimate`), and the usage chunk decides.
const trusted = (estimatedInputTokens = 100): ModelRequest => ({ ...request(), estimatedInputTokens, trustEstimate: true });
const chunk = (delta: object, finish: string | null = null) => ({ model: config.model, choices: [{ index: 0, delta, finish_reason: finish }] });
const measured = { wait_ms: 3, first_token_ms: 420, total_ms: 5100 };
const usage = { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 100 }, simple_serving: measured };
const closing = (fields: object = {}) => ({ model: config.model, choices: [], usage: { ...usage, ...fields } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const refusal = (status: number, code: string) => json({ error: { code } }, status);
// Events as the gateway writes them; a string is sent as the data of one event as it is.
function stream(items: (object | string)[], { split = false, done = true } = {}) {
  const encoded = new TextEncoder().encode(items.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('')
    + (done ? 'data: [DONE]\n\n' : ''));
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(encoded);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const answer = (text = 'Готово.') => stream([chunk({ role: 'assistant' }), chunk({ content: text }), chunk({}, 'stop'), closing()]);
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
// An adapter checks the service before its first count or generation. A test of something else puts this ready
// service in front of its fetch, and does not see the check.
const ready = (fetch: Fetch): Fetch => async (url, init) => {
  const path = new URL(url).pathname;
  return path === '/v1/state' ? json(state) : path === '/v1/models' ? json(models) : fetch(url, init);
};
// `seeCheck`: the test's `respond` answers the check, and the check is among the calls.
function fixture(respond: Respond = () => answer(), { seeCheck = false, ...options }: Partial<typeof config> & { timeoutMs?: number; seeCheck?: boolean } = {}) {
  const calls: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    // The provider sends JSON text.
    const sent = { path: new URL(url).pathname, method: init.method ?? 'GET', headers: new Headers(init.headers),
      body: init.body ? JSON.parse(init.body as string) : null, options: init };
    calls.push(sent);
    if (sent.path.endsWith('/input_tokens')) return json({ input_tokens: 120 });
    return respond(sent.path, sent);
  };
  return { calls, provider: createServing({ ...config, ...options }, { fetch: seeCheck ? fetch : ready(fetch) }) };
}
const whose = (sent: Sent) => [sent.headers.get('x-simple-serving-class'), sent.headers.get('x-simple-serving-scope')];

test('count and generation send one body of the contract\'s fields, with neighbouring roles merged', async () => {
  const f = fixture();
  const r = request();
  assert.equal(await f.provider.countInput(r), 120);
  // A pool's slot means nothing to the gateway and is never sent.
  await f.provider.generate(r, { slot: 2 });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`),
    ['POST /v1/chat/completions/input_tokens', 'POST /v1/chat/completions']);
  assert.deepEqual(f.calls[0].body, f.calls[1].body);
  assert.deepEqual(f.calls[1].body, { model: 'test-model', messages: [{ role: 'system', content: r.system },
    { role: 'user', content: 'Синтетический сид.\n\nПамять.' }, ...r.messages.slice(2)],
    max_tokens: 4096, stream: true, stream_options: { include_usage: true }, temperature: 0.8,
    top_p: 0.95, top_k: 64, min_p: 0, repetition_penalty: 1, chat_template_kwargs: { enable_thinking: false } });
  for (const call of f.calls) {
    assert.equal(call.headers.get('authorization'), 'Bearer synthetic-key');
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.equal(call.options.redirect, 'error');
  }
  // The configured temperature, and the default without one.
  for (const [temperature, sent] of [[1.1, 1.1], [undefined, 0.8]]) {
    const g = fixture(undefined, { temperature });
    await g.provider.generate(trusted());
    assert.equal(g.calls[0].body!.temperature, sent);
  }
});

test('a structured request asks for its schema as json_schema, and memory samples cold', async () => {
  const f = fixture();
  const outputSchema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string', maxLength: 200 } } },
    required: ['facts'], additionalProperties: false };
  const r: ModelRequest = { ...request(), outputSchema, purpose: 'memory' };
  await f.provider.countInput(r);
  await f.provider.generate(r);
  // The schema goes as it is, lengths included: the gateway passes it to the engine unread (contract section 4).
  assert.deepEqual(f.calls[0].body!.response_format, { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema: outputSchema } });
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  assert.equal(f.calls[1].body!.temperature, 0.2);
  await f.provider.generate(request());
  assert.equal('response_format' in f.calls.at(-1)!.body!, false);
  assert.equal(f.calls.at(-1)!.body!.temperature, 0.8);
});

test('every call says whose it is: a reader with a scope of their own, the agent, or internal work', async () => {
  const f = fixture();
  await f.provider.generate(trusted(), { priority: 'foreground', holder: 'synthetic-reader' });
  await f.provider.countInput(request(), { priority: 'foreground', holder: 'synthetic-reader' });
  await f.provider.generate(trusted(), { priority: 'agent', holder: 'synthetic-reader' });
  await f.provider.generate(trusted(), { priority: 'background' });
  // A call that did not come through the scheduler is our own work, whatever its request carries: whose a call is
  // comes from the controls alone, never from a request, which a socket client writes (local/background.ts).
  await f.provider.generate({ ...trusted(), priority: 'foreground', holder: 'synthetic-reader' } as ModelRequest);
  await f.provider.countInput({ ...request(), priority: 'foreground', holder: 'synthetic-reader' } as ModelRequest);
  const reader = readerScope('synthetic-reader');
  assert.deepEqual(f.calls.map(whose), [['reader', reader], ['reader', reader], ['agent', 'agent'], ['internal', 'internal'],
    ['internal', 'internal'], ['internal', 'internal']]);
  assert.deepEqual(workOf(), { class: 'internal', scope: 'internal' });
});

test('a reader\'s scope is stable in the process, differs between readers and never shows the holder', () => {
  const holders = ['123456789', '987654321', 'synthetic-reader'];
  const scopes = holders.map(readerScope);
  for (const [index, scope] of scopes.entries()) {
    // The contract allows 8 to 64 characters of A-Z, a-z, 0-9, _ and - after `reader.`.
    assert.match(scope, /^reader\.[A-Za-z0-9_-]{22}$/);
    assert.equal(readerScope(holders[index]), scope);
    assert.equal(scope.includes(holders[index]), false);
  }
  assert.equal(new Set(scopes).size, holders.length);
  assert.deepEqual(workOf({ priority: 'foreground', holder: '123456789' }), { class: 'reader', scope: scopes[0] });
});

// Whatever scope such a call were given, it would share another reader's cache or never meet its own.
test('a person\'s call that names no reader is refused before anything is sent', async t => {
  for (const holder of [undefined, '']) {
    assert.throws(() => workOf({ priority: 'foreground', holder }), { code: 'unnamed_reader' });
    const f = fixture(undefined, { seeCheck: true });
    await assert.rejects(f.provider.generate(trusted(), { priority: 'foreground', holder }), { code: 'unnamed_reader', phase: 'generate' });
    await assert.rejects(f.provider.countInput(request(), { priority: 'foreground', holder }), { code: 'unnamed_reader', phase: 'count_input' });
    assert.deepEqual(f.calls, []);
  }
  // Through the scheduler: a person's call outside a turn, or in a turn that names nobody.
  const f = fixture(undefined, { seeCheck: true });
  const scheduler = createScheduler(f.provider, { quietMs: 0, pollMs: 100000 });
  t.after(() => scheduler.close());
  await assert.rejects(scheduler.foreground.generate(trusted()), { code: 'unnamed_reader' });
  await assert.rejects(scheduler.foreground.countInput!(request()), { code: 'unnamed_reader' });
  const nobody = scheduler.foreground.openTurn();
  await assert.rejects(nobody.generate(trusted()), { code: 'unnamed_reader' });
  nobody.end();
  assert.deepEqual(f.calls, []);
});

test('a reader\'s scope comes from a secret of this process: another process gives the same holder another scope', () => {
  const module = JSON.stringify(new URL('./serving.ts', import.meta.url).href);
  const scopes = [0, 1].map(() => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { readerScope } from ${module}; process.stdout.write(readerScope('synthetic-reader'))`], { encoding: 'utf8' }));
  for (const scope of scopes) assert.match(scope, /^reader\.[A-Za-z0-9_-]{22}$/);
  assert.notEqual(scopes[0], scopes[1]);
  assert.equal(scopes.includes(readerScope('synthetic-reader')), false);
});

// A log row is made from an error by safeErrorDetails, and the error is all that a failed call leaves behind. The
// secret stays inside the module.
test('a reader\'s failed call leaves neither the holder nor the scope in its error, and the secret is not exported', async () => {
  const scope = readerScope('synthetic-reader');
  for (const respond of [() => refusal(403, 'class_not_allowed'),
    () => stream([chunk({ content: 'Текст.' }), { error: { code: 'engine_unavailable' } }], { done: false })]) {
    const f = fixture(respond);
    const error: ModelError = await f.provider.generate(trusted(), { priority: 'foreground', holder: 'synthetic-reader' })
      .then(() => assert.fail('the call must fail'), (error: ModelError) => error);
    const traces = [JSON.stringify(error), String(error), error.stack ?? '', JSON.stringify(safeErrorDetails(error))].join('\n');
    for (const secret of ['synthetic-reader', scope.slice('reader.'.length)]) assert.equal(traces.includes(secret), false);
  }
  assert.deepEqual(Object.keys(await import('./serving.ts')), ['codeFor', 'createServing', 'readerScope', 'workOf']);
});

test('through the scheduler, a person\'s turn, an agent\'s turn and a probe reach the gateway as reader, agent and internal', async t => {
  const f = fixture();
  const scheduler = createScheduler(f.provider, { quietMs: 0, pollMs: 100000 });
  t.after(() => scheduler.close());
  const reader = scheduler.foreground.openTurn({ holder: 'synthetic-reader' });
  const scene = request();
  await reader.countInput!(scene);
  await reader.generate(scene);
  reader.end();
  // The work done ahead for a reader is theirs too, in the order the bot runs it: their picture's description, which
  // continues the scene in its slot (local/picture.ts), then the compaction prepared while they read (local/prepare.ts).
  for (const options of [{ sharesPrefix: true }, { yields: true }]) {
    const ahead = scheduler.foreground.openTurn({ holder: 'synthetic-reader', ...options });
    await ahead.countInput!(request());
    await ahead.generate(trusted());
    ahead.end();
  }
  const agent = scheduler.agent.openTurn();
  await agent.countInput!(request());
  await agent.generate(trusted());
  agent.end();
  await scheduler.background.countInput!(request());
  await scheduler.background.generate(trusted());
  const scope = readerScope('synthetic-reader');
  assert.deepEqual(f.calls.map(whose), [...Array(6).fill(['reader', scope]), ['agent', 'agent'], ['agent', 'agent'],
    ['internal', 'internal'], ['internal', 'internal']]);
  // One lane: nothing slot-specific reaches the body.
  for (const call of f.calls) assert.equal('id_slot' in call.body!, false);
});

test('a stream of text, reasoning and usage becomes the result, with the gateway\'s measurements as timings', async () => {
  const f = fixture(() => stream([chunk({ role: 'assistant' }), { ...chunk({ reasoning_content: 'Скрытое рассуждение.' }), usage: null },
    chunk({ content: 'Привет, ' }), chunk({}), { model: config.model, choices: [] }, chunk({ content: 'мир 🌊.' }, 'stop'), closing()], { split: true }));
  const parts: string[] = [];
  const result = await f.provider.generate(request(), { onText: async value => parts.push(value) });
  assert.equal(parts.join(''), 'Привет, мир 🌊.');
  assert.equal(result.text, parts.join(''));
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 8, cachedInputTokens: 100,
    reasoningCharacters: 'Скрытое рассуждение.'.length, totalTokens: 128 });
  // The gateway's own numbers go to fields of their own, never into llama-server's prompt and prediction times.
  assert.deepEqual(result.timings, { servingWaitMs: 3, servingFirstTokenMs: 420, servingTotalMs: 5100, cacheTokens: 100 });
  // Without cached tokens the cache is unknown, not empty. The measurements are all three, in order, or none, and never
  // fail an answer: absent, out of order, not whole milliseconds, not numbers, one missing or not a record.
  for (const simple_serving of [undefined, { wait_ms: 3, first_token_ms: 2, total_ms: 1 }, { wait_ms: 3, first_token_ms: 420, total_ms: '5100' },
    { wait_ms: -1, first_token_ms: 420, total_ms: 5100 }, { wait_ms: 3, first_token_ms: 1.5, total_ms: 5100 }, { wait_ms: 3, total_ms: 5100 },
    [3, 420, 5100]]) {
    const g = fixture(() => stream([chunk({ content: 'Текст.' }, 'length'),
      { model: config.model, choices: [], usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: [100], simple_serving } }]));
    const cut = await g.provider.generate(request());
    assert.equal(cut.finishReason, 'length');
    assert.equal(cut.usage!.cachedInputTokens, null);
    assert.deepEqual(cut.timings, {}, JSON.stringify(simple_serving));
  }
  // An answer of no tokens at all, from a request that waited for nothing, is still in order.
  const empty = await fixture(() => stream([chunk({ content: 'Текст.' }, 'length'),
    closing({ completion_tokens: 0, simple_serving: { wait_ms: 0, first_token_ms: 0, total_ms: 0 } })])).provider.generate(request());
  assert.deepEqual([empty.usage!.outputTokens, empty.usage!.totalTokens, empty.timings],
    [0, 120, { servingWaitMs: 0, servingFirstTokenMs: 0, servingTotalMs: 0, cacheTokens: 100 }]);
});

test('a stream that fails what the adapter checks never becomes an answer', async () => {
  const text = chunk({ content: 'Текст.' });
  const stop = chunk({}, 'stop');
  type Case = [string, (object | string)[], { done?: boolean }, string];
  const cases: Case[] = [
    ['another model', [{ ...text, model: 'other-model' }, stop, closing()], {}, 'unexpected_model'],
    ['a chunk without a model', [{ choices: text.choices }, stop, closing()], {}, 'invalid_stream'],
    ['no usage chunk', [text, stop], {}, 'usage_unavailable'],
    ['usage without prompt tokens', [text, stop, closing({ prompt_tokens: undefined })], {}, 'usage_unavailable'],
    ...[undefined, null, -1, 1.5, '8'].map((value): Case =>
      [`completion tokens of ${value}`, [text, stop, closing({ completion_tokens: value })], {}, 'usage_unavailable']),
    ['usage that is not a record', [text, stop, { model: config.model, choices: [], usage: [usage] }], {}, 'invalid_stream'],
    ['usage before the finish', [text, closing(), stop], {}, 'invalid_stream'],
    ['usage beside a choice', [text, { ...stop, usage }], {}, 'invalid_stream'],
    ['a second usage chunk', [text, stop, closing(), closing()], {}, 'invalid_stream'],
    ['a chunk after the usage chunk', [text, stop, closing(), chunk({})], {}, 'invalid_stream'],
    ['two finishes', [text, stop, stop, closing()], {}, 'invalid_stream'],
    ['an unknown finish', [text, chunk({}, 'tool_calls'), closing()], {}, 'invalid_stream'],
    ['content after the finish', [text, stop, chunk({ content: 'Ещё.' }), closing()], {}, 'invalid_stream'],
    ['reasoning after the finish', [text, stop, chunk({ reasoning_content: 'Ещё.' }), closing()], {}, 'invalid_stream'],
    ['a role after the finish', [text, stop, chunk({ role: 'assistant' }), closing()], {}, 'invalid_stream'],
    ['an empty delta after the finish', [text, stop, chunk({}), closing()], {}, 'invalid_stream'],
    ['a chunk without a choice after the finish', [text, stop, { model: config.model, choices: [] }, closing()], {}, 'invalid_stream'],
    ['a delta that is not a record', [chunk([]), text, stop, closing()], {}, 'invalid_stream'],
    ['a choice that is not a record', [{ model: config.model, choices: [[text.choices[0]]] }, stop, closing()], {}, 'invalid_stream'],
    ['no finish', [text], {}, 'incomplete_stream'],
    ['no [DONE]', [text, stop, closing()], { done: false }, 'incomplete_stream'],
    ['two choices', [{ model: config.model, choices: [text.choices[0], text.choices[0]] }, stop, closing()], {}, 'invalid_stream'],
    ['a choice with index 1', [{ model: config.model, choices: [{ ...text.choices[0], index: 1 }] }, stop, closing()], {}, 'invalid_stream'],
    ['content that is not text', [chunk({ content: 5 }), stop, closing()], {}, 'invalid_stream'],
    ['tool calls', [chunk({ tool_calls: [{ id: 'x' }] }), stop, closing()], {}, 'unexpected_tools'],
    ['a line that is not JSON', [text, 'PRIVATE_RAW_TEXT', stop, closing()], {}, 'invalid_stream'],
    ['an empty answer', [chunk({ content: ' \n' }), stop, closing()], {}, 'empty_response'],
  ];
  for (const [name, items, options, code] of cases) {
    await assert.rejects(fixture(() => stream(items, options)).provider.generate(request()), (error: ModelError) => {
      assert.equal(error.code, code, name);
      assert.equal(error.phase, 'generate', name);
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
  // Bytes that are not UTF-8, and an answer that is not a stream at all.
  const broken = new Response(new Uint8Array([...new TextEncoder().encode('data: {"model":"test-model","choices":[]}\n\ndata: '), 0xff, 0xfe, 10, 10]),
    { headers: { 'Content-Type': 'text/event-stream' } });
  await assert.rejects(fixture(() => broken).provider.generate(request()), { code: 'provider_failed', phase: 'generate' });
  await assert.rejects(fixture(() => json({ choices: [] })).provider.generate(request()), { code: 'invalid_stream' });
});

test('an error event ends a started stream with the gateway\'s code, and the text before it is not an answer', async () => {
  for (const [servingCode, code] of [['engine_unavailable', 'model_unavailable'], ['draining', 'model_unavailable'],
    ['timeout', 'timeout'], ['internal_error', 'provider_failed'], ['PRIVATE_CODE', 'provider_failed']] as const) {
    const parts: string[] = [];
    const f = fixture(() => stream([chunk({ content: 'Начало ' }), chunk({}, 'stop'), { error: { code: servingCode } }], { done: false }));
    await assert.rejects(f.provider.generate(request(), { onText: async value => parts.push(value) }), (error: ModelError) => {
      assert.equal(error.code, code);
      assert.equal(error.servingCode, servingCode === 'PRIVATE_CODE' ? 'other' : servingCode);
      // The status was 200 already: that and the code tell an error event from a refusal before the stream.
      assert.equal(error.httpStatus, 200);
      assert.equal(error.phase, 'generate');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE|Начало/);
      return true;
    });
    assert.deepEqual(parts, ['Начало ']);
  }
  // An error event without a code of the contract's shape is no code at all, and a list is no record: both still end
  // the stream.
  for (const error of [{ message: 'PRIVATE_RAW_ERROR' }, [{ code: 'draining' }]]) {
    await assert.rejects(fixture(() => stream([chunk({ content: 'Начало ' }), { error }], { done: false })).provider.generate(request()),
      (failure: ModelError) => failure.code === 'provider_failed' && failure.servingCode === undefined && !/PRIVATE/.test(JSON.stringify(failure)));
  }
});

test('oversized streams and texts stop at the limits the bot keeps for every server', async () => {
  const long = 'Ж'.repeat(60_000);
  await assert.rejects(fixture(() => stream([chunk({ content: long }), chunk({ content: long }), chunk({}, 'stop'), closing()]))
    .provider.generate(request()), { code: 'output_limit' });
  // Two million bytes of events, reasoning here, whatever they carry.
  const reasoning = chunk({ reasoning_content: 'ж'.repeat(40_000) });
  await assert.rejects(fixture(() => stream([...Array.from({ length: 30 }, () => reasoning), chunk({ content: 'Текст.' }, 'stop'), closing()]))
    .provider.generate(request()), { code: 'output_limit' });
});

test('refusals map by their code, keep the status, phase and code, and never carry the body', async () => {
  const table = [[400, 'invalid_request', 'provider_failed'], [400, 'unsupported_field', 'provider_failed'],
    [400, 'limit_exceeded', 'provider_failed'], [400, 'context_limit', 'context_limit'], [401, 'unauthorized', 'unauthorized'],
    [403, 'class_not_allowed', 'unauthorized'], [403, 'scope_not_allowed', 'unauthorized'], [403, 'forbidden', 'unauthorized'],
    [404, 'not_found', 'unsupported_server'], [409, 'stale_boot', 'provider_failed'], [409, 'stale_generation', 'provider_failed'],
    [413, 'body_too_large', 'provider_failed'], [429, 'queue_full', 'rate_limited'], [500, 'internal_error', 'provider_failed'],
    [503, 'starting', 'model_unavailable'], [503, 'draining', 'model_unavailable'], [503, 'drained', 'model_unavailable'],
    [503, 'engine_unavailable', 'model_unavailable'], [504, 'timeout', 'timeout']] as const;
  for (const [status, servingCode, code] of table) {
    assert.equal(codeFor(servingCode), code);
    const f = fixture(() => json({ error: { code: servingCode, message: 'PRIVATE_RAW_ERROR' } }, status));
    await assert.rejects(f.provider.generate(trusted()), (error: ModelError) => {
      assert.deepEqual({ ...error }, { code, httpStatus: status, phase: 'generate', servingCode });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
    // A gateway does not retry, and neither does the bot.
    assert.equal(f.calls.length, 1);
  }
  // The count is refused the same way, in its own phase.
  const counting = createServing(config, { fetch: ready(async () => refusal(429, 'queue_full')) });
  await assert.rejects(counting.countInput(request()), { code: 'rate_limited', phase: 'count_input', httpStatus: 429, servingCode: 'queue_full' });
  // A code the contract does not list, a body that is not the contract's, and one too large to be an error body.
  for (const [body, servingCode] of [[JSON.stringify({ error: { code: 'PRIVATE_CODE' } }), 'other'], ['PRIVATE_RAW_ERROR', undefined],
    [JSON.stringify({ error: 'PRIVATE_CODE' }), undefined], ['', undefined],
    [JSON.stringify({ padding: 'x'.repeat(5000), error: { code: 'queue_full' } }), undefined]] as const) {
    const provider = createServing(config, { fetch: ready(async () => new Response(body, { status: 500 })) });
    await assert.rejects(provider.generate(trusted()), (error: ModelError) => {
      assert.deepEqual({ ...error }, { code: 'provider_failed', httpStatus: 500, phase: 'generate', ...(servingCode ? { servingCode } : {}) });
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
      return true;
    });
  }
});

test('the gateway\'s context_limit is taken as it came: nothing is counted again', async () => {
  for (const r of [trusted(30000), request()]) {
    const f = fixture(() => refusal(400, 'context_limit'));
    await assert.rejects(f.provider.generate(r), { code: 'context_limit', httpStatus: 400, servingCode: 'context_limit' });
    assert.equal(f.calls.filter(call => call.path.endsWith('/input_tokens')).length, r.trustEstimate ? 0 : 1);
  }
});

test('a trusted estimate goes without a count, and the usage chunk decides; a count must match it', async () => {
  const f = fixture();
  const result = await f.provider.generate(trusted());
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/chat/completions']);
  // The gateway counted 120 where the estimate said 100: no mismatch, and its count is the usage.
  assert.equal(result.usage!.inputTokens, 120);
  // Only an estimate that is a count is trusted.
  for (const estimatedInputTokens of [undefined, 0, 99.5]) {
    const g = fixture();
    await g.provider.generate({ ...request(), estimatedInputTokens, trustEstimate: true });
    assert.deepEqual(g.calls.map(call => call.path), ['/v1/chat/completions/input_tokens', '/v1/chat/completions']);
  }
  // A count, asked for or made by generate itself, holds the stream to it.
  for (const counted of [true, false]) {
    const g = fixture(() => stream([chunk({ content: 'Текст.' }, 'stop'), closing({ prompt_tokens: 121 })]));
    const r = request();
    if (counted) assert.equal(await g.provider.countInput(r), 120);
    await assert.rejects(g.provider.generate(r), { code: 'unexpected_context' });
    assert.deepEqual(g.calls.map(call => call.path), ['/v1/chat/completions/input_tokens', '/v1/chat/completions']);
  }
  // Over the limit, by the estimate before sending or by the gateway's count after, the result does not stand.
  const over = fixture(() => stream([chunk({ content: 'Текст.' }, 'stop'), closing({ prompt_tokens: 54000 })]));
  await assert.rejects(over.provider.generate(trusted(30000), { inputLimitTokens: 53999 }), { code: 'context_limit' });
  const early = fixture();
  await assert.rejects(early.provider.generate(trusted(54000), { inputLimitTokens: 53999 }), { code: 'context_limit' });
  assert.equal(early.calls.length, 0);
  // A count that is not one.
  for (const value of [{ input_tokens: 0 }, { input_tokens: 'PRIVATE' }, null, [120]]) {
    const provider = createServing(config, { fetch: ready(async () => json(value)) });
    await assert.rejects(provider.countInput(request()), { code: 'usage_unavailable' });
  }
});

test('the check reads the state, then the model and its context, and the two must agree', async () => {
  const checked = (stateAnswer: unknown, modelsAnswer: unknown) =>
    fixture(path => path === '/v1/state' ? json(stateAnswer) : json(modelsAnswer), { seeCheck: true });
  const f = checked(state, models);
  assert.deepEqual(await f.provider.check({ priority: 'foreground', holder: 'synthetic-reader' }), { model: 'test-model', contextTokens: 65536 });
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`), ['GET /v1/state', 'GET /v1/models']);
  // A check names no class, whoever asks for it: only the key goes with it.
  for (const call of f.calls) {
    assert.equal(call.body, null);
    assert.equal(call.headers.get('authorization'), 'Bearer synthetic-key');
    assert.deepEqual([...call.headers.keys()], ['authorization']);
  }
  // Each answer, and how many routes the check read: a service that is not ready, not of this contract or not serving
  // this model is not asked for its models.
  const cases: [unknown, unknown, string, number][] = [
    [{ ...state, contract: '1' }, models, 'unsupported_server', 1], [{ ...state, contract: 2 }, models, 'unsupported_server', 1],
    [[state], models, 'unsupported_server', 1],
    [{ ...state, status: 'starting' }, models, 'model_unavailable', 1], [{ ...state, status: 'draining' }, models, 'model_unavailable', 1],
    [{ ...state, status: 'drained' }, models, 'model_unavailable', 1], [{ ...state, status: 'failed' }, models, 'model_unavailable', 1],
    [{ ...state, model: 'other-model' }, models, 'unexpected_model', 1], [{ ...state, model: undefined }, models, 'unexpected_model', 1],
    [state, { data: [{ id: 'other-model', max_model_len: 65536 }] }, 'unexpected_model', 2], [state, { data: null }, 'unexpected_model', 2],
    [state, [models], 'unexpected_model', 2], [state, { data: [[models.data[1]]] }, 'unexpected_model', 2],
    // The state and the models route give two contexts, or one of them none.
    [{ ...state, context_tokens: 32768 }, models, 'unsupported_server', 2], [{ ...state, context_tokens: undefined }, models, 'unsupported_server', 2],
    [state, { data: [{ id: 'test-model' }] }, 'unsupported_server', 2],
    [{ ...state, context_tokens: 32768 }, { data: [{ id: 'test-model', max_model_len: 32768 }] }, 'context_limit', 2],
  ];
  for (const [stateAnswer, modelsAnswer, code, routes] of cases) {
    const g = checked(stateAnswer, modelsAnswer);
    await assert.rejects(g.provider.check(), { code, phase: 'health' });
    assert.equal(g.calls.length, routes, JSON.stringify([stateAnswer, modelsAnswer]));
  }
  await assert.rejects(fixture(() => refusal(401, 'unauthorized'), { seeCheck: true }).provider.check(),
    { code: 'unauthorized', phase: 'health', httpStatus: 401, servingCode: 'unauthorized' });
  await assert.rejects(fixture(() => new Response('PRIVATE_RAW_TEXT'), { seeCheck: true }).provider.check(), { code: 'invalid_response' });
});

test('the bot starts while the service is down, and its first call checks the service before it goes on', async () => {
  // At the start (local/main.ts), a service out of reach or not ready lets the bot start; any other answer stops it.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const atStart = [[() => { throw refused; }, true], [() => refusal(503, 'starting'), true], [() => refusal(401, 'unauthorized'), false],
    [() => refusal(500, 'internal_error'), false], [() => json({ ...state, contract: '0' }), false],
    [() => json({ ...state, model: 'other-model' }), false]] as const;
  for (const [respond, starts] of atStart) assert.equal(unavailable(await fixture(respond, { seeCheck: true }).provider.check().catch(error => error)), starts);
  // Down, then back with another model, then back as configured.
  let serving: 'down' | 'other' | 'up' = 'down';
  const f = fixture(path => {
    if (serving === 'down') throw refused;
    const model = serving === 'up' ? 'test-model' : 'other-model';
    return path === '/v1/state' ? json({ ...state, model }) : path === '/v1/models' ? json({ data: [{ id: model, max_model_len: 65536 }] }) : answer();
  }, { seeCheck: true });
  await assert.rejects(f.provider.check(), { code: 'provider_failed', transportCode: 'ECONNREFUSED' });
  // A person's call that names no reader is still refused before anything is sent, the check included.
  await assert.rejects(f.provider.generate(trusted(), { priority: 'foreground' }), { code: 'unnamed_reader' });
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.provider.generate(trusted()), { code: 'provider_failed', transportCode: 'ECONNREFUSED' });
  serving = 'other';
  await assert.rejects(f.provider.countInput(request()), { code: 'unexpected_model' });
  serving = 'up';
  f.calls.length = 0;
  assert.equal((await f.provider.generate(trusted())).text, 'Готово.');
  assert.equal((await f.provider.generate(trusted())).text, 'Готово.');
  assert.deepEqual(f.calls.map(call => `${call.method} ${call.path}`),
    ['GET /v1/state', 'GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/chat/completions']);
});

test('cancellation and timeout close the in-flight request, and a check cancelled on the way is made again', async () => {
  const waitForAbort = async (_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
  // A ready service, except that the call is cancelled while its request on one path is in flight.
  const sent: string[] = [];
  let [holds, controller] = ['', new AbortController()];
  const pass = ready(async () => answer());
  const provider = createServing(config, { fetch: async (url, init) => {
    const path = new URL(url).pathname;
    sent.push(path);
    if (path !== holds) return pass(url, init);
    const held = waitForAbort(url, init);
    controller.abort();
    return held;
  } });
  // Cancelled in its check, a call sends no text; the next one checks again, and is cancelled in its stream.
  for (const path of ['/v1/state', '/v1/chat/completions']) {
    [holds, controller] = [path, new AbortController()];
    await assert.rejects(provider.generate(trusted(), { signal: controller.signal }), { code: 'cancelled' });
  }
  assert.deepEqual(sent, ['/v1/state', '/v1/state', '/v1/models', '/v1/chat/completions']);
  const timer = setTimeout(() => {}, 1000); // AbortSignal.timeout does not keep Node alive.
  try {
    await assert.rejects(createServing({ ...config, timeoutMs: 100 }, { fetch: ready(waitForAbort) }).generate(trusted()), { code: 'timeout', phase: 'generate' });
    await assert.rejects(createServing(config, { fetch: waitForAbort }).check({ signal: AbortSignal.timeout(10) }), { code: 'timeout', phase: 'health' });
  }
  finally { clearTimeout(timer); }
});

const serving = { SIMPLE_CHAT_PROVIDER: 'simple-serving', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:8081',
  SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_MODEL: 'synthetic-alias' };
const nowhere = '/nonexistent-simple-chat-config';

test('configuration: the gateway\'s root, its key even over the tunnel, and the name of its model', () => {
  const c = loadModelConfig(nowhere, serving);
  assert.deepEqual([c.provider, c.baseUrl, c.apiKey, c.model, c.compactAtTokens], ['simple-serving', 'http://127.0.0.1:8081', 'synthetic-key', 'synthetic-alias', 44000]);
  assert.equal(loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_BASE_URL: 'https://serving.example.invalid' }).baseUrl, 'https://serving.example.invalid');
  for (const url of [undefined, 'http://serving.example.invalid', 'http://127.0.0.1:8081/v1', 'https://user:pass@serving.example.invalid', 'https://serving.example.invalid?key=x']) {
    assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_BASE_URL: url }), /SIMPLE_CHAT_BASE_URL/);
  }
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_API_KEY: undefined }), /Set SIMPLE_CHAT_API_KEY to the gateway key/);
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_API_KEY: ' ' }), /SIMPLE_CHAT_API_KEY/);
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_MODEL: undefined }), /Set SIMPLE_CHAT_MODEL/);
  // One lane, whatever the pool settings of llama-server say.
  const pooled = loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_GPU_SLOTS: '4', SIMPLE_CHAT_GPU_KV_UNIFIED: 'true', SIMPLE_CHAT_POOL_TOKENS: '131072' });
  assert.deepEqual([pooled.slots, pooled.poolTokens], [1, 65536]);
  // Our own card is not a hosted API: the bot and the agent interface need no consent to send stories there.
  const bot = { ...serving, TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1' };
  assert.equal(loadConfig(nowhere, bot).gpu, undefined);
  assert.equal(loadAgentConfig(nowhere, serving).provider, 'simple-serving');
  // simple-serving runs its own card, so a Vast instance beside it stops the start. The key alone does not: npm run gpu:rent
  // rents the picture card with it.
  const vast = { SIMPLE_CHAT_VAST_INSTANCE_ID: '1', SIMPLE_CHAT_VAST_API_KEY: 'synthetic-key', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:8080' };
  assert.throws(() => loadConfig(nowhere, { ...bot, ...vast }), /simple-serving runs its own card, not the bot: unset SIMPLE_CHAT_VAST_INSTANCE_ID$/);
  assert.throws(() => gpuConfig(vast, 'simple-serving'), /simple-serving runs its own card, not the bot: unset SIMPLE_CHAT_VAST_INSTANCE_ID$/);
  assert.equal(gpuConfig({ SIMPLE_CHAT_VAST_API_KEY: 'synthetic-key' }, 'simple-serving'), undefined);
  assert.equal(gpuConfig(vast, 'llama-cpp')!.instanceId, '1');
});

test('the configured provider is this adapter, without llama-server\'s batches of samples', () => {
  const provider = createModel({ ...loadModelConfig(nowhere, serving), dbPath: '/nonexistent-simple-chat-config/bot.sqlite' });
  assert.deepEqual(Object.keys(provider).sort(), ['check', 'countInput', 'generate']);
});
