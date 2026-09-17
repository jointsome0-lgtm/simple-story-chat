import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from './scheduler.ts';
import { createBackgroundClient, serveBackground } from './background.ts';
import type { ModelRequest } from './model.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const request: ModelRequest = { system: 'Synthetic', messages: [{ role: 'user', content: 'Synthetic' }], maxOutputTokens: 256 };
// The scheduler passes requests and results through, so the fake reads only what a test sends.
async function fixture(t: TestContext, generate: (request: unknown, controls: { signal: AbortSignal }) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-queue-'));
  const socketPath = join(directory, 'model.sock');
  const scheduler = createScheduler({ generate }, { quietMs: 0 });
  const server = await serveBackground({ socketPath, scheduler, status: () => ({ model: 'synthetic-model' }) });
  t.after(async () => { await server.close(); await scheduler.close(); rmSync(directory, { recursive: true, force: true }); });
  return { socketPath, scheduler, client: createBackgroundClient({ socketPath, model: 'synthetic-model', timeoutMs: 2000 }) };
}
test('private background socket returns bounded model results and content-free status', async t => {
  const f = await fixture(t, async () => ({ text: 'Synthetic response', finishReason: 'stop' }));
  assert.equal(statSync(f.socketPath).mode & 0o777, 0o600);
  assert.equal((await f.client.check()).model, 'synthetic-model');
  assert.equal((await f.client.generate(request)).text, 'Synthetic response');
  await assert.rejects(f.client.generate({ ...request, maxOutputTokens: 9000 }), { code: 'background_invalid_request' });
  const other = createBackgroundClient({ socketPath: f.socketPath, model: 'different-model' });
  await assert.rejects(other.check(), { code: 'unexpected_model' });
});
test('foreground work preempts a real socket request; only synthetic background may be retried', async t => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, (req, { signal }) => {
    if (req === 'foreground') return Promise.resolve('user result');
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started!();
    });
  });
  const low = f.client.generate(request);
  const rejection = assert.rejects(low, { code: 'background_preempted' });
  await ready;
  assert.equal(await f.scheduler.foreground.generate('foreground'), 'user result');
  await rejection;
});
test('disconnecting a background client cancels its request; no other process can steal a live socket', async t => {
  let started: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted: (() => void) | undefined;
  const stopped = new Promise<void>(resolve => { aborted = resolve; });
  const f = await fixture(t, (req, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted!(); reject(signal.reason); }, { once: true }); started!();
  }));
  await assert.rejects(serveBackground({ socketPath: f.socketPath, scheduler: f.scheduler, status: () => ({}) }), { code: 'background_socket_in_use' });
  const controller = new AbortController();
  const low = f.client.generate(request, { signal: controller.signal });
  const rejection = assert.rejects(low, { code: 'cancelled' });
  await ready; controller.abort(); await rejection; await stopped; await turn();
  assert.equal(f.scheduler.snapshot().active, null);
});
