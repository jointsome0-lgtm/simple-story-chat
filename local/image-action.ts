// The action measurement (docs/action-experiment.md): scenes where several people touch, written on the text card,
// drawn in six arms on the picture card, and judged by fresh GPT-6 sessions, with the sharp scenes sealed. The
// commands, in the runbook's order (docs/action-experiment.md#runbook), all in illustrations/action, whose sealed/ the
// owner's deny covers; only `dry-run` takes another `--dir`:
//   texts       on the text card, through simple-serving's gateway: `--marker` first, the marker check of the sealed
//               path, then the 26 stories and the owner's own. `--smoke-record` names the record of the gateway's
//               smoke, which route A starts on; `--model gpu:<label>` takes the llama.cpp fallback from .env.gpu
//               instead. `--again id,...` asks once more the sheets that came back empty (docs/action-experiment.md#again)
//   own         how many themes and scenes the owner's sealed/own.txt holds, before the text card (#own)
//   prompts     the manifests, the six arms' prompts, the fronts and the views
//   checklists  the checklists, from the texts alone, before the picture card; it says whether the card may come
//   draw        on the picture card: `--smoke` first; `portraits` then draws the rest of the fronts and views, and
//   portraits   `draw` whatever is left of them, seed 7, and seed 11 if it fits. Each takes `--until`
//   bundles     the bundles of the text, pictures, repeat and identity sessions, from the drawn pictures
//   judge       every session that is ready, `--parallel` (4) at a time
//   collect     the owner's answers to the sessions both judges left, and the counts
//   report      report.json, and the owner's report.md
//   gallery     the owner's pages: gallery.html, and sealed/gallery.html for the sharp scenes; while the card draws,
//               also what is still to come and when, and with the stages' `--until`, the deadline and seed 11
//   dry-run     all of it against fakes, with the boundary test; `--dev` then takes the texts through simple-serving's
//               dev launcher
// What it prints is ids, codes, counts and times, one JSON object a line: never a word of a story, a prompt or a key.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { MARKER_STORY } from '../examples/action-set.ts';
import { apiGraph, comfyUrl, textEncoderOf } from './image-batch.ts';
import { writeCardRecord } from './image-identity.ts';
import { safeErrorDetails } from './model-error.ts';
import { loadTokenizers, qwenPromptTokens } from './tokenizer.ts';
import type { QwenTokenizer } from './tokenizer.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { Refusal, capture, madeUpName, markerForms, searchBoundary, searchTree } from './action-boundary.ts';
import { ARMS, SERVING, SMOKE_PROBES, TEXT_CODES, gpuModel, isSharp, markerCheck, readClientKey, readGpuEnv, readJson, requestCounts,
  runTexts, servingModel, storyDir, textStories, useOwnScenes } from './action-text.ts';
import type { Fetch, StoryText, TextModel, TextsRecord } from './action-text.ts';
import { planAll, readPlan, textsHash } from './action-prompts.ts';
import type { PromptsRecord, Tokens } from './action-prompts.ts';
import { ACTION_GRAPH, DRAW_CODES, drawStage, planCells } from './action-draw.ts';
import type { DrawIndex, DrawStageOptions } from './action-draw.ts';
import { KINDS, answersFile, bundleDir, checklistBundles, collectAnswers, judgeSessions, judgingCounts, pictureBundles,
  sessionName } from './action-judge.ts';
import type { Exec, JudgingRecord, SessionKind } from './action-judge.ts';
import { writeGalleries, writeReport } from './action-report.ts';
import { fakeGateway, fakeJudge, madeUpAnswers } from './action-fakes.ts';
import type { Faults, JudgeFault } from './action-fakes.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const RUN_DIR = join(ROOT, 'illustrations', 'action');
const print = (value: object) => console.log(JSON.stringify(value));
const tally = (names: (string | undefined)[]) => names.reduce<Record<string, number>>((all, name) => {
  if (name !== undefined) all[name] = (all[name] ?? 0) + 1;
  return all;
}, {});

// What an error may say here (docs/action-experiment.md#sealed): its code when the code is in `CODES`, the fields that
// pass safeErrorDetails, and its class when that is one of `CLASSES`. A refusal of the harness (`Refusal`) also says
// what to do, in the harness's own words. No other message is printed, a plain Error's included: whose words those
// are, nothing about the error says, and a parser's quotes what it read.
const CODES = new Set<string>([...TEXT_CODES, ...DRAW_CODES, 'variant_anchor',
  // A system error's and the command line's, which name no file and no value.
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'ENOSPC', 'EMFILE',
  'ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL']);
const CLASSES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'AbortError', 'TimeoutError']);
export function safeError(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  const own = typeof code === 'string' && CODES.has(code) ? { code } : {};
  if (error instanceof Refusal) return { message: error.message, ...own };
  const name = error instanceof Error ? (CLASSES.has(error.name) ? error.name : 'other') : typeof error;
  return { error: name, ...own, ...safeErrorDetails(error) };
}

