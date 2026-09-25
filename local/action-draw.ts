// The picture run of the action measurement (docs/action-experiment.md#drawing): the fronts, the views and the six
// arms' frames of the plans `prompts` wrote, on the picture card, through local/image-batch.ts's own drawing. Three
// stages, each ended on the wall clock by `--until` as the identity run's were:
//   smoke      the scene with the most bound people at seed 7, its fronts, its views and its arms, and one view more
//              when it needs none; then its verdict;
//   portraits  the rest of the fronts and views, once the smoke has passed and the whole of seed 7 fits;
//   main       whatever of those is left, seed 7 scene by scene, then seed 11 if it fits whole.
// Every file goes into its story's directory, `sealed/<id>/` for a sharp one, stripped of its metadata; `draw.json`
// at the run's level holds ids, codes, sizes, counts and times. For a sharp story nothing else is asked of the card:
// not its log, which may carry the prompt.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ACTION_SEEDS } from '../examples/action-set.ts';
import { CLEANUP_RESERVE_MS, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, drawOne, encoderResolution, logLines, partialLoadsSince,
  pngSize, referenceGeometry, referenceSlots, samplerSettingsOf, serverPins, settled, stopsTheRun, textEncoderOf,
  uploadReference } from './image-batch.ts';
import type { Comfy, Graph, Phases, Vram } from './image-batch.ts';
import { cardOf, pinsOf } from './image-identity.ts';
import { portraitCanvas } from './image-portraits.ts';
import { safeErrorDetails } from './model-error.ts';
import { qwenPromptTokens } from './tokenizer.ts';
import type { QwenTokenizer } from './tokenizer.ts';
import { Refusal } from './action-boundary.ts';
import { ARMS, isSharp, readJson, storyDir, textStories } from './action-text.ts';
import type { ActionArm } from './action-text.ts';
import { T_OPENING, VIEW_TURNS, readPlan } from './action-prompts.ts';
import type { PromptsRecord, StoryPlan } from './action-prompts.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const FRONT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen.json');
export const ACTION_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen-action.json');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const readGraph = (file: string): Graph => apiGraph(JSON.parse(readFileSync(file, 'utf8')));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });

// The sizes the doc fixes: every frame, every view, and every reference after its scale node.
export const FRAME_CANVAS = { width: 1280, height: 704 };
export const VIEW_CANVAS = { width: 704, height: 1280 };
export const SCALED = { width: 352, height: 640 };
// The smoke's floor of free video memory at the sampled peak, and a cell's price: its slowest time in the smoke, a
// quarter more, and three seconds for the transfers (docs/action-experiment.md#time). Before the smoke nothing is
// measured, and a smoke cell's price is the longest a picture may take: its whole wait (`--wait`) and the three
// seconds.
export const FREE_MIB = 2048;
export const MARGIN = 1.25, CELL_MS = 3000, WAIT_MS = 300000;
// The codes a cell fails under (docs/action-experiment.md#sealed): local/image-batch.ts's for a picture, the graph
// and the server, and the harness's own. A code is one of them because it is in this list; any other is
// `image_failed`.
export const DRAW_CODES: readonly string[] = ['cancelled', 'out_of_time', 'image_timeout', 'image_failed', 'not_a_png', 'truncated_png',
  'comfy_http_error', 'comfy_rejected_prompt', 'comfy_upload_failed', 'comfy_socket_unavailable', 'comfy_stop_unconfirmed',
  'workflow_not_api_format', 'workflow_no_sampler_or_loader', 'workflow_no_latent_size', 'workflow_no_positive_prompt',
  'workflow_too_few_reference_slots', 'workflow_slot_mismatch'];

// ---- The graphs ----

