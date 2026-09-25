// The picture under a scene, end to end: the bot, a fake Telegram, a fake story model and a fake ComfyUI on
// loopback. No card, no network, no reader's story — the scenes here are the synthetic ones the bot tests use.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { createBot } from './bot.ts';
import type { Update } from './bot.ts';
import { imageConfig } from './config.ts';
import { createScheduler } from './scheduler.ts';
import type { ImageConfig } from './config.ts';
import { defaultWorkflow, latentSizeOf } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { STYLE } from './illustrate.ts';
import type { Description } from './illustrate.ts';
import { createLlama } from './llama.ts';
import type { ErrorDetails } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { createServing, readerScope } from './serving.ts';
import { PORTRAIT_CLOTHES, PORTRAIT_STYLE } from './image-portraits.ts';
import { clothesOf, createIllustrator, encoderTokens, foldedPrompt, personTag, rewrittenSheet, textTokens, wornAt } from './picture.ts';
import { PRESETS, PROMPT_CHARS } from './picture-style.ts';
import type { GpuController } from './gpu.ts';
import { Store } from './store.ts';
import type { TelegramPayload } from './telegram.ts';
import { REGISTERED, texts } from './text.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { addSeed, newStory } from '../lib/library.ts';
import type { SeedDraft, Story } from '../lib/library.ts';

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
  // `interrupted`: the job each interrupt named.
  const seen = { interrupted: [] as unknown[], queueDeletes: 0, cleared: [] as string[] };
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
        // ComfyUI draws one job at a time and interrupts that one, and only while it is the job the interrupt names;
        // an interrupted prompt lands in the history too, so that the delete below has a record to remove.
        const named = (await body().catch(() => ({})) as { prompt_id?: unknown }).prompt_id;
        seen.interrupted.push(named);
        const running = [...finishAt.keys()][0];
        if (running !== undefined && (named === undefined || named === running)) { finishAt.delete(running); done.add(running); }
        return json({});
      }
      // As ComfyUI deletes: a job still waiting leaves the queue, and the one it draws stays (the stop's confirmation
      // reads the queue after it).
      if (request.method === 'POST' && url.pathname === '/queue') {
        seen.queueDeletes++;
        const running = [...finishAt.keys()][0];
        for (const id of ((await body().catch(() => ({}))) as { delete?: unknown }).delete as string[] ?? []) if (id !== running) finishAt.delete(id);
        return json({});
      }
      // The card draws one job and queues the rest, and says which is which (local/image-batch.ts `stopJob`).
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
    // Ends every job on the card at once: a slow card, done at last.
    finish: () => { for (const id of finishAt.keys()) finishAt.set(id, 0); },
    listen: () => new Promise<string>(ready => server.listen(0, '127.0.0.1', () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

// What the describing model answers. The sheet writes an age as a number and the frame carries a name in two
// fields the instruction forbids them in: both are what the assembly has to take out (local/illustrate.ts).
const SHEET = { characters: [{ name: 'Элин', look: 'A middle-aged woman, 48-year-old, lean, short ash-grey hair', outfit: 'wearing a grey wool coat' }] };
// Элин as the characters' buttons name her: her story, her place on the sheet and the hash of her name.
const elin = (storyId: string) => `${storyId}:0:${personTag('Элин')}`;
// A kept portrait of some look, as a sheet refers to it.
const keptOf = (look: string, file = `${'0'.repeat(32)}.png`) => ({ file, look, clothes: PORTRAIT_CLOTHES, style: PORTRAIT_STYLE, at: 1,
  seed: 1, graph: '0123456789abcdef', checkpoint: 'synthetic.safetensors', width: 720, height: 1280, steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' });
const FRAME = {
  moment: 'Элин stands with her back against the closed door', shot: 'Medium wide three-quarter shot',
  setting: 'A narrow stone passage, the door closed', objects: 'A splint of two boards beside Элина сумка',
  props: 'The grey-clad woman holds the only dagger in her right hand', light: 'Overcast morning light',
  people: [{ who: 'Элин', look: 'a 30 years old woman in red', clothes: 'wearing a grey wool coat', state: 'her bandaged left forearm folded against her chest',
    action: 'leans her back against the door' }],
};
const STYLE_LINE = 'Synthetic test style line, one sentence and no more.';
const seedText = 'Маяк\n2026-08-02 20:00\nСмотритель встречает лодку. Кодовая фраза: СЕВЕР.';
type Row = { event: string; code?: string | number } & ErrorDetails;
type Payload = { chat_id: number; message_id: number; message_ids?: number[]; text: string; rich_message: { markdown?: string; html?: string }; photo: Uint8Array;
  reply_parameters?: { message_id: number }; caption?: string; reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } };
type Sent = { method: string; payload: Payload };
// Which of the three calls a request is: a scene streams and has no schema, the other two are told apart by the
// field their schema asks for.
const kindOf = (request: ModelRequest) => {
  const properties = (request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !properties ? 'scene' : 'characters' in properties ? 'sheet' : 'frame';
};

// llama-server as the bot's provider meets it (local/llama.ts): the count endpoint, and a stream whose usage repeats
// the count. A scene costs what `scene` says; a description repeats that scene and adds its instruction. Every count
// asked for is noted in `counted` by the kind of request it was for.
function fakeLlama(scene: { inputTokens: number; outputTokens: number }, counted: string[]) {
  return createLlama({ baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536 }, { fetch: async (url, init) => {
    const body = JSON.parse(init.body as string) as { response_format?: { schema: object } };
    const kind = kindOf({ system: '', messages: [], maxOutputTokens: 1, outputSchema: body.response_format?.schema });
    const promptTokens = kind === 'scene' ? scene.inputTokens : scene.inputTokens + scene.outputTokens + (kind === 'sheet' ? 200 : 1200);
    if (new URL(url).pathname.endsWith('/input_tokens')) {
      counted.push(kind);
      return new Response(JSON.stringify({ input_tokens: promptTokens }), { headers: { 'content-type': 'application/json' } });
    }
    const text = kind === 'scene' ? '2026-08-02 20:00\n\nСинтетическая сцена.' : JSON.stringify(kind === 'sheet' ? SHEET : FRAME);
    const events = [{ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: kind === 'scene' ? scene.outputTokens : 50 } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
}

// simple-serving as the bot's provider meets it (local/serving.ts): a gateway that notes whose each request is, its class
// and cache scope, beside the kind of work it is. A count and its generation agree, as the contract has them.
type Heard = { kind: string; class: string | null; scope: string | null };
function fakeServing(scene: { inputTokens: number; outputTokens: number }, heard: Heard[]) {
  return createServing({ baseUrl: 'http://127.0.0.1:8080', model: 'test-model', contextTokens: 65536, apiKey: 'synthetic-key' }, { fetch: async (url, init) => {
    // A ready service, for the check the adapter makes before its first call.
    if (url.endsWith('/v1/state')) return Response.json({ contract: '2', status: 'ready', model: 'test-model', context_tokens: 65536 });
    if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'test-model', max_model_len: 65536 }] });
    const body = JSON.parse(init.body as string) as { response_format?: { json_schema: { schema: { properties: Record<string, unknown> } } } };
    const properties = body.response_format?.json_schema.schema.properties;
    const kind = !properties ? 'scene' : 'facts' in properties ? 'compaction' : 'characters' in properties ? 'sheet' : 'frame';
    const promptTokens = kind === 'scene' ? scene.inputTokens : kind === 'compaction' ? 5000
      : scene.inputTokens + scene.outputTokens + (kind === 'sheet' ? 200 : 1200);
    const headers = new Headers(init.headers);
    const count = new URL(url).pathname.endsWith('/input_tokens');
    heard.push({ kind: count ? `count ${kind}` : kind, class: headers.get('x-simple-serving-class'), scope: headers.get('x-simple-serving-scope') });
    if (count) return new Response(JSON.stringify({ input_tokens: promptTokens }), { headers: { 'content-type': 'application/json' } });
    // A compaction's answer is not a memory and is dropped by its check: all this needs from it is that it was asked.
    const text = kind === 'scene' ? '2026-08-02 20:00\n\nСинтетическая сцена.' : JSON.stringify(kind === 'sheet' ? SHEET : kind === 'frame' ? FRAME : { facts: [] });
    const events = [{ model: 'test-model', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] },
      { model: 'test-model', choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: kind === 'scene' ? scene.outputTokens : 50 } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
}

type Options = {
  comfy?: string; users?: string[]; style?: string; offsetMs?: number; sheetReply?: object;
  // What the model describes each frame as, in turn; the last one answers every frame after it.
  frameReplies?: object[];
  // How many scene deliveries to hold, so that a test can send the next message while one is still in flight;
  // `scheduler` puts the real queue between the bot and the model, which is where a picture takes its slot;
  // `compactAtTokens` and `keepScenes` are what makes the bot prepare the next compaction while the reader reads.
  holdFinal?: number; scheduler?: boolean; compactAtTokens?: number; keepScenes?: number;
  // How many photos to hold on their way, so that a test can delete their scene while Telegram has them.
  holdPhotos?: number;
  // A workflow pinned on a card the way the ones in gpu/ are: it ends in SaveImage.
  saveImage?: boolean;
  // A model that refuses the sheet with this code, and a Telegram that will not delete a message or send the prompt
  // under a photo.
  sheetError?: string; refuseDelete?: boolean; refuseNote?: boolean;
  // The picture model's tokenizer, as the note under a photo counts with it, and as the characters' card counts one text.
  promptTokens?: (prompt: string) => number;
  textTokens?: (text: string) => number;
  // What the model says the scene cost. Above `compactAtTokens` the bot prepares the next compaction while the
  // reader reads; the numbers are the model's own and say nothing about the size of these synthetic scenes.
  usage?: { inputTokens: number; outputTokens: number };
  // The real simple-serving provider in front of `fakeServing`, whose usage is `usage` as the fake model's is.
  serving?: boolean;
  // The real llama.cpp provider in front of `fakeLlama`, with what the server counts for the scene; `illustratorModel`
  // names the story model to the illustrator otherwise than the scenes' stamps do.
  llama?: { inputTokens: number; outputTokens: number; illustratorModel?: string };
  // The language model's card as the bot holds it for a scene.
  gpu?: GpuController;
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
  let heldFinals = 0, heldPhotos = 0;
  const api = async (method: string, fields?: TelegramPayload) => {
    const payload = fields as Payload;
    if (method === 'deleteMessage') {
      deleted.push(payload.message_id);
      // Telegram refuses to delete a message that is gone, too old, or was never the bot's.
      if (options.refuseDelete) throw Object.assign(new Error('message to delete not found'), { code: 400 });
    }
    sent.push({ method, payload });
    const id = sent.length;
    if (isNote({ method, payload }) && options.refuseNote) throw Object.assign(new Error('can\'t parse the rich message'), { code: 400 });
    // A scene that is still being delivered: the story is already committed and its job lock clear, so the reader
    // can answer here, which is the moment the bot has to get right.
    if (method === 'sendRichMessage' && !isNote({ method, payload }) && heldFinals++ < (options.holdFinal ?? 0)) await new Promise<void>(go => holding.push(go));
    if (method === 'sendPhoto' && heldPhotos++ < (options.holdPhotos ?? 0)) await new Promise<void>(go => holding.push(go));
    return { message_id: id };
  };
  const counted: string[] = [];
  let frames = 0;
  const fake: Provider = { async generate(request, controls?: GenerateControls) {
    requests.push(request);
    const kind = kindOf(request);
    if (kind === 'sheet' && options.sheetError) throw Object.assign(new Error(options.sheetError), { code: options.sheetError });
    if (kind === 'sheet') return { text: JSON.stringify(options.sheetReply ?? SHEET), finishReason: 'stop' };
    if (kind === 'frame') {
      const replies = options.frameReplies ?? [FRAME];
      return { text: JSON.stringify(replies[Math.min(frames++, replies.length - 1)]), finishReason: 'stop' };
    }
    // A compaction prepared ahead asks with no stream and no schema; its answer is not a memory and is dropped by
    // the check, which is all this test needs from it — that it took the model's slot on the way.
    await controls?.onText?.('2026-08-02 20:00\n\n');
    return { text: `2026-08-02 20:00\n\nСинтетическая сцена ${requests.length}.`, finishReason: 'stop',
      usage: { ...(options.usage ?? { inputTokens: 100, outputTokens: 50 }),
        totalTokens: (options.usage?.inputTokens ?? 100) + (options.usage?.outputTokens ?? 50) } };
  } };
  const llama = options.llama && fakeLlama(options.llama, counted);
  const heard: Heard[] = [];
  const serving = options.serving ? fakeServing(options.usage ?? { inputTokens: 100, outputTokens: 50 }, heard) : undefined;
  const real = llama || serving;
  const model: Provider = real ? { ...real, generate: (request, controls) => { requests.push(request); return real.generate(request, controls); } } : fake;
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
    const illustrator = images && createIllustrator(images, { store, provider, pollMs: 2, now: () => Date.now() + (options.offsetMs ?? 0),
      model: { model: options.llama?.illustratorModel ?? 'test-model', provider: 'claude-code', contextTokens: 65536 },
      promptTokens: () => options.promptTokens, textTokens: () => options.textTokens });
    const bot = createBot({ store, api, provider, gpu: options.gpu, illustrator, allowedUsers: new Set(['1', '2']), maxOutputTokens: 4096,
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
    store, sent, rows, requests, counted, heard, deleted, provider, message, click, start, release, workflow, directory, images };
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
// The prompt folded under a photo is a rich message like a scene, and the only one written in HTML.
const isNote = (one: Sent) => one.method === 'sendRichMessage' && typeof one.payload.rich_message?.html === 'string';
const htmlOf = (one: Sent) => one.payload.rich_message.html!;
const notes = (sent: Sent[]) => sent.filter(isNote);
const idOf = (sent: Sent[], one: Sent) => sent.indexOf(one) + 1;
// The data of the button under a photo's prompt, as the reader presses it.
const editOf = (note: Sent) => note.payload.reply_markup!.inline_keyboard[0][0].callback_data;

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
  const f = fixture(t, { comfy: root, style: STYLE_LINE, offsetMs: 3000 });
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
  assert.match(prompt, /short ash-grey hair, wearing a grey wool coat, her bandaged/, 'the sheet line is the appearance of a person it covers, the frame\'s clothes after it');
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
  // Three seconds on the bot's clock, plus the real time of the fakes and of the library's writes, which is tens of
  // milliseconds and which a loaded machine can stretch several times over: rounded, that is still 3, where a
  // ceiling would make it 4.
  assert.equal(row.pictureSeconds, 3, 'the seconds from the end of the scene to the photo, rounded');
  assert.ok(Number.isSafeInteger(row.pictureAfterSceneMs!) && row.pictureAfterSceneMs! >= 3000);
  assert.ok(Number.isSafeInteger(row.describeMs!) && Number.isSafeInteger(row.imageMs!));
  // The photo's own leg: the upload's time, and the size of what was uploaded, the stripped picture.
  assert.ok(Number.isSafeInteger(row.photoMs!) && row.photoMs! >= 0);
  assert.equal(row.photoBytes, bytes.length);
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

  // A style of the reader's own ends the prompt as written, and is logged as custom, never by its words.
  await f.bot.handle(f.click('style-new'));
  await f.bot.handle(f.message('Уголь\nCharcoal sketch on rough paper'));
  const styleId = f.store.read('1').pictureStyle!;
  await f.bot.handle(f.click(`style-sample:${styleId}`));
  await f.bot.idle();
  assert.ok(promptOf(comfy.submitted[2]).endsWith('. Charcoal sketch on rough paper'));
  assert.equal(photos(f.sent)[2].payload.caption, 'Пример стиля: ✍️ Уголь');
  assert.deepEqual(photos(f.sent)[2].payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), ['view:style']);
  assert.equal(f.rows.filter(one => one.event === 'picture_sample').at(-1)!.pictureStyle, 'custom');
  assert.doesNotMatch(JSON.stringify(f.rows), /Charcoal|Уголь/);
});

// The count under a picture, with the real vocabulary when `npm run tokenizers` has written it: the prompt and the
// tokens of each encoder's template that stay, and six more for each reference picture of the edit graph.
test('the tokens under a picture are what the pinned graph\'s encoder conditions on', { skip: !existsSync(resolve('tokenizers/qwen-2.5.json.gz'))
  && 'no tokenizers/qwen-2.5.json.gz; npm run tokenizers writes it' }, () => {
  const qwen = loadTokenizers(resolve('tokenizers')).qwen()!;
  const counter = (file: string) => encoderTokens(qwen, JSON.parse(readFileSync(resolve(file), 'utf8')))!;
  const prompt = 'A lighthouse keeper reads by the lamp. Oil painting, warm candlelight';
  const own = qwenPromptTokens(qwen, prompt, 'qwen_image').prompt;
  assert.equal(counter('gpu/image-workflow-qwen.json')(prompt), own + 8);
  assert.equal(counter('gpu/image-workflow.json')(prompt), own + 5);
  assert.equal(counter('gpu/image-workflow-qwen-edit.json')(prompt), own + 8 + 6 * 6);
  assert.equal(encoderTokens(qwen, defaultWorkflow()), undefined);
  // A text of a characters' card is counted alone: no template and no picture, whatever the graph.
  for (const file of ['gpu/image-workflow-qwen.json', 'gpu/image-workflow.json', 'gpu/image-workflow-qwen-edit.json']) {
    assert.equal(textTokens(qwen, JSON.parse(readFileSync(resolve(file), 'utf8')))!(prompt), own, file);
  }
  assert.equal(textTokens(qwen, defaultWorkflow()), undefined);
});

// The prompt under a photo, for the reader to read, copy and tune a style line against
// (docs/telegram-ui.md#picture-prompts).
test('the prompt of every photo is folded under it, with its size in characters and in the picture model\'s tokens', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  // A tokenizer of whole words, so that what the note says can be counted by hand.
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const f = fixture(t, { comfy: root, style: STYLE_LINE, promptTokens: words });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();

  // One note under each photo, the scene's own and the sample's: the very prompt the card drew, in a fenced block
  // inside a fold, whose one line gives the prompt's tokens, the style line's share of them, and its characters.
  const [own, sample] = comfy.submitted.map(promptOf);
  assert.equal(notes(f.sent).length, 2);
  for (const [at, prompt, line] of [[0, own, STYLE_LINE], [1, sample, PRESETS.film]] as const) {
    const note = notes(f.sent)[at];
    const photo = photos(f.sent)[at];
    assert.equal(note.payload.reply_parameters?.message_id, idOf(f.sent, photo), 'the note hangs under its own photo');
    assert.ok(idOf(f.sent, note) > idOf(f.sent, photo), 'and follows it');
    const summary = htmlOf(note).match(/^<details><summary>(.*)<\/summary>/)![1];
    assert.equal(htmlOf(note), foldedPrompt(summary, prompt));
    assert.match(summary, /^🖼 Промпт: \d+ токен\S*, из них стиль \d+ · [\d ]+ знак\S*$/u);
    assert.deepEqual(summary.match(/\d[\d ]*/g)!.map(number => Number(number.replace(/ /g, ''))),
      [words(prompt), words(line), [...prompt].length]);
  }
  // The status line is the only message the picture takes out of the chat.
  assert.deepEqual(f.deleted.length, 2);

  // The rows carry the same three counts, and not a word of the prompt.
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([row.outcome, row.promptCharacters, row.pictureTokens, row.styleTokens], ['ready', [...own].length, words(own), words(STYLE_LINE)]);
  const sampled = f.rows.find(one => one.event === 'picture_sample')!;
  assert.deepEqual([sampled.promptCharacters, sampled.pictureTokens, sampled.styleTokens], [[...sample].length, words(sample), words(PRESETS.film)]);
  assert.ok(!f.rows.some(one => one.event === 'picture_prompt_unsent'));
  assert.doesNotMatch(JSON.stringify(f.rows), /hair|door|Synthetic test style/);
});

test('without the picture model\'s tokenizer, or with one that fails, the note gives characters alone, and a note Telegram refuses costs only the note', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  const prompt = promptOf(comfy.submitted[0]);
  const html = htmlOf(notes(f.sent)[0]);
  assert.ok(html.startsWith(`<details><summary>🖼 Промпт: ${String([...prompt].length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} знак`));
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.equal(row.promptCharacters, [...prompt].length);
  assert.ok(!('pictureTokens' in row) && !('styleTokens' in row));

  // A tokenizer that throws is the same as none.
  const broken = fixture(t, { comfy: root, style: STYLE_LINE, promptTokens: () => { throw new Error('vocabulary'); } });
  await broken.start();
  await broken.bot.idle();
  const kept = broken.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([kept.outcome, kept.promptCharacters, 'pictureTokens' in kept], ['ready', [...prompt].length, false]);
  assert.match(htmlOf(notes(broken.sent)[0]), /^<details><summary>🖼 Промпт: [\d ]+ знак/u);

  const g = fixture(t, { comfy: root, style: STYLE_LINE, refuseNote: true });
  await g.start();
  await g.bot.idle();
  assert.equal(photos(g.sent).length, 1, 'the photo is there');
  assert.equal(notes(g.sent).length, 1, 'its note was tried once');
  assert.deepEqual(g.store.read('1').sentPictures!.map(picture => picture.messageId), [idOf(g.sent, photos(g.sent)[0])]);
  assert.deepEqual(g.rows.filter(one => one.event === 'picture_prompt_unsent').map(one => one.code), [400]);
  assert.equal(g.rows.find(one => one.event === 'picture')!.outcome, 'ready');
  assert.ok(!g.sent.some(one => one.method === 'editMessageText'), 'and the reader is told nothing about it');
});

test('a folded prompt is plain text a phone wraps, and nothing in it is read as a tag', () => {
  assert.equal(foldedPrompt('S', 'A quiet harbour. Painterly.'), '<details><summary>S</summary>A quiet harbour. Painterly.</details>');
  const folded = foldedPrompt('S & T', 'A sign reads </details> <summary>x</summary> & ```code```. Done.');
  assert.equal(folded, '<details><summary>S &amp; T</summary>A sign reads &lt;/details&gt; &lt;summary&gt;x&lt;/summary&gt; &amp; ```code```. Done.</details>');
  assert.equal(folded.match(/<\/details>/g)!.length, 1, 'only the fold itself closes');
});

// A rich message holds 32768 characters (docs/telegram-ui.md#telegram-limits). Counted here in UTF-8 bytes, which are
// never fewer.
test('the longest prompt a reader may write fits its note, every character escaped, under the summary of any language', () => {
  for (const lang of REGISTERED) {
    const summary = texts(lang).notices.promptSummary(PROMPT_CHARS, 999_999, null);
    for (const prompt of ['&'.repeat(PROMPT_CHARS), '𝔄'.repeat(PROMPT_CHARS)]) {
      assert.ok(Buffer.byteLength(foldedPrompt(summary, prompt), 'utf8') <= 32768, lang);
    }
  }
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

test('all styles at once: one frame, every style of the picker in its order, each photo with its own caption', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  // The bot's own line is not a preset here, so the picker, and the batch, start with it.
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  const calls = f.requests.length;
  await f.bot.handle(f.click('style-samples'));
  await f.bot.idle();

  assert.equal(f.requests.length, calls, 'the frame of the scene\'s own picture is drawn again, without the model');
  const lines = [STYLE_LINE, PRESETS.semi, PRESETS.novel, PRESETS.film, PRESETS.graphic, PRESETS.watercolor];
  assert.equal(comfy.submitted.length, 1 + lines.length);
  const [own, ...samples] = comfy.submitted.map(promptOf);
  samples.forEach((prompt, index) => {
    assert.ok(prompt.endsWith(lines[index]), `style ${index} in the picker's order`);
    assert.equal(prompt.slice(0, -lines[index].length), own.slice(0, -STYLE_LINE.length), 'the same frame every time');
  });
  assert.ok(comfy.submitted.every(graph => seedIn(graph) === seedIn(comfy.submitted[0])), 'and the story\'s one seed');

  // One photo per style, sent as it is drawn, each with its caption and the way to choose it; one status line for all.
  const captions = photos(f.sent).slice(1).map(photo => photo.payload.caption);
  assert.deepEqual(captions, ['⚙️ Стандартный', '🖌 Полуреализм', '📖 Визуальная новелла', '🎬 Кинокадр', '🖋 Графический роман', '💧 Акварель']
    .map(name => `Пример стиля: ${name}`));
  assert.deepEqual(photos(f.sent)[2].payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), ['style:semi', 'view:style']);
  const statuses = f.sent.filter(one => one.method === 'sendMessage' && /во всех стилях/.test(one.payload.text ?? ''));
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].payload.text!, /во всех стилях \(6\)/);
  assert.ok(f.deleted.includes(f.sent.indexOf(statuses[0]) + 1), 'the status line goes once the last one is there');
  assert.equal(f.store.read('1').pictureStyle, undefined, 'drawing every style chooses none of them');

  const rows = f.rows.filter(one => one.event === 'picture_sample');
  assert.deepEqual(rows.map(row => row.pictureStyle), ['standard', 'semi', 'novel', 'film', 'graphic', 'watercolor']);
  assert.ok(rows.every(row => row.outcome === 'ready' && row.stylesAsked === 6 && row.frameReused === true && row.describeMs === 0));
  assert.doesNotMatch(JSON.stringify(f.rows), /Элин|hair|Photorealistic|Watercolor|Synthetic test style/);
  assert.ok(['p2', 'p3', 'p4', 'p5', 'p6', 'p7'].every(id => comfy.seen.cleared.includes(id)), 'no job is left on the card');
});

test('all styles stop at the reader\'s next move, and at the first style the card cannot draw', async t => {
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1'] });
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s own picture to reach the card');
  await f.bot.handle(f.click('style-samples'));
  await until(() => comfy.submitted.length === 2, 'the first style to reach the card');
  await f.bot.handle(f.click('style-sample:film'));
  assert.ok(told(f.sent, 'Уже рисую пример. Следующий можно попросить, когда он придёт.'));
  await f.bot.handle(f.message('Осмотреться'));
  await until(() => f.rows.some(one => one.event === 'picture_sample'), 'the styles to stop');
  await f.bot.stop();
  const rows = f.rows.filter(one => one.event === 'picture_sample');
  assert.deepEqual(rows.map(row => [row.outcome, row.pictureStyle, row.stylesAsked]), [['cancelled', 'semi', 5]]);
  // The scenes' own pictures end with the standard line, which is the novel preset here; the batch began with semi.
  assert.equal(comfy.submitted.filter(graph => promptOf(graph).endsWith(PRESETS.semi)).length, 1);
  assert.ok(!comfy.submitted.some(graph => [PRESETS.film, PRESETS.graphic, PRESETS.watercolor].some(line => promptOf(graph).endsWith(line))),
    'no style after the one being drawn reaches the card');
  assert.ok(!photos(f.sent).some(one => one.payload.caption), 'no sample of a scene the reader has moved past');

  // A card that fails: the first style says so once, and the rest are not tried.
  const broken = fakeComfy({ failing: true });
  const brokenRoot = await broken.listen();
  t.after(() => broken.server.close());
  const g = fixture(t, { comfy: brokenRoot });
  await g.start();
  await g.bot.idle();
  const before = broken.submitted.length;
  await g.bot.handle(g.click('style-samples'));
  await g.bot.idle();
  assert.equal(broken.submitted.length, before + 1);
  assert.equal(g.sent.filter(one => one.method === 'editMessageText' && one.payload.text === 'Не получилось нарисовать пример. Попробуй ещё раз чуть позже.').length, 1);
  assert.deepEqual(g.rows.filter(one => one.event === 'picture_sample').map(row => [row.outcome, row.pictureStyle]), [['failed', 'semi']]);
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

// The seed dressed a person once; the story changed their clothes later, and a sheet that kept clothes never let the
// pictures follow (2026-09-24). Each frame now starts from what the picture before it showed and says what changed.
test('a change of clothes reaches the next picture, and the picture after it starts from the new clothes', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const dress = { ...FRAME, people: [{ ...FRAME.people[0], clothes: 'wearing a red silk dress' }] };
  const f = fixture(t, { comfy: root, frameReplies: [FRAME, dress] });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.message('Переодеться'));
  await f.bot.idle();
  await f.bot.handle(f.message('Выйти на улицу'));
  await f.bot.idle();
  const frames = f.requests.filter(request => kindOf(request) === 'frame').map(request => request.messages.at(-1)!.content);
  assert.equal(frames.length, 3);
  assert.match(frames[0], /- Элин: wearing a grey wool coat\n/, 'the first frame starts from the sheet');
  assert.match(frames[1], /- Элин: wearing a grey wool coat\n/, 'the second from the first picture');
  assert.match(frames[2], /- Элин: wearing a red silk dress\n/, 'the third from the second picture, where the story changed them');
  const prompts = comfy.submitted.map(promptOf);
  assert.match(prompts[1], /short ash-grey hair, wearing a red silk dress, her bandaged/);
  assert.doesNotMatch(prompts[1], /grey wool coat/);
  assert.deepEqual(f.rows.filter(row => row.event === 'picture').map(row => row.clothesChanged), [0, 1, 0]);
  const state = f.store.read('1');
  const story = state.stories[state.active!.storyId];
  assert.deepEqual(Object.values(story.nodes).map(node => node.clothes?.['Элин']),
    ['wearing a grey wool coat', 'wearing a red silk dress', 'wearing a red silk dress']);
});

// A sheet written before clothes left it has them in its appearance lines and no `outfit`: used as it is, it would
// dress a person twice. It is written once more from the history as it stands, and then kept like any other.
test('a sheet from before clothes left it is written again once', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  f.store.mutate('1', state => {
    state.stories[state.active!.storyId].sheet = [{ name: 'Элин', look: 'A middle-aged woman, short ash-grey hair, grey wool coat' }];
  });
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.handle(f.message('Подождать'));
  await f.bot.idle();
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'scene', 'sheet', 'frame', 'scene', 'frame']);
  assert.deepEqual(f.rows.filter(row => row.event === 'picture_sheet_written').map(row => row.sheetRewritten), [false, true]);
  const state = f.store.read('1');
  assert.deepEqual(state.stories[state.active!.storyId].sheet, [{ ...SHEET.characters[0] }]);
  assert.equal(photos(f.sent).length, 3);
});

