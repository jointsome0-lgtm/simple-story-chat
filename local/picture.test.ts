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
// Every word of these stories, looks, prompts and styles, and the card's address and checkpoint: a log row carries
// counts and words of its own, and none of these.
const PRIVATE = /Элин|Тарек|Мира|Маяк|Смотритель|Кодовая|СЕВЕР|Синтетическ|Уголь|hair|braid|coat|door|lighthouse|Charcoal|[Ss]ynthetic|Photorealistic|Semi-realistic|Watercolor|Hand-painted|tank top|reference|127\.0\.0\.1|safetensors/;
// A tokenizer of whole words, so that what a note or a card says can be counted by hand.
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
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
  // A picture card of its own (`fakeComfy`), whose options a test may change while it runs; without one there is no
  // picture configuration at all.
  card?: { jobMs?: number; failing?: boolean };
  users?: string[]; style?: string; offsetMs?: number; sheetReply?: object;
  // What the model describes each frame as, in turn; the last one answers every frame after it.
  frameReplies?: object[];
  // Scene deliveries and photos to hold on their way, so that a test can act while Telegram has them; the real queue
  // between the bot and the model; and what makes the bot prepare the next compaction while the reader reads.
  holdFinal?: number; holdPhotos?: number; scheduler?: boolean; compactAtTokens?: number; keepScenes?: number;
  // A workflow that ends in SaveImage, as the ones pinned in gpu/ do.
  saveImage?: boolean;
  // A model that refuses the sheet with this code, and a Telegram that will not delete a message or send a photo's note.
  sheetError?: string; refuseDelete?: boolean; refuseNote?: boolean;
  // The picture model's tokenizer, for the note under a photo and for a text of a characters' card.
  promptTokens?: (prompt: string) => number; textTokens?: (text: string) => number;
  // What the model says a scene cost: its own numbers, not the size of these synthetic scenes.
  usage?: { inputTokens: number; outputTokens: number };
  // The real simple-serving or llama.cpp provider in front of its fake, with what the server counts for the scene;
  // `illustratorModel` names the story model to the illustrator otherwise than the scenes' stamps do.
  serving?: boolean; llama?: { inputTokens: number; outputTokens: number; illustratorModel?: string };
  // The language model's card as the bot holds it for a scene.
  gpu?: GpuController;
};
async function fixture(t: TestContext, options: Options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-picture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'story.sqlite'));
  t.after(() => store.close());
  const card = options.card && fakeComfy(options.card);
  if (card) t.after(() => card.server.close());
  const url = card && await card.listen();
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
    // A compaction prepared ahead asks with no stream and no schema; its answer is dropped by the check, and all a
    // test needs of it is that it took the model's slot.
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

  const images: ImageConfig | undefined = url === undefined ? undefined : {
    url, workflow, checkpoint: 'synthetic.safetensors', style: options.style,
    users: new Set(options.users ?? ['1']), waitMs: 5000, timeoutMs: 5000,
  };
  // A test that wants whole seconds of wait moves the bot's clock forward by `offsetMs`. `restart` builds the bot and
  // its illustrator again over the same store and Telegram, and so forgets whatever they kept in memory.
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
  return { get bot() { return running.bot; }, get illustrator() { return running.illustrator; },
    get comfy() { if (!card) throw new Error('This fixture has no picture card'); return card; }, restart,
    store, sent, rows, requests, counted, heard, deleted, provider, message, click, start, release, workflow, directory, images };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Waits for something the fake server or the bot does on its own; the whole file runs in milliseconds.
async function until(condition: () => boolean, what: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await delay(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}
// A slow card, done at last: waits for its `jobs`th job, ends every job on it, and lets the bot finish what follows.
async function drawnOn(f: Fixture, jobs: number) {
  await until(() => f.comfy.submitted.length === jobs, `job ${jobs} to reach the card`);
  f.comfy.finish();
  await f.bot.idle();
}
// A picture goes with its scene: the reader deletes the seed, and the photos of its scenes leave the chat.
async function deleteTheSeed(f: Fixture) {
  const seedId = Object.keys(f.store.read('1').seeds)[0];
  await f.bot.handle(f.click(`view:delete-seed:${seedId}`));
  await f.bot.handle(f.click(`remove-seed:${seedId}`));
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
// The numbers a note's summary gives, in order.
const countsOf = (summary: string) => summary.match(/\d[\d ]*/g)!.map(number => Number(number.replace(/ /g, '')));
const KEPT = '✅ Портрет сохранён: Элин. В картинки к сценам он пока не попадает.';
const STALE = 'Этот портрет уже не сохранить: он устарел или внешность с тех пор изменилась. Нарисуй новый.';

// Off by default and per reader: the story of a reader who did not ask for pictures is never drawn, not even on a card
// we run (AGENTS.md), whatever button they press.
test('a reader who is not on the picture list gets the scene and nothing else', async t => {
  const none = await fixture(t);
  await none.start();
  await none.bot.idle();
  assert.deepEqual([none.requests.map(kindOf), statuses(none.sent).length, photos(none.sent).length, none.rows.filter(row => row.event === 'picture').length],
    [['scene'], 0, 0, 0], 'without the picture configuration the scene is the only model call, and nothing is drawn');

  // The configuration is on and the card is up for reader 1; reader 2 is simply not named in it.
  const card: { jobMs?: number } = {};
  const f = await fixture(t, { card });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.click(`portrait:${elin(f.store.read('1').active!.storyId)}`));
  await f.bot.idle();
  const keep = photos(f.sent).at(-1)!.payload.reply_markup!.inline_keyboard[0][1].callback_data;
  const [drawn, calls, sent] = [f.comfy.submitted.length, f.requests.length, f.sent.length];
  await f.start(2);
  await f.bot.idle();
  assert.deepEqual([f.requests.slice(calls).map(kindOf), statuses(f.sent.slice(sent)).length, photos(f.sent.slice(sent)).length], [['scene'], 0, 0],
    'a reader not on the list gets the scene alone');
  // A drawing on request is refused with the reason, whether the button is of their own story or another reader's.
  const theirs = f.store.read('2').active!.storyId;
  f.store.mutate('2', state => { state.stories[theirs].sheet = [{ name: 'Мира', look: 'A tall woman.', outfit: '' }]; });
  const off = (what: string) => `Картинки к твоим сценам пока не включены, поэтому ${what} нарисовать нельзя.`;
  for (const [data, refusal] of [['style-sample:film', off('пример')], [`portrait:${theirs}:0:${personTag('Мира')}`, off('портрет')],
    [keep, off('портрет')], [editOf(notes(f.sent)[0]), off('вариант')]]) {
    await f.bot.handle(f.click(data, 2));
    assert.equal(f.sent.at(-1)!.payload.text, refusal, data);
  }
  await f.bot.idle();
  assert.deepEqual([f.comfy.submitted.length, f.store.read('2').ui], [drawn, null], 'nothing of this reader reached the card, and no wait is open');

  // Reader 1, taken off the list while the card draws their variant, gets no photo and is told why.
  card.jobMs = 60000;
  const before = f.sent.length;
  await f.bot.handle(f.click(editOf(notes(f.sent)[0])));
  await f.bot.handle(f.message('A synthetic prompt.'));
  await until(() => f.comfy.submitted.length === drawn + 1, 'the variant to reach the card');
  f.images!.users.delete('1');
  f.comfy.finish();
  await f.bot.idle();
  assert.deepEqual([photos(f.sent).length, told(f.sent.slice(before), off('вариант')), f.rows.filter(one => one.event === 'picture_variant').map(row => [row.outcome, row.code])],
    [2, true, [['skipped', 'pictures_off']]], 'a reader taken off the list while the card draws');
});

test('an illustrated scene: a status line, one description call, a prompt with our style and no names, then the photo', async t => {
  const f = await fixture(t, { card: {}, style: STYLE_LINE, offsetMs: 3000, promptTokens: words });
  await f.start();
  await f.bot.idle();
  // The scene, one status line under it, then the photo under the scene, and the status line alone goes.
  const scene = f.sent.find(one => one.method === 'sendRichMessage')!;
  const [status, ...more] = statuses(f.sent);
  const photo = photos(f.sent)[0];
  assert.deepEqual([more, f.sent.indexOf(scene) < f.sent.indexOf(status), photo.payload.reply_parameters?.message_id, f.deleted],
    [[], true, idOf(f.sent, scene), [idOf(f.sent, status)]]);
  // Two model calls after the scene, each with its schema; the frame continues the scene's own request, instruction last.
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame']);
  const frame = f.requests[2];
  const properties = (frame.outputSchema as { properties: Record<string, { maxItems?: number }> }).properties;
  assert.deepEqual([Object.keys(properties).sort(), properties.people.maxItems, frame.system],
    [['light', 'moment', 'objects', 'people', 'props', 'setting', 'shot'], 4, f.requests[0].system]);
  assert.match(frame.messages.at(-1)!.content, /Опиши ПОСЛЕДНЮЮ сцену/);

  // Our style line last; the sheet's look of a person it covers with the frame's clothes after it, and not the frame's
  // own look; no name, no age as a number, and nothing of the scene.
  const prompt = promptOf(f.comfy.submitted[0]);
  assert.ok(prompt.endsWith(STYLE_LINE));
  assert.match(prompt, /short ash-grey hair, wearing a grey wool coat, her bandaged/);
  assert.doesNotMatch(prompt, /Элин|Elin|\d|woman in red|Кодовая фраза|СЕВЕР|Синтетическая сцена/);
  // The photo is pixels alone: the prompt ComfyUI wrote into the PNG does not reach the reader.
  const bytes = Buffer.from(photo.payload.photo);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && !bytes.includes('tEXt') && !bytes.includes(STYLE_LINE));

  // The prompt the card drew goes to the reader alone, folded under the photo (docs/telegram-ui.md#picture-prompts),
  // with its tokens in the picture model's tokenizer, the style line's share of them, and its characters.
  const note = notes(f.sent)[0];
  assert.deepEqual([note.payload.reply_parameters?.message_id, idOf(f.sent, note) > idOf(f.sent, photo)], [idOf(f.sent, photo), true]);
  const summary = htmlOf(note).match(/^<details><summary>(.*)<\/summary>/)![1];
  assert.equal(htmlOf(note), foldedPrompt(summary, prompt));
  assert.match(summary, /^🖼 Промпт: \d+ токен\S*, из них стиль \d+ · [\d ]+ знак\S*$/u);
  assert.deepEqual(countsOf(summary), [words(prompt), words(STYLE_LINE), [...prompt].length]);

  // One row of counts and words of its own; the names that got through the instruction were cut from two fields. Three
  // seconds on the bot's clock plus the fakes' real time, which a loaded machine stretches: rounded, still 3.
  const row = f.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([row.outcome, row.code, row.actor, row.pictureSeconds, row.photoBytes, row.imageSteps, row.withoutLook, row.namesStripped],
    ['ready', undefined, 'owner', 3, bytes.length, 8, 0, 2]);
  assert.ok([row.pictureAfterSceneMs, row.describeMs, row.imageMs, row.photoMs].every(ms => Number.isSafeInteger(ms) && ms! >= 0) && row.pictureAfterSceneMs! >= 3000);
  assert.deepEqual([row.promptCharacters, row.pictureTokens, row.styleTokens], [[...prompt].length, words(prompt), words(STYLE_LINE)], 'the note\'s counts');
  assert.deepEqual([f.rows.find(one => one.event === 'picture_sheet_written')!.sheetCharacters, f.rows.some(one => one.event === 'picture_prompt_unsent')], [1, false]);
  assert.doesNotMatch(JSON.stringify(f.rows), PRIVATE);
  // The job is not left on the card: its record is cleared, prompt and workflow with it.
  assert.deepEqual(f.comfy.seen.cleared, ['p1']);

  // A workflow pinned on a card ends in SaveImage, which writes the picture, prompt and all, where ComfyUI never empties
  // and its API cannot reach: it is loaded as one that previews it, keyed so that the job's file is its own.
  const saving = await fixture(t, { card: {}, saveImage: true });
  await saving.start();
  await saving.bot.idle();
  const sink = saving.comfy.submitted[0]['7'];
  assert.deepEqual([sink.class_type, Object.keys(sink.inputs).sort(), sink.inputs.images, photos(saving.sent).length, saving.rows.find(one => one.event === 'picture')!.outcome],
    ['PreviewImage', ['images', 'nonce'], ['6', 0], 1, 'ready'], 'a workflow that saves');

  // A sheet the model answers with nothing: the frame's own look draws the person, its years and the name cut
  // (local/illustrate.ts); with no style line configured, the measured one ends it.
  const empty = await fixture(t, { card: {}, sheetReply: { characters: [] } });
  await empty.start();
  await empty.bot.idle();
  const bare = promptOf(empty.comfy.submitted[0]);
  assert.ok(bare.endsWith(STYLE) && bare.includes('a woman in red'), 'an empty sheet');
  assert.doesNotMatch(bare, /\d|Элин/, 'an empty sheet: no age as a number, and no name');
  const described = empty.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([described.outcome, described.namesStripped, described.withoutLook], ['ready', 2, 0], 'an empty sheet');
});

