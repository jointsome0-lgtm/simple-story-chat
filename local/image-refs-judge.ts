// The judging of the refs stand (docs/action-experiment.md#refs-judging): blind, by gpt-6-astra at high effort through
// local/action-judge.ts's attempts, with qwen-refs' questions (its final report's §4.6 and next-card-texts.txt) as a
// GPT-6 Astra review before any judging changed them, and scored by its §4.7, the phase-1 rules for arm D and the FV
// rule. Five kinds of session:
//   frames    one comparison's frames of one scene and seed, against the scene, each person's words and H's table;
//   identity  the same frames beside the comparison's references: each woman, found by her place, against each
//             reference compared, and what each frame resembles in every reference shown (the pictures the cells were
//             drawn from, FV's views and FC's crop included);
//   fronts    fronts against the people's words and H's table;
//   sheet     one character sheet against the common specification of its build;
//   turns     pictures each made from one reference to show the person turned (FV's views, VIEW), against it.
// A bundle holds its task, its inputs, its schema, the form of its answers and its pictures under names that say
// nothing; which cell is which picture stays in judge/keys/. Every session is a paid one: the run takes three at a time
// and stops at its limit, at --until, after two failures of codex itself in a row, or once the fallback has judged more
// than a quarter of the sessions tried. The words the judges are shown (people, scenes, style lines, sheets) are
// synthetic and kept beside the run in judge/judge-texts.json, pinned here. What this file prints is names, codes,
// counts and times.
// The second stand (docs/action-experiment.md#refs-stand-2) is judged by the same questions and the same judging texts:
// its eight cells of one scene and seed side by side, against H's words and table and against H's front, with the
// view and the crop its cells were drawn from shown for resemblance. Its references are the first stand's pictures,
// read from that run (--from, by default the directory beside it) and checked against the hashes its cells used.
// The third and fourth stands (docs/action-experiment.md#refs-judging-34) are judged by the questions of their own
// judge-questions.json, pinned here in place of judge-texts.json, as a review before their judging changed them: the
// third stand's eight cells of one scene and seed side by side against the scene (`frames`) and against each person's
// front and words (`identity`), S's four beside the draft they were edited from (`draft`), and B's and T's fronts
// (`fronts`); the fourth stand's four views of one person and seed against the front they were drawn from (`turns`).
// Every picture any of their cells took is read from its own run and checked against the hash the cell recorded. Their
// queue also stops once more than a tenth of their planned sessions have had an attempt fail or refuse, and their
// agreement is Astra's retest of every session: completion and clean first, then over the pictures eligible in both
// passes the same answer, the same assessability and the success reading with its kappa.
// The fifth, the tester stand (docs/action-experiment.md#tester-stand), is judged by questions of its own, in one
// session a story and seed: the arms' frames side by side, where each person is against their place in the four stories
// seen through the viewer's eyes (`pov`), and what each person wears beside their front in the three by the lake
// (`dress`). Its question file is pinned as the third's is; it has no retest, and so no agreement.
//   bundles   judge/bundles/ and judge/keys/ from the drawn cells, once
//   dry-run   the bundles judged by stand-ins for codex in a scratch directory, scored and compared: the sessions and the
//             expected time (--jobs FILE for a whole night's plan)
//   judge     the sessions without answers, in the plan's order: --parallel 3 --limit 119 [--until 2026-09-28T05:00:00Z]; the
//             fallback judged alone on arm A and FV, only to be compared: --model gpt-6-sol --fallback none --ranks A,FV
//             --limit 60 --record DIR/judge/sol; or --jobs FILE, several such jobs in one queue of `parallel` sessions,
//             each job's sessions before the next job's
//   score     judge/score.json and judge/score.md from the judge of record's answers
//   agreement judge/agreement.md: the compared judge's answers against the judge of record's, question by question
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JUDGE, SESSION_MS, each, runAttempt, strict } from './action-judge.ts';
import type { AttemptRecord, Exec, Read } from './action-judge.ts';
import { fitsSchema, readJson } from './action-text.ts';
import type { Schema } from './action-text.ts';
import { pngSize, stripPngMetadata } from './image-batch.ts';
import { decodePng } from './image-pilot.ts';
import { encodePng } from './image-levers.ts';
import { Refusal } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { CROP as GRAPH_CROP, SEEDS, SHEET_PEOPLE, frameKey, frontKey, sheetKey, viewKey } from './image-refs-test.ts';
import type { Scene } from './image-refs-test.ts';
import { FRONTS, SEEDS_3, SEEDS_4, TEXTS_SHA256_3, TEXTS_SHA256_4, viewId, viewKeyOf } from './image-refs-backlog.ts';
import { ANSWERS, CELLS_5, PLANNED_5, SEEDS_5, TEXTS_SHA256_5, armsOf, cellKey5 } from './image-refs-tester.ts';
import type { Arm } from './image-refs-tester.ts';
import { CASES } from '../examples/tester-stand.ts';
import type { BarePart, CaseId } from '../examples/tester-stand.ts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
// judge/judge-texts.json as judge/build-judge-texts.ts wrote it, byte for byte, and the stand's own texts.
const JUDGE_TEXTS_SHA256 = '6460753f52b88bc31ec52d269c4a257d6a932bc08e3b07baabdfc50de8fdbc78';
const STAND_TEXTS_SHA256 = 'd0678be9753c496fc3ad754ad5124a0add622b8298a3f744f6c71f0da2728f61';
const STAND_2_TEXTS_SHA256 = '9a5ee1a68c05970bed86088e982a0c64df99827712db10af13143fcddfa3cfe3';
export const judgeDirOf = (run: string) => join(resolve(run), 'judge');
export type StandId = 1 | 2 | 3 | 4 | 5;
type Stand12 = 1 | 2;
type Stand34 = 3 | 4;
// Which stand a run is, by its texts.
export function standOf(run: string): StandId {
  const file = join(resolve(run), 'texts.json'), hash = existsSync(file) ? sha256(readFileSync(file)) : '';
  if (hash === STAND_TEXTS_SHA256) return 1;
  if (hash === STAND_2_TEXTS_SHA256) return 2;
  if (hash === TEXTS_SHA256_3) return 3;
  if (hash === TEXTS_SHA256_4) return 4;
  if (hash === TEXTS_SHA256_5) return 5;
  throw new Refusal(`${file} is not the texts any refs stand drew from`);
}

// ---- The words the judges are shown ----

export const PARTS = ['height', 'build', 'shoulders', 'bust', 'waist', 'hips', 'buttocks', 'legs', 'arms'] as const;
type Part = typeof PARTS[number];
type Who = 'H' | 'L';
type Style = 'VN' | 'FILM' | 'SEMI' | 'PENCIL' | 'PORTRAIT' | 'RF';
type PersonWords = { name: string; words: string; table?: string; parts: Partial<Record<Part, string>> };
type ScenePerson = { person: Who; role: string; facing: string; place: string; clothes: string; action: string };
type SceneWords = { shot: string; setting: string; objects: string; props: string; light: string; moment: string; people: ScenePerson[] };
type SheetWords = { request: string; layout: string; medium: string; physique: string; outfit: string; table?: string };
type JudgeTexts = { people: Record<Who, PersonWords>; scenes: Record<Scene, SceneWords>; media: Record<Style, string>; sheets: Record<string, SheetWords>;
  turns: Record<string, string> };
export function readTexts(run: string): JudgeTexts {
  const file = join(judgeDirOf(run), 'judge-texts.json');
  if (!existsSync(file)) throw new Refusal(`${file} is missing: node judge/build-judge-texts.ts writes it beside the run`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== JUDGE_TEXTS_SHA256) throw new Refusal(`${file} is not the judging texts image-refs-judge.ts pins; nothing is judged from it`);
  standOf(run);
  return JSON.parse(bytes.toString('utf8')) as JudgeTexts;
}
const ID: Record<Who, string> = { H: 'mara', L: 'lina' };
const partsOf = (texts: JudgeTexts, who: Who) => PARTS.filter(part => texts.people[who].parts[part] !== undefined);

// ---- The layout ----

// The ranks of qwen-refs' §4.3 with FV right after arm A: the order the sessions run in, and so the order a cut would
// leave them out.
export const RANKS = ['A', 'FV', 'B', 'C', 'D'] as const;
// The second stand's one rank: its cells of one scene and seed side by side, the seeds in the order it drew them.
export const RANKS_2 = ['S2'] as const;
// The third stand's: B's and T's fronts, then each scene and seed's frames, then S's four beside the draft; the fourth
// stand's one, its views.
export const RANKS_3 = ['F3', 'K3', 'S3'] as const;
export const RANKS_4 = ['V4'] as const;
type Rank = typeof RANKS[number] | typeof RANKS_2[number] | typeof RANKS_3[number] | typeof RANKS_4[number] | typeof RANKS_5[number];
export const ranksOf = (stand: StandId): readonly string[] => (stand === 1 ? RANKS : stand === 2 ? RANKS_2 : stand === 3 ? RANKS_3 : stand === 4 ? RANKS_4 : RANKS_5);
export const SEEDS_2 = [21, 23, 29, 31, 37, 41];
// In the order of the tester's complaints: the negative at CFG 2, the look, the clothes.
export const CELLS_2 = ['R-L0', 'R-L0-NEG', 'W-L0', 'W-L0-NEG', 'R-L1', 'W-L1', 'FV-L0', 'FC-L0'];
type Kind12 = 'frames' | 'identity' | 'fronts' | 'sheet' | 'turns';
// The third stand adds `draft`; its `frames`, `identity` and `fronts` and the fourth stand's `turns` ask their own tasks.
// The fifth has `pov` and `dress`.
export type Kind = Kind12 | 'draft' | Kind5;
// A picture a session judges: its cell, the style it was asked for, the person a front shows, and for a turned
// picture the turn and the reference it was made from.
type Shown = { key: string; style?: Style; person?: Who; turn?: string; reference?: string; sheet?: string };
// One comparison: the cells judged side by side, the references each woman is compared with, and the other pictures
// its cells were drawn from, which the identity session shows for resemblance only. A comparison of frames is judged
// twice, by `frames` against the words and by `identity` against the references.
type Comparison = { group: string; rank: Rank; kind: 'frames' | 'fronts' | 'sheet' | 'turns'; scene?: Scene; seed?: number; pictures: Shown[]; references: string[];
  sources: string[] };
const H_FRONT = frontKey('H-PORTRAIT'), L_FRONT = frontKey('L-PORTRAIT'), VN_FRONT = frontKey('H-VN');
// FC's reference: the top 720x400 of H's VN front at seed 7, as ImageCrop cut it for the encoder.
export const CROP_KEY = 'crop:H-VN:s7';
const CROP = { from: VN_FRONT, width: 720, height: 400 };
export function comparisons(stand: Stand12 = 1): Comparison[] {
  const out: Comparison[] = [];
  if (stand === 2) {
    for (const seed of SEEDS_2) for (const scene of ['K-solo', 'P'] as Scene[]) {
      out.push({ group: 'S2', rank: 'S2', kind: 'frames', scene, seed, pictures: CELLS_2.map(id => ({ key: frameKey(id, scene, seed), style: 'VN' as Style })),
        references: [H_FRONT], sources: [scene === 'K-solo' ? viewKey('H-34R') : viewKey('H-PL'), CROP_KEY] });
    }
    return out;
  }
  const frames = (group: string, rank: Rank, scenes: Scene[], cells: [string, Style][], references: string[], sources: (scene: Scene) => string[] = () => []) => {
    for (const scene of scenes) for (const seed of SEEDS) {
      out.push({ group, rank, kind: 'frames', scene, seed, pictures: cells.map(([id, style]) => ({ key: frameKey(id, scene, seed), style })), references,
        sources: sources(scene) });
    }
  };
  const fronts = (group: string, rank: Rank, ids: [string, Who, Style][]) => out.push({ group, rank, kind: 'fronts', references: [], sources: [],
    pictures: ids.flatMap(([id, person, style]) => SEEDS.map(seed => ({ key: frontKey(id, seed), person, style }))) });
  const views = (scene: Scene) => (scene === 'K-solo' ? [viewKey('H-34R')] : scene === 'P' ? [viewKey('H-PL')] : [viewKey('H-34R'), viewKey('L-34L')]);
  // Arm A: the wording (C-now, R) beside FV and the 2x2 of wording and front style (C-VN, R-VN); the face crop (FC)
  // beside the words alone (W); the pair; and the fronts the frames were drawn from.
  frames('A1', 'A', ['K-solo', 'P'], [['C-now', 'VN'], ['R', 'VN'], ['FV', 'VN'], ['C-VN', 'VN'], ['R-VN', 'VN']], [H_FRONT, VN_FRONT], views);
  frames('A2', 'A', ['K-solo', 'P'], [['W', 'VN'], ['FC', 'VN']], [H_FRONT, VN_FRONT], () => [CROP_KEY]);
  frames('AP', 'A', ['K-pair'], [['C-now', 'VN'], ['R', 'VN'], ['FV', 'VN'], ['W', 'VN']], [H_FRONT, L_FRONT], views);
  fronts('F1', 'A', [['H-PORTRAIT', 'H', 'PORTRAIT'], ['L-PORTRAIT', 'L', 'PORTRAIT'], ['H-VN', 'H', 'VN']]);
  // FV's views, each against the front it was made from.
  out.push({ group: 'V1', rank: 'FV', kind: 'turns', references: [H_FRONT, L_FRONT], sources: [], pictures: [
    { key: viewKey('H-34R'), turn: 'H-34R', reference: H_FRONT }, { key: viewKey('H-PL'), turn: 'H-PL', reference: H_FRONT },
    { key: viewKey('L-34L'), turn: 'L-34L', reference: L_FRONT }] });
  // Arm B: every sheet alone, the frames from H's sheets and from RF, RF beside H's PENCIL front, and VIEW.
  for (const id of [...SHEET_PEOPLE.map(who => `SH-${who}`), 'SH-words-H', 'SH-words-4', 'SH-cfg1-H', 'SH-cfg1-4']) for (const seed of SEEDS) {
    out.push({ group: id, rank: 'B', kind: 'sheet', seed, references: [], sources: [], pictures: [{ key: sheetKey(id, seed), sheet: id.replace(/^SH-(?:words-|cfg1-)?/, '') }] });
  }
  frames('B1', 'B', ['K-solo', 'P'], [['SF-sheet7', 'PENCIL'], ['SF-sheet11', 'PENCIL'], ['QRF', 'PENCIL'], ['SF-VN', 'VN']],
    [sheetKey('SH-H', 7), sheetKey('SH-H', 11), frontKey('RF')]);
  fronts('F3', 'B', [['H-PENCIL', 'H', 'PENCIL'], ['RF', 'H', 'RF']]);
  for (const who of SHEET_PEOPLE) {
    out.push({ group: `VIEW-${who}`, rank: 'B', kind: 'turns', references: SEEDS.map(seed => sheetKey(`SH-${who}`, seed)), sources: [],
      pictures: SEEDS.map(seed => ({ key: frameKey(`VIEW-${who}`, undefined, seed), turn: 'VIEW', reference: sheetKey(`SH-${who}`, seed), sheet: who })) });
  }
  // Arm C: W and R in each other style beside one another, and the fronts of those styles.
  frames('C1', 'C', ['K-solo', 'P'], [['W-FILM', 'FILM'], ['R-FILM', 'FILM'], ['W-SEMI', 'SEMI'], ['R-SEMI', 'SEMI'], ['W-PENCIL', 'PENCIL'], ['R-PENCIL', 'PENCIL']],
    [frontKey('H-FILM'), frontKey('H-SEMI'), frontKey('H-PENCIL')]);
  fronts('F2', 'C', [['H-FILM', 'H', 'FILM'], ['H-SEMI', 'H', 'SEMI']]);
  // Arm D: the fronts at their own size (Q), L's front for H (X), rough words (Rough), and in the pair the tags as words
  // (Naming), the pictures in the other order (Order), and neither pictures nor looks (L-now).
  frames('D1', 'D', ['K-solo'], [['Q', 'VN'], ['X', 'VN'], ['Rough', 'VN']], [H_FRONT, L_FRONT]);
  frames('DP', 'D', ['K-pair'], [['Q', 'VN'], ['Naming', 'VN'], ['Order', 'VN'], ['Rough', 'VN'], ['L-now', 'VN']], [H_FRONT, L_FRONT]);
  return out;
}
// The sessions in the order they run: each comparison of frames twice, the words first. A session's name is a number
// and its kind, which is what the judge sees of it.
export type SessionPlan = { name: string; kind: Kind12; comparison: Comparison };
export function sessionPlan(stand: Stand12 = 1): SessionPlan[] {
  const sessions = ranksOf(stand).flatMap(rank => comparisons(stand).filter(one => one.rank === rank))
    .flatMap(comparison => (comparison.kind === 'frames' ? ['frames', 'identity'] as const : [comparison.kind]).map(kind => ({ kind, comparison })));
  return sessions.map((one, at) => ({ name: `j${String(at + 1).padStart(2, '0')}-${one.kind}`, ...one }));
}
// Any stand's sessions as the queue takes them: name, kind and rank, in the order they run.
export type Planned = { name: string; kind: Kind; rank: string };
export const plannedSessions = (stand: StandId): Planned[] => (stand === 1 || stand === 2
  ? sessionPlan(stand).map(one => ({ name: one.name, kind: one.kind, rank: one.comparison.rank }))
  : stand === 5 ? sessionPlan5().map(one => ({ name: one.name, kind: one.kind, rank: one.rank }))
    : sessionPlan34(stand).map(one => ({ name: one.name, kind: one.kind, rank: one.rank })));

// ---- The tasks ----

const ENDING = 'Reason as long as you need. End your answer with exactly one ```json block that fits schema.json in this folder: the form in form.json with each value replaced by one of the values it lists there, nothing more and nothing missing.';
const FALLBACK = 'If clean is no, still return every required field: for each remaining answer field, use the first value allowed by that field from this ordered list: not_visible, unsure, no, absent, wrong. These values are placeholders only; the whole picture is left out.';
const CLEAN = `clean: is it free of nudity and of sexual content? yes or no. ${FALLBACK}`;
const ANATOMY = 'anatomy: is there an anatomy error: a limb too many or missing, bodies merged, a joint bent the way it cannot bend, a torso twisted at the waist so that the chest and the hips face clearly different ways beyond what a body can turn, a malformed hand or foot? yes, no or unsure.';
const WORDS = 'people: each person\'s words: her looks, and her build part by part in parts, each part with the words that name it and, for one person, the figures of her table of measurements (centimetres; the weight in kilograms)';
const PART_RULE = 'Judge visible proportions, fullness and shape. Measurements are approximate visual design guidance, not quantities you can verify from pixels. Use matches when the visible criteria agree; too_small or too_large for a clear directional size mismatch; mismatch for a visible non-size mismatch or conflicting size directions; unsure when the visible evidence or target description is insufficient; and not_visible when the required feature is hidden, cropped or unavailable from this viewpoint. Do not infer absolute height or weight without a reliable scale, lateral width from a true profile, or buttock projection from hip circumference alone.';
const FACING = 'facing: judge only the requested body orientation, from the orientation words in her facing and her place (three-quarters toward one side of the picture, true profile toward one side, turned toward someone). Judge torso and pelvis, not the head alone. A true side profile does not satisfy a three-quarter request, nor a three-quarter view a profile request. Position and figure size do not affect this answer. yes, no or unsure';
export const TASKS: Record<Kind12, string> = {
  frames: `You judge pictures drawn for one scene of a story, each against the words you are given.

input.json holds:
- scene: the scene every picture was drawn for: the shot, the setting, the objects, the props, the light, the moment, and each person in it with her role, her facing (how her body is turned in the picture), her place, her clothes and her action;
- ${WORDS};
- pictures: the pictures' file names, each with the medium it was asked to be drawn in.
The pictures are in this folder and attached in the order input.json lists them.

For each picture:
1. ${CLEAN}
2. medium: is the whole picture drawn in its medium? yes, partly or no.
3. panels: is the picture split into panels or several views, or does it show one person more than once? yes or no. lettering: is there any writing, label, number or arrow in it? yes or no.
4. ${ANATOMY}
5. For each person of the scene, first tell who is who by her looks and her place, before you judge anything she does: present, absent or unsure. If you cannot tell who is who, answer unsure and judge the rest for the woman in her place. Then:
   - looks: are her face, hair and skin as her words say? yes, no or unsure;
   - hair: do the visible hair colour, length, texture and hairstyle agree with her words? yes, no or unsure;
   - clothes: does she wear the clothes the scene gives her, and nothing in their place? yes, no or unsure;
   - ${FACING};
   - action: does she do what the scene says? yes, no or unsure;
   - parts: each part of her build in her parts, on its own, against the words and figures given for it. ${PART_RULE}
   For a person who is absent: looks, hair, clothes, facing and action no, and every part not_visible.
6. Where the scene has two people, mixups: wrong_person (one of them does what the scene gives the other), swapped_looks (their looks are swapped), merged (two people merged into one): yes, no or unsure each.
The pictures may be compared with one another.

${ENDING}`,
  identity: `You compare the people in pictures with reference pictures.

input.json holds:
- references: the reference pictures' file names, each with what it shows and whether it is compared: compare true for a reference each person is compared with, false for one that is only looked at for resemblance;
- pictures: the pictures' file names, each with the medium it was asked to be drawn in;
- scene: the setting, the light, and each person of the scene (people) with her id, her name, her role, her place, her clothes and her action.
Everything is in this folder and attached: the pictures in the order input.json lists them, then the references in theirs.

For each picture:
1. ${CLEAN}
2. people: for each person of the scene, locate her figure by the scene's stated place, independently of resemblance to any reference or of the action performed: the sole figure when the scene has one person, and when it has two, the figure at the place the scene gives her. present: does that place hold an identifiable figure? yes, no or unsure. Then compare that figure independently with every reference whose compare is true:
   - silhouette: do the visible body proportions and volumes agree with the reference, allowing for pose, perspective and clothing? Judge body shape separately from hair outline and rendering. Do not compare the two-dimensional outlines literally across different turns. Answer no for a clear visible contradiction, yes when there is sufficient comparable evidence of agreement, and unsure when the views or clothing prevent that judgment. Do not infer unseen dimensions.
   - face: does her face match the reference? Judge the face by its shape and features (outline, nose, eyes, brows, lips, hairline), not by how it is painted: two pictures in different media can show the same face. yes, no or unsure.
   A poor likeness does not make the figure absent. If the place holds no figure, answer no for silhouette and face; if its figure cannot be determined, answer unsure.
3. takes: for each reference, whether the picture visibly resembles that reference in a feature that conflicts with the requested scene or medium. These are visual resemblance judgments, not claims about which reference the picture was made from. Answer yes, no or unsure; unsure when the feature cannot be assessed in either image:
   - rendering: the reference's rendering (its line, shading and finish) in place of the picture's own medium;
   - backdrop: the reference's plain grey backdrop in place of the scene's setting;
   - light: the reference's even frontal light in place of the scene's light;
   - pose: the reference's standing pose (upright, the arms at the sides or held a little away) in place of the scene's action;
   - clothes: does a figure wear the reference's identifiable garment, or a distinctive combination of its construction, material and colour, in place of the scene's requested clothing? A shared colour, close fit or generic sleeveless cut alone is insufficient. Clothing explicitly requested by the scene does not count.
The pictures may be compared with one another.

${ENDING}`,
  fronts: `You check pictures drawn to show how people look, each against the person's words.

input.json holds:
- ${WORDS};
- pictures: the pictures' file names, each with the person it was asked to show and the medium it was asked to be drawn in. Each was asked to show that person alone, standing, full length from the front, on a plain grey backdrop.
The pictures are in this folder and attached in the order input.json lists them.

For each picture:
1. ${CLEAN}
2. medium: is the whole picture drawn in its medium? yes, partly or no.
3. front_view: one person, full length from head to feet, seen from the front? yes or no. lettering: is there any writing, label, number or arrow in it? yes or no.
4. ${ANATOMY}
5. looks: are her face, hair and skin as her words say? yes, no or unsure.
6. parts: each part of her build in her parts, on its own, against the words and figures given for it. ${PART_RULE}
The pictures may be compared with one another.

${ENDING}`,
  sheet: `You check one character reference sheet against its intended visual target.

input.json holds the sheet's file name (sheet) and the common evaluation specification for the intended character, layout, medium and outfit: request (whom it shows), layout (the views it should show, and how), medium (the rendering), physique (the build; its measurements are in centimetres and are visual design guidance, not text to print) and outfit. The sheet is in this folder and attached.

Answer:
1. clean: is the sheet free of nudity and of sexual content? yes or no. ${FALLBACK}
2. layout: views (the front, the true profile and the back full-body views and the two head-and-shoulders portraits are all there), aligned (the heads and the soles of the full-body views are at the same heights), cropped (a view is cut off by the edge), lettering (any writing, label, number or arrow), second_person (anyone but the one person): yes or no each.
3. consistency: face (the same face in the two portraits and the front view), hair (the same hair in every view), outfit (the same outfit in every full-body view): yes, no or unsure each; shape: could the front, profile and back views depict one coherent three-dimensional build, allowing for the different widths and depths visible from each direction? Do not require identical projected waist-to-hip ratios. yes, no or unsure.
4. build, in the front view and in the profile view, each part on its own against the physique: bust (for a man, the chest), waist, hips, buttocks, shoulders, legs. ${PART_RULE}
5. anatomy: assess hands, feet, joints, spine and back_arch across the depicted views. Answer wrong if any view shows a clear anatomical error in that category, right if there is enough visible evidence and no clear error, and unsure if the evidence is insufficient. A hidden hand is not a missing hand. glamour: does the pose depart from the requested neutral stance through exaggerated arching, twisting or presentation of the bust or hips? Judge the pose, not the character's body shape. yes or no.
6. medium: is it drawn in the rendering asked for? yes or no.

${ENDING}`,
  turns: `You check pictures that were each made from one reference picture to show the same person turned another way.

input.json holds pictures: the pictures' file names, each with its reference (a file in this folder) and the turn it was asked to show. Everything is in this folder and attached: the pictures in the order input.json lists them, then their references.

For each picture:
1. ${CLEAN}
2. single: one figure only, no panels, no one shown twice? yes or no. lettering: is there any writing, label, number or arrow in it? yes or no.
3. same_person: is it the same person as in its reference, by face, hair and build? yes, no or unsure.
4. turned: is she turned as asked, the whole body in the frame? yes, no or unsure.
5. build: each part against the same person in its reference, on its own: bust (for a man, the chest), waist, hips, buttocks, shoulders, legs: same; smaller or larger for a clear directional size difference; different for a visible difference that is not one of size, or conflicting directions; unsure when the evidence is insufficient; not_visible when the picture or its reference cannot show it.
6. outfit: the same clothes as in its reference? yes, no or unsure. medium: the same rendering as its reference? yes, no or unsure.
7. ${ANATOMY}

${ENDING}`,
};

// ---- The schemas ----

const YN: Schema = { type: 'string', enum: ['yes', 'no'] };
const YNU: Schema = { type: 'string', enum: ['yes', 'no', 'unsure'] };
const YPN: Schema = { type: 'string', enum: ['yes', 'partly', 'no'] };
const PRESENCE: Schema = { type: 'string', enum: ['present', 'absent', 'unsure'] };
const PART: Schema = { type: 'string', enum: ['matches', 'too_small', 'too_large', 'mismatch', 'unsure', 'not_visible'] };
const SAME: Schema = { type: 'string', enum: ['same', 'smaller', 'larger', 'different', 'unsure', 'not_visible'] };
const RWU: Schema = { type: 'string', enum: ['right', 'wrong', 'unsure'] };
const MIXUPS = ['wrong_person', 'swapped_looks', 'merged'];
const TAKES = ['rendering', 'backdrop', 'light', 'pose', 'clothes'] as const;
type Take = typeof TAKES[number];
const SHEET_PARTS = ['bust', 'waist', 'hips', 'buttocks', 'shoulders', 'legs'] as const;
const SHEET_LAYOUT = ['views', 'aligned', 'cropped', 'lettering', 'second_person'];
const SHEET_CONSISTENCY = ['face', 'hair', 'outfit', 'shape'];
const SHEET_ANATOMY = ['hands', 'feet', 'joints', 'spine', 'back_arch'];

type FramesInput = { scene: Omit<SceneWords, 'people'> & { people: (Omit<ScenePerson, 'person'> & { id: string; name: string })[] };
  people: (PersonWords & { id: string })[]; pictures: { name: string; medium: string }[] };
type IdentityInput = { references: { name: string; shows: string; compare: boolean }[]; pictures: { name: string; medium: string }[];
  scene: { setting: string; light: string; people: { id: string; name: string; role: string; place: string; clothes: string; action: string }[] } };
type FrontsInput = { people: (PersonWords & { id: string })[]; pictures: { name: string; person: string; medium: string }[] };
type SheetInput = SheetWords & { sheet: string };
type TurnsInput = { pictures: { name: string; reference: string; turn: string }[] };

function framesSchema(input: FramesInput, parts: Record<string, Part[]>): Schema {
  const pair = input.scene.people.length > 1;
  return strict({ pictures: each(input.pictures.map(one => one.name), strict({ clean: YN, medium: YPN, panels: YN, lettering: YN, anatomy: YNU,
    people: strict(Object.fromEntries(input.scene.people.map(one => [one.id, strict({ present: PRESENCE, looks: YNU, hair: YNU, clothes: YNU, facing: YNU, action: YNU,
      parts: each(parts[one.id], PART) })]))),
    ...(pair ? { mixups: each(MIXUPS, YNU) } : {}) })) });
}
const identitySchema = (input: IdentityInput): Schema => {
  const compared = input.references.filter(one => one.compare).map(one => one.name);
  return strict({ pictures: each(input.pictures.map(one => one.name), strict({ clean: YN,
    people: strict(Object.fromEntries(input.scene.people.map(one => [one.id, strict({ present: YNU, references: each(compared, each(['silhouette', 'face'], YNU)) })]))),
    takes: each(input.references.map(one => one.name), each([...TAKES], YNU)) })) });
};
const frontsSchema = (input: FrontsInput, parts: Record<string, Part[]>): Schema => strict({ pictures: strict(Object.fromEntries(input.pictures.map(one => [one.name,
  strict({ clean: YN, medium: YPN, front_view: YN, lettering: YN, anatomy: YNU, looks: YNU, parts: each(parts[one.person], PART) })]))) });
const sheetSchema = (): Schema => strict({ clean: YN, layout: each(SHEET_LAYOUT, YN), consistency: each(SHEET_CONSISTENCY, YNU),
  build: each(['front', 'profile'], each([...SHEET_PARTS], PART)), anatomy: each(SHEET_ANATOMY, RWU), glamour: YN, medium: YN });
const turnsSchema = (input: TurnsInput): Schema => strict({ pictures: each(input.pictures.map(one => one.name), strict({ clean: YN, single: YN, lettering: YN,
  same_person: YNU, turned: YNU, build: each([...SHEET_PARTS], SAME), outfit: YNU, medium: YNU, anatomy: YNU })) });
// The answers' form: the schema's keys, each value the choices it allows.
export const formOf = (schema: Schema): unknown => schema.enum ? schema.enum.join(' | ')
  : Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, formOf(value)]));