// A look the reader wrote is theirs: that rewrite keeps it under its name, and keeps the person even when the new sheet
// does not name them. Only what the reader did not write is taken from the new sheet. A person is their name, apart
// from spaces and case, and nothing else: one the model renames is somebody new, and what the reader made of the old
// name stays beside them, under it. Two people are never merged by a like name.
test('the rewrite of an old sheet keeps the looks the reader wrote and the portraits they kept, under the names they had', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  f.store.mutate('1', state => {
    state.stories[state.active!.storyId].sheet = [{ name: 'Элин', look: 'A tall woman with a long braid', edited: true },
      { name: 'Тарек', look: 'A young man with curly hair', edited: true }, { name: 'Ора', look: 'An old woman in a grey coat' }];
  });
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  const state = f.store.read('1');
  assert.deepEqual(state.stories[state.active!.storyId].sheet, [{ ...SHEET.characters[0], look: 'A tall woman with a long braid', edited: true },
    { name: 'Тарек', look: 'A young man with curly hair', outfit: '', edited: true }]);
  assert.match(promptOf(comfy.submitted[1]), /A tall woman with a long braid, wearing a grey wool coat/);
  assert.deepEqual(rewrittenSheet([{ name: ' элин ', look: 'Mine', edited: true }], SHEET.characters),
    [{ ...SHEET.characters[0], look: 'Mine', edited: true }], 'a name is matched as a reader would, apart from spaces and case');
  const portrait = keptOf('An old look');
  assert.deepEqual(rewrittenSheet([{ name: 'Элин', look: 'An old look', portrait }, { name: 'Ора', look: 'An old woman', portrait }], SHEET.characters),
    [{ ...SHEET.characters[0], portrait }, { name: 'Ора', look: 'An old woman', outfit: '', portrait }], 'a kept portrait stays, and so does its person');
  const renamed = { name: 'Элин Вос', look: 'A lean woman, grey hair', outfit: 'wearing a grey wool coat' };
  assert.deepEqual(rewrittenSheet([{ name: 'Элин', look: 'Mine', edited: true, portrait }], [renamed]),
    [renamed, { name: 'Элин', look: 'Mine', outfit: '', edited: true, portrait }], 'a person renamed is somebody new');
  // So are the buttons: they name her by the hash of the name she has.
  assert.equal(personTag(' ЭЛИН '), personTag('Элин'));
  assert.notEqual(personTag('Элин Вос'), personTag('Элин'));
});

