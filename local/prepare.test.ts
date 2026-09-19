import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { GenerationConfig } from './generation.ts';
import { generateScene } from './generation.ts';
import { createPrepared } from './prepare.ts';
import { createScheduler } from './scheduler.ts';
import { makeRequest } from './prompt.ts';
import { requestBudget } from './context.ts';
import { safeErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { addSeed, newStory, beginJob, commitTurn } from '../lib/library.ts';

// Summary requests carry their scenes as JSON in the first message.
type SummaryInput = { newScenes: { id: string }[] };
const turn = () => new Promise(resolve => setImmediate(resolve));
const isExtraction = (request: ModelRequest) => request.system.startsWith('Извлеки');

// Seven synthetic scenes; the threshold is the size of the next scene request, so the next turn compacts three.
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.mutate('1', state => {
    const seed = addSeed(state, 'Маяк\n2026-08-02 20:00\nСинтетический смотритель бережёт маяк.');
    newStory(state, seed.id);
    for (let i = 0; i < 7; i++) {
      const job = beginJob(state, `Синтетический ввод ${i}.`, i);
      commitTurn(state, job.id, `2026-08-02 20:00\n\nИсходная сцена ${i}: ${'ветер '.repeat(300)}`);
    }
  });
  const config: GenerationConfig = { contextTokens: 65536, maxOutputTokens: 4096, model: 'test-model', keepScenes: 4, repairCoverage: true };
  const probe = store.mutate('1', state => beginJob(state, 'Синтетическое действие.', 10));
  config.compactAtTokens = requestBudget(makeRequest(store.read('1'), probe, config.maxOutputTokens), config.contextTokens).inputTokens;
  store.mutate('1', state => { state.job = null; });
  const calls: { request: ModelRequest; controls?: GenerateControls }[] = [];
  // Facts for the listed scenes of a request, or for all of them.
  const summary = (request: ModelRequest, skip = 0): GenerationResult => {
    const data: SummaryInput = JSON.parse(request.messages[0].content);
    return { text: JSON.stringify({ facts: data.newScenes.slice(skip).map(n => ({ kind: 'event', at: '2026-08-02 20:00', text: 'На острове дул ветер.', source: [n.id] })) }), finishReason: 'stop' };
  };
  let answer = (request: ModelRequest) => summary(request);
  const provider: Provider = { async generate(request, controls) {
    calls.push({ request, controls });
    if (isExtraction(request)) return answer(request);
    return { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop', usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } };
  } };
  const rows: { event: string }[] = [];
  const scene = (prepared: ReturnType<typeof createPrepared>, model: Provider = provider) => {
    const job = store.mutate('1', state => beginJob(state, 'НОВОЕ ДЕЙСТВИЕ, не включать в память.', 20));
    return generateScene({ store, userId: '1', jobId: job.id, provider: model, config, prepared,
      log: (event, code, details) => { rows.push({ event, ...safeErrorDetails(details) }); } });
  };
  return { store, config, calls, provider, summary, rows, scene, setAnswer: (next: typeof answer) => { answer = next; } };
}

test('a compaction prepared while the person reads is saved by the next turn without asking the model again', async t => {
  const f = fixture(t);
  const prepared = createPrepared();
  await prepared.run(f.store.read('1'), f.provider, f.config);
  assert.equal(f.calls.length, 1);
  const extraction = f.calls[0].request;
  await f.scene(prepared);
  // The turn asked only for its scene.
  assert.deepEqual(f.calls.map(call => isExtraction(call.request)), [true, false]);
  const state = f.store.read('1');
  const story = Object.values(state.stories)[0];
  const branch = Object.values(story.branches)[0];
  const memory = story.memories[branch.memory!];
  assert.deepEqual(memory.covered, (JSON.parse(extraction.messages[0].content) as SummaryInput).newScenes.map(n => n.id));
  assert.ok(f.rows.some(row => row.event === 'compaction_request_prepared'));
  assert.ok(!f.rows.some(row => row.event === 'compaction_request_completed'));
});

test('a prepared supplement for missed scenes is taken too', async t => {
  const f = fixture(t);
  // The first extraction misses the first scene; the supplement covers it.
  f.setAnswer(request => f.summary(request, request.messages[0].content.includes('draftFacts') ? 0 : 1));
  const prepared = createPrepared();
  await prepared.run(f.store.read('1'), f.provider, f.config);
  assert.equal(f.calls.length, 2);
  await f.scene(prepared);
  assert.deepEqual(f.calls.map(call => isExtraction(call.request)), [true, true, false]);
  assert.equal(f.rows.filter(row => row.event === 'compaction_request_prepared').length, 2);
});

test('a prepared result that fails its check, or one for another branch point, is not used', async t => {
  const f = fixture(t);
  f.setAnswer(() => ({ text: 'not json', finishReason: 'stop' }));
  const prepared = createPrepared();
  await prepared.run(f.store.read('1'), f.provider, f.config);
  f.setAnswer(request => f.summary(request));
  await f.scene(prepared);
  // The dropped result was asked again.
  assert.deepEqual(f.calls.map(call => isExtraction(call.request)), [true, true, false]);

  const g = fixture(t);
  const other = createPrepared();
  await other.run(g.store.read('1'), g.provider, g.config);
  // A new scene moves the branch head before the turn.
  g.store.mutate('1', state => {
    const job = beginJob(state, 'Ещё один синтетический ввод.', 15);
    commitTurn(state, job.id, `2026-08-02 20:00\n\nЕщё сцена: ${'ветер '.repeat(300)}`);
  });
  await g.scene(other);
  assert.deepEqual(g.calls.map(call => isExtraction(call.request)), [true, true, false]);
  assert.ok(!g.rows.some(row => row.event === 'compaction_request_prepared'));
});

test('a run still waiting for the model is stopped by the turn it would block; a started one is awaited', async t => {
  const releases: (() => void)[] = [];
  // Every call waits until the test lets it go, so the order in the model slot is visible.
  const shared = (provider: Provider) => {
    const scheduler = createScheduler({ async generate(request: ModelRequest, controls: GenerateControls) {
      await new Promise<void>(resolve => releases.push(resolve));
      return provider.generate(request, controls);
    } }, { quietMs: 0, pollMs: 100000 });
    t.after(() => scheduler.close());
    return scheduler.foreground;
  };
  const f = fixture(t);
  let model = shared(f.provider);

  // Someone else holds the slot, so the run waits in the queue; the turn arrives and stops it.
  const other = model.generate({ system: 'Синтетика', messages: [{ role: 'user', content: 'Синтетика' }], maxOutputTokens: 16 });
  const waiting = createPrepared();
  const run = waiting.run(f.store.read('1'), model, f.config);
  const scene = f.scene(waiting, model);
  await turn();
  releases.shift()!(); await other;
  while (!(await Promise.race([run.then(() => true), turn().then(() => false)]))) await turn();
  // Only the turn's own calls reach the model now: its live extraction, then its scene.
  while (releases.length) { releases.shift()!(); await turn(); await turn(); }
  await scene;
  assert.ok(!f.rows.some(row => row.event === 'compaction_request_prepared'));

  // A started run keeps the slot; the next turn waits for it and takes its result.
  const g = fixture(t);
  model = shared(g.provider);
  const started = createPrepared();
  const running = started.run(g.store.read('1'), model, g.config);
  while (!releases.length) await turn();
  const next = g.scene(started, model);
  await turn();
  releases.shift()!(); await running;
  while (releases.length || !(await Promise.race([next.then(() => true), turn().then(() => false)]))) {
    releases.shift()?.(); await turn();
  }
  await next;
  assert.ok(g.rows.some(row => row.event === 'compaction_request_prepared'));
  assert.equal(g.calls.filter(call => isExtraction(call.request)).length, 1);
});
