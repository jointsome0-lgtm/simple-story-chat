import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Library, SceneNode } from '../lib/library.ts';
import type { ContextStats } from './context.ts';
import type { Screen } from './telegram.ts';
import type { GpuInfo, ModelInfo, RenderDetails } from './ui.ts';
import { render, renderContext, scenePrefix, sceneKeyboard } from './ui.ts';
import { PRESETS } from './picture-style.ts';
import { texts } from './text.ts';

const ACTION = /^(view:.+|new-seed|save-seed:[^:]+|start:[^:]+|use:[^:]+:[^:]+|fork:[^:]+:[^:]+|remove-seed:[^:]+|remove-branch:[^:]+:[^:]+|continue|cancel|last|compact|gpu:start|gpu:pause|lang:[a-z]{2}|style:[a-z0-9]+|style-new|style-edit:y\d+|remove-style:y\d+|style-sample:[a-z0-9]+|style-samples)$/;

function node(id: string, parent: string | null, time: string, body: string, input = 'Ввод'): SceneNode {
  return { id, parent, input, text: `${time}\n\n${body}`, time, truncated: false, delivery: 'sent' };
}

function fixture(): Library {
  return {
    version: 1, seq: 11,
    seeds: { s1: { id: 's1', title: 'Маяк', startTime: '2026-08-02 20:00', text: 'Северный остров. Смотрительница Мира.' } },
    stories: {
      h2: {
        id: 'h2', seedId: 's1', title: 'Маяк',
        branches: {
          b3: { id: 'b3', name: 'Начало', head: 'n6', memory: null },
          b8: { id: 'b8', name: 'От Сцена 1', head: 'n9', memory: null },
        },
        checkpoints: {
          c4: { id: 'c4', branchId: 'b3', label: 'Сид', kind: 'start', head: null, memory: null },
          c5: { id: 'c5', branchId: 'b3', label: 'Сцена 1', kind: 'scene', head: 'n5', memory: null },
          c7: { id: 'c7', branchId: 'b3', label: 'Сцена 2', kind: 'scene', head: 'n6', memory: null },
          c10: { id: 'c10', branchId: 'b8', label: 'Точка развилки', kind: 'fork', head: 'n5', memory: null },
          c11: { id: 'c11', branchId: 'b8', label: 'Сцена 2', kind: 'scene', head: 'n9', memory: null },
        },
        nodes: {
          n5: node('n5', null, '2026-08-02 20:00', 'Ветер бьёт в стекло.'),
          n6: node('n6', 'n5', '2026-08-02 20:30', 'Лодка пуста.'),
          n9: node('n9', 'n5', '2026-08-02 20:40', 'Огонь гаснет.'),
        },
        memories: {},
      },
    },
    active: { storyId: 'h2', branchId: 'b3' },
    job: null, ui: null, seen: [],
  };
}

// The UI reads only a job's presence, kind and story; these jobs carry just that, including kinds the bot never writes.
const partialJob = (fields: { id: string; kind?: string; storyId: string; branchId: string }) => fields as Job;

function callbacks(message: Screen) {
  return (message.reply_markup?.inline_keyboard ?? []).flat().map(button => button.callback_data);
}

function checkPayload(message: Screen & { parse_mode?: unknown }, route: string) {
  assert.equal(typeof message.text, 'string', route);
  assert.ok(message.text.length > 0 && message.text.length <= 4096, route);
  assert.equal(message.parse_mode, undefined, route);
  for (const row of message.reply_markup?.inline_keyboard ?? []) {
    assert.ok(row.length > 0, route);
    for (const button of row) {
      assert.ok(button.text, route);
      assert.ok(Buffer.byteLength(button.callback_data, 'utf8') <= 64, `${route}: ${button.callback_data}`);
      assert.match(button.callback_data, ACTION, route);
    }
  }
}

// Renders every screen reachable through view: buttons.
function crawl(state: Library, details: RenderDetails = {}) {
  const seen = new Set<string>();
  const queue = ['home', 'new-seed'];
  const all: string[] = [];
  while (queue.length) {
    const route = queue.shift()!;
    if (seen.has(route)) continue;
    seen.add(route);
    const message = render(state, route, details);
    checkPayload(message, route);
    for (const data of callbacks(message)) {
      all.push(data);
      if (data.startsWith('view:')) queue.push(data.slice(5));
    }
  }
  return { routes: seen, callbacks: all };
}

test('every reachable screen is a valid payload', () => {
  const { routes, callbacks: all } = crawl(fixture());
  for (const route of ['seeds:0', 'seed:s1', 'story:h2', 'branch:h2:b3', 'branch:h2:b8', 'checkpoints:h2:b3:0', 'checkpoint:h2:c4', 'delete-seed:s1', 'delete-branch:h2:b8', 'context', 'context:h2:c4', 'model']) {
    assert.ok(routes.has(route), route);
  }
  for (const action of ['continue', 'last', 'new-seed', 'start:s1', 'use:h2:b8', 'fork:h2:c5', 'remove-seed:s1', 'remove-branch:h2:b3', 'compact']) {
    assert.ok(all.includes(action), action);
  }
});

// A card's prompt: the text under its `pre` entity.
function preText(message: Screen) {
  const entity = message.entities?.find(one => one.type === 'pre');
  return entity ? message.text.slice(entity.offset, entity.offset + entity.length) : null;
}

