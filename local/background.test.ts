import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScheduler } from './scheduler.ts';
import type { SchedulerOptions } from './scheduler.ts';
import { createBackgroundClient, serveBackground } from './background.ts';
import { ModelError } from './model-error.ts';
import type { GenerateControls, ModelRequest } from './model.ts';

type Generate = (request: unknown, controls: GenerateControls & { signal: AbortSignal }) => Promise<unknown>;
const request: ModelRequest = { system: 'Synthetic', messages: [{ role: 'user', content: 'Synthetic' }], maxOutputTokens: 256 };
// Waits, up to two seconds, for what the other end of the socket does in its own time.
async function until(done: () => boolean, label: string) {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(done(), label);
}
// The scheduler passes requests and results through, so the fake reads only what a test sends. The holds on the GPU
// that the scheduler takes for a probe's call or an agent's turn are counted as they are taken and let go.
async function fixture(t: TestContext, generate: Generate, options: SchedulerOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-queue-'));
  const socketPath = join(directory, 'model.sock');
  const holds = { taken: 0, released: 0 };
  const hold = () => { holds.taken++; return () => { holds.released++; }; };
  const scheduler = createScheduler({ generate }, { quietMs: 0, holdBackgroundCall: hold, holdAgentTurn: hold, ...options });
  const server = await serveBackground({ socketPath, scheduler, status: () => ({ model: 'synthetic-model' }) });
  t.after(async () => { await server.close(); await scheduler.close(); rmSync(directory, { recursive: true, force: true }); });
  const client = (work: 'probe' | 'agent' = 'probe', timeoutMs = 2000) => createBackgroundClient({ socketPath, model: 'synthetic-model', timeoutMs, work });
  // The slot is free and every hold let go.
  const idle = () => scheduler.snapshot().active === null && holds.released >= holds.taken;
  return { socketPath, scheduler, client, holds, idle };
}
// A model call that runs until its slot stops it, then rejects with the slot's reason or with an error of its own.
const stalled = (started: (signal: AbortSignal) => void, error?: Error): Generate => (_request, { signal }) =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(error ?? signal.reason), { once: true });
    started(signal);
  });

test('private background socket returns bounded model results and content-free status', async t => {
  const limits: unknown[] = [];
  const f = await fixture(t, async (_request, controls) => {
    limits.push(controls.inputLimitTokens);
    return { text: 'Synthetic response', finishReason: 'stop' };
  });
  assert.equal(statSync(f.socketPath).mode & 0o777, 0o600);
  assert.deepEqual(await f.client().check(), { model: 'synthetic-model', queue: { foregroundQueued: 0, agentQueued: 0,
    backgroundQueued: 0, active: null, activeCount: 0, quietRemainingMs: 0 } });
  assert.equal((await f.client().generate(request)).text, 'Synthetic response');
  // An agent's input limit goes with its call, so the model server refuses a longer input before generating.
  assert.equal((await f.client('agent').generate(request, { inputLimitTokens: 43999 })).text, 'Synthetic response');
  assert.deepEqual(limits, [undefined, 43999]);
  await assert.rejects(f.client().generate({ ...request, maxOutputTokens: 9000 }), { code: 'background_invalid_request' });
  await assert.rejects(createBackgroundClient({ socketPath: f.socketPath, model: 'different-model' }).check(), { code: 'unexpected_model' });
  // No other process can take over a live socket.
  await assert.rejects(serveBackground({ socketPath: f.socketPath, scheduler: f.scheduler, status: () => ({}) }), { code: 'background_socket_in_use' });
});

// The kinds of abort a caller's signal carries, sent once the call runs, the two deadlines and a lost agent process.
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Ending = { label: string; code: string; call: (f: Fixture, running: Promise<AbortSignal>) => Promise<unknown>; early?: true;
  options?: SchedulerOptions; error?: Error };
