// The identity measurement of docs/illustrations-plan.md ("The identity runbook"): does a person drawn from a portrait
// come back the same in the next frame, face and figure, and what does that cost the card. Three arms over one fixed
// synthetic set (examples/identity-set.ts), every frame from two seeds, all on one canvas, 1280x704:
//   A  text only on the edit graph: the frame's text, looks included, with every reference slot taken out. A matched
//      text-only baseline, and not the bot, which draws on the text-to-image graph; the control below is that;
//   B  the same text, and the portraits of the people the frame binds (local/image-batch.ts `bindingPlan`);
//   C  the same portraits, and the whole look of each bound person, build included, replaced by the number of their
//      picture. C asks whether the figure comes from the portrait alone, which is the owner's question.
// The commands, in the runbook's order, all in one directory (`--dir`, illustrations/identity by default):
//   set        the set and the portraits' prompts, as prompts directories
//   portraits  one portrait per person on the text-to-image graph, and the references file that binds them
//   draw       the arms: `--smoke` first, then the main set and after it the text-to-image control, cost only
//   report     geometry, time, memory and prompt length per arm, and the gates once the answers are in
//   bundles    one blind bundle per arm and seed, with the sheet of checks the gates count
//   dry-run    all of it against local/fake-comfy.ts, with fake answers, and no card
// Every stage that draws takes `--until`, the end of its work on the wall clock in epoch seconds: nothing is sent after
// it, and only a job already submitted gets a minute more, for its own stop (image-batch.ts `DrawOptions`). It also
// takes `--comfy`, the tunnel's address, `--wait`, the seconds one picture may take (300), `--timeout`, the seconds one
// request may take (60), and `--tokenizers`. The transformer is the one the card's record verified, and no other.
// Nothing here talks to a model, and what it prints is counts, sizes, times and verdicts.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { assemblePrompt, matchSheet } from './illustrate.ts';
import type { Case } from './illustrate-probe.ts';
import { ARMS, REVIEW, bindingPlan, comfyUrl, draw, encoderResolution, parseSeeds, pngSize, referenceGeometry, stopsTheRun,
  taskMarkdown, textEncoderOf } from './image-batch.ts';
import type { Arm, BatchIndex, Failure, Graph, Picture, References } from './image-batch.ts';
import { PORTRAIT_ACTION, PORTRAIT_CLOTHES, PORTRAIT_STYLE, portraitCanvas, portraitCases, referencesOf } from './image-portraits.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';
import { readManifest } from './tokenizer-extract.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { IDENTITY_BINDING, IDENTITY_CONTROL, IDENTITY_SEEDS, IDENTITY_SMOKE, IDENTITY_STORY, identityFrames, identitySheet } from '../examples/identity-set.ts';

const ROOT = resolve(import.meta.dirname, '..');
const EDIT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen-edit.json');
const PORTRAIT_GRAPH = join(ROOT, 'gpu', 'image-workflow-qwen.json');
const MANIFEST = join(ROOT, 'gpu', 'image-manifest.env');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const readGraph = (file: string): Graph => JSON.parse(readFileSync(file, 'utf8'));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return !sorted.length ? undefined : sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

// Every frame of every arm, and of the control, is drawn on this canvas whatever size the portraits are: the sampler's
// latent is the edit graph's own `EmptyLatentImage`, never the latent the encode node would make of the first portrait.
export const IDENTITY_CANVAS = { width: 1280, height: 704 };
// The numbers the measurement is judged by, fixed before the paid run (docs/illustrations-plan.md, "The gates"), and
// the budget's. No other number in this file decides anything.
export const CRITERIA = {
  transitions: 20, face: 0.9, figure: 0.9, // gate 1: recognition, over at least this many transitions
  gain: 0.15, high: 0.9, below: 0.05, // gate 2: against A, and C's rule when A is already this high
  changed: 0.9, // gate 3: the frames' own changes of clothes shown right
  median: 1.5, slowest: 2, // gate 4: warm frames against A's, matched
  headroomMiB: 2048, // gate 5: the card left free at a frame of four
  margin: 1.25, cellMs: 3000, // the budget: a cell's time in the smoke times this, and the seconds around its job
};
const atLeast = (part: number, share: number, whole: number) => part >= share * whole - 1e-9;
// Each arm by what it is, in the words of the docs, the report and the bundle keys.
export const armName = (arm: Arm) => arm === 'A' ? `text only on the edit graph, ${IDENTITY_CANVAS.width}x${IDENTITY_CANVAS.height}`
  : arm === 'B' ? 'the same text and the bound portraits' : 'the bound portraits, their looks replaced by the number of their picture';

// The set as illustrate-probe.ts writes a prompts directory, each prompt assembled by the bot's own `assemblePrompt`.
export function identityCases(): Case[] {
  return identityFrames.map((frame, order) => ({ id: frame.id, scenario: IDENTITY_STORY, index: order + 1, scene: frame.scene,
    sheet: identitySheet, description: frame.description, ...assemblePrompt(frame.description, identitySheet) }));
}

// The measurement's directory as the runbook fills it: the set and the portraits' prompts, the card's record, the
// portraits and the references file that binds them, the arms' run, and the control's.
export function layout(directory: string) {
  const root = resolve(directory);
  return { root, set: join(root, 'set'), portraitPrompts: join(root, 'portrait-prompts'), card: join(root, 'card.txt'),
    portraits: join(root, 'portraits'), references: join(root, 'references.json'), run: join(root, 'run'), control: join(root, 'control') };
}
type Paths = ReturnType<typeof layout>;
const readIndex = (directory: string): BatchIndex | undefined =>
  existsSync(join(directory, 'index.json')) ? JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) : undefined;

// `set`: the set and one portrait case per person, both from examples/identity-set.ts and nothing else.
export function writeSet(directory: string): Paths {
  const paths = layout(directory);
  for (const [folder, cases] of [[paths.set, identityCases()], [paths.portraitPrompts, portraitCases(identityCases())]] as const) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'prompts.json'), JSON.stringify(cases, null, 2), { mode: 0o600 });
  }
  return paths;
}

