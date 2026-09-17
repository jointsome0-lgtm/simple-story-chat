import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpu } from './gpu.mjs';
import { createVast } from './vast.mjs';
import { gpuConfig } from './config.mjs';
import { ModelError } from './model-error.mjs';

function fixture() {
  let time = 0;
  let remote = { actual: 'running', intended: 'running' };
  let failRead = false;
  let healthy = true;
  const writes = [];
  const connection = { ensure() {}, close() {} };
  const gpu = createGpu({ api: {
    async read() { if (failRead) throw new ModelError(typeof failRead === 'string' ? failRead : 'gpu_api_failed'); return { ...remote }; },
    async setState(state) { writes.push(state); remote.intended = state; },
  }, connection, now: () => time, check: async () => { if (healthy !== true) throw new ModelError(typeof healthy === 'string' ? healthy : 'model_unavailable'); } });
  return { gpu, writes, advance: ms => { time += ms; },
    setRemote: value => { remote = value; }, fail: value => { failRead = value; }, health: value => { healthy = value; } };
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
  let finish;
  const gpu = createGpu({ now: () => time,
    api: { read: async () => {
      if (fail) throw new ModelError('gpu_api_failed');
      return { actual: 'running', intended: 'running' };
    } }, connection: { ensure() {}, close() {} },
    check: () => wait ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(),
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
  finish(); await recovering;
  assert.equal(gpu.snapshot().status, 'ready');
});

test('Vast adapter is pinned to one instance and discards sensitive response fields', async () => {
  const calls = [];
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
  assert.deepEqual(JSON.parse(calls[1].body), { state: 'stopped' });
  assert.throws(() => api.setState('destroyed'), { code: 'gpu_config' });
  const wrong = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, { fetch: async () => Response.json({ instances: { id: 456 } }) });
  await assert.rejects(wrong.read(), { code: 'gpu_instance_mismatch' });
});

test('power control configuration is opt-in and cannot control a Claude deployment', () => {
  assert.equal(gpuConfig({}, 'claude-code'), undefined);
  const env = { SIMPLE_CHAT_VAST_INSTANCE_ID: '123', SIMPLE_CHAT_VAST_API_KEY: 'synthetic' };
  assert.throws(() => gpuConfig(env, 'claude-code'));
  assert.equal(gpuConfig(env, 'llama-cpp').idleMinutes, 15);
  assert.throws(() => gpuConfig({ ...env, SIMPLE_CHAT_GPU_SSH_HOST: '-oProxyCommand=bad' }, 'llama-cpp'));
});

test('Vast HTTP errors expose only status and read/write phase', async () => {
  const api = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, {
    fetch: async () => new Response('PRIVATE_PROVIDER_BODY', { status: 502 }),
  });
  await assert.rejects(api.read(), { code: 'gpu_api_failed', phase: 'gpu_read', httpStatus: 502 });
  await assert.rejects(api.setState('stopped'), { code: 'gpu_api_failed', phase: 'gpu_write', httpStatus: 502 });
});
