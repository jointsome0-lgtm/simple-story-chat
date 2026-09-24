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

test('every profile of a session shares the workload flags and labels its own measurer command', () => {
  const names = profiles();
  assert.ok(names.includes('single') && names.includes('pool-3') && names.includes('pool-3-draft'));
  for (const profile of names) {
    const printed = run(['--print', profile]).stdout;
    assert.match(printed, /--ubatch-size 128/);
    assert.match(printed, /--fixture battle --cold-runs 1 --scenes 1 --read-seconds 15 --minutes 12/);
    assert.match(printed, new RegExp(`--profile ${profile} `));
    // The measurer's `--draft` only labels a report, so the label has to come from the same place as the server.
    assert.equal(/--draft/.test(printed), profile.includes('draft'));
    // The memory verdicts are about one card. On a two-card box nothing attributes llama-server to one by itself —
    // nvidia-smi reports host pids and gpu/diagnose-remote.py reads the container's own /proc — so a command
    // without `--card` leaves thresholds 1 and 7 `unknown` for every profile of the session.
    assert.match(printed, /--card 0(?: |$)/m);
    // Every profile names all three bot variables, because this script runs on the rented machine and cannot see
    // .env.gpu: a line it leaves out is a pool's setting surviving into the next profile's report.
    assert.match(printed, /SIMPLE_CHAT_GPU_SLOTS=\d+\n\s+SIMPLE_CHAT_GPU_KV_UNIFIED=(?:true|false)\n\s+SIMPLE_CHAT_POOL_TOKENS=\d+\n/);
  }
  // The card is the machine's, not the profile's, so it is named once in the environment and follows into the
  // printed command; the log level travels the same way, and the record then says which level ran.
  const named = run(['--print', 'pool-3'], { env: { SIMPLE_CHAT_GPU_CARD: '1', SIMPLE_CHAT_GPU_LOG_VERBOSITY: '3' } });
  assert.match(named.stdout, /--card 1(?: |$)/m);
  assert.match(named.stdout, /SIMPLE_CHAT_GPU_LOG_VERBOSITY=3/);
  const refused = run(['--print', 'pool-3'], { env: { SIMPLE_CHAT_GPU_LOG_VERBOSITY: '9' } });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /SIMPLE_CHAT_GPU_LOG_VERBOSITY/);
  assert.equal(run(['--print', 'pool-4']).status, 1);
  assert.match(run(['--print', 'pool-4']).stderr, /Unknown profile/);
});

