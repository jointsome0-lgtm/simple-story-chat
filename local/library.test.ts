import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from '../lib/library.ts';
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
  // A library from before the language choice has none, like a new one, and a chosen language is stored with it.
  assert.equal(store.read('1').language, undefined);
  assert.equal(store.read('2').language, undefined);
  store.mutate('1', state => source.setLanguage(state, 'ja'));
  assert.deepEqual(store.read('1'), { ...structuredClone(stored), job: null, interrupted: true, language: 'ja' });
});

test('pictures are recorded as sent, and a deletion forgets those of its lost scenes and those too old to delete', () => {
  const state: Library = JSON.parse(payload);
  const hour = 60 * 60 * 1000;
  const now = 1_790_000_000_000;
  // The list is read through a call: an assertion narrows the field it names, and the calls below change it.
  const pictures = () => state.sentPictures;
  const ids = () => pictures()?.map(one => one.messageId);
  // A library that never had a picture gets no list from a deletion either.
  assert.deepEqual(source.forgetLostPictures(state, now), []);
  assert.equal(pictures(), undefined);
  // Scene 4 is written on b18 alone; n6 is on both branches.
  const { nodeId } = source.commitTurn(state, 'j20', '2026-08-02 20:04\n\nСцена 4.')!;
  const sent = (messageId: number, scene: string, at: number) => ({ storyId: 'h2', nodeId: scene, messageId, at });
  source.recordPicture(state, sent(1, 'n6', now - 50 * hour));
  source.recordPicture(state, sent(2, nodeId, now - 47 * hour));
  assert.deepEqual(ids(), [1, 2]);
  // Every record drops what Telegram would no longer delete by then.
  source.recordPicture(state, sent(3, 'n6', now - hour));
  source.recordPicture(state, sent(4, nodeId, now - hour / 2));
  // A portrait of one of the story's people shows no scene, and goes with the story alone.
  const portrait = { storyId: 'h2', messageId: 5, at: now - hour / 4 };
  source.recordPicture(state, portrait);
  assert.deepEqual(ids(), [2, 3, 4, 5]);
  // The branch takes scene 4 with it: its picture of half an hour ago is returned for the chat, the one from 48 hours
  // ago is only forgotten, and the picture of the shared scene stays, as does the portrait of the story that stays.
  source.deleteBranch(state, 'h2', 'b18');
  assert.deepEqual(source.forgetLostPictures(state, now + hour), [4]);
  assert.deepEqual(pictures(), [sent(3, 'n6', now - hour), portrait]);
  source.deleteSeed(state, 's1');
  assert.deepEqual(source.forgetLostPictures(state, now + hour), [3, 5]);
  assert.deepEqual(pictures(), []);
  // However many are sent within the 48 hours, the library keeps the newest thousand.
  for (let n = 0; n < source.SENT_PICTURES_MAX + 5; n++) source.recordPicture(state, sent(100 + n, 'n6', now + n));
  assert.equal(ids()?.length, source.SENT_PICTURES_MAX);
  assert.equal(ids()?.[0], 105);
});
