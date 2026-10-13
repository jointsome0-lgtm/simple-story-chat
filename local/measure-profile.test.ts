// `gpu/measure-profile.sh` has to hold on a rented machine, where a wrong answer costs a measurement block. What can
// be checked without a GPU is checked here: serve.sh really does emit the flags a profile promises (a fake
// llama-server records its own command line), the check refuses another profile's server, ensure-server.sh starts
// nothing while a measurement owns the lock but is not held by that marker forever, and a whole start against a fake
// server records the process that serves, only after the flags were verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const script = resolve('gpu/measure-profile.sh');
const manifest = Object.fromEntries(readFileSync(resolve('gpu/manifest.env'), 'utf8').split('\n')
  .filter(line => line.includes('=') && !line.startsWith('#')).map(line => line.split('=') as [string, string]));
const pathOf = (tool: string) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
// The starting half of the script decides with process tools and a loopback request; where they are missing the
// tests that start something say so instead of failing.
const absent = ['pgrep', 'pkill', 'setsid', 'flock', 'curl', 'python3', 'tr'].filter(tool => !pathOf(tool));
const needsTools = absent.length ? { skip: `no ${absent.join(', ')}` } : {};

const freePort = async (): Promise<number> => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address() as AddressInfo;
  await new Promise(done => socket.close(done));
  return port;
};

// A directory that looks like the rented machine to serve.sh, with a llama-server that only records its argv. `git`
// is shimmed because serve.sh pins the llama.cpp revision and no local clone can carry that commit. `keep` decides
// what the fake does after recording: leave (the flag checks), answer /health on the port serve.sh was given (a whole
// start), or stay silent (a start that is interrupted). A staying fake kills its own process group on SIGTERM, so
// `stop_server` leaves no listener on the port behind.
type Machine = { directory: string; cmdline: string; card: string; binary: string; pidFile: string; path: string };

