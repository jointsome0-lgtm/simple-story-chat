import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from './store.ts';
import { createScheduler } from './scheduler.ts';
import { serveBackground } from './background.ts';
import { agentProvider, createAgentApi } from './agent-api.ts';
import type { AgentApi, AgentOptions, AgentResponse } from './agent-api.ts';
import { loadAgentConfig } from './config.ts';
import { ModelError, safeErrorDetails } from './model-error.ts';
import type { ErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { beginJob, commitTurn } from '../lib/library.ts';
import { narration } from './story-text.ts';

// Synthetic stories only.
const SEED = 'Lighthouse\n2026-08-02 20:00\nThe keeper meets a boat. The password is NORTH.';
type Row = { event: string; code?: string | number } & ErrorDetails;
// Results the tests read; the interface returns them as unknown JSON.
type Turn = { storyId: string; branchId: string; scene: { sceneId: string; worldTime: string; text: string; truncated: boolean } | null;
  checkpointId: string; revision: string; compaction?: { memoryIds: string[]; checkpoints: { checkpointId: string; kind: string }[] } };
type View = { revision: string; sceneCount: number; scenes: { sceneId: string; input: string }[]; runningRequestId?: string;
  checkpoints: { checkpointId: string; kind: string; sceneId: string | null }[]; memory?: { memoryId: string; covered: string[]; facts: { source: string[] }[] }[] };
type Held = { request: ModelRequest; signal?: AbortSignal; release: (result?: GenerationResult) => void };
type Options = { hold?: boolean; generate?: (request: ModelRequest, controls: GenerateControls) => Promise<GenerationResult> } & Partial<AgentOptions>;

const config = { model: 'test-model', provider: 'claude-code', maxOutputTokens: 1024, contextTokens: 65536, compactAtTokens: 54000, keepScenes: 4 };

function fixture(t: TestContext, options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-test-'));
  const path = join(directory, 'agents.sqlite');
  const stores: Store[] = [];
  const apis: AgentApi[] = [];
  t.after(async () => {
    for (const api of apis) await api.close();
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const requests: ModelRequest[] = [];
  const held: Held[] = [];
  const rows: Row[] = [];
  const provider: Provider = { async generate(request, controls = {}) {
    requests.push(request);
    if (options.generate) return options.generate(request, controls);
    const scene = { text: `2026-08-02 20:0${requests.length % 10}\n\nSynthetic scene ${requests.length}.`, finishReason: 'stop' as const,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    if (!options.hold) return scene;
    return new Promise<GenerationResult>((resolve, reject) => {
      controls.signal?.addEventListener('abort', () => reject(new ModelError('cancelled')), { once: true });
      held.push({ request, signal: controls.signal, release: result => resolve(result ?? scene) });
    });
  } };
  const open = (extra: Partial<AgentOptions> = {}) => {
    const store = new Store(path, { readOnly: extra.readOnly });
    stores.push(store);
    const api = createAgentApi({ store, provider, config, waitSeconds: 5, ...options, ...extra,
      log: (event, code, details) => rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }) });
    apis.push(api);
    return { api, store };
  };
  const { api, store } = open();
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check()); };
  return { api, store, open, requests, held, rows, until };
}
type Fixture = ReturnType<typeof fixture>;
const turn = (response: AgentResponse) => response.result as Turn;
const view = (response: AgentResponse) => response.result as View;

