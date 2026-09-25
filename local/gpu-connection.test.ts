import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGpuConnection, sshReasonOf } from './gpu-connection.ts';
import type { GpuApi } from './gpu.ts';
import { createGpu } from './gpu.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';

// Fake ssh processes, each with the arguments and environment it was started with, and the log rows as the
// whitelist lets them reach the technical log.
function fixture() {
  type Worker = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; args: string[]; env: NodeJS.ProcessEnv };
  const workers: Worker[] = [];
  const events: ({ event: string; code?: string | number } & ErrorDetails)[] = [];
  const clock = { now: 0 };
  const connection = createGpuConnection('synthetic-host', { now: () => clock.now,
    log: (event, code, details) => events.push({ event, code, ...safeErrorDetails(details) }),
    spawn: (_command, args, { env }) => {
      const worker: Worker = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), args, env,
        kill: (): boolean => worker.emit('exit', null, 'SIGTERM') });
      workers.push(worker);
      return worker;
    } });
  return { connection, workers, events, clock, ready: (i: number) => workers[i].stdout.write('SIMPLE_CHAT_TUNNEL_READY\n') };
}

test('GPU health is not checked until its own SSH forwarding is confirmed, and one tunnel serves every caller', async t => {
  const secrets = ['SIMPLE_CHAT_DB_PATH', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'VAST_API_KEY'].filter(key => !(key in process.env));
  for (const key of secrets) process.env[key] = 'PRIVATE';
  t.after(() => { for (const key of secrets) delete process.env[key]; });
  const f = fixture();
  let healthChecks = 0;
  // This GPU never pauses, so it has no state writes.
  const gpu = createGpu({ api: { read: async () => ({ actual: 'running', intended: 'running' }) } as GpuApi,
    connection: f.connection, check: async () => { healthChecks++; } });
  const failed = gpu.tick();
  await Promise.resolve();
  // The model port goes from loopback to loopback, to a host whose key is pinned, and ssh gets no bot setting or key.
  assert.ok(f.workers[0].args.includes('127.0.0.1:8080:127.0.0.1:8080') && f.workers[0].args.includes('StrictHostKeyChecking=yes'));
  assert.doesNotMatch(JSON.stringify(f.workers[0].env), /PRIVATE/);
  // An occupied port or a refused identity: HTTP may still be up, but this connection failed and reports no model.
  f.workers[0].emit('exit', 255);
  await failed;
  assert.deepEqual([gpu.snapshot().status, healthChecks], ['error', 0]);
  f.clock.now += 10000;
  const retry = gpu.tick();
  await Promise.resolve();
  f.workers[1].stdout.write('SIMPLE_CHAT_TUNNEL_');
  assert.equal(healthChecks, 0);
  f.workers[1].stdout.write('READY\n');
  await retry;
  assert.deepEqual([gpu.snapshot().status, healthChecks], ['ready', 1]);
  f.connection.close();
  // A pending attempt is shared; closing it settles it, and the next attempt is independent of the closed one.
  const g = fixture();
  const first = g.connection.ensure();
  assert.equal(g.connection.ensure(), first);
  g.connection.close();
  await assert.rejects(first, { code: 'gpu_connection_failed' });
  const second = g.connection.ensure();
  g.workers[0].emit('exit', 255);
  g.ready(1);
  await second;
  assert.deepEqual([g.connection.ensure() === second, g.workers.length], [true, 2]);
  g.connection.close();
});

