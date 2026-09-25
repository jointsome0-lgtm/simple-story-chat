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
import type { Illustrator, SampleRequest } from './picture.ts';
import { personTag } from './picture.ts';
import { PRESETS } from './picture-style.ts';
import type { TelegramPayload } from './telegram.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { texts } from './text.ts';
import { UserError, addSeed, history, newStory, beginJob, commitTurn, context } from '../lib/library.ts';
import type { Job, SeedDraft, SentPicture } from '../lib/library.ts';

// Scene and memory requests from the bot always pass a text callback.
type TextControls = GenerateControls & Required<Pick<GenerateControls, 'onText'>>;
type FixtureOptions = {
  progressFailure?: boolean; contextFailure?: boolean; deliveryFailure?: boolean;
  generate?: (request: ModelRequest, controls: TextControls) => Promise<GenerationResult>;
  gpu?: GpuController; readSeedFile?: BotOptions['readSeedFile'];
  model?: string; providerName?: string; compactAtTokens?: number; ownerId?: string; illustrator?: Illustrator;
  // Holds a Telegram call until the returned promise settles.
  hold?: (method: string, payload: Payload) => Promise<void> | undefined;
};
// A log row as main.ts writes it: the event, a code and the allowed details.
type Row = { event: string; code?: string | number } & ErrorDetails;
// Fields of sent payloads that the tests read; each is present for the methods where it is read.
type Payload = { chat_id: number; message_id: number; message_ids: number[]; text: string; rich_message: { markdown: string }; draft_id: number };
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
  const bot = createBot({ store, api, provider, gpu: options.gpu, illustrator: options.illustrator, allowedUsers: new Set(['1', '2']), maxOutputTokens: 4096,
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

// The fixture's updates come from a Russian Telegram app; these come from an app in the given language.
function speaking<T extends Update>(update: T, languageCode: string | undefined): T {
  const from = update.message?.from ?? update.callback_query?.from;
  if (from) from.language_code = languageCode;
  return update;
}

// A card that draws nothing: the bot's side of the picture styles, with the samples it asks for kept here.
function sketchbook(drawn: SampleRequest[]) {
  return { enabledFor: (userId: string) => userId === '1', standardStyle: PRESETS.semi,
    illustrate: async () => {}, sample: async (request: SampleRequest) => { drawn.push(request); } } as unknown as Illustrator;
}

// What a restarted bot finds: a second Store on the same file, recovered as local/main.ts recovers it at a start.
function reopened<T>(path: string, read: (store: Store) => T): T {
  const store = new Store(path);
  try { store.recover(); return read(store); } finally { store.close(); }
}

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
    assert.ok(f.rows.length > 3 && f.rows.every(row => row.actor === first), first);
    const compaction = f.rows.filter(row => row.sceneCount !== undefined);
    assert.deepEqual(compaction.map(row => row.event), ['compaction_request_started', 'compaction_request_completed', 'memory_compacted'], first);
    const { elapsedMs, requestBytes, inputBytesBefore, inputBytesAfter, ...saved } = compaction[2];
    assert.deepEqual(saved, { event: 'memory_compacted', actor: first, automatic: false, sceneCount: 3, repairSceneCount: 0, factCount: 3, outputCharacters: 0 }, first);
    assert.ok(elapsedMs! >= 0 && requestBytes! > 0 && inputBytesAfter! < inputBytesBefore!, first);
    // The tester's failed scene: the row has the transport details and no trace of whose library it was.
    const before = f.rows.length;
    await f.start(2);
    const other = f.rows.slice(before);
    assert.ok(other.length > 1 && other.every(row => row.actor === 'other'), first);
    assert.deepEqual(other.find(row => row.event === 'generation_failed'),
      { event: 'generation_failed', code: 'provider_failed', phase: 'generate', transportCode: 'UND_ERR_SOCKET', actor: 'other' }, first);
    assert.doesNotMatch(JSON.stringify(f.rows), /Защитники|Синтетический|Кодовая|СЕВЕР|userId|"1"|"2"/, first);
  }
  // The owner ID is optional, but one outside the access list stops the start instead of mislabelling rows. The
  // message names the two settings and never the rejected value.
  const env = { TELEGRAM_BOT_TOKEN: '1:synthetic', SIMPLE_CHAT_ALLOWED_USER_IDS: '1, 2' };
  const load = (ownerId?: string) => loadConfig('/nonexistent-simple-chat-config', { ...env, SIMPLE_CHAT_OWNER_ID: ownerId }).ownerId;
  assert.equal(load(), '', 'no owner');
  assert.equal(load(' 2 '), '2', 'an owner on the access list');
  assert.throws(() => load('3'), { message: 'SIMPLE_CHAT_OWNER_ID must be one of SIMPLE_CHAT_ALLOWED_USER_IDS' }, 'an owner off the list');
  assert.throws(() => load('PRIVATE'), error => !/PRIVATE/.test((error as Error).message), 'the rejected value');
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

test('SQLite survives reopening, keeps update deduplication, and clears interrupted work without running it', async t => {
  let download: 'fails' | 'waits' = 'fails';
  let release: ((text: string) => void) | undefined;
  const f = fixture(t, { readSeedFile: async () => {
    if (download === 'fails') throw new UserError('Синтетическая ошибка файла.');
    return new Promise<string>(resolve => { release = resolve; });
  } });
  const update = await f.start();
  // Recovery clears any job, so a partial one is enough.
  f.store.mutate(1, state => { state.job = { id: 'j999', input: 'synthetic unfinished input' } as Job; });
  f.store.offset(update.update_id + 1);
  assert.deepEqual(reopened(f.path, store => [store.read(1).job, store.read(1).interrupted, store.read(1).seen.includes(update.update_id),
    Object.keys(Object.values(store.read(1).stories)[0].nodes).length, store.offset()]), [null, true, true, 1, update.update_id + 1], 'a restart mid-job');

  // A seed pasted in parts stays a draft through navigation, a change of language and a restart, and never continues
  // the previous story.
  const before = f.store.read(1);
  await f.bot.handle(f.message('/new'));
  const draftId = (f.store.read(1).ui as SeedDraft).draftId;
  const header = 'Большой маяк\n2026-08-02 20:00\n';
  const first = header + 'а'.repeat(4096 - header.length);
  const second = 'б'.repeat(4096);
  const part = f.message(first);
  await f.bot.handle(part);
  await f.bot.handle(part);
  await f.bot.handle(f.message('/language'));
  assert.match(f.sent.at(-1)!.payload.text, /^🌐 Язык интерфейса/, 'the language picker from a draft');
  for (const action of ['view:home', 'continue', 'new-seed', `start:${Object.keys(before.seeds)[0]}`, 'lang:en']) {
    await f.bot.handle(f.click(action));
    assert.equal((f.store.read(1).ui as SeedDraft).draftId, draftId, action);
  }
  assert.match(f.sent.at(-1)!.payload.text, /^📝 Seed draft, not saved yet\nReceived: 1 part · /, 'a draft in English');
  await f.bot.handle(f.message(second));
  assert.deepEqual(reopened(f.path, store => (store.read(1).ui as SeedDraft).parts), [first, second], 'a restart');
  await f.bot.handle(f.message('Последняя часть.'));
  assert.deepEqual([f.store.read(1).stories, Object.keys(f.store.read(1).seeds).length], [before.stories, 1], 'a draft before its save');
  const save = f.click(`save-seed:${draftId}`);
  await f.bot.handle(save);
  await f.bot.handle(save);
  await f.bot.handle(f.click(`save-seed:${draftId}`));
  const saved = f.store.read(1);
  assert.equal(Object.values(saved.seeds).find(seed => seed.title === 'Большой маяк')!.text,
    [first.slice(header.length), second, 'Последняя часть.'].join('\n\n'), 'a split paste');
  assert.deepEqual([Object.keys(saved.seeds).length, saved.stories, saved.active, saved.ui], [2, before.stories, before.active, null], 'a split paste');

  // A save of a draft without a complete header keeps the draft; a valid save saves it.
  await f.bot.handle(f.message('/new'));
  const headed = (f.store.read(1).ui as SeedDraft).draftId;
  for (const [label, text, parts] of [['an empty draft', undefined, 0], ['a title without its time', 'Маяк', 1]] as const) {
    if (text) await f.bot.handle(f.message(text));
    await f.bot.handle(f.click(`save-seed:${headed}`));
    const draft = f.store.read(1).ui as SeedDraft;
    assert.deepEqual([draft.draftId, draft.parts.length, Object.keys(f.store.read(1).seeds).length], [headed, parts, 2], label);
  }
  await f.bot.handle(f.message('2026-08-02 20:00\nСмотритель ждёт лодку.'));
  await f.bot.handle(f.click(`save-seed:${headed}`));
  assert.deepEqual([Object.values(f.store.read(1).seeds).at(-1)!.text, f.store.read(1).ui], ['Смотритель ждёт лодку.', null], 'a complete header');

  // A long rich message is a part like any other.
  await f.bot.handle(f.message('/new'));
  const body = 'Синтетический остров. '.repeat(1000);
  const rich = f.message(undefined);
  rich.message.rich_message = { blocks: [{ type: 'heading', text: 'Маяк', size: 1 },
    { type: 'paragraph', text: '2026-08-02 20:00' }, { type: 'paragraph', text: body }] };
  await f.bot.handle(rich);
  assert.equal(Object.keys(f.store.read(1).seeds).length, 3, 'a rich message before its save');
  await f.bot.handle(f.click(`save-seed:${(f.store.read(1).ui as SeedDraft).draftId}`));
  assert.equal(Object.values(f.store.read(1).seeds).at(-1)!.text, body.trim(), 'a rich message');

  // /cancel discards only the draft, and the old draft's save button cannot save the next one.
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  const kept = f.store.read(1);
  await f.bot.handle(f.message('/cancel'));
  assert.deepEqual([f.store.read(1).ui, f.store.read(1).stories, f.store.read(1).seeds], [null, kept.stories, kept.seeds], 'a cancelled draft');
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  const open = f.store.read(1).ui;
  await f.bot.handle(f.click(`save-seed:${(kept.ui as SeedDraft).draftId}`));
  assert.deepEqual([f.store.read(1).ui, f.store.read(1).seeds], [open, kept.seeds], 'an old save button');

  // A failed download leaves the draft as it was; a late one cannot complete, overwrite or resurrect a draft.
  const attachment = () => {
    const file = f.message(undefined);
    file.message.document = { file_name: 'seed.txt', file_id: 'synthetic' };
    return file;
  };
  await f.bot.handle(attachment());
  assert.deepEqual(f.store.read(1).ui, open, 'a failed download');
  download = 'waits';
  const pending = f.bot.handle(attachment());
  await f.bot.handle(f.message('/cancel'));
  await f.bot.handle(f.message('/new'));
  const next = f.store.read(1).ui;
  release!(seedText);
  await pending;
  assert.deepEqual([f.store.read(1).ui, f.store.read(1).seeds, f.requests.length], [next, kept.seeds, 1], 'a late download');

  // First contact takes the language of the Telegram app: none is English, and one with no catalog yet is kept for
  // later. A library from before the language choice stays Russian whatever the app says.
  for (const [label, code, old, language, menu] of [
    ['an English app', 'en-GB', false, 'en', /^🏠 Menu\n\n[^]*Nothing here yet/],
    ['no language code', undefined, false, 'en', /^🏠 Menu\n/],
    ['a language with no catalog yet', 'ja-JP', false, 'ja', new RegExp(`^${texts('ja').home.title}`)],
    ['a library from before the choice', 'en', true, undefined, /^🏠 Меню\n\n[^]*История не выбрана/],
  ] as const) {
    const g = fixture(t);
    if (old) g.store.mutate(1, state => { addSeed(state, seedText); });
    await g.bot.handle(speaking(g.message('/start'), code));
    assert.equal(g.store.read(1).language, language, label);
    assert.match(g.sent.at(-1)!.payload.text, menu, label);
    if (language === 'en') assert.doesNotMatch(g.sent.at(-1)!.payload.text, /[А-Яа-яЁё]/, label);
  }

  // The interface language names what the bot creates and never reaches the model; /language changes it, a stale
  // language button changes nothing, and the choice survives a reload.
  const g = fixture(t);
  const shown = () => g.sent.filter(item => item.method === 'sendMessage').at(-1)!.payload.text;
  await g.bot.handle(speaking(g.message('/start'), 'en-GB'));
  // A refusal thrown by the library carries a key and is shown in the reader's language.
  await g.bot.handle(speaking(g.click('start:s999'), 'en'));
  assert.equal(shown(), texts('en').errors.seedGone, 'a refusal from the library');
  await g.start();
  const story = Object.values(g.store.read(1).stories)[0];
  assert.deepEqual([Object.values(story.branches).map(branch => branch.name), Object.values(story.checkpoints).map(cp => cp.label)],
    [['Start'], ['Seed', 'Scene 1']], 'names the bot creates');
  assert.match(g.requests[0].messages.at(-1)!.content, /Начни историю из сида\. Покажи первую сцену\./, 'the request');
  assert.doesNotMatch(JSON.stringify(g.requests[0]), /Scene 1|"Start"|Menu/, 'the request');
  for (const stale of ['lang:xx', 'lang:constructor', 'lang:']) {
    await g.bot.handle(speaking(g.click(stale), 'en'));
    assert.deepEqual([shown(), g.store.read(1).language], [texts('en').errors.staleButton, 'en'], stale);
  }
  await g.bot.handle(speaking(g.click('lang:ru'), 'en'));
  assert.match(shown(), /^🏠 Меню\n\n[^]*📖 Сейчас: «Маяк» · история 1/, 'Russian chosen');
  // Stored names keep the language they were written in.
  assert.match(shown(), /🌿 Ветка «Start» · 1 сцена/, 'Russian chosen');
  assert.equal(reopened(g.path, store => store.read(1).language), 'ru', 'a reload');
  await g.bot.handle(speaking(g.message('/menu'), 'en'));
  assert.match(shown(), /^🏠 Меню/, 'an English app after the choice');
});

test('a replay or a delivery failure never regenerates a completed scene', async t => {
  const { deliveryUnconfirmed, truncated, modelUnavailable } = texts('ru').notices;
  const cut = async () => ({ text: '2026-08-02 20:00\n\nСинтетический оборванный ответ', finishReason: 'length' as const });
  // Each story is started, its start replayed, and /context and /last asked for: one model call, whatever fails.
  for (const [label, options, delivery, usage, cutShort, notice] of [
    ['the scene message fails', { deliveryFailure: true }, 'pending', 101, false, deliveryUnconfirmed],
    ['the /context message fails', { contextFailure: true }, 'sent', 101, false, undefined],
    ['the scene reaches the token limit', { generate: cut }, 'sent', undefined, true, truncated],
  ] as const) {
    const f = fixture(t, options);
    const update = await f.start();
    await f.bot.handle(update);
    await f.bot.idle();
    await f.bot.handle(f.message('/context'));
    await f.bot.handle(f.message('/last'));
    const story = Object.values(f.store.read(1).stories)[0];
    assert.equal(f.requests.length, 1, label);
    assert.deepEqual(Object.values(story.nodes).map(node => [node.delivery, node.usage?.inputTokens, node.truncated]), [[delivery, usage, cutShort]], label);
    assert.equal(Object.values(story.checkpoints).filter(cp => cp.kind === 'scene').length, 1, label);
    if (notice) assert.ok(f.sent.some(item => item.payload.text === notice), label);
  }

  // /model checks the selected server without generating and shows a failure; an archived scene keeps its label.
  const f = fixture(t, { model: 'claude-haiku-4-5-20251001' });
  await f.start();
  assert.deepEqual(Object.values(Object.values(f.store.read(1).stories)[0].nodes)[0].modelInfo, { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' });
  let checks = 0;
  const server = createBot({ store: f.store, api: f.api, provider: { async check({ signal }: Controls) {
    assert.ok(signal instanceof AbortSignal);
    if (++checks === 2) throw new Error('synthetic unreachable server');
  }, async generate() { assert.fail('health checks must not generate'); } },
  allowedUsers: new Set(['1']), maxOutputTokens: 4096, render, scenePrefix, sceneKeyboard, model: 'gemma-4-test', providerName: 'llama-cpp' });
  await server.handle(f.message('/model'));
  assert.match(f.sent.at(-1)!.payload.text, /gemma-4-test/, 'a server that answers');
  assert.match(f.sent.at(-1)!.payload.text, /доступ|успеш|ответил/i, 'a server that answers');
  await server.handle(f.click('view:model'));
  assert.match(f.sent.at(-1)!.payload.text, /недоступ|не ответил|не удалось/i, 'a server that does not');
  await server.handle(f.message('/last'));
  const last = f.sent.at(-1)!.payload.rich_message.markdown;
  assert.ok(/Haiku|haiku/.test(last) && !/gemma|Gemma/.test(last), 'an archived scene');
  assert.equal(f.requests.length, 1, 'a check');

  // While the model service is down the reader is told so and the story stays; it goes on once the service is back.
  // A closed tunnel, then a service that is still starting: the bot cannot tell a sleeping card from either.
  let failure: ModelError | undefined;
  const down = fixture(t, { providerName: 'simple-serving', generate: async (_request, controls) => {
    if (failure) throw failure;
    await controls.onText('2026-08-02 20:00\n\n');
    return { text: '2026-08-02 20:00\n\nСинтетическая сцена.', finishReason: 'stop' };
  } });
  const scenes = () => {
    const { stories, active } = down.store.read(1);
    return history(stories[active!.storyId], stories[active!.storyId].branches[active!.branchId].head).length;
  };
  const go = async () => { await down.bot.handle(down.message('/continue')); await down.bot.idle(); };
  for (const [label, error, act, count] of [
    ['a closed tunnel', new ModelError('provider_failed', { phase: 'generate', transportCode: 'ECONNREFUSED' }), () => down.start(), 0],
    ['a service still starting', new ModelError('model_unavailable', { phase: 'generate', httpStatus: 503, servingCode: 'starting' }), go, 0],
    ['the service back', undefined, go, 1],
  ] as const) {
    failure = error;
    const before = down.sent.length;
    await act();
    assert.deepEqual([down.sent.slice(before).some(item => item.payload.text === modelUnavailable), scenes()], [!!error, count], label);
  }
});

test('a running job refuses another and /cancel keeps its late answer out; no status lands after the scene or a cancel', async t => {
  // A scene, then a compaction: another input is refused while it runs, /cancel stops the model call, and the answer
  // that comes anyway commits nothing.
  for (const compact of [false, true]) {
    const label = compact ? 'a compaction' : 'a scene';
    let release: (() => void) | undefined, signal: AbortSignal | undefined;
    const f = fixture(t, { generate: (request, controls) => new Promise<GenerationResult>(resolve => {
      signal = controls.signal;
      release = () => resolve(compact ? compactResult(request) : { text: '2026-08-02 20:00\n\nПоздний ответ.', finishReason: 'stop' });
    }) });
    if (compact) { await battleFixture(f); await f.bot.handle(f.message('/compact')); }
    else await f.bot.handle(f.click(`start:${await f.seed()}`));
    assert.equal(f.store.read(1).job!.kind, compact ? 'compact' : undefined, label);
    await f.bot.handle(f.message(compact ? '/continue' : 'Нельзя запустить вторую генерацию.'));
    assert.equal(f.requests.length, 1, label);
    await f.bot.handle(f.message('/cancel'));
    assert.equal(signal?.aborted, true, label);
    release!();
    await f.bot.idle();
    const state = f.store.read(1);
    const story = Object.values(state.stories)[0];
    assert.deepEqual([state.job, Object.keys(story.nodes).length, Object.keys(story.memories).length], [null, compact ? 7 : 0, 0], label);
    assert.ok(!f.sent.some(item => /Сжатие готово/.test(item.payload.text) || /Поздний ответ/.test(item.payload.rich_message?.markdown)), label);
    if (compact) assert.ok(f.sent.some(item => item.method === 'editMessageText' && item.payload.text.includes('Сжатие отменено')), label);
  }

  // The first queue status stays in flight until the test lets it go.
  const holdFirstStatus = () => {
    const out = Promise.withResolvers<void>();
    let held = false;
    return { release: () => out.resolve(), hold: (method: string, payload: Payload) => {
      if (method !== 'sendRichMessageDraft' || held || !payload.rich_message.markdown.startsWith('⏳')) return undefined;
      held = true;
      return out.promise;
    } };
  };
  const text = '2026-08-02 20:00\n\nСинтетическая сцена.';
  const slow = holdFirstStatus();
  const f = fixture(t, { hold: slow.hold, generate: async (request, controls) => {
    controls.onWait?.(2);
    await new Promise(resolve => setImmediate(resolve));
    // The first status is in flight now; these are queued behind it.
    controls.onWait?.(1);
    controls.onStart?.();
    setTimeout(slow.release, 20);
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } });
  await f.start();
  const order = f.sent.filter(m => m.method.startsWith('sendRich')).map(m => m.method === 'sendRichMessage' ? 'final'
    : m.payload.rich_message.markdown.endsWith(text) ? 'scene' : m.payload.rich_message.markdown);
  // The held status went out first; the superseded ones were skipped; nothing came after the scene began.
  assert.deepEqual(order, ['⏳ Очередь к модели: перед вами 2 запроса.', 'scene', 'final'], 'a slow status');

  const late = holdFirstStatus();
  const g: ReturnType<typeof fixture> = fixture(t, { hold: late.hold, generate: async (request, controls) => {
    controls.onWait?.(1);
    await new Promise(resolve => setImmediate(resolve));
    controls.onStart?.();
    // The person cancels while the status is still in flight, then the status goes out.
    setTimeout(async () => { await g.bot.handle(g.message('/cancel')); late.release(); }, 10);
    await controls.onText('2026-08-02 20:00\n\nПоздний текст.');
    // A delta the provider had already received goes to the callback before it checks the signal.
    await controls.onText(' Ещё поздний текст.');
    throw new ModelError('cancelled');
  } });
  await g.start();
  assert.ok(!g.sent.some(m => m.method === 'sendRichMessageDraft' && /оздний текст/.test(m.payload.rich_message.markdown)), 'a cancel while a status is in flight');
});

test('fork uses only the checkpoint past; a deletion takes only its own scenes and their pictures, a hundred to a call', async t => {
  let refuse: (() => void) | undefined;
  const refusal = () => Object.assign(new Error('synthetic'), { code: 400 });
  const f = fixture(t, { ownerId: '1', hold: (method, payload) => {
    // The harbour's batch is answered when the test says so, with a refusal; one message on its own is refused as well.
    if (method === 'deleteMessages' && payload.message_ids[0] > 9000) return new Promise<void>((_, reject) => { refuse = () => reject(refusal()); });
    return method === 'deleteMessage' && payload.message_id === 9002 ? Promise.reject(refusal()) : undefined;
  } });
  await f.start();
  await f.start(2);
  const story = Object.values(f.store.read(1).stories)[0];
  const first = f.store.read(1).active!.branchId;
  const checkpoint = Object.values(story.checkpoints).find(cp => cp.kind === 'scene')!;
  await f.bot.handle(f.message('Уникальное будущее родителя: ПОЖАР.'));
  await f.bot.idle();
  await f.bot.handle(f.click(`fork:${story.id}:${checkpoint.id}`));
  const fork = f.store.read(1).active!.branchId;
  await f.bot.handle(f.message('В новой ветке смотритель закрывает дверь.'));
  await f.bot.idle();
  const request = JSON.stringify(f.requests.at(-1));
  assert.ok(!request.includes('ПОЖАР') && request.includes('СЕВЕР'), 'the request of the fork');
  // One more fork from the same scene, with no scene of its own; and a second seed, whose story has a scene.
  await f.bot.handle(f.click(`fork:${story.id}:${checkpoint.id}`));
  const bare = f.store.read(1).active!.branchId;
  const [shared, onlyFirst, onlyFork] = Object.keys(f.store.read(1).stories[story.id].nodes);
  const harbour = f.store.mutate(1, state => {
    const { story: other, branch } = newStory(state, addSeed(state, seedText.replace('Маяк', 'Порт')).id);
    return { storyId: other.id, branchId: branch.id, nodeId: commitTurn(state, beginJob(state, 'Синтетический ход.', 0).id, '2026-08-02 20:00\n\nСинтетическая гавань.')!.nodeId };
  });
  // The bot tests draw no pictures, so the library is given the records local/picture.ts would have left in it: of the
  // shared first scene, one sent before the 48 hours in which Telegram lets the bot delete it and 251 since; of the
  // second scene, its picture and a sample; the fork's scene's; and three of the harbour's.
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();
  const sent = (nodeId: string, messageId: number, age = 0, storyId = story.id): SentPicture => ({ storyId, nodeId, messageId, at: now - age });
  f.store.mutate(1, state => { state.sentPictures = [sent(shared, 7001, 49 * HOUR), sent(shared, 501), sent(onlyFirst, 502), sent(onlyFirst, 503),
    sent(onlyFork, 504), ...Array.from({ length: 250 }, (_, n) => sent(shared, 8000 + n, 24 * HOUR - n)),
    ...[9001, 9002, 9003].map(id => sent(harbour.nodeId, id, HOUR, harbour.storyId))]; });
  // The other reader's library has the same ids, and is not touched.
  const their = Object.values(f.store.read(2).stories)[0];
  f.store.mutate(2, state => { state.sentPictures = [{ storyId: their.id, nodeId: Object.keys(their.nodes)[0], messageId: 8000, at: now }]; });
  const theirs = f.store.read(2);
  // What is left: how many of the 250 pictures, the others by id, the stories, and the scenes of the fork.
  const left = () => {
    const { sentPictures, stories } = f.store.read(1);
    const ids = sentPictures!.map(one => one.messageId);
    const lighthouse = stories[story.id];
    return [ids.filter(id => id >= 8000 && id < 9000).length, ids.filter(id => id < 8000 || id > 9000),
      Object.keys(stories).length, lighthouse ? history(lighthouse, lighthouse.branches[fork].head).length : 0];
  };
  // Each deletion shows its screen at once and then takes the pictures of the scenes it took, a hundred to a call: a
  // branch none of a scene another branch still has, and the last branch of a story the whole story.
  for (const [label, route, calls, after, removed] of [
    ['a fork with no scene of its own', `branch:${story.id}:${bare}`, [], [250, [501, 502, 503, 504, 9001, 9002, 9003], 2, 2], undefined],
    ['the first branch', `branch:${story.id}:${first}`, [['deleteMessages', 2]], [250, [501, 504, 9001, 9002, 9003], 2, 2], [2, 0]],
    ['the seed and its story', `seed:${story.seedId}`, [['deleteMessages', 100], ['deleteMessages', 100], ['deleteMessages', 52]],
      [0, [9001, 9002, 9003], 1, 0], [252, 0]],
    ['the last branch of the harbour, in a batch Telegram refuses', `branch:${harbour.storyId}:${harbour.branchId}`,
      [['deleteMessage', 9001], ['deleteMessage', 9003]], [0, [], 0, 0], [2, 1]],
  ] as const) {
    await f.bot.handle(f.click(`view:delete-${route}`));
    const sentBefore = f.sent.length, rowsBefore = f.rows.length;
    await f.bot.handle(f.click(`remove-${route}`));
    // The update is handled, the library written and the screen out while Telegram still holds the batch.
    if (refuse) assert.deepEqual(f.sent.slice(sentBefore).map(call => call.method), ['answerCallbackQuery', 'sendMessage'], label);
    refuse?.();
    await f.bot.idle();
    const out = f.sent.slice(sentBefore);
    assert.equal(out[1].payload.text, render(f.store.read(1), 'seeds:0').text, label);
    assert.deepEqual(out.slice(2).map(call => [call.method, call.payload.message_ids?.length ?? call.payload.message_id]), calls, label);
    assert.deepEqual(left(), after, label);
    // One row, in counts: no message, story or scene id.
    assert.deepEqual(f.rows.slice(rowsBefore).filter(row => row.event === 'pictures_removed'),
      removed ? [{ event: 'pictures_removed', picturesRemoved: removed[0], picturesNotRemoved: removed[1], actor: 'owner' }] : [], label);
  }
  assert.deepEqual(f.sent.filter(call => call.method === 'deleteMessages').flatMap(call => call.payload.message_ids),
    [502, 503, 501, 504, ...Array.from({ length: 250 }, (_, n) => 8000 + n)], 'the ids, in order');
  assert.deepEqual(f.store.read(2), theirs, 'another reader');
});

test('/compact is explicit, deduplicated and never creates a scene; an automatic one hands the next scene its new memory', async t => {
  // Asked for, then with its progress messages refused by Telegram: neither undoes the memory, asks the model again or
  // shows what the model wrote.
  for (const [label, progressFailure] of [['asked for', false], ['progress not delivered', true]] as const) {
    const f = fixture(t, { progressFailure, generate: async (request, controls) => {
      await controls.onText('PRIVATE GENERATED MEMORY');
      return compactResult(request);
    } });
    await battleFixture(f);
    const before = f.store.read(1);
    const update = f.message('/compact');
    await f.bot.handle(update);
    await f.bot.idle();
    await f.bot.handle(update);
    await f.bot.idle();
    const state = f.store.read(1);
    const story = state.stories[state.active!.storyId];
    assert.deepEqual([state.job, f.requests.length, Object.keys(story.memories).length], [null, 1, 1], label);
    assert.deepEqual(story.nodes, before.stories[story.id].nodes, label);
    assert.equal(context(story, story.branches[state.active!.branchId]).recent.length, 4, label);
    assert.deepEqual(['pre-compaction', 'compaction'].map(kind => Object.values(story.checkpoints).filter(cp => cp.kind === kind).length), [1, 1], label);
    assert.match(f.sent.at(-1)!.payload.text, /Сжатие готово/, label);
    assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE GENERATED MEMORY/, label);
    // The retained tail cannot be silently discarded.
    await f.bot.handle(f.click('compact'));
    await f.bot.idle();
    assert.equal(f.requests.length, 1, label);
    assert.match(f.sent.at(-1)!.payload.text, /нечего сжимать/, label);
  }

  // A branch past the threshold is compacted before its next scene, which is written from the new memory, saved and
  // sent with no service card.
  const f = fixture(t, { compactAtTokens: 10000, generate: async (request, controls) => {
    if (request.purpose === 'memory') return compactResult(request);
    const text = '2026-08-03 20:00\n\nПосле сжатия зажгли фонарь.';
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 4000, outputTokens: 40, totalTokens: 4040 } };
  } });
  const seed = await f.seed();
  f.store.mutate(1, state => {
    newStory(state, seed);
    for (let i = 0; i < 8; i++) commitTurn(state, beginJob(state, `Сцена ${i}`, i).id, `2026-08-02 20:00\n\n${'ветер '.repeat(400)}`);
  });
  await f.bot.handle(f.message('/continue'));
  await f.bot.idle();
  const state = f.store.read(1);
  const story = Object.values(state.stories)[0];
  const branch = story.branches[state.active!.branchId];
  assert.deepEqual([Object.keys(story.nodes).length, context(story, branch).memories.length, context(story, branch).recent.length], [9, 1, 5], 'automatic');
  assert.equal(story.nodes[branch.head!].requestContext!.memory, branch.memory, 'automatic');
  assert.deepEqual([f.requests.length, f.sent.at(-1)!.method], [2, 'sendRichMessage'], 'automatic');
  assert.match(f.sent.at(-1)!.payload.rich_message.markdown, /После сжатия зажгли фонарь/, 'automatic');
});

