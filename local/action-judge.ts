// The judging of the action measurement (docs/action-experiment.md#judging). Four kinds of session work on each
// scene, each a fresh `codex exec` session in its own copy of its bundle:
//   checklist  from the action scene, its target and the sheet, before any picture exists;
//   text       the prompts of A and A+, the fronts and the views;
//   pictures   one scene's pictures of one seed, and `repeat`, the same bundle again for four clean scenes at seed 7;
//   identity   the same pictures beside the fronts of the bound people, once `pictures` has its answers.
// A bundle holds its task, its inputs, its schema and its pictures, named by their hashes; which arm drew which picture
// stays outside, in the story's `keys/`. A session's answers are the last JSON block of its report, read strictly
// against its bundle's schema. A clean scene's report without a valid block gets one fresh session and then counts as
// a judge's failure; a sharp scene's goes to gpt-6-sol, then to the owner's page (docs/action-experiment.md#sealed).
// Every word of a story stays in its directory, `sealed/<id>/` for a sharp one, and the sessions of a sharp story run
// inside `sealed/`; what this file prints and writes at the run's level is ids, codes, counts and times.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ACTION_SEEDS, ACTION_STORIES, SHARP_TARGET, repeatedScenes } from '../examples/action-set.ts';
import { pngSize } from './image-batch.ts';
import type { Character } from './illustrate.ts';
import { Store } from './store.ts';
import { Refusal } from './action-boundary.ts';
import { ARMS, USER, fitsSchema, isSharp, readJson, storyDir, textStories } from './action-text.ts';
import type { ActionArm, Facing, Schema, StoryText } from './action-text.ts';
import { entryId, readPlan } from './action-prompts.ts';
import type { Turn } from './action-prompts.ts';
import { FRAME_CANVAS, SCALED, VIEW_CANVAS, frameKey } from './action-draw.ts';
import type { DrawIndex } from './action-draw.ts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);

// ---- The sessions ----

// The judge, its fallback for a sharp scene, and the effort, as the second panel ran them. The pictures are attached
// as they were drawn, at these sizes, and a bundle refuses any other.
export const JUDGE = { model: 'gpt-6-astra', fallback: 'gpt-6-sol', effort: 'high' } as const;
export const ATTACHED = { frame: `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`, front: '720x1280', view: `${VIEW_CANVAS.width}x${VIEW_CANVAS.height}` };
export type SessionKind = 'checklist' | 'text' | 'pictures' | 'repeat' | 'identity';
export const KINDS: SessionKind[] = ['checklist', 'text', 'pictures', 'repeat', 'identity'];
export type Session = { story: string; kind: SessionKind; seed?: number };
export const sessionName = (session: { kind: SessionKind; seed?: number }) => session.seed === undefined ? session.kind : `${session.kind}-s${session.seed}`;
export const sessionKey = (session: Session) => `${session.story}/${sessionName(session)}`;
const parseSession = (story: string, name: string): Session | undefined => {
  const match = /^(checklist|text|pictures|repeat|identity)(?:-s(\d+))?$/.exec(name);
  return match ? { story, kind: match[1] as SessionKind, ...(match[2] ? { seed: Number(match[2]) } : {}) } : undefined;
};
// The models a session's attempts go to, in order: a clean scene gets one fresh session of the same kind, a sharp one
// goes to the fallback, and after it to the owner.
export const modelsFor = (story: string) => isSharp(story) ? [JUDGE.model, JUDGE.fallback] : [JUDGE.model, JUDGE.model];

// ---- The tasks ----

