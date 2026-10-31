// What each person has on them, thing by thing and from scene to scene, for the readers of SIMPLE_CHAT_WEAR_USERS, on
// the owner's word of 2026-10-31 to bring the clothes probe of that day into the bot
// (docs/knowledge/clothes-state-2026-10-31.md). A frame used to write a person's line of clothes anew from the line
// before it, and what the line lost was lost for every frame after it. Here a frame's first answer is `wear`, a whole
// snapshot of the things of each person who was in the scenes since their record: on, partly on or off, with a free
// phrase for how each one sits and what became of it, as long as it has to be. Code keeps the snapshot beside the
// scene (lib/library.ts `SceneNode.wear`) and makes the line from it, which `clothes` then holds as it always did: the
// picture, the next frame's start, G and the reader's card all read that line and know nothing of what it is made of.
// A snapshot is whole so that a change of everything is no harder than a change of one thing, and what was taken off
// stays with its phrase, so that a torn shirt put back on is still torn.
//
// All of this is added at the call, as local/picture-clothes.ts adds its own: local/illustrate.ts stays as it is, since
// the action experiment pins what its request builders return (local/action-text.ts `textPins`).
import { matchSheet } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import { clothesRequest } from './picture-clothes.ts';
import type { ModelRequest } from './model.ts';
import type { Story, Worn, WornThing } from '../lib/library.ts';

// The answer's own limit on the things of a person.
const MOST_THINGS = 16;
// A thing taken off stays until the answer says it is gone, which takes it out of what follows and leaves it in the
// scenes before, each with its own snapshot, as `git rm` leaves a file in the commits before. Clothes left at home have
// nothing that ends them, and every frame's request reads the list: without an end a long story would pay for each
// change of clothes it ever had. The newest stay.
const MOST_OFF = 12;
// The room a snapshot takes on top of the frame's own answer, and the end of a runaway in JSON mode: the probe's answers
// took 775 tokens on average against 297 without it, and 998 against 437 in a lean frame.
const WEAR_TOKENS = 1600;

const str = { type: 'string' };
const ITEM = { type: 'object', additionalProperties: false, required: ['item', 'worn', 'how'],
  properties: { item: str, worn: { type: 'string', enum: ['on', 'partly', 'off', 'gone'] }, how: str } };
// `things` comes last in a person's record: with a field after it, an empty list left JSON mode running into blanks until
// the output limit, on the same requests each time.
const WEAR = { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['who', 'happened', 'body', 'things'],
  properties: { who: str, happened: str, body: str, things: { type: 'array', maxItems: MOST_THINGS, items: ITEM } } } };

const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const bare = (value: string) => value.toLowerCase().replace(/^(?:a|an|the|some)\s+/, '').trim();
const words = (name: string) => bare(name).split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
const singular = (word: string) => word.replace(/s$/, '');

// The things of a line. A sheet's is a garment after a garment in English, and all 21 of the probe's came apart right
// here; the model left two things of one line joined whatever it was told. One this module wrote, kept as the reader
// changed it, has a stretch between semicolons for each thing, which holds commas of its own.
export function thingsOf(line: string): WornThing[] {
  const worn = line.replace(/^wearing\s+/i, '');
  const names = worn.includes(';') ? worn.split(';') : worn.split(/,\s+(?:and\s+)?|\s+over\s+|\s+tucked into\s+|\s+with\s+|\s+and\s+/);
  return names.map(text).filter(Boolean).slice(0, MOST_THINGS).map(name => ({ name, how: '' }));
}

// A thing and its phrase as the line says them: a phrase that says the thing anew, with its name in it, stands for it, and
// one that only repeats it as its subject starts after it. One thing is one stretch between semicolons.
function phrase(thing: WornThing) {
  const how = thing.how.replace(/;/g, ',');
  if (!how) return thing.name;
  const name = words(thing.name);
  const subject = how.match(/^(?:the|its|this)\s+(.+?)\s+(?:is|are|has|have|was|were)\s+/i);
  const said = words(subject?.[1] ?? '');
  if (said.length && said.slice(0, -1).every(word => name.includes(word)) && singular(said.at(-1)!) === singular(name.at(-1) ?? '')) return `${thing.name}, ${how.slice(subject![0].length)}`;
  return /^(?:a|an|some)\s/i.test(how) && ` ${words(how).slice(0, 14).join(' ')} `.includes(` ${name.join(' ')} `) ? how : `${thing.name}, ${how}`;
}

