import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStoryLanguage, narration, seedLanguage } from './story-text.ts';
import type { StoryLang } from './story-text.ts';
import { makeRequest } from './prompt.ts';
import { summaryRequest } from './memory.ts';
import { Store } from './store.ts';
import { addSeed, newStory, beginJob, commitTurn, active } from '../lib/library.ts';

const LANGS: StoryLang[] = ['ru', 'en', 'zh', 'ko', 'ja'];

test('the script of the seed names the language, and a foreign name does not change it', () => {
  assert.equal(detectStoryLanguage('Маяк\nСмотритель зажёг лампу.'), 'ru');
  assert.equal(detectStoryLanguage('The lighthouse\nThe keeper lit the lamp.'), 'en');
  assert.equal(detectStoryLanguage('灯塔\n守塔人点亮了灯。'), 'zh');
  assert.equal(detectStoryLanguage('灯台\n守り手はランプをつけた。'), 'ja');
  assert.equal(detectStoryLanguage('등대\n관리인은 등을 켰다.'), 'ko');
  // A quotation or a name in another script is outnumbered by the rest of the seed.
  assert.equal(detectStoryLanguage('Маяк Sea Star\nСмотритель зажёг лампу и записал в журнал 灯 на память.'), 'ru');
  assert.equal(detectStoryLanguage('The lighthouse\nThe keeper, Вера, lit the lamp.'), 'en');
  // Kana next to Han is Japanese; Han alone is Chinese.
  assert.equal(detectStoryLanguage('灯台の話\n守塔人点亮了灯'), 'ja');
  // A seed without letters at all is narrated from the English catalog, which follows the seed's own language.
  assert.equal(detectStoryLanguage('2026 — 12:00 …'), 'en');
});

test('every catalog keeps the machine-readable parts of the rules', () => {
  const keys = Object.keys(narration('ru'));
  for (const lang of LANGS) {
    const n = narration(lang);
    assert.deepEqual(Object.keys(n), keys, lang);
    for (const [key, value] of Object.entries(n)) {
      if (typeof value === 'string') assert.ok(value.trim().length > 0, `${lang}.${key}`);
    }
    // The scene format, the JSON schema and the names of the fields the model is given are not translated.
    assert.match(n.system, /YYYY-MM-DD HH:MM/, lang);
    assert.match(n.system, /Markdown/, lang);
    assert.match(n.system, /08:08/, lang);
    assert.match(n.summaryRules, /newScenes/, lang);
    assert.match(n.summaryRules, /"kind":"event\|state\|knowledge\|relationship\|promise\|directive\|uncertainty"/, lang);
    assert.match(n.summaryRules, /"at"/, lang);
    assert.match(n.summaryRules, /"text"/, lang);
    assert.match(n.summaryRules, /"source"/, lang);
    assert.match(n.supplementRules(7), /draftFacts/, lang);
    assert.match(n.supplementRules(7), /precedingScenes/, lang);
    assert.match(n.supplementRules(7), /\b7\b/, lang);
    assert.match(n.sgrRules, /evidence/, lang);
    assert.match(n.sgrRules, /conflicts/, lang);
    assert.match(n.sgrRules, /author_priority/, lang);
    assert.match(n.sgrRules, /unresolved/, lang);
    assert.match(n.sgrRules, /e1, e2/, lang);
    // A status is a prefix of a stored fact, so it ends with its own separator.
    for (const label of Object.values(n.statusLabels)) assert.match(label, /[:：]\s?$/, lang);
    assert.match(n.seed('T', '2026-08-02 10:00', 'B'), /T[\s\S]*2026-08-02 10:00[\s\S]*B/, lang);
    assert.match(n.increment(2, 'n1, n2'), /2[\s\S]*n1, n2/, lang);
    assert.match(n.sources('n1'), /n1/, lang);
    assert.match(n.lastMessage('2026-08-02 10:00', 'MOVE'), /2026-08-02 10:00[\s\S]*MOVE/, lang);
  }
});

test('the Russian catalog is the measured production text', () => {
  const n = narration('ru');
  assert.ok(n.system.startsWith('Ты соавтор интерактивной истории.'));
  assert.ok(n.narratorRule.startsWith('Правило рассказчика: сообщение выше задаёт действие и слова'));
  assert.ok(n.summaryRules.startsWith('Извлеки инкремент памяти только из newScenes.'));
  assert.equal(n.startStory, 'Начни историю из сида. Покажи первую сцену.');
  assert.equal(n.continueStory, 'Продолжай историю самостоятельно с текущего места.');
  assert.equal(n.seed('Маяк', '2026-08-02 10:00', 'Текст.'), 'СИД: Маяк\nНачало: 2026-08-02 10:00\nТекст.');
});

function story(seed: string) {
  const store = new Store(':memory:');
  store.mutate('u', state => newStory(state, addSeed(state, seed).id));
  store.mutate('u', state => {
    const job = beginJob(state, 'turn', 0);
    commitTurn(state, job.id, '2026-08-02 10:01\nScene.');
  });
  const state = store.read('u');
  store.close();
  const { story: current, branch } = active(state);
  return { state, target: { seed: state.seeds[current.seedId], story: current, branch },
    point: { storyId: current.id, head: branch.head, memory: branch.memory, input: 'next' },
    nodes: Object.values(current.nodes).map(({ id, input, text }) => ({ id, input, text })) };
}

test('the narrator and the memory read the language of the seed, not of the interface', () => {
  const korean = story('등대\n2026-08-02 10:00\n관리인이 등을 켠다.');
  const russian = story('Маяк\n2026-08-02 10:00\nСмотритель зажигает лампу.');
  const scene = makeRequest(korean.state, korean.point, 4096);
  assert.equal(scene.system, narration('ko').system);
  assert.ok(scene.messages.at(-1)!.content.endsWith(narration('ko').narratorRule));
  assert.match(scene.messages[0].content, /^시드: 등대/);
  assert.equal(summaryRequest(korean.target, korean.nodes, 'plain').system, narration('ko').summaryRules);
  assert.equal(summaryRequest(korean.target, korean.nodes, 'sgr').system, narration('ko').sgrRules);
  // The Russian story keeps the production prompt unchanged.
  assert.equal(makeRequest(russian.state, russian.point, 4096).system, narration('ru').system);
  assert.equal(summaryRequest(russian.target, russian.nodes, 'plain').system, narration('ru').summaryRules);
  assert.equal(seedLanguage(russian.target.seed), 'ru');
});
