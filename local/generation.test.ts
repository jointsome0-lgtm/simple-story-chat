import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { GenerationConfig } from './generation.ts';
import { generateScene, compactBranch } from './generation.ts';
import { ModelError } from './claude.ts';
import { makeRequest } from './prompt.ts';
import { requestBudget } from './context.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import type { Checkpoint } from '../lib/library.ts';
import { addSeed, newStory, beginJob, commitTurn, context, fork, deleteSeed } from '../lib/library.ts';

// Summary requests carry their scenes as JSON in the first message; these are the fields the tests read.
type SummaryInput = { newScenes: { id: string }[]; precedingScenes: { id: string }[]; draftFacts: unknown[] };
type Summary = { facts: { source: string[]; text: string }[] };
type MemorySchema = { properties: { facts: { maxItems: number; items: { properties: { source: { items: { enum: string[] } } } } } } };

function fixture(t: TestContext, count = 7) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.mutate('1', state => {
    const seed = addSeed(state, 'Маяк\n2026-08-02 20:00\nСинтетический смотритель бережёт маяк.');
    newStory(state, seed.id);
    for (let i = 0; i < count; i++) {
      const job = beginJob(state, `Синтетический ввод ${i}.`, i);
      commitTurn(state, job.id, `2026-08-02 20:00\n\nИсходная сцена ${i}: ${'ветер '.repeat(300)}`);
    }
    return beginJob(state, 'НОВОЕ ДЕЙСТВИЕ, не включать в память.', 10);
  });
  const config: GenerationConfig = { contextTokens: 65536, maxOutputTokens: 4096, model: 'test-model', keepScenes: 4, repairCoverage: true };
  config.compactAtTokens = requestBudget(makeRequest(store.read('1'), job, config.maxOutputTokens), config.contextTokens).inputTokens;
  const controller = new AbortController();
  const calls: { request: ModelRequest; controls: GenerateControls | undefined }[] = [];
  const summary = (request: ModelRequest): GenerationResult => {
    const data: SummaryInput = JSON.parse(request.messages[0].content);
    return { text: JSON.stringify({ facts: data.newScenes.map(n => ({ kind: 'event', at: '2026-08-02 20:00', text: 'На острове дул ветер.', source: [n.id] })) }), finishReason: 'stop' };
  };
  const provider: Provider = { async generate(request, controls) {
    calls.push({ request, controls });
    if (request.system.startsWith('Извлеки')) return summary(request);
    await controls!.onText?.('2026-08-02 20:00\n\nНовая сцена.');
    return { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop', usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } };
  } };
  const run = () => generateScene({ store, userId: '1', jobId: job.id, provider, config, signal: controller.signal });
  return { store, job, config, controller, calls, provider, summary, run };
}

test('compaction at the threshold keeps four recent scenes and both reversible checkpoints', async t => {
  const f = fixture(t);
  const before = f.store.read('1');
  const originals = before.stories[f.job.storyId].nodes;
  const result = await f.run();
  assert.match(result.result.text, /Новая сцена/);
  assert.equal(f.calls.length, 2);
  const summaryData: SummaryInput = JSON.parse(f.calls[0].request.messages[0].content);
  assert.equal(summaryData.newScenes.length, 3);
  assert.deepEqual((f.calls[0].request.outputSchema as MemorySchema).properties.facts.items.properties.source.items.enum,
    summaryData.newScenes.map(node => node.id));
  assert.doesNotMatch(f.calls[0].request.messages[0].content, /НОВОЕ ДЕЙСТВИЕ/);
  const state = f.store.read('1');
  const story = state.stories[f.job.storyId];
  assert.deepEqual(story.nodes, originals);
  const restored = context(story, story.branches[f.job.branchId]);
  assert.equal(restored.recent.length, 4);
  assert.equal(restored.memories.length, 1);
  assert.match(JSON.stringify(f.calls[1].request.messages), /НОВОЕ ДЕЙСТВИЕ/);
  assert.doesNotMatch(JSON.stringify(f.calls[1].request.messages), /Исходная сцена 0/);
  const pre = Object.values(story.checkpoints).find(cp => cp.kind === 'pre-compaction')!;
  const post = Object.values(story.checkpoints).find(cp => cp.kind === 'compaction')!;
  assert.equal(context(story, pre).recent.length, 7);
  assert.equal(context(story, post).recent.length, 4);
  state.job = null;
  const a = fork(state, story.id, pre.id);
  const b = fork(state, story.id, post.id);
  assert.equal(context(story, a).memories.length, 0);
  assert.equal(context(story, b).memories.length, 1);
});

