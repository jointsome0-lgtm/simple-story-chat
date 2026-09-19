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
type Held = { request: ModelRequest; signal?: AbortSignal; release: (result?: GenerationResult) => void; fail: (error: unknown) => void };

const config = { model: 'test-model', provider: 'claude-code', maxOutputTokens: 1024, contextTokens: 65536, compactAtTokens: 54000, keepScenes: 4 };

function fixture(t: TestContext, options: { hold?: boolean; generate?: (request: ModelRequest, controls: GenerateControls) => Promise<GenerationResult> } & Partial<AgentOptions> = {}) {
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
      held.push({ request, signal: controls.signal, release: result => resolve(result ?? scene), fail: reject });
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
  async function story(target = api) {
    const seed = target.createSeed({ requestId: 'seed-1', text: SEED });
    const started = await target.startStory({ requestId: 'start-1', seedId: (seed.result as { seedId: string }).seedId });
    return started;
  }
  return { api, store, open, requests, held, rows, path, until, story };
}

const turn = (response: AgentResponse) => response.result as Turn;

test('a story runs through the agent interface: seed, start, act, continue, read', async t => {
  const f = fixture(t);
  const seed = f.api.createSeed({ requestId: 'seed-1', text: SEED });
  assert.deepEqual(seed, { requestId: 'seed-1', status: 'done', result: { seedId: 's1', title: 'Lighthouse', worldTime: '2026-08-02 20:00' } });
  const started = await f.api.startStory({ requestId: 'start-1', seedId: 's1' });
  assert.equal(started.status, 'done');
  const first = turn(started);
  assert.equal(first.scene!.text, '2026-08-02 20:01\n\nSynthetic scene 1.');
  assert.equal(first.scene!.worldTime, '2026-08-02 20:01');
  assert.match(f.requests[0].messages.at(-1)!.content, new RegExp(narration('en').startStory));
  // Every scene gets a checkpoint that carries its head and memory.
  const view = f.api.read({ storyId: first.storyId, branchId: first.branchId }).result as View;
  assert.equal(view.revision, first.revision);
  assert.deepEqual(view.checkpoints.map(cp => cp.kind), ['start', 'scene']);
  assert.equal(view.checkpoints[1].checkpointId, first.checkpointId);

  const acted = await f.api.act({ requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'I light the lamp.' });
  assert.equal(acted.status, 'done');
  assert.notEqual(turn(acted).revision, first.revision);
  assert.match(f.requests[1].messages.at(-1)!.content, /I light the lamp\./);
  // Empty input is "continue".
  const continued = await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId: first.branchId, expected: turn(acted).revision });
  assert.equal(continued.status, 'done');
  assert.match(f.requests[2].messages.at(-1)!.content, new RegExp(narration('en').continueStory));
  const after = f.api.read({ storyId: first.storyId, scenes: 2 }).result as View;
  assert.equal(after.sceneCount, 3);
  assert.deepEqual(after.scenes.map(s => s.input), ['I light the lamp.', narration('en').continueStory]);
  // The agent library stores English labels and the scene's metadata as the bot does.
  const state = f.store.read('agent');
  const node = state.stories[first.storyId].nodes[turn(continued).scene!.sceneId];
  assert.deepEqual(node.modelInfo, { provider: 'claude-code', model: 'test-model' });
  assert.equal(node.usage?.inputTokens, 100);
  assert.equal(node.requestContext?.model, 'test-model');
  assert.equal(state.stories[first.storyId].checkpoints[turn(continued).checkpointId].label, 'Scene 3');
  assert.equal(state.job, null);
});

