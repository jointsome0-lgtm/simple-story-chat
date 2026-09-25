// The text run of the action measurement (docs/action-experiment.md#text-run): for each of the 18 stories, the
// sharp seed where there is one, the opening and the action scene by the bot's `generateScene`, the sheet, the bot's
// frame and the variant frame, every call the bot's own through one provider as class `internal`. Each reply is
// decided by the rules the doc fixes, every attempt is recorded as counts and times, and nothing is asked again by
// choice. A story's words stay in its own directory, `sealed/<id>/` for a sharp one; what this file prints and writes
// at the run's level is ids, codes, counts and times.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { performance } from 'node:perf_hooks';
import { addSeed, beginJob, commitTurn, newStory } from '../lib/library.ts';
import { ACTION_STORIES, MARKER_STORY, SHARP_SCHEMA, SHARP_START_TIME, SHARP_THEMES, SHARP_TOKENS, actionSetHash,
  sharpInstruction } from '../examples/action-set.ts';
import { capture, madeUpName, markerForms, searchBoundary, searchTree } from './action-boundary.ts';
import { loadModelConfig } from './config.ts';
import type { Env, ModelConfig } from './config.ts';
import { generateScene } from './generation.ts';
import { askJson, frameRequest, sheetOf, sheetRequest } from './illustrate.ts';
import type { Character, Description, Excerpt } from './illustrate.ts';
import { createLlama } from './llama.ts';
import { safeErrorDetails } from './model-error.ts';
import type { ErrorDetails } from './model-error.ts';

// What a failed call may say beyond its code: the fields of `safeErrorDetails` that describe a request, and no other.
type Details = Pick<ErrorDetails, 'httpStatus' | 'phase' | 'transportCode' | 'servingCode' | 'exitCode' | 'signal'>;
export function detailsOf(error: unknown): Details {
  const { httpStatus, phase, transportCode, servingCode, exitCode, signal } = safeErrorDetails(error);
  return Object.fromEntries(Object.entries({ httpStatus, phase, transportCode, servingCode, exitCode, signal })
    .filter(([, value]) => value !== undefined)) as Details;
}
import type { ModelRequest, Provider } from './model.ts';
import { rewrittenSheet, wornAt } from './picture.ts';
import { contextParts, normalizeScene, storyNarration } from './prompt.ts';
import { createServing } from './serving.ts';
import { Store } from './store.ts';

const ROOT = resolve(import.meta.dirname, '..');
const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
export const readJson = <T>(file: string): T | undefined => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : undefined);

// ---- The variant frame (docs/action-experiment.md#variant) ----