const scaleNode = (slot: number) => String(20 + slot);
const copyNode = (slot: number) => String(30 + slot);
// The action graph with a scale node of its own to 352x640 on each slot in `scaled`, and, in the smoke, a saving node
// after each, whose copy is read back to check the size the encoder got. The slots a frame leaves empty go with their
// whole chain when the graph is filled (image-batch.ts `applyToWorkflow`).
export function actionGraph(base: Graph, scaled: number[], copies = false): { graph: Graph; copies: string[] } {
  const graph: Graph = structuredClone(base);
  const saved: string[] = [];
  referenceSlots(base).forEach((slot, order) => {
    const n = order + 1;
    if (!scaled.includes(n)) return;
    graph[scaleNode(n)] = { class_type: 'ImageScale', inputs: { upscale_method: 'area', width: SCALED.width, height: SCALED.height, crop: 'disabled', image: [slot.loader, 0] } };
    graph[slot.node].inputs[slot.key] = [scaleNode(n), 0];
    if (copies) {
      graph[copyNode(n)] = { class_type: 'SaveImage', inputs: { filename_prefix: 'action-check', images: [scaleNode(n), 0] } };
      saved.push(copyNode(n));
    }
  });
  return { graph, copies: saved };
}
// What a filled graph sends: each slot's file, and whether a scale node stands between it and the encoder.
export const sentSlots = (graph: Graph) => referenceSlots(graph).map(slot => ({ file: String(graph[slot.loader].inputs.image), scaled: slot.scale !== undefined }));

// ---- The cells ----

export type CellKind = 'front' | 'view' | 'frame';
// One picture to draw: a front or a view by its id, or a frame of one arm, scene and seed. `refs` are the ids of what
// its slots send, in slot order: fronts, views, and `L` for L's picture of the same scene and seed.
export type ActionCell = { key: string; kind: CellKind; story: string; id: string; seed: number; arm?: ActionArm; refs: string[]; prompt: string };
export const frameKey = (story: string, seed: number, arm: ActionArm) => `frame:${story}:s${seed}:${arm}`;
export function planCells(plans: StoryPlan[], tOut = false) {
  const fronts: ActionCell[] = plans.flatMap(plan => plan.portraits.map(one => ({ key: `front:${one.id}`, kind: 'front' as const, story: plan.id,
    id: one.id, seed: ACTION_SEEDS[0], refs: [], prompt: one.prompt })));
  const views: ActionCell[] = plans.flatMap(plan => plan.views.map(one => ({ key: `view:${one.id}`, kind: 'view' as const, story: plan.id,
    id: one.id, seed: ACTION_SEEDS[0], refs: [one.portrait], prompt: one.prompt })));
  // L before T; V only where its inputs are not C's; T not at all once the smoke has taken it out.
  const frames = (seed: number): ActionCell[] => plans.flatMap(plan => ARMS.filter(arm => plan.arms[arm] && !(arm === 'V' && plan.vIsC) && !(arm === 'T' && tOut))
    .map(arm => ({ key: frameKey(plan.id, seed, arm), kind: 'frame' as const, story: plan.id, id: `${plan.id}-s${seed}-${arm}`, seed, arm,
      refs: plan.arms[arm]!.references, prompt: plan.arms[arm]!.prompt })));
  return { fronts, views, frames };
}
// The smoke's scene: the most people bound among the scenes that draw C, the first in the set's order on a tie, or the
// first scene with any arm when none does; and, when it needs no view, the first view another scene needs.
export function smokeChoice(plans: StoryPlan[]): { story: string; extraView?: string } | undefined {
  const bound = (plan: StoryPlan) => (plan.arms.C ? plan.manifest?.bound.length ?? 0 : 0);
  const drawn = plans.filter(plan => Object.keys(plan.arms).length);
  const best = drawn.reduce<StoryPlan | undefined>((top, plan) => (!top || bound(plan) > bound(top) ? plan : top), undefined);
  if (!best) return undefined;
  const extra = best.views.length ? undefined : plans.find(plan => plan !== best && plan.views.length)?.views[0]?.id;
  return { story: best.id, ...(extra ? { extraView: extra } : {}) };
}
// Its cells: the scene's fronts, the front the extra view is drawn from, the views, and the scene's arms at seed 7.
export function smokeCells(plans: StoryPlan[]): ActionCell[] {
  const choice = smokeChoice(plans);
  if (!choice) return [];
  const { fronts, views, frames } = planCells(plans);
  const extra = views.find(cell => cell.id === choice.extraView);
  return [...fronts.filter(cell => cell.story === choice.story || extra?.refs.includes(cell.id)),
    ...views.filter(cell => cell.story === choice.story || cell === extra), ...frames(ACTION_SEEDS[0]).filter(cell => cell.story === choice.story)];
}

