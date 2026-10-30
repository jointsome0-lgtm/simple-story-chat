// The story domain: the library's types and the pure operations on it, used across local/.

// Library format v1 as stored by the local bot. Store.read checks only `version`; everything
// else is trusted as written by this code, and readers of optional fields tolerate their absence.
export type Seed = { id: string; title: string; startTime: string; text: string };
// New memory always has these fields, but prompt.ts also reads facts without kind, at or source;
// keep those fallbacks for older or incomplete v1 data.
export type Fact = { kind: string; at: string; text: string; source: string[] };
/** Token counts reported by a provider; null marks a count it did not report. */
export type Usage = {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  cachedInputTokens?: number | null; reasoningCharacters?: number | null; reasoningTokens?: number | null;
};
export type RequestStamp = { model: string; memory: string | null; provider: string; inputBytes: number; systemHash: string };
export type MemoryVersion = {
  id: string; parent: string | null; cutoff: string; covered: string[];
  // `sgr` keeps the validated extraction stages for audit; prompts use only `facts`.
  delta: { facts: Fact[]; sgr?: { evidence: unknown[]; conflicts: unknown[]; facts: unknown[] } };
  method?: 'plain' | 'sgr'; repairScenes?: number; usage?: Usage;
  // The reader rewrote or took out a fact of this version (`editFact`), which the model did not write as it stands.
  edited?: boolean;
};
export type SceneNode = {
  id: string; parent: string | null; input: string; text: string; time: string; truncated: boolean; delivery: 'pending' | 'sent';
  usage?: Usage | null; requestContext?: RequestStamp; streamResultMismatch?: boolean;
  modelInfo?: { provider: string; model: string }; messageId?: number;
  // The messages that showed this scene again (/last, a switch of branch, a fork), newest last, the last few only: a
  // reply to one of them is a reply to the scene as well (local/bot.ts `replied`). Only the local bot writes it.
  shownAs?: number[];
  // `Job.move` of the turn that wrote the scene, for another version of it to be the same move. A scene from before
  // this field does not say (local/bot.ts `narratorsMove`).
  move?: 'narrator';
  // What each person of the story's sheet wore in this scene's picture, by their sheet name: the clothes the next
  // picture of this line of the story starts from (local/picture.ts). A reader who changes a person's clothes in the
  // person's whole profile while this scene is the head of the branch being played writes them here too
  // (local/profile.ts). Only the local bot writes it.
  clothes?: Record<string, string>;
  // How this scene's own picture was drawn, all but its prompt: a variant of it is drawn with the same, for as long
  // as the scene is kept (local/picture.ts `variant`). Only the local bot writes it.
  picture?: PictureRecipe;
  // Telegram's id of the file of this scene's own picture, by which it can be sent again without being drawn again: no
  // picture is kept on this disk. Nothing reads it yet; it is written from now on, for an export or a thumbnail to have
  // the pictures of the scenes before that day. Only the local bot writes it.
  pictureFile?: string;
  // How people of the story's sheet look from this scene on, by their sheet name, where it is not what the sheet and
  // the scenes above say (local/picture-versions.ts): a version holds here and in every scene below this one, on every
  // line through it. Only the local bot writes it.
  appearance?: Record<string, SheetVersion>;
};
// One person's appearance from one scene on (the owner's design of 2026-09-28, local/picture-versions.ts): text alone,
// since their portrait and their references are the person's whatever the scene. `changes` are the lasting changes the
// story made by this scene, as a frame named them, one line each in the story's language; `description` and `look` are
// what the reader wrote «only from this moment», their own description or their own look; `retold` is the details and
// the look retold from what is in force at this scene, and `from` a hash of what they were retold from, which tells a
// retelling that is out of date.
export type SheetVersion = { changes?: string[]; description?: string; look?: string; retold?: { details: string; look: string; from: string } };
export type Branch = { id: string; name: string; head: string | null; memory: string | null };
// `bookmark`: the reader keeps this checkpoint's scene among their bookmarks (`addBookmark`). A build without bookmarks
// keeps the field as it keeps any other, and loses it only with the checkpoint.
export type Checkpoint = { id: string; branchId: string; label: string; kind: string; head: string | null; memory: string | null;
  bookmark?: Bookmark };
// A bookmark (docs/telegram-ui.md#bookmarks): the label it was saved with, stored as written and never translated
// afterwards, and when, in milliseconds since the epoch. It names its checkpoint's scene, and one checkpoint of that
// scene at most holds it.
export type Bookmark = { label: string; at: number };
// A portrait of one person of a sheet that the reader kept to pick a reference by (local/picture.ts): the name of its
// file among the reader's portraits beside the database (local/store.ts), never the picture itself, and how it was
// drawn — its recipe, on a canvas of its own, the text of the person it was drawn from as `look` (their `details` or
// their look, `portraitText` in local/image-portraits.ts), which a new text of theirs no longer matches, and the
// clothes and the style line of its prompt. Only the reference experiment's frames use it (local/picture-references.ts).
// One kept before a reader could send pictures of their own, on 2026-09-27, has no `source`, and one kept before a
// portrait showed its whole prompt, which the reader may edit, has no `prompt`: the whole prompt it was drawn from, the
// bot's own or, with `ownPrompt`, the one the reader wrote (the sheet's `portraitPrompt`), which is drawn from nothing
// else, so its `look`, `clothes` and `style` are empty and whatever it says of them is in `prompt`.
export type KeptPortrait = PictureRecipe & { source?: 'drawn'; file: string; look: string; clothes: string; style: string; at: number;
  prompt?: string; ownPrompt?: boolean };