// The frame kept for samples was described with the looks of that moment; one the reader edited since, or while it was
// being described, is described again, and the sample draws the look as it is now.
test('a sample after a look is edited describes the scene again, and the card counts each text with the picture model\'s tokenizer', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const words = (text: string) => text.split(' ').length;
  const f = fixture(t, { comfy: root, textTokens: words });
  await f.start();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  await f.bot.handle(f.click(`view:character:${elin(storyId)}`));
  assert.match(f.sent.at(-1)!.payload.text, /\nТекст внешности: 8 токенов · 59 знаков\n/);
  assert.match(f.sent.at(-1)!.payload.text, /\nТекст одежды: 5 токенов · 24 знака\n/);
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.message('A tall woman with a long braid'));
  assert.equal(comfy.submitted.length, 1, 'an edit draws nothing');
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'frame']);
  assert.match(promptOf(comfy.submitted[1]), /A tall woman with a long braid, wearing a grey wool coat/);
  assert.doesNotMatch(promptOf(comfy.submitted[1]), /ash-grey/);
  assert.equal(f.rows.find(one => one.event === 'picture_sample')!.frameReused, false);
  // The frame described now has the look as it is, and serves the next sample.
  await f.bot.handle(f.click('style-sample:graphic'));
  await f.bot.idle();
  assert.equal(f.rows.filter(one => one.event === 'picture_sample').at(-1)!.frameReused, true);
  assert.equal(f.requests.length, 4);
  assert.doesNotMatch(JSON.stringify(f.rows), /braid/);
});

