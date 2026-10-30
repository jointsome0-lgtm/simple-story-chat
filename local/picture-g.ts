// A frame's whole picture prompt, written by the story model, for the readers of SIMPLE_CHAT_G_PROMPT_USERS: the arm G
// of the prompt arms probe (local/image-prompt-arms.ts and docs/action-experiment.md#prompt-arms at 15f7f13, on the
// judge-lean branch), which the owner decided on 2026-09-29 to put in the live bot without a measurement on the card
// (docs/telegram-ui.md#g-prompt). For those readers a frame costs one request more. The frame's own request is asked
// first, as for everybody, and its answer still chooses the reference pictures, gives the clothes the next picture
// starts from, and stands ready as today's prompt; then the same scene's request once more, with G's instruction last
// (`gRequest`), and the prompt it answers, through the same nets for names and ages (`gPrompt`), is drawn in place of
// the assembled one. Whatever goes wrong on the way draws today's prompt instead, and the row says why (`GFallback`).
//
// The part from `gInstruction` to `INSTRUCTIONS` is local/image-prompt-arms.ts of 15f7f13, lines 179 to 227, byte for
// byte but for one thing: `gPrompt` ends with the style it is given, which in the bot is the picture's line, as the
// assembly ends today's prompt with it (local/illustrate.ts `assemblePrompt`), and none for the empty style; with the
// probe's STYLE, its default, it gives the probe's prompt. The rest is the bot's.
import { createHash } from 'node:crypto';
import { STYLE, frameRequest, matchSheet, sheetLooks, stripAges, stripNames } from './illustrate.ts';
import type { Character, Excerpt } from './illustrate.ts';
import type { ErrorDetails } from './model-error.ts';
import type { ModelRequest } from './model.ts';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

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
export function gPrompt(value: { people?: { who?: unknown }[]; prompt?: unknown }, sheet: Character[], style = STYLE) {
  const names = sheet.map(one => one.name);
  const strangers = (value.people ?? []).map(person => String(person.who ?? '').trim())
    .filter(who => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, names) === null);
  const stripped = stripNames(stripAges(String(value.prompt ?? '')), [...names, ...strangers]);
  const text = stripped.text.replace(/\s+/g, ' ').trim();
  return { prompt: text ? `${/[.!?]$/.test(text) ? text : `${text}.`} ${style}`.trimEnd() : '', namesStripped: stripped.removed };
}
// Each instruction by one hash, for the records: the bot's frame and G's, as a made-up sheet of one gets them.
const TEMPLATE_SHEET: Character[] = [{ name: 'Имя', look: 'a look', outfit: 'wearing an outfit' }];
export const INSTRUCTIONS = { frame: sha256(frameRequest({ system: '', messages: [] }, TEMPLATE_SHEET).messages.at(-1)!.content),
  g: sha256(gInstruction(TEMPLATE_SHEET)) };

// Why a frame of a reader who has G was drawn from today's prompt after all (local/model-error.ts `G_FALLBACKS`).
export type GFallback = NonNullable<ErrorDetails['gFallback']>;
// Which rule of `gTagged` left a bound person without a number (local/model-error.ts `G_TAG_MISSES`).
export type GTagMiss = NonNullable<ErrorDetails['gTagMiss']>;
// What a frame keeps of G, in memory alone as the frame itself is (local/picture.ts `frames`), so that a sample draws
// the same prompt with another line: the prompt without its style line, what the nets cut from it, the names they cut
// and the sheet's people G's `people` named; or why today's prompt is drawn instead.
export type GKept = { prose: string; namesStripped: number; names: string[]; listed: string[] } | { fallback: GFallback };
// What the row says of G's request (local/model-error.ts): its time, and its tokens where the server reported them.
export type GCounts = { gMs: number; gInputTokens?: number; gCachedTokens?: number; gOutputTokens?: number };