// The line a snapshot makes. Somebody with nothing on has that as their one thing (`commit`).
export const wearLine = (worn: Worn) => [`wearing ${worn.on.map(phrase).join('; ')}`, worn.body].filter(Boolean).join('; ');

// What each person of `sheet` has at `nodeId`, for a frame there, and `scenes`, how far up their line is, or every scene
// of this line of the story when none was written. `sheet` is as local/picture.ts `wornAt` dressed it, so the line in
// force is `outfit`, and the nearest snapshot up the story's own line holds as long as it makes that line. A scene whose
// frame changed nothing keeps the line and needs no snapshot of its own; any other line is the reader's, or from before
// this reader had snapshots, and starts over from its own words.
export type Held = Map<string, Worn & { scenes: number }>;
export function wearAt(story: Pick<Story, 'nodes'>, nodeId: string, sheet: Character[]): Held {
  const written = new Map<string, number>();
  const snapshots = new Map<string, Worn>();
  const seen = new Set<string>();
  for (let id: string | null = nodeId; id && !seen.has(id); id = story.nodes[id]?.parent ?? null) {
    const node = story.nodes[id];
    for (const { name } of sheet) {
      if (!written.has(name) && node?.clothes && Object.hasOwn(node.clothes, name) && node.clothes[name]?.trim()) written.set(name, seen.size);
      if (!snapshots.has(name) && node?.wear && Object.hasOwn(node.wear, name)) snapshots.set(name, node.wear[name]);
    }
    seen.add(id);
  }
  return new Map(sheet.map(({ name, outfit }) => {
    const line = outfit?.trim() ?? '';
    const worn = snapshots.get(name);
    return [name, { ...worn && wearLine(worn) === line ? worn : { on: thingsOf(line), off: [], body: '' }, scenes: written.get(name) ?? seen.size }];
  }));
}