// The owner's draft of the seven changes as nine replacements in the bot's instruction (local/illustrate.ts
// `instruction`), with the coordinator's amendments of 2026-09-25: a role of two to eight words, and the facing line
// with `other`. Each `from` must stand in the bot's text exactly once; `to` replaces it. Items 7 and 8 keep their text
// and add a sentence, item 9 adds four lines before the shot's.
export const VARIANT_CHANGES: { from: string; to: string }[] = [
  { from: '- Выбери ОДИН конкретный момент сцены, до или после сложного контакта, и сохрани',
    to: '- Выбери ОДИН конкретный момент сцены: главное действие, к которому она пришла в конце, в тот миг, когда оно происходит, а не до и не после него, и сохрани' },
  { from: '- Не больше четырёх человек. Если в моменте их больше, выбери тесный ракурс, который естественно оставляет остальных за краем кадра; не показывай часть группы как всю группу.',
    to: '- В кадре все участники главного действия, до шести: люди, животные и существа, каждый отдельной записью в people, даже если они похожи (два стражника — две записи). Тех, кто только смотрит, можно оставить за кадром. Если участников больше шести, выбери ракурс, который естественно оставляет лишних за краем кадра; не показывай часть группы как всю группу.' },
  { from: '- people: каждый человек, который должен быть виден, отдельной записью',
    to: '- people: каждый участник, человек, животное или существо, который должен быть виден, отдельной записью' },
  { from: 'Без имён: the commander, the shield-bearer, the two dancers.', to: 'Без имён: называй участников их role.' },
  { from: 'Имён не должно быть НИ В ОДНОМ поле, кроме who: пиши he, she, the shield-bearer.',
    to: 'Имён не должно быть НИ В ОДНОМ поле, кроме who: называй участников их role.' },
  { from: '- props: одно предложение по-английски: у каждого важного предмета один владелец и одно состояние, и у кого руки пусты ("The gray-clad woman holds the only dagger in her right hand; the blond man carries the one steel shield, his other hand is empty."). Людей называй по заметной примете, без имён. Пустая строка, если важных предметов нет.',
    to: '- props: одно предложение по-английски: каждый важный предмет один раз, его состояние и все, кто его держит, каждый своей role и тем, где он держит ("the stretcher, its front handles held by the front-left carrier and the front-right carrier"). Пустая строка, если важных предметов нет.' },
  { from: 'Скрывай такие детали ракурсом: экран повёрнут тыльной стороной к зрителю, кончик инструмента закрыт руками.',
    to: 'Скрывай такие детали ракурсом: экран повёрнут тыльной стороной к зрителю, кончик инструмента закрыт руками. Это правило о мелких предметах; касания участников главного действия друг друга не скрывай.' },
  { from: 'В тесной сцене с несколькими людьми бери средне-общий план в три четверти, а не эффектный нижний ракурс.',
    to: 'В тесной сцене с несколькими людьми бери средне-общий план в три четверти, а не эффектный нижний ракурс. Все касания главного действия в кадре: край кадра не режет руку, ногу или тело там, где они касаются другого участника; не бери план «по пояс», если касаются колени или ноги. Касание может быть закрыто телом другого участника, если так они стоят в сцене, но не краем кадра.' },
  { from: '\n- shot: ', to: `
- role — поле каждой записи people: 2-8 английских слов, одна фраза для одного участника, ни для кого больше, слово в слово везде, где moment, props, state и action называют этого участника. Она называет его место в главном действии и в кадре, с явным владельцем всего, что в ней упомянуто ("the running father", "the girl in the father's left arm", "the rear lifter of the near pod"), и никогда не внешность и не имя. Вид и масштаб оставь, если на них стоит сцена ("the crouching giant", "the tiny sailor").
- facing — поле каждой записи people: куда обращена передняя сторона корпуса участника, как видит камера. viewer — к зрителю; away — спиной к зрителю; screen-left — в профиль, к левому краю кадра; screen-right — в профиль, к правому краю; other — когда ни одно из четырёх не подходит: у существа нет переда, или корпус направлен вверх или вниз по кадру (лежащий на спине, снятый сбоку). Вид в три четверти — ближайшее значение; ровно посередине — то, что ближе к viewer. Лежащий лицом вверх под камерой сверху — viewer, лицом вниз — away. facing говорит только о кадре: left и right в остальных полях — по-прежнему стороны самого участника; в профиль к левому краю кадра к камере обращён его собственный левый бок. Куда повёрнута голова и куда он смотрит — в action, не сюда.
- Внешность только в look: ни волос, ни лица, ни кожи, ни телосложения, ни возраста, ни цвета одежды в moment, shot, setting, objects, props, role, state и action; одежда только в clothes. Можно и нужно: выражение лица, свежие раны и повязки, части тела в касании и часть одежды как место хвата ("grips his collar").
- Если сцена говорит, куда участник смотрит или что делает его лицо, это часть его action ("looks back over his right shoulder", "snarls"). Если лицо отвёрнуто от зрителя, оставь, куда он смотрит, но не выдумывай выражение, которого не видно.
- shot: ` },
];
export const FACINGS = ['viewer', 'away', 'screen-left', 'screen-right', 'other'] as const;
export type Facing = typeof FACINGS[number];
export type VariantPerson = { who: string; role: string; facing: Facing; look: string; clothes: string; state: string; action: string };
export type VariantFrame = Omit<Description, 'people'> & { people: VariantPerson[] };
// Twice the bot's 900: stage 1's longest variant took 710 with six people before role and facing were asked for.
export const VARIANT_TOKENS = 1800;

// `from` replaced by `to`, where `from` stands in `text` exactly once; anything else is a variant that no longer fits
// the bot's instruction, and the run does not start.
export function once(text: string, from: string, to: string): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw Object.assign(new Error('variant_anchor'), { code: 'variant_anchor' });
  return text.slice(0, at) + to + text.slice(at + from.length);
}

export type Schema = { type?: string | string[]; enum?: unknown[]; properties?: Record<string, Schema>; required?: string[];
  additionalProperties?: boolean; items?: Schema; maxItems?: number; minItems?: number };
// The bot's frame request with the changes, the people up to six, and `role` and `facing` required right after
// `who`, so that the model writes them before the look.
export function variantRequest(context: Excerpt, sheet: Character[]): ModelRequest {
  const bot = frameRequest(context, sheet);
  const text = VARIANT_CHANGES.reduce((instruction, change) => once(instruction, change.from, change.to), bot.messages.at(-1)!.content);
  const schema = structuredClone(bot.outputSchema) as { properties: { people: Schema & { items: Schema } } };
  const people = schema.properties.people;
  people.maxItems = 6;
  const { who, ...rest } = people.items.properties!;
  people.items.properties = { who, role: { type: 'string' }, facing: { type: 'string', enum: [...FACINGS] }, ...rest };
  people.items.required = ['who', 'role', 'facing', 'look', 'clothes', 'state', 'action'];
  return { ...bot, maxOutputTokens: VARIANT_TOKENS, outputSchema: schema, messages: [...bot.messages.slice(0, -1), { role: 'user', content: text }] };
}

