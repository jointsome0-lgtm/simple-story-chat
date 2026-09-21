// Read-only diagnostics for the rented GPU, run on the bot host while a problem is happening:
//   npm run gpu:diagnose                 one snapshot through a new SSH session
//   npm run gpu:diagnose -- --watch 30   a snapshot every 30 seconds through one SSH session that stays open, until Ctrl+C
//                                        (down to --watch 1, for the seconds in which a starting server runs out of memory)
//   npm run gpu:diagnose -- --pull       also save every retained server event under logs/
// It asks the same question twice at the same moment: through the bot's forwarded port, and on the server's own
// loopback through a separate SSH session. No Telegram, story DB, prompts or server output are read. Hosts, raw
// SSH errors and any string the remote side could choose freely are never printed or saved. The SSH alias is
// SIMPLE_CHAT_GPU_SSH_HOST, as for the bot, unless --host names another.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sshEnvironment, sshReasonOf } from './gpu-connection.ts';
import type { SshReason } from './gpu-connection.ts';
import { safeErrorDetails } from './model-error.ts';

type Stream = { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
// The part of a spawned SSH process the diagnostic uses, so tests can pass a fake.
type SshProcess = {
  stdin: { end(data: string): unknown; on(event: 'error', listener: () => void): unknown };
  stdout: Stream; stderr: Stream; kill(): unknown;
  once(event: 'error', listener: () => void): unknown;
  once(event: 'exit' | 'close', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
};
export type SpawnSsh = (command: 'ssh', args: string[], options: { stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }) => SshProcess;
type Request = (url: string, init: { signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; arrayBuffer(): Promise<unknown> }>;

type Probe = { httpStatus?: number; failure?: string; seconds?: number };
type ServerEvent = { at?: string; event?: string; category?: string; pid?: number; exitCode?: number; signal?: string };
// `failed` names the parts the remote script could not read; the other parts still arrive.
export type Remote = {
  at?: string; failed: string[];
  http: { health: Probe; models: Probe & { modelId?: string }; props: Probe & { contextTokens?: number; slots?: number } };
  sockets: { established?: number; synRecv?: number; closeWait?: number; listen?: number };
  processes: { llamaServer: { pid?: number; ageSeconds?: number; state?: string }[];
    sshd: { sessions?: number; unauthenticated?: number; startups?: number; dropFrom?: number; dropAllAt?: number } };
  // `index` is the driver's own card number and `pids` the compute processes on it: a reading from a box with
  // several cards belongs to one of them, and only the pids say which card llama-server occupies.
  gpus: { index?: number; pids: number[]; memoryUsedMiB?: number; memoryFreeMiB?: number; memoryTotalMiB?: number;
    utilizationPercent?: number; temperatureC?: number }[];
  machine: { load1?: number; cpus?: number; memoryAvailableMiB?: number };
  // `pressure.scope` is `machine` when the kernel offers the numbers only for the whole machine, other tenants included.
  container: { throttledPeriods?: number; throttledSeconds?: number; memoryMiB?: number; memoryLimitMiB?: number;
    pressure: { scope?: string; cpu?: number; io?: number; memory?: number } };
  serverEvents: { mode?: string; total?: number; rows: ServerEvent[]; savedTo?: string };
};
// ssh_failed: SSH itself ended with its own status 255 or could not start. remote_failed: the session worked and the
// script ended with another status. invalid_output: the script's last line was not its JSON report. ssh_silent: the
// watching session is open, yet its next line did not arrive. `seconds` is how long the session has lasted.
type Direct = { seconds: number; failure?: 'ssh_failed' | 'ssh_timeout' | 'ssh_silent' | 'remote_failed' | 'invalid_output'; exitCode?: number; signal?: string; sshReason?: SshReason };
// ok: both paths answer. no_tunnel: nothing listens on the forwarded port. ssh_path: the server answers on its own
// loopback while the forwarded port does not. server: it does not answer even there. ssh_unreachable: no separate
// SSH session either. ssh_stalled: the watching session stopped delivering. unclear: the session worked, yet it
// returned no report.
export type Reading = 'ok' | 'no_tunnel' | 'ssh_path' | 'server' | 'ssh_unreachable' | 'ssh_stalled' | 'unclear';
// `tunnel.props` is absent when `models` failed: the bot's check stops there as well.
export type Report = { at: string; reading: Reading; tunnel: { models: Probe; props?: Probe }; direct: Direct; remote?: Remote };
export type Options = {
  host?: string; events?: number | 'all'; script?: string; timeoutMs?: number;
  spawn?: SpawnSsh; request?: Request; now?: () => Date;
};
// `every` is in seconds. A lost session is reopened after `retryMs`. A session gets `startMs` to deliver its first
// line; after that a line later than `silenceMs` counts as missing.
export type WatchOptions = Pick<Options, 'host' | 'script' | 'spawn' | 'request' | 'now'> &
// `events` is how many retained server events each line carries; a watcher that only wants counters asks for none.
  { every: number; signal: AbortSignal; retryMs?: number; startMs?: number; silenceMs?: number; events?: number };

const script = () => readFileSync(new URL('../gpu/diagnose-remote.py', import.meta.url), 'utf8');

// The remote report is rebuilt field by field: numbers, and strings of a fixed shape.
type Fields = { readonly [key: string]: unknown };
const fields = (value: unknown): Fields => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value) ? value : undefined;
const NAME = /^[A-Za-z_]{1,40}$/;
const PARTS = ['sockets', 'processes', 'gpus', 'machine', 'container', 'http', 'serverEvents'];
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const probeOf = (value: unknown): Probe => {
  const probe = fields(value);
  return { httpStatus: count(probe.httpStatus), failure: text(probe.failure, NAME), seconds: amount(probe.seconds) };
};

export function remoteOf(value: unknown): Remote {
  const report = fields(value);
  const http = fields(report.http), sockets = fields(report.sockets), processes = fields(report.processes);
  const sshd = fields(processes.sshd), machine = fields(report.machine), events = fields(report.serverEvents);
  const container = fields(report.container), pressure = fields(container.pressure);
  const models = fields(http.models), props = fields(http.props);
  return {
    at: text(report.at, AT),
    failed: list(report.failed).filter(part => typeof part === 'string' && PARTS.includes(part)) as string[],
    http: { health: probeOf(http.health),
      // A model started without an alias is named by its file path; a path never matches.
      models: { ...probeOf(models), modelId: text(models.modelId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/) },
      props: { ...probeOf(props), contextTokens: count(props.contextTokens), slots: count(props.slots) } },
    sockets: { established: count(sockets.established), synRecv: count(sockets.synRecv), closeWait: count(sockets.closeWait), listen: count(sockets.listen) },
    processes: {
      llamaServer: list(processes.llamaServer).slice(0, 16).map(fields).map(server =>
        ({ pid: count(server.pid), ageSeconds: count(server.ageSeconds), state: text(server.state, /^[A-Za-z]$/) })),
      sshd: { sessions: count(sshd.sessions), unauthenticated: count(sshd.unauthenticated), startups: count(sshd.startups),
        dropFrom: count(sshd.dropFrom), dropAllAt: count(sshd.dropAllAt) } },
    gpus: list(report.gpus).slice(0, 16).map(fields).map(gpu => ({ index: count(gpu.index),
      pids: list(gpu.pids).slice(0, 64).map(count).filter((pid): pid is number => pid !== undefined),
      memoryUsedMiB: count(gpu.memoryUsedMiB),
      memoryFreeMiB: count(gpu.memoryFreeMiB), memoryTotalMiB: count(gpu.memoryTotalMiB),
      utilizationPercent: count(gpu.utilizationPercent), temperatureC: count(gpu.temperatureC) })),
    machine: { load1: amount(machine.load1), cpus: count(machine.cpus), memoryAvailableMiB: count(machine.memoryAvailableMiB) },
    container: { throttledPeriods: count(container.throttledPeriods), throttledSeconds: count(container.throttledSeconds),
      memoryMiB: count(container.memoryMiB), memoryLimitMiB: count(container.memoryLimitMiB),
      pressure: { scope: text(pressure.scope, /^(container|machine)$/), cpu: amount(pressure.cpu), io: amount(pressure.io), memory: amount(pressure.memory) } },
    serverEvents: { mode: text(events.mode, /^0o[0-7]{1,4}$/), total: count(events.total),
      rows: list(events.rows).map(fields).map(row => ({ at: text(row.at, AT), event: text(row.event, /^[a-z_]{1,40}$/),
        category: text(row.category, /^[a-z_]{1,40}$/), pid: count(row.pid), exitCode: count(row.exitCode),
        signal: text(row.signal, /^SIG[A-Z0-9+-]{2,10}$/) })).filter(row => row.event) },
  };
}

async function probe(request: Request, path: string, signal: AbortSignal): Promise<Probe> {
  const started = performance.now();
  const seconds = () => Math.round(performance.now() - started) / 1000;
  try {
    const response = await request(`http://127.0.0.1:8080${path}`, { signal, redirect: 'error' });
    // Read in full, as the bot does, and dropped.
    await response.arrayBuffer();
    return { httpStatus: response.status, seconds: seconds() };
  } catch (error) {
    // Thrown values are not checked: fetch failures carry a name and a cause with a system code.
    const thrown = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } | null } | null;
    const failure = thrown?.name === 'TimeoutError' ? 'timeout'
      : safeErrorDetails({ transportCode: thrown?.cause?.code ?? thrown?.code }).transportCode ?? 'other';
    return { failure, seconds: seconds() };
  }
}