// What the questions are pinned to: the effort, each task, each kind's schema for a made-up bundle, and the judging
// texts and the stand's texts. The sha256 of this object is the questions' pin; a record holds one, and its models.
export function judgePins(): Record<string, string> {
  const person = { role: 'r', facing: 'f', place: 'p', clothes: 'c', action: 'a' };
  const scene = { shot: '', setting: '', objects: '', props: '', light: '', moment: '' };
  const frames: FramesInput = { scene: { ...scene, people: [{ id: 'mara', name: 'n', ...person }, { id: 'lina', name: 'n', ...person }] }, people: [],
    pictures: [{ name: 'pic-0.png', medium: 'm' }] };
  const schemas = { frames: framesSchema(frames, { mara: [...PARTS], lina: [...PARTS] }),
    identity: identitySchema({ references: [{ name: 'ref-0.png', shows: 's', compare: true }, { name: 'ref-1.png', shows: 's', compare: false }],
      pictures: [{ name: 'pic-0.png', medium: 'm' }], scene: { setting: '', light: '', people: [{ id: 'mara', name: 'n', role: '', place: '', clothes: '', action: '' }] } }),
    fronts: frontsSchema({ people: [], pictures: [{ name: 'pic-0.png', person: 'mara', medium: 'm' }] }, { mara: [...PARTS] }),
    sheet: sheetSchema(), turns: turnsSchema({ pictures: [{ name: 'pic-0.png', reference: 'ref-0.png', turn: 't' }] }) };
  return { effort: JUDGE.effort, judgeTexts: JUDGE_TEXTS_SHA256, standTexts: STAND_TEXTS_SHA256,
    ...Object.fromEntries(Object.entries(TASKS).map(([kind, text]) => [`task.${kind}`, sha256(text)])),
    ...Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [`schema.${kind}`, sha256(JSON.stringify(schema))])) };
}
export const questionsPin = () => sha256(JSON.stringify(judgePins()));

// ---- The bundles ----

type StandCell = { status: string; file?: string; sha256?: string; width?: number; height?: number; references?: string[]; start?: string };
// Which cell each picture of a session is, and each reference: kept in judge/keys/, never in a bundle.
export type SessionKey = { name: string; kind: Kind; group: string; rank: Rank; scene?: Scene; seed?: number; task: string; schema: string; input: string;
  pictures: { name: string; key: string; sha256: string }[]; references: { name: string; key: string; sha256: string; compare: boolean }[]; missing: string[] };
const keyOf = (dir: string, name: string) => join(dir, 'keys', `${name}.json`);
const answerOf = (dir: string, name: string) => join(dir, 'answers', `${name}.json`);
const SHOWS = { front: 'one woman, alone, full length from the front, on a plain grey backdrop',
  view: 'one woman, alone, full length, turned to one side, on a plain grey backdrop',
  crop: 'the head and shoulders of one woman, cut from the top of a picture of her standing on a plain grey backdrop',
  sheet: 'one woman on a character sheet: full-length views from the front, the side and the back, and two head-and-shoulders portraits' };
const showsOf = (key: string) => (key.startsWith('sheet:') ? SHOWS.sheet : key.startsWith('view:') ? SHOWS.view : key.startsWith('crop:') ? SHOWS.crop : SHOWS.front);

// A drawn picture as a bundle takes it: the very file cells.json records, at its size, without any text chunk; FC's
// crop is cut from its front here as ImageCrop cut it.
function drawn(run: string, cells: Record<string, StandCell>, key: string): { bytes: Uint8Array; sha256: string } | undefined {
  if (key === CROP_KEY) {
    const front = drawn(run, cells, CROP.from);
    const image = front && decodePng(front.bytes);
    if (!image || image.width !== CROP.width || (image.channels !== 3 && image.channels !== 4)) return undefined;
    const bytes = encodePng(CROP.width, CROP.height, image.pixels.subarray(0, CROP.width * CROP.height * image.channels), image.channels);
    return { bytes, sha256: sha256(bytes) };
  }
  const cell = cells[key];
  if (cell?.status !== 'drawn' || !cell.file) return undefined;
  const path = resolve(resolve(run), cell.file);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path), size = pngSize(bytes);
  if (sha256(bytes) !== cell.sha256 || size.width !== cell.width || size.height !== cell.height) throw new Refusal(`${key} is not the file cells.json recorded; no bundle is built from it`);
  return { bytes: stripPngMetadata(bytes), sha256: cell.sha256 };
}

// Every session's bundle, written once: its task, input, schema, form and pictures in judge/bundles/<name>/, and its
// key in judge/keys/. A cell the stand did not draw leaves its picture out and is listed as missing; a session left
// with no picture, or a turned picture without its reference, is not built.
export function writeBundles(run: string, log: (event: object) => void = () => undefined, from?: string) {
  const which = standOf(run);
  if (which === 3 || which === 4) return writeBundles34(run, which, log);
  if (which === 5) return writeBundles5(run, log);
  const texts = readTexts(run), dir = judgeDirOf(run), stand = which;
  const cells = (readJson<{ cells: Record<string, StandCell> }>(join(resolve(run), 'cells.json')) ?? { cells: {} }).cells;
  if (stand === 2) {
    // The first stand's pictures the second drew from, each one its cells used by its hash.
    const lentRun = resolve(from ?? join(resolve(run), '..', 'refs-stand'));
    if (standOf(lentRun) !== 1) throw new Refusal('--from is not the first refs stand');
    const lent = (readJson<{ cells: Record<string, StandCell> }>(join(lentRun, 'cells.json')) ?? { cells: {} }).cells;
    const used = new Set(Object.values(cells).flatMap(cell => cell.references ?? []));
    for (const key of [H_FRONT, VN_FRONT, viewKey('H-34R'), viewKey('H-PL')]) {
      const cell = lent[key];
      if (!cell?.file || !cell.sha256 || !used.has(cell.sha256)) throw new Refusal(`${key} in ${lentRun} is not a picture the second stand drew from`);
      cells[key] = { ...cell, file: join(lentRun, cell.file) };
    }
  }
  const counts = { sessions: 0, built: 0, kept: 0, skipped: 0, missing: [] as string[] };
  for (const sub of ['bundles', 'keys']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  for (const session of sessionPlan(stand)) {
    counts.sessions++;
    const { comparison: one } = session;
    if (existsSync(join(dir, 'bundles', session.name))) { counts.kept++; continue; }
    const missing: string[] = [];
    const take = (key: string, prefix: 'pic' | 'ref') => {
      const file = drawn(run, cells, key);
      if (!file) { missing.push(key); return undefined; }
      return { name: `${prefix}-${file.sha256.slice(0, 8)}.png`, key, ...file };
    };
    const pictures = one.pictures.flatMap(shown => { const file = take(shown.key, 'pic'); return file ? [{ shown, ...file }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));
    const pool = session.kind === 'frames' ? [] : [...one.references.map(key => ({ key, compare: true })), ...one.sources.map(key => ({ key, compare: false }))];
    const references = pool.flatMap(({ key, compare }) => { const file = take(key, 'ref'); return file ? [{ compare, ...file }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));
    counts.missing.push(...missing.filter(key => !counts.missing.includes(key)));
    const refName = (key: string | undefined) => references.find(file => file.key === key)?.name ?? '';
    const orphan = session.kind === 'turns' && pictures.some(file => !refName(file.shown.reference));
    if (!pictures.length || orphan || new Set([...pictures, ...references].map(file => file.name)).size !== pictures.length + references.length) {
      counts.skipped++;
      log({ event: 'bundle_skipped', session: session.name, missing: missing.length });
      continue;
    }
    const medium = (shown: Shown) => texts.media[shown.style ?? 'PORTRAIT'];
    let input: object, schema: Schema;
    if (session.kind === 'frames' || session.kind === 'identity') {
      const scene = texts.scenes[one.scene!];
      if (session.kind === 'frames') {
        const framesInput: FramesInput = { scene: { shot: scene.shot, setting: scene.setting, objects: scene.objects, props: scene.props, light: scene.light,
          moment: scene.moment, people: scene.people.map(person => ({ id: ID[person.person], name: texts.people[person.person].name, role: person.role,
            facing: person.facing, place: person.place, clothes: person.clothes, action: person.action })) },
          people: scene.people.map(person => ({ id: ID[person.person], ...texts.people[person.person] })),
          pictures: pictures.map(file => ({ name: file.name, medium: medium(file.shown) })) };
        input = framesInput;
        schema = framesSchema(framesInput, Object.fromEntries(scene.people.map(person => [ID[person.person], partsOf(texts, person.person)])));
      } else {
        const identityInput: IdentityInput = { references: references.map(file => ({ name: file.name, shows: showsOf(file.key), compare: file.compare })),
          pictures: pictures.map(file => ({ name: file.name, medium: medium(file.shown) })),
          scene: { setting: scene.setting, light: scene.light, people: scene.people.map(person => ({ id: ID[person.person], name: texts.people[person.person].name,
            role: person.role, place: person.place, clothes: person.clothes, action: person.action })) } };
        input = identityInput;
        schema = identitySchema(identityInput);
      }
    } else if (session.kind === 'fronts') {
      const who = [...new Set(one.pictures.map(shown => shown.person!))];
      const frontsInput: FrontsInput = { people: who.map(person => ({ id: ID[person], ...texts.people[person] })),
        pictures: pictures.map(file => ({ name: file.name, person: ID[file.shown.person!], medium: medium(file.shown) })) };
      input = frontsInput;
      schema = frontsSchema(frontsInput, Object.fromEntries(who.map(person => [ID[person], partsOf(texts, person)])));
    } else if (session.kind === 'sheet') {
      // SH, SH-words and SH-cfg1 of one build get the same specification, measurements included.
      const sheetInput: SheetInput = { sheet: pictures[0].name, ...texts.sheets[one.pictures[0].sheet!] };
      input = sheetInput;
      schema = sheetSchema();
    } else {
      const turnsInput: TurnsInput = { pictures: pictures.map(file => ({ name: file.name, reference: refName(file.shown.reference), turn: texts.turns[file.shown.turn!] })) };
      input = turnsInput;
      schema = turnsSchema(turnsInput);
    }
    const bundle = join(dir, 'bundles', session.name), task = TASKS[session.kind], inputText = JSON.stringify(input, null, 2);
    mkdirSync(bundle, { recursive: true, mode: 0o700 });
    writeFileSync(join(bundle, 'TASK.md'), task + '\n', { mode: 0o600 });
    writeFileSync(join(bundle, 'input.json'), inputText + '\n', { mode: 0o600 });
    writeJson(join(bundle, 'schema.json'), schema);
    writeJson(join(bundle, 'form.json'), formOf(schema));
    for (const file of [...pictures, ...references]) writeFileSync(join(bundle, file.name), file.bytes, { mode: 0o600 });
    const key: SessionKey = { name: session.name, kind: session.kind, group: one.group, rank: one.rank, ...(one.scene ? { scene: one.scene } : {}),
      ...(one.seed === undefined ? {} : { seed: one.seed }), task: sha256(task), schema: sha256(JSON.stringify(schema)), input: sha256(inputText),
      pictures: pictures.map(file => ({ name: file.name, key: file.key, sha256: file.sha256 })),
      references: references.map(file => ({ name: file.name, key: file.key, sha256: file.sha256, compare: file.compare })), missing };
    writeJson(keyOf(dir, session.name), key);
    counts.built++;
    log({ event: 'bundle_written', session: session.name, pictures: pictures.length, references: references.length, missing: missing.length });
  }
  return counts;
}
// The files a session is shown, attached in the order its input names them: the sheet or the pictures, then the
// references, then a turned picture's reference; in the third and fourth stands' bundles the pictures, then the draft,
// then the fronts, or the one front, then the faces cut from the fronts.
export function attachments(copy: string): string[] {
  const input = JSON.parse(readFileSync(join(copy, 'input.json'), 'utf8')) as { pictures?: { name: string; reference?: string }[]; references?: { name: string }[]; sheet?: string;
    draft?: string; fronts?: { name: string }[]; front?: string; faces?: { name: string }[] };
  const names = [...(input.sheet ? [input.sheet] : []), ...(input.pictures ?? []).map(one => one.name), ...(input.references ?? []).map(one => one.name),
    ...(input.pictures ?? []).flatMap(one => (one.reference ? [one.reference] : [])), ...(input.draft ? [input.draft] : []), ...(input.fronts ?? []).map(one => one.name),
    ...(input.front ? [input.front] : []), ...(input.faces ?? []).map(one => one.name)];
  return [...new Set(names)].map(name => join(copy, name));
}

// ---- The run ----

type Attempted = AttemptRecord & { codexFailed?: boolean };
export type SessionRecord = { name: string; kind: Kind; state?: 'answered' | 'failed'; attempts: Attempted[] };
// A record holds one judge's sessions: its model, the fallback it goes to after a refusal (none for a judge that is only
// compared), and the questions' pin.
export type JudgingRecord = { questions: string; model: string; fallback: string | null; effort: string; sessions: Record<string, SessionRecord>; stopped?: string };
const recordFile = (dir: string) => join(dir, 'judging.json');
function openRecord(dir: string, model: string = JUDGE.model, fallback: string | null = JUDGE.fallback, questions = questionsPin()): JudgingRecord {
  const record = readJson<JudgingRecord>(recordFile(dir)) ?? { questions, model, fallback, effort: JUDGE.effort, sessions: {} };
  if (record.questions !== questions) throw new Refusal(`${recordFile(dir)} was judged under other questions or texts; one record holds one set of pins`);
  if (record.model !== model || record.fallback !== fallback) throw new Refusal(`${recordFile(dir)} holds another judge's sessions`);
  return record;
}
// The next attempt's model: the judge first; after a report without any answers block, which is what a refusal gives,
// the fallback once, or nothing if there is none; after any other failure the judge once more; two attempts at most.
export function nextModel(attempts: AttemptRecord[], model: string = JUDGE.model, fallback: string | null = JUDGE.fallback): string | undefined {
  if (!attempts.length) return model;
  if (attempts.length > 1 || attempts[0].code === 'ok') return undefined;
  return attempts[0].code === 'no_block' ? fallback ?? undefined : model;
}
// codex itself failed, as against a judge that answered: no report at all, or the deadline.
const codexFailed = (read: Read) => read.code === 'no_report' || read.code === 'timeout';
// The judges a record may hold: the judge of record and its fallback, which is also judged alone to be compared.
const MODELS = [JUDGE.model, JUDGE.fallback] as string[];

// One judge's work on one stand: the stand's run, the record it writes (its judge/ by default), its bundles, the judge
// and its fallback, the ranks, and the attempts its record may hold in all.
export type Job = { run: string; dir?: string; bundles?: string; model?: string; fallback?: string | null; ranks?: readonly string[]; limit?: number };
export type RunOptions = { parallel?: number; until?: number; exec?: Exec; codex?: string; log?: (event: object) => void };
export type JudgeOptions = Job & RunOptions;
// Every bundled session of each job's ranks without answers and with an attempt left, `parallel` at a time in one
// queue: a job's sessions in the plan's order, and a later job's only while no earlier job has one ready. Two jobs may
// write one record, with one judge. A new attempt starts only while the attempts in its record and those running stay
// under its job's `limit`, while it could end by `until` at its deadline, and while no stop rule holds: two attempts in
// a row in which codex itself failed, or the fallback on more than a quarter of a record's sessions tried, once four
// have been, or, among the third and fourth stands' sessions, attempts that failed or refused in more than a tenth of
// the sessions planned; any stops every job. Running attempts end as they end; a record is saved after each of its
// attempts, and a new run resumes it.
export async function judgeJobs(jobs: Job[], options: RunOptions = {}): Promise<JudgingRecord[]> {
  const log = options.log ?? (() => undefined), records = new Map<string, JudgingRecord>();
  const open = jobs.map((job, index) => {
    const run = resolve(job.run), dir = resolve(job.dir ?? judgeDirOf(run)), bundles = job.bundles ?? join(judgeDirOf(run), 'bundles');
    const model = job.model ?? JUDGE.model, fallback = job.fallback === undefined ? JUDGE.fallback : job.fallback, stand = standOf(run);
    if (!MODELS.includes(model) || (fallback !== null && !MODELS.includes(fallback))) throw new Refusal('the stand is judged by codex\'s gpt-6-astra and JUDGE\'s fallback only');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let record = records.get(dir);
    if (!record) { record = openRecord(dir, model, fallback, pinOf(stand)); delete record.stopped; records.set(dir, record); }
    if (record.model !== model || record.fallback !== fallback) throw new Refusal('two jobs that write one record must name one judge');
    const ranks = job.ranks ?? ranksOf(stand);
    const plan = plannedSessions(stand).filter(one => ranks.includes(one.rank) && existsSync(join(bundles, one.name)));
    return { index, stand, dir, bundles, model, fallback, plan, limit: job.limit ?? 120, record };
  });
  type Open = typeof open[number];
  const save = (job: Open) => writeJson(recordFile(job.dir), job.record);
  const running = new Map<string, Open>(), promises = new Map<string, Promise<void>>();
  const inRecord = (job: Open) => sum(Object.values(job.record.sessions).map(one => one.attempts.length))
    + [...running.values()].filter(other => other.record === job.record).length;
  const ready = (job: Open, one: Planned) => {
    const known = job.record.sessions[one.name];
    return !running.has(`${job.dir}/${one.name}`) && !known?.state && nextModel(known?.attempts ?? [], job.model, job.fallback) !== undefined;
  };
  let streak = 0, stopped: string | undefined;
  const stopRule = () => {
    if (streak >= 2) return 'codex_failed_twice';
    for (const record of records.values()) {
      const tried = Object.values(record.sessions).filter(one => one.attempts.length);
      const fallen = tried.filter(one => one.attempts.some(attempt => attempt.model !== record.model)).length;
      if (tried.length >= 4 && fallen > tried.length / 4) return 'fallback_over_a_quarter';
    }
    const planned34 = [...new Map(open.filter(job => job.stand >= 3).flatMap(job => job.plan.map(one => [`${job.dir}/${one.name}`, { job, one }] as const))).values()];
    const bad = planned34.filter(({ job, one }) => job.record.sessions[one.name]?.attempts.some(attempt => attempt.code !== 'ok')).length;
    if (planned34.length && bad > planned34.length / 10) return 'failed_over_a_tenth';
    return undefined;
  };
  const attempt = async (job: Open, one: Planned) => {
    const entry = job.record.sessions[one.name] ??= { name: one.name, kind: one.kind, attempts: [] };
    const now = nextModel(entry.attempts, job.model, job.fallback)!, base = join(job.dir, 'sessions'), name = `${one.name}.${entry.attempts.length + 1}`;
    let read: Read = { code: 'no_report' }, exitCode = -1, ms = 0;
    try {
      const schema = JSON.parse(readFileSync(join(job.bundles, one.name, 'schema.json'), 'utf8')) as Schema;
      ({ read, exitCode, ms } = await runAttempt({ bundle: join(job.bundles, one.name), copy: join(base, name), report: join(base, `${name}.report.md`),
        events: join(base, `${name}.events.jsonl`), stderr: join(base, `${name}.stderr.log`), model: now, prompt: taskOf(job.stand, one.kind), images: attachments,
        validate: got => (got.code === 'ok' && !fitsSchema(got.value, schema) ? { code: 'schema' } : got), exec: options.exec, codex: options.codex }));
    } catch { /* recorded below as an attempt without a report */ }
    const failed = codexFailed(read);
    streak = failed ? streak + 1 : 0;
    entry.attempts.push({ model: now, code: read.code, ...(exitCode === 0 ? {} : { exitCode }), ms, ...(failed ? { codexFailed: true } : {}) });
    if (read.code === 'ok') {
      mkdirSync(join(job.dir, 'answers'), { recursive: true, mode: 0o700 });
      writeJson(answerOf(job.dir, one.name), read.value);
      entry.state = 'answered';
    } else if (nextModel(entry.attempts, job.model, job.fallback) === undefined) entry.state = 'failed';
    save(job);
    log({ event: 'session_done', stand: job.stand, job: job.index, session: one.name, attempt: entry.attempts.length, model: now, code: read.code, ms,
      ...(exitCode === 0 ? {} : { exitCode }), ...(entry.state ? { state: entry.state } : {}) });
  };
  for (;;) {
    const stop = stopped ? undefined : stopRule();
    if (stop) {
      stopped = stop;
      for (const job of open) { job.record.stopped = stop; save(job); }
      log({ event: 'judging_stopped', reason: stop });
    }
    while (!stopped && running.size < (options.parallel ?? 3)) {
      let next: [Open, Planned] | undefined;
      for (const job of open) {
        const one = job.plan.find(session => ready(job, session));
        if (!one) continue;
        if (inRecord(job) >= job.limit) { job.record.stopped ??= 'limit'; continue; }
        next = [job, one];
        break;
      }
      if (!next) break;
      if (options.until !== undefined && Date.now() + SESSION_MS > options.until) {
        for (const job of open) if (job.plan.some(session => ready(job, session))) job.record.stopped ??= 'until';
        break;
      }
      const [job, one] = next, id = `${job.dir}/${one.name}`;
      running.set(id, job);
      promises.set(id, attempt(job, one).finally(() => { running.delete(id); promises.delete(id); }));
    }
    if (!promises.size) break;
    await Promise.race(promises.values());
  }
  for (const job of open) {
    save(job);
    log({ event: 'judging_done', stand: job.stand, job: job.index, model: job.model, ...judgingCounts(job.record, job.plan.map(one => one.name)),
      ...(job.record.stopped ? { stopped: job.record.stopped } : {}) });
  }
  return open.map(job => job.record);
}
export const judgeStand = async (options: JudgeOptions): Promise<JudgingRecord> => (await judgeJobs([options], options))[0];
const sum = (values: (number | undefined)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
// The sessions by state, the attempts, the refusals (a report without an answers block), the fallback's attempts,
// the answers that did not fit, codex's own failures, and the median and total time of the answered attempts.
export function judgingCounts(record: JudgingRecord, names: string[] = Object.keys(record.sessions)) {
  const states: Record<string, number> = {};
  for (const name of names) {
    const known = record.sessions[name], state = known?.state ?? (known?.attempts.length ? 'retry' : 'pending');
    states[state] = (states[state] ?? 0) + 1;
  }
  const attempts = names.flatMap(name => record.sessions[name]?.attempts ?? []);
  const ms = attempts.filter(one => one.code === 'ok').map(one => one.ms).sort((a, b) => a - b);
  return { sessions: names.length, states, attempts: attempts.length, refusals: attempts.filter(one => one.code === 'no_block').length,
    fallback: attempts.filter(one => one.model !== record.model).length, invalid: attempts.filter(one => one.code === 'schema' || one.code === 'unparsed_block').length,
    codexFailed: attempts.filter(one => one.codexFailed).length, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : undefined, answeredMs: sum(ms) };
}
export const readRecord = (dir: string) => readJson<JudgingRecord>(recordFile(dir));

// ---- The dry run ----

// A stand-in for codex that answers every session with a valid form chosen at random from the schema, every picture
// clean, and the first attempt of the second session with no block at all, as a refusal would: no request leaves the
// computer. A field that may be null is null or its other type by turns (the prompt arms probe's places).
const sampleOf = (schema: Schema, random: () => number, name = ''): unknown => name === 'clean' ? 'yes'
  : schema.enum ? schema.enum[Math.floor(random() * schema.enum.length)]
    : Array.isArray(schema.type) ? (random() < 0.5 ? null : sampleOf({ ...schema, type: schema.type.find(type => type !== 'null') }, random, name))
    : schema.type === 'integer' ? Math.floor(random() * 4)
      : schema.type === 'array' ? Array.from({ length: Math.floor(random() * 3) }, () => sampleOf(schema.items!, random))
        : schema.type === 'string' ? 'a stand-in'
          : Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, sampleOf(value, random, key)]));
export function fakeCodex(seed = 1): Exec {
  let state = seed, calls = 0;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  return async (_command, args, { cwd }) => {
    calls++;
    const report = args[args.indexOf('-o') + 1];
    const schema = JSON.parse(readFileSync(join(cwd, 'schema.json'), 'utf8')) as Schema;
    const images = args.filter((_, at) => args[at - 1] === '-i');
    if (!images.length || images.some(image => !existsSync(image))) return 2;
    writeFileSync(report, calls === 2 ? 'I will not judge these pictures.\n' : `Judged.\n\n\`\`\`json\n${JSON.stringify(sampleOf(schema, random))}\n\`\`\`\n`);
    return 0;
  };
}
// The ranks the fallback judges alone, to be compared with the judge of record.
export const COMPARED: readonly string[] = ['A', 'FV'];
// A run's jobs when none are given: its judge of record on every session, and on the first stand the fallback alone
// on arm A and FV, to be compared.
export const defaultJobs = (run: string): Job[] => [{ run }, ...(standOf(run) === 1 ? [{ run, dir: join(judgeDirOf(run), 'sol'), model: JUDGE.fallback,
  fallback: null, ranks: COMPARED, limit: 60 }] : [])];
// The jobs judged by stand-ins in a scratch directory, in one queue as the real run goes, each record in a directory
// of its own; then each judge of record's answers scored, and each compared judge's answers set against the judge of
// record of its stand. It gives each record's counts and the time the real run is expected to take at `minutes` a
// session, `parallel` at a time.
export async function dryJudge(jobs: Job[], scratch: string, minutes: number, parallel = 3, log: (event: object) => void = () => undefined) {
  const dirs = new Map<string, string>();
  const scratchOf = (real: string, run: string) => {
    let dir = dirs.get(real);
    if (!dir) {
      dir = join(scratch, `r${dirs.size + 1}`);
      dirs.set(real, dir);
      cpSync(join(judgeDirOf(run), 'keys'), join(dir, 'keys'), { recursive: true });
    }
    return dir;
  };
  const moved = jobs.map(job => { const run = resolve(job.run); return { ...job, run, dir: scratchOf(resolve(job.dir ?? judgeDirOf(run)), run), bundles: job.bundles ?? join(judgeDirOf(run), 'bundles') }; });
  const records = await judgeJobs(moved, { parallel, exec: fakeCodex(), log });
  const out: object[] = [];
  let sessions = 0;
  for (const [real, dir] of dirs) {
    const index = moved.findIndex(job => job.dir === dir), job = moved[index], record = records[index], stand = standOf(job.run);
    const names = [...new Set(moved.filter(one => one.dir === dir).flatMap(one => plannedSessions(stand).filter(session => (one.ranks ?? ranksOf(stand)).includes(session.rank))
      .map(session => session.name)))];
    const counts = judgingCounts(record, names);
    sessions += counts.sessions;
    if (real === judgeDirOf(job.run)) {
      if (stand === 1) {
        const score = scoreStand(job.run, dir);
        writeFileSync(join(dir, 'score.md'), scoreTables(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, decisions: score.decisions.length, undecided: score.decisions.filter(one => one.verdict === 'undecided').length });
      } else if (stand === 5) {
        const score = scoreStand5(job.run, dir);
        writeFileSync(join(dir, 'score.md'), scoreTables5(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, judged: score.judged, decisions: score.decisions.length,
          undecided: score.decisions.filter(one => one.verdict === 'undecided').length });
      } else if (stand === 3 || stand === 4) {
        const score = scoreStand34(job.run, dir);
        writeFileSync(join(dir, 'score.md'), scoreTables34(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, judged: score.judged, decisions: score.decisions.length,
          undecided: score.decisions.filter(one => one.verdict === 'undecided').length });
      } else {
        const score = scoreStand2(dir);
        writeFileSync(join(dir, 'score.md'), scoreTables2(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, cells: score.cells.filter(cell => cell.judged).length });
      }
    } else {
      const first = dirs.get(judgeDirOf(job.run)), firstRecord = first ? readRecord(first) : undefined;
      if (stand === 5) {
        out.push({ stand, model: record.model, dir, ...counts });
        continue;
      }
      if (stand === 3 || stand === 4) {
        const agreement = first && firstRecord ? agreementOf34(job.run, first, dir) : undefined;
        if (agreement && firstRecord) writeFileSync(join(dir, 'agreement.md'), agreementTable34(agreement, firstRecord, record), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, agreementRows: agreement?.rows.length ?? 0 });
        continue;
      }
      const agreement = first && firstRecord ? agreementOf(first, dir) : [];
      if (firstRecord) writeFileSync(join(dir, 'agreement.md'), agreementTable(agreement, firstRecord, record), { mode: 0o600 });
      out.push({ stand, model: record.model, dir, ...counts, agreementRows: agreement.length });
    }
  }
  return { records: out, sessions, expectedMinutes: Math.ceil(sessions / parallel) * minutes, perSession: minutes, parallel };
}

// ---- The agreement ----

// Two judges' answers to the same bundles, question by question: how often they give the same answer, and how often
// the same reading of it (yes, matches, present or same against any other answer, and for anatomy no error against
// any other), with Cohen's kappa on the reading. A picture either calls not clean is left out.
type Ans = Record<string, unknown>;
const reading = (family: string, value: string) => (family.endsWith('.anatomy') ? value === 'no' : family.includes('.parts.') ? value === 'matches'
  : family.includes('.build.') ? value === 'same' : value === 'yes' || value === 'present');
export function agreementOf(first: string, second: string) {
  const names = existsSync(join(second, 'answers')) ? readdirSync(join(second, 'answers')).filter(name => name.endsWith('.json')).sort() : [];
  const pairs: { family: string; a: string; b: string }[] = [];
  const flat = (value: unknown, path: string[] = []): [string[], string][] => typeof value === 'string' ? [[path, value]]
    : Object.entries((value ?? {}) as Record<string, unknown>).flatMap(([key, inner]) => flat(inner, [...path, key]));
  for (const file of names) {
    const a = readJson<Ans>(join(first, 'answers', file)), b = readJson<Ans>(join(second, 'answers', file));
    if (!a || !b) continue;
    const kind = file.replace(/^j\d+-|\.json$/g, '');
    const theirs = new Map(flat(b).map(([path, value]) => [path.join('/'), value]));
    const clean = (answers: Ans, picture: string) => kind === 'sheet' ? answers.clean === 'yes' : ((answers.pictures as Record<string, Ans> | undefined)?.[picture]?.clean === 'yes');
    for (const [path, value] of flat(a)) {
      const other = theirs.get(path.join('/'));
      if (other === undefined || path[path.length - 1] === 'clean') continue;
      const picture = path[0] === 'pictures' ? path[1] : '';
      if (!clean(a, picture) || !clean(b, picture)) continue;
      // The question without the names of pictures, references and people: the kind, then the path's fields.
      const rest = (path[0] === 'pictures' ? path.slice(2) : path).filter(part => !/^(pic|ref)-[0-9a-f]{8}\.png$/.test(part) && !['people', 'references', 'mara', 'lina'].includes(part));
      pairs.push({ family: `${kind}.${rest.join('.')}`, a: value, b: other });
    }
  }
  return [...new Set(pairs.map(one => one.family))].sort().map(family => {
    const rows = pairs.filter(one => one.family === family), n = rows.length;
    const ra = rows.map(one => reading(family, one.a)), rb = rows.map(one => reading(family, one.b));
    const agree = ra.filter((value, index) => value === rb[index]).length;
    const pa = ra.filter(Boolean).length / n, pb = rb.filter(Boolean).length / n, expected = pa * pb + (1 - pa) * (1 - pb);
    return { family, n, exact: rows.filter(one => one.a === one.b).length / n, reading: agree / n, kappa: expected < 1 ? (agree / n - expected) / (1 - expected) : undefined,
      firstPositive: ra.filter(Boolean).length, secondPositive: rb.filter(Boolean).length };
  });
}
export type Agreement = ReturnType<typeof agreementOf>;
export function agreementTable(agreement: Agreement, first: JudgingRecord, second: JudgingRecord): string {
  const percent = (value: number | undefined) => (value === undefined ? '-' : `${Math.round(value * 100)}%`);
  const names = Object.keys(second.sessions).sort();
  const timing = (record: JudgingRecord) => {
    const counts = judgingCounts(record, names);
    return `${record.model}: ${counts.states.answered ?? 0} of ${counts.sessions} sessions answered in ${counts.attempts} attempts, refusals ${counts.refusals}, `
      + `answers that did not fit ${counts.invalid}, codex failures ${counts.codexFailed}, fallback attempts ${counts.fallback}, median ${counts.medianMs === undefined ? '-' : `${(counts.medianMs / 60000).toFixed(1)} min`} an answered session`;
  };
  return [`First: ${timing(first)}, on the same sessions.`, `Second: ${timing(second)}.`, '',
    'The reading is the one the score uses: yes, matches, present or same against any other answer, and for anatomy no error against any other.', '',
    '| question | pairs | same answer | same reading | kappa on the reading | first, read positive | second, read positive |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...agreement.map(one => `| ${one.family} | ${one.n} | ${percent(one.exact)} | ${percent(one.reading)} | ${one.kappa === undefined ? '-' : one.kappa.toFixed(2)} | ${one.firstPositive} | ${one.secondPositive} |`)]
    .join('\n') + '\n';
}

// ---- The score ----

type PersonFacts = { present: string; looks: string; hair: string; clothes: string; facing: string; action: string; parts: Record<string, string> };
type FrameFacts = { medium: string; panels: string; lettering: string; anatomy: string; people: Record<string, PersonFacts>; mixups?: Record<string, string> };
// Identity by reference key: each woman's slot against each reference compared, and the frame's resemblance to each
// reference shown.
type IdentityFacts = { people: Record<string, { present: string; references: Record<string, { silhouette: string; face: string }> }>; takes: Record<string, Record<Take, string>> };
type FrontFacts = { medium: string; front_view: string; lettering: string; anatomy: string; looks: string; parts: Record<string, string> };
type SheetFacts = { layout: Record<string, string>; consistency: Record<string, string>; build: Record<string, Record<string, string>>; anatomy: Record<string, string>;
  glamour: string; medium: string };
type TurnFacts = { single: string; lettering: string; same_person: string; turned: string; build: Record<string, string>; outfit: string; medium: string; anatomy: string };
type Facts = { frames: Map<string, FrameFacts>; identity: Map<string, IdentityFacts>; fronts: Map<string, FrontFacts>; sheets: Map<string, SheetFacts>;
  turns: Map<string, TurnFacts>; unclean: Set<string>; unjudged: string[]; sessions: { answered: number; planned: number } };

// The answers of every session, each picture under its cell's key and each reference under its own. A picture any
// judge calls not clean is left out everywhere: it counts as unjudged, and nothing else about it is read.
function readFacts(dir: string, keys = join(dir, 'keys')): Facts {
  const facts: Facts = { frames: new Map(), identity: new Map(), fronts: new Map(), sheets: new Map(), turns: new Map(), unclean: new Set(), unjudged: [],
    sessions: { answered: 0, planned: 0 } };
  const files = existsSync(keys) ? readdirSync(keys).filter(name => name.endsWith('.json')).sort() : [];
  const read: { key: SessionKey; answers: Ans }[] = [];
  for (const file of files) {
    const key = JSON.parse(readFileSync(join(keys, file), 'utf8')) as SessionKey;
    facts.sessions.planned++;
    const answers = readJson<Ans>(answerOf(dir, key.name));
    if (!answers) { facts.unjudged.push(...key.pictures.map(one => one.key)); continue; }
    facts.sessions.answered++;
    read.push({ key, answers });
    const pictures = (answers.pictures ?? {}) as Record<string, Ans>;
    if (key.kind === 'sheet') { if (answers.clean !== 'yes') facts.unclean.add(key.pictures[0].key); } else {
      for (const one of key.pictures) if (pictures[one.name]?.clean !== 'yes') facts.unclean.add(one.key);
    }
  }
  for (const { key, answers } of read) {
    const pictures = (answers.pictures ?? {}) as Record<string, Ans>;
    const refKey = new Map(key.references.map(one => [one.name, one.key]));
    const byKey = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).map(([name, value]) => [refKey.get(name)!, value]));
    for (const one of key.pictures) {
      if (facts.unclean.has(one.key)) continue;
      const got = key.kind === 'sheet' ? answers : pictures[one.name];
      if (key.kind === 'frames') facts.frames.set(one.key, got as unknown as FrameFacts);
      else if (key.kind === 'identity') {
        const people = got.people as Record<string, { present: string; references: Record<string, { silhouette: string; face: string }> }>;
        facts.identity.set(one.key, { people: Object.fromEntries(Object.entries(people).map(([id, value]) => [id, { present: value.present, references: byKey(value.references) }])),
          takes: byKey(got.takes as Record<string, Record<Take, string>>) });
      } else if (key.kind === 'fronts') facts.fronts.set(one.key, got as unknown as FrontFacts);
      else if (key.kind === 'sheet') facts.sheets.set(one.key, got as unknown as SheetFacts);
      else facts.turns.set(one.key, got as unknown as TurnFacts);
    }
  }
  return facts;
}

