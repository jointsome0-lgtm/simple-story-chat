import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { GpuApi } from './gpu.ts';
import { createGpu, queueOptions } from './gpu.ts';
import type { SchedulerOptions } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import { createVast } from './vast.ts';
import { gpuConfig } from './config.ts';
import { ModelError } from './model-error.ts';

function fixture() {
  let time = 0;
  let remote = { actual: 'running', intended: 'running' };
  let failRead: boolean | string = false;
  let healthy: boolean | string = true;
  const writes: string[] = [];
  const connection = { ensure() {}, close() {} };
  const gpu = createGpu({ api: {
    async read() { if (failRead) throw new ModelError(typeof failRead === 'string' ? failRead : 'gpu_api_failed'); return { ...remote }; },
    async setState(state) { writes.push(state); remote.intended = state; },
  }, connection, now: () => time, check: async () => { if (healthy !== true) throw new ModelError(typeof healthy === 'string' ? healthy : 'model_unavailable'); } });
  return { gpu, writes, now: () => time, advance: (ms: number) => { time += ms; },
    setRemote: (value: typeof remote) => { remote = value; }, fail: (value: boolean | string) => { failRead = value; },
    health: (value: boolean | string) => { healthy = value; } };
}

test('idle stop waits 15 minutes after the last job; status reads never extend it', async () => {
  const f = fixture();
  await f.gpu.tick();
  const release = f.gpu.acquire();
  f.advance(20 * 60000);
  await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  release();
  f.advance(14 * 60000);
  await f.gpu.tick();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, 60);
  f.advance(59999); await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  f.advance(1); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
  assert.equal(f.gpu.snapshot().status, 'stopping', 'PUT acknowledgement is not a stopped receipt');
  f.setRemote({ actual: 'exited', intended: 'stopped' });
  await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'paused');
});

test('other work keeps the card up while it lasts, and the end of the last work starts the idle interval', async () => {
  const f = fixture();
  // Work held when the bot starts: the first tick starts no idle interval.
  const early = f.gpu.keepAwake();
  await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().idleRemainingSeconds], ['ready', null]);
  f.advance(60 * 60000); await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  // Nor does the end of a reader's job while other work lasts.
  f.gpu.acquire()();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, null);
  early();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, 15 * 60);
  // A release works once: called again, it does not end the work that came after it.
  const next = f.gpu.keepAwake();
  early();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, null);
  next();
  f.advance(15 * 60000 - 1); await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  f.advance(1); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});

test('other work neither wakes a paused card nor takes back a pause, which waits for it', async () => {
  const f = fixture(); await f.gpu.tick();
  const work = f.gpu.keepAwake();
  f.gpu.pause();
  assert.equal(f.gpu.snapshot().status, 'draining');
  // Work that begins while the pause waits leaves the pause in place, and the pause waits for it too.
  const more = f.gpu.keepAwake();
  await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().canPause, f.writes], ['draining', false, []]);
  assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
  work(); await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  more(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
  f.setRemote({ actual: 'exited', intended: 'stopped' }); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'paused');
  // Work taken on a paused card does not start it: only the owner does.
  const late = f.gpu.keepAwake();
  await f.gpu.tick(); await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.writes], ['paused', ['stopped']]);
  late();
  f.gpu.resume(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped', 'running']);
});

test('manual pause drains all users and refuses new jobs without interrupting existing work', async () => {
  const f = fixture(); await f.gpu.tick();
  const owner = f.gpu.acquire(); const tester = f.gpu.acquire();
  f.gpu.pause();
  assert.equal(f.gpu.snapshot().status, 'draining');
  assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
  await f.gpu.tick(); owner(); owner(); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().activeJobs, 1);
  assert.deepEqual(f.writes, []);
  tester(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});

