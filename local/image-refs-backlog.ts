// The backlog for the next picture card (docs/action-experiment.md#refs-backlog): two stands that draw in the gaps
// on a card the owner rents for the live tester, so that it never idles. The tester's frames go first: the bot sends
// them with ComfyUI's `front`, and the stands send one job at a time without it, so a tester's frame waits at most for
// the one cell being drawn.
//   The third stand, two and three people with references, the owner's next priority: H and L as the first stand drew
//   them, and B, a tall heavyset man, and T, a short slim woman, whose fronts it draws first with the bot's portrait
//   prompt and clothes. The first stand's K-pair, and K-trio, where B sits on the bench, H stands with a lantern and T
//   stands behind the bench with a hand on his shoulder, at seeds 43, 47, 53, 59, 61 and 67:
//     W   no picture, each person's look in words, the floor;
//     R   each person's front at 352x640 and the bot's wording of 47f7f80 with the look (local/picture-references.ts);
//     S   scene first, the owner's three steps: W's picture as the draft; the edit, the draft as image 1 and the fronts
//         after it, sampled from VAEEncode of the draft at denoise 0.55 (S2-55) or 0.8 (S2-80); and the cleanup, the
//         edit's picture at 0.3 with W's words and no picture (S3-55, S3-80);
//     FC  the top 720x400 of each front as the face, the figure from the words;
//     FV  each person's front and the view of the fourth stand turned as the scene turns them, all at 352x640.
//   R against W at every seed first, so that a short gap still leaves whole comparisons, then S, which W's pictures
//   start, then FC, then FV.
//   The fourth stand, views drawn from the front, which FV and pose picking need: each person three-quarters, in
//   profile, from behind and sitting, on the side the scenes turn them, from the front alone at 720x1280 with the
//   portrait's backdrop and clothes, at seeds 7, 11, 13 and 17; FV's four views first.
// Both draw on the bot's picture path through local/image-refs-test.ts, which prices, draws, records and pages every
// cell. `drawBacklog` draws them in turn on one card: the third stand up to FV, the four views FV takes, FV, then the
// rest of the views, each begun only if it can end by --until. A start on the next card goes on where the last
// stopped, with every picture uploaded again from the run directories. build-texts.ts in
// ~/simple-story-chat-runs/2026-09-28/refs-backlog writes each stand's texts.json and judge-questions.json, and this
// file pins both texts.
//   estimate  the cells, the minutes at tonight's timings and at the admission prices, what arm S adds to a frame
//   dry-run   the real texts, every graph built from them, then the whole backlog against local/fake-comfy.ts, a card
//             that goes away in the middle of it and another that takes over
//   draw      on the card, --stand3 DIR --stand4 DIR --from <the first stand's DIR> --until EPOCH
//   page      each stand's DIR/index.html
// What it prints is keys, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { apiGraph, applyToWorkflow, comfyUrl, pngSize, referenceGeometry, stripPngMetadata, withAttention } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { ACTION_GRAPH, FRAME_CANVAS, FRONT_GRAPH, SCALED, actionGraph } from './action-draw.ts';
import { referenceGraph } from './picture-references.ts';
import { STYLE } from './illustrate.ts';
import { PORTRAIT_STYLE } from './image-portraits.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { kitchenLines } from './image-pilot.ts';
import { readJson } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { BY_KEY, CROP, FRONT_CANVAS, INDEX_FILE, PLANNED, SCENE_WORDS, TEXTS_FILE, TEXTS_SHA256, TRITON_ARGV, attentionInfo, buildJob, cellOf,
  cellRight, countsOf, drawStand, estimateOf, frameKey, frontKey, inputsOf, setupOf, sizeText, slotChains, tokenReport, writePage } from './image-refs-test.ts';
import type { Group, How, Planned, Ref, Section, Size, Stand, StandIndex, TextCell, Warmth } from './image-refs-test.ts';

const ROOT = resolve(import.meta.dirname, '..');
// Each stand's texts.json as ~/simple-story-chat-runs/2026-09-28/refs-backlog/build-texts.ts wrote it, byte for byte.
export const TEXTS_SHA256_3 = '68fe56218d01184ae9fbe11d2e76088b6abf6c67fa919dca8ff63b5ee29dc2ff';
export const TEXTS_SHA256_4 = '00e57ba428636fc440af8649c2c8029481538859c5c1bbfacdb43a43acf6931e';
// The Qwen edit graph, which the action graph is with a seventh slot: a cell drawn on either sends the same graph.
const EDIT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen-edit.json');
// The picture card's rate on 2026-09-27, as the refs stand's estimate prices it.
const RATE = 0.605;
// The longest --until: a card rented for the tester may stay the evening.
const LONGEST_MS = 12 * 3600000;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
const minutes = (ms: number) => Math.round(ms / 6000) / 10;

// ---- The plan ----

export const SEEDS_3 = [43, 47, 53, 59, 61, 67];
export const SEEDS_4 = [7, 11, 13, 17];
type Scene3 = 'K-pair' | 'K-trio';
const SCENES_3: Scene3[] = ['K-pair', 'K-trio'];
// The people by their fronts at seed 7: H's and L's the first stand's, B's and T's the third stand's own. A scene names
// its people in its cast's order, and a frame's references follow it.
type Person = 'H' | 'L' | 'B' | 'T';
const PEOPLE: Person[] = ['H', 'L', 'B', 'T'];
export const FRONTS: Record<Person, string> = { H: frontKey('H-PORTRAIT'), L: frontKey('L-PORTRAIT'), B: frontKey('B-PORTRAIT'), T: frontKey('T-PORTRAIT') };
export const CAST: Record<Scene3, Person[]> = { 'K-pair': ['H', 'L'], 'K-trio': ['H', 'B', 'T'] };
// The views: each person three-quarters (TQ), in profile (P), from behind (BACK) and sitting (SIT), turned toward the
// side of the picture the scenes turn them to: H and B to the right, L and T to the left.
const TURNS = ['TQ', 'P', 'BACK', 'SIT'] as const;
type Turn = typeof TURNS[number];
export const SIDES: Record<Person, 'R' | 'L'> = { H: 'R', L: 'L', B: 'R', T: 'L' };
export const viewId = (person: Person, turn: Turn) => `${person}-${turn}${turn === 'BACK' ? '' : SIDES[person]}`;
export const viewKeyOf = (id: string, seed: number) => `view:${id}:s${seed}`;
// FV's view of each person, of seed 7, as the scene turns them: H three-quarters to the right in both scenes, L
// three-quarters to the left in the pair, B sitting three-quarters to the right and T three-quarters to the left in
// the trio.
export const NEAREST: Record<Scene3, string[]> = { 'K-pair': [viewKeyOf(viewId('H', 'TQ'), 7), viewKeyOf(viewId('L', 'TQ'), 7)],
  'K-trio': [viewKeyOf(viewId('H', 'TQ'), 7), viewKeyOf(viewId('B', 'SIT'), 7), viewKeyOf(viewId('T', 'TQ'), 7)] };