function fakeMachine(t: { after(action: () => void): void }, { keep = 'exit' }: { keep?: 'exit' | 'serve' | 'sleep' } = {}): Machine {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, 'llama.cpp/build/bin/llama-server');
  const cmdline = join(directory, 'cmdline');
  const card = join(directory, 'card');
  const pidFile = join(directory, 'server.pid');
  mkdirSync(join(directory, 'llama.cpp/build/bin'), { recursive: true });
  mkdirSync(join(directory, 'models'), { recursive: true });
  writeFileSync(join(directory, 'models', manifest.MODEL_FILE), '');
  writeFileSync(join(directory, 'models', manifest.DRAFT_FILE), '');
  const health = `python3 -c 'import http.server as server, sys
class Health(server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *ignored): pass
server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Health).serve_forever()' "$SIMPLE_CHAT_GPU_PORT"`;
  // The fake takes its own child down on SIGTERM (`kill 0` would signal the trapped shell again and never end), so
  // `stop_server` leaves no listener on the port for the next profile to mistake for its own.
  const stay = keep === 'exit' ? ''
    : `echo $$ >"${pidFile}"\n${keep === 'serve' ? health : 'sleep 600'} &\nserving=$!\n`
      + `trap 'kill "$serving" 2>/dev/null; exit 143' TERM INT\nwait "$serving"\n`;
  // The cards the server may use are an environment variable and not an argument, so the fake records that too: the
  // flags say nothing about which card llama.cpp would have spread itself over.
  writeFileSync(binary, `#!/usr/bin/env bash\nprintf '%s\\0' "$0" "$@" >"${cmdline}"\n`
    + `printf '%s' "\${CUDA_VISIBLE_DEVICES-unset}" >"${card}"\n${stay}`);
  chmodSync(binary, 0o755);
  const shim = join(directory, 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/usr/bin/env bash\necho ${manifest.LLAMA_CPP_REVISION}\n`);
  chmodSync(join(shim, 'git'), 0o755);
  return { directory, cmdline, card, binary, pidFile, path: `${shim}:${process.env.PATH}` };
}

// The scripts as they are shipped to the machine, in a directory of their own so a test may change one of them. The
// patched serve.sh is the server the measurer must refuse: a default or leftover one that answers on the port.
function shippedScripts(t: { after(action: () => void): void }, patchServe?: (text: string) => string) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-gpu-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ['measure-profile.sh', 'ensure-server.sh', 'serve.sh', 'server-log.py', 'manifest.env'])
    copyFileSync(resolve('gpu', name), join(directory, name));
  if (patchServe) {
    const before = readFileSync(join(directory, 'serve.sh'), 'utf8');
    const after = patchServe(before);
    assert.notEqual(after, before, 'the test patch of serve.sh matched nothing');
    writeFileSync(join(directory, 'serve.sh'), after);
  }
  return directory;
}

const measure = (scripts: string, args: string[], machine: Machine, environment: NodeJS.ProcessEnv = {}) =>
  spawnSync('bash', [join(scripts, 'measure-profile.sh'), ...args], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, ...environment } });

const markerOf = (machine: Machine) => join(machine.directory, 'measuring.profile');
const recordOf = (machine: Machine) => readFileSync(join(machine.directory, 'profile-flags.jsonl'), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);

test('ensure-server.sh starts no server while a measurement marker is valid, and is not held by it forever', async t => {
  const machine = fakeMachine(t);
  const marker = markerOf(machine);
  const ensure = () => spawnSync('bash', [resolve('gpu/ensure-server.sh')], { encoding: 'utf8', timeout: 30000,
    env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory } });
  const startedServer = async () => {
    const until = Date.now() + 20000;
    while (!existsSync(machine.cmdline) && Date.now() < until) await delay(20);
    return existsSync(machine.cmdline);
  };
  // The fake server exits once it has written its command line, but its supervisor holds server.lock a moment longer,
  // and a reconnect in that moment rightly starts nothing (`flock -n`: one server per machine). Under load that moment
  // failed this test, so a reconnect that must start a server first waits for the previous one to let go.
  const released = async () => {
    const lock = join(machine.directory, 'server.lock'), until = Date.now() + 20000;
    while (spawnSync('flock', ['-n', lock, 'true']).status !== 0 && Date.now() < until) await delay(20);
  };
  const now = () => Math.floor(Date.now() / 1000);

  writeFileSync(marker, `pool-3\nuntil=${now() + 3600}\n`);
  assert.equal(ensure().status, 0);
  await delay(300);
  assert.equal(existsSync(machine.cmdline), false, 'a reconnect replaced the profile server');

  // An interrupted session cannot take its own marker away, and a bot that silently never starts a server again is
  // worse than one spoiled measurement: a marker past its deadline, or one from before the deadline existed, is
  // announced and dropped.
  for (const stale of [`pool-3\nuntil=${now() - 1}\n`, 'pool-3\n']) {
    rmSync(machine.cmdline, { force: true });
    writeFileSync(marker, stale);
    await released();
    const reconnect = ensure();
    assert.equal(reconnect.status, 0);
    assert.match(reconnect.stdout, /expired measurement marker/);
    assert.ok(await startedServer(), `an expired marker left the bot without a server: ${JSON.stringify(stale)}`);
    assert.equal(existsSync(marker), false, 'the expired marker stayed to stop the next reconnect too');
  }

  rmSync(machine.cmdline, { force: true });
  await released();
  assert.equal(ensure().status, 0);
  assert.ok(await startedServer(), 'without the marker a reconnect must start the default server');
});

test('the end of a session leaves the bot a running default server, not an empty machine', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const started = measure(scripts, ['pool-3'], machine, { SIMPLE_CHAT_GPU_PORT: port, SIMPLE_CHAT_GPU_CARD: '1', SIMPLE_CHAT_GPU_LOG_VERBOSITY: '3' });
  assert.equal(started.status, 0, started.stderr);
  const record = recordOf(machine)[0];
  assert.equal(String(record.pid), readFileSync(machine.pidFile, 'utf8').trim(), 'record the serving process');
  assert.equal(record.verified, true);
  assert.match(String(record.flags), /--parallel 3 /);
  assert.match(String(record.flags), /--log-verbosity 3/);
  assert.equal(readFileSync(machine.card, 'utf8'), '1');
  rmSync(machine.cmdline, { force: true });

  const released = measure(scripts, ['--release'], machine, { SIMPLE_CHAT_GPU_PORT: port,
    SIMPLE_CHAT_GPU_CARD: undefined, CUDA_VISIBLE_DEVICES: undefined });
  assert.equal(released.status, 0, released.stderr);
  assert.equal(existsSync(markerOf(machine)), false);
  for (let tries = 0; tries < 200 && !existsSync(machine.cmdline); tries++) await delay(20);
  assert.ok(existsSync(machine.cmdline), 'the session ended with a machine that has no server on it');
  // The bot's own default server, not the profile's: nothing of the measurement session decides what runs now.
  const argv = readFileSync(machine.cmdline, 'utf8').replaceAll('\0', ' ');
  assert.match(argv, /--parallel 1 /, `the profile server outlived the session: ${argv}`);
  assert.match(argv, /--no-kv-unified/);
  assert.equal(readFileSync(machine.card, 'utf8'), '0', 'the default server keeps off the picture card');
  assert.equal(spawnSync('pgrep', ['-f', machine.binary]).status, 0, 'the server the bot was handed is not running');
});

test('the text server uses one selected GPU and refuses an invalid selection before starting', t => {
  for (const [environment, card] of [[{}, '0'], [{ SIMPLE_CHAT_GPU_CARD: '1' }, '1'],
    [{ CUDA_VISIBLE_DEVICES: 'GPU-0000' }, 'GPU-0000'], [{ SIMPLE_CHAT_GPU_CARD: 'all' }, undefined]] as const) {
    const machine = fakeMachine(t);
    const started = spawnSync('bash', [resolve('gpu/serve.sh')], { encoding: 'utf8', timeout: 30000,
      env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, ...environment } });
    assert.equal(started.status, card === undefined ? 1 : 0, started.stderr);
    if (card === undefined) assert.equal(existsSync(machine.card), false, 'invalid selection starts no server');
    else assert.equal(readFileSync(machine.card, 'utf8'), card);
  }
});

test('a start whose server answers with another profile flags is refused, and the record says it was', needsTools, async t => {
  const port = String(await freePort());
  // A server that serves the port but not this profile: what a reconnect of the bot, or an earlier block, leaves.
  const scripts = shippedScripts(t, text => text.replace('--parallel "$slots"', '--parallel 2'));
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const started = measure(scripts, ['single'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /did not take effect/);

  const rows = recordOf(machine);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verified, false, 'a refused start was recorded as the profile it had asked for');
  assert.equal(rows[0].slots, 1);
  assert.match(String(rows[0].flags), /--parallel 2/);
  assert.equal(existsSync(markerOf(machine)), false, 'a refused start kept holding the bot back');
  assert.equal(spawnSync('pgrep', ['-f', machine.binary]).status, 1, 'the refused server was left running');
});

// bootstrap.sh fetches the draft weights only when SIMPLE_CHAT_GPU_DRAFT=true was set at bootstrap time, an hour
// before the draft profile runs; serve.sh then exits with 'Draft model missing'. Finding that out after the
// measurement server has been stopped costs the running block as well as the draft one.
test('a draft profile without its weights is refused before the running server is stopped', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const serving = measure(scripts, ['pool-3'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(serving.status, 0, serving.stderr);
  rmSync(join(machine.directory, 'models', manifest.DRAFT_FILE));

  const started = measure(scripts, ['pool-3-draft'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /draft weights; rerun/);
  assert.equal(spawnSync('pgrep', ['-f', machine.binary]).status, 0, 'the block that was serving was stopped too');
  assert.match(readFileSync(markerOf(machine), 'utf8'), /^pool-3\n/, 'the running profile lost its marker');
});

test('an interrupted start gives the server back to the bot', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'sleep' });  // starts, never answers: the session is interrupted while waiting
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const child = spawn('bash', [join(scripts, 'measure-profile.sh'), 'single'], { stdio: 'ignore',
    env: { ...process.env, PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, SIMPLE_CHAT_GPU_PORT: port } });
  t.after(() => child.kill('SIGKILL'));
  for (let tries = 0; tries < 200 && !existsSync(markerOf(machine)); tries++) await delay(20);
  assert.ok(existsSync(markerOf(machine)), 'the marker was never written');

  // Ctrl-C while the profile is still starting: without its own handler the script would not even end here, and the
  // marker would hold every later reconnect back.
  child.kill('SIGINT');
  for (let tries = 0; tries < 250 && existsSync(markerOf(machine)); tries++) await delay(20);
  assert.equal(existsSync(markerOf(machine)), false, 'Ctrl-C left a marker that stops every later reconnect');
});

test('a health timeout that is not a number is refused before anything is started', async t => {
  const machine = fakeMachine(t);
  const started = measure(shippedScripts(t), ['single'], machine, { SIMPLE_CHAT_MEASURE_HEALTH_SECONDS: 'oops' });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /SIMPLE_CHAT_MEASURE_HEALTH_SECONDS/);
  // Read where its neighbour is read, or the arithmetic that first touches it runs after the profile server has
  // started: the script then dies, the trap takes the marker with it, and that server is left holding the lock.
  await delay(300);
  assert.equal(existsSync(machine.cmdline), false, `a server was started before the value was read: ${started.stderr}`);
});

test('the script stops when a tool it decides with is missing', t => {
  // Without pgrep a process list reads as "nothing runs": stop_server would kill nothing and the health wait would
  // give up on a server that is serving, leaving the profile up and the marker gone.
  const bare = mkdtempSync(join(tmpdir(), 'simple-chat-bare-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  for (const tool of ['bash', 'dirname']) symlinkSync(pathOf(tool), join(bare, tool));
  const started = spawnSync('bash', [script, 'single'], { encoding: 'utf8', timeout: 30000, env: { PATH: bare } });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /needs pgrep/);
});
