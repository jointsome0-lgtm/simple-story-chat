// The description step (docs/telegram-ui.md#picture-pipeline): one character sheet per story, one structured
// description of one frame per scene, and the text-to-image prompt assembled here, in code
// (docs/illustrations-plan.md#step-3: the model writing the prompt itself dropped fields it had filled). Two callers
// share it and must keep sharing it — local/picture.ts, which illustrates a reader's scene in the bot, and
// local/illustrate-probe.ts, which describes the frozen synthetic stories on a hosted model — so that what the six
// steps measured is what the bot sends. Nothing is drawn here.
import type { ChatMessage, GenerateControls, ModelRequest, Provider } from './model.ts';

// One recurring person of a story: the name as the story writes it, three layers of their appearance
// (docs/illustrations-plan.md#three-layers, the owner's design of 2026-09-27), and the clothes they wear unless the
// frame says otherwise. `description` is the whole text, in any language and form, which the sheet takes from the story
// or the reader writes, and which never reaches the image model; `changes`, the lasting changes the story made to the
// person, which the sheet writes beside it. `details`, the English prose a portrait is drawn from
// (local/image-portraits.ts `portraitText`), and `look`, the fixed appearance line the assembly puts in wherever a
// described person is that name, are retold from those two in a call of their own (`retellRequest`): a portrait holds
// one person and takes all of it, a frame holds up to four and keeps the short line. The sheet is written once per
// story and reused for all its frames, and as the model answers it, it has no details and an empty look. Clothes are
// not in `look`: a sheet that froze them kept a reader's characters in the clothes of the seed after the story had
// changed them (2026-09-24), so each frame writes what its people wear, starting from what they wore in the picture
// before it (local/picture.ts).
export type Character = { name: string; description?: string; changes?: string; details?: string; look: string; outfit?: string };
// `who` is the only field allowed to carry a name, and it never reaches the image model: it selects the sheet line.
export type Person = { who: string; look: string; clothes?: string; state: string; action: string };
export type Description = {
  moment: string; shot: string; setting: string; objects: string; props: string; light: string; people: Person[];
};
// What the assembly counts about one frame. `withoutLook` counts the people who reached the prompt with no
// appearance at all, which is the way this assembly fails quietly; `namesStripped` counts the names the net below
// caught in a field the instruction forbids them in.
export type Assembled = { prompt: string; namesStripped: number; fromSheet: number; withoutLook: number };

// The style belongs to us, not to the describing model: step 1 measured it picking a different style every time.
// Its faces are true to each person's age, not adult, since 2026-09-26: the sheet now gives a child's age as a word,
// and the style line, last in every frame, would have drawn that child with an adult's face.
export const STYLE = 'Hand-painted visual novel illustration with soft opaque brushwork, muted natural colors and restrained shading. Naturalistic facial proportions true to each person\'s age, moderately sized eyes, simplified noses and mouths, and age-appropriate facial lines throughout. Clear silhouettes.';

// An age as a number reached the prompt in step 1 ("48-year-old") against the rule that only the visible goes in: the
// years a person has lived are not always the age they look. Every field is cleaned, not only the sheet as in the
// scratch script. The net knows English alone, the language the describing model writes, and cuts a visible age given
// in years as readily as the years themselves. A description reaches no prompt at all, only what the model retold of it
// (`retellRequest`), and a look the reader writes in another language reaches the frames as written.
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
// A part of a clause: the parts of a person are joined with commas, so a full stop at the end of one is cut.
const phrase = (text: string) => text.trim().replace(/\.$/, '').trim();

// The sheet's appearance lines, by name in lower case. A line is the story's constant for that person, so an age
// written as a number is taken out of it once, here.
export function sheetLooks(sheet: Character[]): Map<string, string> {
  return new Map(sheet.map(character => [character.name.trim().toLowerCase(), stripAges(character.look.trim().replace(/\.$/, ''))]));
}

