// A person's appearance along the story (the owner's design of 2026-09-28, «Делай», for the tester's «версонировать
// персонажей каким то образом в каждый момент истории или на чекпоинтах»; docs/telegram-ui.md#along-the-story).
//
// The sheet is each person as the story's first scene has them. A version holds from one scene on and only where the
// story or the reader changed something: a lasting change the story made, as the frame of that scene named it (a haircut,
// a scar, dyed hair), or what the reader wrote «only from this moment». It sits on its scene (lib/library.ts
// `SceneNode.appearance`), and the version in force at any scene is the nearest one up its own line, as the clothes are
// found (local/picture.ts `wornAt`). A branch, a checkpoint and going back to one need nothing of their own: a scene
// above the change, or on another line, never sees it, and deleting a branch deletes its scenes and their versions with
// them. A story without versions is drawn from its sheet exactly as before.
//
// A version holds text alone. Only what the story changes varies along it: the changes, and the details and the look
// retold from the description with them. The portrait, the references and a portrait's own prompt are the person's and
// stay on the sheet, one for the whole story.
//
// What wins where two disagree is what is later: a change the story made at a scene wins over the description in force
// above it, the story's or the reader's, since it happened after it (`LATER`); the description the reader wrote «only from
// this moment» wins over the changes above it, as the reader's description on the sheet wins over the changes the sheet
// took from the story (the owner, 2026-09-27); and a look the reader wrote stays in the frames until they write a
// description, as on the sheet, whatever the story changes meanwhile.
//
// The frame's new field, the retelling's added rule and the edits of readers who have versions (config
// SIMPLE_CHAT_SHEET_VERSION_USERS) are added here, at the call, as local/picture-pov.ts adds its own: local/illustrate.ts
// stays as it is, since the action experiment pins what its request builders return (local/action-text.ts `textPins`).
import { createHash } from 'node:crypto';
import type { Library, SheetVersion, Story } from '../lib/library.ts';
import { matchSheet } from './illustrate.ts';
import type { Character } from './illustrate.ts';
import type { ModelRequest } from './model.ts';

type SheetEntry = NonNullable<Story['sheet']>[number];
// A person of a sheet is their name, apart from spaces and case (local/picture.ts `rewrittenSheet`).
export const personKey = (name: string) => name.trim().toLowerCase();
// A person's description as the card shows it and the retelling reads it (docs/illustrations-plan.md#three-layers): the
// one the sheet took from the story, or the reader's. A sheet written before 2026-09-27 has none, and its details stand
// in until the sheet is written again: the reader's own text, or the English prose the sheet wrote since 2026-09-26.
export const descriptionOf = (person: SheetEntry) => person.description ?? person.details ?? '';
// Whether that description is the reader's own: written on the card since 2026-09-27, or as details before that day.
export const ownDescription = (person: SheetEntry) =>
  person.description === undefined ? !!person.detailsEdited && !!person.details?.trim() : !!person.descriptionEdited;

// What a person's details and look are retold from at one scene: the description in force there, the changes the story
// made before it, which it wins over where they disagree, and those made after it, which win over both (`LATER`).
export type Inputs = { description: string; earlier: string[]; later: string[] };
type Step = { nodeId: string; key: string; version: SheetVersion };
const textOf = (value: unknown) => typeof value === 'string' ? value : undefined;
const listOf = (value: unknown) => Array.isArray(value)
  ? value.filter((one): one is string => typeof one === 'string' && !!one.trim()).map(one => one.trim()) : [];
const changesOf = (steps: Step[]) => steps.flatMap(one => listOf(one.version.changes));
// A change as another is compared with it: apart from case, and a full stop or a semicolon at its end.
const same = (text: string) => text.trim().replace(/[.;]+$/, '').toLowerCase();
const stampOf = (inputs: Inputs) => createHash('sha256').update(JSON.stringify([inputs.description, inputs.earlier, inputs.later])).digest('hex').slice(0, 16);