// A rich message holds 32768 characters (docs/telegram-ui.md#telegram-limits), counted here in UTF-8 bytes, which are
// never fewer. The prompt in it is plain text a phone wraps: nothing in it is read as a tag, and only the fold itself
// closes.
test('the longest prompt a reader may write fits its note, every character escaped, under the summary of any language', () => {
  for (const [summary, prompt, folded] of [['S', 'A quiet harbour. Painterly.', '<details><summary>S</summary>A quiet harbour. Painterly.</details>'],
    ['S & T', 'A sign reads </details> <summary>x</summary> & ```code```. Done.',
      '<details><summary>S &amp; T</summary>A sign reads &lt;/details&gt; &lt;summary&gt;x&lt;/summary&gt; &amp; ```code```. Done.</details>']]) {
    assert.equal(foldedPrompt(summary, prompt), folded, prompt);
  }
  for (const lang of REGISTERED) {
    const summary = texts(lang).notices.promptSummary(PROMPT_CHARS, 999_999, null);
    for (const prompt of ['&'.repeat(PROMPT_CHARS), '𝔄'.repeat(PROMPT_CHARS)]) {
      assert.ok(Buffer.byteLength(foldedPrompt(summary, prompt), 'utf8') <= 32768, lang);
    }
  }
});

// A sample of a style is the frame of the reader's last scene drawn again with the story's seed and another last
// sentence: the frame kept from the scene's own picture, so that a sample costs the card alone, or the scene described
// again once that frame is gone or stale. It chooses no style.
test('a sample of a style is the last scene drawn once more: its frame and seed, another last sentence, and no model call', async t => {
  const f = await fixture(t, { card: {}, style: STYLE_LINE, promptTokens: words, textTokens: words });
  const sampled = async (button: string) => {
    await f.bot.handle(f.click(button));
    await f.bot.idle();
    return f.rows.filter(one => one.event === 'picture_sample').at(-1)!;
  };
  await sampled('style-sample:film');
  assert.equal(f.sent.at(-1)!.payload.text, 'Пример рисуется по последней сцене. Начни историю, и после первой сцены его можно будет попросить.', 'before any scene');
  await f.start();
  await f.bot.idle();
  const row = await sampled('style-sample:film');
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame'], 'the language model is not asked again');
  const [own, sample] = f.comfy.submitted.map(promptOf);
  const described = own.slice(0, -STYLE_LINE.length);
  assert.equal(sample, described + PRESETS.film, 'the same frame, and another style sentence');
  assert.equal(seedIn(f.comfy.submitted[1]), seedIn(f.comfy.submitted[0]), 'and the story\'s seed, so that the style alone tells them apart');
  // A photo of its own with a caption and the way to choose the style, and its status line goes.
  const photo = photos(f.sent)[1];
  assert.deepEqual([photo.payload.caption, photo.payload.reply_parameters, photo.payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data)],
    ['Пример стиля: 🎬 Кинокадр', undefined, ['style:film', 'view:style']]);
  assert.ok(f.deleted.includes(idOf(f.sent, f.sent.find(one => one.payload.text === '🎨 Рисую пример…')!)));
  assert.deepEqual([row.outcome, row.frameReused, row.describeMs, row.pictureStyle, row.imageSteps, row.actor], ['ready', true, 0, 'film', 8, 'owner']);
  // Its note under it and its row count the style line it was drawn in; the status lines are all that left the chat.
  const note = notes(f.sent)[1];
  const summary = htmlOf(note).match(/^<details><summary>(.*)<\/summary>/)![1];
  assert.deepEqual([note.payload.reply_parameters?.message_id, idOf(f.sent, note) > idOf(f.sent, photo), htmlOf(note), countsOf(summary), f.deleted.length],
    [idOf(f.sent, photo), true, foldedPrompt(summary, sample), [words(sample), words(PRESETS.film), [...sample].length], 2]);
  assert.deepEqual([row.promptCharacters, row.pictureTokens, row.styleTokens], [[...sample].length, words(sample), words(PRESETS.film)]);

  // Every style at once: that frame in every style of the picker, in its order, with the one seed and a caption each,
  // and one status line for all, which goes once the last one is there; no job, the sample's included, stays on the card.
  await sampled('style-samples');
  const lines = [STYLE_LINE, PRESETS.semi, PRESETS.novel, PRESETS.film, PRESETS.graphic, PRESETS.watercolor];
  assert.deepEqual(f.comfy.submitted.slice(2).map(promptOf), lines.map(line => described + line));
  assert.ok(f.comfy.submitted.every(graph => seedIn(graph) === seedIn(f.comfy.submitted[0])));
  assert.deepEqual(photos(f.sent).slice(2).map(one => one.payload.caption), ['⚙️ Стандартный', '🖌 Полуреализм', '📖 Визуальная новелла', '🎬 Кинокадр',
    '🖋 Графический роман', '💧 Акварель'].map(name => `Пример стиля: ${name}`));
  assert.deepEqual(photos(f.sent)[3].payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data), ['style:semi', 'view:style']);
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_sample').slice(1).map(one => [one.pictureStyle, one.stylesAsked, one.frameReused, one.outcome, one.describeMs]),
    ['standard', 'semi', 'novel', 'film', 'graphic', 'watercolor'].map(style => [style, 6, true, 'ready', 0]));
  assert.deepEqual(f.sent.filter(one => one.method === 'sendMessage' && /во всех стилях/.test(one.payload.text ?? ''))
    .map(one => [/\(6\)/.test(one.payload.text), f.deleted.includes(idOf(f.sent, one))]), [[true, true]], 'one status line for all');
  assert.ok(f.comfy.submitted.every((graph, at) => f.comfy.seen.cleared.includes(`p${at + 1}`)), 'no job is left on the card');
  assert.equal(f.store.read('1').pictureStyle, undefined, 'a sample chooses no style');

  // A style of the reader's own ends the prompt as written, and is logged as custom, never by its words.
  await f.bot.handle(f.click('style-new'));
  await f.bot.handle(f.message('Уголь\nCharcoal sketch on rough paper'));
  assert.equal((await sampled(`style-sample:${f.store.read('1').pictureStyle!}`)).pictureStyle, 'custom');
  assert.ok(promptOf(f.comfy.submitted.at(-1)!).endsWith('. Charcoal sketch on rough paper'));
  const custom = photos(f.sent).at(-1)!.payload;
  assert.deepEqual([custom.caption, custom.reply_markup?.inline_keyboard.flat().map(button => button.callback_data)], ['Пример стиля: ✍️ Уголь', ['view:style']]);

  // A person's card counts each text with the picture model's tokenizer. A look edited since the frame was described is
  // described again and drawn as it is now, and that frame serves the next sample.
  const storyId = f.store.read('1').active!.storyId;
  await f.bot.handle(f.click(`view:character:${elin(storyId)}`));
  assert.match(f.sent.at(-1)!.payload.text, /\nТекст внешности: 8 токенов · 59 знаков\n/);
  assert.match(f.sent.at(-1)!.payload.text, /\nТекст одежды: 5 токенов · 24 знака\n/);
  const drawn = f.comfy.submitted.length;
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.message('A tall woman with a long braid'));
  assert.equal(f.comfy.submitted.length, drawn, 'an edit draws nothing');
  assert.equal((await sampled('style-sample:graphic')).frameReused, false, 'a look edited since');
  assert.match(promptOf(f.comfy.submitted.at(-1)!), /A tall woman with a long braid, wearing a grey wool coat/);
  assert.doesNotMatch(promptOf(f.comfy.submitted.at(-1)!), /ash-grey/);
  assert.equal((await sampled('style-sample:watercolor')).frameReused, true, 'the frame described for it');
  // The frame is kept in memory only: after a restart the scene is described again, from the sheet kept beside the story.
  await f.restart();
  const restarted = await sampled('style-sample:semi');
  assert.deepEqual([restarted.outcome, restarted.frameReused, Number.isSafeInteger(restarted.describeMs)], ['ready', false, true], 'after a restart');
  assert.ok(promptOf(f.comfy.submitted.at(-1)!).endsWith(PRESETS.semi));
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'frame', 'frame'], 'described again twice, and only then');
  assert.doesNotMatch(JSON.stringify(f.rows), PRIVATE);
});