// A sheet written before clothes left its appearance lines, or before the descriptions came on 2026-09-27: every entry
// of a newer one carries `outfit` and `changes`, even empty ones. The first kind would dress its people twice, and the
// second has no description to retell, its looks written by the sheet itself; either is written again rather than used.
export function olderSheet(sheet: Character[]): boolean {
  return sheet.some(character => typeof character.outfit !== 'string' || typeof character.changes !== 'string');
}

// The order is the one the third reader asked for: shot, setting, the shared action once, each person, objects,
// props, light, style. A person the sheet covers takes their look from the sheet alone — the model's own `look` for
// them contradicts it, and in step 6 the contradiction was visible in the picture. Clothes are the frame's for
// everybody; a person of the sheet whom the frame left without any wears the sheet's `outfit`, which the caller has
// set to what they wore in the picture before. The style line is always the
// last sentence and never comes from the describing model: the bot may carry its own in `SIMPLE_CHAT_IMAGE_STYLE`,
// and a reader may pick a preset or write a line of their own (local/picture-style.ts). Those are the only parts of
// this prompt a person writes.
export function assemblePrompt(description: Description, sheet: Character[], style = STYLE): Assembled {
  const looks = sheetLooks(sheet);
  const sheetNames = sheet.map(character => character.name);
  // The sheet holds the recurring people, and a stranger of one scene — or anybody at all, when the sheet came back
  // empty — is named in `who` and then, often enough, in `moment` and `objects` as well. `who` never reaches the
  // image model, but those fields do, so the description's own names join the ones the net strips. The instruction
  // asks for a short lower-case role for a person the sheet does not cover ("salt worker"), so a `who` of one
  // capitalised word is a name and a role written as the instruction asks is left alone: cutting a role would cost
  // the picture the person it describes. A name in a field of somebody the description never lists is still only
  // the instruction's to catch.
  const strangers = (description.people ?? []).map(person => (person.who ?? '').trim())
    .filter(who => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, sheetNames) === null);
  const names = [...sheetNames, ...strangers];
  let namesStripped = 0;
  let fromSheet = 0;
  let withoutLook = 0;
  const clean = (text: string) => {
    const stripped = stripNames(stripAges(text ?? ''), names);
    namesStripped += stripped.removed;
    return stripped.text;
  };
  const outfits = new Map(sheet.map(character => [character.name.trim().toLowerCase(), character.outfit ?? '']));
  const people = (description.people ?? []).map(person => {
    const matched = matchSheet(person.who ?? '', sheetNames);
    const key = matched === null ? undefined : matched.trim().toLowerCase();
    const known = key === undefined ? undefined : looks.get(key);
    if (known) fromSheet++;
    // The sheet is model output too: a name in an appearance line would reach every frame of that story.
    const look = clean(known ?? person.look ?? '');
    // A person the sheet does not cover and whose `look` the model left empty anyway reaches the picture with no
    // body or hair. Nothing can be done about it here, but it is counted rather than lost.
    if (!look.trim()) withoutLook++;
    const clothes = phrase(clean(person.clothes ?? '')) || (key === undefined ? '' : phrase(clean(outfits.get(key) ?? '')));
    const before = [look, clothes, clean(person.state)].map(phrase).filter(Boolean).join(', ');
    const action = clean(person.action).trim();
    // No appearance and no state leaves nothing to put before the colon, and a prompt that opens a clause with one.
    return sentence(before ? `${before}: ${action}` : action);
  }).join('');
  const prompt = sentence(clean(description.shot)) + sentence(clean(description.setting)) + sentence(clean(description.moment))
    + people + sentence(clean(description.objects)) + sentence(clean(description.props)) + sentence(clean(description.light)) + style;
  // The empty style (local/picture-style.ts) leaves the space after the last sentence at the end.
  return { prompt: prompt.trimEnd(), namesStripped, fromSheet, withoutLook };
}