// A reply against its request's own schema, on the raw reply and before any parser drops an entry: the types, the
// required fields, no field more where the schema forbids it, the enums and the length limits of arrays.
export function fitsSchema(value: unknown, schema: Schema): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some(type => ofType(value, type))) return false;
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    return !schema.items || value.every(item => fitsSchema(item, schema.items!));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ((schema.required ?? []).some(key => !Object.hasOwn(record, key))) return false;
    return Object.entries(record).every(([key, item]) => schema.properties?.[key] ? fitsSchema(item, schema.properties[key])
      : schema.additionalProperties !== false);
  }
  return true;
}
const ofType = (value: unknown, type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
  : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value)
    : typeof value === type;
// The variant's own rule on top of its schema: no two participants share a role, compared trimmed and without case.
export const rolesUnique = (frame: { people?: { role?: unknown }[] }) => {
  const roles = (frame.people ?? []).map(person => String(person.role ?? '').trim().toLowerCase());
  return new Set(roles).size === roles.length;
};

// ---- The stories and where they live ----

export type TextStory = { id: string; title: string; startTime: string; sealed: boolean; theme?: string; seed?: string; action?: string };
export function textStories(): TextStory[] {
  return [...ACTION_STORIES.map(story => ({ id: story.id, title: story.title, startTime: story.startTime, sealed: false, seed: story.seed, action: story.action })),
    ...SHARP_THEMES.map(theme => ({ id: theme.id, title: theme.theme, startTime: SHARP_START_TIME, sealed: true, theme: theme.theme }))];
}
export const isSharp = (id: string) => id.startsWith('sharp-');
// Each story's own directory: `sealed/<id>/` for a sharp one and the marker check's, `clean/<id>/` for the rest.
export const storyDir = (root: string, id: string) => join(resolve(root), isSharp(id) || id === MARKER_STORY.id ? 'sealed' : 'clean', id);

export type Outcome = 'ok' | 'unparsed' | 'truncated' | 'schema' | 'empty_sheet' | 'failed';
export type StepName = 'seed' | 'opening' | 'action' | 'sheet' | 'frame' | 'variant';
export const STEPS: StepName[] = ['seed', 'opening', 'action', 'sheet', 'frame', 'variant'];
export type StepResult = { outcome: Outcome; code?: string; attempts: number; ms: number } & Details;
// What a story's text run keeps in its directory: each step's outcome and what the steps that succeeded returned. The
// scenes are in `story.sqlite` beside it.
export type StoryText = { id: string; pins: string; steps: Partial<Record<StepName, StepResult>>; nodeId?: string;
  sharp?: { seed: string; action: string }; sheet?: Character[]; worn?: Character[]; frame?: Description; variant?: VariantFrame };
// The arms a step's failure takes out (docs/action-experiment.md#text-run): a scene or the sheet, the whole story; the
// bot's frame, A; the variant, A+, L, C, V and T.
export const ARMS = ['A', 'A+', 'L', 'C', 'V', 'T'] as const;
export type ActionArm = typeof ARMS[number];
export function armsOut(text: StoryText | undefined): Partial<Record<ActionArm, string>> {
  const steps = text?.steps ?? {};
  // A step that failed names its outcome; one never reached leaves its arms without a text.
  const reason = (step: StepName) => steps[step] ? (steps[step]!.outcome === 'ok' ? undefined : `${step}_${steps[step]!.outcome}`) : 'text_missing';
  const story = (['seed', 'opening', 'action'] as StepName[]).map(step => steps[step] && reason(step)).find(Boolean) ?? reason('sheet');
  return Object.fromEntries(ARMS.flatMap(arm => {
    const why = story ?? reason(arm === 'A' ? 'frame' : 'variant');
    return why ? [[arm, why]] : [];
  }));
}

// ---- The model ----

// The gateway's key for our own calls, and nothing else of the file, which also holds the control key and Vast's. The
// value is never printed, logged or put in an error, and neither is anything the file says.
export const CLIENT_KEY_FILE = join(homedir(), '.config', 'simple-serving', 'config.json');
export function readClientKey(path = CLIENT_KEY_FILE): string {
  let key: unknown;
  try { key = (JSON.parse(readFileSync(path, 'utf8')) as { client_key?: unknown } | null)?.client_key; }
  catch { throw new Error(`Cannot read ${path} as a JSON object`); }
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key)) throw new Error(`${path} has no client_key`);
  return key.trim();
}

// Route A's defaults (docs/action-experiment.md#text-run): the local end of `cli up`'s tunnel, the served name, a
// context of 65536 and the gateway's own wall for `internal`, 900 s, where the bot's default is 300.
export const SERVING = { baseUrl: 'http://127.0.0.1:8080', model: 'gemma-4-31b-heretic-nvfp4', contextTokens: 65536, timeoutMs: 900000 };
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type TextModel = { provider: Provider; config: ModelConfig; route: 'simple-serving' | 'gpu'; weights: string;
  requests: Record<string, number>; fetch: Fetch };
