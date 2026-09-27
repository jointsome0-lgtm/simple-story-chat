// The body test (docs/action-experiment.md#body-test), for the picture card after round two's draw. Of the head test's
// variants, p-crop-080 alone moved the faces and hair of round one's A+ toward the portraits and still fitted every
// body in the blind judgment of 2026-09-27; the owner cares more for the silhouette, the height, the build and the
// proportions, and for the action, than for the face.
// Here each bound person's whole body is cut out of A+, enlarged, redrawn with that person's full-length front as image
// 1, and pasted back: does the front's build come through while A+'s action, its contacts and the scene's clothes stay?
// All else is p-crop's: seed 7, the action graph's model, encoder, VAE and 25 steps of euler/simple at CFG 1, the start
// latent from A+'s crop under a noise mask, and the paste into A+'s own pixels. Each body is drawn
//   front-065, front-080  with round one's front of the person, which wore the white tank top and grey trousers, at
//                         denoise 0.65 and 0.80;
//   suit-080              for the demon's and the flight's eight, with the T probe's suit front of the same person
//                         (illustrations/t-probe/suit), at 0.80: does the suit leak into the scene's clothes?
// The crop. The body's region is bodies.json's box with BODY_MARGIN a side, out to the latent's 16-pixel grid. It is
// held by the most upright of four canvases whose crop fits in the frame: 576x1024 (the front's own 9:16), 672x896,
// 896x896, 1024x768. The crop has the canvas's shape to within half a pixel, and is centred on the body and moved
// inside the frame. It is scaled bicubic to the canvas, so every body gains 1.09 to 2.25 times its pixels a side, the
// most where it is smallest. Upright first because the front is 9:16. At 576x1024 it lies on a 9:16 canvas cell for
// cell, as p-crop's portrait square lay on its square, since the encoder centres a reference on the canvas at the same
// scale. A fighter on his back, a giant or a couple in a dip is wider than 9:16 allows in the frame's 704 pixels, and
// takes the next shape that holds it. The front goes whole, area-scaled to 576x1024 for every body: the same size
// everywhere, and never stretched to a canvas, so that the build it shows is its own.
// The masks. The noise mask is the region on the canvas less every other bound person's head, and less the flight's
// fifth person, the child round one does not bind: the probe's A+ head boxes, to the canvas's grid, so that every face
// but the person's own stays A+'s. The paste goes into A+'s own pixels through the region feathered EDGE_FEATHER px
// inward, none at the frame's edge, and away from those heads by KEEP_FEATHER. Outside the region the picture is A+
// pixel for pixel. The other people's bodies inside the region are redrawn with it: their hands, arms and legs are
// where the contacts are, and holding them out would hold the body's outline too.
// The prompt: "The person from image 1, <the person's own clause of round one's A+ without its look>. <round one's
// style line>". The role, the facing, the scene's clothes and the action are A+'s own words, begun as round one's C
// begins a bound person. The look is left to the front, so that no words draw the build A+ drew.
// The commands read illustrations/action-1/clean, the probe's boxes.json, probe.json and suit/, and the head test's
// heads.json for its times; they write illustrations/t-probe-bodies alone, where bodies.json lies. Only `dry-run`
// takes another --dir:
//   estimate  the jobs and their minutes, from the head test's times, before a card is rented
//   plan      plan.png: each body's region, crop and masks over A+, and its front; needs ImageMagick's convert
//   draw      on the picture card, --until EPOCH: every body's two fronts, then the suit's eight, a body's jobs begun
//             only if all of them can end by --until
//   page      index.html: each body's crop of A+ beside its redraws and its front, then the whole frames; `draw` also
//             writes it after every body
//   dry-run   all of it against local/fake-comfy.ts, from a made-up round one with a sealed story beside it
// What it prints is ids, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { ACTION_SEEDS, ACTION_STORIES, MARKER_STORY } from '../examples/action-set.ts';
import { CLEANUP_RESERVE_MS, SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, comfyUrl, drawOne, logLines, partialLoadsSince, pngSize,
  samplerSettingsOf, serverPins, settled, stopsTheRun, stripPngMetadata, uploadReference } from './image-batch.ts';
import type { Comfy, Graph, Phases } from './image-batch.ts';
import { ACTION_GRAPH, CELL_MS, DRAW_CODES, FRAME_CANVAS, MARGIN, WAIT_MS, actionGraph, fileOf, frameKey } from './action-draw.ts';
import type { DrawIndex } from './action-draw.ts';
import { FACE_OPENING, PROBE_DIR, PROBE_SCENES, SOURCE_DIR, SUIT_SCENES, VARIANTS, facePrompt, readBoxes, regionOf, sceneOf, startFrom } from './image-t-probe.ts';
import type { Box, Boxes, Region, Scene } from './image-t-probe.ts';
import { T_OPENING, tClause } from './action-prompts.ts';
import type { StoryPlan } from './action-prompts.ts';
import { cardOf, pinsOf, writeCardRecord } from './image-identity.ts';
import { kitchenOf } from './image-pilot.ts';
import { isSharp, readJson, storyDir } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchBoundary, searchTree } from './action-boundary.ts';
import { escapeHtml } from './action-judge.ts';
import { safeError } from './image-action.ts';
import { safeErrorDetails } from './model-error.ts';
import { greyPng, startFakeComfy } from './fake-comfy.ts';
import type { FakeJob, MaskSummary } from './fake-comfy.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'illustrations', 't-probe-bodies');
const HEADS_DIR = join(ROOT, 'illustrations', 't-probe-heads');
// The six scenes of the T probe, whose bound people bodies.json boxes on A+, and whose A+, fronts and head boxes the
// probe checked; the demon and the flight have suit fronts.
const BODY_SCENES = PROBE_SCENES;
// bodies.json, marked by eye on round one's A+ on 2026-09-27 before any card: for each scene, by the id of each bound
// person's front, a rectangle [left, top, right, bottom) round that person's whole figure, hands, feet, hair and hat, in
// the frame's pixels. The file's hash is pinned here and in redraws.json, so that nothing changes it unseen.
//   { "canvas": "1280x704", "A+": { "flight": { "flight-e1": [330, 58, 800, 704], ... }, ... } }
const BODIES_FILE = 'bodies.json';
const BODIES_SHA256 = 'fc49ff0fcc37f65355918de6c58898e26df2bfb53fc10088121d1bbed357ec97';
const SEED = ACTION_SEEDS[0], RECIPE = { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1 };
// The latent's grid (Qwen Image 2.1's 16 pixels a latent), the region's margin round a body, the paste's feather at
// the region's edge and round a head kept, as in the probe's masks on L (image-t-probe.ts MASK_FEATHER) and the head
// test's round what it kept.
const GRID = 16, BODY_MARGIN = 32, EDGE_FEATHER = 24, KEEP_FEATHER = 8;
type Size = { width: number; height: number };
type Shape = { id: string; canvas: Size };
// The canvases, the most upright first, each a multiple of 32 a side as the encoder takes a picture, and near the
// head test's 768x768 in pixels.
const SHAPES: Shape[] = [{ id: '9:16', canvas: { width: 576, height: 1024 } }, { id: '3:4', canvas: { width: 672, height: 896 } },
  { id: '1:1', canvas: { width: 896, height: 896 } }, { id: '4:3', canvas: { width: 1024, height: 768 } }];
const FRONT_SIZE = { width: 576, height: 1024 };
type Rect = [number, number, number, number];
// The flight's fifth person, the child round one does not bind: her head and raised hand on A+, inside the father's
// region and the mother's.
const UNBOUND_HEADS: Record<string, Rect[]> = { flight: [[414, 98, 536, 202]] };
// The first job of a run pays Triton's compile, and the first job of each other canvas a compile of its own: the head
// test's first took 33 s against 10 s warm, and a new shape 3 s more. A job is priced at a minute where the head test
// left no time. A socket that did not open is waited out this long, once.
const COLD_MS = 45000, SHAPE_MS = 15000, FALLBACK_MS = 60000, RETRY_PAUSE_MS = 3000;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const minutes = (ms: number) => Math.round(ms / 6000) / 10;
const seconds = (ms: number | undefined) => (ms === undefined ? 'нет' : String(Math.round(ms / 100) / 10).replace('.', ','));
const idOf = (link: unknown) => (Array.isArray(link) ? String(link[0]) : undefined);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return !sorted.length ? undefined : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const workflowError = () => Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });

// ---- The variants ----

// `image`: which front is image 1. The fronts' jobs come first, every body's, then the suit's.
type BodyVariant = { id: 'front-065' | 'front-080' | 'suit-080'; image: 'front' | 'suit'; denoise: number; caption: string };
const BODY_VARIANTS: BodyVariant[] = [
  { id: 'front-065', image: 'front', denoise: 0.65, caption: 'фронт раунда 1, denoise 0,65' },
  { id: 'front-080', image: 'front', denoise: 0.8, caption: 'фронт раунда 1, denoise 0,8' },
  { id: 'suit-080', image: 'suit', denoise: 0.8, caption: 'фронт в костюме, denoise 0,8' },
];
const FACE_EACH = VARIANTS.find(one => one.id === 'face-each')!;
const cellKey = (body: string, variant: string) => `${body}:${variant}`;

// ---- Round one ----