test('server token counts decide compaction even when the byte estimate disagrees', async t => {
  for (const needsCompaction of [false, true]) {
    const f = fixture(t);
    f.config.compactAtTokens = needsCompaction ? 54000 : f.config.compactAtTokens;
    let counts = 0;
    f.provider.countInput = async () => (++counts === 1 && needsCompaction ? 54000 : 1000);
    await f.run();
    const story = f.store.read('1').stories[f.job.storyId];
    assert.equal(Object.keys(story.memories).length, needsCompaction ? 1 : 0);
    assert.equal(f.calls.length, needsCompaction ? 2 : 1);
    assert.equal(f.calls.at(-1)!.request.estimatedInputTokens, 1000);
  }
});

test('a second compaction appends only new facts and leaves older checkpoints unchanged', async t => {
  const f = fixture(t);
  const first = await f.run();
  let checkpoint: Checkpoint | undefined;
  f.store.mutate('1', state => {
    const story = state.stories[f.job.storyId];
    checkpoint = Object.values(story.checkpoints).find(cp => cp.kind === 'compaction');
    commitTurn(state, f.job.id, first.result.text);
    for (let i = 0; i < 3; i++) {
      const next = beginJob(state, `Новое событие ${i}`, i);
      commitTurn(state, next.id, `2026-08-03 20:00\n\n${'Синтетический дождь. '.repeat(100)}`);
    }
    Object.assign(f.job, beginJob(state, 'Дальше.', 20));
  });
  await f.run();
  const story = f.store.read('1').stories[f.job.storyId];
  const chain = context(story, story.branches[f.job.branchId]).memories;
  assert.equal(chain.length, 2);
  assert.equal(chain[1].parent, chain[0].id);
  assert.ok(chain[1].covered.every(id => !chain[0].covered.includes(id)));
  assert.equal(context(story, checkpoint!).memories.length, 1);
});

test('a live token limit can initiate compaction when the preflight estimate was below 54k', async t => {
  const f = fixture(t);
  f.config.compactAtTokens = 54000;
  const original = f.provider.generate;
  let first = true;
  f.provider.generate = async (request, controls) => {
    if (first) {
      first = false;
      assert.equal(controls!.inputLimitTokens, 53999);
      throw new ModelError('context_limit');
    }
    return original(request, controls);
  };
  await f.run();
  assert.equal(Object.keys(f.store.read('1').stories[f.job.storyId].memories).length, 1);
});

test('invalid, ungrounded, incomplete or truncated summaries never replace original context', async t => {
  for (const type of ['json', 'source', 'missing-scene', 'truncated', 'growth']) {
    const f = fixture(t);
    const before = f.store.read('1');
    f.provider.generate = async request => {
      const result = f.summary(request);
      const data: Summary = JSON.parse(result.text);
      if (type === 'json') result.text = 'invalid';
      if (type === 'source') data.facts[0].source = ['n999999'];
      if (type === 'missing-scene') data.facts.pop();
      if (type === 'truncated') result.finishReason = 'length';
      if (type === 'growth') data.facts.forEach(fact => { fact.text = 'я'.repeat(4000); });
      if (type !== 'json') result.text = JSON.stringify(data);
      return result;
    };
    await assert.rejects(f.run(), { code: type === 'growth' ? 'memory_not_smaller' : 'invalid_memory' });
    assert.deepEqual(f.store.read('1'), before);
  }
});

test('cancellation or deletion during summarization cannot commit late memory', async t => {
  for (const deletion of [false, true]) {
    const f = fixture(t);
    let release: (() => void) | undefined;
    f.provider.generate = request => new Promise(resolve => { release = () => resolve(f.summary(request)); });
    const running = f.run();
    f.store.mutate('1', state => {
      if (deletion) deleteSeed(state, state.stories[f.job.storyId].seedId);
      else state.job = null;
    });
    f.controller.abort();
    release!();
    await assert.rejects(running, { code: 'cancelled' });
    const story = f.store.read('1').stories[f.job.storyId];
    assert.equal(story ? Object.keys(story.memories).length : 0, 0);
  }
});