// Every request the adapter sends, counted by its path, which names a route and nothing else: the checks, the counts
// before a send and the generations are told apart by it.
function counted(inner: Fetch) {
  const requests: Record<string, number> = {};
  const fetch: Fetch = (url, init) => {
    const path = new URL(url).pathname;
    requests[path] = (requests[path] ?? 0) + 1;
    return inner(url, init);
  };
  return { requests, fetch };
}
// The configuration as `loadModelConfig` builds it from `env` alone, on a directory that holds nothing, so that no
// `.env` of the repository or the working directory is read.
function configFrom(env: Env, root: string): ModelConfig {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (readdirSync(root).length) throw new Error(`${root} must be empty: the model's configuration is built on it so that no .env is read`);
  return loadModelConfig(root, env);
}
export function servingModel({ key, configRoot, baseUrl = SERVING.baseUrl, fetch = globalThis.fetch as Fetch }: {
  key: string; configRoot: string; baseUrl?: string; fetch?: Fetch }): TextModel {
  const config = configFrom({ SIMPLE_CHAT_PROVIDER: 'simple-serving', SIMPLE_CHAT_BASE_URL: baseUrl, SIMPLE_CHAT_API_KEY: key,
    SIMPLE_CHAT_MODEL: SERVING.model, SIMPLE_CHAT_CONTEXT_TOKENS: String(SERVING.contextTokens), SIMPLE_CHAT_MODEL_TIMEOUT_MS: String(SERVING.timeoutMs) }, configRoot);
  const counting = counted(fetch);
  return { provider: createServing(config, { fetch: counting.fetch }), config, route: 'simple-serving',
    weights: `route A: ${config.model}, simple-serving's NVFP4 conversion of the heretic`, requests: counting.requests, fetch: counting.fetch };
}
// The fallback, llama.cpp with the bot's Q6_K, as eval's `gpu:<label>` takes it from `.env.gpu`: the model's settings
// and nothing of the rental or ssh.
export function gpuModel({ label, env, configRoot, fetch = globalThis.fetch as Fetch }: { label: string; env: Env; configRoot: string; fetch?: Fetch }): TextModel {
  const names = ['PROVIDER', 'BASE_URL', 'API_KEY', 'MODEL', 'CONTEXT_TOKENS', 'MAX_OUTPUT_TOKENS', 'MODEL_TIMEOUT_MS', 'TEMPERATURE'];
  const config = configFrom(Object.fromEntries(names.map(name => [`SIMPLE_CHAT_${name}`, env[`SIMPLE_CHAT_${name}`]])), configRoot);
  if (config.provider !== 'llama-cpp') throw new Error('The fallback is the llama.cpp card: SIMPLE_CHAT_PROVIDER=llama-cpp in .env.gpu');
  const counting = counted(fetch);
  return { provider: createLlama(config, { fetch: counting.fetch }), config, route: 'gpu', weights: `gpu:${label}: ${config.model} on llama.cpp`,
    requests: counting.requests, fetch: counting.fetch };
}
export const readGpuEnv = (file = join(ROOT, '.env.gpu')): Env => {
  try { return parseEnv(readFileSync(file, 'utf8')); } catch { throw new Error('Cannot read .env.gpu'); }
};

// simple-serving's smoke, by its own record: the JSON lines of the one plain `smoke` the text card runs once `up` holds
// its tunnel. That card is never stopped and resumed, since the stop and the resume are the rehearsal's on its own
// small card (the owner, 2026-09-25), so the run has no --before or --after and no `lifecycle`: ten probes, from the
// gateway's state to its privacy check. Every line passed, and privacy is among them, since a request's words in a log
// of the card are the sealed scenes' leak; a record of an --after run, whose passed lifecycle line comes first, passes
// too. The text run starts on nothing less. What the record says of versions is kept as pins, as names and digits only.
export const SMOKE_PROBES = ['state', 'completion', 'fields', 'reasoning', 'finish', 'refusal', 'abort', 'schemas', 'counts', 'privacy'];
export function smokeRecord(file: string) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => {
    try { return JSON.parse(line) as { probe?: unknown; ok?: unknown; versions?: unknown }; } catch { return {}; }
  });
  const passed = new Set(lines.filter(line => line.ok === true && typeof line.probe === 'string').map(line => String(line.probe)));
  const missing = SMOKE_PROBES.filter(probe => !passed.has(probe));
  if (missing.length || lines.some(line => line.ok !== true)) {
    throw new Error(`The gateway's smoke record ${file} has not passed whole (${missing.length ? `missing or failed: ${missing.join(', ')}` : 'a line did not pass'})`);
  }
  const versions = lines.find(line => line.probe === 'state')?.versions;
  const safe = Object.entries(versions && typeof versions === 'object' ? versions : {})
    .filter(([name, value]) => /^[A-Za-z0-9_.-]{1,60}$/.test(name) && typeof value === 'string' && /^[A-Za-z0-9_.+-]{1,80}$/.test(value));
  return { probes: passed.size, versions: Object.fromEntries(safe) as Record<string, string> };
}

