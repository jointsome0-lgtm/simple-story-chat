// Interface language of the bot: what the bot itself says. Stories, prompts and stored labels are not translated.
// Catalogs live in local/text/; ru.ts defines the shape (`Messages`) and tsc rejects a language that differs from it.

import { ru } from './text/ru.ts';
import type { Messages } from './text/ru.ts';
import { en } from './text/en.ts';

export type { Messages };
export type Lang = 'ru' | 'en' | 'zh' | 'ko' | 'ja';
// Each language under its own name, in the order of the picker.
export const LANGS: Record<Lang, string> = { ru: 'Русский', en: 'English', zh: '中文', ko: '한국어', ja: '日本語' };
// The same in every language, so that a user in a wrong language still finds it.
export const LANGUAGE_BUTTON = '🌐 Language';

// REGISTER A LANGUAGE HERE: import its catalog above and add it to this map. Nothing else needs to change.
// A language of `Lang` that is not in the map yet is shown in English.
const CATALOGS: Partial<Record<Lang, Messages>> = { ru, en };

export const REGISTERED: Lang[] = (Object.keys(LANGS) as Lang[]).filter(lang => CATALOGS[lang]);
export const isRegistered = (lang: unknown): lang is Lang => (REGISTERED as unknown[]).includes(lang);

// The language a stored value is shown in. A library without a language predates the choice and belongs to a
// Russian-speaking user; so does anything that is not a language at all.
export function shownLang(lang: unknown): Lang {
  if (typeof lang !== 'string' || !Object.hasOwn(LANGS, lang)) return 'ru';
  return CATALOGS[lang as Lang] ? lang as Lang : 'en';
}

export function texts(lang: unknown): Messages {
  return CATALOGS[shownLang(lang)] ?? ru;
}

// Telegram sends an IETF language tag such as `ru`, `pt-br` or `zh-hans`, or nothing.
export function langFromTelegram(code: string | undefined): Lang {
  const primary = typeof code === 'string' ? code.toLowerCase().split(/[-_]/)[0] : '';
  return primary === 'ru' || primary === 'zh' || primary === 'ko' || primary === 'ja' ? primary : 'en';
}

const COMMANDS = ['menu', 'seeds', 'new', 'checkpoints', 'continue', 'last', 'context', 'compact', 'model', 'language', 'gpu_pause', 'gpu_start', 'cancel'] as const;

// Payloads for setMyCommands: the default list in English, then one list per registered language.
export function commandSets(gpu: boolean): { language_code?: Lang; commands: { command: string; description: string }[] }[] {
  const list = (t: Messages) => COMMANDS.filter(command => gpu || !command.startsWith('gpu_'))
    .map(command => ({ command, description: t.commands[command] }));
  return [{ commands: list(en) }, ...REGISTERED.map(lang => ({ language_code: lang, commands: list(texts(lang)) }))];
}
