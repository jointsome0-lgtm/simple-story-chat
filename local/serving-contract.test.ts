import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { createServing } from './serving.ts';
import type { ModelError } from './model-error.ts';
import type { ChatMessage, Controls, GenerationResult, ModelRequest } from './model.ts';

// The shared cases of simple-serving's contract v1, pinned in local/serving-contract/ (pin.json says from where). The
// gateway's tests play each step's engine and check the gateway's response; these play that response from a fake
// gateway over HTTP and check what the bot makes of it (contract/README.md there, "Who runs what").
type Json = { readonly [field: string]: unknown };
type Step = {
  name?: string; only?: string;
  request: { base: string; method: string; path: string; headers?: { [name: string]: string }; body_patch?: Json };
  response: { status: number; error?: string; json?: unknown; chunks?: Json[]; done?: boolean; error_event?: string };
  result?: { text?: string; reasoning?: string; finish_reason?: string; usage?: { input: number; output: number; cached: number | null };
    input_tokens?: number; model?: string; context_tokens?: number; status?: string; error?: string };
};
type Cases = { contract: string; service: { alias: string; context_tokens: number };
  defaults: { chat_body: Json & { messages: { role: string; content: string }[]; max_tokens: number } };
  cases: { name: string; steps: Step[] }[] };

const directory = new URL('./serving-contract/', import.meta.url);
const raw = readFileSync(new URL('cases-v1.json', directory));
const pin = JSON.parse(readFileSync(new URL('pin.json', directory), 'utf8')) as { [field: string]: unknown };
const cases = JSON.parse(raw.toString('utf8')) as Cases;
const alias = cases.service.alias;
const KEY = 'test-key-bot';
const MEASURED = { wait_ms: 2, first_token_ms: 40, total_ms: 90 };
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

test('the pinned cases are the file the pin names, byte for byte', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), pin.sha256);
  assert.equal(pin.contract, '1');
  assert.equal(cases.contract, pin.contract);
  assert.equal(pin.repository, 'jointsome0-lgtm/simple-serving');
  assert.equal(pin.path, 'contract/cases-v1.json');
  assert.match(String(pin.commit), /^[0-9a-f]{40}$/);
});

// The bot's code for each of the contract's, written out here apart from the adapter's own table (local/serving.ts),
// so that a change to either shows. The control codes come only from routes the bot does not call yet.
const BOT_CODES: { readonly [code: string]: string } = {
  unauthorized: 'unauthorized', class_not_allowed: 'unauthorized', scope_not_allowed: 'unauthorized', forbidden: 'unauthorized',
  context_limit: 'context_limit', queue_full: 'rate_limited', timeout: 'timeout', not_found: 'unsupported_server',
  starting: 'model_unavailable', draining: 'model_unavailable', drained: 'model_unavailable', engine_unavailable: 'model_unavailable',
  invalid_request: 'provider_failed', unsupported_field: 'provider_failed', limit_exceeded: 'provider_failed',
  body_too_large: 'provider_failed', stale_boot: 'provider_failed', stale_generation: 'provider_failed',
};

// Contract section 4: the fields a body may have and the values each may take. Anything else is refused.
const number = (value: unknown, min: number, max: number, above = false) =>
  typeof value === 'number' && Number.isFinite(value) && (above ? value > min : value >= min) && value <= max;