test('picture styles: a picker of cards, the prompt of each to copy, a library of the reader\'s own, and samples only on request', () => {
  const state = fixture();
  const semi = { pictures: true, standardStyle: PRESETS.semi };
  const presets = Object.keys(PRESETS);
  // The way in exists only for a reader whose scenes are drawn.
  assert.ok(callbacks(render(state, 'home', semi)).includes('view:style'));
  assert.ok(!callbacks(render(state, 'home')).includes('view:style'));
  const { routes, callbacks: all } = crawl(state, semi);
  for (const route of ['style', ...presets.map(key => `style:${key}`)]) assert.ok(routes.has(route), route);
  for (const action of ['style-new', 'style:film', 'style-sample:semi', 'style-samples']) assert.ok(all.includes(action), action);

  // The standard line is the semi preset here: it has no button of its own, and semi is marked as the current style.
  const picker = render(state, 'style', semi);
  assert.deepEqual(callbacks(picker), [...presets.map(key => `view:style:${key}`), 'style-new', 'style-samples', 'view:home']);
  // All styles at once is offered only to a reader whose scenes are drawn, like a single sample.
  assert.ok(!callbacks(render(state, 'style')).includes('style-samples'));
  assert.match(picker.text, /Сейчас: 🖌 Полуреализм/);
  assert.deepEqual(picker.reply_markup!.inline_keyboard.flat().filter(button => button.text.startsWith('✅ ')).map(button => button.callback_data), ['view:style:semi']);
  // A standard line of the owner's own has a button, and is the current style of a reader who chose nothing.
  const custom = render(state, 'style', { pictures: true, standardStyle: 'An owner line.' });
  assert.deepEqual(callbacks(custom).slice(0, 2), ['view:style:standard', 'view:style:semi']);
  assert.equal(preText(render(state, 'style:standard', { pictures: true, standardStyle: 'An owner line.' })), 'An owner line.');
  assert.deepEqual(callbacks(render(state, 'style:standard', semi)), callbacks(picker));

  // A card: the whole prompt in a pre block, to be copied; the sample is a button, and nothing is drawn by opening it.
  const film = render(state, 'style:film', semi);
  assert.equal(preText(film), PRESETS.film);
  assert.deepEqual(callbacks(film), ['style:film', 'style-sample:film', 'view:style']);
  assert.deepEqual(callbacks(render(state, 'style:semi', semi)), ['style-sample:semi', 'view:style']);
  assert.match(render(state, 'style:semi', semi).text, /✅ Картинки рисуются в этом стиле/);
  // Without pictures a style may still be chosen, but no sample is offered.
  const off = render(state, 'style:film');
  assert.deepEqual(callbacks(off), ['style:film', 'view:style']);
  assert.match(off.text, /пока не включены/);

  // A style of the reader's own: its line, then the sentence the bot adds, and the ways to change or delete it.
  state.pictureStyles = { y7: { id: 'y7', name: 'Масло при свечах', line: 'Oil painting, warm candlelight' } };
  state.pictureStyle = 'y7';
  const own = render(state, 'style:y7', semi);
  checkPayload(own, 'style:y7');
  assert.equal(preText(own), 'Oil painting, warm candlelight. All people are adults.');
  assert.match(own.text, /^✍️ Масло при свечах\n✅/);
  assert.match(own.text, /Последнюю фразу бот добавляет сам/);
  assert.deepEqual(callbacks(own), ['style-sample:y7', 'style-edit:y7', 'view:delete-style:y7', 'view:style']);
  assert.deepEqual(callbacks(render(state, 'style', semi)).slice(-4), ['view:style:y7', 'style-new', 'style-samples', 'view:home']);
  assert.match(render(state, 'style', semi).text, /Сейчас: ✍️ Масло при свечах/);

  // Deleting the chosen style says where the pictures go next.
  const remove = render(state, 'delete-style:y7', semi);
  assert.match(remove.text, /Удалить стиль «Масло при свечах»\?/);
  assert.match(remove.text, /в стиле «🖌 Полуреализм»/);
  assert.deepEqual(callbacks(remove), ['remove-style:y7', 'view:style:y7']);
  assert.deepEqual(callbacks(render(state, 'delete-style:y8', semi)), callbacks(render(state, 'style', semi)));

  // Writing a style: only while the bot waits for one, a new one with a copyable example, an edit with the line as it is.
  assert.deepEqual(callbacks(render(state, 'style-input', semi)), callbacks(render(state, 'style', semi)));
  state.ui = { input: 'style' };
  const fresh = render(state, 'style-input', semi);
  checkPayload(fresh, 'style-input new');
  assert.equal(preText(fresh), texts('ru').pictureStyle.exampleText);
  assert.match(fresh.text, /до 400 знаков/);
  assert.deepEqual(callbacks(fresh), ['view:style']);
  state.ui = { input: 'style', styleId: 'y7' };
  const edit = render(state, 'style-input', semi);
  assert.equal(preText(edit), 'Oil painting, warm candlelight');
  assert.deepEqual(callbacks(edit), ['view:style:y7']);
  state.ui = null;

  // The caption of a sample offers the style unless it is the chosen one.
  assert.deepEqual(render(state, 'sample:film', semi), { text: 'Пример стиля: 🎬 Кинокадр',
    reply_markup: { inline_keyboard: [[{ text: '✅ Рисовать в этом стиле', callback_data: 'style:film' }], [{ text: '↩️ К стилям', callback_data: 'view:style' }]] } });
  assert.deepEqual(callbacks(render(state, 'sample:y7', semi)), ['view:style']);

  // A full library offers no new style; stored entries that are not styles are left out.
  state.pictureStyles = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`y${n + 1}`, { id: `y${n + 1}`, name: `Стиль ${n + 1}`, line: 'Ink.' }]));
  assert.ok(!callbacks(render(state, 'style', semi)).includes('style-new'));
  state.pictureStyles = { y1: { id: 'y1', name: ' ', line: 'Ink.' }, x2: { id: 'x2', name: 'X', line: 'Ink.' } };
  state.pictureStyle = 'y1';
  assert.deepEqual(callbacks(render(state, 'style', semi)), [...presets.map(key => `view:style:${key}`), 'style-new', 'style-samples', 'view:home']);
  assert.deepEqual(callbacks(render(state, 'style:x2', semi)), callbacks(render(state, 'style', semi)));
});