test('a story runs through the agent interface: seed, start, act, continue, fork, read', async t => {
  const f = fixture(t);
  const seed = f.api.createSeed({ requestId: 'seed-1', text: SEED });
  assert.deepEqual(seed, { requestId: 'seed-1', status: 'done', result: { seedId: 's1', title: 'Lighthouse', worldTime: '2026-08-02 20:00' } });
  const started = await f.api.startStory({ requestId: 'start-1', seedId: 's1' });
  const first = turn(started);
  assert.deepEqual([started.status, first.scene!.text, first.scene!.worldTime], ['done', '2026-08-02 20:01\n\nSynthetic scene 1.', '2026-08-02 20:01']);
  assert.match(f.requests[0].messages.at(-1)!.content, new RegExp(narration('en').startStory));
  // Every scene gets a checkpoint that carries its head and memory.
  const opened = view(f.api.read({ storyId: first.storyId, branchId: first.branchId }));
  assert.equal(opened.revision, first.revision);
  assert.deepEqual(opened.checkpoints.map(cp => cp.kind), ['start', 'scene']);
  assert.equal(opened.checkpoints[1].checkpointId, first.checkpointId);

  const acted = await f.api.act({ requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'I light the lamp.' });
  assert.equal(acted.status, 'done');
  assert.notEqual(turn(acted).revision, first.revision);
  assert.match(f.requests[1].messages.at(-1)!.content, /I light the lamp\./);
  // Empty input is "continue".
  const continued = await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId: first.branchId, expected: turn(acted).revision });
  assert.equal(continued.status, 'done');
  assert.match(f.requests[2].messages.at(-1)!.content, new RegExp(narration('en').continueStory));
  const after = view(f.api.read({ storyId: first.storyId, scenes: 2 }));
  assert.equal(after.sceneCount, 3);
  assert.deepEqual(after.scenes.map(s => s.input), ['I light the lamp.', narration('en').continueStory]);
  // The agent library stores English labels and the scene's metadata as the bot does.
  const state = f.store.read('agent');
  const node = state.stories[first.storyId].nodes[turn(continued).scene!.sceneId];
  assert.deepEqual([node.modelInfo, node.usage?.inputTokens, node.requestContext?.model], [{ provider: 'claude-code', model: 'test-model' }, 100, 'test-model']);
  assert.equal(state.stories[first.storyId].checkpoints[turn(continued).checkpointId].label, 'Scene 3');
  assert.equal(state.job, null);

  // A fork starts a branch from a checkpoint, with its head and memory, and the branches move apart.
  const forked = f.api.fork({ requestId: 'fork-1', storyId: first.storyId, checkpointId: first.checkpointId });
  assert.equal(forked.status, 'done');
  const { branchId, revision } = forked.result as { branchId: string; revision: string };
  assert.notEqual(branchId, first.branchId);
  const branch = view(f.api.read({ storyId: first.storyId, branchId }));
  assert.equal(branch.revision, revision);
  assert.deepEqual(branch.scenes.map(s => s.sceneId), [first.scene!.sceneId]);
  const other = turn(await f.api.act({ requestId: 'act-3', storyId: first.storyId, branchId, expected: revision, input: 'Keep the door shut.' }));
  assert.equal(view(f.api.read({ storyId: first.storyId, branchId: first.branchId })).revision, turn(continued).revision);
  assert.equal(view(f.api.read({ storyId: first.storyId, branchId })).revision, other.revision);
  assert.deepEqual(f.api.fork({ requestId: 'fork-1', storyId: first.storyId, checkpointId: first.checkpointId }), forked);
  assert.equal(f.api.fork({ requestId: 'fork-2', storyId: first.storyId, checkpointId: 'constructor' }).reason, 'not_found');
});

