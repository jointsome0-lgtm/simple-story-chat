// The figure card test (docs/illustrations-plan.md#figure-card-test), for the picture card after round two's draw and
// before the body test. It asks what no text check can: whether Qwen-Image 2.1 draws the words of a build as
// proportions or averages them, whether the kept front as a reference keeps the build where the words alone do not,
// whether two alike people stay apart in one frame, whether "looks about N" moves the age a person looks, whether
// graded words keep four figures apart, and what a game character named for a figure does. 34 pictures in six arms,
// for the owner's eye on one page, with no scores.
// The texts are figure-age's of 2026-09-27, fixed before the card: 34 cells in the order drawn, each with its key, arm,
// kind, seed, graph, canvas, references and exact prompt, built from synthetic texts by the bot's own recipes
// (`portraitPrompt` for a front, `variantPrompt` for a frame, A+ from words and C with the kept front as image 1). They
// lie in illustrations/figure-card/texts.json and stay out of the repository, as the body test's bodies.json does:
// this file pins their sha256, refuses any other file, and holds every cell to PLAN below.
// Every picture is drawn by the bot's model and recipe as the graphs pin them, at the cell's seed, with no turbo and no
// TorchCompileModel:
//   a front   on gpu/image-workflow-qwen.json (FRONT_GRAPH), its latent turned upright to 720x1280, as round two's fronts;
//   a frame   on gpu/image-workflow-qwen-action.json (ACTION_GRAPH) at 1280x704 with no reference, as round two's A+;
//   a C frame on the same graph with the front hard-retold at seed 7 as image 1, scaled by area to 352x640, as round
//             two's C.
// In the texts' order: the 12 fronts, the 16 frames from words, then the 6 C frames, which need the kept front. A C
// frame whose front failed is `out`, and a resume draws the front again before it.
// The commands read illustrations/figure-card/texts.json and card.txt and the pilot's times in illustrations/pilot;
// they write illustrations/figure-card alone. Only `dry-run` takes another --dir:
//   estimate  the cells and their minutes at the pilot's warm times with Triton, before a card is rented
//   draw      on the picture card, --until EPOCH: cell by cell, each begun only if it can end by --until
//   page      index.html: a section an arm, the pictures compared side by side a seed, each prompt folded under its
//             picture; `draw` also writes it before the first cell and after every cell
//   dry-run   all of it against local/fake-comfy.ts, from made-up texts
// What it prints is keys, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CLEANUP_RESERVE_MS, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, comfyUrl, drawOne, logLines, partialLoadsSince, pngSize,
  samplerSettingsOf, serverPins, settled, stopsTheRun, stripPngMetadata, uploadReference } from './image-batch.ts';
import type { Comfy, Graph, Phases } from './image-batch.ts';
import { ACTION_GRAPH, CELL_MS, DRAW_CODES, FRAME_CANVAS, FRONT_GRAPH, MARGIN, SCALED, WAIT_MS, actionGraph } from './action-draw.ts';
import { portraitCanvas } from './image-portraits.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { PILOT_DIR, kitchenOf } from './image-pilot.ts';
import type { PilotRecord } from './image-pilot.ts';
import { readJson } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { escapeHtml } from './action-judge.ts';
import { safeError } from './image-action.ts';
import { safeErrorDetails } from './model-error.ts';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeJob } from './fake-comfy.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'illustrations', 'figure-card');
const PILOT_FILE = join(PILOT_DIR, 'pilot.json');
// texts.json: figure-age's figure-card-texts.json as it wrote it on 2026-09-27, byte for byte.
const TEXTS_FILE = 'texts.json';
const TEXTS_SHA256 = 'db21e09a17db7fd987a0664c5e641a15444a0216d43d2fbe8e6cb2a2acdb76fc';
const INDEX_FILE = 'cells.json';
// The front every C frame takes as image 1, fixed before the card: the hard case's retold front at seed 7.
const KEPT = 'front:hard-retold:s7';
// As the body test prices: the first job of a run pays Triton's compile (the pilot's cold front took 31 s against 6 s
// warm), and the first job of each other group a compile of its own; a group the pilot left no time for costs a
// minute. A socket that did not open is waited out this long, once.
const COLD_MS = 45000, SHAPE_MS = 15000, FALLBACK_MS = 60000, RETRY_PAUSE_MS = 3000;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const minutes = (ms: number) => Math.round(ms / 6000) / 10;
const seconds = (ms: number | undefined) => (ms === undefined ? 'нет' : String(Math.round(ms / 100) / 10).replace('.', ','));
// A count and its noun as Russian says them: 1 картинка, 2 картинки, 5 картинок.
const counted = (n: number, one: string, few: string, many: string) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return !sorted.length ? undefined : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const workflowError = () => Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
const noLink = (path: string) => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${path} is a link: nothing is read through it`);
};

// ---- The plan ----

type Kind = 'front' | 'frame';
// What a cell is drawn as, and what it is priced and timed with: a front, a frame from words, a C frame.
type Group = 'front' | 'words' | 'C';
const GROUPS: Group[] = ['front', 'words', 'C'];
const GROUP_NAMES: Record<Group, string> = { front: 'фронты', words: 'кадры по словам', C: 'кадры C' };
type Size = { width: number; height: number };
const TWO = [7, 11], THREE = [7, 11, 13];
// The card's cells in the order drawn, as texts.json lists them: an id, its kind and arm, its seeds, the fronts it
// takes as images, and what the page calls it.
const PLAN: { id: string; kind: Kind; arm: number; seeds: number[]; references?: string[]; label: string }[] = [
  { id: 'hard-retold', kind: 'front', arm: 1, seeds: TWO, label: 'из английского пересказа' },
  { id: 'hard-table', kind: 'front', arm: 1, seeds: TWO, label: 'из таблицы как написана' },
  { id: 'hard-aged', kind: 'front', arm: 4, seeds: TWO, label: 'пересказ и «looks about 22»' },
  { id: 'grace-words', kind: 'front', arm: 6, seeds: THREE, label: 'только слова' },
  { id: 'grace-named', kind: 'front', arm: 6, seeds: THREE, label: 'слова и фигура по имени' },
  { id: 'market-words', kind: 'frame', arm: 2, seeds: TWO, label: 'рынок, по словам' },
  { id: 'crates-words', kind: 'frame', arm: 2, seeds: TWO, label: 'ящики, по словам' },
  { id: 'porch-words', kind: 'frame', arm: 2, seeds: TWO, label: 'крыльцо, по словам' },
  { id: 'pair-without', kind: 'frame', arm: 3, seeds: TWO, label: 'пересказаны порознь (without)' },
  { id: 'pair-with', kind: 'frame', arm: 3, seeds: TWO, label: 'пересказаны вместе (with)' },
  { id: 'gym-words', kind: 'frame', arm: 5, seeds: TWO, label: 'внешности как есть' },
  { id: 'gym-order', kind: 'frame', arm: 5, seeds: TWO, label: 'с порядком слева направо' },
  { id: 'gym-grace', kind: 'frame', arm: 6, seeds: TWO, label: 'у одной фигура по имени' },
  { id: 'market-C', kind: 'frame', arm: 2, seeds: TWO, references: [KEPT], label: 'рынок, фронт картинкой 1 (C)' },
  { id: 'crates-C', kind: 'frame', arm: 2, seeds: TWO, references: [KEPT], label: 'ящики, фронт картинкой 1 (C)' },
  { id: 'porch-C', kind: 'frame', arm: 2, seeds: TWO, references: [KEPT], label: 'крыльцо, фронт картинкой 1 (C)' },
];
type Planned = { key: string; id: string; kind: Kind; arm: number; seed: number; group: Group; references: string[]; label: string; file: string };
const PLANNED: Planned[] = PLAN.flatMap(one => one.seeds.map(seed => ({ key: `${one.kind}:${one.id}:s${seed}`, id: one.id, kind: one.kind, arm: one.arm,
  seed, group: (one.kind === 'front' ? 'front' : one.references ? 'C' : 'words') as Group, references: one.references ?? [], label: one.label,
  file: join(one.kind === 'front' ? 'fronts' : 'frames', `${one.id}-s${seed}.png`) })));
const canvasOf = (one: { kind: Kind }, front: Size) => (one.kind === 'front' ? front : FRAME_CANVAS);
const sizeText = (size: Size) => `${size.width}x${size.height}`;

// ---- The texts ----

type TextCell = { key: string; arm: string; kind: Kind; seed: number; graph: 'front' | 'action'; canvas: string; references: string[]; prompt: string };
type Texts = { hash: string; cells: Map<string, TextCell> };
// texts.json, read as the body test reads bodies.json: a link, a missing file and a file other than the one pinned are
// refused, and so is one whose cells are not PLAN's, key by key in its order, each on its graph and canvas with the
// fronts PLAN gives it as images, and with a prompt.
function readTexts(out: string, pinned: string, front: Size): Texts {
  const file = join(resolve(out), TEXTS_FILE);
  noLink(file);
  if (!existsSync(file)) throw new Refusal(`${file} is missing: the texts are fixed before the card, and nothing is drawn`);
  const bytes = readFileSync(file), bad = (why: string) => new Refusal(`${file} ${why}; nothing is drawn from it`);
  if (sha256(bytes) !== pinned) throw bad('is not the texts fixed before the card, whose sha256 image-figure-test.ts pins');
  let read: unknown;
  try { read = JSON.parse(bytes.toString('utf8')); } catch { throw bad('is not JSON'); }
  const cells = typeof read === 'object' && read !== null ? (read as { cells?: unknown }).cells : undefined;
  if (!Array.isArray(cells) || cells.length !== PLANNED.length) throw bad(`does not hold the card's ${PLANNED.length} cells`);
  const found = new Map<string, TextCell>();
  PLANNED.forEach((one, at) => {
    const cell = cells[at] as Partial<TextCell> | null;
    const right = typeof cell === 'object' && cell !== null && cell.key === one.key && cell.kind === one.kind && cell.seed === one.seed
      && typeof cell.arm === 'string' && Number.parseInt(cell.arm, 10) === one.arm && cell.graph === (one.kind === 'front' ? 'front' : 'action')
      && cell.canvas === sizeText(canvasOf(one, front)) && same(cell.references, one.references) && typeof cell.prompt === 'string' && cell.prompt.trim() !== '';
    if (!right) throw bad(`has as its cell ${at + 1} no ${one.key} of arm ${one.arm} on its graph and canvas, with its references and a prompt`);
    found.set(one.key, cell as TextCell);
  });
  return { hash: sha256(bytes), cells: found };
}

