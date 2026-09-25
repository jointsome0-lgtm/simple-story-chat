// The assembly of the action measurement (docs/action-experiment.md#assembly): from each story's two frames and its
// sheet, without a card and without a model, the binding manifest, the prompts of the six arms, and the front portraits
// and views the manifests need. Every prompt goes into its story's own directory, `sealed/<id>/` for a sharp one; what
// this file returns for the run's level is ids, codes and counts.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_STORIES } from '../examples/action-set.ts';
import { STYLE, assemblePrompt, matchSheet, sheetLooks, stripAges, stripNames } from './illustrate.ts';
import type { Character } from './illustrate.ts';
import { PORTRAIT_STYLE, portraitPrompt } from './image-portraits.ts';
import { armsOut, readJson, storyDir } from './action-text.ts';
import type { ActionArm, Facing, StoryText, TextStory, VariantFrame, VariantPerson } from './action-text.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// How `facing` is written in a clause: the torso alone, the head and the gaze left to the action. `other` adds nothing.
export const FACING_WORDS: Record<Facing, string> = { viewer: 'body facing the viewer', away: 'back to the viewer',
  'screen-left': 'body turned toward the left of the picture', 'screen-right': 'body turned toward the right of the picture', other: '' };
// T's instruction, followed by one clause per bound person and the style line.
export const T_OPENING = 'Image 1 is the finished picture. Keep everything in it: the place, the light, the framing, every pose, grip and contact, and all clothes. Change only the faces, hair, skin and build of these people in image 1, and a build only as far as every contact stays where it is:';
export const tClause = (role: string, image: number) => `${role} takes them from the person in image ${image}`;
// The facings a view is drawn for, and how its prompt asks for the turn (docs/action-experiment.md#views).
export type Turn = 'away' | 'screen-left' | 'screen-right';
export const VIEW_TURNS: Record<Turn, string> = { away: 'with the back to the viewer',
  'screen-left': 'turned toward the left of the picture, seen from the side', 'screen-right': 'turned toward the right of the picture, seen from the side' };
export const needsView = (facing: Facing | undefined): facing is Turn => facing === 'away' || facing === 'screen-left' || facing === 'screen-right';
export const viewPrompt = (turn: Turn) => `Image 1 shows one person. Draw the same person, with the same face, hair, build, marks and clothes, on the same plain grey backdrop, the whole body in frame, arms relaxed, now ${VIEW_TURNS[turn]}. ${PORTRAIT_STYLE}`;

// ---- The binding manifest ----

// A sheet entry by its place in the sheet, the id the checklist and the manifest both use; a portrait by its story
// and entry; a view by its portrait and turn. None carries a name.
export const entryId = (index: number) => `e${index + 1}`;
export const portraitId = (story: string, entry: string) => `${story}-${entry}`;
export const viewId = (portrait: string, turn: Turn) => `${portrait}-${turn}`;
export type Bound = { person: number; entry: string; portrait: string; slot: number; facing: Facing; view: string | null };
export type ManifestStop = 'shared_entry' | 'shared_portrait' | 'bound_mismatch';
// `order`: the frame's people by their index, the sheet's first. `entries`: each person's sheet entry, by index.
export type Manifest = { order: number[]; entries: (string | null)[]; bound: Bound[]; stop?: ManifestStop };

export function planManifest(story: string, frame: VariantFrame, sheet: Character[]): Manifest {
  const names = sheet.map(character => character.name);
  const people = frame.people ?? [];
  const entries = people.map(person => {
    const name = matchSheet(person.who ?? '', names);
    return name === null ? null : entryId(names.indexOf(name));
  });
  const order = [...people.keys()].sort((a, b) => Number(entries[a] === null) - Number(entries[b] === null) || a - b);
  const bound: Bound[] = order.filter(index => entries[index] !== null).map((index, at) => {
    const portrait = portraitId(story, entries[index]!);
    const facing = people[index].facing;
    return { person: index, entry: entries[index]!, portrait, slot: at + 1, facing, view: needsView(facing) ? viewId(portrait, facing) : null };
  });
  const matched = entries.filter(entry => entry !== null);
  const stop: ManifestStop | undefined = new Set(matched).size !== matched.length ? 'shared_entry'
    : new Set(bound.map(one => one.portrait)).size !== bound.length ? 'shared_portrait'
      : bound.length !== matched.length ? 'bound_mismatch' : undefined;
  return { order, entries, bound, ...(stop ? { stop } : {}) };
}

