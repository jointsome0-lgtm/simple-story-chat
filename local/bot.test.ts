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
import { OWN_STYLES_MAX, PRESETS } from './picture-style.ts';
import { multipartBody } from './telegram.ts';
import type { TelegramPayload } from './telegram.ts';
import { storyFile } from './story-file.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { texts } from './text.ts';
import { UserError, active, addSeed, factsOf, history, newStory, beginJob, commitTurn, context } from '../lib/library.ts';
import type { Job, MoveInput, SeedDraft, SentPicture } from '../lib/library.ts';

// Scene and memory requests from the bot always pass a text callback.
type TextControls = GenerateControls & Required<Pick<GenerateControls, 'onText'>>;
type FixtureOptions = {
  progressFailure?: boolean; contextFailure?: boolean; deliveryFailure?: boolean;
  generate?: (request: ModelRequest, controls: TextControls) => Promise<GenerationResult>;
  gpu?: GpuController; readSeedFile?: BotOptions['readSeedFile']; readPicture?: BotOptions['readPicture'];
  model?: string; providerName?: string; compactAtTokens?: number; ownerId?: string; illustrator?: Illustrator;
  // Holds a Telegram call until the returned promise settles.
  hold?: (method: string, payload: Payload) => Promise<void> | undefined;
};
// A log row as main.ts writes it: the event, a code and the allowed details.
type Row = { event: string; code?: string | number } & ErrorDetails;
// Fields of sent payloads that the tests read; each is present for the methods where it is read.
type Payload = { chat_id: number; message_id: number; message_ids: number[]; text: string; rich_message: { markdown: string }; draft_id: number; reply_markup?: unknown };
// A synthetic private message; tests may replace its chat or add rich content, a document or a caption.
type MessageUpdate = Update & { message: NonNullable<Update['message']> & { chat: { id: number; type: string }; caption?: string } };
// Summary requests carry their scenes as JSON in the first message.
type SummaryInput = { newScenes: { id: string }[] };