// ---- The text card ----

export type TextsOptions = { smokeRecord?: string; model?: string; baseUrl?: string; keyFile?: string; fetch?: Fetch;
  log?: (event: object) => void; again?: string[] };
// Route A with the client key alone, or the llama.cpp fallback from .env.gpu, each configured on an empty directory of
// its own so that no .env is read.
function textModel(options: TextsOptions, configRoot: string): TextModel {
  const fetch = options.fetch ? { fetch: options.fetch } : {};
  if (options.model !== undefined) {
    const label = /^gpu:([A-Za-z0-9._-]{1,40})$/.exec(options.model)?.[1];
    if (!label) throw new Refusal('--model takes gpu:<label>, the llama.cpp card of .env.gpu, as eval does');
    return gpuModel({ label, env: readGpuEnv(), configRoot, ...fetch });
  }
  return servingModel({ key: readClientKey(options.keyFile), configRoot, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...fetch });
}
function textsSummary(record: TextsRecord) {
  const steps = Object.values(record.stories).flatMap(one => Object.entries(one).map(([step, result]) => ({ step, ...result! })));
  return { stories: Object.keys(record.stories).length, steps: steps.length, ok: steps.filter(one => one.outcome === 'ok').length,
    other: tally(steps.filter(one => one.outcome !== 'ok').map(one => `${one.step}:${one.outcome}${one.code ? `:${one.code}` : ''}`)),
    held: record.skipped ?? {}, again: Object.keys(record.again ?? {}).length, requests: requestCounts(record),
    complete: !!record.completedAt && !record.skipped };
}
async function withTextModel<T>(options: TextsOptions, work: (model: TextModel) => Promise<T>): Promise<T> {
  const configRoot = mkdtempSync(join(tmpdir(), 'simple-chat-action-config-'));
  try { return await work(textModel(options, configRoot)); } finally { rmSync(configRoot, { recursive: true, force: true }); }
}
export const textsCommand = (root: string, options: TextsOptions) => withTextModel(options, async model =>
  ({ event: 'texts', ...textsSummary(await runTexts({ root, model, smoke: options.smokeRecord, say: options.log, again: options.again })) }));
// `texts --marker`. Where a hit is, is not printed: a path may hold the word.
export const markerCommand = (root: string, options: TextsOptions) => withTextModel(options, async model => {
  const check = await markerCheck({ root, model, smoke: options.smokeRecord, say: options.log });
  return { event: 'marker_check', pass: check.pass, reached: check.reached, steps: check.steps, files: check.files, bytes: check.bytes,
    tempFiles: check.tempFiles, unread: check.unread, hits: check.hits, requests: check.requests };
});

// ---- Between the cards ----

// The encoder's tokenizer, for the counts of `prompts` and the drawing's telemetry: `--tokenizers` names its
// directory, and tokenizers/ at the repository's root is taken when it is there. Without one, no count has tokens.
export function qwenTokenizer(dir?: string): QwenTokenizer | undefined {
  const tokenizer = loadTokenizers(resolve(dir ?? join(ROOT, 'tokenizers'))).qwen();
  if (dir !== undefined && !tokenizer) throw new Refusal(`No Qwen tokenizer in ${dir}: npm run tokenizers writes it (docs/tokenizers.md)`);
  return tokenizer;
}
function tokensOf(tokenizer: QwenTokenizer | undefined): Tokens | undefined {
  const encoder = tokenizer ? textEncoderOf(apiGraph(JSON.parse(readFileSync(ACTION_GRAPH, 'utf8')))) : undefined;
  return tokenizer && encoder ? (prompt, images) => qwenPromptTokens(tokenizer, prompt, encoder, { images }) : undefined;
}

export function promptsCommand(root: string, tokenizer?: QwenTokenizer) {
  const record = planAll(root, textStories(), tokensOf(tokenizer));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  const stories = Object.values(record.stories);
  const most = (read: (story: PromptsRecord['stories'][string]) => number | undefined) => Math.max(0, ...stories.map(one => read(one) ?? 0));
  const sum = (read: (story: PromptsRecord['stories'][string]) => number) => stories.reduce((total, one) => total + read(one), 0);
  return { event: 'prompts', stories: stories.length, arms: Object.fromEntries(ARMS.map(arm => [arm, stories.filter(one => !one.out[arm]).length])),
    vIsC: stories.filter(one => !one.out.V && one.vIsC).length, out: tally(stories.flatMap(one => Object.values(one.out))),
    fronts: sum(one => one.portraits.length), views: sum(one => one.views.length), people: most(one => one.people), bound: most(one => one.bound),
    stops: tally(stories.map(one => one.stop)), emptyRoles: sum(one => one.emptyRoles ?? 0),
    nonLatin: sum(one => Object.values(one.counts).reduce((total, counts) => total + (counts?.nonLatin ?? 0), 0)),
    namesStripped: sum(one => Object.values(one.counts).reduce((total, counts) => total + (counts?.namesStripped ?? 0), 0)),
    most: Object.fromEntries(ARMS.map(arm => [arm, { words: most(one => one.counts[arm]?.words),
      ...(tokenizer ? { tokens: most(one => one.counts[arm]?.tokens), conditioning: most(one => one.counts[arm]?.conditioning) } : {}) }])),
    tokens: !!tokenizer, textsComplete: !!readJson<TextsRecord>(join(root, 'texts.json'))?.completedAt };
}

