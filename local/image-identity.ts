// The identity measurement of docs/illustrations-plan.md ("The identity runbook"): does a person drawn from a portrait
// come back the same in the next frame, face and figure, and what does that cost the card. Three arms over one fixed
// synthetic set (examples/identity-set.ts), every frame from two seeds, all on one canvas:
//   A  the frame's text alone, looks included, as the bot draws today;
//   B  the same text, and the portraits of the people the frame binds (local/image-batch.ts `bindingPlan`);
//   C  the same portraits, and the whole look of each bound person, build included, replaced by the number of their
//      picture. C asks whether the figure comes from the portrait alone, which is the owner's question.
// The commands, in the runbook's order:
//   set       the set as a prompts directory, which local/image-portraits.ts and `draw` read
//   draw      the three arms on the card through image-batch.ts `draw`: `--smoke` first, the main set only after it
//   report    geometry, time, memory and prompt length per arm, and the gates once the answers are in
//   bundles   one blind bundle per arm and seed, with the sheet of checks the gates count
//   dry-run   all of it against local/fake-comfy.ts, with fake answers, and no card
// Nothing here talks to a model, and what it prints is counts, sizes, times and verdicts.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assemblePrompt, matchSheet } from './illustrate.ts';
import type { Case } from './illustrate-probe.ts';
import { ARMS, REVIEW, comfyUrl, draw, encoderResolution, parseSeeds, pngSize, taskMarkdown, textEncoderOf } from './image-batch.ts';
import type { Arm, BatchIndex, Failure, Graph, Picture, References } from './image-batch.ts';
import { portraitCases, referencesOf } from './image-portraits.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';
import { readManifest } from './tokenizer-extract.ts';
import { greyPng, startFakeComfy } from './fake-comfy.ts';
import { IDENTITY_SEEDS, IDENTITY_SMOKE, IDENTITY_STORY, identityFrames, identitySheet } from '../examples/identity-set.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EDIT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen-edit.json');
const PORTRAIT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen.json');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return !sorted.length ? undefined : sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// The set as illustrate-probe.ts writes a prompts directory, each prompt assembled by the bot's own `assemblePrompt`.
export function identityCases(): Case[] {
  return identityFrames.map((frame, order) => ({ id: frame.id, scenario: IDENTITY_STORY, index: order + 1, scene: frame.scene,
    sheet: identitySheet, description: frame.description, ...assemblePrompt(frame.description, identitySheet) }));
}

// What the pictures depend on beyond the graph, whose hash the index keeps already: the files the bootstrap pinned the
// card to, where the graph keeps its cache and what it resizes a reference to, the set, the portraits and the seeds.
// image-batch.ts refuses a resume under any other value, so one run directory is one comparison.
function pinsOf(graph: Graph, prompts: string, references: string, seeds: number[]): Record<string, string | number> {
  const manifest = readManifest(join(ROOT, 'gpu', 'image-manifest.env'));
  const named: References = JSON.parse(readFileSync(references, 'utf8'));
  const portraits = createHash('sha256');
  for (const story of Object.keys(named).sort()) {
    for (const name of Object.keys(named[story]).sort()) {
      const path = resolve(dirname(references), named[story][name]);
      if (existsSync(path)) portraits.update(readFileSync(path));
    }
  }
  const cache = Object.values(graph).find(node => node.class_type === 'QwenImage21Cache');
  return { comfyuiRevision: manifest.COMFYUI_REVISION ?? '', transformer: manifest.IMAGE_QWEN_MODEL_SHA256 ?? '',
    encoder: manifest.IMAGE_QWEN_ENCODER_SHA256 ?? '', vae: manifest.IMAGE_QWEN_VAE_SHA256 ?? '',
    cacheDevice: String(cache?.inputs.device ?? 'none'), resolution: encoderResolution(graph) ?? -1,
    set: sha256(readFileSync(join(prompts, 'prompts.json'))), portraits: portraits.digest('hex'), seeds: seeds.join(',') };
}

// The canvas of the run, measured from the picture files themselves, and the size the first reference of each bound
// frame reached the encoder at, which the node hands out as the canvas and so has to be it.
function geometryOf(index: BatchIndex, root: string, pictures: Picture[]) {
  const canvas = `${index.comfy.width}x${index.comfy.height}`;
  const size = (picture: Picture) => {
    const path = join(root, picture.file);
    if (!existsSync(path)) return 'missing';
    const { width, height } = pngSize(readFileSync(path));
    return `${width}x${height}`;
  };
  const bound = pictures.filter(picture => (picture.references ?? 0) > 0);
  const offCanvas = pictures.filter(picture => size(picture) !== canvas).length;
  const firstOff = bound.filter(picture => picture.referenceSizes?.[0]?.join('x') !== canvas
    || picture.referenceSizes.length !== picture.references).length;
  return { canvas, pictures: pictures.length, offCanvas, bound: bound.length, firstOff, pass: pictures.length > 0 && !offCanvas && !firstOff };
}

