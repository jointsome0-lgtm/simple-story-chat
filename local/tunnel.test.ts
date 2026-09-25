// `gpu/tunnel.sh` is the only forwarding the session has written down. The language lane's port was in it from the
// start; the picture lane's was not, although gpu/image-serve.sh binds ComfyUI to loopback on the rented machine and
// local/image-batch.ts refuses a root that is not loopback here, so the two ends can only meet through a tunnel.
// The checks below run the script with a fake `ssh` that records its arguments, so nothing is connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('gpu/tunnel.sh');
const model = '127.0.0.1:8080:127.0.0.1:8080';
// ComfyUI's default port is what local/image-batch.ts looks for (`--comfy http://127.0.0.1:8188`).
const pictures = '127.0.0.1:8188:127.0.0.1:8188';
// [what is asked, arguments, the forwards ssh gets, or null when the script refuses before ssh]
const cases: [string, string[], string[] | null][] = [
  ['the model port alone by default', ['simple-chat-vast'], [model]],
  ['both lanes, measured from this host in one session', ['--pictures', 'simple-chat-vast'], [model, pictures]],
  // Two rented machines, one lane each: the picture machine's tunnel leaves the model port to the other one.
  ['the picture port alone', ['--pictures-only', 'simple-chat-vast-pictures'], [pictures]],
  // An alias is still required, and the flag is not one: a host name that is not a config alias would otherwise
  // reach ssh as an address to connect to.
  ['no alias', ['--pictures'], null],
  ['the flag after the alias', ['simple-chat-vast', '--pictures'], null],
  ['both flags', ['--pictures', '--pictures-only', 'simple-chat-vast'], null],
  ['an address instead of an alias', ['user@host'], null],
];

test('the tunnel forwards the model port, and the picture port only when it is asked for', t => {
  assert.equal(spawnSync('bash', ['-n', script], { encoding: 'utf8' }).status, 0);
  if (spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0) {
    const linted = spawnSync('shellcheck', ['-S', 'warning', script], { encoding: 'utf8' });
    assert.equal(linted.status, 0, linted.stdout);
  }
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-tunnel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const argv = join(directory, 'argv');
  writeFileSync(join(directory, 'ssh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"${argv}"\n`);
  chmodSync(join(directory, 'ssh'), 0o755);
  for (const [label, args, expected] of cases) {
    rmSync(argv, { force: true });
    const run = spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } });
    if (!expected) {
      assert.equal(run.status, 1, label);
      assert.match(run.stderr, /Usage: bash gpu\/tunnel\.sh \[--pictures\|--pictures-only\] SSH_CONFIG_ALIAS/, label);
      assert.equal(existsSync(argv), false, `${label}: ssh is never started`);
      continue;
    }
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    const words = readFileSync(argv, 'utf8').split('\n');
    const forwards = words.filter((_, i) => words[i - 1] === '-L');
    // Every forwarding stays on loopback at both ends: the rented machine publishes neither server.
    assert.deepEqual(forwards, expected, label);
    assert.ok(!words.some(word => /^-[RD]/.test(word)), `${label}: no remote or dynamic forwarding`);
  }
});
