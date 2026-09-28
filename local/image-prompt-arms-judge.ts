// The judging of the prompt arms probe (docs/action-experiment.md#prompt-arms-judging), as round two judged its
// pictures (local/action-judge.ts): for each scene and seed one fresh `codex exec` session of GPT-6 Astra at high
// effort in a read-only sandbox, shown the scene, the sheet with the proportions its looks name, round two's checklist
// of the scene without which relations are essential, and that seed's pictures of every arm, named by their hashes and
// in the order of the names. The task and the schema are round two's `pictures`, word for word; no session sees a
// prompt, and which arm drew which picture stays in judge/keys/. Four scenes are judged again at seed 7, round two's
// `repeatedScenes`, for the judge's agreement with itself. A session without valid answers gets one fresh Astra
// session. The scores are round two's (local/action-report.ts `scorePicture`), and G, PE, PT and A+ are each set
// against C0 by the clauses fixed here before any picture exists (`CLAUSES`).
//   review     before the card: one Astra review of the judging, with blinded samples built by this file's own code
//              from round two's pictures, and those samples judged as the probe's sessions will be (three sessions)
//   bundles    after the card: every session's bundle from the stands' pictures, each checked against its cell's hash
//   judge      the sessions, three at a time
//   score      the scores, the clauses, the agreement, and the contacts the prompts name against those the pictures show
//   dry-run    the whole judging on made-up pictures, with a stand-in for codex
// What it prints is names, codes, counts and times: never a word of a scene, a prompt or an answer.
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { JUDGE, TASKS, judgePins, picturesSchema, projectionOf, runAttempt, sceneOf, sheetLines, shown, strict } from './action-judge.ts';
import type { AttemptRecord, Checklist, Exec, PicturesInput, Projection, Read } from './action-judge.ts';
import { interval, scorePicture } from './action-report.ts';
import type { Score } from './action-report.ts';
import { fakeCodex } from './image-refs-judge.ts';
import { greyPng } from './fake-comfy.ts';
import { INDEX_FILE } from './image-refs-test.ts';
import type { StandIndex } from './image-refs-test.ts';
import { ARM_SEEDS, CHECKS_FILE, CORE, FROZEN_SHA256, SCENES, armKey, gInstruction } from './image-prompt-arms.ts';
import type { Arm, PromptCheck } from './image-prompt-arms.ts';

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

export const ARMS: Arm[] = [...CORE, 'PT'];
const standOf = (arm: Arm) => (arm === 'PT' ? 'think' : 'core');
export const REPEATED = repeatedScenes().filter(scene => SCENES.includes(scene));
export type JudgeSession = { name: string; kind: 'pictures' | 'repeat'; scene: string; seed: number };
export const judgeSessions = (): JudgeSession[] => [
  ...ARM_SEEDS.flatMap(seed => SCENES.map(scene => ({ name: `pictures-${scene}-s${seed}`, kind: 'pictures' as const, scene, seed }))),
  ...REPEATED.map(scene => ({ name: `repeat-${scene}-s${ARM_SEEDS[0]}`, kind: 'repeat' as const, scene, seed: ARM_SEEDS[0] }))];
export const judgeDirOf = (run: string) => join(resolve(run), 'judge');
// What the judging is pinned to: round two's judge, effort, tasks and schemas (action-judge.ts `judgePins`), the probe's
// frozen texts and its sessions.
export const pinsOf = () => ({ ...judgePins(), probe: FROZEN_SHA256, sessions: sha256(JSON.stringify(judgeSessions())) });