// A frame's own reference for a person, which its identity is read against: the picture it was drawn with (for W and
// L-now, which have none, the one their comparison sets them beside). In the pair every cell's is the person's
// portrait front, and X's is L's front though Mara's words and place are H's.
function ownReference(id: string, scene: Scene, person: string): string {
  if (person === 'lina') return L_FRONT;
  if (scene === 'K-pair') return H_FRONT;
  const style = /^[WR]-(FILM|SEMI|PENCIL|VN)$/.exec(id)?.[1];
  if (style) return frontKey(`H-${style}`);
  const own: Record<string, string> = { W: VN_FRONT, FC: VN_FRONT, 'C-VN': VN_FRONT, 'SF-sheet7': sheetKey('SH-H', 7), 'SF-sheet11': sheetKey('SH-H', 11),
    'SF-VN': sheetKey('SH-H', 7), QRF: frontKey('RF'), X: L_FRONT };
  return own[id] ?? H_FRONT;
}
// The pictures a frame was drawn from, whose resemblance answers are its own: none for W, W-X and L-now.
function sourcesOf(cell: string, scene: Scene): string[] {
  const pair = scene === 'K-pair', id = cell === 'FV-L0' ? 'FV' : cell === 'FC-L0' ? 'FC' : cell;
  if (['W', 'L-now'].includes(id) || id.startsWith('W-')) return [];
  if (id === 'FV') return scene === 'K-solo' ? [H_FRONT, viewKey('H-34R')] : scene === 'P' ? [H_FRONT, viewKey('H-PL')] : [H_FRONT, viewKey('H-34R'), L_FRONT, viewKey('L-34L')];
  if (id === 'FC') return [CROP_KEY];
  if (id === 'X') return [L_FRONT];
  const style = /^R-(FILM|SEMI|PENCIL|VN)$/.exec(id)?.[1];
  if (style) return [frontKey(`H-${style}`)];
  const own: Record<string, string[]> = { 'C-VN': [VN_FRONT], 'SF-sheet7': [sheetKey('SH-H', 7)], 'SF-sheet11': [sheetKey('SH-H', 11)], 'SF-VN': [sheetKey('SH-H', 7)],
    QRF: [frontKey('RF')] };
  return own[id] ?? (pair ? [H_FRONT, L_FRONT] : [H_FRONT]);
}
// One frame cell as the tables show it and the rules read it. A value is undefined where the cell was not judged.
type CellScore = { key: string; id: string; scene: Scene; seed: number; judged: boolean; parts?: number; of?: number; partsUnsure?: number; partsHidden?: number;
  partsLina?: number; ofLina?: number;
  silhouette?: number; face?: number; silhouetteLina?: number; faceLina?: number; anatomy?: number; medium?: string; sceneClothes?: string; sceneClothesLina?: string;
  looks?: string; hair?: string; hairLina?: string; action?: string; actionLina?: string; facing?: string; present?: string; apart?: boolean;
  takes: Take[]; dropped: Take[]; takesAny: Take[]; sources: number };
function cellScore(facts: Facts, id: string, scene: Scene, seed: number): CellScore {
  const key = frameKey(id, scene, seed), frame = facts.frames.get(key), identity = facts.identity.get(key), sources = sourcesOf(id, scene);
  const out: CellScore = { key, id, scene, seed, judged: !!frame && !!identity, takes: [], dropped: [], takesAny: [], sources: sources.length };
  const yes = (value: string | undefined) => (value === undefined ? undefined : value === 'yes' ? 1 : 0);
  const count = (parts: Record<string, string>) => Object.values(parts).filter(value => value === 'matches').length;
  if (frame) {
    const mara = frame.people.mara, lina = frame.people.lina;
    Object.assign(out, { parts: count(mara.parts), of: Object.keys(mara.parts).length, anatomy: frame.anatomy === 'no' ? 0 : 1, medium: frame.medium,
      partsUnsure: Object.values(mara.parts).filter(value => value === 'unsure').length, partsHidden: Object.values(mara.parts).filter(value => value === 'not_visible').length,
      sceneClothes: mara.clothes, looks: mara.looks, hair: mara.hair, action: mara.action, facing: mara.facing, present: mara.present });
    if (lina) {
      Object.assign(out, { partsLina: count(lina.parts), ofLina: Object.keys(lina.parts).length, sceneClothesLina: lina.clothes, hairLina: lina.hair, actionLina: lina.action });
      out.apart = mara.present === 'present' && lina.present === 'present' && Object.values(frame.mixups ?? {}).every(value => value === 'no');
    }
  }
  if (identity) {
    const mine = identity.people.mara?.references[ownReference(id, scene, 'mara')];
    out.silhouette = yes(mine?.silhouette);
    out.face = yes(mine?.face);
    if (scene === 'K-pair') { const hers = identity.people.lina?.references[L_FRONT]; out.silhouetteLina = yes(hers?.silhouette); out.faceLina = yes(hers?.face); }
    // Resemblance to the pictures the cell was drawn from; removal only where every one of them is an explicit no.
    out.takes = TAKES.filter(take => sources.some(source => identity.takes[source]?.[take] === 'yes'));
    out.dropped = sources.length ? TAKES.filter(take => sources.every(source => identity.takes[source]?.[take] === 'no')) : [];
    out.takesAny = TAKES.filter(take => Object.values(identity.takes).some(one => one[take] === 'yes'));
  }
  return out;
}

type Verdict = 'pays' | 'does not pay' | 'undecided';
export type Decision = { arm: string; rule: string; verdict: Verdict; why: string; cells: string[] };
const SOLO4: [Scene, number][] = [['K-solo', 7], ['K-solo', 11], ['P', 7], ['P', 11]];
const fraction = (cell: CellScore) => (cell.parts === undefined || !cell.of ? undefined : cell.parts / cell.of);
const one01 = (value: string | undefined) => (value === 'yes' ? 1 : 0);
type SheetScore = { key: string; judged: false } | { key: string; judged: true; consistency: number; build: number; holds: boolean; lettering: boolean;
  anatomyWrong: number; anatomyUnsure: number; glamour: boolean; medium: boolean; views: boolean; second: boolean; cropped: boolean; profileHips: string; profileButtocks: string };

// The score: each rule's verdict with the cells it read, and the tables the report shows. A difference counts only
// where it goes the same way at every scene and seed the rule names (qwen-refs' phase 1); a hidden part is never right;
// X keeps Y on a measure when it is nowhere below Y, and ties never establish a gain.
export function scoreStand(run: string, dir = judgeDirOf(run)) {
  const facts = readFacts(dir);
  const at = (id: string, pairs: [Scene, number][]) => pairs.map(([scene, seed]) => cellScore(facts, id, scene, seed));
  const missingOf = (...rows: CellScore[][]) => rows.flat().filter(cell => !cell.judged).map(cell => cell.key);
  const decisions: Decision[] = [];
  const decide = (arm: string, rule: string, rows: CellScore[][], verdict: () => [boolean, string], extra: string[] = []) => {
    const cells = [...rows.flat().map(cell => cell.key), ...extra], missing = missingOf(...rows);
    if (missing.length) { decisions.push({ arm, rule, verdict: 'undecided', why: `not judged: ${missing.join(', ')}`, cells }); return; }
    const [pays, why] = verdict();
    decisions.push({ arm, rule, verdict: pays ? 'pays' : 'does not pay', why, cells });
  };
  const everywhere = (a: CellScore[], b: CellScore[], test: (x: CellScore, y: CellScore) => boolean) => a.every((cell, index) => test(cell, b[index]));
  // X keeps Y on a measure: nowhere below it. X beats Y: more parts matching at every cell, the silhouette nowhere
  // below, and the anatomy-error indicator no worse at every cell.
  const keeps = (a: CellScore[], b: CellScore[], measure: (cell: CellScore) => number | undefined) => everywhere(a, b, (x, y) => measure(x)! >= measure(y)!);
  const beats = (a: CellScore[], b: CellScore[]) => everywhere(a, b, (x, y) => fraction(x)! > fraction(y)!) && keeps(a, b, cell => cell.silhouette)
    && everywhere(a, b, (x, y) => x.anatomy! <= y.anatomy!);
  const show = (row: CellScore[], measure: (cell: CellScore) => number | string | undefined) => row.map(cell => `${cell.scene} s${cell.seed} ${measure(cell)}`).join(', ');
  const parts = (cell: CellScore) => `${cell.parts}/${cell.of}`;
  const yesOf = (row: CellScore[], measure: (cell: CellScore) => number | undefined) => `${sum(row.map(measure))} of ${row.length}`;

  // Arm A (b), the wording: R against C-now. R is the tested wording closest to the bot's identity-only instruction;
  // the bot also keeps the full look words, which R omits, and C-now is round two's C, not the bot's frame of today.
  const cNow = at('C-now', SOLO4), r = at('R', SOLO4), cVN = at('C-VN', SOLO4), rVN = at('R-VN', SOLO4), w = at('W', SOLO4), fc = at('FC', SOLO4), fv = at('FV', SOLO4);
  decide('A', '(b) the wording: R holds VN, drops the pose, light and backdrop wherever C-now takes them (an explicit no), keeps C-now\'s face and parts matching', [cNow, r], () => {
    const holds = r.every(cell => cell.medium === 'yes');
    const dropped = (['pose', 'light', 'backdrop'] as const).map(take => ({ take, cNow: cNow.filter(cell => cell.takes.includes(take)).length,
      notDropped: cNow.filter((cell, index) => cell.takes.includes(take) && !r[index].dropped.includes(take)).length }));
    const drops = dropped.every(one => one.notDropped === 0), tested = dropped.some(one => one.cNow > 0);
    const face = keeps(r, cNow, cell => cell.face), proportions = keeps(r, cNow, fraction);
    return [holds && drops && tested && face && proportions, `R medium yes at ${r.filter(cell => cell.medium === 'yes').length} of 4; C-now took `
      + dropped.map(one => `${one.take} at ${one.cNow} of 4 (R not an explicit no at ${one.notDropped} of those)`).join(', ') + (tested ? '' : ', so nothing was there to drop')
      + `; face against H's front C-now ${yesOf(cNow, cell => cell.face)}, R ${yesOf(r, cell => cell.face)}${face ? '' : ' (below somewhere)'}`
      + `; parts matching C-now ${show(cNow, parts)}; R ${show(r, parts)}${proportions ? '' : ' (below somewhere)'}`];
  });
  decide('A', 'the face artifact: if R loses face to C-now at every cell while R-VN keeps C-VN\'s face, the loss is consistent with the reference\'s rendering or image (not proof that rendering alone caused it)', [cNow, r, cVN, rVN], () => {
    const lost = everywhere(r, cNow, (x, y) => x.face! < y.face!), kept = keeps(rVN, cVN, cell => cell.face);
    return [lost && kept, lost ? `R lost the face at every cell; R-VN ${kept ? 'kept' : 'did not keep'} C-VN's` : `R did not lose C-now's face at every cell (C-now ${yesOf(cNow, cell => cell.face)}, R ${yesOf(r, cell => cell.face)}): nothing to explain`];
  });
  decide('A', '(a) the front in the reader\'s style adds something: C-VN beats C-now and R-VN beats R', [cNow, cVN, r, rVN], () => {
    const c = beats(cVN, cNow), rr = beats(rVN, r);
    return [c && rr, `C-VN ${c ? 'beats' : 'does not beat'} C-now, R-VN ${rr ? 'beats' : 'does not beat'} R; parts C-now ${show(cNow, parts)}; C-VN ${show(cVN, parts)}; R ${show(r, parts)}; R-VN ${show(rVN, parts)}`];
  });
  decide('A', 'the face crop: FC keeps W\'s parts matching and its face against H\'s VN front is above W\'s at every cell', [w, fc], () => {
    const kept = keeps(fc, w, fraction), gained = everywhere(fc, w, (x, y) => x.face! > y.face!);
    return [kept && gained, `parts W ${show(w, parts)}; FC ${show(fc, parts)}${kept ? '' : ' (below somewhere)'}; face W ${yesOf(w, cell => cell.face)}, FC ${yesOf(fc, cell => cell.face)}${gained ? ', above W at every cell' : ''}`];
  });
  // FV, the owner's pose idea, by the rule the review set.
  const pairOf = (id: string) => at(id, [['K-pair', 7], ['K-pair', 11]]);
  decide('FV', 'FV pays: in K-solo and P at both seeds Mara is present with facing and action yes, FV has more parts matching than R, its silhouette and face against H\'s front are each no worse than R\'s and one is better, and its anatomy no worse; in K-pair at both seeds FV is apart with each woman\'s silhouette and face yes', [r, fv, pairOf('FV')], () => {
    const posed = fv.every(cell => cell.present === 'present' && cell.facing === 'yes' && cell.action === 'yes');
    const more = everywhere(fv, r, (x, y) => fraction(x)! > fraction(y)!);
    const identity = everywhere(fv, r, (x, y) => x.silhouette! >= y.silhouette! && x.face! >= y.face! && (x.silhouette! > y.silhouette! || x.face! > y.face!));
    const preserved = keeps(fv, r, cell => cell.silhouette) && keeps(fv, r, cell => cell.face);
    const anatomy = everywhere(fv, r, (x, y) => x.anatomy! <= y.anatomy!);
    const pair = pairOf('FV').every(cell => cell.apart && cell.silhouette === 1 && cell.face === 1 && cell.silhouetteLina === 1 && cell.faceLina === 1);
    const partial = (!identity && more && preserved && posed && anatomy ? ' Proportions improved; identity preserved; identity gain not demonstrated.' : '')
      + (posed ? '' : ' The requested turn failed somewhere: FV has not demonstrated the pose proposal.');
    return [posed && more && identity && anatomy && pair, `facing and action yes with Mara present at ${fv.filter(cell => cell.present === 'present' && cell.facing === 'yes' && cell.action === 'yes').length} of 4`
      + ` (R ${r.filter(cell => cell.present === 'present' && cell.facing === 'yes' && cell.action === 'yes').length}); parts R ${show(r, parts)}; FV ${show(fv, parts)}`
      + `; silhouette R ${yesOf(r, cell => cell.silhouette)}, FV ${yesOf(fv, cell => cell.silhouette)}; face R ${yesOf(r, cell => cell.face)}, FV ${yesOf(fv, cell => cell.face)}`
      + `; anatomy errors R ${sum(r.map(cell => cell.anatomy))}, FV ${sum(fv.map(cell => cell.anatomy))}; K-pair apart with both likenesses at ${pairOf('FV').filter(cell => cell.apart && cell.silhouette === 1 && cell.face === 1 && cell.silhouetteLina === 1 && cell.faceLina === 1).length} of 2.${partial}`];
  });

  // Arm B: the sheets.
  const sheetScore = (id: string, seed: number): SheetScore => {
    const key = sheetKey(id, seed), got = facts.sheets.get(key);
    if (!got) return { key, judged: false };
    const consistency = SHEET_CONSISTENCY.filter(name => got.consistency[name] === 'yes').length;
    const build = ['front', 'profile'].reduce((total, view) => total + SHEET_PARTS.filter(part => got.build[view]?.[part] === 'matches').length, 0);
    const layout = got.layout.views === 'yes' && got.layout.cropped === 'no' && got.layout.second_person === 'no';
    const front = ['bust', 'waist', 'hips'].every(part => got.build.front?.[part] === 'matches'), profile = ['bust', 'waist'].every(part => got.build.profile?.[part] === 'matches');
    return { key, judged: true, consistency, build, holds: layout && consistency === SHEET_CONSISTENCY.length && front && profile, lettering: got.layout.lettering === 'yes',
      anatomyWrong: SHEET_ANATOMY.filter(name => got.anatomy[name] === 'wrong').length, anatomyUnsure: SHEET_ANATOMY.filter(name => got.anatomy[name] === 'unsure').length,
      glamour: got.glamour === 'yes', medium: got.medium === 'yes', views: got.layout.views === 'yes', second: got.layout.second_person === 'yes', cropped: got.layout.cropped === 'yes',
      profileHips: got.build.profile?.hips ?? '-', profileButtocks: got.build.profile?.buttocks ?? '-' };
  };
  const sheetRows: SheetScore[] = [...SHEET_PEOPLE.map(who => `SH-${who}`), 'SH-words-H', 'SH-words-4', 'SH-cfg1-H', 'SH-cfg1-4'].flatMap(id => SEEDS.map(seed => sheetScore(id, seed)));
  const sheetOf = (id: string, seed: number) => sheetRows.find(row => row.key === sheetKey(id, seed))!;
  const sheetDecide = (rule: string, keys: string[], verdict: () => [boolean, string]) => {
    const missing = keys.filter(key => !sheetRows.find(row => row.key === key)?.judged);
    if (missing.length) { decisions.push({ arm: 'B', rule, verdict: 'undecided', why: `not judged: ${missing.join(', ')}`, cells: keys }); return; }
    const [pays, why] = verdict();
    decisions.push({ arm: 'B', rule, verdict: pays ? 'pays' : 'does not pay', why, cells: keys });
  };
  const holdsAt = (id: string) => SEEDS.filter(seed => { const row = sheetOf(id, seed); return row.judged && row.holds; });
  const sheetLine = (id: string) => SEEDS.map(seed => { const row = sheetOf(id, seed); return row.judged ? `s${seed} consistency ${row.consistency} of 4, build ${row.build} of 12, all views ${row.views ? 'yes' : 'no'}` : `s${seed} not judged`; }).join('; ');
  for (const who of SHEET_PEOPLE) {
    sheetDecide(`the build holds on SH-${who}: at one seed all views there, none cropped, no second person, every consistency answer yes, bust, waist and hips matching in front and bust and waist in profile`,
      SEEDS.map(seed => sheetKey(`SH-${who}`, seed)), () => [holdsAt(`SH-${who}`).length > 0,
        `holds at ${holdsAt(`SH-${who}`).map(seed => `s${seed}`).join(', ') || 'neither seed'}; ${sheetLine(`SH-${who}`)}`]);
  }
  sheetDecide('Qwen holds the extreme builds: H and cases 2 to 4 hold at as many seeds as case 1', SHEET_PEOPLE.flatMap(who => SEEDS.map(seed => sheetKey(`SH-${who}`, seed))), () => {
    const base = holdsAt('SH-1').length;
    return [base > 0 && ['H', '2', '3', '4'].every(who => holdsAt(`SH-${who}`).length >= base),
      `seeds held: ${SHEET_PEOPLE.map(who => `${who} ${holdsAt(`SH-${who}`).length}`).join(', ')}${base ? '' : '; case 1 held at neither seed, so the test says nothing'}`];
  });
  const pick = (() => {
    const [a, b] = SEEDS.map(seed => sheetOf('SH-H', seed));
    if (!a.judged || !b.judged) return 7;
    if (a.consistency !== b.consistency) return a.consistency > b.consistency ? 7 : 11;
    return a.build >= b.build ? 7 : 11;
  })();
  const sf = at(`SF-sheet${pick}`, SOLO4), qrf = at('QRF', SOLO4);
  decide('B', `the sheet format: SF (SF-sheet${pick}, from the picked sheet) beats QRF in P at both seeds and keeps its parts matching, silhouette and anatomy in K-solo at both seeds`, [sf, qrf], () => {
    const inP = beats(sf.slice(2), qrf.slice(2));
    const kSf = sf.slice(0, 2), kQ = qrf.slice(0, 2);
    const inK = keeps(kSf, kQ, fraction) && keeps(kSf, kQ, cell => cell.silhouette) && everywhere(kSf, kQ, (x, y) => x.anatomy! <= y.anatomy!);
    return [inP && inK, `picked seed ${pick}; parts SF ${show(sf, parts)}; QRF ${show(qrf, parts)}; silhouette against its own reference SF ${show(sf, cell => cell.silhouette)}; QRF ${show(qrf, cell => cell.silhouette)}`];
  }, SEEDS.map(seed => sheetKey('SH-H', seed)));
  const frontRow = (id: string) => SEEDS.map(seed => ({ key: frontKey(id, seed), seed, got: facts.fronts.get(frontKey(id, seed)) }));
  const frontParts = (got: FrontFacts | undefined) => (got ? Object.values(got.parts).filter(value => value === 'matches').length : undefined);
  {
    const rf = frontRow('RF'), pencil = frontRow('H-PENCIL'), keys = [...rf, ...pencil].map(one => one.key);
    const missing = [...rf, ...pencil].filter(one => !one.got).map(one => one.key);
    const rule = 'the recipe\'s words: RF has more parts matching than H\'s PENCIL front at both seeds, with its anatomy no worse at each';
    if (missing.length) decisions.push({ arm: 'B', rule, verdict: 'undecided', why: `not judged: ${missing.join(', ')}`, cells: keys });
    else {
      const better = rf.every((one, index) => frontParts(one.got)! > frontParts(pencil[index].got)!);
      const anatomy = rf.every((one, index) => (one.got!.anatomy === 'no' ? 0 : 1) <= (pencil[index].got!.anatomy === 'no' ? 0 : 1));
      decisions.push({ arm: 'B', rule, verdict: better && anatomy ? 'pays' : 'does not pay',
        why: `parts matching RF ${rf.map(one => `s${one.seed} ${frontParts(one.got)}`).join(', ')}; H-PENCIL ${pencil.map(one => `s${one.seed} ${frontParts(one.got)}`).join(', ')}`, cells: keys });
    }
  }
  const sheetBeats = (a: string, b: string, also: (row: SheetScore) => boolean = () => true) => ['H', '4'].every(who => SEEDS.every(seed => {
    const x = sheetOf(`${a}${who}`, seed), y = sheetOf(`${b}${who}`, seed);
    return x.judged && y.judged && x.build > y.build && x.consistency >= y.consistency && x.anatomyWrong <= y.anatomyWrong && x.anatomyUnsure <= y.anatomyUnsure && also(x);
  }));
  const pairKeys = (a: string, b: string) => ['H', '4'].flatMap(who => SEEDS.flatMap(seed => [sheetKey(`${a}${who}`, seed), sheetKey(`${b}${who}`, seed)]));
  const buildLine = (ids: string[]) => ids.map(id => `${id} ${SEEDS.map(seed => { const row = sheetOf(id, seed); return row.judged ? `s${seed} ${row.build}` : `s${seed} -`; }).join(' ')}`).join('; ');
  sheetDecide('CFG 2: SH beats SH-cfg1 for H and case 4 at both seeds (more build matches, no fewer consistency yes, no more anatomy wrong or unsure)', pairKeys('SH-', 'SH-cfg1-'),
    () => [sheetBeats('SH-', 'SH-cfg1-'), `build matches of 12: ${buildLine(['SH-H', 'SH-cfg1-H', 'SH-4', 'SH-cfg1-4'])}`]);
  sheetDecide('the numbers: SH beats SH-words on the build for H and case 4 at both seeds, without lettering', pairKeys('SH-', 'SH-words-'),
    () => [sheetBeats('SH-', 'SH-words-', row => row.judged && !row.lettering), `build matches of 12: ${buildLine(['SH-H', 'SH-words-H', 'SH-4', 'SH-words-4'])}; lettering on SH at `
      + (['H', '4'].flatMap(who => SEEDS.filter(seed => { const row = sheetOf(`SH-${who}`, seed); return row.judged && row.lettering; }).map(seed => `${who} s${seed}`)).join(', ') || 'none')]);

  // Arm C: one shared style.
  const styles = ['VN', 'FILM', 'SEMI', 'PENCIL'].map(style => {
    const fronts = frontRow(`H-${style}`), wCells = at(style === 'VN' ? 'W' : `W-${style}`, SOLO4), rCells = at(`R-${style}`, SOLO4);
    const framesJudged = [...wCells, ...rCells].filter(cell => cell.judged), frontsJudged = fronts.filter(one => one.got);
    const matches = sum(framesJudged.map(cell => cell.parts)) + sum(frontsJudged.map(one => frontParts(one.got)));
    const possible = sum(framesJudged.map(cell => cell.of)) + frontsJudged.length * PARTS.length;
    const anatomy = sum(framesJudged.map(cell => cell.anatomy)) + frontsJudged.filter(one => one.got!.anatomy !== 'no').length;
    return { style, pictures: framesJudged.length + frontsJudged.length, matches, possible, rate: possible ? matches / possible : 0, anatomy,
      identity: sum(framesJudged.map(cell => cell.silhouette)), missing: [...missingOf(wCells, rCells), ...fronts.filter(one => !one.got).map(one => one.key)],
      cells: [...fronts.map(one => one.key), ...wCells.map(cell => cell.key), ...rCells.map(cell => cell.key)] };
  });
  {
    const fewest = Math.min(...styles.map(one => one.anatomy / Math.max(1, one.pictures)));
    const inRace = styles.filter(one => one.pictures && (one.anatomy / one.pictures - fewest) * 10 < 2);
    const ranked = [...inRace].sort((a, b) => b.rate - a.rate || a.anatomy - b.anatomy || b.identity - a.identity);
    const missing = styles.flatMap(one => one.missing);
    decisions.push({ arm: 'C', rule: 'one shared style: the most parts matching over its fronts, W and R cells, then the fewest anatomy errors, then silhouette; a style whose share of pictures with an anatomy error is 20 points or more above the best style\'s is out',
      verdict: missing.length ? 'undecided' : ranked.length ? 'pays' : 'does not pay',
      why: `${ranked[0] ? `winner ${ranked[0].style}; ` : ''}` + styles.map(one => `${one.style} ${one.matches} of ${one.possible} parts matching over ${one.pictures} pictures, anatomy errors ${one.anatomy}, silhouette ${one.identity} of 8`
        + (inRace.includes(one) ? '' : ' (out on anatomy)')).join('; ') + (missing.length ? `; not judged: ${missing.join(', ')}` : ''),
      cells: styles.flatMap(one => one.cells) });
  }

  // Arm D: the phase-1 rules.
  const KS: [Scene, number][] = [['K-solo', 7], ['K-solo', 11], ['K-pair', 7], ['K-pair', 11]], K1: [Scene, number][] = [['K-solo', 7], ['K-solo', 11]];
  const q = at('Q', KS), x = at('X', K1), rough = at('Rough', KS), wKS = at('W', KS);
  decide('D', 'the references carry the build: Q\'s silhouette against H\'s front yes solo and pair at both seeds, and X\'s against L\'s front yes and against H\'s front no at both seeds', [q, x], () => {
    const xH = x.map(cell => (facts.identity.get(cell.key)?.people.mara?.references[H_FRONT]?.silhouette === 'no' ? 0 : 1));
    const carried = q.every(cell => cell.silhouette === 1) && x.every(cell => cell.silhouette === 1) && xH.every(value => value === 0);
    return [carried, `Q silhouette against H's front ${show(q, cell => cell.silhouette)}; X against L's front ${show(x, cell => cell.silhouette)}; X against H's front not an explicit no at ${sum(xH)} of 2`];
  });
  decide('D', 'the owner\'s rough words: per woman, at K-solo and K-pair at both seeds, Rough keeps W\'s and Q\'s parts matching and Q\'s hair, face and action (yes 1, no or unsure 0)', [rough, wKS, q], () => {
    const mara = keeps(rough, wKS, fraction) && keeps(rough, q, fraction) && keeps(rough, q, cell => one01(cell.hair)) && keeps(rough, q, cell => cell.face) && keeps(rough, q, cell => one01(cell.action));
    const pair = [2, 3], lina = (cell: CellScore) => (cell.partsLina === undefined || !cell.ofLina ? undefined : cell.partsLina / cell.ofLina);
    const rp = pair.map(index => rough[index]), wp = pair.map(index => wKS[index]), qp = pair.map(index => q[index]);
    const linaKept = keeps(rp, wp, lina) && keeps(rp, qp, lina) && keeps(rp, qp, cell => one01(cell.hairLina)) && keeps(rp, qp, cell => cell.faceLina) && keeps(rp, qp, cell => one01(cell.actionLina));
    return [mara && linaKept, `Mara ${mara ? 'kept' : 'not kept'}, Lina ${linaKept ? 'kept' : 'not kept'}; parts Rough ${show(rough, parts)}; W ${show(wKS, parts)}; Q ${show(q, parts)}; `
      + `face Rough ${yesOf(rough, cell => cell.face)}, Q ${yesOf(q, cell => cell.face)}; hair Rough ${yesOf(rough, cell => one01(cell.hair))}, Q ${yesOf(q, cell => one01(cell.hair))}`];
  });
  decide('D', 'naming and order: in K-pair at both seeds, Naming and Order are apart, each woman\'s silhouette yes against her own front', [pairOf('Naming'), pairOf('Order')], () => {
    const ok = (cells: CellScore[]) => cells.every(cell => cell.apart && cell.silhouette === 1 && cell.silhouetteLina === 1);
    return [ok(pairOf('Naming')) && ok(pairOf('Order')), ['Q', 'Naming', 'Order', 'Rough', 'L-now'].map(id => `${id} apart ${pairOf(id).filter(cell => cell.apart).length} of 2, `
      + `silhouettes Mara/Lina ${pairOf(id).map(cell => `${cell.silhouette ?? '-'}/${cell.silhouetteLina ?? '-'}`).join(' ')}`).join('; ')];
  });

  // The tables: every frame cell by arm, what the frames resemble in the pictures they were drawn from (the clothes
  // above all: the live tester's grey suit), the fronts, the sheets and the turned pictures.
  const ARM_CELLS: Record<string, [string, Scene[]][]> = {
    A: [['C-now', ['K-solo', 'P', 'K-pair']], ['R', ['K-solo', 'P', 'K-pair']], ['W', ['K-solo', 'P', 'K-pair']], ['FC', ['K-solo', 'P']], ['C-VN', ['K-solo', 'P']], ['R-VN', ['K-solo', 'P']]],
    FV: [['FV', ['K-solo', 'P', 'K-pair']]],
    B: [['SF-sheet7', ['K-solo', 'P']], ['SF-sheet11', ['K-solo', 'P']], ['QRF', ['K-solo', 'P']], ['SF-VN', ['K-solo', 'P']]],
    C: ['FILM', 'SEMI', 'PENCIL'].flatMap(style => [[`W-${style}`, ['K-solo', 'P']], [`R-${style}`, ['K-solo', 'P']]] as [string, Scene[]][]),
    D: [['Q', ['K-solo', 'K-pair']], ['X', ['K-solo']], ['Rough', ['K-solo', 'K-pair']], ['Naming', ['K-pair']], ['Order', ['K-pair']], ['L-now', ['K-pair']]],
  };
  const cellsOf = (arm: string) => ARM_CELLS[arm].flatMap(([id, scenes]) => scenes.flatMap(scene => SEEDS.map(seed => cellScore(facts, id, scene, seed))));
  const takes = Object.values(ARM_CELLS).flat().map(([id, scenes]) => {
    const cells = scenes.flatMap(scene => SEEDS.map(seed => cellScore(facts, id, scene, seed))).filter(cell => cell.judged);
    const own = Object.fromEntries(TAKES.map(take => [take, cells.filter(cell => cell.takes.includes(take)).length])) as Record<Take, number>;
    return { id, judged: cells.length, own, clothesAny: cells.filter(cell => cell.takesAny.includes('clothes')).length, sources: cells[0]?.sources ?? sourcesOf(id, scenes[0]).length,
      sceneClothesNo: cells.filter(cell => cell.sceneClothes !== 'yes' || (cell.sceneClothesLina !== undefined && cell.sceneClothesLina !== 'yes')).length };
  });
  const turns = [...['H-34R', 'H-PL', 'L-34L'].map(id => viewKey(id)), ...SHEET_PEOPLE.flatMap(who => SEEDS.map(seed => frameKey(`VIEW-${who}`, undefined, seed)))]
    .map(key => ({ key, got: facts.turns.get(key) }));
  const fronts = ['H-PORTRAIT', 'L-PORTRAIT', 'H-VN', 'H-FILM', 'H-SEMI', 'H-PENCIL', 'RF'].flatMap(frontRow);
  return { questions: questionsPin(), sessions: facts.sessions, unclean: [...facts.unclean], unjudged: [...new Set(facts.unjudged)].filter(key => !facts.unclean.has(key)),
    decisions, pick, styles, sheetRows, takes,
    fronts: fronts.map(one => ({ key: one.key, judged: !!one.got, parts: frontParts(one.got), of: one.got ? Object.keys(one.got.parts).length : undefined,
      looks: one.got?.looks, anatomy: one.got?.anatomy, medium: one.got?.medium, frontView: one.got?.front_view, lettering: one.got?.lettering })),
    turns: turns.map(one => ({ key: one.key, judged: !!one.got, samePerson: one.got?.same_person, turned: one.got?.turned, single: one.got?.single,
      buildSame: one.got ? SHEET_PARTS.filter(part => one.got!.build[part] === 'same').length : undefined, outfit: one.got?.outfit, medium: one.got?.medium, anatomy: one.got?.anatomy })),
    arms: Object.fromEntries(Object.keys(ARM_CELLS).map(arm => [arm, cellsOf(arm)])) as Record<string, CellScore[]> };
}
export type Score = ReturnType<typeof scoreStand>;