const shown = (thing: WornThing) => `    - ${thing.name}${thing.how ? `: ${thing.how}` : ''}`;
const person = (name: string, worn: Worn & { scenes: number }) => `  - ${name} (записано сцен назад: ${worn.scenes}):
    надето, верхнее первым:
${worn.on.map(shown).join('\n')}${worn.off.length ? `\n    снято:\n${worn.off.map(shown).join('\n')}` : ''}${worn.body ? `\n    на теле: ${worn.body}` : ''}`;
const FREE = 'Пиши свободно, своими словами и столько, сколько нужно, чтобы художник, который не читал историю, увидел это как есть. Не своди вещь к одному слову: вместо open скажи, как именно и насколько, вместо torn где, чем и что от этого стало. Говори то, что видно: из чего вещь и какого покроя, что поверх чего, как она сидит и держится, где сбилась, сползла, перекосилась, смялась, где натянулась, облегает или висит, что на ней и где, как это выглядит сейчас. Вот как это звучит: a long tan raincoat buttoned one hole off, so that the left hem hangs a hand lower than the right and the collar stands up on one side only, a dark rain line across the shoulders. О чём история молчит, можешь дополнить, если это с ней не спорит.';
function block(sheet: Character[], held: Held) {
  const listed = sheet.filter(one => one.outfit?.trim());
  const unlisted = sheet.filter(one => !one.outfit?.trim()).map(one => one.name);
  return `
- Вещи людей из списка, как они записаны:
${listed.map(one => person(one.name, held.get(one.name)!)).join('\n')}
- wear: заполни ПЕРВЫМ, раньше всех остальных полей. Ты костюмер фильма: кроме тебя никто не следит за тем, что стало с одеждой и телом людей от сцены к сцене, а на картинке видно всё. По одной записи на каждого человека из списка, кто появлялся в сценах после своей записи, даже если в этот кадр он не попадёт; кого там не было, того не пиши.
  who — имя из списка.
  happened — по-русски, одной короткой фразой: что случилось с его одеждой и телом после записи, написано это прямо или только следует из написанного. Спроси себя, что должно было произойти, чтобы написанное стало возможным, и что от этого осталось на виду: пролез под колючей проволокой, значит, на спине куртки дыра, а на коленях грязь; всю ночь красил забор, значит, краска на руках и рукавах; таскал мешки с цементом, значит, серая пыль на плечах и груди. Считай только то, что почти неизбежно следует из написанного: человек споткнулся и устоял, рядом что-то упало, он сел на чистую скамейку, и с ним ничего не случилось. Если ничего не случилось, пустая строка.
  body — по-английски, свободно: всё, что видно на самом теле и пройдёт не сразу (повязка, шина, кровь, грязь, мокрые волосы). Пустая строка, если на теле ничего такого нет.
  things — все его вещи к концу последней сцены, каждая отдельной записью: сначала надетое, верхнее первым, потом снятое в этих сценах. Это полный снимок, а не правка: пройди его вещи по очереди и про каждую спроси себя, на нём ли она ещё и что с ней. Чего нет в записи, а на нём есть (надел чужое, выдали новое, пришёл в другой одежде), добавь. Если он переоделся целиком, здесь только то, что на нём теперь, а прежнего не пиши. Пустой список, если happened пуст.
    item — название вещи из записи слово в слово, новую пиши её английским названием с артиклем.
    worn — on, если вещь на нём как положено. partly, если на нём только отчасти: надета наполовину, спущена, от пары осталась одна. off, если на нём её совсем нет: снята, сброшена, отдана или потеряна. Снятую пиши отдельной записью, а в how где она теперь. gone, если вещи больше нет и она уже не вернётся: сгорела, изрезана в клочья, выброшена; так же запиши и вещь из его снятого, когда с ней покончено, и программа вычеркнет её. Если на нём совсем ничего нет, добавь к снятому запись с item nothing и worn on: без неё программа решит, что он во что-то одет.
    how — по-английски: как эта вещь сидит на нём сейчас и что с ней стало. ${FREE} Без имён людей. Начинай сразу с описания, название вещи программа поставит сама перед ним: не пиши a long tan raincoat, the raincoat is buttoned one hole off, пиши buttoned one hole off. Если про эту вещь что-то сказано в этих сценах или что-то следует из них, how обязателен: напиши её заново всю, с тем, что на ней было и осталось, и с новым. Что вернули, надели обратно, починили, того больше нет: так и пиши. Пустая строка только у той вещи, про которую ничего не сказано и с которой ничего не случилось: программа сохранит её описание как было.
  Что случилось, то держится, пока этому не придёт конец, и конец тоже бывает сказан прямо или только следует из написанного. Сравни дату и время в начале сцен. В тот же день, пока человеку негде было привести себя в порядок, всё остаётся как есть: порванное порвано, мокрое мокро, снятое снято, надетое наполовину так и надето, если он не поправил его сам. Но движение кончается раньше следа: что текло, капало и стекало, через четверть часа уже не течёт, и в записи остаётся след, а не движение. Если настал другой день или прошло столько времени, что человек успел вымыться, переодеться, зашить или сменить вещь, подлечиться, и теперь занят своим обычным делом или пришёл туда, куда так не ходят, happened говорит об этом, а things пишет его таким, какой он сейчас. Если история не говорит, во что он одет, одень его так, как он оделся бы сам для этой сцены, и не неси из прошлого то, что к ней не подходит.
  clothes в people: для людей из списка пустая строка, программа соберёт её из вещей. Для остальных как обычно.${unlisted.length ? ` Вещи этих людей ещё не записаны, им пиши clothes как обычно: ${unlisted.join(', ')}.` : ''}`;
}

const HEAD = '\n- Одежда людей из списка до этой сцены:';
function withBlock(instruction: string, rules: string) {
  const at = instruction.indexOf(HEAD);
  if (at < 0) return `${instruction}${rules}`;
  const end = instruction.indexOf('\n- ', at + HEAD.length);
  return `${instruction.slice(0, at)}${rules}${end < 0 ? '' : instruction.slice(end)}`;
}
// The sentences of the frames' and G's rules that change with a snapshot, what they become, each as the probe had it. One
// that no longer stands there is left as it is: a request a word worse is no reason to lose a picture.
export const FRAME_SWAPS: [string, string][] = [['state — то, что сейчас с ним и видно глазу, кроме одежды: повязки, шины, что держит, что в ножнах; пустая строка, если нечего.',
  'state — что держит, что в ножнах; повязки, шины, кровь и грязь уже в clothes; пустая строка, если нечего.']];