// ---- The prompts ----

// A sentence and a part of a clause, as local/illustrate.ts writes them.
const sentence = (text: string) => {
  const value = text.trim().replace(/\.$/, '');
  return value ? value + '. ' : '';
};
const phrase = (text: string) => text.trim().replace(/\.$/, '').trim();

// The names the bot strips (local/illustrate.ts `assemblePrompt`): the sheet's, and each `who` of one capitalised word
// the sheet does not know, with ages taken out of every field.
function cleaner(frame: { people?: { who?: string }[] }, sheet: Character[]) {
  const sheetNames = sheet.map(character => character.name);
  const strangers = (frame.people ?? []).map(person => (person.who ?? '').trim())
    .filter(who => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, sheetNames) === null);
  const names = [...sheetNames, ...strangers];
  const counted = { namesStripped: 0 };
  const clean = (text: string | undefined) => {
    const stripped = stripNames(stripAges(text ?? ''), names);
    counted.namesStripped += stripped.removed;
    return stripped.text;
  };
  return { clean, counted };
}

// A variant arm's prompt: shot, setting, moment, each person in the manifest's order, objects, props, light, style.
// A+ writes each person as "look, role, facing, clothes, state: action", the look from the sheet as the bot takes it;
// L drops the looks of the bound; C, and V with it, begins each bound person's clause "The person from image N".
export function variantPrompt(frame: VariantFrame, sheet: Character[], manifest: Manifest, arm: 'A+' | 'L' | 'C') {
  const looks = sheetLooks(sheet);
  const outfits = new Map(sheet.map(character => [character.name.trim().toLowerCase(), character.outfit ?? '']));
  const names = sheet.map(character => character.name);
  const { clean, counted } = cleaner(frame, sheet);
  const people = manifest.order.map(index => {
    const person: VariantPerson = frame.people[index];
    const matched = matchSheet(person.who ?? '', names);
    const key = matched === null ? undefined : matched.trim().toLowerCase();
    const slot = manifest.bound.find(one => one.person === index)?.slot;
    const look = arm !== 'A+' && slot !== undefined ? '' : clean((key === undefined ? undefined : looks.get(key)) ?? person.look ?? '');
    const clothes = phrase(clean(person.clothes ?? '')) || (key === undefined ? '' : phrase(clean(outfits.get(key) ?? '')));
    const parts = [arm === 'C' && slot !== undefined ? `The person from image ${slot}` : '', look, clean(person.role), FACING_WORDS[person.facing] ?? '',
      clothes, clean(person.state)].map(phrase).filter(Boolean).join(', ');
    const action = clean(person.action).trim();
    return sentence(parts ? `${parts}: ${action}` : action);
  }).join('');
  const prompt = sentence(clean(frame.shot)) + sentence(clean(frame.setting)) + sentence(clean(frame.moment)) + people
    + sentence(clean(frame.objects)) + sentence(clean(frame.props)) + sentence(clean(frame.light)) + STYLE;
  return { prompt, namesStripped: counted.namesStripped };
}

// T's prompt: its instruction, "ROLE takes them from the person in image N" for each bound person, N from 2, and the
// style line. A role the variant left empty is counted, not made up.
export function tPrompt(frame: VariantFrame, sheet: Character[], manifest: Manifest) {
  const { clean, counted } = cleaner(frame, sheet);
  const roles = manifest.bound.map(one => phrase(clean(frame.people[one.person].role)));
  const prompt = `${T_OPENING} ${manifest.bound.map((one, at) => tClause(roles[at], one.slot + 1)).join('; ')}. ${STYLE}`;
  return { prompt, namesStripped: counted.namesStripped, emptyRoles: roles.filter(role => !role).length };
}