// A picture of a scene the reader has read past is worse than none, and so is a drawing asked for at a scene they have
// left: their next message ends it, the card is told to stop each job by its id, and the reader is told nothing.
test('the reader\'s next message ends the picture of the scene they have read past', async t => {
  const f = await fixture(t, { card: { jobMs: 60000 } });
  await f.start();
  await until(() => f.comfy.submitted.length === 1, 'the picture to reach the card');
  const status = idOf(f.sent, statuses(f.sent)[0]);
  await f.bot.handle(f.message('Осмотреться'));
  // The second scene starts its own picture on the same slow card; stopping the bot ends that one the same way.
  await until(() => f.comfy.submitted.length === 2, 'the next scene\'s picture to reach the card');
  await f.bot.stop();
  assert.equal(photos(f.sent).length, 0, 'no picture of a scene the reader has read past');
  assert.ok(f.deleted.includes(status), 'the status line under the first scene goes without a word');
  assert.ok(f.comfy.seen.interrupted.includes('p1') && f.comfy.seen.queueDeletes >= 1 && f.comfy.seen.cleared.includes('p1'),
    'the card is told to stop drawing it, and the job is off its history');
  assert.deepEqual(f.rows.filter(one => one.event === 'picture').map(row => [row.outcome, row.code, row.cancelled, Number.isSafeInteger(row.pictureSeconds)]),
    [['cancelled', 'cancelled', true, true], ['cancelled', 'cancelled', true, true]]);
  // The turn the reader asked for ran, and the second scene is theirs as usual.
  const state = f.store.read('1');
  assert.deepEqual([f.requests.filter(request => kindOf(request) === 'scene').length, Object.keys(state.stories[state.active!.storyId].nodes).length], [2, 2]);

  // A drawing the reader asked for, one of a kind at a time, stops the same way. `jobs` are its jobs on the card,
  // `stopped` its rows as [event, outcome, code, style, styles asked, edited].
  const errors = texts('ru').errors;
  const waits = async (g: Fixture, label: string, text: string, ...updates: Update[]) => {
    const drawn = g.comfy.submitted.length;
    for (const update of updates) await g.bot.handle(update);
    assert.deepEqual([g.sent.at(-1)!.payload.text, g.comfy.submitted.length], [text, drawn], `${label}: the next one waits`);
  };
  const asked: { label: string; jobs: string[]; stopped: unknown[][]; ask: (g: Fixture, label: string) => Promise<void>; after?: (g: Fixture, label: string) => void }[] = [
    { label: 'a sample', jobs: ['p2'], stopped: [['picture_sample', 'cancelled', 'cancelled', 'film', 1, undefined]], ask: async (g, label) => {
      await g.bot.handle(g.click('view:style'));
      await g.bot.handle(g.click('view:style:film'));
      assert.equal(g.comfy.submitted.length, 1, `${label}: the picker and a style's card draw nothing`);
      await g.bot.handle(g.click('style-sample:film'));
      await until(() => g.comfy.submitted.length === 2, `${label}: to reach the card`);
      await waits(g, label, errors.sampleInFlight, g.click('style-sample:graphic'));
    } },
    { label: 'every style', jobs: ['p2'], stopped: [['picture_sample', 'cancelled', 'cancelled', 'semi', 5, undefined]], ask: async (g, label) => {
      await g.bot.handle(g.click('style-samples'));
      await until(() => g.comfy.submitted.length === 2, `${label}: to reach the card`);
      await waits(g, label, errors.sampleInFlight, g.click('style-sample:film'));
    }, after: (g, label) => {
      // The scenes' own pictures end with the standard line, the novel preset here; the batch began with semi.
      const ending = (line: string) => g.comfy.submitted.filter(graph => promptOf(graph).endsWith(line)).length;
      assert.deepEqual([PRESETS.semi, PRESETS.film, PRESETS.graphic, PRESETS.watercolor].map(ending), [1, 0, 0, 0], `${label}: no style after it reaches the card`);
    } },
    { label: 'a portrait beside a variant', jobs: ['p2', 'p3'], stopped: [['picture_portrait', 'cancelled', 'cancelled', undefined, undefined, undefined],
      ['picture_variant', 'cancelled', 'cancelled', undefined, undefined, true]], ask: async (g, label) => {
      const storyId = g.store.read('1').active!.storyId;
      await g.bot.handle(g.click(`view:characters:${storyId}`));
      await g.bot.handle(g.click(`view:character:${elin(storyId)}`));
      assert.equal(g.comfy.submitted.length, 1, `${label}: the list and the card draw nothing`);
      await g.bot.handle(g.click(`portrait:${elin(storyId)}`));
      await until(() => g.comfy.submitted.length === 2, `${label}: to reach the card`);
      // Another portrait, or a sample, waits for it; a variant has a slot of its own, and the next variant waits for that.
      await waits(g, label, errors.portraitInFlight, g.click(`portrait:${elin(storyId)}`));
      await waits(g, label, errors.sampleInFlight, g.click('style-sample:film'));
      await g.bot.handle(g.click(editOf(notes(g.sent)[0])));
      await g.bot.handle(g.message('A first synthetic prompt.'));
      await until(() => g.comfy.submitted.length === 3, `${label}: the variant to reach the card beside it`);
      await waits(g, label, errors.variantInFlight, g.click(editOf(notes(g.sent)[0])), g.message('A second synthetic prompt.'));
    }, after: (g, label) => {
      assert.ok(!g.comfy.submitted.some(graph => promptOf(graph) === 'A second synthetic prompt.'), `${label}: the variant refused is never drawn`);
    } },
  ];
  for (const { label, jobs, stopped, ask, after } of asked) {
    const g = await fixture(t, { card: { jobMs: 60000 } });
    await g.start();
    await drawnOn(g, 1);
    await ask(g, label);
    const rows = () => g.rows.filter(one => /^picture_(sample|portrait|variant)$/.test(one.event));
    await g.bot.handle(g.message('Осмотреться'));
    await until(() => rows().length === stopped.length, `${label}: to stop`);
    await g.bot.stop();
    assert.deepEqual(rows().map(row => [row.event, row.outcome, row.code, row.pictureStyle, row.stylesAsked, row.edited]).sort(), stopped, label);
    assert.equal(photos(g.sent).length, 1, `${label}: nothing of it is sent once the reader moved on`);
    assert.ok(statuses(g.sent).every(one => g.deleted.includes(idOf(g.sent, one))) && !g.sent.some(one => one.method === 'editMessageText'),
      `${label}: its status line goes without a word`);
    assert.ok(jobs.every(id => g.comfy.seen.interrupted.includes(id) && g.comfy.seen.cleared.includes(id)), `${label}: each job stopped and cleared`);
    after?.(g, label);
  }

  // A card that fails: a sample says so once, from the frame described for the scene's own picture that failed, and of
  // every style the first says so and the rest are not tried; so does a variant of a later scene's picture, once.
  const failing = { failing: true };
  const broken = await fixture(t, { card: failing });
  await broken.start();
  await broken.bot.idle();
  for (const button of ['style-sample:film', 'style-samples']) {
    await broken.bot.handle(broken.click(button));
    await broken.bot.idle();
  }
  failing.failing = false;
  await broken.bot.handle(broken.message('Осмотреться'));
  await broken.bot.idle();
  failing.failing = true;
  await broken.bot.handle(broken.click(editOf(notes(broken.sent)[0])));
  await broken.bot.handle(broken.message('A synthetic prompt.'));
  await broken.bot.idle();
  const failed = (what: string) => broken.sent.filter(one => one.method === 'editMessageText'
    && one.payload.text === `Не получилось нарисовать ${what}. Попробуй ещё раз чуть позже.`).length;
  assert.deepEqual([broken.comfy.submitted.length, failed('пример'), failed('вариант')], [5, 2, 1],
    'the scene\'s picture, the sample, the first style, the next scene\'s picture and the variant, each once');
  assert.deepEqual(broken.rows.filter(one => one.event === 'picture_sample').map(row => [row.outcome, row.pictureStyle, row.frameReused]),
    [['failed', 'film', true], ['failed', 'semi', true]]);
  assert.deepEqual(broken.rows.filter(one => one.event === 'picture_variant').map(row => [row.outcome, row.edited]), [['failed', true]]);

  // A photo Telegram already has when its picture is stopped, here by /cancel, goes out with its note, or a portrait
  // with nothing; it is not taken back, nothing else follows it, and the portrait stays there to keep.
  const h = await fixture(t, { card: {}, holdPhotos: 4 });
  const stopOnItsWay = async (count: number, label: string, noted = true) => {
    await until(() => photos(h.sent).length === count, `${label}: the photo to be on its way`);
    await h.bot.handle(h.message('/cancel'));
    const stopped = h.sent.length;
    h.release();
    await h.bot.idle();
    const photo = photos(h.sent)[count - 1];
    const after = h.sent.slice(stopped).filter(one => one.method !== 'deleteMessage');
    assert.ok(!h.deleted.includes(idOf(h.sent, photo)), `${label}: the photo stays`);
    assert.deepEqual(after.map(one => [isNote(one), one.payload.reply_parameters?.message_id]), noted ? [[true, idOf(h.sent, photo)]] : [], `${label}: its note alone follows`);
    return noted ? after[0] : photo;
  };
  await h.start();
  const note = await stopOnItsWay(1, 'the scene\'s own picture');
  await h.bot.handle(h.click(editOf(note)));
  await h.bot.handle(h.message('A synthetic prompt.'));
  await stopOnItsWay(2, 'a variant');
  await h.bot.handle(h.click('style-sample:film'));
  await stopOnItsWay(3, 'a sample');
  await h.bot.handle(h.click(`portrait:${elin(h.store.read('1').active!.storyId)}`));
  const portrait = await stopOnItsWay(4, 'a portrait', false);
  await h.bot.handle(h.click(portrait.payload.reply_markup!.inline_keyboard[0][1].callback_data));
  assert.equal(h.sent.at(-1)!.payload.text, KEPT);
  assert.deepEqual(h.rows.filter(one => /^picture(_variant|_sample|_portrait)?$/.test(one.event)).map(row => [row.event, row.outcome, row.cancelled]),
    [['picture', 'ready', true], ['picture_variant', 'ready', true], ['picture_sample', 'ready', true], ['picture_portrait', 'ready', true]]);

  // Pictures off: a reader who answers while their scene is still on its way does not cancel the turn that wrote it,
  // whose job lock is clear; it still closes its status message and starts the next compaction beside the new turn.
  const d = await fixture(t, { holdFinal: 1, compactAtTokens: 30000, usage: { inputTokens: 29000, outputTokens: 2000 } });
  await d.start();
  await until(() => d.sent.some(one => one.method === 'sendRichMessage'), 'the first scene to reach delivery');
  await d.bot.handle(d.message('Осмотреться'));
  d.release();
  await d.bot.idle();
  await d.bot.idle();
  assert.deepEqual(['scene_saved_and_sent', 'compaction_prepare_started'].map(event => d.rows.filter(row => row.event === event).length), [2, 2],
    'each turn was delivered and prepared the next compaction; neither was cancelled by the other');
});