// The bootstrap's own record of the card: gpu/image-bootstrap.sh writes image-verified.txt once every file is
// verified, the ComfyUI revision it checked out and the SHA256 of each file, and the runbook copies it here over ssh
// before the first job. A record that differs from the manifest, or none, is refused: a pin nobody read off the card
// is a guess.
export function cardOf(file: string) {
  const manifest = readManifest(MANIFEST);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  const revision = lines.find(line => line.startsWith('revision '))?.slice('revision '.length).trim();
  const verified = new Map(lines.flatMap(line => {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    return match ? [[match[2], match[1]] as const] : [];
  }));
  const wanted: Record<string, [string | undefined, string | undefined]> = { comfyuiRevision: [revision, manifest.COMFYUI_REVISION],
    transformer: [verified.get(manifest.IMAGE_QWEN_MODEL_FILE), manifest.IMAGE_QWEN_MODEL_SHA256],
    encoder: [verified.get(manifest.IMAGE_QWEN_ENCODER_FILE), manifest.IMAGE_QWEN_ENCODER_SHA256],
    vae: [verified.get(manifest.IMAGE_QWEN_VAE_FILE), manifest.IMAGE_QWEN_VAE_SHA256] };
  const wrong = Object.keys(wanted).filter(key => !wanted[key][0] || wanted[key][0] !== wanted[key][1]);
  if (wrong.length) {
    throw new Error(`${lines.length ? `The card's record ${file} differs from gpu/image-manifest.env in ${wrong.join(', ')}` : `No record of the card at ${file}`}; `
      + 'copy image-verified.txt off the card as the runbook says before anything is drawn');
  }
  return { comfyuiRevision: revision!, model: manifest.IMAGE_QWEN_MODEL_FILE, transformer: wanted.transformer[0]!, encoder: wanted.encoder[0]!, vae: wanted.vae[0]! };
}
// That record as the bootstrap writes it, made from the manifest for the dry run.
function writeCardRecord(file: string) {
  const manifest = readManifest(MANIFEST);
  const files = ['MODEL', 'ENCODER', 'VAE'].map(kind => `${manifest[`IMAGE_QWEN_${kind}_SHA256`]}  ${manifest[`IMAGE_QWEN_${kind}_FILE`]}`);
  writeFileSync(file, [`revision ${manifest.COMFYUI_REVISION}`, ...files, ''].join('\n'), { mode: 0o600 });
}

// What the pictures depend on beyond the graph, whose hash the index keeps already. Every stage: the revision and the
// weights the card's record says the bootstrap verified — the experiment draws with that transformer and no other,
// so there is no checkpoint to choose — and the portraits' recipe, so that nobody resumes under another. The frames
// add the set, the portraits themselves, the seeds, the canvas, the size a portrait reaches the encoder at and where
// the graph keeps its cache. image-batch.ts refuses a resume under any other value, and under a server that no longer
// says what it is.
export function pinsOf(card: ReturnType<typeof cardOf>): Record<string, string | number> {
  const canvas = portraitCanvas(readGraph(PORTRAIT_GRAPH));
  return { comfyuiRevision: card.comfyuiRevision, transformer: card.transformer,
    encoder: card.encoder, vae: card.vae, portraitClothes: PORTRAIT_CLOTHES, portraitStyle: PORTRAIT_STYLE, portraitAction: PORTRAIT_ACTION,
    portraitCanvas: `${canvas.width}x${canvas.height}`, portraitGraph: sha256(readFileSync(PORTRAIT_GRAPH)) };
}
function framePins(paths: Paths, graph: Graph, references: References): Record<string, string | number> {
  const portraits = createHash('sha256');
  for (const one of identitySheet) portraits.update(readFileSync(resolve(dirname(paths.references), references[IDENTITY_STORY][one.name])));
  const cache = Object.values(graph).find(node => node.class_type === 'QwenImage21Cache');
  const canvas = portraitCanvas(readGraph(PORTRAIT_GRAPH)), resolution = encoderResolution(graph) ?? -1;
  return { cacheDevice: String(cache?.inputs.device ?? 'none'), resolution, set: sha256(readFileSync(join(paths.set, 'prompts.json'))),
    portraits: portraits.digest('hex'), seeds: IDENTITY_SEEDS.join(','), canvas: `${IDENTITY_CANVAS.width}x${IDENTITY_CANVAS.height}`,
    referenceSize: referenceGeometry(canvas.width, canvas.height, Math.max(0, resolution)).join('x') };
}

// The portraits the frames are bound to, checked before the smoke: all six people have one, on the portrait canvas,
// none failed, and every frame binds exactly whom examples/identity-set.ts says it binds, in that order. Anything less
// ends the measurement here, incomplete: no portrait is drawn again, retried or chosen, and no smoke starts on a set
// whose look-alikes have quietly lost their faces. The binding keeps its prefix rule: the ferryman's frame needs it.
export function portraitsOf(paths: Paths): References {
  const references: References = existsSync(paths.references) ? JSON.parse(readFileSync(paths.references, 'utf8')) : {};
  const story = references[IDENTITY_STORY] ?? {};
  const canvas = portraitCanvas(readGraph(PORTRAIT_GRAPH));
  const drawn = identitySheet.filter(one => {
    const path = story[one.name] ? resolve(dirname(paths.references), story[one.name]) : '';
    if (!path || !existsSync(path)) return false;
    const size = pngSize(readFileSync(path));
    return size.width === canvas.width && size.height === canvas.height;
  }).length;
  const failed = readIndex(paths.portraits)?.failures.length ?? 0;
  const otherwise = identityCases().filter(one => bindingPlan(one, references).map(bound => bound.name).join() !== IDENTITY_BINDING[one.id]?.join()).length;
  if (drawn < identitySheet.length || failed || otherwise) {
    throw new Error(`The portraits are not all there: ${drawn} of ${identitySheet.length} on the ${canvas.width}x${canvas.height} canvas, ${failed} failed, `
      + `${otherwise} of ${identityFrames.length} frames bound otherwise than the set says. The measurement ends here, incomplete`);
  }
  return references;
}

// What every frame is held to: its file at the canvas, as many references as the set binds for it (none in A), and
// each of them at the size the pins say a portrait reaches the encoder at.
function rightGeometry(index: BatchIndex, root: string) {
  const canvas = `${IDENTITY_CANVAS.width}x${IDENTITY_CANVAS.height}`, reference = String(index.pins?.referenceSize ?? '-');
  return (picture: Picture) => {
    const path = join(root, picture.file);
    if (!existsSync(path)) return false;
    const size = pngSize(readFileSync(path)), bound = picture.arm === 'A' ? 0 : IDENTITY_BINDING[picture.caseId]?.length;
    return `${size.width}x${size.height}` === canvas && picture.references === bound && picture.referenceSizes?.length === bound
      && picture.referenceSizes.every(one => one.join('x') === reference);
  };
}
function geometryOf(index: BatchIndex, root: string, pictures: Picture[]) {
  const right = rightGeometry(index, root);
  const wrong = pictures.filter(picture => !right(picture)).length;
  return { canvas: `${IDENTITY_CANVAS.width}x${IDENTITY_CANVAS.height}`, reference: String(index.pins?.referenceSize ?? '-'),
    pictures: pictures.length, wrong, pass: pictures.length > 0 && !wrong };
}