// ---- The record ----

export type CellRecord = { key: string; kind: CellKind; story: string; id: string; seed: number; arm?: ActionArm;
  status: 'drawn' | 'failed' | 'out'; code?: string; httpStatus?: number; oom?: boolean; smoke?: boolean;
  steps?: number; sampler?: string; scheduler?: string; cfg?: number;
  file?: string; sha256?: string; bytes?: number; width?: number; height?: number; references: number; referenceSizes?: [number, number][];
  totalMs?: number; viewMs?: number; uploadMs?: number; loaderCacheMiss?: boolean; first?: boolean; phases?: Phases;
  vram?: Vram[]; vramSamples?: number; ramMiB?: { min: number; max: number }; partialModelLoadEvents?: number;
  promptChars?: number; promptTokens?: number; conditioningTokens?: number; slotsRight?: boolean;
  copies?: { node: string; width: number; height: number }[] };
export type SmokeVerdict = { pass: boolean; tOut: boolean; cells: number; drawn: boolean; geometry: boolean; slots: boolean;
  heard: boolean; memory: boolean; failing: string[] };
export type DrawIndex = { pins: Record<string, string | number>; startedAt: string; completedAt?: string; cells: Record<string, CellRecord>;
  smoke?: { keys: string[]; extraView?: string; verdict?: SmokeVerdict }; admitted?: Record<string, boolean>;
  admission?: { seed: number; cells: number; needMs: number; leftMs: number; admitted: boolean }[]; stopped?: 'until' | 'admission'; error?: string };

const canvasOf = (kind: CellKind, front: { width: number; height: number }) => kind === 'front' ? front : kind === 'view' ? VIEW_CANVAS : FRAME_CANVAS;
const heard = (one: CellRecord) => one.phases?.sampleMs !== undefined && one.loaderCacheMiss !== undefined;
const freeMiB = (one: CellRecord) => {
  const device = one.vram?.[0];
  return device?.occupiedMiBMax === undefined || !one.vramSamples ? undefined : device.totalMiB - device.occupiedMiBMax;
};
const scaledCount = (one: { kind: CellKind; arm?: ActionArm; references: number }) =>
  one.kind !== 'frame' || !one.arm || !['C', 'V', 'T'].includes(one.arm) ? 0 : one.arm === 'T' ? one.references - 1 : one.references;

// The smoke passes when every cell is drawn, on the right geometry with its scaled copies at 352x640, with the slots
// its manifest names, every phase heard on the socket and 2 GiB free at the sampled peak. When T's cell alone fails,
// T leaves the run and the rest passes.
export function smokeVerdict(index: DrawIndex, keys: string[], front: { width: number; height: number }): SmokeVerdict {
  const reasons = (key: string): string[] => {
    const one = index.cells[key];
    if (!one || one.status !== 'drawn') return ['drawn'];
    const canvas = canvasOf(one.kind, front);
    const copies = one.copies ?? [];
    return [
      ...(one.width === canvas.width && one.height === canvas.height && copies.length === scaledCount(one)
        && copies.every(copy => copy.width === SCALED.width && copy.height === SCALED.height) ? [] : ['geometry']),
      ...(one.slotsRight ? [] : ['slots']), ...(heard(one) ? [] : ['heard']),
      ...((freeMiB(one) ?? -1) >= FREE_MIB ? [] : ['memory'])];
  };
  const all = keys.map(key => ({ key, why: reasons(key) }));
  const failing = all.filter(one => one.why.length).map(one => one.key);
  const tOut = failing.length > 0 && failing.every(key => key.startsWith('frame:') && key.endsWith(':T'));
  const has = (why: string) => all.some(one => one.why.includes(why));
  return { pass: keys.length > 0 && (!failing.length || tOut), tOut, cells: keys.length, drawn: !has('drawn'), geometry: !has('geometry'),
    slots: !has('slots'), heard: !has('heard'), memory: !has('memory'), failing };
}

