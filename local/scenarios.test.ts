import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadScenario, packScenarios } from './scenarios.ts';

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
});

test('a pack scenario outside the repository loads with its authors and its own frozen story', async () => {
  const directory = pack(scenario);
  assert.deepEqual(packScenarios(directory), ['hidden']);
  const hidden = await loadScenario('hidden', directory);
  assert.deepEqual(hidden.authors, ['fable-5.1']);
  assert.equal(hidden.frozenPath, join(directory, 'hidden', 'frozen.json'));
  assert.equal(hidden.traps[0].afterTurn, 9);
});

test('a pack scenario without authors, with too few turns or with a malformed trap is refused', async () => {
  await assert.rejects(loadScenario('hidden', pack({ ...scenario, authors: [] })), /Invalid scenario/);
  await assert.rejects(loadScenario('hidden', pack({ ...scenario, turns: scenario.turns.slice(0, 15) })), /Invalid scenario/);
  await assert.rejects(loadScenario('hidden', pack({ ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'maybe']] }] })), /Invalid scenario/);
  await assert.rejects(loadScenario('hidden', pack({ ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'yes']] }] })), /Invalid scenario/);
});