// The card's side of gate 5: no cell ran out of memory, and every frame of four references was drawn, sampled while
// it ran, and left the headroom of CRITERIA free at its highest. A frame of four that failed or was never sampled is a
// peak nobody measured, and fails the gate as an OOM does. RAM and partial loads are shown, not gated.
function memoryOf(pictures: Picture[], failures: Failure[]) {
  const four = pictures.filter(picture => (picture.references ?? 0) >= 4);
  const headroom = four.map(picture => picture.vramSamples && picture.vram[0]?.occupiedMiBMax !== undefined
    ? picture.vram[0].totalMiB - picture.vram[0].occupiedMiBMax : undefined);
  const least = headroom.length && headroom.every(value => value !== undefined) ? Math.min(...headroom as number[]) : undefined;
  const oom = failures.filter(failure => failure.oom).length, lost = failures.filter(failure => (failure.references ?? 0) >= 4).length;
  return { oom, four: four.length, lost, unmeasured: headroom.filter(value => value === undefined).length, headroomMiB: least,
    occupiedMiB: Math.max(0, ...pictures.map(picture => picture.vram[0]?.occupiedMiBMax ?? 0)),
    ramMiB: Math.max(0, ...pictures.map(picture => picture.ramMiB?.max ?? 0)),
    partialModelLoadEvents: pictures.reduce((total, picture) => total + (picture.partialModelLoadEvents ?? 0), 0),
    pass: !oom && !lost && four.length > 0 && least !== undefined && least >= CRITERIA.headroomMiB };
}

// A frame whose job the socket heard from its start: where its time went, and whether any loader ran.
const heard = (picture: Picture) => picture.phases?.sampleMs !== undefined && picture.loaderCacheMiss !== undefined;
// A warm frame: every loader of its job was answered from the node cache, and it is not its arm's first.
const warm = (picture: Picture) => picture.loaderCacheMiss === false && !picture.first;
// What gate 4 compares: each warm frame of the arm, with A's warm frame of the same scene and seed.
const pairsOf = (arm: Arm, pictures: Picture[]) => pictures.filter(picture => picture.arm === arm && warm(picture)).flatMap(picture => {
  const other = pictures.find(one => one.arm === 'A' && one.caseId === picture.caseId && one.seed === picture.seed && warm(one));
  return other ? [[picture.totalMs, other.totalMs] as [number, number]] : [];
});

// The smoke: the frame with one portrait and the frame with four, at the first seed, in every arm. It passes only with
// all six drawn and none failed, on the right geometry, within the card's memory, and with what gate 4 needs: every
// picture's phases and loader answer heard on the socket, and a warm frame of B and of C matched in A. Anything less and
// the main set is refused in that directory, and the measurement ends there.
export function smokeOf(index: BatchIndex, root: string) {
  const ours = <T extends { caseId: string; seed: number }>(list: T[]) => list.filter(one => one.seed === IDENTITY_SEEDS[0] && IDENTITY_SMOKE.includes(one.caseId));
  const pictures = ours(index.pictures), failures = ours(index.failures);
  const drawn = !failures.length && IDENTITY_SMOKE.every(caseId => ARMS.every(arm => pictures.some(one => one.caseId === caseId && one.arm === arm)));
  const geometry = geometryOf(index, root, pictures).pass, memory = memoryOf(pictures, failures).pass;
  const telemetry = pictures.length > 0 && pictures.every(heard) && pairsOf('B', pictures).length > 0 && pairsOf('C', pictures).length > 0;
  return { drawn, geometry, memory, telemetry, pass: drawn && geometry && memory && telemetry };
}

// What a cell is expected to take, from the smoke's own frames: A's first and warm frames for a frame without portraits,
// and for n portraits the slowest frame of one and a straight line to the slowest of four, uploads included; then the
// margin, and the seconds around a job that its own time leaves out.
export function etaOf(index: BatchIndex): (references: number, first: boolean) => number {
  const smoke = index.pictures.filter(picture => picture.seed === IDENTITY_SEEDS[0] && IDENTITY_SMOKE.includes(picture.caseId));
  const slowest = (pictures: Picture[]) => Math.max(0, ...pictures.map(picture => picture.totalMs + (picture.uploadMs ?? 0)));
  const text = smoke.filter(picture => picture.arm === 'A');
  const one = slowest(smoke.filter(picture => picture.references === 1)), four = slowest(smoke.filter(picture => picture.references === 4));
  return (references, first) => CRITERIA.cellMs + CRITERIA.margin * (references === 0
    ? slowest(text.filter(picture => !!picture.first === first)) || slowest(text)
    : one + (references - 1) * Math.max(0, four - one) / 3);
}

export type StageOptions = { stage: 'portraits' | 'smoke' | 'main'; dir: string; comfy: string; until: number;
  tokenizers?: string; timeoutMs?: number; waitMs?: number; pollMs?: number; log?: (event: object) => void };
