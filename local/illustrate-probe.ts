// The description step of docs/illustrations-plan.md, brought in from the scratch script it was iterated in. For
// chosen scenes of the frozen synthetic stories it asks the story model for one character sheet per story and then a
// structured description of one frame, and assembles the text-to-image prompt here, in code (step 3 of the plan: the
// model writing the prompt itself dropped fields it had filled). Nothing is drawn here; local/image-batch.ts draws.
// Synthetic stories only: examples/ is safe to send to a hosted model, a reader's story is not.
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadModelConfig } from './config.ts';
import type { Env } from './config.ts';
import { createModel } from './model.ts';
import type { Provider, ModelRequest } from './model.ts';
import { channelFor } from './budget.ts';
import { safeErrorDetails } from './model-error.ts';
import { contextParts, storyNarration } from './prompt.ts';
import { active, history } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';

// One recurring person of a story: the name as the story writes it, and the fixed appearance line the assembly puts
// in wherever a described person is that name. The sheet is written once per story and reused for all its frames.
export type Character = { name: string; look: string };
// `who` is the only field allowed to carry a name, and it never reaches the image model: it selects the sheet line.
export type Person = { who: string; look: string; state: string; action: string };
export type Description = {
  moment: string; shot: string; setting: string; objects: string; props: string; light: string; people: Person[];
};
// What one frame is: written to the output directory and read by local/image-batch.ts. `withoutLook` counts the
// people who reached the prompt with no appearance at all, which is the way this assembly fails quietly.
export type Case = {
  id: string; scenario: string; index: number; scene: string; sheet: Character[]; description: Description;
  prompt: string; namesStripped: number; fromSheet: number; withoutLook: number;
};

// The style belongs to us, not to the describing model: step 1 measured it picking a different style every time.
export const STYLE = 'Hand-painted visual novel illustration with soft opaque brushwork, muted natural colors and restrained shading. Naturalistic adult facial proportions, moderately sized eyes, simplified noses and mouths, and age-appropriate facial lines throughout. Clear silhouettes. No captions, logos or watermarks.';

// An age as a number reached the prompt in step 1 ("48-year-old") against the rule that only the visible goes in, and
// an image model reads a number worse than a word. Every field is cleaned, not only the sheet as in the scratch script.
export function stripAges(text: string): string {
  return text
    .replace(/,?\s*\b[\w-]+[- ]years?[- ]old\b/gi, '')
    .replace(/,?\s*\baged\s+\d{1,3}\b/gi, '')
    .replace(/,?\s*\b\d{1,3}\s*(?:years?|y\.?o\.?)\b/gi, '');
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The Latin spellings of one Cyrillic letter. The sheet holds a name as the story writes it — in Cyrillic — while
// every described field is English, and there the model writes the same name transliterated by a system it picks
// itself: Лидия comes back as Lidia, Lidiya or Lidija. One alternation per letter covers all of them at once, which
// is why this is a table of variants and not a transliteration.
const LATIN: { [letter: string]: string } = {
  а: 'a', б: 'b', в: 'v|w', г: 'g', д: 'd', е: 'e|ye|je', ё: 'e|yo|jo|io', ж: 'zh|j', з: 'z', и: 'i|y|ee',
  й: 'y|i|j|', к: 'k|c', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u|oo|ou',
  ф: 'f|ph', х: 'kh|h|ch', ц: 'ts|tz|c', ч: 'ch|tch', ш: 'sh|ch', щ: 'shch|sch|sh', ъ: "'|", ы: 'y|i',
  ь: "'|", э: 'e', ю: 'yu|iu|ju|u', я: 'ya|ia|ja|a',
};
// One pattern for every Latin spelling of a Russian name; null when the name is not Cyrillic, and then the name as
// the sheet writes it is already what the describing model would write. The first letter is capitalised and the
// pattern is used without the `i` flag: in English a name is capitalised and an ordinary word is not, and a name
// transliterates into an ordinary word often enough to matter (Роан -> roan, Мать -> mat, Ян -> an).
export function latinPattern(name: string): string | null {
  const letters = [...name.trim().toLowerCase()];
  if (!letters.some(letter => /\p{Script=Cyrillic}/u.test(letter))) return null;
  const capital = (spelling: string) => (spelling ? spelling[0].toUpperCase() + spelling.slice(1) : spelling);
  return letters.map((letter, at) => {
    const start = at === 0;
    if (!(letter in LATIN)) return escape(start ? letter.toUpperCase() : letter);
    return `(?:${LATIN[letter].split('|').map(spelling => (start ? capital(spelling) : spelling)).join('|')})`;
  }).join('');
}

// Names must not reach the image model: it cannot use them, and in step 6 they arrived through `moment` and put the
// story's own words on the picture. The instruction forbids them in every field; this is the net under it, and it
// catches the names the sheet knows in both alphabets. The Cyrillic spelling is matched in any case, with up to
// three letters of a case ending; the transliterated one stands in English text, so it is matched as English writes
// a name — capitalised, with at most a plural or a possessive after it. Three free letters there would swallow
// ordinary words (Элин would eat "eliminate"), and matching in any case would swallow "roan" and "mat".
export function stripNames(text: string, names: string[]): { text: string; removed: number } {
  let removed = 0;
  let value = text;
  const cut = (pattern: RegExp) => { value = value.replace(pattern, () => { removed++; return 'the figure'; }); };
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    cut(new RegExp(`(?<!\\p{L})${escape(trimmed)}\\p{L}{0,3}(?!\\p{L})`, 'giu'));
    const latin = latinPattern(trimmed);
    if (latin) cut(new RegExp(`(?<!\\p{L})${latin}(?:'s|s)?(?!\\p{L})`, 'gu'));
  }
  return { text: value, removed };
}

