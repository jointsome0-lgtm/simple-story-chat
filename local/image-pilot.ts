// The pilot of the picture run's speed (docs/action-experiment.md#pilot): a fixed handful of round one's clean cells,
// drawn again on the picture card from round one's own plans, portraits and views, into illustrations/pilot, before
// round two is drawn. It asks what round two's path buys: one socket for a stage (local/image-batch.ts `stageSocket`),
// each job sent as soon as the one before it is over and the next cell's references uploaded while a job draws
// (local/action-draw.ts `drawAhead`). It asks too whether the card draws the same inputs to the same picture, and what
// comfy-kitchen's Triton backend changes. Its cells are flight's at
// seed 7, flight binding four people, the most round two binds: one of each kind of picture the run draws, a front,
// a view, a frame without references (A), C with four portraits, V with views among them, and T with L's picture and
// four portraits. Each pass is drawn as a stage draws (local/action-draw.ts `drawPilot`) into a directory of its own,
// with round one's portraits, views and L as its references.
//   draw      on the server as round one ran it. The determinism check: C, then A, then C again, whose picture should
//             be the first's, with neither C's sampler answered from the server's cache; then the timed cells, the
//             front, the view, A, V and T: the baseline, each cell whole before the next on a socket of its own with
//             a read of the log before and after its job, as round one drew; the same on round two's path; and the
//             baseline again, which brackets whatever drifts on the card
//   triton    once the server is started again with SIMPLE_CHAT_IMAGE_TRITON=1: what its log says of the backends,
//             then the timed cells twice on round two's path, the first pass with whatever Triton compiles
// The backend measurement (docs/action-experiment.md#backend) draws the same timed cells, each command cold then warm on
// round two's path, into a directory of its own, illustrations/pilot-cuda, on one card with Triton on:
//   reference     on the default torch, cu128: what the others are compared with
//   compile       on the same server, with ComfyUI's TorchCompileModel before the sampler; a failed cell ends it
//   turbo         once the server is started again with Viggle's two nodes (SIMPLE_CHAT_IMAGE_VIGGLE=true), which no
//                 other command draws on: the cells sampled through Viggle's LoRA in six steps, their times against the
//                 reference's and their pictures beside its on a page (turbo.html), for the owner to judge by eye
//   cuda          once the server is started again on the cu130 torch, whose log must show comfy-kitchen's CUDA backend on
//   cuda-compile  on that server, with the compile node
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
import { readManifest } from './tokenizer-extract.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { isSharp, readJson, storyDir, textStories } from './action-text.ts';
import type { StoryText } from './action-text.ts';
import { planAll } from './action-prompts.ts';
import type { StoryPlan } from './action-prompts.ts';
import { ACTION_GRAPH, DRAW_CODES, FRAME_CANVAS, FRONT_GRAPH, SCALED, VIEW_CANVAS, drawPilot, drawStage, frameKey, planCells } from './action-draw.ts';
import type { ActionCell, CellRecord, DrawIndex } from './action-draw.ts';
import { escapeHtml } from './action-judge.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const SOURCE_DIR = join(ROOT, 'illustrations', 'action-1');
export const PILOT_DIR = join(ROOT, 'illustrations', 'pilot');
export const BACKEND_DIR = join(ROOT, 'illustrations', 'pilot-cuda');
const MANIFEST = join(ROOT, 'gpu', 'image-manifest.env');
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

export type PassName = 'determinism-x1' | 'determinism-y' | 'determinism-x2' | 'baseline' | 'round-two' | 'baseline-again'
  | 'triton-cold' | 'triton-warm' | 'reference-cold' | 'reference-warm' | 'compile-cold' | 'compile-warm' | 'turbo-cold' | 'turbo-warm'
  | 'cuda-cold' | 'cuda-warm' | 'cuda-compile-cold' | 'cuda-compile-warm';
export type BackendCommand = 'reference' | 'compile' | 'turbo' | 'cuda' | 'cuda-compile';
export type Command = 'draw' | 'triton' | BackendCommand;
// `roundTwo`: drawn on round two's path rather than round one's (local/action-draw.ts `drawPilot`). `cells`: what a
// pass draws, by the cells' labels; `earlier`: the pass whose pictures its own are compared with, and `against` the
// backend measurement's reference, whose pictures they are compared with too. `compile`: drawn with the compile node
// (`withCompile`), and `needsMs` the time before --until without which the pass does not begin. `turbo`: sampled
// through Viggle's LoRA (`withTurbo`), whose pictures are compared with none.
type PassPlan = { name: PassName; roundTwo: boolean; cells: string[]; earlier?: PassName; against?: PassName; compile?: true; turbo?: true;
  needsMs?: number };
export const TIMED = ['front', 'view', 'A', 'V', 'T'];
// A compile pass's job may take ten minutes, the compiles included, and no longer (the owner, 2026-09-26): the cold pass
// begins only with ten minutes left before --until, and the warm one with two. A failed cell ends a compile pass.
const COMPILE_WAIT_MS = 10 * 60000;
const REFERENCE = { against: 'reference-warm' } as const;
const COMPILED = { compile: true } as const;
const TURBO = { turbo: true } as const;
export const PASSES: Record<Command, PassPlan[]> = {
  draw: [{ name: 'determinism-x1', roundTwo: true, cells: ['C'] }, { name: 'determinism-y', roundTwo: true, cells: ['A'] },
    { name: 'determinism-x2', roundTwo: true, cells: ['C'] }, { name: 'baseline', roundTwo: false, cells: TIMED },
    { name: 'round-two', roundTwo: true, cells: TIMED }, { name: 'baseline-again', roundTwo: false, cells: TIMED }],
  triton: [{ name: 'triton-cold', roundTwo: true, cells: TIMED }, { name: 'triton-warm', roundTwo: true, cells: TIMED, earlier: 'triton-cold' }],
  reference: [{ name: 'reference-cold', roundTwo: true, cells: TIMED }, { name: 'reference-warm', roundTwo: true, cells: TIMED, earlier: 'reference-cold' }],
  compile: [{ name: 'compile-cold', roundTwo: true, cells: TIMED, ...REFERENCE, ...COMPILED, needsMs: COMPILE_WAIT_MS },
    { name: 'compile-warm', roundTwo: true, cells: TIMED, earlier: 'compile-cold', ...REFERENCE, ...COMPILED, needsMs: 2 * 60000 }],
  turbo: [{ name: 'turbo-cold', roundTwo: true, cells: TIMED, ...TURBO }, { name: 'turbo-warm', roundTwo: true, cells: TIMED, ...TURBO }],
  cuda: [{ name: 'cuda-cold', roundTwo: true, cells: TIMED, ...REFERENCE }, { name: 'cuda-warm', roundTwo: true, cells: TIMED, earlier: 'cuda-cold', ...REFERENCE }],
  'cuda-compile': [{ name: 'cuda-compile-cold', roundTwo: true, cells: TIMED, ...REFERENCE, ...COMPILED, needsMs: COMPILE_WAIT_MS },
    { name: 'cuda-compile-warm', roundTwo: true, cells: TIMED, earlier: 'cuda-compile-cold', ...REFERENCE, ...COMPILED, needsMs: 2 * 60000 }],
};
// The backend measurement's commands: the torch each draws on, as gpu/image-manifest.env pins it, the pass that must
// have finished before it, and whether the server's log must show comfy-kitchen's CUDA backend on. Turbo's server alone
// has Viggle's nodes (`viggleOn`).
const BACKEND: Record<BackendCommand, { torch: 'TORCH_VERSION' | 'TORCH_CU130_VERSION'; after?: PassName; cuda: boolean }> = {
  reference: { torch: 'TORCH_VERSION', cuda: false },
  compile: { torch: 'TORCH_VERSION', after: 'reference-warm', cuda: false },
  turbo: { torch: 'TORCH_VERSION', after: 'reference-warm', cuda: false },
  cuda: { torch: 'TORCH_CU130_VERSION', after: 'reference-warm', cuda: true },
  'cuda-compile': { torch: 'TORCH_CU130_VERSION', after: 'cuda-warm', cuda: true },
};
const isBackend = (command: string): command is BackendCommand => Object.hasOwn(BACKEND, command);
// A pass that has not finished is drawn again whole, into a new directory: a pass is a measurement, and half of one
// resumed on a later server is not one. After this many attempts somebody looks first.
const ATTEMPTS = 3;

