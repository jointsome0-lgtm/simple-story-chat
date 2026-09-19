import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from '../lib/library.ts';
// The committed cloud artifact; `npm run check` verifies that it is the current tsc output of lib/library.ts.
import * as artifact from '../lib/library.js';
import type { Library } from '../lib/library.ts';
import { Store } from './store.ts';

// A synthetic library in format v1, built with the original JS domain plus the fields the bot adds to scenes and
// memory: sent and pending scenes, a compacted branch, a fork and a pending job.
const stored: Library = {
  version: 1, seq: 20,
  seeds: { s1: { id: 's1', title: 'Маяк', startTime: '2026-08-02 20:00', text: 'Синтетический остров и смотритель.' } },
  stories: { h2: { id: 'h2', seedId: 's1', title: 'Маяк',
    branches: { b3: { id: 'b3', name: 'Начало', head: 'n12', memory: 'm15' }, b18: { id: 'b18', name: 'От Пауза', head: 'n12', memory: 'm15' } },
    checkpoints: {
      c4: { id: 'c4', branchId: 'b3', label: 'Сид', kind: 'start', head: null, memory: null },
      c7: { id: 'c7', branchId: 'b3', label: 'Сцена 1', kind: 'scene', head: 'n6', memory: null },
      c10: { id: 'c10', branchId: 'b3', label: 'Сцена 2', kind: 'scene', head: 'n9', memory: null },
      c13: { id: 'c13', branchId: 'b3', label: 'Сцена 3', kind: 'scene', head: 'n12', memory: null },
      c16: { id: 'c16', branchId: 'b3', label: 'После сжатия', kind: 'compaction', head: 'n12', memory: 'm15' },
      c17: { id: 'c17', branchId: 'b3', label: 'Пауза', kind: 'manual', head: 'n12', memory: 'm15' },
      c19: { id: 'c19', branchId: 'b18', label: 'Точка развилки', kind: 'fork', head: 'n12', memory: 'm15' },
    },
    nodes: {
      n6: { id: 'n6', parent: null, input: 'Ввод 1.', text: '2026-08-02 20:01\n\nСцена 1.', time: '2026-08-02 20:01', truncated: false, delivery: 'sent',
        usage: { inputTokens: 1001, outputTokens: 30, totalTokens: 1031 }, modelInfo: { provider: 'llama-cpp', model: 'synthetic-model' }, messageId: 101 },
      n9: { id: 'n9', parent: 'n6', input: 'Ввод 2.', text: '2026-08-02 20:02\n\nСцена 2.', time: '2026-08-02 20:02', truncated: false, delivery: 'sent',
        usage: { inputTokens: 1002, outputTokens: 30, totalTokens: 1032 }, modelInfo: { provider: 'llama-cpp', model: 'synthetic-model' }, messageId: 102 },
      n12: { id: 'n12', parent: 'n9', input: 'Ввод 3.', text: '2026-08-02 20:03\n\nСцена 3.', time: '2026-08-02 20:03', truncated: false, delivery: 'pending',
        usage: { inputTokens: 1003, outputTokens: 30, totalTokens: 1033 }, modelInfo: { provider: 'llama-cpp', model: 'synthetic-model' } },
    },
    memories: { m15: { id: 'm15', parent: null, cutoff: 'n9', covered: ['n6', 'n9'],
      delta: { facts: [{ kind: 'event', at: '2026-08-02 20:01', text: 'Смотритель передал ключ.', source: ['n6'] }] },
      method: 'plain', usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } } },
  } },
  active: { storyId: 'h2', branchId: 'b18' },
  job: { id: 'j20', storyId: 'h2', branchId: 'b18', head: 'n12', memory: 'm15', input: 'Продолжай.', started: 5000 },
  ui: null, seen: [7, 8, 9],
};
const payload = JSON.stringify(stored);

