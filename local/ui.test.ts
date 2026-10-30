import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Library, SceneNode } from '../lib/library.ts';
import type { ContextStats } from './context.ts';
import type { InlineKeyboard, Screen } from './telegram.ts';
import type { GpuInfo, ModelInfo, RenderDetails } from './ui.ts';
import { render, renderContext, sceneKeyboard } from './ui.ts';
import { personTag } from './picture.ts';
import { PRESETS } from './picture-style.ts';
import { texts } from './text.ts';

const t = texts('ru');

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

// The story's people as its first picture wrote them, and a first scene that dressed Мира otherwise than the sheet did.
const LOOK = 'Tall, short grey hair, a scar on the left cheek.';
function drawn(): Library {
  const state = fixture();
  state.stories.h2.sheet = [{ name: 'Мира', look: LOOK, outfit: 'a dark wool coat' },
    { name: 'Олег', look: 'A broad-shouldered man with a shaved head.', outfit: 'a fisherman sweater' }];
  state.stories.h2.nodes.n5.clothes = { Мира: 'a yellow raincoat' };
  return state;
}
// A reader whose scenes are drawn, with the semi preset as the owner's standard line.
const on = { pictures: true, standardStyle: PRESETS.semi };
// A button names a person by their place on the sheet and the hash of their name (local/picture.ts `personTag`).
const mira = `h2:0:${personTag('Мира')}`;

// An owned style is removable only through its confirmation.
const styled = (): Library => ({ ...fixture(), pictureStyles: { y7: { id: 'y7', name: 'Масло при свечах', line: 'Oil painting, warm candlelight' } }, pictureStyle: 'y7' });
// A seed being collected from the parts sent so far.
const drafting = (parts: string[]): Library => ({ ...fixture(), ui: { input: 'seed', draftId: 'd123', parts } });
const TWO_PARTS = ['Маяк\n2026-08-02 20:00\nСеверный остров.', 'Вторая часть описания.'];

// The UI reads only a job's presence, kind and story; these jobs carry just that, including kinds the bot never writes.
const partialJob = (fields: { id: string; kind?: string; storyId: string; branchId: string }) => fields as Job;

const grid = (keyboard: InlineKeyboard | undefined) => keyboard?.inline_keyboard.map(row => row.map(button =>
  button.web_app ? `web_app:${button.web_app.url}` : button.callback_data));
const callbacks = (message: Screen) => grid(message.reply_markup)?.flat() ?? [];
// What a screen puts in pre blocks, to be copied in one tap or kept monospaced, and its buttons.
const preAndButtons = (screen: Screen) => [screen.entities?.map(e => e.type === 'pre' ? screen.text.slice(e.offset, e.offset + e.length) : e.type), callbacks(screen)];

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

function modelInfo(overrides: ModelInfo = {}): ModelInfo {
  return { provider: 'llama-cpp', model: 'gemma-4-31b-heretic-Q4_K_M', status: 'ready', checkedAt: '2026-09-16T10:05:30.000Z', ...overrides };
}

// GPU status is rendered defensively, so overrides can replace any field with any value.
function gpuInfo(overrides: Record<string, unknown> = {}) {
  return { status: 'ready', activeJobs: 0, idleMinutes: 15, idleRemainingSeconds: 600, canStart: false, canPause: true, ...overrides } as GpuInfo;
}

type Row = [string, unknown, unknown];