const integer = (value: unknown, min: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const keys = (value: unknown, ...names: string[]) => isObject(value) && isDeepStrictEqual(Object.keys(value).sort(), names.sort());
const FIELDS: { readonly [field: string]: (value: unknown) => boolean } = {
  model: value => value === alias,
  // The bot merges neighbouring messages of one role (local/llama.ts `messagesFor`), so no two neighbours share one.
  messages: value => Array.isArray(value) && value.length > 0 && value.every((message, index) => keys(message, 'role', 'content')
    && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string'
    && (index === 0 || message.role !== value[index - 1].role)),
  max_tokens: value => integer(value, 1),
  stream: value => value === true,
  stream_options: value => keys(value, 'include_usage') && (value as Json).include_usage === true,
  temperature: value => number(value, 0, 2),
  top_p: value => number(value, 0, 1, true),
  top_k: value => integer(value, 1),
  min_p: value => number(value, 0, 1),
  repetition_penalty: value => number(value, 0, 2, true),
  seed: value => integer(value, Number.MIN_SAFE_INTEGER),
  response_format: value => keys(value, 'type', 'json_schema') && (value as Json).type === 'json_schema'
    && keys((value as Json).json_schema, 'name', 'strict', 'schema') && typeof ((value as Json).json_schema as Json).name === 'string'
    && typeof ((value as Json).json_schema as Json).strict === 'boolean' && isObject(((value as Json).json_schema as Json).schema),
  chat_template_kwargs: value => keys(value, 'enable_thinking') && typeof (value as Json).enable_thinking === 'boolean',
};
const REQUIRED = ['model', 'messages', 'max_tokens', 'stream', 'stream_options'];

type Call = 'generate' | 'count' | 'check';
// The bot's call that meets a step's route. A route the bot has no call for is still run, since the cases leave out
// only what a client cannot meet at all: its answer goes to the bot's nearest call, and what the bot makes of that
// answer is compared.
function callOf({ method, path }: Step['request']): Call {
  if (path === '/v1/chat/completions/input_tokens') return 'count';
  if (path === '/v1/chat/completions') return 'generate';
  if (path === '/v1/models' || path === '/v1/state') return 'check';
  return method === 'GET' ? 'check' : 'generate';
}
// The request whose answer is the step's response: the check reads the state first.
const ownRoute = (call: Call, { path }: Step['request']) => call === 'generate' ? 'POST /v1/chat/completions'
  : call === 'count' ? 'POST /v1/chat/completions/input_tokens' : path === '/v1/models' ? 'GET /v1/models' : 'GET /v1/state';
// Whose call the step's headers describe. A reader's opaque part stands in for the reader, whom the bot then names by a
// scope of its own; a reader without a reader scope is a person's call that names nobody.
function controlsOf(headers: Step['request']['headers'] = {}): Controls {
  const scope = headers['X-Simple-Serving-Scope'];
  if (headers['X-Simple-Serving-Class'] === 'reader') {
    return { priority: 'foreground', holder: scope?.startsWith('reader.') ? scope.slice('reader.'.length) : undefined };
  }
  return headers['X-Simple-Serving-Class'] === 'agent' ? { priority: 'agent' } : {};
}
// The bot's request for a step, and the body it must send when the step's body is one the bot can build at all: the
// default body with another `max_tokens`, or with a memory request's schema. Every other body (unknown fields, wrong
// types, raw bytes) is the gateway's to refuse, and the bot sends its own ordinary one in its place. Sent on an
// estimate far below any limit, a generation is one exchange, as the step is.
function requestOf({ body_patch: patch }: Step['request']): { request: ModelRequest; body: Json | null } {
  const [system, ...messages] = cases.defaults.chat_body.messages;
  const request: ModelRequest = { system: system.content, messages: messages as ChatMessage[],
    maxOutputTokens: cases.defaults.chat_body.max_tokens, estimatedInputTokens: 1, trustEstimate: true };
  if (!patch) return { request, body: null };
  const { max_tokens: maxTokens, temperature, response_format: format, ...rest } = patch;
  let exact = Object.keys(rest).length === 0;
  if (maxTokens !== undefined) {
    if (integer(maxTokens, 1)) request.maxOutputTokens = maxTokens as number;
    else exact = false;
  }
  if (format !== undefined || temperature !== undefined) {
    const schema = isObject(format) && isObject(format.json_schema) ? format.json_schema.schema : undefined;
    if (temperature === 0.2 && isObject(schema)
        && isDeepStrictEqual(format, { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } })) {
      request.purpose = 'memory';
      request.outputSchema = schema;
    } else exact = false;
  }
  return { request, body: exact ? { ...cases.defaults.chat_body, ...patch } : null };
}
// The fake's concrete values for the placeholders of an expected answer.
function fill(value: unknown): unknown {
  if (value === 'present') return 'synthetic-present';
  if (value === 'measurements') return MEASURED;
  if (Array.isArray(value)) return value.map(fill);
  return isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)])) : value;
}
const READY = { contract: '1', boot_id: 'synthetic-boot', status: 'ready', model: alias, context_tokens: cases.service.context_tokens, drain_generation: 0 };
const MODELS = { object: 'list', data: [{ id: alias, object: 'model', max_model_len: cases.service.context_tokens }] };

