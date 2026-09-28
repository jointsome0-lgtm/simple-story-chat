// The frames of a story seen through one person's own eyes (the owner, 2026-09-27: «я бы не делал такое ограничение, а
// просто то что он может увидеть глазами, это же реальный POV»; docs/telegram-ui.md#seen-through-their-eyes). The
// reader picks the person on their card (`Story.pov`), and a frame of a scene they are in then shows what they see
// from where they stand, given their pose and where they look: whatever of their own body falls into view, their
// clothes and what they hold, their shadow, and their reflection in a mirror, water or glass. They are never drawn
// whole from outside. In a scene without them the frame is described and drawn as usual.
//
// local/illustrate.ts is left as it is: the action experiment pins what its request builders return by hash
// (local/action-text.ts `textPins`), and with the mode off every request, prompt, graph and recipe is what it was. So
// the rule and the viewer's fields are added to the frame's request here, and the answer is turned back into an
// ordinary description before the assembly: the viewer leaves `people`, which also keeps their kept portrait out of
// the reference experiment's inputs (it would pull their whole figure into the frame), and a first-person clause opens
// the prompt, through `shot`, the field the assembly puts first: the camera, then only what of their body is in view
// and their reflection, and never their look.
import type { Story } from '../lib/library.ts';
import { matchSheet } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { ModelRequest } from './model.ts';

// The person of a frame's sheet the story is seen through, or undefined: the mode is off, or that person has no look
// on the sheet (not retold yet, or no longer on it), and the frame is then described as usual. `sheet` is the frame's,
// its people in the clothes they start it in (local/picture.ts `wornAt`). Names are compared as the sheet compares
// them, apart from spaces and case.
export function viewerOf(story: Story | undefined, sheet: Character[]): Character | undefined {
  return sheet.find(one => seesThrough(story, one.name));
}
// Whether the story is seen through the eyes of the person of the sheet named `name` (the characters' card, local/ui.ts).
export const seesThrough = (story: Story | undefined, name: string) =>
  typeof story?.pov === 'string' && !!story.pov.trim() && story.pov.trim().toLowerCase() === name.trim().toLowerCase();

// Room for the four fields the answer gains, about 150 tokens as the instruction asks for them, and a margin.
const POV_TOKENS = 250;
// Room for each person's place and how much of them is in view (`PLACE`): about 30 tokens a person, four at most.
const PLACE_TOKENS = 150;

// The rule, appended to the frame's instruction in its language. The viewer is named once and called «смотрящий»
// after that, a masculine noun whatever the person is, so that no Russian case ending of their name is needed. The
// last scene is named by its first words: without them the hosted Gemma 4 31B described the scene before a cutaway
// without the viewer, the one with them, in two answers of two (2026-09-27). The viewer is the camera and never a
// person of the answer: the first version called them "the viewer" in the moment and the props and gave their whole
// look, and on the card Qwen drew the usual scene with one more person in it (the tester, 2026-09-27: «как будто
// добавляется еще один человек с руками»).
const rule = (name: string, opening: string) => `
Кадр от первого лица. Смотрящий — ${name}: если он есть в последней сцене, кадр снят его глазами. Камера стоит на месте его глаз и показывает то, что он видит в этот момент со своего места, при своей позе и туда, куда смотрит.
- Последняя сцена — последний ответ рассказчика${opening ? `, тот, что начинается словами «${opening}…»` : ''}. Кадр всегда из неё, даже если смотрящего в ней нет: не бери ради него сцену раньше.
- viewer_in_scene: true, если смотрящий есть в последней сцене, иначе false. При false опиши кадр как обычно, по правилам выше, а viewer_clothes, viewer и reflection оставь пустыми строками. Всё, что ниже, — для true.
- Смотрящий в кадре не человек, а камера. Его нет в people, и нигде в ответе нет ни его имени, ни слов о нём как о человеке (the viewer, a woman, a man, he, she, they). Его действия в moment, props и objects — только через видимые части его тела: "hands at the bottom of the frame hold the lantern", а не "she holds the lantern". Кто смотрит на него или протягивает ему что-то, делает это toward the camera.
- shot: вид от первого лица с высоты его глаз и куда направлен взгляд ("first-person view at eye level, looking down at the workbench").
- viewer: по-английски: только те части его собственного тела, которые он сам видит при этой позе и этом взгляде, так, как он их видит: обрезанные краем кадра и в перспективе. Кисти и предплечья, колени и ноги, грудь или живот, если взгляд опущен; на них только их одежда (рукава, штанины, обувь) и то, что он держит; кожа того цвета, что во внешности; его тень на полу или стене. Например: "hands and forearms enter from the bottom edge of the frame, foreshortened, in the cuffs of a navy wool sweater, the right hand holding a lit lantern". Лицо, волосы, фигуру и возраст здесь не описывай. Пустая строка, если ничего из этого не видно.
- reflection: по-английски: его отражение, если перед его глазами зеркало, вода или стекло, где оно в кадре и что оно делает ("in the mirror straight ahead, the reflection wipes soot off its cheek with a sleeve"); иначе пустая строка.
- viewer_clothes: во что смотрящий одет в этот момент, фразой, которая начинается с wearing, по тому же правилу, что clothes у людей из списка.`;