// The two instruction texts are kept as they were iterated against the readers' reports
// (docs/illustrations-plan.md#description-steps). The changes since: the name ban, which step 6 found stated in one
// bullet about `people` while `moment` carried names to the image model; clothes taken out of `look` into `outfit`
// and `clothes` (2026-09-24); the age words, which say young adult where they said young, since no line after the
// prompt says the people are adults; and `details` before `look` (2026-09-26), so that the model wrote a portrait's
// worth of each person first, with the age words of children, which the sheet lacked
// (docs/illustrations-plan.md#portrait-details); and the same words, with the skin tone, in the look the frame writes of
// a person the sheet does not name, the same day, where the rule allowed an adult's words only; and on 2026-09-27 the
// age a stranger looks in that look, where it said nothing of looks and years; and the same day the three layers
// (docs/illustrations-plan.md#three-layers): the sheet takes each person's description from the story, in the story's
// language, with the lasting changes beside it, where it wrote English details and a look, and the rules for those two
// went to the retelling (`RETELL`), which writes them for the whole sheet at once; and, before the second retelling
// check, no word for the bust, the hips or the buttocks of a child or a teenager, in a stranger's look as in the
// sheet's description and the retelling (2026-09-27).
// The age words, children's among them, which the details and the look are retold with.
const AGE_WORDS = 'small child, child, teenager, young adult, middle-aged, elderly';
// Where a height given in numbers becomes a word, against an ordinary adult of the same sex (the owner, 2026-09-27): a
// woman is tall from about 175 cm, 10 cm over an ordinary woman's 165, so 170 is not tall. A man's tall is set on the
// same step over an ordinary man's 178, and very tall and short 18 cm over and 10 cm under the same two heights. Each
// word's range is closed at both ends since the second retelling check, where men of 193 and 194 cm, tall by these
// heights, came back very tall in five answers of five.
const HEIGHTS = 'взрослой женщине short — ниже 155 см (5\'1"), tall — от 175 до 182 см (5\'9"–5\'11"), very tall — от 183 см (6\'0"); взрослому мужчине short — ниже 168 см (5\'6"), tall — от 188 до 195 см (6\'2"–6\'4"), very tall — от 196 см (6\'5"). Так что женщина 170 см — ещё не tall, а мужчина 190 см — ещё не very tall';
// The description is taken in the story's language: the reader reads it on the characters' card and writes over it
// there, and the story's own words, numbers and tables go in as the story gives them, to be put into English once, by
// the retelling. Where the story is silent the sheet still chooses once, as it did when it wrote the look itself, and
// says so in a line of its own: the choice is then part of the description every retelling reads, so the frames keep
// it, and the reader sees which part of it the story never said.
const SHEET = `Не продолжай историю. Составь лист внешности для художника: по одной записи на КАЖДОГО человека, названного в истории по имени или по постоянной роли (командир, лекарь, судья) и появляющегося больше чем в одной сцене. Обычно их от трёх до шести; одна запись на целую историю — почти наверняка ошибка.
- name: имя так, как оно пишется в истории.
- description: на языке истории, не длиннее 150 слов, без имени и БЕЗ ОДЕЖДЫ: всё, что история говорит о постоянной внешности этого человека, так подробно, как она это даёт: пол, возраст и на сколько он выглядит, цвет кожи, рост и телосложение, мерки тела, волосы и обычная причёска, лицо, постоянные приметы с их местом и стороной. Числа, мерки и таблицы переписывай как в истории, не пересчитывая и не переводя в слова; что история говорит о теле словами, передавай с той же силой. Внешность — такая, какой история её оставила к последней сцене, с постоянными переменами по ходу истории. О груди, бёдрах и ягодицах ребёнка и подростка не пиши, даже если история о них говорит.
- Если история не говорит, какого человек пола, на сколько лет он выглядит, какого цвета у него кожа, какого он роста и телосложения, какие у него волосы и лицо, выбери это сам, один раз, правдоподобно для мира истории и так, чтобы люди листа заметно отличались друг от друга силуэтом, волосами и лицом, и допиши выбранное последней строкой description, которая начинается словами «Не сказано в истории:» на языке истории.
- changes: на языке истории, одной строкой: постоянные перемены внешности, которые случились по ходу истории (шрам, новая стрижка, выбритая голова, перекрашенные волосы, татуировка); в description они уже есть. Пустая строка, если их не было.
- outfit: по-английски, 8-20 слов, фразой, которая начинается с wearing: во что человек одет в ПОСЛЕДНЕЙ сцене, где история говорит о его одежде. Если по ходу истории он переоделся, это новая одежда, а не та, что в начале истории или в её описании. Если история об одежде молчит, придумай её правдоподобно для мира истории, и так, чтобы персонажи заметно отличались цветом одежды.
- Не включай в description и changes одежду, раны и повязки, которые заживут, грязь, мокрые волосы, оружие и предметы в руках и причёски на один раз.`;
const SHEET_SCHEMA = { type: 'object', additionalProperties: false, required: ['characters'], properties: { characters: { type: 'array', maxItems: 6,
  items: { type: 'object', additionalProperties: false, required: ['name', 'description', 'changes', 'outfit'],
    properties: { name: { type: 'string' }, description: { type: 'string' }, changes: { type: 'string' }, outfit: { type: 'string' } } } } } };

