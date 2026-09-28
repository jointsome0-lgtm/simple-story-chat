// Many pictures of one person that a reader sends at once, for each frame to take the one whose pose fits (the tester,
// 2026-09-28, through the owner: about 80 pose references of a character, unsorted, «просто закинуть»; a LoRA is too
// dear to train). Behind SIMPLE_CHAT_POSE_SET_USERS, a part of the reference experiment's readers, and nobody by
// default (docs/telegram-ui.md#pose-set).
//
// Each picture is kept as a picture of the reader's own is (local/reference.ts), stripped and in its own format, and
// captioned once, in the background, by a small vision model on this computer's CPU (`createPoseCaptioner`, and
// captioner/caption.py beside it), which answers with labels alone: a pose, the side turned to the viewer and how much
// of the person shows (lib/library.ts `POSE_LABELS`). No picture and no caption leaves this computer for it. The
// pictures are then sorted into the standard poses and the back (`poseGroups`), each group with one picture to stand
// for it, so that a frame chooses among six at most: the frame's description names, right after each person's `who`,
// the caption of the group that fits how the frame shows them (`poseRequest`), as Gemma was measured to choose on
// 2026-09-28 (docs/knowledge/view-pick-measurements.md#gemma-card-2026-09-28), and that group's picture is the person's
// one reference, or their front where no group fits (local/picture-references.ts `frameReferences`).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { FRAMING_LABELS, POSE_LABELS, SIDE_LABELS } from '../lib/library.ts';
import type { Library, PoseCaption, PoseSetPicture, Story } from '../lib/library.ts';
import { matchSheet } from './illustrate.ts';
import type { ModelRequest } from './model.ts';
import { errorCode, member } from './model-error.ts';
import type { Log } from './model-error.ts';
import type { ReferencePicture } from './reference.ts';
import type { Store } from './store.ts';

type SheetEntry = NonNullable<Story['sheet']>[number];

// The most pictures one person's set holds, and the most bytes, and the most bytes of every set of one reader's
// together: about 80 drawings of a character fit a set with room to spare, and two such characters a reader's disk.
export const POSE_SET_PICTURES = 100;
export const POSE_SET_BYTES = 300 * 1024 * 1024;
export const POSE_SET_READER_BYTES = 600 * 1024 * 1024;
// The wait for the next picture, from the press of the button or the last picture that came.
export const POSE_SET_WAIT_MS = 30 * 60 * 1000;

// The groups a set is sorted into: lib/library.ts `POSES`, the standard poses, and the back. A standing, kneeling,
// crouching or lying person goes by the side they turn to the viewer, and a sitting or walking one by that pose.
export const POSE_GROUPS = ['front', 'three-quarter', 'profile', 'back', 'sitting', 'walking'] as const;
export type PoseGroup = typeof POSE_GROUPS[number];
export function groupOf(caption: PoseCaption): PoseGroup {
  if (caption.pose === 'sitting' || caption.pose === 'walking') return caption.pose;
  return caption.side === 'front' || caption.side === 'back' ? caption.side : caption.side.startsWith('three-quarter') ? 'three-quarter' : 'profile';
}

// The caption a frame chooses a group by, in the words the view pick was measured with: `standing, three-quarter left`,
// `sitting, front`, `head and shoulders, front`. A group of a side says how its picture shows the person, and a group of
// a pose says that pose first, so that no two groups of one person share a caption.
export function captionText(caption: PoseCaption, group: PoseGroup): string {
  if (group === 'sitting' || group === 'walking') return `${group}, ${caption.side}`;
  return `${caption.framing === 'full body' ? caption.pose : caption.framing}, ${caption.side}`;
}

// How well a picture stands for its group, the lowest first: a group of a side by a standing person over a kneeling,
// a crouching and a lying one, then the whole figure over half of it and the head alone, since a reference carries the
// person's build as well as their face, then the captioner's surest, then the earliest sent.
const STANCE: Record<PoseCaption['pose'], number> = { standing: 0, sitting: 0, walking: 0, kneeling: 1, crouching: 2, lying: 3 };
const FRAMING: Record<PoseCaption['framing'], number> = { 'full body': 0, 'half body': 1, 'head and shoulders': 2 };
export type Group = { group: PoseGroup; caption: string; file: string; count: number };
export function poseGroups(person: Pick<SheetEntry, 'poseSet'>): Group[] {
  const members = new Map<PoseGroup, (PoseSetPicture & { caption: PoseCaption })[]>();
  for (const picture of person.poseSet ?? []) {
    if (!picture.caption) continue;
    const group = groupOf(picture.caption);
    members.set(group, [...members.get(group) ?? [], picture as PoseSetPicture & { caption: PoseCaption }]);
  }
  return POSE_GROUPS.flatMap(group => {
    const list = members.get(group);
    if (!list) return [];
    const [best] = list.toSorted((one, other) => STANCE[one.caption.pose] - STANCE[other.caption.pose]
      || FRAMING[one.caption.framing] - FRAMING[other.caption.framing] || other.caption.confidence - one.caption.confidence || one.at - other.at);
    return [{ group, caption: captionText(best.caption, group), file: best.file, count: list.length }];
  });
}

