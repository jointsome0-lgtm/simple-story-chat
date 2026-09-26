// The pilot of the picture run's speed (docs/action-experiment.md#pilot): a fixed handful of round one's clean cells,
// drawn again on the picture card from round one's own plans, portraits and views, into illustrations/pilot, before
// round two is drawn. It asks what the stage's one socket buys (local/image-batch.ts `stageSocket`), whether the card
// draws the same inputs to the same picture, and what comfy-kitchen's Triton backend changes. Its cells are flight's at
// seed 7, flight binding four people, the most round two binds: one of each kind of picture the run draws, a front,
// a view, a frame without references (A), C with four portraits, V with views among them, and T with L's picture and
// four portraits. Each pass is drawn as a stage draws (local/action-draw.ts `drawPilot`) into a directory of its own,
// with round one's portraits, views and L as its references.
//   draw      on the server as round one ran it. The determinism check: C, then A, then C again, whose picture should
//             be the first's, with neither C's sampler answered from the server's cache; then the timed cells, the
//             front, the view, A, V and T: the baseline, a socket a picture and a read of the log before each, as
//             round one drew; the same on one socket, as round two draws; and the baseline again, which brackets
//             whatever drifts on the card
//   triton    once the server is started again with SIMPLE_CHAT_IMAGE_TRITON=1: what its log says of the backends,
//             then the timed cells twice on one socket, the first pass with whatever Triton compiles
//   report    what the passes measured, in numbers
//   dry-run   all of it against local/fake-comfy.ts, from a made-up round one
// It draws no sharp story and reads nothing under sealed/. What it prints and keeps is ids, codes, counts, times,
// hashes and pixel differences, never a prompt or a word of a story.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inflateSync } from 'node:zlib';
import { ACTION_SEEDS, MARKER_STORY } from '../examples/action-set.ts';
import { apiGraph, comfyUrl, encoderResolution, logLines, serverPins } from './image-batch.ts';
import type { Comfy, Graph, Phases } from './image-batch.ts';
import { cardOf, pinsOf, writeCardRecord } from './image-identity.ts';
import { safeErrorDetails } from './model-error.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { isSharp, readJson, storyDir, textStories } from './action-text.ts';
import type { StoryText } from './action-text.ts';
import { planAll } from './action-prompts.ts';
import type { StoryPlan } from './action-prompts.ts';
import { ACTION_GRAPH, DRAW_CODES, FRAME_CANVAS, FRONT_GRAPH, SCALED, VIEW_CANVAS, drawPilot, drawStage, frameKey, planCells } from './action-draw.ts';
import type { ActionCell, CellRecord, DrawIndex } from './action-draw.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const SOURCE_DIR = join(ROOT, 'illustrations', 'action-1');
export const PILOT_DIR = join(ROOT, 'illustrations', 'pilot');
// Round two's directory, which the pilot never writes into.
const RUN_DIR = join(ROOT, 'illustrations', 'action');
export const PILOT_STORY = 'flight';
export const PILOT_SEED = ACTION_SEEDS[0];
// The pilot's cells go under keys of their own: round one's cells keep theirs in a pass's index, as its references.
const PREFIX = 'pilot:';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const graphOf = (file: string): Graph => apiGraph(JSON.parse(readFileSync(file, 'utf8')));
const print = (value: object) => console.log(JSON.stringify(value));

// ---- The passes ----

export type PassName = 'determinism-x1' | 'determinism-y' | 'determinism-x2' | 'baseline' | 'one-socket' | 'baseline-again'
  | 'triton-cold' | 'triton-warm';
// `cells`: what a pass draws, by the cells' labels; `earlier`: the pass whose pictures its own are compared with.
type PassPlan = { name: PassName; oneSocket: boolean; cells: string[]; earlier?: PassName };
const TIMED = ['front', 'view', 'A', 'V', 'T'];
export const PASSES: Record<'draw' | 'triton', PassPlan[]> = {
  draw: [{ name: 'determinism-x1', oneSocket: true, cells: ['C'] }, { name: 'determinism-y', oneSocket: true, cells: ['A'] },
    { name: 'determinism-x2', oneSocket: true, cells: ['C'] }, { name: 'baseline', oneSocket: false, cells: TIMED },
    { name: 'one-socket', oneSocket: true, cells: TIMED }, { name: 'baseline-again', oneSocket: false, cells: TIMED }],
  triton: [{ name: 'triton-cold', oneSocket: true, cells: TIMED }, { name: 'triton-warm', oneSocket: true, cells: TIMED, earlier: 'triton-cold' }],
};
// A pass that has not finished is drawn again whole, into a new directory: a pass is a measurement, and half of one
// resumed on a later server is not one. After this many attempts somebody looks first.
const ATTEMPTS = 3;

// Two pictures compared: their bytes, then their pixels, as many as differ in any channel, the largest and the mean
// difference of a channel, and the PSNR in dB when any differs. `comparable: false` for two that cannot be decoded
// here or differ in size.
export type Diff = { bytesSame: boolean; pixelsSame?: boolean; comparable?: false; differing?: number; share?: number; maxDelta?: number;
  meanDelta?: number; psnr?: number };