// A portrait to pick a reference by: one person from their look alone, the whole figure from the front, in clothes and
// a style of the bot's own, with a new seed each time the reader asks. It needs no description, so no model is asked.
test('a portrait is the look alone, full length in neutral clothes and style, a new seed each time, and no model call', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  const calls = f.requests.length;
  const storyId = f.store.read('1').active!.storyId;
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  await f.bot.idle();
  assert.equal(f.requests.length, calls, 'the language model is not asked');
  const prompt = promptOf(comfy.submitted[1]);
  assert.ok(prompt.startsWith('Full-length character reference, the whole body in frame, seen from the front.'), prompt);
  assert.ok(prompt.includes(`short ash-grey hair, ${PORTRAIT_CLOTHES}: stands upright facing the viewer, arms relaxed at the sides.`), prompt);
  assert.ok(prompt.endsWith(PORTRAIT_STYLE), prompt);
  assert.doesNotMatch(prompt, /Элин|grey wool coat|Synthetic test style|expression/);
  // A standing figure is drawn on the scenes' canvas turned upright.
  assert.deepEqual([latentSizeOf(comfy.submitted[0]), latentSizeOf(comfy.submitted[1])], [{ width: 1344, height: 768 }, { width: 768, height: 1344 }]);

  // The photo comes with its caption, another version, the keep button with the id it was drawn under, and the way back.
  const photo = photos(f.sent)[1];
  assert.equal(photo.payload.caption, '🖼 Портрет: Элин. Лицо и фигура в полный рост, в простой нейтральной одежде.');
  const [[again, keep], [back]] = photo.payload.reply_markup!.inline_keyboard.map(row => row.map(button => button.callback_data));
  assert.equal(again, `portrait:${elin(storyId)}`);
  assert.match(keep, /^portrait-keep:[0-9a-f]{8}$/);
  assert.equal(back, `view:character:${elin(storyId)}`);
  const status = f.sent.find(one => one.method === 'sendMessage' && one.payload.text === '🎨 Рисую портрет…')!;
  assert.ok(f.deleted.includes(idOf(f.sent, status)), 'its status line goes');
  // It is recorded with its story and no scene, and has no prompt under it.
  const { at, ...recorded } = f.store.read('1').sentPictures!.at(-1)!;
  assert.deepEqual(recorded, { storyId, messageId: idOf(f.sent, photo) });
  assert.ok(Number.isSafeInteger(at));
  assert.equal(notes(f.sent).length, 1);
  const row = f.rows.find(one => one.event === 'picture_portrait')!;
  assert.deepEqual([row.outcome, row.imageSteps, row.actor], ['ready', 8, 'owner']);
  assert.ok(comfy.seen.cleared.includes('p2'));

  // Another version is the same prompt with another seed.
  await f.bot.handle(f.click(again));
  await f.bot.idle();
  assert.equal(promptOf(comfy.submitted[2]), prompt);
  assert.notEqual(seedIn(comfy.submitted[2]), seedIn(comfy.submitted[1]));
  assert.equal(f.requests.length, calls);
  assert.doesNotMatch(JSON.stringify(f.rows), /Элин|hair|tank top|reference/);

  // A reader who is not drawn for is refused, whatever button they have, and the card never hears of them.
  await f.start(2);
  await f.bot.idle();
  const theirs = f.store.read('2').active!.storyId;
  f.store.mutate('2', state => { state.stories[theirs].sheet = [{ name: 'Мира', look: 'A tall woman.', outfit: '' }]; });
  await f.bot.handle(f.click(`portrait:${theirs}:0:${personTag('Мира')}`, 2));
  assert.ok(told(f.sent, 'Картинки к твоим сценам пока не включены, поэтому портрет нарисовать нельзя.'));
  await f.bot.handle(f.click(keep, 2));
  assert.equal(f.sent.at(-1)!.payload.text, 'Картинки к твоим сценам пока не включены, поэтому портрет нарисовать нельзя.');
  assert.equal(comfy.submitted.length, 3);
});

test('keeping a portrait writes the very one shown into a private file beside the database, and a newer one replaces it', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1', '2'] });
  await f.start();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  const shown = () => f.sent.at(-1)!.payload.text;
  const draw = async () => {
    await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
    await f.bot.idle();
    const photo = photos(f.sent).at(-1)!;
    return { photo, keep: photo.payload.reply_markup!.inline_keyboard[0][1].callback_data, seed: seedIn(comfy.submitted.at(-1)!) };
  };
  const first = await draw();
  const second = await draw();
  // The button of a portrait keeps nothing once another one has been shown, and another reader has none to keep.
  await f.bot.handle(f.click(first.keep));
  assert.equal(shown(), 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.');
  await f.start(2);
  await f.bot.idle();
  await f.bot.handle(f.click(second.keep, 2));
  assert.equal(shown(), 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.');
  assert.equal(f.store.read('1').stories[storyId].sheet![0].portrait, undefined);
  await f.bot.handle(f.click(second.keep));
  assert.equal(shown(), '✅ Портрет сохранён: Элин. В картинки к сценам он пока не попадает.');
  const person = f.store.read('1').stories[storyId].sheet![0];
  const portrait = person.portrait!;
  assert.match(portrait.file, /^[0-9a-f]{32}\.png$/);
  assert.match(portrait.graph, /^[0-9a-f]{16}$/);
  assert.deepEqual({ ...portrait, file: '', graph: '', at: 0 }, { file: '', graph: '', at: 0, seed: second.seed, look: person.look,
    clothes: PORTRAIT_CLOTHES, style: PORTRAIT_STYLE, checkpoint: 'synthetic.safetensors', width: 768, height: 1344, steps: 8, cfg: 1,
    sampler: 'er_sde', scheduler: 'simple' });

  // The file is the photo that was shown, byte for byte, without the prompt the card wrote into it, in a directory of
  // this reader's beside the database whose name says nothing of whose it is. Only this reader can read either.
  const directory = f.store.portraits('1');
  assert.equal(dirname(directory), `${f.store.path}.portraits`);
  assert.match(basename(directory), /^[0-9a-f]{32}$/);
  assert.notEqual(f.store.portraits('2'), directory);
  assert.deepEqual(readdirSync(directory), [portrait.file]);
  const bytes = readFileSync(join(directory, portrait.file));
  assert.deepEqual(new Uint8Array(bytes), new Uint8Array(second.photo.payload.photo));
  assert.doesNotMatch(bytes.toString('latin1'), /tank top|reference/);
  assert.equal(statSync(dirname(directory)).mode & 0o777, 0o700);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, portrait.file)).mode & 0o777, 0o600);
  // The library refers to it; it never carries the picture.
  assert.ok(JSON.stringify(f.store.read('1')).length < 10_000);

  // A newer portrait kept in its place: its file is written first, and the old one goes once the library has moved on.
  const third = await draw();
  await f.bot.handle(f.click(third.keep));
  const replaced = f.store.read('1').stories[storyId].sheet![0].portrait!;
  assert.equal(replaced.seed, third.seed);
  assert.deepEqual(readdirSync(directory), [replaced.file]);
  await f.bot.handle(f.click(third.keep));
  assert.equal(shown(), 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.');

  // Once the look changes, a portrait shown before it cannot be kept, and the kept one is marked as of the earlier look.
  const fourth = await draw();
  const drawings = comfy.submitted.length;
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.message('A tall woman with a long braid'));
  assert.match(shown(), /\n\n🖼 Сохранённый портрет нарисован по прежней внешности\./);
  await f.bot.handle(f.click(fourth.keep));
  assert.equal(shown(), 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.');
  assert.equal(f.store.read('1').stories[storyId].sheet![0].portrait!.file, replaced.file);
  assert.deepEqual(readdirSync(directory), [replaced.file]);
  assert.equal(comfy.submitted.length, drawings, 'an edit draws nothing');
});

test('a portrait whose story is deleted while it is drawn is not sent, and a deleted seed takes kept ones out of the chat and off the disk', async t => {
  const slow = fakeComfy({ jobMs: 60000 });
  const slowRoot = await slow.listen();
  t.after(() => slow.server.close());
  const f = fixture(t, { comfy: slowRoot });
  await f.start();
  await until(() => slow.submitted.length === 1, 'the scene\'s picture to reach the card');
  slow.finish();
  await f.bot.idle();
  await f.bot.handle(f.click(`portrait:${elin(f.store.read('1').active!.storyId)}`));
  await until(() => slow.submitted.length === 2, 'the portrait to reach the card');
  await deleteTheSeed(f);
  slow.finish();
  await f.bot.idle();
  assert.equal(photos(f.sent).length, 1, 'the card finished it, and only the scene\'s own photo was ever sent');
  const row = f.rows.find(one => one.event === 'picture_portrait')!;
  assert.deepEqual([row.outcome, row.code, row.cancelled], ['cancelled', 'scene_gone', true]);
  assert.ok(!f.sent.some(one => one.method === 'editMessageText'), 'and the reader is told nothing');

  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const g = fixture(t, { comfy: root });
  await g.start();
  await g.bot.idle();
  await g.bot.handle(g.click(`portrait:${elin(g.store.read('1').active!.storyId)}`));
  await g.bot.idle();
  const photo = photos(g.sent).at(-1)!;
  await g.bot.handle(g.click(photo.payload.reply_markup!.inline_keyboard[0][1].callback_data));
  const directory = g.store.portraits('1');
  assert.equal(readdirSync(directory).length, 1);
  await deleteTheSeed(g);
  await g.bot.idle();
  assert.ok(g.sent.filter(one => one.method === 'deleteMessages').flatMap(one => one.payload.message_ids!).includes(idOf(g.sent, photo)));
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(g.store.read('1').sentPictures, []);
});

