import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('server error logging records lifecycle and categories without persisting output or credentials', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-server-log-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  const child = `import sys
print('CUDA error: out of memory PRIVATE_STORY PRIVATE_KEY', file=sys.stderr)
print('PRIVATE_PROMPT' * 2000)
print('llama_decode: failed PRIVATE_RESPONSE', file=sys.stderr)
sys.exit(7)`;
  const result = spawnSync('python3', [resolve('gpu/server-log.py'), path, '--', 'python3', '-c', child], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const log = readFileSync(path, 'utf8');
  assert.doesNotMatch(log, /PRIVATE|PROMPT|RESPONSE|STORY|KEY/);
  const rows = log.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows[0].event, 'server_started');
  assert.ok(rows.some(row => row.category === 'out_of_memory'));
  assert.ok(rows.some(row => row.category === 'decode_failed'));
  assert.equal(rows.at(-1).event, 'server_exit');
  assert.equal(rows.at(-1).exitCode, 7);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('stopping the logging supervisor stops its server and records the signal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-server-stop-'));
  const path = join(directory, 'events.jsonl');
  const worker = spawn('python3', [resolve('gpu/server-log.py'), path, '--', 'python3', '-c', 'import time; time.sleep(60)'], { stdio: 'ignore' });
  const exited = once(worker, 'exit');
  t.after(() => { worker.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); });
  for (let tries = 0; tries < 200; tries++) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes('server_started')) break;
    await delay(10);
  }
  const started = JSON.parse(readFileSync(path, 'utf8').trim().split('\n')[0]);
  worker.kill('SIGTERM');
  assert.deepEqual(await exited, [143, null]);
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(row => row.event === 'server_stop_requested' && row.signal === 'SIGTERM'));
  assert.ok(rows.some(row => row.event === 'server_exit' && row.signal === 'SIGTERM'));
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
});
