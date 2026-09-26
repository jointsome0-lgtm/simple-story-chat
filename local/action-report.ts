// The report of the action measurement (docs/action-experiment.md#gates and #complete-run): each picture's scores from
// the judges' stored answers and the checklists' projections, the arms' means over scenes, the five gates on seed 7,
// the same gates over the clean scenes and over the scenes that reached their target, seed 11 as a repetition, the
// repeats' agreement, the text audit, what the run delivered cell by cell, and the times. `report.json` holds ids and
// numbers; `report.md` is the owner's, in Russian, where the sharp scenes appear only as counts. The galleries are the
// owner's too: the clean pictures on one page, the sharp ones on a page inside `sealed/`, and while the card draws,
// what is still to come and when.
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ACTION_SEEDS, ACTION_STORIES, repeatedScenes } from '../examples/action-set.ts';
import { ARMS, isSharp, readJson, requestCounts, textStories } from './action-text.ts';
import type { ActionArm, TextsRecord } from './action-text.ts';
import type { PromptsRecord, StoryPlan } from './action-prompts.ts';
import { readPlan, readPlans } from './action-prompts.ts';
import { CELL_MS, WAIT_MS, frameKey, planCells, pricing, redraws, smokeCells } from './action-draw.ts';
import { CLEANUP_RESERVE_MS } from './image-batch.ts';
import { Refusal } from './action-boundary.ts';
import type { ActionCell, CellKind, CellRecord, DrawIndex } from './action-draw.ts';
import { JUDGE, MIXUPS, answersFile, escapeHtml, keyFile, sessionKey } from './action-judge.ts';
import type { BundleKey, JudgingRecord, Projection, Session } from './action-judge.ts';

type YNU = 'yes' | 'no' | 'unsure';
type PictureAnswer = { participants: Record<string, 'present' | 'absent' | 'unsure'>; items: Record<string, YNU>;
  mixups: Record<string, YNU>; anatomy: YNU; looks: Record<string, YNU> };
type IdentityAnswer = Record<string, { present: YNU; silhouette: YNU; face: YNU }>;
type TextAnswers = { prompts: Record<string, Record<string, 'yes' | 'no'>>; facing: Record<string, YNU>;
  fronts: Record<string, { face_hair: YNU; build_marks: YNU }>; views: Record<string, { same_person: YNU; turned: YNU }> };

// The gates compare exact values; this only keeps the sums of fractions from missing a threshold by a rounding error.
const EPS = 1e-9;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const share = (ids: string[], yes: (id: string) => boolean) => ids.length ? ids.filter(yes).length / ids.length : undefined;
const points = (value: number | null | undefined) => value === null || value === undefined ? '—' : `${Math.round(value * 100)}`;

// ---- One picture ----

// A picture's scores (docs/action-experiment.md#gates). `no` and `unsure` both count against it; a score with nothing
// to count is left undefined, `not_applicable`, and the picture is out of that score's mean. The essential relations
// are those with the subject's own body and with a thing too; the mirror items are counted apart, outside the contacts.
// Identity counts a bound person present with the silhouette of their front, and `identityFace` the face apart, which
// no gate reads: the owner judged on 2026-09-26 the silhouette, and what the people do, worth more than the face.
export type Score = { contacts?: number; allContacts?: boolean; gazesFaces?: number; clothes?: number; scale?: number; complete: boolean;
  mixups: Record<string, boolean>; mixup: boolean; anatomy: boolean; looks?: number; identity?: number; identityFace?: number; shown: string[];
  mirror?: { shown: number; of: number } };
export type ScoreName = 'contacts' | 'gazesFaces' | 'clothes' | 'scale' | 'looks' | 'identity' | 'identityFace';
export const SCORES: ScoreName[] = ['contacts', 'gazesFaces', 'clothes', 'scale', 'looks', 'identity', 'identityFace'];
export function scorePicture(projection: Projection, answer: PictureAnswer, identity?: IdentityAnswer): Score {
  const kind = (...kinds: string[]) => projection.items.filter(item => kinds.includes(item.kind)).map(item => item.id);
  const essential = projection.items.filter(item => item.kind === 'relation' && item.essential).map(item => item.id);
  const yes = (id: string) => answer.items[id] === 'yes';
  const present = (id: string) => answer.participants[id] === 'present';
  const sheetPeople = projection.participants.filter(one => one.entry).map(one => one.id);
  const mixups = Object.fromEntries(MIXUPS.map(name => [name, answer.mixups[name] !== 'no']));
  const bound = identity ? Object.keys(identity) : [];
  const mirrors = kind('mirror');
  return { contacts: share(essential, yes), ...(essential.length ? { allContacts: essential.every(yes) } : {}),
    ...(mirrors.length ? { mirror: { shown: mirrors.filter(yes).length, of: mirrors.length } } : {}),
    gazesFaces: share(kind('gaze', 'face'), yes), clothes: share(kind('clothes'), yes), scale: share(kind('scale'), yes),
    complete: projection.participants.every(one => present(one.id)), mixups, mixup: Object.values(mixups).some(Boolean),
    anatomy: answer.anatomy !== 'no', looks: share(sheetPeople, id => present(id) && answer.looks[id] === 'yes'),
    identity: identity ? share(bound, entry => identity[entry].present === 'yes' && identity[entry].silhouette === 'yes') : undefined,
    identityFace: identity ? share(bound, entry => identity[entry].present === 'yes' && identity[entry].face === 'yes') : undefined,
    shown: essential.filter(yes) };
}

// ---- The scenes ----

export type Scene = { story: string; clean: boolean; reached: boolean; vDrawn: boolean; scores: Partial<Record<ActionArm, Score>> };
type Run = { root: string; draw?: DrawIndex; prompts?: PromptsRecord; texts?: TextsRecord; judging?: JudgingRecord;
  projections: Record<string, Projection>; plans: Record<string, StoryPlan | undefined> };

function readRun(root: string): Run {
  root = resolve(root);
  return { root, draw: readJson<DrawIndex>(join(root, 'draw.json')), prompts: readJson<PromptsRecord>(join(root, 'prompts.json')),
    texts: readJson<TextsRecord>(join(root, 'texts.json')), judging: readJson<JudgingRecord>(join(root, 'judging.json')),
    projections: readJson<Record<string, Projection>>(join(root, 'checklists.json')) ?? {},
    plans: Object.fromEntries(textStories().map(story => [story.id, readPlan(root, story.id)])) };
}
const answered = (run: Run, session: Session) => run.judging?.sessions[sessionKey(session)]?.state === 'answered';
function stored<T>(run: Run, session: Session): { key: BundleKey; answers: T } | undefined {
  if (!answered(run, session)) return undefined;
  const key = readJson<BundleKey>(keyFile(run.root, session)), answers = readJson<T>(answersFile(run.root, session));
  return key && answers ? { key, answers } : undefined;
}

// Each scene of a seed with its arms' scores: every arm of a picture the pictures session answered, V by C's picture
// where it stands for it, and identity from the identity session of the same scene and seed. `kind` is `repeat` to read
// the repeat's answers in place of the first's.
export function scenesOf(run: Run, seed: number, kind: 'pictures' | 'repeat' = 'pictures', only?: string[]): Scene[] {
  return textStories().flatMap(story => {
    const projection = run.projections[story.id];
    if (!projection) return [];
    const pictures = stored<{ pictures: Record<string, PictureAnswer> }>(run, { story: story.id, kind: only?.includes(story.id) ? kind : 'pictures', seed });
    const identity = stored<{ pictures: Record<string, IdentityAnswer> }>(run, { story: story.id, kind: 'identity', seed });
    const scores: Scene['scores'] = {};
    for (const picture of pictures?.key.pictures ?? []) {
      const score = scorePicture(projection, pictures!.answers.pictures[picture.name], identity?.answers.pictures[picture.name]);
      for (const arm of picture.arms) scores[arm] = score;
    }
    return [{ story: story.id, clean: !isSharp(story.id), reached: projection.reached, scores,
      vDrawn: run.draw?.cells[frameKey(story.id, seed, 'V')]?.status === 'drawn' }];
  });
}

// ---- The gates ----

export type Clause = { clause: string; kind: 'gain' | 'safeguard'; scenes: number; value: number | null; threshold: number;
  pass: boolean | 'not_applicable' | 'inconclusive' };
