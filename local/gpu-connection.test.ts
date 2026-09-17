import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGpuConnection } from './gpu-connection.ts';
import type { GpuApi } from './gpu.ts';
import { createGpu } from './gpu.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';

function fixture() {
  const workers: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean })[] = [];
  const events: ({ event: string; code?: string | number } & ErrorDetails)[] = [];
  const connection = createGpuConnection('synthetic-host', { log: (event, code, details) => events.push({ event, code, ...safeErrorDetails(details) }), spawn: () => {
    const worker = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (): boolean => worker.emit('exit', null, 'SIGTERM'),
    });
    workers.push(worker);
    return worker;
  } });
  return { connection, workers, events };
}

test('GPU health is not checked until its own SSH forwarding is confirmed', async () => {
  const f = fixture();
  let healthChecks = 0;
  const gpu = createGpu({
    // This GPU never pauses, so it has no state writes.
    api: { read: async () => ({ actual: 'running', intended: 'running' }) } as GpuApi,
    connection: f.connection,
    check: async () => { healthChecks++; },
  });
  const failed = gpu.tick();
  await Promise.resolve();
  assert.equal(healthChecks, 0);
  // Covers a occupied port or a refused SSH identity: HTTP may still be up,
  // but this connection failed and must not report a ready model.
  f.workers[0].emit('exit', 255);
  await failed;
  assert.equal(gpu.snapshot().status, 'error');
  assert.equal(healthChecks, 0);
  const retry = gpu.tick();
  await Promise.resolve();
  f.workers[1].stdout.write('SIMPLE_CHAT_TUNNEL_');
  assert.equal(healthChecks, 0);
  f.workers[1].stdout.write('READY\n');
  await retry;
  assert.equal(healthChecks, 1);
  assert.equal(gpu.snapshot().status, 'ready');
  f.connection.close();
});

test('closing a pending SSH attempt settles it; the next attempt is independent', async () => {
  const f = fixture();
  const first = f.connection.ensure();
  assert.equal(f.connection.ensure(), first);
  f.connection.close();
  await assert.rejects(first, { code: 'gpu_connection_failed' });
  const second = f.connection.ensure();
  f.workers[0].emit('exit', 255);
  f.workers[1].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await second;
  assert.equal(f.workers.length, 2);
  assert.equal(f.connection.ensure(), second);
  f.connection.close();
});

test('SSH exit after readiness reports only safe transport metadata and permits reconnect', async () => {
  const f = fixture();
  const ready = f.connection.ensure();
  f.workers[0].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await ready;
  f.workers[0].stderr.write('PRIVATE_HOST PRIVATE_PATH: client_loop: send disconnect: Broken pipe\n');
  f.workers[0].emit('exit', 255, null);
  const { connectionAgeMs, ...failure } = f.events.at(-1)!;
  assert.ok(connectionAgeMs! >= 0);
  assert.deepEqual(failure, { event: 'gpu_connection_closed', code: 'process_exit', phase: 'ssh_tunnel', sshReason: 'connection_lost', exitCode: 255 });
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
  const next = f.connection.ensure();
  f.workers[1].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await next;
  f.connection.close();
  assert.equal(f.events.at(-1)!.code, 'requested_close');
});

test('SSH readiness timeout is distinct from exit and requested close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = f.connection.ensure();
  const rejected = assert.rejects(pending, { code: 'gpu_connection_failed' });
  t.mock.timers.tick(12000);
  await rejected;
  assert.equal(f.events.length, 1);
  const { connectionAgeMs, ...failure } = f.events[0];
  assert.ok(connectionAgeMs! >= 0);
  assert.deepEqual(failure, { event: 'gpu_connection_closed', code: 'ready_timeout', phase: 'ssh_connect' });
});