test('empty library guides to seed creation', () => {
  const state: Library = { version: 1, seq: 0, seeds: {}, stories: {}, active: null, job: null, ui: null, seen: [] };
  const home = render(state);
  assert.deepEqual(callbacks(home), ['new-seed', 'view:model', 'view:language']);
  assert.deepEqual(callbacks(render(state, 'seeds:0')), ['new-seed', 'view:home']);
  crawl(state);
});

test('new seed screen has a copyable example and a cancel path', () => {
  const message = render(fixture(), 'new-seed');
  assert.ok(callbacks(message).includes('cancel'));
  const [entity] = message.entities!;
  const example = message.text.slice(entity.offset, entity.offset + entity.length).split('\n');
  assert.equal(example[0], 'Маяк на краю света');
  assert.match(example[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(example[2].length > 0);
});

test('seed can be collected from several messages before explicit save', () => {
  const state = fixture();
  state.ui = { input: 'seed', draftId: 'd123', parts: [] };
  const initial = render(state, 'new-seed');
  checkPayload(initial, 'new-seed initial');
  assert.deepEqual(callbacks(initial), ['cancel']);
  assert.match(initial.text, /одним или несколькими сообщениями/);
  assert.match(initial.text, /Сохранить сид/);
  assert.match(initial.text, /\.txt \/ \.md \(UTF-8, до 256 КиБ/);
  assert.match(initial.text, /Подпись к файлу не учитывается, PDF и DOCX не подходят/);
  assert.doesNotMatch(render(state).text, /одно сообщение/);

  state.ui.parts = ['Маяк\n2026-08-02 20:00\nСеверный остров.', 'Вторая часть описания.'];
  const receipt = render(state, 'new-seed');
  checkPayload(receipt, 'new-seed draft');
  assert.deepEqual(callbacks(receipt), ['save-seed:d123', 'cancel']);
  const chars = [...state.ui.parts.join('\n\n')].length;
  assert.match(receipt.text, /не сохранён/);
  assert.match(receipt.text, new RegExp(`Получено: 2 части · ${chars} знак`));
  assert.doesNotMatch(receipt.text, /Маяк|2026-08-02|Северный остров|Вторая часть/);
  assert.match(receipt.text, /\.txt/);
  assert.doesNotMatch(receipt.text, /⚠️|ток/);
  assert.equal(receipt.entities, undefined);

  // Format is left to the backend: blank lines, headings or a title-only first part get no warning.
  state.ui.parts = ['# Маяк'];
  const titleOnly = render(state, 'new-seed');
  assert.match(titleOnly.text, /Получено: 1 часть/);
  assert.doesNotMatch(titleOnly.text, /⚠️|Маяк/);
  assert.deepEqual(callbacks(titleOnly), ['save-seed:d123', 'cancel']);

  state.ui = { input: 'seed', draftId: 'd456', parts: ['x'.repeat(50000)] };
  const long = render(state, 'new-seed');
  checkPayload(long, 'long draft');
  assert.ok(long.text.length < 1000);
  assert.match(long.text, /50000 знаков/);
  assert.deepEqual(callbacks(long), ['save-seed:d456', 'cancel']);
});

test('busy state hides mutations but keeps navigation and cancel', () => {
  const state = fixture();
  state.job = { id: 'j12', storyId: 'h2', branchId: 'b3', head: 'n6', memory: null, input: 'дальше', started: 0 };
  const { callbacks: all } = crawl(state);
  assert.ok(all.includes('cancel'));
  assert.ok(all.includes('view:checkpoint:h2:c5'));
  for (const data of all) {
    assert.doesNotMatch(data, /^(start|use|fork|remove-seed|remove-branch):|^(continue|compact)$|^view:delete-/, data);
  }
  assert.ok(all.includes('view:model'));
  assert.ok(!callbacks(render(state, 'context', { contextStats: current() })).includes('compact'));
  assert.ok(!callbacks(render(state, 'delete-seed:s1')).some(data => data.startsWith('remove-')));
  assert.ok(!callbacks(render(state, 'delete-branch:h2:b3')).some(data => data.startsWith('remove-')));
});

test('delete confirmations show scope', () => {
  const state = fixture();
  const seed = render(state, 'delete-seed:s1').text;
  assert.match(seed, /1 история/);
  assert.match(seed, /2 ветки/);
  assert.match(seed, /3 сцены/);
  const branch = render(state, 'delete-branch:h2:b3').text;
  assert.match(branch, /3 чекпоинта/);
  assert.match(branch, /1 сцена, которой нет в других ветках/);
  assert.match(branch, /1 другая ветка/);
  delete state.stories.h2.branches.b8;
  for (const id of ['c10', 'c11']) delete state.stories.h2.checkpoints[id];
  delete state.stories.h2.nodes.n9;
  assert.match(render(state, 'delete-branch:h2:b3').text, /история удалится целиком/);
});

test('stale and malformed routes recover', () => {
  const state = fixture();
  for (const route of ['seed:s99', 'story:h99', 'branch:h2:b99', 'checkpoints:h9:b3:0', 'checkpoint:h2:c99', 'delete-seed:s99', 'delete-branch:h2:b99', 'seed:constructor', 'story:__proto__', 'nonsense', '', 'seeds:-1', 'seeds:abc']) {
    const message = render(state, route);
    checkPayload(message, route);
    assert.ok(callbacks(message).some(data => data === 'view:home' || data === 'view:seeds:0'), route);
  }
  checkPayload(render(state, undefined), 'undefined');
  checkPayload(render(null, 'home'), 'null state');
  state.active = { storyId: 'h2', branchId: 'gone' };
  checkPayload(render(state), 'stale active');
  assert.equal(sceneKeyboard(state), undefined);
});

test('long collections paginate and long texts fit', () => {
  const state = fixture();
  for (let i = 100; i < 130; i++) state.seeds[`s${i}`] = { id: `s${i}`, title: 'Очень длинное название '.repeat(5), startTime: '2026-08-02 20:00', text: 'мир '.repeat(3000) };
  const story = state.stories.h2;
  let parent = 'n6';
  for (let i = 200; i < 240; i++) {
    story.nodes[`n${i}`] = node(`n${i}`, parent, '2026-08-03 10:00', 'Текст сцены. '.repeat(1000), 'ввод '.repeat(500));
    story.checkpoints[`c${i}`] = { id: `c${i}`, branchId: 'b3', label: `Сцена ${i}`, kind: 'scene', head: `n${i}`, memory: null };
    parent = `n${i}`;
  }
  story.branches.b3.head = parent;

  const first = render(state, 'seeds:0');
  assert.equal(callbacks(first).filter(data => data.startsWith('view:seed:')).length, 8);
  assert.ok(callbacks(first).includes('view:seeds:1'));
  const last = render(state, 'seeds:999');
  assert.ok(callbacks(last).includes('view:seeds:2'));
  assert.ok(!callbacks(last).includes('view:seeds:4'));

  const newest = render(state, 'checkpoints:h2:b3:0');
  assert.ok(callbacks(newest).includes('view:checkpoint:h2:c239'));
  const preview = render(state, 'checkpoint:h2:c239');
  assert.ok(callbacks(preview).includes('fork:h2:c239'));
  assert.ok(preview.text.includes('новую ветку'), 'footer survives clipping');
  crawl(state);
});

// Stats may reach the renderer incomplete, so overrides can replace any field with any value.
function stats(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'checkpoint', label: 'Сцена 2',
    storyId: 'h2', branchId: 'b3', checkpointId: 'c7',
    model: 'claude-haiku-4-5-20251001',
    limitTokens: 65536, reserveTokens: 4096,
    seed: { bytes: 1200, estimatedTokens: 300 },
    memory: { count: 0, bytes: 0, estimatedTokens: 0 },
    prefix: { bytes: 1200, estimatedTokens: 300 },
    tail: { count: 3, bytes: 8800, estimatedTokens: 2200 },
    snapshot: { bytes: 10000, estimatedTokens: 2500 },
    request: { bytes: 13000, estimatedTokens: 3250, estimateSource: 'usage' },
    budget: { inputTokens: 3250, limitTokens: 61440, remainingTokens: 58190 },
    compaction: { thresholdTokens: 54000, keepScenes: 4 },
    lastRequest: { inputTokens: 2700, outputTokens: 500, totalTokens: 3200 },
    ...overrides,
  } as ContextStats;
}

const current = (overrides?: Record<string, unknown>) => stats({ scope: 'current', label: 'Начало', checkpointId: null, ...overrides });

test('detailed context view separates exact bytes, estimates and measurements', () => {
  const message = renderContext(current());
  checkPayload(message, 'context full');
  const text = message.text;
  assert.match(text, /65\s536/);
  assert.match(text, /Сид \+ память: 1\s200 Б · ≈300 ток\./);
  assert.match(text, /Весь снимок: 10\s000 Б · ≈2\s500 ток\./);
  assert.match(text, /Следующий запрос ≈3\s250 ток\. \(≈5% окна\)/);
  assert.match(text, /сверена с последним измеренным/);
  assert.match(text, /≈3\s250 из 61\s440 ток\./);
  assert.match(text, /Осталось ≈58\s190 ток\./);
  assert.match(text, /проверяется в начале ответа/);
  assert.match(text, /Автосжатие: когда вход достигает ≈54\s000 ток\.; последние 4 сцены остаются целиком/);
  assert.match(text, /Память: пусто, сжатий ещё не было/);
  assert.doesNotMatch(text, /не реализовано/);
  assert.match(text, /вход 2\s700 · выход 500 · всего 3\s200/);
  assert.match(text, /скрытые рассуждения/);
  assert.match(text, /байты UTF-8 ÷ 4/);
  assert.doesNotMatch(text, /haiku/i);
  assert.ok(callbacks(message).includes('view:home'));

  const rough = renderContext(current({ request: { bytes: 13000, estimatedTokens: 3250, estimateSource: 'bytes' } })).text;
  assert.match(rough, /Грубая оценка: байты UTF-8 ÷ 4 плюс запас/);
  const compacted = renderContext(current({ memory: { count: 2, bytes: 900, estimatedTokens: 225 } })).text;
  assert.match(compacted, /Память: 2 части · 900 Б · ≈225 ток\./);
  const exhausted = renderContext(current({ budget: { inputTokens: 62000, limitTokens: 61440, remainingTokens: -560 } })).text;
  assert.match(exhausted, /⚠️ По оценке бюджет ввода уже исчерпан/);
});

test('scene prefix is a minimal approximate percentage', () => {
  assert.equal(scenePrefix(current()), '_📏 Контекст ≈ 5%_\n\n');
  assert.equal(scenePrefix(current({ request: { estimatedTokens: 3250, estimateSource: 'bytes' } })), '_📏 Контекст ≈ 5%, грубая оценка_\n\n');
  assert.equal(scenePrefix(current({ request: { estimatedTokens: 300, estimateSource: 'usage' } })), '_📏 Контекст менее 1%_\n\n');
  assert.equal(scenePrefix(current({ request: { estimatedTokens: 70000, estimateSource: 'usage' } })), '_📏 Контекст ≈ 107%_\n\n');
  for (const unknown of [null, undefined, {} as ContextStats, current({ request: null }), current({ request: { estimatedTokens: null } }), current({ limitTokens: null }), current({ limitTokens: 0 })]) {
    assert.equal(scenePrefix(unknown), '');
  }
  const prefix = scenePrefix(current());
  assert.ok(prefix.endsWith('\n\n'));
  assert.equal(prefix.trim().split('\n').length, 1);
  assert.doesNotMatch(prefix, /\d{3}|ток|[.()<>[\]*`]/);
});

test('scene prefix names the model only when the scene carries provenance', () => {
  const haiku = { provider: 'claude-code', model: 'claude-haiku-4-5-20251001' };
  assert.equal(scenePrefix(current(), haiku), '_🤖 Claude Code · claude‐haiku‐4‐5‐20251001 · 📏 Контекст ≈ 5%_\n\n');
  assert.equal(scenePrefix(null, haiku), '_🤖 Claude Code · claude‐haiku‐4‐5‐20251001_\n\n');
  const gemma = scenePrefix(current(), { provider: 'llama-cpp', model: 'gemma_4*31b [Q4_K_M].gguf`' });
  assert.equal(gemma, '_🤖 наш сервер · gemma‐4‐31b ‐Q4‐K‐M‐gguf‐ · 📏 Контекст ≈ 5%_\n\n');
  assert.doesNotMatch(gemma.slice(1, -3), /[_*`[\]()<>.\\]/);
  // Old scenes without provenance, or broken metadata, are never labelled.
  for (const missing of [undefined, null, {}, { provider: 'llama-cpp' }, { provider: 'other', model: 'x' }, { provider: 'claude-code', model: '  ' }]) {
    assert.equal(scenePrefix(current(), missing), '_📏 Контекст ≈ 5%_\n\n');
    assert.equal(scenePrefix(null, missing), '');
  }
});

function modelInfo(overrides: ModelInfo = {}): ModelInfo {
  return { provider: 'llama-cpp', model: 'gemma-4-31b-heretic-Q4_K_M', status: 'ready', checkedAt: '2026-09-16T10:05:30.000Z', ...overrides };
}

test('model screen explains provider and status without a switch', () => {
  const state = fixture();
  for (const provider of ['claude-code', 'llama-cpp']) {
    for (const status of ['configured', 'ready', 'unavailable']) {
      for (const checkedAt of ['2026-09-16T10:05:30.000Z', null]) {
        const route = `model ${provider} ${status} ${checkedAt}`;
        const message = render(state, 'model', { modelInfo: modelInfo({ provider, status, checkedAt }) });
        checkPayload(message, route);
        assert.deepEqual(callbacks(message), ['view:model', 'view:home'], route);
        assert.doesNotMatch(message.text, /undefined|null|NaN/, route);
        if (status === 'ready') {
          assert.match(message.text, /не постоянное наблюдение/, route);
          assert.match(message.text, checkedAt ? /2026-09-16 10:05 UTC/ : /время неизвестно/, route);
        } else {
          assert.doesNotMatch(message.text, /✅/, route);
        }
      }
    }
  }
  const claude = render(state, 'model', { modelInfo: modelInfo({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' }) }).text;
  assert.match(claude, /Claude Code по подписке Claude/);
  assert.match(claude, /не на нашем арендованном GPU/);
  assert.match(claude, /claude-haiku-4-5-20251001/);

  const llama = render(state, 'model', { modelInfo: modelInfo() }).text;
  assert.match(llama, /наш сервер модели \(llama\.cpp\)/);
  assert.match(llama, /не измеряет видеокарту, память GPU/);
  assert.doesNotMatch(llama, /RTX|5090|ГиБ|VRAM/);

  assert.match(render(state, 'model', { modelInfo: modelInfo({ status: 'configured' }) }).text, /не проверена — готова ли она, неизвестно/);
  assert.match(render(state, 'model', { modelInfo: modelInfo({ status: 'unavailable' }) }).text, /Недоступна при проверке: 2026-09-16 10:05 UTC/);

  for (const details of [undefined, {}, { modelInfo: null }, { modelInfo: { provider: 'other', model: 'x' } }]) {
    const empty = render(state, 'model', details);
    checkPayload(empty, 'model without info');
    assert.match(empty.text, /Данных о модели пока нет/);
    assert.deepEqual(callbacks(empty), ['view:model', 'view:home']);
  }
});

test('home shows a model line only with model info', () => {
  const state = fixture();
  assert.ok(callbacks(render(state)).includes('view:model'));
  assert.doesNotMatch(render(state).text, /🤖/);
  assert.match(render(state, 'home', { modelInfo: modelInfo() }).text, /🤖 наш сервер · gemma-4-31b-heretic-Q4_K_M · отвечала 2026-09-16 10:05 UTC/);
  assert.match(render(state, 'home', { modelInfo: modelInfo({ provider: 'claude-code', status: 'configured' }) }).text, /🤖 Claude Code · .* · не проверена/);
  assert.match(render(state, 'home', { modelInfo: modelInfo({ status: 'unavailable' }) }).text, /· недоступна при проверке/);
  assert.match(render(state, 'nonsense', { modelInfo: modelInfo() }).text, /🤖 наш сервер/);
});

// GPU status is rendered defensively, so overrides can replace any field with any value.
function gpuInfo(overrides: Record<string, unknown> = {}) {
  return { status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: 600, canStart: false, canPause: true, ...overrides } as GpuInfo;
}

const GPU_STATUSES = ['unknown', 'ready', 'paused', 'starting', 'stopping', 'draining', 'error'];

test('gpu controls follow canStart and canPause only', () => {
  const state = fixture();
  for (const status of [...GPU_STATUSES, 'weird', undefined]) {
    for (const [canStart, canPause] of [[false, false], [true, false], [false, true], [true, true], [undefined, 'yes']]) {
      const route = `model gpu ${status} ${canStart} ${canPause}`;
      const message = render(state, 'model', { modelInfo: modelInfo(), gpuInfo: gpuInfo({ status, canStart, canPause }) });
      checkPayload(message, route);
      const expected = [canStart === true ? 'gpu:start' : null, canPause === true ? 'gpu:pause' : null, 'view:model', 'view:home'].filter(Boolean);
      assert.deepEqual(callbacks(message), expected, route);
      assert.doesNotMatch(message.text, /undefined|null|NaN/, route);
      const buttons = message.reply_markup!.inline_keyboard.flat().map(b => b.text).join(' ');
      if (canStart === true) assert.match(buttons, /Запустить GPU/, route);
      if (canPause === true) assert.match(buttons, /Пауза GPU/, route);
      // Power control, never provider selection.
      assert.doesNotMatch(buttons, /Claude|llama|Провайдер|Выбрать/, route);
    }
  }
  // Model data may be missing while the GPU is still known.
  assert.deepEqual(callbacks(render(state, 'model', { gpuInfo: gpuInfo({ status: 'paused', canStart: true, canPause: false }) })), ['gpu:start', 'view:model', 'view:home']);
});

test('gpu status texts are honest about billing, waiting and unknown states', () => {
  const state = fixture();
  const text = (overrides: Record<string, unknown>, details: RenderDetails = {}) => render(state, 'model', { modelInfo: modelInfo(), gpuInfo: gpuInfo(overrides), ...details }).text;

  const ready = text({ activeJobs: 0, idleRemainingSeconds: 600 });
  assert.match(ready, /общий для всех пользователей/);
  assert.match(ready, /Задач модели сейчас: 0/);
  assert.match(ready, /после 15 мин без задач модели/);
  assert.match(ready, /Просмотр меню этот отсчёт не сбрасывает/);
  assert.match(ready, /До автопаузы ≈10 мин/);
  assert.match(ready, /дождётся конца всех сцен и сжатий/);
  assert.doesNotMatch(text({ activeJobs: 2 }), /До автопаузы/);
  assert.match(text({ activeJobs: 0, idleRemainingSeconds: 20 }), /До автопаузы ≈меньше минуты/);
  assert.match(text({ activeJobs: null }), /Задач модели сейчас: неизвестно/);

  const draining = text({ status: 'draining', activeJobs: 2, canPause: false });
  assert.match(draining, /ждём, пока закончатся все задачи модели \(сейчас: 2\)/);
  assert.match(draining, /Новые сцены и сжатия до паузы не начинаются/);

  const paused = text({ status: 'paused', activeJobs: 0, canStart: true, canPause: false });
  assert.match(paused, /Vast подтвердил остановку/);
  assert.match(paused, /диск оплачивается и дальше/);
  assert.match(paused, /Истории и чекпоинты хранятся у бота/);
  assert.match(paused, /прогрев модели/);
  assert.doesNotMatch(paused, /\$|₽|руб|USD|\/ч|бесплатн/);
  // No claim that writing a message starts the GPU.
  assert.doesNotMatch(paused, /напиши|сообщени/i);

  assert.match(text({ status: 'starting', canPause: false }), /ждём свободную видеокарту на Vast и прогрев модели/);
  for (const status of ['unknown', 'error', 'weird', undefined]) {
    const unclear = text({ status, canPause: false });
    assert.match(unclear, /не значит, что он на паузе/, String(status));
    assert.match(unclear, /Обновить/, String(status));
    assert.doesNotMatch(unclear, /⏸ На паузе|Vast подтвердил/, String(status));
  }

  // Only a count of active jobs, nothing about who runs them.
  const extra = { ...gpuInfo({ activeJobs: 3 }), users: ['Алиса'], storyTitle: 'Секрет' };
  const busy = render(state, 'model', { modelInfo: modelInfo(), gpuInfo: extra }).text;
  assert.doesNotMatch(busy, /Алиса|Секрет/);
});

test('gpu info is hidden for the Claude provider and when absent', () => {
  const state = fixture();
  const claude = render(state, 'model', { modelInfo: modelInfo({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' }), gpuInfo: gpuInfo({ canStart: true }) });
  assert.deepEqual(callbacks(claude), ['view:model', 'view:home']);
  assert.doesNotMatch(claude.text, /🖥/);
  assert.doesNotMatch(render(state, 'home', { modelInfo: modelInfo({ provider: 'claude-code' }), gpuInfo: gpuInfo() }).text, /🖥/);
  for (const gpu of [undefined, null, 'ready']) {
    const message = render(state, 'model', { modelInfo: modelInfo(), gpuInfo: gpu as GpuInfo | null | undefined });
    assert.deepEqual(callbacks(message), ['view:model', 'view:home']);
    assert.doesNotMatch(message.text, /🖥/);
  }
});

test('home shows a compact gpu line without controls', () => {
  const state = fixture();
  const home = (overrides: Record<string, unknown>) => render(state, 'home', { modelInfo: modelInfo(), gpuInfo: gpuInfo(overrides) });
  const ready = home({ activeJobs: 2 });
  assert.match(ready.text, /🤖 наш сервер · .*\n🖥 GPU: работает · задач: 2\n/);
  assert.ok(!callbacks(ready).some(data => data.startsWith('gpu:')));
  assert.ok(callbacks(ready).includes('view:model'));
  assert.match(home({ status: 'paused', canStart: true }).text, /🖥 GPU: на паузе/);
  assert.ok(!callbacks(home({ status: 'paused', canStart: true })).includes('gpu:start'));
  assert.match(home({ status: 'draining', activeJobs: 1 }).text, /🖥 GPU: ставится на паузу, ждёт задач: 1/);
  assert.match(home({ status: 'starting' }).text, /🖥 GPU: запускается/);
  assert.match(home({ status: 'stopping' }).text, /🖥 GPU: останавливается/);
  assert.match(home({ status: 'error' }).text, /🖥 GPU: ошибка, открой «Модель» и обнови/);
  assert.match(home({ status: 'unknown' }).text, /🖥 GPU: состояние неизвестно/);
  for (const status of GPU_STATUSES) checkPayload(home({ status }), `home gpu ${status}`);
  assert.match(render(state, 'home', { gpuInfo: gpuInfo({ status: 'paused' }) }).text, /🏠 Меню\n\n🖥 GPU: на паузе\n\n/);

  // Scene provenance and scene keyboards are unchanged by GPU controls.
  assert.equal(scenePrefix(current(), { provider: 'llama-cpp', model: 'gemma' }), '_🤖 наш сервер · gemma · 📏 Контекст ≈ 5%_\n\n');
  assert.ok(!sceneKeyboard(state)!.inline_keyboard.flat().some(b => b.callback_data.startsWith('gpu:')));
});

test('compact now is offered only for the idle current branch', () => {
  const state = fixture();
  const idle = render(state, 'context', { contextStats: current() });
  checkPayload(idle, 'context idle');
  assert.equal(callbacks(idle)[0], 'compact');
  assert.match(idle.text, /Последние 4 сцены останутся целиком/);
  assert.match(idle.text, /в архиве/);
  assert.match(idle.text, /до и после сжатия будут чекпоинты/);
  assert.ok(callbacks(render(state, 'context')).includes('compact'));

  assert.ok(!callbacks(render(state, 'context:h2:c7', { contextStats: stats() })).includes('compact'));
  assert.ok(!callbacks(renderContext(current())).includes('compact'));
  assert.ok(!callbacks(renderContext(stats())).includes('compact'));
  state.active = null;
  assert.ok(!callbacks(render(state, 'context', { contextStats: current() })).includes('compact'));

  state.active = { storyId: 'h2', branchId: 'b3' };
  for (const kind of [undefined, 'scene', 'compact']) {
    state.job = partialJob({ id: 'j12', kind, storyId: 'h2', branchId: 'b3' });
    assert.ok(!callbacks(render(state, 'context', { contextStats: current() })).includes('compact'), String(kind));
    assert.ok(!callbacks(render(state, 'context')).includes('compact'), String(kind));
  }
});

test('busy labels distinguish compaction from scene generation', () => {
  const state = fixture();
  state.job = partialJob({ id: 'j12', kind: 'compact', storyId: 'h2', branchId: 'b3' });
  const home = render(state);
  assert.match(home.text, /⏳ Идёт сжатие памяти в истории/);
  assert.doesNotMatch(home.text, /Пишется сцена/);
  assert.ok(home.reply_markup!.inline_keyboard.flat().some(b => b.callback_data === 'cancel' && b.text === '✖️ Отменить сжатие'));
  assert.match(render(state, 'seed:s1').text, /Сейчас идёт сжатие памяти: начать историю или удалить сид можно будет после него/);
  assert.match(render(state, 'context', { contextStats: current() }).text, /Идёт сжатие памяти/);
  assert.match(render(state, 'new-seed').text, /Сжатие памяти, начатое раньше/);

  state.job = partialJob({ id: 'j13', kind: 'scene', storyId: 'h2', branchId: 'b3' });
  assert.match(render(state).text, /⏳ Пишется сцена в истории/);
  assert.match(render(state, 'seed:s1').text, /Сейчас пишется сцена: .* после неё/);
  assert.ok(render(state).reply_markup!.inline_keyboard.flat().some(b => b.text === '✖️ Отменить генерацию'));
});

test('missing measurements are unknown, never zero', () => {
  const partial = current({ lastRequest: { inputTokens: null, outputTokens: 500, totalTokens: null }, seed: { bytes: 1200, estimatedTokens: null }, request: null });
  const text = renderContext(partial).text;
  assert.match(text, /вход неизвестно · выход 500 · всего неизвестно/);
  assert.match(text, /Сид: 1\s200 Б · токены неизвестны/);
  assert.match(text, /оценки нет/);
  assert.match(renderContext(current({ lastRequest: null })).text, /нет измерений/);
  assert.match(renderContext(current({ budget: { inputTokens: null, limitTokens: 61440, remainingTokens: null } })).text, /Бюджет ввода \(окно минус резерв\): неизвестно из 61\s440/);
  checkPayload(renderContext(null), 'null stats');
});

test('context routes use only matching stats', () => {
  const state = fixture();
  const own = render(state, 'context:h2:c7', { contextStats: stats() });
  assert.match(own.text, /≈2\s500/);
  assert.ok(callbacks(own).includes('view:checkpoint:h2:c7'));

  const other = render(state, 'context:h2:c5', { contextStats: stats() });
  assert.doesNotMatch(other.text, /≈/);
  assert.ok(callbacks(other).includes('view:checkpoint:h2:c5'));

  const preview = render(state, 'checkpoint:h2:c7', { contextStats: stats() });
  assert.doesNotMatch(preview.text, /📏|≈|\d Б/);
  assert.ok(callbacks(preview).includes('view:context:h2:c7'));

  assert.match(render(state, 'context', { contextStats: current() }).text, /≈3\s250/);
  assert.doesNotMatch(render(state, 'context', { contextStats: current({ branchId: 'b8' }) }).text, /≈/);
  assert.doesNotMatch(render(state, 'context', { contextStats: stats() }).text, /≈/);
  assert.match(render(state, 'context').text, /пока нет/);
  checkPayload(render(state, 'context', null), 'null details');

  state.job = partialJob({ id: 'j12', storyId: 'h2', branchId: 'b3' });
  const busy = render(state, 'context', { contextStats: current() });
  assert.match(busy.text, /⏳/);
  assert.ok(callbacks(render(state)).includes('view:context'));

  state.job = null;
  state.active = null;
  assert.ok(callbacks(render(state, 'context', { contextStats: current() })).includes('view:seeds:0'));
  assert.ok(callbacks(render(state, 'context:h2:c99')).includes('view:home'));
});

test('scene keyboard follows state', () => {
  const state = fixture();
  assert.deepEqual(sceneKeyboard(state)!.inline_keyboard.flat().map(b => b.callback_data), ['continue', 'view:context', 'view:model', 'view:checkpoints:h2:b3:0', 'view:story:h2', 'view:home']);
  state.job = partialJob({ id: 'j12', storyId: 'h2', branchId: 'b3' });
  assert.deepEqual(sceneKeyboard(state)!.inline_keyboard.flat().map(b => b.callback_data), ['cancel', 'view:context', 'view:model', 'view:home']);
  state.job = null;
  state.active = null;
  assert.equal(sceneKeyboard(state), undefined);
});

test('the story tree folds straight runs, shows forks, saved checkpoints and the active branch in a pre block', () => {
  const state = fixture();
  const story = state.stories.h2;
  story.nodes.n12 = node('n12', 'n9', '2026-08-02 21:00', 'Шаги на лестнице.');
  story.nodes.n13 = node('n13', 'n12', '2026-08-02 21:20', 'Дверь открыта.');
  story.branches.b8.head = 'n13';
  story.checkpoints.c14 = { id: 'c14', branchId: 'b8', label: 'Перед дверью', kind: 'manual', head: 'n12', memory: null };
  state.active = { storyId: 'h2', branchId: 'b8' };
  story.nodes.n15 = node('n15', 'n6', '2026-08-02 22:00', 'Туман.');
  story.nodes.n16 = node('n16', 'n15', '2026-08-02 22:30', 'Колокол.');
  story.branches.b3.head = 'n16';
  story.checkpoints.c17 = { id: 'c17', branchId: 'b3', label: 'После сжатия', kind: 'compaction', head: 'n15', memory: null };
  const tree = ['🌱 начало', '└─ 1 сцена до 02.08 20:00', '  ├─ 2 сцены до 02.08 22:00 · 🗜 сжатие памяти', '  │ └─ 1 сцена до 02.08 22:30 · 🌿 Начало',
    '  └─ 2 сцены до 02.08 21:00 · 📍 Перед дверью', '    └─ 1 сцена до 02.08 21:20 · 🌿 От Сцена 1 ✅'].join('\n');
  const screen = render(state, 'tree:h2');
  assert.ok(screen.text.includes(tree));
  assert.deepEqual(screen.entities, [{ type: 'pre', offset: screen.text.indexOf(tree), length: tree.length }]);
  assert.ok(!screen.text.includes('Ветер бьёт'));
  assert.deepEqual(screen.reply_markup!.inline_keyboard.flat().map(b => b.callback_data), ['view:log:h2:b3:0', 'view:log:h2:b8:0', 'view:story:h2', 'view:home']);
  // The log of a branch reads like a commit log: every scene, newest first, with the names that point at it.
  story.checkpoints.c18 = { id: 'c18', branchId: 'b8', label: 'Сцена 3', kind: 'scene', head: 'n12', memory: null };
  const log = render(state, 'log:h2:b8:0');
  assert.match(log.text, /4\. 2026-08-02 21:20 · 🌿 От Сцена 1\n {3}✍️ Ввод\n3\. 2026-08-02 21:00 · 📍 Перед дверью\n {3}✍️ Ввод\n2\. 2026-08-02 20:40\n {3}✍️ Ввод\n1\. 2026-08-02 20:00 · ⑂ Начало/);
  assert.ok(!log.text.includes('Шаги на лестнице'));
  assert.deepEqual(log.reply_markup!.inline_keyboard.flat().map(b => b.callback_data),
    // Scene 4 has no checkpoint in this fixture, so it has no button; the bot saves one after every scene.
    ['view:checkpoint:h2:c14', 'view:checkpoint:h2:c11', 'view:checkpoint:h2:c5', 'view:tree:h2', 'view:branch:h2:b8', 'view:home']);
  assert.match(render(state, 'log:h2:missing:0').text, /не найдена/);
  assert.ok(render(state, 'story:h2').reply_markup!.inline_keyboard.flat().some(b => b.callback_data === 'view:tree:h2'));
  assert.match(render(state, 'tree:missing').text, /не найдена/);
});