export type Verdict = 'pass' | 'fail' | 'inconclusive';
export type Gate = { gate: number; arms: ActionArm[]; scenes: number; clean: number; verdict: Verdict; clauses: Clause[]; floor: Clause; note?: Record<string, unknown> };
const tolerance = (n: number) => Math.max(1, Math.floor(n / 10));

// A score's difference between two arms, the means over the scenes where it applies to both: a gain needs 6 of them.
function shareClause(scenes: Scene[], name: ScoreName, [x, y]: [ActionArm, ActionArm], threshold: number, kind: Clause['kind'], clause: string): Clause {
  const both = scenes.filter(scene => scene.scores[x]?.[name] !== undefined && scene.scores[y]?.[name] !== undefined);
  if (!both.length) return { clause, kind, scenes: 0, value: null, threshold, pass: kind === 'gain' ? 'inconclusive' : 'not_applicable' };
  const value = mean(both.map(scene => scene.scores[x]![name]!)) - mean(both.map(scene => scene.scores[y]![name]!));
  return { clause, kind, scenes: both.length, value, threshold, pass: kind === 'gain' && both.length < 6 ? 'inconclusive' : value >= threshold - EPS };
}
// A count of pictures between two arms: `fewer` for what counts against a picture, `more` for what counts for it, with
// n/10 of the matched pictures allowed where the gate says so.
function countClause(scenes: Scene[], pick: (score: Score) => boolean | undefined, [x, y]: [ActionArm, ActionArm], sense: 'fewer' | 'more',
  slack: boolean, clause: string): Clause {
  const both = scenes.filter(scene => pick(scene.scores[x]!) !== undefined && pick(scene.scores[y]!) !== undefined);
  if (!both.length) return { clause, kind: 'safeguard', scenes: 0, value: null, threshold: 0, pass: 'not_applicable' };
  const count = (arm: ActionArm) => both.filter(scene => pick(scene.scores[arm]!) === true).length;
  const allowed = slack ? tolerance(both.length) : 0, value = count(x) - count(y);
  return { clause, kind: 'safeguard', scenes: both.length, value, threshold: sense === 'fewer' ? allowed : -allowed,
    pass: sense === 'fewer' ? value <= allowed : value >= -allowed };
}
// The floor: an arm that passes has contacts of at least 50%, the mean over scenes.
function floorOf(scenes: Scene[], arm: ActionArm): Clause {
  const counted = scenes.filter(scene => scene.scores[arm]?.contacts !== undefined);
  if (!counted.length) return { clause: 'contacts_floor', kind: 'safeguard', scenes: 0, value: null, threshold: 0.5, pass: 'inconclusive' };
  const value = mean(counted.map(scene => scene.scores[arm]!.contacts!));
  return { clause: 'contacts_floor', kind: 'safeguard', scenes: counted.length, value, threshold: 0.5, pass: value >= 0.5 - EPS };
}
const verdictOf = (clauses: Clause[], floor: Clause, enough: boolean): Verdict =>
  !enough || clauses.some(clause => clause.pass === 'inconclusive') || floor.pass === 'inconclusive' ? 'inconclusive'
    : clauses.every(clause => clause.pass !== false) && floor.pass === true ? 'pass' : 'fail';

const all = (arms: ActionArm[]) => (scene: Scene) => arms.every(arm => scene.scores[arm]);
const contacts = (score: Score) => score.allContacts, complete = (score: Score) => score.complete;
const mixup = (score: Score) => score.mixup, anatomy = (score: Score) => score.anatomy;

// The five gates over a set of scenes (docs/action-experiment.md#gates). `minimum` says what the scene count must
// reach: 14 of the scenes with 10 of them clean for the main count, 10 for the clean scenes alone.
export function gatesOf(scenes: Scene[], views: { right: number; judged: number; stories: string[] }, minimum: { all: number; clean: number }): Gate[] {
  const matched = (arms: ActionArm[]) => scenes.filter(all(arms));
  const enough = (list: Scene[]) => list.length >= minimum.all && list.filter(scene => scene.clean).length >= minimum.clean;
  const gate = (gate: number, arms: ActionArm[], list: Scene[], clauses: Clause[], floor: Clause, note?: Record<string, unknown>): Gate =>
    ({ gate, arms, scenes: list.length, clean: list.filter(scene => scene.clean).length, verdict: verdictOf(clauses, floor, enough(list)), clauses, floor, ...(note ? { note } : {}) });

  const one = matched(['A+', 'A']);
  const g1 = gate(1, ['A+', 'A'], one, [shareClause(one, 'contacts', ['A+', 'A'], 0.10, 'gain', 'contacts'),
    countClause(one, contacts, ['A+', 'A'], 'more', false, 'all_contacts'), countClause(one, complete, ['A+', 'A'], 'more', false, 'complete'),
    countClause(one, mixup, ['A+', 'A'], 'fewer', false, 'mixups'), countClause(one, anatomy, ['A+', 'A'], 'fewer', true, 'anatomy'),
    shareClause(one, 'scale', ['A+', 'A'], 0, 'safeguard', 'scale')], floorOf(one, 'A+'));

  const two = matched(['C', 'A+']);
  const lGain = shareClause(two.filter(scene => scene.scores.L), 'contacts', ['L', 'A+'], 0.10, 'gain', 'l_contacts');
  const g2 = gate(2, ['C', 'A+'], two, [shareClause(two, 'contacts', ['C', 'A+'], 0.10, 'gain', 'contacts'),
    countClause(two, complete, ['C', 'A+'], 'more', false, 'complete'), countClause(two, mixup, ['C', 'A+'], 'fewer', false, 'mixups'),
    countClause(two, anatomy, ['C', 'A+'], 'fewer', true, 'anatomy'), shareClause(two, 'clothes', ['C', 'A+'], -0.10, 'safeguard', 'clothes')],
  floorOf(two, 'C'), { lGainsAsMuch: lGain.pass, lContacts: lGain.value, lScenes: lGain.scenes });

  const g3 = gate(3, ['C', 'A+'], two, [shareClause(two, 'contacts', ['C', 'A+'], -0.05, 'safeguard', 'contacts'),
    shareClause(two, 'identity', ['C', 'A+'], 0.15, 'gain', 'identity'), shareClause(two, 'looks', ['C', 'A+'], -0.05, 'safeguard', 'looks'),
    countClause(two, mixup, ['C', 'A+'], 'fewer', false, 'mixups'), countClause(two, complete, ['C', 'A+'], 'more', true, 'complete'),
    countClause(two, anatomy, ['C', 'A+'], 'fewer', true, 'anatomy'), shareClause(two, 'clothes', ['C', 'A+'], -0.10, 'safeguard', 'clothes')],
  floorOf(two, 'C'));

  // Gate 4: the scenes where V was drawn, two alternative gains each with its own safeguard, and the shared clauses.
  const four = matched(['V', 'C']).filter(scene => scene.vDrawn);
  const branches = [[shareClause(four, 'contacts', ['V', 'C'], 0.05, 'gain', 'contacts'), shareClause(four, 'identity', ['V', 'C'], -0.05, 'safeguard', 'identity')],
    [shareClause(four, 'identity', ['V', 'C'], 0.10, 'gain', 'identity'), shareClause(four, 'contacts', ['V', 'C'], 0, 'safeguard', 'contacts')]];
  const inFour = views.stories.filter(story => four.some(scene => scene.story === story));
  const viewClause: Clause = !views.judged || !inFour.length ? { clause: 'views_right', kind: 'safeguard', scenes: 0, value: null, threshold: 0.8, pass: 'not_applicable' }
    : { clause: 'views_right', kind: 'safeguard', scenes: inFour.length, value: views.right / views.judged, threshold: 0.8, pass: views.right / views.judged >= 0.8 - EPS };
  const shared = [countClause(four, mixup, ['V', 'C'], 'fewer', false, 'mixups'), countClause(four, complete, ['V', 'C'], 'more', false, 'complete'),
    countClause(four, anatomy, ['V', 'C'], 'fewer', true, 'anatomy'), shareClause(four, 'clothes', ['V', 'C'], -0.10, 'safeguard', 'clothes'),
    shareClause(four, 'scale', ['V', 'C'], 0, 'safeguard', 'scale'), viewClause];
  const floor4 = floorOf(four, 'V');
  const counted = (branch: Clause[]) => branch[0].scenes >= 6;
  const passes = (branch: Clause[]) => branch[0].pass === true && branch[1].pass !== false;
  const verdict4: Verdict = four.length < 6 ? 'inconclusive' : shared.some(clause => clause.pass === false) ? 'fail'
    : branches.some(branch => counted(branch) && passes(branch)) ? (floor4.pass === true ? 'pass' : floor4.pass === false ? 'fail' : 'inconclusive')
      : branches.every(branch => counted(branch) && !passes(branch)) ? 'fail' : 'inconclusive';
  const g4: Gate = { gate: 4, arms: ['V', 'C'], scenes: four.length, clean: four.filter(scene => scene.clean).length, verdict: verdict4,
    clauses: [...branches.flat(), ...shared], floor: floor4, note: { branches: branches.map(branch => ({ counted: counted(branch), passes: passes(branch) })) } };

  // Gate 5: T against L, and against C for identity; L's shown essential relations kept in T, pooled.
  const five = matched(['T', 'L', 'C']);
  const inL = five.reduce((sum, scene) => sum + scene.scores.L!.shown.length, 0);
  const inBoth = five.reduce((sum, scene) => sum + scene.scores.L!.shown.filter(id => scene.scores.T!.shown.includes(id)).length, 0);
  const kept: Clause = { clause: 'kept_from_l', kind: 'safeguard', scenes: five.length, value: inL ? inBoth / inL : null, threshold: 0.8,
    pass: inL < 10 ? 'inconclusive' : inBoth / inL >= 0.8 - EPS };
  const g5 = gate(5, ['T', 'L', 'C'], five, [shareClause(five, 'contacts', ['T', 'L'], -0.05, 'safeguard', 'contacts'), kept,
    shareClause(five, 'identity', ['T', 'L'], 0.15, 'gain', 'identity'), shareClause(five, 'identity', ['T', 'C'], -0.05, 'safeguard', 'identity_c'),
    countClause(five, mixup, ['T', 'L'], 'fewer', false, 'mixups'), countClause(five, anatomy, ['T', 'L'], 'fewer', true, 'anatomy'),
    countClause(five, complete, ['T', 'L'], 'more', true, 'complete'), shareClause(five, 'clothes', ['T', 'L'], -0.10, 'safeguard', 'clothes'),
    shareClause(five, 'scale', ['T', 'L'], 0, 'safeguard', 'scale')], floorOf(five, 'T'), { keptFromL: inBoth, shownInL: inL });
  return [g1, g2, g3, g4, g5];
}