// The bot's own check, step for step: /v1/models, then /props, under one 8-second deadline. Its result can be set
// against the bot's `gpu_check_failed` events. The model name and context size are the bot's business and are not compared.
async function tunnelCheck(request: Request, stopped?: AbortSignal): Promise<Report['tunnel']> {
  const deadline = AbortSignal.timeout(8000);
  const signal = stopped ? AbortSignal.any([deadline, stopped]) : deadline;
  const models = await probe(request, '/v1/models', signal);
  return models.httpStatus === 200 ? { models, props: await probe(request, '/props', signal) } : { models };
}

// ControlPath=none: the session is a connection of its own even when the owner's SSH configuration shares connections.
const SSH = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', '-o', 'ControlPath=none'];
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const failureOf = (exitCode: number | null) => exitCode === 0 ? undefined : exitCode === null || exitCode === 255 ? 'ssh_failed' : 'remote_failed';
// `close` follows `exit` once the output has been read. A helper of SSH that keeps the pipes open would delay it
// without limit, so a finished process is given this long.
const DRAIN_MS = 2000;

function direct(host: string, events: number | 'all', source: string, spawnChild: SpawnSsh, timeoutMs: number) {
  return new Promise<{ direct: Direct; remote?: Remote }>(resolve => {
    const started = performance.now();
    const child = spawnChild('ssh', [...SSH, host, `python3 - --events ${events}`], { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnvironment() });
    let output = '';
    let diagnostic = '';
    let sshReason: SshReason | undefined;
    let settled = false;
    const settle = (failure?: Direct['failure'], details: unknown = {}, remote?: Remote) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { exitCode, signal } = safeErrorDetails(details);
      resolve({ direct: { seconds: Math.round(performance.now() - started) / 1000, failure, exitCode, signal, sshReason: failure && sshReason }, remote });
    };
    const timer = setTimeout(() => { settle('ssh_timeout'); child.kill(); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { if (output.length < 16_000_000) output += chunk.toString(); });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2048); sshReason = sshReasonOf(diagnostic, sshReason); });
    const ended = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0) return settle(failureOf(exitCode), { exitCode, signal });
      let parsed: unknown;
      try { parsed = JSON.parse(output.trim().split('\n').at(-1) ?? ''); } catch { return settle('invalid_output'); }
      settle(undefined, {}, remoteOf(parsed));
    };
    child.once('error', () => settle('ssh_failed'));
    child.once('close', ended);
    child.once('exit', (exitCode, signal) => setTimeout(() => ended(exitCode, signal), DRAIN_MS).unref());
    child.stdin.end(source);
  });
}