// The task texts, pinned by their hashes. None names an arm, shows a prompt of a picture it judges, or states a
// hypothesis or a threshold.
const ENDING = 'Рассуждай сколько нужно. В конце ответа дай ровно один блок ```json, который в точности подходит под schema.json из этой папки: только id из input.json и значения из перечислений схемы, без лишних полей и без пропусков.';
export const TASKS: Record<Exclude<SessionKind, 'repeat'>, string> = {
  checklist: `Ты составляешь список проверки к сцене из интерактивной истории. Картинок ещё нет: работай только с текстом.

В input.json: scene — сцена, которой кончается история; target — момент, к которому она должна была прийти, и кто в нём нужен; sheet — лист персонажей, у каждой записи свой entry, имя (name), внешность (look) и одежда (outfit).

Опиши момент, которым кончается сцена:
1. participants — каждый участник главного действия этого момента: человек, животное или существо. handle — короткое описание по его месту в действии, без имени и без внешности, у каждого своё. entry — запись листа, если это он, иначе null; одна запись — не больше чем у одного участника.
2. relations — отношения момента, у каждого один subject, один verb и один object, где subject и object — handle участников. part и side — часть тела и её сторона (left или right), только если сцена их называет; сторону, которой сцена не называет, не выдумывай и оставь пустую строку. Касание в обе стороны — одно отношение. essential: true у касаний, из которых состоит главное действие; если сцена не показывает ни одного такого касания, не отмечай ни одного и ни одного не выдумывай. quote — короткая цитата из сцены.
3. gazes и faces — взгляды и выражения лиц, которые сцена называет; clothes — одежда, которую сцена называет для этого момента. У каждого пункта who (handle), text — что именно, и quote. scale — масштаб, если на нём стоит сцена: text и quote.
4. target — пришла ли сцена к моменту из target: происходит ли это касание (contact), есть ли в нём каждый нужный участник (participants), можно ли различить сам момент (moment); yes или no.
5. contradictions — где строка листа о человеке противоречит сцене: entry и quote.

${ENDING}`,
  text: `Ты проверяешь описания кадра и портреты к сцене из интерактивной истории.

В input.json: scene — сцена; sheet — лист персонажей (entry, name, look, outfit); checklist — список проверки момента: участники (id p…, у каждого handle и entry из листа или null) и пункты: отношения (r…), взгляды (g…), лица (f…), одежда (c…), масштаб (s…); shot — план кадра; prompts — описания кадра для художника, у каждого свой id; portraits — люди с портретами: entry, facing — куда в кадре обращён их корпус (viewer — к зрителю, away — спиной к зрителю, screen-left и screen-right — в профиль к левому или правому краю кадра, other — иначе), front — файл портрета спереди, если он есть, и view — файл вида с turn, куда человека просили повернуть, если вид есть. Файлы лежат в этой папке и приложены.

Ответь:
1. prompts — для каждого описания и каждого отношения, взгляда и пункта одежды из checklist: называет ли его это описание, yes или no.
2. facing — для каждого человека из portraits: подходит ли его facing к моменту и к плану кадра.
3. fronts — для каждого портрета спереди: совпадает ли он со строкой листа лицом и волосами (face_hair) и телосложением и приметами (build_marks).
4. views — для каждого вида: тот же ли это человек, что на его портрете спереди (same_person), и повёрнут ли он так, как просили (turned).
В facing, fronts и views отвечай yes, no или unsure.

${ENDING}`,
  pictures: `Ты оцениваешь картинки к сцене из интерактивной истории.

В input.json: scene — сцена; sheet — лист персонажей (entry, name, look, outfit); checklist — список проверки момента: участники (id p…, у каждого handle и entry из листа или null) и пункты: отношения (r…), взгляды (g…), лица (f…), одежда (c…), масштаб (s…); pictures — имена картинок, они лежат в этой папке и приложены.

Для каждой картинки сначала скажи, кто есть кто: каждый участник present, absent или unsure, и где он, по его внешности и месту, прежде чем оценивать действие. Если не можешь понять, кто есть кто, отвечай unsure за этого участника, а не решай по действию.
Потом для каждой картинки:
1. items — каждое отношение, взгляд, лицо, пункт одежды и масштаба: yes, no или unsure. Касание, закрытое телом, — unsure, если картинка его не показывает; касание, которое срезает край кадра, — no.
2. mixups — есть ли путаница каждого вида: действие делает не тот участник (wrong_person), двое поменялись внешностью (swapped_looks), двое слились в одного (merged).
3. anatomy — есть ли ошибка анатомии: лишняя или недостающая конечность, слившиеся тела, сустав, согнутый так, как он не гнётся.
4. looks — для каждого участника, у которого есть entry: выглядит ли он так, как говорит его строка листа.
В mixups, anatomy и looks отвечай yes, no или unsure. Картинки можно сравнивать между собой.

${ENDING}`,
  identity: `Ты сравниваешь людей на картинках с их портретами.

В input.json: pictures — имена картинок; portraits — люди с портретами спереди: entry, handle — кто это в сцене, если известно, и front — файл портрета. Всё лежит в этой папке и приложено.

Для каждой картинки и каждого человека из portraits: есть ли он на картинке (present), совпадает ли его лицо с портретом (face), совпадает ли его телосложение (build); yes, no или unsure. Если человека на картинке нет, face и build — no.

${ENDING}`,
};
export const taskOf = (kind: SessionKind) => TASKS[kind === 'repeat' ? 'pictures' : kind];

// ---- The schemas ----

const TEXT: Schema = { type: 'string' };
const YN: Schema = { type: 'string', enum: ['yes', 'no'] };
const YNU: Schema = { type: 'string', enum: ['yes', 'no', 'unsure'] };
const PRESENCE: Schema = { type: 'string', enum: ['present', 'absent', 'unsure'] };
const strict = (properties: Record<string, Schema>): Schema => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const each = (keys: string[], value: Schema) => strict(Object.fromEntries(keys.map(key => [key, value])));
const list = (item: Record<string, Schema>, minItems?: number): Schema => ({ type: 'array', ...(minItems ? { minItems } : {}), items: strict(item) });
export const MIXUPS = ['wrong_person', 'swapped_looks', 'merged'] as const;

