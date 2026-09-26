// The T probe (docs/action-experiment.md#t-probe). T, the action measurement's second pass, gave round one's L picture
// back, its layout and faces, with its edges and colours pushed, and took no face, hair or build from the portraits: its
// judges scored T as L on every item of all 13 clean scenes. Here nine variants of T are drawn on one pilot card from
// round one's own pictures and portraits of six clean scenes at seed 7, with no text card and no new portrait, and one
// page sets each beside the portraits, L, A+, and round one's T and C, for the owner to pick from. Five are one change
// against T each; `mask` and `mask-each` redraw only the boxes of the bound people on L, and `face` and `face-each`
// only their heads and hair on A+'s picture, from a head-and-shoulders crop of each front, the boxes and the crops
// marked before the card. Round two's T stays as it is: T_OPENING, `tPrompt` and the action graph are read here and
// never changed, and the variants' prompts and graphs live in this file alone. On the same card, first, the clothing
// test of the portraits: eight fronts of round one drawn again in a dark grey suit, and the demon's C from them. The
// commands read illustrations/action-1/clean alone, and write illustrations/t-probe alone, where they also read the
// boxes; only `dry-run` takes another --dir:
//   estimate  the cells, the jobs and their minutes, from round one's own times, before a card is rented
//   draw      on the picture card: the clothing test, then the scenes in turn, each begun only if all of it can end by
//             --until
//   page      index.html, the owner's page, with the boxes and the crops over the pictures and the fronts old and new,
//             before the card as after; `draw` also writes it after the test and after every scene
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
import { cardOf, pinsOf, writeCardRecord } from './image-identity.ts';
import { PORTRAIT_CLOTHES, portraitCanvas, portraitPrompt } from './image-portraits.ts';
import { safeErrorDetails } from './model-error.ts';
import { STYLE } from './illustrate.ts';
import { greyPng, startFakeComfy } from './fake-comfy.ts';
import { Refusal, capture, madeUpName, markerForms, searchBoundary, searchTree } from './action-boundary.ts';
import { isSharp, readJson, storyDir } from './action-text.ts';
import type { ActionArm } from './action-text.ts';
import { T_OPENING, tClause } from './action-prompts.ts';
import type { StoryPlan } from './action-prompts.ts';
import { ACTION_GRAPH, CELL_MS, DRAW_CODES, FRAME_CANVAS, FRONT_GRAPH, MARGIN, SCALED, WAIT_MS, actionGraph, fileOf, frameKey } from './action-draw.ts';
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
// below the slow regime seven took it into: from four people to two. The flight's L kept all its contacts and the
// twister's most; the giants, the guard and the tango are the ones whose C took looks with two and three portraits; the
// demon binds all four of its people, where the monkeys, in the probe's first plan, bound one of five people, more than
// round two draws (docs/action-experiment.md#four).
export const PROBE_SCENES = ['flight', 'twister', 'giants', 'guard', 'tango', 'demon'];
const MOST_BOUND = 4;

// ---- The variants ----

// The first five are one change each against today's T, whose graph is action-draw.ts `actionGraph` with image 1, L's
// picture, as it is and every portrait through its scale node to 352x640, and whose prompt is round one's own,
// T_OPENING, one clause a person and the style line. `mask` is `latent-70` redrawing only the boxes of the bound people
// on L, and `mask-each` those one person at a time. `face` is T on A+'s picture instead of L's, redrawing only the
// heads of the bound people, with a head-and-shoulders crop of each front in its slot, and `face-each` those one head
// at a time. `short` names the change on the page, `change`, `faces` and `risk` explain it there.
export type VariantId = 'words' | 'no-style' | 'half' | 'latent-50' | 'latent-70' | 'mask' | 'mask-each' | 'face' | 'face-each';
export type Variant = { id: VariantId; short: string; change: string; faces: string; risk: string; denoise?: number; mask?: 'all' | 'each';
  face?: true };
export const HALF = { width: 640, height: 352 };
// The masked variants' region round each box (see `regionOf`): so many pixels more a side, for a build that grows, or
// for the hair and the neck, brought out to the latent's grid, Qwen Image 2.1's 16 pixels a latent, so that the
// sampler's mask has no half cells; and the paste's feather, so many pixels in from the region's edge, none on a side
// at the canvas's edge. The bodies on L take MASK_*, the heads on A+ HEAD_*.
export const MASK_MARGIN = 48, MASK_FEATHER = 24, HEAD_MARGIN = 32, HEAD_FEATHER = 16;
const GRID = 16;
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
  { id: 'mask', short: 'latent-70 только в рамках людей', denoise: 0.7, mask: 'all',
    change: 'Как latent-70 (старт от L, denoise 0,70, портреты с картинки 1, промпт C), но перерисовываются только рамки связанных людей '
      + `из boxes.json, каждая с полями по ${MASK_MARGIN} px, доведёнными до сетки латента в ${GRID} px. Эти области — маска шума `
      + `(SetLatentNoiseMask); после VAEDecode ImageCompositeMasked вклеивает результат в пиксели L через те же области, растушёванные на `
      + `${MASK_FEATHER} px внутрь, кроме краёв кадра. Вне областей картинка — L пиксель в пиксель.`,
    faces: 'Как у latent-70, но только внутри рамок: лица, волосы и телосложение — от портретов; фон, свет и всё вне рамок — от L.',
    risk: 'Средний: внутри рамок позы и контакты могут поехать, как у latent-70; на границе области возможен шов. Где рамки занимают почти '
      + 'весь кадр (giants, guard, tango), это почти latent-70.' },
  { id: 'mask-each', short: 'по одному человеку в его рамке', denoise: 0.7, mask: 'each',
    change: 'По проходу на связанного человека, в порядке слотов: в проходе только его область и только его портрет картинкой 1; промпт — L, '
      + 'где только его фраза начата как в C («The person from image 1, …»), остальные — как в L. Denoise 0,70 внутри области и та же вклейка, '
      + 'что у mask; проход k начинается с картинки прохода k−1, первый — с L. Картинка каждого прохода лежит рядом.',
    faces: 'Каждому — только свой портрет: лица и телосложение не смешиваются между людьми.',
    risk: 'Средний, как у mask, и ещё: где области перекрываются, поздний проход перерисовывает и того, кто уже сделан (giants: рамка первого '
      + 'великана содержит купца; flight: рамки отца, матери и девочек перекрываются). Проходов столько, сколько людей: дольше.' },
  { id: 'face', short: 'A+: только лица и волосы', denoise: 1, mask: 'all', face: true,
    change: 'Правится картинка A+ первого раунда, а не L: она картинка 1, как L у T, и с неё же через VAEEncode стартует сэмплер, с denoise 1,0 '
      + `внутри маски. Маска — головы с волосами связанных людей из boxes.json, с полями по ${HEAD_MARGIN} px до сетки ${GRID} px; после VAEDecode `
      + `ImageCompositeMasked вклеивает их в пиксели A+ с растушёвкой ${HEAD_FEATHER} px, и вне голов картинка — A+ пиксель в пиксель. С картинки 2 — `
      + `кадры головы и плеч из фронтальных портретов (ImageCrop по кадру из boxes.json, 11:20, затем ${SCALED.width}x${SCALED.height}). Промпт — как `
      + 'у T, но меняет только лица и волосы: «… Change only the faces and hair of these people in image 1: РОЛЬ takes them from the person in '
      + 'image N; …» и строка стиля.',
    faces: 'Лица и волосы — от портретов; позы, контакты, одежда и телосложение — от A+, который рисовал без портретов.',
    risk: 'Низкий для действия: вне голов это A+ пиксель в пиксель. Но модель может вернуть лица с картинки 1, как T вернул L; на краю области '
      + 'возможен шов; волосы длиннее рамки за ней останутся от A+; телосложение не меняется. В flight у A+ пятый, несвязанный ребёнок: его лицо '
      + 'частью в рамках отца и девочки.' },
  { id: 'face-each', short: 'A+: по одной голове за проход', denoise: 1, mask: 'each', face: true,
    change: 'Как face, но по проходу на связанного человека, в порядке слотов: в маске только его голова, картинка 2 — только его кадр, в промпте '
      + 'только его фраза («… РОЛЬ takes them from the person in image 2»); проход k правит картинку прохода k−1, первый — A+. Картинка каждого '
      + 'прохода лежит рядом.',
    faces: 'Каждому — только свой кадр: лица не смешиваются между людьми.',
    risk: 'Как у face; где рамки голов перекрываются, поздний проход перерисовывает край соседней головы. Проходов столько, сколько людей: дольше.' },
];
const latentStart = (variant: Variant) => variant.denoise !== undefined;
// Whether image 1 is the picture the variant changes, as in T; a latent start of L sends the portraits alone.
const pictureFirst = (variant: Variant) => !latentStart(variant) || variant.face === true;

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

// `face` and `face-each`: T's own form, its opening kept to the faces and hair, and every body and build added to what
// is kept; each person's clause takes them from the crop of that person's front by role, and the style line ends it.
export const FACE_OPENING = 'Image 1 is the finished picture. Keep everything in it: the place, the light, the framing, every pose, grip and '
  + 'contact, all clothes, and every body and its build. Change only the faces and hair of these people in image 1:';
export const facePrompt = (clauses: Clause[]) => `${FACE_OPENING} ${clauses.map(one => tClause(one.role, one.image)).join('; ')}. ${STYLE}`;

// `mask-each`'s prompts, one a pass in slot order: round one's L prompt, with only that person's clause begun the C
// way and bound to image 1, the one portrait the pass sends. Read back from round one's C, which is its L with "The person
// from image N, ", or ": " before a clause with no words ahead of its action, at the head of each bound person's clause
// (action-prompts.ts `variantPrompt`): a C that is not its L with one such head for each slot from 1 gives nothing.
export function eachPrompts(l: string, c: string, bound: number): string[] | undefined {
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
  return slots.map(one => `${l.slice(0, one!.at)}The person from image 1${one!.joint}${l.slice(one!.at)}`);
}

// ---- Round one ----

