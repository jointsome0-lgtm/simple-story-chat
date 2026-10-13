import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServing } from '../serving.ts';
import type { ModelRequest } from '../model.ts';

// The bot's adapter against the real simple-serving gateway, in front of the fake engine its dev launcher starts on
// loopback. Not part of `npm test`: `npm run test:serving` needs a checkout of simple-serving (SIMPLE_SERVING_CHECKOUT)
// and the python of an environment with its dependencies (SIMPLE_SERVING_PYTHON), and fails without them, since a
// gateway it could not start is no pass. The shared cases (local/serving-contract.test.ts) play the gateway's answers;
// this asks the gateway itself. The gateway's own lifecycle, its sleep included, stays in its own tests.
const checkout = process.env.SIMPLE_SERVING_CHECKOUT;
const python = process.env.SIMPLE_SERVING_PYTHON;
// The launcher serves the service block of the bot's pinned cases: their model, context and test keys.
const cases = fileURLToPath(new URL('../serving-contract/cases-v2.json', import.meta.url));
const { service } = JSON.parse(readFileSync(cases, 'utf8')) as { service: { alias: string; context_tokens: number } };

// Loopback ports that were free a moment ago: the launcher takes its ports as numbers.
async function freePorts(count: number) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise<Server>(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = servers.map(server => (server.address() as AddressInfo).port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}
// The commit a checkout holds, marked when its tracked files differ from it.
function commitOf(directory: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  return git('rev-parse', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '+changes' : '');
}

test('the real gateway: state and contract, a count, a stream with usage, a refusal, a cancellation and the classes', { timeout: 120_000 }, async t => {
  assert.ok(checkout && python, 'Set SIMPLE_SERVING_CHECKOUT to a checkout of simple-serving and SIMPLE_SERVING_PYTHON to the python of its environment');
  assert.ok(existsSync(`${checkout}/simple_serving/dev.py`), 'SIMPLE_SERVING_CHECKOUT has no simple_serving/dev.py');
  t.diagnostic(`simple-chat ${commitOf(fileURLToPath(new URL('../..', import.meta.url)))}, simple-serving ${commitOf(checkout)}`);

  const [engine, gateway, control] = await freePorts(3);
  // Each event of a generation 50 ms after the last, so that a stream the bot leaves is still running.
  const launcher = spawn(python, ['-m', 'simple_serving.dev', '--config', cases, '--engine-port', String(engine),
    '--public-port', String(gateway), '--control-port', String(control), '--event-delay-ms', '50'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(launcher, 'close');
  t.after(async () => { launcher.kill('SIGTERM'); await exited; });
  // The gateway's log: a JSON row per line, of named fields only (simple_serving/log.py there). A line that is not
  // one, such as the end of a traceback, is kept to say why the launcher stopped.
  const rows: { [field: string]: unknown }[] = [];
  let partial = '';
  let other = '';
  launcher.stderr.setEncoding('utf8').on('data', (text: string) => {
    const lines = (partial + text).split('\n');
    partial = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch { other = line; }
    }
  });
  let printed = '';
  await new Promise<void>((resolve, reject) => {
    launcher.stdout.setEncoding('utf8').on('data', (text: string) => {
      printed += text;
      if (printed.includes('simple-serving dev launcher: ready')) resolve();
    });
    void exited.then(([code]) => reject(new Error(`The launcher stopped (${code}) before it was ready: ${other}`)));
  });

  const provider = createServing({ baseUrl: `http://127.0.0.1:${gateway}`, model: service.alias,
    contextTokens: service.context_tokens, apiKey: 'test-key-bot', timeoutMs: 30_000 });
  // Contract 2, ready, this model, and one context in the state and the models.
  assert.deepEqual(await provider.check(), { model: service.alias, contextTokens: service.context_tokens });
  const request: ModelRequest = { system: 'You narrate a short synthetic story.',
    messages: [{ role: 'user', content: 'The lighthouse keeper opens the door.' }], maxOutputTokens: 64 };
  const reader = { priority: 'foreground', holder: 'synthetic-reader' } as const;
  // The fake engine counts a quarter of the characters, rounded up, and the gateway passes its count on.
  const input = await provider.countInput(request, reader);
  assert.equal(input, Math.ceil((request.system + request.messages[0].content).length / 4));
  // The text as it was streamed, in more than one piece, the engine's count equal to the gateway's (the adapter
  // refuses any other) and the gateway's measurements.
  const streamed: string[] = [];
  const result = await provider.generate(request, { ...reader, onText: async text => { streamed.push(text); } });
  assert.ok(streamed.length > 1 && result.text === streamed.join('') && result.text.trim(), 'the streamed text');
  assert.deepEqual([result.finishReason, result.usage?.inputTokens], ['stop', input]);
  assert.deepEqual(Object.keys(result.timings!).sort(), ['servingFirstTokenMs', 'servingTotalMs', 'servingWaitMs']);
  // Sent on a trusted estimate, an input over the context reaches the gateway, which counts it and refuses it.
  const long = { ...request, system: 'x'.repeat(4 * service.context_tokens), estimatedInputTokens: 1, trustEstimate: true };
  await assert.rejects(provider.generate(long, reader), { code: 'context_limit', servingCode: 'context_limit', httpStatus: 400 });
  // The bot leaves a stream at its first text.
  const leave = new AbortController();
  await assert.rejects(provider.generate(request, { ...reader, signal: leave.signal, onText: async () => leave.abort() }),
    { code: 'cancelled' });
  // An agent's turn and an internal count.
  assert.ok((await provider.generate(request, { priority: 'agent' })).text.trim());
  assert.equal(await provider.countInput(request), input);

  // The gateway's rows of these calls, in any order: each under the bot's key, in the class and scope the bot meant,
  // and the stream the bot left recorded as cancelled. A row is written once its request has ended.
  const expected = ['count reader/reader 200', 'chat reader/reader stop', 'chat reader/reader context_limit',
    'count reader/reader 200', 'chat reader/reader cancelled', 'count agent/agent 200', 'chat agent/agent stop',
    'count internal/internal 200'].sort();
  const calls = () => rows.filter(row => row.event === 'request' && String(row.route).startsWith('/v1/chat/completions'))
    .map(row => `${row.route === '/v1/chat/completions' ? 'chat' : 'count'} ${row.class}/${row.scope} ${
      row.cancelled ? 'cancelled' : row.code ?? row.finish ?? row.status}${row.key === 'bot' ? '' : ` key ${row.key}`}`).sort();
  for (let waited = 0; calls().length < expected.length && waited < 5000; waited += 50) await sleep(50);
  assert.deepEqual(calls(), expected);
});
