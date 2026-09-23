// A stand-in for llama-server on the loopback interface: the endpoints local/llama.ts calls, per-slot prefix caching
// and plausible `timings`, so that local/gpu-measure.ts can be rehearsed end to end before a card is rented. It runs
// no model: the answers are a fixed synthetic Russian sentence, and nothing it is sent is stored or printed.
// Run by hand to rehearse a whole measurement off the card:
//   node local/fake-llama.ts --slots 3 --context 65536      then point SIMPLE_CHAT_BASE_URL at the printed address
import http from 'node:http';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

type Message = { role: string; content: string };
type Body = {
  messages?: unknown; max_tokens?: unknown; stream?: unknown; n?: unknown; id_slot?: unknown; cache_prompt?: unknown;
  response_format?: unknown;
};
export type FakeOptions = {
  model?: string; slots?: number; contextTokens?: number;
  // How much the server answers, and the speeds it reports in `timings`.
  outputTokens?: number; promptMsPerToken?: number; predictMsPerToken?: number;
  // On, the server really spends the time it reports, so a rehearsal has prefill, decode and a queue to measure.
  // Off, every call is answered at once, which is what a test about caching or counting wants.
  realTime?: boolean;
  // A draft model (MTP): the share of drafted tokens the main model accepts, reported as `draft_n`/`draft_n_accepted`.
  draftAcceptance?: number;
  // Off, the slots keep nothing between calls: what a server whose cache the work beside it evicts looks like.
  prefixCache?: boolean;
};
// What a generation did, for a test to assert on. No message content: this server sees prompts and keeps none.
// `queuedMs` is how long the call waited for a free slot, which is the wait the measurer's threshold 5 is about.
export type FakeCall = { slot: number; promptTokens: number; cachedTokens: number; outputTokens: number; queuedMs: number };

// A token stands for four characters. The exact number is not the point — only that the count is deterministic,
// grows with the text and lets two prompts be compared piece by piece, which is what a prefix cache does.
const CHARS_PER_TOKEN = 4;
// What a rehearsal answers with by default. The measurer discards a scene shorter than the shortest scene of the
// frozen fixture it replays (1847 characters for `battle`) and reports "scene shorter than the frozen fixture
// minimum" instead of a verdict, so a server that answers in 256 tokens decides nothing at all.
export const REHEARSAL_OUTPUT_TOKENS = 520;
const SENTENCE = 'Синтетический ответ замера: сцена продолжается, ключ остаётся у того, у кого был. ';
// The measurer asks the model to begin its answer with a date and counts an answer that does not as a format failure.
// The date is read back out of the request, so this server knows nothing about the caller's prompt.
const DATE = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

function tokenize(messages: Message[]): string[] {
  const text = messages.map(message => `<${message.role}>${message.content}`).join('\n');
  const tokens: string[] = [];
  for (let at = 0; at < text.length; at += CHARS_PER_TOKEN) tokens.push(text.slice(at, at + CHARS_PER_TOKEN));
  return tokens;
}
const sharedPrefix = (a: string[], b: string[]) => {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
};
function messagesOf(value: unknown): Message[] {
  if (!Array.isArray(value)) throw new Error('invalid_messages');
  return value.map(entry => {
    const message = entry as { role?: unknown; content?: unknown };
    if (typeof message.role !== 'string' || typeof message.content !== 'string') throw new Error('invalid_messages');
    return { role: message.role, content: message.content };
  });
}
const whole = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;

// The schema a request asks its answer to follow, in either spelling the adapters use.
const schemaOf = (format: unknown) => {
  const asked = (format ?? {}) as { schema?: unknown; json_schema?: { schema?: unknown } | null };
  return asked.json_schema?.schema ?? asked.schema;
};
// An answer that obeys a schema: the first value every field allows. llama-server constrains its sampling with a
// grammar built from the schema, and the bot's memory step is a schema request; a server that answered it with prose
// would fail every compaction, and the rehearsal would never reach the scene that uses the memory. Only the schema
// is read here, never the prompt — the scene ids a memory must cite are in the schema itself.
function sample(schema: unknown): unknown {
  const node = (schema ?? {}) as { type?: unknown; enum?: unknown[]; properties?: Record<string, unknown>;
    items?: unknown; maxItems?: unknown };
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  if (node.type === 'array') {
    // Every value an item is allowed to take, so that a field listing the scenes to cite cites all of them.
    const items = (node.items ?? {}) as { enum?: unknown[] };
    const all = Array.isArray(items.enum) && items.enum.length ? items.enum : [sample(node.items)];
    return typeof node.maxItems === 'number' ? all.slice(0, Math.max(1, node.maxItems)) : all;
  }
  if (node.properties) return Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, sample(value)]));
  if (node.type === 'integer' || node.type === 'number') return 0;
  if (node.type === 'boolean') return false;
  return SENTENCE.trim();
}