// The card's side of gate 5: no cell ran out of memory, and every frame of four references was drawn, sampled while
// it ran, and left at least 2 GiB of the card free at its highest. A frame of four that failed or was never sampled
// is a peak nobody measured, and fails the gate as an OOM does. RAM and partial loads are shown, not gated.
const HEADROOM_MIB = 2048;
function memoryOf(pictures: Picture[], failures: Failure[]) {
  const four = pictures.filter(picture => (picture.references ?? 0) >= 4);
  const headroom = four.map(picture => picture.vramSamples && picture.vram[0]?.occupiedMiBMax !== undefined
    ? picture.vram[0].totalMiB - picture.vram[0].occupiedMiBMax : undefined);
  const least = headroom.length && headroom.every(value => value !== undefined) ? Math.min(...headroom as number[]) : undefined;
  const oom = failures.filter(failure => failure.oom).length, lost = failures.filter(failure => (failure.references ?? 0) >= 4).length;
  return { oom, four: four.length, lost, unmeasured: headroom.filter(value => value === undefined).length, headroomMiB: least,
    occupiedMiB: Math.max(0, ...pictures.map(picture => picture.vram[0]?.occupiedMiBMax ?? 0)),
    ramMiB: Math.max(0, ...pictures.map(picture => picture.ramMiB?.max ?? 0)),
    offloads: pictures.reduce((total, picture) => total + (picture.offloads ?? 0), 0),
    pass: !oom && !lost && four.length > 0 && least !== undefined && least >= HEADROOM_MIB };
}

// The smoke: the frame with one portrait and the frame with four, at the first seed, in every arm. The main set is
// drawn only once all of it is drawn on the canvas and within the card's memory; a failed smoke is the end of the run.
export function smokeOf(index: BatchIndex, root: string) {
  const seed = parseSeeds(String(index.pins?.seeds ?? ''))[0];
  const ours = <T extends { caseId: string; seed: number }>(list: T[]) => list.filter(one => one.seed === seed && IDENTITY_SMOKE.includes(one.caseId));
  const pictures = ours(index.pictures), failures = ours(index.failures);
  const drawn = IDENTITY_SMOKE.every(caseId => (index.arms ?? []).every(arm =>
    [...pictures, ...failures].some(one => one.caseId === caseId && one.arm === arm))) && !!index.arms?.length;
  const geometry = geometryOf(index, root, pictures).pass, memory = memoryOf(pictures, failures).pass;
  return { drawn, geometry, memory, pass: drawn && geometry && memory };
}

export type ArmsOptions = { prompts: string; out: string; references: string; comfy: string; minutes: number; smoke?: boolean;
  workflow?: string; checkpoint?: string; seeds?: number[]; tokenizers?: string; timeoutMs?: number; waitMs?: number;
  pollMs?: number; log?: (event: object) => void };
// The arms on the card, through the same `draw` every other run uses. The prompt of each cell is counted in tokens
// as the graph's encoder reads it, with the pictures ahead of it, when the Qwen tokenizer is at hand (docs/tokenizers.md);
// without it the report falls back to characters and says so.
export async function drawArms(options: ArmsOptions): Promise<BatchIndex> {
  const workflow = resolve(options.workflow ?? EDIT_GRAPH);
  const graph: Graph = JSON.parse(readFileSync(workflow, 'utf8'));
  const loader = Object.values(graph).find(node => typeof node.inputs.unet_name === 'string' || typeof node.inputs.ckpt_name === 'string');
  const checkpoint = options.checkpoint ?? String(loader?.inputs.unet_name ?? loader?.inputs.ckpt_name ?? '');
  const seeds = options.seeds ?? IDENTITY_SEEDS;
  const out = resolve(options.out), prompts = resolve(options.prompts), references = resolve(options.references);
  if (!options.smoke) {
    const indexPath = join(out, 'index.json');
    const smoke = existsSync(indexPath) ? smokeOf(JSON.parse(readFileSync(indexPath, 'utf8')), out) : undefined;
    if (!smoke?.pass) {
      throw new Error(`The main set is drawn only after the smoke has passed in the same directory (--smoke): ${smoke
        ? `drawn ${smoke.drawn}, geometry ${smoke.geometry}, memory ${smoke.memory}` : 'no smoke there'}`);
    }
  }
  const tokenizer = loadTokenizers(resolve(options.tokenizers ?? join(ROOT, 'tokenizers'))).qwen();
  const encoder = textEncoderOf(graph);
  return draw({ prompts, out, comfy: options.comfy, checkpoints: [checkpoint], seeds: options.smoke ? seeds.slice(0, 1) : seeds,
    negative: '', minutes: options.minutes, timeoutMs: options.timeoutMs ?? 60000, waitMs: options.waitMs ?? 300000,
    pollMs: options.pollMs, workflow, references, arms: ARMS, only: options.smoke ? IDENTITY_SMOKE : undefined,
    pins: pinsOf(graph, prompts, references, seeds), log: options.log,
    tokens: tokenizer && encoder ? (prompt, images) => qwenPromptTokens(tokenizer, prompt, encoder, { images }) : undefined });
}

