// The judging of the prompt arms probe (docs/action-experiment.md#prompt-arms-judging), as round two judged its
// pictures (local/action-judge.ts) and as the GPT-6 Astra review of 2026-09-28 changed it before the card: for each
// scene and seed one fresh `codex exec` session of GPT-6 Astra at high effort in a read-only sandbox, shown the scene,
// the sheet with the proportions its looks name, round two's checklist of the scene without which relations are
// essential, and that seed's pictures of every arm under names drawn at random, in an order drawn at random, both kept
// in judge/keys/ with which arm drew which. The task is round two's `pictures` with what the review changed (`TASK`),
// and the schema round two's with each participant's place and the people beyond the checklist (`probeSchema`); no
// session sees a prompt. Four scenes are judged again at seed 7, round two's `repeatedScenes`, under fresh names in a
// fresh order, for the judge's agreement with itself. A session without valid answers gets one fresh Astra session;
// both attempts are kept, the first valid answer counts, and a second attempt without one leaves a missing judgment,
// not a failed picture: the score counts it and leaves the verdicts it touches undecided. G against C0 is the probe's
// one primary comparison; PE, GPE (G→PE), PT and A+ against C0 are exploratory, and GPE against G as well (`compare`).
// Every frame the plan has is accounted for per arm: planned, drawn, failed on the card, the enhancer's failure, not
// reached, judged, and without a judgment (`armsOf`).
//   trial      before the card: the review's two blinded samples under the task and schema it left (two sessions)
//   bundles    after the card: every session's bundle from the stands' pictures, each checked against its cell's hash
//   judge      the sessions, three at a time
//   score      the scores, the clauses, the agreement, and the contacts the prompts name against those the pictures show
//   dry-run    the whole judging on made-up pictures, with a stand-in for codex
// The review itself ran from 435b726's `review`, on the design as it then was. What this prints is names, codes,
// counts and times: never a word of a scene, a prompt or an answer.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { repeatedScenes } from '../examples/action-set.ts';
import { pngSize, stripPngMetadata } from './image-batch.ts';
import { FRAME_CANVAS } from './action-draw.ts';
import { Refusal, capture, searchTree } from './action-boundary.ts';
import { safeError } from './image-action.ts';
import { fitsSchema, readJson, storyDir } from './action-text.ts';
import type { Schema, StoryText } from './action-text.ts';
import { ENDING, JUDGE, MIXUPS, SHOWN, each, judgePins, projectionOf, runAttempt, sceneOf, sheetLines, shown, strict } from './action-judge.ts';
import type { AttemptRecord, Checklist, Exec, PicturesInput, Projection, Read } from './action-judge.ts';
import { interval } from './action-report.ts';
import { fakeCodex } from './image-refs-judge.ts';
import { greyPng } from './fake-comfy.ts';
import { INDEX_FILE } from './image-refs-test.ts';
import type { StandIndex } from './image-refs-test.ts';
import { ARMS, ARM_SEEDS, CHECKS_FILE, ENHANCER_FAILURES, FROZEN_SHA256, REWRITES_FILE, REWRITTEN, SCENES, SCHEDULES_FILE, STANDS, STAND_OF, armKey, armLabel,
  isRewritten } from './image-prompt-arms.ts';
import type { Arm, Optional, PromptCheck, Rewrites, Rewritten, Schedule, Schedules } from './image-prompt-arms.ts';

const ROOT = resolve(import.meta.dirname, '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const print = (value: object) => console.log(JSON.stringify(value));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
};
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const EPS = 1e-9;

// ---- The sessions ----

export const REPEATED = repeatedScenes().filter(scene => SCENES.includes(scene));
export type JudgeSession = { name: string; kind: 'pictures' | 'repeat'; scene: string; seed: number };
export const judgeSessions = (): JudgeSession[] => [
  ...ARM_SEEDS.flatMap(seed => SCENES.map(scene => ({ name: `pictures-${scene}-s${seed}`, kind: 'pictures' as const, scene, seed }))),
  ...REPEATED.map(scene => ({ name: `repeat-${scene}-s${ARM_SEEDS[0]}`, kind: 'repeat' as const, scene, seed: ARM_SEEDS[0] }))];
export const judgeDirOf = (run: string) => join(resolve(run), 'judge');

// ---- The task ----

// The rules the review added to the task, in its words.
export const REVIEW_RULES = 'Identify each participant from visible appearance and independently identifying clothing; do not use the action expected in the story as proof of identity. Do not transfer an identity between pictures. Use a one-to-one assignment; if competing assignments remain, answer unsure. For an item whose required participant is absent, answer no; if identity or the required contact cannot be resolved, answer unsure. A limb hidden by clothing, another body or the frame is not by itself an anatomical error. Evaluate only the checklist\'s stated moment, not an earlier action in the scene.';
// Round two's `pictures` task (action-judge.ts TASKS.pictures) with the review's changes: each participant's place kept
// in the answer beside whether they are there, the people beyond the checklist asked for, and the review's rules.
export const TASK = `Ты оцениваешь картинки к сцене из интерактивной истории.

В input.json: scene — сцена; sheet — лист персонажей (entry, name, look, outfit и, если look их называет, proportions — пропорции тела, у каждой слова look о ней); ${SHOWN}; pictures — имена картинок, они лежат в этой папке и приложены.

Для каждой картинки сначала скажи, кто есть кто, по внешности и месту, прежде чем оценивать действие: participants — у каждого участника status, present, absent или unsure, и location — коротко, где он на картинке, или null, если его нет; extra_participants — есть ли на картинке люди или существа, которых нет среди участников checklist: yes, no или unsure. Если не можешь понять, кто есть кто, отвечай unsure за этого участника, а не решай по действию.
Потом для каждой картинки:
1. items — каждое отношение, взгляд, лицо, отражение, пункт одежды и масштаба: yes, no или unsure. Касание, закрытое телом, — unsure, если картинка его не показывает; касание, которое срезает край кадра, — no. Отражение — yes, если на картинке видно отражение этого участника и в нём тот же человек в той же позе.
2. mixups — есть ли путаница каждого вида: действие делает не тот участник (wrong_person), двое поменялись внешностью (swapped_looks), двое слились в одного (merged).
3. anatomy — есть ли ошибка анатомии: лишняя или недостающая конечность, слившиеся тела, сустав, согнутый так, как он не гнётся.
4. looks — для каждого участника, у которого есть entry: выглядит ли он так, как говорит его строка листа.
5. proportions — для каждого участника, у записи которого есть proportions, и каждой пропорции оттуда (height — рост, build — телосложение, shoulders — плечи, bust — грудь, waist — талия, hips — бёдра, buttocks — ягодицы, legs — ноги, arms — руки), каждой отдельно: такая ли она у него на картинке, как говорят слова look о ней, yes или no; not_visible — если картинка её не показывает: она закрыта, срезана краем кадра или не видна с этой стороны.
В mixups, anatomy и looks отвечай yes, no или unsure. Картинки можно сравнивать между собой.

${REVIEW_RULES}

${ENDING}`;
const YNU: Schema = { type: 'string', enum: ['yes', 'no', 'unsure'] };
const PRESENCE: Schema = { type: 'string', enum: ['present', 'absent', 'unsure'] };
const SHOWN_AS: Schema = { type: 'string', enum: ['yes', 'no', 'not_visible'] };
// Round two's `picturesSchema` with the review's bundle: each participant an object of whether they are there and
// where, null where absent, and the people beyond the checklist. Built from the bundle's input.json, it takes every
// picture, participant, item and proportion there and nothing else, which `fitsSchema` holds every answer to.
export function probeSchema(input: PicturesInput): Schema {
  const people = input.checklist.participants;
  const named = (entry: string | null) => Object.keys(input.sheet.find(line => line.entry === entry)?.proportions ?? {});
  return strict({ pictures: each(input.pictures, strict({
    participants: each(people.map(one => one.id), strict({ status: PRESENCE, location: { type: ['string', 'null'] } })), extra_participants: YNU,
    items: each(input.checklist.items.map(item => item.id), YNU), mixups: each([...MIXUPS], YNU), anatomy: YNU,
    looks: each(people.filter(one => one.entry).map(one => one.id), YNU),
    proportions: strict(Object.fromEntries(people.flatMap(one => (named(one.entry).length ? [[one.id, each(named(one.entry), SHOWN_AS)]] : [])))) })) });
}
// The schema as one hash for the pins: built for a made-up bundle of every item kind.
const TEMPLATE: PicturesInput = { scene: '', sheet: [{ entry: 'e1', name: 'n', look: 'l', outfit: 'o', proportions: { height: 'h' } }],
  checklist: { participants: [{ id: 'p1', handle: 'h', entry: 'e1' }], items: (['relation', 'gaze', 'face', 'clothes', 'mirror', 'scale'] as const)
    .map(kind => ({ id: `${kind[0]}1`, kind, quote: 'q' })) }, pictures: ['pic-0.png'] };
// What the judging is pinned to: round two's judge, effort, attached size and the words the proportions are found by
// (action-judge.ts `judgePins`), this task and schema, the probe's frozen texts and its sessions.
export const pinsOf = () => {
  const round = judgePins();
  return { model: JUDGE.model, effort: JUDGE.effort, attached: round.attached, proportions: round.proportions, task: sha256(TASK),
    schema: sha256(JSON.stringify(probeSchema(TEMPLATE))), probe: FROZEN_SHA256, sessions: sha256(JSON.stringify(judgeSessions())) };
};

// ---- The bundles ----

