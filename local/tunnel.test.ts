// `gpu/tunnel.sh` is the only forwarding the session has written down. The language lane's port was in it from the
// start; the picture lane's was not, although gpu/image-serve.sh binds ComfyUI to loopback on the rented machine and
// local/image-batch.ts refuses a root that is not loopback here, so the two ends can only meet through a tunnel.
// The checks below run the script with a fake `ssh` that records its arguments, so nothing is connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('gpu/tunnel.sh');

function fakeSsh(t: { after(action: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-tunnel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const argv = join(directory, 'argv');
  writeFileSync(join(directory, 'ssh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${argv}"\n`);
  chmodSync(join(directory, 'ssh'), 0o755);
  return { argv, path: `${directory}:${process.env.PATH}` };
}

const run = (fake: { path: string }, args: string[]) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: fake.path } });
const forwards = (fake: { argv: string }) => readFileSync(fake.argv, 'utf8').split('\n')
  .filter(line => /^127\.0\.0\.1:/.test(line));

test('the tunnel forwards the model port, and the picture port only when it is asked for', t => {
  const fake = fakeSsh(t);
  const plain = run(fake, ['simple-chat-vast']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(forwards(fake), ['127.0.0.1:8080:127.0.0.1:8080']);

  // Both lanes are measured from this host in the same session, and ComfyUI's default port is what
  // local/image-batch.ts looks for (`--comfy http://127.0.0.1:8188`).
  const pictures = run(fake, ['--pictures', 'simple-chat-vast']);
  assert.equal(pictures.status, 0, pictures.stderr);
  assert.deepEqual(forwards(fake), ['127.0.0.1:8080:127.0.0.1:8080', '127.0.0.1:8188:127.0.0.1:8188']);
  // Every forwarding stays on loopback at both ends: the rented machine publishes neither server.
  assert.ok(forwards(fake).every(line => line.startsWith('127.0.0.1:') && line.includes(':127.0.0.1:')));

  // An alias is still required, and the flag is not one: a host name that is not a config alias would otherwise
  // reach ssh as an address to connect to.
  assert.equal(run(fake, ['--pictures']).status, 1);
  assert.match(run(fake, ['--pictures']).stderr, /Usage: bash gpu\/tunnel\.sh \[--pictures\] SSH_CONFIG_ALIAS/);
  assert.equal(run(fake, ['simple-chat-vast', '--pictures']).status, 1);
  assert.equal(run(fake, ['user@host']).status, 1);
});

test('the shell of the tunnel parses', () => {
  assert.equal(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status, 0);
  if (spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status !== 0) return;
  const linted = spawnSync('shellcheck', ['-S', 'warning', script], { encoding: 'utf8' });
  assert.equal(linted.status, 0, linted.stdout);
});
