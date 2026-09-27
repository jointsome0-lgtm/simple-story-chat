// The refs stand (docs/action-experiment.md#refs-stand), for the picture card of the night of 2026-09-27. One card
// answers two questions about references in the bot. The first is qwen-refs' four arms (its final report's §4, with
// next-card-texts.txt): the wording that names the reference's role before the scene (ROLE, Qwen's own form), the
// face crop with the figure from words, the character sheet, and one shared style. The second is the owner's pose idea
// as "front + nearest view" (FV): each person's front for the identity beside one view turned as the scene turns them,
// both at 352x640. Round one's V, a view in place of the front, lost 14 identity points
// (docs/knowledge/action-measurements.md:69), and is not drawn again.
// 137 pictures in the card order: 14 fronts, 3 views, arm A's 28 frames, arm C's 32, 18 sheets, the 26 frames drawn
// from the sheets and from RF, then arm D's 16. The cuts follow the report's order: arm D comes last, so the end
// leaves it out first, and a sheet at CFG 1 (SH-cfg1) begins only if every core cell after it still fits.
// Every picture is drawn on the bot's picture path (docs/gpu.md#bot-card): cu130, the Triton backend, and the kitchen's
// attention on the sampler's model. A server that is not that path is refused, and a job whose log says the attention
// fell back to PyTorch's stops the run. Each is drawn at its cell's seed with the graphs' 25 steps of euler/simple:
//   a front   on gpu/image-workflow-qwen.json at 720x1280, CFG 1; RF at CFG 2 with its negative;
//   a sheet   on the same graph at 2048x1152, CFG 2 with the shared negative, or CFG 1 without one (SH-cfg1);
//   a view    on gpu/image-workflow-qwen-action.json at 704x1280, its front as image 1 at its own size;
//   a frame   on the same graph at 1280x704, CFG 1, each reference as its cell says: area-scaled to 352x640 as round
//             two's C, at its own size (704x1280 at the encoder), the top 720x400 of a front through ImageCrop
//             (704x384), or a sheet at `resolution` 1024 (1376x768); a VIEW frame at 704x1280.
// The texts are built from next-card-texts.txt and sheet-test/gpt-sheet-prompts.md, synthetic and clean, into
// texts.json in the run's directory. They stay out of the repository as the figure test's do: this file pins their
// sha256, refuses any other file, and holds every cell to PLANNED below.
//   estimate  the cells, their groups, the minutes at the seeded prices, and what the card costs
//   dry-run   the real texts' tokens and every graph built from them, then the whole run against local/fake-comfy.ts
//   draw      on the card, --out DIR --until EPOCH: cell by cell, each begun only if it can end by --until
//   page      DIR/index.html: a section an arm, the cells it compares side by side, each prompt folded under its picture
// What it prints is keys, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CLEANUP_RESERVE_MS, KITCHEN_ATTENTION, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, attentionOffered, comfyUrl, drawOne, latentSizeOf,
  logLines, partialLoadsSince, pngSize, referenceGeometry, referenceSlots, samplerSettingsOf, serverPins, settled, stopsTheRun, stripPngMetadata,
  uploadReference, withAttention } from './image-batch.ts';
import type { Comfy, Graph, Phases } from './image-batch.ts';
import { ACTION_GRAPH, CELL_MS, DRAW_CODES, FRAME_CANVAS, FRONT_GRAPH, MARGIN, SCALED, VIEW_CANVAS, WAIT_MS, actionGraph } from './action-draw.ts';
import { portraitCanvas } from './image-portraits.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { kitchenLines, kitchenOf } from './image-pilot.ts';
import { readJson } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { escapeHtml } from './action-judge.ts';
import { safeError } from './image-action.ts';
import { safeErrorDetails } from './model-error.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeJob } from './fake-comfy.ts';

