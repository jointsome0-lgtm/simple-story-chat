import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job, Library, SceneNode } from '../lib/library.ts';
import type { ContextStats } from './context.ts';
import type { InlineKeyboard, Screen } from './telegram.ts';
import type { GpuInfo, ModelInfo, RenderDetails } from './ui.ts';
import { render, renderContext, scenePrefix, sceneKeyboard } from './ui.ts';
import { personTag } from './picture.ts';
import { PRESETS } from './picture-style.ts';
import { texts } from './text.ts';

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
function drawn(): Library {
  const state = fixture();
  state.stories.h2.sheet = [{ name: 'Мира', look: 'Tall, short grey hair, a scar on the left cheek.', outfit: 'a dark wool coat' },
    { name: 'Олег', look: 'A broad-shouldered man with a shaved head.', outfit: 'a fisherman sweater' }];
  state.stories.h2.nodes.n5.clothes = { Мира: 'a yellow raincoat' };
  return state;
}
// A button names a person by their place on the sheet and the hash of their name (local/picture.ts `personTag`).
const mira = `h2:0:${personTag('Мира')}`, oleg = `h2:1:${personTag('Олег')}`;

// The story forked twice, with memory compacted on one line and a checkpoint saved on the other, which is played.
function forked(): Library {
  const state = fixture();
  const story = state.stories.h2;
  Object.assign(story.nodes, { n12: node('n12', 'n9', '2026-08-02 21:00', 'Шаги на лестнице.'), n13: node('n13', 'n12', '2026-08-02 21:20', 'Дверь открыта.'),
    n15: node('n15', 'n6', '2026-08-02 22:00', 'Туман.'), n16: node('n16', 'n15', '2026-08-02 22:30', 'Колокол.') });
  story.branches.b8.head = 'n13';
  story.branches.b3.head = 'n16';
  story.checkpoints.c14 = { id: 'c14', branchId: 'b8', label: 'Перед дверью', kind: 'manual', head: 'n12', memory: null };
  story.checkpoints.c17 = { id: 'c17', branchId: 'b3', label: 'После сжатия', kind: 'compaction', head: 'n15', memory: null };
  state.active = { storyId: 'h2', branchId: 'b8' };
  return state;
}

// The UI reads only a job's presence, kind and story; these jobs carry just that, including kinds the bot never writes.
const partialJob = (fields: { id: string; kind?: string; storyId: string; branchId: string }) => fields as Job;