// The one runner around image-batch.ts `draw`, for each drawing stage of the runbook. Each reads the card's record
// first and is pinned to it, asks for the socket that hears a job from its start and fails a cell without it, sends
// nothing and waits for nothing past `until` but a submitted job's own stop (`DrawOptions`), and draws no cell again
// that failed:
//   portraits  one per person on the text-to-image graph, upright on its canvas turned, and the references file;
//   smoke      once the portraits are all there and bind as the set says;
//   main       once the smoke has passed, and only if the whole set can end before `until` by the smoke's own times;
//              then, after a complete main set, the control: the text-to-image graph at the frames' canvas, cost only,
//              and once: a control the end cut short, or that was never begun because it could not end in time, stays so.
export async function drawStage(options: StageOptions): Promise<BatchIndex> {
  const paths = layout(options.dir);
  const card = cardOf(paths.card);
  const pins = pinsOf(card);
  const common = { comfy: options.comfy, checkpoints: [card.model], negative: '', timeoutMs: options.timeoutMs ?? 60000,
    waitMs: options.waitMs ?? 300000, pollMs: options.pollMs, until: options.until, requireSocket: true, log: options.log };
  if (options.stage === 'portraits') {
    if (readIndex(paths.portraits)?.failures.some(failure => !stopsTheRun(failure.code))) {
      throw new Error('A portrait failed in this directory: the measurement is incomplete, and no portrait is drawn again');
    }
    const index = await draw({ ...common, prompts: paths.portraitPrompts, out: paths.portraits, seeds: IDENTITY_SEEDS.slice(0, 1),
      workflow: PORTRAIT_GRAPH, ...portraitCanvas(readGraph(PORTRAIT_GRAPH)), pins });
    const bound = referencesOf(index, portraitCases(identityCases()), dirname(paths.references), paths.portraits);
    writeFileSync(paths.references, JSON.stringify(bound, null, 2), { mode: 0o600 });
    return index;
  }
  const references = portraitsOf(paths);
  const graph = readGraph(EDIT_GRAPH);
  const tokenizer = loadTokenizers(resolve(options.tokenizers ?? join(ROOT, 'tokenizers'))).qwen();
  const encoder = textEncoderOf(graph);
  const framed = { ...pins, ...framePins(paths, graph, references) };
  const arms = { ...common, prompts: paths.set, out: paths.run, workflow: EDIT_GRAPH, ...IDENTITY_CANVAS, references: paths.references,
    arms: ARMS, pins: framed,
    tokens: tokenizer && encoder ? (prompt: string, images: number) => qwenPromptTokens(tokenizer, prompt, encoder, { images }) : undefined };
  if (options.stage === 'smoke') return draw({ ...arms, seeds: IDENTITY_SEEDS.slice(0, 1), only: IDENTITY_SMOKE });
  const drawn = readIndex(paths.run);
  const smoke = drawn && smokeOf(drawn, paths.run);
  if (!drawn || !smoke?.pass) {
    throw new Error(`The main set is drawn only after the smoke has passed in the same directory (draw --smoke): ${smoke
      ? `drawn ${smoke.drawn}, geometry ${smoke.geometry}, memory ${smoke.memory}, telemetry ${smoke.telemetry}` : 'no smoke there'}`);
  }
  const estimate = etaOf(drawn);
  const index = await draw({ ...arms, seeds: IDENTITY_SEEDS, estimate });
  if (identityReport(options.dir).complete && !readIndex(paths.control)) {
    await draw({ ...common, prompts: paths.set, out: paths.control, workflow: PORTRAIT_GRAPH, ...IDENTITY_CANVAS,
      seeds: IDENTITY_SEEDS.slice(0, 1), only: IDENTITY_CONTROL, pins: { ...pins, set: framed.set, canvas: framed.canvas }, estimate });
  }
  return index;
}

// The items a judge answers `yes`, `no` or `unsure` to (image-batch.ts `taskMarkdown`, the identity variant).
type Item = 'face' | 'figure' | 'action' | 'apart' | 'swap' | 'clothes' | 'style';
export type Check = { id: string; kind: 'transition' | 'picture' | 'clothes' | 'style'; person?: string; from?: string; to?: string;
  picture?: string; pictures?: string[]; items: Item[] };
export type Answers = { answers?: Record<string, Partial<Record<Item, string>>> };
type Key = { arm: Arm; armIs: string; seed: number; checkpoint: string; pictures: { picture: string; caseId: string; file: string; sha256: string }[] };
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
// from image 1" and would name the arm. Bundles are built once, the answers are read against them, and a run that gets
// no verdict gets no bundles: an incomplete set is not judged in pieces.
export function buildIdentityBundles(directory: string, log: (event: object) => void = () => undefined): string[] {
  const root = layout(directory).run;
  const index: BatchIndex = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  if (!index.arms) throw new Error(`${root} is not an identity run; bundle it with npm run image:batch -- bundles`);
  if (existsSync(join(root, REVIEW))) throw new Error(`${join(root, REVIEW)} exists: bundles are built once, and the answers are read against them`);
  const judged = identityReport(directory);
  if (!judged.judged) throw new Error(`${root} gets no verdict (${judged.verdict}), and so no bundles to judge`);
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
    const key: Key = { arm: pictures[0].arm!, armIs: armName(pictures[0].arm!), seed: pictures[0].seed, checkpoint: pictures[0].checkpoint,
      pictures: entries.map(({ picture, source }) => ({ picture, caseId: source.caseId, file: source.file, sha256: source.sha256 })) };
    writeFileSync(join(root, 'keys', `${name}.json`), JSON.stringify(key, null, 2), { mode: 0o600 });
    log({ event: 'bundle_written', bundle: name, pictures: entries.length });
    return name;
  });
}

// The checks where arm C's text really lost the person's look (`removed`: bound in the frame, or in both frames of a
// transition), and those where the binding stopped before the person and the look stayed (`kept`). The same split is
// counted for every arm, so that C is read against B on the same checks.
type Part = { transitions: number; face: number; figure: number; pictures: number; actionFailed: number; clothes: number; clothesYes: number };
type Tally = { bundles: number; missing: number; transitions: number; face: number; figure: number; both: number; pictures: number;
  actionFailed: number; together: number; apartFailed: number; swapFailed: number; clothes: number; clothesYes: number;
  changed: number; changedYes: number; styleYes: number; removed: Part; kept: Part };
const part = (): Part => ({ transitions: 0, face: 0, figure: 0, pictures: 0, actionFailed: 0, clothes: 0, clothesYes: 0 });
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
    const tally = tallies[key.arm] ??= { bundles: 0, missing: 0, transitions: 0, face: 0, figure: 0, both: 0, pictures: 0, actionFailed: 0,
      together: 0, apartFailed: 0, swapFailed: 0, clothes: 0, clothesYes: 0, changed: 0, changedYes: 0, styleYes: 0, removed: part(), kept: part() };
    tally.bundles++;
    const entries = key.pictures.map(({ picture, caseId }) => ({ picture, one: cases.find(one => one.id === caseId)! }));
    const oneOf = (picture: string) => entries.find(entry => entry.picture === picture)!.one;
    const lost = (person: string, picture: string) => IDENTITY_BINDING[oneOf(picture).id]?.includes(person) ?? false;
    for (const check of checksOf(entries)) {
      const yes = (item: Item) => {
        const said = given[check.id]?.[item];
        if (said === undefined) tally.missing++;
        return said === 'yes' ? 1 : 0;
      };
      if (check.kind === 'transition') {
        const face = yes('face'), figure = yes('figure');
        tally.transitions++; tally.face += face; tally.figure += figure; tally.both += face * figure;
        const into = lost(check.person!, check.from!) && lost(check.person!, check.to!) ? tally.removed : tally.kept;
        into.transitions++; into.face += face; into.figure += figure;
      } else if (check.kind === 'picture') {
        const failed = 1 - yes('action');
        tally.pictures++; tally.actionFailed += failed;
        const into = sheetPeople(oneOf(check.picture!)).every(person => lost(person.name, check.picture!)) ? tally.removed : tally.kept;
        into.pictures++; into.actionFailed += failed;
        if (check.items.includes('apart')) { tally.together++; tally.apartFailed += 1 - yes('apart'); tally.swapFailed += 1 - yes('swap'); }
      } else if (check.kind === 'clothes') {
        const kept = yes('clothes');
        tally.clothes++; tally.clothesYes += kept;
        if (sheetPeople(oneOf(check.picture!)).some(person => person.name === check.person && person.changed)) { tally.changed++; tally.changedYes += kept; }
        const into = lost(check.person!, check.picture!) ? tally.removed : tally.kept;
        into.clothes++; into.clothesYes += kept;
      } else tally.styleYes += yes('style');
    }
  }
  return tallies;
}