function reading(tunnel: Report['tunnel'], session: Direct, remote: Remote | undefined): Reading {
  // Both steps of the bot's check. How long they took is in `seconds`; a slow answer is still an answer.
  const passes = (check: Report['tunnel']) => check.models.httpStatus === 200 && check.props?.httpStatus === 200;
  if (!remote) return session.failure === 'ssh_silent' ? 'ssh_stalled'
    : session.failure === 'ssh_failed' || session.failure === 'ssh_timeout' ? 'ssh_unreachable' : 'unclear';
  if (!passes(remote.http)) return 'server';
  if (passes(tunnel)) return 'ok';
  return tunnel.models.failure === 'ECONNREFUSED' ? 'no_tunnel' : 'ssh_path';
}

export async function diagnose({ host = 'simple-chat-vast', events = 25, script: source = script(), timeoutMs = events === 'all' ? 60000 : 30000,
  spawn: spawnChild = spawn, request = fetch, now = () => new Date() }: Options = {}): Promise<Report> {
  if (!HOST.test(host)) throw new Error('invalid_host');
  if (events !== 'all' && !(Number.isSafeInteger(events) && events >= 0 && events <= 9999)) throw new Error('invalid_events');
  const at = now().toISOString();
  const [tunnel, session] = await Promise.all([tunnelCheck(request), direct(host, events, source, spawnChild, timeoutMs)]);
  return { at, reading: reading(tunnel, session.direct, session.remote), tunnel, direct: session.direct, remote: session.remote };
}