// What the run is pinned to (docs/action-experiment.md#text-run): the route and its weights, the address, the served
// name, the context and the wall, the bot's sampling for this provider by its adapter's source, the instructions and
// schemas by their hash, and the set. A rerun under other pins is refused.
export function textPins(model: TextModel, gateway: Record<string, string | number> = {}): Record<string, string | number> {
  const empty: Excerpt = { system: '', messages: [] };
  const adapter = model.route === 'simple-serving' ? 'serving.ts' : 'llama.ts';
  const instructions = { sheet: sheetRequest(empty), frame: frameRequest(empty, []), variant: variantRequest(empty, []),
    sharp: sharpInstruction('ТЕМА'), sharpSchema: SHARP_SCHEMA, sharpTokens: SHARP_TOKENS };
  return { route: model.route, weights: model.weights, baseUrl: model.config.baseUrl ?? '', model: model.config.model,
    contextTokens: model.config.contextTokens, timeoutMs: model.config.timeoutMs, temperature: model.config.temperature,
    maxOutputTokens: model.config.maxOutputTokens, adapter: sha256(readFileSync(join(ROOT, 'local', adapter))),
    instructions: sha256(JSON.stringify(instructions)), set: actionSetHash(), ...gateway };
}
const pinsHash = (pins: Record<string, string | number>) => sha256(JSON.stringify(pins));

// What the gateway says of itself on /v1/state with our key: the contract, the model and the context, and nothing
// that changes with a boot. Its versions need the control key, which the harness never reads.
export async function gatewayFacts(model: TextModel): Promise<Record<string, string | number>> {
  if (model.route !== 'simple-serving') return {};
  const response = await model.fetch(`${model.config.baseUrl}/v1/state`, { headers: { Authorization: `Bearer ${model.config.apiKey}` } });
  const state = response.ok ? await response.json().catch(() => null) as { contract?: unknown; model?: unknown; context_tokens?: unknown } | null : null;
  const facts: Record<string, string | number> = {};
  if (typeof state?.contract === 'string' && /^\d{1,4}$/.test(state.contract)) facts.gatewayContract = state.contract;
  if (typeof state?.model === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(state.model)) facts.gatewayModel = state.model;
  if (Number.isSafeInteger(state?.context_tokens)) facts.gatewayContext = state!.context_tokens as number;
  return facts;
}

// ---- The run ----

const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
export const codeOf = (error: unknown) => {
  const raw = String((error as { code?: unknown } | null)?.code ?? '');
  return /^[a-z_]{1,50}$/.test(raw) ? raw : 'failed';
};
// One attempt at the model, as counts, times and a code: no text of the request or the reply.
export type Attempt = { story: string; kind: StepName; attempt: number; retry: boolean; inputTokens: number | null;
  outputTokens: number | null; cachedTokens: number | null; servingWaitMs: number | null; servingFirstTokenMs: number | null;
  servingTotalMs: number | null; finish: 'stop' | 'length' | null; code: string | null; ms: number } & Details;
// The provider as one step sees it: every attempt recorded, the finish of the last kept for the step's decision.
function instrument(inner: Provider, story: string, kind: StepName, log: (row: Attempt) => void) {
  let attempts = 0;
  let lastFinish: 'stop' | 'length' | null = null;
  const provider: Provider = {
    ...(inner.check ? { check: (controls?: Parameters<NonNullable<Provider['check']>>[0]) => inner.check!(controls) } : {}),
    ...(inner.countInput ? { countInput: (request: ModelRequest, controls?: Parameters<NonNullable<Provider['countInput']>>[1]) => inner.countInput!(request, controls) } : {}),
    async generate(request, controls) {
      const attempt = ++attempts;
      const began = performance.now();
      const row = { story, kind, attempt, retry: attempt > 1 };
      const blank = { inputTokens: null, outputTokens: null, cachedTokens: null, servingWaitMs: null, servingFirstTokenMs: null, servingTotalMs: null };
      try {
        const result = await inner.generate(request, controls);
        lastFinish = result.finishReason;
        log({ ...row, ...blank, inputTokens: count(result.usage?.inputTokens), outputTokens: count(result.usage?.outputTokens),
          cachedTokens: count(result.usage?.cachedInputTokens), servingWaitMs: count(result.timings?.servingWaitMs),
          servingFirstTokenMs: count(result.timings?.servingFirstTokenMs), servingTotalMs: count(result.timings?.servingTotalMs),
          finish: result.finishReason, code: null, ms: Math.round(performance.now() - began) });
        return result;
      } catch (error) {
        lastFinish = null;
        log({ ...row, ...blank, finish: null, code: codeOf(error), ...detailsOf(error), ms: Math.round(performance.now() - began) });
        throw error;
      }
    },
  };
  return { provider, attempts: () => attempts, lastFinish: () => lastFinish };
}