// A cell's price from the smoke's own slowest times, uploads included: a front by its slowest front, a view by its
// slowest view, a frame without references by its slowest of A, A+ and L, an edit with k references by its slowest
// edit with the fewest references at or above k, T by its T, and anything it did not draw by its slowest edit.
export function pricing(smoke: CellRecord[]): (cell: ActionCell) => number {
  const drawn = smoke.filter(one => one.status === 'drawn' && one.totalMs !== undefined);
  const time = (one: CellRecord) => one.totalMs! + (one.uploadMs ?? 0);
  const slowest = (list: CellRecord[]) => (list.length ? Math.max(...list.map(time)) : undefined);
  const edits = drawn.filter(one => one.arm === 'C' || one.arm === 'V');
  const fallback = slowest(drawn.filter(one => one.arm === 'C' || one.arm === 'V' || one.arm === 'T')) ?? slowest(drawn);
  return cell => {
    let ms: number | undefined;
    if (cell.kind !== 'frame') ms = slowest(drawn.filter(one => one.kind === cell.kind));
    else if (cell.arm === 'A' || cell.arm === 'A+' || cell.arm === 'L') ms = slowest(drawn.filter(one => one.arm === 'A' || one.arm === 'A+' || one.arm === 'L'));
    else if (cell.arm === 'T') ms = slowest(drawn.filter(one => one.arm === 'T'));
    else {
      const above = edits.filter(one => one.references >= cell.refs.length);
      const fewest = Math.min(...above.map(one => one.references));
      ms = slowest(above.filter(one => one.references === fewest));
    }
    ms ??= fallback;
    return ms === undefined ? Infinity : Math.round(ms * MARGIN + CELL_MS);
  };
}

// ---- The stages ----

export type DrawStageOptions = { stage: 'smoke' | 'portraits' | 'main'; root: string; comfy: string; until: number;
  tokenizer?: QwenTokenizer; timeoutMs?: number; waitMs?: number; pollMs?: number; log?: (event: object) => void };
type Run = { root: string; index: DrawIndex; save: () => void; comfy: Comfy; plans: Map<string, StoryPlan>; until: number;
  checkpoint: string; front: { graph: Graph; canvas: { width: number; height: number } }; base: Graph; resolution: number;
  sampler: { steps: number; sampler: string; scheduler: string; cfg: number }; frontSampler: { steps: number; sampler: string; scheduler: string; cfg: number };
  uploaded: Map<string, string>; tokens?: (prompt: string, images: number, front: boolean) => { prompt: number; conditioning: number } | undefined;
  options: DrawStageOptions; log: (event: object) => void };

// Where a cell's picture goes in its story's directory.
export function fileOf(root: string, cell: { kind: CellKind; story: string; id: string; seed: number; arm?: ActionArm }) {
  const dir = storyDir(root, cell.story);
  return cell.kind === 'front' ? join(dir, 'portraits', `${cell.id}.png`) : cell.kind === 'view' ? join(dir, 'views', `${cell.id}.png`)
    : join(dir, 'pictures', `s${cell.seed}-${cell.arm}.png`);
}
const settings = (graph: Graph) => {
  const own = samplerSettingsOf(graph);
  return { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler,
    scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler, cfg: own.cfg ?? SAMPLER_DEFAULTS.cfg };
};