// The versions of every person on the line from the story's first scene down to `nodeId`, oldest first, by person.
function versionsAlong(story: Story, nodeId: string | null | undefined): Map<string, Step[]> {
  const along = new Map<string, Step[]>();
  const seen = new Set<string>();
  for (let id = nodeId ?? null; id && !seen.has(id); id = story.nodes[id]?.parent ?? null) {
    seen.add(id);
    for (const [key, version] of Object.entries(story.nodes[id]?.appearance ?? {})) {
      if (!version || typeof version !== 'object') continue;
      along.set(personKey(key), [{ nodeId: id, key, version }, ...along.get(personKey(key)) ?? []]);
    }
  }
  return along;
}

// One person as the versions of their line leave them. The details and the look are those retold for the nearest scene
// that gave them something to retell (`source`), and `fresh` says whether they were retold from what is in force now;
// until they are, the nearest retold above stands, and the sheet's own under all of them, and the person is pending.
function resolve(base: SheetEntry, along: Step[]) {
  const told = along.findLastIndex(one => textOf(one.version.description) !== undefined);
  // A change named once more further down the line, by the frame of a scene in between drawn later, counts once.
  const seen = new Set((base.changes ?? '').split(';').map(same));
  const once = (list: string[]) => list.filter(one => !seen.has(same(one)) && !!seen.add(same(one)));
  const inputs: Inputs = { description: told < 0 ? descriptionOf(base) : textOf(along[told].version.description)!,
    earlier: [...base.changes?.trim() ? [base.changes.trim()] : [], ...once(changesOf(along.slice(0, told + 1)))],
    later: once(changesOf(along.slice(told + 1))) };
  // A description of the reader's replaces a look of theirs written above it, as on the sheet, and a look written at
  // the same scene as a description came after it.
  let own = base.edited ? base.look : undefined;
  for (const { version } of along) {
    if (textOf(version.description) !== undefined) own = undefined;
    if (textOf(version.look) !== undefined) own = version.look;
  }
  const at = along.findLastIndex(one => textOf(one.version.description) !== undefined || listOf(one.version.changes).length > 0);
  const source = at < 0 ? undefined : along[at];
  const stamp = stampOf(inputs);
  const fresh = !source || source.version.retold?.from === stamp;
  const entry: SheetEntry = { ...base };
  if (told >= 0) Object.assign(entry, { description: inputs.description, descriptionEdited: true });
  if (changesOf(along).length) entry.changes = [...inputs.earlier, ...inputs.later].join('; ');
  if (source) {
    const retold = source.version.retold ?? along.slice(0, at).reverse().find(one => one.version.retold)?.version.retold;
    if (retold) { entry.details = retold.details; delete entry.detailsEdited; }
    entry.look = retold?.look ?? base.look;
    if (fresh) delete entry.lookPending; else entry.lookPending = true;
  }
  if (own !== undefined) Object.assign(entry, { look: own, edited: true }); else delete entry.edited;
  return { entry, source, inputs, stamp, fresh, count: along.length };
}

// The sheet of a story as it stands at the scene `nodeId`, in the sheet's order, each person with the versions of that
// scene's line: what a frame of that scene is drawn with, and what the characters' card shows at the reader's scene.
// Without versions on the line, or with no scene, it is the sheet itself, the very same entries.
export function sheetAt(story: Story, nodeId: string | null | undefined): SheetEntry[] {
  const sheet = story.sheet ?? [];
  const along = versionsAlong(story, nodeId);
  if (!along.size) return sheet;
  return sheet.map(one => {
    const mine = one && typeof one.name === 'string' ? along.get(personKey(one.name)) : undefined;
    return mine?.length ? resolve(one, mine).entry : one;
  });
}

// How many versions of the person `name` the line down to `nodeId` holds: how many times their look changed by then,
// which their card says.
export function versionsOf(story: Story, nodeId: string | null | undefined, name: string): number {
  return versionsAlong(story, nodeId).get(personKey(name))?.length ?? 0;
}

// Every version of a story, on every line.
export function countVersions(story: Story | undefined): number {
  return Object.values(story?.nodes ?? {}).reduce((sum, node) => sum + Object.keys(node?.appearance ?? {}).length, 0);
}