// ---- The prices ----

type Prices = { from: string; groups: Record<Group, { expected: number; price: number }> };
// A cell's time at the pilot's last finished warm pass with Triton (illustrations/pilot/pilot.json), uploads
// included: a front by its front, a frame from words by its A, and a C frame by its V, the edit with the fewest
// references at or above C's one that the pass drew (action-draw.ts `pricing`). The price is that time a quarter more
// and three seconds, as round two prices.
function pricesOf(file: string): Prices {
  const record = readJson<PilotRecord>(file);
  const pass = record?.passes?.findLast(one => one.name === 'triton-warm' && one.ended === 'done' && one.cells.length > 0
    && one.cells.every(cell => cell.status === 'drawn' && !cell.outageMs));
  const of = (name: string) => {
    const cell = pass?.cells.find(one => one.cell === name && one.totalMs !== undefined);
    const ms = cell ? cell.totalMs! + (cell.uploadMs ?? 0) : undefined;
    return ms === undefined ? { expected: FALLBACK_MS, price: FALLBACK_MS } : { expected: ms, price: Math.round(ms * MARGIN + CELL_MS) };
  };
  return { from: pass ? `${pass.name} ${pass.attempt}` : 'none', groups: { front: of('front'), words: of('A'), C: of('V') } };
}
// What `cells` cost from here at the admission prices: the run's first cell with the compile and each other group's
// first with its own, unless a job of the run has reached the card (`reached`) or of that group (`seen`).
function needOf(cells: Planned[], prices: Prices, reached = false, seen: Set<Group> = new Set()) {
  let any = reached;
  const groups = new Set(seen);
  return cells.reduce((sum, one) => {
    const extra = !any ? COLD_MS : groups.has(one.group) ? 0 : SHAPE_MS;
    any = true;
    groups.add(one.group);
    return sum + prices.groups[one.group].price + extra;
  }, 0);
}
const expectedOf = (cells: Planned[], prices: Prices) => cells.reduce((sum, one) => sum + prices.groups[one.group].expected, 0) + (cells.length ? COLD_MS / 2 : 0);

// ---- What is drawn from ----

type Recipe = { steps: number; sampler: string; scheduler: string; cfg: number };
const recipeOf = (graph: Graph): Recipe => {
  const own = samplerSettingsOf(graph);
  return { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler,
    scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler, cfg: own.cfg ?? SAMPLER_DEFAULTS.cfg };
};
type Inputs = { texts: Texts; frontGraph: Graph; base: Graph; frontCanvas: Size; recipes: Record<Kind, Recipe>; prices: Prices };
function inputsOf(out: string, pilot: string, pinned: string): Inputs {
  const frontGraph = apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))), base = apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
  const frontCanvas = portraitCanvas(frontGraph);
  return { texts: readTexts(out, pinned, frontCanvas), frontGraph, base, frontCanvas, recipes: { front: recipeOf(frontGraph), frame: recipeOf(base) },
    prices: pricesOf(pilot) };
}
type Setup = Inputs & { card: ReturnType<typeof cardOf>; pins: Record<string, string> };
// And the card's record at <out>/card.txt. The pins are all a picture here depends on beyond the server: the texts,
// both graphs, whose recipes they carry, the canvases, the reference's size and the weights the card verified. A
// resume under any other, or on a server that says another thing of itself, is refused.
function setupOf(out: string, pilot: string, pinned: string): Setup {
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(out, 'card.txt')); }
  catch { throw new Refusal(`${join(out, 'card.txt')} is missing or differs from gpu/image-manifest.env: copy the card's image-verified.txt there first; nothing is drawn`); }
  const inputs = inputsOf(out, pilot, pinned);
  return { ...inputs, card, pins: { texts: inputs.texts.hash, frontGraph: sha256(readFileSync(FRONT_GRAPH)), actionGraph: sha256(readFileSync(ACTION_GRAPH)),
    frontCanvas: sizeText(inputs.frontCanvas), frameCanvas: sizeText(FRAME_CANVAS), referenceSize: sizeText(SCALED), comfyuiRevision: card.comfyuiRevision,
    transformer: card.transformer, encoder: card.encoder, vae: card.vae } };
}

// The cells, their groups and minutes: expected at the pilot's times with half a compile, and at the prices a cell is
// admitted by, with the compile of the first cell and of each other group.
function estimateOf(inputs: Inputs) {
  const count = (group: Group) => PLANNED.filter(one => one.group === group).length;
  return { cells: PLANNED.length, fronts: count('front'), words: count('words'), withReference: count('C'),
    expectedMinutes: minutes(expectedOf(PLANNED, inputs.prices)), pricedMinutes: minutes(needOf(PLANNED, inputs.prices)), from: inputs.prices.from,
    cellSeconds: Object.fromEntries(GROUPS.map(group => [group, { expected: Math.round(inputs.prices.groups[group].expected / 100) / 10,
      priced: Math.round(inputs.prices.groups[group].price / 100) / 10 }])) };
}

// ---- The graphs ----