const shared = (one: string, other: string) => {
  let at = 0;
  while (at < one.length && at < other.length && one[at] === other[at]) at++;
  return at;
};

// Which sheet line a described person is, or null. `who` is model output too: it comes back inflected (Элину for
// Элин), transliterated (Elin) or with a trailing comma, and an exact compare then leaves that person with no
// appearance at all, because the instruction tells the model to leave `look` empty for everybody the sheet covers.
export function matchSheet(who: string, names: string[]): string | null {
  const value = who.trim().toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '');
  if (value.length < 2) return null;
  let best: { name: string; stem: number } | null = null;
  for (const name of names) {
    const trimmed = name.trim().toLowerCase();
    if (trimmed.length < 2) continue;
    if (value === trimmed) return name;
    const latin = latinPattern(trimmed);
    if (latin && new RegExp(`^${latin}(?:'s|s)?$`, 'iu').test(value)) return name;
    // A Russian name arrives inflected: the whole sheet name stands at the front of it and at most two letters of a
    // case ending follow (Элину -> Элин). The sheet name must be all of the stem, or Марина would be read as Мария
    // and Элину as Элина — and a person given somebody else's fixed appearance is counted as a correct frame while
    // their own look is thrown away. A role of several words ("salt worker") is never stem-matched: it is not a name.
    const stem = shared(value, trimmed);
    if (stem === trimmed.length && stem >= 3 && value.length - stem <= 2 && !/\s/.test(value)
      && (!best || stem > best.stem)) best = { name, stem };
  }
  return best ? best.name : null;
}

const sentence = (text: string) => {
  const value = text.trim().replace(/\.$/, '');
  return value ? value + '. ' : '';
};

// The sheet's appearance lines, by name in lower case. A line is the story's constant for that person, so an age
// written as a number is taken out of it once, here.
export function sheetLooks(sheet: Character[]): Map<string, string> {
  return new Map(sheet.map(character => [character.name.trim().toLowerCase(), stripAges(character.look.trim().replace(/\.$/, ''))]));
}