// One sheet per story, written the first time a scene of it is illustrated and reused after. A sheet written before
// clothes left it would dress a person twice: it is written once more, keeping what the reader made of it — a look they
// wrote, a portrait they kept, and the person even when the new sheet does not name them. A person is their name, apart
// from spaces and case, and nothing else: one the model renames is somebody new.
test('the rewrite of an old sheet keeps the looks the reader wrote and the portraits they kept, under the names they had', async t => {
  const f = await fixture(t, { card: {} });
  await f.start();
  await f.bot.idle();
  const storyId = f.store.read('1').active!.storyId;
  const sheet = () => f.store.read('1').stories[storyId].sheet;
  assert.deepEqual(sheet(), SHEET.characters, 'the sheet is kept beside the story');
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  assert.deepEqual(f.requests.map(kindOf), ['scene', 'sheet', 'frame', 'scene', 'frame'], 'and reused by the next scene');

  f.store.mutate('1', state => {
    state.stories[storyId].sheet = [{ name: 'Элин', look: 'A tall woman with a long braid', edited: true },
      { name: 'Тарек', look: 'A young man with curly hair', edited: true }, { name: 'Ора', look: 'An old woman in a grey coat' }];
  });
  for (const move of ['Подождать', 'Выйти на улицу']) {
    await f.bot.handle(f.message(move));
    await f.bot.idle();
  }
  assert.deepEqual(f.requests.slice(5).map(kindOf), ['scene', 'sheet', 'frame', 'scene', 'frame'], 'an old sheet is written again once');
  assert.deepEqual(f.rows.filter(row => row.event === 'picture_sheet_written').map(row => row.sheetRewritten), [false, true]);
  assert.deepEqual(sheet(), [{ ...SHEET.characters[0], look: 'A tall woman with a long braid', edited: true },
    { name: 'Тарек', look: 'A young man with curly hair', outfit: '', edited: true }]);
  assert.match(promptOf(f.comfy.submitted[2]), /A tall woman with a long braid, wearing a grey wool coat/);
  assert.equal(photos(f.sent).length, 4);
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

// The seed dressed a person once; the story changed their clothes later, and a sheet that kept clothes never let the
// pictures follow (2026-09-24). Each frame starts from what the picture before it in its own line of the story showed.
test('clothes are carried down one line of the story and never into another', async t => {
  const dress = { ...FRAME, people: [{ ...FRAME.people[0], clothes: 'wearing a red silk dress' }] };
  const f = await fixture(t, { card: {}, frameReplies: [FRAME, dress] });
  await f.start();
  await f.bot.idle();
  for (const move of ['Переодеться', 'Выйти на улицу']) {
    await f.bot.handle(f.message(move));
    await f.bot.idle();
  }
  const frames = f.requests.filter(request => kindOf(request) === 'frame').map(request => request.messages.at(-1)!.content);
  assert.equal(frames.length, 3);
  assert.match(frames[0], /- Элин: wearing a grey wool coat\n/, 'the first frame starts from the sheet');
  assert.match(frames[1], /- Элин: wearing a grey wool coat\n/, 'the second from the first picture');
  assert.match(frames[2], /- Элин: wearing a red silk dress\n/, 'the third from the second picture, where the story changed them');
  const prompts = f.comfy.submitted.map(promptOf);
  assert.match(prompts[1], /short ash-grey hair, wearing a red silk dress, her bandaged/);
  assert.doesNotMatch(prompts[1], /grey wool coat/);
  assert.deepEqual(f.rows.filter(row => row.event === 'picture').map(row => row.clothesChanged), [0, 1, 0]);
  const state = f.store.read('1');
  assert.deepEqual(Object.values(state.stories[state.active!.storyId].nodes).map(node => node.clothes?.['Элин']),
    ['wearing a grey wool coat', 'wearing a red silk dress', 'wearing a red silk dress']);

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
  assert.deepEqual([worn.clothes, worn.changed], [{ Элин: 'wearing a red silk dress', Тарек: 'wearing a blue tunic' }, 1]);
});

// A portrait to pick a reference by: one person from their look alone, the whole figure from the front, in clothes and a
// style of the bot's own (local/image-portraits.ts), a new seed each time, and no model asked. The one shown last is held
// for its keep button alone: one replaced and one kept are let go at once, which is asked of the collector itself.
test('keeping a portrait writes the very one shown into a private file beside the database, and a newer one replaces it', async t => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const f = await fixture(t, { card: { jobMs: 60000 }, style: STYLE_LINE, users: ['1', '2'] });
  await f.start();
  await drawnOn(f, 1);
  const calls = f.requests.length;
  const storyId = f.store.read('1').active!.storyId;
  const shown = () => f.sent.at(-1)!.payload.text;
  // A portrait with `meanwhile` done while it is on the card. The test keeps a copy of the photo and lets go of the one
  // sent: past this, only the bot can hold it.
  const draw = async (meanwhile?: () => void) => {
    const job = f.comfy.submitted.length + 1;
    await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
    await until(() => f.comfy.submitted.length === job, 'the portrait to reach the card');
    meanwhile?.();
    await drawnOn(f, job);
    const photo = photos(f.sent).at(-1)!;
    const bytes = Buffer.from(photo.payload.photo);
    const picture = new WeakRef(photo.payload.photo);
    photo.payload.photo = new Uint8Array(0);
    const [[again, keep], [back]] = photo.payload.reply_markup!.inline_keyboard.map(row => row.map(button => button.callback_data));
    return { photo, bytes, picture, again, keep, back, seed: seedIn(f.comfy.submitted.at(-1)!) };
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

  const first = await draw();
  const prompt = promptOf(f.comfy.submitted[1]);
  assert.ok(prompt.startsWith('Full-length character reference, the whole body in frame, seen from the front.') && prompt.endsWith(PORTRAIT_STYLE), prompt);
  assert.ok(prompt.includes(`short ash-grey hair, ${PORTRAIT_CLOTHES}: stands upright facing the viewer, arms relaxed at the sides.`), prompt);
  assert.doesNotMatch(prompt, /Элин|grey wool coat|Synthetic test style|expression/);
  // A standing figure is drawn on the scenes' canvas turned upright.
  assert.deepEqual(f.comfy.submitted.slice(0, 2).map(graph => latentSizeOf(graph)), [{ width: 1344, height: 768 }, { width: 768, height: 1344 }]);
  // Its caption, another version, the keep button with the id it was drawn under, and the way back; no prompt follows
  // it, its status line goes, and its job is off the card.
  assert.deepEqual([first.photo.payload.caption, first.again, first.back, f.requests.length, notes(f.sent).length],
    ['🖼 Портрет: Элин. Лицо и фигура в полный рост, в простой нейтральной одежде.', `portrait:${elin(storyId)}`, `view:character:${elin(storyId)}`, calls, 1]);
  assert.match(first.keep, /^portrait-keep:[0-9a-f]{8}$/);
  assert.ok(f.deleted.includes(idOf(f.sent, f.sent.find(one => one.payload.text === '🎨 Рисую портрет…')!)) && f.comfy.seen.cleared.includes('p2'));
  const row = f.rows.find(one => one.event === 'picture_portrait')!;
  assert.deepEqual([row.outcome, row.imageSteps, row.actor], ['ready', 8, 'owner']);

  // Another version is the same prompt with another seed, and the one shown last alone is held.
  const second = await draw();
  assert.deepEqual([promptOf(f.comfy.submitted[2]), f.requests.length, second.seed !== first.seed], [prompt, calls, true]);
  assert.deepEqual([await held(first.picture), await held(second.picture)], [false, true], 'the portrait shown before is let go');
  // The button of a portrait keeps nothing once another one has been shown, and another reader has none to keep.
  await f.bot.handle(f.click(first.keep));
  assert.equal(shown(), STALE);
  await f.start(2);
  await drawnOn(f, 4);
  await f.bot.handle(f.click(second.keep, 2));
  assert.deepEqual([shown(), f.store.read('1').stories[storyId].sheet![0].portrait], [STALE, undefined]);
  await f.bot.handle(f.click(second.keep));
  assert.equal(shown(), KEPT);
  const person = f.store.read('1').stories[storyId].sheet![0];
  const portrait = person.portrait!;
  assert.match(`${portrait.file} ${portrait.graph}`, /^[0-9a-f]{32}\.png [0-9a-f]{16}$/);
  assert.deepEqual({ ...portrait, file: '', graph: '', at: 0 }, { file: '', graph: '', at: 0, seed: second.seed, look: person.look,
    clothes: PORTRAIT_CLOTHES, style: PORTRAIT_STYLE, checkpoint: 'synthetic.safetensors', width: 768, height: 1344, steps: 8, cfg: 1,
    sampler: 'er_sde', scheduler: 'simple' });

  // The very photo shown, without the prompt the card wrote into it, in a directory of this reader's beside the database
  // whose name says nothing of whose it is. Only this reader can read either, and the library only refers to it.
  const directory = f.store.portraits('1');
  assert.deepEqual([dirname(directory), f.store.portraits('2') === directory, readdirSync(directory)], [`${f.store.path}.portraits`, false, [portrait.file]]);
  assert.match(basename(directory), /^[0-9a-f]{32}$/);
  const bytes = readFileSync(join(directory, portrait.file));
  assert.deepEqual(new Uint8Array(bytes), new Uint8Array(second.bytes));
  assert.doesNotMatch(bytes.toString('latin1'), /tank top|reference/);
  assert.deepEqual([dirname(directory), directory, join(directory, portrait.file)].map(path => statSync(path).mode & 0o777), [0o700, 0o700, 0o600]);
  assert.ok(JSON.stringify(f.store.read('1')).length < 10_000);

  // A newer portrait kept in its place: its file is written first, and the old one goes once the library has moved on.
  const third = await draw();
  await f.bot.handle(f.click(third.keep));
  const replaced = f.store.read('1').stories[storyId].sheet![0].portrait!;
  assert.deepEqual([replaced.seed, readdirSync(directory)], [third.seed, [replaced.file]]);
  await f.bot.handle(f.click(third.keep));
  assert.equal(shown(), STALE);
  assert.deepEqual([await held(second.picture), await held(third.picture)], [false, false], 'a kept portrait is let go');

  // Once the look changes, a portrait shown before cannot be kept, and the kept one is marked as of the earlier look.
  const fourth = await draw();
  const drawings = f.comfy.submitted.length;
  await f.bot.handle(f.click(`look-edit:${elin(storyId)}`));
  await f.bot.handle(f.message('A tall woman with a long braid'));
  assert.match(shown(), /\n\n🖼 Сохранённый портрет нарисован по прежней внешности\./);
  await f.bot.handle(f.click(fourth.keep));
  assert.equal(shown(), STALE);
  assert.deepEqual([f.store.read('1').stories[storyId].sheet![0].portrait!.file, readdirSync(directory), f.comfy.submitted.length],
    [replaced.file, [replaced.file], drawings], 'the kept one stays, and an edit draws nothing');

  // A sheet written anew while a portrait is drawn may put somebody else where its buttons name the person: those are
  // refused and neither draw nor open that other person, while its keep button keeps it for the person it shows.
  f.store.mutate('1', state => { state.stories[storyId].sheet!.push({ name: 'Тарек', look: 'A young wiry man, curly black hair', outfit: '' }); });
  const moved = await draw(() => f.store.mutate('1', state => {
    const sheet = state.stories[storyId].sheet!;
    state.stories[storyId].sheet = [sheet[1], sheet[0]];
  }));
  assert.equal(moved.photo.payload.caption, '🖼 Портрет: Элин. Лицо и фигура в полный рост, в простой нейтральной одежде.');
  await f.bot.handle(f.click(moved.again));
  assert.equal(shown(), 'Кнопка устарела. Открой /menu.');
  await f.bot.handle(f.click(moved.back));
  assert.match(shown(), /^👤 Персонажи: /, 'the list, not the card of Тарек');
  assert.equal(f.comfy.submitted.length, drawings + 1, 'nobody was drawn for the old place');
  await f.bot.handle(f.click(moved.keep));
  assert.equal(shown(), KEPT);
  const [one, other] = f.store.read('1').stories[storyId].sheet!;
  assert.deepEqual([one.name, one.portrait, other.name, other.portrait!.look], ['Тарек', undefined, 'Элин', other.look]);
  assert.deepEqual([await held(fourth.picture), await held(moved.picture)], [false, false], 'the third one kept, and the one it replaced, are let go');
  assert.doesNotMatch(JSON.stringify(f.rows), PRIVATE);
});

// A picture goes with its scene and a portrait with its story (local/picture.ts `sendKept`): each photo and note is
// recorded as it is sent, and deleting the seed takes them all out of the chat. What is on the card then is not sent,
// and a photo on its way is taken back once it is there. A kept portrait's file goes with a write rolled back, and
// with the next sweep once nothing refers to it.
test('a portrait whose story is deleted while it is drawn is not sent, and a deleted seed takes kept ones out of the chat and off the disk', async t => {
  // What is on the card when the seed goes ends without a word; the scene's own photo and note go with the seed.
  const phases: { label: string; event: string; ask?: (f: Fixture) => Promise<unknown>; also?: Partial<Row> }[] = [
    { label: 'the scene\'s own picture', event: 'picture' },
    { label: 'every style', event: 'picture_sample', ask: f => f.bot.handle(f.click('style-samples')), also: { pictureStyle: 'semi', stylesAsked: 5 } },
    { label: 'a variant', event: 'picture_variant', ask: async f => {
      await f.bot.handle(f.click(editOf(notes(f.sent)[0])));
      await f.bot.handle(f.message('A synthetic prompt.'));
    } },
    { label: 'a portrait', event: 'picture_portrait', ask: f => f.bot.handle(f.click(`portrait:${elin(f.store.read('1').active!.storyId)}`)) },
  ];
  for (const { label, event, ask, also } of phases) {
    const f = await fixture(t, { card: { jobMs: 60000 } });
    await f.start();
    let own: number[][] = [];
    if (ask) {
      await drawnOn(f, 1);
      own = [[idOf(f.sent, photos(f.sent)[0]), idOf(f.sent, notes(f.sent)[0])]];
      await ask(f);
    }
    await until(() => f.comfy.submitted.length === (ask ? 2 : 1), `${label}: to reach the card`);
    await deleteTheSeed(f);
    f.comfy.finish();
    await f.bot.idle();
    assert.deepEqual(f.sent.filter(one => one.method === 'deleteMessages').map(one => one.payload.message_ids), own, label);
    assert.deepEqual([photos(f.sent).length, f.comfy.submitted.length], ask ? [1, 2] : [0, 1], `${label}: the card finished it, and nothing more was sent or drawn`);
    assert.ok(f.deleted.includes(idOf(f.sent, statuses(f.sent).at(-1)!)) && !f.sent.some(one => one.method === 'editMessageText'),
      `${label}: its status line goes without a word`);
    const row = f.rows.find(one => one.event === event) as Record<string, unknown>;
    const expected = { outcome: 'cancelled', code: 'scene_gone', cancelled: true, ...also };
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, row[key]])), expected, label);
  }
  // A photo Telegram has when the deletion lands has no record yet to delete by: it is taken back once it is there.
  const g = await fixture(t, { card: {}, holdPhotos: 1 });
  await g.start();
  await until(() => photos(g.sent).length === 1, 'the photo to be on its way');
  await deleteTheSeed(g);
  g.release();
  await g.bot.idle();
  assert.deepEqual([g.deleted.includes(idOf(g.sent, photos(g.sent)[0])), g.sent.some(one => one.method === 'deleteMessages'), g.store.read('1').sentPictures],
    [true, false, undefined], 'the photo on its way is taken back');
  const taken = g.rows.find(one => one.event === 'picture')!;
  assert.deepEqual([taken.outcome, taken.code, taken.picturesRemoved, taken.picturesNotRemoved], ['cancelled', 'scene_gone', 1, 0]);

  // The scene's own picture, one sample, all six styles and a kept portrait.
  const f = await fixture(t, { card: {}, style: STYLE_LINE });
  await f.start();
  await f.bot.idle();
  for (const button of ['style-sample:film', 'style-samples']) {
    await f.bot.handle(f.click(button));
    await f.bot.idle();
  }
  const { storyId, branchId } = f.store.read('1').active!;
  const nodeId = f.store.read('1').stories[storyId].branches[branchId].head!;
  await f.bot.handle(f.click(`portrait:${elin(storyId)}`));
  await f.bot.idle();
  const portrait = photos(f.sent).at(-1)!;
  const keep = portrait.payload.reply_markup!.inline_keyboard[0][1].callback_data;
  // A keep whose write is rolled back, here by a trigger that refuses it as a full disk would, takes its file with it,
  // and the same button keeps the portrait still; once a write is committed, the button has nothing left to keep.
  f.store.db.exec(`CREATE TEMP TRIGGER refuse_portrait BEFORE UPDATE ON libraries WHEN instr(NEW.payload, '"portrait":') > 0
    BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`);
  await assert.rejects(f.bot.handle(f.click(keep)), /synthetic refusal/);
  const directory = f.store.portraits('1');
  assert.deepEqual([readdirSync(directory), f.store.read('1').stories[storyId].sheet![0].portrait], [[], undefined], 'the file of the write rolled back went with it');
  f.store.db.exec('DROP TRIGGER refuse_portrait');
  await f.bot.handle(f.click(keep));
  const kept = f.store.read('1').stories[storyId].sheet![0].portrait!;
  assert.deepEqual([f.sent.at(-1)!.payload.text, kept.seed, readdirSync(directory)], [KEPT, seedIn(f.comfy.submitted.at(-1)!), [kept.file]]);
  await f.bot.handle(f.click(keep));
  assert.equal(f.sent.at(-1)!.payload.text, STALE);
  // Each photo and note recorded by its message beside its scene, and the portrait beside its story alone.
  const ids = [...photos(f.sent), ...notes(f.sent)].map(one => idOf(f.sent, one)).sort((one, other) => one - other);
  const state = f.store.read('1');
  assert.deepEqual(state.sentPictures!.map(({ at, ...picture }) => picture),
    ids.map(messageId => messageId === idOf(f.sent, portrait) ? { storyId, messageId } : { storyId, nodeId, messageId }));
  assert.ok(ids.length === 17 && state.sentPictures!.every(picture => Number.isSafeInteger(picture.at) && Math.abs(Date.now() - picture.at) < 60_000));
  await deleteTheSeed(f);
  await f.bot.idle();
  assert.deepEqual([f.sent.filter(one => one.method === 'deleteMessages').map(one => one.payload.message_ids), f.store.read('1').sentPictures, readdirSync(directory)],
    [[ids], [], []], 'every photo and note out of the chat, and the kept portrait off the disk');
  assert.deepEqual(f.rows.filter(one => one.event === 'pictures_removed'), [{ event: 'pictures_removed', picturesRemoved: 17, picturesNotRemoved: 0, actor: 'owner' }]);

  // A file whose write never came, from a process stopped between the two, goes with the next sweep after a write, and
  // at the next start; the key that names the directory is kept in the database.
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-portraits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'story.sqlite');
  let store = new Store(path);
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const mine = store.portraits('1');
  store.writePortrait('1', bytes);
  assert.deepEqual([store.sweepPortraits('1'), readdirSync(mine)], [1, []], 'after a write');
  const file = store.writePortrait('1', bytes);
  store.mutate('1', state => {
    const { story } = newStory(state, addSeed(state, seedText).id);
    story.sheet = [{ name: 'Элин', look: 'lean', outfit: '', portrait: keptOf('lean', file) }];
  });
  store.writePortrait('1', bytes);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  store.recover();
  assert.deepEqual([store.portraits('1'), readdirSync(mine), store.sweepPortraits('2')], [mine, [file], 0], 'at start; a reader with no portraits has no directory');
  const memory = new Store(':memory:');
  assert.equal(memory.sweepPortraits('1'), 0);
  assert.throws(() => memory.writePortrait('1', bytes), /database file/);
  memory.close();

  // A directory that cannot be read is not taken for one that is not there: the start and the bot log its code alone,
  // never the message, which names the path, and a deletion stands regardless.
  const u = await fixture(t);
  await u.start();
  assert.equal(u.store.sweepPortraits('1'), 0, 'a missing directory means no portraits');
  const unreadable = u.store.portraits('1');
  mkdirSync(dirname(unreadable), { recursive: true });
  writeFileSync(unreadable, '');
  assert.throws(() => u.store.sweepPortraits('1'), { code: 'ENOTDIR' });
  const rows: Row[] = [];
  u.store.recover((event, code, details) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); });
  assert.deepEqual(rows, [{ event: 'portraits_unswept', code: 'enotdir' }]);
  await deleteTheSeed(u);
  assert.deepEqual(u.store.read('1').seeds, {});
  assert.deepEqual(u.rows.filter(one => one.event === 'portraits_unswept').map(({ event, code, actor }) => ({ event, code, actor })),
    [{ event: 'portraits_unswept', code: 'enotdir', actor: 'owner' }]);
  assert.ok(!JSON.stringify([rows, u.rows]).includes(u.directory), 'no path in the log');
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

