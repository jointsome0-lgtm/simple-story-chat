import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblePrompt, matchSheet, sheetLooks, stripAges, stripNames, STYLE } from './illustrate-probe.ts';
import type { Character, Description } from './illustrate-probe.ts';

// A synthetic sheet and frame in the shape the describing model fills. No reader's story is involved.
const sheet: Character[] = [
  { name: 'Элин', look: 'A middle-aged woman, 48-year-old, lean, short ash-grey hair, grey wool coat.' },
  { name: 'Тарек', look: 'A young man, broad shouldered, black curls, brown leather jerkin' },
];
const frame = (over: Partial<Description> = {}): Description => ({
  moment: 'Two figures stand at a closed side door.', shot: 'Medium wide three-quarter shot',
  setting: 'A narrow stone passage, the door closed', objects: 'A splint of two boards', props: 'The grey-clad woman holds the only dagger in her right hand',
  light: 'Overcast morning light',
  people: [{ who: 'Элин', look: 'a 30 years old woman in red', state: 'her bandaged left forearm folded against her chest', action: 'leans her back against the door' }],
  ...over,
});

test('an age written as a number is taken out wherever it stands', () => {
  assert.equal(stripAges('A lean woman, 48-year-old, in grey'), 'A lean woman, in grey');
  assert.equal(stripAges('A man aged 31, bearded'), 'A man, bearded');
  assert.equal(stripAges('a 30 years old woman in red'), 'a woman in red');
  assert.equal(stripAges('An elderly judge in black'), 'An elderly judge in black');
});

test('a name is cut with its Russian case ending, and a word that only starts like one is kept', () => {
  assert.deepEqual(stripNames('Элин отступает, Тарека рядом нет', ['Элин', 'Тарек']), { text: 'the figure отступает, the figure рядом нет', removed: 2 });
  assert.deepEqual(stripNames("Elin's right hand rests on Sava", ['Elin', 'Sava']), { text: "the figure's right hand rests on the figure", removed: 2 });
  // Up to three letters of an ending are taken; a longer word is a different word.
  assert.deepEqual(stripNames('Элинарий смотрит', ['Элин']), { text: 'Элинарий смотрит', removed: 0 });
  assert.deepEqual(stripNames('nobody is named here', ['Элин']), { text: 'nobody is named here', removed: 0 });
});

// The sheet spells a name as the story does, in Cyrillic; the described fields are English and carry the same name
// transliterated. Every recorded run where a name got through at all got it through in this form.
test('a name the describing model transliterated is cut as well, whichever system it used', () => {
  assert.deepEqual(stripNames('Elin and Tarek defend a salt-cart barricade.', ['Элин', 'Тарек']),
    { text: 'the figure and the figure defend a salt-cart barricade.', removed: 2 });
  assert.equal(stripNames("Sava's hands are on the lock", ['Сава']).removed, 1);
  // Лидия comes back as Lidia, Lidiya or Lidija, depending on what the model felt like.
  for (const spelling of ['Lidia', 'Lidiya', 'Lidija']) assert.equal(stripNames(`${spelling} turns away`, ['Лидия']).removed, 1, spelling);
  // The English ending is an ending, not three free letters: a word that starts like a name is still a word.
  assert.deepEqual(stripNames('the guard is eliminated', ['Элин']), { text: 'the guard is eliminated', removed: 0 });
});

test('a described person is found on the sheet however the model wrote their name', () => {
  const names = ['Элин', 'Тарек', 'лекарь'];
  assert.equal(matchSheet('Элин', names), 'Элин');
  assert.equal(matchSheet('Элину,', names), 'Элин');
  assert.equal(matchSheet('Elin', names), 'Элин');
  assert.equal(matchSheet('Tarek', names), 'Тарек');
  // A role in English is not one of them, and neither is a word that merely starts alike.
  assert.equal(matchSheet('salt worker', names), null);
  assert.equal(matchSheet('the scout', names), null);
  assert.equal(matchSheet('Элеонора', names), null);
});

