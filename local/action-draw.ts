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
import { CLEANUP_RESERVE_MS, RECORD_LIFE_MS, RIDES, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, charge, drawOne, encoderResolution, logCursor,
  logLines, partialLoadsAfter, pngSize, referenceGeometry, referenceSlots, ride, samplerSettingsOf, serverPins, settled, stageSocket,
  stopsTheRun, submitOnStage, textEncoderOf, transportCode, uploadReference } from './image-batch.ts';
import type { Comfy, Graph, LogCursor, Outage, Phases, StagedJob, StageSocket, Vram } from './image-batch.ts';
import { cardOf, pinsOf } from './image-identity.ts';
import { portraitCanvas } from './image-portraits.ts';
import { safeErrorDetails } from './model-error.ts';
import { qwenPromptTokens } from './tokenizer.ts';
import type { QwenTokenizer } from './tokenizer.ts';
import { Refusal } from './action-boundary.ts';
import { ARMS, isSharp, readJson, storyDir, textStories } from './action-text.ts';
import type { ActionArm } from './action-text.ts';
import { T_OPENING, VIEW_TURNS, readPlans } from './action-prompts.ts';
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
// A dropped connection (docs/action-experiment.md#dropped-connection): after the smoke a cell may lose up to eight
// minutes to the network, its waits and its failed requests together, and looks for the server every two seconds; in
// the smoke it looks once and does not wait. The window stays short of the ten minutes after which the card's sweeper
// deletes a finished job's record.
export const OUTAGE_MS = 8 * 60000, RIDE_PAUSE_MS = 2000;
// The codes a cell fails under (docs/action-experiment.md#sealed): local/image-batch.ts's for a picture, the graph
// and the server, and the harness's own. A code is one of them because it is in this list; any other is
// `image_failed`. `comfy_unreachable` and `comfy_socket_unavailable` are a cell that never reached the card, and are
// the stage's error rather than the cell's.
export const DRAW_CODES: readonly string[] = ['cancelled', 'out_of_time', 'image_timeout', 'image_failed', 'not_a_png', 'truncated_png',
  'comfy_http_error', 'comfy_rejected_prompt', 'comfy_upload_failed', 'comfy_socket_unavailable', 'comfy_stop_unconfirmed',
  'comfy_unreachable', 'comfy_connection_lost',
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

// `lost`: how many of the cell's jobs the network lost after their submit before this record's, each drawn again by a
// resume (`redraws`).
export type CellRecord = { key: string; kind: CellKind; story: string; id: string; seed: number; arm?: ActionArm;
  status: 'drawn' | 'failed' | 'out'; code?: string; httpStatus?: number; oom?: boolean; smoke?: boolean; lost?: number;
  steps?: number; sampler?: string; scheduler?: string; cfg?: number;
  file?: string; sha256?: string; bytes?: number; width?: number; height?: number; references: number; referenceSizes?: [number, number][];
  totalMs?: number; viewMs?: number; uploadMs?: number; outageMs?: number; loaderCacheMiss?: boolean; first?: boolean; phases?: Phases;
  vram?: Vram[]; vramSamples?: number; ramMiB?: { min: number; max: number }; partialModelLoadEvents?: number;
  promptChars?: number; promptTokens?: number; conditioningTokens?: number; slotsRight?: boolean;
  copies?: { node: string; width: number; height: number }[] };
export type SmokeVerdict = { pass: boolean; tOut: boolean; cells: number; drawn: boolean; geometry: boolean; slots: boolean;
  heard: boolean; memory: boolean; failing: string[] };
export type DrawIndex = { pins: Record<string, string | number>; startedAt: string; completedAt?: string; cells: Record<string, CellRecord>;
  smoke?: { keys: string[]; extraView?: string; verdict?: SmokeVerdict }; admitted?: Record<string, boolean>;
  admission?: { seed: number; cells: number; needMs: number; leftMs: number; admitted: boolean }[]; stopped?: 'until' | 'admission'; error?: string };

// A cell the network lost after its submit (`comfy_connection_lost`), which a resume draws again, as the owner decided
// on 2026-09-26 (docs/action-experiment.md#dropped-connection); every other outcome is kept.
export const redraws = (one: CellRecord) => one.status === 'failed' && one.code === 'comfy_connection_lost';

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

// `outage`: the window through a dropped connection after the smoke, and the pause between two looks (`OUTAGE_MS`);
// a test shortens both.
export type DrawStageOptions = { stage: 'smoke' | 'portraits' | 'main'; root: string; comfy: string; until: number;
  tokenizer?: QwenTokenizer; timeoutMs?: number; waitMs?: number; pollMs?: number; outage?: { windowMs?: number; pauseMs?: number };
  log?: (event: object) => void };
// `session`: the stage's one socket (image-batch.ts `stageSocket`), and `outage` the window each cell gets on it; with
// them the cells go in round two's order (`drawAhead`). Without them, as in the pilot's baseline, a cell opens a socket
// of its own, waits out nothing and is whole before the next, as round one did (`drawInTurn`). `cursor`: where the last
// clean job's read of the card's log at its over ended, and on which socket. `observe`: the pilot's ear.
type Run = { root: string; index: DrawIndex; save: () => void; comfy: Comfy; plans: Map<string, StoryPlan>; until: number;
  checkpoint: string; front: { graph: Graph; canvas: { width: number; height: number } }; base: Graph; resolution: number;
  sampler: { steps: number; sampler: string; scheduler: string; cfg: number }; frontSampler: { steps: number; sampler: string; scheduler: string; cfg: number };
  uploaded: Map<string, string>; tokens?: (prompt: string, images: number, front: boolean) => { prompt: number; conditioning: number } | undefined;
  options: DrawStageOptions; log: (event: object) => void; session?: StageSocket; outage?: { windowMs: number; pauseMs: number };
  cursor?: LogCursor & { epoch: number }; observe?: (cell: ActionCell, record: CellRecord, cached: string[] | undefined) => void };

// The server a stage talks to, and when it must stop: `end` at `--until`, and the reserve a minute after it for a job
// already submitted (image-batch.ts `Comfy`).
function stageComfy(options: { comfy: string; until: number; timeoutMs?: number }): Comfy {
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  return { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
}
function makeRun(options: DrawStageOptions, parts: { root: string; index: DrawIndex; comfy: Comfy; plans: Map<string, StoryPlan>; checkpoint: string;
  base: Graph; frontGraph: Graph }): Run {
  const { root, index, base, frontGraph } = parts;
  const encoder = textEncoderOf(base), frontEncoder = textEncoderOf(frontGraph);
  const tokenizer = options.tokenizer;
  return { root, index, save: () => writeJson(join(root, 'draw.json'), index), comfy: parts.comfy, plans: parts.plans, until: options.until,
    checkpoint: parts.checkpoint, front: { graph: frontGraph, canvas: portraitCanvas(frontGraph) }, base,
    resolution: Math.max(0, encoderResolution(base) ?? 0), sampler: settings(base), frontSampler: settings(frontGraph), uploaded: new Map(),
    tokens: tokenizer ? (prompt, images, isFront) => {
      const kind = isFront ? frontEncoder : encoder;
      return kind ? qwenPromptTokens(tokenizer, prompt, kind, { images }) : undefined;
    } : undefined, options, log: options.log ?? (() => undefined) };
}
// A cell's window: none in the smoke, which looks once and waits for nothing; after it `OUTAGE_MS`, and never as long
// as the ten minutes a finished job's record lives, less the reserve (image-batch.ts `RECORD_LIFE_MS`).
const windowOf = (asked: DrawStageOptions['outage'], smoke: boolean) => ({
  windowMs: smoke ? 0 : Math.min(Math.max(0, asked?.windowMs ?? OUTAGE_MS), RECORD_LIFE_MS - CLEANUP_RESERVE_MS),
  pauseMs: Math.max(1, asked?.pauseMs ?? RIDE_PAUSE_MS) });

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
// `plans` is the hash of the plan files as they were read for this stage (action-prompts.ts `readPlans`): a plan.json
// that changed after `prompts` is refused here, before anything is asked of the card.
function pinsFor(root: string, card: ReturnType<typeof cardOf>, base: Graph, plans: string): Record<string, string | number> {
  const texts = readJson<{ pins: Record<string, string | number> }>(join(root, 'texts.json'));
  const prompts = readJson<PromptsRecord>(join(root, 'prompts.json'));
  if (!texts || !prompts) throw new Refusal('The pictures are drawn from the texts and the prompts: run `texts` and `prompts` in this directory first');
  if (plans !== prompts.plans) {
    throw new Refusal('The plan files in this directory are not those prompts.json records: a plan.json changed after `prompts`, and nothing is drawn from it');
  }
  const cache = Object.values(base).find(node => node.class_type === 'QwenImage21Cache');
  const gateway = Object.fromEntries(Object.entries(texts.pins).filter(([key]) => key.startsWith('gateway')).map(([key, value]) => [`text.${key}`, value]));
  return { ...pinsOf(card), actionGraph: sha256(readFileSync(ACTION_GRAPH)), cacheDevice: String(cache?.inputs.device ?? 'none'),
    resolution: encoderResolution(base) ?? -1, canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, viewCanvas: `${VIEW_CANVAS.width}x${VIEW_CANVAS.height}`,
    referenceSize: `${SCALED.width}x${SCALED.height}`, seeds: ACTION_SEEDS.join(','), views: sha256(JSON.stringify(VIEW_TURNS)), t: sha256(T_OPENING),
    plans, texts: sha256(JSON.stringify(texts.pins)), textRoute: String(texts.pins.route), textWeights: String(texts.pins.weights), ...gateway };
}

export async function drawStage(options: DrawStageOptions): Promise<DrawIndex> {
  const root = resolve(options.root);
  const comfy = stageComfy(options);
  // Everything is read and checked before draw.json is written: a refused resume leaves it as it was. The card's
  // record and the server's pins are refused in the harness's own words (`Refusal`).
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(root, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${root} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says before anything is drawn`); }
  const base = readGraph(ACTION_GRAPH), frontGraph = readGraph(FRONT_GRAPH);
  const read = readPlans(root, textStories()), plans = read.plans;
  const own = pinsFor(root, card, base, read.hash);
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
  const run = makeRun(options, { root, index, comfy, plans, checkpoint: card.model, base, frontGraph });
  delete index.stopped;
  delete index.error;
  delete index.completedAt;
  const ordered = textStories().flatMap(story => plans.has(story.id) ? [plans.get(story.id)!] : []);
  // One socket for the whole stage (docs/action-experiment.md#one-socket), closed however the stage ends.
  run.session = stageSocket(options.comfy);
  run.outage = windowOf(options.outage, options.stage === 'smoke');
  try { return await stageCells(run, ordered); }
  finally { run.session.close(); }
}

async function stageCells(run: Run, ordered: StoryPlan[]): Promise<DrawIndex> {
  const { index, options, log } = run;
  if (options.stage === 'smoke') {
    const cells = smokeCells(ordered);
    const choice = smokeChoice(ordered);
    index.smoke = { keys: cells.map(cell => cell.key), ...(choice?.extraView ? { extraView: choice.extraView } : {}) };
    run.save();
    const ended = await drawCells(run, cells, true, () => (options.waitMs ?? WAIT_MS) + CELL_MS);
    const verdict = index.smoke.verdict = smokeVerdict(index, index.smoke.keys, run.front.canvas);
    // When T's cell alone failed, T leaves the run and the rest passes (docs/action-experiment.md#picture-smoke), a
    // failure of T's that stops a run included: T is the smoke's last cell, and every other one was drawn before it.
    // Not T's alone: the deadline; a stop the card did not confirm, which may leave T's job drawing; a T the network
    // kept from the card, which has no record, or lost on its way (`comfy_connection_lost`). Each fails the smoke.
    const tKey = cells.find(cell => cell.arm === 'T')?.key;
    const tAlone = verdict.tOut && ended === 'stopped' && tKey !== undefined && index.cells[tKey]?.status === 'failed'
      && index.error !== 'comfy_stop_unconfirmed' && index.error !== 'comfy_connection_lost';
    if (ended === 'until' || (ended === 'stopped' && !tAlone)) verdict.pass = false;
    if (tAlone) delete index.error;
    log({ event: 'smoke', ...verdict, failing: verdict.failing.length });
    return finish(run, tAlone ? 'done' : ended);
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
    const left = cells.filter(cell => !index.cells[cell.key] || redraws(index.cells[cell.key]));
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

// Where a reference of a cell was drawn: the key of its record, its kind, and the name its codes use.
function referenceOf(run: Run, cell: ActionCell, ref: string): { key: string; kind: CellKind; name: string } {
  const kind: CellKind = ref === 'L' ? 'frame' : run.plans.get(cell.story)?.views.some(view => view.id === ref) ? 'view' : 'front';
  return { key: ref === 'L' ? frameKey(cell.story, cell.seed, 'L') : `${kind}:${ref}`, kind, name: ref === 'L' ? 'l' : kind };
}

// The files a cell's slots send, each checked against the record of the cell that drew it: drawn, and the very file
// that was drawn, on its canvas. Anything else keeps the cell from the card with the code of what is missing.
function referencesOf(run: Run, cell: ActionCell): { files: { path: string; bytes: Buffer }[] } | { out: string } {
  const files: { path: string; bytes: Buffer }[] = [];
  for (const ref of cell.refs) {
    const { key, kind, name } = referenceOf(run, cell, ref);
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

// A reference is the same file under the same name however often it is sent (image-batch.ts `uploadReference`), so an
// upload the network cut is sent again once the server answers, within the cell's window. One that never gets through
// leaves the cell never sent (`comfy_unreachable`).
async function upload(comfy: Comfy, bytes: Uint8Array, outage: Outage | undefined): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const since = performance.now();
    try { return await uploadReference(comfy, bytes); } catch (error) {
      if (!outage || comfy.end?.aborted || !transportCode(error)) throw error;
      charge(outage, since);
      if (attempt >= RIDES || !(await ride(comfy, outage))) throw Object.assign(new Error('comfy_unreachable'), { code: 'comfy_unreachable' });
    }
  }
}

// A cell's record as it begins: which cell, how many references it sends, whether the smoke drew it, and how many of
// its jobs the network lost after their submit before this one (`lost`, docs/action-experiment.md#dropped-connection).
function recordBase(cell: ActionCell, smoke: boolean, known: CellRecord | undefined) {
  const lost = known && redraws(known) ? (known.lost ?? 0) + 1 : 0;
  return { key: cell.key, kind: cell.kind, story: cell.story, id: cell.id, seed: cell.seed, ...(cell.arm ? { arm: cell.arm } : {}),
    references: cell.refs.length, ...(smoke ? { smoke } : {}), ...(lost ? { lost } : {}) };
}
type Base = ReturnType<typeof recordBase>;
function markOut(run: Run, base: Base, code: string) {
  run.index.cells[base.key] = { ...base, status: 'out', code };
  run.save();
  run.log({ event: 'cell_out', key: base.key, code });
}

// A cell made ready for the card: its new references uploaded (`uploadMs`, less what the network took), the graph
// filled, and the graph as it goes out checked: every slot the file its plan names, in order, scaled where the doc
// says. `sizes`: the size each reference reaches the encoder at, for the record.
async function prepare(run: Run, cell: ActionCell, files: { path: string; bytes: Buffer }[], outage: Outage | undefined, smoke: boolean) {
  let uploadMs = 0;
  const names: string[] = [];
  for (const one of files) {
    const hash = sha256(one.bytes);
    let name = run.uploaded.get(hash);
    if (name === undefined) {
      const began = performance.now(), waited = outage?.spentMs ?? 0;
      name = await upload(run.comfy, one.bytes, outage);
      uploadMs += performance.now() - began - ((outage?.spentMs ?? 0) - waited);
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
  const sent = sentSlots(filled);
  const slotsRight = sent.length === names.length && sent.every((slot, at) => slot.file === names[at] && slot.scaled === scaled.includes(at + 1));
  if (!slotsRight) throw Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
  const sizes = files.map((one, at): [number, number] => {
    if (scaled.includes(at + 1)) return [SCALED.width, SCALED.height];
    const own = pngSize(one.bytes);
    return referenceGeometry(own.width, own.height, run.resolution);
  });
  return { names, uploadMs, recipe, filled, copies: built.copies, sizes };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
type Drawn = Awaited<ReturnType<typeof drawOne>>;

// A picture that is down, saved into its story's directory and recorded: it is kept whatever comes next, the end
// included, so that nothing drawn is lost or counted as never sent.
function keep(run: Run, cell: ActionCell, base: Base, prepared: Prepared, drawn: Drawn, outage: Outage | undefined, partialModelLoadEvents?: number) {
  const { index } = run;
  const path = fileOf(run.root, cell);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, drawn.bytes, { mode: 0o600 });
  const size = pngSize(drawn.bytes), names = prepared.names;
  const group = (one: CellRecord) => one.status === 'drawn' && (cell.kind === 'frame' ? one.arm === cell.arm : one.kind === cell.kind);
  const counted = run.tokens?.(cell.prompt, cell.kind === 'front' ? 0 : names.length, cell.kind === 'front');
  const record: CellRecord = { ...base, status: 'drawn', ...prepared.recipe, file: relative(run.root, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length,
    width: size.width, height: size.height, ...(names.length ? { referenceSizes: prepared.sizes } : {}), totalMs: drawn.totalMs, viewMs: drawn.viewMs,
    ...(prepared.uploadMs ? { uploadMs: Math.round(prepared.uploadMs) } : {}), ...(outage?.spentMs ? { outageMs: outage.spentMs } : {}),
    first: !Object.values(index.cells).some(group), ...drawn.timing,
    vram: drawn.vram, vramSamples: drawn.memory.samples, ...(drawn.memory.ramMiB ? { ramMiB: drawn.memory.ramMiB } : {}),
    promptChars: cell.prompt.length, ...(counted ? { promptTokens: counted.prompt, conditioningTokens: counted.conditioning } : {}), slotsRight: true,
    ...(drawn.copies ? { copies: drawn.copies.map(copy => ({ node: copy.node, ...pngSize(copy.bytes) })) } : {}),
    ...(partialModelLoadEvents === undefined ? {} : { partialModelLoadEvents }) };
  index.cells[cell.key] = record;
  run.save();
  run.log({ event: 'cell_drawn', key: cell.key, totalMs: drawn.totalMs, references: names.length, width: size.width, height: size.height });
  return record;
}

// What a cell's failure leaves. `until`, with no record: whatever failed once the end had come was cut by it, and a job
// its time no longer covered was never sent. `stopped`, with no record either: a cell that never reached the card, the
// network or its socket having stayed down for the whole window (docs/action-experiment.md#dropped-connection), for a
// resume to draw. Otherwise a failed record, and `stopped` when its code says the graph, the server or the network
// rather than this picture (`stopsTheRun`). `index.error` keeps the first code that stopped the stage.
function failure(run: Run, cell: ActionCell, base: Base, error: unknown, outage: Outage | undefined): 'until' | 'stopped' | undefined {
  const { index, comfy, log } = run;
  const raw = (error as { code?: unknown }).code;
  const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
  const { httpStatus } = safeErrorDetails(error);
  const oom = (error as { oom?: unknown }).oom === true;
  const waited = outage?.spentMs ? { outageMs: outage.spentMs } : {};
  if (comfy.end?.aborted || raw === 'not_admitted') return 'until';
  if (code === 'comfy_unreachable' || code === 'comfy_socket_unavailable') {
    index.error ??= code;
    run.save();
    log({ event: 'cell_unsent', key: cell.key, code, ...waited });
    return 'stopped';
  }
  index.cells[cell.key] = { ...base, status: 'failed', code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}), ...waited };
  run.save();
  log({ event: 'cell_failed', key: cell.key, code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}), ...waited });
  // The graph or the server, not this picture: the run stops, and a resume goes on after this cell, or draws it again
  // when the network lost it after its submit (`redraws`).
  if (!stopsTheRun(code)) return undefined;
  index.error ??= code;
  return 'stopped';
}

// The cells in order, each with its outcome at the end but those the end or a stop left for a resume. On the stage's
// one socket they go in round two's order (`drawAhead`); without it, as in the pilot's baseline, in round one's
// (`drawInTurn`).
async function drawCells(run: Run, cells: ActionCell[], smoke: boolean, price?: (cell: ActionCell) => number): Promise<'done' | 'until' | 'stopped'> {
  return run.session && run.outage ? drawAhead(run, cells, smoke, price) : drawInTurn(run, cells, smoke, price);
}

// Round one's order: each cell whole before the next is asked for, on a socket of its own; its picture saved and
// recorded before anything more is asked of the card, and the card's log read before and after each clean job.
async function drawInTurn(run: Run, cells: ActionCell[], smoke: boolean, price?: (cell: ActionCell) => number): Promise<'done' | 'until' | 'stopped'> {
  const { index, comfy } = run;
  for (const cell of cells) {
    // A cell with an outcome keeps it: drawn, out, or failed, a failure that stopped the run included; one the network
    // lost after its submit is drawn again (docs/action-experiment.md#dropped-connection).
    const known = index.cells[cell.key];
    if (known && !redraws(known)) continue;
    const sealed = isSharp(cell.story);
    const base = recordBase(cell, smoke, known);
    const refs = referencesOf(run, cell);
    if ('out' in refs) {
      markOut(run, base, refs.out);
      continue;
    }
    // A cell begins only if it can end by `--until`, and that is asked again right before its job goes out, after the
    // uploads, the log and the socket, which may have taken the time it had (image-batch.ts `drawOne`'s `admit`).
    const fits = () => !comfy.end?.aborted && (!price || Date.now() + price(cell) <= run.until);
    if (!fits()) return 'until';
    try {
      const prepared = await prepare(run, cell, refs.files, undefined, smoke);
      const before = sealed ? undefined : logCursor(await logLines(comfy));
      const drawn = await drawOne(comfy, prepared.filled, { pollMs: run.options.pollMs, waitMs: run.options.waitMs ?? WAIT_MS, sampleEvery: 1,
        requireSocket: true, admit: fits, ...(prepared.copies.length ? { copies: prepared.copies } : {}) });
      await settled();
      const record = keep(run, cell, base, prepared, drawn, undefined);
      if (comfy.end?.aborted) return 'until';
      // The card's log after the job, for a clean story alone, once the picture is safe.
      if (!sealed) {
        const partialModelLoadEvents = partialLoadsAfter(before, await logLines(comfy));
        if (partialModelLoadEvents !== undefined) {
          record.partialModelLoadEvents = partialModelLoadEvents;
          run.save();
        }
      }
      run.observe?.(cell, record, drawn.cached);
    } catch (error) {
      const ended = failure(run, cell, base, error, undefined);
      if (ended) return ended;
    }
  }
  return 'done';
}

// A cell whose job went out, until it has its outcome: `handover` once the job is over, its last sample of video
// memory and the card's log taken and its picture on its way down, or its failure recorded; `done` once the cell has
// its outcome.
type Aloft = { handover: () => Promise<void>; done: () => Promise<void> };

// Round two's order (docs/action-experiment.md#pipeline), on the stage's one socket. While a job draws, the next cell
// is made ready: its references checked, its new ones uploaded, its graph filled. When the socket says the job is
// over, its last sample of video memory and, for a clean story, the card's log after it are taken in one wait, and the
// next job goes out at once; the picture before it comes down, is saved and recorded while the next one draws. Nothing
// goes out before the job ahead of it is over, so the card never holds two of ours, and a cell one of whose references
// is still on its way down waits for it. Whatever ends the loop, a job that went out is followed to its end, and each
// outcome is recorded after those of the cells before it.
async function drawAhead(run: Run, cells: ActionCell[], smoke: boolean, price?: (cell: ActionCell) => number): Promise<'done' | 'until' | 'stopped'> {
  const { index, comfy } = run;
  const socket = run.session!;
  // What ended the stage, the first to say so: a cell's outcome may be recorded while the next job draws. `fault`: an
  // outcome that could not be recorded at all, such as a disk that refuses the write, which ends the stage as it
  // always did, thrown once every job that went out is followed to its end.
  let ending: 'until' | 'stopped' | undefined, fault: { error: unknown } | undefined;
  const end = (why: 'until' | 'stopped' | undefined) => { ending ??= why; };
  const broke = (error: unknown) => {
    fault ??= { error };
    end('stopped');
  };
  // The cells whose job went out, by key, and the last of them.
  const aloft = new Map<string, Aloft>();
  let last: Aloft | undefined;
  try {
    for (const cell of cells) {
      if (ending) break;
      // A cell with an outcome keeps it, as in `drawInTurn`; one the network lost after its submit is drawn again.
      const known = index.cells[cell.key];
      if (known && !redraws(known)) continue;
      // A reference still on its way down is waited for, its record with it.
      for (const ref of cell.refs) await aloft.get(referenceOf(run, cell, ref).key)?.done();
      if (ending) break;
      const base = recordBase(cell, smoke, known);
      const refs = referencesOf(run, cell);
      if ('out' in refs) {
        markOut(run, base, refs.out);
        continue;
      }
      // As in `drawInTurn`, asked before the cell begins and again right before its job goes out; the job ahead's
      // outcome comes first, as it did when each cell was whole before the next.
      const fits = () => !comfy.end?.aborted && (!price || Date.now() + price(cell) <= run.until);
      if (!fits()) {
        await last?.done();
        end('until');
        break;
      }
      // The cell's own window through a dropped connection, its uploads' included; `outageMs` in its record.
      const outage: Outage = { ...run.outage!, spentMs: 0 };
      const sealed = isSharp(cell.story);
      let prepared: Prepared, before: LogCursor | undefined, job: StagedJob;
      try {
        prepared = await prepare(run, cell, refs.files, outage, smoke);
        // The job ahead: over, its last sample and its log taken.
        await last?.handover();
        if (ending) break;
        // Where the card's log stood before the job, for a clean story: where the clean job ahead's read at its over
        // ended, while the stage's socket has stayed the one it was then, and otherwise a read now, the job ahead being
        // over. A failure, a sealed cell and a socket that closed drop that place, as the server's does when it starts
        // again.
        before = sealed ? undefined : run.cursor && socket.open && run.cursor.epoch === socket.epoch ? run.cursor : logCursor(await logLines(comfy));
        // The last word before the submit is asked as late as ever: a stage the job ahead's outcome ended meanwhile sends
        // nothing.
        job = await submitOnStage(comfy, prepared.filled, { pollMs: run.options.pollMs, waitMs: run.options.waitMs ?? WAIT_MS, sampleEvery: 1,
          requireSocket: true, admit: () => !ending && fits(), ...(prepared.copies.length ? { copies: prepared.copies } : {}) }, { socket, outage });
      } catch (error) {
        await last?.done();
        run.cursor = undefined;
        end(failure(run, cell, base, error, outage));
        continue;
      }
      last = launch(run, { cell, base, prepared, job, outage, before, sealed, prior: last, end, broke });
      aloft.set(cell.key, last);
    }
  } finally {
    await last?.done();
  }
  if (fault) throw fault.error;
  return ending ?? 'done';
}

// A job that went out, followed from its submit to its cell's outcome (`Aloft`) while the next cell is made ready and
// drawn. `prior` is the cell whose job went out before it, whose outcome is recorded first; `end` says what ended the
// stage, and `broke` takes an outcome that could not be recorded, so that neither half ever rejects.
function launch(run: Run, one: { cell: ActionCell; base: Base; prepared: Prepared; job: StagedJob; outage: Outage; before: LogCursor | undefined;
  sealed: boolean; prior: Aloft | undefined; end: (why: 'until' | 'stopped' | undefined) => void; broke: (error: unknown) => void }): Aloft {
  const { cell, base, prepared, job, outage, before, sealed, end, broke } = one;
  let prior = one.prior;
  const first = async () => {
    await prior?.done();
    prior = undefined;
  };
  let flight: Promise<void> = Promise.resolve();
  const handed = (async () => {
    try { await job.untilOver(); } catch (error) {
      run.cursor = undefined;
      await first();
      end(failure(run, cell, base, error, outage));
      return;
    }
    // At the over, in one wait: the job's last sample, and for a clean story the card's log, whose end stands for the
    // next clean job's start. Neither throws: a read that fails reads as nothing.
    const [, after] = await Promise.all([job.lastSample(), sealed ? undefined : logLines(run.comfy)]);
    const reached = sealed ? undefined : logCursor(after);
    run.cursor = reached && { ...reached, epoch: run.session!.epoch };
    const partialModelLoadEvents = sealed ? undefined : partialLoadsAfter(before, after);
    // The picture comes down while the next job draws, and is recorded after the cell before it.
    flight = (async () => {
      try {
        const drawn = await job.fetch();
        await first();
        const record = keep(run, cell, base, prepared, drawn, outage, partialModelLoadEvents);
        if (run.comfy.end?.aborted) end('until');
        run.observe?.(cell, record, drawn.cached);
      } catch (error) {
        await first();
        end(failure(run, cell, base, error, outage));
      }
    })().catch(broke);
  })().catch(broke);
  return { handover: () => handed, done: async () => { await handed; await flight; } };
}

// ---- The pilot (local/image-pilot.ts, docs/action-experiment.md#pilot) ----

// Clean cells drawn as a stage draws them, into a directory of their own: `seeded` are the records the references are
// read from (round one's, each file relative to `root`). `roundTwo` draws as round two will, on the stage's one socket
// with its window, each job sent as soon as the one before it is over (`drawAhead`); otherwise each cell is whole
// before the next, on a socket of its own and with no window, as round one did (`drawInTurn`). `observe` hears each
// cell once it is saved and recorded, in the cells' order, with the nodes the server answered from its cache. The
// pilot checks the card first.
export type PilotOptions = { root: string; comfy: string; until: number; checkpoint: string; pins: Record<string, string | number>;
  plans: StoryPlan[]; cells: ActionCell[]; seeded: Record<string, CellRecord>; roundTwo: boolean; timeoutMs?: number; waitMs?: number;
  pollMs?: number; outage?: { windowMs?: number; pauseMs?: number }; log?: (event: object) => void;
  observe?: (cell: ActionCell, record: CellRecord, cached: string[] | undefined) => void };
export async function drawPilot(options: PilotOptions): Promise<{ index: DrawIndex; ended: 'done' | 'until' | 'stopped' }> {
  const root = resolve(options.root);
  if (options.cells.some(cell => isSharp(cell.story) || storyDir(root, cell.story).split(/[\\/]/).includes('sealed'))) {
    throw new Refusal('The pilot draws clean cells alone');
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const index: DrawIndex = { pins: options.pins, startedAt: new Date().toISOString(), cells: { ...options.seeded } };
  const run = makeRun({ stage: 'main', root, comfy: options.comfy, until: options.until, timeoutMs: options.timeoutMs, waitMs: options.waitMs,
    pollMs: options.pollMs, log: options.log }, { root, index, comfy: stageComfy(options), plans: new Map(options.plans.map(plan => [plan.id, plan])),
    checkpoint: options.checkpoint, base: readGraph(ACTION_GRAPH), frontGraph: readGraph(FRONT_GRAPH) });
  run.observe = options.observe;
  if (options.roundTwo) {
    run.session = stageSocket(options.comfy);
    run.outage = windowOf(options.outage, false);
  }
  try {
    const ended = await drawCells(run, options.cells, false);
    await settled();
    index.completedAt = new Date().toISOString();
    run.save();
    return { index, ended };
  } finally { run.session?.close(); }
}
