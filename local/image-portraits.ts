// The first half of the identity test (docs/illustrations-plan.md): one portrait per person of the synthetic
// stories, drawn on the card, and the file that binds those portraits to the frames they belong in.
//   `prompts`    turns the character sheets inside an illustrate-probe prompts directory into a prompts directory
//                of its own, one case per person, which local/image-batch.ts draws like any other.
//   `references` turns the run directory that came out of it into the `--references` file of the frame run.
// Nothing here talks to a model or to a card. The name on a sheet picks a portrait and never leaves this file: the
// prompt is assembled by the same `assemblePrompt` the frames use, which strips names and ages, and the case ids
// are numbered rather than named.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { assemblePrompt } from './illustrate.ts';
import type { Description } from './illustrate.ts';
import type { Case } from './illustrate-probe.ts';
import { latentSizeOf } from './image-batch.ts';
import type { BatchIndex, Graph, References } from './image-batch.ts';

// A reference portrait carries the whole person, the figure as well as the face, so that a frame need not describe
// the build every time: the owner's example is a man whose big muscles and barbarian menace should come from the
// picture (2026-09-24). This is the recipe the bot draws its portraits by (local/picture.ts), fixed before the
// identity run and pinned by it: the whole figure from the front, in plain close-fitting clothes of the bot's own
// that hide none of the build and follow the person into no scene, standing, with no expression put on them — a grim
// face is the look's to say — in a neutral style of its own, never a story's. `look` comes from the sheet through
// `assemblePrompt`, which strips names and ages here as in every frame, and these clothes stand where a frame would
// put the sheet's outfit. Two portraits of one look differ by the seed.
export const PORTRAIT_CLOTHES = 'wearing a plain close-fitting white tank top, close-fitting dark grey trousers and plain dark shoes';
export const PORTRAIT_STYLE = 'Neutral character reference illustration with natural colors, realistic proportions and clean even rendering, the build, silhouette and permanent marks clearly readable.';
export const PORTRAIT_ACTION = 'stands upright facing the viewer, arms relaxed at the sides';
export function portraitDescription(name: string): Description {
  return {
    shot: 'Full-length character reference, the whole body in frame, seen from the front',
    setting: 'A plain even grey backdrop, no scenery',
    moment: 'One person stands still to be looked at',
    objects: '', props: '', light: 'Even soft frontal light, no strong shadows',
    people: [{ who: name, look: '', clothes: PORTRAIT_CLOTHES, state: '', action: PORTRAIT_ACTION }],
  };
}
export const portraitPrompt = (name: string, look: string) =>
  assemblePrompt(portraitDescription(name), [{ name, look, outfit: '' }], PORTRAIT_STYLE);

// The canvas a portrait is drawn on: the text-to-image graph's own latent turned upright, the smaller side across. A
// standing figure in a wide frame gets a third of the pixels; the bot applies the same rule to its own graph.
export function portraitCanvas(graph: Graph): { width: number; height: number } {
  const size = latentSizeOf(graph);
  if (!size) throw new Error('The portrait graph has no latent size to turn upright');
  return { width: Math.min(size.width, size.height), height: Math.max(size.width, size.height) };
}

// One portrait case per person of every story in `cases`. The id carries the story and a number, never the name:
// it becomes a file name in the run directory and a key in a review bundle. A story is described once, so the
// first case of each story is the one its sheet is taken from.
export function portraitCases(cases: Case[]): Case[] {
  const stories = new Map<string, Case>();
  for (const one of cases) if (!stories.has(one.scenario)) stories.set(one.scenario, one);
  return [...stories.values()].flatMap(story => (story.sheet ?? []).map((character, order) => {
    return { id: `portrait-${story.scenario}-${order + 1}`, scenario: story.scenario, index: order + 1, scene: '',
      sheet: [character], description: portraitDescription(character.name), ...portraitPrompt(character.name, character.look) } satisfies Case;
  }));
}

// The `--references` file of the frame run: story, then sheet name, then the portrait's path relative to this file,
// so that the file and the pictures move together. One checkpoint and one seed, because a person has one face here;
// with several of either the first row of the index wins and the rest are ignored on purpose.
export function referencesOf(index: BatchIndex, cases: Case[], from: string, run: string): References {
  const byId = new Map(cases.map(one => [one.id, one]));
  const references: References = {};
  for (const picture of index.pictures) {
    const one = byId.get(picture.caseId);
    const name = one?.sheet?.[0]?.name;
    if (!one || !name) continue;
    const story = references[one.scenario] ??= {};
    if (story[name] === undefined) story[name] = relative(from, join(run, picture.file));
  }
  return references;
}

const report = (value: object) => console.log(JSON.stringify(value)); // counts and ids only, never a name

function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    prompts: { type: 'string' }, run: { type: 'string' }, out: { type: 'string' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'prompts') {
    if (!values.prompts || !values.out) throw new Error('Use: prompts --prompts <illustrate-probe directory> --out <directory>');
    const cases: Case[] = JSON.parse(readFileSync(join(resolve(values.prompts), 'prompts.json'), 'utf8'));
    const portraits = portraitCases(cases);
    if (!portraits.length) throw new Error('No character sheet in that prompts directory');
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, 'prompts.json'), JSON.stringify(portraits, null, 2), { mode: 0o600 });
    report({ event: 'portrait_prompts_written', directory: out, portraits: portraits.length,
      stories: new Set(portraits.map(one => one.scenario)).size });
  } else if (command === 'references') {
    if (!values.run || !values.out) throw new Error('Use: references --run <portrait run directory> --out <file>');
    const run = resolve(values.run), out = resolve(values.out);
    const index: BatchIndex = JSON.parse(readFileSync(join(run, 'index.json'), 'utf8'));
    const cases: Case[] = JSON.parse(readFileSync(join(run, 'prompts.json'), 'utf8'));
    const references = referencesOf(index, cases, dirname(out), run);
    const people = Object.values(references).reduce((total, story) => total + Object.keys(story).length, 0);
    if (!people) throw new Error('That run drew no portrait this file could name');
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, JSON.stringify(references, null, 2), { mode: 0o600 });
    report({ event: 'references_written', file: out, stories: Object.keys(references).length, people });
  } else throw new Error('Use: image-portraits.ts prompts|references');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  main(process.argv.slice(2));
}