// The details and the look of the people of one sheet, retold from their descriptions and the story's changes in one
// answer (the owner's designs of 2026-09-26 and 2026-09-27, docs/illustrations-plan.md#three-layers): the English
// prose a portrait is drawn from, since a table of measurements given to the image model as written was drawn as
// lettering, and the look compressed from it. Only what a description and its changes say goes in, since both stand
// for them in every picture, and a height, a weight or a body's measurements go in as words about the build (the
// owner, 2026-09-26), since neither holds numbers. A sex read from measurements, a skin tone from freckles, a height
// left out and the years where a description says how old a person looks were what the hosted Gemma still did on
// 2026-09-26 with the rule for the look alone, and the rule names each since 2026-09-27. The owner allowed the same day
// a sex that words about the body leave in no doubt, such as a beard or a bra size, never one read from measurements
// alone, and set where a height in numbers becomes a word (`HEIGHTS`), a height also given in a word keeping that word.
// The whole sheet is in view, the others' descriptions as well as their looks, for two rules of the same day: people
// described alike keep in their looks what tells them apart, hair and height before proportions, and one measure is
// given in the words of one absolute scale across the sheet, the same size in the same word and a size more in the
// next word up, never a comparison (the owner, 2026-09-27). A look carries a word and not the number it stands for, so
// the others' looks alone could not keep that scale. Where the reader's description and the story's changes disagree,
// the description wins (the owner, 2026-09-27). After the first retelling check of the same day
// (docs/illustrations-plan.md#retell-check): sex and age are one ordinary phrase, where "each in its own word" gave
// "Woman young adult" and details of 11 words; the build names arms and legs, whose softness the revised details lost
// in four answers of four; a table of measurements alone becomes words, which the rule for an unknown sex had left
// empty in four answers of five; people alike lead with what the others lack, where the look-alike led with the "tall"
// both looks had; and the scale holds within one sex and one age group. Before the second check of the same day, a
// child or a teenager gets no word for the bust, the hips or the buttocks, since the proportions the rule lists for
// everybody name them: an adult who looks a teenager loses them as well, since the look is of the age a person looks.
// After the second check, in its one revision: the people are put in order by a measure before its words are given,
// with one intensifier a word, since a size 6 took a stronger word than two sizes 7 in two answers of three and the
// size 8 two intensifiers in all three; a word of the description keeps its strength, since "очень" became
// "extremely" once; a child's age word takes the sex word beside it, since the boy of six was "a small child" in all
// three; and a table alone opens with "a person", since it was "a man" in all three.
const RETELL =`Перескажи для художника описания внешности людей одной истории, которые идут ниже: каждому, кого просят пересказать, — details для его портрета и look для сцен.
- details: по-английски, связной прозой, не длиннее 200 слов, без имён, без одежды, без чисел и без разметки (таблиц, списков, заголовков). Всё, что описание говорит о внешности, ничего не теряя, по порядку: пол и возраст одной обычной фразой (a young adult woman, a middle-aged man; у ребёнка — слово возраста, затем слово пола: a small child, a boy; a teenager, a girl); цвет кожи; рост и телосложение; пропорции: плечи, грудь, талия, бёдра, ягодицы, руки и ноги, и мягкие они или рельефные; волосы: цвет, длина, фактура и обычная причёска; лицо: форма, брови, глаза и их цвет, нос, губы, растительность на лице, морщины; постоянные приметы (шрам, татуировка, родинка, очки) с их местом и стороной (left и right здесь стороны самого человека).
- look: по-английски, 15-25 слов, тоже без имён, без одежды и без чисел. Это details, сжатые до того, по чему этого человека узнают издали среди других: пол и возраст теми же словами, что в details, рост и телосложение с тем, что в них заметно отличается, каждую заметную пропорцию своими словами, а не одним общим словом вместо них (curvy, voluptuous, muscular), цвет кожи, волосы с обычной причёской и одна-две приметы.
- Пол словом (man, woman, boy, girl) — если описание называет его прямо (мальчик — boy, девочка — girl) или однозначно выдаёт словами о теле (борода — man, размер груди — woman); одни мерки пола не выдают, даже если кажутся мужскими или женскими (плечи, обхваты, стопа), а слово возраста (small child, teenager) — не слово пола и не заменяет его. Цвет кожи — только если описание называет его прямо: веснушки и светлые волосы — не цвет кожи.
- Возраст ТОЛЬКО словом (${AGE_WORDS}) и никогда числом, и тот, на который человек выглядит: если описание называет и годы, и то, на сколько он выглядит, бери второе.
- Рост, вес и мерки тела, если описание даёт их числами, переведи в слова о росте, телосложении и пропорциях, сравнивая с обычным человеком того же пола и возраста: tall, very tall, short, petite, slender, heavyset, broad-shouldered, narrow-waisted, wide-hipped, long-legged. Рост: ${HEIGHTS}. Если пол не понять, сравнивай с обычным взрослым, пола не называя: details и look тогда начинаются с a person. Назови всё, что заметно отличается от обычного, и рост тоже, а сильное отличие — со словом very, рост — по этим порогам: это не выдумка, а те же числа словами. Описание из одной таблицы мерок — тоже рост, телосложение и пропорции словами, а не пустые details и look. Рост, названный и словом, и числом, передавай словом описания. Что описание говорит о теле словами, передавай с той же силой, не усиливая и не ослабляя: очень — very, а не extremely.
- Ребёнку и подростку (small child, child, teenager) не называй ни грудь, ни бёдра, ни ягодицы, ни в details, ни в look, даже если описание о них говорит: его телосложение — это рост, худоба или полнота, плечи, руки и ноги.
- Одна и та же мерка у разных людей одного пола и одной возрастной группы (рост, грудь, талия, бёдра, ягодицы и другие) — слова одной лестницы на всех. Сначала расставь этих людей по мерке от меньшей к большей, потом дай слова в том же порядке: у меньшей мерки слово никогда не сильнее, чем у большей; одинаковые числа, размеры или слова описаний — одно и то же слово; на размер больше — следующее слово вверх, на размер меньше — вниз. Слова лестницы, например: small, medium, large, very large, extremely large, huge; в слове одно усиление, никогда два (не extremely very large). Слова без сравнения с другими людьми (не larger than hers, не the largest): look один на все сцены, а рядом с человеком каждый раз стоят разные люди. Готовые look других — часть той же лестницы.
- Если люди похожи, в look каждого сразу после пола и возраста назови то, чего нет у похожих на него, по порядку: волосы (цвет, длина, причёска), рост, цвет кожи, приметы; общее с ними, пропорции тоже, — только потом. Словами только о нём самом, не сравнивая и не упоминая других.
- Если причёска меняется (по дням, по случаю), пиши обычную и не пиши остальные.
- Изменения из истории — постоянные перемены внешности по ходу истории (шрам, стрижка, перекрашенные волосы): прибавь их к описанию; где они ему противоречат, верь описанию.
- Описание может быть на любом языке и в любом виде, с таблицей мерок тоже, а его строка «Не сказано в истории: …» — тоже внешность этого человека. Бери всё только из описания и изменений этого человека и ничего не придумывай: чего в них нет, того нет ни в details, ни в look, даже пола, возраста и цвета кожи. Но details и look не бывают пустыми: без пола и возраста пиши то, что в описании есть. Описания и look других людей — только для лестницы слов и чтобы отличать похожих: ничего из них этому человеку не переноси.`;
const RETELL_SCHEMA = { type: 'object', additionalProperties: false, required: ['retold'], properties: { retold: { type: 'array', maxItems: 6,
  items: { type: 'object', additionalProperties: false, required: ['person', 'details', 'look'],
    properties: { person: { type: 'integer' }, details: { type: 'string' }, look: { type: 'string' } } } } } };