test('a stored v1 library is read and saved unchanged, and recovery only marks its pending job', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare('INSERT INTO libraries VALUES (?, ?)').run('1', payload);
  assert.equal(JSON.stringify(store.read('1')), payload);
  store.mutate('1', () => {});
  assert.equal(store.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get('1')!.payload, payload);
  store.recover();
  assert.deepEqual(store.read('1'), { ...structuredClone(stored), job: null, interrupted: true });
});

test('a library written before the language choice has no language, and a chosen one is stored with the library', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare('INSERT INTO libraries VALUES (?, ?)').run('1', payload);
  assert.equal(store.read('1').language, undefined);
  assert.equal(store.read('2').language, undefined);
  store.mutate('1', state => source.setLanguage(state, 'ja'));
  assert.deepEqual(store.read('1'), { ...structuredClone(stored), language: 'ja' });
});

// The same operations on a copy of the stored library: scenes, a checkpoint, compaction, a fork and deletions.
// Each result or expected rejection is recorded with the state after it.
function exercise(domain: typeof source) {
  const state: Library = JSON.parse(payload);
  const results: unknown[] = [];
  const keep = (value: unknown) => { results.push(structuredClone({ value, state })); };
  const reject = (operation: () => unknown) => {
    try { operation(); } catch (error) { keep({ userError: error instanceof domain.UserError, error: String(error), key: (error as { key?: string }).key }); return; }
    assert.fail('the operation should be rejected');
  };
  const { story, branch, seed } = domain.active(state);
  keep(['2026-08-02 20:04', '2024-02-29 23:59', '2026-02-29 20:04', '2026-13-01 20:04', '2026-08-02 24:00', '206-08-02 20:04', '20:04']
    .map(time => domain.validTime(time)));
  keep(domain.history(story, branch.head));
  keep(domain.context(story, branch));
  keep([domain.jobTarget(state, 'j20'), domain.jobTarget(state, 'j0')]);
  reject(() => domain.beginJob(state, 'Ещё раз.', 6000));
  reject(() => domain.commitTurn(state, 'j20', 'Без даты.\n\nСцена 4.'));
  keep(domain.commitTurn(state, 'j20', '2026-08-02 20:04\n\nСцена 4.'));
  keep(domain.saveCheckpoint(state, story, branch, 'Сцена 4', 'scene'));
  const job = domain.beginJob(state, 'Продолжай.', 7000);
  reject(() => domain.commitMemory(state, job.id, ['n9'], { facts: [] }));
  keep(domain.commitMemory(state, job.id, ['n12'], { facts: [{ kind: 'event', at: '2026-08-02 20:03', text: 'Ключ спрятан.', source: ['n12'] }] }));
  keep(domain.memoryChain(story, branch.memory));
  state.job = null;
  keep(domain.fork(state, story.id, 'c16'));
  reject(() => domain.addSeed(state, 'Без даты'));
  keep(domain.newStory(state, domain.addSeed(state, 'Порт\n2026-08-03 09:00\nСинтетическая гавань.').id));
  keep(domain.deleteBranch(state, story.id, branch.id));
  reject(() => domain.deleteBranch(state, story.id, branch.id));
  keep(domain.deleteSeed(state, seed.id));
  reject(() => domain.deleteSeed(state, seed.id));
  // Names in another interface language are stored as given; the defaults above are the Russian ones.
  const labels = { firstBranch: 'Start', seedCheckpoint: 'Seed', forkBranch: (from: string) => `From ${from}`, forkCheckpoint: 'Fork point', afterCompaction: 'After' };
  const harbour = domain.newStory(state, domain.addSeed(state, 'Harbour\n2026-08-03 09:00\nA synthetic harbour.').id, labels);
  keep(domain.fork(state, harbour.story.id, Object.keys(harbour.story.checkpoints)[0], labels));
  keep(domain.setLanguage(state, 'en'));
  keep([domain.emptyLibrary(), domain.id(state, 'x')]);
  return { results, state };
}

test('the generated cloud domain behaves like lib/library.ts on a stored v1 library', () => {
  assert.notEqual(artifact.UserError, source.UserError);
  assert.deepEqual(exercise(artifact), exercise(source));
});