// Where each person of the frame is against the camera, for a reader of SIMPLE_CHAT_POV_PLACE_USERS: the tester's
// complaint of 2026-09-28, two girls pressed against the viewer from both sides drawn standing in front of them («а мы
// по сути лишь их часть должны видеть боковым зрением»). The rule above says what the camera shows and not where the
// others stand, so a person beside the viewer was drawn where people usually are, facing the camera. `place` says the
// side, the distance and what of the person is in view and cut by the frame's edge, and `in_view` whether it is only a
// part, which local/picture.ts reads to leave that person's portrait out of the references for a reader of
// SIMPLE_CHAT_POV_PARTIAL_USERS. Both come right after `who`: a field added last to a person ran away into whitespace
// on the card's Gemma in 42 answers of 124 on 2026-09-28, and in none of 124 right after `who`.
const PLACE = `
- place — поле каждой записи people, сразу после who: по-английски, где этот человек в этот момент относительно камеры и что из него видно: с какой стороны кадра (at the left edge, at the right edge, in the middle), как близко (pressed against the camera's side, within arm's reach, a few steps away, far off) и какие его части в кадре, а какие обрезаны краем кадра ("pressed close at the left edge of the frame, only her shoulder, arm and the side of her face in view, the rest cut off by the frame's edge"). Кто прижался к смотрящему или сидит вплотную к нему сбоку, идёт рядом, стоит у него за плечом или наклоняется к нему сзади, тот не перед камерой, а у края кадра со своей стороны и виден только частью, как краем глаза; в середине кадра только тот, кто и правда перед смотрящим. Кого с этого места не видно совсем, потому что он целиком за спиной смотрящего, в people не включай. Если смотрящего нет в последней сцене, place — пустая строка.
- in_view — поле каждой записи people, сразу после place: partly, если в кадре только часть этого человека у края кадра, а остальное за краем кадра или за камерой; whole, если в кадре его лицо и почти всё тело. Если смотрящего нет в последней сцене, whole.`;

// The frame's request as `frameRequest` built it, with the rule for `viewer` after its instruction and the schema with
// four more fields: whether the viewer is in the scene, first, so that the shot and the people are written knowing
// it, and what they wear, what of them is in view and their reflection after the people. With `place`, each person
// also gets `place` and `in_view` right after `who`, and the rule for them after the viewer's.
export function povRequest(request: ModelRequest, viewer: Character, place = false): ModelRequest {
  const schema = request.outputSchema as { required: string[]; properties: Record<string, unknown> };
  const last = request.messages.at(-1)!;
  // The scene is the narrator's message before the instruction, and its date line is not its words.
  const scene = request.messages.at(-2)?.role === 'assistant' ? request.messages.at(-2)!.content : '';
  const opening = scene.replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s*/, '').split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
  return { ...request, maxOutputTokens: request.maxOutputTokens + POV_TOKENS + (place ? PLACE_TOKENS : 0),
    outputSchema: { ...schema, required: ['viewer_in_scene', ...schema.required, 'viewer_clothes', 'viewer', 'reflection'],
      // `people` keeps its place among the fields: a key given again stays where it first stood.
      properties: { viewer_in_scene: { type: 'boolean' }, ...schema.properties, ...place ? { people: withPlaces(schema.properties.people as People) } : {},
        viewer_clothes: { type: 'string' }, viewer: { type: 'string' }, reflection: { type: 'string' } } },
    messages: [...request.messages.slice(0, -1), { ...last, content: last.content + rule(viewer.name, opening) + (place ? PLACE : '') }] };
}
type People = { items: { required: string[]; properties: Record<string, unknown> } };
// The people's schema with `place` and `in_view` right after `who`.
const withPlaces = (people: People) => {
  const { who, ...rest } = people.items.properties;
  return { ...people, items: { ...people.items, required: ['who', 'place', 'in_view', ...people.items.required.filter(key => key !== 'who')],
    properties: { who, place: { type: 'string' }, in_view: { type: 'string', enum: ['whole', 'partly'] }, ...rest } } };
};
// Whether a person of a frame is only partly in view, by the answer's `in_view`; anything else keeps their reference.
export const partlyInView = (person: object) => (person as { in_view?: unknown }).in_view === 'partly';

