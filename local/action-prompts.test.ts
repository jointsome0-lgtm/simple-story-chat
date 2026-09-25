import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE, assemblePrompt } from './illustrate.ts';
import type { Description } from './illustrate.ts';
import { PORTRAIT_STYLE } from './image-portraits.ts';
import { FACING_WORDS, T_OPENING, planManifest, planStory, tPrompt, variantPrompt, viewPrompt } from './action-prompts.ts';
import { textStories } from './action-text.ts';
import type { StoryText, VariantFrame } from './action-text.ts';

const rows = (list: [string, () => void][]) => {
  for (const [promise, check] of list) {
    try { check(); } catch (error) { assert.fail(`${promise}: ${(error as Error).message}`); }
  }
};
const sheet = [{ name: 'Бранд', look: 'A tall broad man with a black beard', outfit: 'wearing a grey cloak' },
  { name: 'Лиэль', look: 'A slim young adult woman with red hair', outfit: 'wearing a green dress' },
  { name: 'Мира', look: 'A small girl with dark braids', outfit: 'wearing a blue coat' }];
const variant: VariantFrame = { moment: 'The running father carries the girl while Бранд runs', shot: 'Medium wide shot', setting: 'A mountain pass',
  objects: '', props: '', light: 'Evening light', people: [
    { who: 'the rock', role: 'the falling rock', facing: 'other', look: 'A huge grey boulder', clothes: '', state: '', action: 'falls behind them' },
    { who: 'Brand', role: 'the running father', facing: 'screen-left', look: 'ignored', clothes: '', state: 'aged 40', action: 'runs toward the left' },
    { who: 'Мира', role: 'the girl in the father\'s left arm', facing: 'viewer', look: '', clothes: 'wearing a blue coat', state: '', action: 'clings to his neck' },
  ] };
const bot: Description = { moment: 'He runs', shot: 'Wide', setting: 'A pass', objects: '', props: '', light: 'Evening',
  people: [{ who: 'Бранд', look: '', clothes: '', state: '', action: 'runs' }] };

// docs/action-experiment.md#assembly: one manifest decides every variant arm.
test('the manifest binds the sheet\'s people first, in the frame\'s order, one slot and one portrait each', () => {
  const manifest = planManifest('flight', variant, sheet);
  rows([
    ['the sheet\'s people first, in the frame\'s order, a transliterated name matched', () => {
      assert.deepEqual(manifest.order, [1, 2, 0]);
      assert.deepEqual(manifest.entries, [null, 'e1', 'e3']);
    }],
    ['slots from 1, portraits by story and entry, a view only for a turned facing', () => assert.deepEqual(manifest.bound, [
      { person: 1, entry: 'e1', portrait: 'flight-e1', slot: 1, facing: 'screen-left', view: 'flight-e1-screen-left' },
      { person: 2, entry: 'e3', portrait: 'flight-e3', slot: 2, facing: 'viewer', view: null }])],
    ['two people matched to one entry stop the plan', () => {
      const twice = { ...variant, people: [...variant.people, { ...variant.people[1], who: 'Бранда', role: 'the second father' }] };
      assert.equal(planManifest('flight', twice, sheet).stop, 'shared_entry');
    }],
    ['nobody of the sheet binds nobody, and stops nothing', () => {
      const none = planManifest('flight', { ...variant, people: [variant.people[0]] }, sheet);
      assert.deepEqual([none.bound.length, none.stop], [0, undefined]);
    }],
  ]);
});

test('each arm writes its people as the doc says, and every prompt ends with the style line', () => {
  const manifest = planManifest('flight', variant, sheet);
  const plus = variantPrompt(variant, sheet, manifest, 'A+').prompt;
  const light = variantPrompt(variant, sheet, manifest, 'L').prompt;
  const c = variantPrompt(variant, sheet, manifest, 'C').prompt;
  const t = tPrompt(variant, sheet, manifest).prompt;
  rows([
    ['A+: look from the sheet, role, facing, clothes or the worn outfit, state: action, in the manifest\'s order', () => {
      assert.ok(plus.includes('A tall broad man with a black beard, the running father, body turned toward the left of the picture, wearing a grey cloak: runs toward the left. '
        + 'A small girl with dark braids, the girl in the father\'s left arm, body facing the viewer, wearing a blue coat: clings to his neck. '
        + 'A huge grey boulder, the falling rock: falls behind them. '));
    }],
    ['L: the bound lose their looks, the rest keep theirs', () => {
      assert.ok(light.includes('. the running father, body turned toward the left of the picture, wearing a grey cloak: runs toward the left. '));
      assert.ok(light.includes('A huge grey boulder, the falling rock: falls behind them. '));
      assert.ok(!light.includes('black beard') && !light.includes('dark braids'));
    }],
    ['C: each bound clause begins with the image of its slot and its role', () => {
      assert.ok(c.includes('The person from image 1, the running father, body turned toward the left of the picture'));
      assert.ok(c.includes('The person from image 2, the girl in the father\'s left arm, body facing the viewer'));
    }],
    ['T: its instruction, then each bound role from the image after L\'s', () => assert.equal(t,
      `${T_OPENING} the running father takes them from the person in image 2; the girl in the father's left arm takes them from the person in image 3. ${STYLE}`)],
    ['other adds no words', () => assert.equal(FACING_WORDS.other, '')],
    ['names and ages are stripped as the bot strips them', () => {
      assert.ok(plus.includes('The running father carries the girl while the figure runs. '));
      assert.ok(!/aged|40|Бранд|Brand/.test(plus));
    }],
    ['every prompt ends with the style line', () => assert.ok([plus, light, c, t].every(prompt => prompt.endsWith(STYLE))) ],
    ['a view asks for its turn, with the portraits\' style', () => assert.equal(viewPrompt('away'),
      `Image 1 shows one person. Draw the same person, with the same face, hair, build, marks and clothes, on the same plain grey backdrop, the whole body in frame, arms relaxed, now with the back to the viewer. ${PORTRAIT_STYLE}`)],
  ]);
});