// The order is the one the third reader asked for: shot, setting, the shared action once, each person, objects,
// props, light, style. A person the sheet covers takes their look from the sheet alone — the model's own `look` for
// them contradicts it, and in step 6 the contradiction was visible in the picture.
export function assemblePrompt(description: Description, sheet: Character[]): { prompt: string; namesStripped: number; fromSheet: number; withoutLook: number } {
  const looks = sheetLooks(sheet);
  const names = sheet.map(character => character.name);
  let namesStripped = 0;
  let fromSheet = 0;
  let withoutLook = 0;
  const clean = (text: string) => {
    const stripped = stripNames(stripAges(text ?? ''), names);
    namesStripped += stripped.removed;
    return stripped.text;
  };
  const people = (description.people ?? []).map(person => {
    const matched = matchSheet(person.who ?? '', names);
    const known = matched === null ? undefined : looks.get(matched.trim().toLowerCase());
    if (known) fromSheet++;
    // The sheet is model output too: a name in an appearance line would reach every frame of that story.
    const look = clean(known ?? person.look ?? '');
    // A person the sheet does not cover and whose `look` the model left empty anyway reaches the picture with no
    // body, hair or clothes. Nothing can be done about it here, but it is counted rather than lost.
    if (!look.trim()) withoutLook++;
    const before = [look, clean(person.state)].map(part => part.trim()).filter(Boolean).join(', ');
    const action = clean(person.action).trim();
    // No appearance and no state leaves nothing to put before the colon, and a prompt that opens a clause with one.
    return sentence(before ? `${before}: ${action}` : action);
  }).join('');
  const prompt = sentence(clean(description.shot)) + sentence(clean(description.setting)) + sentence(clean(description.moment))
    + people + sentence(clean(description.objects)) + sentence(clean(description.props)) + sentence(clean(description.light)) + STYLE;
  return { prompt, namesStripped, fromSheet, withoutLook };
}

// The two instruction texts are kept as they were iterated against the readers' reports (docs/illustrations-plan.md,
// steps 1-6). The only change is the name ban, which step 6 found stated in one bullet about `people` while `moment`
// carried names to the image model.
const SHEET = `Не продолжай историю. Составь лист внешности для художника: по одной записи на КАЖДОГО человека, названного в истории по имени или по постоянной роли (командир, лекарь, судья) и появляющегося больше чем в одной сцене. Обычно их от трёх до шести; одна запись на целую историю — почти наверняка ошибка.
- name: имя так, как оно пишется в истории.
- look: по-английски, 15-25 слов, без имени: пол, возраст ТОЛЬКО словом (young, middle-aged, elderly) и никогда числом, даже если история называет годы, телосложение, волосы, лицо, постоянная одежда и её цвета. Всё, что история называет, бери из истории; чего она не называет — придумай один раз, правдоподобно для мира истории, и так, чтобы персонажи заметно отличались друг от друга силуэтом, волосами и цветом одежды.
- Не включай травмы, повязки, оружие в руках и предметы, которые появляются или меняются по ходу истории: только постоянное.`;
const SHEET_SCHEMA = { type: 'object', additionalProperties: false, required: ['characters'], properties: { characters: { type: 'array', maxItems: 6,
  items: { type: 'object', additionalProperties: false, required: ['name', 'look'], properties: { name: { type: 'string' }, look: { type: 'string' } } } } } };