// ---- The bundles ----

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
// One bundle, written once: the task, the inputs, the schema and the pictures, and its key outside it.
function writeBundle(dir: string, keyFile: string, name: string, scene: string, seed: number, base: Omit<PicturesInput, 'pictures'>,
  drawn: { arms: string[]; sha256: string; bytes: Buffer }[]) {
  const pictures = drawn.map(one => ({ ...one, name: `pic-${one.sha256.slice(0, 8)}.png` })).sort((a, b) => a.name.localeCompare(b.name));
  const input: PicturesInput = { ...base, pictures: pictures.map(one => one.name) }, schema = picturesSchema(input);
  const inputText = JSON.stringify(input, null, 2), schemaText = JSON.stringify(schema, null, 2);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'TASK.md'), `${TASKS.pictures}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'input.json'), inputText, { mode: 0o600 });
  writeFileSync(join(dir, 'schema.json'), schemaText, { mode: 0o600 });
  for (const one of pictures) writeFileSync(join(dir, one.name), one.bytes, { mode: 0o600 });
  const key: Key = { name, scene, seed, task: sha256(TASKS.pictures), schema: sha256(schemaText), input: sha256(inputText),
    pictures: pictures.map(one => ({ name: one.name, arms: one.arms, sha256: one.sha256 })) };
  writeJson(keyFile, key);
  return key;
}
// Every session's bundle from the stands' pictures, each checked against the hash and size its cell recorded: an arm
// whose picture is another's byte for byte is shown once. A repeat is its pictures session's bundle, copied. A bundle
// there is kept; the bundles are built once the card is over.
export function writeBundles(run: string, round2: string, log: (event: object) => void = () => undefined) {
  const judge = judgeDirOf(run), indexes = new Map<string, StandIndex | undefined>();
  const indexOf = (stand: string) => {
    if (!indexes.has(stand)) indexes.set(stand, readJson<StandIndex>(join(resolve(run), stand, INDEX_FILE)));
    return indexes.get(stand);
  };
  if (!indexOf('core')) throw new Refusal(`${join(resolve(run), 'core', INDEX_FILE)} is missing: the bundles are built from the drawn pictures`);
  const counts = { built: 0, kept: 0, skipped: {} as Record<string, number> }, inputs = new Map<string, ReturnType<typeof sceneInput>>();
  for (const session of judgeSessions()) {
    const dir = join(judge, 'bundles', session.name), keyFile = join(judge, 'keys', `${session.name}.json`);
    if (existsSync(dir)) { counts.kept++; continue; }
    if (session.kind === 'repeat') {
      const first = `pictures-${session.scene}-s${session.seed}`;
      if (!existsSync(join(judge, 'bundles', first))) { counts.skipped.no_first = (counts.skipped.no_first ?? 0) + 1; continue; }
      cpSync(join(judge, 'bundles', first), dir, { recursive: true });
      writeJson(keyFile, { ...readJson<Key>(join(judge, 'keys', `${first}.json`))!, name: session.name });
      counts.built++;
      log({ event: 'bundle_written', session: session.name, from: first });
      continue;
    }
    const drawn: { arms: string[]; sha256: string; bytes: Buffer }[] = [];
    for (const arm of ARMS) {
      const cell = indexOf(standOf(arm))?.cells[armKey(arm, session.scene, session.seed)];
      if (cell?.status !== 'drawn' || !cell.file || !cell.sha256) continue;
      const bytes = checked(join(resolve(run), standOf(arm), cell.file), cell.sha256, cell.key);
      const same = drawn.find(one => one.sha256 === cell.sha256);
      if (same) same.arms.push(arm); else drawn.push({ arms: [arm], sha256: cell.sha256, bytes });
    }
    if (!drawn.length) { counts.skipped.no_picture = (counts.skipped.no_picture ?? 0) + 1; continue; }
    if (!inputs.has(session.scene)) inputs.set(session.scene, sceneInput(round2, session.scene));
    const input = inputs.get(session.scene)!;
    writeBundle(dir, keyFile, session.name, session.scene, session.seed, { scene: input.scene, sheet: input.sheet, checklist: shown(input.checklist) }, drawn);
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
// A session's attempts, both Astra's: a fresh session after one without valid answers.
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
    prompt: () => TASKS.pictures });
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

type PictureAnswer = Parameters<typeof scorePicture>[1];
export type Scored = { scene: string; seed: number; arm: Arm; score: Score };
// Every picture the pictures sessions answered, each arm's score from its picture's answers.
function scoredPictures(dir: string, projections: Record<string, Projection>, kind: 'pictures' | 'repeat' = 'pictures') {
  const record = readJson<JudgingRecord>(recordFile(dir)), out: Scored[] = [];
  for (const session of judgeSessions().filter(one => one.kind === kind)) {
    if (record?.sessions[session.name]?.state !== 'answered') continue;
    const key = readJson<Key>(join(dir, 'keys', `${session.name}.json`)), answers = readJson<{ pictures: Record<string, PictureAnswer> }>(join(dir, 'answers', `${session.name}.json`));
    if (!key || !answers) continue;
    for (const picture of key.pictures) {
      const score = scorePicture(projections[session.scene], answers.pictures[picture.name]);
      for (const arm of picture.arms) out.push({ scene: session.scene, seed: session.seed, arm: arm as Arm, score });
    }
  }
  return out;
}
// The clauses each of G, PE, PT and A+ is set against C0 by, fixed on 2026-09-28 before any picture was drawn, on the
// pictures of the scenes and seeds where both have one: `contacts`, the mean over those scenes of each scene's mean over
// its seeds, gains 0.10 or more, over 8 scenes at least, else the arm is undecided; as many pictures with all the
// essential contacts and with every participant as C0 or more; no more mixups; at most max(1, n/10) more anatomy errors
// among the n pictures; `looks` not below C0's by more than 0.05; and the arm's own contacts at 0.50 or more.
export const CLAUSES = { contactsGain: 0.10, scenes: 8, looks: -0.05, floor: 0.5 };
export type Clause = { clause: string; value: number | null; threshold: number; scenes: number; pass: boolean | 'undecided' };
export type Comparison = { arm: Arm; scenes: number; pictures: number; verdict: 'pass' | 'fail' | 'undecided'; clauses: Clause[];
  contacts: { x: number | null; y: number | null; difference: number | null; interval: [number, number] | null; ahead: number; level: number; behind: number;
    byScene: Record<string, number> } };
export function compare(pictures: Scored[], arm: Arm, base: Arm = 'C0'): Comparison {
  const at = (scene: string, seed: number, which: Arm) => pictures.find(one => one.scene === scene && one.seed === seed && one.arm === which)?.score;
  const pairs = SCENES.flatMap(scene => ARM_SEEDS.flatMap(seed => {
    const x = at(scene, seed, arm), y = at(scene, seed, base);
    return x && y ? [{ scene, seed, x, y }] : [];
  }));
  const scenes = [...new Set(pairs.map(one => one.scene))];
  const byScene = (read: (score: Score) => number | undefined) => scenes.flatMap(scene => {
    const own = pairs.filter(one => one.scene === scene && read(one.x) !== undefined && read(one.y) !== undefined);
    return own.length ? [{ scene, x: mean(own.map(one => read(one.x)!)), y: mean(own.map(one => read(one.y)!)) }] : [];
  });
  const contacts = byScene(score => score.contacts), looks = byScene(score => score.looks);
  const diff = (list: { x: number; y: number }[]) => (list.length ? mean(list.map(one => one.x)) - mean(list.map(one => one.y)) : null);
  const count = (pick: (score: Score) => boolean | undefined, which: 'x' | 'y') => pairs.filter(one => pick(one[which]) === true).length;
  const counted = (clause: string, pick: (score: Score) => boolean | undefined, sense: 'fewer' | 'more', slack: number): Clause => {
    const value = count(pick, 'x') - count(pick, 'y');
    return { clause, value, threshold: sense === 'fewer' ? slack : -slack, scenes: scenes.length, pass: sense === 'fewer' ? value <= slack : value >= -slack };
  };
  const gain = diff(contacts), own = contacts.length ? mean(contacts.map(one => one.x)) : null, looksDiff = diff(looks);
  const clauses: Clause[] = [
    { clause: 'contacts', value: gain, threshold: CLAUSES.contactsGain, scenes: contacts.length,
      pass: contacts.length < CLAUSES.scenes || gain === null ? 'undecided' : gain >= CLAUSES.contactsGain - EPS },
    counted('all_contacts', score => score.allContacts, 'more', 0), counted('complete', score => score.complete, 'more', 0),
    counted('mixups', score => score.mixup, 'fewer', 0), counted('anatomy', score => score.anatomy, 'fewer', Math.max(1, Math.floor(pairs.length / 10))),
    { clause: 'looks', value: looksDiff, threshold: CLAUSES.looks, scenes: looks.length, pass: looksDiff === null ? true : looksDiff >= CLAUSES.looks - EPS },
    { clause: 'floor', value: own, threshold: CLAUSES.floor, scenes: contacts.length, pass: own === null ? 'undecided' : own >= CLAUSES.floor - EPS }];
  const verdict = clauses.some(one => one.pass === 'undecided') ? 'undecided' : clauses.every(one => one.pass === true) ? 'pass' : 'fail';
  const diffs = contacts.map(one => one.x - one.y);
  return { arm, scenes: scenes.length, pictures: pairs.length, verdict, clauses,
    contacts: { x: own, y: contacts.length ? mean(contacts.map(one => one.y)) : null, difference: gain, interval: interval(contacts.map(one => [one.x, one.y])),
      ahead: diffs.filter(one => one > EPS).length, level: diffs.filter(one => Math.abs(one) <= EPS).length, behind: diffs.filter(one => one < -EPS).length,
      byScene: Object.fromEntries(contacts.map((one, index) => [one.scene, diffs[index]])) } };
}
// Each arm over its pictures: the means of the shares, and the pictures with all the contacts, with everyone, with a
// mixup and with an anatomy error.
function armsOf(pictures: Scored[]) {
  return Object.fromEntries(ARMS.map(arm => {
    const own = pictures.filter(one => one.arm === arm).map(one => one.score);
    const share = (read: (score: Score) => number | undefined) => { const values = own.flatMap(score => read(score) ?? []); return values.length ? mean(values) : null; };
    return [arm, { pictures: own.length, contacts: share(score => score.contacts), allContacts: own.filter(score => score.allContacts).length,
      complete: own.filter(score => score.complete).length, mixups: own.filter(score => score.mixup).length, anatomy: own.filter(score => score.anatomy).length,
      looks: share(score => score.looks), clothes: share(score => score.clothes), gazesFaces: share(score => score.gazesFaces), proportions: share(score => score.proportions) }];
  }));
}
// The judge against itself: the repeats' answers against the first session's of the same bundle, family by family.
function agreementOf(dir: string, projections: Record<string, Projection>) {
  const families: Record<string, { same: number; of: number }> = {};
  const add = (family: string, a: unknown, b: unknown) => { const one = families[family] ??= { same: 0, of: 0 }; one.of++; if (a === b) one.same++; };
  for (const scene of REPEATED) {
    const first = readJson<{ pictures: Record<string, PictureAnswer> }>(join(dir, 'answers', `pictures-${scene}-s${ARM_SEEDS[0]}.json`));
    const again = readJson<{ pictures: Record<string, PictureAnswer> }>(join(dir, 'answers', `repeat-${scene}-s${ARM_SEEDS[0]}.json`));
    if (!first || !again) continue;
    const essential = new Set(projections[scene].items.filter(item => item.essential).map(item => item.id));
    for (const [name, a] of Object.entries(first.pictures)) {
      const b = again.pictures[name];
      if (!b) continue;
      for (const [id, value] of Object.entries(a.items)) add(essential.has(id) ? 'essential' : 'other_items', value, b.items[id]);
      for (const [id, value] of Object.entries(a.participants)) add('participants', value, b.participants[id]);
      for (const [id, value] of Object.entries(a.mixups)) add('mixups', value, b.mixups[id]);
      add('anatomy', a.anatomy, b.anatomy);
      for (const [id, value] of Object.entries(a.looks)) add('looks', value, b.looks[id]);
    }
  }
  return families;
}
// Whether a contact the prompt names in words is drawn more often: each arm's essential contacts over its pictures,
// by whether code found them named in its prompt (local/image-prompt-arms.ts `checks`) and whether Astra saw them.
function namedAgainstShown(run: string, pictures: Scored[], projections: Record<string, Projection>) {
  const checks = readJson<{ arms: Record<string, Record<string, PromptCheck>> }>(join(resolve(run), CHECKS_FILE));
  if (!checks) return undefined;
  return Object.fromEntries(ARMS.flatMap(arm => {
    const tally = { namedShown: 0, named: 0, unnamedShown: 0, unnamed: 0 };
    for (const one of pictures.filter(picture => picture.arm === arm)) {
      const check = checks.arms[arm]?.[one.scene];
      if (!check) continue;
      for (const item of projections[one.scene].items.filter(candidate => candidate.essential)) {
        const named = !check.contacts.missing.includes(item.id), drawn = one.score.shown.includes(item.id);
        if (named) { tally.named++; if (drawn) tally.namedShown++; } else { tally.unnamed++; if (drawn) tally.unnamedShown++; }
      }
    }
    return tally.named + tally.unnamed ? [[arm, tally]] : [];
  }));
}
export function scoreProbe(run: string, round2: string) {
  const dir = judgeDirOf(run);
  const projections = Object.fromEntries(SCENES.map(scene => {
    const checklist = readJson<Checklist>(join(storyDir(round2, scene), 'checklist.json'));
    if (!checklist) throw new Refusal(`${storyDir(round2, scene)} has no checklist: pass --round2 <round two's run directory>`);
    return [scene, projectionOf(checklist)];
  }));
  const pictures = scoredPictures(dir, projections), record = readJson<JudgingRecord>(recordFile(dir));
  return { pins: record?.pins, judging: record ? judgingCounts(record, judgeSessions().map(one => one.name)) : undefined, arms: armsOf(pictures),
    comparisons: (['G', 'PE', 'PT', 'A+'] as Arm[]).map(arm => compare(pictures, arm)), agreement: agreementOf(dir, projections),
    namedAgainstShown: namedAgainstShown(run, pictures, projections) };
}
export type ProbeScore = ReturnType<typeof scoreProbe>;
const points = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}`);
const VERDICT_RU = { pass: 'проходит', fail: 'не проходит', undecided: 'не решено' };
// The owner's page of the scores, in Russian: numbers and ids only.
export function scoreMarkdown(score: ProbeScore): string {
  const arms = Object.entries(score.arms).filter(([, one]) => one.pictures);
  const lines = ['# Стенд промптов: оценки Astra', '',
    'Судья видел сцену, лист и список проверки, но не промпты. Касания, внешность, одежда, взгляды: доля ответов «да», в пунктах из 100.', '',
    '| Рука | Картинок | Касания | Все касания | Все участники | Путаница | Анатомия | Внешность | Одежда |', '|---|---|---|---|---|---|---|---|---|',
    ...arms.map(([arm, one]) => `| ${arm} | ${one.pictures} | ${points(one.contacts)} | ${one.allContacts} | ${one.complete} | ${one.mixups} | ${one.anatomy} | ${points(one.looks)} | ${points(one.clothes)} |`),
    '', '## Против C0', '',
    ...score.comparisons.flatMap(one => [`**${one.arm}**: ${VERDICT_RU[one.verdict]}; сцен ${one.scenes}, пар картинок ${one.pictures}. Касания ${points(one.contacts.x)} против ${points(one.contacts.y)}, `
      + `разница ${points(one.contacts.difference)}, 90% интервал ${one.contacts.interval ? one.contacts.interval.map(points).join('…') : '—'}; впереди в ${one.contacts.ahead} сценах, `
      + `вровень в ${one.contacts.level}, позади в ${one.contacts.behind}.`, '',
    ...one.clauses.map(clause => `- ${clause.clause}: ${clause.value === null ? '—' : ['contacts', 'looks', 'floor'].includes(clause.clause) ? points(clause.value) : clause.value} `
      + `(порог ${['contacts', 'looks', 'floor'].includes(clause.clause) ? points(clause.threshold) : clause.threshold}): ${clause.pass === 'undecided' ? 'не решено' : clause.pass ? 'да' : 'нет'}`), '']),
    '## Судья против себя', '', `Повторные сессии сцен ${REPEATED.join(', ')} на сиде ${ARM_SEEDS[0]}: доля тех же ответов.`, '',
    ...Object.entries(score.agreement).map(([family, one]) => `- ${family}: ${one.same} из ${one.of}`), ''];
  if (score.namedAgainstShown) {
    lines.push('## Названо в промпте и нарисовано', '', 'Существенные касания по картинкам руки: названо ли касание в промпте (по коду) и видит ли его Astra.', '',
      '| Рука | Названо: нарисовано | Не названо: нарисовано |', '|---|---|---|',
      ...Object.entries(score.namedAgainstShown).map(([arm, one]) => `| ${arm} | ${one.namedShown} из ${one.named} | ${one.unnamedShown} из ${one.unnamed} |`), '');
  }
  return lines.join('\n');
}

// ---- The review ----

// One GPT-6 Astra review before the card, as the refs stand had one (docs/action-experiment.md#refs-judging-34): a
// packet with the probe's design, G's instruction on a made-up sheet, and blinded samples of the sessions, which this
// file's own code builds from round two's pictures of arms A, A+ and C at two scenes, with their keys outside the
// packet; the review answers with changes to apply as it words them. The two samples are also judged as the probe's
// sessions will be, which tries the whole chain before the card: three sessions of the six the lead allowed.
export const SAMPLES = [{ scene: 'bandage', seed: 7 }, { scene: 'rescue', seed: 11 }];
const SAMPLE_ARMS = ['A', 'A+', 'C'];
const TEXT: Schema = { type: 'string' };
export const REVIEW_SCHEMA: Schema = strict({ verdict: { type: 'string', enum: ['freeze', 'freeze_with_changes', 'do_not_freeze'] },
  changes: { type: 'array', items: strict({ area: { type: 'string', enum: ['task', 'bundle', 'blinding', 'scores', 'clauses', 'layout', 'arms', 'other'] },
    change: TEXT, why: TEXT }) } });
export const REVIEW_TASK = `You are reviewing, before a paid GPU rental, how a probe that compares picture prompts will be judged. Nothing of the probe is drawn yet. In this folder: probe.md, the probe's design, its scores and the clauses fixed for its verdicts; g-instruction.txt, the instruction one arm's prompts were written under, shown on a made-up sheet (the prompts are frozen and cannot change); and samples/, two sessions exactly as a judge will get them: TASK.md, input.json, schema.json and the pictures, all of them attached here. The samples' pictures come from an earlier round and stand in for the probe's; which prompt drew which is kept outside the folder.

