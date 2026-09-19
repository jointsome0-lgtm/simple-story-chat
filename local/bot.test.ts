import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { createBot } from './bot.ts';
import { loadConfig } from './config.ts';
import type { BotOptions, Update } from './bot.ts';
import { createGpu } from './gpu.ts';
import type { GpuController } from './gpu.ts';
import type { ErrorDetails } from './model-error.ts';
import { ModelError, safeErrorDetails } from './model-error.ts';
import type { Controls, GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import type { TelegramPayload } from './telegram.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { texts } from './text.ts';
import { UserError, addSeed, history, newStory, beginJob, commitTurn, context } from '../lib/library.ts';
import type { Job, SeedDraft } from '../lib/library.ts';

// Scene and memory requests from the bot always pass a text callback.
type TextControls = GenerateControls & Required<Pick<GenerateControls, 'onText'>>;
type FixtureOptions = {
  progressFailure?: boolean; contextFailure?: boolean; deliveryFailure?: boolean;
  generate?: (request: ModelRequest, controls: TextControls) => Promise<GenerationResult>;
  check?: Provider['check']; gpu?: GpuController; readSeedFile?: BotOptions['readSeedFile'];
  model?: string; providerName?: string; compactAtTokens?: number; ownerId?: string;
  // Holds a Telegram call until the returned promise settles.
  hold?: (method: string, payload: Payload) => Promise<void> | undefined;
};
// A log row as main.ts writes it: the event, a code and the allowed details.
type Row = { event: string; code?: string | number } & ErrorDetails;
// Fields of sent payloads that the tests read; each is present for the methods where it is read.
type Payload = { chat_id: number; message_id: number; text: string; rich_message: { markdown: string }; draft_id: number };
// A synthetic private message; tests may replace its chat or add rich content, a document or a caption.
type MessageUpdate = Update & { message: NonNullable<Update['message']> & { chat: { id: number; type: string }; caption?: string } };
// Summary requests carry their scenes as JSON in the first message.
type SummaryInput = { newScenes: { id: string }[] };

const seedText = 'Маяк\n2026-08-02 20:00\nСмотритель встречает лодку. Кодовая фраза: СЕВЕР.';
function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-test-'));
  const path = join(directory, 'story.sqlite');
  const store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const sent: { method: string; payload: Payload }[] = [];
  const rows: Row[] = [];
  const requests: ModelRequest[] = [];
  let sequence = 0;
  const api = async (method: string, fields?: TelegramPayload) => {
    const payload = fields as Payload;
    await options.hold?.(method, payload);
    if (options.progressFailure && ['sendMessage', 'editMessageText'].includes(method) && payload.text.startsWith('🗜')) {
      throw Object.assign(new Error('PRIVATE TRANSPORT ERROR'), { code: 'network' });
    }
    if (options.contextFailure && method === 'sendMessage' && payload.text.startsWith('📏')) throw Object.assign(new Error('synthetic'), { code: 'network' });
    if (method === 'sendRichMessage') {
      const state = store.read(payload.chat_id);
      assert.ok(Object.values(state.stories).some(story => Object.values(story.nodes).some(node => payload.rich_message.markdown.endsWith(node.text)))
        || payload.rich_message.markdown.includes('Кодовая фраза'), 'scenes must be saved before delivery');
      if (options.deliveryFailure) throw Object.assign(new Error('synthetic'), { code: 'network' });
    }
    sent.push({ method, payload });
    return { message_id: sent.length };
  };
  const provider: Provider = { async generate(request, controls?: TextControls) {
    requests.push(request);
    if (options.generate) return options.generate(request, controls!);
    await controls!.onText('2026-08-02 20:00\n\n');
    return { text: `2026-08-02 20:00\n\nСинтетическая сцена ${requests.length}.`, finishReason: 'stop',
      usage: { inputTokens: 100 + requests.length, outputTokens: 50, totalTokens: 150 + requests.length } };
  } };
  if (options.check) provider.check = options.check;
  const bot = createBot({ store, api, provider, gpu: options.gpu, allowedUsers: new Set(['1', '2']), maxOutputTokens: 4096,
    readSeedFile: options.readSeedFile, render, scenePrefix, sceneKeyboard, model: options.model ?? 'test-model',
    providerName: options.providerName ?? 'claude-code', compactAtTokens: options.compactAtTokens ?? 54000, ownerId: options.ownerId,
    log: (event, code, details) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); } });
  const message = (text: string | undefined, user = 1, updateId = ++sequence): MessageUpdate => ({ update_id: updateId,
    message: { from: { id: user, language_code: 'ru' }, chat: { id: user, type: 'private' }, text } });
  const click = (data: string, user = 1) => ({ update_id: ++sequence,
    callback_query: { id: `q${sequence}`, from: { id: user, language_code: 'ru' }, message: { chat: { id: user, type: 'private' } }, data } });
  async function seed(user = 1) {
    await bot.handle(click('new-seed', user));
    await bot.handle(message(seedText, user));
    await bot.handle(click(`save-seed:${(store.read(user).ui as SeedDraft).draftId}`, user));
    return Object.keys(store.read(user).seeds)[0];
  }
  async function start(user = 1) {
    const id = await seed(user);
    const update = click(`start:${id}`, user);
    await bot.handle(update);
    await bot.idle();
    return update;
  }
  return { bot, store, sent, rows, requests, message, click, seed, start, path, api, provider };
}

async function battleFixture(f: ReturnType<typeof fixture>) {
  const seedId = await f.seed();
  f.store.mutate('1', state => {
    newStory(state, seedId);
    for (let n = 0; n < 7; n++) {
      const job = beginJob(state, `Синтетический ход ${n}`, n);
      commitTurn(state, job.id, `2026-08-02 20:00\n\n${'Защитники держали ворота. '.repeat(100)}`);
    }
  });
}

