// The tester stand, the fifth refs stand (docs/action-experiment.md#tester-stand): the tester's two complaints about
// pictures of 2026-09-28 as the clean stories of examples/tester-stand.ts, drawn on the next picture card with the
// frame changes of 1a84d3d on and off, the clothes rule with its sentence on nothing on, and the clothes stories with
// the reference on and off. build-texts.ts in ~/simple-story-chat-runs/2026-09-28/tester-stand writes the
// stand's texts.json and judge-questions.json from the frozen frames beside it; this file pins the frames and the
// texts, and local/image-refs-judge.ts the question file, by which it judges the pictures after the card.
//   estimate  the cells, the minutes at the refs stands' times and at the admission prices, the picture card's dollars
//   dry-run   --out DIR --frames FILE --first DIR --third DIR: the real texts against the frozen frames and every graph
//             built from them, then the stand against local/fake-comfy.ts, a card that goes away in the middle of it
//             and another that takes over, and its judging against stand-ins for codex
//   draw      on the card, --out DIR --first <the first stand's DIR> --third <the third's> --until EPOCH
//   page      DIR/index.html
// What it prints is keys, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { addSeed, beginJob, commitTurn, emptyLibrary, newStory } from '../lib/library.ts';
import { CASES, PEOPLE, SEEDS, VIEWER, VIEWER_OUTFIT } from '../examples/tester-stand.ts';
import type { CaseId, TesterCase, Who } from '../examples/tester-stand.ts';
import { STYLE, assemblePrompt, frameRequest, matchSheet } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { ModelRequest } from './model.ts';
import { contextParts, storyNarration } from './prompt.ts';
import { clothesRequest } from './picture-clothes.ts';
import { partlyInView, povRequest, seenBy } from './picture-pov.ts';
import { referenceGraph, referencePrompt } from './picture-references.ts';
import { ACTION_GRAPH, FRAME_CANVAS, FRONT_GRAPH, SCALED, actionGraph } from './action-draw.ts';
import { apiGraph, applyToWorkflow, comfyUrl, pngSize, referenceGeometry, stripPngMetadata, withAttention } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { kitchenLines } from './image-pilot.ts';
import { readJson } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { BY_KEY, CROP, INDEX_FILE, PLANNED, TEXTS_FILE, TEXTS_SHA256, TRITON_ARGV, attentionInfo, buildJob, cellOf, cellRight, countsOf, drawStand, estimateOf,
  frameKey, inputsOf, sizeText, slotChains, tokenReport, writePage } from './image-refs-test.ts';
import type { Group, How, Planned, Section, Size, Stand, StandIndex, TextCell, Warmth } from './image-refs-test.ts';
import { FRONTS, PLANNED_3, STAND_3, TEXTS_SHA256_3, canon } from './image-refs-backlog.ts';
import type { SessionKey } from './image-refs-judge.ts';

