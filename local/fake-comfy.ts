// A stand-in for ComfyUI on the loopback interface, so that an identity or action run can be rehearsed end to end
// before a card is rented (local/image-identity.ts and local/image-action.ts `dry-run`). It keeps the narrow contract
// local/image-batch.ts relies on: the routes it calls, one job at a time, and the websocket messages the pinned
// revision sends, in the order it sends them and only to a socket that is open when they are sent. It models no card:
// no speed, no cache, no memory. What it says about those — how long a job takes, which loaders the cache answered, a
// failure, an OOM, a partial load in the log, the numbers on /system_stats — is fixed or set by the knobs below, and
// says nothing about any card. A picture is a flat grey PNG with a text chunk beside the pixels, as a saving node
// writes one, of the size of what the node saves: the sampler's latent behind a decode, the size a scale node asks
// for, a crop's as the pinned ImageCrop cuts it, a composite's destination's, or an uploaded file's own. Masks it
// computes as the pinned mask nodes do, and reports them as counts (`MaskedJob`), never pixels. No prompt it is sent is
// printed or kept past its job.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { pngSize } from './image-batch.ts';
import type { Graph } from './image-batch.ts';

// The knobs, read at every job and every connection, so that a test can turn one between two rows.
export type FakeComfyOptions = {
  // How long the sampler of a job takes, and how much longer per reference picture.
  jobMs?: number; referenceMs?: number;
  // Whether the sampler, its time done, goes on until the memory has been asked for (`/system_stats`) since the job
  // started, for two seconds at most. A job on a card takes tens of seconds and is sampled many times, whatever the
  // harness does beside it; a fake one takes milliseconds, and in round two's order the harness's own work while it
  // draws, the picture before it written to disk and draw.json with it, can outlast it (local/action-draw.ts
  // `drawAhead`).
  untilSampled?: boolean;
  // How long the websocket's handshake is held back. There is no grace: a job submitted before its socket is open
  // is told nothing of its start, as on the real server.
  openDelayMs?: number;
  // A job with at least this many references fails as a card out of memory does; the jobs numbered here (from 1, in
  // the order they were submitted) fail with an error that is not an OOM.
  oomAtReferences?: number; failJobs?: number[];
  // A job with at least this many references gets one "loaded partially" line in the log.
  partialLoadAtReferences?: number;
  // Whether a job after the first is told that its loader nodes came from the cache.
  loadersCached?: boolean;
  // A word every saved picture carries in its metadata beside the pixels, where ComfyUI writes the prompt: once
  // \u-escaped in a tEXt chunk, as its JSON does, and once as UTF-8 in an iTXt chunk. The action dry run's marker, so
  // that a copy kept with its metadata is found by the search for it.
  marker?: string;
  // Whether `/prompt` refuses a graph whose loader names a file nobody uploaded, as the real server's validation does.
  requireUploads?: boolean;
  // The network to the server going down for `ms`, once each, at a moment of the job numbered `job`: before its submit
  // is answered (`prompt`), once it has started (`start`), halfway through its picture's download (`view`), or once
  // the delete of its record is answered (`delete`). Every connection is cut and the port refuses new ones, as a
  // tunnel whose ssh has died does; the jobs go on, as they do on the card.
  drops?: { at: 'prompt' | 'start' | 'view' | 'delete'; job: number; ms: number }[];
  // The server's command line on /system_stats, and lines its log has from its start (the pilot's Triton evidence).
  argv?: string[]; startupLog?: string[];
  // Whether a picture's pixels follow from the graph it was drawn from alone, as on a card that draws the same inputs
  // alike, rather than from the job's number (the pilot's determinism check, local/image-pilot.ts).
  picturesByGraph?: boolean;
};
// A request as the server saw it, for a test to assert on the order of things: the job it concerns, when there is one.
export type FakeCall = { method: string; path: string; id?: string };
// What a job was, for a test to assert on. Never its text. `slots`: each reference slot of the encoder in slot order,
// the file on the loader behind it, the size a scale node between them hands on (`null` without one), and the
// rectangle an ImageCrop between the loader and the scale node cuts (`null` without one). `images`: each picture a
// saving node wrote, with its size.
export type FakeJob = { references: number; width: number; height: number; cached: number; outcome: 'success' | 'error' | 'interrupted';
  slots: { slot: number; file: string; scaled: { width: number; height: number } | null; cropped: { x: number; y: number; width: number; height: number } | null }[];
  images: { node: string; width: number; height: number }[] } & MaskedJob;

