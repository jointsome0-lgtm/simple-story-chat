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
// the reference experiment's inputs (it would pull their whole figure into the frame), and a first-person clause with
// their look and clothes opens the prompt, through `shot`, the field the assembly puts first.
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

// Room for the three fields the answer gains, about 100 tokens as the instruction asks for them, and a margin.
const POV_TOKENS = 200;

// The rule, appended to the frame's instruction in its language. The viewer is named once and called «смотрящий»
// after that, a masculine noun whatever the person is, so that no Russian case ending of their name is needed. The
// last scene is named by its first words: without them the hosted Gemma 4 31B described the scene before a cutaway
// without the viewer, the one with them, in two answers of two (2026-09-27).
const rule = (name: string, opening: string) => `
Кадр от первого лица. Смотрящий — ${name}: если он есть в последней сцене, камера стоит на месте его глаз и показывает то, что он видит в этот момент со своего места, при своей позе и туда, куда смотрит.
- Последняя сцена — последний ответ рассказчика${opening ? `, тот, что начинается словами «${opening}…»` : ''}. Кадр всегда из неё, даже если смотрящего в ней нет: не бери ради него сцену раньше.
- viewer_in_scene: true, если смотрящий есть в последней сцене, иначе false. При false опиши кадр как обычно, по правилам выше, а viewer_clothes и viewer оставь пустыми строками. Всё, что ниже, — для true.
- Смотрящего нет в people, и он никогда не виден целиком со стороны: в people только те, кого он видит. В moment, props и objects называй его the viewer.
- shot: вид от первого лица, с высоты глаз смотрящего, и куда направлен взгляд ("first-person view at eye level, looking down at the workbench").
- viewer: по-английски, без имён: что из собственного тела смотрящего попадает в кадр при этой позе и этом взгляде — кисти и руки, ноги и колени, грудь или живот, если взгляд опущен, одежда на них, что он держит; его тень на полу или стене; его отражение в зеркале, воде или стекле, если оно у него перед глазами. У каждой части — её место в кадре ("the viewer's own hands grip the oars at the bottom of the frame"). Пустая строка, если ничего из этого не видно.
- viewer_clothes: во что смотрящий одет в этот момент, фразой, которая начинается с wearing, по тому же правилу, что clothes у людей из списка.`;

// The frame's request as `frameRequest` built it, with the rule for `viewer` after its instruction and the schema with
// three more fields: whether the viewer is in the scene, first, so that the shot and the people are written knowing
// it, and what they wear and what of them is in view after the people.
export function povRequest(request: ModelRequest, viewer: Character): ModelRequest {
  const schema = request.outputSchema as { required: string[]; properties: Record<string, unknown> };
  const last = request.messages.at(-1)!;
  // The scene is the narrator's message before the instruction, and its date line is not its words.
  const scene = request.messages.at(-2)?.role === 'assistant' ? request.messages.at(-2)!.content : '';
  const opening = scene.replace(/^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s*/, '').split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
  return { ...request, maxOutputTokens: request.maxOutputTokens + POV_TOKENS,
    outputSchema: { ...schema, required: ['viewer_in_scene', ...schema.required, 'viewer_clothes', 'viewer'],
      properties: { viewer_in_scene: { type: 'boolean' }, ...schema.properties, viewer_clothes: { type: 'string' }, viewer: { type: 'string' } } },
    messages: [...request.messages.slice(0, -1), { ...last, content: last.content + rule(viewer.name, opening) }] };
}

const text = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const part = (value: string) => value.trim().replace(/\.$/, '').trim();
type Person = Description['people'][number];

// The answer to `povRequest` as an ordinary description. `seen` when the viewer is in the scene, by the answer's word
// or by being among its people anyway: then `description` has them out of `people` and the first-person clause ahead
// of the shot. The clause says what of them is in view and gives their look from the sheet and their clothes, so that
// an arm or a belly matches their figure, and it passes the assembly's nets for names and ages like every field.
// `dressed` is what the clothes are read from for the next picture (local/picture.ts `clothesOf`): the viewer in what
// the answer says they wear. An answer that says they are not there comes back as the plain description it holds.
export function seenBy(answer: Description, viewer: Character, sheet: Character[]): { description: Description; dressed: Description; seen: boolean } {
  const { viewer_in_scene: present, viewer_clothes: worn, viewer: body, ...plain } = answer as Description
    & { viewer_in_scene?: unknown; viewer_clothes?: unknown; viewer?: unknown };
  const names = sheet.map(one => one.name);
  const people = Array.isArray(plain.people) ? plain.people : [];
  // The rule tells the model to call them the viewer, and a model that lists them anyway may do it under that word.
  const own = (person: Person) => matchSheet(person?.who ?? '', names) === viewer.name || /^(?:the )?viewer$/i.test(text(person?.who));
  const seen = present === true || people.some(own);
  if (!seen) return { description: plain, dressed: plain, seen };
  const others = people.filter(one => !own(one));
  const clothes = text(worn) || text(people.find(own)?.clothes) || text(viewer.outfit);
  const visible = text(body);
  const opening = visible
    ? ['First-person point of view: the picture shows what the viewer sees with their own eyes, and the viewer is never shown whole',
      `In view of the viewer's own body: ${visible}`, `The viewer's own body and clothes: ${[viewer.look, clothes].map(part).filter(Boolean).join(', ')}`]
    : ['First-person point of view: the picture shows what the viewer sees with their own eyes, and none of the viewer\'s own body is in view'];
  const description = { ...plain, people: others, shot: [...opening, text(plain.shot)].map(part).filter(Boolean).join('. ') };
  return { description, dressed: { ...plain, people: [...others, { who: viewer.name, look: '', clothes, state: '', action: '' }] }, seen };
}