// The picture card is rented only when every prompt is assembled and counted and every checklist is stored
// (docs/action-experiment.md#the-rentals): the text run ended with no story held back, the plans are those of the texts
// as they are now, and every story with an action scene has its checklist stored, or failed for good as a judge's
// failure; none is still to run, and none waits for the owner. `checklists` and `collect` print it, and no drawing
// stage starts without it.
export function picturesReady(root: string) {
  const texts = readJson<TextsRecord>(join(root, 'texts.json'));
  const prompts = readJson<PromptsRecord>(join(root, 'prompts.json'));
  const judging = readJson<JudgingRecord>(join(root, 'judging.json'));
  const checklists = { scenes: 0, stored: 0, failed: 0, owner: 0, pending: 0 };
  for (const story of textStories()) {
    const text = readJson<StoryText>(join(storyDir(root, story.id), 'text.json'));
    if (!text?.worn?.length || !text.nodeId || text.steps.action?.outcome !== 'ok') continue;
    checklists.scenes++;
    const state = judging?.sessions[`${story.id}/checklist`]?.state;
    if (state === 'answered') checklists.stored++;
    else if (state === 'failed') checklists.failed++;
    else if (state === 'owner') checklists.owner++;
    else checklists.pending++;
  }
  const textsDone = !!texts?.completedAt && !texts.skipped;
  const promptsCurrent = !!prompts && prompts.texts === textsHash(root, textStories());
  return { ready: textsDone && promptsCurrent && !checklists.owner && !checklists.pending, textsDone, promptsCurrent, checklists };
}

export type JudgeOptions = { kinds?: SessionKind[]; parallel?: number; exec?: Exec; log?: (event: object) => void };
export async function checklistsCommand(root: string, options: JudgeOptions = {}) {
  const bundles = checklistBundles(root, options.log);
  const record = await judgeSessions({ root, kinds: ['checklist'], parallel: options.parallel, exec: options.exec, log: options.log });
  return { event: 'checklists', bundles, ...judgingCounts(root, record), pictures: picturesReady(root) };
}

// ---- The picture card ----

export type DrawOptions = Omit<DrawStageOptions, 'stage' | 'root'>;
export async function drawCommand(root: string, stage: DrawStageOptions['stage'], options: DrawOptions) {
  const gate = picturesReady(root);
  if (!gate.ready) {
    throw new Refusal(`Nothing is drawn before every prompt is assembled and counted and every checklist is stored (texts done ${gate.textsDone}, `
      + `prompts of these texts ${gate.promptsCurrent}, checklists ${JSON.stringify(gate.checklists)}); the card is rented only after that`);
  }
  const index = await drawStage({ stage, root, ...options });
  return drawSummary(stage, index);
}
function drawSummary(stage: DrawStageOptions['stage'], index: DrawIndex) {
  const cells = Object.values(index.cells);
  return { event: 'drawn', stage, drawn: tally(cells.filter(one => one.status === 'drawn').map(one => one.kind === 'frame' ? `s${one.seed}` : one.kind)),
    failed: tally(cells.filter(one => one.status === 'failed').map(one => one.code)), out: tally(cells.filter(one => one.status === 'out').map(one => one.code)),
    ...(index.smoke?.verdict ? { smoke: index.smoke.verdict } : {}), ...(index.admission?.length ? { admission: index.admission.at(-1) } : {}),
    ...(index.stopped ? { stopped: index.stopped } : {}), ...(index.error ? { error: index.error } : {}) };
}

// ---- After the card ----

