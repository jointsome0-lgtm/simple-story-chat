import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';

process.umask(0o077);
try {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  // Linux flock releases automatically on crash. Only one poller uses this DB.
  const child = spawn('flock', ['--nonblock', config.dbPath + '.lock', process.execPath,
    fileURLToPath(new URL('./main.ts', import.meta.url))], { stdio: 'inherit' });
  child.once('error', () => { console.error('Cannot start bot: flock is required.'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  // loadConfig, mkdirSync and spawn throw Error objects.
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
