// `gpu/image-sweeper.py` is what keeps a picture of somebody's scene off the rented card once the bot has it, and
// `gpu/image-serve.sh` is what puts ComfyUI's temp directory where a stopped instance's disk never holds it. Both run
// here for real: the sweeper against a fake ComfyUI on loopback and a temporary directory, the serve script in a box
// whose ComfyUI is a stub that records how it was started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, statfsSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

type Hooks = { after(action: () => void): void };
type Row = { event: string; [field: string]: unknown };
const sweeper = resolve('gpu/image-sweeper.py');
const serve = resolve('gpu/image-serve.sh');
const pathOf = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
const needsPython = pathOf('python3') ? {} : { skip: 'no python3' };
// statfs(2) names a tmpfs by this magic number; the serve script asks `stat -f` the same question.
const TMPFS = 0x01021994;
const onTmpfs = (path: string) => { try { return statfsSync(path).type === TMPFS; } catch { return false; } };
const needsShm = onTmpfs('/dev/shm') ? {} : { skip: '/dev/shm is not a tmpfs here' };
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A record as the pinned server writes it (execution.py `task_done`): the prompt with the reader's text in it, the
// outputs that name the files, and status messages stamped in milliseconds. `ended: null` is a record with none.
const record = (id: string, ended: number | null, files: { filename: string; subfolder?: string }[]) => ({
  prompt: [0, id, { 2: { class_type: 'CLIPTextEncode', inputs: { text: 'PRIVATE_PROMPT of a reader' } } }, {}, ['7']],
  outputs: { 7: { images: files.map(file => ({ filename: file.filename, subfolder: file.subfolder ?? '', type: 'temp' })) } },
  status: { status_str: 'success', completed: true, messages: ended === null ? []
    : [['execution_start', { prompt_id: id, timestamp: Math.round((ended - 3) * 1000) }],
      ['execution_success', { prompt_id: id, timestamp: Math.round(ended * 1000) }]] },
  meta: {},
});

// ComfyUI's /history on loopback: GET answers with `history` (or with `status` alone), POST records what it was asked
// to delete.
async function fakeComfy(t: Hooks, history: unknown, status = 200) {
  const deleted: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/history' && request.method === 'GET') {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(status === 200 ? JSON.stringify(history) : 'server error');
      } else if (request.url === '/history' && request.method === 'POST') {
        deleted.push(JSON.parse(body));
        response.writeHead(200);
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  // Every connection is dropped with the server, or an idle keep-alive socket holds the test process for seconds.
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { port: (server.address() as AddressInfo).port, deleted };
}

function tempDirectory(t: Hooks) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-sweeper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// A file `age` seconds old, as the node wrote it.
function picture(directory: string, name: string, age: number) {
  const path = join(directory, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'synthetic picture bytes');
  const at = Date.now() / 1000 - age;
  utimesSync(path, at, at);
  return path;
}

