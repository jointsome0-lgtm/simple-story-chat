// The picture under a scene, end to end: the bot, a fake Telegram, a fake story model and a fake ComfyUI on
// loopback. No card, no network, no reader's story — the scenes here are the synthetic ones the bot tests use.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from './bot.ts';
import type { Update } from './bot.ts';
import { imageConfig } from './config.ts';
import { createScheduler } from './scheduler.ts';
import type { ImageConfig } from './config.ts';
import { defaultWorkflow } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { STYLE } from './illustrate.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { createIllustrator } from './picture.ts';
import { PRESETS } from './picture-style.ts';
import { Store } from './store.ts';
import type { TelegramPayload } from './telegram.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import type { SeedDraft } from '../lib/library.ts';

// A real PNG, written the way ComfyUI writes one: the whole prompt in a text chunk beside the pixels.
const RAW = Buffer.from([0, 10, 20, 30, 40, 50, 60, 0, 70, 80, 90, 100, 110, 120]);
const IHDR = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}
const pngCarrying = (text: string) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', IHDR),
  chunk('tEXt', Buffer.from(`prompt\0${text}`, 'latin1')),
  chunk('IDAT', deflateSync(RAW)), chunk('IEND', Buffer.alloc(0)),
]);
// The positive prompt of a filled graph: the longest text it carries. The negative one is empty here, and which
// node holds which is `applyToWorkflow`'s business (local/image-batch.ts tests it).
const promptOf = (graph: Graph) => (Object.values(graph)
  .flatMap(node => [node.inputs.text, node.inputs.prompt]).filter(value => typeof value === 'string') as string[])
  .sort((one, other) => other.length - one.length)[0] ?? '';