// The score as the report's tables, in Markdown.
export function scoreTables(score: Score): string {
  const lines: string[] = [];
  const row = (cells: (string | number | undefined)[]) => lines.push(`| ${cells.map(cell => (cell === undefined ? '-' : String(cell))).join(' | ')} |`);
  const head = (cells: string[]) => { row(cells); row(cells.map(() => '---')); };
  const yn = (value: number | undefined) => (value === undefined ? undefined : value ? 'yes' : 'no');
  const short = (key: string) => key.replace(/^(frame|front|sheet|view):/, '');
  lines.push(`Questions ${score.questions}; sessions answered ${score.sessions.answered} of ${score.sessions.planned}; pictures not clean ${score.unclean.length}; cells unjudged ${score.unjudged.length}.`, '');
  for (const arm of RANKS) {
    lines.push(`### Arm ${arm}`, '');
    head(['rule', 'verdict', 'evidence']);
    for (const one of score.decisions.filter(decision => decision.arm === arm)) row([one.rule, one.verdict, one.why]);
    lines.push('');
    const cells = score.arms[arm] ?? [];
    if (!cells.length) continue;
    head(['cell', 'scene', 'seed', 'parts matching', 'parts unsure / not visible', 'silhouette', 'face', 'anatomy error', 'medium', 'facing', 'action', 'hair', 'scene clothes', 'resembles its sources in', 'pair apart', 'Lina parts', 'Lina silhouette', 'Lina face']);
    for (const cell of cells) {
      if (!cell.judged) { row([cell.id, cell.scene, cell.seed, 'not judged']); continue; }
      row([cell.id, cell.scene, cell.seed, `${cell.parts}/${cell.of}`, `${cell.partsUnsure} / ${cell.partsHidden}`, yn(cell.silhouette), yn(cell.face), yn(cell.anatomy), cell.medium, cell.facing, cell.action, cell.hair,
        cell.sceneClothes, cell.sources ? cell.takes.join(', ') || 'nothing' : 'no source', cell.apart === undefined ? undefined : cell.apart ? 'yes' : 'no',
        cell.partsLina === undefined ? undefined : `${cell.partsLina}/${cell.ofLina}`, yn(cell.silhouetteLina), yn(cell.faceLina)]);
    }
    lines.push('');
  }
  lines.push('### What the frames resemble in the pictures they were drawn from', '');
  head(['cell', 'frames judged', 'sources', 'clothes', 'pose', 'light', 'backdrop', 'rendering', 'clothes of any reference shown', 'scene clothes not worn']);
  for (const one of score.takes) row([one.id, one.judged, one.sources, one.own.clothes, one.own.pose, one.own.light, one.own.backdrop, one.own.rendering, one.clothesAny, one.sceneClothesNo]);
  lines.push('', '### Fronts', '');
  head(['front', 'parts matching', 'looks', 'anatomy error', 'medium', 'front view', 'lettering']);
  for (const one of score.fronts) row(one.judged ? [short(one.key), `${one.parts}/${one.of}`, one.looks, one.anatomy, one.medium, one.frontView, one.lettering] : [short(one.key), 'not judged']);
  lines.push('', '### Sheets', '');
  head(['sheet', 'consistency of 4', 'build matches of 12', 'holds', 'all views', 'cropped', 'lettering', 'second person', 'anatomy wrong of 5', 'anatomy unsure', 'profile hips', 'profile buttocks', 'glamour', 'medium']);
  for (const one of score.sheetRows) {
    if (!one.judged) { row([short(one.key), 'not judged']); continue; }
    row([short(one.key), one.consistency, one.build, one.holds ? 'yes' : 'no', one.views ? 'yes' : 'no', one.cropped ? 'yes' : 'no', one.lettering ? 'yes' : 'no', one.second ? 'yes' : 'no',
      one.anatomyWrong, one.anatomyUnsure, one.profileHips, one.profileButtocks, one.glamour ? 'yes' : 'no', one.medium ? 'yes' : 'no']);
  }
  lines.push('', '### Turned pictures (FV\'s views and VIEW)', '');
  head(['picture', 'same person', 'turned', 'single', 'build parts the same of 6', 'outfit', 'medium', 'anatomy error']);
  for (const one of score.turns) row(one.judged ? [short(one.key), one.samePerson, one.turned, one.single, one.buildSame, one.outfit, one.medium, one.anatomy] : [short(one.key), 'not judged']);
  lines.push('', '### The styles', '');
  head(['style', 'pictures judged of 10', 'parts matching', 'anatomy errors', 'silhouette of 8']);
  for (const one of score.styles) row([one.style, one.pictures, `${one.matches}/${one.possible}`, one.anatomy, one.identity]);
  return lines.join('\n') + '\n';
}

// ---- The second stand's score ----

// The parts in which a heavier figure shows: a build, waist, arms or legs answered too_large.
const WEIGHT_PARTS = ['build', 'waist', 'arms', 'legs'];
const SCENES_2: Scene[] = ['K-solo', 'P'];
// The second stand's answers as the tester's three complaints ask them, seed by seed: the negative at CFG 2 against the
// same texts without it, the look with weight anchors against H's look, and how often each cell's frames wear the
// clothes of a picture it was drawn from. No rule decides here: the tables give each seed, and the counts.
export function scoreStand2(dir: string) {
  const facts = readFacts(dir);
  const cellOf = (id: string, scene: Scene, seed: number) => {
    const base = cellScore(facts, id, scene, seed), frame = facts.frames.get(base.key), identity = facts.identity.get(base.key);
    const values = frame?.people.mara?.parts ?? {};
    return { ...base, values, anatomyValue: frame?.anatomy, heavier: frame ? WEIGHT_PARTS.filter(part => values[part] === 'too_large').length : undefined,
      tooLarge: frame ? Object.values(values).filter(value => value === 'too_large').length : undefined, suit: identity?.takes[H_FRONT]?.clothes,
      unsure: Object.values(values).filter(value => value === 'unsure').length, hidden: Object.values(values).filter(value => value === 'not_visible').length };
  };
  type Cell2 = ReturnType<typeof cellOf>;
  const cells = CELLS_2.flatMap(id => SCENES_2.flatMap(scene => SEEDS_2.map(seed => cellOf(id, scene, seed))));
  const get = (id: string, scene: Scene, seed: number) => cells.find(one => one.id === id && one.scene === scene && one.seed === seed)!;
  const grid = (id: string) => SCENES_2.flatMap(scene => SEEDS_2.map(seed => get(id, scene, seed)));
  // Seeds at which `b` is better, the same or worse than `a` on a measure (lower is better where `lower`), over the seeds
  // both were judged at.
  const versus = (a: Cell2[], b: Cell2[], measure: (cell: Cell2) => number | undefined, lower: boolean) => {
    const pairs = a.map((cell, index) => [measure(cell), measure(b[index])]).filter(([x, y]) => x !== undefined && y !== undefined) as [number, number][];
    const better = pairs.filter(([x, y]) => (lower ? y < x : y > x)).length, worse = pairs.filter(([x, y]) => (lower ? y > x : y < x)).length;
    return { seeds: pairs.length, better, same: pairs.length - better - worse, worse, a: sum(pairs.map(([x]) => x)), b: sum(pairs.map(([, y]) => y)) };
  };
  const yes = (value: string | undefined) => (value === undefined ? undefined : value === 'yes' ? 1 : 0);
  const MEASURES_1: [string, (cell: Cell2) => number | undefined, boolean][] = [
    ['clothes like H\'s front (the suit): yes', cell => yes(cell.suit), true],
    ['heavier: build, waist, arms or legs too_large', cell => cell.heavier, true],
    ['broken body: anatomy error yes', cell => yes(cell.anatomyValue), true],
    ['anatomy unsure', cell => (cell.anatomyValue === undefined ? undefined : cell.anatomyValue === 'unsure' ? 1 : 0), true],
    ['parts matching of 9', cell => cell.parts, false],
    ['the scene\'s clothes worn: yes', cell => yes(cell.sceneClothes), false],
    ['silhouette like H\'s front: yes', cell => cell.silhouette, false]];
  const complaint1 = [['R-L0', 'R-L0-NEG'], ['W-L0', 'W-L0-NEG']].map(([a, b]) => ({ a, b,
    measures: MEASURES_1.map(([name, measure, lower]) => ({ name, lower, ...versus(grid(a), grid(b), measure, lower) })) }));
  const spread = (values: number[]) => {
    if (!values.length) return { n: 0 };
    const mean = sum(values) / values.length, sd = Math.sqrt(sum(values.map(value => (value - mean) ** 2)) / values.length);
    return { n: values.length, mean, sd, min: Math.min(...values), max: Math.max(...values) };
  };
  const judgedOf = (row: Cell2[]) => row.filter(cell => cell.judged);
  const complaint2 = ['R', 'W'].flatMap(arm => ['L0', 'L1'].flatMap(look => [...SCENES_2.map(scene => [scene]), SCENES_2].map(scenes => {
    const id = `${arm}-${look}`, row = judgedOf(scenes.flatMap(scene => SEEDS_2.map(seed => get(id, scene, seed))));
    return { id, scenes: scenes.join(' and '), parts: spread(row.map(cell => cell.parts!)), heavier: spread(row.map(cell => cell.heavier!)),
      seeds: row.map(cell => `${cell.scene === 'K-solo' ? 'K' : 'P'}${cell.seed} ${cell.parts}${cell.heavier ? `+${cell.heavier}` : ''}`),
      silhouette: sum(row.map(cell => cell.silhouette)), face: sum(row.map(cell => cell.face)), build: row.map(cell => cell.values.build ?? '-') };
  })));
  const looks = ['R', 'W'].map(arm => ({ arm, parts: versus(grid(`${arm}-L0`), grid(`${arm}-L1`), cell => cell.parts, false),
    heavier: versus(grid(`${arm}-L0`), grid(`${arm}-L1`), cell => cell.heavier, true), silhouette: versus(grid(`${arm}-L0`), grid(`${arm}-L1`), cell => cell.silhouette, false) }));
  const complaint3 = CELLS_2.map(id => {
    const row = judgedOf(grid(id));
    const count = (test: (cell: Cell2) => boolean) => SCENES_2.map(scene => row.filter(cell => cell.scene === scene && test(cell)).length);
    return { id, judged: count(() => true), sources: row[0]?.sources ?? sourcesOf(id, 'K-solo').length, ownClothes: count(cell => cell.takes.includes('clothes')),
      frontClothes: count(cell => cell.suit === 'yes'), frontUnsure: count(cell => cell.suit === 'unsure'), anyClothes: count(cell => cell.takesAny.includes('clothes')),
      ownPose: count(cell => cell.takes.includes('pose')), ownBackdrop: count(cell => cell.takes.includes('backdrop')), ownLight: count(cell => cell.takes.includes('light')),
      sceneClothesNot: count(cell => cell.sceneClothes !== 'yes') };
  });
  return { questions: questionsPin(), sessions: facts.sessions, unclean: [...facts.unclean], unjudged: [...new Set(facts.unjudged)].filter(key => !facts.unclean.has(key)),
    complaint1, complaint2, looks, complaint3, cells };
}
export type Score2 = ReturnType<typeof scoreStand2>;

export function scoreTables2(score: Score2): string {
  const lines: string[] = [];
  const row = (cells: (string | number | undefined)[]) => lines.push(`| ${cells.map(cell => (cell === undefined ? '-' : String(cell))).join(' | ')} |`);
  const head = (cells: string[]) => { row(cells); row(cells.map(() => '---')); };
  const fixed = (value: number | undefined) => (value === undefined ? '-' : value.toFixed(2));
  const pair = (a: string | number | undefined, b: string | number | undefined) => `${a ?? '-'} → ${b ?? '-'}`;
  lines.push(`Questions ${score.questions}; sessions answered ${score.sessions.answered} of ${score.sessions.planned}; pictures not clean ${score.unclean.length}; cells unjudged ${score.unjudged.length}.`, '');
  lines.push('### 1. The negative at CFG 2, seed by seed', '');
  for (const one of score.complaint1) {
    lines.push(`${one.a} → ${one.b}:`, '');
    head(['scene', 'seed', 'clothes like H\'s front', 'heavier parts', 'build', 'anatomy error', 'parts matching', 'scene clothes', 'silhouette']);
    for (const scene of SCENES_2) for (const seed of SEEDS_2) {
      const a = score.cells.find(cell => cell.id === one.a && cell.scene === scene && cell.seed === seed)!, b = score.cells.find(cell => cell.id === one.b && cell.scene === scene && cell.seed === seed)!;
      row([scene, seed, pair(a.suit, b.suit), pair(a.heavier, b.heavier), pair(a.values.build, b.values.build), pair(a.anatomyValue, b.anatomyValue),
        pair(a.parts, b.parts), pair(a.sceneClothes, b.sceneClothes), pair(a.silhouette === undefined ? undefined : a.silhouette ? 'yes' : 'no', b.silhouette === undefined ? undefined : b.silhouette ? 'yes' : 'no')]);
    }
    lines.push('');
    head(['measure', `${one.a} in all`, `${one.b} in all`, 'seeds judged', `${one.b} better`, 'same', 'worse']);
    for (const measure of one.measures) row([measure.name, measure.a, measure.b, measure.seeds, measure.better, measure.same, measure.worse]);
    lines.push('');
  }
  lines.push('### 2. The look across the six seeds', '', 'Parts matching of 9 at each seed (K or P and the seed; +n where n of build, waist, arms and legs are too_large).', '');
  head(['cell', 'scenes', 'seeds', 'parts matching: mean', 'SD', 'min–max', 'heavier parts: mean', 'SD', 'silhouette like H\'s front', 'face like H\'s front', 'build answers']);
  for (const one of score.complaint2) {
    row([one.id, one.scenes, one.seeds.join(', '), fixed(one.parts.mean), fixed(one.parts.sd), one.parts.n ? `${one.parts.min}–${one.parts.max}` : '-', fixed(one.heavier.mean),
      fixed(one.heavier.sd), `${one.silhouette} of ${one.parts.n}`, `${one.face} of ${one.parts.n}`, one.build.join(' ')]);
  }
  lines.push('');
  head(['arm', 'L1 against L0', 'seeds judged', 'L1 better', 'same', 'worse', 'L0 in all', 'L1 in all']);
  for (const one of score.looks) {
    for (const [name, value] of [['parts matching', one.parts], ['heavier parts', one.heavier], ['silhouette like H\'s front', one.silhouette]] as const) {
      row([one.arm, name, value.seeds, value.better, value.same, value.worse, value.a, value.b]);
    }
  }
  lines.push('', '### 3. The clothes of the pictures a frame was drawn from', '', 'Counts in K-solo / P, of six seeds each. A cell\'s own sources: H\'s front for R, H\'s front and the view for FV, the crop for FC; W has none, so its counts against H\'s front are the base rate.', '');
  head(['cell', 'judged', 'clothes like its own sources', 'clothes like H\'s front', 'unsure against H\'s front', 'clothes like any picture shown', 'pose like its sources', 'backdrop', 'light', 'scene clothes not worn']);
  const two = (value: number[]) => value.join(' / ');
  for (const one of score.complaint3) {
    row([one.id, two(one.judged), one.sources ? two(one.ownClothes) : 'no source', two(one.frontClothes), two(one.frontUnsure), two(one.anyClothes),
      one.sources ? two(one.ownPose) : '-', one.sources ? two(one.ownBackdrop) : '-', one.sources ? two(one.ownLight) : '-', two(one.sceneClothesNot)]);
  }
  return lines.join('\n') + '\n';
}

// ---- The third and fourth stands ----

// Their question files as ~/simple-story-chat-runs/2026-09-28/refs-backlog/build-texts.ts wrote them beside each stand's
// texts.json, byte for byte: the people, the scenes, and the cells with every picture each took. Their questions are
// asked as the review of 2026-09-28 left them (REVIEWED_34 below).
const QUESTIONS_SHA256: Record<Stand34, string> = { 3: '29919050ccaf6150e13f639fb1751dbd60a745c5fd77f81fffbe41d8613c2e8b',
  4: 'e11fa71ea2e4669396d7717d04a05024a8bfba0db2a00d474602edb99bb92405' };
type Who4 = 'H' | 'L' | 'B' | 'T';
type Scene34 = 'K-pair' | 'K-trio';
const WHO_4: Who4[] = ['H', 'L', 'B', 'T'];
const SCENES_3: Scene34[] = ['K-pair', 'K-trio'];
export const ID_4: Record<Who4, string> = { H: 'mara', L: 'lina', B: 'bruno', T: 'tessa' };
export const PARTS_4 = ['overall', 'height', 'shoulders', 'chest', 'waist', 'belly', 'hips', 'arms', 'legs'] as const;
// The parts a build score counts: all but height, which pictures without a common physical scale cannot show.
export const SCORED_4: string[] = PARTS_4.filter(part => part !== 'height');
export const TURNS_4 = ['TQ', 'P', 'BACK', 'SIT'] as const;
// The third stand's eight cells of one scene and seed, and S's four, which are also judged beside their draft, W's
// picture of the same scene and seed.
export const CELLS_3 = ['W', 'R', 'S2-55', 'S3-55', 'S2-80', 'S3-80', 'FC', 'FV'];
export const S_CELLS = ['S2-55', 'S3-55', 'S2-80', 'S3-80'];
const NOT_SAID = 'not said';

type QPerson = { name: string; front: { key: string; run: string }; details: string; build: Record<string, string> };
type QScene = { count: number; people: { person: Who4; place: string; pose: string; action: string; clothes: string }[];
  touches: { from: Who4; to: Who4; how: string }[]; heights: string };
type QRef = { slot: number; key: string; run: string; how: string; person?: Who4; draft?: boolean };
type QCell = { key: string; arm: string; id: string; scene?: Scene34; person?: Who4; turn?: string; seed: number; file: string; references: QRef[];
  start?: { key: string; denoise: number } };
type QuestionFile = { stand: string; people: Record<Who4, QPerson>; portraitClothes: string; scenes?: Record<Scene34, QScene>; cells: QCell[];
  questions: Record<string, (Asked & { expected?: unknown })[]> };
// A stand's question file, only as the pin has it.
export function readQuestions(run: string): QuestionFile {
  const stand = standOf(run);
  if (stand !== 3 && stand !== 4) throw new Refusal('only the third and fourth stands are judged from a question file');
  const file = join(resolve(run), 'judge-questions.json');
  if (!existsSync(file)) throw new Refusal(`${file} is missing: build-texts.ts writes it beside the stand's texts.json`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== QUESTIONS_SHA256[stand]) throw new Refusal(`${file} is not the question file image-refs-judge.ts pins; nothing is judged from it`);
  return JSON.parse(bytes.toString('utf8')) as QuestionFile;
}

// ---- The questions, as the review left them ----