// The standard poses of a person's references (the owner, 2026-09-27: «по дефолту генерация стандартных поз, а далее с
// возможностью поменять на свое закрепить»). `front` is the kept portrait, standing and facing the viewer, or the
// reader's own picture in its place, and the only pose so far: the others are to be drawn from it by editing, which is
// not built yet. The keys stay English, as captions do.
export const POSES = ['front', 'three-quarter', 'profile', 'sitting', 'walking'] as const;
export type Pose = typeof POSES[number];
export const isPose = (value: unknown): value is Pose => (POSES as readonly unknown[]).includes(value);
// How much story time a turn covers and when the reader gets the move again (the owner, 2026-09-29): «Миг», seconds
// to minutes told closely, up to the next point where the hero must act; «Сцена», the default; «Глава», hours to days
// told briefly, up to the next important fork. A story stores only `moment` or `chapter` (`Story.pace`).
export const PACES = ['moment', 'scene', 'chapter'] as const;
export type Pace = typeof PACES[number];
export const isPace = (value: unknown): value is Pace => (PACES as readonly unknown[]).includes(value);
// A picture of a person that a reader in the reference experiment sent (local/reference.ts): the name of its file
// beside the portraits, stripped of its metadata and kept in the format it came in, its size in pixels, and the English
// caption it came with, if any. Nothing drew it, so it has no recipe. Frames take it as they take a drawn portrait (the
// owner, 2026-09-27: «мы можем просто добавить фичу менять на свой портрет?»). `pinned` is to keep it in its pose when
// the poses are drawn, and every picture sent is pinned.
export type OwnReference = { source: 'own'; file: string; format: 'png' | 'jpeg' | 'webp'; width: number; height: number;
  at: number; pinned: boolean; caption?: string };
// The labels a captioner on this computer gives each picture of a pose set (local/pose-set.ts), one of each list: how
// the person holds themselves, the side they turn to the viewer, with left and right the sides of the picture they
// face, and how much of them the picture shows. English, as captions are.
// Keep the CPU captioner's measured six-label protocol independent of manually supplied domain poses.
export const CAPTIONER_POSE_LABELS = ['standing', 'sitting', 'walking', 'lying', 'kneeling', 'crouching'] as const;
export const POSE_LABELS = [...CAPTIONER_POSE_LABELS, 'all_fours'] as const;
export const SIDE_LABELS = ['front', 'three-quarter left', 'three-quarter right', 'profile left', 'profile right', 'back'] as const;
export const FRAMING_LABELS = ['full body', 'half body', 'head and shoulders'] as const;
// A caption: the three labels, and how sure the captioner was of the least sure of them, from 0 to 1, or 1 where the
// reader gave all three.
export type PoseCaption = { pose: typeof POSE_LABELS[number]; side: typeof SIDE_LABELS[number]; framing: typeof FRAMING_LABELS[number];
  confidence: number };
export const POSE_ANNOTATION_LIMITS = { specificPose: 64, poseDetails: 320, expression: 160 } as const;
export const FACE_VISIBILITY_LABELS = ['visible', 'partial', 'hidden'] as const;
export type PoseAnnotations = { specificPose?: string; poseDetails?: string; expression?: string;
  faceVisibility?: typeof FACE_VISIBILITY_LABELS[number] };
// Optional human labels. Overlong fields are omitted, not silently made into another variant; the importer reports
// their row. Bound before Unicode normalisation, including for already saved records used in a model request.
export function poseAnnotations(value: PoseAnnotations): PoseAnnotations {
  const kept: PoseAnnotations = {};
  for (const field of ['specificPose', 'poseDetails', 'expression'] as const) {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length > POSE_ANNOTATION_LIMITS[field]) continue;
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
    if (text && text.length <= POSE_ANNOTATION_LIMITS[field]) kept[field] = text;
  }
  if ((FACE_VISIBILITY_LABELS as readonly unknown[]).includes(value.faceVisibility)) kept.faceVisibility = value.faceVisibility;
  return kept;
}
// One of many pictures of a person that a reader in the pose-set experiment sent (local/pose-set.ts; the tester,
// 2026-09-28, has about 80 of one character), kept as a picture of their own is (`OwnReference`): its file, format, size
// in pixels and bytes, and when it came. `caption` comes later, from the captioner, and `failed` counts the captioner's
// attempts that gave none. A frame takes one picture of the set per person, the one its pose calls for. A picture that
// came in an archive may have labels its reader gave in the archive's labels.csv (local/pose-archive.ts): `given`, the
// labels of the three they gave, which its caption keeps whatever the captioner says, so that a label of the caption is
// the reader's where `given` has it and the captioner's where not, and with all three the caption is theirs from the
// start and the captioner never sees it; and `main`, which prefers it within the same pose variant.
export type PoseSetPicture = PoseAnnotations & { file: string; format: OwnReference['format']; width: number; height: number; bytes: number; at: number;
  caption?: PoseCaption; failed?: number; given?: Partial<Pick<PoseCaption, 'pose' | 'side' | 'framing'>>; main?: true };
