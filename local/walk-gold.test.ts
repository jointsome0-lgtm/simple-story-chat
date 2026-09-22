import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyGold, loadGold, saveGold, pathOf, trunk, addNode, agree, trunkTasks, renderGold, goldPaths } from './walk-gold.ts';

const node = (parent: string | null, depth: number, step: string, text: string) => ({ parent, depth, step, input: step || 'Продолжай.', text, author: 'x', attempts: 1,
  approved: { at: 't', judges: ['a', 'b', 'c', 'd'], dissent: 0 }, read: false });

test('a gold tree keeps its seed hash, grows by ids, and gives a node its path from the root', () => {
  const tree = emptyGold('w', 'Сид\n2026-01-01 10:00\nМир.');
  const g1 = addNode(tree, node(null, 1, '', 'Сцена 1.'));
  const g2 = addNode(tree, node(g1, 2, 'Гаснет свет.', 'Сцена 2.'));
  const g3 = addNode(tree, node(g1, 2, '', 'Другая сцена 2.'));
  assert.deepEqual([g1, g2, g3], ['g1', 'g2', 'g3']);
  assert.deepEqual(pathOf(tree, g2).map(s => [s.id, s.turn, s.kind, s.text]), [['g1', 1, 'continue', 'Сцена 1.'], ['g2', 2, 'intervention', 'Сцена 2.']]);
  assert.deepEqual(pathOf(tree, null), []);
  const path = join(mkdtempSync(join(tmpdir(), 'simple-chat-gold-')), 'gold.json');
  saveGold(path, tree);
  assert.equal(Object.keys(loadGold(path, 'w', 'Сид\n2026-01-01 10:00\nМир.').nodes).length, 3);
  assert.throws(() => loadGold(path, 'w', 'Сид\n2026-01-01 10:00\nДругой мир.'), /does not match/);
  assert.equal(Object.keys(loadGold(join(path, '..', 'none.json'), 'w', 'x').nodes).length, 0);
});

test('the trunk follows the walk steps, and the per-step tasks continue from the seed and every trunk node', () => {
  const tree = emptyGold('w', 'seed');
  const steps = ['', 'Гаснет свет.', '', ''];
  const g1 = addNode(tree, node(null, 1, '', 'a'));
  addNode(tree, node(g1, 2, '', 'branch: continued instead of the intervention'));
  const g3 = addNode(tree, node(g1, 2, 'Гаснет свет.', 'b'));
  assert.deepEqual(trunk(tree, steps), [g1, g3]);
  assert.deepEqual(trunkTasks(tree, steps), [{ parent: null, step: '' }, { parent: g1, step: 'Гаснет свет.' }, { parent: g3, step: '' }]);
  assert.deepEqual(trunkTasks(emptyGold('w', 'seed'), steps), [{ parent: null, step: '' }]);
});

test('the gate to gold is the agreement of every judge, a judge may take back its own finding, nobody is overruled', () => {
  const all = (v: 'consistent' | 'inconsistent' | 'error') => ({ a: v, b: v, c: v, d: v });
  const check = (confirmed: boolean) => [{ turn: 3, finding: 1, confirmed, note: '' }];
  assert.deepEqual(agree(all('consistent'), {}, 3, 0), { agreed: true, against: [] });
  assert.deepEqual(agree({ ...all('consistent'), d: 'inconsistent' }, {}, 3, 0), { agreed: false, against: ['d'] });
  assert.deepEqual(agree({ ...all('consistent'), d: 'error' }, {}, 3, 0), { agreed: false, against: ['d'] });
  // d listed one finding and takes it back; everyone refutes it: agreed.
  assert.deepEqual(agree({ ...all('consistent'), d: 'inconsistent' }, { a: check(false), b: check(false), c: check(false), d: check(false) }, 3, 1), { agreed: true, against: [] });
  // d stands by its finding although three refute it: not gold.
  assert.deepEqual(agree({ ...all('consistent'), d: 'inconsistent' }, { a: check(false), b: check(false), c: check(false), d: check(true) }, 3, 1), { agreed: false, against: ['d'] });
  // d takes it back but a confirms it: not gold; c gave no checks: not gold either.
  assert.deepEqual(agree({ ...all('consistent'), d: 'inconsistent' }, { a: check(true), b: check(false), c: check(false), d: check(false) }, 3, 1).against, ['a']);
  assert.deepEqual(agree({ ...all('consistent'), d: 'inconsistent' }, { a: check(false), b: check(false), d: check(false) }, 3, 1).against, ['c']);
  // Checks of another scene do not count for this one.
  assert.deepEqual(agree(all('consistent'), { a: [{ turn: 2, finding: 1, confirmed: false, note: '' }], b: check(false), c: check(false), d: check(false) }, 3, 1).against, ['a']);
  assert.equal(agree({}, {}, 1, 0).agreed, false);
});

test('the rendering lists the trunk in order, then the branches, and marks what nobody has read', () => {
  const tree = emptyGold('w', 'Сид\n2026-01-01 10:00\nМир.');
  const g1 = addNode(tree, node(null, 1, '', '2026-01-01 10:05\n\nПервая.'));
  addNode(tree, node(g1, 2, '', '2026-01-01 10:10\n\nВетка.'));
  const g3 = addNode(tree, node(g1, 2, 'Гаснет свет.', '2026-01-01 10:10\n\nСтвол.'));
  tree.nodes[g3].read = true;
  tree.rejected.push({ parent: g1, step: 'Гаснет свет.', text: 'x', author: 'x', at: 't', findings: [{ now: 'a', before: 'b', where: 'сид', kind: 'number', by: 'j' }] });
  const text = renderGold(tree, { seed: 'Сид\n2026-01-01 10:00\nМир.', steps: ['', 'Гаснет свет.', ''] });
  assert.match(text, /^# Сид · золотое дерево/);
  assert.ok(text.indexOf('### Сцена 1 · g1 · знак продолжать') < text.indexOf('### Сцена 2 · g3 (от g1) · вмешательство: Гаснет свет.'));
  assert.ok(text.indexOf('## Ветви') < text.indexOf('### Сцена 2 · g2 (от g1)'));
  assert.match(text, /g3 \(от g1\)[^\n]*\n\n_x · судей 4, против 0, попытка 1 · вычитано_/);
  assert.match(text, /Отклонённые попытки: 1/);
});

test('gold paths sit next to the walk, or inside the pack directory of the scenario', () => {
  assert.deepEqual(goldPaths('/r', 'w'), { tree: '/r/examples/walk/w.gold.json', story: '/r/examples/walk/w.gold.md' });
  assert.deepEqual(goldPaths('/r', 'w', '/p'), { tree: '/p/w/gold.json', story: '/p/w/gold.md' });
});
