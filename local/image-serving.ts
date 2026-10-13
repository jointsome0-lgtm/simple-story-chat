// Pictures through simple-serving's picture gateway (its docs/pictures.md, phase 1), behind the entry points of
// local/image-batch.ts: a Comfy the gateway serves (`servedBy`) draws here and gets what it got from ComfyUI itself.
// The gateway does on the card what image-batch.ts does through the tunnel, the nonce, the socket, the queue's order by
// class, the samples of memory, the stop and the delete of the record, and answers a picture with one stream of events
// in place of the socket and the polls: `accepted`, the place while the job waits, `started`, the nodes and steps,
// `over` with the memory, then the frame and its copies. Every request carries the key, the class and the scope. Of
// an answer only a code, the numbers and the pictures are kept, and neither the key nor anything else the gateway says
// goes into an error.
import { performance } from 'node:perf_hooks';
import { NEVER_SENT, SERVER_PINS, afterAbort, halt, phasesOf, stripPngMetadata, transportCode } from './image-batch.ts';
import type { CardPlace, Comfy, DrawOneOptions, Drawn, Graph, Memory, Serving, StagedJob, Vram } from './image-batch.ts';

const failure = (code: string, details: object = {}) => Object.assign(new Error(code), { code, ...details });
const bounded = (...signals: (AbortSignal | undefined)[]) => AbortSignal.any(signals.filter(one => one !== undefined));
const coded = (servingCode: string | undefined) => (servingCode ? { servingCode } : {});

// Every request says whose it is, as the text lane's do (local/serving.ts).
function send(comfy: Comfy, serving: Serving, path: string, signal: AbortSignal,
  { method = 'GET', type, body }: { method?: string; type?: string; body?: RequestInit['body'] } = {}) {
  return fetch(comfy.baseUrl + path, { method, redirect: 'error', signal, ...(body === undefined ? {} : { body }),
    headers: { Authorization: `Bearer ${serving.key}`, 'X-Simple-Serving-Class': serving.cls, 'X-Simple-Serving-Scope': serving.scope,
      ...(type ? { 'Content-Type': type } : {}) } });
}

// The gateway's code for a refusal, `{"error": {"code": …}}`, from at most 4096 bytes of the body, as local/serving.ts
// reads the text lane's. Nothing else of the body is kept, and a body of any other shape gives no code.
async function refusal(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 4096) return undefined;
      chunks.push(chunk);
    }
    const error = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { code?: unknown } } | null)?.error;
    return error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  } catch { return undefined; }
}

// A refusal before the stream. A graph the gateway or ComfyUI refused is the refused graph it always was, the one
// refusal that starts the bot's plain-graph fallback (local/picture.ts `draw`); a socket the gateway could not open for
// a job that needs one is the harness's own code for it, and so is a submit whose answer ComfyUI lost and whose job the
// gateway could not confirm stopped; any other refusal, a key, a class, a full queue or a service that is starting or
// draining, starts no fallback and stops a harness's run (`serving_refused`).
function refused(httpStatus: number, servingCode: string | undefined) {
  const code = servingCode === 'graph_rejected' || servingCode === 'graph_refused' ? 'comfy_rejected_prompt'
    : servingCode === 'socket_unavailable' ? 'comfy_socket_unavailable'
    : servingCode === 'stop_unconfirmed' ? 'comfy_stop_unconfirmed' : 'serving_refused';
  return failure(code, { httpStatus, ...coded(servingCode) });
}
// An error the gateway ended the stream with once the job had begun: the picture failed, with `oom` when the card ran out
// of memory; the class's wall time ran out; the job's stop is not confirmed. Anything else, a drain and an engine lost
// included, is the job lost with the connection to it.
const STREAM_CODES = new Map([['picture_failed', 'image_failed'], ['timeout', 'image_timeout'], ['stop_unconfirmed', 'comfy_stop_unconfirmed']]);
function streamError(error: { code?: unknown; oom?: unknown }) {
  const servingCode = typeof error.code === 'string' ? error.code : undefined;
  const code = (servingCode && STREAM_CODES.get(servingCode)) || 'comfy_connection_lost';
  return failure(code, { ...coded(servingCode), ...(code === 'image_failed' && error.oom === true ? { oom: true } : {}) });
}
// A request that never had its answer: refused at the connect, nothing was sent (`comfy_unreachable`); anything else is
// `code`.
function unanswered(error: unknown, code: string) {
  const transport = transportCode(error);
  return failure(transport && NEVER_SENT.has(transport) ? 'comfy_unreachable' : code);
}

