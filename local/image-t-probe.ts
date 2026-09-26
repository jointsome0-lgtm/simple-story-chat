// The T probe (docs/action-experiment.md#t-probe). T, the action measurement's second pass, gave round one's L picture
// back, its layout and faces, with its edges and colours pushed, and took no face, hair or build from the portraits: its
// judges scored T as L on every item of all 13 clean scenes. Here five variants of T, each one change against it, are
// drawn on one pilot card from round one's own L pictures and portraits of six clean scenes at seed 7, with no text card
// and no new portrait, and one page sets each beside the portraits, L, and round one's T and C, for the owner to pick
// from. Round two's T stays as it is: T_OPENING, `tPrompt` and the action graph are read here and never changed, and
// the variants' prompts and graphs live in this file alone. The commands read illustrations/action-1/clean alone and
// write illustrations/t-probe alone; only `dry-run` takes another --dir:
//   estimate  the cells and their minutes, from round one's own times, before a card is rented
//   draw      on the picture card: the scenes in turn, each begun only if all its variants can end by --until
//   page      index.html, the owner's page, which `draw` also writes after every scene
//   dry-run   all of it against local/fake-comfy.ts, from a made-up round one with a sealed story beside it
// What it prints is ids, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ACTION_SEEDS, ACTION_STORIES, MARKER_STORY } from '../examples/action-set.ts';
import { CLEANUP_RESERVE_MS, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, comfyUrl, drawOne, encoderResolution, logLines,
  partialLoadsSince, pngSize, referenceSlots, samplerSettingsOf, serverPins, settled, stopsTheRun, stripPngMetadata,
  uploadReference } from './image-batch.ts';
import type { Comfy, Graph, Phases, Vram } from './image-batch.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { safeErrorDetails } from './model-error.ts';
import { STYLE } from './illustrate.ts';
import { greyPng, startFakeComfy } from './fake-comfy.ts';
import { Refusal, capture, madeUpName, markerForms, searchBoundary, searchTree } from './action-boundary.ts';
import { isSharp, readJson, storyDir } from './action-text.ts';
import type { ActionArm } from './action-text.ts';
import { T_OPENING, tClause } from './action-prompts.ts';
import type { StoryPlan } from './action-prompts.ts';
import { ACTION_GRAPH, CELL_MS, DRAW_CODES, FRAME_CANVAS, MARGIN, SCALED, WAIT_MS, actionGraph, fileOf, frameKey } from './action-draw.ts';
import type { CellRecord, DrawIndex } from './action-draw.ts';
import { escapeHtml } from './action-judge.ts';
import { safeError } from './image-action.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const SOURCE_DIR = join(ROOT, 'illustrations', 'action-1');
export const PROBE_DIR = join(ROOT, 'illustrations', 't-probe');
const SEED = ACTION_SEEDS[0];
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const print = (value: object) => console.log(JSON.stringify(value));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Round one's clean scenes with four people bound at most, as round two binds, so that T sends five pictures at most,
// below the slow regime seven took it into: from four people to one. The flight's L kept all its contacts and the
// twister's most; the giants, the guard and the tango are the ones whose C took looks with two and three portraits; the
// monkeys have one person bound.
export const PROBE_SCENES = ['flight', 'twister', 'giants', 'guard', 'tango', 'monkeys'];
const MOST_BOUND = 4;

// ---- The variants ----

// Each is one change against today's T, whose graph is action-draw.ts `actionGraph` with image 1, L's picture, as it
// is and every portrait through its scale node to 352x640, and whose prompt is round one's own, T_OPENING, one clause a
// person and the style line. `short` names the change on the page, `change`, `faces` and `risk` explain it there.
export type VariantId = 'words' | 'no-style' | 'half' | 'latent-50' | 'latent-70';
export type Variant = { id: VariantId; short: string; change: string; faces: string; risk: string; denoise?: number };
export const HALF = { width: 640, height: 352 };
export const VARIANTS: Variant[] = [
  { id: 'words', short: 'только слова',
    change: 'Промпт переписан: сначала замена, по фразе на человека — «Replace the face, hair, skin and build of РОЛЬ in image 1 with those '
      + 'of the person in image N», потом оговорка про телосложение и «Keep everything else in image 1 as it is:» с тем же списком; нет '
      + '«Image 1 is the finished picture». Те же признаки, та же строка стиля, граф и картинки как у T.',
    faces: 'Если модель умеет менять лица по ссылке, когда картинка 1 совпадает с холстом, — лица и волосы портретов на месте людей L. Если нет — снова L.',
    risk: 'Низкий: картинка 1 совпадает с холстом, как в T; контакты, позы и кадр остаются от L.' },
  { id: 'no-style', short: 'без строки стиля',
    change: 'Промпт T без строки стиля в конце. Больше ничего.',
    faces: 'Лиц не ждём: это проверка перерезких краёв. Если края, цвет и контраст станут как у L, их давала строка стиля.',
    risk: 'Низкий, как у T.' },
  { id: 'half', short: 'L в 640x352',
    change: 'Картинка 1 (L) идёт через свой ImageScale (area) до 640x352: 880 токенов вместо 3520, как один портрет, и уже не клетка '
      + 'в клетку с холстом, хотя по-прежнему по его центру. Промпт T тот же.',
    faces: 'L больше не лежит на холсте клетка в клетку и весит как один портрет: портреты могут пробиться, как в C, хотя L остаётся ссылкой.',
    risk: 'Высокий: сцену нарисуют заново по содержанию L, а не скопируют; кадр, позы и контакты могут сдвинуться.' },
  { id: 'latent-50', short: 'старт от L, denoise 0,50', denoise: 0.5,
    change: 'L входит не картинкой 1, а стартовым латентом: VAEEncode → KSampler с denoise 0,50 (σ 0,67, от латента L — 0,33). '
      + 'Ссылки — только портреты (картинки 1…k, 352x640), промпт — C первого раунда.',
    faces: 'Лица и волосы перерисуются к портретам внутри раскладки L; цвет и длина волос — частично.',
    risk: 'Низкий или средний: раскладка из латента L; кисти и мелкие контакты могут перерисоваться.' },
  { id: 'latent-70', short: 'старт от L, denoise 0,70', denoise: 0.7,
    change: 'То же при denoise 0,70 (σ 0,83, от латента L — 0,17).',
    faces: 'Больше от портретов: цвет и длина волос, телосложение.',
    risk: 'Средний или высокий: позы и контакты могут поехать; кадр в основном держится.' },
];
const latentStart = (variant: Variant) => variant.denoise !== undefined;

