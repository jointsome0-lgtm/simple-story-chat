import type { ErrorDetails } from './model-error.ts';
import { ModelError, member } from './model-error.ts';
import type { ModelConfig } from './config.ts';
import { modelBaseUrl } from './config.ts';
import type { Controls, GenerateControls, GenerationResult, ModelRequest } from './model.ts';

// Only the fields this provider reads; tests pass a partial configuration.
export type LlamaConfig = Pick<ModelConfig, 'baseUrl' | 'model' | 'contextTokens'> & Partial<Pick<ModelConfig, 'apiKey' | 'temperature' | 'timeoutMs'>>;
// Thrown values are not checked; these fields are read if present and filtered by ModelError.
type Thrown = { phase?: unknown; httpStatus?: unknown; code?: unknown; cause?: { code?: unknown } | null } | null | undefined;
// llama.cpp JSON is not validated in advance. Fields the provider checks are unknown; a body or
// list entry that is not an object fails with a TypeError, reported as provider_failed.
type Models = { data?: { id?: unknown }[] | null };
type Props = { default_generation_settings?: { n_ctx?: unknown } | null; total_slots?: unknown };
type StreamEvent = {
  error?: unknown; model?: unknown; choices?: unknown;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } | null };
};
type Choice = { index?: unknown; delta?: unknown; finish_reason?: unknown };

const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const isObject = (value: unknown): value is { readonly [field: string]: unknown } => !!value && typeof value === 'object';
const MAX_BODY = 2_000_000;
function messagesFor(request: ModelRequest) {
  const messages: { role: string; content: string }[] = [];
  for (const message of [{ role: 'system', content: request.system }, ...request.messages]) {
    const previous = messages.at(-1);
    if (previous?.role === message.role) previous.content += '\n\n' + message.content;
    else messages.push({ ...message });
  }
  return messages;
}

// Decode complete SSE events, including UTF-8 characters split across chunks.
async function* events(body: Response['body']) {
  if (!body) throw new ModelError('invalid_stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY) throw new ModelError('output_limit');
    buffer += decoder.decode(chunk, { stream: true });
    let end: RegExpExecArray | null;
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, end.index);
      buffer = buffer.slice(end.index + end[0].length);
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new ModelError('invalid_stream');
}

