// `gpu/image-bootstrap.sh` spends a rented card's minutes and the operator's money: it decides whether to keep the
// machine, and it holds ~31.5 GB of half-downloaded weights while it does. Those decisions are made in the parts
// no `--dry-run` reaches, so the script itself is run here against a synthetic manifest that pins one small file on
// loopback: the speed floor, the downloads a failed run leaves behind, the lock and an unresumable leftover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type Hooks = { after(action: () => void): void };
const script = resolve('gpu/image-bootstrap.sh');
const digestOf = (content: string) => createHash('sha256').update(content).digest('hex');
const pathOf = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
const absent = ['flock', 'curl', 'python3', 'awk'].filter(tool => !pathOf(tool));
// The disk check in front of the downloads asks for the virtual environment's 13 GiB wherever the box lives, and
// the speed floor reads an interface counter, which is where `lo` stands in for the rented machine's link.
const space = statfsSync(tmpdir());
const cannotRun = absent.length ? `no ${absent.join(', ')}`
  : !existsSync('/sys/class/net/lo/statistics/rx_bytes') ? 'no interface byte counters'
  : space.bavail * space.bsize < 14 * 1024 ** 3 ? 'less than 14 GiB free in the temporary directory' : '';
const needsBox = cannotRun ? { skip: cannotRun } : {};

// A stand-in for the weights host: one blob on loopback, trickled in chunks, and `ranges: false` for a host that
// answers a ranged request with the whole file — the case curl reports as exit 33 and cannot resume.
const weightsHost = `
import http.server, hashlib, sys, time
size = int(sys.argv[1]); ranges = sys.argv[2] == 'ranges'; chunk = int(sys.argv[3]); pause = float(sys.argv[4])
blob = bytes((index * 7 + 3) % 251 for index in range(size))
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *ignored): pass
    def do_GET(self):
        start = 0
        wanted = self.headers.get('Range')
        if wanted and ranges:
            start = int(wanted.split('=')[1].split('-')[0])
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{size - 1}/{size}')
        else:
            self.send_response(200)
        body = blob[start:]
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        for at in range(0, len(body), chunk):
            try:
                self.wfile.write(body[at:at + chunk]); self.wfile.flush()
            except Exception:
                return
            time.sleep(pause)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, hashlib.sha256(blob).hexdigest(), flush=True)
server.serve_forever()
`;

// The other traffic on the same link: the torch wheels this script installs and the language model bootstrap.sh
// pulls beside it. It lands nowhere near models/, which is the whole point of measuring the interface.
const linkTraffic = `
import socket, sys, threading, time
blocks = int(sys.argv[1]); pause = float(sys.argv[2])
listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
def drain():
    connection, _ = listener.accept()
    while connection.recv(1 << 20):
        pass
threading.Thread(target=drain, daemon=True).start()
sender = socket.create_connection(('127.0.0.1', listener.getsockname()[1]))
block = b'x' * (1 << 20)
for _ in range(blocks):
    sender.sendall(block)
    time.sleep(pause)
`;

type Host = { port: number; digest: string; size: number };
async function startHost(t: Hooks, { size, ranges = true, chunk = 100_000, pause = 0 }:
  { size: number; ranges?: boolean; chunk?: number; pause?: number }): Promise<Host> {
  const server = spawn('python3', ['-c', weightsHost, String(size), ranges ? 'ranges' : 'whole-file',
    String(chunk), String(pause)], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => server.kill('SIGKILL'));
  const first = await new Promise<string>((done, fail) => {
    let seen = '';
    server.stdout.on('data', chunkRead => {
      seen += String(chunkRead);
      if (seen.includes('\n')) done(seen.split('\n')[0]!);
    });
    server.on('exit', () => fail(new Error('the weights host did not start')));
  });
  const [port, digest] = first.split(' ') as [string, string];
  return { port: Number(port), digest, size };
}