type Gate = { gate: number; status: 'pass' | 'fail' | 'unscored' | 'unmeasured'; detail: string };
const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '-';

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
    gates.push({ gate: 1, status: transitions >= CRITERIA.transitions && atLeast(face, CRITERIA.face, transitions)
      && atLeast(figure, CRITERIA.figure, transitions) && !apartFailed ? 'pass' : 'fail',
    detail: `face ${percent(face, transitions)}, figure ${percent(figure, transitions)} of ${transitions} transitions, ${apartFailed} mixed up` });
  }
  if (!both) gates.push({ gate: 2, status: 'unscored', detail: 'answers missing' });
  else {
    const gain = recognised(own!) - recognised(base!), shorter = text[arm] !== undefined && text.A !== undefined && text[arm]! < text.A;
    const high = recognised(base!) >= CRITERIA.high - 1e-9;
    const pass = high ? arm === 'C' && gain >= -CRITERIA.below - 1e-9 && shorter && own!.actionFailed <= base!.actionFailed
      : gain >= CRITERIA.gain - 1e-9;
    gates.push({ gate: 2, status: pass ? 'pass' : 'fail', detail: `face and figure ${percent(own!.both, own!.transitions)} against A's ${percent(base!.both, base!.transitions)}`
      + (high ? `; A is at ${CRITERIA.high * 100}% or more, so only a shorter C may pass (${text[arm]} against ${text.A})` : '') });
  }
  // Gate 3 as Astra wrote it before the rental: the clothes the frames themselves change, each shown right, no person
  // with another's look and clothes, and no more action errors than A. Every appearance is shown beside it, and never
  // dilutes the changes: a picture that kept the portrait's clothes is not a frame that kept its own.
  if (!both) gates.push({ gate: 3, status: 'unscored', detail: 'answers missing' });
  else {
    const { clothes, clothesYes, changed, changedYes, swapFailed, actionFailed } = own!;
    gates.push({ gate: 3, status: changed > 0 && atLeast(changedYes, CRITERIA.changed, changed) && !swapFailed && actionFailed <= base!.actionFailed ? 'pass' : 'fail',
      detail: `the frames' own changes of clothes right in ${changedYes} of ${changed}, ${swapFailed} swapped, action errors ${actionFailed} against A's ${base!.actionFailed}; `
        + `every appearance, not gated: ${clothesYes} of ${clothes}` });
  }
  // A frame the socket did not hear is neither warm nor cold but unknown, and dropping it could take the slowest frames
  // out of the count: one such frame of the arm or of A leaves the gate unmeasured, never passed.
  const pairs = pairsOf(arm, pictures);
  const unheard = pictures.filter(picture => (picture.arm === arm || picture.arm === 'A') && !heard(picture)).length;
  if (unheard || !pairs.length) {
    gates.push({ gate: 4, status: 'unmeasured', detail: unheard ? `${unheard} frames of ${arm} and A without the socket's account of their job` : 'no warm frame matched in A' });
  } else {
    const [mine, theirs] = [median(pairs.map(pair => pair[0]))!, median(pairs.map(pair => pair[1]))!];
    const [slowest, baseline] = [Math.max(...pairs.map(pair => pair[0])), Math.max(...pairs.map(pair => pair[1]))];
    gates.push({ gate: 4, status: mine <= CRITERIA.median * theirs && slowest <= CRITERIA.slowest * baseline ? 'pass' : 'fail',
      detail: `warm median ${mine} ms against ${theirs}, slowest ${slowest} against ${baseline}, over ${pairs.length} matched frames` });
  }
  const memory = memoryOf(pictures.filter(picture => picture.arm === arm), failures.filter(failure => failure.arm === arm));
  gates.push({ gate: 5, status: memory.pass ? 'pass' : 'fail', detail: `${memory.oom} OOM, ${memory.four} frames of four drawn, ${memory.lost} failed, `
    + `${memory.unmeasured} unmeasured, least headroom ${memory.headroomMiB ?? '-'} MiB of the ${CRITERIA.headroomMiB} asked for` });
  return gates;
}

type ArmSummary = { drawn: number; failed: number; references: Record<string, number>; warm: number; warmMedianMs?: number;
  slowestWarmMs?: number; firstMs?: number; firstMiss?: boolean; uploadMs: number; encodeMs?: number; sampleMs?: number;
  memory: ReturnType<typeof memoryOf>; text?: number; tally?: Tally };