// ---- One story's plan ----

// What one arm of one scene sends: its prompt, and each slot's reference by id, the portraits' fronts or views, and
// for T first L's picture of the same seed.
export type ArmPlan = { prompt: string; references: string[] };
export type PortraitPlan = { id: string; entry: string; prompt: string };
export type ViewPlan = { id: string; portrait: string; entry: string; turn: Turn; prompt: string };
export type Counts = { words: number; people: number; bound: number; nonLatin: number; namesStripped: number;
  tokens?: number; conditioning?: number };
export type StoryPlan = { id: string; manifest?: Manifest; arms: Partial<Record<ActionArm, ArmPlan>>;
  out: Partial<Record<ActionArm, string>>; vIsC: boolean; portraits: PortraitPlan[]; views: ViewPlan[];
  counts: Partial<Record<ActionArm, Counts>>; emptyRoles?: number; cast?: { cast: number; inSheet: number; sheetOnly: number } };
// The words, the letters outside the Latin script (stage 1's «рыжая» would have been one), and the encoder's tokens
// when a tokenizer is at hand.
export type Tokens = (prompt: string, images: number) => { prompt: number; conditioning: number } | undefined;
export function countsOf(prompt: string, people: number, bound: number, namesStripped: number, tokens?: Tokens, images = bound): Counts {
  const counted = tokens?.(prompt, images);
  return { words: prompt.split(/\s+/).filter(Boolean).length, people, bound,
    nonLatin: [...prompt].filter(char => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)).length, namesStripped,
    ...(counted ? { tokens: counted.prompt, conditioning: counted.conditioning } : {}) };
}

export function planStory(story: TextStory, text: StoryText | undefined, tokens?: Tokens): StoryPlan {
  const out: Partial<Record<ActionArm, string>> = armsOut(text);
  const plan: StoryPlan = { id: story.id, arms: {}, out, vIsC: false, portraits: [], views: [], counts: {} };
  // A clean story's cast against its sheet (docs/action-experiment.md#the-sheet): how many of the cast the sheet has,
  // and how many sheet entries are nobody of the cast.
  const cast = ACTION_STORIES.find(one => one.id === story.id)?.cast;
  if (cast && text?.sheet) {
    const names = text.sheet.map(character => character.name);
    const found = cast.map(name => matchSheet(name, names)).filter(name => name !== null);
    plan.cast = { cast: cast.length, inSheet: new Set(found).size, sheetOnly: names.filter(name => !found.includes(name)).length };
  }
  const worn = text?.worn ?? [];
  if (!out.A && text?.frame) {
    const assembled = assemblePrompt(text.frame, worn);
    plan.arms.A = { prompt: assembled.prompt, references: [] };
    plan.counts.A = countsOf(assembled.prompt, text.frame.people?.length ?? 0, 0, assembled.namesStripped, tokens);
  }
  const frame = text?.variant;
  if (out['A+'] || !frame) return plan;
  const manifest = planManifest(story.id, frame, worn);
  plan.manifest = manifest;
  const people = frame.people.length, bound = manifest.bound.length;
  const plus = variantPrompt(frame, worn, manifest, 'A+');
  plan.arms['A+'] = { prompt: plus.prompt, references: [] };
  plan.counts['A+'] = countsOf(plus.prompt, people, 0, plus.namesStripped, tokens);
  // A plan that stopped is what drops L's looks, so it takes L and every arm after it; nobody bound leaves C, V and T
  // nothing to send, and L is then A+ itself, drawn as its own arm all the same.
  const stopped = manifest.stop ?? (bound ? undefined : 'nobody_bound');
  for (const arm of (manifest.stop ? ['L', 'C', 'V', 'T'] : bound ? [] : ['C', 'V', 'T']) as ActionArm[]) out[arm] = stopped!;
  if (manifest.stop) return plan;
  const light = variantPrompt(frame, worn, manifest, 'L');
  plan.arms.L = { prompt: light.prompt, references: [] };
  plan.counts.L = countsOf(light.prompt, people, 0, light.namesStripped, tokens);
  if (!bound) return plan;
  plan.portraits = manifest.bound.map(one => {
    const character = worn[Number(one.entry.slice(1)) - 1];
    return { id: one.portrait, entry: one.entry, prompt: portraitPrompt(character.name, character.look).prompt };
  });
  plan.views = manifest.bound.flatMap(one => one.view && needsView(one.facing)
    ? [{ id: one.view, portrait: one.portrait, entry: one.entry, turn: one.facing, prompt: viewPrompt(one.facing) }] : []);
  const c = variantPrompt(frame, worn, manifest, 'C');
  const fronts = manifest.bound.map(one => one.portrait);
  plan.arms.C = { prompt: c.prompt, references: fronts };
  plan.counts.C = countsOf(c.prompt, people, bound, c.namesStripped, tokens);
  // V's inputs equal C's where nobody bound needs a view: V is not drawn, and C's picture counts for it.
  plan.vIsC = !plan.views.length;
  plan.arms.V = { prompt: c.prompt, references: manifest.bound.map(one => one.view ?? one.portrait) };
  plan.counts.V = plan.counts.C;
  const t = tPrompt(frame, worn, manifest);
  plan.arms.T = { prompt: t.prompt, references: ['L', ...fronts] };
  plan.counts.T = countsOf(t.prompt, bound, bound, t.namesStripped, tokens, bound + 1);
  if (t.emptyRoles) plan.emptyRoles = t.emptyRoles;
  return plan;
}