// A variant of a picture from a prompt the reader writes whole (local/picture.ts `variant`), for testing prompts against
// each other: everything but the prompt is the picture's own. `unworded` is a filled graph without its words, and
// without the key every job's preview gets (local/image-batch.ts `freshPreviews`).
const unworded = (graph: Graph) => Object.fromEntries(Object.entries(graph).map(([id, node]) => [id, { ...node,
  inputs: Object.fromEntries(Object.entries(node.inputs).filter(([key]) => key !== 'nonce').map(([key, value]) => [key, key === 'text' ? '' : value])) }]));
const samplerIn = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs as { seed: number; steps: number };

test('a variant is the reader\'s whole prompt drawn as it came, by the picture\'s own seed and settings, under its scene', async t => {
  // The language model's card, which notes every hold and every start.
  const touched: string[] = [];
  const gpu = { acquire: () => { touched.push('acquire'); return () => {}; }, assertReady: () => { touched.push('assertReady'); },
    resume: () => { touched.push('resume'); }, keepAwake: () => { touched.push('keepAwake'); return () => {}; },
    snapshot: () => ({ status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: null, canStart: false, canPause: true }) } as unknown as GpuController;
  const f = await fixture(t, { card: {}, style: STYLE_LINE, promptTokens: words, gpu });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.click('style-sample:film'));
  await f.bot.idle();
  const [own, sample] = photos(f.sent);
  const [ownNote, sampleNote] = notes(f.sent);
  const { storyId, branchId } = f.store.read('1').active!;
  const nodeId = f.store.read('1').stories[storyId].branches[branchId].head!;
  // The button is on the prompt under the scene's own photo alone, not on a photo nor under a sample, and names the scene.
  assert.deepEqual(ownNote.payload.reply_markup?.inline_keyboard,
    [[{ text: '✏️ Изменить промпт и нарисовать вариант', callback_data: `prompt-edit:${storyId}:${nodeId}` }]]);
  assert.deepEqual([own.payload.reply_markup, sampleNote.payload.reply_markup], [undefined, undefined]);
  assert.ok(!sample.payload.reply_markup?.inline_keyboard.flat().some(button => button.callback_data.startsWith('prompt-edit:')));
  const stories = JSON.stringify(f.store.read('1').stories);
  const calls = f.requests.length;
  touched.length = 0;

  // It asks for the whole prompt, style and all; the reader's next message is that prompt, and none of it is kept.
  await f.bot.handle(f.click(editOf(ownNote)));
  assert.match(f.sent.at(-1)!.payload.text, /Это весь промпт вместе со стилем/);
  assert.deepEqual(f.store.read('1').ui, { input: 'prompt', storyId, nodeId });
  const prompt = 'Элин, 48 years old, waits at the lighthouse door at dawn. <b>Charcoal</b> & ink, no colour.';
  await f.bot.handle(f.message(prompt));
  await f.bot.idle();
  assert.equal(f.store.read('1').ui, null);
  // Drawn as it came, with no style line after it and no name or age cut, by the seed, size and sampler of the photo it
  // varies; the language model is neither asked nor held for it.
  assert.equal(promptOf(f.comfy.submitted[2]), prompt);
  assert.deepEqual(unworded(f.comfy.submitted[2]), unworded(f.comfy.submitted[0]));
  assert.deepEqual([f.comfy.submitted.length, f.requests.length, touched], [3, calls, []]);

  // A photo of its own under the same scene, its prompt under it with the same button, and its status line gone. The
  // note counts what was drawn, and gives no style's share, which nobody knows.
  const scene = f.sent.find(one => one.method === 'sendRichMessage' && !isNote(one))!;
  const variant = photos(f.sent)[2];
  const note = notes(f.sent)[2];
  assert.deepEqual([variant.payload.reply_parameters?.message_id, variant.payload.caption, note.payload.reply_parameters?.message_id,
    note.payload.reply_markup?.inline_keyboard.flat().map(button => button.callback_data)], [idOf(f.sent, scene), undefined, idOf(f.sent, variant), [editOf(ownNote)]]);
  assert.ok(f.deleted.includes(idOf(f.sent, f.sent.find(one => one.payload.text === '🎨 Рисую вариант…')!)));
  const summary = htmlOf(note).match(/^<details><summary>(.*)<\/summary>/)![1];
  assert.equal(htmlOf(note), foldedPrompt(summary, prompt));
  assert.match(summary, /^🖼 Промпт: \d+ токен\S* · [\d ]+ знак\S*$/u);
  assert.deepEqual(countsOf(summary), [words(prompt), [...prompt].length]);

  // Recorded beside its scene, so that it leaves the chat with it, and varied in turn by the same scene's recipe.
  const records = f.store.read('1').sentPictures!;
  assert.ok([variant, note].every(one => records.some(picture => picture.messageId === idOf(f.sent, one) && picture.nodeId === nodeId)));
  await f.bot.handle(f.click(editOf(note)));
  await f.bot.handle(f.message('A second synthetic prompt.'));
  await f.bot.idle();
  assert.equal(promptOf(f.comfy.submitted[3]), 'A second synthetic prompt.');
  assert.deepEqual(unworded(f.comfy.submitted[3]), unworded(f.comfy.submitted[0]));

  // Nothing else changed: not the scene, the sheet or the clothes, and a sample still has the scene's own frame.
  assert.equal(JSON.stringify(f.store.read('1').stories), stories);
  await f.bot.handle(f.click('style-sample:graphic'));
  await f.bot.idle();
  assert.equal(promptOf(f.comfy.submitted[4]).slice(0, -PRESETS.graphic.length), promptOf(f.comfy.submitted[0]).slice(0, -STYLE_LINE.length));
  // Its rows are counts and one flag, never a word of the prompt.
  const rows = f.rows.filter(one => one.event === 'picture_variant');
  assert.deepEqual(rows.map(row => [row.outcome, row.edited, row.actor]), [['ready', true, 'owner'], ['ready', true, 'owner']]);
  assert.deepEqual([rows[0].promptCharacters, rows[0].pictureTokens, 'styleTokens' in rows[0], rows[0].imageSteps], [[...prompt].length, words(prompt), false, 8]);
  assert.ok(Number.isSafeInteger(rows[0].imageMs!) && rows[0].photoBytes! > 0);
  assert.doesNotMatch(JSON.stringify(f.rows), PRIVATE);
});