type Input = Scene['aPlus'];
// A story the test may read: a clean scene of the action set, as the probe's rule (image-t-probe.ts `cleanId`).
function cleanId(id: string) {
  if (isSharp(id) || id === MARKER_STORY.id || !ACTION_STORIES.some(story => story.id === id)) {
    throw new Refusal(`${id} is not a clean scene of the action set: the test draws round one's clean scenes alone and reads nothing of a sealed one`);
  }
}
const noLink = (path: string) => {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${path} is a link: nothing is read through it`);
};

// Each bound person's words, read back from round one's own L, C and A+. C is L with "The person from image N" and ", "
// or ": " at the head of each bound person's clause (action-prompts.ts `variantPrompt`), and A+ is L with the person's
// look and the same joint there. The clause runs to its first ". ". Unless C gives L back with one head for each slot
// from 1, and L with each look put back gives A+ byte for byte, nothing is read.
type Words = { joint: string; clause: string };
function clausesOf(l: string, c: string, aPlus: string, bound: number): Words[] | undefined {
  const heads = new Map<number, { at: number; joint: string }>();
  let rest = '', last = 0;
  for (const match of c.matchAll(/The person from image (\d+)(, |: )/g)) {
    rest += c.slice(last, match.index);
    last = match.index + match[0].length;
    if (heads.has(Number(match[1]))) return undefined;
    heads.set(Number(match[1]), { at: rest.length, joint: match[2] });
  }
  rest += c.slice(last);
  const slots = Array.from({ length: bound }, (_, at) => heads.get(at + 1));
  if (bound < 1 || rest !== l || heads.size !== bound || slots.some(one => !one)) return undefined;
  const words = slots.map(one => {
    const end = l.indexOf('. ', one!.at);
    return end > one!.at ? { joint: one!.joint, clause: l.slice(one!.at, end) } : undefined;
  });
  if (words.some(one => !one)) return undefined;
  const order = slots.map((one, slot) => ({ ...one!, slot })).sort((a, b) => a.at - b.at);
  let cursor = 0, from = 0;
  for (const one of order) {
    const plain = l.slice(from, one.at), own = `${one.joint}${words[one.slot]!.clause}. `;
    if (!aPlus.startsWith(plain, cursor)) return undefined;
    cursor += plain.length;
    const found = aPlus.indexOf(own, cursor);
    if (found <= cursor || aPlus.slice(cursor, found).includes('. ')) return undefined;
    cursor = found + one.joint.length;
    from = one.at;
  }
  return aPlus.slice(cursor) === l.slice(from) ? words as Words[] : undefined;
}
const promptOf = (words: Words, style: string) => `The person from image 1${words.joint}${words.clause}. ${style}`;
// Round one's style line, the probe's, which it does not export: what its face prompt has after its clauses.
function styleLine(): string {
  const face = facePrompt([{ role: 'ROLE', image: 2 }]), before = `${FACE_OPENING} ${tClause('ROLE', 2)}. `;
  const style = face.startsWith(before) ? face.slice(before.length) : '';
  if (!style.startsWith('Hand-painted') || !style.endsWith('.')) throw new Refusal('The probe\'s face prompt no longer ends in round one\'s style line: nothing is drawn');
  return style;
}

// bodies.json, read as the probe reads boxes.json: a link, a sealed id, a box off the frame and a file other than the
// one pinned are refused.
type Bodies = { hash: string; boxes: Record<string, Record<string, Box>> };
function readBodies(out: string, pinned: string): Bodies {
  const file = join(resolve(out), BODIES_FILE);
  noLink(file);
  if (!existsSync(file)) throw new Refusal(`${file} is missing: the bodies are marked before the card, and nothing is drawn`);
  const bytes = readFileSync(file), bad = (why: string) => new Refusal(`${file} ${why}; nothing is drawn from it`);
  if (sha256(bytes) !== pinned) throw bad('is not the file marked before the card, whose sha256 image-body-test.ts pins');
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  let read: unknown;
  try { read = JSON.parse(bytes.toString('utf8')); } catch { throw bad('is not JSON'); }
  if (!object(read) || read.canvas !== `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}` || !object(read['A+'])) throw bad('is not the bodies on A+ by scene on its canvas');
  const boxes = Object.fromEntries(Object.entries(read['A+']).map(([id, people]) => {
    cleanId(id);
    if (!object(people)) throw bad(`has no bodies for ${id}`);
    return [id, Object.fromEntries(Object.entries(people).map(([front, value]) => {
      const [left, top, right, bottom] = Array.isArray(value) ? value : [];
      if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger) || left < 0 || top < 0 || right > FRAME_CANVAS.width
        || bottom > FRAME_CANVAS.height || left >= right || top >= bottom) {
        throw bad(`has a body of ${front} that is not [left, top, right, bottom) on the frame`);
      }
      return [front, [left, top, right, bottom] as Box];
    }))];
  }));
  return { hash: sha256(bytes), boxes };
}

// The T probe's suit fronts of a scene's people, as its probe.json records them: drawn, in its suit/, the very bytes,
// on the fronts' canvas.
type SuitRecord = { suit?: { cells?: Record<string, { status?: string; file?: string; sha256?: string }> } };
function suitFrontsOf(probe: string, scene: Scene): Input[] {
  const record = readJson<SuitRecord>(join(probe, 'probe.json'));
  noLink(join(probe, 'suit'));
  return scene.fronts.map(front => {
    const cell = record?.suit?.cells?.[`front:${front}`], file = join('suit', `${front}.png`), path = join(probe, file);
    noLink(path);
    const bytes = cell?.status === 'drawn' && cell.file === file && existsSync(path) ? readFileSync(path) : undefined;
    const size = bytes ? pngSize(bytes) : undefined;
    if (!bytes || sha256(bytes) !== cell?.sha256 || size?.width !== scene.portraitCanvas.width || size.height !== scene.portraitCanvas.height) {
      throw new Refusal(`The suit front of ${front} is not the picture the probe's probe.json records, where it records it: nothing is drawn`);
    }
    return { file, bytes, sha256: cell.sha256 };
  });
}

// ---- The geometry ----

type Crop = { x: number; y: number; width: number; height: number };
const rectOf = (one: { x: number; y: number; width: number; height: number }): Rect => [one.x, one.y, one.x + one.width, one.y + one.height];
const sizeOf = ([left, top, right, bottom]: Rect): Size => ({ width: right - left, height: bottom - top });
const meet = (a: Rect, b: Rect): Rect | undefined => {
  const out: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return out[0] < out[2] && out[1] < out[3] ? out : undefined;
};
const holds = (outer: Rect, inner: Rect) => outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
// Out to the latent's grid and kept on the canvas, as the probe's regions are; and to the nearest line of the grid.
const snapOut = ([left, top, right, bottom]: Rect, canvas: Size): Rect => [Math.max(0, Math.floor(left / GRID) * GRID), Math.max(0, Math.floor(top / GRID) * GRID),
  Math.min(canvas.width, Math.ceil(right / GRID) * GRID), Math.min(canvas.height, Math.ceil(bottom / GRID) * GRID)];
const snapNear = (rect: Rect): Rect => rect.map(side => Math.round(side / GRID) * GRID) as Rect;
// The crop a canvas takes round a region: the region's height, or more where its width asks for it, and the canvas's
// shape to within half a pixel.
function cropSize(region: Rect, canvas: Size): Size {
  const { width, height } = sizeOf(region), tall = Math.max(height, Math.ceil(width * canvas.height / canvas.width));
  return { width: Math.round(tall * canvas.width / canvas.height), height: tall };
}
// Where a crop of `side` lies on one axis: centred on the body, moved, never stretched, until it holds the region and
// lies in the frame.
function place(centre: number, low: number, high: number, extent: number, side: number) {
  const least = Math.max(0, high - side), most = Math.min(extent - side, low);
  if (least > most) throw new Refusal('A body\'s region does not fit its crop inside the frame: nothing is drawn');
  return Math.min(Math.max(Math.round(centre - side / 2), least), most);
}
// One body as it is drawn. `region`: round bodies.json's box. `kept`: the other bound people's heads and an unbound
// person's, cut to the region, which the paste keeps pixel for pixel; `holes` the same on the canvas to the nearest
// line of its grid, where the sampler keeps them. `crop` in frame pixels on `shape`'s canvas, and `cropRegion` the
// region there, out to its grid. `front` and `suit` in their records' directories; `words` the person's clause.
type Body = { id: string; scene: Scene; slot: number; box: Box; head: Box; region: Region; kept: Rect[]; shape: Shape; crop: Crop; gain: number;
  cropRegion: Rect; holes: Rect[]; front: Input; suit?: Input; words: Words };
function bodyOf(scene: Scene, slot: number, box: Box, heads: Record<string, Box>, words: Words, suit?: Input): Body {
  const id = scene.fronts[slot - 1], head = heads[id];
  if (!holds(box, head)) throw new Refusal(`The body of ${id} in bodies.json does not hold its head in the probe's boxes.json: nothing is drawn`);
  const region = regionOf(box, BODY_MARGIN, EDGE_FEATHER), frame = rectOf(region);
  const keep = [...scene.fronts.filter(other => other !== id).map(other => heads[other]), ...(UNBOUND_HEADS[scene.id] ?? [])];
  const kept = keep.map(rect => meet(rect, frame)).filter((rect): rect is Rect => rect !== undefined);
  const fit = SHAPES.map(shape => ({ shape, size: cropSize(frame, shape.canvas) }))
    .find(one => one.size.width <= FRAME_CANVAS.width && one.size.height <= FRAME_CANVAS.height);
  if (!fit) throw new Refusal(`No canvas holds the region of ${id} in a crop inside the frame: nothing is drawn`);
  const { shape, size } = fit, canvas = shape.canvas;
  const crop = { x: place((box[0] + box[2]) / 2, frame[0], frame[2], FRAME_CANVAS.width, size.width),
    y: place((box[1] + box[3]) / 2, frame[1], frame[3], FRAME_CANVAS.height, size.height), ...size };
  // Multiplied before it is divided, so that a side that falls on a whole pixel stays whole.
  const inCrop = ([left, top, right, bottom]: Rect): Rect => [(left - crop.x) * canvas.width / crop.width, (top - crop.y) * canvas.height / crop.height,
    (right - crop.x) * canvas.width / crop.width, (bottom - crop.y) * canvas.height / crop.height];
  const cropRegion = snapOut(inCrop(frame), canvas);
  const holes = kept.map(rect => meet(snapNear(inCrop(rect)), cropRegion)).filter((rect): rect is Rect => rect !== undefined);
  return { id, scene, slot, box, head, region, kept, shape, crop, gain: canvas.height / crop.height, cropRegion, holes, front: scene.portraits[slot - 1],
    ...(suit ? { suit } : {}), words };
}

// A mask as the graph makes it, from an empty canvas (SolidMask 0): each step a SolidMask 1 of its rectangle's size,
// through a FeatherMask where it has one, added or subtracted at its place (MaskComposite, which clamps to [0, 1]).
type Feather = Region['feather'];
type Op = { op: 'add' | 'subtract'; rect: Rect; feather?: Feather };
type Chain = { canvas: Size; ops: Op[] };
// A job's two masks. The noise mask, on the canvas: the region, less each hole. The paste's, on the crop at its own
// size: the region feathered inward, less each head kept brought out by KEEP_FEATHER and feathered, so that it is 0 on
// all that is kept and outside the region. `at`: where the crop lies in A+.
function masksOf(b: Body): { noise: Chain; paste: Chain; at: { x: number; y: number } } {
  const size = { width: b.crop.width, height: b.crop.height };
  const local = ([left, top, right, bottom]: Rect): Rect => [left - b.crop.x, top - b.crop.y, right - b.crop.x, bottom - b.crop.y];
  const around = ([left, top, right, bottom]: Rect): Op => ({ op: 'subtract',
    rect: [Math.max(0, left - KEEP_FEATHER), Math.max(0, top - KEEP_FEATHER), Math.min(size.width, right + KEEP_FEATHER), Math.min(size.height, bottom + KEEP_FEATHER)],
    feather: { left: left >= KEEP_FEATHER ? KEEP_FEATHER : 0, top: top >= KEEP_FEATHER ? KEEP_FEATHER : 0,
      right: right + KEEP_FEATHER <= size.width ? KEEP_FEATHER : 0, bottom: bottom + KEEP_FEATHER <= size.height ? KEEP_FEATHER : 0 } });
  return { noise: { canvas: b.shape.canvas, ops: [{ op: 'add', rect: b.cropRegion }, ...b.holes.map((rect): Op => ({ op: 'subtract', rect }))] },
    paste: { canvas: size, ops: [{ op: 'add', rect: local(rectOf(b.region)), feather: b.region.feather }, ...b.kept.map(rect => around(local(rect)))] },
    at: { x: b.crop.x, y: b.crop.y } };
}

// ---- What is drawn from ----

type Dirs = { source: string; probe: string; heads: string; out: string };
const LIVE: Dirs = { source: SOURCE_DIR, probe: PROBE_DIR, heads: HEADS_DIR, out: OUT_DIR };
type Inputs = { base: Graph; recipe: typeof RECIPE; round: DrawIndex; boxes: Boxes; bodiesHash: string; scenes: Scene[]; bodies: Body[]; style: string;
  prices: { price: number; expected: number; from: number } };
type HeadsRecord = { cells?: Record<string, { status?: string; totalMs?: number; uploadMs?: number; cold?: boolean; firstOfShape?: boolean;
  loaderCacheMiss?: boolean }> };