type Input = { file: string; bytes: Buffer; sha256: string };
// One scene as the probe draws it: its fronts' ids in slot order and their canvas, its clauses and round one's T and C
// prompts, `mask-each`'s prompts where they read back, L's and A+'s pictures and the fronts, the prompts the fronts
// were drawn from, and what the page shows beside them. `hash` is what probe.json pins the scene's variants to.
export type Scene = { id: string; bound: number; fronts: string[]; clauses: Clause[]; t: string; c: string; each?: string[]; l: Input;
  aPlus: Input; portraits: Input[]; portraitCanvas: { width: number; height: number }; frontPrompts: (string | undefined)[];
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

// A link on the way into round one, which could lead into sealed/, is refused.
function noLink(source: string, path: string) {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${relative(source, path)} is a link, which could lead into sealed/: nothing of it is read`);
}
// A picture as round one recorded it: drawn, in its place, the very bytes, on its canvas.
function recorded(source: string, round: DrawIndex, key: string, path: string, canvas: string): Input | undefined {
  const one = round.cells[key], file = relative(source, path);
  if (!one || one.status !== 'drawn' || one.file !== file) return undefined;
  noLink(source, path);
  const bytes = existsSync(path) ? readFileSync(path) : undefined;
  const size = bytes ? pngSize(bytes) : undefined;
  return bytes && sha256(bytes) === one.sha256 && `${size?.width}x${size?.height}` === canvas ? { file, bytes, sha256: one.sha256 } : undefined;
}

// One clean scene of round one, read where the harness left it and checked against round one's record: its plan, with
// T over L and one to four fronts in slots 1 on and C over the same fronts; L's and A+'s pictures and the fronts byte
// for byte, on their canvases. A link on the way, which could lead into sealed/, is refused.
export function sceneOf(source: string, round: DrawIndex, id: string): Scene {
  cleanId(id);
  source = resolve(source);
  const dir = storyDir(source, id);
  for (const path of [join(source, 'clean'), dir, join(dir, 'pictures'), join(dir, 'portraits')]) noLink(source, path);
  if (!existsSync(dir) || realpathSync(dir).split(sep).includes('sealed')) throw new Refusal(`Round one has no clean scene ${id} in ${source}`);
  const plan = readJson<StoryPlan>(join(dir, 'plan.json'));
  const bound = plan?.manifest?.bound ?? [], fronts = bound.map(one => one.portrait);
  const t = plan?.arms.T, c = plan?.arms.C;
  const same = (a: string[] | undefined, b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  if (!t || !c || !fronts.length || fronts.length > MOST_BOUND || bound.some((one, at) => one.slot !== at + 1) || !same(t.references, ['L', ...fronts])
    || !same(c.references, fronts)) {
    throw new Refusal(`Round one's plan of ${id} has no T over L and one to ${MOST_BOUND} fronts in slots 1 on with C over the same fronts: the probe draws where round one drew T`);
  }
  const clauses = tClauses(t.prompt, fronts.length);
  if (!clauses) throw new Refusal(`Round one's T prompt of ${id} does not read back as T_OPENING, one clause a person and the style line: one of them changed since round one`);
  const frame = (arm: ActionArm) => recorded(source, round, frameKey(id, SEED, arm), fileOf(source, { kind: 'frame', story: id, id: '', seed: SEED, arm }),
    `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`);
  const l = frame('L'), aPlus = frame('A+');
  const portraitCanvas = String(round.pins.portraitCanvas);
  const portraits = fronts.map(front => recorded(source, round, `front:${front}`, fileOf(source, { kind: 'front', story: id, id: front, seed: SEED }), portraitCanvas));
  if (!l || !aPlus || portraits.some(one => !one)) {
    throw new Refusal(`L's or A+'s picture or a front of ${id} is not the picture round one recorded, where it recorded it: nothing is drawn from it`);
  }
  const shown: Scene['shown'] = {};
  for (const arm of ['T', 'C'] as const) {
    const one = frame(arm);
    if (one) shown[arm] = one.file;
  }
  const inputs = portraits as Input[];
  const [width, height] = portraitCanvas.split('x').map(Number);
  const lPrompt = plan!.arms.L?.prompt;
  const each = lPrompt === undefined ? undefined : eachPrompts(lPrompt, c.prompt, fronts.length);
  const hash = sha256(JSON.stringify([id, l.sha256, aPlus.sha256, inputs.map(one => one.sha256), sha256(t.prompt), sha256(c.prompt), sha256(lPrompt ?? '')]));
  const frontPrompts = fronts.map(front => plan!.portraits?.find(one => one.id === front)?.prompt);
  return { id, bound: fronts.length, fronts, clauses, t: t.prompt, c: c.prompt, ...(each ? { each } : {}), l, aPlus, portraits: inputs,
    portraitCanvas: { width, height }, frontPrompts, shown, hash };
}

// ---- The clothing test ----

// The clothing test of the portraits (docs/action-experiment.md#t-probe-suit), which the owner agreed on 2026-09-26:
// round one's C of the demon at seed 7 drew the demon in his portrait's white tank top, where his scene dressed him in
// a tattered leather skirt and iron bracers. Eight of round one's fronts, the demon's four and the flight's four, are
// drawn again as round one drew them, by its front graph at seed 7 from its own prompts with the clothes alone changed,
// and the demon's C at both seeds from its own prompt with the new fronts in its slots: does a plain dark grey suit
// leak less, and show the build as well as the tank top and trousers? The looks stay round one's, so that the clothes
// alone differ; the bot's portraits keep PORTRAIT_CLOTHES (image-portraits.ts) until the owner has seen these. A
// skin-coloured suit was turned down: the flight's sheet holds two children, it reads as nudity, and it fixes a skin
// tone that may be the wrong one.
export const SUIT_SCENES = ['demon', 'flight'];
const SUIT_C = 'demon';
export const SUIT_CLOTHES = 'wearing a plain sleeveless close-fitting dark grey full-length one-piece athletic suit of matte fabric, '
  + 'covering the torso and legs down to the ankles, and plain dark shoes';
export type SuitFront = { id: string; story: string; prompt: string; old: Input };
// The test's fronts, the demon's first; its C, with round one's prompt, the fronts it binds in slot order and round
// one's own C at each seed where round one drew one; `was`, the clothes round one's fronts wore; and `hash`, what
// probe.json pins the test's cells to.
export type Suit = { fronts: SuitFront[]; c: { story: string; prompt: string; fronts: string[]; old: Record<number, string | undefined> }; was: string;
  hash: string };
export function suitOf(source: string, round: DrawIndex): Suit {
  source = resolve(source);
  const { portraitClothes: clothes, portraitStyle: style, portraitAction: action } = round.pins;
  if (typeof clothes !== 'string' || !clothes || typeof style !== 'string' || typeof action !== 'string') {
    throw new Refusal('Round one\'s draw.json does not say what clothes, style and action its fronts were drawn with: the clothing test changes the clothes alone, and nothing is drawn');
  }
  const scenes = SUIT_SCENES.map(id => sceneOf(source, round, id));
  const fronts = scenes.flatMap(scene => scene.fronts.map((id, at) => {
    // Round one's prompt with its clothes, once, and nothing else changed: the look, the action and the style last.
    const prompt = scene.frontPrompts[at];
    if (prompt === undefined || prompt.split(clothes).length !== 2 || !prompt.includes(action) || !prompt.endsWith(style)) {
      throw new Refusal(`Round one's prompt of ${id} does not carry its clothes once, its action and its style last: the clothing test changes the clothes alone, and nothing is drawn`);
    }
    return { id, story: scene.id, prompt: prompt.split(clothes).join(SUIT_CLOTHES), old: scene.portraits[at] };
  }));
  const own = scenes.find(scene => scene.id === SUIT_C)!;
  const old = Object.fromEntries(ACTION_SEEDS.map(seed => [seed, recorded(source, round, frameKey(SUIT_C, seed, 'C'),
    fileOf(source, { kind: 'frame', story: SUIT_C, id: '', seed, arm: 'C' }), `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`)?.file]));
  const hash = sha256(JSON.stringify([SUIT_CLOTHES, clothes, sha256(readFileSync(FRONT_GRAPH)), fronts.map(one => [one.id, sha256(one.prompt), one.old.sha256]),
    sha256(own.c), own.fronts, ACTION_SEEDS]));
  return { fronts, c: { story: SUIT_C, prompt: own.c, fronts: own.fronts, old }, was: clothes, hash };
}
// Its jobs in the order drawn: the demon's fronts, the demon's C at seed 7 and 11, then the flight's fronts, so that a
// stop leaves the demon's whole where it can. The files go into the probe's suit/.
export type SuitJob = { key: string; kind: 'front' | 'C'; story: string; id: string; seed: number; prompt: string; fronts: string[] };
export function suitJobs(suit: Suit): SuitJob[] {
  const front = (one: SuitFront): SuitJob => ({ key: `front:${one.id}`, kind: 'front', story: one.story, id: one.id, seed: SEED, prompt: one.prompt, fronts: [] });
  const c = ACTION_SEEDS.map((seed): SuitJob => ({ key: `C:${suit.c.story}:s${seed}`, kind: 'C', story: suit.c.story, id: `${suit.c.story}-s${seed}-C`, seed,
    prompt: suit.c.prompt, fronts: suit.c.fronts }));
  return [...suit.fronts.filter(one => one.story === suit.c.story).map(front), ...c, ...suit.fronts.filter(one => one.story !== suit.c.story).map(front)];
}
const suitFile = (job: SuitJob) => join('suit', `${job.id}.png`);
// The front graph round one drew its fronts with, and its canvas, 720x1280, which the test's fronts share.
function frontSetup() {
  const graph = apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))), canvas = portraitCanvas(graph);
  return { graph, canvas, pins: { portraitGraph: sha256(readFileSync(FRONT_GRAPH)), portraitCanvas: `${canvas.width}x${canvas.height}` } };
}
// A job of the test as it goes out: the sampler at the job's seed from the empty latent of its canvas at full denoise,
// no mask node, and a slot for each of its files alone, in order, each through its scale node to 352x640: none for a
// front, the four new fronts for the C.
export function suitRight(graph: Graph, slots: string[], seed: number, canvas: { width: number; height: number }): boolean {
  const found = slotsIn(graph);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const latent = Array.isArray(sampler?.inputs.latent_image) ? graph[String(sampler.inputs.latent_image[0])] : undefined;
  return latent?.class_type === 'EmptyLatentImage' && latent.inputs.width === canvas.width && latent.inputs.height === canvas.height
    && sampler?.inputs.denoise === 1 && sampler.inputs.seed === seed && !Object.values(graph).some(node => MASK_NODES.includes(node.class_type))
    && Object.values(graph).filter(node => node.class_type === 'LoadImage').length === slots.length && found.length === slots.length
    && found.every((one, at) => one.order === at + 1 && one.file === slots[at] && one.size === `${SCALED.width}x${SCALED.height}` && !one.crop);
}

// ---- The boxes and the crops ----

// boxes.json in the probe's directory, marked by eye before any card on round one's pictures: for each scene, by the
// id of each bound person's front, a rectangle [left, top, right, bottom) round that person on L (`L`, for mask and
// mask-each) and round their head and hair on A+ (`A+`, for face and face-each), in the canvas's pixels; and for each
// front, the head-and-shoulders crop face and face-each send of it (`crops`), in the front's pixels, its sides at the
// reference slot's 11:20, so that the scale to 352x640 stretches nothing.
//   { "canvas": "1280x704", "L": { "tango": { "tango-e1": [262, 16, 784, 674], ... }, ... }, "A+": { ... },
//     "crops": { "tango-e1": [185, 35, 537, 675], ... } }
// probe.json pins its hash, so that nothing changes it once drawing starts. A sharp id in it is refused, as anywhere.
export const BOXES_FILE = 'boxes.json';
export type Box = [number, number, number, number];
type ByScene = Record<string, Record<string, Box>>;
export type Boxes = { hash: string; L: ByScene; 'A+': ByScene; crops: Record<string, Box> };
export function readBoxes(out: string): Boxes | undefined {
  const file = join(resolve(out), BOXES_FILE);
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Refusal(`${file} is a link: the boxes are read where the probe lies`);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  const bad = (why: string) => new Refusal(`${file} ${why}; nothing is drawn from it (docs/action-experiment.md#t-probe)`);
  const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  let read: unknown;
  try { read = JSON.parse(bytes.toString('utf8')); } catch { throw bad('is not JSON'); }
  const canvas = `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`;
  if (!object(read) || read.canvas !== canvas || !object(read.L) || !object(read['A+']) || !object(read.crops)) {
    throw bad(`is not the bodies on L and the heads on A+ by scene on their ${canvas} canvas, with the fronts' crops`);
  }
  const boxOf = (value: unknown, what: string, width = FRAME_CANVAS.width, height = FRAME_CANVAS.height): Box => {
    const [left, top, right, bottom] = Array.isArray(value) ? value : [];
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isInteger) || left < 0 || top < 0 || right > width || bottom > height
      || left >= right || top >= bottom) {
      throw bad(`has a ${what} that is not [left, top, right, bottom) on its picture`);
    }
    return [left, top, right, bottom];
  };
  const byScene = (on: 'L' | 'A+', all: Record<string, unknown>): ByScene => Object.fromEntries(Object.entries(all).map(([id, people]) => {
    cleanId(id);
    if (!object(people)) throw bad(`has no ${on} boxes for ${id}`);
    return [id, Object.fromEntries(Object.entries(people).map(([front, box]) => [front, boxOf(box, `${on} box for ${front}`)]))];
  }));
  const crops = Object.fromEntries(Object.entries(read.crops).map(([front, value]) => {
    const story = /^(.+)-e\d+$/.exec(front)?.[1];
    if (story === undefined) throw bad(`has a crop for ${front}, which is not a front's id`);
    cleanId(story);
    const crop = boxOf(value, `crop of ${front}`, Infinity, Infinity);
    if ((crop[2] - crop[0]) * SCALED.height !== (crop[3] - crop[1]) * SCALED.width) {
      throw bad(`has a crop of ${front} whose sides are not the reference slot's ${SCALED.width}:${SCALED.height}, and the scale would stretch it`);
    }
    return [front, crop] as const;
  }));
  return { hash: sha256(bytes), L: byScene('L', read.L), 'A+': byScene('A+', read['A+']), crops };
}