test('OpenSSH endings map to fixed reasons, and their rows carry only safe transport metadata', async t => {
  for (const [message, reason] of [['Timeout, server PRIVATE_HOST not responding.', 'keepalive_timeout'],
    ['Connection to PRIVATE_HOST closed by remote host.', 'connection_lost'], ['client_loop: send disconnect: Broken pipe', 'connection_lost'],
    ['kex_exchange_identification: read: Connection reset by peer', 'connection_lost'], ['Host key verification failed.', 'host_key'],
    ['ssh: connect to host PRIVATE_HOST port 1: Connection timed out', 'connect_timeout'], ['PRIVATE_TEXT', 'other'],
    ['ssh: connect to host PRIVATE_HOST port 1: Connection refused', 'connection_refused'], ['', undefined],
    ['bind [127.0.0.1]:8080: Address already in use', 'port_in_use'], ['PRIVATE_USER@PRIVATE_HOST: Permission denied (publickey).', 'authentication'],
  ] as const) assert.equal(sshReasonOf(message), reason, message);
  // A specific reason found earlier survives later unrelated output.
  assert.equal(sshReasonOf('PRIVATE_TEXT', 'keepalive_timeout'), 'keepalive_timeout');
  // An exit after readiness is a lost tunnel, logged by its reason and exit code; it permits a reconnect.
  const f = fixture();
  const ready = f.connection.ensure();
  f.ready(0);
  await ready;
  f.clock.now += 60000;
  f.workers[0].stderr.write('PRIVATE_HOST PRIVATE_PATH: client_loop: send disconnect: Broken pipe\n');
  f.workers[0].emit('exit', 255, null);
  const { connectionAgeMs, ...lost } = f.events.at(-1)!;
  assert.ok(connectionAgeMs! >= 0);
  assert.deepEqual(lost, { event: 'gpu_connection_closed', code: 'process_exit', phase: 'ssh_tunnel', sshReason: 'connection_lost', exitCode: 255 });
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE/);
  const next = f.connection.ensure();
  f.ready(1);
  await next;
  f.connection.close();
  assert.equal(f.events.at(-1)!.code, 'requested_close');
  // No confirmation within 12 seconds is an ending of its own, told apart from an exit and from a requested close.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const g = fixture();
  const rejected = assert.rejects(g.connection.ensure(), { code: 'gpu_connection_failed' });
  t.mock.timers.tick(12000);
  await rejected;
  const [{ connectionAgeMs: age, ...timeout }, ...more] = g.events;
  assert.ok(age! >= 0 && more.length === 0);
  assert.deepEqual(timeout, { event: 'gpu_connection_closed', code: 'ready_timeout', phase: 'ssh_connect' });
});

test('failed SSH attempts are retried after 10, 20 and then every 30 seconds; a requested close or a tunnel that stayed up clears the wait', async () => {
  const f = fixture();
  for (const [index, delay] of [10000, 20000, 30000, 30000].entries()) {
    const attempt = f.connection.ensure();
    assert.equal(f.workers.length, index + 1);
    f.workers[index].emit('exit', 255, null);
    await assert.rejects(attempt, error => (error as ErrorDetails & { code: string }).code === 'gpu_connection_failed' && (error as ErrorDetails).phase === undefined);
    f.clock.now += delay - 1;
    // A postponed attempt starts no SSH process and adds no log event of its own. Its phase marks the controller's row.
    await assert.rejects(f.connection.ensure(), { code: 'gpu_connection_failed', phase: 'ssh_wait' });
    assert.deepEqual([f.workers.length, f.events.length], [index + 1, index + 1], `attempt ${index + 1}`);
    f.clock.now += 1;
  }
  // A pause or a stopped instance closes the connection even when no tunnel is open, and the wait starts over.
  f.connection.close();
  const brief = f.connection.ensure();
  f.ready(4);
  await brief;
  // A tunnel that lived less than a minute is a failed attempt, and one that stayed up a minute reconnects at once.
  f.clock.now += 59999;
  f.workers[4].emit('exit', 255, null);
  await assert.rejects(f.connection.ensure(), { code: 'gpu_connection_failed', phase: 'ssh_wait' });
  assert.equal(f.workers.length, 5);
  f.clock.now += 10000;
  const stable = f.connection.ensure();
  f.ready(5);
  await stable;
  f.clock.now += 60000;
  f.workers[5].emit('exit', 255, null);
  const next = f.connection.ensure();
  assert.equal(f.workers.length, 7);
  f.connection.close();
  await assert.rejects(next, { code: 'gpu_connection_failed' });
});