// `sheet` is the story's sheet with `outfit` set to what each of its people wore in the picture before this one.
const instruction = (sheet: Character[]) => `Не продолжай историю. Опиши ПОСЛЕДНЮЮ сцену для художника-иллюстратора: один неподвижный кадр, как в визуальной новелле. Пиши по-английски. Готовый запрос для модели картинок соберёт программа из твоих полей, поэтому всё существенное должно быть в полях; чего в них нет, того не будет на картинке.
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
- people: каждый человек, который должен быть виден, отдельной записью, со своим действием. who — имя из списка [${sheet.map(character => character.name).join(', ')}], если это он; иначе короткая роль по-английски ("salt worker"). look: для людей из списка — ПУСТАЯ строка, их постоянную внешность подставит программа из листа внешности, и твой текст для них не будет использован; для остальных — пол, возраст словом (small child, child, teenager, young adult, middle-aged, elderly) по виду, а не по годам, цвет кожи, телосложение, волосы, без одежды; у ребёнка и подростка — без груди, бёдер и ягодиц. clothes — во что он одет В ЭТОТ МОМЕНТ, по-английски, фразой, которая начинается с wearing. state — то, что сейчас с ним и видно глазу, кроме одежды: повязки, шины, что держит, что в ножнах; пустая строка, если нечего. action — что он делает в этом кадре и чего касается. Имён не должно быть НИ В ОДНОМ поле, кроме who: пиши he, she, the shield-bearer.${clothesRule(sheet)}
- shot: план и ракурс, при котором видны ключевое действие и все перечисленные люди. В тесной сцене с несколькими людьми бери средне-общий план в три четверти, а не эффектный нижний ракурс.
- setting: место, по-английски, без названий, которые ничего не говорят глазу. objects: важные предметы и их состояние; пустая строка, если нечего.
- light: свет и время суток словами (morning, evening), без часов и минут. Не называй дверь, проём или арку источником света: закрытая дверь должна остаться закрытой. Если дверь или окно в сцене закрыты, так и напиши в setting.
- Только то, что можно увидеть: без мыслей, реплик, предыстории. Без слов стиля, техники, качества (photorealistic, anime, 8k, cinematic). Возраст словами, не числом.`;