// What the pictures depend on (docs/action-experiment.md#drawing): the identity run's pins, the action graph and the
// canvases, the reference size, the views' and T's templates, every plan by its hash, and the text run's model.
function pinsFor(root: string, card: ReturnType<typeof cardOf>, base: Graph): Record<string, string | number> {
  const texts = readJson<{ pins: Record<string, string | number> }>(join(root, 'texts.json'));
  const prompts = readJson<PromptsRecord>(join(root, 'prompts.json'));
  if (!texts || !prompts) throw new Refusal('The pictures are drawn from the texts and the prompts: run `texts` and `prompts` in this directory first');
  const cache = Object.values(base).find(node => node.class_type === 'QwenImage21Cache');
  const gateway = Object.fromEntries(Object.entries(texts.pins).filter(([key]) => key.startsWith('gateway')).map(([key, value]) => [`text.${key}`, value]));
  return { ...pinsOf(card), actionGraph: sha256(readFileSync(ACTION_GRAPH)), cacheDevice: String(cache?.inputs.device ?? 'none'),
    resolution: encoderResolution(base) ?? -1, canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, viewCanvas: `${VIEW_CANVAS.width}x${VIEW_CANVAS.height}`,
    referenceSize: `${SCALED.width}x${SCALED.height}`, seeds: ACTION_SEEDS.join(','), views: sha256(JSON.stringify(VIEW_TURNS)), t: sha256(T_OPENING),
    plans: prompts.plans, texts: sha256(JSON.stringify(texts.pins)), textRoute: String(texts.pins.route), textWeights: String(texts.pins.weights), ...gateway };
}

