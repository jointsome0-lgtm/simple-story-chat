import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, save, watch } from './gpu-diagnose.ts';
import type { Options, Report } from './gpu-diagnose.ts';

// What a healthy instance reports, with fields a changed or hostile remote side could add.
const remote = (models: object = { httpStatus: 200, seconds: 0.01, modelId: 'synthetic-model' }) => JSON.stringify({
  at: '2026-09-17T02:12:17.803123+00:00', hostname: 'PRIVATE_HOST', failed: ['gpus', 'PRIVATE_PART', 7],
  http: { health: { httpStatus: 200, seconds: 0.004 }, models,
    props: { httpStatus: 200, seconds: 0.01, contextTokens: 65536, slots: 1, template: 'PRIVATE_TEMPLATE' } },
  sockets: { established: 3, synRecv: 0, closeWait: 1, listen: 1 },
  processes: { llamaServer: [{ pid: 108, ageSeconds: 5321, state: 'S', cmdline: 'PRIVATE_ARGUMENTS' }],
    sshd: { sessions: 2, unauthenticated: 4, startups: 4, dropFrom: 10, dropAllAt: 100 } },
  // The free memory is its own number here, not total minus used: the driver's reserve is counted in neither.
  gpus: [{ memoryUsedMiB: 28394, memoryFreeMiB: 3715, memoryTotalMiB: 32607, utilizationPercent: 97, temperatureC: 61, name: 'PRIVATE_NAME' }, { memoryUsedMiB: 1000 }],
  machine: { load1: 1.5, cpus: 16, memoryAvailableMiB: 50000, kernel: 'PRIVATE_KERNEL' },
  container: { throttledPeriods: 12, throttledSeconds: 3, memoryMiB: 30000, memoryLimitMiB: 64000, pressure: { scope: 'machine', cpu: 41.5, io: 0, memory: 'PRIVATE' } },
  serverEvents: { mode: '0o600', total: 3, rows: [
    { at: '2026-09-17T02:12:17.803123+00:00', event: 'server_started', pid: 108, line: 'PRIVATE_PROMPT' },
    { at: 'PRIVATE_TIME', event: 'server_diagnostic', category: 'PRIVATE category' },
    { event: 'PRIVATE event', category: 'out_of_memory' }] },
});

type Worker = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
function fixture(answer: (worker: Worker) => void) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv; script: Promise<string>; killed: boolean }[] = [];
  const spawnSsh: NonNullable<Options['spawn']> = (_command, args, options) => {
    const worker: Worker = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: (): boolean => { call.killed = true; return worker.emit('close', null, 'SIGTERM'); } });
    const script = (async () => { let text = ''; for await (const chunk of worker.stdin) text += chunk; return text; })();
    const call = { args, env: options.env, script, killed: false };
    calls.push(call);
    void script.then(() => answer(worker));
    return worker;
  };
  return { calls, spawn: spawnSsh };
}
const succeed = (output: string) => (worker: Worker) => { worker.stdout.write(`${output}\n`); worker.emit('close', 0, null); };
const answer = (status: number) => async () => ({ status, arrayBuffer: async () => new ArrayBuffer(0) });
const answers = answer(200);
const refuses = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
const stalls = async () => { throw Object.assign(new Error('PRIVATE_URL'), { name: 'TimeoutError' }); };
// What fetch reports when `ssh -L` accepts the connection and then closes it because the channel was refused.
const resets = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }); };