// What people of different stories may share of a person: the text they are retold from and every picture of them. Their
// name, clothes and changes, their scenes' versions, and the details and the look retold from all that stay on the sheet,
// since a haircut in one story must not reach another.
export type Appearance = Pick<SheetEntry, 'description' | 'descriptionEdited' | 'portrait' | 'poses' | 'portraitPrompt' | 'poseSet'>;
// A person's appearance saved once, in the reader's library, for any story's sheet to link to (the owner, 2026-10-31:
// «разве не логичнее иметь библиотеку, и просто привязывать их к персонажу?»; docs/telegram-ui.md#presets): a label,
// which a reader's list shows, and when it was made. A link is never a copy, so a picture added reaches every person
// linked, and a caption is made once. It always has a description, the text everybody linked is retold from: a person
// with none is not saved (local/bot.ts), and nothing writes an empty one.
export type CharacterPreset = Appearance & { label: string; at: number; description: string };
export type Story = {
  id: string; seedId: string; title: string; branches: Record<string, Branch>; checkpoints: Record<string, Checkpoint>;
  nodes: Record<string, SceneNode>; memories: Record<string, MemoryVersion>;
  // The character sheet the illustrations use: one fixed appearance line per recurring person, written once from
  // the story's own history and kept beside its memory (docs/illustrations-plan.md#step-3), and the clothes they
  // wore when it was written. A sheet without `outfit` is older and had clothes in `look`; the next picture writes it
  // again. Only the local bot writes it, and only when pictures are switched on; a story without pictures never has it.
  // Since 2026-09-27 a person has three layers of appearance (docs/illustrations-plan.md#three-layers): `description`,
  // the whole text in any language and form, which the sheet takes from the story with the lasting `changes` the story
  // made beside it, and `descriptionEdited` marks one the reader wrote, which wins over the story's; `details`, the
  // English prose a portrait is drawn from, and `look`, which the frames take, are retold from those two, and
  // `lookPending` marks a person still to be retold. `edited` marks a look the reader wrote themselves, which the frames
  // take until the reader writes the description again. A sheet without `changes` is older and is written again by the
  // next picture as well: in one written from 2026-09-26, `details` were the sheet's own or, with `detailsEdited`, the
  // reader's, and the look was compressed from them. That rewrite keeps what the reader wrote and the portrait they kept
  // (local/picture.ts `rewrittenSheet`), and their references with it.
  // A reader in the reference experiment may send a picture of a person of their own (docs/telegram-ui.md#references),
  // which is kept in a pose (`poses`); the front's stands over the portrait. One in the pose-set experiment may send
  // many (`poseSet`), which frames choose from by pose (docs/telegram-ui.md#pose-set).
  // `portraitPrompt` is the whole prompt the reader wrote for this person's portraits, from the one folded under a
  // portrait (docs/telegram-ui.md#portrait-prompt): every portrait of them is drawn from it word for word until they
  // drop it, and without it from the bot's own (local/image-portraits.ts `portraitPrompt`).
  // The sheet is each person as the story's first scene has them. Where the story or the reader changed their text from
  // some scene on, that scene holds the change (`SceneNode.appearance`), and a scene is drawn with what is in force on
  // its own line (local/picture-versions.ts `sheetAt`); the portrait and the references stay here, one per person.
  // `preset` links the person to one of the reader's presets (`CharacterPreset`), whose appearance stands in for their
  // own while it does (`linkedStory`).
  sheet?: { name: string; description?: string; changes?: string; details?: string; look: string; outfit?: string;
    descriptionEdited?: boolean; edited?: boolean; lookPending?: boolean; detailsEdited?: boolean; portrait?: KeptPortrait;
    poses?: Partial<Record<Pose, OwnReference>>; portraitPrompt?: string; poseSet?: PoseSetPicture[]; preset?: string }[];
  // The person of the sheet, by name, whose eyes the frames of this story are seen through (the owner, 2026-09-27;
  // local/picture-pov.ts). At most one; without it, or while that person is not in the scene or not on the sheet, a
  // frame is drawn as usual. Only the local bot writes it, from the characters' card.
  pov?: string;
  // The story's pace when it is not «Сцена», which a story without it has (`PACES`). Only the local bot writes it, from
  // the pace picker of the menu, and only scene requests read it (local/prompt.ts).
  pace?: Exclude<Pace, 'scene'>;
};
export type Job = {
  id: string; storyId: string; branchId: string; head: string | null; memory: string | null; input: string; started: number;
  kind?: 'compact';
  // The reader wrote nothing: «Продолжить» or the start of the story handed the move to the narrator. Without it the
  // input is the reader's own message, the hero's move. Only a story with a pace tells the narrator which it is.
  move?: 'narrator';
  // A move from an earlier point (`beginSideJob`): the reader stays at `back` until its scene is saved. `memory` and
  // `name` are what its branch started with, for the move to be repeated (`LostMove`).
  side?: { back: Place; memory: string | null; name: string };
};
// Where the reader stands in a story: a branch and the scene it had reached.
export type Place = { storyId: string; branchId: string; head: string | null };
// The move of a turn that ended without a scene: the model failed, or the process stopped or died under it (`keepMove`).
// The reader's words outlive the turn and nothing runs them again by itself: «🔄 Повторить» offers them for as long as
// the reader stands where they stood (`lostMove`), and their next move takes their place. A story's deletion takes them.
// `job` is the turn's id, by which a button left under an older failure does not repeat a newer move. `from`: the move
// was to leave an earlier point, and does so again. Only the local bot writes it.
export type LostMove = Place & { job: string; input: string; move?: 'narrator'; from?: Point & { storyId: string; name: string } };
// New drafts always have draftId and parts, but bot.ts and ui.ts also accept a stored draft without them;
// keep those fallbacks for older or incomplete v1 data.
export type SeedDraft = { input: 'seed'; draftId: string; parts: string[]; confirm?: undefined };
export type DeleteConfirmation = { confirm: string; input?: undefined };
// A reader writing a picture style of their own (local/picture-style.ts): their next text message is the style, not a
// move. With `styleId` it is a new version of that style; without it, a new style.
export type StyleInput = { input: 'style'; styleId?: string; confirm?: undefined };
// A reader writing the whole prompt of a variant of the picture of the scene `nodeId` (local/picture.ts `variant`):
// their next text message is that prompt, not a move. The prompt itself is not kept here.
export type PromptInput = { input: 'prompt'; storyId: string; nodeId: string; confirm?: undefined };
// A reader writing the look of one person of a story's sheet, or their details (local/ui.ts, the characters' card):
// their next text message is that text. The person is the one they opened, by story and name, never whatever is
// active by then. `from` is the scene the reader stood at when they chose to write it «only from this moment»
// (local/picture-versions.ts `landEdit`); without it the text is for the whole story.
export type LookInput = { input: 'look' | 'details'; storyId: string; name: string; from?: string; confirm?: undefined };
// A reader in the reference experiment sending a picture of one person of a story's sheet for `pose` (local/reference.ts):
// their next photo or file is that, if it comes within half an hour of `at`, when the wait began. The person is the one
// whose card they opened, by story and name.
export type ReferenceInput = { input: 'reference'; storyId: string; name: string; pose: Pose; at: number; confirm?: undefined };
// A reader in the pose-set experiment sending many pictures of one person of a story's sheet (local/pose-set.ts): every
// photo or file that comes within half an hour of `last`, when the last one came, or of `at`, when the wait began,
// joins the person's pose set, until a button or a command ends the wait. The person is the one whose card they opened,
// by story and name, and `preset` the preset they were linked to then, which the pictures join whatever is linked later.
export type PoseSetInput = { input: 'pose-set'; storyId: string; name: string; at: number; last?: number; preset?: string; confirm?: undefined };
// A photo or a file a reader sent while a wait for a pose set stood, as Telegram described it, until the bot has read it
// (local/bot.ts `uploadNext`): the sizes of a photo, or the file, never a caption; the wait it answered, by its story,
// person and start, with the preset it was for; and the update that brought it. The fields are Telegram's, not validated
// here.
export type PoseUploadFile = { photo?: Record<string, unknown>[]; document?: Record<string, unknown> };
export type PendingPoseUpload = { update: number; storyId: string; name: string; at: number; preset?: string; file: PoseUploadFile };
// A reader writing the whole prompt of a portrait of one person of a story's sheet (local/picture.ts `portrait`): their
// next text message is that prompt, which the person keeps as theirs, and a variant of the portrait whose note they
// pressed is drawn from it with that portrait's `seed`, while the graph and the checkpoint are still the ones its
// `recipe` tag names. The person is the one the note was under, by story and name.
export type PortraitPromptInput = { input: 'portrait-prompt'; storyId: string; name: string; seed: number; recipe: string; confirm?: undefined };
// A reader sending back the whole profile of one person of a story's sheet (local/profile.ts): their next text message
// is that profile, edited. `fields` names the fields of the message they copied it from, as a hexadecimal mask, and
// `hash` is a hash of the person's name, of where new clothes would go and of those fields' text there
// (`profileHash`), which must still be the person's when the profile arrives. The text itself is not kept here. The
// person is the one whose profile it was, by story and name.
export type ProfileInput = { input: 'profile'; storyId: string; name: string; fields: string; hash: string; confirm?: undefined };
// A reader who answered an earlier scene with a move, by replying to its message (local/bot.ts `replied`): the screen of
// that scene asks whether to go on from there. Unlike the other waits this one holds text, since the reader wrote it
// before anything could be asked; a button, a command or their next message ends it, and the text with it. `asked` is
// the update that brought the reply, by which the screen of an earlier reply, which a restart leaves in the chat, cannot
// send this text.
export type MoveInput = { input: 'move'; storyId: string; checkpointId: string; move: string; asked: number; confirm?: undefined };
// A reader rewriting one fact of a branch's memory (`editFact`): their next text message is that fact. The fact is the
// one they opened, by the version that holds it and its place there, which the write must find still in the branch.
export type FactInput = { input: 'fact'; storyId: string; branchId: string; version: string; index: number; confirm?: undefined };
// One of the reader's own picture styles: the name on its button and the line that ends the prompt.
export type OwnStyle = { id: string; name: string; line: string };
// How a picture was drawn, all but its prompt (local/picture.ts): its seed, a hash of the graph, the checkpoint's file
// name, and the size and sampler settings the graph was filled with. A variant of it is drawn with the same. It pins
// the request and not the card: after a change to the card's software, or to weights under the same file name, the
// same recipe can draw another picture (docs/telegram-ui.md#picture-variants).
export type PictureRecipe = { seed: number; graph: string; checkpoint: string; width: number; height: number;
  steps: number; cfg: number; sampler: string; scheduler: string;
  // `pov-guide-v1`: drawn by the recipe of a story seen through a person's eyes (local/picture-guide.ts), which a frame
  // from outside does not take over, nor it a recipe of those. No field means the usual recipe.
  frame?: 'pov-guide-v1';
  // Ordered, immutable portrait inputs of the reference experiment. No field means the older text-only recipe.
  // The version fixes the reference graph; each file is scaled to its own shape, which keeps the card's portraits of
  // 720x1280 at the 352x640 they were first pinned at (local/picture-references.ts `referenceScale`). Hashes refuse a
  // file whose bytes have changed.
  references?: { version: 'qwen-identity-v1'; portraits: { name: string; file: string; sha256: string }[] } };