// Before any judging, a GPT-6 Astra review (docs/action-experiment.md#refs-judging-34) changed the question files'
// questions: build against the front apart from build against the words, `different` and `not seen` where a build or a
// likeness cannot be ordered or seen, height kept but not scored, a person found by place alone, touches by body part,
// and the asks below. These are the questions as it left them, in the question files' form: the tasks ask them word for
// word, the schemas allow their answers, and `bundles` writes them beside the record as judge/questions.json.
export const ANATOMY_ITEMS = ['twisted torso', 'limb or finger too many or missing', 'joint bent the wrong way', 'neck or limb of impossible length', 'bodies merged'];
export const BODY_PARTS = ['hand', 'arm', 'shoulder', 'head', 'torso', 'hip', 'leg', 'foot', 'other'];
const ANATOMY_ASK = 'List visible anatomical impossibilities: an implausibly twisted or disconnected torso, an extra or visibly malformed/missing limb or finger, a joint bent impossibly, a neck or limb of impossible length, or merged bodies. Normal torso rotation and foreshortening are not errors. Do not count a body part hidden by another object, another person, the viewpoint or the crop as missing. Use [] when no listed error is visible.';
const IDENTITY_ASK = 'Compare the visible face, hair, skin, apparent age and identifying marks with the front. Same means the visible facial structure and distinguishing features agree, allowing for viewpoint, expression, lighting and rendering style. Similar means there is a recognizable resemblance with visible differences. Different means the visible features clearly conflict. Not seen means there is insufficient facial detail to distinguish these outcomes. Matching hair, glasses or skin alone is insufficient for same. Do not penalize marks hidden by the view. Use missing when the target person is absent.';
type Asked = { id: string; each?: string; replaces?: string; ask: string; answers: string | string[]; parts?: readonly string[]; values?: string[] };
export const REVIEWED_34 = {
  instructions: {
    place: 'Treat place as a spatial region, not a requirement that the person perform the correct pose or action. Assign each visible person to at most one scene slot using position alone. A person standing at the bench can occupy the bench slot and then fail the sitting requirement. Do not change assignments to improve likeness scores.',
    build: 'Judge body proportions rather than pixel size. Less and more describe a clear decrease or increase in the relevant size, width, thickness or length. Use different for a visible shape mismatch that has no single direction, including conflicting changes across dimensions. Use not seen when the relevant feature cannot be compared reliably because of concealment, resolution, clothing, pose, perspective or insufficient information in the reference. An unseen part is not evidence of a smaller or missing body part. Judge overall from the visible distribution of body mass and proportions.',
    height: 'Height means standing stature, not apparent size in the picture or leg-to-torso proportions. Use not seen unless the pictures provide a reliable common physical scale. Do not infer stature from independently fitted portraits or reconstruct standing height from a seated figure. Judge visible leg and torso proportions in their relevant build fields.',
    absent: 'For an absent person, use not seen throughout build_front; use not specified for unspecified word targets and not seen otherwise in build_words.',
    view: 'Judge the sole person, or the largest central person if several are present; count everyone. If nobody is present, use identity missing, every build part not seen, turn no, clothes_kept no, whole_body no and anatomy []. Judge backdrop_kept independently.',
    front: 'Judge the sole person, or the largest central person if several are present; count everyone. If nobody is present, use every build part not seen, or not specified where the words for the part are "not said", face_hair_skin no, clothes no, whole_body no and anatomy [].',
  },
  frame: [
    { id: 'count', ask: 'How many people are in the picture? Count everyone, whole or in part.', answers: 'a number' },
    { id: 'identity', each: 'person', ask: IDENTITY_ASK, answers: ['same', 'similar', 'different', 'not seen', 'missing'] },
    { id: 'build_front', each: 'person and part', replaces: 'build', ask: 'For each part, compare the depicted body with the front alone, allowing for pose, perspective and clothing. Answer same, less, more, different or not seen.',
      answers: ['same', 'less', 'more', 'different', 'not seen'], parts: PARTS_4 },
    { id: 'build_words', each: 'person and part', replaces: 'build', ask: 'For each part, compare the depicted body with the words for that part alone. Answer as given, less, more, different, not seen or not specified. Use not specified when the part\'s words are "not said". Do not use the front to supply an unstated requirement.',
      answers: ['as given', 'less', 'more', 'different', 'not seen', 'not specified'], parts: PARTS_4 },
    { id: 'heights', ask: 'Are the standing people\'s relative heights as described, allowing for depth and posture? Answer yes when the ordering is clear and correct, no when it is clearly wrong, and not seen when it cannot be established. If a required standing person is absent or seated, answer not seen; record that failure under count or pose.',
      answers: ['yes', 'no', 'not seen'] },
    { id: 'reference_clothes', each: 'person', ask: 'Is clothing visibly identifiable as the front\'s dark grey one-piece athletic suit? Answer yes when the suit is visibly present as the person\'s main outfit; partly when a recognizable portion replaces or shows beneath the scene\'s clothes; no when no recognizable portion is visible; and not seen when the relevant clothing cannot be inspected. Matching colour, ordinary dark shoes or grey trousers alone do not establish the presence of the suit. Do not infer clothing beneath opaque garments.',
      answers: ['no', 'partly', 'yes', 'not seen'] },
    { id: 'scene_clothes', each: 'person', ask: 'Does the person wear the scene\'s clothes as described?', answers: ['yes', 'partly', 'no'] },
    { id: 'pose', each: 'person', ask: 'Is the person where the scene puts them, standing or sitting and turned as it says, doing what it says?', answers: ['yes', 'partly', 'no'] },
    { id: 'anatomy', each: 'person', ask: ANATOMY_ASK, answers: 'a list, or none', values: ANATOMY_ITEMS },
    { id: 'touches', ask: 'List visible contacts between different people. Give one entry per contacting body part, including separate entries for two hands. Each entry has from, to, with and on. From is the person making the contact; with is their contacting body part; to is the contacted person; on is the contacted body part. Do not also list the same contact in reverse. Exclude contact with clothing worn by the same person, props and furniture. Use [] for no visible interpersonal contact.',
      answers: 'a list, or none', values: BODY_PARTS },
  ] as Asked[],
  S: [
    { id: 'draft_kept', ask: 'Beside the draft, did this picture keep its composition and poses: the framing, where each person stands or sits, their turn and gesture? Yes means all listed aspects are preserved; partly means some are preserved and some changed; no means the composition and poses are substantially replaced.',
      answers: ['yes', 'partly', 'no'] },
    { id: 'figure_moved', each: 'person', ask: 'Compare the person\'s visible body proportions in the edited picture and the draft, using the front as the target. Use only features that can be compared reliably across all three pictures. Answer toward the front when at least one feature moves clearly closer and none moves clearly farther; away from the front for the reverse; mixed when some move closer and others farther; as in the draft when no clear change in body proportions is visible; and not seen when no reliable comparison is possible or the person is absent from either picture. Changes in texture, sharpness, lighting or clothing alone do not establish a change in figure.',
      answers: ['toward the front', 'as in the draft', 'away from the front', 'mixed', 'not seen'] },
  ] as Asked[],
  front: [
    { id: 'count', ask: 'How many people are in the picture?', answers: 'a number' },
    { id: 'build', ask: 'For this part of the body, is it as the words give it, less or more? Use not specified when the words for the part are "not said".',
      answers: ['as given', 'less', 'more', 'different', 'not seen', 'not specified'], parts: PARTS_4 },
    { id: 'face_hair_skin', ask: 'Are the face, hair, skin and marks as the words give them?', answers: ['yes', 'partly', 'no'] },
    { id: 'clothes', ask: 'Does the person wear the portrait\'s clothes, and nothing else?', answers: ['yes', 'partly', 'no'] },
    { id: 'whole_body', ask: 'Is the whole body in frame from head to feet, standing and facing the viewer?', answers: ['yes', 'no'] },
    { id: 'anatomy', each: 'person', ask: ANATOMY_ASK, answers: 'a list, or none', values: ANATOMY_ITEMS },
  ] as Asked[],
  view: [
    { id: 'count', ask: 'How many people are in the picture?', answers: 'a number' },
    { id: 'identity', ask: IDENTITY_ASK, answers: ['same', 'similar', 'different', 'not seen', 'missing'] },
    { id: 'build', ask: 'Against the front, is this part of the body the same, less (thinner, smaller, narrower, shorter) or more (heavier, larger, wider, longer)?',
      answers: ['same', 'less', 'more', 'different', 'not seen'], parts: PARTS_4 },
    { id: 'turn', ask: 'Does the person satisfy the complete requested pose? Check standing or sitting, body orientation and picture-relative direction, and any specified support and hand placement. Yes means all requested elements are visibly satisfied. Partly means the requested orientation is substantially present but an angle or another pose detail is wrong. No means the main orientation or standing/sitting state is wrong, or the person is absent. A frontal figure is no for a requested profile, back view or three-quarter turn. Turning the head alone does not satisfy a requested body turn.',
      answers: ['yes', 'partly', 'no'] },
    { id: 'clothes_kept', ask: 'Does the person wear the front\'s clothes, and nothing else?', answers: ['yes', 'partly', 'no'] },
    { id: 'backdrop_kept', ask: 'Is the backdrop the front\'s plain grey, with no scenery? The requested grey sitting block is allowed. Compare backdrop colour and absence of scenery, not exact texture.',
      answers: ['yes', 'no'] },
    { id: 'whole_body', ask: 'Is the whole body in frame from head to feet?', answers: ['yes', 'no'] },
    { id: 'anatomy', each: 'person', ask: ANATOMY_ASK, answers: 'a list, or none', values: ANATOMY_ITEMS },
  ] as Asked[],
};
type Group34 = 'frame' | 'S' | 'front' | 'view';
function asked(group: Group34, id: string): Asked {
  const one = REVIEWED_34[group].find(question => question.id === id);
  if (!one) throw new Error(`no question ${group}.${id}`);
  return one;
}
const ask = (group: Group34, id: string) => asked(group, id).ask;
const answersOf = (group: Group34, id: string) => asked(group, id).answers as string[];
const choices = (group: Group34, id: string) => { const values = answersOf(group, id); return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`; };
// The record beside a stand's judging: the question file's questions as the review left them, each reviewed entry over
// the pinned one of its id (or the one it replaces), whose other fields the review kept, and the instructions it added.
function reviewedFile(stand: Stand34, questions: QuestionFile) {
  const groups: Group34[] = stand === 3 ? ['frame', 'S', 'front'] : ['view'];
  return { version: 2, stand: questions.stand,
    note: 'The questions of ../judge-questions.json as the GPT-6 Astra review of 2026-09-28 left them before any judging (judge/review/session/review.report.md in 2026-09-28/refs-stand-3). The judges are asked these, word for word; the other fields of each entry are the pinned file\'s. Synthetic.',
    instructions: REVIEWED_34.instructions,
    questions: Object.fromEntries(groups.map(group => [group, REVIEWED_34[group].map(one => {
      const pinned = (questions.questions[group] ?? []).find(entry => entry.id === (one.replaces ?? one.id));
      const { ask: _ask, answers: _answers, parts: _parts, values: _values, id: _id, ...kept } = pinned ?? { id: '', ask: '', answers: '' };
      const { id, ...reviewed } = one;
      return { id, ...kept, ...reviewed };
    })])) };
}

// One comparison: the stand's own cells judged side by side, with a frame's scene and seed, the views' person and seed,
// and S's draft.
type Comparison34 = { group: string; rank: Rank; kind: 'fronts' | 'frames' | 'draft' | 'turns'; scene?: Scene34; seed?: number; person?: Who4; cells: string[];
  draft?: string };
export function comparisons34(stand: Stand34): Comparison34[] {
  const out: Comparison34[] = [];
  if (stand === 4) {
    for (const seed of SEEDS_4) for (const who of WHO_4) {
      out.push({ group: `${who}-s${seed}`, rank: 'V4', kind: 'turns', seed, person: who, cells: TURNS_4.map(turn => viewKeyOf(viewId(who, turn), seed)) });
    }
    return out;
  }
  out.push({ group: 'fronts', rank: 'F3', kind: 'fronts', cells: [FRONTS.B, FRONTS.T] });
  for (const seed of SEEDS_3) for (const scene of SCENES_3) {
    out.push({ group: `${scene}-s${seed}`, rank: 'K3', kind: 'frames', scene, seed, cells: CELLS_3.map(id => frameKey(id, scene, seed)) });
    out.push({ group: `${scene}-s${seed}`, rank: 'S3', kind: 'draft', scene, seed, cells: S_CELLS.map(id => frameKey(id, scene, seed)), draft: frameKey('W', scene, seed) });
  }
  return out;
}
// The sessions in the order they run, by rank: each comparison of frames twice, against the scene and then against the
// fronts.
export type SessionPlan34 = { name: string; kind: Kind; rank: Rank; comparison: Comparison34 };
export function sessionPlan34(stand: Stand34): SessionPlan34[] {
  const sessions = ranksOf(stand).flatMap(rank => comparisons34(stand).filter(one => one.rank === rank))
    .flatMap(comparison => (comparison.kind === 'frames' ? ['frames', 'identity'] as const : [comparison.kind]).map(kind => ({ kind, comparison })));
  return sessions.map((one, at) => ({ name: `j${String(at + 1).padStart(2, '0')}-${one.kind}`, kind: one.kind, rank: one.comparison.rank, comparison: one.comparison }));
}

// The tasks: the reviewed questions, each in its words, with the answers it allows.
const CLEAN_34 = 'clean: is it free of nudity and of sexual content? yes or no. If clean is no, still return every required field: 0 for a number, [] for a list, and for any other field the first value it allows from this ordered list: not seen, missing, no, different, as in the draft. These values are placeholders only; the whole picture is left out.';
const ENDING_34 = 'Reason as long as you need. End your answer with exactly one ```json block that fits schema.json in this folder: the form in form.json with each value replaced by your answer (one of the values it lists, or a whole number or a list where it asks for one), nothing more and nothing missing.';
const PLACEHOLDER_ORDER = ['not seen', 'missing', 'no', 'different', 'as in the draft'];
const anatomy34 = (group: Group34) => `anatomy: ${ask(group, 'anatomy')} Name each error by the value form.json lists for it.`;
const FIND_34 = 'first find them by the place the scene gives them, independently of any likeness or of what they do';
const WORDS_34 = `people: each person's id, name, words, and their build part by part (parts: ${PARTS_4.join(', ')}; "${NOT_SAID}" where the words say nothing of that part)`;
const FRONT_34 = 'standing alone, full length from the front, on a plain grey backdrop, in the portrait\'s clothes';
const BUILD_RULE_34 = `For every build answer: ${REVIEWED_34.instructions.build} ${REVIEWED_34.instructions.height}`;
export const TASKS_34: Record<Exclude<Kind, 'sheet' | Kind5>, string> = {
  frames: `You judge pictures drawn for one scene of a story, each against the scene's words.

input.json holds:
- scene: the scene every picture was drawn for: how the heights of its people standing compare (heights), and each person in it with their id, name, place, pose, action and clothes;
- pictures: the pictures' file names.
The pictures are in this folder and attached in the order input.json lists them.

${REVIEWED_34.instructions.place}

For each picture:
1. ${CLEAN_34}
2. count: ${ask('frame', 'count')} A whole number.
3. heights: ${ask('frame', 'heights')}
4. For each person of the scene, ${FIND_34}. Then:
   - scene_clothes: ${ask('frame', 'scene_clothes')} ${choices('frame', 'scene_clothes')};
   - pose: ${ask('frame', 'pose')} ${choices('frame', 'pose')};
   - ${anatomy34('frame')}
   If the place holds no one: scene_clothes and pose no, and anatomy [].
5. touches: ${ask('frame', 'touches')} From and to are the ids of the scene's people (someone else for anyone else); with and on are each one of: ${BODY_PARTS.join(', ')}.
The pictures may be compared with one another.

${ENDING_34}`,
  identity: `You compare the people in pictures with each person's front picture and words.

input.json holds:
- ${WORDS_34};
- fronts: each person's front picture: its file name and the id of the person it shows, ${FRONT_34};
- faces: the top of each front, cut at full resolution to show the face closer: its file name and the id of the person it shows;
- clothes: the portrait's clothes, which every front shows;
- scene: each person of the scene the pictures were drawn for, with their id, name, place and the clothes the scene gives them;
- pictures: the pictures' file names.
Everything is in this folder and attached: the pictures in the order input.json lists them, then the fronts in theirs, then the faces in theirs.

${REVIEWED_34.instructions.place}

${BUILD_RULE_34}

For each picture:
1. ${CLEAN_34}
2. For each person of the scene, ${FIND_34}. Then:
   - identity: ${ask('frame', 'identity')} ${choices('frame', 'identity')};
   - build_front: each part in their parts, on its own: ${ask('frame', 'build_front')}
   - build_words: each part in their parts, on its own: ${ask('frame', 'build_words')}
   - reference_clothes: ${ask('frame', 'reference_clothes')} ${choices('frame', 'reference_clothes')}.
   Keep all nine parts in both build_front and build_words. If the place holds no one, the person is absent: identity missing and reference_clothes no. ${REVIEWED_34.instructions.absent}
The pictures may be compared with one another.

${ENDING_34}`,
  draft: `You compare pictures made by editing one draft picture with that draft and with each person's front picture.

input.json holds:
- draft: the draft's file name: a picture of the scene, from which every picture was made;
- fronts: each person's front picture: its file name and the id of the person it shows, ${FRONT_34};
- scene: each person of the scene with their id, name, place and pose;
- pictures: the pictures' file names.
Everything is in this folder and attached: the pictures in the order input.json lists them, then the draft, then the fronts in theirs.

${REVIEWED_34.instructions.place}

For each picture:
1. ${CLEAN_34}
2. draft_kept: ${ask('S', 'draft_kept')} ${choices('S', 'draft_kept')}.
3. For each person of the scene, found by the place the scene gives them in the draft and in the picture: figure_moved: ${ask('S', 'figure_moved')} ${choices('S', 'figure_moved')}.
The pictures may be compared with one another.

${ENDING_34}`,
  fronts: `You check pictures drawn to show how people look, each against the person's words.

input.json holds:
- ${WORDS_34};
- clothes: the portrait's clothes;
- pictures: the pictures' file names, each with the id of the person it was asked to show, ${FRONT_34}.
The pictures are in this folder and attached in the order input.json lists them.

${REVIEWED_34.instructions.front}

${BUILD_RULE_34}

For each picture:
1. ${CLEAN_34}
2. count: ${ask('front', 'count')} A whole number.
3. build: each part in the person's parts, on its own: ${ask('front', 'build')} ${choices('front', 'build')}.
4. face_hair_skin: ${ask('front', 'face_hair_skin')} ${choices('front', 'face_hair_skin')}.
5. clothes: ${ask('front', 'clothes')} ${choices('front', 'clothes')}.
6. whole_body: ${ask('front', 'whole_body')} ${choices('front', 'whole_body')}.
7. ${anatomy34('front')}
The pictures may be compared with one another.

${ENDING_34}`,
  turns: `You check pictures that were each made from one front picture of a person, to show the same person turned another way.

input.json holds:
- front: the front picture's file name: the person ${FRONT_34};
- clothes: the portrait's clothes;
- pictures: the pictures' file names, each with the pose it was asked to show (turn).
Everything is in this folder and attached: the pictures in the order input.json lists them, then the front.

${REVIEWED_34.instructions.view}

${BUILD_RULE_34}

For each picture:
1. ${CLEAN_34}
2. count: ${ask('view', 'count')} A whole number.
3. identity: ${ask('view', 'identity')} ${choices('view', 'identity')}.
4. build: each part (${PARTS_4.join(', ')}), on its own: ${ask('view', 'build')} ${choices('view', 'build')}.
5. turn: ${ask('view', 'turn')} ${choices('view', 'turn')}.
6. clothes_kept: ${ask('view', 'clothes_kept')} ${choices('view', 'clothes_kept')}.
7. backdrop_kept: ${ask('view', 'backdrop_kept')} ${choices('view', 'backdrop_kept')}.
8. whole_body: ${ask('view', 'whole_body')} ${choices('view', 'whole_body')}.
9. ${anatomy34('view')}
The pictures may be compared with one another.

${ENDING_34}`,
};
const taskOf = (stand: StandId, kind: Kind) => (stand === 5 ? TASKS_5[kind as Kind5] : stand === 3 || stand === 4 ? TASKS_34[kind as Exclude<Kind, 'sheet' | Kind5>]
  : TASKS[kind as Kind12]);

const INT: Schema = { type: 'integer' };
const enumOf = (group: Group34, id: string): Schema => ({ type: 'string', enum: answersOf(group, id) });
const ANATOMY_LIST: Schema = { type: 'array', items: { type: 'string', enum: ANATOMY_ITEMS } };
const touchesSchema = (ids: string[]): Schema => ({ type: 'array', items: strict({ from: { type: 'string', enum: [...ids, 'someone else'] },
  to: { type: 'string', enum: [...ids, 'someone else'] }, with: { type: 'string', enum: BODY_PARTS }, on: { type: 'string', enum: BODY_PARTS } }) });
const frames34Schema = (names: string[], ids: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, count: INT, heights: enumOf('frame', 'heights'),
  people: each(ids, strict({ scene_clothes: enumOf('frame', 'scene_clothes'), pose: enumOf('frame', 'pose'), anatomy: ANATOMY_LIST })), touches: touchesSchema(ids) })) });
const identity34Schema = (names: string[], ids: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN,
  people: each(ids, strict({ identity: enumOf('frame', 'identity'), build_front: each([...PARTS_4], enumOf('frame', 'build_front')),
    build_words: each([...PARTS_4], enumOf('frame', 'build_words')), reference_clothes: enumOf('frame', 'reference_clothes') })) })) });
const draftSchema = (names: string[], ids: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, draft_kept: enumOf('S', 'draft_kept'),
  people: each(ids, strict({ figure_moved: enumOf('S', 'figure_moved') })) })) });
const fronts34Schema = (names: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, count: INT, build: each([...PARTS_4], enumOf('front', 'build')),
  face_hair_skin: enumOf('front', 'face_hair_skin'), clothes: enumOf('front', 'clothes'), whole_body: enumOf('front', 'whole_body'), anatomy: ANATOMY_LIST })) });
const turns34Schema = (names: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, count: INT, identity: enumOf('view', 'identity'),
  build: each([...PARTS_4], enumOf('view', 'build')), turn: enumOf('view', 'turn'), clothes_kept: enumOf('view', 'clothes_kept'), backdrop_kept: enumOf('view', 'backdrop_kept'),
  whole_body: enumOf('view', 'whole_body'), anatomy: ANATOMY_LIST })) });
// The answers' form: the schema's keys, each value the choices it allows, a whole number or a list.
const formOf34 = (schema: Schema): unknown => schema.enum ? schema.enum.join(' | ')
  : schema.type === 'integer' ? 'a whole number'
    : schema.type === 'array' ? `a list of ${schema.items?.enum ? `any of: ${schema.items.enum.join(' | ')}` : JSON.stringify(formOf34(schema.items!))}; [] for none`
      : schema.type === 'string' ? 'a few words'
        : Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, value]) => [name, formOf34(value)]));
// The answers a picture that is not clean gets, by the task's fixed order; none if a field allows none of it.
function placeholderOf(schema: Schema, name = ''): unknown {
  if (name === 'clean') return 'no';
  if (schema.enum) return PLACEHOLDER_ORDER.find(value => schema.enum!.includes(value));
  if (schema.type === 'integer') return 0;
  if (schema.type === 'array') return [];
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, placeholderOf(value, key)]));
}
// A bundle's form, schema and placeholder answers checked together, as the review asked: the form has the schema's
// keys and lists each field's values, and the placeholders for every picture fit the schema.
function formFits(form: unknown, schema: Schema): boolean {
  if (schema.enum) return form === schema.enum.join(' | ');
  if (schema.type === 'integer' || schema.type === 'array' || schema.type === 'string') return typeof form === 'string';
  const properties = schema.properties ?? {}, record = form as Record<string, unknown>;
  return !!form && typeof form === 'object' && Object.keys(record).join() === Object.keys(properties).join()
    && Object.entries(properties).every(([key, value]) => formFits(record[key], value));
}
const bundleFits = (schema: Schema, form: unknown) => formFits(form, schema) && fitsSchema(placeholderOf(schema), schema);
// What the third and fourth stands' questions are pinned to, as judgePins is for the first two.
export function judgePins34(): Record<string, string> {
  const names = ['pic-0.png'], ids = ['mara', 'lina'];
  const schemas = { frames: frames34Schema(names, ids), identity: identity34Schema(names, ids), draft: draftSchema(names, ids), fronts: fronts34Schema(names),
    turns: turns34Schema(names) };
  return { effort: JUDGE.effort, texts3: TEXTS_SHA256_3, texts4: TEXTS_SHA256_4, questions3: QUESTIONS_SHA256[3], questions4: QUESTIONS_SHA256[4],
    reviewed: sha256(JSON.stringify(REVIEWED_34)),
    ...Object.fromEntries(Object.entries(TASKS_34).map(([kind, text]) => [`task.${kind}`, sha256(text)])),
    ...Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [`schema.${kind}`, sha256(JSON.stringify(schema))])) };
}
export const questionsPin34 = () => sha256(JSON.stringify(judgePins34()));
const pinOf = (stand: StandId) => (stand === 5 ? questionsPin5() : stand === 3 || stand === 4 ? questionsPin34() : questionsPin());

// A picture of any run the stands drew from, by its run as the question file names it (under the runs' root) and its
// key: the very file that run's cells.json records, checked against the sha256 and size recorded there, without any
// text chunk.
function runPictures(root: string) {
  const runs = new Map<string, Record<string, StandCell>>(), seen = new Map<string, { bytes: Uint8Array; sha256: string }>();
  return (run: string, key: string) => {
    const id = `${run}/${key}`;
    if (seen.has(id)) return seen.get(id);
    let cells = runs.get(run);
    if (!cells) { cells = (readJson<{ cells: Record<string, StandCell> }>(join(root, run, 'cells.json')) ?? { cells: {} }).cells; runs.set(run, cells); }
    const cell = cells[key];
    if (cell?.status !== 'drawn' || !cell.file || !cell.sha256) return undefined;
    const path = resolve(root, run, cell.file);
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path), size = pngSize(bytes);
    if (sha256(bytes) !== cell.sha256 || size.width !== cell.width || size.height !== cell.height) throw new Refusal(`${key} in ${run} is not the file its cells.json recorded; no bundle is built from it`);
    const file = { bytes: stripPngMetadata(bytes), sha256: cell.sha256 };
    seen.set(id, file);
    return file;
  };
}

// FC's face: the top of a front as the stand's ImageCrop cut it (CROP in image-refs-test.ts), shown beside the fronts
// in the identity sessions to show each face closer.
function faceOf(front: { bytes: Uint8Array }) {
  const image = decodePng(front.bytes), { x, y, width, height } = GRAPH_CROP;
  if (!image || image.width < x + width || image.height < y + height || (image.channels !== 3 && image.channels !== 4)) return undefined;
  const row = image.width * image.channels, pixels = new Uint8Array(width * height * image.channels);
  for (let at = 0; at < height; at++) pixels.set(image.pixels.subarray((y + at) * row + x * image.channels, (y + at) * row + (x + width) * image.channels), at * width * image.channels);
  const bytes = encodePng(width, height, pixels, image.channels);
  return { bytes, sha256: sha256(bytes) };
}