// The items a judge answers `yes`, `no` or `unsure` to (image-batch.ts `taskMarkdown`, the identity variant).
type Item = 'face' | 'figure' | 'action' | 'apart' | 'swap' | 'clothes' | 'style';
export type Check = { id: string; kind: 'transition' | 'picture' | 'clothes' | 'style'; person?: string; from?: string; to?: string;
  picture?: string; pictures?: string[]; items: Item[] };
export type Answers = { answers?: Record<string, Partial<Record<Item, string>>> };
type Key = { arm: Arm; seed: number; checkpoint: string; pictures: { picture: string; caseId: string; file: string; sha256: string }[] };
type Entry = { picture: string; one: Case };

const sheetPeople = (one: Case) => {
  const names = (one.sheet ?? []).map(character => character.name);
  return (one.description.people ?? []).flatMap(person => {
    const name = matchSheet(person.who ?? '', names);
    return name === null ? [] : [{ name, changed: !!person.clothes?.trim() }];
  });
};

// The sheet of checks of one bundle, from the set alone: every arm gets the same checks, and the report rebuilds them
// from a key. `transition`: a person of the sheet in two frames that follow each other in the story, face and figure
// apart, because a face kept on a body that lost its build is no person kept; `picture`: the frame's action and, where
// two people of the sheet share it, that neither took the other's face or figure (`apart`) or both the other's look and
// clothes (`swap`); `clothes`: each person of the sheet in each frame; `style`: the bundle as a whole.
export function checksOf(entries: Entry[]): Check[] {
  const frames = [...entries].sort((a, b) => a.one.index - b.one.index);
  const checks: Check[] = [];
  const next = (prefix: string) => `${prefix}${String(checks.filter(check => check.id[0] === prefix).length + 1).padStart(2, '0')}`;
  for (const { name: person } of (frames[0]?.one.sheet ?? [])) {
    const seen = frames.filter(entry => sheetPeople(entry.one).some(one => one.name === person));
    for (let at = 1; at < seen.length; at++) {
      checks.push({ id: next('t'), kind: 'transition', person, from: seen[at - 1].picture, to: seen[at].picture, items: ['face', 'figure'] });
    }
  }
  for (const entry of frames) {
    checks.push({ id: next('p'), kind: 'picture', picture: entry.picture,
      items: sheetPeople(entry.one).length > 1 ? ['action', 'apart', 'swap'] : ['action'] });
  }
  for (const entry of frames) {
    for (const { name } of sheetPeople(entry.one)) checks.push({ id: next('c'), kind: 'clothes', person: name, picture: entry.picture, items: ['clothes'] });
  }
  checks.push({ id: 's01', kind: 'style', pictures: entries.map(entry => entry.picture).sort(), items: ['style'] });
  return checks;
}