test('a repeated requestId returns the stored result before any state check, and a different payload conflicts', async t => {
  const f = fixture(t);
  const first = turn(await f.story());
  const payload = { requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'Go north.' };
  const done = await f.api.act(payload);
  const next = await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId: first.branchId, expected: turn(done).revision, input: 'Go on.' });
  assert.equal(next.status, 'done');
  const calls = f.requests.length;
  // The branch has moved since act-1, and a retry after success must not see that as stale.
  assert.deepEqual(await f.api.act(payload), done);
  assert.deepEqual(await f.api.startStory({ requestId: 'start-1', seedId: 's1' }), (await f.api.status({ requestId: 'start-1' })));
  assert.equal(f.requests.length, calls, 'a replay never generates');
  assert.deepEqual(await f.api.act({ ...payload, input: 'Go south.' }), { requestId: 'act-1', status: 'conflict', reason: 'request_id_reused' });
  assert.equal(f.api.createSeed({ requestId: 'act-1', text: SEED }).status, 'conflict');
  assert.deepEqual(f.api.createSeed({ requestId: 'seed-1', text: SEED }).result, { seedId: 's1', title: 'Lighthouse', worldTime: '2026-08-02 20:00' });
  assert.equal(Object.keys(f.store.read('agent').seeds).length, 1);
});

test('act with an old revision is stale and generates nothing', async t => {
  const f = fixture(t);
  const first = turn(await f.story());
  await f.api.act({ requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision });
  const calls = f.requests.length;
  const stale = await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'Late move.' });
  assert.equal(stale.status, 'stale');
  assert.equal((stale.result as { revision: string }).revision, (f.api.read({ storyId: first.storyId }).result as View).revision);
  assert.equal(f.requests.length, calls);
  // A rejection is not a receipt: the same key may be used again once the client has the current revision.
  assert.equal(f.api.status({ requestId: 'act-2' }).reason, 'unknown_request');
});

test('a long turn returns running; wait and status never start anything; one job at a time is busy', async t => {
  const f = fixture(t, { hold: true });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  const running = await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 });
  assert.equal(running.status, 'running');
  const { storyId, branchId } = running.result as Turn;
  assert.equal((await f.api.wait({ requestId: 'start-1', seconds: 0.01 })).status, 'running');
  assert.equal(f.api.status({ requestId: 'start-1' }).status, 'running');
  assert.equal((f.api.read({ storyId }).result as View).runningRequestId, 'start-1');
  const busy = await f.api.startStory({ requestId: 'start-2', seedId: 's1' });
  assert.deepEqual(busy, { requestId: 'start-2', status: 'busy', reason: 'job_running', result: { runningRequestId: 'start-1' } });
  assert.equal((await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 })).status, 'running');
  assert.equal(f.requests.length, 1);
  await f.until(() => f.held.length === 1);
  f.held[0].release();
  const done = await f.api.wait({ requestId: 'start-1', seconds: 5 });
  assert.equal(done.status, 'done');
  assert.equal(turn(done).storyId, storyId);
  assert.equal(turn(done).branchId, branchId);
  assert.equal(f.requests.length, 1);
  assert.equal(f.api.status({ requestId: 'nobody' }).reason, 'unknown_request');
});

test('cancel ends a running turn without a scene; after a commit the turn stays done', async t => {
  const f = fixture(t, { hold: true });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 });
  await f.until(() => f.held.length === 1);
  const cancelled = f.api.cancel({ requestId: 'start-1' });
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(f.held[0].signal?.aborted, true);
  await f.api.idle();
  const state = f.store.read('agent');
  assert.equal(state.job, null);
  assert.equal(Object.keys(state.stories.h2.nodes).length, 0);
  assert.equal(f.api.status({ requestId: 'start-1' }).reason, 'cancelled');

  const branch = f.api.read({ storyId: 'h2' }).result as View;
  const next = await f.api.act({ requestId: 'act-1', storyId: 'h2', branchId: 'b3', expected: branch.revision, wait: 0 });
  assert.equal(next.status, 'running');
  await f.until(() => f.held.length === 2);
  // An empty branch starts the story, as the cancelled start would have.
  assert.match(f.held[1].request.messages.at(-1)!.content, new RegExp(narration('en').startStory));
  f.held[1].release();
  assert.equal((await f.api.wait({ requestId: 'act-1', seconds: 5 })).status, 'done');
  const after = f.api.cancel({ requestId: 'act-1' });
  assert.equal(after.status, 'done');
  assert.equal(turn(after).scene!.text, '2026-08-02 20:02\n\nSynthetic scene 2.');
});