// A cell of a pass: its times (`cycleMs` from the end of the cell before, or from the pass's start, to the end of this
// one, the log's reads included; the rest local/action-draw.ts's own), whether the server answered its sampler from
// its cache, the peaks of video memory (as nvidia-smi sees it, and in use) and RAM in MiB, and its picture against the
// baseline's, round one's and the earlier pass's. `unsent`: a cell that never reached the card.
export type PilotCell = { cell: string; key: string; status: CellRecord['status'] | 'unsent'; code?: string; references: number;
  cycleMs?: number; totalMs?: number; viewMs?: number; uploadMs?: number; outageMs?: number; phases?: Phases; loaderCacheMiss?: boolean;
  samplerCached?: boolean; partialModelLoadEvents?: number; file?: string; sha256?: string; vramMiB?: number; vramUsedMiB?: number; ramMiB?: number;
  vsBaseline?: Diff; vsRoundOne?: Diff; vsEarlier?: Diff };
export type PassRecord = { name: PassName; attempt: number; dir: string; oneSocket: boolean; triton: boolean; startedAt: string; completedAt: string;
  ended: 'done' | 'until' | 'stopped'; error?: string; wallMs: number; cells: PilotCell[] };
// What the server's log said of comfy-kitchen's backends right after its start (comfy/quant_ops.py:34-45 at the pinned
// revision): the Triton backend asked for on the command line (`argv`), triton imported or not, each backend available
// and disabled, and the warning that the CUDA backend needs torch built for CUDA 13. `seen`: the lines were still in
// the log's ring. Which backend ran a given layer the server logs at DEBUG alone (comfy_kitchen.dispatch), never in
// this log: `dispatchVisible` is always false, and the pictures and the sampler's seconds are the evidence of use.
export type Kitchen = { seen: boolean; argv: boolean; tritonImported: boolean; tritonImportFailed: boolean; cudaNeedsCu130: boolean;
  backends: Record<string, { available: boolean; disabled: boolean }>; dispatchVisible: false };
export type Determinism = { verdict: 'same' | 'different' | 'inconclusive'; x1SamplerCached: boolean | null; ySamplerCached: boolean | null;
  x2SamplerCached: boolean | null; diff: Diff };
export type PilotRecord = { story: string; seed: number; source: string; pins?: Record<string, string | number>; differsFromRoundOne?: string[];
  kitchen?: Partial<Record<'draw' | 'triton', Kitchen>>; passes: PassRecord[]; determinism?: Determinism };

// A pass is finished when it drew every cell and none of them waited for the network (`outageMs`): its times would
// hold the wait, and a pass on one socket rides out a drop that fails the baseline's.
const finished = (pass: PassRecord) => pass.ended === 'done' && pass.cells.length > 0 && pass.cells.every(cell => cell.status === 'drawn' && !cell.outageMs);
const lastFinished = (record: PilotRecord, name: PassName) => record.passes.findLast(pass => pass.name === name && finished(pass));

// ---- Round one ----

// The pilot's cells from flight's plan: its first front, its first view, and A, C, V and T at seed 7.
export function pilotCells(plan: StoryPlan): ActionCell[] {
  const { fronts, views, frames } = planCells([plan]);
  const arms = frames(PILOT_SEED);
  const picked = [fronts[0], views[0], ...(['A', 'C', 'V', 'T'] as const).map(arm => arms.find(cell => cell.arm === arm))];
  const cells = picked.filter(cell => cell !== undefined);
  if (cells.length !== picked.length) throw new Refusal(`${plan.id}'s plan has no front, no view, or not each of A, C, V and T: the pilot draws one of each`);
  return cells.map(cell => ({ ...cell, key: PREFIX + cell.key }));
}
const natural = (cell: ActionCell) => cell.key.slice(PREFIX.length);
const labelOf = (cell: ActionCell) => (cell.kind === 'frame' ? cell.arm! : cell.kind);
// A reference's key in round one's index, found as local/action-draw.ts `referencesOf` finds it.
const referenceKey = (plan: StoryPlan, cell: ActionCell, ref: string) => ref === 'L' ? frameKey(cell.story, cell.seed, 'L')
  : plan.views.some(view => view.id === ref) ? `view:${ref}` : `front:${ref}`;

type Source = { root: string; plan: StoryPlan; planHash: string; cells: ActionCell[]; roundOne: Record<string, CellRecord>; references: string[];
  pins: Record<string, string | number> };
// Round one as the pilot draws from it: flight's plan, and round one's record of each of the pilot's cells and of each
// reference, drawn, under clean/, and the very file it drew. The plan must be the one round one drew from: each
// prompt as long as round one's and as many references, since the hash round one pinned covers every plan, sealed
// ones too, which the pilot does not read.
function readSource(root: string): Source {
  if (isSharp(PILOT_STORY) || PILOT_STORY === MARKER_STORY.id) throw new Refusal('The pilot draws clean cells alone');
  const index = readJson<DrawIndex>(join(root, 'draw.json'));
  const planFile = join(storyDir(root, PILOT_STORY), 'plan.json');
  const plan = readJson<StoryPlan>(planFile);
  if (!index || !plan) throw new Refusal(`The pilot draws round one's cells from ${root} (--from), whose draw.json or ${PILOT_STORY}'s plan.json is not there`);
  const cells = pilotCells(plan);
  const references = [...new Set(cells.flatMap(cell => cell.refs.map(ref => referenceKey(plan, cell, ref))))];
  const clean = join(root, 'clean') + sep;
  const roundOne: Record<string, CellRecord> = {};
  for (const key of [...cells.map(natural), ...references]) {
    const one = index.cells[key];
    const path = one?.file === undefined ? '' : resolve(root, one.file);
    if (!one || one.status !== 'drawn' || !path.startsWith(clean) || !existsSync(path) || sha256(readFileSync(path)) !== one.sha256) {
      throw new Refusal(`Round one's ${key} is not drawn in ${root}, or its file is not the one it drew: the pilot draws from round one's own pictures`);
    }
    roundOne[key] = one;
  }
  if (!cells.every(cell => roundOne[natural(cell)].promptChars === cell.prompt.length && roundOne[natural(cell)].references === cell.refs.length)) {
    throw new Refusal(`${PILOT_STORY}'s plan.json in ${root} is not the one round one drew from`);
  }
  return { root, plan, planHash: sha256(readFileSync(planFile)), cells, roundOne, references, pins: index.pins };
}