// A cell's graph as round two builds it (action-draw.ts `prepare`): a front on the front graph as pinned at the front's
// canvas; a frame on the action graph, a scale node to 352x640 on slot 1 for C, every slot it leaves empty gone with
// its loader; each graph's own recipe, the cell's seed and prompt, and no negative words.
function buildJob(setup: Setup, one: Planned, prompt: string, names: string[]): Graph {
  const front = one.kind === 'front';
  return applyToWorkflow(front ? setup.frontGraph : actionGraph(setup.base, names.map((_, at) => at + 1)).graph, { checkpoint: setup.card.model, prompt,
    negative: '', seed: one.seed, ...setup.recipes[one.kind], ...canvasOf(one, setup.frontCanvas), ...(front ? {} : { references: names }) });
}
// A cell's graph as it goes out, read from the sampler and the save rather than by the ids the graphs give: the recipe
// and the seed at full denoise from an empty latent of the cell's canvas; the prompt on Qwen's encoder, both
// conditionings from it, and no negative words; the model from the loader of the card's transformer, through the
// action graph's cache on a frame and nothing else; each slot an upload scaled by area to 352x640, the kept front's
// for C and none otherwise; and one save, of the sampler's decode.
function cellRight(graph: Graph, one: Planned, prompt: string, names: string[], setup: Setup): boolean {
  const from = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
  const nodes = Object.values(graph), canvas = canvasOf(one, setup.frontCanvas), recipe = setup.recipes[one.kind];
  const samplers = nodes.filter(node => node.class_type === 'KSampler'), saves = nodes.filter(node => node.class_type === 'SaveImage');
  if (samplers.length !== 1 || saves.length !== 1) return false;
  const sampler = samplers[0].inputs, positive = from(sampler.positive), latent = from(sampler.latent_image);
  const sampled = sampler.seed === one.seed && sampler.steps === recipe.steps && sampler.sampler_name === recipe.sampler
    && sampler.scheduler === recipe.scheduler && sampler.cfg === recipe.cfg && sampler.denoise === 1 && latent?.class_type === 'EmptyLatentImage'
    && latent.inputs.width === canvas.width && latent.inputs.height === canvas.height && latent.inputs.batch_size === 1;
  const worded = positive?.class_type === 'TextEncodeQwenImage21' && from(sampler.negative) === positive && positive.inputs.prompt === prompt
    && positive.inputs.negative_prompt === '';
  const model: Graph[string][] = [];
  for (let node = from(sampler.model); node && model.length < 8; node = from(node.inputs.model)) model.push(node);
  const modelled = same(model.map(node => node.class_type), one.kind === 'front' ? ['UNETLoader'] : ['QwenImage21Cache', 'UNETLoader'])
    && model.at(-1)?.inputs.unet_name === setup.card.model;
  const slots = Object.entries(positive?.inputs ?? {}).filter(([key]) => /^images\.image_\d+$/.test(key)).map(([key, link]) => {
    const scale = from(link), loader = from(scale?.inputs.image);
    return [key, scale?.class_type, scale?.inputs.upscale_method, scale?.inputs.width, scale?.inputs.height, scale?.inputs.crop, loader?.class_type,
      loader?.inputs.image];
  });
  const slotted = names.length === one.references.length && nodes.filter(node => node.class_type === 'LoadImage').length === names.length
    && same(slots, names.map((name, at) => [`images.image_${at + 1}`, 'ImageScale', 'area', SCALED.width, SCALED.height, 'disabled', 'LoadImage', name]));
  const decoded = from(saves[0].inputs.images);
  return sampled && worded && modelled && slotted && decoded?.class_type === 'VAEDecode' && from(decoded.inputs.samples) === samplers[0];
}

// ---- The drawing ----

// `reference`: the sha256 of the front a C frame took as image 1.
type Cell = { key: string; id: string; kind: Kind; arm: number; seed: number; group: Group; references: number; triton: boolean;
  status: 'drawn' | 'failed' | 'out'; code?: string; httpStatus?: number; oom?: boolean; retried?: boolean; file?: string; sha256?: string; bytes?: number;
  width?: number; height?: number; reference?: string; cold?: boolean; firstOfGroup?: boolean; totalMs?: number; viewMs?: number; queueMs?: number;
  sampleMs?: number; phases?: Phases; loaderCacheMiss?: boolean; uploadMs?: number; vramSamples?: number; partialModelLoadEvents?: number; promptChars?: number };
type KitchenRecord = { seen: boolean; argv: boolean; tritonImported: boolean; tritonImportFailed: boolean; backend: { available: boolean; disabled: boolean } | null };
// cells.json: keys, codes, sizes, counts and times, no prompt. `server`: what the server said it is, triton among it
// when it runs comfy-kitchen's Triton backend; `kitchen`: what its log said of the backends at its start.
type FiguresIndex = { startedAt: string; completedAt?: string; pins: Record<string, string>; server: Record<string, string>; triton: boolean;
  kitchen?: KitchenRecord; cells: Record<string, Cell>; stopped?: 'until'; error?: string };
// `keys`: the dry run's, the cells a run draws, in PLAN's order; every one otherwise.
type Options = { out: string; pilot: string; comfy: string; until: number; pinned: string; keys?: string[]; timeoutMs?: number; waitMs?: number;
  pollMs?: number; log: (event: object) => void };
const countsOf = (index: FiguresIndex) => {
  const cells = Object.values(index.cells), tally = (status: Cell['status']) => cells.filter(one => one.status === status)
    .reduce<Record<string, number>>((all, one) => ({ ...all, [one.code ?? 'image_failed']: (all[one.code ?? 'image_failed'] ?? 0) + 1 }), {});
  return { drawn: cells.filter(one => one.status === 'drawn').length, failed: tally('failed'), out: tally('out') };
};

