import test from 'node:test';
import assert from 'node:assert/strict';
import { deal, page, score, task } from './blind-review.ts';
import type { Entry } from './blind-review.ts';

const entries: Entry[] = ['one', 'two', 'three', 'four', 'five', 'six'].flatMap(caseId => ['alpha', 'beta'].map(checkpoint => (
  { caseId, checkpoint, seed: 7, file: `pictures/${caseId}-${checkpoint}.png`, run: '/run' })));
const scenes = entries.map(entry => ({ id: entry.caseId, scene: `Сцена ${entry.caseId} <script>` }));

test('a dealt page names no checkpoint and its key names every one', () => {
  const { questions, key, files } = deal(entries, scenes, 'owner', 1);
  assert.equal(questions.length, 6);
  assert.equal(files.length, 12);
  const shown = JSON.stringify(questions) + page('owner', questions) + task(questions.length);
  assert.ok(!/alpha|beta/.test(shown));
  for (const question of key.questions) assert.deepEqual(Object.values(question.letters).sort(), ['alpha', 'beta']);
  // Picture names are what the rater's files are called: they must not repeat the source names either.
  assert.ok(files.every(file => !/alpha|beta|one|two/.test(file.name)));
  assert.equal(new Set(files.map(file => file.name)).size, 12);
});

test('the same seed deals the same page; another rater gets another order and other file names', () => {
  const first = deal(entries, scenes, 'owner', 1), again = deal(entries, scenes, 'owner', 1), other = deal(entries, scenes, 'astra', 1);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first.key.questions, other.key.questions);
  const names = new Set(first.files.map(file => file.name));
  assert.ok(other.files.every(file => !names.has(file.name)));
  // Letters are not a constant mapping: over six scenes each checkpoint stands under A at least once.
  assert.equal(new Set(first.key.questions.map(question => question.letters.A)).size, 2);
});

test('a scene one checkpoint drew is left out, and a repeated picture is counted once', () => {
  const lone: Entry = { caseId: 'lone', checkpoint: 'alpha', seed: 7, file: 'pictures/lone.png', run: '/run' };
  const { questions, files } = deal([...entries, lone, entries[0]], scenes, 'owner', 1);
  assert.equal(questions.length, 6);
  assert.equal(files.length, 12);
});

test('the page escapes scene text', () => {
  const { questions } = deal(entries, scenes, 'owner', 1);
  assert.ok(!page('owner', questions).includes('<script>"'));
  assert.ok(page('owner', questions).includes('\\u003cscript>'));
});

test('score opens the key, counts wins and contradictions, and measures agreement', () => {
  const owner = deal(entries, scenes, 'owner', 1), astra = deal(entries, scenes, 'astra', 1);
  const letterOf = (key: typeof owner.key, id: string, checkpoint: string) =>
    Object.entries(key.questions.find(question => question.id === id)!.letters).find(([, value]) => value === checkpoint)![0];
  const ids = owner.key.questions.map(question => question.id).sort();
  // The owner prefers alpha everywhere but calls one scene hopeless; the model agrees on four of the six.
  const ownerAnswers = { rater: 'owner', answers: ids.map((id, at) => at === 5 ? { id, best: 'none' }
    : { id, best: letterOf(owner.key, id, 'alpha'), contradicts: at === 0 ? [letterOf(owner.key, id, 'beta')] : [] }) };
  const astraAnswers = { rater: 'astra', answers: ids.map((id, at) => ({ id, best: at < 4 ? letterOf(astra.key, id, 'alpha') : letterOf(astra.key, id, 'beta') })) };
  const result = score([{ key: owner.key, answers: ownerAnswers }, { key: astra.key, answers: astraAnswers }]);
  assert.deepEqual(result.raters[0].wins, { alpha: 5, beta: 0 });
  assert.equal(result.raters[0].none, 1);
  assert.deepEqual(result.raters[0].contradictions, { alpha: 0, beta: 1 });
  assert.deepEqual(result.raters[1].wins, { alpha: 4, beta: 2 });
  assert.deepEqual(result.agreement, { shared: 6, agreed: 4, rate: 0.667 });
  assert.equal(score([{ key: owner.key, answers: ownerAnswers }]).agreement, null);
});