// Everything the directory says, and the gates once `answers/` holds a judge's answers for every bundle. A cell that
// failed stays in the record as its result, and a set that is missing one, or was cut short, is incomplete: it gets no
// gates and no verdict, whatever the surviving cells would say. So does a set whose geometry or smoke failed.
export function identityReport(directory: string) {
  const paths = layout(directory), root = paths.run;
  const index: BatchIndex = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  const cases: Case[] = JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8'));
  const arms = index.arms ?? [];
  const seeds = parseSeeds(String(index.pins?.seeds ?? ''));
  const right = rightGeometry(index, root);
  const expected = cases.flatMap(one => seeds.flatMap(seed => arms.map(arm => ({ caseId: one.id, seed, arm }))));
  const good = expected.filter(cell => index.pictures.some(picture => picture.caseId === cell.caseId && picture.seed === cell.seed
    && picture.arm === cell.arm && right(picture))).length;
  const complete = expected.length > 0 && good === expected.length && !index.failures.length && !index.stopped && !index.error;
  const geometry = geometryOf(index, root, index.pictures), smoke = smokeOf(index, root);
  const judged = complete && geometry.pass && smoke.pass;
  const ofArm = (arm: Arm) => index.pictures.filter(picture => picture.arm === arm);
  const tokens = index.pictures.length > 0 && index.pictures.every(picture => picture.promptTokens !== undefined);
  const text = Object.fromEntries(ARMS.map(arm => [arm, median(ofArm(arm).map(picture => (tokens ? picture.promptTokens : picture.promptChars) ?? 0))])) as Record<Arm, number | undefined>;
  const tallies = scoresOf(root, cases);
  const gates: Record<string, Gate[]> = judged ? Object.fromEntries(arms.filter(arm => arm !== 'A')
    .map(arm => [arm, gatesOf(arm, index.pictures, index.failures, tallies, text)])) : {};
  const verdicts = Object.entries(gates).map(([arm, list]) => `${arm} ${list.some(gate => gate.status === 'fail') ? 'fails'
    : list.every(gate => gate.status === 'pass') ? 'passes' : 'is open'}`);
  const summaries: Record<string, ArmSummary> = Object.fromEntries(arms.map(arm => {
    const pictures = ofArm(arm), warmOnes = pictures.filter(warm), first = pictures.find(picture => picture.first);
    const references: Record<string, number> = {};
    for (const picture of pictures) references[picture.references ?? 0] = (references[picture.references ?? 0] ?? 0) + 1;
    return [arm, { drawn: pictures.length, failed: index.failures.filter(failure => failure.arm === arm).length, references,
      warm: warmOnes.length, warmMedianMs: median(warmOnes.map(picture => picture.totalMs)),
      slowestWarmMs: warmOnes.length ? Math.max(...warmOnes.map(picture => picture.totalMs)) : undefined,
      firstMs: first?.totalMs, firstMiss: first?.loaderCacheMiss, uploadMs: pictures.reduce((total, picture) => total + (picture.uploadMs ?? 0), 0),
      encodeMs: median(warmOnes.flatMap(picture => picture.phases?.encodeMs ?? [])),
      sampleMs: median(warmOnes.flatMap(picture => picture.phases?.sampleMs ?? [])),
      memory: memoryOf(pictures, index.failures.filter(failure => failure.arm === arm)), text: text[arm], tally: tallies[arm] }];
  }));
  const portraits = readIndex(paths.portraits), control = readIndex(paths.control);
  // The control: the same frames on the text-to-image graph at the frames' canvas, against A's warm frames of the same
  // scenes and seed. What the bot's own graph costs, and nothing a gate reads.
  const controlWarm = control?.pictures.filter(warm) ?? [];
  const matched = ofArm('A').filter(picture => warm(picture) && picture.seed === IDENTITY_SEEDS[0] && controlWarm.some(one => one.caseId === picture.caseId));
  return {
    directory: root, expected: expected.length, good, drawn: index.pictures.length, failed: index.failures.length, complete, judged,
    stopped: index.stopped, error: index.error, pins: index.pins ?? {}, geometry, smoke,
    portraits: portraits && { drawn: portraits.pictures.length, failed: portraits.failures.length, canvas: `${portraits.comfy.width}x${portraits.comfy.height}`,
      firstMs: portraits.pictures.find(picture => picture.first)?.totalMs, medianMs: median(portraits.pictures.filter(picture => !picture.first).map(picture => picture.totalMs)) },
    control: control && { drawn: control.pictures.length, failed: control.failures.length, stopped: control.stopped, error: control.error,
      firstMs: control.pictures.find(picture => picture.first)?.totalMs, warm: controlWarm.length,
      warmMedianMs: median(controlWarm.map(picture => picture.totalMs)), matchedMs: median(matched.map(picture => picture.totalMs)) },
    arms: summaries, unit: tokens ? 'tokens' : 'characters', gates,
    verdict: !complete ? 'incomplete' : !judged ? 'no verdict: the geometry or the smoke failed' : verdicts.join(', '),
  };
}
export type IdentityReport = ReturnType<typeof identityReport>;

