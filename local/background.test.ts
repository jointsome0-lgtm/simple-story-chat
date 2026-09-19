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
test('an agent request over the socket goes to the agent queue and a person does not cut it off', async t => {
  let finish: ((value: unknown) => void) | undefined;
  const calls: unknown[] = [];
  const f = await fixture(t, (req, { signal }) => {
    calls.push(req === 'foreground' ? 'foreground' : 'agent');
    if (req === 'foreground') return Promise.resolve('user result');
    return new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const scene = agent.generate(request);
  while (!finish) await turn();
  assert.equal(f.scheduler.snapshot().active, 'agent');
  const user = f.scheduler.foreground.generate('foreground');
  await turn();
  assert.deepEqual(calls, ['agent']);
  finish({ text: 'Agent scene', finishReason: 'stop' });
  assert.equal((await scene).text, 'Agent scene');
  assert.equal(await user, 'user result');
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
test('an agent turn over the socket holds the slot until its control request closes; a late call is refused', async t => {
  const calls: string[] = [];
  const finishes: ((value: unknown) => void)[] = [];
  const f = await fixture(t, (req, { signal }) => {
    const name = req === 'foreground' ? 'foreground' : 'agent';
    calls.push(name);
    if (name === 'foreground') return Promise.resolve('user result');
    return new Promise((resolve, reject) => {
      finishes.push(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const turnChannel = await agent.openTurn();
  const compaction = agent.generate(request, { turn: turnChannel.id });
  while (!finishes.length) await turn();
  const user = f.scheduler.foreground.generate('foreground');
  finishes[0]({ text: 'Memory', finishReason: 'stop' });
  await compaction;
  // Between the turn's calls the person still waits.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(calls, ['agent']);
  const scene = agent.generate(request, { turn: turnChannel.id });
  while (finishes.length < 2) await turn();
  finishes[1]({ text: 'Scene', finishReason: 'stop' });
  assert.equal((await scene).text, 'Scene');
  turnChannel.close();
  assert.equal(await user, 'user result');
  await assert.rejects(agent.generate(request, { turn: turnChannel.id }), { code: 'background_unavailable' });
});
test('a lost agent process ends its turn and stops its running call', async t => {
  let aborted = false;
  const f = await fixture(t, (req, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }));
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const turnChannel = await agent.openTurn();
  const call = agent.generate(request, { turn: turnChannel.id }).catch(() => null);
  while (f.scheduler.snapshot().active !== 'agent') await turn();
  // The control request closes as it would when the agent process dies.
  turnChannel.close();
  while (!aborted) await turn();
  await call;
  assert.equal(f.scheduler.snapshot().active, null);
});
test('the input limit of an agent call reaches the model through the socket', async t => {
  let limit: unknown;
  const f = await fixture(t, async (req, controls) => {
    limit = (controls as { inputLimitTokens?: number }).inputLimitTokens;
    return { text: 'Scene', finishReason: 'stop' };
  });
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  await agent.generate(request, { inputLimitTokens: 43999 });
  assert.equal(limit, 43999);
});