// A picture the local bot sent into its reader's chat (local/picture.ts): the scene it shows, the message it is, and
// when it was sent, in milliseconds since the epoch. A portrait of a person of the story's sheet shows no scene.
export type SentPicture = { storyId: string; nodeId?: string; messageId: number; at: number };
// Interface language of the bot, never of the stories. A library without it predates the choice and is shown in Russian.
export type Language = 'ru' | 'en' | 'zh' | 'ko' | 'ja';
export type Library = {
  version: 1; seq: number; seeds: Record<string, Seed>; stories: Record<string, Story>;
  active: { storyId: string; branchId: string } | null; job: Job | null;
  ui: SeedDraft | DeleteConfirmation | StyleInput | PromptInput | LookInput | ReferenceInput | PoseSetInput | PortraitPromptInput | ProfileInput | MoveInput | FactInput | null;
  seen: number[];
  language?: Language; lostMove?: LostMove;
  // A job of this reader's ended with the process and they have not been told yet (`interruptJob`, local/bot.ts
  // `interrupted`): it stays through a start that fails or a message that does not get through. Only the local bot
  // writes it. The `interrupted` of older libraries said only that a job had died, and may be long past.
  jobInterrupted?: boolean;
  // The look of this reader's pictures: a preset's key or the id of one of their own styles, and those styles. Only
  // the local bot reads them (local/picture-style.ts), and only for a reader it draws for; without a choice the bot's
  // own style is used.
  pictureStyle?: string; pictureStyles?: Record<string, OwnStyle>;
  // The pictures in this reader's chat that Telegram would still let the bot delete, so that deleting a seed or a
  // branch takes the pictures of its scenes out of the chat too (`forgetLostPictures`). Only the local bot writes them.
  sentPictures?: SentPicture[];
  // The photos and files this reader sent for pose sets that the bot has not read yet, in the order they came. Only the
  // local bot writes them.
  poseUploads?: PendingPoseUpload[];
  // This reader's presets of people, by id (`CharacterPreset`). Only the local bot writes them.
  characterPresets?: Record<string, CharacterPreset>;
};
// Names the library gives to what it creates. They are stored as written and never translated afterwards.
export type Labels = { firstBranch: string; seedCheckpoint: string; forkBranch: (from: string) => string; forkCheckpoint: string; afterCompaction: string };
const LABELS: Labels = { firstBranch: 'Начало', seedCheckpoint: 'Сид', forkBranch: from => `От ${from}`, forkCheckpoint: 'Точка развилки', afterCompaction: 'После сжатия' };
/** A timeline position: a branch or checkpoint head with its memory version. */
export type Point = { head: string | null; memory: string | null };