// The engine as the gateway last checked it, never a request of its own to ComfyUI; 503 `starting` before its first
// check. `kitchen_attention` is null while the attention node has not answered.
type Engine = { comfyui?: unknown; pytorch?: unknown; card?: unknown; triton?: unknown; kitchen_attention?: unknown } | null;
async function engine(comfy: Comfy, serving: Serving): Promise<Engine> {
  halt(comfy);
  const response = await send(comfy, serving, '/v1/pictures/engine', bounded(AbortSignal.timeout(comfy.timeoutMs), comfy.signal, comfy.end));
  if (!response.ok) throw refused(response.status, await refusal(response));
  return await response.json() as Engine;
}
// `serverPins`' pins from the engine's facts: the versions and the card cut to 120 characters, and `triton` when it is on.
export async function servedPins(comfy: Comfy, serving: Serving, strict: boolean): Promise<Record<string, string>> {
  const pins: Record<string, string> = {};
  try {
    const seen = await engine(comfy, serving);
    const keep = (key: string, value: unknown) => { if (typeof value === 'string' && value) pins[key] = value.slice(0, 120); };
    keep('comfyui', seen?.comfyui);
    keep('pytorch', seen?.pytorch);
    keep('card', seen?.card);
    if (seen?.triton === true) pins.triton = 'enabled';
  } catch { /* judged below */ }
  if (strict && !SERVER_PINS.every(key => pins[key])) {
    throw new Error(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The gateway did not say what the server is on /v1/pictures/engine (ComfyUI, PyTorch and the card), and a pinned run is pinned to that too');
  }
  return pins;
}
// `attentionOffered`: an attention node that has not answered the gateway yet is no answer, not a no.
export async function servedAttention(comfy: Comfy, serving: Serving): Promise<boolean> {
  const offered = (await engine(comfy, serving))?.kitchen_attention;
  if (typeof offered !== 'boolean') throw failure('attention_unanswered');
  return offered;
}

// An experiment's reference into the card's input directory, for class `internal` alone, under the name
// `uploadReference` gives the stripped bytes; the gateway checks the name against them.
export async function putInput(comfy: Comfy, serving: Serving, name: string, stripped: Uint8Array): Promise<string> {
  halt(comfy);
  let answer: { name?: unknown } | null;
  try {
    const response = await send(comfy, serving, `/v1/pictures/inputs/${name}`, bounded(AbortSignal.timeout(comfy.timeoutMs), comfy.signal, comfy.end),
      { method: 'PUT', type: 'image/png', body: new Blob([stripped]) });
    if (!response.ok) throw failure('comfy_upload_failed', { httpStatus: response.status, ...coded(await refusal(response)) });
    answer = await response.json() as { name?: unknown } | null;
  } catch (error) {
    if ((error as { code?: unknown }).code === 'comfy_upload_failed') throw error;
    halt(comfy);
    throw unanswered(error, 'comfy_upload_failed');
  }
  if (answer?.name !== name) throw failure('comfy_upload_failed');
  return name;
}

// A reader's reference, under the name local/picture-references.ts chose before sending it, so that a lost answer can
// still be erased; the gateway answers with the name the graph gives LoadImage, exactly as ComfyUI's answer made it.
export async function putUpload(comfy: Comfy, serving: Serving, name: string, bytes: Uint8Array, type: string) {
  const timeout = AbortSignal.timeout(Math.min(comfy.timeoutMs, 15000));
  const response = await send(comfy, serving, `/v1/pictures/uploads/${name}`, bounded(comfy.signal, timeout), { method: 'PUT', type, body: new Blob([bytes]) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('reference_upload_failed');
  }
  const answer = await response.json() as { name?: unknown } | null;
  if (answer?.name !== `bot-references/${name} [temp]`) throw new Error('reference_upload_failed');
}
// Its erasure: the gateway overwrites the name with a blank, as the bot does with ComfyUI, and says so with 204. The
// reader's signal does not reach it: a reader who has let go still has their picture erased.
export async function eraseUpload(comfy: Comfy, serving: Serving, name: string) {
  const response = await send(comfy, serving, `/v1/pictures/uploads/${name}`, AbortSignal.timeout(Math.min(comfy.timeoutMs, 15000)), { method: 'DELETE' });
  await response.body?.cancel();
  if (response.status !== 204) throw new Error('reference_cleanup_failed');
}

// A job the client let go of, stopped by the gateway as `stopJob` stops one, under the reserve and not the caller's
// signal (`afterAbort`): true once the gateway confirms the stop or no longer knows the job, false when it cannot
// confirm it or does not answer.
async function stop(comfy: Comfy, serving: Serving, job: string): Promise<boolean> {
  const after = afterAbort(comfy);
  try {
    halt(after);
    const response = await send(after, serving, `/v1/pictures/${encodeURIComponent(job)}/stop`, bounded(AbortSignal.timeout(after.timeoutMs), after.end),
      { method: 'POST' });
    if (!response.ok) return response.status === 404 && await refusal(response) === 'not_found';
    return (await response.json() as { stopped?: unknown } | null)?.stopped === true;
  } catch { return false; }
}

// The stream's lines, each whole: a picture's line is megabytes of base64 over many reads. The bytes of one job's
// stream are bounded, its pictures and the events around them.
const STREAM_LIMIT = 128 * 1024 * 1024;
async function* lines(body: ReadableStream<Uint8Array> | null) {
  if (!body) throw failure('comfy_connection_lost');
  let parts: Uint8Array[] = [], bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > STREAM_LIMIT) throw failure('comfy_connection_lost');
    let from = 0;
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, from)) {
      parts.push(chunk.subarray(from, at));
      yield Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
      parts = [];
      from = at + 1;
    }
    if (from < chunk.byteLength) parts.push(chunk.subarray(from));
  }
}

