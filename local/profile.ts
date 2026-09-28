// The whole profile of one person of a story's sheet as one message, to copy, edit and send back (the owner,
// 2026-09-28: «почему при нажатии персонажа нельзя добавить текущий профиль в сообщение маркдаун…»;
// docs/telegram-ui.md#profile). The block is plain text in a simple Markdown shape: the person's name as its first
// line, a heading for each field, and an end line last, so that a paste Telegram split into two messages is refused
// and never half taken. It is read back by its headings in any of the bot's languages. A field is written only where
// the text sent differs from the person's, and only while what the message showed is still what the person has: its
// button and the wait carry a hash of it (`profileHash`), never the text.
import { createHash } from 'node:crypto';
import type { Library, Story } from '../lib/library.ts';
import { olderSheet } from './illustrate.ts';
import { DESCRIPTION_CHARS, LOOK_CHARS, descriptionOf, ownDescription, ownPortraitPrompt, wornAt } from './picture.ts';
import { PROMPT_CHARS } from './picture-style.ts';
import { sheetAt, versionsOf } from './picture-versions.ts';
import { REGISTERED, texts } from './text.ts';

type SheetEntry = NonNullable<Story['sheet']>[number];

// In the order the profile shows them. The prompt is the one the reader wrote for the person's portraits, and only a
// person who has one has it.
export const PROFILE_FIELDS = ['description', 'changes', 'details', 'look', 'clothes', 'prompt'] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];
// The fields that keep their lines, as a description written on the card does; the others are one line each, as a look
// written there is.
const MULTILINE: readonly ProfileField[] = ['description', 'prompt'];
// The fields a profile may empty: a story that made no lasting change has none, and a person without a prompt of the
// reader's own has their portraits drawn from the bot's again. Any other emptied is refused.
export const MAY_BE_EMPTY: readonly ProfileField[] = ['changes', 'prompt'];
// The longest text a profile may write into each field, in characters. The description, the look and the prompt have
// the limits of their own waits. The other three had no wait: the details are the English prose a portrait is drawn
// from, which the retelling asks 200 words at most of (local/illustrate.ts); the clothes are repeated word for word by
// every frame of the people in it, whose answer holds 900 tokens (`DESCRIBE_TOKENS`), and the sheet asks 8 to 20 words
// of them; the changes are one line, which the sheet asks a few words of.
export const DETAILS_CHARS = 1500;
export const CHANGES_CHARS = 300;
export const CLOTHES_CHARS = 300;
export const PROFILE_CHARS: Record<ProfileField, number> = { description: DESCRIPTION_CHARS, changes: CHANGES_CHARS, details: DETAILS_CHARS,
  look: LOOK_CHARS, clothes: CLOTHES_CHARS, prompt: PROMPT_CHARS };

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
// A field's text as the profile shows it and as a profile sent back is compared and written: a description or a prompt
// with the spaces at the ends of its lines and the blank lines past one cut, as the card's wait for a description
// cuts them; anything else on one line.
export const profileText = (field: ProfileField, text: string) => MULTILINE.includes(field)
  ? text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  : oneLine(text);

// What a person's profile shows: each field as the card shows it, and the fields the person has. The clothes are the
// card's, those of the nearest picture up the branch being played, or the sheet's own (`wornAt`), and new ones go to
// the scene at that branch's head (`clothesAt`), from which the next pictures of the branch start until a scene changes
// them; for a story not being played, or a branch with no scene yet, they are the sheet's own, which the story's
// pictures start from where no scene dressed the person. A sheet older than the three layers (`older`) is written
// anew by the story's next picture, which would drop the changes, the details and the clothes written into it, so its
// profile is only shown. So is the profile of a person whose look changed along the line of that head
// (`versioned`, local/picture-versions.ts): it shows them as the card does at that scene, while a profile sent back
// writes the sheet, for the whole story; the card's own edits offer «only from this moment» instead.
export type Profile = { values: Record<ProfileField, string>; present: ProfileField[]; clothesAt: string | null; older: boolean; versioned: boolean };
export function profileOf(state: Partial<Library>, story: Story, entry: SheetEntry): Profile {
  const where = state.active?.storyId === story.id ? state.active : null;
  const branch = where && Object.hasOwn(story.branches ?? {}, where.branchId) ? story.branches[where.branchId] : undefined;
  const clothesAt = branch?.head && Object.hasOwn(story.nodes ?? {}, branch.head) ? branch.head : null;
  const versioned = clothesAt !== null && versionsOf(story, clothesAt, entry.name) > 0;
  const person = versioned ? sheetAt(story, clothesAt).find(one => one?.name === entry.name) ?? entry : entry;
  const worn = clothesAt === null ? '' : wornAt(story, clothesAt, [{ ...person, outfit: '' }])[0].outfit ?? '';
  const prompt = ownPortraitPrompt(person);
  // Details a reader wrote before 2026-09-27 stood for their description, which shows them, and no portrait read them.
  const values: Record<ProfileField, string> = {
    description: profileText('description', descriptionOf(person)), changes: profileText('changes', person.changes ?? ''),
    details: profileText('details', person.detailsEdited ? '' : person.details ?? ''), look: profileText('look', person.look),
    clothes: profileText('clothes', worn || (typeof person.outfit === 'string' ? person.outfit : '')), prompt: profileText('prompt', prompt ?? ''),
  };
  return { values, present: PROFILE_FIELDS.filter(field => field !== 'prompt' || prompt !== undefined), clothesAt,
    older: olderSheet(story.sheet ?? []), versioned };
}