// Every cell not yet drawn, one at a time through the harness's drawOne, in PLAN's order: each begun only if it can
// end by `until` at its group's price, the compile of the run's first cell and of each other group's first priced in,
// and none after the first that cannot. A C frame whose front is not drawn is `out`. A socket that does not open is
// waited out once; a failed cell is recorded and the run goes on, unless its code says the graph or the server is
// wrong (stopsTheRun), which stops the run.
async function drawFigures(options: Options): Promise<FiguresIndex> {
  const out = resolve(options.out), file = join(out, INDEX_FILE);
  const setup = setupOf(out, options.pilot, options.pinned), earlier = readJson<FiguresIndex>(file);
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card); nothing is drawn');
  });
  if (earlier && (!same(earlier.pins, setup.pins) || !same(earlier.server, server))) {
    throw new Refusal(`${file} was drawn from other texts, graphs or weights, or on a server that said another thing of itself (Triton included): `
      + 'move it aside; nothing is drawn');
  }
  const triton = server.triton === 'enabled';
  // The log's word on comfy-kitchen's backends, read before anything is drawn, while the lines of the server's start
  // are still in its ring; a later read that no longer finds them keeps the earlier one.
  const kitchen = kitchenOf(await logLines(comfy), triton);
  const index: FiguresIndex = earlier ?? { startedAt: new Date().toISOString(), pins: setup.pins, server, triton, cells: {} };
  if (kitchen.seen || !index.kitchen) {
    index.kitchen = { seen: kitchen.seen, argv: kitchen.argv, tritonImported: kitchen.tritonImported, tritonImportFailed: kitchen.tritonImportFailed,
      backend: kitchen.backends.triton ?? null };
  }
  delete index.completedAt;
  delete index.stopped;
  delete index.error;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, index);
  save();
  const page = () => writePage(out, setup, index);
  page();
  if (!triton) options.log({ event: 'triton_off' });
  else if (kitchen.seen && (kitchen.tritonImportFailed || !kitchen.backends.triton?.available || kitchen.backends.triton.disabled)) {
    options.log({ event: 'triton_not_loaded' });
  }
  const done = (key: string) => {
    const cell = index.cells[key], path = cell?.file === undefined ? undefined : join(out, cell.file);
    return cell?.status === 'drawn' && path !== undefined && existsSync(path) && sha256(readFileSync(path)) === cell.sha256;
  };
  // The kept front as a C frame takes it: drawn, where its record says, the very bytes, on the front's canvas.
  const keptFront = () => {
    const cell = index.cells[KEPT], bytes = done(KEPT) ? readFileSync(join(out, cell.file!)) : undefined, size = bytes ? pngSize(bytes) : undefined;
    return bytes && size?.width === setup.frontCanvas.width && size.height === setup.frontCanvas.height ? bytes : undefined;
  };
  const plan = options.keys ? PLANNED.filter(one => options.keys!.includes(one.key)) : PLANNED, prices = setup.prices;
  const left = plan.filter(one => !done(one.key));
  options.log({ event: 'figures_plan', cells: plan.length, left: left.length, triton, expectedMinutes: minutes(expectedOf(left, prices)),
    pricedMinutes: minutes(needOf(left, prices)) });
  const uploaded = new Map<string, string>();
  // Whether a job of the run has reached the card, and the groups those jobs had: what the card has compiled.
  let reached = false, sentJobs = 0;
  const groupsReached = new Set<Group>();
  const extraMs = (group: Group) => (!reached ? COLD_MS : groupsReached.has(group) ? 0 : SHAPE_MS);
  const own = (one: Planned, retried: boolean) => ({ key: one.key, id: one.id, kind: one.kind, arm: one.arm, seed: one.seed, group: one.group,
    references: one.references.length, triton, ...(retried ? { retried } : {}) });
  const attempt = async (one: Planned, kept: Buffer | undefined, fits: () => boolean, retried: boolean): Promise<'drawn' | 'failed' | 'socket' | 'until' | 'stopped'> => {
    const path = join(out, one.file), prompt = setup.texts.cells.get(one.key)!.prompt;
    let sent = false;
    try {
      const began = performance.now(), names: string[] = [];
      let uploadMs = 0;
      if (kept) {
        let named = uploaded.get(sha256(kept));
        if (named === undefined) {
          named = await uploadReference(comfy, kept);
          uploaded.set(sha256(kept), named);
          uploadMs = performance.now() - began;
        }
        names.push(named);
      }
      const graph = buildJob(setup, one, prompt, names);
      if (!cellRight(graph, one, prompt, names, setup)) throw workflowError();
      const before = await logLines(comfy);
      const cold = !reached, firstOfGroup = !groupsReached.has(one.group);
      sent = true;
      const drawn = await drawOne(comfy, graph, { pollMs: options.pollMs, waitMs: options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true, admit: fits });
      reached = true;
      groupsReached.add(one.group);
      sentJobs++;
      // The picture is down, and it is kept whatever comes next: saved and recorded before anything more is asked.
      await settled();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const size = pngSize(drawn.bytes), phases = drawn.timing?.phases;
      // The job's time on the card is its phases; the rest of totalMs, less the download, is the wait from the submit to
      // its first node and from its end to the download.
      const ran = phases ? Object.values(phases).reduce<number>((sum, ms) => sum + (ms ?? 0), 0) : undefined;
      const cell: Cell = { ...own(one, retried), status: 'drawn', file: relative(out, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length, ...size,
        ...(kept ? { reference: sha256(kept) } : {}), ...(cold ? { cold } : {}), ...(firstOfGroup ? { firstOfGroup } : {}), totalMs: drawn.totalMs,
        viewMs: drawn.viewMs, ...(ran === undefined ? {} : { queueMs: Math.max(0, drawn.totalMs - drawn.viewMs - ran), sampleMs: phases?.sampleMs }),
        ...drawn.timing, ...(uploadMs ? { uploadMs: Math.round(uploadMs) } : {}), vramSamples: drawn.memory.samples, promptChars: prompt.length };
      index.cells[one.key] = cell;
      save();
      options.log({ event: 'cell_drawn', key: one.key, totalMs: drawn.totalMs, sampleMs: phases?.sampleMs, width: size.width, height: size.height,
        ...(cold ? { cold } : {}), ...(firstOfGroup ? { firstOfGroup } : {}) });
      if (comfy.end?.aborted) return 'until';
      const loads = partialLoadsSince(before, await logLines(comfy));
      if (loads !== undefined) {
        cell.partialModelLoadEvents = loads;
        save();
      }
      return 'drawn';
    } catch (error) {
      const raw = (error as { code?: unknown }).code;
      // A socket that did not open, and a job its time no longer covered, never reached the card.
      if (sent && raw !== 'comfy_socket_unavailable' && raw !== 'not_admitted') {
        reached = true;
        groupsReached.add(one.group);
      }
      if (comfy.end?.aborted || raw === 'not_admitted') return 'until';
      if (raw === 'comfy_socket_unavailable' && !retried) return 'socket';
      const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
      const { httpStatus } = safeErrorDetails(error);
      const failure = { code, ...(httpStatus === undefined ? {} : { httpStatus }), ...((error as { oom?: unknown }).oom === true ? { oom: true } : {}) };
      index.cells[one.key] = { ...own(one, retried), status: 'failed', ...failure };
      save();
      options.log({ event: 'cell_failed', key: one.key, ...failure });
      if (stopsTheRun(code)) { index.error = code; return 'stopped'; }
      return 'failed';
    }
  };

  let ended: 'done' | 'until' | 'stopped' = 'done';
  for (const one of plan) {
    if (done(one.key)) continue;
    const kept = one.references.length ? keptFront() : undefined;
    if (one.references.length && !kept) {
      index.cells[one.key] = { ...own(one, false), status: 'out', code: 'front_missing' };
      save();
      options.log({ event: 'cell_out', key: one.key, code: 'front_missing' });
      continue;
    }
    const fits = () => !comfy.end?.aborted && Date.now() + prices.groups[one.group].price + extraMs(one.group) <= options.until;
    if (!fits()) {
      options.log({ event: 'cell_not_begun', key: one.key, needSeconds: Math.ceil((prices.groups[one.group].price + extraMs(one.group)) / 1000),
        leftSeconds: Math.max(0, Math.floor((options.until - Date.now()) / 1000)) });
      ended = 'until';
      break;
    }
    let result = await attempt(one, kept, fits, false);
    if (result === 'socket') {
      options.log({ event: 'socket_retry', key: one.key });
      await delay(RETRY_PAUSE_MS, undefined, { signal: comfy.end }).catch(() => undefined);
      if (!fits()) { ended = 'until'; break; }
      result = await attempt(one, kept, fits, true);
    }
    if (result === 'until' || result === 'stopped') { ended = result; break; }
    page();
  }
  // A failed job's delete may still be on its way, and the run is not over before the card has had it.
  await settled();
  if (ended === 'until') index.stopped = 'until';
  index.completedAt = new Date().toISOString();
  save();
  page();
  options.log({ event: 'figures_done', ended, sent: sentJobs, ...countsOf(index), left: plan.filter(one => !done(one.key)).length,
    ...(index.error ? { error: index.error } : {}) });
  return index;
}

// ---- The page ----