// ---- The pairs ----

// The pairs the gates read, each score's difference scene by scene, who is ahead, and a 90% interval from 10 000
// resamples of the scenes with a fixed seed.
export const PAIRS: [ActionArm, ActionArm][] = [['A+', 'A'], ['C', 'A+'], ['L', 'A+'], ['V', 'C'], ['T', 'L'], ['T', 'C']];
const RESAMPLES = 10000, BOOTSTRAP_SEED = 20260925;
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function interval(pairs: [number, number][], seed = BOOTSTRAP_SEED): [number, number] | null {
  if (!pairs.length) return null;
  const next = random(seed);
  const diffs: number[] = [];
  for (let round = 0; round < RESAMPLES; round++) {
    let sum = 0;
    for (let at = 0; at < pairs.length; at++) {
      const [x, y] = pairs[Math.floor(next() * pairs.length)];
      sum += x - y;
    }
    diffs.push(sum / pairs.length);
  }
  diffs.sort((a, b) => a - b);
  return [diffs[Math.floor(0.05 * RESAMPLES)], diffs[Math.ceil(0.95 * RESAMPLES) - 1]];
}
export type PairScore = { pair: string; score: ScoreName; scenes: number; x: number | null; y: number | null; difference: number | null;
  ahead: number; level: number; behind: number; interval: [number, number] | null; byScene: Record<string, number> };
function pairsOf(scenes: Scene[]): PairScore[] {
  return PAIRS.flatMap(([x, y]) => SCORES.map(score => {
    const both = scenes.filter(scene => (x !== 'V' || scene.vDrawn) && scene.scores[x]?.[score] !== undefined && scene.scores[y]?.[score] !== undefined);
    const values = both.map(scene => [scene.scores[x]![score]!, scene.scores[y]![score]!] as [number, number]);
    const diffs = values.map(([a, b]) => a - b);
    return { pair: `${x}-${y}`, score, scenes: both.length, x: both.length ? mean(values.map(v => v[0])) : null, y: both.length ? mean(values.map(v => v[1])) : null,
      difference: both.length ? mean(diffs) : null, ahead: diffs.filter(d => d > EPS).length, level: diffs.filter(d => Math.abs(d) <= EPS).length,
      behind: diffs.filter(d => d < -EPS).length, interval: interval(values), byScene: Object.fromEntries(both.map((scene, at) => [scene.story, diffs[at]])) };
  }));
}

// ---- The rest of the report ----

// The arms' means over the scenes, each score over the scenes where it applies, with the counts of pictures.
function armsOf(scenes: Scene[]) {
  return Object.fromEntries(ARMS.map(arm => {
    const scored = scenes.filter(scene => scene.scores[arm] && (arm !== 'V' || scene.vDrawn));
    const meanOf = (score: ScoreName) => { const values = scored.flatMap(scene => scene.scores[arm]![score] ?? []); return values.length ? mean(values) : null; };
    const count = (pick: (score: Score) => boolean | undefined) => scored.filter(scene => pick(scene.scores[arm]!) === true).length;
    return [arm, { scenes: scored.length, ...Object.fromEntries(SCORES.map(score => [score, meanOf(score)])), allContacts: count(contacts),
      complete: count(complete), mixups: count(mixup), mixupsByKind: Object.fromEntries(MIXUPS.map(kind => [kind, count(score => score.mixups[kind])])),
      anatomy: count(anatomy) }];
  }));
}

// What the scores count of the checklists at a seed: the scenes with a scored picture whose checklist has an essential
// relation, those relations, the ones with the subject's own body and with a thing among them, and the mirror items.
function itemsOf(run: Run, scenes: Scene[]) {
  const items = scenes.filter(scene => Object.keys(scene.scores).length).map(scene => run.projections[scene.story].items);
  const essential = items.map(list => list.filter(item => item.kind === 'relation' && item.essential));
  const all = essential.flat();
  return { scenes: essential.filter(list => list.length).length, essential: all.length, self: all.filter(item => item.with === 'self').length,
    thing: all.filter(item => item.with === 'thing').length, mirror: items.flat().filter(item => item.kind === 'mirror').length };
}

// The mirror items (docs/action-experiment.md#judging): whether a reflection shows the same person in the same pose,
// each arm's answers pooled over the scenes that list one. A line of its own, which neither the contacts nor a gate
// reads.
function mirrorsOf(scenes: Scene[]) {
  return Object.fromEntries(ARMS.map(arm => {
    const scored = scenes.flatMap(scene => (arm !== 'V' || scene.vDrawn) && scene.scores[arm]?.mirror ? [scene.scores[arm]!.mirror!] : []);
    return [arm, { scenes: scored.length, shown: scored.reduce((sum, one) => sum + one.shown, 0), of: scored.reduce((sum, one) => sum + one.of, 0) }];
  }));
}

// The text audit, from the text-and-portraits sessions: how many of the checklists' relations and mirror items A's
// and A+'s prompts state, how often a bound person's facing fits, how many fronts match their line and how many views
// were judged right.
function auditOf(run: Run) {
  const audit = { relations: { A: 0, 'A+': 0, of: { A: 0, 'A+': 0 } }, mirrors: { A: 0, 'A+': 0, of: { A: 0, 'A+': 0 } }, facing: [0, 0], fronts: [0, 0],
    views: [0, 0], viewStories: [] as string[] };
  for (const story of textStories()) {
    const text = stored<TextAnswers>(run, { story: story.id, kind: 'text' });
    const projection = run.projections[story.id];
    if (!text || !projection) continue;
    const ids = (kind: string) => projection.items.filter(item => item.kind === kind).map(item => item.id);
    for (const prompt of text.key.prompts ?? []) {
      if (prompt.arm !== 'A' && prompt.arm !== 'A+') continue;
      for (const [into, list] of [[audit.relations, ids('relation')], [audit.mirrors, ids('mirror')]] as const) {
        into[prompt.arm] += list.filter(id => text.answers.prompts[prompt.id]?.[id] === 'yes').length;
        into.of[prompt.arm] += list.length;
      }
    }
    const tally = (into: number[], values: boolean[]) => { into[0] += values.filter(Boolean).length; into[1] += values.length; };
    tally(audit.facing, Object.values(text.answers.facing).map(value => value === 'yes'));
    tally(audit.fronts, Object.values(text.answers.fronts).map(one => one.face_hair === 'yes' && one.build_marks === 'yes'));
    tally(audit.views, Object.values(text.answers.views).map(one => one.same_person === 'yes' && one.turned === 'yes'));
    if (Object.keys(text.answers.views).length) audit.viewStories.push(story.id);
  }
  return audit;
}