function compactResult(request: ModelRequest): GenerationResult {
  assert.equal(request.purpose, 'memory');
  const { newScenes }: SummaryInput = JSON.parse(request.messages[0].content);
  return { text: JSON.stringify({ facts: newScenes.map(scene => ({ kind: 'event', at: '2026-08-02 20:00',
    text: 'Защитники удерживали ворота.', source: [scene.id] })) }), finishReason: 'stop' };
}

test('/compact is explicit, deduplicated, archives originals and never creates a scene', async t => {
  const f = fixture(t, { generate: async request => compactResult(request) });
  await battleFixture(f);
  const before = f.store.read('1');
  const update = f.message('/compact');
  await f.bot.handle(update);
  await f.bot.idle();
  await f.bot.handle(update);
  await f.bot.idle();
  const state = f.store.read('1');
  const story = state.stories[state.active!.storyId];
  assert.equal(state.job, null);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(story.nodes, before.stories[story.id].nodes);
  assert.equal(context(story, story.branches[state.active!.branchId]).recent.length, 4);
  assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'pre-compaction').length, 1);
  assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'compaction').length, 1);
  assert.ok(f.sent.some(m => m.payload.text?.includes('Сжатие готово')));
  await f.bot.handle(f.click('compact'));
  await f.bot.idle();
  assert.equal(f.requests.length, 1, 'retained tail cannot be silently discarded');
  assert.match(f.sent.at(-1)!.payload.text, /нечего сжимать/);
});

test('log rows of a user request say owner or other, never who; compaction rows carry sizes and counts', async t => {
  for (const ownerId of ['1', undefined]) {
    const f = fixture(t, { ownerId, generate: async request => {
      if (request.purpose === 'memory') return compactResult(request);
      throw new ModelError('provider_failed', { phase: 'generate', transportCode: 'UND_ERR_SOCKET' });
    } });
    await battleFixture(f);
    await f.bot.handle(f.message('/compact'));
    await f.bot.idle();
    const first = ownerId ? 'owner' : 'other';
    assert.ok(f.rows.length > 3 && f.rows.every(row => row.actor === first));
    const compaction = f.rows.filter(row => row.sceneCount !== undefined);
    assert.deepEqual(compaction.map(row => row.event), ['compaction_request_started', 'compaction_request_completed', 'memory_compacted']);
    const { elapsedMs, requestBytes, inputBytesBefore, inputBytesAfter, ...saved } = compaction[2];
    assert.deepEqual(saved, { event: 'memory_compacted', actor: first, automatic: false, sceneCount: 3, repairSceneCount: 0, factCount: 3, outputCharacters: 0 });
    assert.ok(elapsedMs! >= 0 && requestBytes! > 0 && inputBytesAfter! < inputBytesBefore!);
    // The tester's failed scene: the row has the transport details and no trace of whose library it was.
    const before = f.rows.length;
    await f.start(2);
    const other = f.rows.slice(before);
    assert.ok(other.length > 1 && other.every(row => row.actor === 'other'));
    assert.deepEqual(other.find(row => row.event === 'generation_failed'),
      { event: 'generation_failed', code: 'provider_failed', phase: 'generate', transportCode: 'UND_ERR_SOCKET', actor: 'other' });
    assert.doesNotMatch(JSON.stringify(f.rows), /Защитники|Синтетический|Кодовая|СЕВЕР|userId|"1"|"2"/);
  }
});

test('the owner ID is optional, but one outside the access list stops the start instead of mislabelling rows', () => {
  const env = { TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1, 2' };
  const load = (ownerId?: string) => loadConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_OWNER_ID: ownerId }).ownerId;
  assert.equal(load(), '');
  assert.equal(load(' 2 '), '2');
  // The message names the two settings and never the rejected value.
  assert.throws(() => load('3'), { message: 'SIMPLE_CHAT_OWNER_ID must be one of SIMPLE_CHAT_ALLOWED_USER_IDS' });
  assert.throws(() => load('PRIVATE'), error => !/PRIVATE/.test((error as Error).message));
});

test('/cancel stops explicit compaction and rejects its late response', async t => {
  let release: (() => void) | undefined;
  const f = fixture(t, { generate: request => new Promise<GenerationResult>(resolve => { release = () => resolve(compactResult(request)); }) });
  await battleFixture(f);
  await f.bot.handle(f.message('/compact'));
  assert.equal(f.store.read('1').job!.kind, 'compact');
  await f.bot.handle(f.message('/continue'));
  assert.equal(f.requests.length, 1);
  await f.bot.handle(f.message('/cancel'));
  release!();
  await f.bot.idle();
  const state = f.store.read('1');
  assert.equal(state.job, null);
  assert.equal(Object.keys(state.stories[state.active!.storyId].memories).length, 0);
  assert.ok(!f.sent.some(m => m.payload.text?.includes('Сжатие готово')));
  assert.ok(f.sent.some(m => m.method === 'editMessageText' && m.payload.text.includes('Сжатие отменено')));
});

test('manual compaction updates one status without showing memory text and explains truncation', async t => {
  let release: (() => void) | undefined;
  const f = fixture(t, { generate: (request, controls) => {
    controls.onText('PRIVATE GENERATED MEMORY');
    return new Promise<GenerationResult>(resolve => { release = () => resolve({ ...compactResult(request), finishReason: 'length' }); });
  } });
  await battleFixture(f);
  const before = f.store.read('1');
  await f.bot.handle(f.message('/compact'));
  await new Promise(resolve => setImmediate(resolve));
  const status = f.sent.filter(m => m.method === 'sendMessage' && m.payload.text.startsWith('🗜'));
  assert.equal(status.length, 1);
  release!(); await f.bot.idle();
  const updated = f.sent.filter(m => m.method === 'editMessageText');
  assert.ok(updated.length >= 1);
  assert.equal(new Set(updated.map(m => m.payload.message_id)).size, 1);
  assert.match(updated.at(-1)!.payload.text, /не уместился в лимит/);
  assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE GENERATED MEMORY/);
  assert.deepEqual(f.store.read('1').stories, before.stories);
  assert.equal(f.requests.length, 1);
});