// On 17 September sessions that were already open kept working while new ones hung. A watcher therefore keeps one
// session open and the remote script reports through it, so a failure that starts later can still be seen from the
// server's side. Every line is paired with a probe of the forwarded port made on its arrival.
export async function watch({ host = 'simple-chat-vast', every, script: source = script(), retryMs = Math.max(5000, every * 1000), startMs = 30000, silenceMs = every * 1000 + 20000,
  spawn: spawnChild = spawn, request = fetch, now = () => new Date(), signal: stopped, events = 5 }: WatchOptions, emit: (report: Report) => void): Promise<void> {
  if (!HOST.test(host)) throw new Error('invalid_host');
  // A second between lines is allowed: a server that runs out of memory does it within seconds of its start, and a
  // slower watch reports nothing but the exit. A lost session is still reopened no faster than every five seconds.
  if (!(Number.isSafeInteger(every) && every >= 1 && every <= 3600)) throw new Error('invalid_interval');
  if (!(Number.isSafeInteger(events) && events >= 0 && events <= 9999)) throw new Error('invalid_events');
  const session = () => new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const age = () => Math.round(performance.now() - started) / 1000;
    // Keepalives end a session whose path is dead, as they do for the bot's tunnel; the exit is then reported.
    const child = spawnChild('ssh', [...SSH, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', host,
      `python3 - --events ${events} --every ${every}`], { stdio: ['pipe', 'pipe', 'pipe'], env: sshEnvironment() });
    let pending = '';
    let diagnostic = '';
    let sshReason: SshReason | undefined;
    let reports = Promise.resolve();
    const report = (direct: Direct, remote?: Remote) => {
      const at = now().toISOString();
      reports = reports.then(async () => {
        const tunnel = await tunnelCheck(request, stopped);
        if (!stopped.aborted) emit({ at, reading: reading(tunnel, direct, remote), tunnel, direct, remote });
      });
      // A snapshot that cannot be written ends the watch with that error: a quiet terminal would pass for a healthy one.
      reports.catch(() => { closed(undefined); child.kill(); });
    };
    let delivered = false;
    const silent = () => {
      if (delivered) { report({ seconds: age(), failure: 'ssh_silent' }); silence = setTimeout(silent, silenceMs); }
      // A session that never delivered is not kept: it may still be waiting for authentication.
      else { closed('ssh_timeout'); child.kill(); }
    };
    let silence = setTimeout(silent, startMs);
    // Stopping does not wait for the process: nothing more is reported after it.
    const stop = () => { closed(undefined); child.kill(); };
    stopped.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-2048); sshReason = sshReasonOf(diagnostic, sshReason); });
    child.stdout.on('data', chunk => {
      pending = (pending + chunk.toString()).slice(-4_000_000);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        clearTimeout(silence);
        silence = setTimeout(silent, silenceMs);
        delivered = true;
        report({ seconds: age() }, remoteOf(parsed));
      }
    });
    let finished = false;
    const closed = (failure: Direct['failure'], details: unknown = {}) => {
      // A process that could not start reports `error` and may report `close` as well.
      if (finished) return;
      finished = true;
      clearTimeout(silence);
      stopped.removeEventListener('abort', stop);
      const { exitCode, signal } = safeErrorDetails(details);
      // The remote script ends by itself at its time limit with status 0; that is not a failure.
      if (failure) report({ seconds: age(), failure, exitCode, signal, sshReason });
      reports.then(resolve, reject);
    };
    child.once('error', () => closed('ssh_failed'));
    child.once('close', (exitCode, signal) => closed(failureOf(exitCode), { exitCode, signal }));
    child.once('exit', (exitCode, signal) => setTimeout(() => closed(failureOf(exitCode), { exitCode, signal }), DRAIN_MS).unref());
    child.stdin.end(source);
  });
  while (!stopped.aborted) {
    await session();
    await delay(retryMs, undefined, { signal: stopped }).catch(() => {});
  }
}