// The repeats: how often the second pictures session agrees with the first on each kind of item, over the four scenes
// at seed 7, and which verdicts would change if its answers stood there.
function repeatsOf(run: Run, main: Gate[], views: Parameters<typeof gatesOf>[1]) {
  const scenes = repeatedScenes();
  const agree: Record<string, [number, number]> = {};
  const count = (kind: string, same: boolean) => { const one = agree[kind] ??= [0, 0]; one[0] += Number(same); one[1]++; };
  let compared = 0;
  for (const story of scenes) {
    const seed = ACTION_SEEDS[0];
    const first = stored<{ pictures: Record<string, PictureAnswer> }>(run, { story, kind: 'pictures', seed });
    const second = stored<{ pictures: Record<string, PictureAnswer> }>(run, { story, kind: 'repeat', seed });
    const projection = run.projections[story];
    if (!first || !second || !projection) continue;
    compared++;
    for (const [name, one] of Object.entries(first.answers.pictures)) {
      const other = second.answers.pictures[name];
      for (const [id, value] of Object.entries(one.participants)) count('participant', other.participants[id] === value);
      for (const item of projection.items) count(item.kind, other.items[item.id] === one.items[item.id]);
      for (const kind of MIXUPS) count('mixup', other.mixups[kind] === one.mixups[kind]);
      count('anatomy', other.anatomy === one.anatomy);
      for (const [id, value] of Object.entries(one.looks)) count('looks', other.looks[id] === value);
    }
  }
  const swapped = gatesOf(scenesOf(run, ACTION_SEEDS[0], 'repeat', scenes), views, { all: 14, clean: 10 });
  return { scenes: compared, agree: Object.fromEntries(Object.entries(agree).map(([kind, [same, of]]) => [kind, { same, of }])),
    changed: swapped.filter((gate, at) => gate.verdict !== main[at].verdict).map(gate => ({ gate: gate.gate, from: main[gate.gate - 1].verdict, to: gate.verdict })) };
}

// What the run delivered (docs/action-experiment.md#complete-run): per arm and seed, the cells planned, submitted,
// drawn and scored, and every other cell with its reason. V where C's picture counts for it is not drawn, has the
// reason `v_is_c`, and is scored with C's picture. A cell nobody submitted is `not_yet` while the drawing may go on,
// and `not_submitted` once it is over: a stage stopped on the clock, the admission or an error, the smoke failed, or
// seed 11 was admitted, which only the end of seed 7 does. `redrawnAfterLoss`: the cells of every kind a resume drew
// again after the network lost a job of theirs after its submit, and how many of them are drawn now
// (docs/action-experiment.md#dropped-connection); the jobs lost were paid for and are in no row.
function deliveryOf(run: Run) {
  const draw = run.draw;
  const tOut = draw?.smoke?.verdict?.tOut === true;
  const over = !!draw && (!!draw.stopped || !!draw.error || draw.smoke?.verdict?.pass === false || !!draw.admitted?.[ACTION_SEEDS[1]]);
  const out: Record<string, { planned: number; submitted: number; drawn: number; scored: number; reasons: Record<string, number> }> = {};
  let unanswered = 0;
  for (const seed of ACTION_SEEDS) {
    for (const story of textStories()) {
      const planned = run.prompts?.stories[story.id];
      const judged = stored<unknown>(run, { story: story.id, kind: 'pictures', seed });
      const scored = (arm: ActionArm) => !!judged?.key.pictures?.some(picture => picture.arms.includes(arm));
      // A scene without its checklist has no pictures session: its checklist's own state is the reason.
      const sessions = run.judging?.sessions;
      const state = run.projections[story.id] ? sessions?.[`${story.id}/pictures-s${seed}`]?.state : sessions?.[`${story.id}/checklist`]?.state;
      let drawnHere = false;
      for (const arm of ARMS) {
        const row = out[`${arm}#${seed}`] ??= { planned: 0, submitted: 0, drawn: 0, scored: 0, reasons: {} };
        const reason = (code: string) => { row.reasons[code] = (row.reasons[code] ?? 0) + 1; };
        row.planned++;
        const code = planned ? planned.out[arm] : 'text_missing';
        if (code) { reason(code); continue; }
        if (arm === 'T' && tOut) { reason('t_out'); continue; }
        if (arm === 'V' && planned?.vIsC) {
          reason('v_is_c');
          if (scored(arm)) row.scored++;
          continue;
        }
        const cell: CellRecord | undefined = draw?.cells[frameKey(story.id, seed, arm)];
        if (!cell) { reason(over ? 'not_submitted' : 'not_yet'); continue; }
        if (cell.status === 'out') { reason(cell.code ?? 'out'); continue; }
        row.submitted++;
        if (cell.status !== 'drawn') { reason(cell.code ?? cell.status); continue; }
        row.drawn++;
        drawnHere = true;
        if (scored(arm)) row.scored++;
        else reason(state === 'failed' ? 'judge_failed' : state === 'owner' ? 'owner_pending' : 'not_judged');
      }
      if (isSharp(story.id) && seed === ACTION_SEEDS[0] && drawnHere && !judged) unanswered++;
    }
  }
  const seven = Object.entries(out).filter(([name]) => name.endsWith(`#${ACTION_SEEDS[0]}`));
  const again = Object.values(draw?.cells ?? {}).filter(cell => (cell.lost ?? 0) > 0);
  return { cells: out, sharpUnanswered: unanswered, seedSevenComplete: !!draw && seven.every(([, row]) => !row.reasons.not_yet),
    redrawnAfterLoss: { cells: again.length, drawn: again.filter(cell => cell.status === 'drawn').length } };
}

// The times: the median and the slowest of each arm's warm frames against A's, T with L's time added, and the time to a
// reader's first picture with portraits, the fronts and views the scene needs included. A picture that waited for the
// network (`outageMs`, docs/action-experiment.md#dropped-connection) has that wait in its time, and counts for none.
function timesOf(run: Run) {
  const timed = (cell: CellRecord | undefined): cell is CellRecord => cell?.status === 'drawn' && cell.totalMs !== undefined && !cell.outageMs;
  const cells = Object.values(run.draw?.cells ?? {}).filter(timed);
  const stat = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    return { frames: values.length, medianMs: sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2, slowestMs: sorted.at(-1)! };
  };
  const cellOf = (story: string, seed: number, arm: ActionArm) => run.draw?.cells[frameKey(story, seed, arm)];
  const warm = (cell: CellRecord) => cell.loaderCacheMiss === false && !cell.first;
  const frames = cells.filter(cell => cell.kind === 'frame' && warm(cell));
  const ms = (cell: CellRecord | undefined) => (timed(cell) ? cell.totalMs! : NaN);
  const time = (cell: CellRecord) => cell.arm === 'T' ? cell.totalMs! + ms(cellOf(cell.story, cell.seed, 'L')) : cell.totalMs!;
  const perArm = Object.fromEntries(ARMS.map(arm => [arm, stat(frames.filter(cell => cell.arm === arm).map(time).filter(Number.isFinite))]));
  const first = Object.fromEntries((['C', 'V', 'T'] as ActionArm[]).map(arm => [arm, stat(textStories().flatMap(story => {
    const cell = cellOf(story.id, ACTION_SEEDS[0], arm), plan = run.plans[story.id];
    if (!timed(cell) || !plan) return [];
    const needed = [...plan.portraits.map(one => `front:${one.id}`), ...(arm === 'V' ? plan.views.map(one => `view:${one.id}`) : [])];
    const before = needed.map(key => ms(run.draw!.cells[key]));
    const total = time(cell) + before.reduce((sum, ms) => sum + ms, 0);
    return Number.isFinite(total) ? [total] : [];
  }))]));
  return { warm: perArm, firstWithPortraits: first, fronts: stat(cells.filter(cell => cell.kind === 'front').map(cell => cell.totalMs!)),
    views: stat(cells.filter(cell => cell.kind === 'view').map(cell => cell.totalMs!)) };
}