// A job's price: the slowest warm job of the head test, on its Triton server, a quarter more and three seconds, as the
// harness prices (action-draw.ts `pricing`); expected, their median. Its slowest is a p-native job, a 1280x704 canvas
// and a 768x768 portrait, which is more for the sampler than any job here (a canvas of 896x896 at most and the front
// at 576x1024).
function pricesOf(dir: string) {
  const record = readJson<HeadsRecord>(join(dir, 'heads.json'));
  const times = Object.values(record?.cells ?? {}).filter(one => one.status === 'drawn' && one.totalMs !== undefined && !one.cold && !one.firstOfShape
    && !one.loaderCacheMiss).map(one => one.totalMs! + (one.uploadMs ?? 0));
  return times.length ? { price: Math.round(Math.max(...times) * MARGIN + CELL_MS), expected: median(times)!, from: times.length }
    : { price: FALLBACK_MS, expected: FALLBACK_MS, from: 0 };
}
// Round one's scenes, the probe's head boxes and suit fronts and bodies.json, read and checked before anything is asked
// of a server: A+ was drawn by this action graph and recipe, each scene's bound people all have a body and a head, and
// each person's clause reads back from round one's own prompts.
function inputsOf(dirs: Dirs, ids: string[], pinned: string): Inputs {
  ids.forEach(cleanId);
  const base = apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8'))), own = samplerSettingsOf(base);
  const recipe = { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler,
    scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler, cfg: own.cfg ?? SAMPLER_DEFAULTS.cfg };
  if (!same(recipe, RECIPE)) throw new Refusal('The action graph no longer samples 25 steps of euler/simple at CFG 1: nothing is drawn');
  const round = readJson<DrawIndex>(join(dirs.source, 'draw.json')), boxes = readBoxes(dirs.probe);
  if (!round?.cells || !round.pins || !boxes) throw new Refusal('Round one\'s draw.json or the probe\'s boxes.json is missing: nothing is drawn');
  if (round.pins.actionGraph !== sha256(readFileSync(ACTION_GRAPH))) throw new Refusal('The action graph is not the one round one drew A+ with: nothing is drawn');
  const marked = readBodies(dirs.out, pinned), style = styleLine();
  const scenes = ids.map(id => sceneOf(dirs.source, round, id));
  const bodies = scenes.flatMap(scene => {
    const people = marked.boxes[scene.id] ?? {}, heads = boxes['A+'][scene.id] ?? {};
    const lacking = scene.fronts.filter(front => !people[front] || !heads[front]), extra = Object.keys(people).filter(front => !scene.fronts.includes(front));
    if (lacking.length || extra.length) {
      throw new Refusal(lacking.length ? `${lacking.join(', ')} of ${scene.id} has no body in bodies.json or no head in the probe's boxes.json: nothing is drawn`
        : `bodies.json has a body for ${extra.join(', ')}, whom round one's ${scene.id} does not bind: nothing is drawn`);
    }
    const plan = readJson<StoryPlan>(join(storyDir(dirs.source, scene.id), 'plan.json'));
    const l = plan?.arms.L?.prompt, aPlus = plan?.arms['A+']?.prompt;
    const words = l === undefined || aPlus === undefined ? undefined : clausesOf(l, scene.c, aPlus, scene.bound);
    if (!words) throw new Refusal(`Round one's A+ of ${scene.id} does not read back as its L with each bound person's look: nothing is drawn`);
    const suits = SUIT_SCENES.includes(scene.id) ? suitFrontsOf(dirs.probe, scene) : [];
    return scene.fronts.map((_, at) => bodyOf(scene, at + 1, people[scene.fronts[at]], heads, words[at], suits[at]));
  });
  return { base, recipe, round, boxes, bodiesHash: marked.hash, scenes, bodies, style, prices: pricesOf(dirs.heads) };
}
type Setup = Inputs & { card: ReturnType<typeof cardOf>; pins: Record<string, string | number> };
// And the card's record at <out>/card.txt, whose revision and weights are round one's. `geometry` pins all a picture
// here depends on beyond round one's inputs, which sceneOf holds to round one's record: a resume under any other is
// refused.
function setupOf(dirs: Dirs, ids: string[], pinned: string): Setup {
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(dirs.out, 'card.txt')); }
  catch { throw new Refusal(`${join(dirs.out, 'card.txt')} is missing or differs from gpu/image-manifest.env: copy the card's image-verified.txt there first; nothing is drawn`); }
  const inputs = inputsOf(dirs, ids, pinned), read = card as Record<string, string>;
  const wrong = ['comfyuiRevision', 'transformer', 'encoder', 'vae'].filter(key => inputs.round.pins[key] !== read[key]);
  if (wrong.length) throw new Refusal(`The card's ${wrong.join(', ')} is not what round one drew A+ with: nothing is drawn`);
  const geometry = sha256(JSON.stringify({ bodies: inputs.bodies.map(b => [b.id, b.box, b.shape.id, b.crop, b.kept, b.holes, b.cropRegion,
    sha256(promptOf(b.words, inputs.style)), b.scene.aPlus.sha256, b.front.sha256, b.suit?.sha256 ?? null]),
  variants: BODY_VARIANTS.map(one => [one.id, one.image, one.denoise]), shapes: SHAPES, front: FRONT_SIZE, grid: GRID, margin: BODY_MARGIN,
  feathers: [EDGE_FEATHER, KEEP_FEATHER], unbound: UNBOUND_HEADS, recipe: RECIPE, style: sha256(inputs.style) }));
  return { ...inputs, card, pins: { seed: SEED, comfyuiRevision: card.comfyuiRevision, transformer: card.transformer, encoder: card.encoder, vae: card.vae,
    actionGraph: String(inputs.round.pins.actionGraph), boxes: inputs.boxes.hash, bodies: inputs.bodiesHash, geometry } };
}

// The jobs in the order drawn: every body's two fronts, scene by scene in slot order, then the suit's, so that a stop
// leaves the question whole before the add-on. A row is one body's jobs of one part, begun only whole.
type Job = { body: Body; variant: BodyVariant };
const jobsOf = (bodies: Body[]): Job[] => [...bodies.flatMap(body => BODY_VARIANTS.filter(one => one.image === 'front').map(variant => ({ body, variant }))),
  ...bodies.filter(body => body.suit).flatMap(body => BODY_VARIANTS.filter(one => one.image === 'suit').map(variant => ({ body, variant })))];
const rowsOf = (jobs: Job[]) => jobs.reduce<Job[][]>((rows, job) => {
  const last = rows.at(-1);
  if (last && last[0].body === job.body && last[0].variant.image === job.variant.image) last.push(job); else rows.push([job]);
  return rows;
}, []);

// The jobs, their shapes and minutes: expected at the head test's median with half the compile, and at the prices a
// body is admitted by, with the compile of the first job and of each other canvas.
function estimateOf(inputs: Inputs) {
  const jobs = jobsOf(inputs.bodies), { price, expected, from } = inputs.prices;
  const shapes = new Set(jobs.map(job => job.body.shape.id)).size;
  const part = (list: Job[]) => ({ jobs: list.length, expectedMinutes: minutes(list.length * expected), pricedMinutes: minutes(list.length * price) });
  return { bodies: inputs.bodies.length, jobs: jobs.length, shapes, expectedMinutes: minutes(jobs.length * expected + (jobs.length ? COLD_MS / 2 : 0)),
    pricedMinutes: minutes(jobs.length * price + (jobs.length ? COLD_MS + (shapes - 1) * SHAPE_MS : 0)),
    fronts: part(jobs.filter(job => job.variant.image === 'front')), suit: part(jobs.filter(job => job.variant.image === 'suit')),
    jobSeconds: { expected: Math.round(expected / 100) / 10, priced: Math.round(price / 100) / 10, from },
    layout: inputs.bodies.map(b => ({ id: b.id, shape: b.shape.id, crop: [b.crop.x, b.crop.y, b.crop.width, b.crop.height], gain: Math.round(b.gain * 100) / 100,
      kept: b.kept.length })) };
}

// ---- The graphs ----

// The probe's ids where this graph has the probe's nodes (image-t-probe.ts `startFrom`), and its own beside them.
const START = '40', ENCODE = '41', NOISE = '43', PASTE = '44', EMPTY = '45', SCENE_CROP = '46', SCENE_UP = '47', DOWN = '48', PASTE_EMPTY = '49';
const REGION = '60', NOISED = '61', FEATHERED = '62', PASTED = '63', PASTE_REGION = '64', LOADER = '11', SCALE = '21';
const holeNodes = (at: number) => [String(70 + 2 * at), String(71 + 2 * at)];
const pasteHoleNodes = (at: number) => [String(80 + 3 * at), String(81 + 3 * at), String(82 + 3 * at)];
type Names = { aPlus: string; front: string };
// One job's graph: the action graph with slot 1 scaled, filled as the probe fills it, started from A+ through the VAE
// at the variant's denoise (`startFrom`); then the front scaled whole (area) to 576x1024, A+'s crop scaled bicubic to
// the canvas on its way to the VAE, the decode scaled back (area) to the crop's size, and the two masks of `masksOf`.
function buildJob(setup: Setup, b: Body, v: BodyVariant, names: Names) {
  const prompt = promptOf(b.words, setup.style), canvas = b.shape.canvas;
  const graph = applyToWorkflow(actionGraph(setup.base, [1]).graph, { checkpoint: setup.card.model, prompt, negative: '', seed: SEED, ...setup.recipe,
    ...canvas, references: [names.front] });
  startFrom(graph, { ...FACE_EACH, denoise: v.denoise }, names.aPlus);
  const find = (type: string) => Object.keys(graph).filter(id => graph[id].class_type === type);
  const [sampler] = find('KSampler'), [save] = find('SaveImage');
  const decode = idOf(graph[save]?.inputs.images), encoder = idOf(graph[sampler]?.inputs.positive);
  const { noise, paste, at } = masksOf(b), [region, ...holes] = noise.ops, [pasteRegion, ...pasteHoles] = paste.ops;
  const ours = [NOISE, PASTE, EMPTY, SCENE_CROP, SCENE_UP, DOWN, PASTE_EMPTY, REGION, NOISED, FEATHERED, PASTED, PASTE_REGION,
    ...holes.flatMap((_, k) => holeNodes(k)), ...pasteHoles.flatMap((_, k) => pasteHoleNodes(k))];
  if (!sampler || !save || decode === undefined || graph[decode]?.class_type !== 'VAEDecode' || encoder === undefined
    || graph[START]?.class_type !== 'LoadImage' || graph[ENCODE]?.class_type !== 'VAEEncode' || graph[LOADER]?.class_type !== 'LoadImage'
    || graph[SCALE]?.class_type !== 'ImageScale' || !same(graph[SCALE].inputs.image, [LOADER, 0]) || !same(graph[encoder].inputs['images.image_1'], [SCALE, 0])
    || Object.keys(graph[encoder].inputs).some(key => /^images\.image_\d+$/.test(key) && key !== 'images.image_1') || ours.some(id => graph[id])) {
    throw workflowError();
  }
  graph[SCALE].inputs = { upscale_method: 'area', ...FRONT_SIZE, crop: 'disabled', image: [LOADER, 0] };
  graph[SCENE_CROP] = { class_type: 'ImageCrop', inputs: { image: [START, 0], ...b.crop } };
  graph[SCENE_UP] = { class_type: 'ImageScale', inputs: { upscale_method: 'bicubic', ...canvas, crop: 'disabled', image: [SCENE_CROP, 0] } };
  graph[ENCODE].inputs.pixels = [SCENE_UP, 0];
  graph[DOWN] = { class_type: 'ImageScale', inputs: { upscale_method: 'area', width: b.crop.width, height: b.crop.height, crop: 'disabled', image: [decode, 0] } };
  const solid = (rect: Rect) => ({ class_type: 'SolidMask', inputs: { value: 1, ...sizeOf(rect) } });
  const composite = (destination: string, from: string, op: Op) => ({ class_type: 'MaskComposite',
    inputs: { destination: [destination, 0], source: [from, 0], x: op.rect[0], y: op.rect[1], operation: op.op } });
  graph[EMPTY] = { class_type: 'SolidMask', inputs: { value: 0, ...noise.canvas } };
  graph[REGION] = solid(region.rect);
  graph[NOISED] = composite(EMPTY, REGION, region);
  let last = NOISED;
  holes.forEach((hole, k) => {
    const [one, cutOut] = holeNodes(k);
    graph[one] = solid(hole.rect);
    graph[cutOut] = composite(last, one, hole);
    last = cutOut;
  });
  graph[NOISE] = { class_type: 'SetLatentNoiseMask', inputs: { samples: [ENCODE, 0], mask: [last, 0] } };
  graph[sampler].inputs.latent_image = [NOISE, 0];
  graph[PASTE_EMPTY] = { class_type: 'SolidMask', inputs: { value: 0, ...paste.canvas } };
  graph[PASTE_REGION] = solid(pasteRegion.rect);
  graph[FEATHERED] = { class_type: 'FeatherMask', inputs: { mask: [PASTE_REGION, 0], ...pasteRegion.feather } };
  graph[PASTED] = composite(PASTE_EMPTY, FEATHERED, pasteRegion);
  last = PASTED;
  pasteHoles.forEach((hole, k) => {
    const [one, feathered, cutOut] = pasteHoleNodes(k);
    graph[one] = solid(hole.rect);
    graph[feathered] = { class_type: 'FeatherMask', inputs: { mask: [one, 0], ...hole.feather } };
    graph[cutOut] = composite(last, feathered, hole);
    last = cutOut;
  });
  graph[PASTE] = { class_type: 'ImageCompositeMasked', inputs: { destination: [START, 0], source: [DOWN, 0], ...at, resize_source: false, mask: [last, 0] } };
  graph[save].inputs.images = [PASTE, 0];
  return { graph, promptChars: prompt.length };
}