// What a masked variant redraws for a box: the box with `margin` a side, brought out to the latent's grid and kept on
// the canvas, and the paste's `feather` on each side, none at the canvas's edge.
export type Region = { x: number; y: number; width: number; height: number; feather: { left: number; top: number; right: number; bottom: number } };
export function regionOf(box: Box, margin = MASK_MARGIN, feather = MASK_FEATHER): Region {
  const { width, height } = FRAME_CANVAS;
  const x = Math.max(0, Math.floor((box[0] - margin) / GRID) * GRID), y = Math.max(0, Math.floor((box[1] - margin) / GRID) * GRID);
  const right = Math.min(width, Math.ceil((box[2] + margin) / GRID) * GRID), bottom = Math.min(height, Math.ceil((box[3] + margin) / GRID) * GRID);
  return { x, y, width: right - x, height: bottom - y, feather: { left: x > 0 ? feather : 0, top: y > 0 ? feather : 0,
    right: right < width ? feather : 0, bottom: bottom < height ? feather : 0 } };
}
// A masked variant's regions in slot order, one a bound person: round each body on L for mask and mask-each, round
// each head on A+ for face and face-each. A scene with a bound person unboxed, or a box for someone it does not bind,
// is refused.
export function regionsOf(scene: Scene, boxes: Boxes | undefined, variant: Variant): Region[] {
  const on = variant.face ? 'A+' : 'L';
  const marked = boxes?.[on][scene.id] ?? {};
  const lacking = scene.fronts.filter(front => !marked[front]), extra = Object.keys(marked).filter(front => !scene.fronts.includes(front));
  if (!boxes || lacking.length || extra.length) {
    throw new Refusal(!boxes ? `${BOXES_FILE} is missing: ${variant.id} redraws the bound people's ${variant.face ? 'heads' : 'boxes'}, marked before the card`
      : lacking.length ? `${BOXES_FILE} has no ${on} box for ${lacking.join(', ')} of ${scene.id}: ${variant.id} redraws each bound person's, and nothing is drawn`
        : `${BOXES_FILE} has an ${on} box for ${extra.join(', ')}, whom round one's ${scene.id} does not bind: nothing is drawn`);
  }
  return scene.fronts.map(front => (variant.face ? regionOf(marked[front], HEAD_MARGIN, HEAD_FEATHER) : regionOf(marked[front])));
}
// face's and face-each's crops in slot order, one a bound person, each on its front; a front without one is refused.
export type Crop = { x: number; y: number; width: number; height: number };
export function cropsOf(scene: Scene, boxes: Boxes | undefined): Crop[] {
  const lacking = scene.fronts.filter(front => !boxes?.crops[front]);
  if (!boxes || lacking.length) {
    throw new Refusal(`${BOXES_FILE} has no crop of ${lacking.join(', ')}: face and face-each send each bound person's head and shoulders, and nothing is drawn`);
  }
  return scene.fronts.map(front => {
    const [left, top, right, bottom] = boxes.crops[front];
    const { width, height } = scene.portraitCanvas;
    if (right > width || bottom > height) throw new Refusal(`${BOXES_FILE}'s crop of ${front} runs off its ${width}x${height} front: nothing is drawn`);
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}
// What a masked variant draws a scene with: its regions, and for face and face-each its crops.
export const layoutOf = (scene: Scene, boxes: Boxes | undefined, variant: Variant) =>
  ({ regions: regionsOf(scene, boxes, variant), crops: variant.face ? cropsOf(scene, boxes) : [] });

// What round one's pictures were drawn under, which the probe's must share, or its variants would be compared with a T
// of another setup: the card's revision and weights, the action graph, T's opening, the canvas, the reference size, the
// encoder's resolution and the cache's device.
function setupOf(card: ReturnType<typeof cardOf>, base: Graph): Record<string, string | number> {
  const cache = Object.values(base).find(node => node.class_type === 'QwenImage21Cache');
  return { comfyuiRevision: card.comfyuiRevision, transformer: card.transformer, encoder: card.encoder, vae: card.vae,
    actionGraph: sha256(readFileSync(ACTION_GRAPH)), t: sha256(T_OPENING), canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`,
    referenceSize: `${SCALED.width}x${SCALED.height}`, resolution: encoderResolution(base) ?? -1, cacheDevice: String(cache?.inputs.device ?? 'none') };
}
const variantsPin = () => sha256(JSON.stringify({ variants: VARIANTS.map(one => [one.id, one.denoise ?? null, one.mask ?? null, one.face ?? null]),
  half: HALF, words: wordsPrompt([{ role: 'ROLE', image: 2 }]), face: facePrompt([{ role: 'ROLE', image: 2 }]), style: STYLE,
  mask: { margin: MASK_MARGIN, feather: MASK_FEATHER, grid: GRID }, head: { margin: HEAD_MARGIN, feather: HEAD_FEATHER } }));
const readBase = () => apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
const recipeOf = (graph: Graph) => {
  const own = samplerSettingsOf(graph);
  return { steps: own.steps ?? SAMPLER_DEFAULTS.steps, sampler: own.sampler ?? SAMPLER_DEFAULTS.sampler,
    scheduler: own.scheduler ?? SAMPLER_DEFAULTS.scheduler, cfg: own.cfg ?? SAMPLER_DEFAULTS.cfg };
};

// ---- The graphs and the prompts ----

const START_LOADER = '40', START_ENCODE = '41', HALF_SCALE = '42', NOISE_MASK = '43', PASTE = '44', NO_MASK = '45';
const cropNode = (slot: number) => String(50 + slot);
const regionNodes = (at: number) => [60, 61, 62, 63].map(node => String(node + 4 * at));
// The graph a variant sends for `portraits` portraits, before it is filled: today's T graph, image 1 as it is and every
// portrait through its scale node from slot 2, for words, no-style, face and face-each; the same with image 1 through a
// scale node of its own to 640x352 for half; and C's graph, every portrait through its scale node from slot 1, for a
// latent start of L. Once it is filled, `startFrom` gives a latent start its picture, `cropFrom` face's portraits their
// crops, and `maskFrom` a masked variant its masks.
export function probeGraph(base: Graph, variant: Variant, portraits: number): Graph {
  const first = pictureFirst(variant) ? 2 : 1;
  const { graph } = actionGraph(base, Array.from({ length: portraits }, (_, at) => at + first));
  if (variant.id === 'half') {
    const slot = referenceSlots(graph)[0];
    graph[HALF_SCALE] = { class_type: 'ImageScale', inputs: { upscale_method: 'area', width: HALF.width, height: HALF.height, crop: 'disabled', image: [slot.loader, 0] } };
    graph[slot.node].inputs[slot.key] = [HALF_SCALE, 0];
  }
  return graph;
}
// A latent start, once the graph is filled: the sampler starts from the picture through the VAE, 80x44 latents of the
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
// face and face-each, once the graph is filled: each portrait from slot 2 goes through an ImageCrop of its own between
// its loader and its scale node, so that the scale to 352x640 is of the head and shoulders alone. The pinned ImageCrop
// (comfy_extras/nodes_images.py at 73c9bad4) is flagged deprecated there and still registered.
export function cropFrom(filled: Graph, crops: Crop[]): Graph {
  const slots = referenceSlots(filled);
  if (slots.length !== crops.length + 1 || slots.slice(1).some(slot => slot.scale === undefined)) {
    throw Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
  }
  slots.slice(1).forEach((slot, at) => {
    filled[cropNode(at + 2)] = { class_type: 'ImageCrop', inputs: { image: [slot.loader, 0], ...crops[at] } };
    filled[slot.scale!].inputs.image = [cropNode(at + 2), 0];
  });
  return filled;
}
// A masked variant, once its start is in: the sampler redraws the regions alone, through SetLatentNoiseMask on the
// start's latent with their union, and ImageCompositeMasked pastes the decoded picture into the start's own pixels
// through the regions feathered, so that outside them the saved picture is the start pixel for pixel. Both masks are
// made on the card from the numbers, by the pinned nodes: an empty canvas (SolidMask 0), and for each region a
// SolidMask 1 of its size added at its place (MaskComposite `add`, which clamps to 1 where two overlap), through
// FeatherMask for the paste's.
export function maskFrom(filled: Graph, regions: Region[]): Graph {
  const sampler = Object.values(filled).find(node => node.class_type === 'KSampler');
  const saves = Object.values(filled).filter(node => node.class_type === 'SaveImage');
  const decode = Array.isArray(saves[0]?.inputs.images) ? String(saves[0].inputs.images[0]) : '';
  if (!sampler || saves.length !== 1 || filled[decode]?.class_type !== 'VAEDecode' || !regions.length
    || JSON.stringify(sampler.inputs.latent_image) !== JSON.stringify([START_ENCODE, 0])) {
    throw Object.assign(new Error('workflow_no_sampler_or_loader'), { code: 'workflow_no_sampler_or_loader' });
  }
  filled[NO_MASK] = { class_type: 'SolidMask', inputs: { value: 0, width: FRAME_CANVAS.width, height: FRAME_CANVAS.height } };
  let noise = NO_MASK, paste = NO_MASK;
  regions.forEach((region, at) => {
    const [solid, noised, feathered, pasted] = regionNodes(at);
    filled[solid] = { class_type: 'SolidMask', inputs: { value: 1, width: region.width, height: region.height } };
    filled[noised] = { class_type: 'MaskComposite', inputs: { destination: [noise, 0], source: [solid, 0], x: region.x, y: region.y, operation: 'add' } };
    filled[feathered] = { class_type: 'FeatherMask', inputs: { mask: [solid, 0], ...region.feather } };
    filled[pasted] = { class_type: 'MaskComposite', inputs: { destination: [paste, 0], source: [feathered, 0], x: region.x, y: region.y, operation: 'add' } };
    [noise, paste] = [noised, pasted];
  });
  filled[NOISE_MASK] = { class_type: 'SetLatentNoiseMask', inputs: { samples: [START_ENCODE, 0], mask: [noise, 0] } };
  sampler.inputs.latent_image = [NOISE_MASK, 0];
  filled[PASTE] = { class_type: 'ImageCompositeMasked', inputs: { destination: [START_LOADER, 0], source: [decode, 0], x: 0, y: 0, resize_source: false,
    mask: [paste, 0] } };
  saves[0].inputs.images = [PASTE, 0];
  return filled;
}
// The regions a mask chain of `maskFrom` adds onto the empty canvas, read back from a graph as it goes out, the
// paste's with their feathers and the sampler's with none; anything else reads as nothing.
function regionsIn(graph: Graph, link: unknown, feathered: boolean): Region[] | undefined {
  const from = (value: unknown) => (Array.isArray(value) ? graph[String(value[0])] : undefined);
  const regions: Region[] = [];
  let node = from(link);
  for (; node?.class_type === 'MaskComposite' && node.inputs.operation === 'add'; node = from(node.inputs.destination)) {
    const feather = feathered ? from(node.inputs.source) : undefined;
    const solid = feathered ? (feather?.class_type === 'FeatherMask' ? from(feather.inputs.mask) : undefined) : from(node.inputs.source);
    if (regions.length === MOST_BOUND || solid?.class_type !== 'SolidMask' || solid.inputs.value !== 1) return undefined;
    const { left = 0, top = 0, right = 0, bottom = 0 } = (feather?.inputs ?? {}) as Partial<Region['feather']>;
    regions.unshift({ x: Number(node.inputs.x), y: Number(node.inputs.y), width: Number(solid.inputs.width), height: Number(solid.inputs.height),
      feather: { left, top, right, bottom } });
  }
  const empty = node?.class_type === 'SolidMask' && node.inputs.value === 0 && node.inputs.width === FRAME_CANVAS.width && node.inputs.height === FRAME_CANVAS.height;
  return empty ? regions : undefined;
}
// Each reference slot of the encoder in slot order as the graph goes out: the file on its loader, the size its scale
// node asks for ('own' without one), and the rectangle an ImageCrop between the two cuts.
function slotsIn(graph: Graph) {
  const from = (link: unknown) => (Array.isArray(link) ? graph[String(link[0])] : undefined);
  const found: { order: number; file: unknown; size: string; crop?: Crop }[] = [];
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      const slot = /^images\.image_(\d+)$/.exec(key);
      const linked = from(value);
      if (!slot || !linked) continue;
      const scale = linked.class_type === 'ImageScale' ? linked : undefined;
      const behind = scale ? from(scale.inputs.image) : linked;
      const crop = behind?.class_type === 'ImageCrop' ? behind : undefined;
      const loader = crop ? from(crop.inputs.image) : behind;
      found.push({ order: Number(slot[1]), file: loader?.class_type === 'LoadImage' ? loader.inputs.image : undefined,
        size: scale ? `${scale.inputs.width}x${scale.inputs.height}` : 'own',
        ...(crop ? { crop: { x: Number(crop.inputs.x), y: Number(crop.inputs.y), width: Number(crop.inputs.width), height: Number(crop.inputs.height) } } : {}) });
    }
  }
  return found.sort((a, b) => a.order - b.order);
}
// The graph as it goes out: each slot the file the variant names, in order, at the size it says (image 1 as it is for
// T's form, half's at 640x352, every portrait at 352x640), face's portraits through their crops and no other slot
// through one; the sampler starting from the empty latent of the canvas at full denoise, or for a latent start from
// its upload through the VAE at the variant's denoise, with no empty latent left, and for face the same upload as image
// 1; and for a masked variant, that latent under a noise mask of the regions, and the picture saved the decoded one
// pasted into the start's own pixels through the regions feathered, where any other variant has no mask node at all.
const MASK_NODES = ['SetLatentNoiseMask', 'ImageCompositeMasked', 'SolidMask', 'MaskComposite', 'FeatherMask'];
export function graphRight(graph: Graph, variant: Variant, slots: string[], start?: string, regions: Region[] = [], crops: Crop[] = []): boolean {
  const found = slotsIn(graph), first = pictureFirst(variant);
  const wanted = (at: number) => (at > 0 || !first ? `${SCALED.width}x${SCALED.height}` : variant.id === 'half' ? `${HALF.width}x${HALF.height}` : 'own');
  const cut = (at: number) => (variant.face && at > 0 ? crops[at - 1] : undefined);
  const from = (link: unknown) => (Array.isArray(link) ? graph[String(link[0])] : undefined);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const noised = from(sampler?.inputs.latent_image);
  const latent = variant.mask ? (noised?.class_type === 'SetLatentNoiseMask' ? from(noised.inputs.samples) : undefined) : noised;
  const begins = !latentStart(variant)
    ? latent?.class_type === 'EmptyLatentImage' && latent.inputs.width === FRAME_CANVAS.width && latent.inputs.height === FRAME_CANVAS.height && sampler?.inputs.denoise === 1
    : latent?.class_type === 'VAEEncode' && from(latent.inputs.pixels)?.class_type === 'LoadImage' && from(latent.inputs.pixels)?.inputs.image === start
      && from(latent.inputs.vae)?.class_type === 'VAELoader' && sampler?.inputs.denoise === variant.denoise
      && !Object.values(graph).some(node => node.class_type === 'EmptyLatentImage') && (!variant.face || slots[0] === start);
  const saved = Object.values(graph).filter(node => node.class_type === 'SaveImage');
  const pasted = saved.length === 1 ? from(saved[0].inputs.images) : undefined, decoded = from(pasted?.inputs.source);
  const places = (list?: Region[]) => JSON.stringify(list?.map(one => [one.x, one.y, one.width, one.height]));
  const masked = !variant.mask ? !Object.values(graph).some(node => MASK_NODES.includes(node.class_type))
    : regions.length > 0 && pasted?.class_type === 'ImageCompositeMasked' && from(pasted.inputs.destination) === from(latent?.inputs.pixels)
      && decoded?.class_type === 'VAEDecode' && from(decoded.inputs.samples) === sampler && pasted.inputs.x === 0 && pasted.inputs.y === 0
      && pasted.inputs.resize_source === false && places(regionsIn(graph, noised?.inputs.mask, false)) === places(regions)
      && JSON.stringify(regionsIn(graph, pasted.inputs.mask, true)) === JSON.stringify(regions);
  return begins && masked && (!variant.face || crops.length === slots.length - 1) && found.length === slots.length
    && found.every((one, at) => one.order === at + 1 && one.file === slots[at] && one.size === wanted(at) && JSON.stringify(one.crop) === JSON.stringify(cut(at)));
}
// The prompt a variant sends: words' own; T's without its style line; T's; for a latent start of L, C's, whose clauses
// bind the portraits from image 1, as `mask` does; for `mask-each`, the pass's own; and for face the face prompt over
// all the clauses, for face-each over the pass's person alone, bound to image 2.
export function probePrompt(scene: Scene, variant: Variant, pass = 1): string {
  if (variant.id === 'words') return wordsPrompt(scene.clauses);
  if (variant.id === 'no-style') return scene.t.slice(0, scene.t.length - STYLE.length - 1);
  if (variant.face) return facePrompt(variant.mask === 'each' ? [{ role: scene.clauses[pass - 1].role, image: 2 }] : scene.clauses);
  if (variant.mask === 'each') {
    const prompt = scene.each?.[pass - 1];
    if (prompt === undefined) throw new Refusal(`mask-each has no prompt for pass ${pass} of ${scene.id}`);
    return prompt;
  }
  return latentStart(variant) ? scene.c : scene.t;
}

// ---- The prices ----

// A job's time from round one's own clean frames on the same kind of card, uploads included: T's form (words,
// no-style, face and face-each) as its T with as many pictures, half as its C with one picture more than the scene
// binds (image 1 at 640x352 is one portrait's 880 tokens), and a latent start of L as its C with as many portraits. A
// job's pictures are the scene's bound people, or one a pass for mask-each and face-each, and image 1 in T's form; the
// VAE's encode of one picture, a crop, the masks and the paste are well inside the margin. A count round one never
// drew takes the fewest above it, and failing that its arm's whole. The clothing test's fronts are priced as round
// one's fronts, and its C as its C with as many portraits. `price` is the slowest, a quarter more and three seconds, as
// the harness prices (action-draw.ts `pricing`); `expected` the median. A cell is one variant on one scene: one job,
// or one a bound person for mask-each and face-each; each cell of the clothing test is one job.
export const passesOf = (variant: Variant, bound: number) => (variant.mask === 'each' ? bound : 1);
const imagesOf = (variant: Variant, bound: number) => (variant.mask === 'each' ? 1 : bound) + (pictureFirst(variant) ? 1 : 0);
export type JobKind = { arm: 'front' | 'T' | 'C'; images: number };
export const jobOf = (variant: Variant, bound: number): JobKind => ({ arm: pictureFirst(variant) && variant.id !== 'half' ? 'T' : 'C', images: imagesOf(variant, bound) });
export const suitKind = (job: SuitJob): JobKind => ({ arm: job.kind === 'front' ? 'front' : 'C', images: job.fronts.length });
export function timesOf(round: DrawIndex) {
  // A job whose loaders missed the cache was cold, the run's first or the first on a new card, and a cold start is
  // priced apart (COLD_MS): round one's first front took 31 s against 15.5 s warm.
  const drawn = Object.values(round.cells).filter(one => one.status === 'drawn' && !isSharp(one.story) && one.totalMs !== undefined && !one.loaderCacheMiss);
  const time = (one: CellRecord) => one.totalMs! + (one.uploadMs ?? 0);
  const pool = ({ arm, images }: JobKind) => {
    const like = drawn.filter(one => (arm === 'front' ? one.kind === 'front' : one.kind === 'frame' && one.arm === arm));
    const above = like.filter(one => one.references >= images);
    const fewest = Math.min(...above.map(one => one.references));
    return (above.length ? above.filter(one => one.references === fewest) : like).map(time);
  };
  return {
    price: (job: JobKind) => {
      const times = pool(job);
      return times.length ? Math.round(Math.max(...times) * MARGIN + CELL_MS) : Infinity;
    },
    expected: (job: JobKind) => {
      const times = pool(job);
      return times.length ? median(times) : Infinity;
    },
  };
}
// The first job of a run loads the weights onto the card: round one's first frame took 31 s against 16 s warm.
const COLD_MS = 30000;

// The plan's cells, its jobs and their minutes, the clothing test's included when it is drawn and apart as `suit`:
// expected from round one's medians, and at the prices a scene or the test is admitted by.
export function estimateOf(round: DrawIndex, scenes: Scene[], variants: Variant[], suit?: Suit) {
  const times = timesOf(round);
  const tested = suit ? suitJobs(suit).map(suitKind) : [];
  const jobs = [...tested, ...scenes.flatMap(scene => variants.flatMap(variant => Array.from({ length: passesOf(variant, scene.bound) }, () => jobOf(variant, scene.bound))))];
  const sum = (list: JobKind[], read: (job: JobKind) => number) => list.reduce((total, job) => total + read(job), 0);
  const minutes = (ms: number) => Math.round(ms / 6000) / 10;
  return { scenes: scenes.length, variants: variants.length, cells: scenes.length * variants.length + tested.length, jobs: jobs.length,
    expectedMinutes: minutes(sum(jobs, times.expected) + COLD_MS / 2), pricedMinutes: minutes(sum(jobs, times.price) + COLD_MS),
    ...(suit ? { suit: { cells: tested.length, expectedMinutes: minutes(sum(tested, times.expected)), pricedMinutes: minutes(sum(tested, times.price)) } } : {}) };
}

// ---- The drawing ----

export const cellKey = (story: string, variant: VariantId) => `${story}:${variant}`;
// One job: its picture, or its failure.
export type JobRecord = { status: 'drawn' | 'failed'; code?: string; httpStatus?: number; oom?: boolean; references: number;
  file?: string; sha256?: string; bytes?: number; width?: number; height?: number; cold?: boolean; totalMs?: number; viewMs?: number;
  uploadMs?: number; phases?: Phases; loaderCacheMiss?: boolean; vram?: Vram[]; vramSamples?: number; partialModelLoadEvents?: number;
  promptChars?: number; graphRight?: boolean };
export type ProbeJob = JobRecord & { pass: number };
// One cell of the clothing test, its one job; `out` where a front its C binds was not drawn, with the code of why.
export type SuitCell = Omit<JobRecord, 'status'> & { key: string; kind: SuitJob['kind']; story: string; id: string; seed: number;
  status: 'drawn' | 'failed' | 'out' };
// One variant on one scene: its jobs in pass order, one, or one a bound person for mask-each and face-each, each pass
// after the first starting from the picture of the one before. `drawn` once its last pass is, whose picture is the
// cell's `file`; `failed` once a pass failed, the passes after it never drawn; `partial` where the end came between two
// passes, and a resume goes on from the last picture.
export type ProbeCell = { key: string; story: string; variant: VariantId; passes: number; status: 'drawn' | 'failed' | 'partial'; code?: string;
  file?: string; jobs: ProbeJob[] };
// probe.json: ids, codes, sizes, counts and times, no prompt. `scenes` pins each scene's inputs, and `suit.hash` the
// clothing test's; `sameServer` says whether the server said what it said to round one (ComfyUI, PyTorch, the card),
// which the comparison does not need.
export type ProbeIndex = { pins: Record<string, string | number>; startedAt: string; completedAt?: string; sameServer?: boolean;
  scenes: Record<string, string>; cells: Record<string, ProbeCell>; suit?: { hash: string; cells: Record<string, SuitCell> }; stopped?: 'until';
  error?: string };
// `suit`: whether the clothing test is drawn, by default when no scene is named.
export type ProbeOptions = { source: string; out: string; comfy: string; until: number; scenes?: string[]; variants?: VariantId[]; suit?: boolean;
  timeoutMs?: number; waitMs?: number; pollMs?: number; log?: (event: object) => void };
const open = (cell: ProbeCell | undefined) => !cell || cell.status === 'partial';

// The picture a partial cell's last pass left, as probe.json recorded it: the cell goes on from it and from nothing else.
function lastPicture(out: string, cell: ProbeCell): Input {
  const last = cell.jobs.at(-1), path = last?.file === undefined ? undefined : join(out, last.file);
  const bytes = path && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && existsSync(path) ? readFileSync(path) : undefined;
  if (!last || last.status !== 'drawn' || !bytes || sha256(bytes) !== last.sha256) {
    throw new Refusal(`The picture of pass ${cell.jobs.length} of ${cell.key} is not the one probe.json records: that is data lost or changed, to be looked into; nothing is drawn`);
  }
  return { file: last.file!, bytes, sha256: last.sha256! };
}

// The clothing test first, then every scene in turn, and in it every variant not yet recorded, in the list's order, a
// cell's passes in slot order: the test and each scene begin only if all they have left can end by `--until`, each
// cell only if all its passes left can, and each job only if it still can, so that a stop leaves the test and the
// scenes whole. The test goes first because it is small and draws with the two graphs round one drew with, before the
// masked variants' nodes, which are new to the card. A cell with an outcome keeps it; nothing is drawn again.
export async function drawProbe(options: ProbeOptions): Promise<ProbeIndex> {
  const source = resolve(options.source), out = resolve(options.out);
  const log = options.log ?? (() => undefined);
  const ids = options.scenes ?? PROBE_SCENES, withSuit = options.suit ?? !options.scenes;
  // Everything is read and checked before probe.json is written or the server is asked anything, and a sealed id is
  // refused before a byte of round one is read.
  ids.forEach(cleanId);
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(out, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${out} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says before anything is drawn`); }
  const base = readBase(), round = roundOf(source), setup = setupOf(card, base), front = frontSetup();
  const differs = Object.keys(setup).filter(key => round.pins[key] !== setup[key]);
  if (differs.length) throw new Refusal(`Round one was drawn under another ${differs.join(', ')}: its T is not today's T on this card, and nothing is drawn`);
  const otherFronts = Object.keys(front.pins).filter(key => round.pins[key] !== front.pins[key as keyof typeof front.pins]);
  if (withSuit && otherFronts.length) {
    throw new Refusal(`Round one's fronts were drawn under another ${otherFronts.join(', ')}: the clothing test's would differ from them in more than their clothes, and nothing is drawn; --scenes without suit draws the scenes alone`);
  }
  const scenes = ids.map(id => sceneOf(source, round, id)), suit = suitOf(source, round);
  const variants = options.variants ? VARIANTS.filter(one => options.variants!.includes(one.id)) : VARIANTS;
  // The boxes and the crops, pinned with the rest whatever is drawn: a masked variant is drawn only where every bound
  // person has a box, and face and face-each also a crop.
  const boxes = readBoxes(out);
  if (!boxes) throw new Refusal(`${BOXES_FILE} is missing from ${out}: the boxes and the crops are marked before the card and pinned with the rest (docs/action-experiment.md#t-probe); nothing is drawn`);
  const layouts = new Map<string, ReturnType<typeof layoutOf>>();
  for (const scene of scenes) for (const variant of variants) if (variant.mask) layouts.set(cellKey(scene.id, variant.id), layoutOf(scene, boxes, variant));
  const file = join(out, 'probe.json');
  const earlier = readJson<ProbeIndex>(file);
  // A picture probe.json records as drawn whose file is gone is data lost: nothing more is drawn before someone looks.
  const gone = (one: { status: string; file?: string }) => one.status === 'drawn' && !(one.file && existsSync(join(out, one.file)));
  const lost = [...Object.values(earlier?.cells ?? {}).filter(cell => (cell.jobs ?? []).some(gone)),
    ...Object.values(earlier?.suit?.cells ?? {}).filter(gone).map(cell => ({ key: `suit:${cell.key}` }))];
  if (lost.length) throw new Refusal(`probe.json records pictures of ${lost.length} cells whose files are gone from ${out}, ${lost[0].key} the first: that is data lost, to be looked into; nothing is drawn`);
  const moved = scenes.find(scene => earlier?.scenes[scene.id] !== undefined && earlier.scenes[scene.id] !== scene.hash);
  if (moved) throw new Refusal(`Round one's ${moved.id} is not what ${file} drew from: one probe directory holds one set of inputs`);
  if (withSuit && earlier?.suit && earlier.suit.hash !== suit.hash) {
    throw new Refusal(`The clothing test's inputs are not what ${file} drew from: one probe directory holds one set of inputs`);
  }
  const resumed = new Map<string, Input>();
  for (const scene of scenes) {
    for (const variant of variants) {
      const cell = earlier?.cells[cellKey(scene.id, variant.id)];
      if (cell?.status === 'partial') resumed.set(cell.key, lastPicture(out, cell));
    }
  }
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => {
    throw new Refusal(comfy.end?.aborted ? 'The end (--until) came before the server said what it is; nothing is drawn'
      : 'The server did not say what it is on /system_stats (ComfyUI, PyTorch and the card), and the probe is pinned to that too; nothing is drawn');
  });
  const pins: Record<string, string | number> = { ...setup, style: sha256(STYLE), variants: variantsPin(), seed: SEED, boxes: boxes.hash, ...server };
  const changed = earlier && [...new Set([...Object.keys(pins), ...Object.keys(earlier.pins)])].find(key => earlier.pins[key] !== pins[key]);
  if (changed) throw new Refusal(`${file} was drawn under another ${changed}; one probe directory holds one set of pins`);
  const index: ProbeIndex = earlier ?? { pins, startedAt: new Date().toISOString(), scenes: {}, cells: {} };
  index.sameServer = ['comfyui', 'pytorch', 'card'].every(key => round.pins[key] === pins[key]);
  for (const scene of scenes) index.scenes[scene.id] = scene.hash;
  if (withSuit) index.suit ??= { hash: suit.hash, cells: {} };
  delete index.stopped;
  delete index.error;
  delete index.completedAt;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, index);
  save();
  const page = () => writePage(source, out, { scenes, suit });
  const times = timesOf(round), recipe = recipeOf(base), frontRecipe = recipeOf(front.graph), uploaded = new Map<string, string>();
  let cold = true;
  const price = (job: JobKind) => times.price(job) + (cold ? COLD_MS : 0);
  const jobsLeft = (scene: Scene, variant: Variant) => passesOf(variant, scene.bound) - (index.cells[cellKey(scene.id, variant.id)]?.jobs.length ?? 0);
  const tests = withSuit ? suitJobs(suit).filter(job => !index.suit!.cells[job.key]) : [];
  log({ event: 'probe_plan', ...estimateOf(round, scenes, variants, withSuit ? suit : undefined),
    left: tests.length + scenes.reduce((sum, scene) => sum + variants.filter(one => open(index.cells[cellKey(scene.id, one.id)])).length, 0), sameServer: index.sameServer });
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
  // One job, as every cell draws it: its uploads and its graph, which goes out only if it is right; the picture saved at
  // `path` and handed to `keep` with its record before anything more is asked of the card, then the card's log read for
  // partial loads; or the failure handed to `keep` with its code. `until` where the end came first, and `stopped` where
  // the failure was the graph's or the server's, not the picture's.
  const attempt = async <T extends { references: number }>(own: T, path: string, fits: () => boolean, tag: object,
    build: (spent: { ms: number }) => Promise<{ graph: Graph; right: boolean; promptChars: number }>,
    keep: (record: T & JobRecord, bytes?: Buffer) => void): Promise<'drawn' | 'failed' | 'until' | 'stopped'> => {
    let sent = false;
    try {
      const spent = { ms: 0 };
      const built = await build(spent);
      if (!built.right) throw Object.assign(new Error('workflow_slot_mismatch'), { code: 'workflow_slot_mismatch' });
      const before = await logLines(comfy);
      sent = true;
      const drawn = await drawOne(comfy, built.graph, { pollMs: options.pollMs, waitMs: options.waitMs ?? WAIT_MS, sampleEvery: 1, requireSocket: true, admit: fits });
      // The picture is down, and it is kept whatever comes next: saved and recorded before anything more is asked.
      await settled();
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const size = pngSize(drawn.bytes);
      const record: T & JobRecord = { ...own, status: 'drawn', file: relative(out, path), sha256: sha256(drawn.bytes), bytes: drawn.bytes.length, ...size,
        ...(cold ? { cold } : {}), totalMs: drawn.totalMs, viewMs: drawn.viewMs, ...(spent.ms ? { uploadMs: Math.round(spent.ms) } : {}), ...drawn.timing,
        vram: drawn.vram, vramSamples: drawn.memory.samples, promptChars: built.promptChars, graphRight: true };
      keep(record, Buffer.from(drawn.bytes));
      cold = false;
      save();
      log({ event: 'cell_drawn', ...tag, totalMs: drawn.totalMs, width: size.width, height: size.height });
      if (comfy.end?.aborted) return 'until';
      const loads = partialLoadsSince(before, await logLines(comfy));
      if (loads !== undefined) {
        record.partialModelLoadEvents = loads;
        save();
      }
      return 'drawn';
    } catch (error) {
      if (sent) cold = false;
      const raw = (error as { code?: unknown }).code;
      // Whatever failed once the end had come was cut by it, and a job its time no longer covered was never sent.
      if (comfy.end?.aborted || raw === 'not_admitted') return 'until';
      const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : 'image_failed';
      const { httpStatus } = safeErrorDetails(error);
      const failure = { code, ...(httpStatus === undefined ? {} : { httpStatus }), ...((error as { oom?: unknown }).oom === true ? { oom: true } : {}) };
      keep({ ...own, status: 'failed', ...failure });
      save();
      log({ event: 'cell_failed', ...tag, ...failure });
      // The graph or the server, not this picture: the probe stops, and a resume goes on after this cell.
      if (stopsTheRun(code)) { index.error = code; return 'stopped'; }
      return 'failed';
    }
  };

  let ended: 'done' | 'until' | 'stopped' = 'done';
  // The clothing test, begun only if all it has left can end by `--until`. A new front the C sends is drawn here, the
  // very file probe.json records, on the front's canvas; a C whose fronts are not all that is out with the code of why.
  const tested = index.suit?.cells ?? {};
  const newFront = (id: string): Input | string => {
    const one = tested[`front:${id}`];
    if (one?.status !== 'drawn') return one ? 'front_failed' : 'front_missing';
    const path = join(out, one.file ?? '');
    const bytes = one.file && !lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && existsSync(path) ? readFileSync(path) : undefined;
    const size = bytes ? pngSize(bytes) : undefined;
    return bytes && sha256(bytes) === one.sha256 && size?.width === front.canvas.width && size?.height === front.canvas.height
      ? { file: one.file!, bytes, sha256: one.sha256! } : 'reference_mismatch';
  };
  if (tests.length) {
    const needMs = tests.reduce((sum, job) => sum + times.price(suitKind(job)), cold ? COLD_MS : 0), leftMs = options.until - Date.now();
    if (comfy.end?.aborted || needMs > leftMs) {
      log({ event: 'suit_not_begun', cells: tests.length, needMinutes: Math.ceil(needMs / 60000), leftMinutes: Math.max(0, Math.floor(leftMs / 60000)) });
      ended = 'until';
    }
    for (const job of ended === 'done' ? tests : []) {
      const tag = { key: `suit:${job.key}` }, own = { key: job.key, kind: job.kind, story: job.story, id: job.id, seed: job.seed, references: job.fronts.length };
      const refs = job.fronts.map(newFront), inputs = refs.filter((one): one is Input => typeof one !== 'string');
      const missing = refs.find((one): one is string => typeof one === 'string');
      if (missing !== undefined) {
        tested[job.key] = { ...own, status: 'out', code: missing };
        save();
        log({ event: 'cell_out', ...tag, code: missing });
        continue;
      }
      const fits = () => !comfy.end?.aborted && Date.now() + price(suitKind(job)) <= options.until;
      if (!fits()) { ended = 'until'; break; }
      const isFront = job.kind === 'front', canvas = isFront ? front.canvas : FRAME_CANVAS;
      const result = await attempt(own, join(out, suitFile(job)), fits, tag, async spent => {
        const slots: string[] = [];
        for (const input of inputs) slots.push(await name(input, spent));
        const graph = isFront ? front.graph : actionGraph(base, slots.map((_, at) => at + 1)).graph;
        const filled = applyToWorkflow(graph, { checkpoint: card.model, prompt: job.prompt, negative: '', seed: job.seed, ...(isFront ? frontRecipe : recipe),
          ...canvas, ...(slots.length ? { references: slots } : {}) });
        return { graph: filled, right: suitRight(filled, slots, job.seed, canvas), promptChars: job.prompt.length };
      }, record => { tested[job.key] = record; });
      if (result === 'until' || result === 'stopped') { ended = result; break; }
    }
    page();
  }

  if (ended === 'done') {
    scenes: for (const scene of scenes) {
      const left = variants.filter(variant => open(index.cells[cellKey(scene.id, variant.id)]));
      if (!left.length) continue;
      const needMs = left.reduce((sum, variant) => sum + jobsLeft(scene, variant) * times.price(jobOf(variant, scene.bound)), cold ? COLD_MS : 0);
      const leftMs = options.until - Date.now();
      if (comfy.end?.aborted || needMs > leftMs) {
        log({ event: 'scene_not_begun', story: scene.id, cells: left.length, needMinutes: Math.ceil(needMs / 60000), leftMinutes: Math.max(0, Math.floor(leftMs / 60000)) });
        ended = 'until';
        break;
      }
      for (const variant of left) {
        const key = cellKey(scene.id, variant.id), passes = passesOf(variant, scene.bound), each = variant.mask === 'each', kind = jobOf(variant, scene.bound);
        const cell: ProbeCell = index.cells[key] ?? { key, story: scene.id, variant: variant.id, passes, status: 'partial', jobs: [] };
        const fits = () => !comfy.end?.aborted && Date.now() + price(kind) <= options.until;
        if (comfy.end?.aborted || Date.now() + jobsLeft(scene, variant) * times.price(kind) + (cold ? COLD_MS : 0) > options.until) {
          ended = 'until';
          break scenes;
        }
        const layout = layouts.get(key);
        // The picture the next pass changes: the variant's own, L's or A+'s, or the one the pass before left.
        let picture = resumed.get(key) ?? (variant.face ? scene.aPlus : scene.l);
        for (let pass = cell.jobs.length + 1; pass <= passes; pass++) {
          if (!fits()) { ended = 'until'; break scenes; }
          const portraits = each ? [scene.portraits[pass - 1]] : scene.portraits, from = picture;
          const path = join(out, scene.id, passes > 1 ? `${variant.id}-${pass}.png` : `${variant.id}.png`);
          const result = await attempt({ pass, references: portraits.length + (pictureFirst(variant) ? 1 : 0) }, path, fits, { key, ...(passes > 1 ? { pass } : {}) },
            async spent => {
              const slots: string[] = [];
              for (const input of pictureFirst(variant) ? [from, ...portraits] : portraits) slots.push(await name(input, spent));
              const start = latentStart(variant) ? await name(from, spent) : undefined;
              const regions = !layout ? [] : each ? [layout.regions[pass - 1]] : layout.regions;
              const crops = !layout?.crops.length ? [] : each ? [layout.crops[pass - 1]] : layout.crops;
              const prompt = probePrompt(scene, variant, pass);
              const filled = applyToWorkflow(probeGraph(base, variant, portraits.length), { checkpoint: card.model, prompt, negative: '', seed: SEED, ...recipe,
                ...FRAME_CANVAS, references: slots });
              if (start !== undefined) startFrom(filled, variant, start);
              if (crops.length) cropFrom(filled, crops);
              if (regions.length) maskFrom(filled, regions);
              return { graph: filled, right: graphRight(filled, variant, slots, start, regions, crops), promptChars: prompt.length };
            },
            (job, bytes) => {
              cell.jobs.push(job);
              if (job.status === 'failed') Object.assign(cell, { status: 'failed', code: job.code });
              else if (pass === passes) Object.assign(cell, { status: 'drawn', file: job.file });
              index.cells[key] = cell;
              if (bytes) picture = { file: job.file!, bytes, sha256: job.sha256! };
            });
          if (result === 'until' || result === 'stopped') { ended = result; break scenes; }
          // A pass that failed leaves the passes after it nothing to start from.
          if (result === 'failed') break;
        }
      }
      page();
    }
  }
  // A failed cell's delete may still be on its way, and the run is not over before the card has had it.
  await settled();
  if (ended === 'until') index.stopped = 'until';
  index.completedAt = new Date().toISOString();
  save();
  page();
  log({ event: 'probe_done', ended, ...countsOf(index) });
  return index;
}
const countsOf = (index: ProbeIndex) => {
  const cells = Object.values(index.cells), tested = Object.values(index.suit?.cells ?? {});
  const tally = (list: { code?: string }[]) => list.reduce<Record<string, number>>((all, one) => ({ ...all, [one.code ?? 'image_failed']: (all[one.code ?? 'image_failed'] ?? 0) + 1 }), {});
  return { drawn: cells.filter(one => one.status === 'drawn').length, partial: cells.filter(one => one.status === 'partial').length,
    failed: tally(cells.filter(one => one.status === 'failed')), jobs: cells.reduce((sum, one) => sum + one.jobs.filter(job => job.status === 'drawn').length, 0),
    planned: Object.keys(index.scenes).length * VARIANTS.length,
    ...(index.suit ? { suit: { drawn: tested.filter(one => one.status === 'drawn').length, failed: tally(tested.filter(one => one.status !== 'drawn')) } } : {}) };
};

