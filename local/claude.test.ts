import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Launch } from './claude.ts';
import { createClaude } from './claude.ts';
import { ModelError } from './model-error.ts';
import type { GenerateControls, ModelRequest } from './model.ts';

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

test('unexpected tools fail before emitting a preview; a run is a scene only after a successful result, and a failed one names how it ended, never its text', async t => {
  type Failure = { code: string; cliResult?: string; cliError?: boolean; exitCode?: number; stopReason?: string };
  const runs: [string, object[], number, string | Failure, string[]?][] = [
    ['text deltas and a successful result', [init, chunk('Первая '), chunk('сцена.'), { type: 'result', subtype: 'success', is_error: false, result: 'Первая сцена.' }], 0,
      'Первая сцена.', ['Первая ', 'сцена.']],
    ['a tool', [{ ...init, tools: ['Bash'] }, chunk('no')], 0, { code: 'unexpected_tools' }, []],
    ['an incomplete stream', [init, chunk('unfinished')], 0, { code: 'provider_failed', cliResult: 'missing', exitCode: 0 }],
    ['a failed process after a success-looking result', [init, { type: 'result', subtype: 'success', result: 'text' }], 1, { code: 'provider_failed', cliResult: 'success', exitCode: 1 }],
    ['a refused structured output', [init, { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: 'PRIVATE' }], 0,
      { code: 'provider_failed', cliResult: 'error_max_structured_output_retries', cliError: true, exitCode: 0 }],
    ['an unknown result', [init, { type: 'result', subtype: 'PRIVATE', is_error: false, result: 'x' }], 0, { code: 'provider_failed', cliResult: 'other', cliError: false }],
    ['no result from a failed process', [init, chunk('scene')], 1, { code: 'provider_failed', cliResult: 'missing', exitCode: 1 }],
    // A run that hit its output cap: the CLI calls the result an error under the subtype `success`, and the row says why.
    ['the output cap', [init, chunk('PRIVATE'), { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' } } },
      { type: 'result', subtype: 'success', is_error: true, result: 'PRIVATE' }], 1, { code: 'provider_failed', cliResult: 'success', cliError: true, exitCode: 1, stopReason: 'max_tokens' }],
    ['an unknown stop reason', [init, { type: 'assistant', message: { stop_reason: 'PRIVATE' } }, { type: 'result', subtype: 'success', is_error: true, result: 'x' }], 1,
      { code: 'provider_failed', stopReason: 'other' }],
  ];
  for (const [label, events, exitCode, expected, previews] of runs) {
    const chunks: string[] = [];
    const generated = fixture(t, events, exitCode).provider.generate(request, { onText: async text => { chunks.push(text); } });
    if (typeof expected === 'string') assert.equal((await generated).text, expected, label);
    else await assert.rejects(generated, { ...expected, message: expected.code }, label);
    if (previews) assert.deepEqual(chunks, previews, label);
  }
});

test('configured CLI deadline terminates a stalled process and reports timeout; an abort of any kind terminates it as cancelled', async t => {
  const abortLater = (abort: (controller: AbortController) => void) => () => {
    const controller = new AbortController();
    setTimeout(() => abort(controller), 30);
    return controller.signal;
  };
  // The kinds of abort a caller passes down (local/abort.test.ts): the caller's own timeout is a cancellation here too.
  const stops: [string, number, (() => AbortSignal) | undefined, string][] = [
    ['the deadline', 80, undefined, 'timeout'],
    ['abort()', 5000, abortLater(c => c.abort()), 'cancelled'],
    ["abort(ModelError('cancelled'))", 5000, abortLater(c => c.abort(new ModelError('cancelled'))), 'cancelled'],
    ["abort(ModelError('background_preempted'))", 5000, abortLater(c => c.abort(new ModelError('background_preempted'))), 'cancelled'],
    ['AbortSignal.timeout', 5000, () => AbortSignal.timeout(30), 'cancelled'],
  ];
  for (const [label, timeoutMs, signal, code] of stops) {
    const directory = mkdtempSync(join(tmpdir(), 'simple-chat-cli-timeout-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let child: ReturnType<Launch> | undefined;
    const provider = createClaude({ dbPath: join(directory, 'test.sqlite'), model: 'test-model', contextTokens: 65536, timeoutMs }, { launch(_command, _args, options) {
      child = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'], options);
      return child;
    } });
    await assert.rejects(provider.generate(request, { signal: signal?.() }), { code }, label);
    assert.equal(child!.signalCode, 'SIGTERM', label);
  }
});

const start = (id: string, usage: object) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, usage } } });
const delta = (usage: object) => ({ type: 'stream_event', event: { type: 'message_delta', usage } });