// G's answer as a frame keeps it: `gPrompt` with no style, when the answer has G's fields at all, since it is model
// output, then the checks. A letter of another script left in the prompt is most likely a name the nets did not know,
// since the stories' names are Cyrillic, and the picture model would read it as text to draw.
export function gKept(value: Record<string, unknown>, sheet: Character[]): GKept {
  const people = value.people ?? [];
  if (typeof value.prompt !== 'string' || !Array.isArray(people) || !people.every(one => typeof one === 'object' && one !== null)) {
    return { fallback: 'unparsed' };
  }
  const { prompt: prose, namesStripped } = gPrompt({ people, prompt: value.prompt }, sheet, '');
  if (!prose) return { fallback: 'empty' };
  if (/(?=\p{L})\P{Script=Latin}/u.test(prose)) return { fallback: 'non_latin' };
  // The names `gPrompt` took out, for the looks `gTagged` looks for: the sheet's, and each stranger's that `people`
  // gives as one capitalised word. And the sheet's people `people` named, in whatever spelling (`matchSheet`), so that
  // `gTagged` can tell a person G left out from one whose look it wrote in other words.
  const names = sheet.map(one => one.name);
  const who = (people as { who?: unknown }[]).map(person => String(person.who ?? '').trim());
  const strangers = who.filter(one => one.length > 1 && !/\s/.test(one) && /^\p{Lu}/u.test(one) && matchSheet(one, names) === null);
  const listed = who.map(one => matchSheet(one, names)).filter(one => one !== null);
  return { prose, namesStripped, names: [...names, ...strangers], listed };
}

// The prompt drawn from G's: the prompt, then the picture's style line, or nothing more for the empty style.
export const gLine = (prose: string, line: string) => `${prose} ${line}`.trimEnd();

const key = (name: string) => name.trim().toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A text's words as it spells them, with what stands between each two; and words in lower case, for comparing looks.
type Parts = { words: string[]; gaps: string[] };
const split = (text: string): Parts => {
  const cut = text.split(/([\p{L}\p{N}]+)/u);
  return { words: cut.filter((_, at) => at % 2 === 1), gaps: cut.filter((_, at) => at % 2 === 0).slice(1, -1) };
};
const lower = (run: string[]) => run.map(word => word.toLowerCase());
// Whether one run of words stands whole, in order and unbroken, inside another.
const within = (part: string[], whole: string[]) => part.length > 0
  && whole.some((_, at) => at + part.length <= whole.length && part.every((word, index) => whole[at + index] === word));