// The last message the bot sent or edited, past its tidying after it (docs/telegram-ui.md#passing-messages), which the
// reader must still see: one the bot deleted or wrote over later fails the test. The fake Telegram gives each call the
// id of its place among the calls.
function said<T extends { method: string; payload: { message_id?: number; message_ids?: number[] } }>(sent: T[]) {
  const at = sent.findLastIndex(one => !['deleteMessage', 'deleteMessages', 'editMessageReplyMarkup'].includes(one.method));
  const one = sent[at];
  const id = one?.method === 'editMessageText' ? one.payload.message_id : at + 1;
  const later = sent.slice(at + 1).filter(call => call.method !== 'editMessageReplyMarkup')
    .flatMap(call => call.payload.message_ids ?? [call.payload.message_id]);
  assert.ok(!later.includes(id), `message ${id} is still there`);
  return one;
}
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
    readSeedFile: options.readSeedFile, readPicture: options.readPicture, render, scenePrefix, sceneKeyboard, model: options.model ?? 'test-model',
    providerName: options.providerName ?? 'claude-code', compactAtTokens: options.compactAtTokens ?? 54000, ownerId: options.ownerId,
    log: (event, code, details) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); } });
  const message = (text: string | undefined, user = 1, updateId = ++sequence): MessageUpdate => ({ update_id: updateId,
    message: { from: { id: user, language_code: 'ru' }, chat: { id: user, type: 'private' }, text } });
  // `on`: the message the button is under, as Telegram names it; without it the bot answers with a message of its own.
  const click = (data: string, user = 1, on?: number) => ({ update_id: ++sequence,
    callback_query: { id: `q${sequence}`, from: { id: user, language_code: 'ru' }, message: { message_id: on, chat: { id: user, type: 'private' } }, data } });
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
  return { enabledFor: (userId: string) => userId === '1', standardStyle: PRESETS.semi, referencesFor: () => false, versionsFor: () => false,
    poseSetFor: () => false,
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
  assert.deepEqual(reopened(f.path, store => [store.read(1).job, store.read(1).jobInterrupted, store.read(1).seen.includes(update.update_id),
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
  assert.match(said(f.sent)!.payload.text, /^🌐 Язык интерфейса/, 'the language picker from a draft');
  for (const action of ['view:home', 'continue', 'new-seed', `start:${Object.keys(before.seeds)[0]}`, 'lang:en']) {
    await f.bot.handle(f.click(action));
    assert.equal((f.store.read(1).ui as SeedDraft).draftId, draftId, action);
  }
  assert.match(said(f.sent)!.payload.text, /^📝 Seed draft, not saved yet\nReceived: 1 part · /, 'a draft in English');
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
    assert.match(said(g.sent)!.payload.text, menu, label);
    if (language === 'en') assert.doesNotMatch(said(g.sent)!.payload.text, /[А-Яа-яЁё]/, label);
  }

  // The interface language names what the bot creates and never reaches the model; /language changes it, a stale
  // language button changes nothing, and the choice survives a reload.
  const g = fixture(t);
  const shown = () => g.sent.filter(item => item.method === 'sendMessage').at(-1)!.payload.text;
  await g.bot.handle(speaking(g.message('/start'), 'en-GB'));
  // A refusal thrown by the library carries a key and is shown in the reader's language.
  await g.bot.handle(speaking(g.click('start:s999'), 'en'));
  assert.equal(shown(), texts('en').errors.seedGone, 'a refusal from the library');
  await g.bot.handle(speaking(g.message('/nope'), 'en'));
  assert.equal(shown(), texts('en').notices.unknownCommand, 'an unknown command');
  await g.start();
  const story = Object.values(g.store.read(1).stories)[0];
  assert.deepEqual([Object.values(story.branches).map(branch => branch.name), Object.values(story.checkpoints).map(cp => cp.label)],
    [['Start'], ['Seed', 'Scene 1']], 'names the bot creates');
  assert.ok(g.sent.findLast(item => item.method === 'sendRichMessage')!.payload.rich_message.markdown
    .startsWith(`${scenePrefix(null, { provider: 'claude-code', model: 'test-model' }, 'en', { branch: 'Start', scene: 1 }).slice(0, -3)} · 📏 Context`), 'the header of a scene');
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
  const { deliveryUnconfirmed, truncated, modelUnavailable, modelServiceSeparate, gpuNotConfigured } = texts('ru').notices;
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

  // A scene goes out, as a draft and as its message, under a header with its model and the share of the context, which
  // is no part of the scene; /context has the numbers of the story.
  const f = fixture(t, { model: 'claude-haiku-4-5-20251001' });
  await f.start();
  const haiku = { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' };
  const [scene] = Object.values(Object.values(f.store.read(1).stories)[0].nodes);
  assert.deepEqual([scene.modelInfo, scene.text], [haiku, '2026-08-02 20:00\n\nСинтетическая сцена 1.'], 'a scene');
  for (const method of ['sendRichMessageDraft', 'sendRichMessage']) {
    assert.ok(f.sent.find(m => m.method === method)!.payload.rich_message.markdown.startsWith(`${scenePrefix(null, haiku, 'ru', { branch: 'Начало', scene: 1 }).slice(0, -3)} · 📏`), method);
  }
  await f.bot.handle(f.message('/context'));
  assert.match(said(f.sent)!.payload.text, /≈\d/, '/context');
  // A provider without a check (a CLI) that has written nothing was never seen to answer.
  const cli = fixture(t);
  await cli.bot.handle(cli.click('view:model'));
  assert.ok(said(cli.sent)!.payload.text.includes(texts('ru').model.configured), 'a provider without a check');

  // /model checks the selected server without generating and shows a failure; an archived scene keeps its label.
  let checks = 0;
  const server = createBot({ store: f.store, api: f.api, provider: { async check({ signal }: Controls) {
    assert.ok(signal instanceof AbortSignal);
    if (++checks === 2) throw new Error('synthetic unreachable server');
  }, async generate() { assert.fail('health checks must not generate'); } },
  allowedUsers: new Set(['1']), maxOutputTokens: 4096, render, scenePrefix, sceneKeyboard, model: 'gemma-4-test', providerName: 'llama-cpp' });
  await server.handle(f.message('/model'));
  assert.match(said(f.sent)!.payload.text, /gemma-4-test/, 'a server that answers');
  assert.match(said(f.sent)!.payload.text, /доступ|успеш|ответил/i, 'a server that answers');
  await server.handle(f.click('view:model'));
  assert.match(said(f.sent)!.payload.text, /недоступ|не ответил|не удалось/i, 'a server that does not');
  await server.handle(f.message('/last'));
  const last = said(f.sent)!.payload.rich_message.markdown;
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
  // Without GPU control, simple-serving says its service is started apart from this chat, and another provider that no
  // GPU is configured.
  for (const [g, notice] of [[down, modelServiceSeparate], [cli, gpuNotConfigured]] as const) for (const command of ['/gpu_start', '/gpu_pause']) {
    await g.bot.handle(g.message(command));
    assert.equal(said(g.sent)!.payload.text, notice, command);
  }
});

test('a move that became no scene is kept for the reader to repeat, only on their press and only where it was lost', async t => {
  let fails = false;
  const f = fixture(t, { generate: async request => {
    if (fails) throw new ModelError('provider_failed');
    return { text: `2026-08-02 20:00\n\nСцена ${f.requests.length}.`, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  } });
  const update = await f.start();
  const lost = () => f.store.read(1).lostMove;
  const asked = () => f.requests.filter(request => JSON.stringify(request.messages).includes('Мой потерянный ход')).length;
  const buttons = () => JSON.stringify(sceneKeyboard(f.store.read(1)));

  // A failure keeps the words and offers them under the failure; nothing runs them by itself.
  fails = true;
  await f.bot.handle(f.message('Мой потерянный ход'));
  await f.bot.idle();
  assert.equal(lost()?.input, 'Мой потерянный ход');
  assert.ok(JSON.stringify(f.sent.at(-1)!.payload.reply_markup).includes(`"retry:${lost()!.job}"`) && f.sent.at(-1)!.payload.text.includes('/retry'));
  assert.equal(asked(), 1, 'a failed move is not run again by itself');

  // A press runs the same words as the reader's own move, here not the narrator's; a second failure keeps them still.
  await f.bot.handle(f.click('retry'));
  await f.bot.idle();
  assert.equal(asked(), 2);
  assert.equal(lost()?.input, 'Мой потерянный ход');
  fails = false;
  await f.bot.handle(f.message('/retry'));
  await f.bot.idle();
  const state = f.store.read(1);
  const story = Object.values(state.stories)[0];
  assert.deepEqual([asked(), state.lostMove, Object.values(story.nodes).at(-1)!.input], [3, undefined, 'Мой потерянный ход']);
  assert.ok(!buttons().includes('"retry:'));

  // A scene the reader took another way past it leaves nothing to repeat there, and an old button says so.
  fails = true;
  await f.bot.handle(f.message('Мой потерянный ход'));
  await f.bot.idle();
  fails = false;
  await f.bot.handle(f.message('Другой ход'));
  await f.bot.idle();
  assert.equal(lost(), undefined, 'the next move takes its place');
  const before = f.requests.length;
  await f.bot.handle(f.click('retry'));
  await f.bot.idle();
  assert.equal(f.requests.length, before, 'nothing to repeat');
  assert.ok(f.sent.at(-1)!.payload.text.includes('Повторять нечего'));

  // Stopping a scene is the reader's own word, and keeps nothing.
  fails = true;
  await f.bot.handle(f.message('Мой потерянный ход'));
  await f.bot.idle();
  const held = f.store.read(1).lostMove!;
  f.store.mutate(1, state => {
    delete state.lostMove;
    state.job = { id: 'j900', storyId: held.storyId, branchId: held.branchId, head: held.head, memory: null, input: 'Ход на момент остановки', started: 0 };
  });
  await f.bot.handle(f.message('/cancel'));
  assert.equal(lost(), undefined);

  // A process that dies under a turn keeps the move too and runs nothing; the reader is told once, and a compaction has
  // no move to keep.
  f.store.mutate(1, state => { state.job = { id: 'j901', storyId: held.storyId, branchId: held.branchId, head: held.head, memory: null, input: 'Ход на момент смерти', started: 0 }; });
  f.store.offset(update.update_id + 1);
  const after = f.requests.length;
  assert.deepEqual(reopened(f.path, store => store.read(1).lostMove?.input), 'Ход на момент смерти');
  assert.equal(f.requests.length, after);
  assert.deepEqual(reopened(f.path, store => store.recover()), ['1'], 'a start that did not get to tell them leaves it to the next');
  await f.bot.interrupted(['1', '77']);
  assert.ok(f.sent.at(-1)!.payload.text.includes('/retry') && JSON.stringify(f.sent.at(-1)!.payload.reply_markup).includes('"retry:j901"'));
  assert.equal(f.sent.at(-1)!.payload.chat_id, 1, 'a reader off the access list is told nothing');
  assert.deepEqual(reopened(f.path, store => store.recover()), []);

  // A button left under an older failure does not repeat a newer move.
  const moves = f.requests.length;
  await f.bot.handle(f.click('retry:j1'));
  await f.bot.idle();
  assert.deepEqual([f.requests.length, f.store.read(1).lostMove?.input], [moves, 'Ход на момент смерти']);

  // A deleted story takes the reader's words with it.
  await f.bot.handle(f.click(`view:delete-seed:${Object.keys(f.store.read(1).seeds)[0]}`));
  await f.bot.handle(f.click(`remove-seed:${Object.keys(f.store.read(1).seeds)[0]}`));
  assert.equal(lost(), undefined);
  assert.ok(!JSON.stringify(f.store.read(1)).includes('Ход на момент смерти'));
});

test('another version leaves the old scene whole, and a turn that writes no scene leaves the reader where they stood', async t => {
  let mode: 'ok' | 'fail' | 'hold' = 'ok';
  const f = fixture(t, { generate: async (_request, controls) => {
    if (mode === 'fail') throw new ModelError('provider_failed');
    if (mode === 'hold') await new Promise(resolve => controls.signal?.addEventListener('abort', resolve));
    return { text: `2026-08-02 20:00\n\nСцена запроса ${f.requests.length}.`, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  } });
  const update = await f.start();
  await f.bot.handle(f.message('Мой ход'));
  await f.bot.idle();
  const here = () => {
    const state = f.store.read(1);
    const story = Object.values(state.stories)[0];
    return { state, story, branch: story.branches[state.active!.branchId], branches: Object.keys(story.branches).length };
  };
  const first = here();
  const again = `again:${first.story.id}:${first.branch.head}`;
  const where = () => [here().branch.id, here().branch.head, here().branches];
  const standing = [first.branch.id, first.branch.head, 1];

  // A button of a scene that is no longer the last one rewrites nothing.
  const asked = f.requests.length;
  await f.bot.handle(f.click(`again:${first.story.id}:n999999`));
  await f.bot.idle();
  assert.deepEqual([f.requests.length, where()], [asked, standing], 'a stale button');

  // A failure: the reader has not moved, no branch is left, and the kept move leaves the same point again.
  mode = 'fail';
  await f.bot.handle(f.click(again));
  await f.bot.idle();
  assert.deepEqual(where(), standing, 'a failed version');
  assert.equal(here().state.lostMove?.input, 'Мой ход');
  mode = 'ok';
  await f.bot.handle(f.click('retry'));
  await f.bot.idle();
  const second = here();
  const asks = JSON.stringify(f.requests.at(-1)!.messages);
  assert.ok(second.branch.id !== first.branch.id && second.branches === 2, 'the reader is on a branch of its own');
  assert.equal(second.story.nodes[second.branch.head!].input, 'Мой ход');
  assert.equal(second.story.nodes[second.branch.head!].parent, first.story.nodes[first.branch.head!].parent);
  assert.equal(second.story.branches[first.branch.id].head, first.branch.head, 'the old scene stays on its branch');
  assert.ok(!asks.includes(first.story.nodes[first.branch.head!].text.split('\n').at(-1)!), 'the request is told nothing of the old version');

  // While the scene is written the reader stands at the scene the chat ends with, and a stop leaves no branch.
  mode = 'hold';
  const standsNow = where();
  await f.bot.handle(f.click(`again:${second.story.id}:${second.branch.head}`));
  assert.deepEqual([where()[0], where()[1]], [standsNow[0], standsNow[1]], 'during a version');
  assert.equal(here().branches, 3);
  await f.bot.handle(f.message('/cancel'));
  await f.bot.idle();
  assert.deepEqual([where(), here().state.lostMove], [standsNow, undefined], 'a stopped version');

  // A process that dies under one leaves no branch either, and the kept move still knows where it leaves from.
  await f.bot.handle(f.click(`again:${second.story.id}:${second.branch.head}`));
  f.store.offset(update.update_id + 1);
  const dead = reopened(f.path, store => { const state = store.read(1); return [state.job, Object.keys(Object.values(state.stories)[0].branches).length, state.lostMove?.from?.head]; });
  assert.deepEqual(dead, [null, 2, first.story.nodes[first.branch.head!].parent]);
  await f.bot.handle(f.message('/cancel'));
  await f.bot.idle();
  mode = 'ok';

  // A stop of the bot cuts a move short as a death does: it is kept, and its reader is told at the next start.
  let stopping = false;
  const stopped = fixture(t, { generate: async (_request, controls) => {
    if (stopping) await new Promise((_resolve, reject) => controls?.signal?.addEventListener('abort', () => reject(new ModelError('provider_failed'))));
    return { text: '2026-08-02 20:00\n\nСинтетическая сцена.', finishReason: 'stop' };
  } });
  await stopped.start();
  stopping = true;
  await stopped.bot.handle(stopped.message('Ход под остановку'));
  await stopped.bot.stop();
  const kept = stopped.store.read(1);
  assert.deepEqual([kept.job, kept.lostMove?.input, kept.jobInterrupted], [null, 'Ход под остановку', true]);

  // The narrator's move stays the narrator's, also for a scene written before `SceneNode.move`.
  await f.bot.handle(f.click('continue'));
  await f.bot.idle();
  f.store.mutate(1, state => { const { story, branch } = active(state); delete story.nodes[branch.head!].move; });
  const old = here();
  await f.bot.handle(f.click(`again:${old.story.id}:${old.branch.head}`));
  await f.bot.idle();
  assert.equal(here().story.nodes[here().branch.head!].move, 'narrator');
});

test('a reply to an earlier scene asks first and goes on from there; to the last scene it is a move', async t => {
  const f = fixture(t);
  await f.start();
  await f.bot.handle(f.message('Второй ход'));
  await f.bot.idle();
  const replying = (text: string, to: number) => { const update = f.message(text); update.message.reply_to_message = { message_id: to }; return update; };
  const here = () => {
    const state = f.store.read(1);
    const story = Object.values(state.stories)[0];
    return { state, story, branch: story.branches[state.active!.branchId], nodes: Object.values(story.nodes) };
  };
  const [opening, lastOne] = here().nodes;

  // To the last scene: a move like any other, and so to a message that shows no scene.
  await f.bot.handle(replying('Ответ на последнюю', lastOne.messageId!));
  await f.bot.idle();
  await f.bot.handle(replying('Ответ не на сцену', 999_999));
  await f.bot.idle();
  assert.deepEqual(here().nodes.slice(-2).map(node => node.input), ['Ответ на последнюю', 'Ответ не на сцену']);

  // To an earlier one: no model call and no branch until the reader says so.
  const asked = f.requests.length;
  await f.bot.handle(replying('Ход с первой сцены', opening.messageId!));
  await f.bot.idle();
  const before = here();
  assert.deepEqual([f.requests.length, Object.keys(before.story.branches).length], [asked, 1]);
  const screen = f.sent.at(-1)!.payload;
  assert.ok(screen.text.includes('Ход с первой сцены'));
  const { checkpointId } = before.state.ui as MoveInput;

  // Another message ends the wait and the words it held, and the screen's button is stale from then on.
  await f.bot.handle(f.message('Передумал'));
  await f.bot.idle();
  assert.equal(here().state.ui, null);
  await f.bot.handle(f.click(`from-here:${checkpointId}:${(before.state.ui as MoveInput).asked}`));
  await f.bot.idle();
  assert.equal(Object.keys(here().story.branches).length, 1, 'a stale button');

  // The press goes on from that scene, and the branch the reader left stays whole. A scene shown again counts as itself.
  const left = here().branch;
  await f.bot.handle(f.message('/last'));
  await f.bot.idle();
  const again = here().story.nodes[left.head!];
  assert.equal(again.shownAs?.length, 1);
  await f.bot.handle(replying('Ход с первой сцены', opening.messageId!));
  await f.bot.idle();
  const waiting = here().state.ui as MoveInput;
  // A screen of an earlier reply, left in the chat by a restart, does not send this one's words.
  await f.bot.handle(f.click(`from-here:${waiting.checkpointId}:1`));
  await f.bot.idle();
  assert.equal(Object.keys(here().story.branches).length, 1, 'a stale screen');
  assert.equal((here().state.ui as MoveInput).move, 'Ход с первой сцены');
  await f.bot.handle(f.click(`from-here:${waiting.checkpointId}:${waiting.asked}`));
  await f.bot.idle();
  const after = here();
  assert.equal(after.story.nodes[after.branch.head!].input, 'Ход с первой сцены');
  assert.equal(after.story.nodes[after.branch.head!].parent, opening.id);
  assert.equal(after.story.branches[left.id].head, left.head, 'the branch left stays');
  const fresh = f.sent.filter(item => item.method === 'sendRichMessage').length;
  await f.bot.handle(replying('Ответ на показанную снова', again.shownAs![0]));
  await f.bot.idle();
  assert.equal((here().state.ui as MoveInput).move, 'Ответ на показанную снова');
  assert.equal(f.sent.filter(item => item.method === 'sendRichMessage').length, fresh);
});

test('a fact the reader corrects reaches the next request, and the memory before it stays with the checkpoints before it', async t => {
  const f = fixture(t, { generate: async request => request.purpose === 'memory' ? compactResult(request)
    : { text: '2026-08-02 21:00\n\nСинтетическая сцена.', finishReason: 'stop' } });
  await battleFixture(f);
  await f.bot.handle(f.message('/compact'));
  await f.bot.idle();
  const here = () => {
    const state = f.store.read(1);
    const { story, branch } = active(state);
    return { state, story, branch, facts: factsOf(story, branch) };
  };
  const first = here();
  const compacted = Object.values(first.story.checkpoints).find(cp => cp.kind === 'compaction')!;
  const original = first.facts[1].fact.text;
  const route = (one = first.facts[1]) => `${first.story.id}:${first.branch.id}:${one.version}:${one.index}`;

  // The way in is under the branch's detailed view. The fact is offered to copy, and the wait takes the reader's next
  // message for it, not for a move.
  await f.bot.handle(f.message('/context'));
  assert.ok(JSON.stringify(said(f.sent)!.payload.reply_markup).includes(`view:memory:${first.story.id}:${first.branch.id}:0`));
  const scenes = Object.keys(first.story.nodes).length;
  await f.bot.handle(f.click(`view:fact:${route()}`));
  assert.ok(said(f.sent)!.payload.text.includes(original));
  await f.bot.handle(f.click(`fact-edit:${route()}`));
  await f.bot.handle(f.message('Ворота пали на рассвете.'));
  await f.bot.idle();
  const edited = here();
  assert.deepEqual([Object.keys(edited.story.nodes).length, edited.state.job, edited.state.ui, edited.facts[1].fact.text],
    [scenes, null, null, 'Ворота пали на рассвете.']);
  assert.deepEqual(edited.facts[1].fact.source, first.facts[1].fact.source, 'the fact keeps the scenes it came from');
  assert.equal(edited.facts.length, first.facts.length);

  // The old memory stays what it was for the checkpoint before the edit, and a checkpoint marks the new one.
  assert.equal(edited.story.memories[compacted.memory!].delta.facts[1].text, original);
  assert.equal(Object.values(edited.story.checkpoints).at(-1)!.kind, 'memory');

  // A fact longer than a screen shows cannot come back whole from a copy of it, so it can only be taken out.
  const long = { ...edited.facts[1].fact, text: 'д'.repeat(3704) };
  f.store.mutate(1, state => { active(state).story.memories[edited.facts[1].version].delta.facts[1] = long; });
  await f.bot.handle(f.click(`view:fact:${route(edited.facts[1])}`));
  assert.ok(!JSON.stringify(said(f.sent)!.payload.reply_markup).includes('fact-edit') && JSON.stringify(said(f.sent)!.payload.reply_markup).includes('delete-fact'));
  f.store.mutate(1, state => { active(state).story.memories[edited.facts[1].version].delta.facts[1] = edited.facts[1].fact; });

  // A button of the memory as it was changes nothing now; taking a fact out needs its question.
  const count = Object.keys(edited.story.memories).length;
  await f.bot.handle(f.click(`fact-edit:${route()}`));
  await f.bot.handle(f.click(`view:delete-fact:${route()}`));
  await f.bot.handle(f.click(`remove-fact:${route()}`));
  assert.ok(said(f.sent)!.payload.text.includes('не записан'));
  const fresh = route(edited.facts[0]);
  await f.bot.handle(f.click(`remove-fact:${fresh}`));
  assert.equal(here().facts.length, first.facts.length, 'no question, no removal');
  assert.equal(Object.keys(here().story.memories).length, count);
  await f.bot.handle(f.click(`view:delete-fact:${fresh}`));
  await f.bot.handle(f.click(`remove-fact:${fresh}`));
  assert.equal(here().facts.length, first.facts.length - 1);

  // The next request reads the memory as the reader left it.
  await f.bot.handle(f.message('Дальше.'));
  await f.bot.idle();
  const asked = JSON.stringify(f.requests.at(-1)!.messages);
  assert.ok(asked.includes('Ворота пали на рассвете.'));
  assert.equal(asked.split(original).length - 1, first.facts.length - 2, 'the fact rewritten and the one taken out are not read');
  assert.equal(here().story.nodes[here().branch.head!].input, 'Дальше.');
});

test('a branch as a file holds its line and nothing of another, and goes to its reader alone', async t => {
  const f = fixture(t);
  await f.start();
  await f.bot.handle(f.message('Мой ход\nв две строки'));
  await f.bot.idle();
  const state = f.store.read(1);
  const { story, branch } = active(state);
  const nodes = history(story, branch.head);

  // The reader of another library has no such story, whatever the button says.
  await f.bot.handle(f.click(`export:${story.id}:${branch.id}`, 2));
  await f.bot.idle();
  assert.equal(f.sent.filter(item => item.method === 'sendDocument').length, 0);

  await f.bot.handle(f.click(`export:${story.id}:${branch.id}`));
  await f.bot.idle();
  const [{ payload }] = f.sent.filter(item => item.method === 'sendDocument') as unknown as { payload: { chat_id: number; document: Uint8Array; file_name: string } }[];
  const text = Buffer.from(payload.document).toString('utf8');
  assert.equal(payload.chat_id, 1);
  assert.ok(nodes.every(node => text.includes(node.text)), 'every scene of the line');
  assert.ok(text.indexOf(nodes[0].text) < text.indexOf('> Мой ход\n> в две строки') && text.indexOf('> в две строки') < text.indexOf(nodes[1].text), 'in order, each move above its scene');
  assert.ok(!text.includes(nodes[0].input), 'the bot\'s own instruction is no words of the reader\'s');
  assert.deepEqual(f.rows.filter(row => row.event === 'branch_exported').map(row => row.sceneCount), [2]);
  assert.ok(!JSON.stringify(f.rows).includes('Мой ход'), 'no row says what the file holds');

  // The name of a file travels in a header: nothing in a title can end that header.
  assert.ok(!/[\r\n"]/.test(storyFile({ ...state, stories: { [story.id]: { ...story, title: 'Ма"як\r\nX-Evil: 1' } } }, story.id, branch.id).name));
  const body = multipartBody({ chat_id: 1, document: new Uint8Array([1]), file_name: 'Ма"як\r\nX.txt' }, 'B').toString('utf8');
  assert.ok(body.includes('filename="МаякX.txt"') && !body.includes('name="file_name"'));
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
  // A scene waiting for the shared model shows its place in the queue in the scene's own draft: each status after the
  // one before, one superseded before it went out skipped, and nothing about the queue once the model has started,
  // though there is the time for one to go out before the scene.
  const queue = fixture(t, { generate: async (request, controls) => {
    const out = () => new Promise(resolve => setImmediate(resolve));
    controls.onWait?.(2); await out();
    controls.onWait?.(5); controls.onWait?.(1); await out();
    controls.onWait?.(0); await out();
    controls.onStart?.(); await out();
    controls.onWait?.(3); await out();
    await controls.onText(text);
    return { text, finishReason: 'stop', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  } });
  await queue.start();
  const { wait } = texts('ru');
  const drafts = queue.sent.filter(m => m.method === 'sendRichMessageDraft');
  assert.deepEqual([drafts.map(m => m.payload.rich_message.markdown.endsWith(text) ? 'scene' : m.payload.rich_message.markdown), new Set(drafts.map(m => m.payload.draft_id)).size],
    [[wait.queued(2), wait.queued(1), wait.next, wait.reading, 'scene'], 1], 'a place in the queue');

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
    // Pressed on the confirmation, whose place the screen after the deletion takes.
    await f.bot.handle(f.click(`remove-${route}`, 1, sentBefore));
    // The update is handled, the library written and the screen out while Telegram still holds the batch.
    if (refuse) assert.deepEqual(f.sent.slice(sentBefore).map(call => call.method), ['answerCallbackQuery', 'editMessageText'], label);
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
  // Apart from the bot's tidying of its own menus and waits, ordinary messages (docs/telegram-ui.md#passing-messages).
  assert.deepEqual(f.sent.filter(call => call.method === 'deleteMessages' && !call.payload.message_ids.every(id => f.sent[id - 1]?.method === 'sendMessage'))
    .flatMap(call => call.payload.message_ids), [502, 503, 501, 504, ...Array.from({ length: 250 }, (_, n) => 8000 + n)], 'the ids, in order');
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
    assert.match(said(f.sent)!.payload.text, /Сжатие готово/, label);
    assert.doesNotMatch(JSON.stringify(f.sent), /PRIVATE GENERATED MEMORY/, label);
    // The retained tail cannot be silently discarded.
    await f.bot.handle(f.click('compact'));
    await f.bot.idle();
    assert.equal(f.requests.length, 1, label);
    assert.match(said(f.sent)!.payload.text, /нечего сжимать/, label);
  }
  // Cut off at its limit, the memory is refused: the story stays as it was, and the status says why, never what the
  // model wrote.
  const cut = fixture(t, { generate: async (request, controls) => {
    await controls.onText('PRIVATE GENERATED MEMORY');
    return { ...compactResult(request), finishReason: 'length' };
  } });
  await battleFixture(cut);
  const whole = cut.store.read(1).stories;
  await cut.bot.handle(cut.message('/compact'));
  await cut.bot.idle();
  assert.deepEqual([cut.store.read(1).stories, cut.requests.length, said(cut.sent)!.payload.text.includes(texts('ru').compact.reasons.output_limit),
    JSON.stringify(cut.sent).includes('PRIVATE')], [whole, 1, true, false], 'a memory cut off at its limit');

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
  // The compaction's status may still be edited to its end after the scene, and nothing else is touched.
  const status = f.sent.findIndex(call => call.method === 'sendMessage' && call.payload.text.startsWith('🗜')) + 1;
  const at = f.sent.findLastIndex(call => !(call.method === 'editMessageText' && call.payload.message_id === status));
  const last = f.sent[at];
  assert.deepEqual([f.requests.length, status > 0, last.method], [2, true, 'sendRichMessage'], 'automatic');
  assert.match(last.payload.rich_message.markdown, /После сжатия зажгли фонарь/, 'automatic');
  assert.ok(!f.sent.some(call => call.payload.message_id === at + 1 || call.payload.message_ids?.includes(at + 1)), 'the scene untouched');
});

test('private state cannot be reached from another user, group or unconfirmed delete callback', async t => {
  let downloads = 0;
  const body = 'Описание синтетического острова. '.repeat(300);
  const drawn: SampleRequest[] = [];
  const f = fixture(t, { illustrator: sketchbook(drawn), readSeedFile: async () => { downloads++; return body; } });
  const shown = () => said(f.sent)!.payload.text;
  const { staleButton, lookTooLong, lookNeedsText, lookGone, sampleOff, styleTooLong, styleNeedsText, stylesFull } = texts('ru').errors;
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

  // Picture styles. A preset's button chooses the preset, the standard one being the preset it is.
  const mine = () => f.store.read(1);
  for (const [key, chosen] of [['film', 'film'], ['standard', undefined]] as const) {
    await f.bot.handle(f.click(`style:${key}`));
    assert.equal(mine().pictureStyle, chosen, `the preset ${key}`);
  }
  // A style of the reader's own: the text after its button is the style, chosen at once and never a move in the story.
  // A new version of one line keeps the name, and one of two lines renames it.
  await f.bot.handle(f.click('style-new'));
  await f.bot.handle(f.message('Уголь\nCharcoal sketch on rough paper'));
  const [styleId] = Object.keys(mine().pictureStyles!);
  assert.deepEqual([mine().pictureStyles, mine().pictureStyle, mine().ui],
    [{ [styleId]: { id: styleId, name: 'Уголь', line: 'Charcoal sketch on rough paper' } }, styleId, null], 'a new style');
  for (const [text, name] of [['Charcoal and white chalk', 'Уголь'], ['Мел\nWhite chalk on a blackboard', 'Мел']]) {
    await f.bot.handle(f.click(`style-edit:${styleId}`));
    await f.bot.handle(f.message(text));
    assert.deepEqual(mine().pictureStyles![styleId], { id: styleId, name, line: text.split('\n').at(-1) }, text);
  }
  // What does not fit is refused and the bot keeps waiting, and a button leaves; a line at the limit is kept whole,
  // named by its start.
  for (const [label, update, reply, ui, count] of [
    ['a style too long', f.message('y'.repeat(401)), styleTooLong, { input: 'style' }, 1],
    ['a message without text', f.message(undefined), styleNeedsText, { input: 'style' }, 1],
    ['a button', f.click('view:style'), undefined, null, 1],
    ['a style at the limit', f.message(`${'x'.repeat(399)}.`), undefined, null, 2],
  ] as const) {
    await f.bot.handle(f.click('style-new'));
    await f.bot.handle(update);
    if (reply) assert.equal(shown(), reply, label);
    assert.deepEqual([mine().ui, Object.keys(mine().pictureStyles!).length], [ui, count], label);
  }
  const copy = mine().pictureStyle!;
  assert.deepEqual(mine().pictureStyles![copy], { id: copy, name: `${'x'.repeat(39)}…`, line: `${'x'.repeat(399)}.` }, 'a style at the limit');
  // A delete needs its confirmation, and deleting the chosen style gives the pictures back to the standard one.
  await f.bot.handle(f.click(`remove-style:${copy}`));
  assert.ok(mine().pictureStyles![copy], 'a delete without its confirmation');
  await f.bot.handle(f.click(`view:delete-style:${copy}`));
  await f.bot.handle(f.click(`remove-style:${copy}`));
  assert.deepEqual([Object.keys(mine().pictureStyles!), mine().pictureStyle], [[styleId], undefined], 'a confirmed delete');
  await f.bot.handle(f.click(`style:${copy}`));
  assert.equal(shown(), staleButton, 'the button of a deleted style');
  // A full library takes no new style, nor one written while it filled up.
  await f.bot.handle(f.click('style-new'));
  f.store.mutate(1, library => { for (let n = 1; n < OWN_STYLES_MAX; n++) library.pictureStyles![`y${900 + n}`] = { id: `y${900 + n}`, name: `S${n}`, line: 'Ink.' }; });
  await f.bot.handle(f.message('Тушь\nInk wash on rice paper'));
  assert.deepEqual([shown(), mine().ui, Object.keys(mine().pictureStyles!).length], [stylesFull, null, OWN_STYLES_MAX], 'a style written while the library filled up');
  await f.bot.handle(f.click('style-new'));
  assert.deepEqual([shown(), mine().ui], [stylesFull, null], 'a full library');
  // A sample is drawn from the scene the reader is at, and chooses nothing.
  await f.bot.handle(f.click(`style-sample:${styleId}`));
  await f.bot.idle();
  const where = mine().active!;
  assert.deepEqual(drawn.map(({ storyId, branchId, nodeId, styles }) => [storyId, branchId, nodeId, styles.map(style => [style.line, style.pictureStyle, style.caption.text])]),
    [[where.storyId, where.branchId, mine().stories[where.storyId].branches[where.branchId].head, [['White chalk on a blackboard', 'custom', 'Пример стиля: ✍️ Мел']]]], 'a sample');
  assert.equal(mine().pictureStyle, undefined, 'a sample chooses nothing');
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

test('a pose-set file leaves the reader\'s queue only in the write that keeps its picture, so a stop halfway loses none', async t => {
  const picture = { bytes: new Uint8Array([1, 2, 3]), format: 'png' as const, width: 480, height: 640, strippedBytes: 0, sent: 'photo' as const };
  // The download waits until its read is cut short, as the stop cuts a real one (local/seed-file.ts).
  const waiting = (_message: unknown, signal?: AbortSignal) =>
    new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const illustrator = { ...sketchbook([]), referencesFor: () => true, poseSetFor: (userId: string) => userId === '1' } as unknown as Illustrator;
  const f = fixture(t, { illustrator, readPicture: waiting });
  await f.start();
  const storyId = Object.keys(f.store.read(1).stories)[0];
  f.store.mutate('1', state => {
    state.stories[storyId].sheet = [{ name: 'Мира', look: 'синтетическая' }];
    state.ui = { input: 'pose-set', storyId, name: 'Мира', at: Date.now() };
  });
  const photo = f.message(undefined);
  Object.assign(photo.message, { photo: [{ file_id: 'synthetic', width: 480, height: 640 }] });
  // The update ends with the file queued, while its download still waits.
  await f.bot.handle(photo);
  assert.equal(f.store.read(1).poseUploads?.length, 1);
  await f.bot.stop();
  assert.equal(f.store.read(1).poseUploads?.length, 1, 'a stop halfway leaves the file queued');
  assert.equal(f.store.read(1).stories[storyId].sheet![0].poseSet, undefined);
  const again = createBot({ store: f.store, api: f.api, provider: f.provider, illustrator, allowedUsers: new Set(['1', '2']), maxOutputTokens: 4096,
    render, scenePrefix, sceneKeyboard, readPicture: async () => picture });
  await again.idle();
  await again.handle(photo);
  await again.idle();
  assert.equal(f.store.read(1).stories[storyId].sheet![0].poseSet?.length, 1, 'the next start keeps it, once');
  assert.equal(f.store.read(1).poseUploads, undefined);
  await again.stop();
});

// A person's card and profile stay as a scene does, and an answer that did not get out leaves everything in place
// (docs/telegram-ui.md#passing-messages): none of them is ever lost to the bot's tidying.
test('a card, a profile and an answer that did not get out are never lost unnoticed', async t => {
  // What Telegram refuses: the scene, every message, or an edit whose answer is lost; and every call asked of it.
  let refusing: 'scene' | 'all' | 'edit' | undefined;
  const asked: string[] = [];
  const fail = (code: number | string) => Promise.reject(Object.assign(new Error('synthetic'), { code }));
  const f = fixture(t, { illustrator: { ...sketchbook([]), retell: async () => {} } as unknown as Illustrator, hold: method => {
    asked.push(method);
    return refusing === 'scene' && method === 'sendRichMessage' ? fail(429)
      : refusing === 'all' && ['sendMessage', 'editMessageText', 'sendRichMessage'].includes(method) ? fail(429)
      : refusing === 'edit' && method === 'editMessageText' ? fail('network') : undefined;
  } });
  await f.start();
  const { storyId, branchId } = f.store.read(1).active!;
  f.store.mutate(1, library => { library.stories[storyId].sheet = [{ name: 'Мира', look: 'A tall woman with short grey hair.', outfit: 'a dark wool coat' }]; });
  const ref = `${storyId}:0:${personTag('Мира')}`;
  // The fake Telegram gives each call the id of its place among the calls.
  const sentLast = () => f.sent.findLastIndex(one => one.method === 'sendMessage') + 1;
  const told = (text: string) => f.sent.filter(one => one.method === 'sendMessage' && one.payload.text === text).length;
  const touched = () => f.sent.filter(one => ['deleteMessage', 'deleteMessages', 'editMessageText'].includes(one.method))
    .flatMap(one => one.payload.message_ids ?? [one.payload.message_id]);
  await f.bot.handle(f.click(`view:characters:${storyId}`));
  const list = sentLast();
  await f.bot.handle(f.click(`view:character:${ref}`, 1, list));
  const card = sentLast();
  await f.bot.handle(f.click(`view:profile:${ref}`, 1, card));
  const profile = sentLast();
  await f.bot.handle(f.click(`view:character:${ref}`, 1, profile));
  await f.bot.handle(f.message('/menu'));
  assert.deepEqual(new Set([list, card, profile, sentLast()]).size, 4, 'each one a message of its own');
  // A description retold, whose status line Telegram may have turned into the card without saying so: it stays, and
  // the card is sent again.
  await f.bot.handle(f.click(`details-edit:${ref}`));
  await f.bot.handle(f.message('A tall woman with short grey hair and a scar.'));
  const status = sentLast();
  refusing = 'edit';
  await f.bot.idle();
  refusing = undefined;
  assert.ok(sentLast() > status, 'the card sent again');
  // A branch shown again whose scene Telegram refuses: the screen pressed stays, nothing is deleted and no notice is
  // sent, as before the passing messages; the branch's own screen still goes out.
  await f.bot.handle(f.click(`view:story:${storyId}`));
  const pressed = sentLast();
  refusing = 'scene';
  asked.length = 0;
  await f.bot.handle(f.click(`use:${storyId}:${branchId}`, 1, pressed));
  refusing = undefined;
  assert.deepEqual([asked, told(texts('ru').notices.deliveryUnconfirmed), touched().includes(pressed)],
    [['answerCallbackQuery', 'sendRichMessage', 'sendMessage'], 0, false], 'the scene refused, the screen out, nothing else');
  // A seed deleted whose result Telegram refuses: the deletion stands, the confirmation pressed stays, nothing is
  // deleted and no notice is tried, as before the passing messages.
  const seedId = Object.keys(f.store.read(1).seeds)[0];
  await f.bot.handle(f.click(`view:delete-seed:${seedId}`));
  const confirmation = sentLast();
  refusing = 'all';
  asked.length = 0;
  await f.bot.handle(f.click(`remove-seed:${seedId}`, 1, confirmation));
  refusing = undefined;
  assert.deepEqual([Object.keys(f.store.read(1).seeds).length, asked, touched().includes(confirmation)],
    [0, ['answerCallbackQuery', 'editMessageText'], false], 'deleted, the result refused, and nothing else asked');
  assert.deepEqual([card, profile, status, pressed].filter(id => touched().includes(id)), [], 'none of these written over or deleted');
});
