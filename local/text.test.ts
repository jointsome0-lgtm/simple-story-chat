import test from 'node:test';
import assert from 'node:assert/strict';
import type { Library, SceneNode } from '../lib/library.ts';
import { personTag } from './picture.ts';
import { renderCompaction } from './compact-view.ts';
import type { Screen } from './telegram.ts';
import { REGISTERED, commandSets, langFromTelegram, texts } from './text.ts';
import type { Lang } from './text.ts';
import { LIMIT, render } from './ui.ts';

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

// Language-specific text must fit Telegram, including UTF-16 entity offsets after emoji.
// Action permissions and destructive scope are checked in ui.test.ts, without repeating that matrix per catalog.
test('registered languages keep bounded messages, callbacks and copyable fields', () => {
  for (const lang of [undefined, ...REGISTERED]) {
    const state = library(lang), t = texts(lang);
    if (!lang) for (const odd of [null, 7, 'xx', 'constructor']) assert.equal(texts(odd), texts('ru'));
    const codes = lang ? [lang, lang.toUpperCase(), `${lang}-XX`, `${lang}_xx`] : [undefined, '', 'rue', 'uk', 'de-DE'];
    for (const code of codes) assert.equal(langFromTelegram(code), lang ?? 'en');
    const look = '🌊 Tall, grey-haired keeper.', clothes = '🧥 A wool coat.';
    state.stories.h2.sheet = [{ name: 'Mira', description: '🌊 A keeper.', changes: '', details: look, look, outfit: clothes }];
    state.pictureStyles = { y20: { id: 'y20', name: 'Oil', line: '🎨 Oil painting.' } };
    const person = `h2:0:${personTag('Mira')}`;
    const on = { pictures: true, standardStyle: 'Oil painting.' };
    const routes = ['home', 'language', 'seeds:0', 'seed:s1', 'story:h2', 'branch:h2:b3', 'tree:h2', 'log:h2:b3:0',
      'checkpoints:h2:b3:0', 'checkpoint:h2:c7', 'context', 'delete-seed:s1', 'delete-branch:h2:b3', 'new-seed',
      'style', 'style:film', 'style:y20', 'delete-style:y20', 'characters:h2', `character:${person}`, `profile:${person}`];
    const screens: [string, Screen][] = routes.map(route => [route, render(state, route, on)]);
    for (const input of ['look', 'details', 'profile', 'style', 'prompt'] as const) {
      state.ui = input === 'style' ? { input, styleId: 'y20' }
        : input === 'prompt' ? { input, storyId: 'h2', nodeId: 'n6' }
        : input === 'profile' ? { input, storyId: 'h2', name: 'Mira', fields: '1f', hash: '0123abcd' }
        : { input, storyId: 'h2', name: 'Mira' };
      screens.push([`${input} input`, render(state, `${input}-input`, on)]);
    }
    state.ui = null;
    // Worst-size stored text must leave room for navigation and valid entity ranges.
    state.stories.h2.nodes.n6.text = '🌊'.repeat(5000);
    state.stories.h2.sheet[0].description = '🌊'.repeat(4000);
    screens.push(['long scene', render(state, 'checkpoint:h2:c7', on)], ['long character', render(state, `character:${person}`, on)]);
    for (const stage of ['queued', 'extracting', 'validating', 'saving', 'done', 'failed', 'cancelled'] as const)
      screens.push([`compaction ${stage}`, renderCompaction({ stage, scenes: 12, repairScenes: 2, outputCharacters: 12345, elapsedMs: 75000 }, lang)]);
    for (const status of ['ready', 'draining', 'paused', 'starting', 'error'] as const) screens.push([`GPU ${status}`, render(state, 'model', {
      gpuInfo: { status, activeJobs: 2, idleMinutes: 15, idleRemainingSeconds: 30, canStart: false, canPause: true },
      modelInfo: { provider: 'llama-cpp', model: 'synthetic-model', status: 'ready' },
    })]);
    for (const [route, screen] of screens) {
      const label = `${lang ?? 'legacy'}: ${route}`;
      assert.ok(screen.text.length > 0 && screen.text.length <= LIMIT, label);
      assert.ok(!screen.text.startsWith(t.common.failure), label);
      assert.doesNotMatch(screen.text, /undefined|\[object|NaN/, label);
      assert.equal((screen as { parse_mode?: unknown }).parse_mode, undefined, label);
      for (const row of screen.reply_markup?.inline_keyboard ?? []) {
        assert.ok(row.length > 0, label);
        for (const button of row) assert.ok(button.text.trim() && Buffer.byteLength(button.callback_data ?? '', 'utf8') <= 64, label);
      }
      for (const entity of screen.entities ?? []) {
        assert.ok(Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0 && entity.length > 0
          && entity.offset + entity.length <= screen.text.length, label);
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(screen.text.slice(entity.offset, entity.offset + entity.length)), label);
      }
    }
    const card = screens.find(([route]) => route === `character:${person}`)![1];
    const copied = card.entities?.map(entity => card.text.slice(entity.offset, entity.offset + entity.length));
    assert.ok(copied?.includes(look) && copied.includes(clothes), `${lang}: copy offsets select the actual fields`);
    // setMyCommands has separate payload bounds, even though its wording is left to ordinary use.
    for (const { commands } of commandSets(true, true).filter(set => set.language_code === lang)) {
      assert.ok(commands.length <= 100);
      for (const { command, description } of commands)
        assert.ok(/^[a-z_]{1,32}$/.test(command) && description.length >= 1 && description.length <= 256);
    }
  }
});