// One bundle per arm and seed: a transition compares two frames of one arm, and a session shown the arms side by side
// would judge the arms rather than the frames. Bundles are named in the order of their pictures' hashes and pictures
// by their own, so no name shows the arm or the seed, and the key stays outside, in `keys/`. The judge reads each
// frame's `frame_text`, the prompt with every look in it, whichever arm drew it: arm C's own text says "the person
// from image 1" and would name the arm. Bundles are built once: the answers are read against them.
export function buildIdentityBundles(directory: string, log: (event: object) => void = () => undefined): string[] {
  const root = resolve(directory);
  const index: BatchIndex = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  if (!index.arms) throw new Error(`${root} is not an identity run; bundle it with npm run image:batch -- bundles`);
  if (existsSync(join(root, REVIEW))) throw new Error(`${join(root, REVIEW)} exists: bundles are built once, and the answers are read against them`);
  const cases: Case[] = JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8'));
  const groups = new Map<string, Picture[]>();
  for (const picture of index.pictures) groups.set(`${picture.arm}#${picture.seed}`, [...groups.get(`${picture.arm}#${picture.seed}`) ?? [], picture]);
  const digest = (pictures: Picture[]) => sha256(pictures.map(picture => picture.sha256).join());
  const ordered = [...groups.values()].map(pictures => pictures.sort((a, b) => a.sha256.localeCompare(b.sha256)))
    .sort((a, b) => digest(a).localeCompare(digest(b)));
  mkdirSync(join(root, 'keys'), { recursive: true, mode: 0o700 });
  return ordered.map((pictures, order) => {
    const name = `bundle-${order + 1}`, folder = join(root, REVIEW, name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const entries = pictures.map((source, at) => ({ picture: `pic-${String(at + 1).padStart(2, '0')}.png`, source,
      one: cases.find(one => one.id === source.caseId)! }));
    for (const entry of entries) copyFileSync(join(root, entry.source.file), join(folder, entry.picture));
    writeFileSync(join(folder, 'cases.json'), JSON.stringify(entries.map(({ picture, one }) => ({ picture, scene_text_ru: one.scene,
      character_sheet: one.sheet, description: one.description, frame_text: one.prompt })), null, 2), { mode: 0o600 });
    writeFileSync(join(folder, 'checks.json'), JSON.stringify(checksOf(entries), null, 2), { mode: 0o600 });
    writeFileSync(join(folder, 'TASK.md'), taskMarkdown(entries.length, true), { mode: 0o600 });
    const key: Key = { arm: pictures[0].arm!, seed: pictures[0].seed, checkpoint: pictures[0].checkpoint,
      pictures: entries.map(({ picture, source }) => ({ picture, caseId: source.caseId, file: source.file, sha256: source.sha256 })) };
    writeFileSync(join(root, 'keys', `${name}.json`), JSON.stringify(key, null, 2), { mode: 0o600 });
    log({ event: 'bundle_written', bundle: name, pictures: entries.length });
    return name;
  });
}

type Tally = { bundles: number; missing: number; transitions: number; face: number; figure: number; both: number; pictures: number;
  actionFailed: number; together: number; apartFailed: number; swapFailed: number; clothes: number; clothesYes: number;
  changed: number; changedYes: number; styleYes: number };
// What the judges answered, per arm: each bundle's checks rebuilt from its key, each item read from
// `answers/<bundle>.json`. Only `yes` counts for a picture, `no` and `unsure` against it; an item nobody answered
// leaves the arm unscored.
export function scoresOf(root: string, cases: Case[]): Partial<Record<Arm, Tally>> {
  const tallies: Partial<Record<Arm, Tally>> = {};
  const keys = existsSync(join(root, 'keys')) ? readdirSync(join(root, 'keys')).filter(name => name.endsWith('.json')).sort() : [];
  for (const file of keys) {
    const key: Key = JSON.parse(readFileSync(join(root, 'keys', file), 'utf8'));
    const path = join(root, 'answers', file);
    const given = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Answers).answers ?? {} : {};
    const tally = tallies[key.arm] ??= { bundles: 0, missing: 0, transitions: 0, face: 0, figure: 0, both: 0, pictures: 0,
      actionFailed: 0, together: 0, apartFailed: 0, swapFailed: 0, clothes: 0, clothesYes: 0, changed: 0, changedYes: 0, styleYes: 0 };
    tally.bundles++;
    const entries = key.pictures.map(({ picture, caseId }) => ({ picture, one: cases.find(one => one.id === caseId)! }));
    for (const check of checksOf(entries)) {
      const yes = (item: Item) => {
        const said = given[check.id]?.[item];
        if (said === undefined) tally.missing++;
        return said === 'yes' ? 1 : 0;
      };
      if (check.kind === 'transition') {
        const face = yes('face'), figure = yes('figure');
        tally.transitions++; tally.face += face; tally.figure += figure; tally.both += face * figure;
      } else if (check.kind === 'picture') {
        tally.pictures++;
        tally.actionFailed += 1 - yes('action');
        if (check.items.includes('apart')) { tally.together++; tally.apartFailed += 1 - yes('apart'); tally.swapFailed += 1 - yes('swap'); }
      } else if (check.kind === 'clothes') {
        const one = entries.find(entry => entry.picture === check.picture)!.one;
        const kept = yes('clothes');
        tally.clothes++; tally.clothesYes += kept;
        if (sheetPeople(one).some(person => person.name === check.person && person.changed)) { tally.changed++; tally.changedYes += kept; }
      } else tally.styleYes += yes('style');
    }
  }
  return tallies;
}

type Gate = { gate: number; status: 'pass' | 'fail' | 'unscored' | 'unmeasured'; detail: string };
const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '-';
const warm = (picture: Picture) => picture.cold === false && !picture.first;