// The fields a message showed, as its button and the wait name them: a mask in hexadecimal, a bit for each field in
// the order of PROFILE_FIELDS. `maskFields` takes nothing but a mask of one field or more.
export const fieldsMask = (fields: readonly ProfileField[]) =>
  PROFILE_FIELDS.reduce((mask, field, bit) => fields.includes(field) ? mask | 1 << bit : mask, 0).toString(16);
export function maskFields(mask: string | undefined): ProfileField[] | undefined {
  if (!/^[0-9a-f]{1,2}$/.test(mask ?? '')) return undefined;
  const value = parseInt(mask!, 16);
  return value > 0 && value < 1 << PROFILE_FIELDS.length ? PROFILE_FIELDS.filter((_, bit) => value & 1 << bit) : undefined;
}
// What a message showed, which a profile sent back from it must still find: the person, where new clothes would go,
// and the text of each field it had.
export const profileHash = (name: string, profile: Profile, fields: readonly ProfileField[]) =>
  createHash('sha256').update(JSON.stringify([name, profile.clothesAt, fields.map(field => [field, profile.values[field]])])).digest('hex').slice(0, 8);

// The block itself, in the reader's language: `# name`, then `## heading` and the text of each field, a field left
// empty with its heading alone, then the end line.
export function profileBlock(name: string, profile: Profile, fields: readonly ProfileField[], lang: unknown): string {
  const headings = texts(lang).characters.profileHeadings;
  return [`# ${oneLine(name)}`, ...fields.map(field => [`## ${headings[field]}`, ...profile.values[field] ? [profile.values[field]] : []].join('\n')),
    `# ${headings.end}`].join('\n\n');
}

// A heading line: one to six #, then its text after a space, as in Markdown. A line of # alone is one too, with no text.
const HEADING = /^#{1,6}(?:\s+(.*))?$/;
const headingKey = (text: string | undefined) => oneLine(text ?? '').toLowerCase().replace(/\s*[:：]$/, '');
// Every language's headings, so that a profile copied before the reader changed the language still reads.
let headings: Map<string, ProfileField | 'end'> | undefined;
function headingOf(text: string | undefined) {
  if (!headings) {
    headings = new Map();
    for (const lang of REGISTERED) for (const [field, heading] of Object.entries(texts(lang).characters.profileHeadings)) {
      headings.set(headingKey(heading), field as ProfileField | 'end');
    }
  }
  return headings.get(headingKey(text));
}

// Why a text sent back is not a profile: no line with the name, or no end line after it, as in either part of a
// message Telegram split; a heading outside the two, as of a second profile in the same message; the name is not the
// person's; a heading no language of the bot has; a field twice, missing, or one the message did not show; text
// between the name and the first field.
export type ProfileRefusal = 'incomplete' | 'name' | 'heading' | 'sections' | 'outside';
export type ParsedProfile = { values: Partial<Record<ProfileField, string>>; refusal?: undefined; heading?: undefined }
  | { refusal: ProfileRefusal; heading?: string; values?: undefined };