test('failed progress delivery does not undo a compaction or cause another model call', async t => {
  const f = fixture(t, { progressFailure: true, generate: async request => compactResult(request) });
  await battleFixture(f);
  await f.bot.handle(f.message('/compact')); await f.bot.idle();
  const state = f.store.read('1');
  assert.equal(state.job, null);
  assert.equal(Object.keys(state.stories[state.active!.storyId].memories).length, 1);
  assert.equal(f.requests.length, 1);
  assert.match(f.sent.at(-1)!.payload.text, /Сжатие готово/);
});

test('a token-limited scene is archived, delivered and explicitly marked without regeneration', async t => {
  const f = fixture(t, { generate: async () => ({ text: '2026-08-02 20:00\n\nСинтетический оборванный ответ', finishReason: 'length' }) });
  const update = await f.start();
  const story = Object.values(f.store.read('1').stories)[0];
  assert.equal(Object.values(story.nodes)[0].truncated, true);
  assert.equal(Object.values(story.nodes)[0].delivery, 'sent');
  assert.match(f.sent.at(-1)!.payload.text, /достиг лимита/);
  await f.bot.handle(update);
  await f.bot.idle();
  assert.equal(f.requests.length, 1);
});

test('/model checks the selected server without generating, exposes failure and does not relabel archived scenes', async t => {
  const f = fixture(t, { model: 'claude-haiku-4-5-20251001' });
  await f.start();
  const story = Object.values(f.store.read('1').stories)[0];
  assert.deepEqual(Object.values(story.nodes)[0].modelInfo, { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' });
  let checks = 0;
  const gpu = createBot({ store: f.store, api: f.api, provider: { async check({ signal }: Controls) {
    assert.ok(signal instanceof AbortSignal);
    if (++checks === 2) throw new Error('synthetic unreachable server');
  }, async generate() { assert.fail('health checks must not generate'); } },
  allowedUsers: new Set(['1']), maxOutputTokens: 4096, render, scenePrefix, sceneKeyboard,
  model: 'gemma-4-test', providerName: 'llama-cpp' });
  await gpu.handle(f.message('/model'));
  assert.match(f.sent.at(-1)!.payload.text, /gemma-4-test/);
  assert.match(f.sent.at(-1)!.payload.text, /доступ|успеш|ответил/i);
  await gpu.handle(f.click('view:model'));
  assert.match(f.sent.at(-1)!.payload.text, /недоступ|не ответил|не удалось/i);
  await gpu.handle(f.message('/last'));
  const last = f.sent.at(-1)!.payload.rich_message.markdown;
  assert.match(last, /Haiku|haiku/);
  assert.doesNotMatch(last, /gemma|Gemma/);
  assert.equal(f.requests.length, 1);
});

test('unknown private /start stores only a bounded access request, never story text or access', async t => {
  const f = fixture(t);
  await f.bot.handle(f.message('PRIVATE UNAUTHORIZED STORY', 99));
  assert.equal(f.store.db.prepare("SELECT value FROM metadata WHERE key='access_requests'").get(), undefined);
  await f.bot.handle(f.message('/start', 99));
  await f.bot.handle(f.message('/start', 99));
  const group = f.message('/start', 100); group.message.chat.type = 'group';
  await f.bot.handle(group);
  await f.bot.handle(f.message('ANOTHER PRIVATE STORY', 99));
  const reopened = new Store(f.path);
  const requests = JSON.parse(reopened.db.prepare("SELECT value FROM metadata WHERE key='access_requests'").get()!.value as string);
  reopened.close();
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]).sort(), ['at', 'userId']);
  assert.equal(requests[0].userId, '99');
  assert.equal(typeof requests[0].at, 'number');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM libraries').get()!.n, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.requests.length, 0);
  for (let n = 100; n < 201; n++) f.store.requestAccess(String(n));
  assert.equal(JSON.parse(f.store.db.prepare("SELECT value FROM metadata WHERE key='access_requests'").get()!.value as string).length, 100);
});

test('a replay or a delivery failure never regenerates a completed scene', async t => {
  const f = fixture(t, { deliveryFailure: true });
  const update = await f.start();
  await f.bot.handle(update);
  await f.bot.idle();
  assert.equal(f.requests.length, 1);
  const state = f.store.read(1);
  const story = Object.values(state.stories)[0];
  assert.equal(Object.keys(story.nodes).length, 1);
  assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'scene').length, 1);
  await f.bot.handle(f.message('/last'));
  assert.equal(f.requests.length, 1);
});

test('fork uses only the checkpoint past; deletion preserves another branch and another user', async t => {
  const f = fixture(t);
  await f.start();
  await f.start(2);
  let state = f.store.read(1);
  let story = Object.values(state.stories)[0];
  const originalBranch = state.active!.branchId;
  const firstCheckpoint = Object.values(story.checkpoints).find(cp => cp.kind === 'scene');
  await f.bot.handle(f.message('Уникальное будущее родителя: ПОЖАР.'));
  await f.bot.idle();
  await f.bot.handle(f.click(`fork:${story.id}:${firstCheckpoint!.id}`));
  await f.bot.handle(f.message('В новой ветке смотритель закрывает дверь.'));
  await f.bot.idle();
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes('ПОЖАР'));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('СЕВЕР'));
  await f.bot.handle(f.click(`view:delete-branch:${story.id}:${originalBranch}`));
  await f.bot.handle(f.click(`remove-branch:${story.id}:${originalBranch}`));
  state = f.store.read(1);
  story = state.stories[story.id];
  assert.equal(Object.keys(story.branches).length, 1);
  assert.equal(history(story, story.branches[state.active!.branchId].head).length, 2);
  await f.bot.handle(f.click(`view:delete-seed:${story.seedId}`));
  await f.bot.handle(f.click(`remove-seed:${story.seedId}`));
  assert.equal(Object.keys(f.store.read(1).stories).length, 0);
  assert.equal(Object.keys(f.store.read(1).seeds).length, 0);
  assert.equal(Object.keys(f.store.read(2).stories).length, 1);
});