test('a request runs once: a retry gets its receipt before any state check, a reused id conflicts, a stale act generates nothing', async t => {
  const f = fixture(t);
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  const first = turn(await f.api.startStory({ requestId: 'start-1', seedId: 's1' }));
  const payload = { requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'Go north.' };
  const done = await f.api.act(payload);
  const moved = await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId: first.branchId, expected: turn(done).revision, input: 'Go on.' });
  assert.equal(moved.status, 'done');
  const calls = f.requests.length;
  const reused = { requestId: 'act-1', status: 'conflict', reason: 'request_id_reused' };
  for (const [label, call, expected] of [
    // The branch has moved since act-1, and a retry after success must not see that as stale.
    ['an act retried after its branch moved on', () => f.api.act(payload), done],
    ['a start retried', () => f.api.startStory({ requestId: 'start-1', seedId: 's1' }), f.api.status({ requestId: 'start-1' })],
    ['a seed retried', () => f.api.createSeed({ requestId: 'seed-1', text: SEED }), f.api.status({ requestId: 'seed-1' })],
    ['an act id with another payload', () => f.api.act({ ...payload, input: 'Go south.' }), reused],
    ['an act id reused for a seed', () => f.api.createSeed({ requestId: 'act-1', text: SEED }), reused],
    ['a new act on an old revision', () => f.api.act({ ...payload, requestId: 'act-3', input: 'Late move.' }),
      { requestId: 'act-3', status: 'stale', result: { revision: turn(moved).revision } }],
  ] as const) {
    assert.deepEqual(await call(), expected, label);
    assert.equal(f.requests.length, calls, `${label} generates nothing`);
  }
  assert.equal(Object.keys(f.store.read('agent').seeds).length, 1);
  // A refusal is not a receipt: the same key may be used again once the client has the current revision.
  assert.equal(f.api.status({ requestId: 'act-3' }).reason, 'unknown_request');
});

test('a read-only process sees receipts and stories but writes nothing', async t => {
  const f = fixture(t, { hold: true });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  const running = await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 });
  assert.equal(running.status, 'running');
  const { storyId, branchId } = turn(running);
  await f.until(() => f.held.length === 1);
  const reader = f.open({ readOnly: true });
  const overview = f.api.read().result as { seeds: unknown[]; stories: { branches: unknown[] }[] };
  assert.deepEqual([overview.seeds.length, overview.stories[0].branches.length], [1, 1]);
  // While a turn runs, none of these writes to the library or calls the model again: reads, waits, retries, refusals.
  const before = JSON.stringify(f.store.read('agent'));
  const seen = (response: AgentResponse) => [response.status, response.reason, (response.result as View | undefined)?.runningRequestId].filter(Boolean).join(' ');
  for (const [label, call, expected] of [
    ['a wait', () => f.api.wait({ requestId: 'start-1', seconds: 0.01 }), 'running'],
    ['a status', () => f.api.status({ requestId: 'start-1' }), 'running'],
    ['the running start retried', () => f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 }), 'running'],
    ['another start: one job at a time', () => f.api.startStory({ requestId: 'start-2', seedId: 's1' }), 'busy job_running start-1'],
    ['a read of the running branch', () => f.api.read({ storyId }), 'done start-1'],
    ['a read with memory and no scenes', () => f.api.read({ storyId, scenes: 0, memory: true }), 'done start-1'],
    ['an unknown request', () => f.api.status({ requestId: 'nobody' }), 'failed unknown_request'],
    ['a story key that is not a library id', () => f.api.read({ storyId: 'constructor' }), 'failed not_found'],
    ['a branch key that is not a library id', () => f.api.read({ storyId, branchId: '__proto__' }), 'failed not_found'],
    ['a negative scene count', () => f.api.read({ storyId, scenes: -1 }), 'failed invalid_request'],
    ['a seed without a date', () => f.api.createSeed({ requestId: 'bad', text: 'no date here' }), 'failed seed_format'],
    ['a request id with a space', () => f.api.createSeed({ requestId: 'a b', text: SEED }), 'failed invalid_request'],
    ['the read-only process\'s status', () => reader.api.status({ requestId: 'start-1' }), 'running'],
    ['the read-only process\'s wait', () => reader.api.wait({ requestId: 'start-1', seconds: 0 }), 'running'],
    ['the read-only process\'s read', () => reader.api.read({ storyId }), 'done start-1'],
    ['a seed of the read-only process', () => reader.api.createSeed({ requestId: 'seed-2', text: SEED }), 'failed library_locked'],
    ['an act of the read-only process', () => reader.api.act({ requestId: 'act-9', storyId, branchId, expected: 'x' }), 'failed library_locked'],
  ] as const) {
    assert.equal(seen(await call()), expected, label);
    assert.equal(JSON.stringify(f.store.read('agent')), before, `${label} writes nothing`);
    assert.equal(f.requests.length, 1, `${label} calls no model`);
  }
  f.held[0].release();
  const done = await f.api.wait({ requestId: 'start-1', seconds: 5 });
  assert.deepEqual([done.status, turn(done).storyId, turn(done).branchId], ['done', storyId, branchId]);
  assert.equal(f.requests.length, 1);
  // The read-only process sees the finished turn and the story as the writer left them.
  assert.equal((await reader.api.wait({ requestId: 'start-1', seconds: 1 })).status, 'done');
  assert.equal(view(reader.api.read({ storyId })).revision, turn(done).revision);
});

