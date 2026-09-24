import test from 'node:test';
import assert from 'node:assert/strict';
import { scenesWanted } from './illustrate-probe.ts';
import { askJson, assemblePrompt, matchSheet, sheetLooks, sheetRequest, stripAges, stripNames, STYLE } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { GenerationResult, Provider } from './model.ts';

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

// A name transliterates into an ordinary English word often enough to matter: Роан is a name in the frozen battle
// story and "roan" is the colour of a horse. In English the name is capitalised and the word is not.
test('an ordinary English word that spells like a transliterated name is left alone', () => {
  assert.deepEqual(stripNames('a roan mare stands at the rail', ['Роан']), { text: 'a roan mare stands at the rail', removed: 0 });
  assert.equal(stripNames('Roan holds the gate open', ['Роан']).removed, 1);
  assert.deepEqual(stripNames('a lantern and a mat lie on the boards', ['Мать']), { text: 'a lantern and a mat lie on the boards', removed: 0 });
  assert.equal(stripNames('an archway of grey stone', ['Ян']).removed, 0);
  // The story's own alphabet stays case-insensitive: a Russian sentence may start with a name in any case.
  assert.equal(stripNames('роан стоит у ворот', ['Роан']).removed, 1);
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

// Giving a person another person's fixed appearance is worse than giving them none: the frame is then counted as
// correct and their own look is thrown away, so no counter shows anything.
test('a name that only shares a stem with a sheet name is not that person', () => {
  const names = ['Мария', 'Элина', 'Элин'];
  // Марина is not Мария, however alike they start.
  assert.equal(matchSheet('Марина', names), null);
  // Элину is the dative of Элин, and Элина is somebody else on the same sheet.
  assert.equal(matchSheet('Элину', names), 'Элин');
  assert.equal(matchSheet('Элине', names), 'Элин');
  assert.equal(matchSheet('Тарелка', ['Тарек']), null);
  const sheetOfThree: Character[] = [{ name: 'Мария', look: 'An elderly woman, stooped, white braid, black mourning dress' },
    { name: 'Элина', look: 'A young woman, tall, red hair, green riding coat' }];
  const lifted = assemblePrompt({ moment: 'A woman at a gate.', shot: 'Medium shot', setting: 'A stone gate', objects: '',
    props: '', light: 'Morning light', people: [{ who: 'Марина', look: 'a young woman in a blue apron, braided dark hair',
      state: '', action: 'lifts a basket' }] }, sheetOfThree);
  assert.equal(lifted.fromSheet, 0);
  assert.equal(lifted.withoutLook, 0);
  assert.match(lifted.prompt, /a young woman in a blue apron, braided dark hair: lifts a basket\./);
  assert.doesNotMatch(lifted.prompt, /mourning dress/);
});

// `--scenes battle-2,battle-2` paid for the frame twice and wrote prompts.json with one id in it twice, which the
// drawing step then refused as a whole run, naming a cause that was not the one.
test('a scene named twice on the command line is described once', () => {
  assert.deepEqual(scenesWanted('battle-2,battle-2, dance-12').map(scene => scene.id), ['battle-2', 'dance-12']);
  assert.deepEqual(scenesWanted('battle-2'), [{ id: 'battle-2', scenario: 'battle', index: 2 }]);
  // The default is every other scene of all three frozen stories.
  assert.equal(scenesWanted(undefined).length, 24);
  assert.equal(new Set(scenesWanted(undefined).map(scene => scene.id)).size, 24);
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

// Clothes change with the story, so they are the frame's: the sheet's outfit is only what a person of the sheet wears
// when the frame gives them none. A full stop at the end of any part of a person would break the clause in two.
test('a person wears the clothes of the frame, and the sheet\'s outfit only when the frame gives none', () => {
  const dressed: Character[] = [{ name: 'Элин', look: 'A lean woman with short ash-grey hair.', outfit: 'wearing a grey wool coat.' }];
  const person = { who: 'Элин', look: '', state: '', action: 'leans her back against the door' };
  const changed = assemblePrompt(frame({ people: [{ ...person, clothes: 'wearing a red silk dress.' }] }), dressed).prompt;
  assert.match(changed, /A lean woman with short ash-grey hair, wearing a red silk dress: leans her back against the door\. /);
  assert.doesNotMatch(changed, /grey wool coat/);
  const left = assemblePrompt(frame({ people: [{ ...person, clothes: ' ' }] }), dressed).prompt;
  assert.match(left, /short ash-grey hair, wearing a grey wool coat: leans/);
  // A sheet from before `outfit` gives nothing to fall back on, and a stranger's clothes stand after their own look.
  assert.match(assemblePrompt(frame({ people: [person] }), [{ name: 'Элин', look: 'A lean woman' }]).prompt, /A lean woman: leans/);
  const stranger = assemblePrompt(frame({ people: [{ who: 'salt worker', look: 'An old man.', clothes: 'wearing rags', state: 'soaked.', action: 'waits' }] }), dressed);
  assert.match(stranger.prompt, /An old man, wearing rags, soaked: waits\. /);
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

// A person of one scene is not on the sheet and is named all the same: `who` carries their name, and the fields
// that do reach the image model carry it too. An empty sheet is the same case for everybody in the frame.
test('a name the sheet never knew is cut as well, when the description writes it as a name', () => {
  const stranger = assemblePrompt(frame({
    moment: 'Мирослав waits at the door', objects: 'Мирославова лампа stands on the step',
    people: [{ who: 'Мирослав', look: 'a stocky young man in a canvas coat', state: '', action: 'waits' }],
  }), sheet);
  assert.doesNotMatch(stranger.prompt, /Мирослав/);
  assert.equal(stranger.namesStripped, 2);
  assert.match(stranger.prompt, /a stocky young man in a canvas coat/, 'the person is still described');
  // A role as the instruction asks for it stays: it is what the picture has instead of a name.
  const role = assemblePrompt(frame({ moment: 'The salt worker waits at the door',
    people: [{ who: 'salt worker', look: 'a stocky young man', state: '', action: 'waits' }] }), sheet);
  assert.match(role.prompt, /salt worker/);
  // And what the net cannot know: a name in a field of somebody the description does not list at all. The
  // instruction forbids it in every field, and here that is the only guard there is.
  const unlisted = assemblePrompt(frame({ moment: 'Мирослав waits at the door', people: [] }), sheet);
  assert.match(unlisted.prompt, /Мирослав/);
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

// JSON mode runs away into newlines until the output limit, and the same scene parsed on the next attempt: one
// retry, and only one, and never a word of what came back (local/illustrate.ts).
test('a description that did not parse is asked for once more, and never quoted', async () => {
  const context = { system: 'система', messages: [] };
  const answers = ['\n\n\n\n', JSON.stringify({ characters: [{ name: 'Элин', look: 'A middle-aged woman' }] })];
  let asked = 0;
  const twice: Provider = { generate: async () => ({ text: answers[asked++] ?? '', finishReason: 'stop' }) as GenerationResult };
  const { value, retried } = await askJson(twice, sheetRequest(context));
  assert.equal(asked, 2);
  assert.equal(retried, true);
  assert.deepEqual(value, { characters: [{ name: 'Элин', look: 'A middle-aged woman' }] });

  let always = 0;
  const never: Provider = { generate: async () => { always++; return { text: 'PRIVATE_SCENE_TEXT', finishReason: 'stop' } as GenerationResult; } };
  await assert.rejects(askJson(never, sheetRequest(context)), (error: Error & { code?: string }) =>
    error.code === 'unparsed_description' && !/PRIVATE/.test(JSON.stringify(error)));
  assert.equal(always, 2, 'two attempts, not more');

  // A reader who has moved on while the first answer was arriving gets no second attempt: their next scene needs
  // the slot more than their last one needs a picture.
  const stop = new AbortController();
  let cancelled = 0;
  const late: Provider = { generate: async () => { cancelled++; stop.abort(); return { text: 'not json', finishReason: 'stop' } as GenerationResult; } };
  await assert.rejects(askJson(late, sheetRequest(context), { signal: stop.signal }),
    (error: Error & { code?: string }) => error.code === 'unparsed_description');
  assert.equal(cancelled, 1);
});
