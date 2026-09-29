// The POV stand (docs/telegram-ui.md#seen-through-their-eyes): the twenty synthetic scenes of examples/pov-stand.ts,
// seen through one person's eyes, each described twice on the text card and drawn once from each description, at seed 7
// and at seed 11, on the picture card, and judged blind by GPT-6 Astra.
//   node local/pov-stand.ts run --out <dir> --until <epoch seconds or ISO time> [--via socket --socket <the bot's model
//        socket> | --via direct] [--comfy http://127.0.0.1:8188]
//   node local/pov-stand.ts check --out <dir>
//   node local/pov-stand.ts bundles --out <dir>
//   node local/pov-stand.ts judge --out <dir> [--partial]
//   node local/pov-stand.ts tally --out <dir>
// `run` takes both steps at once and ends before `--until`. It describes by running each story through the bot itself
// (local/bot.ts and local/picture.ts, as a reader who drew them, with the stand's narrator and sheet and a ComfyUI on
// loopback that keeps each job's graph), so that each frame's request, POV answer, prompt, references and graph are the
// bot's; a story runs once per seed, and each run's frames are that seed's descriptions. Only the frames go to the text
// card, and never ahead of a reader, by one of two routes:
// - `--via socket` (the default): as probes of the running bot's own model queue (local/background.ts, the socket beside
//   its database, which a bot with GPU control over llama.cpp serves). Its scheduler gives them the card only in its
//   quiet window, stops them the moment a reader calls, and holds the key if there is one.
// - `--via direct`: from this process, through createModel with the configuration loadModelConfig reads from this
//   process's environment alone (no .env file is read), to a simple-serving gateway as `internal` work, which it serves
//   after readers (local/serving.ts `workOf`). A llama-server cannot tell that a reader is waiting and is refused here.
// A frame whose JSON does not parse on the second try, as a gateway's may run away into whitespace to its output limit,
// fails with `unparsed_description` as the bot's would; it is counted by code and never asked again. Each description
// is saved as it comes, and the drawing takes it at once: one job at a time, only while the picture card's queue is
// empty, and never with `front`, so the bot's own frames go first. Without a route it only draws what is described. A
// second run asks for and draws only what is missing. What this prints and logs is keys, counts, codes and times:
// never a scene, a prompt, an answer or a key.
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { LOOKS, OPENING, SHEET, STORIES } from '../examples/pov-stand.ts';
import type { Case, StandScene, StandStory } from '../examples/pov-stand.ts';
import { createBot } from './bot.ts';
import type { BotOptions, Update } from './bot.ts';
import { createIllustrator, personTag } from './picture.ts';
import { Store } from './store.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { errorCode, safeErrorDetails } from './model-error.ts';
import { PORTRAIT_CLOTHES, PORTRAIT_STYLE } from './image-portraits.ts';
import { createModel } from './model.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import { loadModelConfig } from './config.ts';
import type { ModelConfig } from './config.ts';
import { createBackgroundClient } from './background.ts';
import { drawOne, stripPngMetadata } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { codexArgs, spawnExec } from './action-judge.ts';
import { placeFile } from './picture-store.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CHECKPOINT = 'qwen_image_2.1_int8_convrot.safetensors';
const SEEDS = [7, 11];
const FRONTS = join(homedir(), 'simple-story-chat-runs/2026-09-27/refs-stand/fronts');
const FRONT_FILES = { L: 'L-PORTRAIT-s7.png', H: 'H-VN-s7.png' } as const;
const JUDGE_MODEL = 'gpt-6-astra';

type Upload = { name: string; fields: Record<string, string>; sha: string };
// One description as `run` saves it: its scene and seed, the POV answer as the model wrote it, the prompt and graph the
// bot built from it, the uploads its job made in order (a portrait before the job, its stub after), the names of the
// portraits its recipe bound, and the bot's own `pov` for it; or the code its frame failed with. `calls`: the calls to
// the text card it took, those the queue stopped included.
type Cell = { key: string; id: string; story: string; case: Case; seed: number; answer?: string; prompt?: string; graph?: Graph;
  uploads?: Upload[]; references?: string[]; pov?: boolean; code?: string; calls: number };
type Row = Record<string, unknown>;
type Note = (row: Row) => void;

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const say = (row: Row) => console.log(JSON.stringify(row));
const scenes = STORIES.flatMap(story => story.scenes.map(scene => ({ story, scene })));
const sceneOf = (id: string) => scenes.find(one => one.scene.id === id)!;
const keyOf = (id: string, seed: number) => `${id}-s${seed}`;
const keys = SEEDS.flatMap(seed => scenes.map(({ scene }) => ({ key: keyOf(scene.id, seed), id: scene.id, seed })));
const cellFile = (out: string, key: string) => join(out, 'cells', `${key}.json`);
const pictureFile = (out: string, key: string) => join(out, 'pictures', `${key}.png`);
const readCell = (out: string, key: string) => existsSync(cellFile(out, key)) ? JSON.parse(readFileSync(cellFile(out, key), 'utf8')) as Cell : undefined;
// Whole or not at all: the drawing reads what the describing writes.
function writeWhole(file: string, data: string | Uint8Array) {
  writeFileSync(`${file}.part`, data, { mode: 0o600 });
  renameSync(`${file}.part`, file);
}
// A frame is settled once drawn, or once its description failed: nothing more is asked of it.
function settled(out: string, key: string) {
  if (existsSync(pictureFile(out, key))) return true;
  const cell = readCell(out, key);
  return !!cell && !cell.graph;
}
const coded = (code: string) => Object.assign(new Error(code), { code });

