import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import type { GenerationConfig } from './generation.ts';
import { generateScene, compactBranch } from './generation.ts';
import { makeRequest } from './prompt.ts';
import { requestBudget, requestStamp } from './context.ts';
import { createLlama } from './llama.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { ErrorDetails } from './model-error.ts';
import { ModelError, safeErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import type { Checkpoint } from '../lib/library.ts';
import { addSeed, newStory, beginJob, commitTurn, context, fork, deleteSeed } from '../lib/library.ts';

// Summary requests carry their scenes as JSON in the first message; these are the fields the tests read.
type SummaryInput = { newScenes: { id: string }[]; precedingScenes: { id: string }[]; draftFacts: unknown[] };
type Summary = { facts: { source: string[]; text: string }[] };
type MemorySchema = { properties: { facts: { maxItems: number; items: { properties: { source: { items: { enum: string[] } } } } } } };
// Log rows as main.ts writes them: the event, a code and the allowed details.
type LogRow = { event: string; code?: string | number } & ErrorDetails;
const rowsOf = (rows: LogRow[]) => (event: string, code?: string | number, details?: unknown) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); };
const isExtraction = (request: ModelRequest) => request.system.startsWith('Извлеки');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t: TestContext, count = 7) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const job = store.mutate('1', state => {
    newStory(state, addSeed(state, 'Маяк\n2026-08-02 20:00\nСинтетический смотритель бережёт маяк.').id);
    for (let i = 0; i < count; i++)
      commitTurn(state, beginJob(state, `Синтетический ввод ${i}.`, i).id, `2026-08-02 20:00\n\nИсходная сцена ${i}: ${'ветер '.repeat(300)}`);
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
  // A call leaves the queue, starts and streams its text, a summary as a scene; no status or log row may carry that text.
  const provider: Provider = { async generate(request, controls) {
    calls.push({ request, controls });
    const result = isExtraction(request) ? summary(request)
      : { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop' as const, usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } };
    controls?.onQueued?.(); controls?.onStart?.();
    await controls?.onText?.(result.text);
    return result;
  } };
  const events: CompactionStatus[] = [];
  const rows: LogRow[] = [];
  const observe = { signal: controller.signal, onProgress: (event: CompactionStatus) => { events.push(event); }, log: rowsOf(rows) };
  const run = () => generateScene({ store, userId: '1', jobId: job.id, provider, config, ...observe });
  const compact = () => compactBranch({ store, userId: '1', jobId: job.id, provider, config, ...observe });
  return { store, job, config, controller, calls, provider, summary, events, rows, run, compact };
}
type Fixture = ReturnType<typeof fixture>;
type Change = (data: Summary, call: number, request: ModelRequest) => Partial<GenerationResult> | void | Promise<void>;
// Changes the summaries the model answers with, `call` counting them; scenes are answered as ever.
function answer(f: Fixture, change: Change) {
  const original = f.provider.generate;
  let call = 0;
  f.provider.generate = async (request, controls) => {
    const result = await original(request, controls);
    if (!isExtraction(request)) return result;
    const data: Summary = JSON.parse(result.text);
    const extra = await change(data, ++call, request);
    return { ...result, text: JSON.stringify(data), ...extra as Partial<GenerationResult> };
  };
}
const grow = (data: Summary) => { data.facts.forEach(fact => { fact.text = 'я'.repeat(4000); }); };

// Every way a compaction ends. One that completes keeps the stored scenes, sends the last four of them with the memory
// of the rest and leaves a checkpoint on each side; one that fails, is cancelled or loses its story leaves the library
// as it found it. Statuses and log rows count; they never carry the text of the story or of the summary.
test('cancellation or deletion during summarization cannot commit late memory', async t => {
  let release = () => {};
  let held = Promise.resolve();
  type Case = { label: string; scenes?: number; manual?: true; repair?: false; calls: number; change?: Change;
    during?: (f: Fixture, label: string) => unknown; error?: { code: string } & ErrorDetails };
  const cancelled = { code: 'cancelled' };
  const rows: Case[] = [
    { label: 'a compaction at the threshold', calls: 2 },
    { label: 'a summary in a lone JSON fence', calls: 2, change: data => ({ text: '```json\n' + JSON.stringify(data) + '\n```' }) },
    { label: 'prose around the fence', calls: 1, change: data => ({ text: 'Пояснение.\n```json\n' + JSON.stringify(data) + '\n```' }),
      error: { code: 'invalid_memory', memoryReason: 'json' } },
    { label: 'text that is not JSON', calls: 1, change: () => ({ text: 'invalid' }), error: { code: 'invalid_memory', memoryReason: 'json' } },
    { label: 'a fact from a scene outside the summary', calls: 1, change: data => { data.facts[0].source = ['n999999']; },
      error: { code: 'invalid_memory', memoryReason: 'source' } },
    { label: 'a scene missing from the summary and from its supplement', calls: 2, change: data => { data.facts.pop(); },
      error: { code: 'invalid_memory', memoryReason: 'shape' } },
    { label: 'a summary cut off at its limit', calls: 1, change: () => ({ finishReason: 'length' }),
      error: { code: 'invalid_memory', operation: 'compact', automatic: true, memoryReason: 'output_limit' } },
    { label: 'a memory larger than its scenes', calls: 1, change: grow, error: { code: 'memory_not_smaller' } },
    { label: 'a missed scene with repair off', repair: false, manual: true, calls: 1, change: data => { data.facts.pop(); },
      error: { code: 'invalid_memory', memoryReason: 'coverage', sceneCount: 3, missingCount: 1 } },
    { label: 'a draft at the fact cap', manual: true, calls: 1, change: data => { data.facts = Array.from({ length: 200 }, () => data.facts[0]); },
      error: { code: 'invalid_memory', memoryReason: 'coverage' } },
    // The supplement asked for three scenes and covered one: the error counts the supplement, for the one row the bot writes.
    { label: 'a supplement that still misses scenes', scenes: 8, manual: true, calls: 2, change: data => { data.facts.splice(1); },
      error: { code: 'invalid_memory', operation: 'compact', automatic: false, memoryReason: 'coverage', sceneCount: 3, missingCount: 2, repairSceneCount: 3 } },
    { label: 'an oversized supplement', scenes: 8, manual: true, calls: 2, change: (data, call) => { if (call === 1) data.facts.splice(1); else grow(data); },
      error: { code: 'memory_not_smaller' } },
    { label: 'a cancel during the summary', calls: 1, change: () => held, during: f => f.store.mutate('1', state => { state.job = null; }), error: cancelled },
    { label: 'a deletion of the story during the summary', calls: 1, change: () => held,
      during: f => f.store.mutate('1', state => { deleteSeed(state, state.stories[f.job.storyId].seedId); }), error: cancelled },
    { label: 'a cancel during the supplement', manual: true, calls: 2, change: (data, call) => { if (call === 1) data.facts.pop(); else return held; },
      during: async (f, label) => { await turn(); assert.equal(f.calls.length, 2, label); }, error: cancelled },
  ];
  for (const { label, scenes, manual, repair, calls, change, during, error } of rows) {
    const f = fixture(t, scenes);
    if (repair === false) f.config.repairCoverage = false;
    held = new Promise(resolve => { release = resolve; });
    if (change) answer(f, change);
    const before = f.store.read('1');
    const running = manual ? f.compact() : f.run();
    await during?.(f, label);
    const found = during ? f.store.read('1') : before;
    if (during) { f.controller.abort(); release(); }
    if (error) {
      await assert.rejects(running, error, label);
      assert.deepEqual(f.store.read('1'), found, label);
      if (!during) assert.deepEqual([f.events.at(-1)!.stage, f.events.at(-1)!.reason], ['failed', error.memoryReason ?? error.code], label);
    } else {
      const done = await running;
      assert.match('result' in done ? done.result.text : '', /Новая сцена/, label);
      const extraction = f.calls[0].request;
      const summarized = (JSON.parse(extraction.messages[0].content) as SummaryInput).newScenes.map(node => node.id);
      assert.deepEqual((extraction.outputSchema as MemorySchema).properties.facts.items.properties.source.items.enum, summarized, label);
      assert.doesNotMatch(extraction.messages[0].content, /НОВОЕ ДЕЙСТВИЕ/, label);
      const state = f.store.read('1');
      const story = state.stories[f.job.storyId];
      assert.deepEqual(story.nodes, before.stories[f.job.storyId].nodes, label);
      // The memory covers the first three scenes and the tail keeps the other four; the next request has both.
      const ids = Object.keys(story.nodes);
      const { memories, recent } = context(story, story.branches[f.job.branchId]);
      assert.deepEqual([summarized, memories.map(memory => memory.covered), recent.map(node => node.id)],
        [ids.slice(0, 3), [ids.slice(0, 3)], ids.slice(3)], label);
      const next = JSON.stringify(f.calls[1].request.messages);
      assert.match(next, /НОВОЕ ДЕЙСТВИЕ/, label); assert.match(next, /На острове дул ветер/, label);
      assert.doesNotMatch(next, /Исходная сцена 0/, label);
      const pre = Object.values(story.checkpoints).find(cp => cp.kind === 'pre-compaction')!;
      const post = Object.values(story.checkpoints).find(cp => cp.kind === 'compaction')!;
      assert.deepEqual([context(story, pre).recent.length, context(story, post).recent.length], [7, 4], label);
      state.job = null;
      assert.deepEqual([pre, post].map(cp => context(story, fork(state, story.id, cp.id)).memories.length), [0, 1], label);
      // The status leaves the queue for the stages in order and counts the characters that came; the rows carry sizes.
      assert.deepEqual(f.events.map(event => event.stage), ['extracting', 'queued', 'extracting', 'extracting', 'validating', 'saving', 'done'], label);
      assert.ok(f.events.some(event => event.outputCharacters === f.summary(extraction).text.length), label);
      const saved = f.rows.find(row => row.event === 'memory_compacted');
      assert.deepEqual([f.rows.map(row => row.event), saved?.automatic, saved?.sceneCount, saved?.factCount, saved?.inputBytesAfter! < saved?.inputBytesBefore!],
        [['compaction_request_started', 'compaction_request_completed', 'memory_compacted', 'scene_request_completed'], true, 3, 3, true], label);
    }
    assert.equal(f.calls.length, calls, label);
    assert.doesNotMatch(JSON.stringify([f.events, f.rows]), /ветер|Синтетический|Исходная|НОВОЕ|Новая|n\d/, label);
  }
});

// Near the threshold the server's count decides, not the byte estimate; a scene sent uncounted is compacted and written
// again when its usage or a live limit says it was too long. A seed or tail that cannot shrink stops without a summary.
test('a count, a usage or a live limit decides when a scene compacts first, and far below the threshold nothing is counted', async t => {
  type Case = { label: string; scenes?: number; threshold: (estimate: number) => number; count?: number[] | 'echo'; first?: 'limit' | 'usage';
    memories: number; counts: number; sent: number; trust?: true; estimate?: number; error?: string };
  const rows: Case[] = [
    // At the estimate or just above it: that says the request fits, and it is too close to the threshold to go uncounted.
    { label: 'a count under a threshold the estimate reaches', threshold: e => e, count: [1000], memories: 0, counts: 1, sent: 1, estimate: 1000 },
    { label: 'a count over a threshold the estimate is under', threshold: e => e + 1, count: [54000, 1000], memories: 1, counts: 2, sent: 1, estimate: 1000 },
    { label: 'a live token limit when the estimate was below 54k', threshold: () => 54000, first: 'limit', memories: 1, counts: 0, sent: 2 },
    // The server's count of the first scene is over the threshold: in the usage it reports with the scene, or found
    // by the provider itself, as local/llama.ts finds it.
    { label: 'the usage of an uncounted scene', threshold: () => 54000, count: 'echo', first: 'usage', memories: 1, counts: 0, sent: 2, trust: true },
    { label: 'a limit found for an uncounted scene', threshold: () => 54000, count: 'echo', first: 'limit', memories: 1, counts: 0, sent: 2, trust: true },
    { label: 'a full seed or retained tail', scenes: 4, threshold: e => e, memories: 0, counts: 0, sent: 0, error: 'context_limit' },
  ];
  for (const row of rows) {
    const f = fixture(t, row.scenes);
    const before = f.store.read('1');
    f.config.compactAtTokens = row.threshold(f.config.compactAtTokens!);
    let counts = 0;
    const count = row.count;
    if (count) f.provider.countInput = async request => { counts++; return count === 'echo' ? request.estimatedInputTokens! : count[counts - 1]; };
    const sent: ModelRequest[] = [];
    const original = f.provider.generate;
    f.provider.generate = async (request, controls) => {
      if (isExtraction(request)) return original(request, controls);
      sent.push(request);
      if (sent.length > 1 || !row.first) return original(request, controls);
      assert.equal(controls!.inputLimitTokens, 53999, row.label);
      if (row.first === 'limit') throw new ModelError('context_limit');
      return { text: '2026-08-02 20:00\n\nНовая сцена.', finishReason: 'stop', usage: { inputTokens: 54000, outputTokens: 20, totalTokens: 54020 } };
    };
    // The scene kept is the one written after the compaction, and a summary is asked only for a compaction.
    const outcome = await f.run().then(({ result }) => result.usage!.inputTokens, (error: { code: string }) => error.code);
    const summaries = f.calls.filter(call => isExtraction(call.request)).length;
    assert.deepEqual([outcome, counts, sent.length, summaries], [row.error ?? 1000, row.counts, row.sent, row.memories], row.label);
    assert.equal(Object.keys(f.store.read('1').stories[f.job.storyId].memories).length, row.memories, row.label);
    assert.ok(sent.every(request => request.trustEstimate === row.trust), row.label);
    if (row.estimate) assert.equal(sent.at(-1)!.estimatedInputTokens, row.estimate, row.label);
    if (row.error) assert.deepEqual(f.store.read('1'), before, row.label);
  }
  // A provider that counts input exactly is asked to only near the threshold: below half of it for an estimate of the
  // whole request, below nine tenths for one anchored on the last scene's measured input.
  for (const anchored of [false, true]) for (const counted of [false, true]) {
    const f = fixture(t);
    const label = `${anchored ? 'an anchored' : 'a whole'} estimate, ${counted ? 'counted' : 'uncounted'}`;
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
    f.config.compactAtTokens = Math.floor(estimate / (anchored ? 0.9 : 0.5)) + (counted ? 0 : 1);
    let counts = 0;
    f.provider.countInput = async request => { counts++; return request.estimatedInputTokens!; };
    await f.run();
    // The scene, and no compaction.
    const { trustEstimate, estimatedInputTokens } = f.calls[0].request;
    assert.deepEqual([counts, f.calls.length, trustEstimate, estimatedInputTokens], [counted ? 1 : 0, 1, counted ? undefined : true, estimate], label);
    // The estimate goes to the row either way; a skipped count leaves no duration rather than a zero.
    const row = f.rows.find(one => one.event === 'scene_request_completed')!;
    assert.deepEqual([row.estimateTokens, 'countMs' in row], [estimate, counted], label);
  }
});

// The first summary misses the second scene: it drops it, or passes over it with a fact about the transition from the
// first to the third. One supplement asks for that scene alone, and the memory is saved only whole.
test('one coverage supplement targets only missed scenes and commits complete memory atomically', async t => {
  const rows: [string, (data: Summary) => void, number, number[][]][] = [
    ['a scene the summary dropped', data => { data.facts.splice(1, 1); }, 2, [[0], [1], [2]]],
    // A fact covering a transition belongs after its latest source, not before the correction of a scene within it.
    ['a transition over the scene it missed',
      data => { data.facts = [{ ...data.facts[0], source: [data.facts[0].source[0], data.facts[2].source[0]] }]; }, 1, [[1], [0, 2]]],
  ];
  for (const [label, miss, drafted, sources] of rows) {
    const f = fixture(t);
    const before = f.store.read('1');
    const requests: string[][] = [];
    answer(f, (data, call, request) => {
      const payload: SummaryInput = JSON.parse(request.messages[0].content);
      requests.push(payload.newScenes.map(n => n.id));
      if (call === 1) miss(data);
      else {
        assert.deepEqual(f.store.read('1'), before, `${label}: the draft cannot be saved before the supplement completes`);
        assert.deepEqual(payload.precedingScenes.map(node => node.id), [requests[0][0]], label);
        assert.equal(payload.draftFacts.length, drafted, label);
        const schema = (request.outputSchema as MemorySchema).properties.facts;
        assert.deepEqual(schema.items.properties.source.items.enum, [requests[0][1]], `${label}: context-only scenes cannot be cited`);
        assert.equal(schema.maxItems, 200 - drafted, label);
      }
      return { usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } };
    });
    await f.compact();
    assert.deepEqual(requests, [requests[0], [requests[0][1]]], label);
    const story = f.store.read('1').stories[f.job.storyId];
    const memories = Object.values(story.memories);
    assert.equal(memories.length, 1, label);
    assert.deepEqual(memories[0].delta.facts.map(fact => fact.source), sources.map(indexes => indexes.map(index => requests[0][index])), label);
    const { usage, repairScenes } = memories[0];
    assert.deepEqual([repairScenes, usage!.inputTokens, usage!.outputTokens, usage!.totalTokens], [1, 2000, 200, 2200], label);
    assert.deepEqual(story.nodes, before.stories[f.job.storyId].nodes, label);
    assert.deepEqual(['pre-compaction', 'compaction'].map(kind => Object.values(story.checkpoints).filter(cp => cp.kind === kind).length), [1, 1], label);
    assert.ok(f.events.some(e => e.repairScenes === 1 && e.stage === 'extracting'), label);
    assert.equal(f.events.at(-1)!.stage, 'done', label);
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
    for (let i = 0; i < 3; i++)
      commitTurn(state, beginJob(state, `Новое событие ${i}`, i).id, `2026-08-03 20:00\n\n${'Синтетический дождь. '.repeat(100)}`);
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