// The people of the sheet at `nodeId` whose details and look are to be retold there, because their line holds something
// new to retell or what it was retold from changed since: a description written for the whole story, say, is under
// every change the story made. `key` names the version in its scene's `appearance`, which the retelling writes to only
// while it is still retold from `stamp`.
export function staleAt(story: Story, nodeId: string) {
  const along = versionsAlong(story, nodeId);
  if (!along.size) return [];
  return (story.sheet ?? []).flatMap((one, index) => {
    const mine = one && typeof one.name === 'string' ? along.get(personKey(one.name)) : undefined;
    const resolved = mine?.length ? resolve(one, mine) : undefined;
    return resolved?.source && !resolved.fresh && resolved.inputs.description.trim()
      ? [{ index, name: one.name, node: resolved.source.nodeId, key: resolved.source.key, inputs: resolved.inputs, stamp: resolved.stamp }] : [];
  });
}

// The scene a reader stands at in a story: the head of the branch they play, if they play that story, and otherwise
// none, where the sheet itself stands.
export function sceneOf(state: Partial<Library>, storyId: string): string | null {
  const active = state.active;
  if (active?.storyId !== storyId) return null;
  const story = state.stories && Object.hasOwn(state.stories, storyId) ? state.stories[storyId] : undefined;
  const branch = story && Object.hasOwn(story.branches ?? {}, active.branchId) ? story.branches[active.branchId] : undefined;
  return branch?.head ?? null;
}

// The person at the sheet's place `index` of the story `storyId` as its reader has them now: at the scene they stand at.
export function personHere(state: Partial<Library>, storyId: string, index: number): SheetEntry | undefined {
  const story = state.stories && Object.hasOwn(state.stories, storyId) ? state.stories[storyId] : undefined;
  return story ? sheetAt(story, sceneOf(state, storyId))[index] : undefined;
}

// The frame's field, for a reader who has versions. The rule is appended to the frame's instruction in its language,
// after the looks the frame is drawn with, so that the model compares the story with them and names a lasting change
// made in this scene or in one before it that no picture has shown. A person is named by their sheet name, as `who`
// names them. The field comes first in the answer, at its top level, and the frame's own fields follow it as before: on
// the card on 2026-09-28 a field appended last to each person, after `action`, left 42 answers of 124 unparsed, every
// one running away into whitespace right after `action`, while the same field right after `who` left none of 124
// (~/simple-story-chat-runs/2026-09-28/openjev/view_position.mts), and the point of view's fields at the top level none
// of 40. The point of view's viewer is left out of the list: their name must be nowhere in the answer
// (local/picture-pov.ts), and their look is in none of those frames.
const rule = (people: Character[]) => `
- lasting_changes: постоянные перемены внешности людей из списка ниже, которые история уже сделала, в последней сцене или раньше, но которых нет ни в их внешности, ни в их переменах ниже: остриженные, выбритые или отросшие волосы, перекрашенные или поседевшие волосы, сбритая или отпущенная борода, шрам, татуировка, потерянный глаз, палец или рука. По записи на перемену: who — имя из списка, change — одной короткой фразой на языке истории, какой стала внешность («волосы коротко острижены», «шрам через левую бровь»). Не перемены: одежда, украшения и то, что в руках; то, что смоется или пройдёт (мокрые, грязные или растрёпанные волосы, кровь, синяки, свежие раны и повязки, румянец, слёзы, причёска на один раз); поза, выражение лица и настроение; и то, в чём внешность ниже просто расходится с историей, а не изменилась по её ходу. Перемену, которая уже есть в переменах человека ниже, не называй снова, даже если его внешность её ещё не показывает. Если сомневаешься, это не перемена. Обычно перемен нет, и lasting_changes — пустой массив.
  Внешность людей из списка сейчас:
${people.map(one => `  - ${one.name}: ${one.look.trim().replace(/\.$/, '')}. Перемены: ${one.changes?.trim().replace(/\.$/, '') || 'нет'}.`).join('\n')}`;