export function createLlama(config: LlamaConfig,
  { fetch: fetcher = globalThis.fetch }: { fetch?: (url: string, init: RequestInit) => Promise<Response> } = {}) {
  const baseUrl = modelBaseUrl(config.baseUrl);
  const headers = { 'Content-Type': 'application/json',
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) };
  const prepared = new WeakMap<ModelRequest, { body: ReturnType<typeof bodyFor>; inputTokens: number }>();
  const bodyFor = (request: ModelRequest) => ({ model: config.model,
    messages: messagesFor(request),
    max_tokens: request.maxOutputTokens, stream: true, stream_options: { include_usage: true },
    temperature: request.purpose === 'memory' ? 0.2 : config.temperature ?? 0.8,
    top_p: 0.95, top_k: 64, min_p: 0, repeat_penalty: 1,
    reasoning_effort: 'none', reasoning_format: 'deepseek',
    chat_template_kwargs: { enable_thinking: false }, cache_prompt: true,
    ...(request.outputSchema ? { response_format: { type: 'json_object', schema: request.outputSchema } } : {}),
  });

  async function operation<T>(signal: AbortSignal | undefined, phase: NonNullable<ErrorDetails['phase']>, fn: (signal: AbortSignal) => Promise<T>) {
    const timer = AbortSignal.timeout(config.timeoutMs ?? 300000);
    const combined = signal ? AbortSignal.any([signal, timer]) : timer;
    try {
      combined.throwIfAborted();
      return await fn(combined);
    } catch (error) {
      const thrown = error as Thrown;
      const details = { phase: thrown?.phase ?? phase, httpStatus: thrown?.httpStatus,
        transportCode: error instanceof ModelError ? error.transportCode : thrown?.cause?.code ?? thrown?.code };
      // Health checks from gpu.ts and bot.ts are not queued and pass their own AbortSignal.timeout, so its expiry is
      // a timeout. Scheduled calls are aborted with the scheduler's reasons, which the scheduler reports instead.
      if (signal?.aborted) throw new ModelError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', details);
      if (timer.aborted) throw new ModelError('timeout', details);
      throw new ModelError(error instanceof ModelError ? error.code : 'provider_failed', details);
    }
  }

  async function http(path: string, body: object | null, signal: AbortSignal) {
    const phase = path.endsWith('/input_tokens') ? 'count_input' : path === '/v1/chat/completions' ? 'generate' : 'health';
    let response: Response;
    try { response = await fetcher(baseUrl + path, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' }); }
    catch (error) { throw new ModelError('provider_failed', { phase, transportCode: (error as Thrown)?.cause?.code ?? (error as Thrown)?.code }); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelError(response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 429 ? 'rate_limited' : response.status === 503 ? 'model_unavailable'
          : response.status === 404 ? 'unsupported_server' : 'provider_failed', { phase, httpStatus: response.status });
    }
    return response;
  }

  async function json(path: string, body: object | null, signal: AbortSignal): Promise<unknown> {
    const response = await http(path, body, signal);
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

  async function prepare(request: ModelRequest, signal: AbortSignal) {
    if (prepared.has(request)) return prepared.get(request)!;
    const body = bodyFor(request);
    const result = await json('/v1/chat/completions/input_tokens', body, signal) as { input_tokens?: unknown };
    const inputTokens = count(result.input_tokens);
    if (inputTokens === null || inputTokens === 0) throw new ModelError('usage_unavailable');
    const value = { body, inputTokens };
    prepared.set(request, value);
    return value;
  }

  return {
    // llama.cpp 0.4.1 uses the same template and tokenizer for this endpoint
    // and chat generation. No heuristic fallback to another protocol.
    countInput(request: ModelRequest, { signal }: Controls = {}) {
      return operation(signal, 'count_input', async current => (await prepare(request, current)).inputTokens);
    },
    check({ signal }: Controls = {}) {
      return operation(signal, 'health', async current => {
        const models = await json('/v1/models', null, current) as Models;
        if (!models.data?.some(model => model.id === config.model)) throw new ModelError('unexpected_model');
        const props = await json('/props', null, current) as Props;
        const contextTokens = count(props.default_generation_settings?.n_ctx);
        if (contextTokens === null || contextTokens < config.contextTokens) throw new ModelError('context_limit');
        if (props.total_slots !== 1) throw new ModelError('unexpected_slots');
        return { model: config.model, contextTokens, slots: props.total_slots };
      });
    },
    generate(request: ModelRequest, { onText = async () => {}, signal, inputLimitTokens }: GenerateControls = {}) {
      return operation(signal, 'generate', async (current): Promise<GenerationResult> => {
        const { body, inputTokens } = await prepare(request, current);
        prepared.delete(request);
        const limit = Math.min(config.contextTokens - request.maxOutputTokens, inputLimitTokens ?? Infinity);
        if (inputTokens > limit) throw new ModelError('context_limit');
        const response = await http('/v1/chat/completions', body, current);
        if (!response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          throw new ModelError('invalid_stream');
        }
        let text = '';
        let finishReason: GenerationResult['finishReason'] | undefined;
        let done = false;
        let outputTokens: number | null = null;
        let cachedInputTokens: number | null = null;
        let reasoningCharacters = 0;
        for await (const data of events(response.body)) {
          if (data === '[DONE]') { done = true; break; }
          let event: StreamEvent;
          try { event = JSON.parse(data); } catch { throw new ModelError('invalid_stream'); }
          if (event.error || !Array.isArray(event.choices)) throw new ModelError('invalid_stream');
          if (event.model && event.model !== config.model) throw new ModelError('unexpected_model');
          if (event.usage) {
            const reported = count(event.usage.prompt_tokens);
            if (reported !== null && reported !== inputTokens) throw new ModelError('unexpected_context');
            outputTokens = count(event.usage.completion_tokens);
            cachedInputTokens = count(event.usage.prompt_tokens_details?.cached_tokens);
          }
          if (event.choices.length > 1) throw new ModelError('invalid_stream');
          for (const choice of event.choices as Choice[]) {
            if (choice.index !== 0) throw new ModelError('invalid_stream');
            const delta = choice.delta;
            if (!isObject(delta)) throw new ModelError('invalid_stream');
            if (delta.tool_calls || delta.function_call) throw new ModelError('unexpected_tools');
            if (typeof delta.reasoning_content === 'string') reasoningCharacters += delta.reasoning_content.length;
            if (delta.content != null && typeof delta.content !== 'string') throw new ModelError('invalid_stream');
            if (delta.content) {
              if (finishReason) throw new ModelError('invalid_stream');
              text += delta.content;
              if (text.length > 100_000) throw new ModelError('output_limit');
              await onText(delta.content);
            }
            if (choice.finish_reason != null) {
              if (finishReason || !member(['stop', 'length'] as const, choice.finish_reason)) throw new ModelError('invalid_stream');
              finishReason = choice.finish_reason;
            }
          }
        }
        current.throwIfAborted();
        if (!done || !finishReason) throw new ModelError('incomplete_stream');
        if (!text.trim()) throw new ModelError('empty_response');
        return { text, finishReason, usage: { inputTokens, outputTokens, cachedInputTokens, reasoningCharacters,
          totalTokens: outputTokens === null ? null : inputTokens + outputTokens } };
      });
    },
  };
}