// The text run's own numbers: each step's outcomes, and the requests apart from the calls.
function textsOf(run: Run) {
  const outcomes: Record<string, Record<string, number>> = {};
  for (const steps of Object.values(run.texts?.stories ?? {})) {
    for (const [step, result] of Object.entries(steps)) {
      const row = outcomes[step] ??= {};
      const name = result!.code ? `${result!.outcome}:${result!.code}` : result!.outcome;
      row[name] = (row[name] ?? 0) + 1;
    }
  }
  return { outcomes, requests: run.texts ? requestCounts(run.texts) : null, skipped: run.texts?.skipped ?? {},
    route: run.texts?.pins.route ?? null, weights: run.texts?.pins.weights ?? null };
}

export function actionReport(root: string) {
  const run = readRun(root);
  const [seven, eleven] = ACTION_SEEDS.map(seed => scenesOf(run, seed));
  const audit = auditOf(run);
  const views = { right: audit.views[0], judged: audit.views[1], stories: audit.viewStories };
  const main = gatesOf(seven, views, { all: 14, clean: 10 });
  const repeated = gatesOf(eleven, views, { all: 14, clean: 10 });
  const direction = main.map((gate, at) => ({ gate: gate.gate, clauses: gate.clauses.filter(clause => clause.kind === 'gain').map(clause => {
    const other = repeated[at].clauses.find(one => one.clause === clause.clause && one.kind === 'gain');
    const same = clause.value !== null && other?.value !== null && other?.value !== undefined ? Math.sign(clause.value) === Math.sign(other.value) : null;
    return { clause: clause.clause, seed7: clause.value, seed11: other?.value ?? null, same };
  }) }));
  return {
    judge: { model: JUDGE.model, fallback: JUDGE.fallback, effort: JUDGE.effort },
    scenes: { seed7: seven.length, clean: seven.filter(scene => scene.clean).length, reached: seven.filter(scene => scene.reached).length,
      missed: seven.filter(scene => !scene.reached).map(scene => scene.story), sharp: seven.filter(scene => !scene.clean).length, items: itemsOf(run, seven) },
    gates: main, cleanOnly: gatesOf(seven.filter(scene => scene.clean), views, { all: 10, clean: 10 }),
    reachedOnly: gatesOf(seven.filter(scene => scene.reached), views, { all: 14, clean: 10 }),
    seed11: { scenes: eleven.filter(scene => Object.keys(scene.scores).length).length, gates: repeated.map(gate => ({ gate: gate.gate, verdict: gate.verdict })), direction },
    arms: { seed7: armsOf(seven), seed11: armsOf(eleven) }, mirror: { seed7: mirrorsOf(seven), seed11: mirrorsOf(eleven) },
    pairs: pairsOf(seven), audit, repeats: repeatsOf(run, main, views),
    delivery: deliveryOf(run), times: timesOf(run), texts: textsOf(run),
  };
}
export type ActionReport = ReturnType<typeof actionReport>;

// ---- The owner's pages ----

const VERDICT_RU: Record<Verdict, string> = { pass: 'проходит', fail: 'не проходит', inconclusive: 'не решено' };
const GATE_RU = ['', 'Текст варианта: A+ против A', 'Идея владельца: C против A+', 'Портреты: C против A+', 'Виды: V против C', 'Два прохода: T против L'];
const clauseText = (clause: Clause) => `${clause.clause} ${clause.value === null ? '—' : Number.isInteger(clause.value) ? clause.value : points(clause.value)}`
  + ` (порог ${Number.isInteger(clause.threshold) ? clause.threshold : points(clause.threshold)}, сцен ${clause.scenes}, ${clause.pass === true ? 'да' : clause.pass === false ? 'нет' : clause.pass === 'not_applicable' ? 'неприменимо' : 'не решено'})`;

// The owner's report in Russian. The sharp scenes are counts: no row of theirs by id.
export function reportMarkdown(report: ActionReport): string {
  const lines = ['# Замер действия: отчёт', '', `Судья ${report.judge.model} (запасной ${report.judge.fallback}), усилие ${report.judge.effort}. Тексты: ${report.texts.route ?? '—'}, веса ${report.texts.weights ?? '—'}.`, '',
    `Сцен с чек-листом: ${report.scenes.seed7}, из них чистых ${report.scenes.clean} и острых ${report.scenes.sharp}; дошли до цели ${report.scenes.reached}.`
    + ` Не дошли (чистые): ${report.scenes.missed.filter(id => !isSharp(id)).join(', ') || 'нет'}; острых не дошло: ${report.scenes.missed.filter(isSharp).length}.`
    + ` Существенных касаний в чек-листах сцен с картинками сида 7: ${report.scenes.items.essential} в ${report.scenes.items.scenes} сценах, из них своего тела`
    + ` ${report.scenes.items.self} и предметов ${report.scenes.items.thing}; пунктов отражения ${report.scenes.items.mirror}.`, '',
    '## Ворота, сид 7', '', 'Пороги — для следующего решения, а не доказательство. Значения в пунктах, счёт картинок — числом.', ''];
  for (const gate of report.gates) {
    lines.push(`**${gate.gate}. ${GATE_RU[gate.gate]}** — ${VERDICT_RU[gate.verdict]}; сцен ${gate.scenes}, чистых ${gate.clean}.`, '');
    for (const clause of [...gate.clauses, gate.floor]) lines.push(`- ${clauseText(clause)}`);
    lines.push('');
  }
  lines.push('## Подмножества и повтор', '', '| Ворота | Все | Только чистые | Дошли до цели | Сид 11 |', '| --- | --- | --- | --- | --- |');
  for (const gate of report.gates) {
    lines.push(`| ${gate.gate} | ${VERDICT_RU[gate.verdict]} | ${VERDICT_RU[report.cleanOnly[gate.gate - 1].verdict]} | ${VERDICT_RU[report.reachedOnly[gate.gate - 1].verdict]} | ${VERDICT_RU[report.seed11.gates[gate.gate - 1].verdict]} |`);
  }
  lines.push('', 'Направление разниц на сиде 11: ' + report.seed11.direction.flatMap(gate => gate.clauses.map(clause =>
    `${gate.gate}/${clause.clause} ${clause.same === null ? '—' : clause.same ? 'то же' : 'обратное'}`)).join(', ') + '.', '');
  lines.push('## Руки, сид 7', '', '| Рука | Сцен | Контакты | Все контакты | Взгляды и лица | Одежда | Масштаб | Полнота | Путаницы | Анатомия | Внешность | Сходство | Лицо |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [arm, one] of Object.entries(report.arms.seed7)) {
    const row = one as unknown as Record<string, number | null>;
    lines.push(`| ${arm} | ${row.scenes} | ${points(row.contacts)} | ${row.allContacts} | ${points(row.gazesFaces)} | ${points(row.clothes)} | ${points(row.scale)} | ${row.complete} | ${row.mixups} | ${row.anatomy} | ${points(row.looks)} | ${points(row.identity)} | ${points(row.identityFace)} |`);
  }
  const ratio = (pair: number[]) => pair[1] ? `${pair[0]} из ${pair[1]}` : '—';
  lines.push('', 'Отражение (тот же человек в той же позе; в контакты не входит), сид 7: '
    + Object.entries(report.mirror.seed7).map(([arm, one]) => `${arm} ${ratio([one.shown, one.of])}`).join(', ') + '.');
  lines.push('', '## Пары, сид 7', '', 'Разница средних в пунктах, 90% интервал по 10 000 пересэмплам сцен, впереди / вровень / позади; по чистым сценам — разница сцены.', '');
  for (const pair of report.pairs.filter(one => one.scenes)) {
    const clean = Object.entries(pair.byScene).filter(([story]) => !isSharp(story)).map(([story, diff]) => `${story} ${points(diff)}`).join(', ');
    lines.push(`- ${pair.pair} ${pair.score}: ${points(pair.difference)} [${pair.interval ? pair.interval.map(points).join('; ') : '—'}], ${pair.ahead}/${pair.level}/${pair.behind}, сцен ${pair.scenes}${clean ? `; ${clean}` : ''}`);
  }
  const audit = report.audit;
  lines.push('', '## Аудит текста', '', `Отношения чек-листов в промпте A: ${ratio([audit.relations.A, audit.relations.of.A])}, в промпте A+: ${ratio([audit.relations['A+'], audit.relations.of['A+']])};`
    + ` отражения в промпте A: ${ratio([audit.mirrors.A, audit.mirrors.of.A])}, в промпте A+: ${ratio([audit.mirrors['A+'], audit.mirrors.of['A+']])}.`
    + ` facing подходит: ${ratio(audit.facing)}. Портреты совпадают со строкой: ${ratio(audit.fronts)}. Виды верны: ${ratio(audit.views)}.`, '');
  lines.push('## Повторные сессии', '', `Сцен сравнено: ${report.repeats.scenes}. Согласие: ${Object.entries(report.repeats.agree).map(([kind, one]) => `${kind} ${one.same}/${one.of}`).join(', ') || '—'}.`
    + ` Изменили бы вердикт: ${report.repeats.changed.map(one => `${one.gate} (${VERDICT_RU[one.from]} → ${VERDICT_RU[one.to]})`).join(', ') || 'ничего'}.`, '');
  lines.push('## Что доставлено', '', '| Рука и сид | План | Отправлено | Нарисовано | Оценено | Причины |', '| --- | --- | --- | --- | --- | --- |');
  for (const [name, row] of Object.entries(report.delivery.cells)) {
    lines.push(`| ${name} | ${row.planned} | ${row.submitted} | ${row.drawn} | ${row.scored} | ${Object.entries(row.reasons).map(([code, n]) => `${code} ${n}`).join(', ') || '—'} |`);
  }
  const again = report.delivery.redrawnAfterLoss;
  lines.push('', `Сид 7 ${report.delivery.seedSevenComplete ? 'полон' : 'не полон'}. Острых сцен без ответа судьи: ${report.delivery.sharpUnanswered}.`
    + ` Перерисовано после потери связи: ${again.cells}, из них нарисовано ${again.drawn}.`, '');
  const ms = (stat: { medianMs: number; slowestMs: number; frames: number } | null) => stat ? `${Math.round(stat.medianMs / 1000)} с / ${Math.round(stat.slowestMs / 1000)} с (${stat.frames})` : '—';
  lines.push('## Время', '', 'Медиана и самый медленный из тёплых кадров; T — вместе с L. Первая картинка с портретами — с портретами и видами сцены.', '',
    '| Рука | Тёплые кадры | Первая с портретами |', '| --- | --- | --- |');
  for (const arm of ARMS) lines.push(`| ${arm} | ${ms(report.times.warm[arm] ?? null)} | ${arm in report.times.firstWithPortraits ? ms(report.times.firstWithPortraits[arm] ?? null) : ''} |`);
  lines.push('', `Портреты: ${ms(report.times.fronts)}; виды: ${ms(report.times.views)}.`, '', '## Тексты', '');
  for (const [step, outcomes] of Object.entries(report.texts.outcomes)) lines.push(`- ${step}: ${Object.entries(outcomes).map(([name, n]) => `${name} ${n}`).join(', ')}`);
  if (report.texts.requests) lines.push('', `Вызовов ${report.texts.requests.calls}, повторов ${report.texts.requests.retries}, проверок ${report.texts.requests.checks}, подсчётов ${report.texts.requests.counts}.`);
  return lines.join('\n') + '\n';
}