// Two pictures compared: their bytes, then their pixels, as many as differ in any channel, the largest and the mean
// difference of a channel, and the PSNR in dB when any differs. `comparable: false` for two that cannot be decoded
// here or differ in size.
export type Diff = { bytesSame: boolean; pixelsSame?: boolean; comparable?: false; differing?: number; share?: number; maxDelta?: number;
  meanDelta?: number; psnr?: number };
// A cell of a pass: its times (`cycleMs` from the record of the cell before, or from the pass's start, to this one's,
// the log's reads included; the rest local/action-draw.ts's own), whether the server answered its sampler from
// its cache, the peaks of video memory (as nvidia-smi sees it, and in use) and RAM in MiB, and its picture against the
// baseline's, the backend measurement's reference, round one's and the earlier pass's. `unsent`: a cell that never
// reached the card.
export type PilotCell = { cell: string; key: string; status: CellRecord['status'] | 'unsent'; code?: string; references: number;
  cycleMs?: number; totalMs?: number; viewMs?: number; uploadMs?: number; outageMs?: number; phases?: Phases; loaderCacheMiss?: boolean;
  samplerCached?: boolean; partialModelLoadEvents?: number; file?: string; sha256?: string; vramMiB?: number; vramUsedMiB?: number; ramMiB?: number;
  vsBaseline?: Diff; vsReference?: Diff; vsRoundOne?: Diff; vsEarlier?: Diff };
// `pytorch`: the torch the server said it runs; `compile`: the compile node's backend, on a pass drawn with it; `turbo`:
// the LoRA, its strength and the schedule's nodes, on a pass sampled through it, and `skippedCells` those it left out,
// which start from a picture (`fromPicture`).
export type PassRecord = { name: PassName; attempt: number; dir: string; roundTwo: boolean; triton: boolean; pytorch?: string; compile?: string;
  turbo?: { lora: string; strength: number; nodes: string }; skippedCells?: string[];
  startedAt: string; completedAt: string; ended: 'done' | 'until' | 'stopped'; error?: string; wallMs: number; cells: PilotCell[] };
// What the server's log said of comfy-kitchen's backends right after its start (comfy/quant_ops.py:22-43 at the pinned
// revision): the Triton backend asked for on the command line (`argv`), triton imported or not, each backend available
// and disabled, and the warning that the CUDA backend needs torch built for CUDA 13. `why`: a backend the kitchen could
// not load, by the kind of reason it gave, the reason's words never kept: its extension missing, the extension failing
// to load (a library it needs, such as cuBLASLt 13), no CUDA, or another. `seen`: the lines were still in the log's
// ring. Which backend ran a given layer the server logs at DEBUG alone (comfy_kitchen.dispatch), never in this log:
// `dispatchVisible` is always false, and the pictures and the sampler's seconds are the evidence of use.
export type Kitchen = { seen: boolean; argv: boolean; tritonImported: boolean; tritonImportFailed: boolean; cudaNeedsCu130: boolean;
  backends: Record<string, { available: boolean; disabled: boolean; why?: 'extension_missing' | 'extension_failed' | 'no_cuda' | 'other' }>;
  dispatchVisible: false };
export type Determinism = { verdict: 'same' | 'different' | 'inconclusive'; x1SamplerCached: boolean | null; ySamplerCached: boolean | null;
  x2SamplerCached: boolean | null; diff: Diff };
// `skipped`: the passes that did not begin at least once for too little time before --until (`needsMs`).
export type PilotRecord = { story: string; seed: number; source: string; pins?: Record<string, string | number>; differsFromRoundOne?: string[];
  kitchen?: Partial<Record<Command, Kitchen>>; passes: PassRecord[]; skipped?: PassName[]; determinism?: Determinism };

// A pass is finished when it drew every cell and none of them waited for the network (`outageMs`): its times would
// hold the wait, and a pass on round two's path rides out a drop that fails the baseline's.
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
export const natural = (cell: ActionCell) => cell.key.slice(PREFIX.length);
export const labelOf = (cell: ActionCell) => (cell.kind === 'frame' ? cell.arm! : cell.kind);
// A reference's key in round one's index, found as local/action-draw.ts `referencesOf` finds it.
export const referenceKey = (plan: StoryPlan, cell: ActionCell, ref: string) => ref === 'L' ? frameKey(cell.story, cell.seed, 'L')
  : plan.views.some(view => view.id === ref) ? `view:${ref}` : `front:${ref}`;

export type Source = { root: string; plan: StoryPlan; planHash: string; cells: ActionCell[]; roundOne: Record<string, CellRecord>; references: string[];
  pins: Record<string, string | number> };
