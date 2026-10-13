// `gpu/bootstrap.sh` verifies the two model files on every run, not only on the run that downloaded them. What it
// may delete when a check fails is the part worth a test: a half-downloaded .part is worthless, but the file that
// is already in place is half a gigabyte of a rented machine's link, and a wrong pin is not a reason to lose it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Hooks = { after(action: () => void): void };
const manifest = Object.fromEntries(readFileSync(resolve('gpu/manifest.env'), 'utf8').split('\n')
  .filter(line => line.includes('=') && !line.startsWith('#')).map(line => line.split('=') as [string, string]));
const pathOf = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
const absent = ['python3', 'awk'].filter(tool => !pathOf(tool));
// The script asks for 4 GiB free once the weights are in place, before it looks at anything else.
const space = statfsSync(tmpdir());
const cannotRun = absent.length ? `no ${absent.join(', ')}`
  : space.bavail * space.bsize < 5 * 1024 ** 3 ? 'less than 5 GiB free in the temporary directory' : '';
const needsBox = cannotRun ? { skip: cannotRun } : {};

// A machine that has the weights, a toolchain that answers and no card: everything the script shells out to is a
// shim, so the run reaches the draft model's check and stops there.
function fakeMachine(t: Hooks): string {
  const box = mkdtempSync(join(tmpdir(), 'simple-chat-gpu-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  mkdirSync(join(box, 'shim'), { recursive: true });
  mkdirSync(join(box, 'state/models'), { recursive: true });
  mkdirSync(join(box, 'state/llama.cpp/.git'), { recursive: true });
  for (const tool of ['cmake', 'ninja', 'nvcc', 'cc', 'curl', 'aria2c']) {
    writeFileSync(join(box, 'shim', tool), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(box, 'shim', tool), 0o755);
  }
  writeFileSync(join(box, 'shim/nvidia-smi'), '#!/usr/bin/env bash\necho "synthetic card, 32760 MiB, 0.00"\n');
  writeFileSync(join(box, 'shim/git'), ['#!/usr/bin/env bash', 'for argument in "$@"; do', '  case "$argument" in',
    '    get-url) echo https://github.com/ggml-org/llama.cpp.git; exit 0 ;;',
    `    rev-parse) echo ${manifest['LLAMA_CPP_REVISION']}; exit 0 ;;`, '  esac', 'done', 'exit 0', ''].join('\n'));
  for (const tool of ['shim/nvidia-smi', 'shim/git']) chmodSync(join(box, tool), 0o755);
  // The weights are already here, so nothing is downloaded and the disk check asks for 4 GiB instead of 30.
  writeFileSync(join(box, 'state/models', manifest['MODEL_FILE']!), '');
  return box;
}

const runMachine = (box: string) => spawnSync('bash', [resolve('gpu/bootstrap.sh')], {
  encoding: 'utf8', timeout: 120_000,
  env: {
    ...process.env,
    PATH: `${join(box, 'shim')}:${process.env['PATH']}`,
    SIMPLE_CHAT_GPU_DIR: join(box, 'state'),
    SIMPLE_CHAT_GPU_DRAFT: 'true',
    SIMPLE_CHAT_BUILD_JOBS: '1',
  },
});

test('a failed draft check preserves installed weights and discards only incomplete downloads', needsBox, t => {
  for (const installed of [true, false]) {
    const box = fakeMachine(t);
    const path = join(box, 'state/models', manifest['DRAFT_FILE']!) + (installed ? '' : '.part');
    writeFileSync(path, 'synthetic invalid weights');
    const run = runMachine(box);
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.match(run.stdout + run.stderr, /Draft model size mismatch/);
    assert.equal(existsSync(path), installed);
  }
});
