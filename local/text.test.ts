import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Language, Library, SceneNode } from '../lib/library.ts';
import { contextStats } from './context.ts';
import { renderCompaction } from './compact-view.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { GpuStatus } from './gpu.ts';
import { OWN_NAME_CHARS, OWN_STYLE_CHARS, OWN_STYLES_MAX, PROMPT_CHARS } from './picture-style.ts';
import type { Screen } from './telegram.ts';
import { LANGS, LANGUAGE_BUTTON, REGISTERED, commandSets, isRegistered, langFromTelegram, shownLang, texts } from './text.ts';
import type { Lang } from './text.ts';
import type { RenderDetails } from './ui.ts';
import { LIMIT, render, renderContext, scenePrefix, sceneKeyboard } from './ui.ts';

const CYRILLIC = /[Ѐ-ӿ]/;
const config = { model: 'synthetic-model', provider: 'llama-cpp', maxOutputTokens: 4096, contextTokens: 65536, compactAtTokens: 54000, keepScenes: 4 };

function node(id: string, parent: string | null, time: string, body: string, input = 'Look around'): SceneNode {
  return { id, parent, input, text: `${time}\n\n${body}`, time, truncated: false, delivery: 'sent' };
}

// A synthetic library in Latin script, with the labels the bot would have stored in that language.
function library(lang: Lang | undefined): Library {
  const l = texts(lang ?? 'en').labels;
  return {
    version: 1, seq: 14, ...(lang ? { language: lang } : {}),
    seeds: {
      s1: { id: 's1', title: 'Lighthouse', startTime: '2026-08-02 20:00', text: 'A northern island. Mira keeps the light.' },
      s12: { id: 's12', title: 'Empty seed', startTime: '2026-08-02 20:00', text: 'Nothing started here.' },
    },
    stories: {
      h2: {
        id: 'h2', seedId: 's1', title: 'Lighthouse',
        branches: {
          b3: { id: 'b3', name: l.firstBranch, head: 'n6', memory: null },
          b8: { id: 'b8', name: l.forkBranch(l.scene(1)), head: 'n9', memory: null },
        },
        checkpoints: {
          c4: { id: 'c4', branchId: 'b3', label: l.seedCheckpoint, kind: 'start', head: null, memory: null },
          c5: { id: 'c5', branchId: 'b3', label: l.scene(1), kind: 'scene', head: 'n5', memory: null },
          c7: { id: 'c7', branchId: 'b3', label: l.scene(2), kind: 'scene', head: 'n6', memory: null },
          c10: { id: 'c10', branchId: 'b8', label: l.forkCheckpoint, kind: 'fork', head: 'n5', memory: null },
          c11: { id: 'c11', branchId: 'b8', label: l.scene(2), kind: 'scene', head: 'n9', memory: null },
          c13: { id: 'c13', branchId: 'b3', label: l.afterCompaction, kind: 'compaction', head: 'n5', memory: null },
          c14: { id: 'c14', branchId: 'b3', label: 'My mark', kind: 'manual', head: 'n6', memory: null },
        },
        nodes: {
          n5: node('n5', null, '2026-08-02 20:00', 'Wind beats on the glass.'),
          n6: { ...node('n6', 'n5', '2026-08-02 20:30', 'The boat is empty.'), truncated: true, usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 } },
          n9: node('n9', 'n5', '2026-08-02 20:40', 'The fire goes out.', ''),
        },
        memories: {},
      },
    },
    active: { storyId: 'h2', branchId: 'b3' },
    job: null, ui: null, seen: [],
  };
}

const job = (kind?: 'compact') => ({ id: 'j20', storyId: 'h2', branchId: 'b3', head: 'n6', memory: null, input: 'x', started: 0, ...(kind ? { kind } : {}) }) satisfies Job;
const GPU_STATUSES: (GpuStatus | undefined)[] = ['ready', 'draining', 'stopping', 'paused', 'starting', 'error', undefined];
const PROVIDERS = ['claude-code', 'llama-cpp', 'codex-cli', 'openai-compatible', 'simple-serving'];
const MODEL_STATUSES = ['ready', 'unavailable', 'configured', 'other'];