test('the agent interface keeps the hosted-provider consent gate and never shares the bot database', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const hosted = { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: 'https://example.invalid/v1', SIMPLE_CHAT_API_KEY: 'synthetic', SIMPLE_CHAT_MODEL: 'm' };
  assert.throws(() => loadAgentConfig(directory, hosted), /synthetic probes only/);
  assert.equal(loadAgentConfig(directory, { ...hosted, SIMPLE_CHAT_ALLOW_HOSTED: 'stories-leave-this-computer' }).provider, 'openai-compatible');
  const local = loadAgentConfig(directory, {});
  assert.equal(local.dbPath, join(directory, 'data/agents.sqlite'));
  assert.equal(local.modelSocket, join(directory, 'data/simple-chat.sqlite.model.sock'));
  assert.throws(() => loadAgentConfig(directory, { SIMPLE_CHAT_AGENT_DB_PATH: 'data/simple-chat.sqlite' }), /must not be the bot database/);
  // The same file under another name: a symlinked directory, and a hard link to an existing (empty, synthetic) file.
  mkdirSync(join(directory, 'data'));
  symlinkSync(join(directory, 'data'), join(directory, 'alias'));
  assert.throws(() => loadAgentConfig(directory, { SIMPLE_CHAT_AGENT_DB_PATH: 'alias/simple-chat.sqlite' }), /must not be the bot database/);
  writeFileSync(join(directory, 'data/simple-chat.sqlite'), '');
  linkSync(join(directory, 'data/simple-chat.sqlite'), join(directory, 'data/other.sqlite'));
  assert.throws(() => loadAgentConfig(directory, { SIMPLE_CHAT_AGENT_DB_PATH: 'data/other.sqlite' }), /must not be the bot database/);
  assert.equal(loadAgentConfig(directory, { SIMPLE_CHAT_AGENT_ID: 'alice' }).agentId, 'alice');
  assert.equal(local.agentId, undefined);
});

