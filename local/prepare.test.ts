import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { GenerationConfig } from './generation.ts';
import { compactBranch, generateScene } from './generation.ts';
import { createPrepared } from './prepare.ts';
import type { Prepared } from './prepare.ts';
import { createScheduler } from './scheduler.ts';
import { makeRequest } from './prompt.ts';
import { requestBudget } from './context.ts';
import { safeErrorDetails } from './model-error.ts';
import type { ErrorDetails, Log } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { addSeed, newStory, beginJob, commitTurn } from '../lib/library.ts';

// Summary requests carry their scenes as JSON in the first message.
type SummaryInput = { newScenes: { id: string }[] };
const turn = () => new Promise(resolve => setImmediate(resolve));
const isExtraction = (request: ModelRequest) => request.system.startsWith('Извлеки');
const other = { system: 'Синтетика', messages: [{ role: 'user' as const, content: 'Синтетика' }], maxOutputTokens: 16 };

// Seven synthetic scenes; the threshold is the size of the next scene request, so the next turn compacts three.
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.mutate('1', state => {
    newStory(state, addSeed(state, 'Маяк\n2026-08-02 20:00\nСинтетический смотритель бережёт маяк.').id);
    for (let i = 0; i < 7; i++) commitTurn(state, beginJob(state, `Синтетический ввод ${i}.`, i).id, `2026-08-02 20:00\n\nИсходная сцена ${i}: ${'ветер '.repeat(300)}`);
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
  // The rows of the turns and of the prepared runs, as main.ts writes them.
  const rows: ({ event: string; code?: string | number } & ErrorDetails)[] = [];
  const log: Log = (event, code, details) => { rows.push({ event, code, ...safeErrorDetails(details) }); };
  const outcomes = () => rows.filter(row => row.event === 'compaction_prepare_outcome').map(row => row.code);
  const run = (prepared: Prepared, model = provider) => prepared.run(store.read('1'), model, config, { log });
  const scene = (prepared: Prepared, model: Provider = provider) => {
    const job = store.mutate('1', state => beginJob(state, 'НОВОЕ ДЕЙСТВИЕ, не включать в память.', 20));
    return generateScene({ store, userId: '1', jobId: job.id, provider: model, config, prepared, log });
  };
  return { store, config, calls, provider, summary, rows, log, outcomes, run, scene, setAnswer: (next: typeof answer) => { answer = next; } };
}
// A shared model whose every call waits until the test lets it go, so the order in the model slot is visible.
function held(t: TestContext, provider: Provider) {
  const releases: (() => void)[] = [];
  const scheduler = createScheduler({ async generate(request: ModelRequest, controls: GenerateControls) {
    await new Promise<void>(resolve => releases.push(resolve));
    return provider.generate(request, controls);
  } }, { quietMs: 0, pollMs: 100000 });
  t.after(() => scheduler.close());
  return { model: scheduler.foreground, releases };
}

test('a compaction prepared while the person reads is saved by the next turn without asking the model again', async t => {
  // A first extraction that misses the first scene is followed by a prepared supplement that covers it.
  for (const [label, missed] of [['the extraction', 0], ['a supplement for missed scenes', 1]] as const) {
    const f = fixture(t);
    const skip = (request: ModelRequest) => request.messages[0].content.includes('draftFacts') ? 0 : missed;
    f.setAnswer(request => ({ ...f.summary(request, skip(request)), timings: { promptMs: 40, predictedMs: 60 } }));
    const prepared = createPrepared();
    await f.run(prepared);
    assert.equal(f.calls.length, 1 + missed, label);
    await f.scene(prepared);
    // The turn asked only for its scene.
    assert.deepEqual(f.calls.map(call => isExtraction(call.request)), [true, ...missed ? [true] : [], false], label);
    const story = Object.values(f.store.read('1').stories)[0];
    const memory = story.memories[Object.values(story.branches)[0].memory!];
    assert.deepEqual(memory.covered, (JSON.parse(f.calls[0].request.messages[0].content) as SummaryInput).newScenes.map(n => n.id), label);
    assert.equal(f.rows.filter(row => row.event === 'compaction_request_prepared').length, 1 + missed, label);
    assert.ok(!f.rows.some(row => row.event === 'compaction_request_completed'), label);
    // Each prepared request wrote its own row with its timings, and the run one row with what became of it.
    assert.deepEqual(f.rows.filter(row => row.event === 'compaction_prepare_request_completed').map(row => [row.promptMs, row.predictedMs]),
      Array(1 + missed).fill([40, 60]), label);
    assert.deepEqual(f.outcomes(), ['used'], label);
  }
});

test('a prepared result that fails its check, or one for another branch point, is not used', async t => {
  const rows: [string, (f: ReturnType<typeof fixture>, prepared: Prepared) => Promise<unknown>, boolean[], number, string[]][] = [
    ['an answer that fails its check', async (f, prepared) => {
      f.setAnswer(() => ({ text: 'not json', finishReason: 'stop' })); await f.run(prepared);
      f.setAnswer(request => f.summary(request)); await f.scene(prepared);
    }, [true, true, false], 0, ['asked_again']],
    ['a run for another branch point', async (f, prepared) => {
      await f.run(prepared);
      // A new scene moves the branch head before the turn.
      f.store.mutate('1', state => { commitTurn(state, beginJob(state, 'Ещё один синтетический ввод.', 15).id, `2026-08-02 20:00\n\nЕщё сцена: ${'ветер '.repeat(300)}`); });
      await f.scene(prepared);
    }, [true, true, false], 0, ['discarded']],
    // Stopping a run after a turn took it adds nothing.
    ['a run replaced by the next before any turn took it', async (f, prepared) => {
      await f.run(prepared); await f.run(prepared); await f.scene(prepared); prepared.stop();
    }, [true, true, false], 1, ['discarded', 'used']],
    ['an invalid answer still in flight when a manual compaction takes it', async (f, prepared) => {
      let invalid = true;
      const { model, releases } = held(t, { async generate(request, controls) {
        if (invalid) { invalid = false; return { text: 'not json', finishReason: 'stop' }; }
        return f.provider.generate(request, controls);
      } });
      const run = prepared.run(f.store.read('1'), model, f.config, { holder: '1', log: f.log });
      while (!releases.length) await turn();
      const job = f.store.mutate('1', state => { const job = beginJob(state, '', 20); job.kind = 'compact'; return job; });
      const compaction = compactBranch({ store: f.store, userId: '1', jobId: job.id, provider: model, config: f.config, prepared, log: f.log });
      await turn(); releases.shift()!(); await run;
      while (releases.length) { releases.shift()!(); await turn(); }
      assert.ok(await compaction);
    }, [true], 0, ['asked_again']],
  ];
  for (const [label, act, extractions, taken, outcomes] of rows) {
    const f = fixture(t);
    await act(f, createPrepared());
    // The calls that reached the model: a result the turn could not use was asked again, live.
    assert.deepEqual(f.calls.map(call => isExtraction(call.request)), extractions, label);
    assert.equal(f.rows.filter(row => row.event === 'compaction_request_prepared').length, taken, label);
    assert.deepEqual(f.outcomes(), outcomes, label);
    // Each run writes its request row and its one outcome under its own number.
    const numbers = f.rows.flatMap(row => row.prepareRun ?? []);
    assert.deepEqual(numbers.map(number => number - numbers[0]), outcomes.flatMap((_, run) => [run, run]), label);
  }
});

test('a run still waiting for the model is stopped by the turn it would block; a started one is awaited', async t => {
  // Someone else holds the slot, so the run waits in the queue; the turn arrives and stops it.
  const f = fixture(t);
  const queued = held(t, f.provider);
  const first = queued.model.generate(other);
  const waiting = createPrepared();
  const run = f.run(waiting, queued.model);
  const scene = f.scene(waiting, queued.model);
  await turn(); queued.releases.shift()!(); await first;
  while (!(await Promise.race([run.then(() => true), turn().then(() => false)]))) await turn();
  // Only the turn's own calls reach the model now: its live extraction, then its scene.
  while (queued.releases.length) { queued.releases.shift()!(); await turn(); await turn(); }
  await scene;
  assert.ok(!f.rows.some(row => row.event === 'compaction_request_prepared'));
  assert.deepEqual(f.outcomes(), ['unstarted']);
  // A started run keeps the slot; the next turn waits for it and takes its result.
  const g = fixture(t);
  const busy = held(t, g.provider);
  const started = createPrepared();
  const running = g.run(started, busy.model);
  while (!busy.releases.length) await turn();
  const next = g.scene(started, busy.model);
  await turn(); busy.releases.shift()!(); await running;
  while (busy.releases.length || !(await Promise.race([next.then(() => true), turn().then(() => false)]))) { busy.releases.shift()?.(); await turn(); }
  await next;
  assert.ok(g.rows.some(row => row.event === 'compaction_request_prepared'));
  assert.equal(g.calls.filter(call => isExtraction(call.request)).length, 1);
  assert.deepEqual(g.outcomes(), ['used']);
  // A scene's token count waits behind another call: the queue goes to the row's `waitMs`, only the count to `countMs`.
  t.mock.timers.enable({ apis: ['Date'] });
  const h = fixture(t);
  let release = (): void => assert.fail('the other call did not start');
  const scheduler = createScheduler({ countInput: async () => 10, async generate(request: ModelRequest, controls: GenerateControls) {
    if (request === other) await new Promise<void>(resolve => { release = resolve; });
    return h.provider.generate(request, controls);
  } }, { quietMs: 0, pollMs: 100000 });
  t.after(() => scheduler.close());
  const ahead = scheduler.foreground.generate(other);
  const counted = h.scene(createPrepared(), scheduler.foreground);
  await turn(); t.mock.timers.tick(60); release(); await ahead; await counted;
  const row = h.rows.find(one => one.event === 'scene_request_completed')!;
  assert.deepEqual([row.waitMs, row.countMs], [60, 0], 'a scene row separates the queue from the token count');
});