test('private state cannot be reached from another user, group or unconfirmed delete callback', async t => {
  const f = fixture(t);
  await f.start();
  const state = f.store.read(1);
  const story = Object.values(state.stories)[0];
  await f.bot.handle(f.click(`use:${story.id}:${state.active!.branchId}`, 2));
  assert.equal(f.store.read(2).active, null);
  await f.bot.handle(f.click(`remove-seed:${story.seedId}`));
  assert.equal(Object.keys(f.store.read(1).seeds).length, 1);
  const group = f.message('/continue'); group.message.chat = { id: -10, type: 'group' };
  await f.bot.handle(group);
  await f.bot.handle(f.message('/continue', 99));
  assert.equal(f.requests.length, 1);
});

test('a button whose IDs are not library IDs is stale: answered once, recorded, no change or model call, later input works', async t => {
  const f = fixture(t);
  await f.start();
  const { stories, active } = f.store.read(1);
  const story = Object.values(stories)[0];
  const replies = () => f.sent.filter(m => m.method === 'sendMessage').map(m => m.payload.text);
  // Object.prototype names in place of each ID these actions look up; a delete is confirmed first, as the UI does.
  for (const { confirm, data } of [{ data: 'use:constructor:b1' }, { data: `use:${story.id}:constructor` },
    { data: 'fork:constructor:c1' }, { data: `fork:${story.id}:__proto__` }, { data: 'start:constructor' },
    { confirm: 'view:delete-branch:constructor:b1', data: 'remove-branch:constructor:b1' },
    { confirm: 'view:delete-seed:constructor', data: 'remove-seed:constructor' }]) {
    if (confirm) await f.bot.handle(f.click(confirm));
    const before = f.store.read(1);
    const count = replies().length;
    const update = f.click(data);
    // A rejected update is fetched again, so handling must succeed once and ignore the replay.
    await f.bot.handle(update);
    await f.bot.handle(update);
    await f.bot.idle();
    assert.deepEqual(replies().slice(count), ['Кнопка устарела. Открой /menu.'], data);
    const after = f.store.read(1);
    assert.ok(after.seen.includes(update.update_id), data);
    assert.deepEqual({ ...after, seen: before.seen }, before, data);
  }
  assert.equal(f.requests.length, 1);
  await f.bot.handle(f.click(`use:${story.id}:${active!.branchId}`));
  await f.bot.handle(f.message('/continue'));
  await f.bot.idle();
  assert.equal(f.requests.length, 2);
  const current = f.store.read(1).stories[story.id];
  assert.equal(history(current, current.branches[active!.branchId].head).length, 2);
});

test('text starting with an Object.prototype name is ordinary text: a character action or a part of a seed draft', async t => {
  const f = fixture(t);
  await f.start();
  for (const text of ['constructor', 'toString и дальше текст', '__proto__']) {
    const update = f.message(text);
    await f.bot.handle(update);
    await f.bot.idle();
    await f.bot.handle(update);
    await f.bot.idle();
    const state = f.store.read(1);
    const story = state.stories[state.active!.storyId];
    assert.equal(history(story, story.branches[state.active!.branchId].head).at(-1)!.input, text);
  }
  assert.equal(f.requests.length, 4);
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  await f.bot.handle(f.message('valueOf'));
  await f.bot.handle(f.click(`save-seed:${(f.store.read(1).ui as SeedDraft).draftId}`));
  const seeds = Object.values(f.store.read(1).seeds);
  assert.equal(seeds.length, 2);
  assert.match(seeds[1].text, /СЕВЕР\.\n\nvalueOf$/);
  assert.equal(f.requests.length, 4);
});

test('running generation rejects another input and cancel prevents a late commit', async t => {
  let release: ((result: GenerationResult) => void) | undefined;
  const f = fixture(t, { generate: () => new Promise<GenerationResult>(resolve => { release = resolve; }) });
  const seedId = await f.seed();
  await f.bot.handle(f.click(`start:${seedId}`));
  await f.bot.handle(f.message('Нельзя запустить вторую генерацию.'));
  assert.equal(f.requests.length, 1);
  await f.bot.handle(f.message('/cancel'));
  release!({ text: '2026-08-02 20:00\n\nПоздний ответ.', finishReason: 'stop' });
  await f.bot.idle();
  assert.equal(f.store.read(1).job, null);
  assert.equal(Object.keys(Object.values(f.store.read(1).stories)[0].nodes).length, 0);
});

test('SQLite survives reopening, keeps update deduplication, and clears interrupted work without running it', async t => {
  const f = fixture(t);
  const update = await f.start();
  // Recovery clears any job, so a partial one is enough.
  f.store.mutate(1, state => { state.job = { id: 'j999', input: 'synthetic unfinished input' } as Job; });
  f.store.offset(update.update_id + 1);
  const reopened = new Store(f.path);
  try {
    reopened.recover();
    assert.equal(reopened.read(1).job, null);
    assert.equal(reopened.read(1).interrupted, true);
    assert.ok(reopened.read(1).seen.includes(update.update_id));
    assert.equal(Object.keys(Object.values(reopened.read(1).stories)[0].nodes).length, 1);
    assert.equal(reopened.offset(), update.update_id + 1);
  } finally { reopened.close(); }
});