// ---- The page ----

const COLOURS = ['#ff1744', '#00e676', '#00b0ff', '#ffea00'];
// Rectangles over a picture, in its own pixels: each marked box thin, the region a variant redraws round it thick, in
// the colour of the person's slot and numbered by it.
function overlay(width: number, height: number, marks: { box: Box; region?: Region; at: number }[]) {
  if (!marks.length) return '';
  const rect = (x: number, y: number, w: number, h: number, colour: string, stroke: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${colour}" stroke-width="${stroke}" vector-effect="non-scaling-stroke"/>`;
  const size = Math.round(height / 18);
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${marks.map(({ box, region, at }) => {
    const colour = COLOURS[at % COLOURS.length];
    return rect(box[0], box[1], box[2] - box[0], box[3] - box[1], colour, 1.5) + (region ? rect(region.x, region.y, region.width, region.height, colour, 3.5) : '')
      + `<text x="${box[0] + 6}" y="${box[1] + size}" fill="${colour}" font-size="${size}" font-family="sans-serif">${at + 1}</text>`;
  }).join('')}</svg>`;
}

// index.html in the probe's directory: what T did in round one and what each variant changes, then each scene's
// portraits with their crops, round one's L with the bodies and A+ with the heads, T and C, every variant and each
// pass of mask-each and face-each, and last the clothing test, each front of round one beside its new one and the
// demon's C of round one beside the new at each seed, each picture linked where it lies and never copied. Before the
// card, with no probe.json yet, it shows round one's pictures and the boxes and crops over them for the owner to check.
// While the probe draws, the page reloads every minute.
export function writePage(source: string, out: string, read?: { scenes: Scene[]; suit: Suit }) {
  source = resolve(source);
  out = resolve(out);
  const index = readJson<ProbeIndex>(join(out, 'probe.json'));
  const round = read ? undefined : roundOf(source);
  const scenes = read?.scenes ?? (index ? Object.keys(index.scenes) : PROBE_SCENES).map(id => sceneOf(source, round!, id));
  const suit = read?.suit ?? suitOf(source, round!);
  const boxes = readBoxes(out);
  const drawing = index !== undefined && !index.completedAt;
  const figure = (path: string | undefined, caption: string, shape: 'wide' | 'half' | 'tall' | 'side', missing: string, over = '') => {
    const src = path && existsSync(path) ? escapeHtml(relative(out, path).split(sep).join('/')) : undefined;
    const body = src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>` : `<div class="box">${escapeHtml(missing)}</div>`;
    return `<figure class="${shape}">${src && over ? `<div class="over">${body}${over}</div>` : body}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  const notYet = drawing || !index ? 'ещё не нарисовано' : 'не нарисовано';
  const sections = scenes.map(scene => {
    const title = ACTION_STORIES.find(one => one.id === scene.id)?.label ?? scene.id;
    const marks = (on: 'L' | 'A+') => scene.fronts.flatMap((front, at) => {
      const box = boxes?.[on][scene.id]?.[front];
      return box ? [{ box, region: on === 'A+' ? regionOf(box, HEAD_MARGIN, HEAD_FEATHER) : regionOf(box), at }] : [];
    });
    const portraits = scene.portraits.map((one, at) => {
      const crop = boxes?.crops[scene.fronts[at]];
      return figure(join(source, one.file), `портрет ${at + 1}${crop ? `, кадр ${crop[2] - crop[0]}x${crop[3] - crop[1]}` : ', кадра нет'}`, 'tall', 'нет файла',
        crop ? overlay(scene.portraitCanvas.width, scene.portraitCanvas.height, [{ box: crop, at }]) : '');
    }).join('');
    const bodies = marks('L'), heads = marks('A+');
    const count = (list: unknown[], what: string) => (list.length === scene.bound ? what : `${what}: рамок ${list.length} из ${scene.bound}`);
    const pictures = figure(join(source, scene.l.file), `L — раунд 1, ${count(bodies, 'тела для mask и mask-each')}`, 'half', 'нет файла',
      overlay(FRAME_CANVAS.width, FRAME_CANVAS.height, bodies))
      + figure(join(source, scene.aPlus.file), `A+ — раунд 1, ${count(heads, 'головы для face и face-each')}`, 'half', 'нет файла',
        overlay(FRAME_CANVAS.width, FRAME_CANVAS.height, heads));
    const cells = [...(['T', 'C'] as const).map(arm => figure(scene.shown[arm] && join(source, scene.shown[arm]), `${arm} — раунд 1`, 'wide', 'нет в записи раунда')),
      ...VARIANTS.map(variant => {
        const one = index?.cells[cellKey(scene.id, variant.id)];
        const passes = passesOf(variant, scene.bound);
        return figure(one?.status === 'drawn' && one.file ? join(out, one.file) : undefined,
          `${variant.id} — ${variant.short}${passes > 1 ? `, после ${passes} проходов` : ''}`, 'wide',
          one?.status === 'failed' ? `не вышло${passes > 1 ? ` на проходе ${one.jobs.length}` : ''}: ${one.code ?? '—'}`
            : one?.status === 'partial' ? `начато: проходов ${one.jobs.length} из ${passes}` : one ? 'нет файла' : notYet);
      })].join('');
    const passes = VARIANTS.filter(variant => variant.mask === 'each').map(variant => {
      const one = index?.cells[cellKey(scene.id, variant.id)];
      return `<div class="row">${scene.fronts.map((_, at) => {
        const job = one?.jobs[at];
        return figure(job?.status === 'drawn' && job.file ? join(out, job.file) : undefined, `${variant.id}, проход ${at + 1} из ${scene.bound}: портрет ${at + 1}`,
          'wide', job?.status === 'failed' ? `не вышло: ${job.code ?? '—'}` : one?.status === 'failed' ? 'не рисовался: проход до него не вышел' : job ? 'нет файла' : notYet);
      }).join('')}</div>`;
    }).join('');
    return `<section><h2>${escapeHtml(scene.id)}: ${escapeHtml(title)}, портретов ${scene.bound}</h2><div class="row">${portraits}</div>`
      + `<div class="row">${pictures}</div><div class="row">${cells}</div>${passes}</section>`;
  });
  const tested = index?.suit?.cells ?? {};
  const fresh = (key: string) => (tested[key]?.status === 'drawn' && tested[key].file ? join(out, tested[key].file!) : undefined);
  const why = (one: SuitCell | undefined) => (one?.status === 'failed' ? `не вышло: ${one.code ?? '—'}` : one?.status === 'out' ? `не рисовался: ${one.code ?? '—'}`
    : one ? 'нет файла' : notYet);
  const suitFronts = SUIT_SCENES.map(story => `<div class="row">${suit.fronts.filter(one => one.story === story).map(one => `<div class="pair">`
    + figure(join(source, one.old.file), `${one.id} — раунд 1`, 'side', 'нет файла')
    + figure(fresh(`front:${one.id}`), `${one.id} — костюм`, 'side', why(tested[`front:${one.id}`])) + '</div>').join('')}</div>`).join('');
  // Round one's C beside the new at each seed; where round one drew none, the page says so and shows the new alone.
  const suitCs = ACTION_SEEDS.map(seed => {
    const key = `C:${suit.c.story}:s${seed}`, old = suit.c.old[seed];
    const now = figure(fresh(key), `C, сид ${seed} — новые портреты в костюме`, 'half', why(tested[key]));
    return old ? `<div class="row">${figure(join(source, old), `C, сид ${seed} — раунд 1, портреты в майке`, 'half', 'нет файла')}${now}</div>`
      : `<p>В первом раунде C сцены ${escapeHtml(suit.c.story)} на сиде ${seed} нет: новый показан один.</p><div class="row">${now}</div>`;
  }).join('');
  const counts = index ? countsOf(index) : undefined;
  const state = !index ? 'не начато: пробы рисуются на карте, а рамки и кадры ниже можно проверить до неё'
    : drawing ? 'рисуется; страница обновляется сама раз в минуту'
      : index.error ? `остановилось с ошибкой ${index.error}` : index.stopped ? 'остановилось: следующая сцена или проба одежды не успевала до срока' : 'закончено';
  const failed = Object.entries(counts?.failed ?? {}).map(([code, n]) => `${code} ${n}`).join(', ');
  const suitFailed = Object.entries(counts?.suit?.failed ?? {}).map(([code, n]) => `${code} ${n}`).join(', ');
  const legend = boxes
    ? `Рамки и кадры отмечены на глаз до карты и лежат в ${BOXES_FILE} (sha256 ${boxes.hash.slice(0, 12)}…); probe.json закрепляет его при первом `
      + 'рисовании, и дальше его не меняют. Тонкая рамка — отмеченная, толстая — область, которую проба перерисовывает: на L — тела для mask и mask-each, '
      + `поля ${MASK_MARGIN} px и растушёвка ${MASK_FEATHER} px; на A+ — головы с волосами для face и face-each, поля ${HEAD_MARGIN} px и растушёвка `
      + `${HEAD_FEATHER} px; обе доведены до сетки латента в ${GRID} px, у края кадра растушёвки нет. На портретах — кадр головы и плеч, который face и `
      + `face-each посылают вместо целого портрета: 11:20, как слот ${SCALED.width}x${SCALED.height}, без растяжения. Цвет и номер — слот человека.`
    : `${BOXES_FILE} нет: mask, mask-each, face и face-each не рисуются, пока рамки и кадры не отмечены.`;
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${drawing ? '<meta http-equiv="refresh" content="60">' : ''}
<title>T: пробы</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}figure{margin:0}
figure.wide{width:calc((100% - 16px) / 3)}figure.half{width:calc((100% - 8px) / 2)}figure.tall{width:calc((100% - 40px) / 6)}img{width:100%;display:block}
.pair{display:flex;gap:4px;width:calc((100% - 24px) / 4)}figure.side{width:calc((100% - 4px) / 2)}
.over{position:relative}.over svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.box{display:flex;align-items:center;justify-content:center;text-align:center;aspect-ratio:16/9;background:#eee;font-size:14px}
figure.tall .box,figure.side .box{aspect-ratio:9/16}table{border-collapse:collapse}th,td{padding:4px 6px;border-top:1px solid #ddd;vertical-align:top;text-align:left}
@media (max-width:640px){figure.wide,figure.half{width:100%}figure.tall{width:calc((100% - 16px) / 3)}.pair{width:calc((100% - 8px) / 2)}}</style>
<h1>T: девять проб на картинках первого раунда и проба одежды портретов</h1>
<p>В первом раунде T вернул картинку L: те же люди и лица на тех же местах, только края перерезкие, а цвет и контраст задраны; судьи поставили T то же,
что L, по всем пунктам всех 13 чистых сцен. Здесь девять проб на тех же картинках и портретах сида ${SEED}: пять — по одному изменению против сегодняшнего T;
mask и mask-each перерисовывают на L только рамки связанных людей; face и face-each меняют на картинке A+ только лица и волосы, по кадру головы и плеч
из портрета. Лица, волосы и телосложение сравнивать с портретами; контакты, позы и кадр — с L, у face и face-each — с A+; края и цвета — с ними же.
Раунд два рисует T как есть, пока владелец не выберет. После сцен — <a href="#suit">проба одежды портретов</a>.</p>
<table><tr><th>проба</th><th>что изменено</th><th>чего ждём на лицах</th><th>риск для действия</th></tr>
${VARIANTS.map(one => `<tr><td><b>${escapeHtml(one.id)}</b></td><td>${escapeHtml(one.change)}</td><td>${escapeHtml(one.faces)}</td><td>${escapeHtml(one.risk)}</td></tr>`).join('\n')}
</table>
<p>${escapeHtml(legend)}</p>
<p>Состояние: ${escapeHtml(state)}.${counts ? ` Нарисовано ${counts.drawn} из ${counts.planned}${counts.partial ? `, начато и не докончено ${counts.partial}` : ''}`
    + `${failed ? `, не вышло: ${escapeHtml(failed)}` : ''}.` : ''}${counts?.suit ? ` Проба одежды: нарисовано ${counts.suit.drawn} из ${suitJobs(suit).length}`
    + `${suitFailed ? `, не вышло: ${escapeHtml(suitFailed)}` : ''}.` : ''}
${index?.sameServer === false ? ' Сервер сказал о себе не то, что в первом раунде (ComfyUI, PyTorch или карта).' : ''}</p>
${sections.join('\n')}
<section id="suit"><h2>Проба одежды портретов</h2>
<p>В первом раунде C сцены ${escapeHtml(suit.c.story)} на сиде ${SEED} нарисовал демона в белой майке с его портрета, хотя сцена одела его иначе. Здесь
${suit.fronts.length} фронтальных портретов первого раунда (${escapeHtml(SUIT_SCENES.join(' и '))}) нарисованы заново тем же графом, в тех же 720x1280 и на том же
сиде ${SEED}, по тем же промптам, в которых заменена только одежда: «${escapeHtml(suit.was)}» → «${escapeHtml(SUIT_CLOTHES)}». Внешность, поза и стиль —
как в первом раунде. C сцены ${escapeHtml(suit.c.story)} нарисован на сидах ${ACTION_SEEDS.join(' и ')} с промптом первого раунда и новыми портретами в слотах.
Смотреть: меньше ли костюм протекает в сцену, чем майка; видно ли телосложение так же, как в майке и брюках; читается ли костюм как одежда, особенно у
детей полёта. Бот рисует портреты в майке и брюках, пока владелец не решит.</p>
${suitFronts}${suitCs}</section>
`, { mode: 0o600 });
}