const ROOT = resolve(import.meta.dirname, '..');
// texts.json as ~/simple-story-chat-runs/2026-09-27/refs-stand/build-texts.ts wrote it, byte for byte.
export const TEXTS_FILE = 'texts.json';
export const TEXTS_SHA256 = 'd0678be9753c496fc3ad754ad5124a0add622b8298a3f744f6c71f0da2728f61';
export const INDEX_FILE = 'cells.json';
// As the figure test prices: the run's first job pays the compile, the first job of each other group a shape of its
// own. A socket that did not open is waited out this long, once.
const COLD_MS = 45000, SHAPE_MS = 15000, RETRY_PAUSE_MS = 3000;
// The picture card's rate on 2026-09-27 (52996413, an RTX 5090, $0.605 an hour) and the minutes from the rental to the
// first picture (the weights, the cu130 environment and the server's start), for what `estimate` says the card costs.
const RATE = 0.605, BOOTSTRAP_MINUTES = 20;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const minutes = (ms: number) => Math.round(ms / 6000) / 10;
const seconds = (ms: number | undefined) => (ms === undefined ? 'нет' : String(Math.round(ms / 100) / 10).replace('.', ','));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return !sorted.length ? undefined : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const workflowError = () => Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
const noLink = (path: string) => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${path} is a link: nothing is read through it`);
};
// The kitchen's attention falling back to PyTorch's (comfy_extras/nodes_model_advanced.py:406-408), as
// local/image-levers.ts counts it.
const FALLBACK = /Attention backend '.*' is unavailable; using PyTorch attention\./;

// ---- The plan ----

export type Size = { width: number; height: number };
type Kind = 'front' | 'view' | 'sheet' | 'frame';
// How a reference reaches its slot: area-scaled to 352x640 (round two's C), at its own size, the top of a front through
// ImageCrop at its own size, or a sheet at the encoder's `resolution` 1024. The last is the whole node's setting, so a
// cell never mixes it with the others.
export type How = 's352' | 'own' | 'crop' | 'r1024';
export type Ref = { from: string; how: How };
// The sheets' shared negative, RF's, and the one of the second stand (local/image-refs-stand-2.ts).
export type Negative = 'none' | 'shared' | 'rf' | 'neg';
// `core` is drawn while it fits; `cfg1` only if every core cell after it fits too; `D` is last, the first cut.
export type Tier = 'core' | 'cfg1' | 'D';
export type Scene = 'K-solo' | 'K-pair' | 'P' | 'K-trio';
// What a cell is priced and timed with: its graph, canvas, CFG and references. The later stands' (local/image-refs-backlog.ts):
// three and six references at 352x640, two and three face crops, an edit of a picture with two or three references
// (`edit2`, `edit3`), and a pass over a picture with none (`clean`).
export const GROUPS = ['front', 'front2', 'view', 'words', 'ref1', 'ref2', 'ref4', 'crop', 'own1', 'own2', 'sheet', 'sheet1', 'sheetref', 'sheetview',
  'wordsCfg2', 'ref1Cfg2', 'ref3', 'ref6', 'crop2', 'crop3', 'edit2', 'edit3', 'clean'] as const;
export type Group = typeof GROUPS[number];
export const FRONT_CANVAS: Size = { width: 720, height: 1280 };
const SHEET_CANVAS: Size = { width: 2048, height: 1152 };
// The face crop: the top 720x400 of H's VN front at seed 7, which the encoder takes at 704x384 (next-card-texts.txt, FC).
export const CROP = { x: 0, y: 0, width: 720, height: 400 };
const SHEET_RESOLUTION = 1024;
export const SEEDS = [7, 11];
// A group's warm time in ms before the card has drawn one of it. A front, a frame from words and a frame with one
// reference at 352x640 as the pilot drew them with Triton (docs/illustrations-plan.md: 6.4, 6.1 and about 7 s) and
// the bot on the day's card (6 and 7 s). The rest are estimates from their tokens (qwen-refs' final report §4.3 and
// §4.5): CFG 2 runs the sampler twice, a reference is computed once into the prefix cache, and a 2048x1152 sheet has
// 9,216 tokens to a frame's 3,520. Once the card has drawn a group, its measured time prices it (`drawStand`). The
// second stand's frames at CFG 2 from the card's own times: a front took 5.0 s at CFG 1 and 8.2 s at CFG 2. The later
// stands' groups from the times of 2026-09-27 (docs/action-experiment.md#refs-backlog), a second or two over them.
export const SEED_MS: Record<Group, number> = { front: 6500, front2: 12000, view: 9000, words: 6500, ref1: 7500, ref2: 8000, ref4: 9500, crop: 7500,
  own1: 9000, own2: 10500, sheet: 55000, sheet1: 29000, sheetref: 10500, sheetview: 10500, wordsCfg2: 10000, ref1Cfg2: 11000,
  ref3: 8000, ref6: 8500, crop2: 8000, crop3: 8000, edit2: 9000, edit3: 9500, clean: 7000 };
// The price a cell is admitted by: its time, a quarter more, and three seconds, as round two prices.
const priceOf = (ms: number) => Math.round(ms * MARGIN + CELL_MS);

// `start` and `denoise`: a frame the sampler begins from another picture of the run rather than from an empty latent,
// that picture through VAEEncode at `denoise` below 1 (the later stands' arm S).
export type Planned = { key: string; id: string; arm: string; kind: Kind; scene?: Scene; seed: number; group: Group; tier: Tier;
  graph: 'front' | 'action'; canvas: Size; cfg: number; negative: Negative; refs: Ref[]; file: string; start?: string; denoise?: number };
export const frontKey = (id: string, seed = 7) => `front:${id}:s${seed}`;
export const viewKey = (id: string) => `view:${id}:s7`;
export const sheetKey = (id: string, seed: number) => `sheet:${id}:s${seed}`;
export const frameKey = (id: string, scene: Scene | undefined, seed: number) => `frame:${id}${scene ? `:${scene}` : ''}:s${seed}`;
// H's front in today's portrait style and in each reader style; L's for the pair.
export const FRONT_IDS = ['H-PORTRAIT', 'L-PORTRAIT', 'H-VN', 'H-FILM', 'H-SEMI', 'H-PENCIL'];
export const STYLES = ['VN', 'FILM', 'SEMI', 'PENCIL'] as const;
// FV's views, each an edit of a front turned as a scene turns its person: H three-quarters to the right in K, H in
// profile facing left in P, L three-quarters to the left in K's pair.
export const VIEWS = [{ id: 'H-34R', front: frontKey('H-PORTRAIT') }, { id: 'H-PL', front: frontKey('H-PORTRAIT') },
  { id: 'L-34L', front: frontKey('L-PORTRAIT') }];
// The sheets' people: H, and cases 1 to 4 of gpt-sheet-prompts.md.
export const SHEET_PEOPLE = ['H', '1', '2', '3', '4'];
const ALL: Scene[] = ['K-solo', 'P', 'K-pair'], SOLO: Scene[] = ['K-solo', 'P'], KS: Scene[] = ['K-solo', 'K-pair'];

function groupOf(one: { kind: Kind; cfg: number; refs: Ref[]; canvas: Size; start?: string }): Group {
  if (one.kind === 'front') return one.cfg === 1 ? 'front' : 'front2';
  if (one.kind === 'sheet') return one.cfg === 1 ? 'sheet1' : 'sheet';
  if (one.kind === 'view') return 'view';
  const how = one.refs[0]?.how, count = one.refs.length;
  if (one.start !== undefined) {
    // The edit: the picture it starts from at its own size in slot 1, and the people's fronts at 352x640 after it.
    if (one.cfg !== 1 || (count && (how !== 'own' || count < 3 || count > 4 || one.refs.slice(1).some(ref => ref.how !== 's352')))) {
      throw new Error('A frame from a picture is at CFG 1, with no reference or with that picture and two or three fronts at 352x640');
    }
    return !count ? 'clean' : count === 3 ? 'edit2' : 'edit3';
  }
  if (one.cfg !== 1) {
    if (how && (how !== 's352' || count !== 1)) throw new Error('A frame at CFG 2 takes one reference at 352x640 or none');
    return how ? 'ref1Cfg2' : 'wordsCfg2';
  }
  if (!how) return 'words';
  if (how === 'r1024') return one.canvas.height > one.canvas.width ? 'sheetview' : 'sheetref';
  if (how === 'crop') return count === 1 ? 'crop' : count === 2 ? 'crop2' : 'crop3';
  if (how === 'own') return count === 1 ? 'own1' : 'own2';
  return count === 1 ? 'ref1' : count === 2 ? 'ref2' : count === 3 ? 'ref3' : count === 4 ? 'ref4' : 'ref6';
}
// A cell with its group and its file in the run's directory, under fronts, views, sheets or frames by its kind.
export const cellOf = (one: Omit<Planned, 'group' | 'file' | 'tier'> & { tier?: Tier }): Planned => {
  const cell = { ...one, tier: one.tier ?? 'core' };
  const dir = { front: 'fronts', view: 'views', sheet: 'sheets', frame: 'frames' }[one.kind];
  return { ...cell, group: groupOf(cell), file: join(dir, `${one.id}${one.scene ? `-${one.scene}` : ''}-s${one.seed}.png`) };
};
// The card's cells in the order drawn: fronts and RF, FV's views, arm A with FV, arm C, the sheets, the frames from the
// sheets and RF, arm D (the report's §4.3, FV beside R, which it is compared with).
function planOf(): Planned[] {
  const out: Planned[] = [];
  const add = (one: Parameters<typeof cellOf>[0]) => out.push(cellOf(one));
  const frames = (arm: string, id: string, scenes: Scene[], refs: (scene: Scene) => Ref[], tier: Tier = 'core') => {
    for (const scene of scenes) for (const seed of SEEDS) {
      add({ key: frameKey(id, scene, seed), id, arm, kind: 'frame', scene, seed, graph: 'action', canvas: FRAME_CANVAS, cfg: 1, negative: 'none', refs: refs(scene), tier });
    }
  };
  const at = (from: string, how: How): Ref => ({ from, how });
  const H = frontKey('H-PORTRAIT'), L = frontKey('L-PORTRAIT');
  const people = (scene: Scene, how: How) => (scene === 'K-pair' ? [at(H, how), at(L, how)] : [at(H, how)]);
  for (const id of FRONT_IDS) for (const seed of SEEDS) {
    add({ key: frontKey(id, seed), id, arm: /PORTRAIT|VN/.test(id) ? 'A' : 'C', kind: 'front', seed, graph: 'front', canvas: FRONT_CANVAS, cfg: 1, negative: 'none', refs: [] });
  }
  for (const seed of SEEDS) add({ key: frontKey('RF', seed), id: 'RF', arm: 'B', kind: 'front', seed, graph: 'front', canvas: FRONT_CANVAS, cfg: 2, negative: 'rf', refs: [] });
  for (const view of VIEWS) {
    add({ key: viewKey(view.id), id: view.id, arm: 'FV', kind: 'view', seed: 7, graph: 'action', canvas: VIEW_CANVAS, cfg: 1, negative: 'none', refs: [at(view.front, 'own')] });
  }
  frames('A', 'C-now', ALL, scene => people(scene, 's352'));
  frames('A', 'R', ALL, scene => people(scene, 's352'));
  frames('FV', 'FV', ALL, scene => (scene === 'K-solo' ? [at(H, 's352'), at(viewKey('H-34R'), 's352')] : scene === 'P' ? [at(H, 's352'), at(viewKey('H-PL'), 's352')]
    : [at(H, 's352'), at(viewKey('H-34R'), 's352'), at(L, 's352'), at(viewKey('L-34L'), 's352')]));
  frames('A', 'W', ALL, () => []);
  frames('A', 'FC', SOLO, () => [at(frontKey('H-VN'), 'crop')]);
  for (const style of ['FILM', 'SEMI', 'PENCIL']) frames('C', `W-${style}`, SOLO, () => []);
  frames('C', 'C-VN', SOLO, () => [at(frontKey('H-VN'), 's352')]);
  for (const style of STYLES) frames('C', `R-${style}`, SOLO, () => [at(frontKey(`H-${style}`), 's352')]);
  const sheets = (id: string, cfg: number, negative: Negative, tier: Tier = 'core') => {
    for (const seed of SEEDS) add({ key: sheetKey(id, seed), id, arm: 'B', kind: 'sheet', seed, graph: 'front', canvas: SHEET_CANVAS, cfg, negative, refs: [], tier });
  };
  for (const who of SHEET_PEOPLE) sheets(`SH-${who}`, 2, 'shared');
  for (const who of ['H', '4']) sheets(`SH-words-${who}`, 2, 'shared');
  for (const who of ['H', '4']) sheets(`SH-cfg1-${who}`, 1, 'none', 'cfg1');
  for (const sheet of SEEDS) frames('B', `SF-sheet${sheet}`, SOLO, () => [at(sheetKey('SH-H', sheet), 'r1024')]);
  frames('B', 'QRF', SOLO, () => [at(frontKey('RF'), 'own')]);
  frames('B', 'SF-VN', SOLO, () => [at(sheetKey('SH-H', 7), 'r1024')]);
  for (const who of SHEET_PEOPLE) for (const seed of SEEDS) {
    add({ key: frameKey(`VIEW-${who}`, undefined, seed), id: `VIEW-${who}`, arm: 'B', kind: 'frame', seed, graph: 'action', canvas: VIEW_CANVAS, cfg: 1,
      negative: 'none', refs: [at(sheetKey(`SH-${who}`, seed), 'r1024')] });
  }
  frames('D', 'Q', KS, scene => people(scene, 'own'), 'D');
  frames('D', 'X', ['K-solo'], () => [at(L, 'own')], 'D');
  frames('D', 'Naming', ['K-pair'], () => [at(H, 'own'), at(L, 'own')], 'D');
  frames('D', 'Order', ['K-pair'], () => [at(L, 'own'), at(H, 'own')], 'D');
  frames('D', 'Rough', KS, scene => people(scene, 'own'), 'D');
  frames('D', 'L-now', ['K-pair'], () => [], 'D');
  return out;
}
export const PLANNED = planOf();
export const BY_KEY = new Map(PLANNED.map(one => [one.key, one]));
export const sizeText = (size: Size) => `${size.width}x${size.height}`;
// The size a reference reaches the encoder at, from the picture it is made of.
const atEncoder = (how: How, from: Size): Size => {
  const [width, height] = how === 's352' ? [SCALED.width, SCALED.height] : how === 'crop' ? referenceGeometry(CROP.width, CROP.height, 0)
    : referenceGeometry(from.width, from.height, how === 'r1024' ? SHEET_RESOLUTION : 0);
  return { width, height };
};
// Qwen-Image 2.1's tokens for a picture of this size: one a 16x16 patch of pixels (8 in the VAE, 2 in the patching).
const tokensOf = (size: Size) => (size.width / 16) * (size.height / 16);

// ---- The texts ----

export type TextCell = { key: string; kind: Kind; seed: number; graph: 'front' | 'action'; canvas: string; cfg: number; refs: Ref[]; prompt: string;
  negative: string; start?: string; denoise?: number };
type Texts = { hash: string; cells: Map<string, TextCell> };
// texts.json, read as the figure test reads its texts: a link, a missing file and a file other than the one pinned are
// refused, and so is one whose cells are not the plan's, key by key in its order, each on its graph, canvas and CFG with
// its references and the picture it starts from, a prompt, no negative where CFG 1 skips it, and one negative a kind:
// all the sheets', RF's, the NEG cells' of the second stand.
function readTexts(file: string, pinned: string, plan: Planned[]): Texts {
  noLink(file);
  if (!existsSync(file)) throw new Refusal(`${file} is missing: the texts are fixed before the card, and nothing is drawn`);
  const bytes = readFileSync(file), bad = (why: string) => new Refusal(`${file} ${why}; nothing is drawn from it`);
  if (sha256(bytes) !== pinned) throw bad('is not the texts fixed before the card, whose sha256 image-refs-test.ts pins');
  let read: unknown;
  try { read = JSON.parse(bytes.toString('utf8')); } catch { throw bad('is not JSON'); }
  const cells = typeof read === 'object' && read !== null ? (read as { cells?: unknown }).cells : undefined;
  if (!Array.isArray(cells) || cells.length !== plan.length) throw bad(`does not hold the stand's ${plan.length} cells`);
  const found = new Map<string, TextCell>(), negatives = new Map<Negative, Set<string>>();
  plan.forEach((one, at) => {
    const cell = cells[at] as Partial<TextCell> | null;
    const right = typeof cell === 'object' && cell !== null && cell.key === one.key && cell.kind === one.kind && cell.seed === one.seed
      && cell.graph === one.graph && cell.canvas === sizeText(one.canvas) && cell.cfg === one.cfg && same(cell.refs, one.refs)
      && cell.start === one.start && cell.denoise === one.denoise
      && typeof cell.prompt === 'string' && cell.prompt.trim() !== '' && typeof cell.negative === 'string'
      && (one.negative === 'none') === (cell.negative === '');
    if (!right) throw bad(`has as its cell ${at + 1} no ${one.key} on its graph, canvas and CFG, with its references and start, a prompt and its negative`);
    negatives.set(one.negative, (negatives.get(one.negative) ?? new Set()).add(cell.negative!));
    found.set(one.key, cell as TextCell);
  });
  if ([...negatives].some(([kind, texts]) => kind !== 'none' && texts.size !== 1)) throw bad('has more than one negative of a kind');
  return { hash: sha256(bytes), cells: found };
}

// ---- What is drawn from ----

type Recipe = { steps: number; sampler: string; scheduler: string };
const recipeOf = (graph: Graph): Recipe => {
  const own = samplerSettingsOf(graph);
  return { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler, scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler };
};
export type Inputs = { texts: Texts; frontGraph: Graph; base: Graph; recipe: Recipe };
// The graphs as pinned, the canvases they pin, and one recipe for both; then the texts.
export function inputsOf(textsFile: string, pinned: string, plan = PLANNED): Inputs {
  const frontGraph = apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))), base = apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
  const recipe = recipeOf(frontGraph), slots = Math.max(4, ...plan.map(one => one.refs.length));
  if (!same(portraitCanvas(frontGraph), FRONT_CANVAS) || !same(latentSizeOf(base), FRAME_CANVAS) || !same(recipeOf(base), recipe)
    || referenceSlots(base).length < slots) {
    throw new Refusal(`The pinned graphs no longer give the fronts 720x1280, the frames 1280x704, one recipe and ${slots} reference slots; nothing is drawn`);
  }
  return { texts: readTexts(textsFile, pinned, plan), frontGraph, base, recipe };
}
type Setup = Inputs & { card: ReturnType<typeof cardOf>; pins: Record<string, string> };
// And the card's record at <out>/card.txt. The pins are all a picture here depends on beyond the server: the texts,
// both graphs, the canvases, the crop, the sizes references reach the encoder at, the attention, and the weights the
// card verified. A resume under any other, or on a server that says another thing of itself, is refused.
export function setupOf(out: string, pinned: string, plan = PLANNED): Setup {
  let card: ReturnType<typeof cardOf>;
  noLink(join(out, 'card.txt'));
  try { card = cardOf(join(out, 'card.txt')); }
  catch { throw new Refusal(`${join(out, 'card.txt')} is missing or differs from gpu/image-manifest.env: copy the card's image-verified.txt there first; nothing is drawn`); }
  const inputs = inputsOf(join(out, TEXTS_FILE), pinned, plan);
  return { ...inputs, card, pins: { texts: inputs.texts.hash, frontGraph: sha256(readFileSync(FRONT_GRAPH)), actionGraph: sha256(readFileSync(ACTION_GRAPH)),
    frontCanvas: sizeText(FRONT_CANVAS), sheetCanvas: sizeText(SHEET_CANVAS), frameCanvas: sizeText(FRAME_CANVAS), viewCanvas: sizeText(VIEW_CANVAS),
    scaled: sizeText(SCALED), crop: `${CROP.width}x${CROP.height}+${CROP.x}+${CROP.y}`, sheetResolution: String(SHEET_RESOLUTION),
    attention: KITCHEN_ATTENTION, comfyuiRevision: card.comfyuiRevision, transformer: card.transformer, encoder: card.encoder, vae: card.vae } };
}