// Arm S's levels. The pinned KSampler runs the last 25 steps of a schedule of int(25 / denoise) (comfy/samplers.py
// 1431-1441), so at Qwen Image 2.1's shift of 0.69 the edit begins at sigma 0.893 at 0.8, where a frame from noise is
// after about 5 of its 25 steps and has its layout but not yet its figures, and at 0.714 at 0.55, after about 11, with
// the outlines set; the cleanup at 0.3 begins at 0.462, after about 17 of 25, where detail, colour and light are drawn.
export const S_LEVELS = [{ id: '55', denoise: 0.55 }, { id: '80', denoise: 0.8 }];
export const CLEAN_DENOISE = 0.3;
const at = (from: string, how: How): Ref => ({ from, how });

// B's and T's fronts; then, seed by seed and scene by scene, W and R; S's four cells; FC; FV.
function planOf3(): Planned[] {
  const out: Planned[] = [];
  const fronts = (scene: Scene3, how: How) => CAST[scene].map(person => at(FRONTS[person], how));
  const frame = (id: string, arm: string, scene: Scene3, seed: number, refs: Ref[], start?: { from: string; denoise: number }) => out.push(cellOf({
    key: frameKey(id, scene, seed), id, arm, kind: 'frame', scene, seed, graph: 'action', canvas: FRAME_CANVAS, cfg: 1, negative: 'none', refs,
    ...(start ? { start: start.from, denoise: start.denoise } : {}) }));
  const each = (draw: (scene: Scene3, seed: number) => void) => { for (const seed of SEEDS_3) for (const scene of SCENES_3) draw(scene, seed); };
  for (const person of ['B', 'T'] as const) {
    out.push(cellOf({ key: FRONTS[person], id: `${person}-PORTRAIT`, arm: 'front', kind: 'front', seed: 7, graph: 'front', canvas: FRONT_CANVAS, cfg: 1,
      negative: 'none', refs: [] }));
  }
  each((scene, seed) => {
    frame('W', 'W', scene, seed, []);
    frame('R', 'R', scene, seed, fronts(scene, 's352'));
  });
  each((scene, seed) => {
    const draft = frameKey('W', scene, seed);
    for (const level of S_LEVELS) {
      frame(`S2-${level.id}`, 'S', scene, seed, [at(draft, 'own'), ...fronts(scene, 's352')], { from: draft, denoise: level.denoise });
      frame(`S3-${level.id}`, 'S', scene, seed, [], { from: frameKey(`S2-${level.id}`, scene, seed), denoise: CLEAN_DENOISE });
    }
  });
  each((scene, seed) => frame('FC', 'FC', scene, seed, fronts(scene, 'crop')));
  each((scene, seed) => frame('FV', 'FV', scene, seed, CAST[scene].flatMap((person, n) => [at(FRONTS[person], 's352'), at(NEAREST[scene][n], 's352')])));
  return out;
}
// FV's four views at seed 7, then the other twelve of seed 7, then the sixteen of each later seed.
function planOf4(): Planned[] {
  const views = (seed: number) => PEOPLE.flatMap(person => TURNS.map(turn => cellOf({ key: viewKeyOf(viewId(person, turn), seed), id: viewId(person, turn),
    arm: turn, kind: 'view', seed, graph: 'action', canvas: FRONT_CANVAS, cfg: 1, negative: 'none', refs: [at(FRONTS[person], 'own')] })));
  const nearest = new Set(Object.values(NEAREST).flat());
  return [...views(7).filter(one => nearest.has(one.key)), ...views(7).filter(one => !nearest.has(one.key)), ...SEEDS_4.slice(1).flatMap(views)];
}
export const PLANNED_3 = planOf3();
export const PLANNED_4 = planOf4();
const BY_KEY_3 = new Map(PLANNED_3.map(one => [one.key, one])), BY_KEY_4 = new Map(PLANNED_4.map(one => [one.key, one]));

const COLUMNS_3 = ['W', 'R', 'S2-55', 'S3-55', 'S2-80', 'S3-80', 'FC', 'FV'];
const NOTES_3: Record<Scene3, string> = {
  'K-pair': 'Пара первого стенда: H вешает фонарь на ветку, L протягивает ей второй. W: без картинок, внешность словами. R: фронты 352x640 и формулировка бота '
    + 'с внешностью. S2: кадр W как картинка 1 и фронты после него, из VAEEncode кадра W при denoise 0,55 или 0,8. S3: кадр S2 при denoise 0,3 со словами W, '
    + 'без картинок. FC: верх фронта 720x400 как лицо, фигура словами. FV: фронт и ближний вид каждого, 352x640.',
  'K-trio': 'H стоит слева с фонарём, B сидит на скамье, T стоит за скамьёй справа и положила руку ему на плечо. Столбцы как у пары; в FV у B вид сидя.',
};
const TURN_WORDS: Record<Turn, string> = { TQ: 'три четверти', P: 'профиль', BACK: 'спиной', SIT: 'сидя' };
const SECTIONS_3: Section[] = [
  { title: 'Фронты B и T', note: 'Промпт портрета бота с подробностями, костюм портрета, 720x1280, сид 7. H и L взяты из первого стенда.',
    columns: ['сид 7'], rows: (['B', 'T'] as const).map(person => ({ label: person, keys: [FRONTS[person]] })) },
  ...SCENES_3.map(scene => ({ title: SCENE_WORDS[scene][0].toUpperCase() + SCENE_WORDS[scene].slice(1), note: NOTES_3[scene], columns: COLUMNS_3,
    rows: SEEDS_3.map(seed => ({ label: `сид ${seed}`, keys: COLUMNS_3.map(id => frameKey(id, scene, seed)) })) })),
];
const SECTIONS_4: Section[] = PEOPLE.map(person => ({ title: `Виды ${person}`,
  note: `С фронта ${person} сида 7, единственной картинки, 720x1280, фон и костюм портрета; повёрнут ${SIDES[person] === 'R' ? 'вправо' : 'влево'}, как в сценах.`,
  columns: TURNS.map(turn => TURN_WORDS[turn]), rows: SEEDS_4.map(seed => ({ label: `сид ${seed}`, keys: TURNS.map(turn => viewKeyOf(viewId(person, turn), seed)) })) }));
const INTRO = 'Рисуется в промежутках на карте тестера, по одному заданию и без front, так что кадр тестера ждёт не дольше одной ячейки. Путь бота: cu130, '
  + 'Triton, внимание кухни, 25 шагов euler, CFG 1. Синтетические люди: H и L первого стенда, B, высокий полный мужчина, и T, невысокая худая женщина.';
export const STAND_3: Stand = { plan: PLANNED_3, title: 'Третий стенд референсов: двое и трое', sections: SECTIONS_3, date: '2026-09-28', others: PLANNED_4,
  pinEach: true, cards: true, intro: `${INTRO} Сиды 43, 47, 53, 59, 61 и 67.` };
export const STAND_4: Stand = { plan: PLANNED_4, title: 'Четвёртый стенд: виды с фронта', sections: SECTIONS_4, date: '2026-09-28', others: PLANNED_3,
  pinEach: true, cards: true, intro: `${INTRO} Виды рисует Qwen с фронта как единственной картинки, сиды 7, 11, 13 и 17.` };

// ---- The prices ----

