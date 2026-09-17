import { spawn } from 'node:child_process';
import type { ErrorDetails, Log } from './model-error.ts';
import { ModelError } from './model-error.ts';

type Output = { on(event: 'data', listener: (chunk: Buffer) => void): unknown };
// The part of a spawned SSH process the connection uses, so tests can pass a fake.
type SshProcess = {
  stdout: Output; stderr: Output; kill(): unknown;
  once(event: 'error', listener: () => void): unknown;
  once(event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
};
export type SpawnSsh = (command: 'ssh', args: string[], options: { stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }) => SshProcess;
// A started tunnel: `ready` settles once its forwarding is confirmed or the process ends first; `stop` closes it.
type Tunnel = { ready: Promise<void>; stop: () => void };
export type SshReason = NonNullable<ErrorDetails['sshReason']>;

// A killed attempt can stay unauthenticated on the remote side for minutes, and the controller asks again on every
// 10-second tick. Failed attempts are therefore spaced out. A tunnel that stayed up this long reconnects at once.
const RETRY_MS = [10000, 20000, 30000];
const STABLE_MS = 60000;

// SSH diagnostics may contain hostnames or paths. Classify only in RAM; no raw
// stderr, addresses or arbitrary error codes reach logs. A specific reason found earlier is kept.
export function sshReasonOf(diagnostic: string, previous?: SshReason): SshReason | undefined {
  const text = diagnostic.toLowerCase();
  let reason: SshReason | undefined = previous ?? (text.trim() ? 'other' : undefined);
  for (const [pattern, value] of [
    [/permission denied/, 'authentication'],
    [/host key verification failed|remote host identification has changed/, 'host_key'],
    [/address already in use|cannot listen to port/, 'port_in_use'],
    [/connection timed out|operation timed out/, 'connect_timeout'],
    [/connection refused/, 'connection_refused'],
    [/broken pipe|connection reset|connection closed|closed by remote host/, 'connection_lost'],
    // OpenSSH names the host inside this message: "Timeout, server HOST not responding."
    [/not responding/, 'keepalive_timeout'],
    [/network is unreachable|no route to host/, 'network_unreachable'],
  ] satisfies [RegExp, SshReason][]) if (pattern.test(text)) reason = value;
  return reason;
}

// An SSH child gets no bot configuration or credentials from the environment.
export const sshEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('SIMPLE_CHAT_') && !['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'VAST_API_KEY'].includes(key)));

// SSH configuration contains the host, port and identity; it is never committed.
// Both the model listener and forwarded port stay on loopback. Reconnect after
// Vast resumes; refuse changed host keys or an already occupied local port.
export function createGpuConnection(host: string, { spawn: spawnChild = spawn, log = () => {}, now = Date.now }:
  { spawn?: SpawnSsh; log?: Log; now?: () => number } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new ModelError('gpu_config');
  let child: Tunnel | undefined;
  let failures = 0;
  let retryAt = -Infinity;
  return {
    ensure() {
      if (child) return child.ready;
      // A postponed attempt starts no process; the caller asks again on its next tick. The phase tells its log row
      // from one of a real attempt.
      if (now() < retryAt) return Promise.reject(new ModelError('gpu_connection_failed', { phase: 'ssh_wait' }));
      const worker = spawnChild('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=yes', '-L', '127.0.0.1:8080:127.0.0.1:8080', host,
        "bash /workspace/simple-chat/gpu/ensure-server.sh && printf 'SIMPLE_CHAT_TUNNEL_READY\\n' && exec sleep infinity"],
      { stdio: ['ignore', 'pipe', 'pipe'], env: sshEnvironment() });
      const started = now();
      // `stop` is set by the promise executor, which runs before the tunnel is created. `finish` runs only later,
      // from process events, the timer or `stop`, so the tunnel exists by then.
      let stop!: () => void;
      // SSH runs the command only after establishing its forwarding. A health
      // response from an unrelated listener on 8080 cannot establish readiness.
      const readiness = new Promise<void>((resolve, reject) => {
        let output = '';
        let diagnostic = '';
        let sshReason: SshReason | undefined;
        let ready = false;
        let finished = false;
        const timer = setTimeout(() => { finish('ready_timeout'); worker.kill(); }, 12000);
        const finish = (code: string, details: { exitCode?: number | null; signal?: NodeJS.Signals | null } = {}) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (child === tunnel) child = undefined;
          const connectionAgeMs = Math.max(0, now() - started);
          // `close` has already cleared the delay for a requested close.
          if (code !== 'requested_close') {
            if (ready && connectionAgeMs >= STABLE_MS) { failures = 0; retryAt = -Infinity; }
            else retryAt = now() + RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)];
          }
          log('gpu_connection_closed', code, { phase: ready ? 'ssh_tunnel' : 'ssh_connect', connectionAgeMs, sshReason, ...details });
          reject(new ModelError('gpu_connection_failed'));
        };
        stop = () => { finish('requested_close'); worker.kill(); };
        worker.once('error', () => finish('process_error'));
        worker.once('exit', (exitCode, signal) => finish('process_exit', { exitCode, signal }));
        worker.stderr.on('data', chunk => {
          if (finished) return;
          diagnostic = (diagnostic + chunk.toString()).slice(-2048);
          sshReason = sshReasonOf(diagnostic, sshReason);
        });
        worker.stdout.on('data', chunk => {
          if (finished || ready) return;
          output = (output + chunk.toString()).slice(-128);
          if (output.split('\n').includes('SIMPLE_CHAT_TUNNEL_READY')) {
            clearTimeout(timer);
            ready = true;
            log('gpu_connection_ready', undefined, { phase: 'ssh_connect' });
            resolve();
          }
        });
      });
      const tunnel: Tunnel = { ready: readiness, stop };
      child = tunnel;
      return readiness;
    },
    // A pause, a stopped instance or shutdown closes the tunnel; the attempt after it is not postponed.
    close() { const tunnel = child; child = undefined; failures = 0; retryAt = -Infinity; tunnel?.stop(); },
  };
}