// The third or fourth stand's bundles, written once. First every cell of the question file against the stand's
// cells.json: drawn from the file it names, and every picture it took, read from that picture's own run, the one whose
// sha256 the cell recorded in that slot, its start as well. A cell the stand did not draw leaves its picture out; a
// session left with no picture, or without a front, face or draft it shows, is not built. Each bundle's form, schema
// and placeholder answers are checked together, and the reviewed questions are written beside the record.
function writeBundles34(run: string, stand: Stand34, log: (event: object) => void) {
  const questions = readQuestions(run), dir = judgeDirOf(run), root = resolve(run, '..', '..');
  if (resolve(root, questions.stand) !== resolve(run)) throw new Refusal(`${run} is not where its question file puts the stand under the runs' root`);
  const picture = runPictures(root), cells = (readJson<{ cells: Record<string, StandCell> }>(join(resolve(run), 'cells.json')) ?? { cells: {} }).cells;
  const byKey = new Map(questions.cells.map(one => [one.key, one]));
  let checked = 0;
  for (const one of questions.cells) {
    const cell = cells[one.key];
    if (cell?.status !== 'drawn') continue;
    if (cell.file !== one.file || !picture(questions.stand, one.key)) throw new Refusal(`${one.key} is not drawn where the question file says`);
    const took = cell.references ?? [];
    if (took.length !== one.references.length) throw new Refusal(`${one.key} took ${took.length} pictures where the question file names ${one.references.length}`);
    for (const ref of one.references) {
      if (picture(ref.run, ref.key)?.sha256 !== took[ref.slot - 1]) throw new Refusal(`${one.key}'s picture ${ref.slot} (${ref.key}) is not the one it was drawn with`);
      checked++;
    }
    if ((one.start ? picture(questions.stand, one.start.key)?.sha256 : undefined) !== cell.start) throw new Refusal(`${one.key}'s start is not the picture it was drawn from`);
    if (one.start) checked++;
  }
  const counts = { sessions: 0, built: 0, kept: 0, skipped: 0, missing: [] as string[], checked };
  for (const sub of ['bundles', 'keys']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  writeJson(join(dir, 'questions.json'), reviewedFile(stand, questions));
  const clothes = questions.portraitClothes, nameOf = (who: Who4) => questions.people[who].name;
  const words = (who: Who4) => ({ id: ID_4[who], name: nameOf(who), words: questions.people[who].details, parts: questions.people[who].build });
  for (const session of sessionPlan34(stand)) {
    counts.sessions++;
    const one = session.comparison;
    if (existsSync(join(dir, 'bundles', session.name))) { counts.kept++; continue; }
    const missing: string[] = [];
    const take = (from: string, key: string, prefix: 'pic' | 'ref') => {
      const file = picture(from, key);
      if (!file) { missing.push(key); return undefined; }
      return { name: `${prefix}-${file.sha256.slice(0, 8)}.png`, key, ...file };
    };
    const pictures = one.cells.flatMap(key => { const file = take(questions.stand, key, 'pic'); return file ? [{ ...file, cell: byKey.get(key)! }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));
    const scene = one.scene ? questions.scenes![one.scene] : undefined;
    const cast: Who4[] = scene ? scene.people.map(person => person.person) : one.kind === 'fronts' ? one.cells.map(key => byKey.get(key)!.person!) : [one.person!];
    const fronts = session.kind === 'identity' || session.kind === 'draft' || session.kind === 'turns' ? cast.flatMap(who => {
      const file = take(questions.people[who].front.run, questions.people[who].front.key, 'ref');
      return file ? [{ ...file, person: who }] : [];
    }) : [];
    const faces = session.kind === 'identity' ? fronts.flatMap(front => {
      const face = faceOf(front);
      return face ? [{ ...face, name: `ref-${face.sha256.slice(0, 8)}.png`, key: `crop:${front.key}`, person: front.person }] : [];
    }) : [];
    const draft = session.kind === 'draft' ? take(questions.stand, one.draft!, 'ref') : undefined;
    const shown = [...pictures, ...(draft ? [draft] : []), ...fronts, ...faces];
    counts.missing.push(...missing.filter(key => !counts.missing.includes(key)));
    const complete = (!['identity', 'draft', 'turns'].includes(session.kind) || fronts.length === cast.length) && (session.kind !== 'draft' || !!draft)
      && (session.kind !== 'identity' || faces.length === cast.length);
    if (!pictures.length || !complete || new Set(shown.map(file => file.name)).size !== shown.length) {
      counts.skipped++;
      log({ event: 'bundle_skipped', session: session.name, missing: missing.length });
      continue;
    }
    const ids = cast.map(who => ID_4[who]), names = pictures.map(file => file.name), list = names.map(name => ({ name }));
    const shownFronts = fronts.map(file => ({ name: file.name, person: ID_4[file.person] }));
    let input: object, schema: Schema;
    if (session.kind === 'frames') {
      input = { scene: { heights: scene!.heights.replace(/\b([HLBT])\b/g, (_, who: Who4) => nameOf(who)), people: scene!.people.map(person => ({ id: ID_4[person.person],
        name: nameOf(person.person), place: person.place, pose: person.pose, action: person.action, clothes: person.clothes })) }, pictures: list };
      schema = frames34Schema(names, ids);
    } else if (session.kind === 'identity') {
      input = { people: cast.map(words), fronts: shownFronts, faces: faces.map(file => ({ name: file.name, person: ID_4[file.person] })), clothes,
        scene: { people: scene!.people.map(person => ({ id: ID_4[person.person], name: nameOf(person.person), place: person.place, clothes: person.clothes })) }, pictures: list };
      schema = identity34Schema(names, ids);
    } else if (session.kind === 'draft') {
      input = { draft: draft!.name, fronts: shownFronts, scene: { people: scene!.people.map(person => ({ id: ID_4[person.person], name: nameOf(person.person),
        place: person.place, pose: person.pose })) }, pictures: list };
      schema = draftSchema(names, ids);
    } else if (session.kind === 'fronts') {
      input = { people: cast.map(words), clothes, pictures: pictures.map(file => ({ name: file.name, person: ID_4[file.cell.person!] })) };
      schema = fronts34Schema(names);
    } else {
      input = { front: fronts[0].name, clothes, pictures: pictures.map(file => ({ name: file.name, turn: file.cell.turn! })) };
      schema = turns34Schema(names);
    }
    const form = formOf34(schema);
    if (!bundleFits(schema, form)) throw new Refusal(`${session.name}'s form, schema and placeholder answers do not fit together`);
    const bundle = join(dir, 'bundles', session.name), task = taskOf(stand, session.kind), inputText = JSON.stringify(input, null, 2);
    mkdirSync(bundle, { recursive: true, mode: 0o700 });
    writeFileSync(join(bundle, 'TASK.md'), task + '\n', { mode: 0o600 });
    writeFileSync(join(bundle, 'input.json'), inputText + '\n', { mode: 0o600 });
    writeJson(join(bundle, 'schema.json'), schema);
    writeJson(join(bundle, 'form.json'), form);
    for (const file of shown) writeFileSync(join(bundle, file.name), file.bytes, { mode: 0o600 });
    const key: SessionKey = { name: session.name, kind: session.kind, group: one.group, rank: one.rank, ...(one.scene ? { scene: one.scene } : {}),
      ...(one.seed === undefined ? {} : { seed: one.seed }), task: sha256(task), schema: sha256(JSON.stringify(schema)), input: sha256(inputText),
      pictures: pictures.map(file => ({ name: file.name, key: file.key, sha256: file.sha256 })),
      references: [...(draft ? [{ name: draft.name, key: draft.key, sha256: draft.sha256, compare: false }] : []),
        ...[...fronts, ...faces].map(file => ({ name: file.name, key: file.key, sha256: file.sha256, compare: true }))], missing };
    writeJson(keyOf(dir, session.name), key);
    counts.built++;
    log({ event: 'bundle_written', session: session.name, pictures: pictures.length, references: shown.length - pictures.length, missing: missing.length });
  }
  return counts;
}

// ---- The third and fourth stands' answers ----

type Touch34 = { from: string; to: string; with: string; on: string };
type Frame34 = { count: number; heights: string; people: Record<string, { scene_clothes: string; pose: string; anatomy: string[] }>; touches: Touch34[] };
type Identity34 = { people: Record<string, { identity: string; build_front: Record<string, string>; build_words: Record<string, string>; reference_clothes: string }> };
type Draft34 = { draft_kept: string; people: Record<string, { figure_moved: string }> };
type Front34 = { count: number; build: Record<string, string>; face_hair_skin: string; clothes: string; whole_body: string; anatomy: string[] };
type Turn34 = { count: number; identity: string; build: Record<string, string>; turn: string; clothes_kept: string; backdrop_kept: string; whole_body: string;
  anatomy: string[] };
type Facts34 = { frames: Map<string, Frame34>; identity: Map<string, Identity34>; draft: Map<string, Draft34>; fronts: Map<string, Front34>;
  turns: Map<string, Turn34>; excluded: Map<string, string[]>; sessions: { answered: number; planned: number } };
// One judging pass's answers, each picture under its cell's key, the keys read from the judge of record's judge/keys.
// A picture any session of this pass calls not clean is left out of everything this pass scores, with the sessions
// that called it so.
function readFacts34(dir: string, keys: string): Facts34 {
  const facts: Facts34 = { frames: new Map(), identity: new Map(), draft: new Map(), fronts: new Map(), turns: new Map(), excluded: new Map(),
    sessions: { answered: 0, planned: 0 } };
  const read: { key: SessionKey; pictures: Record<string, Ans> }[] = [];
  for (const file of existsSync(keys) ? readdirSync(keys).filter(name => name.endsWith('.json')).sort() : []) {
    const key = JSON.parse(readFileSync(join(keys, file), 'utf8')) as SessionKey;
    facts.sessions.planned++;
    const answers = readJson<Ans>(answerOf(dir, key.name));
    if (!answers) continue;
    facts.sessions.answered++;
    const pictures = (answers.pictures ?? {}) as Record<string, Ans>;
    read.push({ key, pictures });
    for (const one of key.pictures) if (pictures[one.name]?.clean !== 'yes') facts.excluded.set(one.key, [...(facts.excluded.get(one.key) ?? []), key.name]);
  }
  for (const { key, pictures } of read) {
    for (const one of key.pictures) {
      if (facts.excluded.has(one.key)) continue;
      const got = pictures[one.name] as unknown;
      if (key.kind === 'frames') facts.frames.set(one.key, got as Frame34);
      else if (key.kind === 'identity') facts.identity.set(one.key, got as Identity34);
      else if (key.kind === 'draft') facts.draft.set(one.key, got as Draft34);
      else if (key.kind === 'fronts') facts.fronts.set(one.key, got as Front34);
      else facts.turns.set(one.key, got as Turn34);
    }
  }
  return facts;
}
const count34 = (values: (string | undefined)[], value: string) => values.filter(one => one === value).length;
const tally = (values: (string | undefined)[], choices: readonly string[]) => Object.fromEntries(choices.map(choice => [choice, count34(values, choice)]));
const counts34 = (value: Record<string, number>) => Object.values(value).join('/');
// The contact the scene's touch is read as, by the review: one entry from Tessa's hand to Bruno's shoulder. Every other
// entry is an extra, a second hand included.
const REQUIRED_TOUCHES: Record<Scene34, Touch34[]> = { 'K-pair': [], 'K-trio': [{ from: 'tessa', to: 'bruno', with: 'hand', on: 'shoulder' }] };
const touchKey = (one: Touch34) => `${one.from}>${one.to}:${one.with}@${one.on}`;
// A person's word targets: the scored parts their words say something of.
const targetsOf = (questions: QuestionFile, id: string) => {
  const who = WHO_4.find(one => ID_4[one] === id)!;
  return SCORED_4.filter(part => questions.people[who].build[part] !== NOT_SAID);
};

// One frame of the third stand as the tables and rules read it: each person's answers, and the frame's count, heights
// and contacts against the scene's.
type Person3 = { identity?: string; front?: Record<string, string>; words?: Record<string, string>; suit?: string; sceneClothes?: string; pose?: string;
  anatomy?: number; moved?: string };
type Cell3 = { key: string; id: string; scene: Scene34; seed: number; judged: boolean; drafted: boolean; count?: number; countRight?: boolean; heights?: string;
  touchFound?: boolean; touchExtras?: number; draftKept?: string; people: Record<string, Person3> };
function cell3(facts: Facts34, questions: QuestionFile, id: string, scene: Scene34, seed: number): Cell3 {
  const key = frameKey(id, scene, seed), frame = facts.frames.get(key), identity = facts.identity.get(key), draft = facts.draft.get(key);
  const out: Cell3 = { key, id, scene, seed, judged: !!frame && !!identity, drafted: !!draft, people: {} };
  if (frame) {
    const listed = frame.touches.map(touchKey), required = REQUIRED_TOUCHES[scene].map(touchKey);
    const found = required.every(one => listed.includes(one));
    Object.assign(out, { count: frame.count, countRight: frame.count === questions.scenes![scene].count, heights: frame.heights,
      touchFound: required.length ? found : undefined, touchExtras: listed.length - (required.length && found ? required.length : 0) });
  }
  if (draft) out.draftKept = draft.draft_kept;
  for (const person of questions.scenes![scene].people) {
    const who = ID_4[person.person], seen = frame?.people[who], like = identity?.people[who], moved = draft?.people[who];
    const one: Person3 = {};
    if (seen) Object.assign(one, { sceneClothes: seen.scene_clothes, pose: seen.pose, anatomy: seen.anatomy.length ? 1 : 0 });
    if (like) Object.assign(one, { identity: like.identity, front: like.build_front, words: like.build_words, suit: like.reference_clothes });
    if (moved) one.moved = moved.figure_moved;
    out.people[who] = one;
  }
  return out;
}

export type Verdict34 = 'yes' | 'no' | 'undecided';
export type Decision34 = { question: string; verdict: Verdict34; why: string; winner?: string };
// X against Y on a measure over the seeds both were judged at: the sums, and the seeds at which X is ahead, tied or
// behind, of the seeds required.
type Pairwise = { required: number; seeds: number; ahead: number; tied: number; behind: number; x: number; y: number };
function pairwise(x: number[], y: number[], required: number): Pairwise {
  const pairs = x.map((value, index) => [value, y[index]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const ahead = pairs.filter(([a, b]) => a > b).length, behind = pairs.filter(([a, b]) => a < b).length;
  return { required, seeds: pairs.length, ahead, tied: pairs.length - ahead - behind, behind, x: sum(pairs.map(([a]) => a)), y: sum(pairs.map(([, b]) => b)) };
}
// X is above Y when its sum is higher and it is ahead at more seeds than it is behind; below when the reverse holds;
// otherwise neither, which does not mean equal. Not below in the stricter sense of rules 2 and 4: a sum at least Y's,
// and at least as many seeds ahead as behind.
const above = (one: Pairwise) => one.x > one.y && one.ahead > one.behind;
const below = (one: Pairwise) => one.x < one.y && one.behind > one.ahead;
const atLeast = (one: Pairwise) => one.x >= one.y && one.ahead >= one.behind;
const pairReading = (one: Pairwise) => (above(one) ? 'above' : below(one) ? 'below' : 'neither');
const pairText = (one: Pairwise) => `${one.x} against ${one.y}, ahead at ${one.ahead}, tied at ${one.tied}, behind at ${one.behind}, `
  + `${one.seeds} of ${one.required} seeds available: ${pairReading(one)}`;
const MOVED_34 = ['toward the front', 'as in the draft', 'away from the front', 'mixed', 'not seen'];
const IDENTITY_VALUES = ['same', 'similar', 'different', 'not seen', 'missing'];
const FRONT_VALUES = ['same', 'less', 'more', 'different', 'not seen'];
const WORDS_VALUES = ['as given', 'less', 'more', 'different', 'not seen', 'not specified'];
const shortOf = (scene: Scene34) => (scene === 'K-pair' ? 'pair' : 'trio');

// The third stand's tallies per arm, scene and person, the rules' readings, the cleanup, and B's and T's fronts.
function score3(questions: QuestionFile, facts: Facts34) {
  const cells = SCENES_3.flatMap(scene => CELLS_3.flatMap(id => SEEDS_3.map(seed => cell3(facts, questions, id, scene, seed))));
  const row = (id: string, scene: Scene34) => SEEDS_3.map(seed => cells.find(one => one.id === id && one.scene === scene && one.seed === seed)!);
  const idsOf = (scene: Scene34) => questions.scenes![scene].people.map(person => ID_4[person.person]);
  // Per frame, over the scene's people: identity matches, the people whose identity is `same`; builds, the scored parts
  // whose build_front is `same`; words, the word targets `as given`. NaN where the frame was not judged.
  const identityOf = (cell: Cell3) => (cell.judged ? idsOf(cell.scene).filter(who => cell.people[who].identity === 'same').length : NaN);
  const buildOf = (cell: Cell3) => (cell.judged ? sum(idsOf(cell.scene).map(who => SCORED_4.filter(part => cell.people[who].front?.[part] === 'same').length)) : NaN);
  const wordsOf = (cell: Cell3) => (cell.judged ? sum(idsOf(cell.scene).map(who => targetsOf(questions, who).filter(part => cell.people[who].words?.[part] === 'as given').length)) : NaN);
  const suitOf = (cell: Cell3) => (cell.judged ? idsOf(cell.scene).filter(who => ['yes', 'partly'].includes(cell.people[who].suit ?? '')).length : NaN);
  const clothesOf = (cell: Cell3) => (cell.judged ? idsOf(cell.scene).filter(who => cell.people[who].sceneClothes === 'yes').length : NaN);
  const anatomyOf = (cell: Cell3) => (cell.judged ? sum(idsOf(cell.scene).map(who => cell.people[who].anatomy)) : NaN);
  const arms = SCENES_3.flatMap(scene => CELLS_3.map(id => {
    const all = row(id, scene), got = all.filter(cell => cell.judged), drafted = all.filter(cell => cell.drafted), ids = idsOf(scene);
    const frontValues = got.flatMap(cell => ids.flatMap(who => SCORED_4.map(part => cell.people[who].front?.[part])));
    const wordValues = got.flatMap(cell => ids.flatMap(who => targetsOf(questions, who).map(part => cell.people[who].words?.[part])));
    const front = tally(frontValues, FRONT_VALUES), words = tally(wordValues, WORDS_VALUES);
    const frontAssessable = frontValues.length - front['not seen'], wordsAssessable = wordValues.length - words['not seen'] - words['not specified'];
    return { id, scene, judged: got.length, drafted: drafted.length, countRight: got.filter(cell => cell.countRight).length,
      heights: tally(got.map(cell => cell.heights), answersOf('frame', 'heights')), touchFound: got.filter(cell => cell.touchFound).length,
      touchExtras: sum(got.map(cell => cell.touchExtras)), identity: sum(got.map(identityOf)), identityOf: got.length * ids.length,
      build: front.same, buildSlots: frontValues.length, front, frontAssessable, frontFraction: frontAssessable ? front.same / frontAssessable : undefined,
      words: words['as given'], wordTargets: wordValues.length, wordCounts: words, wordsAssessable, wordsFraction: wordsAssessable ? words['as given'] / wordsAssessable : undefined,
      suit: sum(got.map(suitOf)), sceneClothes: sum(got.map(clothesOf)), pose: sum(got.map(cell => ids.filter(who => cell.people[who].pose === 'yes').length)),
      anatomy: got.filter(cell => ids.some(who => cell.people[who].anatomy)).length, draftKept: tally(drafted.map(cell => cell.draftKept), answersOf('S', 'draft_kept')),
      moved: tally(drafted.flatMap(cell => ids.map(who => cell.people[who].moved)), MOVED_34),
      people: Object.fromEntries(ids.map(who => {
        const targets = targetsOf(questions, who);
        return [who, { identity: tally(got.map(cell => cell.people[who].identity), IDENTITY_VALUES),
          front: tally(got.flatMap(cell => SCORED_4.map(part => cell.people[who].front?.[part])), FRONT_VALUES),
          words: tally(got.flatMap(cell => targets.map(part => cell.people[who].words?.[part])), WORDS_VALUES), targets: targets.length * got.length,
          height: { front: tally(got.map(cell => cell.people[who].front?.height), FRONT_VALUES), words: tally(got.map(cell => cell.people[who].words?.height), WORDS_VALUES) },
          suit: tally(got.map(cell => cell.people[who].suit), answersOf('frame', 'reference_clothes')),
          sceneClothes: tally(got.map(cell => cell.people[who].sceneClothes), answersOf('frame', 'scene_clothes')),
          pose: tally(got.map(cell => cell.people[who].pose), answersOf('frame', 'pose')), anatomy: sum(got.map(cell => cell.people[who].anatomy)),
          moved: tally(drafted.map(cell => cell.people[who].moved), MOVED_34),
          parts: Object.fromEntries(SCORED_4.map(part => [part, tally(got.map(cell => cell.people[who].front?.[part]), FRONT_VALUES)])) }];
      })),
      perSeed: all.map(cell => ({ seed: cell.seed, identity: identityOf(cell), build: buildOf(cell), words: wordsOf(cell), suit: suitOf(cell), sceneClothes: clothesOf(cell),
        anatomy: anatomyOf(cell) })) };
  }));
  type Arm3 = typeof arms[number];
  const armOf = (id: string, scene: Scene34) => arms.find(one => one.id === id && one.scene === scene)!;
  const compare = (x: string, y: string, scene: Scene34, measure: 'identity' | 'build' | 'words') => pairwise(armOf(x, scene).perSeed.map(one => one[measure]),
    armOf(y, scene).perSeed.map(one => one[measure]), SEEDS_3.length);
  const matrices = SCENES_3.flatMap(scene => (['identity', 'build'] as const).map(measure => ({ scene, measure,
    rows: CELLS_3.map(x => ({ x, against: CELLS_3.map(y => (x === y ? undefined : compare(x, y, scene, measure))) })) })));
  const pairs = SCENES_3.flatMap(scene => CELLS_3.flatMap(x => ['R', 'W'].filter(y => y !== x).map(y => ({ x, y, scene, identity: compare(x, y, scene, 'identity'),
    build: compare(x, y, scene, 'build'), words: compare(x, y, scene, 'words') }))));
  const decisions: Decision34[] = [];
  const decide = (question: string, needs: Cell3[], verdict: () => [boolean, string, string?], drafted: Cell3[] = []) => {
    const gap = [...needs.filter(cell => !cell.judged), ...drafted.filter(cell => !cell.drafted)].map(cell => cell.key);
    if (gap.length) { decisions.push({ question, verdict: 'undecided', why: `not judged: ${[...new Set(gap)].join(', ')}` }); return; }
    const [yes, why, winner] = verdict();
    decisions.push({ question, verdict: yes ? 'yes' : 'no', why, ...(winner ? { winner } : {}) });
  };
  const measureName = { identity: 'confirmed identity matches', build: 'confirmed build matches' } as const;
  // 1. The best arm on confirmed identity matches and on confirmed build matches, in each scene: the one arm above every
  // other arm, or no unique best arm.
  for (const scene of SCENES_3) {
    for (const measure of ['identity', 'build'] as const) {
      const winner = CELLS_3.find(x => CELLS_3.every(y => x === y || above(compare(x, y, scene, measure))));
      const totals = CELLS_3.map(id => `${id} ${armOf(id, scene)[measure]} of ${measure === 'identity' ? armOf(id, scene).identityOf : armOf(id, scene).buildSlots}`).join(', ');
      decide(`${scene}: the best arm on ${measureName[measure]}, above every other arm`, CELLS_3.flatMap(id => row(id, scene)), () => [!!winner,
        `${winner ? `${winner} is above every other arm` : 'no unique best arm (the pairwise matrix is in the tables)'}; totals ${totals}`, winner]);
    }
  }
  // 2. S's edit reshapes the figures toward their references at a level: at least 16 of the 30 figure_moved answers
  // toward the front, and in each scene S2's confirmed builds at least W's with at least as many seeds ahead as behind.
  for (const level of ['55', '80']) {
    const id = `S2-${level}`;
    decide(`S2-${level}: the edit reshapes the figures toward their fronts`, SCENES_3.flatMap(scene => [...row(id, scene), ...row('W', scene)]), () => {
      const moved = SCENES_3.flatMap(scene => idsOf(scene).flatMap(who => row(id, scene).map(cell => cell.people[who].moved)));
      const toward = count34(moved, 'toward the front');
      const builds = SCENES_3.map(scene => ({ scene, build: compare(id, 'W', scene, 'build'), identity: compare(id, 'W', scene, 'identity') }));
      return [toward >= 16 && builds.every(one => atLeast(one.build)), `figure_moved over both scenes ${counts34(tally(moved, MOVED_34))} (${MOVED_34.join('/')}), `
        + `${toward} of ${moved.length} toward the front; `
        + builds.map(one => `${shortOf(one.scene)} builds against W ${pairText(one.build)}; identity matches against W ${pairText(one.identity)}; draft kept `
          + `${counts34(armOf(id, one.scene).draftKept)}`).join('; ')];
    }, SCENES_3.flatMap(scene => row(id, scene)));
  }
  // 3. What the cleanup changes: S3 against S2 at each level, scene and seed, with no rule deciding. figure_moved sets
  // each picture against W, not S3 against S2.
  const cleanup = ['55', '80'].flatMap(level => SCENES_3.map(scene => {
    const s2 = row(`S2-${level}`, scene), s3 = row(`S3-${level}`, scene);
    const minus = (measure: (cell: Cell3) => number) => s3.map((cell, at) => measure(cell) - measure(s2[at]));
    return { level, scene, identity: minus(identityOf), build: minus(buildOf), words: minus(wordsOf), suit: minus(suitOf), sceneClothes: minus(clothesOf),
      anatomy: minus(anatomyOf), moved: [armOf(`S2-${level}`, scene).moved, armOf(`S3-${level}`, scene).moved],
      draftKept: [armOf(`S2-${level}`, scene).draftKept, armOf(`S3-${level}`, scene).draftKept] };
  }));
  // 4. FC and FV against R, the bot's frame: in each scene, above R on identity matches or on builds, and on each at
  // least R's total with at least as many seeds ahead as behind.
  for (const id of ['FC', 'FV']) {
    decide(`${id} is better than R on the measured identity and build outcomes`, SCENES_3.flatMap(scene => [...row(id, scene), ...row('R', scene)]), () => {
      const got = SCENES_3.map(scene => ({ scene, identity: compare(id, 'R', scene, 'identity'), build: compare(id, 'R', scene, 'build') }));
      return [got.every(one => (above(one.identity) || above(one.build)) && atLeast(one.identity) && atLeast(one.build)),
        got.map(one => `${shortOf(one.scene)} identity matches ${pairText(one.identity)}; builds ${pairText(one.build)}`).join('; ')];
    });
  }
  const fronts = (['B', 'T'] as Who4[]).map(who => {
    const got = facts.fronts.get(FRONTS[who]);
    return { person: ID_4[who], judged: !!got, count: got?.count, build: got?.build, parts: got ? tally(PARTS_4.map(part => got.build[part]), answersOf('front', 'build')) : undefined,
      faceHairSkin: got?.face_hair_skin, clothes: got?.clothes, wholeBody: got?.whole_body, anatomy: got?.anatomy };
  });
  const scoreArm = (one: Arm3) => one;
  return { arms: arms.map(scoreArm), matrices, pairs, cleanup, fronts, decisions, cells };
}

// The fourth stand's tallies per view over the four seeds and per picture, and whether each turn turns as asked: yes at
// three of the four seeds or more, and no at none, for every person.
function score4(facts: Facts34) {
  const views = WHO_4.flatMap(who => TURNS_4.map(turn => {
    const id = viewId(who, turn), got = SEEDS_4.map(seed => ({ seed, facts: facts.turns.get(viewKeyOf(id, seed)) }));
    const judged = got.flatMap(one => (one.facts ? [one.facts] : []));
    const scored = judged.flatMap(one => SCORED_4.map(part => one.build[part]));
    return { person: ID_4[who], turn, id, judged: judged.length, turned: tally(judged.map(one => one.turn), answersOf('view', 'turn')),
      identity: tally(judged.map(one => one.identity), IDENTITY_VALUES), build: tally(scored, FRONT_VALUES), slots: scored.length,
      height: tally(judged.map(one => one.build.height), FRONT_VALUES), clothes: tally(judged.map(one => one.clothes_kept), answersOf('view', 'clothes_kept')),
      backdrop: count34(judged.map(one => one.backdrop_kept), 'yes'), wholeBody: count34(judged.map(one => one.whole_body), 'yes'),
      single: judged.filter(one => one.count === 1).length, anatomy: judged.filter(one => one.anatomy.length).length,
      pictures: got.map(one => ({ seed: one.seed, turn: one.facts?.turn, identity: one.facts?.identity,
        build: one.facts ? tally(SCORED_4.map(part => one.facts!.build[part]), FRONT_VALUES) : undefined, height: one.facts?.build.height })),
      parts: Object.fromEntries(SCORED_4.map(part => [part, tally(judged.map(one => one.build[part]), FRONT_VALUES)])) };
  }));
  const decisions: Decision34[] = [];
  for (const turn of TURNS_4) {
    const rows = views.filter(one => one.turn === turn);
    const question = `${turn} turns as asked: yes at three of the four seeds or more, and no at none, for every person`;
    if (rows.some(one => one.judged < SEEDS_4.length)) decisions.push({ question, verdict: 'undecided', why: `not judged: ${rows.filter(one => one.judged < SEEDS_4.length).map(one => one.id).join(', ')}` });
    else decisions.push({ question, verdict: rows.every(one => one.turned.yes >= 3 && one.turned.no === 0) ? 'yes' : 'no',
      why: rows.map(one => `${one.person} yes ${one.turned.yes}, partly ${one.turned.partly}, no ${one.turned.no}`).join('; ') });
  }
  return { views, decisions };
}

export function scoreStand34(run: string, dir = judgeDirOf(run)) {
  const stand = standOf(run) as Stand34, questions = readQuestions(run), facts = readFacts34(dir, join(judgeDirOf(run), 'keys'));
  const base = { stand, questions: questionsPin34(), sessions: facts.sessions, excluded: [...facts.excluded].map(([key, sessions]) => ({ key, sessions })) };
  if (stand === 4) {
    const four = score4(facts);
    return { ...base, judged: facts.turns.size, decisions: four.decisions, four, three: undefined };
  }
  const three = score3(questions, facts);
  return { ...base, judged: three.cells.filter(cell => cell.judged).length, decisions: three.decisions, three, four: undefined };
}
export type Score34 = ReturnType<typeof scoreStand34>;

const fraction34 = (value: number | undefined) => (value === undefined ? 'unavailable' : `${Math.round(value * 100)}%`);
export function scoreTables34(score: Score34): string {
  const lines: string[] = [];
  const row = (cells: (string | number | undefined)[]) => lines.push(`| ${cells.map(cell => (cell === undefined ? '-' : String(cell))).join(' | ')} |`);
  const head = (cells: string[]) => { row(cells); row(cells.map(() => '---')); };
  lines.push(`Questions ${score.questions}; sessions answered ${score.sessions.answered} of ${score.sessions.planned}; judged ${score.judged}; left out as not clean `
    + `${score.excluded.length ? score.excluded.map(one => `${one.key} (${one.sessions.join(', ')})`).join(', ') : 'none'}.`, '');
  lines.push('Above, below and neither are descriptive results for these sampled scenes and seeds. Neither does not mean equal, equivalent or non-inferior. People and body parts within a picture are not independent repetitions. No population-level or statistical-significance claim follows from these verdicts.', '');
  lines.push('### The rules', '');
  head(['question', 'verdict', 'winner', 'evidence']);
  for (const one of score.decisions) row([one.question, one.verdict, one.winner, one.why]);
  lines.push('');
  if (score.three) {
    const three = score.three;
    for (const scene of SCENES_3) {
      const arms = three.arms.filter(arm => arm.scene === scene);
      lines.push(`### ${scene}: each arm over the six seeds`, '');
      head(['arm', 'frames judged', 'identity matches', 'builds: same of scored slots', 'less/more/different/not seen', 'assessable', 'same of assessable',
        'words: as given of targets', 'less/more/different/not seen/not specified', 'as given of assessable']);
      for (const one of arms) {
        row([one.id, one.judged, `${one.identity} of ${one.identityOf}`, `${one.build} of ${one.buildSlots}`,
          [one.front.less, one.front.more, one.front.different, one.front['not seen']].join('/'), one.frontAssessable, fraction34(one.frontFraction),
          `${one.words} of ${one.wordTargets}`, [one.wordCounts.less, one.wordCounts.more, one.wordCounts.different, one.wordCounts['not seen'], one.wordCounts['not specified']].join('/'),
          fraction34(one.wordsFraction)]);
      }
      lines.push('', `${scene}, the scene's words (scene fidelity):`, '');
      head(['arm', 'count right', 'heights yes/no/not seen', 'the required contact', 'extra contacts', 'scene\'s clothes yes', 'pose yes', 'suit yes or partly',
        'frames with an anatomy error', 'draft kept yes/partly/no', 'figure moved toward/as in the draft/away/mixed/not seen']);
      for (const one of arms) {
        row([one.id, one.countRight, counts34(one.heights), scene === 'K-trio' ? one.touchFound : '-', one.touchExtras, one.sceneClothes, one.pose, one.suit, one.anatomy,
          S_CELLS.includes(one.id) ? counts34(one.draftKept) : '-', S_CELLS.includes(one.id) ? counts34(one.moved) : '-']);
      }
      lines.push('');
      for (const who of Object.keys(arms[0].people)) {
        lines.push(`${scene}, ${who}:`, '');
        head(['arm', 'identity same/similar/different/not seen/missing', 'build_front same/less/more/different/not seen', 'build_words as given/less/more/different/not seen/not specified',
          'word targets', 'height: front / words', 'suit no/partly/yes/not seen', 'scene\'s clothes yes/partly/no', 'pose yes/partly/no', 'anatomy', 'figure moved toward/as in the draft/away/mixed/not seen']);
        for (const one of arms) {
          const person = one.people[who];
          row([one.id, counts34(person.identity), counts34(person.front), counts34(person.words), person.targets, `${counts34(person.height.front)} / ${counts34(person.height.words)}`,
            counts34(person.suit), counts34(person.sceneClothes), counts34(person.pose), person.anatomy, S_CELLS.includes(one.id) ? counts34(person.moved) : '-']);
        }
        lines.push('');
        head(['build_front: same/less/more/different/not seen', ...CELLS_3]);
        for (const part of SCORED_4) row([part, ...CELLS_3.map(id => counts34(arms.find(arm => arm.id === id)!.people[who].parts[part]))]);
        lines.push('');
      }
      lines.push(`${scene}, seed by seed (identity matches / builds / words as given):`, '');
      head(['arm', ...SEEDS_3.map(seed => `s${seed}`)]);
      for (const one of arms) row([one.id, ...one.perSeed.map(seed => (Number.isNaN(seed.identity) ? '-' : `${seed.identity} / ${seed.build} / ${seed.words}`))]);
      lines.push('');
      for (const matrix of three.matrices.filter(one => one.scene === scene)) {
        lines.push(`${scene}, ${matrix.measure === 'identity' ? 'confirmed identity matches' : 'confirmed build matches'}: the row's arm against the column's`, '');
        head(['', ...CELLS_3]);
        for (const one of matrix.rows) row([one.x, ...one.against.map(pair => (pair ? pairReading(pair) : ''))]);
        lines.push('');
      }
    }
    lines.push('### Each arm against R and W, seed by seed', '');
    head(['scene', 'arm', 'against', 'identity matches', 'builds', 'words as given']);
    for (const one of three.pairs) row([one.scene, one.x, one.y, pairText(one.identity), pairText(one.build), pairText(one.words)]);
    lines.push('', '### The cleanup: S3 minus S2, seed by seed', '',
      'figure_moved sets each picture against W, the draft, not S3 against its S2.', '');
    head(['level', 'scene', 'identity matches', 'builds', 'words as given', 'suit yes or partly', 'scene\'s clothes yes', 'people with an anatomy error',
      'draft kept S2 → S3', 'figure moved S2 → S3 (toward/as in the draft/away/mixed/not seen)']);
    const signed = (values: number[]) => values.map(value => (Number.isNaN(value) ? '-' : value > 0 ? `+${value}` : String(value))).join(' ');
    for (const one of three.cleanup) {
      row([one.level, one.scene, signed(one.identity), signed(one.build), signed(one.words), signed(one.suit), signed(one.sceneClothes), signed(one.anatomy),
        `${counts34(one.draftKept[0])} → ${counts34(one.draftKept[1])}`, `${counts34(one.moved[0])} → ${counts34(one.moved[1])}`]);
    }
    lines.push('', '### B\'s and T\'s fronts, against their words', '',
      'Unspecified targets and unobservable stature are not failures. These fronts provide no shared physical scale for judging tall versus short.', '');
    head(['person', 'count', 'as given/less/more/different/not seen/not specified', 'face, hair, skin', 'clothes', 'whole body', 'anatomy', 'parts']);
    for (const one of three.fronts) {
      row(one.judged ? [one.person, one.count, counts34(one.parts!), one.faceHairSkin, one.clothes, one.wholeBody, one.anatomy!.join(', ') || 'none',
        Object.entries(one.build ?? {}).map(([part, value]) => `${part} ${value}`).join(', ')] : [one.person, 'not judged']);
    }
  }
  if (score.four) {
    lines.push('### Each view over the four seeds', '', 'The turn verdict concerns the requested pose only. A successful turn does not establish preservation of the person; a correct back view cannot establish facial likeness.', '');
    head(['person', 'turn', 'judged', 'turn yes/partly/no', 'identity same/similar/different/not seen/missing', 'build_front same/less/more/different/not seen (scored parts)',
      'height', 'clothes kept yes/partly/no', 'backdrop kept', 'whole body', 'one person', 'anatomy']);
    for (const one of score.four.views) {
      row([one.person, one.turn, one.judged, counts34(one.turned), counts34(one.identity), `${counts34(one.build)} of ${one.slots}`, counts34(one.height), counts34(one.clothes),
        one.backdrop, one.wholeBody, one.single, one.anatomy]);
    }
    lines.push('', 'Each picture: the turn, the identity and the build, side by side:', '');
    head(['person', 'turn', ...SEEDS_4.map(seed => `s${seed}: turn, identity, build same/less/more/different/not seen`)]);
    for (const one of score.four.views) {
      row([one.person, one.turn, ...one.pictures.map(picture => (picture.turn === undefined ? '-' : `${picture.turn}, ${picture.identity}, ${counts34(picture.build!)}`))]);
    }
    lines.push('', 'Parts, each view over the four seeds (same/less/more/different/not seen):', '');
    head(['person', 'turn', ...SCORED_4]);
    for (const one of score.four.views) row([one.person, one.turn, ...SCORED_4.map(part => counts34(one.parts[part]))]);
  }
  return lines.join('\n') + '\n';
}

// ---- The third and fourth stands' agreement ----

// Two passes over the same bundles, question by question, as the review asked: schema-valid completion and clean
// agreement first; then, for pictures clean in both passes only, the same answer (lists compared without regard to
// order), the same assessability (neither `not seen`, `missing` nor `not specified`), and the success reading (identity
// same, a part as given or the same, the suit no, the figure toward the front, the count the scene's or one, the
// contacts the scene's, no anatomy item, and yes elsewhere) where both answers are assessable and the target is
// specified, with Cohen's kappa on it, undefined when its denominator is zero.
type Row34 = { family: string; n: number; exact: number; bothAssessable: number; assessability: number; read: number; reading?: number; kappa?: number;
  firstPositive: number; secondPositive: number; first: Record<string, number>; second: Record<string, number> };
export type Agreement34 = { completion: { planned: number; first: number; second: number; both: number };
  clean: { pictures: number; both: number; neither: number; differ: number; eligible: number }; rows: Row34[] };
const UNASSESSABLE = ['not seen', 'missing', 'not specified'];
export function agreementOf34(run: string, first: string, second: string): Agreement34 {
  const questions = readQuestions(run), byKey = new Map(questions.cells.map(cell => [cell.key, cell]));
  const names = existsSync(join(first, 'keys')) ? readdirSync(join(first, 'keys')).filter(name => name.endsWith('.json')).sort() : [];
  const completion = { planned: names.length, first: 0, second: 0, both: 0 }, clean = { pictures: 0, both: 0, neither: 0, differ: 0, eligible: 0 };
  const excluded = new Set([...readFacts34(first, join(first, 'keys')).excluded.keys(), ...readFacts34(second, join(first, 'keys')).excluded.keys()]);
  const pairs: { family: string; a: string; b: string; assessable: [boolean, boolean]; specified: boolean; read: [boolean, boolean] }[] = [];
  const normal = (value: unknown) => (Array.isArray(value) ? JSON.stringify(value.map(one => (typeof one === 'string' ? one : touchKey(one as Touch34))).sort()) : String(value));
  for (const file of names) {
    const key = readJson<SessionKey>(join(first, 'keys', file)), a = readJson<Ans>(join(first, 'answers', file)), b = readJson<Ans>(join(second, 'answers', file));
    if (a) completion.first++;
    if (b) completion.second++;
    if (!key || !a || !b) continue;
    completion.both++;
    const scene = key.scene as Scene34 | undefined, expectedCount = scene ? questions.scenes![scene].count : 1;
    const expectedTouches = normal(scene ? REQUIRED_TOUCHES[scene] : []);
    for (const picture of key.pictures) {
      const x = (a.pictures as Record<string, Ans> | undefined)?.[picture.name], y = (b.pictures as Record<string, Ans> | undefined)?.[picture.name];
      clean.pictures++;
      const cx = x?.clean === 'yes', cy = y?.clean === 'yes';
      if (cx && cy) clean.both++; else if (!cx && !cy) clean.neither++; else clean.differ++;
      if (!cx || !cy || excluded.has(picture.key)) continue;
      clean.eligible++;
      // Each answer by its field, with the person it is about: a person's own, or the front's person.
      const flat = (answers: Ans) => {
        const out = new Map<string, { field: string; person?: string; value: unknown }>();
        const walk = (value: unknown, path: string[], person?: string) => {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
              if (name === 'clean') continue;
              if (path.length === 1 && path[0] === 'people') walk(inner, [], name);
              else walk(inner, [...path, name], person);
            }
          } else out.set(`${person ?? ''}/${path.join('.')}`, { field: path.join('.'), person, value });
        };
        walk(answers, []);
        return out;
      };
      const theirs = flat(y!), cellPerson = byKey.get(picture.key)?.person;
      for (const [id, mine] of flat(x!)) {
        const other = theirs.get(id);
        if (!other) continue;
        const family = `${key.kind}.${mine.field}`, [field, part] = mine.field.split('.');
        const person = mine.person ?? (cellPerson ? ID_4[cellPerson] : undefined);
        const specified = !part || !((key.kind === 'identity' && field === 'build_words') || (key.kind === 'fronts' && field === 'build'))
          || !person || targetsOf(questions, person).includes(part) || (part === 'height' && questions.people[WHO_4.find(one => ID_4[one] === person)!].build.height !== NOT_SAID);
        const good = (value: unknown) => (field === 'count' ? value === expectedCount : field === 'touches' ? normal(value) === expectedTouches
          : field === 'anatomy' ? Array.isArray(value) && !value.length : field === 'identity' ? value === 'same'
            : field === 'build_front' || (key.kind === 'turns' && field === 'build') ? value === 'same'
              : field === 'build_words' || (key.kind === 'fronts' && field === 'build') ? value === 'as given'
                : field === 'reference_clothes' ? value === 'no' : field === 'figure_moved' ? value === 'toward the front' : value === 'yes');
        const assessable = (value: unknown) => !UNASSESSABLE.includes(String(value));
        pairs.push({ family, a: normal(mine.value), b: normal(other.value), assessable: [assessable(mine.value), assessable(other.value)], specified,
          read: [good(mine.value), good(other.value)] });
      }
    }
  }
  const rows = [...new Set(pairs.map(one => one.family))].sort().map(family => {
    const all = pairs.filter(one => one.family === family), n = all.length;
    const read = all.filter(one => one.assessable[0] && one.assessable[1] && one.specified), m = read.length;
    const agree = read.filter(one => one.read[0] === one.read[1]).length;
    const pa = m ? read.filter(one => one.read[0]).length / m : 0, pb = m ? read.filter(one => one.read[1]).length / m : 0, expected = pa * pb + (1 - pa) * (1 - pb);
    const categories = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(one => one === value).length]));
    return { family, n, exact: all.filter(one => one.a === one.b).length / n, bothAssessable: all.filter(one => one.assessable[0] && one.assessable[1]).length,
      assessability: all.filter(one => one.assessable[0] === one.assessable[1]).length / n, read: m, reading: m ? agree / m : undefined,
      kappa: m && expected < 1 ? (agree / m - expected) / (1 - expected) : undefined, firstPositive: read.filter(one => one.read[0]).length,
      secondPositive: read.filter(one => one.read[1]).length, first: categories(all.map(one => one.a)), second: categories(all.map(one => one.b)) };
  });
  return { completion, clean, rows };
}
export function agreementTable34(agreement: Agreement34, first: JudgingRecord, second: JudgingRecord): string {
  const percent = (value: number | undefined) => (value === undefined ? 'undefined' : `${Math.round(value * 100)}%`);
  const names = Object.keys(second.sessions).sort();
  const timing = (record: JudgingRecord) => {
    const counts = judgingCounts(record, names);
    return `${record.model}: ${counts.states.answered ?? 0} of ${counts.sessions} sessions answered in ${counts.attempts} attempts, refusals ${counts.refusals}, `
      + `answers that did not fit ${counts.invalid}, codex failures ${counts.codexFailed}, fallback attempts ${counts.fallback}, median ${counts.medianMs === undefined ? '-' : `${(counts.medianMs / 60000).toFixed(1)} min`} an answered session`;
  };
  // Each answer's count, the most frequent first; a list's answers beyond the eighth are summed.
  const categories = (value: Record<string, number>) => {
    const sorted = Object.entries(value).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), rest = sorted.slice(8);
    return [...sorted.slice(0, 8).map(([name, n]) => `${name.length > 60 ? `${name.slice(0, 57)}...` : name} ${n}`),
      ...(rest.length ? [`${rest.length} other answers ${sum(rest.map(([, n]) => n))}`] : [])].join('; ');
  };
  const { completion, clean } = agreement;
  return [`First: ${timing(first)}, on the same sessions.`, `Second: ${timing(second)}.`, '',
    `Schema-valid completion: the first pass ${completion.first} of ${completion.planned} sessions, the second ${completion.second}, both ${completion.both}.`,
    `Clean, per picture of a session answered in both: ${clean.pictures} pictures, clean in both ${clean.both}, not clean in both ${clean.neither}, clean in one only ${clean.differ}; `
      + `eligible in both passes (clean here and left out by no session of either pass) ${clean.eligible}.`, '',
    'Only pictures eligible in both passes enter below. The same answer compares lists without regard to order. Assessable: neither not seen, missing nor not specified. The success reading (identity same, a part as given or the same, the suit no, the figure toward the front, the count the scene\'s or one, the contacts the scene\'s, no anatomy item, and yes elsewhere) is compared only where both answers are assessable and the part\'s words say something. This measures the repeatability of this judge and setup, not its accuracy or agreement between different judges.', '',
    '| question | pairs | same answer | both assessable | same assessability | pairs read | same reading | kappa | first, read positive | second, read positive | first: answers | second: answers |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...agreement.rows.map(one => `| ${one.family} | ${one.n} | ${percent(one.exact)} | ${one.bothAssessable} | ${percent(one.assessability)} | ${one.read} | ${percent(one.reading)} | `
      + `${one.kappa === undefined ? 'undefined' : one.kappa.toFixed(2)} | ${one.firstPositive} | ${one.secondPositive} | ${categories(one.first)} | ${categories(one.second)} |`)]
    .join('\n') + '\n';
}