// Tonight's warm medians, a cell's whole time with the queue as the socket saw it, the uploads apart: the refs
// stand's and the second's on 2026-09-27, on an RTX 5090. A front 4984 ms, a view 6482 (at 704x1280; one at 720x1280
// is priced the same), a frame from words 5030, one with two fronts at 352x640 5655 (5232 and 6078 on the two
// stands). The groups neither drew are priced from what their pictures add there: about 250 ms a picture at 352x640 or
// a face crop, 1.45 s one at its own size (a view against words), and 250 ms the VAEEncode a frame starts from. Arm
// S's edit is a frame with its draft at its own size, two or three fronts and a VAEEncode; its cleanup a frame from
// words with a VAEEncode. Every step of S samples 25 steps, whatever its denoise.
export const TONIGHT_MS: Partial<Record<Group, number>> = { front: 4984, view: 6482, words: 5030, ref2: 5655, ref3: 5900, ref4: 6150, ref6: 6650,
  crop2: 5650, crop3: 5900, edit2: 7250, edit3: 7500, clean: 5280 };
// The upload of the picture an edit or a cleanup starts from (tonight's took 670 to 950 ms), the first job's compile
// beyond a warm front (19.1 s against 5.0), and a group's first job beyond its warm median (up to 2.8 s tonight).
const UPLOAD_MS = 800, COMPILE_MS = 14000, FIRST_MS = 2000;
// The coordinator's range for a cell at CFG 1 on tonight's card.
export const FLAT_SECONDS = [5.5, 6.1];

// Each stand and both: the cells by arm; the minutes at 5.5 and 6.1 s a cell; at tonight's time of each cell's group,
// with the uploads of the pictures S starts from, one compile and a first job a group; and at the admission prices
// the runner begins a cell by, which only the last cells before --until meet. Arm S apart: each step's cells and
// seconds, and what a frame drawn in S's three steps costs beside R's one.
export function backlogEstimate(rate = RATE) {
  const tonight = (plan: Planned[]) => plan.reduce((sum, one) => sum + TONIGHT_MS[one.group]! + (one.start === undefined ? 0 : UPLOAD_MS), 0)
    + COMPILE_MS + new Set(plan.map(one => one.group)).size * FIRST_MS;
  const dollars = (ms: number) => Math.round(minutes(ms) / 60 * rate * 100) / 100;
  const stand = (plan: Planned[]) => {
    const flat = FLAT_SECONDS.map(seconds => plan.length * seconds * 1000), byGroup = tonight(plan), admission = estimateOf(rate, 0, 600, plan);
    return { cells: plan.length, arms: admission.arms, flatMinutes: flat.map(minutes), tonightMinutes: minutes(byGroup), admissionMinutes: admission.pricedMinutes,
      dollars: { flat: flat.map(dollars), tonight: dollars(byGroup) } };
  };
  const seconds = (ms: number) => Math.round(ms / 100) / 10;
  const cells = (group: Group) => PLANNED_3.filter(one => one.group === group).length;
  const card = (group: Group) => TONIGHT_MS[group]!;
  // A frame on the card, the uploads apart: R's as tonight, and S's as W, the edit and the cleanup, or the first two.
  const frame = (r: Group, edit: Group) => {
    const s = card('words') + card(edit) + card('clean'), s2 = card('words') + card(edit);
    return { R: seconds(card(r)), S: seconds(s), addedOverR: seconds(s - card(r)), times: Math.round(s / card(r) * 10) / 10,
      withoutCleanup: seconds(s2), withoutCleanupAdded: seconds(s2 - card(r)) };
  };
  return { stand3: stand(PLANNED_3), stand4: stand(PLANNED_4), both: stand([...PLANNED_3, ...PLANNED_4]), dollarsPerHour: rate, frameSecondsFlat: FLAT_SECONDS,
    armS: { draft: 'W\'s picture of the same seed, drawn anyway: nothing more',
      edit: { cells: { pair: cells('edit2'), trio: cells('edit3') }, seconds: { pair: seconds(card('edit2') + UPLOAD_MS), trio: seconds(card('edit3') + UPLOAD_MS) },
        minutes: minutes(cells('edit2') * (card('edit2') + UPLOAD_MS) + cells('edit3') * (card('edit3') + UPLOAD_MS)) },
      cleanup: { cells: cells('clean'), seconds: seconds(card('clean') + UPLOAD_MS), minutes: minutes(cells('clean') * (card('clean') + UPLOAD_MS)) },
      frame: { pair: frame('ref2', 'edit2'), trio: frame('ref3', 'edit3'), uploads: 'S uploads the draft and the edit on top of R\'s references, 0.7 to 0.9 s each' } } };
}

// ---- The drawing ----

// The backlog's order on one card, each step a run of drawStand: the third stand up to FV, the four views FV takes,
// FV, then the rest of the views. Each step skips what is drawn, so the next card's start goes on where this one
// stopped.
const FV_VIEWS = [...new Set(Object.values(NEAREST).flat())];
export const STEPS: { stand: 3 | 4; keys?: string[] }[] = [{ stand: 3, keys: PLANNED_3.filter(one => one.arm !== 'FV').map(one => one.key) },
  { stand: 4, keys: FV_VIEWS }, { stand: 3 }, { stand: 4 }];
type BacklogOptions = { stand3: string; stand4: string; first: string; comfy: string; until: number; pinned3?: string; pinned4?: string; timeoutMs?: number;
  waitMs?: number; pollMs?: number; warm?: Warmth; log: (event: object) => void };
// The steps in turn with one --until and one warmth, so that neither a step nor a stand pays the card's compile again.
// Both stands' texts and card records are checked before anything is sent; each step takes the first stand's pictures
// and the other stand's. The first step that ends by --until or with an error ends the backlog.
export async function drawBacklog(options: BacklogOptions): Promise<{ ended: 'done' | 'until' | 'stopped'; error?: string }> {
  const dirs = { 3: resolve(options.stand3), 4: resolve(options.stand4) }, pinned = { 3: options.pinned3 ?? TEXTS_SHA256_3, 4: options.pinned4 ?? TEXTS_SHA256_4 };
  setupOf(dirs[3], pinned[3], PLANNED_3);
  setupOf(dirs[4], pinned[4], PLANNED_4);
  const warm: Warmth = options.warm ?? { reached: false, groups: new Set() };
  for (const [n, step] of STEPS.entries()) {
    const plan = step.stand === 3 ? PLANNED_3 : PLANNED_4;
    options.log({ event: 'backlog_step', step: n + 1, stand: step.stand, cells: step.keys?.length ?? plan.length });
    const index = await drawStand({ out: dirs[step.stand], comfy: options.comfy, until: options.until, pinned: pinned[step.stand],
      stand: step.stand === 3 ? STAND_3 : STAND_4, from: [options.first, dirs[step.stand === 3 ? 4 : 3]], keys: step.keys, warm, timeoutMs: options.timeoutMs,
      waitMs: options.waitMs, pollMs: options.pollMs, log: options.log });
    if (index.error) return { ended: 'stopped', error: index.error };
    if (index.stopped) return { ended: 'until' };
  }
  return { ended: 'done' };
}

// ---- The dry run ----