// A variant draws only for a scene of the presser's own library that still has its picture, while no scene is being
// written. Its wait keeps the scene alone, never the prompt, outlives a restart, and is checked again at the prompt. A
// wait for a style, a prompt or a look ends at any command, or where another wait begins, and keeps nothing.
test('a variant is drawn only for a scene of the reader\'s own that has its picture, and a wait for a prompt, a style or a look ends where it should', async t => {
  const f = await fixture(t, { card: {}, users: ['1', '2'] });
  await f.start();
  await f.bot.idle();
  const edit = editOf(notes(f.sent)[0]);
  const [, storyId, nodeId] = edit.split(':');
  const waiting = { input: 'prompt', storyId, nodeId };
  const press = (data: string, user = 1) => f.bot.handle(f.click(data, user));
  const send = (text: string) => f.bot.handle(f.message(text));
  // A scene written while the reader's pictures were off has no picture to vary.
  f.images!.users.delete('1');
  await send('Осмотреться');
  await f.bot.idle();
  f.images!.users.add('1');
  const bare = Object.keys(f.store.read('1').stories[storyId].nodes).find(id => id !== nodeId)!;
  // The bot that starts again takes the next text for the prompt.
  await press(edit);
  await f.restart();
  assert.deepEqual(f.store.read('1').ui, waiting);
  await send('A synthetic prompt after a restart.');
  await f.bot.idle();
  assert.equal(promptOf(f.comfy.submitted.at(-1)!), 'A synthetic prompt after a restart.');

  const writing = (job: boolean) => f.store.mutate('1', state => {
    state.job = job ? { id: 'j99', storyId, branchId: state.active!.branchId, head: null, memory: null, input: 'x', started: 0 } : null;
  });
  const gone = 'Вариант этой картинки уже не нарисовать: её сцена удалена.';
  const busy = 'Сцена ещё пишется. Попроси вариант, когда она придёт.';
  // What the reader does, what they are told, and whether the wait for a prompt is still open after it: a prompt that
  // cannot be drawn leaves it open for the next try.
  const refusals: [string, () => Promise<unknown>, string, boolean][] = [
    ['another reader\'s scene', () => press(edit, 2), gone, false],
    ['a scene without a picture', () => press(`prompt-edit:${storyId}:${bare}`), gone, false],
    ['a name of the prototype', () => press('prompt-edit:constructor:__proto__'), gone, false],
    ['a story alone, all a portrait\'s photo is recorded with', () => press(`prompt-edit:${storyId}`), gone, false],
    ['a button nobody made', () => press('prompt-edit:7'), gone, false],
    ['an empty prompt', async () => { await press(edit); await send('   '); },
      'Пришли промпт текстом, одним сообщением. Выйти без изменений можно кнопкой «↩️» или командой /cancel.', true],
    ['a prompt past the limit', () => send('x'.repeat(PROMPT_CHARS + 1)), 'Слишком длинно: промпт должен уложиться в 4000 знаков. Сократи и пришли снова.', true],
    ['a scene being written, at the button', async () => { writing(true); await press(edit); writing(false); }, busy, false],
    ['a scene being written, at the prompt', async () => { await press(edit); writing(true); await send('A synthetic prompt.'); writing(false); }, busy, false],
    ['a reader no longer drawn for, at their own picture\'s button', async () => { f.images!.users.delete('1'); await press(edit); f.images!.users.add('1'); },
      'Картинки к твоим сценам пока не включены, поэтому вариант нарисовать нельзя.', false],
    ['a bot started again without pictures for this reader', async () => {
      await press(edit);
      f.images!.users.delete('1');
      await f.restart();
      await send('A synthetic prompt.');
      f.images!.users.add('1');
      await f.restart();
    }, 'Картинки к твоим сценам пока не включены, поэтому вариант нарисовать нельзя.', false],
  ];
  for (const [label, act, refusal, open] of refusals) {
    const before = f.sent.length;
    await act();
    assert.ok(told(f.sent.slice(before), refusal), label);
    assert.deepEqual(f.store.read('1').ui, open ? waiting : null, label);
  }
  assert.equal(f.store.read('2').ui, null);

  const scenes = () => Object.keys(f.store.read('1').stories[storyId].nodes).length;
  for (const wait of ['style-new', edit, `look-edit:${elin(storyId)}`]) {
    await press(wait);
    await send('/charcoal');
    assert.deepEqual([f.sent.at(-1)!.payload.text, f.store.read('1').ui], [texts('ru').notices.unknownCommand, null], wait);
    const before = scenes();
    await send('Осмотреться');
    await f.bot.idle();
    assert.equal(scenes(), before + 1, `${wait}: the next message is a move in the story`);
  }
  assert.deepEqual([Object.keys(f.store.read('1').pictureStyles ?? {}), f.store.read('1').stories[storyId].sheet!.some(one => one.edited)], [[], false],
    'no style and no look was kept');
  // A look, then a prompt, then the look again, which the text is.
  await press(`look-edit:${elin(storyId)}`);
  await press(edit);
  assert.deepEqual(f.store.read('1').ui, waiting);
  await press(`look-edit:${elin(storyId)}`);
  await send('A tall woman with a long braid');
  assert.equal(f.store.read('1').stories[storyId].sheet![0].look, 'A tall woman with a long braid');

  // The scene is looked for again when the prompt arrives: here it has left the library behind the bot's back.
  await press(edit);
  f.store.mutate('1', state => { delete state.stories[storyId].nodes[nodeId]; });
  const before = f.sent.length;
  await send('A synthetic prompt.');
  await f.bot.idle();
  assert.deepEqual([told(f.sent.slice(before), gone), f.store.read('1').ui], [true, null]);
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => row.outcome), ['ready'], 'nothing refused was drawn');
  assert.ok(!f.comfy.submitted.some(graph => promptOf(graph) === 'A synthetic prompt.'));
});