// How far a second pass moves the score: each rule's verdict and winner, undecided included; per arm and scene the
// totals the rules read; per person and frame how far the confirmed builds moved and whether identity kept its answer;
// per view the turns, identity matches and builds.
export function scoreMoved34(first: Score34, second: Score34) {
  const verdicts = first.decisions.map(one => {
    const other = second.decisions.find(decision => decision.question === one.question);
    return { question: one.question, first: one.verdict + (one.winner ? ` (${one.winner})` : ''), second: other ? other.verdict + (other.winner ? ` (${other.winner})` : '') : 'missing' };
  });
  if (first.three && second.three) {
    const arms = first.three.arms.map(one => {
      const other = second.three!.arms.find(arm => arm.id === one.id && arm.scene === one.scene)!;
      return { id: one.id, scene: one.scene, identity: [one.identity, other.identity], build: [one.build, other.build], words: [one.words, other.words], of: [one.identityOf, one.buildSlots] };
    });
    const moves: number[] = [], identity: boolean[] = [];
    for (const cell of first.three.cells) {
      const other = second.three.cells.find(one => one.key === cell.key);
      if (!cell.judged || !other?.judged) continue;
      for (const who of Object.keys(cell.people)) {
        const same = (person: Person3) => SCORED_4.filter(part => person.front?.[part] === 'same').length;
        moves.push(Math.abs(same(cell.people[who]) - same(other.people[who])));
        identity.push(cell.people[who].identity === other.people[who].identity);
      }
    }
    return { verdicts, arms, partMoves: tally(moves.map(value => String(Math.min(value, 3))), ['0', '1', '2', '3']), identitySame: identity.filter(Boolean).length,
      identityPairs: identity.length, views: undefined };
  }
  const views = first.four!.views.map(one => {
    const other = second.four!.views.find(view => view.id === one.id)!;
    return { id: one.id, turned: [one.turned.yes, other.turned.yes], same: [one.build.same, other.build.same], identity: [one.identity.same, other.identity.same] };
  });
  return { verdicts, arms: undefined, partMoves: undefined, identitySame: undefined, identityPairs: undefined, views };
}
export function movedTable34(moved: ReturnType<typeof scoreMoved34>): string {
  const lines: string[] = [];
  const row = (cells: (string | number | undefined)[]) => lines.push(`| ${cells.map(cell => (cell === undefined ? '-' : String(cell))).join(' | ')} |`);
  const head = (cells: string[]) => { row(cells); row(cells.map(() => '---')); };
  head(['rule', 'first pass', 'second pass']);
  for (const one of moved.verdicts) row([one.question, one.first, one.second]);
  lines.push('');
  if (moved.arms) {
    lines.push(`Identity kept its answer at ${moved.identitySame} of ${moved.identityPairs} person-frames; the confirmed builds moved per person-frame by 0, 1, 2 and 3 or more: `
      + `${Object.values(moved.partMoves!).join(', ')}.`, '');
    head(['arm', 'scene', 'identity matches first → second', 'builds first → second', 'words as given first → second']);
    for (const one of moved.arms) row([one.id, one.scene, `${one.identity.join(' → ')} of ${one.of[0]}`, `${one.build.join(' → ')} of ${one.of[1]}`, one.words.join(' → ')]);
  } else {
    head(['view', 'turn yes first → second', 'build same first → second', 'identity same first → second']);
    for (const one of moved.views!) row([one.id, one.turned.join(' → '), one.same.join(' → '), one.identity.join(' → ')]);
  }
  return lines.join('\n') + '\n';
}

// ---- The tester stand ----

// The fifth stand (docs/action-experiment.md#tester-stand), the tester's two complaints of 2026-09-28 as the seven clean
// stories of examples/tester-stand.ts: each story's frames of one seed side by side in one session, its arms' three
// answers each, nine pictures (six in V-face, whose PN is P). `pov`, the four stories seen through the viewer's eyes,
// against where each story puts its people; `dress`, the three by the lake, against what each story gives its people
// to wear, beside each person's front in the portrait's grey suit. Its question file, as build-texts.ts in
// ~/simple-story-chat-runs/2026-09-28/tester-stand wrote it beside the stand's texts.json, holds what the judges are
// told of the people, the viewer and the stories, and every cell with the pictures it took; the questions are ASKED_5's.
const QUESTIONS_SHA256_5 = '3e49adba26aae01ea4f6e3ae1ba08ed5963f82814617be3a5f82abad3af4d351';
export const RANKS_5 = ['T5'] as const;
type Kind5 = 'pov' | 'dress';
export const BODY_5: BarePart[] = ['chest and belly', 'arms', 'legs', 'feet'];
const SIDE_STORIES: CaseId[] = ['V-squeeze', 'V-walk', 'V-behind'], POV_STORIES: CaseId[] = [...SIDE_STORIES, 'V-face'];
const DRESS_STORIES: CaseId[] = ['C-bare', 'C-outfit', 'C-swim'];
type Place5 = { person: Who4; where: string; side: string; view: 'part' | 'whole'; clothes: string };
type Dressed5 = { person: Who4; clothes: string; bare: BarePart[]; covered: BarePart[] };
type Story5 = { family: 'pov'; intent: string; count: number; people: Place5[] } | { family: 'clothes'; intent: string; count: number; people: Dressed5[] };
type QCell5 = { key: string; case: CaseId; arm: Arm; answer: number; seed: number; file: string; references: QRef[] };
type QuestionFile5 = { stand: string; portraitClothes: string; people: Record<Who4, { id: string; name: string; look: string; front: { key: string; run: string } }>;
  viewer: { name: string; seen: string }; cases: Record<CaseId, Story5>; cells: QCell5[] };
// The stand's question file, only as the pin has it.
export function readQuestions5(run: string): QuestionFile5 {
  if (standOf(run) !== 5) throw new Refusal('only the tester stand is judged from this question file');
  const file = join(resolve(run), 'judge-questions.json');
  if (!existsSync(file)) throw new Refusal(`${file} is missing: build-texts.ts writes it beside the stand's texts.json`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== QUESTIONS_SHA256_5) throw new Refusal(`${file} is not the question file image-refs-judge.ts pins; nothing is judged from it`);
  return JSON.parse(bytes.toString('utf8')) as QuestionFile5;
}

// The questions, each in the words the tasks ask it, with the answers it allows, as the one GPT-6 Astra review of
// 2026-09-28 left them (docs/action-experiment.md#tester-stand): `side`, `in_view` and `facing` with firm boundaries and
// `both edges`; `found` with one figure for one person and position never a sign of who it is; `as_placed` with
// `unsure`; `clothes` with `not seen`, the suit's patch of grey, and `body` over what can be inspected, with `mixed`;
// and anatomy with the malformed limb its question names. The third and fourth stands' anatomy stays as it was.
const ANATOMY_ITEMS_5 = [...ANATOMY_ITEMS, 'malformed limb or finger'];
const ANATOMY_ASK_5 = `${ANATOMY_ASK} Use malformed limb or finger for a clearly malformed visible limb or digit that is not described by the extra/missing, impossible-joint or impossible-length categories.`;
const ANATOMY_LIST_5: Schema = { type: 'array', items: { type: 'string', enum: ANATOMY_ITEMS_5 } };
const ONE_FIGURE_5 = 'Identify people independently in each picture. Do not assign the same visible figure or body fragment to more than one person. If several figures fit equally well, or a fragment lacks distinguishing features, answer unsure. For the remaining fields, use the strongest candidate by visible identity cues; break an exact tie by choosing the leftmost candidate. Those answers remain conditional on an unsure identification.';
export const ASKED_5 = {
  instructions: {
    pov: 'The picture is the viewer\'s own view: the camera is the viewer\'s eyes, and the picture\'s left and right are the viewer\'s. The viewer may see parts of their own body from their own eyes; any other sight of the viewer is a figure seen from outside. Tell who is who by looks and clothes (hair, build, glasses, beard, what they wear), never by where they are: where they are is what you judge.',
    dress: 'Find each person by their looks (face, hair, build, glasses, beard), which their front shows. The fronts show who each person is, not what they should wear here. Judge only what the picture shows: do not guess at clothing hidden by something else, or at skin under clothing.',
    absentPov: 'If nothing of the person shows: found no, side and in_view not in the picture, facing not seen and as_placed not in the picture.',
    absentDress: 'If nobody in the picture is the person: found no, clothes no, suit not seen and every part of body not seen.',
  },
  pov: [
    { id: 'viewer', ask: 'Does the viewer show in the picture? not in the picture: nothing of them shows; own body only: only parts of their own body as they would see them from their own eyes, such as hands, forearms, knees or feet, or the edge of a shoulder or of their chest; seen from outside: the viewer drawn as someone else would see them, whole or in part (their face, the back of their head, their body from outside); unsure.',
      answers: ['not in the picture', 'own body only', 'seen from outside', 'unsure'] },
    { id: 'others', ask: 'Is anyone in the picture besides the story\'s people and the viewer? no; far off: only small figures in the distance; yes: someone nearer, taking part in the moment or close to the viewer.',
      answers: ['no', 'far off', 'yes'] },
    { id: 'anatomy', ask: `${ANATOMY_ASK_5} The viewer's own hands and arms count too.`, answers: 'a list, or none', values: ANATOMY_ITEMS_5 },
    { id: 'found', each: 'person', ask: `Is this person in the picture, whole or in part? yes: you can tell by their looks or clothes that a figure, or a part of one, is them; unsure: a figure or a part of one could be them, but you cannot tell; no: nothing of them shows. ${ONE_FIGURE_5} Distinctive clothing may establish identity even when no face is visible. Expected position alone may not establish identity. Do not select a candidate because their position better matches the story.`,
      answers: ['yes', 'unsure', 'no'] },
    { id: 'side', each: 'person', ask: 'Where in the picture is this person? left edge: the picture\'s left border cuts through their body; right edge: the right border cuts through their body; both edges: both the left and the right border cut through them. Edge categories take precedence over left, middle and right. Otherwise left, middle or right: the third of the picture\'s width that holds most of what shows of them; if two thirds contain equal amounts of their visible body, use the third containing the horizontal midpoint of their visible extent. not in the picture.',
      answers: ['left edge', 'left', 'middle', 'right', 'right edge', 'both edges', 'not in the picture'] },
    { id: 'in_view', each: 'person', ask: 'How much of this person is visible? most: more than half of their head and more than half of their torso from shoulders to waist are visible; part: anything less, including a head and shoulder, an isolated limb, or a torso without most of the head; not in the picture: nothing of them is visible. Count only visible anatomy, not anatomy inferred behind objects or beyond the crop. Ignore the direction their head faces.',
      answers: ['most', 'part', 'not in the picture'] },
    { id: 'facing', each: 'person', ask: 'Which way is the torso turned relative to the camera? Estimate the direction the chest faces: toward the viewer if it is within 45 degrees of facing the camera; side-on if it is more than 45 but less than 135 degrees away; away if it is at least 135 degrees away. not seen: too little torso is visible to estimate its direction. Judge the torso independently of the head. Orientation does not establish whether someone is beside, behind or opposite the viewer.',
      answers: ['toward the viewer', 'side-on', 'away', 'not seen'] },
    { id: 'as_placed', each: 'person', ask: 'Does the visible scene establish the person\'s stated relationship to the viewer? yes: the required beside, behind or across relationship, side, closeness and amount in view are supported by visible evidence. partly: the required beside, behind or across relationship is supported, but the side, closeness or framing contradicts the stated place. no: visible evidence contradicts the required beside, behind or across relationship. unsure: the person may be correctly placed, but the visible evidence cannot establish the relationship. not in the picture: nothing of the person is visible. A border crop alone does not establish that someone is beside or behind the viewer. A turned head alone does not establish that someone is opposite the viewer. An arm entering from beside the camera and reaching over the foreground may support a behind-the-shoulder placement even when its owner\'s torso is hidden.',
      answers: ['yes', 'partly', 'no', 'unsure', 'not in the picture'] },
  ] as Asked[],
  dress: [
    { id: 'count', ask: 'How many people are in the picture? Count everyone, whole or in part.', answers: 'a number' },
    { id: 'anatomy', ask: ANATOMY_ASK_5, answers: 'a list, or none', values: ANATOMY_ITEMS_5 },
    { id: 'found', each: 'person', ask: `Is this person in the picture? yes: you can tell by their looks that a figure is them; unsure: a figure could be them, but you cannot tell; no: nobody in the picture is them. ${ONE_FIGURE_5}`,
      answers: ['yes', 'unsure', 'no'] },
    { id: 'clothes', each: 'person', ask: 'Does the inspectable outfit match the story, including its required bare skin? yes: at least one diagnostic garment or required bare region is inspectable, and everything inspectable agrees with the specified garment types, colours and coverage. partly: some diagnostic requirements match and others visibly contradict the story. no: the inspectable outfit is different altogether, or none of its diagnostic requirements match. not seen: there is insufficient diagnostic evidence to assess the outfit. A face alone or a generic sleeve is insufficient. Hidden garments do not count as either matches or mismatches. Required bare regions, such as a bare chest, are part of this assessment.',
      answers: ['yes', 'partly', 'no', 'not seen'] },
    { id: 'suit', each: 'person', ask: 'Is clothing visibly identifiable as the front\'s dark grey one-piece athletic suit? yes: the suit is visibly present as the person\'s main outfit; partly: a recognizable portion of it replaces or shows beneath the story\'s clothes; no: no recognizable portion is visible; not seen: the relevant clothing cannot be inspected. Matching colour, ordinary dark shoes or grey trousers alone do not establish the presence of the suit, and a swimsuit the story gives is the suit only if it is the front\'s. Do not infer clothing beneath opaque garments. An isolated patch of grey fabric that could belong to several garments is not enough to identify the suit. Use not seen when no diagnostic clothing area can be inspected. Use no when the inspectable clothing provides no recognizable evidence of the suit. Neither answer establishes what is hidden beneath other garments.',
      answers: ['no', 'partly', 'yes', 'not seen'] },
    { id: 'body', each: 'person and part', ask: 'For each part of their body, judge only the portion of it that can be inspected. bare: the inspectable portion is bare skin; covered: it is covered by clothing; mixed: substantial areas of both bare skin and clothing are visible within the part; not seen: no portion can be inspected well enough to classify. Ignore small openings at ordinary necklines, cuffs and garment edges when deciding mixed. A sleeve ending partway along an arm, or a skirt ending partway along a leg, creates mixed coverage when both sides of that boundary are visible. For feet, bare means visibly without footwear; covered means visibly wearing footwear, including flat shoes with an open instep; mixed means visible feet have different footwear states. Clothing counts as coverage, not occlusion. Water, furniture, other people and the pose may prevent inspection. If skin or clothing is clearly visible through water, classify that visible portion; otherwise it is not seen. A result for a partly visible part describes only its inspectable portion. The parts: chest and belly, the front of the torso from the collarbones to the waist; arms, from the shoulders to the wrists, without the hands; legs, from the hips to the ankles, without the feet; feet. Combine the visible portions of both arms, both legs or both feet.',
      answers: ['bare', 'covered', 'mixed', 'not seen'], parts: BODY_5 },
  ] as Asked[],
};
type Group5 = 'pov' | 'dress';
function asked5(group: Group5, id: string): Asked {
  const one = ASKED_5[group].find(question => question.id === id);
  if (!one) throw new Error(`no question ${group}.${id}`);
  return one;
}
const ask5 = (group: Group5, id: string) => asked5(group, id).ask;
const enum5 = (group: Group5, id: string): Schema => ({ type: 'string', enum: asked5(group, id).answers as string[] });
const CLEAN_5 = 'clean: is it free of nudity and of sexual content? A man\'s bare chest, bare arms, legs or feet, and ordinary swimwear do not make a picture unclean. yes or no. If clean is no, still return every required field: 0 for a number, [] for a list, and for any other field the first value it allows from this ordered list: not seen, not in the picture, no, unsure. These values are placeholders only; the whole picture is left out.';
const PLACEHOLDER_ORDER_5 = ['not seen', 'not in the picture', 'no', 'unsure'];
export const TASKS_5: Record<Kind5, string> = {
  pov: `You judge pictures drawn for one moment of a story seen through one person's eyes, each against where the story puts the other people.

input.json holds:
- story: what the picture should show;
- viewer: the person through whose eyes the picture is seen: their name, and how anyone else would see them (seen);
- people: each other person of the story with their id, name, looks, the clothes they wear, and their place: where the story puts them against the viewer;
- pictures: the pictures' file names.
The pictures are in this folder and attached in the order input.json lists them.

${ASKED_5.instructions.pov}

For each picture:
1. ${CLEAN_5}
2. viewer: ${ask5('pov', 'viewer')}
3. others: ${ask5('pov', 'others')}
4. anatomy: ${ask5('pov', 'anatomy')} Name each error by the value form.json lists for it.
5. For each person of the story:
   - found: ${ask5('pov', 'found')}
   - side: ${ask5('pov', 'side')}
   - in_view: ${ask5('pov', 'in_view')}
   - facing: ${ask5('pov', 'facing')}
   - as_placed: ${ask5('pov', 'as_placed')}
   ${ASKED_5.instructions.absentPov}
The pictures may be compared with one another.

${ENDING_34}`,
  dress: `You judge pictures drawn for one moment of a story, each against what the story gives each person to wear.

input.json holds:
- story: what the picture should show;
- people: each person of the story with their id, name, looks, and the clothes the story gives them at this moment;
- fronts: each person's front picture: its file name and the id of the person it shows, ${FRONT_34};
- portrait_clothes: the portrait's clothes, which every front shows;
- pictures: the pictures' file names.
Everything is in this folder and attached: the pictures in the order input.json lists them, then the fronts in theirs.

${ASKED_5.instructions.dress}

For each picture:
1. ${CLEAN_5}
2. count: ${ask5('dress', 'count')} A whole number.
3. anatomy: ${ask5('dress', 'anatomy')} Name each error by the value form.json lists for it.
4. For each person of the story:
   - found: ${ask5('dress', 'found')}
   - clothes: ${ask5('dress', 'clothes')}
   - suit: ${ask5('dress', 'suit')}
   - body: ${ask5('dress', 'body')}
   ${ASKED_5.instructions.absentDress}
The pictures may be compared with one another.

${ENDING_34}`,
};
const pov5Schema = (names: string[], ids: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, viewer: enum5('pov', 'viewer'),
  others: enum5('pov', 'others'), anatomy: ANATOMY_LIST_5, people: each(ids, strict({ found: enum5('pov', 'found'), side: enum5('pov', 'side'),
    in_view: enum5('pov', 'in_view'), facing: enum5('pov', 'facing'), as_placed: enum5('pov', 'as_placed') })) })) });
const dress5Schema = (names: string[], ids: string[]): Schema => strict({ pictures: each(names, strict({ clean: YN, count: INT, anatomy: ANATOMY_LIST_5,
  people: each(ids, strict({ found: enum5('dress', 'found'), clothes: enum5('dress', 'clothes'), suit: enum5('dress', 'suit'),
    body: each(BODY_5, enum5('dress', 'body')) })) })) });
// Answers that use every value each field allows, as the review asked before the questions are frozen: the n-th set
// gives each field its n-th value, or its last, so that the sets together use them all.
function exercised5(schema: Schema): unknown[] {
  const most = (one: Schema): number => Math.max(one.enum?.length ?? 1, ...(one.items ? [most(one.items)] : []), ...Object.values(one.properties ?? {}).map(most));
  const pick = (one: Schema, n: number): unknown => one.enum ? one.enum[Math.min(n, one.enum.length - 1)] : one.type === 'integer' ? n
    : one.type === 'array' ? [pick(one.items!, n)] : Object.fromEntries(Object.entries(one.properties ?? {}).map(([key, value]) => [key, pick(value, n)]));
  return Array.from({ length: most(schema) }, (_, n) => pick(schema, n));
}
// The answers a picture that is not clean gets, by CLEAN_5's order.
function placeholder5(schema: Schema, name = ''): unknown {
  if (name === 'clean') return 'no';
  if (schema.enum) return PLACEHOLDER_ORDER_5.find(value => schema.enum!.includes(value));
  if (schema.type === 'integer') return 0;
  if (schema.type === 'array') return [];
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, placeholder5(value, key)]));
}
// What the fifth stand's questions are pinned to, as judgePins34 is for the third and fourth.
export function judgePins5(): Record<string, string> {
  const names = ['pic-0.png'], ids = ['mara', 'lina'];
  return { effort: JUDGE.effort, texts5: TEXTS_SHA256_5, questions5: QUESTIONS_SHA256_5, asked: sha256(JSON.stringify(ASKED_5)),
    ...Object.fromEntries(Object.entries(TASKS_5).map(([kind, text]) => [`task.${kind}`, sha256(text)])),
    'schema.pov': sha256(JSON.stringify(pov5Schema(names, ids))), 'schema.dress': sha256(JSON.stringify(dress5Schema(names, ids))) };
}
export const questionsPin5 = () => sha256(JSON.stringify(judgePins5()));

// The sessions in the order they run: seed by seed, so that a cut leaves every story judged at the seeds before it, and
// each story's cells in the plan's order, which the bundle sorts away.
export type SessionPlan5 = { name: string; kind: Kind5; rank: 'T5'; story: CaseId; seed: number; cells: string[] };
export function sessionPlan5(): SessionPlan5[] {
  const sessions = SEEDS_5.flatMap(seed => CASES.map(one => ({ kind: (one.family === 'pov' ? 'pov' : 'dress') as Kind5, story: one.id, seed,
    cells: armsOf(one.id).flatMap(arm => ANSWERS.map(answer => cellKey5(one.id, arm, answer, seed))) })));
  return sessions.map((one, at) => ({ name: `j${String(at + 1).padStart(2, '0')}-${one.kind}`, rank: 'T5' as const, ...one }));
}

