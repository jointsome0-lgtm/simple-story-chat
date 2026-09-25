import test from 'node:test';
import assert from 'node:assert/strict';
import { askJson, assemblePrompt, frameRequest, matchSheet, sheetLooks, sheetOf, sheetRequest, stripAges, stripNames, DESCRIBE_TOKENS, STYLE } from './illustrate.ts';
import type { Assembled, Character, Description, Excerpt } from './illustrate.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';

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
// One frame assembled per row: [label, the frame's own fields, the sheet, what the prompt says, never says and counts].
type Expected = Partial<Pick<Assembled, 'namesStripped' | 'fromSheet' | 'withoutLook'>> & { says?: RegExp[]; never?: RegExp };
function assembles(rows: [string, Partial<Description>, Character[], Expected][]) {
  for (const [label, over, people, expected] of rows) {
    const assembled = assemblePrompt(frame(over), people);
    for (const said of expected.says ?? []) assert.match(assembled.prompt, said, label);
    if (expected.never) assert.doesNotMatch(assembled.prompt, expected.never, label);
    for (const count of ['namesStripped', 'fromSheet', 'withoutLook'] as const) {
      if (expected[count] !== undefined) assert.equal(assembled[count], expected[count], `${label}: ${count}`);
    }
  }
}

test('no name and no age written as a number reaches the image model, and a word that only spells like a name stays', () => {
  const ages: [string, string][] = [['A lean woman, 48-year-old, in grey', 'A lean woman, in grey'], ['A man aged 31, bearded', 'A man, bearded'],
    ['a 30 years old woman in red', 'a woman in red'], ['An elderly judge in black', 'An elderly judge in black']];
  for (const [text, expected] of ages) assert.equal(stripAges(text), expected, text);
  // [text, the names, how many are cut, the text after; left out where only the count is pinned]
  const names: [string, string[], number, string?][] = [
    // A Russian case ending of up to three letters goes with the name; a longer word is a different word.
    ['Элин отступает, Тарека рядом нет', ['Элин', 'Тарек'], 2, 'the figure отступает, the figure рядом нет'], ['Элинарий смотрит', ['Элин'], 0],
    ["Elin's right hand rests on Sava", ['Elin', 'Sava'], 2, "the figure's right hand rests on the figure"], ['nobody is named here', ['Элин'], 0],
    // The sheet spells a name as the story does, in Cyrillic, and the described fields carry it transliterated by whatever
    // system the model picked: every recorded run where a name got through at all got it through in this form.
    ['Elin and Tarek defend a salt-cart barricade.', ['Элин', 'Тарек'], 2, 'the figure and the figure defend a salt-cart barricade.'],
    ["Sava's hands are on the lock", ['Сава'], 1], ['Lidia turns away', ['Лидия'], 1], ['Lidiya turns away', ['Лидия'], 1], ['Lidija turns away', ['Лидия'], 1],
    // The English ending is an ending, not three free letters, and a name transliterates into an ordinary word often
    // enough to matter (Роан is a name in the frozen battle story, "roan" the colour of a horse): in English the name
    // is capitalised and the word is not, while the story's own alphabet stays case-insensitive.
    ['the guard is eliminated', ['Элин'], 0], ['a roan mare stands at the rail', ['Роан'], 0], ['Roan holds the gate open', ['Роан'], 1],
    ['a lantern and a mat lie on the boards', ['Мать'], 0], ['an archway of grey stone', ['Ян'], 0], ['роан стоит у ворот', ['Роан'], 1],
  ];
  for (const [text, list, removed, after] of names) {
    const stripped = stripNames(text, list);
    assert.equal(stripped.removed, removed, text);
    if (after !== undefined || !removed) assert.equal(stripped.text, after ?? text, text);
  }
  assembles([
    ['names the instruction let through', { moment: 'Элин stands at the door while Тарек kneels', objects: 'Тарека сумка lies open',
      people: [{ who: 'the scout', look: 'a young man in grey', state: '', action: 'watches Элин' }] }, sheet, { namesStripped: 4, never: /Элин|Тарек/ }],
    // The sheet is model output too: a name in an appearance line would otherwise reach every frame of that story.
    ['a name in a sheet line', {}, [{ name: 'Элин', look: 'A middle-aged woman, Тарека сестра, in grey' }, sheet[1]], { fromSheet: 1, never: /Тарек/ }],
    // A person of one scene is not on the sheet and is named all the same, in `who` and in the fields that do reach
    // the image model. An empty sheet is the same case for everybody in the frame.
    ['a name the sheet never knew', { moment: 'Мирослав waits at the door', objects: 'Мирославова лампа stands on the step',
      people: [{ who: 'Мирослав', look: 'a stocky young man in a canvas coat', state: '', action: 'waits' }] }, sheet,
    { namesStripped: 2, never: /Мирослав/, says: [/a stocky young man in a canvas coat/] }],
    // A role as the instruction asks for it stays: it is what the picture has instead of a name. And a name in a field
    // of somebody the description does not list at all is the instruction's alone to catch: the net cannot know it.
    ['a role', { moment: 'The salt worker waits at the door', people: [{ who: 'salt worker', look: 'a stocky young man', state: '', action: 'waits' }] },
      sheet, { says: [/salt worker/] }],
    ['a name of nobody listed', { moment: 'Мирослав waits at the door', people: [] }, sheet, { says: [/Мирослав/] }],
    ['the ages of the sheet line and of the model\'s own look', {}, sheet, { never: /\d/ }],
  ]);
});

