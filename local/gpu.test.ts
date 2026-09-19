import test from 'node:test';
import assert from 'node:assert/strict';
import type { GpuApi } from './gpu.ts';
import { createGpu } from './gpu.ts';
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
  return { gpu, writes, advance: (ms: number) => { time += ms; },
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

test('an agent turn holds the GPU past the idle deadline without resetting the countdown', async () => {
  const f = fixture(); await f.gpu.tick();
  f.gpu.acquire()();
  f.advance(14 * 60000);
  const release = f.gpu.hold();
  // The countdown goes on while the agent turn holds the GPU.
  assert.equal(f.gpu.snapshot().idleRemainingSeconds, 60);
  f.advance(60000); await f.gpu.tick();
  assert.deepEqual([f.gpu.snapshot().status, f.writes], ['draining', []]);
  release(); await f.gpu.tick();
  assert.deepEqual(f.writes, ['stopped']);
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