// The fifth stand's bundles, written once, as the third's are: every cell of the question file against the stand's
// cells.json and every picture it took against the sha256 it recorded in that slot, read from that picture's own run; a
// cell the stand did not draw leaves its picture out, and a session left with no picture, or a `dress` session without
// a front it shows, is not built. The pictures and then the fronts go in the order of their names. Each bundle's form,
// schema and placeholder answers are checked together, with answers that use every value and against the pictures and
// people of its input, once every question is known to name each answer it allows; the questions are written beside
// the record.
function writeBundles5(run: string, log: (event: object) => void) {
  const questions = readQuestions5(run), dir = judgeDirOf(run), root = resolve(run, '..', '..');
  const unnamed = [...ASKED_5.pov, ...ASKED_5.dress].filter(one => Array.isArray(one.answers) && one.answers.some(value => !one.ask.includes(value)));
  if (unnamed.length) throw new Refusal(`the words of ${unnamed.map(one => one.id).join(', ')} do not name every answer they allow`);
  if (resolve(root, questions.stand) !== resolve(run)) throw new Refusal(`${run} is not where its question file puts the stand under the runs' root`);
  const cellOf = (key: string, file: string, refs: [number, string, string][]) => [key, CELLS_5.get(key)?.case, CELLS_5.get(key)?.arm, CELLS_5.get(key)?.answer,
    CELLS_5.get(key)?.seed, file, refs];
  if (!same5(questions.cells.map(one => [one.key, one.case, one.arm, one.answer, one.seed, one.file, one.references.map(ref => [ref.slot, ref.key, ref.how])]),
    PLANNED_5.map(one => cellOf(one.key, one.file, one.refs.map((ref, at) => [at + 1, ref.from, ref.how]))))) {
    throw new Refusal('the question file\'s cells are not the stand\'s, each with the pictures it takes');
  }
  const picture = runPictures(root), cells = (readJson<{ cells: Record<string, StandCell> }>(join(resolve(run), 'cells.json')) ?? { cells: {} }).cells;
  let checked = 0;
  for (const one of questions.cells) {
    const cell = cells[one.key];
    if (cell?.status !== 'drawn') continue;
    if (cell.file !== one.file || !picture(questions.stand, one.key)) throw new Refusal(`${one.key} is not drawn where the question file says`);
    const took = cell.references ?? [];
    if (took.length !== one.references.length) throw new Refusal(`${one.key} took ${took.length} pictures where the question file names ${one.references.length}`);
    for (const ref of one.references) {
      if (picture(ref.run, ref.key)?.sha256 !== took[ref.slot - 1]) throw new Refusal(`${one.key}'s picture ${ref.slot} (${ref.key}) is not the one it was drawn with`);
      checked++;
    }
  }
  const counts = { sessions: 0, built: 0, kept: 0, skipped: 0, missing: [] as string[], checked };
  for (const sub of ['bundles', 'keys']) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  writeJson(join(dir, 'questions.json'), { version: 1, stand: questions.stand, note: 'The questions the tester stand\'s judges are asked, word for word (ASKED_5 in local/image-refs-judge.ts). Synthetic.',
    ...ASKED_5 });
  const person = (who: Who4) => questions.people[who];
  for (const session of sessionPlan5()) {
    counts.sessions++;
    if (existsSync(join(dir, 'bundles', session.name))) { counts.kept++; continue; }
    const story = questions.cases[session.story], missing: string[] = [];
    const take = (from: string, key: string, prefix: 'pic' | 'ref') => {
      const file = picture(from, key);
      if (!file) { missing.push(key); return undefined; }
      return { name: `${prefix}-${file.sha256.slice(0, 8)}.png`, key, ...file };
    };
    const pictures = session.cells.flatMap(key => { const file = take(questions.stand, key, 'pic'); return file ? [file] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));
    const cast = story.people.map(one => one.person);
    const fronts = session.kind === 'dress' ? cast.flatMap(who => { const file = take(person(who).front.run, person(who).front.key, 'ref'); return file ? [{ ...file, person: who }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name)) : [];
    const shown = [...pictures, ...fronts];
    counts.missing.push(...missing.filter(key => !counts.missing.includes(key)));
    if (!pictures.length || (session.kind === 'dress' && fronts.length !== cast.length) || new Set(shown.map(file => file.name)).size !== shown.length) {
      counts.skipped++;
      log({ event: 'bundle_skipped', session: session.name, missing: missing.length });
      continue;
    }
    const ids = cast.map(who => ID_4[who]), names = pictures.map(file => file.name), list = names.map(name => ({ name }));
    let input: object, schema: Schema;
    if (story.family === 'pov') {
      input = { story: story.intent, viewer: { name: questions.viewer.name, seen: questions.viewer.seen }, people: story.people.map(one => ({ id: ID_4[one.person],
        name: person(one.person).name, looks: person(one.person).look, clothes: one.clothes, place: one.where })), pictures: list };
      schema = pov5Schema(names, ids);
    } else {
      input = { story: story.intent, people: story.people.map(one => ({ id: ID_4[one.person], name: person(one.person).name, looks: person(one.person).look,
        clothes: one.clothes })), fronts: fronts.map(file => ({ name: file.name, person: ID_4[file.person] })), portrait_clothes: questions.portraitClothes, pictures: list };
      schema = dress5Schema(names, ids);
    }
    const form = formOf34(schema), keyed = Object.values(schema.properties!.pictures.properties!);
    if (!formFits(form, schema) || !fitsSchema(placeholder5(schema), schema) || !exercised5(schema).every(answers => fitsSchema(answers, schema))
      || !same5(Object.keys(schema.properties!.pictures.properties!), names) || keyed.some(one => !same5(Object.keys(one.properties!.people.properties!), ids))) {
      throw new Refusal(`${session.name}'s form, schema, input and answers do not fit together`);
    }
    const bundle = join(dir, 'bundles', session.name), task = TASKS_5[session.kind], inputText = JSON.stringify(input, null, 2);
    mkdirSync(bundle, { recursive: true, mode: 0o700 });
    writeFileSync(join(bundle, 'TASK.md'), task + '\n', { mode: 0o600 });
    writeFileSync(join(bundle, 'input.json'), inputText + '\n', { mode: 0o600 });
    writeJson(join(bundle, 'schema.json'), schema);
    writeJson(join(bundle, 'form.json'), form);
    for (const file of shown) writeFileSync(join(bundle, file.name), file.bytes, { mode: 0o600 });
    const key: SessionKey = { name: session.name, kind: session.kind, group: `${session.story}-s${session.seed}`, rank: session.rank, seed: session.seed,
      task: sha256(task), schema: sha256(JSON.stringify(schema)), input: sha256(inputText), pictures: pictures.map(file => ({ name: file.name, key: file.key, sha256: file.sha256 })),
      references: fronts.map(file => ({ name: file.name, key: file.key, sha256: file.sha256, compare: true })), missing };
    writeJson(keyOf(dir, session.name), key);
    counts.built++;
    log({ event: 'bundle_written', session: session.name, pictures: pictures.length, references: fronts.length, missing: missing.length });
  }
  return counts;
}
const same5 = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- The fifth stand's answers ----

type SeenPov5 = { found: string; side: string; in_view: string; facing: string; as_placed: string };
type Pov5 = { viewer: string; others: string; anatomy: string[]; people: Record<string, SeenPov5> };
type SeenDress5 = { found: string; clothes: string; suit: string; body: Record<string, string> };
type Dress5 = { count: number; anatomy: string[]; people: Record<string, SeenDress5> };
type Facts5 = { pov: Map<string, Pov5>; dress: Map<string, Dress5>; excluded: Map<string, string[]>; sessions: { answered: number; planned: number } };
// One judging pass's answers, each picture under its cell's key; a picture any session calls not clean is left out of
// everything scored, with the sessions that called it so.
function readFacts5(dir: string, keys: string): Facts5 {
  const facts: Facts5 = { pov: new Map(), dress: new Map(), excluded: new Map(), sessions: { answered: 0, planned: 0 } };
  const read: { key: SessionKey; pictures: Record<string, Ans> }[] = [];
  for (const file of existsSync(keys) ? readdirSync(keys).filter(name => name.endsWith('.json')).sort() : []) {
    const key = JSON.parse(readFileSync(join(keys, file), 'utf8')) as SessionKey;
    facts.sessions.planned++;
    const answers = readJson<Ans>(answerOf(dir, key.name));
    if (!answers) continue;
    facts.sessions.answered++;
    const pictures = (answers.pictures ?? {}) as Record<string, Ans>;
    read.push({ key, pictures });
    for (const one of key.pictures) if (pictures[one.name]?.clean !== 'yes') facts.excluded.set(one.key, [...(facts.excluded.get(one.key) ?? []), key.name]);
  }
  for (const { key, pictures } of read) {
    for (const one of key.pictures) {
      if (facts.excluded.has(one.key)) continue;
      if (key.kind === 'pov') facts.pov.set(one.key, pictures[one.name] as unknown as Pov5);
      else facts.dress.set(one.key, pictures[one.name] as unknown as Dress5);
    }
  }
  return facts;
}

// A result under one of the rules' measures, as the review of 2026-09-28 has them: 1, 0, or unresolved (null) when no
// condition fails but an answer is unsure. `triOf` reads the conditions, each true, false or null for unsure.
type Tri = 0 | 1 | null;
const triOf = (conditions: (boolean | null)[]): Tri => (conditions.includes(false) ? 0 : conditions.includes(null) ? null : 1);
const yesOr = (value: string, unsure: string) => (value === 'yes' ? true : value === unsure ? null : false);
// A person of a POV story as the rules read them. Placed: found, at the edge of the picture their place gives, only part
// of them in view, and as placed; in V-face found, in the middle, most of them in view, facing the viewer, and as placed.
// Opposite, a diagnostic of what the tester saw and no proof of it: someone whose place is beside or behind the viewer,
// found, most of them in view and facing the viewer; apart, the same of an unsure identity.
const placedOf = (place: Place5, seen: SeenPov5): Tri => triOf([yesOr(seen.found, 'unsure'), seen.side === place.side,
  seen.in_view === (place.view === 'part' ? 'part' : 'most'), place.view === 'part' || seen.facing === 'toward the viewer', yesOr(seen.as_placed, 'unsure')]);
const oppositeOf = (place: Place5, seen: SeenPov5, found = 'yes') => place.view === 'part' && seen.found === found && seen.in_view === 'most'
  && seen.facing === 'toward the viewer';
// The viewer not drawn from outside; unresolved when the judge is unsure.
const insideOf = (viewer: string): Tri => (viewer === 'seen from outside' ? 0 : viewer === 'unsure' ? null : 1);
// A person of a clothes story dressed as the story says, as far as the picture can be inspected: found, the story's
// clothes, no grey suit, every part the story bares bare and every one it covers covered. Mixed contradicts both, a part
// not seen counts neither way, and a part the story neither bares nor covers is not read. Unresolved when nothing fails
// but found is unsure or the clothes are not seen. It says nothing of what opaque clothing hides.
const dressedOf = (dress: Dressed5, seen: SeenDress5): Tri => triOf([yesOr(seen.found, 'unsure'), yesOr(seen.clothes, 'not seen'),
  ['no', 'not seen'].includes(seen.suit), ...dress.bare.map(part => ['bare', 'not seen'].includes(seen.body[part])),
  ...dress.covered.map(part => ['covered', 'not seen'].includes(seen.body[part]))]);
const MEASURES_5 = ['placed', 'opposite', 'oppositeUnsure', 'asPlaced', 'outside', 'inside', 'others', 'anatomy', 'dressed', 'suit', 'bare', 'covered', 'countRight'] as const;
type Measure5 = typeof MEASURES_5[number];
// A measure as the least and the most it can be: its results of 1, and those with the unresolved ones.
type Range5 = { lo: number; hi: number };
type Scored5 = { key: string; story: CaseId; arm: Arm; answer: number; seed: number; judged: boolean; at: Record<Measure5, Range5> };
const known5 = (n: number): Range5 => ({ lo: n, hi: n });
const ranged5 = (results: Tri[]): Range5 => ({ lo: results.filter(one => one === 1).length, hi: results.filter(one => one !== 0).length });
const rangeText5 = (one: Range5) => (one.lo === one.hi ? `${one.lo}` : `${one.lo} to ${one.hi}`);
const values5 = (group: Group5, id: string) => asked5(group, id).answers as string[];

// Each cell's measures, each arm's tallies per story and person, the placed and dressed counts by answer and seed, and
// the rules.
function score5(questions: QuestionFile5, facts: Facts5) {
  const cells: Scored5[] = questions.cells.map(one => {
    const story = questions.cases[one.case], pov = facts.pov.get(one.key), dress = facts.dress.get(one.key);
    const at = Object.fromEntries(MEASURES_5.map(measure => [measure, known5(0)])) as Record<Measure5, Range5>;
    if (story.family === 'pov' && pov) {
      const seen = story.people.map(place => ({ place, seen: pov.people[ID_4[place.person]] }));
      Object.assign(at, { placed: ranged5(seen.map(one => placedOf(one.place, one.seen))), opposite: known5(seen.filter(one => oppositeOf(one.place, one.seen)).length),
        oppositeUnsure: known5(seen.filter(one => oppositeOf(one.place, one.seen, 'unsure')).length), asPlaced: known5(seen.filter(one => one.seen.as_placed === 'yes').length),
        outside: known5(pov.viewer === 'seen from outside' ? 1 : 0), inside: ranged5([insideOf(pov.viewer)]), others: known5(pov.others === 'yes' ? 1 : 0),
        anatomy: known5(pov.anatomy.length ? 1 : 0) });
    }
    if (story.family === 'clothes' && dress) {
      const seen = story.people.map(want => ({ want, seen: dress.people[ID_4[want.person]] }));
      Object.assign(at, { dressed: ranged5(seen.map(one => dressedOf(one.want, one.seen))), suit: known5(seen.filter(one => ['yes', 'partly'].includes(one.seen.suit)).length),
        bare: known5(sum(seen.map(one => one.want.bare.filter(part => one.seen.body[part] === 'bare').length))),
        covered: known5(sum(seen.map(one => one.want.covered.filter(part => one.seen.body[part] === 'covered').length))),
        countRight: known5(dress.count === story.count ? 1 : 0), anatomy: known5(dress.anatomy.length ? 1 : 0) });
    }
    return { key: one.key, story: one.case, arm: one.arm, answer: one.answer, seed: one.seed, judged: story.family === 'pov' ? !!pov : !!dress, at };
  });
  const byKey = new Map(cells.map(one => [one.key, one]));
  const cellAt = (story: CaseId, arm: Arm, answer: number, seed: number) => byKey.get(cellKey5(story, arm, answer, seed))!;
  const all = (stories: CaseId[], arms: Arm[]) => stories.flatMap(story => arms.flatMap(arm => SEEDS_5.flatMap(seed => ANSWERS.map(answer => cellAt(story, arm, answer, seed)))));
  // An arm's measure seed by seed over the stories and the three answers, at its least or its most; NaN at a seed where
  // a picture was not judged.
  const perSeed = (arm: Arm, stories: CaseId[], measure: Measure5, bound: keyof Range5) => SEEDS_5.map(seed => sum(stories.flatMap(story => ANSWERS.map(answer => {
    const cell = cellAt(story, arm, answer, seed);
    return cell.judged ? cell.at[measure][bound] : NaN;
  }))));
  const total = (arm: Arm, stories: CaseId[], measure: Measure5): Range5 => {
    const got = all(stories, [arm]).filter(cell => cell.judged);
    return { lo: sum(got.map(cell => cell.at[measure].lo)), hi: sum(got.map(cell => cell.at[measure].hi)) };
  };
  const slots = (stories: CaseId[]) => sum(stories.map(story => questions.cases[story].people.length)) * SEEDS_5.length * ANSWERS.length;
  // X against Y at the worst for X, its unresolved results 0 and Y's 1, or at its best, the reverse. Each rule reads its
  // first arm as X, so it holds under every resolution when it holds at the worst, and fails under every one when it
  // fails at the best.
  const compare = (x: Arm, y: Arm, stories: CaseId[], measure: Measure5, best: boolean) => pairwise(perSeed(x, stories, measure, best ? 'hi' : 'lo'),
    perSeed(y, stories, measure, best ? 'lo' : 'hi'), SEEDS_5.length);
  const decisions: Decision34[] = [];
  // A rule is undecided when a picture it needs was left out or not judged; otherwise yes when it holds under every
  // resolution of the unresolved results, no when it fails under every one, and undecided between.
  const decide = (question: string, needs: Scored5[], measure: Measure5, verdict: (best: boolean) => [boolean, string], beside = '') => {
    const gap = needs.filter(cell => !cell.judged).map(cell => cell.key);
    if (gap.length) { decisions.push({ question, verdict: 'undecided', why: `not judged: ${gap.join(', ')}` }); return; }
    const open = sum(needs.map(cell => cell.at[measure].hi - cell.at[measure].lo)), [worst, why] = verdict(false), [best, bestWhy] = verdict(true);
    const read = open ? `${open} result${open === 1 ? '' : 's'} unresolved; each against the first arm, ${why}; each for it, ${bestWhy}` : why;
    decisions.push({ question, verdict: worst ? 'yes' : best ? 'undecided' : 'no', why: beside ? `${read}; ${beside}` : read });
  };
  const byStory = (arms: Arm[], stories: CaseId[], measure: Measure5) => stories.map(story => `${story} ${arms.map(arm => `${arm} ${rangeText5(total(arm, [story], measure))}`)
    .join(', ')} of ${slots([story])}`).join('; ');
  const armsText = (arms: Arm[], stories: CaseId[], measure: Measure5) => arms.map(arm => `${arm} ${rangeText5(total(arm, stories, measure))}`).join(', ');
  // 1. The place: P above R on placed in V-squeeze, the tester's own scene, and over the three stories where people are
  // beside or behind the viewer.
  decide('P puts the people beside or behind the viewer at their edge of the picture, only partly in view, more often than R, in V-squeeze and over the three stories',
    all(SIDE_STORIES, ['P', 'R']), 'placed', best => {
      const squeeze = compare('P', 'R', ['V-squeeze'], 'placed', best), pooled = compare('P', 'R', SIDE_STORIES, 'placed', best);
      return [above(squeeze) && above(pooled), `in V-squeeze placed ${pairText(squeeze)}; over the three ${pairText(pooled)}`];
    }, `placed ${byStory(['R', 'P', 'PN'], SIDE_STORIES, 'placed')}; drawn facing the viewer with most of them in view, a diagnostic only, `
      + `${armsText(['R', 'P', 'PN'], SIDE_STORIES, 'opposite')}, and of an unsure identity ${armsText(['R', 'P', 'PN'], SIDE_STORIES, 'oppositeUnsure')}`);
  // 2. Without the fronts of the people only partly in view: PN against P, in the same two comparisons.
  decide('PN, P without the fronts of the people only partly in view, does so more often than P, in V-squeeze and over the three stories',
    all(SIDE_STORIES, ['PN', 'P']), 'placed', best => {
      const squeeze = compare('PN', 'P', ['V-squeeze'], 'placed', best), pooled = compare('PN', 'P', SIDE_STORIES, 'placed', best);
      return [above(squeeze) && above(pooled), `in V-squeeze placed ${pairText(squeeze)}; over the three ${pairText(pooled)}`];
    });
  // 3. The control: in V-face P keeps the person across the table in the middle, most of her in view and facing the
  // viewer, as R does. A yes holds for these pictures, not for every frontal scene.
  decide('In V-face, P keeps the person across the table in the middle, most of her in view and facing the viewer, at least as often as R',
    all(['V-face'], ['P', 'R']), 'placed', best => {
      const placed = compare('P', 'R', ['V-face'], 'placed', best);
      return [atLeast(placed), `placed ${pairText(placed)}`];
    });
  // 4. The viewer: neither switch draws the viewer from outside more often than R.
  decide('P and PN draw the viewer from outside no more often than R', all(POV_STORIES, ['P', 'R']).concat(all(SIDE_STORIES, ['PN'])), 'inside', best => {
    const p = compare('P', 'R', POV_STORIES, 'inside', best), pn = compare('PN', 'R', SIDE_STORIES, 'inside', best);
    return [atLeast(p) && atLeast(pn), `pictures without the viewer seen from outside, over the four stories P ${pairText(p)}; over the three PN ${pairText(pn)}`];
  }, `the viewer seen from outside R ${total('R', POV_STORIES, 'outside').lo}, P ${total('P', POV_STORIES, 'outside').lo}, PN ${total('PN', SIDE_STORIES, 'outside').lo}`);
  // 5. The clothes rule: C dresses the people as the story says more often than R, over the three stories together.
  decide('C dresses the people as the story says more often than R, as far as the pictures show them: its clothes, bare where it bares, covered where it covers, and no grey suit',
    all(DRESS_STORIES, ['C', 'R']), 'dressed', best => {
      const dressed = compare('C', 'R', DRESS_STORIES, 'dressed', best);
      return [above(dressed), `dressed ${pairText(dressed)}`];
    }, `dressed ${byStory(['R', 'C', 'CF'], DRESS_STORIES, 'dressed')}; the suit ${armsText(['R', 'C', 'CF'], DRESS_STORIES, 'suit')}; the parts the stories bare `
      + `shown bare ${armsText(['R', 'C', 'CF'], DRESS_STORIES, 'bare')}`);
  // 6. The cropped fronts: CF against C.
  decide('CF, C\'s words with the top 720x400 of each front (head, shoulders and some of the suit) as the reference, dresses them so more often than C',
    all(DRESS_STORIES, ['CF', 'C']), 'dressed', best => {
      const dressed = compare('CF', 'C', DRESS_STORIES, 'dressed', best);
      return [above(dressed), `dressed ${pairText(dressed)}`];
    }, `the suit ${armsText(['C', 'CF'], DRESS_STORIES, 'suit')}`);
  // The tallies each table shows.
  const judgedOf = (story: CaseId, arm: Arm) => all([story], [arm]).filter(cell => cell.judged);
  const pov = POV_STORIES.map(story => {
    const one = questions.cases[story] as Extract<Story5, { family: 'pov' }>;
    return { story, arms: armsOf(story).map(arm => {
      const got = judgedOf(story, arm), seen = got.map(cell => facts.pov.get(cell.key)!);
      return { arm, judged: got.length, slots: got.length * one.people.length, opposite: total(arm, [story], 'opposite').lo, oppositeUnsure: total(arm, [story], 'oppositeUnsure').lo,
        viewer: tally(seen.map(answer => answer.viewer), values5('pov', 'viewer')), others: tally(seen.map(answer => answer.others), values5('pov', 'others')),
        anatomy: total(arm, [story], 'anatomy').lo,
        people: one.people.map(place => {
          const each = seen.map(answer => answer.people[ID_4[place.person]]);
          return { person: ID_4[place.person], side: place.side, view: place.view, placed: ranged5(each.map(answer => placedOf(place, answer))),
            found: tally(each.map(answer => answer.found), values5('pov', 'found')), sides: tally(each.map(answer => answer.side), values5('pov', 'side')),
            inView: tally(each.map(answer => answer.in_view), values5('pov', 'in_view')), facing: tally(each.map(answer => answer.facing), values5('pov', 'facing')),
            asPlaced: tally(each.map(answer => answer.as_placed), values5('pov', 'as_placed')) };
        }) };
    }) };
  });
  const dress = DRESS_STORIES.map(story => {
    const one = questions.cases[story] as Extract<Story5, { family: 'clothes' }>;
    return { story, arms: armsOf(story).map(arm => {
      const got = judgedOf(story, arm), seen = got.map(cell => facts.dress.get(cell.key)!);
      return { arm, judged: got.length, slots: got.length * one.people.length, countRight: total(arm, [story], 'countRight').lo, anatomy: total(arm, [story], 'anatomy').lo,
        people: one.people.map(want => {
          const each = seen.map(answer => answer.people[ID_4[want.person]]);
          return { person: ID_4[want.person], bare: want.bare, covered: want.covered, dressed: ranged5(each.map(answer => dressedOf(want, answer))),
            found: tally(each.map(answer => answer.found), values5('dress', 'found')), clothes: tally(each.map(answer => answer.clothes), values5('dress', 'clothes')),
            suit: tally(each.map(answer => answer.suit), values5('dress', 'suit')),
            body: Object.fromEntries(BODY_5.map(part => [part, tally(each.map(answer => answer.body[part]), values5('dress', 'body'))])) };
        }) };
    }) };
  });
  // Placed and dressed for each of the frame model's three answers, seed by seed: the arms' answers are not pairs.
  const byAnswer = [...POV_STORIES.map(story => ({ story, measure: 'placed' as const })), ...DRESS_STORIES.map(story => ({ story, measure: 'dressed' as const }))]
    .map(({ story, measure }) => ({ story, measure, arms: armsOf(story).map(arm => ({ arm, answers: ANSWERS.map(answer => {
      const seeds = SEEDS_5.map(seed => cellAt(story, arm, answer, seed)), got = seeds.filter(cell => cell.judged);
      return { seeds: seeds.map(cell => (cell.judged ? cell.at[measure] : null)), judged: got.length,
        value: { lo: sum(got.map(cell => cell.at[measure].lo)), hi: sum(got.map(cell => cell.at[measure].hi)) } };
    }) })) }));
  return { judged: cells.filter(cell => cell.judged).length, decisions, pov, dress, byAnswer, slots: { side: slots(SIDE_STORIES), dress: slots(DRESS_STORIES) } };
}
export function scoreStand5(run: string, dir = judgeDirOf(run)) {
  const questions = readQuestions5(run), facts = readFacts5(dir, join(judgeDirOf(run), 'keys')), five = score5(questions, facts);
  return { stand: 5 as const, questions: questionsPin5(), sessions: facts.sessions, excluded: [...facts.excluded].map(([key, sessions]) => ({ key, sessions })), ...five };
}
export type Score5 = ReturnType<typeof scoreStand5>;
export function scoreTables5(score: Score5): string {
  const lines: string[] = [];
  const row = (cells: (string | number | undefined)[]) => lines.push(`| ${cells.map(cell => (cell === undefined ? '-' : String(cell))).join(' | ')} |`);
  const head = (cells: string[]) => { row(cells); row(cells.map(() => '---')); };
  const choices = (group: Group5, id: string) => `(${values5(group, id).join('/')})`;
  lines.push(`Questions ${score.questions}; sessions answered ${score.sessions.answered} of ${score.sessions.planned}; pictures judged ${score.judged} of ${PLANNED_5.length}; `
    + `left out as not clean ${score.excluded.length ? score.excluded.map(one => `${one.key} (${one.sessions.join(', ')})`).join(', ') : 'none'}.`, '');
  lines.push('Each rule is yes when it holds under every resolution of the unresolved results, no when it fails under every one, and undecided between, or when a picture it needs was left out or not judged. With every result known, no means the rule\'s criterion was not met; it does not mean equal or worse. Above, below and neither describe these seven stories, four seeds and three answers of the frame model to each arm\'s request: the answers are the same at every seed and are not pairs between arms, and nothing here is a test of significance.', '');
  lines.push('These stories test ordinary outfits, a man\'s bare chest and ordinary swimwear. They do not test fully naked characters.', '');
  lines.push('### The rules', '');
  head(['question', 'verdict', 'evidence']);
  for (const one of score.decisions) row([one.question, one.verdict, one.why]);
  lines.push('', '### Seen through the viewer\'s eyes', '', 'Placed: found, at the edge of the picture their place gives, only part of them in view, and as placed; in V-face found, in the middle, most of them in view, facing the viewer, and as placed; "a to b" when found or as placed is unsure and nothing else fails. Opposite, a diagnostic and no proof of where they sit: someone whose place is beside or behind the viewer, found, most of them in view and facing the viewer; apart, the same of an unsure identity.', '');
  head(['story', 'arm', 'pictures', 'person', 'place', 'placed', `side ${choices('pov', 'side')}`, `in view ${choices('pov', 'in_view')}`, `facing ${choices('pov', 'facing')}`,
    `as placed ${choices('pov', 'as_placed')}`, `found ${choices('pov', 'found')}`]);
  for (const story of score.pov) {
    for (const arm of story.arms) {
      for (const one of arm.people) {
        row([story.story, arm.arm, arm.judged, one.person, `${one.side}, ${one.view}`, `${rangeText5(one.placed)} of ${arm.judged}`, counts34(one.sides), counts34(one.inView),
          counts34(one.facing), counts34(one.asPlaced), counts34(one.found)]);
      }
    }
  }
  lines.push('');
  head(['story', 'arm', 'pictures', 'opposite', 'opposite, identity unsure', `viewer ${choices('pov', 'viewer')}`, `others ${choices('pov', 'others')}`, 'anatomy errors']);
  for (const story of score.pov) {
    for (const arm of story.arms) row([story.story, arm.arm, arm.judged, `${arm.opposite} of ${arm.slots}`, arm.oppositeUnsure, counts34(arm.viewer), counts34(arm.others), arm.anatomy]);
  }
  lines.push('', '### Dressed as the story says', '', 'Dressed: found, the story\'s clothes, no grey suit, and every part the story bares bare and every one it covers covered where it can be inspected; mixed contradicts both, not seen counts neither way; "a to b" when found is unsure or the clothes are not seen and nothing else fails. It is what the picture shows, not what opaque clothing hides.', '');
  head(['story', 'arm', 'pictures', 'person', 'dressed', `clothes ${choices('dress', 'clothes')}`, `suit ${choices('dress', 'suit')}`,
    ...BODY_5.map(part => `${part} ${choices('dress', 'body')}`), `found ${choices('dress', 'found')}`]);
  for (const story of score.dress) {
    for (const arm of story.arms) {
      for (const one of arm.people) {
        const mark = (part: BarePart) => `${counts34(one.body[part])}${one.bare.includes(part) ? ' (bare)' : one.covered.includes(part) ? ' (covered)' : ''}`;
        row([story.story, arm.arm, arm.judged, one.person, `${rangeText5(one.dressed)} of ${arm.judged}`, counts34(one.clothes), counts34(one.suit), ...BODY_5.map(mark),
          counts34(one.found)]);
      }
    }
  }
  lines.push('');
  head(['story', 'arm', 'pictures', 'people counted right', 'anatomy errors']);
  for (const story of score.dress) for (const arm of story.arms) row([story.story, arm.arm, arm.judged, arm.countRight, arm.anatomy]);
  lines.push('', '### By the frame model\'s answer', '', `Placed (the POV stories) and dressed (the clothes stories) for each of the three answers each arm was drawn from, at seeds ${SEEDS_5.join(', ')}, then their sum; - where a picture was not judged.`, '');
  head(['story', 'measure', 'arm', ...ANSWERS.map(answer => `a${answer}`)]);
  for (const one of score.byAnswer) {
    for (const arm of one.arms) {
      row([one.story, one.measure, arm.arm, ...arm.answers.map(answer => `${answer.seeds.map(seed => (seed ? rangeText5(seed) : '-')).join(' / ')} = ${rangeText5(answer.value)}`)]);
    }
  }
  return lines.join('\n') + '\n';
}

// ---- The command line ----

const print = (value: object) => console.log(JSON.stringify(value));
// A jobs file: {"jobs": [{"out": run, "ranks"?: [...], "model"?: judge, "fallback"?: model or null, "record"?: dir,
// "limit"?: attempts}, ...]}, in the order they are to be judged. A judge other than the judge of record never writes
// a run's judge/.
function readJobs(file: string): Job[] {
  const got = readJson<{ jobs?: { out?: unknown; ranks?: unknown; model?: unknown; fallback?: unknown; record?: unknown; limit?: unknown }[] }>(resolve(file));
  if (!got || !Array.isArray(got.jobs) || !got.jobs.length) throw new Refusal(`${file} holds no jobs`);
  return got.jobs.map(job => {
    if (typeof job.out !== 'string') throw new Refusal('a job names its run in out');
    const run = resolve(job.out), stand = standOf(run), dir = typeof job.record === 'string' ? resolve(job.record) : judgeDirOf(run);
    const model = job.model ?? JUDGE.model, fallback = job.fallback === undefined ? JUDGE.fallback : job.fallback, limit = job.limit ?? 119;
    const ranks = job.ranks ?? ranksOf(stand);
    if (typeof model !== 'string' || !MODELS.includes(model) || (fallback !== null && (typeof fallback !== 'string' || !MODELS.includes(fallback)))
      || !Array.isArray(ranks) || ranks.some(rank => !ranksOf(stand).includes(rank)) || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1
      || (model !== JUDGE.model && dir === judgeDirOf(run))) throw new Refusal(`a job in ${file} is not one this judging runs`);
    return { run, dir, model, fallback, ranks: ranks as string[], limit };
  });
}
async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string' }, jobs: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' }, parallel: { type: 'string', default: '3' },
    limit: { type: 'string', default: '119' }, 'per-session': { type: 'string', default: '6' }, model: { type: 'string', default: JUDGE.model },
    fallback: { type: 'string', default: JUDGE.fallback }, ranks: { type: 'string' }, record: { type: 'string' }, second: { type: 'string' },
  } });
  const command = positionals[0] ?? '';
  const jobsFirst = (command === 'judge' || command === 'dry-run') && values.jobs;
  if ((!values.out && !jobsFirst) || !['bundles', 'judge', 'dry-run', 'score', 'agreement'].includes(command)) {
    throw new Refusal('Use: image-refs-judge.ts bundles|dry-run|judge|score|agreement --out <the run\'s directory> (docs/action-experiment.md#refs-judging)');
  }
  const out = values.out ? resolve(values.out) : '';
  if (command === 'bundles') {
    const counts = writeBundles(out, print, values.from);
    print({ event: 'bundles', stand: standOf(out), ...counts, missing: counts.missing.length, questions: pinOf(standOf(out)) });
  } else if (command === 'judge') {
    // `--until` is when no attempt may still be running: an ISO time or epoch seconds. `--limit` counts the attempts
    // in the record, the ones before a resume included. The judge of record writes judge/; a judge only compared
    // with it writes its own `--record`, with `--fallback none`.
    const until = values.until === undefined ? undefined : /^\d+$/.test(values.until) ? Number(values.until) * 1000 : Date.parse(values.until);
    const parallel = Number(values.parallel), limit = Number(values.limit);
    if ((until !== undefined && !Number.isFinite(until)) || !Number.isInteger(parallel) || parallel < 1 || parallel > 3 || !Number.isInteger(limit) || limit < 1) {
      throw new Refusal('Use: judge --out <dir> [--until <ISO time or epoch seconds>] [--parallel 3] [--limit 119] [--ranks A,FV,B,C,D] [--model gpt-6-sol --fallback none --record <dir>], or judge --jobs <file> [--until] [--parallel]');
    }
    let jobs: Job[];
    if (values.jobs) jobs = readJobs(values.jobs);
    else {
      const stand = standOf(out), ranks = values.ranks ? values.ranks.split(',') : [...ranksOf(stand)], fallback = values.fallback === 'none' ? null : values.fallback!;
      const record = values.record ? resolve(values.record) : judgeDirOf(out);
      if (ranks.some(rank => !ranksOf(stand).includes(rank)) || (values.model !== JUDGE.model && record === judgeDirOf(out))) throw new Refusal('Use: judge --out <dir> [--ranks the stand\'s ranks] [--model gpt-6-sol --fallback none --record <dir>]');
      jobs = [{ run: out, dir: record, model: values.model, fallback, ranks, limit }];
    }
    const judged = await judgeJobs(jobs, { parallel, until, log: print });
    if (judged.some(record => record.stopped && record.stopped !== 'limit' && record.stopped !== 'until')) process.exitCode = 1;
  } else if (command === 'dry-run') {
    const minutes = Number(values['per-session']);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Refusal('Use: dry-run --out <dir> | --jobs <file> [--per-session 6]');
    const scratch = mkdtempSync(join(tmpdir(), 'simple-chat-refs-judge-dry-'));
    print({ event: 'dry_run', dir: scratch, ...await dryJudge(values.jobs ? readJobs(values.jobs) : defaultJobs(out), scratch, minutes, 3, print) });
  } else if (command === 'agreement') {
    if (!values.second) throw new Refusal('Use: agreement --out <dir> --second <the compared judge\'s record directory>');
    const second = resolve(values.second), first = readRecord(judgeDirOf(out)), other = readRecord(second), stand = standOf(out);
    if (stand === 5) throw new Refusal('the tester stand is judged once, without a retest to compare');
    if (!first || !other) throw new Refusal('both records must exist');
    if (stand === 3 || stand === 4) {
      // Two passes over the same bundles, and the second scored as the judge of record's is, with each count it moved.
      const agreement = agreementOf34(out, judgeDirOf(out), second), retest = scoreStand34(out, second), moved = scoreMoved34(scoreStand34(out), retest);
      writeFileSync(join(second, 'score.json'), JSON.stringify(retest, null, 2) + '\n', { mode: 0o600 });
      writeFileSync(join(second, 'score.md'), scoreTables34(retest), { mode: 0o600 });
      writeJson(join(judgeDirOf(out), 'retest-moved.json'), moved);
      writeFileSync(join(judgeDirOf(out), 'retest-moved.md'), movedTable34(moved), { mode: 0o600 });
      writeFileSync(join(judgeDirOf(out), 'agreement.md'), agreementTable34(agreement, first, other), { mode: 0o600 });
      writeJson(join(judgeDirOf(out), 'agreement.json'), agreement);
      print({ event: 'agreement', questions: agreement.rows.length, pairs: agreement.rows.reduce((total, one) => total + one.n, 0), ...agreement.completion });
      return;
    }
    const agreement = agreementOf(judgeDirOf(out), second);
    writeFileSync(join(judgeDirOf(out), 'agreement.md'), agreementTable(agreement, first, other), { mode: 0o600 });
    writeJson(join(judgeDirOf(out), 'agreement.json'), agreement);
    print({ event: 'agreement', questions: agreement.length, pairs: agreement.reduce((total, one) => total + one.n, 0) });
  } else if (standOf(out) === 5) {
    const score = scoreStand5(out);
    writeFileSync(join(judgeDirOf(out), 'score.json'), JSON.stringify(score, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(judgeDirOf(out), 'score.md'), scoreTables5(score), { mode: 0o600 });
    print({ event: 'score', stand: 5, answered: score.sessions.answered, planned: score.sessions.planned, excluded: score.excluded.length, judged: score.judged,
      verdicts: Object.fromEntries(['yes', 'no', 'undecided'].map(verdict => [verdict, score.decisions.filter(one => one.verdict === verdict).length])) });
  } else if (standOf(out) === 3 || standOf(out) === 4) {
    const score = scoreStand34(out);
    writeFileSync(join(judgeDirOf(out), 'score.json'), JSON.stringify(score, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(judgeDirOf(out), 'score.md'), scoreTables34(score), { mode: 0o600 });
    print({ event: 'score', stand: score.stand, answered: score.sessions.answered, planned: score.sessions.planned, excluded: score.excluded.length, judged: score.judged,
      verdicts: Object.fromEntries(['yes', 'no', 'undecided'].map(verdict => [verdict, score.decisions.filter(one => one.verdict === verdict).length])) });
  } else if (standOf(out) === 2) {
    const score = scoreStand2(judgeDirOf(out));
    writeFileSync(join(judgeDirOf(out), 'score.json'), JSON.stringify(score, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(judgeDirOf(out), 'score.md'), scoreTables2(score), { mode: 0o600 });
    print({ event: 'score', stand: 2, answered: score.sessions.answered, planned: score.sessions.planned, unclean: score.unclean.length, unjudged: score.unjudged.length });
  } else {
    const score = scoreStand(out);
    writeFileSync(join(judgeDirOf(out), 'score.json'), JSON.stringify(score, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(judgeDirOf(out), 'score.md'), scoreTables(score), { mode: 0o600 });
    print({ event: 'score', stand: 1, answered: score.sessions.answered, planned: score.sessions.planned, unclean: score.unclean.length, unjudged: score.unjudged.length,
      verdicts: Object.fromEntries(['pays', 'does not pay', 'undecided'].map(verdict => [verdict, score.decisions.filter(one => one.verdict === verdict).length])) });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