// T's clauses, read back from round one's own prompt as `tPrompt` wrote it: T_OPENING, "ROLE takes them from the
// person in image N" for each bound person, N from 2, joined by "; ", and the style line. A prompt that does not
// rebuild into itself byte for byte gives nothing.
export type Clause = { role: string; image: number };
export function tClauses(prompt: string, bound: number): Clause[] | undefined {
  const head = `${T_OPENING} `, tail = `. ${STYLE}`;
  if (bound < 1 || !prompt.startsWith(head) || !prompt.endsWith(tail)) return undefined;
  let rest = prompt.slice(head.length, prompt.length - tail.length);
  const clauses: Clause[] = [];
  for (let image = 2; image <= bound + 1; image++) {
    const end = tClause('', image), last = image === bound + 1;
    const at = last ? (rest.endsWith(end) ? rest.length - end.length : -1) : rest.indexOf(`${end}; `);
    if (at < 1) return undefined;
    clauses.push({ role: rest.slice(0, at), image });
    rest = rest.slice(at + end.length + (last ? 0 : 2));
  }
  return rest === '' && `${head}${clauses.map(one => tClause(one.role, one.image)).join('; ')}${tail}` === prompt ? clauses : undefined;
}

// `words`: the change first, one sentence a person, then T's own caveat on the build and its keep list, and the style.
const WORDS_KEEP = 'Change a build only as far as every contact stays where it is. Keep everything else in image 1 as it is: '
  + 'the place, the light, the framing, every pose, grip and contact, and all clothes.';
export const wordsPrompt = (clauses: Clause[]) => `${clauses.map(one =>
  `Replace the face, hair, skin and build of ${one.role} in image 1 with those of the person in image ${one.image}.`).join(' ')} ${WORDS_KEEP} ${STYLE}`;

// ---- Round one ----

type Input = { file: string; bytes: Buffer; sha256: string };
// One scene as the probe draws it: its clauses and round one's T and C prompts, L's picture and the fronts, and what
// the page shows beside them. `hash` is what probe.json pins the scene's cells to.
export type Scene = { id: string; bound: number; clauses: Clause[]; t: string; c: string; l: Input; portraits: Input[];
  shown: Partial<Record<'T' | 'C', string>>; hash: string };

// A story the probe may read: a clean scene of the action set. A sharp story and the marker are refused by their id,
// before anything of them is read.
function cleanId(id: string) {
  if (isSharp(id) || id === MARKER_STORY.id || !ACTION_STORIES.some(story => story.id === id)) {
    throw new Refusal(`${id} is not a clean scene of the action set: the probe draws round one's clean scenes alone and reads nothing of a sealed one`);
  }
}

// Round one's record of its pictures, draw.json at the run's level: ids, codes, sizes, times and its pins.
function roundOf(source: string): DrawIndex {
  const round = readJson<DrawIndex>(join(source, 'draw.json'));
  if (!round?.cells || !round.pins) throw new Refusal(`${join(source, 'draw.json')} is missing: the probe draws from round one's own pictures`);
  return round;
}

// One clean scene of round one, read where the harness left it and checked against round one's record: its plan, with
// T over L and one to four fronts and C over the same fronts; L's picture and the fronts byte for byte, on their
// canvases. A link on the way, which could lead into sealed/, is refused.
export function sceneOf(source: string, round: DrawIndex, id: string): Scene {
  cleanId(id);
  source = resolve(source);
  const dir = storyDir(source, id);
  const noLink = (path: string) => {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${relative(source, path)} is a link, which could lead into sealed/: nothing of it is read`);
  };
  for (const path of [join(source, 'clean'), dir, join(dir, 'pictures'), join(dir, 'portraits')]) noLink(path);
  if (!existsSync(dir) || realpathSync(dir).split(sep).includes('sealed')) throw new Refusal(`Round one has no clean scene ${id} in ${source}`);
  const plan = readJson<StoryPlan>(join(dir, 'plan.json'));
  const fronts = (plan?.manifest?.bound ?? []).map(one => one.portrait);
  const t = plan?.arms.T, c = plan?.arms.C;
  const same = (a: string[] | undefined, b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  if (!t || !c || !fronts.length || fronts.length > MOST_BOUND || !same(t.references, ['L', ...fronts]) || !same(c.references, fronts)) {
    throw new Refusal(`Round one's plan of ${id} has no T over L and one to ${MOST_BOUND} fronts with C over the same fronts: the probe draws where round one drew T`);
  }
  const clauses = tClauses(t.prompt, fronts.length);
  if (!clauses) throw new Refusal(`Round one's T prompt of ${id} does not read back as T_OPENING, one clause a person and the style line: one of them changed since round one`);
  // A picture as round one recorded it: drawn, in its place, the very bytes, on its canvas.
  const recorded = (key: string, path: string, canvas: string): Input | undefined => {
    const one = round.cells[key], file = relative(source, path);
    if (!one || one.status !== 'drawn' || one.file !== file) return undefined;
    noLink(path);
    const bytes = existsSync(path) ? readFileSync(path) : undefined;
    const size = bytes ? pngSize(bytes) : undefined;
    return bytes && sha256(bytes) === one.sha256 && `${size?.width}x${size?.height}` === canvas ? { file, bytes, sha256: one.sha256 } : undefined;
  };
  const frame = (arm: ActionArm) => recorded(frameKey(id, SEED, arm), fileOf(source, { kind: 'frame', story: id, id: '', seed: SEED, arm }),
    `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`);
  const l = frame('L');
  const portraits = fronts.map(front => recorded(`front:${front}`, fileOf(source, { kind: 'front', story: id, id: front, seed: SEED }), String(round.pins.portraitCanvas)));
  if (!l || portraits.some(one => !one)) throw new Refusal(`L's picture or a front of ${id} is not the picture round one recorded, where it recorded it: nothing is drawn from it`);
  const shown: Scene['shown'] = {};
  for (const arm of ['T', 'C'] as const) {
    const one = frame(arm);
    if (one) shown[arm] = one.file;
  }
  const inputs = portraits as Input[];
  const hash = sha256(JSON.stringify([id, l.sha256, inputs.map(one => one.sha256), sha256(t.prompt), sha256(c.prompt)]));
  return { id, bound: fronts.length, clauses, t: t.prompt, c: c.prompt, l, portraits: inputs, shown, hash };
}

