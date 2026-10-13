// The second refs stand (docs/action-experiment.md#refs-stand-2), on the first stand's card on the night of
// 2026-09-27, for two things tonight's tester saw in frames drawn with references and the bot's wording of 47f7f80
// (local/picture-references.ts): a woman whose look says a large bust, a very narrow waist and long legs came out much
// heavier in one picture, and the portrait's grey suit came into a scene where a man was to be bare-chested. The owner
// holds the figure the more important of the two. So H alone, in K-solo and P at six new seeds, 96 cells:
//   R-L0      the first stand's R (ROLE, H's front at 352x640) with H's look beside the reference, as the bot's wording
//             puts it and the first stand's R did not;
//   R-L1      the same with weight anchors in the look, within the look rule's 25 words (local/illustrate.ts);
//   W-L0, W-L1  no picture, the two looks; FV-L0 and FC-L0 as the first stand drew them, FV without a look;
//   R-L0-NEG and W-L0-NEG  R-L0's and W-L0's texts at CFG 2 with a negative aimed at the complaints, the suit named
//             without a color, since the tester's own pictures wear a skin-colored one. The frame graph takes a
//             negative as the sheets do: Qwen's encoder conditions both from the same references. Last, so the end
//             cuts them first.
// The references are the first stand's pictures, taken by --from from its run and never drawn again. build-texts.ts in
// the run's directory builds texts.json from the first stand's pinned texts, and this file pins its sha256. The rest is
// local/image-refs-test.ts: the bot's picture path, the prices, cells.json and the page.
//   estimate  the cells and the minutes at the seeded prices
//   dry-run   the real texts beside the first stand's, their graphs, then both stands against local/fake-comfy.ts
//   draw      on the card, --out DIR --from <the first stand's DIR> --until EPOCH
//   page      DIR/index.html
// What it prints is keys, codes, counts and times, one JSON object a line: never a word of a prompt.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { comfyUrl, pngSize, referenceGeometry, stripPngMetadata } from './image-batch.ts';
import type { Graph } from './image-batch.ts';
import { FRAME_CANVAS, SCALED } from './action-draw.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { kitchenLines } from './image-pilot.ts';
import { readJson } from './action-text.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeJob } from './fake-comfy.ts';
import { BY_KEY, CROP, INDEX_FILE, PLANNED, SCENE_WORDS, TEXTS_FILE, TEXTS_SHA256, TRITON_ARGV, attentionInfo, buildJob, cellOf, cellRight, countsOf,
  drawStand, estimateOf, frameKey, frontKey, inputsOf, setupOf, sizeText, slotChains, tokenReport, viewKey, writePage } from './image-refs-test.ts';
import type { How, Negative, Planned, Ref, Scene, Section, Size, Stand, StandIndex, TextCell, Tier } from './image-refs-test.ts';

const ROOT = resolve(import.meta.dirname, '..');
// texts.json as ~/simple-story-chat-runs/2026-09-27/refs-stand-2/build-texts.ts wrote it, byte for byte.
const TEXTS_SHA256_2 = '9a5ee1a68c05970bed86088e982a0c64df99827712db10af13143fcddfa3cfe3';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const print = (value: object) => console.log(JSON.stringify(value));

// ---- The plan ----

export const SEEDS_2 = [21, 23, 29, 31, 37, 41];
const SCENES: Scene[] = ['K-solo', 'P'];
const H = frontKey('H-PORTRAIT');
// FV's view as the scene turns H: three-quarters to the right in K, in profile facing left in P.
const VIEW: Partial<Record<Scene, string>> = { 'K-solo': viewKey('H-34R'), P: viewKey('H-PL') };
type Arm = { id: string; arm: string; cfg: number; negative: Negative; tier: Tier; refs: (scene: Scene) => Ref[] };
const at = (from: string, how: How): Ref => ({ from, how });
const worded = (id: string, refs: Arm['refs']): Arm => ({ id, arm: id.split('-')[0], cfg: 1, negative: 'none', tier: 'core', refs });
const ARMS: Arm[] = [worded('R-L0', () => [at(H, 's352')]), worded('R-L1', () => [at(H, 's352')]), worded('W-L0', () => []), worded('W-L1', () => []),
  worded('FV-L0', scene => [at(H, 's352'), at(VIEW[scene]!, 's352')]), worded('FC-L0', () => [at(frontKey('H-VN'), 'crop')])];
