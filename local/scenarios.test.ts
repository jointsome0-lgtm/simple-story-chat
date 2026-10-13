import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadScenario, loadWalk } from './scenarios.ts';

const scenario = { authors: ['fable-5.1'], seed: 'Синтетика\n2026-01-01 10:00\nТекст сида.', turns: Array.from({ length: 16 }, (_, i) => `Ход ${i + 1}`),
  checks: [['total', 'Сколько всего? Целое число.', '7']], facts: '- Факт.', traps: [{ key: 'mid', afterTurn: 9, questions: [['mid_ok', 'Показано ли это?', 'yes']] }] };

test('scenario and walk preflight refuses unsafe names and invalid pack data', async t => {
  const walk = { authors: ['gpt-6-astra'], seed: 'Ночь\n2026-01-01 10:00\nТекст сида.', steps: ['', 'Гаснет свет.', '', '', '', '', '', ''] };
  for (const [load, file, good, bad] of [
    [loadScenario, 'scenario.json', scenario, [
      { ...scenario, authors: [] }, { ...scenario, turns: scenario.turns.slice(0, 15) },
      { ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'maybe']] }] },
      { ...scenario, traps: [{ key: 'end', questions: [['q', 'Вопрос?', 'yes']] }] },
    ]],
    [loadWalk, 'walk.json', walk, [{ ...walk, seed: 'Ночь\nвчера\nТекст сида.' }, { ...walk, steps: walk.steps.slice(0, 7) }]],
  ] as const) {
    for (const name of ['../hidden', 'nothing']) await assert.rejects(load(name), /Unknown synthetic/);
    for (const data of [good, ...bad]) {
      const root = mkdtempSync(join(tmpdir(), 'simple-chat-pack-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, 'hidden'));
      writeFileSync(join(root, 'hidden', file), JSON.stringify(data));
      if (data === good) assert.deepEqual((await load('hidden', root)).authors, good.authors);
      else await assert.rejects(load('hidden', root), /Invalid/);
    }
  }
});
