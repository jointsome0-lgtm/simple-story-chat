// The prompt arms probe (docs/action-experiment.md#prompt-arms), for the next picture card: does a picture prompt a
// model writes beat the one code assembles today? The code-assembled picture prompt looked like the weak point.
// Twelve clean scenes of round two with
// actions and contacts (`SCENES`), seeds 7 and 11, every frame on the bot's picture path (docs/gpu.md#bot-card):
//   C0  today's assembly, local/illustrate.ts `assemblePrompt`, from the bot's own frame description of the scene;
//   G   the whole prompt written by the same model from the same scene (`gInstruction`): the main action first, who is
//       where and who touches whom, each participant with the sheet's look word for word, what each wears and what is
//       bare; code only takes names and ages out and adds the style line, as the bot does to its fields;
//   PE  C0 rewritten on the card by Qwen-Image 2.1's own text-to-image prompt enhancer (gpu/image-manifest.env
//       IMAGE_QWEN_PE_T2I_*) through ComfyUI's TextGenerate, without thinking, as ComfyUI's template runs it;
//   A+  round two's variant prompt as round two drew it, written by round two's heretic, where C0's and G's are the
//       hosted Gemma 4 31B's of 2026-09-28: another model, quantization and instruction at once;
//   PT  C0 rewritten with thinking, as the enhancer's own model card runs it.
// G against C0 is the probe's question; PE, A+ and PT are explored beside it. As the GPT-6 Astra review of 2026-09-28
// asked, the card draws every C0 and G frame first, then each other arm as a schedule of its own, all twelve scenes at
// both seeds, begun only while the time left covers all of it (`SCHEDULES_FILE`). Astra judges the pictures blind
// against the scene and never against the prompt sent (local/image-prompt-arms-judge.ts). C0 and G are asked of a
// hosted model before the card and frozen (`FROZEN_SHA256`); the rewrites and the pictures are the card's. The rest is
// local/image-refs-test.ts's: the prices, cells.json and the pages. Round two's run is read and never written: its
// stores are opened as copies.
//   prompts    C0 and G on openrouter-paid, at most 40 requests in all, the words in the run's prompts.json
//   checks     every arm's prompts by code: the looks kept, the scene's essential contacts named, the action first
//   freeze     frozen.json from prompts.json and round two's A+, whose sha256 this file then pins
//   pe-prompt  the enhancer's system prompt, fetched at its pinned revision and checked, into the run
//   estimate   the cells, the schedules with their budgets, and the minutes
//   dry-run    the whole card against local/fake-comfy.ts, the rewrites and the pictures
//   card       on the card, --run DIR --until EPOCH: C0 and G; then PE's rewrites and frames, A+'s frames, PT's
//              rewrites and frames, each schedule only if its budget fits
//   page       the stands' pages
// What it prints is keys, codes, counts and times: never a word of a prompt, a scene or a rewrite.
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { CLEANUP_RESERVE_MS, attentionOffered, call, comfyUrl, post, serverPins, stopJob } from './image-batch.ts';
import type { Comfy, Graph } from './image-batch.ts';
import { CELL_MS, DRAW_CODES, FRAME_CANVAS, MARGIN } from './action-draw.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { kitchenLines } from './image-pilot.ts';
import { readManifest } from './tokenizer-extract.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { safeErrorDetails } from './model-error.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { INDEX_FILE, SEED_MS, SHAPE_MS, TEXTS_FILE, TRITON_ARGV, attentionInfo, buildJob, cellOf, cellRight, countsOf, drawStand,
  estimateOf, frameKey, inputsOf, setupOf, sizeText, writePage } from './image-refs-test.ts';
import type { Planned, Stand, StandIndex, Warmth } from './image-refs-test.ts';
import { STYLE, askJson, assemblePrompt, frameRequest, matchSheet, sheetLooks, stripAges, stripNames } from './illustrate.ts';
import type { Character, Description, Excerpt } from './illustrate.ts';
import { USER, codeOf, detailsOf, fitsSchema, hostedModel, readJson, storyDir } from './action-text.ts';
import type { Schema, StoryText } from './action-text.ts';
import type { Checklist } from './action-judge.ts';
import { modelEnv } from './illustrate-probe.ts';
import { BUDGET_PATH } from './model.ts';
import type { ModelRequest, Provider } from './model.ts';
import { contextParts, storyNarration } from './prompt.ts';
import { Store } from './store.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';

const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = readManifest(join(ROOT, 'gpu', 'image-manifest.env'));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};
const minutes = (ms: number) => Math.round(ms / 6000) / 10;

// ---- The plan ----

// Round two's clean scenes whose checklist names an essential contact, from a bandage on a forearm to a stretcher's
// handles: two to four participants each, 49 essential relations in all (docs/action-experiment.md#prompt-arms).
export const SCENES = ['bandage', 'beach', 'cheer', 'demon', 'giants', 'guard', 'gulliver', 'gym', 'jellyfish', 'lineout', 'monkeys', 'rescue'];
export const ARM_SEEDS = [7, 11];
export type Arm = 'C0' | 'G' | 'PE' | 'A+' | 'PT';
// C0 and G, drawn first whatever else the card has time for; then the others, each a schedule of its own, in this order.
export const RESERVED: Arm[] = ['C0', 'G'];
export type Optional = 'PE' | 'A+' | 'PT';
export const OPTIONAL: Optional[] = ['PE', 'A+', 'PT'];
export const ARMS: Arm[] = [...RESERVED, ...OPTIONAL];
// C0, G and A+ from the frozen texts in one stand, drawn in two runs of it; PE and PT each from its pass of rewrites in
// a stand named for the pass.
export type StandName = 'core' | 'fast' | 'think';
export const STANDS: StandName[] = ['core', 'fast', 'think'];
export const STAND_OF: Record<Arm, StandName> = { C0: 'core', G: 'core', 'A+': 'core', PE: 'fast', PT: 'think' };
export const armKey = (arm: Arm, scene: string, seed: number) => frameKey(`${arm}-${scene}`, undefined, seed);
const frame = (arm: Arm, scene: string, seed: number) => cellOf({ key: armKey(arm, scene, seed), id: `${arm}-${scene}`, arm, kind: 'frame', seed,
  graph: 'action', canvas: FRAME_CANVAS, cfg: 1, negative: 'none', refs: [] });
export const sceneOfCell = (one: Planned) => one.id.slice(one.arm.length + 1);
// Seed by seed and scene by scene, the arms of a scene side by side, so that an end that comes early leaves whole
// scenes at whole seeds: C0 and G, then A+. PE and PT only where the rewrite came back.
const framesOf = (arms: Arm[], scenes: string[]) => ARM_SEEDS.flatMap(seed => scenes.flatMap(scene => arms.map(arm => frame(arm, scene, seed))));
export const corePlan = () => [...framesOf(RESERVED, SCENES), ...framesOf(['A+'], SCENES)];
export const rewritePlan = (arm: 'PE' | 'PT', rewritten: string[]) => framesOf([arm], SCENES.filter(scene => rewritten.includes(scene)));
const PAGES: Record<StandName, { title: string; section: string; note: string; intro: string }> = {
  core: { title: 'Стенд промптов', section: 'Три промпта к одному кадру',
    note: 'C0: сборка кодом, как сейчас в боте. G: весь промпт пишет Gemma по сцене. A+: промпт варианта второго раунда, его писала другая модель. '
      + 'C0 и G рисуются первыми, A+ только если хватает времени на все его кадры.',
    intro: 'Двенадцать чистых сцен второго раунда с касаниями, сиды 7 и 11, 25 шагов euler, путь бота: cu130, Triton, внимание кухни. Судит Astra вслепую по сцене, а не по промпту.' },
  fast: { title: 'Стенд промптов: энхансер', section: 'PE',
    note: 'Промпт C0, переписанный энхансером Qwen-Image 2.1 без размышлений: рисуется только его rewritten_prompt, холст 1280x704. Нет строки: энхансер не дал годного JSON или не успел.',
    intro: 'Рисуется после C0 и G, если хватает времени на все переписывания и кадры. Путь бота: cu130, Triton, внимание кухни.' },
  think: { title: 'Стенд промптов: энхансер с размышлениями', section: 'PT',
    note: 'Промпт C0, переписанный энхансером с размышлениями, как советует карточка модели. Нет строки: энхансер не дал годного JSON или не успел.',
    intro: 'Рисуется последним, если хватает времени на все переписывания и кадры. Путь бота: cu130, Triton, внимание кухни.' },
};
export function standOf(name: StandName, plan: Planned[], day: string): Stand {
  const keys = new Set(plan.map(one => one.key)), arms = ARMS.filter(arm => STAND_OF[arm] === name), page = PAGES[name];
  const rows = SCENES.flatMap(scene => ARM_SEEDS.map(seed => ({ label: `${scene}, сид ${seed}`,
    keys: arms.map(arm => (keys.has(armKey(arm, scene, seed)) ? armKey(arm, scene, seed) : undefined)) }))).filter(row => row.keys.some(Boolean));
  return { plan, date: day, title: page.title, sections: [{ title: page.section, columns: arms, rows, note: page.note }], intro: page.intro };
}

// ---- The texts ----

export const FROZEN_FILE = 'frozen.json', PROMPTS_FILE = 'prompts.json', CHECKS_FILE = 'checks.json';
const SYSTEM_FILE = join('pe', 'system_prompt.txt');
export const REWRITES_FILE: Record<'fast' | 'think', string> = { fast: join('pe', 'fast.json'), think: join('pe', 'think.json') };
// frozen.json as `freeze` wrote it from the hosted answers of 2026-09-28, byte for byte.
export const FROZEN_SHA256 = 'bc2745a57cb35670da52dd7c09670809879b9b99e0bc4fc402f714c9b0488378';
export type Frozen = { note: string; model: string; instructions: { frame: string; g: string }; scenes: Record<string, { C0: string; G: string; 'A+': string }> };
function readPinned(file: string, pinned: string, what: string) {
  if (!existsSync(file)) throw new Refusal(`${file} is missing: ${what}; nothing is sent`);
  const bytes = readFileSync(file);
  if (sha256(bytes) !== pinned) throw new Refusal(`${file} is not ${what}, whose sha256 image-prompt-arms.ts pins; nothing is sent`);
  return bytes.toString('utf8');
}
export function readFrozen(file: string, pinned = FROZEN_SHA256): Frozen {
  const frozen = JSON.parse(readPinned(file, pinned, 'the frozen texts')) as Frozen;
  if (!SCENES.every(scene => ['C0', 'G', 'A+'].every(arm => String(frozen.scenes?.[scene]?.[arm as 'C0'] ?? '').trim()))) {
    throw new Refusal(`${file} lacks a prompt of the probe; nothing is sent`);
  }
  return frozen;
}
// texts.json of a stand, from the frozen texts and a pass of rewrites, the same bytes each time from the same two:
// drawStand is pinned to their hash, and a resume under other texts is refused. With the stand's cells.json, which pins
// the graphs, the weights, the attention and the server, it is the private record the review asked for: the exact text
// each frame is drawn from, with its seed, graph, canvas and CFG.
export function textsOf(plan: Planned[], frozen: Frozen, rewrites?: Rewrites): string {
  const promptOf = (one: Planned) => {
    const scene = sceneOfCell(one), arm = one.arm as Arm;
    return arm === 'PE' || arm === 'PT' ? rewrites!.scenes[scene]!.prompt! : frozen.scenes[scene][arm as 'C0' | 'G' | 'A+'];
  };
  return JSON.stringify({ note: 'The prompt arms probe: the frozen texts and the rewrites the card returned, one cell each.',
    cells: plan.map(one => ({ key: one.key, kind: one.kind, seed: one.seed, graph: one.graph, canvas: sizeText(one.canvas), cfg: one.cfg, refs: one.refs,
      prompt: promptOf(one), negative: '' })) }, null, 2);
}

