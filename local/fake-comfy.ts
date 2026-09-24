// A stand-in for ComfyUI on the loopback interface, as gpu/image-serve.sh runs it on the picture card, so that an
// identity run can be rehearsed end to end before a card is rented (local/image-identity.ts `dry-run`). It has the
// routes local/image-batch.ts calls and the websocket messages the pinned revision sends, in the order it sends them;
// it draws one job at a time; its cache answers a node whose inputs and upstream it saw in the job before, as the
// server's does; and its card's video memory, host RAM and log move with the job, a four-reference job spilling into
// RAM and logging a partial load. It runs no model: a picture is a flat grey PNG of the latent's size with a text
// chunk beside the pixels, as a saving node writes one. No prompt it is sent is printed or kept past its job.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import type { Graph } from './image-batch.ts';

export type FakeComfyOptions = {
  // Milliseconds per unit of work (`work`): 1 rehearses a set in seconds, 0 answers at once.
  msPerUnit?: number;
  // A job with this many reference pictures or more runs out of video memory in the sampler, as a card does.
  oomAtReferences?: number;
};
// What a job was, for a test to assert on. Never its text.
export type FakeJob = { references: number; width: number; height: number; cached: number; outcome: 'success' | 'error' | 'interrupted' };

const MIB = 1024 * 1024;
const CARD_MIB = 32 * 1024, RAM_MIB = 64 * 1024, WEIGHTS_MIB = 12000, SPILL_MIB = 2048;
// Units of work by the kind of node, and what the card holds meanwhile over the weights the first job left on it.
// A reference costs the text encoder a vision pass and the sampler a longer sequence.
function work(type: string, references: number) {
  if (type === 'UNETLoader') return { units: 30, extraMiB: 0 };
  if (/Loader/.test(type)) return { units: 10, extraMiB: 0 };
  if (/TextEncode/.test(type)) return { units: 4 + 3 * references, extraMiB: 6000 + 350 * references };
  if (/Sampler/.test(type)) return { units: 40 + 6 * references, extraMiB: 7000 + 800 * references };
  if (/^VAEDecode/.test(type)) return { units: 5, extraMiB: 2000 };
  return { units: 1, extraMiB: 0 };
}

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
// A node's cache key: its type, its own inputs and the keys of the nodes it reads from.
function signatures(graph: Graph): Map<string, string> {
  const keys = new Map<string, string>();
  const key = (id: string): string => {
    const known = keys.get(id);
    if (known) return known;
    const inputs = Object.entries(graph[id].inputs).map(([name, value]) =>
      [name, Array.isArray(value) && graph[String(value[0])] ? key(String(value[0])) : value]);
    const made = createHash('sha256').update(JSON.stringify([graph[id].class_type, inputs])).digest('hex');
    keys.set(id, made);
    return made;
  };
  for (const id of Object.keys(graph)) key(id);
  return keys;
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
  socket.on('error', () => undefined);
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', (chunk: Buffer) => { if ((chunk[0] & 0x0f) === 8) { if (socket.writable) socket.end(Buffer.from([0x88, 0])); else socket.destroy(); } });
  return (message: object) => {
    const data = Buffer.from(JSON.stringify(message), 'utf8');
    const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    if (socket.writable) socket.write(Buffer.concat([head, data]));
  };
}

type Job = { id: string; number: number; clientId: string; graph: Graph; interrupted?: boolean };