test('a preempted or failed turn ends with a safe code and is never rerun', async t => {
  let code = 'background_preempted';
  const f = fixture(t, { generate: async () => { throw new ModelError(code, { httpStatus: 503 }); } });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  const preempted = await f.api.startStory({ requestId: 'start-1', seedId: 's1' });
  assert.equal(preempted.status, 'preempted');
  assert.equal(preempted.reason, 'background_preempted');
  assert.deepEqual(preempted.result, { storyId: 'h2', branchId: 'b3', scene: null, revision: (f.api.read({ storyId: 'h2' }).result as View).revision });
  assert.deepEqual(await f.api.startStory({ requestId: 'start-1', seedId: 's1' }), preempted);
  assert.equal(f.requests.length, 1);
  code = 'PRIVATE provider text';
  const failed = await f.api.act({ requestId: 'act-1', storyId: 'h2', branchId: 'b3', expected: (preempted.result as Turn).revision });
  assert.deepEqual([failed.status, failed.reason], ['failed', 'internal_error']);
  assert.equal(f.store.read('agent').job, null);
  assert.ok(!JSON.stringify(f.rows).includes('PRIVATE'));
  assert.ok(f.rows.every(row => row.actor === 'agent'));
  assert.ok(f.rows.some(row => row.event === 'agent_turn_failed' && row.code === 'background_preempted' && row.agentCall === 'start_story' && row.httpStatus === 503));
});

test('a process that dies mid-turn leaves an interrupted receipt naming the compaction it saved', async t => {
  // The scene request never returns; the memory request succeeds, so the automatic compaction commits first.
  const f = fixture(t, { config: { ...config, compactAtTokens: 5800, keepScenes: 1 }, generate: async (request, controls) => {
    if (request.purpose !== 'memory') {
      return new Promise((_, reject) => controls.signal?.addEventListener('abort', () => reject(new ModelError('cancelled')), { once: true }));
    }
    const { newScenes }: { newScenes: { id: string }[] } = JSON.parse(request.messages[0].content);
    return { text: JSON.stringify({ facts: newScenes.map(scene => ({ kind: 'event', at: '2026-08-02 20:00', text: 'The keeper held the light.', source: [scene.id] })) }), finishReason: 'stop' };
  } });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  // The start never returns either; it is cancelled, and scenes large enough to cross the threshold are written
  // straight into the synthetic library.
  const opened = await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 });
  const { storyId, branchId } = opened.result as Turn;
  f.api.cancel({ requestId: 'start-1' });
  await f.api.idle();
  f.store.mutate('agent', state => {
    state.active = { storyId, branchId };
    for (let n = 0; n < 4; n++) {
      const job = beginJob(state, `Synthetic move ${n}`, n);
      commitTurn(state, job.id, `2026-08-02 20:00\n\n${'The keeper watched the sea. '.repeat(80)}`);
    }
  });
  const expected = (f.api.read({ storyId }).result as View).revision;
  assert.equal((await f.api.act({ requestId: 'act-1', storyId, branchId, expected, wait: 0 })).status, 'running');
  await f.until(() => f.requests.filter(r => r.purpose !== 'memory').length === 2 && !!f.store.read('agent').stories[storyId].branches[branchId].memory);
  // The process "dies": nothing closes it. The next writer opens the same file.
  const next = f.open();
  const receipt = next.api.status({ requestId: 'act-1' });
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.reason, 'process_exited');
  const result = receipt.result as Turn;
  assert.equal(result.scene, null);
  assert.deepEqual(result.compaction!.checkpoints.map(cp => cp.kind), ['pre-compaction', 'compaction']);
  const view = next.api.read({ storyId, memory: true }).result as View;
  assert.equal(result.revision, view.revision);
  assert.equal(view.sceneCount, 4);
  assert.deepEqual(view.memory!.map(m => m.memoryId), result.compaction!.memoryIds);
  assert.deepEqual(view.memory![0].facts.map(fact => fact.source[0]), view.memory![0].covered);
  assert.equal(next.store.read('agent').job, null);
  // The old process's late cancel cannot undo that.
  assert.equal((await next.api.wait({ requestId: 'act-1', seconds: 0 })).status, 'interrupted');
});