// ---- The prices ----

// What `cells` cost from here at the admission prices, in order: the run's first cell with the compile and each other
// group's first with a shape of its own, unless a job of the run has reached the card (`reached`) or of that group
// (`seen`).
function needOf(cells: Planned[], price: (group: Group) => number, reached = false, seen: Set<Group> = new Set()) {
  let any = reached;
  const groups = new Set(seen);
  return cells.reduce((sum, one) => {
    const extra = !any ? COLD_MS : groups.has(one.group) ? 0 : SHAPE_MS;
    any = true;
    groups.add(one.group);
    return sum + price(one.group) + extra;
  }, 0);
}
const seeded = (group: Group) => priceOf(SEED_MS[group]);
// The cells at the seeded warm times with half the compile and half each group's shape, and at the admission prices;
// the arms, the tiers the end cuts first, and the card's cost: the drawing alone and with the bootstrap.
export function estimateOf(rate = RATE, bootstrap = BOOTSTRAP_MINUTES, budget = 60, plan = PLANNED) {
  const count = (test: (one: Planned) => boolean) => plan.filter(test).length;
  const groups = new Set(plan.map(one => one.group)).size;
  const expectedMs = plan.reduce((sum, one) => sum + SEED_MS[one.group], 0) + COLD_MS / 2 + (groups - 1) * SHAPE_MS / 2;
  const pricedMs = needOf(plan, seeded), coreMs = needOf(plan.filter(one => one.tier === 'core'), seeded);
  const fits = minutes(pricedMs) <= budget, cut = fits ? [] : minutes(needOf(plan.filter(one => one.tier !== 'D'), seeded)) <= budget ? ['D'] : ['D', 'cfg1'];
  const cost = (ms: number) => Math.round((minutes(ms) + bootstrap) / 60 * rate * 100) / 100;
  return { cells: plan.length, fronts: count(one => one.kind === 'front'), views: count(one => one.kind === 'view'), sheets: count(one => one.kind === 'sheet'),
    frames: count(one => one.kind === 'frame'), arms: Object.fromEntries([...new Set(plan.map(one => one.arm))].map(arm => [arm, count(one => one.arm === arm)])),
    expectedMinutes: minutes(expectedMs), pricedMinutes: minutes(pricedMs), coreMinutes: minutes(coreMs),
    tiers: { cfg1: { cells: count(one => one.tier === 'cfg1'), minutes: minutes(needOf(plan.filter(one => one.tier === 'cfg1'), seeded, true, new Set())) },
      D: { cells: count(one => one.tier === 'D'), minutes: minutes(needOf(plan.filter(one => one.tier === 'D'), seeded, true, new Set(plan.map(one => one.group)))) } },
    budgetMinutes: budget, fits, cut, bootstrapMinutes: bootstrap, dollarsPerHour: rate,
    dollars: { expected: cost(expectedMs), priced: cost(pricedMs) },
    cellSeconds: Object.fromEntries(GROUPS.filter(group => count(one => one.group === group)).map(group => [group, { cells: count(one => one.group === group),
      expected: SEED_MS[group] / 1000, priced: seeded(group) / 1000 }])) };
}

// ---- The graphs ----

const cropNode = (slot: number) => String(40 + slot);
// The loader of the picture a frame starts from, and its VAEEncode.
const START_LOADER = '50', START_ENCODE = '51';
// A cell's graph: a front or a sheet on the front graph at its canvas; a view or a frame on the action graph with a
// scale node to 352x640 on each slot that asks for one and an ImageCrop on the slot of the face crop, the slots it
// leaves empty gone with their chains, and the encoder at `resolution` 1024 for a sheet, 0 otherwise. A frame with a
// `start` begins from that picture (`startName`, uploaded) through its own loader and a VAEEncode on the graph's VAE, in
// place of the empty latent, at its `denoise`: the pinned KSampler then runs the last 25 of int(25 / denoise) steps of
// the schedule (comfy/samplers.py:1431-1441), and the encoder's references stay as they are. Each with the graphs'
// recipe, the cell's CFG and seed, its prompt and negative, and the kitchen's attention on the sampler's model.
export function buildJob(setup: Inputs & { card: { model: string } }, one: Planned, text: TextCell, names: string[], startName?: string): Graph {
  const values = { checkpoint: setup.card.model, prompt: text.prompt, negative: text.negative, seed: one.seed, ...setup.recipe, cfg: one.cfg, ...one.canvas };
  let graph: Graph;
  if (one.graph === 'front') graph = applyToWorkflow(setup.frontGraph, values);
  else {
    const base = actionGraph(setup.base, one.refs.flatMap((ref, at) => (ref.how === 's352' ? [at + 1] : []))).graph;
    const slots = referenceSlots(base);
    one.refs.forEach((ref, at) => {
      if (ref.how !== 'crop') return;
      base[cropNode(at + 1)] = { class_type: 'ImageCrop', inputs: { image: [slots[at].loader, 0], ...CROP } };
      base[slots[at].node].inputs[slots[at].key] = [cropNode(at + 1), 0];
    });
    graph = applyToWorkflow(base, { ...values, references: names });
    const encoder = Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21');
    if (!encoder) throw workflowError();
    encoder.inputs.resolution = one.refs.some(ref => ref.how === 'r1024') ? SHEET_RESOLUTION : 0;
  }
  if ((one.start === undefined) !== (startName === undefined) || (one.start !== undefined && one.graph !== 'action')) throw workflowError();
  if (startName !== undefined) {
    const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
    const empty = sampler && Array.isArray(sampler.inputs.latent_image) ? String(sampler.inputs.latent_image[0]) : undefined;
    const vae = Object.entries(graph).find(([, node]) => node.class_type === 'VAELoader')?.[0];
    if (!sampler || empty === undefined || graph[empty]?.class_type !== 'EmptyLatentImage' || vae === undefined || graph[START_LOADER] || graph[START_ENCODE]) {
      throw workflowError();
    }
    delete graph[empty];
    graph[START_LOADER] = { class_type: 'LoadImage', inputs: { image: startName } };
    graph[START_ENCODE] = { class_type: 'VAEEncode', inputs: { pixels: [START_LOADER, 0], vae: [vae, 0] } };
    sampler.inputs.latent_image = [START_ENCODE, 0];
    sampler.inputs.denoise = one.denoise;
  }
  const attended = withAttention(graph);
  if (!attended) throw workflowError();
  return attended;
}
// Each reference slot of the encoder in slot order as the graph goes out: the nodes between it and its loader, with
// what each asks for, and the file on the loader.
export function slotChains(graph: Graph) {
  const from = (link: unknown) => (Array.isArray(link) ? graph[String(link[0])] : undefined);
  const found: { order: number; chain: unknown[] }[] = [];
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      const slot = /^images\.image_(\d+)$/.exec(key);
      if (!slot) continue;
      const chain: unknown[] = [];
      for (let at = from(value), hops = 0; at && hops < 4; at = from(at.inputs.image), hops++) {
        if (at.class_type === 'LoadImage') { chain.push('LoadImage', at.inputs.image); break; }
        if (at.class_type === 'ImageScale') chain.push('ImageScale', at.inputs.upscale_method, at.inputs.width, at.inputs.height, at.inputs.crop);
        else if (at.class_type === 'ImageCrop') chain.push('ImageCrop', at.inputs.width, at.inputs.height, at.inputs.x, at.inputs.y);
        else { chain.push(at.class_type); break; }
      }
      found.push({ order: Number(slot[1]), chain });
    }
  }
  return found.sort((a, b) => a.order - b.order);
}
const wantedChain = (ref: Ref, name: string) => (ref.how === 's352' ? ['ImageScale', 'area', SCALED.width, SCALED.height, 'disabled', 'LoadImage', name]
  : ref.how === 'crop' ? ['ImageCrop', CROP.width, CROP.height, CROP.x, CROP.y, 'LoadImage', name] : ['LoadImage', name]);
// A cell's graph as it goes out, read from the sampler and the save rather than by the ids the graphs give: the recipe,
// the cell's CFG and seed at full denoise from an empty latent of its canvas, or at its `denoise` from its start
// picture through VAEEncode on the graph's VAE; the prompt and the negative on Qwen's encoder, both conditionings from
// it; on a view or a frame the VAE wired to the encoder and its `resolution`; the model from the loader of the card's
// transformer through the kitchen's attention, and the action graph's cache on a view or a frame; each slot the chain
// its reference asks for, and no other loader, scale or crop; one save, of the sampler's decode.
export function cellRight(graph: Graph, one: Planned, text: TextCell, names: string[], setup: Inputs & { card: { model: string } }, startName?: string): boolean {
  const from = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
  const nodes = Object.values(graph), recipe = setup.recipe;
  const samplers = nodes.filter(node => node.class_type === 'KSampler'), saves = nodes.filter(node => node.class_type === 'SaveImage');
  if (samplers.length !== 1 || saves.length !== 1) return false;
  const sampler = samplers[0].inputs, positive = from(sampler.positive), latent = from(sampler.latent_image);
  const pixels = from(latent?.inputs.pixels);
  const started = one.start === undefined
    ? startName === undefined && sampler.denoise === 1 && latent?.class_type === 'EmptyLatentImage' && latent.inputs.width === one.canvas.width
      && latent.inputs.height === one.canvas.height && latent.inputs.batch_size === 1
    : startName !== undefined && typeof one.denoise === 'number' && one.denoise > 0 && one.denoise < 1 && sampler.denoise === one.denoise
      && latent?.class_type === 'VAEEncode' && from(latent.inputs.vae)?.class_type === 'VAELoader' && pixels?.class_type === 'LoadImage'
      && pixels.inputs.image === startName && !nodes.some(node => node.class_type === 'EmptyLatentImage');
  const sampled = sampler.seed === one.seed && sampler.steps === recipe.steps && sampler.sampler_name === recipe.sampler
    && sampler.scheduler === recipe.scheduler && sampler.cfg === one.cfg && started;
  const worded = positive?.class_type === 'TextEncodeQwenImage21' && from(sampler.negative) === positive && same(sampler.positive, [(sampler.positive as unknown[])[0], 0])
    && same(sampler.negative, [(sampler.positive as unknown[])[0], 1]) && positive.inputs.prompt === text.prompt && positive.inputs.negative_prompt === text.negative
    && (one.graph === 'front' || (from(positive.inputs.vae)?.class_type === 'VAELoader'
      && positive.inputs.resolution === (one.refs.some(ref => ref.how === 'r1024') ? SHEET_RESOLUTION : 0)));
  const model: Graph[string][] = [];
  for (let node = from(sampler.model); node && model.length < 8; node = from(node.inputs.model)) model.push(node);
  const modelled = same(model.map(node => node.class_type), one.graph === 'front' ? ['ModelAttentionBackend', 'UNETLoader']
    : ['ModelAttentionBackend', 'QwenImage21Cache', 'UNETLoader']) && model[0].inputs.attention === KITCHEN_ATTENTION
    && model.at(-1)?.inputs.unet_name === setup.card.model && nodes.filter(node => node.class_type === 'ModelAttentionBackend').length === 1;
  const slotted = names.length === one.refs.length
    && nodes.filter(node => node.class_type === 'LoadImage').length === names.length + (startName === undefined ? 0 : 1)
    && nodes.filter(node => node.class_type === 'ImageScale').length === one.refs.filter(ref => ref.how === 's352').length
    && nodes.filter(node => node.class_type === 'ImageCrop').length === one.refs.filter(ref => ref.how === 'crop').length
    && same(slotChains(graph), one.refs.map((ref, at) => ({ order: at + 1, chain: wantedChain(ref, names[at]) })));
  const decoded = from(saves[0].inputs.images);
  return sampled && worded && modelled && slotted && decoded?.class_type === 'VAEDecode' && from(decoded.inputs.samples) === samplers[0];
}

// ---- The drawing ----