// Room for the field in the answer: four changes of a short phrase each, and a margin.
const CHANGES_TOKENS = 150;
// The longest change taken, in characters: a short phrase is asked for, and a longer one is something else.
const CHANGE_CHARS = 200;
// The most changes one scene writes for one person, however often it is described again.
const CHANGES_PER_SCENE = 3;

// The frame's request as `frameRequest` built it, with the rule after its instruction and the field first in its
// schema. `people` are the frame's people the field may name. Without any, the request is left as it is.
export function changesRequest(request: ModelRequest, people: Character[]): ModelRequest {
  if (!people.length) return request;
  const schema = request.outputSchema as { required: string[]; properties: Record<string, unknown> };
  const last = request.messages.at(-1)!;
  const str = { type: 'string' };
  const field = { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['who', 'change'],
    properties: { who: str, change: str } } };
  return { ...request, maxOutputTokens: request.maxOutputTokens + CHANGES_TOKENS,
    outputSchema: { ...schema, required: ['lasting_changes', ...schema.required], properties: { lasting_changes: field, ...schema.properties } },
    messages: [...request.messages.slice(0, -1), { ...last, content: last.content + rule(people) }] };
}

// The changes an answer named, by sheet name among `names`, at most CHANGES_PER_SCENE each: an entry that names nobody
// of them, or has no change, or one too long to be a phrase, is left out.
export function lastingChangesOf(value: unknown, names: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const one of Array.isArray(value) ? value : []) {
    const { who, change } = (one ?? {}) as { who?: unknown; change?: unknown };
    const name = typeof who === 'string' ? matchSheet(who, names) : null;
    const text = typeof change === 'string' ? change.replace(/\s+/g, ' ').trim() : '';
    if (name === null || !text || [...text].length > CHANGE_CHARS || /^(?:нет|none|no|—|-)\.?$/i.test(text)) continue;
    const list = found.get(name) ?? [];
    if (list.length < CHANGES_PER_SCENE && !list.includes(text)) found.set(name, [...list, text]);
  }
  return found;
}

// Writes the changes a frame of the scene `nodeId` named into a version of each person at that scene, after what it
// holds already, and returns the names of those it wrote for. A change the person has in force there already, or one
// past CHANGES_PER_SCENE at this scene, is not written.
export function addChanges(story: Story, nodeId: string, found: Map<string, string[]>): string[] {
  const node = story.nodes[nodeId];
  if (!node) return [];
  const here = sheetAt(story, nodeId);
  return [...found].flatMap(([name, changes]) => {
    const person = here.find(one => one?.name === name);
    if (!person) return [];
    const known = new Set((person.changes ?? '').split(';').map(same));
    const key = keyAt(node.appearance, name);
    const version = node.appearance?.[key] ?? {};
    const fresh = changes.filter(one => !known.has(same(one))).slice(0, Math.max(0, CHANGES_PER_SCENE - listOf(version.changes).length));
    if (!fresh.length) return [];
    (node.appearance ??= {})[key] = { ...version, changes: [...listOf(version.changes), ...fresh] };
    return [name];
  });
}
// The key a scene holds the person `name` under, the sheet's name when it holds none yet.
const keyAt = (appearance: Record<string, SheetVersion> | undefined, name: string) =>
  Object.keys(appearance ?? {}).find(key => personKey(key) === personKey(name)) ?? name;

// The retelling's added rule: the changes the story made after the description in force, listed after the whole request
// as `retellRequest` built it, where its pinned rule has the description win over the story's changes. Those changes are
// the ones in its lines «Изменения из истории», made before it.
const LATER = 'Поздние перемены — постоянные перемены внешности, которые история сделала уже после описания и изменений из истории выше. Прибавь их к ним; где они расходятся с описанием или с изменениями из истории, верь поздним переменам: они новее.';
// `later` are the later changes of the people asked, by their index in the request.
export function laterRequest(request: ModelRequest, later: Map<number, string[]>): ModelRequest {
  if (!later.size) return request;
  const last = request.messages.at(-1)!;
  const lines = [...later].map(([index, changes]) => `- человек ${index + 1}: ${changes.join('; ')}`);
  return { ...request, messages: [...request.messages.slice(0, -1), { ...last, content: `${last.content}\n\n${LATER}\n${lines.join('\n')}` }] };
}