test('a scene waiting for the shared model shows its place in the queue in the disappearing draft', async t => {
  const text = '2026-08-02 20:00\n\nСинтетическая сцена.';
  const f = fixture(t, { generate: async (request, controls) => {
    // Each status goes out before the next; one superseded before it is sent is skipped.
    const out = () => new Promise(resolve => setImmediate(resolve));
    controls.onWait?.(2); await out();
    controls.onWait?.(5); controls.onWait?.(1); await out();
    controls.onWait?.(0); await out();
    controls.onStart?.(); await out();
    controls.onWait?.(3);
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } });
  await f.start();
  const drafts = f.sent.filter(m => m.method === 'sendRichMessageDraft').map(m => m.payload.rich_message.markdown);
  assert.deepEqual(drafts.slice(0, 4), ['⏳ Очередь к модели: перед вами 2 запроса.', '⏳ Очередь к модели: перед вами 1 запрос.',
    '⏳ Подошла ваша очередь.', '📖 Модель читает историю, скоро начнёт писать…']);
  // Nothing about the queue after the model has started; the scene replaces the status in the same draft.
  assert.equal(drafts.length, 5);
  assert.ok(drafts[4].endsWith(text));
  assert.equal(new Set(f.sent.filter(m => m.method === 'sendRichMessageDraft').map(m => m.payload.draft_id)).size, 1);
});

test('a slow status never lands after the scene text or the final message', async t => {
  const text = '2026-08-02 20:00\n\nСинтетическая сцена.';
  let release: (() => void) | undefined;
  let held = false;
  const f = fixture(t, {
    // The first status stays in flight until the scene is over.
    hold: (method, payload) => {
      if (method !== 'sendRichMessageDraft' || held || !payload.rich_message.markdown.startsWith('⏳')) return undefined;
      held = true;
      return new Promise<void>(resolve => { release = resolve; });
    },
    generate: async (request, controls) => {
      controls.onWait?.(2);
      await new Promise(resolve => setImmediate(resolve));
      // The first status is in flight now; these are queued behind it.
      controls.onWait?.(1);
      controls.onStart?.();
      setTimeout(() => release?.(), 20);
      await controls.onText(text);
      return { text, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
    },
  });
  await f.start();
  const order = f.sent.filter(m => m.method.startsWith('sendRich')).map(m => m.method === 'sendRichMessage' ? 'final'
    : m.payload.rich_message.markdown.endsWith(text) ? 'scene' : m.payload.rich_message.markdown);
  // The held status went out first; the superseded ones were skipped; nothing came after the scene began.
  assert.deepEqual(order, ['⏳ Очередь к модели: перед вами 2 запроса.', 'scene', 'final']);
});

test('a turn cancelled while its status is in flight sends no late scene text', async t => {
  let release: (() => void) | undefined;
  let held = false;
  let f: ReturnType<typeof fixture>;
  f = fixture(t, {
    hold: (method, payload) => {
      if (method !== 'sendRichMessageDraft' || held || !payload.rich_message.markdown.startsWith('⏳')) return undefined;
      held = true;
      return new Promise<void>(resolve => { release = resolve; });
    },
    generate: async (request, controls) => {
      controls.onWait?.(1);
      await new Promise(resolve => setImmediate(resolve));
      controls.onStart?.();
      // The person cancels while the status is still in flight, then the status goes out.
      setTimeout(async () => { await f.bot.handle(f.message('/cancel')); release!(); }, 10);
      await controls.onText('2026-08-02 20:00\n\nПоздний текст.');
      throw new ModelError('cancelled');
    },
  });
  await f.start();
  assert.ok(!f.sent.some(m => m.method === 'sendRichMessageDraft' && m.payload.rich_message.markdown.includes('Поздний текст')));
});

test('model and percentage stay above Markdown; full context is on demand and never enters narrative', async t => {
  const text = '2026-08-02 20:00\n\n**Лодка** качнулась. *Тихо*.\n\n> На берег!\n\n- Фонарь\n- Весло';
  const f = fixture(t, { generate: async (request, controls) => {
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 1234, outputTokens: 87, totalTokens: 1321 } };
  } });
  await f.start();
  const draft = f.sent.find(m => m.method === 'sendRichMessageDraft')!;
  const finalIndex = f.sent.findIndex(m => m.method === 'sendRichMessage');
  assert.ok(draft.payload.rich_message.markdown.endsWith(text));
  assert.match(draft.payload.rich_message.markdown, /^_🤖 Claude Code · test‐model · 📏 Контекст /);
  assert.ok(f.sent[finalIndex].payload.rich_message.markdown.endsWith(text));
  assert.match(f.sent[finalIndex].payload.rich_message.markdown, /^_🤖 Claude Code · test‐model · 📏 Контекст /);
  assert.equal(f.sent.length, finalIndex + 1, 'no automatic service card');
  assert.equal(Object.values(Object.values(f.store.read('1').stories)[0].nodes)[0].text, text);
  await f.bot.handle(f.message('/context'));
  assert.match(f.sent.at(-1)!.payload.text, /Сид \+ память/);
  assert.match(f.sent.at(-1)!.payload.text, /вход 1\s234 · выход 87/);
  assert.equal(f.requests.length, 1);
  await f.bot.handle(f.message('/last'));
  assert.equal(f.sent.at(-1)!.method, 'sendRichMessage');
  assert.ok(f.sent.at(-1)!.payload.rich_message.markdown.endsWith(text));
  await f.bot.handle(f.message('Следующий шаг.'));
  await f.bot.idle();
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)!.messages), /inputTokens|estimatedTokens|📏|🤖|Лимит ввода бота/);
});

