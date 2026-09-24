import { createHmac, randomBytes } from 'node:crypto';
import type { ErrorDetails } from './model-error.ts';
import { ModelError, member } from './model-error.ts';
import type { ModelConfig } from './config.ts';
import { modelBaseUrl } from './config.ts';
import type { Controls, GenerateControls, GenerationResult, ModelRequest, Timings } from './model.ts';
import { MAX_BODY, events, messagesFor } from './llama.ts';

// simple-serving: our own gateway in front of vLLM on a rented card, built to contract v2 (docs/contract-v2.md in
// jointsome0-lgtm/simple-serving; the cases both sides test are pinned in local/serving-contract/). Unlike llama-server
// it serves readers, agents, our own probes and outside keys at once, so every request says whose it is, and every
// refusal comes with a code of the contract rather than a bare status.

// Only the fields this provider reads; tests pass a partial configuration.
export type ServingConfig = Pick<ModelConfig, 'baseUrl' | 'model' | 'contextTokens' | 'apiKey'> & Partial<Pick<ModelConfig, 'temperature' | 'timeoutMs'>>;
// Thrown values are not checked; these fields are read if present and filtered by ModelError.
type Thrown = { phase?: unknown; httpStatus?: unknown; servingCode?: unknown; code?: unknown; cause?: { code?: unknown } | null } | null | undefined;
type Options = { fetch?: (url: string, init: RequestInit) => Promise<Response> };

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
// A JSON record: an array is none, wherever the contract asks for one.
const isObject = (value: unknown): value is { readonly [field: string]: unknown } =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// A reader's cache scope tells the gateway which reader a request is without saying who: an HMAC of the holder under
// a secret this process makes once and never stores or logs, cut to 22 base64url characters (the contract allows 8 to
// 64). One reader keeps one scope, and so one cached story, until the bot restarts.
const SCOPE_SECRET = randomBytes(32);
export const readerScope = (holder: string) =>
  `reader.${createHmac('sha256', SCOPE_SECRET).update(holder).digest('base64url').slice(0, 22)}`;
// The class and cache scope of a call (contract section 2), from the queue it came through (local/model.ts Controls),
// which the scheduler sets, or the agent interface for its direct calls. A person's turns are a reader's, with a cache
// of their own; the agent interface's turns share one scope; probes, eval and every other call are internal.
export function workOf({ priority, holder }: Pick<Controls, 'priority' | 'holder'> = {}) {
  // A person's call names its reader: the bot's own turns always do (local/turn.ts, bot.ts, prepare.ts, picture.ts).
  // One that does not is a bug, refused before anything is sent: in any scope it could be given, it would either
  // share another reader's cache or never meet its own.
  if (priority === 'foreground') {
    if (typeof holder !== 'string' || !holder) throw new ModelError('unnamed_reader');
    return { class: 'reader', scope: readerScope(holder) };
  }
  if (priority === 'agent') return { class: 'agent', scope: 'agent' };
  return { class: 'internal', scope: 'internal' };
}
type Work = ReturnType<typeof workOf>;

// The bot's code for each of the gateway's (contract section 9). A refused key, class or scope is a configuration
// the owner must fix; a full queue is a wait; a service that is starting, stopping or has lost its engine is not
// serving. The gateway counts the context itself, so its `context_limit` compacts as llama-server's recount did. Any
// other code, and a body without one, is a request the bot built wrong, a gateway it does not understand or, with
// `internal_error`, a failure in the gateway itself.
const CODES: { readonly [code: string]: string } = { unauthorized: 'unauthorized', class_not_allowed: 'unauthorized',
  scope_not_allowed: 'unauthorized', forbidden: 'unauthorized', context_limit: 'context_limit', queue_full: 'rate_limited',
  starting: 'model_unavailable', draining: 'model_unavailable', drained: 'model_unavailable',
  engine_unavailable: 'model_unavailable', timeout: 'timeout', not_found: 'unsupported_server' };
export const codeFor = (servingCode: unknown) =>
  typeof servingCode === 'string' && Object.hasOwn(CODES, servingCode) ? CODES[servingCode] : 'provider_failed';