test('each state offers only the actions it allows: the scene keyboard, compaction, characters, the GPU and stale routes', () => {
  const at = (fields: Partial<Library>, base = fixture()): Library => ({ ...base, ...fields });
  const job = (kind?: string) => partialJob({ id: 'j12', kind, storyId: 'h2', branchId: 'b3' });
  const menu = callbacks(render(drawn(), 'home', on));
  // The model screen's buttons, and whether it shows the GPU at all.
  const model = (details: RenderDetails) => { const screen = render(fixture(), 'model', details); return [callbacks(screen), screen.text.includes('🖥')]; };
  // [what, what is offered, what must be]
  const rows: Row[] = [
    // The scene's keyboard: going on while idle, cancel and a way around while busy, nothing without a story.
    ['scene keyboard while idle', grid(sceneKeyboard(fixture()))?.flat(), ['continue', 'again:h2:n6', 'view:checkpoints:h2:b3:0', 'view:story:h2', 'view:home']],
    ['scene keyboard while busy', grid(sceneKeyboard(at({ job: job() })))?.flat(), ['cancel', 'view:context', 'view:model', 'view:home']],
    ['scene keyboard without a story', sceneKeyboard(at({ active: null })), undefined],
    ['scene keyboard of a branch that is gone', sceneKeyboard(at({ active: { storyId: 'h2', branchId: 'gone' } })), undefined],
    // Compaction is offered for the live branch while idle, first on its context; never for a checkpoint or during a job.
    ['compaction of the idle current branch', callbacks(render(fixture(), 'context', { contextStats: current() }))[0], 'compact'],
    ['compaction of the idle current branch without stats', callbacks(render(fixture(), 'context')).includes('compact'), true],
    ['compaction at a checkpoint', callbacks(render(fixture(), 'context:h2:c7', { contextStats: stats() })).includes('compact'), false],
    ['the detailed views of the branch and of a checkpoint', [current(), stats()].map(one => callbacks(renderContext(one))),
      [['view:context', 'view:checkpoints:h2:b3:0', 'view:home'], ['view:checkpoint:h2:c7', 'view:home']]],
    ['compaction without a story', callbacks(render(at({ active: null }), 'context', { contextStats: current() })).includes('compact'), false],
    ...[undefined, 'scene', 'compact'].map((kind): Row => [`compaction during a job of kind ${kind}`,
      [{ contextStats: current() }, {}].some(details => callbacks(render(at({ job: job(kind) }), 'context', details)).includes('compact')), false]),
    // Character navigation is gated on pictures; stale person buttons never select another person.
    ...['home', 'seed:s1', 'story:h2'].map((route): Row => [`the way to characters from ${route}, with and without pictures`,
      [on, {}].map(details => callbacks(render(fixture(), route, details)).includes('view:characters:h2')), [true, false]]),
    // Somebody not on the sheet, or a button of one whose place another person took since, is the list, never a card.
    ...['character:h2:7', 'character:h2:x', 'character:h2:0', 'character:h2:0:00000000', `character:h2:1:${personTag('Мира')}`].map((route): Row =>
      [`a stale person: ${route}`, callbacks(render(drawn(), route, on)), callbacks(render(drawn(), 'characters:h2', on))]),
    ['a look without the wait for one', callbacks(render(drawn(), 'look-input', on)), menu],
    ['a look for Мира', preAndButtons(render(at({ ui: { input: 'look', storyId: 'h2', name: 'Мира' } }, drawn()), 'look-input', on)), [[LOOK], [`view:character:${mira}`]]],
    ['a look for somebody gone from the sheet', callbacks(render(at({ ui: { input: 'look', storyId: 'h2', name: 'Нет такой' } }, drawn()), 'look-input', on)), menu],
    ...[`portrait:h99:0:${personTag('Мира')}:0a1b2c3d`, `portrait:h2:7:${personTag('Мира')}:0a1b2c3d`, `portrait:h2:1:${personTag('Мира')}:0a1b2c3d`, 'portrait-kept:h2:7']
      .map((route): Row => [`a stale portrait: ${route}`, callbacks(render(drawn(), route, on)).some(data => data.startsWith('portrait')), false]),
    // GPU power follows canStart and canPause alone, whatever the status says; there is no GPU for Claude or without one.
    ...[[false, false], [true, false], [false, true], [true, true], [undefined, 'yes']].flatMap(([canStart, canPause]) =>
      ['ready', 'paused', 'weird', undefined].map((status): Row => [`GPU ${status}, start ${canStart}, pause ${canPause}`,
        model({ modelInfo: modelInfo(), gpuInfo: gpuInfo({ status, canStart, canPause }) }),
        [[...canStart === true ? ['gpu:start'] : [], ...canPause === true ? ['gpu:pause'] : [], 'view:model', 'view:home'], true]])),
    ['GPU without model data', model({ gpuInfo: gpuInfo({ status: 'paused', canStart: true, canPause: false }) }), [['gpu:start', 'view:model', 'view:home'], true]],
    ['GPU for Claude', model({ modelInfo: modelInfo({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' }), gpuInfo: gpuInfo({ canStart: true }) }),
      [['view:model', 'view:home'], false]],
    ...[undefined, null, 'ready'].map((gpu): Row => [`GPU info ${gpu}`, model({ modelInfo: modelInfo(), gpuInfo: gpu as GpuInfo | null | undefined }), [['view:model', 'view:home'], false]]),
    // The menu has a line about the GPU and never its controls.
    ...[{ status: 'paused', canStart: true }, { status: 'ready', activeJobs: 2 }].map((gpu): Row => [`the menu with a GPU ${gpu.status}`,
      (screen => [screen.text.includes('🖥'), callbacks(screen).some(data => data.startsWith('gpu:'))])(render(fixture(), 'home', { modelInfo: modelInfo(), gpuInfo: gpuInfo(gpu) })),
      [true, false]]),
    ['the menu for Claude', render(fixture(), 'home', { modelInfo: modelInfo({ provider: 'claude-code' }), gpuInfo: gpuInfo() }).text.includes('🖥'), false],
    // Style input and deletion require their own active state or confirmation.
    ['a style without the wait for one', callbacks(render(styled(), 'style-input', on)), callbacks(render(styled(), 'style', on))],
    ['the deletion of a style', callbacks(render(styled(), 'delete-style:y7', on)), ['remove-style:y7', 'view:style:y7']],
    ['the deletion of a style that is gone', callbacks(render(styled(), 'delete-style:y8', on)), callbacks(render(styled(), 'style', on))],
    // Tree and history navigation must not repeat the scene text.
    ...['tree:h2', 'log:h2:b8:0'].map((route): Row => [route, /Ветер бьёт|Огонь гаснет/.test(render(fixture(), route).text), false]),
    // A stale or malformed route leads back to the menu or the seeds.
    ...['seed:s99', 'story:h99', 'branch:h2:b99', 'checkpoints:h9:b3:0', 'checkpoint:h2:c99', 'delete-seed:s99', 'delete-branch:h2:b99', 'seed:constructor',
      'story:__proto__', 'nonsense', '', 'seeds:-1', 'seeds:abc', 'context:h2:c99', 'characters:h99', 'tree:h99', 'log:h2:b99:0'].map((route): Row =>
      [`the stale route "${route}"`, callbacks(render(fixture(), route)).some(data => data === 'view:home' || data === 'view:seeds:0'), true]),
    ['no library at all', callbacks(render(null, 'home')).includes('new-seed'), true],
  ];
  for (const [label, got, want] of rows) assert.deepEqual(got, want, label);
  // All mutating story routes, especially a confirmation opened before the job began, become inert while busy.
  const mutations = /^(start|use|fork|again|remove-seed|remove-branch):|^(continue|retry|compact)$|^view:delete-/;
  for (const kind of ['scene', 'compact']) {
    const state = at({ job: job(kind) });
    for (const route of ['home', 'seed:s1', 'story:h2', 'branch:h2:b3', 'checkpoint:h2:c5', 'context',
      'delete-seed:s1', 'delete-branch:h2:b3']) {
      for (const data of callbacks(render(state, route))) assert.doesNotMatch(data, mutations, `${kind}: ${route}`);
    }
  }

});

test('deletion names its scope, stats belong to their checkpoint and GPU status exposes no reader data', () => {
  const single = fixture();
  delete single.stories.h2.branches.b8;
  for (const id of ['c10', 'c11']) delete single.stories.h2.checkpoints[id];
  delete single.stories.h2.nodes.n9;
  // [what, the confirmation, what it says goes]
  const scopes: [string, Screen, RegExp[]][] = [
    ['a seed', render(fixture(), 'delete-seed:s1'), [/1 история/, /2 ветки/, /3 сцены/]],
    ['a branch beside another', render(fixture(), 'delete-branch:h2:b3'), [/3 чекпоинта/, /1 сцена, которой нет в других ветках/, /1 другая ветка/]],
    ['the only branch', render(single, 'delete-branch:h2:b3'), [/история удалится целиком/]],
  ];
  for (const [label, screen, says] of scopes) for (const scope of says) assert.match(screen.text, scope, label);
  assert.deepEqual(scopes.map(([, screen]) => callbacks(screen).filter(data => data.startsWith('remove-'))),
    [['remove-seed:s1'], ['remove-branch:h2:b3'], ['remove-branch:h2:b3']]);
  for (const route of ['home', 'seed:s1', 'story:h2', 'branch:h2:b3'])
    assert.ok(!callbacks(render(fixture(), route)).some(data => data.startsWith('remove-')), route);


  // A context screen shows only the stats that are its own.
  const shown: [string, Screen, boolean][] = [
    ['checkpoint c7 with its stats', render(fixture(), 'context:h2:c7', { contextStats: stats() }), true],
    ['checkpoint c5 with those of c7', render(fixture(), 'context:h2:c5', { contextStats: stats() }), false],
    ['the preview of checkpoint c7', render(fixture(), 'checkpoint:h2:c7', { contextStats: stats() }), false],
    ['the current branch with its stats', render(fixture(), 'context', { contextStats: current() }), true],
    ['the current branch with those of another branch', render(fixture(), 'context', { contextStats: current({ branchId: 'b8' }) }), false],
    ['the current branch with those of a checkpoint', render(fixture(), 'context', { contextStats: stats() }), false],
  ];
  for (const [label, screen, numbers] of shown) assert.equal(/≈\d/.test(screen.text), numbers, label);

  // A paused card names no price and does not promise that a message starts it. The jobs are a count, never whose.
  const gpu = (overrides: Record<string, unknown>) => render(fixture(), 'model', { modelInfo: modelInfo(), gpuInfo: gpuInfo(overrides) }).text;
  assert.doesNotMatch(gpu({ status: 'paused', activeJobs: 0, canStart: true, canPause: false }), /\$|₽|руб|USD|\/ч|бесплатн|напиши|сообщени/i, 'a paused GPU');
  assert.doesNotMatch(gpu({ activeJobs: 3, users: ['Алиса'], storyTitle: 'Секрет' }), /Алиса|Секрет/);

  for (const status of ['error', 'weird', undefined]) assert.ok(!gpu({ status }).includes(t.gpu.paused), 'unknown is not stopped');
  const draft = render(drafting(TWO_PARTS), 'new-seed');
  assert.doesNotMatch(draft.text, /Маяк|Северный остров|Вторая часть/, 'a draft receipt does not repeat story text');
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

  // A seed pasted in parts: the receipt counts them without repeating any, and keeps its save and cancel.
  state.ui = { input: 'seed', draftId: 'd456', parts: ['x'.repeat(50000)] };
  const draft = render(state, 'new-seed');
  assert.ok(draft.text.length < 1000 && draft.text.includes(t.draft.received(1, 50000)) && !draft.text.includes('xxx'), 'a 50,000-character draft');
  assert.deepEqual(callbacks(draft), ['save-seed:d456', 'cancel']);
  state.ui = null;

  // Every screen a button reaches fits one Telegram message.
  const queue = ['home', 'new-seed'], seen = new Set<string>();
  while (queue.length) {
    const route = queue.shift()!;
    if (seen.has(route)) continue;
    seen.add(route);
    const screen = render(state, route);
    assert.ok(screen.text.length > 0 && screen.text.length <= 4096, `${route}: ${screen.text.length} characters`);
    for (const data of callbacks(screen)) if (data.startsWith('view:')) queue.push(data.slice(5));
  }
  assert.ok(seen.size > 100, 'the crawl reaches the long library');
});
