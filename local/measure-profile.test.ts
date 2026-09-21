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
const profiles = (): string[] => run(['--list']).stdout.trim().split(' ');

const run = (args: string[], options: { env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync('bash', [script, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...options.env } });

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

// The environment `--print` says the profile has, as serve.sh would receive it.
function environmentOf(profile: string): NodeJS.ProcessEnv {
  const printed = run(['--print', profile]);
  assert.equal(printed.status, 0, printed.stderr);
  return Object.fromEntries(printed.stdout.split('\n').map(line => line.trim())
    .filter(line => /^SIMPLE_CHAT_GPU_[A-Z_]+=\S+$/.test(line)).map(line => line.split('=') as [string, string]));
}

// A directory that looks like the rented machine to serve.sh, with a llama-server that only records its argv. `git`
// is shimmed because serve.sh pins the llama.cpp revision and no local clone can carry that commit. `keep` decides
// what the fake does after recording: leave (the flag checks), answer /health on the port serve.sh was given (a whole
// start), or stay silent (a start that is interrupted). A staying fake kills its own process group on SIGTERM, so
// `stop_server` leaves no listener on the port behind.
type Machine = { directory: string; cmdline: string; binary: string; pidFile: string; path: string };

function fakeMachine(t: { after(action: () => void): void }, { keep = 'exit' }: { keep?: 'exit' | 'serve' | 'sleep' } = {}): Machine {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-profile-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, 'llama.cpp/build/bin/llama-server');
  const cmdline = join(directory, 'cmdline');
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
  writeFileSync(binary, `#!/usr/bin/env bash\nprintf '%s\\0' "$0" "$@" >"${cmdline}"\n${stay}`);
  chmodSync(binary, 0o755);
  const shim = join(directory, 'shim');
  mkdirSync(shim);
  writeFileSync(join(shim, 'git'), `#!/usr/bin/env bash\necho ${manifest.LLAMA_CPP_REVISION}\n`);
  chmodSync(join(shim, 'git'), 0o755);
  return { directory, cmdline, binary, pidFile, path: `${shim}:${process.env.PATH}` };
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

test('every profile of a session shares the workload flags and labels its own measurer command', () => {
  const names = profiles();
  assert.ok(names.includes('single') && names.includes('pool-3') && names.includes('pool-3-draft'));
  for (const profile of names) {
    const printed = run(['--print', profile]).stdout;
    assert.match(printed, /--ubatch-size 128/);
    assert.match(printed, /--scenes 2 --read-seconds 15 --minutes 12/);
    assert.match(printed, new RegExp(`--profile ${profile} `));
    // The measurer's `--draft` only labels a report, so the label has to come from the same place as the server.
    assert.equal(/--draft/.test(printed), profile.includes('draft'));
    // Every profile names all three bot variables, because this script runs on the rented machine and cannot see
    // .env.gpu: a line it leaves out is a pool's setting surviving into the next profile's report.
    assert.match(printed, /SIMPLE_CHAT_GPU_SLOTS=\d+\n\s+SIMPLE_CHAT_GPU_KV_UNIFIED=(?:true|false)\n\s+SIMPLE_CHAT_POOL_TOKENS=\d+\n/);
  }
  assert.equal(run(['--print', 'pool-4']).status, 1);
  assert.match(run(['--print', 'pool-4']).stderr, /Unknown profile/);
});

test('serve.sh started with a profile environment passes that profile check and fails another', t => {
  const machine = fakeMachine(t);
  for (const profile of profiles()) {
    rmSync(machine.cmdline, { force: true });
    const started = spawnSync('bash', [resolve('gpu/serve.sh')], { encoding: 'utf8', timeout: 30000,
      env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, ...environmentOf(profile) } });
    assert.equal(started.status, 0, `${profile}: ${started.stderr}`);
    assert.ok(existsSync(machine.cmdline), `${profile} started no server`);
    const verified = run(['--verify', profile, machine.cmdline]);
    assert.equal(verified.status, 0, `${profile}: ${verified.stderr}`);
    // The failure that matters: another profile's server, which is what the bot's reconnect would leave behind.
    const other = profile === 'pool-3' ? 'pool-3-draft' : 'pool-3';
    const rejected = run(['--verify', other, machine.cmdline]);
    assert.equal(rejected.status, 1, `${other} accepted a ${profile} server`);
    assert.match(rejected.stderr, /Missing from the running server|draft model/);
  }
});