async function runSweeper(args: string[]) {
  const child = spawn('python3', [sweeper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [status] = await once(child, 'close') as [number | null];
  const rows: Row[] = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { status, stdout, stderr, rows };
}

const oneSweep = (port: number, temp: string) =>
  ['--once', '--pid', String(process.pid), '--temp', temp, '--port', String(port), '--grace', '5', '--file-cap', '600',
    '--history-cap', '600'];

test('the sweeper deletes a picture no record names, keeps one still wanted, and ends what the bot left behind', needsPython, async t => {
  const now = Date.now() / 1000;
  const comfy = await fakeComfy(t, {
    'job-alpha': record('job-alpha', now - 30, [{ filename: 'named.png' }, { filename: 'old-named.png' }, { filename: 'in-sub.png', subfolder: 'sub' }]),
    // The bot died between the drawing and its delete: the record is older than the cap.
    'job-bravo': record('job-bravo', now - 700, [{ filename: 'stale.png' }]),
    'job-charlie': record('job-charlie', null, [{ filename: 'untimed.png' }]),
  });
  const temp = tempDirectory(t);
  const delivered = picture(temp, 'delivered.png', 30);
  const fresh = picture(temp, 'fresh.png', 1);
  const named = picture(temp, 'named.png', 30);
  const oldNamed = picture(temp, 'old-named.png', 700);
  const inSub = picture(temp, 'sub/in-sub.png', 30);
  const stale = picture(temp, 'stale.png', 30);
  const untimed = picture(temp, 'untimed.png', 30);
  mkdirSync(join(temp, 'left-empty'));
  utimesSync(join(temp, 'left-empty'), now - 30, now - 30);

  const run = await runSweeper(oneSweep(comfy.port, temp));
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  // Delivered and past the grace; past the file cap although named; named only by a record past the history cap.
  for (const gone of [delivered, oldNamed, stale]) assert.equal(existsSync(gone), false, gone);
  // Inside the grace, where the record may not have been written yet; named by a live record; the same in a
  // subfolder; named by a record with no timestamp, which is timed from this first pass.
  for (const kept of [fresh, named, inSub, untimed]) assert.equal(existsSync(kept), true, kept);
  assert.equal(existsSync(join(temp, 'left-empty')), false);
  assert.deepEqual(comfy.deleted, [{ delete: ['job-bravo'] }]);
  assert.deepEqual(run.rows.map(row => row.event), ['sweeper_started', 'swept']);
  assert.deepEqual(run.rows[1], { event: 'swept', files: 3, failedFiles: 0, records: 1 });
  // Counts and codes only: no file name, no record id and nothing of the prompt.
  assert.doesNotMatch(run.stdout, /PRIVATE|\.png|job-|sub|delivered|stale/);
});

test('with /history unreadable only the file cap applies, and the failure is a code', needsPython, async t => {
  const refused = createServer();
  refused.listen(0, '127.0.0.1');
  await once(refused, 'listening');
  const closedPort = (refused.address() as AddressInfo).port;
  await new Promise(done => refused.close(done));
  const failing = await fakeComfy(t, null, 500);
  for (const [port, code] of [[failing.port, 'http_500'], [closedPort, 'connection_refused']] as const) {
    const temp = tempDirectory(t);
    const unnamed = picture(temp, 'maybe-wanted.png', 30);
    const expired = picture(temp, 'expired.png', 700);
    const run = await runSweeper(oneSweep(port, temp));
    assert.equal(run.status, 0, run.stderr);
    // Nothing says whether the bot still wants it, so it waits for the cap like every other picture.
    assert.equal(existsSync(unnamed), true);
    assert.equal(existsSync(expired), false);
    assert.deepEqual(run.rows.slice(1), [{ event: 'history_unreadable', code }, { event: 'swept', files: 1, failedFiles: 0, records: 0 }]);
  }
  assert.deepEqual(failing.deleted, []);
});

test('the sweeper stops by itself once the server it serves is gone', needsPython, async t => {
  const comfy = await fakeComfy(t, {});
  const temp = tempDirectory(t);
  const server = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => server.kill('SIGKILL'));
  const child = spawn('python3', [sweeper, '--pid', String(server.pid), '--temp', temp, '--port', String(comfy.port), '--interval', '0.05'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = once(child, 'close');
  for (let tries = 0; tries < 200 && !stdout.includes('sweeper_started'); tries++) await delay(10);
  // Still sweeping while the server lives.
  await delay(200);
  assert.equal(child.exitCode, null);
  server.kill('SIGKILL');
  const [status] = await Promise.race([closed, delay(5000, [undefined], { ref: false })]) as [number | null | undefined];
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), { event: 'sweeper_stopped', reason: 'server_gone' });
});

// A picture box as image-serve.sh expects to find it, with a ComfyUI whose python records its arguments and exits:
// Krea's files and graph, or with `qwenOnly` Qwen's and nothing of Krea's, as image-bootstrap.sh leaves each.
function serveBox(t: Hooks, qwenOnly = false) {
  const box = mkdtempSync(join(tmpdir(), 'simple-chat-serve-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const comfy = join(box, 'state/ComfyUI');
  for (const directory of ['gpu', 'shim', 'state/ComfyUI/.venv/bin', 'state/ComfyUI/models/diffusion_models',
    'state/ComfyUI/models/text_encoders', 'state/ComfyUI/models/vae']) mkdirSync(join(box, directory), { recursive: true });
  copyFileSync(serve, join(box, 'gpu/image-serve.sh'));
  copyFileSync(sweeper, join(box, 'gpu/image-sweeper.py'));
  const revision = '0'.repeat(40);
  writeFileSync(join(box, 'gpu/image-manifest.env'), [`COMFYUI_REVISION=${revision}`, 'COMFYUI_VERSION=0.0.0',
    'IMAGE_MODEL_NAME="Synthetic weights"', 'IMAGE_MODEL_FILE=model.safetensors', 'IMAGE_ENCODER_FILE=encoder.safetensors',
    'IMAGE_VAE_FILE=vae.safetensors', 'IMAGE_WORKFLOW=image-workflow.json', 'IMAGE_QWEN_NAME="Synthetic Qwen"',
    'IMAGE_QWEN_MODEL_FILE=qwen.safetensors', 'IMAGE_QWEN_ENCODER_FILE=qwen-encoder.safetensors', 'IMAGE_QWEN_VAE_FILE=qwen-vae.safetensors',
    'IMAGE_QWEN_WORKFLOW=image-workflow-qwen.json', 'IMAGE_QWEN_EDIT_WORKFLOW=image-workflow-qwen-edit.json', ''].join('\n'));
  const files = qwenOnly ? ['diffusion_models/qwen.safetensors', 'text_encoders/qwen-encoder.safetensors', 'vae/qwen-vae.safetensors']
    : ['diffusion_models/model.safetensors', 'text_encoders/encoder.safetensors', 'vae/vae.safetensors'];
  for (const file of files) writeFileSync(join(comfy, 'models', file), 'weights');
  for (const graph of qwenOnly ? ['image-workflow-qwen.json', 'image-workflow-qwen-edit.json'] : ['image-workflow.json']) {
    writeFileSync(join(box, 'state', graph), '{"8": {"inputs": {"clip_name": "encoder.safetensors"}}}');
  }
  writeFileSync(join(box, 'shim/git'), `#!/usr/bin/env bash\necho ${revision}\n`);
  const started = join(box, 'started.log');
  writeFileSync(join(comfy, '.venv/bin/python'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(started)}\n`);
  chmodSync(join(box, 'shim/git'), 0o755);
  chmodSync(join(comfy, '.venv/bin/python'), 0o755);
  const run = (tempRoot: string, qwen = 'false') => spawnSync('bash', [join(box, 'gpu/image-serve.sh')], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${join(box, 'shim')}:${process.env['PATH']}`, SIMPLE_CHAT_GPU_DIR: join(box, 'state'),
      SIMPLE_CHAT_IMAGE_GPU: '0', SIMPLE_CHAT_IMAGE_TEMP_ROOT: tempRoot, SIMPLE_CHAT_IMAGE_QWEN: qwen,
      COMFYUI_ARGS: '', CLI_ARGS: '', COMFYUI_EXTRA_ARGS: '' } });
  // The sweeper is started in the background, so its line may land a moment after the script has exec'd.
  const lines = async (count: number) => {
    for (let tries = 0; tries < 200; tries++) {
      const seen = existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n') : [];
      if (seen.length >= count) return seen;
      await delay(10);
    }
    return existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n') : [];
  };
  return { run, lines, started };
}

test('image-serve.sh keeps ComfyUI temp directory on a tmpfs and starts the sweeper beside the server', needsShm, async t => {
  const shm = mkdtempSync('/dev/shm/simple-chat-serve-test-');
  t.after(() => rmSync(shm, { recursive: true, force: true }));
  const root = join(shm, 'comfy');
  const box = serveBox(t);
  const result = box.run(root);
  assert.equal(result.status, 0, result.stderr);
  const started = await box.lines(2);
  const server = started.find(line => line.includes('main.py'));
  const sweeping = started.find(line => line.includes('image-sweeper.py'));
  assert.ok(server?.includes(`--temp-directory ${root} `), server);
  assert.match(sweeping ?? '', new RegExp(`--pid \\d+ --temp ${escaped(root)}/temp --port 8188$`));
  assert.equal(statSync(root).mode & 0o777, 0o700);
  // A box with Qwen's files and nothing of Krea's starts with SIMPLE_CHAT_IMAGE_QWEN=only, and is refused without it.
  const qwen = serveBox(t, true);
  const refused = qwen.run(join(shm, 'krea'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Missing models\/diffusion_models\/model\.safetensors/);
  const alone = qwen.run(join(shm, 'qwen'), 'only');
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /for Synthetic Qwen alone .*image-workflow-qwen-edit\.json\.$/m);
  assert.ok((await qwen.lines(2)).some(line => line.includes('main.py')));
});

test('image-serve.sh refuses a temp directory that is not on a tmpfs rather than write pictures to disk', async t => {
  const disk = [tmpdir(), process.cwd()].find(path => !onTmpfs(path));
  if (!disk) { t.skip('no directory off tmpfs to try'); return; }
  const parent = mkdtempSync(join(disk, '.simple-chat-serve-disk-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const box = serveBox(t);
  const result = box.run(join(parent, 'comfy'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a writable tmpfs.*Refusing to start/);
  // Neither the server nor the sweeper was started, and nothing was made on the disk.
  assert.equal(existsSync(box.started), false);
  assert.equal(existsSync(join(parent, 'comfy')), false);
});

test('image-serve.sh defaults the temp directory to /dev/shm and hands the same one to both processes', () => {
  const script = readFileSync(serve, 'utf8');
  assert.match(script, /temp_root="\$\{SIMPLE_CHAT_IMAGE_TEMP_ROOT:-\/dev\/shm\/[a-z-]+\}"/);
  const sweeperAt = script.indexOf('"$sweeper" --pid "$$" --temp "$temp_root/temp"');
  const execAt = script.indexOf('exec "$comfy_dir/.venv/bin/python" "$comfy_dir/main.py"');
  assert.ok(sweeperAt > 0 && execAt > sweeperAt, 'the sweeper starts before the exec hands its PID to ComfyUI');
  assert.match(script.slice(execAt), /--temp-directory "\$temp_root"/);
});