// The one command the operator is told to run in every block, checked against the measurer that has to accept it.
// A plan that does not fit is refused before anything is measured, and improvising flags per profile instead would
// give each report its own `workload.fingerprint`, which is exactly what makes `decide()` refuse to compare them.
test('the measurer accepts the command every profile prints, and its plan fits the block', t => {
  const printed = run(['--print', 'pool-3']).stdout;
  const command = /^\s*npm run gpu:measure -- (--profile \S.*)$/m.exec(printed);
  assert.ok(command, `no measurer command was printed:\n${printed}`);
  // A directory of its own and a provider that is not llama.cpp: the plan is the whole question here, and no
  // configuration of this machine may decide the answer.
  const elsewhere = mkdtempSync(join(tmpdir(), 'simple-chat-plan-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const measurer = spawnSync(process.execPath, [resolve('local/gpu-measure.ts'), ...command[1].split(' ')],
    { encoding: 'utf8', timeout: 60000, cwd: elsewhere, env: { PATH: process.env.PATH ?? '', SIMPLE_CHAT_PROVIDER: 'claude-code' } });
  const plan = measurer.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    .find(row => row.event === 'measurement_plan');
  assert.ok(plan, `the measurer refused the printed flags: ${measurer.stderr}`);
  assert.equal(plan.fits, true, `${plan.plannedSeconds}s planned against the ${plan.maximumPlannedSeconds}s the block allows`);
  // Everything after the plan needs a llama.cpp server, so this is as far as a measurement goes without one.
  assert.match(measurer.stderr, /gpu_config_required/);
});

test('the pooled profiles differ from each other in slots alone, at a pool the card was measured at', () => {
  const unified = profiles().map(environmentOf).filter(environment => environment.SIMPLE_CHAT_GPU_KV_UNIFIED === 'true');
  assert.ok(unified.length >= 2, 'a session with one pooled profile decides nothing about slots');
  const cells = new Set(unified.map(environment => environment.SIMPLE_CHAT_GPU_POOL));
  assert.equal(cells.size, 1, `the pooled profiles move the pool and the slots at once: ${[...cells].join(', ')}`);
  // The floor is the scheduler's (docs/gpu.md, "The pool has a floor"); 131072 is the ceiling local/config.ts
  // allows SIMPLE_CHAT_POOL_TOKENS, which the pool has to stay within to be the bot's own.
  const pool = Number([...cells][0]);
  assert.ok(pool >= 78970 && pool <= 131072, `${pool} cells`);
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

// The bot's reconnect starts the server with an empty environment (local/gpu-connection.ts), so what a rental was set
// up with lives in a file on the machine: serve.sh reads it for every start, and the caller's own values win.
test('serve.sh takes the machine\'s own settings from serve.env, and the caller\'s environment still wins', t => {
  const machine = fakeMachine(t);
  const start = (environment: NodeJS.ProcessEnv = {}) => spawnSync('bash', [resolve('gpu/serve.sh')],
    { encoding: 'utf8', timeout: 30000, env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, ...environment } });
  const argv = () => readFileSync(machine.cmdline, 'utf8').split('\0');
  assert.equal(start().status, 0);
  assert.ok(!argv().includes('--spec-draft-model'), 'no draft without being asked');
  writeFileSync(join(machine.directory, 'serve.env'),
    'SIMPLE_CHAT_GPU_DRAFT=true\n# a comment\nPATH=/nowhere\nSIMPLE_CHAT_GPU_DIR=/elsewhere\nSIMPLE_CHAT_GPU_UBATCH=256');
  const started = start();
  assert.equal(started.status, 0, started.stderr);
  assert.ok(argv().includes('--spec-draft-model'), 'the machine\'s setting turned the draft on');
  assert.equal(argv()[argv().indexOf('--ubatch-size') + 1], '256', 'a last line without a newline is read too');
  assert.equal(start({ SIMPLE_CHAT_GPU_DRAFT: 'false' }).status, 0);
  assert.ok(!argv().includes('--spec-draft-model'), 'the caller\'s own value wins');
});

// The two lanes of the session share a box and not a card: gpu/image-serve.sh pins ComfyUI to one, and nothing
// pinned llama-server, whose `--gpu-layers 99` under llama.cpp's default split mode spreads the layers and the whole
// KV pool over every visible card. Fourteen GiB of Gemma on the picture card is an out-of-memory in the middle of
// somebody's scene, and it would be blamed on the checkpoint.
test('serve.sh takes one card, so the picture lane keeps its own', t => {
  const machine = fakeMachine(t);
  const start = (environment: NodeJS.ProcessEnv) => spawnSync('bash', [resolve('gpu/serve.sh')],
    { encoding: 'utf8', timeout: 30000, env: { PATH: machine.path, SIMPLE_CHAT_GPU_DIR: machine.directory, ...environment } });

  const plain = start({});
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(readFileSync(machine.card, 'utf8'), '0', 'the server was left free to take every card');
  assert.match(plain.stdout, /card=0/, 'the start line does not say which card it took');

  assert.equal(start({ SIMPLE_CHAT_GPU_CARD: '1' }).status, 0);
  assert.equal(readFileSync(machine.card, 'utf8'), '1');
  // A card the container itself chose stays as it is: it may be a list or a UUID, and it is not this script's.
  assert.equal(start({ CUDA_VISIBLE_DEVICES: 'GPU-0000' }).status, 0);
  assert.equal(readFileSync(machine.card, 'utf8'), 'GPU-0000');
  const bad = start({ SIMPLE_CHAT_GPU_CARD: 'all' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /SIMPLE_CHAT_GPU_CARD/);
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
});

// `env -i` keeps the operator's shell from deciding a profile by accident, and it kept out the two variables that
// are the machine's own: the card the server may use, and how much the server says about its memory. The block that
// wants llama.cpp's own account of its cache sizes runs at verbosity 3, and no profile started here could ask for it.
test('a profile start carries the machine card and the log level the block asks for', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const started = measure(scripts, ['pool-3'], machine,
    { SIMPLE_CHAT_GPU_PORT: port, SIMPLE_CHAT_GPU_CARD: '1', SIMPLE_CHAT_GPU_LOG_VERBOSITY: '3' });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(readFileSync(machine.card, 'utf8'), '1', 'the profile server was spread over every card');
  assert.match(readFileSync(machine.cmdline, 'utf8').replaceAll('\0', ' '), /--log-verbosity 3/);
  assert.match(started.stdout, /--card 1(?: |$)/m);
});

// Stopping the profile is not handing the server back. The bot runs ensure-server.sh only while it is creating a
// tunnel — local/gpu-connection.ts keeps a live one and never asks again, and a failing health check does not close
// it — so a session that ends with an empty machine leaves a bot forwarding the port to nothing until it restarts.
test('the end of a session leaves the bot a running default server, not an empty machine', needsTools, async t => {
  const port = String(await freePort());
  const scripts = shippedScripts(t);
  const machine = fakeMachine(t, { keep: 'serve' });
  t.after(() => spawnSync('pkill', ['-f', machine.binary]));
  const started = measure(scripts, ['pool-3'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(started.status, 0, started.stderr);
  assert.match(String(recordOf(machine)[0].flags), /--parallel 3 /);
  rmSync(machine.cmdline, { force: true });

  const released = measure(scripts, ['--release'], machine, { SIMPLE_CHAT_GPU_PORT: port });
  assert.equal(released.status, 0, released.stderr);
  assert.equal(existsSync(markerOf(machine)), false);
  for (let tries = 0; tries < 200 && !existsSync(machine.cmdline); tries++) await delay(20);
  assert.ok(existsSync(machine.cmdline), 'the session ended with a machine that has no server on it');
  // The bot's own default server, not the profile's: nothing of the measurement session decides what runs now.
  const argv = readFileSync(machine.cmdline, 'utf8').replaceAll('\0', ' ');
  assert.match(argv, /--parallel 1 /, `the profile server outlived the session: ${argv}`);
  assert.match(argv, /--no-kv-unified/);
  assert.equal(spawnSync('pgrep', ['-f', machine.binary]).status, 0, 'the server the bot was handed is not running');
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

test('the shell of the rented machine parses', () => {
  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
  for (const file of ['gpu/measure-profile.sh', 'gpu/ensure-server.sh', 'gpu/serve.sh']) {
    assert.equal(spawnSync('bash', ['-n', resolve(file)], { encoding: 'utf8' }).status, 0, file);
    if (!shellcheck) continue;
    const linted = spawnSync('shellcheck', ['-S', 'warning', resolve(file)], { encoding: 'utf8' });
    assert.equal(linted.status, 0, `${file}: ${linted.stdout}`);
  }
});