const endings: Ending[] = [
  ...[undefined, new ModelError('cancelled'), new ModelError('background_preempted')].map(reason => ({
    label: `the caller disconnects with abort(${reason ? `ModelError('${reason.code}')` : ''})`, code: 'cancelled',
    call: (f: Fixture, running: Promise<AbortSignal>) => {
      const controller = new AbortController();
      void running.then(() => controller.abort(reason));
      return f.client().generate(request, { signal: controller.signal });
    } })),
  // Deadlines counted from the call, which may end it before it reaches the model.
  { label: 'the caller\'s AbortSignal.timeout', code: 'cancelled', early: true, call: f => f.client().generate(request, { signal: AbortSignal.timeout(30) }) },
  { label: 'the client\'s own deadline', code: 'background_timeout', early: true, call: f => f.client('probe', 60).generate(request) },
  // The scheduler's reason reaches the client as a wire code, whatever the provider throws.
  { label: 'the scheduler\'s backgroundTimeoutMs', code: 'background_timeout', options: { backgroundTimeoutMs: 40 }, error: new Error('provider noise'),
    call: f => f.client().generate(request) },
  // The process's control request closes with it: the turn ends and stops its running call.
  { label: 'the agent process is lost', code: 'cancelled', call: async (f, running) => {
    const agent = f.client('agent');
    const channel = await agent.openTurn();
    void running.then(() => channel.close());
    return agent.generate(request, { turn: channel.id });
  } },
];
test('however a socket call ends, its caller gets its own code and the slot and the GPU are let go once', async t => {
  for (const row of endings) {
    const running = Promise.withResolvers<AbortSignal>();
    const seen: AbortSignal[] = [];
    const f = await fixture(t, stalled(signal => { seen.push(signal); running.resolve(signal); }, row.error), row.options);
    await assert.rejects(row.call(f, running.promise), { code: row.code }, row.label);
    await until(f.idle, row.label);
    if (row.early && !seen.length) continue;
    // The model ran the call once, and the slot's own signal stopped it.
    assert.ok(seen.length === 1 && seen[0].aborted && seen[0].reason instanceof ModelError, row.label);
    assert.deepEqual(f.holds, { taken: 1, released: 1 }, row.label);
  }
  // A bot that accepts the connection and never answers: opening a turn gives up in time.
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-silent-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'model.sock');
  const sockets = new Set<net.Socket>();
  const silent = net.createServer(socket => { sockets.add(socket); });
  await new Promise<void>(resolve => silent.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => silent.close(resolve)); });
  const opening = createBackgroundClient({ socketPath, model: 'synthetic-model', work: 'agent' }).openTurn(undefined, 100);
  await assert.rejects(opening, { code: 'background_unavailable' }, 'the bot does not answer');
});

test('a person stops a probe but waits for an agent\'s call and turn, and no call runs twice', async t => {
  const calls: unknown[] = [];
  const finishes: ((value: unknown) => void)[] = [];
  const f = await fixture(t, (_request, { signal, priority }) => {
    calls.push(priority);
    if (priority === 'foreground') return Promise.resolve('user result');
    return new Promise((resolve, reject) => {
      finishes.push(resolve);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  // The calls that reached the model since the last look, and the next running call's finish.
  const ran = () => calls.splice(0);
  const next = async (label: string) => { await until(() => finishes.length > 0, label); return finishes.shift()!; };
  const agent = f.client('agent');

  // A probe's call gives way to a person and ends: the scheduler does not run it again, only its client may.
  const probe = assert.rejects(f.client().generate(request), { code: 'background_preempted' });
  await next('a probe runs');
  assert.equal(await f.scheduler.foreground.generate(request), 'user result');
  await probe;
  assert.deepEqual(ran(), ['background', 'foreground'], 'a person preempts a probe');

  // An agent's call goes to the agent queue, and a person waits for its end.
  const scene = agent.generate(request);
  const finishScene = await next('an agent call runs');
  const person = f.scheduler.foreground.generate(request);
  assert.equal(f.scheduler.snapshot().foregroundQueued, 1, 'a person waits for an agent call');
  finishScene({ text: 'Agent scene', finishReason: 'stop' });
  assert.equal((await scene).text, 'Agent scene');
  assert.equal(await person, 'user result');
  assert.deepEqual(ran(), ['agent', 'foreground'], 'a person waits for an agent call');

  // An agent's turn keeps the slot between its calls: a person and a probe wait until its control request closes.
  const channel = await agent.openTurn();
  const compaction = agent.generate(request, { turn: channel.id });
  (await next('a turn\'s first call runs'))({ text: 'Memory', finishReason: 'stop' });
  await compaction;
  const waiting = Promise.all([f.scheduler.foreground.generate(request), f.scheduler.background.generate(request)]);
  assert.deepEqual(f.scheduler.snapshot(), { foregroundQueued: 1, agentQueued: 0, backgroundQueued: 1, active: null,
    activeCount: 0, quietRemainingMs: 0 }, 'between a turn\'s calls');
  const second = agent.generate(request, { turn: channel.id });
  (await next('a turn\'s next call runs'))({ text: 'Scene', finishReason: 'stop' });
  assert.equal((await second).text, 'Scene');
  channel.close();
  (await next('the probe runs after the turn'))('probe result');
  assert.deepEqual(await waiting, ['user result', 'probe result']);
  assert.deepEqual(ran(), ['agent', 'agent', 'foreground', 'background'], 'an agent turn keeps its slot');
  await assert.rejects(agent.generate(request, { turn: channel.id }), { code: 'background_unavailable' }, 'a late call of an ended turn');
});