// The provider's first call is preempted; its second fails with a code of its own, which must not reach a log.
const codes = ['background_preempted', 'PRIVATE provider text'];
// Ways a turn ends without its scene, each with its own set-up and checks; `end` returns the turn's receipt.
const endings: { label: string; options?: Options; expected: [string, string]; end: (f: Fixture) => Promise<AgentResponse> }[] = [
  { label: 'cancelled while it runs', options: { hold: true }, expected: ['failed', 'cancelled'], end: async f => {
    await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 });
    await f.until(() => f.held.length === 1);
    const cancelled = f.api.cancel({ requestId: 'start-1' });
    assert.equal(f.held[0].signal?.aborted, true, 'a cancel stops the model call');
    await f.api.idle();
    assert.equal(Object.keys(f.store.read('agent').stories.h2.nodes).length, 0, 'a cancelled turn leaves no scene');
    // An act on the empty branch starts the story, as the cancelled start would have; a cancel after its commit finds it
    // done.
    const next = await f.api.act({ requestId: 'act-1', storyId: 'h2', branchId: 'b3', expected: view(f.api.read({ storyId: 'h2' })).revision, wait: 0 });
    assert.equal(next.status, 'running');
    await f.until(() => f.held.length === 2);
    assert.match(f.held[1].request.messages.at(-1)!.content, new RegExp(narration('en').startStory));
    f.held[1].release();
    assert.equal((await f.api.wait({ requestId: 'act-1', seconds: 5 })).status, 'done');
    const after = f.api.cancel({ requestId: 'act-1' });
    assert.deepEqual([after.status, turn(after).scene!.text], ['done', '2026-08-02 20:02\n\nSynthetic scene 2.'], 'a committed turn stays done');
    return cancelled;
  } },
  { label: 'preempted, then failed', expected: ['failed', 'internal_error'],
    options: { generate: async () => { throw new ModelError(codes.shift()!, { httpStatus: 503 }); } }, end: async f => {
    const preempted = await f.api.startStory({ requestId: 'start-1', seedId: 's1' });
    assert.deepEqual([preempted.status, preempted.reason], ['preempted', 'background_preempted']);
    assert.deepEqual(preempted.result, { storyId: 'h2', branchId: 'b3', scene: null, revision: view(f.api.read({ storyId: 'h2' })).revision });
    assert.deepEqual(await f.api.startStory({ requestId: 'start-1', seedId: 's1' }), preempted, 'a preempted turn is never rerun');
    assert.equal(f.requests.length, 1);
    assert.ok(f.rows.some(row => row.event === 'agent_turn_failed' && row.code === 'background_preempted' && row.agentCall === 'start_story' && row.httpStatus === 503));
    return f.api.act({ requestId: 'act-1', storyId: 'h2', branchId: 'b3', expected: turn(preempted).revision });
  } },
  { label: 'its process died', expected: ['interrupted', 'process_exited'], options: { config: { ...config, compactAtTokens: 5800, keepScenes: 1 },
    // The scene request never returns; the memory request succeeds, so the automatic compaction commits first.
    generate: async (request, controls) => {
      if (request.purpose !== 'memory') {
        return new Promise((_, reject) => controls.signal?.addEventListener('abort', () => reject(new ModelError('cancelled')), { once: true }));
      }
      const { newScenes }: { newScenes: { id: string }[] } = JSON.parse(request.messages[0].content);
      return { text: JSON.stringify({ facts: newScenes.map(scene => ({ kind: 'event', at: '2026-08-02 20:00', text: 'The keeper held the light.', source: [scene.id] })) }), finishReason: 'stop' };
    } }, end: async f => {
    // The start never returns either; it is cancelled, and scenes large enough to cross the threshold are written
    // straight into the synthetic library.
    const { storyId, branchId } = turn(await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 }));
    f.api.cancel({ requestId: 'start-1' });
    await f.api.idle();
    f.store.mutate('agent', state => {
      state.active = { storyId, branchId };
      for (let n = 0; n < 4; n++) commitTurn(state, beginJob(state, `Synthetic move ${n}`, n).id, `2026-08-02 20:00\n\n${'The keeper watched the sea. '.repeat(80)}`);
    });
    const expected = view(f.api.read({ storyId })).revision;
    assert.equal((await f.api.act({ requestId: 'act-1', storyId, branchId, expected, wait: 0 })).status, 'running');
    await f.until(() => f.requests.filter(r => r.purpose !== 'memory').length === 2 && !!f.store.read('agent').stories[storyId].branches[branchId].memory);
    // The process "dies": nothing closes it. The next writer opens the same file, and its receipt names the compaction.
    const next = f.open();
    const receipt = next.api.status({ requestId: 'act-1' });
    const result = turn(receipt);
    assert.equal(result.scene, null);
    assert.deepEqual(result.compaction!.checkpoints.map(cp => cp.kind), ['pre-compaction', 'compaction']);
    const saved = view(next.api.read({ storyId, memory: true }));
    assert.equal(result.revision, saved.revision);
    assert.equal(saved.sceneCount, 4);
    assert.deepEqual(saved.memory!.map(m => m.memoryId), result.compaction!.memoryIds);
    assert.deepEqual(saved.memory![0].facts.map(fact => fact.source[0]), saved.memory![0].covered);
    // The old process's late cancel cannot undo that.
    assert.equal((await next.api.wait({ requestId: 'act-1', seconds: 0 })).status, 'interrupted');
    return receipt;
  } },
  { label: 'a clean stop', options: { hold: true }, expected: ['interrupted', 'shutdown'], end: async f => {
    assert.equal((await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 })).status, 'running');
    await f.until(() => f.held.length === 1);
    const pending = f.api.wait({ requestId: 'start-1', seconds: 5 });
    await f.api.close();
    const stopped = await pending;
    assert.deepEqual(stopped.result, { storyId: 'h2', branchId: 'b3', scene: null, revision: view(f.api.read({ storyId: 'h2' })).revision });
    return stopped;
  } },
];
test('a turn that ends without its scene keeps a safe receipt and is never rerun: cancelled, preempted, failed, cut off, stopped', async t => {
  for (const row of endings) {
    const f = fixture(t, row.options);
    f.api.createSeed({ requestId: 'seed-1', text: SEED });
    const receipt = await row.end(f);
    assert.deepEqual([receipt.status, receipt.reason], row.expected, row.label);
    // The receipt stays, the library holds no job, and the next process starts nothing.
    const calls = f.requests.length;
    const next = f.open();
    assert.deepEqual(next.api.status({ requestId: receipt.requestId }), receipt, row.label);
    await next.api.idle();
    assert.equal(next.store.read('agent').job, null, row.label);
    assert.equal(f.requests.length, calls, row.label);
    // Only technical rows, all of them the agent's, and none with the provider's text.
    assert.ok(f.rows.every(r => r.actor === 'agent') && !JSON.stringify(f.rows).includes('PRIVATE'), row.label);
  }
});

