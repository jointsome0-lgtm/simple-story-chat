import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { emptyLibrary, addSeed, newStory, beginJob, commitTurn, active, context, history } from '../lib/library.ts';
import { seed, turns } from '../examples/dance-probe.ts';
import { checks } from '../examples/memory-checks.ts';
import { createScheduler } from './scheduler.ts';
import { serveBackground } from './background.ts';
import { ModelError } from './model-error.ts';
import type { ModelRequest } from './model.ts';
import type { ProbeNode } from './story-probe.ts';
import type { ReplayReport } from './memory-probe.ts';

// Memory and recall requests always carry a schema; its properties tell them apart.
type Schema = { properties: { answers?: object; evidence?: object } };
// Summary requests carry their scenes as JSON in the first message.
type SummaryInput = { newScenes: { id: string; input: string }[] };
// Probe progress lines; the tests read the event, the failure code and the report directory.
type Progress = { event?: string; code?: string; directory?: string };

// Frozen synthetic scenes of the dance scenario in a directory of their own, and the probe that replays them through the
// model socket of a bot whose database is `test.sqlite` there.
function replay(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-memory-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = emptyLibrary();
  newStory(state, addSeed(state, seed).id);
  for (const [i, input] of turns.entries()) {
    const job = beginJob(state, input, i);
    // The job was just begun, so the turn commits.
    const ref = commitTurn(state, job.id, '2026-09-01 10:00\n\n' + input + '\n' + 'Синтетическая сцена для проверки транспорта. '.repeat(100))!;
    (active(state).story.nodes[ref.nodeId] as ProbeNode).probeTurn = i + 1;
  }
  const source = join(directory, 'evidence.json');
  writeFileSync(source, JSON.stringify({ report: { scenario: 'dance' }, state }));
  async function run(resume?: string) {
    const child = spawn(process.execPath, [new URL('./memory-probe.ts', import.meta.url).pathname,
      '--source', source, '--minutes', '1', ...(resume ? ['--resume', resume] : [])], {
      cwd: directory, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TELEGRAM_BOT_TOKEN: '1:synthetic',
        SIMPLE_CHAT_ALLOWED_USER_IDS: '1', SIMPLE_CHAT_MODEL: 'synthetic-model', SIMPLE_CHAT_DB_PATH: 'test.sqlite' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    return { code, events: output.trim().split('\n').map((line): Progress => JSON.parse(line)) };
  }
  return { socketPath: join(directory, 'test.sqlite.model.sock'), run };
}

test('background probe resumes a failed synthetic step without repeating committed increments', async t => {
  const { socketPath, run } = replay(t);
  let calls = 0;
  const provider = { async generate(request: ModelRequest) {
    calls++;
    if (calls === 2) throw new ModelError('background_timeout');
    let data;
    if ((request.outputSchema as Schema).properties.answers) data = { answers: checks.dance.map(([key, , value]) => ({ key, value })) };
    else {
      const { newScenes }: SummaryInput = JSON.parse(request.messages[0].content);
      data = (request.outputSchema as Schema).properties.evidence
        ? { evidence: newScenes.map((n, i) => ({ id: `e${i + 1}`, scene: n.id, part: 'input', quote: n.input.slice(0, 40) })), conflicts: [],
          facts: newScenes.map((n, i) => ({ kind: 'event', at: '2026-09-01 10:00', status: 'actual', text: 'Синтетическая запись.', evidence: [`e${i + 1}`] })) }
        : { facts: newScenes.map(n => ({ kind: 'event', at: '2026-09-01 10:00', text: 'Синтетическая запись.', source: [n.id] })) };
    }
    return { text: JSON.stringify(data), finishReason: 'stop', usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 } };
  } };
  const scheduler = createScheduler(provider, { quietMs: 0 });
  const server = await serveBackground({ socketPath, scheduler,
    status: () => ({ model: 'synthetic-model', gpu: { status: 'ready' } }) });
  t.after(async () => { await server.close(); await scheduler.close(); });
  const first = await run();
  assert.equal(first.code, 1);
  assert.equal(first.events.at(-1)!.code, 'background_timeout');
  // The first event, `started`, names the report directory.
  const savedDirectory = first.events[0].directory!;
  t.after(() => rmSync(savedDirectory, { recursive: true, force: true }));
  const before: ReplayReport = JSON.parse(readFileSync(join(savedDirectory, 'report.json'), 'utf8'));
  // The plain mode failed after its first compaction.
  assert.equal(before.modes.plain!.compactions.length, 1);
  const second = await run(savedDirectory);
  assert.equal(second.code, 0);
  assert.equal(calls, 9);
  const after: ReplayReport = JSON.parse(readFileSync(join(savedDirectory, 'report.json'), 'utf8'));
  // A completed replay has both modes, each with its answers and saved state.
  assert.deepEqual(after.modes.plain!.compactions[0], before.modes.plain!.compactions[0]);
  for (const mode of ['plain', 'sgr'] as const) {
    const run = after.modes[mode]!;
    assert.deepEqual(run.compactions.map(c => c.afterTurn), [7, 11, 15]);
    assert.ok(run.answers!.every(a => a.pass));
    const { story, branch } = active(run.state!);
    assert.equal(context(story, branch).memories.length, 3);
    assert.equal(history(story, branch.head).length, turns.length);
  }
});

test('a probe ends gpu_paused at the first refusal from a card that pauses, instead of spending its retries at once', async t => {
  const { socketPath, run } = replay(t);
  // The owner pauses the card while the probe's first call runs. The queue stops that call, as the bot's does, and
  // would refuse every later one at once.
  let status = 'ready', calls = 0;
  const provider = { generate: (_request: ModelRequest, { signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    calls++;
    status = 'draining';
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const scheduler = createScheduler(provider, { quietMs: 0, pollMs: 10,
    backgroundAllowed: () => status === 'ready', backgroundCanWait: () => status === 'ready' });
  const server = await serveBackground({ socketPath, scheduler, status: () => ({ model: 'synthetic-model', gpu: { status } }) });
  t.after(async () => { await server.close(); await scheduler.close(); });
  const { code, events } = await run();
  t.after(() => rmSync(events[0].directory!, { recursive: true, force: true }));
  assert.equal(code, 1);
  assert.deepEqual(events.filter(e => e.event === 'yielded').map(e => e.code), ['background_unavailable']);
  assert.deepEqual([events.at(-1)!.event, events.at(-1)!.code, calls], ['deferred_or_failed', 'gpu_paused', 1]);
});