const NEG_ARMS: Arm[] = [{ id: 'R-L0-NEG', arm: 'NEG', cfg: 2, negative: 'neg', tier: 'D', refs: () => [at(H, 's352')] },
  { id: 'W-L0-NEG', arm: 'NEG', cfg: 2, negative: 'neg', tier: 'D', refs: () => [] }];
// Seed by seed, so that an end that comes early leaves every arm the same seeds: the six arms at each seed and scene,
// then the two at CFG 2 the same way.
function planOf(): Planned[] {
  const cells = (arms: Arm[]) => SEEDS_2.flatMap(seed => SCENES.flatMap(scene => arms.map(one => cellOf({ key: frameKey(one.id, scene, seed), id: one.id,
    arm: one.arm, kind: 'frame', scene, seed, graph: 'action', canvas: FRAME_CANVAS, cfg: one.cfg, negative: one.negative, refs: one.refs(scene), tier: one.tier }))));
  return [...cells(ARMS), ...cells(NEG_ARMS)];
}
export const PLANNED_2 = planOf();

const COLUMNS = [...ARMS, ...NEG_ARMS].map(one => one.id);
const NOTES: Partial<Record<Scene, string>> = {
  'K-solo': 'H вешает фонарь, на три четверти вправо. L0: внешность H как сегодня, 26 слов. L1: та же с якорями веса (slender, slim, long slim legs), 25 слов. '
    + 'R: фронт H 352x640, формулировка ROLE и внешность рядом с картинкой, как у бота. W: без картинки. FV: фронт и вид на три четверти, без внешности, как в первом стенде. '
    + 'FC: верх фронта VN как лицо, фигура словами. NEG: R-L0 и W-L0 при CFG 2 с негативом против комбинезона любого цвета, полноты, лишнего человека, рук и текста.',
  P: 'H открывает окно, в профиль влево. FV: фронт и вид в профиль. Остальное как во дворе.',
};
const SECTIONS_2: Section[] = SCENES.map(scene => ({ title: SCENE_WORDS[scene][0].toUpperCase() + SCENE_WORDS[scene].slice(1), note: NOTES[scene]!,
  columns: COLUMNS, rows: SEEDS_2.map(seed => ({ label: `сид ${seed}`, keys: COLUMNS.map(id => frameKey(id, scene, seed)) })) }));
export const STAND_2: Stand = { plan: PLANNED_2, title: 'Второй стенд референсов', sections: SECTIONS_2,
  intro: 'Ответ тестеру: фигура полнее, чем говорит внешность, и костюм с картинки в сцене. Синтетические тексты первого стенда, только H, двор и окно, '
    + 'сиды 21, 23, 29, 31, 37 и 41, 25 шагов euler, путь бота: cu130, Triton, внимание кухни. Фронты и виды взяты из первого стенда и заново не рисовались.' };

// ---- The dry run ----