// `key` names the message for a caller that shows it in another language; the message itself stays Russian.
export class UserError extends Error {
  declare key: string | undefined;
  constructor(message: string, key?: string) { super(message); this.key = key; }
}

export function emptyLibrary(): Library {
  return { version: 1, seq: 0, seeds: {}, stories: {}, active: null, job: null, ui: null, seen: [] };
}

export function setLanguage(state: Library, language: Language): void {
  state.language = language;
}

export function id(state: Library, prefix: string): string {
  state.seq += 1;
  return prefix + state.seq;
}

export function validTime(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!match) return false;
  const [, y, m, d, h, min] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && h < 24 && min < 60;
}

export function addSeed(state: Library, text: string): Seed {
  const [title, startTime, ...body] = text.trim().split('\n');
  if (!title || title.length > 100 || !validTime(startTime?.trim() ?? '') || !body.join('\n').trim()) {
    throw new UserError('Нужны название (до 100 знаков), дата в формате 2026-08-02 20:00 и описание мира, каждое с новой строки.', 'seedFormat');
  }
  const seed = { id: id(state, 's'), title, startTime: startTime.trim(), text: body.join('\n').trim() };
  state.seeds[seed.id] = seed;
  return seed;
}

export function newStory(state: Library, seedId: string, labels: Labels = LABELS): { story: Story; branch: Branch } {
  const seed = state.seeds[seedId];
  if (!seed) throw new UserError('Сид уже удалён.', 'seedGone');
  const story: Story = { id: id(state, 'h'), seedId, title: seed.title, branches: {}, checkpoints: {}, nodes: {}, memories: {} };
  const branch: Branch = { id: id(state, 'b'), name: labels.firstBranch, head: null, memory: null };
  story.branches[branch.id] = branch;
  state.stories[story.id] = story;
  state.active = { storyId: story.id, branchId: branch.id };
  saveCheckpoint(state, story, branch, labels.seedCheckpoint, 'start');
  return { story, branch };
}

export function active(state: Library): { story: Story; branch: Branch; seed: Seed } {
  const story = state.stories[state.active?.storyId as string];
  const branch = story?.branches[state.active?.branchId as string];
  if (!branch) throw new UserError('Выбери ветку истории через /seeds.', 'pickBranch');
  return { story, branch, seed: state.seeds[story.seedId] };
}

export function saveCheckpoint(state: Library, story: Story, branch: Branch, label = 'Пауза', kind = 'manual'): Checkpoint {
  const cp = { id: id(state, 'c'), branchId: branch.id, label: label.slice(0, 100), kind, head: branch.head, memory: branch.memory };
  story.checkpoints[cp.id] = cp;
  return cp;
}

export function fork(state: Library, storyId: string, checkpointId: string, labels: Labels = LABELS): Branch {
  const story = state.stories[storyId];
  const cp = story?.checkpoints[checkpointId];
  if (!cp) throw new UserError('Чекпоинт уже удалён.', 'checkpointGone');
  const branch = { id: id(state, 'b'), name: labels.forkBranch(cp.label), head: cp.head, memory: cp.memory };
  story.branches[branch.id] = branch;
  state.active = { storyId, branchId: branch.id };
  saveCheckpoint(state, story, branch, labels.forkCheckpoint, 'fork');
  return branch;
}

// The point just before a scene of `branch`: its parent, and as much of the branch's memory as stops there.
export function pointBefore(story: Story, branch: Branch, node: SceneNode): Point {
  const before = new Set(history(story, node.parent).map(one => one.id));
  return { head: node.parent, memory: memoryChain(story, branch.memory).filter(memory => before.has(memory.cutoff)).at(-1)?.id ?? null };
}

// Whether a point kept aside still exists: a branch that held it alone may have gone since.
export function pointStands(story: Story | undefined, point: Point): boolean {
  return !!story && (point.head === null || Object.hasOwn(story.nodes, point.head)) && (point.memory === null || Object.hasOwn(story.memories, point.memory));
}

export function history(story: Story, head: string | null): SceneNode[] {
  const nodes = [];
  while (head) {
    const node = story.nodes[head];
    if (!node) throw new Error('Broken history reference');
    nodes.push(node);
    head = node.parent;
  }
  return nodes.reverse();
}

export function memoryChain(story: Story, memory: string | null): MemoryVersion[] {
  const versions = [];
  while (memory) {
    const version = story.memories[memory];
    if (!version) throw new Error('Broken memory reference');
    versions.push(version);
    memory = version.parent;
  }
  return versions.reverse();
}

// The facts of a point's memory, oldest first, each with the version that holds it and its place there.
export function factsOf(story: Story, point: Point): { version: string; index: number; fact: Fact }[] {
  return memoryChain(story, point.memory).flatMap(memory => memory.delta.facts.map((fact, index) => ({ version: memory.id, index, fact })));
}