const instruction = (names: string[]) => `Не продолжай историю. Опиши ПОСЛЕДНЮЮ сцену для художника-иллюстратора: один неподвижный кадр, как в визуальной новелле. Пиши по-английски. Готовый запрос для модели картинок соберёт программа из твоих полей, поэтому всё существенное должно быть в полях; чего в них нет, того не будет на картинке.
Правила:
- Имён не должно быть НИ В ОДНОМ поле, кроме who: ни в moment, ни в shot, ни в setting, ни в objects, ни в props, ни в light, ни в look, state и action. Программа всё равно вырежет их из запроса, и текст станет от этого хуже.
- Модель картинок хорошо рисует, КТО в кадре, ГДЕ они, как стоят и что держат. Она НЕ умеет рисовать точные контакты (лезвие в щели, пальцы на кнопке, отмычку в скважине), читаемый текст и содержимое экранов. Скрывай такие детали ракурсом: экран повёрнут тыльной стороной к зрителю, кончик инструмента закрыт руками.
- Выбери ОДИН конкретный момент сцены, до или после сложного контакта, и сохрани состояние людей и предметов именно в этот момент: у кого оружие, обнажено оно или в ножнах, какая рука повреждена, открыта или закрыта дверь, кто продолжает важное действие. Не смешивай состояния из разных моментов сцены. Если предмет по ходу сцены перешёл из рук в руки, реши, до или после передачи твой кадр.
- Момент должен узнаваться как именно этот эпизод: через место, крупные позы и состояние предметов. Просто присутствия людей в нужном месте мало. Кто продолжает работу (у замка, у стола, у раненого), тот описан у этой работы, с руками на её высоте, а не стоящим рядом.
- moment: одно-два предложения о том, что происходит в кадре в целом; общее действие называй здесь один раз. Без имён: the commander, the shield-bearer, the two dancers.
- Не больше четырёх человек. Если в моменте их больше, выбери тесный ракурс, который естественно оставляет остальных за краем кадра; не показывай часть группы как всю группу. Позы описывай на уровне тела: stands, crouches, leans her back against, raises, turns toward, looks at. Предмет в руке — "holds X in her right hand", не точнее.
- props: одно предложение по-английски: у каждого важного предмета один владелец и одно состояние, и у кого руки пусты ("The gray-clad woman holds the only dagger in her right hand; the blond man carries the one steel shield, his other hand is empty."). Людей называй по заметной примете, без имён. Пустая строка, если важных предметов нет.
- Перед ответом проверь: кадр не меняет сторону травмы, владельца оружия, состояние двери, число щитов, мечей и других единственных предметов и то, кто что делает. Не добавляй действий, которых в сцене нет, ради более напряжённой позы.
- Точно сохраняй, КТО делает действие, какой рукой, какая сторона тела повреждена, у кого предмет и где точки контакта людей и предметов. left и right — стороны самого персонажа ("her own left forearm"); место в кадре называй отдельно: screen-left, screen-right.
- Прямые запреты и физические ограничения сцены обязательны: переведи их в видимую позу ("her bandaged left forearm stays folded against her chest, bearing no weight").
- Не передавай действие другому человеку: если в сцене запись отматывает председатель, то и в кадре это делает председатель; если в сцене никто ни на что не указывает, никто и не указывает. Не выдумывай подробностей позы, которых сцена не называет.
- Сохраняй, где кто находится, если сцена это говорит: на пороге, внутри комнаты, в середине, справа от другого, спиной к двери.
- Не добавляй свечение, магию, оружие, травмы и действия, которых нет в выбранном моменте. Наличие волшебного предмета не значит, что он светится.
- people: каждый человек, который должен быть виден, отдельной записью, со своим действием. who — имя из списка [${names.join(', ')}], если это он; иначе короткая роль по-английски ("salt worker"). look: для людей из списка — ПУСТАЯ строка, их постоянную внешность подставит программа из листа внешности, и твой текст для них не будет использован; для остальных — пол, возраст словом, телосложение, волосы, одежда. state — то, что сейчас на нём или с ним и видно глазу: повязки, шины, что держит, что в ножнах; пустая строка, если нечего. action — что он делает в этом кадре и чего касается. Имён не должно быть НИ В ОДНОМ поле, кроме who: пиши he, she, the shield-bearer.
- shot: план и ракурс, при котором видны ключевое действие и все перечисленные люди. В тесной сцене с несколькими людьми бери средне-общий план в три четверти, а не эффектный нижний ракурс.
- setting: место, по-английски, без названий, которые ничего не говорят глазу. objects: важные предметы и их состояние; пустая строка, если нечего.
- light: свет и время суток словами (morning, evening), без часов и минут. Не называй дверь, проём или арку источником света: закрытая дверь должна остаться закрытой. Если дверь или окно в сцене закрыты, так и напиши в setting.
- Только то, что можно увидеть: без мыслей, реплик, предыстории. Без слов стиля, техники, качества (photorealistic, anime, 8k, cinematic). Возраст словами, не числом.`;