// A mask chain read back from a graph as it goes out: MaskComposite `add` and `subtract` down to an empty SolidMask,
// each with its SolidMask 1, through a FeatherMask or not; anything else reads as nothing.
function chainIn(graph: Graph, link: unknown): Chain | undefined {
  const from = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
  const ops: Op[] = [];
  let node = from(link);
  for (; node?.class_type === 'MaskComposite'; node = from(node.inputs.destination)) {
    const op = node.inputs.operation;
    let source = from(node.inputs.source), feather: Feather | undefined;
    if (source?.class_type === 'FeatherMask') {
      const { left, top, right, bottom } = source.inputs;
      feather = { left: Number(left), top: Number(top), right: Number(right), bottom: Number(bottom) };
      source = from(source.inputs.mask);
    }
    if ((op !== 'add' && op !== 'subtract') || source?.class_type !== 'SolidMask' || source.inputs.value !== 1 || ops.length > 8) return undefined;
    const x = Number(node.inputs.x), y = Number(node.inputs.y);
    ops.unshift({ op, rect: [x, y, x + Number(source.inputs.width), y + Number(source.inputs.height)], ...(feather ? { feather } : {}) });
  }
  return node?.class_type === 'SolidMask' && node.inputs.value === 0
    ? { canvas: { width: Number(node.inputs.width), height: Number(node.inputs.height) }, ops } : undefined;
}
// A job's graph as it goes out, read from the sampler, the encoder and the save rather than by the ids buildJob gave:
// the recipe, seed and denoise; the prompt, and the encoder at resolution 0, which takes the front at its own size; one
// slot, the job's front scaled whole (area) to 576x1024; the start, A+'s crop scaled bicubic to the canvas through the
// VAE; the noise mask; the paste of the decode, scaled back (area), into the start's own pixels at the crop's place
// through the paste's mask; two uploads, and no empty latent or DifferentialDiffusion.
function bodyRight(graph: Graph, b: Body, v: BodyVariant, names: Names, style: string): boolean {
  const from = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
  const nodes = Object.values(graph), canvas = b.shape.canvas;
  const samplers = nodes.filter(node => node.class_type === 'KSampler'), saves = nodes.filter(node => node.class_type === 'SaveImage');
  if (samplers.length !== 1 || saves.length !== 1) return false;
  const sampler = samplers[0].inputs, positive = from(sampler.positive);
  const recipe = sampler.seed === SEED && sampler.steps === RECIPE.steps && sampler.sampler_name === RECIPE.sampler && sampler.scheduler === RECIPE.scheduler
    && sampler.cfg === RECIPE.cfg && sampler.denoise === v.denoise;
  const worded = positive?.class_type === 'TextEncodeQwenImage21' && from(sampler.negative) === positive && positive.inputs.resolution === 0
    && positive.inputs.prompt === promptOf(b.words, style) && positive.inputs.negative_prompt === '';
  const slots = Object.entries(positive?.inputs ?? {}).filter(([key]) => /^images\.image_\d+$/.test(key)).map(([key, link]) => {
    const scale = from(link), loader = from(scale?.inputs.image);
    return [key, scale?.class_type, scale?.inputs.upscale_method, scale?.inputs.width, scale?.inputs.height, scale?.inputs.crop, loader?.class_type,
      loader?.inputs.image];
  });
  const slotted = same(slots, [['images.image_1', 'ImageScale', 'area', FRONT_SIZE.width, FRONT_SIZE.height, 'disabled', 'LoadImage', names.front]]);
  const noised = from(sampler.latent_image), encode = noised?.class_type === 'SetLatentNoiseMask' ? from(noised.inputs.samples) : undefined;
  const up = from(encode?.inputs.pixels), cut = from(up?.inputs.image), start = from(cut?.inputs.image);
  const starts = encode?.class_type === 'VAEEncode' && from(encode.inputs.vae)?.class_type === 'VAELoader' && up?.class_type === 'ImageScale'
    && same([up.inputs.upscale_method, up.inputs.width, up.inputs.height, up.inputs.crop], ['bicubic', canvas.width, canvas.height, 'disabled'])
    && cut?.class_type === 'ImageCrop' && same([cut.inputs.x, cut.inputs.y, cut.inputs.width, cut.inputs.height], [b.crop.x, b.crop.y, b.crop.width, b.crop.height])
    && start?.class_type === 'LoadImage' && start.inputs.image === names.aPlus;
  const masks = masksOf(b), pasted = from(saves[0].inputs.images), down = from(pasted?.inputs.source), decoded = from(down?.inputs.image);
  const pastes = pasted?.class_type === 'ImageCompositeMasked' && from(pasted.inputs.destination) === start && down?.class_type === 'ImageScale'
    && same([down.inputs.upscale_method, down.inputs.width, down.inputs.height, down.inputs.crop], ['area', b.crop.width, b.crop.height, 'disabled'])
    && decoded?.class_type === 'VAEDecode' && from(decoded.inputs.samples) === samplers[0] && pasted.inputs.x === masks.at.x && pasted.inputs.y === masks.at.y
    && pasted.inputs.resize_source === false && same(chainIn(graph, pasted.inputs.mask), masks.paste);
  const plain = !nodes.some(node => node.class_type === 'EmptyLatentImage' || node.class_type === 'DifferentialDiffusion')
    && nodes.filter(node => node.class_type === 'LoadImage').length === 2;
  return recipe && worded && slotted && starts && same(chainIn(graph, noised?.inputs.mask), masks.noise) && pastes && plain;
}

// ---- The drawing ----

type Cell = { key: string; body: string; scene: string; variant: string; image: BodyVariant['image']; denoise: number; shape: string;
  status: 'drawn' | 'failed'; code?: string; httpStatus?: number; oom?: boolean; references: number; triton: boolean; retried?: boolean; file?: string;
  sha256?: string; bytes?: number; width?: number; height?: number; cold?: boolean; firstOfShape?: boolean; totalMs?: number; viewMs?: number;
  queueMs?: number; sampleMs?: number; phases?: Phases; loaderCacheMiss?: boolean; uploadMs?: number; vramSamples?: number;
  partialModelLoadEvents?: number; promptChars?: number };
type KitchenRecord = { seen: boolean; argv: boolean; tritonImported: boolean; tritonImportFailed: boolean; backend: { available: boolean; disabled: boolean } | null };
// redraws.json: ids, codes, sizes, counts and times, no prompt. `server`: what the server said it is, triton among it
// when it runs comfy-kitchen's Triton backend; `kitchen`: what its log said of the backends at its start. `layout`:
// each body's crop [x, y, width, height], its box, its region and the heads kept, in frame pixels, so that the redraws
// can be cut and checked later without this file's geometry: outside the region and inside a kept head a redraw is A+.
type Layout = { scene: string; slot: number; shape: string; crop: [number, number, number, number]; box: Box; region: Rect; kept: Rect[] };
const layoutOf = (bodies: Body[]): Record<string, Layout> => Object.fromEntries(bodies.map(b => [b.id, { scene: b.scene.id, slot: b.slot,
  shape: `${b.shape.canvas.width}x${b.shape.canvas.height}`, crop: [b.crop.x, b.crop.y, b.crop.width, b.crop.height], box: b.box, region: rectOf(b.region),
  kept: b.kept }]));
type BodiesIndex = { startedAt: string; completedAt?: string; pins: Record<string, string | number>; server: Record<string, string>; triton: boolean;
  kitchen?: KitchenRecord; layout?: Record<string, Layout>; cells: Record<string, Cell>; stopped?: 'until'; error?: string };
type Options = { dirs: Dirs; comfy: string; until: number; ids: string[]; pinned: string; timeoutMs?: number; waitMs?: number; pollMs?: number;
  log: (event: object) => void };
const INDEX_FILE = 'redraws.json';
const fileKey = (b: Body, v: BodyVariant) => join(b.scene.id, b.id, `${v.id}.png`);
const countsOf = (index: BodiesIndex) => {
  const cells = Object.values(index.cells);
  return { drawn: cells.filter(one => one.status === 'drawn').length,
    failed: cells.filter(one => one.status === 'failed').reduce<Record<string, number>>((all, one) => ({ ...all, [one.code ?? 'image_failed']: (all[one.code ?? 'image_failed'] ?? 0) + 1 }), {}) };
};