type Span = { at: number; end: number };
const found = (text: string, pattern: string): Span[] => [...text.matchAll(new RegExp(pattern, 'giu'))].map(one => ({ at: one.index, end: one.index + one[0].length }));
// What the prompt may have between two of a look's words when the look is not there to the letter: what the sheet has
// there, with either apostrophe, and for a space or a hyphen either of the two ("blue eyed" for "blue-eyed"), though
// not beside a number, where "1-5" is not "1.5". Nothing more: a comma or a full stop the sheet does not have could
// begin another clause, about somebody else.
const gap = (between: string, left: string, right: string) => /^(?:\s+|-)$/.test(between) && !/\p{N}/u.test(left + right) ? '(?:\\s+|-)'
  : escape(between).replace(/['’]/g, "['’]");
// A look that owns the next word is not the person: "the tall woman's daughter" is about the daughter.
const owns = (text: string, span: Span) => /^['’]s(?![\p{L}\p{N}])/iu.test(text.slice(span.end));
// Every place a look's words, from the given one on, stand in a text in that way, in any case, and not as an owner.
const spans = (text: string, look: Parts, from = 0) => look.words.length <= from ? []
  : found(text, `(?<![\\p{L}\\p{N}])${look.words.slice(from).map((word, at) => (at ? gap(look.gaps[from + at - 1], look.words[from + at - 1], word) : '') + word).join('')}(?![\\p{L}\\p{N}])`)
    .filter(span => !owns(text, span));
const ARTICLE = /^(?:a|an|the)$/i;
// What may stand before a look's words in place of its article: an article, with at most one word of the model's own
// after it ("the kneeling"), or nothing at all where a sentence begins. Not a word that tells one person from another
// like them ("the other tall woman").
const LEAD = /(?<![\p{L}\p{N}])(?:a|an|the)\s+(?:(?!(?:a|an|the|other|different|second|third|fourth)\s)\p{L}[\p{L}'’-]*\s+)?$/iu;
const OPENS = /(?:^|[.!?]\s+)$/;

// G's prompt for a frame with reference pictures, before its opening (local/picture-references.ts `referenceOpening`):
// each person bound to a picture named by its number, `The person from image N, `, before their look, which G's
// instruction has the model copy word for word (`gInstruction`). The model does not always copy letter for letter, so:
// - the look stands once, letter for letter in whatever case: the number goes there and the look after it is the
//   sheet's own, as the nets left it and as in today's clause (`referencePrompt`). This is the rule of before
//   2026-10-04, and its prompts come out as they did, but for a look that owns the next word (`owns`), which is not
//   a place for the number in any of the three ways.
// - not so, but it stands once with a space for a hyphen, a hyphen for a space or the other apostrophe (`gap`): there.
// - nowhere, in a look of five words or more that begins with an article: where the look without the article stands
//   once in the same way, behind another article with at most one word of the model's own ("the kneeling tall woman"
//   for "a tall woman") or at the start of a sentence. Only for a person G's `people` named: without G's word that the
//   person is in the frame, a look found less than whole could be somebody else's.
// In the two looser places the prompt keeps its own words and only gains the number: code does not rewrite what it did
// not find whole. A look or its words standing more than once say nothing of which place is the person's own
// sentence, and a person whose words another person of the sheet has too, alone or inside a longer look, could be
// either of the two: no number then. Nor when two places overlap, or when the prompt already has such a label, since
// only code binds image numbers and the model's own could duplicate or misassign one.
// The first person without a place, in the order of the pictures, gives the reason the row carries (`GTagMiss`);
// `loose` counts the people placed in the two looser ways.
export function gTagged(kept: { prose: string; names: string[]; listed: string[] }, sheet: Character[], bound: { name: string }[]): { text: string; loose: number } | { miss: GTagMiss } {
  if (/\bthe person from image\s+\d+\b/i.test(kept.prose)) return { miss: 'label' };
  const looks = sheetLooks(sheet);
  const cleaned = (name: string) => stripNames(stripAges(looks.get(key(name)) ?? ''), kept.names).text.replace(/\s+/g, ' ').trim();
  const places: (Span & { text: string })[] = [];
  let loose = 0;
  for (const [slot, one] of bound.entries()) {
    const look = cleaned(one.name), parts = split(look), run = parts.words, label = `The person from image ${slot + 1}, `;
    const others = sheet.filter(other => key(other.name) !== key(one.name)).map(other => lower(split(cleaned(other.name)).words));
    const shared = (part: string[]) => others.some(other => within(lower(part), other));
    // The prompt's own words after the number, their first word small where the look's is: an article whole, another
    // word by its capital.
    const own = (span: Span, model: string) => {
      const text = kept.prose.slice(span.at, span.end), first = /^[\p{L}\p{N}]+/u.exec(text)?.[0] ?? '';
      const small = !/^\p{Ll}/u.test(model) ? first : ARTICLE.test(first) ? first.toLowerCase()
        : /^\p{Lu}\P{Lu}*$/u.test(first) ? first[0].toLowerCase() + first.slice(1) : first;
      return label + small + text.slice(first.length);
    };
    const exact = look ? found(kept.prose, `(?<!\\p{L})${escape(look)}(?!\\p{L})`).filter(span => !owns(kept.prose, span)) : [], close = spans(kept.prose, parts);
    if (exact.length > 1 || (!exact.length && close.length > 1)) return { miss: 'several' };
    if (exact.length || close.length) {
      if (shared(run)) return { miss: 'repeated' };
      if (exact.length) places.push({ ...exact[0], text: label + look });
      else { places.push({ ...close[0], text: own(close[0], look) }); loose++; }
      continue;
    }
    const named = kept.listed.some(name => key(name) === key(one.name)), rest = run.slice(1);
    const tail = named && run.length >= 5 && ARTICLE.test(run[0]) ? spans(kept.prose, parts, 1) : [];
    if (tail.length > 1) return { miss: 'several' };
    if (tail.length && shared(rest)) return { miss: 'repeated' };
    const before = tail.length ? kept.prose.slice(0, tail[0].at) : '', lead = tail.length ? LEAD.exec(before) : null;
    if (!tail.length || (!lead && !OPENS.test(before))) return { miss: named ? 'missing' : 'absent' };
    const span = { at: lead ? lead.index : tail[0].at, end: tail[0].end };
    places.push({ ...span, text: own(span, lead ? 'a' : rest[0]) });
    loose++;
  }
  const ordered = places.sort((one, other) => one.at - other.at);
  if (ordered.some((one, index) => index > 0 && one.at < ordered[index - 1].end)) return { miss: 'overlap' };
  return { text: ordered.reduceRight((text, one) => text.slice(0, one.at) + one.text + text.slice(one.end), kept.prose), loose };
}
