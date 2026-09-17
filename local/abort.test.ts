// The code each site reports for an external abort, an external AbortSignal.timeout and its own deadline.
// Synthetic only: a fake fetch, a stalled local node child and a private unix socket.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlama } from './llama.ts';
import { createClaude } from './claude.ts';
import type { Launch } from './claude.ts';
import { createScheduler } from './scheduler.ts';
import type { SchedulerOptions } from './scheduler.ts';
import { createBackgroundClient, serveBackground } from './background.ts';
import { ModelError } from './model-error.ts';
import type { ModelRequest } from './model.ts';

const request: ModelRequest = { system: 'Synthetic', messages: [{ role: 'user', content: 'Synthetic' }], maxOutputTokens: 256 };
// AbortSignal.timeout does not keep Node alive.
const keepAlive = (t: TestContext) => { const timer = setInterval(() => {}, 1000); t.after(() => clearInterval(timer)); };
const abortLater = (abort: (controller: AbortController) => void) => {
  const controller = new AbortController();
  setTimeout(() => abort(controller), 30);
  return controller.signal;
};
// llama always passes a signal to fetch.
const waitForAbort = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
  init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});
const stalledCli: Launch = (_command, _args, options) => spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], options);
const llamaConfig = { baseUrl: 'http://127.0.0.1:8080', model: 'synthetic', contextTokens: 8192, timeoutMs: 5000 };
// A provider that settles only when its scheduler slot aborts, rejecting with the slot's reason or its own error.
const waitingProvider = (error?: Error) => ({
  generate: (_request: ModelRequest, { signal }: { signal: AbortSignal }) => new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(error ?? signal.reason), { once: true });
  }),
});
async function backgroundSocket(t: TestContext, provider: ReturnType<typeof waitingProvider>, options: SchedulerOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-abort-'));
  const socketPath = join(directory, 'm.sock');
  const scheduler = createScheduler(provider, { quietMs: 0, ...options });
  const server = await serveBackground({ socketPath, scheduler, status: () => ({ model: 'm' }) });
  t.after(async () => { await server.close(); await scheduler.close(); rmSync(directory, { recursive: true, force: true }); });
  return socketPath;
}
function claudeProvider(t: TestContext, timeoutMs: number) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-abort-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return createClaude({ dbPath: join(directory, 'x.sqlite'), model: 'm', contextTokens: 65536, timeoutMs }, { launch: stalledCli });
}

const externals = [
  { kind: 'abort() without reason', signal: () => abortLater(c => c.abort()),
    llama: 'cancelled', claude: 'cancelled', background: 'cancelled', scheduler: 'cancelled' },
  { kind: "abort(ModelError('cancelled'))", signal: () => abortLater(c => c.abort(new ModelError('cancelled'))),
    llama: 'cancelled', claude: 'cancelled', background: 'cancelled', scheduler: 'cancelled' },
  { kind: "abort(ModelError('background_preempted'))", signal: () => abortLater(c => c.abort(new ModelError('background_preempted'))),
    llama: 'cancelled', claude: 'cancelled', background: 'cancelled', scheduler: 'cancelled' },
  { kind: 'AbortSignal.timeout', signal: () => AbortSignal.timeout(30),
    llama: 'timeout', claude: 'cancelled', background: 'cancelled', scheduler: 'cancelled' },
];

for (const { kind, signal, llama, claude, background, scheduler } of externals) {
  test(`llama direct: external ${kind} -> ${llama}`, async t => {
    keepAlive(t);
    await assert.rejects(createLlama(llamaConfig, { fetch: waitForAbort }).generate(request, { signal: signal() }), { code: llama });
  });
  test(`claude direct: external ${kind} -> ${claude}`, async t => {
    keepAlive(t);
    await assert.rejects(claudeProvider(t, 5000).generate(request, { signal: signal() }), { code: claude });
  });
  test(`background client: external ${kind} -> ${background}`, async t => {
    keepAlive(t);
    const socketPath = await backgroundSocket(t, waitingProvider());
    await assert.rejects(createBackgroundClient({ socketPath, model: 'm', timeoutMs: 5000 }).generate(request, { signal: signal() }), { code: background });
  });
  test(`scheduler foreground (the bot path): external ${kind} -> ${scheduler}, provider never sees the caller's signal`, async t => {
    keepAlive(t);
    let seen: AbortSignal | undefined;
    const external = signal();
    const provider = waitingProvider(new Error('provider noise'));
    const queue = createScheduler({ generate: (next: ModelRequest, slot: { signal: AbortSignal }) => {
      seen = slot.signal;
      return provider.generate(next, slot);
    } }, { quietMs: 0 });
    t.after(() => queue.close());
    await assert.rejects(queue.foreground.generate(request, { signal: external }), { code: scheduler });
    assert.notEqual(seen, external);
    assert.ok(seen!.reason instanceof ModelError);
  });
}

test('own deadlines: llama -> timeout, claude -> timeout, background client -> background_timeout', async t => {
  keepAlive(t);
  await assert.rejects(createLlama({ ...llamaConfig, timeoutMs: 30 }, { fetch: waitForAbort }).generate(request), { code: 'timeout' });
  await assert.rejects(claudeProvider(t, 60).generate(request), { code: 'timeout' });
  const socketPath = await backgroundSocket(t, waitingProvider());
  await assert.rejects(createBackgroundClient({ socketPath, model: 'm', timeoutMs: 60 }).generate(request), { code: 'background_timeout' });
});

test('scheduler-owned reasons survive whatever the provider throws: background_timeout via the socket as a wire code', async t => {
  keepAlive(t);
  const socketPath = await backgroundSocket(t, waitingProvider(new Error('provider noise')), { backgroundTimeoutMs: 40 });
  await assert.rejects(createBackgroundClient({ socketPath, model: 'm', timeoutMs: 5000 }).generate(request), { code: 'background_timeout' });
});