// The picture card: POST /prompt, poll /history/<id>, GET /view, and the two routes that stop a job. `jobMs` is how
// long the card draws; `failing` answers as ComfyUI answers for a graph it could not run.
function fakeComfy(options: { jobMs?: number; failing?: boolean } = {}) {
  const submitted: Graph[] = [];
  const done = new Set<string>();
  const seen = { interrupts: 0, queueDeletes: 0, cleared: [] as string[] };
  const finishAt = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/prompt') {
        submitted.push((await body()).prompt as Graph);
        const id = `p${submitted.length}`;
        finishAt.set(id, Date.now() + (options.jobMs ?? 0));
        return json({ prompt_id: id });
      }
      if (request.method === 'POST' && url.pathname === '/interrupt') {
        seen.interrupts++;
        // ComfyUI draws one job at a time and interrupts that one; an interrupted prompt lands in the history too,
        // so that the delete below has a record to remove.
        const running = [...finishAt.keys()][0];
        if (running !== undefined) { finishAt.delete(running); done.add(running); }
        return json({});
      }
      if (request.method === 'POST' && url.pathname === '/queue') { seen.queueDeletes++; return json({}); }
      // The card draws one job and queues the rest, and says which is which: only the one being drawn may be
      // interrupted, because the interrupt has no id (local/image-batch.ts `stopJob`).
      if (url.pathname === '/queue') {
        const waiting = [...finishAt.keys()];
        return json({ queue_running: waiting.slice(0, 1).map(id => [0, id]), queue_pending: waiting.slice(1).map((id, at) => [at + 1, id]) });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        seen.cleared.push(...((await body()).delete as string[]) ?? []);
        return json({});
      }
      if (url.pathname === '/system_stats') return json({ devices: [{ index: 0, vram_total: 32 * 1024 ** 3, vram_free: 8 * 1024 ** 3 }] });
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        const at = finishAt.get(id);
        if (at !== undefined && Date.now() >= at) { finishAt.delete(id); done.add(id); }
        if (!done.has(id)) return json({});
        if (options.failing) return json({ [id]: { status: { completed: false, status_str: 'error' } } });
        return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: `${id}.png`, subfolder: '', type: 'temp' }] } } } });
      }
      if (url.pathname === '/view') {
        const id = String(url.searchParams.get('filename')).replace('.png', '');
        response.setHeader('content-type', 'image/png');
        return response.end(pngCarrying(promptOf(submitted[Number(id.slice(1)) - 1])));
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  return { server, submitted, seen,
    listen: () => new Promise<string>(ready => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

// What the describing model answers. The sheet writes an age as a number and the frame carries a name in two
// fields the instruction forbids them in: both are what the assembly has to take out (local/illustrate.ts).
const SHEET = { characters: [{ name: 'Элин', look: 'A middle-aged woman, 48-year-old, lean, short ash-grey hair, grey wool coat' }] };
const FRAME = {
  moment: 'Элин stands with her back against the closed door', shot: 'Medium wide three-quarter shot',
  setting: 'A narrow stone passage, the door closed', objects: 'A splint of two boards beside Элина сумка',
  props: 'The grey-clad woman holds the only dagger in her right hand', light: 'Overcast morning light',
  people: [{ who: 'Элин', look: 'a 30 years old woman in red', state: 'her bandaged left forearm folded against her chest',
    action: 'leans her back against the door' }],
};
const STYLE_LINE = 'Synthetic test style line, one sentence and no more.';
const seedText = 'Маяк\n2026-08-02 20:00\nСмотритель встречает лодку. Кодовая фраза: СЕВЕР.';
type Row = { event: string; code?: string | number } & ErrorDetails;
type Payload = { chat_id: number; message_id: number; text: string; rich_message: { markdown: string }; photo: Uint8Array; reply_parameters?: { message_id: number };
  caption?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
type Sent = { method: string; payload: Payload };
// Which of the three calls a request is: a scene streams and has no schema, the other two are told apart by the
// field their schema asks for.
const kindOf = (request: ModelRequest) => {
  const properties = (request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !properties ? 'scene' : 'characters' in properties ? 'sheet' : 'frame';
};

type Options = {
  comfy?: string; users?: string[]; style?: string; offsetMs?: number; sheetReply?: object;
  // How many scene deliveries to hold, so that a test can send the next message while one is still in flight;
  // `scheduler` puts the real queue between the bot and the model, which is where a picture takes its slot;
  // `compactAtTokens` and `keepScenes` are what makes the bot prepare the next compaction while the reader reads.
  holdFinal?: number; scheduler?: boolean; compactAtTokens?: number; keepScenes?: number;
  // A workflow pinned on a card the way the ones in gpu/ are: it ends in SaveImage.
  saveImage?: boolean;
  // A model that refuses the sheet with this code, and a Telegram that will not delete a message.
  sheetError?: string; refuseDelete?: boolean;
  // What the model says the scene cost. Above `compactAtTokens` the bot prepares the next compaction while the
  // reader reads; the numbers are the model's own and say nothing about the size of these synthetic scenes.
  usage?: { inputTokens: number; outputTokens: number };
};
function fixture(t: TestContext, options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-picture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'story.sqlite'));
  t.after(() => store.close());
  const workflow = join(directory, 'workflow.json');
  const graph = defaultWorkflow();
  if (options.saveImage) graph['7'] = { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'frame' } };
  writeFileSync(workflow, JSON.stringify(graph));

  const sent: Sent[] = [];
  const rows: Row[] = [];
  const requests: ModelRequest[] = [];
  const deleted: number[] = [];
  let sequence = 0;
  const holding: (() => void)[] = [];
  let heldFinals = 0;
  const api = async (method: string, fields?: TelegramPayload) => {
    const payload = fields as Payload;
    if (method === 'deleteMessage') {
      deleted.push(payload.message_id);
      // Telegram refuses to delete a message that is gone, too old, or was never the bot's.
      if (options.refuseDelete) throw Object.assign(new Error('message to delete not found'), { code: 400 });
    }
    sent.push({ method, payload });
    const id = sent.length;
    // A scene that is still being delivered: the story is already committed and its job lock clear, so the reader
    // can answer here, which is the moment the bot has to get right.
    if (method === 'sendRichMessage' && heldFinals++ < (options.holdFinal ?? 0)) await new Promise<void>(go => holding.push(go));
    return { message_id: id };
  };
  const model: Provider = { async generate(request, controls?: GenerateControls) {
    requests.push(request);
    const kind = kindOf(request);
    if (kind === 'sheet' && options.sheetError) throw Object.assign(new Error(options.sheetError), { code: options.sheetError });
    if (kind === 'sheet') return { text: JSON.stringify(options.sheetReply ?? SHEET), finishReason: 'stop' };
    if (kind === 'frame') return { text: JSON.stringify(FRAME), finishReason: 'stop' };
    // A compaction prepared ahead asks with no stream and no schema; its answer is not a memory and is dropped by
    // the check, which is all this test needs from it — that it took the model's slot on the way.
    await controls?.onText?.('2026-08-02 20:00\n\n');
    return { text: `2026-08-02 20:00\n\nСинтетическая сцена ${requests.length}.`, finishReason: 'stop',
      usage: { ...(options.usage ?? { inputTokens: 100, outputTokens: 50 }),
        totalTokens: (options.usage?.inputTokens ?? 100) + (options.usage?.outputTokens ?? 50) } };
  } };
  // The queue the bot really runs on, when a test needs the slot itself: one slot, as one llama-server has.
  const scheduler = options.scheduler
    ? createScheduler(model as { generate: Provider['generate'] }, { pollMs: 2, quietMs: 0, log: (event, code, details) => rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }) })
    : undefined;
  if (scheduler) t.after(() => scheduler.close());
  const provider: Provider = scheduler ? scheduler.foreground : model;

  const images: ImageConfig | undefined = options.comfy === undefined ? undefined : {
    url: options.comfy, workflow, checkpoint: 'synthetic.safetensors', style: options.style,
    users: new Set(options.users ?? ['1']), waitMs: 5000, timeoutMs: 5000,
  };
  // The reader's wait is measured against the real clock of the bot, so a test that wants whole seconds moves this
  // one forward by a fixed offset instead of pretending time stands still. `restart` builds the bot and its
  // illustrator again over the same store and Telegram, and so forgets whatever they kept in memory.
  const boot = () => {
    const illustrator = images && createIllustrator(images,
      { store, provider, pollMs: 2, now: () => Date.now() + (options.offsetMs ?? 0) });
    const bot = createBot({ store, api, provider, illustrator, allowedUsers: new Set(['1', '2']), maxOutputTokens: 4096,
      render, scenePrefix, sceneKeyboard, model: 'test-model', ownerId: '1',
      compactAtTokens: options.compactAtTokens, keepScenes: options.keepScenes,
      log: (event, code, details) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); } });
    return { bot, illustrator };
  };
  let running = boot();

  const message = (text: string, user = 1): Update => ({ update_id: ++sequence,
    message: { from: { id: user, language_code: 'ru' }, chat: { id: user, type: 'private' }, text } });
  const click = (data: string, user = 1): Update => ({ update_id: ++sequence,
    callback_query: { id: `q${sequence}`, from: { id: user, language_code: 'ru' }, message: { chat: { id: user, type: 'private' } }, data } });
  async function start(user = 1) {
    await running.bot.handle(click('new-seed', user));
    await running.bot.handle(message(seedText, user));
    await running.bot.handle(click(`save-seed:${(store.read(user).ui as SeedDraft).draftId}`, user));
    const seedId = Object.keys(store.read(user).seeds)[0];
    await running.bot.handle(click(`start:${seedId}`, user));
  }
  // Lets every held delivery through, the way Telegram answers when the network comes back.
  const release = () => { for (const go of holding.splice(0)) go(); };
  const restart = async () => { await running.bot.stop(); running = boot(); };
  return { get bot() { return running.bot; }, get illustrator() { return running.illustrator; }, restart,
    store, sent, rows, requests, deleted, provider, message, click, start, release, workflow, directory };
}