// One of the reader's own picture styles, in the same script as the rest of the library.
const OWN = { id: 'y20', name: 'Candle oil', line: 'Oil painting with visible impasto brushstrokes, warm candlelight and deep shadows.' };

// Every screen the interface can produce for one language: [what it is, the screen].
function screens(lang: Lang | undefined): [string, Screen][] {
  const out: [string, Screen][] = [];
  const states: [string, Library][] = [
    ['idle', library(lang)],
    ['scene job', { ...library(lang), job: job() }],
    ['compact job', { ...library(lang), job: job('compact') }],
    ['empty', { ...library(lang), seeds: {}, stories: {}, active: null }],
    ['no active', { ...library(lang), active: null }],
    ['draft', { ...library(lang), ui: { input: 'seed', draftId: 'd15', parts: ['Lighthouse', '2026-08-02 20:00\nAn island.'] } }],
    ['own style', { ...library(lang), pictureStyles: { y20: OWN }, pictureStyle: 'y20' }],
    ['full library', { ...library(lang), pictureStyles: Object.fromEntries(Array.from({ length: OWN_STYLES_MAX }, (_, n) => [`y${30 + n}`, { ...OWN, id: `y${30 + n}` }])) }],
    ['new style', { ...library(lang), ui: { input: 'style' } }],
    ['style edit', { ...library(lang), pictureStyles: { y20: OWN }, ui: { input: 'style', styleId: 'y20' } }],
    ['style edit of a deleted style', { ...library(lang), ui: { input: 'style', styleId: 'y404' } }],
    ['prompt input', { ...library(lang), ui: { input: 'prompt', storyId: 'h2', nodeId: 'n6' } }],
  ];
  for (const [name, state] of states) {
    const details = (route: string): RenderDetails => {
      const [kind, storyId, checkpointId] = route.split(':');
      let stats = null;
      try { if (kind === 'context') stats = contextStats(state, config, checkpointId ? { storyId, checkpointId } : undefined); } catch {}
      return { contextStats: stats, modelInfo: { provider: 'llama-cpp', model: 'synthetic-model', status: 'ready', checkedAt: '2026-09-16T10:05:00Z' },
        gpuInfo: { status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: 400, canStart: false, canPause: true },
        pictures: true, standardStyle: 'A synthetic standard line of an owner.' };
    };
    // Crawl what the buttons reach, and add the routes no button leads to in this state.
    const queue = ['home', 'new-seed', 'model', 'language', 'nonsense', 'seed:s404', 'story:h404', 'tree:h404', 'log:h2:b404:0', 'branch:h2:b404',
      'checkpoints:h2:b404:0', 'checkpoint:h2:c404', 'context:h2:c404', 'delete-seed:s404', 'delete-branch:h2:b404', 'delete-seed:s12', 'delete-branch:h2:b8',
      'style-input', 'style:y404', 'delete-style:y404', 'delete-style:y20', 'sample:film', 'sample:standard', 'sample:y20', 'prompt-input'];
    const seen = new Set<string>();
    while (queue.length) {
      const route = queue.shift()!;
      if (seen.has(route)) continue;
      seen.add(route);
      const screen = render(state, route, details(route));
      out.push([`${name}: ${route}`, screen]);
      for (const button of screen.reply_markup?.inline_keyboard.flat() ?? []) if (button.callback_data.startsWith('view:')) queue.push(button.callback_data.slice(5));
    }
    out.push([`${name}: context without stats`, render(state, 'context')]);
    // The picker of a reader who is not drawn for, and a card with the standard line being one of the presets.
    out.push([`${name}: style without pictures`, render(state, 'style')], [`${name}: style card without pictures`, render(state, 'style:film')]);
    const keyboard = sceneKeyboard(state);
    if (keyboard) out.push([`${name}: scene keyboard`, { text: '-', reply_markup: keyboard }]);
  }
  // The only branch of a story, which takes the story with it.
  const single = library(lang);
  delete single.stories.h2.branches.b8;
  out.push(['single branch', render(single, 'delete-branch:h2:b3')]);
  const state = library(lang);
  for (const status of GPU_STATUSES) for (const activeJobs of [null, 2]) for (const idleRemainingSeconds of [30, 400]) {
    const gpuInfo = { status, activeJobs, idleMinutes: 15, idleRemainingSeconds, canStart: true, canPause: true };
    for (const route of ['home', 'model']) out.push([`gpu ${status}: ${route}`, render(state, route, { gpuInfo, modelInfo: { provider: 'llama-cpp', model: 'm' } })]);
  }
  for (const provider of PROVIDERS) for (const status of MODEL_STATUSES) for (const checkedAt of ['2026-09-16T10:05:00Z', null]) {
    for (const route of ['home', 'model']) out.push([`model ${provider} ${status}: ${route}`, render(state, route, { modelInfo: { provider, model: 'synthetic-model', status, checkedAt } })]);
  }
  out.push(['model unknown', render(state, 'model')]);
  const stats = contextStats(state, config);
  out.push(['renderContext', renderContext(stats, lang)], ['renderContext empty', renderContext(null, lang)]);
  out.push(['context unknown numbers', renderContext({ ...stats, limitTokens: NaN, lastRequest: null, request: { ...stats.request, estimatedTokens: NaN }, budget: { ...stats.budget, inputTokens: NaN, remainingTokens: 0 } }, lang)]);
  for (const estimateSource of ['usage', 'bytes']) for (const estimatedTokens of [100, 30000]) {
    out.push(['scene prefix', { text: scenePrefix({ ...stats, request: { ...stats.request, estimatedTokens, estimateSource } }, { provider: 'llama-cpp', model: 'synthetic-model' }, lang) }]);
  }
  const compactions: CompactionStatus[] = [
    ...(['queued', 'extracting', 'validating', 'saving'] as const).flatMap(stage => [
      { stage, scenes: 12, keptScenes: 4, outputCharacters: 12345, elapsedMs: 75_000 },
      { stage, automatic: true, scenes: 1, repairScenes: 2, outputCharacters: 1, elapsedMs: 4_000_000 },
    ]),
    { stage: 'queued', automatic: true, scenes: 3, ahead: 2 },
    { stage: 'done', scenes: 12, keptScenes: 4, facts: 30, repairScenes: 2, elapsedMs: 9000, automatic: true }, { stage: 'done' }, { stage: 'done', scenes: 3 }, { stage: 'done', facts: 3 },
    ...Object.keys(texts('ru').compact.reasons).map(reason => ({ stage: 'failed' as const, reason, elapsedMs: 1000 })),
    { stage: 'failed', reason: 'unlisted' }, { stage: 'cancelled', automatic: true }, {},
  ];
  for (const status of compactions) out.push([`compaction ${status.stage}`, renderCompaction(status, lang)]);
  return out;
}

