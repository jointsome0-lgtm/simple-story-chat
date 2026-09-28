// A profile sent back is written over the person's fields as it reads (local/profile.ts). A reading that dropped a field,
// cut one short, moved text into the next one or took a part of a message Telegram split would lose what the reader
// wrote with nobody noticing: one check for that risk (local/AGENTS.md), and its own file, since no other file reads a
// profile. Each row is a text sent back and what it reads as, in every language of the bot.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Story } from '../lib/library.ts';
import { PROFILE_FIELDS, parseProfile, profileBlock, profileOf } from './profile.ts';
import { REGISTERED, texts } from './text.ts';

const PERSON = { name: 'Mira  Vale', description: 'A tall woman in her forties.\n\n| Height | 180 cm |\n| Eyes | grey |', descriptionEdited: true,
  changes: 'A scar on the left cheek.', details: 'A tall woman in her forties, short grey hair, a thin scar on the left cheek.',
  look: 'A tall woman, short grey hair, a scar on the left cheek.', outfit: 'a dark wool coat', portraitPrompt: 'Portrait of a tall woman.\n  Grey #2 light.' };

test('a profile reads back as it was shown, edited as it was written, and a part of one or a changed frame of it not at all', () => {
  const story = { id: 'h1', seedId: 's1', title: 'Lighthouse', branches: {}, checkpoints: {}, nodes: {}, memories: {}, sheet: [PERSON] } as unknown as Story;
  const profile = profileOf({}, story, PERSON);
  const shown = profile.values;
  for (const lang of REGISTERED) {
    const headings = texts(lang).characters.profileHeadings;
    const block = profileBlock(PERSON.name, profile, PROFILE_FIELDS, lang);
    const edited = block.replace(shown.clothes, 'a yellow raincoat').replace('| Eyes | grey |', '| Eyes | grey |\n\n\n| Hair | short |   ')
      .replace(`## ${headings.changes}\n${shown.changes}`, `## ${headings.changes}`);
    const half = Math.floor(block.length / 2);
    // [what, the text sent back, what it reads as]
    const rows: [string, string, ReturnType<typeof parseProfile>][] = [
      ['as it was shown', block, { values: shown }],
      ['from another client', block.replace(/\n/g, '\r\n').replace(`# ${headings.end}`, `#   ${headings.end.toUpperCase()}:  \n\n`), { values: shown }],
      ['edited: new clothes, a line more in the description, the changes emptied', edited,
        { values: { ...shown, clothes: 'a yellow raincoat', changes: '', description: `${shown.description}\n\n| Hair | short |` } }],
      ['the first part of a message Telegram split', block.slice(0, half), { refusal: 'incomplete' }],
      ['the part after it', block.slice(half), { refusal: 'incomplete' }],
      ['from its second field on', block.slice(block.indexOf(`## ${headings.changes}`)), { refusal: 'incomplete' }],
      ['under another name', block.replace('# Mira Vale', '# Mira Vole'), { refusal: 'name' }],
      ['with a line of its own made a heading', block.replace('| Eyes | grey |', '## Eyes'), { refusal: 'heading', heading: '## Eyes' }],
      ['with a field missing', block.replace(`## ${headings.look}\n${shown.look}`, ''), { refusal: 'sections' }],
      ['with a field twice', block.replace(`## ${headings.look}`, `## ${headings.clothes}\nx\n\n## ${headings.look}`), { refusal: 'sections' }],
      ['with text above its first field', block.replace(`\n\n## ${headings.description}`, `\nhello\n\n## ${headings.description}`), { refusal: 'outside' }],
    ];
    for (const [label, text, want] of rows) assert.deepEqual(parseProfile(text, PERSON.name, PROFILE_FIELDS), want, `${lang}: ${label}`);
    // A message that showed fewer fields reads those alone, and one of the others in it is refused.
    const fewer = PROFILE_FIELDS.filter(field => field !== 'description' && field !== 'prompt');
    assert.deepEqual(parseProfile(profileBlock(PERSON.name, profile, fewer, lang), PERSON.name, fewer),
      { values: Object.fromEntries(fewer.map(field => [field, shown[field]])) }, `${lang}: fewer fields`);
    assert.deepEqual(parseProfile(block, PERSON.name, fewer), { refusal: 'sections' }, `${lang}: more fields than shown`);
  }
});
