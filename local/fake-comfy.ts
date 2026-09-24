// A stand-in for ComfyUI on the loopback interface, so that an identity run can be rehearsed end to end before a card
// is rented (local/image-identity.ts `dry-run`). It keeps the narrow contract local/image-batch.ts relies on: the
// routes it calls, one job at a time, and the websocket messages the pinned revision sends, in the order it sends
// them and only to a socket that is open when they are sent. It models no card: no speed, no cache, no memory. What
// it says about those — how long a job takes, which loaders the cache answered, a failure, an OOM, a partial load in
// the log, the numbers on /system_stats — is fixed or set by the knobs below, and says nothing about any card. A
// picture is a flat grey PNG of the latent's size with a text chunk beside the pixels, as a saving node writes one.
// No prompt it is sent is printed or kept past its job.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import type { Graph } from './image-batch.ts';

// The knobs, read at every job and every connection, so that a test can turn one between two rows.
export type FakeComfyOptions = {
  // How long the sampler of a job takes, and how much longer per reference picture.
  jobMs?: number; referenceMs?: number;
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
};
// What a job was, for a test to assert on. Never its text.
export type FakeJob = { references: number; width: number; height: number; cached: number; outcome: 'success' | 'error' | 'interrupted' };

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
// A flat grey picture; the first pixel carries the job's number, so that no two jobs draw the same bytes.
export function greyPng(width: number, height: number, number: number): Buffer {
  const row = Buffer.alloc(1 + width * 3, 60 + (number * 37) % 160);
  row[0] = 0;
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  rows[1] = (number >> 8) & 255;
  rows[2] = number & 255;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([SIGNATURE, pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('prompt\0{"fake":"the graph a saving node writes here"}', 'latin1')),
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
  let running: Job | undefined;
  let count = 0, lines = 0;
  // app/logger.py keeps the last 300 lines, each stamped to the microsecond.
  const say = (m: string) => {
    log.push({ t: new Date().toISOString().replace('Z', String(++lines % 1000).padStart(3, '0')), m: `${m}\n` });
    if (log.length > 300) log.shift();
  };
  const tell = (job: Job, type: string, data: object) => speakers.get(job.clientId)?.({ type, data: { ...data, prompt_id: job.id } });

  async function run(job: Job) {
    const began = performance.now();
    const graph = job.graph;
    const order = executionOrder(graph);
    const cached = options.loadersCached && job.number > 1 ? order.filter(id => /Loader/.test(graph[id].class_type)) : [];
    const references = Object.values(graph).filter(node => node.class_type === 'LoadImage').length;
    const sampler = Object.values(graph).find(node => 'seed' in node.inputs || 'noise_seed' in node.inputs);
    const link = sampler?.inputs.latent_image;
    const latent = Array.isArray(link) ? graph[String(link[0])]?.inputs : undefined;
    const width = Number(latent?.width ?? 1024), height = Number(latent?.height ?? 1024);
    const messages: [string, object][] = [];
    const record = (type: string, data: object) => { messages.push([type, { ...data, prompt_id: job.id }]); tell(job, type, data); };
    record('execution_start', { timestamp: Date.now() });
    record('execution_cached', { nodes: cached, timestamp: Date.now() });
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
        const took = await delay((options.jobMs ?? 0) + (options.referenceMs ?? 0) * references, true, { signal: job.stop.signal }).catch(() => false);
        if (!took) {
          outcome = 'interrupted';
          record('execution_interrupted', { node_id: id, node_type: type, executed: ran, timestamp: Date.now() });
          break;
        }
      }
      ran.push(id);
      if (type === 'SaveImage' || type === 'PreviewImage') {
        const file = { filename: `fake_${String(job.number).padStart(5, '0')}_.png`, subfolder: '', type: type === 'SaveImage' ? 'output' : 'temp' };
        files.set(file.filename, greyPng(width, height, job.number));
        outputs[id] = { images: [file] };
        tell(job, 'executed', { node: id, display_node: id, output: outputs[id] });
      }
    }
    if (outcome === 'success') record('execution_success', { timestamp: Date.now() });
    history.set(job.id, { prompt: [job.number, job.id, {}, {}, []], outputs,
      status: { status_str: outcome === 'success' ? 'success' : 'error', completed: outcome === 'success', messages }, meta: {} });
    say(`Prompt executed in ${((performance.now() - began) / 1000).toFixed(2)} seconds`);
    jobs.push({ references, width, height, cached: cached.length, outcome });
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
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const asked = JSON.parse((await read()).toString('utf8')) as { prompt?: Graph; client_id?: unknown };
        if (!asked.prompt || typeof asked.prompt !== 'object') { response.statusCode = 400; return json({ error: 'no prompt' }); }
        const job = { id: `fake-${++count}`, number: count, clientId: String(asked.client_id ?? ''), graph: asked.prompt, stop: new AbortController() };
        say('got prompt');
        queue.push(job);
        pump();
        return json({ prompt_id: job.id, number: job.number, node_errors: {} });
      }
      if (request.method === 'POST' && url.pathname === '/upload/image') {
        const form = await new Response(await read(), { headers: { 'content-type': String(request.headers['content-type']) } }).formData();
        const file = form.get('image') as File | null;
        if (!file) { response.statusCode = 400; return response.end(); }
        uploads.push(file.name);
        return json({ name: file.name, subfolder: '', type: 'input' });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        const asked = JSON.parse((await read()).toString('utf8')) as { delete?: string[]; clear?: boolean };
        if (asked.clear) history.clear();
        for (const id of asked.delete ?? []) history.delete(id);
        return json({});
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        return json(history.has(id) ? { [id]: history.get(id) } : {});
      }
      if (url.pathname === '/view' && files.has(String(url.searchParams.get('filename')))) {
        response.setHeader('content-type', 'image/png');
        return response.end(files.get(String(url.searchParams.get('filename'))));
      }
      if (url.pathname === '/system_stats') {
        // The shape comfy/model_management.py reports, with fixed numbers.
        return json({ system: { os: 'posix', ram_total: 64 * GIB, ram_free: 50 * GIB, comfyui_version: 'fake', python_version: 'fake',
          pytorch_version: 'fake', embedded_python: false, argv: [] },
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
        await read();
        running?.stop.abort();
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
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, jobs, uploads, options,
    close: () => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
  };
}
