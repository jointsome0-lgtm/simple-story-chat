import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Case } from './illustrate-probe.ts';
import type { Picture } from './image-batch.ts';

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

const picture = (caseId: string, file: string): Picture => ({ caseId, checkpoint: 'q.safetensors', role: 'primary',
  seed: 7, steps: 25, sampler: 'euler', scheduler: 'simple', width: 1280, height: 720, totalMs: 1, viewMs: 1,
  vram: [], bytes: 10, sha256: 'aa', file });

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
  assert.deepEqual(portraits.map(one => one.id), ['portrait-battle-1', 'portrait-battle-2', 'portrait-dance-1']);
  assert.doesNotMatch(portraits[0].prompt, /Элин|48/);

  // What local/image-batch.ts leaves behind after drawing them.
  mkdirSync(join(root, 'run'), { recursive: true });
  writeFileSync(join(root, 'run', 'prompts.json'), JSON.stringify(portraits));
  writeFileSync(join(root, 'run', 'index.json'), JSON.stringify({ startedAt: '',
    comfy: { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 },
    pictures: [picture(portraits[0].id, 'pictures/q/elin-s7.png'), picture(portraits[2].id, 'pictures/q/sava-s7.png'),
      { ...picture(portraits[0].id, 'pictures/q/elin-s9.png'), seed: 9 }], failures: [] }));
  const bound = run(['references', '--run', join(root, 'run'), '--out', join(root, 'references.json')]);
  assert.equal(bound.status, 0, bound.stderr);
  assert.deepEqual(JSON.parse(bound.stdout.trim()),
    { event: 'references_written', file: join(root, 'references.json'), stories: 2, people: 2 });
  const references = JSON.parse(readFileSync(join(root, 'references.json'), 'utf8'));
  // A missing portrait stays absent and a second seed cannot overwrite the first face.
  assert.deepEqual(references, { battle: { 'Элин': 'run/pictures/q/elin-s7.png' }, dance: { 'Сава': 'run/pictures/q/sava-s7.png' } });

  // A run that drew nothing this file could name is an error, not an empty file the frame run would read as
  // "nobody has a portrait" and then draw a whole identity comparison without a single reference.
  writeFileSync(join(root, 'run', 'index.json'), JSON.stringify({ startedAt: '',
    comfy: { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 }, pictures: [], failures: [] }));
  assert.equal(run(['references', '--run', join(root, 'run'), '--out', join(root, 'empty.json')]).status, 1);
});