// The gates, fixed before the paid run (docs/illustrations-plan.md), for a candidate arm against A.
function gatesOf(arm: Arm, pictures: Picture[], failures: Failure[], tallies: Partial<Record<Arm, Tally>>,
  text: Record<Arm, number | undefined>): Gate[] {
  const own = tallies[arm], base = tallies.A;
  const scored = (tally?: Tally) => !!tally && tally.bundles > 0 && tally.missing === 0;
  const both = scored(own) && scored(base);
  const recognised = (tally: Tally) => tally.transitions ? tally.both / tally.transitions : 0;
  const gates: Gate[] = [];
  if (!scored(own)) gates.push({ gate: 1, status: 'unscored', detail: 'answers missing' });
  else {
    const { transitions, face, figure, apartFailed } = own!;
    gates.push({ gate: 1, status: transitions >= 20 && face >= 0.9 * transitions && figure >= 0.9 * transitions && !apartFailed ? 'pass' : 'fail',
      detail: `face ${percent(face, transitions)}, figure ${percent(figure, transitions)} of ${transitions} transitions, ${apartFailed} mixed up` });
  }
  if (!both) gates.push({ gate: 2, status: 'unscored', detail: 'answers missing' });
  else {
    const gain = recognised(own!) - recognised(base!), shorter = text[arm] !== undefined && text.A !== undefined && text[arm]! < text.A;
    const pass = recognised(base!) >= 0.9
      ? arm === 'C' && gain >= -0.05 - 1e-9 && shorter && own!.actionFailed <= base!.actionFailed
      : gain >= 0.15 - 1e-9;
    gates.push({ gate: 2, status: pass ? 'pass' : 'fail', detail: `face and figure ${percent(own!.both, own!.transitions)} against A's ${percent(base!.both, base!.transitions)}`
      + (recognised(base!) >= 0.9 ? `; A is at 90% or more, so only a shorter C may pass (${text[arm]} against ${text.A})` : '') });
  }
  if (!both) gates.push({ gate: 3, status: 'unscored', detail: 'answers missing' });
  else {
    const { clothes, clothesYes, changed, changedYes, swapFailed, actionFailed } = own!;
    gates.push({ gate: 3, status: clothesYes >= 0.9 * clothes && !swapFailed && actionFailed <= base!.actionFailed ? 'pass' : 'fail',
      detail: `clothes ${percent(clothesYes, clothes)} (${percent(changedYes, changed)} where the story changes them), ${swapFailed} swapped, action errors ${actionFailed} against A's ${base!.actionFailed}` });
  }
  const pairs = pictures.filter(picture => picture.arm === arm && warm(picture)).flatMap(picture => {
    const other = pictures.find(one => one.arm === 'A' && one.caseId === picture.caseId && one.seed === picture.seed && warm(one));
    return other ? [[picture.totalMs, other.totalMs]] : [];
  });
  if (!pairs.length) gates.push({ gate: 4, status: 'unmeasured', detail: 'no warm frame matched in A' });
  else {
    const [mine, theirs] = [median(pairs.map(pair => pair[0]))!, median(pairs.map(pair => pair[1]))!];
    const [slowest, baseline] = [Math.max(...pairs.map(pair => pair[0])), Math.max(...pairs.map(pair => pair[1]))];
    gates.push({ gate: 4, status: mine <= 1.5 * theirs && slowest <= 2 * baseline ? 'pass' : 'fail',
      detail: `warm median ${mine} ms against ${theirs}, slowest ${slowest} against ${baseline}, over ${pairs.length} matched frames` });
  }
  const memory = memoryOf(pictures.filter(picture => picture.arm === arm), failures.filter(failure => failure.arm === arm));
  gates.push({ gate: 5, status: memory.pass ? 'pass' : 'fail', detail: `${memory.oom} OOM, ${memory.four} frames of four drawn, ${memory.lost} failed, `
    + `${memory.unmeasured} unmeasured, least headroom ${memory.headroomMiB ?? '-'} MiB of the ${HEADROOM_MIB} asked for` });
  return gates;
}

type ArmSummary = { drawn: number; failed: number; references: Record<string, number>; warm: number; warmMedianMs?: number;
  slowestWarmMs?: number; firstMs?: number; firstCold?: boolean; uploadMs: number; encodeMs?: number; sampleMs?: number;
  memory: ReturnType<typeof memoryOf>; text?: number; tally?: Tally };