test('fork starts a branch from a checkpoint, with its head and memory, and branches move apart', async t => {
  const f = fixture(t);
  const first = turn(await f.story());
  const second = turn(await f.api.act({ requestId: 'act-1', storyId: first.storyId, branchId: first.branchId, expected: first.revision, input: 'Open the door.' }));
  const forked = f.api.fork({ requestId: 'fork-1', storyId: first.storyId, checkpointId: first.checkpointId });
  assert.equal(forked.status, 'done');
  const { branchId, revision } = forked.result as { branchId: string; revision: string };
  assert.notEqual(branchId, first.branchId);
  const branch = f.api.read({ storyId: first.storyId, branchId }).result as View;
  assert.equal(branch.revision, revision);
  assert.deepEqual(branch.scenes.map(s => s.sceneId), [first.scene!.sceneId]);
  const other = turn(await f.api.act({ requestId: 'act-2', storyId: first.storyId, branchId, expected: revision, input: 'Keep the door shut.' }));
  assert.equal((f.api.read({ storyId: first.storyId, branchId: first.branchId }).result as View).revision, second.revision);
  assert.equal((f.api.read({ storyId: first.storyId, branchId }).result as View).revision, other.revision);
  assert.deepEqual(f.api.fork({ requestId: 'fork-1', storyId: first.storyId, checkpointId: first.checkpointId }), forked);
  assert.equal(f.api.fork({ requestId: 'fork-2', storyId: first.storyId, checkpointId: 'constructor' }).reason, 'not_found');
});

test('read has no side effects and refuses keys that are not library ids', async t => {
  const f = fixture(t);
  const first = turn(await f.story());
  const before = JSON.stringify(f.store.read('agent'));
  const overview = f.api.read().result as { seeds: unknown[]; stories: { branches: unknown[] }[] };
  assert.equal(overview.seeds.length, 1);
  assert.equal(overview.stories[0].branches.length, 1);
  assert.equal(f.api.read({ storyId: first.storyId, scenes: 0, memory: true }).status, 'done');
  assert.equal(f.api.read({ storyId: 'constructor' }).reason, 'not_found');
  assert.equal(f.api.read({ storyId: first.storyId, branchId: '__proto__' }).reason, 'not_found');
  assert.equal(f.api.read({ storyId: first.storyId, scenes: -1 }).reason, 'invalid_request');
  assert.equal(JSON.stringify(f.store.read('agent')), before);
  assert.equal(f.api.createSeed({ requestId: 'bad', text: 'no date here' }).reason, 'seed_format');
  assert.equal(f.api.createSeed({ requestId: 'a b', text: SEED }).reason, 'invalid_request');
});

test('a read-only process sees receipts and stories but writes nothing', async t => {
  const f = fixture(t);
  const first = turn(await f.story());
  const reader = f.open({ readOnly: true });
  assert.equal(reader.api.status({ requestId: 'start-1' }).status, 'done');
  assert.equal((await reader.api.wait({ requestId: 'start-1', seconds: 1 })).status, 'done');
  assert.equal((reader.api.read({ storyId: first.storyId }).result as View).revision, first.revision);
  assert.equal(reader.api.createSeed({ requestId: 'seed-2', text: SEED }).reason, 'library_locked');
  assert.equal((await reader.api.act({ requestId: 'act-9', storyId: first.storyId, branchId: first.branchId, expected: first.revision })).reason, 'library_locked');
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

test('the model route is chosen before every call, so a bot started later gets its queue', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadAgentConfig(directory, {});
  mkdirSync(dirname(config.modelSocket), { recursive: true });
  // No socket yet: the direct provider is chosen but not created, so nothing is launched.
  const { provider, queue } = await agentProvider(config);
  assert.equal(queue, false);
  // The bot starts and serves its queue; a synthetic stand-in answers its two routes.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/status' ? { model: config.model, gpu: { status: 'ready' } }
      : { text: 'queued scene', finishReason: 'stop', usage: null }));
  });
  await new Promise<void>(resolve => server.listen(config.modelSocket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request: ModelRequest = { system: 's', messages: [{ role: 'user', content: 'u' }], maxOutputTokens: 16, estimatedInputTokens: 7 };
  assert.equal((await provider.generate(request)).text, 'queued scene');
  assert.equal(await provider.countInput!(request), 7);
});

