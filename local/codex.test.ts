import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createCodex } from './codex.ts';
import { loadConfig, loadModelConfig } from './config.ts';
import type { ModelRequest } from './model.ts';

const request: ModelRequest = { system: 'synthetic system', messages: [{ role: 'user', content: 'synthetic private seed' }], maxOutputTokens: 256 };
const started = { type: 'thread.started', thread_id: 'synthetic' };
const message = (text: string) => ({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
const done = { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 30 } };
function fixture(t: TestContext, events: object[], exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-codex-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seen: { instructions?: string; schema?: string } = {};
  const provider = createCodex({ dbPath: join(directory, 'test.sqlite'), model: 'test-model', contextTokens: 65536 }, { launch(command, args, options) {
    assert.equal(command, 'codex');
    assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
    for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']) assert.ok(args.includes(flag));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('shell_tool') && args.includes('unified_exec') && args.includes('web_search="disabled"'));
    // Neither the story nor the system prompt travels in the argument list.
    assert.ok(!args.join(' ').includes('synthetic'));
    assert.equal(args.at(-1), '-');
    for (const key of ['TELEGRAM_BOT_TOKEN', 'OPENAI_API_KEY', 'SIMPLE_CHAT_MODEL']) assert.equal(options.env[key], undefined);
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

test('Codex: the last agent message is the scene, usage comes from the completed turn, nothing is left on disk', async t => {
  const f = fixture(t, [started, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'error', message: 'synthetic warning' } },
    { type: 'item.completed', item: { type: 'reasoning', text: 'synthetic thought' } }, message('Черновик.'), message('Первая сцена.'), done]);
  const chunks: string[] = [];
  const result = await f.provider.generate(request, { onText: async text => { chunks.push(text); } });
  assert.equal(result.text, 'Первая сцена.');
  assert.deepEqual(chunks, ['Первая сцена.']);
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 });
  assert.equal(f.seen.instructions, 'synthetic system');
  assert.deepEqual(readdirSync(f.directory), []);
});

test('Codex: a schema goes through a file', async t => {
  const f = fixture(t, [started, message('{"a":"b"}'), done]);
  const result = await f.provider.generate({ ...request, outputSchema: { type: 'object' } });
  assert.equal(result.text, '{"a":"b"}');
  assert.equal(f.seen.schema, '{"type":"object"}');
});

test('Codex: any tool item, a failed turn, a missing end, a bad exit and an empty answer are safe errors', async t => {
  const cases: [object[], number, string][] = [
    [[started, { type: 'item.started', item: { type: 'command_execution', command: 'synthetic' } }, message('x'), done], 0, 'unexpected_tools'],
    [[started, { type: 'item.completed', item: { type: 'mcp_tool_call' } }, message('x'), done], 0, 'unexpected_tools'],
    [[started, { type: 'error', message: 'synthetic private seed' }, { type: 'turn.failed', error: { message: 'synthetic private seed' } }], 0, 'provider_failed'],
    [[started, message('x')], 0, 'provider_failed'],
    [[started, message('x'), done], 1, 'provider_failed'],
    [[message('x'), done], 0, 'invalid_stream'],
    [[started, message('  '), done], 0, 'empty_response'],
    [[started, message('x'), { type: 'turn.completed', usage: { input_tokens: 70000, output_tokens: 1 } }], 0, 'context_limit'],
  ];
  for (const [events, exitCode, code] of cases) {
    const f = fixture(t, events, exitCode);
    await assert.rejects(f.provider.generate(request), (error: Error & { code?: string }) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('synthetic private seed'));
      return true;
    });
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test('configuration: Codex needs a model; the bot takes a hosted connection only after an explicit consent', () => {
  const bot = { TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1' };
  const codex = { SIMPLE_CHAT_PROVIDER: 'codex-cli', SIMPLE_CHAT_MODEL: 'test-model' };
  assert.equal(loadModelConfig('/nonexistent-simple-chat-config', codex).compactAtTokens, 54000);
  assert.throws(() => loadModelConfig('/nonexistent-simple-chat-config', { SIMPLE_CHAT_PROVIDER: 'codex-cli' }), /SIMPLE_CHAT_MODEL/);
  const hosted = { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: 'https://openrouter.ai/api/v1', SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_MODEL: 'test-model' };
  for (const env of [codex, hosted]) {
    assert.throws(() => loadConfig('/nonexistent-simple-chat-config', { ...bot, ...env }), /synthetic probes only/);
    assert.throws(() => loadConfig('/nonexistent-simple-chat-config', { ...bot, ...env, SIMPLE_CHAT_ALLOW_HOSTED: '1' }), /synthetic probes only/);
    assert.equal(loadConfig('/nonexistent-simple-chat-config', { ...bot, ...env, SIMPLE_CHAT_ALLOW_HOSTED: 'stories-leave-this-computer' }).provider, env.SIMPLE_CHAT_PROVIDER);
  }
});