// The reader rewrites one fact of a branch's memory, or takes it out with `text` null. A version never changes, since
// earlier checkpoints read it: the one that holds the fact is copied with the change, and so is every version after it,
// and the branch and a new checkpoint point at the copies. Going back to a checkpoint before it is going back to the
// memory as it was. Returns false if the fact is no longer in the branch's memory.
export function editFact(state: Library, story: Story, branch: Branch, version: string, index: number, text: string | null, label: string): boolean {
  const chain = memoryChain(story, branch.memory);
  const at = chain.findIndex(memory => memory.id === version);
  if (at < 0 || !chain[at].delta.facts[index]) return false;
  let parent = chain[at].parent;
  for (const memory of chain.slice(at)) {
    const copy: MemoryVersion = { ...memory, id: id(state, 'm'), parent };
    if (memory.id === version) {
      const facts = memory.delta.facts.flatMap((fact, place) => place !== index ? [fact] : text === null ? [] : [{ ...fact, text }]);
      Object.assign(copy, { delta: { ...memory.delta, facts }, edited: true });
    }
    story.memories[copy.id] = copy;
    // A move kept from a point of this branch's memory reads it corrected too.
    if (state.lostMove?.branchId === branch.id && state.lostMove.from?.memory === memory.id) state.lostMove.from.memory = copy.id;
    parent = copy.id;
  }
  branch.memory = parent;
  saveCheckpoint(state, story, branch, label, 'memory');
  return true;
}

export function context(story: Story, branch: Point): { memories: MemoryVersion[]; recent: SceneNode[] } {
  const all = history(story, branch.head);
  const memories = memoryChain(story, branch.memory);
  const cutoff = memories.at(-1)?.cutoff;
  const index = cutoff ? all.findIndex(n => n.id === cutoff) : -1;
  if (cutoff && index < 0) throw new Error('Memory belongs to another timeline');
  return { memories, recent: all.slice(index + 1) };
}

export function beginJob(state: Library, input: string, now: number, where?: { story: Story; branch: Branch }): Job {
  if (state.job) throw new UserError('Продолжение уже готовится. /cancel отменит его, если запрос завис.', 'jobRunning');
  const { story, branch } = where ?? active(state);
  const job: Job = { id: id(state, 'j'), storyId: story.id, branchId: branch.id, head: branch.head, memory: branch.memory, input, started: now };
  state.job = job;
  return job;
}

// A move from an earlier point of a story. Its scene goes on a branch of its own, which stands aside until that scene
// is saved (`commitTurn`): until then the reader stays where they are, at the scene their chat ends with, and a turn
// that ends without a scene leaves no branch behind (`releaseJob`).
export function beginSideJob(state: Library, storyId: string, point: Point, name: string, input: string, now: number, labels: Labels = LABELS): Job {
  const here = active(state);
  const story = state.stories[storyId];
  const branch: Branch = { id: id(state, 'b'), name, ...point };
  const job = beginJob(state, input, now, { story, branch });
  job.side = { back: { storyId: here.story.id, branchId: here.branch.id, head: here.branch.head }, memory: point.memory, name };
  story.branches[branch.id] = branch;
  saveCheckpoint(state, story, branch, labels.forkCheckpoint, 'fork');
  return job;
}

// Ends a job that left no scene. A branch that stood aside for the scene goes with it: it holds nothing else, and a
// compaction made on the way is made again when it is needed.
export function releaseJob(state: Library): void {
  const job = state.job;
  state.job = null;
  if (!job?.side || !state.stories[job.storyId]?.branches[job.branchId]) return;
  const { ui } = state;
  deleteBranch(state, job.storyId, job.branchId);
  state.ui = ui;
}

// Keeps the move of a scene turn that is about to end without a scene. A compaction has no move to keep.
export function keepMove(state: Library, job: Job): void {
  if (job.kind === 'compact') return;
  const { side } = job;
  state.lostMove = { ...side?.back ?? { storyId: job.storyId, branchId: job.branchId, head: job.head }, job: job.id, input: job.input,
    ...job.move ? { move: job.move } : {}, ...side ? { from: { storyId: job.storyId, head: job.head, memory: side.memory, name: side.name } } : {} };
}

// A job that will not finish, since the process died under it or is stopping: its move is kept, and its reader is told
// at the next start. No model or Telegram write is retried by itself.
export function interruptJob(state: Library): void {
  if (!state.job) return;
  keepMove(state, state.job);
  releaseJob(state);
  state.jobInterrupted = true;
}

// The lost move the reader can repeat where they stand now, if there is one.
export function lostMove(state: Partial<Library>): LostMove | undefined {
  const lost = state.lostMove;
  if (!lost || state.active?.storyId !== lost.storyId || state.active.branchId !== lost.branchId) return undefined;
  return state.stories?.[lost.storyId]?.branches[lost.branchId]?.head === lost.head ? lost : undefined;
}

export function jobTarget(state: Library, jobId: string) {
  const job = state.job;
  if (job?.id !== jobId) return null;
  const story = state.stories[job.storyId];
  const branch = story?.branches[job.branchId];
  if (!branch || branch.head !== job.head || branch.memory !== job.memory) return null;
  return { job, story, branch, seed: state.seeds[story.seedId] };
}

export function commitMemory(state: Library, jobId: string, covered: string[], delta: MemoryVersion['delta'], label = LABELS.afterCompaction): boolean {
  const target = jobTarget(state, jobId);
  if (!target) return false;
  const { story, branch, job } = target;
  const recent = context(story, branch).recent;
  if (!covered.length || covered.some((n, i) => recent[i]?.id !== n)) throw new Error('Invalid compaction range');
  const memory = { id: id(state, 'm'), parent: branch.memory, cutoff: covered.at(-1) as string, covered, delta };
  story.memories[memory.id] = memory;
  branch.memory = memory.id;
  job.memory = memory.id;
  saveCheckpoint(state, story, branch, label, 'compaction');
  return true;
}

export function commitTurn(state: Library, jobId: string, text: string, truncated = false) {
  const target = jobTarget(state, jobId);
  if (!target) return null;
  const { story, branch, job } = target;
  const time = text.split('\n')[0].trim();
  if (!validTime(time)) throw new UserError('Модель не указала корректные дату и время. Ответ не записан; отправь продолжение ещё раз.', 'sceneTime');
  const node: SceneNode = { id: id(state, 'n'), parent: branch.head, input: job.input, text, time, truncated, delivery: 'pending',
    ...job.move ? { move: job.move } : {} };
  story.nodes[node.id] = node;
  branch.head = node.id;
  if (job.side) state.active = { storyId: story.id, branchId: branch.id };
  state.job = null;
  return { storyId: story.id, branchId: branch.id, nodeId: node.id };
}