// Waits for something the fake server or the bot does on its own; the whole file runs in milliseconds.
async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await delay(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const statuses = (sent: Sent[]) => sent.filter(one => one.method === 'sendMessage' && one.payload.text?.includes('Рисую'));
const told = (sent: Sent[], text: string) => sent.some(one => one.payload.text === text);
const seedIn = (graph: Graph) => (Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs as { seed: number }).seed;
const photos = (sent: Sent[]) => sent.filter(one => one.method === 'sendPhoto');

test('without the picture configuration a scene is written, sent and not described', async t => {
  const f = fixture(t);
  await f.start();
  await f.bot.idle();
  assert.equal(f.requests.length, 1, 'the scene is the only model call');
  assert.equal(f.requests.filter(request => request.outputSchema).length, 0);
  assert.equal(statuses(f.sent).length, 0);
  assert.equal(photos(f.sent).length, 0);
  assert.equal(f.rows.filter(row => row.event === 'picture').length, 0);
});

test('a reader who is not on the picture list gets the scene and nothing else', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  // The configuration is on, the card is up, and this reader is simply not one of the two named in it.
  const f = fixture(t, { comfy: root, users: ['2'] });
  await f.start();
  await f.bot.idle();
  assert.equal(f.requests.length, 1);
  assert.equal(statuses(f.sent).length, 0);
  assert.equal(photos(f.sent).length, 0);
  assert.equal(comfy.submitted.length, 0, 'nothing of this reader reached the card');
});