// Giving a person another person's fixed appearance is worse than giving them none: the frame is then counted as
// correct and their own look is thrown away, so no counter shows anything. Clothes change with the story, so they
// are the frame's: the sheet's outfit is only what a person of the sheet wears when the frame gives them none.
test('a described person takes their own sheet line, the clothes of the frame and their place in the agreed order', () => {
  const [three, alike] = [['Элин', 'Тарек', 'лекарь'], ['Мария', 'Элина', 'Элин']];
  // A role in English is not one of them, and neither is a word that merely starts alike: Марина is not Мария,
  // Элину is the dative of Элин, and Элина is somebody else on the same sheet.
  const matches: [string, string[], string | null][] = [['Элин', three, 'Элин'], ['Элину,', three, 'Элин'], ['Elin', three, 'Элин'], ['Tarek', three, 'Тарек'],
    ['salt worker', three, null], ['the scout', three, null], ['Элеонора', three, null], ['Марина', alike, null], ['Элину', alike, 'Элин'],
    ['Элине', alike, 'Элин'], ['Тарелка', ['Тарек'], null]];
  for (const [who, names, expected] of matches) assert.equal(matchSheet(who, names), expected, who);
  assert.equal(sheetLooks(sheet).get('элин'), 'A middle-aged woman, lean, short ash-grey hair, grey wool coat');
  const dressed: Character[] = [{ name: 'Элин', look: 'A lean woman with short ash-grey hair.', outfit: 'wearing a grey wool coat.' }];
  const leaning = { who: 'Элин', look: '', state: '', action: 'leans her back against the door' };
  assembles([
    // The model's own look for a person the sheet covers contradicts the sheet, so it is not sent.
    ['a person of the sheet', {}, sheet, { fromSheet: 1, says: [/short ash-grey hair/], never: /woman in red/ }],
    ['a name that only shares a stem', { moment: 'A woman at a gate.', shot: 'Medium shot', setting: 'A stone gate', objects: '', props: '', light: 'Morning light',
      people: [{ who: 'Марина', look: 'a young woman in a blue apron, braided dark hair', state: '', action: 'lifts a basket' }] },
    [{ name: 'Мария', look: 'An elderly woman, stooped, white braid, black mourning dress' },
      { name: 'Элина', look: 'A young woman, tall, red hair, green riding coat' }],
    { fromSheet: 0, withoutLook: 0, says: [/a young woman in a blue apron, braided dark hair: lifts a basket\./], never: /mourning dress/ }],
    // A full stop at the end of any part of a person would break the clause in two. A sheet from before `outfit` gives
    // nothing to fall back on, and a stranger's clothes stand after their own look.
    ['the clothes of the frame', { people: [{ ...leaning, clothes: 'wearing a red silk dress.' }] }, dressed,
      { says: [/A lean woman with short ash-grey hair, wearing a red silk dress: leans her back against the door\. /], never: /grey wool coat/ }],
    ['no clothes in the frame', { people: [{ ...leaning, clothes: ' ' }] }, dressed, { says: [/short ash-grey hair, wearing a grey wool coat: leans/] }],
    ['a sheet from before outfit', { people: [leaning] }, [{ name: 'Элин', look: 'A lean woman' }], { says: [/A lean woman: leans/] }],
    ['a stranger\'s clothes', { people: [{ who: 'salt worker', look: 'An old man.', clothes: 'wearing rags', state: 'soaked.', action: 'waits' }] }, dressed,
      { says: [/An old man, wearing rags, soaked: waits\. /] }],
    // A person the sheet does not cover keeps their described look, and an empty field adds nothing.
    ['a person the sheet does not cover', { objects: '', props: '   ', people: [{ who: 'salt worker',
      look: 'a stocky middle-aged man in a canvas apron', state: '', action: 'pours salt into a crate' }] }, sheet,
    { fromSheet: 0, withoutLook: 0, says: [/a stocky middle-aged man in a canvas apron: pours salt into a crate\./], never: /: {2}|, :/ }],
    // The instruction orders an empty `look` for everybody on the sheet, so a `who` the sheet does not recognise costs
    // that person their whole appearance. It must be recognised, and when it cannot be, counted: then the action
    // stands alone rather than behind a bare colon.
    ['an inflected and a transliterated who', { people: [{ who: 'Элину', look: '', state: 'a large steel shield', action: 'presses the shield against a cart' },
      { who: 'Tarek', look: '', state: '', action: 'holds the barricade' }] }, sheet,
    { fromSheet: 2, withoutLook: 0, says: [/short ash-grey hair, grey wool coat, a large steel shield: presses/,
      /black curls, brown leather jerkin: holds the barricade/] }],
    ['nobody found and nothing described', { people: [{ ...leaning, who: 'Мара' }] }, sheet,
      { fromSheet: 0, withoutLook: 1, says: [/door\. leans her back against the door\./], never: /(^|[.\s]):/ }],
  ]);
  const { prompt } = assemblePrompt(frame(), sheet);
  const order = ['Medium wide three-quarter shot', 'A narrow stone passage', 'Two figures stand at a closed side door',
    'leans her back against the door', 'A splint of two boards', 'holds the only dagger', 'Overcast morning light'];
  order.reduce((at, part) => { assert.ok(prompt.indexOf(part) > at, `${part} is out of order`); return prompt.indexOf(part); }, -1);
  assert.ok(prompt.endsWith(STYLE), 'our one style sentence ends the prompt');
  assert.doesNotMatch(prompt, /\.\./);
});