export async function judgeCommand(root: string, options: JudgeOptions = {}) {
  const record = await judgeSessions({ root, kinds: options.kinds ?? KINDS.filter(kind => kind !== 'checklist'), parallel: options.parallel,
    exec: options.exec, log: options.log });
  return { event: 'judged', ...judgingCounts(root, record) };
}
export function reportCommand(root: string) {
  const report = writeReport(root);
  const verdicts = (gates: { verdict: string }[]) => gates.map(gate => gate.verdict);
  return { event: 'report', scenes: { ...report.scenes, missed: report.scenes.missed.length }, gates: verdicts(report.gates), cleanOnly: verdicts(report.cleanOnly),
    reachedOnly: verdicts(report.reachedOnly), seed11: verdicts(report.seed11.gates), repeats: { scenes: report.repeats.scenes, changed: report.repeats.changed.length },
    mirror: Object.fromEntries(Object.entries(report.mirror.seed7).map(([arm, one]) => [arm, [one.shown, one.of]])),
    sharpUnanswered: report.delivery.sharpUnanswered, seedSevenComplete: report.delivery.seedSevenComplete };
}

// ---- The dry run ----

// The gateway's faults in the dry run: each of the doc's outcomes once, the provider's error on a sharp story, whose
// body then carries the marker, and two faults in each of two stories so that 25 scenes keep both A and A+. The beach
// scene, which binds the most people, has them all face the viewer: the smoke then draws another scene's view and its
// front, and V is C's picture there.
const DRY_FAULTS: Faults = {
  beach: { variant: 'all_viewer' },
  demon: { sheet: 'retry' },
  tango: { frame: 'unparsed', variant: 'duplicate_roles' },
  cheer: { sheet: 'empty_sheet' },
  'sharp-2': { frame: 'error', variant: 'truncated' },
};
// The judge's: a clean session without a block and a fresh one that answers, a clean session with a field too many and
// one that answers, a clean judge's failure, a sharp checklist that Astra's malformed block and Sol's extra field
// leave to the owner, a sharp pictures session that Sol answers, and one that goes to the owner while the identity
// session of its seed waits for it.
const DRY_SCRIPT: Record<string, JudgeFault[]> = {
  'flight/checklist': ['missing'],
  'sharp-1/checklist': ['marker', 'invalid'],
  'demon/pictures-s7': ['invalid'],
  'guard/text': ['missing', 'missing'],
  'sharp-3/pictures-s7': ['marker'],
  'sharp-5/pictures-s7': ['missing', 'marker'],
};

// The owner's part in the dry run: answers where each owner's page says, made up as a judge's are.
function ownerAnswers(root: string, word: string) {
  let written = 0;
  for (const entry of Object.values(readJson<JudgingRecord>(join(root, 'judging.json'))?.sessions ?? {})) {
    const file = answersFile(root, entry, true);
    if (entry.state !== 'owner' || existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(madeUpAnswers(entry.story, sessionName(entry), bundleDir(root, entry), word)), { mode: 0o600 });
    written++;
  }
  return written;
}