test('a portrait is drawn on request only, in one slot with the samples and beside a variant, and a move in the story stops both', async t => {
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s picture to reach the card');
  comfy.finish();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  // Opening the list and the card draws nothing.
  await f.bot.handle(f.click(`view:characters:${storyId}`));
  await f.bot.handle(f.click(`view:character:${elin(storyId)}`));
  assert.equal(comfy.submitted.length, 1);
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  await until(() => comfy.submitted.length === 2, 'the portrait to reach the card');
  // Another portrait, or a sample, waits for this one; a variant of the scene's picture has a slot of its own.
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  assert.ok(told(f.sent, 'Уже рисую картинку по твоей просьбе. Портрет можно попросить, когда она придёт.'));
  await f.bot.handle(f.click('style-sample:film'));
  assert.ok(told(f.sent, texts('ru').errors.sampleInFlight));
  assert.equal(comfy.submitted.length, 2);
  await f.bot.handle(f.click(editOf(notes(f.sent)[0])));
  await f.bot.handle(f.message('A synthetic prompt.'));
  await until(() => comfy.submitted.length === 3, 'the variant to reach the card beside it');

  // The move stops both, and the card is told to stop each by the job it is.
  await f.bot.handle(f.message('Осмотреться'));
  const stopped = () => f.rows.filter(one => one.event === 'picture_portrait' || one.event === 'picture_variant');
  await until(() => stopped().length === 2, 'both to stop');
  assert.deepEqual(stopped().map(row => [row.event, row.outcome, row.code]).sort(),
    [['picture_portrait', 'cancelled', 'cancelled'], ['picture_variant', 'cancelled', 'cancelled']]);
  await f.bot.stop();
  assert.equal(photos(f.sent).length, 1, 'no portrait or variant after the reader moved on');
  assert.ok(['p2', 'p3'].every(id => comfy.seen.interrupted.includes(id) && comfy.seen.cleared.includes(id)));
});

// A portrait's caption is written when it is asked for, and the drawing takes a while: a sheet written anew meanwhile
// may put somebody else where its buttons name the person. Those buttons are then refused and neither draw nor open
// that other person, while its keep button still keeps the portrait for the person it shows.
test('a portrait whose sheet changes order while it is drawn keeps to its person', async t => {
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s picture to reach the card');
  comfy.finish();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  f.store.mutate('1', state => { state.stories[storyId].sheet!.push({ name: 'Тарек', look: 'A young wiry man, curly black hair', outfit: '' }); });
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  await until(() => comfy.submitted.length === 2, 'the portrait to reach the card');
  // Тарек now stands where Элин stood, her look as it was.
  f.store.mutate('1', state => { const sheet = state.stories[storyId].sheet!; state.stories[storyId].sheet = [sheet[1], sheet[0]]; });
  comfy.finish();
  await f.bot.idle();
  const photo = photos(f.sent).at(-1)!;
  assert.equal(photo.payload.caption, '🖼 Портрет: Элин. Лицо и фигура в полный рост, в простой нейтральной одежде.');
  const [[again, keep], [back]] = photo.payload.reply_markup!.inline_keyboard.map(row => row.map(button => button.callback_data));
  await f.bot.handle(f.click(again));
  assert.equal(f.sent.at(-1)!.payload.text, 'Кнопка устарела. Открой /menu.');
  await f.bot.handle(f.click(back));
  assert.match(f.sent.at(-1)!.payload.text!, /^👤 Персонажи: /, 'the list, not the card of Тарек');
  assert.equal(comfy.submitted.length, 2, 'nobody was drawn for the old place');
  await f.bot.handle(f.click(keep));
  assert.equal(f.sent.at(-1)!.payload.text, '✅ Портрет сохранён: Элин. В картинки к сценам он пока не попадает.');
  const [first, second] = f.store.read('1').stories[storyId].sheet!;
  assert.deepEqual([first.name, first.portrait, second.name], ['Тарек', undefined, 'Элин']);
  assert.equal(second.portrait!.look, second.look);
});

// The picture of a portrait is held for its keep button and for nothing else: one replaced by a newer portrait, and one
// kept, are let go at once rather than when half an hour is up, which three portraits kept in a row once kept alive.
// Asked of the collector itself, since the size of the map says nothing of a timer that still holds a picture.
test('a portrait replaced or kept leaves no picture of it in memory', async t => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  // The picture of the photo just sent, which the test itself lets go of: past this, only the bot can hold it.
  const draw = async () => {
    await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
    await f.bot.idle();
    const photo = photos(f.sent).at(-1)!;
    const picture = new WeakRef(photo.payload.photo);
    photo.payload.photo = new Uint8Array(0);
    return { picture, keep: photo.payload.reply_markup!.inline_keyboard[0][1].callback_data };
  };
  // A WeakRef keeps what it points at to the end of the job that made or read it, so each look is a job of its own.
  const held = async (picture: WeakRef<Uint8Array>) => {
    for (let round = 0; round < 3; round++) {
      await delay(0);
      gc();
      if (picture.deref() === undefined) return false;
    }
    return true;
  };
  const replaced = await draw();
  const kept = [await draw()];
  assert.equal(await held(replaced.picture), false, 'the portrait shown before is let go');
  assert.equal(await held(kept[0].picture), true, 'the one shown last is held for its button');
  await f.bot.handle(f.click(kept[0].keep));
  for (let n = 0; n < 2; n++) {
    kept.push(await draw());
    await f.bot.handle(f.click(kept.at(-1)!.keep));
  }
  assert.equal(f.store.read('1').stories[storyId].sheet![0].portrait!.seed, seedIn(comfy.submitted.at(-1)!));
  for (const one of kept) assert.equal(await held(one.picture), false, 'a kept portrait is let go');
});

// Keeping writes the file and then the write that refers to it. When that write is rolled back, here by a trigger
// that refuses it the way a full disk would, the file goes with it and the portrait stays held for the same button.
test('a portrait whose keep is rolled back leaves no file behind and is kept by the same button again', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  await f.bot.idle();
  const keep = photos(f.sent).at(-1)!.payload.reply_markup!.inline_keyboard[0][1].callback_data;
  f.store.db.exec(`CREATE TEMP TRIGGER refuse_portrait BEFORE UPDATE ON libraries WHEN instr(NEW.payload, '"portrait":') > 0
    BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`);
  await assert.rejects(f.bot.handle(f.click(keep)), /synthetic refusal/);
  const directory = f.store.portraits('1');
  assert.deepEqual(readdirSync(directory), [], 'the file of the write rolled back went with it');
  assert.equal(f.store.read('1').stories[storyId].sheet![0].portrait, undefined);

  f.store.db.exec('DROP TRIGGER refuse_portrait');
  await f.bot.handle(f.click(keep));
  assert.equal(f.sent.at(-1)!.payload.text, '✅ Портрет сохранён: Элин. В картинки к сценам он пока не попадает.');
  const portrait = f.store.read('1').stories[storyId].sheet![0].portrait!;
  assert.equal(portrait.seed, seedIn(comfy.submitted.at(-1)!));
  assert.deepEqual(readdirSync(directory), [portrait.file]);
  // Once that write is committed, the button has nothing left to keep.
  await f.bot.handle(f.click(keep));
  assert.equal(f.sent.at(-1)!.payload.text, 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.');
});

// The sidecar of the library: a portrait's file is written before the write that refers to it. A write rolled back
// takes the file with it (above); one a stopped process never made leaves a file nobody refers to, and the next sweep
// takes it, and so does the next start.
test('a portrait file whose write never came is swept, after a write and at start', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-portraits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'story.sqlite');
  let store = new Store(path);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const mine = store.portraits('1');
  store.writePortrait('1', bytes);
  assert.equal(store.sweepPortraits('1'), 1);
  assert.deepEqual(readdirSync(mine), []);

  const file = store.writePortrait('1', bytes);
  store.mutate('1', state => {
    const { story } = newStory(state, addSeed(state, seedText).id);
    story.sheet = [{ name: 'Элин', look: 'lean', outfit: '', portrait: keptOf('lean', file) }];
  });
  store.writePortrait('1', bytes);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.portraits('1'), mine, 'the key that names the directory is kept in the database');
  store.recover();
  assert.deepEqual(readdirSync(mine), [file]);
  assert.equal(store.sweepPortraits('2'), 0, 'a reader with no portraits has no directory');
  const memory = new Store(':memory:');
  assert.equal(memory.sweepPortraits('1'), 0);
  assert.throws(() => memory.writePortrait('1', bytes), /database file/);
  memory.close();
});

// A reader's directory that cannot be read is not taken for one that is not there: the sweep fails, and the start and
// the bot tell the log so by the code alone, never by the message, which names the path. A deletion stands regardless.
test('a portraits directory that cannot be read is logged by its code, and a missing one means no portraits', async t => {
  const f = fixture(t);
  await f.start();
  assert.equal(f.store.sweepPortraits('1'), 0);
  // A file where the reader's directory should be: reading it fails otherwise than for a directory that is not there.
  const directory = f.store.portraits('1');
  mkdirSync(dirname(directory), { recursive: true });
  writeFileSync(directory, '');
  assert.throws(() => f.store.sweepPortraits('1'), { code: 'ENOTDIR' });
  const rows: Row[] = [];
  f.store.recover((event, code, details) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); });
  assert.deepEqual(rows, [{ event: 'portraits_unswept', code: 'enotdir' }]);
  await deleteTheSeed(f);
  assert.deepEqual(f.store.read('1').seeds, {});
  assert.deepEqual(f.rows.filter(one => one.event === 'portraits_unswept').map(({ event, code, actor }) => ({ event, code, actor })),
    [{ event: 'portraits_unswept', code: 'enotdir', actor: 'owner' }]);
  assert.ok(!JSON.stringify([rows, f.rows]).includes(f.directory), 'no path in the log');
});

// A kept portrait shows a reader's character, so it is story data wherever the database is put: `*.db` or `*.sqlite*`
// covers the database, and `*.portraits/` the directory beside it. Asked of the rules alone, for paths that do not
// exist, and only of this repository's own rules: a global ignore of the one who runs the test could pass it otherwise.
test('git ignores the portraits beside a database of any name', t => {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...args],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git('rev-parse', '--is-inside-work-tree'); } catch { t.skip('not a git work tree'); return; }
  const file = `${'0'.repeat(32)}/${'f'.repeat(32)}.png`;
  const paths = [`story.db.portraits/${file}`, `story.sqlite.portraits/${file}`, `state/bot.db.portraits/${file}`];
  const rules = git('check-ignore', '--no-index', '--verbose', ...paths).trim().split('\n');
  assert.deepEqual(rules.map(one => one.split('\t')[1]), paths);
  for (const rule of rules) assert.match(rule, /^\.gitignore:\d+:/);
  assert.ok(paths.every(path => !existsSync(path.split('/')[0])), 'nothing was made to be asked about');
});

