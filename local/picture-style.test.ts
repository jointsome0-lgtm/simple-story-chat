// The picture styles of a reader (local/picture-style.ts): which line a key stands for, what a reader's own style
// becomes, and what is kept of what they sent. Synthetic styles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Library } from '../lib/library.ts';
import { STYLE } from './illustrate.ts';
import { OWN_NAME_CHARS, OWN_STYLE_CHARS, OWN_STYLE_TAIL, PRESETS, PRESET_KEYS, choiceOf, lineOf, ownStyle, ownStyleInput, ownStyles,
  presetOf, styleChoice, styleKey, styleLine, styleName } from './picture-style.ts';

const OWNER = 'An owner line of their own.';

test('the standard style is the bot\'s own line, and the preset it is when it is one', () => {
  assert.equal(presetOf(STYLE), 'novel');
  assert.equal(presetOf(PRESETS.semi), 'semi');
  assert.equal(presetOf(OWNER), undefined);
  assert.equal(styleKey({}, PRESETS.semi), 'semi');
  assert.equal(styleKey({}, OWNER), 'standard');
  assert.equal(styleLine({}, OWNER), OWNER);
  assert.equal(styleLine({ pictureStyle: 'film' }, OWNER), PRESETS.film);
  // A choice the library no longer has is the standard style again.
  assert.equal(styleKey({ pictureStyle: 'y4' }, OWNER), 'standard');
  assert.equal(styleKey({ pictureStyle: 'toString' }, OWNER), 'standard');
  assert.equal(styleLine({ pictureStyle: 'y4' }, OWNER), OWNER);
  // Every preset asks for natural proportions, no longer says anything about lettering, and fits the limit of an
  // own style.
  for (const key of PRESET_KEYS) {
    assert.match(PRESETS[key], /proportions/, key);
    assert.doesNotMatch(PRESETS[key], /captions|logos|watermarks/, key);
    assert.ok([...PRESETS[key]].length <= OWN_STYLE_CHARS, key);
  }
});

test('a style of the reader\'s own ends with the sentences it lacks of the bot\'s, and is logged as custom', () => {
  const state: Partial<Library> = { pictureStyle: 'y3', pictureStyles: {
    y3: { id: 'y3', name: 'Уголь', line: 'Charcoal sketch on rough paper' },
    y5: { id: 'y5', name: 'Копия', line: PRESETS.film },
    y6: { id: 'y6', name: 'Со всем', line: `Ink. ${OWN_STYLE_TAIL}` },
    y7: { id: 'y7', name: 'Длинный', line: 'z'.repeat(OWN_STYLE_CHARS + 50) },
  } };
  assert.equal(styleKey(state), 'y3');
  assert.equal(styleChoice(state), 'custom');
  assert.equal(choiceOf('film'), 'film');
  assert.equal(choiceOf('standard'), 'standard');
  assert.equal(styleLine(state, OWNER), `Charcoal sketch on rough paper. ${OWN_STYLE_TAIL}`);
  // A preset copied into the library keeps its own rules and gets the one sentence it does not say.
  assert.equal(lineOf(state, 'y5', OWNER), `${PRESETS.film} ${OWN_STYLE_TAIL}`);
  assert.equal(lineOf(state, 'y6', OWNER), `Ink. ${OWN_STYLE_TAIL}`);
  // A line longer than the bot accepts came from elsewhere, and is cut to the limit.
  assert.equal(lineOf(state, 'y7', OWNER), `${'z'.repeat(OWN_STYLE_CHARS)}. ${OWN_STYLE_TAIL}`);
  assert.equal(lineOf(state, 'y9', OWNER), null);
  assert.equal(lineOf(state, 'standard', OWNER), OWNER);
});

test('stored styles are not trusted: entries that are not styles are left out, in the order they were made', () => {
  const state = { pictureStyles: {
    y2: { id: 'y2', name: 'Первый', line: 'Ink.' },
    x1: { id: 'x1', name: 'Не id', line: 'Ink.' },
    y3: { id: 'y3', name: '  ', line: 'Ink.' },
    y4: { id: 'y4', name: 'Пустой', line: '' },
    y5: null,
    y6: { id: 'y6', name: 'Второй', line: 'Pencil.' },
  } } as unknown as Partial<Library>;
  assert.deepEqual(ownStyles(state).map(style => style.id), ['y2', 'y6']);
  assert.equal(ownStyle(state, 'x1'), undefined);
  assert.equal(ownStyle(state, 'y6')!.name, 'Второй');
  assert.deepEqual(ownStyles({ pictureStyles: 'nonsense' } as unknown as Partial<Library>), []);
});

test('what a reader sends: the first of several lines is the name, control characters are spaces, the bot\'s own sentences come off', () => {
  assert.deepEqual(ownStyleInput('Charcoal sketch'), { name: null, line: 'Charcoal sketch' });
  assert.deepEqual(ownStyleInput('Уголь\r\nCharcoal sketch\non rough   paper'), { name: 'Уголь', line: 'Charcoal sketch on rough paper' });
  assert.deepEqual(ownStyleInput('Уголь Charcoal sketch'), { name: 'Уголь', line: 'Charcoal sketch' });
  assert.deepEqual(ownStyleInput('\n\nУголь\n\n  \nCharcoal​ sketch\t\n'), { name: 'Уголь', line: 'Charcoal sketch' });
  assert.deepEqual(ownStyleInput(`Ink wash. ${OWN_STYLE_TAIL}`), { name: null, line: 'Ink wash.' });
  // A preset's own sentence is the reader's to keep: only what the bot adds comes off.
  assert.deepEqual(ownStyleInput(`Имя\nInk wash. No captions, logos or watermarks.`), { name: 'Имя', line: 'Ink wash. No captions, logos or watermarks.' });
  assert.equal(ownStyleInput(' \n\t '), null);
  assert.equal(ownStyleInput(`Имя\n${OWN_STYLE_TAIL}`), null);
});

test('a style\'s name fits a button: cut at a word near the limit, or at the limit', () => {
  assert.equal(styleName('Уголь'), 'Уголь');
  assert.equal(styleName('a'.repeat(OWN_NAME_CHARS)), 'a'.repeat(OWN_NAME_CHARS));
  const words = styleName('Oil painting with visible impasto brushstrokes, warm candlelight');
  assert.equal(words, 'Oil painting with visible impasto…');
  assert.ok([...words].length <= OWN_NAME_CHARS);
  assert.equal(styleName('b'.repeat(80)), `${'b'.repeat(OWN_NAME_CHARS - 1)}…`);
  assert.equal([...styleName('🎨'.repeat(60))].length, OWN_NAME_CHARS);
});
