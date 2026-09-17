import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { emptyLibrary, addSeed, newStory, beginJob, commitTurn, active, context, history } from '../lib/library.js';
import { seed, turns } from '../examples/dance-probe.mjs';
import { checks } from '../examples/memory-checks.mjs';
import { createScheduler } from './scheduler.mjs';
import { serveBackground } from './background.mjs';
import { ModelError } from './model-error.mjs';

test('background probe resumes a failed synthetic step without repeating committed increments', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-memory-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = emptyLibrary();
  newStory(state, addSeed(state, seed).id);
  for (const [i, input] of turns.entries()) {
    const job = beginJob(state, input, i);
    const ref = commitTurn(state, job.id, '2026-09-01 10:00\n\n' + input + '\n' + 'Синтетическая сцена для проверки транспорта. '.repeat(100));
    active(state).story.nodes[ref.nodeId].probeTurn = i + 1;
  }
  const source = join(directory, 'evidence.json');
  writeFileSync(source, JSON.stringify({ report: { scenario: 'dance' }, state }));
  let calls = 0;
  const provider = { async generate(request) {
    calls++;
    if (calls === 2) throw new ModelError('background_timeout');
    let data;
    if (request.outputSchema.properties.answers) data = { answers: checks.dance.map(([key, , value]) => ({ key, value })) };
    else {
      const { newScenes } = JSON.parse(request.messages[0].content);
      data = request.outputSchema.properties.evidence
        ? { evidence: newScenes.map((n, i) => ({ id: `e${i + 1}`, scene: n.id, part: 'input', quote: n.input.slice(0, 40) })), conflicts: [],
          facts: newScenes.map((n, i) => ({ kind: 'event', at: '2026-09-01 10:00', status: 'actual', text: 'Синтетическая запись.', evidence: [`e${i + 1}`] })) }
        : { facts: newScenes.map(n => ({ kind: 'event', at: '2026-09-01 10:00', text: 'Синтетическая запись.', source: [n.id] })) };
    }
    return { text: JSON.stringify(data), finishReason: 'stop', usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 } };
  } };
  const scheduler = createScheduler(provider, { quietMs: 0 });
  const server = await serveBackground({ socketPath: join(directory, 'test.sqlite.model.sock'), scheduler,
    status: () => ({ model: 'synthetic-model', gpu: { status: 'ready' } }) });
  t.after(async () => { await server.close(); await scheduler.close(); });
  async function run(resume) {
    const child = spawn(process.execPath, [new URL('./memory-probe.mjs', import.meta.url).pathname,
      '--source', source, '--minutes', '1', ...(resume ? ['--resume', resume] : [])], {
      cwd: directory, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TELEGRAM_BOT_TOKEN: '1:synthetic',
        SIMPLE_CHAT_ALLOWED_USER_IDS: '1', SIMPLE_CHAT_MODEL: 'synthetic-model', SIMPLE_CHAT_DB_PATH: 'test.sqlite' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    return { code, events: output.trim().split('\n').map(line => JSON.parse(line)) };
  }
  const first = await run();
  assert.equal(first.code, 1);
  assert.equal(first.events.at(-1).code, 'background_timeout');
  const savedDirectory = first.events[0].directory;
  t.after(() => rmSync(savedDirectory, { recursive: true, force: true }));
  const before = JSON.parse(readFileSync(join(savedDirectory, 'report.json'), 'utf8'));
  assert.equal(before.modes.plain.compactions.length, 1);
  const second = await run(savedDirectory);
  assert.equal(second.code, 0);
  assert.equal(calls, 9);
  const after = JSON.parse(readFileSync(join(savedDirectory, 'report.json'), 'utf8'));
  assert.deepEqual(after.modes.plain.compactions[0], before.modes.plain.compactions[0]);
  for (const mode of ['plain', 'sgr']) {
    const run = after.modes[mode];
    assert.deepEqual(run.compactions.map(c => c.afterTurn), [7, 11, 15]);
    assert.ok(run.answers.every(a => a.pass));
    const { story, branch } = active(run.state);
    assert.equal(context(story, branch).memories.length, 3);
    assert.equal(history(story, branch.head).length, turns.length);
  }
});