// Everything the run directory says, and the gates once `answers/` holds a judge's answers for every bundle. A run
// that did not draw every cell of the set is incomplete, whatever its gates say: the hour is not extended for it.
export function identityReport(directory: string, portraits?: string) {
  const root = resolve(directory);
  const index: BatchIndex = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  const cases: Case[] = JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8'));
  const arms = index.arms ?? [];
  const seeds = parseSeeds(String(index.pins?.seeds ?? ''));
  const expected = cases.length * seeds.length * arms.length;
  const complete = expected > 0 && index.pictures.length + index.failures.length === expected && !index.stopped && !index.error;
  const ofArm = (arm: Arm) => index.pictures.filter(picture => picture.arm === arm);
  const tokens = index.pictures.length > 0 && index.pictures.every(picture => picture.promptTokens !== undefined);
  const text = Object.fromEntries(ARMS.map(arm => [arm, median(ofArm(arm).map(picture => (tokens ? picture.promptTokens : picture.promptChars) ?? 0))])) as Record<Arm, number | undefined>;
  const tallies = scoresOf(root, cases);
  const portraitIndex: BatchIndex | undefined = portraits ? JSON.parse(readFileSync(join(resolve(portraits), 'index.json'), 'utf8')) : undefined;
  const gates: Record<string, Gate[]> = Object.fromEntries(arms.filter(arm => arm !== 'A')
    .map(arm => [arm, gatesOf(arm, index.pictures, index.failures, tallies, text)]));
  const verdicts = Object.entries(gates).map(([arm, list]) => `${arm} ${list.some(gate => gate.status === 'fail') ? 'fails'
    : list.every(gate => gate.status === 'pass') ? 'passes' : 'is open'}`);
  const summaries: Record<string, ArmSummary> = Object.fromEntries(arms.map(arm => {
    const pictures = ofArm(arm), warmOnes = pictures.filter(warm), first = pictures.find(picture => picture.first);
    const references: Record<string, number> = {};
    for (const picture of pictures) references[picture.references ?? 0] = (references[picture.references ?? 0] ?? 0) + 1;
    return [arm, { drawn: pictures.length, failed: index.failures.filter(failure => failure.arm === arm).length, references,
      warm: warmOnes.length, warmMedianMs: median(warmOnes.map(picture => picture.totalMs)),
      slowestWarmMs: warmOnes.length ? Math.max(...warmOnes.map(picture => picture.totalMs)) : undefined,
      firstMs: first?.totalMs, firstCold: first?.cold, uploadMs: pictures.reduce((total, picture) => total + (picture.uploadMs ?? 0), 0),
      encodeMs: median(warmOnes.flatMap(picture => picture.phases?.encodeMs ?? [])),
      sampleMs: median(warmOnes.flatMap(picture => picture.phases?.sampleMs ?? [])),
      memory: memoryOf(pictures, index.failures.filter(failure => failure.arm === arm)), text: text[arm], tally: tallies[arm] }];
  }));
  return {
    directory: root, expected, drawn: index.pictures.length, failed: index.failures.length, complete, stopped: index.stopped, error: index.error,
    pins: index.pins ?? {}, geometry: geometryOf(index, root, index.pictures), smoke: smokeOf(index, root),
    portraits: portraitIndex && { drawn: portraitIndex.pictures.length, firstMs: portraitIndex.pictures.find(picture => picture.first)?.totalMs,
      medianMs: median(portraitIndex.pictures.filter(picture => !picture.first).map(picture => picture.totalMs)) },
    arms: summaries, unit: tokens ? 'tokens' : 'characters', gates,
    verdict: !complete ? 'incomplete' : verdicts.join(', '),
  };
}
export type IdentityReport = ReturnType<typeof identityReport>;

// The report as a person reads it.
export function reportLines(report: IdentityReport): string[] {
  const { geometry, smoke, arms } = report;
  const lines = [
    `identity run ${report.directory}`,
    `  cells: ${report.drawn + report.failed} of ${report.expected} (drawn ${report.drawn}, failed ${report.failed})${report.stopped === 'budget' ? ', stopped by the time budget' : ''}${report.error ? `, stopped by ${report.error}` : ''}`,
    `  pins: ${Object.entries(report.pins).map(([key, value]) => `${key} ${String(value).slice(0, 12)}`).join(', ')}`,
    `  geometry ${geometry.pass ? 'pass' : 'FAIL'}: canvas ${geometry.canvas}, ${geometry.pictures - geometry.offCanvas} of ${geometry.pictures} pictures at it, first reference at it in ${geometry.bound - geometry.firstOff} of ${geometry.bound} bound frames`,
    `  smoke (${IDENTITY_SMOKE.join(', ')}, first seed): drawn ${smoke.drawn}, geometry ${smoke.geometry ? 'pass' : 'FAIL'}, memory ${smoke.memory ? 'pass' : 'FAIL'}`,
  ];
  if (report.portraits) lines.push(`  portraits, a run of their own: ${report.portraits.drawn} drawn, the first ${report.portraits.firstMs ?? '-'} ms, the rest median ${report.portraits.medianMs ?? '-'} ms`);
  lines.push('  arm  frames  refs per frame      warm  median ms  slowest ms  first ms  upload ms  encode ms  sample ms');
  for (const [arm, one] of Object.entries(arms)) {
    const refs = Object.entries(one.references).map(([count, frames]) => `${count}:${frames}`).join(' ');
    lines.push(`  ${arm}    ${String(one.drawn).padEnd(6)}  ${refs.padEnd(18)}  ${String(one.warm).padEnd(4)}  ${String(one.warmMedianMs ?? '-').padEnd(9)}  ${String(one.slowestWarmMs ?? '-').padEnd(10)}  ${`${one.firstMs ?? '-'}${one.firstCold ? ' cold' : ''}`.padEnd(8)}  ${String(one.uploadMs).padEnd(9)}  ${String(one.encodeMs ?? '-').padEnd(9)}  ${one.sampleMs ?? '-'}`);
  }
  lines.push('  arm  failed  OOM  frames of 4  least headroom MiB  occupied max MiB  RAM max MiB  partial loads');
  for (const [arm, one] of Object.entries(arms)) {
    const memory = one.memory;
    lines.push(`  ${arm}    ${String(one.failed).padEnd(6)}  ${String(memory.oom).padEnd(3)}  ${String(memory.four).padEnd(11)}  ${String(memory.headroomMiB ?? '-').padEnd(18)}  ${String(memory.occupiedMiB).padEnd(16)}  ${String(memory.ramMiB).padEnd(11)}  ${memory.offloads}`);
  }
  lines.push(`  prompt, median ${report.unit}: ${Object.entries(arms).map(([arm, one]) => `${arm} ${one.text ?? '-'}`).join(', ')}`);
  for (const [arm, one] of Object.entries(arms)) {
    const tally = one.tally;
    if (!tally) { lines.push(`  ${arm} answers: no bundle yet`); continue; }
    lines.push(`  ${arm} answers: ${tally.bundles} bundles, ${tally.missing} items unanswered; face ${percent(tally.face, tally.transitions)}, figure ${percent(tally.figure, tally.transitions)}, both ${percent(tally.both, tally.transitions)} of ${tally.transitions} transitions; ${tally.apartFailed} mixed up and ${tally.swapFailed} swapped of ${tally.together}; action errors ${tally.actionFailed} of ${tally.pictures}; clothes ${percent(tally.clothesYes, tally.clothes)}; style ${tally.styleYes} of ${tally.bundles}`);
  }
  for (const [arm, list] of Object.entries(report.gates)) {
    for (const gate of list) lines.push(`  ${arm} gate ${gate.gate} ${gate.status}: ${gate.detail}`);
  }
  lines.push(`  verdict: ${report.verdict}`);
  return lines;
}