// A two-by-two PNG with a text chunk: the stub the viewer keeps as a portrait, and the picture the loopback card
// answers every job with.
function stubPng(text: string) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0])),
    chunk('tEXt', Buffer.from(`prompt\0${text}`, 'latin1')), chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30, 40, 50, 60, 0, 70, 80, 90, 100, 110, 120]))),
    chunk('IEND', Buffer.alloc(0))]);
}
const promptOf = (graph: Graph) => (Object.values(graph).flatMap(node => [node.inputs.text, node.inputs.prompt])
  .filter(value => typeof value === 'string') as string[]).sort((a, b) => b.length - a.length)[0] ?? '';

// ---- describing ----

// A ComfyUI on loopback that answers every job at once and keeps its graph and the files uploaded for it.
async function loopbackCard(out: string) {
  const graphs: Graph[] = [];
  const uploads: Upload[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(part as Buffer);
      const body = Buffer.concat(parts);
      if (request.method === 'POST' && url.pathname === '/upload/image') {
        const form = await new Response(body, { headers: { 'content-type': request.headers['content-type'] ?? '' } }).formData();
        const image = form.get('image') as File;
        const bytes = Buffer.from(await image.arrayBuffer());
        const digest = sha(bytes);
        mkdirSync(join(out, 'uploads'), { recursive: true, mode: 0o700 });
        if (!existsSync(join(out, 'uploads', `${digest}.png`))) writeWhole(join(out, 'uploads', `${digest}.png`), bytes);
        uploads.push({ name: image.name, sha: digest,
          fields: Object.fromEntries([...form.entries()].filter(([key]) => key !== 'image').map(([key, value]) => [key, String(value)])) });
        return json({ name: image.name, subfolder: form.get('subfolder'), type: form.get('type') });
      }
      if (request.method === 'POST' && url.pathname === '/prompt') {
        graphs.push((JSON.parse(body.toString('utf8')) as { prompt: Graph }).prompt);
        return json({ prompt_id: `p${graphs.length}` });
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: `${id}.png`, subfolder: '', type: 'temp' }] } } } });
      }
      if (url.pathname === '/view') { response.setHeader('content-type', 'image/png'); return response.end(stubPng('x')); }
      if (url.pathname === '/system_stats') return json({ devices: [{ index: 0, vram_total: 1, vram_free: 1 }] });
      if (url.pathname === '/queue') return json({ queue_running: [], queue_pending: [] });
      if (request.method === 'POST') return json({});
      response.statusCode = 404;
      response.end();
    })();
  });
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', () => ready()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, graphs, uploads, close: () => server.close() };
}

// What the describing needs of a route: the card's model and context, once it can take a frame.
type Status = { model?: unknown; contextTokens?: unknown; provider?: unknown; gpu?: { status?: unknown } };
type Asker = { calls: number; stopped?: string; status(): Promise<Status | undefined>; ask(request: ModelRequest): Promise<GenerationResult> };
// How a route's failures are taken: `again`, ends that are the queue's and not the frame's, asked again after `againMs`;
// `own`, the frame request's own, which fail the frame as they would the bot's; `fatal`, a route that cannot work,
// which ends the describing. Any other failure is asked again 30 s later, and ten in a row end the describing.
type Codes = { again: Set<string>; againMs: number; own: Set<string>; fatal: Set<string> };
const OWN = new Set(['context_limit', 'output_limit', 'empty_response', 'unexpected_tools', 'background_invalid_request',
  'background_request_too_large']);
// A probe the bot's queue stopped for a reader, refused while the card was busy or not ready, or held past its wait is
// asked again, and the queue waits out its own quiet window. One it stopped for running over 90 s (local/scheduler.ts
// `backgroundTimeoutMs`) is the frame's own the second time.
const SOCKET: Codes = { again: new Set(['background_preempted', 'background_unavailable', 'background_timeout', 'queue_full']), againMs: 5000,
  own: OWN, fatal: new Set(['unexpected_model']) };
const RUN_LIMIT_MS = 80000;
// A gateway that is full or not ready is asked again; a key, model or contract it refuses ends the describing.
const DIRECT: Codes = { again: new Set(['rate_limited', 'model_unavailable']), againMs: 15000, own: OWN,
  fatal: new Set(['unauthorized', 'unexpected_model', 'unsupported_server']) };

// One frame, asked until it is answered or `until` is near. What is logged of an answer is its size, how it finished
// and how much blank it ends with, the mark of a JSON that ran away into whitespace.
async function persist(asker: Asker, until: number, note: Note, codes: Codes, attempt: (signal: AbortSignal) => Promise<GenerationResult>) {
  let failures = 0, overruns = 0;
  for (;;) {
    if (asker.stopped || !await asker.status()) throw coded(asker.stopped ?? 'until');
    const signal = AbortSignal.timeout(Math.max(1, until - Date.now()));
    const started = Date.now();
    asker.calls++;
    try {
      const result = await attempt(signal);
      note({ event: 'text_call', ms: Date.now() - started, input: result.usage?.inputTokens ?? null, output: result.usage?.outputTokens ?? null,
        finish: result.finishReason, blankTail: result.text.length - result.text.trimEnd().length });
      return result;
    } catch (error) {
      if (signal.aborted) throw coded(asker.stopped = 'until');
      const code = String(errorCode(error) ?? 'unknown'), ms = Date.now() - started;
      note({ event: 'text_failed', code, ms });
      if (codes.fatal.has(code)) throw coded(asker.stopped = code);
      if (code === 'background_timeout' && ms >= RUN_LIMIT_MS && ++overruns >= 2) throw error;
      if (codes.own.has(code)) throw error;
      if (codes.again.has(code)) { await delay(codes.againMs); continue; }
      if (++failures >= 10) throw coded(asker.stopped = code);
      await delay(30000);
    }
  }
}