// The gateway's own measurements in `usage.simple_serving` (contract section 11), for the log only. All three count
// from the moment it took the request, so they are kept together and in order, or not at all; they never fail an
// answer.
function timingsOf(usage: { readonly [field: string]: unknown }): Timings {
  const timings: Timings = {};
  const measured = isObject(usage.simple_serving) ? usage.simple_serving : {};
  const [wait, firstToken, total] = [count(measured.wait_ms), count(measured.first_token_ms), count(measured.total_ms)];
  if (wait !== null && firstToken !== null && total !== null && wait <= firstToken && firstToken <= total) {
    Object.assign(timings, { servingWaitMs: wait, servingFirstTokenMs: firstToken, servingTotalMs: total });
  }
  // What the engine found cached of the prompt means what llama-server's `cache_n` does. Absent is unknown, not zero.
  const cached = isObject(usage.prompt_tokens_details) ? count(usage.prompt_tokens_details.cached_tokens) : null;
  if (cached !== null) timings.cacheTokens = cached;
  return timings;
}

export function createServing(config: ServingConfig, { fetch: fetcher = globalThis.fetch }: Options = {}) {
  const origin = modelBaseUrl(config.baseUrl);
  const prepared = new WeakMap<ModelRequest, { body: ReturnType<typeof bodyFor>; inputTokens: number }>();
  // Contract section 4: llama-server's body without its own fields (`id_slot`, `cache_prompt`, `reasoning_*`), with
  // vLLM's name for the repetition penalty and the schema in OpenAI's form. The gateway refuses any other field.
  const bodyFor = (request: ModelRequest) => ({ model: config.model,
    messages: messagesFor(request),
    max_tokens: request.maxOutputTokens, stream: true, stream_options: { include_usage: true },
    temperature: request.purpose === 'memory' ? 0.2 : config.temperature ?? 0.8,
    top_p: 0.95, top_k: 64, min_p: 0, repetition_penalty: 1,
    chat_template_kwargs: { enable_thinking: false },
    ...(request.outputSchema ? { response_format: { type: 'json_schema',
      json_schema: { name: 'reply', strict: true, schema: request.outputSchema } } } : {}),
  });

  async function operation<T>(signal: AbortSignal | undefined, phase: NonNullable<ErrorDetails['phase']>, fn: (signal: AbortSignal) => Promise<T>) {
    const timer = AbortSignal.timeout(config.timeoutMs ?? 300000);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    try {
      combined.throwIfAborted();
      return await fn(combined);
    } catch (error) {
      const thrown = error as Thrown;
      const details = { phase: thrown?.phase ?? phase, httpStatus: thrown?.httpStatus, servingCode: thrown?.servingCode,
        transportCode: error instanceof ModelError ? error.transportCode : thrown?.cause?.code ?? thrown?.code };
      // As in local/llama.ts: a caller's own AbortSignal.timeout is a timeout, the scheduler's abort its own reason.
      if (signal?.aborted) throw new ModelError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', details);
      if (timer.aborted) throw new ModelError('timeout', details);
      throw new ModelError(error instanceof ModelError ? error.code : 'provider_failed', details);
    }
  }

  // Every request carries the key, on loopback too; a generation or a count also says whose it is.
  async function http(path: string, body: object | null, signal: AbortSignal, work?: Work) {
    const phase = path.endsWith('/input_tokens') ? 'count_input' : path === '/v1/chat/completions' ? 'generate' : 'health';
    let response: Response;
    try {
      response = await fetcher(origin + path, { method: body ? 'POST' : 'GET', signal, redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(work ? { 'X-Simple-Serving-Class': work.class, 'X-Simple-Serving-Scope': work.scope } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) { throw new ModelError('provider_failed', { phase, transportCode: (error as Thrown)?.cause?.code ?? (error as Thrown)?.code }); }
    if (!response.ok) {
      const servingCode = await refusal(response);
      throw new ModelError(codeFor(servingCode), { phase, httpStatus: response.status, servingCode });
    }
    return response;
  }

  // The code of a refusal, `{"error": {"code": ...}}`, from at most 4096 bytes of its body. Nothing else of the body
  // is kept, and a body of any other shape gives no code.
  async function refusal(response: Response) {
    if (!response.body) return undefined;
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 4096) return undefined;
        chunks.push(Buffer.from(chunk));
      }
      const error = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: unknown } | null)?.error;
      return isObject(error) && typeof error.code === 'string' ? error.code : undefined;
    } catch { return undefined; }
  }

  async function json(path: string, body: object | null, signal: AbortSignal, work?: Work): Promise<unknown> {
    const response = await http(path, body, signal, work);
    let bytes = 0;
    const chunks: Buffer[] = [];
    // A missing body is not iterable and fails as provider_failed.
    for await (const chunk of response.body!) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY) throw new ModelError('invalid_response');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ModelError('invalid_response'); }
  }

  // As in local/llama.ts: `counted` says the number is the gateway's own count, and `trust` lets a generate call go
  // on the estimate of a request whose caller trusts it (ModelRequest `trustEstimate`). The usage chunk reports the
  // count either way, and a count of the same body always equals it (contract section 5).
  async function prepare(request: ModelRequest, work: Work, signal: AbortSignal, trust = false) {
    const known = prepared.get(request);
    if (known) return { ...known, counted: true };
    const body = bodyFor(request);
    const estimate = count(request.estimatedInputTokens);
    if (trust && request.trustEstimate === true && estimate) return { body, inputTokens: estimate, counted: false };
    const result = await json('/v1/chat/completions/input_tokens', body, signal, work);
    const inputTokens = isObject(result) ? count(result.input_tokens) : null;
    if (!inputTokens) throw new ModelError('usage_unavailable');
    const value = { body, inputTokens };
    prepared.set(request, value);
    return { ...value, counted: true };
  }

  // No text goes to a service that has not passed a check: until one has, and again after one fails or is cancelled,
  // a count or a generation checks the service before it runs. The agent interface and the probes call it without the
  // check the bot makes at its start (local/main.ts), and the bot starts while the service is down: either way, a
  // wrong contract, model or context must meet no story.
  let unchecked = true;
  const provider = {
    countInput(request: ModelRequest, { signal, priority, holder }: Controls = {}) {
      return operation(signal, 'count_input', async current => {
        const work = workOf({ priority, holder });
        if (unchecked) await provider.check({ signal: current });
        return (await prepare(request, work, current)).inputTokens;
      });
    },
    // The state first: another contract version may answer the models route differently, and a service that is not
    // ready answers no inference route at all.
    check({ signal }: Controls = {}) {
      return operation(signal, 'health', async current => {
        unchecked = true;
        const state = await json('/v1/state', null, current);
        if (!isObject(state) || state.contract !== '2') throw new ModelError('unsupported_server');
        if (state.status !== 'ready') throw new ModelError('model_unavailable');
        if (state.model !== config.model) throw new ModelError('unexpected_model');
        const models = await json('/v1/models', null, current);
        const listed = isObject(models) && Array.isArray(models.data)
          ? (models.data as unknown[]).find(model => isObject(model) && model.id === config.model) : undefined;
        if (!isObject(listed)) throw new ModelError('unexpected_model');
        // The gateway's effective context: the engine's, or its own smaller limit. Its state shows the same number
        // (contract section 6); a gateway that says two things is not one the bot understands.
        const contextTokens = count(listed.max_model_len);
        if (contextTokens === null || count(state.context_tokens) !== contextTokens) throw new ModelError('unsupported_server');
        if (contextTokens < config.contextTokens) throw new ModelError('context_limit');
        unchecked = false;
        return { model: config.model, contextTokens };
      });
    },
    // One request at a time over one lane (local/scheduler.ts): a pool's `slot` means nothing to the gateway.
    generate(request: ModelRequest, { onText = async () => {}, signal, inputLimitTokens, priority, holder }: GenerateControls = {}) {
      return operation(signal, 'generate', async (current): Promise<GenerationResult> => {
        const work = workOf({ priority, holder });
        if (unchecked) await provider.check({ signal: current });
        const { body, inputTokens: preparedTokens, counted } = await prepare(request, work, current, true);
        prepared.delete(request);
        const limit = Math.min(config.contextTokens - request.maxOutputTokens, inputLimitTokens ?? Infinity);
        if (preparedTokens > limit) throw new ModelError('context_limit');
        const response = await http('/v1/chat/completions', body, current, work);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          throw new ModelError('invalid_stream');
        }
        let text = '';
        let finishReason: GenerationResult['finishReason'] | undefined;
        let done = false;
        let usage: { readonly [field: string]: unknown } | undefined;
        let reasoningCharacters = 0;
        // What this adapter checks of the stream (contract section 4): every chunk is a record that names the model and
        // holds one choice or none; a choice has index 0 and a delta of text, reasoning or neither, never a tool; one
        // finish, `stop` or `length`; after it only the usage chunk, and after that only `[DONE]`. An error event, or
        // any of these broken, fails the stream, and so does a stream that ends before `[DONE]`.
        for await (const data of events(response.body)) {
          if (data === '[DONE]') { done = true; break; }
          let event: unknown;
          try { event = JSON.parse(data); } catch { throw new ModelError('invalid_stream'); }
          if (!isObject(event)) throw new ModelError('invalid_stream');
          // An error event ends a stream that has started: what came before it, a finish included, is not an answer.
          if (event.error != null) {
            const servingCode = isObject(event.error) ? event.error.code : undefined;
            throw new ModelError(codeFor(servingCode), { phase: 'generate', httpStatus: response.status, servingCode });
          }
          if (usage) throw new ModelError('invalid_stream');
          if (typeof event.model !== 'string' || !Array.isArray(event.choices) || event.choices.length > 1) throw new ModelError('invalid_stream');
          if (event.model !== config.model) throw new ModelError('unexpected_model');
          // Chunks before the last may carry `usage: null`, as OpenAI's do.
          if (event.usage != null) {
            if (!isObject(event.usage) || event.choices.length || !finishReason) throw new ModelError('invalid_stream');
            usage = event.usage;
            continue;
          }
          if (finishReason) throw new ModelError('invalid_stream');
          const choice: unknown = event.choices[0];
          if (choice === undefined) continue;
          if (!isObject(choice) || choice.index !== 0 || !isObject(choice.delta)) throw new ModelError('invalid_stream');
          const { content, reasoning_content: reasoning } = choice.delta;
          if (choice.delta.tool_calls || choice.delta.function_call) throw new ModelError('unexpected_tools');
          if ((content != null && typeof content !== 'string') || (reasoning != null && typeof reasoning !== 'string')) throw new ModelError('invalid_stream');
          if (typeof reasoning === 'string') reasoningCharacters += reasoning.length;
          if (content) {
            text += content;
            if (text.length > 100_000) throw new ModelError('output_limit');
            await onText(content);
          }
          if (choice.finish_reason != null) {
            if (!member(['stop', 'length'] as const, choice.finish_reason)) throw new ModelError('invalid_stream');
            finishReason = choice.finish_reason;
          }
        }
        current.throwIfAborted();
        if (!done || !finishReason) throw new ModelError('incomplete_stream');
        const inputTokens = count(usage?.prompt_tokens);
        const outputTokens = count(usage?.completion_tokens);
        if (!usage || !inputTokens || outputTokens === null) throw new ModelError('usage_unavailable');
        // The gateway's count and its engine's must agree, as llama-server's did (contract section 5).
        if (counted && inputTokens !== preparedTokens) throw new ModelError('unexpected_context');
        // Over the limit the result does not stand, whatever it says: the story compacts and asks again.
        if (inputTokens > limit) throw new ModelError('context_limit');
        if (!text.trim()) throw new ModelError('empty_response');
        const cachedInputTokens = isObject(usage.prompt_tokens_details) ? count(usage.prompt_tokens_details.cached_tokens) : null;
        return { text, finishReason, usage: { inputTokens, outputTokens, cachedInputTokens, reasoningCharacters,
          totalTokens: inputTokens + outputTokens }, timings: timingsOf(usage) };
      });
    },
  };
  return provider;
}