// The request a sharp story's seed is asked with: the pinned instruction alone.
export const sharpRequest = (theme: string): ModelRequest => ({ system: '', maxOutputTokens: SHARP_TOKENS, outputSchema: SHARP_SCHEMA,
  messages: [{ role: 'user', content: sharpInstruction(theme) }] });

// The one reader of each story's own store.
export const USER = 'action';
type RunContext = { root: string; model: TextModel; pins: string; log: (row: Attempt) => void; say: (event: object) => void };

// One story, step by step, resumed where it stopped: a step with an outcome is never asked again, and a scene already
// in the store is not written twice.
export async function runStory(story: TextStory, run: RunContext): Promise<StoryText> {
  const dir = storyDir(run.root, story.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'text.json');
  const text: StoryText = readJson<StoryText>(file) ?? { id: story.id, pins: run.pins, steps: {} };
  if (text.pins !== run.pins) throw new Error(`${story.id} was written under other pins; one run directory holds one set of pins`);
  const save = () => writeJson(file, text);
  const done = (step: StepName, result: StepResult) => {
    text.steps[step] = result;
    save();
    run.say({ event: 'text_step', story: story.id, step, outcome: result.outcome, ...(result.code ? { code: result.code } : {}), attempts: result.attempts, ms: result.ms });
    return result.outcome === 'ok';
  };
  const ok = (step: StepName) => text.steps[step]?.outcome === 'ok';
  // One structured reply: parsed with the bot's one retry, then decided on the raw reply.
  const ask = async (step: StepName, request: ModelRequest, rule: (value: Record<string, unknown>) => boolean = () => true) => {
    const counting = instrument(run.model.provider, story.id, step, run.log);
    const began = performance.now();
    const ms = () => Math.round(performance.now() - began);
    try {
      const { value } = await askJson(counting.provider, request);
      const outcome: Outcome = counting.lastFinish() === 'length' ? 'truncated'
        : fitsSchema(value, request.outputSchema as Schema) && rule(value) ? 'ok' : 'schema';
      return { result: { outcome, attempts: counting.attempts(), ms: ms() } as StepResult, value };
    } catch (error) {
      const code = codeOf(error);
      return { result: (code === 'unparsed_description' ? { outcome: 'unparsed', attempts: counting.attempts(), ms: ms() }
        : { outcome: 'failed', code, attempts: counting.attempts(), ms: ms(), ...detailsOf(error) }) as StepResult };
    }
  };

  const store = new Store(join(dir, 'story.sqlite'));
  try {
    if (story.theme && !text.steps.seed) {
      const { result, value } = await ask('seed', sharpRequest(story.theme), reply => String(reply.seed).trim() !== '' && String(reply.action).trim() !== '');
      if (result.outcome === 'ok') text.sharp = { seed: String(value!.seed).trim(), action: String(value!.action).trim() };
      done('seed', result);
    }
    if (story.theme && !ok('seed')) return text;
    const seed = story.seed ?? text.sharp!.seed, action = story.action ?? text.sharp!.action;
    // The story in its own store, begun once; a job a crash left behind is dropped, as local/story-probe.ts does.
    store.mutate(USER, state => {
      if (!Object.keys(state.stories).length) newStory(state, addSeed(state, `${story.title}\n${story.startTime}\n${seed}`).id);
      state.job = null;
    });
    const nodes = () => Object.values(Object.values(store.read(USER).stories)[0].nodes);
    for (const [step, input, at] of [['opening', null, 1], ['action', action, 2]] as const) {
      if (text.steps[step] && !ok(step)) return text;
      if (ok(step)) continue;
      // A scene the store holds was written and committed before the crash that lost its outcome: its call has an
      // outcome, and it is not asked again.
      if (nodes().length >= at) { done(step, { outcome: nodes()[at - 1].truncated ? 'truncated' : 'ok', attempts: 0, ms: 0 }); continue; }
      const counting = instrument(run.model.provider, story.id, step, run.log);
      const began = performance.now();
      const job = store.mutate(USER, state => {
        const storyId = Object.keys(state.stories)[0];
        return beginJob(state, input ?? storyNarration(state, storyId).startStory, Date.now());
      });
      try {
        const { result } = await generateScene({ store, userId: USER, jobId: job.id, provider: counting.provider, config: run.model.config });
        const truncated = result.finishReason === 'length';
        const ref = store.mutate(USER, state => {
          const current = state.stories[job.storyId];
          const fallback = current.nodes[job.head as string]?.time ?? state.seeds[current.seedId].startTime;
          const committed = commitTurn(state, job.id, normalizeScene(result.text, fallback), truncated);
          if (committed) current.nodes[committed.nodeId].usage = result.usage;
          return committed;
        });
        if (!ref) throw Object.assign(new Error('scene_not_committed'), { code: 'scene_not_committed' });
        if (step === 'action') text.nodeId = ref.nodeId;
        // A cut scene is not the scene the frames are asked about: the story leaves the run, as a cut scene ends
        // local/story-probe.ts.
        if (!done(step, { outcome: truncated ? 'truncated' : 'ok', attempts: counting.attempts(), ms: Math.round(performance.now() - began) })) return text;
      } catch (error) {
        store.mutate(USER, state => { state.job = null; });
        done(step, { outcome: 'failed', code: codeOf(error), attempts: counting.attempts(), ms: Math.round(performance.now() - began), ...detailsOf(error) });
        return text;
      }
    }
    text.nodeId ??= nodes()[1].id;
    // The excerpt the bot describes a scene from (local/picture.ts `excerpt`): the same history up to the scene.
    const state = store.read(USER);
    const storyId = Object.keys(state.stories)[0];
    const branchId = Object.keys(state.stories[storyId].branches)[0];
    const memory = state.stories[storyId].branches[branchId]?.memory ?? null;
    const parts = contextParts(state, { storyId, head: text.nodeId, memory });
    const excerpt: Excerpt = { system: storyNarration(state, storyId).system, messages: [...parts.seed, ...parts.memory, ...parts.tail] };

    if (!text.steps.sheet) {
      const { result, value } = await ask('sheet', sheetRequest(excerpt));
      if (result.outcome === 'ok') {
        const characters = sheetOf(value!);
        if (!characters.length) result.outcome = 'empty_sheet';
        else {
          text.sheet = characters;
          store.mutate(USER, saved => { saved.stories[storyId].sheet = rewrittenSheet([], characters); });
          text.worn = wornAt(store.read(USER).stories[storyId], text.nodeId, store.read(USER).stories[storyId].sheet ?? []);
        }
      }
      done('sheet', result);
    }
    if (!ok('sheet')) return text;
    if (!text.steps.frame) {
      const { result, value } = await ask('frame', frameRequest(excerpt, text.worn!));
      if (result.outcome === 'ok') text.frame = value as unknown as Description;
      done('frame', result);
    }
    if (!text.steps.variant) {
      const { result, value } = await ask('variant', variantRequest(excerpt, text.worn!), rolesUnique);
      if (result.outcome === 'ok') text.variant = value as unknown as VariantFrame;
      done('variant', result);
    }
    return text;
  } finally { store.close(); }
}