export async function startFakeComfy(options: FakeComfyOptions = {}) {
  const msPerUnit = options.msPerUnit ?? 1;
  const jobs: FakeJob[] = [];
  const history = new Map<string, object>();
  const files = new Map<string, Buffer>();
  const speakers = new Map<string, (message: object) => void>();
  const sockets = new Set<Duplex>();
  const queue: Job[] = [];
  const log: { t: string; m: string }[] = [];
  const card = { weights: false, extraMiB: 0, spillMiB: 0, busy: false };
  const uploads: string[] = [];
  let running: Job | undefined;
  let previous = new Map<string, string>();
  let count = 0, lines = 0;
  // app/logger.py keeps the last 300 lines, each stamped to the microsecond.
  const say = (m: string) => {
    log.push({ t: new Date().toISOString().replace('Z', String(++lines % 1000).padStart(3, '0')), m: `${m}\n` });
    if (log.length > 300) log.shift();
  };
  const tell = (job: Job, type: string, data: object) => speakers.get(job.clientId)?.({ type, data: { ...data, prompt_id: job.id } });

  async function run(job: Job) {
    // The card tells a job's news only to a socket that is there, and a client opens its socket before the submit.
    for (let waited = 0; !speakers.has(job.clientId) && waited < 200; waited += 5) await delay(5);
    const began = performance.now();
    const graph = job.graph;
    const order = executionOrder(graph);
    const keys = signatures(graph);
    const cached = order.filter(id => previous.get(id) === keys.get(id));
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
    card.busy = true;
    const ran: string[] = [];
    for (const id of order.filter(one => !cached.includes(one))) {
      const type = graph[id].class_type;
      if (job.interrupted) {
        outcome = 'interrupted';
        record('execution_interrupted', { node_id: id, node_type: type, executed: ran, timestamp: Date.now() });
        break;
      }
      tell(job, 'executing', { node: id, display_node: id });
      const cost = work(type, references);
      card.extraMiB = cost.extraMiB;
      if (/Loader/.test(type) && type !== 'LoadImage') card.weights = true;
      if (/Sampler/.test(type) && options.oomAtReferences !== undefined && references >= options.oomAtReferences) {
        outcome = 'error';
        say('!!! Exception during processing !!! Allocation on device');
        record('execution_error', { node_id: id, node_type: type, executed: ran, exception_message: 'Allocation on device',
          exception_type: 'torch.OutOfMemoryError', traceback: [], current_inputs: {}, current_outputs: {}, timestamp: Date.now() });
        break;
      }
      // Four references do not fit beside the weights: the cache node on `auto` moves the rest to pinned RAM.
      if (/Sampler/.test(type) && references >= 4) {
        card.spillMiB = SPILL_MIB;
        say(`loaded partially; 21000.00 MB usable, ${WEIGHTS_MIB - SPILL_MIB}.00 MB loaded, ${SPILL_MIB}.00 MB offloaded, 1024.00 MB buffer reserved, lowvram patches: 0`);
      }
      await delay(cost.units * msPerUnit);
      ran.push(id);
      if (type === 'SaveImage' || type === 'PreviewImage') {
        const file = { filename: `fake_${String(job.number).padStart(5, '0')}_.png`, subfolder: '', type: type === 'SaveImage' ? 'output' : 'temp' };
        files.set(file.filename, greyPng(width, height, job.number));
        outputs[id] = { images: [file] };
        tell(job, 'executed', { node: id, display_node: id, output: outputs[id] });
      }
    }
    card.busy = false;
    card.extraMiB = 0;
    card.spillMiB = 0;
    if (outcome === 'success') record('execution_success', { timestamp: Date.now() });
    previous = new Map([...keys].filter(([id]) => cached.includes(id) || ran.includes(id)));
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
        const job = { id: `fake-${++count}`, number: count, clientId: String(asked.client_id ?? ''), graph: asked.prompt };
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
        // As comfy/model_management.py reports it: `vram_free` counts what torch holds but is not using as free.
        const used = 400 + (card.weights ? WEIGHTS_MIB - card.spillMiB : 0) + card.extraMiB, held = card.busy ? 1024 : 512;
        return json({ system: { os: 'posix', ram_total: RAM_MIB * MIB, ram_free: (RAM_MIB - 5000 - card.spillMiB) * MIB,
          comfyui_version: 'fake', python_version: 'fake', pytorch_version: 'fake', embedded_python: false, argv: [] },
        devices: [{ name: 'fake card', type: 'cuda', index: 0, vram_total: CARD_MIB * MIB, vram_free: (CARD_MIB - used) * MIB,
          torch_vram_total: (used + held) * MIB, torch_vram_free: held * MIB }] });
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
        if (running) running.interrupted = true;
        return json({});
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const clientId = new URL(request.url!, 'http://127.0.0.1').searchParams.get('clientId') ?? '';
    sockets.add(socket);
    const send = acceptSocket(request, socket);
    // The greeting every socket gets first (server.py); it names no job.
    send({ type: 'status', data: { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } }, sid: clientId } });
    speakers.set(clientId, send);
    socket.on('close', () => { sockets.delete(socket); if (speakers.get(clientId) === send) speakers.delete(clientId); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, jobs, uploads,
    close: () => new Promise<void>(done => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
  };
}