// The checklist's schema describes the items it lists; the entries are the sheet's.
export function checklistSchema(entries: string[]): Schema {
  const said = { who: TEXT, text: TEXT, quote: TEXT };
  return strict({
    participants: list({ handle: TEXT, entry: { type: ['string', 'null'], enum: [...entries, null] } }, 1),
    relations: list({ subject: TEXT, verb: TEXT, object: TEXT, part: TEXT, side: { type: 'string', enum: ['left', 'right', ''] },
      essential: { type: 'boolean' }, quote: TEXT }),
    gazes: list(said), faces: list(said), clothes: list(said), scale: list({ text: TEXT, quote: TEXT }),
    target: each(['contact', 'participants', 'moment'], YN),
    contradictions: list({ entry: { type: 'string', enum: entries }, quote: TEXT }),
  });
}
// The other three take the ids of their bundle and values from their enums, and nothing else.
export function textSchema(input: TextInput): Schema {
  const asked = input.checklist.items.filter(item => item.kind === 'relation' || item.kind === 'gaze' || item.kind === 'clothes').map(item => item.id);
  return strict({ prompts: each(input.prompts.map(prompt => prompt.id), each(asked, YN)), facing: each(input.portraits.map(one => one.entry), YNU),
    fronts: each(input.portraits.filter(one => one.front).map(one => one.entry), each(['face_hair', 'build_marks'], YNU)),
    views: each(input.portraits.filter(one => one.view).map(one => one.entry), each(['same_person', 'turned'], YNU)) });
}
export function picturesSchema(input: PicturesInput): Schema {
  const people = input.checklist.participants;
  return strict({ pictures: each(input.pictures, strict({ participants: each(people.map(one => one.id), PRESENCE),
    items: each(input.checklist.items.map(item => item.id), YNU), mixups: each([...MIXUPS], YNU), anatomy: YNU,
    looks: each(people.filter(one => one.entry).map(one => one.id), YNU) })) });
}
export function identitySchema(input: IdentityInput): Schema {
  return strict({ pictures: each(input.pictures, each(input.portraits.map(one => one.entry), each(['present', 'face', 'build'], YNU))) });
}
// Each kind's schema as one hash for the pins: the schema built for a made-up bundle of every item kind.
function schemaTemplates(): Record<string, string> {
  const checklist: ShownChecklist = { participants: [{ id: 'p1', handle: 'h', entry: 'e1' }], items: (['relation', 'gaze', 'face', 'clothes', 'scale'] as ItemKind[])
    .map(kind => ({ id: `${PREFIX[kind]}1`, kind, quote: 'q' })) };
  return { checklist: sha256(JSON.stringify(checklistSchema(['e1']))),
    text: sha256(JSON.stringify(textSchema({ scene: '', sheet: [], checklist, shot: '', prompts: [{ id: 'q1', text: '' }],
      portraits: [{ entry: 'e1', facing: 'away', front: 'front-e1.png', view: 'view-e1.png', turn: 'away' }] }))),
    pictures: sha256(JSON.stringify(picturesSchema({ scene: '', sheet: [], checklist, pictures: ['pic-0.png'] }))),
    identity: sha256(JSON.stringify(identitySchema({ pictures: ['pic-0.png'], portraits: [{ entry: 'e1', handle: null, front: 'front-e1.png' }] }))) };
}
// What the judging is pinned to: the models, the effort, each task and each schema by its hash, and the sizes the
// pictures are attached at.
export function judgePins(): Record<string, string | number> {
  const schemas = schemaTemplates();
  return { model: JUDGE.model, fallback: JUDGE.fallback, effort: JUDGE.effort, attached: Object.values(ATTACHED).join(','),
    referenceSize: `${SCALED.width}x${SCALED.height}`,
    ...Object.fromEntries(Object.entries(TASKS).map(([kind, text]) => [`task.${kind}`, sha256(text)])),
    ...Object.fromEntries(Object.entries(schemas).map(([kind, hash]) => [`schema.${kind}`, hash])) };
}

// ---- The checklist ----

export type ItemKind = 'relation' | 'gaze' | 'face' | 'clothes' | 'scale';
export const PREFIX: Record<ItemKind, string> = { relation: 'r', gaze: 'g', face: 'f', clothes: 'c', scale: 's' };
type Said = { who: string; text: string; quote: string };
// The checklist as the session writes it.
export type RawChecklist = {
  participants: { handle: string; entry: string | null }[];
  relations: { subject: string; verb: string; object: string; part: string; side: 'left' | 'right' | ''; essential: boolean; quote: string }[];
  gazes: Said[]; faces: Said[]; clothes: Said[]; scale: { text: string; quote: string }[];
  target: { contact: 'yes' | 'no'; participants: 'yes' | 'no'; moment: 'yes' | 'no' };
  contradictions: { entry: string; quote: string }[];
};
// As code stores it, every item with an id of its own and every participant named by theirs.
export type ChecklistItem = { id: string; kind: ItemKind; subject?: string; verb?: string; object?: string; part?: string; side?: string;
  essential?: boolean; who?: string; text?: string; quote: string };
export type Checklist = { story: string; participants: { id: string; handle: string; entry: string | null }[]; items: ChecklistItem[];
  target: RawChecklist['target']; contradictions: RawChecklist['contradictions'] };
// What the scoring reads, and all that leaves a sharp story: ids, kinds, which relations are essential, which
// participant is which entry and so which portrait, and whether the scene reached its target.
export type Projection = { story: string; reached: boolean; participants: { id: string; entry: string | null; portrait: string | null }[];
  items: { id: string; kind: ItemKind; essential?: boolean }[]; contradictions: number };
// What sessions 2 and 3 are shown of it: everything but which relations count as essential.
export type ShownChecklist = { participants: Checklist['participants']; items: Omit<ChecklistItem, 'essential'>[] };