// The contract promises a client no split of the text (contract/README.md there, "response"): the bot must make the
// same of a stream however its text is cut into chunks and however its bytes arrive. So each streamed step runs as the
// case cuts it, with every piece of text cut into single characters, with neighbouring text joined, and a byte at a time.
type Split = 'case' | 'characters' | 'joined' | 'bytes';
const SPLITS: readonly Split[] = ['case', 'characters', 'joined', 'bytes'];
// The one choice of a chunk, with its delta.
const choiceOf = (chunk: Json | undefined) => chunk && Array.isArray(chunk.choices) && chunk.choices.length === 1
  && isObject(chunk.choices[0]) && isObject(chunk.choices[0].delta) ? chunk.choices[0] as Json & { delta: Json } : undefined;
function resplit(chunks: Json[], split: Split): Json[] {
  if (split === 'characters') return chunks.flatMap(chunk => {
    const choice = choiceOf(chunk);
    const field = choice && ['content', 'reasoning_content'].find(name => typeof choice.delta[name] === 'string');
    if (!choice || !field || Object.keys(choice.delta).some(name => name !== field && name !== 'role')) return [chunk];
    const { [field]: text, ...rest } = choice.delta;
    const { finish_reason: finish, ...open } = choice;
    const pieces = [...text as string];
    if (pieces.length < 2) return [chunk];
    // A role goes with the first piece, a finish with the last.
    return pieces.map((piece, index) => ({ ...chunk, choices: [{ ...open, delta: { ...index ? {} : rest, [field]: piece },
      ...index === pieces.length - 1 && finish != null ? { finish_reason: finish } : {} }] }));
  });
  if (split !== 'joined') return chunks;
  // Plain text, or none, joins the plain text before it, unless that has finished; a finish comes along.
  const plain = (delta: Json) => Object.keys(delta).every(name => name === 'content' && typeof delta.content === 'string');
  const joined: Json[] = [];
  for (const chunk of chunks) {
    const last = joined.at(-1);
    const [into, from] = [choiceOf(last), choiceOf(chunk)];
    if (!last || !into || !from || into.finish_reason != null || !plain(into.delta) || !plain(from.delta)) {
      joined.push(chunk);
      continue;
    }
    const content = `${into.delta.content ?? ''}${from.delta.content ?? ''}`;
    joined[joined.length - 1] = { ...last, choices: [{ ...into, delta: content ? { content } : {},
      ...from.finish_reason != null ? { finish_reason: from.finish_reason } : {} }] };
  }
  return joined;
}

type Running = { step: Step; call: Call; controls: Controls; body: Json | null; split: Split; seen: string[]; problems: string[];
  // Within a case: the scope the bot sent for each reader of the case.
  scopes: Map<string, string> };

// What the bot sent that the contract or the bot's own rules forbid. The fake answers regardless: the cases decide
// the answer, and these are reported with the step.
function problemsOf({ call, controls, body: expected, scopes }: Running, incoming: IncomingMessage, sent: Buffer) {
  const found: string[] = [];
  const header = (name: string) => incoming.headers[name];
  if (header('authorization') !== `Bearer ${KEY}`) found.push('the key');
  const extra = Object.keys(incoming.headers).filter(name => name.startsWith('x-') && !name.startsWith('x-simple-serving-'));
  if (extra.length) found.push(`headers ${extra.join(', ')}`);
  if (call === 'check') {
    if (incoming.method !== 'GET' || sent.length || header('x-simple-serving-class') || header('x-simple-serving-scope')) found.push('a check that is not a plain GET');
    return found;
  }
  if (header('content-type') !== 'application/json') found.push('the content type');
  const kind = controls.priority === 'foreground' ? 'reader' : controls.priority === 'agent' ? 'agent' : 'internal';
  if (header('x-simple-serving-class') !== kind) found.push('the class');
  const scope = String(header('x-simple-serving-scope'));
  if (kind !== 'reader' && scope !== kind) found.push('the scope');
  if (kind === 'reader') {
    const holder = controls.holder;
    // The bot refuses such a call before it is sent.
    if (holder === undefined) found.push('a reader\'s call that names nobody');
    if (!/^reader\.[A-Za-z0-9_-]{8,64}$/.test(scope) || (holder && scope.includes(holder))) found.push('the reader scope');
    // One reader keeps one scope; two readers never share one.
    const known = holder === undefined ? undefined : scopes.get(holder);
    if (known !== undefined && known !== scope) found.push('another scope for the same reader');
    if (known === undefined && [...scopes.values()].includes(scope)) found.push('one scope for two readers');
    if (holder !== undefined) scopes.set(holder, scope);
  }
  let body: unknown;
  try { body = JSON.parse(sent.toString('utf8')); } catch { return [...found, 'a body that is not JSON']; }
  if (!isObject(body)) return [...found, 'a body that is not an object'];
  for (const field of REQUIRED) if (!(field in body)) found.push(`no ${field}`);
  for (const [field, value] of Object.entries(body)) if (!Object.hasOwn(FIELDS, field) || !FIELDS[field](value)) found.push(`the field ${field}`);
  if (expected) for (const [field, value] of Object.entries(expected)) if (!isDeepStrictEqual(body[field], value)) found.push(`${field} unlike the case`);
  return found;
}