test('an illustrated scene: a status line, one description call, a prompt with our style and no names, then the photo', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE, offsetMs: 3400 });
  await f.start();
  await f.bot.idle();

  // The reader sees: the scene, then a status line under it, then the photo in its place.
  const scene = f.sent.find(one => one.method === 'sendRichMessage')!;
  assert.equal(statuses(f.sent).length, 1);
  const status = statuses(f.sent)[0];
  assert.ok(f.sent.indexOf(scene) < f.sent.indexOf(status), 'the picture is offered only after the scene is there');
  const photo = photos(f.sent)[0];
  assert.ok(photo, 'a photo was sent');
  assert.equal(photo.payload.reply_parameters?.message_id, f.sent.indexOf(scene) + 1, 'the photo hangs under its own scene');
  assert.deepEqual(f.deleted, [f.sent.indexOf(status) + 1], 'the status line is removed once the photo is there');

  // Two model calls after the scene: the sheet of the story and the frame of this scene, both with their schema.
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame']);
  const frame = f.requests[2];
  const properties = (frame.outputSchema as { properties: Record<string, { maxItems?: number }> }).properties;
  assert.deepEqual(Object.keys(properties).sort(), ['light', 'moment', 'objects', 'people', 'props', 'setting', 'shot']);
  assert.equal(properties.people.maxItems, 4);
  // The description continues the scene's own request: same system prompt, the story's history, instruction last.
  assert.equal(frame.system, f.requests[0].system);
  assert.match(frame.messages.at(-1)!.content, /Опиши ПОСЛЕДНЮЮ сцену/);

  // What the card was asked to draw: our style line last, no name of a character, no age as a number.
  const prompt = promptOf(comfy.submitted[0]);
  assert.ok(prompt.endsWith(STYLE_LINE), 'the style line is ours and stands last');
  assert.doesNotMatch(prompt, /Элин|Elin/);
  assert.doesNotMatch(prompt, /\d/, 'an age is a word, never a number');
  assert.match(prompt, /short ash-grey hair/, 'the sheet line is the appearance of a person it covers');
  assert.doesNotMatch(prompt, /woman in red/, 'and the model\'s own look for them is not sent beside it');
  assert.doesNotMatch(prompt, /Кодовая фраза|СЕВЕР|Синтетическая сцена/, 'the scene itself is not the prompt');

  // The picture that reaches the reader carries pixels and nothing else: ComfyUI wrote the prompt into the PNG.
  const bytes = Buffer.from(photo.payload.photo);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.ok(!bytes.includes('tEXt') && !bytes.includes(STYLE_LINE));

  // One row, in counts and words: how long the reader waited, and nothing of what was described or drawn.
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.equal(row.outcome, 'ready');
  assert.equal(row.code, undefined);
  assert.equal(row.actor, 'owner');
  assert.equal(row.pictureSeconds, 3, 'the seconds from the end of the scene to the photo, rounded');
  assert.ok(Number.isSafeInteger(row.pictureAfterSceneMs!) && row.pictureAfterSceneMs! >= 3400);
  assert.ok(Number.isSafeInteger(row.describeMs!) && Number.isSafeInteger(row.imageMs!));
  assert.equal(row.imageSteps, 8);
  assert.equal(row.namesStripped, 2, 'the names that got through the instruction were cut out of both fields');
  assert.equal(row.withoutLook, 0);
  assert.equal(f.rows.find(one => one.event === 'picture_sheet_written')!.sheetCharacters, 1);
  assert.doesNotMatch(JSON.stringify(f.rows), /Элин|Кодовая|СЕВЕР|hair|door|127\.0\.0\.1|safetensors/);
  // The job is not left on the card: its record is cleared, prompt and workflow with it.
  assert.deepEqual(comfy.seen.cleared, ['p1']);
});

test('a sample of a style is the last scene drawn once more: its frame and seed, another last sentence, and no model call', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  const calls = f.requests.length;
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();

  // The frame described for the scene's own picture is drawn again; only the style sentence differs, and the seed
  // is the story's, so the two pictures can be told apart by their style alone.
  assert.equal(f.requests.length, calls, 'the language model is not asked again');
  assert.equal(comfy.submitted.length, 2);
  const [own, sample] = comfy.submitted.map(promptOf);
  assert.ok(sample.endsWith(PRESETS.film));
  assert.equal(sample.slice(0, -PRESETS.film.length), own.slice(0, -STYLE_LINE.length));
  assert.equal(seedIn(comfy.submitted[1]), seedIn(comfy.submitted[0]));

  // It arrives as a photo of its own, with a caption and the way to choose the style, and its status line goes.
  const photo = photos(f.sent)[1];
  assert.equal(photo.payload.caption, 'Пример стиля: 🎬 Кинокадр');
  assert.equal(photo.payload.reply_parameters, undefined);
  assert.deepEqual(photo.payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), ['style:film', 'view:style']);
  const status = f.sent.find(one => one.method === 'sendMessage' && one.payload.text === '🎨 Рисую пример…')!;
  assert.ok(f.deleted.includes(f.sent.indexOf(status) + 1));
  // Asking for a sample chooses nothing.
  assert.equal(f.store.read('1').pictureStyle, undefined);

  const row = f.rows.find(one => one.event === 'picture_sample')!;
  assert.equal(row.outcome, 'ready');
  assert.equal(row.frameReused, true);
  assert.equal(row.describeMs, 0);
  assert.equal(row.pictureStyle, 'film');
  assert.equal(row.imageSteps, 8);
  assert.equal(row.actor, 'owner');
  assert.doesNotMatch(JSON.stringify(f.rows), /Элин|hair|door|Photorealistic|Synthetic test style/);
  assert.ok(comfy.seen.cleared.includes('p2'), 'the sample\'s job is off the card\'s history as well');

  // A style of the reader's own is drawn with the sentences the bot adds, and logged as custom, never by its words.
  await f.bot.handle(f.click('style-new'));
  await f.bot.handle(f.message('Уголь\nCharcoal sketch on rough paper'));
  const styleId = f.store.read('1').pictureStyle!;
  await f.bot.handle(f.click(`style-sample:${styleId}`));
  await f.bot.idle();
  assert.ok(promptOf(comfy.submitted[2]).endsWith('Charcoal sketch on rough paper. Adults with natural adult proportions and faces. No captions, logos or watermarks.'));
  assert.equal(photos(f.sent)[2].payload.caption, 'Пример стиля: ✍️ Уголь');
  assert.deepEqual(photos(f.sent)[2].payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), ['view:style']);
  assert.equal(f.rows.filter(one => one.event === 'picture_sample').at(-1)!.pictureStyle, 'custom');
  assert.doesNotMatch(JSON.stringify(f.rows), /Charcoal|Уголь/);
});