// ---- The dry run ----

// Round one as the harness left it for the probe, made up: each probe scene's plan, whose T, C and front prompts are in
// round one's own form around made-up roles and looks, L's, A+'s, T's and C's pictures at 1280x704 and the fronts at
// 720x1280, flat grey, all of seed 7, and draw.json with their records, round one's pins and times like round one's;
// beside them a sealed story whose plan and picture hold `word`.
const DRY_BOUND: Record<string, number> = { flight: 4, twister: 4, giants: 3, guard: 2, tango: 2, demon: 4 };
function madeUpRound(root: string, card: ReturnType<typeof cardOf>, word: string) {
  const round: DrawIndex = { pins: { ...pinsOf(card), ...setupOf(card, readBase()), comfyui: 'fake', pytorch: 'fake', card: 'fake card' },
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
    out: {}, vIsC: true, portraits: fronts.map((portrait, at) => ({ id: portrait, entry: `e${at + 1}`, prompt: portraitPrompt(roles[at], `a made-up look ${at + 1}`).prompt })),
    views: [], counts: {} };
    mkdirSync(storyDir(root, id), { recursive: true, mode: 0o700 });
    writeJson(join(storyDir(root, id), 'plan.json'), plan);
    for (const arm of ['L', 'A+', 'T', 'C'] as const) {
      put({ key: frameKey(id, SEED, arm), kind: 'frame', story: id, id: `${id}-s${SEED}-${arm}`, arm,
        references: arm === 'T' ? roles.length + 1 : arm === 'C' ? roles.length : 0 }, greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++));
    }
    for (const front of fronts) put({ key: `front:${front}`, kind: 'front', story: id, id: front, references: 0 }, greyPng(720, 1280, number++));
  }
  const sealed = storyDir(root, 'sharp-1');
  mkdirSync(join(sealed, 'pictures'), { recursive: true, mode: 0o700 });
  writeJson(join(sealed, 'plan.json'), { id: 'sharp-1', arms: { T: { prompt: `${T_OPENING} ${word} takes them from the person in image 2. ${STYLE}`, references: ['L', 'sharp-1-e1'] } } });
  writeFileSync(join(sealed, 'pictures', `s${SEED}-L.png`), greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, number++, 0, word), { mode: 0o600 });
  writeJson(join(root, 'draw.json'), round);
}
// The made-up round's boxes.json: for each bound person a body on L and a head on A+, the first in the canvas's corner,
// so that its region meets the canvas's edges, each overlapping the one before, and a crop of each front at 11:20, of
// two sizes. `without` leaves that front's body out.
function madeUpBoxes(out: string, without?: string) {
  const bodies: ByScene = {}, heads: ByScene = {}, crops: Record<string, Box> = {};
  for (const id of PROBE_SCENES) {
    bodies[id] = {};
    heads[id] = {};
    for (let at = 0; at < DRY_BOUND[id]; at++) {
      const front = `${id}-e${at + 1}`;
      if (front !== without) bodies[id][front] = [250 * at, at ? 100 : 0, 250 * at + 400, 704 - 50 * at];
      heads[id][front] = [60 + 300 * at, 20 + 40 * at, 200 + 300 * at, 180 + 40 * at];
      crops[front] = at % 2 ? [150, 20, 557, 760] : [184, 30, 536, 670];
    }
  }
  writeFileSync(join(out, BOXES_FILE), JSON.stringify({ canvas: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, L: bodies, 'A+': heads, crops }), { mode: 0o600 });
}
// The pixels a list of regions covers together, and the box round them, as the fake reports a mask.
function cover(regions: Region[]) {
  const seen = new Uint8Array(FRAME_CANVAS.width * FRAME_CANVAS.height);
  let pixels = 0;
  for (const one of regions) {
    for (let y = one.y; y < one.y + one.height; y++) {
      for (let x = one.x; x < one.x + one.width; x++) if (!seen[y * FRAME_CANVAS.width + x]++) pixels++;
    }
  }
  const bounds = regions.length ? [Math.min(...regions.map(one => one.x)), Math.min(...regions.map(one => one.y)),
    Math.max(...regions.map(one => one.x + one.width)), Math.max(...regions.map(one => one.y + one.height))] : null;
  return { pixels, bounds };
}