const handleKey = (handle: string) => handle.trim().toLowerCase();
// Beyond its schema, a checklist must hold together: handles that are there and apart, each entry at most once, and
// every relation, gaze, face and clothes item about participants it lists, a relation about two of them.
export function checklistHolds(raw: RawChecklist): boolean {
  const handles = raw.participants.map(one => handleKey(one.handle));
  const entries = raw.participants.flatMap(one => one.entry === null ? [] : [one.entry]);
  const known = (handle: string) => handles.includes(handleKey(handle));
  return handles.every(Boolean) && new Set(handles).size === handles.length && new Set(entries).size === entries.length
    && raw.relations.every(one => known(one.subject) && known(one.object) && handleKey(one.subject) !== handleKey(one.object))
    && [...raw.gazes, ...raw.faces, ...raw.clothes].every(one => known(one.who));
}
export function withIds(story: string, raw: RawChecklist): Checklist {
  const participants = raw.participants.map((one, at) => ({ id: `p${at + 1}`, handle: one.handle.trim(), entry: one.entry }));
  const id = (handle: string) => participants.find(one => handleKey(one.handle) === handleKey(handle))!.id;
  const said = (kind: ItemKind, list: Said[]) => list.map((one, at) => ({ id: `${PREFIX[kind]}${at + 1}`, kind, who: id(one.who), text: one.text, quote: one.quote }));
  return { story, participants, items: [
    ...raw.relations.map((one, at) => ({ id: `r${at + 1}`, kind: 'relation' as const, subject: id(one.subject), verb: one.verb, object: id(one.object),
      part: one.part, side: one.side, essential: one.essential, quote: one.quote })),
    ...said('gaze', raw.gazes), ...said('face', raw.faces), ...said('clothes', raw.clothes),
    ...raw.scale.map((one, at) => ({ id: `s${at + 1}`, kind: 'scale' as const, text: one.text, quote: one.quote }))],
  target: raw.target, contradictions: raw.contradictions };
}
export function projectionOf(checklist: Checklist): Projection {
  const { target } = checklist;
  return { story: checklist.story, reached: target.contact === 'yes' && target.participants === 'yes' && target.moment === 'yes',
    participants: checklist.participants.map(one => ({ id: one.id, entry: one.entry, portrait: one.entry ? `${checklist.story}-${one.entry}` : null })),
    items: checklist.items.map(item => ({ id: item.id, kind: item.kind, ...(item.kind === 'relation' ? { essential: item.essential === true } : {}) })),
    contradictions: checklist.contradictions.length };
}
const shown = (checklist: Checklist): ShownChecklist => ({ participants: checklist.participants,
  items: checklist.items.map(({ essential: _essential, ...item }) => item) });

// ---- The bundles ----

type SheetLine = { entry: string; name: string; look: string; outfit: string };
export type ChecklistInput = { scene: string; target: { contact: string; participants: string[] }; sheet: SheetLine[] };
export type TextInput = { scene: string; sheet: SheetLine[]; checklist: ShownChecklist; shot: string; prompts: { id: string; text: string }[];
  portraits: { entry: string; facing: Facing; front?: string; view?: string; turn?: Turn }[] };
export type PicturesInput = { scene: string; sheet: SheetLine[]; checklist: ShownChecklist; pictures: string[] };
export type IdentityInput = { pictures: string[]; portraits: { entry: string; handle: string | null; front: string }[] };
// Which arm drew which picture, and which prompt is which: kept in the story's `keys/`, never in a bundle.
export type BundleKey = { story: string; kind: SessionKind; seed?: number; task: string; schema: string; input: string;
  pictures?: { name: string; arms: ActionArm[]; sha256: string }[]; prompts?: { id: string; arm: ActionArm }[];
  fronts?: { entry: string; portrait: string; sha256: string }[]; views?: { entry: string; view: string; sha256: string }[] };

export const bundleDir = (root: string, session: Session) => join(storyDir(root, session.story), 'bundles', sessionName(session));
export const keyFile = (root: string, session: Session) => join(storyDir(root, session.story), 'keys', `${sessionName(session)}.json`);
export const answersFile = (root: string, session: Session, owner = false) =>
  join(storyDir(root, session.story), 'answers', `${sessionName(session)}${owner ? '.owner' : ''}.json`);
const sheetLines = (sheet: Character[]): SheetLine[] => sheet.map((one, at) => ({ entry: entryId(at), name: one.name, look: one.look, outfit: one.outfit ?? '' }));

// The action scene as the narrator wrote it, from the story's own store.
export function sceneOf(root: string, story: string, nodeId: string): string {
  const store = new Store(join(storyDir(root, story), 'story.sqlite'));
  try { return Object.values(store.read(USER).stories)[0]?.nodes[nodeId]?.text ?? ''; } finally { store.close(); }
}

// A bundle: its task, its inputs, its schema and its files, written once; the key beside the story's other keys.
function writeBundle(root: string, session: Session, input: object, schema: Schema, files: { name: string; from: string }[], key: Partial<BundleKey>) {
  const dir = bundleDir(root, session);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const task = taskOf(session.kind);
  const inputText = JSON.stringify(input, null, 2);
  writeFileSync(join(dir, 'TASK.md'), task + '\n', { mode: 0o600 });
  writeFileSync(join(dir, 'input.json'), inputText, { mode: 0o600 });
  writeFileSync(join(dir, 'schema.json'), JSON.stringify(schema, null, 2), { mode: 0o600 });
  for (const file of files) copyFileSync(file.from, join(dir, file.name));
  writeJson(keyFile(root, session), { story: session.story, kind: session.kind, ...(session.seed === undefined ? {} : { seed: session.seed }),
    task: sha256(task), schema: sha256(JSON.stringify(schema)), input: sha256(inputText), ...key });
}