test('paused startup stays off; explicit resume waits for allocation and model readiness', async () => {
  const f = fixture(); f.setRemote({ actual: 'exited', intended: 'stopped' });
  await f.gpu.tick(); await f.gpu.tick();
  assert.deepEqual(f.writes, []);
  f.gpu.resume();
  assert.equal(f.gpu.snapshot().status, 'starting');
  await f.gpu.tick(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['running']);
  assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
  f.setRemote({ actual: 'running', intended: 'running' }); f.health(false);
  await f.gpu.tick();
  assert.notEqual(f.gpu.snapshot().status, 'ready');
  f.health(true); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'ready');
});

test('failed control or unknown remote status never reports a free paused GPU', async () => {
  const f = fixture(); await f.gpu.tick();
  f.gpu.pause(); f.fail(true); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'error');
  f.fail(false); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
  f.setRemote({ actual: 'offline', intended: 'stopped' }); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'stopping');
  assert.throws(() => f.gpu.resume(), { code: 'gpu_not_ready' });
});

test('slow allocation is also paused after the idle interval', async () => {
  const f = fixture(); f.setRemote({ actual: 'exited', intended: 'stopped' }); await f.gpu.tick();
  f.gpu.resume(); await f.gpu.tick();
  f.advance(15 * 60000); await f.gpu.tick();
  assert.deepEqual(f.writes, ['running', 'stopped']);
});

test('a transient control or health failure retains recent readiness for at most 30 seconds', async () => {
  for (const failure of ['control', 'health']) {
    const f = fixture(); await f.gpu.tick();
    f.advance(10000);
    if (failure === 'control') f.fail(true); else f.health('cancelled');
    await f.gpu.tick();
    assert.equal(f.gpu.snapshot().status, 'ready');
    assert.equal(f.gpu.snapshot().checkDegraded, true);
    const release = f.gpu.acquire(); release();
    f.advance(19999); await f.gpu.tick();
    assert.equal(f.gpu.snapshot().status, 'ready');
    f.advance(1);
    assert.equal(f.gpu.snapshot().status, 'error');
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
    await f.gpu.tick();
    assert.deepEqual(f.writes, []);
    f.fail(false); f.health(true); await f.gpu.tick();
    assert.equal(f.gpu.snapshot().status, 'ready');
    assert.equal(f.gpu.snapshot().checkDegraded, false);
  }
});

test('startup, identity mismatch, actual stop and explicit pause cannot use cached readiness', async () => {
  const fresh = fixture(); fresh.fail(true); await fresh.gpu.tick();
  assert.equal(fresh.gpu.snapshot().status, 'error');
  for (const reason of ['identity', 'model', 'stopped', 'pause']) {
    const f = fixture(); await f.gpu.tick();
    if (reason === 'identity') f.fail('gpu_instance_mismatch');
    if (reason === 'model') f.health('unexpected_model');
    if (reason === 'stopped') f.setRemote({ actual: 'exited', intended: 'stopped' });
    if (reason === 'pause') { f.gpu.pause(); f.fail(true); }
    await f.gpu.tick();
    assert.notEqual(f.gpu.snapshot().status, 'ready');
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
    f.fail(true); await f.gpu.tick();
    assert.notEqual(f.gpu.snapshot().status, 'ready');
  }
});

test('an idle deadline latches during API failure even with a fresh successful health check', async () => {
  const f = fixture(); await f.gpu.tick();
  f.advance(15 * 60000 - 1); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'ready');
  f.fail(true); f.advance(1); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'error');
  assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
  f.fail(false); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});

test('a pending recovery check cannot extend cached readiness past its deadline', async () => {
  let time = 0;
  let fail = false;
  let wait = false;
  let finish: (() => void) | undefined;
  const gpu = createGpu({ now: () => time,
    // This GPU never pauses, so it has no state writes.
    api: { read: async () => {
      if (fail) throw new ModelError('gpu_api_failed');
      return { actual: 'running', intended: 'running' };
    } } as GpuApi, connection: { ensure() {}, close() {} },
    check: () => wait ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve(),
  });
  await gpu.tick();
  time = 10000; fail = true; await gpu.tick();
  assert.equal(gpu.snapshot().checkDegraded, true);
  time = 29000; fail = false; wait = true;
  const recovering = gpu.tick();
  await new Promise(resolve => setImmediate(resolve));
  time = 30000;
  assert.equal(gpu.snapshot().status, 'error');
  assert.throws(() => gpu.acquire(), { code: 'gpu_not_ready' });
  finish!(); await recovering;
  assert.equal(gpu.snapshot().status, 'ready');
});

