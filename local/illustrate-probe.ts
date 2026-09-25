// The description step of docs/illustrations-plan.md#step-1, brought in from the scratch script it was iterated in. For
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
import { channelFor } from './budget.ts';
import { safeErrorDetails } from './model-error.ts';
import { contextParts, storyNarration } from './prompt.ts';
import { active, history } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';
import { askJson, assemblePrompt, frameRequest, sheetOf, sheetRequest } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';

// What one frame is: written to the output directory and read by local/image-batch.ts and local/image-portraits.ts.
// `withoutLook` counts the people who reached the prompt with no appearance at all, which is the way the assembly
// fails quietly.
export type Case = {
  id: string; scenario: string; index: number; scene: string; sheet: Character[]; description: Description;
  prompt: string; namesStripped: number; fromSheet: number; withoutLook: number;
};

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
        const reply = await askJson(provider, sheetRequest({ system, messages: messages(scenes.at(-1)!.id) }));
        sheet = sheetOf(reply.value);
        writeFileSync(sheetPath, JSON.stringify(sheet, null, 2));
        report({ event: 'sheet_written', scenario, characters: sheet.length, retried: reply.retried });
      }
      for (const scene of todo) {
        const node = scenes[scene.index];
        if (!node) throw new Error(`No scene ${scene.index} in ${scenario}`);
        const reply = await askJson(provider, frameRequest({ system, messages: messages(node.id) }, sheet));
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