test('a clean stop ends a running turn as interrupted, and the next process starts nothing', async t => {
  const f = fixture(t, { hold: true });
  f.api.createSeed({ requestId: 'seed-1', text: SEED });
  assert.equal((await f.api.startStory({ requestId: 'start-1', seedId: 's1', wait: 0 })).status, 'running');
  await f.until(() => f.held.length === 1);
  const pending = f.api.wait({ requestId: 'start-1', seconds: 5 });
  await f.api.close();
  const stopped = await pending;
  assert.deepEqual([stopped.status, stopped.reason], ['interrupted', 'shutdown']);
  assert.deepEqual(stopped.result, { storyId: 'h2', branchId: 'b3', scene: null, revision: (f.api.read({ storyId: 'h2' }).result as View).revision });
  assert.equal(f.store.read('agent').job, null);
  const next = f.open();
  assert.equal(next.api.status({ requestId: 'start-1' }).reason, 'shutdown');
  assert.equal(f.requests.length, 1);
});

test('a compaction stage passes the log whitelist only as a known value', () => {
  assert.deepEqual(safeErrorDetails({ actor: 'agent', stage: 'extracting' }), { actor: 'agent', stage: 'extracting' });
  assert.deepEqual(safeErrorDetails({ stage: 'a line of the story' }), {});
});

// A llama.cpp connection to a closed local port: a direct call, if one were made, would fail without reaching a model.
function queueFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-turn-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = loadAgentConfig(directory, { SIMPLE_CHAT_PROVIDER: 'llama-cpp', SIMPLE_CHAT_BASE_URL: 'http://127.0.0.1:9' });
  mkdirSync(dirname(config.modelSocket), { recursive: true });
  return config;
}
const synthetic: ModelRequest = { system: 's', messages: [{ role: 'user', content: 'u' }], maxOutputTokens: 16, estimatedInputTokens: 7 };

test('a turn that began in the bot queue ends when the queue goes away and never goes on directly', async t => {
  const config = queueFixture(t);
  const scheduler = createScheduler({ generate: async () => ({ text: 'queued scene', finishReason: 'stop' }) }, { quietMs: 0 });
  t.after(() => scheduler.close());
  const server = await serveBackground({ socketPath: config.modelSocket, scheduler,
    status: () => ({ model: config.model, gpu: { status: 'ready' } }) });
  const { provider } = await agentProvider(config);
  const turn = provider.openTurn!();
  assert.equal((await turn.generate(synthetic)).text, 'queued scene');
  await server.close();
  await assert.rejects(turn.generate(synthetic), { code: 'background_unavailable' });
  await assert.rejects(turn.countInput!(synthetic), { code: 'background_unavailable' });
  turn.end();
  await assert.rejects(turn.generate(synthetic), { code: 'cancelled' });
});

test('cancelling a turn while its control request opens settles at once', async t => {
  const config = queueFixture(t);
  // A bot that answers its status but never its turn request.
  const server = http.createServer((req, res) => {
    if (req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: config.model, gpu: { status: 'ready' } })); }
  });
  await new Promise<void>(resolve => server.listen(config.modelSocket, resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { provider } = await agentProvider(config);
  const turn = provider.openTurn!();
  const controller = new AbortController();
  const pending = turn.generate(synthetic, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  turn.end();
});