const grid = (keyboard: InlineKeyboard | undefined) => keyboard?.inline_keyboard.map(row => row.map(button => button.callback_data));
const callbacks = (message: Screen) => grid(message.reply_markup)?.flat() ?? [];

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
  const on = { pictures: true, standardStyle: PRESETS.semi };
  const at = (fields: Partial<Library>, base = fixture()): Library => ({ ...base, ...fields });
  const job = (kind?: string) => partialJob({ id: 'j12', kind, storyId: 'h2', branchId: 'b3' });
  const menu = callbacks(render(drawn(), 'home', on));
  // The model screen's buttons, and whether it shows the GPU at all.
  const model = (details: RenderDetails) => { const screen = render(fixture(), 'model', details); return [callbacks(screen), screen.text.includes('🖥')]; };
  // [what, what is offered, what must be]
  const rows: Row[] = [
    // The scene's keyboard: going on while idle, cancel and a way around while busy, nothing without a story.
    ['scene keyboard while idle', grid(sceneKeyboard(fixture()))?.flat(), ['continue', 'view:context', 'view:model', 'view:checkpoints:h2:b3:0', 'view:story:h2', 'view:home']],
    ['scene keyboard while busy', grid(sceneKeyboard(at({ job: job() })))?.flat(), ['cancel', 'view:context', 'view:model', 'view:home']],
    ['scene keyboard without a story', sceneKeyboard(at({ active: null })), undefined],
    ['scene keyboard of a branch that is gone', sceneKeyboard(at({ active: { storyId: 'h2', branchId: 'gone' } })), undefined],
    // Compaction is offered for the live branch while idle, first on its context; never for a checkpoint or during a job.
    ['compaction of the idle current branch', callbacks(render(fixture(), 'context', { contextStats: current() }))[0], 'compact'],
    ['compaction of the idle current branch without stats', callbacks(render(fixture(), 'context')).includes('compact'), true],
    ['compaction at a checkpoint', callbacks(render(fixture(), 'context:h2:c7', { contextStats: stats() })).includes('compact'), false],
    ['compaction from the detailed view', [current(), stats()].some(one => callbacks(renderContext(one)).includes('compact')), false],
    ['compaction without a story', callbacks(render(at({ active: null }), 'context', { contextStats: current() })).includes('compact'), false],
    ...[undefined, 'scene', 'compact'].map((kind): Row => [`compaction during a job of kind ${kind}`,
      [{ contextStats: current() }, {}].some(details => callbacks(render(at({ job: job(kind) }), 'context', details)).includes('compact')), false]),
    // Characters: beside each story only for a reader whose scenes are drawn; a list, a card, a look to write.
    ...['home', 'seed:s1', 'story:h2'].map((route): Row => [`the way to characters from ${route}, with and without pictures`,
      [on, {}].map(details => callbacks(render(fixture(), route, details)).includes('view:characters:h2')), [true, false]]),
    ['characters before the first picture', callbacks(render(fixture(), 'characters:h2', on)), ['view:story:h2', 'view:home']],
    ['characters of a sheet', callbacks(render(drawn(), 'characters:h2', on)), [`view:character:${mira}`, `view:character:${oleg}`, 'view:story:h2', 'view:home']],
    ['a card with pictures', callbacks(render(drawn(), `character:${mira}`, on)), [`look-edit:${mira}`, `portrait:${mira}`, 'view:characters:h2']],
    ['a card without pictures', callbacks(render(drawn(), `character:${mira}`)), [`look-edit:${mira}`, 'view:characters:h2']],
    // Somebody not on the sheet, or a button of one whose place another person took since, is the list, never a card.
    ...['character:h2:7', 'character:h2:x', 'character:h2:0', 'character:h2:0:00000000', `character:h2:1:${personTag('Мира')}`].map((route): Row =>
      [`a stale person: ${route}`, callbacks(render(drawn(), route, on)), callbacks(render(drawn(), 'characters:h2', on))]),
    ['a look without the wait for one', callbacks(render(drawn(), 'look-input', on)), menu],
    ['a look for Мира', callbacks(render(at({ ui: { input: 'look', storyId: 'h2', name: 'Мира' } }, drawn()), 'look-input', on)), [`view:character:${mira}`]],
    ['a look for somebody gone from the sheet', callbacks(render(at({ ui: { input: 'look', storyId: 'h2', name: 'Нет такой' } }, drawn()), 'look-input', on)), menu],
    // A portrait's keep button carries its own candidate; a portrait of somebody not found offers none.
    ['a portrait', grid(render(drawn(), `portrait:${mira}:0a1b2c3d`, on).reply_markup), [[`portrait:${mira}`, 'portrait-keep:0a1b2c3d'], [`view:character:${mira}`]]],
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
    // A new seed: an example to copy in one tap, and a way out of the wait for a seed.
    ['a new seed', (screen => [screen.entities?.map(e => [e.type, screen.text.slice(e.offset, e.offset + e.length)]), callbacks(screen)])(render(fixture(), 'new-seed')),
      [[['pre', texts('ru').newSeed.example]], ['cancel']]],
    // The story tree: a straight run of scenes is one line, which ends where the story forks or a name points at it, the
    // branch being played marked among them, in a pre block that keeps it monospaced. A branch's log is newest first.
    ['the story tree', (screen => [screen.entities?.map(e => screen.text.slice(e.offset, e.offset + e.length)), callbacks(screen)])(render(forked(), 'tree:h2')),
      [[['🌱 начало', '└─ 1 сцена до 02.08 20:00', '  ├─ 2 сцены до 02.08 22:00 · 🗜 сжатие памяти', '  │ └─ 1 сцена до 02.08 22:30 · 🌿 Начало',
        '  └─ 2 сцены до 02.08 21:00 · 📍 Перед дверью', '    └─ 1 сцена до 02.08 21:20 · 🌿 От Сцена 1 ✅'].join('\n')],
      ['view:log:h2:b3:0', 'view:log:h2:b8:0', 'view:story:h2', 'view:home']]],
    ['a branch\'s log', render(forked(), 'log:h2:b8:0').text.match(/^\d+\./gm), ['4.', '3.', '2.', '1.']],
    // A stale or malformed route leads back to the menu or the seeds.
    ...['seed:s99', 'story:h99', 'branch:h2:b99', 'checkpoints:h9:b3:0', 'checkpoint:h2:c99', 'delete-seed:s99', 'delete-branch:h2:b99', 'seed:constructor',
      'story:__proto__', 'nonsense', '', 'seeds:-1', 'seeds:abc', 'context:h2:c99', 'characters:h99', 'tree:h99', 'log:h2:b99:0'].map((route): Row =>
      [`the stale route "${route}"`, callbacks(render(fixture(), route)).some(data => data === 'view:home' || data === 'view:seeds:0'), true]),
    ['no library at all', callbacks(render(null, 'home')).includes('new-seed'), true],
  ];
  for (const [label, got, want] of rows) assert.deepEqual(got, want, label);
});