test('statistics delivery failure cannot regenerate or un-save a completed scene', async t => {
  const f = fixture(t, { contextFailure: true });
  const update = await f.start();
  await f.bot.handle(update);
  await f.bot.idle();
  await f.bot.handle(f.message('/context'));
  assert.equal(f.requests.length, 1);
  const story = Object.values(f.store.read(1).stories)[0];
  const node = Object.values(story.nodes)[0];
  assert.equal(node.delivery, 'sent');
  assert.equal(node.usage!.inputTokens, 101);
});

test('a compacted branch saves and sends the next scene with its new memory and no service card', async t => {
  const f = fixture(t, { compactAtTokens: 10000, generate: async (request, controls) => {
    if (request.system.startsWith('Извлеки')) {
      const data: SummaryInput = JSON.parse(request.messages[0].content);
      return { text: JSON.stringify({ facts: data.newScenes.map(n => ({ kind: 'event', at: '2026-08-02 20:00', text: 'Дул ветер.', source: [n.id] })) }), finishReason: 'stop' };
    }
    const text = '2026-08-03 20:00\n\nПосле сжатия зажгли фонарь.';
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 4000, outputTokens: 40, totalTokens: 4040 } };
  } });
  const seed = await f.seed();
  f.store.mutate('1', state => {
    newStory(state, seed);
    for (let i = 0; i < 8; i++) {
      const job = beginJob(state, `Сцена ${i}`, i);
      commitTurn(state, job.id, `2026-08-02 20:00\n\n${'ветер '.repeat(400)}`);
    }
  });
  await f.bot.handle(f.message('/continue'));
  await f.bot.idle();
  const state = f.store.read('1');
  const story = Object.values(state.stories)[0];
  const branch = story.branches[state.active!.branchId];
  assert.equal(Object.keys(story.nodes).length, 9);
  assert.equal(context(story, branch).memories.length, 1);
  assert.equal(context(story, branch).recent.length, 5);
  assert.equal(story.nodes[branch.head!].requestContext!.memory, branch.memory);
  assert.equal(f.requests.length, 2);
  assert.equal(f.sent.at(-1)!.method, 'sendRichMessage');
  assert.match(f.sent.at(-1)!.payload.rich_message.markdown, /После сжатия зажгли фонарь/);
});

test('a split paste stays in a persistent draft and cannot continue the previous story', async t => {
  const f = fixture(t);
  await f.start();
  const before = f.store.read(1);
  await f.bot.handle(f.message('/new'));
  const draftId = (f.store.read(1).ui as SeedDraft).draftId;
  const header = 'Большой маяк\n2026-08-02 20:00\n';
  const first = header + 'а'.repeat(4096 - header.length);
  const second = 'б'.repeat(4096);
  const update = f.message(first);
  await f.bot.handle(update);
  await f.bot.handle(update);
  for (const action of ['view:home', 'continue', 'new-seed', `start:${Object.keys(before.seeds)[0]}`]) {
    await f.bot.handle(f.click(action));
    assert.equal((f.store.read(1).ui as SeedDraft).draftId, draftId);
  }
  await f.bot.handle(f.message(second));
  const reopened = new Store(f.path);
  try {
    reopened.recover();
    assert.deepEqual((reopened.read(1).ui as SeedDraft).parts, [first, second]);
  } finally { reopened.close(); }
  await f.bot.handle(f.message('Последняя часть.'));
  assert.deepEqual(f.store.read(1).stories, before.stories);
  assert.equal(Object.keys(f.store.read(1).seeds).length, 1);
  assert.equal(f.requests.length, 1);
  const save = f.click(`save-seed:${draftId}`);
  await f.bot.handle(save);
  await f.bot.handle(save);
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  const state = f.store.read(1);
  const seed = Object.values(state.seeds).find(seed => seed.title === 'Большой маяк')!;
  assert.equal(seed.text, [first.slice(header.length), second, 'Последняя часть.'].join('\n\n'));
  assert.equal(Object.keys(state.seeds).length, 2);
  assert.deepEqual(state.stories, before.stories);
  assert.deepEqual(state.active, before.active);
  assert.equal(state.ui, null);
  assert.equal(f.requests.length, 1, 'saving a seed never calls the model');
});

test('cancel discards only the draft and an old save button cannot save a new draft', async t => {
  const f = fixture(t);
  await f.start();
  const before = f.store.read(1);
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  const oldId = (f.store.read(1).ui as SeedDraft).draftId;
  await f.bot.handle(f.message('/cancel'));
  assert.equal(f.store.read(1).ui, null);
  assert.deepEqual(f.store.read(1).stories, before.stories);
  assert.deepEqual(f.store.read(1).seeds, before.seeds);
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  const currentId = (f.store.read(1).ui as SeedDraft).draftId;
  await f.bot.handle(f.click(`save-seed:${oldId}`));
  assert.equal((f.store.read(1).ui as SeedDraft).draftId, currentId);
  assert.deepEqual(f.store.read(1).seeds, before.seeds);
  assert.equal(f.requests.length, 1);
});

test('incomplete seed headers stay in the draft until a valid explicit save', async t => {
  const f = fixture(t);
  await f.bot.handle(f.message('/new'));
  const draftId = (f.store.read(1).ui as SeedDraft).draftId;
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  assert.equal((f.store.read(1).ui as SeedDraft).draftId, draftId);
  await f.bot.handle(f.message('Маяк'));
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  assert.equal(Object.keys(f.store.read(1).seeds).length, 0);
  assert.equal((f.store.read(1).ui as SeedDraft).parts.length, 1);
  await f.bot.handle(f.message('2026-08-02 20:00\nСмотритель ждёт лодку.'));
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  assert.equal(Object.values(f.store.read(1).seeds)[0].text, 'Смотритель ждёт лодку.');
  assert.equal(f.store.read(1).ui, null);
  assert.equal(f.requests.length, 0);
});

