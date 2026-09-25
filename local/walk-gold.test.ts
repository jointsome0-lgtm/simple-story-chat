import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyGold, loadGold, saveGold, pathOf, trunk, addNode, agree, trunkTasks, renderGold, noteLater, stats, noteSeen, promote, pathText, goldPaths } from './walk-gold.ts';

const node = (parent: string | null, depth: number, step: string, text: string) => ({ parent, depth, step, input: step || 'Продолжай.', text, author: 'x', attempts: 1,
  approved: { at: 't', judges: ['a', 'b', 'c', 'd'], dissent: 0 }, read: false });

test('a gold tree keeps its seed hash, grows by ids, and gives a node its path from the root', () => {
  const walk = { seed: 'Сид\n2026-01-01 10:00\nМир.', steps: ['', 'Гаснет свет.', '', ''] };
  const tree = emptyGold('w', walk.seed);
  const g1 = addNode(tree, node(null, 1, '', 'Сцена 1.'));
  // A branch that continued where the walk intervenes, grown before the trunk's own scene 2.
  const g2 = addNode(tree, node(g1, 2, '', 'Ветка.'));
  const g3 = addNode(tree, node(g1, 2, 'Гаснет свет.', 'Сцена 2.'));
  assert.deepEqual([g1, g2, g3], ['g1', 'g2', 'g3']);
  assert.deepEqual(pathOf(tree, g3).map(s => [s.id, s.turn, s.kind, s.text]), [['g1', 1, 'continue', 'Сцена 1.'], ['g3', 2, 'intervention', 'Сцена 2.']]);
  assert.deepEqual(pathOf(tree, null), []);
  // What a reader of the node has read: the seed, then every step and scene down to it.
  assert.equal(pathText(tree, walk, null), walk.seed);
  assert.equal(pathText(tree, walk, g3), `${walk.seed}\n\nПродолжай.\n\nСцена 1.\n\nГаснет свет.\n\nСцена 2.`);
  // The trunk follows the walk's steps, and the per-step tasks continue from the seed and every trunk node.
  assert.deepEqual(trunk(tree, walk.steps), [g1, g3]);
  assert.deepEqual(trunkTasks(tree, walk.steps), [{ parent: null, step: '' }, { parent: g1, step: 'Гаснет свет.' }, { parent: g3, step: '' }]);
  assert.deepEqual(trunkTasks(emptyGold('w', walk.seed), walk.steps), [{ parent: null, step: '' }]);
  // A counted path shows in the reading of its own node.
  tree.nodes[g3].pathTokens = 42;
  const story = renderGold(tree, walk);
  assert.match(story, /Сцена 2 · g3[^\n]*\n\n_кандидат[^\n]*путь 42 токенов/);
  assert.doesNotMatch(story, /Сцена 1 · g1[^\n]*\n\n_кандидат[^\n]*путь \d+ токенов/);
  assert.deepEqual(stats(tree).pathTokens, { counted: 1, max: 42 });
  const path = join(mkdtempSync(join(tmpdir(), 'simple-chat-gold-')), 'gold.json');
  saveGold(path, tree);
  assert.equal(Object.keys(loadGold(path, 'w', walk.seed).nodes).length, 3);
  assert.throws(() => loadGold(path, 'w', 'Сид\n2026-01-01 10:00\nДругой мир.'), /does not match/);
  assert.equal(Object.keys(loadGold(join(path, '..', 'none.json'), 'w', 'x').nodes).length, 0);
  // Next to a built-in walk, or in the scenario's own directory of a pack, so two scenarios never share a gold.
  assert.deepEqual(goldPaths('/r', 'w'), { tree: '/r/examples/walk/w.gold.json', story: '/r/examples/walk/w.gold.md' });
  assert.deepEqual(goldPaths('/r', 'w', '/p'), { tree: '/p/w/gold.json', story: '/p/w/gold.md' });
});