export const LEAN_SWAPS: [string, string][] = [
  ['- clothes_as_before: false для того, кого нет в списке одежды до этой сцены, и для всех, если такого списка нет; когда true, смотри ниже. clothes — во что', '- clothes — во что'],
  ['повязки, шины и оружие в ножнах тоже здесь', 'оружие в ножнах тоже здесь, а повязки, шины, кровь и грязь уже в clothes'],
  ['viewer_clothes_as_before — false, viewer_clothes, viewer и reflection — пустые строки.', 'viewer_clothes, viewer и reflection — пустые строки.'],
  ['viewer_clothes_as_before — по правилу clothes_as_before выше, по его строке в списке одежды до этой сцены; при true программа сама возьмёт ту строку. viewer_clothes — во что он одет, фразой, которая начинается с wearing, по правилам одежды выше.',
    'viewer_clothes — пустая строка, программа соберёт её из вещей.'],
];
const UNLISTED_VIEWER: [string, string][] = [...LEAN_SWAPS.slice(0, -1), [LEAN_SWAPS.at(-1)![0], 'viewer_clothes — во что он одет, фразой, которая начинается с wearing.']];
export const G_SWAPS: [string, string][] = [['- Одежда людей из списка до этой сцены:', '- Одежда людей из списка в этой сцене:'],
  ['Если история с тех пор переодела человека, раздела его, одела во что-то новое, испачкала или порвала одежду, в запросе опиши одежду такой, какая она сейчас. Если нет — повтори его строку отсюда слово в слово.',
    'Повтори строку каждого отсюда слово в слово, не меняй её и не дополняй.']];
const swapped = (content: string, swaps: [string, string][]) => swaps.reduce((one, [from, to]) => one.replace(from, () => to), content);

// `request` with the snapshot's rules in the place of the rule on clothes, and `wear` the first field of the answer, the
// lasting changes after it: a frame with a viewer is lean (local/picture-lean.ts), and its `clothes_as_before` goes,
// since nothing is repeated any more, while a viewer with no line yet still writes what they wear. A frame without one
// takes local/picture-clothes.ts's sentence on what is bare, which is still the rule for people outside the sheet.
// `sheet` has somebody with a line (local/picture.ts `describeFrame`).
export function wearRequest(request: ModelRequest, sheet: Character[], held: Held, viewer?: Character): ModelRequest {
  const base = viewer ? request : clothesRequest(request);
  type Schema = { required: string[]; properties: Record<string, unknown> };
  const schema = structuredClone(base.outputSchema) as Schema & { properties: { people: { items: Schema } } };
  if (viewer) {
    const item = schema.properties.people.items;
    delete item.properties.clothes_as_before;
    item.required = item.required.filter(one => one !== 'clothes_as_before');
    delete schema.properties.viewer_clothes_as_before;
    schema.required = schema.required.filter(one => one !== 'viewer_clothes_as_before');
  }
  const last = base.messages.at(-1)!;
  return { ...base, maxOutputTokens: base.maxOutputTokens + WEAR_TOKENS,
    messages: [...base.messages.slice(0, -1), { ...last, content: swapped(withBlock(last.content, block(sheet, held)), viewer?.outfit?.trim() ? LEAN_SWAPS : viewer ? UNLISTED_VIEWER : FRAME_SWAPS) }],
    outputSchema: { ...schema, required: ['wear', ...schema.required], properties: { wear: WEAR, ...schema.properties } } };
}

// G's request reads each person's line of this frame as it stands and only repeats it.
export function wearG(request: ModelRequest): ModelRequest {
  const last = request.messages.at(-1)!;
  return { ...request, messages: [...request.messages.slice(0, -1), { ...last, content: swapped(last.content, G_SWAPS) }] };
}

const NOTHING = 'nothing';
const isNothing = (thing: WornThing) => bare(thing.name) === NOTHING;
// One person's record of the answer on what they have: what it names, in its order, under the name it had, with its old
// phrase where it wrote none, and what it leaves out of what they had goes off, since a person who changed altogether
// is told to name only what is on them now. A name is the same name word for word or with a phrase of its own after a
// colon or a comma, as 2 of the 643 things of the probe had it: anything else is a new thing, since a dress shirt is no
// dress, and the 594 that kept a thing kept its name. A thing that goes back on with no word of it is as it was on
// them, not where it lay: the probe had trousers on a man and in his locker. A record with nothing on it says nothing
// of what they wear: somebody out of the frame who went home and «changed», in both runs of one scene of the probe,
// with no word of into what. Such a record is no record, since a line of «wearing nothing» would draw them so. Nothing
// on is said outright, as a thing of its own, and only so. A thing it calls gone leaves the list.
function commit(worn: Worn, record: Record<string, unknown>): Worn | undefined {
  const had = [...worn.on, ...worn.off];
  const on: WornThing[] = [], off: WornThing[] = [], gone: string[] = [];
  for (const entry of (record.things as unknown[]).slice(0, MOST_THINGS)) {
    const { item, worn: state, how } = (entry ?? {}) as Record<string, unknown>;
    const label = text(item), short = label.split(/[:,]/)[0];
    const old = had.find(thing => bare(thing.name) === bare(label)) ?? had.find(thing => bare(thing.name) === bare(short));
    const name = old?.name ?? label, wore = old?.wore ?? old?.how ?? '';
    if (!/[\p{L}\p{N}]/u.test(name) || bare(name) === NOTHING && state !== 'on' || gone.includes(name) || [...on, ...off].some(thing => thing.name === name)) continue;
    if (state === 'gone') gone.push(name);
    else if (state === 'off') off.push({ name, how: text(how) || old?.how || '', wore });
    else on.push({ name, how: text(how) || wore });
  }
  if (!on.length) return undefined;
  const dressed = on.filter(thing => !isNothing(thing));
  const named = [...on, ...off].map(thing => thing.name).concat(gone);
  return { on: dressed.length ? dressed : on, off: [...off, ...had.filter(thing => !isNothing(thing) && !named.includes(thing.name))].slice(0, MOST_OFF), body: text(record.body) };
}