// A variant is drawn by the recipe its scene's picture was drawn with, kept on the scene as long as the scene is: another
// style line or a restart changes neither its seed nor its settings, and another checkpoint or graph is refused. Its
// button names the scene by ids one sequence per library counts.
test('a scene keeps its picture\'s recipe as long as the scene is kept, and its button fits in 64 bytes however long the ids grow', async t => {
  const f = await fixture(t, { card: {}, style: STYLE_LINE });
  // This library's sequence is near the largest number it can count to.
  f.store.mutate('1', state => { state.seq = Number.MAX_SAFE_INTEGER - 100; });
  await f.start();
  await f.bot.idle();
  const own = editOf(notes(f.sent)[0]);
  assert.match(own, /^prompt-edit:h\d{16}:n\d{16}$/);
  assert.ok(Buffer.byteLength(own, 'utf8') <= 64, own);
  const [, storyId, nodeId] = own.split(':');
  // How its picture was drawn stays on the scene, and never its prompt.
  assert.deepEqual(Object.keys(f.store.read('1').stories[storyId].nodes[nodeId].picture!).sort(),
    ['cfg', 'checkpoint', 'graph', 'height', 'sampler', 'scheduler', 'seed', 'steps', 'width']);
  const vary = async (prompt: string) => { await f.bot.handle(f.click(own)); await f.bot.handle(f.message(prompt)); await f.bot.idle(); };
  // The records of the photos go after two days, when Telegram lets the bot delete them no more; the recipe stays.
  f.store.mutate('1', state => { state.sentPictures = []; });
  f.images!.style = 'Another synthetic style line.';
  await f.restart();
  await vary('A synthetic prompt two days on.');
  assert.deepEqual([promptOf(f.comfy.submitted[1]), photos(f.sent).length], ['A synthetic prompt two days on.', 2]);
  assert.deepEqual(unworded(f.comfy.submitted[1]), unworded(f.comfy.submitted[0]));
  // It is the scene's own record that is drawn by, not what the bot would draw the story with today.
  f.store.mutate('1', state => Object.assign(state.stories[storyId].nodes[nodeId].picture!, { seed: 12345, steps: 3 }));
  await vary('A synthetic prompt by the record.');
  assert.deepEqual([samplerIn(f.comfy.submitted[2]).seed, samplerIn(f.comfy.submitted[2]).steps], [12345, 3]);

  // Another checkpoint or graph, there when the button is pressed or come while the prompt is written: the reader is
  // told so, and nothing is drawn.
  const changed = 'С тех пор поменялась модель картинок или её настройки, и с прежними эту картинку уже не повторить. С новыми рисовать не буду, иначе отличался бы не только промпт.';
  f.images!.checkpoint = 'another.safetensors';
  await f.restart();
  await f.bot.handle(f.click(own));
  assert.deepEqual([told(f.sent, changed), f.store.read('1').ui], [true, null], 'another checkpoint');
  f.images!.checkpoint = 'synthetic.safetensors';
  await f.restart();
  await f.bot.handle(f.click(own));
  const graph = JSON.parse(readFileSync(f.workflow, 'utf8')) as Graph;
  graph['5'].inputs.steps = 20;
  writeFileSync(f.workflow, JSON.stringify(graph));
  await f.restart();
  const before = f.sent.length;
  await f.bot.handle(f.message('A synthetic prompt for a graph that changed meanwhile.'));
  assert.deepEqual([told(f.sent.slice(before), changed), f.comfy.submitted.length], [true, 3], 'another graph');

  // A picture drawn since has the new recipe, and its variant is drawn by it, with the story's one seed.
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.handle(f.click(editOf(notes(f.sent).at(-1)!)));
  await f.bot.handle(f.message('A synthetic prompt for the new graph.'));
  await f.bot.idle();
  const last = f.comfy.submitted.at(-1)!;
  assert.deepEqual([promptOf(last), samplerIn(last).steps, samplerIn(last).seed], ['A synthetic prompt for the new graph.', 20, samplerIn(f.comfy.submitted[0]).seed]);
  assert.deepEqual(f.rows.filter(one => one.event === 'picture_variant').map(row => row.outcome), ['ready', 'ready', 'ready']);
});