type Await = 'check' | 'ensure' | 'read';
// Like fixture, but reconcile can be held at one of its awaits, so a test can act while it waits there.
function heldFixture({ remote = { actual: 'running', intended: 'running' } } = {}) {
  let time = 0;
  let failRead = false;
  const writes: string[] = [];
  const holding = new Set<Await>();
  const held: Partial<Record<Await, { resolve: () => void; reject: (error: Error) => void }>> = {};
  const hold = (name: Await) => holding.has(name) ? new Promise<void>((resolve, reject) => { held[name] = { resolve, reject }; }) : Promise.resolve();
  const gpu = createGpu({ now: () => time,
    api: { async read() { await hold('read'); if (failRead) throw new ModelError('gpu_api_failed'); return { ...remote }; },
      async setState(state) { writes.push(state); remote.intended = state; } },
    connection: { async ensure() { await hold('ensure'); }, close() {} },
    check: async () => { await hold('check'); } });
  return { gpu, writes, holding, held, advance: (ms: number) => { time += ms; },
    fail: (value: boolean) => { failRead = value; }, setRemote: (value: typeof remote) => { remote = value; } };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const point of ['check', 'ensure', 'read'] as const) {
  test(`pause() arriving during await ${point} is kept: never 'ready', no new lease, next tick stops`, async () => {
    const f = heldFixture(); await f.gpu.tick();
    assert.equal(f.gpu.snapshot().status, 'ready');
    f.holding.add(point);
    const inflight = f.gpu.tick(); await turn();
    f.gpu.pause();
    f.holding.delete(point); f.held[point]!.resolve(); await inflight;
    const s = f.gpu.snapshot();
    assert.equal(s.status, 'stopping'); assert.equal(s.canPause, false);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' });
    // A pause during the read is seen by the same reconcile; later awaits leave the stop to the next tick.
    if (point === 'read') assert.deepEqual(f.writes, ['stopped']);
    else { assert.deepEqual(f.writes, []); await f.gpu.tick(); assert.deepEqual(f.writes, ['stopped']); }
  });
}

test('pause() during await check with a held lease drains instead of stopping, then stops on release', async () => {
  const f = heldFixture(); await f.gpu.tick();
  const release = f.gpu.acquire();
  f.holding.add('check'); const inflight = f.gpu.tick(); await turn();
  f.gpu.pause(); f.holding.delete('check'); f.held.check!.resolve(); await inflight;
  assert.equal(f.gpu.snapshot().status, 'draining');
  await f.gpu.tick(); assert.deepEqual(f.writes, []);
  release(); await turn(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});

test('pause() during a failing check reports error at once, without the readiness grace, and still stops on the next tick', async () => {
  const f = heldFixture(); await f.gpu.tick();
  f.holding.add('check'); const inflight = f.gpu.tick(); await turn();
  f.gpu.pause(); f.held.check!.reject(new ModelError('timeout')); f.holding.delete('check'); await inflight;
  assert.equal(f.gpu.snapshot().status, 'error');
  assert.equal(f.gpu.snapshot().checkDegraded, false);
  await f.gpu.tick(); assert.deepEqual(f.writes, ['stopped']);
});

test('a start overtaken by the idle deadline while the control API is down: the pause wins and running is never written again', async () => {
  const f = heldFixture({ remote: { actual: 'exited', intended: 'stopped' } }); await f.gpu.tick();
  f.gpu.resume(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['running']);
  // The idle deadline latches the pause before the failing read.
  f.fail(true); f.advance(15 * 60000); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'error'); assert.equal(f.gpu.snapshot().canPause, false);
  f.fail(false); f.advance(31000); await f.gpu.tick();
  assert.deepEqual(f.writes, ['running', 'stopped']);
  f.setRemote({ actual: 'exited', intended: 'stopped' }); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'paused'); assert.equal(f.gpu.snapshot().canStart, true);
  await f.gpu.tick(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['running', 'stopped'], 'the overtaken start must not resurface after the pause completes');
});