// The run's own record, `texts.json`: pins, each story's outcomes, every attempt and every request by its route. Ids,
// codes, counts and times only, for the sharp stories as for the clean ones.
export type TextsRecord = { pins: Record<string, string | number>; startedAt: string; completedAt?: string;
  smoke?: { probes: number; versions: Record<string, string> };
  stories: Record<string, Partial<Record<StepName, Pick<StepResult, 'outcome' | 'code' | 'attempts'>>>>;
  attempts: Attempt[]; requests: Record<string, number>; skipped?: Record<string, string> };

// The requests apart from the main calls (docs/action-experiment.md#text-run): the calls are the first attempts, the
// retries the second, and the checks and the counts before a send are the adapter's own routes.
export function requestCounts(record: Pick<TextsRecord, 'attempts' | 'requests'>) {
  const route = (path: string) => record.requests[path] ?? 0;
  return { calls: record.attempts.filter(row => !row.retry).length, retries: record.attempts.filter(row => row.retry).length,
    checks: route('/v1/state') + route('/v1/models') + route('/health') + route('/props'),
    counts: route('/v1/chat/completions/input_tokens') + route('/tokenize') + route('/apply-template'),
    generations: route('/v1/chat/completions') + route('/completion'), all: Object.values(record.requests).reduce((sum, n) => sum + n, 0) };
}

export type TextsOptions = { root: string; model: TextModel; stories?: TextStory[]; concurrency?: number; smoke?: string;
  say?: (event: object) => void; gateway?: Record<string, string | number> };
