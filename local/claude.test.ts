import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Launch } from './claude.ts';
import { createClaude } from './claude.ts';
import type { ModelRequest } from './model.ts';

const request: ModelRequest = { system: 'synthetic system', messages: [{ role: 'user', content: 'synthetic private seed' }], maxOutputTokens: 256 };
const init = { type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'test-model' };
const chunk = (text: string) => ({ type: 'stream_event', event: { delta: { type: 'text_delta', text } } });
function fixture(t: TestContext, events: object[], exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = { dbPath: join(directory, 'test.sqlite'), model: 'test-model', contextTokens: 65536 };
  let launches = 0;
  // The provider must not pass another address or token on to the CLI.
  process.env.ANTHROPIC_BASE_URL = 'http://elsewhere.invalid';
  t.after(() => { delete process.env.ANTHROPIC_BASE_URL; });
  const provider = createClaude(config, { launch(command, args, options) {
    launches++;
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--no-session-persistence'));
    assert.ok(!args.join(' ').includes('synthetic private seed'));
    assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(options.env.ANTHROPIC_BASE_URL, undefined);
    const output = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    return spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(' + JSON.stringify(output) + '); process.exitCode=' + exitCode + '; });'], options);
  } });
  return { provider, launches: () => launches };
}

test('CLI emits only text deltas and requires a successful terminal result', async t => {
  const f = fixture(t, [init, chunk('Первая '), chunk('сцена.'),
    { type: 'result', subtype: 'success', is_error: false, result: 'Первая сцена.' }]);
  const chunks: string[] = [];
  const result = await f.provider.generate(request, { onText: async text => { chunks.push(text); } });
  assert.deepEqual(chunks, ['Первая ', 'сцена.']);
  assert.equal(result.text, 'Первая сцена.');
});

test('configured CLI deadline terminates a stalled process and reports timeout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-cli-timeout-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let child: ReturnType<Launch> | undefined;
  const provider = createClaude({ dbPath: join(directory, 'test.sqlite'), model: 'test-model',
    contextTokens: 65536, timeoutMs: 80 }, { launch(_command, _args, options) {
    child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], options);
    return child;
  } });
  await assert.rejects(provider.generate(request), { code: 'timeout' });
  assert.equal(child!.signalCode, 'SIGTERM');
});

test('unexpected tools fail before emitting a preview', async t => {
  const f = fixture(t, [{ ...init, tools: ['Bash'] }, chunk('no')]);
  let previews = 0;
  await assert.rejects(f.provider.generate(request, { onText: async () => { previews++; } }), { code: 'unexpected_tools' });
  assert.equal(previews, 0);
});

test('an incomplete stream is not a completed scene', async t => {
  const f = fixture(t, [init, chunk('unfinished')]);
  await assert.rejects(f.provider.generate(request), { code: 'provider_failed' });
});

test('a failed process cannot turn a success-looking result into a saved scene', async t => {
  const f = fixture(t, [init, { type: 'result', subtype: 'success', result: 'text' }], 1);
  await assert.rejects(f.provider.generate(request), { code: 'provider_failed' });
});

test('oversized context stops before invoking the model', async t => {
  const f = fixture(t, []);
  await assert.rejects(f.provider.generate({ ...request, messages: [{ role: 'user', content: 'я'.repeat(140000) }] }), { code: 'context_limit' });
  assert.equal(f.launches(), 0);
});

test('a truncated terminal field cannot discard the beginning of the streamed scene', async t => {
  const full = '2026-08-02 20:00\n\nСильная лодка.\n\nСледующий абзац.';
  const f = fixture(t, [init, chunk(full.slice(0, 29)), chunk(full.slice(29)),
    { type: 'result', subtype: 'success', result: 'ка.\n\nСледующий абзац.' }]);
  const result = await f.provider.generate(request);
  assert.equal(result.text, full);
  assert.equal(result.streamResultMismatch, true);
});

const start = (id: string, usage: object) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, usage } } });
const delta = (usage: object) => ({ type: 'stream_event', event: { type: 'message_delta', usage } });

test('usage includes cache once, ignores placeholder outputs and does not sum cumulative deltas', async t => {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 3 };
  const assistant = { type: 'assistant', message: { id: 'response-1', usage } };
  const f = fixture(t, [init, start('response-1', usage), assistant, assistant, chunk('scene'),
    delta({ output_tokens: 10 }), delta({ output_tokens: 40 }),
    { type: 'result', subtype: 'success', num_turns: 1, result: 'scene', usage: { ...usage, output_tokens: 40 } }]);
  assert.deepEqual((await f.provider.generate(request)).usage, { inputTokens: 1100, outputTokens: 40, totalTokens: 1140 });
});

test('last-response usage is not the aggregate across model steps', async t => {
  const f = fixture(t, [init, start('a', { input_tokens: 1000 }), delta({ output_tokens: 20 }),
    start('b', { input_tokens: 50, cache_read_input_tokens: 100 }), chunk('scene'), delta({ output_tokens: 30 }),
    { type: 'result', subtype: 'success', num_turns: 2, result: 'scene', usage: { input_tokens: 1050, cache_read_input_tokens: 100, output_tokens: 50 } }]);
  assert.deepEqual((await f.provider.generate(request)).usage, { inputTokens: 150, outputTokens: 30, totalTokens: 180 });
});

test('unknown usage is not fabricated as zero', async t => {
  const f = fixture(t, [init, chunk('scene'), { type: 'result', subtype: 'success', result: 'scene' }]);
  assert.equal((await f.provider.generate(request)).usage, null);
});

test('actual cached input triggers compaction before any preview, even if the estimate was low', async t => {
  const f = fixture(t, [init, start('large', { input_tokens: 1000, cache_read_input_tokens: 53000 }), chunk('must not appear')]);
  let previews = 0;
  await assert.rejects(f.provider.generate(request, { inputLimitTokens: 53999, onText: async () => { previews++; } }), { code: 'context_limit' });
  assert.equal(previews, 0);
});

test('large UTF-8 input is allowed when its observed token count fits, and fails closed without usage', async t => {
  const large: ModelRequest = { ...request, messages: [{ role: 'user', content: 'я'.repeat(40000) }] };
  const f = fixture(t, [init, start('large', { input_tokens: 25000 }), chunk('scene'),
    delta({ output_tokens: 10 }), { type: 'result', subtype: 'success', result: 'scene' }]);
  assert.equal((await f.provider.generate(large)).text, 'scene');
  const missing = fixture(t, [init, chunk('no'), { type: 'result', subtype: 'success', result: 'no' }]);
  await assert.rejects(missing.provider.generate(large), { code: 'usage_unavailable' });
});

test('a failed CLI run names how it ended, never its text', async t => {
  const refused = fixture(t, [init, { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'PRIVATE' }]);
  await assert.rejects(refused.provider.generate(request),
    { code: 'provider_failed', cliResult: 'error_max_structured_output_retries', cliError: true, exitCode: 0 });
  const unknown = fixture(t, [init, { type: 'result', subtype: 'PRIVATE', is_error: false, result: 'x' }]);
  await assert.rejects(unknown.provider.generate(request), { code: 'provider_failed', cliResult: 'other', cliError: false });
  const none = fixture(t, [init, chunk('scene')], 1);
  await assert.rejects(none.provider.generate(request), { code: 'provider_failed', cliResult: 'missing', exitCode: 1 });
});