test('a sample after a restart describes the scene again, and one that fails says so once', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  await f.restart();
  await f.bot.handle(f.click('style-sample:watercolor'));
  await f.bot.idle();
  // The frame was kept in memory only: the scene is described again, from the sheet kept beside the story.
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'frame']);
  assert.ok(promptOf(comfy.submitted[1]).endsWith(PRESETS.watercolor));
  const row = f.rows.find(one => one.event === 'picture_sample')!;
  assert.equal(row.outcome, 'ready');
  assert.equal(row.frameReused, false);
  assert.ok(Number.isSafeInteger(row.describeMs!));

  // A card that cannot draw: the status line turns into one line saying so.
  const broken = fakeComfy({ failing: true });
  const brokenRoot = await broken.listen();
  t.after(() => broken.server.close());
  const g = fixture(t, { comfy: brokenRoot });
  await g.start();
  await g.bot.idle();
  await g.bot.handle(g.click('style-sample:film'));
  await g.bot.idle();
  assert.ok(g.sent.some(one => one.method === 'editMessageText' && one.payload.text === 'Не получилось нарисовать пример. Попробуй ещё раз чуть позже.'));
  const failed = g.rows.find(one => one.event === 'picture_sample')!;
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.frameReused, true, 'the frame was described; it is the card that failed, twice');
});

// On the real queue a picture's description runs only in the slot where its scene is cached. A sample asked for later
// cannot count on that slot: after a restart nobody holds it, and another reader's scene may have taken it since.
test('a sample whose scene is no longer cached in its reader\'s slot is described in the slot that is free', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1', '2'], scheduler: true });
  await f.start(1);
  await f.bot.idle();
  await f.start(2);
  await f.bot.idle();
  await f.restart();
  await f.bot.handle(f.click('style-sample:graphic', 1));
  await f.bot.idle();
  const row = f.rows.find(one => one.event === 'picture_sample')!;
  assert.equal(row.outcome, 'ready', String(row.code));
  assert.equal(row.frameReused, false);
  assert.equal(photos(f.sent).filter(one => one.payload.chat_id === 1 && one.payload.caption).length, 1);
  assert.ok(promptOf(comfy.submitted.at(-1)!).endsWith(PRESETS.graphic));
});

test('a sample is drawn only on request, one at a time, and a move in the story stops it', async t => {
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1'] });
  // Before any scene there is nothing to draw from.
  await f.bot.handle(f.click('style-sample:film'));
  assert.ok(told(f.sent, 'Пример рисуется по последней сцене. Начни историю, и после первой сцены его можно будет попросить.'));
  // A reader who is not drawn for is told so, and the card never hears of them.
  await f.bot.handle(f.click('style-sample:film', 2));
  assert.ok(told(f.sent, 'Картинки к твоим сценам пока не включены, поэтому пример нарисовать нельзя.'));

  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s own picture to reach the card');
  // Opening the picker and the cards draws nothing.
  await f.bot.handle(f.click('view:style'));
  await f.bot.handle(f.click('view:style:film'));
  assert.equal(comfy.submitted.length, 1);
  await f.bot.handle(f.click('style-sample:film'));
  await until(() => comfy.submitted.length === 2, 'the sample to reach the card');
  await f.bot.handle(f.click('style-sample:graphic'));
  assert.ok(told(f.sent, 'Уже рисую пример. Следующий можно попросить, когда он придёт.'));
  assert.equal(comfy.submitted.length, 2);

  await f.bot.handle(f.message('Осмотреться'));
  await until(() => f.rows.some(one => one.event === 'picture_sample'), 'the sample to stop');
  const row = f.rows.find(one => one.event === 'picture_sample')!;
  assert.equal(row.outcome, 'cancelled');
  assert.equal(row.code, 'cancelled');
  await f.bot.stop();
  assert.ok(!photos(f.sent).some(one => one.payload.caption), 'no sample of a scene the reader has moved past');
  const status = f.sent.find(one => one.method === 'sendMessage' && one.payload.text === '🎨 Рисую пример…')!;
  assert.ok(f.deleted.includes(f.sent.indexOf(status) + 1), 'its status line goes without a word');
  assert.ok(comfy.seen.cleared.includes('p2'));
});