// The clothes the people of the sheet start this frame in. Repeated word for word, they keep a person recognisable from
// one picture to the next; a change the story made since is the one thing that should change them.
function clothesRule(sheet: Character[]): string {
  const worn = sheet.filter(character => character.outfit?.trim());
  if (!worn.length) return '';
  return `
- Одежда людей из списка до этой сцены:
${worn.map(character => `  - ${character.name}: ${character.outfit!.trim()}`).join('\n')}
  Если история с тех пор переодела человека, раздела его, одела во что-то новое, испачкала или порвала одежду, в clothes опиши одежду такой, какая она сейчас. Если нет — повтори его строку отсюда слово в слово.`;
}

const str = { type: 'string' };
const FRAME_SCHEMA = { type: 'object', additionalProperties: false, required: ['moment', 'shot', 'setting', 'objects', 'props', 'light', 'people'], properties: {
  props: str, moment: str, shot: str, setting: str, objects: str, light: str,
  people: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['who', 'look', 'clothes', 'state', 'action'],
    properties: { who: str, look: str, clothes: str, state: str, action: str } } } } };

// The sheet and the frame are shaped as a continuation of the scene's own request: the same system prompt and the same
// history, with one instruction appended last, so a server with a prefix cache pays for the instruction alone (the
// plan's "What the second call costs"). `messages` is what local/prompt.ts `contextParts` produced for that scene.
export type Excerpt = { system: string; messages: ChatMessage[] };
// The runaway of JSON mode is answered with a low limit and one retry, not with a longer wait: step 1 measured a
// reply that filled 700 tokens with newlines, and the same scene parsed on the next attempt.
export const DESCRIBE_TOKENS = 900;
// The sheet's own limit since it takes each person's description from the story: six people with descriptions of 150
// Russian words, changes of 20 and outfits of 20, a synthetic reply counted by Gemma 4's tokenizer (local/tokenizer.ts),
// came to 2494 tokens as compact JSON and 2634 indented, and with descriptions of 200 words to 3342 indented. A runaway
// takes that long.
export const SHEET_TOKENS = 3600;
// The retelling's limit, once for the reply and once more for every person it retells: details of 200 words and a look
// of 25 came to 295 tokens of Gemma 4's tokenizer as compact JSON and 321 indented for one person, and to 1861
// indented for six, so this holds about half as many words again and a runaway ends there before its one retry.
export const RETELL_TOKENS = { reply: 200, person: 500 };