test('resume() while an externally started instance is being health-checked ends ready with the start consumed', async () => {
  const f = heldFixture({ remote: { actual: 'exited', intended: 'stopped' } }); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'paused');
  // Started outside the bot, for example from the Vast console.
  f.setRemote({ actual: 'running', intended: 'running' });
  f.holding.add('check'); const inflight = f.gpu.tick(); await turn();
  f.gpu.resume(); assert.equal(f.gpu.snapshot().status, 'starting');
  f.holding.delete('check'); f.held.check!.resolve(); await inflight;
  assert.equal(f.gpu.snapshot().status, 'ready'); assert.deepEqual(f.writes, []);
  // Without a pending start, a transient failure gets the readiness grace.
  f.fail(true); f.advance(1000); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'ready'); assert.equal(f.gpu.snapshot().checkDegraded, true);
});

test('Vast adapter is pinned to one instance and discards sensitive response fields', async () => {
  const calls: (RequestInit & { url: string })[] = [];
  const api = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, { fetch: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(options.method === 'PUT' ? { success: true } : {
      instances: { id: 123, actual_status: 'running', intended_status: 'running', jupyter_token: 'synthetic-private' },
    });
  } });
  assert.deepEqual(await api.read(), { actual: 'running', intended: 'running' });
  await api.setState('stopped');
  assert.equal(calls[1].url, 'https://console.vast.ai/api/v0/instances/123/');
  assert.equal(calls[1].redirect, 'error');
  assert.deepEqual(JSON.parse(calls[1].body as string), { state: 'stopped' });
  assert.throws(() => api.setState('destroyed'), { code: 'gpu_config' });
  const wrong = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, { fetch: async () => Response.json({ instances: { id: 456 } }) });
  await assert.rejects(wrong.read(), { code: 'gpu_instance_mismatch' });
});

test('power control configuration is opt-in and cannot control a Claude deployment', () => {
  assert.equal(gpuConfig({}, 'claude-code'), undefined);
  const env = { SIMPLE_CHAT_VAST_INSTANCE_ID: '123', SIMPLE_CHAT_VAST_API_KEY: 'synthetic' };
  assert.throws(() => gpuConfig(env, 'claude-code'));
  assert.equal(gpuConfig(env, 'llama-cpp')!.idleMinutes, 15);
  assert.throws(() => gpuConfig({ ...env, SIMPLE_CHAT_GPU_SSH_HOST: '-oProxyCommand=bad' }, 'llama-cpp'));
});

test('Vast HTTP errors expose only status and read/write phase', async () => {
  const api = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, {
    fetch: async () => new Response('PRIVATE_PROVIDER_BODY', { status: 502 }),
  });
  await assert.rejects(api.read(), { code: 'gpu_api_failed', phase: 'gpu_read', httpStatus: 502 });
  await assert.rejects(api.setState('stopped'), { code: 'gpu_api_failed', phase: 'gpu_write', httpStatus: 502 });
});

test('a start counter separates a real restart from a failing control API', async () => {
  let time = 0, apiFails = false, state = { actual: 'running', intended: 'running' };
  const gpu = createGpu({ now: () => time, idleMinutes: 15,
    api: { read: async () => { if (apiFails) throw new ModelError('gpu_api_failed'); return state; },
      setState: async next => { state = { actual: next === 'running' ? 'running' : 'stopped', intended: next }; } },
    connection: { ensure: async () => {}, close() {} }, check: async () => {} });
  assert.equal((await gpu.tick()).starts, 1);
  // A control API that fails and recovers says nothing about the model server.
  time = 40000; apiFails = true; await gpu.tick();
  assert.equal(gpu.snapshot().status, 'error');
  time = 50000; apiFails = false;
  assert.equal((await gpu.tick()).starts, 1);
  // A pause and a resume start a server with empty caches.
  gpu.pause();
  time = 60000; await gpu.tick();
  assert.equal((await gpu.tick()).status, 'paused');
  gpu.resume();
  time = 70000; await gpu.tick();
  assert.equal((await gpu.tick()).starts, 2);
});