// Answers the dry run writes in place of a judge's, so that the counting and the gates run end to end. They are made
// up by rule and say nothing about any model: A loses the figure on every other transition, C gets every fourth
// clothes check `unsure`, and everything else is `yes`.
function fakeAnswers(root: string, cases: Case[]) {
  mkdirSync(join(root, 'answers'), { recursive: true, mode: 0o700 });
  for (const file of readdirSync(join(root, 'keys'))) {
    const key: Key = JSON.parse(readFileSync(join(root, 'keys', file), 'utf8'));
    const checks = checksOf(key.pictures.map(({ picture, caseId }) => ({ picture, one: cases.find(one => one.id === caseId)! })));
    const said = (check: Check, item: Item) => {
      const number = Number(check.id.slice(1));
      return key.arm === 'A' && item === 'figure' && number % 2 === 1 ? 'no' : key.arm === 'C' && item === 'clothes' && number % 4 === 1 ? 'unsure' : 'yes';
    };
    const answers: Answers = { answers: Object.fromEntries(checks.map(check =>
      [check.id, Object.fromEntries(check.items.map(item => [item, said(check, item)]))])) };
    writeFileSync(join(root, 'answers', file), JSON.stringify(answers, null, 2), { mode: 0o600 });
  }
}

// What `set`, `image:portraits` and `image:batch` leave before the first frame is drawn: the set, one portrait per
// person drawn by the text-to-image graph, and the references file that binds them.
export async function prepare(root: string, comfy: string) {
  const set = join(root, 'set');
  mkdirSync(set, { recursive: true, mode: 0o700 });
  writeFileSync(join(set, 'prompts.json'), JSON.stringify(identityCases(), null, 2), { mode: 0o600 });
  const people = portraitCases(identityCases());
  mkdirSync(join(root, 'portrait-prompts'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'portrait-prompts', 'prompts.json'), JSON.stringify(people, null, 2), { mode: 0o600 });
  const portraits = await draw({ prompts: join(root, 'portrait-prompts'), out: join(root, 'portraits'), comfy,
    checkpoints: ['qwen_image_2.1_int8_convrot.safetensors'], seeds: [7], negative: '', minutes: 5, timeoutMs: 10000, waitMs: 60000,
    pollMs: 20, workflow: PORTRAIT_GRAPH });
  const references = join(root, 'references.json');
  writeFileSync(references, JSON.stringify(referencesOf(portraits, people, root, join(root, 'portraits')), null, 2), { mode: 0o600 });
  return { set, references, portraits };
}