export type BundleCounts = { built: number; kept: number; skipped: Record<string, number> };
const skip = (counts: BundleCounts, why: string) => { counts.skipped[why] = (counts.skipped[why] ?? 0) + 1; };

// The 18 checklists' bundles, from the texts alone, before the picture card: a story without its action scene or its
// sheet has none.
export function checklistBundles(root: string, log: (event: object) => void = () => undefined): BundleCounts {
  const counts: BundleCounts = { built: 0, kept: 0, skipped: {} };
  for (const story of textStories()) {
    const session: Session = { story: story.id, kind: 'checklist' };
    const text = readJson<StoryText>(join(storyDir(root, story.id), 'text.json'));
    if (!text?.worn?.length || !text.nodeId || text.steps.action?.outcome !== 'ok') { skip(counts, 'no_text'); continue; }
    if (existsSync(bundleDir(root, session))) { counts.kept++; continue; }
    const set = ACTION_STORIES.find(one => one.id === story.id);
    const input: ChecklistInput = { scene: sceneOf(root, story.id, text.nodeId),
      target: set ? set.target : { contact: SHARP_TARGET, participants: [] }, sheet: sheetLines(text.worn) };
    writeBundle(root, session, input, checklistSchema(input.sheet.map(line => line.entry)), [], {});
    counts.built++;
    log({ event: 'bundle_written', story: story.id, session: sessionName(session) });
  }
  return counts;
}

// A drawn file as the bundles take it: there, the very file its record names, at the size it was drawn at.
function drawnFile(root: string, draw: DrawIndex, key: string, size: string) {
  const cell = draw.cells[key];
  if (cell?.status !== 'drawn' || !cell.file) return undefined;
  const path = join(root, cell.file);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const own = pngSize(bytes);
  if (sha256(bytes) !== cell.sha256 || `${own.width}x${own.height}` !== size) throw new Refusal(`${key} is not the file draw.json recorded; the bundles are not built from it`);
  return { path, sha256: cell.sha256! };
}

// The bundles after the card, for every story whose checklist is stored: the text and the portraits; the pictures of
// each seed, named by their hashes and in their order, C's picture once where it stands for V; the repeat of the four
// scenes at seed 7; and the identity of each seed, where somebody bound has a front.
export function pictureBundles(root: string, log: (event: object) => void = () => undefined): BundleCounts {
  const draw = readJson<DrawIndex>(join(root, 'draw.json'));
  if (!draw) throw new Refusal(`${join(root, 'draw.json')} is missing: the bundles are built from the drawn pictures`);
  const counts: BundleCounts = { built: 0, kept: 0, skipped: {} };
  const repeated = repeatedScenes();
  for (const story of textStories()) {
    const dir = storyDir(root, story.id);
    const checklist = readJson<Checklist>(join(dir, 'checklist.json'));
    const text = readJson<StoryText>(join(dir, 'text.json'));
    const plan = readPlan(root, story.id);
    if (!checklist || !text?.worn || !text.nodeId || !plan) { skip(counts, 'no_checklist'); continue; }
    const scene = sceneOf(root, story.id, text.nodeId);
    const sheet = sheetLines(text.worn);
    const bound = plan.manifest && !plan.manifest.stop ? plan.manifest.bound : [];
    const fronts = bound.flatMap(one => {
      const file = drawnFile(root, draw, `front:${one.portrait}`, ATTACHED.front);
      return file ? [{ ...one, file }] : [];
    });
    const handleOf = (entry: string) => checklist.participants.find(one => one.entry === entry)?.handle ?? null;
    const build = (session: Session, input: object, schema: Schema, files: { name: string; from: string }[], key: Partial<BundleKey>) => {
      if (existsSync(bundleDir(root, session))) { counts.kept++; return; }
      writeBundle(root, session, input, schema, files, key);
      counts.built++;
      log({ event: 'bundle_written', story: story.id, session: sessionName(session), files: files.length });
    };

    // The text and the portraits: A's and A+'s prompts in the order of their hashes, each front and each view.
    const prompts = (['A', 'A+'] as ActionArm[]).flatMap(arm => plan.arms[arm] ? [{ arm, text: plan.arms[arm]!.prompt }] : [])
      .sort((a, b) => sha256(a.text).localeCompare(sha256(b.text))).map((one, at) => ({ id: `q${at + 1}`, ...one }));
    const views = bound.flatMap(one => {
      const view = plan.views.find(candidate => candidate.id === one.view);
      const file = view ? drawnFile(root, draw, `view:${view.id}`, ATTACHED.view) : undefined;
      return view && file ? [{ entry: one.entry, view, file }] : [];
    });
    const portraits = bound.map(one => {
      const front = fronts.find(candidate => candidate.entry === one.entry);
      const view = views.find(candidate => candidate.entry === one.entry);
      return { entry: one.entry, facing: one.facing, ...(front ? { front: `front-${one.entry}.png` } : {}),
        ...(view ? { view: `view-${one.entry}.png`, turn: view.view.turn } : {}) };
    });
    if (prompts.length || portraits.length) {
      const input: TextInput = { scene, sheet, checklist: shown(checklist), shot: text.variant?.shot ?? text.frame?.shot ?? '',
        prompts: prompts.map(({ id, text: prompt }) => ({ id, text: prompt })), portraits };
      build({ story: story.id, kind: 'text' }, input, textSchema(input),
        [...fronts.map(one => ({ name: `front-${one.entry}.png`, from: one.file.path })), ...views.map(one => ({ name: `view-${one.entry}.png`, from: one.file.path }))],
        { prompts: prompts.map(({ id, arm }) => ({ id, arm })), fronts: fronts.map(one => ({ entry: one.entry, portrait: one.portrait, sha256: one.file.sha256 })),
          views: views.map(one => ({ entry: one.entry, view: one.view.id, sha256: one.file.sha256 })) });
    } else skip(counts, 'no_prompt');

    for (const seed of ACTION_SEEDS) {
      // The seed's pictures, one per file: an arm whose picture is another's byte for byte is shown once, and so is C's
      // where it stands for V.
      const pictures: { name: string; arms: ActionArm[]; sha256: string; path: string }[] = [];
      for (const arm of ARMS) {
        const file = drawnFile(root, draw, frameKey(story.id, seed, arm), ATTACHED.frame);
        if (!file) continue;
        const same = pictures.find(one => one.sha256 === file.sha256);
        const arms: ActionArm[] = arm === 'C' && plan.vIsC ? ['C', 'V'] : [arm];
        if (same) same.arms.push(...arms);
        else pictures.push({ name: `pic-${file.sha256.slice(0, 8)}.png`, arms, sha256: file.sha256, path: file.path });
      }
      if (!pictures.length) { skip(counts, 'no_picture'); continue; }
      pictures.sort((a, b) => a.name.localeCompare(b.name));
      const names = pictures.map(one => one.name);
      const files = pictures.map(one => ({ name: one.name, from: one.path }));
      const key = { pictures: pictures.map(({ name, arms, sha256: hash }) => ({ name, arms, sha256: hash })) };
      const input: PicturesInput = { scene, sheet, checklist: shown(checklist), pictures: names };
      build({ story: story.id, kind: 'pictures', seed }, input, picturesSchema(input), files, key);
      if (seed === ACTION_SEEDS[0] && repeated.includes(story.id)) build({ story: story.id, kind: 'repeat', seed }, input, picturesSchema(input), files, key);
      if (!fronts.length) { skip(counts, 'nobody_bound'); continue; }
      const identity: IdentityInput = { pictures: names, portraits: fronts.map(one => ({ entry: one.entry, handle: handleOf(one.entry), front: `front-${one.entry}.png` })) };
      build({ story: story.id, kind: 'identity', seed }, identity, identitySchema(identity),
        [...files, ...fronts.map(one => ({ name: `front-${one.entry}.png`, from: one.file.path }))],
        { ...key, fronts: fronts.map(one => ({ entry: one.entry, portrait: one.portrait, sha256: one.file.sha256 })) });
    }
  }
  return counts;
}