// The whole probe against local/fake-comfy.ts, in `dir`: the made-up round in `round/`, the probe's directory in
// `probe/`, `tmp/` as the temporary directory. On the way, what the paid run relies on: the page shows the boxes and
// the crops, and the clothing test's fronts of round one, before the card; a sealed story, the marker, a clean scene
// whose directory is a link into sealed/, an L that is not round one's, a front's prompt without round one's clothes
// and a bound person without a box are refused before anything is sent or written; the clothing test or a scene that
// cannot end by --until is not begun; the clothing test's jobs come first, each front with no slot at 720x1280 and the
// demon's C with the new fronts at 1280x704, and every variant's job sends its slots, sizes, crops, start and masks and
// comes back at 1280x704; a resume draws nothing again, and a cell cut between two passes goes on from its last
// picture; the page shows every picture it names. The fake writes a made-up word into every picture's metadata, and
// the sealed story holds it: afterwards it is nowhere outside sealed/, in the temporary directory or in what was printed.
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
    madeUpBoxes(out);
    fake = await startFakeComfy({ jobMs: 30, referenceMs: 0, requireUploads: true, marker: word });
    const url = fake.url;
    const draw = (extra: Partial<ProbeOptions> = {}) => drawProbe({ source, out, comfy: url, until: Date.now() + 3600000, pollMs: 10, waitMs: 60000, timeoutMs: 10000, ...extra });
    const people = PROBE_SCENES.reduce((sum, id) => sum + DRY_BOUND[id], 0);
    const pictures = (page: string) => [...page.matchAll(/<img src="([^"]+)"/g)].map(match => match[1]);
    const rectangles = (page: string) => page.split('<rect ').length - 1;
    // The clothing test's pictures of round one: its fronts, and the demon's C of seed 7, the one seed round one drew.
    const tested = SUIT_SCENES.reduce((sum, id) => sum + DRY_BOUND[id], 0), noEleven = `на сиде ${ACTION_SEEDS[1]} нет`;

    // Each person has a body with its region, a head with its region and a crop drawn over the pictures.
    writePage(source, out);
    const first = readFileSync(join(out, 'index.html'), 'utf8');
    say(`0 the page before the card: ${pictures(first).length} pictures, ${rectangles(first)} rectangles over them`);
    expect(pictures(first).length === people + 4 * PROBE_SCENES.length + tested + 1 && rectangles(first) === 5 * people && first.includes(noEleven)
      && !existsSync(join(out, 'probe.json')),
      'the page before the card shows every portrait, L, A+, T and C, each body, head and crop over them, and the clothing test\'s fronts and C of round one');

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
    const planFile = join(storyDir(source, 'flight'), 'plan.json'), plan = readFileSync(planFile);
    const unworn = JSON.parse(plan.toString('utf8')) as StoryPlan;
    unworn.portraits[1].prompt = unworn.portraits[1].prompt.split(PORTRAIT_CLOTHES).join('wearing made-up clothes');
    writeJson(planFile, unworn);
    await refused('a front whose prompt does not carry round one\'s clothes', () => draw());
    writeFileSync(planFile, plan);
    madeUpBoxes(out, 'tango-e2');
    await refused('mask on a scene with a bound person unboxed', () => draw({ scenes: ['tango'], variants: ['mask'] }));
    madeUpBoxes(out);
    expect(fake.jobs.length === 0 && fake.uploads.length === 0 && !existsSync(join(out, 'probe.json')), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`2 five seconds left: stopped ${short.stopped}, ${fake.jobs.length} jobs sent`);
    expect(short.stopped === 'until' && fake.jobs.length === 0, 'the clothing test or a scene that cannot end in time is not begun');

    const whole = await draw();
    const counts = countsOf(whole), round = roundOf(source), suit = suitOf(source, round), tests = suitJobs(suit);
    say(`3 the probe: ${counts.drawn} of ${counts.planned} cells drawn and ${counts.suit?.drawn} of the clothing test's ${tests.length}, in ${fake.jobs.length} jobs, `
      + `failed ${JSON.stringify({ ...counts.failed, ...counts.suit?.failed })}`);
    expect(counts.drawn === PROBE_SCENES.length * VARIANTS.length && counts.suit?.drawn === tests.length && Object.values(whole.cells).every(one => one.jobs.every(job =>
      job.status === 'drawn' && job.width === FRAME_CANVAS.width && job.height === FRAME_CANVAS.height)), 'every cell drawn, the clothing test\'s too');
    const named = (file: string) => `ref-${sha256(stripPngMetadata(readFileSync(file))).slice(0, 16)}.png`;
    const boxes = readBoxes(out), same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const wrong: string[] = [];
    let job = 0;
    // The clothing test's jobs first, in their order: a front with no slot at 720x1280 from round one's prompt with the
    // new clothes in place of the old, and the demon's C from round one's own prompt with the four new fronts through
    // their scale nodes at 1280x704; no mask anywhere, and each recorded with its prompt's length and its graph right.
    const read = SUIT_SCENES.map(id => sceneOf(source, round, id));
    const worn = new Map(read.flatMap(scene => scene.fronts.map((front, at) => [front, scene.frontPrompts[at]] as const)));
    for (const test of tests) {
      const one = fake.jobs[job++], cell = whole.suit?.cells[test.key], canvas = test.kind === 'front' ? { width: 720, height: 1280 } : FRAME_CANVAS;
      const files = test.fronts.map(id => [named(join(out, whole.suit?.cells[`front:${id}`]?.file ?? '')), '352x640', null]);
      const prompt = test.kind === 'C' ? test.prompt === read.find(scene => scene.id === test.story)?.c
        : test.prompt.split(SUIT_CLOTHES).length === 2 && !test.prompt.includes(PORTRAIT_CLOTHES)
          && test.prompt.split(SUIT_CLOTHES).join(PORTRAIT_CLOTHES) === worn.get(test.id);
      const right = one?.outcome === 'success' && one.width === canvas.width && one.height === canvas.height && one.start === null && one.noiseMask === null
        && one.composites.length === 0 && same(one.slots.map(slot => [slot.file, slot.scaled && `${slot.scaled.width}x${slot.scaled.height}`, slot.cropped]), files)
        && prompt && cell?.status === 'drawn' && cell.graphRight === true && cell.promptChars === test.prompt.length;
      if (!right) wrong.push(`suit:${test.key}`);
    }
    // Each variant's job against its variant and pass, in the order drawn: the slots with their files, sizes and crops,
    // what the sampler starts from, and the masks, the sampler's and the paste's, against the regions they are made of.
    for (const id of PROBE_SCENES) {
      const scene = sceneOf(source, round, id), upload = (input: Input) => named(join(source, input.file));
      const l = upload(scene.l), aPlus = upload(scene.aPlus), fronts = scene.portraits.map(upload);
      for (const variant of VARIANTS) {
        const cell = whole.cells[cellKey(id, variant.id)], layout = variant.mask ? layoutOf(scene, boxes, variant) : { regions: [], crops: [] };
        for (let pass = 1; pass <= passesOf(variant, scene.bound); pass++) {
          const one = fake.jobs[job++], each = variant.mask === 'each';
          const start = !latentStart(variant) ? null : pass > 1 ? named(join(out, cell.jobs[pass - 2].file!)) : variant.face ? aPlus : l;
          const files = [...(pictureFirst(variant) ? [variant.face ? start : l] : []), ...(each ? [fronts[pass - 1]] : fronts)];
          const sent = files.map((file, at) => [file, at > 0 || !pictureFirst(variant) ? '352x640' : variant.id === 'half' ? '640x352' : 'own',
            variant.face && at > 0 ? layout.crops[each ? pass - 1 : at - 1] : null]);
          const area = cover(each ? [layout.regions[pass - 1]] : layout.regions);
          const right = one?.outcome === 'success' && one.width === FRAME_CANVAS.width && one.height === FRAME_CANVAS.height && one.start === start
            && same(one.slots.map(slot => [slot.file, slot.scaled ? `${slot.scaled.width}x${slot.scaled.height}` : 'own', slot.cropped]), sent)
            && (variant.mask ? one.noiseMask?.nonzero === area.pixels && one.noiseMask.full === area.pixels && same(one.noiseMask.bounds, area.bounds)
              && one.composites.length === 1 && one.composites[0].destination === start && one.composites[0].mask?.nonzero === area.pixels
              && same(one.composites[0].mask.bounds, area.bounds)
              : one.noiseMask === null && one.composites.length === 0);
          if (!right) wrong.push(`${cellKey(id, variant.id)}${each ? `#${pass}` : ''}`);
        }
      }
    }
    say(`   jobs against their cells, variants and passes: ${job - wrong.length} of ${job} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    expect(!wrong.length && fake.jobs.length === job, 'every job sends its own prompt, slots, sizes, crops, start and masks');

    const jobs = fake.jobs.length;
    await draw();
    say(`4 a resume: ${fake.jobs.length - jobs} jobs`);
    expect(fake.jobs.length === jobs, 'a resume draws nothing again');
    // The end came between the demon's third head and its fourth, as probe.json then records it.
    const recorded = readJson<ProbeIndex>(join(out, 'probe.json'))!, cut = recorded.cells[cellKey('demon', 'face-each')];
    unlinkSync(join(out, cut.jobs.pop()!.file!));
    Object.assign(cut, { status: 'partial', file: undefined });
    writeJson(join(out, 'probe.json'), recorded);
    const again = (await draw()).cells[cut.key], goesOn = fake.jobs.slice(jobs);
    say(`   a cell cut between two passes: ${goesOn.length} jobs, from its last picture ${goesOn[0]?.start === named(join(out, cut.jobs.at(-1)!.file!))}`);
    expect(goesOn.length === 1 && goesOn[0].start === named(join(out, cut.jobs.at(-1)!.file!)) && again.status === 'drawn' && again.jobs.length === 4
      && again.file === again.jobs[3].file && existsSync(join(out, again.file!)), 'a cell cut between two passes goes on from its last picture and draws what it lacks');

    writePage(source, out);
    const page = readFileSync(join(out, 'index.html'), 'utf8'), shown = pictures(page);
    const planned = people + PROBE_SCENES.length * (4 + VARIANTS.length) + 2 * people + tested + 1 + tests.length;
    say(`5 page: ${shown.length} pictures, ${shown.filter(src => existsSync(join(out, src))).length} of them where it links, ${rectangles(page)} rectangles`);
    expect(shown.length === planned && shown.every(src => existsSync(join(out, src))) && rectangles(page) === 5 * people && page.includes(noEleven)
      && VARIANTS.every(one => page.includes(`<b>${one.id}</b>`)),
      'the page shows every portrait, L, A+, T, C, variant and pass, the boxes, the clothing test old and new, and names every change');

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
  // `--scenes` names the scenes and `suit`, the clothing test; without it, all of them. `--variants` narrows the
  // scenes' variants and leaves the clothing test as it is.
  const named = list(values.scenes), variants = list(values.variants);
  const suit = !named || named.includes('suit'), scenes = named?.filter(id => id !== 'suit');
  if (variants?.some(id => !VARIANTS.some(one => one.id === id))) throw new Refusal(`--variants takes ${VARIANTS.map(one => one.id).join(', ')}, comma separated`);
  scenes?.forEach(cleanId);
  if (command === 'estimate') {
    const round = roundOf(SOURCE_DIR);
    const read = (scenes ?? PROBE_SCENES).map(id => sceneOf(SOURCE_DIR, round, id));
    print({ event: 'estimate', ...estimateOf(round, read, variants ? VARIANTS.filter(one => variants.includes(one.id)) : VARIANTS,
      suit ? suitOf(SOURCE_DIR, round) : undefined), bound: Object.fromEntries(read.map(scene => [scene.id, scene.bound])) });
  } else if (command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --until <epoch seconds, five minutes before the card\'s end> [--scenes suit,flight,...] [--variants words,...] [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawProbe({ source: SOURCE_DIR, out: PROBE_DIR, comfy: comfyUrl(values.comfy!), until, scenes, suit, variants: variants as VariantId[] | undefined,
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