// Which arm drew which picture, and the order the session is shown them in, which is the order of `pictures`.
type Key = { name: string; scene: string; seed: number; task: string; schema: string; input: string; pictures: { name: string; arms: string[]; sha256: string }[] };
const SIZE = `${FRAME_CANVAS.width}x${FRAME_CANVAS.height}`;
// A picture holds its pixels and nothing a judge could read a prompt or an arm from: no text chunk of any kind.
function textChunks(bytes: Buffer) {
  const found: string[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('latin1', at + 4, at + 8);
    if (['tEXt', 'iTXt', 'zTXt'].includes(type)) found.push(type);
    at += 12 + length;
  }
  return found;
}
function checked(path: string, pinned: string, what: string) {
  const bytes = readFileSync(path), size = pngSize(bytes);
  if (sha256(bytes) !== pinned || `${size.width}x${size.height}` !== SIZE || textChunks(bytes).length) {
    throw new Refusal(`${what} is not the picture its record names at ${SIZE} without text: nothing is bundled from it`);
  }
  return bytes;
}
// A round-two scene as its sessions were shown it: the scene from a copy of its store, since round two's directory is
// never written; the sheet with the proportions; the checklist, and its projection for the scores.
export function sceneInput(round2: string, scene: string) {
  const dir = storyDir(round2, scene), text = readJson<StoryText>(join(dir, 'text.json')), checklist = readJson<Checklist>(join(dir, 'checklist.json'));
  if (!text?.worn?.length || !text.nodeId || !checklist) throw new Refusal(`${dir} has no sheet, scene or checklist: pass --round2 <round two's run directory>`);
  const temp = mkdtempSync(join(tmpdir(), 'simple-chat-prompt-arms-scene-'));
  try {
    mkdirSync(storyDir(temp, scene), { recursive: true });
    copyFileSync(join(dir, 'story.sqlite'), join(storyDir(temp, scene), 'story.sqlite'));
    return { scene: sceneOf(temp, scene, text.nodeId), sheet: sheetLines(text.worn, 'proportions'), checklist };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
const shuffled = <T>(list: T[]) => {
  const out = [...list];
  for (let at = out.length - 1; at > 0; at--) {
    const to = randomInt(at + 1);
    [out[at], out[to]] = [out[to], out[at]];
  }
  return out;
};
// One bundle, written once: the task, the inputs, the schema and the pictures, under names drawn at random and in an
// order drawn at random, neither of which says anything of an arm or a hash; the key, outside it, keeps both with the
// arms. A repeat's names are drawn apart from its first session's (`taken`).
function writeBundle(dir: string, keyFile: string, name: string, scene: string, seed: number, base: Omit<PicturesInput, 'pictures'>,
  drawn: { arms: string[]; sha256: string; bytes: Buffer }[], taken: Set<string> = new Set()) {
  const names = new Set(taken);
  const opaque = () => {
    let one: string;
    do one = `pic-${randomBytes(4).toString('hex')}.png`; while (names.has(one));
    names.add(one);
    return one;
  };
  const pictures = shuffled(drawn).map(one => ({ ...one, name: opaque() }));
  const input: PicturesInput = { ...base, pictures: pictures.map(one => one.name) }, schema = probeSchema(input);
  const inputText = JSON.stringify(input, null, 2), schemaText = JSON.stringify(schema, null, 2);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'TASK.md'), `${TASK}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'input.json'), inputText, { mode: 0o600 });
  writeFileSync(join(dir, 'schema.json'), schemaText, { mode: 0o600 });
  for (const one of pictures) writeFileSync(join(dir, one.name), one.bytes, { mode: 0o600 });
  const key: Key = { name, scene, seed, task: sha256(TASK), schema: sha256(schemaText), input: sha256(inputText),
    pictures: pictures.map(one => ({ name: one.name, arms: one.arms, sha256: one.sha256 })) };
  writeJson(keyFile, key);
  return key;
}
// Every session's bundle from the stands' pictures, each checked against the hash and size its cell recorded: an arm
// whose picture is another's byte for byte is shown once. A repeat shows its first session's pictures, checked again,
// under fresh names in a fresh order. A bundle there is kept; the bundles are built once the card is over.
export function writeBundles(run: string, round2: string, log: (event: object) => void = () => undefined) {
  const judge = judgeDirOf(run), indexes = new Map<string, StandIndex | undefined>();
  const indexOf = (stand: string) => {
    if (!indexes.has(stand)) indexes.set(stand, readJson<StandIndex>(join(resolve(run), stand, INDEX_FILE)));
    return indexes.get(stand);
  };
  if (!indexOf('core')) throw new Refusal(`${join(resolve(run), 'core', INDEX_FILE)} is missing: the bundles are built from the drawn pictures`);
  const counts = { built: 0, kept: 0, skipped: {} as Record<string, number> }, inputs = new Map<string, ReturnType<typeof sceneInput>>();
  const inputOf = (scene: string) => {
    if (!inputs.has(scene)) inputs.set(scene, sceneInput(round2, scene));
    const input = inputs.get(scene)!;
    return { scene: input.scene, sheet: input.sheet, checklist: shown(input.checklist) };
  };
  for (const session of judgeSessions()) {
    const dir = join(judge, 'bundles', session.name), keyFile = join(judge, 'keys', `${session.name}.json`);
    if (existsSync(dir)) { counts.kept++; continue; }
    if (session.kind === 'repeat') {
      const first = `pictures-${session.scene}-s${session.seed}`, firstKey = readJson<Key>(join(judge, 'keys', `${first}.json`));
      if (!firstKey || !existsSync(join(judge, 'bundles', first))) { counts.skipped.no_first = (counts.skipped.no_first ?? 0) + 1; continue; }
      const drawn = firstKey.pictures.map(one => ({ arms: one.arms, sha256: one.sha256, bytes: checked(join(judge, 'bundles', first, one.name), one.sha256, `${first}'s ${one.name}`) }));
      writeBundle(dir, keyFile, session.name, session.scene, session.seed, inputOf(session.scene), drawn, new Set(firstKey.pictures.map(one => one.name)));
      counts.built++;
      log({ event: 'bundle_written', session: session.name, from: first });
      continue;
    }
    const drawn: { arms: string[]; sha256: string; bytes: Buffer }[] = [];
    for (const arm of ARMS) {
      const stand = STAND_OF[arm], cell = indexOf(stand)?.cells[armKey(arm, session.scene, session.seed)];
      if (cell?.status !== 'drawn' || !cell.file || !cell.sha256) continue;
      const bytes = checked(join(resolve(run), stand, cell.file), cell.sha256, cell.key);
      const same = drawn.find(one => one.sha256 === cell.sha256);
      if (same) same.arms.push(arm); else drawn.push({ arms: [arm], sha256: cell.sha256, bytes });
    }
    if (!drawn.length) { counts.skipped.no_picture = (counts.skipped.no_picture ?? 0) + 1; continue; }
    writeBundle(dir, keyFile, session.name, session.scene, session.seed, inputOf(session.scene), drawn);
    counts.built++;
    log({ event: 'bundle_written', session: session.name, pictures: drawn.length });
  }
  return counts;
}

// ---- The judging ----

type Attempted = AttemptRecord & { codexFailed?: boolean };
export type SessionRecord = { name: string; state?: 'answered' | 'failed'; attempts: Attempted[] };
export type JudgingRecord = { pins: Record<string, string | number>; sessions: Record<string, SessionRecord>; stopped?: string };
const recordFile = (dir: string) => join(dir, 'judging.json');
function openRecord(dir: string, pins: Record<string, string | number> = pinsOf()): JudgingRecord {
  const record = readJson<JudgingRecord>(recordFile(dir)) ?? { pins, sessions: {} };
  const changed = [...new Set([...Object.keys(pins), ...Object.keys(record.pins)])].find(key => record.pins[key] !== pins[key]);
  if (changed) throw new Refusal(`${recordFile(dir)} was judged under another ${changed}: one directory holds one set of pins`);
  delete record.stopped;
  return record;
}
// A session's attempts, both Astra's: one fresh session after one without valid answers, and no more. Each attempt's
// copy of the bundle and its report stay in sessions/, and the answers are the first valid ones.
const ATTEMPTS = 2;
const codexFailed = (read: Read) => read.code === 'no_report' || read.code === 'timeout';
const picturesOf = (copy: string) => (JSON.parse(readFileSync(join(copy, 'input.json'), 'utf8')) as { pictures?: string[] }).pictures?.map(name => join(copy, name)) ?? [];
export type QueueOptions = { dir: string; bundles: string; names: string[]; prompt: (name: string) => string; images?: (copy: string) => string[];
  pins?: Record<string, string | number>; parallel?: number; exec?: Exec; codex?: string; log?: (event: object) => void; badShare?: number };