// What round one's pictures were drawn under, which the probe's must share, or its variants would be compared with a T
// of another setup: the card's revision and weights, the action graph, T's opening, the canvas, the reference size, the
// encoder's resolution and the cache's device.
function setupOf(card: ReturnType<typeof cardOf>, base: Graph): Record<string, string | number> {
  const cache = Object.values(base).find(node => node.class_type === 'QwenImage21Cache');
  return { comfyuiRevision: card.comfyuiRevision, transformer: card.transformer, encoder: card.encoder, vae: card.vae,
    actionGraph: sha256(readFileSync(ACTION_GRAPH)), t: sha256(T_OPENING), canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`,
    referenceSize: `${SCALED.width}x${SCALED.height}`, resolution: encoderResolution(base) ?? -1, cacheDevice: String(cache?.inputs.device ?? 'none') };
}
const variantsPin = () => sha256(JSON.stringify({ variants: VARIANTS.map(one => [one.id, one.denoise ?? null]), half: HALF,
  words: wordsPrompt([{ role: 'ROLE', image: 2 }]), style: STYLE }));
const readBase = () => apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
const recipeOf = (graph: Graph) => {
  const own = samplerSettingsOf(graph);
  return { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler,
    scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler, cfg: own.cfg ?? SAMPLER_DEFAULTS.cfg };
};

// ---- The graphs and the prompts ----

const START_LOADER = '40', START_ENCODE = '41', HALF_SCALE = '42';
// The graph a variant sends, before it is filled: today's T graph for words and no-style; the same with image 1 through
// a scale node of its own to 640x352 for half; and C's graph, every portrait through its scale node from slot 1, for a
// latent start (`startFrom` then gives its sampler L's picture).
export function probeGraph(base: Graph, variant: Variant, bound: number): Graph {
  const { graph } = actionGraph(base, Array.from({ length: bound }, (_, at) => at + (latentStart(variant) ? 1 : 2)));
  if (variant.id === 'half') {
    const slot = referenceSlots(graph)[0];
    graph[HALF_SCALE] = { class_type: 'ImageScale', inputs: { upscale_method: 'area', width: HALF.width, height: HALF.height, crop: 'disabled', image: [slot.loader, 0] } };
    graph[slot.node].inputs[slot.key] = [HALF_SCALE, 0];
  }
  return graph;
}
// A latent start, once the graph is filled: the sampler starts from L's picture through the VAE, 80x44 latents of the
// canvas's own size, at the variant's denoise, and the empty latent leaves the graph. The seed and the steps stay.
export function startFrom(filled: Graph, variant: Variant, start: string): Graph {
  const sampler = Object.values(filled).find(node => node.class_type === 'KSampler');
  const vae = Object.keys(filled).find(id => filled[id].class_type === 'VAELoader');
  const link = sampler?.inputs.latent_image;
  if (!sampler || !vae || !Array.isArray(link) || filled[String(link[0])]?.class_type !== 'EmptyLatentImage') {
    throw Object.assign(new Error('workflow_no_latent_size'), { code: 'workflow_no_latent_size' });
  }
  delete filled[String(link[0])];
  filled[START_LOADER] = { class_type: 'LoadImage', inputs: { image: start } };
  filled[START_ENCODE] = { class_type: 'VAEEncode', inputs: { pixels: [START_LOADER, 0], vae: [vae, 0] } };
  sampler.inputs.latent_image = [START_ENCODE, 0];
  sampler.inputs.denoise = variant.denoise;
  return filled;
}
// The graph as it goes out: each slot the file the variant names, in order, at the size it says (T's image 1 as it is,
// half's at 640x352, every portrait at 352x640); the sampler starting from the empty latent of the canvas at full
// denoise, or for a latent start from L's upload through the VAE at the variant's denoise, with no empty latent left.
export function graphRight(graph: Graph, variant: Variant, slots: string[], start?: string): boolean {
  const found = referenceSlots(graph);
  const size = (scale?: string) => (scale === undefined ? 'own' : `${graph[scale].inputs.width}x${graph[scale].inputs.height}`);
  const wanted = (at: number) => (at > 0 || latentStart(variant) ? `${SCALED.width}x${SCALED.height}` : variant.id === 'half' ? `${HALF.width}x${HALF.height}` : 'own');
  const from = (link: unknown) => (Array.isArray(link) ? graph[String(link[0])] : undefined);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const latent = from(sampler?.inputs.latent_image);
  const begins = !latentStart(variant)
    ? latent?.class_type === 'EmptyLatentImage' && latent.inputs.width === FRAME_CANVAS.width && latent.inputs.height === FRAME_CANVAS.height && sampler?.inputs.denoise === 1
    : latent?.class_type === 'VAEEncode' && from(latent.inputs.pixels)?.class_type === 'LoadImage' && from(latent.inputs.pixels)?.inputs.image === start
      && from(latent.inputs.vae)?.class_type === 'VAELoader' && sampler?.inputs.denoise === variant.denoise
      && !Object.values(graph).some(node => node.class_type === 'EmptyLatentImage');
  return begins && found.length === slots.length && found.every((slot, at) => graph[slot.loader].inputs.image === slots[at] && size(slot.scale) === wanted(at));
}
// The prompt a variant sends: words' own; T's without its style line; T's; or, for a latent start, C's, whose clauses
// bind the portraits from image 1.
export function probePrompt(scene: Scene, variant: Variant): string {
  if (variant.id === 'words') return wordsPrompt(scene.clauses);
  if (variant.id === 'no-style') return scene.t.slice(0, scene.t.length - STYLE.length - 1);
  return latentStart(variant) ? scene.c : scene.t;
}

// ---- The prices ----

// A cell's time from round one's own clean frames on the same kind of card, uploads included: words and no-style as
// its T with as many pictures, half as its C with one picture more than the scene binds (image 1 at 640x352 is one
// portrait's 880 tokens), a latent start as its C with the scene's own count, the VAE's encode of one picture being
// well inside the margin. A count round one never drew takes the fewest above it, and failing that its arm's whole.
// `price` is the slowest, a quarter more and three seconds, as the harness prices (action-draw.ts `pricing`);
// `expected` the median.
export function timesOf(round: DrawIndex) {
  const drawn = Object.values(round.cells).filter(one => one.status === 'drawn' && one.kind === 'frame' && !isSharp(one.story) && one.totalMs !== undefined);
  const time = (one: CellRecord) => one.totalMs! + (one.uploadMs ?? 0);
  const pool = (variant: Variant, bound: number) => {
    const [arm, images]: [ActionArm, number] = variant.id === 'half' ? ['C', bound + 1] : latentStart(variant) ? ['C', bound] : ['T', bound + 1];
    const like = drawn.filter(one => one.arm === arm);
    const above = like.filter(one => one.references >= images);
    const fewest = Math.min(...above.map(one => one.references));
    return (above.length ? above.filter(one => one.references === fewest) : like).map(time);
  };
  return {
    price: (variant: Variant, bound: number) => {
      const times = pool(variant, bound);
      return times.length ? Math.round(Math.max(...times) * MARGIN + CELL_MS) : Infinity;
    },
    expected: (variant: Variant, bound: number) => {
      const times = pool(variant, bound);
      return times.length ? median(times) : Infinity;
    },
  };
}
// The first job of a run loads the weights onto the card: round one's first frame took 31 s against 16 s warm.
const COLD_MS = 30000;

// The plan's cells and their minutes: expected from round one's medians, and at the prices a scene is admitted by.
export function estimateOf(round: DrawIndex, scenes: Scene[], variants: Variant[]) {
  const times = timesOf(round);
  const sum = (read: (variant: Variant, bound: number) => number) => scenes.reduce((total, scene) => total + variants.reduce((all, variant) => all + read(variant, scene.bound), 0), 0);
  return { scenes: scenes.length, variants: variants.length, cells: scenes.length * variants.length,
    expectedMinutes: Math.round((sum(times.expected) + COLD_MS / 2) / 6000) / 10, pricedMinutes: Math.round((sum(times.price) + COLD_MS) / 6000) / 10 };
}

// ---- The drawing ----

export const cellKey = (story: string, variant: VariantId) => `${story}:${variant}`;
export type ProbeCell = { key: string; story: string; variant: VariantId; status: 'drawn' | 'failed'; code?: string; httpStatus?: number; oom?: boolean;
  references: number; file?: string; sha256?: string; bytes?: number; width?: number; height?: number; cold?: boolean;
  totalMs?: number; viewMs?: number; uploadMs?: number; phases?: Phases; loaderCacheMiss?: boolean; vram?: Vram[]; vramSamples?: number;
  partialModelLoadEvents?: number; promptChars?: number; graphRight?: boolean };
// probe.json: ids, codes, sizes, counts and times, no prompt. `scenes` pins each scene's inputs; `sameServer` says
// whether the server said what it said to round one (ComfyUI, PyTorch, the card), which the comparison does not need.
export type ProbeIndex = { pins: Record<string, string | number>; startedAt: string; completedAt?: string; sameServer?: boolean;
  scenes: Record<string, string>; cells: Record<string, ProbeCell>; stopped?: 'until'; error?: string };
export type ProbeOptions = { source: string; out: string; comfy: string; until: number; scenes?: string[]; variants?: VariantId[];
  timeoutMs?: number; waitMs?: number; pollMs?: number; log?: (event: object) => void };

// Every scene in turn, and in it every variant not yet recorded, in the list's order: a scene begins only if all it has
// left can end by `--until`, and each cell only if it still can, so that a stop leaves whole scenes. A cell with an
// outcome keeps it; nothing is drawn again.
export async function drawProbe(options: ProbeOptions): Promise<ProbeIndex> {
  const source = resolve(options.source), out = resolve(options.out);
  const log = options.log ?? (() => undefined);
  const ids = options.scenes ?? PROBE_SCENES;
  // Everything is read and checked before probe.json is written or the server is asked anything, and a sealed id is
  // refused before a byte of round one is read.
  ids.forEach(cleanId);
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(out, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${out} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says before anything is drawn`); }
  const base = readBase(), round = roundOf(source), setup = setupOf(card, base);
  const differs = Object.keys(setup).filter(key => round.pins[key] !== setup[key]);
  if (differs.length) throw new Refusal(`Round one was drawn under another ${differs.join(', ')}: its T is not today's T on this card, and nothing is drawn`);
  const scenes = ids.map(id => sceneOf(source, round, id));
  const variants = options.variants ? VARIANTS.filter(one => options.variants!.includes(one.id)) : VARIANTS;
  const file = join(out, 'probe.json');
  const earlier = readJson<ProbeIndex>(file);
  // A picture probe.json records as drawn whose file is gone is data lost: nothing more is drawn before someone looks.
  const lost = Object.values(earlier?.cells ?? {}).filter(one => one.status === 'drawn' && !(one.file && existsSync(join(out, one.file))));
  if (lost.length) throw new Refusal(`probe.json records ${lost.length} pictures whose files are gone from ${out}, ${lost[0].key} the first: that is data lost, to be looked into; nothing is drawn`);
  const moved = scenes.find(scene => earlier?.scenes[scene.id] !== undefined && earlier.scenes[scene.id] !== scene.hash);
  if (moved) throw new Refusal(`Round one's ${moved.id} is not what ${file} drew from: one probe directory holds one set of inputs`);
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card), and the probe is pinned to that too; nothing is drawn');
  });
  const pins: Record<string, string | number> = { ...setup, style: sha256(STYLE), variants: variantsPin(), seed: SEED, ...server };
  const changed = earlier && [...new Set([...Object.keys(pins), ...Object.keys(earlier.pins)])].find(key => earlier.pins[key] !== pins[key]);
  if (changed) throw new Refusal(`${file} was drawn under another ${changed}; one probe directory holds one set of pins`);
  const index: ProbeIndex = earlier ?? { pins, startedAt: new Date().toISOString(), scenes: {}, cells: {} };
  index.sameServer = ['comfyui', 'pytorch', 'card'].every(key => round.pins[key] === pins[key]);
  for (const scene of scenes) index.scenes[scene.id] = scene.hash;
  delete index.stopped;
  delete index.error;
  delete index.completedAt;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, index);
  save();
  const times = timesOf(round), recipe = recipeOf(base), uploaded = new Map<string, string>();
  let cold = true;
  const price = (variant: Variant, bound: number) => times.price(variant, bound) + (cold ? COLD_MS : 0);
  log({ event: 'probe_plan', ...estimateOf(round, scenes, variants), left: scenes.reduce((sum, scene) => sum + variants.filter(one => !index.cells[cellKey(scene.id, one.id)]).length, 0),
    sameServer: index.sameServer });
  const name = async (input: Input, spent: { ms: number }) => {
    let named = uploaded.get(input.sha256);
    if (named === undefined) {
      const began = performance.now();
      named = await uploadReference(comfy, input.bytes);
      spent.ms += performance.now() - began;
      uploaded.set(input.sha256, named);
    }
    return named;
  };

  let ended: 'done' | 'until' | 'stopped' = 'done';
  scenes: for (const scene of scenes) {
    const left = variants.filter(variant => !index.cells[cellKey(scene.id, variant.id)]);
    if (!left.length) continue;
    const needMs = left.reduce((sum, variant) => sum + times.price(variant, scene.bound), cold ? COLD_MS : 0), leftMs = options.until - Date.now();
    if (comfy.end?.aborted || needMs > leftMs) {
      log({ event: 'scene_not_begun', story: scene.id, cells: left.length, needMinutes: Math.ceil(needMs / 60000), leftMinutes: Math.max(0, Math.floor(leftMs / 60000)) });
      ended = 'until';
      break;
    }
    for (const variant of left) {
      const key = cellKey(scene.id, variant.id);
      const fits = () => !comfy.end?.aborted && Date.now() + price(variant, scene.bound) <= options.until;
      if (!fits()) { ended = 'until'; break scenes; }
      const latent = latentStart(variant);
      const own = { key, story: scene.id, variant: variant.id, references: scene.bound + (latent ? 0 : 1) };
      let sent = false;
      try {
        const spent = { ms: 0 };
        const slots: string[] = [];
        for (const input of latent ? scene.portraits : [scene.l, ...scene.portraits]) slots.push(await name(input, spent));
        const start = latent ? await name(scene.l, spent) : undefined;
        const prompt = probePrompt(scene, variant);
        const filled = applyToWorkflow(probeGraph(base, variant, scene.bound), { checkpoint: card.model, prompt, negative: '', seed: SEED, ...recipe,
          ...FRAME_CANVAS, references: slots });
        if (start !== undefined) startFrom(filled, variant, start);
        if (!graphRight(filled, variant, slots, start)) throw Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
        const before = await logLines(comfy);
        sent = true;
        const drawn = await drawOne(comfy, filled, { pollMs: options.pollMs, waitMs: options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true, admit: fits });
        // The picture is down, and it is kept whatever comes next: saved and recorded before anything more is asked.
        await settled();
        const path = join(out, scene.id, `${variant.id}.png`);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, drawn.bytes, { mode: 0o600 });
        const size = pngSize(drawn.bytes);
        index.cells[key] = { ...own, status: 'drawn', file: relative(out, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length, ...size,
          ...(cold ? { cold } : {}), totalMs: drawn.totalMs, viewMs: drawn.viewMs, ...(spent.ms ? { uploadMs: Math.round(spent.ms) } : {}), ...drawn.timing,
          vram: drawn.vram, vramSamples: drawn.memory.samples, promptChars: prompt.length, graphRight: true };
        cold = false;
        save();
        log({ event: 'cell_drawn', key, totalMs: drawn.totalMs, width: size.width, height: size.height });
        if (comfy.end?.aborted) { ended = 'until'; break scenes; }
        const loads = partialLoadsSince(before, await logLines(comfy));
        if (loads !== undefined) {
          index.cells[key].partialModelLoadEvents = loads;
          save();
        }
      } catch (error) {
        if (sent) cold = false;
        const raw = (error as { code?: unknown }).code;
        const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
        const { httpStatus } = safeErrorDetails(error);
        const oom = (error as { oom?: unknown }).oom === true;
        // Whatever failed once the end had come was cut by it, and a job its time no longer covered was never sent.
        if (comfy.end?.aborted || raw === 'not_admitted') { ended = 'until'; break scenes; }
        index.cells[key] = { ...own, status: 'failed', code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}) };
        save();
        log({ event: 'cell_failed', key, code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}) });
        // The graph or the server, not this picture: the probe stops, and a resume goes on after this cell.
        if (stopsTheRun(code)) { index.error = code; ended = 'stopped'; break scenes; }
      }
    }
    writePage(source, out, scenes);
  }
  // A failed cell's delete may still be on its way, and the run is not over before the card has had it.
  await settled();
  if (ended === 'until') index.stopped = 'until';
  index.completedAt = new Date().toISOString();
  save();
  writePage(source, out, scenes);
  log({ event: 'probe_done', ended, ...countsOf(index) });
  return index;
}
const countsOf = (index: ProbeIndex) => {
  const cells = Object.values(index.cells);
  const failed = cells.filter(one => one.status === 'failed').reduce<Record<string, number>>((all, one) => ({ ...all, [one.code ?? 'image_failed']: (all[one.code ?? 'image_failed'] ?? 0) + 1 }), {});
  return { drawn: cells.filter(one => one.status === 'drawn').length, failed, planned: Object.keys(index.scenes).length * VARIANTS.length };
};