test('the sheet is written once per story and reused by the next scene', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const state = f.store.read('1');
  const story = state.stories[state.active!.storyId];
  assert.deepEqual(story.sheet, SHEET.characters, 'the sheet is kept beside the story');

  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'scene', 'frame']);
  assert.equal(f.rows.filter(row => row.event === 'picture_sheet_written').length, 1);
  assert.equal(photos(f.sent).length, 2);
});

test('a card that cannot draw the frame replaces the status line with one line, and the story is untouched', async t => {
  const comfy = fakeComfy({ failing: true });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const state = f.store.read('1');
  const story = state.stories[state.active!.storyId];
  assert.equal(state.job, null);
  assert.equal(Object.keys(story.nodes).length, 1, 'the scene is saved');
  assert.equal(Object.values(story.nodes)[0].delivery, 'sent');
  assert.equal(photos(f.sent).length, 0);
  assert.deepEqual(f.deleted, [], 'the status line is not removed but rewritten');
  const edit = f.sent.find(one => one.method === 'editMessageText')!;
  assert.equal(edit.payload.message_id, f.sent.indexOf(statuses(f.sent)[0]) + 1);
  assert.match(edit.payload.text, /Иллюстрация не получилась/);
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.equal(row.outcome, 'failed');
  assert.equal(row.code, 'image_failed');
  assert.ok(Number.isSafeInteger(row.pictureSeconds!) && row.pictureSeconds! >= 0);
});

test('the reader\'s next message ends the picture of the scene they have read past', async t => {
  // A card that draws for longer than this reader's patience.
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the picture to reach the card');
  const status = f.sent.indexOf(statuses(f.sent)[0]) + 1;
  await f.bot.handle(f.message('Осмотреться'));
  // The second scene starts its own picture on the same slow card; stopping the bot ends that one the same way.
  await until(() => comfy.submitted.length === 2, 'the next scene\'s picture to reach the card');
  await f.bot.stop();

  assert.equal(photos(f.sent).length, 0, 'no picture of a scene the reader has read past');
  assert.ok(f.deleted.includes(status), 'the status line under the first scene goes without a word');
  assert.ok(comfy.seen.interrupts >= 1 && comfy.seen.queueDeletes >= 1, 'the card is told to stop drawing it');
  assert.ok(comfy.seen.cleared.includes('p1'), 'and the job it was drawing is off its history');
  const rows = f.rows.filter(one => one.event === 'picture');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.outcome, 'cancelled');
    assert.equal(row.code, 'cancelled');
    assert.equal(row.cancelled, true);
    assert.ok(Number.isSafeInteger(row.pictureSeconds!));
  }
  // The turn the reader asked for ran, and the second scene is theirs as usual.
  assert.equal(f.requests.filter(request => kindOf(request) === 'scene').length, 2);
  const state = f.store.read('1');
  assert.equal(Object.keys(state.stories[state.active!.storyId].nodes).length, 2);
});

// The bot prepares the next compaction while the reader reads (local/bot.ts `prepareNext`), on a turn of its own
// that takes the reader's slot and leaves it marked for nobody (local/scheduler.ts `start`). The description
// continues the scene cached in that slot and runs there or nowhere, so it has to go first.
test('the description keeps the reader\'s own slot, and the compaction prepared ahead follows it', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, scheduler: true, keepScenes: 1, compactAtTokens: 30000, usage: { inputTokens: 29000, outputTokens: 2000 } });
  await f.start();
  await f.bot.idle();
  // The second scene is the one that gives the preparation something to extract, and its picture is the one that
  // used to end as `skipped` every time, on a card that was free.
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.idle();

  const pictures = f.rows.filter(row => row.event === 'picture');
  assert.equal(pictures.length, 2);
  for (const row of pictures) assert.equal(row.outcome, 'ready');
  assert.equal(photos(f.sent).length, 2);
  assert.ok(f.rows.some(row => row.event === 'compaction_prepare_started'), 'the work ahead still runs');
  assert.ok(!f.rows.some(row => row.event === 'background_unavailable'), 'and it no longer takes the slot first');
});

// Pictures off, and the bot as it was: a reader who answers while the scene they asked for is still being
// delivered must not cancel the turn that wrote it. Its job lock is already clear, so their message starts a new
// turn beside it, and the old one still has a status message to close and the next compaction to start.
test('a message sent while the scene is on its way leaves the turn that wrote it alone', async t => {
  const f = fixture(t, { holdFinal: 1, compactAtTokens: 30000, usage: { inputTokens: 29000, outputTokens: 2000 } });
  await f.start();
  await until(() => f.sent.some(one => one.method === 'sendRichMessage'), 'the first scene to reach delivery');
  await f.bot.handle(f.message('Осмотреться'));
  f.release();
  await f.bot.idle();
  await f.bot.idle();
  assert.equal(f.rows.filter(row => row.event === 'scene_saved_and_sent').length, 2);
  assert.equal(f.rows.filter(row => row.event === 'compaction_prepare_started').length, 2,
    'each turn prepared the next compaction; neither was cancelled by the other');
});