// ---- G ----

// G's instruction, appended to the scene's own request as the bot's frame is (local/illustrate.ts `frameRequest`), in
// the bot's words where it says the same thing: the variant's (local/action-text.ts `VARIANT_CHANGES`) for the moment,
// the participants, the contacts, the frame's edge and bare skin, and the bot's own for the rest. What is new is that
// the model writes the whole English prompt, in the order the tester asked for: the main action first, who is where
// and who touches whom; each participant with the sheet's look word for word; what each wears and what is bare. The
// names are in it only so that the model can say who is who, as in the bot's; code takes them out of the prompt. A
// version that had the model list every contact of the moment before the prompt did no better by the checks
// (docs/action-experiment.md#prompt-arms).
export function gInstruction(sheet: Character[]): string {
  const looks = sheetLooks(sheet), worn = sheet.filter(one => one.outfit?.trim());
  return `Не продолжай историю. Напиши по-английски готовый запрос для модели картинок к ПОСЛЕДНЕЙ сцене: один неподвижный кадр, как в визуальной новелле. Запрос уйдёт в модель картинок как есть, только программа допишет в конец строку стиля: чего нет в запросе, того не будет на картинке.
Правила:
- Выбери ОДИН момент: главное действие, к которому сцена пришла в конце, в тот миг, когда оно происходит, а не до и не после него. Сохрани состояние людей и предметов именно в этот момент: у кого что в руках, обнажено оружие или в ножнах, какая сторона тела повреждена, открыта или закрыта дверь.
- В кадре все участники главного действия, до четырёх: люди, животные и существа, каждый отдельно, даже если они похожи (два стражника — два участника). Тех, кто только смотрит, можно оставить за кадром. Если участников больше четырёх, выбери ракурс, который естественно оставляет лишних за краем кадра.
- Первое предложение запроса — само главное действие: кто на кого или на что действует, какой частью тела (рукой, ногой, коленом, плечом, спиной, головой, всем телом), к какой части тела другого участника или к какому предмету, и где участники друг относительно друга и в кадре. left и right — стороны самого участника ("her own left forearm"); место в кадре называй отдельно: screen-left, screen-right.
- Потом по одному предложению на каждого участника. Называй его по месту в действии ("the kneeling medic", "the girl on the right"), без имени. Предложение человека из списка начинается с его строки внешности, СЛОВО В СЛОВО и целиком, и другой внешности у него нет: не сокращай её, не пересказывай и не дополняй. Остальным — пол, возраст словом (small child, child, teenager, young adult, middle-aged, elderly) по виду, а не по годам, цвет кожи, телосложение и волосы; у ребёнка и подростка — без груди, бёдер и ягодиц. Дальше в том же предложении — во что он одет в этот момент, фразой, которая начинается с wearing: открытое тело называй прямо ("wearing only rolled-up linen trousers, bare-chested and barefoot"), но не открывай того, что сцена не открывает. И его поза: куда обращён корпус, куда он смотрит, что держит, чего касается и какой частью тела.
- Все касания главного действия в кадре: край кадра не режет руку, ногу или тело там, где они касаются другого участника; не бери план «по пояс», если касаются колени или ноги. Касание может быть закрыто телом другого участника, если так они стоят в сцене, но не краем кадра. Мелкие точные касания предметов (лезвие в щели, пальцы на кнопке), читаемый текст и содержимое экранов модель рисовать не умеет: скрывай их ракурсом. Касания участников друг друга не скрывай.
- Затем план и ракурс, при которых видны главное действие и все участники (в тесной сцене с несколькими людьми — средне-общий план в три четверти, а не эффектный нижний ракурс); место, без названий, которые ничего не говорят глазу; важные предметы, у каждого один владелец и одно состояние; свет и время суток словами, без часов и минут.
- Не передавай действие другому участнику и не добавляй действий, которых в сцене нет, ради более напряжённой позы. Не добавляй свечение, магию, оружие и травмы. Прямые запреты и физические ограничения сцены переведи в видимую позу ("her bandaged left forearm stays folded against her chest").
- Только то, что можно увидеть: без мыслей, реплик и предыстории. Без имён, без цифр и без слов стиля, техники и качества (photorealistic, anime, 8k, cinematic): стиль допишет программа.
- prompt — весь запрос, одним абзацем, от 120 до 300 слов. people — участники в кадре в том порядке, в каком их называет prompt: who — имя из списка [${sheet.map(one => one.name).join(', ')}], если это он, иначе короткая роль по-английски ("salt worker").
- Внешность людей из списка, каждая строка слово в слово:
${sheet.map(one => `  - ${one.name}: ${looks.get(one.name.trim().toLowerCase()) ?? ''}`).join('\n')}${worn.length ? `
- Одежда людей из списка до этой сцены:
${worn.map(one => `  - ${one.name}: ${one.outfit!.trim()}`).join('\n')}
  Если история с тех пор переодела человека, раздела его, одела во что-то новое, испачкала или порвала одежду, в запросе опиши одежду такой, какая она сейчас. Если нет — повтори его строку отсюда слово в слово.` : ''}`;
}
const G_SCHEMA = { type: 'object', additionalProperties: false, required: ['people', 'prompt'], properties: {
  people: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who: { type: 'string' } } } },
  prompt: { type: 'string' } } };
// The answers, the people and a prompt of 187 to 253 words, took 225 to 345 tokens; this leaves a runaway room to end
// before the bot's one retry.
const G_TOKENS = 1200;
export const gRequest = (context: Excerpt, sheet: Character[]): ModelRequest => ({ system: context.system, maxOutputTokens: G_TOKENS, outputSchema: G_SCHEMA,
  messages: [...context.messages, { role: 'user', content: gInstruction(sheet) }] });
// The prompt G sends: the model's, with the names of the sheet and of each stranger `who` gives as one capitalised word
// and the ages in years taken out as the bot takes them out of its fields, one paragraph, a full stop, and the style.
export function gPrompt(value: { people?: { who?: unknown }[]; prompt?: unknown }, sheet: Character[]) {
  const names = sheet.map(one => one.name);
  const strangers = (value.people ?? []).map(person => String(person.who ?? '').trim())
    .filter(who => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, names) === null);
  const stripped = stripNames(stripAges(String(value.prompt ?? '')), [...names, ...strangers]);
  const text = stripped.text.replace(/\s+/g, ' ').trim();
  return { prompt: text ? `${/[.!?]$/.test(text) ? text : `${text}.`} ${STYLE}` : '', namesStripped: stripped.removed };
}
// Each instruction by one hash, for the records: the bot's frame and G's, as a made-up sheet of one gets them.
const TEMPLATE_SHEET: Character[] = [{ name: 'Имя', look: 'a look', outfit: 'wearing an outfit' }];
export const INSTRUCTIONS = { frame: sha256(frameRequest({ system: '', messages: [] }, TEMPLATE_SHEET).messages.at(-1)!.content),
  g: sha256(gInstruction(TEMPLATE_SHEET)) };

// ---- Round two ----