test('the sheet line is the only look of a person the sheet covers, and its age is a word', () => {
  assert.equal(sheetLooks(sheet).get('элин'), 'A middle-aged woman, lean, short ash-grey hair, grey wool coat');
  const { prompt, fromSheet } = assemblePrompt(frame(), sheet);
  assert.equal(fromSheet, 1);
  assert.match(prompt, /short ash-grey hair/);
  // The model's own look for that person contradicts the sheet, so it is not sent.
  assert.doesNotMatch(prompt, /woman in red/);
  assert.doesNotMatch(prompt, /\d/);
});

test('the assembled prompt keeps the agreed order and ends with our one style sentence', () => {
  const { prompt } = assemblePrompt(frame(), sheet);
  const order = ['Medium wide three-quarter shot', 'A narrow stone passage', 'Two figures stand at a closed side door',
    'leans her back against the door', 'A splint of two boards', 'holds the only dagger', 'Overcast morning light'];
  let at = -1;
  for (const part of order) {
    const found = prompt.indexOf(part);
    assert.ok(found > at, `${part} is out of order`);
    at = found;
  }
  assert.ok(prompt.endsWith(STYLE));
  assert.doesNotMatch(prompt, /\.\./);
});

test('a name that gets through the instruction never reaches the image model', () => {
  const { prompt, namesStripped } = assemblePrompt(frame({
    moment: 'Элин stands at the door while Тарек kneels', objects: 'Тарека сумка lies open',
    people: [{ who: 'the scout', look: 'a young man in grey', state: '', action: 'watches Элин' }],
  }), sheet);
  assert.equal(namesStripped, 4);
  assert.doesNotMatch(prompt, /Элин|Тарек/);
  // The sheet is model output too: a name in an appearance line would otherwise reach every frame of that story.
  const named = assemblePrompt(frame(), [{ name: 'Элин', look: 'A middle-aged woman, Тарека сестра, in grey' }, sheet[1]]);
  assert.equal(named.fromSheet, 1);
  assert.doesNotMatch(named.prompt, /Тарек/);
});

test('a person the sheet does not cover keeps their described look, and an empty field adds nothing', () => {
  const { prompt, fromSheet, withoutLook } = assemblePrompt(frame({ objects: '', props: '   ',
    people: [{ who: 'salt worker', look: 'a stocky middle-aged man in a canvas apron', state: '', action: 'pours salt into a crate' }] }), sheet);
  assert.equal(fromSheet, 0);
  assert.equal(withoutLook, 0);
  assert.match(prompt, /a stocky middle-aged man in a canvas apron: pours salt into a crate\./);
  assert.doesNotMatch(prompt, /: {2}|, :/);
});

// The instruction orders an empty `look` for everybody on the sheet, so a `who` the sheet does not recognise costs
// that person their whole appearance. It must be recognised, and when it cannot be, counted.
test('an inflected or transliterated who still takes its look from the sheet, and a person with none is counted', () => {
  const people = [{ who: 'Элину', look: '', state: 'a large steel shield', action: 'presses the shield against a cart' },
    { who: 'Tarek', look: '', state: '', action: 'holds the barricade' }];
  const { prompt, fromSheet, withoutLook } = assemblePrompt(frame({ people }), sheet);
  assert.equal(fromSheet, 2);
  assert.equal(withoutLook, 0);
  assert.match(prompt, /short ash-grey hair, grey wool coat, a large steel shield: presses/);
  assert.match(prompt, /black curls, brown leather jerkin: holds the barricade/);

  // Nobody found and nothing described: the action stands alone rather than behind a bare colon.
  const lost = assemblePrompt(frame({ people: [{ who: 'Мара', look: '', state: '', action: 'leans her back against the door' }] }), sheet);
  assert.equal(lost.withoutLook, 1);
  assert.equal(lost.fromSheet, 0);
  assert.match(lost.prompt, /door\. leans her back against the door\./);
  assert.doesNotMatch(lost.prompt, /(^|[.\s]):/);
});