// The page's sections, one an arm: what the arm asks, the risk its texts carry that figure-age saw before the card,
// and its rows, a row a seed of the pictures compared, with `beside` first in each.
type Section = { arm: number; title: string; question: string; risk: string; rows: { ids: string[]; seeds: number[]; beside?: string }[] };
const HEAVYSET = 'пересказ (details) называет её «heavyset»; если фронт из пересказа выйдет тяжелее фронта из таблицы, причиной может быть это слово.';
const GYM = 'внешности gym взяты из второй выборки исправленного пересказа, единственной из трёх, где сказано «breasts»; в двух других «chest».';
const SECTIONS: Section[] = [
  { arm: 1, title: 'Пересказ или таблица', rows: [{ ids: ['hard-retold', 'hard-table'], seeds: TWO }],
    question: 'Героиня нарисована из английского пересказа (слева) и из своей таблицы как она написана (справа). Держит ли фронт из пересказа '
      + 'телосложение? Если ни один фронт из пересказа его не держит, тест здесь останавливается, и картинки ниже не судятся.', risk: HEAVYSET },
  { arm: 2, title: 'Слова или фронт картинкой 1', rows: ['market', 'crates', 'porch'].map(scene => ({ ids: [`${scene}-words`, `${scene}-C`], seeds: TWO, beside: KEPT })),
    question: 'Три сцены, один человек лицом к зрителю в одежде не как на портрете. В каждом ряду фронт из пересказа сида 7, кадр по словам внешности '
      + 'и кадр C, где этот фронт картинка 1. Держит ли C телосложение там, где слова его не держат? Референс идёт дальше, только если держит в 6 из 6.',
    risk: 'фронт, картинка 1 кадров C, нарисован из пересказа со словом «heavyset», а кадры по словам из её описания внешности (look), где этого слова нет.' },
  { arm: 3, title: 'Две похожие в одном кадре', rows: [{ ids: ['pair-without', 'pair-with'], seeds: TWO }],
    question: 'Героиня и похожая на неё женщина несут скамью через двор в одинаковой одежде: различить их может только внешность. Слева внешности '
      + 'пересказаны порознь, каждая на своём листе, справа вместе, одна с другой в виду. Правило остаётся, если оно различает их в 2 из 2 там, где '
      + 'без него они сливаются.',
    risk: 'стороны взяты из разных текстов проверки пересказа: «without» из первого текста, «with» из исправленного. Разница может идти и от правки текста.' },
  { arm: 4, title: 'Выглядит лет на 22', rows: [{ ids: ['hard-retold', 'hard-aged'], seeds: TWO }],
    question: 'Слева фронты руки 1 из пересказа, справа тот же промпт с «who looks about 22» после слова о возрасте. Какой фронт выглядит ближе к 22? '
      + 'Число здесь возраст, на который человек выглядит, а не его годы.', risk: 'тот же пересказ со словом «heavyset», что в руке 1.' },
  { arm: 5, title: 'Ступени слов', rows: [{ ids: ['gym-words', 'gym-order'], seeds: TWO }],
    question: 'Четыре женщины gym в одном кадре, стоят в том порядке, в каком их перечисляет кадр. Слева их внешности как есть, справа с порядком, '
      + 'сказанным прямо: слева направо бюст у каждой больше, чем у предыдущей, у средних двух одинаковый. Держат ли одни слова размеры 6, 7, 7 и 8 '
      + 'врозь, и держит ли их сказанный порядок там, где слова не держат? Бёдра и ягодицы, заданные в обратную сторону, остаются во внешностях обоих.',
    risk: GYM },
  { arm: 6, title: 'Фигура по имени персонажа', rows: [{ ids: ['grace-words', 'grace-named'], seeds: THREE }, { ids: ['gym-words', 'gym-grace'], seeds: TWO }],
    question: 'Сначала фронт одной синтетической женщины по рецепту портрета: слева только слова, справа те же слова с фигурой как у персонажа игры, '
      + 'названного по имени, сиды 7, 11 и 13. Потом кадр gym: слева как есть, справа с той же фразой во внешности одной женщины. Сдвигается ли фигура '
      + 'к фигуре персонажа, и приходят ли с ней лицо, волосы или одежда?', risk: `у кадров gym риск руки 5: ${GYM}` },
];

