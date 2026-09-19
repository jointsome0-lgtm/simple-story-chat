// The language of a story: what the narrator and the memory read and write. It is not the interface language of
// text.ts — a user whose menus are Korean can write a Russian seed and gets Russian scenes, and the other way round.
// The seed decides, because the seed is the story's own text; the catalogs live in local/story-text/.

import { ru } from './story-text/ru.ts';
import type { Narration } from './story-text/ru.ts';
import { en } from './story-text/en.ts';
import { zh } from './story-text/zh.ts';
import { ko } from './story-text/ko.ts';
import { ja } from './story-text/ja.ts';

export type { Narration };
export type StoryLang = 'ru' | 'en' | 'zh' | 'ko' | 'ja';

// REGISTER A LANGUAGE HERE: add its catalog. A seed whose script is not one of these is narrated from the English
// catalog, which tells the narrator to follow the language of the seed.
const CATALOGS: Record<StoryLang, Narration> = { ru, en, zh, ko, ja };

export const narration = (lang: StoryLang): Narration => CATALOGS[lang];

// Title and body together: a title alone is too short to name a script.
export const seedLanguage = (seed: { title: string; text: string }): StoryLang =>
  detectStoryLanguage(`${seed.title}\n${seed.text}`);
export const seedNarration = (seed: { title: string; text: string }): Narration => narration(seedLanguage(seed));

// The script of the seed names the language: Cyrillic is Russian, Hangul Korean, kana Japanese, Han without kana
// Chinese. Everything else, every other Latin-script language included, falls back to English.
// Counting decides, so a quoted name or a term in another script does not change the language of a whole seed.
export function detectStoryLanguage(text: string): StoryLang {
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length;
  const cyrillic = count(/\p{Script=Cyrillic}/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const kana = count(/\p{Script=Hiragana}|\p{Script=Katakana}/gu);
  const han = count(/\p{Script=Han}/gu);
  const latin = count(/\p{Script=Latin}/gu);
  // Japanese writes kana together with Han; Han alone is Chinese.
  const scores: [StoryLang, number][] = [['ru', cyrillic], ['ko', hangul],
    ['ja', kana ? kana + han : 0], ['zh', kana ? 0 : han], ['en', latin]];
  let best: StoryLang = 'en';
  let most = 0;
  for (const [lang, score] of scores) if (score > most) { best = lang; most = score; }
  return best;
}