// `references`: the sha256 of each picture a cell took, in slot order; `start`: of the picture it began from.
// `session`: the run of a stand that may go on on another card (`Stand.cards`) it was drawn in.
export type Cell = { key: string; id: string; arm: string; kind: Kind; seed: number; group: Group; refs: number; status: 'drawn' | 'failed' | 'out'; code?: string;
  httpStatus?: number; oom?: boolean; retried?: boolean; file?: string; sha256?: string; bytes?: number; width?: number; height?: number;
  references?: string[]; start?: string; session?: number; cold?: boolean; firstOfGroup?: boolean; totalMs?: number; viewMs?: number; queueMs?: number;
  sampleMs?: number; phases?: Phases; loaderCacheMiss?: boolean; uploadMs?: number; vramSamples?: number; partialModelLoadEvents?: number; fallback?: number;
  promptChars?: number };
type KitchenRecord = { seen: boolean; argv: boolean; tritonImported: boolean; tritonImportFailed: boolean; backends: Record<string, { available: boolean; disabled: boolean }> };
// cells.json: keys, codes, sizes, counts and times, no prompt. `server`: what the server said it is, triton among it;
// `kitchen`: what its log said of comfy-kitchen's backends at its start. A stand that may go on on another card keeps
// each run as a session, with what its server said, and each picture it takes from another stand's run by its sha256
// as it was first seen drawn (`lent`).
export type StandIndex = { startedAt: string; completedAt?: string; pins: Record<string, string>; server: Record<string, string>; kitchen?: KitchenRecord;
  cells: Record<string, Cell>; stopped?: 'until'; error?: string; sessions?: { startedAt: string; server: Record<string, string> }[];
  lent?: Record<string, string> };
// What the card has compiled: whether a job has reached it, and the groups the jobs had. A caller that draws several
// stands in turn on one card hands the same one to each.
export type Warmth = { reached: boolean; groups: Set<Group> };
// `keys`: the cells a run draws, in the plan's order; every one otherwise. `stand`: a stand beside PLANNED's; `from`:
// the directories of the runs whose pictures its cells take.
type Options = { out: string; comfy: string; until: number; pinned: string; stand?: Stand; from?: string | string[]; keys?: string[]; timeoutMs?: number;
  waitMs?: number; pollMs?: number; warm?: Warmth; log: (event: object) => void };
export const countsOf = (index: StandIndex) => {
  const cells = Object.values(index.cells), tally = (status: Cell['status']) => cells.filter(one => one.status === status)
    .reduce<Record<string, number>>((all, one) => ({ ...all, [one.code ?? 'image_failed']: (all[one.code ?? 'image_failed'] ?? 0) + 1 }), {});
  return { drawn: cells.filter(one => one.status === 'drawn').length, failed: tally('failed'), out: tally('out') };
};

// The pictures a stand's cells take and do not draw: each drawn by one of the runs in `from`, as that run's cells.json
// records it, on the same graphs, weights and attention, and a picture two of them hold is refused. Which pictures
// they are is pinned with the run's own pins (`pin`), or, for a stand that pins each (`Stand.pinEach`), each as it is
// first seen drawn (drawStand); there a run in `from` that has not begun, whose directory has no cells.json yet, lends
// nothing for now.
function lentOf(plan: Planned[], pins: Record<string, string>, from: string[], each: boolean) {
  const keys = [...new Set(plan.flatMap(one => [...one.refs.map(ref => ref.from), ...(one.start === undefined ? [] : [one.start])]))]
    .filter(key => !plan.some(one => one.key === key));
  if (!keys.length) return undefined;
  if (!from.length) throw new Refusal(`The cells take ${keys.length} pictures another run drew: --from names its directory; nothing is drawn`);
  const runs = from.map(dir => {
    const at = resolve(dir), file = join(at, INDEX_FILE);
    noLink(file);
    if (each && statSync(at, { throwIfNoEntry: false })?.isDirectory() && !existsSync(file)) return { dir: at, cells: {} as Record<string, Cell> };
    const index = readJson<StandIndex>(file);
    if (!index || ['frontGraph', 'actionGraph', 'attention', 'comfyuiRevision', 'transformer', 'encoder', 'vae'].some(name => index.pins[name] !== pins[name])) {
      throw new Refusal(`${file} is missing, or its run was drawn from other graphs, weights or attention; nothing is drawn`);
    }
    return { dir: at, cells: index.cells };
  });
  const found = new Map<string, { dir: string; cell: Cell }>();
  for (const key of keys) {
    const holding = runs.filter(run => run.cells[key] !== undefined);
    if (holding.length > 1) throw new Refusal(`${key} is in ${holding.length} of the runs in --from, and a cell would not know which it takes; nothing is drawn`);
    if (holding.length) found.set(key, { dir: holding[0].dir, cell: holding[0].cells[key] });
  }
  return { keys, found, pin: sha256(JSON.stringify(keys.map(key => [key, found.get(key)?.cell.sha256 ?? null]))) };
}