function send(outgoing: ServerResponse, status: number, value: unknown) {
  outgoing.writeHead(status, { 'Content-Type': 'application/json' });
  outgoing.end(JSON.stringify(value));
}
// The step's response as the gateway sends it: an error body, a JSON body, or a stream whose every chunk names the
// model, ending in `[DONE]` or in the error event, its text cut as `split` says.
async function respond(outgoing: ServerResponse, { status, error, json, chunks = [], done, error_event: errorEvent }: Step['response'], split: Split) {
  if (error !== undefined) return send(outgoing, status, { error: { code: error } });
  if (json !== undefined) return send(outgoing, status, fill(json));
  outgoing.writeHead(status, { 'Content-Type': 'text/event-stream' });
  const events = resplit(chunks.map(chunk => fill(chunk) as Json), split)
    .map(chunk => `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: alias, ...chunk })}\n\n`);
  if (done) events.push('data: [DONE]\n\n');
  else if (errorEvent !== undefined) events.push(`data: ${JSON.stringify({ error: { code: errorEvent } })}\n\n`);
  const bytes = Buffer.from(events.join(''));
  if (split !== 'bytes') return outgoing.end(bytes);
  for (let at = 0; at < bytes.length; at++) {
    outgoing.write(bytes.subarray(at, at + 1));
    await new Promise(resolve => setImmediate(resolve));
  }
  outgoing.end();
}