// `--via socket`: the running bot's model queue, as a probe. A card that is pausing takes no probe (local/gpu.ts), so
// the stand waits for it to be ready again rather than ask in a loop, and a bot that does not answer is waited for too.
function botQueue(socketPath: string, until: number, note: Note): Asker {
  const client = createBackgroundClient({ socketPath, model: '', timeoutMs: 20 * 60000 });
  let waiting = '';
  const wait = async (reason: string, ms: number) => {
    if (waiting !== reason) note({ event: 'text_waiting', reason });
    waiting = reason;
    await delay(ms);
  };
  const asker: Asker = { calls: 0,
    async status() {
      while (until - Date.now() > 60000) {
        let state: Status;
        try { state = await client.status({ signal: AbortSignal.timeout(20000) }) as Status; } catch { await wait('no_bot', 30000); continue; }
        if (['draining', 'stopping', 'paused'].includes(String(state.gpu?.status))) { await wait('gpu_paused', 60000); continue; }
        waiting = '';
        // Only a bot with GPU control serves the socket, and only over llama.cpp (local/config.ts `gpuConfig`).
        return { ...state, provider: 'llama-cpp' };
      }
      asker.stopped ??= 'until';
      return undefined;
    },
    ask: request => persist(asker, until, note, SOCKET, signal => client.generate(request, { signal })) };
  return asker;
}

// `--via direct`'s configuration: what loadModelConfig reads from this process's environment, in an empty directory so
// that no .env file is read. The key comes with the environment and is never logged. Only a simple-serving gateway is
// taken: a llama-server cannot tell that a reader is waiting.
function directConfig(): ModelConfig {
  const empty = mkdtempSync(join(tmpdir(), 'pov-stand-config-'));
  let config: ModelConfig;
  try { config = loadModelConfig(empty, process.env); } finally { rmSync(empty, { recursive: true, force: true }); }
  if (config.provider === 'llama-cpp') throw new Error('direct_llama: llama-server cannot tell that a reader is waiting; describe with --via socket');
  if (config.provider !== 'simple-serving') throw new Error('gpu_config_required: point SIMPLE_CHAT_* at the card\'s simple-serving gateway');
  return config;
}

// `--via direct`: the card's provider in this process. A call names no reader, so simple-serving takes it as `internal`
// work and serves every reader's call first. The gateway is checked before the first frame and again after it was not
// ready or not reached, and while its check fails it is waited for without a frame; a check it refuses (key, model,
// contract or context) ends the describing.
function cardDirect(config: ModelConfig, until: number, note: Note): Asker {
  // simple-serving keeps no database; the path is createModel's signature only.
  const provider = createModel({ ...config, dbPath: join(tmpdir(), 'pov-stand-unused.sqlite') });
  let checked = false, waiting = '';
  const asker: Asker = { calls: 0,
    async status() {
      while (!asker.stopped && until - Date.now() > 60000) {
        if (checked) return { model: config.model, contextTokens: config.contextTokens, provider: config.provider };
        try {
          await provider.check!({ signal: AbortSignal.timeout(30000) });
          checked = true;
          waiting = '';
          note({ event: 'text_ready', contextTokens: config.contextTokens });
        } catch (error) {
          const code = String(errorCode(error) ?? 'unknown');
          if (DIRECT.fatal.has(code) || code === 'context_limit') { asker.stopped = code; note({ event: 'text_refused', code }); break; }
          if (waiting !== code) note({ event: 'text_waiting', reason: code });
          waiting = code;
          await delay(30000);
        }
      }
      asker.stopped ??= 'until';
      return undefined;
    },
    ask: request => persist(asker, until, note, DIRECT, async signal => {
      try { return await provider.generate(request, { signal, priority: 'background' }); } catch (error) {
        if (['model_unavailable', 'provider_failed', 'timeout'].includes(String(errorCode(error)))) checked = false;
        throw error;
      }
    }) };
  return asker;
}