// The report as a person reads it.
export function reportLines(report: IdentityReport): string[] {
  const { geometry, smoke, arms } = report;
  const pass = (value: boolean) => value ? 'pass' : 'FAIL';
  const lines = [
    `identity run ${report.directory}`,
    ...Object.keys(arms).map(arm => `  ${arm}: ${armName(arm as Arm)}`),
    `  cells: ${report.good} of ${report.expected} drawn on the right geometry (${report.drawn} pictures, ${report.failed} failed)${report.stopped === 'budget' ? ', stopped by the end of the rental' : ''}${report.error ? `, stopped by ${report.error}` : ''}`,
    `  pins: ${Object.entries(report.pins).map(([key, value]) => `${key} ${String(value).slice(0, 12)}`).join(', ')}`,
    `  geometry ${pass(geometry.pass)}: ${geometry.pictures - geometry.wrong} of ${geometry.pictures} pictures at ${geometry.canvas}, each with the references the set binds, at ${geometry.reference}`,
    `  smoke (${IDENTITY_SMOKE.join(', ')}, first seed): drawn ${smoke.drawn}, geometry ${pass(smoke.geometry)}, memory ${pass(smoke.memory)}, telemetry ${pass(smoke.telemetry)}`,
  ];
  const { portraits, control } = report;
  if (portraits) lines.push(`  portraits, a run of their own at ${portraits.canvas}: ${portraits.drawn} drawn, ${portraits.failed} failed, the first ${portraits.firstMs ?? '-'} ms, the rest median ${portraits.medianMs ?? '-'} ms`);
  lines.push(control ? `  control, the text-to-image graph at ${IDENTITY_CANVAS.width}x${IDENTITY_CANVAS.height}, cost only and not gated, drawn once: ${control.drawn} drawn`
    + `${control.stopped === 'budget' ? ', stopped by the end of the rental and never resumed' : ''}, the first ${control.firstMs ?? '-'} ms, warm median ${control.warmMedianMs ?? '-'} ms`
    + ` over ${control.warm}, against ${control.matchedMs ?? '-'} ms for the same frames in A` : '  control: not drawn; it follows a complete main set only');
  lines.push('  arm  frames  refs per frame      warm  median ms  slowest ms  first ms  upload ms  encode ms  sample ms');
  for (const [arm, one] of Object.entries(arms)) {
    const refs = Object.entries(one.references).map(([count, frames]) => `${count}:${frames}`).join(' ');
    lines.push(`  ${arm}    ${String(one.drawn).padEnd(6)}  ${refs.padEnd(18)}  ${String(one.warm).padEnd(4)}  ${String(one.warmMedianMs ?? '-').padEnd(9)}  ${String(one.slowestWarmMs ?? '-').padEnd(10)}  ${`${one.firstMs ?? '-'}${one.firstMiss ? ' miss' : ''}`.padEnd(8)}  ${String(one.uploadMs).padEnd(9)}  ${String(one.encodeMs ?? '-').padEnd(9)}  ${one.sampleMs ?? '-'}`);
  }
  lines.push('  (warm: every loader answered from the node cache and not the arm\'s first; "miss": a loader of the first frame ran)');
  lines.push('  arm  failed  OOM  frames of 4  least headroom MiB  occupied max MiB  RAM max MiB  partial-load events');
  for (const [arm, one] of Object.entries(arms)) {
    const memory = one.memory;
    lines.push(`  ${arm}    ${String(one.failed).padEnd(6)}  ${String(memory.oom).padEnd(3)}  ${String(memory.four).padEnd(11)}  ${String(memory.headroomMiB ?? '-').padEnd(18)}  ${String(memory.occupiedMiB).padEnd(16)}  ${String(memory.ramMiB).padEnd(11)}  ${memory.partialModelLoadEvents}`);
  }
  lines.push('  (RAM counts every process on the machine; no partial-load event does not prove the models stayed on the card)');
  lines.push(`  prompt, median ${report.unit}: ${Object.entries(arms).map(([arm, one]) => `${arm} ${one.text ?? '-'}`).join(', ')}`);
  for (const [arm, one] of Object.entries(arms)) {
    const tally = one.tally;
    if (!tally) { lines.push(`  ${arm} answers: no bundle yet`); continue; }
    lines.push(`  ${arm} answers: ${tally.bundles} bundles, ${tally.missing} items unanswered; face ${percent(tally.face, tally.transitions)}, figure ${percent(tally.figure, tally.transitions)}, both ${percent(tally.both, tally.transitions)} of ${tally.transitions} transitions; ${tally.apartFailed} mixed up and ${tally.swapFailed} swapped of ${tally.together}; action errors ${tally.actionFailed} of ${tally.pictures}; clothes ${percent(tally.clothesYes, tally.clothes)}; style ${tally.styleYes} of ${tally.bundles}`);
  }
  const [b, c] = [arms.B?.tally, arms.C?.tally];
  if (b && c) {
    lines.push(`  C against B, where C's text lost the look (${c.removed.transitions} transitions, ${c.removed.pictures} pictures, ${c.removed.clothes} appearances) | where the binding stopped and the look stayed (${c.kept.transitions}, ${c.kept.pictures}, ${c.kept.clothes}):`);
    const row = (name: string, of: (one: Part) => [number, number]) => {
      const say = (one: Part) => of(one).join('/');
      lines.push(`    ${name.padEnd(8)} C ${say(c.removed).padEnd(6)} B ${say(b.removed).padEnd(6)} | C ${say(c.kept).padEnd(6)} B ${say(b.kept)}`);
    };
    row('face', one => [one.face, one.transitions]);
    row('figure', one => [one.figure, one.transitions]);
    row('action', one => [one.pictures - one.actionFailed, one.pictures]);
    row('clothes', one => [one.clothesYes, one.clothes]);
  }
  lines.push('  what this measures: the 26 transitions of an arm are repeated observations of six people, not 26 independent characters;',
    '  a transition checks that two frames agree, and the figure against the look, not the face against its portrait. So a pass',
    '  proves no exact transfer of a face from reference to scene, and promises no identity beyond this set.');
  for (const [arm, list] of Object.entries(report.gates)) {
    for (const gate of list) lines.push(`  ${arm} gate ${gate.gate} ${gate.status}: ${gate.detail}`);
  }
  lines.push(`  verdict: ${report.verdict}`);
  return lines;
}

// Answers the dry run writes in place of a judge's, so that the counting and the gates run end to end. They are made
// up by rule and say nothing about any model: A loses the figure on every other transition; B misses the clothes of
// every fifth appearance the story does not change, which is shown and not gated; C is `unsure` of the first change of
// clothes in its bundle of the first seed, 7 of 8 then, one short of what gate 3 asks; everything else is `yes`.
function fakeAnswers(root: string, cases: Case[]) {
  mkdirSync(join(root, 'answers'), { recursive: true, mode: 0o700 });
  for (const file of readdirSync(join(root, 'keys'))) {
    const key: Key = JSON.parse(readFileSync(join(root, 'keys', file), 'utf8'));
    const entries = key.pictures.map(({ picture, caseId }) => ({ picture, one: cases.find(one => one.id === caseId)! }));
    const checks = checksOf(entries);
    const changed = checks.filter(check => check.kind === 'clothes' && sheetPeople(entries.find(entry => entry.picture === check.picture)!.one)
      .some(person => person.name === check.person && person.changed));
    const said = (check: Check, item: Item) => {
      const number = Number(check.id.slice(1));
      if (key.arm === 'A' && item === 'figure' && number % 2 === 1) return 'no';
      if (key.arm === 'B' && item === 'clothes' && !changed.includes(check) && number % 5 === 0) return 'no';
      return key.arm === 'C' && key.seed === IDENTITY_SEEDS[0] && check === changed[0] ? 'unsure' : 'yes';
    };
    const answers: Answers = { answers: Object.fromEntries(checks.map(check =>
      [check.id, Object.fromEntries(check.items.map(item => [item, said(check, item)]))])) };
    writeFileSync(join(root, 'answers', file), JSON.stringify(answers, null, 2), { mode: 0o600 });
  }
}

// A directory as one hash, every file's path and bytes in order: a refused resume has to leave the run as it was.
export function treeHash(directory: string): string {
  const hash = createHash('sha256');
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else hash.update(`${relative(directory, path)}\u0000`).update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest('hex');
}