test('private state cannot be reached from another user, group or unconfirmed delete callback', async t => {
  let downloads = 0;
  const body = 'Описание синтетического острова. '.repeat(300);
  const drawn: SampleRequest[] = [];
  const f = fixture(t, { illustrator: sketchbook(drawn), readSeedFile: async () => { downloads++; return body; } });
  const shown = () => f.sent.at(-1)!.payload.text;
  const { staleButton, lookTooLong, lookNeedsText, lookGone, sampleOff } = texts('ru').errors;
  await f.start();
  const { stories, active } = f.store.read(1);
  const story = Object.values(stories)[0];
  await f.bot.handle(f.click(`use:${story.id}:${active!.branchId}`, 2));
  assert.equal(f.store.read(2).active, null, 'another user');
  await f.bot.handle(f.click(`remove-seed:${story.seedId}`));
  assert.equal(Object.keys(f.store.read(1).seeds).length, 1, 'an unconfirmed delete');
  const group = f.message('/continue'); group.message.chat = { id: -10, type: 'group' };
  await f.bot.handle(group);
  await f.bot.handle(f.message('/continue', 99));
  assert.equal(f.requests.length, 1, 'a group or a stranger');

  // A button whose IDs are not library IDs is stale: answered once, recorded, and nothing changes. Object.prototype
  // names stand in for each ID these actions look up; a delete is confirmed first, as the UI does.
  const replies = () => f.sent.filter(m => m.method === 'sendMessage').map(m => m.payload.text);
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
    const after = f.store.read(1);
    assert.deepEqual([replies().slice(count), after.seen.includes(update.update_id)], [[staleButton], true], data);
    assert.deepEqual({ ...after, seen: before.seen }, before, data);
  }
  assert.equal(f.requests.length, 1, 'no model call from a stale button');
  await f.bot.handle(f.click(`use:${story.id}:${active!.branchId}`));
  await f.bot.handle(f.message('/continue'));
  await f.bot.idle();
  const current = f.store.read(1).stories[story.id];
  assert.deepEqual([f.requests.length, history(current, current.branches[active!.branchId].head).length], [2, 2], 'later input works');

  // Text starting with an Object.prototype name is ordinary text: a move in the story, or a part of a seed draft.
  for (const text of ['constructor', 'toString и дальше текст', '__proto__']) {
    const update = f.message(text);
    await f.bot.handle(update);
    await f.bot.idle();
    await f.bot.handle(update);
    await f.bot.idle();
    const state = f.store.read(1);
    const where = state.stories[state.active!.storyId];
    assert.equal(history(where, where.branches[state.active!.branchId].head).at(-1)!.input, text, text);
  }
  assert.equal(f.requests.length, 5, 'one scene for each text, replayed or not');
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message(seedText));
  await f.bot.handle(f.message('valueOf'));
  await f.bot.handle(f.click(`save-seed:${(f.store.read(1).ui as SeedDraft).draftId}`));
  assert.match(Object.values(f.store.read(1).seeds).at(-1)!.text, /СЕВЕР\.\n\nvalueOf$/, 'valueOf in a draft');

  // Seed files are read only for an allowed reader's private draft, once, and a caption is never a command.
  const attachment = (user = 1, chat = user) => {
    const update = f.message(undefined, user);
    Object.assign(update.message, { chat: { id: chat, type: chat === user ? 'private' : 'group' }, caption: '/cancel',
      document: { file_name: 'seed.md', file_id: 'synthetic' } });
    return update;
  };
  for (const [label, update] of [['a stranger', attachment(99)], ['no open draft', attachment()], ['a group', attachment(1, -1)]] as const) {
    await f.bot.handle(update);
    assert.equal(downloads, 0, label);
  }
  await f.bot.handle(f.message('/new'));
  await f.bot.handle(f.message('Маяк\n2026-08-02 20:00'));
  const file = attachment();
  await f.bot.handle(file);
  await f.bot.handle(file);
  const draft = f.store.read(1).ui as SeedDraft;
  assert.deepEqual([downloads, draft.parts.length], [1, 2], 'a file in an open draft, replayed');
  await f.bot.handle(f.click(`save-seed:${draft.draftId}`));
  assert.equal(Object.values(f.store.read(1).seeds).at(-1)!.text, body.trim(), 'a saved file');

  // A look lands on one person of the story's sheet, as one line, and is never a move in the story. A button names a
  // person by their place on the sheet and the hash of their name (local/picture.ts `personTag`).
  const mira = { name: 'Мира', look: 'A tall woman with short grey hair.', outfit: 'a dark wool coat' };
  const oleg = { name: 'Олег', look: 'A broad-shouldered man with a shaved head.', outfit: 'a fisherman sweater' };
  f.store.mutate(1, library => { library.stories[story.id].sheet = [mira, oleg]; });
  const at = (index: number | string, name: string) => `${story.id}:${index}:${personTag(name)}`;
  const sheet = () => f.store.read(1).stories[story.id].sheet!;
  await f.bot.handle(f.click(`look-edit:${at(1, 'Олег')}`));
  await f.bot.handle(f.message('A broad-shouldered man\nwith a shaved head  and a broken nose.'));
  assert.deepEqual([sheet(), f.store.read(1).ui],
    [[mira, { ...oleg, look: 'A broad-shouldered man with a shaved head and a broken nose.', edited: true }], null], 'a look');
  // What does not fit is refused and the bot keeps waiting; any button or command leaves without a change.
  const waiting = { input: 'look', storyId: story.id, name: 'Мира' };
  for (const [label, update, reply, ui, look] of [
    ['a look too long', f.message('y'.repeat(401)), lookTooLong, waiting, mira.look],
    ['a blank look', f.message(' \n '), lookNeedsText, waiting, mira.look],
    ['a message without text', f.message(undefined), lookNeedsText, waiting, mira.look],
    ['a button', f.click('view:home'), undefined, null, mira.look],
    ['a command', f.message('/last'), undefined, null, mira.look],
    ['a look at the limit', f.message(`${'x'.repeat(399)}.`), undefined, null, `${'x'.repeat(399)}.`],
  ] as const) {
    await f.bot.handle(f.click(`look-edit:${at(0, 'Мира')}`));
    await f.bot.handle(update);
    if (reply) assert.equal(shown(), reply, label);
    assert.deepEqual([f.store.read(1).ui, sheet()[0].look], [ui, look], label);
  }
  // The wait keeps its person: once the sheet is written anew without her, the look has nowhere to go.
  await f.bot.handle(f.click(`look-edit:${at(0, 'Мира')}`));
  const rewritten = [{ name: 'Олег', look: 'Another man.', outfit: '' }];
  f.store.mutate(1, library => { library.stories[story.id].sheet = rewritten; });
  await f.bot.handle(f.message('A tall woman with a braid.'));
  assert.deepEqual([shown(), f.store.read(1).ui, sheet()], [lookGone, null, rewritten], 'a person gone from the sheet');
  // So does a button: one for nobody on the sheet is stale, and so is one of another reader, whose library has no such
  // person.
  await f.start(2);
  for (const [label, data, user] of [
    ['her place, now his', `look-edit:${at(0, 'Мира')}`, 1], ['a place off the sheet', `look-edit:${at(5, 'Олег')}`, 1],
    ['a place that is no number', `look-edit:${at('x', 'Олег')}`, 1], ['no name', `look-edit:${story.id}:0`, 1],
    ['a story not in the library', `look-edit:h404:0:${personTag('Олег')}`, 1],
    ['an Object.prototype name', `look-edit:__proto__:0:${personTag('Олег')}`, 1], ['another reader', `look-edit:${at(0, 'Олег')}`, 2],
  ] as const) {
    await f.bot.handle(f.click(data, user));
    assert.deepEqual([shown(), f.store.read(user).ui], [staleButton, null], label);
  }
  assert.deepEqual(sheet(), rewritten, 'the sheet after the stale buttons');

  // A style of the reader's own: the text after its button is the style, chosen at once and never a move in the story;
  // it is edited, drawn from the scene the reader is at, and deleted only after a confirmation.
  await f.bot.handle(f.click('style-new'));
  await f.bot.handle(f.message('Уголь\nCharcoal sketch on rough paper'));
  const [styleId] = Object.keys(f.store.read(1).pictureStyles!);
  assert.deepEqual([f.store.read(1).pictureStyles, f.store.read(1).pictureStyle, f.store.read(1).ui],
    [{ [styleId]: { id: styleId, name: 'Уголь', line: 'Charcoal sketch on rough paper' } }, styleId, null], 'a new style');
  await f.bot.handle(f.click(`style-edit:${styleId}`));
  await f.bot.handle(f.message('Мел\nWhite chalk on a blackboard'));
  assert.deepEqual(f.store.read(1).pictureStyles![styleId], { id: styleId, name: 'Мел', line: 'White chalk on a blackboard' }, 'an edited style');
  await f.bot.handle(f.click(`style-sample:${styleId}`));
  await f.bot.idle();
  const where = f.store.read(1).active!;
  assert.deepEqual(drawn.map(({ storyId, branchId, nodeId, styles }) => [storyId, branchId, nodeId, styles.map(style => [style.line, style.pictureStyle, style.caption.text])]),
    [[where.storyId, where.branchId, f.store.read(1).stories[where.storyId].branches[where.branchId].head, [['White chalk on a blackboard', 'custom', 'Пример стиля: ✍️ Мел']]]], 'a sample');
  await f.bot.handle(f.click(`remove-style:${styleId}`));
  assert.ok(f.store.read(1).pictureStyles![styleId], 'a delete without its confirmation');
  await f.bot.handle(f.click(`view:delete-style:${styleId}`));
  await f.bot.handle(f.click(`remove-style:${styleId}`));
  assert.deepEqual([f.store.read(1).pictureStyles, f.store.read(1).pictureStyle], [{}, undefined], 'a confirmed delete');
  await f.bot.handle(f.click(`style:${styleId}`));
  assert.equal(shown(), staleButton, 'the button of a deleted style');
  // Another reader is not drawn for, and the card never hears of them.
  await f.bot.handle(f.click('style-sample:film', 2));
  assert.deepEqual([shown(), drawn.length], [sampleOff, 1], 'another reader');
  assert.equal(f.requests.length, 6, 'no look, file, style or stale button asks the model');
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