Answer:
1. Can a judge answer TASK.md for such inputs and pictures as it asks, and does anything in a session's folder tell which arm drew a picture?
2. Do the scores and the clauses in probe.md measure what the probe asks: whether a prompt a model writes gives pictures closer to the scene than today's assembled one? Could an arm win or lose for a reason other than its prompt?
3. What should change before the rental, while a change costs nothing?
Word each change so that it can be applied as written; a change that needs the frozen prompts to change, say so. End with exactly one \`\`\`json block that fits schema.json in this folder: verdict, and changes, each with its area, the change and why.`;
function probeText() {
  return `# The prompt arms probe: what is drawn, and how it is judged

The question, from a tester: does a picture prompt that a language model writes beat the one the bot's code assembles today?

## Scenes and pictures

Twelve clean scenes of an earlier round (${SCENES.join(', ')}), each ending in one moment with two to four participants and ${'essential contacts, 49 in all'}; each has a checklist made from the scene's text alone, before any picture existed. Every picture of a scene and seed shares the seed, the canvas (${SIZE}), 25 steps, CFG 1 and one image model (Qwen-Image 2.1, int8); only the prompt differs. Seeds ${ARM_SEEDS.join(' and ')}: up to 120 pictures.

## Arms

- C0, today's bot: a language model (hosted Gemma 4 31B) fills a structured description of the moment (shot, place, each person's pose and clothes, the contacts), and code assembles it into a prompt, each listed person with the sheet's look word for word, and a fixed style line at the end.
- G: the same model writes the whole English prompt from the same scene under g-instruction.txt: the main action first, then one sentence per participant beginning with the look word for word, then the shot, the place, the objects and the light. Code only takes names and ages out and adds the same style line.
- PE: C0's prompt rewritten on the GPU by the image model's own prompt enhancer (Qwen-Image 2.1 PE, a 9B language model at int8, run by ComfyUI's TextGenerate) under its published system prompt, which asks for one JSON line with the rewritten prompt and an aspect ratio: without thinking, temperature 1, top-p 0.95, top-k 20, one fixed seed, at most 1536 new tokens. The rewrite is drawn as it comes back, on the same canvas whatever ratio it names; the arm has no picture where the enhancer returned nothing usable.
- PT: the same with thinking, at most 4096 new tokens, drawn after the rest, and the first cut if time runs out.
- A+: the earlier round's variant prompt of the scene, drawn again here: an uncensored 4-bit variant of the same Gemma 4 31B on a rented card filled the bot's structured description under an instruction changed to stress the moment, every participant and their contacts, and code assembled it as C0's is.

By code, in words only: every arm's prompt keeps every sheet look (38 of 38 for C0 and G); C0 and G each name 34 of the 49 essential contacts, A+ 37; G states the main action in its first sentence in 11 scenes of 12, C0 in 1.

## Judging

For each scene and seed one session with that seed's pictures of every arm (up to five), named by their hashes, in the order of the names. TASK.md and schema.json are the earlier round's pictures task word for word: the judge sees the scene, the sheet and the checklist (without which relations are essential), never a prompt. GPT-6 Astra at high effort, one fresh session after one without valid answers. Four scenes (${REPEATED.join(', ')}) are judged again at seed ${ARM_SEEDS[0]}, for the judge's agreement with itself.

## Scores, per picture

- contacts: the share of the scene's essential relations answered yes; all_contacts: every one of them yes;
- complete: every participant present; mixup: wrong_person, swapped_looks or merged not answered no; anatomy: anatomy not answered no;
- looks: the share of the participants on the sheet present and answered yes on looks.

## Clauses, fixed before any picture

Each of G, PE, PT and A+ against C0, on the scenes and seeds where both have a picture, a scene's value the mean over its seeds:
- contacts gain ${CLAUSES.contactsGain.toFixed(2)} or more, over ${CLAUSES.scenes} matched scenes at least, else undecided;
- all_contacts and complete: no fewer pictures than C0;
- mixups: no more pictures than C0;
- anatomy: at most max(1, n/10) more pictures than C0, n the matched pictures;
- looks: not below C0 by more than ${Math.abs(CLAUSES.looks).toFixed(2)};
- floor: the arm's own contacts ${CLAUSES.floor.toFixed(2)} or more.
An arm passes when every clause and the floor hold. Beside each difference, a 90% interval from 10,000 resamples of the scenes, reported and not a clause; and, for each arm, how often a contact its prompt names in words is drawn, against one it does not name.
`;
}
// The packet, built once; its samples' keys beside it, outside.
export function writeReview(run: string, round2: string) {
  const dir = join(judgeDirOf(run), 'review'), packet = join(dir, 'packet');
  if (existsSync(packet)) return { packet, kept: true };
  mkdirSync(join(packet, 'samples'), { recursive: true, mode: 0o700 });
  writeFileSync(join(packet, 'REVIEW.md'), `${REVIEW_TASK}\n`, { mode: 0o600 });
  writeFileSync(join(packet, 'schema.json'), JSON.stringify(REVIEW_SCHEMA, null, 2), { mode: 0o600 });
  writeFileSync(join(packet, 'probe.md'), probeText(), { mode: 0o600 });
  writeFileSync(join(packet, 'g-instruction.txt'), `${gInstruction([{ name: 'Вера', look: 'a slender young woman with short dark hair and grey eyes',
    outfit: 'wearing a green raincoat and rubber boots' }, { name: 'Олег', look: 'a broad-shouldered middle-aged man with a grey beard',
    outfit: 'wearing a checked flannel shirt and work trousers' }])}\n`, { mode: 0o600 });
  for (const sample of SAMPLES) {
    const name = `pictures-${sample.scene}-s${sample.seed}`, from = storyDir(round2, sample.scene);
    const key = readJson<{ pictures: { name: string; arms: string[]; sha256: string }[] }>(join(from, 'keys', `pictures-s${sample.seed}.json`));
    const drawn = (key?.pictures ?? []).filter(one => one.arms.some(arm => SAMPLE_ARMS.includes(arm)))
      .map(one => ({ arms: one.arms, sha256: one.sha256, bytes: checked(join(from, 'bundles', `pictures-s${sample.seed}`, one.name), one.sha256, `${sample.scene} ${one.name}`) }));
    if (drawn.length < 2) throw new Refusal(`round two has too few pictures of ${sample.scene} at seed ${sample.seed} for a sample`);
    const input = sceneInput(round2, sample.scene);
    writeBundle(join(packet, 'samples', name), join(dir, 'keys', `${name}.json`), name, sample.scene, sample.seed,
      { scene: input.scene, sheet: input.sheet, checklist: shown(input.checklist) }, drawn);
  }
  return { packet, kept: false };
}
const samplePictures = (copy: string) => readdirSync(join(copy, 'samples')).sort().flatMap(name => picturesOf(join(copy, 'samples', name)));
// The review and the samples' sessions, three at a time in one queue, each with its two attempts: six sessions at most,
// the review's record apart from the probe's.
export async function runReview(run: string, round2: string, options: { exec?: Exec; codex?: string; log?: (event: object) => void } = {}) {
  const { packet } = writeReview(run, round2), dir = join(judgeDirOf(run), 'review'), bundles = join(dir, 'bundles');
  if (!existsSync(bundles)) {
    mkdirSync(bundles, { recursive: true, mode: 0o700 });
    cpSync(packet, join(bundles, 'review'), { recursive: true });
    for (const name of readdirSync(join(packet, 'samples'))) cpSync(join(packet, 'samples', name), join(bundles, name), { recursive: true });
  }
  const names = ['review', ...SAMPLES.map(one => `pictures-${one.scene}-s${one.seed}`)];
  return runQueue({ dir, bundles, names, pins: { ...pinsOf(), review: sha256(REVIEW_TASK), reviewSchema: sha256(JSON.stringify(REVIEW_SCHEMA)) },
    prompt: name => (name === 'review' ? REVIEW_TASK : TASKS.pictures), images: copy => (existsSync(join(copy, 'samples')) ? samplePictures(copy) : picturesOf(copy)),
    parallel: 3, exec: options.exec, codex: options.codex, log: options.log, badShare: 1 });
}