// The whole runbook against fakes, in its order, in `out`: the run in `run/`, and `tmp/` as the temporary directory of
// the harness while it runs. simple-serving's gateway is local/action-fakes.ts's behind the real adapter, reached with
// a key file that also holds the two keys the harness must not read; ComfyUI is local/fake-comfy.ts; the judge writes
// made-up answers. A made-up word goes wherever a sharp story's words would, and into the fakes' error bodies, the
// pictures' metadata and the judge's prose and malformed blocks; the boundary test then searches every file of `out`
// outside `run/sealed/`, `tmp/` and all the dry run printed for it, and fails on anything it cannot read; and the whole
// of `run/`, `tmp/` and the output for the keys. On the way it goes through the refusals the paid run relies on. No
// card, no model, no network. Beside `run/` it leaves the key file, the smoke record and `dev.json`, which `devRun`
// takes up.
export async function dryRun(out: string, options: { tokenizers?: string } = {}) {
  const dry = resolve(out), root = join(dry, 'run'), temp = join(dry, 'tmp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) { say(`   ${what}: refused (${JSON.stringify(safeError(error))})`); }
  };
  const word = madeUpName();
  const keys = { client_key: `dry-client-${randomBytes(8).toString('hex')}`, control_key: `dry-control-${randomBytes(8).toString('hex')}`,
    vast_api_key: `dry-vast-${randomBytes(8).toString('hex')}` };
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  try {
    say(`dry run in ${dry}: fakes of simple-serving's gateway, ComfyUI and the judge; no card, no model, no network, and every word made up`);
    const keyFile = join(dry, 'config.json'), smokeRecord = join(dry, 'serving-smoke.jsonl');
    writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
    // The same client key for simple-serving's dev launcher, which the runbook starts in front of its fake engine for a
    // run of the texts before any card: a service block with the served name, the context, and the key's one class,
    // whose calls name the scope `internal`.
    writeFileSync(join(dry, 'dev.json'), JSON.stringify({ service: { alias: SERVING.model, context_tokens: SERVING.contextTokens,
      keys: { [keys.client_key]: { label: 'action', classes: ['internal'], default: 'internal', scopes: true, control: false } } } }), { mode: 0o600 });
    writeFileSync(smokeRecord, SMOKE_PROBES.map(probe => JSON.stringify({ probe, ok: true, ...(probe === 'state' ? { versions: { gateway: '0.1.0' } } : {}) })).join('\n') + '\n');
    // The owner's file (#own): a theme and a scene of two people, the word in each part, so that the boundary test below
    // has their title, theme, seed and action to find; and a scene with no action in a file of its own, whose refusal
    // must name a line and nothing on it.
    const ownFile = join(root, 'sealed', 'own.txt'), broken = join(root, 'sealed', 'broken');
    mkdirSync(join(broken, 'sealed'), { recursive: true, mode: 0o700 });
    writeFileSync(ownFile, ['# Проверка: одна тема и одна сцена целиком.', `тема: ночной рынок ${word}`, '', `сцена: Переправа ${word}`,
      'Спокойная история для взрослых. Все персонажи взрослые, им больше двадцати лет.',
      `Брод через холодную реку, поздняя осень, сумерки; на том берегу горит костёр ${word}.`,
      'Ярина — женщина лет тридцати, высокая и худая, короткие чёрные волосы, родинка над губой. Зелёный плащ.',
      'Тарас — мужчина лет сорока, плотный и широкоплечий, рыжая борода, лысина. Кожаная куртка и высокие сапоги.',
      'Ярина подвернула ногу на камнях посреди брода.', `действие: Тарас подхватывает Ярину на руки ${word}`, 'и несёт её через брод к костру.'].join('\n'));
    writeFileSync(join(broken, 'sealed', 'own.txt'), `сцена: ${word}\n${word} и никакого действия`);
    await refused('an owner\'s scene without «действие:»', () => useOwnScenes(broken));
    const own = useOwnScenes(root);
    say(`   the owner's file: ${own.themes} theme, ${own.scenes} scene, pinned ${own.pinned}`);
    expect(own.themes === 1 && own.scenes === 1 && !own.pinned, 'the owner\'s file reads as a theme and a scene');
    const gateway = fakeGateway({ key: keys.client_key, sharp: [...textStories().filter(story => isSharp(story.id)).map(story => story.id), MARKER_STORY.id],
      marker: word, faults: DRY_FAULTS });
    const texts = (extra: TextsOptions = {}) => textsCommand(root, { smokeRecord, keyFile, fetch: gateway.fetch, ...extra });

    const early = await texts();
    say(`1 texts before the marker check: ${early.stories} stories written, ${Object.keys(early.held).length} held (${JSON.stringify(tally(Object.values(early.held)))})`);
    expect(!gateway.calls.some(call => call.story.startsWith('sharp-')), 'no sharp story asked before the marker check');
    const marker = await markerCommand(root, { smokeRecord, keyFile, fetch: gateway.fetch });
    say(`2 marker check: pass ${marker.pass}, steps ${JSON.stringify(marker.steps)}; searched ${marker.files} files and ${marker.tempFiles} temporary ones, ${marker.unread} unread, hits ${JSON.stringify(marker.hits)}`);
    expect(marker.pass, 'the marker check passes');
    const full = await texts();
    say(`3 texts: ${full.stories} stories, ${full.ok} of ${full.steps} steps ok, the rest ${JSON.stringify(full.other)}; requests ${JSON.stringify(full.requests)}`);
    const calls = gateway.calls.length;
    await texts();
    say(`   a rerun: ${gateway.calls.length - calls} calls`);
    expect(gateway.calls.length === calls, 'a finished text run asks nothing again');
    const asked = (id: string, kind: string) => gateway.calls.filter(call => call.story === id && call.kind === kind).length;
    say(`   the owner's theme: ${asked('sharp-6', 'seed')} seed asked; the owner's scene: ${asked('sharp-7', 'seed')} seeds asked, ${asked('sharp-7', 'scene')} scenes`);
    expect(asked('sharp-6', 'seed') === 1 && asked('sharp-7', 'seed') === 0 && asked('sharp-7', 'scene') === 2,
      'the heretic writes the owner\'s theme, and the owner\'s scene starts from its own seed');
    const ownText = readFileSync(ownFile);
    writeFileSync(ownFile, `${ownText}\nтема: ещё одна`);
    await refused('a command after the owner\'s file changed', () => useOwnScenes(root));
    writeFileSync(ownFile, ownText);
    expect(useOwnScenes(root).pinned, 'the owner\'s file pinned by the first text run');
    const kept = readFileSync(join(root, 'texts.json'));
    await refused('the texts under another address', () => texts({ baseUrl: 'http://127.0.0.1:8090' }));
    expect(readFileSync(join(root, 'texts.json')).equals(kept), 'texts.json unchanged by the refusal');
    // The error boundary: a plain Error that carries the word, and an error under a code of no list, which is a word
    // too, print neither (the boundary test below searches the output for the first).
    const unlisted = `dry${Array.from(randomBytes(8), byte => String.fromCharCode(97 + byte % 26)).join('')}`;
    const shown = JSON.stringify([safeError(new Error(`a parser quoting ${word}`)), safeError(Object.assign(new Error(unlisted), { code: unlisted }))]);
    say(`   a plain error and an unlisted code print ${shown}`);
    expect(!shown.includes(unlisted), 'an unlisted code is not printed');

    const tokenizer = qwenTokenizer(options.tokenizers);
    const prompts = promptsCommand(root, tokenizer);
    say(`4 prompts: ${JSON.stringify({ arms: prompts.arms, vIsC: prompts.vIsC, fronts: prompts.fronts, views: prompts.views, out: prompts.out, nonLatin: prompts.nonLatin, tokens: prompts.tokens })}`);

    const judge = fakeJudge({ marker: word, script: DRY_SCRIPT });
    const lists = await checklistsCommand(root, { exec: judge.exec });
    say(`5 checklists: ${lists.bundles.built} bundles; ${JSON.stringify(lists.sessions.checklist)}; the picture card may come: ${lists.pictures.ready}`);
    fake = await startFakeComfy({ jobMs: 30, referenceMs: 0, requireUploads: true, marker: word });
    writeCardRecord(join(root, 'card.txt'));
    const draw = (stage: DrawStageOptions['stage'], until = Date.now() + 2 * 3600000) =>
      drawCommand(root, stage, { comfy: fake!.url, until, tokenizer, pollMs: 10, waitMs: 60000, timeoutMs: 10000 });
    await refused('the smoke while a checklist waits for the owner', () => draw('smoke'));
    const answered = ownerAnswers(root, word);
    const collected = collectAnswers(root);
    say(`   the owner answers ${answered} page; ${JSON.stringify(collected.sessions.checklist)}; the picture card may come: ${picturesReady(root).ready}`);

    await refused('the rest before the smoke', () => draw('main'));
    const smoke = await draw('smoke');
    const index = () => readJson<DrawIndex>(join(root, 'draw.json'))!;
    say(`6 smoke: scene ${index().smoke!.keys.find(key => key.startsWith('frame:'))?.split(':')[1]}, ${smoke.smoke!.cells} cells, `
      + `${index().smoke!.extraView ? 'a view of another scene' : 'no view of another scene'}; verdict ${JSON.stringify({ ...smoke.smoke!, failing: smoke.smoke!.failing.length })}`);
    expect(smoke.smoke!.pass, 'the smoke passes');
    const before = fake.jobs.length;
    const short = await draw('portraits', Date.now() + 5000);
    say(`   the rest of seed 7 with five seconds left: stopped ${short.stopped}, ${short.admission?.cells} cells needing ${Math.ceil((short.admission?.needMs ?? 0) / 60000)} min; ${fake.jobs.length - before} jobs sent`);
    expect(short.stopped === 'admission' && fake.jobs.length === before, 'a seed that cannot end in time is not begun');
    // The first front left and the last view sent fail on the card: the front's scene loses C, V and T, the view's V.
    const cells = planCells(textStories().flatMap(story => { const plan = readPlan(root, story.id); return plan ? [plan] : []; }));
    const fronts = cells.fronts.filter(cell => !index().cells[cell.key]);
    const views = cells.views.filter(cell => !index().cells[cell.key] && cell.refs[0] !== fronts[0]?.id);
    fake.options.failJobs = [fake.jobs.length + 1, fake.jobs.length + fronts.length + views.length];
    const portraits = await draw('portraits');
    fake.options.failJobs = [];
    say(`   portraits: drawn ${JSON.stringify(portraits.drawn)}, failed ${JSON.stringify(portraits.failed)}, out ${JSON.stringify(portraits.out)}`);
    const main = await draw('main');
    say(`7 frames: drawn ${JSON.stringify(main.drawn)}, failed ${JSON.stringify(main.failed)}, out ${JSON.stringify(main.out)}; seed 11 ${JSON.stringify(main.admission)}`);
    const jobs = fake.jobs.length;
    await draw('main');
    say(`   a resume: ${fake.jobs.length - jobs} jobs`);
    expect(fake.jobs.length === jobs, 'a resume draws nothing again');
    // A plan changed after `prompts`: the stage hashes the plan files as it reads them.
    const planFile = join(storyDir(root, textStories()[0].id), 'plan.json'), plan = readFileSync(planFile), drawn = readFileSync(join(root, 'draw.json'));
    writeFileSync(planFile, JSON.stringify({ ...JSON.parse(plan.toString('utf8')), changed: true }));
    await refused('a resume under a plan changed after prompts', () => draw('main'));
    writeFileSync(planFile, plan);
    expect(readFileSync(join(root, 'draw.json')).equals(drawn), 'draw.json unchanged by the refusal');

    const bundles = pictureBundles(root);
    say(`8 bundles: ${bundles.built} built, skipped ${JSON.stringify(bundles.skipped)}`);
    let judged = await judgeCommand(root, { exec: judge.exec });
    const pages = ownerAnswers(root, word);
    collectAnswers(root);
    judged = await judgeCommand(root, { exec: judge.exec });
    say(`   judged: ${JSON.stringify(judged.sessions)}, ${judged.attempts} attempts in all; the owner answered ${pages} page, and the identity it held back ran after it`);
    const fell = judge.runs.filter(run => run.model !== judge.runs[0].model);
    say(`   sessions by model: ${JSON.stringify(tally(judge.runs.map(run => run.model)))}, faults ${JSON.stringify(tally(judge.runs.map(run => run.fault)))}; `
      + `sharp sessions that went to the fallback: ${fell.filter(run => run.story.startsWith('sharp-')).length}, clean ones: ${fell.filter(run => !run.story.startsWith('sharp-')).length}`);
    expect(!fell.some(run => !run.story.startsWith('sharp-')), 'a clean session never goes to the fallback');

    const report = reportCommand(root);
    say(`9 report: ${JSON.stringify(report)}`);
    // The fakes give the one-person scenes a touch of their own body and a grip on a thing, and the mirror scene its
    // reflection: a checklist that lost them would score those scenes on nothing and say so nowhere.
    const items = report.scenes.items;
    expect(items.self > 0 && items.thing > 0 && items.mirror > 0 && Object.values(report.mirror).some(([, of]) => of > 0),
      'a touch of one\'s own body, one of a thing and a mirror item reach the report');
    const delivery = readJson<{ delivery: { cells: Record<string, { planned: number; submitted: number; drawn: number; scored: number; reasons: Record<string, number> }> } }>(join(root, 'report.json'))!.delivery;
    for (const [name, row] of Object.entries(delivery.cells)) say(`   ${name}: planned ${row.planned}, submitted ${row.submitted}, drawn ${row.drawn}, scored ${row.scored}; ${JSON.stringify(row.reasons)}`);
    const gallery = writeGalleries(root);
    say(`10 gallery: ${gallery.clean} clean stories on gallery.html, ${gallery.sharp} sharp on sealed/gallery.html`);

    // Every place the dry run wrote: the whole of `out` but run/sealed/, the key file and the smoke record beside run/
    // included, then tmp/ and the output.
    const found = searchBoundary({ root: dry, sealed: join(root, 'sealed'), tempDir: temp, word, output: output.text() });
    // A search that finds nothing proves something only where the word is: inside sealed/, as the sharp words are.
    const inside = searchTree(join(root, 'sealed'), markerForms(word)).hits.length;
    const needles = Object.values(keys).map(key => Buffer.from(key, 'utf8'));
    const keyHits = searchTree(root, needles).hits.length + searchTree(temp, needles).hits.length + Number(needles.some(key => output.text().includes(key.toString('utf8'))));
    say(`11 boundary: ${found.files} files outside sealed/, ${found.tempFiles} temporary, ${found.bytes} bytes, ${found.unread} unread: hits ${JSON.stringify({ files: found.hits.files.length, temp: found.hits.temp, output: found.hits.output })}; `
      + `the word is in ${inside} files inside sealed/; the keys found ${keyHits} times`);
    expect(inside > 0, 'the word inside sealed/');
    expect(found.pass, 'the word nowhere outside sealed/');
    expect(keyHits === 0, 'no key anywhere');
    say(missed.length ? `the dry run did NOT go as expected: ${missed.length} of its checks` : 'the dry run went as expected');
    return { pass: !missed.length, missed, boundary: found.pass, keys: keyHits };
  } finally {
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// The texts against simple-serving's dev launcher, after a dry run in `out` (the runbook's first step): the marker
// check, then the text run, in `dev/` beside the dry run's `run/`, through the gateway at `url`, with the dry run's
// own key file and smoke record. Its client key is made up, so only a launcher started on the dry run's dev.json
// answers it, and that launcher's engine is a fake whose sheets never parse: a marker check that passes means that a
// model answered, and no sharp story is asked for outside illustrations/action.
export async function devRun(out: string | undefined, url: string) {
  const dry = out === undefined ? undefined : resolve(out);
  if (!dry || !existsSync(join(dry, 'dev.json'))) throw new Refusal('dry-run --dev takes the --dir of a dry run, which holds its key file and dev.json');
  const root = join(dry, 'dev');
  const options: TextsOptions = { smokeRecord: join(dry, 'serving-smoke.jsonl'), keyFile: join(dry, 'config.json'), baseUrl: url, log: print };
  const marker = await markerCommand(root, options);
  print(marker);
  if (marker.pass) {
    throw new Refusal('The marker check passed against the dev launcher, whose fake engine parses no sheet: a model answered it, and no sharp story is asked for outside illustrations/action');
  }
  print(await textsCommand(root, options));
}

// ---- The command line ----

// Every command but the dry run works in illustrations/action alone, the one directory whose sealed/ the owner's deny
// covers (docs/action-experiment.md#sealed): another --dir, or a link on the way to sealed/, would put the sharp
// stories where no deny is.
function liveRoot(dir: string | undefined) {
  if (dir !== undefined && resolve(dir) !== RUN_DIR) {
    throw new Refusal('Only dry-run takes another --dir: every other command works in illustrations/action, whose sealed/ the owner\'s deny covers');
  }
  for (const path of [join(ROOT, 'illustrations'), RUN_DIR, join(RUN_DIR, 'sealed')]) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Refusal(`${relative(ROOT, path)} is a link: the sharp stories would land where the owner's deny is not`);
    }
  }
  return RUN_DIR;
}

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, dev: { type: 'string' },
    marker: { type: 'boolean', default: false }, 'smoke-record': { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    'key-file': { type: 'string' }, again: { type: 'string' },
    smoke: { type: 'boolean', default: false }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' }, tokenizers: { type: 'string' },
    kind: { type: 'string' }, parallel: { type: 'string', default: '4' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    if (values.dev !== undefined) return devRun(values.dir, values.dev);
    const result = await dryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-action-dry-')), { tokenizers: values.tokenizers });
    if (!result.pass) process.exitCode = 1;
    return;
  }
  const root = liveRoot(values.dir);
  const own = useOwnScenes(root);
  if (command === 'own') return print({ event: 'own', ...own });
  const parallel = Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Refusal('--parallel takes 1 to 8 sessions at a time');
  const kinds = values.kind?.split(',').map(kind => kind.trim());
  if (kinds?.some(kind => !KINDS.includes(kind as SessionKind))) throw new Refusal(`--kind takes ${KINDS.join(', ')}, comma separated`);
  if (command === 'texts') {
    const options = { smokeRecord: values['smoke-record'], model: values.model, baseUrl: values['base-url'], keyFile: values['key-file'], log: print,
      again: values.again?.split(',').map(id => id.trim()).filter(Boolean) };
    if (values.marker && options.again) throw new Refusal('--again belongs to the texts, not to the marker check');
    if (values.marker) {
      const check = await markerCommand(root, options);
      print(check);
      if (!check.pass) process.exitCode = 1;
    } else {
      const result = await textsCommand(root, options);
      print(result);
      if (!result.complete) process.exitCode = 1;
    }
  } else if (command === 'prompts') {
    print(promptsCommand(root, qwenTokenizer(values.tokenizers)));
  } else if (command === 'checklists') {
    const result = await checklistsCommand(root, { parallel, log: print });
    print(result);
    if (!result.pictures.ready) process.exitCode = 1;
  } else if (command === 'portraits' || command === 'draw') {
    // `--until` is the end of the work in epoch seconds, five minutes before the card's end as the runbook computes it.
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: portraits|draw [--smoke] --until <epoch seconds, five minutes before the card\'s end> [--dir illustrations/action] [--wait 300] [--timeout 60] [--tokenizers tokenizers] [--comfy http://127.0.0.1:8188]');
    }
    const stage = command === 'portraits' ? 'portraits' : values.smoke ? 'smoke' : 'main';
    const result = await drawCommand(root, stage, { comfy: comfyUrl(values.comfy!), until, tokenizer: qwenTokenizer(values.tokenizers),
      timeoutMs: timeout * 1000, waitMs: wait * 1000, log: print });
    print(result);
    if (result.error || result.stopped || (stage === 'smoke' && !result.smoke?.pass)) process.exitCode = 1;
  } else if (command === 'bundles') {
    print({ event: 'bundles', ...pictureBundles(root, print) });
  } else if (command === 'judge') {
    print(await judgeCommand(root, { kinds: kinds as SessionKind[] | undefined, parallel, log: print }));
  } else if (command === 'collect') {
    print({ event: 'collected', ...collectAnswers(root, print), pictures: picturesReady(root) });
  } else if (command === 'report') {
    print(reportCommand(root));
  } else if (command === 'gallery') {
    // `--until` as the drawing stages took it; once it is past the drawing is over, unless a stage that stopped on an
    // error waits for a resume.
    const until = values.until === undefined ? undefined : Number(values.until) * 1000;
    if (until !== undefined && !(Number.isInteger(until) && until > 0)) throw new Refusal('Use: gallery [--until <epoch seconds, the drawing stages\' own>]');
    print({ event: 'gallery', ...writeGalleries(root, { until }) });
  } else throw new Refusal('Use: image-action.ts texts|own|prompts|checklists|draw|portraits|bundles|judge|collect|report|gallery|dry-run (docs/action-experiment.md#runbook)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