test('a long rich message follows the same explicit-save seed flow', async t => {
  const f = fixture(t);
  await f.bot.handle(f.message('/new'));
  const draftId = (f.store.read(1).ui as SeedDraft).draftId;
  const body = 'Синтетический остров. '.repeat(1000);
  const update = f.message(undefined);
  update.message.rich_message = { blocks: [
    { type: 'heading', text: 'Маяк', size: 1 },
    { type: 'paragraph', text: '2026-08-02 20:00' },
    { type: 'paragraph', text: body },
  ] };
  await f.bot.handle(update);
  assert.equal(Object.keys(f.store.read(1).seeds).length, 0);
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  assert.equal(Object.values(f.store.read(1).seeds)[0].text, body.trim());
  assert.equal(f.requests.length, 0);
});

test('seed files are read only for an allowed private draft, appended once and never execute captions', async t => {
  let downloads = 0;
  const body = 'Описание синтетического острова. '.repeat(300);
  const f = fixture(t, { readSeedFile: async () => { downloads++; return body; } });
  const attachment = (user: number) => {
    const update = f.message(undefined, user);
    update.message.document = { file_name: 'seed.md', file_id: 'synthetic' };
    update.message.caption = '/cancel';
    return update;
  };
  await f.bot.handle(attachment(99));
  await f.bot.handle(attachment(1));
  const group = attachment(1); group.message.chat = { id: -1, type: 'group' };
  await f.bot.handle(group);
  assert.equal(downloads, 0);
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message('Маяк\n2026-08-02 20:00'));
  const update = attachment(1);
  await f.bot.handle(update);
  await f.bot.handle(update);
  assert.equal(downloads, 1);
  const draft = f.store.read(1).ui as SeedDraft;
  assert.equal(draft.parts.length, 2);
  await f.bot.handle(f.click(`save-seed:${draft.draftId}`));
  assert.equal(Object.values(f.store.read(1).seeds)[0].text, body.trim());
  assert.equal(f.requests.length, 0);
});

test('a failed or late file download cannot overwrite, complete or resurrect a draft', async t => {
  let release: ((text: string) => void) | undefined;
  let fail = true;
  const f = fixture(t, { readSeedFile: async () => {
    if (fail) throw new UserError('Синтетическая ошибка файла.');
    return new Promise<string>(resolve => { release = resolve; });
  } });
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  const before = f.store.read(1).ui;
  const attachment = () => {
    const update = f.message(undefined);
    update.message.document = { file_name: 'seed.txt', file_id: 'synthetic' };
    return update;
  };
  await f.bot.handle(attachment());
  assert.deepEqual(f.store.read(1).ui, before);
  fail = false;
  const pending = f.bot.handle(attachment());
  await f.bot.handle(f.message('/cancel'));
  await f.bot.handle(f.message('/new'));
  const next = f.store.read(1).ui;
  release!(seedText);
  await pending;
  assert.deepEqual(f.store.read(1).ui, next);
  assert.equal(Object.keys(f.store.read(1).seeds).length, 0);
  assert.equal(f.requests.length, 0);
});

test('GPU pause spans automatic compaction and its following scene, including another user requesting pause', { timeout: 10000 }, async t => {
  const writes: string[] = [];
  const gpu = createGpu({ api: { read: async () => ({ actual: 'running', intended: 'running' }),
    setState: async state => { writes.push(state); } }, connection: { ensure() {}, close() {} }, check: async () => {} });
  await gpu.tick();
  let finishMemory: (() => void) | undefined, finishScene: (() => void) | undefined;
  const memoryStarted = Promise.withResolvers<void>();
  const sceneStarted = Promise.withResolvers<void>();
  const f = fixture(t, { gpu, compactAtTokens: 12000, generate: request => new Promise<GenerationResult>(resolve => {
    if (request.purpose === 'memory') {
      finishMemory = () => resolve(compactResult(request)); memoryStarted.resolve();
    } else {
      finishScene = () => resolve({ text: '2026-08-02 20:00\n\nСинтетическое продолжение.', finishReason: 'stop' }); sceneStarted.resolve();
    }
  }) });
  await battleFixture(f);
  await f.bot.handle(f.message('/continue'));
  await memoryStarted.promise;
  assert.equal(gpu.snapshot().activeJobs, 1);
  await f.bot.handle(f.message('/gpu_pause', 2));
  assert.equal(gpu.snapshot().status, 'draining');
  assert.deepEqual(writes, []);
  finishMemory!(); await sceneStarted.promise;
  assert.equal(gpu.snapshot().activeJobs, 1, 'compaction must not release the whole job lease');
  assert.deepEqual(writes, []);
  finishScene!(); await f.bot.idle(); await gpu.tick();
  assert.equal(gpu.snapshot().activeJobs, 0);
  assert.deepEqual(writes, ['stopped']);
});

test('paused GPU accepts seed drafts and model controls but never creates an unwanted story or starts from text', async t => {
  const writes: string[] = [];
  const gpu = createGpu({ api: { read: async () => ({ actual: 'exited', intended: 'stopped' }),
    setState: async state => { writes.push(state); } }, connection: { ensure() {}, close() {} }, check: async () => {} });
  await gpu.tick();
  const f = fixture(t, { gpu });
  const seedId = await f.seed();
  await f.bot.handle(f.click(`start:${seedId}`));
  assert.equal(Object.keys(f.store.read(1).stories).length, 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(writes, []);
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message('Новый черновик'));
  const before = f.store.read(1).ui;
  await f.bot.handle(f.message('/model'));
  assert.deepEqual(f.store.read(1).ui, before);
  await f.bot.handle(f.message('/gpu_start', 99));
  assert.deepEqual(writes, []);
  const update = f.message('/gpu_start');
  await f.bot.handle(update); await gpu.tick();
  await f.bot.handle(update); await gpu.tick();
  assert.deepEqual(writes, ['running']);
  assert.deepEqual(f.store.read(1).ui, before);
});