// The pins round one's draw.json has that the pilot's cells depend on, as local/action-draw.ts computes them, and the
// hash of flight's plan; the server's own join them (image-batch.ts `serverPins`), Triton's included when it is on.
function ownPins(card: ReturnType<typeof cardOf>, source: Source): Record<string, string | number> {
  const base = graphOf(ACTION_GRAPH);
  const cache = Object.values(base).find(node => node.class_type === 'QwenImage21Cache');
  return { ...pinsOf(card), actionGraph: sha256(readFileSync(ACTION_GRAPH)), cacheDevice: String(cache?.inputs.device ?? 'none'),
    resolution: encoderResolution(base) ?? -1, canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`,
    viewCanvas: `${VIEW_CANVAS.width}x${VIEW_CANVAS.height}`, referenceSize: `${SCALED.width}x${SCALED.height}`, plan: source.planHash };
}

// ---- Pictures compared ----

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
// The pixels of an 8-bit PNG that is not interlaced, grey or colour, with or without alpha: what ComfyUI's saving node
// and the fake write. Anything else is `undefined`.
export function decodePng(bytes: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let width = 0, height = 0, depth = 0, colour = -1, interlace = 0;
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = bytes[at + 16];
      colour = bytes[at + 17];
      interlace = bytes[at + 20];
    } else if (type === 'IDAT') parts.push(bytes.subarray(at + 8, at + 8 + length));
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = CHANNELS[colour];
  if (depth !== 8 || !channels || interlace !== 0 || !width || !height) return undefined;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(parts)); } catch { return undefined; }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return undefined;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride), prior = y ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0, b = prior ? prior[x] : 0, c = prior && x >= channels ? prior[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return undefined;
      out[x] = value & 255;
    }
  }
  return { width, height, channels, pixels };
}
export function pictureDiff(one: Uint8Array, other: Uint8Array): Diff {
  if (sha256(one) === sha256(other)) return { bytesSame: true, pixelsSame: true, differing: 0, maxDelta: 0 };
  const a = decodePng(one), b = decodePng(other);
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return { bytesSame: false, comparable: false };
  let differing = 0, max = 0, total = 0, squares = 0;
  const count = a.width * a.height, channels = a.channels;
  for (let pixel = 0; pixel < count; pixel++) {
    let differs = false;
    for (let k = pixel * channels; k < (pixel + 1) * channels; k++) {
      const delta = Math.abs(a.pixels[k] - b.pixels[k]);
      if (!delta) continue;
      differs = true;
      max = Math.max(max, delta);
      total += delta;
      squares += delta * delta;
    }
    if (differs) differing++;
  }
  const samples = count * channels;
  return { bytesSame: false, pixelsSame: differing === 0, differing, share: Number((differing / count).toFixed(6)), maxDelta: max,
    meanDelta: Number((total / samples).toFixed(4)), ...(squares ? { psnr: Number((10 * Math.log10(255 * 255 * samples / squares)).toFixed(2)) } : {}) };
}

// ---- The server's log ----

// comfy-kitchen's lines of the server's start, matched and never kept: a line of the log can carry a prompt.
export function kitchenOf(lines: string[] | undefined, argv: boolean): Kitchen {
  const messages = (lines ?? []).map(line => line.slice(line.indexOf('\u0000') + 1));
  const backends: Kitchen['backends'] = {};
  for (const message of messages) {
    const found = /Found comfy_kitchen backend ([a-z][a-z0-9_]{0,19}): \{(.*)\}/.exec(message);
    if (found) backends[found[1]] = { available: /'available': True\b/.test(found[2]), disabled: /'disabled': True\b/.test(found[2]) };
  }
  const any = (pattern: RegExp) => messages.some(message => pattern.test(message));
  return { seen: Object.keys(backends).length > 0, argv, tritonImported: any(/Found triton \S+\. Enabling comfy-kitchen triton backend/),
    tritonImportFailed: any(/Failed to import triton/), cudaNeedsCu130: any(/pytorch with cu130 or higher/), backends, dispatchVisible: false };
}

// ---- The command ----

export type PilotOptions = { dir: string; source: string; comfy: string; until: number; waitMs?: number; timeoutMs?: number; pollMs?: number;
  outage?: { windowMs?: number; pauseMs?: number }; log?: (event: object) => void };

// The pilot's directory is its own: not round one's or inside it, not round two's, and no run's.
function guard(dir: string, source: string) {
  const within = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
  if (within(dir, source) || within(source, dir) || within(dir, RUN_DIR)) {
    throw new Refusal('The pilot draws into a directory of its own (--dir), outside round one\'s (--from) and round two\'s illustrations/action');
  }
  for (const name of ['prompts.json', 'texts.json', 'draw.json', 'sealed']) {
    if (existsSync(join(dir, name))) throw new Refusal(`${dir} holds ${name}: it is a run's directory, not the pilot's`);
  }
}

export async function pilotCommand(command: 'draw' | 'triton', options: PilotOptions) {
  const dir = resolve(options.dir), from = resolve(options.source);
  guard(dir, from);
  const source = readSource(from);
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(dir, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${dir} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says`); }
  const log = options.log ?? (() => undefined);
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: AbortSignal.timeout(Math.max(0, options.until - Date.now())) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal('The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card), or the end (--until) came first; nothing is drawn');
  });
  const pins = { ...ownPins(card, source), ...server };
  const { triton, ...plain } = pins;
  const file = join(dir, 'pilot.json');
  const record: PilotRecord = readJson<PilotRecord>(file) ?? { story: PILOT_STORY, seed: PILOT_SEED, source: relative(dir, from), passes: [] };
  if (record.source !== relative(dir, from)) throw new Refusal(`${file} was drawn from another round one than ${from}`);
  // One card and one server for the whole pilot, Triton aside: a pass on another would be compared with none of these.
  const known = record.pins;
  const changed = known && [...new Set([...Object.keys(plain), ...Object.keys(known)])].find(key => known[key] !== plain[key]);
  if (changed) throw new Refusal(`${file} was drawn under another ${changed}: one pilot directory holds one card and one server`);
  if (command === 'draw' && triton !== undefined) {
    throw new Refusal('draw measures the server as round one ran it: start it again without SIMPLE_CHAT_IMAGE_TRITON (docs/action-experiment.md#pilot)');
  }
  if (command === 'triton' && triton !== 'enabled') {
    throw new Refusal('triton needs the server started again with SIMPLE_CHAT_IMAGE_TRITON=1 (docs/action-experiment.md#pilot)');
  }
  if (command === 'triton' && !lastFinished(record, 'baseline')) throw new Refusal('triton is compared with the baseline: run draw to its end first');
  record.pins = plain;
  record.differsFromRoundOne = Object.keys(plain).filter(key => key in source.pins && source.pins[key] !== plain[key]);
  mkdirSync(join(dir, 'passes'), { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, record);
  // The log's word on the backends, read before anything is drawn, while the lines of the server's start are still in
  // its ring; a later read that no longer finds them keeps the earlier one. A server started with the flag whose log
  // says Triton did not load would draw the eager path again, and is refused before it draws.
  const kitchen = kitchenOf(await logLines(comfy), triton === 'enabled');
  if (kitchen.seen || !record.kitchen?.[command]?.seen) (record.kitchen ??= {})[command] = kitchen;
  save();
  const backend = kitchen.backends.triton;
  if (command === 'triton' && kitchen.seen && (kitchen.tritonImportFailed || !backend?.available || backend.disabled)) {
    throw new Refusal('The server\'s log says comfy-kitchen\'s Triton backend did not load at its start: triton would draw the eager path again');
  }
  const samplers = (graph: Graph) => Object.keys(graph).filter(id => /Sampler/.test(graph[id].class_type));
  const context: PassContext = { dir, source, card, pins, comfy: options.comfy, until: options.until, options, log, record,
    samplers: { front: samplers(graphOf(FRONT_GRAPH)), frame: samplers(graphOf(ACTION_GRAPH)) } };
  let stopped: PassName | undefined;
  for (const plan of PASSES[command]) {
    if (lastFinished(record, plan.name)) continue;
    let attempt = record.passes.filter(pass => pass.name === plan.name).length + 1;
    while (existsSync(join(dir, 'passes', `${plan.name}-${attempt}`))) attempt++;
    if (attempt > ATTEMPTS) throw new Refusal(`${plan.name} has not finished in ${attempt - 1} attempts: look at their draw.json before the card draws it again`);
    const pass = await drawPass(context, plan, attempt);
    record.passes.push(pass);
    save();
    const waited = pass.cells.filter(cell => cell.outageMs).length;
    log({ event: 'pass', name: pass.name, attempt, ended: pass.ended, drawn: pass.cells.filter(cell => cell.status === 'drawn').length,
      cells: pass.cells.length, wallMs: pass.wallMs, ...(waited ? { waitedForNetwork: waited } : {}), ...(pass.error ? { error: pass.error } : {}) });
    if (!finished(pass)) { stopped = pass.name; break; }
  }
  if (command === 'draw') {
    const determinism = determinismOf(dir, record);
    if (determinism) record.determinism = determinism;
    save();
  }
  const seen = record.kitchen?.[command];
  return { event: 'pilot', command, done: !stopped, ...(stopped ? { stopped } : {}),
    passes: Object.fromEntries(PASSES[command].map(plan => [plan.name, lastFinished(record, plan.name) ? 'finished' : 'not finished'])),
    ...(record.determinism ? { determinism: record.determinism.verdict } : {}),
    kitchen: seen ? { seen: seen.seen, argv: seen.argv, tritonImported: seen.tritonImported, triton: seen.backends.triton ?? null } : null,
    differsFromRoundOne: record.differsFromRoundOne };
}

