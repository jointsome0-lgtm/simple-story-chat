import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Library, SceneNode } from '../lib/library.ts';
import { addSeed, emptyLibrary } from '../lib/library.ts';
import { contextStats } from './context.ts';
import { renderCompaction } from './compact-view.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { GpuStatus } from './gpu.ts';
import { LOOK_CHARS, personTag } from './picture.ts';
import { OWN_NAME_CHARS, OWN_STYLE_CHARS, OWN_STYLES_MAX, PRESETS, PROMPT_CHARS } from './picture-style.ts';
import type { Screen } from './telegram.ts';
import { LANGS, LANGUAGE_BUTTON, REGISTERED, commandSets, langFromTelegram, texts } from './text.ts';
import type { Lang } from './text.ts';
import type { RenderDetails } from './ui.ts';
import { LIMIT, render, renderContext, scenePrefix, sceneKeyboard } from './ui.ts';

const CYRILLIC = /[Ѐ-ӿ]/;

// Every callback the bot acts on (local/bot.ts); it answers any other as a stale button.
const ACTION = /^(view:.+|new-seed|save-seed:[^:]+|start:[^:]+|use:[^:]+:[^:]+|fork:[^:]+:[^:]+|remove-seed:[^:]+|remove-branch:[^:]+:[^:]+|continue|cancel|last|compact|gpu:start|gpu:pause|lang:[a-z]{2}|style:[a-z0-9]+|style-new|style-edit:y\d+|remove-style:y\d+|style-sample:[a-z0-9]+|style-samples|look-edit:[^:]+:\d+:[0-9a-f]{8}|portrait:[^:]+:\d+:[0-9a-f]{8}|portrait-keep:[0-9a-f]+)$/;
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
// A story's people as its first picture writes them, and a library whose first scene dressed one of them otherwise.
const SHEET = [{ name: 'Mira', look: 'A tall woman in her forties, short grey hair, a scar on the left cheek.', outfit: 'wearing a dark wool coat' },
  { name: 'Oleg', look: 'A broad-shouldered man with a shaved head.', outfit: 'wearing a fisherman sweater' }, { name: 'Ora', look: 'An old woman.' }];