// A rented box as the script expects to find it: its own copy of the script beside a manifest that pins one small
// file on the loopback host, a ComfyUI clone and virtual environment that answer without a network or a card.
function fakeBox(t: Hooks, host: Host): string {
  const box = mkdtempSync(join(tmpdir(), 'simple-chat-bootstrap-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const state = join(box, 'state');
  mkdirSync(join(box, 'gpu'), { recursive: true });
  mkdirSync(join(box, 'shim'), { recursive: true });
  mkdirSync(join(state, 'ComfyUI/.git'), { recursive: true });
  mkdirSync(join(state, 'ComfyUI/.venv/bin'), { recursive: true });
  mkdirSync(join(state, 'ComfyUI/models/text_encoders'), { recursive: true });
  mkdirSync(join(state, 'ComfyUI/models/vae'), { recursive: true });
  copyFileSync(script, join(box, 'gpu/image-bootstrap.sh'));
  copyFileSync(resolve('gpu/image-workflow.json'), join(box, 'gpu/image-workflow.json'));
  // The encoder and the VAE are already here and verify, so only the pinned model is fetched over the loopback link.
  writeFileSync(join(state, 'ComfyUI/models/text_encoders/encoder.safetensors'), 'encoder');
  writeFileSync(join(state, 'ComfyUI/models/vae/vae.safetensors'), 'vae');
  const revision = '0'.repeat(40);
  const repository = 'https://example.invalid/comfy.git';
  writeFileSync(join(box, 'gpu/image-manifest.env'), [
    `COMFYUI_REPO=${repository}`, `COMFYUI_REVISION=${revision}`, 'COMFYUI_VERSION=0.0.0',
    'TORCH_INDEX_URL=https://example.invalid/whl', 'TORCH_VERSION=0.0.0', 'TORCHVISION_VERSION=0.0.0',
    'TORCHAUDIO_VERSION=0.0.0', 'TORCH_ARCH=sm_120', 'IMAGE_MODEL_NAME="Synthetic weights"',
    `IMAGE_MODEL_URL=http://127.0.0.1:${host.port}/model`, 'IMAGE_MODEL_FILE=model.safetensors',
    `IMAGE_MODEL_SHA256=${host.digest}`, `IMAGE_MODEL_BYTES=${host.size}`,
    'IMAGE_ENCODER_REPO=synthetic/encoder', 'IMAGE_ENCODER_REVISION=main',
    'IMAGE_ENCODER_PATH=encoder.safetensors', 'IMAGE_ENCODER_FILE=encoder.safetensors',
    `IMAGE_ENCODER_SHA256=${digestOf('encoder')}`, 'IMAGE_ENCODER_BYTES=7',
    'IMAGE_VAE_REPO=synthetic/vae', 'IMAGE_VAE_REVISION=main', 'IMAGE_VAE_PATH=vae.safetensors',
    'IMAGE_VAE_FILE=vae.safetensors', `IMAGE_VAE_SHA256=${digestOf('vae')}`, 'IMAGE_VAE_BYTES=3',
    'IMAGE_TURBO_REPO=synthetic/turbo', 'IMAGE_TURBO_REVISION=main', 'IMAGE_TURBO_PATH=turbo.safetensors',
    'IMAGE_TURBO_FILE=turbo.safetensors', `IMAGE_TURBO_SHA256=${'0'.repeat(64)}`, 'IMAGE_TURBO_BYTES=1',
    'OFFICIAL_REPO=synthetic/official', 'OFFICIAL_REVISION=main', 'OFFICIAL_ENCODER_PATH=encoder.safetensors',
    'OFFICIAL_ENCODER_FILE=official_encoder.safetensors', 'OFFICIAL_ENCODER_SHA256=unknown',
    'OFFICIAL_ENCODER_BYTES=1', 'OFFICIAL_VAE_PATH=vae.safetensors', 'OFFICIAL_VAE_FILE=official_vae.safetensors',
    'OFFICIAL_VAE_SHA256=unknown', 'OFFICIAL_VAE_BYTES=1', 'OFFICIAL_TURBO_PATH=turbo.safetensors',
    'OFFICIAL_TURBO_FILE=official_turbo.safetensors', 'OFFICIAL_TURBO_SHA256=unknown', 'OFFICIAL_TURBO_BYTES=1',
    'IMAGE_WORKFLOW=image-workflow.json', ''].join('\n'));
  // `git` answers for the pinned clone, and GIT_SHIM_SLEEP/GIT_SHIM_STATUS stand in for the minutes the fetch and
  // the torch wheels take on the box, and for the steps that can end the run while the downloads are in flight.
  writeFileSync(join(box, 'shim/git'), ['#!/usr/bin/env bash', 'for argument in "$@"; do', '  case "$argument" in',
    `    get-url) echo ${repository}; exit 0 ;;`, `    rev-parse) echo ${revision}; exit 0 ;;`, '  esac', 'done',
    '[[ -z "${GIT_SHIM_SLEEP:-}" ]] || sleep "$GIT_SHIM_SLEEP"', 'exit ${GIT_SHIM_STATUS:-0}', ''].join('\n'));
  writeFileSync(join(box, 'shim/nvidia-smi'), '#!/usr/bin/env bash\necho "0, synthetic card, 32760 MiB, 0.00"\n');
  // The virtual environment's python: pip installs nothing and the sm_120 check passes.
  writeFileSync(join(state, 'ComfyUI/.venv/bin/python'),
    '#!/usr/bin/env bash\n[[ "${1:-}" != - ]] || cat >/dev/null\nexit 0\n');
  for (const file of ['shim/git', 'shim/nvidia-smi']) chmodSync(join(box, file), 0o755);
  chmodSync(join(state, 'ComfyUI/.venv/bin/python'), 0o755);
  return box;
}

const boxEnvironment = (box: string, extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${join(box, 'shim')}:${process.env['PATH']}`,
  SIMPLE_CHAT_GPU_DIR: join(box, 'state'),
  SIMPLE_CHAT_CIVITAI_TOKEN: 'synthetic',
  SIMPLE_CHAT_IMAGE_SOURCE: 'comfy',
  SIMPLE_CHAT_IMAGE_TURBO: 'false',
  ...extra,
});
const runBox = (box: string, extra: Record<string, string> = {}) =>
  spawnSync('bash', [join(box, 'gpu/image-bootstrap.sh')],
    { encoding: 'utf8', timeout: 120_000, env: boxEnvironment(box, extra) });
// Started in its own process group, so what the run leaves behind can be counted and killed by that group alone.
const startBox = (t: Hooks, box: string, extra: Record<string, string> = {}): ChildProcess => {
  const running = spawn('bash', [join(box, 'gpu/image-bootstrap.sh')],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: boxEnvironment(box, extra) });
  t.after(() => { try { process.kill(-running.pid!, 'SIGKILL'); } catch { /* already gone */ } });
  return running;
};
const partPath = (box: string) => join(box, 'state/ComfyUI/models/diffusion_models/model.safetensors.part');
const sizeOf = (path: string) => { try { return statSync(path).size; } catch { return -1; } };

test('the speed floor judges the machine link, not the bytes that land in models/', needsBox, async t => {
  // 4 MB trickled over about 4 s is 8 Mbit/s of weights, well under this run's 50 Mbit/s floor, while the link
  // carries far more: on the rented box that is the script's own torch wheels and the 24 GB bootstrap.sh pulls
  // over 16 connections. Counting only models/ turns that fast machine into "destroy this machine".
  const host = await startHost(t, { size: 4_000_000, chunk: 100_000, pause: 0.1 });
  const box = fakeBox(t, host);
  // The traffic runs for several seconds, so the window falls inside it wherever the run's own start lands.
  const traffic = spawn('python3', ['-c', linkTraffic, '400', '0.01'], { stdio: 'ignore' });
  t.after(() => traffic.kill('SIGKILL'));
  const run = runBox(box, { SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '2', SIMPLE_CHAT_IMAGE_MIN_MBIT: '50',
    SIMPLE_CHAT_IMAGE_LINK_IF: 'lo' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stderr, /destroy this machine/);
  assert.match(run.stdout, /The link is carrying about \d+ Mbit\/s/);
  assert.match(run.stdout, /model\.safetensors: SHA256 verified/);
});

test('a link below the floor still ends the run and the downloads with it', needsBox, async t => {
  // The other half of the money decision: no machine carries 100 Tbit/s, so this link is below its floor and the
  // answer is to stop paying for it now rather than to spend the session watching 70 GB arrive.
  const host = await startHost(t, { size: 4_000_000, chunk: 100_000, pause: 0.1 });
  const box = fakeBox(t, host);
  const run = runBox(box, { SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '2', SIMPLE_CHAT_IMAGE_MIN_MBIT: '100000000',
    SIMPLE_CHAT_IMAGE_LINK_IF: 'lo' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /below the 100000000 Mbit\/s floor, so destroy this machine/);
  assert.match(run.stderr, /A download failed or was ended/);
  assert.doesNotMatch(run.stdout, /SHA256 verified/);
});

test('a run that ends takes its downloads with it', needsBox, async t => {
  const host = await startHost(t, { size: 4_000_000, chunk: 50_000, pause: 0.1 });
  const box = fakeBox(t, host);
  // `git fetch` fails two seconds in, the way the repository check, the torch install and the sm_120 abort can end
  // the run under `set -e` while four curls are pulling. An orphan keeps writing into the .part, and the next run
  // resumes that file from an end nobody wrote: a corruption the SHA256 only reports after the whole download.
  const running = startBox(t, box, { GIT_SHIM_SLEEP: '2', GIT_SHIM_STATUS: '1',
    SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '30', SIMPLE_CHAT_IMAGE_MIN_MBIT: '0' });
  const code = await new Promise<number>(done => running.on('exit', status => done(status ?? -1)));
  assert.equal(code, 1);
  const stopped = sizeOf(partPath(box));
  assert.ok(stopped > 0, 'the download should have written something before the run ended');
  await delay(1500);
  assert.equal(sizeOf(partPath(box)), stopped, 'the .part grew after the run ended: a curl outlived it');
  if (pathOf('pgrep')) {
    const left = spawnSync('pgrep', ['-g', String(running.pid), '-x', 'curl'], { encoding: 'utf8' });
    assert.equal(left.stdout.trim(), '', 'a curl of this run is still alive');
  }
});

test('a second run is refused while one is working in the same directory', needsBox, async t => {
  const host = await startHost(t, { size: 4_000_000, chunk: 50_000, pause: 0.1 });
  const box = fakeBox(t, host);
  const running = startBox(t, box, { GIT_SHIM_SLEEP: '20', SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '20',
    SIMPLE_CHAT_IMAGE_MIN_MBIT: '0' });
  for (let waited = 0; waited < 100 && sizeOf(partPath(box)) <= 0; waited++) await delay(100);
  assert.ok(sizeOf(partPath(box)) > 0, 'the first run should be downloading by now');
  // Two runs would resume one .part from two ends and only find out in the SHA256, after paying for the bytes.
  const second = runBox(box, { SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '1', SIMPLE_CHAT_IMAGE_MIN_MBIT: '0' });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Another image-bootstrap\.sh is working/);
  process.kill(-running.pid!, 'SIGKILL');
});

test('a leftover this host refuses to resume is discarded and fetched again', needsBox, async t => {
  // A host that answers a ranged request with the whole file (curl exit 33: "Cannot resume"). Kept, that leftover
  // fails the same way on every later run, and the box can never finish on its own.
  const host = await startHost(t, { size: 4_000_000, ranges: false, chunk: 1_000_000, pause: 0 });
  const box = fakeBox(t, host);
  mkdirSync(join(box, 'state/ComfyUI/models/diffusion_models'), { recursive: true });
  writeFileSync(partPath(box), Buffer.alloc(1_000_000));
  const run = runBox(box, { SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '1', SIMPLE_CHAT_IMAGE_MIN_MBIT: '0' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /model\.safetensors\.part cannot be resumed/);
  assert.match(run.stdout, /model\.safetensors: SHA256 verified/);
  const fetched = readFileSync(join(box, 'state/ComfyUI/models/diffusion_models/model.safetensors'));
  assert.equal(createHash('sha256').update(fetched).digest('hex'), host.digest);
});

test('a rerun with every pinned file present is not held for the measurement window', needsBox, async t => {
  const host = await startHost(t, { size: 4_000, chunk: 4_000, pause: 0 });
  const box = fakeBox(t, host);
  mkdirSync(join(box, 'state/ComfyUI/models/diffusion_models'), { recursive: true });
  const blob = Buffer.from(Array.from({ length: host.size }, (ignored, index) => (index * 7 + 3) % 251));
  writeFileSync(join(box, 'state/ComfyUI/models/diffusion_models/model.safetensors'), blob);
  const started = Date.now();
  // Nothing was supposed to arrive, so there is nothing to measure. The window used to be slept out anyway and the
  // run then reported "about 0 Mbit/s" — the reading of a dead link, on a run where the link was never used.
  const run = runBox(box, { GIT_SHIM_SLEEP: '1', SIMPLE_CHAT_IMAGE_SPEED_WINDOW: '20',
    SIMPLE_CHAT_IMAGE_MIN_MBIT: '200' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.doesNotMatch(run.stdout + run.stderr, /Mbit\/s/);
  assert.ok(Date.now() - started < 15_000, 'the run waited out the measurement window with nothing to measure');
});