test('a snapshot compares the forwarded port with the server loopback and keeps only known fields', async () => {
  const f = fixture(succeed(remote()));
  process.env.SIMPLE_CHAT_SYNTHETIC_SECRET = 'PRIVATE_KEY';
  let report: Report;
  try { report = await diagnose({ host: 'synthetic-host', script: 'print(1)', spawn: f.spawn, request: answers, now: () => new Date(0) }); }
  finally { delete process.env.SIMPLE_CHAT_SYNTHETIC_SECRET; }
  assert.equal(report.reading, 'ok');
  assert.equal(report.at, '1970-01-01T00:00:00.000Z');
  assert.deepEqual([report.tunnel.models.httpStatus, report.tunnel.props?.httpStatus, report.direct.failure], [200, 200, undefined]);
  assert.deepEqual(f.calls[0].args.slice(-2), ['synthetic-host', 'python3 - --events 25']);
  for (const option of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ControlPath=none']) assert.ok(f.calls[0].args.includes(option));
  assert.equal(await f.calls[0].script, 'print(1)');
  assert.equal(f.calls[0].env.SIMPLE_CHAT_SYNTHETIC_SECRET, undefined);
  assert.deepEqual(report.remote!.processes, { llamaServer: [{ pid: 108, ageSeconds: 5321, state: 'S' }],
    sshd: { sessions: 2, unauthenticated: 4, startups: 4, dropFrom: 10, dropAllAt: 100 } });
  assert.deepEqual([report.remote!.failed, report.remote!.http.models.modelId], [['gpus'], 'synthetic-model']);
  assert.deepEqual(JSON.parse(JSON.stringify(report.remote!.gpus)), [{ memoryUsedMiB: 28394, memoryFreeMiB: 3715, memoryTotalMiB: 32607, utilizationPercent: 97, temperatureC: 61 }, { memoryUsedMiB: 1000 }]);
  assert.deepEqual(report.remote!.http.props, { httpStatus: 200, failure: undefined, seconds: 0.01, contextTokens: 65536, slots: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify([report.remote!.machine, report.remote!.container])), [{ load1: 1.5, cpus: 16, memoryAvailableMiB: 50000 },
    { throttledPeriods: 12, throttledSeconds: 3, memoryMiB: 30000, memoryLimitMiB: 64000, pressure: { scope: 'machine', cpu: 41.5, io: 0 } }]);
  // Rows survive only with a well-formed event name; a malformed time or category is dropped from its row.
  assert.deepEqual(JSON.parse(JSON.stringify(report.remote!.serverEvents.rows)), [
    { at: '2026-09-17T02:12:17.803123+00:00', event: 'server_started', pid: 108 }, { event: 'server_diagnostic' }]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('the reading separates a missing tunnel, a failing SSH path and a server that does not answer', async () => {
  const read = async (request: NonNullable<Options['request']>, models?: object) =>
    (await diagnose({ script: '', spawn: fixture(succeed(remote(models))).spawn, request })).reading;
  assert.equal(await read(refuses), 'no_tunnel');
  assert.equal(await read(stalls), 'ssh_path');
  assert.equal(await read(resets), 'ssh_path');
  assert.equal(await read(answer(503)), 'ssh_path');
  assert.equal(await read(answers, { failure: 'timeout', seconds: 5 }), 'server');
  assert.equal(await read(stalls, { httpStatus: 503, seconds: 0.01 }), 'server');
  // A slow answer is still an answer; the time is in the report.
  assert.equal(await read(answers, { httpStatus: 200, seconds: 4.2 }), 'ok');
  // A model named by its file path is reported without the name.
  const unnamed = await diagnose({ script: '', spawn: fixture(succeed(remote({ httpStatus: 200, seconds: 0.01, modelId: '/PRIVATE/model.gguf' }))).spawn, request: answers });
  assert.deepEqual([unnamed.reading, unnamed.remote!.http.models.modelId], ['ok', undefined]);

  // The bot's check: /v1/models, then /props, and nothing after a failed step.
  const paths: string[] = [];
  const second = await diagnose({ script: '', spawn: fixture(succeed(remote())).spawn,
    request: async url => { paths.push(new URL(url).pathname); return paths.length === 1 ? answers() : stalls(); } });
  assert.deepEqual([paths, second.reading, second.tunnel.props?.failure], [['/v1/models', '/props'], 'ssh_path', 'timeout']);
  const stalled = await diagnose({ script: '', spawn: fixture(succeed(remote())).spawn, request: stalls });
  assert.deepEqual([stalled.tunnel.models.failure, stalled.tunnel.props], ['timeout', undefined]);
  assert.equal((await diagnose({ script: '', spawn: fixture(succeed(remote())).spawn, request: resets })).tunnel.models.failure, 'UND_ERR_SOCKET');
  assert.doesNotMatch(JSON.stringify([second, stalled]), /PRIVATE/);
});

test('a failed SSH session reports only its status, signal and a fixed reason', async () => {
  const refused = await diagnose({ script: '', request: answers, spawn: fixture(worker => {
    worker.stderr.write('ssh: connect to host PRIVATE_HOST port 40022: Connection timed out\n');
    worker.emit('close', 255, null);
  }).spawn });
  assert.equal(refused.reading, 'ssh_unreachable');
  assert.equal(refused.remote, undefined);
  const { seconds, ...failure } = refused.direct;
  assert.ok(seconds >= 0);
  assert.deepEqual(failure, { failure: 'ssh_failed', exitCode: 255, signal: undefined, sshReason: 'connect_timeout' });
  assert.doesNotMatch(JSON.stringify(refused), /PRIVATE|40022/);

  const script = await diagnose({ script: '', request: answers, spawn: fixture(worker => {
    worker.stderr.write('Traceback PRIVATE_PATH\n'); worker.emit('close', 1, null);
  }).spawn });
  assert.deepEqual([script.reading, script.direct.failure, script.direct.exitCode], ['unclear', 'remote_failed', 1]);
  const banner = await diagnose({ script: '', request: answers, spawn: fixture(succeed('PRIVATE banner, not a report')).spawn });
  assert.deepEqual([banner.reading, banner.direct.failure], ['unclear', 'invalid_output']);
  // Text a login script prints before the report does not matter.
  assert.equal((await diagnose({ script: '', request: answers, spawn: fixture(succeed(`PRIVATE banner\n${remote()}`)).spawn })).reading, 'ok');
  assert.doesNotMatch(JSON.stringify([script, banner]), /PRIVATE/);

  // A session that never answers is stopped at the deadline.
  const silent = fixture(() => {});
  const hung = await diagnose({ script: '', request: answers, timeoutMs: 5, spawn: silent.spawn });
  assert.deepEqual([hung.reading, hung.direct.failure, silent.calls[0].killed], ['ssh_unreachable', 'ssh_timeout', true]);
});

test('a watcher keeps one session open, probes the tunnel on every line and reopens a session that ended', async () => {
  const f = fixture(worker => {
    worker.stdout.write(`${remote()}\nPRIVATE banner\n${remote({ failure: 'timeout', seconds: 5 })}\n`);
    setTimeout(() => { worker.stderr.write('Timeout, server PRIVATE_HOST not responding.\n'); worker.emit('close', 255, null); }, 5);
  });
  const stopped = new AbortController();
  const reports: Report[] = [];
  await watch({ host: 'synthetic-host', every: 30, retryMs: 1, script: 'print(1)', spawn: f.spawn, request: answers, signal: stopped.signal }, report => {
    reports.push(report);
    if (reports.length === 6) stopped.abort();
  });
  assert.deepEqual(reports.map(report => report.reading), ['ok', 'server', 'ssh_unreachable', 'ok', 'server', 'ssh_unreachable']);
  assert.deepEqual([reports[0].direct.failure, reports[0].remote!.http.models.modelId], [undefined, 'synthetic-model']);
  const { seconds, ...ended } = reports[2].direct;
  assert.ok(seconds >= 0);
  assert.deepEqual([ended, reports[2].remote], [{ failure: 'ssh_failed', exitCode: 255, signal: undefined, sshReason: 'keepalive_timeout' }, undefined]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args.slice(-2), ['synthetic-host', 'python3 - --events 5 --every 30']);
  for (const option of ['ControlPath=none', 'ServerAliveInterval=15', 'ServerAliveCountMax=3']) assert.ok(f.calls[0].args.includes(option));
  assert.equal(await f.calls[0].script, 'print(1)');
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/);
});

test('a watching session that goes quiet is reported as stalled; stopping the watcher ends its SSH process', async () => {
  const f = fixture(worker => { worker.stdout.write(`${remote()}\n`); });
  const stopped = new AbortController();
  const reports: Report[] = [];
  await watch({ every: 30, retryMs: 1, silenceMs: 5, script: '', spawn: f.spawn, request: stalls, signal: stopped.signal }, report => {
    reports.push(report);
    if (reports.length === 3) stopped.abort();
  });
  assert.deepEqual(reports.map(report => [report.reading, report.direct.failure, report.tunnel.models.failure]),
    [['ssh_path', undefined, 'timeout'], ['ssh_stalled', 'ssh_silent', 'timeout'], ['ssh_stalled', 'ssh_silent', 'timeout']]);
  // The exit of a stopped session is not reported, and no new session follows.
  assert.deepEqual(f.calls.map(call => call.killed), [true]);
  // A session that delivers nothing at all is ended and replaced.
  const mute = fixture(() => {});
  const muted = new AbortController();
  const failures: Report[] = [];
  await watch({ every: 30, retryMs: 1, startMs: 5, script: '', spawn: mute.spawn, request: answers, signal: muted.signal }, report => {
    failures.push(report);
    if (failures.length === 2) muted.abort();
  });
  assert.deepEqual(failures.map(report => [report.reading, report.direct.failure]), [['ssh_unreachable', 'ssh_timeout'], ['ssh_unreachable', 'ssh_timeout']]);
  assert.deepEqual(mute.calls.map(call => call.killed), [true, true]);
  // The remote script ends with status 0 at its own time limit: a new session follows and no failure is reported.
  const limited = fixture(worker => { worker.stdout.write(`${remote()}\n`); worker.emit('close', 0, null); });
  const again = new AbortController();
  const rows: Report[] = [];
  await watch({ every: 30, retryMs: 1, script: '', spawn: limited.spawn, request: answers, signal: again.signal }, report => {
    rows.push(report);
    if (rows.length === 2) again.abort();
  });
  assert.deepEqual(rows.map(report => report.reading), ['ok', 'ok']);
  assert.equal(limited.calls.length, 2);
  // A snapshot that cannot be written ends the watch with that error instead of a quiet terminal.
  const unsaved = fixture(worker => { worker.stdout.write(`${remote()}\n`); });
  await assert.rejects(watch({ every: 30, retryMs: 1, script: '', spawn: unsaved.spawn, request: answers, signal: new AbortController().signal },
    () => { throw new Error('synthetic_disk_full'); }), { message: 'synthetic_disk_full' });
  assert.deepEqual(unsaved.calls.map(call => call.killed), [true]);
  await assert.rejects(watch({ every: 5, spawn: f.spawn, request: answers, signal: stopped.signal }, () => {}), { message: 'invalid_interval' });
  await assert.rejects(watch({ host: '-oProxyCommand=synthetic', every: 30, spawn: f.spawn, request: answers, signal: stopped.signal }, () => {}), { message: 'invalid_host' });
});

test('a host or an event count that is not plain is refused before SSH starts', async () => {
  const f = fixture(succeed(remote()));
  await assert.rejects(diagnose({ host: '-oProxyCommand=synthetic', spawn: f.spawn, request: answers }), { message: 'invalid_host' });
  await assert.rejects(diagnose({ events: 1.5, spawn: f.spawn, request: answers }), { message: 'invalid_events' });
  await assert.rejects(diagnose({ events: -1, spawn: f.spawn, request: answers }), { message: 'invalid_events' });
  assert.equal(f.calls.length, 0);
  assert.equal((await diagnose({ events: 'all', script: '', spawn: f.spawn, request: answers })).reading, 'ok');
  assert.equal(f.calls[0].args.at(-1), 'python3 - --events all');
});

test('snapshots are appended privately; pulled server events go to their own file', async t => {
  const directory = join(mkdtempSync(join(tmpdir(), 'simple-chat-diagnose-')), 'synthetic-logs');
  t.after(() => rmSync(resolve(directory, '..'), { recursive: true, force: true }));
  // A directory made earlier with wider access is closed as well.
  mkdirSync(directory, { mode: 0o755 });
  const take = () => diagnose({ script: '', spawn: fixture(succeed(remote())).spawn, request: answers, now: () => new Date(Date.UTC(2026, 8, 17, 2, 12, 17, 803)) });
  save(directory, await take(), false);
  const line = save(directory, await take(), true);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const rows = readFileSync(join(directory, 'gpu-diagnose.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row) as Report);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].remote!.serverEvents.rows.length, 2);
  assert.deepEqual(rows[1], JSON.parse(line));
  assert.deepEqual([rows[1].remote!.serverEvents.rows, rows[1].remote!.serverEvents.savedTo], [[], 'synthetic-logs/gpu-server-events-20260917T021217803Z.jsonl']);
  assert.deepEqual(readdirSync(directory).sort(), ['gpu-diagnose.jsonl', 'gpu-server-events-20260917T021217803Z.jsonl']);
  const pulled = readFileSync(join(directory, 'gpu-server-events-20260917T021217803Z.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(pulled.map(row => row.event), ['server_started', 'server_diagnostic']);
  for (const name of readdirSync(directory)) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
});

test('the remote script reports a synthetic server and retained events without anything else they contain', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-diagnose-remote-'));
  const server = createServer((request, response) => {
    const body = request.url === '/health' ? { status: 'ok' }
      : request.url === '/v1/models' ? { data: [{ id: 'synthetic-model', owned_by: 'PRIVATE_OWNER' }] }
      : request.url === '/props' ? { default_generation_settings: { n_ctx: 65536, prompt: 'PRIVATE_PROMPT' }, total_slots: 1, chat_template: 'PRIVATE_TEMPLATE' }
      : null;
    response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? { error: 'PRIVATE_ERROR' }));
  });
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  writeFileSync(join(directory, 'server-events.jsonl.1'), '{"at":"2026-09-17T02:00:00+00:00","event":"server_started","pid":7}\n');
  writeFileSync(join(directory, 'server-events.jsonl'), [
    '{"at":"2026-09-17T02:13:00.5+00:00","event":"server_diagnostic","category":"out_of_memory","line":"PRIVATE_PROMPT"}',
    'PRIVATE_STORY, not JSON', '{"event":"PRIVATE event"}', '["PRIVATE_LIST"]',
    '{"at":"2026-09-17T02:14:00+00:00","event":"server_exit","signal":"SIGKILL","exitCode":"PRIVATE"}'].join('\n') + '\n', { mode: 0o600 });

  const run = async (events: string, ...more: string[]) => {
    // As over SSH: the script arrives on standard input. The server above answers while the child runs.
    const child = spawn('python3', ['-', '--dir', directory, '--port', String((server.address() as AddressInfo).port), '--events', events, ...more],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.end(readFileSync(fileURLToPath(new URL('../gpu/diagnose-remote.py', import.meta.url)), 'utf8'));
    const [status] = await once(child, 'close');
    assert.deepEqual([status, errors], [0, '']);
    assert.doesNotMatch(output, /PRIVATE/);
    return output.trim().split('\n').map(line => JSON.parse(line));
  };
  const [report, ...rest] = await run('2');
  assert.equal(rest.length, 0);
  assert.deepEqual([report.http.health.httpStatus, report.http.models.modelId, report.http.props.contextTokens, report.http.props.slots], [200, 'synthetic-model', 65536, 1]);
  assert.ok(report.sockets.listen >= 1);
  assert.deepEqual(report.processes.llamaServer, []);
  assert.deepEqual(report.serverEvents, { mode: '0o600', total: 3, rows: [
    { at: '2026-09-17T02:13:00.5+00:00', event: 'server_diagnostic', category: 'out_of_memory' },
    { at: '2026-09-17T02:14:00+00:00', event: 'server_exit', signal: 'SIGKILL' }] });
  // Rotated files come first, so a full pull stays in order.
  assert.deepEqual((await run('all'))[0].serverEvents.rows.map((row: { event: string }) => row.event), ['server_started', 'server_diagnostic', 'server_exit']);
  assert.deepEqual((await run('0'))[0].serverEvents.rows, []);
  assert.ok(Number.isInteger(report.machine.cpus) && typeof report.container === 'object' && Number.isInteger(report.processes.sshd.sessions));
  // A watcher prints a line per interval and ends by itself at its time limit.
  const lines = await run('0', '--every', '1', '--limit', '2');
  assert.deepEqual(lines.map(line => line.http.health.httpStatus), [200, 200]);
});
