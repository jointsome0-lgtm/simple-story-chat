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
import { SEEDS, SHEET_PEOPLE, frameKey, frontKey, sheetKey, viewKey } from './image-refs-test.ts';
import type { Scene } from './image-refs-test.ts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
// judge/judge-texts.json as judge/build-judge-texts.ts wrote it, byte for byte, and the stand's own texts.
const JUDGE_TEXTS_SHA256 = '6460753f52b88bc31ec52d269c4a257d6a932bc08e3b07baabdfc50de8fdbc78';
const STAND_TEXTS_SHA256 = 'd0678be9753c496fc3ad754ad5124a0add622b8298a3f744f6c71f0da2728f61';
const STAND_2_TEXTS_SHA256 = '9a5ee1a68c05970bed86088e982a0c64df99827712db10af13143fcddfa3cfe3';
export const judgeDirOf = (run: string) => join(resolve(run), 'judge');
export type StandId = 1 | 2;
// Which stand a run is, by its texts.
export function standOf(run: string): StandId {
  const file = join(resolve(run), 'texts.json'), hash = existsSync(file) ? sha256(readFileSync(file)) : '';
  if (hash === STAND_TEXTS_SHA256) return 1;
  if (hash === STAND_2_TEXTS_SHA256) return 2;
  throw new Refusal(`${file} is not the texts either refs stand drew from`);
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
type Rank = typeof RANKS[number] | typeof RANKS_2[number];
export const ranksOf = (stand: StandId): readonly string[] => (stand === 1 ? RANKS : RANKS_2);
export const SEEDS_2 = [21, 23, 29, 31, 37, 41];
// In the order of the tester's complaints: the negative at CFG 2, the look, the clothes.
export const CELLS_2 = ['R-L0', 'R-L0-NEG', 'W-L0', 'W-L0-NEG', 'R-L1', 'W-L1', 'FV-L0', 'FC-L0'];
export type Kind = 'frames' | 'identity' | 'fronts' | 'sheet' | 'turns';
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
export function comparisons(stand: StandId = 1): Comparison[] {
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
export type SessionPlan = { name: string; kind: Kind; comparison: Comparison };
export function sessionPlan(stand: StandId = 1): SessionPlan[] {
  const sessions = ranksOf(stand).flatMap(rank => comparisons(stand).filter(one => one.rank === rank))
    .flatMap(comparison => (comparison.kind === 'frames' ? ['frames', 'identity'] as const : [comparison.kind]).map(kind => ({ kind, comparison })));
  return sessions.map((one, at) => ({ name: `j${String(at + 1).padStart(2, '0')}-${one.kind}`, ...one }));
}

// ---- The tasks ----

const ENDING = 'Reason as long as you need. End your answer with exactly one ```json block that fits schema.json in this folder: the form in form.json with each value replaced by one of the values it lists there, nothing more and nothing missing.';
const FALLBACK = 'If clean is no, still return every required field: for each remaining answer field, use the first value allowed by that field from this ordered list: not_visible, unsure, no, absent, wrong. These values are placeholders only; the whole picture is left out.';
const CLEAN = `clean: is it free of nudity and of sexual content? yes or no. ${FALLBACK}`;
const ANATOMY = 'anatomy: is there an anatomy error: a limb too many or missing, bodies merged, a joint bent the way it cannot bend, a torso twisted at the waist so that the chest and the hips face clearly different ways beyond what a body can turn, a malformed hand or foot? yes, no or unsure.';
const WORDS = 'people: each person\'s words: her looks, and her build part by part in parts, each part with the words that name it and, for one person, the figures of her table of measurements (centimetres; the weight in kilograms)';
const PART_RULE = 'Judge visible proportions, fullness and shape. Measurements are approximate visual design guidance, not quantities you can verify from pixels. Use matches when the visible criteria agree; too_small or too_large for a clear directional size mismatch; mismatch for a visible non-size mismatch or conflicting size directions; unsure when the visible evidence or target description is insufficient; and not_visible when the required feature is hidden, cropped or unavailable from this viewpoint. Do not infer absolute height or weight without a reliable scale, lateral width from a true profile, or buttock projection from hip circumference alone.';
const FACING = 'facing: judge only the requested body orientation, from the orientation words in her facing and her place (three-quarters toward one side of the picture, true profile toward one side, turned toward someone). Judge torso and pelvis, not the head alone. A true side profile does not satisfy a three-quarter request, nor a three-quarter view a profile request. Position and figure size do not affect this answer. yes, no or unsure';
export const TASKS: Record<Kind, string> = {
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

type StandCell = { status: string; file?: string; sha256?: string; width?: number; height?: number; references?: string[] };
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
  const texts = readTexts(run), dir = judgeDirOf(run), stand = standOf(run);
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
// references, then a turned picture's reference.
export function attachments(copy: string): string[] {
  const input = JSON.parse(readFileSync(join(copy, 'input.json'), 'utf8')) as { pictures?: { name: string; reference?: string }[]; references?: { name: string }[]; sheet?: string };
  const names = [...(input.sheet ? [input.sheet] : []), ...(input.pictures ?? []).map(one => one.name), ...(input.references ?? []).map(one => one.name),
    ...(input.pictures ?? []).flatMap(one => (one.reference ? [one.reference] : []))];
  return [...new Set(names)].map(name => join(copy, name));
}

// ---- The run ----

type Attempted = AttemptRecord & { codexFailed?: boolean };
export type SessionRecord = { name: string; kind: Kind; state?: 'answered' | 'failed'; attempts: Attempted[] };
// A record holds one judge's sessions: its model, the fallback it goes to after a refusal (none for a judge that is only
// compared), and the questions' pin.
export type JudgingRecord = { questions: string; model: string; fallback: string | null; effort: string; sessions: Record<string, SessionRecord>; stopped?: string };
const recordFile = (dir: string) => join(dir, 'judging.json');
function openRecord(dir: string, model: string = JUDGE.model, fallback: string | null = JUDGE.fallback): JudgingRecord {
  const questions = questionsPin();
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
// have been; either stops every job. Running attempts end as they end; a record is saved after each of its attempts,
// and a new run resumes it.
export async function judgeJobs(jobs: Job[], options: RunOptions = {}): Promise<JudgingRecord[]> {
  const log = options.log ?? (() => undefined), records = new Map<string, JudgingRecord>();
  const open = jobs.map((job, index) => {
    const run = resolve(job.run), dir = resolve(job.dir ?? judgeDirOf(run)), bundles = job.bundles ?? join(judgeDirOf(run), 'bundles');
    const model = job.model ?? JUDGE.model, fallback = job.fallback === undefined ? JUDGE.fallback : job.fallback, stand = standOf(run);
    if (!MODELS.includes(model) || (fallback !== null && !MODELS.includes(fallback))) throw new Refusal('the stand is judged by codex\'s gpt-6-astra and JUDGE\'s fallback only');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let record = records.get(dir);
    if (!record) { record = openRecord(dir, model, fallback); delete record.stopped; records.set(dir, record); }
    if (record.model !== model || record.fallback !== fallback) throw new Refusal('two jobs that write one record must name one judge');
    const ranks = job.ranks ?? ranksOf(stand);
    const plan = sessionPlan(stand).filter(one => ranks.includes(one.comparison.rank) && existsSync(join(bundles, one.name)));
    return { index, stand, dir, bundles, model, fallback, plan, limit: job.limit ?? 120, record };
  });
  type Open = typeof open[number];
  const save = (job: Open) => writeJson(recordFile(job.dir), job.record);
  const running = new Map<string, Open>(), promises = new Map<string, Promise<void>>();
  const inRecord = (job: Open) => sum(Object.values(job.record.sessions).map(one => one.attempts.length))
    + [...running.values()].filter(other => other.record === job.record).length;
  const ready = (job: Open, one: SessionPlan) => {
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
    return undefined;
  };
  const attempt = async (job: Open, one: SessionPlan) => {
    const entry = job.record.sessions[one.name] ??= { name: one.name, kind: one.kind, attempts: [] };
    const now = nextModel(entry.attempts, job.model, job.fallback)!, base = join(job.dir, 'sessions'), name = `${one.name}.${entry.attempts.length + 1}`;
    let read: Read = { code: 'no_report' }, exitCode = -1, ms = 0;
    try {
      const schema = JSON.parse(readFileSync(join(job.bundles, one.name, 'schema.json'), 'utf8')) as Schema;
      ({ read, exitCode, ms } = await runAttempt({ bundle: join(job.bundles, one.name), copy: join(base, name), report: join(base, `${name}.report.md`),
        events: join(base, `${name}.events.jsonl`), stderr: join(base, `${name}.stderr.log`), model: now, prompt: TASKS[one.kind], images: attachments,
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
      let next: [Open, SessionPlan] | undefined;
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
// computer.
const sampleOf = (schema: Schema, random: () => number, name = ''): unknown => name === 'clean' ? 'yes'
  : schema.enum ? schema.enum[Math.floor(random() * schema.enum.length)]
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
    const names = [...new Set(moved.filter(one => one.dir === dir).flatMap(one => sessionPlan(stand).filter(session => (one.ranks ?? ranksOf(stand)).includes(session.comparison.rank))
      .map(session => session.name)))];
    const counts = judgingCounts(record, names);
    sessions += counts.sessions;
    if (real === judgeDirOf(job.run)) {
      if (stand === 1) {
        const score = scoreStand(job.run, dir);
        writeFileSync(join(dir, 'score.md'), scoreTables(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, decisions: score.decisions.length, undecided: score.decisions.filter(one => one.verdict === 'undecided').length });
      } else {
        const score = scoreStand2(dir);
        writeFileSync(join(dir, 'score.md'), scoreTables2(score), { mode: 0o600 });
        out.push({ stand, model: record.model, dir, ...counts, cells: score.cells.filter(cell => cell.judged).length });
      }
    } else {
      const first = dirs.get(judgeDirOf(job.run)), firstRecord = first ? readRecord(first) : undefined;
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
    print({ event: 'bundles', stand: standOf(out), ...counts, missing: counts.missing.length, questions: questionsPin() });
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
    const second = resolve(values.second), first = readRecord(judgeDirOf(out)), other = readRecord(second);
    if (!first || !other) throw new Refusal('both records must exist');
    const agreement = agreementOf(judgeDirOf(out), second);
    writeFileSync(join(judgeDirOf(out), 'agreement.md'), agreementTable(agreement, first, other), { mode: 0o600 });
    writeJson(join(judgeDirOf(out), 'agreement.json'), agreement);
    print({ event: 'agreement', questions: agreement.length, pairs: agreement.reduce((total, one) => total + one.n, 0) });
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