test('clothes are carried down one line of the story and never into another', () => {
  const node = (id: string, parent: string | null, clothes?: Record<string, string>) =>
    ({ id, parent, input: '', text: '', time: '', truncated: false, delivery: 'sent', ...(clothes ? { clothes } : {}) });
  // a → b → c is one line of the story, a → d another; the clothes of b belong to c and never to d.
  const story = { nodes: { a: node('a', null, { Элин: 'wearing a grey wool coat' }), b: node('b', 'a', { Элин: 'wearing a red silk dress' }),
    c: node('c', 'b'), d: node('d', 'a') } } as unknown as Story;
  const sheet = [{ name: 'Элин', look: 'lean', outfit: 'wearing travel leathers' }, { name: 'Тарек', look: 'tall', outfit: 'wearing a blue tunic' }];
  assert.deepEqual(wornAt(story, 'c', sheet).map(one => one.outfit), ['wearing a red silk dress', 'wearing a blue tunic']);
  assert.deepEqual(wornAt(story, 'd', sheet).map(one => one.outfit), ['wearing a grey wool coat', 'wearing a blue tunic']);
  assert.deepEqual(wornAt(story, 'b', sheet).map(one => one.outfit), ['wearing a red silk dress', 'wearing a blue tunic'],
    'a scene described again starts from its own picture');
  // The frame names people as it likes: inflected, transliterated, twice, or somebody the sheet does not know.
  const people = [{ who: 'Элину', clothes: ' wearing a red silk dress ' }, { who: 'Tarek', clothes: 'wearing a blue tunic' },
    { who: 'salt worker', clothes: 'wearing rags' }, { who: 'Элин', clothes: 'wearing armour' }, { who: 'Тарек', clothes: '' }]
    .map(person => ({ look: '', state: '', action: '', ...person }));
  const worn = clothesOf({ people } as unknown as Description, wornAt(story, 'd', sheet));
  assert.deepEqual(worn.clothes, { Элин: 'wearing a red silk dress', Тарек: 'wearing a blue tunic' });
  assert.equal(worn.changed, 1);
});

// A description repeats the scene's own request, so what the server counted for the scene and its answer, plus the
// instruction, says what it will count now. Far from the limit that is enough and the description goes without a
// count of its own; near it, or when the scene's stamp names another model, the server counts it first as before.
test('a description far from the limit is not counted first; near it, or without the scene\'s anchor, it is', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  // Nine tenths of what a description may take, 65536 less its 900 tokens of answer, is 58172. A scene that cost 57000
  // leaves room under it for the sheet's short instruction and not for the frame's long one; 58200 leaves none.
  for (const { llama, counted, trusted } of [
    { llama: { inputTokens: 100, outputTokens: 50 }, counted: [], trusted: ['scene', 'sheet', 'frame'] },
    { llama: { inputTokens: 52000, outputTokens: 5000 }, counted: ['frame'], trusted: ['scene', 'sheet'] },
    { llama: { inputTokens: 53000, outputTokens: 5200 }, counted: ['sheet', 'frame'], trusted: ['scene'] },
    { llama: { inputTokens: 100, outputTokens: 50, illustratorModel: 'another-model' }, counted: ['sheet', 'frame'], trusted: ['scene'] },
  ]) {
    // The threshold stays above the scene and its answer, so no compaction is prepared on the way.
    const f = fixture(t, { comfy: root, llama, scheduler: true, compactAtTokens: 64000 });
    await f.start();
    await f.bot.idle();
    // The scene itself is far below its threshold and is never counted first.
    assert.deepEqual(f.counted, counted);
    assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame']);
    assert.deepEqual(f.requests.filter(request => request.trustEstimate).map(kindOf), trusted);
    assert.equal(f.rows.find(one => one.event === 'picture')!.outcome, 'ready');
  }
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
  assert.ok(comfy.seen.interrupted.includes('p1') && comfy.seen.queueDeletes >= 1, 'the card is told to stop drawing it');
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

// A picture goes with its scene: the reader deletes the seed, and the photos of its scenes leave the chat.
async function deleteTheSeed(f: ReturnType<typeof fixture>) {
  const seedId = Object.keys(f.store.read('1').seeds)[0];
  await f.bot.handle(f.click(`view:delete-seed:${seedId}`));
  await f.bot.handle(f.click(`remove-seed:${seedId}`));
}

test('every photo and the prompt under it are recorded as they are sent, and deleting the seed takes them all out of the chat', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();
  await f.bot.handle(f.click('style-samples'));
  await f.bot.idle();
  const state = f.store.read('1');
  const { storyId, branchId } = state.active!;
  const nodeId = state.stories[storyId].branches[branchId].head!;
  // The scene's own picture, one sample and all six styles, each with its prompt under it, and each recorded by its
  // message beside its scene.
  const ids = [...photos(f.sent), ...notes(f.sent)].map(one => idOf(f.sent, one)).sort((one, other) => one - other);
  assert.equal(ids.length, 16);
  assert.deepEqual(state.sentPictures!.map(({ at, ...picture }) => picture), ids.map(messageId => ({ storyId, nodeId, messageId })));
  assert.ok(state.sentPictures!.every(picture => Number.isSafeInteger(picture.at) && Math.abs(Date.now() - picture.at) < 60_000));
  // How the scene's own picture was drawn stays on the scene, for a variant of it, and never its prompt.
  assert.deepEqual(Object.keys(state.stories[storyId].nodes[nodeId].picture!).sort(),
    ['cfg', 'checkpoint', 'graph', 'height', 'sampler', 'scheduler', 'seed', 'steps', 'width']);

  await deleteTheSeed(f);
  await f.bot.idle();
  assert.deepEqual(f.sent.filter(one => one.method === 'deleteMessages').map(one => one.payload.message_ids), [ids]);
  assert.deepEqual(f.store.read('1').sentPictures, []);
  assert.deepEqual(f.rows.filter(one => one.event === 'pictures_removed'),
    [{ event: 'pictures_removed', picturesRemoved: 16, picturesNotRemoved: 0, actor: 'owner' }]);
});

test('a picture whose scene is deleted while it is drawn is not sent, and one already on its way is taken back', async t => {
  const slow = fakeComfy({ jobMs: 60000 });
  const slowRoot = await slow.listen();
  t.after(() => slow.server.close());
  const f = fixture(t, { comfy: slowRoot });
  await f.start();
  await until(() => slow.submitted.length === 1, 'the picture to reach the card');
  await deleteTheSeed(f);
  slow.finish();
  await f.bot.idle();
  assert.equal(photos(f.sent).length, 0, 'the card finished it, and nothing was sent');
  assert.ok(f.deleted.includes(f.sent.indexOf(statuses(f.sent)[0]) + 1), 'its status line goes without a word');
  assert.ok(!f.sent.some(one => one.method === 'editMessageText'));
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([row.outcome, row.code, row.cancelled], ['cancelled', 'scene_gone', true]);

  // The photo is with Telegram when the deletion lands, so the deletion finds no record of it; the photo is taken
  // back the moment it is there.
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const g = fixture(t, { comfy: root, holdPhotos: 1 });
  await g.start();
  await until(() => photos(g.sent).length === 1, 'the photo to be on its way');
  await deleteTheSeed(g);
  g.release();
  await g.bot.idle();
  assert.ok(g.deleted.includes(g.sent.indexOf(photos(g.sent)[0]) + 1), 'the photo is taken back');
  assert.ok(!g.sent.some(one => one.method === 'deleteMessages'));
  assert.equal(g.store.read('1').sentPictures, undefined);
  const taken = g.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([taken.outcome, taken.code, taken.picturesRemoved, taken.picturesNotRemoved], ['cancelled', 'scene_gone', 1, 0]);
});

test('a sample whose scene is deleted ends with the style on the card, silently, and the scene\'s own photo goes', async t => {
  const comfy = fakeComfy({ jobMs: 60000 });
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s own picture to reach the card');
  comfy.finish();
  await f.bot.idle();
  const own = [idOf(f.sent, photos(f.sent)[0]), idOf(f.sent, notes(f.sent)[0])];
  await f.bot.handle(f.click('style-samples'));
  await until(() => comfy.submitted.length === 2, 'the first style to reach the card');
  await deleteTheSeed(f);
  comfy.finish();
  await f.bot.idle();
  assert.deepEqual(f.sent.filter(one => one.method === 'deleteMessages').map(one => one.payload.message_ids), [own]);
  assert.equal(photos(f.sent).length, 1, 'the style the card finished is not sent');
  assert.equal(comfy.submitted.length, 2, 'and no style after it is drawn');
  const status = f.sent.find(one => one.method === 'sendMessage' && /во всех стилях/.test(one.payload.text ?? ''))!;
  assert.ok(f.deleted.includes(f.sent.indexOf(status) + 1), 'its status line goes without a word');
  assert.ok(!f.sent.some(one => one.method === 'editMessageText'));
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_sample').map(row => [row.outcome, row.code, row.pictureStyle, row.stylesAsked]),
    [['cancelled', 'scene_gone', 'semi', 5]]);
});

// A variant of a picture from a prompt the reader writes whole (local/picture.ts `variant`), for testing prompts
// against each other: everything but the prompt has to be the picture's own. `unworded` is a filled graph without its
// words, and without the key every job's preview gets (local/image-batch.ts `freshPreviews`).
const unworded = (graph: Graph) => Object.fromEntries(Object.entries(graph).map(([id, node]) => [id, { ...node,
  inputs: Object.fromEntries(Object.entries(node.inputs).filter(([key]) => key !== 'nonce').map(([key, value]) => [key, key === 'text' ? '' : value])) }]));
const samplerIn = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs as { seed: number; steps: number };