type Event = { event?: unknown; error?: { code?: unknown; oom?: unknown }; job?: unknown; before?: unknown; drawing?: unknown;
  drawing_ms?: unknown; stamp?: unknown; nodes?: unknown; node?: unknown; value?: unknown; max?: unknown; heard?: unknown;
  memory?: unknown; stamps?: unknown; partial_loads?: unknown; png?: unknown };
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
// `over`'s memory in image-batch.ts's names (`Memory`); what does not read as a number is left out.
function memoryOf(value: unknown): Memory {
  const seen = (value && typeof value === 'object' ? value : {}) as { vram?: unknown; samples?: unknown; ram_mib?: { min?: unknown; max?: unknown } };
  const vram: Vram[] = (Array.isArray(seen.vram) ? seen.vram : []).flatMap((device: { index?: unknown; total_mib?: unknown; used_mib_max?: unknown;
    occupied_mib_max?: unknown } | null) => {
    const [index, totalMiB, usedMiBMax, occupied] = [count(device?.index), count(device?.total_mib), count(device?.used_mib_max), count(device?.occupied_mib_max)];
    return index === undefined || totalMiB === undefined || usedMiBMax === undefined ? []
      : [{ index, totalMiB, usedMiBMax, ...(occupied === undefined ? {} : { occupiedMiBMax: occupied }) }];
  });
  const [min, max] = [count(seen.ram_mib?.min), count(seen.ram_mib?.max)];
  return { vram, samples: count(seen.samples) ?? 0, ...(min === undefined || max === undefined ? {} : { ramMiB: { min, max } }) };
}
function stampsOf(value: unknown) {
  const { start, end } = (value && typeof value === 'object' ? value : {}) as { start?: unknown; end?: unknown };
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;
}

