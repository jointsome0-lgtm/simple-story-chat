import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { GenerationConfig } from './generation.ts';
import { generateScene, compactBranch } from './generation.ts';
import { ModelError } from './claude.ts';
import { makeRequest } from './prompt.ts';
import { requestBudget, requestStamp } from './context.ts';
import { createLlama } from './llama.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';
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
    // Just above the estimate: it says the request fits, and it is too close to the threshold to go uncounted.
    f.config.compactAtTokens = needsCompaction ? f.config.compactAtTokens! + 1 : f.config.compactAtTokens;
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

// Log rows as main.ts writes them: the event, a code and the allowed details.
type Row = { event: string; code?: string | number } & ErrorDetails;
const rowsOf = (rows: Row[]) => (event: string, code?: string | number, details?: unknown) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); };

test('an automatic compaction that succeeds leaves rows with its sizes and counts, and none of its text', async t => {
  const f = fixture(t);
  const rows: Row[] = [];
  let extraction: ModelRequest | undefined;
  f.provider.generate = async (request, controls) => {
    if (!request.system.startsWith('Извлеки')) return { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop' };
    extraction = request;
    await controls!.onText?.('PRIVATE SUMMARY CONTENT');
    return { ...f.summary(request), usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
  };
  await generateScene({ store: f.store, userId: '1', jobId: f.job.id, provider: f.provider, config: f.config, log: rowsOf(rows) });
  assert.deepEqual(rows.map(row => row.event), ['compaction_request_started', 'compaction_request_completed', 'memory_compacted', 'scene_request_completed']);
  const [started, completed, saved, scene] = rows;
  // A provider that cannot count has no `countMs`; the estimate is logged all the same.
  assert.deepEqual(Object.keys(scene).sort(), ['elapsedMs', 'estimateTokens', 'event']);
  // The size of the extraction request itself: the three scenes it carries are most of it.
  const requestBytes = requestBudget(extraction!, f.config.contextTokens).inputBytes;
  assert.ok(requestBytes > 3 * 300 * Buffer.byteLength('ветер '));
  const { elapsedMs: startedAfter, ...first } = started;
  assert.deepEqual(first, { event: 'compaction_request_started', automatic: true, sceneCount: 3, repairSceneCount: 0, requestBytes, outputCharacters: 0 });
  const { elapsedMs: completedAfter, ...second } = completed;
  assert.deepEqual(second, { ...first, event: 'compaction_request_completed', outputCharacters: 23, inputTokens: 1000, outputTokens: 100 });
  const { elapsedMs, inputBytesBefore, inputBytesAfter, ...third } = saved;
  assert.deepEqual(third, { ...first, event: 'memory_compacted', outputCharacters: 23, factCount: 3 });
  assert.ok(inputBytesAfter! < inputBytesBefore!);
  assert.ok(startedAfter! <= completedAfter! && completedAfter! <= elapsedMs!);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|CONTENT|Синтетический|Исходная|n\d/);
});

test('a failed compaction carries its numbers on the error, so its one log row tells how far it got', async t => {
  for (const type of ['transport', 'coverage', 'supplement', 'growth'] as const) {
    const f = fixture(t, 8);
    f.config.repairCoverage = type === 'supplement';
    const rows: Row[] = [];
    let calls = 0;
    f.provider.generate = async (request, controls) => {
      calls++;
      await controls!.onText?.('PRIVATE');
      if (type === 'transport') throw Object.assign(new TypeError('PRIVATE_TEXT'), { cause: { code: 'UND_ERR_SOCKET' } });
      const data: Summary = JSON.parse(f.summary(request).text);
      if (type === 'coverage') data.facts.pop();
      if (type === 'supplement') data.facts.splice(1);
      if (type === 'growth') data.facts.forEach(fact => { fact.text = 'я'.repeat(4000); });
      return { text: JSON.stringify(data), finishReason: 'stop' };
    };
    const error = await compactBranch({ store: f.store, userId: '1', jobId: f.job.id, config: f.config, provider: f.provider, log: rowsOf(rows) })
      .then(() => assert.fail('compaction must fail'), (error: unknown) => error);
    // The bot writes the failure row from the error; these are the details that row gets.
    const { elapsedMs, inputBytesBefore, inputBytesAfter, requestBytes, ...details } = safeErrorDetails(error);
    assert.ok(elapsedMs! >= 0 && requestBytes! > 0);
    const common = { operation: 'compact', automatic: false, outputCharacters: 7 };
    if (type === 'transport') assert.deepEqual(details, { ...common, sceneCount: 4, repairSceneCount: 0 });
    if (type === 'coverage') assert.deepEqual(details, { ...common, memoryReason: 'coverage', sceneCount: 4, missingCount: 1, repairSceneCount: 0 });
    // The supplement asked for three scenes and covered one: the error counts the supplement, the row says it was one.
    if (type === 'supplement') assert.deepEqual(details, { ...common, memoryReason: 'coverage', sceneCount: 3, missingCount: 2, repairSceneCount: 3 });
    if (type === 'growth') assert.deepEqual(details, { ...common, sceneCount: 4, repairSceneCount: 0 });
    assert.equal(inputBytesBefore !== undefined && inputBytesAfter! >= inputBytesBefore, type === 'growth');
    assert.deepEqual(rows.map(row => row.event), type === 'transport' ? ['compaction_request_started']
      : type === 'supplement' ? ['compaction_request_started', 'compaction_request_completed', 'compaction_request_started', 'compaction_request_completed']
        : ['compaction_request_started', 'compaction_request_completed']);
    assert.equal(rows.at(-1)!.repairSceneCount, type === 'supplement' ? 3 : 0);
    assert.equal(calls, type === 'supplement' ? 2 : 1);
    assert.doesNotMatch(JSON.stringify([rows, safeErrorDetails(error)]), /PRIVATE/);
  }
});

// A provider that counts input exactly is asked to only near the threshold: below half of it for an estimate of the
// whole request, below nine tenths for one anchored on the last scene's measured input.
test('far below the threshold a scene is sent uncounted, and from the trusted share of it on it is counted', async t => {
  for (const anchored of [false, true]) for (const counted of [false, true]) {
    const f = fixture(t);
    // The fixture's threshold is the byte estimate of its request, which has no anchor.
    let estimate = f.config.compactAtTokens!;
    if (anchored) {
      // The head scene measured 30000 tokens for a request this one repeats byte for byte: the estimate is just that.
      estimate = 30000;
      const request = makeRequest(f.store.read('1'), f.job, f.config.maxOutputTokens);
      f.store.mutate('1', state => Object.assign(state.stories[f.job.storyId].nodes[f.job.head!], {
        usage: { inputTokens: estimate, outputTokens: 20, totalTokens: estimate + 20 },
        requestContext: requestStamp(request, f.config.model, f.job.memory, f.config.provider) }));
    }
    const share = anchored ? 0.9 : 0.5;
    f.config.compactAtTokens = Math.floor(estimate / share) + (counted ? 0 : 1);
    let counts = 0;
    f.provider.countInput = async request => { counts++; return request.estimatedInputTokens!; };
    const rows: Row[] = [];
    await generateScene({ store: f.store, userId: '1', jobId: f.job.id, provider: f.provider, config: f.config, log: rowsOf(rows) });
    assert.equal(counts, counted ? 1 : 0);
    assert.equal(f.calls.length, 1, 'the scene, and no compaction');
    assert.equal(f.calls[0].request.trustEstimate, counted ? undefined : true);
    assert.equal(f.calls[0].request.estimatedInputTokens, estimate);
    // The estimate goes to the row either way; a skipped count leaves no duration rather than a zero.
    const row = rows.find(one => one.event === 'scene_request_completed')!;
    assert.equal(row.estimateTokens, estimate);
    assert.equal('countMs' in row, counted);
  }
});

test('a scene sent uncounted that the server counts over the threshold still compacts and is written again', async t => {
  for (const late of ['usage', 'context_limit'] as const) {
    const f = fixture(t);
    f.config.compactAtTokens = 54000;
    let counts = 0;
    f.provider.countInput = async request => { counts++; return request.estimatedInputTokens!; };
    const original = f.provider.generate;
    const scenes: ModelRequest[] = [];
    f.provider.generate = async (request, controls) => {
      if (request.system.startsWith('Извлеки')) return original(request, controls);
      scenes.push(request);
      if (scenes.length > 1) return original(request, controls);
      // The server's count of the first scene is over the threshold: in the usage it reports with the scene, or found
      // by the provider itself, as local/llama.ts finds it.
      if (late === 'context_limit') throw new ModelError('context_limit');
      return { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop', usage: { inputTokens: 54000, outputTokens: 20, totalTokens: 54020 } };
    };
    const { result } = await f.run();
    assert.equal(counts, 0);
    assert.equal(scenes.length, 2);
    assert.ok(scenes.every(scene => scene.trustEstimate));
    assert.equal(Object.keys(f.store.read('1').stories[f.job.storyId].memories).length, 1);
    assert.equal(result.usage!.inputTokens, 1000);
  }
});

// The same all the way down to llama-server: the server's count of an uncounted scene, in the usage of its stream or
// through a prompt it refuses as longer than its context, ends in a compaction and a new scene, never in a failure.
test('an uncounted scene that llama-server finds too long compacts the branch and is written again', async t => {
  for (const refused of [false, true]) {
    const f = fixture(t);
    f.config.compactAtTokens = 54000;
    const calls: string[] = [];
    let scenes = 0;
    const fetch = async (url: string, init: RequestInit) => {
      const counting = new URL(url).pathname.endsWith('/input_tokens');
      const messages = (JSON.parse(init.body as string) as { messages: { role: string; content: string }[] }).messages;
      const summary = messages[0].content.startsWith('Извлеки');
      if (!summary && !counting) scenes++;
      calls.push(`${summary ? 'summary' : 'scene'} ${counting ? 'count' : 'generate'}`);
      // The first scene is over the threshold by the server's count, and when refused longer than the whole context.
      const tokens = summary ? 2000 : scenes > 1 ? 1000 : refused ? 70000 : 60000;
      if (counting) return new Response(JSON.stringify({ input_tokens: tokens }), { headers: { 'Content-Type': 'application/json' } });
      if (refused && !summary && scenes === 1) return new Response('{"error":{"code":400}}', { status: 400 });
      const text = summary ? f.summary({ system: messages[0].content, messages: messages.slice(1) as ModelRequest['messages'], maxOutputTokens: 1 }).text
        : '2026-08-02 20:00\n\nНовая сцена.';
      const events = [{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: tokens, completion_tokens: 20 } }];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const provider = createLlama({ baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536 }, { fetch });
    const { result } = await generateScene({ store: f.store, userId: '1', jobId: f.job.id, provider, config: f.config, signal: f.controller.signal });
    // Neither scene is counted first; only the refused one is counted after, and the extraction as ever.
    assert.deepEqual(calls, [...refused ? ['scene generate', 'scene count'] : ['scene generate'],
      'summary count', 'summary generate', 'scene generate']);
    assert.equal(result.usage!.inputTokens, 1000);
    assert.equal(Object.keys(f.store.read('1').stories[f.job.storyId].memories).length, 1);
  }
});