test('a variant is the reader\'s whole prompt drawn as it came, by the picture\'s own seed and settings, under its scene', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  // A tokenizer of whole words, and the language model's card, which notes every hold and every start.
  const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
  const touched: string[] = [];
  const gpu = { acquire: () => { touched.push('acquire'); return () => {}; }, assertReady: () => { touched.push('assertReady'); },
    resume: () => { touched.push('resume'); }, keepAwake: () => { touched.push('keepAwake'); return () => {}; },
    snapshot: () => ({ status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: null, canStart: false, canPause: true }) } as unknown as GpuController;
  const f = fixture(t, { comfy: root, style: STYLE_LINE, promptTokens: words, gpu });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();
  const [own, sample] = photos(f.sent);
  const [ownNote, sampleNote] = notes(f.sent);
  const { storyId, branchId } = f.store.read('1').active!;
  const nodeId = f.store.read('1').stories[storyId].branches[branchId].head!;

  // The button is on the prompt under the scene's own photo and nowhere else: not on the photo, not under a sample.
  // It names the scene, which keeps how its picture was drawn.
  assert.deepEqual(ownNote.payload.reply_markup?.inline_keyboard,
    [[{ text: '✏️ Изменить промпт и нарисовать вариант', callback_data: `prompt-edit:${storyId}:${nodeId}` }]]);
  assert.equal(own.payload.reply_markup, undefined);
  assert.equal(sampleNote.payload.reply_markup, undefined);
  assert.ok(!sample.payload.reply_markup?.inline_keyboard.flat().some(button => button.callback_data.startsWith('prompt-edit:')));
  const stories = JSON.stringify(f.store.read('1').stories);
  const calls = f.requests.length;
  touched.length = 0;

  // It asks for the whole prompt, style and all, and the reader's next message is that prompt.
  await f.bot.handle(f.click(editOf(ownNote)));
  assert.match(f.sent.at(-1)!.payload.text, /Это весь промпт вместе со стилем/);
  assert.deepEqual(f.store.read('1').ui, { input: 'prompt', storyId, nodeId });
  const prompt = 'Элин, 48 years old, waits at the lighthouse door at dawn. <b>Charcoal</b> & ink, no colour.';
  await f.bot.handle(f.message(prompt));
  await f.bot.idle();
  assert.equal(f.store.read('1').ui, null, 'nothing of the prompt is kept');

  // The card draws it as it came, with no style line after it and no name or age cut out, by the seed, the size and
  // the sampler of the photo it varies; the language model is neither asked nor held for it.
  assert.equal(comfy.submitted.length, 3);
  assert.equal(promptOf(comfy.submitted[2]), prompt);
  assert.deepEqual(unworded(comfy.submitted[2]), unworded(comfy.submitted[0]));
  assert.equal(f.requests.length, calls);
  assert.deepEqual(touched, []);

  // A photo of its own under the same scene, with its prompt under it and the same button, and its status line gone.
  const scene = f.sent.find(one => one.method === 'sendRichMessage' && !isNote(one))!;
  const variant = photos(f.sent)[2];
  assert.equal(variant.payload.reply_parameters?.message_id, idOf(f.sent, scene));
  assert.equal(variant.payload.caption, undefined);
  const note = notes(f.sent)[2];
  assert.equal(note.payload.reply_parameters?.message_id, idOf(f.sent, variant));
  assert.deepEqual(note.payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), [editOf(ownNote)]);
  const status = f.sent.find(one => one.method === 'sendMessage' && one.payload.text === '🎨 Рисую вариант…')!;
  assert.ok(f.deleted.includes(idOf(f.sent, status)));
  // Its size is the prompt that was drawn; what share of it is the style nobody knows, so the note does not say.
  const summary = htmlOf(note).match(/^<details><summary>(.*)<\/summary>/)![1];
  assert.equal(htmlOf(note), foldedPrompt(summary, prompt));
  assert.match(summary, /^🖼 Промпт: \d+ токен\S* · [\d ]+ знак\S*$/u);
  assert.deepEqual(summary.match(/\d[\d ]*/g)!.map(number => Number(number.replace(/ /g, ''))), [words(prompt), [...prompt].length]);

  // Recorded beside its scene like every photo, so that it leaves the chat with the scene, and varied in turn from
  // the same scene's recipe.
  const records = f.store.read('1').sentPictures!;
  assert.ok([variant, note].every(one => records.some(picture => picture.messageId === idOf(f.sent, one) && picture.nodeId === nodeId)));
  await f.bot.handle(f.click(editOf(note)));
  await f.bot.handle(f.message('A second synthetic prompt.'));
  await f.bot.idle();
  assert.equal(promptOf(comfy.submitted[3]), 'A second synthetic prompt.');
  assert.deepEqual(unworded(comfy.submitted[3]), unworded(comfy.submitted[0]));

  // Nothing else changed: not the scene, not the sheet, not the clothes, and a sample still has the scene's own frame.
  assert.equal(JSON.stringify(f.store.read('1').stories), stories);
  await f.bot.handle(f.click('style-sample:graphic'));
  await f.bot.idle();
  assert.equal(promptOf(comfy.submitted[4]).slice(0, -PRESETS.graphic.length), promptOf(comfy.submitted[0]).slice(0, -STYLE_LINE.length));

  // Its rows are counts and one flag, never a word of the prompt.
  const rows = f.rows.filter(one => one.event === 'picture_variant');
  assert.deepEqual(rows.map(row => [row.outcome, row.edited, row.actor]), [['ready', true, 'owner'], ['ready', true, 'owner']]);
  assert.deepEqual([rows[0].promptCharacters, rows[0].pictureTokens, 'styleTokens' in rows[0], rows[0].imageSteps], [[...prompt].length, words(prompt), false, 8]);
  assert.ok(Number.isSafeInteger(rows[0].imageMs!) && rows[0].photoBytes! > 0);
  assert.doesNotMatch(JSON.stringify(f.rows), /Элин|lighthouse|Charcoal|second synthetic/);
});

test('a variant is refused for a scene that is not the reader\'s own or has no picture, and for a prompt that is empty or too long', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1', '2'] });
  await f.start();
  await f.bot.idle();
  const edit = editOf(notes(f.sent)[0]);
  const [, storyId, nodeId] = edit.split(':');
  // A scene written while the reader's pictures were off has no picture to vary.
  f.images!.users.delete('1');
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  f.images!.users.add('1');
  const bare = Object.keys(f.store.read('1').stories[storyId].nodes).find(id => id !== nodeId)!;
  const drawn = comfy.submitted.length;
  const gone = 'Вариант этой картинки уже не нарисовать: её сцена удалена.';

  // A button names a scene in the library of the reader who presses it: another reader's library has no such scene,
  // a scene without a picture has nothing to vary, a story alone, all a portrait's photo is recorded with, is no scene,
  // and a button nobody made names nothing.
  for (const [data, user] of [[edit, 2], [`prompt-edit:${storyId}:${bare}`, 1], ['prompt-edit:constructor:__proto__', 1],
    [`prompt-edit:${storyId}`, 1], ['prompt-edit:7', 1]] as const) {
    const before = f.sent.length;
    await f.bot.handle(f.click(data, user));
    assert.ok(told(f.sent.slice(before), gone), data);
    assert.equal(f.store.read(String(user)).ui, null, data);
  }

  // An empty prompt and one past the limit are refused, and the reader may send it again.
  await f.bot.handle(f.click(edit));
  await f.bot.handle(f.message('   '));
  assert.ok(told(f.sent, 'Пришли промпт текстом, одним сообщением. Выйти без изменений можно кнопкой «↩️» или командой /cancel.'));
  await f.bot.handle(f.message('x'.repeat(PROMPT_CHARS + 1)));
  assert.ok(told(f.sent, 'Слишком длинно: промпт должен уложиться в 4000 знаков. Сократи и пришли снова.'));
  assert.deepEqual(f.store.read('1').ui, { input: 'prompt', storyId, nodeId });
  // Any command leaves, and the next message is a move in the story again.
  await f.bot.handle(f.message('/menu'));
  assert.equal(f.store.read('1').ui, null);
  // While a scene is being written its own picture goes first, as it does before a sample: the button is refused, and
  // so is a prompt that finds a scene being written.
  const writing = (job: boolean) => f.store.mutate('1', state => {
    state.job = job ? { id: 'j99', storyId, branchId: state.active!.branchId, head: null, memory: null, input: 'x', started: 0 } : null;
  });
  const busy = 'Сцена ещё пишется. Попроси вариант, когда она придёт.';
  writing(true);
  const pressed = f.sent.length;
  await f.bot.handle(f.click(edit));
  assert.ok(told(f.sent.slice(pressed), busy));
  assert.equal(f.store.read('1').ui, null);
  writing(false);
  await f.bot.handle(f.click(edit));
  writing(true);
  const written = f.sent.length;
  await f.bot.handle(f.message('A synthetic prompt.'));
  assert.ok(told(f.sent.slice(written), busy));
  assert.equal(f.store.read('1').ui, null);
  writing(false);
  // A reader who is no longer drawn for is told so, for a picture of their own too.
  f.images!.users.delete('1');
  await f.bot.handle(f.click(edit));
  assert.ok(told(f.sent, 'Картинки к твоим сценам пока не включены, поэтому вариант нарисовать нельзя.'));
  f.images!.users.add('1');
  // The scene is looked for again when the prompt arrives: here it has left the library behind the bot's back.
  await f.bot.handle(f.click(edit));
  f.store.mutate('1', state => { delete state.stories[storyId].nodes[nodeId]; });
  const before = f.sent.length;
  await f.bot.handle(f.message('A synthetic prompt.'));
  assert.ok(told(f.sent.slice(before), gone));
  assert.equal(f.store.read('1').ui, null);
  assert.equal(comfy.submitted.length, drawn, 'nothing was drawn');
  assert.ok(!f.rows.some(one => one.event === 'picture_variant'));
});

test('a command the bot does not know ends the wait for a style, a prompt or a look, and so does another wait', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const edit = editOf(notes(f.sent)[0]);
  const [, storyId, nodeId] = edit.split(':');
  const scenes = () => Object.keys(f.store.read('1').stories[storyId].nodes).length;
  for (const wait of ['style-new', edit, `look-edit:${elin(storyId)}`]) {
    await f.bot.handle(f.click(wait));
    await f.bot.handle(f.message('/charcoal'));
    assert.equal(f.sent.at(-1)!.payload.text, texts('ru').notices.unknownCommand, wait);
    assert.equal(f.store.read('1').ui, null, wait);
    const before = scenes();
    await f.bot.handle(f.message('Осмотреться'));
    await f.bot.idle();
    assert.equal(scenes(), before + 1, wait);
  }
  assert.deepEqual(Object.keys(f.store.read('1').pictureStyles ?? {}), [], 'no style was kept');
  assert.ok(!f.store.read('1').stories[storyId].sheet!.some(one => one.edited), 'no look was kept');
  // One wait ends where another begins: a look, then a prompt, then the look again, which the text is.
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.click(edit));
  assert.deepEqual(f.store.read('1').ui, { input: 'prompt', storyId, nodeId });
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.message('A tall woman with a long braid'));
  assert.equal(f.store.read('1').stories[storyId].sheet![0].look, 'A tall woman with a long braid');
  assert.ok(!f.rows.some(one => one.event === 'picture_variant'), 'no variant was drawn');
});

test('a variant stops at the reader\'s next move, is not sent once its scene is deleted, and a failure is told once', async t => {
  const card: { jobMs: number; failing?: boolean } = { jobMs: 60000 };
  const comfy = fakeComfy(card);
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  const vary = async (edit: string, prompt: string) => { await f.bot.handle(f.click(edit)); await f.bot.handle(f.message(prompt)); };
  const drawing = (prompt: string) => until(() => comfy.submitted.some(graph => promptOf(graph) === prompt), 'the variant to reach the card');
  await f.start();
  await until(() => comfy.submitted.length === 1, 'the scene\'s own picture to reach the card');
  comfy.finish();
  await f.bot.idle();
  const first = editOf(notes(f.sent)[0]);

  // One at a time, and the reader's next move in the story stops it without a word.
  await vary(first, 'A first synthetic prompt.');
  await drawing('A first synthetic prompt.');
  await vary(first, 'A second synthetic prompt.');
  assert.ok(told(f.sent, 'Уже рисую вариант. Следующий можно попросить, когда он придёт.'));
  await f.bot.handle(f.message('Осмотреться'));
  await until(() => f.rows.some(one => one.event === 'picture_variant'), 'the variant to stop');
  await until(() => comfy.submitted.length === 3, 'the next scene\'s picture to reach the card');
  comfy.finish();
  await f.bot.idle();
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => [row.outcome, row.code, row.edited]), [['cancelled', 'cancelled', true]]);
  assert.ok(!comfy.submitted.some(graph => promptOf(graph) === 'A second synthetic prompt.'), 'the one refused was never drawn');
  assert.equal(photos(f.sent).length, 2, 'the next scene\'s picture, and no variant of the one before');
  assert.ok(comfy.seen.cleared.includes('p2'));

  // A reader taken off the picture list while the card draws gets no photo, and is told why.
  const second = editOf(notes(f.sent)[1]);
  await vary(second, 'A third synthetic prompt.');
  await drawing('A third synthetic prompt.');
  f.images!.users.delete('1');
  comfy.finish();
  await f.bot.idle();
  f.images!.users.add('1');
  assert.equal(photos(f.sent).length, 2);
  assert.ok(told(f.sent, 'Картинки к твоим сценам пока не включены, поэтому вариант нарисовать нельзя.'));

  // The scene is deleted while its variant is on the card: the card finishes it, and nothing is sent or said.
  await vary(second, 'A fourth synthetic prompt.');
  await drawing('A fourth synthetic prompt.');
  const edits = f.sent.filter(one => one.method === 'editMessageText').length;
  await deleteTheSeed(f);
  comfy.finish();
  await f.bot.idle();
  assert.equal(photos(f.sent).length, 2);
  assert.equal(f.sent.filter(one => one.method === 'editMessageText').length, edits);
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => [row.outcome, row.code]),
    [['cancelled', 'cancelled'], ['skipped', 'pictures_off'], ['cancelled', 'scene_gone']]);

  // A card that cannot draw it: the reader is told once, and it is not tried again.
  const g = fixture(t, { comfy: root });
  await g.start();
  await until(() => comfy.submitted.length === 6, 'the scene\'s own picture to reach the card');
  comfy.finish();
  await g.bot.idle();
  card.failing = true;
  await g.bot.handle(g.click(editOf(notes(g.sent)[0])));
  await g.bot.handle(g.message('A fifth synthetic prompt.'));
  await drawing('A fifth synthetic prompt.');
  comfy.finish();
  await g.bot.idle();
  assert.equal(comfy.submitted.filter(graph => promptOf(graph) === 'A fifth synthetic prompt.').length, 1);
  assert.equal(g.sent.filter(one => one.method === 'editMessageText' && one.payload.text === 'Не получилось нарисовать вариант. Попробуй ещё раз чуть позже.').length, 1);
  assert.deepEqual(g.rows.filter(one => one.event === 'picture_variant').map(row => [row.outcome, row.edited]), [['failed', true]]);
});