// The sessions named, each with its bundle, without answers and with an attempt left, `parallel` at a time, in order.
// The queue stops when codex itself fails twice in a row, or once more than `badShare` (a tenth) of the sessions
// planned have had an attempt without valid answers; running attempts end as they end, and a new run resumes the
// record.
export async function runQueue(options: QueueOptions): Promise<JudgingRecord> {
  const log = options.log ?? (() => undefined), record = openRecord(options.dir, options.pins);
  const save = () => writeJson(recordFile(options.dir), record);
  const planned = options.names.filter(name => existsSync(join(options.bundles, name)));
  const running = new Map<string, Promise<void>>();
  let streak = 0;
  const stopRule = () => {
    if (streak >= 2) return 'codex_failed_twice';
    const bad = planned.filter(name => record.sessions[name]?.attempts.some(one => one.code !== 'ok')).length;
    return bad > planned.length * (options.badShare ?? 0.1) ? 'failed_over_a_tenth' : undefined;
  };
  const attempt = async (name: string) => {
    const entry = record.sessions[name] ??= { name, attempts: [] };
    const base = join(options.dir, 'sessions'), copy = `${name}.${entry.attempts.length + 1}`;
    let read: Read = { code: 'no_report' }, exitCode = -1, ms = 0;
    try {
      const schema = JSON.parse(readFileSync(join(options.bundles, name, 'schema.json'), 'utf8')) as Schema;
      ({ read, exitCode, ms } = await runAttempt({ bundle: join(options.bundles, name), copy: join(base, copy), report: join(base, `${copy}.report.md`),
        events: join(base, `${copy}.events.jsonl`), stderr: join(base, `${copy}.stderr.log`), model: JUDGE.model, prompt: options.prompt(name),
        images: options.images ?? picturesOf, validate: got => (got.code === 'ok' && !fitsSchema(got.value, schema) ? { code: 'schema' } : got),
        exec: options.exec, codex: options.codex }));
    } catch { /* recorded below as an attempt without a report */ }
    const failed = codexFailed(read);
    streak = failed ? streak + 1 : 0;
    entry.attempts.push({ model: JUDGE.model, code: read.code, ...(exitCode === 0 ? {} : { exitCode }), ms, ...(failed ? { codexFailed: true } : {}) });
    if (read.code === 'ok') {
      writeJson(join(options.dir, 'answers', `${name}.json`), read.value);
      entry.state = 'answered';
    } else if (entry.attempts.length >= ATTEMPTS) entry.state = 'failed';
    save();
    log({ event: 'session_done', session: name, attempt: entry.attempts.length, code: read.code, ms, ...(exitCode === 0 ? {} : { exitCode }),
      ...(entry.state ? { state: entry.state } : {}) });
  };
  for (;;) {
    const stop = record.stopped ? undefined : stopRule();
    if (stop) { record.stopped = stop; save(); log({ event: 'judging_stopped', reason: stop }); }
    while (!record.stopped && running.size < (options.parallel ?? 3)) {
      const name = planned.find(one => !running.has(one) && !record.sessions[one]?.state && (record.sessions[one]?.attempts.length ?? 0) < ATTEMPTS);
      if (!name) break;
      running.set(name, attempt(name).finally(() => running.delete(name)));
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }
  save();
  return record;
}
export const judgeProbe = (run: string, options: Omit<QueueOptions, 'dir' | 'bundles' | 'names' | 'prompt'> & { names?: string[] }) =>
  runQueue({ ...options, dir: judgeDirOf(run), bundles: join(judgeDirOf(run), 'bundles'), names: options.names ?? judgeSessions().map(one => one.name),
    prompt: () => TASK });
export function judgingCounts(record: JudgingRecord, names: string[]) {
  const states: Record<string, number> = {};
  for (const name of names) {
    const known = record.sessions[name], state = known?.state ?? (known?.attempts.length ? 'retry' : 'pending');
    states[state] = (states[state] ?? 0) + 1;
  }
  const attempts = names.flatMap(name => record.sessions[name]?.attempts ?? []);
  const ms = attempts.filter(one => one.code === 'ok').map(one => one.ms).sort((a, b) => a - b);
  return { sessions: names.length, states, attempts: attempts.length, refusals: attempts.filter(one => one.code === 'no_block').length,
    invalid: attempts.filter(one => one.code === 'schema' || one.code === 'unparsed_block').length, codexFailed: attempts.filter(one => one.codexFailed).length,
    medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : undefined, ...(record.stopped ? { stopped: record.stopped } : {}) };
}

// ---- The scores ----

type YNU = 'yes' | 'no' | 'unsure';
export type Answer = { participants: Record<string, { status: 'present' | 'absent' | 'unsure'; location: string | null }>; extra_participants: YNU;
  items: Record<string, YNU>; mixups: Record<string, YNU>; anatomy: YNU; looks: Record<string, YNU>;
  proportions: Record<string, Record<string, 'yes' | 'no' | 'not_visible'>> };
export type Tally = { yes: number; no: number; unsure: number; of: number };
const NONE: Tally = { yes: 0, no: 0, unsure: 0, of: 0 };
const plus = (a: Tally, b: Tally): Tally => ({ yes: a.yes + b.yes, no: a.no + b.no, unsure: a.unsure + b.unsure, of: a.of + b.of });
const WITH = ['person', 'self', 'thing'] as const, KINDS = ['gaze', 'face', 'clothes', 'mirror', 'scale'] as const;
export type PictureScore = { visible: number | null; allVisible: boolean; essential: Tally; byWith: Record<typeof WITH[number], Tally>; otherRelations: Tally;
  kinds: Record<typeof KINDS[number], Tally>; complete: boolean; extra: YNU; mixup: { confirmed: boolean; notRuledOut: boolean };
  anatomy: { confirmed: boolean; notRuledOut: boolean }; looks: { conservative: number | null; upper: number | null }; proportions: number | null; shown: string[] };
// A picture's scores, as the review named and split them. `visible`, visible_essential_relations: the essential
// relations answered yes over all of them, `no` and `unsure` counting nothing, with the three answers' counts apart
// (`essential`) and by what a relation is with: another participant, the subject's own body, a thing. `complete`: every
// participant of the checklist answered present. A mixup and an anatomy error `confirmed` where answered yes, and
// `notRuledOut` where not answered no, round two's conservative reading. `looks` over the checklist's participants
// with a sheet entry: present and yes, and as an upper bound present and yes or unsure. The gazes, faces, clothes,
// reflections and scale by kind, the proportions and the people beyond the checklist are reported, in no clause.
export function scoreAnswer(projection: Projection, answer: Answer): PictureScore {
  const tally = (ids: string[]): Tally => ({ yes: ids.filter(id => answer.items[id] === 'yes').length, no: ids.filter(id => answer.items[id] === 'no').length,
    unsure: ids.filter(id => answer.items[id] === 'unsure').length, of: ids.length });
  const ids = (items: { id: string }[]) => items.map(item => item.id);
  const relations = projection.items.filter(item => item.kind === 'relation'), essential = relations.filter(item => item.essential);
  const counted = tally(ids(essential)), present = (id: string) => answer.participants[id]?.status === 'present';
  const sheetPeople = projection.participants.filter(one => one.entry).map(one => one.id);
  const looks = (credit: YNU[]) => (sheetPeople.length ? sheetPeople.filter(id => present(id) && credit.includes(answer.looks[id])).length / sheetPeople.length : null);
  const mixups = MIXUPS.map(name => answer.mixups[name]);
  const shownAs = Object.entries(answer.proportions ?? {}).flatMap(([id, named]) => (present(id) ? Object.values(named).filter(value => value !== 'not_visible') : []));
  return { visible: essential.length ? counted.yes / essential.length : null, allVisible: essential.length > 0 && counted.yes === essential.length, essential: counted,
    byWith: Object.fromEntries(WITH.map(kind => [kind, tally(ids(essential.filter(item => (item.with ?? 'person') === kind)))])) as PictureScore['byWith'],
    otherRelations: tally(ids(relations.filter(item => !item.essential))),
    kinds: Object.fromEntries(KINDS.map(kind => [kind, tally(ids(projection.items.filter(item => item.kind === kind)))])) as PictureScore['kinds'],
    complete: projection.participants.every(one => present(one.id)), extra: answer.extra_participants,
    mixup: { confirmed: mixups.includes('yes'), notRuledOut: mixups.some(value => value !== 'no') },
    anatomy: { confirmed: answer.anatomy === 'yes', notRuledOut: answer.anatomy !== 'no' },
    looks: { conservative: looks(['yes']), upper: looks(['yes', 'unsure']) },
    proportions: shownAs.length ? shownAs.filter(value => value === 'yes').length / shownAs.length : null,
    shown: ids(essential).filter(id => answer.items[id] === 'yes') };
}

// What came of each case, a scene at a seed, of an arm: judged, with its scores; drawn and without a judgment; the
// enhancer's output unusable (PE, GPE, PT); the frame failed on the card; not reached before the card's end, or cut by
// the server; or, for an arm drawn only with a budget, its schedule never begun. `rewrite`: whether the arm's pass gave
// the scene a usable text.
export const OUTCOMES = ['judged', 'not_judged', 'enhancer_failed', 'render_failed', 'not_reached', 'budget_omitted'] as const;
export type Outcome = typeof OUTCOMES[number];
export type Case = { arm: Arm; scene: string; seed: number; outcome: Outcome; score?: PictureScore; rewrite?: boolean };
export function casesOf(run: string, projections: Record<string, Projection>): Case[] {
  const dir = judgeDirOf(run), record = readJson<JudgingRecord>(recordFile(dir));
  const schedules = readJson<Schedules>(join(resolve(run), SCHEDULES_FILE)) ?? {};
  const rewrites = Object.fromEntries(REWRITTEN.map(arm => [arm, readJson<Rewrites>(join(resolve(run), REWRITES_FILE[arm]))])) as Record<Rewritten, Rewrites | undefined>;
  const indexes = Object.fromEntries(STANDS.map(stand => [stand, readJson<StandIndex>(join(resolve(run), stand, INDEX_FILE))]));
  const scored = new Map<string, PictureScore>();
  for (const session of judgeSessions().filter(one => one.kind === 'pictures')) {
    if (record?.sessions[session.name]?.state !== 'answered') continue;
    const key = readJson<Key>(join(dir, 'keys', `${session.name}.json`)), answers = readJson<{ pictures: Record<string, Answer> }>(join(dir, 'answers', `${session.name}.json`));
    for (const picture of key?.pictures ?? []) {
      const answer = answers?.pictures[picture.name];
      if (answer) scored.set(`${session.name}:${picture.sha256}`, scoreAnswer(projections[session.scene], answer));
    }
  }
  return ARMS.flatMap(arm => SCENES.flatMap(scene => ARM_SEEDS.map((seed): Case => {
    const base = { arm, scene, seed };
    if (arm !== 'C0' && arm !== 'G' && schedules[arm as Optional]?.state !== 'begun') return { ...base, outcome: 'budget_omitted' };
    if (isRewritten(arm)) {
      const rewrite = rewrites[arm]?.scenes[scene];
      if (rewrite?.status !== 'ok') {
        return { ...base, outcome: rewrite && ENHANCER_FAILURES.includes(rewrite.code ?? '') ? 'enhancer_failed' : 'not_reached', rewrite: false };
      }
    }
    const own = { ...base, ...(isRewritten(arm) ? { rewrite: true } : {}) };
    const cell = indexes[STAND_OF[arm]]?.cells[armKey(arm, scene, seed)];
    if (cell?.status === 'failed' || cell?.status === 'out') return { ...own, outcome: 'render_failed' };
    if (cell?.status !== 'drawn' || !cell.sha256) return { ...own, outcome: 'not_reached' };
    const score = scored.get(`pictures-${scene}-s${seed}:${cell.sha256}`);
    return score ? { ...own, outcome: 'judged', score } : { ...own, outcome: 'not_judged' };
  })));
}

// The clauses each arm is set against its baseline by, fixed on 2026-09-28 before any picture was drawn and changed by
// the review before the card. G against C0 is the primary comparison; PE, GPE, PT and A+ against C0 exploratory, and
// GPE against G as well. Every difference is the mean over scenes of each scene's difference, a scene's value the mean
// over the seeds where both arms have a case. `visible_essential_relations` gains 0.10 or more over 8 scenes at least,
// and the lower end of the 90% interval from 10,000 resamples of whole scenes (action-report.ts `interval`) is above 0,
// else undecided; no fewer pictures than the baseline with every essential relation visible and with every
// participant; no more mixups, and at most max(1, n/10) more anatomy errors among the n pictures judged in both, each
// counted as confirmed and with unsure counted in; `looks` not below the baseline's by more than 0.05,
// conservatively and at its upper bound; a safeguard whose two readings disagree is unresolved and leaves the arm
// undecided, unless another clause fails outright; and the arm's own visible_essential_relations 0.50 or more. A frame
// that failed on the card counts as a picture that shows none, on either side; so does an unusable text of the
// enhancer for PE, GPE and PT, which are held to the relations over every case their schedule planned (`operational`).
// Their comparison over the pictures they drew is a diagnostic with no verdict, and reads drawn pictures alone. A case
// drawn and never judged is counted apart (`missing`), never read as a picture, and leaves the verdict undecided; so
// does an arm whose schedule was never begun or not finished.
export const CLAUSES = { gain: 0.10, scenes: 8, looks: -0.05, floor: 0.5 };
export type Pass = boolean | 'undecided' | 'unresolved';
export type Clause = { clause: string; value: number | null; threshold: number; scenes: number; pass: Pass; lower?: number | null;
  treatments?: Record<string, { value: number | null; pass: boolean }> };
export type Role = 'primary' | 'exploratory' | 'diagnostic';
// `shownNothing`: the pairs where the arm (`x`) or the baseline (`y`) failed on the card or had no usable text, read
// as pictures that show nothing; `missing`: the cases of each drawn and without a judgment.
export type Comparison = { arm: Arm; against: Arm; role: Role; basis: 'operational' | 'matched' | 'drawn'; scenes: number; pictures: number;
  shownNothing: { x: number; y: number }; missing: { x: number; y: number }; verdict?: 'pass' | 'fail' | 'undecided'; why?: string[];
  clauses: Clause[]; visible: { x: number | null; y: number | null; difference: number | null; interval: [number, number] | null; ahead: number; level: number; behind: number;
    byScene: Record<string, number> } };
type Pair = { scene: string; seed: number; x?: PictureScore; y?: PictureScore };
export function compare(cases: Case[], arm: Arm, role: Role, against: Arm = 'C0'): Comparison {
  const operational = role !== 'diagnostic' && isRewritten(arm);
  const at = new Map(cases.map(one => [`${one.arm}:${one.scene}:${one.seed}`, one]));
  // What a case gives a pair: its scores when judged; a picture that shows nothing when its frame failed on the card,
  // or the enhancer gave its arm no usable text, except in a diagnostic, which reads the drawn pictures alone; and no
  // pair at all otherwise: a case not reached, never begun, or drawn and not judged.
  const side = (one: Case | undefined): { score?: PictureScore } | undefined => {
    if (one?.outcome === 'judged' && one.score) return { score: one.score };
    if (role !== 'diagnostic' && (one?.outcome === 'render_failed' || (isRewritten(one?.arm ?? '') && one?.outcome === 'enhancer_failed'))) return {};
    return undefined;
  };
  const pairs: Pair[] = SCENES.flatMap(scene => ARM_SEEDS.flatMap(seed => {
    const x = side(at.get(`${arm}:${scene}:${seed}`)), y = side(at.get(`${against}:${scene}:${seed}`));
    return x && y ? [{ scene, seed, x: x.score, y: y.score }] : [];
  }));
  const judged = pairs.filter(one => one.x && one.y);
  const means = (list: Pair[], read: (score: PictureScore | undefined) => number | null) => SCENES.flatMap(scene => {
    const own = list.filter(one => one.scene === scene).map(one => ({ x: read(one.x), y: read(one.y) })).filter(one => one.x !== null && one.y !== null);
    return own.length ? [{ scene, x: mean(own.map(one => one.x!)), y: mean(own.map(one => one.y!)) }] : [];
  });
  const paired = (list: { x: number; y: number }[]) => (list.length ? mean(list.map(one => one.x - one.y)) : null);
  const counted = (list: Pair[], read: (score: PictureScore | undefined) => boolean) => list.filter(one => read(one.x)).length - list.filter(one => read(one.y)).length;
  const scenesOf = (list: Pair[]) => new Set(list.map(one => one.scene)).size;
  const relation = means(pairs, score => (score ? score.visible : 0)), gain = paired(relation);
  const bounds = interval(relation.map(one => [one.x, one.y] as [number, number])), own = relation.length ? mean(relation.map(one => one.x)) : null;
  // A safeguard read two ways: it holds or fails when both readings agree, and is unresolved when they do not.
  const twoWays = (clause: string, threshold: number, scenes: number, treatments: Record<string, { value: number | null; pass: boolean }>): Clause => {
    const [a, b] = Object.values(treatments);
    return { clause, value: a.value, threshold, scenes, pass: a.pass === b.pass ? a.pass : 'unresolved', treatments };
  };
  const fewer = (value: number, slack: number) => ({ value, pass: value <= slack });
  const slack = Math.max(1, Math.floor(judged.length / 10));
  const looks = (read: (score: PictureScore) => number | null) => {
    const value = paired(means(judged, score => (score ? read(score) : null)));
    return { value, pass: value === null || value >= CLAUSES.looks - EPS };
  };
  const allVisible = counted(pairs, score => score?.allVisible === true), complete = counted(judged, score => score?.complete === true);
  const clauses: Clause[] = [
    { clause: 'visible_essential_relations', value: gain, threshold: CLAUSES.gain, scenes: relation.length, lower: bounds?.[0] ?? null,
      pass: relation.length < CLAUSES.scenes || gain === null ? 'undecided' : gain < CLAUSES.gain - EPS ? false : bounds && bounds[0] > EPS ? true : 'undecided' },
    { clause: 'all_visible', value: allVisible, threshold: 0, scenes: scenesOf(pairs), pass: allVisible >= 0 },
    { clause: 'complete', value: complete, threshold: 0, scenes: scenesOf(judged), pass: complete >= 0 },
    twoWays('mixups', 0, scenesOf(judged), { confirmed: fewer(counted(judged, score => score?.mixup.confirmed === true), 0),
      with_unsure: fewer(counted(judged, score => score?.mixup.notRuledOut === true), 0) }),
    twoWays('anatomy', slack, scenesOf(judged), { confirmed: fewer(counted(judged, score => score?.anatomy.confirmed === true), slack),
      with_unsure: fewer(counted(judged, score => score?.anatomy.notRuledOut === true), slack) }),
    twoWays('looks', CLAUSES.looks, scenesOf(judged), { conservative: looks(score => score.looks.conservative), upper: looks(score => score.looks.upper) }),
    { clause: 'floor', value: own, threshold: CLAUSES.floor, scenes: relation.length, pass: own === null ? 'undecided' : own >= CLAUSES.floor - EPS }];
  // A clause failed whatever the unsure answers and the interval say fails the arm; otherwise one undecided or unresolved
  // leaves it undecided.
  const why = clauses.filter(one => one.pass === 'undecided' || one.pass === 'unresolved').map(one => `${one.clause}_${one.pass}`);
  const verdict = role === 'diagnostic' ? undefined : clauses.some(one => one.pass === false) ? 'fail' : why.length ? 'undecided' : 'pass';
  const diffs = relation.map(one => one.x - one.y);
  const unjudged = (of: Arm) => cases.filter(one => one.arm === of && one.outcome === 'not_judged').length;
  return { arm, against, role, basis: operational ? 'operational' : role === 'diagnostic' ? 'drawn' : 'matched', scenes: relation.length, pictures: pairs.length,
    shownNothing: { x: pairs.filter(one => !one.x).length, y: pairs.filter(one => !one.y).length }, missing: { x: unjudged(arm), y: unjudged(against) },
    ...(verdict ? { verdict } : {}), ...(why.length ? { why } : {}), clauses,
    visible: { x: own, y: relation.length ? mean(relation.map(one => one.y)) : null, difference: gain, interval: bounds,
      ahead: diffs.filter(one => one > EPS).length, level: diffs.filter(one => Math.abs(one) <= EPS).length, behind: diffs.filter(one => one < -EPS).length,
      byScene: Object.fromEntries(relation.map((one, index) => [one.scene, diffs[index]])) } };
}
// An arm is undecided while its schedule was never begun, or it or its baseline has a case the card did not reach: C0
// and G are the schedule every other waits for. So it is while either has a picture drawn and not judged.
function scheduled(comparison: Comparison, cases: Case[]): Comparison {
  const own = cases.filter(one => one.arm === comparison.arm), base = cases.filter(one => one.arm === comparison.against);
  const why = [...(own.some(one => one.outcome === 'budget_omitted') ? ['budget_omitted']
    : [...own, ...base].some(one => one.outcome === 'not_reached') ? ['schedule_unfinished'] : []),
  ...(comparison.missing.x + comparison.missing.y ? ['judgments_missing'] : [])];
  return why.length && comparison.verdict ? { ...comparison, verdict: 'undecided', why: [...why, ...(comparison.why ?? [])] } : comparison;
}
// Each arm over its judged pictures, and what came of every case it had. `frames` accounts for every frame the plan
// has: drawn, failed on the card, without a usable text of the enhancer, or not reached, cut by the card's end or the
// server (`cut`) or with its schedule never begun (`omitted`); and of those drawn, judged or without a judgment
// (`missing`). `extra`: the pictures the judge saw a person or creature in that the scene's checklist does not have.
function armsOf(cases: Case[]) {
  return Object.fromEntries(ARMS.map(arm => {
    const own = cases.filter(one => one.arm === arm), scores = own.flatMap(one => (one.score ? [one.score] : []));
    const share = (read: (score: PictureScore) => number | null) => {
      const values = scores.flatMap(score => { const value = read(score); return value === null ? [] : [value]; });
      return values.length ? mean(values) : null;
    };
    const count = (read: (score: PictureScore) => boolean) => scores.filter(read).length;
    const sum = (read: (score: PictureScore) => Tally) => scores.map(read).reduce(plus, NONE);
    const of = (outcome: Outcome) => own.filter(one => one.outcome === outcome).length;
    return [arm, { pictures: scores.length, outcomes: Object.fromEntries(OUTCOMES.flatMap(outcome => (of(outcome) ? [[outcome, of(outcome)]] : []))),
      frames: { planned: own.length, drawn: of('judged') + of('not_judged'), renderFailed: of('render_failed'), enhancerFailed: of('enhancer_failed'),
        notReached: { cut: of('not_reached'), omitted: of('budget_omitted') }, judged: of('judged'), missing: of('not_judged') },
      visible: share(score => score.visible), essential: sum(score => score.essential), allVisible: count(score => score.allVisible),
      complete: count(score => score.complete),
      mixups: { confirmed: count(score => score.mixup.confirmed), unsureOnly: count(score => score.mixup.notRuledOut && !score.mixup.confirmed),
        notRuledOut: count(score => score.mixup.notRuledOut) },
      anatomy: { confirmed: count(score => score.anatomy.confirmed), unsureOnly: count(score => score.anatomy.notRuledOut && !score.anatomy.confirmed),
        notRuledOut: count(score => score.anatomy.notRuledOut) },
      looks: { conservative: share(score => score.looks.conservative), upper: share(score => score.looks.upper) },
      extra: { yes: count(score => score.extra === 'yes'), unsure: count(score => score.extra === 'unsure') },
      byWith: Object.fromEntries(WITH.map(kind => [kind, sum(score => score.byWith[kind])])) as Record<typeof WITH[number], Tally>,
      otherRelations: sum(score => score.otherRelations),
      kinds: Object.fromEntries(KINDS.map(kind => [kind, sum(score => score.kinds[kind])])) as Record<typeof KINDS[number], Tally>, proportions: share(score => score.proportions),
      ...(isRewritten(arm) ? { usable: SCENES.filter(scene => own.some(one => one.scene === scene && one.rewrite === true)).length, of: SCENES.length } : {}) }];
  }));
}
// The judge against itself: each repeat's answers against its first session's, picture by picture through the hashes,
// since the repeat's names and order are fresh. Who is who (each participant's presence and the people beyond); the
// essential relations; the other items; the mixups, the anatomy and the looks; whether an answer is unsure at all;
// and each picture's safeguards as the scores read them.
function agreementOf(dir: string, projections: Record<string, Projection>) {
  const families: Record<string, { same: number; of: number }> = {};
  const add = (family: string, a: unknown, b: unknown) => { const one = families[family] ??= { same: 0, of: 0 }; one.of++; if (a === b) one.same++; };
  const answersOf = (answer: Answer) => new Map<string, string | undefined>([...Object.entries(answer.participants).map(([id, one]) => [`p:${id}`, one?.status] as const),
    ['extra', answer.extra_participants], ...Object.entries(answer.items).map(([id, value]) => [`i:${id}`, value] as const),
    ...Object.entries(answer.mixups).map(([id, value]) => [`x:${id}`, value] as const), ['anatomy', answer.anatomy],
    ...Object.entries(answer.looks).map(([id, value]) => [`l:${id}`, value] as const)]);
  for (const scene of REPEATED) {
    const names = [`pictures-${scene}-s${ARM_SEEDS[0]}`, `repeat-${scene}-s${ARM_SEEDS[0]}`];
    const [firstKey, againKey] = names.map(name => readJson<Key>(join(dir, 'keys', `${name}.json`)));
    const [first, again] = names.map(name => readJson<{ pictures: Record<string, Answer> }>(join(dir, 'answers', `${name}.json`)));
    if (!firstKey || !againKey || !first || !again) continue;
    const essential = new Set(projections[scene].items.filter(item => item.essential).map(item => item.id));
    for (const picture of firstKey.pictures) {
      const other = againKey.pictures.find(one => one.sha256 === picture.sha256), a = first.pictures[picture.name], b = other && again.pictures[other.name];
      if (!a || !b) continue;
      for (const id of Object.keys(a.participants)) add('identity', a.participants[id]?.status, b.participants[id]?.status);
      add('identity', a.extra_participants, b.extra_participants);
      for (const [id, value] of Object.entries(a.items)) add(essential.has(id) ? 'essential' : 'other_items', value, b.items[id]);
      for (const [id, value] of Object.entries(a.mixups)) add('mixups', value, b.mixups[id]);
      add('anatomy', a.anatomy, b.anatomy);
      for (const [id, value] of Object.entries(a.looks)) add('looks', value, b.looks[id]);
      const theirs = answersOf(b);
      for (const [key, value] of answersOf(a)) add('uncertainty', value === 'unsure', theirs.get(key) === 'unsure');
      const [x, y] = [scoreAnswer(projections[scene], a), scoreAnswer(projections[scene], b)];
      for (const read of [(s: PictureScore) => s.complete, (s: PictureScore) => s.mixup.confirmed, (s: PictureScore) => s.mixup.notRuledOut,
        (s: PictureScore) => s.anatomy.confirmed, (s: PictureScore) => s.anatomy.notRuledOut]) add('safeguards', read(x), read(y));
    }
  }
  return families;
}
// Whether a contact the prompt names in words is drawn more often: each arm's essential contacts over its judged
// pictures, by whether code found them named in its prompt (local/image-prompt-arms.ts `checks`) and whether Astra saw
// them. A description of what went together, not a cause: the named and the unnamed contacts may differ in how hard
// they are to draw.
function namedAgainstShown(run: string, cases: Case[], projections: Record<string, Projection>) {
  const checks = readJson<{ arms: Record<string, Record<string, PromptCheck>> }>(join(resolve(run), CHECKS_FILE));
  if (!checks) return undefined;
  return Object.fromEntries(ARMS.flatMap(arm => {
    const tally = { namedShown: 0, named: 0, unnamedShown: 0, unnamed: 0 };
    for (const one of cases.filter(picture => picture.arm === arm && picture.score)) {
      const check = checks.arms[arm]?.[one.scene];
      if (!check) continue;
      for (const item of projections[one.scene].items.filter(candidate => candidate.essential)) {
        const named = !check.contacts.missing.includes(item.id), drawn = one.score!.shown.includes(item.id);
        if (named) { tally.named++; if (drawn) tally.namedShown++; } else { tally.unnamed++; if (drawn) tally.unnamedShown++; }
      }
    }
    return tally.named + tally.unnamed ? [[arm, tally]] : [];
  }));
}
const projectionsOf = (round2: string) => Object.fromEntries(SCENES.map(scene => {
  const checklist = readJson<Checklist>(join(storyDir(round2, scene), 'checklist.json'));
  if (!checklist) throw new Refusal(`${storyDir(round2, scene)} has no checklist: pass --round2 <round two's run directory>`);
  return [scene, projectionOf(checklist)];
}));
export function scoreProbe(run: string, round2: string) {
  const dir = judgeDirOf(run), projections = projectionsOf(round2), cases = casesOf(run, projections), record = readJson<JudgingRecord>(recordFile(dir));
  return { pins: record?.pins, judging: record ? judgingCounts(record, judgeSessions().map(one => one.name)) : undefined, arms: armsOf(cases),
    comparisons: [scheduled(compare(cases, 'G', 'primary'), cases),
      ...([['PE', 'C0'], ['GPE', 'C0'], ['GPE', 'G'], ['PT', 'C0']] as [Arm, Arm][]).flatMap(([arm, against]) => [scheduled(compare(cases, arm, 'exploratory', against), cases),
        compare(cases, arm, 'diagnostic', against)]),
      scheduled(compare(cases, 'A+', 'exploratory'), cases)],
    agreement: agreementOf(dir, projections), namedAgainstShown: namedAgainstShown(run, cases, projections) };
}
export type ProbeScore = ReturnType<typeof scoreProbe>;
const points = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}`);
const shares = (tally: Tally) => (tally.of ? [tally.yes, tally.no, tally.unsure].map(n => points(n / tally.of)).join(' / ') : '—');
const VERDICT_RU = { pass: 'проходит', fail: 'не проходит', undecided: 'не решено' };
const ROLE_RU: Record<Role, string> = { primary: 'главное сравнение', exploratory: 'разведка', diagnostic: 'диагностика по одним нарисованным картинкам, без вердикта' };
const PASS_RU = (pass: Pass) => (pass === true ? 'да' : pass === false ? 'нет' : pass === 'unresolved' ? 'не разрешено: исход зависит от ответов «не уверен»' : 'не решено');
const CLAUSE_RU: Record<string, string> = { visible_essential_relations: 'видимые существенные отношения', all_visible: 'картинок, где видны все существенные',
  complete: 'картинок со всеми участниками', mixups: 'картинок с путаницей', anatomy: 'картинок с ошибкой анатомии', looks: 'внешность', floor: 'свой уровень отношений' };
const WHY_RU: Record<string, string> = { budget_omitted: 'расписание не начато', schedule_unfinished: 'расписание не закончено',
  judgments_missing: 'не хватает суждений судьи' };
const BASIS_RU = { operational: 'все случаи расписания', matched: 'пары случаев', drawn: 'пары нарисованных картинок' };
const READING_RU: Record<string, string> = { confirmed: 'только «да»', with_unsure: 'с «не уверен»', conservative: 'осторожно', upper: 'верхняя граница' };
const FAMILY_RU: Record<string, string> = { identity: 'кто есть кто', essential: 'существенные отношения', other_items: 'остальные пункты', mixups: 'путаница',
  anatomy: 'анатомия', looks: 'внешность', uncertainty: '«не уверен» или нет', safeguards: 'предохранители картинки' };
const SHARE_CLAUSES = ['visible_essential_relations', 'looks', 'floor'];
// The owner's page of the scores, in Russian: numbers and ids only, and the limits of what they say.
export function scoreMarkdown(score: ProbeScore): string {
  const arms = Object.entries(score.arms);
  const value = (clause: string, one: number | null | undefined) => (SHARE_CLAUSES.includes(clause) ? points(one) : one === null || one === undefined ? '—' : `${one}`);
  const lines = ['# Стенд промптов: оценки Astra', '',
    'Проба сравнивает замороженные рецепты промптов C0 и G на двенадцати выбранных сценах при одних настройках рисования: выводы только об этих сценах и этих промптах. '
      + 'Рука, которая проходит, улучшает видимые существенные отношения при перечисленных предохранителях; что её картинки вообще ближе к сцене, проба не показывает. '
      + 'A+ отличается от C0 сразу моделью, квантованием и инструкцией; PE, G→PE и PT: конвейеры энхансера, G→PE переписывает промпт G.', '',
    'Судья видел сцену, лист и список проверки, но не промпты; картинки под случайными именами и в случайном порядке. Доли в пунктах из 100.', '',
    '## Руки', '',
    '| Рука | Картинок | Видимые существенные отношения | Да / нет / не уверен | Все видны | Все участники | Путаница: да / только не уверен / не исключена | Анатомия: да / только не уверен / не исключена | Внешность: осторожно / верхняя граница | Лишние люди: да / не уверен |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...arms.map(([arm, one]) => `| ${armLabel(arm)} | ${one.pictures} | ${points(one.visible)} | ${shares(one.essential)} | ${one.allVisible} | ${one.complete} | `
      + `${one.mixups.confirmed} / ${one.mixups.unsureOnly} / ${one.mixups.notRuledOut} | ${one.anatomy.confirmed} / ${one.anatomy.unsureOnly} / ${one.anatomy.notRuledOut} | `
      + `${points(one.looks.conservative)} / ${points(one.looks.upper)} | ${one.extra.yes} / ${one.extra.unsure} |`),
    '', 'Видимые существенные отношения: ответы «да» среди всех существенных отношений сцены, «нет» и «не уверен» не засчитываются. «Не исключена»: осторожное чтение второго раунда, всё, кроме ответа «нет». '
      + 'Внешность считается по участникам списка, у которых есть строка листа; верхняя граница засчитывает присутствующим и «не уверен». '
      + 'Лишние люди: картинки, где судья видит человека или существо, которого нет среди участников сцены.', '',
    '## Существенные отношения по виду', '', 'Да / нет / не уверен, в пунктах из 100.', '',
    '| Рука | Человек с человеком | Со своим телом | С предметом | Остальные отношения |', '|---|---|---|---|---|',
    ...arms.map(([arm, one]) => `| ${armLabel(arm)} | ${shares(one.byWith.person)} | ${shares(one.byWith.self)} | ${shares(one.byWith.thing)} | ${shares(one.otherRelations)} |`),
    '', 'Видимое касание нужно продукту: касание, которого не видно, не засчитывается. Замороженная инструкция G разрешает закрыть касание телом другого участника '
      + 'и просит прятать мелкие точные касания предметов ракурсом, поэтому отношения с предметами показаны отдельно. Трудные отношения не убирались после того, как появились картинки.', '',
    '## Остальные пункты по виду', '', 'Да / нет / не уверен, в пунктах из 100; ни в одном условии.', '',
    '| Рука | Взгляды | Лица | Одежда | Отражения | Масштаб | Пропорции, да |', '|---|---|---|---|---|---|---|',
    ...arms.map(([arm, one]) => `| ${armLabel(arm)} | ${shares(one.kinds.gaze)} | ${shares(one.kinds.face)} | ${shares(one.kinds.clothes)} | ${shares(one.kinds.mirror)} | ${shares(one.kinds.scale)} | ${points(one.proportions)} |`),
    '', '## Каждый кадр плана', '', 'Кадр: сцена на сиде, 24 у каждой руки. Не дошли: срезано концом карты или сервером, или расписание не начато.', '',
    '| Рука | По плану | Нарисовано | Не вышло на карте | Энхансер не дал текста | Не дошли: срезано / не начато | Оценено | Нет суждения судьи |', '|---|---|---|---|---|---|---|---|',
    ...arms.map(([arm, one]) => `| ${armLabel(arm)} | ${one.frames.planned} | ${one.frames.drawn} | ${one.frames.renderFailed} | ${one.usable === undefined ? '—' : one.frames.enhancerFailed} | `
      + `${one.frames.notReached.cut} / ${one.frames.notReached.omitted} | ${one.frames.judged} | ${one.frames.missing} |`),
    '', ...arms.flatMap(([arm, one]) => (one.usable === undefined ? [] : [`- ${armLabel(arm)}: годный текст энхансера в ${one.usable} сценах из ${one.of}`])),
    '', '## Против C0 и G', '',
    'Главное сравнение: G против C0; PE, G→PE, PT и A+ против C0 и G→PE против G: разведка. Разница: среднее по сценам разностей сцен, где у сцены сперва усреднены её сиды. Прирост видимых существенных отношений '
      + 'не меньше 10 пунктов на 8 сценах или больше, и нижний край 90% интервала (10 000 выборок сцен целиком) выше нуля; прирост меньше 10 пунктов не проходит, а нижний край не выше нуля даёт «не решено». '
      + 'Кадр, который не вышел на карте, засчитан картинкой без видимых отношений с любой стороны сравнения, кроме диагностики. PE, G→PE и PT считаются по всем случаям своего расписания: '
      + 'где энхансер не дал годного текста, отношения тоже засчитаны нулём. Кадр без суждения судьи не засчитан ни как картинка, ни как ноль: он показан отдельно, и вердикт тогда «не решено». '
      + 'Путаница, анатомия и внешность проверены двумя способами, только по «да» '
      + 'и вместе с «не уверен»; если исход от этого меняется, условие не разрешено и вердикт «не решено», если только другое условие не провалено при любом чтении. '
      + 'Не начатое или не законченное расписание даёт «не решено», а не проигрыш.', '',
    ...score.comparisons.flatMap(one => [`**${armLabel(one.arm)} против ${armLabel(one.against)}**, ${ROLE_RU[one.role]}${one.verdict ? `: ${VERDICT_RU[one.verdict]}` : ''}`
      + `${one.why?.some(why => WHY_RU[why]) ? ` (${one.why.filter(why => WHY_RU[why]).map(why => WHY_RU[why]).join(', ')})` : ''}; `
      + `${BASIS_RU[one.basis]}: сцен ${one.scenes}, пар ${one.pictures}, из них пустых картинок ${one.shownNothing.x} у ${armLabel(one.arm)} и ${one.shownNothing.y} у ${armLabel(one.against)}; `
      + `без суждения судьи ${one.missing.x} и ${one.missing.y}. Видимые существенные отношения `
      + `${points(one.visible.x)} против ${points(one.visible.y)}, разница ${points(one.visible.difference)}, 90% интервал ${one.visible.interval ? one.visible.interval.map(points).join('…') : '—'}; `
      + `впереди в ${one.visible.ahead} сценах, вровень в ${one.visible.level}, позади в ${one.visible.behind}.`, '',
    ...one.clauses.map(clause => `- ${CLAUSE_RU[clause.clause]}: ${clause.treatments ? Object.entries(clause.treatments).map(([name, reading]) => `${READING_RU[name]} ${value(clause.clause, reading.value)}`).join(', ')
      : value(clause.clause, clause.value)} (порог ${value(clause.clause, clause.threshold)}${clause.lower === undefined ? '' : `, нижний край ${points(clause.lower)}`}): ${PASS_RU(clause.pass)}`), '']),
    '## Судья против себя', '', `Повторные сессии сцен ${REPEATED.join(', ')} на сиде ${ARM_SEEDS[0]}, под новыми именами и в новом порядке: доля тех же ответов.`, '',
    ...Object.entries(score.agreement).map(([family, one]) => `- ${FAMILY_RU[family] ?? family}: ${one.same} из ${one.of}`), ''];
  if (score.namedAgainstShown) {
    lines.push('## Названо в промпте и нарисовано', '', 'Существенные касания по картинкам руки: названо ли касание в промпте (по коду) и видит ли его Astra. '
      + 'Это описание того, что шло вместе, а не причина: названные и неназванные касания могут быть разной трудности.', '',
    '| Рука | Названо: нарисовано | Не названо: нарисовано |', '|---|---|---|',
    ...Object.entries(score.namedAgainstShown).map(([arm, one]) => `| ${armLabel(arm)} | ${one.namedShown} из ${one.named} | ${one.unnamedShown} из ${one.unnamed} |`), '');
  }
  return lines.join('\n');
}

// ---- The trial ----

// The review's two blinded samples, round two's pictures of arms A, A+ and C at two scenes, bundled again under the
// task and schema the review left and judged in two sessions of their own (judge/trial), as the probe's will be: the
// chain tried with the judge before the card, in two of the three sessions the review left of the lead's six.
export const SAMPLES = [{ scene: 'bandage', seed: 7 }, { scene: 'rescue', seed: 11 }];
const SAMPLE_ARMS = ['A', 'A+', 'C'];
const trialDirOf = (run: string) => join(judgeDirOf(run), 'trial');
const sampleName = (sample: { scene: string; seed: number }) => `pictures-${sample.scene}-s${sample.seed}`;
export async function runTrial(run: string, round2: string, options: { exec?: Exec; codex?: string; log?: (event: object) => void } = {}) {
  const dir = trialDirOf(run), bundles = join(dir, 'bundles');
  for (const sample of SAMPLES) {
    const name = sampleName(sample), from = storyDir(round2, sample.scene);
    if (existsSync(join(bundles, name))) continue;
    const key = readJson<{ pictures: { name: string; arms: string[]; sha256: string }[] }>(join(from, 'keys', `pictures-s${sample.seed}.json`));
    const drawn = (key?.pictures ?? []).filter(one => one.arms.some(arm => SAMPLE_ARMS.includes(arm)))
      .map(one => ({ arms: one.arms, sha256: one.sha256, bytes: checked(join(from, 'bundles', `pictures-s${sample.seed}`, one.name), one.sha256, `${sample.scene} ${one.name}`) }));
    if (drawn.length < 2) throw new Refusal(`round two has too few pictures of ${sample.scene} at seed ${sample.seed} for a sample`);
    const input = sceneInput(round2, sample.scene);
    writeBundle(join(bundles, name), join(dir, 'keys', `${name}.json`), name, sample.scene, sample.seed,
      { scene: input.scene, sheet: input.sheet, checklist: shown(input.checklist) }, drawn);
  }
  return runQueue({ dir, bundles, names: SAMPLES.map(sampleName), pins: pinsOf(), prompt: () => TASK, parallel: 2, exec: options.exec, codex: options.codex,
    log: options.log, badShare: 1 });
}
// What the trial's answers give: each picture's scores, by the arms round two gave it, and its answers against the
// review's session of the same picture under round two's task, where the review's record holds one.
export function trialScores(run: string, round2: string) {
  const dir = trialDirOf(run), review = join(judgeDirOf(run), 'review'), projections = projectionsOf(round2);
  const against: Record<string, { same: number; of: number }> = {};
  const add = (family: string, a: unknown, b: unknown) => { const one = against[family] ??= { same: 0, of: 0 }; one.of++; if (a === b) one.same++; };
  const pictures = SAMPLES.flatMap(sample => {
    const name = sampleName(sample), key = readJson<Key>(join(dir, 'keys', `${name}.json`));
    const answers = readJson<{ pictures: Record<string, Answer> }>(join(dir, 'answers', `${name}.json`));
    const earlierKey = readJson<Key>(join(review, 'keys', `${name}.json`));
    const earlier = readJson<{ pictures: Record<string, { participants: Record<string, string>; items: Record<string, string>; mixups: Record<string, string>; anatomy: string }> }>(
      join(review, 'answers', `${name}.json`));
    const essential = new Set(projections[sample.scene].items.filter(item => item.essential).map(item => item.id));
    return (key?.pictures ?? []).flatMap(picture => {
      const answer = answers?.pictures[picture.name];
      if (!answer) return [];
      const was = earlierKey?.pictures.find(one => one.sha256 === picture.sha256), old = was && earlier?.pictures[was.name];
      if (old) {
        for (const [id, value] of Object.entries(answer.participants)) add('participants', value.status, old.participants[id]);
        for (const [id, value] of Object.entries(answer.items)) add(essential.has(id) ? 'essential' : 'other_items', value, old.items[id]);
        for (const [id, value] of Object.entries(answer.mixups)) add('mixups', value, old.mixups[id]);
        add('anatomy', answer.anatomy, old.anatomy);
      }
      const score = scoreAnswer(projections[sample.scene], answer);
      return [{ session: name, arms: picture.arms, visible: score.visible, essential: score.essential, complete: score.complete, extra: score.extra,
        mixup: score.mixup, anatomy: score.anatomy, looks: score.looks, placed: Object.values(answer.participants).filter(one => one.status === 'present' && one.location?.trim()).length,
        present: Object.values(answer.participants).filter(one => one.status === 'present').length }];
    });
  });
  return { pictures, againstReview: against };
}

// ---- The dry run ----

// The judging without a card or a judge, in `dir`: made-up stands of grey pictures under the probe's keys, as a card
// leaves them: C0, GPE and A+ in every case; G's frame failed in one; PE's text unusable in three scenes and one of its
// frames failed; PT's text unusable in two scenes and one scene never reached, so that its schedule is unfinished. A
// picture whose bytes are not its cell's refused; the bundles, blinded, GPE's pictures in the same sessions, under
// random names in a random order, the repeats under fresh ones; the sessions judged by a stand-in for codex that
// refuses once (image-refs-judge.ts `fakeCodex`); the scores: every frame of every arm accounted for, the failed frames
// read as pictures that show nothing on either side, the operational, the matched and the drawn, GPE against C0 and
// against G, and the people beyond each scene's checklist counted per arm; a session left without a judgment, counted
// and leaving every verdict it touches undecided; an arm whose schedule was omitted; the trial's two sessions; and the
// scenes' words nowhere but the bundles and the sessions.
export async function dryJudge(dir: string, round2: string) {
  const dry = resolve(dir), run = join(dry, 'run'), temp = join(dry, 'tmp');
  for (const path of [dry, run, temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temp;
  const output = capture(), missed: string[] = [];
  const say = (line: string) => console.log(line);
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  try {
    say(`prompt arms judging dry run in ${dry}: made-up pictures, a stand-in for codex; no card, no judge, no network`);
    let number = 0;
    const unusable: Record<string, string[]> = { PE: ['beach', 'cheer', 'lineout'], PT: ['demon', 'gym'] }, unreached: Record<string, string[]> = { PT: ['rescue'] };
    const renderFailed = [armKey('PE', 'giants', 11), armKey('G', 'monkeys', 7)];
    for (const stand of STANDS) {
      const cells: StandIndex['cells'] = {};
      for (const arm of ARMS.filter(one => STAND_OF[one] === stand)) {
        for (const scene of SCENES.filter(one => !unusable[arm]?.includes(one) && !unreached[arm]?.includes(one))) {
          for (const seed of ARM_SEEDS) {
            const key = armKey(arm, scene, seed), file = `frames/${arm}-${scene}-s${seed}.png`, own = { key, id: `${arm}-${scene}`, arm, kind: 'frame' as const, seed, group: 'words' as const, refs: 0 };
            if (renderFailed.includes(key)) { cells[key] = { ...own, status: 'failed', code: 'image_failed' }; continue; }
            // As the harness keeps a picture: its metadata stripped (image-batch.ts `stripPngMetadata`).
            const bytes = stripPngMetadata(greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, ++number));
            mkdirSync(join(run, stand, 'frames'), { recursive: true, mode: 0o700 });
            writeFileSync(join(run, stand, file), bytes, { mode: 0o600 });
            cells[key] = { ...own, status: 'drawn', file, sha256: sha256(bytes) };
          }
        }
      }
      writeJson(join(run, stand, INDEX_FILE), { startedAt: new Date().toISOString(), pins: {}, server: {}, cells } satisfies StandIndex);
    }
    const rewrites = (arm: Rewritten) => ({ settings: {}, scenes: Object.fromEntries(SCENES.filter(scene => !unreached[arm]?.includes(scene)).map(scene => [scene,
      unusable[arm]?.includes(scene) ? { status: 'failed', code: 'pe_unparsed', ms: 1 } : { status: 'ok', ms: 1, form: 'json' }])) });
    for (const arm of REWRITTEN) writeJson(join(run, REWRITES_FILE[arm]), rewrites(arm));
    const begun: Schedule = { state: 'begun', needSeconds: 1, leftSeconds: 2, at: new Date().toISOString() };
    writeJson(join(run, SCHEDULES_FILE), { PE: begun, GPE: begun, 'A+': begun, PT: begun } satisfies Schedules);

    // A picture other than its cell recorded, and one that kept its metadata: each refused, and its bundle not written.
    const wrong = join(run, 'core', 'frames', 'G-guard-s11.png'), kept = readFileSync(wrong);
    const index = readJson<StandIndex>(join(run, 'core', INDEX_FILE))!, cell = index.cells[armKey('G', 'guard', 11)];
    for (const [what, bytes, pinned] of [['a picture other than its cell recorded', stripPngMetadata(greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, 9999)), cell.sha256],
      ['a picture that kept its metadata', greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, 9999), undefined]] as [string, Uint8Array, string | undefined][]) {
      writeFileSync(wrong, bytes, { mode: 0o600 });
      writeJson(join(run, 'core', INDEX_FILE), { ...index, cells: { ...index.cells, [cell.key]: { ...cell, sha256: pinned ?? sha256(bytes) } } });
      try { writeBundles(run, round2); expect(false, `${what} refused`); } catch (error) {
        const bundled = existsSync(join(judgeDirOf(run), 'bundles', 'pictures-guard-s11'));
        say(`1 ${what}: ${error instanceof Refusal ? 'refused' : 'failed'}, ${bundled ? 'bundled' : 'not bundled'}`);
        expect(error instanceof Refusal && !bundled, `${what} refused before its bundle`);
      }
      rmSync(judgeDirOf(run), { recursive: true, force: true });
    }
    writeFileSync(wrong, kept, { mode: 0o600 });
    writeJson(join(run, 'core', INDEX_FILE), index);

    const counts = writeBundles(run, round2), judge = judgeDirOf(run);
    const keyOf = (name: string) => readJson<Key>(join(judge, 'keys', `${name}.json`))!;
    const shownPictures = judgeSessions().reduce((sum, one) => sum + keyOf(one.name).pictures.length, 0);
    const drawnPictures = judgeSessions().reduce((sum, one) => sum + STANDS.reduce((total, stand) => total
      + Object.values(readJson<StandIndex>(join(run, stand, INDEX_FILE))!.cells).filter(each => each.status === 'drawn' && each.id.endsWith(`-${one.scene}`) && each.seed === one.seed).length, 0), 0);
    const blind = judgeSessions().every(one => {
      const files = readdirSync(join(judge, 'bundles', one.name)).sort(), key = keyOf(one.name);
      const input = JSON.parse(readFileSync(join(judge, 'bundles', one.name, 'input.json'), 'utf8')) as PicturesInput;
      return files.every(name => ['TASK.md', 'input.json', 'schema.json'].includes(name) || /^pic-[0-9a-f]{8}\.png$/.test(name))
        && !ARMS.some(arm => JSON.stringify(input).includes(`${arm}-`)) && readFileSync(join(judge, 'bundles', one.name, 'TASK.md'), 'utf8') === `${TASK}\n`
        && same(input.pictures, key.pictures.map(picture => picture.name)) && key.pictures.every(picture => picture.name !== `pic-${picture.sha256.slice(0, 8)}.png`)
        && same(JSON.parse(readFileSync(join(judge, 'bundles', one.name, 'schema.json'), 'utf8')), probeSchema(input));
    });
    const armsOrder = judgeSessions().filter(one => one.kind === 'pictures').filter(one => same(keyOf(one.name).pictures.map(picture => picture.arms[0]),
      ARMS.filter(arm => keyOf(one.name).pictures.some(picture => picture.arms.includes(arm))))).length;
    const repeats = REPEATED.every(scene => {
      const first = keyOf(`pictures-${scene}-s${ARM_SEEDS[0]}`), again = keyOf(`repeat-${scene}-s${ARM_SEEDS[0]}`);
      return same(first.pictures.map(one => one.sha256).sort(), again.pictures.map(one => one.sha256).sort())
        && !again.pictures.some(one => first.pictures.some(other => other.name === one.name))
        && again.pictures.every(one => sha256(readFileSync(join(judge, 'bundles', again.name, one.name))) === one.sha256);
    });
    const withGpe = judgeSessions().filter(one => one.kind === 'pictures' && keyOf(one.name).pictures.some(picture => picture.arms.includes('GPE'))).length;
    say(`2 bundles: ${counts.built} built, ${shownPictures} pictures shown of ${drawnPictures} drawn, GPE's in ${withGpe} of 24 sessions; each folder the task, the inputs, the schema `
      + `and pictures under opaque names in the key's order: ${blind}; ${armsOrder} of 24 sessions in the arms' own order; each repeat its first session's pictures under fresh names: ${repeats}`);
    expect(counts.built === 28 && shownPictures === drawnPictures && withGpe === 24 && blind && armsOrder < 24 && repeats,
      '28 bundles, every picture drawn, GPE\'s beside the others, blinded, in a random order, the repeats renamed');

    const exec = fakeCodex(3), log: object[] = [];
    const record = await judgeProbe(run, { exec, log: event => log.push(event) });
    const judged = judgingCounts(record, judgeSessions().map(one => one.name));
    say(`3 judging: ${JSON.stringify(judged.states)}, ${judged.attempts} attempts, ${judged.refusals} refusal; both attempts of the refused session kept `
      + `${existsSync(join(judge, 'sessions', `${judgeSessions()[1].name}.1.report.md`)) && existsSync(join(judge, 'sessions', `${judgeSessions()[1].name}.2.report.md`))}`);
    expect(judged.states.answered === 28 && judged.attempts === 29 && judged.refusals === 1, 'every session answered, the refused one on its second attempt');
    const again = await judgeProbe(run, { exec });
    expect(judgingCounts(again, judgeSessions().map(one => one.name)).attempts === 29, 'a resume judges nothing more');

    const score = scoreProbe(run, round2);
    writeFileSync(join(judge, 'score.md'), scoreMarkdown(score), { mode: 0o600 });
    writeJson(join(judge, 'score.json'), score);
    const find = (from: ProbeScore, arm: Arm, role: Role, against: Arm = 'C0') => from.comparisons.find(one => one.arm === arm && one.role === role && one.against === against)!;
    say(`4 scores: ${Object.entries(score.arms).map(([arm, one]) => `${arm} ${one.pictures} ${JSON.stringify(one.outcomes)}`).join('; ')}; `
      + `${score.comparisons.map(one => `${one.arm} against ${one.against} ${one.role} ${one.basis} ${one.verdict ?? 'no verdict'} over ${one.pictures} pairs, `
        + `${one.shownNothing.x} and ${one.shownNothing.y} showing nothing${one.why ? ` (${one.why.join(', ')})` : ''}`).join('; ')}; `
      + `agreement ${JSON.stringify(Object.fromEntries(Object.entries(score.agreement).map(([family, one]) => [family, one.of])))}`);
    expect(score.arms.C0.pictures === 24 && score.arms.G.pictures === 23 && score.arms.GPE.pictures === 24 && score.arms['A+'].pictures === 24 && score.arms.PE.pictures === 17
      && score.arms.PT.pictures === 18 && same(score.arms.G.outcomes, { judged: 23, render_failed: 1 }) && same(score.arms.GPE.outcomes, { judged: 24 })
      && same(score.arms.PE.outcomes, { judged: 17, enhancer_failed: 6, render_failed: 1 }) && same(score.arms.PT.outcomes, { judged: 18, enhancer_failed: 4, not_reached: 2 })
      && score.arms.PE.usable === 9 && score.arms.GPE.usable === 12 && score.arms.PT.usable === 9 && !!find(score, 'G', 'primary').verdict
      && find(score, 'G', 'primary').pictures === 24 && same(find(score, 'G', 'primary').shownNothing, { x: 1, y: 0 })
      && find(score, 'PE', 'exploratory').pictures === 24 && find(score, 'PE', 'exploratory').shownNothing.x === 7
      && find(score, 'PE', 'diagnostic').pictures === 17 && find(score, 'PE', 'diagnostic').verdict === undefined
      && find(score, 'GPE', 'exploratory').pictures === 24 && !!find(score, 'GPE', 'exploratory').verdict && find(score, 'GPE', 'diagnostic').pictures === 24
      && find(score, 'GPE', 'exploratory', 'G').pictures === 24 && same(find(score, 'GPE', 'exploratory', 'G').shownNothing, { x: 0, y: 1 })
      && find(score, 'GPE', 'diagnostic', 'G').pictures === 23 && find(score, 'GPE', 'exploratory', 'G').role === 'exploratory'
      && find(score, 'PT', 'exploratory').verdict === 'undecided' && find(score, 'PT', 'exploratory').why?.[0] === 'schedule_unfinished'
      && ['identity', 'essential', 'uncertainty', 'safeguards'].every(family => (score.agreement[family]?.of ?? 0) > 0),
    'every arm\'s cases as the card left them, a failed frame read as showing nothing on either side, PE held to its whole schedule and matched apart, GPE against C0 and G, '
      + 'PT undecided while unfinished, the agreement by family');
    // Every frame the plan has, accounted for per arm; and the people beyond the checklist per arm, against a count
    // straight from the answers and the keys.
    const frames = Object.entries(score.arms).every(([, one]) => one.frames.planned === 24 && one.frames.drawn === one.frames.judged + one.frames.missing
      && one.frames.planned === one.frames.drawn + one.frames.renderFailed + one.frames.enhancerFailed + one.frames.notReached.cut + one.frames.notReached.omitted);
    const extra = Object.fromEntries(ARMS.map(arm => [arm, { yes: 0, unsure: 0 }]));
    for (const one of judgeSessions().filter(session => session.kind === 'pictures')) {
      const answers = readJson<{ pictures: Record<string, Answer> }>(join(judge, 'answers', `${one.name}.json`));
      for (const picture of keyOf(one.name).pictures) {
        const said = answers?.pictures[picture.name]?.extra_participants;
        for (const arm of picture.arms) if (said === 'yes' || said === 'unsure') extra[arm][said]++;
      }
    }
    const page = readFileSync(join(judge, 'score.md'), 'utf8');
    say(`   every frame accounted for: ${frames}; ${Object.entries(score.arms).map(([arm, one]) => `${arm} ${JSON.stringify(one.frames)}`).join('; ')}; `
      + `people beyond the checklist, yes and unsure: ${Object.entries(score.arms).map(([arm, one]) => `${arm} ${one.extra.yes}/${one.extra.unsure}`).join(', ')}, as the answers say `
      + `${same(Object.fromEntries(Object.entries(score.arms).map(([arm, one]) => [arm, one.extra])), extra)}; G→PE on the page ${page.includes('| G→PE |')}`);
    expect(frames && same(Object.fromEntries(Object.entries(score.arms).map(([arm, one]) => [arm, one.extra])), extra) && page.includes('| G→PE |')
      && page.includes('## Каждый кадр плана'), 'every frame of every arm accounted for, and the people beyond each scene counted per arm, GPE\'s under its name');

    // A session left without a judgment: its pictures counted as missing, read neither as pictures nor as nothing, and
    // every verdict they touch undecided.
    const missingName = `pictures-bandage-s${ARM_SEEDS[1]}`, recordPath = recordFile(judge), answersPath = join(judge, 'answers', `${missingName}.json`);
    const [recordBytes, answerBytes] = [readFileSync(recordPath), readFileSync(answersPath)];
    const unjudged = readJson<JudgingRecord>(recordPath)!;
    unjudged.sessions[missingName] = { ...unjudged.sessions[missingName], state: 'failed' };
    writeJson(recordPath, unjudged);
    rmSync(answersPath);
    const holes = scoreProbe(run, round2), verdicted = holes.comparisons.filter(one => one.verdict);
    writeFileSync(recordPath, recordBytes, { mode: 0o600 });
    writeFileSync(answersPath, answerBytes, { mode: 0o600 });
    say(`5 a session without a judgment: ${Object.entries(holes.arms).map(([arm, one]) => `${arm} ${one.frames.missing}`).join(', ')} missing; G against C0 over `
      + `${find(holes, 'G', 'primary').pictures} pairs, missing ${JSON.stringify(find(holes, 'G', 'primary').missing)}, ${find(holes, 'G', 'primary').verdict} `
      + `(${find(holes, 'G', 'primary').why?.join(', ')}); ${verdicted.filter(one => one.verdict === 'undecided' && one.why?.includes('judgments_missing')).length} of ${verdicted.length} verdicts undecided for it`);
    expect(Object.values(holes.arms).every(one => one.frames.missing === 1 && one.frames.drawn === one.frames.judged + 1) && find(holes, 'G', 'primary').pictures === 23
      && same(find(holes, 'G', 'primary').missing, { x: 1, y: 1 }) && verdicted.length === 6
      && verdicted.every(one => one.verdict === 'undecided' && one.why?.includes('judgments_missing')), 'a missing judgment counted, never a picture, never a pass');

    writeJson(join(run, SCHEDULES_FILE), { PE: begun, GPE: begun, 'A+': { ...begun, state: 'omitted' }, PT: begun } satisfies Schedules);
    const omitted = scoreProbe(run, round2), plus = omitted.comparisons.find(one => one.arm === 'A+')!;
    say(`6 A+'s schedule omitted: ${JSON.stringify(omitted.arms['A+'].outcomes)}, ${plus.verdict} (${plus.why?.join(', ')})`);
    expect(same(omitted.arms['A+'].outcomes, { budget_omitted: 24 }) && plus.verdict === 'undecided' && plus.why?.[0] === 'budget_omitted', 'an arm never begun is undecided, not failed');

    const trial = await runTrial(run, round2, { exec: fakeCodex(5) });
    const tried = judgingCounts(trial, SAMPLES.map(sampleName)), trialScored = trialScores(run, round2);
    const trialBlind = SAMPLES.every(sample => readFileSync(join(trialDirOf(run), 'bundles', sampleName(sample), 'TASK.md'), 'utf8') === `${TASK}\n`);
    say(`7 trial: ${JSON.stringify(tried.states)} in ${tried.attempts} attempts, ${trialScored.pictures.length} pictures scored, the task the probe's: ${trialBlind}`);
    expect(tried.states.answered === 2 && trialScored.pictures.length >= 4 && trialBlind, 'the trial\'s two sessions answered under the probe\'s task and scored');

    // The scenes' words stay in the bundles and the session copies; nothing is printed.
    const text = output.text();
    const scenes = SCENES.map(scene => sceneInput(round2, scene).scene.split(/\s+/).slice(0, 6).join(' '));
    const beyond = searchTree(dry, scenes.map(one => Buffer.from(one, 'utf8')), path => /\/(bundles|sessions)(\/|$)/.test(path));
    const printed = scenes.some(one => text.includes(one));
    say(`8 privacy: a scene's opening words in ${beyond.hits.length} of ${beyond.files} files beside the bundles and the sessions; printed ${printed}`);
    expect(!beyond.hits.length && !beyond.unread.length && !printed, 'no scene beyond the bundles and the sessions, nothing printed');
    say(missed.length ? `the judging dry run did NOT go as expected: ${missed.length} of its checks` : 'the judging dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- The command line ----

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    run: { type: 'string' }, round2: { type: 'string', default: join(ROOT, 'illustrations', 'action') }, dir: { type: 'string' },
    parallel: { type: 'string', default: '3' }, sessions: { type: 'string' },
  } });
  const command = positionals[0] ?? '', round2 = resolve(values.round2!);
  if (command === 'dry-run') {
    const result = await dryJudge(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-prompt-arms-judge-dry-')), round2);
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (!values.run) throw new Refusal('Use: image-prompt-arms-judge.ts trial|bundles|judge|score|dry-run --run <the probe\'s run directory> [--round2 <round two\'s>]');
  const run = resolve(values.run);
  if (command === 'trial') {
    const record = await runTrial(run, round2, { log: print });
    print({ event: 'trial', ...judgingCounts(record, SAMPLES.map(sampleName)) });
    const scored = trialScores(run, round2);
    for (const one of scored.pictures) print({ event: 'trial_picture', ...one });
    print({ event: 'trial_against_review', ...scored.againstReview });
  } else if (command === 'bundles') {
    print({ event: 'bundles', ...writeBundles(run, round2, print) });
  } else if (command === 'judge') {
    const parallel = Number(values.parallel);
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 3) throw new Refusal('--parallel takes 1 to 3');
    const names = values.sessions ? values.sessions.split(',').map(one => one.trim()) : undefined;
    const record = await judgeProbe(run, { parallel, names, log: print });
    print({ event: 'judging_done', ...judgingCounts(record, judgeSessions().map(one => one.name)) });
  } else if (command === 'score') {
    const score = scoreProbe(run, round2);
    writeJson(join(judgeDirOf(run), 'score.json'), score);
    writeFileSync(join(judgeDirOf(run), 'score.md'), scoreMarkdown(score), { mode: 0o600 });
    for (const one of score.comparisons) print({ event: 'comparison', arm: one.arm, role: one.role, basis: one.basis, verdict: one.verdict ?? null, scenes: one.scenes, gain: one.visible.difference });
  } else throw new Refusal('Use: image-prompt-arms-judge.ts trial|bundles|judge|score|dry-run (docs/action-experiment.md#prompt-arms-judging)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