test('every public step of the pinned cases gives the bot the result the case expects', async t => {
  let running: Running | undefined;
  const server = createServer((incoming, outgoing) => {
    const parts: Buffer[] = [];
    incoming.on('data', (part: Buffer) => parts.push(part));
    incoming.on('end', () => {
      const route = `${incoming.method} ${incoming.url}`;
      running!.seen.push(route);
      running!.problems.push(...problemsOf(running!, incoming, Buffer.concat(parts)));
      if (route === ownRoute(running!.call, running!.step.request)) void respond(outgoing, running!.step.response, running!.split);
      else if (route === 'GET /v1/state') send(outgoing, 200, READY);
      else if (route === 'GET /v1/models') send(outgoing, 200, MODELS);
      else { running!.problems.push(`a call of ${route}`); send(outgoing, 500, {}); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const provider = createServing({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: alias,
    contextTokens: cases.service.context_tokens, apiKey: KEY, timeoutMs: 10000 });

  const counted = { run: 0, gateway: 0, control: 0, unnamed: 0, resplit: 0 };
  for (const { name, steps } of cases.cases) {
    const scopes = new Map<string, string>();
    for (const [index, step] of steps.entries()) {
      const label = `${name} #${index + 1}${step.name ? ` (${step.name})` : ''}`;
      // The two kinds of steps a client skips (contract/README.md there): the gateway's own, and those on the control
      // listener, which the bot does not call yet.
      if (step.only === 'gateway') { counted.gateway++; continue; }
      if (step.request.base === 'control') { counted.control++; continue; }
      assert.equal(step.request.base, 'public', label);
      assert.equal(step.only, undefined, label);
      const result = step.result!;
      // Every part of an expected result is compared; one this runner does not know fails rather than pass unread.
      assert.deepEqual(Object.keys(result).filter(key => !['text', 'reasoning', 'finish_reason', 'usage', 'input_tokens', 'model',
        'context_tokens', 'status', 'error'].includes(key)), [], label);
      const call = callOf(step.request);
      const { request, body } = requestOf(step.request);
      const controls = controlsOf(step.request.headers);
      const run = async (split: Split): Promise<{ value?: unknown; failure?: ModelError }> => {
        running = { step, call, controls, body, split, seen: [], problems: [], scopes };
        try {
          return { value: call === 'generate' ? await provider.generate(request, controls)
            : call === 'count' ? await provider.countInput(request, controls) : await provider.check() };
        } catch (error) { return { failure: error as ModelError }; }
      };
      // A person's call always names its reader (local/serving.ts `workOf`), so a reader step without a reader scope is
      // a call the bot does not make: it fails on its own, and no request reaches the gateway, whatever the step's
      // answer would have been.
      if (call !== 'check' && controls.priority === 'foreground' && controls.holder === undefined) {
        const { failure } = await run('case');
        assert.deepEqual([failure?.code, failure?.servingCode, running!.seen, running!.problems], ['unnamed_reader', undefined, [], []], label);
        counted.run++;
        counted.unnamed++;
        continue;
      }
      for (const split of call === 'generate' && step.response.chunks ? SPLITS : ['case'] as const) {
        const where = split === 'case' ? label : `${label}, split ${split}`;
        const { value, failure } = await run(split);
        if (split !== 'case') counted.resplit++;
        assert.deepEqual(running!.problems, [], where);
        assert.deepEqual(running!.seen, call === 'generate' ? ['POST /v1/chat/completions'] : call === 'count' ? ['POST /v1/chat/completions/input_tokens']
          : ownRoute(call, step.request) === 'GET /v1/models' || result.error === undefined ? ['GET /v1/state', 'GET /v1/models'] : ['GET /v1/state'], where);
        if (result.error !== undefined) {
          assert.ok(failure, `${where}: no failure`);
          assert.ok(Object.hasOwn(BOT_CODES, result.error), where);
          assert.equal(failure.code, BOT_CODES[result.error], where);
          // The gateway's own code goes to the log beside the bot's; the status tells a refusal from an error event.
          assert.equal(failure.servingCode, result.error, where);
          assert.equal(failure.httpStatus, step.response.status, where);
          continue;
        }
        assert.equal(failure, undefined, `${where}: ${failure?.code}`);
        if (result.text !== undefined) {
          const { text, finishReason, usage, timings } = value as GenerationResult;
          assert.equal(text, result.text, where);
          assert.equal(finishReason, result.finish_reason, where);
          assert.deepEqual([usage?.inputTokens, usage?.outputTokens, usage?.cachedInputTokens],
            [result.usage!.input, result.usage!.output, result.usage!.cached], where);
          // The bot keeps no reasoning, only how long it was.
          assert.equal(usage?.reasoningCharacters, (result.reasoning ?? '').length, where);
          assert.deepEqual(timings, { servingWaitMs: MEASURED.wait_ms, servingFirstTokenMs: MEASURED.first_token_ms,
            servingTotalMs: MEASURED.total_ms, ...(result.usage!.cached === null ? {} : { cacheTokens: result.usage!.cached }) }, where);
        }
        if (result.input_tokens !== undefined) assert.equal(value, result.input_tokens, where);
        if (result.model !== undefined) assert.deepEqual(value, { model: result.model, contextTokens: result.context_tokens }, where);
        // The check passes only on a service that is ready.
        if (result.status !== undefined) assert.equal(result.status, 'ready', where);
      }
      counted.run++;
    }
  }
  // A client counts the steps it skips, so that none is skipped by accident; beside them, the reader steps that fail
  // in the bot before any request and the streams it read cut otherwise. A new copy of the cases changes these.
  assert.deepEqual(counted, { run: 56, gateway: 4, control: 14, unnamed: 3, resplit: 57 });
});