type PassContext = { dir: string; source: Source; card: ReturnType<typeof cardOf>; pins: Record<string, string | number>; comfy: string; until: number;
  options: PilotOptions; log: (event: object) => void; record: PilotRecord; samplers: { front: string[]; frame: string[] } };
async function drawPass(context: PassContext, plan: PassPlan, attempt: number): Promise<PassRecord> {
  const { dir, source, options, record } = context;
  const root = join(dir, 'passes', `${plan.name}-${attempt}`);
  const cells = plan.cells.map(label => source.cells.find(cell => labelOf(cell) === label)!);
  // Round one's references, each file as the pass's directory sees it.
  const seeded = Object.fromEntries(source.references.map(key => [key, { ...source.roundOne[key],
    file: relative(root, resolve(source.root, source.roundOne[key].file!)) }]));
  const heard = new Map<string, { cycleMs?: number; cached?: string[] }>();
  const startedAt = new Date().toISOString(), began = performance.now();
  let mark = began, last = -1;
  const drawn = await drawPilot({ root, comfy: context.comfy, until: context.until, checkpoint: context.card.model, pins: context.pins,
    plans: [source.plan], cells, seeded, oneSocket: plan.oneSocket, timeoutMs: options.timeoutMs, waitMs: options.waitMs, pollMs: options.pollMs,
    outage: options.outage, log: context.log, observe: (cell, _record, cached) => {
      // A cell's cycle is only its own when the cell before it was drawn too.
      const now = performance.now(), at = cells.findIndex(one => one.key === cell.key);
      heard.set(cell.key, { ...(at === last + 1 ? { cycleMs: Math.round(now - mark) } : {}), ...(cached ? { cached } : {}) });
      mark = now;
      last = at;
    } });
  const wallMs = Math.round(performance.now() - began);
  const baseline = plan.name === 'baseline' ? undefined : lastFinished(record, 'baseline');
  const earlier = plan.earlier ? lastFinished(record, plan.earlier) : undefined;
  const out = cells.map((cell): PilotCell => {
    const one = drawn.index.cells[cell.key];
    const base = { cell: labelOf(cell), key: natural(cell), references: cell.refs.length };
    if (!one) return { ...base, status: 'unsent' };
    if (one.status !== 'drawn' || !one.file) return { ...base, status: one.status, ...(one.code ? { code: one.code } : {}), ...(one.outageMs ? { outageMs: one.outageMs } : {}) };
    const bytes = readFileSync(join(root, one.file));
    const against = (pass: PassRecord | undefined) => {
      const other = pass?.cells.find(each => each.cell === base.cell && each.file);
      return other ? pictureDiff(bytes, readFileSync(join(dir, other.file!))) : undefined;
    };
    const vsBaseline = against(baseline), vsEarlier = against(earlier);
    const told = heard.get(cell.key), device = one.vram?.[0];
    const samplers = cell.kind === 'front' ? context.samplers.front : context.samplers.frame;
    return { ...base, status: 'drawn', ...(told?.cycleMs === undefined ? {} : { cycleMs: told.cycleMs }), totalMs: one.totalMs, viewMs: one.viewMs,
      ...(one.uploadMs ? { uploadMs: one.uploadMs } : {}), ...(one.outageMs ? { outageMs: one.outageMs } : {}), ...(one.phases ? { phases: one.phases } : {}),
      ...(one.loaderCacheMiss === undefined ? {} : { loaderCacheMiss: one.loaderCacheMiss }),
      ...(told?.cached ? { samplerCached: samplers.some(id => told.cached!.includes(id)) } : {}),
      ...(one.partialModelLoadEvents === undefined ? {} : { partialModelLoadEvents: one.partialModelLoadEvents }),
      file: relative(dir, join(root, one.file)), sha256: one.sha256,
      ...(device ? { vramMiB: device.occupiedMiBMax ?? device.usedMiBMax, vramUsedMiB: device.usedMiBMax } : {}), ...(one.ramMiB ? { ramMiB: one.ramMiB.max } : {}),
      ...(vsBaseline ? { vsBaseline } : {}), vsRoundOne: pictureDiff(bytes, readFileSync(resolve(source.root, source.roundOne[natural(cell)].file!))),
      ...(vsEarlier ? { vsEarlier } : {}) };
  });
  return { name: plan.name, attempt, dir: relative(dir, root), oneSocket: plan.oneSocket, triton: context.pins.triton === 'enabled', startedAt,
    completedAt: new Date().toISOString(), ended: drawn.ended, ...(drawn.index.error ? { error: drawn.index.error } : {}), wallMs, cells: out };
}