// How many things are new on somebody while somebody else had them and has them still. That may be a thing in the wrong
// list: the model goes by who did the seizing, and in a tale of the probe the man who pulled at another's brace came away
// with it in his own, snapped. It may as well be their own of the same name, a blanket, a hospital gown, and nothing in
// the answer tells which, so that moving it could take a person's own thing from them. It is counted, for the log.
function crossedThings(written: Map<string, Worn>, held: Held, names: string[]) {
  const same = (thing: WornThing) => (other: WornThing) => bare(other.name) === bare(thing.name);
  return [...written].reduce((count, [name, worn]) => {
    const { on, off } = held.get(name)!;
    return count + worn.on.filter(thing => !isNothing(thing) && ![...on, ...off].some(same(thing)) && names.some(other => other !== name
      && held.get(other)!.on.some(same(thing)) && (written.get(other) ?? held.get(other)!).on.some(same(thing)))).length;
  }, 0);
}

// The answer's `wear` as the frame keeps it: `lines` for each person of the sheet who has one, as the picture, G and the
// next frame read it; `worn`, the snapshot of each person it changed; and `crossedThings`. A person with no record, or
// none of what they have, keeps their line word for word.
export type SettledWear = { lines: Record<string, string>; worn: Record<string, Worn>; crossed: number };
export function settleWear(answer: unknown, sheet: Character[], held: Held): SettledWear {
  const names = sheet.map(one => one.name);
  const answered = new Set<string>();
  const written = new Map<string, Worn>();
  for (const one of Array.isArray(answer) ? answer : []) {
    const record = (one ?? {}) as Record<string, unknown>;
    const name = matchSheet(text(record.who), names);
    if (name === null || answered.has(name)) continue;
    answered.add(name);
    const next = Array.isArray(record.things) && record.things.length ? commit(held.get(name)!, record) : undefined;
    if (next) written.set(name, next);
  }
  const crossed = crossedThings(written, held, names);
  const lines = Object.fromEntries(sheet.flatMap(({ name, outfit }) => {
    const line = written.has(name) ? wearLine(written.get(name)!) : outfit?.trim() ?? '';
    return line ? [[name, line]] : [];
  }));
  return { lines, worn: Object.fromEntries(written), crossed };
}

// A frame with each person of the sheet in their line; `viewer`, seen through, likewise. A person with no line yet has
// what the frame wrote for them, and is recorded from it as anybody is (local/picture.ts `clothesOf`).
export function wornFrame<T extends Description>(frame: T, settled: SettledWear, sheet: Character[], viewer?: Character): T {
  const names = sheet.map(one => one.name);
  const people = Array.isArray(frame.people) ? frame.people.map(one => {
    const name = matchSheet(text(one?.who), names);
    return name !== null && settled.lines[name] ? { ...one, clothes: settled.lines[name] } : one;
  }) : frame.people;
  const { eyes } = frame as { eyes?: { clothes: string } };
  return { ...frame, people, ...viewer && eyes ? { eyes: { ...eyes, clothes: settled.lines[viewer.name] ?? eyes.clothes } } : {} };
}

// The sheet G reads: each person in their line of this frame.
export const wornSheet = (sheet: Character[], settled: SettledWear) => sheet.map(one => ({ ...one, outfit: settled.lines[one.name] ?? one.outfit }));