for (const lang of [undefined, ...REGISTERED]) {
  test(`every screen in ${lang ?? 'a library without a language'} is a valid payload`, () => {
    const t = texts(lang);
    const all = screens(lang);
    assert.ok(all.length > 150, 'the crawl reaches the whole interface');
    for (const [name, screen] of all) {
      assert.equal(typeof screen.text, 'string', name);
      assert.ok(screen.text.length > 0 && screen.text.length <= LIMIT, `${name}: ${screen.text.length} characters`);
      // render() answers an exception with this screen instead of throwing.
      assert.ok(!screen.text.startsWith(t.common.failure), `${name} failed to render`);
      assert.doesNotMatch(screen.text, /undefined|\[object|NaN/, name);
      for (const button of screen.reply_markup?.inline_keyboard.flat() ?? []) {
        assert.ok(button.text.trim().length > 0, `${name}: empty label for ${button.callback_data}`);
        assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, `${name}: ${button.callback_data}`);
      }
    }
  });
}

test('the English interface has no Cyrillic apart from the name of Russian in the language picker', () => {
  for (const [name, screen] of screens('en')) {
    assert.doesNotMatch(screen.text, CYRILLIC, name);
    for (const button of screen.reply_markup?.inline_keyboard.flat() ?? []) {
      if (button.callback_data !== 'lang:ru') assert.doesNotMatch(button.text, CYRILLIC, `${name}: ${button.callback_data}`);
    }
  }
  for (const set of commandSets(true).filter(set => set.language_code !== 'ru')) {
    for (const { description } of set.commands) assert.doesNotMatch(description, CYRILLIC);
  }
});