// A round-two scene as its text run left it: the sheet with its looks retold and the clothes of the scene before
// (`worn`), round two's checklist of the scene, and the request the bot describes the scene from, built from a copy of
// the story's store, since round two's own directory is never written.
export function roundScene(round2: string, scene: string) {
  const dir = storyDir(round2, scene), text = readJson<StoryText>(join(dir, 'text.json'));
  const checklist = readJson<Checklist>(join(dir, 'checklist.json'));
  if (!text?.worn?.length || !text.nodeId || !checklist) throw new Refusal(`${dir} has no sheet, scene or checklist: pass --round2 <round two's run directory>`);
  const temp = mkdtempSync(join(tmpdir(), 'simple-chat-prompt-arms-'));
  try {
    copyFileSync(join(dir, 'story.sqlite'), join(temp, 'story.sqlite'));
    const store = new Store(join(temp, 'story.sqlite'));
    try {
      const state = store.read(USER), storyId = Object.keys(state.stories)[0];
      const branchId = Object.keys(state.stories[storyId].branches)[0];
      const memory = state.stories[storyId].branches[branchId]?.memory ?? null;
      const parts = contextParts(state, { storyId, head: text.nodeId, memory });
      const excerpt: Excerpt = { system: storyNarration(state, storyId).system, messages: [...parts.seed, ...parts.memory, ...parts.tail] };
      return { worn: text.worn, checklist, excerpt };
    } finally { store.close(); }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
const roundPrompt = (round2: string, scene: string, arm: 'A' | 'A+') =>
  readJson<{ arms: Record<string, { prompt?: string }> }>(join(storyDir(round2, scene), 'plan.json'))?.arms[arm]?.prompt ?? '';

// ---- The hosted prompts ----

// Every call to the hosted model, as counts and a code; and each prompt as it will be drawn, beside its outcome.
type Row = { scene: string; arm: 'C0' | 'G'; attempt: number; inputTokens: number | null; outputTokens: number | null; finish: 'stop' | 'length' | null;
  code: string | null; httpStatus?: number; ms: number };
export type Asked = { outcome: 'ok' | 'unparsed' | 'truncated' | 'schema' | 'failed'; code?: string; httpStatus?: number; attempts: number; ms: number;
  instruction: string; schemaFits?: boolean; prompt?: string; namesStripped?: number; fromSheet?: number; withoutLook?: number; people?: number };
export type PromptsRecord = { model: string; startedAt: string; rows: Row[]; scenes: Record<string, { C0?: Asked; G?: Asked }> };
const MODEL = 'openrouter:google/gemma-4-31b-it';
// The lead's cap for this probe (2026-09-28): 40 requests on openrouter-paid, retries and the pilot included.
export const REQUEST_CAP = 40;
const capError = () => Object.assign(new Error('request_cap'), { code: 'request_cap' });
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// The provider as one prompt sees it: every attempt a row, none beyond the cap.
function counted(inner: Provider, rows: Row[], scene: string, arm: 'C0' | 'G') {
  let attempts = 0, last: 'stop' | 'length' | null = null;
  const provider: Provider = {
    async generate(request, controls) {
      if (rows.length >= REQUEST_CAP) throw capError();
      const began = performance.now(), row = { scene, arm, attempt: ++attempts };
      try {
        const result = await inner.generate(request, controls);
        last = result.finishReason;
        rows.push({ ...row, inputTokens: count(result.usage?.inputTokens), outputTokens: count(result.usage?.outputTokens), finish: result.finishReason, code: null,
          ms: Math.round(performance.now() - began) });
        return result;
      } catch (error) {
        last = null;
        rows.push({ ...row, inputTokens: null, outputTokens: null, finish: null, code: codeOf(error), ...(detailsOf(error).httpStatus ? { httpStatus: detailsOf(error).httpStatus } : {}),
          ms: Math.round(performance.now() - began) });
        throw error;
      }
    },
  };
  return { provider, attempts: () => attempts, last: () => last };
}
// A call that closes the channel for the day: the ledger's cap, the probe's, and a paid API's refusal (the lead: stop
// the channel on budget_exceeded, 402 or 403).
const closes = (asked: Asked) => asked.code === 'budget_exceeded' || asked.code === 'request_cap' || [401, 402, 403].includes(asked.httpStatus ?? 0);

// C0 and G of each scene not yet answered, C0 first: the bot's frame and its assembly, then G's prompt. An answer is
// kept whatever its outcome, and a scene's arm is asked again only while it has none that is `ok`, within the cap.
export async function askPrompts(options: { run: string; round2: string; scenes: string[]; arms: ('C0' | 'G')[]; provider: Provider; model: string;
  log: (event: object) => void }) {
  const file = join(options.run, PROMPTS_FILE);
  const record: PromptsRecord = readJson<PromptsRecord>(file) ?? { model: options.model, startedAt: new Date().toISOString(), rows: [], scenes: {} };
  if (record.model !== options.model) throw new Refusal(`${file} holds another model's prompts: one run directory holds one model's`);
  for (const scene of options.scenes) {
    const input = roundScene(options.round2, scene);
    for (const arm of options.arms) {
      const had = record.scenes[scene]?.[arm];
      if (had?.outcome === 'ok' && had.instruction === INSTRUCTIONS[arm === 'C0' ? 'frame' : 'g']) continue;
      const request = arm === 'C0' ? frameRequest(input.excerpt, input.worn) : gRequest(input.excerpt, input.worn);
      const counting = counted(options.provider, record.rows, scene, arm), began = performance.now();
      let asked: Asked;
      const base = () => ({ attempts: counting.attempts(), ms: Math.round(performance.now() - began), instruction: INSTRUCTIONS[arm === 'C0' ? 'frame' : 'g'] });
      try {
        const { value } = await askJson(counting.provider, request);
        const schemaFits = fitsSchema(value, request.outputSchema as Schema);
        if (counting.last() === 'length') asked = { outcome: 'truncated', ...base(), schemaFits };
        else if (arm === 'C0') {
          const assembled = assemblePrompt(value as unknown as Description, input.worn);
          asked = { outcome: 'ok', ...base(), schemaFits, prompt: assembled.prompt, namesStripped: assembled.namesStripped, fromSheet: assembled.fromSheet,
            withoutLook: assembled.withoutLook, people: Array.isArray(value.people) ? value.people.length : 0 };
        } else {
          const written = gPrompt(value as { people?: { who?: unknown }[]; prompt?: unknown }, input.worn);
          asked = { outcome: written.prompt && schemaFits ? 'ok' : 'schema', ...base(), schemaFits, ...(written.prompt ? { prompt: written.prompt } : {}),
            namesStripped: written.namesStripped, people: Array.isArray(value.people) ? value.people.length : 0 };
        }
      } catch (error) {
        const raw = (error as { code?: unknown }).code, { httpStatus } = detailsOf(error);
        asked = raw === 'unparsed_description' ? { outcome: 'unparsed', ...base() }
          : { outcome: 'failed', code: raw === 'request_cap' ? 'request_cap' : codeOf(error), ...(httpStatus ? { httpStatus } : {}), ...base() };
      }
      record.scenes[scene] = { ...record.scenes[scene], [arm]: asked };
      writeJson(file, record);
      options.log({ event: 'prompt', scene, arm, outcome: asked.outcome, ...(asked.code ? { code: asked.code } : {}), ...(asked.httpStatus ? { httpStatus: asked.httpStatus } : {}),
        attempts: asked.attempts, ms: asked.ms, requests: record.rows.length, ...(asked.prompt ? { words: asked.prompt.split(/\s+/).length } : {}) });
      if (closes(asked)) {
        options.log({ event: 'channel_closed', code: asked.code ?? null, httpStatus: asked.httpStatus ?? null, requests: record.rows.length });
        return record;
      }
    }
  }
  return record;
}

// ---- The checks ----

// The words that name each essential relation of a scene's checklist (round two's checklist.json, the ids its judges
// use), all the groups of one alternative within one sentence: a stem matches at the start of a word, a pattern as it
// is. Drafted from the checklists' own quotes and calibrated on round two's A and A+ prompts against Astra's text answers
// (`checks` prints the agreement). They read words, not pictures, and say whether a prompt asks for the contact at all.
type Alternative = (string | RegExp)[];
const CONTACTS: Record<string, Record<string, Alternative[]>> = {
  bandage: { r1: [['bandag|wrap|dress|bind|wind', 'forearm']], r2: [['secur|fasten|tuck|pin|clip|tape|tie|knot', 'end|tail|edge']] },
  beach: { r1: [['surround|encircl|circle|ring|hem|crowd|close in|swarm']], r2: [['surround|encircl|circle|ring|hem|crowd|close in|swarm']],
    r3: [['block|bar|obstruct|cut off|in his path', 'shoulder']], r6: [['clutch|hug|press|hold|clasp|cradl|squeez', 'ball', 'chest']] },
  cheer: { r1: [['palm|hands', 'foot|feet|sole']], r2: [['palm|hands', 'foot|feet|sole']] },
  demon: { r1: [['wrap|lock|clasp|grab|grip|hold|hug|seiz|restrain', 'torso|waist|chest|midsection|body', 'behind|from the back|from the rear']],
    r2: [['grip|grab|lock|hold|clamp|seiz|twist|wrench|pin|trap', 'forearm|wrist|arm\\b']],
    r3: [['wrap|clasp|grab|grip|hold|hug|lock|clutch|seiz|tackl|cling', 'legs|knees|thighs|ankles|shins']] },
  giants: { r1: [['collar|scruff', 'hold|lift|grip|grab|hoist|dangl|suspend|rais|pick']], r2: [['poke|prod|jab|nudg|tap', 'side|ribs|flank|waist']],
    r5: [['neck|throat|chok|strangl|tight|constrict', 'collar|cloak|fabric']] },
  guard: { r1: [['legs', 'waist|torso|body|midsection|hips', 'wrap|lock|clamp|squeez|around|encircl|hook|cross']],
    r2: [['chest', 'press|push|lean|against|drive|bear']], r3: [['legs', 'push|pry|spread|forc|break|separat|apart|open']],
    r4: [[/\b(?:with|using) (?:his|both|the) shoulders?\b/i], [/\bshoulders? (?:into|against|onto|down on)\b/i]],
    r5: [['collar|lapel', 'grip|grab|hold|pull|tug|clutch|seiz']], r6: [['on his back|on her back|flat on|supine']] },
  gulliver: { r1: [['stand|perch|plant', 'chest']], r3: [['lie|lies|lying|sprawl', 'grass|ground|meadow|lawn']],
    r4: [['hair', 'peg|stake|tie|tied|bound|thread|rope|strand']], r5: [['wrist', 'rope|tie|tied|bound|cord|line']],
    r7: [['rope|cord|line', 'grip|hold|grab|clutch|pull|haul|tug|grasp']], r8: [['whole body|full weight|entire body|all her weight|full body|body weight']],
    r9: [['rope|cord', 'pull|haul|tug|heav']], r10: [['feet|foot|legs|heels', 'brac|plant|dig|dug|against the ground|push']] },
  gym: { r1: [['barbell|bar\\b', 'shoulder|back|trapez|neck']], r2: [['lower|bring down|hing', 'bar']], r3: [['dumbbell', 'hold|grip|carr|clutch|each hand']],
    r4: [['kettlebell', 'swing']] },
  jellyfish: { r1: [['head|crown|scalp', 'sit|perch|cling|stuck|atop|on top|rest']], r2: [['hair', 'hand|finger|tentacle|comb|tousl|play|touch|run|stroke|pat|pick']],
    r3: [['shoulder', 'cling|hug|wrap|clasp|grip|hold|embrac|drap']], r4: [['right wrist', 'wrap|coil|twin|squeez|grip|clamp|curl|around']],
    r5: [[/\b(?:grip|squeez|clutch|grab|clench|hold)\w*(?:\W+\w+){0,4}?\W+(?:telnyashka|shirt|fabric|sleeve)/i]] },
  lineout: { r1: [['support|lift|hoist|boost|held|hold|prop|rest|lean', 'shoulders']], r2: [['support|lift|hoist|boost|held|hold|prop|rest|lean', 'shoulders']],
    r3: [['collid|clash|crash|bump|slam|smash|barg|ram|hit']] },
  monkeys: { r1: [['sunglasses|glasses', 'chest|breast|clutch|hug|clasp|press']], r2: [['lace|shoelace|bootlace']],
    r3: [['strap', 'grip|grab|cling|clutch|hang|pull|tug|hold|seiz']],
    r4: [[/\b(?:holds?|holding|clutch\w*|grip\w*|clasp\w*|hug\w*) (?:on to |onto |on )?(?:her|the) (?:own )?(?:\w+ )?(?:backpack|rucksack)/i]] },
  rescue: { r1: [['handle|stretcher', 'hold|grip|carr|grasp|lift|clutch']], r2: [['rear|back end|far end|other end|opposite|foot end', 'stretcher|handle']],
    r3: [['drip|iv\\b|bottle|bag|infusion|saline', 'high|raise|aloft|above|up\\b']], r4: [['strap|belt|buckl|harness|secured|tied|fastened|bound']],
    r5: [[/\b(?:rigid|hard|stiff) (?:base|board|stretcher|frame)/i], [/\bbackboard/i], [/\bpressed (?:flat )?(?:against|onto|to) the stretcher/i]] },
};
const group = (one: string | RegExp) => (typeof one === 'string' ? new RegExp(`\\b(?:${one})`, 'i') : one);
const sentencesOf = (prompt: string) => prompt.split(/(?<=[.;!?])\s+/).filter(Boolean);
// The essential relations a prompt names, and the first sentence that names one, from 1.
export function namedContacts(prompt: string, scene: string, essential: string[]) {
  const sentences = sentencesOf(prompt), terms = CONTACTS[scene] ?? {};
  const names = (id: string, sentence: string) => (terms[id] ?? []).some(alternative => alternative.every(one => group(one).test(sentence)));
  const named = essential.filter(id => sentences.some(sentence => names(id, sentence)));
  const first = sentences.findIndex(sentence => essential.some(id => names(id, sentence)));
  return { named, first: first < 0 ? null : first + 1 };
}
const norm = (text: string) => text.toLowerCase().replace(/[“”"]/g, '').replace(/\s+/g, ' ').trim();
// A look is kept when the prompt holds it whole, in any case, an article at its start aside.
const kept = (prompt: string, look: string) => norm(prompt).includes(norm(look).replace(/^(?:a|an|the) /, ''));
export type PromptCheck = { words: number; looks: { kept: number; of: number; missing: string[] }; contacts: { named: number; of: number; missing: string[] };
  firstAction: number | null; digits: number; nonLatin: number; names: number; wearing: number; bare: number; style: boolean; tokens?: number };
// One prompt against its scene: the looks of the checklist's participants whom the sheet knows, the scene's essential
// contacts, whether the first sentence names one, and what the image model is not to get: digits, letters outside the
// Latin script, the sheet's names; the clothes said with "wearing" and the bare skin named; the style line at the end.
export function checkPrompt(prompt: string, scene: string, checklist: Checklist, worn: Character[], tokens?: (text: string) => number): PromptCheck {
  const looks = sheetLooks(worn);
  const entries = checklist.participants.flatMap(one => (one.entry ? [one.entry] : []));
  const lookOf = (entry: string) => looks.get(worn[Number(entry.slice(1)) - 1]?.name.trim().toLowerCase() ?? '') ?? '';
  const missingLooks = entries.filter(entry => !lookOf(entry) || !kept(prompt, lookOf(entry)));
  const essential = checklist.items.filter(item => item.kind === 'relation' && item.essential).map(item => item.id);
  const contacts = namedContacts(prompt, scene, essential);
  return { words: prompt.split(/\s+/).filter(Boolean).length, looks: { kept: entries.length - missingLooks.length, of: entries.length, missing: missingLooks },
    contacts: { named: contacts.named.length, of: essential.length, missing: essential.filter(id => !contacts.named.includes(id)) },
    firstAction: contacts.first, digits: (prompt.match(/\d/g) ?? []).length,
    nonLatin: [...prompt].filter(char => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)).length,
    names: stripNames(prompt, worn.map(one => one.name)).removed, wearing: (prompt.match(/\bwearing\b/gi) ?? []).length,
    bare: (prompt.match(/\b(?:bare\w*|barefoot|shirtless|topless|naked|nude)\b/gi) ?? []).length, style: prompt.trimEnd().endsWith(STYLE),
    ...(tokens ? { tokens: tokens(prompt) } : {}) };
}
// Every arm's prompts that exist in the run, checked, with the totals an arm is read by; and the contacts' words
// against Astra's text answers on round two's A and A+ prompts: how often both say a prompt names a contact, neither
// does, or only one.
export function checkAll(run: string, round2: string, tokenizers?: string) {
  const qwen = tokenizers ? loadTokenizers(tokenizers).qwen() : undefined;
  const tokens = qwen ? (text: string) => qwenPromptTokens(qwen, text, 'qwen_image').prompt : undefined;
  const hosted = readJson<PromptsRecord>(join(run, PROMPTS_FILE));
  const rewrites = { PE: readJson<Rewrites>(join(run, REWRITES_FILE.fast)), PT: readJson<Rewrites>(join(run, REWRITES_FILE.think)) };
  const arms: Record<string, Record<string, PromptCheck>> = { C0: {}, G: {}, PE: {}, 'A+': {}, PT: {}, A: {} };
  const agreement: Record<'A' | 'A+', { both: number; neither: number; codeOnly: number; astraOnly: number }> = {
    A: { both: 0, neither: 0, codeOnly: 0, astraOnly: 0 }, 'A+': { both: 0, neither: 0, codeOnly: 0, astraOnly: 0 } };
  for (const scene of SCENES) {
    const dir = storyDir(round2, scene), worn = readJson<StoryText>(join(dir, 'text.json'))?.worn ?? [];
    const checklist = readJson<Checklist>(join(dir, 'checklist.json'));
    if (!checklist) throw new Refusal(`${dir} has no checklist: pass --round2 <round two's run directory>`);
    const prompts: Partial<Record<string, string>> = { C0: hosted?.scenes[scene]?.C0?.prompt, G: hosted?.scenes[scene]?.G?.prompt,
      PE: rewrites.PE?.scenes[scene]?.prompt, PT: rewrites.PT?.scenes[scene]?.prompt, 'A+': roundPrompt(round2, scene, 'A+') || undefined,
      A: roundPrompt(round2, scene, 'A') || undefined };
    for (const [arm, prompt] of Object.entries(prompts)) if (prompt) arms[arm][scene] = checkPrompt(prompt, scene, checklist, worn, tokens);
    const answers = readJson<{ prompts?: Record<string, Record<string, string>> }>(join(dir, 'answers', 'text.json'));
    const keys = readJson<{ prompts?: { id: string; arm: string }[] }>(join(dir, 'keys', 'text.json'));
    const essential = checklist.items.filter(item => item.kind === 'relation' && item.essential).map(item => item.id);
    for (const arm of ['A', 'A+'] as const) {
      const id = keys?.prompts?.find(one => one.arm === arm)?.id, said = id ? answers?.prompts?.[id] : undefined, prompt = prompts[arm];
      if (!said || !prompt) continue;
      const named = namedContacts(prompt, scene, essential).named;
      for (const relation of essential) {
        const code = named.includes(relation), astra = said[relation] === 'yes', tally = agreement[arm];
        if (code && astra) tally.both++; else if (!code && !astra) tally.neither++; else if (code) tally.codeOnly++; else tally.astraOnly++;
      }
    }
  }
  const totals = Object.fromEntries(Object.entries(arms).filter(([, scenes]) => Object.keys(scenes).length).map(([arm, scenes]) => {
    const all = Object.values(scenes), sum = (read: (one: PromptCheck) => number) => all.reduce((total, one) => total + read(one), 0);
    const words = all.map(one => one.words), tokenCounts = all.flatMap(one => (one.tokens === undefined ? [] : [one.tokens]));
    return [arm, { scenes: all.length, looksKept: sum(one => one.looks.kept), looks: sum(one => one.looks.of), scenesAllLooks: all.filter(one => one.looks.kept === one.looks.of).length,
      contactsNamed: sum(one => one.contacts.named), contacts: sum(one => one.contacts.of), scenesAllContacts: all.filter(one => one.contacts.named === one.contacts.of).length,
      actionFirst: all.filter(one => one.firstAction === 1).length, withDigits: all.filter(one => one.digits).length, withNonLatin: all.filter(one => one.nonLatin).length,
      withNames: all.filter(one => one.names).length, wearing: sum(one => one.wearing), bare: sum(one => one.bare), styleAtEnd: all.filter(one => one.style).length,
      words: [Math.min(...words), Math.max(...words)], ...(tokenCounts.length ? { tokens: [Math.min(...tokenCounts), Math.max(...tokenCounts)] } : {}) }];
  }));
  return { arms, totals, agreement };
}

// ---- The freeze ----

// frozen.json: C0 and G of every scene as the hosted model answered them under this file's instructions, and round two's
// A+ as round two drew it. Written once: a run whose frozen texts would change is refused, and the card draws only the
// file this module pins.
export function freeze(run: string, round2: string) {
  const record = readJson<PromptsRecord>(join(run, PROMPTS_FILE));
  const good = (asked: Asked | undefined, kind: 'frame' | 'g') => asked?.outcome === 'ok' && asked.instruction === INSTRUCTIONS[kind] && !!asked.prompt?.trim();
  const missing = SCENES.flatMap(scene => [...good(record?.scenes[scene]?.C0, 'frame') ? [] : [`C0-${scene}`], ...good(record?.scenes[scene]?.G, 'g') ? [] : [`G-${scene}`],
    ...roundPrompt(round2, scene, 'A+').trim() ? [] : [`A+-${scene}`]]);
  if (!record || missing.length) throw new Refusal(`No text yet for ${missing.length || 'any'} of the probe's prompts (${missing.join(', ')}); nothing is frozen`);
  const frozen: Frozen = { note: 'The prompt arms probe\'s frozen texts: C0 and G from the hosted model under the instructions hashed here, A+ from round two\'s plans.',
    model: record.model, instructions: INSTRUCTIONS, scenes: Object.fromEntries(SCENES.map(scene => [scene, { C0: record.scenes[scene].C0!.prompt!,
      G: record.scenes[scene].G!.prompt!, 'A+': roundPrompt(round2, scene, 'A+') }])) };
  const bytes = JSON.stringify(frozen, null, 2), file = join(run, FROZEN_FILE);
  if (existsSync(file) && readFileSync(file, 'utf8') !== bytes) throw new Refusal(`${file} holds other texts: move it aside; nothing is frozen`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sha256: sha256(bytes) };
}

// ---- The enhancer ----

// Qwen-Image 2.1's text-to-image prompt enhancer, a Qwen3.5 9B beside the image model in Comfy-Org's repository, and
// the system prompt its model card ships (Qwen/Qwen-Image-2.1-PE-T2I at f3ed7985), which asks for one JSON line with
// `rewritten_prompt` and `wh_ratio`. The Qwen Research License's text, so it is fetched into the run and checked, never
// kept in the repository. ComfyUI's template (node 475) wraps the same text with a plain paragraph for an answer and
// passes it through a `system_prompt` input the pinned TextGenerate does not have; here the whole chat goes in as the
// prompt, as the model card lays it out (docs/action-experiment.md#prompt-arms).
export const PE = { file: MANIFEST.IMAGE_QWEN_PE_T2I_FILE, sha256: MANIFEST.IMAGE_QWEN_PE_T2I_SHA256,
  systemUrl: 'https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I/resolve/f3ed7985c788ad75b3ab7223e0c4c51e2a43545b/system_prompt.txt',
  systemSha256: 'a77c9a06c59b120741141d9514b95682bb8761d02bec49ca61def7b2b3d9fb99' };
export type Mode = 'fast' | 'think';
// The card's sampling (temperature 1, top-p 0.95, top-k 20, no penalty) and one seed for every rewrite. New tokens at
// most: a rewrite without thinking is a paragraph of a few hundred; with thinking the card allows 16256, which at the
// card's pace would outlast the probe, so the thinking is cut at 4096 and the scene then has no PT.
const MAX_LENGTH: Record<Mode, number> = { fast: 1536, think: 4096 };
const SAMPLING = { temperature: 1, top_k: 20, top_p: 0.95, min_p: 0, repetition_penalty: 1, seed: 20260928, presence_penalty: 0 };
const PREVIEW = '3';
// The chat as Qwen3.5's own template lays it out, the enhancer's system prompt stripped as its card strips it; the
// assistant's turn opens with an empty thought without thinking, and with an open one with it. A prompt that starts
// with <|im_start|> is taken as it is by the pinned tokenizer (comfy/text_encoders/qwen35.py:1046).
export const chatOf = (system: string, prompt: string, mode: Mode) => `<|im_start|>system\n${system.trim()}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n`
  + `<|im_start|>assistant\n${mode === 'fast' ? '<think>\n\n</think>\n\n' : '<think>\n'}`;
// One rewrite's graph: the enhancer through CLIPLoader, TextGenerate on the chat, and PreviewAny, which puts the text in
// the job's record; its `nonce`, an input it does not declare, makes every job run it afresh, as the harness's previews.
export function peGraph(system: string, prompt: string, mode: Mode, nonce: string): Graph {
  return {
    '1': { class_type: 'CLIPLoader', inputs: { clip_name: PE.file, type: 'stable_diffusion', device: 'default' } },
    '2': { class_type: 'TextGenerate', inputs: { clip: ['1', 0], prompt: chatOf(system, prompt, mode), max_length: MAX_LENGTH[mode], sampling_mode: 'on',
      ...Object.fromEntries(Object.entries(SAMPLING).map(([key, value]) => [`sampling_mode.${key}`, value])), thinking: mode === 'think',
      use_default_template: true, mtp: 'auto' } },
    [PREVIEW]: { class_type: 'PreviewAny', inputs: { source: ['2', 0], nonce } },
  };
}
export const settingsOf = (mode: Mode, system: string) => ({ file: PE.file, fileSha256: PE.sha256, system: sha256(system), mode, maxLength: MAX_LENGTH[mode],
  ...SAMPLING, template: 'chat' });
// A rewrite as the card returned it: its text only when it is a rewrite, and of the thinking its length alone. `form`:
// the JSON object the system prompt asks for, alone or in one fenced block; `whRatio`, the ratio it asks for, recorded
// and never drawn.
export type Rewrite = { status: 'ok' | 'failed'; code?: string; httpStatus?: number; ms: number; prompt?: string; form?: 'json' | 'fenced';
  whRatio?: string; thinkingChars?: number; answerChars?: number; stopped?: boolean; oom?: boolean };
export type Rewrites = { settings: ReturnType<typeof settingsOf>; scenes: Record<string, Rewrite> };
// The rewrites that are the enhancer's own failure, which the judging counts as a frame showing nothing: the job failed
// on the card, outlasted its time, never closed its thought, answered no such object, or an empty prompt. A pass the
// card's end or the server cut is not reached, not failed.
export const ENHANCER_FAILURES = ['pe_failed', 'pe_timeout', 'pe_truncated', 'pe_unparsed', 'pe_empty'];
// The answer after the last </think>, as the card's own code splits it, read as the review of 2026-09-28 fixed before
// the card: the JSON object the system prompt asks for, alone or in one fenced block, whose `rewritten_prompt` alone
// the image model gets, on the probe's 1280x704 canvas whatever `wh_ratio` asks. Anything else is the enhancer's
// failure: a thinking that never closed `pe_truncated`, no such object `pe_unparsed`, an empty prompt `pe_empty`.
export function parseRewrite(text: string, mode: Mode): Omit<Rewrite, 'ms'> {
  const cut = text.lastIndexOf('</think>');
  const thinkingChars = cut >= 0 ? cut : mode === 'think' ? text.length : 0;
  if (mode === 'think' && cut < 0) return { status: 'failed', code: 'pe_truncated', thinkingChars, answerChars: 0 };
  const answer = (cut >= 0 ? text.slice(cut + '</think>'.length) : text).trim(), fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(answer)?.[1];
  let value: unknown;
  try { value = JSON.parse(fenced ?? answer); } catch { value = undefined; }
  const fields = value && typeof value === 'object' && !Array.isArray(value) ? value as { rewritten_prompt?: unknown; wh_ratio?: unknown } : undefined;
  if (typeof fields?.rewritten_prompt !== 'string') return { status: 'failed', code: 'pe_unparsed', thinkingChars, answerChars: answer.length };
  const prompt = fields.rewritten_prompt.trim(), ratio = typeof fields.wh_ratio === 'string' ? fields.wh_ratio.trim() : '';
  // A ratio is digits and their separators, and nothing of the answer's words.
  const whRatio = /^[\d.:/x ]{1,12}$/.test(ratio) ? { whRatio: ratio } : {};
  return prompt ? { status: 'ok', prompt, form: fenced === undefined ? 'json' : 'fenced', ...whRatio, thinkingChars, answerChars: answer.length }
    : { status: 'failed', code: 'pe_empty', ...whRatio, thinkingChars, answerChars: answer.length };
}
// The server has the enhancer: the file among CLIPLoader's, the pinned TextGenerate with its sampling and template
// switches, and PreviewAny.
async function enhancerOffered(comfy: Comfy) {
  const info = async (name: string) => JSON.stringify(await (await call(comfy, `/object_info/${name}`)).json());
  const [loader, generate, preview] = [await info('CLIPLoader'), await info('TextGenerate'), await info('PreviewAny')];
  return loader.includes(JSON.stringify(PE.file)) && generate.includes('"sampling_mode"') && generate.includes('"use_default_template"') && preview.includes('"source"');
}
// The card's record with the enhancer's line: the bootstrap verified it (gpu/image-bootstrap.sh, SIMPLE_CHAT_IMAGE_QWEN_PE).
function cardHasEnhancer(file: string) {
  if (!existsSync(file)) return false;
  cardOf(file);
  return readFileSync(file, 'utf8').split('\n').some(line => line.trim() === `${PE.sha256}  ${PE.file}`);
}

type HistoryRecord = { status?: { completed?: boolean; status_str?: string; messages?: [string, { exception_type?: unknown }][] };
  outputs?: Record<string, { text?: unknown[] }> };
// Polls of a job's record that may fail in a row before the rewrite is given up, as the harness allows its pictures.
const POLL_RETRIES = 3;
// A failure that says the server is gone or the graph is wrong ends the pass: every scene after it would fail alike.
const STOPS = new Set(['comfy_http_error', 'comfy_rejected_prompt', 'comfy_unreachable', 'out_of_time', 'comfy_stop_unconfirmed']);
// One rewrite: submitted under an id of its own, its record read until the job is over or its time is up, and deleted
// once read, since it holds the chat. A job whose time is up is stopped by name (image-batch.ts `stopJob`) with the
// minute the end keeps for that.
async function rewriteOne(comfy: Comfy, graph: Graph, mode: Mode, timeoutMs: number, pollMs: number): Promise<Rewrite> {
  const began = performance.now(), ms = () => Math.round(performance.now() - began);
  const reserve: Comfy = { baseUrl: comfy.baseUrl, timeoutMs: comfy.timeoutMs, end: comfy.reserve };
  const forget = (id: string) => post(reserve, '/history', { delete: [id] }).catch(() => undefined);
  const failure = (error: unknown, extra: Partial<Rewrite> = {}): Rewrite => {
    const raw = (error as { code?: unknown }).code;
    const lost = (error instanceof TypeError && error.message === 'fetch failed') || (error as { name?: unknown }).name === 'TimeoutError';
    const code = typeof raw === 'string' && DRAW_CODES.includes(raw) ? raw : lost ? 'comfy_unreachable' : 'pe_failed';
    const { httpStatus } = safeErrorDetails(error);
    return { status: 'failed', code, ...(httpStatus ? { httpStatus } : {}), ms: ms(), ...extra };
  };
  let id: string = randomUUID();
  try {
    const answer = await (await post(comfy, '/prompt', { prompt: graph, prompt_id: id })).json() as { prompt_id?: unknown };
    if (typeof answer.prompt_id !== 'string' || !answer.prompt_id) return { status: 'failed', code: 'comfy_rejected_prompt', ms: ms() };
    id = answer.prompt_id;
  } catch (error) { return failure(error); }
  try {
    for (let misses = 0; ;) {
      await delay(pollMs, undefined, { signal: comfy.end }).catch(() => undefined);
      if (comfy.end?.aborted || performance.now() - began > timeoutMs) {
        const stopped = await stopJob(reserve, id, pollMs);
        await forget(id);
        return { status: 'failed', code: comfy.end?.aborted ? 'out_of_time' : 'pe_timeout', ms: ms(), stopped };
      }
      let entry: HistoryRecord | undefined;
      try {
        entry = ((await (await call(comfy, `/history/${id}`)).json()) as Record<string, HistoryRecord>)[id];
        misses = 0;
      } catch (error) {
        if (++misses > POLL_RETRIES) throw error;
        continue;
      }
      if (!entry?.status?.completed && entry?.status?.status_str !== 'error') continue;
      await forget(id);
      if (!entry.status.completed) {
        const oom = (entry.status.messages ?? []).some(([, data]) => /OutOfMemory/.test(String(data?.exception_type ?? '')));
        return { status: 'failed', code: 'pe_failed', ms: ms(), ...(oom ? { oom } : {}) };
      }
      const text = entry.outputs?.[PREVIEW]?.text?.[0];
      return { ...parseRewrite(typeof text === 'string' ? text : '', mode), ms: ms() };
    }
  } catch (error) {
    const stopped = await stopJob(reserve, id, pollMs);
    await forget(id);
    return failure(error, { stopped });
  }
}

// One pass of rewrites, scene by scene, each begun only if its time and the frames after it still fit before `until`:
// `need` prices the frames of the stand the pass feeds once `scenes` of it have a rewrite. A scene is rewritten once,
// whatever comes back; one never begun is begun on a resume. The first rewrite of a pass loads the enhancer.
async function rewritePass(options: { comfy: Comfy; mode: Mode; file: string; system: string; frozen: Frozen; until: number; timeoutMs: number; loadMs: number;
  pollMs: number; need: (scenes: number) => number; log: (event: object) => void }): Promise<Rewrites> {
  const settings = settingsOf(options.mode, options.system);
  const record: Rewrites = readJson<Rewrites>(options.file) ?? { settings, scenes: {} };
  if (!same(record.settings, settings)) throw new Refusal(`${options.file} was rewritten with other settings or another system prompt: move it aside; nothing is sent`);
  let first = true;
  for (const scene of SCENES) {
    if (record.scenes[scene]) continue;
    const ok = SCENES.filter(one => record.scenes[one]?.status === 'ok').length, open = SCENES.filter(one => !record.scenes[one]).length;
    const needMs = options.timeoutMs + (first ? options.loadMs : 0) + options.need(ok + open);
    if (options.comfy.end?.aborted || Date.now() + needMs > options.until) {
      options.log({ event: 'rewrite_not_begun', mode: options.mode, scene, needSeconds: Math.ceil(needMs / 1000),
        leftSeconds: Math.max(0, Math.floor((options.until - Date.now()) / 1000)) });
      break;
    }
    const result = await rewriteOne(options.comfy, peGraph(options.system, options.frozen.scenes[scene].C0, options.mode, randomUUID()), options.mode,
      options.timeoutMs + (first ? options.loadMs : 0), options.pollMs);
    first = false;
    record.scenes[scene] = result;
    writeJson(options.file, record);
    options.log({ event: 'rewrite', mode: options.mode, scene, status: result.status, ...(result.code ? { code: result.code } : {}), ms: result.ms,
      ...(result.form ? { form: result.form } : {}), ...(result.prompt ? { words: result.prompt.split(/\s+/).length } : {}),
      ...(result.thinkingChars ? { thinkingChars: result.thinkingChars } : {}) });
    if (result.code && STOPS.has(result.code)) break;
  }
  return record;
}
const rewritten = (record: Rewrites | undefined) => SCENES.filter(scene => record?.scenes[scene]?.status === 'ok');

// ---- The card ----

// The rewrites' times, before the card has measured one: a paragraph without thinking in about 20 s and with it in
// about a minute, at a 9B's pace on the card (unmeasured); the time a rewrite is waited for, and the load of the
// enhancer beside the image model's weights at a pass's start (docs/action-experiment.md#prompt-arms).
export const REWRITE_MS = { fast: 20000, think: 60000 }, TIMEOUT_MS = { fast: 90000, think: 240000 }, LOAD_MS = 60000;
// A swap of the enhancer and the image model as the estimate expects it, and the slot the card plan gives the probe.
const SWAP_MS = 20000, SLOT_MINUTES = 40;
const priceOf = (ms: number) => Math.round(ms * MARGIN + CELL_MS);
// The warm price of a frame from the words: the slowest of the core stand's warm frames once it has drawn, the seeded
// time until then.
const framePrice = (index: StandIndex | undefined) => priceOf(Math.max(0, ...Object.values(index?.cells ?? {})
  .filter(cell => cell.status === 'drawn' && !cell.cold && !cell.firstOfGroup && cell.totalMs !== undefined).map(cell => cell.totalMs!)) || SEED_MS.words);

// Each optional arm's schedule is all twelve scenes at both seeds, begun only when the time left covers all of it at the
// admission prices, and recorded either way in schedules.json: begun, or omitted for want of its budget.
export const SCHEDULES_FILE = 'schedules.json';
export type Schedule = { state: 'begun' | 'omitted'; needSeconds: number; leftSeconds: number; at: string };
export type Schedules = Partial<Record<Optional, Schedule>>;
const FRAMES = SCENES.length * ARM_SEEDS.length;
// What a schedule needs: for PE and PT the enhancer's load, every rewrite at its time priced as a frame's is, and the
// image model's return; then every frame at `frame`.
export const budgetOf = (arm: Optional, frame: number, rewriteMs: Record<Mode, number>, loadMs = LOAD_MS) => (arm === 'A+' ? SHAPE_MS + FRAMES * frame
  : loadMs + SCENES.length * priceOf(rewriteMs[arm === 'PE' ? 'fast' : 'think']) + SHAPE_MS + FRAMES * frame);
// A rewrite with thinking is priced at its seeded time, scaled up by as much as the card's rewrites without thinking
// took longer than theirs, at their median.
function thinkMs(seeded: Record<Mode, number>, fast: Rewrites | undefined) {
  const times = SCENES.flatMap(scene => (fast?.scenes[scene]?.status === 'ok' ? [fast.scenes[scene].ms] : [])).sort((a, b) => a - b);
  return times.length ? Math.max(seeded.think, Math.round(seeded.think * times[Math.floor(times.length / 2)] / seeded.fast)) : seeded.think;
}

export type CardOptions = { run: string; comfy: string; until: number; frozenSha256?: string; systemSha256?: string; waitMs?: number; timeoutMs?: number;
  pollMs?: number; rewriteTimeoutMs?: Partial<Record<Mode, number>>; rewriteMs?: Partial<Record<Mode, number>>; loadMs?: number; log: (event: object) => void };
export type CardResult = { core: StandIndex; pe?: StandIndex; pt?: StandIndex; schedules: Schedules };
// The whole card, as the review of 2026-09-28 ordered it: every C0 and G frame first; then PE's rewrites and frames,
// A+'s frames, and PT's rewrites and frames, each schedule begun only if the time left covers all of it, and PE's and
// PT's texts fixed once their pass is over, so that a resume draws from them. Refused before anything is sent: the
// frozen texts or the system prompt other than the pinned, a card record without the enhancer's line, a server off the
// bot's path or without the enhancer.
export async function runCard(options: CardOptions): Promise<CardResult> {
  const run = resolve(options.run), log = options.log;
  const frozen = readFrozen(join(run, FROZEN_FILE), options.frozenSha256 ?? FROZEN_SHA256);
  const system = readPinned(join(run, SYSTEM_FILE), options.systemSha256 ?? PE.systemSha256, 'the enhancer\'s system prompt (pe-prompt fetches it)');
  if (!cardHasEnhancer(join(run, 'card.txt'))) {
    throw new Refusal(`${join(run, 'card.txt')} is missing or has no line for ${PE.file}: copy the card's image-verified.txt there, from a bootstrap with SIMPLE_CHAT_IMAGE_QWEN_PE=true; nothing is sent`);
  }
  for (const name of STANDS) {
    const copy = join(run, name, 'card.txt');
    mkdirSync(join(run, name), { recursive: true, mode: 0o700 });
    if (!existsSync(copy)) copyFileSync(join(run, 'card.txt'), copy);
    else if (!readFileSync(copy).equals(readFileSync(join(run, 'card.txt')))) throw new Refusal(`${copy} is another card's record: move ${join(run, name)} aside; nothing is sent`);
  }
  const at = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: at(options.until), reserve: at(options.until + CLEANUP_RESERVE_MS) };
  const server = await serverPins(comfy, true).catch(() => { throw new Refusal('The server did not say what it is on /system_stats; nothing is sent'); });
  const cuda = Number(/\+cu(\d+)$/.exec(server.pytorch ?? '')?.[1] ?? 0);
  if (cuda < 130 || server.triton !== 'enabled' || !(await attentionOffered(comfy).catch(() => false))) {
    throw new Refusal('The probe draws on the bot\'s picture path: a server on cu130 with SIMPLE_CHAT_IMAGE_TRITON=1 whose ModelAttentionBackend offers the kitchen\'s attention (docs/gpu.md#bot-card); nothing is sent');
  }
  if (!(await enhancerOffered(comfy).catch(() => false))) {
    throw new Refusal(`The server has no ${PE.file} among CLIPLoader's files, or no TextGenerate or PreviewAny as pinned: bootstrap with SIMPLE_CHAT_IMAGE_QWEN_PE=true; nothing is sent`);
  }
  const day = new Date().toISOString().slice(0, 10), pollMs = options.pollMs ?? 500, timeouts = { ...TIMEOUT_MS, ...options.rewriteTimeoutMs };
  const seeded = { ...REWRITE_MS, ...options.rewriteMs }, loadMs = options.loadMs ?? LOAD_MS;
  // What the card has compiled, handed to every stand in turn; the enhancer's pass sends the image model away, and the
  // first frame after it is priced as a shape of its own.
  const warmth: Warmth = { reached: false, groups: new Set() };
  const stand = (name: StandName, plan: Planned[], texts: string, keys?: string[]) => {
    const dir = join(run, name), file = join(dir, TEXTS_FILE);
    if (existsSync(file) && readFileSync(file, 'utf8') !== texts) throw new Refusal(`${file} holds other texts than the frozen ones and the rewrites give: move ${dir} aside; nothing more is drawn`);
    if (!existsSync(file)) writeFileSync(file, texts, { mode: 0o600 });
    const earlier = readJson<StandIndex>(join(dir, INDEX_FILE));
    return drawStand({ out: dir, comfy: options.comfy, until: options.until, pinned: sha256(texts), stand: standOf(name, plan, earlier?.startedAt.slice(0, 10) ?? day),
      keys, waitMs: options.waitMs, timeoutMs: options.timeoutMs, pollMs: options.pollMs, warm: warmth, log });
  };
  const pass = (mode: Mode, need: (scenes: number) => number) => rewritePass({ comfy, mode, file: join(run, REWRITES_FILE[mode]), system, frozen, until: options.until,
    timeoutMs: timeouts[mode], loadMs, pollMs, need, log });
  const schedulesFile = join(run, SCHEDULES_FILE), schedules: Schedules = readJson<Schedules>(schedulesFile) ?? {};
  // A schedule begun goes on on a resume; one omitted is weighed again.
  const gate = (arm: Optional, needMs: number) => {
    if (schedules[arm]?.state === 'begun') return true;
    const leftMs = options.until - Date.now(), begun = !comfy.end?.aborted && leftMs >= needMs;
    const one: Schedule = { state: begun ? 'begun' : 'omitted', needSeconds: Math.ceil(needMs / 1000), leftSeconds: Math.max(0, Math.floor(leftMs / 1000)), at: new Date().toISOString() };
    schedules[arm] = one;
    writeJson(schedulesFile, schedules);
    log({ event: begun ? 'schedule_begun' : 'schedule_omitted', arm, needSeconds: one.needSeconds, leftSeconds: one.leftSeconds });
    return begun;
  };

  const coreCells = corePlan(), coreTexts = textsOf(coreCells, frozen), keysOf = (arms: Arm[]) => coreCells.filter(one => arms.includes(one.arm as Arm)).map(one => one.key);
  const result: CardResult = { core: await stand('core', coreCells, coreTexts, keysOf(RESERVED)), schedules };
  const ended = (index: StandIndex) => index.error ?? (index.stopped ? 'until' : undefined);
  const done = (end?: string) => {
    log({ event: 'card_done', core: countsOf(result.core), ...(result.pe ? { pe: countsOf(result.pe) } : {}), ...(result.pt ? { pt: countsOf(result.pt) } : {}),
      schedules: Object.fromEntries(Object.entries(schedules).map(([arm, one]) => [arm, one.state])), ...(end ? { ended: end } : {}) });
    return result;
  };
  if (ended(result.core)) return done(ended(result.core));
  for (const arm of OPTIONAL) {
    const price = framePrice(result.core), rewriteMs = { fast: seeded.fast, think: thinkMs(seeded, readJson<Rewrites>(join(run, REWRITES_FILE.fast))) };
    if (!gate(arm, budgetOf(arm, price, rewriteMs, loadMs))) continue;
    if (arm === 'A+') {
      result.core = await stand('core', coreCells, coreTexts, keysOf(['A+']));
      if (ended(result.core)) return done(ended(result.core));
      continue;
    }
    const mode: Mode = arm === 'PE' ? 'fast' : 'think', name = STAND_OF[arm];
    const rewrites = existsSync(join(run, name, TEXTS_FILE)) ? readJson<Rewrites>(join(run, REWRITES_FILE[mode]))
      : await pass(mode, scenes => SHAPE_MS + ARM_SEEDS.length * scenes * price);
    warmth.groups.clear();
    const cells = rewritePlan(arm, rewritten(rewrites));
    if (!cells.length) continue;
    const drawn = await stand(name, cells, textsOf(cells, frozen, rewrites));
    if (arm === 'PE') result.pe = drawn; else result.pt = drawn;
    if (ended(drawn)) return done(ended(drawn));
  }
  return done();
}

// What the card costs: the cells; C0 and G at the seeded times and at the admission prices; each schedule's minutes as
// expected, its rewrites at their seeded times and each swap of the enhancer and the image model at 20 s, and the
// budget its gate asks at the seeded prices; the sums, against the slot. The rewrites' time is the probe's to measure:
// the first figure the card will correct.
export function estimate() {
  const reserved = estimateOf(undefined, 0, 60, framesOf(RESERVED, SCENES)), frame = priceOf(SEED_MS.words);
  const expectedOf = (arm: Optional) => (arm === 'A+' ? 0 : 2 * SWAP_MS + SCENES.length * REWRITE_MS[arm === 'PE' ? 'fast' : 'think']) + FRAMES * SEED_MS.words;
  const schedules = OPTIONAL.map(arm => ({ arm, rewrites: arm === 'A+' ? 0 : SCENES.length, frames: FRAMES, expectedMinutes: minutes(expectedOf(arm)),
    budgetMinutes: minutes(budgetOf(arm, frame, REWRITE_MS)) }));
  const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10;
  return { cells: { core: corePlan().length, pe: FRAMES, think: FRAMES, arms: Object.fromEntries(ARMS.map(arm => [arm, FRAMES])) }, scenes: SCENES.length, seeds: ARM_SEEDS,
    reserved: { arms: RESERVED, frames: reserved.frames, expectedMinutes: reserved.expectedMinutes, pricedMinutes: reserved.pricedMinutes }, schedules,
    rewrites: { fastSeconds: REWRITE_MS.fast / 1000, thinkSeconds: REWRITE_MS.think / 1000, timeoutSeconds: { fast: TIMEOUT_MS.fast / 1000, think: TIMEOUT_MS.think / 1000 },
      loadSeconds: LOAD_MS / 1000 },
    expectedMinutes: sum([reserved.expectedMinutes, ...schedules.map(one => one.expectedMinutes)]),
    budgetMinutes: sum([reserved.pricedMinutes, ...schedules.map(one => one.budgetMinutes)]), slotMinutes: SLOT_MINUTES,
    enhancerGiB: Math.round(Number(MANIFEST.IMAGE_QWEN_PE_T2I_BYTES) / 1024 ** 3 * 100) / 100 };
}

// ---- The pages ----

export function writePages(run: string) {
  const plans: Record<StandName, () => Planned[]> = { core: corePlan, fast: () => rewritePlan('PE', rewritten(readJson<Rewrites>(join(run, REWRITES_FILE.fast)))),
    think: () => rewritePlan('PT', rewritten(readJson<Rewrites>(join(run, REWRITES_FILE.think)))) };
  for (const name of STANDS) {
    const dir = join(run, name), file = join(dir, TEXTS_FILE);
    if (!existsSync(file)) continue;
    const plan = plans[name](), index = readJson<StandIndex>(join(dir, INDEX_FILE));
    writePage(dir, inputsOf(file, sha256(readFileSync(file)), plan), index, standOf(name, plan, index?.startedAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10)));
  }
}

// ---- The dry run ----

// The whole card without one, in `dir`: the real frozen texts and system prompt where the run holds them, synthetic
// ones otherwise, each prompt with a made-up word. Every rewrite's graph built and read back; then local/fake-comfy.ts
// started as the bot's card with the enhancer, the fake answering each rewrite: frozen texts, a system prompt and a
// card record other than the pinned, a server on cu128 and one without the enhancer refused before anything is sent;
// a card whose end is too near for the first frame begins nothing and weighs no schedule; one with two and a half
// minutes draws C0, G and A+ and omits both enhancer schedules for want of their budgets; the card: C0 and G; twelve
// rewrites without thinking, one failing on the card, one past its time and stopped, one a plain paragraph and one a
// fenced object, and PE's frames of the rest; A+'s frames; twelve rewrites with thinking, one never closing its thought
// and one answering no JSON, and PT's frames; a resume that sends nothing; every job as built and in order, every
// rewrite's record deleted once read, one job at a time; and the prompts' word only in the texts, the records of the
// rewrites and the pages, the thinking's word and the fake's nowhere.
export async function dryRun(dir: string, runDir?: string) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), run = join(dry, 'run');
  for (const path of [dry, temp, run, join(run, 'pe')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  const sent: Graph[] = [], fetched = globalThis.fetch;
  let strays = 0, origin = '', submits = 0;
  // The fake's answers by scene and pass: `steer` sets what the next rewrite does on the card before it is submitted.
  let steer: (graph: Graph, number: number) => void = () => undefined;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) { strays++; throw new Error('the dry run asks the fake alone'); }
    if (init?.method === 'POST' && url.endsWith('/prompt') && typeof init.body === 'string') {
      const graph = (JSON.parse(init.body) as { prompt: Graph }).prompt;
      sent.push(graph);
      steer(graph, ++submits);
    }
    return fetched(input, init);
  };
  try {
    say(`prompt arms dry run in ${dry}: the texts, the rewrites' graphs, then the whole card against local/fake-comfy.ts; no card, no model, no network`);
    const plan = estimate();
    say(`0 the plan: ${plan.cells.core} cells of C0, G and A+, ${plan.cells.pe} of PE and ${plan.cells.think} of PT; C0 and G first, ${plan.reserved.expectedMinutes} minutes expected `
      + `(${plan.reserved.pricedMinutes} at the admission prices), then ${plan.schedules.map(one => `${one.arm} ${one.expectedMinutes} (its budget ${one.budgetMinutes})`).join(', ')}: `
      + `${plan.expectedMinutes} minutes expected and ${plan.budgetMinutes} at the budgets, in a slot of ${plan.slotMinutes}`);
    expect(plan.cells.core === 72 && plan.cells.pe === 24 && plan.cells.think === 24 && plan.expectedMinutes <= plan.slotMinutes
      && new Set([...corePlan(), ...rewritePlan('PE', SCENES), ...rewritePlan('PT', SCENES)].map(one => one.key)).size === 120,
    '72 cells of C0, G and A+, 24 of PE and 24 of PT, every key once, and the minutes expected inside the slot');

    // The texts: the run's, pinned, or made up; a word in every prompt either way.
    const word = madeUpName(), thought = madeUpName(name => name !== word), marker = madeUpName(name => name !== word && name !== thought);
    const realFile = runDir ? join(resolve(runDir), FROZEN_FILE) : undefined;
    const real = realFile && existsSync(realFile) && sha256(readFileSync(realFile)) === FROZEN_SHA256 ? readFrozen(realFile) : undefined;
    const base: Frozen = real ?? { note: 'made up', model: 'none', instructions: INSTRUCTIONS, scenes: Object.fromEntries(SCENES.map(scene => [scene,
      { C0: `A made-up C0 prompt of the ${scene} scene. ${STYLE}`, G: `A made-up G prompt of the ${scene} scene. ${STYLE}`, 'A+': `A made-up A+ prompt of the ${scene} scene. ${STYLE}` }])) };
    const frozen: Frozen = { ...base, scenes: Object.fromEntries(SCENES.map(scene => [scene, { C0: `${base.scenes[scene].C0} ${word}`, G: `${base.scenes[scene].G} ${word}`,
      'A+': `${base.scenes[scene]['A+']} ${word}` }])) };
    const frozenBytes = JSON.stringify(frozen, null, 2), frozenSha = sha256(frozenBytes);
    writeFileSync(join(run, FROZEN_FILE), frozenBytes, { mode: 0o600 });
    const realSystem = runDir && existsSync(join(resolve(runDir), SYSTEM_FILE)) ? readFileSync(join(resolve(runDir), SYSTEM_FILE), 'utf8') : undefined;
    const system = realSystem !== undefined && sha256(realSystem) === PE.systemSha256 ? realSystem
      : 'Rewrite the user\'s picture prompt. Answer with one JSON line: {"rewritten_prompt": "<the description>", "wh_ratio": "<e.g. 3:2>"}.';
    writeFileSync(join(run, SYSTEM_FILE), system, { mode: 0o600 });
    say(`1 the texts: ${real ? 'the run\'s frozen texts, pinned' : 'made-up texts, the run has no frozen texts pinned yet'}, and ${system === realSystem ? 'the enhancer\'s system prompt, pinned'
      : 'a made-up system prompt'}; a made-up word in every prompt`);

    // Each rewrite's graph as built, read back: the chat around the scene's C0, each pass's opening of the answer, the
    // sampling, the file.
    const graphRight = (graph: Graph, scene: string, mode: Mode) => {
      const nodes = Object.values(graph), generate = nodes.find(node => node.class_type === 'TextGenerate')?.inputs, loader = nodes.find(node => node.class_type === 'CLIPLoader')?.inputs;
      const preview = nodes.find(node => node.class_type === 'PreviewAny')?.inputs;
      return nodes.length === 3 && !!generate && !!loader && !!preview && loader.clip_name === PE.file && same(generate.clip, ['1', 0]) && same(preview.source, ['2', 0])
        && generate.prompt === chatOf(system, frozen.scenes[scene].C0, mode) && String(generate.prompt).endsWith(mode === 'fast' ? '<think>\n\n</think>\n\n' : '<think>\n')
        && String(generate.prompt).startsWith(`<|im_start|>system\n${system.trim()}<|im_end|>\n<|im_start|>user\n`) && generate.max_length === MAX_LENGTH[mode]
        && generate['sampling_mode.temperature'] === 1 && generate['sampling_mode.top_k'] === 20 && generate['sampling_mode.top_p'] === 0.95
        && generate['sampling_mode.repetition_penalty'] === 1 && generate.sampling_mode === 'on' && typeof preview.nonce === 'string';
    };
    const built = SCENES.flatMap(scene => (['fast', 'think'] as Mode[]).map(mode => graphRight(peGraph(system, frozen.scenes[scene].C0, mode, randomUUID()), scene, mode)));
    say(`2 the rewrites' graphs: ${built.filter(Boolean).length} of ${built.length} read back right`);
    expect(built.every(Boolean), 'every rewrite\'s graph as the card is to get it');

    // The fake as the bot's card with the enhancer. Its answers: by the scene's C0 in the chat and the pass.
    const sceneIn = (graph: Graph) => {
      const chat = String(Object.values(graph).find(node => node.class_type === 'TextGenerate')?.inputs.prompt ?? '');
      return { scene: SCENES.find(scene => chat.includes(`<|im_start|>user\n${frozen.scenes[scene].C0}<|im_end|>`)), mode: (chat.endsWith('</think>\n\n') ? 'fast' : 'think') as Mode };
    };
    const answer = (chat: string) => {
      const scene = SCENES.find(one => chat.includes(`<|im_start|>user\n${frozen.scenes[one].C0}<|im_end|>`))!, mode = chat.endsWith('</think>\n\n') ? 'fast' : 'think';
      const json = JSON.stringify({ rewritten_prompt: `A rewritten ${scene} frame, the people where the scene has them. ${word}`, wh_ratio: '16:9' });
      if (mode === 'fast') {
        if (scene === 'lineout') return `${'A plain paragraph for the frame, the people where the scene has them, '.repeat(3)}${word}`;
        return scene === 'giants' ? `\`\`\`json\n${json}\n\`\`\`` : json;
      }
      if (scene === 'demon') return `Thinking about the frame ${thought}, and on`;
      return `Thinking about the frame ${thought}.\n</think>\n\n${scene === 'gym' ? 'No line of JSON here {' : json}`;
    };
    const started = await startFakeComfy({ jobMs: 20, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: kitchenLines(true, 'cu130'),
      pytorch: '2.11.0+cu130', textMs: 5, generate: prompt => answer(prompt), objectInfo: { ...attentionInfo(true),
        CLIPLoader: { input: { required: { clip_name: [[MANIFEST.IMAGE_QWEN_ENCODER_FILE, PE.file]], type: [['stable_diffusion', 'qwen_image']] } } },
        TextGenerate: { input: { required: { sampling_mode: ['COMFY_DYNAMICCOMBO_V3', {}] }, optional: { use_default_template: ['BOOLEAN', {}] } } },
        PreviewAny: { input: { required: { source: ['*', {}] } } } } });
    fake = started;
    origin = started.url;
    // Without thinking, beach's rewrite fails on the card and cheer's outlasts its time; the rest answer at once.
    steer = (graph, number) => {
      const { scene, mode } = sceneIn(graph);
      started.options.failJobs = scene === 'beach' && mode === 'fast' ? [number] : [];
      started.options.textMs = scene === 'cheer' && mode === 'fast' ? 5000 : 5;
    };
    writeCardRecord(join(run, 'card.txt'));
    const events: object[] = [];
    const card = (extra: Partial<CardOptions> = {}) => runCard({ run, comfy: origin, until: Date.now() + 3600000, frozenSha256: frozenSha, systemSha256: sha256(system),
      pollMs: 10, waitMs: 60000, timeoutMs: 10000, rewriteTimeoutMs: { fast: 500, think: 500 }, loadMs: 0, log: event => events.push(event), ...extra });
    const clear = () => {
      for (const name of STANDS) rmSync(join(run, name), { recursive: true, force: true });
      rmSync(join(run, SCHEDULES_FILE), { force: true });
    };

    say('3 refusals before anything is sent or written:');
    const refused = async (what: string, work: () => unknown) => {
      try { await work(); expect(false, `${what} refused`); } catch (error) {
        expect(error instanceof Refusal, `${what} refused as a refusal`);
        say(`   ${what}: refused (${JSON.stringify(safeError(error))})`);
      }
    };
    await refused('a card record without the enhancer\'s line', () => card());
    writeFileSync(join(run, 'card.txt'), `${readFileSync(join(run, 'card.txt'), 'utf8')}${PE.sha256}  ${PE.file}\n`, { mode: 0o600 });
    await refused('frozen texts other than the pinned', () => card({ frozenSha256: sha256('other texts') }));
    await refused('a system prompt other than the pinned', () => card({ systemSha256: sha256('another system prompt') }));
    started.options.pytorch = '2.11.0+cu128';
    await refused('a server on cu128', () => card());
    started.options.pytorch = '2.11.0+cu130';
    const offered = started.options.objectInfo!;
    started.options.objectInfo = { ...offered, CLIPLoader: { input: { required: { clip_name: [[MANIFEST.IMAGE_QWEN_ENCODER_FILE]] } } } };
    await refused('a server without the enhancer', () => card());
    started.options.objectInfo = offered;
    expect(!submits && !existsSync(join(run, REWRITES_FILE.fast)) && !existsSync(join(run, 'core', INDEX_FILE)) && !existsSync(join(run, SCHEDULES_FILE)),
      'the refusals send and write nothing');

    const short = await card({ until: Date.now() + 5000, loadMs: 60000 });
    say(`4 five seconds left: ${submits} jobs sent, ${countsOf(short.core).drawn} frames drawn, the schedules ${existsSync(join(run, SCHEDULES_FILE)) ? 'weighed' : 'not weighed'}`);
    expect(!submits && countsOf(short.core).drawn === 0 && short.core.stopped === 'until' && !existsSync(join(run, SCHEDULES_FILE)),
      'a card whose end is near begins no frame and weighs no schedule');
    clear();

    // Two and a half minutes: every frame of C0 and G, then A+, whose 24 frames the time left covers, and neither
    // enhancer's schedule, whose twelve rewrites it does not.
    const tightFrom = submits, tight = await card({ until: Date.now() + 150000 });
    const states = (record: Schedules | undefined) => Object.fromEntries(Object.entries(record ?? {}).map(([arm, one]) => [arm, one.state]));
    const tightStates = states(readJson<Schedules>(join(run, SCHEDULES_FILE)));
    say(`5 two and a half minutes: ${countsOf(tight.core).drawn} frames of C0, G and A+ in ${submits - tightFrom} jobs; the schedules ${JSON.stringify(tightStates)}`);
    expect(countsOf(tight.core).drawn === 72 && submits - tightFrom === 72 && same(tightStates, { PE: 'omitted', 'A+': 'begun', PT: 'omitted' })
      && !existsSync(join(run, REWRITES_FILE.fast)) && !tight.pe && !tight.pt, 'C0, G and A+ drawn, both enhancer schedules omitted for want of their budgets');
    clear();

    const firstSent = sent.length, firstJob = started.jobs.length;
    const done = await card();
    const fast = readJson<Rewrites>(join(run, REWRITES_FILE.fast))!, think = readJson<Rewrites>(join(run, REWRITES_FILE.think))!;
    const schedules = states(readJson<Schedules>(join(run, SCHEDULES_FILE)));
    const codes = (record: Rewrites) => Object.fromEntries(SCENES.flatMap(scene => (record.scenes[scene]?.code ? [[scene, record.scenes[scene].code]] : [])));
    const drawnOf = (index: StandIndex | undefined) => (index ? countsOf(index).drawn : 0);
    say(`6 the card: C0, G and A+ ${drawnOf(done.core)} drawn; without thinking ${rewritten(fast).length} of 12 rewritten, ${JSON.stringify(codes(fast))}, forms `
      + `${JSON.stringify(SCENES.map(scene => fast.scenes[scene]?.form ?? '-'))}, PE ${drawnOf(done.pe)} drawn; with thinking ${rewritten(think).length} rewritten, `
      + `${JSON.stringify(codes(think))}, PT ${drawnOf(done.pt)} drawn; the schedules ${JSON.stringify(schedules)}`);
    expect(same(codes(fast), { beach: 'pe_failed', cheer: 'pe_timeout', lineout: 'pe_unparsed' }) && fast.scenes.cheer.stopped === true && fast.scenes.giants.form === 'fenced'
      && fast.scenes.bandage.form === 'json' && fast.scenes.bandage.whRatio === '16:9' && rewritten(fast).length === 9 && drawnOf(done.core) === 72 && drawnOf(done.pe) === 18
      && same(codes(think), { demon: 'pe_truncated', gym: 'pe_unparsed' }) && rewritten(think).length === 10 && drawnOf(done.pt) === 20 && think.scenes.bandage.thinkingChars! > 0
      && same(schedules, { PE: 'begun', 'A+': 'begun', PT: 'begun' }),
    'nine rewrites without thinking and ten with, the failed, the stopped, the unclosed thought and the unread answers out; 72 frames of C0, G and A+, 18 of PE and 20 of PT');

    // Each job against what was meant: C0 and G, PE's rewrites and frames, A+, PT's rewrites and frames; each rewrite's
    // graph as built and its record deleted, each frame the cell's graph from its stand's texts.
    const coreCells = corePlan(), peCells = rewritePlan('PE', rewritten(fast)), ptCells = rewritePlan('PT', rewritten(think));
    const cellsOf: Record<StandName, Planned[]> = { core: coreCells, fast: peCells, think: ptCells };
    const setups = Object.fromEntries(STANDS.map(name => [name, setupOf(join(run, name), sha256(readFileSync(join(run, name, TEXTS_FILE))), cellsOf[name])])) as Record<StandName, ReturnType<typeof setupOf>>;
    type Meant = { rewrite: Mode; scene: string } | { stand: StandName; key: string };
    const order: Meant[] = [...coreCells.filter(one => RESERVED.includes(one.arm as Arm)).map(one => ({ stand: 'core' as const, key: one.key })),
      ...SCENES.map(scene => ({ rewrite: 'fast' as const, scene })), ...peCells.map(one => ({ stand: 'fast' as const, key: one.key })),
      ...coreCells.filter(one => one.arm === 'A+').map(one => ({ stand: 'core' as const, key: one.key })),
      ...SCENES.map(scene => ({ rewrite: 'think' as const, scene })), ...ptCells.map(one => ({ stand: 'think' as const, key: one.key }))];
    const jobs = sent.slice(firstSent), wrong: string[] = [];
    order.forEach((meant, n) => {
      const graph = jobs[n];
      if ('rewrite' in meant) {
        if (!graph || !graphRight(graph, meant.scene, meant.rewrite)) wrong.push(`${meant.rewrite}:${meant.scene}`);
        return;
      }
      const setup = setups[meant.stand], one = cellsOf[meant.stand].find(cell => cell.key === meant.key)!, text = setup.texts.cells.get(meant.key)!;
      if (!graph || !same(buildJob(setup, one, text, []), graph) || !cellRight(graph, one, text, [], setup)) wrong.push(meant.key);
    });
    const deletes = new Set(started.calls.filter(one => one.method === 'POST' && one.path === '/history').map(one => one.id));
    const rewriteIds = started.calls.filter(one => one.method === 'POST' && one.path === '/prompt' && one.id !== undefined)
      .map(one => one.id!).filter((id, n) => { const graph = sent[n]; return !!graph && Object.values(graph).some(node => node.class_type === 'TextGenerate'); });
    const texts = (name: StandName, index: StandIndex | undefined) => !!index && cellsOf[name].every(one => {
      const cell = index.cells[one.key], prompt = readJson<{ cells: { key: string; prompt: string }[] }>(join(run, name, TEXTS_FILE))!.cells.find(row => row.key === one.key)?.prompt ?? '';
      const scene = sceneOfCell(one), arm = one.arm as Arm;
      return cell?.status === 'drawn' && prompt === (arm === 'PE' ? fast.scenes[scene].prompt : arm === 'PT' ? think.scenes[scene].prompt : frozen.scenes[scene][arm as 'C0']);
    });
    const ownTexts = texts('core', done.core) && texts('fast', done.pe) && texts('think', done.pt);
    say(`7 the jobs: ${jobs.length - wrong.length} of ${jobs.length} as meant, in order${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}; each rewrite's record deleted `
      + `${rewriteIds.every(id => deletes.has(id))}; each cell drawn from its own text ${ownTexts}`);
    expect(!wrong.length && jobs.length === 48 + 12 + 18 + 24 + 12 + 20 && rewriteIds.length === 24 && rewriteIds.every(id => deletes.has(id)) && ownTexts,
      'C0 and G first, then each schedule in order, each job as built, every record of a rewrite deleted');
    expect(started.jobs.slice(firstJob).filter(job => job.generated).length === 22 && started.jobs.slice(firstJob).filter(job => job.outcome === 'interrupted').length === 1,
      'twenty-two rewrites answered on the card, the failed one not, and the one past its time stopped there');

    const before = submits;
    const again = await card();
    say(`8 a resume: ${submits - before} jobs sent; C0, G and A+ ${drawnOf(again.core)}, PE ${drawnOf(again.pe)} and PT ${drawnOf(again.pt)} drawn`);
    expect(submits === before && drawnOf(again.core) === 72 && drawnOf(again.pe) === 18 && drawnOf(again.pt) === 20, 'a resume sends nothing');

    writePages(run);
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length;
    const pages = Object.fromEntries(STANDS.map(name => [name, readFileSync(join(run, name, 'index.html'), 'utf8')])) as Record<StandName, string>;
    const prose = (page: string) => page.replace(/<pre>[\s\S]*?<\/pre>/g, '');
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = [run, join(run, 'pe'), ...STANDS.map(name => join(run, name)), join(run, 'core', 'frames')].every(path => mode(path) === 0o700)
      && [REWRITES_FILE.fast, REWRITES_FILE.think, SCHEDULES_FILE, ...STANDS.flatMap(name => [join(name, TEXTS_FILE), join(name, INDEX_FILE), join(name, 'index.html')])]
        .every(file => mode(join(run, file)) === 0o600) && coreCells.every(one => mode(join(run, 'core', one.file)) === 0o600);
    const dashes = STANDS.some(name => /[–—]/.test(prose(pages[name])));
    say(`9 pages: ${STANDS.map(name => `${name} ${figures(pages[name])}`).join(', ')} figures; dashes in their own words ${dashes}; directories 700 and files 600: ${modes}`);
    expect(figures(pages.core) === 72 && figures(pages.fast) === 18 && figures(pages.think) === 20 && !dashes && pages.core.includes('Нарисовано 72 из 72') && modes,
      'the pages show every cell, in words without dashes');

    say(`10 the fake held at most ${started.mostHeld} job at once; ${strays} calls to anything but the fake`);
    expect(started.mostHeld === 1 && strays === 0, 'one job at a time, the fake alone');

    // The prompts' word is in the texts, the rewrites' records and the pages alone; the thinking's and the fake's nowhere.
    const text = output.text(), allowed = new Set([FROZEN_FILE, TEXTS_FILE, 'index.html', basename(REWRITES_FILE.fast), basename(REWRITES_FILE.think)]);
    const beyond = searchTree(dry, markerForms(word), path => allowed.has(basename(path)));
    const anywhere = searchTree(dry, [...markerForms(thought), ...markerForms(marker)]);
    const printed = [...markerForms(word), ...markerForms(thought), ...markerForms(marker)].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`11 privacy: the prompts' word in ${beyond.hits.length} of ${beyond.files} files beside the texts, the rewrites and the pages; the thinking's and the fake's in `
      + `${anywhere.hits.length} of ${anywhere.files}; unread ${beyond.unread.length + anywhere.unread.length}; printed ${printed}`);
    expect(!beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length && !printed,
      'no prompt beyond the texts, the rewrites and the pages, no thinking kept, nothing printed');
    say(missed.length ? `the prompt arms dry run did NOT go as expected: ${missed.length} of its checks` : 'the prompt arms dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    run: { type: 'string' }, round2: { type: 'string', default: join(ROOT, 'illustrations', 'action') }, scenes: { type: 'string' }, arms: { type: 'string' },
    tokenizers: { type: 'string' }, from: { type: 'string' }, dir: { type: 'string' }, until: { type: 'string' },
    comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'estimate') { print({ event: 'estimate', ...estimate() }); return; }
  if (command === 'dry-run') {
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-prompt-arms-dry-')), values.run);
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (!values.run) throw new Refusal('Use: image-prompt-arms.ts prompts|checks|freeze|pe-prompt|estimate|dry-run|card|page; all but estimate and dry-run take --run <the run\'s directory>');
  const run = resolve(values.run), round2 = resolve(values.round2!);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  if (command === 'prompts') {
    const scenes = values.scenes ? values.scenes.split(',').map(one => one.trim()) : SCENES;
    const arms = (values.arms ? values.arms.split(',').map(one => one.trim()) : ['C0', 'G']) as ('C0' | 'G')[];
    if (!scenes.every(scene => SCENES.includes(scene)) || !arms.every(arm => arm === 'C0' || arm === 'G')) throw new Refusal(`--scenes takes the probe's scenes (${SCENES.join(', ')}), --arms C0 and G`);
    const configRoot = mkdtempSync(join(tmpdir(), 'simple-chat-prompt-arms-config-'));
    try {
      const keys = parseEnv(readFileSync(join(ROOT, '.env.eval'), 'utf8'));
      const model = hostedModel({ env: modelEnv(MODEL, keys), configRoot, ledger: BUDGET_PATH });
      const record = await askPrompts({ run, round2, scenes, arms, provider: model.provider, model: MODEL, log: print });
      print({ event: 'prompts', requests: record.rows.length, cap: REQUEST_CAP, ok: SCENES.flatMap(scene => (['C0', 'G'] as const).filter(arm => record.scenes[scene]?.[arm]?.outcome === 'ok')).length,
        tokens: { input: record.rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0), output: record.rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0) } });
    } finally { rmSync(configRoot, { recursive: true, force: true }); }
  } else if (command === 'checks') {
    const checked = checkAll(run, round2, values.tokenizers ? resolve(values.tokenizers) : undefined);
    writeJson(join(run, CHECKS_FILE), checked);
    for (const [arm, totals] of Object.entries(checked.totals)) print({ event: 'checks', arm, ...totals });
    print({ event: 'contact_words_against_astra', ...checked.agreement });
  } else if (command === 'freeze') {
    print({ event: 'frozen', ...freeze(run, round2) });
  } else if (command === 'pe-prompt') {
    const bytes = values.from ? readFileSync(resolve(values.from)) : Buffer.from(await (await fetch(PE.systemUrl, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
    if (sha256(bytes) !== PE.systemSha256) throw new Refusal('The system prompt is not the one pinned at the enhancer\'s revision; nothing is written');
    mkdirSync(join(run, 'pe'), { recursive: true, mode: 0o700 });
    writeFileSync(join(run, SYSTEM_FILE), bytes, { mode: 0o600 });
    print({ event: 'pe_prompt', file: join(run, SYSTEM_FILE), bytes: bytes.length });
  } else if (command === 'page') {
    writePages(run);
    print({ event: 'page', files: STANDS.map(name => join(run, name, 'index.html')).filter(existsSync) });
  } else if (command === 'card') {
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10 || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: card --run <dir> --until <epoch seconds> [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const result = await runCard({ run, comfy: comfyUrl(values.comfy!), until, waitMs: wait * 1000, timeoutMs: timeout * 1000, log: print });
    if ([result.core, result.pe, result.pt].some(index => index?.error || index?.stopped)) process.exitCode = 1;
  } else throw new Refusal('Use: image-prompt-arms.ts prompts|checks|freeze|pe-prompt|estimate|dry-run|card|page (docs/action-experiment.md#prompt-arms)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
