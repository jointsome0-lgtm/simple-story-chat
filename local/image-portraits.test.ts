import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PORTRAIT_CLOTHES, PORTRAIT_STYLE, portraitCanvas, portraitCases, portraitDescription, portraitPrompt, referencesOf } from './image-portraits.ts';
import { STYLE } from './illustrate.ts';
import type { Case } from './illustrate-probe.ts';
import type { BatchIndex, Picture, References } from './image-batch.ts';

// Two frames of one story and one of another, as local/illustrate-probe.ts writes them. The sheet is the story's,
// so both frames of `battle` carry the same two people.
const sheet = [{ name: 'Элин', look: 'A middle-aged woman in grey, aged 48' }, { name: 'Марта', look: 'A tall young woman in red' }];
const cases: Case[] = [
  { id: 'battle-2', scenario: 'battle', index: 2, scene: 'Сцена про телегу.', sheet,
    description: { moment: 'At a cart', shot: 'Medium shot', setting: 'A salt road', objects: '', props: '', light: 'Morning light', people: [] },
    prompt: 'Medium shot.', namesStripped: 0, fromSheet: 0, withoutLook: 0 },
  { id: 'battle-5', scenario: 'battle', index: 5, scene: 'Сцена про шину.', sheet,
    description: { moment: 'At a wheel', shot: 'Wide shot', setting: 'A salt road', objects: '', props: '', light: 'Noon light', people: [] },
    prompt: 'Wide shot.', namesStripped: 0, fromSheet: 0, withoutLook: 0 },
  { id: 'dance-12', scenario: 'dance', index: 12, scene: 'Сцена про запись.', sheet: [{ name: 'Сава', look: 'A young man in black' }],
    description: { moment: 'At a monitor', shot: 'Wide shot', setting: 'A hall', objects: '', props: '', light: 'Evening light', people: [] },
    prompt: 'Wide shot.', namesStripped: 0, fromSheet: 0, withoutLook: 0 },
];