test('a full seed or retained tail stops without dropping scenes or running a summary', async t => {
  const f = fixture(t, 4);
  const before = f.store.read('1');
  await assert.rejects(f.run(), { code: 'context_limit' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.read('1'), before);
});

test('a single JSON code fence is accepted but surrounding prose cannot hide a malformed summary', async t => {
  for (const extraProse of [false, true]) {
    const f = fixture(t);
    const before = f.store.read('1');
    const original = f.provider.generate;
    f.provider.generate = async (request, controls) => {
      const result = await original(request, controls);
      if (request.system.startsWith('Извлеки')) result.text = (extraProse ? 'Пояснение.\n' : '') + '```json\n' + result.text + '\n```';
      return result;
    };
    if (extraProse) {
      await assert.rejects(f.run(), { code: 'invalid_memory' });
      assert.deepEqual(f.store.read('1'), before);
    } else {
      await f.run();
      const state = f.store.read('1');
      const story = state.stories[f.job.storyId];
      assert.equal(context(story, story.branches[f.job.branchId]).memories.length, 1);
      assert.deepEqual(story.nodes, before.stories[f.job.storyId].nodes);
    }
  }
});

test('explicit compaction below the threshold changes only memory, keeps the job lock and never generates prose', async t => {
  const f = fixture(t);
  const before = f.store.read('1');
  f.config.compactAtTokens = 54000;
  const result = await compactBranch({ store: f.store, userId: '1', jobId: f.job.id,
    provider: f.provider, config: f.config, signal: f.controller.signal });
  const state = f.store.read('1');
  assert.deepEqual(result, { scenes: 3, facts: 3 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.purpose, 'memory');
  assert.equal(state.job!.id, f.job.id);
  assert.deepEqual(state.stories[f.job.storyId].nodes, before.stories[f.job.storyId].nodes);
  assert.equal(state.stories[f.job.storyId].branches[f.job.branchId].head, f.job.head);
});

test('compaction reports stages and counts without exposing text; truncation has an exact safe reason', async t => {
  for (const truncated of [false, true]) {
    const f = fixture(t);
    const before = f.store.read('1');
    const events: CompactionStatus[] = [];
    // Compaction passes all three observers.
    f.provider.generate = async (request, controls?: Required<Pick<GenerateControls, 'onQueued' | 'onStart' | 'onText'>>) => {
      controls!.onQueued(); controls!.onStart();
      controls!.onText('PRIVATE SUMMARY CONTENT');
      return { ...f.summary(request), ...(truncated ? { finishReason: 'length' } : {}) };
    };
    const run = compactBranch({ store: f.store, userId: '1', jobId: f.job.id, provider: f.provider,
      config: f.config, onProgress: event => events.push(event) });
    if (truncated) {
      await assert.rejects(run, { code: 'invalid_memory', operation: 'compact', memoryReason: 'output_limit' });
      assert.deepEqual(f.store.read('1'), before);
      assert.equal(events.at(-1)!.stage, 'failed');
      assert.equal(events.at(-1)!.reason, 'output_limit');
    } else {
      await run;
      assert.deepEqual(events.map(e => e.stage), ['extracting', 'queued', 'extracting', 'extracting', 'validating', 'saving', 'done']);
    }
    assert.ok(events.some(e => e.outputCharacters === 23));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|CONTENT|Синтетический|Исходная/);
  }
});

test('one coverage supplement targets only missed scenes and commits complete memory atomically', async t => {
  const f = fixture(t);
  const before = f.store.read('1');
  const requests: string[][] = [];
  const events: CompactionStatus[] = [];
  f.provider.generate = async request => {
    const payload: SummaryInput = JSON.parse(request.messages[0].content);
    const nodes = payload.newScenes;
    requests.push(nodes.map(n => n.id));
    const result = f.summary(request);
    if (requests.length === 1) {
      const data: Summary = JSON.parse(result.text);
      data.facts.splice(1, 1);
      result.text = JSON.stringify(data);
    } else {
      assert.deepEqual(f.store.read('1'), before, 'draft cannot be saved before the supplement completes');
      assert.deepEqual(payload.precedingScenes.map(node => node.id), [requests[0][0]]);
      assert.equal(payload.draftFacts.length, 2);
      assert.deepEqual((request.outputSchema as MemorySchema).properties.facts.items.properties.source.items.enum, [requests[0][1]], 'context-only scenes cannot be cited');
      assert.equal((request.outputSchema as MemorySchema).properties.facts.maxItems, 198);
    }
    return { ...result, usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
  };
  await compactBranch({ store: f.store, userId: '1', jobId: f.job.id, config: f.config,
    provider: f.provider, onProgress: event => events.push(event) });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [requests[0][1]]);
  const story = f.store.read('1').stories[f.job.storyId];
  const memories = Object.values(story.memories);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].delta.facts.map(fact => fact.source[0]), requests[0]);
  assert.equal(memories[0].repairScenes, 1);
  assert.equal(memories[0].usage!.inputTokens, 2000);
  assert.equal(memories[0].usage!.outputTokens, 200);
  assert.equal(memories[0].usage!.totalTokens, 2200);
  assert.deepEqual(story.nodes, before.stories[f.job.storyId].nodes);
  assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'pre-compaction').length, 1);
  assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'compaction').length, 1);
  assert.ok(events.some(e => e.repairScenes === 1 && e.stage === 'extracting'));
  assert.equal(events.at(-1)!.stage, 'done');
});