// How far a person's set has got: its pictures, those captioned, those still to be, and those the captioner gave up on.
export function poseSetState(person: Pick<SheetEntry, 'poseSet'>) {
  const set = person.poseSet ?? [];
  const captioned = set.filter(one => one.caption).length;
  const failed = set.filter(one => !one.caption && (one.failed ?? 0) >= CAPTION_ATTEMPTS).length;
  return { count: set.length, captioned, pending: set.length - captioned - failed, failed, bytes: set.reduce((sum, one) => sum + one.bytes, 0) };
}
const readerBytes = (state: Library) => Object.values(state.stories).flatMap(story => story.sheet ?? [])
  .reduce((sum, person) => sum + (person?.poseSet ?? []).reduce((one, picture) => one + picture.bytes, 0), 0);

// Why a picture was not added to a set it could otherwise join: the set is full, or its bytes, or the reader's.
export type PoseSetLimit = 'full' | 'person_bytes' | 'reader_bytes';
export function poseSetLimit(state: Library, person: SheetEntry, bytes: number): PoseSetLimit | undefined {
  const { count, bytes: held } = poseSetState(person);
  return count >= POSE_SET_PICTURES ? 'full' : held + bytes > POSE_SET_BYTES ? 'person_bytes'
    : readerBytes(state) + bytes > POSE_SET_READER_BYTES ? 'reader_bytes' : undefined;
}

// Adds a picture to `person`'s set, uncaptioned, inside the library write `person` belongs to: the file is written first
// and the sheet refers to it once that write commits, and a rollback deletes it (local/store.ts).
const EXTENSIONS = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;
export function keepPoseSetPicture(store: Store, userId: string, person: SheetEntry, picture: ReferencePicture, at: number) {
  const { bytes, format, width, height } = picture;
  person.poseSet = [...person.poseSet ?? [], { file: store.writePortrait(userId, bytes, EXTENSIONS[format]), format, width, height,
    bytes: bytes.length, at }];
}

// The pose field of a frame, added here at the call and never in local/illustrate.ts, whose request the action
// experiment pins. It is the variant measured on the card on 2026-09-28 (`enumfirst` in view_position.mts): `view`
// right after `who` in each person, an enum of every caption listed and the empty string, 100 more output tokens, and
// the rule after the frame's instruction, word for word. Placed last in a person, the field ran the answer away into
// whitespace in a third of the calls; right after `who`, in none of 124. Another field of a person that goes right after
// `who` too, added before this one, follows it.
export const VIEW_TOKENS = 100;
const COMMON = 'тот вид, который ближе всего к тому, как этот человек показан в кадре, — та же поза (стоит, сидит, лежит, на коленях, на корточках, идёт, бежит), та же сторона к зрителю (лицом, вполоборота, в профиль, спиной) и тот же охват (весь человек или только голова и плечи). Модель картинок повторит позу и охват портрета с этого вида. Смотри на самого человека в кадре, а не на его отражение, если только в кадре не одно отражение. left и right в подписи — сторона кадра, куда человек смотрит.';
export type Viewed = { name: string; groups: Group[] };
const rule = (people: Viewed[]) => `\n- view: у каждого человека из списка ниже — подпись одного из его видов, слово в слово из его строки: ${COMMON} У людей без видов view — пустая строка.\n  Виды:\n${people.map(person => `  - ${person.name}: ${person.groups.map(group => `«${group.caption}»`).join('; ')}`).join('\n')}`;
export function poseRequest(request: ModelRequest, people: Viewed[]): ModelRequest {
  if (!people.length) return request;
  type Items = { required: string[]; properties: Record<string, unknown> };
  const schema = request.outputSchema as { properties: { people: { items: Items } } & Record<string, unknown> };
  const items = schema.properties.people.items;
  const { who, ...rest } = items.properties;
  const view = { type: 'string', enum: [...new Set(people.flatMap(person => person.groups.map(group => group.caption))), ''] };
  const last = request.messages.at(-1)!;
  return { ...request, maxOutputTokens: request.maxOutputTokens + VIEW_TOKENS,
    outputSchema: { ...schema, properties: { ...schema.properties, people: { ...schema.properties.people, items: { ...items,
      required: ['who', 'view', ...items.required.filter(key => key !== 'who')], properties: { who, view, ...rest } } } } },
    messages: [...request.messages.slice(0, -1), { ...last, content: last.content + rule(people) }] };
}