// ---- The page ----

// index.html in the probe's directory: what T did in round one and what each variant changes, then each scene's
// portraits, round one's L, T and C, and every variant, each picture linked where it lies and never copied. While the
// probe draws, the page reloads every minute.
export function writePage(source: string, out: string, read?: Scene[]) {
  source = resolve(source);
  out = resolve(out);
  const index = readJson<ProbeIndex>(join(out, 'probe.json'));
  if (!index) throw new Refusal(`${join(out, 'probe.json')} is missing: the page shows what the probe drew`);
  const round = read ? undefined : roundOf(source);
  const scenes = read ?? Object.keys(index.scenes).map(id => sceneOf(source, round!, id));
  const drawing = !index.completedAt;
  const figure = (path: string | undefined, caption: string, shape: 'wide' | 'tall', missing: string) => {
    const src = path && existsSync(path) ? escapeHtml(relative(out, path).split(sep).join('/')) : undefined;
    const body = src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>` : `<div class="box">${escapeHtml(missing)}</div>`;
    return `<figure class="${shape}">${body}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  const sections = scenes.map(scene => {
    const title = ACTION_STORIES.find(one => one.id === scene.id)?.label ?? scene.id;
    const portraits = scene.portraits.map((one, at) => figure(join(source, one.file), `портрет ${at + 1}`, 'tall', 'нет файла')).join('');
    const first = [figure(join(source, scene.l.file), 'L — раунд 1', 'wide', 'нет файла'),
      ...(['T', 'C'] as const).map(arm => figure(scene.shown[arm] && join(source, scene.shown[arm]), `${arm} — раунд 1`, 'wide', 'нет в записи раунда'))].join('');
    const variants = VARIANTS.map(variant => {
      const one = index.cells[cellKey(scene.id, variant.id)];
      return figure(one?.status === 'drawn' && one.file ? join(out, one.file) : undefined, `${variant.id} — ${variant.short}`, 'wide',
        one?.status === 'failed' ? `не вышло: ${one.code ?? '—'}` : one ? 'нет файла' : drawing ? 'ещё не нарисовано' : 'не нарисовано');
    }).join('');
    return `<section><h2>${escapeHtml(scene.id)}: ${escapeHtml(title)}, портретов ${scene.bound}</h2><div class="row">${portraits}</div>`
      + `<div class="row">${first}</div><div class="row">${variants}</div></section>`;
  });
  const counts = countsOf(index);
  const state = drawing ? 'рисуется; страница обновляется сама раз в минуту'
    : index.error ? `остановилось с ошибкой ${index.error}` : index.stopped ? 'остановилось: следующая сцена не успевала до срока' : 'закончено';
  const failed = Object.entries(counts.failed).map(([code, count]) => `${code} ${count}`).join(', ');
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${drawing ? '<meta http-equiv="refresh" content="60">' : ''}
<title>T: пробы</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}figure{margin:0}
figure.wide{width:calc((100% - 16px) / 3)}figure.tall{width:calc((100% - 40px) / 6)}img{width:100%;display:block}
.box{display:flex;align-items:center;justify-content:center;text-align:center;aspect-ratio:16/9;background:#eee;font-size:14px}
figure.tall .box{aspect-ratio:9/16}table{border-collapse:collapse}th,td{padding:4px 6px;border-top:1px solid #ddd;vertical-align:top;text-align:left}
@media (max-width:640px){figure.wide{width:100%}figure.tall{width:calc((100% - 16px) / 3)}}</style>
<h1>T: пять проб на картинках первого раунда</h1>
<p>В первом раунде T вернул картинку L: те же люди и лица на тех же местах, только края перерезкие, а цвет и контраст задраны; судьи поставили T то же,
что L, по всем пунктам всех 13 чистых сцен. Здесь пять проб, каждая — одно изменение против сегодняшнего T, на тех же L и портретах сида ${SEED}.
Лица, волосы и телосложение сравнивать с портретами; контакты, позы и кадр — с L; края и цвета — с L. Раунд два рисует T как есть, пока
владелец не выберет.</p>
<table><tr><th>проба</th><th>что изменено</th><th>чего ждём на лицах</th><th>риск для действия</th></tr>
${VARIANTS.map(one => `<tr><td><b>${escapeHtml(one.id)}</b></td><td>${escapeHtml(one.change)}</td><td>${escapeHtml(one.faces)}</td><td>${escapeHtml(one.risk)}</td></tr>`).join('\n')}
</table>
<p>Состояние: ${escapeHtml(state)}. Нарисовано ${counts.drawn} из ${counts.planned}${failed ? `, не вышло: ${escapeHtml(failed)}` : ''}.
${index.sameServer === false ? ' Сервер сказал о себе не то, что в первом раунде (ComfyUI, PyTorch или карта).' : ''}</p>
${sections.join('\n')}
`, { mode: 0o600 });
}

// ---- The dry run ----

// Round one as the harness left it for the probe, made up: each probe scene's plan, whose T and C prompts are in round
// one's own form around made-up roles, L's, T's and C's pictures at 1280x704 and the fronts at 720x1280, flat grey,
// and draw.json with their records, round one's pins and times like round one's; beside them a sealed story whose plan
// and picture hold `word`.
const DRY_BOUND: Record<string, number> = { flight: 4, twister: 4, giants: 3, guard: 2, tango: 2, monkeys: 1 };
function madeUpRound(root: string, card: ReturnType<typeof cardOf>, word: string) {
  const round: DrawIndex = { pins: { ...setupOf(card, readBase()), portraitCanvas: '720x1280', comfyui: 'fake', pytorch: 'fake', card: 'fake card' },
    startedAt: new Date().toISOString(), cells: {} };
  let number = 1000;
  const put = (cell: { key: string; kind: 'frame' | 'front'; story: string; id: string; arm?: ActionArm; references: number }, bytes: Buffer) => {
    const path = fileOf(root, { ...cell, seed: SEED });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    round.cells[cell.key] = { ...cell, seed: SEED, status: 'drawn', file: relative(root, path), sha256: sha256(bytes), bytes: bytes.length, ...pngSize(bytes),
      totalMs: 18000 + 1000 * cell.references, uploadMs: 700 };
  };
  for (const id of PROBE_SCENES) {
    const roles = Array.from({ length: DRY_BOUND[id] }, (_, at) => `the made-up holder ${at + 1}`);
    const fronts = roles.map((_, at) => `${id}-e${at + 1}`);
    const plan = { id, manifest: { order: roles.map((_, at) => at), entries: fronts.map((_, at) => `e${at + 1}`),
      bound: fronts.map((portrait, at) => ({ person: at, entry: `e${at + 1}`, portrait, slot: at + 1, facing: 'viewer', view: null })) },
    arms: { L: { prompt: `A made-up room. ${roles.map(role => `${role}: holds on. `).join('')}${STYLE}`, references: [] },
      C: { prompt: `A made-up room. ${roles.map((role, at) => `The person from image ${at + 1}, ${role}: holds on. `).join('')}${STYLE}`, references: fronts },
      T: { prompt: `${T_OPENING} ${roles.map((role, at) => tClause(role, at + 2)).join('; ')}. ${STYLE}`, references: ['L', ...fronts] } },
    out: {}, vIsC: true, portraits: fronts.map((portrait, at) => ({ id: portrait, entry: `e${at + 1}`, prompt: 'made up' })), views: [], counts: {} };
    mkdirSync(storyDir(root, id), { recursive: true, mode: 0o700 });
    writeJson(join(storyDir(root, id), 'plan.json'), plan);
    for (const arm of ['L', 'T', 'C'] as const) {
      put({ key: frameKey(id, SEED, arm), kind: 'frame', story: id, id: `${id}-s${SEED}-${arm}`, arm, references: arm === 'L' ? 0 : arm === 'T' ? roles.length + 1 : roles.length },
        greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++));
    }
    for (const front of fronts) put({ key: `front:${front}`, kind: 'front', story: id, id: front, references: 0 }, greyPng(720, 1280, number++));
  }
  const sealed = storyDir(root, 'sharp-1');
  mkdirSync(join(sealed, 'pictures'), { recursive: true, mode: 0o700 });
  writeJson(join(sealed, 'plan.json'), { id: 'sharp-1', arms: { T: { prompt: `${T_OPENING} ${word} takes them from the person in image 2. ${STYLE}`, references: ['L', 'sharp-1-e1'] } } });
  writeFileSync(join(sealed, 'pictures', `s${SEED}-L.png`), greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++, 0, word), { mode: 0o600 });
  writeJson(join(root, 'draw.json'), round);
}

// The whole probe against local/fake-comfy.ts, in `dir`: the made-up round in `round/`, the probe's directory in
// `probe/`, `tmp/` as the temporary directory. On the way, what the paid run relies on: a sealed story, the marker, a
// clean scene whose directory is a link into sealed/ and an L that is not round one's are refused before anything is
// sent or written; a scene that cannot end by --until is not begun; every variant sends its own slots, sizes and start
// and comes back at 1280x704; a resume draws nothing again; the page shows every picture it names. The fake writes a
// made-up word into every picture's metadata, and the sealed story holds it: afterwards it is nowhere outside sealed/,
// in the temporary directory or in what was printed.
export async function dryRun(dir: string) {
  const dry = resolve(dir), source = join(dry, 'round'), out = join(dry, 'probe'), temp = join(dry, 'tmp');
  for (const path of [source, out, temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) { say(`   ${what}: refused (${JSON.stringify(safeError(error))})`); }
  };
  const word = madeUpName();
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  try {
    say(`dry run in ${dry}: a made-up round one and local/fake-comfy.ts; no card, no model, no network`);
    writeCardRecord(join(out, 'card.txt'));
    madeUpRound(source, cardOf(join(out, 'card.txt')), word);
    fake = await startFakeComfy({ jobMs: 30, referenceMs: 0, requireUploads: true, marker: word });
    const url = fake.url;
    const draw = (extra: Partial<ProbeOptions> = {}) => drawProbe({ source, out, comfy: url, until: Date.now() + 3600000, pollMs: 10, waitMs: 60000, timeoutMs: 10000, ...extra });

    say('1 refusals before anything is sent or written:');
    await refused('a sealed story', () => draw({ scenes: ['tango', 'sharp-1'] }));
    await refused('the marker story', () => draw({ scenes: [MARKER_STORY.id] }));
    symlinkSync(storyDir(source, 'sharp-1'), storyDir(source, 'rescue'));
    await refused('a clean scene whose directory is a link into sealed/', () => draw({ scenes: ['rescue'] }));
    unlinkSync(storyDir(source, 'rescue'));
    const lFile = fileOf(source, { kind: 'frame', story: 'tango', id: '', seed: SEED, arm: 'L' }), kept = readFileSync(lFile);
    writeFileSync(lFile, greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, 1));
    await refused('an L that is not the picture round one recorded', () => draw());
    writeFileSync(lFile, kept);
    expect(fake.jobs.length === 0 && fake.uploads.length === 0 && !existsSync(join(out, 'probe.json')), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`2 five seconds left: stopped ${short.stopped}, ${fake.jobs.length} jobs sent`);
    expect(short.stopped === 'until' && fake.jobs.length === 0, 'a scene that cannot end in time is not begun');

    const whole = await draw();
    const cells = Object.values(whole.cells);
    const counts = countsOf(whole);
    say(`3 the probe: ${counts.drawn} of ${counts.planned} drawn, failed ${JSON.stringify(counts.failed)}; ${fake.jobs.length} jobs`);
    expect(counts.drawn === PROBE_SCENES.length * VARIANTS.length && cells.every(one => one.width === FRAME_CANVAS.width && one.height === FRAME_CANVAS.height),
      'every cell drawn at 1280x704');
    // Each job against its variant, in the order drawn: the slots, their sizes, and what the sampler starts from.
    const named = (file: string) => `ref-${sha256(stripPngMetadata(readFileSync(file))).slice(0, 16)}.png`;
    const wrong: string[] = [];
    let job = 0;
    for (const id of PROBE_SCENES) {
      const bound = DRY_BOUND[id], l = named(fileOf(source, { kind: 'frame', story: id, id: '', seed: SEED, arm: 'L' }));
      for (const variant of VARIANTS) {
        const one = fake.jobs[job++];
        const sizes = one?.slots.map(slot => (slot.scaled ? `${slot.scaled.width}x${slot.scaled.height}` : 'own'));
        const first = latentStart(variant) ? '352x640' : variant.id === 'half' ? '640x352' : 'own';
        const right = one && one.width === FRAME_CANVAS.width && one.height === FRAME_CANVAS.height && one.references === bound + 1
          && sizes!.length === (latentStart(variant) ? bound : bound + 1) && sizes![0] === first && sizes!.slice(1).every(size => size === '352x640')
          && (latentStart(variant) ? one.slots.every(slot => slot.file !== l) : one.slots[0].file === l);
        if (!right) wrong.push(cellKey(id, variant.id));
      }
    }
    say(`   jobs against their variants: ${job - wrong.length} of ${job} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    expect(!wrong.length && fake.jobs.length === job, 'every variant sends its own slots, sizes and start');

    const jobs = fake.jobs.length;
    await draw();
    say(`4 a resume: ${fake.jobs.length - jobs} jobs`);
    expect(fake.jobs.length === jobs, 'a resume draws nothing again');

    writePage(source, out);
    const page = readFileSync(join(out, 'index.html'), 'utf8');
    const sources = [...page.matchAll(/<img src="([^"]+)"/g)].map(match => match[1]);
    const shown = PROBE_SCENES.reduce((sum, id) => sum + DRY_BOUND[id] + 3 + VARIANTS.length, 0);
    say(`5 page: ${sources.length} pictures, ${sources.filter(src => existsSync(join(out, src))).length} of them where it links`);
    expect(sources.length === shown && sources.every(src => existsSync(join(out, src))) && VARIANTS.every(one => page.includes(`<b>${one.id}</b>`)),
      'the page shows every portrait, L, T, C and variant, and names every change');

    const found = searchBoundary({ root: dry, sealed: join(source, 'sealed'), tempDir: temp, word, output: output.text() });
    const inside = searchTree(join(source, 'sealed'), markerForms(word)).hits.length;
    say(`6 boundary: ${found.files} files outside sealed/, ${found.unread} unread: hits ${JSON.stringify({ files: found.hits.files.length, temp: found.hits.temp, output: found.hits.output })}; `
      + `the word is in ${inside} files inside sealed/`);
    expect(inside > 0, 'the word inside sealed/');
    expect(found.pass, 'the word nowhere outside sealed/');
    say(missed.length ? `the dry run did NOT go as expected: ${missed.length} of its checks` : 'the dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

// The live commands read illustrations/action-1 and write illustrations/t-probe, where they lie: a link on the way
// could lead into a sealed/ or out of the owner's reach.
function liveDirs() {
  for (const path of [join(ROOT, 'illustrations'), SOURCE_DIR, join(SOURCE_DIR, 'clean'), PROBE_DIR]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${relative(ROOT, path)} is a link: the probe reads and writes only where round one and the probe lie`);
  }
}
const list = (value: string | undefined) => value?.split(',').map(part => part.trim()).filter(Boolean);

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' }, scenes: { type: 'string' }, variants: { type: 'string' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-t-probe-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (values.dir !== undefined) throw new Refusal('Only dry-run takes --dir: the probe reads illustrations/action-1 and writes illustrations/t-probe');
  liveDirs();
  const scenes = list(values.scenes), variants = list(values.variants);
  if (variants?.some(id => !VARIANTS.some(one => one.id === id))) throw new Refusal(`--variants takes ${VARIANTS.map(one => one.id).join(', ')}, comma separated`);
  scenes?.forEach(cleanId);
  if (command === 'estimate') {
    const round = roundOf(SOURCE_DIR);
    const read = (scenes ?? PROBE_SCENES).map(id => sceneOf(SOURCE_DIR, round, id));
    print({ event: 'estimate', ...estimateOf(round, read, variants ? VARIANTS.filter(one => variants.includes(one.id)) : VARIANTS),
      bound: Object.fromEntries(read.map(scene => [scene.id, scene.bound])) });
  } else if (command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --until <epoch seconds, five minutes before the card\'s end> [--scenes flight,...] [--variants words,...] [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawProbe({ source: SOURCE_DIR, out: PROBE_DIR, comfy: comfyUrl(values.comfy!), until, scenes, variants: variants as VariantId[] | undefined,
      timeoutMs: timeout * 1000, waitMs: wait * 1000, log: print });
    print({ event: 'probe', ...countsOf(index), sameServer: index.sameServer, ...(index.stopped ? { stopped: index.stopped } : {}), ...(index.error ? { error: index.error } : {}) });
    if (index.error || index.stopped) process.exitCode = 1;
  } else if (command === 'page') {
    writePage(SOURCE_DIR, PROBE_DIR);
    print({ event: 'page', file: relative(ROOT, join(PROBE_DIR, 'index.html')) });
  } else throw new Refusal('Use: image-t-probe.ts estimate|draw|page|dry-run (docs/action-experiment.md#t-probe)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