test('one portrait per person, numbered rather than named, with the appearance the frames will use', () => {
  const portraits = portraitCases(cases);
  // Three people over two stories; `battle` is described once, so its two frames give two portraits, not four.
  assert.deepEqual(portraits.map(one => one.id), ['portrait-battle-1', 'portrait-battle-2', 'portrait-dance-1']);
  // The id becomes a file name in the run directory and a key in a review bundle: no name of a person in it.
  for (const one of portraits) assert.ok(!/[Ѐ-ӿ]/.test(one.id), `${one.id} carries a name`);
  const elin = portraits[0]!;
  assert.deepEqual(elin.sheet, [sheet[0]]);
  assert.equal(elin.scenario, 'battle');
  // The prompt is assembled by the frames' own `assemblePrompt`: the sheet's appearance line, the age taken out of
  // it as everywhere else, the portrait's own style string at the end, and the name nowhere.
  assert.ok(elin.prompt.includes('A middle-aged woman in grey'));
  assert.ok(!elin.prompt.includes('48') && !elin.prompt.includes('Элин'));
  assert.ok(elin.prompt.endsWith(PORTRAIT_STYLE) && !elin.prompt.includes(STYLE));
  assert.equal(elin.prompt, portraitPrompt('Элин', sheet[0]!.look).prompt, 'the bot\'s own recipe');
  assert.equal(elin.fromSheet, 1);
  assert.equal(elin.withoutLook, 0);
  // Nothing is happening in a reference picture: it is the person, not a moment of the story.
  assert.equal(portraitDescription('Элин').people[0]!.who, 'Элин');
  assert.equal(portraitDescription('Элин').people[0]!.look, '', 'the look comes from the sheet, as it does in a frame');
  assert.equal(portraitCases([]).length, 0);
  // The owner wants the build to come from the portrait, so the portrait shows it: the whole figure, in clothes that
  // do not hide it, and no expression that could argue with a look line that says grim. The sheet's robe is what the
  // man wears in the story; in the portrait it would hide what the portrait is for.
  const [bran] = portraitCases([{ ...cases[0]!, sheet: [{ name: 'Бран', look: 'A middle-aged man of huge heavy build, grim menacing bearing',
    outfit: 'wearing a long fur-lined robe' }] }]);
  assert.ok(bran!.prompt.includes(`A middle-aged man of huge heavy build, grim menacing bearing, ${PORTRAIT_CLOTHES}`));
  assert.ok(bran!.prompt.includes('the whole body in frame'));
  assert.ok(!bran!.prompt.includes('robe'));
  assert.ok(!/expression|calm|smil/i.test(bran!.prompt));
  // Drawn upright, on the text-to-image graph's latent turned: 720x1280 for the pinned Qwen graph.
  assert.deepEqual(portraitCanvas(JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'))), { width: 720, height: 1280 });
});

const picture = (caseId: string, file: string): Picture => ({ caseId, checkpoint: 'q.safetensors', role: 'primary',
  seed: 7, steps: 25, sampler: 'euler', scheduler: 'simple', width: 1280, height: 720, totalMs: 1, viewMs: 1,
  vram: [], bytes: 10, sha256: 'aa', file });

test('the references file names a portrait per story and person, by a path relative to itself', () => {
  const portraits = portraitCases(cases);
  const index = { startedAt: '', comfy: { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 },
    pictures: [picture('portrait-battle-1', 'pictures/q/portrait-battle-1-s7.png'),
      picture('portrait-dance-1', 'pictures/q/portrait-dance-1-s7.png')], failures: [] } satisfies BatchIndex;
  const references: References = referencesOf(index, portraits, '/tmp/work', '/tmp/work/portraits');
  // A person whose portrait the run never drew is absent rather than pointing at a file that is not there.
  assert.equal(references.battle!['Марта'], undefined);
  assert.deepEqual(references, {
    battle: { 'Элин': 'portraits/pictures/q/portrait-battle-1-s7.png' },
    dance: { 'Сава': 'portraits/pictures/q/portrait-dance-1-s7.png' } });
  // One face per person: a second seed or a second checkpoint of the same portrait does not overwrite the first.
  const twice = { ...index, pictures: [...index.pictures, { ...picture('portrait-battle-1', 'pictures/q/portrait-battle-1-s9.png'), seed: 9 }] };
  assert.equal(referencesOf(twice, portraits, '/tmp/work', '/tmp/work/portraits').battle!['Элин'],
    'portraits/pictures/q/portrait-battle-1-s7.png');
});

// The two commands as the runbook types them, so that a flag renamed here is caught here and not on a rented card.
test('the tool writes a portrait prompts directory and reads a portrait run back into a references file', t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-portraits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(cases));
  const run = (args: string[]) => spawnSync(process.execPath, [resolve('local/image-portraits.ts'), ...args], { encoding: 'utf8' });

  const written = run(['prompts', '--prompts', join(root, 'prompts'), '--out', join(root, 'portrait-prompts')]);
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(JSON.parse(written.stdout.trim()),
    { event: 'portrait_prompts_written', directory: join(root, 'portrait-prompts'), portraits: 3, stories: 2 });
  const portraits: Case[] = JSON.parse(readFileSync(join(root, 'portrait-prompts', 'prompts.json'), 'utf8'));
  assert.equal(portraits.length, 3);

  // What local/image-batch.ts leaves behind after drawing them.
  mkdirSync(join(root, 'run'), { recursive: true });
  writeFileSync(join(root, 'run', 'prompts.json'), JSON.stringify(portraits));
  writeFileSync(join(root, 'run', 'index.json'), JSON.stringify({ startedAt: '',
    comfy: { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 },
    pictures: portraits.map(one => picture(one.id, `pictures/q/${one.id}-s7.png`)), failures: [] }));
  const bound = run(['references', '--run', join(root, 'run'), '--out', join(root, 'references.json')]);
  assert.equal(bound.status, 0, bound.stderr);
  assert.deepEqual(JSON.parse(bound.stdout.trim()),
    { event: 'references_written', file: join(root, 'references.json'), stories: 2, people: 3 });
  const references = JSON.parse(readFileSync(join(root, 'references.json'), 'utf8'));
  assert.deepEqual(Object.keys(references).sort(), ['battle', 'dance']);
  assert.equal(references.battle['Элин'], 'run/pictures/q/portrait-battle-1-s7.png');

  // A run that drew nothing this file could name is an error, not an empty file the frame run would read as
  // "nobody has a portrait" and then draw a whole identity comparison without a single reference.
  writeFileSync(join(root, 'run', 'index.json'), JSON.stringify({ startedAt: '',
    comfy: { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 }, pictures: [], failures: [] }));
  assert.equal(run(['references', '--run', join(root, 'run'), '--out', join(root, 'empty.json')]).status, 1);
});