// JSON mode runs away into newlines until the output limit, and the same scene parsed on the next attempt: one
// retry, and only one, and never a word of what came back (local/illustrate.ts).
test('a description is asked for in its schema after the scene, once more when it did not parse, and never quoted', async () => {
  const context: Excerpt = { system: 'система', messages: [{ role: 'user', content: 'Синтетическая сцена.' }] };
  type Schema = { required: string[]; additionalProperties: boolean; properties: Record<string, { maxItems: number; items: Schema }> };
  // Both calls continue the scene's own request, their instruction last, in a schema that asks for every field.
  const requests: [string, ModelRequest, string[], string, number, string[]][] = [
    ['the sheet', sheetRequest(context), ['characters'], 'characters', 6, ['name', 'look', 'outfit']],
    ['the frame', frameRequest(context, sheet), ['moment', 'shot', 'setting', 'objects', 'props', 'light', 'people'], 'people', 4,
      ['who', 'look', 'clothes', 'state', 'action']],
  ];
  for (const [label, request, required, list, most, fields] of requests) {
    const { properties, ...schema } = request.outputSchema as Schema;
    assert.deepEqual([schema.required, schema.additionalProperties], [required, false], label);
    assert.deepEqual([properties[list].maxItems, properties[list].items.required, properties[list].items.additionalProperties], [most, fields, false], label);
    assert.deepEqual([request.system, request.maxOutputTokens, request.messages.slice(0, -1)], [context.system, DESCRIBE_TOKENS, context.messages], label);
  }
  // The frame's instruction names the people of the sheet for `who`, and repeats the clothes they wore before.
  const worn = frameRequest(context, [{ ...sheet[0], outfit: 'wearing a grey wool coat' }, sheet[1]]).messages.at(-1)!.content;
  assert.match(worn, /\[Элин, Тарек\][^]*\n {2}- Элин: wearing a grey wool coat\n/);
  // A reply that parsed without a string name or look would otherwise reach the assembly as undefined.
  assert.deepEqual(sheetOf({ characters: [{ name: 'Элин', look: 'A lean woman' }, { name: 7, look: 'x' }, { name: 'Тарек' }, null] }),
    [{ name: 'Элин', look: 'A lean woman', outfit: '' }]);
  assert.deepEqual(sheetOf({ people: [] }), []);
  // A reader who has moved on while the first answer was arriving gets no second attempt: their next scene needs
  // the slot more than their last one needs a picture. [label, the answers, moved on, attempts, the reply]
  const character = { characters: [{ name: 'Элин', look: 'A middle-aged woman' }] };
  const replies: [string, string[], boolean, number, object | null][] = [
    ['a runaway, then JSON', ['\n\n\n\n', JSON.stringify(character)], false, 2, { value: character, retried: true }],
    ['never JSON', ['PRIVATE_SCENE_TEXT', 'PRIVATE_SCENE_TEXT', 'PRIVATE_SCENE_TEXT'], false, 2, null],
    ['a reader who moved on', ['not json', 'not json'], true, 1, null],
  ];
  for (const [label, answers, movedOn, attempts, expected] of replies) {
    const stop = new AbortController();
    let asked = 0;
    const model: Provider = { generate: async () => { if (movedOn) stop.abort(); return { text: answers[asked++] ?? '', finishReason: 'stop' } as GenerationResult; } };
    const reply = askJson(model, sheetRequest(context), movedOn ? { signal: stop.signal } : undefined);
    if (expected) assert.deepEqual(await reply, expected, label);
    else await assert.rejects(reply, (error: Error & { code?: string }) =>
      error.code === 'unparsed_description' && !/PRIVATE/.test(`${error.message} ${JSON.stringify(error)}`), label);
    assert.equal(asked, attempts, `${label}: the attempts`);
  }
});