// ---- The run ----

// What `prompts` leaves at the run's level: per story, the codes that took arms out, the counts of each arm, the
// portraits and views planned, and the manifest's numbers; the hash of every plan, which the picture run is pinned
// to; and the hash of the texts they were planned from. No prompt and no name.
export type PromptsRecord = { plans: string; texts: string; stories: Record<string, { out: Partial<Record<ActionArm, string>>; vIsC: boolean;
  portraits: string[]; views: string[]; bound: number; people: number; stop?: string; emptyRoles?: number;
  counts: StoryPlan['counts']; cast?: StoryPlan['cast'] }> };
// Every story's text by one hash: a text written after `prompts` leaves its plans behind it.
export function textsHash(root: string, stories: TextStory[]): string {
  const hash = createHash('sha256');
  for (const story of stories) {
    const file = join(storyDir(root, story.id), 'text.json');
    hash.update(`${story.id}\0${existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : '-'}\n`);
  }
  return hash.digest('hex');
}
export function planAll(root: string, stories: TextStory[], tokens?: Tokens): PromptsRecord {
  const record: PromptsRecord = { plans: '', texts: textsHash(root, stories), stories: {} };
  const hash = createHash('sha256');
  for (const story of stories) {
    const dir = storyDir(root, story.id);
    const plan = planStory(story, readJson<StoryText>(join(dir, 'text.json')), tokens);
    const written = JSON.stringify(plan, null, 2);
    // The story's directory exists once its text run has begun; a story never begun keeps no plan, and its arms are
    // out with `text_missing` all the same.
    if (existsSync(dir)) writeFileSync(join(dir, 'plan.json'), written, { mode: 0o600 });
    hash.update(`${story.id}\0${sha256(written)}\n`);
    record.stories[story.id] = { out: plan.out, vIsC: plan.vIsC, portraits: plan.portraits.map(one => one.id), views: plan.views.map(one => one.id),
      bound: plan.manifest?.bound.length ?? 0, people: plan.manifest ? plan.manifest.entries.length : 0,
      ...(plan.manifest?.stop ? { stop: plan.manifest.stop } : {}), ...(plan.emptyRoles ? { emptyRoles: plan.emptyRoles } : {}),
      counts: plan.counts, ...(plan.cast ? { cast: plan.cast } : {}) };
  }
  record.plans = hash.digest('hex');
  return record;
}
export const readPlan = (root: string, id: string): StoryPlan | undefined => readJson<StoryPlan>(join(storyDir(root, id), 'plan.json'));
