import { spawn } from 'node:child_process';
import { ModelError } from './model-error.mjs';

// SSH configuration contains the host, port and identity; it is never committed.
// Both the model listener and forwarded port stay on loopback. Reconnect after
// Vast resumes; refuse changed host keys or an already occupied local port.
export function createGpuConnection(host, { spawn: spawnChild = spawn, log = () => {} } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host)) throw new ModelError('gpu_config');
  let child;
  return {
    ensure() {
      if (child) return child.ready;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('SIMPLE_CHAT_') && !['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'VAST_API_KEY'].includes(key)));
      const worker = spawnChild('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=yes', '-L', '127.0.0.1:8080:127.0.0.1:8080', host,
        "bash /workspace/simple-chat/gpu/ensure-server.sh && printf 'SIMPLE_CHAT_TUNNEL_READY\\n' && exec sleep infinity"],
      { stdio: ['ignore', 'pipe', 'pipe'], env });
      child = worker;
      const started = Date.now();
      // SSH runs the command only after establishing its forwarding. A health
      // response from an unrelated listener on 8080 cannot establish readiness.
      worker.ready = new Promise((resolve, reject) => {
        let output = '';
        let diagnostic = '';
        let sshReason;
        let ready = false;
        let finished = false;
        const timer = setTimeout(() => { finish('ready_timeout'); worker.kill(); }, 12000);
        const finish = (code, details = {}) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (child === worker) child = undefined;
          log('gpu_connection_closed', code, { phase: ready ? 'ssh_tunnel' : 'ssh_connect',
            connectionAgeMs: Math.max(0, Date.now() - started), sshReason, ...details });
          reject(new ModelError('gpu_connection_failed'));
        };
        worker.stop = () => { finish('requested_close'); worker.kill(); };
        worker.once('error', () => finish('process_error'));
        worker.once('exit', (exitCode, signal) => finish('process_exit', { exitCode, signal }));
        worker.stderr.on('data', chunk => {
          if (finished) return;
          // SSH diagnostics may contain hostnames or paths. Classify only in
          // RAM; no raw stderr, addresses or arbitrary error codes reach logs.
          diagnostic = (diagnostic + chunk.toString()).slice(-2048).toLowerCase();
          if (diagnostic.trim()) sshReason ??= 'other';
          for (const [pattern, reason] of [
            [/permission denied/, 'authentication'],
            [/host key verification failed|remote host identification has changed/, 'host_key'],
            [/address already in use|cannot listen to port/, 'port_in_use'],
            [/connection timed out|operation timed out/, 'connect_timeout'],
            [/connection refused/, 'connection_refused'],
            [/broken pipe|connection reset|connection closed|server not responding/, 'connection_lost'],
            [/network is unreachable|no route to host/, 'network_unreachable'],
          ]) if (pattern.test(diagnostic)) sshReason = reason;
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
      return worker.ready;
    },
    close() { const process = child; child = undefined; process?.stop(); },
  };
}