test('a still-incomplete or oversized supplement fails without partial memory or further retries', async t => {
  for (const growth of [false, true]) {
    const f = fixture(t, 8);
    const before = f.store.read('1');
    let calls = 0;
    f.provider.generate = async request => {
      calls++;
      const data: Summary = JSON.parse(f.summary(request).text);
      if (calls === 1 || !growth) data.facts.splice(1);
      if (growth && calls === 2) data.facts.forEach(fact => { fact.text = 'я'.repeat(4000); });
      return { text: JSON.stringify(data), finishReason: 'stop' };
    };
    await assert.rejects(compactBranch({ store: f.store, userId: '1', jobId: f.job.id, config: f.config, provider: f.provider }),
      growth ? { code: 'memory_not_smaller' } : { code: 'invalid_memory', memoryReason: 'coverage' });
    assert.equal(calls, 2);
    assert.deepEqual(f.store.read('1'), before);
  }
});

test('a draft at the fact cap fails before a supplement can exceed the memory schema', async t => {
  const f = fixture(t);
  const before = f.store.read('1');
  let calls = 0;
  f.provider.generate = async request => {
    calls++;
    const data: Summary = JSON.parse(f.summary(request).text);
    return { text: JSON.stringify({ facts: Array.from({ length: 200 }, () => data.facts[0]) }), finishReason: 'stop' };
  };
  await assert.rejects(compactBranch({ store: f.store, userId: '1', jobId: f.job.id,
    config: f.config, provider: f.provider }), { code: 'invalid_memory', memoryReason: 'coverage' });
  assert.equal(calls, 1);
  assert.deepEqual(f.store.read('1'), before);
});

test('coverage repair is opt-in; diagnostics alone preserve the single-call failure', async t => {
  const f = fixture(t);
  f.config.repairCoverage = false;
  const before = f.store.read('1');
  let calls = 0;
  f.provider.generate = async request => {
    calls++;
    const data: Summary = JSON.parse(f.summary(request).text); data.facts.pop();
    return { text: JSON.stringify(data), finishReason: 'stop' };
  };
  await assert.rejects(compactBranch({ store: f.store, userId: '1', jobId: f.job.id,
    config: f.config, provider: f.provider }), { code: 'invalid_memory', memoryReason: 'coverage', sceneCount: 3, missingCount: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(f.store.read('1'), before);
});

test('a multi-scene transition stays after facts from an omitted intermediate scene', async t => {
  const f = fixture(t);
  let firstIds: string[] | undefined;
  f.provider.generate = async request => {
    const result = f.summary(request);
    const data: Summary = JSON.parse(result.text);
    if (!firstIds) {
      firstIds = data.facts.map(fact => fact.source[0]);
      data.facts = [{ ...data.facts[0], source: [firstIds[0], firstIds[2]] }];
    }
    return { ...result, text: JSON.stringify(data) };
  };
  await compactBranch({ store: f.store, userId: '1', jobId: f.job.id,
    config: f.config, provider: f.provider });
  const memory = Object.values(f.store.read('1').stories[f.job.storyId].memories)[0];
  assert.deepEqual(memory.delta.facts.map(fact => fact.source), [[firstIds![1]], [firstIds![0], firstIds![2]]]);
});

test('cancellation during a coverage supplement cannot commit the initial draft or late repair', async t => {
  const f = fixture(t);
  const before = f.store.read('1');
  let release: (() => void) | undefined;
  let calls = 0;
  f.provider.generate = request => {
    if (++calls === 1) {
      const data: Summary = JSON.parse(f.summary(request).text); data.facts.pop();
      return Promise.resolve({ text: JSON.stringify(data), finishReason: 'stop' });
    }
    return new Promise(resolve => { release = () => resolve(f.summary(request)); });
  };
  const run = compactBranch({ store: f.store, userId: '1', jobId: f.job.id, config: f.config,
    provider: f.provider, signal: f.controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  f.controller.abort(); release!();
  await assert.rejects(run, { code: 'cancelled' });
  assert.deepEqual(f.store.read('1'), before);
});
