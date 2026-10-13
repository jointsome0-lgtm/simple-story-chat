import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCodex } from './codex.ts';
import { loadConfig, loadModelConfig } from './config.ts';
import type { Env } from './config.ts';
import type { ModelRequest } from './model.ts';

const request: ModelRequest = { system: 'synthetic system', messages: [{ role: 'user', content: 'synthetic private seed' }], maxOutputTokens: 256 };
const started = { type: 'thread.started', thread_id: 'synthetic' };
const message = (text: string) => ({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
const done = { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30 } };
function fixture(t: TestContext, events: object[], exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-codex-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seen: { instructions?: string; schema?: string } = {};
  // The provider must not pass another address or key on to the CLI.
  process.env.OPENAI_BASE_URL = 'http://elsewhere.invalid';
  t.after(() => { delete process.env.OPENAI_BASE_URL; });
  const provider = createCodex({ dbPath: join(directory, 'test.sqlite'), model: 'test-model', contextTokens: 65536 }, { launch(command, args, options) {
    assert.equal(command, 'codex');
    assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
    for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('shell_tool') && args.includes('unified_exec') && args.includes('web_search="disabled"'));
    // Neither the story nor the system prompt travels in the argument list.
    assert.ok(!args.join(' ').includes('synthetic'));
    assert.equal(args.at(-1), '-');
    for (const key of ['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SIMPLE_CHAT_MODEL']) assert.equal(options.env[key], undefined);
    assert.deepEqual(readdirSync(options.cwd), []);
    const file = (args.find(arg => arg.startsWith('model_instructions_file=')) ?? '').slice('model_instructions_file='.length);
    seen.instructions = readFileSync(JSON.parse(file), 'utf8');
    assert.equal(dirname(JSON.parse(file)), dirname(options.cwd));
    if (args.includes('--output-schema')) seen.schema = readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8');
    const output = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    return spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(' + JSON.stringify(output) + '); process.exitCode=' + exitCode + '; });'], options);
  } });
  return { provider, seen, directory };
}

test('Codex: the last agent message is the scene, usage comes from the completed turn, a schema goes through a file, nothing is left on disk', async t => {
  const runs: [string, object[], Partial<ModelRequest>, string, string | undefined][] = [
    ['a scene after a warning, reasoning and a draft', [started, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'error', message: 'synthetic warning' } },
      { type: 'item.completed', item: { type: 'reasoning', text: 'synthetic thought' } }, message('Черновик.'), message('Первая сцена.'), done], {}, 'Первая сцена.', undefined],
    ['a structured answer', [started, message('{"a":"b"}'), done], { outputSchema: { type: 'object' } }, '{"a":"b"}', '{"type":"object"}'],
  ];
  for (const [label, events, extra, text, schema] of runs) {
    const f = fixture(t, events);
    const chunks: string[] = [];
    const result = await f.provider.generate({ ...request, ...extra }, { onText: async chunk => { chunks.push(chunk); } });
    assert.deepEqual({ text: result.text, chunks, usage: result.usage, instructions: f.seen.instructions, schema: f.seen.schema },
      { text, chunks: [text], usage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 }, instructions: 'synthetic system', schema }, label);
    assert.deepEqual(readdirSync(f.directory), [], label);
  }
});

test('Codex: any tool item, a failed turn, a missing end, a bad exit and an empty answer are safe errors', async t => {
  const cases: [string, object[], number, string][] = [
    ['a command', [started, { type: 'item.started', item: { type: 'command_execution', command: 'synthetic' } }, message('x'), done], 0, 'unexpected_tools'],
    ['an MCP call', [started, { type: 'item.completed', item: { type: 'mcp_tool_call' } }, message('x'), done], 0, 'unexpected_tools'],
    ['a failed turn', [started, { type: 'error', message: 'synthetic private seed' }, { type: 'turn.failed', error: { message: 'synthetic private seed' } }], 0, 'provider_failed'],
    ['no end of the turn', [started, message('x')], 0, 'provider_failed'], ['a bad exit', [started, message('x'), done], 1, 'provider_failed'],
    ['no thread', [message('x'), done], 0, 'invalid_stream'], ['a blank answer', [started, message('  '), done], 0, 'empty_response'],
    ['a counted input over the limit', [started, message('x'), { type: 'turn.completed', usage: { input_tokens: 70000, output_tokens: 1 } }], 0, 'context_limit'],
  ];
  for (const [label, events, exitCode, code] of cases) {
    const f = fixture(t, events, exitCode);
    await assert.rejects(f.provider.generate(request),
      (error: Error & { code?: string }) => error.code === code && !error.message.includes('synthetic private seed'), label);
    assert.deepEqual(readdirSync(f.directory), [], label);
  }
});

test('configuration: Codex needs a model; the bot takes a hosted connection only after an explicit consent', () => {
  const codex = { SIMPLE_CHAT_PROVIDER: 'codex-cli', SIMPLE_CHAT_MODEL: 'test-model' };
  const hosted = { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: 'https://openrouter.ai/api/v1/', SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_MODEL: 'test-model' };
  // What a probe loads. A hosted API root is HTTPS, with no credentials or query in it, and it keeps its path.
  const probes: [string, Env, RegExp | { baseUrl: string | undefined; compactAtTokens: number }][] = [
    ['Codex', codex, { baseUrl: undefined, compactAtTokens: 54000 }],
    ['Codex without a model', { SIMPLE_CHAT_PROVIDER: 'codex-cli' }, /SIMPLE_CHAT_MODEL/],
    ['a hosted API', hosted, { baseUrl: 'https://openrouter.ai/api/v1', compactAtTokens: 44000 }],
    ['a hosted API without a key', { ...hosted, SIMPLE_CHAT_API_KEY: '' }, /SIMPLE_CHAT_API_KEY/],
    ['a hosted API without a model', { ...hosted, SIMPLE_CHAT_MODEL: '' }, /SIMPLE_CHAT_MODEL/],
    ...[undefined, 'http://openrouter.ai/api/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=1']
      .map((url): [string, Env, RegExp] => [`a hosted API at ${url}`, { ...hosted, SIMPLE_CHAT_BASE_URL: url }, /SIMPLE_CHAT_BASE_URL/]),
  ];
  for (const [label, env, expected] of probes) {
    const load = () => loadModelConfig('/nonexistent-simple-chat-config', env);
    if (expected instanceof RegExp) assert.throws(load, expected, label);
    else { const { baseUrl, compactAtTokens } = load(); assert.deepEqual({ baseUrl, compactAtTokens }, expected, label); }
  }
  for (const env of [codex, hosted].map(env => ({ TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1', ...env }))) {
    for (const allow of [undefined, '1']) assert.throws(() => loadConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_ALLOW_HOSTED: allow }), /synthetic probes only/, env.SIMPLE_CHAT_PROVIDER);
    assert.equal(loadConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_ALLOW_HOSTED: 'stories-leave-this-computer' }).provider, env.SIMPLE_CHAT_PROVIDER);
  }
});
