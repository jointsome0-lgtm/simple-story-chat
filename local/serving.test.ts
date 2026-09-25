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
type Serving = ReturnType<typeof createServing>;

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
const whose = (sent: Sent) => [`${sent.method} ${sent.path}`, sent.headers.get('x-simple-serving-class'), sent.headers.get('x-simple-serving-scope')];
const routes = (calls: Sent[]) => calls.map(call => `${call.method} ${call.path}`);
// The error a call ends in. Tests compare all of its fields, so that nothing else, a body or a text, rides along.
const failure = (call: Promise<unknown>) => call.then(() => assert.fail('the call must fail'), (error: ModelError) => error);
const [COUNT, GENERATE] = ['POST /v1/chat/completions/input_tokens', 'POST /v1/chat/completions'];
const reading = { priority: 'foreground', holder: 'synthetic-reader' } as const;

test('every call says whose it is: a reader with a scope of their own, the agent, or internal work', async t => {
  const r = request(), scope = readerScope('synthetic-reader');
  // One body for the count and the generation, of the contract's fields, with neighbouring roles merged. A memory
  // request's schema goes as it is, lengths included: the gateway passes it to the engine unread (contract section 4).
  const body = { model: 'test-model', messages: [{ role: 'system', content: r.system }, { role: 'user', content: 'Синтетический сид.\n\nПамять.' },
    ...r.messages.slice(2)], max_tokens: 4096, stream: true, stream_options: { include_usage: true }, temperature: 0.8,
    top_p: 0.95, top_k: 64, min_p: 0, repetition_penalty: 1, chat_template_kwargs: { enable_thinking: false } };
  const schema = { type: 'object', properties: { facts: { type: 'array', items: { type: 'string', maxLength: 200 } } }, required: ['facts'], additionalProperties: false };
  const memory: ModelRequest = { ...request(), outputSchema: schema, purpose: 'memory' };
  const own = (...routes: string[]) => routes.map(route => [route, 'internal', 'internal']);
  const calls: [string, Partial<typeof config>, (provider: Serving) => Promise<unknown>, (string | null)[][], object][] = [
    // A pool's slot means nothing to the gateway and is never sent.
    ['a reader\'s count and scene', {}, async p => { assert.equal(await p.countInput(r, reading), 120); await p.generate(r, { ...reading, slot: 2 }); },
      [[COUNT, 'reader', scope], [GENERATE, 'reader', scope]], body],
    ['the agent\'s', {}, p => p.generate(trusted(), { priority: 'agent', holder: 'synthetic-reader' }), [[GENERATE, 'agent', 'agent']], body],
    ['our own', {}, p => p.generate(trusted(), { priority: 'background' }), own(GENERATE), body],
    // Whose a call is comes from the controls alone, which the scheduler sets, never from a request, which a socket
    // client writes (local/background.ts): a call that did not come through the scheduler is our own work.
    ['a request that names a reader', {}, async p => { await p.generate({ ...trusted(), ...reading } as ModelRequest);
      await p.countInput({ ...request(), ...reading } as ModelRequest); }, own(GENERATE, COUNT), body],
    ['a memory request, which samples cold', {}, async p => { await p.countInput(memory); await p.generate(memory); }, own(COUNT, GENERATE),
      { ...body, temperature: 0.2, response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } } }],
    ['the configured temperature', { temperature: 1.1 }, p => p.generate(trusted()), own(GENERATE), { ...body, temperature: 1.1 }],
    ['the default temperature', { temperature: undefined }, p => p.generate(trusted()), own(GENERATE), body],
  ];
  for (const [label, options, act, expected, sent] of calls) {
    const f = fixture(undefined, options);
    await act(f.provider);
    assert.deepEqual(f.calls.map(whose), expected, label);
    for (const call of f.calls) assert.deepEqual([call.headers.get('authorization'), call.headers.get('content-type'), call.options.redirect, call.body],
      ['Bearer synthetic-key', 'application/json', 'error', sent], label);
  }
  assert.deepEqual(workOf(), { class: 'internal', scope: 'internal' });
  // A reader's scope is stable in the process, differs between readers and never shows the holder. It comes from a
  // secret of this process: another process gives the same holder another scope.
  const module = JSON.stringify(new URL('./serving.ts', import.meta.url).href);
  const elsewhere = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { readerScope } from ${module}; process.stdout.write(readerScope('synthetic-reader'))`], { encoding: 'utf8' });
  const scopes: [string, string, string][] = [...['123456789', '987654321', 'synthetic-reader'].map((holder): [string, string, string] =>
    [holder, holder, readerScope(holder)]), ['another process', 'synthetic-reader', elsewhere()], ['a third process', 'synthetic-reader', elsewhere()]];
  for (const [label, holder, value] of scopes) {
    // The contract allows 8 to 64 characters of A-Z, a-z, 0-9, _ and - after `reader.`.
    assert.match(value, /^reader\.[A-Za-z0-9_-]{22}$/, label);
    assert.equal(value.includes(holder), false, label);
    if (label === holder) assert.deepEqual(workOf({ priority: 'foreground', holder }), { class: 'reader', scope: value }, label);
  }
  assert.equal(new Set(scopes.map(([, , value]) => value)).size, scopes.length);
  // A person's call that names no reader is refused before anything is sent, the check included: whatever scope it
  // were given, it would share another reader's cache or never meet its own.
  const f = fixture(undefined, { seeCheck: true });
  const scheduler = createScheduler(f.provider, { quietMs: 0, pollMs: 100000 });
  t.after(() => scheduler.close());
  const nobody = scheduler.foreground.openTurn();
  const unnamed: [string, () => unknown, string?][] = [...[undefined, ''].flatMap((holder): [string, () => unknown, string?][] => [
    [`the reader ${JSON.stringify(holder)}`, () => workOf({ priority: 'foreground', holder })],
    [`a scene for the reader ${JSON.stringify(holder)}`, () => f.provider.generate(trusted(), { priority: 'foreground', holder }), 'generate'],
    [`a count for the reader ${JSON.stringify(holder)}`, () => f.provider.countInput(request(), { priority: 'foreground', holder }), 'count_input']]),
    // Through the scheduler: a person's call outside a turn, or in a turn that names nobody.
    ['a scheduled scene outside a turn', () => scheduler.foreground.generate(trusted())],
    ['a scheduled count outside a turn', () => scheduler.foreground.countInput!(request())], ['a turn that names nobody', () => nobody.generate(trusted())]];
  for (const [label, call, phase] of unnamed) await assert.rejects(async () => call(), { code: 'unnamed_reader', ...(phase ? { phase } : {}) }, label);
  nobody.end();
  assert.deepEqual(f.calls, []);
});

test('refusals map by their code, keep the status, phase and code, and never carry the body', async () => {
  const table = [[400, 'invalid_request', 'provider_failed'], [400, 'unsupported_field', 'provider_failed'], [400, 'limit_exceeded', 'provider_failed'],
    [400, 'context_limit', 'context_limit'], [401, 'unauthorized', 'unauthorized'], [403, 'class_not_allowed', 'unauthorized'], [403, 'scope_not_allowed', 'unauthorized'],
    [403, 'forbidden', 'unauthorized'], [404, 'not_found', 'unsupported_server'], [409, 'stale_boot', 'provider_failed'], [409, 'stale_generation', 'provider_failed'],
    [413, 'body_too_large', 'provider_failed'], [429, 'queue_full', 'rate_limited'], [500, 'internal_error', 'provider_failed'], [503, 'starting', 'model_unavailable'],
    [503, 'draining', 'model_unavailable'], [503, 'drained', 'model_unavailable'], [503, 'engine_unavailable', 'model_unavailable'], [504, 'timeout', 'timeout']] as const;
  for (const [status, servingCode, code] of table) {
    assert.equal(codeFor(servingCode), code, servingCode);
    const f = fixture(() => json({ error: { code: servingCode, message: 'PRIVATE_RAW_ERROR' } }, status));
    assert.deepEqual({ ...await failure(f.provider.generate(trusted())) }, { code, httpStatus: status, phase: 'generate', servingCode }, servingCode);
    // A gateway does not retry, and neither does the bot.
    assert.equal(f.calls.length, 1, servingCode);
  }
  // The count is refused the same way, in its own phase.
  const counting = createServing(config, { fetch: ready(async () => refusal(429, 'queue_full')) });
  assert.deepEqual({ ...await failure(counting.countInput(request())) }, { code: 'rate_limited', phase: 'count_input', httpStatus: 429, servingCode: 'queue_full' });
  // A code the contract does not list, a body that is not the contract's, and one too large to be an error body.
  for (const [body, servingCode] of [[JSON.stringify({ error: { code: 'PRIVATE_CODE' } }), 'other'], ['PRIVATE_RAW_ERROR', undefined],
    [JSON.stringify({ error: 'PRIVATE_CODE' }), undefined], ['', undefined], [JSON.stringify({ padding: 'x'.repeat(5000), error: { code: 'queue_full' } }), undefined]] as const) {
    const error = await failure(fixture(() => new Response(body, { status: 500 })).provider.generate(trusted()));
    assert.deepEqual({ ...error }, { code: 'provider_failed', httpStatus: 500, phase: 'generate', ...(servingCode ? { servingCode } : {}) }, body.slice(0, 30));
  }
  // A reader's failed call leaves neither the holder nor the scope in its error, which is all a failed call leaves
  // behind: a log row is made from it by safeErrorDetails. The secret stays inside the module.
  for (const respond of [() => refusal(403, 'class_not_allowed'), () => stream([chunk({ content: 'Текст.' }), { error: { code: 'engine_unavailable' } }], { done: false })]) {
    const error = await failure(fixture(respond).provider.generate(trusted(), reading));
    const traces = [JSON.stringify(error), String(error), error.stack ?? '', JSON.stringify(safeErrorDetails(error))].join('\n');
    for (const secret of ['synthetic-reader', readerScope('synthetic-reader').slice('reader.'.length)]) assert.equal(traces.includes(secret), false, error.code);
  }
  assert.deepEqual(Object.keys(await import('./serving.ts')), ['codeFor', 'createServing', 'readerScope', 'workOf']);
  // A call cancelled or out of time closes the request it has in flight: one left open is work to the gateway, whose
  // card does not sleep while it hangs. A check cancelled on the way is made again before the next call sends anything.
  const held: AbortSignal[] = [];
  const waitForAbort = async (_: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    held.push(init.signal!);
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  });
  const sent: string[] = [];
  let [holds, controller] = ['', new AbortController()];
  const provider = createServing(config, { fetch: async (url, init) => {
    sent.push(new URL(url).pathname);
    if (sent.at(-1) !== holds) return ready(async () => answer())(url, init);
    const response = waitForAbort(url, init);
    controller.abort();
    return response;
  } });
  // Cancelled in its check, a call sends no text; the next one checks again, and is cancelled in its stream.
  for (const path of ['/v1/state', '/v1/chat/completions']) {
    [holds, controller] = [path, new AbortController()];
    await assert.rejects(provider.generate(trusted(), { signal: controller.signal }), { code: 'cancelled' }, path);
  }
  assert.deepEqual(sent, ['/v1/state', '/v1/state', '/v1/models', '/v1/chat/completions']);
  const timer = setTimeout(() => {}, 1000); // AbortSignal.timeout does not keep Node alive.
  try {
    await assert.rejects(createServing({ ...config, timeoutMs: 100 }, { fetch: ready(waitForAbort) }).generate(trusted()), { code: 'timeout', phase: 'generate' });
    await assert.rejects(createServing(config, { fetch: waitForAbort }).check({ signal: AbortSignal.timeout(10) }), { code: 'timeout', phase: 'health' });
  } finally { clearTimeout(timer); }
  assert.deepEqual(held.map(signal => signal.aborted), [true, true, true, true]);
});

test('a stream becomes an answer only whole, as the adapter checks it, and within the limits the bot keeps for every server', async () => {
  const text = chunk({ content: 'Текст.' }), stop = chunk({}, 'stop'), end = closing(), started = chunk({ content: 'Начало ' }), [first] = text.choices;
  const capped = chunk({ content: 'Текст.' }, 'length'), finished = chunk({ content: 'Текст.' }, 'stop');
  const choices = (...list: unknown[]) => ({ model: config.model, choices: list });
  type Row = [string, (object | string)[] | (() => Response), string | { [field: string]: unknown }, { split?: boolean; done?: boolean }?];
  const cut = { text: 'Текст.', finishReason: 'length', usage: { inputTokens: 120, outputTokens: 8, cachedInputTokens: null, reasoningCharacters: 0, totalTokens: 128 }, timings: {} };
  const rows: Row[] = [
    ['text, reasoning and usage, a byte at a time', [chunk({ role: 'assistant' }), { ...chunk({ reasoning_content: 'Скрытое рассуждение.' }), usage: null },
      chunk({ content: 'Привет, ' }), chunk({}), choices(), chunk({ content: 'мир 🌊.' }, 'stop'), end],
    // The gateway's own numbers go to fields of their own, never into llama-server's prompt and prediction times.
    { text: 'Привет, мир 🌊.', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 8, cachedInputTokens: 100, reasoningCharacters: 'Скрытое рассуждение.'.length,
      totalTokens: 128 }, timings: { servingWaitMs: 3, servingFirstTokenMs: 420, servingTotalMs: 5100, cacheTokens: 100 } }, { split: true }],
    // Without cached tokens the cache is unknown, not empty. The measurements are all three, in order, or none, and never
    // fail an answer: absent, out of order, not whole milliseconds, not numbers, one missing or not a record.
    ...[undefined, { wait_ms: 3, first_token_ms: 2, total_ms: 1 }, { wait_ms: 3, first_token_ms: 420, total_ms: '5100' }, { wait_ms: -1, first_token_ms: 420, total_ms: 5100 },
      { wait_ms: 3, first_token_ms: 1.5, total_ms: 5100 }, { wait_ms: 3, total_ms: 5100 }, [3, 420, 5100]].map((simple_serving): Row =>
      [`measurements ${JSON.stringify(simple_serving)}`, [capped, closing({ prompt_tokens_details: [100], simple_serving })], cut]),
    // An answer of no tokens at all, from a request that waited for nothing, is still in order.
    ['no tokens', [capped, closing({ completion_tokens: 0, simple_serving: { wait_ms: 0, first_token_ms: 0, total_ms: 0 } })], { ...cut,
      usage: { ...cut.usage, outputTokens: 0, cachedInputTokens: 100, totalTokens: 120 }, timings: { servingWaitMs: 0, servingFirstTokenMs: 0, servingTotalMs: 0, cacheTokens: 100 } }],
    ['another model', [{ ...text, model: 'other-model' }, stop, end], 'unexpected_model'], ['a chunk without a model', [{ choices: text.choices }, stop, end], 'invalid_stream'],
    ['no usage chunk', [text, stop], 'usage_unavailable'], ['usage without prompt tokens', [text, stop, closing({ prompt_tokens: undefined })], 'usage_unavailable'],
    ...[undefined, null, -1, 1.5, '8'].map((value): Row => [`completion tokens of ${value}`, [text, stop, closing({ completion_tokens: value })], 'usage_unavailable']),
    ['usage that is not a record', [text, stop, { ...choices(), usage: [usage] }], 'invalid_stream'], ['usage before the finish', [text, end, stop], 'invalid_stream'],
    ['usage beside a choice', [text, { ...stop, usage }], 'invalid_stream'], ['a second usage chunk', [text, stop, end, end], 'invalid_stream'],
    ['a chunk after the usage chunk', [text, stop, end, chunk({})], 'invalid_stream'], ['two finishes', [text, stop, stop, end], 'invalid_stream'],
    ['an unknown finish', [text, chunk({}, 'tool_calls'), end], 'invalid_stream'], ['no finish', [text], 'incomplete_stream'],
    ['no [DONE]', [text, stop, end], 'incomplete_stream', { done: false }], ['a delta that is not a record', [chunk([]), text, stop, end], 'invalid_stream'],
    ...[['content', chunk({ content: 'Ещё.' })], ['reasoning', chunk({ reasoning_content: 'Ещё.' })], ['a role', chunk({ role: 'assistant' })], ['an empty delta', chunk({})],
      ['a chunk without a choice', choices()]].map(([what, late]): Row => [`${what} after the finish`, [text, stop, late, end], 'invalid_stream']),
    ['a choice that is not a record', [choices([first]), stop, end], 'invalid_stream'], ['two choices', [choices(first, first), stop, end], 'invalid_stream'],
    ['a choice with index 1', [choices({ ...first, index: 1 }), stop, end], 'invalid_stream'], ['content that is not text', [chunk({ content: 5 }), stop, end], 'invalid_stream'],
    ['tool calls', [chunk({ tool_calls: [{ id: 'x' }] }), stop, end], 'unexpected_tools'], ['a line that is not JSON', [text, 'PRIVATE_RAW_TEXT', stop, end], 'invalid_stream'],
    ['an empty answer', [chunk({ content: ' \n' }), stop, end], 'empty_response'], ['an answer that is not a stream', () => json({ choices: [] }), 'invalid_stream'],
    ['bytes that are not UTF-8', () => new Response(new Uint8Array([...new TextEncoder().encode('data: {"model":"test-model","choices":[]}\n\ndata: '), 0xff, 0xfe, 10, 10]),
      { headers: { 'Content-Type': 'text/event-stream' } }), { code: 'provider_failed', transportCode: 'other' }],
    // An error event ends a started stream with the gateway's code: what came before it, a finish included, is not an
    // answer. The status was 200 already: that and the code tell an error event from a refusal before the stream.
    ...[['engine_unavailable', 'model_unavailable'], ['draining', 'model_unavailable'], ['timeout', 'timeout'], ['internal_error', 'provider_failed'],
      ['PRIVATE_CODE', 'provider_failed', 'other']].map(([servingCode, code, logged = servingCode]): Row =>
      [`an error event of ${servingCode}`, [started, stop, { error: { code: servingCode } }], { code, servingCode: logged, httpStatus: 200 }, { done: false }]),
    // An error event without a code of the contract's shape is no code at all, and a list is no record: both still end the stream.
    ...[{ message: 'PRIVATE_RAW_ERROR' }, [{ code: 'draining' }]].map((error): Row =>
      [`an error event of ${JSON.stringify(error)}`, [started, { error }], { code: 'provider_failed', httpStatus: 200 }, { done: false }]),
    ['a text too long', [chunk({ content: 'Ж'.repeat(60_000) }), chunk({ content: 'Ж'.repeat(60_000) }), stop, end], 'output_limit'],
    // Two million bytes of events, reasoning here, whatever they carry.
    ['a stream too large', [...Array.from({ length: 30 }, () => chunk({ reasoning_content: 'ж'.repeat(40_000) })), finished, end], 'output_limit'],
  ];
  for (const [label, items, expected, options] of rows) {
    const parts: string[] = [];
    const generated = fixture(typeof items === 'function' ? items : () => stream(items, options)).provider.generate(request(), { onText: async value => { parts.push(value); } });
    if (typeof expected === 'object' && 'text' in expected) {
      const { text, finishReason, usage, timings } = await generated;
      assert.deepEqual({ text, finishReason, usage, timings }, expected, label);
      assert.equal(parts.join(''), text, label);
    } else assert.deepEqual({ ...await failure(generated) }, { phase: 'generate', ...(typeof expected === 'string' ? { code: expected } : expected) }, label);
  }
  // A trusted estimate goes without a count, and the usage chunk decides: the gateway counted 120 where the estimate said
  // 100, and its count is the usage. Only an estimate that is a count is trusted. A count, asked for or made by generate
  // itself, holds the stream to it. Over the limit, by the estimate before sending or by the gateway's count after, the
  // result does not stand; the gateway's context_limit is taken as it came, nothing is counted again, and the story compacts.
  const r = request(), recounted = () => stream([finished, closing({ prompt_tokens: 121 })]), mismatch = { code: 'unexpected_context', phase: 'generate' };
  const over = { code: 'context_limit', phase: 'generate' }, refused = { ...over, httpStatus: 400, servingCode: 'context_limit' }, limited = { inputLimitTokens: 53999 };
  const counts: [string, Respond | undefined, (provider: Serving) => Promise<unknown>, number | object, string[]][] = [
    ['a trusted estimate', undefined, p => p.generate(trusted()).then(result => result.usage!.inputTokens), 120, [GENERATE]],
    ...[undefined, 0, 99.5].map((estimatedInputTokens): typeof counts[number] => [`an estimate of ${estimatedInputTokens}`, undefined,
      p => p.generate({ ...request(), estimatedInputTokens, trustEstimate: true }).then(result => result.usage!.inputTokens), 120, [COUNT, GENERATE]]),
    ['a count asked for', recounted, async p => { assert.equal(await p.countInput(r), 120); return p.generate(r); }, mismatch, [COUNT, GENERATE]],
    ['a count made by generate', recounted, p => p.generate(request()), mismatch, [COUNT, GENERATE]],
    ['over the limit by the gateway\'s count', () => stream([finished, closing({ prompt_tokens: 54000 })]), p => p.generate(trusted(30000), limited), over, [GENERATE]],
    ['over the limit by the estimate', undefined, p => p.generate(trusted(54000), limited), over, []],
    ['the gateway\'s context_limit on an estimate', () => refusal(400, 'context_limit'), p => p.generate(trusted(30000)), refused, [GENERATE]],
    ['the gateway\'s context_limit after a count', () => refusal(400, 'context_limit'), p => p.generate(request()), refused, [COUNT, GENERATE]],
  ];
  for (const [label, respond, act, expected, sent] of counts) {
    const f = fixture(respond);
    assert.deepEqual(await act(f.provider).catch((error: ModelError) => ({ ...error })), expected, label);
    assert.deepEqual(routes(f.calls), sent, label);
  }
  // A count that is not one.
  for (const value of [{ input_tokens: 0 }, { input_tokens: 'PRIVATE' }, null, [120]]) {
    await assert.rejects(createServing(config, { fetch: ready(async () => json(value)) }).countInput(request()), { code: 'usage_unavailable' }, JSON.stringify(value));
  }
});

test('configuration: the gateway\'s root, its key even over the tunnel, and the name of its model; no call reaches a service its check has not passed', async () => {
  const serving = { SIMPLE_CHAT_PROVIDER: 'simple-serving', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:8081', SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_MODEL: 'synthetic-alias' };
  const nowhere = '/nonexistent-simple-chat-config';
  const c = loadModelConfig(nowhere, serving);
  assert.deepEqual([c.provider, c.baseUrl, c.apiKey, c.model, c.compactAtTokens], ['simple-serving', 'http://127.0.0.1:8081', 'synthetic-key', 'synthetic-alias', 44000]);
  assert.equal(loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_BASE_URL: 'https://serving.example.invalid' }).baseUrl, 'https://serving.example.invalid');
  const roots = [undefined, 'http://serving.example.invalid', 'http://127.0.0.1:8081/v1', 'https://user:pass@serving.example.invalid', 'https://serving.example.invalid?key=x'];
  for (const url of roots) assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_BASE_URL: url }), /SIMPLE_CHAT_BASE_URL/, url);
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_API_KEY: undefined }), /Set SIMPLE_CHAT_API_KEY to the gateway key/);
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_API_KEY: ' ' }), /SIMPLE_CHAT_API_KEY/);
  assert.throws(() => loadModelConfig(nowhere, { ...serving, SIMPLE_CHAT_MODEL: undefined }), /Set SIMPLE_CHAT_MODEL/);
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
  // The provider so configured is this adapter. Its check reads the gateway's state, then its models, and names no
  // class, whoever asks for it: only the key goes with it.
  const [heard, global] = [[] as unknown[], globalThis.fetch];
  globalThis.fetch = async (url, init) => {
    heard.push([init?.method, String(url), init?.body ?? null, [...new Headers(init?.headers)]]);
    return String(url).endsWith('/v1/state') ? json({ ...state, model: 'synthetic-alias' }) : json({ data: [{ id: 'synthetic-alias', max_model_len: 65536 }] });
  };
  try { assert.deepEqual(await createModel({ ...c, dbPath: `${nowhere}/bot.sqlite` }).check!(reading), { model: 'synthetic-alias', contextTokens: 65536 }); }
  finally { globalThis.fetch = global; }
  assert.deepEqual(heard, ['/v1/state', '/v1/models'].map(path => ['GET', `http://127.0.0.1:8081${path}`, null, [['authorization', 'Bearer synthetic-key']]]));
  // The state and the model must agree. Each answer, and how many routes the check read: a service that is not ready,
  // not of this contract or not serving this model is not asked for its models.
  const checked = (stateAnswer: unknown, modelsAnswer: unknown) => fixture(path => path === '/v1/state' ? json(stateAnswer) : json(modelsAnswer), { seeCheck: true });
  type Case = [unknown, unknown, string, number];
  const cases: Case[] = [
    [{ ...state, contract: '1' }, models, 'unsupported_server', 1], [{ ...state, contract: 2 }, models, 'unsupported_server', 1], [[state], models, 'unsupported_server', 1],
    ...['starting', 'draining', 'drained', 'failed'].map((status): Case => [{ ...state, status }, models, 'model_unavailable', 1]),
    [{ ...state, model: 'other-model' }, models, 'unexpected_model', 1], [{ ...state, model: undefined }, models, 'unexpected_model', 1],
    ...[{ data: [{ id: 'other-model', max_model_len: 65536 }] }, { data: null }, [models], { data: [[models.data[1]]] }].map((listed): Case => [state, listed, 'unexpected_model', 2]),
    // The state and the models route give two contexts, or one of them none.
    [{ ...state, context_tokens: 32768 }, models, 'unsupported_server', 2], [{ ...state, context_tokens: undefined }, models, 'unsupported_server', 2],
    [state, { data: [{ id: 'test-model' }] }, 'unsupported_server', 2],
    [{ ...state, context_tokens: 32768 }, { data: [{ id: 'test-model', max_model_len: 32768 }] }, 'context_limit', 2],
  ];
  for (const [stateAnswer, modelsAnswer, code, count] of cases) {
    const f = checked(stateAnswer, modelsAnswer);
    await assert.rejects(f.provider.check(), { code, phase: 'health' }, JSON.stringify([stateAnswer, modelsAnswer]));
    assert.equal(f.calls.length, count, JSON.stringify([stateAnswer, modelsAnswer]));
  }
  await assert.rejects(fixture(() => refusal(401, 'unauthorized'), { seeCheck: true }).provider.check(),
    { code: 'unauthorized', phase: 'health', httpStatus: 401, servingCode: 'unauthorized' });
  await assert.rejects(fixture(() => new Response('PRIVATE_RAW_TEXT'), { seeCheck: true }).provider.check(), { code: 'invalid_response' });
  // At the start (local/main.ts), a service out of reach or not ready lets the bot start; any other answer stops it.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const atStart = [['out of reach', () => { throw refused; }, true], ['starting', () => refusal(503, 'starting'), true],
    ['unauthorized', () => refusal(401, 'unauthorized'), false], ['internal_error', () => refusal(500, 'internal_error'), false],
    ['of another contract', () => json({ ...state, contract: '0' }), false], ['of another model', () => json({ ...state, model: 'other-model' }), false]] as const;
  for (const [label, respond, starts] of atStart) assert.equal(unavailable(await fixture(respond, { seeCheck: true }).provider.check().catch(error => error)), starts, label);
  // Down, then back with another model, then back as configured: the first call after each checks the service again, and
  // the one after a check that passed does not.
  let service: 'down' | 'other' | 'up' = 'down';
  const g = fixture(path => {
    if (service === 'down') throw refused;
    const model = service === 'up' ? 'test-model' : 'other-model';
    return path === '/v1/state' ? json({ ...state, model }) : path === '/v1/models' ? json({ data: [{ id: model, max_model_len: 65536 }] }) : answer();
  }, { seeCheck: true });
  await assert.rejects(g.provider.check(), { code: 'provider_failed', transportCode: 'ECONNREFUSED' });
  await assert.rejects(g.provider.generate(trusted()), { code: 'provider_failed', transportCode: 'ECONNREFUSED' });
  service = 'other';
  await assert.rejects(g.provider.countInput(request()), { code: 'unexpected_model' });
  service = 'up';
  g.calls.length = 0;
  assert.equal((await g.provider.generate(trusted())).text, 'Готово.');
  assert.equal((await g.provider.generate(trusted())).text, 'Готово.');
  assert.deepEqual(routes(g.calls), ['GET /v1/state', 'GET /v1/models', GENERATE, GENERATE]);
});