// Logs stay private to the owner; the directory is already ignored by Git. One made earlier with wider access is closed.
export function save(directory: string, report: Report, pull: boolean) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (pull && report.remote) {
    const events = report.remote.serverEvents;
    const name = `gpu-server-events-${report.at.replace(/[-:.]/g, '')}.jsonl`;
    writeFileSync(`${directory}/${name}`, events.rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600, flag: 'wx' });
    events.savedTo = `${basename(directory)}/${name}`;
    events.rows = [];
  }
  const line = JSON.stringify(report);
  appendFileSync(`${directory}/gpu-diagnose.jsonl`, line + '\n', { mode: 0o600 });
  return line;
}

async function main(args: string[]) {
  let host = process.env.SIMPLE_CHAT_GPU_SSH_HOST || undefined;
  let every: number | undefined;
  let pull = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--pull') pull = true;
    else if (arg === '--host' && args.length) host = args.shift();
    else if (arg === '--watch' && /^\d{1,4}$/.test(args[0] ?? '') && Number(args[0]) >= 1 && Number(args[0]) <= 3600) every = Number(args.shift());
    else throw new Error('Usage: npm run gpu:diagnose -- [--host SSH_ALIAS] [--watch SECONDS(1-3600)] [--pull]');
  }
  if (pull && every) throw new Error('Use --pull for a single snapshot, not with --watch');
  const directory = fileURLToPath(new URL('../logs', import.meta.url));
  const stopped = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stopped.abort());
  if (every) return watch({ host, every, signal: stopped.signal }, report => console.log(save(directory, report, false)));
  const report = await diagnose({ host, events: pull ? 'all' : 25 });
  // Ctrl+C in a terminal also interrupts the snapshot's own SSH process; such a result says nothing about the server.
  if (!stopped.signal.aborted) console.log(save(directory, report, pull));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  // A stopped SSH process may leave a helper that still holds its pipes. The work is done either way; lines still
  // queued for a slow reader are written first.
  process.stdout.write('', () => process.exit());
}