// Whatever fails on the way to a picture costs that alone, and never the scene: a card that cannot draw says so once in
// place of the status line; a description given to somebody waiting for a scene is no failure; a status line or a note
// Telegram refuses, and a tokenizer missing or failing, cost nothing else.
test('a failure on the way to a picture costs what failed, and the scene stays as it was', async t => {
  const charactersAlone = (f: Fixture, label: string) => {
    const prompt = promptOf(f.comfy.submitted[0]);
    const html = htmlOf(notes(f.sent)[0]);
    assert.ok(html.startsWith(`<details><summary>🖼 Промпт: ${String([...prompt].length).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} знак`), `${label}: ${html}`);
    const row = f.rows.find(one => one.event === 'picture')!;
    assert.deepEqual([row.promptCharacters, 'pictureTokens' in row, 'styleTokens' in row], [[...prompt].length, false, false], `${label}: characters alone`);
  };
  const cases: { label: string; options: Options; outcome: string; code?: string; drawn: number; check?: (f: Fixture, label: string) => void }[] = [
    { label: 'a card that cannot draw the frame', options: { card: { failing: true } }, outcome: 'failed', code: 'image_failed', drawn: 0, check: (f, label) => {
      // The status line is not removed but rewritten.
      const edit = f.sent.find(one => one.method === 'editMessageText')!;
      assert.deepEqual([f.deleted, edit.payload.message_id], [[], idOf(f.sent, statuses(f.sent)[0])], label);
      assert.match(edit.payload.text, /Иллюстрация не получилась/, label);
    } },
    { label: 'a description given away to somebody waiting for a scene', options: { card: {}, sheetError: 'background_preempted' }, outcome: 'skipped',
      code: 'background_preempted', drawn: 0, check: (f, label) => {
        assert.deepEqual([f.comfy.submitted.length, f.deleted], [0, [idOf(f.sent, statuses(f.sent)[0])]], `${label}: nothing on the card, and the status line goes`);
      } },
    { label: 'a status line Telegram will not take back', options: { card: {}, refuseDelete: true }, outcome: 'ready', drawn: 1 },
    { label: 'a note Telegram refuses', options: { card: {}, refuseNote: true }, outcome: 'ready', drawn: 1, check: (f, label) => {
      assert.equal(notes(f.sent).length, 1, `${label}: tried once`);
      assert.deepEqual(f.store.read('1').sentPictures!.map(picture => picture.messageId), [idOf(f.sent, photos(f.sent)[0])], `${label}: the photo is recorded`);
      assert.deepEqual(f.rows.filter(one => one.event === 'picture_prompt_unsent').map(one => one.code), [400], label);
    } },
    { label: 'no tokenizer of the picture model', options: { card: {} }, outcome: 'ready', drawn: 1, check: charactersAlone },
    { label: 'a tokenizer that fails', options: { card: {}, promptTokens: () => { throw new Error('vocabulary'); } }, outcome: 'ready', drawn: 1, check: charactersAlone },
  ];
  for (const { label, options, outcome, code, drawn, check } of cases) {
    const f = await fixture(t, options);
    await f.start();
    await f.bot.idle();
    const state = f.store.read('1');
    assert.deepEqual([state.job, Object.values(state.stories[state.active!.storyId].nodes).map(node => node.delivery)], [null, ['sent']],
      `${label}: the scene is saved and sent`);
    const row = f.rows.find(one => one.event === 'picture')!;
    assert.deepEqual([row.outcome, row.code, photos(f.sent).length], [outcome, code, drawn], label);
    assert.ok(Number.isSafeInteger(row.pictureSeconds!) && row.pictureSeconds! >= 0, label);
    if (outcome !== 'failed') assert.ok(!f.sent.some(one => one.method === 'editMessageText'), `${label}: and the reader is told nothing`);
    check?.(f, label);
  }

  // The card of the language model is paused, and Telegram will not take the status line: nothing is described or
  // drawn, and the caller is still told that the model is free, since it never took it (local/bot.ts `prepareNext`).
  const f = await fixture(t, { card: {} });
  const rows: Row[] = [];
  const sent: string[] = [];
  let freed = 0;
  const chat = { send: async () => { sent.push('send'); throw Object.assign(new Error('forbidden'), { code: 403 }); },
    edit: async () => { sent.push('edit'); }, remove: async () => { sent.push('remove'); },
    photo: async () => { sent.push('photo'); } } as unknown as Parameters<NonNullable<typeof f.illustrator>['illustrate']>[0]['chat'];
  await f.illustrator!.illustrate({ userId: '1', chat, storyId: 'h1', nodeId: 'n1', branchId: 'b1',
    sceneMessageId: 5, sceneAt: Date.now(), signal: new AbortController().signal,
    log: (event, code, details) => rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }),
    hold: () => { throw Object.assign(new Error('gpu paused'), { code: 'gpu_paused' }); },
    afterDescribe: () => { freed++; } });
  assert.deepEqual([sent, freed], [['send'], 1], 'no photo, nothing to take away, and the model freed once');
  assert.deepEqual(rows.map(row => [row.event, row.code, row.outcome]), [['picture_status_unsent', 403, undefined], ['picture', 'gpu_not_ready', 'skipped']]);
});

// The bot prepares the next compaction while the reader reads, on a turn that takes the reader's slot (local/bot.ts
// `prepareNext`). A description continues the scene cached in that slot, so it goes first; a sample asked for later is
// described in the slot that is free. On llama-server a description is counted first only near the limit, or when the
// scene's stamp names another model: what the server counted for the scene and its answer says the rest.
test('on the real queue a description keeps its reader\'s slot ahead of the compaction prepared for them, a later sample takes the slot that is free, and a description is counted first only near the limit', async t => {
  // The second scene gives the preparation something to extract; its picture used to end as `skipped` on a free card.
  const f = await fixture(t, { card: {}, scheduler: true, keepScenes: 1, compactAtTokens: 30000, usage: { inputTokens: 29000, outputTokens: 2000 } });
  await f.start();
  await f.bot.idle();
  await f.bot.handle(f.message('Осмотреться'));
  await f.bot.idle();
  await f.bot.idle();
  assert.deepEqual([f.rows.filter(row => row.event === 'picture').map(row => row.outcome), photos(f.sent).length], [['ready', 'ready'], 2]);
  assert.ok(f.rows.some(row => row.event === 'compaction_prepare_started'), 'the work ahead still runs');
  assert.ok(!f.rows.some(row => row.event === 'background_unavailable'), 'and it no longer takes the slot first');

  // After a restart nobody holds the slot the scene was cached in, and another reader's scene has taken it since.
  const g = await fixture(t, { card: {}, users: ['1', '2'], scheduler: true });
  await g.start(1);
  await g.bot.idle();
  await g.start(2);
  await g.bot.idle();
  await g.restart();
  await g.bot.handle(g.click('style-sample:graphic', 1));
  await g.bot.idle();
  const row = g.rows.find(one => one.event === 'picture_sample')!;
  assert.deepEqual([row.outcome, row.code, row.frameReused], ['ready', undefined, false], 'a sample after a restart');
  assert.equal(photos(g.sent).filter(one => one.payload.chat_id === 1 && one.payload.caption).length, 1);
  assert.ok(promptOf(g.comfy.submitted.at(-1)!).endsWith(PRESETS.graphic));

  // Nine tenths of what a description may take, 65536 less its 900 tokens of answer, is 58172. A scene that cost 57000
  // leaves room under it for the sheet's short instruction and not for the frame's long one; 58200 leaves none. The
  // threshold stays above the scene and its answer, so no compaction is prepared on the way.
  for (const { label, llama, counted, trusted } of [
    { label: 'far from the limit', llama: { inputTokens: 100, outputTokens: 50 }, counted: [], trusted: ['scene', 'sheet', 'frame'] },
    { label: 'the frame near it', llama: { inputTokens: 52000, outputTokens: 5000 }, counted: ['frame'], trusted: ['scene', 'sheet'] },
    { label: 'both near it', llama: { inputTokens: 53000, outputTokens: 5200 }, counted: ['sheet', 'frame'], trusted: ['scene'] },
    { label: 'another model\'s stamp', llama: { inputTokens: 100, outputTokens: 50, illustratorModel: 'another-model' }, counted: ['sheet', 'frame'], trusted: ['scene'] },
  ]) {
    const h = await fixture(t, { card: {}, llama, scheduler: true, compactAtTokens: 64000 });
    await h.start();
    await h.bot.idle();
    // The scene itself is far below its threshold and is never counted first.
    assert.deepEqual(h.counted, counted, label);
    assert.deepEqual(h.requests.filter(request => request.trustEstimate).map(kindOf), trusted, label);
    assert.deepEqual([h.requests.map(kindOf), h.rows.find(one => one.event === 'picture')!.outcome], [['scene', 'sheet', 'frame'], 'ready'], label);
  }
});

// Everything the bot asks for a reader is that reader's work at the gateway: their scene, the compaction prepared while
// they read and their picture's description, counts included, all go as class reader in the reader's own cache scope,
// and another reader's in another (local/serving.ts, contract section 2).
test('a reader\'s scene, the compaction prepared for them and their picture reach the gateway in that reader\'s scope', async t => {
  const f = await fixture(t, { card: {}, users: ['1', '2'], serving: true, scheduler: true, keepScenes: 1, compactAtTokens: 30000,
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

test('the picture configuration is off by default, loopback only, and never the language model\'s own card', t => {
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

  // A workflow that is not a ComfyUI API export stops the bot at startup, not under the first reader: what the Save menu
  // writes rather than Export (API); a sampler's latent with no size, drawn at one size and recorded at another; and a
  // file missing or not JSON, which reached the startup row with no code, since ENOENT is upper case and JSON's has none.
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-picture-graph-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, 'story.sqlite'));
  t.after(() => store.close());
  const provider: Provider = { generate: async () => ({ text: '', finishReason: 'stop' }) as GenerationResult };
  const sizeless = defaultWorkflow();
  delete (sizeless['4'] as { inputs: Record<string, unknown> }).inputs.width;
  const unreadable = (error: Error & { code?: string }) => error.code === 'workflow_unreadable' && /SIMPLE_CHAT_IMAGE_WORKFLOW/.test(error.message);
  for (const [file, content, refused] of [['ui.json', JSON.stringify({ nodes: [], links: [] }), /API format/],
    ['sizeless.json', JSON.stringify(sizeless), /width and a height/], ['broken.json', '{ "1": ', unreadable], ['missing.json', undefined, unreadable]] as const) {
    if (content !== undefined) writeFileSync(join(directory, file), content);
    assert.throws(() => createIllustrator({ ...config, workflow: join(directory, file) }, { store, provider }), refused, file);
  }
});

// The count under a picture, with the real vocabulary when `npm run tokenizers` has written it: the prompt and the
// tokens of each encoder's template that stay, and six more for each reference picture of the edit graph; a text of a
// characters' card alone, with no template and no picture, whatever the graph.
test('the tokens under a picture are what the pinned graph\'s encoder conditions on', { skip: !existsSync(resolve('tokenizers/qwen-2.5.json.gz'))
  && 'no tokenizers/qwen-2.5.json.gz; npm run tokenizers writes it' }, () => {
  const qwen = loadTokenizers(resolve('tokenizers')).qwen()!;
  const prompt = 'A lighthouse keeper reads by the lamp. Oil painting, warm candlelight';
  const own = qwenPromptTokens(qwen, prompt, 'qwen_image').prompt;
  for (const [file, template] of [['gpu/image-workflow-qwen.json', 8], ['gpu/image-workflow.json', 5], ['gpu/image-workflow-qwen-edit.json', 8 + 6 * 6]] as const) {
    const graph = JSON.parse(readFileSync(resolve(file), 'utf8')) as Graph;
    assert.deepEqual([encoderTokens(qwen, graph)!(prompt), textTokens(qwen, graph)!(prompt)], [own + template, own], file);
  }
  assert.deepEqual([encoderTokens(qwen, defaultWorkflow()), textTokens(qwen, defaultWorkflow())], [undefined, undefined]);
});
