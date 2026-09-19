import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { ModelError, member } from './model-error.ts';
import type { Controls, GenerationResult, ModelRequest } from './model.ts';
import type { Scheduler } from './scheduler.ts';

// A body may be any JSON value; its fields are read as unknown.
type Json = { readonly [field: string]: unknown } | null;
const MAX_BYTES = 1_000_000;
// Codes are not type-checked: ModelError, Node errors and this server's error bodies
// carry string codes, and any code that is not a short identifier is replaced.
const safeCode = (error: unknown) => {
  const code = (error as { code?: string } | null | undefined)?.code ?? '';
  return /^[a-z_]{1,40}$/.test(code) ? code : 'background_failed';
};
const socketLive = (path: string) => new Promise<boolean>((resolve, reject) => {
  const socket = net.connect(path);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', (error: NodeJS.ErrnoException) => {
    if (member(['ECONNREFUSED', 'ENOENT'], error.code)) resolve(false); else reject(error);
  });
});
async function jsonBody(stream: AsyncIterable<Buffer>): Promise<Json> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new ModelError('background_request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ModelError('background_invalid_request'); }
}
function validateRequest(request: Json): ModelRequest {
  if (!request || typeof request.system !== 'string' || !Array.isArray(request.messages)
      || !request.messages.length || request.messages.some((m: Json) => !m || !member(['user', 'assistant'], m.role) || typeof m.content !== 'string')
      || typeof request.maxOutputTokens !== 'number' || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 8192) {
    throw new ModelError('background_invalid_request');
  }
  // Required fields are checked above; optional request fields pass through unchecked.
  return request as ModelRequest;
}

// Private Unix socket: no network listener and no bot database access for the
// experiment client. Only background inference and content-free status exist.
export async function serveBackground({ socketPath, scheduler, status }: {
  socketPath: string; scheduler: Scheduler<ModelRequest, unknown>; status: () => object;
}) {
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket() || await socketLive(socketPath)) throw new ModelError('background_socket_in_use');
    unlinkSync(socketPath);
  }
  const requests = new Set<AbortController>();
  // Open agent turns by the id this server gave them. A turn lives exactly as long as its control request stays open:
  // the agent closes it when the turn ends, and a lost agent process closes it too.
  const turns = new Map<string, ReturnType<typeof scheduler.agent.openTurn>>();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/agent/turn') {
      const id = randomUUID();
      const turn = scheduler.agent.openTurn();
      turns.set(id, turn);
      res.once('close', () => { turns.delete(id); turn.end(); });
      req.resume();
      res.writeHead(200, { 'X-Turn': id });
      res.flushHeaders();
      return;
    }
    const controller = new AbortController();
    requests.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let body: unknown;
      if (req.method === 'GET' && req.url === '/status') body = { ...status(), queue: scheduler.snapshot() };
      else if (req.method === 'POST' && (req.url === '/generate' || req.url === '/agent/generate')) {
        const request = validateRequest(await jsonBody(req));
        // An agent turn is real work and is not cut off by people; a probe is disposable (local/scheduler.ts).
        const agent = req.url === '/agent/generate';
        const id = req.headers['x-turn'];
        // A call for a turn that has ended or was never opened is refused: it must not continue under an old key.
        const turn = agent && typeof id === 'string' ? turns.get(id) : undefined;
        if (agent && id !== undefined && !turn) throw new ModelError('background_unavailable');
        const limit = req.headers['x-input-limit'];
        const inputLimitTokens = typeof limit === 'string' && /^\d{1,9}$/.test(limit) ? Number(limit) : undefined;
        if (limit !== undefined && inputLimitTokens === undefined) throw new ModelError('background_invalid_request');
        body = await (turn ?? (agent ? scheduler.agent : scheduler.background)).generate(request, { signal: controller.signal, inputLimitTokens });
      } else throw new ModelError('background_invalid_request');
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    } catch (error) {
      if (!res.destroyed) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: safeCode(error) })); }
    } finally { requests.delete(controller); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return { async close() {
    for (const controller of requests) controller.abort();
    server.closeAllConnections();
    // A close error is passed to resolve and ignored.
    await new Promise<unknown>(resolve => server.close(resolve));
  } };
}

export function createBackgroundClient({ socketPath, model, timeoutMs = 600000, work = 'probe' }: {
  socketPath: string; model: string; timeoutMs?: number; work?: 'probe' | 'agent';
}) {
  async function call(path: string, body: ModelRequest | null, signal: AbortSignal | undefined, turn?: string, inputLimitTokens?: number) {
    const timer = AbortSignal.timeout(timeoutMs);
    const current = signal ? AbortSignal.any([signal, timer]) : timer;
    try {
      current.throwIfAborted();
      return await new Promise<Json>((resolve, reject) => {
        const req = http.request({ socketPath, path, method: body ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json', ...(turn ? { 'X-Turn': turn } : {}),
            ...(inputLimitTokens === undefined ? {} : { 'X-Input-Limit': String(inputLimitTokens) }) }, signal: current }, async res => {
          try {
            const result = await jsonBody(res);
            if (res.statusCode !== 200) throw new ModelError(safeCode(result));
            resolve(result);
          } catch (error) { reject(error); }
        });
        req.once('error', () => reject(new ModelError(current.aborted ? 'cancelled' : 'background_unavailable')));
        req.end(body ? JSON.stringify(body) : undefined);
      });
    } catch (error) {
      if (signal?.aborted) throw new ModelError('cancelled');
      if (timer.aborted) throw new ModelError('background_timeout');
      throw error;
    }
  }
  // Responses come from the bot's own socket and are not validated beyond the model check.
  return {
    status: (controls?: Controls) => call('/status', null, controls?.signal),
    async check(controls?: Controls) {
      // This server's status body is an object.
      const state = (await call('/status', null, controls?.signal))!;
      if (state.model !== model) throw new ModelError('unexpected_model');
      return state;
    },
    // Opens an agent turn: the bot keeps its model slot for the turn's calls until `close` (local/scheduler.ts). The
    // turn's signal also closes it; the bot must answer within `openMs`.
    openTurn: (signal?: AbortSignal, openMs = 10_000) => new Promise<{ id: string; close(): void }>((resolve, reject) => {
      if (signal?.aborted) { reject(new ModelError('cancelled')); return; }
      const req = http.request({ socketPath, path: '/agent/turn', method: 'POST', signal }, res => {
        clearTimeout(timer);
        res.on('error', () => {});
        const id = res.headers['x-turn'];
        if (res.statusCode !== 200 || typeof id !== 'string') { req.destroy(); reject(new ModelError('background_unavailable')); return; }
        resolve({ id, close: () => req.destroy() });
      });
      const timer = setTimeout(() => req.destroy(), openMs);
      req.once('error', () => { clearTimeout(timer); reject(new ModelError(signal?.aborted ? 'cancelled' : 'background_unavailable')); });
      req.end();
    }),
    // `turn` is the id from openTurn. The input limit goes with the call, so the model server refuses an input over it
    // before generating, as it does for the bot's own calls.
    generate: (request: ModelRequest, controls: Controls & { turn?: string; inputLimitTokens?: number } = {}) =>
      call(work === 'agent' ? '/agent/generate' : '/generate', request, controls.signal, controls.turn, controls.inputLimitTokens) as Promise<GenerationResult>,
  };
}