// The text run: the clean stories always, the sharp ones only after the marker check passed on these pins, two at a
// time. Returns the run's record; a sharp story held back is in `skipped` with its code.
export async function runTexts(options: TextsOptions): Promise<TextsRecord> {
  const root = resolve(options.root);
  const say = options.say ?? (() => undefined);
  const smoke = options.smoke ? smokeRecord(options.smoke) : undefined;
  if (options.model.route === 'simple-serving' && !smoke) throw new Error('Route A starts only on the gateway\'s passed smoke: name its record with --smoke-record');
  const gateway = options.gateway ?? await gatewayFacts(options.model);
  const pins = textPins(options.model, { ...gateway, ...Object.fromEntries(Object.entries(smoke?.versions ?? {}).map(([name, value]) => [`gateway.${name}`, value])) });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, 'texts.json');
  const earlier = readJson<TextsRecord>(file);
  if (earlier && pinsHash(earlier.pins) !== pinsHash(pins)) {
    const changed = [...new Set([...Object.keys(pins), ...Object.keys(earlier.pins)])].find(key => earlier.pins[key] !== pins[key]);
    throw new Error(`${file} was written under another ${changed}; one run directory holds one set of pins`);
  }
  const record: TextsRecord = earlier ?? { pins, startedAt: new Date().toISOString(), stories: {}, attempts: [], requests: {} };
  if (smoke) record.smoke = smoke;
  delete record.completedAt;
  delete record.skipped;
  const before = { ...record.requests };
  const save = () => {
    for (const [path, n] of Object.entries(options.model.requests)) record.requests[path] = (before[path] ?? 0) + n;
    writeJson(file, record);
  };
  const marker = readJson<{ pass?: boolean; pins?: string }>(join(root, 'marker.json'));
  const markerCode = !marker ? 'marker_missing' : marker.pins !== pinsHash(pins) ? 'marker_other_pins' : marker.pass !== true ? 'marker_failed' : undefined;
  const all = options.stories ?? textStories();
  const held = markerCode ? all.filter(story => isSharp(story.id)) : [];
  const skipped: Record<string, string> = Object.fromEntries(held.map(story => [story.id, markerCode!]));
  const stories = all.filter(story => !held.includes(story));
  const context: RunContext = { root, model: options.model, pins: pinsHash(pins), say,
    log: row => { record.attempts.push(row); save(); say({ event: 'text_attempt', ...row }); } };
  let next = 0;
  const worker = async () => {
    while (next < stories.length) {
      const story = stories[next++];
      const text = await runStory(story, context);
      record.stories[story.id] = Object.fromEntries(Object.entries(text.steps).map(([step, result]) =>
        [step, { outcome: result.outcome, ...(result.code ? { code: result.code } : {}), attempts: result.attempts }]));
      save();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 2, stories.length)) }, worker));
  if (Object.keys(skipped).length) record.skipped = skipped;
  record.completedAt = new Date().toISOString();
  save();
  return record;
}

// The marker check of the sealed path (docs/action-experiment.md#sealed): one synthetic story, marked sealed, with a
// made-up name in its seed, through the same steps as a sharp story after its seed; then the search. The temporary
// directory is a fresh one for the check, removed after it. `marker.json` says whether it passed, never the name.
export async function markerCheck(options: Omit<TextsOptions, 'stories'> & { tempRoot?: string }) {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const smoke = options.smoke ? smokeRecord(options.smoke) : undefined;
  if (options.model.route === 'simple-serving' && !smoke) throw new Error('Route A starts only on the gateway\'s passed smoke: name its record with --smoke-record');
  const gateway = options.gateway ?? await gatewayFacts(options.model);
  const pins = textPins(options.model, { ...gateway, ...Object.fromEntries(Object.entries(smoke?.versions ?? {}).map(([name, value]) => [`gateway.${name}`, value])) });
  const sealed = join(root, 'sealed');
  // A check starts from nothing: a story left by an earlier one holds an earlier name, and a search for the new one
  // would find nothing whatever the harness did.
  rmSync(storyDir(root, MARKER_STORY.id), { recursive: true, force: true });
  const outside = (word: string) => !searchTree(root, markerForms(word), path => path === sealed).hits.length;
  const name = madeUpName(outside);
  const tempDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'simple-chat-action-marker-'));
  const previous = process.env.TMPDIR;
  const output = capture();
  process.env.TMPDIR = tempDir;
  let steps: StoryText['steps'] = {};
  try {
    const story: TextStory = { id: MARKER_STORY.id, title: MARKER_STORY.title, startTime: MARKER_STORY.startTime, sealed: true,
      seed: MARKER_STORY.seed(name), action: MARKER_STORY.action(name) };
    const attempts: Attempt[] = [];
    const say = options.say ?? (() => undefined);
    const text = await runStory(story, { root, model: options.model, pins: pinsHash(pins), say,
      log: row => { attempts.push(row); say({ event: 'text_attempt', ...row }); } });
    steps = text.steps;
  } finally {
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
  const found = searchBoundary({ root, tempDir, word: name, output: output.text() });
  rmSync(tempDir, { recursive: true, force: true });
  const reached = Object.values(steps).length === 5 && Object.values(steps).every(step => step.outcome === 'ok');
  const result = { pass: found.pass && reached, reached, files: found.files, bytes: found.bytes, tempFiles: found.tempFiles,
    hits: { files: found.hits.files.length, temp: found.hits.temp, output: found.hits.output }, pins: pinsHash(pins), at: new Date().toISOString(),
    steps: Object.fromEntries(Object.entries(steps).map(([step, one]) => [step, one.outcome])), requests: { ...options.model.requests } };
  writeJson(join(root, 'marker.json'), result);
  return { ...result, hitFiles: found.hits.files };
}