test('a screen says what it shows: what a deletion takes, a job, the context, the model and the GPU, and a number it lacks as unknown', () => {
  const t = texts('ru');
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

  // [what, the screen with the number missing, the same with a zero]: a missing number reads as unknown, not as 0.
  const card = (textTokens?: RenderDetails['textTokens']) => render(drawn(), `character:${mira}`, { pictures: true, textTokens }).text;
  const jobs = (activeJobs: number | null) => render(fixture(), 'model', { modelInfo: modelInfo(), gpuInfo: gpuInfo({ activeJobs }) }).text;
  const context = (overrides: Record<string, unknown>) => renderContext(current(overrides)).text;
  const unknowns: [string, string, string][] = [
    ['the last request', context({ lastRequest: { inputTokens: null, outputTokens: 500, totalTokens: null } }),
      context({ lastRequest: { inputTokens: 0, outputTokens: 500, totalTokens: 500 } })],
    ['the tokens of the seed', context({ seed: { bytes: 1200, estimatedTokens: null } }), context({ seed: { bytes: 1200, estimatedTokens: 0 } })],
    ['the input budget', context({ budget: { inputTokens: null, limitTokens: 61440, remainingTokens: null } }),
      context({ budget: { inputTokens: 0, limitTokens: 61440, remainingTokens: 61440 } })],
    ['the jobs on the GPU', jobs(null), jobs(0)],
    ...[undefined, () => { throw new Error('vocabulary'); }, () => null].map((count, n): [string, string, string] => [`the tokens of a look, counter ${n}`, card(count), card(() => 0)]),
  ];
  for (const [label, missing, zero] of unknowns) assert.ok(missing !== zero && /неизвестн/.test(missing), label);
  // A card counts the look and the clothes each on its own, never their sum.
  const words = card(text => text.split(' ').length);
  assert.ok(words.includes(t.characters.lookSize(10, 48)) && words.includes(t.characters.clothesSize(3, 17)) && !/13 токенов|dark wool coat/.test(words), 'a card');
  // A share of the context the scene header cannot know is left out rather than shown as 0 %.
  for (const unknown of [null, undefined, {} as ContextStats, current({ request: null }), current({ request: { estimatedTokens: null } }), current({ limitTokens: null }), current({ limitTokens: 0 })]) {
    assert.equal(scenePrefix(unknown), '', JSON.stringify(unknown));
  }
  assert.notEqual(scenePrefix(current({ request: { estimatedTokens: 0, estimateSource: 'usage' } })), '', 'a known zero');
  // The header names a model only from the scene's own provenance, and keeps its name out of Markdown.
  const gemma = scenePrefix(current(), { provider: 'llama-cpp', model: 'gemma_4*31b [Q4_K_M].gguf`' });
  assert.ok(gemma.startsWith('_🤖 ') && !/[_*`[\]()<>.\\]/.test(gemma.slice(1, -3)), gemma);
  for (const missing of [undefined, null, {}, { provider: 'llama-cpp' }, { provider: 'other', model: 'x' }]) assert.doesNotMatch(scenePrefix(current(), missing), /🤖/);

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

  // A pause is Vast's confirmed stop, with the disk still paid for; a state the bot does not know is never a pause.
  const gpu = (overrides: Record<string, unknown>) => render(fixture(), 'model', { modelInfo: modelInfo(), gpuInfo: gpuInfo(overrides) }).text;
  const paused = gpu({ status: 'paused', canStart: true, canPause: false });
  assert.ok(paused.includes(t.gpu.paused) && /диск оплачивается/.test(paused), 'a paused GPU');
  for (const status of ['unknown', 'error', 'weird', undefined]) assert.ok(!gpu({ status, canPause: false }).includes(t.gpu.paused), `a GPU ${status}`);
  // Only a count of the jobs, nothing about who runs them.
  assert.doesNotMatch(gpu({ activeJobs: 3, users: ['Алиса'], storyTitle: 'Секрет' }), /Алиса|Секрет/);

  // What a screen says of the state it shows: [what, the text and its buttons, what it says, what it must not say].
  const c = t.context, num = t.format.number;
  const during = (kind: string, route: string) => (screen => [screen.text, ...(screen.reply_markup?.inline_keyboard.flat() ?? []).map(button => button.text)].join('\n'))(
    render({ ...fixture(), job: partialJob({ id: 'j12', kind, storyId: 'h2', branchId: 'b3' }) }, route, { contextStats: current() }));
  const home = (details: RenderDetails) => render(fixture(), 'home', details).text;
  const says: [string, string, string[], string[]][] = [
    // A compaction and a scene are told apart wherever a job shows.
    ...[['the menu', 'home', t.home.compactJobNote, t.home.sceneJobNote], ['the cancel button', 'home', t.buttons.cancelCompaction, t.buttons.cancelScene],
      ['a seed', 'seed:s1', t.busy.compact.startOrDeleteSeed, t.busy.scene.startOrDeleteSeed], ['the context', 'context', c.duringCompaction, c.duringScene],
      ['a new seed', 'new-seed', t.newSeed.compactRunning, t.newSeed.sceneRunning]].flatMap(([what, route, compact, scene]): [string, string, string[], string[]][] =>
      [[`${what} during a compaction`, during('compact', route), [compact], [scene]], [`${what} during a scene`, during('scene', route), [scene], [compact]]]),
    // The detailed context: a budget used up is a warning, an estimate says how rough it is, a compacted memory has its
    // parts, and the last request's input comes before its output.
    ['a budget used up', renderContext(current({ budget: { inputTokens: 62000, limitTokens: 61440, remainingTokens: -560 } })).text, [c.exhausted], [c.remaining(num(-560))]],
    ['an estimate from bytes', renderContext(current({ request: { bytes: 13000, estimatedTokens: 3250, estimateSource: 'bytes' } })).text, [c.estimateFromBytes], [c.estimateFromUsage]],
    ['an estimate from usage', renderContext(current()).text, [c.estimateFromUsage, c.lastRequest(num(2700), num(500), num(3200))], [c.estimateFromBytes]],
    ['a compacted memory', renderContext(current({ memory: { count: 2, bytes: 900, estimatedTokens: 225 } })).text, [t.count.parts(2)], [c.memoryEmpty]],
    // A model has answered only after a check it passed, and the menu's line about the GPU says what the GPU does.
    ['a model never checked', render(fixture(), 'model', { modelInfo: modelInfo({ status: 'configured' }) }).text, [t.model.configured], [t.model.readyNote]],
    ['the menu of a model that failed its check', home({ modelInfo: modelInfo({ status: 'unavailable' }) }), [t.model.short.unavailable], []],
    ...([['draining', t.gpu.short.draining(2)], ['paused', t.gpu.short.paused], ['weird', t.gpu.short.unknown]] as const).map(([status, short]): [string, string, string[], string[]] =>
      [`the menu with a GPU ${status}`, home({ modelInfo: modelInfo(), gpuInfo: gpuInfo({ status, activeJobs: 2 }) }), [t.home.gpu(short)], status === 'paused' ? [] : [t.home.gpu(t.gpu.short.paused)]]),
  ];
  for (const [label, text, said, unsaid] of says) {
    for (const part of said) assert.ok(text.includes(part), `${label}: ${part}`);
    for (const part of unsaid) assert.ok(!text.includes(part), `${label}: ${part}`);
  }
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
  assert.ok(draft.text.length < 1000 && !draft.text.includes('xxx'), 'a 50,000-character draft');
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