// Every job not yet drawn, one at a time through the harness's drawOne, row by row: a body's row begins only if all its
// jobs left can end by `until`, the compile of the run's first job and of each new canvas priced in, and each job only
// if it still can. A socket that does not open is waited out once; a failed job is recorded and the run goes on,
// unless its code says the graph or the server is wrong (stopsTheRun), which stops the run.
async function drawBodies(options: Options): Promise<BodiesIndex> {
  const out = resolve(options.dirs.out), file = join(out, INDEX_FILE);
  const setup = setupOf(options.dirs, options.ids, options.pinned), earlier = readJson<BodiesIndex>(file);
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card); nothing is drawn');
  });
  if (earlier && (earlier.pins.geometry !== setup.pins.geometry || !same(earlier.server, server))) {
    throw new Refusal(`${file} was drawn from other bodies, variants or prompts, or on a server that said another thing of itself (Triton included): `
      + 'move it aside; nothing is drawn');
  }
  const triton = server.triton === 'enabled';
  // The log's word on comfy-kitchen's backends, read before anything is drawn, while the lines of the server's start
  // are still in its ring; a later read that no longer finds them keeps the earlier one.
  const kitchen = kitchenOf(await logLines(comfy), triton);
  const index: BodiesIndex = earlier ?? { startedAt: new Date().toISOString(), pins: {}, server, triton, cells: {} };
  index.pins = setup.pins;
  index.server = server;
  index.triton = triton;
  index.layout = layoutOf(setup.bodies);
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
  const page = () => writePage(options.dirs, setup, index);
  page();
  if (triton && kitchen.seen && (kitchen.tritonImportFailed || !kitchen.backends.triton?.available || kitchen.backends.triton.disabled)) {
    options.log({ event: 'triton_not_loaded' });
  }
  const done = (key: string) => {
    const cell = index.cells[key], path = cell?.file === undefined ? undefined : join(out, cell.file);
    return cell?.status === 'drawn' && path !== undefined && existsSync(path) && sha256(readFileSync(path)) === cell.sha256;
  };
  const { price, expected } = setup.prices, jobs = jobsOf(setup.bodies);
  const left = jobs.filter(job => !done(cellKey(job.body.id, job.variant.id))), shapes = new Set(left.map(job => job.body.shape.id)).size;
  options.log({ event: 'bodies_plan', bodies: setup.bodies.length, jobs: jobs.length, left: left.length, triton,
    expectedMinutes: minutes(left.length * expected + (left.length ? COLD_MS / 2 : 0)),
    pricedMinutes: minutes(left.length * price + (left.length ? COLD_MS + (shapes - 1) * SHAPE_MS : 0)) });
  const uploaded = new Map<string, string>();
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
  // Whether a job of the run has reached the card, and the canvases those jobs had: what the card has compiled.
  let reached = false, sentJobs = 0;
  const shapesReached = new Set<string>();
  const extraMs = (shape: string, any = reached, seen: Set<string> = shapesReached) => (!any ? COLD_MS : seen.has(shape) ? 0 : SHAPE_MS);
  const needOf = (todo: Job[]) => {
    let any = reached;
    const seen = new Set(shapesReached);
    return todo.reduce((sum, job) => {
      const extra = extraMs(job.body.shape.id, any, seen);
      any = true;
      seen.add(job.body.shape.id);
      return sum + price + extra;
    }, 0);
  };
  const attempt = async ({ body: b, variant: v }: Job, fits: () => boolean, retried: boolean): Promise<'drawn' | 'failed' | 'socket' | 'until' | 'stopped'> => {
    const key = cellKey(b.id, v.id), path = join(out, fileKey(b, v)), shape = b.shape.id;
    const own = { key, body: b.id, scene: b.scene.id, variant: v.id, image: v.image, denoise: v.denoise, shape, references: 1, triton,
      ...(retried ? { retried } : {}) };
    let sent = false;
    try {
      const spent = { ms: 0 };
      const names = { aPlus: await name(b.scene.aPlus, spent), front: await name(v.image === 'suit' ? b.suit! : b.front, spent) };
      const built = buildJob(setup, b, v, names);
      if (!bodyRight(built.graph, b, v, names, setup.style)) throw workflowError();
      const before = await logLines(comfy);
      const cold = !reached, firstOfShape = !shapesReached.has(shape);
      sent = true;
      const drawn = await drawOne(comfy, built.graph, { pollMs: options.pollMs, waitMs: options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true, admit: fits });
      reached = true;
      shapesReached.add(shape);
      sentJobs++;
      // The picture is down, and it is kept whatever comes next: saved and recorded before anything more is asked.
      await settled();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const size = pngSize(drawn.bytes), phases = drawn.timing?.phases;
      // The job's time on the card is its phases; the rest of totalMs, less the download, is the wait from the submit to
      // its first node and from its end to the download.
      const ran = phases ? Object.values(phases).reduce<number>((sum, ms) => sum + (ms ?? 0), 0) : undefined;
      const cell: Cell = { ...own, status: 'drawn', file: relative(out, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length, ...size,
        ...(cold ? { cold } : {}), ...(firstOfShape ? { firstOfShape } : {}), totalMs: drawn.totalMs, viewMs: drawn.viewMs,
        ...(ran === undefined ? {} : { queueMs: Math.max(0, drawn.totalMs - drawn.viewMs - ran), sampleMs: phases?.sampleMs }), ...drawn.timing,
        ...(spent.ms ? { uploadMs: Math.round(spent.ms) } : {}), vramSamples: drawn.memory.samples, promptChars: built.promptChars };
      index.cells[key] = cell;
      save();
      options.log({ event: 'cell_drawn', key, totalMs: drawn.totalMs, sampleMs: phases?.sampleMs, width: size.width, height: size.height,
        ...(cold ? { cold } : {}), ...(firstOfShape ? { firstOfShape } : {}) });
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
        shapesReached.add(shape);
      }
      if (comfy.end?.aborted || raw === 'not_admitted') return 'until';
      if (raw === 'comfy_socket_unavailable' && !retried) return 'socket';
      const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
      const { httpStatus } = safeErrorDetails(error);
      const failure = { code, ...(httpStatus === undefined ? {} : { httpStatus }), ...((error as { oom?: unknown }).oom === true ? { oom: true } : {}) };
      index.cells[key] = { ...own, status: 'failed', ...failure };
      save();
      options.log({ event: 'cell_failed', key, ...failure });
      if (stopsTheRun(code)) { index.error = code; return 'stopped'; }
      return 'failed';
    }
  };

  let ended: 'done' | 'until' | 'stopped' = 'done';
  rows: for (const row of rowsOf(jobs)) {
    const todo = row.filter(job => !done(cellKey(job.body.id, job.variant.id)));
    if (!todo.length) continue;
    const needMs = needOf(todo), leftMs = options.until - Date.now();
    if (comfy.end?.aborted || needMs > leftMs) {
      options.log({ event: 'body_not_begun', body: row[0].body.id, jobs: todo.length, needMinutes: Math.ceil(needMs / 60000),
        leftMinutes: Math.max(0, Math.floor(leftMs / 60000)) });
      ended = 'until';
      break;
    }
    for (const job of todo) {
      const fits = () => !comfy.end?.aborted && Date.now() + price + extraMs(job.body.shape.id) <= options.until;
      if (!fits()) { ended = 'until'; break rows; }
      let result = await attempt(job, fits, false);
      if (result === 'socket') {
        options.log({ event: 'socket_retry', key: cellKey(job.body.id, job.variant.id) });
        await delay(RETRY_PAUSE_MS, undefined, { signal: comfy.end }).catch(() => undefined);
        if (!fits()) { ended = 'until'; break rows; }
        result = await attempt(job, fits, true);
      }
      if (result === 'until' || result === 'stopped') { ended = result; break rows; }
    }
    page();
  }
  // A failed job's delete may still be on its way, and the run is not over before the card has had it.
  await settled();
  if (ended === 'until') index.stopped = 'until';
  index.completedAt = new Date().toISOString();
  save();
  page();
  options.log({ event: 'bodies_done', ended, sent: sentJobs, ...countsOf(index),
    left: jobs.filter(job => !done(cellKey(job.body.id, job.variant.id))).length, ...(index.error ? { error: index.error } : {}) });
  return index;
}

// ---- The page ----