export async function drawStage(options: DrawStageOptions): Promise<DrawIndex> {
  const root = resolve(options.root);
  const log = options.log ?? (() => undefined);
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  // Everything is read and checked before draw.json is written: a refused resume leaves it as it was. The card's
  // record and the server's pins are refused in the harness's own words (`Refusal`).
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(root, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${root} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says before anything is drawn`); }
  const base = readGraph(ACTION_GRAPH), frontGraph = readGraph(FRONT_GRAPH);
  const plans = new Map(textStories().flatMap(story => { const plan = readPlan(root, story.id); return plan ? [[story.id, plan] as const] : []; }));
  const own = pinsFor(root, card, base);
  const file = join(root, 'draw.json');
  const earlier = readJson<DrawIndex>(file);
  // A picture draw.json records as drawn whose file is gone is data lost: it is not drawn again, and nothing more is
  // drawn before someone has looked.
  const lost = Object.values(earlier?.cells ?? {}).filter(one => one.status === 'drawn' && !(one.file && existsSync(join(root, one.file))));
  if (lost.length) {
    throw new Refusal(`draw.json records ${lost.length} pictures whose files are gone from ${root}, ${lost[0].key} the first: that is data lost, `
      + 'to be looked into; nothing is drawn, and they are never drawn again');
  }
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card), and the run is pinned to that too; nothing is drawn');
  });
  const pins = { ...own, ...server };
  if (earlier) {
    const changed = [...new Set([...Object.keys(pins), ...Object.keys(earlier.pins)])].find(key => earlier.pins[key] !== pins[key]);
    if (changed) throw new Refusal(`${file} was drawn under another ${changed}; one run directory holds one set of pins`);
  }
  const index: DrawIndex = earlier ?? { pins, startedAt: new Date().toISOString(), cells: {} };
  const front = { graph: frontGraph, canvas: portraitCanvas(frontGraph) };
  const encoder = textEncoderOf(base), frontEncoder = textEncoderOf(frontGraph);
  const tokenizer = options.tokenizer;
  const run: Run = { root, index, save: () => writeJson(file, index), comfy, plans, until: options.until, checkpoint: card.model, front, base,
    resolution: Math.max(0, encoderResolution(base) ?? 0), sampler: settings(base), frontSampler: settings(frontGraph), uploaded: new Map(),
    tokens: tokenizer ? (prompt, images, isFront) => {
      const kind = isFront ? frontEncoder : encoder;
      return kind ? qwenPromptTokens(tokenizer, prompt, kind, { images }) : undefined;
    } : undefined, options, log };
  delete index.stopped;
  delete index.error;
  delete index.completedAt;
  const ordered = textStories().flatMap(story => plans.has(story.id) ? [plans.get(story.id)!] : []);

  if (options.stage === 'smoke') {
    const cells = smokeCells(ordered);
    const choice = smokeChoice(ordered);
    index.smoke = { keys: cells.map(cell => cell.key), ...(choice?.extraView ? { extraView: choice.extraView } : {}) };
    run.save();
    const ended = await drawCells(run, cells, true, () => (options.waitMs ?? WAIT_MS) + CELL_MS);
    index.smoke.verdict = smokeVerdict(index, index.smoke.keys, front.canvas);
    if (ended !== 'done') index.smoke.verdict.pass = false;
    log({ event: 'smoke', ...index.smoke.verdict, failing: index.smoke.verdict.failing.length });
    return finish(run, ended);
  }
  const verdict = index.smoke?.verdict;
  if (!verdict?.pass) {
    throw new Refusal(`The rest is drawn only after the smoke has passed in this directory (draw --smoke): ${verdict
      ? `drawn ${verdict.drawn}, geometry ${verdict.geometry}, slots ${verdict.slots}, heard ${verdict.heard}, memory ${verdict.memory}` : 'no smoke there'}`);
  }
  const { fronts, views, frames } = planCells(ordered, verdict.tOut);
  const price = pricing(index.smoke!.keys.map(key => index.cells[key]).filter(Boolean));
  // A seed begins only if all of it can end by `--until`; once begun it is never priced again, and each cell still
  // waits for its own time.
  const admit = (seed: number, cells: ActionCell[]) => {
    if (index.admitted?.[seed]) return true;
    const left = cells.filter(cell => !index.cells[cell.key]);
    const needMs = left.reduce((sum, cell) => sum + price(cell), 0), leftMs = options.until - Date.now();
    const admitted = needMs <= leftMs;
    (index.admission ??= []).push({ seed, cells: left.length, needMs: Math.min(needMs, Number.MAX_SAFE_INTEGER), leftMs: Math.max(0, leftMs), admitted });
    if (admitted) (index.admitted ??= {})[seed] = true;
    run.save();
    log({ event: 'admission', seed, cells: left.length, needMinutes: Math.ceil(needMs / 60000), leftMinutes: Math.max(0, Math.floor(leftMs / 60000)), admitted });
    return admitted;
  };
  const [first, second] = ACTION_SEEDS;
  if (!admit(first, [...fronts, ...views, ...frames(first)])) return finish(run, 'admission');
  const ended = await drawCells(run, [...fronts, ...views], false, price);
  if (ended !== 'done' || options.stage === 'portraits') return finish(run, ended);
  const seven = await drawCells(run, frames(first), false, price);
  if (seven !== 'done') return finish(run, seven);
  if (!admit(second, frames(second))) return finish(run, 'admission');
  return finish(run, await drawCells(run, frames(second), false, price));
}

async function finish(run: Run, ended: 'done' | 'until' | 'stopped' | 'admission') {
  // A failed cell's delete may still be on its way, and the stage is not over before the card has had it.
  await settled();
  if (ended === 'until' || ended === 'admission') run.index.stopped = ended;
  run.index.completedAt = new Date().toISOString();
  run.save();
  const cells = Object.values(run.index.cells);
  run.log({ event: 'stage_done', stage: run.options.stage, ended, drawn: cells.filter(one => one.status === 'drawn').length,
    failed: cells.filter(one => one.status === 'failed').length, out: cells.filter(one => one.status === 'out').length });
  return run.index;
}

// The files a cell's slots send, each checked against the record of the cell that drew it: drawn, and the very file
// that was drawn, on its canvas. Anything else keeps the cell from the card with the code of what is missing.
function referencesOf(run: Run, cell: ActionCell): { files: { path: string; bytes: Buffer }[] } | { out: string } {
  const plan = run.plans.get(cell.story);
  const files: { path: string; bytes: Buffer }[] = [];
  for (const ref of cell.refs) {
    const kind: CellKind = ref === 'L' ? 'frame' : plan?.views.some(view => view.id === ref) ? 'view' : 'front';
    const key = ref === 'L' ? frameKey(cell.story, cell.seed, 'L') : `${kind}:${ref}`;
    const name = ref === 'L' ? 'l' : kind;
    const known = run.index.cells[key];
    if (!known || known.status !== 'drawn') return { out: known?.status === 'out' ? known.code ?? `${name}_missing` : known ? `${name}_failed` : `${name}_missing` };
    const path = join(run.root, known.file ?? '');
    const bytes = existsSync(path) ? readFileSync(path) : undefined;
    const canvas = canvasOf(kind, run.front.canvas);
    const size = bytes ? pngSize(bytes) : undefined;
    if (!bytes || sha256(bytes) !== known.sha256 || size?.width !== canvas.width || size?.height !== canvas.height) return { out: 'reference_mismatch' };
    files.push({ path, bytes });
  }
  return { files };
}

async function drawCells(run: Run, cells: ActionCell[], smoke: boolean, price?: (cell: ActionCell) => number): Promise<'done' | 'until' | 'stopped'> {
  const { index, comfy, log } = run;
  for (const cell of cells) {
    // A cell with an outcome keeps it: drawn, out, or failed, a failure that stopped the run included. Nothing is drawn
    // again (docs/action-experiment.md#drawing).
    if (index.cells[cell.key]) continue;
    const sealed = isSharp(cell.story);
    const base = { key: cell.key, kind: cell.kind, story: cell.story, id: cell.id, seed: cell.seed, ...(cell.arm ? { arm: cell.arm } : {}),
      references: cell.refs.length, ...(smoke ? { smoke } : {}) };
    const refs = referencesOf(run, cell);
    if ('out' in refs) {
      index.cells[cell.key] = { ...base, status: 'out', code: refs.out };
      run.save();
      log({ event: 'cell_out', key: cell.key, code: refs.out });
      continue;
    }
    // A cell begins only if it can end by `--until`, and that is asked again right before its job goes out, after the
    // uploads, the log and the socket, which may have taken the time it had (image-batch.ts `drawOne`'s `admit`).
    const fits = () => !comfy.end?.aborted && (!price || Date.now() + price(cell) <= run.until);
    if (!fits()) return 'until';
    try {
      let uploadMs = 0;
      const names: string[] = [];
      for (const one of refs.files) {
        const hash = sha256(one.bytes);
        let name = run.uploaded.get(hash);
        if (name === undefined) {
          const began = performance.now();
          name = await uploadReference(comfy, one.bytes);
          uploadMs += performance.now() - began;
          run.uploaded.set(hash, name);
        }
        names.push(name);
      }
      const canvas = canvasOf(cell.kind, run.front.canvas);
      const scaled = cell.kind !== 'frame' || !['C', 'V', 'T'].includes(cell.arm!) ? []
        : cell.refs.map((ref, at) => at + 1).filter(slot => !(cell.arm === 'T' && slot === 1));
      const built = cell.kind === 'front' ? { graph: run.front.graph, copies: [] as string[] } : actionGraph(run.base, scaled, smoke);
      const recipe = cell.kind === 'front' ? run.frontSampler : run.sampler;
      const filled = applyToWorkflow(built.graph, { checkpoint: run.checkpoint, prompt: cell.prompt, negative: '', seed: cell.seed, ...recipe, ...canvas,
        ...(cell.kind === 'front' ? {} : { references: names }) });
      // The graph as it goes out: every slot the file its plan names, in order, scaled where the doc says.
      const sent = sentSlots(filled);
      const slotsRight = sent.length === names.length && sent.every((slot, at) => slot.file === names[at] && slot.scaled === scaled.includes(at + 1));
      if (!slotsRight) throw Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
      const before = sealed ? undefined : await logLines(comfy);
      const drawn = await drawOne(comfy, filled, { pollMs: run.options.pollMs, waitMs: run.options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true,
        admit: fits, ...(built.copies.length ? { copies: built.copies } : {}) });
      // The picture is down, and it is kept whatever comes next, the end included: saved and recorded before anything
      // more is asked of the card, so that nothing drawn is lost or counted as never sent.
      await settled();
      const path = fileOf(run.root, cell);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const size = pngSize(drawn.bytes);
      const sizes = refs.files.map((one, at): [number, number] => {
        if (scaled.includes(at + 1)) return [SCALED.width, SCALED.height];
        const own = pngSize(one.bytes);
        return referenceGeometry(own.width, own.height, run.resolution);
      });
      const group = (one: CellRecord) => one.status === 'drawn' && (cell.kind === 'frame' ? one.arm === cell.arm : one.kind === cell.kind);
      const counted = run.tokens?.(cell.prompt, cell.kind === 'front' ? 0 : names.length, cell.kind === 'front');
      const record: CellRecord = { ...base, status: 'drawn', ...recipe, file: relative(run.root, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length,
        width: size.width, height: size.height, ...(names.length ? { referenceSizes: sizes } : {}), totalMs: drawn.totalMs, viewMs: drawn.viewMs,
        ...(uploadMs ? { uploadMs: Math.round(uploadMs) } : {}), first: !Object.values(index.cells).some(group), ...drawn.timing,
        vram: drawn.vram, vramSamples: drawn.memory.samples, ...(drawn.memory.ramMiB ? { ramMiB: drawn.memory.ramMiB } : {}),
        promptChars: cell.prompt.length, ...(counted ? { promptTokens: counted.prompt, conditioningTokens: counted.conditioning } : {}), slotsRight,
        ...(drawn.copies ? { copies: drawn.copies.map(copy => ({ node: copy.node, ...pngSize(copy.bytes) })) } : {}) };
      index.cells[cell.key] = record;
      run.save();
      log({ event: 'cell_drawn', key: cell.key, totalMs: drawn.totalMs, references: names.length, width: size.width, height: size.height });
      if (comfy.end?.aborted) return 'until';
      // The card's log after the job, for a clean story alone, once the picture is safe.
      const partialModelLoadEvents = sealed ? undefined : partialLoadsSince(before, await logLines(comfy));
      if (partialModelLoadEvents !== undefined) {
        record.partialModelLoadEvents = partialModelLoadEvents;
        run.save();
      }
    } catch (error) {
      const raw = (error as { code?: unknown }).code;
      const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
      const { httpStatus } = safeErrorDetails(error);
      const oom = (error as { oom?: unknown }).oom === true;
      // Whatever failed once the end had come was cut by it, and a job its time no longer covered was never sent:
      // neither is this cell's result.
      if (comfy.end?.aborted || raw === 'not_admitted') return 'until';
      index.cells[cell.key] = { ...base, status: 'failed', code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}) };
      run.save();
      log({ event: 'cell_failed', key: cell.key, code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}) });
      // The graph or the server, not this picture: the run stops, and a resume goes on after this cell.
      if (stopsTheRun(code)) { index.error = code; return 'stopped'; }
    }
  }
  return 'done';
}