// A mask the pinned mask nodes make (comfy_extras/nodes_mask.py at 73c9bad4), computed as they compute it: SolidMask
// fills, MaskComposite adds, subtracts or multiplies its source into its destination at x, y and clamps the whole to
// [0, 1], FeatherMask ramps each edge in, the i-th pixel from it by (i + 1) / n. Any other node or operation gives no
// mask, never a guessed one.
type Mask = { width: number; height: number; data: Float32Array };
function maskOf(graph: Graph, link: unknown): Mask | undefined {
  const node = Array.isArray(link) ? graph[String(link[0])] : undefined;
  const at = (key: string) => Number(node?.inputs[key]);
  if (node?.class_type === 'SolidMask') return { width: at('width'), height: at('height'), data: new Float32Array(at('width') * at('height')).fill(at('value')) };
  const into = maskOf(graph, node?.inputs[node?.class_type === 'FeatherMask' ? 'mask' : 'destination']);
  const op = String(node?.inputs.operation);
  if (!into || (node?.class_type !== 'FeatherMask' && !(node?.class_type === 'MaskComposite' && ['add', 'subtract', 'multiply'].includes(op)))) return undefined;
  const out = { ...into, data: new Float32Array(into.data) }, w = out.width, h = out.height;
  if (node.class_type === 'FeatherMask') {
    const [left, right, top, bottom] = [Math.min(at('left'), w), Math.min(at('right'), w), Math.min(at('top'), h), Math.min(at('bottom'), h)];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      out.data[y * w + x] *= (x < left ? (x + 1) / left : 1) * (w - 1 - x < right ? (w - x) / right : 1)
        * (y < top ? (y + 1) / top : 1) * (h - 1 - y < bottom ? (h - y) / bottom : 1);
    }
    return out;
  }
  const from = maskOf(graph, node.inputs.source);
  if (!from) return undefined;
  for (let y = at('y'); y < Math.min(at('y') + from.height, h); y++) for (let x = at('x'); x < Math.min(at('x') + from.width, w); x++) {
    const a = out.data[y * w + x], b = from.data[(y - at('y')) * from.width + x - at('x')];
    out.data[y * w + x] = Math.min(1, Math.max(0, op === 'add' ? a + b : op === 'subtract' ? a - b : a * b));
  }
  return out;
}
// What a test reads of a mask: its size, the pixels above 0 and at 1, and the box round those above 0.
export type MaskSummary = { width: number; height: number; nonzero: number; full: number; bounds: [number, number, number, number] | null };
function summaryOf(mask: Mask | undefined): MaskSummary | null {
  if (!mask) return null;
  let nonzero = 0, full = 0, left = mask.width, top = mask.height, right = 0, bottom = 0;
  mask.data.forEach((value, i) => {
    if (value <= 0) return;
    const x = i % mask.width, y = Math.floor(i / mask.width);
    nonzero++;
    if (value >= 1) full++;
    [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x + 1), Math.max(bottom, y + 1)];
  });
  return { width: mask.width, height: mask.height, nonzero, full, bounds: nonzero ? [left, top, right, bottom] : null };
}
// `start`: the upload the sampler's latent was encoded from (VAEEncode), `noiseMask` the mask SetLatentNoiseMask put
// on it, and each ImageCompositeMasked with the upload behind its destination and its mask.
export type MaskedJob = { start: string | null; noiseMask: MaskSummary | null;
  composites: { node: string; destination: string | null; mask: MaskSummary | null }[] };

const GIB = 1024 ** 3;