// Where an edit «only from this moment» of the story `storyId` would land for its reader: the scene they stand at
// (`sceneOf`). At a scene another line of the story goes on from, as right after going back to a checkpoint, a version
// would hold on that line's later scenes too, so there it is `shared` and not offered, until the reader's next scene.
export function editableFrom(state: Partial<Library>, storyId: string): { scene: string; shared: boolean } | undefined {
  const scene = sceneOf(state, storyId);
  const story = scene && state.stories && Object.hasOwn(state.stories, storyId) ? state.stories[storyId] : undefined;
  if (!scene || !story || !Object.hasOwn(story.nodes ?? {}, scene)) return undefined;
  return { scene, shared: Object.values(story.nodes).some(node => node?.parent === scene) };
}

// How many scenes of the story hold a text the reader wrote «only from this moment» for the person `name`: those an
// edit for the whole story takes the place of (`landEdit`).
export function ownVersions(story: Story, name: string): number {
  return Object.values(story.nodes ?? {}).reduce((sum, node) => sum + Object.entries(node?.appearance ?? {}).filter(([key, version]) =>
    personKey(key) === personKey(name) && (textOf(version?.look) !== undefined || textOf(version?.description) !== undefined)).length, 0);
}

// Where a reader's edit of the person `name` lands (local/bot.ts, and the whole profile's edit to come). Without `from`,
// on the sheet itself, for the whole story, as before: the description, which replaces a look of the reader's and is to
// be retold, or their own look. So that it holds in every scene of every line, it then takes the place of what the
// reader wrote «only from this moment» anywhere in the story (`ownVersions`): a description of every text of theirs
// there, and a look of every look of theirs, and it is written beside a description of theirs, which would otherwise
// have its own retold look stand there. The changes the story made stay where they are and are retold over it. With
// `from`, a scene of the story, in a version at that scene, where it holds and in every scene below it, and nowhere above
// it or on another line. `edit` may carry both texts, the description taken first. Returns whether a retelling is due,
// and how many versions the edit for the whole story changed; undefined when the person or the scene is gone.
export function landEdit(story: Story, name: string, edit: { description?: string; look?: string }, from?: string):
{ retell: boolean; cleared: number } | undefined {
  const sheet = story.sheet ?? [];
  const index = sheet.findIndex(one => one.name === name);
  if (index < 0) return undefined;
  const retell = edit.description !== undefined;
  if (from !== undefined) {
    const node = Object.hasOwn(story.nodes, from) ? story.nodes[from] : undefined;
    if (!node) return undefined;
    const key = keyAt(node.appearance, name);
    const version: SheetVersion = { ...node.appearance?.[key] };
    if (edit.description !== undefined) { version.description = edit.description; delete version.look; }
    if (edit.look !== undefined) version.look = edit.look;
    (node.appearance ??= {})[key] = version;
    return { retell, cleared: 0 };
  }
  let cleared = 0;
  for (const node of Object.values(story.nodes)) {
    for (const [key, version] of Object.entries(node.appearance ?? {})) {
      const { description, look, ...rest } = version;
      if (personKey(key) !== personKey(name) || textOf(description) === undefined && textOf(look) === undefined) continue;
      cleared++;
      const kept: SheetVersion = retell || textOf(description) === undefined ? rest : { ...rest, description, look: edit.look };
      if (listOf(kept.changes).length || kept.description !== undefined) node.appearance![key] = kept;
      else delete node.appearance![key];
    }
    if (node.appearance && !Object.keys(node.appearance).length) delete node.appearance;
  }
  if (edit.description !== undefined) {
    // A description the reader wrote replaces their own look, and details they wrote before 2026-09-27 go (local/bot.ts).
    const { edited, detailsEdited, details, ...person } = sheet[index];
    sheet[index] = { ...person, ...!detailsEdited && details ? { details } : {}, description: edit.description, descriptionEdited: true, lookPending: true };
  }
  if (edit.look !== undefined) sheet[index] = { ...sheet[index], look: edit.look, edited: true };
  return { retell, cleared };
}