// A graph as the tree of what each node reads, the ids aside.
function canon(graph: Graph) {
  const seen = new Map<string, string>();
  const of = (id: string): string => {
    if (seen.has(id)) return seen.get(id)!;
    const node = graph[id];
    const inputs = Object.keys(node.inputs).sort().map(key => {
      const value = node.inputs[key];
      return `${key}=${Array.isArray(value) ? `(${of(String(value[0]))})#${value[1]}` : JSON.stringify(value)}`;
    });
    const text = `${node.class_type}{${inputs.join(',')}}`;
    seen.set(id, text);
    return text;
  };
  return Object.entries(graph).filter(([, node]) => node.class_type === 'SaveImage').map(([id]) => of(id)).join('|');
}

// The whole backlog without a card, in `dir`. First the real texts at `texts3` and `texts4`: their pins, their tokens,
// one prompt an arm and scene or a view across the seeds, S's cleanup with W's words, and every graph built from them
// and read back, S's from VAEEncode of its start at its denoise, each the same on the Qwen edit graph, and R's and
// FV's the bot's referenceGraph for one to six references. Then marked copies against local/fake-comfy.ts started as
// the bot's card: the first stand's H and L fronts drawn in a run of their own; the pages before the card; texts other
// than the pinned, a card record missing, a --from that is not there or was drawn from other weights, and a server
// on cu128 refused before anything is sent or written; five seconds that begin nothing; an --until that comes in the
// middle of a job, which stops the job and records nothing; the backlog drawn until the card goes away in the middle
// of arm S; a new card on another torch and a lent picture that has changed since refused; another card that takes
// over, with every picture uploaded to it again, and draws the rest, each cell once, in the backlog's order; a start
// after it that draws nothing; every job against its reading and the fake's, with what each reference reaches the
// encoder at; no `front` in any submit; one job at a time; the pages; and the prompts' word in the texts and on the
// pages alone, the fake's word nowhere.
export async function dryRunBacklog(dir: string, texts3: string, texts4: string, fromTexts: string, tokenizers: string,
  pinned3 = TEXTS_SHA256_3, pinned4 = TEXTS_SHA256_4) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), first = join(dry, 'refs-stand'), out3 = join(dry, 'refs-stand-3'), out4 = join(dry, 'refs-stand-4');
  for (const path of [dry, temp, first, out3, out4]) mkdirSync(path, { recursive: true, mode: 0o700 });
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
  const fakes: Awaited<ReturnType<typeof startFakeComfy>>[] = [];
  const bodies: { origin: string; body: Record<string, unknown> }[] = [], fetched = globalThis.fetch;
  let strays = 0, origin = '';
  // A card that goes away as the next upload to it begins: it closes, and the upload meets a closed port.
  let goes: (() => Promise<void>) | undefined;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) { strays++; throw new Error('the dry run asks the fake alone'); }
    if (goes && new URL(url).pathname === '/upload/image') { const going = goes; goes = undefined; await going(); }
    if (init?.method === 'POST' && url.endsWith('/prompt') && typeof init.body === 'string') bodies.push({ origin, body: JSON.parse(init.body) as Record<string, unknown> });
    return fetched(input, init);
  };
  try {
    say(`refs-backlog dry run in ${dry}: the real texts, then copies of the three stands' against local/fake-comfy.ts as the bot's cards; no card, no model, no network`);
    for (const out of [first, out3, out4]) writeCardRecord(join(out, 'card.txt'));
    const card = cardOf(join(out3, 'card.txt'));
    const real3 = inputsOf(texts3, pinned3, PLANNED_3), real4 = inputsOf(texts4, pinned4, PLANNED_4), stand1 = inputsOf(fromTexts, TEXTS_SHA256);
    const plan = [...PLANNED_3, ...PLANNED_4], estimate = backlogEstimate();
    say(`0 the plans: the third stand ${PLANNED_3.length} cells, arms ${JSON.stringify(estimate.stand3.arms)}; the fourth ${PLANNED_4.length} views, `
      + `${JSON.stringify(estimate.stand4.arms)}; minutes at ${FLAT_SECONDS.join(' and ')} s a cell ${JSON.stringify(estimate.both.flatMinutes)}, at tonight's `
      + `times ${estimate.both.tonightMinutes}, at the admission prices ${estimate.both.admissionMinutes}; arm S ${JSON.stringify(estimate.armS.frame)}`);
    // The order: each cell after the pictures it takes in its own stand; the third stand's fronts, W and R seed by seed,
    // S, FC and FV; the fourth stand's FV views first; every picture a stand takes from another drawn by one.
    const after = (list: Planned[]) => list.every((one, n) => [...one.refs.map(ref => ref.from), ...(one.start ? [one.start] : [])]
      .every(key => !list.some(other => other.key === key) || list.findIndex(other => other.key === key) < n));
    const arms3 = PLANNED_3.map(one => one.arm);
    const ordered = same(arms3.slice(0, 2), ['front', 'front']) && arms3.slice(2, 26).every((arm, n) => arm === (n % 2 ? 'R' : 'W'))
      && arms3.slice(26, 74).every(arm => arm === 'S') && arms3.slice(74, 86).every(arm => arm === 'FC') && arms3.slice(86).every(arm => arm === 'FV')
      && same(PLANNED_4.slice(0, 4).map(one => one.key), FV_VIEWS);
    const lends = (list: Planned[], others: Map<string, Planned>) => list.every(one => [...one.refs.map(ref => ref.from), ...(one.start ? [one.start] : [])]
      .every(key => list.some(other => other.key === key) || others.has(key) || BY_KEY.has(key)));
    expect(PLANNED_3.length === 98 && PLANNED_4.length === 64 && new Set(plan.map(one => one.key)).size === 162 && after(PLANNED_3) && after(PLANNED_4) && ordered
      && lends(PLANNED_3, BY_KEY_4) && lends(PLANNED_4, BY_KEY_3) && !plan.some(one => BY_KEY.has(one.key)),
    '98 and 64 cells in the backlog\'s order, each after the pictures it takes, every lent picture another stand\'s');

    const tokens3 = tokenReport(real3.texts, tokenizers, PLANNED_3, PLANNED_4), tokens4 = tokenReport(real4.texts, tokenizers, PLANNED_4, PLANNED_3);
    say('1 the real texts (sha256 pinned): tokens, the prompt as the encoder takes it with its references, the canvas and each reference at the encoder:');
    for (const one of [...tokens3.groups, ...tokens4.groups]) say(`   ${JSON.stringify(one)}`);
    expect([...tokens3.groups, ...tokens4.groups].every(one => one.promptTokens[0] > 0 && one.promptTokens[1] < 2000), 'every prompt counted, none past 2,000 tokens');

    // One prompt an arm and scene across the six seeds, and a view across the four; S's cleanup W's words; every frame
    // ending with the reader style of the bot and every view with the portrait's; the references named by image
    // number where a frame takes some, from image 2 in the edit, whose image 1 is the draft, and never in W and S3.
    const text3 = (id: string, scene: Scene3, seed: number) => real3.texts.cells.get(frameKey(id, scene, seed))!.prompt;
    const oneEach = SCENES_3.every(scene => COLUMNS_3.every(id => new Set(SEEDS_3.map(seed => text3(id, scene, seed))).size === 1))
      && PEOPLE.every(person => TURNS.every(turn => new Set(SEEDS_4.map(seed => real4.texts.cells.get(viewKeyOf(viewId(person, turn), seed))!.prompt)).size === 1));
    const cleanup = SCENES_3.every(scene => SEEDS_3.every(seed => S_LEVELS.every(level => text3(`S3-${level.id}`, scene, seed) === text3('W', scene, seed))));
    const endings = PLANNED_3.every(one => real3.texts.cells.get(one.key)!.prompt.endsWith(one.kind === 'front' ? PORTRAIT_STYLE : STYLE))
      && PLANNED_4.every(one => real4.texts.cells.get(one.key)!.prompt.endsWith(PORTRAIT_STYLE));
    const numbered = SCENES_3.every(scene => {
      const count = CAST[scene].length, has = (id: string, words: string) => text3(id, scene, 43).includes(words);
      return Array.from({ length: count }, (_, n) => n).every(n => has('R', `The person from image ${n + 1},`) && has('FC', `The person from image ${n + 1},`)
        && has('S2-55', `The person from image ${n + 2},`) && has('FV', `The person from images ${2 * n + 1} and ${2 * n + 2},`))
        && !has('R', `image ${count + 1}`) && !has('S2-55', `The person from image 1,`) && has('S2-55', 'image 1') && !/\bimages?\b/.test(text3('W', scene, 43));
    });
    const distinct = SCENES_3.every(scene => new Set(['W', 'R', 'S2-55', 'FC', 'FV'].map(id => text3(id, scene, 43))).size === 5)
      && text3('S2-55', 'K-pair', 43) === text3('S2-80', 'K-pair', 43);
    say(`2 the texts beside each other: one prompt an arm and scene or a view across the seeds ${oneEach}; the cleanup W's words ${cleanup}; each ending with `
      + `its style ${endings}; the references named by image number as each arm takes them ${numbered}; W, R, S2, FC and FV each its own, S2 one text at both levels ${distinct}`);
    expect(oneEach && cleanup && endings && numbered && distinct, 'the texts as the arms ask');

    // Every graph from the real texts, each picture named as an upload would be, one name a picture, read back
    // independently.
    const nameOf = (key: string) => `ref-${sha256(key).slice(0, 16)}.png`;
    const names = (one: Planned) => one.refs.map(ref => nameOf(ref.from));
    const startName = (one: Planned) => (one.start === undefined ? undefined : nameOf(one.start));
    const realOf = (one: Planned) => (BY_KEY_3.has(one.key) ? real3 : real4);
    const built = plan.map(one => ({ one, text: realOf(one).texts.cells.get(one.key)!, graph: buildJob({ ...realOf(one), card }, one, realOf(one).texts.cells.get(one.key)!,
      names(one), startName(one)) }));
    const wrongBuilt = built.filter(({ one, text, graph }) => !cellRight(graph, one, text, names(one), { ...realOf(one), card }, startName(one))).map(({ one }) => one.key);
    const samplerOf = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs;
    const chains = (graph: Graph) => slotChains(graph).map(slot => slot.chain.slice(0, 5));
    const scaled = ['ImageScale', 'area', SCALED.width, SCALED.height, 'disabled'];
    const wanted = (one: Planned) => one.refs.map((ref, n) => (ref.how === 's352' ? scaled : ref.how === 'crop' ? ['ImageCrop', CROP.width, CROP.height, CROP.x, CROP.y]
      : ['LoadImage', names(one)[n]]));
    const shaped = built.every(({ one, graph }) => same(chains(graph), wanted(one)) && samplerOf(graph).denoise === (one.denoise ?? 1)
      && Object.values(graph).filter(node => node.class_type === 'VAEEncode').length === (one.start === undefined ? 0 : 1));
    const begun = built.filter(({ one }) => one.start !== undefined).every(({ one, graph }) => {
      const encode = graph[String((samplerOf(graph).latent_image as unknown[])[0])], loader = graph[String((encode.inputs.pixels as unknown[])[0])];
      return encode.class_type === 'VAEEncode' && loader.class_type === 'LoadImage' && loader.inputs.image === startName(one);
    });
    const levels = [...new Set(built.map(({ one }) => one.denoise).filter(value => value !== undefined))].sort();
    say(`3 every graph built from the real texts: ${built.length - wrongBuilt.length} of ${built.length} read back right${wrongBuilt.length ? `, wrong ${wrongBuilt.join(', ')}` : ''}; `
      + `each slot as its arm takes it, the draft whole in the edit's slot 1 and every other reference through ImageScale 352x640 or ImageCrop 720x400: ${shaped}; `
      + `the ${built.filter(({ one }) => one.start !== undefined).length} cells of S from VAEEncode of their start, at denoise ${levels.join(', ')}: ${begun}`);
    expect(!wrongBuilt.length && shaped && begun && same(levels, [0.3, 0.55, 0.8]), 'every graph of the real texts as its cell asks');

    // The same graphs on the Qwen edit graph, and R's and FV's the bot's own for one to six references.
    const editBase = apiGraph(JSON.parse(readFileSync(EDIT_GRAPH, 'utf8')));
    const onEdit = built.filter(({ one }) => one.graph === 'action').every(({ one, text, graph }) => canon(buildJob({ ...realOf(one), card, base: editBase }, one, text,
      names(one), startName(one))) === canon(graph));
    const frontGraph = apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))), actionBase = apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
    const values = (references: string[]) => ({ checkpoint: card.model, prompt: 'p', negative: '', seed: 43, steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1,
      ...FRAME_CANVAS, references });
    const bots = [1, 2, 3, 4, 5, 6].map(count => {
      const refs = Array.from({ length: count }, (_, n) => `ref-${n + 1}.png`);
      return canon(withAttention(applyToWorkflow(actionGraph(actionBase, refs.map((_, n) => n + 1)).graph, values(refs)))!)
        === canon(withAttention(applyToWorkflow(referenceGraph(frontGraph, count)!, values(refs)))!);
    });
    say(`4 each view and frame the same on gpu/image-workflow-qwen-edit.json: ${onEdit}; the action graph with one to six references at 352x640 the bot's `
      + `referenceGraph: ${bots.join(', ')}`);
    expect(onEdit && bots.every(Boolean), 'the edit graph\'s and the bot\'s graphs');

    // The copies the fakes draw: a made-up word in every prompt, and their own pins.
    const word = madeUpName(), marker = madeUpName(name => name !== word);
    const writeTexts = (to: string, cells: TextCell[]) => {
      const bytes = JSON.stringify({ note: 'The real texts with a made-up word, for the dry run.', cells: cells.map(cell => ({ ...cell, prompt: `${cell.prompt} ${word}`,
        negative: cell.negative ? `${cell.negative} ${word}` : '' })) }, null, 2);
      writeFileSync(join(to, TEXTS_FILE), bytes, { mode: 0o600 });
      return sha256(bytes);
    };
    const firstMarked = writeTexts(first, PLANNED.map(one => stand1.texts.cells.get(one.key)!));
    const marked3 = writeTexts(out3, PLANNED_3.map(one => real3.texts.cells.get(one.key)!)), marked4 = writeTexts(out4, PLANNED_4.map(one => real4.texts.cells.get(one.key)!));
    const CARD_A = 'cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync', CARD_B = 'cuda:0 NVIDIA GeForce RTX 5090 D : cudaMallocAsync';
    const startCard = async (name: string, pytorch = '2.11.0+cu130') => {
      const started = await startFakeComfy({ jobMs: 20, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: kitchenLines(true, 'cu130'),
        pytorch, objectInfo: attentionInfo(true), card: name });
      fakes.push(started);
      origin = started.url;
      return started;
    };
    const fakeA = await startCard(CARD_A);
    const events: { event?: string; key?: string }[] = [];
    const heard = (event: string) => events.filter(one => one.event === event);
    const draw = (extra: Partial<BacklogOptions> = {}) => drawBacklog({ stand3: out3, stand4: out4, first, comfy: origin, until: Date.now() + 3600000,
      pinned3: marked3, pinned4: marked4, pollMs: 10, waitMs: 60000, timeoutMs: 10000, log: event => events.push(event), ...extra });
    const lent = await drawStand({ out: first, comfy: origin, until: Date.now() + 3600000, pinned: firstMarked, keys: [FRONTS.H, FRONTS.L], pollMs: 10, waitMs: 60000,
      timeoutMs: 10000, log: () => undefined });
    say(`5 the first stand's H and L fronts in a run of their own: ${countsOf(lent).drawn} drawn, ${fakeA.jobs.length} jobs`);
    expect(countsOf(lent).drawn === 2 && fakeA.jobs.length === 2, 'the two fronts drawn');

    for (const [out, stand, pinned] of [[out3, STAND_3, marked3], [out4, STAND_4, marked4]] as const) writePage(out, inputsOf(join(out, TEXTS_FILE), pinned, stand.plan), undefined, stand);
    const pages = [readFileSync(join(out3, 'index.html'), 'utf8'), readFileSync(join(out4, 'index.html'), 'utf8')];
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length, folded = (page: string) => (page.match(/<details>/g) ?? []).length;
    const pageKeys = (sections: Section[]) => sections.flatMap(section => section.rows.flatMap(row => row.keys.filter((key): key is string => key !== undefined))).sort();
    say(`6 the pages before the card: ${pages.map(figures).join(' and ')} figures, ${pages.map(folded).join(' and ')} prompts folded`);
    expect(figures(pages[0]) === 98 && figures(pages[1]) === 64 && folded(pages[0]) === 98 && folded(pages[1]) === 64
      && same(pageKeys(SECTIONS_3), PLANNED_3.map(one => one.key).sort()) && same(pageKeys(SECTIONS_4), PLANNED_4.map(one => one.key).sort()),
    'the pages before the card show every cell once, with its prompt');

    say('7 refusals before anything is sent or written:');
    const beforeRefusals = fakeA.jobs.length, uploadsBefore = fakeA.uploads.length;
    await refused('the third stand\'s texts other than the pinned', () => draw({ pinned3: sha256('another texts.json') }));
    await refused('the fourth stand\'s texts other than the pinned', () => draw({ pinned4: sha256('another texts.json') }));
    const record = readFileSync(join(out4, 'card.txt'));
    writeFileSync(join(out4, 'card.txt'), '', { mode: 0o600 });
    await refused('the fourth stand without its card record', () => draw());
    writeFileSync(join(out4, 'card.txt'), record, { mode: 0o600 });
    await refused('a --from that is not there', () => draw({ first: join(dry, 'nowhere') }));
    const other = join(dry, 'other'), firstIndex = readJson<StandIndex>(join(first, INDEX_FILE))!;
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeFileSync(join(other, INDEX_FILE), JSON.stringify({ ...firstIndex, pins: { ...firstIndex.pins, transformer: 'another-transformer.safetensors' } }), { mode: 0o600 });
    await refused('a --from drawn from other weights', () => draw({ first: other }));
    fakeA.options.pytorch = '2.11.0+cu128';
    await refused('a server on cu128', () => draw());
    fakeA.options.pytorch = '2.11.0+cu130';
    expect(fakeA.jobs.length === beforeRefusals && fakeA.uploads.length === uploadsBefore && !existsSync(join(out3, INDEX_FILE)) && !existsSync(join(out4, INDEX_FILE)),
      'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`8 five seconds left: ${short.ended}, ${fakeA.jobs.length - beforeRefusals} jobs sent`);
    expect(short.ended === 'until' && fakeA.jobs.length === beforeRefusals, 'a cell that cannot end by --until is not begun');

    // An --until that comes while a job draws, on a card that has drawn a front: the job stopped, nothing recorded.
    fakeA.options.jobMs = 30000;
    const midway = await draw({ until: Date.now() + 12500, warm: { reached: true, groups: new Set<Group>(['front']) } });
    fakeA.options.jobMs = 20;
    const stoppedJob = fakeA.jobs.at(-1), afterMidway = readJson<StandIndex>(join(out3, INDEX_FILE))!;
    say(`9 an --until in the middle of a job: ${midway.ended}, ${fakeA.jobs.length - beforeRefusals} job, its outcome ${stoppedJob?.outcome}, `
      + `${countsOf(afterMidway).drawn} drawn, stopped ${afterMidway.stopped}`);
    expect(midway.ended === 'until' && fakeA.jobs.length - beforeRefusals === 1 && stoppedJob?.outcome === 'interrupted' && countsOf(afterMidway).drawn === 0
      && afterMidway.stopped === 'until' && !Object.keys(afterMidway.cells).length, 'the job stopped at --until, and nothing recorded');

    // The backlog on card A until the card goes away after 30 cells, in the middle of arm S: the 31st, the trio's
    // first edit, uploads its draft to a card that is not there.
    const onA = fakeA.jobs.length, sentA = bodies.length, drawnA: string[] = [];
    const gone = await draw({ log: event => {
      events.push(event);
      const one = event as { event?: string; key?: string };
      if (one.event !== 'cell_drawn') return;
      drawnA.push(one.key!);
      if (drawnA.length === 30) goes = () => fakeA.close();
    } });
    const index3A = readJson<StandIndex>(join(out3, INDEX_FILE))!;
    say(`10 card A goes away after 30 cells: ${gone.ended}, error ${gone.error}; ${fakeA.jobs.length - onA} jobs, ${countsOf(index3A).drawn} drawn, `
      + `failed ${JSON.stringify(countsOf(index3A).failed)}`);
    expect(gone.ended === 'stopped' && gone.error === 'comfy_unreachable' && fakeA.jobs.length - onA === 30 && countsOf(index3A).drawn === 30
      && same(drawnA, PLANNED_3.slice(0, 30).map(one => one.key)) && Object.values(index3A.cells).filter(one => one.status === 'failed').length === 1,
    'the card gone: 30 drawn, the cell after them failed as unreachable, and the backlog stopped');

    say('11 refusals on the next card before anything is sent:');
    const fakeC = await startCard(CARD_B, '2.11.1+cu130');
    await refused('a card on another torch', () => draw());
    expect(fakeC.jobs.length === 0 && fakeC.uploads.length === 0, 'the card on another torch gets nothing');
    const fakeB = await startCard(CARD_B);
    const firstFile = join(first, INDEX_FILE), firstBytes = readFileSync(firstFile), changed = JSON.parse(firstBytes.toString('utf8')) as StandIndex;
    changed.cells[FRONTS.H] = { ...changed.cells[FRONTS.H], sha256: sha256('another front') };
    writeFileSync(firstFile, JSON.stringify(changed), { mode: 0o600 });
    await refused('a lent picture that changed since the third stand took it', () => draw());
    writeFileSync(firstFile, firstBytes, { mode: 0o600 });
    expect(fakeB.jobs.length === 0 && fakeB.uploads.length === 0, 'the changed picture sends nothing');

    // Card B takes over: every picture uploaded again from the run directories, the rest drawn once each in order.
    const sentB = bodies.length, drawnB: string[] = [];
    const takeover = await draw({ log: event => {
      events.push(event);
      const one = event as { event?: string; key?: string };
      if (one.event === 'cell_drawn') drawnB.push(one.key!);
    } });
    const onB = fakeB.jobs.length, again = await draw();
    const index3 = readJson<StandIndex>(join(out3, INDEX_FILE))!, index4 = readJson<StandIndex>(join(out4, INDEX_FILE))!;
    const order = [...PLANNED_3.filter(one => one.arm !== 'FV'), ...PLANNED_4.slice(0, 4), ...PLANNED_3.filter(one => one.arm === 'FV'), ...PLANNED_4.slice(4)]
      .map(one => one.key);
    const pathOf = (key: string) => (BY_KEY_3.has(key) ? join(out3, BY_KEY_3.get(key)!.file) : BY_KEY_4.has(key) ? join(out4, BY_KEY_4.get(key)!.file)
      : join(first, BY_KEY.get(key)!.file));
    const uploadName = (key: string) => `ref-${sha256(stripPngMetadata(readFileSync(pathOf(key)))).slice(0, 16)}.png`;
    const needed = [...new Set(drawnB.flatMap(key => { const one = BY_KEY_3.get(key) ?? BY_KEY_4.get(key)!; return [...one.refs.map(ref => ref.from), ...(one.start ? [one.start] : [])]; }))];
    const carded = (index: StandIndex) => Object.values(index.cells).every(cell => index.sessions?.[cell.session ?? -1]?.server.card
      === (drawnA.includes(cell.key) ? CARD_A : CARD_B));
    say(`12 card B takes over: ${takeover.ended}, ${fakeB.jobs.length} jobs, ${fakeB.uploads.length} uploads for the ${needed.length} pictures they take, `
      + `among them the first stand's two fronts and the ${needed.filter(key => BY_KEY_3.has(key) || BY_KEY_4.has(key)).length} card A or B drew; `
      + `a start after it: ${again.ended}, ${fakeB.jobs.length - onB} more jobs; drawn ${countsOf(index3).drawn} and ${countsOf(index4).drawn}, `
      + `each once in the backlog's order ${same([...drawnA, ...drawnB], order)}; sessions ${index3.sessions?.length} and ${index4.sessions?.length}, each cell on its card `
      + `${carded(index3) && carded(index4)}`);
    expect(takeover.ended === 'done' && again.ended === 'done' && onB === 132 && fakeB.jobs.length === onB && drawnB.length === 132 && countsOf(index3).drawn === 98
      && countsOf(index4).drawn === 64 && same([...drawnA, ...drawnB], order) && needed.every(key => fakeB.uploads.includes(uploadName(key)))
      && needed.includes(FRONTS.H) && needed.includes(FRONTS.L) && carded(index3) && carded(index4), 'card B draws the rest, every picture uploaded to it again');

    // Each job against its cell, on the card that drew it, and what the fake made of it; each reference as the card
    // gets it: the picture, what the graph hands the encoder, the size the encoder draws it at, and its change of shape.
    const setups = { 3: setupOf(out3, marked3, PLANNED_3), 4: setupOf(out4, marked4, PLANNED_4) };
    const wrong: string[] = [];
    const seen = new Map<string, { arm: string; how: How; ids: Set<string>; picture: Size; handed: Size; encoder: Size; change: number }>();
    const jobsA = fakeA.jobs.slice(onA), postsA = bodies.slice(sentA, sentA + jobsA.length), postsB = bodies.slice(sentB);
    [...drawnA.map((key, n) => ({ key, job: jobsA[n], body: postsA[n] })),
      ...drawnB.map((key, n) => ({ key, job: fakeB.jobs[n], body: postsB[n] }))].forEach(({ key, job, body }) => {
      const one = BY_KEY_3.get(key) ?? BY_KEY_4.get(key)!, setup = BY_KEY_3.has(key) ? setups[3] : setups[4], index = BY_KEY_3.has(key) ? index3 : index4;
      const text = setup.texts.cells.get(key)!, graph = body?.body.prompt as Graph | undefined, cell = index.cells[key];
      const refNames = one.refs.map(ref => uploadName(ref.from)), begin = one.start === undefined ? undefined : uploadName(one.start);
      job?.slots.forEach((slot, s) => {
        const ref = one.refs[s], picture = pngSize(readFileSync(pathOf(ref.from)));
        const shown = slot.cropped ? { width: slot.cropped.width, height: slot.cropped.height } : picture, handed = slot.scaled ?? shown;
        const [width, height] = referenceGeometry(handed.width, handed.height, 0);
        const change = Math.abs(width / height / (shown.width / shown.height) - 1), row = `${one.arm} ${ref.how} ${sizeText(picture)} ${width}x${height}`;
        const entry = seen.get(row) ?? { arm: one.arm, how: ref.how, ids: new Set<string>(), picture, handed, encoder: { width, height }, change };
        seen.set(row, { ...entry, ids: entry.ids.add(one.id) });
      });
      const right = graph !== undefined && same(buildJob(setup, one, text, refNames, begin), graph) && cellRight(graph, one, text, refNames, setup, begin)
        && job?.outcome === 'success' && job.sampler === 'KSampler' && job.start === (begin ?? null) && job.noiseMask === null && !job.composites.length
        && same(job.slots, one.refs.map((ref, s) => ({ slot: s + 1, file: refNames[s], scaled: ref.how === 's352' ? SCALED : null, cropped: ref.how === 'crop' ? CROP : null })))
        && same(job.model, one.graph === 'front' ? ['ModelAttentionBackend', 'UNETLoader'] : ['ModelAttentionBackend', 'QwenImage21Cache', 'UNETLoader'])
        && same(job.images, [{ node: one.graph === 'front' ? '8' : '9', ...one.canvas }]) && job.width === one.canvas.width && job.height === one.canvas.height
        && cell?.status === 'drawn' && cell.file === one.file && cell.width === one.canvas.width && cell.height === one.canvas.height && cell.fallback === 0
        && existsSync(pathOf(key)) && same(cell.references ?? [], one.refs.map(ref => sha256(readFileSync(pathOf(ref.from)))))
        && cell.start === (one.start === undefined ? undefined : sha256(readFileSync(pathOf(one.start))));
      if (!right) wrong.push(key);
    });
    say(`13 jobs against their reading and the fake's: ${drawnA.length + drawnB.length - wrong.length} of ${drawnA.length + drawnB.length} right`
      + `${wrong.length ? `, wrong ${wrong.slice(0, 12).join(', ')}` : ''}`);
    expect(!wrong.length && drawnA.length + drawnB.length === 162, 'every job sends its own graph, with the pictures it takes and the one it starts from');
    const handedBy: Record<How, string> = { s352: 'ImageScale hands on', own: 'handed whole at', crop: 'ImageCrop hands on', r1024: 'handed whole at' };
    say('   each reference by arm: the picture, what the graph hands the encoder, the size the encoder draws it at, the change of shape');
    for (const one of seen.values()) {
      say(`   ${one.arm} ${[...one.ids].join(', ')}: the picture ${sizeText(one.picture)}, ${handedBy[one.how]} ${sizeText(one.handed)}, `
        + `at resolution 0 the encoder draws it at ${sizeText(one.encoder)}, shape changed ${(one.change * 100).toFixed(1)} %`);
    }
    const sizes: Record<string, string[]> = {};
    for (const one of seen.values()) sizes[one.how] = [...new Set([...(sizes[one.how] ?? []), sizeText(one.encoder)])].sort();
    expect(same(Object.keys(sizes).sort(), ['crop', 'own', 's352']) && same(sizes.s352, ['352x640']) && same(sizes.crop, ['704x384'])
      && same(sizes.own, ['1280x704', '704x1280']) && [...seen.values()].every(one => one.change <= 0.05), 'each reference reaches the encoder at its size, none squeezed by more than 5 %');

    const fronted = bodies.filter(one => 'front' in one.body || Object.keys(one.body).some(key => !['prompt', 'client_id', 'prompt_id'].includes(key))).length;
    say(`14 submits with anything but the graph, the client and the job's id, \`front\` among it: ${fronted} of ${bodies.length}; the fakes held at most `
      + `${fakes.map(one => one.mostHeld).join(', ')} job at once; ${strays} calls to anything but the fake of the moment`);
    expect(fronted === 0 && bodies.length > 0 && fakes.every(one => one.mostHeld <= 1) && strays === 0, 'no front, one job at a time, the fakes alone');

    const pagesAfter = [out3, out4].map(out => readFileSync(join(out, 'index.html'), 'utf8'));
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = [out3, out4].every(out => mode(out) === 0o700 && mode(join(out, INDEX_FILE)) === 0o600 && mode(join(out, 'index.html')) === 0o600)
      && ['fronts', 'frames'].every(sub => mode(join(out3, sub)) === 0o700) && mode(join(out4, 'views')) === 0o700 && plan.every(one => mode(pathOf(one.key)) === 0o600);
    const linked = pagesAfter.map((page, n) => {
      const out = n ? out4 : out3, links = [...new Set([...page.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
      return links.length === (n ? 64 : 98) && links.every(link => existsSync(resolve(out, link)));
    });
    const prose = pagesAfter.map(page => page.replace(/<pre>[\s\S]*?<\/pre>/g, '')), dashes = /[–—]/;
    // The third stand drew on both cards, the fourth on card B alone.
    const named = pagesAfter[0].includes(CARD_A) && pagesAfter[0].includes(CARD_B) && !pagesAfter[1].includes(CARD_A) && pagesAfter[1].includes(CARD_B);
    say(`15 pages: ${pagesAfter.map(figures).join(' and ')} figures, every picture linked where it lies ${linked.join(', ')}; dashes in their own words `
      + `${prose.some(page => dashes.test(page))}; the cards each drew on named ${named}; directories 700 and files 600: ${modes}`);
    expect(linked.every(Boolean) && !prose.some(page => dashes.test(page)) && pagesAfter[0].includes('Нарисовано 98 из 98') && pagesAfter[1].includes('Нарисовано 64 из 64')
      && pagesAfter.every(page => page.includes('Triton включён') && !page.includes('не нарисовано')) && named && modes,
    'the pages link every picture, name the cards each stand drew on, in words without dashes');

    // The prompts' word is in the texts and on the pages, and nowhere else; the fake's word is nowhere.
    const text = output.text(), wordForms = markerForms(word), marks = markerForms(marker);
    const shown = (name: string) => name === TEXTS_FILE || name === 'index.html';
    const beyond = searchTree(dry, wordForms, path => shown(basename(path)));
    const anywhere = searchTree(dry, marks);
    const printed = [...wordForms, ...marks].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`16 privacy: the prompts' word in ${beyond.hits.length} of ${beyond.files} files beside the texts and the pages, unread ${beyond.unread.length + anywhere.unread.length}; `
      + `the fake's word in ${anywhere.hits.length} of ${anywhere.files}; printed ${printed}`);
    expect(!beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length && !printed,
      'no prompt anywhere but the texts and the pages, and nothing printed');
    expect(heard('attention_fallback').length === 0, 'no fallback of the attention');
    say(missed.length ? `the backlog's dry run did NOT go as expected: ${missed.length} of its checks` : 'the backlog\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    for (const fake of fakes) await fake.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    stand3: { type: 'string' }, stand4: { type: 'string' }, from: { type: 'string' }, dir: { type: 'string' }, tokenizers: { type: 'string' },
    until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, wait: { type: 'string', default: '300' },
    timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'estimate') {
    print({ event: 'estimate', ...backlogEstimate() });
    return;
  }
  if (!values.stand3 || !values.stand4) {
    throw new Refusal('Use: image-refs-backlog.ts estimate|dry-run|draw|page --stand3 <the third stand\'s directory> --stand4 <the fourth\'s> (docs/action-experiment.md#refs-backlog)');
  }
  const stand3 = resolve(values.stand3), stand4 = resolve(values.stand4);
  if (command === 'dry-run') {
    if (!values.from) throw new Refusal('Use: dry-run --stand3 <dir> --stand4 <dir> --from <the first stand\'s directory> [--tokenizers <dir>] [--dir <dir>]');
    const result = await dryRunBacklog(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-refs-backlog-dry-')), join(stand3, TEXTS_FILE), join(stand4, TEXTS_FILE),
      join(resolve(values.from), TEXTS_FILE), resolve(values.tokenizers ?? join(ROOT, 'tokenizers')));
    if (!result.pass) process.exitCode = 1;
  } else if (command === 'page') {
    for (const [out, stand, pinned] of [[stand3, STAND_3, TEXTS_SHA256_3], [stand4, STAND_4, TEXTS_SHA256_4]] as const) {
      writePage(out, inputsOf(join(out, TEXTS_FILE), pinned, stand.plan), readJson<StandIndex>(join(out, INDEX_FILE)), stand);
      print({ event: 'page', file: join(out, 'index.html') });
    }
  } else if (command === 'draw') {
    // `--until` is the end of the drawing in epoch seconds, before the card's end as the runbook computes it. Exit 0 once
    // everything is drawn, 3 at --until, 1 on an error.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!values.from || !Number.isInteger(until) || until <= Date.now() || until > Date.now() + LONGEST_MS || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --stand3 <dir> --stand4 <dir> --from <the first stand\'s directory> --until <epoch seconds, at most 12 hours on> [--wait 300] '
        + '[--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const result = await drawBacklog({ stand3, stand4, first: resolve(values.from), comfy: comfyUrl(values.comfy!), until, waitMs: wait * 1000,
      timeoutMs: timeout * 1000, log: print });
    const counts = [stand3, stand4].map(out => countsOf(readJson<StandIndex>(join(out, INDEX_FILE)) ?? { cells: {} } as StandIndex));
    print({ event: 'backlog_done', ...result, stand3: counts[0], stand4: counts[1] });
    process.exitCode = result.ended === 'done' ? 0 : result.ended === 'until' ? 3 : 1;
  } else throw new Refusal('Use: image-refs-backlog.ts estimate|dry-run|draw|page (docs/action-experiment.md#refs-backlog)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