// The group each person of `people` got in an answer to `poseRequest`, by sheet name, and the answer without the field.
// A caption that is not one of the person's own, the empty string among them, gives them none.
export function viewsOf<T extends { people?: unknown }>(answer: T, people: Viewed[]): { answer: T; views: Record<string, PoseGroup> } {
  const views: Record<string, PoseGroup> = {};
  const names = people.map(one => one.name);
  const listed = Array.isArray(answer.people) ? answer.people as { who?: unknown; view?: unknown }[] : undefined;
  for (const one of listed ?? []) {
    const name = typeof one?.who === 'string' ? matchSheet(one.who, names) : null;
    const group = people.find(person => person.name === name)?.groups.find(group => group.caption === one?.view);
    if (name !== null && group && !Object.hasOwn(views, name)) views[name] = group.group;
  }
  const plain = listed ? { ...answer, people: listed.map(one => {
    if (!one || typeof one !== 'object') return one;
    const { view, ...rest } = one;
    return rest;
  }) } : answer;
  return { answer: plain, views };
}

// The captioner (captioner/caption.py): one process on this computer, started when a picture waits for a caption and
// ended a minute after the last, read one picture at a time from the reader's own directory, by path, and answering
// with labels alone. It runs niced, on a few threads, with none of the bot's environment: no token or key reaches it,
// and it opens no connection. An answer that is not labels is no caption. A picture gets CAPTION_ATTEMPTS tries; one
// the model cannot read, or that takes it past CAPTION_MS, uses one up and goes to the end of the queue, and after the
// last it stays uncaptioned, out of every group. A captioner that does not start, or whose process ends or stalls on
// CRASHES pictures in a row, leaves the pictures waiting, and is not started again for RETRY_MS, however many pictures
// come meanwhile: an album sent to a computer without the captioner would otherwise start it once a picture.
export const CAPTION_ATTEMPTS = 2;
const CAPTION_MS = 120_000;
const START_MS = 180_000;
const IDLE_MS = 60_000;
const RETRY_MS = 10 * 60_000;
const CRASHES = 3;
export type CaptionerConfig = { python: string; script: string; model: string; threads: number };
type Job = { userId: string; storyId: string; name: string; file: string };
type Answer = { id?: unknown; pose?: unknown; side?: unknown; framing?: unknown; confidence?: unknown; error?: unknown; ready?: unknown };
export function createPoseCaptioner(config: CaptionerConfig, { store, log, spawnProcess = spawn }: {
  store: Store; log: (userId: string) => Log; spawnProcess?: typeof spawn;
}) {
  const queue: Job[] = [];
  const queued = new Set<string>();
  let child: { process: ChildProcess; answers: AsyncIterator<string> } | undefined;
  let running: Promise<void> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let next = 0;
  // After a start that failed: the retry, and the readers whose pictures wait for it.
  let blocked: ReturnType<typeof setTimeout> | undefined;
  const waiting = new Set<string>();
  const key = (job: Pick<Job, 'userId' | 'file'>) => `${job.userId}/${job.file}`;

  function end() {
    const was = child;
    child = undefined;
    if (!was) return;
    was.process.stdin?.end();
    // A process that does not leave on its own when its input ends is ended.
    const kill = setTimeout(() => was.process.kill('SIGKILL'), 10_000);
    kill.unref();
    was.process.once('exit', () => clearTimeout(kill));
  }
  // The next line of the process's answers, or a failure once it ends or `ms` pass.
  async function answer(ms: number): Promise<Answer> {
    const current = child!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('captioner_timeout'), { code: 'captioner_timeout' })), ms); });
    try {
      const line = await Promise.race([current.answers.next(), timeout]);
      if (line.done) throw Object.assign(new Error('captioner_exited'), { code: 'captioner_exited' });
      try { return JSON.parse(line.value) as Answer; } catch { throw Object.assign(new Error('captioner_protocol'), { code: 'captioner_protocol' }); }
    } finally { clearTimeout(timer); }
  }
  async function start() {
    const launched = spawnProcess(config.python, [config.script, '--model', config.model, '--threads', String(config.threads)], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/nonexistent', LANG: 'C.UTF-8',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', OMP_NUM_THREADS: String(config.threads),
        PYTHONDONTWRITEBYTECODE: '1' },
    });
    const failed = new Promise<never>((_, reject) => launched.on('error', () => reject(Object.assign(new Error('captioner_unavailable'),
      { code: 'captioner_unavailable' }))));
    failed.catch(() => {});
    // A process that went away between pictures fails the next write, and would take the bot with it: its answers end
    // instead, and the picture counts it as a failed try.
    launched.stdin?.on('error', () => {});
    child = { process: launched, answers: createInterface({ input: launched.stdout! })[Symbol.asyncIterator]() };
    const ready = await Promise.race([answer(START_MS), failed]);
    if (ready.ready !== true) throw Object.assign(new Error('captioner_protocol'), { code: 'captioner_protocol' });
  }
  function valid(one: Answer): PoseCaption | undefined {
    const confidence = typeof one.confidence === 'number' && one.confidence >= 0 && one.confidence <= 1 ? Math.round(one.confidence * 1000) / 1000 : undefined;
    return member(POSE_LABELS, one.pose) && member(SIDE_LABELS, one.side) && member(FRAMING_LABELS, one.framing) && confidence !== undefined
      ? { pose: one.pose, side: one.side, framing: one.framing, confidence } : undefined;
  }
  // Writes what became of one picture into its reader's library, its caption or one more failed try, if the picture is
  // still where it was and uncaptioned; and says whether it was written, and whether the picture has a try left.
  function settle(job: Job, caption: PoseCaption | undefined) {
    return store.mutate(job.userId, state => {
      const picture = state.stories[job.storyId]?.sheet?.find(one => one.name === job.name)?.poseSet?.find(one => one.file === job.file);
      if (!picture || picture.caption) return { written: false, again: false };
      if (caption) picture.caption = caption; else picture.failed = (picture.failed ?? 0) + 1;
      return { written: true, again: !caption && (picture.failed ?? 0) < CAPTION_ATTEMPTS };
    });
  }
  // Nothing can be captioned now: every picture waits for the retry, or for the bot's next start.
  function block(job: Job) {
    end();
    for (const one of [job, ...queue.splice(0)]) { queued.delete(key(one)); waiting.add(one.userId); }
    blocked = setTimeout(() => {
      blocked = undefined;
      const users = [...waiting];
      waiting.clear();
      for (const userId of users) captioner.enqueue(userId);
    }, RETRY_MS);
    blocked.unref();
  }
  async function run() {
    let crashes = 0;
    while (queue.length && !stopped) {
      const job = queue.shift()!;
      const row = log(job.userId);
      const started = Date.now();
      let again = false;
      try {
        if (!child) {
          try { await start(); }
          catch (error) {
            row('pose_captioner_failed', errorCode(error) === 'captioner_timeout' ? 'captioner_timeout' : 'captioner_unavailable', { outcome: 'failed' });
            block(job);
            return;
          }
        }
        const id = ++next;
        child!.process.stdin!.write(`${JSON.stringify({ id, path: join(store.portraits(job.userId), job.file) })}\n`);
        const got = await answer(CAPTION_MS);
        if (got.id !== id) throw Object.assign(new Error('captioner_protocol'), { code: 'captioner_protocol' });
        crashes = 0;
        const caption = valid(got);
        const settled = settle(job, caption);
        again = settled.again;
        if (settled.written) row('pose_captioned', caption ? undefined : 'caption_refused', { outcome: caption ? 'ready' : 'failed',
          elapsedMs: Date.now() - started, ...caption ? { captionPose: caption.pose, captionSide: caption.side, captionFraming: caption.framing } : {} });
      } catch (error) {
        const code = errorCode(error);
        end();
        if (!stopped) {
          again = settle(job, undefined).again;
          row('pose_captioner_failed', typeof code === 'string' && /^captioner_[a-z]+$/.test(code) ? code : 'captioner_failed',
            { outcome: 'failed', elapsedMs: Date.now() - started });
          if (++crashes >= CRASHES) {
            block(job);
            return;
          }
        }
      } finally {
        // A picture with a try left goes to the end of the queue, and one without stays uncaptioned.
        if (again && !stopped && !blocked) queue.push(job);
        else queued.delete(key(job));
      }
    }
  }
  function pump() {
    if (running || stopped) return;
    clearTimeout(idle);
    // A library write that failed leaves its picture as it was, to be queued again with its reader's next picture.
    running = run().catch(() => {}).finally(() => {
      running = undefined;
      if (queue.length && !stopped) return pump();
      idle = setTimeout(end, IDLE_MS);
      idle.unref();
    });
  }
  const captioner = {
    // Queues every picture of `userId`'s sets that waits for a caption and has tries left, and starts on them.
    enqueue(userId: string) {
      if (stopped) return;
      if (blocked) { waiting.add(userId); return; }
      const state = store.read(userId);
      for (const story of Object.values(state.stories)) for (const person of story.sheet ?? []) for (const picture of person?.poseSet ?? []) {
        const job = { userId, storyId: story.id, name: person.name, file: picture.file };
        if (picture.caption || (picture.failed ?? 0) >= CAPTION_ATTEMPTS || queued.has(key(job)) || !/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(picture.file)) continue;
        queued.add(key(job));
        queue.push(job);
      }
      pump();
    },
    async stop() {
      stopped = true;
      queue.splice(0);
      clearTimeout(idle);
      clearTimeout(blocked);
      end();
      await running;
    },
  };
  return captioner;
}