// The story model the bot is given: the stand's sheet, retellings and narrator, the bot's queue for each frame of a
// stand scene, and the saved description of a frame described before, so that a second run replays a story as the first
// wrote it; the frame of the opening, drawn before the viewer is chosen, is answered here.
function standProvider(asker: Asker, current: () => { scene: StandScene; key: string } | undefined, saved: (key: string) => Cell | undefined,
  answers: Map<string, string>): Provider {
  const retold = (content: string) => ({ retold: [...(content.match(/Перескажи: ([^.]*)\./)?.[1] ?? '').matchAll(/\d+/g)]
    .map(([number]) => ({ person: Number(number), ...LOOKS[Number(number) - 1] })) });
  const opening = { props: 'The young woman holds a brass spyglass.', moment: 'A young woman looks down from the lighthouse window at an empty boat by the pier.',
    shot: 'Medium wide three-quarter shot', setting: 'The lamp room of a lighthouse above a small wooden pier', objects: 'An empty rowing boat with a lit lantern at its bow',
    light: 'Late summer evening, low golden light', people: [{ who: 'Мира', look: '', clothes: 'wearing a navy wool sweater', state: '', action: 'looks down from the window' }] };
  return { async generate(request: ModelRequest, controls?: GenerateControls): Promise<GenerationResult> {
    const properties = (request.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    const now = current();
    if (properties && 'characters' in properties) return { text: JSON.stringify(SHEET), finishReason: 'stop' };
    if (properties && 'retold' in properties) return { text: JSON.stringify(retold(request.messages.at(-1)?.content ?? '')), finishReason: 'stop' };
    if (properties) {
      if (!now) return { text: JSON.stringify(opening), finishReason: 'stop' };
      const kept = saved(now.key);
      if (kept?.graph && kept.answer !== undefined) return { text: kept.answer, finishReason: 'stop' };
      if (kept) throw coded(kept.code ?? 'no_picture');
      const result = await asker.ask(request);
      answers.set(now.key, result.text);
      return result;
    }
    const { time, text } = now?.scene ?? OPENING;
    await controls?.onText?.(`${time}\n\n`);
    return { text: `${time}\n\n${text}`, finishReason: 'stop', usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } };
  } };
}