test('a library without a language is Russian, an unregistered language is English, and anything else is Russian', () => {
  assert.equal(texts(undefined), texts('ru'));
  assert.equal(texts(null), texts('ru'));
  assert.equal(texts('constructor'), texts('ru'));
  assert.equal(texts(7), texts('ru'));
  assert.notEqual(texts('en'), texts('ru'));
  for (const lang of Object.keys(LANGS)) {
    assert.equal(texts(lang), texts(isRegistered(lang) ? lang : 'en'), lang);
    assert.equal(shownLang(lang), isRegistered(lang) ? lang : 'en', lang);
  }
  assert.match(render(library(undefined), 'home').text, /🏠 Меню/);
  assert.match(render({ ...library(undefined), language: 'xx' as Language }, 'home').text, /🏠 Меню/);
  assert.match(render(library('en'), 'home').text, /🏠 Menu/);
});

test('the language picker lists registered languages by their own names and marks the shown one', () => {
  for (const lang of [undefined, ...REGISTERED]) {
    const buttons = render(library(lang), 'language').reply_markup!.inline_keyboard.flat();
    const choices = buttons.filter(button => button.callback_data.startsWith('lang:'));
    assert.deepEqual(choices.map(button => button.callback_data), REGISTERED.map(code => `lang:${code}`));
    for (const button of choices) {
      const code = button.callback_data.slice(5) as Lang;
      assert.equal(button.text, `${code === (lang ?? 'ru') ? '✅ ' : ''}${LANGS[code]}`);
    }
    // The way to the picker reads the same in every language.
    assert.ok(render(library(lang), 'home').reply_markup!.inline_keyboard.flat().some(button => button.text === LANGUAGE_BUTTON && button.callback_data === 'view:language'));
  }
});

test('Telegram language codes map to interface languages, and everything else to English', () => {
  const cases: [string | undefined, Lang][] = [
    ['ru', 'ru'], ['ru-RU', 'ru'], ['RU', 'ru'], ['zh', 'zh'], ['zh-hans', 'zh'], ['zh_TW', 'zh'], ['ko', 'ko'], ['ko-KR', 'ko'], ['ja', 'ja'], ['ja-JP', 'ja'],
    ['en', 'en'], ['en-GB', 'en'], ['uk', 'en'], ['de', 'en'], ['rue', 'en'], ['', 'en'], [undefined, 'en'],
  ];
  for (const [code, lang] of cases) assert.equal(langFromTelegram(code), lang, String(code));
  assert.equal(langFromTelegram(7 as unknown as string), 'en');
});

test('command lists: English by default, then one per registered language, GPU commands only with a GPU', () => {
  const sets = commandSets(false);
  assert.deepEqual(sets.map(set => set.language_code), [undefined, ...REGISTERED]);
  assert.deepEqual(sets[0].commands, commandSets(false).find(set => set.language_code === 'en')!.commands);
  for (const set of [...sets, ...commandSets(true)]) {
    for (const { command, description } of set.commands) {
      assert.match(command, /^[a-z_]{1,32}$/);
      assert.ok(description.length >= 1 && description.length <= 256, command);
    }
  }
  assert.ok(sets[0].commands.some(item => item.command === 'language'));
  assert.ok(!sets[0].commands.some(item => item.command.startsWith('gpu_')));
  assert.deepEqual(commandSets(true)[0].commands.filter(item => item.command.startsWith('gpu_')).map(item => item.command), ['gpu_pause', 'gpu_start']);
  // /style is listed only where pictures are drawn at all.
  assert.ok(!sets.some(set => set.commands.some(item => item.command === 'style')));
  for (const set of commandSets(false, true)) assert.ok(set.commands.some(item => item.command === 'style'), String(set.language_code));
});