// Round one as the pilot draws from it: flight's plan, and round one's record of each of the pilot's cells and of each
// reference, drawn, under clean/, and the very file it drew. The plan must be the one round one drew from: each
// prompt as long as round one's and as many references, since the hash round one pinned covers every plan, sealed
// ones too, which the pilot does not read.
export function readSource(root: string): Source {
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
export function ownPins(card: ReturnType<typeof cardOf>, source: Source): Record<string, string | number> {
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
    if (!found) continue;
    const reason = /'unavailable_reason': (?!None\b)/.test(found[2]);
    const why = !reason ? undefined : /Extension file not found|Could not create module spec/.test(found[2]) ? 'extension_missing' as const
      : /CUDA not available/.test(found[2]) ? 'no_cuda' as const : /extension|\.so\b|\.so\.|cannot open shared object/i.test(found[2]) ? 'extension_failed' as const
      : 'other' as const;
    backends[found[1]] = { available: /'available': True\b/.test(found[2]), disabled: /'disabled': True\b/.test(found[2]), ...(why ? { why } : {}) };
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

export async function pilotCommand(command: Command, options: PilotOptions) {
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
  const backend = isBackend(command) ? BACKEND[command] : undefined;
  // The backend measurement moves torch alone, between the two lines the manifest pins, each command on its own.
  const { triton, ...rest } = pins;
  const { pytorch, ...others } = rest;
  const plain = backend ? others : rest;
  const file = join(dir, 'pilot.json');
  const record: PilotRecord = readJson<PilotRecord>(file) ?? { story: PILOT_STORY, seed: PILOT_SEED, source: relative(dir, from), passes: [] };
  if (record.source !== relative(dir, from)) throw new Refusal(`${file} was drawn from another round one than ${from}`);
  // The pilot and the backend measurement each have a directory of their own: their passes are compared with their own.
  const family = new Set(Object.entries(PASSES).filter(([one]) => isBackend(one) === !!backend).flatMap(([, plans]) => plans.map(plan => plan.name)));
  const foreign = record.passes.find(pass => !family.has(pass.name));
  if (foreign) throw new Refusal(`${file} holds ${foreign.name}, which ${command} is never compared with: each measurement draws into a directory of its own (--dir)`);
  // One card and one server for the whole pilot, Triton aside, and for the backend measurement one card and a server for
  // each torch: a pass on another would be compared with none of these.
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
  const manifest = readManifest(MANIFEST);
  if (backend) {
    const wanted = manifest[backend.torch];
    if (!wanted || pytorch !== wanted) {
      throw new Refusal(`${command} draws on torch ${wanted}, as gpu/image-manifest.env pins it, and the server runs ${pytorch}: start it as docs/action-experiment.md#backend says`);
    }
    if (triton !== 'enabled') throw new Refusal(`${command} needs the server started with SIMPLE_CHAT_IMAGE_TRITON=1 (docs/action-experiment.md#backend)`);
    if (backend.after && !lastFinished(record, backend.after)) throw new Refusal(`${command} comes after ${backend.after}: draw that to its end first`);
    // Turbo's server has Viggle's two nodes and its LoRA among the loader's files, and every other command's has neither
    // node: no server draws the LoRA's graphs and plain ones both (the owner, after ComfyUI's PRs 16493 and 15734).
    const viggle = await viggleOn(comfy, manifest.IMAGE_VIGGLE_LORA_FILE ?? '').catch(() => {
      throw new Refusal('The server did not answer /object_info, which says whether it has Viggle\'s nodes; nothing is drawn');
    });
    if (command === 'turbo' && !(viggle.nodes === VIGGLE_NODES.length && viggle.lora)) {
      throw new Refusal(`turbo needs the server started with SIMPLE_CHAT_IMAGE_VIGGLE=true, with Viggle's ${VIGGLE_NODES.length} nodes and its LoRA; it has `
        + `${viggle.nodes} of the nodes, and the LoRA ${viggle.lora ? 'listed' : 'not listed'} (docs/action-experiment.md#backend)`);
    }
    if (command !== 'turbo' && viggle.nodes) {
      throw new Refusal(`${command} draws on a server without Viggle's nodes, and this one has them: start it again without SIMPLE_CHAT_IMAGE_VIGGLE (docs/action-experiment.md#backend)`);
    }
  }
  record.pins = plain;
  record.differsFromRoundOne = Object.keys(plain).filter(key => key in source.pins && source.pins[key] !== plain[key]);
  mkdirSync(join(dir, 'passes'), { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, record);
  // The log's word on the backends, read before anything is drawn, while the lines of the server's start are still in
  // its ring; a later read that no longer finds them keeps the earlier one, and cuda-compile, on cuda's server, may
  // stand on cuda's. A server started with the flag whose log says Triton did not load would draw the eager path again,
  // and is refused before it draws; a cuda pass is refused unless the log shows the kitchen's CUDA backend available
  // and on.
  const kitchen = kitchenOf(await logLines(comfy), triton === 'enabled');
  if (kitchen.seen || !record.kitchen?.[command]?.seen) (record.kitchen ??= {})[command] = kitchen;
  save();
  const shown = [kitchen, record.kitchen?.[command], ...(command === 'cuda-compile' ? [record.kitchen?.cuda] : [])].find(one => one?.seen);
  const tritonOff = shown && (shown.tritonImportFailed || !shown.backends.triton?.available || shown.backends.triton.disabled);
  if ((command === 'triton' || backend) && tritonOff) {
    throw new Refusal(`The server's log says comfy-kitchen's Triton backend did not load at its start: ${command} would draw without it`);
  }
  const cuda = shown?.backends.cuda;
  if (backend?.cuda && !(cuda?.available && !cuda.disabled)) {
    throw new Refusal(`The server's log does not show comfy-kitchen's CUDA backend available and on (${!shown ? 'its lines are not in the log'
      : !cuda ? 'no line of it' : `available ${cuda.available}, disabled ${cuda.disabled}${cuda.why ? `, ${cuda.why}` : ''}`}): ${command} would draw without it`);
  }
  const samplers = (graph: Graph) => Object.keys(graph).filter(id => /Sampler/.test(graph[id].class_type));
  const context: PassContext = { dir, source, card, pins, comfy: options.comfy, until: options.until, options, log, record,
    samplers: { front: samplers(graphOf(FRONT_GRAPH)), frame: samplers(graphOf(ACTION_GRAPH)) }, lora: manifest.IMAGE_VIGGLE_LORA_FILE ?? '' };
  let stopped: PassName | undefined, skipped: PassName | undefined;
  for (const plan of PASSES[command]) {
    if (lastFinished(record, plan.name)) continue;
    // A pass with an estimate of its own begins only with that much time left: the card's minutes after it are others'.
    if (plan.needsMs && options.until - Date.now() < plan.needsMs) {
      skipped = plan.name;
      record.skipped = [...new Set([...record.skipped ?? [], plan.name])];
      save();
      break;
    }
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
  if (command === 'turbo') writeTurboPage(dir, source, record);
  const seen = record.kitchen?.[command];
  const failed = stopped && record.passes.findLast(pass => pass.name === stopped)!.cells.filter(cell => cell.status === 'failed')
    .map(cell => ({ cell: cell.cell, code: cell.code ?? null }));
  return { event: 'pilot', command, done: !stopped && !skipped, ...(stopped ? { stopped } : {}), ...(failed?.length ? { failed } : {}),
    ...(skipped ? { skipped, reason: 'too little time before --until' } : {}),
    passes: Object.fromEntries(PASSES[command].map(plan => [plan.name, lastFinished(record, plan.name) ? 'finished' : 'not finished'])),
    ...(record.determinism ? { determinism: record.determinism.verdict } : {}),
    ...(backend ? { pytorch } : {}), ...(command === 'turbo' ? { page: join(dir, TURBO_PAGE) } : {}),
    kitchen: seen ? { seen: seen.seen, argv: seen.argv, tritonImported: seen.tritonImported, triton: seen.backends.triton ?? null,
      ...(backend ? { cuda: seen.backends.cuda ?? null, cudaNeedsCu130: seen.cudaNeedsCu130 } : {}) } : null,
    differsFromRoundOne: record.differsFromRoundOne };
}

// `lora`: the file of Viggle's LoRA, as gpu/image-manifest.env names it.
type PassContext = { dir: string; source: Source; card: ReturnType<typeof cardOf>; pins: Record<string, string | number>; comfy: string; until: number;
  options: PilotOptions; log: (event: object) => void; record: PilotRecord; samplers: { front: string[]; frame: string[] }; lora: string };
async function drawPass(context: PassContext, plan: PassPlan, attempt: number): Promise<PassRecord> {
  const { dir, source, options, record } = context;
  const root = join(dir, 'passes', `${plan.name}-${attempt}`);
  const planned = plan.cells.map(label => source.cells.find(cell => labelOf(cell) === label)!);
  // Turbo leaves out a cell that starts from a picture, and its record says which.
  const skipped = plan.turbo ? planned.filter(cell => fromPicture(graphOf(cell.kind === 'front' ? FRONT_GRAPH : ACTION_GRAPH))) : [];
  const cells = planned.filter(cell => !skipped.includes(cell));
  // Round one's references, each file as the pass's directory sees it.
  const seeded = Object.fromEntries(source.references.map(key => [key, { ...source.roundOne[key],
    file: relative(root, resolve(source.root, source.roundOne[key].file!)) }]));
  const heard = new Map<string, { cycleMs?: number; cached?: string[] }>();
  const startedAt = new Date().toISOString(), began = performance.now();
  let mark = began, last = -1;
  const compiling = plan.compile ? { graph: withCompile, stopAtFailure: true, waitMs: Math.min(options.waitMs ?? COMPILE_WAIT_MS, COMPILE_WAIT_MS) } : {};
  const lora = context.lora;
  const turbo = plan.turbo ? { graph: (filled: Graph) => withTurbo(filled, lora), recipe: TURBO_RECIPE, stopAtFailure: true } : {};
  const drawn = await drawPilot({ root, comfy: context.comfy, until: context.until, checkpoint: context.card.model, pins: context.pins,
    plans: [source.plan], cells, seeded, roundTwo: plan.roundTwo, timeoutMs: options.timeoutMs, waitMs: options.waitMs, pollMs: options.pollMs,
    outage: options.outage, log: context.log, ...compiling, ...turbo, observe: (cell, _record, cached) => {
      // A cell's cycle is only its own when the cell before it was drawn too. Cells are heard in their order: on round
      // two's path a cell's record waits for the one before it.
      const now = performance.now(), at = cells.findIndex(one => one.key === cell.key);
      heard.set(cell.key, { ...(at === last + 1 ? { cycleMs: Math.round(now - mark) } : {}), ...(cached ? { cached } : {}) });
      mark = now;
      last = at;
    } });
  const wallMs = Math.round(performance.now() - began);
  const baseline = plan.name === 'baseline' ? undefined : lastFinished(record, 'baseline');
  const reference = plan.against ? lastFinished(record, plan.against) : undefined;
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
    const vsBaseline = against(baseline), vsReference = against(reference), vsEarlier = against(earlier);
    const told = heard.get(cell.key), device = one.vram?.[0];
    const samplers = cell.kind === 'front' ? context.samplers.front : context.samplers.frame;
    return { ...base, status: 'drawn', ...(told?.cycleMs === undefined ? {} : { cycleMs: told.cycleMs }), totalMs: one.totalMs, viewMs: one.viewMs,
      ...(one.uploadMs ? { uploadMs: one.uploadMs } : {}), ...(one.outageMs ? { outageMs: one.outageMs } : {}), ...(one.phases ? { phases: one.phases } : {}),
      ...(one.loaderCacheMiss === undefined ? {} : { loaderCacheMiss: one.loaderCacheMiss }),
      ...(told?.cached ? { samplerCached: samplers.some(id => told.cached!.includes(id)) } : {}),
      ...(one.partialModelLoadEvents === undefined ? {} : { partialModelLoadEvents: one.partialModelLoadEvents }),
      file: relative(dir, join(root, one.file)), sha256: one.sha256,
      ...(device ? { vramMiB: device.occupiedMiBMax ?? device.usedMiBMax, vramUsedMiB: device.usedMiBMax } : {}), ...(one.ramMiB ? { ramMiB: one.ramMiB.max } : {}),
      ...(vsBaseline ? { vsBaseline } : {}), ...(vsReference ? { vsReference } : {}),
      ...(plan.turbo ? {} : { vsRoundOne: pictureDiff(bytes, readFileSync(resolve(source.root, source.roundOne[natural(cell)].file!))) }),
      ...(vsEarlier ? { vsEarlier } : {}) };
  });
  return { name: plan.name, attempt, dir: relative(dir, root), roundTwo: plan.roundTwo, triton: context.pins.triton === 'enabled',
    ...(context.pins.pytorch === undefined ? {} : { pytorch: String(context.pins.pytorch) }), ...(plan.compile ? { compile: COMPILE.backend } : {}),
    ...(plan.turbo ? { turbo: { lora, strength: VIGGLE.strength, nodes: VIGGLE.nodes }, ...(skipped.length ? { skippedCells: skipped.map(labelOf) } : {}) } : {}),
    startedAt, completedAt: new Date().toISOString(), ended: drawn.ended, ...(drawn.index.error ? { error: drawn.index.error } : {}), wallMs, cells: out };
}

// ComfyUI's core TorchCompileModel (comfy_extras/nodes_torch_compile.py at the pinned revision), on the model's way
// to the sampler: after the loader and, in a frame's graph, after QwenImage21Cache, so that it compiles the patched
// model. Its one input besides the model is the backend, pinned to its default, inductor; the node itself asks
// torch.compile for no mode and no fullgraph, dynamic None, with a guard filter that drops the guards on
// transformer_options, and clones the model without dynamic loading (comfy_api/torch_helpers/torch_compile.py).
export const COMPILE = { node: '40', backend: 'inductor' } as const;
export function withCompile(graph: Graph): Graph {
  const sampler = Object.entries(graph).find(([, node]) => node.class_type === 'KSampler');
  const model = sampler?.[1].inputs.model;
  if (!sampler || !Array.isArray(model) || graph[COMPILE.node]) {
    throw new Refusal(`The pinned graph has no KSampler taking a model to compile, or a node ${COMPILE.node} of its own where the compile node goes`);
  }
  return { ...graph, [COMPILE.node]: { class_type: 'TorchCompileModel', inputs: { model, backend: COMPILE.backend } },
    [sampler[0]]: { ...sampler[1], inputs: { ...sampler[1].inputs, model: [COMPILE.node, 0] } } };
}

// Viggle's few-step LoRA (docs/action-experiment.md#backend), as its repository's own ComfyUI workflows use it, from
// its two nodes (comfyui/viggle_turbo.py, pinned in gpu/image-manifest.env): ViggleTurboLora at strength 1.0, which its
// readme says to keep, on the loader's model, so that in a frame's graph QwenImage21Cache takes the LoRA's; the
// KSampler replaced, under its own id, by a SamplerCustomAdvanced with euler, no guidance (BasicGuider on the positive
// conditioning; the plain graphs' cfg 1.0 skips the negative too, comfy/samplers.py:610), RandomNoise on the cell's seed,
// and ViggleTurboSigmas' six-step schedule, its default, shifted for the size of the cell's latent. The graph is
// changed once it is filled (local/action-draw.ts `drawPilot`), and the new nodes take ids of their own.
export const VIGGLE = { strength: 1, nodes: '1.0, 0.9375, 0.875, 0.75, 0.5, 0.25', sampler: 'euler',
  ids: { lora: '41', noise: '42', guider: '43', select: '44', sigmas: '45' } } as const;
export const VIGGLE_NODES = ['ViggleTurboLora', 'ViggleTurboSigmas'];
// What a turbo cell's record says it was sampled with: the schedule's six steps, euler, and no guidance.
export const TURBO_RECIPE = { steps: VIGGLE.nodes.split(',').length, sampler: VIGGLE.sampler, scheduler: 'ViggleTurboSigmas', cfg: 1 };
export function withTurbo(graph: Graph, lora: string): Graph {
  const sampler = Object.entries(graph).find(([, node]) => node.class_type === 'KSampler');
  const loader = Object.keys(graph).find(id => graph[id].class_type === 'UNETLoader');
  const ids = VIGGLE.ids;
  if (!sampler || !loader || !lora || fromPicture(graph) || Object.values(ids).some(id => graph[id])) {
    throw new Refusal('The graph has no KSampler sampling noise, no UNETLoader or a node where Viggle\'s go, or no LoRA is named');
  }
  const [id, { inputs }] = sampler;
  const out: Graph = structuredClone(graph);
  for (const node of Object.values(out)) {
    if (Array.isArray(node.inputs.model) && String(node.inputs.model[0]) === loader) node.inputs.model = [ids.lora, 0];
  }
  out[ids.lora] = { class_type: 'ViggleTurboLora', inputs: { model: [loader, 0], lora_name: lora, strength: VIGGLE.strength } };
  out[ids.noise] = { class_type: 'RandomNoise', inputs: { noise_seed: inputs.seed } };
  out[ids.guider] = { class_type: 'BasicGuider', inputs: { model: out[id].inputs.model, conditioning: inputs.positive } };
  out[ids.select] = { class_type: 'KSamplerSelect', inputs: { sampler_name: VIGGLE.sampler } };
  out[ids.sigmas] = { class_type: 'ViggleTurboSigmas', inputs: { latent: inputs.latent_image, nodes: VIGGLE.nodes } };
  out[id] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: [ids.noise, 0], guider: [ids.guider, 0], sampler: [ids.select, 0],
    sigmas: [ids.sigmas, 0], latent_image: inputs.latent_image } };
  return out;
}
// A graph that starts from a picture rather than from noise: its KSampler at a denoise below 1, or its latent not an
// EmptyLatentImage. Turbo leaves such a cell out and says so, rather than cut the six-step schedule the way the
// KSampler's denoise cuts its own: nobody distilled the LoRA for a cut one. Neither pinned graph does, so no cell of the
// pilot is left out.
export function fromPicture(graph: Graph) {
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const link = sampler?.inputs.latent_image, denoise = sampler?.inputs.denoise ?? 1;
  return !sampler || !Array.isArray(link) || graph[String(link[0])]?.class_type !== 'EmptyLatentImage' || typeof denoise !== 'number' || denoise < 1;
}
// Viggle's nodes on the server, by what /object_info/<class> says of each (server.py:816-822 at the pinned revision:
// `{}` for a class the server does not have), and whether ViggleTurboLora lists `lora` among the files in models/loras.
export async function viggleOn(comfy: Comfy, lora: string) {
  const signal = AbortSignal.any([AbortSignal.timeout(comfy.timeoutMs), ...(comfy.end ? [comfy.end] : [])]);
  const infos = await Promise.all(VIGGLE_NODES.map(async name => {
    const response = await fetch(`${comfy.baseUrl}/object_info/${name}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as Record<string, { input?: { required?: { lora_name?: unknown } } } | undefined>)[name];
  }));
  const files = infos[0]?.input?.required?.lora_name;
  return { nodes: infos.filter(Boolean).length, lora: Array.isArray(files) && Array.isArray(files[0]) && files[0].includes(lora) };
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
// The card's idle time in a cell's cycle, roughly: the cycle less the job's own time on the card, from its submit to
// its over, which is its `totalMs` less the download (`viewMs`). Round one's path downloads with the card idle, and
// round two's while the next job draws, so that the download counts as idle in the one and not in the other; on
// round two's path what is left is about the gap between the over of the job before and this one's submit.
const idle = (cell: PilotCell | undefined) => (cell?.cycleMs === undefined || cell.totalMs === undefined || cell.viewMs === undefined ? undefined
  : cell.cycleMs - (cell.totalMs - cell.viewMs));

// What the passes measured, in numbers and the cells' labels: each pass's times and peaks; what round two's path saved
// a cell, against the mean of the two baselines around it; the determinism check; and Triton's sampler against round
// two's path without it, its first pass against its second, and its pictures against the baseline's. A pass with a
// sampler answered from the cache is not a measurement of time, and says so (`comparable`). A directory of the backend
// measurement has its own passes and its own block (`backend`).
export function pilotReport(dir: string) {
  const record = readJson<PilotRecord>(join(resolve(dir), 'pilot.json'));
  if (!record) throw new Refusal(`No pilot.json in ${dir}: the pilot's draw writes it`);
  const pass = (name: PassName) => lastFinished(record, name);
  const cellIn = (one: PassRecord | undefined, cell: string) => one?.cells.find(each => each.cell === cell);
  const comparable = (list: (PassRecord | undefined)[]) => list.every(one => one?.cells.every(cell => cell.samplerCached === false));
  const peak = (values: (number | undefined)[]) => (known(values).length ? Math.max(...known(values)) : null);
  const commands = Object.keys(PASSES) as Command[];
  const measured = commands.filter(command => PASSES[command].some(plan => record.passes.some(one => one.name === plan.name)));
  const backendDir = measured.some(isBackend);
  const passes = Object.fromEntries(commands.filter(command => isBackend(command) === backendDir).flatMap(command => PASSES[command]).map(plan => {
    const one = pass(plan.name);
    return [plan.name, one ? { attempt: one.attempt, wallMs: one.wallMs, ...(one.pytorch && backendDir ? { pytorch: one.pytorch } : {}),
      ...(one.compile ? { compile: one.compile } : {}), cycleMs: Object.fromEntries(one.cells.map(cell => [cell.cell, cell.cycleMs ?? null])),
      totalMs: Object.fromEntries(one.cells.map(cell => [cell.cell, cell.totalMs ?? null])),
      sampleMs: Object.fromEntries(one.cells.map(cell => [cell.cell, whole(cell.phases?.sampleMs)])), meanIdleMs: whole(mean(one.cells.map(idle))),
      samplerCached: one.cells.filter(cell => cell.samplerCached === true).length,
      samplerUnheard: one.cells.filter(cell => cell.samplerCached === undefined).length, vramMiB: peak(one.cells.map(cell => cell.vramMiB)),
      ramMiB: peak(one.cells.map(cell => cell.ramMiB)),
      // Turbo's pictures are another schedule's, compared with none (`writeTurboPage` puts them beside the reference's).
      ...(plan.turbo ? {} : { changedVsBaseline: one.cells.filter(cell => cell.vsBaseline && !cell.vsBaseline.pixelsSame).length,
        ...(plan.against ? { changedVsReference: one.cells.filter(cell => cell.vsReference && !cell.vsReference.pixelsSame).length } : {}),
        sameAsRoundOne: one.cells.filter(cell => cell.vsRoundOne?.pixelsSame).length }),
      ...(one.skippedCells ? { skippedCells: one.skippedCells } : {}) } : null];
  }));
  const baseline = pass('baseline'), again = pass('baseline-again'), second = pass('round-two');
  const labels = baseline?.cells.map(cell => cell.cell) ?? [];
  const roundTwo = baseline && again && second ? (() => {
    const byCell = Object.fromEntries(labels.map(label => {
      const before = mean([cellIn(baseline, label)?.cycleMs, cellIn(again, label)?.cycleMs]), after = cellIn(second, label)?.cycleMs;
      const idleBefore = mean([idle(cellIn(baseline, label)), idle(cellIn(again, label))]), idleAfter = idle(cellIn(second, label));
      return [label, { baselineCycleMs: whole(before), roundTwoCycleMs: whole(after),
        savedMs: before === undefined || after === undefined ? null : Math.round(before - after), baselineIdleMs: whole(idleBefore), roundTwoIdleMs: whole(idleAfter),
        idleSavedMs: idleBefore === undefined || idleAfter === undefined ? null : Math.round(idleBefore - idleAfter) }];
    }));
    const rows = Object.values(byCell);
    return { comparable: comparable([baseline, again, second]), savedMsPerCell: whole(mean(rows.map(row => row.savedMs ?? undefined))),
      idleSavedMsPerCell: whole(mean(rows.map(row => row.idleSavedMs ?? undefined))), byCell };
  })() : null;
  const cold = pass('triton-cold'), warm = pass('triton-warm');
  const ratio = (top: number | undefined, bottom: number | undefined) => (top === undefined || !bottom ? null : Number((top / bottom).toFixed(3)));
  const total = (one: PassRecord | undefined, field: 'cycleMs' | 'totalMs') => {
    const list = one?.cells.map(cell => cell[field]) ?? [];
    return list.length && list.every(value => value !== undefined) ? list.reduce((sum, value) => sum + value!, 0) : undefined;
  };
  const triton = warm && second ? {
    kitchen: record.kitchen?.triton ?? null, dispatchVisible: false, comparable: comparable([second, warm]),
    sampleRatio: Object.fromEntries(labels.map(label => [label, ratio(cellIn(warm, label)?.phases?.sampleMs, cellIn(second, label)?.phases?.sampleMs)])),
    totalRatio: ratio(total(warm, 'totalMs'), total(second, 'totalMs')),
    coldExtraMs: whole(cold && total(cold, 'cycleMs') !== undefined && total(warm, 'cycleMs') !== undefined ? total(cold, 'cycleMs')! - total(warm, 'cycleMs')! : undefined),
    changedVsBaseline: warm.cells.filter(cell => cell.vsBaseline && !cell.vsBaseline.pixelsSame).length,
    warmSameAsCold: warm.cells.filter(cell => cell.vsEarlier?.pixelsSame).length, cells: warm.cells.length } : null;
  // The backend measurement: the reference's cold pass against its warm one, and against the reference's warm pass each
  // other command's warm sampler and cell times by cell and in all (a ratio below 1 is the faster), what its cold pass
  // took more a cell than its warm one (a compile pass's compiles), its pictures against the reference's, and its
  // peaks of video memory; cuda-compile against cuda's warm pass too. A command whose passes did not finish says how
  // its last attempts ended. The evidence: the torch each pass was drawn on and the log's word on the backends.
  const reference = pass('reference-warm');
  const marks = reference?.cells.map(cell => cell.cell) ?? [];
  const byCell = (value: (label: string) => number | null) => Object.fromEntries(marks.map(label => [label, value(label)]));
  const sampled = (cell: PilotCell | undefined) => cell?.phases?.sampleMs;
  const sumOf = (one: PassRecord | undefined, value: (cell: PilotCell) => number | undefined) => {
    const list = one?.cells.map(value) ?? [];
    return list.length && list.every(item => item !== undefined) ? list.reduce((sum, item) => sum + item!, 0) : undefined;
  };
  const times = (warmer: PassRecord, base: PassRecord) => ({ comparable: comparable([base, warmer]),
    sampleRatio: { ...byCell(label => ratio(sampled(cellIn(warmer, label)), sampled(cellIn(base, label)))), all: ratio(sumOf(warmer, sampled), sumOf(base, sampled)) },
    cellRatio: { ...byCell(label => ratio(cellIn(warmer, label)?.totalMs, cellIn(base, label)?.totalMs)),
      all: ratio(sumOf(warmer, cell => cell.totalMs), sumOf(base, cell => cell.totalMs)) } });
  const coldExtra = (first: PassRecord | undefined, warmer: PassRecord) => (first ? { ...byCell(label => {
    const before = cellIn(first, label)?.cycleMs, after = cellIn(warmer, label)?.cycleMs;
    return before === undefined || after === undefined ? null : before - after;
  }), all: whole(sumOf(first, cell => cell.cycleMs) === undefined || sumOf(warmer, cell => cell.cycleMs) === undefined ? undefined
    : sumOf(first, cell => cell.cycleMs)! - sumOf(warmer, cell => cell.cycleMs)!) } : null);
  // A pass that has not finished: its attempts, how the last one ended, with the cells that failed and their codes, and
  // whether it was skipped for too little time.
  const unfinished = (name: PassName) => {
    const tries = record.passes.filter(one => one.name === name), last = tries.at(-1);
    return { attempts: tries.length, ...(last ? { ended: last.ended, ...(last.error ? { error: last.error } : {}),
      failed: last.cells.filter(cell => cell.status === 'failed').map(cell => ({ cell: cell.cell, code: cell.code ?? null })) } : {}),
      ...(record.skipped?.includes(name) ? { skipped: 'too little time before --until' } : {}) };
  };
  const pair = (command: BackendCommand) => {
    const [coldPlan, warmPlan] = PASSES[command];
    const first = pass(coldPlan.name), warmer = pass(warmPlan.name);
    if (!warmer || !reference) return { finished: false as const, cold: first ? 'finished' : unfinished(coldPlan.name), warm: unfinished(warmPlan.name) };
    return { finished: true as const, ...(warmer.compile ? { compile: warmer.compile } : {}), vsReference: times(warmer, reference), coldExtraMs: coldExtra(first, warmer),
      pictures: Object.fromEntries(warmer.cells.map(cell => [cell.cell, cell.vsReference ?? null])),
      changedVsReference: warmer.cells.filter(cell => cell.vsReference && !cell.vsReference.pixelsSame).length,
      warmSameAsCold: warmer.cells.filter(cell => cell.vsEarlier?.pixelsSame).length,
      vramMiB: { cold: peak(first?.cells.map(cell => cell.vramMiB) ?? []), warm: peak(warmer.cells.map(cell => cell.vramMiB)),
        reference: peak(reference.cells.map(cell => cell.vramMiB)) } };
  };
  const cudaWarm = pass('cuda-warm'), cudaCompileWarm = pass('cuda-compile-warm');
  // Turbo: its warm sampler and cell times against the reference's warm pass, by cell and in all, what its cold pass took
  // more, its peaks, the LoRA, the cells it left out, and the page its pictures are on, beside the reference's, for the
  // owner's eye; no pixels, which are another schedule's.
  const turboCold = pass('turbo-cold'), turboWarm = pass('turbo-warm');
  const turbo = turboWarm && reference ? { finished: true as const, viggle: turboWarm.turbo ?? null, skippedCells: turboWarm.skippedCells ?? [],
    vsReference: times(turboWarm, reference), coldExtraMs: coldExtra(turboCold, turboWarm),
    vramMiB: { cold: peak(turboCold?.cells.map(cell => cell.vramMiB) ?? []), warm: peak(turboWarm.cells.map(cell => cell.vramMiB)),
      reference: peak(reference.cells.map(cell => cell.vramMiB)) },
    page: existsSync(join(resolve(dir), TURBO_PAGE)) ? TURBO_PAGE : null }
    : { finished: false as const, cold: turboCold ? 'finished' : unfinished('turbo-cold'), warm: unfinished('turbo-warm') };
  const backend = backendDir ? {
    torch: { reference: reference?.pytorch ?? null, cuda: cudaWarm?.pytorch ?? null },
    kitchen: Object.fromEntries((Object.keys(BACKEND) as BackendCommand[]).map(command => [command, record.kitchen?.[command] ?? null])), dispatchVisible: false,
    reference: reference ? { finished: true as const, coldExtraMs: coldExtra(pass('reference-cold'), reference),
      warmSameAsCold: reference.cells.filter(cell => cell.vsEarlier?.pixelsSame).length, vramMiB: peak(reference.cells.map(cell => cell.vramMiB)) }
      : { finished: false as const, cold: pass('reference-cold') ? 'finished' : unfinished('reference-cold'), warm: unfinished('reference-warm') },
    compile: pair('compile'), turbo, cuda: pair('cuda'),
    cudaCompile: { ...pair('cuda-compile'), ...(cudaCompileWarm && cudaWarm ? { vsCuda: times(cudaCompileWarm, cudaWarm) } : {}) },
  } : null;
  return { event: 'pilot_report', differsFromRoundOne: record.differsFromRoundOne ?? [], passes, determinism: record.determinism ?? null, roundTwo, triton, backend };
}

// ---- The turbo page ----

// Each cell's picture from the reference's warm pass beside turbo's, over the pictures the cell took into its slots,
// with the seconds of both, for the owner to judge by eye (docs/action-experiment.md#backend): faces roughly like the
// portraits', the figure and the silhouette kept everywhere; the very faces are not asked for. Turbo's warm pass is
// shown, else its cold one, else what its last attempt drew. The paths are relative, so that the page opens from the
// directory, and it carries labels, ids and seconds, never a prompt or a word of a story.
export const TURBO_PAGE = 'turbo.html';
export const CELL_WORDS: Record<string, string> = { front: 'фронтальный портрет, по тексту', view: 'вид: портрет, повёрнутый по слоту',
  A: 'кадр без портретов', V: 'кадр с видами среди слотов', T: 'кадр по картинке L и портретам' };
function writeTurboPage(dir: string, source: Source, record: PilotRecord) {
  const reference = lastFinished(record, 'reference-warm');
  const shown = lastFinished(record, 'turbo-warm') ?? lastFinished(record, 'turbo-cold') ?? record.passes.findLast(one => one.name.startsWith('turbo-'));
  const seconds = (ms: number | undefined) => (ms === undefined ? 'нет' : `${(ms / 1000).toFixed(1)} с`);
  const total = (one: PassRecord | undefined) => {
    const list = one?.cells.map(cell => cell.phases?.sampleMs) ?? [];
    return list.length && list.every(value => value !== undefined) ? list.reduce((sum, value) => sum + value!, 0) : undefined;
  };
  const stepsOf = (file: string) => String(Object.values(graphOf(file)).find(node => node.class_type === 'KSampler')?.inputs.steps ?? '?');
  const figure = (path: string | undefined, caption: string, missing: string, shape: 'half' | 'slot') => {
    const src = path && existsSync(path) ? escapeHtml(relative(dir, path).split(sep).join('/')) : undefined;
    return `<figure class="${shape}">${src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>` : `<div class="box">${escapeHtml(missing)}</div>`}`
      + `<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  const sections = TIMED.map(label => {
    const cell = source.cells.find(one => labelOf(one) === label)!;
    const plain = reference?.cells.find(one => one.cell === label), fast = shown?.cells.find(one => one.cell === label);
    const missing = shown?.skippedCells?.includes(label) ? 'турбо не рисовал: клетка начинается с картинки'
      : fast?.status === 'failed' ? `турбо не вышел: ${fast.code ?? 'без кода'}` : 'турбо не нарисован';
    const slots = cell.refs.map((ref, at) => figure(resolve(source.root, source.roundOne[referenceKey(source.plan, cell, ref)].file!),
      `слот ${at + 1}: ${ref === 'L' ? 'L' : source.plan.views.some(view => view.id === ref) ? 'вид' : 'портрет'}`, 'нет файла', 'slot'));
    return `<section><h2>${escapeHtml(label)}: ${escapeHtml(CELL_WORDS[label] ?? '')}</h2><div class="row">`
      + figure(plain?.file ? join(dir, plain.file) : undefined, `эталон, ${stepsOf(cell.kind === 'front' ? FRONT_GRAPH : ACTION_GRAPH)} шагов: сэмплер `
        + `${seconds(plain?.phases?.sampleMs)}, клетка ${seconds(plain?.totalMs)}`, 'эталон не нарисован', 'half')
      + figure(fast?.file ? join(dir, fast.file) : undefined, `турбо, ${TURBO_RECIPE.steps} шагов: сэмплер ${seconds(fast?.phases?.sampleMs)}, `
        + `клетка ${seconds(fast?.totalMs)}`, missing, 'half')
      + `</div>${slots.length ? `<div class="row">${slots.join('')}</div>` : '<p>Слотов у клетки нет.</p>'}</section>`;
  });
  const which = !shown ? 'Турбо не рисовался' : `Турбо: ${shown.name === 'turbo-warm' ? 'тёплый' : 'холодный'} проход, попытка ${shown.attempt}`
    + `${finished(shown) ? '' : `, не докончен (${shown.ended}${shown.error ? `, ${shown.error}` : ''})`}`;
  writeFileSync(join(dir, TURBO_PAGE), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Турбо: LoRA Viggle против эталона</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}figure{margin:0}
figure.half{width:calc((100% - 8px) / 2)}figure.slot{width:calc((100% - 48px) / 7)}img{width:100%;max-height:85vh;object-fit:contain;display:block}
.box{display:flex;align-items:center;justify-content:center;text-align:center;aspect-ratio:16/9;background:#eee;font-size:14px}
figure.slot .box{aspect-ratio:9/16}@media (max-width:640px){figure.half{width:100%}figure.slot{width:calc((100% - 16px) / 3)}}</style>
<h1>Турбо: LoRA Viggle в ${TURBO_RECIPE.steps} шагов против эталона</h1>
<p>Пять клеток пилота на одной карте, torch и Triton те же. Слева эталон: Qwen-Image 2.1 так, как рисует раунд два. Справа та же клетка с тем же
промптом, теми же слотами и тем же шумом (тот же сид), но через LoRA Viggle (${escapeHtml(shown?.turbo?.lora ?? 'не записана')}, сила ${VIGGLE.strength}) и её
расписание в ${TURBO_RECIPE.steps} шагов, euler, без CFG, как и эталон при cfg 1. Под парой картинки первого раунда, которые клетка получила в слоты.
Смотреть так, как решил владелец: лица примерно похожи на портреты, фигура и силуэт сохранены везде; точных лиц не нужно.</p>
<p>Эталон: ${reference ? `тёплый проход, попытка ${reference.attempt}` : 'не нарисован'}. ${escapeHtml(which)}. Сэмплер за пять клеток:
эталон ${seconds(total(reference))}, турбо ${seconds(total(shown))}.</p>
${sections.join('\n')}
`, { mode: 0o600 });
}

// ---- The dry run ----

// comfy-kitchen's lines as the pinned server logs them at its start (comfy/quant_ops.py:22-43), without Triton and with
// it. On the default torch, cu128, the CUDA backend is available and disabled, with the warning, as the card logged it
// on 2026-09-26. On cu130 (`torch`) the lines are modelled on the same code and no card has shown them yet: the CUDA
// backend available and on, and no warning; or, `unloaded`, its extension failing to load a library it needs.
export const kitchenLines = (triton: boolean, torch: 'cu128' | 'cu130' | 'unloaded' = 'cu128') => [
  ...(torch === 'cu128' ? ['WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations.'] : []),
  ...(triton ? ['Found triton 3.4.0. Enabling comfy-kitchen triton backend.'] : []),
  `Found comfy_kitchen backend cuda: {'available': ${torch === 'unloaded' ? 'False' : 'True'}, 'disabled': ${torch === 'cu128' ? 'True' : 'False'}, `
    + `'unavailable_reason': ${torch === 'unloaded' ? '\'libcublasLt.so.13: cannot open shared object file: No such file or directory\'' : 'None'}, 'capabilities': []}`,
  'Found comfy_kitchen backend eager: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}',
  `Found comfy_kitchen backend triton: {'available': True, 'disabled': ${triton ? 'False' : 'True'}, 'unavailable_reason': None, 'capabilities': []}`];

// A made-up round one of flight alone: four people, the first turned to the right so that it has a view, and `word`
// in the setting, so that every frame's prompt carries it.
export function madeUpRoundOne(root: string, word: string) {
  const ok = { outcome: 'ok' as const, attempts: 1, ms: 1 };
  const sheet = ['Бранд', 'Лиэль', 'Орм', 'Ивла'].map((name, at) => ({ name, look: `An adult with hair ${at}`, outfit: `a tunic ${at}` }));
  const scene = { moment: 'They hold on', shot: 'Medium wide shot', setting: `A hangar at ${word}`, objects: '', props: '', light: 'Evening' };
  const text: StoryText = { id: PILOT_STORY, pins: '', steps: { opening: ok, action: ok, sheet: ok, frame: ok, variant: ok, retell: ok }, sheet, worn: sheet,
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
// with the Triton backend, whose pictures differ from the baseline's, then `report`. Then the backend measurement in a
// directory of its own: `reference` and `compile` on a server of the default torch with Triton, whose twelfth job
// fails, `turbo` on one started again with Viggle's two nodes as /object_info lists them, and `cuda` and `cuda-compile`
// on one started again on cu130, whose log line of the CUDA backend is modelled (`kitchenLines`), then its `report`. On
// the way, the refusals the paid pilot relies on, and at the end the search for the scene's made-up word in everything
// the pilot wrote and printed.
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
  // Each job lasts until the memory has been sampled while it ran, as round one's smoke asks (fake-comfy.ts `untilSampled`).
  const started = { jobMs: 15, referenceMs: 0, requireUploads: true, untilSampled: true, marker: word };
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
      seeded: {}, roundTwo: true }));
    expect(!existsSync(join(dry, 'sharp')), 'nothing is written for a sharp cell');

    const drawn = await run('draw');
    const record = () => readJson<PilotRecord>(join(dir, 'pilot.json'))!;
    say(`2 draw: ${JSON.stringify(drawn)}`);
    expect(drawn.done && PASSES.draw.every(one => lastFinished(record(), one.name)), 'every pass of draw finishes');
    expect(record().determinism?.verdict === 'same', 'the determinism check finds the same picture');
    const drawCells = PASSES.draw.flatMap(one => lastFinished(record(), one.name)?.cells ?? []);
    expect(drawCells.length === 18 && drawCells.every(cell => cell.samplerCached === false && cell.sha256 && cell.vsRoundOne), 'every cell is heard, hashed and compared with round one');
    expect((['round-two', 'baseline-again'] as const).every(name => lastFinished(record(), name)!.cells.every(cell => cell.vsBaseline?.pixelsSame === true)),
      'the same cells come out as the baseline\'s');
    const jobs = fake.jobs.length;
    await run('draw');
    say(`   draw again: ${fake.jobs.length - jobs} jobs; the most jobs the card held at once: ${fake.mostHeld}`);
    expect(fake.jobs.length === jobs, 'a finished draw draws nothing again');
    expect(fake.mostHeld === 1, 'the card never held two jobs at once on either path');

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
    expect(report.determinism?.verdict === 'same' && report.roundTwo?.comparable === true && report.triton !== null && report.backend === null,
      'the report has every block');

    const manifest = readManifest(MANIFEST), cudaDir = join(dry, 'pilot-cuda'), argv = ['main.py', '--enable-triton-backend'];
    mkdirSync(cudaDir, { recursive: true, mode: 0o700 });
    writeCardRecord(join(cudaDir, 'card.txt'));
    const measure = (command: BackendCommand, at = cudaDir, end = until) => pilotCommand(command, { dir: at, source, comfy: fake.url, until: end,
      pollMs: 10, waitMs: 20000, timeoutMs: 10000 });
    await fake.close();
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_VERSION, picturesByGraph: true, failJobs: [12], startupLog: kitchenLines(true) });
    say(`   the server started again on ${manifest.TORCH_VERSION} with Triton, for the backend measurement in ${cudaDir}`);
    await refused('cuda on the default torch', () => measure('cuda'));
    await refused('compile before the reference', () => measure('compile'));
    await refused('the reference in the pilot\'s directory', () => measure('reference', dir));
    const referenced = await measure('reference');
    say(`5 reference: ${JSON.stringify(referenced)}`);
    expect(referenced.done && referenced.pytorch === manifest.TORCH_VERSION && fake.jobs.length === 10
      && fake.jobs.every(job => job.sampler === 'KSampler' && !job.model.includes('TorchCompileModel')), 'the reference draws its ten cells without the compile node');
    const late = await measure('compile', cudaDir, Date.now() + 5 * 60000);
    say(`   compile five minutes before --until: ${JSON.stringify(late)}`);
    expect(!late.done && late.skipped === 'compile-cold' && fake.jobs.length === 10, 'compile with less than its ten minutes left is skipped and draws nothing');
    const broken = await measure('compile');
    say(`   compile, its second job failing: ${JSON.stringify(broken)}`);
    expect(!broken.done && broken.stopped === 'compile-cold' && broken.failed?.[0]?.code === 'image_failed' && fake.jobs.length === 12,
      'a job that fails under compile ends the pass there, its code kept');
    const midway = pilotReport(cudaDir).backend?.compile;
    expect(midway?.finished === false && typeof midway.cold === 'object' && midway.cold.failed?.[0]?.cell === 'view' && midway.cold.skipped !== undefined,
      'the report says how compile ended, and that it was once skipped');
    const compiled = await measure('compile');
    const overs = fake.jobs.slice(10).map(job => job.model.join(' < '));
    say(`   compile again: ${JSON.stringify(compiled)}`);
    expect(compiled.done && overs.length === 12 && overs.filter(one => one === 'TorchCompileModel < UNETLoader').length === 3
      && overs.filter(one => one === 'TorchCompileModel < QwenImage21Cache < UNETLoader').length === 9,
      'the compile node sits before every sampler, after QwenImage21Cache in a frame\'s graph');

    // Turbo: refused on the reference's server, and drawn on one started again with Viggle's two nodes, on which no other
    // command draws.
    await refused('turbo on a server without Viggle\'s nodes', () => measure('turbo'));
    await fake.close();
    const viggleInfo = { ViggleTurboLora: { input: { required: { model: ['MODEL'], lora_name: [[manifest.IMAGE_VIGGLE_LORA_FILE], {}], strength: ['FLOAT', {}] } } },
      ViggleTurboSigmas: { input: { required: { latent: ['LATENT'], nodes: ['STRING', { default: VIGGLE.nodes }] } } } };
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_VERSION, startupLog: kitchenLines(true),
      objectInfo: { ViggleTurboSigmas: viggleInfo.ViggleTurboSigmas } });
    await refused('turbo on a server with one of Viggle\'s nodes', () => measure('turbo'));
    await fake.close();
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_VERSION, startupLog: kitchenLines(true), objectInfo: viggleInfo });
    say('   the server started again with Viggle\'s nodes, SIMPLE_CHAT_IMAGE_VIGGLE=true');
    await refused('compile on a server with Viggle\'s nodes', () => measure('compile'));
    const turbo = await measure('turbo');
    const paths = fake.jobs.map(job => job.model.join(' < '));
    say(`   turbo: ${JSON.stringify(turbo)}`);
    expect(turbo.done && fake.jobs.length === 10 && fake.jobs.every(job => job.sampler === 'SamplerCustomAdvanced')
      && paths.filter(one => one === 'ViggleTurboLora < UNETLoader').length === 2 && paths.filter(one => one === 'QwenImage21Cache < ViggleTurboLora < UNETLoader').length === 8,
      'turbo samples every cell through the LoRA, which QwenImage21Cache takes in a frame\'s graph');
    const turboWarm = lastFinished(readJson<PilotRecord>(join(cudaDir, 'pilot.json'))!, 'turbo-warm');
    const turboIndex = turboWarm && readJson<DrawIndex>(join(cudaDir, turboWarm.dir, 'draw.json'));
    const turboCells = Object.values(turboIndex?.cells ?? {}).filter(one => one.key.startsWith(PREFIX));
    expect(turboCells.length === 5 && turboCells.every(one => one.steps === TURBO_RECIPE.steps && one.scheduler === TURBO_RECIPE.scheduler)
      && turboWarm?.cells.every(cell => !cell.vsReference && !cell.vsRoundOne) === true, 'turbo\'s records say its six steps, and its pictures are compared with none');
    const page = existsSync(join(cudaDir, TURBO_PAGE)) ? readFileSync(join(cudaDir, TURBO_PAGE), 'utf8') : '';
    const reference = lastFinished(readJson<PilotRecord>(join(cudaDir, 'pilot.json'))!, 'reference-warm');
    expect([...turboWarm?.cells ?? [], ...reference?.cells ?? []].every(cell => cell.file && page.includes(cell.file.split(sep).join('/')))
      && (page.match(/<section>/g) ?? []).length === 5, 'the page puts each cell\'s turbo picture beside the reference\'s');

    await fake.close();
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_CU130_VERSION, startupLog: [] });
    await refused('cuda on a server whose log has no word of the backends', () => measure('cuda'));
    await fake.close();
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_CU130_VERSION, startupLog: kitchenLines(true, 'unloaded') });
    await refused('cuda on a server whose log says the CUDA backend did not load', () => measure('cuda'));
    await fake.close();
    fake = await startFakeComfy({ ...started, argv, pytorch: manifest.TORCH_CU130_VERSION, startupLog: kitchenLines(true, 'cu130') });
    say(`   the server started again on ${manifest.TORCH_CU130_VERSION} with Triton, its log line of the CUDA backend modelled`);
    await refused('the reference on the cu130 torch', () => measure('reference'));
    const cuda = await measure('cuda'), both = await measure('cuda-compile');
    say(`6 cuda: ${JSON.stringify(cuda)}; cuda-compile: ${JSON.stringify(both)}`);
    expect(cuda.done && both.done && cuda.pytorch === manifest.TORCH_CU130_VERSION && cuda.kitchen?.cuda?.available === true
      && cuda.kitchen.cuda.disabled === false && cuda.kitchen.cudaNeedsCu130 === false, 'cuda and cuda-compile draw on cu130 with the CUDA backend on');
    const measured = pilotReport(cudaDir), block = measured.backend;
    say(`7 report: ${JSON.stringify(measured)}`);
    expect(block?.torch.reference === manifest.TORCH_VERSION && block.torch.cuda === manifest.TORCH_CU130_VERSION && block.reference.finished
      && block.compile.finished && block.compile.changedVsReference === 5 && block.compile.warmSameAsCold === 5 && typeof block.compile.coldExtraMs?.all === 'number'
      && block.cuda.finished && block.cuda.changedVsReference === 5 && typeof block.cuda.vsReference.cellRatio.all === 'number'
      && block.turbo.finished && typeof block.turbo.vsReference.sampleRatio.all === 'number' && block.turbo.page === TURBO_PAGE
      && block.turbo.skippedCells.length === 0 && block.turbo.viggle?.lora === manifest.IMAGE_VIGGLE_LORA_FILE
      && block.cudaCompile.finished && 'vsCuda' in block.cudaCompile && measured.roundTwo === null && measured.triton === null
      && Object.keys(measured.passes).every(name => /^(reference|compile|turbo|cuda|cuda-compile)-(cold|warm)$/.test(name)), 'the report has the backend block');
    // The word is in round one's plans, which the pilot read; it must be nowhere the pilot wrote or printed.
    const forms = markerForms(word);
    const searched = [dir, cudaDir].map(one => searchTree(one, forms)), inRoundOne = searchTree(source, forms).hits.length;
    const found = { files: searched.reduce((sum, one) => sum + one.files, 0), unread: searched.flatMap(one => one.unread), hits: searched.flatMap(one => one.hits) };
    const printed = forms.some(form => Buffer.from(output.text(), 'utf8').includes(form));
    const sealed = readdirSync(dry, { recursive: true, withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === 'sealed').length;
    say(`8 boundary: ${found.files} files in the pilot's two directories, ${found.unread.length} unread, ${found.hits.length} with the word, which round one's `
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
export function safeError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const own = typeof code === 'string' && CODES.has(code) ? { code } : {};
  if (error instanceof Refusal) return { message: error.message, ...own };
  const name = error instanceof Error ? (CLASSES.has(error.name) ? error.name : 'other') : typeof error;
  return { error: name, ...own, ...safeErrorDetails(error) };
}

const USAGE = 'Use: image-pilot.ts draw|triton|reference|compile|turbo|cuda|cuda-compile --until <epoch seconds, five minutes before the card\'s end> '
  + '[--dir illustrations/pilot, or illustrations/pilot-cuda for the last five] [--from illustrations/action-1] [--wait 600, ten minutes at most '
  + 'under compile] [--timeout 60] [--comfy http://127.0.0.1:8188], report [--dir], or dry-run [--dir] (docs/action-experiment.md#pilot, #backend)';
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
  const dir = resolve(values.dir ?? (isBackend(command) ? BACKEND_DIR : PILOT_DIR));
  if (command === 'report') return print(pilotReport(dir));
  if (command !== 'draw' && command !== 'triton' && !isBackend(command)) throw new Refusal(USAGE);
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