// The sheet of a whole story, from its history up to the scene named in `context`.
export function sheetRequest(context: Excerpt): ModelRequest {
  return { system: context.system, maxOutputTokens: SHEET_TOKENS, outputSchema: SHEET_SCHEMA,
    messages: [...context.messages, { role: 'user', content: SHEET }] };
}

// One person of the sheet as the retelling reads them: the description, the story's changes, and the look already
// written for them, which only a person not retold this time is shown with.
export type RetellPerson = { description: string; changes?: string; look?: string };
// The details and the looks of the people of `asked`, indexes into `people`, retold from their descriptions beside the
// whole sheet's (local/picture.ts). It carries no story: a description and its changes are all it may take a person's
// appearance from, and on its own it is a few thousand tokens at most. The people are numbered rather than named, so
// that no name reaches the model's English, and a number is what its answer names them by.
export function retellRequest(people: RetellPerson[], asked: number[]): ModelRequest {
  const line = (text: string | undefined) => text?.replace(/\s+/g, ' ').trim() || 'нет';
  const block = people.map((person, index) => [`Человек ${index + 1}`, 'Описание:', person.description.trim() || 'нет',
    `Изменения из истории: ${line(person.changes)}`, ...!asked.includes(index) && person.look?.trim() ? [`Готовый look: ${line(person.look)}`] : []].join('\n'));
  const content = `${RETELL}\n\nЛюди истории (номер — только для ответа):\n\n${block.join('\n\n')}\n\nПерескажи: ${asked.map(index => `человек ${index + 1}`).join(', ')}. В retold — по записи на каждого из них: person — его номер, details и look.`;
  return { system: '', maxOutputTokens: RETELL_TOKENS.reply + RETELL_TOKENS.person * asked.length, outputSchema: RETELL_SCHEMA,
    messages: [{ role: 'user', content }] };
}