const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const part = (value: string) => value.trim().replace(/\.$/, '').trim();
// A model that still calls the viewer "the viewer": their hands are the hands, and they themselves the camera.
const unnamed = (value: string) => value.replace(/\b(t)he viewer's (?:own )?/gi, '$1he ').replace(/\b(t)he viewer\b/gi, '$1he camera');
const sentence = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
type Person = Description['people'][number];
type Placed = Person & { place?: unknown; in_view?: unknown };

// The answer to `povRequest` as an ordinary description. `seen` when the viewer is in the scene, by the answer's word
// or by being among its people anyway: then `description` has them out of `people` and a first-person clause in place
// of the shot. The clause puts the camera first in positive words and then only what of their body is in view, cut
// by the frame's edge, with the clothes on those parts, and their reflection as the answer words it. Their look from
// the sheet is left out even for a reflection: on the card it drew the viewer whole beside the water in two pictures
// of two (docs/telegram-ui.md#seen-through-their-eyes). Every field of the answer loses the words "the viewer", and
// the clause passes the assembly's nets for names and ages like every field. `dressed` is what the clothes are read
// from for the next picture (local/picture.ts `clothesOf`): the viewer in what the answer says they wear. An answer
// that says they are not there comes back as the plain description it holds. With `place` (`povRequest`), each other
// person's place against the camera opens their state, which the assembly puts after their look and clothes and before
// their action, and `in_view` stays on them for the references; `placed` counts those with a place. In a frame without
// the viewer both fields leave the people, and it is an ordinary frame.
export function seenBy(answer: Description, viewer: Character, sheet: Character[], place = false):
  { description: Description; dressed: Description; seen: boolean; placed: number } {
  const { viewer_in_scene: present, viewer_clothes: worn, viewer: body, reflection: mirrored, ...plain } = answer as Description
    & { viewer_in_scene?: unknown; viewer_clothes?: unknown; viewer?: unknown; reflection?: unknown };
  const names = sheet.map(one => one.name);
  const people = Array.isArray(plain.people) ? plain.people : [];
  // The rule tells the model to leave them out, and a model that lists them anyway may do it under "the viewer".
  const own = (person: Person) => matchSheet(person?.who ?? '', names) === viewer.name || /^(?:the )?viewer$/i.test(text(person?.who));
  const seen = present === true || people.some(own);
  if (!seen) {
    const usual = place && Array.isArray(plain.people) ? { ...plain, people: people.map(({ place: _, in_view: __, ...one }: Placed) => one) } : plain;
    return { description: usual, dressed: usual, seen, placed: 0 };
  }
  const others = people.filter(one => !own(one)).map(place
    ? ({ place: where, ...one }: Placed) => ({ ...one, state: [unnamed(text(where)), unnamed(text(one.state))].map(part).filter(Boolean).join(', '),
      action: unnamed(text(one.action)) })
    : one => ({ ...one, state: unnamed(text(one.state)), action: unnamed(text(one.action)) }));
  const placed = place ? people.filter(one => !own(one) && text((one as Placed).place)).length : 0;
  const clothes = text(worn) || text(people.find(own)?.clothes) || text(viewer.outfit);
  const visible = sentence(unnamed(text(body))), reflection = sentence(unnamed(text(mirrored)));
  const clause = [`First-person POV shot through the eyes, the camera at eye height: ${unnamed(text(plain.shot)) || 'looking ahead'}`, visible,
    reflection];
  const description = { ...plain, moment: unnamed(text(plain.moment)), props: unnamed(text(plain.props)), objects: unnamed(text(plain.objects)),
    people: others, shot: clause.map(part).filter(Boolean).join('. ') };
  return { description, dressed: { ...plain, people: [...others, { who: viewer.name, look: '', clothes, state: '', action: '' }] }, seen, placed };
}