function drawn(lang: Lang | undefined): Library {
  const state = library(lang);
  state.stories.h2.sheet = SHEET;
  state.stories.h2.nodes.n5.clothes = { Mira: 'wearing a yellow raincoat' };
  return state;
}
// The same, with a portrait kept of the look as it is and one of an earlier look.
function portraits(lang: Lang | undefined): Library {
  const state = drawn(lang);
  const kept = { file: '0123456789abcdef0123456789abcdef.png', seed: 7, clothes: 'plain', style: 'neutral', graph: '0123456789abcdef',
    checkpoint: 'synthetic.safetensors', width: 720, height: 1280, steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', at: 1 };
  state.stories.h2.sheet = [{ ...SHEET[0], portrait: { ...kept, look: SHEET[0].look } }, { ...SHEET[1], portrait: { ...kept, look: 'Earlier.' } }, SHEET[2]];
  return state;
}

const callbacks = (screen: Screen) => (screen.reply_markup?.inline_keyboard.flat() ?? []).map(button => button.callback_data);

// Every screen the interface can produce for one language: [what it is, the screen]. For each state also the callbacks
// its buttons offer on the way from the menu, and all it offers anywhere.
function screens(lang: Lang | undefined) {
  const out: [string, Screen][] = [];
  const offered = new Map<string, [Set<string>, Set<string>]>();
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
    ['sheet', drawn(lang)],
    ['sheet of a story not played', { ...drawn(lang), active: null }],
    ['look edit', { ...drawn(lang), ui: { input: 'look', storyId: 'h2', name: 'Mira' } }],
    ['look edit of a lost person', { ...drawn(lang), ui: { input: 'look', storyId: 'h2', name: 'Nobody' } }],
    ['portraits', portraits(lang)],
  ];
  for (const [name, state] of states) {
    const details = (route: string): RenderDetails => {
      const [kind, storyId, checkpointId] = route.split(':');
      let stats = null;
      try { if (kind === 'context') stats = contextStats(state, config, checkpointId ? { storyId, checkpointId } : undefined); } catch {}
      return { contextStats: stats, modelInfo: { provider: 'llama-cpp', model: 'synthetic-model', status: 'ready', checkedAt: '2026-09-16T10:05:00Z' },
        gpuInfo: { status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: 400, canStart: false, canPause: true },
        pictures: true, standardStyle: 'A synthetic standard line of an owner.',
        // The card counts each text in whole words for one library, and knows no count for the others.
        ...name === 'sheet' ? { textTokens: (text: string) => text.split(' ').length } : {} };
    };
    const seen = new Set<string>(), actions = new Set<string>();
    const walk = (...queue: string[]) => {
      while (queue.length) {
        const route = queue.shift()!;
        if (seen.has(route)) continue;
        seen.add(route);
        const screen = render(state, route, details(route));
        out.push([`${name}: ${route}`, screen]);
        for (const data of callbacks(screen)) {
          actions.add(data);
          if (data.startsWith('view:')) queue.push(data.slice(5));
        }
      }
    };
    // Crawl what the buttons reach from the menu, then the routes no button leads to in this state.
    walk('home', 'new-seed');
    const fromMenu = new Set(actions);
    walk('model', 'language', 'nonsense', 'seed:s404', 'story:h404', 'tree:h404', 'log:h2:b404:0', 'branch:h2:b404',
      'checkpoints:h2:b404:0', 'checkpoint:h2:c404', 'context:h2:c404', 'delete-seed:s404', 'delete-branch:h2:b404', 'delete-seed:s12', 'delete-branch:h2:b8',
      'style-input', 'style:y404', 'delete-style:y404', 'delete-style:y20', 'sample:film', 'sample:standard', 'sample:y20', 'prompt-input',
      'characters:h404', 'character:h404:0', 'character:h2:9', 'look-input',
      `portrait:h2:0:${personTag('Mira')}:0a1b2c3d`, `portrait:h2:1:${personTag('Oleg')}:`, `portrait:h2:1:${personTag('Mira')}:0a1b2c3d`,
      `portrait:h404:0:${personTag('Mira')}:0a1b2c3d`, 'portrait-kept:h2:1', 'portrait-kept:h2:9');
    offered.set(name, [fromMenu, actions]);
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
  return { all: out, offered };
}

// A valid payload alone is no working menu. [state, where its buttons must lead from the menu, what nothing in it offers]:
const MUTATIONS = /^(start|use|fork|remove-seed|remove-branch):|^(continue|compact)$|^view:delete-/;
const PATHS: [string, string[], RegExp?][] = [
  ['idle', ['view:seeds:0', 'view:seed:s1', 'view:story:h2', 'view:branch:h2:b3', 'view:branch:h2:b8', 'view:checkpoints:h2:b3:0',
    'view:checkpoint:h2:c4', 'view:delete-seed:s1', 'view:delete-branch:h2:b8', 'view:context', 'view:context:h2:c4', 'view:model',
    'continue', 'last', 'new-seed', 'start:s1', 'use:h2:b8', 'fork:h2:c5', 'remove-seed:s1', 'remove-branch:h2:b3', 'compact',
    // Pictures are drawn for this reader: every style has a card, and samples are offered on request.
    'view:style', ...Object.keys(PRESETS).map(key => `view:style:${key}`), 'style-new', 'style:film', 'style-sample:semi', 'style-samples']],
  // A busy library keeps navigation and cancel and offers nothing that would change it, a confirmation's button included.
  ['scene job', ['cancel', 'view:checkpoint:h2:c5', 'view:model'], MUTATIONS],
  ['compact job', ['cancel', 'view:checkpoint:h2:c5', 'view:model'], MUTATIONS],
  // An empty library leads to a first seed, and has nothing to go on with.
  ['empty', ['new-seed', 'view:model', 'view:language'], /^(continue|last|compact)$/],
  ['own style', ['view:style:y20', 'style-sample:y20', 'style-edit:y20', 'view:delete-style:y20', 'remove-style:y20']],
  ['full library', ['view:style', 'style-samples'], /^style-new$/],
  ['sheet', ['view:characters:h2', `view:character:h2:0:${personTag('Mira')}`, `look-edit:h2:0:${personTag('Mira')}`, `portrait:h2:0:${personTag('Mira')}`]],
];

for (const lang of [undefined, ...REGISTERED]) {
  test(`every screen in ${lang ?? 'a library without a language'} is a valid payload`, () => {
    const t = texts(lang);
    // A library from before the language choice belongs to a Russian-speaking reader, and so does anything that is no
    // language, a name every object has included.
    assert.equal(t, texts(lang ?? 'ru'));
    if (!lang) for (const odd of [null, 7, 'xx', 'constructor']) assert.equal(texts(odd), t, String(odd));
    // A first contact from a Telegram app in this language, its region written either way, gets it; one with no code,
    // or in a language without a catalog, gets English.
    const codes = lang ? [lang, lang.toUpperCase(), `${lang}-XX`, `${lang}_xx`] : [undefined, '', 'rue', 'uk', 'de-DE'];
    for (const code of codes) assert.equal(langFromTelegram(code), lang ?? 'en', `the Telegram code ${code}`);
    const { all, offered } = screens(lang);
    assert.ok(all.length > 150, 'the crawl reaches the whole interface');
    for (const [name, screen] of all) {
      assert.equal(typeof screen.text, 'string', name);
      assert.ok(screen.text.length > 0 && screen.text.length <= LIMIT, `${name}: ${screen.text.length} characters`);
      // render() answers an exception with this screen instead of throwing.
      assert.ok(!screen.text.startsWith(t.common.failure), `${name} failed to render`);
      assert.doesNotMatch(screen.text, /undefined|\[object|NaN/, name);
      // Plain text: a screen is never sent with a parse mode.
      assert.equal((screen as { parse_mode?: unknown }).parse_mode, undefined, name);
      for (const button of screen.reply_markup?.inline_keyboard.flat() ?? []) {
        assert.ok(button.text.trim().length > 0, `${name}: empty label for ${button.callback_data}`);
        assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, `${name}: ${button.callback_data}`);
        assert.match(button.callback_data, ACTION, name);
      }
    }
    for (const [state, wanted, never] of PATHS) {
      const [fromMenu, anywhere] = offered.get(state)!;
      for (const data of wanted) assert.ok(fromMenu.has(data), `${state}: no way to ${data} from the menu`);
      if (never) for (const data of anywhere) assert.doesNotMatch(data, never, `${state}: ${data}`);
    }
    // Without pictures the menu leads to neither styles nor characters.
    assert.ok(!callbacks(render(library(lang), 'home')).some(data => /^view:(style|characters)/.test(data)), 'a menu without pictures');
    // The picker lists the registered languages by their own names and marks the one shown; the way to it reads the
    // same in every language, so that a reader in a wrong one still finds it.
    const buttons = (route: string) => render(library(lang), route).reply_markup!.inline_keyboard.flat().map(button => [button.callback_data, button.text]);
    assert.deepEqual(buttons('language').filter(([data]) => data.startsWith('lang:')), REGISTERED.map(code => [`lang:${code}`, `${code === (lang ?? 'ru') ? '✅ ' : ''}${LANGS[code]}`]));
    assert.ok(buttons('home').some(([data, text]) => data === 'view:language' && text === LANGUAGE_BUTTON), 'the way to the picker');
    // An English reader reads no Russian, apart from the name of Russian in the picker.
    if (lang === 'en') for (const [name, screen] of all) {
      assert.doesNotMatch(screen.text, CYRILLIC, name);
      for (const button of screen.reply_markup?.inline_keyboard.flat() ?? []) if (button.callback_data !== 'lang:ru') assert.doesNotMatch(button.text, CYRILLIC, name);
    }
    // The texts name the limits the code keeps, and an example works once copied.
    for (const [text, limits] of [[t.errors.styleTooLong, [OWN_STYLE_CHARS]], [t.errors.stylesFull, [OWN_STYLES_MAX]],
      [t.pictureStyle.inputNote(OWN_STYLE_CHARS, OWN_NAME_CHARS), [OWN_STYLE_CHARS, OWN_NAME_CHARS]], [t.pictureStyle.editNote(OWN_STYLE_CHARS), [OWN_STYLE_CHARS]],
      [t.errors.promptTooLong, [PROMPT_CHARS]], [t.variant.note(PROMPT_CHARS), [PROMPT_CHARS]], [t.errors.lookTooLong, [LOOK_CHARS]],
      [t.characters.editNote(LOOK_CHARS), [LOOK_CHARS]]] as const) for (const limit of limits) assert.match(text, new RegExp(`\\b${limit}\\b`), text);
    const [name, line, ...rest] = t.pictureStyle.exampleText.split('\n');
    assert.ok(name && [...name].length <= OWN_NAME_CHARS && line && [...line].length <= OWN_STYLE_CHARS && !rest.length && !/[^\x20-\x7e]/.test(line), 'the example style');
    assert.doesNotThrow(() => addSeed(emptyLibrary(), t.newSeed.example), 'the example seed');
    // The scene header goes out as Markdown, so none of its own words may be Markdown.
    for (const text of [t.scenePrefix.context(12, true), t.scenePrefix.contextBelowOne(true), ...Object.values(t.model.providers).map(provider => provider.short)]) {
      assert.doesNotMatch(text, /[_*`[\]()~>#+=|{}.!\\-]/, text);
    }

    // The command menu in this language fits Telegram's limits, and only the Russian one is in Russian; GPU commands come
    // only with a GPU, /style only with pictures.
    assert.deepEqual(commandSets(false).map(set => set.language_code), [undefined, ...REGISTERED]);
    for (const [gpu, pictures] of [[false, false], [true, false], [false, true]]) {
      const sets = commandSets(gpu, pictures);
      const { commands } = sets.find(set => set.language_code === lang)!;
      if (!lang) assert.deepEqual(commands, sets.find(set => set.language_code === 'en')!.commands, 'the default list is English');
      for (const { command, description } of commands) {
        assert.ok(/^[a-z_]{1,32}$/.test(command) && description.length >= 1 && description.length <= 256 && (lang === 'ru' || !CYRILLIC.test(description)), `/${command}`);
      }
      assert.deepEqual(commands.map(item => item.command).filter(command => /^(language|style|gpu_\w+)$/.test(command)),
        ['language', ...pictures ? ['style'] : [], ...gpu ? ['gpu_pause', 'gpu_start'] : []], `gpu ${gpu}, pictures ${pictures}`);
    }
  });
}

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