const str = { type: 'string' };
const FRAME_SCHEMA = { type: 'object', additionalProperties: false, required: ['moment', 'shot', 'setting', 'objects', 'props', 'light', 'people'], properties: {
  props: str, moment: str, shot: str, setting: str, objects: str, light: str,
  people: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['who', 'look', 'state', 'action'],
    properties: { who: str, look: str, state: str, action: str } } } } };

const SCENARIOS = ['battle', 'chess', 'dance'];
// The frames to describe, in the order they were named and without repeats: `--scenes battle-2,battle-2` paid a
// hosted call for that frame twice and wrote prompts.json with one id in it twice, which local/image-batch.ts then
// refuses as a whole run, because two cells would write one file. The default is every other scene of every frozen
// story: 24 frames, the corpus the rental's image batch draws.
export function scenesWanted(spec: string | undefined): { id: string; scenario: string; index: number }[] {
  const named = (spec ?? SCENARIOS.flatMap(name => [1, 3, 5, 7, 9, 11, 13, 15].map(index => `${name}-${index}`)).join(','))
    .split(',').map(id => id.trim()).filter(Boolean);
  return [...new Set(named)].map(id => ({ id, scenario: id.slice(0, id.lastIndexOf('-')), index: Number(id.slice(id.lastIndexOf('-') + 1)) }));
}
// The hosted APIs are named as in local/eval.ts, and the keys come from the same .env.eval.
const HOSTS: { [host: string]: { baseUrl: string; key: string } } = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY' },
};
// Frozen evidence as local/story-probe.ts wrote it; only the story state is read.
type Evidence = { state: Library };
type Failure = { code?: string };

const report = (value: object) => console.log(JSON.stringify(value)); // counts and keys only, never a field of a description

// "openrouter:google/gemma-4-31b-it", or SIMPLE_CHAT_* in the environment when --model is not given.
function modelEnv(spec: string | undefined, keys: Env): Env {
  if (!spec) return Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('SIMPLE_CHAT_')));
  const [host, model] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  if (!Object.hasOwn(HOSTS, host) || !model) throw new Error('Name a model as <host>:<id>, with host openrouter, openai, cerebras, groq or mistral');
  const { baseUrl, key } = HOSTS[host];
  const apiKey = process.env[key] || keys[key];
  if (!apiKey) throw new Error(`Set ${key} in .env.eval`);
  // OPENROUTER_PAID_DAILY_TOKENS and the like replace the channel's default cap, as they do for the eval.
  const cap = channelFor(baseUrl, model).toUpperCase().replace('-', '_');
  return { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: baseUrl, SIMPLE_CHAT_API_KEY: apiKey, SIMPLE_CHAT_MODEL: model,
    SIMPLE_CHAT_BUDGET_REQUESTS: keys[`${cap}_DAILY_REQUESTS`], SIMPLE_CHAT_BUDGET_TOKENS: keys[`${cap}_DAILY_TOKENS`] };
}

// Both calls are shaped as a continuation of the scene's own request: the same system prompt and history, with one
// instruction appended last, so a server with a prefix cache pays for the instruction alone.
async function ask(provider: Provider, request: ModelRequest): Promise<{ value: Record<string, unknown>; retried: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await provider.generate(request);
    // JSON mode runs away into newlines until the output limit; step 1 measured it, and the same scene parsed next try.
    try { return { value: JSON.parse(result.text), retried: attempt > 0 }; } catch { /* reported as unparsed below */ }
  }
  throw Object.assign(new Error('unparsed_description'), { code: 'unparsed_description' });
}