// Every bundle there is, in the set's order and then by kind and seed.
export function bundledSessions(root: string): Session[] {
  return textStories().flatMap(story => {
    const dir = join(storyDir(root, story.id), 'bundles');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap(name => { const session = parseSession(story.id, name); return session ? [session] : []; })
      .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.seed ?? 0) - (b.seed ?? 0));
  });
}
// The files a session is shown, in the order its inputs name them, attached with `-i`.
function attachments(dir: string, kind: SessionKind): string[] {
  const input = JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8')) as Partial<TextInput & PicturesInput & IdentityInput>;
  const names = kind === 'text' ? (input.portraits ?? []).flatMap(one => [one.front, one.view].filter((name): name is string => !!name))
    : kind === 'identity' ? [...input.pictures ?? [], ...(input.portraits as IdentityInput['portraits'] | undefined ?? []).map(one => one.front)]
      : input.pictures ?? [];
  return names.map(name => join(dir, name));
}

// ---- The sessions' runs ----

// `codex exec` as the second panel ran it: fresh and ephemeral, no user config or rules, a read-only sandbox, the
// model and the effort pinned, started in the session's own copy, its report where `-o` says, its pictures attached.
export function codexArgs({ model, dir, report, images, prompt }: { model: string; dir: string; report: string; images: string[]; prompt: string }) {
  return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--color', 'never', '-m', model, '-c', `model_reasoning_effort="${JUDGE.effort}"`, '-C', dir, '-o', report,
    ...images.flatMap(image => ['-i', image]), '--', prompt];
}
// How a session is started: its command and arguments, its working directory and environment, the files its stdout
// (the events) and stderr go to, and its deadline. It answers with the exit code once the process has exited: at the
// deadline it is asked to stop, killed two seconds later if it has not, and still waited for, so nothing of it runs on.
export type Exec = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: string; stderr: string;
  signal: AbortSignal }) => Promise<number>;