// One frame of the last scene of `context`. The names of `sheet` are in the instruction only so that the model can
// say which described person is which sheet line, and they never reach the image model; its outfits are the clothes
// its people start this frame in.
export function frameRequest(context: Excerpt, sheet: Character[]): ModelRequest {
  return { system: context.system, maxOutputTokens: DESCRIBE_TOKENS, outputSchema: FRAME_SCHEMA,
    messages: [...context.messages, { role: 'user', content: instruction(sheet) }] };
}

// One structured reply, parsed, with one retry. The raw text never leaves this function: it is the reader's scene in
// another form, and an unparsed reply is a code, not a sample.
export async function askJson(provider: Provider, request: ModelRequest, controls?: GenerateControls):
Promise<{ value: Record<string, unknown>; retried: boolean }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await provider.generate(request, controls);
    // JSON mode runs away into newlines until the output limit; step 1 measured it, and the same scene parsed next try.
    try { return { value: JSON.parse(result.text), retried: attempt > 0 }; } catch { /* reported as unparsed below */ }
    // A cancelled call answers with whatever it had; retrying it would spend the slot on a reader who has moved on.
    if (controls?.signal?.aborted) break;
  }
  throw Object.assign(new Error('unparsed_description'), { code: 'unparsed_description' });
}

// The sheet as the model answered it. `characters` is the schema's only field, and a reply that parsed as JSON
// without it, or with a character whose name or description is not a string, would otherwise reach the assembly as
// undefined. A person with an empty description is left out, to be described in each frame as somebody the sheet does
// not cover: there is nothing to retell. `changes` and `outfit` are always strings here, empty when missing, which is
// what marks a sheet as this kind (`olderSheet`), and the look is empty until the retelling writes it.
export function sheetOf(value: Record<string, unknown>): Character[] {
  const characters = Array.isArray(value.characters) ? value.characters : [];
  const text = (field: unknown) => typeof field === 'string' ? field.trim() : '';
  return characters.flatMap(one => {
    const { name, description, changes, outfit } = (one ?? {}) as { name?: unknown; description?: unknown; changes?: unknown; outfit?: unknown };
    return typeof name === 'string' && name.trim() && text(description)
      ? [{ name, description: text(description), changes: text(changes), look: '', outfit: text(outfit) }] : [];
  });
}

// The details and the look of each person the retelling answered for, by index into its people, each on one line as
// the reader's are. An entry with a number out of range or with either text empty is left out, and so is a second
// entry for the same person: the caller says what is missing.
export type Retold = { details: string; look: string };
export function retoldOf(value: Record<string, unknown>, count: number): Map<number, Retold> {
  const text = (field: unknown) => typeof field === 'string' ? field.replace(/\s+/g, ' ').trim() : '';
  const retold = new Map<number, Retold>();
  for (const one of Array.isArray(value.retold) ? value.retold : []) {
    const { person, details, look } = (one ?? {}) as { person?: unknown; details?: unknown; look?: unknown };
    const index = typeof person === 'number' && Number.isInteger(person) ? person - 1 : -1;
    if (index < 0 || index >= count || retold.has(index) || !text(details) || !text(look)) continue;
    retold.set(index, { details: text(details), look: text(look) });
  }
  return retold;
}
// Whether a retold person is in words alone, as the owner asked (2026-09-26): a digit or a table's bar in the details or
// the look refuses that person, since the image model draws a number as lettering.
export const inWords = (retold: Retold) => !/[\d|]/.test(`${retold.details} ${retold.look}`);
