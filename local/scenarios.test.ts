import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadScenario, packScenarios, loadWalk, packWalks } from './scenarios.ts';

const scenario = { authors: ['fable-5.1'], seed: 'Синтетика\n2026-01-01 10:00\nТекст сида.', turns: Array.from({ length: 16 }, (_, i) => `Ход ${i + 1}`),
  checks: [['total', 'Сколько всего? Целое число.', '7']], facts: '- Факт.', traps: [{ key: 'mid', afterTurn: 9, questions: [['mid_ok', 'Показано ли это?', 'yes']] }] };

function pack(data: object) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-pack-'));
  mkdirSync(join(directory, 'hidden'));
  writeFileSync(join(directory, 'hidden', 'scenario.json'), JSON.stringify(data));
  return directory;
}

test('a built-in scenario loads with its checks, traps and frozen path, and has no pack authors', async () => {
  const battle = await loadScenario('battle');
  assert.equal(battle.turns.length, 16);
  assert.ok(battle.checks.length && battle.traps.length && battle.frozenPath.endsWith(join('examples', 'frozen', 'battle.json')));
  assert.deepEqual(battle.authors, []);
  await assert.rejects(loadScenario('../battle'), /Unknown synthetic scenario/);
  await assert.rejects(loadScenario('nothing'), /Unknown synthetic scenario/);
  // A pack scenario outside the repository loads with its authors and its own frozen story.
  const directory = pack(scenario);
  assert.deepEqual(packScenarios(directory), ['hidden']);
  const hidden = await loadScenario('hidden', directory);
  assert.deepEqual([hidden.authors, hidden.frozenPath, hidden.traps[0].afterTurn], [['fable-5.1'], join(directory, 'hidden', 'frozen.json'), 9]);
  const refused: [string, object][] = [['no authors', { ...scenario, authors: [] }],
    ['too few turns', { ...scenario, turns: scenario.turns.slice(0, 15) }],
    ['a trap answer that is not yes or no', { ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'maybe']] }] }],
    ['a trap with neither its turn nor its input', { ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'yes']] }] }]];
  for (const [label, data] of refused) await assert.rejects(loadScenario('hidden', pack(data)), /Invalid scenario/, label);
});

test('a walk loads from examples or from a pack; the empty step is the continue signal, a bad seed time or name is refused', async () => {
  const lighthouse = await loadWalk('lighthouse');
  assert.equal(lighthouse.steps.length, 16);
  assert.ok(lighthouse.steps.some(step => step === '') && lighthouse.steps.some(step => step !== ''));
  assert.deepEqual(lighthouse.authors, ['fable-5.1']);
  await assert.rejects(loadWalk('../lighthouse'), /Unknown synthetic walk/);
  await assert.rejects(loadWalk('nothing'), /Unknown synthetic walk/);
  // A pack directory holds replay scenarios and walks side by side; only a directory with walk.json is a walk.
  const directory = pack(scenario);
  mkdirSync(join(directory, 'night'));
  const walk = { authors: ['gpt-6-astra'], seed: 'Ночь\n2026-01-01 10:00\nТекст сида.', steps: ['', 'Гаснет свет.', '', '', '', '', '', ''] };
  writeFileSync(join(directory, 'night', 'walk.json'), JSON.stringify(walk));
  assert.deepEqual(packWalks(directory), ['night']);
  assert.equal((await loadWalk('night', directory)).steps[1], 'Гаснет свет.');
  writeFileSync(join(directory, 'night', 'walk.json'), JSON.stringify({ ...walk, seed: 'Ночь\nвчера\nТекст сида.' }));
  await assert.rejects(loadWalk('night', directory), /Invalid walk.json/);
  writeFileSync(join(directory, 'night', 'walk.json'), JSON.stringify({ ...walk, steps: walk.steps.slice(0, 7) }));
  await assert.rejects(loadWalk('night', directory), /Invalid walk.json/);
});