test('usage includes cache once, ignores placeholder outputs and does not sum cumulative deltas; oversized context stops before invoking the model', async t => {
  const usage = { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 3 };
  const assistant = { type: 'assistant', message: { id: 'response-1', usage } };
  const success = (fields: object = {}) => ({ type: 'result', subtype: 'success', result: 'scene', ...fields });
  const large = (length: number): ModelRequest => ({ ...request, messages: [{ role: 'user', content: 'я'.repeat(length) }] });
  const full = '2026-08-02 20:00\n\nСильная лодка.\n\nСледующий абзац.';
  const runs: [string, object[], ModelRequest, GenerateControls, object][] = [
    ['cache once, placeholder outputs, cumulative deltas', [init, start('response-1', usage), assistant, assistant, chunk('scene'), delta({ output_tokens: 10 }),
      delta({ output_tokens: 40 }), success({ num_turns: 1, usage: { ...usage, output_tokens: 40 } })], request, {}, { usage: { inputTokens: 1100, outputTokens: 40, totalTokens: 1140 } }],
    // Usage is the last response's, not the total over the model's steps.
    ['two steps', [init, start('a', { input_tokens: 1000 }), delta({ output_tokens: 20 }), start('b', { input_tokens: 50, cache_read_input_tokens: 100 }), chunk('scene'),
      delta({ output_tokens: 30 }), success({ num_turns: 2, usage: { input_tokens: 1050, cache_read_input_tokens: 100, output_tokens: 50 } })], request, {},
      { usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 } }],
    ['no usage is unknown, not zero', [init, chunk('scene'), success()], request, {}, { usage: null }],
    ['a truncated terminal field keeps the streamed beginning', [init, chunk(full.slice(0, 29)), chunk(full.slice(29)), success({ result: 'ка.\n\nСледующий абзац.' })], request, {},
      { text: full, streamResultMismatch: true }],
    ['oversized context', [], large(140000), {}, { code: 'context_limit', launches: 0 }],
    ['large UTF-8 input whose observed count fits', [init, start('large', { input_tokens: 25000 }), chunk('scene'), delta({ output_tokens: 10 }), success()], large(40000), {},
      { text: 'scene' }],
    ['large UTF-8 input without usage', [init, chunk('no'), success({ result: 'no' })], large(40000), {}, { code: 'usage_unavailable', previews: 0 }],
    ['actual cached input over a low estimate', [init, start('large', { input_tokens: 1000, cache_read_input_tokens: 53000 }), chunk('must not appear')], request,
      { inputLimitTokens: 53999 }, { code: 'context_limit', previews: 0 }],
  ];
  for (const [label, events, input, controls, expected] of runs) {
    const f = fixture(t, events);
    let previews = 0;
    const outcome = await f.provider.generate(input, { ...controls, onText: async () => { previews++; } })
      .then(({ text, usage, streamResultMismatch }) => ({ text, usage, streamResultMismatch }), (error: ModelError) => ({ code: error.code }));
    assert.partialDeepStrictEqual({ ...outcome, previews, launches: f.launches() }, expected, label);
  }
});