test('a photo already on its way when its picture is stopped goes out with its note, and nothing of the picture follows', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, holdPhotos: 4 });
  // The stop is /cancel, whose menu is out before the photo lands: all that is sent after it is the picture's, its note
  // or, for a portrait, which has none, nothing. The photo is not taken back.
  const stopOnItsWay = async (count: number, noted = true) => {
    await until(() => photos(f.sent).length === count, 'the photo to be on its way');
    await f.bot.handle(f.message('/cancel'));
    const stopped = f.sent.length;
    f.release();
    await f.bot.idle();
    const photo = photos(f.sent)[count - 1];
    assert.ok(!f.deleted.includes(idOf(f.sent, photo)));
    const after = f.sent.slice(stopped).filter(one => one.method !== 'deleteMessage');
    assert.equal(after.length, noted ? 1 : 0);
    if (noted) {
      assert.ok(isNote(after[0]));
      assert.equal(after[0].payload.reply_parameters?.message_id, idOf(f.sent, photo));
    }
    return noted ? after[0] : photo;
  };
  // The scene's own picture, a variant of it, a sample, and a portrait, which stays there to keep.
  await f.start();
  const note = await stopOnItsWay(1);
  await f.bot.handle(f.click(editOf(note)));
  await f.bot.handle(f.message('A synthetic prompt.'));
  await stopOnItsWay(2);
  await f.bot.handle(f.click('style-sample:film'));
  await stopOnItsWay(3);
  await f.bot.handle(f.click(`portrait:${elin(f.store.read('1').active!.storyId)}`));
  const portrait = await stopOnItsWay(4, false);
  await f.bot.handle(f.click(portrait.payload.reply_markup!.inline_keyboard[0][1].callback_data));
  assert.equal(f.sent.at(-1)!.payload.text, '✅ Портрет сохранён: Элин. В картинки к сценам он пока не попадает.');
  assert.deepEqual(f.rows.filter(one => /^picture(_variant|_sample|_portrait)?$/.test(one.event)).map(row => [row.event, row.outcome, row.cancelled]),
    [['picture', 'ready', true], ['picture_variant', 'ready', true], ['picture_sample', 'ready', true], ['picture_portrait', 'ready', true]]);
});

test('a variant is drawn by the recipe its picture was drawn with, and refused once the graph or the checkpoint changed', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  const own = editOf(notes(f.sent)[0]);
  const [, storyId, nodeId] = own.split(':');
  const vary = async (prompt: string) => { await f.bot.handle(f.click(own)); await f.bot.handle(f.message(prompt)); await f.bot.idle(); };

  // Another style line and a restart change neither the seed nor the settings of a variant.
  f.images!.style = 'Another synthetic style line.';
  await f.restart();
  await vary('A synthetic prompt after a restart.');
  assert.deepEqual(unworded(comfy.submitted[1]), unworded(comfy.submitted[0]));
  // It is the scene's own record that is drawn by, not what the bot would draw the story with today.
  f.store.mutate('1', state => Object.assign(state.stories[storyId].nodes[nodeId].picture!, { seed: 12345, steps: 3 }));
  await vary('A synthetic prompt by the record.');
  assert.deepEqual([samplerIn(comfy.submitted[2]).seed, samplerIn(comfy.submitted[2]).steps], [12345, 3]);

  // Another checkpoint or another graph would make another picture: the reader is told so, and nothing is drawn,
  // whether the change is there when the button is pressed or comes while the prompt is written.
  const changed = 'С тех пор поменялась модель картинок или её настройки, и с прежними эту картинку уже не повторить. С новыми рисовать не буду, иначе отличался бы не только промпт.';
  f.images!.checkpoint = 'another.safetensors';
  await f.restart();
  await f.bot.handle(f.click(own));
  assert.ok(told(f.sent, changed));
  assert.equal(f.store.read('1').ui, null);
  f.images!.checkpoint = 'synthetic.safetensors';
  await f.restart();
  await f.bot.handle(f.click(own));
  const graph = JSON.parse(readFileSync(f.workflow, 'utf8')) as Graph;
  graph['5'].inputs.steps = 20;
  writeFileSync(f.workflow, JSON.stringify(graph));
  await f.restart();
  const before = f.sent.length;
  await f.bot.handle(f.message('A synthetic prompt for a graph that changed meanwhile.'));
  assert.ok(told(f.sent.slice(before), changed));
  assert.equal(comfy.submitted.length, 3);

  // A picture drawn since has the new recipe, and its variant is drawn by it.
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.handle(f.click(editOf(notes(f.sent).at(-1)!)));
  await f.bot.handle(f.message('A synthetic prompt for the new graph.'));
  await f.bot.idle();
  assert.equal(promptOf(comfy.submitted.at(-1)!), 'A synthetic prompt for the new graph.');
  assert.equal(samplerIn(comfy.submitted.at(-1)!).steps, 20);
  assert.equal(samplerIn(comfy.submitted.at(-1)!).seed, samplerIn(comfy.submitted[0]).seed, 'and the story\'s one seed');
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => row.outcome), ['ready', 'ready', 'ready']);
});

test('a scene keeps its picture\'s recipe as long as the scene is kept, and its button fits in 64 bytes however long the ids grow', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  // Ids are counted by one sequence per library; this one is near the largest number it can count to.
  f.store.mutate('1', state => { state.seq = Number.MAX_SAFE_INTEGER - 100; });
  await f.start();
  await f.bot.idle();
  const edit = editOf(notes(f.sent)[0]);
  assert.match(edit, /^prompt-edit:h\d{16}:n\d{16}$/);
  assert.ok(Buffer.byteLength(edit, 'utf8') <= 64, edit);

  // The records of the photos serve their deletion alone and go after two days, when Telegram lets the bot delete
  // them no more; the recipe stays with the scene.
  f.store.mutate('1', state => { state.sentPictures = []; });
  await f.bot.handle(f.click(edit));
  await f.bot.handle(f.message('A synthetic prompt two days on.'));
  await f.bot.idle();
  assert.equal(promptOf(comfy.submitted.at(-1)!), 'A synthetic prompt two days on.');
  assert.equal(photos(f.sent).length, 2);
});

test('a wait for a prompt outlives a restart, and the prompt that ends it is checked again before anything is drawn', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root });
  await f.start();
  await f.bot.idle();
  const edit = editOf(notes(f.sent)[0]);
  const [, storyId, nodeId] = edit.split(':');
  const drawn = () => comfy.submitted.length;

  // The wait is in the library, so the bot that starts again takes the next text for the prompt.
  await f.bot.handle(f.click(edit));
  await f.restart();
  assert.deepEqual(f.store.read('1').ui, { input: 'prompt', storyId, nodeId });
  await f.bot.handle(f.message('A synthetic prompt after a restart.'));
  await f.bot.idle();
  assert.equal(drawn(), 2);
  assert.equal(promptOf(comfy.submitted[1]), 'A synthetic prompt after a restart.');

  // A bot that starts again without pictures for this reader, or with another checkpoint, draws nothing for a wait
  // left open before, says why, and closes it.
  const refusals = [
    [() => f.images!.users.delete('1'), () => f.images!.users.add('1'), 'Картинки к твоим сценам пока не включены, поэтому вариант нарисовать нельзя.'],
    [() => { f.images!.checkpoint = 'another.safetensors'; }, () => { f.images!.checkpoint = 'synthetic.safetensors'; },
      'С тех пор поменялась модель картинок или её настройки, и с прежними эту картинку уже не повторить. С новыми рисовать не буду, иначе отличался бы не только промпт.'],
  ] as const;
  for (const [change, undo, reason] of refusals) {
    await f.bot.handle(f.click(edit));
    change();
    await f.restart();
    const before = f.sent.length;
    await f.bot.handle(f.message('A synthetic prompt for a bot that changed.'));
    await f.bot.idle();
    assert.ok(told(f.sent.slice(before), reason), reason);
    assert.equal(f.store.read('1').ui, null);
    assert.equal(drawn(), 2, 'nothing was drawn');
    undo();
    await f.restart();
  }
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => row.outcome), ['ready']);
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

// Everything the bot asks for a reader is that reader's work at the gateway: their scene, the compaction prepared while
// they read and their picture's description, counts included, all go as class reader in the reader's own cache scope,
// and another reader's in another (local/serving.ts, contract section 2).
test('a reader\'s scene, the compaction prepared for them and their picture reach the gateway in that reader\'s scope', async t => {
  const comfy = fakeComfy();
  const root = await comfy.listen();
  t.after(() => comfy.server.close());
  const f = fixture(t, { comfy: root, users: ['1', '2'], serving: true, scheduler: true, keepScenes: 1, compactAtTokens: 30000,
    usage: { inputTokens: 29000, outputTokens: 2000 } });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.idle();
  const first = f.heard.length;
  await f.start(2);
  await f.bot.idle();
  await f.bot.idle();

  assert.equal(photos(f.sent).length, 3);
  const whose = (heard: Heard[]) => [...new Set(heard.map(one => `${one.class} ${one.scope}`))];
  assert.deepEqual(whose(f.heard.slice(0, first)), [`reader ${readerScope('1')}`]);
  assert.deepEqual(whose(f.heard.slice(first)), [`reader ${readerScope('2')}`]);
  for (const kind of ['scene', 'compaction', 'sheet', 'frame']) assert.ok(f.heard.slice(0, first).some(one => one.kind === kind), kind);
  assert.ok(f.heard.some(one => one.kind.startsWith('count ')), 'a count goes in the same scope as its generation');
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