// The whole stand without a card, in `dir`. First the real texts at `textsFile` beside the first stand's at
// `fromTexts`: the pin, the tokens, what each cell keeps of the first stand's texts and what it adds, and every graph
// built from them and read back. Then marked copies against local/fake-comfy.ts started as the bot's card: the first
// stand's four references drawn in a run of their own; the page before the card; texts other than the pinned, no
// --from, a --from without its cells.json or drawn from other weights, and a server off the bot's path refused before
// anything is sent or written; a cell that cannot end by --until not begun; the 96 jobs against their reading and the
// fake's, each reference the first run's very bytes, with what it reaches the encoder at; a resume that draws nothing;
// a reference the first run lacks leaving its cells out; one job at a time; the page; and the prompts' word in the
// texts and on the pages alone, the fake's word nowhere.
export async function dryRun2(dir: string, textsFile: string, fromTexts: string, tokenizers: string, pinned = TEXTS_SHA256_2) {
  const dry = resolve(dir), temp = join(dry, 'tmp'), from = join(dry, 'refs-stand'), out = join(dry, 'refs-stand-2');
  for (const path of [dry, temp, from, out]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) {
      expect(error instanceof Refusal, `${what} refused as a refusal`);
      say(`   ${what}: refused (${JSON.stringify(safeError(error))})`);
    }
  };
  let fake: Awaited<ReturnType<typeof startFakeComfy>> | undefined;
  const sent: Graph[] = [], fetched = globalThis.fetch;
  let strays = 0, origin = '';
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== origin) { strays++; throw new Error('the dry run asks the fake alone'); }
    if (init?.method === 'POST' && url.endsWith('/prompt') && typeof init.body === 'string') sent.push((JSON.parse(init.body) as { prompt: Graph }).prompt);
    return fetched(input, init);
  };
  try {
    say(`refs-stand-2 dry run in ${dry}: the real texts, then copies of both stands' against local/fake-comfy.ts as the bot's card; no card, no model, no network`);
    writeCardRecord(join(out, 'card.txt'));
    writeCardRecord(join(from, 'card.txt'));
    const card = cardOf(join(out, 'card.txt'));
    const real = inputsOf(textsFile, pinned, PLANNED_2), first = inputsOf(fromTexts, TEXTS_SHA256);
    const estimate = estimateOf(undefined, 0, 60, PLANNED_2);
    const borrowed = [...new Set(PLANNED_2.flatMap(one => one.refs.map(ref => ref.from)))];
    say(`0 the plan: ${estimate.cells} cells, arms ${JSON.stringify(estimate.arms)}, the references ${borrowed.join(', ')}; ${estimate.expectedMinutes} minutes `
      + `expected and ${estimate.pricedMinutes} at the admission prices, ${estimate.coreMinutes} of them for the 72 at CFG 1; ${JSON.stringify(estimate.cellSeconds)}`);
    expect(estimate.cells === 96 && new Set(PLANNED_2.map(one => one.key)).size === 96 && PLANNED_2.slice(0, 72).every(one => one.tier === 'core' && one.cfg === 1)
      && PLANNED_2.slice(72).every(one => one.tier === 'D' && one.cfg === 2 && one.negative === 'neg') && borrowed.length === 4
      && borrowed.every(key => BY_KEY.has(key) && !PLANNED_2.some(one => one.key === key)), '96 cells, the 24 at CFG 2 last, every reference one the first stand drew');
    const tokens = tokenReport(real.texts, tokenizers, PLANNED_2);
    say('1 the real texts (sha256 pinned): tokens, the prompt as the encoder takes it with its references, the canvas and each reference at the encoder:');
    for (const one of tokens.groups) say(`   ${JSON.stringify(one)}`);
    say(`   the negative: ${tokens.negatives.neg} tokens`);
    expect(tokens.groups.every(one => one.promptTokens[0] > 0 && one.promptTokens[1] < 2000) && (tokens.negatives.neg ?? 0) > 0, 'every prompt and the negative counted');

    // What each cell keeps of the first stand's texts: W-L0, FV-L0 and FC-L0 its W, FV and FC word for word; R-L0 and
    // R-L1 its R with a look put in after the reference's words; W-L1 its W with the second look for the first; the
    // NEG cells the texts of their L0 twins.
    const firstOf = (id: string, scene: Scene) => first.texts.cells.get(frameKey(id, scene, 7))!.prompt;
    const textOf = (id: string, scene: Scene, seed: number) => real.texts.cells.get(frameKey(id, scene, seed))!;
    const role = 'The woman from the reference picture';
    const put = (text: string, base: string) => {
      const cut = base.indexOf(role) + role.length, added = text.length - base.length;
      return base.includes(role) && added > 2 && text.startsWith(base.slice(0, cut)) && text.endsWith(base.slice(cut)) ? text.slice(cut, cut + added) : undefined;
    };
    const looks = new Set<string>(), seconds = new Set<string>();
    const kept = SCENES.every(scene => SEEDS_2.every(seed => {
      const w0 = textOf('W-L0', scene, seed).prompt, w1 = textOf('W-L1', scene, seed).prompt;
      const r0 = put(textOf('R-L0', scene, seed).prompt, firstOf('R', scene)), r1 = put(textOf('R-L1', scene, seed).prompt, firstOf('R', scene));
      const l0 = r0?.slice(2), l1 = r1?.slice(2);
      if (l0 !== undefined) looks.add(l0);
      if (l1 !== undefined) seconds.add(l1);
      return l0 !== undefined && l1 !== undefined && r0 === `, ${l0}` && r1 === `, ${l1}` && w0 === firstOf('W', scene) && w0.split(l0).length === 2
        && w1 === w0.replace(l0, l1) && textOf('FV-L0', scene, seed).prompt === firstOf('FV', scene) && textOf('FC-L0', scene, seed).prompt === firstOf('FC', scene)
        && textOf('R-L0-NEG', scene, seed).prompt === textOf('R-L0', scene, seed).prompt && textOf('W-L0-NEG', scene, seed).prompt === w0;
    }));
    const words = (text: string | undefined) => text?.trim().split(/\s+/).length ?? 0, [l0] = looks, [l1] = seconds;
    say(`2 the texts beside the first stand's: kept and added as planned ${kept}; one look a side ${looks.size === 1 && seconds.size === 1}, `
      + `the first ${words(l0)} words, the second ${words(l1)}; the negative on the ${PLANNED_2.filter(one => textOf(one.id, one.scene!, one.seed).negative !== '').length} cells at CFG 2 alone`);
    expect(kept && looks.size === 1 && seconds.size === 1 && l0 !== l1 && words(l0) === 26 && words(l1) >= 15 && words(l1) <= 25
      && PLANNED_2.every(one => (textOf(one.id, one.scene!, one.seed).negative !== '') === (one.cfg === 2)), 'each text the first stand\'s or one look changed');

    // Every graph from the real texts, each reference named as an upload would be, read back independently.
    const names = (one: Planned) => one.refs.map((ref, n) => `ref-${sha256(`${ref.from}:${n}`).slice(0, 16)}.png`);
    const built = PLANNED_2.map(one => ({ one, graph: buildJob({ ...real, card }, one, real.texts.cells.get(one.key)!, names(one)) }));
    const wrongBuilt = built.filter(({ one, graph }) => !cellRight(graph, one, real.texts.cells.get(one.key)!, names(one), { ...real, card })).map(({ one }) => one.key);
    const encoderOf = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21')!.inputs;
    const samplerOf = (graph: Graph) => Object.values(graph).find(node => node.class_type === 'KSampler')!.inputs;
    const chains = (graph: Graph) => slotChains(graph).map(slot => slot.chain.slice(0, 5));
    const wanted: Record<string, unknown[][]> = { R: [['ImageScale', 'area', 352, 640, 'disabled']], W: [],
      FV: [['ImageScale', 'area', 352, 640, 'disabled'], ['ImageScale', 'area', 352, 640, 'disabled']], FC: [['ImageCrop', 720, 400, 0, 0]] };
    const shaped = built.every(({ one, graph }) => encoderOf(graph).resolution === 0 && same(chains(graph), wanted[one.id.split('-')[0]])
      && samplerOf(graph).cfg === one.cfg && (encoderOf(graph).negative_prompt !== '') === (one.cfg === 2));
    say(`3 every graph built from the real texts: ${built.length - wrongBuilt.length} of ${built.length} read back right${wrongBuilt.length ? `, wrong ${wrongBuilt.join(', ')}` : ''}; `
      + `R one reference and FV two through ImageScale 352x640, FC through ImageCrop 720x400, W none, all at resolution 0, and the negative with CFG 2 alone: ${shaped}`);
    expect(!wrongBuilt.length && shaped, 'every graph of the real texts as its cell asks');

    // The copies the fake draws: a made-up word in every prompt and negative, and their own pins.
    const word = madeUpName(), marker = madeUpName(name => name !== word);
    const writeTexts = (to: string, cells: TextCell[]) => {
      const bytes = JSON.stringify({ note: 'The real texts with a made-up word, for the dry run.', cells: cells.map(cell => ({ ...cell, prompt: `${cell.prompt} ${word}`,
        negative: cell.negative ? `${cell.negative} ${word}` : '' })) }, null, 2);
      writeFileSync(join(to, TEXTS_FILE), bytes, { mode: 0o600 });
      return sha256(bytes);
    };
    const firstMarked = writeTexts(from, PLANNED.map(one => first.texts.cells.get(one.key)!));
    const marked = writeTexts(out, PLANNED_2.map(one => real.texts.cells.get(one.key)!));
    const started = await startFakeComfy({ jobMs: 20, referenceMs: 0, requireUploads: true, marker, argv: TRITON_ARGV, startupLog: kitchenLines(true, 'cu130'),
      pytorch: '2.11.0+cu130', objectInfo: attentionInfo(true) });
    fake = started;
    origin = started.url;
    const quiet = () => undefined, events: object[] = [];
    const drawFirst = (to: string, keys: string[]) => drawStand({ out: to, comfy: origin, until: Date.now() + 3600000, pinned: firstMarked, keys, pollMs: 10,
      waitMs: 60000, timeoutMs: 10000, log: quiet });
    const draw = (extra: Partial<Parameters<typeof drawStand>[0]> = {}) => drawStand({ out, comfy: origin, until: Date.now() + 3600000, pinned: marked,
      stand: STAND_2, from, pollMs: 10, waitMs: 60000, timeoutMs: 10000, log: event => events.push(event), ...extra });
    const lent = await drawFirst(from, borrowed);
    say(`4 the first stand's references in a run of their own: ${countsOf(lent).drawn} of ${borrowed.length} drawn, ${started.jobs.length} jobs`);
    expect(countsOf(lent).drawn === 4 && started.jobs.length === 4, 'the four references drawn');

    writePage(out, inputsOf(join(out, TEXTS_FILE), marked, PLANNED_2), undefined, STAND_2);
    const before = readFileSync(join(out, 'index.html'), 'utf8');
    const figures = (page: string) => (page.match(/<figure>/g) ?? []).length;
    const pageKeys = SECTIONS_2.flatMap(section => section.rows.flatMap(row => row.keys.filter((key): key is string => key !== undefined)));
    say(`5 the page before the card: ${figures(before)} figures in ${(before.match(/<section>/g) ?? []).length} sections, ${(before.match(/<details>/g) ?? []).length} prompts folded`);
    expect(figures(before) === 96 && same([...pageKeys].sort(), PLANNED_2.map(one => one.key).sort()) && (before.match(/<details>/g) ?? []).length === 96
      && !existsSync(join(out, INDEX_FILE)), 'the page before the card shows every cell once, with its prompt');

    say('6 refusals before anything is sent or written:');
    const beforeRefusals = started.jobs.length, beforeUploads = started.uploads.length;
    await refused('texts other than the pinned', () => draw({ pinned: sha256('another texts.json') }));
    await refused('no --from', () => draw({ from: undefined }));
    const empty = join(dry, 'empty');
    mkdirSync(empty, { recursive: true, mode: 0o700 });
    await refused('a --from without its cells.json', () => draw({ from: empty }));
    const other = join(dry, 'other'), lentIndex = readJson<StandIndex>(join(from, INDEX_FILE))!;
    mkdirSync(other, { recursive: true, mode: 0o700 });
    writeFileSync(join(other, INDEX_FILE), JSON.stringify({ ...lentIndex, pins: { ...lentIndex.pins, transformer: 'another-transformer.safetensors' } }), { mode: 0o600 });
    await refused('a --from drawn from other weights', () => draw({ from: other }));
    started.options.pytorch = '2.11.0+cu128';
    await refused('a server on cu128', () => draw());
    started.options.pytorch = '2.11.0+cu130';
    expect(started.jobs.length === beforeRefusals && started.uploads.length === beforeUploads && !existsSync(join(out, INDEX_FILE)), 'the refusals send and write nothing');

    const short = await draw({ until: Date.now() + 5000 });
    say(`7 five seconds left: stopped ${short.stopped}, ${started.jobs.length - beforeRefusals} jobs sent`);
    expect(short.stopped === 'until' && started.jobs.length === beforeRefusals, 'a cell that cannot end by --until is not begun');

    const firstMain = sent.length, firstJob = started.jobs.length;
    const run = await draw(), afterRun = started.jobs.length;
    const again = await draw();
    say(`8 the stand: ${afterRun - firstJob} jobs, ${countsOf(run).drawn} drawn; a resume: ${started.jobs.length - afterRun} more, ${countsOf(again).drawn} drawn`);
    expect(afterRun - firstJob === 96 && countsOf(run).drawn === 96 && started.jobs.length === afterRun && countsOf(again).drawn === 96 && !again.stopped && !again.error,
      'the 96 drawn, then none again');

    // Each job against its cell, in the order drawn, and what the fake made of it; each reference by arm as the card
    // gets it: the picture, what the graph hands the encoder, the size the encoder draws it at, and its change of shape.
    const setup = setupOf(out, marked, PLANNED_2), wrong: string[] = [];
    const lentFile = (key: string) => join(from, BY_KEY.get(key)!.file);
    const uploadName = (key: string) => `ref-${sha256(stripPngMetadata(readFileSync(lentFile(key)))).slice(0, 16)}.png`;
    const seen = new Map<string, { arm: string; how: How; ids: Set<string>; picture: Size; handed: Size; encoder: Size; change: number }>();
    PLANNED_2.forEach((one, n) => {
      const graph = sent[firstMain + n], job: FakeJob | undefined = started.jobs[firstJob + n], cell = again.cells[one.key];
      const refNames = one.refs.map(ref => uploadName(ref.from)), text = setup.texts.cells.get(one.key)!;
      job?.slots.forEach((slot, s) => {
        const ref = one.refs[s], picture = pngSize(readFileSync(lentFile(ref.from)));
        const shown = slot.cropped ? { width: slot.cropped.width, height: slot.cropped.height } : picture, handed = slot.scaled ?? shown;
        const [width, height] = referenceGeometry(handed.width, handed.height, 0);
        const change = Math.abs(width / height / (shown.width / shown.height) - 1), row = `${one.arm} ${ref.how} ${sizeText(picture)} ${width}x${height}`;
        const entry = seen.get(row) ?? { arm: one.arm, how: ref.how, ids: new Set<string>(), picture, handed, encoder: { width, height }, change };
        seen.set(row, { ...entry, ids: entry.ids.add(one.id) });
      });
      const right = graph !== undefined && same(buildJob(setup, one, text, refNames), graph) && cellRight(graph, one, text, refNames, setup)
        && samplerOf(graph).cfg === one.cfg && encoderOf(graph).negative_prompt === text.negative
        && job?.outcome === 'success' && job.sampler === 'KSampler' && job.start === null && job.noiseMask === null && !job.composites.length
        && same(job.slots, one.refs.map((ref, s) => ({ slot: s + 1, file: refNames[s], scaled: ref.how === 's352' ? SCALED : null, cropped: ref.how === 'crop' ? CROP : null })))
        && same(job.model, ['ModelAttentionBackend', 'QwenImage21Cache', 'UNETLoader']) && same(job.images, [{ node: '9', ...one.canvas }])
        && cell?.status === 'drawn' && cell.width === one.canvas.width && cell.height === one.canvas.height && cell.file === one.file
        && existsSync(join(out, one.file)) && cell.seed === one.seed && cell.fallback === 0
        && same(cell.references ?? [], one.refs.map(ref => sha256(readFileSync(lentFile(ref.from)))));
      if (!right) wrong.push(one.key);
    });
    say(`9 jobs against their reading and the fake's: ${PLANNED_2.length - wrong.length} of ${PLANNED_2.length} right${wrong.length ? `, wrong ${wrong.join(', ')}` : ''}`);
    expect(!wrong.length && sent.length - firstMain === 96, 'every job sends its own graph in the plan\'s order, with the first run\'s pictures');
    const handedBy: Partial<Record<How, string>> = { s352: 'ImageScale hands on', crop: 'ImageCrop hands on' };
    say('   each reference by arm: the picture, what the graph hands the encoder, the size the encoder draws it at, the change of shape');
    for (const one of seen.values()) {
      say(`   ${one.arm} ${[...one.ids].join(', ')}: the picture ${sizeText(one.picture)}, ${handedBy[one.how]} ${sizeText(one.handed)}, `
        + `at resolution 0 the encoder draws it at ${sizeText(one.encoder)}, shape changed ${(one.change * 100).toFixed(1)} %`);
    }
    const sizes: Record<string, string[]> = {};
    for (const one of seen.values()) sizes[one.how] = [...new Set([...(sizes[one.how] ?? []), sizeText(one.encoder)])];
    expect(same(Object.keys(sizes).sort(), ['crop', 's352']) && same(sizes.s352, ['352x640']) && same(sizes.crop, ['704x384'])
      && [...seen.values()].every(one => one.change <= 0.05), 'each reference reaches the encoder at its size, none squeezed by more than 5 %');

    // A reference the first run lacks: its cells out, the others drawn.
    const lacking = join(dry, 'lacking');
    mkdirSync(lacking, { recursive: true, mode: 0o700 });
    writeCardRecord(join(lacking, 'card.txt'));
    writeTexts(lacking, PLANNED.map(one => first.texts.cells.get(one.key)!));
    await drawFirst(lacking, borrowed.filter(key => key !== viewKey('H-34R')));
    const partOut = join(dry, 'part');
    mkdirSync(partOut, { recursive: true, mode: 0o700 });
    writeCardRecord(join(partOut, 'card.txt'));
    writeTexts(partOut, PLANNED_2.map(one => real.texts.cells.get(one.key)!));
    const partKeys = [frameKey('FV-L0', 'K-solo', 21), frameKey('FV-L0', 'P', 21), frameKey('R-L0-NEG', 'K-solo', 21)], beforePart = started.jobs.length;
    const part = await draw({ out: partOut, from: lacking, keys: partKeys });
    say(`10 a view the first run lacks: ${started.jobs.length - beforePart} jobs, drawn ${countsOf(part).drawn}, out ${JSON.stringify(countsOf(part).out)}`);
    expect(started.jobs.length - beforePart === 2 && part.cells[partKeys[0]]?.code === 'reference_missing' && countsOf(part).drawn === 2,
      'a missing reference leaves its cells out');

    say(`11 the fake held at most ${started.mostHeld} job at once; ${strays} calls to anything but the fake; server pins ${JSON.stringify(again.server)}`);
    expect(started.mostHeld === 1 && strays === 0 && again.server.triton === 'enabled', 'one job at a time, the fake alone, the bot\'s path');

    const page = readFileSync(join(out, 'index.html'), 'utf8'), links = [...new Set([...page.matchAll(/href="([^"]+)"/g)].map(match => match[1]))];
    const prose = page.replace(/<pre>[\s\S]*?<\/pre>/g, ''), dashes = /[–—]/;
    const mode = (path: string) => statSync(path).mode & 0o777;
    const modes = mode(out) === 0o700 && mode(join(out, INDEX_FILE)) === 0o600 && mode(join(out, 'index.html')) === 0o600 && mode(join(out, 'frames')) === 0o700
      && PLANNED_2.every(one => mode(join(out, one.file)) === 0o600);
    say(`12 page: ${figures(page)} figures, ${links.length} links, ${links.filter(link => existsSync(resolve(out, link))).length} where they lead; `
      + `dashes in its own words ${dashes.test(prose)}; directories 700 and files 600: ${modes}`);
    expect(figures(page) === 96 && links.length === 96 && links.every(link => existsSync(resolve(out, link))) && !page.includes('не нарисовано')
      && !dashes.test(prose) && page.includes('Triton включён') && page.includes('Нарисовано 96 из 96') && modes, 'the page links every picture, in words without dashes');

    // The prompts' word is in the texts and on the pages, and nowhere else; the fake's word is nowhere.
    const text = output.text(), wordForms = markerForms(word), marks = markerForms(marker);
    const shown = (name: string) => name === TEXTS_FILE || name === 'index.html';
    const beyond = searchTree(dry, wordForms, path => shown(basename(path)));
    const anywhere = searchTree(dry, marks);
    const printed = [...wordForms, ...marks].some(form => Buffer.from(text, 'utf8').includes(form));
    say(`13 privacy: the prompts' word in ${beyond.hits.length} of ${beyond.files} files beside the texts and the pages, unread ${beyond.unread.length + anywhere.unread.length}; `
      + `the fake's word in ${anywhere.hits.length} of ${anywhere.files}; printed ${printed}`);
    expect(!beyond.hits.length && !anywhere.hits.length && !beyond.unread.length && !anywhere.unread.length && !printed,
      'no prompt anywhere but the texts and the pages, and nothing printed');
    say(missed.length ? `the second stand's dry run did NOT go as expected: ${missed.length} of its checks` : 'the second stand\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    globalThis.fetch = fetched;
    await fake?.close();
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

// ---- The command line ----

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string' }, from: { type: 'string' }, dir: { type: 'string' }, texts: { type: 'string' }, tokenizers: { type: 'string' }, until: { type: 'string' },
    comfy: { type: 'string', default: 'http://127.0.0.1:8188' }, wait: { type: 'string', default: '300' }, timeout: { type: 'string', default: '60' },
    minutes: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'estimate') {
    print({ event: 'estimate', ...estimateOf(undefined, 0, Number(values.minutes), PLANNED_2) });
    return;
  }
  if (command === 'dry-run') {
    if (!values.texts || !values.from) throw new Refusal('Use: dry-run --texts <the run\'s texts.json> --from <the first stand\'s directory> [--tokenizers <dir>] [--dir <dir>]');
    const result = await dryRun2(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-refs-stand-2-dry-')), resolve(values.texts),
      join(resolve(values.from), TEXTS_FILE), resolve(values.tokenizers ?? join(ROOT, 'tokenizers')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (!values.out) throw new Refusal('Use: image-refs-stand-2.ts estimate|dry-run|draw|page; draw and page take --out <the run\'s directory>');
  const out = resolve(values.out);
  if (command === 'page') {
    writePage(out, inputsOf(join(out, TEXTS_FILE), TEXTS_SHA256_2, PLANNED_2), readJson<StandIndex>(join(out, INDEX_FILE)), STAND_2);
    print({ event: 'page', file: join(out, 'index.html') });
  } else if (command === 'draw') {
    const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
    if (!values.from || !Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
      || !Number.isInteger(timeout) || timeout < 10) {
      throw new Refusal('Use: draw --out <dir> --from <the first stand\'s directory> --until <epoch seconds> [--wait 300] [--timeout 60] [--comfy http://127.0.0.1:8188]');
    }
    const index = await drawStand({ out, comfy: comfyUrl(values.comfy!), until, pinned: TEXTS_SHA256_2, stand: STAND_2, from: resolve(values.from),
      waitMs: wait * 1000, timeoutMs: timeout * 1000, log: print });
    if (index.error || index.stopped) process.exitCode = 1;
  } else throw new Refusal('Use: image-refs-stand-2.ts estimate|dry-run|draw|page (docs/action-experiment.md#refs-stand-2)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