// The nodes in the order the server runs them: every input's node before the node itself.
function executionOrder(graph: Graph): string[] {
  const out: string[] = [];
  const visit = (id: string) => {
    if (out.includes(id) || !graph[id]) return;
    for (const value of Object.values(graph[id].inputs)) if (Array.isArray(value)) visit(String(value[0]));
    out.push(id);
  };
  Object.keys(graph).sort((a, b) => Number(a) - Number(b)).forEach(visit);
  return out;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const pngChunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
};
// A flat grey picture; the first pixels carry the job's number and the node's, so that no two pictures have the same
// bytes. `marker` goes into the metadata, as `FakeComfyOptions.marker` says.
export function greyPng(width: number, height: number, number: number, node = 0, marker?: string): Buffer {
  const row = Buffer.alloc(1 + width * 3, 60 + (number * 37) % 160);
  row[0] = 0;
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  rows[1] = (number >> 8) & 255;
  rows[2] = number & 255;
  rows[3] = node & 255;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const escaped = JSON.stringify({ fake: `the graph a saving node writes here${marker ? ` ${marker}` : ''}` })
    .replace(/[\u0080-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', header), pngChunk('tEXt', Buffer.from(`prompt\0${escaped}`, 'latin1')),
    ...(marker ? [pngChunk('iTXt', Buffer.concat([Buffer.from('parameters\0\0\0\0\0', 'latin1'), Buffer.from(marker, 'utf8')]))] : []),
    pngChunk('IDAT', deflateSync(rows, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
}

// The server's half of a websocket (RFC 6455), as much of it as ComfyUI's messages need: the handshake, unmasked
// text frames, and an answer to the client's close.
function acceptSocket(request: IncomingMessage, socket: Duplex) {
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (chunk: Buffer) => { if ((chunk[0] & 0x0f) === 8) { if (socket.writable) socket.end(Buffer.from([0x88, 0])); else socket.destroy(); } });
  return (message: object) => {
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    if (socket.writable) socket.write(Buffer.concat([head, data]));
  };
}

type Job = { id: string; number: number; clientId: string; graph: Graph; stop: AbortController };

export async function startFakeComfy(initial: FakeComfyOptions = {}) {
  const options: FakeComfyOptions = { jobMs: 40, referenceMs: 5, loadersCached: true, ...initial };
  const jobs: FakeJob[] = [];
  const history = new Map<string, object>();
  const files = new Map<string, Buffer>();
  const speakers = new Map<string, (message: object) => void>();
  const sockets = new Set<Duplex>();
  const queue: Job[] = [];
  const log: { t: string; m: string }[] = [];
  const uploads: string[] = [];
  const uploaded = new Map<string, Buffer>();
  const calls: FakeCall[] = [];
  // Each job's number by its id, and each file's job.
  const numbers = new Map<string, number>(), owners = new Map<string, string>();
  let running: Job | undefined;
  // `held`: the most jobs the server has held at once, waiting and drawing, as each submit found them. The harness
  // sends a job only once the one before it is over (local/action-draw.ts `drawAhead`), so for it this stays at 1.
  let count = 0, lines = 0, held = 0;
  // How often /system_stats has been asked, and the jobs waiting for the next time (`untilSampled`): each is woken
  // with true, or with false when its job is stopped.
  let sampled = 0;
  const hearing = new Set<() => void>();
  const nextSample = (job: Job) => new Promise<boolean>(done => {
    const end = (took: boolean) => { clearTimeout(timer); hearing.delete(wake); job.stop.signal.removeEventListener('abort', stop); done(took); };
    const wake = () => end(true), stop = () => end(false);
    const timer = setTimeout(wake, 2000);
    timer.unref();
    hearing.add(wake);
    job.stop.signal.addEventListener('abort', stop, { once: true });
  });
  // app/logger.py keeps the last 300 lines, each stamped to the microsecond.
  const say = (m: string) => {
    log.push({ t: new Date().toISOString().replace('Z', String(++lines % 1000).padStart(3, '0')), m: `${m}\n` });
    if (log.length > 300) log.shift();
  };
  for (const line of options.startupLog ?? []) say(line);
  const tell = (job: Job, type: string, data: object) => speakers.get(job.clientId)?.({ type, data: { ...data, prompt_id: job.id } });
  // A drop (`FakeComfyOptions.drops`): the port stops listening and every open connection is cut, the sockets' too;
  // after `ms` the server listens on the same port again.
  let port = 0, down: Promise<void> = Promise.resolve(), timer: NodeJS.Timeout | undefined;
  const fired = new Set<object>();
  const dropAt = (at: string, job: number) => {
    const drop = options.drops?.find(one => one.at === at && one.job === job && !fired.has(one));
    if (!drop) return false;
    fired.add(drop);
    down = new Promise<void>(back => {
      server.close();
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      timer = setTimeout(() => { timer = undefined; server.listen(port, '127.0.0.1', () => back()); }, drop.ms);
    });
    return true;
  };

  async function run(job: Job) {
    const began = performance.now(), sampledBefore = sampled;
    const graph = job.graph;
    const order = executionOrder(graph);
    const cached = options.loadersCached && job.number > 1 ? order.filter(id => /Loader/.test(graph[id].class_type)) : [];
    const references = Object.values(graph).filter(node => node.class_type === 'LoadImage').length;
    const sampler = Object.values(graph).find(node => 'seed' in node.inputs || 'noise_seed' in node.inputs);
    const source = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
    const noised = source(sampler?.inputs.latent_image);
    const latent = noised?.class_type === 'SetLatentNoiseMask' ? source(noised.inputs.samples) : noised;
    // A latent the VAE encoded from an uploaded picture has that picture's size (local/image-t-probe.ts's latent starts).
    const encoded = latent?.class_type === 'VAEEncode' ? source(latent.inputs.pixels) : undefined;
    const start = encoded?.class_type === 'LoadImage' ? uploaded.get(String(encoded.inputs.image)) : undefined;
    const { width, height } = start ? pngSize(start) : { width: Number(latent?.inputs.width ?? 1024), height: Number(latent?.inputs.height ?? 1024) };
    const fileBehind = (link: unknown) => { const node = source(link); return node?.class_type === 'LoadImage' ? String(node.inputs.image) : null; };
    const masked: MaskedJob = { start: latent?.class_type === 'VAEEncode' ? fileBehind(latent.inputs.pixels) : null,
      noiseMask: noised?.class_type === 'SetLatentNoiseMask' ? summaryOf(maskOf(graph, noised.inputs.mask)) : null,
      composites: Object.entries(graph).filter(([, node]) => node.class_type === 'ImageCompositeMasked')
        .map(([node, one]) => ({ node, destination: fileBehind(one.inputs.destination), mask: summaryOf(maskOf(graph, one.inputs.mask)) })) };
    // What a node hands on is the size of: a scale node's own, a crop's, an uploaded file's, a composite's
    // destination's, and the latent's for the rest. ImageCrop (comfy_extras/nodes_images.py at 73c9bad4) keeps its
    // corner inside the picture and cuts its rectangle at the picture's edge.
    const cropOf = (node: Graph[string]) => {
      const from = sizeOf(source(node.inputs.image));
      const x = Math.min(Number(node.inputs.x), from.width - 1), y = Math.min(Number(node.inputs.y), from.height - 1);
      return { x, y, width: Math.min(Number(node.inputs.width), from.width - x), height: Math.min(Number(node.inputs.height), from.height - y) };
    };
    const sizeOf = (node: Graph[string] | undefined): { width: number; height: number } => {
      if (node?.class_type === 'ImageScale') return { width: Number(node.inputs.width), height: Number(node.inputs.height) };
      if (node?.class_type === 'ImageCrop') { const { width, height } = cropOf(node); return { width, height }; }
      if (node?.class_type === 'ImageCompositeMasked') return sizeOf(source(node.inputs.destination));
      const file = node?.class_type === 'LoadImage' ? uploaded.get(String(node.inputs.image)) : undefined;
      return file ? pngSize(file) : { width, height };
    };
    const slots = Object.values(graph).flatMap(node => Object.entries(node.inputs).flatMap(([key, value]) => {
      const slot = /^images\.image_(\d+)$/.exec(key);
      const linked = source(value);
      const scale = linked?.class_type === 'ImageScale' ? linked : undefined;
      const behind = scale ? source(scale.inputs.image) : linked;
      const crop = behind?.class_type === 'ImageCrop' ? behind : undefined;
      const loader = crop ? source(crop.inputs.image) : behind;
      return slot && loader ? [{ slot: Number(slot[1]), file: String(loader.inputs.image), scaled: scale ? sizeOf(scale) : null,
        cropped: crop ? cropOf(crop) : null }] : [];
    })).sort((a, b) => a.slot - b.slot);
    const images: FakeJob['images'] = [];
    const messages: [string, object][] = [];
    const record = (type: string, data: object) => { messages.push([type, { ...data, prompt_id: job.id }]); tell(job, type, data); };
    record('execution_start', { timestamp: Date.now() });
    record('execution_cached', { nodes: cached, timestamp: Date.now() });
    dropAt('start', job.number);
    const outputs: Record<string, { images: { filename: string; subfolder: string; type: string }[] }> = {};
    let outcome: FakeJob['outcome'] = 'success';
    const ran: string[] = [];
    for (const id of order.filter(one => !cached.includes(one))) {
      const type = graph[id].class_type;
      tell(job, 'executing', { node: id, display_node: id });
      if (/Sampler/.test(type)) {
        const oom = options.oomAtReferences !== undefined && references >= options.oomAtReferences;
        if (oom || options.failJobs?.includes(job.number)) {
          outcome = 'error';
          if (oom) say('!!! Exception during processing !!! Allocation on device');
          record('execution_error', { node_id: id, node_type: type, executed: ran, exception_message: oom ? 'Allocation on device' : 'synthetic failure',
            exception_type: oom ? 'torch.OutOfMemoryError' : 'RuntimeError', traceback: [], current_inputs: {}, current_outputs: {}, timestamp: Date.now() });
          break;
        }
        if (options.partialLoadAtReferences !== undefined && references >= options.partialLoadAtReferences) {
          say('loaded partially; 21000.00 MB usable, 10000.00 MB loaded, 2000.00 MB offloaded, 1024.00 MB buffer reserved, lowvram patches: 0');
        }
        // `/interrupt` ends the wait, as the real server stops a job between two of its steps.
        let took = await delay((options.jobMs ?? 0) + (options.referenceMs ?? 0) * references, true, { signal: job.stop.signal }).catch(() => false);
        if (took && options.untilSampled && sampled === sampledBefore) took = await nextSample(job);
        if (!took) {
          outcome = 'interrupted';
          record('execution_interrupted', { node_id: id, node_type: type, executed: ran, timestamp: Date.now() });
          break;
        }
      }
      ran.push(id);
      if (type === 'SaveImage' || type === 'PreviewImage') {
        const file = { filename: `fake_${String(job.number).padStart(5, '0')}_${id}_.png`, subfolder: '', type: type === 'SaveImage' ? 'output' : 'temp' };
        const size = sizeOf(source(graph[id].inputs.images));
        const drawn = options.picturesByGraph ? createHash('sha256').update(JSON.stringify(graph)).digest().readUInt16BE(0) : job.number;
        files.set(file.filename, greyPng(size.width, size.height, drawn, Number(id) || 0, options.marker));
        owners.set(file.filename, job.id);
        images.push({ node: id, ...size });
        outputs[id] = { images: [file] };
        tell(job, 'executed', { node: id, display_node: id, output: outputs[id] });
      }
    }
    if (outcome === 'success') record('execution_success', { timestamp: Date.now() });
    history.set(job.id, { prompt: [job.number, job.id, {}, {}, []], outputs,
      status: { status_str: outcome === 'success' ? 'success' : 'error', completed: outcome === 'success', messages }, meta: {} });
    say(`Prompt executed in ${((performance.now() - began) / 1000).toFixed(2)} seconds`);
    jobs.push({ references, width, height, cached: cached.length, outcome, slots, images, ...masked });
    // The record is written before the socket hears the job is over (main.py), and a delete sent then finds it.
    tell(job, 'executing', { node: null });
  }
  const pump = () => {
    if (running || !queue.length) return;
    running = queue.shift()!;
    void run(running).finally(() => { running = undefined; pump(); });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const read = async () => { const parts: Buffer[] = []; for await (const part of request) parts.push(part as Buffer); return Buffer.concat(parts); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      const call: FakeCall = { method: request.method ?? 'GET', path: url.pathname };
      calls.push(call);
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const asked = JSON.parse((await read()).toString('utf8')) as { prompt?: Graph; client_id?: unknown; prompt_id?: unknown };
        if (!asked.prompt || typeof asked.prompt !== 'object') { response.statusCode = 400; return json({ error: 'no prompt' }); }
        const missing = Object.values(asked.prompt).some(node => node.class_type === 'LoadImage' && !uploaded.has(String(node.inputs.image)));
        if (options.requireUploads && missing) { response.statusCode = 400; return json({ error: { type: 'prompt_outputs_failed_validation' }, node_errors: {} }); }
        // The id the client sent, as the pinned server takes one (server.py), or one of its own.
        const number = ++count;
        const id = typeof asked.prompt_id === 'string' && asked.prompt_id ? asked.prompt_id : `fake-${number}`;
        const job = { id, number, clientId: String(asked.client_id ?? ''), graph: asked.prompt, stop: new AbortController() };
        call.id = id;
        numbers.set(id, number);
        say('got prompt');
        queue.push(job);
        held = Math.max(held, queue.length + (running ? 1 : 0));
        pump();
        // The job is on the card, and its answer is lost with the connection.
        if (dropAt('prompt', number)) return;
        return json({ prompt_id: job.id, number: job.number, node_errors: {} });
      }
      if (request.method === 'POST' && url.pathname === '/upload/image') {
        const form = await new Response(await read(), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
        const file = form.get('image') as File | null;
        if (!file) { response.statusCode = 400; return response.end(); }
        uploads.push(file.name);
        uploaded.set(file.name, Buffer.from(await file.arrayBuffer()));
        return json({ name: file.name, subfolder: '', type: 'input' });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        const asked = JSON.parse((await read()).toString('utf8')) as { delete?: string[]; clear?: boolean };
        if (asked.clear) history.clear();
        for (const id of asked.delete ?? []) history.delete(id);
        call.id = asked.delete?.[0];
        const number = call.id === undefined ? undefined : numbers.get(call.id);
        response.setHeader('content-type', 'application/json');
        return response.end('{}', () => { if (number !== undefined) dropAt('delete', number); });
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        call.id = id;
        return json(history.has(id) ? { [id]: history.get(id) } : {});
      }
      if (url.pathname === '/view' && files.has(String(url.searchParams.get('filename')))) {
        const name = String(url.searchParams.get('filename'));
        const bytes = files.get(name)!;
        call.id = owners.get(name);
        response.setHeader('content-type', 'image/png');
        response.setHeader('content-length', bytes.length);
        const number = call.id === undefined ? undefined : numbers.get(call.id);
        // Half the picture, and then the network goes.
        if (number !== undefined && options.drops?.some(one => one.at === 'view' && one.job === number && !fired.has(one))) {
          return response.write(bytes.subarray(0, bytes.length >> 1), () => dropAt('view', number));
        }
        return response.end(bytes);
      }
      if (url.pathname === '/system_stats') {
        sampled++;
        for (const wake of hearing) wake();
        // The shape comfy/model_management.py reports, with fixed numbers.
        return json({ system: { os: 'posix', ram_total: 64 * GIB, ram_free: 50 * GIB, comfyui_version: 'fake', python_version: 'fake',
          pytorch_version: 'fake', embedded_python: false, argv: options.argv ?? [] },
        devices: [{ name: 'fake card', type: 'cuda', index: 0, vram_total: 32 * GIB, vram_free: 10 * GIB,
          torch_vram_total: 23 * GIB, torch_vram_free: 1 * GIB }] });
      }
      if (url.pathname === '/internal/logs/raw') return json({ entries: log, size: { cols: 120, rows: 40 } });
      if (url.pathname === '/queue' && request.method === 'GET') {
        return json({ queue_running: running ? [[running.number, running.id, {}, {}, []]] : [],
          queue_pending: queue.map(job => [job.number, job.id, {}, {}, []]) });
      }
      if (url.pathname === '/queue' && request.method === 'POST') {
        const asked = JSON.parse((await read()).toString('utf8')) as { delete?: string[] };
        for (const id of asked.delete ?? []) {
          const at = queue.findIndex(job => job.id === id);
          if (at >= 0) queue.splice(at, 1);
        }
        return json({});
      }
      if (url.pathname === '/interrupt' && request.method === 'POST') {
        // Only the job named, and only while it is the one being drawn; without a name, whatever is (server.py).
        const body = (await read()).toString('utf8');
        const asked = (body ? JSON.parse(body) : {}) as { prompt_id?: unknown };
        call.id = typeof asked.prompt_id === 'string' ? asked.prompt_id : undefined;
        if (call.id === undefined || running?.id === call.id) running?.stop.abort();
        return json({});
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const clientId = new URL(request.url!, 'http://127.0.0.1').searchParams.get('clientId') ?? '';
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    setTimeout(() => {
      if (socket.destroyed) return;
      const send = acceptSocket(request, socket);
      // The greeting every socket gets first (server.py); it names no job.
      send({ type: 'status', data: { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } }, sid: clientId } });
      speakers.set(clientId, send);
      socket.on('close', () => { if (speakers.get(clientId) === send) speakers.delete(clientId); });
    }, options.openDelayMs ?? 0);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, jobs, uploads, options, calls,
    get mostHeld() { return held; },
    // Once the server listens again after the last drop.
    whenUp: () => down,
    close: () => new Promise<void>(done => {
      if (timer) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return done();
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