test('a story\'s plan takes out the arms its text, its manifest or its bindings leave nothing for', () => {
  const story = textStories().find(one => one.id === 'flight')!;
  const ok = { outcome: 'ok' as const, attempts: 1, ms: 1 };
  const text = (change: Partial<StoryText> = {}): StoryText => ({ id: 'flight', pins: '', steps: { opening: ok, action: ok, sheet: ok, frame: ok, variant: ok },
    sheet, worn: sheet, frame: bot, variant, ...change });
  const tokens = (prompt: string, images: number) => ({ prompt: prompt.length, conditioning: images });
  const whole = planStory(story, text(), tokens);
  rows([
    ['A is the bot\'s own assembly', () => assert.equal(whole.arms.A!.prompt, assemblePrompt(bot, sheet).prompt)],
    ['C sends the fronts, V the view where one is needed, T L\'s picture and then the fronts', () => {
      assert.deepEqual(whole.arms.C!.references, ['flight-e1', 'flight-e3']);
      assert.deepEqual(whole.arms.V!.references, ['flight-e1-screen-left', 'flight-e3']);
      assert.deepEqual(whole.arms.T!.references, ['L', 'flight-e1', 'flight-e3']);
      assert.equal(whole.vIsC, false);
    }],
    ['a front per bound person and a view per turned one', () => {
      assert.deepEqual(whole.portraits.map(one => one.id), ['flight-e1', 'flight-e3']);
      assert.deepEqual(whole.views.map(one => [one.id, one.turn]), [['flight-e1-screen-left', 'screen-left']]);
    }],
    ['counts: people, bound, the encoder\'s images, and letters outside the Latin script', () => {
      assert.deepEqual([whole.counts.C!.people, whole.counts.C!.bound, whole.counts.C!.conditioning], [3, 2, 2]);
      assert.equal(whole.counts.T!.conditioning, 3);
      assert.equal(whole.counts['A+']!.nonLatin, 0);
      const russian = planStory(story, text({ variant: { ...variant, setting: 'A pass by the рыжая rock' } }));
      assert.equal(russian.counts['A+']!.nonLatin, 5);
    }],
    ['the cast against the sheet', () => assert.deepEqual(whole.cast, { cast: 4, inSheet: 3, sheetOnly: 0 })],
    ['nobody needing a view makes V\'s inputs C\'s', () => {
      const straight = planStory(story, text({ variant: { ...variant, people: variant.people.map(person => ({ ...person, facing: 'viewer' as const })) } }));
      assert.equal(straight.vIsC, true);
      assert.deepEqual(straight.views, []);
    }],
    ['a failed variant takes out A+, L, C, V and T, and A stays', () => {
      const failed = planStory(story, text({ steps: { ...text().steps, variant: { outcome: 'schema', attempts: 1, ms: 1 } }, variant: undefined }));
      assert.deepEqual(Object.keys(failed.arms), ['A']);
      assert.deepEqual(Object.keys(failed.out), ['A+', 'L', 'C', 'V', 'T']);
    }],
    ['a stopped manifest takes out L, C, V and T with its code, and draws no portrait', () => {
      const twice = { ...variant, people: [...variant.people, { ...variant.people[1], who: 'Бранда', role: 'the second father' }] };
      const stopped = planStory(story, text({ variant: twice }));
      assert.deepEqual(Object.keys(stopped.arms), ['A', 'A+']);
      assert.deepEqual(stopped.out, { L: 'shared_entry', C: 'shared_entry', V: 'shared_entry', T: 'shared_entry' });
      assert.deepEqual(stopped.portraits, []);
    }],
    ['a scene binding nobody keeps L and has no C, V or T', () => {
      const none = planStory(story, text({ variant: { ...variant, people: [variant.people[0]] } }));
      assert.deepEqual(Object.keys(none.arms), ['A', 'A+', 'L']);
      assert.deepEqual(none.out, { C: 'nobody_bound', V: 'nobody_bound', T: 'nobody_bound' });
    }],
  ]);
});