// Every cell not yet drawn, one at a time through the harness's drawOne, in the plan's order. A cell whose references
// or start are not all drawn is `out` until a resume. Each is begun only if it can end by `until` at its group's price,
// the compile of the card's first cell and a shape of each other group's first priced in, and none after the first
// that cannot; an SH-cfg1 sheet only if the core cells after it fit too, or it is `cut`. A group is priced from the
// seeded time until the card has drawn it: then from the slowest of its warm cells, or its first cell's until one is
// warm. A socket that does not open is waited out once; a failed cell is recorded and the run goes on, unless its code
// says the graph or the server is wrong (stopsTheRun), or the kitchen's attention fell back, which stop the run. Each
// run uploads every picture it takes afresh, so that a run on a new card has them. It sends no `front`: a job of the
// bot's that the server puts in front of the queue waits at most for the one cell being drawn.
export async function drawStand(options: Options): Promise<StandIndex> {
  const stand = options.stand ?? FIRST, byKey = new Map(stand.plan.map(one => [one.key, one]));
  const others = new Map((stand.others ?? []).map(one => [one.key, one]));
  const out = resolve(options.out), file = join(out, INDEX_FILE);
  const setup = setupOf(out, options.pinned, stand.plan), earlier = readJson<StandIndex>(file);
  const from = options.from === undefined ? [] : [options.from].flat();
  const lent = lentOf(stand.plan, setup.pins, from, stand.pinEach === true), pins = lent && !stand.pinEach ? { ...setup.pins, lent: lent.pin } : setup.pins;
  // A picture taken from another stand's run, pinned as first seen drawn: one that has changed since is refused.
  const changed = !stand.pinEach || !lent ? [] : [...lent.found].filter(([key, { cell }]) => cell.status === 'drawn' && earlier?.lent?.[key] !== undefined
    && earlier.lent[key] !== cell.sha256).map(([key]) => key);
  if (changed.length) {
    throw new Refusal(`${changed.length} of the pictures this run took from another stand's (${changed.join(', ')}) are not the ones it took: move ${file} aside; nothing is drawn`);
  }
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card); nothing is drawn');
  });
  // The bot's path (docs/gpu.md#bot-card): torch for CUDA 13 or later, the Triton backend, the kitchen's attention.
  const cuda = Number(/\+cu(\d+)$/.exec(server.pytorch ?? '')?.[1] ?? 0);
  const offered = await attentionOffered(comfy).catch(() => false);
  if (cuda < 130 || server.triton !== 'enabled' || !offered) {
    throw new Refusal('The stand draws on the bot\'s picture path: a server on cu130 with SIMPLE_CHAT_IMAGE_TRITON=1 whose ModelAttentionBackend offers '
      + `the kitchen's attention (docs/gpu.md#bot-card); this one has cu${cuda || '?'}, Triton ${server.triton ?? 'off'}, the attention ${offered ? 'offered' : 'not offered'}; nothing is drawn`);
  }
  // A stand that may go on on another card is held to the same ComfyUI, torch and Triton, the card's name aside.
  const held = (said: Record<string, string>) => (stand.cards ? Object.fromEntries(Object.entries(said).filter(([name]) => name !== 'card')) : said);
  if (earlier && (!same(earlier.pins, pins) || !same(held(earlier.server), held(server)))) {
    throw new Refusal(`${file} was drawn from other texts, graphs, weights or pictures, or on a server that said another thing of itself: move it aside; nothing is drawn`);
  }
  const kitchen = kitchenOf(await logLines(comfy), server.triton === 'enabled');
  const index: StandIndex = earlier ?? { startedAt: new Date().toISOString(), pins, server, cells: {} };
  if (kitchen.seen || !index.kitchen) {
    index.kitchen = { seen: kitchen.seen, argv: kitchen.argv, tritonImported: kitchen.tritonImported, tritonImportFailed: kitchen.tritonImportFailed,
      backends: Object.fromEntries(Object.entries(kitchen.backends).map(([name, one]) => [name, { available: one.available, disabled: one.disabled }])) };
  }
  let session: number | undefined;
  if (stand.cards) {
    index.sessions = [...(index.sessions ?? []), { startedAt: new Date().toISOString(), server }];
    session = index.sessions.length - 1;
  }
  if (stand.pinEach && lent) {
    for (const [key, { cell }] of lent.found) if (cell.status === 'drawn' && cell.sha256) index.lent = { ...index.lent, [key]: cell.sha256 };
  }
  delete index.completedAt;
  delete index.stopped;
  delete index.error;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, index);
  save();
  const page = () => writePage(out, setup, index, stand);
  page();
  const done = (key: string) => {
    const cell = index.cells[key], path = cell?.file === undefined ? undefined : join(out, cell.file);
    return cell?.status === 'drawn' && path !== undefined && existsSync(path) && sha256(readFileSync(path)) === cell.sha256;
  };
  // A picture as a cell takes it: drawn, where its record says, the very bytes, at its cell's canvas; by this run, or by
  // the run it borrows from, and then the one pinned where the stand pins each.
  const pictureOf = (key: string) => {
    const lends = lent?.found.get(key);
    const [dir, cell]: [string | undefined, Cell | undefined] = byKey.has(key) ? [out, done(key) ? index.cells[key] : undefined] : [lends?.dir, lends?.cell];
    const path = dir !== undefined && cell?.status === 'drawn' && cell.file !== undefined ? join(dir, cell.file) : undefined;
    const bytes = path !== undefined && existsSync(path) ? readFileSync(path) : undefined;
    const pinned = byKey.has(key) || !stand.pinEach || index.lent?.[key] === cell?.sha256;
    return bytes && sha256(bytes) === cell?.sha256 && pinned && same(pngSize(bytes), (byKey.get(key) ?? others.get(key) ?? BY_KEY.get(key))?.canvas) ? bytes : undefined;
  };
  // The prices: seeded until the card has drawn a group, then measured, from this run's cells and a resumed one's.
  const warm = new Map<Group, number>(), firsts = new Map<Group, number>();
  const learn = (cell: Cell) => {
    if (cell.status !== 'drawn' || cell.totalMs === undefined || cell.cold) return;
    const ms = cell.totalMs + (cell.uploadMs ?? 0), into = cell.firstOfGroup ? firsts : warm;
    into.set(cell.group, Math.max(into.get(cell.group) ?? 0, ms));
  };
  Object.values(index.cells).forEach(learn);
  const price = (group: Group) => priceOf(warm.get(group) ?? firsts.get(group) ?? SEED_MS[group]);
  const plan = options.keys ? stand.plan.filter(one => options.keys!.includes(one.key)) : stand.plan;
  const left = plan.filter(one => !done(one.key));
  options.log({ event: 'stand_plan', cells: plan.length, left: left.length, pricedMinutes: minutes(needOf(left, price)) });
  const uploaded = new Map<string, string>();
  let sentJobs = 0;
  const warmth: Warmth = options.warm ?? { reached: false, groups: new Set() };
  const extraMs = (group: Group) => (!warmth.reached ? COLD_MS : warmth.groups.has(group) ? 0 : SHAPE_MS);
  const own = (one: Planned, retried: boolean) => ({ key: one.key, id: one.id, arm: one.arm, kind: one.kind, seed: one.seed, group: one.group,
    refs: one.refs.length, ...(retried ? { retried } : {}), ...(session === undefined ? {} : { session }) });
  const attempt = async (one: Planned, pictures: Buffer[], begin: Buffer | undefined, fits: () => boolean,
    retried: boolean): Promise<'drawn' | 'failed' | 'socket' | 'until' | 'stopped'> => {
    const path = join(out, one.file), text = setup.texts.cells.get(one.key)!;
    let sent = false;
    try {
      let uploadMs = 0;
      const send = async (bytes: Buffer) => {
        let named = uploaded.get(sha256(bytes));
        if (named === undefined) {
          const began = performance.now();
          named = await uploadReference(comfy, bytes);
          uploaded.set(sha256(bytes), named);
          uploadMs += performance.now() - began;
        }
        return named;
      };
      const names: string[] = [];
      for (const bytes of pictures) names.push(await send(bytes));
      const startName = begin === undefined ? undefined : await send(begin);
      const graph = buildJob(setup, one, text, names, startName);
      if (!cellRight(graph, one, text, names, setup, startName)) throw workflowError();
      const before = await logLines(comfy);
      const cold = !warmth.reached, firstOfGroup = !warmth.groups.has(one.group);
      sent = true;
      const drawn = await drawOne(comfy, graph, { pollMs: options.pollMs, waitMs: options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true, admit: fits });
      warmth.reached = true;
      warmth.groups.add(one.group);
      sentJobs++;
      // The picture is down, and it is kept whatever comes next: saved and recorded before anything more is asked.
      await settled();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const size = pngSize(drawn.bytes), phases = drawn.timing?.phases;
      const ran = phases ? Object.values(phases).reduce<number>((sum, ms) => sum + (ms ?? 0), 0) : undefined;
      const cell: Cell = { ...own(one, retried), status: 'drawn', file: relative(out, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length, ...size,
        ...(pictures.length ? { references: pictures.map(bytes => sha256(bytes)) } : {}), ...(begin ? { start: sha256(begin) } : {}),
        ...(cold ? { cold } : {}), ...(firstOfGroup ? { firstOfGroup } : {}),
        totalMs: drawn.totalMs, viewMs: drawn.viewMs, ...(ran === undefined ? {} : { queueMs: Math.max(0, drawn.totalMs - drawn.viewMs - ran), sampleMs: phases?.sampleMs }),
        ...drawn.timing, ...(uploadMs ? { uploadMs: Math.round(uploadMs) } : {}), vramSamples: drawn.memory.samples, promptChars: text.prompt.length };
      index.cells[one.key] = cell;
      learn(cell);
      save();
      options.log({ event: 'cell_drawn', key: one.key, totalMs: drawn.totalMs, sampleMs: phases?.sampleMs, width: size.width, height: size.height,
        ...(cold ? { cold } : {}), ...(firstOfGroup ? { firstOfGroup } : {}) });
      if (comfy.end?.aborted) return 'until';
      const after = await logLines(comfy), loads = partialLoadsSince(before, after);
      const fell = before && after ? after.slice(before.length ? after.lastIndexOf(before.at(-1)!) + 1 : 0).filter(line => FALLBACK.test(line)).length : undefined;
      if (loads !== undefined) cell.partialModelLoadEvents = loads;
      if (fell !== undefined) cell.fallback = fell;
      save();
      if (fell) {
        index.error = 'attention_fallback';
        options.log({ event: 'attention_fallback', key: one.key, lines: fell });
        return 'stopped';
      }
      return 'drawn';
    } catch (error) {
      // A request that failed on the network before the job went, such as an upload to a card that is gone, is the
      // card's failure and not the cell's: it stops the run as an unreachable server does, where it would fail every
      // cell after it.
      const lost = !sent && ((error instanceof TypeError && error.message === 'fetch failed') || (error as { name?: unknown }).name === 'TimeoutError');
      const raw = (error as { code?: unknown }).code ?? (lost ? 'comfy_unreachable' : undefined);
      // A socket that did not open, and a job its time no longer covered, never reached the card.
      if (sent && raw !== 'comfy_socket_unavailable' && raw !== 'not_admitted') {
        warmth.reached = true;
        warmth.groups.add(one.group);
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
  for (const [position, one] of plan.entries()) {
    if (done(one.key)) continue;
    const pictures = one.refs.map(ref => pictureOf(ref.from)), begin = one.start === undefined ? undefined : pictureOf(one.start);
    if (pictures.some(bytes => bytes === undefined) || (one.start !== undefined && begin === undefined)) {
      index.cells[one.key] = { ...own(one, false), status: 'out', code: 'reference_missing' };
      save();
      options.log({ event: 'cell_out', key: one.key, code: 'reference_missing' });
      continue;
    }
    if (one.tier === 'cfg1') {
      const after = plan.slice(position + 1).filter(other => other.tier === 'core' && !done(other.key));
      const need = needOf([one, ...after], price, warmth.reached, warmth.groups);
      if (Date.now() + need > options.until) {
        index.cells[one.key] = { ...own(one, false), status: 'out', code: 'cut' };
        save();
        options.log({ event: 'cell_cut', key: one.key, needSeconds: Math.ceil(need / 1000), leftSeconds: Math.max(0, Math.floor((options.until - Date.now()) / 1000)) });
        continue;
      }
    }
    const fits = () => !comfy.end?.aborted && Date.now() + price(one.group) + extraMs(one.group) <= options.until;
    if (!fits()) {
      options.log({ event: 'cell_not_begun', key: one.key, needSeconds: Math.ceil((price(one.group) + extraMs(one.group)) / 1000),
        leftSeconds: Math.max(0, Math.floor((options.until - Date.now()) / 1000)) });
      ended = 'until';
      break;
    }
    let result = await attempt(one, pictures as Buffer[], begin, fits, false);
    if (result === 'socket') {
      options.log({ event: 'socket_retry', key: one.key });
      await delay(RETRY_PAUSE_MS, undefined, { signal: comfy.end }).catch(() => undefined);
      if (!fits()) { ended = 'until'; break; }
      result = await attempt(one, pictures as Buffer[], begin, fits, true);
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
  options.log({ event: 'stand_done', ended, sent: sentJobs, ...countsOf(index), left: plan.filter(one => !done(one.key)).length,
    ...(index.error ? { error: index.error } : {}) });
  return index;
}

// ---- The page ----

export const SCENE_WORDS: Record<Scene, string> = { 'K-solo': 'двор, одна', 'K-pair': 'двор, двое', P: 'окно, профиль', 'K-trio': 'двор, трое' };
const HOW_WORDS: Record<How, string> = { s352: '352x640', own: 'свой размер', crop: 'верх 720x400', r1024: 'лист, resolution 1024' };
export type Section = { title: string; note: string; columns: string[]; rows: { label: string; keys: (string | undefined)[] }[] };
const known = (key: string) => (BY_KEY.has(key) ? key : undefined);
const sceneRows = (scenes: Scene[], ids: string[]) => scenes.flatMap(scene => SEEDS.map(seed => ({ label: `${SCENE_WORDS[scene]}, сид ${seed}`,
  keys: ids.map(id => known(frameKey(id, scene, seed))) })));
const SECTIONS: Section[] = [
  { title: 'Фронты и RF', note: 'Фронты H в стиле портрета бота и в четырёх стилях читателя, фронты L для пары, RF по рецепту листа (CFG 2 с негативом). '
    + 'Картинкой кадров служит фронт сида 7.', columns: ['сид 7', 'сид 11'], rows: [...FRONT_IDS, 'RF'].map(id => ({ label: id, keys: SEEDS.map(seed => frontKey(id, seed)) })) },
  { title: 'Виды для FV', note: 'Правка фронта сида 7, повёрнутого как в сцене: H на три четверти вправо (двор), H в профиль влево (окно), L на три четверти влево (пара).',
    columns: VIEWS.map(view => view.id), rows: [{ label: 'сид 7', keys: VIEWS.map(view => viewKey(view.id)) }] },
  { title: 'Рука A: формулировка, фронт с видом, лицо', note: 'C-now: кадр бота сегодня, фронт 352x640. R: тот же фронт и формулировка ROLE. FV: фронт и ближний '
    + 'вид, оба 352x640, с ROLE. W: без картинки, внешность словами. FC: верх фронта VN как лицо, фигура словами. Решают фигура и пропорции.',
    columns: ['C-now', 'R', 'FV', 'W', 'FC'], rows: sceneRows(ALL, ['C-now', 'R', 'FV', 'W', 'FC']) },
  { title: 'Рука C: общий стиль', note: 'W в FILM, SEMI и PENCIL; C-VN: фронт VN с формулировкой сегодня; R в каждом стиле: фронт в том же стиле с ROLE.',
    columns: ['W-FILM', 'W-SEMI', 'W-PENCIL', 'C-VN', 'R-VN', 'R-FILM', 'R-SEMI', 'R-PENCIL'],
    rows: sceneRows(SOLO, ['W-FILM', 'W-SEMI', 'W-PENCIL', 'C-VN', 'R-VN', 'R-FILM', 'R-SEMI', 'R-PENCIL']) },
  { title: 'Листы', note: 'H и случаи с 1 по 4 из запросов GPT: CFG 2 с общим негативом, 2048x1152. SH-words: цифры заменены словами. SH-cfg1: CFG 1 без негатива.',
    columns: ['SH, сид 7', 'SH, сид 11', 'SH-words, сид 7', 'SH-words, сид 11', 'SH-cfg1, сид 7', 'SH-cfg1, сид 11'],
    rows: SHEET_PEOPLE.map(who => ({ label: who, keys: [`SH-${who}`, `SH-words-${who}`, `SH-cfg1-${who}`].flatMap(id => SEEDS.map(seed => known(sheetKey(id, seed)))) })) },
  { title: 'Кадры с листа и с RF', note: 'SF: лист H сида 7 или 11 картинкой, ROLE для листа, кадры PENCIL. QRF: фронт RF своего размера, ROLE, PENCIL. SF-VN: лист сида 7, кадры VN.',
    columns: ['SF с листа 7', 'SF с листа 11', 'QRF', 'SF-VN'], rows: sceneRows(SOLO, ['SF-sheet7', 'SF-sheet11', 'QRF', 'SF-VN']) },
  { title: 'VIEW', note: 'Правка GPT по каждому листу: один человек на три четверти, 704x1280.', columns: ['сид 7', 'сид 11'],
    rows: SHEET_PEOPLE.map(who => ({ label: who, keys: SEEDS.map(seed => frameKey(`VIEW-${who}`, undefined, seed)) })) },
  { title: 'Рука D', note: 'Фронты своего размера 704x1280 с ROLE: Q; X с фронтом L вместо H; Naming со словами image 1 и image 2; Order с картинками '
    + 'в обратном порядке; Rough с грубыми словами внешности; L-now без картинок и без внешностей.', columns: ['Q', 'X', 'Naming', 'Order', 'Rough', 'L-now'],
    rows: sceneRows(KS, ['Q', 'X', 'Naming', 'Order', 'Rough', 'L-now']) },
];
// What a run draws, and its page: PLANNED's here, the second stand's in local/image-refs-stand-2.ts, the third's and
// the fourth's in local/image-refs-backlog.ts. `date`: the night the page names, 2026-09-27 unless said. `others`: the
// cells of the other stands whose pictures it takes, beside the first stand's. `pinEach`: those pictures pinned one by
// one as each is first seen drawn (`StandIndex.lent`), so that one another stand draws later comes in on a resume,
// where the second stand pins them all at once with its run's pins. `cards`: a run that may go on on another card,
// held to the same ComfyUI, torch and Triton, with each of its runs a session.
export type Stand = { plan: Planned[]; title: string; intro: string; sections: Section[]; date?: string; others?: Planned[]; pinEach?: boolean;
  cards?: boolean };
const FIRST: Stand = { plan: PLANNED, title: 'Стенд референсов', sections: SECTIONS,
  intro: 'Синтетические тексты qwen-refs (next-card-texts.txt и запросы листов GPT), путь бота: cu130, Triton, внимание кухни. Сиды 7 и 11, 25 шагов euler.' };

// index.html beside cells.json: a section an arm, a row a scene and seed of the cells it compares, each picture with its
// references, its time and its prompt folded under it, linked where it lies, never copied. Under the sections the warm
// times of each group, the first cells apart.
export function writePage(out: string, inputs: Inputs | undefined, index: StandIndex | undefined, stand = FIRST) {
  const cells = index?.cells ?? {}, drawing = index !== undefined && !index.completedAt, byKey = new Map(stand.plan.map(one => [one.key, one]));
  const href = (path: string) => escapeHtml(relative(out, path).split(sep).join('/'));
  const figure = (key: string | undefined) => {
    if (!key) return '<td></td>';
    const one = byKey.get(key)!, cell = cells[key], text = inputs?.texts.cells.get(key), shape = `aspect-ratio:${one.canvas.width}/${one.canvas.height}`;
    const path = cell?.status === 'drawn' && cell.file ? join(out, cell.file) : undefined;
    const why = cell?.status === 'out' ? (cell.code === 'cut' ? 'срезано по времени' : 'нет картинки-образца') : cell?.status === 'failed'
      ? `не вышло: ${cell.code}` : 'не нарисовано';
    const picture = path && existsSync(path) ? `<a href="${href(path)}"><img src="${href(path)}" alt="${escapeHtml(key)}" style="${shape}"></a>`
      : `<div class="none" style="${shape}">${escapeHtml(why)}</div>`;
    const refs = one.refs.map(ref => `${ref.from} (${HOW_WORDS[ref.how]})`).join(', ');
    const begun = one.start === undefined ? '' : `<br>из ${escapeHtml(one.start)}, denoise ${String(one.denoise).replace('.', ',')}`;
    const time = cell?.totalMs === undefined ? '' : `, ${seconds(cell.totalMs)} с${cell.cold ? ', первое задание' : cell.firstOfGroup ? ', первое в группе' : ''}`;
    const words = text ? `<details><summary>промпт</summary><pre>${escapeHtml(text.prompt)}</pre>${text.negative ? `<p>негатив, CFG ${one.cfg}:</p><pre>${escapeHtml(text.negative)}</pre>` : ''}</details>` : '';
    return `<td><figure>${picture}<figcaption>${escapeHtml(key)}${refs ? `<br>по ${escapeHtml(refs)}` : ''}${begun}${escapeHtml(time)}</figcaption>${words}</figure></td>`;
  };
  const sections = stand.sections.map(section => `<section><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.note)}</p>
<table><tr><th></th>${section.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr>
${section.rows.map(row => `<tr><th>${escapeHtml(row.label)}</th>${row.keys.map(figure).join('')}</tr>`).join('\n')}</table></section>`);
  const drawnCells = Object.values(cells).filter(one => one.status === 'drawn' && one.totalMs !== undefined);
  const times = GROUPS.filter(group => stand.plan.some(one => one.group === group)).map(group => {
    const warm = drawnCells.filter(one => one.group === group && !one.cold && !one.firstOfGroup);
    return `<tr><td>${group}</td><td>${warm.length}</td><td>${seconds(median(warm.map(one => one.totalMs!)))}</td><td>${seconds(median(warm.flatMap(one => (one.sampleMs === undefined ? [] : [one.sampleMs]))))}</td></tr>`;
  }).join('');
  const firsts = drawnCells.filter(one => one.cold || one.firstOfGroup).map(one => `${one.key} ${seconds(one.totalMs)} с`).join('; ');
  const counts = index ? countsOf(index) : { drawn: 0, failed: {}, out: {} };
  const tally = (by: Record<string, number>) => Object.entries(by).map(([code, n]) => `${code} ${n}`).join(', ');
  const state = !index ? 'карта ещё не рисовала' : drawing ? 'рисуется' : index.error ? `остановлено: ${index.error}` : index.stopped ? 'остановлено концом времени' : 'закончено';
  const cards = [...new Set((index?.sessions ?? []).map(one => one.server.card ?? '?'))];
  const server = index ? `Сервер: ComfyUI ${index.server.comfyui ?? '?'}, torch ${index.server.pytorch ?? '?'}, Triton ${index.server.triton === 'enabled' ? 'включён' : 'выключен'}, внимание кухни.`
    + (index.sessions?.length ? ` Запусков ${index.sessions.length}, карты: ${cards.join('; ')}.` : '') : '';
  writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(stand.title)}, ${escapeHtml(stand.date ?? '2026-09-27')}</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:1em}table{border-collapse:collapse}td,th{vertical-align:top;padding:4px}
img,.none{height:300px;max-width:none;display:block;background:#8883}.none{display:flex;align-items:center;justify-content:center;color:#888}
figure{margin:0}figcaption{font-size:12px;color:#666;max-width:360px}pre{white-space:pre-wrap;max-width:520px;font-size:12px}</style></head><body>
<h1>${escapeHtml(stand.title)}</h1>
<p>${escapeHtml(stand.intro)}
Промпт свёрнут под каждой картинкой. Оценок здесь нет: их дают слепые судьи после карты.</p>
<p>Состояние: ${escapeHtml(state)}. Нарисовано ${counts.drawn} из ${stand.plan.length}${tally(counts.failed) ? `, не вышло: ${escapeHtml(tally(counts.failed))}` : ''}${tally(counts.out) ? `, не начато: ${escapeHtml(tally(counts.out))}` : ''}. ${escapeHtml(server)}</p>
${sections.join('\n')}
<section><h2>Время</h2><table><tr><th>группа</th><th>тёплых</th><th>всего, с</th><th>сэмплер, с</th></tr>${times}</table>
<p>Медианы по тёплым картинкам. Первые задания запуска и групп: ${escapeHtml(firsts || 'нет')}.</p></section>
</body></html>
`, { mode: 0o600 });
}

// ---- The dry run ----

// The real texts' tokens: each prompt and negative as the encoder takes it (local/tokenizer.ts), with its references,
// and the tokens of each canvas and of each reference at the size it reaches the encoder. `others`: the cells of the
// other stands whose pictures the plan takes, beside the first stand's.
export function tokenReport(texts: Texts, tokenizers: string, plan = PLANNED, others: Planned[] = []) {
  const qwen = loadTokenizers(tokenizers).qwen();
  if (!qwen) throw new Refusal(`No Qwen tokenizer in ${tokenizers}: pass --tokenizers with the directory that holds qwen-2.5.json.gz`);
  const known = new Map([...BY_KEY, ...others.map(one => [one.key, one] as const), ...plan.map(one => [one.key, one] as const)]);
  const groups = GROUPS.filter(group => plan.some(one => one.group === group)).map(group => {
    const cells = plan.filter(one => one.group === group);
    const counted = cells.map(one => qwenPromptTokens(qwen, texts.cells.get(one.key)!.prompt, 'qwen_image', { images: one.refs.length }));
    const refs = cells[0]?.refs.map(ref => tokensOf(atEncoder(ref.how, known.get(ref.from)!.canvas))) ?? [];
    return { group, cells: cells.length, promptTokens: [Math.min(...counted.map(one => one.prompt)), Math.max(...counted.map(one => one.prompt))],
      conditioningMax: Math.max(...counted.map(one => one.conditioning)), canvasTokens: cells[0] ? tokensOf(cells[0].canvas) : 0, referenceTokens: refs };
  });
  const kinds = [...new Set(plan.map(one => one.negative))].filter(kind => kind !== 'none');
  const negatives: Partial<Record<Negative, number>> = Object.fromEntries(kinds.map(kind => [kind,
    qwenPromptTokens(qwen, texts.cells.get(plan.find(one => one.negative === kind)!.key)!.negative, 'qwen_image').prompt]));
  return { groups, negatives };
}

// The server's command line with the Triton backend on, and ModelAttentionBackend offering the kitchen's attention or
// not, as the levers' dry run serves them.
export const TRITON_ARGV = ['main.py', '--listen', '127.0.0.1', '--enable-triton-backend'];
export const attentionInfo = (offered: boolean) => ({ ModelAttentionBackend: { input: { required: { model: ['MODEL', {}],
  attention: ['COMBO', { options: ['pytorch attention', ...(offered ? [KITCHEN_ATTENTION] : [])] }] } } } });

// The whole stand without a card, in `dir`. First the real texts at `textsFile`: their pin, their tokens, and every
// graph built from them and read back, with the face crop, the sheets' canvas, CFG and negative, `resolution` 1024 on
// the sheets' frames and the graphs with two and four references looked at apart. Then a copy of them with a made-up
// word in every prompt and negative, against local/fake-comfy.ts started as the bot's card (cu130, Triton, the
// kitchen's attention): the page before the card; texts other than the pinned, texts whose cells are not the plan's, a
// texts file through a link, missing texts or card record, and a server off the bot's path refused before anything is
// sent or written; a cell that cannot end by --until not begun; an SH-cfg1 sheet cut where the core after it would not
// fit; a minute that draws up to the first sheet, and a resume that draws the rest and then nothing; the 137 jobs, each
// against its independent reading and what the fake made of it, in the plan's order, with what each reference reaches
// the encoder at; a reference that fails leaving its cells out until a resume draws it; a fallback of the attention
// stopping the run; a socket that opens late waited out once; one job at a time; the page's sections, links, words
// without dashes and the files' modes. Afterwards the made-up word is in the texts and on the page alone, and the fake's
// own word, in every picture's metadata, nowhere.
export async function dryRun(dir: string, textsFile: string, tokenizers: string, pinned = TEXTS_SHA256) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), out = join(dry, 'refs-stand');
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
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  const sent: Graph[] = [], fetched = globalThis.fetch;
  let strays = 0, origin = '';
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) { strays++; throw new Error('the dry run asks the fake alone'); }
    if (init?.method === 'POST' && url.endsWith('/prompt') && typeof init.body === 'string') sent.push((JSON.parse(init.body) as { prompt: Graph }).prompt);
    return fetched(input, init);
  };
  try {
    say(`refs-test dry run in ${dry}: the real texts, then a copy of them against local/fake-comfy.ts as the bot's card; no card, no model, no network`);
    writeCardRecord(join(out, 'card.txt'));
    const real = inputsOf(textsFile, pinned), card = cardOf(join(out, 'card.txt'));
    const estimate = estimateOf();
    say(`0 the plan: ${estimate.cells} cells (${estimate.fronts} fronts, ${estimate.views} views, ${estimate.sheets} sheets, ${estimate.frames} frames), `
      + `arms ${JSON.stringify(estimate.arms)}; ${estimate.expectedMinutes} minutes expected and ${estimate.pricedMinutes} at the admission prices, `
      + `${estimate.coreMinutes} for the core; SH-cfg1 ${estimate.tiers.cfg1.minutes} and arm D ${estimate.tiers.D.minutes}; within ${estimate.budgetMinutes}: `
      + `${estimate.fits}, cut ${JSON.stringify(estimate.cut)}; $${estimate.dollars.expected} to $${estimate.dollars.priced} with ${estimate.bootstrapMinutes} minutes of bootstrap`);
    expect(estimate.cells === 137 && estimate.fronts === 14 && estimate.views === 3 && estimate.sheets === 18 && estimate.frames === 102 && new Set(PLANNED.map(one => one.key)).size === 137
      && PLANNED.every(one => one.refs.every(ref => PLANNED.indexOf(BY_KEY.get(ref.from)!) < PLANNED.indexOf(one))), '137 cells, each after the pictures it takes');
    const tokens = tokenReport(real.texts, tokenizers);
    say(`1 the real texts (sha256 pinned): tokens, the prompt as the encoder takes it with its references, the canvas and each reference at the encoder:`);
    for (const one of tokens.groups) say(`   ${JSON.stringify(one)}`);
    say(`   negatives: the sheets' ${tokens.negatives.shared} tokens, RF's ${tokens.negatives.rf}`);
    expect(tokens.groups.every(one => one.promptTokens[0] > 0 && one.promptTokens[1] < 2000), 'every prompt counted, none past 2,000 tokens');
    // Every graph from the real texts, each reference named as an upload would be, read back independently.
    const names = (one: Planned) => one.refs.map((ref, at) => `ref-${sha256(`${ref.from}:${at}`).slice(0, 16)}.png`);
    const built = PLANNED.map(one => ({ one, graph: buildJob({ ...real, card }, one, real.texts.cells.get(one.key)!, names(one)) }));
    const wrongBuilt = built.filter(({ one, graph }) => !cellRight(graph, one, real.texts.cells.get(one.key)!, names(one), { ...real, card })).map(({ one }) => one.key);
    const encoderOf = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21')!.inputs;
    const samplerOf = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs;
    const of = (test: (one: Planned) => boolean) => built.filter(({ one }) => test(one));
    const shared = real.texts.cells.get(sheetKey('SH-H', 7))!.negative;
    const sheetsRight = of(one => one.kind === 'sheet').every(({ one, graph }) => one.graph === 'front' && same(latentSizeOf(graph), SHEET_CANVAS)
      && samplerOf(graph).cfg === one.cfg && encoderOf(graph).negative_prompt === (one.cfg === 2 ? shared : ''));
    const faceRight = of(one => one.id === 'FC').every(({ graph }) => same(slotChains(graph).map(slot => slot.chain.slice(0, 5)), [['ImageCrop', 720, 400, 0, 0]])
      && encoderOf(graph).resolution === 0) && same(atEncoder('crop', FRONT_CANVAS), { width: 704, height: 384 });
    const r1024 = of(one => one.refs.some(ref => ref.how === 'r1024'));
    const sheetRefsRight = r1024.length === 22 && r1024.every(({ graph }) => encoderOf(graph).resolution === SHEET_RESOLUTION && slotChains(graph).length === 1
      && slotChains(graph)[0].chain[0] === 'LoadImage') && same(atEncoder('r1024', SHEET_CANVAS), { width: 1376, height: 768 });
    const fv = of(one => one.id === 'FV');
    const twoRight = fv.length === 6 && fv.every(({ one, graph }) => slotChains(graph).length === (one.scene === 'K-pair' ? 4 : 2)
      && slotChains(graph).every(slot => slot.chain[0] === 'ImageScale' && slot.chain[2] === 352 && slot.chain[3] === 640));
    const rfRight = of(one => one.id === 'RF').every(({ graph }) => samplerOf(graph).cfg === 2 && encoderOf(graph).negative_prompt !== ''
      && encoderOf(graph).negative_prompt !== shared);
    say(`2 every graph built from the real texts: ${built.length - wrongBuilt.length} of ${built.length} read back right${wrongBuilt.length ? `, wrong ${wrongBuilt.join(', ')}` : ''}; `
      + `sheets at 2048x1152 on the front graph, CFG 2 with the shared negative or CFG 1 without: ${sheetsRight}; RF at CFG 2 with its own negative: ${rfRight}; `
      + `the face crop through ImageCrop 720x400 at resolution 0, 704x384 at the encoder: ${faceRight}; the ${r1024.length} sheet references at resolution 1024, `
      + `1376x768 at the encoder: ${sheetRefsRight}; FV with two references a person at 352x640, four in the pair: ${twoRight}`);
    expect(!wrongBuilt.length && sheetsRight && rfRight && faceRight && sheetRefsRight && twoRight, 'every graph of the real texts as its cell asks');

    // The copy the fake draws: a made-up word in every prompt and negative, and its own pin.
    const word = madeUpName(), marker = madeUpName(name => name !== word);
    const writeTexts = (at: string, change: (cell: TextCell) => TextCell = cell => cell) => {
      const cells = PLANNED.map(one => change({ ...real.texts.cells.get(one.key)!, prompt: `${real.texts.cells.get(one.key)!.prompt} ${word}`,
        negative: real.texts.cells.get(one.key)!.negative ? `${real.texts.cells.get(one.key)!.negative} ${word}` : '' }));
      const bytes = JSON.stringify({ note: 'The real texts with a made-up word, for the dry run.', cells }, null, 2);
      writeFileSync(join(at, TEXTS_FILE), bytes, { mode: 0o600 });
      return sha256(bytes);
    };
    const marked = writeTexts(out);
    const started = await startFakeComfy({ jobMs: 20, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: kitchenLines(true, 'cu130'),
      pytorch: '2.11.0+cu130', objectInfo: attentionInfo(true) });
    fake = started;
    origin = started.url;
    const events: object[] = [];
    const heard = (event: string) => events.filter(one => (one as { event?: string }).event === event);
    const draw = (extra: Partial<Options> = {}) => drawStand({ out, comfy: origin, until: Date.now() + 3600000, pinned: marked, pollMs: 10, waitMs: 60000,
      timeoutMs: 10000, log: event => events.push(event), ...extra });

    const setupInputs = inputsOf(join(out, TEXTS_FILE), marked);
    writePage(out, setupInputs, undefined);
    const before = readFileSync(join(out, 'index.html'), 'utf8');
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length;
    const pageKeys = SECTIONS.flatMap(section => section.rows.flatMap(row => row.keys.filter((key): key is string => key !== undefined)));
    say(`3 the page before the card: ${figures(before)} figures in ${(before.match(/<section>/g) ?? []).length} sections, ${(before.match(/<details>/g) ?? []).length} prompts folded`);
    expect(figures(before) === 137 && same([...pageKeys].sort(), PLANNED.map(one => one.key).sort()) && (before.match(/<details>/g) ?? []).length === 137
      && !existsSync(join(out, INDEX_FILE)), 'the page before the card shows every cell once, with its prompt');

    say('4 refusals before anything is sent or written:');
    await refused('texts other than the pinned', () => draw({ pinned: sha256('another texts.json') }));
    const otherRef = writeTexts(out, cell => (cell.key === frameKey('FV', 'K-pair', 11) ? { ...cell, refs: cell.refs.slice(0, 2) } : cell));
    await refused('an FV frame without its second person', () => draw({ pinned: otherRef }));
    const flat = writeTexts(out, cell => (cell.key === sheetKey('SH-H', 7) ? { ...cell, cfg: 1 } : cell));
    await refused('a sheet at another CFG', () => draw({ pinned: flat }));
    writeTexts(out);
    const elsewhere = join(dry, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
    writeTexts(elsewhere);
    unlinkSync(join(out, TEXTS_FILE));
    symlinkSync(join(elsewhere, TEXTS_FILE), join(out, TEXTS_FILE));
    await refused('texts through a link', () => draw());
    unlinkSync(join(out, TEXTS_FILE));
    await refused('missing texts', () => draw());
    writeTexts(out);
    const cardRecord = readFileSync(join(out, 'card.txt'));
    unlinkSync(join(out, 'card.txt'));
    await refused('a missing card record', () => draw());
    writeFileSync(join(out, 'card.txt'), cardRecord, { mode: 0o600 });
    started.options.argv = ['main.py', '--listen', '127.0.0.1'];
    await refused('a server without Triton', () => draw());
    started.options.argv = TRITON_ARGV;
    started.options.pytorch = '2.11.0+cu128';
    await refused('a server on cu128', () => draw());
    started.options.pytorch = '2.11.0+cu130';
    started.options.objectInfo = attentionInfo(false);
    await refused('a server whose node does not offer the kitchen\'s attention', () => draw());
    started.options.objectInfo = attentionInfo(true);
    expect(started.jobs.length === 0 && started.uploads.length === 0 && !existsSync(join(out, INDEX_FILE)), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`5 five seconds left: stopped ${short.stopped}, ${started.jobs.length} jobs sent`);
    expect(short.stopped === 'until' && started.jobs.length === 0 && sent.length === 0, 'a cell that cannot end by --until is not begun');

    // An SH-cfg1 sheet the time left would take from the frames after it: cut, and the frame drawn. H's sheet is drawn
    // first, in a run of its own, since a fake sheet takes milliseconds and would leave its whole price behind it.
    const outOf = (name: string) => {
      const other = join(dry, name);
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(join(other, 'card.txt'), cardRecord, { mode: 0o600 });
      writeTexts(other);
      return other;
    };
    const cutKeys = [sheetKey('SH-H', 7), sheetKey('SH-cfg1-H', 7), frameKey('SF-sheet7', 'K-solo', 7)], beforeCut = started.jobs.length;
    const cutOut = outOf('cut');
    await draw({ out: cutOut, keys: cutKeys.slice(0, 1) });
    const cutRun = await draw({ out: cutOut, keys: cutKeys, until: Date.now() + COLD_MS + seeded('sheetref') + 14000 });
    const cutEvent = heard('cell_cut').at(-1) as { key?: string } | undefined;
    say(`6 an SH-cfg1 sheet that would leave no time for the frame after it: ${started.jobs.length - beforeCut} jobs, cut ${cutEvent?.key}, `
      + `drawn ${Object.values(cutRun.cells).filter(one => one.status === 'drawn').map(one => one.key).join(', ')}`);
    expect(started.jobs.length - beforeCut === 2 && cutRun.cells[cutKeys[1]]?.code === 'cut' && cutRun.cells[cutKeys[0]]?.status === 'drawn'
      && cutRun.cells[cutKeys[2]]?.status === 'drawn' && cutEvent?.key === cutKeys[1], 'SH-cfg1 cut where the core after it would not fit');

    const firstMain = sent.length, firstJob = started.jobs.length;
    const minute = await draw({ until: Date.now() + 60000 }), afterWindow = started.jobs.length - firstJob;
    const notBegun = heard('cell_not_begun').at(-1) as { key?: string; needSeconds?: number } | undefined;
    const firstSheet = PLANNED.findIndex(one => one.kind === 'sheet');
    say(`7 a minute left: ${afterWindow} jobs, ${countsOf(minute).drawn} drawn, stopped ${minute.stopped}; not begun ${notBegun?.key}, needing ${notBegun?.needSeconds} s`);
    expect(afterWindow === firstSheet && countsOf(minute).drawn === firstSheet && minute.stopped === 'until' && notBegun?.key === PLANNED[firstSheet].key,
      'the fronts, views, arm A and arm C drawn, and the first sheet not begun');
    const resumed = await draw(), afterResume = started.jobs.length - firstJob;
    const again = await draw();
    say(`8 a resume: ${afterResume - afterWindow} jobs, ${countsOf(resumed).drawn} drawn; again: ${started.jobs.length - firstJob - afterResume} more`);
    expect(afterResume === 137 && countsOf(again).drawn === 137 && !again.stopped && !again.error, 'the rest, then none again');

    // Each job against its cell, in the order drawn, and what the fake made of it.
    const setup = setupOf(out, marked), wrong: string[] = [];
    const uploadName = (key: string) => `ref-${sha256(stripPngMetadata(readFileSync(join(out, BY_KEY.get(key)!.file)))).slice(0, 16)}.png`;
    // Each reference as the card gets it, by arm: the picture it is made of, what the graph hands the encoder (the scale
    // node's size, the crop's, or the picture's own), the size the encoder draws it at (lanczos, uncropped:
    // comfy_extras/nodes_qwen.py:155-165), and how far that shape is from the shape of what it shows. The figure is what
    // is judged, so no reference may be squeezed by more than 5 %.
    const seen = new Map<string, { arm: string; how: How; ids: Set<string>; picture: Size; handed: Size; encoder: Size; change: number }>();
    PLANNED.forEach((one, at) => {
      const graph = sent[firstMain + at], job: FakeJob | undefined = started.jobs[firstJob + at], cell = again.cells[one.key];
      const refNames = one.refs.map(ref => uploadName(ref.from)), text = setup.texts.cells.get(one.key)!;
      const resolution = one.refs.some(ref => ref.how === 'r1024') ? SHEET_RESOLUTION : 0;
      job?.slots.forEach((slot, n) => {
        const ref = one.refs[n], picture = pngSize(readFileSync(join(out, BY_KEY.get(ref.from)!.file)));
        const shown = slot.cropped ? { width: slot.cropped.width, height: slot.cropped.height } : picture, handed = slot.scaled ?? shown;
        const [width, height] = referenceGeometry(handed.width, handed.height, resolution);
        const change = Math.abs(width / height / (shown.width / shown.height) - 1), row = `${one.arm} ${ref.how} ${sizeText(picture)} ${width}x${height}`;
        const entry = seen.get(row) ?? { arm: one.arm, how: ref.how, ids: new Set<string>(), picture, handed, encoder: { width, height }, change };
        seen.set(row, { ...entry, ids: entry.ids.add(one.id) });
      });
      const right = graph !== undefined && same(buildJob(setup, one, text, refNames), graph) && cellRight(graph, one, text, refNames, setup)
        && job?.outcome === 'success' && job.sampler === 'KSampler' && job.start === null && job.noiseMask === null && !job.composites.length
        && same(job.slots, one.refs.map((ref, n) => ({ slot: n + 1, file: refNames[n], scaled: ref.how === 's352' ? SCALED : null,
          cropped: ref.how === 'crop' ? CROP : null })))
        && same(job.model, one.graph === 'front' ? ['ModelAttentionBackend', 'UNETLoader'] : ['ModelAttentionBackend', 'QwenImage21Cache', 'UNETLoader'])
        && same(job.images, [{ node: one.graph === 'front' ? '8' : '9', ...one.canvas }]) && cell?.status === 'drawn' && cell.width === one.canvas.width
        && cell.height === one.canvas.height && cell.file === one.file && existsSync(join(out, one.file)) && cell.seed === one.seed && cell.fallback === 0
        && same(cell.references ?? [], one.refs.map(ref => sha256(readFileSync(join(out, BY_KEY.get(ref.from)!.file)))));
      if (!right) wrong.push(one.key);
    });
    say(`9 jobs against their reading and the fake's: ${PLANNED.length - wrong.length} of ${PLANNED.length} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    expect(!wrong.length && sent.length - firstMain === 137, 'every job sends its own graph in the plan\'s order');
    const handedBy: Record<How, string> = { s352: 'ImageScale hands on', own: 'handed whole at', crop: 'ImageCrop hands on', r1024: 'handed whole at' };
    say('   each reference by arm: the picture, what the graph hands the encoder, the size the encoder draws it at, the change of shape');
    for (const one of seen.values()) {
      say(`   ${one.arm} ${[...one.ids].join(', ')}: the picture ${sizeText(one.picture)}, ${handedBy[one.how]} ${sizeText(one.handed)}, `
        + `at resolution ${one.how === 'r1024' ? SHEET_RESOLUTION : 0} the encoder draws it at ${sizeText(one.encoder)}, shape changed ${(one.change * 100).toFixed(1)} %`);
    }
    const sizes: Record<string, string[]> = {};
    for (const one of seen.values()) sizes[one.how] = [...new Set([...(sizes[one.how] ?? []), sizeText(one.encoder)])];
    expect(same(Object.keys(sizes).sort(), ['crop', 'own', 'r1024', 's352']) && same(sizes.own, ['704x1280']) && same(sizes.s352, ['352x640'])
      && same(sizes.crop, ['704x384']) && same(sizes.r1024, ['1376x768']) && [...seen.values()].every(one => one.change <= 0.05),
      'each reference reaches the encoder at its size, none squeezed by more than 5 %');
    const faceJobs = PLANNED.flatMap((one, at) => (one.id === 'FC' ? [started.jobs[firstJob + at]] : []));
    const sheetJobs = PLANNED.flatMap((one, at) => (one.kind === 'sheet' ? [{ one, graph: sent[firstMain + at], job: started.jobs[firstJob + at] }] : []));
    say(`   the face crop: ${faceJobs.length} jobs, the crop ${JSON.stringify(faceJobs[0]?.slots[0]?.cropped)} of ${faceJobs[0]?.slots[0]?.file === uploadName(frontKey('H-VN')) ? 'H\'s VN front at seed 7' : 'another picture'}; `
      + `the sheets: ${sheetJobs.filter(({ job }) => job.width === 2048 && job.height === 1152).length} of ${sheetJobs.length} drawn at 2048x1152, `
      + `${sheetJobs.filter(({ graph }) => samplerOf(graph).cfg === 2 && encoderOf(graph).negative_prompt !== '').length} at CFG 2 with a negative`);
    expect(faceJobs.length === 4 && faceJobs.every(job => same(job.slots[0].cropped, CROP) && job.slots[0].file === uploadName(frontKey('H-VN')))
      && sheetJobs.length === 18 && sheetJobs.every(({ one, graph, job }) => job.width === 2048 && job.height === 1152 && samplerOf(graph).cfg === one.cfg
        && (encoderOf(graph).negative_prompt !== '') === (one.cfg === 2)), 'the face crop and the sheets as the card will get them');

    const cells = Object.values(again.cells);
    const cold = cells.filter(one => one.cold).map(one => one.key), firsts = cells.filter(one => one.firstOfGroup).map(one => one.key);
    say(`10 the bot's path: server pins ${JSON.stringify(again.server)}, kitchen ${JSON.stringify(again.kitchen)}; cold ${cold.join(', ')}; `
      + `${firsts.length} first cells of a group`);
    expect(again.server.triton === 'enabled' && again.server.pytorch === '2.11.0+cu130' && again.kitchen?.tritonImported === true
      && again.kitchen.backends.triton?.available === true && cold.length === 2 && cold[0] === PLANNED[0].key && firsts.length === new Set(PLANNED.map(one => one.group)).size + 1,
      'the pins say cu130 and Triton, and each run\'s and group\'s first is kept apart');

    // A reference the card fails: its cells out, and a resume draws it and then them.
    const failKeys = [frontKey('H-VN'), frameKey('FC', 'K-solo', 7), frameKey('C-VN', 'K-solo', 7)];
    const failedOut = outOf('failed'), beforeFailed = started.jobs.length;
    started.options.failJobs = [started.jobs.length + 1];
    const failed = await draw({ out: failedOut, keys: failKeys });
    started.options.failJobs = [];
    const afterFailed = started.jobs.length, redrawn = await draw({ out: failedOut, keys: failKeys });
    say(`11 a reference that failed: ${afterFailed - beforeFailed} job, out ${JSON.stringify(countsOf(failed).out)}; a resume: ${started.jobs.length - afterFailed} jobs, `
      + `drawn ${countsOf(redrawn).drawn}`);
    expect(afterFailed - beforeFailed === 1 && failed.cells[failKeys[0]]?.status === 'failed' && countsOf(failed).out.reference_missing === 2
      && started.jobs.length - afterFailed === 3 && countsOf(redrawn).drawn === 3, 'a failed reference leaves its cells to a resume');

    // The kitchen's attention falling back to PyTorch's on the card: the run stops after that job.
    const fellKeys = [frontKey('H-PORTRAIT', 7), frontKey('H-PORTRAIT', 11)], beforeFell = started.jobs.length;
    started.options.attentionFallback = true;
    const fell = await draw({ out: outOf('fallback'), keys: fellKeys });
    started.options.attentionFallback = false;
    say(`12 an attention that falls back: ${started.jobs.length - beforeFell} job, error ${fell.error}, the cell's count ${fell.cells[fellKeys[0]]?.fallback}`);
    expect(started.jobs.length - beforeFell === 1 && fell.error === 'attention_fallback' && fell.cells[fellKeys[0]]?.fallback === 1 && !fell.cells[fellKeys[1]],
      'a fallback of the attention stops the run');

    // A socket that does not open in time, once: waited out, and the cell drawn.
    const beforeRetry = started.jobs.length;
    events.length = 0;
    started.options.openDelayMs = 2500;
    const retried = await draw({ out: outOf('retry'), keys: fellKeys, log: event => {
      events.push(event);
      if ((event as { event?: string }).event === 'socket_retry') started.options.openDelayMs = 0;
    } });
    say(`13 a socket that opens late once: ${heard('socket_retry').length} retry, ${started.jobs.length - beforeRetry} jobs, drawn ${countsOf(retried).drawn}`);
    expect(heard('socket_retry').length === 1 && started.jobs.length - beforeRetry === 2 && countsOf(retried).drawn === 2 && retried.cells[fellKeys[0]]?.retried === true,
      'a late socket is waited out once');

    say(`14 the fake held at most ${started.mostHeld} job at once; ${strays} calls to anything but the fake`);
    expect(started.mostHeld === 1 && strays === 0, 'one job at a time, and the fake alone');

    const page = readFileSync(join(out, 'index.html'), 'utf8'), links = [...new Set([...page.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
    const prose = page.replace(/<pre>[\s\S]*?<\/pre>/g, ''), dashes = /[–—]/;
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = mode(out) === 0o700 && mode(join(out, INDEX_FILE)) === 0o600 && mode(join(out, 'index.html')) === 0o600
      && ['fronts', 'views', 'sheets', 'frames'].every(sub => mode(join(out, sub)) === 0o700) && PLANNED.every(one => mode(join(out, one.file)) === 0o600);
    say(`15 page: ${figures(page)} figures, ${links.length} links, ${links.filter(link => existsSync(resolve(out, link))).length} where they lead; `
      + `dashes in its own words ${dashes.test(prose)}; directories 700 and files 600: ${modes}`);
    expect(figures(page) === 137 && links.length === 137 && links.every(link => existsSync(resolve(out, link))) && !page.includes('не нарисовано')
      && !dashes.test(prose) && page.includes('Triton включён') && page.includes('Нарисовано 137 из 137') && modes,
      'the page links every picture, in words without dashes');

    // The prompts' word is in the texts and on the page, and nowhere else; the fake's word is nowhere.
    const text = output.text(), words = markerForms(word), marks = markerForms(marker);
    const shown = (name: string) => name === TEXTS_FILE || name === 'index.html';
    const beyond = searchTree(dry, words, path => shown(basename(path)));
    const anywhere = searchTree(dry, marks);
    const printed = [...words, ...marks].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`16 privacy: the prompts' word in ${beyond.hits.length} of ${beyond.files} files beside the texts and the pages, unread ${beyond.unread.length + anywhere.unread.length}; `
      + `the fake's word in ${anywhere.hits.length} of ${anywhere.files}; printed ${printed}`);
    expect(!beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length && !printed,
      'no prompt anywhere but the texts and the pages, and nothing printed');
    say(missed.length ? `the refs stand's dry run did NOT go as expected: ${missed.length} of its checks` : 'the refs stand\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string' }, dir: { type: 'string' }, texts: { type: 'string' }, tokenizers: { type: 'string' }, until: { type: 'string' },
    comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
    rate: { type: 'string', default: String(RATE) }, bootstrap: { type: 'string', default: String(BOOTSTRAP_MINUTES) }, minutes: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'estimate') {
    const rate = Number(values.rate), bootstrap = Number(values.bootstrap), budget = Number(values.minutes);
    if (![rate, bootstrap, budget].every(value => Number.isFinite(value) && value >= 0)) throw new Refusal('Use: estimate [--rate 0.605] [--bootstrap 20] [--minutes 60]');
    print({ event: 'estimate', ...estimateOf(rate, bootstrap, budget) });
    return;
  }
  if (command === 'dry-run') {
    if (!values.texts) throw new Refusal('Use: dry-run --texts <the run\'s texts.json> [--tokenizers <dir>] [--dir <dir>]');
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-refs-test-dry-')), resolve(values.texts),
      resolve(values.tokenizers ?? join(ROOT, 'tokenizers')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (!values.out) throw new Refusal('Use: image-refs-test.ts estimate|dry-run|draw|page; draw and page take --out <the run\'s directory>');
  const out = resolve(values.out);
  if (command === 'page') {
    writePage(out, inputsOf(join(out, TEXTS_FILE), TEXTS_SHA256), readJson<StandIndex>(join(out, INDEX_FILE)));
    print({ event: 'page', file: join(out, 'index.html') });
  } else if (command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --out <dir> --until <epoch seconds, five minutes before the card\'s end> [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawStand({ out, comfy: comfyUrl(values.comfy!), until, pinned: TEXTS_SHA256, waitMs: wait * 1000, timeoutMs: timeout * 1000, log: print });
    if (index.error || index.stopped) process.exitCode = 1;
  } else throw new Refusal('Use: image-refs-test.ts estimate|dry-run|draw|page (docs/action-experiment.md#refs-stand)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
