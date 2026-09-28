// What each person of a frame wears and what of them is bare, for the readers of SIMPLE_CHAT_CLOTHES_USERS: the tester's
// complaint of 2026-09-28 («если персонаж голый, то он и должен быть голым, если он в одежде, то он и должен быть в
// одежде, а не в бодди из референса»). Two things change, both at the call, never in local/illustrate.ts, whose request
// builders the action experiment pins by hash (local/action-text.ts `textPins`):
//   - the frame's rule for `clothes` takes the words of that experiment's change 8 (local/action-text.ts), which name
//     bare skin outright, in place of its own sentence; the schema does not change;
//   - a frame with reference pictures says what each referenced person wears before it says what the pictures are for
//     (local/picture-references.ts `referencePrompt`), so that the image model reads the scene's clothes before the
//     portrait in its dark grey suit, where today they come only in the person's clause after the look.
import { matchSheet, stripAges, stripNames } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { ModelRequest } from './model.ts';

// The bot's sentence for `clothes` (local/illustrate.ts), and change 8's for it, word for word.
const OWN = 'clothes — во что он одет В ЭТОТ МОМЕНТ, по-английски, фразой, которая начинается с wearing.';
const BARE = `${OWN} Открытое тело называй прямо: если торс, ноги или ступни ничем не закрыты, так и напиши ("wearing only rolled-up linen trousers, bare-chested and barefoot"). Не открывай того, что сцена не открывает.`;

// The frame's request with change 8's sentence in place of the bot's, or after the instruction should the bot's ever not
// stand in it exactly once.
export function clothesRequest(request: ModelRequest): ModelRequest {
  const last = request.messages.at(-1)!;
  const at = last.content.indexOf(OWN);
  const content = at >= 0 && last.content.indexOf(OWN, at + 1) < 0 ? last.content.slice(0, at) + BARE + last.content.slice(at + OWN.length)
    : `${last.content}\n- ${BARE}`;
  return { ...request, messages: [...request.messages.slice(0, -1), { ...last, content }] };
}

const phrase = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();

// The sentences that go before the reference wording: each person of the frame bound to a picture, in the order of the
// pictures, in the clothes the assembly gives them (the frame's, or the sheet's outfit where the frame left them none),
// through the same nets for names and ages. `stated` counts them and `namesStripped` what the nets cut. Empty when
// nobody bound is in the frame.
export function clothesStatement(frame: { description: Description; sheet: Character[] }, bound: { name: string }[]) {
  const people = frame.description.people ?? [];
  const sheetNames = frame.sheet.map(one => one.name);
  // The assembly's strangers: a `who` of one capitalised word that is nobody of the sheet is a name.
  const strangers = people.map(person => (person.who ?? '').trim())
    .filter(who => who.length > 1 && !/\s/.test(who) && /^\p{Lu}/u.test(who) && matchSheet(who, sheetNames) === null);
  const names = [...new Set([...sheetNames, ...bound.map(one => one.name), ...strangers])];
  let namesStripped = 0;
  const clean = (text: string) => {
    const stripped = stripNames(stripAges(text ?? ''), names);
    namesStripped += stripped.removed;
    return phrase(stripped.text);
  };
  const lines = bound.flatMap((one, slot) => {
    const person = people.find(other => matchSheet(other.who ?? '', names) === one.name);
    const clothes = person ? clean(person.clothes ?? '') || clean(frame.sheet.find(other => other.name === one.name)?.outfit ?? '') : '';
    return clothes ? [`The person from image ${slot + 1} in this scene: ${clothes}. `] : [];
  });
  return { text: lines.join(''), stated: lines.length, namesStripped };
}