// The whole runbook against local/fake-comfy.ts: the set, the portraits drawn and bound, the smoke, the main set, the
// bundles, fake answers and the report, and on the way the refusals the paid run relies on. No card, no model.
export async function dryRun(out: string, tokenizers?: string, say: (line: string) => void = console.log) {
  const root = resolve(out);
  const fake = await startFakeComfy();
  const base = { comfy: fake.url, tokenizers, pollMs: 20, timeoutMs: 10000, waitMs: 60000 };
  try {
    say(`dry run in ${root}, against a fake ComfyUI (local/fake-comfy.ts): no card, no model, and the answers are made up`);
    const { set, references, portraits } = await prepare(root, fake.url);
    say(`1 set: ${identityFrames.length} frames, ${identitySheet.length} people; portraits: ${portraits.pictures.length} drawn at ${portraits.comfy.width}x${portraits.comfy.height}, bound in references.json`);
    const run = join(root, 'run');
    const refused = async (what: string, work: Promise<unknown>) => {
      try { await work; say(`   ${what}: NOT refused`); } catch (error) { say(`   ${what}: refused (${(error as Error).message})`); }
    };
    await refused('the main set before the smoke', drawArms({ ...base, prompts: set, out: run, references, minutes: 5 }));
    const odd = JSON.parse(readFileSync(references, 'utf8')) as References;
    writeFileSync(join(root, 'small.png'), greyPng(640, 360, 1));
    odd[IDENTITY_STORY][identitySheet[1].name] = 'small.png';
    writeFileSync(join(root, 'mixed.json'), JSON.stringify(odd));
    await refused('portraits of two sizes', drawArms({ ...base, prompts: set, out: join(root, 'mixed'), references: join(root, 'mixed.json'), minutes: 5, smoke: true }));
    await drawArms({ ...base, prompts: set, out: run, references, minutes: 5, smoke: true });
    const smoke = identityReport(run).smoke;
    say(`2 smoke: ${JSON.stringify(smoke)}`);
    await drawArms({ ...base, prompts: set, out: run, references, minutes: 5 });
    say(`3 main set drawn; bundles: ${buildIdentityBundles(run).join(', ')}; fake answers written to ${join(run, 'answers')}`);
    fakeAnswers(run, identityCases());
    const cut = join(root, 'cut');
    const short = await drawArms({ ...base, prompts: set, out: cut, references, minutes: 0.001, smoke: true });
    say(`4 a run the clock cut short: ${short.pictures.length} drawn, stopped ${short.stopped}, verdict ${identityReport(cut).verdict}`);
    say('5 the report of the full run:');
    for (const line of reportLines(identityReport(run, join(root, 'portraits')))) say(line);
    return identityReport(run, join(root, 'portraits'));
  } finally { await fake.close(); }
}

const report = (value: object) => console.log(JSON.stringify(value)); // counts, ids and codes only, never a prompt

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string' }, prompts: { type: 'string' }, references: { type: 'string' }, portraits: { type: 'string' },
    comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, workflow: { type: 'string' }, checkpoint: { type: 'string' },
    seeds: { type: 'string' }, minutes: { type: 'string' }, wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
    tokenizers: { type: 'string' }, smoke: { type: 'boolean', default: false },
  } });
  const command = positionals[0] ?? '';
  const under = (path: string | undefined, fallback: string) => resolve(path ?? join(ROOT, 'illustrations', 'identity', fallback));
  if (command === 'set') {
    const out = under(values.out, 'set');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, 'prompts.json'), JSON.stringify(identityCases(), null, 2), { mode: 0o600 });
    report({ event: 'identity_set_written', directory: out, frames: identityFrames.length, people: identitySheet.length });
  } else if (command === 'draw') {
    const minutes = Number(values.minutes), wait = Number(values.wait), timeout = Number(values.timeout);
    const seeds = values.seeds === undefined ? IDENTITY_SEEDS : parseSeeds(values.seeds);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60 || !seeds.length || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Error('Use: draw [--smoke] --minutes <1-60, what is left of the hour> [--out illustrations/identity/run] [--prompts illustrations/identity/set] [--references illustrations/identity/references.json] [--workflow gpu/image-workflow-qwen-edit.json] [--checkpoint name] [--seeds 7,11] [--wait 300] [--timeout 60] [--tokenizers tokenizers] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawArms({ prompts: under(values.prompts, 'set'), out: under(values.out, 'run'), references: under(values.references, 'references.json'),
      comfy: comfyUrl(values.comfy!), minutes, smoke: values.smoke, workflow: values.workflow, checkpoint: values.checkpoint, seeds,
      tokenizers: values.tokenizers, timeoutMs: timeout * 1000, waitMs: wait * 1000, log: report });
    report({ event: 'identity_drawn', drawn: index.pictures.length, failed: index.failures.length, stopped: index.stopped, error: index.error });
    if (index.error) process.exitCode = 1;
  } else if (command === 'bundles') {
    buildIdentityBundles(under(values.out, 'run'), report);
  } else if (command === 'report') {
    for (const line of reportLines(identityReport(under(values.out, 'run'), values.portraits && resolve(values.portraits)))) console.log(line);
  } else if (command === 'dry-run') {
    await dryRun(values.out ?? mkdtempSync(join(tmpdir(), 'simple-chat-identity-dry-')), values.tokenizers);
  } else throw new Error('Use: image-identity.ts set|draw|bundles|report|dry-run (docs/illustrations-plan.md, "The identity runbook")');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