// The whole runbook against local/fake-comfy.ts, in its order — the set and the card's record, the portraits, the
// smoke, the main set and the control, the bundles, fake answers and the report — and on the way every refusal the paid
// run relies on, each in a directory of its own. The fake's socket opens late on purpose, as one through a tunnel may,
// and a frame of four logs a partial load. No card and no model.
export async function dryRun(out: string, tokenizers?: string, say: (line: string) => void = console.log) {
  const root = resolve(out);
  // A job of a tenth of a second, so that the milliseconds around it do not decide gate 4 on a busy machine.
  const fake = await startFakeComfy({ jobMs: 100, openDelayMs: 30, partialLoadAtReferences: 4 });
  const stage = (name: StageOptions['stage'], dir = root, until = Date.now() + 10 * 60000) =>
    drawStage({ stage: name, dir, comfy: fake.url, until, tokenizers, pollMs: 20, timeoutMs: 10000, waitMs: 60000 });
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); say(`   ${what}: NOT refused`); } catch (error) { say(`   ${what}: refused (${(error as Error).message})`); }
  };
  // A directory of its own for a refusal, holding what the runbook has made by then.
  const aside = (name: string, ...parts: Exclude<keyof Paths, 'root'>[]) => {
    const dir = join(root, 'aside', name);
    for (const one of parts) cpSync(layout(root)[one], layout(dir)[one], { recursive: true });
    return dir;
  };
  try {
    say(`dry run in ${root}, against a fake ComfyUI (local/fake-comfy.ts): no card, no model, and the answers are made up`);
    const paths = writeSet(root);
    writeCardRecord(paths.card);
    say(`1 set: ${identityFrames.length} frames, ${identitySheet.length} people; the card's record as the bootstrap writes it`);
    const portraits = await stage('portraits');
    say(`2 portraits: ${portraits.pictures.length} drawn at ${portraits.comfy.width}x${portraits.comfy.height}, bound in references.json`);
    await refused('the main set before the smoke', () => stage('main'));
    const missing = aside('missing', 'set', 'portraitPrompts', 'card');
    // The fifth and sixth portraits are the look-alikes'.
    fake.options.failJobs = [fake.jobs.length + 5, fake.jobs.length + 6];
    const lost = await stage('portraits', missing);
    fake.options.failJobs = [];
    say(`   two portraits failed on the card: ${lost.pictures.length} drawn, ${lost.failures.length} failed`);
    await refused('the smoke without all six portraits', () => stage('smoke', missing));
    await refused('the failed portraits drawn again', () => stage('portraits', missing));

    const smoked = await stage('smoke');
    say(`3 smoke: ${JSON.stringify(smokeOf(smoked, paths.run))}`);
    const oom = aside('oom', 'set', 'portraitPrompts', 'card', 'portraits', 'references');
    fake.options.oomAtReferences = 1;
    const failed = await stage('smoke', oom);
    fake.options.oomAtReferences = undefined;
    say(`   a card out of memory at one portrait: ${failed.failures.length} cells failed, smoke ${JSON.stringify(smokeOf(failed, layout(oom).run))}`);
    await refused('the main set after a failed smoke', () => stage('main', oom));
    const before = treeHash(paths.run), set = readFileSync(join(paths.set, 'prompts.json'));
    writeFileSync(join(paths.set, 'prompts.json'), JSON.stringify(identityCases().reverse(), null, 2));
    await refused('a resume with another set', () => stage('main'));
    writeFileSync(join(paths.set, 'prompts.json'), set);
    say(`   the run after that refusal: ${treeHash(paths.run) === before ? 'unchanged, byte for byte' : 'CHANGED'}`);
    const short = aside('short', 'set', 'portraitPrompts', 'card', 'portraits', 'references', 'run');
    const unfit = await stage('main', short, Date.now() + 60000);
    say(`   a main set that cannot end a minute from now: ${unfit.pictures.length - smoked.pictures.length} drawn beyond the smoke, stopped ${unfit.stopped}`);
    const clock = aside('clock', 'set', 'portraitPrompts', 'card', 'portraits', 'references');
    const pace = fake.options.jobMs;
    fake.options.jobMs = 5000;
    const cut = await stage('smoke', clock, Date.now() + 1000);
    fake.options.jobMs = pace;
    say(`   a smoke the end cuts in the middle of a job: ${cut.pictures.length} drawn, ${cut.failures.length} failed, stopped ${cut.stopped}, verdict ${identityReport(clock).verdict}`);
    await refused('bundles of a run the end cut short', () => buildIdentityBundles(clock));

    const main = await stage('main');
    say(`4 main set: ${main.pictures.length} drawn; control: ${readIndex(paths.control)?.pictures.length ?? 0} frames on the text-to-image graph`);
    say(`5 bundles: ${buildIdentityBundles(root).join(', ')}; fake answers written to ${join(paths.run, 'answers')}`);
    fakeAnswers(paths.run, identityCases());
    say('6 the report:');
    const report = identityReport(root);
    for (const line of reportLines(report)) say(line);
    return report;
  } finally { await fake.close(); }
}

const report = (value: object) => console.log(JSON.stringify(value)); // counts, ids and codes only, never a prompt

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    until: { type: 'string' }, wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
    tokenizers: { type: 'string' }, smoke: { type: 'boolean', default: false },
  } });
  const command = positionals[0] ?? '';
  const dir = resolve(values.dir ?? join(ROOT, 'illustrations', 'identity'));
  if (command === 'set') {
    writeSet(dir);
    report({ event: 'identity_set_written', directory: dir, frames: identityFrames.length, people: identitySheet.length });
  } else if (command === 'portraits' || command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Error('Use: portraits|draw [--smoke] --until <epoch seconds, five minutes before the card\'s end> [--dir illustrations/identity] [--wait 300] [--timeout 60] [--tokenizers tokenizers] [--comfy http://127.0.0.1:8188]');
    }
    const stage = command === 'portraits' ? 'portraits' : values.smoke ? 'smoke' : 'main';
    const index = await drawStage({ stage, dir, comfy: comfyUrl(values.comfy!), until,
      tokenizers: values.tokenizers, timeoutMs: timeout * 1000, waitMs: wait * 1000, log: report });
    report({ event: 'identity_drawn', stage, drawn: index.pictures.length, failed: index.failures.length, stopped: index.stopped, error: index.error });
    if (index.error || index.stopped || index.failures.length) process.exitCode = 1;
  } else if (command === 'bundles') {
    buildIdentityBundles(dir, report);
  } else if (command === 'report') {
    for (const line of reportLines(identityReport(dir))) console.log(line);
  } else if (command === 'dry-run') {
    await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-identity-dry-')), values.tokenizers);
  } else throw new Error('Use: image-identity.ts set|portraits|draw|report|bundles|dry-run (docs/illustrations-plan.md, "The identity runbook")');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