// A job through the gateway, from its request (`started`) to its pictures, in the halves `follow` gives a job:
// `accepted` once the gateway has it on the card, `over` once its record is written, `pictures` once the frame and its
// copies are in. The stream is read in one go; the caller takes the halves in its own order. `began`: when the caller's
// wait began, which bounds the whole stream (`waitMs`). `staged`: the harness's job, which has no place to tell.
function stream(comfy: Comfy, serving: Serving, graph: Graph, options: DrawOneOptions, began: number, staged: boolean) {
  const copies = options.copies ?? [], waitMs = options.waitMs ?? 600000;
  const started = performance.now();
  // What the stream said, each on our clock as it came: the job's id for its stop, when the gateway's socket heard it
  // start, the nodes its cache answered, each node that ran, the over, and the pictures.
  let job: string | undefined, startedAt: number | undefined, cached: string[] | undefined;
  let over: { at: number; heard: boolean; memory: Memory; stamps?: { start: number; end: number }; partialLoads?: number } | undefined;
  let frame: { bytes: Uint8Array; at: number } | undefined, lastAt = 0;
  const ran: { node: string; at: number }[] = [], copied: { node: string; bytes: Uint8Array }[] = [];
  const accepted = Promise.withResolvers<void>(), overHeard = Promise.withResolvers<void>(), pictures = Promise.withResolvers<void>();
  for (const one of [accepted, overHeard, pictures]) one.promise.catch(() => undefined);
  // The stream is cut when the caller lets go, the stage ends or the wait runs out, but never before the job's id is in
  // hand: a job the gateway may have taken is followed until its stop can name it (image-batch.ts `submitOnce`).
  const cut = new AbortController();
  let ending: 'image_timeout' | 'halt' | undefined;
  const end = (why: 'image_timeout' | 'halt') => {
    ending ??= why;
    if (job !== undefined) cut.abort();
  };
  const halted = () => end('halt');
  // The bot's place in the queue (`onPlace`), as `follow` tells it: each `place`, then nothing once it has started.
  let placing = !!options.onPlace && !staged;
  const placed = (place: CardPlace | null) => {
    if (!placing) return;
    if (place === null) placing = false;
    try { options.onPlace!(place); } catch { /* the listener's own */ }
  };
  const hear = (event: Event) => {
    const now = performance.now();
    if (event.event === 'accepted') {
      if (typeof event.job !== 'string' || !event.job) throw failure('comfy_connection_lost');
      job = event.job;
      options.onSubmitted?.();
      accepted.resolve();
      if (ending) cut.abort();
    } else if (job === undefined) throw failure('comfy_connection_lost');
    else if (event.event === 'place') {
      const { before, drawing, drawing_ms: drawingMs } = event;
      if (Number.isSafeInteger(before) && (before as number) >= 0 && typeof drawing === 'boolean' && count(drawingMs) !== undefined) {
        placed({ before: before as number, drawing, drawingMs: Math.round(drawingMs as number) });
      }
    } else if (event.event === 'started') {
      if (typeof event.stamp === 'number') startedAt = now;
      placed(null);
    } else if (event.event === 'cached') {
      if (Array.isArray(event.nodes)) cached = event.nodes.map(String);
    } else if (event.event === 'node') {
      if (typeof event.node === 'string') ran.push({ node: event.node, at: now });
    } else if (event.event === 'progress' && options.onProgress) {
      const { value, max } = event;
      if (typeof value === 'number' && typeof max === 'number' && Number.isSafeInteger(max) && max > 0
        && Number.isSafeInteger(value) && value >= 0 && value <= max) {
        try { options.onProgress(value, max); } catch { /* the listener's own */ }
      }
    } else if (event.event === 'over') {
      const partialLoads = event.partial_loads;
      over = { at: now, heard: event.heard === true, memory: memoryOf(event.memory), stamps: stampsOf(event.stamps),
        ...(Number.isSafeInteger(partialLoads) && (partialLoads as number) >= 0 ? { partialLoads: partialLoads as number } : {}) };
      placing = false;
      overHeard.resolve();
    } else if (event.event === 'image') {
      if (!over || typeof event.node !== 'string' || typeof event.png !== 'string') throw failure('comfy_connection_lost');
      // Stripped again, as every picture that reaches this side is.
      const bytes = stripPngMetadata(Buffer.from(event.png, 'base64'));
      if (!frame) frame = { bytes, at: now };
      else if (copies.includes(event.node)) copied.push({ node: event.node, bytes });
      lastAt = now;
    }
  };
  const read = async () => {
    const answer = new AbortController(), timer = setTimeout(() => answer.abort(), comfy.timeoutMs);
    const deadline = setTimeout(() => end('image_timeout'), Math.max(0, began + waitMs - performance.now()));
    comfy.signal?.addEventListener('abort', halted, { once: true });
    comfy.end?.addEventListener('abort', halted, { once: true });
    if (comfy.signal?.aborted || comfy.end?.aborted) halted();
    try {
      // Keep the request's bound until acceptance or the refusal body arrives. Headers alone give no job id to stop,
      // so a stalled body must still be cut by this timer, even after the caller has let go.
      const response = await send(comfy, serving, '/v1/pictures', bounded(answer.signal, cut.signal, comfy.reserve), { method: 'POST', type: 'application/json',
        body: JSON.stringify({ graph, ...(options.copies ? { copies: options.copies } : {}), ...(options.requireSocket ? { require_socket: true } : {}) }) });
      if (!response.ok) throw refused(response.status, await refusal(response));
      for await (const line of lines(response.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          if (!over || !frame) break;
          return pictures.resolve();
        }
        const event = JSON.parse(data) as Event;
        if (event.error && typeof event.error === 'object') throw Object.assign(streamError(event.error), { gateway: true });
        hear(event);
        if (job !== undefined) clearTimeout(timer);
      }
      throw failure('comfy_connection_lost');
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      comfy.signal?.removeEventListener('abort', halted);
      comfy.end?.removeEventListener('abort', halted);
    }
  };
  void read().catch(async (error: unknown) => {
    let thrown = error;
    try {
      const own = (error as { code?: unknown }).code;
      // Before the job's id there is nothing to stop: the refusal as it was mapped, or a request without its answer,
      // whose job the gateway stops itself if it took one, since its client has gone.
      if (job === undefined) throw typeof own === 'string' ? error : unanswered(error, 'comfy_connection_lost');
      // Ended here without its picture, while the card may still draw it: the gateway stops it, and says whether it
      // could. One the gateway ended itself, or one that is over, has nothing to stop.
      const stopped = (error as { gateway?: unknown }).gateway === true || over ? true : await stop(comfy, serving, job);
      halt(comfy);
      if (!stopped) throw failure('comfy_stop_unconfirmed');
      throw ending === 'image_timeout' ? failure('image_timeout')
        : typeof own === 'string' || /^(not_a_png|truncated_png)$/.test((error as Error).message) ? error : failure('comfy_connection_lost');
    } catch (final) { thrown = final; }
    placing = false;
    for (const one of [accepted, overHeard, pictures]) one.reject(thrown);
  });
  // The picture as `follow`'s `fetch` gives it. `totalMs` runs from the request to the last picture; the harness's leaves
  // out the time between the over and its `fetch`, as its next job went out then. `viewMs` runs from the over, or the
  // harness's `fetch`, to the frame. The phases come from the receipt of each node and of the over, when the gateway's
  // socket heard the whole job; `queueMs`, to a start its socket heard.
  const picture = (fetchAt?: number): Drawn => {
    const { at, heard, memory, stamps, partialLoads } = over!, from = fetchAt ?? at;
    const loaders = Object.keys(graph).filter(id => /Loader/.test(graph[id].class_type));
    return { bytes: frame!.bytes, totalMs: Math.round(at - started + Math.max(0, lastAt - from)), viewMs: Math.round(Math.max(0, frame!.at - from)),
      vram: memory.vram, memory,
      timing: heard ? { phases: phasesOf(graph, ran, at), ...(cached ? { loaderCacheMiss: loaders.some(id => !cached!.includes(id)) } : {}) } : undefined,
      cached, stamps,
      ...(startedAt === undefined ? {} : { queueMs: Math.max(0, Math.round(startedAt - started)) }),
      ...(copies.length ? { copies: copied } : {}),
      ...(partialLoads === undefined ? {} : { partialLoads }) };
  };
  return { accepted: accepted.promise, over: overHeard.promise, pictures: pictures.promise, picture, get partialLoads() { return over?.partialLoads; } };
}

