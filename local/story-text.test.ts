import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStoryLanguage, narration, seedLanguage } from './story-text.ts';
import type { StoryLang } from './story-text.ts';
import { makeRequest } from './prompt.ts';
import { summaryRequest } from './memory.ts';
import { Store } from './store.ts';
import { addSeed, newStory, beginJob, commitTurn, active } from '../lib/library.ts';

const LANGS: StoryLang[] = ['ru', 'en', 'zh', 'ko', 'ja'];

// The scene format, the JSON schema and the names of the fields the model is given are not translated. The Russian
// catalog is the text the loop measured: its beginnings and its short inputs stay as they were.
test('every catalog keeps the machine-readable parts of the rules', () => {
  const keys = Object.keys(narration('ru'));
  for (const lang of LANGS) {
    const n = narration(lang);
    assert.deepEqual(Object.keys(n), keys, lang);
    for (const [key, value] of Object.entries(n)) if (typeof value === 'string') assert.ok(value.trim().length > 0, `${lang}.${key}`);
    const parts: [string, RegExp][] = [[n.system, /YYYY-MM-DD HH:MM/], [n.system, /Markdown/], [n.system, /08:08/],
      [n.summaryRules, /newScenes/], [n.summaryRules, /"kind":"event\|state\|knowledge\|relationship\|promise\|directive\|uncertainty"/],
      [n.summaryRules, /"at"/], [n.summaryRules, /"text"/], [n.summaryRules, /"source"/],
      [n.supplementRules(7), /draftFacts/], [n.supplementRules(7), /precedingScenes/], [n.supplementRules(7), /\b7\b/],
      [n.sgrRules, /evidence/], [n.sgrRules, /conflicts/], [n.sgrRules, /author_priority/], [n.sgrRules, /unresolved/], [n.sgrRules, /e1, e2/],
      // A status is a prefix of a stored fact, so it ends with its own separator.
      ...Object.values(n.statusLabels).map((label): [string, RegExp] => [label, /[:：]\s?$/]),
      [n.seed('T', '2026-08-02 10:00', 'B'), /T[\s\S]*2026-08-02 10:00[\s\S]*B/], [n.increment(2, 'n1, n2'), /2[\s\S]*n1, n2/],
      [n.sources('n1'), /n1/], [n.lastMessage('2026-08-02 10:00', 'MOVE'), /2026-08-02 10:00[\s\S]*MOVE/]];
    for (const [text, pattern] of parts) assert.match(text, pattern, `${lang}: ${pattern}`);
  }
  const ru = narration('ru');
  assert.ok(ru.system.startsWith('Ты соавтор интерактивной истории.'));
  assert.ok(ru.narratorRule.startsWith('Правило рассказчика: сообщение выше задаёт действие и слова'));
  assert.ok(ru.summaryRules.startsWith('Извлеки инкремент памяти только из newScenes.'));
  assert.deepEqual([ru.startStory, ru.continueStory, ru.seed('Маяк', '2026-08-02 10:00', 'Текст.')],
    ['Начни историю из сида. Покажи первую сцену.', 'Продолжай историю самостоятельно с текущего места.', 'СИД: Маяк\nНачало: 2026-08-02 10:00\nТекст.']);
});

function story(seed: string) {
  const store = new Store(':memory:');
  store.mutate('u', state => newStory(state, addSeed(state, seed).id));
  store.mutate('u', state => { commitTurn(state, beginJob(state, 'turn', 0).id, '2026-08-02 10:01\nScene.'); });
  const state = store.read('u');
  store.close();
  const { story: current, branch } = active(state);
  return { state, target: { seed: state.seeds[current.seedId], story: current, branch },
    point: { storyId: current.id, head: branch.head, memory: branch.memory, input: 'next' },
    nodes: Object.values(current.nodes).map(({ id, input, text }) => ({ id, input, text })) };
}
const SEEDS: Record<StoryLang, [string, string]> = { ru: ['Маяк', 'Смотритель зажёг лампу.'], en: ['The lighthouse', 'The keeper lit the lamp.'],
  zh: ['灯塔', '守塔人点亮了灯。'], ja: ['灯台', '守り手はランプをつけた。'], ko: ['등대', '관리인은 등을 켰다.'] };

// The script of the seed names the language, by count, so a quoted name or a term in another script does not change
// it. Every language's story is then narrated and remembered from its own catalog, whatever the interface speaks.
test('the narrator and the memory read the language of the seed, not of the interface', () => {
  for (const [seed, lang] of [['Маяк Sea Star\nСмотритель зажёг лампу и записал в журнал 灯 на память.', 'ru'],
    ['The lighthouse\nThe keeper, Вера, lit the lamp.', 'en'],
    ['灯台の話\n守塔人点亮了灯', 'ja'], // kana next to Han is Japanese; Han alone is Chinese
    ['2026 — 12:00 …', 'en'], // no letters: the English catalog, which follows the seed's own language
    ...LANGS.map((lang) => [SEEDS[lang].join('\n'), lang])]) assert.equal(detectStoryLanguage(seed), lang, seed);
  for (const lang of LANGS) {
    const n = narration(lang);
    const [title, text] = SEEDS[lang];
    const { state, target, point, nodes } = story(`${title}\n2026-08-02 10:00\n${text}`);
    assert.equal(seedLanguage(target.seed), lang);
    const scene = makeRequest(state, point, 4096);
    assert.equal(scene.system, n.system, lang);
    assert.equal(scene.messages[0].content, n.seed(title, '2026-08-02 10:00', text), lang);
    assert.ok(scene.messages.at(-1)!.content.endsWith(n.narratorRule), lang);
    assert.equal(summaryRequest(target, nodes, 'plain').system, n.summaryRules, lang);
    assert.equal(summaryRequest(target, nodes, 'sgr').system, n.sgrRules, lang);
  }
});