test('a sheet the model answers with nothing still describes the frame, and the people keep their own look', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, sheetReply: { characters: [] } });
  await f.start();
  await f.bot.idle();
  const prompt = promptOf(comfy.submitted[0]);
  assert.ok(prompt.endsWith(STYLE), 'without a configured style line the measured one is used');
  // Nobody is on the sheet, so the described look is what the person is drawn from, with its number of years cut.
  assert.match(prompt, /a woman in red/);
  assert.doesNotMatch(prompt, /\d/);
  // And the name the frame carries is cut all the same: an empty sheet is no reason to send it (local/illustrate.ts).
  assert.doesNotMatch(prompt, /Элин/);
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.equal(row.namesStripped, 2);
  assert.equal(row.outcome, 'ready');
  assert.equal(row.withoutLook, 0);
});

// The scheduler gives the slot to somebody who is waiting for a scene, which is the order the plan asks for: this
// reader simply gets no picture for this one, and no apology either.
test('a description the model gave away to somebody waiting for a scene is not a failure', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, sheetError: 'background_preempted' });
  await f.start();
  await f.bot.idle();
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.equal(row.outcome, 'skipped');
  assert.equal(row.code, 'background_preempted');
  assert.equal(photos(f.sent).length, 0);
  assert.equal(comfy.submitted.length, 0, 'nothing reached the picture card');
  assert.deepEqual(f.deleted, [f.sent.indexOf(statuses(f.sent)[0]) + 1], 'the status line goes without a word');
  assert.ok(!f.sent.some(one => one.method === 'editMessageText'));
  // The scene is the reader's as usual.
  const state = f.store.read('1');
  assert.equal(Object.keys(state.stories[state.active!.storyId].nodes).length, 1);
});

// The two ends of the status line that can fail on their own: Telegram refusing to send it, and refusing to take
// it away again. Neither is worth a picture.
test('a status line that cannot be sent, and one that cannot be deleted, cost the reader nothing', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, refuseDelete: true });
  await f.start();
  await f.bot.idle();
  assert.equal(photos(f.sent).length, 1, 'the picture is drawn and sent');
  assert.equal(f.rows.find(one => one.event === 'picture')!.outcome, 'ready');

  // The card of the language model is paused: nothing is described, nothing is drawn, and the caller is still told
  // that the model is free, because it never took it (local/bot.ts `prepareNext` waits for that).
  const rows: Row[] = [];
  const sent: string[] = [];
  let told = 0;
  const chat = { send: async () => { sent.push('send'); throw Object.assign(new Error('forbidden'), { code: 403 }); },
    edit: async () => { sent.push('edit'); }, remove: async () => { sent.push('remove'); },
    photo: async () => { sent.push('photo'); } } as unknown as Parameters<NonNullable<typeof f.illustrator>['illustrate']>[0]['chat'];
  await f.illustrator!.illustrate({ userId: '1', chat, storyId: 'h1', nodeId: 'n1', branchId: 'b1',
    sceneMessageId: 5, sceneAt: Date.now(), signal: new AbortController().signal,
    log: (event, code, details) => rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }),
    hold: () => { throw Object.assign(new Error('gpu paused'), { code: 'gpu_paused' }); },
    afterDescribe: () => { told++; } });
  assert.deepEqual(sent, ['send'], 'no photo, and nothing to take away');
  assert.deepEqual(rows.map(row => row.event), ['picture_status_unsent', 'picture']);
  assert.equal(rows[1].code, 'gpu_not_ready');
  assert.equal(rows[1].outcome, 'skipped');
  assert.equal(told, 1);
});

// The graphs pinned on a card end in SaveImage, which writes the picture — with the prompt in its text chunks —
// into the directory ComfyUI never empties and the HTTP API cannot reach. A reader's scene is not left there.
test('a workflow that saves its picture is loaded as one that previews it', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, saveImage: true });
  await f.start();
  await f.bot.idle();
  assert.equal(photos(f.sent).length, 1, 'the picture is drawn and sent as before');
  const sink = comfy.submitted[0]['7'];
  assert.equal(sink.class_type, 'PreviewImage');
  // Wired to the same picture, with no prefix to write; the key beside it only makes the job's file its own (`drawOne`).
  assert.deepEqual(Object.keys(sink.inputs).sort(), ['images', 'nonce']);
  assert.deepEqual(sink.inputs.images, ['6', 0]);
  assert.equal(f.rows.find(row => row.event === 'picture')!.outcome, 'ready');
});

