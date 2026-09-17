import http from 'node:http';
import net from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { ModelError } from './model-error.mjs';

const MAX_BYTES = 1_000_000;
const safeCode = error => /^[a-z_]{1,40}$/.test(error?.code ?? '') ? error.code : 'background_failed';
const socketLive = path => new Promise((resolve, reject) => {
  const socket = net.connect(path);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', error => {
    if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false); else reject(error);
  });
});
async function jsonBody(stream) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new ModelError('background_request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ModelError('background_invalid_request'); }
}
function validateRequest(request) {
  if (!request || typeof request.system !== 'string' || !Array.isArray(request.messages)
      || !request.messages.length || request.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')
      || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 8192) {
    throw new ModelError('background_invalid_request');
  }
  return request;
}

// Private Unix socket: no network listener and no bot database access for the
// experiment client. Only background inference and content-free status exist.
export async function serveBackground({ socketPath, scheduler, status }) {
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket() || await socketLive(socketPath)) throw new ModelError('background_socket_in_use');
    unlinkSync(socketPath);
  }
  const requests = new Set();
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    requests.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let body;
      if (req.method === 'GET' && req.url === '/status') body = { ...status(), queue: scheduler.snapshot() };
      else if (req.method === 'POST' && req.url === '/generate') {
        const request = validateRequest(await jsonBody(req));
        body = await scheduler.background.generate(request, { signal: controller.signal });
      } else throw new ModelError('background_invalid_request');
      if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    } catch (error) {
      if (!res.destroyed) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: safeCode(error) })); }
    } finally { requests.delete(controller); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  return { async close() {
    for (const controller of requests) controller.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}

export function createBackgroundClient({ socketPath, model, timeoutMs = 600000 }) {
  async function call(path, body, signal) {
    const timer = AbortSignal.timeout(timeoutMs);
    const current = signal ? AbortSignal.any([signal, timer]) : timer;
    try {
      current.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path, method: body ? 'POST' : 'GET',
          headers: { 'Content-Type': 'application/json' }, signal: current }, async res => {
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
  return {
    status: controls => call('/status', null, controls?.signal),
    async check(controls) {
      const state = await call('/status', null, controls?.signal);
      if (state.model !== model) throw new ModelError('unexpected_model');
      return state;
    },
    generate: (request, controls = {}) => call('/generate', request, controls.signal),
  };
}
