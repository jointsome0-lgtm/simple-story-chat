// The picture styles of a reader (local/picture-style.ts): which line a key stands for, what a reader's own style
// becomes, and what is kept of what they sent. Synthetic styles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Library } from '../lib/library.ts';
import { STYLE } from './illustrate.ts';
import { OWN_NAME_CHARS, OWN_STYLE_CHARS, PRESETS, PRESET_KEYS, choiceOf, lineOf, ownStyle, ownStyleInput, ownStyles,
  presetOf, styleChoice, styleKey, styleLine, styleName } from './picture-style.ts';

const OWNER = 'An owner line of their own.';

test('stored styles are not trusted: entries that are not styles are left out, in the order they were made', () => {
  const stored = { pictureStyles: { y2: { id: 'y2', name: 'Первый', line: 'Ink.' }, x1: { id: 'x1', name: 'Не id', line: 'Ink.' },
    y3: { id: 'y3', name: '  ', line: 'Ink.' }, y4: { id: 'y4', name: 'Пустой', line: '' }, y5: null,
    y6: { id: 'y6', name: 'Второй', line: 'Pencil.' } } } as unknown as Partial<Library>;
  assert.deepEqual(ownStyles(stored).map(style => style.id), ['y2', 'y6']);
  assert.equal(ownStyle(stored, 'x1'), undefined);
  assert.equal(ownStyle(stored, 'y6')!.name, 'Второй');
  assert.deepEqual(ownStyles({ pictureStyles: 'nonsense' } as unknown as Partial<Library>), []);
  // Which style a library asks for: the standard one is the bot's own line, or the preset that line is; a choice the
  // library no longer has, a prototype name or an entry that is not a style is the standard style again.
  const choices: [string, Partial<Library>, string, string, string][] = [
    ['no choice, the bot\'s line a preset', {}, PRESETS.semi, 'semi', PRESETS.semi],
    ['no choice, the bot\'s own line', {}, OWNER, 'standard', OWNER],
    ['a preset', { pictureStyle: 'film' }, OWNER, 'film', PRESETS.film],
    ['a choice the library no longer has', { pictureStyle: 'y4' }, OWNER, 'standard', OWNER],
    ['a prototype name', { pictureStyle: 'toString' }, OWNER, 'standard', OWNER],
    ['a stored entry that is not a style', { ...stored, pictureStyle: 'y3' }, OWNER, 'standard', OWNER],
  ];
  for (const [label, state, standard, key, line] of choices) {
    assert.deepEqual([styleKey(state, standard), styleLine(state, standard)], [key, line], label);
  }
  assert.deepEqual([presetOf(STYLE), presetOf(PRESETS.semi), presetOf(OWNER)], ['novel', 'semi', undefined]);
  // Every preset asks for natural proportions, says nothing of lettering, and fits the limit of an own style.
  for (const key of PRESET_KEYS) {
    assert.match(PRESETS[key], /proportions/, key);
    assert.doesNotMatch(PRESETS[key], /captions|logos|watermarks/, key);
    assert.ok([...PRESETS[key]].length <= OWN_STYLE_CHARS, key);
  }
});

test('a style of the reader\'s own ends the prompt as written, and is logged as custom', () => {
  const state: Partial<Library> = { pictureStyle: 'y3', pictureStyles: {
    y3: { id: 'y3', name: 'Уголь', line: 'Charcoal sketch on rough paper' }, y5: { id: 'y5', name: 'Копия', line: PRESETS.film },
    y6: { id: 'y6', name: 'Со всем', line: 'Ink. All people are adults.' }, y7: { id: 'y7', name: 'Длинный', line: 'z'.repeat(OWN_STYLE_CHARS + 50) },
  } };
  assert.deepEqual([styleKey(state), styleChoice(state), choiceOf('film'), choiceOf('standard')], ['y3', 'custom', 'film', 'standard']);
  // Nothing is added to a reader's line, and one longer than the bot accepts came from elsewhere and is cut.
  const lines: [string, string, string | null][] = [['the chosen one', 'y3', 'Charcoal sketch on rough paper'],
    ['a copy of a preset', 'y5', PRESETS.film], ['a line with a sentence of its own', 'y6', 'Ink. All people are adults.'],
    ['a line over the limit', 'y7', 'z'.repeat(OWN_STYLE_CHARS)], ['no such style', 'y9', null], ['the standard one', 'standard', OWNER]];
  for (const [label, key, line] of lines) assert.equal(lineOf(state, key, OWNER), line, label);
  assert.equal(styleLine(state, OWNER), 'Charcoal sketch on rough paper');
  // What a reader sends: the first of several lines is the name, control characters are spaces, the rest is kept.
  const sent: [string, ReturnType<typeof ownStyleInput>][] = [['Charcoal sketch', { name: null, line: 'Charcoal sketch' }],
    ['Уголь\r\nCharcoal sketch\non rough   paper', { name: 'Уголь', line: 'Charcoal sketch on rough paper' }],
    ['\n\nУголь\n\n  \nCharcoal​ sketch\t\n', { name: 'Уголь', line: 'Charcoal sketch' }], [' \n\t ', null]];
  for (const [text, style] of sent) assert.deepEqual(ownStyleInput(text), style, JSON.stringify(text));
  // A name fits a button: cut at a word near the limit, or at the limit.
  assert.equal(styleName('Oil painting with visible impasto brushstrokes, warm candlelight'), 'Oil painting with visible impasto…');
  assert.equal(styleName('b'.repeat(80)), `${'b'.repeat(OWN_NAME_CHARS - 1)}…`);
  assert.equal([...styleName('🎨'.repeat(60))].length, OWN_NAME_CHARS);
});