test('a candidate becomes gold by its ledger: agreed rechecks, enough deeper scenes over it, no standing later finding, no audit issue', () => {
  // The gate to a candidate is the agreement of every judge: a judge may take back its own finding, and nobody is
  // overruled or presumed.
  const all = { a: 'consistent', b: 'consistent', c: 'consistent', d: 'consistent' } as const;
  const check = (confirmed: boolean, turn = 3) => [{ turn, finding: 1, confirmed, note: '' }];
  const gate: [string, Parameters<typeof agree>[0], Parameters<typeof agree>[1], number, string[]][] = [
    ['every judge consistent', all, {}, 0, []],
    ['one judge inconsistent', { ...all, d: 'inconsistent' }, {}, 0, ['d']],
    ['one judge without a verdict', { ...all, d: 'error' }, {}, 0, ['d']],
    ['d takes its finding back and everyone refutes it', { ...all, d: 'inconsistent' }, { a: check(false), b: check(false), c: check(false), d: check(false) }, 1, []],
    ['d stands by its finding although three refute it', { ...all, d: 'inconsistent' }, { a: check(false), b: check(false), c: check(false), d: check(true) }, 1, ['d']],
    ['d takes it back but a confirms it', { ...all, d: 'inconsistent' }, { a: check(true), b: check(false), c: check(false), d: check(false) }, 1, ['a']],
    ['c gave no checks', { ...all, d: 'inconsistent' }, { a: check(false), b: check(false), d: check(false) }, 1, ['c']],
    ['a checked another scene', all, { a: check(false, 2), b: check(false), c: check(false), d: check(false) }, 1, ['a']],
  ];
  for (const [label, votes, checks, found, against] of gate) assert.deepEqual(agree(votes, checks, 3, found), { agreed: !against.length, against }, label);
  assert.equal(agree({}, {}, 1, 0).agreed, false, 'no judges');
  // A finding that points back at a scene of the judged path is noted on that node with the cross outcome, unknown
  // without checks; the seed, a step and a scene off the path are not nodes. The ledger counts it.
  const tree = emptyGold('w', 'seed');
  const g1 = addNode(tree, node(null, 1, '', 'a'));
  const g2 = addNode(tree, node(g1, 2, '', 'b'));
  const found = [
    { by: 'j1', where: 'сцена 1', now: 'x', before: 'y', number: 1 },
    { by: 'j2', where: 'Сцена 2', now: 'x', before: 'y', number: 2 },
    { by: 'j2', where: 'сид', now: 'x', before: 'y', number: 3 },
    { by: 'j1', where: 'шаг 2', now: 'x', before: 'y', number: 4 },
    { by: 'j1', where: 'сцена 7', now: 'x', before: 'y', number: 5 },
  ];
  const checks = { j1: [{ turn: 3, finding: 1, confirmed: false, note: '' }, { turn: 3, finding: 2, confirmed: true, note: '' }], j2: [{ turn: 3, finding: 1, confirmed: false, note: '' }, { turn: 3, finding: 2, confirmed: false, note: '' }] };
  assert.equal(noteLater(tree, [g1, g2], found, checks, 3, 'w1', 't'), 2);
  assert.deepEqual(tree.nodes[g1].reviews, [{ kind: 'later', at: 't', by: 'j1', depth: 3, writer: 'w1', confirmed: false, now: 'x', before: 'y' }]);
  assert.deepEqual(tree.nodes[g2].reviews, [{ kind: 'later', at: 't', by: 'j2', depth: 3, writer: 'w1', confirmed: true, now: 'x', before: 'y' }]);
  assert.equal(noteLater(tree, [g1, g2], [found[0]!], {}, 4, 'w2', 't'), 1);
  assert.equal((tree.nodes[g1].reviews!.at(-1) as { confirmed: boolean | null }).confirmed, null);
  tree.nodes[g2].reviews!.push({ kind: 'audit', at: 't', by: 'j1', issue: 'ambiguity', quote: 'q', note: 'n' }, { kind: 'recheck', at: 't', agreed: false, against: ['j2'] });
  const s = stats(tree);
  assert.deepEqual([s.nodes, s.pointedAtLater, s.laterFindings, s.laterConfirmed, s.laterRefuted, s.audited, s.auditIssues, s.rechecked, s.recheckAgreed], [2, 2, 3, 1, 1, 1, 1, 1, 0]);
  assert.deepEqual(s.byJudge, { j1: { later: 2, confirmed: 0, audit: 1 }, j2: { later: 1, confirmed: 1, audit: 0 } });
  const story = renderGold(tree, { seed: 'Сид\n2026-01-01 10:00\nМир.', steps: ['', ''] });
  assert.match(story, /## Согласования\n\nУзлов 2, из них золото 0, кандидатов 2; на 2 позже указывали/);
  assert.match(story, /g2 \(от g1\)[^\n]*\n\n_кандидат · x · судей 4, против 0, попытка 1 · над ним прочитано 0 · позже указывали 1 \(устояло 1, снято 0\) · аудит: 1 · перепроверок 1, согласны снова 0 · не вычитано_/);
  // Promotion, on ledgers set by hand: g3 grows under g2, and four deeper scenes were judged over g1 and g2.
  const g3 = addNode(tree, node(g2, 3, '', 'c'));
  for (let i = 0; i < 4; i++) noteSeen(tree, [g1, g2]);
  assert.deepEqual([tree.nodes[g1].seen, tree.nodes[g2].seen, tree.nodes[g3].seen], [4, 4, undefined]);
  const agreed = { kind: 'recheck' as const, at: 't', agreed: true, against: [] };
  tree.nodes[g1].reviews = [agreed, agreed, { kind: 'later', at: 't', by: 'j', depth: 3, writer: 'w', confirmed: false, now: '', before: '' }];
  tree.nodes[g2].reviews = [agreed, { kind: 'recheck', at: 't', agreed: false, against: ['j'] }];
  tree.nodes[g3].reviews = [agreed, agreed];
  assert.deepEqual(promote(tree, { rechecks: 2, exposures: 4 }), [g1]);
  assert.equal(tree.nodes[g1].status, 'gold');
  assert.equal(tree.nodes[g2].status, undefined);
  // g3 has the rechecks but nothing was judged over it yet; a lower bar admits it.
  assert.deepEqual(promote(tree, { rechecks: 2, exposures: 0 }), [g3]);
  // A later finding that stood, or an audit issue, keeps a node a candidate whatever else it has.
  tree.nodes[g2].reviews = [agreed, agreed, { kind: 'later', at: 't', by: 'j', depth: 3, writer: 'w', confirmed: true, now: '', before: '' }];
  assert.deepEqual(promote(tree, { rechecks: 2, exposures: 4 }), []);
  tree.nodes[g2].reviews = [agreed, agreed, { kind: 'audit', at: 't', by: 'j', issue: 'ambiguity', quote: 'q', note: 'n' }];
  assert.deepEqual(promote(tree, { rechecks: 2, exposures: 4 }), []);
  assert.equal(stats(tree).gold, 2);
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
  assert.match(text, /g3 \(от g1\)[^\n]*\n\n_кандидат · x · судей 4, против 0, попытка 1 · над ним прочитано 0 · вычитано_/);
  assert.match(text, /Отклонённые попытки: 1/);
});