// `drawOne` through the gateway: the graph settled, the caller asked again, and then the request.
export async function drawServed(comfy: Comfy, serving: Serving, graph: Graph | Promise<Graph>, options: DrawOneOptions): Promise<Drawn> {
  const began = performance.now();
  const filled = await graph;
  halt(comfy);
  if (options.admit && !options.admit()) throw failure('not_admitted');
  const flow = stream(comfy, serving, filled, options, began, false);
  await flow.pictures;
  return flow.picture();
}

// `submitOnStage` through the gateway: it returns once the gateway has the job. The last sample of memory came with
// the over; the pictures come down on the same stream while the harness's next job goes out, and wait for its `fetch`.
// The stage's socket and its window through a dropped connection are not used: a connection to the gateway that drops
// loses the job (`comfy_connection_lost`).
export async function submitServed(comfy: Comfy, serving: Serving, graph: Graph, options: DrawOneOptions): Promise<StagedJob> {
  const began = performance.now();
  if (options.admit && !options.admit()) throw failure('not_admitted');
  const flow = stream(comfy, serving, graph, options, began, true);
  await flow.accepted;
  return {
    untilOver: () => flow.over,
    lastSample: async () => undefined,
    fetch: async () => {
      const at = performance.now();
      await flow.pictures;
      return flow.picture(at);
    },
    get partialLoads() { return flow.partialLoads; },
  };
}