test('an intention to stop that never took effect is not a restart', async () => {
  let state = { actual: 'running', intended: 'running' };
  let writes = 0;
  const gpu = createGpu({ now: () => 0,
    api: { read: async () => state, setState: async () => { writes++; } },
    connection: { ensure: async () => {}, close() {} }, check: async () => {} });
  assert.equal((await gpu.tick()).starts, 1);
  // Somebody outside the bot asks Vast to stop the instance and then takes it back. The instance never left 'running',
  // so the model server and its caches stayed up.
  state = { actual: 'running', intended: 'stopped' };
  assert.equal((await gpu.tick()).status, 'stopping');
  state = { actual: 'running', intended: 'running' };
  const back = await gpu.tick();
  assert.deepEqual([back.status, back.starts, writes], ['ready', 1, 0]);
});

// The bot's model queue on this card, with the options local/main.ts gives it. A call runs until the test finishes it
// or the queue stops it.
function queue(t: TestContext, f: ReturnType<typeof fixture>, options: SchedulerOptions = {}) {
  const calls: { name: string; finish: () => void }[] = [];
  const scheduler = createScheduler({ generate: (request: string, { signal }: { signal: AbortSignal }) => new Promise<string>((resolve, reject) => {
    calls.push({ name: request, finish: () => resolve(request) });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }, { ...queueOptions(f.gpu, { pool: false }), now: f.now, quietMs: 0, pollMs: 100000, ...options });
  t.after(() => scheduler.close());
  return { scheduler, calls };
}

test('a long eval keeps the card up: calls back to back for longer than the idle interval never drain or pause it', async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f);
  for (let call = 0; call < 30; call++) {
    const result = q.scheduler.background.generate(`eval ${call}`);
    assert.equal(q.calls.length, call + 1);
    // A minute of generation, with the bot's ticks meanwhile.
    f.advance(60000); await f.gpu.tick(); q.scheduler.tick();
    assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().idleRemainingSeconds], ['ready', null]);
    q.calls[call].finish(); assert.equal(await result, `eval ${call}`);
    // The eval sends its next request a moment later; in between only the idle interval keeps the card up.
    f.advance(50); await f.gpu.tick();
  }
  assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().idleRemainingSeconds, f.writes], ['ready', 15 * 60, []]);
  f.advance(15 * 60000); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});

test('a reader who comes during an eval is served at once, and the card stays ready', async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f, { quietMs: 60000 });
  f.advance(60000);
  const probe = q.scheduler.background.generate('eval');
  const preempted = assert.rejects(probe, { code: 'background_preempted' });
  f.advance(10 * 60000); await f.gpu.tick();
  // A scene as bot.ts runs it: the reader's job first, then its call, which stops the probe.
  const job = f.gpu.acquire();
  const scene = q.scheduler.foreground.generate('scene');
  await preempted; await turn();
  assert.deepEqual(q.calls.map(call => call.name), ['eval', 'scene']);
  // The eval asks again at once. Its call waits for the reader and the quiet window after them, and keeps the card
  // up meanwhile.
  const again = q.scheduler.background.generate('eval again');
  f.advance(30000); await f.gpu.tick(); q.scheduler.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().activeJobs, q.calls.length], ['ready', 1, 2]);
  q.calls[1].finish(); assert.equal(await scene, 'scene'); job();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, null);
  f.advance(60000); await f.gpu.tick(); q.scheduler.tick();
  assert.equal(q.calls[2].name, 'eval again');
  q.calls[2].finish(); await again;
  assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().idleRemainingSeconds, f.writes], ['ready', 15 * 60, []]);
});