test('the model screen does not call a provider verified when it has no check', async t => {
  const cli = fixture(t);
  await cli.bot.handle(cli.click('view:model'));
  assert.match(cli.sent.at(-1)!.payload.text, /ещё не проверена/);
  const server = fixture(t, { check: async () => ({ model: 'test-model' }), providerName: 'llama-cpp' });
  await server.bot.handle(server.click('view:model'));
  assert.match(server.sent.at(-1)!.payload.text, /Последняя успешная проверка/);
});

// The fixture's updates come from a Russian Telegram app; these come from an app in the given language.
function speaking<T extends Update>(update: T, languageCode: string | undefined): T {
  const from = update.message?.from ?? update.callback_query?.from;
  if (from) from.language_code = languageCode;
  return update;
}

test('a new user gets the language of their Telegram app, /language changes it and the choice survives a reload', async t => {
  const f = fixture(t);
  const shown = () => f.sent.filter(item => item.method === 'sendMessage').map(item => item.payload.text);
  await f.bot.handle(speaking(f.message('/start'), 'en-GB'));
  assert.equal(f.store.read(1).language, 'en');
  assert.match(shown().at(-1)!, /^🏠 Menu\n\n[^]*Nothing here yet/);
  assert.doesNotMatch(shown().at(-1)!, /[А-Яа-яЁё]/);
  await f.bot.handle(speaking(f.message('/nope'), 'en'));
  assert.equal(shown().at(-1), texts('en').notices.unknownCommand);
  // A refusal thrown by the library carries a key and is shown in the user's language.
  await f.bot.handle(speaking(f.click('start:s999'), 'en'));
  assert.equal(shown().at(-1), texts('en').errors.seedGone);

  // The interface language names what the bot creates, and never reaches the model.
  await f.start();
  const story = Object.values(f.store.read(1).stories)[0];
  assert.deepEqual(Object.values(story.branches).map(branch => branch.name), ['Start']);
  assert.deepEqual(Object.values(story.checkpoints).map(cp => cp.label), ['Seed', 'Scene 1']);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].messages.at(-1)!.content, /Начни историю из сида\. Покажи первую сцену\./);
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /Scene 1|"Start"|Menu/);
  assert.match(f.sent.findLast(item => item.method === 'sendRichMessage')!.payload.rich_message.markdown, /^_🤖 Claude Code · test‐model · 📏 Context /);

  await f.bot.handle(speaking(f.message('/language'), 'en'));
  assert.match(shown().at(-1)!, /^🌐 Interface language/);
  const picker = f.sent.at(-1)!.payload as unknown as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
  assert.deepEqual(picker.reply_markup.inline_keyboard.flat().map(button => button.callback_data).slice(0, 2), ['lang:ru', 'lang:en']);
  for (const stale of ['lang:xx', 'lang:constructor', 'lang:']) {
    await f.bot.handle(speaking(f.click(stale), 'en'));
    assert.equal(shown().at(-1), texts('en').errors.staleButton);
    assert.equal(f.store.read(1).language, 'en');
  }
  await f.bot.handle(speaking(f.click('lang:ru'), 'en'));
  assert.equal(f.store.read(1).language, 'ru');
  assert.match(shown().at(-1)!, /^🏠 Меню\n\n[^]*📖 Сейчас: «Маяк» · история 1/);
  // Stored names keep the language they were written in.
  assert.match(shown().at(-1)!, /🌿 Ветка «Start» · 1 сцена/);

  const reopened = new Store(f.path);
  try { assert.equal(reopened.read(1).language, 'ru'); } finally { reopened.close(); }
  await f.bot.handle(speaking(f.message('/menu'), 'en'));
  assert.match(shown().at(-1)!, /^🏠 Меню/);
  assert.equal(f.store.read(1).language, 'ru');
});

test('a library from before the language choice stays Russian whatever the Telegram app says', async t => {
  const f = fixture(t);
  f.store.mutate(2, state => { addSeed(state, seedText); });
  assert.equal(f.store.read(2).language, undefined);
  await f.bot.handle(speaking(f.message('/start', 2), 'en'));
  assert.match(f.sent.at(-1)!.payload.text, /^🏠 Меню\n\n[^]*История не выбрана/);
  await f.bot.handle(speaking(f.click('view:language', 2), 'en'));
  assert.match(f.sent.at(-1)!.payload.text, /^🌐 Язык интерфейса/);
  assert.equal(f.store.read(2).language, undefined);
  await f.bot.handle(speaking(f.click('lang:en', 2), 'en'));
  assert.equal(f.store.read(2).language, 'en');
  assert.match(f.sent.at(-1)!.payload.text, /^🏠 Menu/);
});

test('a first contact without a language code is English, and a language with no catalog yet is kept for later', async t => {
  const f = fixture(t);
  await f.bot.handle(speaking(f.message('/start'), undefined));
  assert.equal(f.store.read(1).language, 'en');
  await f.bot.handle(speaking(f.message('/start', 2), 'ja-JP'));
  assert.equal(f.store.read(2).language, 'ja');
  assert.ok(f.sent.at(-1)!.payload.text.startsWith(texts('ja').home.title));
});

test('the language can be changed from inside a seed draft without losing it', async t => {
  const f = fixture(t);
  await f.bot.handle(f.click('new-seed'));
  await f.bot.handle(f.message(seedText));
  await f.bot.handle(f.message('/language'));
  assert.match(f.sent.at(-1)!.payload.text, /^🌐 Язык интерфейса/);
  await f.bot.handle(f.click('lang:en'));
  assert.match(f.sent.at(-1)!.payload.text, /^📝 Seed draft, not saved yet\nReceived: 1 part · /);
  assert.deepEqual((f.store.read(1).ui as SeedDraft).parts, [seedText]);
});