function collect(story: Story): void {
  const nodeIds = new Set();
  const memoryIds = new Set();
  for (const ref of [...Object.values(story.branches), ...Object.values(story.checkpoints)]) {
    for (const node of history(story, ref.head)) nodeIds.add(node.id);
    for (const memory of memoryChain(story, ref.memory)) memoryIds.add(memory.id);
  }
  for (const key of Object.keys(story.nodes)) if (!nodeIds.has(key)) delete story.nodes[key];
  for (const key of Object.keys(story.memories)) if (!memoryIds.has(key)) delete story.memories[key];
}

export function deleteBranch(state: Library, storyId: string, branchId: string): void {
  const story = state.stories[storyId];
  if (!story?.branches[branchId]) throw new UserError('Ветка уже удалена.', 'branchGone');
  delete story.branches[branchId];
  const gone = Object.values(story.checkpoints).filter(cp => cp.branchId === branchId);
  for (const cp of gone) delete story.checkpoints[cp.id];
  // A bookmark names a scene, not the checkpoint it was saved on: while another checkpoint names that scene, the
  // bookmark moves there, to one with the same memory if there is one, and it goes only with the scene's last checkpoint.
  for (const cp of gone) {
    const left = Object.values(story.checkpoints).filter(other => other.head === cp.head && Object.hasOwn(story.branches, other.branchId));
    const heir = left.find(other => other.memory === cp.memory) ?? left[0];
    if (cp.bookmark && heir && !bookmarkOf(story, cp.head)) heir.bookmark = cp.bookmark;
  }
  collect(story);
  if (!Object.keys(story.branches).length) delete state.stories[storyId];
  if (state.active?.storyId === storyId && state.active.branchId === branchId) state.active = null;
  if (state.job?.storyId === storyId && state.job.branchId === branchId) state.job = null;
  forgetLostMove(state);
  state.ui = null;
}

export function deleteSeed(state: Library, seedId: string): void {
  if (!state.seeds[seedId]) throw new UserError('Сид уже удалён.', 'seedGone');
  for (const story of Object.values(state.stories)) {
    if (story.seedId !== seedId) continue;
    if (state.active?.storyId === story.id) state.active = null;
    if (state.job?.storyId === story.id) state.job = null;
    delete state.stories[story.id];
  }
  delete state.seeds[seedId];
  forgetLostMove(state);
  state.ui = null;
}

// The reader's words go with the story they were written for.
function forgetLostMove(state: Library): void {
  const lost = state.lostMove;
  if (lost && (!state.stories[lost.storyId]?.branches[lost.branchId] || (lost.from && !state.stories[lost.from.storyId]))) delete state.lostMove;
}

// The checkpoint that holds the bookmark of the scene `head`, if the reader keeps one. Every checkpoint of a scene opens
// it and forks from it, whatever memory it has: the scene's own, a fork made from it, a compaction after it. One on a
// checkpoint whose branch is gone, which no build leaves, holds nothing (local/ui.ts does not show it either).
export function bookmarkOf(story: Story, head: string | null): Checkpoint | undefined {
  return Object.values(story.checkpoints).find(cp => cp.bookmark && cp.head === head && Object.hasOwn(story.branches, cp.branchId));
}

// Keeps the scene of a checkpoint among the reader's bookmarks, once: a scene already kept keeps its bookmark.
export function addBookmark(story: Story, checkpointId: string, label: string, at: number): Checkpoint {
  const cp = story.checkpoints[checkpointId];
  if (!cp) throw new UserError('Чекпоинт уже удалён.', 'checkpointGone');
  const holder = bookmarkOf(story, cp.head);
  if (holder) return holder;
  for (const other of Object.values(story.checkpoints)) if (other.head === cp.head) delete other.bookmark;
  cp.bookmark = { label: label.slice(0, 200), at };
  return cp;
}

// Takes the scene of a checkpoint out of the bookmarks, whichever of its checkpoints holds it.
export function removeBookmark(story: Story, checkpointId: string): void {
  const cp = story.checkpoints[checkpointId];
  if (!cp) throw new UserError('Чекпоинт уже удалён.', 'checkpointGone');
  for (const other of Object.values(story.checkpoints)) if (other.head === cp.head) delete other.bookmark;
}

// Telegram lets a bot delete a message of its own for 48 hours after sending it and never later (Bot API
// `deleteMessage`). A record older than that can no longer be used, so every write of the list drops it.
export const MESSAGE_DELETABLE_MS = 48 * 60 * 60 * 1000;
// A backstop: the library is read and written whole on every update, and the 48 hours alone do not bound the list.
// A thousand pictures is some five hours of the picture card drawing without a pause.
export const SENT_PICTURES_MAX = 1000;

// Records a picture the moment it is sent, beside the others that may still be deleted, newest last.
export function recordPicture(state: Library, picture: SentPicture): void {
  const deletable = (state.sentPictures ?? []).filter(one => picture.at - one.at < MESSAGE_DELETABLE_MS);
  state.sentPictures = [...deletable, picture].slice(-SENT_PICTURES_MAX);
}

// After a deletion: forgets the pictures whose story or scene is gone and returns their messages, for the caller to
// delete from the chat. A record too old to be deleted is dropped and not returned.
export function forgetLostPictures(state: Library, now: number): number[] {
  if (!state.sentPictures) return [];
  const lost: number[] = [];
  state.sentPictures = state.sentPictures.filter(picture => {
    if (now - picture.at >= MESSAGE_DELETABLE_MS) return false;
    const story = state.stories[picture.storyId];
    if (story && (picture.nodeId === undefined || story.nodes[picture.nodeId])) return true;
    lost.push(picture.messageId);
    return false;
  });
  return lost;
}