// index.html beside cells.json: a section an arm, a row a seed of the pictures it compares, each as high as the others
// of its row and none higher than HIGH, with its caption, its time, and its prompt folded under it. Each picture links
// to its file, linked where it lies, never copied. Under the sections the warm times of each group, the first cells
// of each apart.
const HIGH = 600, GAP = 8;
function writePage(out: string, inputs: Inputs, index: FiguresIndex | undefined) {
  const drawing = index !== undefined && !index.completedAt, cells = index?.cells ?? {};
  const href = (path: string) => escapeHtml(relative(out, path).split(sep).join('/'));
  const figure = (one: Planned, caption: string, timed = true) => {
    const cell = cells[one.key], canvas = canvasOf(one, inputs.frontCanvas), shape = `aspect-ratio:${canvas.width}/${canvas.height}`;
    const path = cell?.status === 'drawn' && cell.file ? join(out, cell.file) : undefined;
    const missing = cell?.status === 'failed' ? `не вышло: ${cell.code ?? 'image_failed'}` : cell?.status === 'out' ? 'не нарисовано: нет фронта из пересказа сида 7'
      : drawing ? 'ещё не нарисовано' : 'не нарисовано';
    const time = cell?.status === 'drawn' && timed ? `; ${seconds(cell.totalMs)} с${cell.cold ? ', первое задание (компиляция)' : cell.firstOfGroup ? ', первое в группе' : ''}` : '';
    const body = path && existsSync(path) ? `<a href="${href(path)}"><img src="${href(path)}" alt="" style="${shape}"></a>`
      : `<div class="box" style="${shape}">${escapeHtml(missing)}</div>`;
    return `<figure style="flex:${(canvas.width / canvas.height).toFixed(4)} 1 0">${body}<figcaption>${escapeHtml(`${caption}, сид ${one.seed}${time}`)}</figcaption>`
      + `<details><summary>промпт</summary><pre>${escapeHtml(inputs.texts.cells.get(one.key)?.prompt ?? '')}</pre></details></figure>`;
  };
  const cellOf = (id: string, seed: number) => PLANNED.find(one => one.id === id && one.seed === seed)!;
  const kept = PLANNED.find(one => one.key === KEPT)!;
  // A row as wide as its pictures at HIGH, or the page's width where that is less.
  const row = (shown: Planned[], figures: string) => {
    const wide = shown.reduce((sum, one) => sum + canvasOf(one, inputs.frontCanvas).width / canvasOf(one, inputs.frontCanvas).height, 0);
    return `<div class="row" style="max-width:${Math.round(HIGH * wide + GAP * (shown.length - 1))}px">${figures}</div>`;
  };
  const sections = SECTIONS.map(section => `<section><h2>Рука ${section.arm}. ${escapeHtml(section.title)}</h2><p>${escapeHtml(section.question)}</p>`
    + `<p class="risk">Риск текста: ${escapeHtml(section.risk)}</p>`
    + section.rows.flatMap(each => each.seeds.map(seed => row([...(each.beside ? [kept] : []), ...each.ids.map(id => cellOf(id, seed))],
      (each.beside ? figure(kept, 'картинка 1 кадров C: фронт из пересказа', false) : '') + each.ids.map(id => figure(cellOf(id, seed), cellOf(id, seed).label)).join(''))))
      .join('\n') + '</section>');
  const drawnCells = Object.values(cells).filter(one => one.status === 'drawn');
  const times = GROUPS.map(group => {
    const warm = drawnCells.filter(one => one.group === group && !one.cold && !one.firstOfGroup);
    const of = (read: (one: Cell) => number | undefined) => seconds(median(warm.map(read).filter((ms): ms is number => ms !== undefined)));
    return `<tr><td>${GROUP_NAMES[group]}</td><td>${warm.length}</td><td>${of(one => one.totalMs)}</td><td>${of(one => one.sampleMs)}</td><td>${of(one => one.queueMs)}</td></tr>`;
  }).join('');
  const first = drawnCells.filter(one => one.cold || one.firstOfGroup)
    .map(one => `${escapeHtml(one.key)}: ${seconds(one.totalMs)} с, сэмплер ${seconds(one.sampleMs)} с${one.cold ? ', первое задание' : ''}`).join('; ');
  const counts = index ? countsOf(index) : { drawn: 0, failed: {}, out: {} };
  const tally = (all: Record<string, number>) => Object.entries(all).map(([code, n]) => `${code} ${n}`).join(', ');
  const state = !index ? 'до карты: ничего не нарисовано' : drawing ? 'рисуется; страница обновляется сама раз в минуту'
    : index.error ? `остановилось с ошибкой ${index.error}` : index.stopped ? 'остановилось: следующая картинка не успевала до срока' : 'закончено';
  const kitchen = index?.kitchen, backend = kitchen?.backend;
  const log = !kitchen?.seen ? 'строк запуска в журнале сервера уже нет' : kitchen.tritonImportFailed ? 'triton не импортировался'
    : backend?.available && !backend.disabled ? 'бэкенд triton загружен' : 'бэкенд triton выключен';
  const server = index ? `Сервер: ComfyUI ${escapeHtml(index.server.comfyui ?? '?')}, PyTorch ${escapeHtml(index.server.pytorch ?? '?')}, карта `
    + `${escapeHtml(index.server.card ?? '?')}; Triton: ${index.triton ? 'включён' : 'выключен'} (${escapeHtml(log)}).` : '';
  const recipe = (one: Recipe) => `${counted(one.steps, 'шаг', 'шага', 'шагов')} ${one.sampler}/${one.scheduler}, CFG ${one.cfg}`;
  const groupSize = (group: Group) => PLANNED.filter(one => one.group === group).length;
  const recipes = same(inputs.recipes.front, inputs.recipes.frame) ? recipe(inputs.recipes.front)
    : `фронты ${recipe(inputs.recipes.front)}, кадры ${recipe(inputs.recipes.frame)}`;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${drawing ? '<meta http-equiv="refresh" content="60">' : ''}
<title>Тест фигуры на карте</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;gap:${GAP}px;margin-bottom:12px;align-items:flex-start}figure{margin:0;min-width:0}
img{display:block;width:100%;height:auto;background:#eee}figcaption{font-size:12px}.box{display:flex;align-items:center;justify-content:center;text-align:center;
background:#eee;font-size:13px;width:100%}pre{white-space:pre-wrap;font-size:12px;margin:4px 0}summary{font-size:12px;cursor:pointer}.risk{color:#8a4b00}
td,th{padding:2px 8px;text-align:right}</style>
<h1>Тест фигуры на карте</h1>
<p>${counted(PLANNED.length, 'картинка', 'картинки', 'картинок')} в шести руках (docs/illustrations-plan.md#figure-card-test): сначала
${counted(groupSize('front'), 'фронт', 'фронта', 'фронтов')} на графе фронтов, ${sizeText(inputs.frontCanvas)}, потом
${counted(groupSize('words'), 'кадр', 'кадра', 'кадров')} по словам и ${counted(groupSize('C'), 'кадр', 'кадра', 'кадров')} C на графе кадров,
${sizeText(FRAME_CANVAS)}; у кадров C картинка 1 это фронт из пересказа сида 7, уменьшенный area до ${sizeText(SCALED)}. Модель и рецепт бота: ${escapeHtml(recipes)}, сид ячейки, без турбо и без TorchCompileModel. Промпт свёрнут
под каждой картинкой, щелчок открывает картинку целиком. Оценок нет: что держит телосложение, различает двух, выглядит ближе к 22, держит порядок или
сдвигается к персонажу, решает глаз. Риски текстов отмечены до карты, по текстам, а не по картинкам.</p>
<p>Состояние: ${escapeHtml(state)}. Нарисовано ${counts.drawn} из ${PLANNED.length}${tally(counts.failed) ? `, не вышло: ${escapeHtml(tally(counts.failed))}` : ''}${tally(counts.out) ? `, без фронта: ${escapeHtml(tally(counts.out))}` : ''}. ${server}</p>
${sections.join('\n')}
<section id="times"><h2>Время</h2>
<table><tr><th>группа</th><th>тёплых</th><th>всего, с</th><th>сэмплер, с</th><th>ожидание, с</th></tr>${times}</table>
<p>Медианы по тёплым картинкам. Отдельно первые задания запуска и каждой группы (компиляция Triton): ${first || 'нет'}.</p>
</section>
`, { mode: 0o600 });
}

// ---- The dry run ----

// Texts of the real file's shape, made up: each prompt a line of its own round `word` with a dash, which a prompt may
// keep and the page's own words may not; `change` spoils one cell for a refusal.
type MadeUpTexts = { note: string; cells: TextCell[] };
function madeUpTexts(word: string, front: Size, change: (cell: TextCell) => TextCell = cell => cell): MadeUpTexts {
  return { note: 'Made up for the dry run.', cells: PLANNED.map(one => change({ key: one.key, arm: `${one.arm} made-up arm`, kind: one.kind, seed: one.seed,
    graph: one.kind === 'front' ? 'front' : 'action', canvas: sizeText(canvasOf(one, front)), references: one.references,
    prompt: `A made-up ${one.id} picture at seed ${one.seed} – ${word}.` })) };
}
const writeTexts = (out: string, texts: MadeUpTexts) => {
  const bytes = JSON.stringify(texts, null, 2);
  writeFileSync(join(out, TEXTS_FILE), bytes, { mode: 0o600 });
  return sha256(bytes);
};
// The pilot's record, made up: a cold pass, the finished warm one whose times price the cells (a front 1.6 s, A 1.2 s
// and V 38 s with 2 s of uploads: 5, 4.5 and 53 s at the admission prices), and a later warm one that did not finish.
function madeUpPilot(file: string) {
  const pass = (name: string, attempt: number, ended: string, times: Record<string, [number, number]>) => ({ name, attempt, dir: '', roundTwo: true, triton: true,
    startedAt: '', completedAt: '', ended, wallMs: 0, cells: Object.entries(times).map(([cell, [totalMs, uploadMs]]) => ({ cell, key: `made-up:${cell}`,
      status: 'drawn', references: 0, totalMs, ...(uploadMs ? { uploadMs } : {}) })) });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeJson(file, { story: 'flight', seed: 7, source: '', passes: [pass('triton-cold', 1, 'done', { front: [30000, 0], A: [9000, 0], V: [60000, 3000] }),
    pass('triton-warm', 1, 'done', { front: [1600, 0], view: [2000, 100], A: [1200, 0], V: [38000, 2000], T: [3000, 500] }),
    pass('triton-warm', 2, 'until', { front: [90000, 0] })] });
}
// comfy-kitchen's lines as the pinned server logs them at its start with Triton on (local/image-pilot.ts's dry run).
const KITCHEN_LINES = ['WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations.',
  'Found triton 3.4.0. Enabling comfy-kitchen triton backend.',
  'Found comfy_kitchen backend cuda: {\'available\': True, \'disabled\': True, \'unavailable_reason\': None, \'capabilities\': []}',
  'Found comfy_kitchen backend eager: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}',
  'Found comfy_kitchen backend triton: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}'];
const TRITON_ARGV = ['main.py', '--listen', '127.0.0.1', '--enable-triton-backend'];

// The whole test against local/fake-comfy.ts started as a Triton server, in `dir`: made-up texts and the card's record
// in `figure-card/`, a made-up pilot record in `pilot/`, `tmp/` as the temporary directory. On the way, what the paid
// run relies on: the page before the card; texts other than the pinned, texts whose cells are not the plan's, a texts
// file through a link, and missing texts or card record refused before anything is sent or written; a cell that
// cannot end by --until not begun, the first C frame not begun where the fronts and frames from words fit; a resume
// drawing the rest and then nothing; the 34 jobs, each against its independent reading and what the fake made of it,
// in the plan's order; the Triton pins, the compile's cells and each group's first kept apart; a kept front that fails
// leaving its C frames out until a resume draws it; a socket that does not open waited out once, and one that never
// opens stopping the run; a resume on a server without Triton refused; one job at a time; the page's sections, links,
// files' modes and words without dashes. The made-up prompts hold a made-up word, which afterwards is only in the
// texts and on the page, never in cells.json, a picture, the temporary directory or what was printed; the fake writes
// another into every picture's metadata, which is nowhere.
export async function dryRun(dir: string) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), out = join(dry, 'figure-card'), pilot = join(dry, 'pilot', 'pilot.json');
  for (const path of [dry, temp, out]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) {
      expect(error instanceof Refusal, `${what} refused as a refusal`);
      say(`   ${what}: refused (${JSON.stringify(safeError(error))})`);
    }
  };
  const word = madeUpName(), marker = madeUpName(name => name !== word);
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  // The graphs as they go out, in the order sent, which the fake does not keep; and any call to anything but the fake.
  const sent: Graph[] = [], fetched = globalThis.fetch;
  let strays = 0, origin = '';
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) { strays++; throw new Error('the dry run asks the fake alone'); }
    if (init?.method === 'POST' && url.endsWith('/prompt') && typeof init.body === 'string') sent.push((JSON.parse(init.body) as { prompt: Graph }).prompt);
    return fetched(input, init);
  };
  try {
    say(`figure-test dry run in ${dry}: made-up texts and local/fake-comfy.ts started with Triton; no card, no model, no network`);
    writeCardRecord(join(out, 'card.txt'));
    const frontCanvas = portraitCanvas(apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))));
    const texts = madeUpTexts(word, frontCanvas), pinned = writeTexts(out, texts);
    madeUpPilot(pilot);
    const started = await startFakeComfy({ jobMs: 30, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: KITCHEN_LINES });
    fake = started;
    origin = started.url;
    const events: object[] = [];
    const heard = (event: string) => events.filter(one => (one as { event?: string }).event === event);
    const draw = (extra: Partial<Options> = {}) => drawFigures({ out, pilot, comfy: origin, until: Date.now() + 3600000, pinned, pollMs: 10, waitMs: 60000,
      timeoutMs: 10000, log: event => events.push(event), ...extra });

    const inputs = inputsOf(out, pilot, pinned), estimate = estimateOf(inputs);
    say(`0 estimate: ${estimate.cells} cells (${estimate.fronts} fronts, ${estimate.words} from words, ${estimate.withReference} C), `
      + `${estimate.expectedMinutes} and ${estimate.pricedMinutes} minutes at the made-up pilot's ${estimate.from}; prices ${JSON.stringify(estimate.cellSeconds)}`);
    expect(estimate.cells === 34 && estimate.fronts === 12 && estimate.words === 16 && estimate.withReference === 6 && estimate.from === 'triton-warm 1'
      && same(inputs.prices.groups, { front: { expected: 1600, price: 5000 }, words: { expected: 1200, price: 4500 }, C: { expected: 40000, price: 53000 } })
      && estimate.expectedMinutes === 5 && estimate.pricedMinutes === 8.8, '34 cells in their groups, priced from the finished warm pass');
    expect(PLANNED.findIndex(one => one.group === 'C') > PLANNED.findLastIndex(one => one.group !== 'C')
      && PLANNED.findLastIndex(one => one.group === 'front') < PLANNED.findIndex(one => one.group !== 'front'), 'the fronts first and the C frames last');
    writePage(out, inputs, undefined);
    const before = readFileSync(join(out, 'index.html'), 'utf8');
    const figures = (page: string) => (page.match(/<figure /g) ?? []).length;
    const pageFigures = SECTIONS.reduce((sum, section) => sum + section.rows.reduce((all, row) => all + row.seeds.length * (row.ids.length + (row.beside ? 1 : 0)), 0), 0);
    say(`1 the page before the card: ${figures(before)} figures in ${(before.match(/<section>/g) ?? []).length} sections, `
      + `${(before.match(/<details>/g) ?? []).length} prompts folded`);
    expect(figures(before) === 44 && pageFigures === 44 && (before.match(/<details>/g) ?? []).length === 44 && !existsSync(join(out, INDEX_FILE)),
      'the page before the card shows every arm\'s pictures with their prompts');

    say('2 refusals before anything is sent or written:');
    await refused('texts other than the pinned', () => draw({ pinned: sha256('another texts.json') }));
    const otherFront = writeTexts(out, madeUpTexts(word, frontCanvas, cell => (cell.key === 'frame:porch-C:s11' ? { ...cell, references: ['front:hard-table:s7'] } : cell)));
    await refused('a C frame that takes another front', () => draw({ pinned: otherFront }));
    const wide = writeTexts(out, madeUpTexts(word, frontCanvas, cell => (cell.key === 'front:grace-named:s13' ? { ...cell, canvas: sizeText(FRAME_CANVAS) } : cell)));
    await refused('a front on the frames\' canvas', () => draw({ pinned: wide }));
    writeTexts(out, texts);
    const elsewhere = join(dry, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    writeTexts(elsewhere, texts);
    unlinkSync(join(out, TEXTS_FILE));
    symlinkSync(join(elsewhere, TEXTS_FILE), join(out, TEXTS_FILE));
    await refused('texts through a link', () => draw());
    unlinkSync(join(out, TEXTS_FILE));
    await refused('missing texts', () => draw());
    writeTexts(out, texts);
    const card = readFileSync(join(out, 'card.txt'));
    unlinkSync(join(out, 'card.txt'));
    await refused('a missing card record', () => draw());
    writeFileSync(join(out, 'card.txt'), card, { mode: 0o600 });
    expect(started.jobs.length === 0 && started.uploads.length === 0 && !existsSync(join(out, INDEX_FILE)), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`3 five seconds left: stopped ${short.stopped}, ${started.jobs.length} jobs sent`);
    expect(short.stopped === 'until' && started.jobs.length === 0 && sent.length === 0, 'a cell that cannot end by --until is not begun');

    const minute = await draw({ until: Date.now() + 60000 }), afterWindow = started.jobs.length;
    const notBegun = heard('cell_not_begun').at(-1) as { key?: string; needSeconds?: number } | undefined;
    say(`4 a minute left: ${afterWindow} jobs, ${countsOf(minute).drawn} drawn, stopped ${minute.stopped}; not begun ${notBegun?.key}, `
      + `needing ${notBegun?.needSeconds} s`);
    expect(afterWindow === 28 && countsOf(minute).drawn === 28 && minute.stopped === 'until' && notBegun?.key === 'frame:market-C:s7'
      && notBegun.needSeconds === 68, 'the fronts and the frames from words drawn, and the first C frame, 53 s and a group\'s compile, not begun');
    const resumed = await draw(), afterResume = started.jobs.length;
    const again = await draw();
    say(`5 a resume: ${afterResume - afterWindow} jobs, ${countsOf(resumed).drawn} drawn; again: ${started.jobs.length - afterResume} more`);
    expect(afterResume === 34 && started.jobs.length === 34 && countsOf(again).drawn === 34 && !again.stopped && !again.error, 'the six C frames, then none again');

    // Each job against its cell, in the order drawn.
    const setup = setupOf(out, pilot, pinned), keptBytes = readFileSync(join(out, PLANNED[0].file));
    const keptName = `ref-${sha256(stripPngMetadata(keptBytes)).slice(0, 16)}.png`, wrong: string[] = [];
    PLANNED.forEach((one, at) => {
      const graph = sent[at], job: FakeJob | undefined = started.jobs[at], cell = again.cells[one.key], canvas = canvasOf(one, frontCanvas);
      const names = one.references.length ? [keptName] : [], prompt = texts.cells[at].prompt;
      const right = graph !== undefined && same(buildJob(setup, one, prompt, names), graph) && cellRight(graph, one, prompt, names, setup)
        && job?.outcome === 'success' && job.sampler === 'KSampler' && job.start === null && job.noiseMask === null && !job.composites.length
        && same(job.slots, names.map((file, slot) => ({ slot: slot + 1, file, scaled: SCALED, cropped: null })))
        && same(job.model, one.kind === 'front' ? ['UNETLoader'] : ['QwenImage21Cache', 'UNETLoader'])
        && same(job.images, [{ node: one.kind === 'front' ? '8' : '9', ...canvas }]) && cell?.status === 'drawn' && cell.width === canvas.width
        && cell.height === canvas.height && cell.file === one.file && existsSync(join(out, one.file)) && cell.seed === one.seed
        && cell.reference === (one.references.length ? sha256(keptBytes) : undefined);
      if (!right) wrong.push(one.key);
    });
    say(`   jobs against their reading and the fake's: ${PLANNED.length - wrong.length} of ${PLANNED.length} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    say('   each: the graph built, read back independently, the model path, the slots (the kept front, 352x640, on C alone) and the picture\'s size; '
      + 'the fronts at 720x1280 on the front graph, the frames at 1280x704 on the action graph, each at its seed with its graph\'s recipe');
    expect(!wrong.length && sent.length === 34, 'every job sends its own graph, in the plan\'s order');

    const cells = Object.values(again.cells), kitchen = again.kitchen;
    const cold = cells.filter(one => one.cold).map(one => one.key), firsts = cells.filter(one => one.firstOfGroup).map(one => one.key);
    say(`6 Triton: server pins ${JSON.stringify(again.server)}, log ${JSON.stringify(kitchen)}; cold ${cold.join(', ')}; first of a group ${firsts.join(', ')}`);
    expect(again.server.triton === 'enabled' && again.triton && cells.every(one => one.triton) && kitchen?.seen === true && kitchen.argv && kitchen.tritonImported
      && kitchen.backend?.available === true && kitchen.backend.disabled === false && same(cold, ['front:hard-retold:s7', 'frame:market-C:s7'])
      && same(firsts, ['front:hard-retold:s7', 'frame:market-words:s7', 'frame:market-C:s7']), 'the pins say Triton, and each run\'s and group\'s first is kept apart');

    // A kept front the card fails: its C frames out, the rest drawn, and a resume draws the front and then them.
    const outOf = (name: string) => {
      const other = join(dry, name);
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(join(other, 'card.txt'), card, { mode: 0o600 });
      writeTexts(other, texts);
      return other;
    };
    const failedOut = outOf('failed'), beforeFailed = started.jobs.length;
    started.options.failJobs = [started.jobs.length + 1];
    const failed = await draw({ out: failedOut });
    started.options.failJobs = [];
    const afterFailed = started.jobs.length, redrawn = await draw({ out: failedOut });
    const failedCells = Object.values(failed.cells).filter(one => one.status === 'failed'), outCells = Object.values(failed.cells).filter(one => one.status === 'out');
    say(`7 the kept front failed: ${afterFailed - beforeFailed} jobs, drawn ${countsOf(failed).drawn}, failed ${failedCells.map(one => one.key).join(', ')}, `
      + `out ${JSON.stringify(countsOf(failed).out)}; a resume: ${started.jobs.length - afterFailed} jobs, drawn ${countsOf(redrawn).drawn}`);
    expect(afterFailed - beforeFailed === 28 && countsOf(failed).drawn === 27 && failedCells.length === 1 && failedCells[0].key === KEPT
      && outCells.length === 6 && outCells.every(one => one.code === 'front_missing') && !failed.stopped && !failed.error
      && started.jobs.length - afterFailed === 7 && countsOf(redrawn).drawn === 34, 'a failed kept front leaves its C frames to a resume');

    // A socket that does not open in time, once: waited out, and the cell drawn.
    const two = ['front:hard-retold:s7', 'front:hard-retold:s11'], beforeRetry = started.jobs.length;
    started.options.openDelayMs = 2500;
    const retried = await draw({ out: outOf('retry'), keys: two, log: event => {
      events.push(event);
      if ((event as { event?: string }).event === 'socket_retry') started.options.openDelayMs = 0;
    } });
    say(`8 a socket that opens late once: ${heard('socket_retry').length} retry, ${started.jobs.length - beforeRetry} jobs, drawn ${countsOf(retried).drawn}, `
      + `retried ${Object.values(retried.cells).filter(one => one.retried).map(one => one.key).join(', ')}`);
    expect(heard('socket_retry').length === 1 && started.jobs.length - beforeRetry === 2 && countsOf(retried).drawn === 2
      && retried.cells[two[0]]?.retried === true && !retried.error, 'a late socket is waited out once');

    // One that never opens: the retry fails too, and the run stops before anything reached the card.
    const beforeStop = started.jobs.length;
    events.length = 0;
    started.options.openDelayMs = 2500;
    const stopped = await draw({ out: outOf('socket'), keys: two });
    started.options.openDelayMs = 0;
    say(`9 a socket that never opens: ${heard('socket_retry').length} retry, ${started.jobs.length - beforeStop} jobs, error ${stopped.error ?? 'none'}, `
      + `failed ${JSON.stringify(countsOf(stopped).failed)}`);
    expect(started.jobs.length === beforeStop && stopped.error === 'comfy_socket_unavailable' && countsOf(stopped).failed.comfy_socket_unavailable === 1
      && countsOf(stopped).drawn === 0, 'a socket that never opens stops the run');

    // A resume on a server that no longer runs Triton.
    started.options.argv = ['main.py', '--listen', '127.0.0.1'];
    say('10 a resume on another server:');
    await refused('a server without Triton', () => draw());
    started.options.argv = TRITON_ARGV;

    say(`11 the fake held at most ${started.mostHeld} job at once; ${strays} calls to anything but the fake`);
    expect(started.mostHeld === 1 && strays === 0, 'one job at a time, and the fake alone');

    const page = readFileSync(join(out, 'index.html'), 'utf8'), links = [...new Set([...page.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
    const prose = page.replace(/<pre>[\s\S]*?<\/pre>/g, ''), dashes = /[–—]/;
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = mode(out) === 0o700 && mode(join(out, INDEX_FILE)) === 0o600 && mode(join(out, 'index.html')) === 0o600
      && mode(join(out, 'fronts')) === 0o700 && mode(join(out, 'frames')) === 0o700 && PLANNED.every(one => mode(join(out, one.file)) === 0o600);
    say(`12 page: ${figures(page)} figures, ${links.length} links, ${links.filter(link => existsSync(resolve(out, link))).length} where they lead; `
      + `dashes in its own words ${dashes.test(prose)}, in the prompts ${dashes.test(page)}; the texts' risks shown `
      + `${['heavyset', 'breasts', 'разных текстов'].every(risk => page.includes(risk))}; Triton on the page ${page.includes('Triton: включён')}; `
      + `directories 700 and files 600: ${modes}`);
    expect(figures(page) === 44 && links.length === 34 && links.every(link => existsSync(resolve(out, link))) && !page.includes('не нарисовано')
      && !dashes.test(prose) && dashes.test(page) && ['heavyset', 'breasts', 'разных текстов'].every(risk => page.includes(risk))
      && page.includes('Triton: включён') && page.includes(`Нарисовано 34 из 34`) && modes, 'the page shows every arm and links every picture, in words without dashes');

    // The prompts' word is in the texts and on the page, and nowhere else; the fake's word is nowhere.
    const text = output.text(), words = markerForms(word), marks = markerForms(marker);
    const shown = (name: string) => name === TEXTS_FILE || name === 'index.html';
    const beyond = searchTree(dry, words, path => shown(basename(path)));
    const where = searchTree(out, words, path => !shown(basename(path)) && statSync(path).isFile());
    const anywhere = searchTree(dry, marks);
    const printed = [...words, ...marks].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`13 privacy: the prompts' word in ${where.hits.length} files of the test's directory (its texts and page), in ${beyond.hits.length} of `
      + `${beyond.files} other files, unread ${beyond.unread.length + anywhere.unread.length}; the fake's word in ${anywhere.hits.length} of ${anywhere.files}; `
      + `printed ${printed}`);
    expect(same(where.hits.sort(), ['index.html', TEXTS_FILE]) && !beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length
      && !printed, 'no prompt anywhere but the texts and the page, and nothing printed');
    say(missed.length ? `the figure test's dry run did NOT go as expected: ${missed.length} of its checks` : 'the figure test\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

// The live commands read the texts, the card's record and the pilot's times and write the test's directory where they
// lie: a link on the way could lead out of the owner's reach.
function liveDirs() {
  for (const path of [join(ROOT, 'illustrations'), OUT_DIR, PILOT_DIR]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${relative(ROOT, path)} is a link: the test reads and writes only where the texts and the pilot lie`);
  }
}

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-figure-test-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (values.dir !== undefined) throw new Refusal('Only dry-run takes --dir: the test reads and writes illustrations/figure-card');
  liveDirs();
  if (command === 'estimate') {
    print({ event: 'estimate', ...estimateOf(inputsOf(OUT_DIR, PILOT_FILE, TEXTS_SHA256)) });
  } else if (command === 'page') {
    writePage(OUT_DIR, inputsOf(OUT_DIR, PILOT_FILE, TEXTS_SHA256), readJson<FiguresIndex>(join(OUT_DIR, INDEX_FILE)));
    print({ event: 'page', file: relative(ROOT, join(OUT_DIR, 'index.html')) });
  } else if (command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --until <epoch seconds, five minutes before the card\'s end> [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawFigures({ out: OUT_DIR, pilot: PILOT_FILE, comfy: comfyUrl(values.comfy!), until, pinned: TEXTS_SHA256, waitMs: wait * 1000,
      timeoutMs: timeout * 1000, log: print });
    if (index.error || index.stopped) process.exitCode = 1;
  } else throw new Refusal('Use: image-figure-test.ts estimate|draw|page|dry-run (docs/illustrations-plan.md#figure-card-test)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