export const spawnExec: Exec = (command, args, { cwd, env, stdout, stderr, signal }) => new Promise(done => {
  const out = openSync(stdout, 'w', 0o600), err = openSync(stderr, 'w', 0o600);
  let ended = false, kill: NodeJS.Timeout | undefined;
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', out, err] });
  const stop = () => {
    child.kill('SIGTERM');
    kill ??= setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const end = (code: number) => {
    if (ended) return;
    ended = true;
    clearTimeout(kill);
    signal.removeEventListener('abort', stop);
    closeSync(out);
    closeSync(err);
    done(code);
  };
  child.on('error', () => end(-1));
  child.on('close', code => end(code ?? -1));
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
});
// A session's deadline. One still running at it, waiting on the network or anywhere else, is ended as above, and its
// attempt is recorded as `timeout`: an attempt without answers, as one without a valid block is.
export const SESSION_MS = 30 * 60000;

// A report's answers: its last JSON block, parsed. Nothing of a block that does not parse is kept or shown: the parser's
// message quotes it.
export type Read = { code: 'ok' | 'no_report' | 'no_block' | 'unparsed_block' | 'schema' | 'timeout'; value?: unknown };
export function answersOf(report: string | undefined): Read {
  if (report === undefined) return { code: 'no_report' };
  const block = [...report.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  if (block === undefined) return { code: 'no_block' };
  try { return { code: 'ok', value: JSON.parse(block) }; } catch { return { code: 'unparsed_block' }; }
}
// The answers against the bundle's own schema, and a checklist also against its own coherence.
export function validated(root: string, session: Session, read: Read): Read {
  if (read.code !== 'ok') return read;
  const schema = JSON.parse(readFileSync(join(bundleDir(root, session), 'schema.json'), 'utf8')) as Schema;
  const fits = fitsSchema(read.value, schema) && (session.kind !== 'checklist' || checklistHolds(read.value as RawChecklist));
  return fits ? read : { code: 'schema' };
}

// The run's record of the judging, `judging.json`: its pins and each session's attempts, by model, code and time.
export type AttemptRecord = { model: string; code: Read['code']; exitCode?: number; ms: number };
export type SessionRecord = Session & { state?: 'answered' | 'failed' | 'owner'; by?: 'judge' | 'owner'; attempts: AttemptRecord[] };
export type JudgingRecord = { pins: Record<string, string | number>; sessions: Record<string, SessionRecord> };

// Valid answers go into the story's `answers/`; a checklist also gets its ids, and its projection goes to the run's
// `checklists.json`.
function store(root: string, session: Session, value: unknown) {
  writeJson(answersFile(root, session), value);
  if (session.kind !== 'checklist') return;
  const checklist = withIds(session.story, value as RawChecklist);
  writeJson(join(storyDir(root, session.story), 'checklist.json'), checklist);
  const file = join(root, 'checklists.json');
  const projections = readJson<Record<string, Projection>>(file) ?? {};
  projections[session.story] = projectionOf(checklist);
  writeJson(file, Object.fromEntries(textStories().flatMap(story => projections[story.id] ? [[story.id, projections[story.id]]] : [])));
}

export type JudgeOptions = { root: string; kinds?: SessionKind[]; stories?: string[]; parallel?: number; exec?: Exec; codex?: string;
  log?: (event: object) => void };
const recordFile = (root: string) => join(root, 'judging.json');
function openRecord(root: string): JudgingRecord {
  const pins = judgePins();
  const record = readJson<JudgingRecord>(recordFile(root)) ?? { pins, sessions: {} };
  const changed = [...new Set([...Object.keys(pins), ...Object.keys(record.pins)])].find(key => record.pins[key] !== pins[key]);
  if (changed) throw new Refusal(`${recordFile(root)} was judged under another ${changed}; one run directory holds one set of pins`);
  return record;
}

// Runs every session that is ready, N at a time: its bundle there, no answers yet, an attempt left, and for identity
// the pictures' answers of the same scene and seed stored. A session is collected as soon as it ends, and its fresh
// session or the next kind starts from there.
export async function judgeSessions(options: JudgeOptions): Promise<JudgingRecord> {
  const root = resolve(options.root);
  const record = openRecord(root);
  const log = options.log ?? (() => undefined);
  const exec = options.exec ?? spawnExec;
  const save = () => writeJson(recordFile(root), record);
  const answered = (key: string) => record.sessions[key]?.state === 'answered';
  const ready = (session: Session) => {
    const known = record.sessions[sessionKey(session)];
    return !known?.state && (known?.attempts.length ?? 0) < modelsFor(session.story).length
      && (!options.kinds || options.kinds.includes(session.kind)) && (!options.stories || options.stories.includes(session.story))
      && (session.kind !== 'identity' || answered(`${session.story}/${sessionName({ kind: 'pictures', seed: session.seed })}`));
  };
  const attempt = async (session: Session) => {
    const key = sessionKey(session);
    const entry = record.sessions[key] ??= { ...session, attempts: [] };
    const models = modelsFor(session.story);
    const model = models[entry.attempts.length];
    const sealed = isSharp(session.story);
    const base = sealed ? join(root, 'sealed', 'sessions') : join(root, 'sessions');
    const name = `${session.story}.${sessionName(session)}.${entry.attempts.length + 1}`;
    const copy = join(base, name), report = join(base, `${name}.report.md`);
    rmSync(copy, { recursive: true, force: true });
    rmSync(report, { force: true });
    mkdirSync(base, { recursive: true, mode: 0o700 });
    cpSync(bundleDir(root, session), copy, { recursive: true });
    const tmp = join(root, 'sealed', 'tmp');
    if (sealed) mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const began = performance.now();
    const deadline = AbortSignal.timeout(SESSION_MS);
    const exitCode = await exec(options.codex ?? 'codex', codexArgs({ model, dir: copy, report, images: attachments(copy, session.kind), prompt: taskOf(session.kind) }),
      { cwd: copy, env: sealed ? { ...process.env, TMPDIR: tmp } : process.env, stdout: join(base, `${name}.events.jsonl`), stderr: join(base, `${name}.stderr.log`),
        signal: deadline });
    const read: Read = deadline.aborted ? { code: 'timeout' }
      : validated(root, session, answersOf(existsSync(report) ? readFileSync(report, 'utf8') : undefined));
    entry.attempts.push({ model, code: read.code, ...(exitCode === 0 ? {} : { exitCode }), ms: Math.round(performance.now() - began) });
    if (read.code === 'ok') {
      store(root, session, read.value);
      entry.state = 'answered';
      entry.by = 'judge';
    } else if (entry.attempts.length >= models.length) {
      entry.state = sealed ? 'owner' : 'failed';
      if (sealed) ownerPage(root, session);
    }
    save();
    log({ event: 'session_done', story: session.story, session: sessionName(session), attempt: entry.attempts.length, model, code: read.code,
      ...(exitCode === 0 ? {} : { exitCode }), ...(entry.state ? { state: entry.state } : {}) });
  };
  const running = new Map<string, Promise<void>>();
  for (;;) {
    const next = bundledSessions(root).filter(session => !running.has(sessionKey(session)) && ready(session));
    while (running.size < (options.parallel ?? 4) && next.length) {
      const session = next.shift()!;
      running.set(sessionKey(session), attempt(session).finally(() => running.delete(sessionKey(session))));
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  save();
  return record;
}

// The owner's page for a sharp session both judges left without valid answers: the task, the inputs, the files and
// the answers' form, inside `sealed/`. The owner saves the answers as the file the page names, and `collect` reads it.
export function ownerPage(root: string, session: Session): string {
  const dir = bundleDir(root, session);
  const page = join(root, 'sealed', 'owner', `${session.story}.${sessionName(session)}.html`);
  const input = readFileSync(join(dir, 'input.json'), 'utf8');
  const schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')) as Schema;
  const form = (one: Schema): unknown => one.enum ? one.enum.join(' | ') : one.properties
    ? Object.fromEntries(Object.entries(one.properties).map(([name, value]) => [name, form(value)])) : one.type === 'array' ? [form(one.items ?? {})] : String(one.type);
  const images = attachments(dir, session.kind).map(file => relative(dirname(page), file));
  mkdirSync(dirname(page), { recursive: true, mode: 0o700 });
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(sessionKey(session))}</title>
<h1>${escapeHtml(sessionKey(session))}</h1>
<p>Ни один судья не дал ответа по схеме. Ответ сохраните как <code>${escapeHtml(answersFile(root, session, true))}</code>, затем <code>npm run image:action -- collect</code>.</p>
<pre>${escapeHtml(taskOf(session.kind))}</pre>
${images.map(src => `<figure><img src="${escapeHtml(src)}" style="max-width:100%"><figcaption>${escapeHtml(src.split('/').at(-1)!)}</figcaption></figure>`).join('\n')}
<h2>input.json</h2><pre>${escapeHtml(input)}</pre>
<h2>Форма ответа</h2><pre>${escapeHtml(JSON.stringify(form(schema), null, 2))}</pre>
`, { mode: 0o600 });
  return page;
}

// What `collect` does besides the judging's own collecting: the owner's answers to the sessions both judges left, read
// as strictly as a judge's, and the counts of every session by kind and state.
export function collectAnswers(root: string, log: (event: object) => void = () => undefined) {
  root = resolve(root);
  const record = openRecord(root);
  for (const entry of Object.values(record.sessions)) {
    if (entry.state !== 'owner') continue;
    const file = answersFile(root, entry, true);
    if (!existsSync(file)) continue;
    let read: Read;
    try { read = validated(root, entry, { code: 'ok', value: JSON.parse(readFileSync(file, 'utf8')) }); } catch { read = { code: 'unparsed_block' }; }
    log({ event: 'owner_answers', story: entry.story, session: sessionName(entry), code: read.code });
    if (read.code !== 'ok') continue;
    store(root, entry, read.value);
    entry.state = 'answered';
    entry.by = 'owner';
  }
  writeJson(recordFile(root), record);
  return judgingCounts(root, record);
}

// Every bundled session by kind: answered by a judge or the owner, failed, waiting for the owner, or not yet run.
export function judgingCounts(root: string, record: JudgingRecord = openRecord(resolve(root))) {
  const counts: Record<string, Record<string, number>> = {};
  for (const session of bundledSessions(resolve(root))) {
    const entry = record.sessions[sessionKey(session)];
    const state = entry?.state === 'answered' ? `answered_by_${entry.by}` : entry?.state ?? (entry?.attempts.length ? 'retry' : 'pending');
    const kind = counts[session.kind] ??= {};
    kind[state] = (kind[state] ?? 0) + 1;
  }
  const attempts = Object.values(record.sessions).reduce((sum, entry) => sum + entry.attempts.length, 0);
  return { sessions: counts, attempts };
}