test('the model route is chosen before every call: the bot\'s queue once it answers, simple-serving directly as an agent', async t => {
  // A llama.cpp connection to a closed local port: a direct call, if one were made, would fail without reaching a
  // model.
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadAgentConfig(directory, { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:9' });
  mkdirSync(dirname(config.modelSocket), { recursive: true });
  const synthetic: ModelRequest = { system: 's', messages: [{ role: 'user', content: 'u' }], maxOutputTokens: 16, estimatedInputTokens: 7 };
  // No socket yet: the direct provider is chosen but not created, so nothing is launched.
  const { provider, queue } = await agentProvider(config);
  assert.equal(queue, false);
  // The bot starts later and serves its queue: the next call goes through it, and so does a turn that begins there.
  const scheduler = createScheduler({ generate: async () => ({ text: 'queued scene', finishReason: 'stop' }) }, { quietMs: 0 });
  t.after(() => scheduler.close());
  const bot = await serveBackground({ socketPath: config.modelSocket, scheduler, status: () => ({ model: config.model, gpu: { status: 'ready' } }) });
  assert.equal((await provider.generate(synthetic)).text, 'queued scene');
  assert.equal(await provider.countInput!(synthetic), 7);
  const queued = provider.openTurn!();
  assert.equal((await queued.generate(synthetic)).text, 'queued scene');
  // The queue goes away: the turn ends there and never goes on directly.
  await bot.close();
  await assert.rejects(queued.generate(synthetic), { code: 'background_unavailable' });
  await assert.rejects(queued.countInput!(synthetic), { code: 'background_unavailable' });
  queued.end();
  await assert.rejects(queued.generate(synthetic), { code: 'cancelled' });

  // Another bot's queue answers its status but never a turn's control request: a cancel of the turn's call settles.
  const other = loadAgentConfig(directory, { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:9', SIMPLE_CHAT_DB_PATH: 'data/other.sqlite' });
  const opening = Promise.withResolvers<void>();
  let asked = 0;
  const silent = http.createServer((req, res) => {
    asked++;
    if (req.url !== '/status') return opening.resolve();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: other.model, gpu: { status: 'ready' } }));
  });
  await new Promise<void>(resolve => silent.listen(other.modelSocket, resolve));
  t.after(() => { silent.closeAllConnections(); return new Promise(resolve => silent.close(resolve)); });
  const stuck = (await agentProvider(other)).provider.openTurn!();
  const controller = new AbortController();
  const pending = stuck.generate(synthetic, { signal: controller.signal });
  await opening.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  stuck.end();

  // simple-serving is called directly, as an agent, once it has passed a check, even while that other bot's queue
  // answers on its socket. A synthetic gateway: the state each case sets, the models route with the same context, a
  // count and a stream. It keeps every call, and whose each count or generation said it was.
  let state: [number, { readonly [field: string]: unknown }] = [503, {}];
  const seen: string[] = [];
  const gateway = http.createServer((req, res) => {
    seen.push([req.method, req.url, req.headers['x-simple-serving-class'], req.headers['x-simple-serving-scope']].filter(Boolean).join(' '));
    req.resume();
    const send = (status: number, value: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/state') return send(...state);
    if (req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: 'synthetic-alias', max_model_len: state[1].context_tokens }] });
    if (req.url?.endsWith('/input_tokens')) return send(200, { input_tokens: 7 });
    const event = (value: object) => `data: ${JSON.stringify({ model: 'synthetic-alias', ...value })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(event({ choices: [{ index: 0, delta: { content: 'direct scene' }, finish_reason: 'stop' }] })
      + event({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }) + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const serving = loadAgentConfig(directory, { SIMPLE_CHAT_PROVIDER: 'simple-serving', SIMPLE_CHAT_API_KEY: 'synthetic-key', SIMPLE_CHAT_DB_PATH: 'data/other.sqlite',
    SIMPLE_CHAT_MODEL: 'synthetic-alias', SIMPLE_CHAT_BASE_URL: `http://127.0.0.1:${(gateway.address() as { port: number }).port}` });
  assert.equal(serving.modelSocket, other.modelSocket);
  asked = 0;
  // A service of another contract, model or context gets no text, neither a count nor a generation.
  const ready = { contract: '2', status: 'ready', model: 'synthetic-alias', context_tokens: serving.contextTokens };
  for (const [answer, code] of [[{ ...ready, contract: '1' }, 'unsupported_server'], [{ ...ready, contract: 2 }, 'unsupported_server'],
    [{ ...ready, model: 'other-alias' }, 'unexpected_model'], [{ ...ready, context_tokens: serving.contextTokens - 1 }, 'context_limit']] as const) {
    state = [200, answer];
    const { provider } = await agentProvider(serving);
    await assert.rejects(provider.countInput!(synthetic), { code });
    await assert.rejects(provider.generate(synthetic), { code });
  }
  assert.deepEqual(seen.filter(call => !call.startsWith('GET ')), []);
  // A check that fails stops its call, and the next call checks again. Once one has passed, the counts and the
  // generations go on without another, and say they are the agent's.
  const direct = await agentProvider(serving);
  state = [503, { error: { code: 'starting' } }];
  await assert.rejects(direct.provider.generate(synthetic), { code: 'model_unavailable' });
  state = [200, ready];
  seen.length = 0;
  const own = direct.provider.openTurn!();
  assert.equal(await own.countInput!(synthetic), 7);
  assert.equal((await own.generate(synthetic)).text, 'direct scene');
  own.end();
  assert.equal((await direct.provider.generate(synthetic)).text, 'direct scene');
  assert.deepEqual([direct.queue, asked], [false, 0]);
  assert.deepEqual(seen, ['GET /v1/state', 'GET /v1/models', 'POST /v1/chat/completions/input_tokens agent agent',
    'POST /v1/chat/completions agent agent', 'POST /v1/chat/completions/input_tokens agent agent', 'POST /v1/chat/completions agent agent']);
});