export async function startFakeLlama({ model = 'fake-llama', slots: slotCount = 1, contextTokens = 65536,
  outputTokens = 64, promptMsPerToken = 0.05, predictMsPerToken = 20, realTime = false,
  draftAcceptance, prefixCache = true }: FakeOptions = {}) {
  // Each slot remembers the prompt it last read, as llama.cpp's slots keep their cache cells, and serves one request
  // at a time, as they do. A rehearsal without that gate has no queue and no contention, and the thresholds about
  // waiting and about the scene slowing down beside other work would pass on a server that never had to choose.
  const slots = Array.from({ length: slotCount }, () => ({ tokens: [] as string[], busy: false }));
  const calls: FakeCall[] = [];
  // Every request that asked the server to count a prompt, recorded as the number of generations it had already
  // answered. A scheduler that admits calls by size counts each call it queues, and those counts land between
  // generations; one that hands a whole slot to a call asks for no count of its own.
  const counts: number[] = [];
  const waiting: (() => void)[] = [];

  // The body is decoded only once it is whole: a prompt of 40,000 tokens arrives in many chunks, and a Russian
  // character split across two of them would decode as a replacement character and break the prefix comparison.
  const body = (request: http.IncomingMessage) => new Promise<Body>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32_000_000) reject(new Error('body_too_large'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as Body); }
      catch { reject(new Error('invalid_json')); }
    });
    request.on('error', reject);
  });

  // The free slot the call runs in: the one it names, else the one whose cache fits the prompt best, as llama-server
  // chooses it. Ties go to the lowest slot. `null` while every candidate is busy.
  function pick(asked: unknown, tokens: string[]) {
    if (typeof asked === 'number' && Number.isInteger(asked) && asked >= 0 && asked < slots.length) {
      return slots[asked].busy ? null : asked;
    }
    let best: number | null = null;
    for (let index = 0; index < slots.length; index++) {
      if (slots[index].busy) continue;
      if (best === null || sharedPrefix(slots[index].tokens, tokens) > sharedPrefix(slots[best].tokens, tokens)) best = index;
    }
    return best;
  }
  // Every waiter is woken, not the first one: a waiter that asked for another slot cannot take this one, and waking
  // it alone would leave the caller that asked for exactly this slot asleep until some other call happened to end.
  const release = (slot: number) => { slots[slot].busy = false; for (const resume of waiting.splice(0)) resume(); };
  async function acquire(asked: unknown, tokens: string[]) {
    for (;;) {
      const slot = pick(asked, tokens);
      if (slot !== null) { slots[slot].busy = true; return slot; }
      await new Promise<void>(resolve => waiting.push(resolve));
    }
  }

  // One answer, and what the server would report about producing it. The prompt is taken into the slot's cache here,
  // as the server fills it while it reads: a call that is cut off still leaves what it read behind. The slot is held
  // until the caller calls `done`, so the next request queues behind this one.
  async function work(request: Body) {
    const messages = messagesOf(request.messages);
    const tokens = tokenize(messages);
    if (tokens.length > contextTokens) throw new Error('context_limit');
    const asked = performance.now();
    const slot = await acquire(request.id_slot, tokens);
    const queuedMs = Math.round(performance.now() - asked);
    // Nothing is ever fully cached: the server always reads at least the last token of a prompt again.
    const cached = request.cache_prompt === false || !prefixCache ? 0
      : Math.min(sharedPrefix(slots[slot].tokens, tokens), Math.max(0, tokens.length - 1));
    slots[slot].tokens = prefixCache ? tokens : [];
    const limit = whole(request.max_tokens, outputTokens);
    const wanted = Math.max(1, Math.min(outputTokens, limit));
    const date = messages.map(message => message.content).join('\n').match(DATE)?.[0];
    const opening = date ? `${date}\n` : '';
    const schema = schemaOf(request.response_format);
    const text = schema ? JSON.stringify(sample(schema))
      : (opening + SENTENCE.repeat(Math.ceil(wanted * CHARS_PER_TOKEN / SENTENCE.length) + 1)).slice(0, wanted * CHARS_PER_TOKEN);
    // A schema answer is as long as the schema makes it; a scene is as long as it was asked to be.
    const answer = schema ? Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN)) : wanted;
    const read = tokens.length - cached;
    const timings = { cache_n: cached, prompt_n: read, prompt_ms: read * promptMsPerToken,
      predicted_n: answer, predicted_ms: answer * predictMsPerToken,
      ...(draftAcceptance === undefined ? {}
        : { draft_n: answer, draft_n_accepted: Math.round(answer * draftAcceptance) }) };
    calls.push({ slot, queuedMs, promptTokens: tokens.length, cachedTokens: cached, outputTokens: answer });
    // A prompt is read before the first token is written, and only the part the cache did not cover.
    if (realTime && timings.prompt_ms) await delay(timings.prompt_ms);
    return { text, timings, slot, done: () => release(slot),
      finishReason: answer >= limit ? 'length' : 'stop',
      usage: { prompt_tokens: tokens.length, completion_tokens: answer,
        prompt_tokens_details: { cached_tokens: cached } } };
  }

  async function stream(response: http.ServerResponse, request: Body) {
    const { text, timings, finishReason, usage, done } = await work(request);
    try {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      const send = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      // Several tokens per chunk, as a server writing at a steady rate does.
      const piece = CHARS_PER_TOKEN * 8;
      for (let at = 0; at < text.length; at += piece) {
        // The caller gave up (the scheduler preempts probes): nothing more is written to a closed socket.
        if (response.destroyed || response.writableEnded) return;
        send({ model, choices: [{ index: 0, delta: { content: text.slice(at, at + piece) }, finish_reason: null }] });
        if (realTime) await delay(predictMsPerToken * 8);
      }
      if (response.destroyed || response.writableEnded) return;
      send({ model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
      send({ model, choices: [], usage, timings });
      response.end('data: [DONE]\n\n');
    } finally { done(); }
  }

  const server = http.createServer(async (request, response) => {
    const json = (status: number, value: object) =>
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method === 'GET' && path === '/health') return json(200, { status: 'ok' });
      if (request.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: [{ id: model, object: 'model' }] });
      if (request.method === 'GET' && path === '/props') {
        return json(200, { default_generation_settings: { n_ctx: contextTokens }, total_slots: slots.length });
      }
      if (request.method !== 'POST') return json(404, { error: 'not_found' });
      const sent = await body(request);
      if (path === '/v1/chat/completions/input_tokens') {
        counts.push(calls.length);
        return json(200, { input_tokens: tokenize(messagesOf(sent.messages)).length });
      }
      if (path !== '/v1/chat/completions') return json(404, { error: 'not_found' });
      if (sent.stream !== false) return await stream(response, sent);
      // Several samples of one prompt in one answer (llama.ts `generateMany`): the prompt is read once and the
      // samples share its cache cells, so this is one call of the server's, not several.
      const { text, finishReason, usage, timings, done } = await work(sent);
      if (realTime) await delay(timings.predicted_ms);
      done();
      return json(200, { model, usage, timings,
        choices: Array.from({ length: whole(sent.n, 1) }, (_unused, index) =>
          ({ index, message: { role: 'assistant', content: text }, finish_reason: finishReason })) });
    } catch (error) {
      if (!response.headersSent) json(400, { error: (error as Error).message });
      else response.end();
    }
  });
  // No request timeouts: a rehearsal holds a connection open for as long as the measurement it stands in for.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    port, baseUrl: `http://127.0.0.1:${port}`, calls, counts,
    async close() {
      server.closeAllConnections();
      await new Promise<unknown>(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    model: { type: 'string', default: 'fake-llama' }, slots: { type: 'string', default: '1' },
    context: { type: 'string', default: '65536' }, 'output-tokens': { type: 'string', default: String(REHEARSAL_OUTPUT_TOKENS) },
    'ms-per-token': { type: 'string', default: '20' },
  } });
  const fake = await startFakeLlama({ model: values.model, slots: Number(values.slots), realTime: true,
    contextTokens: Number(values.context), outputTokens: Number(values['output-tokens']),
    predictMsPerToken: Number(values['ms-per-token']) });
  console.log(JSON.stringify({ event: 'fake_llama_listening', baseUrl: fake.baseUrl, model: values.model,
    slots: Number(values.slots), contextTokens: Number(values.context) }));
}
