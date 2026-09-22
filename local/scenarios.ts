// A synthetic scenario of the eval: the author's turns, the fixed questions and the continuity traps.
// The built-in ones live in examples/. A pack is a directory outside the repository, one subdirectory per scenario with
// scenario.json and frozen.json, so that whoever improves the prompts never reads the hidden questions.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checks } from '../examples/memory-checks.ts';
import { traps } from '../examples/scene-traps.ts';
import type { Trap } from '../examples/scene-traps.ts';
import { validTime } from '../lib/library.ts';

export type Check = [key: string, question: string, expected: string];
// `authors` names the models that wrote the scenario and its frozen scenes, for example "fable-5.1" or "gpt-6-astra".
export type ScenarioPack = { name: string; seed: string; turns: string[]; checks: Check[]; facts: string; traps: Trap[];
  authors: string[]; frozenPath: string };

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function packScenarios(pack: string) {
  return readdirSync(resolve(pack), { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-z][a-z0-9-]{0,39}$/.test(entry.name)).map(entry => entry.name).sort();
}

// The replay compacts after scenes 7, 11 and 15, so a pack scenario needs at least 16 turns.
export async function loadScenario(name: string, pack?: string): Promise<ScenarioPack> {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Unknown synthetic scenario');
  if (!pack) {
    if (!Object.hasOwn(checks, name)) throw new Error('Unknown synthetic scenario');
    // Every scenario module has the same exports as this one.
    const fixture: typeof import('../examples/battle-probe.ts') = await import(`../examples/${name}-probe.ts`);
    return { name, seed: fixture.seed, turns: fixture.turns, checks: checks[name as keyof typeof checks] as Check[], facts: traps[name]?.facts ?? '',
      traps: traps[name]?.traps ?? [], authors: [], frozenPath: resolve(import.meta.dirname, '..', 'examples', 'frozen', `${name}.json`) };
  }
  const directory = join(resolve(pack), name);
  const data: Partial<ScenarioPack> = JSON.parse(readFileSync(join(directory, 'scenario.json'), 'utf8'));
  const questions = (list: unknown): list is [string, string, string][] => Array.isArray(list) && list.every(item => Array.isArray(item) && item.length === 3 && item.every(part => text(part, 2000)));
  if (!text(data.seed, 20000) || !Array.isArray(data.turns) || data.turns.length < 16 || !data.turns.every(turn => text(turn, 4000))
      || !questions(data.checks) || !data.checks.length || !Array.isArray(data.authors) || !data.authors.length || !data.authors.every(author => text(author, 80))
      || (data.traps?.length && !text(data.facts, 8000)) || !(data.traps ?? []).every(trap => text(trap?.key, 40) && questions(trap.questions)
        && trap.questions.every(question => question[2] === 'yes' || question[2] === 'no')
        && (trap.afterTurn === undefined ? text(trap.input, 4000) : Number.isInteger(trap.afterTurn) && trap.afterTurn > 0 && trap.afterTurn < data.turns!.length)
        && (trap.facts === undefined || text(trap.facts, 8000)))) throw new Error('Invalid scenario.json');
  return { name, seed: data.seed, turns: data.turns, checks: data.checks, facts: data.facts ?? '', traps: data.traps ?? [], authors: data.authors,
    frozenPath: join(directory, 'frozen.json') };
}

// A walk: the model under test writes the story itself from the seed, one scene per step. An empty step is the bot's own
// "continue" signal; any other step is the author's intervention, given to the narrator as a player's message.
// Built-in walks live in examples/walk/<name>.json; a pack keeps one in <name>/walk.json.
export type WalkScenario = { name: string; seed: string; steps: string[]; authors: string[] };

export function packWalks(pack: string) {
  return packScenarios(pack).filter(name => existsSync(join(resolve(pack), name, 'walk.json')));
}

export async function loadWalk(name: string, pack?: string): Promise<WalkScenario> {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('Unknown synthetic walk');
  const path = pack ? join(resolve(pack), name, 'walk.json') : resolve(import.meta.dirname, '..', 'examples', 'walk', `${name}.json`);
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { throw new Error('Unknown synthetic walk'); }
  const data: Partial<WalkScenario> = JSON.parse(raw);
  // The seed has the bot's own shape: a title, the in-world start time, then the text. Every step is a string of at most
  // 4000 characters; the empty string is the continue signal. The panel judges 8 to 40 scenes.
  const [title, startTime, ...body] = (data.seed ?? '').trim().split('\n');
  if (!text(data.seed, 20000) || !title || title.length > 100 || !validTime(startTime?.trim() ?? '') || !body.join('\n').trim()
      || !Array.isArray(data.steps) || data.steps.length < 8 || data.steps.length > 40 || !data.steps.every(step => typeof step === 'string' && step.length <= 4000 && step === step.trim())
      || !Array.isArray(data.authors) || !data.authors.length || !data.authors.every(author => text(author, 80))) throw new Error('Invalid walk.json');
  return { name, seed: data.seed, steps: data.steps, authors: data.authors };
}