// index.html beside redraws.json. A row a body: A+ over the body's crop with its region (red), where the paste reaches
// 1 (dashed), the heads kept (blue) and the body's box (green); each redraw over the same crop, so that each is enlarged
// alike and the seams show; and the front whole, with the suit front where there is one. Then the whole frames, scene
// by scene: A+ and every redraw. Each picture links to its file, linked where it lies, never copied. Under the rows the
// warm times of each variant, the first jobs of each canvas apart.
function writePage(dirs: Dirs, inputs: Inputs, index: BodiesIndex | undefined) {
  const out = resolve(dirs.out), drawing = index !== undefined && !index.completedAt, cells = index?.cells ?? {};
  const href = (path: string) => escapeHtml(relative(out, path).split(sep).join('/'));
  const HIGH = 360;
  const figure = (path: string | undefined, view: Crop, canvas: Size, caption: string, missing: string, marks = '') => {
    const width = Math.round(HIGH * view.width / view.height), size = `style="width:${width}px;height:${HIGH}px"`;
    const body = path && existsSync(path)
      ? `<a href="${href(path)}"><svg viewBox="${view.x} ${view.y} ${view.width} ${view.height}" ${size}><image href="${href(path)}" width="${canvas.width}" height="${canvas.height}"/>${marks}</svg></a>`
      : `<div class="box" ${size}>${escapeHtml(missing)}</div>`;
    return `<figure>${body}<figcaption style="width:${width}px">${escapeHtml(caption)}</figcaption></figure>`;
  };
  const rect = ([left, top, right, bottom]: Rect, style: string) =>
    `<rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" ${style} vector-effect="non-scaling-stroke"/>`;
  const drawnFile = (key: string) => (cells[key]?.status === 'drawn' && cells[key].file ? join(out, cells[key].file!) : undefined);
  const whole = { x: 0, y: 0, ...FRAME_CANVAS };
  const rows = inputs.bodies.map(b => {
    const [left, top, right, bottom] = rectOf(b.region), f = b.region.feather;
    const marks = rect([left, top, right, bottom], 'fill="none" stroke="#ff1744" stroke-width="2"')
      + rect([left + f.left, top + f.top, right - f.right, bottom - f.bottom], 'fill="none" stroke="#ff1744" stroke-width="1" stroke-dasharray="4 3"')
      + b.kept.map(kept => rect(kept, 'fill="#00b0ff" fill-opacity="0.3" stroke="#00b0ff" stroke-width="1"')).join('')
      + rect(b.box, 'fill="none" stroke="#00e676" stroke-width="1"');
    const drawn = BODY_VARIANTS.filter(v => v.image === 'front' || b.suit).map(v => {
      const cell = cells[cellKey(b.id, v.id)];
      const time = cell?.status === 'drawn' ? `; ${seconds(cell.totalMs)} с, сэмплер ${seconds(cell.sampleMs)} с${cell.cold ? ', первое задание (компиляция)' : cell.firstOfShape ? ', первое на этом холсте' : ''}` : '';
      return figure(drawnFile(cellKey(b.id, v.id)), b.crop, FRAME_CANVAS, `${v.caption}${time}`,
        cell?.status === 'failed' ? `не вышло: ${cell.code ?? 'image_failed'}` : drawing ? 'ещё не нарисовано' : 'не нарисовано');
    }).join('');
    const portrait = { x: 0, y: 0, ...b.scene.portraitCanvas };
    const title = ACTION_STORIES.find(one => one.id === b.scene.id)?.label ?? b.scene.id;
    return `<section><h2>${escapeHtml(b.id)} (${escapeHtml(title)}): холст ${b.shape.canvas.width}x${b.shape.canvas.height}, увеличение ${String(Math.round(b.gain * 100) / 100).replace('.', ',')}</h2><div class="row">`
      + figure(join(dirs.source, b.scene.aPlus.file), b.crop, FRAME_CANVAS, 'A+ раунда 1, старт; красное: маска шума, пунктир: где вклейка равна 1, синее: чужие головы, зелёное: рамка тела', 'нет файла', marks)
      + drawn + figure(join(dirs.source, b.front.file), portrait, b.scene.portraitCanvas, 'фронт раунда 1, картинка 1', 'нет файла')
      + (b.suit ? figure(join(dirs.probe, b.suit.file), portrait, b.scene.portraitCanvas, 'фронт в костюме из T-пробы, картинка 1 для suit-080', 'нет файла') : '')
      + '</div></section>';
  });
  const frames = inputs.scenes.map(scene => {
    const own = inputs.bodies.filter(b => b.scene === scene);
    return `<h3>${escapeHtml(ACTION_STORIES.find(one => one.id === scene.id)?.label ?? scene.id)}</h3><div class="row">`
      + figure(join(dirs.source, scene.aPlus.file), whole, FRAME_CANVAS, 'A+ раунда 1', 'нет файла')
      + own.flatMap(b => BODY_VARIANTS.filter(v => v.image === 'front' || b.suit).map(v => figure(drawnFile(cellKey(b.id, v.id)), whole, FRAME_CANVAS,
        `${b.id}, ${v.id}`, drawing ? 'ещё не нарисовано' : 'не нарисовано'))).join('') + '</div>';
  });
  const drawnCells = Object.values(cells).filter(one => one.status === 'drawn');
  const times = BODY_VARIANTS.map(v => {
    const warm = drawnCells.filter(one => one.variant === v.id && !one.cold && !one.firstOfShape);
    const of = (read: (one: Cell) => number | undefined) => seconds(median(warm.map(read).filter((ms): ms is number => ms !== undefined)));
    return `<tr><td>${escapeHtml(v.id)}</td><td>${warm.length}</td><td>${of(one => one.totalMs)}</td><td>${of(one => one.sampleMs)}</td><td>${of(one => one.queueMs)}</td></tr>`;
  }).join('');
  const first = drawnCells.filter(one => one.cold || one.firstOfShape)
    .map(one => `${escapeHtml(one.key)} (${escapeHtml(one.shape)}): ${seconds(one.totalMs)} с, сэмплер ${seconds(one.sampleMs)} с${one.cold ? ', первое задание' : ''}`).join('; ');
  const planned = jobsOf(inputs.bodies).length, counts = index ? countsOf(index) : { drawn: 0, failed: {} };
  const failed = Object.entries(counts.failed).map(([code, n]) => `${code} ${n}`).join(', ');
  const state = !index ? 'до карты: ничего не нарисовано' : drawing ? 'рисуется; страница обновляется сама раз в минуту'
    : index.error ? `остановилось с ошибкой ${index.error}` : index.stopped ? 'остановилось: следующее тело не успевало до срока' : 'закончено';
  const kitchen = index?.kitchen, backend = kitchen?.backend;
  const log = !kitchen?.seen ? 'строк запуска в журнале сервера уже нет' : kitchen.tritonImportFailed ? 'triton не импортировался'
    : backend?.available && !backend.disabled ? 'бэкенд triton загружен' : 'бэкенд triton выключен';
  const server = index ? `Сервер: ComfyUI ${escapeHtml(index.server.comfyui ?? '?')}, PyTorch ${escapeHtml(index.server.pytorch ?? '?')}, карта `
    + `${escapeHtml(index.server.card ?? '?')}; Triton: ${index.triton ? 'включён' : 'выключен'} (${escapeHtml(log)}).` : '';
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${drawing ? '<meta http-equiv="refresh" content="60">' : ''}
<title>Тела: фронт картинкой 1</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:flex-start}figure{margin:0}
svg{display:block;background:#eee}figcaption{font-size:12px}td,th{padding:2px 8px;text-align:right}
.box{display:flex;align-items:center;justify-content:center;text-align:center;background:#eee;font-size:13px}</style>
<h1>Тела: фронт картинкой 1, кроп A+ вокруг тела</h1>
<p>Каждое задание начинается с A+ раунда 1 и перерисовывает одного связанного человека целиком. Область: рамка тела из bodies.json с полями
${BODY_MARGIN} px до сетки ${GRID} px. Кроп A+ вокруг неё берёт самый вытянутый вверх холст из ${SHAPES.map(one => `${one.canvas.width}x${one.canvas.height}`).join(', ')},
который помещается в кадр, увеличивается bicubic до холста и рисуется в этом размере. Потом он уменьшается area и вклеивается в пиксели A+ через область,
растушёванную на ${EDGE_FEATHER} px внутрь и на ${KEEP_FEATHER} px прочь от чужих голов (синее), которые маска шума не трогает. Вне области картинка остаётся A+
пиксель в пиксель. Картинка 1 это фронт человека целиком, area до ${FRONT_SIZE.width}x${FRONT_SIZE.height}. У front-065 и front-080 это фронт раунда 1 (белая
майка и серые брюки), у suit-080 фронт того же человека в тёмно-сером костюме из T-пробы. Промпт: «The person from image 1», роль, поворот,
одежда сцены и действие человека из A+ без его внешности, и строка стиля раунда 1; сид ${SEED}, ${RECIPE.steps} шагов ${RECIPE.sampler}/${RECIPE.scheduler},
CFG ${RECIPE.cfg}. Картинки ряда показывают один и тот же кроп кадра; щелчок открывает весь кадр. Вопрос: пришло ли телосложение и пропорции
фронта, остались ли действие, контакты и одежда сцены, и не видно ли шва.</p>
<p>Состояние: ${escapeHtml(state)}. Нарисовано ${counts.drawn} из ${planned}${failed ? `, не вышло: ${escapeHtml(failed)}` : ''}. ${server}</p>
<table><tr><th>вариант</th><th>тёплых</th><th>всего, с</th><th>сэмплер, с</th><th>ожидание, с</th></tr>${times}</table>
<p>Медианы по тёплым заданиям. Отдельно первые задания каждого холста (компиляция Triton): ${first || 'нет'}.</p>
${rows.join('\n')}
<section id="frames"><h2>Кадры целиком</h2>
${frames.join('\n')}
</section>
`, { mode: 0o600 });
}

// ---- The plan panel ----

// plan.png, before the card: a row a body, A+ round its crop with the region (red), the heads kept (blue), where the
// paste reaches 1 (white dashes), the body's box (green), the canvas's noise region and holes back in frame pixels
// (magenta and orange) and the crop (yellow); and beside it the front whole. Drawn by ImageMagick's convert.
const ROW_HIGH = 400;
function planPanel(dirs: Dirs, inputs: Inputs, file: string) {
  if (spawnSync('convert', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Refusal('plan draws with ImageMagick\'s convert, which is not installed; the page shows the same marks');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const parts = mkdtempSync(join(dirname(file), 'plan-'));
  const box = ([left, top, right, bottom]: Rect) => `rectangle ${left},${top} ${right - 1},${bottom - 1}`;
  const rows: string[] = [];
  try {
    for (const b of inputs.bodies) {
      const { x, y, width, height } = b.crop, canvas = b.shape.canvas;
      const back = ([left, top, right, bottom]: Rect): Rect => [x + Math.floor(left * width / canvas.width), y + Math.floor(top * height / canvas.height),
        x + Math.ceil(right * width / canvas.width), y + Math.ceil(bottom * height / canvas.height)];
      const [left, top, right, bottom] = rectOf(b.region), f = b.region.feather;
      const view: Rect = [Math.max(0, x - 24), Math.max(0, y - 24), Math.min(FRAME_CANVAS.width, x + width + 24), Math.min(FRAME_CANVAS.height, y + height + 24)];
      const scene = join(parts, `${b.id}-a.png`), front = join(parts, `${b.id}-b.png`), row = join(parts, `${b.id}.png`);
      const draw = (colour: string, rects: Rect[], stroke = 'none', dashes = '') =>
        (rects.length ? ['-fill', colour, '-stroke', stroke, '-strokewidth', '2', '-draw', `${dashes}${rects.map(box).join(' ')}`] : []);
      execFileSync('convert', [join(dirs.source, b.scene.aPlus.file), ...draw('rgba(255,0,0,0.22)', [[left, top, right, bottom]]),
        ...draw('rgba(0,140,255,0.55)', b.kept), ...draw('none', [[left + f.left, top + f.top, right - f.right, bottom - f.bottom]], 'white', 'stroke-dasharray 6 4 '),
        ...draw('none', [b.box], 'lime'), ...draw('none', [back(b.cropRegion)], 'magenta'), ...draw('none', b.holes.map(back), 'orange'),
        ...draw('none', [[x, y, x + width, y + height]], 'yellow'),
        '-crop', `${view[2] - view[0]}x${view[3] - view[1]}+${view[0]}+${view[1]}`, '+repage', '-resize', `x${ROW_HIGH}`, scene]);
      execFileSync('convert', [join(dirs.source, b.front.file), '-resize', `x${ROW_HIGH}`, front]);
      const label = `${b.id}  ${b.shape.id} ${canvas.width}x${canvas.height}  x${(Math.round(b.gain * 100) / 100).toFixed(2)}`;
      execFileSync('convert', [scene, front, '+append', '-fill', 'white', '-stroke', 'black', '-strokewidth', '1', '-pointsize', '24', '-annotate', '+8+28', label, row]);
      rows.push(row);
    }
    execFileSync('convert', [...rows, '-background', '#222', '-gravity', 'North', '-splice', '0x6', '-append', '+repage', file]);
  } finally { rmSync(parts, { recursive: true, force: true }); }
  return rows.length;
}

// ---- The dry run ----

// Round one as the harness left it, made up: each scene's plan, whose L, A+, C and T are in round one's own forms round
// made-up clauses and looks, the second person's clause with no words ahead of its action, which C joins with ": ";
// L's, A+'s, T's and C's pictures at 1280x704 and the fronts at 720x1280, flat grey, all of seed 7, and draw.json with
// their records and round one's pins; beside them a sealed story whose plan and picture hold `word`.
const DRY_BOUND: Record<string, number> = { flight: 4, twister: 4, giants: 3, guard: 2, tango: 2, demon: 4 };
function madeUpRound(root: string, card: ReturnType<typeof cardOf>, word: string, style: string) {
  const round: DrawIndex = { pins: { ...pinsOf(card), actionGraph: sha256(readFileSync(ACTION_GRAPH)) }, startedAt: new Date().toISOString(), cells: {} };
  let number = 1000;
  const put = (cell: { key: string; kind: 'frame' | 'front'; story: string; id: string; arm?: 'L' | 'A+' | 'T' | 'C'; references: number }, bytes: Buffer) => {
    const path = fileOf(root, { ...cell, seed: SEED });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    round.cells[cell.key] = { ...cell, seed: SEED, status: 'drawn', file: relative(root, path), sha256: sha256(bytes), bytes: bytes.length, ...pngSize(bytes),
      totalMs: 18000, uploadMs: 700 };
  };
  for (const id of BODY_SCENES) {
    const clauses = Array.from({ length: DRY_BOUND[id] }, (_, at) => (at === 1 ? `holds on to the made-up rail ${at + 1}`
      : `the made-up holder ${at + 1}, wearing a made-up coat ${at + 1}: holds on`));
    const joints = clauses.map((_, at) => (at === 1 ? ': ' : ', ')), fronts = clauses.map((_, at) => `${id}-e${at + 1}`);
    const plan = { id, manifest: { order: fronts.map((_, at) => at), entries: fronts.map((_, at) => `e${at + 1}`),
      bound: fronts.map((portrait, at) => ({ person: at, entry: `e${at + 1}`, portrait, slot: at + 1, facing: 'viewer', view: null })) },
    arms: { L: { prompt: `A made-up room. ${clauses.map(one => `${one}. `).join('')}${style}`, references: [] },
      'A+': { prompt: `A made-up room. ${clauses.map((one, at) => `a made-up look ${at + 1}${joints[at]}${one}. `).join('')}${style}`, references: [] },
      C: { prompt: `A made-up room. ${clauses.map((one, at) => `The person from image ${at + 1}${joints[at]}${one}. `).join('')}${style}`, references: fronts },
      T: { prompt: `${T_OPENING} ${fronts.map((_, at) => tClause(`the made-up holder ${at + 1}`, at + 2)).join('; ')}. ${style}`, references: ['L', ...fronts] } },
    out: {}, vIsC: true, portraits: fronts.map((portrait, at) => ({ id: portrait, entry: `e${at + 1}`, prompt: `a made-up front ${at + 1}` })), views: [], counts: {} };
    mkdirSync(storyDir(root, id), { recursive: true, mode: 0o700 });
    writeJson(join(storyDir(root, id), 'plan.json'), plan);
    for (const arm of ['L', 'A+', 'T', 'C'] as const) {
      put({ key: frameKey(id, SEED, arm), kind: 'frame', story: id, id: `${id}-s${SEED}-${arm}`, arm, references: 0 }, greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++));
    }
    for (const front of fronts) put({ key: `front:${front}`, kind: 'front', story: id, id: front, references: 0 }, greyPng(720, 1280, number++));
  }
  const sealed = storyDir(root, 'sharp-1');
  mkdirSync(join(sealed, 'pictures'), { recursive: true, mode: 0o700 });
  writeJson(join(sealed, 'plan.json'), { id: 'sharp-1', arms: { 'A+': { prompt: `A made-up room. ${word}, the made-up holder: holds on. ${style}`, references: [] } } });
  writeFileSync(join(sealed, 'pictures', `s${SEED}-A+.png`), greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++, 0, word), { mode: 0o600 });
  writeJson(join(root, 'draw.json'), round);
}
// The made-up bodies and heads, the same in every scene by slot, each body round its head: the first tall, the second a
// little less, the third about square and the fourth wide, so that each takes another of the four canvases, and each
// region after the first holds another person's head, and the flight's fifth person's where it lies on round one's A+.
const DRY_HEADS: Box[] = [[60, 20, 200, 180], [360, 60, 500, 220], [660, 100, 800, 260], [960, 140, 1100, 300]];
const DRY_BODIES: Box[] = [[40, 10, 280, 690], [330, 40, 700, 560], [600, 80, 1100, 600], [500, 120, 1260, 700]];
function madeUpMarks(dirs: Dirs, word: string, bodies: (id: string, at: number) => Box | undefined = (_, at) => DRY_BODIES[at]) {
  const boxes: Record<string, Record<string, Box>> = {}, marked: Record<string, Record<string, Box>> = {};
  const suit: Record<string, object> = {};
  let number = 3000;
  for (const id of BODY_SCENES) {
    boxes[id] = {};
    marked[id] = {};
    for (let at = 0; at < DRY_BOUND[id]; at++) {
      const front = `${id}-e${at + 1}`, body = bodies(front, at);
      boxes[id][front] = DRY_HEADS[at];
      if (body) marked[id][front] = body;
      if (!SUIT_SCENES.includes(id)) continue;
      const bytes = greyPng(720, 1280, number++), file = join('suit', `${front}.png`);
      mkdirSync(join(dirs.probe, 'suit'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dirs.probe, file), bytes, { mode: 0o600 });
      suit[`front:${front}`] = { key: `front:${front}`, kind: 'front', story: id, id: front, seed: SEED, status: 'drawn', file, sha256: sha256(bytes), width: 720, height: 1280 };
    }
  }
  writeFileSync(join(dirs.probe, 'boxes.json'), JSON.stringify({ canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, L: {}, 'A+': boxes, crops: {} }), { mode: 0o600 });
  writeJson(join(dirs.probe, 'probe.json'), { pins: {}, startedAt: new Date().toISOString(), scenes: {}, cells: {}, suit: { hash: sha256(word), cells: suit } });
  // The head test's record: two warm jobs, and a cold one the prices leave out.
  writeJson(join(dirs.heads, 'heads.json'), { cells: { 'a:p-native-080': { status: 'drawn', totalMs: 30000, uploadMs: 2000, cold: true },
    'a:p-crop-065': { status: 'drawn', totalMs: 9000, uploadMs: 600 }, 'a:p-crop-080': { status: 'drawn', totalMs: 5000 } } });
  const bytes = JSON.stringify({ canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, 'A+': marked });
  writeFileSync(join(dirs.out, BODIES_FILE), bytes, { mode: 0o600 });
  return sha256(bytes);
}
// What a mask chain makes, computed as local/fake-comfy.ts computes the pinned mask nodes, from the geometry rather
// than the graph: the fake's summary of a graph's mask must be this one.
function raster({ canvas, ops }: Chain): MaskSummary {
  const w = canvas.width, h = canvas.height, data = new Float32Array(w * h);
  for (const { op, rect, feather } of ops) {
    const { width: sw, height: sh } = sizeOf(rect), from = new Float32Array(sw * sh).fill(1);
    if (feather) {
      const [left, right, top, bottom] = [Math.min(feather.left, sw), Math.min(feather.right, sw), Math.min(feather.top, sh), Math.min(feather.bottom, sh)];
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        from[y * sw + x] *= (x < left ? (x + 1) / left : 1) * (sw - 1 - x < right ? (sw - x) / right : 1)
          * (y < top ? (y + 1) / top : 1) * (sh - 1 - y < bottom ? (sh - y) / bottom : 1);
      }
    }
    for (let y = rect[1]; y < Math.min(rect[1] + sh, h); y++) for (let x = rect[0]; x < Math.min(rect[0] + sw, w); x++) {
      const a = data[y * w + x], b = from[(y - rect[1]) * sw + x - rect[0]];
      data[y * w + x] = Math.min(1, Math.max(0, op === 'add' ? a + b : a - b));
    }
  }
  let nonzero = 0, full = 0, left = w, top = h, right = 0, bottom = 0;
  data.forEach((value, i) => {
    if (value <= 0) return;
    const x = i % w, y = Math.floor(i / w);
    nonzero++;
    if (value >= 1) full++;
    [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x + 1), Math.max(bottom, y + 1)];
  });
  return { width: w, height: h, nonzero, full, bounds: nonzero ? [left, top, right, bottom] : null };
}
// comfy-kitchen's lines as the pinned server logs them at its start with Triton on (local/image-pilot.ts's dry run).
const KITCHEN_LINES = ['WARNING: You need pytorch with cu130 or higher to use optimized CUDA operations.',
  'Found triton 3.4.0. Enabling comfy-kitchen triton backend.',
  'Found comfy_kitchen backend cuda: {\'available\': True, \'disabled\': True, \'unavailable_reason\': None, \'capabilities\': []}',
  'Found comfy_kitchen backend eager: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}',
  'Found comfy_kitchen backend triton: {\'available\': True, \'disabled\': False, \'unavailable_reason\': None, \'capabilities\': []}'];
const TRITON_ARGV = ['main.py', '--listen', '127.0.0.1', '--enable-triton-backend'];

// The whole test against local/fake-comfy.ts started as a Triton server, in `dir`: the made-up round in `round/`, the
// probe's boxes, suit fronts and record in `probe/`, the head test's times in `heads/`, the test's directory in
// `bodies/`, `tmp/` as the temporary directory. On the way, what the paid run relies on: the page before the card; a
// sealed story, the marker, a bodies.json other than the pinned one, a bound person without a body, a body that does
// not hold its head, an A+ prompt that does not read back, an A+ or a suit front other than the one recorded and a
// missing card record are refused before anything is sent or written; a body that cannot end by --until is not begun;
// the 46 jobs, each against its independent reading and what the fake made of its slot, start, masks and picture; the
// Triton pins, the compile's job and each canvas's first kept apart; the estimate counting every job; a resume drawing
// nothing again; a failed job recorded and the run going on; a socket that does not open waited out once, and one that
// never opens stopping the run; a resume on a server without Triton refused; the page's links and the files' modes;
// the plan where ImageMagick is installed; no prompt printed. The fake writes a made-up word into every picture's
// metadata, and the sealed story holds it: afterwards it is nowhere outside sealed/, in the temporary directory or in
// what was printed.
export async function dryRun(dir: string) {
  const dry = resolve(dir), temp = join(dry, 'tmp');
  const dirs: Dirs = { source: join(dry, 'round'), probe: join(dry, 'probe'), heads: join(dry, 'heads'), out: join(dry, 'bodies') };
  for (const path of [...Object.values(dirs), temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
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
  const word = madeUpName();
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
    say(`body-test dry run in ${dry}: a made-up round one and local/fake-comfy.ts started with Triton; no card, no model, no network`);
    const style = styleLine();
    writeCardRecord(join(dirs.out, 'card.txt'));
    madeUpRound(dirs.source, cardOf(join(dirs.out, 'card.txt')), word, style);
    const pinned = madeUpMarks(dirs, word);
    const started = await startFakeComfy({ jobMs: 30, referenceMs: 0, requireUploads: true, marker: word, argv: TRITON_ARGV, startupLog: KITCHEN_LINES });
    fake = started;
    origin = started.url;
    const events: object[] = [];
    const heard = (event: string) => events.filter(one => (one as { event?: string }).event === event).length;
    const draw = (extra: Partial<Options> = {}) => drawBodies({ dirs, comfy: origin, until: Date.now() + 3600000, ids: BODY_SCENES, pinned, pollMs: 10, waitMs: 60000,
      timeoutMs: 10000, log: event => events.push(event), ...extra });
    const inputs = inputsOf(dirs, BODY_SCENES, pinned), all = jobsOf(inputs.bodies), people = inputs.bodies.length;
    const suited = inputs.bodies.filter(b => b.suit).length, estimate = estimateOf(inputs);
    say(`0 plan: ${people} bodies, ${all.length} jobs (${estimate.fronts.jobs} fronts, ${estimate.suit.jobs} suit) on ${estimate.shapes} canvases; `
      + `${estimate.expectedMinutes} and ${estimate.pricedMinutes} minutes at the made-up head test's times; shapes by slot `
      + `${inputs.bodies.filter(b => b.scene.id === 'flight').map(b => b.shape.id).join(', ')}`);
    expect(people === 19 && suited === 8 && all.length === 46 && estimate.jobs === 46 && estimate.shapes === 4
      && same(inputs.bodies.filter(b => b.scene.id === 'flight').map(b => b.shape.id), SHAPES.map(one => one.id)) && inputs.prices.from === 2
      && inputs.bodies.every(b => b.gain > 1), '19 bodies, 8 of them with suit fronts, 46 jobs on the four canvases, each body gaining pixels');
    const flight2 = inputs.bodies.find(b => b.id === 'flight-e2')!;
    expect(flight2.words.joint === ': ' && inputs.bodies.find(b => b.id === 'flight-e1')!.words.joint === ', '
      && flight2.kept.length === 2 && inputs.bodies.find(b => b.id === 'flight-e4')!.kept.length === 3,
    'a clause with no words ahead of its action joined with ": ", and every other head and the unbound one kept where they meet a region');
    writePage(dirs, inputs, undefined);
    const before = readFileSync(join(dirs.out, 'index.html'), 'utf8');
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length;
    const rowFigures = people * 4 + suited * 2, frameFigures = BODY_SCENES.length + all.length;
    say(`1 the page before the card: ${figures(before)} figures, ${(before.match(/<rect /g) ?? []).length} rectangles`);
    expect(figures(before) === rowFigures + frameFigures && !existsSync(join(dirs.out, INDEX_FILE)), 'the page before the card shows every body\'s row and frame');

    say('2 refusals before anything is sent or written:');
    await refused('a sealed story', () => draw({ ids: ['tango', 'sharp-1'] }));
    await refused('the marker story', () => draw({ ids: [MARKER_STORY.id] }));
    await refused('a bodies.json other than the pinned one', () => draw({ pinned: sha256('another bodies.json') }));
    const kept = readFileSync(join(dirs.out, BODIES_FILE));
    const unboxed = madeUpMarks(dirs, word, (front, at) => (front === 'guard-e2' ? undefined : DRY_BODIES[at]));
    await refused('a bound person without a body', () => draw({ pinned: unboxed }));
    const headless = madeUpMarks(dirs, word, (front, at) => (front === 'tango-e1' ? DRY_BODIES[1] : DRY_BODIES[at]));
    await refused('a body that does not hold its head', () => draw({ pinned: headless }));
    madeUpMarks(dirs, word);
    expect(readFileSync(join(dirs.out, BODIES_FILE)).equals(kept), 'the made-up bodies.json written again as it was');
    const planFile = join(storyDir(dirs.source, 'giants'), 'plan.json'), plan = readFileSync(planFile);
    const lookless = JSON.parse(plan.toString('utf8')) as StoryPlan;
    lookless.arms['A+']!.prompt = lookless.arms['A+']!.prompt.replace('a made-up look 2', '');
    writeJson(planFile, lookless);
    await refused('an A+ prompt that does not read back as L with the looks', () => draw());
    writeFileSync(planFile, plan);
    const aPlusFile = fileOf(dirs.source, { kind: 'frame', story: 'tango', id: '', seed: SEED, arm: 'A+' }), aPlus = readFileSync(aPlusFile);
    writeFileSync(aPlusFile, greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, 1));
    await refused('an A+ that is not the picture round one recorded', () => draw());
    writeFileSync(aPlusFile, aPlus);
    const suitFile = join(dirs.probe, 'suit', 'demon-e3.png'), suit = readFileSync(suitFile);
    writeFileSync(suitFile, greyPng(720, 1280, 2));
    await refused('a suit front that is not the one the probe recorded', () => draw());
    writeFileSync(suitFile, suit);
    const card = readFileSync(join(dirs.out, 'card.txt'));
    unlinkSync(join(dirs.out, 'card.txt'));
    await refused('a missing card record', () => draw());
    writeFileSync(join(dirs.out, 'card.txt'), card, { mode: 0o600 });
    expect(started.jobs.length === 0 && started.uploads.length === 0 && !existsSync(join(dirs.out, INDEX_FILE)), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`3 five seconds left: stopped ${short.stopped}, ${started.jobs.length} jobs sent`);
    expect(short.stopped === 'until' && started.jobs.length === 0 && sent.length === 0, 'a body that cannot end by --until is not begun');

    const first = await draw(), afterFirst = started.jobs.length;
    const again = await draw();
    say(`4 a run: ${afterFirst} jobs, ${countsOf(first).drawn} drawn; again: ${started.jobs.length - afterFirst} more; failed ${JSON.stringify(countsOf(again).failed)}`);
    expect(afterFirst === 46 && started.jobs.length === 46 && countsOf(again).drawn === 46 && !again.stopped && !again.error, '46 jobs, then none again');

    // Each job against its body and variant, in the order drawn.
    const named = (input: Input) => `ref-${sha256(stripPngMetadata(input.bytes)).slice(0, 16)}.png`;
    const wrong: string[] = [];
    all.forEach(({ body: b, variant: v }, at) => {
      const graph = sent[at], job: FakeJob | undefined = started.jobs[at], masks = masksOf(b);
      const names = { aPlus: named(b.scene.aPlus), front: named(v.image === 'suit' ? b.suit! : b.front) };
      const built = buildJob({ ...inputs, card: cardOf(join(dirs.out, 'card.txt')), pins: {} }, b, v, names);
      const noise = raster(masks.noise), paste = raster(masks.paste), cell = again.cells[cellKey(b.id, v.id)];
      const right = graph !== undefined && same(built.graph, graph) && bodyRight(graph, b, v, names, inputs.style) && job?.outcome === 'success'
        && same(job.slots, [{ slot: 1, file: names.front, scaled: FRONT_SIZE, cropped: null }]) && job.start === null
        && same(job.noiseMask, noise) && noise.full === noise.nonzero && same(noise.bounds, b.cropRegion)
        && job.composites.length === 1 && job.composites[0].destination === names.aPlus && same(job.composites[0].mask, paste)
        && same(job.images, [{ node: '9', ...FRAME_CANVAS }]) && cell?.status === 'drawn' && cell.width === FRAME_CANVAS.width
        && cell.height === FRAME_CANVAS.height && cell.denoise === v.denoise && cell.file === fileKey(b, v) && existsSync(join(dirs.out, cell.file))
        && same(again.layout?.[b.id], { scene: b.scene.id, slot: b.slot, shape: `${b.shape.canvas.width}x${b.shape.canvas.height}`,
          crop: [b.crop.x, b.crop.y, b.crop.width, b.crop.height], box: b.box, region: rectOf(b.region), kept: b.kept });
      if (!right) wrong.push(cellKey(b.id, v.id));
    });
    say(`   jobs against their reading and the fake's: ${all.length - wrong.length} of ${all.length} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    say('   each: the graph built, read back independently, the fake\'s slot (the front, 576x1024, whole), start, noise and paste masks against the '
      + 'geometry\'s, a 1280x704 picture; seed 7, 25 steps euler/simple, CFG 1, the variant\'s denoise, no DifferentialDiffusion');
    expect(!wrong.length && sent.length === 46, 'every job sends its own graph');
    const order = all.map(job => job.variant.image);
    expect(order.lastIndexOf('front') < order.indexOf('suit'), 'every front job before the suit\'s');

    const cells = Object.values(again.cells), kitchen = again.kitchen;
    const cold = cells.filter(one => one.cold).map(one => one.key), shapes = cells.filter(one => one.firstOfShape).map(one => one.key);
    say(`5 Triton: server pins ${JSON.stringify(again.server)}, log ${JSON.stringify(kitchen)}; cold ${cold.join(', ')}; first on a canvas ${shapes.join(', ')}`);
    expect(again.server.triton === 'enabled' && again.triton && cells.every(one => one.triton) && kitchen?.seen === true && kitchen.argv && kitchen.tritonImported
      && kitchen.backend?.available === true && kitchen.backend.disabled === false && same(cold, ['flight-e1:front-065'])
      && same(shapes, ['flight-e1:front-065', 'flight-e2:front-065', 'flight-e3:front-065', 'flight-e4:front-065']),
    'the pins say Triton, and the compile\'s jobs are kept apart');

    // A job the card fails: recorded, and the run goes on.
    const outOf = (name: string): Dirs => {
      const out = join(dry, name);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      writeFileSync(join(out, 'card.txt'), card, { mode: 0o600 });
      writeFileSync(join(out, BODIES_FILE), kept, { mode: 0o600 });
      return { ...dirs, out };
    };
    const beforeFailed = started.jobs.length;
    started.options.failJobs = [started.jobs.length + 2];
    const failed = await draw({ dirs: outOf('failed'), ids: ['guard'] });
    started.options.failJobs = [];
    const failedCells = Object.values(failed.cells).filter(one => one.status === 'failed');
    say(`6 a job the card fails: ${started.jobs.length - beforeFailed} jobs, drawn ${countsOf(failed).drawn}, failed ${JSON.stringify(countsOf(failed).failed)}, `
      + `stopped ${failed.stopped ?? failed.error ?? 'no'}`);
    expect(started.jobs.length - beforeFailed === 4 && countsOf(failed).drawn === 3 && failedCells.length === 1 && failedCells[0].key === 'guard-e1:front-080'
      && !failed.stopped && !failed.error, 'a failed job is recorded and the others are drawn');

    // A socket that does not open in time, once: waited out, and the job drawn.
    const beforeRetry = started.jobs.length;
    started.options.openDelayMs = 2500;
    const retried = await draw({ dirs: outOf('retry'), ids: ['guard'], log: event => {
      events.push(event);
      if ((event as { event?: string }).event === 'socket_retry') started.options.openDelayMs = 0;
    } });
    const retries = heard('socket_retry');
    say(`7 a socket that opens late once: ${retries} retry, ${started.jobs.length - beforeRetry} jobs, drawn ${countsOf(retried).drawn}, `
      + `retried ${Object.values(retried.cells).filter(one => one.retried).map(one => one.key).join(', ')}`);
    expect(retries === 1 && started.jobs.length - beforeRetry === 4 && countsOf(retried).drawn === 4 && retried.cells['guard-e1:front-065']?.retried === true
      && !retried.error, 'a late socket is waited out once');

    // One that never opens: the retry fails too, and the run stops before anything reached the card.
    const beforeStop = started.jobs.length;
    events.length = 0;
    started.options.openDelayMs = 2500;
    const stopped = await draw({ dirs: outOf('socket'), ids: ['guard'] });
    started.options.openDelayMs = 0;
    say(`8 a socket that never opens: ${heard('socket_retry')} retry, ${started.jobs.length - beforeStop} jobs, error ${stopped.error ?? 'none'}, `
      + `failed ${JSON.stringify(countsOf(stopped).failed)}`);
    expect(started.jobs.length === beforeStop && stopped.error === 'comfy_socket_unavailable' && countsOf(stopped).failed.comfy_socket_unavailable === 1
      && countsOf(stopped).drawn === 0, 'a socket that never opens stops the run');

    // A resume on a server that no longer runs Triton.
    started.options.argv = ['main.py', '--listen', '127.0.0.1'];
    say('9 a resume on another server:');
    await refused('a server without Triton', () => draw());
    started.options.argv = TRITON_ARGV;

    say(`10 the fake held at most ${started.mostHeld} job at once; ${strays} calls to anything but the fake`);
    expect(started.mostHeld === 1 && strays === 0, 'one job at a time, and the fake alone');

    const page = readFileSync(join(dirs.out, 'index.html'), 'utf8'), links = [...new Set([...page.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = mode(dirs.out) === 0o700 && mode(join(dirs.out, INDEX_FILE)) === 0o600 && mode(join(dirs.out, 'index.html')) === 0o600
      && inputs.bodies.every(b => mode(join(dirs.out, b.scene.id)) === 0o700 && mode(join(dirs.out, b.scene.id, b.id)) === 0o700
        && BODY_VARIANTS.filter(v => v.image === 'front' || b.suit).every(v => mode(join(dirs.out, fileKey(b, v))) === 0o600));
    say(`11 page: ${figures(page)} figures, ${links.length} links, ${links.filter(link => existsSync(resolve(dirs.out, link))).length} where they lead; `
      + `Triton on the page: ${page.includes('Triton: включён')}; directories 700 and files 600: ${modes}`);
    expect(figures(page) === rowFigures + frameFigures && links.length === BODY_SCENES.length + people + suited + all.length
      && links.every(link => existsSync(resolve(dirs.out, link))) && page.includes('Triton: включён') && !page.includes('не нарисовано') && modes,
    'the page shows every body\'s row and frame and links every picture');

    const magick = spawnSync('convert', ['-version'], { stdio: 'ignore' }).status === 0;
    if (magick) {
      const file = join(dirs.out, 'plan.png'), rows = planPanel(dirs, inputs, file), size = pngSize(readFileSync(file));
      say(`12 plan: ${rows} rows, ${size.width}x${size.height}`);
      expect(rows === people && size.height === people * (ROW_HIGH + 6), 'the plan has a row for every body');
    } else say('12 plan: skipped, ImageMagick\'s convert is not installed');

    const text = output.text();
    const prompts = inputs.bodies.map(b => promptOf(b.words, inputs.style));
    const leaked = prompts.filter(prompt => [0, Math.floor(prompt.length / 2)].some(at => text.includes(prompt.slice(at, at + 40)))).length
      + inputs.bodies.filter(b => text.includes(b.words.clause.slice(0, 24))).length;
    say(`13 prompts in what was printed: ${leaked}`);
    expect(leaked === 0, 'no prompt printed');

    const found = searchBoundary({ root: dry, sealed: join(dirs.source, 'sealed'), tempDir: temp, word, output: output.text() });
    const inside = searchTree(join(dirs.source, 'sealed'), markerForms(word)).hits.length;
    say(`14 boundary: ${found.files} files outside sealed/, ${found.unread} unread: hits ${JSON.stringify({ files: found.hits.files.length, temp: found.hits.temp, output: found.hits.output })}; `
      + `the word is in ${inside} files inside sealed/`);
    expect(inside > 0, 'the word inside sealed/');
    expect(found.pass, 'the word nowhere outside sealed/');
    say(missed.length ? `the body test's dry run did NOT go as expected: ${missed.length} of its checks` : 'the body test\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

// The live commands read round one, the probe and the head test and write the test's directory where they lie: a link
// on the way could lead into a sealed/ or out of the owner's reach.
function liveDirs() {
  for (const path of [join(ROOT, 'illustrations'), SOURCE_DIR, join(SOURCE_DIR, 'clean'), PROBE_DIR, HEADS_DIR, OUT_DIR]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${relative(ROOT, path)} is a link: the test reads and writes only where round one, the probe and the head test lie`);
  }
}
const list = (value: string | undefined) => value?.split(',').map(part => part.trim()).filter(Boolean);

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' }, scenes: { type: 'string' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-body-test-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (values.dir !== undefined) throw new Refusal('Only dry-run takes --dir: the test reads illustrations/action-1 and writes illustrations/t-probe-bodies');
  liveDirs();
  const ids = list(values.scenes) ?? BODY_SCENES;
  if (!ids.length || ids.some(id => !BODY_SCENES.includes(id))) throw new Refusal(`--scenes takes ${BODY_SCENES.join(', ')}, comma separated`);
  if (command === 'estimate') {
    print({ event: 'estimate', ...estimateOf(inputsOf(LIVE, ids, BODIES_SHA256)) });
  } else if (command === 'plan') {
    const file = join(OUT_DIR, 'plan.png'), rows = planPanel(LIVE, inputsOf(LIVE, ids, BODIES_SHA256), file);
    print({ event: 'plan', file: relative(ROOT, file), bodies: rows });
  } else if (command === 'page') {
    writePage(LIVE, inputsOf(LIVE, ids, BODIES_SHA256), readJson<BodiesIndex>(join(OUT_DIR, INDEX_FILE)));
    print({ event: 'page', file: relative(ROOT, join(OUT_DIR, 'index.html')) });
  } else if (command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --until <epoch seconds, five minutes before the card\'s end> [--scenes flight,...] [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawBodies({ dirs: LIVE, comfy: comfyUrl(values.comfy!), until, ids, pinned: BODIES_SHA256, waitMs: wait * 1000, timeoutMs: timeout * 1000,
      log: print });
    if (index.error || index.stopped) process.exitCode = 1;
  } else throw new Refusal('Use: image-body-test.ts estimate|plan|draw|page|dry-run (docs/action-experiment.md#body-test)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