// C against C, with A between them: the same picture, or not; and neither, when the server answered either C's sampler
// from its cache, or when the socket did not say.
function determinismOf(dir: string, record: PilotRecord): Determinism | undefined {
  const [x1, y, x2] = (['determinism-x1', 'determinism-y', 'determinism-x2'] as const).map(name => lastFinished(record, name)?.cells[0]);
  if (!x1?.file || !y || !x2?.file) return undefined;
  const diff = pictureDiff(readFileSync(join(dir, x1.file)), readFileSync(join(dir, x2.file)));
  const cached = (cell: PilotCell) => cell.samplerCached ?? null;
  const verdict = cached(x1) !== false || cached(x2) !== false ? 'inconclusive' : diff.pixelsSame ? 'same' : 'different';
  return { verdict, x1SamplerCached: cached(x1), ySamplerCached: cached(y), x2SamplerCached: cached(x2), diff };
}

// ---- The report ----

const known = (values: (number | undefined)[]) => values.filter(value => value !== undefined);
const mean = (values: (number | undefined)[]) => {
  const list = known(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : undefined;
};
const whole = (value: number | undefined) => (value === undefined ? null : Math.round(value));
// The card's idle time before a cell's job, roughly: its cycle less the job's own time from submit to picture.
const idle = (cell: PilotCell | undefined) => (cell?.cycleMs === undefined || cell.totalMs === undefined ? undefined : cell.cycleMs - cell.totalMs);

// What the passes measured, in numbers and the cells' labels: each pass's times and peaks; what the one socket saved
// a cell, against the mean of the two baselines around it; the determinism check; and Triton's sampler against the
// one socket's, its first pass against its second, and its pictures against the baseline's. A pass with a sampler
// answered from the cache is not a measurement of time, and says so (`comparable`).
export function pilotReport(dir: string) {
  const record = readJson<PilotRecord>(join(resolve(dir), 'pilot.json'));
  if (!record) throw new Refusal(`No pilot.json in ${dir}: the pilot's draw writes it`);
  const pass = (name: PassName) => lastFinished(record, name);
  const cellIn = (one: PassRecord | undefined, cell: string) => one?.cells.find(each => each.cell === cell);
  const comparable = (list: (PassRecord | undefined)[]) => list.every(one => one?.cells.every(cell => cell.samplerCached === false));
  const peak = (values: (number | undefined)[]) => (known(values).length ? Math.max(...known(values)) : null);
  const passes = Object.fromEntries([...PASSES.draw, ...PASSES.triton].map(plan => {
    const one = pass(plan.name);
    return [plan.name, one ? { attempt: one.attempt, wallMs: one.wallMs, cycleMs: Object.fromEntries(one.cells.map(cell => [cell.cell, cell.cycleMs ?? null])),
      totalMs: Object.fromEntries(one.cells.map(cell => [cell.cell, cell.totalMs ?? null])), meanIdleMs: whole(mean(one.cells.map(idle))),
      samplerCached: one.cells.filter(cell => cell.samplerCached === true).length,
      samplerUnheard: one.cells.filter(cell => cell.samplerCached === undefined).length, vramMiB: peak(one.cells.map(cell => cell.vramMiB)),
      ramMiB: peak(one.cells.map(cell => cell.ramMiB)), changedVsBaseline: one.cells.filter(cell => cell.vsBaseline && !cell.vsBaseline.pixelsSame).length,
      sameAsRoundOne: one.cells.filter(cell => cell.vsRoundOne?.pixelsSame).length } : null];
  }));
  const baseline = pass('baseline'), again = pass('baseline-again'), socket = pass('one-socket');
  const labels = baseline?.cells.map(cell => cell.cell) ?? [];
  const oneSocket = baseline && again && socket ? (() => {
    const byCell = Object.fromEntries(labels.map(label => {
      const before = mean([cellIn(baseline, label)?.cycleMs, cellIn(again, label)?.cycleMs]), after = cellIn(socket, label)?.cycleMs;
      const idleBefore = mean([idle(cellIn(baseline, label)), idle(cellIn(again, label))]), idleAfter = idle(cellIn(socket, label));
      return [label, { baselineCycleMs: whole(before), oneSocketCycleMs: whole(after),
        savedMs: before === undefined || after === undefined ? null : Math.round(before - after), baselineIdleMs: whole(idleBefore), oneSocketIdleMs: whole(idleAfter),
        idleSavedMs: idleBefore === undefined || idleAfter === undefined ? null : Math.round(idleBefore - idleAfter) }];
    }));
    const rows = Object.values(byCell);
    return { comparable: comparable([baseline, again, socket]), savedMsPerCell: whole(mean(rows.map(row => row.savedMs ?? undefined))),
      idleSavedMsPerCell: whole(mean(rows.map(row => row.idleSavedMs ?? undefined))), byCell };
  })() : null;
  const cold = pass('triton-cold'), warm = pass('triton-warm');
  const ratio = (top: number | undefined, bottom: number | undefined) => (top === undefined || !bottom ? null : Number((top / bottom).toFixed(3)));
  const total = (one: PassRecord | undefined, field: 'cycleMs' | 'totalMs') => {
    const list = one?.cells.map(cell => cell[field]) ?? [];
    return list.length && list.every(value => value !== undefined) ? list.reduce((sum, value) => sum + value!, 0) : undefined;
  };
  const triton = warm && socket ? {
    kitchen: record.kitchen?.triton ?? null, dispatchVisible: false, comparable: comparable([socket, warm]),
    sampleRatio: Object.fromEntries(labels.map(label => [label, ratio(cellIn(warm, label)?.phases?.sampleMs, cellIn(socket, label)?.phases?.sampleMs)])),
    totalRatio: ratio(total(warm, 'totalMs'), total(socket, 'totalMs')),
    coldExtraMs: whole(cold && total(cold, 'cycleMs') !== undefined && total(warm, 'cycleMs') !== undefined ? total(cold, 'cycleMs')! - total(warm, 'cycleMs')! : undefined),
    changedVsBaseline: warm.cells.filter(cell => cell.vsBaseline && !cell.vsBaseline.pixelsSame).length,
    warmSameAsCold: warm.cells.filter(cell => cell.vsEarlier?.pixelsSame).length, cells: warm.cells.length } : null;
  return { event: 'pilot_report', differsFromRoundOne: record.differsFromRoundOne ?? [], passes, determinism: record.determinism ?? null, oneSocket, triton };
}

// ---- The dry run ----

// comfy-kitchen's lines as the pinned server logs them at its start, without Triton and with it.
const kitchenLines = (triton: boolean) => ['WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations.',
  ...(triton ? ['Found triton 3.4.0. Enabling comfy-kitchen triton backend.'] : []),
  'Found comfy_kitchen backend cuda: {\'available\': True, \'disabled\': True, \'unavailable_reason\': None, \'capabilities\': []}',
  'Found comfy_kitchen backend eager: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}',
  `Found comfy_kitchen backend triton: {'available': True, 'disabled': ${triton ? 'False' : 'True'}, 'unavailable_reason': None, 'capabilities': []}`];

// A made-up round one of flight alone: four people, the first turned to the right so that it has a view, and `word`
// in the setting, so that every frame's prompt carries it.
function madeUpRoundOne(root: string, word: string) {
  const ok = { outcome: 'ok' as const, attempts: 1, ms: 1 };
  const sheet = ['Бранд', 'Лиэль', 'Орм', 'Ивла'].map((name, at) => ({ name, look: `An adult with hair ${at}`, outfit: `a tunic ${at}` }));
  const scene = { moment: 'They hold on', shot: 'Medium wide shot', setting: `A hangar at ${word}`, objects: '', props: '', light: 'Evening' };
  const text: StoryText = { id: PILOT_STORY, pins: '', steps: { opening: ok, action: ok, sheet: ok, frame: ok, variant: ok }, sheet, worn: sheet,
    frame: { ...scene, people: sheet.map(one => ({ who: one.name, look: '', clothes: '', state: '', action: 'holds on' })) },
    variant: { ...scene, people: sheet.map((one, at) => ({ who: one.name, role: `the holder ${at}`, facing: at ? 'viewer' as const : 'screen-right' as const,
      look: '', clothes: '', state: '', action: 'holds on' })) } };
  mkdirSync(storyDir(root, PILOT_STORY), { recursive: true, mode: 0o700 });
  writeFileSync(join(storyDir(root, PILOT_STORY), 'text.json'), JSON.stringify(text));
  writeFileSync(join(root, 'texts.json'), JSON.stringify({ pins: { route: 'simple-serving', weights: 'made up' } }));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify(planAll(root, textStories())));
  writeCardRecord(join(root, 'card.txt'));
}