type SheetEntry = NonNullable<Story['sheet']>[number];
// What a pose of a person holds: the picture the reader sent for it over the one the card drew, which only the front
// has until the other poses are drawn (the kept portrait).
export function poseReference(person: Pick<SheetEntry, 'poses' | 'portrait'>, pose: Pose): OwnReference | KeptPortrait | undefined {
  return person.poses?.[pose] ?? (pose === 'front' ? person.portrait : undefined);
}
// Every file a person's references hold, their pose set's among them, which the store keeps while the sheet or a preset
// refers to them (local/store.ts).
export function referenceFiles(person: Pick<SheetEntry, 'portrait' | 'poses' | 'poseSet'>): string[] {
  return [person.portrait, ...Object.values(person.poses ?? {}), ...person.poseSet ?? []].flatMap(one => one?.file ? [one.file] : []);
}

// The preset a person is linked to. A preset linked anywhere cannot be deleted, so a link that finds none comes from a
// library edited by hand, and the person then has their own appearance.
export function linkedPreset(state: Pick<Partial<Library>, 'characterPresets'>, person: Pick<SheetEntry, 'preset'>): CharacterPreset | undefined {
  const { preset: id } = person;
  return id !== undefined && state.characterPresets && Object.hasOwn(state.characterPresets, id) ? state.characterPresets[id] : undefined;
}
// A person as everything but a write reads them: their preset's appearance in the place of their own, which stays on the
// sheet underneath for an unlink to bring back. A view, whose lists are the preset's own and not to be written.
export function linkedPerson(state: Pick<Partial<Library>, 'characterPresets'>, person: SheetEntry): SheetEntry {
  const preset = person && linkedPreset(state, person);
  if (!preset) return person;
  const { description, descriptionEdited, portrait, poses, portraitPrompt, poseSet, ...rest } = person;
  const { label, at, ...shared } = preset;
  return { ...rest, ...shared };
}
// A story as everything but a write reads it (`linkedPerson`), which is the story itself where nobody on its sheet is
// linked: a reader without a preset reads what they always read. Every reader of a person's appearance starts here, and
// every write of it goes to `appearanceOf`, so that the sheet's places, a story's versions and the stored library stay
// what they are. Taken twice it is what it is once.
export function linkedStory<T extends Story | undefined>(state: Pick<Partial<Library>, 'characterPresets'>, story: T): T {
  if (!story?.sheet?.some(one => one?.preset !== undefined)) return story;
  return { ...story, sheet: story.sheet.map(one => linkedPerson(state, one)) };
}
// Where an edit of a person's appearance goes: their preset while they are linked to one, or else the person. `person` is
// the entry stored on the sheet.
export function appearanceOf(state: Pick<Partial<Library>, 'characterPresets'>, person: SheetEntry): Appearance {
  return linkedPreset(state, person) ?? person;
}
// The picture a preset is shown by: its front, or else the first of its pose set.
export const presetPicture = (preset: CharacterPreset) => poseReference(preset, 'front')?.file ?? preset.poseSet?.[0]?.file;
// Everybody linked to the preset `id`, in every story of the reader's.
export function linkedPeople(state: Pick<Library, 'stories'>, id: string): SheetEntry[] {
  return Object.values(state.stories).flatMap(story => (story.sheet ?? []).filter(one => one?.preset === id));
}
// A new description of a person who is linked is every linked person's, each of them retold from it in their own story.
// A look a reader wrote in another story stays there, as the retelling keeps it. Returns whether `person` was linked.
export function describePreset(state: Library, person: SheetEntry, description: string): boolean {
  const preset = linkedPreset(state, person);
  if (!preset) return false;
  Object.assign(preset, { description, descriptionEdited: true });
  for (const one of linkedPeople(state, person.preset!)) one.lookPending = true;
  return true;
}
// Somebody from before the descriptions has one made of what they do have, the details that stand for it (local/picture-
// versions.ts `descriptionOf`) or else their look, so that their own text is there for an unlink to retell them from.
function ownText(person: SheetEntry) {
  if (person.preset !== undefined || person.description?.trim()) return;
  const own = person.details?.trim() ? person.details : person.look.trim() ? person.look : undefined;
  if (own !== undefined) Object.assign(person, { description: own }, own === person.details && person.detailsEdited ? { descriptionEdited: true } : {});
}
// Moves a person's pictures and portrait prompt into a new preset and links them to it, inside one write: none of them
// stays on the sheet. Their description is copied, since a text is not what a preset is there not to multiply: theirs
// stays, as it stands now, for an unlink to bring back, and the preset's is the reader's from then on, whoever wrote it
// first. The person is not retold: their text is what it was. `person` has a description (local/bot.ts). Returns the
// preset's id.
export function savePreset(state: Library, person: SheetEntry, label: string, at: number): string {
  ownText(person);
  const { description, portrait, poses, portraitPrompt, poseSet } = person;
  const presetId = id(state, 'p');
  state.characterPresets = { ...state.characterPresets, [presetId]: { label, at, description: description!, descriptionEdited: true,
    ...portrait ? { portrait } : {}, ...poses ? { poses } : {}, ...portraitPrompt === undefined ? {} : { portraitPrompt }, ...poseSet ? { poseSet } : {} } };
  for (const key of ['portrait', 'poses', 'portraitPrompt', 'poseSet'] as const) delete person[key];
  person.preset = presetId;
  return presetId;
}
// Links a person to a preset, or to another one. Their own appearance stays under the link, and they are retold from the
// preset's description, which writes over their details and look.
export function linkPreset(person: SheetEntry, presetId: string) {
  ownText(person);
  person.preset = presetId;
  person.lookPending = true;
}
// Takes a person off their preset, and their own text is theirs again, as it stood, with whatever pictures they had left:
// one saved as a preset left theirs there. Somebody with no text of their own takes nothing of a preset: the details and
// the look retold under the link go with it, what the reader wrote apart, and there is nothing to retell them from.
export function unlinkPreset(person: SheetEntry) {
  delete person.preset;
  if (person.description?.trim()) person.lookPending = true;
  else {
    delete person.lookPending;
    if (!person.detailsEdited) delete person.details;
    if (!person.edited) person.look = '';
  }
}