async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    out: { type: 'string' }, model: { type: 'string' }, scenes: { type: 'string' },
  } });
  const wanted = scenesWanted(values.scenes);
  if (!wanted.length || wanted.some(scene => !SCENARIOS.includes(scene.scenario) || !Number.isInteger(scene.index) || scene.index < 0 || scene.index > 63)) {
    throw new Error('Use [--out directory] [--model <host>:<id>] [--scenes battle-2,battle-15,dance-12]');
  }
  const root = resolve(import.meta.dirname, '..');
  let keys: Env = {};
  try { keys = parseEnv(readFileSync(join(root, '.env.eval'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read .env.eval'); }
  // An empty directory as the configuration root: the bot's own .env never reaches this probe.
  const empty = mkdtempSync(join(tmpdir(), 'simple-chat-illustrate-'));
  const config = loadModelConfig(empty, modelEnv(values.model, keys));
  const provider = createModel({ ...config, dbPath: join(empty, 'unused.sqlite') });
  // A description is the reader's scene in another form, so the default output sits where .gitignore already keeps
  // story data. Naming --out elsewhere is the operator's choice, and theirs to keep out of the repository.
  const directory = values.out ? resolve(values.out) : join(root, 'illustrations', 'prompts');
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  // A rerun into the same directory describes only the frames that are not there yet: a hosted call costs money,
  // and a run that failed in the middle has written everything before it.
  const promptsPath = join(directory, 'prompts.json');
  const cases: Case[] = existsSync(promptsPath) ? JSON.parse(readFileSync(promptsPath, 'utf8')) : [];
  const save = () => writeFileSync(promptsPath, JSON.stringify(cases, null, 2));
  report({ event: 'started', directory, model: config.model, frames: wanted.length });
  try {
    for (const scenario of [...new Set(wanted.map(scene => scene.scenario))]) {
      const todo = wanted.filter(w => w.scenario === scenario && !cases.some(done => done.id === w.id));
      if (!todo.length) continue;
      const frozen: Evidence = JSON.parse(readFileSync(join(root, 'examples', 'frozen', `${scenario}.json`), 'utf8'));
      const { story, branch } = active(frozen.state);
      const scenes = history(story, branch.head);
      const system = storyNarration(frozen.state, story.id).system;
      // The history as the scene itself was written from, up to and including the chosen node.
      const messages = (nodeId: string) => {
        const parts = contextParts(frozen.state, { storyId: story.id, head: nodeId, memory: null });
        return [...parts.seed, ...parts.memory, ...parts.tail];
      };
      // One sheet per story, from its whole history; in the bot it would be kept beside the memory. A sheet already
      // written for this output directory is reused, so a rerun pays for descriptions only.
      const sheetPath = join(directory, `sheet-${scenario}.json`);
      let sheet: Character[];
      if (existsSync(sheetPath)) sheet = JSON.parse(readFileSync(sheetPath, 'utf8'));
      else {
        const reply = await ask(provider, { system, maxOutputTokens: 900, outputSchema: SHEET_SCHEMA,
          messages: [...messages(scenes.at(-1)!.id), { role: 'user', content: SHEET }] });
        sheet = reply.value.characters as Character[];
        writeFileSync(sheetPath, JSON.stringify(sheet, null, 2));
        report({ event: 'sheet_written', scenario, characters: sheet.length, retried: reply.retried });
      }
      for (const scene of todo) {
        const node = scenes[scene.index];
        if (!node) throw new Error(`No scene ${scene.index} in ${scenario}`);
        const reply = await ask(provider, { system, maxOutputTokens: 900, outputSchema: FRAME_SCHEMA,
          messages: [...messages(node.id), { role: 'user', content: instruction(sheet.map(character => character.name)) }] });
        const description = reply.value as unknown as Description;
        const { prompt, namesStripped, fromSheet, withoutLook } = assemblePrompt(description, sheet);
        cases.push({ id: scene.id, scenario, index: scene.index, scene: node.text, sheet, description, prompt, namesStripped, fromSheet, withoutLook });
        save();
        report({ event: 'frame_described', id: scene.id, people: (description.people ?? []).length, fromSheet, namesStripped,
          withoutLook, promptWords: prompt.split(/\s+/).length, cyrillic: /[а-яё]/i.test(prompt), retried: reply.retried });
      }
    }
    report({ event: 'complete', directory, frames: cases.length,
      namesStripped: cases.reduce((sum, one) => sum + one.namesStripped, 0),
      withoutLook: cases.reduce((sum, one) => sum + one.withoutLook, 0) });
  } catch (error) {
    const code = String((error as Failure).code ?? '');
    save();
    report({ event: 'failed', code: /^[a-z_]{1,50}$/.test(code) ? code : 'illustrate_failed', ...safeErrorDetails(error), directory, frames: cases.length });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