test('the default server ensure-server.sh starts is refused under every pooled profile', t => {
  const machine = fakeMachine(t);
  const started = spawnSync('bash', [resolve('gpu/serve.sh')], { encoding: 'utf8', timeout: 30000,
    env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory } });
  assert.equal(started.status, 0, started.stderr);
  for (const profile of profiles().filter(name => name !== 'single')) {
    const rejected = run(['--verify', profile, machine.cmdline]);
    assert.equal(rejected.status, 1, `${profile} accepted the default one-slot server`);
  }
});

test('ensure-server.sh starts no server while a measurement marker is valid, and is not held by it forever', async t => {
  const machine = fakeMachine(t);
  const marker = markerOf(machine);
  const ensure = () => spawnSync('bash', [resolve('gpu/ensure-server.sh')], { encoding: 'utf8', timeout: 30000,
    env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory } });
  const startedServer = async () => {
    for (let tries = 0; tries < 200 && !existsSync(machine.cmdline); tries++) await delay(20);
    return existsSync(machine.cmdline);
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
    const reconnect = ensure();
    assert.equal(reconnect.status, 0);
    assert.match(reconnect.stdout, /expired measurement marker/);
    assert.ok(await startedServer(), `an expired marker left the bot without a server: ${JSON.stringify(stale)}`);
    assert.equal(existsSync(marker), false, 'the expired marker stayed to stop the next reconnect too');
  }

  rmSync(machine.cmdline, { force: true });
  assert.equal(ensure().status, 0);
  assert.ok(await startedServer(), 'without the marker a reconnect must start the default server');
});

test('a start that takes effect records the server, not its supervisor, and calls the record verified', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const started = measure(scripts, ['single'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(started.status, 0, started.stderr);

  const rows = recordOf(machine);
  assert.equal(rows.length, 1);
  // The supervisor's argv carries the server's path too, and it is the older process: the pid and the flags of the
  // record have to be the process that holds the memory, the one nvidia-smi lists.
  assert.equal(String(rows[0].pid), readFileSync(machine.pidFile, 'utf8').trim(), 'the supervisor was recorded');
  assert.ok(!String(rows[0].flags).includes('server-log.py'), `the supervisor's argv was recorded: ${rows[0].flags}`);
  assert.match(String(rows[0].flags), /--parallel 1 /);
  assert.equal(rows[0].verified, true);
  assert.match(readFileSync(markerOf(machine), 'utf8'), /^single\nuntil=\d+\n$/);

  // The end of the session: the bot owns the next start again.
  const released = measure(scripts, ['--release'], machine);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(existsSync(markerOf(machine)), false);
  assert.equal(spawnSync('pgrep', ['-f', machine.binary]).status, 1, 'the profile server outlived the session');
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

test('a start that cannot take the lock says so where the operator is sent', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t);
  const log = join(machine.directory, 'serve-single.out');
  writeFileSync(log, 'Starting gemma-4-31b-heretic-q6k; context=65536, slots=1, loopback port=18080.\n');
  const holder = spawn('flock', [join(machine.directory, 'server.lock'), 'sleep', '30'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await delay(300);

  const started = measure(scripts, ['single'], machine, { SIMPLE_CHAT_GPU_PORT: port, SIMPLE_CHAT_MEASURE_HEALTH_SECONDS: '3' });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /did not start; see/);
  const text = readFileSync(log, 'utf8');
  assert.ok(!text.includes('Starting gemma'), 'the log the operator is sent to still shows an earlier run succeeding');
  assert.match(text, /Another process holds/);
  assert.equal(existsSync(markerOf(machine)), false);
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

test('the shell of the rented machine parses', () => {
  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
  for (const file of ['gpu/measure-profile.sh', 'gpu/ensure-server.sh', 'gpu/serve.sh']) {
    assert.equal(spawnSync('bash', ['-n', resolve(file)], { encoding: 'utf8' }).status, 0, file);
    if (!shellcheck) continue;
    const linted = spawnSync('shellcheck', ['-S', 'warning', resolve(file)], { encoding: 'utf8' });
    assert.equal(linted.status, 0, `${file}: ${linted.stdout}`);
  }
});