export function writeReport(root: string) {
  root = resolve(root);
  const report = actionReport(root);
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  writeFileSync(join(root, 'report.md'), reportMarkdown(report), { mode: 0o600 });
  return report;
}

// ---- The galleries ----

// A cell without an outcome as the galleries foresee it: when it is expected to end (`eta`, epoch milliseconds, unknown
// until something like it has been drawn), `now` for the one drawing; or why it will not be drawn: a reference that
// did not come (`out`, under the code the drawing will give it), the deadline, its seed's admission (`seed`) refused or
// not yet decided, the smoke's verdict still to come, a resume after an error, or the drawing over.
type Coming = { eta?: number; now?: boolean; why?: 'out' | 'deadline' | 'admission' | 'undecided' | 'smoke' | 'resume' | 'over'; code?: string; seed?: number };
export type GalleryOptions = { until?: number; now?: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Where the drawing is: every cell in the stages' order with its record or what is foreseen for it, the cell drawing
// now, whether the drawing is over or stopped on an error, and the admissions foreseen. `until` is the stages' own `--until`; without it
// nothing is foreseen of the deadline or of an admission.
function progressOf(root: string, draw: DrawIndex, options: GalleryOptions) {
  const now = options.now ?? Date.now(), until = options.until, [first, second] = ACTION_SEEDS;
  const read = readPlans(root, textStories());
  const plans = textStories().flatMap(story => read.plans.has(story.id) ? [read.plans.get(story.id)!] : []);
  const verdict = draw.smoke?.verdict;
  const { fronts, views, frames } = planCells(plans, verdict?.tOut === true);
  // The stages' order (action-draw.ts `drawStage`): the smoke until its verdict, then seed 7's admission over the
  // fronts, the views and its frames, and seed 11's over its own frames. A cell with an outcome is passed over.
  const stages: { seed?: number; cells: ActionCell[] }[] = [{ cells: verdict ? [] : smokeCells(plans) },
    { seed: first, cells: [...fronts, ...views, ...frames(first)] }, { seed: second, cells: frames(second) }];
  const byKey = (cells: ActionCell[]) => new Map(cells.map(cell => [cell.key, cell]));
  // The plan's cells in its own order, and in the order they were drawn in, the smoke's first.
  const planned = byKey([...fronts, ...views, ...frames(first), ...frames(second), ...smokeCells(plans)]);
  const history = byKey([...smokeCells(plans), ...planned.values()]);

  const own = (one: CellRecord) => one.totalMs! + (one.uploadMs ?? 0);
  // The pause between two pictures beyond the second's own time (the card's log, the socket, the record), from the
  // times the clean pictures' files were written one after another: the median. No sharp file is looked at. A picture
  // that waited for the network (`outageMs`) counts for no time here, its pause included, as in the report.
  const gaps: number[] = [];
  let before: number | undefined;
  for (const key of history.keys()) {
    const one = draw.cells[key];
    if (!one || one.status === 'out') continue;
    const at = one.status === 'drawn' && one.file && !isSharp(one.story) ? statSync(join(root, one.file), { throwIfNoEntry: false })?.mtimeMs : undefined;
    if (at !== undefined && before !== undefined && one.totalMs !== undefined && !one.outageMs) gaps.push(at - before - own(one));
    before = at;
  }
  const pause = gaps.length ? Math.max(0, median(gaps)) : 0;
  // A cell's price as the drawing asks it: a smoke cell's is its whole wait, the rest come from the smoke's times.
  const priced = pricing((draw.smoke?.keys ?? []).map(key => draw.cells[key]).filter(Boolean));
  const price = (cell: ActionCell) => verdict ? priced(cell) : WAIT_MS + CELL_MS;
  // A cell's own time: the median of the drawn cells of its kind, of its arm for a frame, the warm ones where there are
  // any, among those whose count of references is nearest its own. A kind none of which is drawn takes its price. A
  // time without a warm cell behind it is rough, and the pages say so.
  const drawn = Object.values(draw.cells).filter(one => one.status === 'drawn' && one.totalMs !== undefined && !one.outageMs);
  let rough = false;
  const timeOf = (cell: ActionCell): number | undefined => {
    const like = drawn.filter(one => one.kind === cell.kind && one.arm === cell.arm);
    const warm = like.filter(one => !one.first && one.loaderCacheMiss !== true);
    const pool = warm.length ? warm : like;
    const distance = (one: CellRecord) => Math.abs(one.references - cell.refs.length);
    const nearest = Math.min(...pool.map(distance));
    const ms = pool.length ? median(pool.filter(one => distance(one) === nearest).map(own)) : verdict ? priced(cell) : Infinity;
    if (!warm.length) rough = true;
    return Number.isFinite(ms) ? ms : undefined;
  };
  const coming = new Map<string, Coming>();
  // A cell's outcome: its record, but for a cell the network lost after its submit, which a resume draws again
  // (action-draw.ts `redraws`) and which is foreseen as any cell still to come.
  const outcome = (key: string) => {
    const one = draw.cells[key];
    return one && !redraws(one) ? one : undefined;
  };
  // A cell a reference of which did not come is never sent, under the code of what is missing (action-draw.ts
  // `referencesOf`), whether that is recorded or foreseen.
  const outCode = (cell: ActionCell) => {
    for (const ref of cell.refs) {
      const kind = ref === 'L' ? 'frame' : read.plans.get(cell.story)?.views.some(view => view.id === ref) ? 'view' : 'front';
      const key = ref === 'L' ? frameKey(cell.story, cell.seed, 'L') : `${kind}:${ref}`, name = ref === 'L' ? 'l' : kind;
      const known = outcome(key), foreseen = coming.get(key);
      if (known ? known.status === 'drawn' : foreseen && (!foreseen.why || foreseen.why === 'resume')) continue;
      return known?.status === 'out' ? known.code ?? `${name}_missing` : known ? `${name}_failed` : foreseen?.code ?? `${name}_missing`;
    }
    return undefined;
  };

  const all = [...planned.keys()].every(outcome);
  // A stage stopped on an error of the graph or the server once the smoke had passed, with cells still to go, waits for
  // a resume on a new card, which goes on after the cell that stopped it, or draws it again when the network lost it
  // (action-draw.ts `drawCells`): the drawing is not over, whatever the deadline of the card it stopped on, and nothing
  // is timed while nothing draws.
  const halted = !!draw.completedAt && !!draw.error && !draw.stopped && verdict?.pass === true && !all;
  const ended = !!draw.completedAt && !halted && (verdict?.pass === false || !!draw.stopped || !!draw.error || !!draw.admitted?.[second] || all);
  // A job begun before `--until` still has the reserve for its stop.
  const over = ended || (!halted && until !== undefined && now >= until + CLEANUP_RESERVE_MS);
  const running = !over && !draw.completedAt;
  const saved = statSync(join(root, 'draw.json')).mtimeMs;
  let t: number | undefined = halted ? undefined : running ? saved : now, halt: Coming['why'] = over ? 'over' : undefined, haltSeed: number | undefined;
  let current: ActionCell | undefined;
  const admissions: { seed: number; needMs: number; leftMs: number }[] = [];
  for (const stage of stages) {
    const left = stage.cells.filter(cell => !outcome(cell.key) && !coming.has(cell.key));
    if (!halt && stage.seed !== undefined && left.length && !draw.admitted?.[stage.seed]) {
      // Asked when the seed would begin, of every cell of it without an outcome, at the prices the drawing asks.
      let why: Coming['why'];
      if (!verdict?.pass) why = 'smoke';
      else if (until === undefined || t === undefined) why = 'undecided';
      else {
        t = Math.max(t, now);
        const needMs = left.reduce((sum, cell) => sum + price(cell), 0);
        admissions.push({ seed: stage.seed, needMs, leftMs: until - t });
        if (needMs > until - t) why = 'admission';
      }
      if (why) { halt = why; haltSeed = stage.seed; }
    }
    for (const cell of left) {
      const code = halt ? undefined : outCode(cell);
      if (halt || code) {
        coming.set(cell.key, halt ? { why: halt, ...(haltSeed === undefined ? {} : { seed: haltSeed }) } : { why: 'out', code });
        continue;
      }
      if (halted) {
        coming.set(cell.key, { why: 'resume' });
        continue;
      }
      const ms = timeOf(cell);
      if (running && !current) {
        // Drawing since the last record: it ends when its time says, and not before now.
        current = cell;
        t = ms === undefined ? undefined : Math.max(now, saved + pause + ms);
      } else if (t !== undefined && until !== undefined && t + price(cell) > until) {
        // A cell begins only if its price ends by `--until`, and nothing begins after the first that does not.
        halt = 'deadline';
        haltSeed = undefined;
        coming.set(cell.key, { why: halt });
        continue;
      } else t = t === undefined || ms === undefined ? undefined : t + pause + ms;
      coming.set(cell.key, { eta: t, ...(cell === current ? { now: true } : {}) });
    }
  }
  const last = draw.admission?.at(-1);
  const reason = verdict?.pass === false ? 'дымовой прогон не прошёл' : draw.stopped === 'until' ? 'пришёл срок'
    : draw.stopped === 'admission' ? `сид ${last?.seed ?? '?'} не поместился до срока${last?.seed === second ? `, вердикт — по сиду ${first}` : ''}`
      : draw.error ? `стадия остановилась с ошибкой ${draw.error}` : ended ? 'всё из плана пройдено' : 'срок прошёл';
  return { now, until, over, halted, running, saved, pause, rough, planned, coming, current, admissions, reason };
}

const clock = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
};
const about = (ms: number) => `≈ ${clock(Math.round(ms / 60000) * 60000)}`;
const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60000))} мин`;
const comingText = (one: Coming | undefined) => !one ? '—' : one.why === 'out' ? `не будет: ${one.code}` : one.why === 'deadline' ? 'не успеет до срока'
  : one.why === 'admission' ? `сид ${one.seed} не поместится`
    : one.why === 'undecided' ? (one.seed === ACTION_SEEDS[1] ? `решится после сида ${ACTION_SEEDS[0]}` : `ждёт допуска сида ${one.seed}`)
      : one.why === 'smoke' ? 'после дымового прогона' : one.why === 'resume' ? 'ждёт продолжения' : one.why === 'over' ? 'не отправлено'
        : `${one.now ? 'рисуется, ' : ''}${one.eta === undefined ? 'время неизвестно' : about(one.eta)}`;
const titleOf = (id: string) => ACTION_STORIES.find(one => one.id === id)?.label ?? textStories().find(story => story.id === id)?.title ?? id;

// The galleries: every story's fronts, views and frames by seed and arm, the clean ones on `gallery.html` and the
// sharp ones on `sealed/gallery.html`. Each cell stands in its place: its picture, linked where it lies and never
// copied, the code of a cell that failed or is out, or, for one still to come, when it is expected to end. Above
// them, what is drawing now, how far the fronts, the views and each seed have come and when each is expected to end,
// the deadline and seed 11's admission; after a stage stopped on an error, what is left for a resume, and no time.
// Until the drawing is over the pages reload themselves every minute. The clean page shows the sharp stories as counts
// alone.
export function writeGalleries(root: string, options: GalleryOptions = {}) {
  root = resolve(root);
  const draw = readJson<DrawIndex>(join(root, 'draw.json'));
  if (!draw) throw new Refusal(`${join(root, 'draw.json')} is missing: the galleries show the drawn pictures`);
  const progress = progressOf(root, draw, options);
  const { now, until, over, halted, planned, coming, current } = progress;
  const [first, second] = ACTION_SEEDS;
  // Every cell of the plan in the stages' order, then any recorded outside it.
  const every: { key: string; kind: CellKind; story: string; seed: number }[] = [...planned.values(), ...Object.values(draw.cells).filter(one => !planned.has(one.key))];
  const where = (test: (one: { kind: CellKind; story: string; seed: number }) => boolean) => every.filter(test).map(one => one.key);
  // A cell's record as the pages show it: none, while the drawing may go on, for a cell the network lost after its
  // submit, which a resume draws again; once it is over, the failure it is.
  const shown = (key: string) => {
    const one = draw.cells[key];
    return one && (over || !redraws(one)) ? one : undefined;
  };
  const count = (keys: string[], status: CellRecord['status']) => keys.filter(key => shown(key)?.status === status).length;

  // When a set of cells is expected to end: its last foreseen time, or why not all of it will be drawn.
  const endOf = (keys: string[]) => {
    const left = keys.filter(key => !shown(key)).map(key => coming.get(key));
    if (!left.length) return 'готово';
    const stop = left.find(one => one?.why !== undefined && one.why !== 'out'), later = left.filter(one => one && !one.why);
    const end = later.length && later.every(one => one!.eta !== undefined) ? Math.max(...later.map(one => one!.eta!)) : undefined;
    if (stop?.why === 'deadline') return !later.length ? comingText(stop) : `до срока ${later.length} из ${left.length}${end === undefined ? '' : `, ${about(end)}`}`;
    if (stop) return `${comingText(stop)}${stop.why === 'over' ? ` ${left.length}` : ''}`;
    return !later.length ? 'не будет' : end === undefined ? 'время неизвестно' : about(end);
  };
  const whatOf = (cell: ActionCell, sharp: boolean) => isSharp(cell.story) && !sharp
    ? `острая сцена, ${cell.kind === 'frame' ? `кадр сида ${cell.seed}` : cell.kind === 'front' ? 'портрет' : 'вид'}`
    : `${titleOf(cell.story)} — ${cell.kind === 'front' ? `портрет ${cell.id}` : cell.kind === 'view' ? `вид ${cell.id}` : `сид ${cell.seed}, рука ${cell.arm}`}`;
  const seedLine = () => {
    const foreseen = progress.admissions.find(one => one.seed === second);
    if (draw.admitted?.[second]) return `Сид ${second} допущен.`;
    if (draw.admission?.some(one => one.seed === second && !one.admitted)) return `Сид ${second} не допущен: по ценам харнесса не помещался до срока, вердикт — по сиду ${first}.`;
    if (over) return `Сид ${second} не начинался.`;
    if (halted) {
      const seven = where(one => one.kind === 'frame' && one.seed === first).some(key => !shown(key));
      return `Сид ${second} решится${seven ? ` после сида ${first}` : ''}, когда рисование продолжится.`;
    }
    if (foreseen) {
      return `Сид ${second} решится после сида ${first}: по оценке ${foreseen.needMs <= foreseen.leftMs ? 'поместится' : 'не поместится'} — по ценам харнесса ему нужно `
        + `${minutes(foreseen.needMs)}, а после сида ${first} останется ≈ ${minutes(foreseen.leftMs)}.`;
    }
    if (where(one => one.kind === 'frame' && one.seed === second).some(key => coming.get(key)?.why === 'deadline')) return `Сид ${second} не начнётся: сид ${first} не успевает до срока.`;
    return `Сид ${second} решится после сида ${first}${until === undefined ? '; без срока (gallery --until) оценки нет' : ''}.`;
  };

  const status = (sharp: boolean) => {
    const deadline = until === undefined ? 'Срок рисования не задан (gallery --until).' : `Срок рисования — ${clock(until)}.`;
    const lines = over
      ? [`<p><b>Рисование закончено</b>: ${escapeHtml(progress.reason)}. ${deadline} Страница собрана в ${clock(now)} и больше не обновляется.</p>`,
        '<p>Дальше — уже без карты: пакеты для судей, судьи (свежие сессии codex), отчёт и эта страница заново. Сколько это займёт, здесь не оценивается.</p>']
      : halted ? [`<p><b>Рисование остановилось</b> в ${clock(Date.parse(draw.completedAt!))} с ошибкой ${escapeHtml(draw.error!)}. Остальное ждёт `
        + `продолжения на новой карте: время здесь появится, когда рисование снова пойдёт. Страница собрана в ${clock(now)} и обновляется сама раз в минуту.</p>`]
      : [`<p>Собрана в ${clock(now)} и обновляется сама раз в минуту. ${deadline}</p>`,
        current ? `<p>Сейчас рисуется: ${escapeHtml(whatOf(current, sharp))}${coming.get(current.key)?.eta === undefined ? '' : `; закончит ${about(coming.get(current.key)!.eta!)}`}.</p>`
          : progress.running ? `<p>${[...coming.values()].some(one => one.why === 'deadline') ? 'До срока больше ничего не начнётся.' : 'Стадия заканчивается.'}</p>`
            : `<p>Сейчас ничего не рисуется: стадия закончилась в ${clock(Date.parse(draw.completedAt!))}. Время ниже — если следующая начнётся сейчас.</p>`,
        ...(progress.running && now - progress.saved > WAIT_MS + CELL_MS ? [`<p class="warn">draw.json не менялся с ${clock(progress.saved)}: рисование, похоже, стоит.</p>`] : [])];
    const rows: [string, string[]][] = [['Портреты', where(one => one.kind === 'front')], ['Виды', where(one => one.kind === 'view')],
      ...ACTION_SEEDS.map((seed): [string, string[]] => [`Сид ${seed}`, where(one => one.kind === 'frame' && one.seed === seed)])];
    // After an error, what is left instead of when it ends.
    const left = (keys: string[]) => keys.filter(key => !shown(key)).length;
    lines.push(`<table><tr><th></th><th>нарисовано</th><th>не вышло</th><th>выбыло</th><th>в плане</th><th>${halted ? 'осталось' : 'закончится'}</th></tr>`,
      ...rows.map(([name, keys]) => `<tr><td>${name}</td><td>${count(keys, 'drawn')}</td><td>${count(keys, 'failed')}</td><td>${count(keys, 'out')}</td>`
        + `<td>${keys.length}</td><td>${halted ? left(keys) : escapeHtml(endOf(keys))}</td></tr>`), '</table>', `<p>${escapeHtml(seedLine())}</p>`);
    if (!sharp) {
      const keys = where(one => isSharp(one.story));
      lines.push(`<p>Острые сцены (${textStories().filter(story => isSharp(story.id)).length}) здесь только числами: нарисовано ${count(keys, 'drawn')}, `
        + `не вышло ${count(keys, 'failed')}, выбыло ${count(keys, 'out')}, ${over ? 'не отправлено' : halted ? 'осталось' : 'впереди'} ${left(keys)}. `
        + 'По картинкам — на их отдельной странице.</p>');
    }
    if (!over && !halted) {
      lines.push(`<p class="note">Время — медиана уже нарисованных картинок того же вида (у кадров — той же руки, с ближайшим числом ссылок) `
        + `и пауза между картинками ≈ ${(progress.pause / 1000).toFixed(1).replace('.', ',')} с; точность — минуты.`
        + `${progress.rough ? ' Для части картинок тёплых замеров ещё нет, и их время пока грубое.' : ''}</p>`);
    }
    return lines.join('\n');
  };

  const page = (file: string, sharp: boolean) => {
    const dir = join(file, '..');
    const figure = (key: string) => {
      const one = shown(key), cell = one ?? draw.cells[key] ?? planned.get(key)!, foreseen = coming.get(key);
      const box = (text: string, style: string) => `<div class="box ${cell.kind === 'frame' ? 'wide' : 'tall'} ${style}">${escapeHtml(text)}</div>`;
      const src = one?.status === 'drawn' && one.file && existsSync(join(root, one.file)) ? escapeHtml(relative(dir, join(root, one.file))) : undefined;
      const body = src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>`
        : one ? box(one.status === 'drawn' ? 'файла нет' : `${one.status === 'failed' ? 'не вышло' : 'выбыло'}: ${one.code ?? '—'}`, 'bad')
          : box(comingText(foreseen), foreseen?.now ? 'now' : foreseen?.why ? 'off' : '');
      return `<figure>${body}<figcaption>${escapeHtml(cell.kind === 'frame' ? `${cell.arm}` : cell.id)}</figcaption></figure>`;
    };
    const stories = textStories().filter(story => isSharp(story.id) === sharp);
    const sections = stories.map(story => {
      const fronts = where(one => one.story === story.id && one.kind === 'front'), views = where(one => one.story === story.id && one.kind === 'view');
      const seeds = ACTION_SEEDS.map(seed => `<h3>сид ${seed}</h3><div class="row">${ARMS.map(arm => frameKey(story.id, seed, arm))
        .filter(key => planned.has(key) || draw.cells[key]).map(figure).join('')}</div>`);
      return `<section><h2>${escapeHtml(story.id)}: ${escapeHtml(titleOf(story.id))}</h2><div class="row">${[...fronts, ...views].map(figure).join('')}</div>${seeds.join('')}</section>`;
    });
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${over ? '' : '<meta http-equiv="refresh" content="60">'}
<title>${sharp ? 'Острые сцены' : 'Чистые сцены'}</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px}figure{margin:0;width:calc((100% - 16px) / 3)}
img{width:100%;display:block}.box{display:flex;align-items:center;justify-content:center;text-align:center;box-sizing:border-box;padding:4px;background:#eee;font-size:14px}
.tall{aspect-ratio:9/16}.wide{aspect-ratio:16/9}.now{background:#d6e8ff}.bad{background:#fbdcdc}.off{color:#777}.warn{color:#a00}.note{color:#666;font-size:13px}
table{border-collapse:collapse}th,td{padding:2px 6px;text-align:right}td:first-child{text-align:left}
@media (max-width:640px){figure{width:calc((100% - 8px) / 2)}}</style>
<h1>${sharp ? 'Острые сцены' : 'Чистые сцены'}</h1>
${status(sharp)}
${sections.join('\n')}
`, { mode: 0o600 });
    return stories.length;
  };
  const clean = page(join(root, 'gallery.html'), false);
  const sharpDir = join(root, 'sealed');
  const sharp = existsSync(sharpDir) ? page(join(sharpDir, 'gallery.html'), true) : 0;
  return { clean, sharp, finished: over };
}