test('the picture configuration is off by default, loopback only, and never the language model\'s own card', () => {
  const allowed = new Set(['1', '2']);
  const on = {
    SIMPLE_CHAT_IMAGE_URL: 'http://127.0.0.1:8188', SIMPLE_CHAT_IMAGE_WORKFLOW: 'gpu/image-workflow-qwen.json',
    SIMPLE_CHAT_IMAGE_CHECKPOINT: 'qwen_image_2.1_int8_convrot.safetensors', SIMPLE_CHAT_IMAGE_USERS: '1',
  };
  assert.equal(imageConfig({}, '/nowhere', allowed, 'http://127.0.0.1:8080'), undefined);
  const config = imageConfig(on, '/nowhere', allowed, 'http://127.0.0.1:8080')!;
  assert.equal(config.url, 'http://127.0.0.1:8188');
  assert.equal(config.workflow, '/nowhere/gpu/image-workflow-qwen.json');
  assert.deepEqual([...config.users], ['1']);
  assert.equal(config.style, undefined);
  assert.equal(config.waitMs, 180000);
  // Nobody by default: the configuration may be there before anybody has agreed to be drawn.
  assert.deepEqual([...imageConfig({ ...on, SIMPLE_CHAT_IMAGE_USERS: '' }, '/nowhere', allowed, undefined)!.users], []);
  // A card of ours, reached through a tunnel, and not the one the language model already fills.
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_URL: 'https://comfy.example.com' }, '/nowhere', allowed, undefined), /loopback/);
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_URL: 'http://10.0.0.5:8188' }, '/nowhere', allowed, undefined), /loopback/);
  assert.throws(() => imageConfig(on, '/nowhere', allowed, 'http://127.0.0.1:8188'), /second card/);
  // One card, three spellings: the language model's own server is the same card however its address writes loopback.
  for (const own of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
    for (const pictures of ['http://127.0.0.1:8080', 'http://localhost:8080', 'http://[::1]:8080']) {
      assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_URL: pictures }, '/nowhere', allowed, own), /second card/);
    }
  }
  // A second port on the same computer is a second card: that is what the tunnel forwards.
  assert.ok(imageConfig({ ...on, SIMPLE_CHAT_IMAGE_URL: 'http://localhost:8188' }, '/nowhere', allowed, 'http://127.0.0.1:8080'));
  // A hosted model is not on this computer at all, and an address that is not one leaves the check with nothing to say.
  assert.ok(imageConfig(on, '/nowhere', allowed, 'https://api.example.com/v1'));
  assert.ok(imageConfig(on, '/nowhere', allowed, 'not a url'));
  // A reader who cannot use the bot at all cannot be drawn by it either, and a typo says so at startup.
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_USERS: '3' }, '/nowhere', allowed, undefined), /SIMPLE_CHAT_ALLOWED_USER_IDS/);
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_USERS: 'PRIVATE' }, '/nowhere', allowed, undefined),
    error => !/PRIVATE/.test((error as Error).message));
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_WORKFLOW: '' }, '/nowhere', allowed, undefined), /SIMPLE_CHAT_IMAGE_WORKFLOW/);
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_CHECKPOINT: '../../etc/passwd' }, '/nowhere', allowed, undefined), /SIMPLE_CHAT_IMAGE_CHECKPOINT/);
  assert.throws(() => imageConfig({ ...on, SIMPLE_CHAT_IMAGE_WAIT_SECONDS: '4' }, '/nowhere', allowed, undefined), /WAIT_SECONDS/);
});

test('a workflow that is not a ComfyUI API export stops the bot at startup, not at the first reader', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-picture-graph-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'story.sqlite'));
  t.after(() => store.close());
  const provider: Provider = { generate: async () => ({ text: '', finishReason: 'stop' }) as GenerationResult };
  const config = (file: string): ImageConfig => ({ url: 'http://127.0.0.1:8188', workflow: join(directory, file),
    checkpoint: 'synthetic.safetensors', style: undefined, users: new Set(['1']), waitMs: 5000, timeoutMs: 5000 });
  // What ComfyUI's Save menu writes, rather than what its Export (API) writes.
  writeFileSync(join(directory, 'ui.json'), JSON.stringify({ nodes: [], links: [] }));
  assert.throws(() => createIllustrator(config('ui.json'), { store, provider }), /API format/);
  // A graph whose sampler starts from a latent with no size would be drawn at one size and recorded at another.
  const graph = defaultWorkflow();
  delete (graph['4'] as { inputs: Record<string, unknown> }).inputs.width;
  writeFileSync(join(directory, 'sizeless.json'), JSON.stringify(graph));
  assert.throws(() => createIllustrator(config('sizeless.json'), { store, provider }), /width and a height/);
  // A file that is not there, and one that is not JSON: both used to reach the startup row as a failure with no
  // code at all, because ENOENT is upper case and a SyntaxError carries none.
  writeFileSync(join(directory, 'broken.json'), '{ "1": ');
  for (const file of ['missing.json', 'broken.json']) {
    assert.throws(() => createIllustrator(config(file), { store, provider }),
      (error: Error & { code?: string }) => error.code === 'workflow_unreadable' && /SIMPLE_CHAT_IMAGE_WORKFLOW/.test(error.message));
  }
});