test('cancelling the last waiting probe starts the idle interval', async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f, { quietMs: 60000 });
  // A reader's scene has just ended; the eval's call waits for the quiet window.
  const job = f.gpu.acquire();
  const scene = q.scheduler.foreground.generate('scene');
  q.calls[0].finish(); await scene;
  const cancel = new AbortController();
  const probe = q.scheduler.background.generate('eval', { signal: cancel.signal });
  job();
  f.advance(30000); await f.gpu.tick(); q.scheduler.tick();
  assert.deepEqual([q.calls.length, f.gpu.snapshot().idleRemainingSeconds], [1, null]);
  const cancelled = assert.rejects(probe, { code: 'cancelled' });
  cancel.abort(); await cancelled;
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, 15 * 60);
  f.advance(15 * 60000); await f.gpu.tick();
  assert.deepEqual([q.calls.length, f.writes], [1, ['stopped']]);
});

test("the owner's pause during an eval completes once the queue stops the running call and refuses the waiting ones", async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f);
  const running = q.scheduler.background.generate('eval 1');
  const waiting = q.scheduler.background.generate('eval 2');
  const stopped = assert.rejects(running, { code: 'background_unavailable' });
  const refused = assert.rejects(waiting, { code: 'background_unavailable' });
  f.gpu.pause();
  await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.writes], ['draining', []]);
  // The queue's next tick: probes may no longer run, nor wait.
  q.scheduler.tick();
  await stopped; await refused;
  // The eval asks again at once, and is refused before its call waits: it keeps nothing up.
  await assert.rejects(q.scheduler.background.generate('eval 3'), { code: 'background_unavailable' });
  await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.writes], ['stopping', ['stopped']]);
  f.setRemote({ actual: 'exited', intended: 'stopped' }); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'paused');
  assert.deepEqual(q.calls.map(call => call.name), ['eval 1']);
});

test('a model server whose checks fail does not hang a pause during an eval', async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f);
  const first = q.scheduler.background.generate('eval 1');
  const stopped = assert.rejects(first, { code: 'background_unavailable' });
  // The server stops answering its checks. Past the readiness grace the card is in error, and the probe stops.
  f.health('timeout'); f.advance(31000); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'error');
  q.scheduler.tick(); await stopped;
  // The eval asks again; its call waits for the card to be ready.
  const second = q.scheduler.background.generate('eval 2');
  const refused = assert.rejects(second, { code: 'background_unavailable' });
  f.advance(60000); await f.gpu.tick(); q.scheduler.tick();
  assert.deepEqual([f.gpu.snapshot().status, q.calls.length, f.writes], ['error', 1, []]);
  // The owner pauses: the pause waits for the waiting call, the queue refuses it, and the pause needs no check.
  f.gpu.pause(); await f.gpu.tick();
  assert.equal(f.gpu.snapshot().status, 'draining');
  q.scheduler.tick(); await refused; await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.writes], ['stopping', ['stopped']]);
});

test("an agent's turn keeps the card up through the gaps between its calls, and its end starts the idle interval", async t => {
  const f = fixture(); await f.gpu.tick();
  const q = queue(t, f);
  // The card has been idle for 14 minutes when the turn begins: it no longer needs the time to end before the pause.
  f.advance(14 * 60000); await f.gpu.tick();
  const agent = q.scheduler.agent.openTurn();
  for (let call = 0; call < 5; call++) {
    const result = agent.generate(`agent ${call}`);
    assert.equal(q.calls.length, call + 1);
    f.advance(3 * 60000); await f.gpu.tick(); q.scheduler.tick();
    q.calls[call].finish(); await result;
    // The agent reads the answer and writes its next call.
    f.advance(50000); await f.gpu.tick(); q.scheduler.tick();
    assert.deepEqual([f.gpu.snapshot().status, f.gpu.snapshot().idleRemainingSeconds, f.writes], ['ready', null, []]);
  }
  agent.end();
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, 15 * 60);
  f.advance(15 * 60000); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
});
