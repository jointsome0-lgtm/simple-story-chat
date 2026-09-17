import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGpuConnection, sshReasonOf } from './gpu-connection.ts';
import type { GpuApi } from './gpu.ts';
import { createGpu } from './gpu.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';

function fixture() {
  const workers: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean })[] = [];
  const events: ({ event: string; code?: string | number } & ErrorDetails)[] = [];
  const clock = { now: 0 };
  const connection = createGpuConnection('synthetic-host', { now: () => clock.now, log: (event, code, details) => events.push({ event, code, ...safeErrorDetails(details) }), spawn: () => {
    const worker = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: (): boolean => worker.emit('exit', null, 'SIGTERM'),
    });
    workers.push(worker);
    return worker;
  } });
  return { connection, workers, events, clock };
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
  f.clock.now += 10000;
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

test('OpenSSH messages map to fixed reasons; a missed keepalive differs from a connection the other side ended', () => {
  for (const [message, reason] of [
    ['Timeout, server PRIVATE_HOST not responding.', 'keepalive_timeout'],
    ['Connection to PRIVATE_HOST closed by remote host.', 'connection_lost'],
    ['kex_exchange_identification: read: Connection reset by peer', 'connection_lost'],
    ['client_loop: send disconnect: Broken pipe', 'connection_lost'],
    ['ssh: connect to host PRIVATE_HOST port 1: Connection timed out', 'connect_timeout'],
    ['ssh: connect to host PRIVATE_HOST port 1: Connection refused', 'connection_refused'],
    ['bind [127.0.0.1]:8080: Address already in use', 'port_in_use'],
    ['PRIVATE_USER@PRIVATE_HOST: Permission denied (publickey).', 'authentication'],
    ['Host key verification failed.', 'host_key'],
    ['PRIVATE_TEXT', 'other'],
  ] as const) assert.equal(sshReasonOf(message), reason);
  assert.equal(sshReasonOf(''), undefined);
  // A specific reason found earlier survives later unrelated output.
  assert.equal(sshReasonOf('PRIVATE_TEXT', 'keepalive_timeout'), 'keepalive_timeout');
});

test('SSH exit after readiness reports only safe transport metadata and permits reconnect', async () => {
  const f = fixture();
  const ready = f.connection.ensure();
  f.workers[0].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await ready;
  f.clock.now += 60000;
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

test('failed SSH attempts are retried after 10, 20 and then every 30 seconds', async () => {
  const f = fixture();
  for (const [index, delay] of [10000, 20000, 30000, 30000].entries()) {
    const attempt = f.connection.ensure();
    assert.equal(f.workers.length, index + 1);
    f.workers[index].emit('exit', 255, null);
    await assert.rejects(attempt, error => (error as ErrorDetails & { code: string }).code === 'gpu_connection_failed' && (error as ErrorDetails).phase === undefined);
    f.clock.now += delay - 1;
    // A postponed attempt starts no SSH process and adds no log event of its own. Its phase marks the controller's row.
    await assert.rejects(f.connection.ensure(), { code: 'gpu_connection_failed', phase: 'ssh_wait' });
    assert.equal(f.workers.length, index + 1);
    assert.equal(f.events.length, index + 1);
    f.clock.now += 1;
  }
});

test('a requested close or a tunnel that stayed up clears the retry delay; a short-lived tunnel does not', async () => {
  const f = fixture();
  const failed = f.connection.ensure();
  f.workers[0].emit('exit', 255, null);
  await assert.rejects(failed, { code: 'gpu_connection_failed' });
  // A pause or a stopped instance closes the connection even when no tunnel is open.
  f.connection.close();
  const brief = f.connection.ensure();
  assert.equal(f.workers.length, 2);
  f.workers[1].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await brief;
  f.clock.now += 59999;
  f.workers[1].emit('exit', 255, null);
  await assert.rejects(f.connection.ensure(), { code: 'gpu_connection_failed' });
  assert.equal(f.workers.length, 2);
  f.clock.now += 10000;
  const stable = f.connection.ensure();
  f.workers[2].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n');
  await stable;
  f.clock.now += 60000;
  f.workers[2].emit('exit', 255, null);
  const next = f.connection.ensure();
  assert.equal(f.workers.length, 4);
  f.connection.close();
  await assert.rejects(next, { code: 'gpu_connection_failed' });
});