const ROOT = resolve(import.meta.dirname, '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
// The longest --until the drawing takes: a card is rented for hours, never for days.
const LONGEST_MS = 12 * 3600000;

// ---- The stories ----

export const WHO: Who[] = ['H', 'L', 'B', 'T'];
export const caseOf = (id: CaseId) => CASES.find(one => one.id === id)!;
// A story's sheet as a frame of its last scene starts from (local/picture.ts `wornAt`): everybody with their look and
// what they wear before that scene; the viewer first in the POV stories, where they are the reader's own person.
export function sheetOf(one: TesterCase): Character[] {
  const entry = (person: typeof VIEWER, outfit: string): Character => ({ name: person.name, description: person.description, changes: '',
    details: person.details, look: person.look, outfit });
  return [...(one.family === 'pov' ? [entry(VIEWER, VIEWER_OUTFIT)] : []), ...WHO.map(who => entry(PEOPLE[who], one.outfits[who] ?? ''))];
}
// The request the bot describes the last scene from (local/picture.ts `excerpt`): the story's seed and every scene with
// the message it answers, as the library keeps them and local/prompt.ts renders them, the narrator's system prompt of
// the story's language, and no memory.
export function excerptOf(one: TesterCase) {
  const state = emptyLibrary(), seed = addSeed(state, SEEDS[one.seed]), { story, branch } = newStory(state, seed.id);
  for (const turn of one.turns) {
    const job = beginJob(state, turn.input ?? storyNarration(state, story.id).startStory, 0);
    if (!commitTurn(state, job.id, `${turn.time}\n\n${turn.text}`)) throw new Error(`${one.id}: a scene was not committed`);
  }
  const parts = contextParts(state, { storyId: story.id, head: branch.head, memory: null });
  return { system: storyNarration(state, story.id).system, messages: [...parts.seed, ...parts.memory, ...parts.tail] };
}

// ---- The frames and their prompts ----

// How a frame is asked: as the bot asks it today, with each person's place in a POV frame (SIMPLE_CHAT_POV_PLACE_USERS),
// or with change 8's rule for the clothes and the sentence on nothing on (SIMPLE_CHAT_CLOTHES_USERS).
export type Variant = 'today' | 'place' | 'clothes';
export const VARIANTS: Record<TesterCase['family'], Variant[]> = { pov: ['today', 'place'], clothes: ['today', 'clothes'] };
const viewerIn = (sheet: Character[]) => sheet.find(one => one.name === VIEWER.name)!;
// The frame's request, as local/picture.ts `describeFrame` builds it for a reader with the switch of `variant` on and
// the others off: the clothes rule inside the instruction, then the POV rule and fields after it.
export function caseRequest(one: TesterCase, variant: Variant): ModelRequest {
  const sheet = sheetOf(one), request = frameRequest(excerptOf(one), sheet);
  const asked = variant === 'clothes' ? clothesRequest(request) : request;
  return one.family === 'pov' ? povRequest(asked, viewerIn(sheet), variant === 'place') : asked;
}

// The arms. POV: R, today's frame with every person's front; P, the frame with places and every front; PN, the same
// frame without the front of anybody only partly in view (SIMPLE_CHAT_POV_PARTIAL_USERS). Clothes: R, today's frame
// with every front; C, the clothes rule and what each referenced person wears said before the reference wording; CF,
// C's words with the top 720x400 of each front, as the refs backlog's FC takes it: the head, the shoulders and some of
// the suit, not the face alone; RW and CW, R's and C's frames with no reference at all, as the bot draws a frame that
// binds nobody: the reference off, against the suit its portrait wears.
export type Arm = 'R' | 'P' | 'PN' | 'C' | 'CF' | 'RW' | 'CW';
export const ARMS: Record<TesterCase['family'], Arm[]> = { pov: ['R', 'P', 'PN'], clothes: ['R', 'C', 'CF', 'RW', 'CW'] };
export const variantOf = (family: TesterCase['family'], arm: Arm): Variant => (arm === 'R' || arm === 'RW' ? 'today' : family === 'pov' ? 'place' : 'clothes');
// `text` with `what` replaced, where it stands exactly once.
const once = (text: string, what: string, by: string) => {
  if (text.split(what).length !== 2) throw new Error('the reference wording to replace is not there exactly once');
  return text.replace(what, () => by);
};
// FC's opening (the refs backlog's build-texts.ts): the pictures as faces, the build from the words, nothing about poses
// or framing to take from a picture that shows neither.
export const faceWording = (prompt: string) => once(once(once(prompt, 'identity sources for the people identified below by image number. ',
  'face sources for the people identified below by image number: each shows only a head and shoulders. '),
'Keep each referenced person\'s face, hair, skin, age, body proportions and relative body volumes. ',
'Keep each referenced person\'s face, hair, skin and age. Take their build, body proportions and relative body volumes from the words below. '),
'do not copy their rendering, backdrop, lighting, clothes, standing poses or framing. ', 'do not copy their rendering, backdrop, lighting or clothes. ');

// A frame's prompt for an arm from the model's answer to its variant's request, as the bot assembles it: a POV answer
// turned into a description by `seenBy`, the people of the sheet with a front bound in the order of the frame's people
// (local/picture-references.ts `frameReferences`), PN's without those only partly in view, RW's and CW's with nobody,
// and the reader style VN. A frame that binds nobody is the bot's plain prompt. `bound`: whose front each picture slot
// takes.
export function framePrompt(one: TesterCase, arm: Arm, answer: Record<string, unknown>): { prompt: string; bound: Who[]; partly: number } {
  const sheet = sheetOf(one), names = sheet.map(person => person.name);
  const description = one.family === 'pov' ? seenBy(answer as unknown as Description, viewerIn(sheet), sheet, arm !== 'R').description
    : answer as unknown as Description;
  const people = description.people ?? [], partly = people.filter(partlyInView).length;
  const bound: Who[] = [];
  for (const person of arm === 'RW' || arm === 'CW' ? [] : arm === 'PN' ? people.filter(other => !partlyInView(other)) : people) {
    const name = matchSheet(person.who ?? '', names), who = WHO.find(letter => PEOPLE[letter].name === name);
    if (who && !bound.includes(who)) bound.push(who);
  }
  const frame = { description, sheet };
  if (!bound.length) return { prompt: assemblePrompt(description, sheet, STYLE).prompt, bound, partly };
  const made = referencePrompt(frame, bound.map(who => ({ name: PEOPLE[who].name, file: `${who}.png` })), STYLE, arm === 'C' || arm === 'CF').prompt;
  return { prompt: arm === 'CF' ? faceWording(made) : made, bound, partly };
}

// ---- The plan ----

// The frames each arm is drawn from: ~/simple-story-chat-runs/2026-09-28/tester-stand/frames.json as write-frames.mts
// froze it, three answers of the hosted Gemma 4 31B to each story's request of each variant; and texts.json, which
// build-texts.ts beside it wrote from them into the stand's directory. Both byte for byte.
export const FRAMES_SHA256 = '069ebf232811961925ed7480ce7ab941582da6644cde0b6cfef880a8eb08bc74';
export const TEXTS_SHA256_5 = 'fe5be57310bab3dfb0c5034139952e272bd18a13ed801bcb74004b9b5e95715f';
export const SEEDS_5 = [71, 73, 79, 83];
export const ANSWERS = [1, 2, 3];
// Whose front each arm's frames take, in slot order: the people of the frozen frames who have one, in the order of the
// frame's people, the same in all three answers of a story. PN takes nobody's where each of them is only partly in
// view; in V-face nobody is, so PN is P there and is not drawn again. RW and CW take nobody's.
export const BOUND: Record<CaseId, Partial<Record<Arm, Who[]>>> = {
  'V-squeeze': { R: ['L', 'T'], P: ['L', 'T'], PN: [] }, 'V-walk': { R: ['H'], P: ['H'], PN: [] }, 'V-behind': { R: ['B'], P: ['B'], PN: [] },
  'V-face': { R: ['H'], P: ['H'] }, 'C-bare': { R: ['B', 'T'], C: ['B', 'T'], CF: ['B', 'T'], RW: [], CW: [] },
  'C-outfit': { R: ['H'], C: ['H'], CF: ['H'], RW: [], CW: [] }, 'C-swim': { R: ['L'], C: ['L'], CF: ['L'], RW: [], CW: [] },
  'C-towel': { R: ['T'], C: ['T'], CF: ['T'], RW: [], CW: [] } };
export const armsOf = (id: CaseId) => ARMS[caseOf(id).family].filter(arm => BOUND[id][arm] !== undefined);
export const cellKey5 = (id: CaseId, arm: Arm, answer: number, seed: number) => frameKey(`${arm}-${id}-a${answer}`, undefined, seed);
// A cell of the stand by its key: its story, arm, answer and seed.
export type Cell5 = { key: string; case: CaseId; arm: Arm; answer: number; seed: number };
// Seed by seed, so that a card that ends early leaves whole comparisons: every story, answer and arm at the first seed,
// then at the next. Every picture a cell takes is a front another stand drew, H's and L's the first stand's, B's and
// T's the third's, at 352x640, or its top 720x400 in CF. A frame that takes none is drawn on the bot's plain graph
// (gpu/image-workflow-qwen.json), as the bot draws a frame that binds nobody (local/picture.ts `drawFrame`), and the
// rest on the action graph, which is the bot's with its references.
function planOf5(): { plan: Planned[]; cells: Cell5[] } {
  const plan: Planned[] = [], cells: Cell5[] = [];
  for (const seed of SEEDS_5) for (const one of CASES) for (const answer of ANSWERS) for (const arm of armsOf(one.id)) {
    const key = cellKey5(one.id, arm, answer, seed), refs = BOUND[one.id][arm]!.map(who => ({ from: FRONTS[who], how: arm === 'CF' ? 'crop' as const : 's352' as const }));
    plan.push(cellOf({ key, id: `${arm}-${one.id}-a${answer}`, arm, kind: 'frame', seed, graph: refs.length ? 'action' : 'front', canvas: FRAME_CANVAS, cfg: 1,
      negative: 'none', refs }));
    cells.push({ key, case: one.id, arm, answer, seed });
  }
  return { plan, cells };
}
const PLAN_5 = planOf5();
export const PLANNED_5 = PLAN_5.plan;
export const CELLS_5 = new Map(PLAN_5.cells.map(one => [one.key, one]));

// ---- The page ----

const CASE_WORDS: Record<CaseId, string> = { 'V-squeeze': 'скамейка на пирсе, двое прижались с боков', 'V-walk': 'набережная, Мара у левого плеча',
  'V-behind': 'кафе, Бруно наклонился сзади через правое плечо', 'V-face': 'ужин, Мара напротив (контроль)', 'C-bare': 'мостки, Бруно после купания, Тесса одета',
  'C-outfit': 'утро у домика, Мара в красном свитере', 'C-swim': 'пляж, Лина в жёлтом купальнике', 'C-towel': 'крыльцо бани, Тесса в полотенце' };
const ARM_WORDS: Record<Arm, string> = { R: 'R: кадр бота сегодня, фронты 352x640', P: 'P: места в кадре (SIMPLE_CHAT_POV_PLACE_USERS), все фронты',
  PN: 'PN: места в кадре и без фронта тех, кто виден частью (SIMPLE_CHAT_POV_PARTIAL_USERS)', C: 'C: правило одежды и одежда каждого перед референсами (SIMPLE_CHAT_CLOTHES_USERS)',
  CF: 'CF: слова C, верх фронта 720x400 (голова, плечи и часть костюма)', RW: 'RW: кадр R без референсов, на обычном графе бота',
  CW: 'CW: кадр C без референсов, на обычном графе бота' };
const SECTIONS_5: Section[] = CASES.map(one => ({ title: `${one.id}: ${CASE_WORDS[one.id]}`,
  note: `${armsOf(one.id).map(arm => ARM_WORDS[arm]).join('. ')}. Три ответа модели кадра на каждый вариант запроса (a1, a2, a3).`
    + (one.id === 'V-face' ? ' PN здесь совпадает с P: никто не виден частью.' : ''),
  columns: armsOf(one.id).flatMap(arm => ANSWERS.map(answer => `${arm} a${answer}`)),
  rows: SEEDS_5.map(seed => ({ label: `сид ${seed}`, keys: armsOf(one.id).flatMap(arm => ANSWERS.map(answer => cellKey5(one.id, arm, answer, seed))) })) }));
export const STAND_5: Stand = { plan: PLANNED_5, title: 'Стенд тестера: POV и одежда', sections: SECTIONS_5, date: '2026-09-28', others: PLANNED_3, pinEach: true, cards: true,
  intro: 'Две жалобы тестера от 2026-09-28 на синтетических историях examples/tester-stand.ts, кадры написаны заранее хостинговой Gemma 4 31B. Рисуется по одному '
    + 'заданию и без front, так что кадр тестера ждёт не дольше одной ячейки. Путь бота: cu130, Triton, внимание кухни, 25 шагов euler, CFG 1; кадр без '
    + 'референсов на обычном графе бота. Люди: H и L первого стенда, B и T третьего; Артём, глазами которого видны POV-кадры, без портрета. Сиды 71, 73, 79 и 83.' };

// ---- The prices ----

// A cell's warm time: the medians of the refs stands' cells on the RTX 5090s of 2026-09-27 and 2026-09-28, the slower
// card's where both drew a group: a frame from words 5028 ms, on the plain graph too, where a front of about as many
// pixels took 5.0 s on the second stand's card; with one front at 352x640 5324 (27 cells), with two 5844,
// with two faces 7167; one face, drawn three times on the faster card at 5031, is priced at 6000. The first job's compile
// and each group's first job come on top, as local/image-refs-backlog.ts prices them.
const TONIGHT_MS_5: Partial<Record<Group, number>> = { words: 5028, ref1: 5324, ref2: 5844, crop: 6000, crop2: 7167 };
const COMPILE_MS = 14000, FIRST_MS = 2000, RATE_5 = 0.498;
const minutes5 = (ms: number) => Math.round(ms / 6000) / 10;
// The cells by arm and group, the minutes at those times and at the admission prices the runner begins a cell by, and
// the picture card's dollars for them at `rate` an hour.
export function testerEstimate(rate = RATE_5) {
  const count = (test: (one: Planned) => boolean) => PLANNED_5.filter(test).length;
  const tonight = PLANNED_5.reduce((sum, one) => sum + TONIGHT_MS_5[one.group]!, 0) + COMPILE_MS + new Set(PLANNED_5.map(one => one.group)).size * FIRST_MS;
  const admission = estimateOf(rate, 0, 600, PLANNED_5);
  const dollars = (ms: number) => Math.round(minutes5(ms) / 60 * rate * 100) / 100;
  return { cells: PLANNED_5.length, arms: admission.arms, groups: Object.fromEntries([...new Set(PLANNED_5.map(one => one.group))].map(group => [group, count(one => one.group === group)])),
    perSeed: PLANNED_5.length / SEEDS_5.length, tonightMinutes: minutes5(tonight), admissionMinutes: admission.pricedMinutes, dollarsPerHour: rate,
    dollars: dollars(tonight) };
}

// ---- The drawing ----

type TesterOptions = { out: string; first: string; third: string; comfy: string; until: number; pinned?: string; timeoutMs?: number; waitMs?: number; pollMs?: number;
  warm?: Warmth; log: (event: object) => void };
const LENDS: [keyof Pick<TesterOptions, 'first' | 'third'>, Who[]][] = [['first', ['H', 'L']], ['third', ['B', 'T']]];
// Each run the fronts are taken from holds the two it lends drawn, in the very file its cells.json records. drawStand
// would draw without them and leave out every cell that takes one, so a wrong --first or --third is refused here,
// before anything is sent.
export function lendersOf(runs: Pick<TesterOptions, 'first' | 'third'>) {
  for (const [name, people] of LENDS) {
    const dir = resolve(runs[name]), index = readJson<StandIndex>(join(dir, INDEX_FILE));
    const held = people.filter(who => {
      const cell = index?.cells[FRONTS[who]], path = cell?.file === undefined ? undefined : join(dir, cell.file);
      return cell?.status === 'drawn' && path !== undefined && existsSync(path) && sha256(readFileSync(path)) === cell.sha256;
    });
    if (held.length !== people.length) throw new Refusal(`--${name} holds ${held.length} of ${people.join(' and ')}'s fronts as its cells.json records them; nothing is drawn`);
  }
}
// The stand on the bot's picture path through local/image-refs-test.ts's drawStand, one job at a time without `front`,
// its fronts taken from the first stand's run (`first`) and the third's (`third`), each pinned as first seen drawn.
export async function drawTester(options: TesterOptions) {
  lendersOf(options);
  return drawStand({ out: options.out, comfy: options.comfy, until: options.until, pinned: options.pinned ?? TEXTS_SHA256_5, stand: STAND_5,
    from: [options.first, options.third], warm: options.warm, timeoutMs: options.timeoutMs, waitMs: options.waitMs, pollMs: options.pollMs, log: options.log });
}

// ---- The dry run ----

type Frozen = { case: CaseId; variant: Variant; answer: number; request: string; value: Record<string, unknown> };
const QUESTIONS_FILE = 'judge-questions.json';
// The runs of the stand and of the two it takes fronts from, under the runs' root as the question file names them.
const RUN_1 = join('2026-09-27', 'refs-stand'), RUN_3 = join('2026-09-28', 'refs-stand-3'), RUN_5 = join('2026-09-28', 'refs-stand-5');

// The whole stand without a card, in `dir`, from the stand's directory `stand` (its texts.json and judge-questions.json),
// the frozen frames at `framesFile` and the runs of the first and third stands, which it only reads. First the plan,
// the real texts' pin and tokens, each frozen answer to the request the stand asks today, each prompt as the bot
// assembles it for its arm from the frozen frames, every graph built from them and read back, and the fronts the stand
// takes, held by those runs as they recorded them. Then, laid
// out as the runs' root is, the four fronts drawn by local/fake-comfy.ts started as the bot's card in runs of their own
// and the stand from marked copies of the texts: the page before the card; texts other than the pinned, a card record
// missing, a --first that is not there or holds no fronts, a --third drawn from other weights, a front changed on disk
// and a server on cu128 refused before anything is sent or written; five seconds that begin nothing; an --until in the
// middle of a job, which stops it and records nothing; the stand drawn until the card goes away as it takes the first
// front it has not uploaded; a card on another torch and a front its run has drawn anew refused; another card that
// takes over, with every front uploaded to it again, and draws the rest, each cell once in the plan's order; a start
// after it that draws nothing; every job against its reading and the fake's, with the size each front reaches the
// encoder at; no `front` in any submit; one job at a time; the page. Then the judging as it will go after the card: the
// real texts and question file beside the drawn cells, the bundles with every picture checked against the hash its
// cell recorded and nothing in them that names a cell, a front or a story, judged by stand-ins for codex and scored; a
// question file, a picture or a front changed since refused, and the bundles kept on a second build. Afterwards the
// prompts' made-up word is in the texts and on the pages alone, and the fake's own word nowhere.
export async function dryRunTester(dir: string, stand: string, framesFile: string, realFirst: string, realThird: string, tokenizers: string,
  pinned = TEXTS_SHA256_5) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), runs = join(dry, 'runs'), first = join(runs, RUN_1), third = join(runs, RUN_3), out = join(runs, RUN_5);
  for (const path of [dry, temp, first, third, out]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const textsFile = join(resolve(stand), TEXTS_FILE), questionsFile = join(resolve(stand), QUESTIONS_FILE);
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
    say(`tester stand dry run in ${dry}: the real texts, then marked copies against local/fake-comfy.ts as the bot's cards and stand-ins for codex; no card, no model, no network`);
    const meta = (one: Planned) => CELLS_5.get(one.key)!;
    const byKey3 = new Map(PLANNED_3.map(one => [one.key, one]));
    const estimate = testerEstimate();
    say(`0 the plan: ${PLANNED_5.length} cells, ${estimate.perSeed} a seed at seeds ${SEEDS_5.join(', ')}; arms ${JSON.stringify(estimate.arms)}; groups `
      + `${JSON.stringify(estimate.groups)}; ${estimate.tonightMinutes} minutes at the refs stands' times, ${estimate.admissionMinutes} at the admission prices, `
      + `$${estimate.dollars} at $${estimate.dollarsPerHour} an hour`);
    // Seed by seed, each story's answers in turn and each answer's arms; every picture a cell takes the front of a person
    // it binds, H's and L's the first stand's, B's and T's the third's, whole at 352x640 or its top as CF's face.
    const order = SEEDS_5.flatMap(seed => CASES.flatMap(one => ANSWERS.flatMap(answer => armsOf(one.id).map(arm => cellKey5(one.id, arm, answer, seed)))));
    const bound = PLANNED_5.every(one => same(one.refs, BOUND[meta(one).case][meta(one).arm]!.map(who => ({ from: FRONTS[who], how: meta(one).arm === 'CF' ? 'crop' : 's352' })))
      && one.refs.every(ref => BY_KEY.has(ref.from) || byKey3.has(ref.from)) && one.canvas.width === FRAME_CANVAS.width && one.canvas.height === FRAME_CANVAS.height);
    const graphs = PLANNED_5.every(one => one.graph === (one.refs.length ? 'action' : 'front'));
    expect(PLANNED_5.length === 372 && new Set(PLANNED_5.map(one => one.key)).size === 372 && same(PLANNED_5.map(one => one.key), order) && bound && graphs
      && same(estimate.arms, { R: 96, P: 48, PN: 36, C: 48, CF: 48, RW: 48, CW: 48 }) && !PLANNED_5.some(one => BY_KEY.has(one.key) || byKey3.has(one.key)),
    '372 cells seed by seed, each taking the fronts its frames bind from the first and third stands, and those that take none on the plain graph');

    const real = inputsOf(textsFile, pinned, PLANNED_5), tokens = tokenReport(real.texts, tokenizers, PLANNED_5, PLANNED_3);
    say('1 the real texts (sha256 pinned): tokens, the prompt as the encoder takes it with its references, the canvas and each reference at the encoder:');
    for (const one of tokens.groups) say(`   ${JSON.stringify(one)}`);
    expect(tokens.groups.every(one => one.promptTokens[0] > 0 && one.promptTokens[1] < 2000), 'every prompt counted, none past 2,000 tokens');
    let lenders = true;
    try { lendersOf({ first: realFirst, third: realThird }); } catch { lenders = false; }
    say(`   the first and third stands' runs hold the four fronts as their cells.json recorded them: ${lenders}`);
    expect(lenders, 'the fronts the stand takes, drawn');

    // Each prompt what the bot assembles for its arm from the frozen answer it was drawn from, the same at every seed,
    // and each arm's words where they belong.
    const framesBytes = readFileSync(framesFile);
    const frozen = sha256(framesBytes) === FRAMES_SHA256 ? (JSON.parse(framesBytes.toString('utf8')) as { frames: Frozen[] }).frames : [];
    const answerOf = (id: CaseId, variant: Variant, answer: number) => {
      const found = frozen.filter(one => one.case === id && one.variant === variant && one.answer === answer);
      return found.length === 1 ? found[0].value : undefined;
    };
    const textOf = (one: Planned) => real.texts.cells.get(one.key)!.prompt;
    // Each frozen answer is to the request the stand asks of its story and variant today, the clothes rule's included.
    const asked = frozen.every(one => one.request === sha256(JSON.stringify(caseRequest(caseOf(one.case), one.variant))));
    const remade = PLANNED_5.filter(one => {
      const cell = meta(one), story = caseOf(cell.case), answer = answerOf(cell.case, variantOf(story.family, cell.arm), cell.answer);
      const made = answer && framePrompt(story, cell.arm, answer);
      return made && made.prompt === textOf(one) && same(made.bound, BOUND[cell.case][cell.arm]);
    }).length;
    const ids = new Map<string, Set<string>>();
    for (const one of PLANNED_5) ids.set(one.id, (ids.get(one.id) ?? new Set()).add(textOf(one)));
    const pov = (one: Planned) => caseOf(meta(one).case).family === 'pov', arm = (one: Planned) => meta(one).arm;
    const names = [VIEWER.name, ...WHO.map(who => PEOPLE[who].name)];
    const worded = PLANNED_5.every(one => textOf(one).endsWith(STYLE) && textOf(one).includes('First-person POV shot') === pov(one)
      && textOf(one).includes(' in this scene: ') === ['C', 'CF'].includes(arm(one)) && textOf(one).includes('face sources') === (arm(one) === 'CF')
      && !names.some(name => new RegExp(`\\b${name}\\b`).test(textOf(one))) && !textOf(one).includes(VIEWER.look));
    const numbered = PLANNED_5.every(one => {
      const count = one.refs.length, prompt = textOf(one);
      return Array.from({ length: count }, (_, n) => prompt.includes(`The person from image ${n + 1},`)).every(Boolean) && !prompt.includes(`image ${count + 1}`)
        && (count > 0 || !/\bimages?\b/.test(prompt));
    });
    const distinct = new Set(PLANNED_5.map(textOf)).size;
    say(`2 the texts against the frozen frames (sha256 pinned ${frozen.length > 0}, ${frozen.length} answers, each to today's request ${asked}): ${remade} of ${PLANNED_5.length} prompts the bot's own for their `
      + `arm and answer, binding the fronts the plan takes; one prompt an arm, story and answer across the seeds ${[...ids.values()].every(set => set.size === 1)}, `
      + `${distinct} in all; each ending with the reader style, the first-person clause in the POV stories alone, the clothes before the references in C and CF `
      + `alone, the faces in CF alone, no name and never the viewer's look ${worded}; the references named by image number as each binds them, none in a frame `
      + `from words ${numbered}`);
    expect(frozen.length === 48 && asked && remade === PLANNED_5.length && [...ids.values()].every(set => set.size === 1) && distinct === 93 && worded && numbered,
      'the texts as the bot words each arm');

    // Every graph from the real texts, each picture named as an upload would be, read back independently; and the
    // action graph with one or two references the bot's own referenceGraph.
    for (const at of [first, third, out]) writeCardRecord(join(at, 'card.txt'));
    const card = cardOf(join(out, 'card.txt'));
    const nameOf = (from: string) => `ref-${sha256(from).slice(0, 16)}.png`;
    const built = PLANNED_5.map(one => ({ one, graph: buildJob({ ...real, card }, one, real.texts.cells.get(one.key)!, one.refs.map(ref => nameOf(ref.from))) }));
    const wrongBuilt = built.filter(({ one, graph }) => !cellRight(graph, one, real.texts.cells.get(one.key)!, one.refs.map(ref => nameOf(ref.from)), { ...real, card }))
      .map(({ one }) => one.key);
    const scaled = ['ImageScale', 'area', SCALED.width, SCALED.height, 'disabled'], cropped = ['ImageCrop', CROP.width, CROP.height, CROP.x, CROP.y];
    const shaped = built.every(({ one, graph }) => same(slotChains(graph).map(slot => slot.chain.slice(0, 5)), one.refs.map(ref => (ref.how === 'crop' ? cropped : scaled))));
    const frontGraph = apiGraph(JSON.parse(readFileSync(FRONT_GRAPH, 'utf8'))), actionBase = apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')));
    const values = (references: string[]) => ({ checkpoint: card.model, prompt: 'p', negative: '', seed: 71, steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1,
      ...FRAME_CANVAS, references });
    const bots = [1, 2].map(count => {
      const refs = Array.from({ length: count }, (_, n) => `ref-${n + 1}.png`);
      return canon(withAttention(applyToWorkflow(actionGraph(actionBase, refs.map((_, n) => n + 1)).graph, values(refs)))!)
        === canon(withAttention(applyToWorkflow(referenceGraph(frontGraph, count)!, values(refs)))!);
    });
    say(`3 every graph built from the real texts: ${built.length - wrongBuilt.length} of ${built.length} read back right${wrongBuilt.length ? `, wrong ${wrongBuilt.join(', ')}` : ''}; `
      + `each front through ImageScale 352x640, or ImageCrop 720x400 in CF: ${shaped}; the action graph with one and two fronts the bot's referenceGraph: ${bots.join(', ')}`);
    expect(!wrongBuilt.length && shaped && bots.every(Boolean), 'every graph of the real texts as its cell asks');

    // The copies the fakes draw: a made-up word in every prompt, and their own pins.
    const word = madeUpName(), marker = madeUpName(name => name !== word);
    const writeTexts = (to: string, cells: TextCell[]) => {
      const bytes = JSON.stringify({ note: 'The real texts with a made-up word, for the dry run.', cells: cells.map(cell => ({ ...cell, prompt: `${cell.prompt} ${word}`,
        negative: cell.negative ? `${cell.negative} ${word}` : '' })) }, null, 2);
      writeFileSync(join(to, TEXTS_FILE), bytes, { mode: 0o600 });
      return sha256(bytes);
    };
    const stand1 = inputsOf(join(resolve(realFirst), TEXTS_FILE), TEXTS_SHA256), stand3 = inputsOf(join(resolve(realThird), TEXTS_FILE), TEXTS_SHA256_3, PLANNED_3);
    const marked1 = writeTexts(first, PLANNED.map(one => stand1.texts.cells.get(one.key)!)), marked3 = writeTexts(third, PLANNED_3.map(one => stand3.texts.cells.get(one.key)!));
    const marked = writeTexts(out, PLANNED_5.map(one => real.texts.cells.get(one.key)!));
    const CARD_A = 'cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync', CARD_B = 'cuda:0 NVIDIA GeForce RTX 5090 D : cudaMallocAsync';
    const startCard = async (name: string, pytorch = '2.11.0+cu130') => {
      const started = await startFakeComfy({ jobMs: 20, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: kitchenLines(true, 'cu130'),
        pytorch, objectInfo: attentionInfo(true), card: name });
      fakes.push(started);
      origin = started.url;
      return started;
    };
    const fakeA = await startCard(CARD_A);
    const lend = (at: string, marks: string, extra: { stand?: Stand; from?: string[]; keys: string[] }) => drawStand({ out: at, comfy: origin,
      until: Date.now() + 3600000, pinned: marks, pollMs: 10, waitMs: 60000, timeoutMs: 10000, log: () => undefined, ...extra });
    const lent1 = await lend(first, marked1, { keys: [FRONTS.H, FRONTS.L] }), lent3 = await lend(third, marked3, { stand: STAND_3, from: [first], keys: [FRONTS.B, FRONTS.T] });
    say(`4 the fronts the stand takes, in runs of their own laid out as the first and third stands': ${countsOf(lent1).drawn} and ${countsOf(lent3).drawn} drawn, `
      + `${fakeA.jobs.length} jobs`);
    expect(countsOf(lent1).drawn === 2 && countsOf(lent3).drawn === 2 && fakeA.jobs.length === 4, 'the four fronts drawn');

    writePage(out, inputsOf(join(out, TEXTS_FILE), marked, PLANNED_5), undefined, STAND_5);
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length, folded = (page: string) => (page.match(/<details>/g) ?? []).length;
    const pageKeys = (sections: Section[]) => sections.flatMap(section => section.rows.flatMap(row => row.keys.filter((one): one is string => one !== undefined))).sort();
    const before = readFileSync(join(out, 'index.html'), 'utf8');
    say(`5 the page before the card: ${figures(before)} figures, ${folded(before)} prompts folded`);
    expect(figures(before) === 372 && folded(before) === 372 && same(pageKeys(STAND_5.sections), PLANNED_5.map(one => one.key).sort()),
      'the page before the card shows every cell once, with its prompt');

    const events: { event?: string; key?: string }[] = [];
    const draw = (extra: Partial<TesterOptions> = {}) => drawTester({ out, first, third, comfy: origin, until: Date.now() + 3600000, pinned: marked, pollMs: 10,
      waitMs: 60000, timeoutMs: 10000, log: event => events.push(event), ...extra });
    say('6 refusals before anything is sent or written:');
    const jobsBefore = fakeA.jobs.length, uploadsBefore = fakeA.uploads.length;
    await refused('texts other than the pinned', () => draw({ pinned: sha256('another texts.json') }));
    const record = readFileSync(join(out, 'card.txt'));
    writeFileSync(join(out, 'card.txt'), '', { mode: 0o600 });
    await refused('the stand without its card record', () => draw());
    writeFileSync(join(out, 'card.txt'), record, { mode: 0o600 });
    await refused('a --first that is not there', () => draw({ first: join(dry, 'nowhere') }));
    await refused('the third stand\'s run as --first, which holds no front of H or L', () => draw({ first: third }));
    // A copy of the third stand's run with its fronts, as if drawn from other weights.
    const other = join(dry, 'other'), thirdIndex = readJson<StandIndex>(join(third, INDEX_FILE))!;
    cpSync(third, other, { recursive: true });
    writeFileSync(join(other, INDEX_FILE), JSON.stringify({ ...thirdIndex, pins: { ...thirdIndex.pins, transformer: 'another-transformer.safetensors' } }), { mode: 0o600 });
    await refused('a --third drawn from other weights', () => draw({ third: other }));
    const tFile = join(third, thirdIndex.cells[FRONTS.T].file!), tBytes = readFileSync(tFile);
    writeFileSync(tFile, readFileSync(join(third, thirdIndex.cells[FRONTS.B].file!)), { mode: 0o600 });
    await refused('a front that is not the file its run recorded', () => draw());
    writeFileSync(tFile, tBytes, { mode: 0o600 });
    fakeA.options.pytorch = '2.11.0+cu128';
    await refused('a server on cu128', () => draw());
    fakeA.options.pytorch = '2.11.0+cu130';
    expect(fakeA.jobs.length === jobsBefore && fakeA.uploads.length === uploadsBefore && !existsSync(join(out, INDEX_FILE)), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`7 five seconds left: stopped ${short.stopped}, ${fakeA.jobs.length - jobsBefore} jobs sent`);
    expect(short.stopped === 'until' && countsOf(short).drawn === 0 && fakeA.jobs.length === jobsBefore, 'a cell that cannot end by --until is not begun');

    // An --until that comes while a job draws, on a card warm for the first cell's group: the job stopped, nothing recorded.
    fakeA.options.jobMs = 30000;
    const midway = await draw({ until: Date.now() + 14000, warm: { reached: true, groups: new Set<Group>([PLANNED_5[0].group]) } });
    fakeA.options.jobMs = 20;
    const stoppedJob = fakeA.jobs.at(-1);
    say(`8 an --until in the middle of a job: stopped ${midway.stopped}, ${fakeA.jobs.length - jobsBefore} job, its outcome ${stoppedJob?.outcome}, ${countsOf(midway).drawn} drawn`);
    expect(midway.stopped === 'until' && fakeA.jobs.length - jobsBefore === 1 && stoppedJob?.outcome === 'interrupted' && !Object.keys(midway.cells).length,
      'the job stopped at --until, and nothing recorded');

    // The stand on card A until the card goes away: after the first cell it closes as the next upload begins, the tenth
    // cell's, the first to take H's front, which the nine before it did not.
    const onA = fakeA.jobs.length, sentA = bodies.length, drawnA: string[] = [];
    const gone = await draw({ log: event => {
      events.push(event);
      const one = event as { event?: string; key?: string };
      if (one.event !== 'cell_drawn') return;
      drawnA.push(one.key!);
      if (drawnA.length === 1) goes = () => fakeA.close();
    } });
    const failedA = Object.values(gone.cells).filter(one => one.status === 'failed');
    say(`9 card A goes away at the first front it has not had: error ${gone.error}; ${fakeA.jobs.length - onA} jobs, ${countsOf(gone).drawn} drawn, failed `
      + `${JSON.stringify(countsOf(gone).failed)}`);
    expect(gone.error === 'comfy_unreachable' && fakeA.jobs.length - onA === 9 && same(drawnA, order.slice(0, 9)) && failedA.length === 1 && failedA[0].key === order[9],
      'the card gone: 9 drawn, the cell after them failed as unreachable, and the stand stopped');

    say('10 refusals on the next card before anything is sent:');
    const fakeC = await startCard(CARD_B, '2.11.1+cu130');
    await refused('a card on another torch', () => draw());
    expect(fakeC.jobs.length === 0 && fakeC.uploads.length === 0, 'the card on another torch gets nothing');
    const fakeB = await startCard(CARD_B);
    // H's front drawn anew in its run, file and record, since the stand first took it.
    const firstFile = join(first, INDEX_FILE), firstBytes = readFileSync(firstFile), firstIndex = JSON.parse(firstBytes.toString('utf8')) as StandIndex;
    const hFile = join(first, firstIndex.cells[FRONTS.H].file!), hBytes = readFileSync(hFile), lBytes = readFileSync(join(first, firstIndex.cells[FRONTS.L].file!));
    writeFileSync(hFile, lBytes, { mode: 0o600 });
    writeFileSync(firstFile, JSON.stringify({ ...firstIndex, cells: { ...firstIndex.cells, [FRONTS.H]: { ...firstIndex.cells[FRONTS.H], sha256: sha256(lBytes) } } }), { mode: 0o600 });
    await refused('a front its run has drawn anew since the stand took it', () => draw());
    writeFileSync(hFile, hBytes, { mode: 0o600 });
    writeFileSync(firstFile, firstBytes, { mode: 0o600 });
    expect(fakeB.jobs.length === 0 && fakeB.uploads.length === 0, 'the changed front sends nothing');

    // Card B takes over: every front uploaded again from the runs, the rest drawn once each in order.
    const sentB = bodies.length, drawnB: string[] = [];
    const takeover = await draw({ log: event => {
      events.push(event);
      const one = event as { event?: string; key?: string };
      if (one.event === 'cell_drawn') drawnB.push(one.key!);
    } });
    const onB = fakeB.jobs.length, again = await draw();
    const index = readJson<StandIndex>(join(out, INDEX_FILE))!;
    const pathOf = (front: string) => (BY_KEY.has(front) ? join(first, lent1.cells[front].file!) : join(third, lent3.cells[front].file!));
    const uploadName = (from: string) => `ref-${sha256(stripPngMetadata(readFileSync(pathOf(from)))).slice(0, 16)}.png`;
    const carded = Object.values(index.cells).every(cell => index.sessions?.[cell.session ?? -1]?.server.card === (drawnA.includes(cell.key) ? CARD_A : CARD_B));
    say(`11 card B takes over: ${takeover.error ?? takeover.stopped ?? 'done'}, ${fakeB.jobs.length} jobs, ${fakeB.uploads.length} uploads for the four fronts; a start after `
      + `it: ${fakeB.jobs.length - onB} more jobs; drawn ${countsOf(index).drawn}, each once in the plan's order ${same([...drawnA, ...drawnB], order)}; `
      + `sessions ${index.sessions?.length}, each cell on its card ${carded}`);
    expect(!takeover.error && !takeover.stopped && !again.error && !again.stopped && onB === 363 && fakeB.jobs.length === onB && countsOf(index).drawn === 372
      && same([...drawnA, ...drawnB], order) && Object.values(FRONTS).every(from => fakeB.uploads.includes(uploadName(from))) && fakeB.uploads.length === 4 && carded,
    'card B draws the rest, every front uploaded to it again');

    // Each job against its cell, on the card that drew it, and what the fake made of it; each front as the card gets
    // it: the picture, what the graph hands the encoder, and the size the encoder draws it at.
    const setup = { ...inputsOf(join(out, TEXTS_FILE), marked, PLANNED_5), card };
    const byKey5 = new Map(PLANNED_5.map(one => [one.key, one])), wrong: string[] = [];
    const seen = new Map<string, { how: How; picture: Size; handed: Size; encoder: Size; change: number }>();
    const jobsA = fakeA.jobs.slice(onA), postsA = bodies.slice(sentA, sentA + jobsA.length), postsB = bodies.slice(sentB);
    [...drawnA.map((from, n) => ({ from, job: jobsA[n], body: postsA[n] })), ...drawnB.map((from, n) => ({ from, job: fakeB.jobs[n], body: postsB[n] }))].forEach(({ from, job, body }) => {
      const one = byKey5.get(from)!, text = setup.texts.cells.get(from)!, graph = body?.body.prompt as Graph | undefined, cell = index.cells[from];
      const refNames = one.refs.map(ref => uploadName(ref.from));
      job?.slots.forEach((slot, s) => {
        const ref = one.refs[s], picture = pngSize(readFileSync(pathOf(ref.from)));
        const shown = slot.cropped ? { width: slot.cropped.width, height: slot.cropped.height } : picture, handed = slot.scaled ?? shown;
        const [width, height] = referenceGeometry(handed.width, handed.height, 0);
        seen.set(`${ref.how} ${sizeText(picture)} ${width}x${height}`, { how: ref.how, picture, handed, encoder: { width, height },
          change: Math.abs(width / height / (shown.width / shown.height) - 1) });
      });
      const right = graph !== undefined && same(buildJob(setup, one, text, refNames), graph) && cellRight(graph, one, text, refNames, setup) && job?.outcome === 'success'
        && job.sampler === 'KSampler' && job.start === null && job.noiseMask === null && !job.composites.length
        && same(job.slots, one.refs.map((ref, s) => ({ slot: s + 1, file: refNames[s], scaled: ref.how === 's352' ? SCALED : null, cropped: ref.how === 'crop' ? CROP : null })))
        && same(job.model, one.graph === 'front' ? ['ModelAttentionBackend', 'UNETLoader'] : ['ModelAttentionBackend', 'QwenImage21Cache', 'UNETLoader'])
        && same(job.images, [{ node: one.graph === 'front' ? '8' : '9', ...FRAME_CANVAS }])
        && cell?.status === 'drawn' && cell.file === one.file && cell.width === FRAME_CANVAS.width && cell.height === FRAME_CANVAS.height && cell.fallback === 0
        && existsSync(join(out, one.file)) && same(cell.references ?? [], one.refs.map(ref => sha256(readFileSync(pathOf(ref.from)))));
      if (!right) wrong.push(from);
    });
    say(`12 jobs against their reading and the fake's: ${drawnA.length + drawnB.length - wrong.length} of ${drawnA.length + drawnB.length} right`
      + `${wrong.length ? `, wrong ${wrong.slice(0, 12).join(', ')}` : ''}`);
    for (const one of seen.values()) {
      say(`   ${one.how}: the front ${sizeText(one.picture)}, handed on at ${sizeText(one.handed)}, drawn by the encoder at ${sizeText(one.encoder)}, shape changed `
        + `${(one.change * 100).toFixed(1)} %`);
    }
    const sizes = Object.fromEntries(['s352', 'crop'].map(how => [how, [...new Set([...seen.values()].filter(one => one.how === how).map(one => sizeText(one.encoder)))]]));
    expect(!wrong.length && drawnA.length + drawnB.length === 372 && same(sizes, { s352: ['352x640'], crop: ['704x384'] }) && [...seen.values()].every(one => one.change <= 0.05),
      'every job sends its own graph with the fronts it takes, each reaching the encoder at its size');

    const fronted = bodies.filter(one => 'front' in one.body || Object.keys(one.body).some(name => !['prompt', 'client_id', 'prompt_id'].includes(name))).length;
    say(`13 submits with anything but the graph, the client and the job's id, \`front\` among it: ${fronted} of ${bodies.length}; the fakes held at most `
      + `${fakes.map(one => one.mostHeld).join(', ')} job at once; ${strays} calls to anything but the fake of the moment`);
    expect(fronted === 0 && bodies.length > 0 && fakes.every(one => one.mostHeld <= 1) && strays === 0, 'no front, one job at a time, the fakes alone');

    const after = readFileSync(join(out, 'index.html'), 'utf8'), mode = (path: string) => statSync(path).mode & 0o777;
    const links = [...new Set([...after.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
    const modes = mode(out) === 0o700 && mode(join(out, INDEX_FILE)) === 0o600 && mode(join(out, 'index.html')) === 0o600 && mode(join(out, 'frames')) === 0o700
      && PLANNED_5.every(one => mode(join(out, one.file)) === 0o600);
    const dashes = /[–—]/.test(after.replace(/<pre>[\s\S]*?<\/pre>/g, '')), named = after.includes(CARD_A) && after.includes(CARD_B);
    say(`14 the page: ${figures(after)} figures, every picture linked where it lies ${links.length === 372 && links.every(link => existsSync(resolve(out, link)))}; dashes in `
      + `its own words ${dashes}; both cards named ${named}; directories 700 and files 600: ${modes}`);
    expect(figures(after) === 372 && links.length === 372 && links.every(link => existsSync(resolve(out, link))) && !dashes && named && modes
      && after.includes('Нарисовано 372 из 372') && after.includes('Triton включён') && !after.includes('не нарисовано'),
    'the page links every picture and names both cards, in words without dashes');

    // The judging as it goes after the card, from the stand's real texts and question file.
    writeFileSync(join(out, TEXTS_FILE), readFileSync(textsFile), { mode: 0o600 });
    writeFileSync(join(out, QUESTIONS_FILE), readFileSync(questionsFile), { mode: 0o600 });
    const judge = await import('./image-refs-judge.ts');
    const bundled = judge.writeBundles(out), checked = 'checked' in bundled ? bundled.checked : 0, judgeDir = judge.judgeDirOf(out), sessions = judge.sessionPlan5();
    const keyed = sessions.every(session => {
      const got = readJson<SessionKey>(join(judgeDir, 'keys', `${session.name}.json`)), story = caseOf(session.story);
      const fronts = (story.dressed ?? []).map(one => FRONTS[one.who]);
      const names = (files: { name: string }[]) => files.map(one => one.name);
      return got !== undefined && same(got.pictures.map(one => one.key).sort(), [...session.cells].sort()) && same(got.references.map(one => one.key).sort(), [...fronts].sort())
        && same(names(got.pictures), names(got.pictures).sort()) && same(names(got.references), names(got.references).sort()) && existsSync(join(judgeDir, 'bundles', session.name));
    });
    const needles = [...PLANNED_5.map(one => one.key), ...Object.values(FRONTS), 'frame:', 'front:', 'refs-stand', ...CASES.map(one => one.id)].map(one => Buffer.from(one, 'utf8'));
    const leaks = searchTree(join(judgeDir, 'bundles'), needles);
    say(`15 the bundles: ${bundled.built} built of ${bundled.sessions}, skipped ${bundled.skipped}, missing ${bundled.missing.length}, ${checked} fronts checked `
      + `against the hash their cell took; each key the session's cells and fronts ${keyed}; a key, a front, a run or a story named in ${leaks.hits.length} of `
      + `${leaks.files} bundle files, unread ${leaks.unread.length}`);
    expect(bundled.built === 32 && bundled.skipped === 0 && !bundled.missing.length && checked === 300 && keyed && !leaks.hits.length && !leaks.unread.length,
      'every session bundled blind, from the pictures the cells recorded');
    const scratch = join(dry, 'judged');
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const judged = await judge.dryJudge(judge.defaultJobs(out), scratch, 4, 3);
    const got = judged.records[0] as { states?: Record<string, number>; refusals?: number; fallback?: number; judged?: number; decisions?: number; undecided?: number; dir?: string };
    // The stand-ins answer at random, unsure included, so a rule may stay undecided between its resolutions; none may for a
    // picture left unjudged.
    const verdicts = judge.scoreStand5(out, got.dir ?? scratch).decisions, gaps = verdicts.filter(one => one.why.startsWith('not judged')).length;
    say(`   judged by stand-ins for codex: sessions ${JSON.stringify(got.states)}, refusals ${got.refusals}, the fallback's attempts ${got.fallback}; pictures judged `
      + `${got.judged}; ${got.decisions} rules, ${['yes', 'no', 'undecided'].map(verdict => `${verdict} ${verdicts.filter(one => one.verdict === verdict).length}`).join(', ')}, `
      + `for a picture not judged ${gaps}; score.md ${existsSync(join(got.dir ?? scratch, 'score.md'))}; about ${judged.expectedMinutes} minutes at ${judged.perSession} a session, `
      + `${judged.parallel} at a time`);
    expect(same(got.states, { answered: 32 }) && got.refusals === 1 && got.fallback === 1 && got.judged === 372 && got.decisions === 8 && verdicts.length === 8 && !gaps,
      'every session answered, the refused one by the fallback, and every rule read from judged pictures');

    say('16 refusals before a bundle is built:');
    const questionsCopy = join(out, QUESTIONS_FILE), questionsBytes = readFileSync(questionsCopy);
    writeFileSync(questionsCopy, Buffer.concat([questionsBytes, Buffer.from(' ')]), { mode: 0o600 });
    await refused('a question file other than the pinned', () => judge.writeBundles(out));
    writeFileSync(questionsCopy, questionsBytes, { mode: 0o600 });
    const frameFile = join(out, PLANNED_5[0].file), frameBytes = readFileSync(frameFile);
    writeFileSync(frameFile, readFileSync(join(out, PLANNED_5[1].file)), { mode: 0o600 });
    await refused('a picture changed since its cell recorded it', () => judge.writeBundles(out));
    writeFileSync(frameFile, frameBytes, { mode: 0o600 });
    writeFileSync(hFile, lBytes, { mode: 0o600 });
    writeFileSync(firstFile, JSON.stringify({ ...firstIndex, cells: { ...firstIndex.cells, [FRONTS.H]: { ...firstIndex.cells[FRONTS.H], sha256: sha256(lBytes) } } }), { mode: 0o600 });
    await refused('a front its run has drawn anew since the cells took it', () => judge.writeBundles(out));
    writeFileSync(hFile, hBytes, { mode: 0o600 });
    writeFileSync(firstFile, firstBytes, { mode: 0o600 });
    const kept = judge.writeBundles(out);
    say(`   built again: ${kept.kept} kept, ${kept.built} built`);
    expect(kept.kept === 32 && kept.built === 0, 'the bundles written once');

    // The prompts' word is in the texts and on the pages, and nowhere else; the fake's word is nowhere.
    const text = output.text(), wordForms = markerForms(word), marks = markerForms(marker);
    const beyond = searchTree(dry, wordForms, path => [TEXTS_FILE, 'index.html'].includes(basename(path))), anywhere = searchTree(dry, marks);
    const printed = [...wordForms, ...marks].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`17 privacy: the prompts' word in ${beyond.hits.length} of ${beyond.files} files beside the texts and the pages, unread ${beyond.unread.length + anywhere.unread.length}; `
      + `the fake's word in ${anywhere.hits.length} of ${anywhere.files}; printed ${printed}`);
    expect(!beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length && !printed,
      'no prompt anywhere but the texts and the pages, and nothing printed');
    expect(!events.some(one => one.event === 'attention_fallback'), 'no fallback of the attention');
    say(missed.length ? `the tester stand's dry run did NOT go as expected: ${missed.length} of its checks` : 'the tester stand\'s dry run went as expected');
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
    out: { type: 'string' }, first: { type: 'string' }, third: { type: 'string' }, frames: { type: 'string' }, dir: { type: 'string' }, tokenizers: { type: 'string' },
    until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, wait: { type: 'string', default: '300' },
    timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'estimate') {
    print({ event: 'estimate', ...testerEstimate() });
    return;
  }
  if (!values.out) throw new Refusal('Use: image-refs-tester.ts estimate|dry-run|draw|page --out <the stand\'s directory> (docs/action-experiment.md#tester-stand)');
  const out = resolve(values.out);
  if (command === 'dry-run') {
    if (!values.frames || !values.first || !values.third) {
      throw new Refusal('Use: dry-run --out <dir> --frames <frames.json> --first <the first stand\'s directory> --third <the third\'s> [--tokenizers <dir>] [--dir <dir>]');
    }
    const result = await dryRunTester(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-refs-tester-dry-')), out, resolve(values.frames), resolve(values.first),
      resolve(values.third), resolve(values.tokenizers ?? join(ROOT, 'tokenizers')));
    if (!result.pass) process.exitCode = 1;
  } else if (command === 'page') {
    writePage(out, inputsOf(join(out, TEXTS_FILE), TEXTS_SHA256_5, PLANNED_5), readJson<StandIndex>(join(out, INDEX_FILE)), STAND_5);
    print({ event: 'page', file: join(out, 'index.html') });
  } else if (command === 'draw') {
    // `--until` is the end of the drawing in epoch seconds, before the card's end as the runbook computes it. Exit 0 once
    // the stand is through, 3 at --until, 1 on an error.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!values.first || !values.third || !Number.isInteger(until) || until <= Date.now() || until > Date.now() + LONGEST_MS || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --out <dir> --first <the first stand\'s directory> --third <the third\'s> --until <epoch seconds, at most 12 hours on> [--wait 300] '
        + '[--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawTester({ out, first: resolve(values.first), third: resolve(values.third), comfy: comfyUrl(values.comfy!), until, waitMs: wait * 1000,
      timeoutMs: timeout * 1000, log: print });
    print({ event: 'tester_done', ...countsOf(index), ...(index.error ? { error: index.error } : {}), ...(index.stopped ? { stopped: index.stopped } : {}) });
    process.exitCode = index.error ? 1 : index.stopped ? 3 : 0;
  } else throw new Refusal('Use: image-refs-tester.ts estimate|dry-run|draw|page (docs/action-experiment.md#tester-stand)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  // Not awaited at the top: the dry run imports local/image-refs-judge.ts, which imports this file, and a module held at
  // its top-level await never finishes loading for another.
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  });
}
