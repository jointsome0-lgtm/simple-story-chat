import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { Store } from './store.ts';
import { sheetAt } from './picture-versions.ts';

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

test('a stored v1 library is read and saved unchanged, and recovery only marks its pending job and keeps its move', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare('INSERT INTO libraries VALUES (?, ?)').run('1', payload);
  assert.equal(JSON.stringify(store.read('1')), payload);
  store.mutate('1', () => {});
  assert.equal(store.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get('1')!.payload, payload);
  const { id: job, storyId, branchId, head, input } = stored.job!;
  const recovered = { ...structuredClone(stored), job: null, jobInterrupted: true, lostMove: { storyId, branchId, head, job, input } };
  assert.deepEqual(store.recover(), ['1']);
  assert.deepEqual(store.read('1'), recovered);
  // A library from before the language choice has none, like a new one, and a chosen language is stored with it.
  assert.equal(store.read('1').language, undefined);
  assert.equal(store.read('2').language, undefined);
  store.mutate('1', state => source.setLanguage(state, 'ja'));
  assert.deepEqual(store.read('1'), { ...recovered, language: 'ja' });
});

// The versions of a person's look sit on the scenes (local/picture-versions.ts): nothing else holds them, so a save that
// dropped them, or a deleted branch that took those of scenes it shares with another, would lose them unnoticed.
test('versions of the people along a story are saved as they are, and a deleted branch takes only those of its own scenes', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const state: Library = JSON.parse(payload);
  const story = state.stories.h2;
  story.sheet = [{ name: 'Мира', description: 'Смотрительница с длинными русыми волосами.', look: 'young woman, long fair hair' }];
  // Scene 4 is written on b18 alone; n9 is on both branches.
  const { nodeId } = source.commitTurn(state, 'j20', '2026-08-02 20:04\n\nСцена 4.')!;
  story.nodes.n9.appearance = { 'Мира': { changes: ['шрам через левую бровь'], retold: { details: 'scar', look: 'young woman, scar', from: '0' } } };
  story.nodes[nodeId].appearance = { 'Мира': { changes: ['волосы коротко острижены'], look: 'short hair' } };
  store.db.prepare('INSERT INTO libraries VALUES (?, ?)').run('1', JSON.stringify(state));
  store.mutate('1', () => {});
  assert.deepEqual(store.read('1'), state);
  store.mutate('1', saved => source.deleteBranch(saved, 'h2', 'b18'));
  const kept = store.read('1').stories.h2;
  assert.equal(kept.nodes[nodeId], undefined);
  assert.deepEqual([kept.sheet, kept.nodes.n9.appearance], [story.sheet, story.nodes.n9.appearance]);
  assert.equal(sheetAt(kept, 'n12')[0].changes, 'шрам через левую бровь');
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

// A bookmark lives on a checkpoint (lib/library.ts `Checkpoint.bookmark`), so a deletion that took one with the wrong
// checkpoint, or left one whose scene it took, would go unnoticed. [what, the change, the bookmarks that stay]
test('a deletion takes exactly the bookmarks of the scenes no checkpoint names any more, and changes nothing else', () => {
  const library = (marked: boolean) => {
    const state: Library = JSON.parse(payload);
    const story = state.stories.h2;
    // Scene 4 is written on b18 alone, which forked at scene 3 with its memory; another seed has a story of its own.
    const { nodeId } = source.commitTurn(state, 'j20', '2026-08-02 20:04\n\nСцена 4.')!;
    const own = source.saveCheckpoint(state, story, story.branches.b18, 'Сцена 4', 'scene');
    const other = source.newStory(state, source.addSeed(state, 'Лес\n2026-08-03 10:00\nСинтетический лес.').id).story;
    other.nodes.n90 = { ...story.nodes.n6, id: 'n90' };
    const theirs = source.saveCheckpoint(state, other, Object.values(other.branches)[0], 'Сцена 1', 'scene');
    Object.values(other.branches)[0].head = theirs.head = 'n90';
    // Scene 1, which b18 has only as history; scene 3 at its checkpoint before the compaction, which b18 forked from
    // after it; scene 4; the other story's scene.
    if (marked) for (const [at, id, label] of [[story, 'c7', 'один'], [story, 'c13', 'три'], [story, own.id, 'четыре'], [other, theirs.id, 'лес']] as const) {
      assert.equal(source.addBookmark(at, id, label, 1).id, id);
    }
    // A scene already kept keeps its bookmark, from whichever of its checkpoints it is kept again.
    if (marked) assert.equal(source.addBookmark(story, 'c19', 'снова', 2).id, 'c13');
    return { state, own: own.id, other: other.id, theirs: theirs.id, nodeId };
  };
  const { own, other, theirs } = library(false);
  const kept = (state: Library) => Object.values(state.stories).flatMap(story => Object.values(story.checkpoints)
    .flatMap(cp => cp.bookmark ? [`${story.id}/${cp.id} ${cp.bookmark.label}`] : [])).sort();
  const rows: [string, (state: Library) => void, string[]][] = [
    ['nothing deleted', () => {}, ['h2/c13 три', 'h2/c7 один', `h2/${own} четыре`, `${other}/${theirs} лес`]],
    // Scene 3 stays at b18's fork with the memory of after the compaction, and its bookmark moves there; scene 1 stays
    // only as b18's history, which no screen opens, and its bookmark goes.
    ['the first branch', state => source.deleteBranch(state, 'h2', 'b3'), ['h2/c19 три', `h2/${own} четыре`, `${other}/${theirs} лес`]],
    ['the fork', state => source.deleteBranch(state, 'h2', 'b18'), ['h2/c13 три', 'h2/c7 один', `${other}/${theirs} лес`]],
    ['both branches, and with them the story', state => { source.deleteBranch(state, 'h2', 'b3'); source.deleteBranch(state, 'h2', 'b18'); },
      [`${other}/${theirs} лес`]],
    ['the seed', state => source.deleteSeed(state, 's1'), [`${other}/${theirs} лес`]],
    ['a bookmark taken away from another checkpoint of its scene', state => source.removeBookmark(state.stories.h2, 'c16'),
      ['h2/c7 один', `h2/${own} четыре`, `${other}/${theirs} лес`]],
  ];
  const strip = (state: Library) => JSON.stringify(state, (key, value) => key === 'bookmark' ? undefined : value);
  for (const [what, change, expected] of rows) {
    const marked = library(true).state, plain = library(false).state;
    change(marked);
    change(plain);
    assert.deepEqual(kept(marked), expected.sort(), what);
    // Apart from its bookmarks, the library is what the same change makes of it without any.
    assert.equal(strip(marked), strip(plain), what);
  }
});

// The store keeps a library whole, so a bookmark is saved and read back with it; and a build from before bookmarks
// (8d14c5c, whose local/store.ts is this one and reads only the version) finds the library it would have written
// itself, with one more field on a checkpoint that it keeps as it is.
test('bookmarks are saved and read back, and without them the stored library is the one a build before them wrote', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.prepare('INSERT INTO libraries VALUES (?, ?)').run('1', payload);
  store.mutate('1', state => source.addBookmark(state.stories.h2, 'c10', '«Маяк» · история 1 · ветка «Начало» · сцена 2 · 2026-08-02 20:02', 7));
  const saved = store.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get('1')!.payload as string;
  assert.deepEqual(store.read('1').stories.h2.checkpoints.c10.bookmark, { label: '«Маяк» · история 1 · ветка «Начало» · сцена 2 · 2026-08-02 20:02', at: 7 });
  assert.equal(JSON.parse(saved).version, 1);
  assert.equal(JSON.stringify(JSON.parse(saved), (key, value) => key === 'bookmark' ? undefined : value), payload);
  // Rolled back and written again by that build, which knows nothing of the field, and read here once more.
  store.db.prepare('UPDATE libraries SET payload = ? WHERE user_id = ?').run(JSON.stringify(JSON.parse(saved)), '1');
  store.mutate('1', () => {});
  assert.equal(store.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get('1')!.payload, saved);
  store.mutate('1', state => source.removeBookmark(state.stories.h2, 'c10'));
  assert.equal(store.db.prepare('SELECT payload FROM libraries WHERE user_id = ?').get('1')!.payload, payload);
});