// Reads a profile sent back as the fields `fields` of the person `name`, or says why it cannot: all of them, each once,
// or nothing. The profile runs from its first heading that is no field's, the line with the name, to the first end
// line after it. The lines around the two are left out, as the title above the block and the hint under it are when
// the reader copies the whole message, but a heading among them belongs to another profile, or to a part of one, and
// is refused. A line inside a field that looks like a heading is not taken as text, and a profile whose own text has
// such a line is never offered for editing (local/ui.ts), since it could not come back as it went.
export function parseProfile(text: string, name: string, fields: readonly ProfileField[]): ParsedProfile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headingLines = lines.map(line => HEADING.exec(line.trim()));
  // What each line is: a field's heading, the end line, any other heading (the name's, or one the bot does not know),
  // or text.
  const kinds = headingLines.map(heading => heading ? headingOf(heading[1]) ?? 'other' : 'text');
  const first = kinds.indexOf('other'), last = first < 0 ? -1 : kinds.indexOf('end', first + 1);
  if (last < 0) return { refusal: 'incomplete' };
  if (kinds.some((kind, at) => kind !== 'text' && (at < first || at > last))) return { refusal: 'sections' };
  if (oneLine(headingLines[first]?.[1] ?? '').toLowerCase() !== oneLine(name).toLowerCase()) return { refusal: 'name' };
  const sections = new Map<ProfileField, string[]>();
  let open: string[] | undefined;
  for (let at = first + 1; at < last; at++) {
    const kind = kinds[at];
    if (kind === 'text') {
      if (open) open.push(lines[at]);
      else if (lines[at].trim()) return { refusal: 'outside' };
    } else if (kind === 'other' || kind === 'end') return { refusal: 'heading', heading: [...oneLine(lines[at])].slice(0, 80).join('') };
    else if (!fields.includes(kind) || sections.has(kind)) return { refusal: 'sections' };
    else sections.set(kind, open = []);
  }
  if (fields.some(field => !sections.has(field))) return { refusal: 'sections' };
  return { values: Object.fromEntries([...sections].map(([field, body]) => [field, profileText(field, body.join('\n'))])) };
}

// The fields a profile sent back changes: those whose text differs from what the person has by more than its spaces,
// its line breaks and its Unicode normalization, which a client may change on the way (non-breaking spaces, blank lines
// joined, a table's spaces turned into tabs). A field that differs by those alone is left as the person has it, where
// writing it would have made it the reader's own and retold the person over a look the reader wrote. A changed field is
// written as it came.
const compared = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
export function changedFields(profile: Profile, values: Partial<Record<ProfileField, string>>, fields: readonly ProfileField[]) {
  const changed: Partial<Record<ProfileField, string>> = {};
  for (const field of fields) {
    const value = values[field];
    if (value !== undefined && compared(value) !== compared(profile.values[field])) changed[field] = value;
  }
  return changed;
}

// Whether the block of these fields reads back as exactly what it shows.
export function roundTrips(block: string, name: string, profile: Profile, fields: readonly ProfileField[]) {
  const parsed = parseProfile(block, name, fields);
  return !parsed.refusal && fields.every(field => parsed.values[field] === profile.values[field]);
}

// Writes the fields a profile sent back changed, each already within its limit, onto the person at `index` of the
// story's sheet, the way the card's own waits write a description and a look (local/bot.ts). Returns whether the person
// is to be retold, which happens where the card would retell them: a new description, or new changes, with no new
// details beside it. New details are the reader's, and nothing retells over them: a retelling still to come for the
// person is dropped, and a new description beside them is not retold. A new look is the reader's (`edited`), which a
// retelling keeps, whether it is one this write asks for or one still to come. A description retold without a new look
// replaces a look the reader wrote before, as on the card. New clothes go where the profile said (`clothesAt`), and an
// emptied prompt drops the reader's own.
export function applyProfile(story: Story, index: number, profile: Profile, changed: Partial<Record<ProfileField, string>>): boolean {
  const one = story.sheet![index];
  const has = (field: ProfileField) => changed[field] !== undefined;
  const retell = (has('description') || has('changes')) && !has('details') && !!(changed.description ?? profile.values.description);
  if (has('description')) {
    // Details the reader wrote before 2026-09-27 were the description that this one replaces.
    if (one.detailsEdited) { delete one.details; delete one.detailsEdited; }
    Object.assign(one, { description: changed.description, descriptionEdited: true });
  }
  if (has('changes')) one.changes = changed.changes;
  if (retell) {
    if (!has('look')) delete one.edited;
    one.lookPending = true;
  }
  if (has('look')) Object.assign(one, { look: changed.look, edited: true });
  if (has('details')) {
    // Such details stand for the person's description until then, and stay it.
    if (one.description === undefined && descriptionOf(one).trim()) {
      Object.assign(one, { description: descriptionOf(one) }, ownDescription(one) ? { descriptionEdited: true } : {});
    }
    one.details = changed.details;
    delete one.detailsEdited;
    delete one.lookPending;
  }
  if (has('clothes')) {
    const node = profile.clothesAt === null ? undefined : story.nodes[profile.clothesAt];
    if (node) node.clothes = { ...node.clothes, [one.name]: changed.clothes! };
    else one.outfit = changed.clothes;
  }
  if (changed.prompt) one.portraitPrompt = changed.prompt;
  else if (has('prompt')) delete one.portraitPrompt;
  return retell;
}