test('the style and prompt texts name the limits the code keeps', () => {
  for (const lang of REGISTERED) {
    const t = texts(lang);
    assert.match(t.errors.styleTooLong, new RegExp(`\\b${OWN_STYLE_CHARS}\\b`), lang);
    assert.match(t.errors.stylesFull, new RegExp(`\\b${OWN_STYLES_MAX}\\b`), lang);
    const note = t.pictureStyle.inputNote(OWN_STYLE_CHARS, OWN_NAME_CHARS);
    assert.ok(note.includes(String(OWN_STYLE_CHARS)) && note.includes(String(OWN_NAME_CHARS)), lang);
    assert.ok(t.pictureStyle.editNote(OWN_STYLE_CHARS).includes(String(OWN_STYLE_CHARS)), lang);
    assert.match(t.errors.promptTooLong, new RegExp(`\\b${PROMPT_CHARS}\\b`), lang);
    assert.ok(t.variant.note(PROMPT_CHARS).includes(String(PROMPT_CHARS)), lang);
    // The example is a style as a reader would send it: a name, then the line in English.
    const [name, line, ...rest] = t.pictureStyle.exampleText.split('\n');
    assert.ok(name && [...name].length <= OWN_NAME_CHARS && line && [...line].length <= OWN_STYLE_CHARS && !rest.length, lang);
    assert.doesNotMatch(line, /[^\x20-\x7e]/, lang);
  }
});

// tsc already rejects a catalog with other keys; this also holds a catalog to the same kind of value and arity.
test('every catalog has the keys of the Russian one, with strings for strings and functions of the same arity', () => {
  const shape = (value: unknown, path: string, out: Map<string, string>) => {
    if (typeof value === 'string') { assert.ok(value.length > 0, `${path} is empty`); out.set(path, 'string'); }
    else if (typeof value === 'function') out.set(path, `function/${value.length}`);
    else {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} is neither text nor a group`);
      for (const [key, child] of Object.entries(value)) shape(child, path ? `${path}.${key}` : key, out);
    }
    return out;
  };
  const expected = shape(texts('ru'), '', new Map());
  assert.ok(expected.size > 300);
  for (const lang of REGISTERED) {
    const actual = shape(texts(lang), '', new Map());
    assert.deepEqual([...actual.keys()].filter(key => !expected.has(key)), [], `${lang} has extra keys`);
    for (const [path, kind] of expected) assert.equal(actual.get(path), kind, `${lang}: ${path}`);
  }
});

test('emoji that code, tests and users rely on stay at the start of their entries in every language', () => {
  for (const lang of REGISTERED) {
    const t = texts(lang);
    for (const text of [t.compact.title, t.compact.titleAutomatic, t.context.compactNote(4), t.buttons.compactNow]) assert.ok(text.startsWith('🗜'), `${lang}: ${text}`);
    for (const text of [t.context.title, t.context.titleOf('x'), t.context.none, t.context.currentBranch, t.buttons.context]) assert.ok(text.startsWith('📏'), `${lang}: ${text}`);
    assert.ok(t.compact.done(null).startsWith('✅') && t.compact.failed(null).startsWith('⚠️') && t.compact.cancelled(null).startsWith('✖️'), lang);
    assert.match(t.newSeed.example.split('\n')[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, lang);
    assert.equal(t.newSeed.example.split('\n').length, 3, lang);
    // The scene header is sent as Markdown.
    for (const text of [t.scenePrefix.context(12, true), t.scenePrefix.contextBelowOne(true), ...Object.values(t.model.providers).map(provider => provider.short)]) {
      assert.doesNotMatch(text, /[_*`\[\]()~>#+=|{}.!\\-]/, `${lang}: ${text}`);
    }
  }
});