// One story for one seed: every scene, with the viewer chosen after the opening, and each frame not yet saved saved.
async function describeStory(story: StandStory, seed: number, out: string, asker: Asker, model: { model: string; provider: string; contextTokens: number },
  note: Note) {
  const card = await loopbackCard(out);
  const directory = mkdtempSync(join(tmpdir(), 'pov-stand-'));
  const store = new Store(join(directory, 'story.sqlite'));
  let now: { scene: StandScene; key: string } | undefined;
  const answers = new Map<string, string>();
  const provider = standProvider(asker, () => now, key => readCell(out, key), answers);
  const rows: Row[] = [];
  const log = (event: string, code?: unknown, details?: unknown) => { rows.push({ event, ...(code === undefined ? {} : { code }), ...safeErrorDetails(details) }); };
  const illustrator = createIllustrator({ url: card.url, workflow: join(ROOT, 'gpu/image-workflow-qwen.json'), checkpoint: CHECKPOINT, style: undefined,
    users: new Set(['1']), waitMs: 60000, timeoutMs: 60000, references: true, referenceUsers: new Set() },
  { store, provider, ownerId: '1', model });
  let sent = 0;
  const api = (async () => ({ message_id: ++sent })) as BotOptions['api'];
  const bot = createBot({ store, api, provider, illustrator, allowedUsers: new Set(['1']), maxOutputTokens: 4096, render, scenePrefix, sceneKeyboard,
    model: 'pov-stand', ownerId: '1', log });
  let sequence = 0;
  const from = { id: 1, language_code: 'ru' }, chat = { id: 1, type: 'private' };
  const message = (text: string): Update => ({ update_id: ++sequence, message: { from, chat, text } as Update['message'] });
  const click = (data: string): Update => ({ update_id: ++sequence, callback_query: { id: `q${sequence}`, from, message: { chat }, data } });
  try {
    await bot.handle(click('new-seed'));
    await bot.handle(message(readFileSync(join(ROOT, 'examples/seed.txt'), 'utf8')));
    await bot.handle(click(`save-seed:${(store.read('1').ui as { draftId: string }).draftId}`));
    await bot.handle(click(`start:${Object.keys(store.read('1').seeds)[0]}`));
    await bot.idle();
    const storyId = store.read('1').active!.storyId;
    // The portraits kept on the sheet: the refs stand's fronts, and the viewer's stub, which no frame may send.
    store.mutate('1', state => {
      const saved = state.stories[storyId];
      const head = saved.nodes[saved.branches[state.active!.branchId].head!].picture!;
      for (const person of saved.sheet ?? []) {
        const kind = story.portraits[person.name];
        if (!kind) continue;
        const bytes = kind === 'stub' ? stubPng('stub portrait') : readFileSync(join(FRONTS, FRONT_FILES[kind]));
        person.portrait = { ...head, file: store.writePortrait('1', bytes), look: person.details ?? person.look, clothes: PORTRAIT_CLOTHES, style: PORTRAIT_STYLE, at: 1 };
      }
    });
    const sheet = store.read('1').stories[storyId].sheet ?? [];
    const index = sheet.findIndex(person => person.name === story.viewer);
    await bot.handle(click(`pov:${storyId}:${index}:${personTag(story.viewer)}`));
    if (store.read('1').stories[storyId].pov !== story.viewer) throw new Error('the viewer was not chosen');
    for (const scene of story.scenes) {
      const key = keyOf(scene.id, seed);
      const before = readCell(out, key);
      now = { scene, key };
      const [graphsBefore, uploadsBefore, rowsBefore, callsBefore] = [card.graphs.length, card.uploads.length, rows.length, asker.calls];
      await bot.handle(message(scene.input));
      await bot.idle();
      // A frame the queue did not answer before the end stays for the next run, and so does the rest of the story.
      if (asker.stopped) break;
      if (before) continue;
      const saved = store.read('1').stories[storyId];
      const head = saved.nodes[saved.branches[store.read('1').active!.branchId].head!];
      const row = rows.slice(rowsBefore).find(entry => entry.event === 'picture');
      const graph = card.graphs.length > graphsBefore ? card.graphs.at(-1) : undefined;
      const cell: Cell = { key, id: scene.id, story: story.id, case: scene.case, seed, answer: answers.get(key), prompt: graph && promptOf(graph), graph,
        uploads: card.uploads.slice(uploadsBefore), references: head.picture?.references?.portraits.map(portrait => portrait.name) ?? [],
        pov: typeof row?.pov === 'boolean' ? row.pov : undefined, code: graph ? undefined : String(row?.code ?? 'no_picture'), calls: asker.calls - callsBefore };
      writeWhole(cellFile(out, key), JSON.stringify(cell));
      note({ event: 'described', key, drawn: !!graph, code: cell.code, calls: cell.calls });
    }
  } finally {
    await bot.stop();
    store.close();
    card.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function describeAll(out: string, asker: Asker, note: Note) {
  const state = await asker.status();
  if (!state) { note({ event: 'describe_stopped', reason: asker.stopped }); return; }
  // The bot's model names the frames' requests as the bot's own would be named; the stand's requests carry no estimate.
  const model = { model: String(state.model), provider: String(state.provider), contextTokens: Number(state.contextTokens) || 65536 };
  for (const seed of SEEDS) {
    for (const story of STORIES) {
      if (story.scenes.every(scene => readCell(out, keyOf(scene.id, seed)))) continue;
      await describeStory(story, seed, out, asker, model, note);
      if (asker.stopped) { note({ event: 'describe_stopped', reason: asker.stopped, calls: asker.calls }); return; }
    }
  }
  note({ event: 'describe_done', calls: asker.calls });
}

// What the answers and prompts hold, as counts: the POV fields against what each scene needs.
function checks(out: string): Row {
  const stub = sha(stubPng('stub portrait'));
  const cells = keys.map(({ key }) => readCell(out, key)).filter((cell): cell is Cell => !!cell);
  const all = cells.map(cell => {
    const { story, scene } = sceneOf(cell.id);
    let answer: Record<string, unknown> = {};
    try { answer = JSON.parse(cell.answer ?? '{}') as Record<string, unknown>; } catch { /* counted as unparsed */ }
    const people = Array.isArray(answer.people) ? answer.people as { who?: unknown }[] : [];
    const who = (one: { who?: unknown }) => String(one.who ?? '').trim().toLowerCase();
    const isViewer = (one: { who?: unknown }) => who(one) === story.viewer.toLowerCase() || /^(?:the )?viewer$/.test(who(one));
    const text = (field: string) => typeof answer[field] === 'string' ? (answer[field] as string).trim() : '';
    const words = ['moment', 'props', 'objects', 'shot', 'viewer', 'reflection'].map(text).join(' ');
    const mirrored = scene.case === 'mirror' || scene.case === 'water', away = scene.case === 'cutaway';
    return { key: cell.key, answered: !!cell.answer, parsed: Object.keys(answer).length > 0, drawn: !!cell.graph,
      inScene: answer.viewer_in_scene === !away, listed: people.some(isViewer), others: people.filter(one => !isViewer(one)).length === scene.people,
      body: away ? !text('viewer') : !!text('viewer'), reflection: away ? !text('reflection') : mirrored === !!text('reflection'),
      viewerWords: /\bthe viewer\b/i.test(words), clause: away ? !cell.prompt?.includes('First-person POV') : !!cell.prompt?.startsWith('First-person POV')
        || !!cell.prompt?.includes('. First-person POV shot'),
      viewerInPrompt: /\bviewer\b/i.test(cell.prompt ?? ''), nameInPrompt: (cell.prompt ?? '').includes(story.viewer),
      references: (cell.references ?? []).join('+'), stubSent: (cell.uploads ?? []).some(upload => upload.sha === stub), pov: cell.pov,
      code: cell.code, calls: cell.calls };
  });
  const count = (field: string) => all.filter(check => (check as Row)[field] === true).length;
  return { described: all.length, of: keys.length, answered: count('answered'), parsed: count('parsed'), drawable: count('drawn'),
    calls: all.reduce((sum, check) => sum + check.calls, 0),
    failed: Object.fromEntries(all.filter(check => check.code).map(check => [check.key, check.code])),
    failedByCode: all.reduce<Record<string, number>>((counts, check) => check.code ? { ...counts, [check.code]: (counts[check.code] ?? 0) + 1 } : counts, {}),
    viewerInSceneRight: count('inScene'), viewerListedInPeople: count('listed'), othersCountRight: count('others'),
    viewerFieldRight: count('body'), reflectionFieldRight: count('reflection'), theViewerWordsInAnswer: count('viewerWords'),
    clauseRight: count('clause'), viewerWordInPrompt: count('viewerInPrompt'), viewerNameInPrompt: count('nameInPrompt'), stubSent: count('stubSent'),
    references: Object.fromEntries(all.filter(check => check.references).map(check => [check.key, check.references])),
    povRows: Object.fromEntries(all.map(check => [check.key, check.pov])),
    wrong: all.filter(check => check.drawn && !(check.inScene && !check.listed && check.others && check.body && check.reflection && !check.viewerWords && check.clause))
      .map(check => ({ key: check.key, ...Object.fromEntries(Object.entries(check).filter(([field, value]) =>
        ['inScene', 'others', 'body', 'reflection', 'clause'].includes(field) ? value === false : ['listed', 'viewerWords'].includes(field) ? value === true : false)) })) };
}

// ---- drawing ----

type Card = { get(path: string): Promise<Record<string, unknown>>; plain: typeof fetch };

// Whether the card is up and offers every node of this graph, and each loader its file: 'ready', 'down' or 'missing'.
async function offers(card: Card, graph: Graph, known: Set<string>): Promise<'ready' | 'down' | 'missing'> {
  try {
    await card.get('/system_stats');
    for (const node of Object.values(graph)) {
      const [field, file] = Object.entries(node.inputs).find(([, value]) => typeof value === 'string' && /\.(?:safetensors|gguf|pt|pth|bin)$/.test(value)) ?? [];
      const name = `${node.class_type}:${file ?? ''}`;
      if (known.has(name)) continue;
      const info = (await card.get(`/object_info/${encodeURIComponent(node.class_type)}`))[node.class_type] as { input?: { required?: Record<string, unknown[]> } } | undefined;
      if (!info) return 'missing';
      if (field && node.class_type.endsWith('Loader')) {
        const offered = info.input?.required?.[field]?.[0];
        if (!Array.isArray(offered) || !offered.includes(file)) return 'missing';
      }
      known.add(name);
    }
    return 'ready';
  } catch { return 'down'; }
}

async function drawAll(out: string, until: number, comfy: string, describing: () => boolean, note: Note) {
  // Never `front`: the bot's frames go ahead of the stand's, and a submission that carried it would jump them.
  const plain = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === `${comfy}/prompt` && init?.method === 'POST' && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if ('front' in body) { delete body.front; note({ event: 'front_removed' }); }
      init = { ...init, body: JSON.stringify(body) };
    }
    return plain(input, init);
  };
  const card: Card = { plain, async get(path) {
    const response = await plain(comfy + path, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Object.assign(new Error(`http ${response.status}`), { code: 'comfy_http', httpStatus: response.status });
    return response.json() as Promise<Record<string, unknown>>;
  } };
  const known = new Set<string>();
  const failures = new Map<string, number>();
  const left = () => keys.filter(({ key }) => !settled(out, key)).length;
  // A job not begun when the end could come before it is over: the first is given two minutes.
  let longest = 120000, drawn = 0, down = false;
  for (;;) {
    const ready = keys.map(({ key, seed }) => ({ key, seed, cell: readCell(out, key) }))
      .filter(({ key, cell }) => cell?.graph && !existsSync(pictureFile(out, key)) && (failures.get(key) ?? 0) < 2);
    if (Date.now() + longest > until) { note({ event: 'draw_stopped', reason: 'until', left: left() }); return; }
    if (!ready.length) {
      if (!describing()) break;
      await delay(3000);
      continue;
    }
    const { key, seed, cell } = ready[0];
    const graph = structuredClone(cell!.graph!);
    const state = await offers(card, graph, known);
    if (state === 'missing') { note({ event: 'missing_on_card', key }); process.exitCode = 1; return; }
    if (state === 'down') {
      if (!down) note({ event: 'card_down' });
      down = true;
      await delay(30000);
      continue;
    }
    down = false;
    // The bot's frames first: the stand waits for an empty queue before each job of its own.
    const queue = await card.get('/queue').catch(() => undefined) as { queue_running?: unknown[]; queue_pending?: unknown[] } | undefined;
    if (!queue || queue.queue_running?.length || queue.queue_pending?.length) { await delay(2000); continue; }
    const uploads = cell!.uploads ?? [];
    const first = uploads.filter((one, at) => uploads.findIndex(other => other.name === one.name) === at);
    const send = async (list: Upload[]) => {
      for (const upload of list) {
        const form = new FormData();
        form.append('image', new Blob([readFileSync(join(out, 'uploads', `${upload.sha}.png`))], { type: 'image/png' }), upload.name);
        for (const [field, value] of Object.entries(upload.fields)) form.append(field, value);
        const response = await plain(`${comfy}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw Object.assign(new Error('upload'), { code: 'upload_failed', httpStatus: response.status });
      }
    };
    for (const node of Object.values(graph)) {
      if (typeof node.inputs.seed === 'number') node.inputs.seed = seed;
      if (typeof node.inputs.noise_seed === 'number') node.inputs.noise_seed = seed;
    }
    const started = Date.now();
    try {
      await send(first);
      const result = await drawOne({ baseUrl: comfy, timeoutMs: 600000 }, graph, { waitMs: Math.max(1000, until - Date.now()) });
      // The stub the bot writes over a portrait once its job is over.
      await send(uploads.filter(one => !first.includes(one)));
      writeWhole(pictureFile(out, key), stripPngMetadata(result.bytes));
      const ms = Date.now() - started;
      longest = drawn ? Math.max(Math.min(longest, 120000), ms) : ms * 2;
      drawn++;
      note({ event: 'drawn', key, ms, references: (cell!.references ?? []).length });
    } catch (error) {
      failures.set(key, (failures.get(key) ?? 0) + 1);
      note({ event: 'draw_failed', key, code: String(errorCode(error) ?? 'unknown'), ms: Date.now() - started });
      await delay(10000);
    }
  }
  note({ event: 'draw_done', pictures: keys.filter(({ key }) => existsSync(pictureFile(out, key))).length, of: keys.length, left: left() });
}

// The stand's log, run.log in the stand directory, which it makes if need be.
function logTo(out: string): Note {
  for (const dir of [out, join(out, 'cells'), join(out, 'pictures')]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return row => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...row });
    appendFileSync(join(out, 'run.log'), line + '\n', { mode: 0o600 });
    console.log(line);
  };
}

// Both steps at once: the describing by `asker`, if there is one, and the drawing. The summary counts the frames that
// failed by code, the runaway JSON's `unparsed_description` among them.
async function run(out: string, until: number, comfy: string, note: Note, asker: Asker | undefined, via: string) {
  note({ event: 'run', until: new Date(until).toISOString(), described: keys.filter(({ key }) => readCell(out, key)).length,
    drawn: keys.filter(({ key }) => existsSync(pictureFile(out, key))).length, of: keys.length, describing: asker ? via : false });
  let describing = !!asker;
  const described = asker ? describeAll(out, asker, note)
    .catch(error => note({ event: 'describe_failed', code: String(errorCode(error) ?? 'unknown') })).finally(() => { describing = false; }) : undefined;
  await Promise.all([described, drawAll(out, until, comfy, () => describing, note)
    .catch(error => note({ event: 'draw_crashed', code: String(errorCode(error) ?? 'unknown') }))]);
  const summary = checks(out);
  writeFileSync(join(out, 'describe.json'), JSON.stringify(summary, null, 1), { mode: 0o600 });
  note({ event: 'run_done', described: summary.described, drawable: summary.drawable, failedByCode: summary.failedByCode,
    calls: summary.calls, drawn: keys.filter(({ key }) => existsSync(pictureFile(out, key))).length, of: keys.length });
}

// ---- judging ----

const INTRO = (count: number) => `You are judging ${count} illustrations for an interactive story, attached as images and also in the working directory as p01.png, p02.png and so on. Most are meant to be first-person frames: what one person of the story, the viewer, sees with their own eyes from where they are, so that of the viewer only what they could see of themselves may appear (hands, arms, knees, legs, feet, chest or belly cut off by the edge of the frame, and their reflection in a mirror or in water), never the viewer seen from outside. A few are meant to be ordinary pictures of a scene without the viewer.`;
const QUESTIONS = `Look at every picture closely and answer for each, strictly by what is drawn:
- wholeViewer: "yes" if the viewer is drawn as a person seen from outside, whole or in part (a figure, a head, a back or a shoulder seen from behind), anywhere except as their reflection; "no" otherwise; "na" for a picture meant to show a scene without the viewer.
- firstPerson: "yes" if the picture is seen from the eyes of someone in the scene; "no" if from a camera outside it; "na" for a picture meant to show a scene without the viewer.
- bodyPlausible: "yes" if the parts of the viewer's own body that are visible are plausible from where the eyes are: they enter from the edges of the frame in the right perspective, attach where the viewer's body would be, and have the right number and anatomy; "no" if not; "na" if none is visible.
- people: how many people are in the picture, as a number: people seen from outside, not counting the viewer's own body seen from their eyes and not counting reflections.
- reflection: for a picture meant to show a reflection, "yes" if it is there and right: in the mirror or the water where it should be, of one person as described, facing and posed as the viewer would be, with no second copy of that person outside it; "no" otherwise; "na" when no reflection is meant.
- cutaway: for a picture meant to show a scene without the viewer, "yes" if it shows that scene as described and none of the viewer; "no" otherwise; "na" for any other picture.
- note: one short sentence on what the picture actually shows.

Answer with only a JSON array, one object per picture in the order p01, p02 and so on, each {"picture": "p01", "wholeViewer": "...", "firstPerson": "...", "bodyPlausible": "...", "people": 0, "reflection": "...", "cutaway": "...", "note": "..."}.`;

type Keys = Record<string, Record<string, { id: string; seed: number }>>;
const bundleNames = SEEDS.map(seed => `s${seed}`);
function taskOf(entries: [string, { id: string }][]) {
  return `${INTRO(entries.length)}\n\nWhat each picture is meant to show:\n${entries.map(([name, { id }]) => `- ${name}.png: ${sceneOf(id).scene.intent}`).join('\n')}\n\n${QUESTIONS}`;
}

// One bundle per seed, its twenty pictures in a fixed shuffled order; the key stays outside the bundles.
function bundles(out: string) {
  const all: Keys = {};
  SEEDS.forEach((seed, at) => {
    let state = 20260928 + at;
    const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const order = scenes.map(({ scene }) => ({ id: scene.id, at: random() })).sort((a, b) => a.at - b.at);
    const name = bundleNames[at];
    all[name] = Object.fromEntries(order.map((one, rank) => [`p${String(rank + 1).padStart(2, '0')}`, { id: one.id, seed }]));
    const dir = join(out, 'judge', name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'task.md'), taskOf(Object.entries(all[name])), { mode: 0o600 });
  });
  writeFileSync(join(out, 'judge', 'keys.json'), JSON.stringify(all, null, 1), { mode: 0o600 });
  say({ event: 'bundles', bundles: bundleNames.map(name => `${name}: ${Object.keys(all[name]).length} pictures`) });
}

// Each bundle whose frames are all settled, drawn or failed, in one fresh session; `--partial` judges what is drawn.
async function judge(out: string, partial: boolean) {
  const all = JSON.parse(readFileSync(join(out, 'judge', 'keys.json'), 'utf8')) as Keys;
  await Promise.all(bundleNames.map(async name => {
    const dir = join(out, 'judge', name);
    const entries = Object.entries(all[name]);
    const present = entries.filter(([, { id, seed }]) => existsSync(pictureFile(out, keyOf(id, seed))));
    const open = entries.filter(([, { id, seed }]) => !settled(out, keyOf(id, seed))).length;
    if (!present.length || (!partial && open)) {
      say({ event: 'bundle_waiting', bundle: name, pictures: present.length, open, of: entries.length });
      return;
    }
    // A link to the picture store's file (local/picture-store.ts): a bundle costs no disk.
    for (const [picture, { id, seed }] of present) placeFile(pictureFile(out, keyOf(id, seed)), join(dir, `${picture}.png`));
    const task = taskOf(present);
    writeFileSync(join(dir, 'task.md'), task, { mode: 0o600 });
    // The session runs in a copy of the bundle away from the stand, so that no key, prompt or answer lies near it.
    const copy = mkdtempSync(join(tmpdir(), 'pov-judge-'));
    for (const [picture] of present) placeFile(join(dir, `${picture}.png`), join(copy, `${picture}.png`));
    writeFileSync(join(copy, 'task.md'), task, { mode: 0o600 });
    const report = join(out, 'judge', `${name}.report.json`);
    const started = Date.now();
    const exit = await spawnExec('codex', codexArgs({ model: JUDGE_MODEL, dir: copy, report: join(copy, 'report.json'),
      images: present.map(([picture]) => join(copy, `${picture}.png`)), prompt: task }),
    { cwd: copy, env: process.env, stdout: join(out, 'judge', `${name}.events.jsonl`), stderr: join(out, 'judge', `${name}.stderr.txt`), signal: AbortSignal.timeout(40 * 60000) });
    if (existsSync(join(copy, 'report.json'))) copyFileSync(join(copy, 'report.json'), report);
    rmSync(copy, { recursive: true, force: true });
    say({ event: 'judged', bundle: name, pictures: present.length, exit, seconds: Math.round((Date.now() - started) / 1000), report: existsSync(report) });
  }));
}

function tally(out: string) {
  const all = JSON.parse(readFileSync(join(out, 'judge', 'keys.json'), 'utf8')) as Keys;
  const verdicts: (Record<string, unknown> & { id: string; seed: number })[] = [];
  for (const name of bundleNames) {
    const file = join(out, 'judge', `${name}.report.json`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const answers = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as Record<string, unknown>[];
    for (const answer of answers) { const key = all[name][String(answer.picture)]; if (key) verdicts.push({ ...answer, ...key }); }
  }
  const is = (value: unknown, wanted: string) => String(value).toLowerCase() === wanted;
  const cases = [...new Set(scenes.map(({ scene }) => scene.case))];
  for (const group of [...cases, 'all'] as const) {
    const mine = verdicts.filter(one => group === 'all' || sceneOf(one.id).scene.case === group);
    const pov = mine.filter(one => sceneOf(one.id).scene.case !== 'cutaway');
    const shown = mine.filter(one => !is(one.bodyPlausible, 'na'));
    const mirrored = mine.filter(one => ['mirror', 'water'].includes(sceneOf(one.id).scene.case));
    const away = mine.filter(one => sceneOf(one.id).scene.case === 'cutaway');
    say({ case: group, pictures: mine.length, wholeViewerFail: pov.filter(one => is(one.wholeViewer, 'yes')).length, of: pov.length,
      firstPerson: pov.filter(one => is(one.firstPerson, 'yes')).length, bodyPlausible: `${shown.filter(one => is(one.bodyPlausible, 'yes')).length}/${shown.length}`,
      peopleRight: mine.filter(one => Number(one.people) === sceneOf(one.id).scene.people).length,
      ...(mirrored.length ? { reflectionRight: `${mirrored.filter(one => is(one.reflection, 'yes')).length}/${mirrored.length}` } : {}),
      ...(away.length ? { cutawayRight: `${away.filter(one => is(one.cutaway, 'yes')).length}/${away.length}` } : {}) });
  }
  say({ wholeViewer: verdicts.filter(one => sceneOf(one.id).scene.case !== 'cutaway' && is(one.wholeViewer, 'yes')).map(one => keyOf(one.id, one.seed)).sort() });
}

// ---- the command ----

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string' }, until: { type: 'string' }, via: { type: 'string', default: 'socket' }, socket: { type: 'string' },
  comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, partial: { type: 'boolean', default: false },
} });
if (!values.out) throw new Error('Name the stand directory with --out');
const out = resolve(values.out);
const time = (value: string) => /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value);
const command = positionals[0];
if (command === 'run') {
  if (!values.until || !Number.isFinite(time(values.until))) throw new Error('Name the end with --until, in epoch seconds or as an ISO time');
  if (values.via !== 'socket' && values.via !== 'direct') throw new Error('Use --via socket (with --socket) or --via direct');
  if (values.via === 'direct' && values.socket) throw new Error('--socket is the socket route\'s: leave it out with --via direct');
  const until = time(values.until);
  // The direct route's configuration is read, and refused, before anything is logged; without a route, only drawing.
  const config = values.via === 'direct' ? directConfig() : undefined;
  const note = logTo(out);
  const asker = config ? cardDirect(config, until, note) : values.socket ? botQueue(resolve(values.socket), until, note) : undefined;
  await run(out, until, values.comfy.replace(/\/$/, ''), note, asker, values.via);
} else if (command === 'check') say(checks(out));
else if (command === 'bundles') bundles(out);
else if (command === 'judge') await judge(out, values.partial);
else if (command === 'tally') tally(out);
else throw new Error('Use run, check, bundles, judge or tally');