// ---- The dry run ----

// The judging without a card or a judge, in `dir`: made-up stands of grey pictures under the probe's keys, PE missing
// in two scenes as a failed rewrite leaves it and PT in four; a picture whose bytes are not its cell's refused; the
// bundles, blinded and checked; the sessions judged by a stand-in for codex that refuses once (image-refs-judge.ts
// `fakeCodex`); the scores; the review's packet and its three sessions; and the scenes' word nowhere but the bundles.
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
    const lost = { PE: ['beach', 'cheer'], PT: ['beach', 'cheer', 'demon', 'gym'] } as Record<string, string[]>;
    for (const stand of ['core', 'think']) {
      const cells: StandIndex['cells'] = {};
      for (const arm of ARMS.filter(one => standOf(one) === stand)) {
        for (const scene of SCENES.filter(one => !lost[arm]?.includes(one))) {
          for (const seed of ARM_SEEDS) {
            // As the harness keeps a picture: its metadata stripped (image-batch.ts `stripPngMetadata`).
            const key = armKey(arm, scene, seed), file = `frames/${arm}-${scene}-s${seed}.png`;
            const bytes = stripPngMetadata(greyPng(FRAME_CANVAS.width, FRAME_CANVAS.height, ++number));
            mkdirSync(join(run, stand, 'frames'), { recursive: true, mode: 0o700 });
            writeFileSync(join(run, stand, file), bytes, { mode: 0o600 });
            cells[key] = { key, id: `${arm}-${scene}`, arm, kind: 'frame', seed, group: 'words', refs: 0, status: 'drawn', file, sha256: sha256(bytes) };
          }
        }
      }
      writeJson(join(run, stand, INDEX_FILE), { startedAt: new Date().toISOString(), pins: {}, server: {}, cells } satisfies StandIndex);
    }
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

    const counts = writeBundles(run, round2);
    const keys = judgeSessions().map(one => readJson<Key>(join(judgeDirOf(run), 'keys', `${one.name}.json`))!);
    const shownPictures = keys.reduce((sum, key) => sum + key.pictures.length, 0);
    const blind = judgeSessions().every(one => {
      const files = readdirSync(join(judgeDirOf(run), 'bundles', one.name)).sort();
      const input = readFileSync(join(judgeDirOf(run), 'bundles', one.name, 'input.json'), 'utf8');
      return files.every(name => ['TASK.md', 'input.json', 'schema.json'].includes(name) || /^pic-[0-9a-f]{8}\.png$/.test(name))
        && !ARMS.some(arm => input.includes(`${arm}-`)) && readFileSync(join(judgeDirOf(run), 'bundles', one.name, 'TASK.md'), 'utf8') === `${TASKS.pictures}\n`;
    });
    const repeats = REPEATED.every(scene => {
      const a = join(judgeDirOf(run), 'bundles', `pictures-${scene}-s${ARM_SEEDS[0]}`), b = join(judgeDirOf(run), 'bundles', `repeat-${scene}-s${ARM_SEEDS[0]}`);
      return readdirSync(a).every(name => readFileSync(join(a, name)).equals(readFileSync(join(b, name))));
    });
    say(`2 bundles: ${counts.built} built, ${shownPictures} pictures shown; each folder the task, the inputs, the schema and pictures named by hash: ${blind}; `
      + `each repeat its first session's bundle: ${repeats}`);
    const drawnPictures = judgeSessions().reduce((sum, one) => sum + ARMS.filter(arm => !lost[arm]?.includes(one.scene)).length, 0);
    expect(counts.built === 28 && shownPictures === drawnPictures && blind && repeats, '28 bundles, every picture as drawn, blinded, the repeats the same');

    const exec = fakeCodex(3), log: object[] = [];
    const record = await judgeProbe(run, { exec, log: event => log.push(event) });
    const judged = judgingCounts(record, judgeSessions().map(one => one.name));
    say(`3 judging: ${JSON.stringify(judged.states)}, ${judged.attempts} attempts, ${judged.refusals} refusal`);
    expect(judged.states.answered === 28 && judged.attempts === 29 && judged.refusals === 1, 'every session answered, the refused one on its second attempt');
    const again = await judgeProbe(run, { exec });
    expect(judgingCounts(again, judgeSessions().map(one => one.name)).attempts === 29, 'a resume judges nothing more');

    const score = scoreProbe(run, round2);
    writeFileSync(join(judgeDirOf(run), 'score.md'), scoreMarkdown(score), { mode: 0o600 });
    writeJson(join(judgeDirOf(run), 'score.json'), score);
    say(`4 scores: ${Object.entries(score.arms).map(([arm, one]) => `${arm} ${one.pictures}`).join(', ')} pictures; `
      + `${score.comparisons.map(one => `${one.arm} ${one.verdict} over ${one.scenes} scenes`).join(', ')}; agreement over ${Object.values(score.agreement).reduce((sum, one) => sum + one.of, 0)} answers`);
    expect(score.arms.C0.pictures === 24 && score.arms.PE.pictures === 20 && score.arms.PT.pictures === 16 && score.comparisons.every(one => one.verdict !== undefined)
      && score.comparisons.find(one => one.arm === 'PT')!.scenes === 8, 'every arm\'s pictures scored and set against C0');

    const review = await runReview(run, round2, { exec: fakeCodex(5) });
    const reviewed = judgingCounts(review, Object.keys(review.sessions));
    const packetFiles = readdirSync(join(judgeDirOf(run), 'review', 'packet')).sort();
    say(`5 review: packet ${packetFiles.join(', ')}; ${JSON.stringify(reviewed.states)} in ${reviewed.attempts} attempts`);
    expect(packetFiles.join(',') === 'REVIEW.md,g-instruction.txt,probe.md,samples,schema.json' && reviewed.states.answered === 3, 'the packet and its three sessions');

    // The scenes' words stay in the bundles and the session copies; nothing is printed.
    const text = output.text();
    const scenes = SCENES.map(scene => sceneInput(round2, scene).scene.split(/\s+/).slice(0, 6).join(' '));
    const beyond = searchTree(dry, scenes.map(one => Buffer.from(one, 'utf8')), path => /\/(bundles|sessions|samples|packet)(\/|$)/.test(path));
    const printed = scenes.some(one => text.includes(one));
    say(`6 privacy: a scene's opening words in ${beyond.hits.length} of ${beyond.files} files beside the bundles and the sessions; printed ${printed}`);
    expect(!beyond.hits.length && !beyond.unread.length && !printed, 'no scene beyond the bundles and the sessions, nothing printed');
    say(missed.length ? `the judging dry run did NOT go as expected: ${missed.length} of its checks` : 'the judging dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    output.stop();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}

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
  if (!values.run) throw new Refusal('Use: image-prompt-arms-judge.ts review|bundles|judge|score|dry-run --run <the probe\'s run directory> [--round2 <round two\'s>]');
  const run = resolve(values.run);
  if (command === 'review') {
    const record = await runReview(run, round2, { log: print });
    print({ event: 'review', ...judgingCounts(record, Object.keys(record.sessions)) });
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
    for (const one of score.comparisons) print({ event: 'comparison', arm: one.arm, verdict: one.verdict, scenes: one.scenes, contacts: one.contacts.difference });
  } else throw new Refusal('Use: image-prompt-arms-judge.ts review|bundles|judge|score|dry-run (docs/action-experiment.md#prompt-arms-judging)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
