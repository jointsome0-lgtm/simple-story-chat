import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_SEEDS, ACTION_STORIES, MARKER_STORY, SHARP_INSTRUCTION, SHARP_SCHEMA, SHARP_THEMES, actionSetHash, repeatedScenes,
  sharpInstruction } from '../examples/action-set.ts';

// The blockquote of the doc that begins with these words, as one line: how the doc pins a text word for word.
function quoted(doc: string, start: string): string {
  const lines = doc.split('\n');
  const first = lines.findIndex(line => line.startsWith(`> ${start}`));
  if (first < 0) return '';
  const end = lines.findIndex((line, at) => at > first && !line.startsWith('> '));
  return lines.slice(first, end < 0 ? undefined : end).map(line => line.slice(2)).join(' ');
}

// The set is the experiment's input, fixed before any card (docs/action-experiment.md#the-set). Each row is one promise
// the doc makes about it.
test('the set holds the stories the doc names, each seed introducing everyone its moment needs', () => {
  const doc = readFileSync(resolve('docs/action-experiment.md'), 'utf8');
  const rows: [string, () => void][] = [
    ['thirteen clean stories, in the doc\'s order', () => assert.deepEqual(ACTION_STORIES.map(story => story.id),
      ['flight', 'demon', 'beach', 'giants', 'jellyfish', 'guard', 'lineout', 'cheer', 'tango', 'monkeys', 'rescue', 'gulliver', 'twister'])],
    ['a seed of six to twelve lines, a start time in the bot\'s format', () => {
      for (const story of ACTION_STORIES) {
        const lines = story.seed.split('\n').filter(line => line.trim()).length;
        assert.ok(lines >= 6 && lines <= 12, `${story.id}: ${lines} lines`);
        assert.match(story.startTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, story.id);
      }
    }],
    ['no moment with more than six participants, each of them in the cast and named in the seed', () => {
      for (const story of ACTION_STORIES) {
        const { participants } = story.target;
        assert.ok(participants.length >= 2 && participants.length <= 6, story.id);
        assert.equal(new Set(story.cast).size, story.cast.length, story.id);
        assert.ok(participants.every(name => story.cast.includes(name)), story.id);
        assert.ok(story.cast.every(name => story.seed.includes(name)), story.id);
        assert.ok(story.target.contact.trim() && story.action.trim(), story.id);
      }
    }],
    ['Gulliver cut to six, the two guards each a person of their own', () => {
      const gulliver = ACTION_STORIES.find(story => story.id === 'gulliver')!;
      assert.equal(gulliver.cast.length, 6);
      assert.ok(['Гвоздик', 'Шило'].every(name => gulliver.target.participants.includes(name)));
    }],
    ['five sharp themes, in the doc\'s words, with the instruction pinned word for word', () => {
      assert.deepEqual(SHARP_THEMES.map(theme => theme.id), ['sharp-1', 'sharp-2', 'sharp-3', 'sharp-4', 'sharp-5']);
      assert.deepEqual(SHARP_THEMES.map(theme => theme.theme), ['общественная баня', 'гарем', 'плен', 'допрос', 'битва и перевязка раненых']);
      assert.equal(quoted(doc, 'Придумай'), SHARP_INSTRUCTION);
      for (const { theme } of SHARP_THEMES) assert.ok(sharpInstruction(theme).includes(`«${theme}»`) && !sharpInstruction(theme).includes('ТЕМА'));
      assert.deepEqual(SHARP_SCHEMA.required, ['seed', 'action']);
    }],
    ['seeds 7 and 11, and four repeated clean scenes drawn from the set\'s hash alone', () => {
      assert.deepEqual(ACTION_SEEDS, [7, 11]);
      const repeated = repeatedScenes();
      assert.equal(new Set(repeated).size, 4);
      assert.ok(repeated.every(id => ACTION_STORIES.some(story => story.id === id)));
      assert.deepEqual(repeatedScenes(actionSetHash()), repeated);
      assert.notDeepEqual(repeatedScenes('another set'), repeated);
    }],
    ['the marker story is a template with the made-up name in its seed and its action', () => {
      assert.ok(MARKER_STORY.seed('Зурбаган').includes('Зурбаган') && MARKER_STORY.action('Зурбаган').includes('Зурбаган'));
      assert.ok(!MARKER_STORY.seed('Зурбаган').includes('ИМЯ'));
    }],
  ];
  for (const [promise, check] of rows) {
    try { check(); } catch (error) { assert.fail(`${promise}: ${(error as Error).message}`); }
  }
});