// Every command against local/fake-comfy.ts: a made-up round one drawn by the action run's own smoke, then `draw` on a
// server whose pictures follow from their graphs, as a deterministic card's would, then `triton` on one started again
// with the Triton backend, whose pictures differ from the baseline's, then `report`. On the way, the refusals the paid
// pilot relies on, and at the end the search for the scene's made-up word in everything the pilot wrote and printed.
export async function pilotDryRun(out: string) {
  const dry = resolve(out), source = join(dry, 'round-one'), dir = join(dry, 'pilot');
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) { say(`   ${what}: refused (${JSON.stringify(safeError(error))})`); }
  };
  const word = madeUpName(), until = Date.now() + 2 * 3600000;
  const started = { jobMs: 15, referenceMs: 0, requireUploads: true, marker: word };
  let fake = await startFakeComfy({ ...started, picturesByGraph: true, startupLog: kitchenLines(false) });
  try {
    say(`the pilot's dry run in ${dry}: a made-up round one and local/fake-comfy.ts; no card, no network`);
    madeUpRoundOne(source, word);
    const smoke = await drawStage({ stage: 'smoke', root: source, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
    say(`1 round one: the smoke drew ${Object.values(smoke.cells).filter(one => one.status === 'drawn').length} cells of ${PILOT_STORY}, pass ${smoke.smoke?.verdict?.pass}`);
    expect(smoke.smoke?.verdict?.pass === true, 'round one\'s smoke passes');
    writeCardRecord(join(dir, 'card.txt'));
    const run = (command: 'draw' | 'triton', at = dir) => pilotCommand(command, { dir: at, source, comfy: fake.url, until, pollMs: 10, waitMs: 20000, timeoutMs: 10000 });
    await refused('triton on the server as round one ran it', () => run('triton'));
    await refused('a pilot directory inside round one\'s', () => run('draw', join(source, 'pilot')));
    const plan = readJson<StoryPlan>(join(storyDir(source, PILOT_STORY), 'plan.json'))!;
    const sharp = { ...pilotCells(plan)[2], story: 'sharp-1' };
    await refused('a sharp cell', () => drawPilot({ root: join(dry, 'sharp'), comfy: fake.url, until, checkpoint: '', pins: {}, plans: [], cells: [sharp],
      seeded: {}, oneSocket: true }));
    expect(!existsSync(join(dry, 'sharp')), 'nothing is written for a sharp cell');

    const drawn = await run('draw');
    const record = () => readJson<PilotRecord>(join(dir, 'pilot.json'))!;
    say(`2 draw: ${JSON.stringify(drawn)}`);
    expect(drawn.done && PASSES.draw.every(one => lastFinished(record(), one.name)), 'every pass of draw finishes');
    expect(record().determinism?.verdict === 'same', 'the determinism check finds the same picture');
    const drawCells = PASSES.draw.flatMap(one => lastFinished(record(), one.name)?.cells ?? []);
    expect(drawCells.length === 18 && drawCells.every(cell => cell.samplerCached === false && cell.sha256 && cell.vsRoundOne), 'every cell is heard, hashed and compared with round one');
    expect((['one-socket', 'baseline-again'] as const).every(name => lastFinished(record(), name)!.cells.every(cell => cell.vsBaseline?.pixelsSame === true)),
      'the same cells come out as the baseline\'s');
    const jobs = fake.jobs.length;
    await run('draw');
    say(`   draw again: ${fake.jobs.length - jobs} jobs`);
    expect(fake.jobs.length === jobs, 'a finished draw draws nothing again');

    await fake.close();
    const failed = 'Failed to import triton, Error: No module named \'triton\', the comfy-kitchen triton backend will not be available.';
    fake = await startFakeComfy({ ...started, argv: ['main.py', '--enable-triton-backend'], startupLog: [...kitchenLines(false), failed] });
    await refused('triton on a server whose log says Triton did not load', () => run('triton'));
    await fake.close();
    fake = await startFakeComfy({ ...started, argv: ['main.py', '--enable-triton-backend'], startupLog: kitchenLines(true) });
    say('   the server started again with SIMPLE_CHAT_IMAGE_TRITON=1');
    await refused('draw with the Triton backend on', () => run('draw'));
    const triton = await run('triton');
    say(`3 triton: ${JSON.stringify(triton)}`);
    const kitchen = record().kitchen;
    expect(triton.done && kitchen?.draw?.backends.triton?.disabled === true && kitchen.triton?.argv === true && kitchen.triton.tritonImported
      && kitchen.triton.backends.triton?.available === true && kitchen.triton.backends.triton.disabled === false, 'the log says Triton was off for draw and on for triton');
    const tritonCells = PASSES.triton.flatMap(one => lastFinished(record(), one.name)?.cells ?? []);
    expect(tritonCells.length === 10 && tritonCells.every(cell => cell.vsBaseline?.pixelsSame === false && (cell.vsBaseline.differing ?? 0) > 0),
      'the pictures under Triton are compared with the baseline\'s pixel by pixel');

    const report = pilotReport(dir);
    say(`4 report: ${JSON.stringify(report)}`);
    expect(report.determinism?.verdict === 'same' && report.oneSocket?.comparable === true && report.triton !== null, 'the report has every block');
    // The word is in round one's plans, which the pilot read; it must be nowhere the pilot wrote or printed.
    const forms = markerForms(word);
    const found = searchTree(dir, forms), inRoundOne = searchTree(source, forms).hits.length;
    const printed = forms.some(form => Buffer.from(output.text(), 'utf8').includes(form));
    const sealed = readdirSync(dry, { recursive: true, withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === 'sealed').length;
    say(`5 boundary: ${found.files} files in the pilot's directory, ${found.unread.length} unread, ${found.hits.length} with the word, which round one's `
      + `plans hold in ${inRoundOne}; printed ${printed}; ${sealed} sealed directories`);
    expect(inRoundOne > 0 && !found.hits.length && !found.unread.length && !printed, 'the scene\'s word nowhere the pilot wrote or printed');
    expect(sealed === 0, 'no sealed directory anywhere');
    say(missed.length ? `the pilot's dry run did NOT go as expected: ${missed.length} of its checks` : 'the pilot\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    await fake.close();
    output.stop();
  }
}

// ---- The command line ----

// What an error may say (docs/action-experiment.md#sealed), as local/image-action.ts `safeError`: its code from the
// lists below, the fields that pass safeErrorDetails, its class, and a refusal's own words. No other message.
const CODES = new Set<string>([...DRAW_CODES, 'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ENOSPC', 'EMFILE',
  'ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL']);
const CLASSES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AbortError', 'TimeoutError']);
function safeError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const own = typeof code === 'string' && CODES.has(code) ? { code } : {};
  if (error instanceof Refusal) return { message: error.message, ...own };
  const name = error instanceof Error ? (CLASSES.has(error.name) ? error.name : 'other') : typeof error;
  return { error: name, ...own, ...safeErrorDetails(error) };
}

const USAGE = 'Use: image-pilot.ts draw|triton --until <epoch seconds, five minutes before the card\'s end> [--dir illustrations/pilot] '
  + '[--from illustrations/action-1] [--wait 600] [--timeout 60] [--comfy http://127.0.0.1:8188], report [--dir], or dry-run [--dir] '
  + '(docs/action-experiment.md#pilot)';
async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '600' }, timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await pilotDryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-pilot-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  const dir = resolve(values.dir ?? PILOT_DIR);
  if (command === 'report') return print(pilotReport(dir));
  if (command !== 'draw' && command !== 'triton') throw new Refusal(USAGE);
  // `--until` as the action run takes it: the end of the work in epoch seconds, five minutes before the card's end.
  const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
  if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
    || !Number.isInteger(timeout) || timeout < 10) throw new Refusal(USAGE);
  let comfy: string;
  try { comfy = comfyUrl(values.comfy!); } catch { throw new Refusal('--comfy is the tunnelled loopback root of the server, such as http://127.0.0.1:8188'); }
  const result = await pilotCommand(command, { dir, source: resolve(values.from ?? SOURCE_DIR), comfy, until, waitMs: wait * 1000,
    timeoutMs: timeout * 1000, log: print });
  print(result);
  if (!result.done) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
