import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import net from 'node:net';
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
test('an agent request over the socket goes to the agent queue and yields to a person', async t => {
  const calls: unknown[] = [];
  const f = await fixture(t, (req, { signal }) => {
    calls.push(req === 'foreground' ? 'foreground' : 'agent');
    if (req === 'foreground') return Promise.resolve('user result');
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  });
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const scene = agent.generate(request);
  while (f.scheduler.snapshot().active !== 'agent') await turn();
  const stopped = assert.rejects(scene, { code: 'background_preempted' });
  assert.equal(await f.scheduler.foreground.generate('foreground'), 'user result');
  await stopped;
  assert.deepEqual(calls, ['agent', 'foreground']);
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
    calls.push(req === 'probe' ? 'probe' : 'agent');
    return new Promise((resolve, reject) => {
      finishes.push(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const turnChannel = await agent.openTurn();
  const compaction = agent.generate(request, { turn: turnChannel.id });
  while (!finishes.length) await turn();
  finishes[0]({ text: 'Memory', finishReason: 'stop' });
  await compaction;
  // Between the turn's calls a probe waits.
  const probe = f.scheduler.background.generate('probe');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(calls, ['agent']);
  const scene = agent.generate(request, { turn: turnChannel.id });
  while (finishes.length < 2) await turn();
  finishes[1]({ text: 'Scene', finishReason: 'stop' });
  assert.equal((await scene).text, 'Scene');
  turnChannel.close();
  while (finishes.length < 3) await turn();
  assert.deepEqual(calls, ['agent', 'agent', 'probe']);
  finishes[2]('probe result'); await probe;
  await assert.rejects(agent.generate(request, { turn: turnChannel.id }), { code: 'background_unavailable' });
});
test('a person ends an agent turn over the socket, and its later calls are refused as preempted', async t => {
  const f = await fixture(t, (req, { signal }) => req === 'foreground' ? Promise.resolve('user result')
    : new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  const agent = createBackgroundClient({ socketPath: f.socketPath, model: 'synthetic-model', timeoutMs: 2000, work: 'agent' });
  const turnChannel = await agent.openTurn();
  t.after(() => turnChannel.close());
  const compaction = agent.generate(request, { turn: turnChannel.id });
  while (f.scheduler.snapshot().active !== 'agent') await turn();
  const stopped = assert.rejects(compaction, { code: 'background_preempted' });
  assert.equal(await f.scheduler.foreground.generate('foreground'), 'user result');
  await stopped;
  await assert.rejects(agent.generate(request, { turn: turnChannel.id }), { code: 'background_preempted' });
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
test('opening an agent turn gives up when the bot does not answer in time', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-silent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'model.sock');
  // Accepts the connection and never answers.
  const sockets = new Set<net.Socket>();
  const silent = net.createServer(socket => { sockets.add(socket); });
  await new Promise<void>(resolve => silent.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => silent.close(resolve)); });
  const agent = createBackgroundClient({ socketPath, model: 'synthetic-model', work: 'agent' });
  await assert.rejects(agent.openTurn(undefined, 100), { code: 'background_unavailable' });
});
