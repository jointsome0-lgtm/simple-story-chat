import { randomBytes } from 'node:crypto';
import { UserError, id, active, addSeed, newStory, fork, beginJob, beginSideJob, addBookmark, removeBookmark,
  deleteSeed, deleteBranch, editFact, forgetLostPictures, interruptJob, MESSAGE_DELETABLE_MS, memoryChain, recoverPictures, releaseReserved, context, factsOf, history, jobTarget, keepMove, lostMove, pointBefore, pointStands, releaseJob, setLanguage, isPace, isPose,
  appearanceOf, linkPreset, linkedPeople, linkedPreset, linkedStory, presetPicture, referenceFiles, savePreset, unlinkPreset } from '../lib/library.ts';
import type { Job, Library, PendingPoseUpload, PoseSetInput, PoseUploadFile, ProfileInput, ReferenceInput, SceneNode } from '../lib/library.ts';
import { storyNarration } from './prompt.ts';
import { chatMemory, createChat } from './telegram.ts';
import type { Chat, ChatMemory, InlineKeyboard, Passing, SceneButtons, Screen, TelegramApi } from './telegram.ts';
import { continueInput, contextStats, narratorsMove } from './context.ts';
import type { ContextSelection, ContextStats } from './context.ts';
import { compactBranch, compactionThreshold } from './generation.ts';
import type { Prepared } from './prepare.ts';
import { createPrepared } from './prepare.ts';
import { beginTurn, inTurn, runTurn } from './turn.ts';
import { messageText, seedInput } from './incoming.ts';
import type { IncomingMessage } from './incoming.ts';
import { SEED_BYTES } from './seed-file.ts';
import type { TelegramDocument } from './seed-file.ts';
import { createProgress } from './progress.ts';
import { storyFile } from './story-file.ts';
import { renderCompaction } from './compact-view.ts';
import type { CompactionStatus } from './compact-view.ts';
import { etaText } from './eta.ts';
import type { GpuController } from './gpu.ts';
import type { Illustrator, PictureRequest, PortraitRequest, SampleRequest, VariantRequest } from './picture.ts';
import { DESCRIPTION_CHARS, LOOK_CHARS, ownPortraitPrompt, personAt, personTag } from './picture.ts';
import { seesThrough } from './picture-pov.ts';
import { countVersions, descriptionOf, editableFrom, landEdit, personHere, personKey } from './picture-versions.ts';
import { portraitText } from './image-portraits.ts';
import { MAY_BE_EMPTY, PROFILE_CHARS, WORN_CLOTHES_CHARS, applyProfile, changedFields, fieldsMask, maskFields, parseProfile, profileHash, profileOf } from './profile.ts';
import type { ProfileField } from './profile.ts';
import type { ArchiveRefusal, ErrorDetails, Log } from './model-error.ts';
import { errorCode, member, safeErrorDetails, unavailable } from './model-error.ts';
import { readReference } from './picture-references.ts';
import { REFERENCE_WAIT_MS, REFUSAL_CODES, captionOf, isArchive, keepReference } from './reference.ts';
import { POSE_SET_PICTURES, POSE_SET_WAIT_MS, createPoseCaptioner, keepPoseSetPicture, poseSetLimit, poseSetState } from './pose-set.ts';
import type { CaptionerConfig, PoseSetLimit } from './pose-set.ts';
import { ArchiveError } from './pose-archive.ts';
import type { ArchiveLabels, PoseArchive } from './pose-archive.ts';
import type { ReceivedPicture } from './reference.ts';
import type { GenerationResult, Provider } from './model.ts';
import { STYLE } from './illustrate.ts';
import { OWN_STYLE_CHARS, OWN_STYLES_MAX, PROMPT_CHARS, choiceOf, lineOf, ownStyle, ownStyleInput, ownStyles, pickerKeys, styleKey, styleName } from './picture-style.ts';
import type { Store } from './store.ts';
import { fileErrorCode } from './store.ts';
import type { GpuInfo, ModelInfo, RenderDetails, ScenePlace } from './ui.ts';
import { FACT_CHARS, PAGE, bookmarkLabel } from './ui.ts';
import { isRegistered, langFromTelegram, texts } from './text.ts';
import type { Messages } from './text.ts';

export type BotOptions = {
  store: Store; api: TelegramApi; provider: Provider; gpu?: GpuController;
  // Pictures under the scenes (local/picture.ts), for the readers its own configuration names. Absent by default:
  // without it nothing is described and nothing is drawn.
  illustrator?: Illustrator;
  readSeedFile?: (document: TelegramDocument) => Promise<string>;
  // A picture a reader in the reference experiment sent of a person (local/reference.ts), read before the library write
  // as a seed file is. Without it, a wait for one refuses whatever comes. `signal` cuts short the read of a file of a
  // pose set (`uploadNext`), as it does an archive's.
  readPicture?: (message: { photo?: unknown; document?: TelegramDocument }, signal?: AbortSignal) => Promise<ReceivedPicture>;
  // The captioner of pose sets on this computer (local/pose-set.ts), for readers the illustrator gives them. Without it a
  // picture of a set waits for its caption.
  captioner?: CaptionerConfig;
  // A ZIP archive of a pose set (local/pose-archive.ts), read before the library write as a picture is. Without it, an
  // archive is refused as one.
  readArchive?: (document: TelegramDocument, signal?: AbortSignal) => Promise<PoseArchive>;
  // The Mini App (local/mini-app.ts) where it is served: its address and the readers whose list of a story's characters
  // has the button that opens it.
  miniApp?: { url: string; users: Set<string> };
  render: (state: Library, route: string, details: RenderDetails) => Screen;
  scenePrefix?: (stats: ContextStats | null, provenance: ModelInfo | undefined, lang?: unknown, place?: ScenePlace | null) => string;
  sceneKeyboard: (state: Library) => InlineKeyboard | undefined;
  allowedUsers: Set<string>; ownerId?: string; maxOutputTokens: number; contextTokens?: number; compactAtTokens?: number; keepScenes?: number;
  memoryMode?: 'plain' | 'sgr'; repairCoverage?: boolean; model?: string; providerName?: string; log?: Log;
};
// Bot API updates are not validated in advance; these are the fields the bot reads.
export type Update = {
  update_id: number;
  message?: IncomingMessage & { from?: Sender; chat?: { id: number; type: string }; document?: TelegramDocument; photo?: unknown; caption?: unknown;
    reply_to_message?: { message_id?: number } };
  callback_query?: { id?: string; data?: string; from?: Sender; message?: { message_id?: number; chat?: { id: number; type: string } } };
};
type Sender = { id: number; is_bot?: boolean; language_code?: string };
// A seed file read before the library write: its text for the draft, or the error to show instead.
type FileInput = { draftId: string; text: string; error?: undefined } | { error: UserError; draftId?: undefined; text?: undefined };
// A picture a reader sent while the bot waited for one of a person (local/reference.ts), read before the library write
// as a seed file is: the picture as it will be kept, or the refusal to show instead, beside the wait it answered, which
// the write must find still standing.
type Upload = { wait: ReferenceInput; picture?: ReceivedPicture; error?: UserError };
// A photo or a file for a pose set (local/pose-set.ts), beside the wait it answered, which the write must find still
// standing: it goes into the reader's queue as Telegram described it, unread (`queuedPoseUpload`).
type PoseUpload = { wait: PoseSetInput; file: PoseUploadFile };
// What the bot read of one (`readPoseFile`): the picture, or the refusal's code for the count of refusals; or an
// archive of them (local/pose-archive.ts), with its name as the reader's chat shows it, or why it was refused whole.
type PoseRead = { picture?: ReceivedPicture; refused?: PoseRefusal; archive?: PoseArchive & { name: string }; archiveRefused?: ArchiveRefusal };
type PoseRefusal = typeof REFUSAL_CODES[keyof typeof REFUSAL_CODES] | PoseSetLimit;
// The pictures of a pose set, one or an archive's, kept or refused, for the message that counts those of the wait they
// came in: how many were kept and how many of those the reader labeled whole, why the others were not, and what became
// of an archive's labels.csv.
type PoseCount = { storyId: string; name: string; at: number; kept: number; labeled: number; refused: Partial<Record<PoseRefusal, number>>;
  labels?: ArchiveLabels & { archive: string } };
// What to do after the library write; handle acts on each field that is set.
type Plan = {
  screen?: Screen; cancel?: boolean; gpuAction?: string; modelStatus?: boolean;
  // The name of the screen a button or a command opened, for its log row (`SCREENS` in local/model-error.ts).
  opened?: string;
  // A branch the reader asked for as a text file (local/story-file.ts).
  exportBranch?: { storyId: string; branchId: string };
  // The screen goes out as a message of its own and leaves the one pressed as it is: a wait that asks for the text of
  // the message its button is under (docs/telegram-ui.md#passing-messages).
  apart?: boolean;
  // The screen only confirms what the update did, and goes with the reader's next update like a notice.
  done?: boolean;
  // The screen is a person's card or profile, which a reader may want to read again: it goes out as a message of its
  // own and stays, as a scene does, and a screen opened from its buttons goes out as one of its own too.
  lasting?: boolean;
  savedText?: { text: string; modelInfo: SceneNode['modelInfo']; shown?: { storyId: string; nodeId: string } }; job?: Job;
  // A sample of styles the reader asked for: what to draw, what to say under each picture and while they are drawn
  // (local/picture.ts `sample`).
  sample?: Pick<SampleRequest, 'storyId' | 'branchId' | 'nodeId' | 'styles' | 'status'>;
  // A variant of a picture from the prompt the reader wrote for it (local/picture.ts `variant`).
  variant?: Pick<VariantRequest, 'storyId' | 'nodeId' | 'prompt'>;
  // The messages of the pictures whose scenes a deletion took with it (lib/library.ts `forgetLostPictures`), to be
  // deleted from the chat once the deletion screen is out.
  lostPictures?: number[];
  // A portrait of a person of a story's sheet the reader asked for (local/picture.ts `portrait`), from the prompt the
  // reader wrote for them if they have one, and with the seed of the portrait it varies if it is a variant.
  portrait?: Pick<PortraitRequest, 'storyId' | 'name' | 'candidate' | 'caption' | 'status' | 'prompt' | 'seed'>;
  // The write may have let go of a kept portrait — a deletion, or a portrait kept in its place — whose file goes once
  // it is committed (local/store.ts `sweepPortraits`).
  sweep?: boolean;
  // The id of a portrait this write keeps, let go from memory once the write is committed and not before.
  portraitKept?: string;
  // The person of a story's sheet whose description this write keeps, for their details and look to be retold from it
  // and their card shown (`retold`).
  retell?: { storyId: string; name: string };
  // A row for the log once the write is committed: what a picture a reader sent became, a profile they sent back, or
  // where a person's text the reader wrote landed (local/picture-versions.ts).
  logged?: { event: string; details: ErrorDetails };
  // The reader's queue of pose-set files to read apart from this update, which a photo or a file joined, or refused as
  // past its length; the refusal, for the message that counts them (local/pose-set.ts).
  poseQueue?: boolean; poseCount?: PoseCount;
  // A preset opened (docs/telegram-ui.md#presets): the picture it is shown by, from the reader's own directory, with its
  // screen as the caption. A message of its own, as a portrait is.
  presetPhoto?: { file: string; caption: Screen };
};
// One reader's turn, for as long as it can still be cancelled. What it leaves behind — a picture being stopped on
// the other card — outlives the entry and is awaited through `inFlight` instead.
//
// `picture` keeps a turn that is still delivering its scene from asking for that scene's picture. The turn's own
// controller feeds it, a /cancel or a shutdown ending both, and a /cancel reaches it through `earlier`, the turn this one
// came after while that one is still delivering: the reader's next message leaves the turn behind it as it is, since
// the job lock is clear by then, and a /cancel means every picture of theirs. Once a picture is asked for it is in the
// reader's queue (local/picture.ts `illustrate`), which /cancel reaches as a whole and nothing here holds.
// `settled` is over once the turn has delivered its scene and kept the place of its picture: the next scene goes out
// after that, so that each picture's place stands right under its scene, whatever Telegram's answers take.
type Running = { controller: AbortController; picture: AbortController; settled: Promise<void>; earlier?: Running };
// Library IDs are a prefix and a sequence number, as id() in lib/library.ts creates them.
const ID = { seed: /^s\d+$/, story: /^h\d+$/, branch: /^b\d+$/, checkpoint: /^c\d+$/, node: /^n\d+$/, memory: /^m\d+$/, place: /^\d{1,4}$/, preset: /^p\d+$/ };
// The wait the reader is in, the input the next message is taken for or the deletion asked about, and for what. A
// draft's parts, the scene a look is written from and a pose set's last picture change within one wait
// (docs/telegram-ui.md#passing-messages).
const waitOf = (ui: Library['ui']) => ui ? JSON.stringify({ ...ui, parts: undefined, from: undefined, last: undefined }) : undefined;
// A refusal in the user's language. The key stays on the error, so it can still be shown in another language.
const refuse = (t: Messages, key: keyof Messages['errors']) => new UserError(t.errors[key], key);
// Errors thrown below the bot (library, seed files, incoming messages) carry Russian text and a catalog key.
const errorText = (t: Messages, error: UserError) =>
  (error.key !== undefined && Object.hasOwn(t.errors, error.key) ? t.errors[error.key as keyof Messages['errors']] : error.message);
// What a reader's queue keeps of a photo or a file sent for a pose set: the sizes of a photo, or the file, as Telegram
// described them and as the picture and archive readers take them (local/reference.ts, local/pose-archive.ts); never a
// caption.
function poseFileOf(message: NonNullable<Update['message']>): PoseUploadFile {
  const fields = (value: unknown, keys: string[]) => Object.fromEntries(keys.flatMap(key =>
    value && typeof value === 'object' && Object.hasOwn(value, key) ? [[key, (value as Record<string, unknown>)[key]]] : []));
  return Array.isArray(message.photo) ? { photo: message.photo.map(size => fields(size, ['file_id', 'file_size', 'width', 'height'])) }
    : { document: fields(message.document, ['file_id', 'file_size', 'mime_type', 'file_name']) };
}
// How long a file of a pose set may take to be read, Telegram's answer with its path, its download (20 s at most,
// local/seed-file.ts) and an archive's reading together: after it the read is cut short, its requests with it
// (`uploadNext`).
const UPLOAD_MS = 45_000;
// How many files of pose sets are read at once, across readers (`readTurn`).
const READS_AT_ONCE = 2;

// Whether this reader's scenes are illustrated, so that their menu offers the picture style, the bot's own style line,
// and the counter of a text's tokens for the characters' card, and whether they may send a portrait of their own
// (local/ui.ts `RenderDetails`). The Mini App's card has the same (local/mini-app.ts).
export const pictureInfo = (illustrator: Illustrator | undefined, userId: string) => ({ pictures: illustrator?.enabledFor(userId) ?? false,
  standardStyle: illustrator?.standardStyle, textTokens: illustrator?.textTokens, references: illustrator?.referencesFor(userId) ?? false,
  versions: illustrator?.versionsFor(userId) ?? false, ...illustrator?.poseSetFor(userId) ? { poseSet: true } : {},
  ...illustrator?.wearFor(userId) ? { wear: true } : {} });

export function createBot({ store, api, provider, gpu, illustrator, readSeedFile, readPicture, captioner: captionerConfig, readArchive, miniApp, render: renderUi, scenePrefix = () => '', sceneKeyboard, allowedUsers, ownerId = '', maxOutputTokens,
  contextTokens = 65536, compactAtTokens = 54000, keepScenes = 4, memoryMode = 'plain', repairCoverage = false, model = 'unknown', providerName = 'claude-code', log = () => {} }: BotOptions) {
  const running = new Map<string, Running>();
  // One drawing on request at a time per reader, a sample of a style or a portrait (local/picture.ts `sample`,
  // `portrait`). A move in the story, /cancel and the bot's stop end it: the scene's own picture goes first, and a
  // sample is only ever a look.
  const sampling = new Map<string, AbortController>();
  // One variant of a picture at a time per reader (local/picture.ts `variant`), beside that one and ended the same way.
  const varying = new Map<string, AbortController>();
  // The retellings of descriptions readers have just written (`retold`), as many as they wrote: each is one call, and
  // only the bot's stop ends one.
  const retelling = new Set<AbortController>();
  // Every turn's work, whether or not its entry is still the reader's current one: a replaced turn is aborted, and
  // what it is unwinding (the picture it had on the other card) still has to finish before the bot may stop. A sample
  // and the removal of a deletion's pictures are awaited the same way.
  const inFlight = new Set<Promise<unknown>>();
  const prepared = new Map<string, Prepared>();
  const preparing = new Set<Promise<void>>();
  const preparedFor = (userId: string) => prepared.get(userId) ?? prepared.set(userId, createPrepared()).get(userId)!;
  const modelInfo: Required<ModelInfo> = { provider: providerName, model, status: 'configured', checkedAt: null };
  // The GPU snapshot must provide every field the renderer reads.
  const render = (state: Library, route: string, details: RenderDetails = {}) =>
    renderUi(state, route, { ...details, modelInfo: { ...modelInfo }, gpuInfo: gpu?.snapshot() satisfies Required<GpuInfo> | undefined });
  // What the reader's screens show of pictures (`pictureInfo`), and the Mini App's address if it serves them.
  const pictureInfoOf = (userId: string) => ({ ...pictureInfo(illustrator, userId), miniApp: miniApp?.users.has(userId) ? miniApp.url : undefined });
  const requireGpu = (t: Messages) => {
    if (!gpu) return;
    try { gpu.assertReady(); }
    catch { throw refuse(t, 'gpuNotReady'); }
  };
  const modelResponded = () => Object.assign(modelInfo, { status: 'ready', checkedAt: new Date().toISOString() });
  const contextConfig = { maxOutputTokens, contextTokens, compactAtTokens, keepScenes, memoryMode, repairCoverage, model, provider: providerName };
  const stats = (state: Library, selection?: ContextSelection) => {
    try { return contextStats(state, contextConfig, selection); } catch { return null; }
  };
  const screen = (state: Library, route: string, details: RenderDetails = {}) => {
    const [name, storyId, checkpointId] = route.split(':');
    const selection = checkpointId ? { storyId, checkpointId } : undefined;
    return render(state, route, { ...details, contextStats: name === 'context' || name === 'checkpoint' ? stats(state, selection) : undefined });
  };
  // What a scene's header says of where it stands: its branch and its number on that line, `ahead` for one being written.
  const placeOf = (state: Library, storyId: string, branchId: string, head: string | null, ahead = 0) => {
    const story = state.stories[storyId];
    const branch = story?.branches[branchId];
    try { return branch ? { branch: branch.name, scene: history(story, head).length + ahead } : null; } catch { return null; }
  };
  // A row about one user's request says whether that user is the owner, never who it is. Only the owner allowed
  // reading the owner's own stories for debugging, so a row without `owner` points at a library that stays closed.
  // With no owner configured every row is `other`.
  const logFor = (userId: string): Log => (event, code, details) =>
    log(event, code, { ...safeErrorDetails(details), actor: userId === ownerId ? 'owner' : 'other' });
  // A message that stays, as a scene does (`send`), and one for the moment (`pass`, docs/telegram-ui.md#passing-messages).
  const safeSend = async (chat: Chat, screen: Screen, log: Log) => {
    try { await chat.send(screen); log('screen_sent'); } catch (error) { log('telegram_send_failed', errorCode(error)); }
  };
  const pass = async (chat: Chat, screen: Screen, log: Log) => {
    try { await chat.show(screen, 'notice'); log('screen_sent'); } catch (error) { log('telegram_send_failed', errorCode(error)); }
  };
  // What the bot remembers of each reader's chat (local/telegram.ts `ChatMemory`).
  const chats = new Map<string, ChatMemory>();
  // The keyboard of a scene of this story and branch, built when the scene goes out (local/telegram.ts `final`): none
  // once the reader is on another one, whose buttons would act on that other branch, and none kept if the reader left
  // it while the scene was on its way (`current`). A new scene gets the usual one, Continue, also while the reader's
  // next job already runs. A scene shown again while a job runs gets the one of the moment (Stop), which leaves the
  // keyboard of the scene before it for when the job ends without a scene.
  const keyboardOf = (userId: string, where: { storyId: string; branchId: string } | null, again = false) => (): SceneButtons => {
    const on = (state: Library) => !!where && state.active?.storyId === where.storyId && state.active.branchId === where.branchId;
    const state = store.read(userId);
    if (!where || !on(state)) return {};
    const current = () => on(store.read(userId));
    const branch = `${where.storyId}:${where.branchId}`;
    return again ? { reply_markup: sceneKeyboard(state), passing: !!state.job, current, branch }
      : { reply_markup: sceneKeyboard({ ...state, job: null }), current, branch };
  };
  const last = (state: Library) => {
    const { story, branch, seed } = active(state);
    // A null head (no scenes yet) is never a node id, so the seed is shown.
    const node = story.nodes[branch.head as string];
    return { text: node?.text ?? `${seed.startTime}\n\n${seed.text}`, modelInfo: node?.modelInfo, ...node ? { shown: { storyId: story.id, nodeId: node.id } } : {} };
  };
  // The scene whose picture a variant is drawn from, when its button is pressed and when its prompt arrives: one of
  // this reader's scenes, still in their library, with a picture still drawable the way it was drawn
  // (local/picture.ts `variantOf`). The picture lane asks again before it draws and before it sends.
  const variantTarget = (state: Library, storyId: string, nodeId: string, t: Messages, pictureInfo: RenderDetails) => {
    const found = pictureInfo.pictures && illustrator ? illustrator.variantOf(state, storyId, nodeId) : 'off';
    if (typeof found === 'string') throw refuse(t, found === 'off' ? 'variantOff' : found === 'gone' ? 'variantGone' : 'variantChanged');
  };
  // `pictureInfo`: whether this reader's scenes are illustrated, so that their menu offers the picture style, and the
  // bot's own style line (local/ui.ts `RenderDetails`).
  function prepare(state: Library, update: Update, fileInput: FileInput | undefined, pictureInfo: RenderDetails, upload?: Upload,
    poseUpload?: PoseUpload): Plan {
    let action = update.callback_query?.data;
    const t = texts(state.language);
    if (fileInput?.error) throw fileInput.error;
    if (fileInput && (state.ui?.input !== 'seed' || state.ui.draftId !== fileInput.draftId)) throw refuse(t, 'draftChanged');
    if (upload) return keptUpload(state, update, upload, t, pictureInfo);
    if (poseUpload) return queuedPoseUpload(state, update, poseUpload, t, pictureInfo);
    const text = fileInput ? fileInput.text : messageText(update.message);
    // Writing a picture style, a look, details or the prompt of a variant or of a portrait, sending a profile back, and the
    // wait for a picture, end with any button or command, an unknown command included, so that no later message is kept
    // as one by surprise (/last, /model or /typo would otherwise leave the next move to be taken for one).
    // Choosing where a look or a description lands is part of writing it (`edit-scope`, below).
    const scoping = action?.startsWith('edit-scope:') && member(['look', 'details'], state.ui?.input);
    const goingOn = action?.startsWith('from-here:') && state.ui?.input === 'move';
    if (((action && !scoping && !goingOn) || text?.startsWith('/')) && member(['style', 'look', 'details', 'prompt', 'portrait-prompt', 'reference', 'pose-set', 'profile', 'move', 'fact'], state.ui?.input)) state.ui = null;
    if (!action && !fileInput) {
      const command = text?.split(/[\s@]/)[0];
      const current = state.active;
      const commands: Record<string, string> = {
        '/start': 'view:home', '/menu': 'view:home', '/seeds': 'view:seeds:0',
        '/new': 'new-seed', '/continue': 'continue', '/retry': 'retry', '/cancel': 'cancel', '/last': 'last',
        '/context': 'view:context', '/compact': 'compact', '/model': 'view:model', '/language': 'view:language', '/style': 'view:style',
        '/gpu': 'view:model', '/gpu_pause': 'gpu:pause', '/gpu_start': 'gpu:start',
        '/checkpoints': current ? `view:checkpoints:${current.storyId}:${current.branchId}:0` : 'view:seeds:0',
      };
      // Only the listed commands: ordinary text may start with an Object.prototype name such as `constructor`.
      action = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
      if (!action && text?.startsWith('/') && state.ui?.input !== 'seed') return { screen: { text: t.notices.unknownCommand } };
    }
    if (action === 'cancel') {
      const hadJob = !!state.job;
      releaseJob(state);
      state.ui = null;
      const menu = render(state, 'home', pictureInfo);
      return { cancel: true, screen: { ...menu, text: (hadJob ? t.notices.cancelled + '\n\n' : '') + menu.text } };
    }
    // Power controls remain available during a seed draft or a model job.
    if (action === 'gpu:pause' || action === 'gpu:start') return { gpuAction: action.slice(4) };
    if (action === 'view:model') return { modelStatus: true, opened: 'model' };
    // The language can be changed at any moment, also from a draft: a user who cannot read the screen has to get out.
    if (action === 'view:language' || action?.startsWith('lang:')) {
      const draft = state.ui?.input === 'seed';
      if (!draft) state.ui = null;
      if (action === 'view:language') return { screen: render(state, 'language'), opened: 'language' };
      const lang = action.slice(5);
      if (!isRegistered(lang)) throw refuse(t, 'staleButton');
      setLanguage(state, lang);
      return { screen: render(state, draft ? 'new-seed' : 'home', pictureInfo) };
    }
    // A paste may arrive as many ordinary Telegram messages. Keep the draft
    // open until an explicit, draft-specific save; navigation must not turn
    // later fragments into instructions for a previously active story.
    if (state.ui?.input === 'seed') {
      const draft = state.ui;
      draft.draftId ??= id(state, 'd');
      draft.parts ??= [];
      if (action?.startsWith('save-seed:')) {
        if (action !== `save-seed:${draft.draftId}`) throw refuse(t, 'otherDraft');
        try {
          const seed = addSeed(state, seedInput(draft.parts.join('\n\n')));
          state.ui = null;
          return { screen: render(state, `seed:${seed.id}`) };
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          const view = render(state, 'new-seed');
          return { screen: { ...view, text: errorText(t, error) + '\n\n' + view.text } };
        }
      }
      if (!action) {
        if (!text) throw refuse(t, 'draftNeedsText');
        if (Buffer.byteLength([...draft.parts, text].join('\n\n'), 'utf8') > SEED_BYTES) throw refuse(t, 'draftTooLarge');
        draft.parts.push(text);
      }
      return { screen: render(state, 'new-seed') };
    }
    if (action?.startsWith('save-seed:')) throw refuse(t, 'draftClosed');
    if (action?.startsWith('view:')) {
      const route = action.slice(5);
      // A preset's screens stand for a person of this reader's and a preset of theirs, with references on: any other button
      // shows no question, and so leaves none to answer.
      const [, storyId, index, tag, presetId] = route.split(':');
      const shown = /^(delete-)?preset:/.test(route) && pictureInfo.references && personAt(state.stories[storyId], index, tag)
        ? linkedPreset(state, { preset: presetId }) : undefined;
      state.ui = route.startsWith('delete-seed:') ? { confirm: route.replace('delete-seed:', 'remove-seed:') }
        : route.startsWith('delete-branch:') ? { confirm: route.replace('delete-branch:', 'remove-branch:') }
        : route.startsWith('delete-fact:') ? { confirm: route.replace('delete-fact:', 'remove-fact:') }
        : route.startsWith('delete-style:') ? { confirm: route.replace('delete-style:', 'remove-style:') }
        : route.startsWith('delete-preset:') && shown && !linkedPeople(state, presetId).length ? { confirm: route.replace('delete-preset:', 'remove-preset:') } : null;
      // A preset is opened under its picture where it has one (`Plan.presetPhoto`).
      const file = route.startsWith('preset:') && shown && presetPicture(shown);
      if (file) return { presetPhoto: { file, caption: screen(state, route, pictureInfo) }, opened: 'preset' };
      return { screen: screen(state, route, pictureInfo), lasting: /^(character|profile):/.test(route), opened: route.split(':')[0] };
    }
    // A story's pace (lib/library.ts `Story.pace`). It changes at any moment, also while a scene is being written: only
    // the scene requests still to be built read it (local/prompt.ts). «Сцена» leaves the story without one.
    if (action?.startsWith('pace:')) {
      const [, storyId, pace] = action.split(':');
      const story = ID.story.test(storyId) ? state.stories[storyId] : undefined;
      if (!story || !isPace(pace)) throw refuse(t, 'staleButton');
      if (pace === 'scene') delete story.pace; else story.pace = pace;
      state.ui = null;
      return { screen: render(state, `pace:${storyId}`) };
    }
    // A bookmark on a scene (lib/library.ts `Checkpoint.bookmark`), from its checkpoint's preview, which comes
    // back as it is now, opened from a page of the bookmarks (`b<page>`) or not. Nothing a scene request reads changes, so it is kept or
    // taken away at any moment, also while a scene is being written, and the story being played stays as it is.
    if (action?.startsWith('mark:') || action?.startsWith('unmark:')) {
      const [verb, storyId, checkpointId, from] = action.split(':');
      const story = ID.story.test(storyId) ? state.stories[storyId] : undefined;
      const cp = story && ID.checkpoint.test(checkpointId) ? story.checkpoints[checkpointId] : undefined;
      if (!story || !cp?.head || !Object.hasOwn(story.nodes, cp.head) || !Object.hasOwn(story.branches, cp.branchId)
        || (from !== undefined && !/^b\d{1,4}$/.test(from))) throw refuse(t, 'staleButton');
      if (verb === 'mark') addBookmark(story, cp.id, bookmarkLabel(state, story, cp), Date.now());
      else removeBookmark(story, cp.id);
      state.ui = null;
      return { screen: render(state, `checkpoint:${storyId}:${checkpointId}${from ? `:${from}` : ''}`) };
    }
    // The picture style is the reader's own setting (local/picture-style.ts). It changes at any moment, also while a
    // scene is being written, and only the pictures still to come follow it.
    const standardStyle = pictureInfo.standardStyle ?? STYLE;
    if (action?.startsWith('style:')) {
      const key = action.slice(6);
      if (lineOf(state, key, standardStyle) === null) throw refuse(t, 'staleButton');
      if (key === 'standard') delete state.pictureStyle; else state.pictureStyle = key;
      state.ui = null;
      return { screen: render(state, `style:${styleKey(state, standardStyle)}`, pictureInfo) };
    }
    if (action === 'style-new') {
      if (ownStyles(state).length >= OWN_STYLES_MAX) throw refuse(t, 'stylesFull');
      state.ui = { input: 'style' };
      return { screen: render(state, 'style-input', pictureInfo) };
    }
    if (action?.startsWith('style-edit:')) {
      const own = ownStyle(state, action.slice(11));
      if (!own) throw refuse(t, 'staleButton');
      state.ui = { input: 'style', styleId: own.id };
      return { screen: render(state, 'style-input', pictureInfo) };
    }
    if (action?.startsWith('remove-style:')) {
      if (state.ui?.confirm !== action) throw refuse(t, 'staleConfirmation');
      const key = action.slice(13);
      if (!ownStyle(state, key)) throw refuse(t, 'staleButton');
      const kept = { ...state.pictureStyles };
      delete kept[key];
      state.pictureStyles = kept;
      if (state.pictureStyle === key) delete state.pictureStyle;
      state.ui = null;
      return { screen: render(state, 'style', pictureInfo) };
    }
    // A sample is the reader's last scene drawn once more in the style they are looking at, or in every style of the
    // picker, on request only.
    if (action?.startsWith('style-sample:') || action === 'style-samples') {
      const all = action === 'style-samples';
      const styles = (all ? pickerKeys(state, standardStyle) : [action.slice(13)]).flatMap(key => {
        const line = lineOf(state, key, standardStyle);
        return line === null ? [] : [{ line, pictureStyle: choiceOf(key), caption: render(state, `sample:${key}`, pictureInfo) }];
      });
      if (!styles.length) throw refuse(t, 'staleButton');
      if (!pictureInfo.pictures) throw refuse(t, 'sampleOff');
      if (state.job) throw refuse(t, 'sampleBusy');
      const where = state.active;
      const nodeId = where ? state.stories[where.storyId]?.branches[where.branchId]?.head : null;
      if (!where || !nodeId) throw refuse(t, 'sampleNoScene');
      return { sample: { storyId: where.storyId, branchId: where.branchId, nodeId, styles,
        status: all ? t.pictureStyle.drawingAll(styles.length) : t.pictureStyle.drawingSample } };
    }
    // While a style is being written, text is the style, never a move in the story; buttons and commands leave. The
    // first line of a message of several is the style's name.
    if (state.ui?.input === 'style' && !action) {
      const sent = ownStyleInput(text ?? '');
      if (!sent) throw refuse(t, 'styleNeedsText');
      if ([...sent.line].length > OWN_STYLE_CHARS) throw refuse(t, 'styleTooLong');
      const editing = state.ui.styleId === undefined ? undefined : ownStyle(state, state.ui.styleId);
      if (state.ui.styleId !== undefined && !editing) { state.ui = null; throw refuse(t, 'staleButton'); }
      if (!editing && ownStyles(state).length >= OWN_STYLES_MAX) { state.ui = null; throw refuse(t, 'stylesFull'); }
      const styleId = editing?.id ?? id(state, 'y');
      state.pictureStyles = { ...state.pictureStyles,
        [styleId]: { id: styleId, name: styleName(sent.name ?? editing?.name ?? sent.line), line: sent.line } };
      if (!editing) state.pictureStyle = styleId;
      state.ui = null;
      return { screen: render(state, `style:${styleId}`, pictureInfo) };
    }
    // A variant of a scene's picture: the button under its prompt waits for a prompt, and the next text message is
    // that prompt, drawn as it came. The wait keeps the scene alone, never the prompt. As with a sample, the picture
    // of a scene being written goes first: no prompt is asked for while it is, and the one that arrives is refused if
    // a scene is being written by then.
    if (action?.startsWith('prompt-edit:')) {
      const [storyId = '', nodeId = ''] = action.slice(12).split(':');
      variantTarget(state, storyId, nodeId, t, pictureInfo);
      if (state.job) throw refuse(t, 'variantBusy');
      state.ui = { input: 'prompt', storyId, nodeId };
      return { screen: render(state, 'prompt-input', pictureInfo) };
    }
    if (state.ui?.input === 'prompt' && !action) {
      const { storyId, nodeId } = state.ui;
      state.ui = null;
      variantTarget(state, storyId, nodeId, t, pictureInfo);
      if (state.job) throw refuse(t, 'variantBusy');
      // A prompt that cannot be drawn leaves the wait open for the next try.
      const again = (key: 'promptNeedsText' | 'promptTooLong') => { state.ui = { input: 'prompt', storyId, nodeId }; return refuse(t, key); };
      if (!text?.trim()) throw again('promptNeedsText');
      if ([...text].length > PROMPT_CHARS) throw again('promptTooLong');
      return { variant: { storyId, nodeId, prompt: text } };
    }
    // The people of a story's sheet (local/ui.ts, the characters' screens), by the story, their place on it and the
    // hash of their name: a button of somebody whose place another person took since is refused (`personAt`). A look
    // and details are written the way a style is, and a portrait is drawn on request only, for a reader who is drawn for.
    if (action?.startsWith('look-edit:') || action?.startsWith('details-edit:') || action?.startsWith('portrait:')
      || action?.startsWith('pov:') || action?.startsWith('pov-off:') || action?.startsWith('portrait-default:')) {
      const [verb, storyId, index, tag, asked] = action.split(':');
      const person = ID.story.test(storyId) ? personAt(linkedStory(state, state.stories[storyId]), index, tag) : undefined;
      if (!person) throw refuse(t, 'staleButton');
      // The frames of the story seen through this person's eyes, or as usual again (local/picture-pov.ts). A story has
      // one such person at most, so choosing another switches; the way back ends it only while it is this person's.
      if (verb === 'pov' || verb === 'pov-off') {
        const story = state.stories[storyId];
        if (verb === 'pov') story.pov = person.name;
        else if (seesThrough(story, person.name)) delete story.pov;
        return { screen: render(state, `character:${storyId}:${index}:${tag}`, pictureInfo), lasting: true };
      }
      if (verb === 'look-edit' || verb === 'details-edit') {
        const input = verb === 'look-edit' ? 'look' : 'details';
        state.ui = { input, storyId, name: person.name };
        return { screen: render(state, `${input}-input`, pictureInfo) };
      }
      // These buttons name the preset their screen showed, if any, as the question of `pose-set-dropped:` does.
      if ((verb === 'portrait' || verb === 'portrait-default') && asked !== person.preset) throw refuse(t, 'staleButton');
      // The prompt the reader wrote for this person's portraits goes, and the bot's own is theirs again.
      if (verb === 'portrait-default') {
        delete appearanceOf(state, state.stories[storyId].sheet![person.index]).portraitPrompt;
        return { screen: render(state, `character:${storyId}:${index}:${tag}`, pictureInfo), lasting: true };
      }
      if (!pictureInfo.pictures) throw refuse(t, 'portraitOff');
      // A portrait is drawn from the prompt the reader wrote for the person, if they did. Otherwise a person of a sheet
      // not yet retold has no text to be drawn from, and a portrait of nobody in particular would spend the picture card
      // for nothing.
      const prompt = ownPortraitPrompt(person);
      if (prompt === undefined && !portraitText(personHere(state, storyId, person.index) ?? person).trim()) throw refuse(t, 'portraitPending');
      // Names the portrait for its keep button, so that a button of an earlier one never keeps this one.
      const candidate = randomBytes(4).toString('hex');
      return { portrait: { storyId, name: person.name, candidate, status: t.characters.drawing, ...prompt === undefined ? {} : { prompt },
        caption: render(state, `portrait:${storyId}:${index}:${tag}:${candidate}`, pictureInfo) } };
    }
    // A person's whole profile, from the button under it (local/profile.ts): the next text message is that profile sent
    // back (`profileSent`). The button names the person as the card's do, the fields its message showed and a hash of
    // their text, which must still be the person's: the button of a profile that has changed since, of a sheet the next
    // picture writes anew, or of a person whose look has changed along the branch since (local/profile.ts `versioned`),
    // shows the profile as it is now instead, and waits for nothing.
    if (action?.startsWith('profile-edit:')) {
      const [, storyId, index, tag, mask, hash] = action.split(':');
      const story = ID.story.test(storyId) ? state.stories[storyId] : undefined;
      const person = personAt(story, index, tag);
      const fields = maskFields(mask);
      if (!story || !person || !fields || !/^[0-9a-f]{8}$/.test(hash ?? '')) throw refuse(t, 'staleButton');
      const profile = profileOf(state, story, person);
      // Apart: the wait asks for the block of the profile above it, and a profile changed since says it was sent above.
      if (profile.older || profile.versioned || profileHash(person.name, profile, fields) !== hash) return { screen: render(state, `profile-changed:${storyId}:${index}:${tag}`, pictureInfo), lasting: true };
      state.ui = { input: 'profile', storyId, name: person.name, fields: mask, hash };
      return { screen: render(state, 'profile-input', pictureInfo), apart: true };
    }
    if (state.ui?.input === 'profile' && !action) return profileSent(state, state.ui, text, t, pictureInfo);
    // The whole prompt of a person's portraits, from the note under one of them (local/picture.ts `portrait`), as a
    // scene's picture has its variant: the button waits for it, and the next text message is that prompt, which the
    // person keeps as theirs (`portraitPrompt`) and a variant of the portrait whose note it was is drawn from, as it
    // came, with that portrait's seed. The button names the person as the card's do, the seed, and a tag of the graph
    // and the checkpoint it was drawn with, which must still be the bot's, when it is pressed and when the prompt
    // arrives. A prompt that cannot be drawn leaves the wait open for the next try, as a variant's does, and so does one
    // that arrives while another portrait or a sample is being drawn (`sampling`): the variant could not be drawn then,
    // and the prompt is not kept without it, where it would have been the person's for the next portrait unseen.
    if (action?.startsWith('portrait-edit:')) {
      const [, storyId, index, tag, seed, recipe, asked] = action.split(':');
      if (!pictureInfo.pictures || !illustrator) throw refuse(t, 'portraitOff');
      const person = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!person || asked !== person.preset || !/^\d{1,10}$/.test(seed ?? '') || Number(seed) >= 2 ** 32 || !/^[0-9a-f]{8}$/.test(recipe ?? '')) throw refuse(t, 'staleButton');
      if (!illustrator.portraitVariant(recipe)) throw refuse(t, 'variantChanged');
      state.ui = { input: 'portrait-prompt', storyId, name: person.name, seed: Number(seed), recipe };
      return { screen: render(state, 'portrait-prompt-input', pictureInfo) };
    }
    if (state.ui?.input === 'portrait-prompt' && !action) {
      const wait = state.ui;
      state.ui = null;
      if (!pictureInfo.pictures || !illustrator) throw refuse(t, 'portraitOff');
      if (!illustrator.portraitVariant(wait.recipe)) throw refuse(t, 'variantChanged');
      const again = (key: 'promptNeedsText' | 'promptTooLong' | 'portraitPromptInFlight') => { state.ui = wait; return refuse(t, key); };
      if (!text?.trim()) throw again('promptNeedsText');
      if ([...text].length > PROMPT_CHARS) throw again('promptTooLong');
      const sheet = state.stories[wait.storyId]?.sheet ?? [];
      const index = sheet.findIndex(one => one.name === wait.name);
      if (index < 0) throw refuse(t, 'portraitPromptGone');
      if (sampling.has(String(update.message?.from?.id))) throw again('portraitPromptInFlight');
      appearanceOf(state, sheet[index]).portraitPrompt = text;
      const candidate = randomBytes(4).toString('hex');
      return { portrait: { storyId: wait.storyId, name: wait.name, candidate, status: t.characters.drawing, prompt: text, seed: wait.seed,
        caption: render(state, `portrait:${wait.storyId}:${index}:${personTag(wait.name)}:${candidate}`, pictureInfo) } };
    }
    if (action?.startsWith('portrait-keep:')) {
      if (!pictureInfo.pictures || !illustrator) throw refuse(t, 'portraitOff');
      const kept = illustrator.keepPortrait(String(update.callback_query?.from?.id), action.slice(14), state);
      if (!kept) throw refuse(t, 'portraitStale');
      return { screen: render(state, `portrait-kept:${kept.storyId}:${kept.index}`, { retainsPortraits: kept.retainsPortraits }), done: true,
        sweep: true, portraitKept: action.slice(14) };
    }
    // A picture of a person of the reader's own for a pose, the front being their portrait (local/reference.ts): the
    // button waits for it, as for a look, and the next photo or file is read before the write that keeps it
    // (`readUpload`, `keptUpload`).
    if (action?.startsWith('ref-send:')) {
      if (!pictureInfo.references) throw refuse(t, 'referencesOff');
      const [, storyId, index, tag, pose] = action.split(':');
      const person = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!person || !isPose(pose)) throw refuse(t, 'staleButton');
      state.ui = { input: 'reference', storyId, name: person.name, pose, at: Date.now() };
      return { screen: render(state, 'reference-input', pictureInfo) };
    }
    // While a picture is awaited, text is no move in the story either; a button or a command leaves (above).
    if (state.ui?.input === 'reference' && !action) throw refuse(t, 'referenceNeedsPicture');
    // A person's pictures by the dozen, for frames to choose from by pose (local/pose-set.ts): the button waits for them,
    // and every photo or file that comes goes into the reader's queue, to be read apart from the updates
    // (`queuedPoseUpload`, `uploadNext`), until «✅ Готово», any other button or a command. One message counts them as
    // they are read.
    if (action?.startsWith('pose-set:')) {
      if (!pictureInfo.poseSet) throw refuse(t, 'poseSetOff');
      const [, storyId, index, tag] = action.split(':');
      const person = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!person) throw refuse(t, 'staleButton');
      state.ui = { input: 'pose-set', storyId, name: person.name, at: Date.now(), ...person.preset ? { preset: person.preset } : {} };
      return { screen: render(state, 'pose-set-input', pictureInfo) };
    }
    if (state.ui?.input === 'pose-set' && !action) throw refuse(t, 'poseSetNeedsPictures');
    // The wait ended above, as by any button: the message that counted the pictures gets its last word once the files sent
    // in it are read (`closing`), and the person's card shows how they were sorted.
    if (action?.startsWith('pose-set-done:')) {
      const [, storyId, index, tag] = action.split(':');
      return { screen: render(state, `character:${storyId}:${index}:${tag}`, pictureInfo), lasting: true };
    }
    // Every picture of a person's set goes at once, after the reader says so; a frame's recipe keeps the files it drew
    // with while a variant may need them (local/store.ts). Offered for a set whatever the switch says now, so that
    // nobody is left with pictures they cannot remove. The question names the preset it asked about, if any: a link, an
    // unlink or a save since then has put another set behind this person, and the answer does not reach that one.
    if (action?.startsWith('pose-set-drop:') || action?.startsWith('pose-set-dropped:')) {
      const [kind, storyId, index, tag, asked] = action.split(':');
      const person = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!person) throw refuse(t, 'staleButton');
      const sheetPerson = state.stories[storyId].sheet![person.index];
      if (kind === 'pose-set-dropped' && asked !== sheetPerson.preset) throw refuse(t, 'staleButton');
      const shared = appearanceOf(state, sheetPerson);
      const dropped = shared.poseSet?.length ?? 0;
      // Files of the set still in the reader's queue go with it, unread: those of the person as a sheet written again
      // spells them (`personKey`), or those of the preset, from whichever story they came.
      const theirs = (one: PendingPoseUpload) => sheetPerson.preset ? one.preset === sheetPerson.preset
        : one.preset === undefined && one.storyId === storyId && personKey(one.name) === personKey(sheetPerson.name);
      if (kind === 'pose-set-dropped' && state.poseUploads?.some(theirs)) {
        const rest = state.poseUploads.filter(one => !theirs(one));
        if (rest.length) state.poseUploads = rest; else delete state.poseUploads;
      }
      // The question first; a set already gone shows the card.
      if (kind === 'pose-set-drop' || !dropped) return { screen: render(state, `pose-set-drop:${storyId}:${index}:${tag}`, pictureInfo), lasting: !dropped };
      delete shared.poseSet;
      return { screen: render(state, `character:${storyId}:${index}:${tag}`, pictureInfo), lasting: true, sweep: true,
        logged: { event: 'pose_set_dropped', details: { poseSetCount: dropped } } };
    }
    // A preset of a person (docs/telegram-ui.md#presets), from their card: their appearance saved once, for people of any
    // story to link to. The buttons name the person as the card's do; the preset is looked for in this reader's library
    // alone, so a button made up for another reader's reaches nothing. Saving moves the pictures in this one write, copies
    // the description and leaves the person as they read, so nothing is retold; a person with no description is not
    // saved, since everybody linked is retold from it. A link is retold from the preset's description, and an unlink from
    // the person's own, each as a description written on the card is (`retold`). Saving and linking are for a reader
    // of the reference experiment. Unlinking is there whatever the switch says now, so that nobody is left linked. None of
    // them happens while a picture of the reader's is on its way (`relinkable`), nor does deleting a preset.
    if (action?.startsWith('preset-save:') || action?.startsWith('preset-link:') || action?.startsWith('preset-unlink:')) {
      const [verb, storyId, index, tag, presetId] = action.split(':');
      const found = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!found) throw refuse(t, 'staleButton');
      if (illustrator && !illustrator.relinkable(String(update.callback_query?.from?.id))) throw refuse(t, 'presetBusy');
      const person = state.stories[storyId].sheet![found.index];
      if (verb === 'preset-unlink') {
        if (!person.preset) throw refuse(t, 'staleButton');
        const presetPeople = linkedPeople(state, person.preset).length - 1;
        unlinkPreset(person);
        return { retell: { storyId, name: person.name }, logged: { event: 'preset_unlinked', details: { presetPeople } } };
      }
      if (!pictureInfo.references) throw refuse(t, 'referencesOff');
      if (verb === 'preset-save') {
        if (person.preset) throw refuse(t, 'staleButton');
        if (!descriptionOf(person).trim()) throw refuse(t, 'presetNeedsText');
        const queued = (one: PendingPoseUpload) => one.preset === undefined && one.storyId === storyId && personKey(one.name) === personKey(person.name);
        const presetPictures = referenceFiles(person).length;
        const saved = savePreset(state, person, person.name.trim(), Date.now());
        // The set moved, and the files still on their way to it follow.
        for (const one of state.poseUploads ?? []) if (queued(one)) one.preset = saved;
        return { screen: render(state, `character:${storyId}:${index}:${tag}`, pictureInfo), lasting: true,
          logged: { event: 'preset_saved', details: { presetPictures } } };
      }
      if (!ID.preset.test(presetId ?? '') || !linkedPreset(state, { preset: presetId })) throw refuse(t, 'staleButton');
      linkPreset(person, presetId);
      return { retell: { storyId, name: person.name }, logged: { event: 'preset_linked', details: { presetPeople: linkedPeople(state, presetId).length } } };
    }
    // A preset goes only with nobody linked to it, and after a question (`view:delete-preset:`). Linked meanwhile, it stays
    // and the question says why. Its files go with the sweep, those a frame's recipe needs apart.
    if (action?.startsWith('remove-preset:')) {
      if (state.ui?.confirm !== action || !pictureInfo.references) throw refuse(t, 'staleButton');
      if (illustrator && !illustrator.relinkable(String(update.callback_query?.from?.id))) throw refuse(t, 'presetBusy');
      const [, storyId, index, tag, presetId, page] = action.split(':');
      const preset = linkedPreset(state, { preset: presetId });
      if (!preset || !state.characterPresets) throw refuse(t, 'staleButton');
      state.ui = null;
      if (linkedPeople(state, presetId).length) return { screen: render(state, `delete-preset:${storyId}:${index}:${tag}:${presetId}:${page}`, pictureInfo) };
      const presetPictures = referenceFiles(preset).length;
      delete state.characterPresets[presetId];
      if (!Object.keys(state.characterPresets).length) delete state.characterPresets;
      return { screen: render(state, `presets:${storyId}:${index}:${tag}:${page}`, pictureInfo), sweep: true,
        logged: { event: 'preset_deleted', details: { presetPictures } } };
    }
    // Where the look or the description being written lands, for a reader who has versions of the sheet
    // (local/picture-versions.ts): the whole story, as always, or «only from this moment», the scene the reader stands at
    // now, kept in the wait. It is chosen on the wait itself, before the text is sent, so that the text is taken as it
    // comes, in one message as ever, and the bot never holds it while asking. A scene another line goes on from, or
    // another branch stands at, is not offered (`editableFrom`).
    if (action === 'edit-scope:here' || action === 'edit-scope:all') {
      const wait = state.ui?.input === 'look' || state.ui?.input === 'details' ? state.ui : undefined;
      if (!wait || !pictureInfo.versions) throw refuse(t, 'staleButton');
      const { from, ...whole } = wait;
      const at = editableFrom(state, wait.storyId);
      if (action === 'edit-scope:here' && (!at || at.shared)) throw refuse(t, 'staleButton');
      state.ui = action === 'edit-scope:here' && at ? { ...whole, from: at.scene } : whole;
      return { screen: render(state, `${wait.input}-input`, pictureInfo) };
    }
    // While a look or a description is being written, text is that text. A look is one line, whatever the lines it was
    // sent in; a description keeps its lines, since a table of measurements is lines (the owner, 2026-09-27), with the
    // spaces at their ends and the blank lines past one cut. The person is looked for again by name, since the story
    // may be gone or its sheet written anew in the meantime.
    if ((state.ui?.input === 'look' || state.ui?.input === 'details') && !action) {
      const { input, storyId, name, from } = state.ui;
      const look = input === 'look';
      const written = look ? (text ?? '').replace(/\s+/g, ' ').trim()
        : (text ?? '').replace(/\r\n?/g, '\n').split('\n').map(one => one.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!written) throw refuse(t, look ? 'lookNeedsText' : 'detailsNeedsText');
      if ([...written].length > (look ? LOOK_CHARS : DESCRIPTION_CHARS)) throw refuse(t, look ? 'lookTooLong' : 'detailsTooLong');
      const story = state.stories[storyId];
      const index = story?.sheet?.findIndex(one => one.name === name) ?? -1;
      // «Only from this moment» needs the reader's versions still, and the scene it was chosen at. Without them the text
      // is refused before the wait ends, since a refusal commits what came before it (`store.mutate` below): the wait
      // stays, as for an empty text, so the next text is not taken for a move either, and a button or a command, /menu
      // as the refusal says, leaves it.
      if (from !== undefined && story && index >= 0 && (!pictureInfo.versions || !Object.hasOwn(story.nodes, from))) throw refuse(t, 'staleButton');
      state.ui = null;
      if (!story || index < 0) throw refuse(t, look ? 'lookGone' : 'detailsGone');
      // The owner's design of 2026-09-27 (docs/illustrations-plan.md#three-layers): the description is the person's
      // text, which wins over the one the sheet took from the story, and the details a portrait is drawn from and the
      // look the frames take are retold from it (local/picture.ts `retell`). A look the reader writes overrides that one
      // in the frames alone, and details still to be retold stay so; a description replaces the reader's look as well,
      // and both are retold from it once this write is committed. Until then a portrait is drawn from the details retold
      // before, while details the reader wrote before that day, which no retelling ever read, go. Where it lands, the
      // whole story or a version from the scene `from` on, is local/picture-versions.ts `landEdit`'s to say.
      const landed = landEdit(state, story, name, look ? { look: written } : { description: written }, from);
      if (!landed) throw refuse(t, look ? 'lookGone' : 'detailsGone');
      const versionField = look ? 'look' : 'description';
      const logged = from !== undefined
        ? { event: 'sheet_version_written', details: { versionSource: 'reader', versionField, versionPeople: 1, storyVersions: countVersions(story) } } as const
        : landed.cleared ? { event: 'sheet_versions_cleared', details: { versionField, versionsCleared: landed.cleared, storyVersions: countVersions(story) } } as const
        : undefined;
      if (look) return { screen: render(state, `character:${storyId}:${index}:${personTag(name)}`, pictureInfo), lasting: true, ...logged ? { logged } : {} };
      return { retell: { storyId, name }, ...logged ? { logged } : {} };
    }
    // A fact of a branch's memory the reader rewrites (lib/library.ts `editFact`). A refusal leaves the wait for the next
    // try, as for a look; a fact gone meanwhile ends it. The text itself reaches no log row.
    if (state.ui?.input === 'fact' && !action) {
      const { storyId, branchId, version, index } = state.ui;
      if (!text) throw refuse(t, 'factNeedsText');
      if (text.length > FACT_CHARS) throw refuse(t, 'factTooLong');
      state.ui = null;
      return factEdited(state, t, storyId, branchId, version, index, text);
    }
    if (action === 'last') return { savedText: last(state) };
    // A branch as a text file only reads it, so it goes out at any moment, also while a scene is being written.
    if (action?.startsWith('export:')) {
      const [, storyId = '', branchId = ''] = action.split(':');
      const story = ID.story.test(storyId) ? state.stories[storyId] : undefined;
      if (!(ID.branch.test(branchId) && story?.branches[branchId]?.head)) throw refuse(t, 'staleButton');
      return { exportBranch: { storyId, branchId } };
    }
    if (action === 'new-seed') {
      if (state.job) throw refuse(t, 'busyNewSeed');
      state.ui = { input: 'seed', draftId: id(state, 'd'), parts: [] };
      return { screen: render(state, 'new-seed') };
    }
    if (state.job) throw refuse(t, 'busy');
    if (action === 'compact') {
      const { story, branch } = active(state);
      if (context(story, branch).recent.length <= keepScenes) {
        return { screen: { text: t.notices.nothingToCompact(keepScenes) } };
      }
      requireGpu(t);
      state.ui = null;
      const job = beginJob(state, continueInput(state, story.id), Date.now());
      job.kind = 'compact';
      return { job };
    }
    const [verb, a, b] = (action || '').split(':');
    // Button data comes from the client, and these actions use its IDs as library keys. A value that is not an ID of
    // the expected kind, such as `constructor`, could reach Object.prototype, so the button is stale; so is a missing ID.
    const validIds = verb === 'start' || verb === 'remove-seed' ? ID.seed.test(a)
      : verb === 'use' || verb === 'remove-branch' ? ID.story.test(a) && ID.branch.test(b)
      : verb === 'fork' ? ID.story.test(a) && ID.checkpoint.test(b)
      : verb === 'again' ? ID.story.test(a) && ID.node.test(b) : true;
    if (!validIds) throw refuse(t, 'staleButton');
    if (verb === 'fact-edit' || verb === 'remove-fact') {
      const [storyId = '', branchId = '', version = '', index = ''] = action!.split(':').slice(1);
      const story = ID.story.test(storyId) ? state.stories[storyId] : undefined;
      const branch = story && ID.branch.test(branchId) ? story.branches[branchId] : undefined;
      if (!story || !branch || !ID.memory.test(version) || !ID.place.test(index)) throw refuse(t, 'staleButton');
      if (verb === 'remove-fact') {
        if (state.ui?.confirm !== action) throw refuse(t, 'staleConfirmation');
        state.ui = null;
        return factEdited(state, t, storyId, branchId, version, Number(index), null);
      }
      if (!factsOf(story, branch).some(one => one.version === version && one.index === Number(index))) throw refuse(t, 'factChanged');
      state.ui = { input: 'fact', storyId, branchId, version, index: Number(index) };
      return { screen: render(state, 'fact-input') };
    }
    if (verb === 'remove-seed' || verb === 'remove-branch') {
      if (state.ui?.confirm !== action) throw refuse(t, 'staleConfirmation');
      if (verb === 'remove-seed') deleteSeed(state, a);
      else deleteBranch(state, a, b);
      // The pictures of the scenes that went leave the chat too. A branch takes only the scenes that no other branch
      // or checkpoint reaches (`deleteBranch`), so the picture of a scene another branch still has stays with it.
      return { screen: render(state, 'seeds:0'), lostPictures: forgetLostPictures(state, Date.now()), sweep: true };
    }
    if (verb === 'use') {
      const story = state.stories[a];
      if (!story?.branches[b]) throw refuse(t, 'branchGoneOpenSeeds');
      state.active = { storyId: a, branchId: b };
      state.ui = null;
      return { savedText: last(state), screen: render(state, `branch:${a}:${b}`), logged: { event: 'branch_switched', details: {} } };
    }
    if (verb === 'fork') {
      const branch = fork(state, a, b, t.labels);
      state.ui = null;
      return { savedText: last(state), screen: render(state, `branch:${a}:${branch.id}`), logged: { event: 'branch_forked', details: {} } };
    }
    let input = text;
    // A lost move runs only here, on the reader's own press, and only where it was lost (lib/library.ts `LostMove`).
    const lost = verb === 'retry' ? lostMove(state) : undefined;
    let from = lost?.from;
    let narrator = verb === 'start' || action === 'continue' || !!lost?.move;
    if (verb === 'start') {
      requireGpu(t);
      const { story } = newStory(state, a, t.labels);
      // Sent to the model and kept as the scene's input, so it follows the language of the seed, not of the menus.
      input = storyNarration(state, story.id).startStory;
    } else if (action === 'continue') input = continueInput(state, active(state).story.id);
    else if (verb === 'retry') {
      if (!lost || (from && !pointStands(state.stories[from.storyId], from))) throw refuse(t, 'nothingToRetry');
      // /retry is the move lost here; a button, the move it came with.
      if (a !== undefined && a !== lost.job) throw refuse(t, 'staleButton');
      input = lost.input;
    } else if (verb === 'again') {
      // Another version of the last scene: its move again from the point before it, and only of the scene the button
      // came with, for a button that outlived its scene not to rewrite a newer one.
      const { story, branch } = active(state);
      const node = story.id === a && branch.head === b ? story.nodes[b] : undefined;
      if (!node) throw refuse(t, 'staleButton');
      input = node.input;
      narrator = narratorsMove(state, story.id, node);
      const scenes = history(story, node.parent).length;
      from = { storyId: story.id, ...pointBefore(story, branch, node), name: t.labels.forkBranch(scenes ? t.labels.scene(scenes) : t.labels.seedCheckpoint) };
    } else if (verb === 'from-here') {
      const wait = state.ui?.input === 'move' && state.ui.checkpointId === a && String(state.ui.asked) === b ? state.ui : undefined;
      const cp = wait && state.stories[wait.storyId]?.checkpoints[wait.checkpointId];
      if (!wait || !cp) throw refuse(t, 'staleButton');
      input = wait.move;
      from = { storyId: wait.storyId, head: cp.head, memory: cp.memory, name: t.labels.forkBranch(cp.label) };
    } else if (action) throw refuse(t, 'staleButton');
    if (!input) return { screen: { text: t.notices.textOnly } };
    if (!state.active) return { screen: render(state, 'home', pictureInfo) };
    if (!action) {
      const route = replied(state, update.message?.reply_to_message?.message_id, input, update.update_id);
      if (route) return { screen: render(state, route, pictureInfo), logged: { event: 'scene_replied_to', details: {} } };
    }
    requireGpu(t);
    state.ui = null;
    const job = from ? beginSideJob(state, from.storyId, from, from.name, input, Date.now(), t.labels) : beginTurn(state, input, Date.now());
    delete state.lostMove;
    delete state.jobInterrupted;
    // The reader wrote nothing, so the move is the narrator's; a story with a pace tells it so (local/prompt.ts).
    if (narrator) job.move = 'narrator';
    const event = verb === 'retry' ? 'move_repeated' : verb === 'again' ? 'scene_again' : verb === 'from-here' ? 'move_from_scene' : undefined;
    return { job, ...event ? { logged: { event, details: {} } } : {} };
  }

  // Rewrites a fact of a branch's memory or takes it out, and shows the list at the place the fact held.
  function factEdited(state: Library, t: Messages, storyId: string, branchId: string, version: string, index: number, text: string | null): Plan {
    const story = state.stories[storyId];
    const branch = story?.branches[branchId];
    const place = branch ? factsOf(story, branch).findIndex(one => one.version === version && one.index === index) : -1;
    if (place < 0 || !editFact(state, story, branch, version, index, text, t.labels.memoryEdited)) throw refuse(t, 'factChanged');
    const view = render(state, `memory:${storyId}:${branchId}:${Math.floor(place / PAGE)}`);
    return { screen: { ...view, text: `${text === null ? t.memory.removed : t.memory.saved}\n\n${view.text}` },
      logged: { event: text === null ? 'memory_fact_removed' : 'memory_fact_edited', details: { factCount: factsOf(story, branch).length } } };
  }

  // A reply to a scene other than the last one of the branch being played: nothing runs and nothing forks by itself, the
  // screen of that scene asks (`MoveInput`). A reply to the last scene, to a message that shows no scene, or to one of a
  // scene with no checkpoint left to go on from is a move like any other. Returns the route of that screen.
  function replied(state: Library, messageId: number | undefined, move: string, asked: number) {
    if (messageId === undefined) return undefined;
    const lastScene = state.stories[state.active!.storyId]?.branches[state.active!.branchId]?.head;
    for (const story of Object.values(state.stories)) {
      const node = Object.values(story.nodes).find(one => one.messageId === messageId || one.shownAs?.includes(messageId));
      if (!node) continue;
      const here = Object.values(story.checkpoints).filter(cp => cp.head === node.id && Object.hasOwn(story.branches, cp.branchId));
      const cp = here.find(one => one.kind === 'scene') ?? here[0];
      if (node.id === lastScene || !cp) return undefined;
      state.ui = { input: 'move', storyId: story.id, checkpointId: cp.id, move, asked };
      return `checkpoint:${story.id}:${cp.id}`;
    }
    return undefined;
  }

  // A profile sent back while one is awaited (`profile-edit`), inside the library write. It is taken whole or not at all:
  // it has to read (local/profile.ts `parseProfile`), with the person's name and the fields its message showed, and
  // each field it changed has to be within its limit and not emptied, where the field may not be; anything else is
  // refused with what to fix, and the wait stays for the next try. A person gone meanwhile, or a profile that has
  // changed since its message was sent, ends the wait: the second is shown as it is now, since the fields sent back
  // unchanged would otherwise write what it said then over what it says now. Only the fields whose text differs by more
  // than its spaces and line breaks (`changedFields`) are written (`applyProfile`), and the person is retold where that
  // says so. One row says which fields changed, with their sizes and the whole text's, or why the text was refused;
  // never a word of it.
  function profileSent(state: Library, wait: ProfileInput, text: string | undefined, t: Messages, pictureInfo: RenderDetails): Plan {
    const c = t.characters;
    const characters = [...text ?? ''].length;
    const refused = (screen: Screen, profileRefusal: NonNullable<ErrorDetails['profileRefusal']>): Plan =>
      ({ screen, logged: { event: 'profile_refused', details: { profileRefusal, profileCharacters: characters } } });
    const story = state.stories[wait.storyId];
    const index = story?.sheet?.findIndex(one => one.name === wait.name) ?? -1;
    const fields = maskFields(wait.fields);
    if (!story || index < 0 || !fields) {
      state.ui = null;
      return refused({ text: t.errors.profileGone }, 'gone');
    }
    const person = story.sheet![index];
    const profile = profileOf(state, story, person);
    if (profile.older || profile.versioned || profileHash(person.name, profile, fields) !== wait.hash) {
      state.ui = null;
      return { ...refused(render(state, `profile-changed:${story.id}:${index}:${personTag(person.name)}`, pictureInfo), 'changed'), lasting: true };
    }
    if (!text?.trim()) return refused({ text: t.errors.profileNeedsText }, 'no_text');
    const parsed = parseProfile(text, person.name, fields);
    if (parsed.refusal) {
      return refused({ text: parsed.refusal === 'name' ? c.profileName(person.name.replace(/\s+/g, ' ').trim())
        : parsed.refusal === 'heading' ? c.profileHeading(parsed.heading ?? '')
        : t.errors[parsed.refusal === 'incomplete' ? 'profileIncomplete' : parsed.refusal === 'sections' ? 'profileSections' : 'profileOutside'] },
      parsed.refusal);
    }
    const changed = changedFields(profile, parsed.values, fields);
    for (const [field, value] of Object.entries(changed) as [ProfileField, string][]) {
      if (!value && !MAY_BE_EMPTY.includes(field)) return refused({ text: c.profileEmpty(c.profileHeadings[field]) }, 'empty');
      const limit = field === 'clothes' && pictureInfo.wear ? WORN_CLOTHES_CHARS : PROFILE_CHARS[field];
      if ([...value].length > limit) return refused({ text: c.profileLong(c.profileHeadings[field], limit) }, 'too_long');
    }
    state.ui = null;
    const retell = applyProfile(state, story, index, profile, changed);
    const has = (field: ProfileField) => changed[field] !== undefined;
    const size = (field: ProfileField) => has(field) ? [...changed[field]!].length : undefined;
    return { screen: render(state, `profile-saved:${story.id}:${index}:${personTag(person.name)}:${fieldsMask(Object.keys(changed) as ProfileField[])}`, pictureInfo), done: true,
      ...retell ? { retell: { storyId: story.id, name: person.name } } : {},
      logged: { event: 'profile_edited', details: { outcome: Object.keys(changed).length ? 'ready' : 'skipped',
        profileFit: !fields.includes('description') ? 'no_description' : profile.present.length > fields.length ? 'no_prompt' : 'whole',
        profileDescription: has('description'), profileChanges: has('changes'), profileDetails: has('details'), profileLook: has('look'),
        profileClothes: has('clothes'), profilePrompt: has('prompt'), profileRetell: retell,
        ...has('clothes') ? { profileClothesAt: profile.clothesAt === null ? 'sheet' : 'scene' } : {}, profileCharacters: characters,
        descriptionCharacters: size('description'), changesCharacters: size('changes'), detailsCharacters: size('details'),
        lookCharacters: size('look'), clothesCharacters: size('clothes'), promptCharacters: size('prompt') } } };
  }

  // Reads a picture a reader sent while the bot waited for one (local/reference.ts), before the library write, as a seed
  // file is read. Nothing is downloaded for a reader without access to references or past the wait's half hour: the
  // write says which. A refusal is logged by its reason alone.
  async function readUpload(userId: string, wait: ReferenceInput, message: NonNullable<Update['message']>, t: Messages): Promise<Upload> {
    if (!illustrator?.referencesFor(userId) || Date.now() - wait.at > REFERENCE_WAIT_MS) return { wait };
    try {
      if (!readPicture) throw new Error('picture_reader_unavailable');
      return { wait, picture: await readPicture(message) };
    } catch (error) {
      const refusal = error instanceof UserError ? error : refuse(t, 'referenceIncomplete');
      const key = refusal.key !== undefined && Object.hasOwn(REFUSAL_CODES, refusal.key) ? refusal.key as keyof typeof REFUSAL_CODES : 'referenceIncomplete';
      logFor(userId)('reference_refused', undefined, { referenceRefusal: REFUSAL_CODES[key] });
      return { wait, error: refusal };
    }
  }

  // What a picture a reader sent becomes inside the library write (local/reference.ts `keepReference`): nothing unless
  // the wait it answered still stands, with access to references and within its half hour, and the person it is of is
  // still on the story's sheet. It ends the wait, and a picture refused leaves the wait open for another, as a prompt
  // does. An English caption is kept with it and any other is not: a caption is what frames are to be matched by later.
  // The portrait it replaces as the front stays under it (lib/library.ts `poseReference`), and a picture of the reader's
  // own it replaces goes with the sweep, unless a recipe still needs its file.
  function keptUpload(state: Library, update: Update, upload: Upload, t: Messages, pictureInfo: RenderDetails): Plan {
    const { storyId, name, pose, at } = upload.wait;
    const wait = state.ui?.input === 'reference' ? state.ui : undefined;
    if (wait?.storyId !== storyId || wait.name !== name || wait.pose !== pose || wait.at !== at) throw refuse(t, 'referenceChanged');
    if (!pictureInfo.references || Date.now() - at > REFERENCE_WAIT_MS) {
      state.ui = null;
      throw refuse(t, pictureInfo.references ? 'referenceExpired' : 'referencesOff');
    }
    const picture = upload.picture;
    if (!picture) throw upload.error ?? refuse(t, 'referenceIncomplete');
    state.ui = null;
    const sheet = state.stories[storyId]?.sheet ?? [];
    const index = sheet.findIndex(one => one.name === name);
    if (index < 0) throw refuse(t, 'referenceGone');
    const caption = typeof update.message?.caption === 'string' ? captionOf(update.message.caption) : undefined;
    keepReference(store, String(update.message?.from?.id), appearanceOf(state, sheet[index]), picture, pose, caption, Date.now());
    return { screen: render(state, `portrait-kept:${storyId}:${index}`, { retainsPortraits: true }), done: true, sweep: true,
      logged: { event: 'reference_saved', details: { referenceSent: picture.sent, referenceFormat: picture.format, referencePlace: pose,
        referenceBytes: picture.bytes.length + picture.strippedBytes, strippedBytes: picture.strippedBytes,
        referenceWidth: picture.width, referenceHeight: picture.height } } };
  }

  // Where a photo or a file of a pose set goes in the library write: into the reader's queue (`poseUploads`), unread, if
  // the wait it answered still stands, with pose sets and within its half hour, and its person is still on the story's
  // sheet, by the person's key, which a sheet written again keeps (local/picture.ts `rewrittenSheet`). The update ends
  // there, and the queue is read apart from the updates (`uploadNext`), so that the downloads of an album or an archive
  // hold up nobody's requests, the owner's among them. A queue as long as a set can be counts the next file as past the
  // limit, unread. Either way the queue's reading goes on, or starts again after a write that failed.
  function queuedPoseUpload(state: Library, update: Update, upload: PoseUpload, t: Messages, pictureInfo: RenderDetails): Plan {
    const { storyId, name, at } = upload.wait;
    const wait = state.ui?.input === 'pose-set' ? state.ui : undefined;
    if (wait?.storyId !== storyId || wait.name !== name || wait.at !== at) throw refuse(t, 'poseSetChanged');
    if (!pictureInfo.poseSet || Date.now() - (wait.last ?? at) > POSE_SET_WAIT_MS) {
      state.ui = null;
      throw refuse(t, pictureInfo.poseSet ? 'poseSetExpired' : 'poseSetOff');
    }
    if (!state.stories[storyId]?.sheet?.some(one => one && personKey(one.name) === personKey(name))) { state.ui = null; throw refuse(t, 'poseSetGone'); }
    const queue = state.poseUploads ?? [];
    if (queue.length >= POSE_SET_PICTURES) return { poseQueue: true, poseCount: { storyId, name, at, kept: 0, labeled: 0, refused: { full: 1 } },
      logged: { event: 'pose_set_refused', details: { poseSetRefusal: 'full' } } };
    state.poseUploads = [...queue, { update: update.update_id, storyId, name, at, ...wait.preset ? { preset: wait.preset } : {}, file: upload.file }];
    wait.last = Date.now();
    return { poseQueue: true };
  }

  // Reads a photo or a file of a pose set as `readUpload` reads a picture of the reader's own. A refusal is kept by its
  // code alone, for the message that counts the pictures, never shown on its own: an album of forty would be forty
  // messages. A ZIP archive is read whole, every picture in it, and one refused whole says why in a message of its own.
  // One cut short by `signal` is refused as `incomplete`.
  async function readPoseFile(file: PoseUploadFile, signal: AbortSignal): Promise<PoseRead> {
    const document = file.document as TelegramDocument | undefined;
    if (document && isArchive(document)) {
      try {
        if (!readArchive) throw new Error('archive_reader_unavailable');
        return { archive: { ...await readArchive(document, signal), name: String(document.file_name ?? '') } };
      } catch (error) {
        return { archiveRefused: error instanceof ArchiveError ? error.code : 'incomplete' };
      }
    }
    try {
      if (!readPicture) throw new Error('picture_reader_unavailable');
      return { picture: await readPicture(file as { photo?: unknown; document?: TelegramDocument }, signal) };
    } catch (error) {
      const key = error instanceof UserError && error.key !== undefined && Object.hasOwn(REFUSAL_CODES, error.key)
        ? error.key as keyof typeof REFUSAL_CODES : 'referenceIncomplete';
      return { refused: REFUSAL_CODES[key] };
    }
  }

  // What a file of the queue becomes inside the library write that takes it out of the queue: nothing if it left
  // meanwhile, with its set, and nothing either if its person left the story's sheet; otherwise its pictures, each kept
  // as one sent alone within the set's and the reader's limits (`poseSetLimit`), its caption to come, or its refusal
  // counted. An archive's pictures are kept in this one write, with the labels its labels.csv gave them.
  type PoseKept = { count?: PoseCount; captions?: boolean; refusal?: ArchiveError; logged: NonNullable<Plan['logged']> };
  // Where a file of the queue goes, whatever has been linked since its wait opened: the preset it was sent for, or else
  // the person of the story's sheet it was for, by the key a sheet written again keeps, into their own set even if a
  // preset stands in for it now. A file is taken as the queue has it at that write, not as its read began: a save while it
  // was read has sent it after the set it moved (`preset-save:`).
  const personOf = (state: Library, job: PendingPoseUpload) => job.preset !== undefined ? linkedPreset(state, job)
    : state.stories[job.storyId]?.sheet?.find(one => one && personKey(one.name) === personKey(job.name));
  function keptPoseFile(state: Library, userId: string, job: PendingPoseUpload, read: PoseRead): PoseKept | undefined {
    const queue = state.poseUploads ?? [];
    const queued = queue.find(one => one.update === job.update);
    if (!queued) return undefined;
    const rest = queue.filter(one => one.update !== job.update);
    if (rest.length) state.poseUploads = rest; else delete state.poseUploads;
    const { storyId, name, at } = job;
    const person = personOf(state, queued);
    if (!person) return { logged: { event: 'pose_upload_dropped', details: {} } };
    if (read.archiveRefused) {
      const refusal = new ArchiveError(read.archiveRefused);
      return { refusal, logged: { event: 'pose_archive_refused', details: { poseArchiveRefusal: refusal.code } } };
    }
    if (read.archive) {
      const { pictures, labels, name: archive } = read.archive;
      const count: PoseCount = { storyId, name, at, kept: 0, labeled: 0, refused: {}, ...labels.found ? { labels: { ...labels, archive } } : {} };
      let main = 0;
      const now = Date.now();
      for (const one of pictures) {
        const refused = one.picture ? poseSetLimit(state, person, one.picture.bytes.length) : one.refused ?? 'incomplete';
        if (refused) { count.refused[refused] = (count.refused[refused] ?? 0) + 1; continue; }
        keepPoseSetPicture(store, userId, person, one.picture!, now, one);
        count.kept++;
        if (one.given?.pose && one.given.side && one.given.framing) count.labeled++;
        if (one.main) main++;
      }
      return { count, captions: count.kept > count.labeled,
        logged: { event: 'pose_archive_saved', details: { poseSetKept: count.kept, poseSetRefused: pictures.length - count.kept,
          poseLabeled: count.labeled, poseMain: main, poseLabels: labels.unread ? 'unread' : labels.found ? 'read' : 'none',
          poseLabelRows: labels.rows, poseRowsUnmatched: labels.unmatched.length, poseRowsUnknown: labels.unknown.length,
          poseSetCount: poseSetState(person).count } } };
    }
    const picture = read.picture;
    const refused = picture ? poseSetLimit(state, person, picture.bytes.length) : read.refused ?? 'incomplete';
    const count: PoseCount = { storyId, name, at, kept: refused ? 0 : 1, labeled: 0, refused: refused ? { [refused]: 1 } : {} };
    if (refused || !picture) return { count, logged: { event: 'pose_set_refused', details: { poseSetRefusal: refused } } };
    keepPoseSetPicture(store, userId, person, picture, Date.now());
    return { count, captions: true,
      logged: { event: 'pose_set_saved', details: { referenceSent: picture.sent, referenceFormat: picture.format,
        referenceBytes: picture.bytes.length + picture.strippedBytes, strippedBytes: picture.strippedBytes,
        referenceWidth: picture.width, referenceHeight: picture.height, poseSetCount: poseSetState(person).count } } };
  }

  // The message that counts the pictures of one wait for a pose set, one per wait, in memory: the first picture read sends
  // it and the next ones edit it, at most every few seconds (local/progress.ts), with «✅ Готово» under it while the wait
  // stands. Once the wait is over it says how many of its files are still being read, and it gets its last word with the
  // last of them (`closing`). A restart starts a new one at the next picture read.
  type Counts = { storyId: string; name: string; at: number; kept: number; labeled: number; refused: Partial<Record<PoseRefusal, number>>;
    archives: NonNullable<PoseCount['labels']>[] };
  type Stage = { stage: 'receiving' | 'finishing' | 'done' };
  type Tally = { counts: Counts; progress: ReturnType<typeof createProgress<Stage>> };
  const tallies = new Map<string, Map<string, Tally>>();
  const waitKey = (wait: Pick<PoseSetInput, 'storyId' | 'name' | 'at'>) => JSON.stringify([wait.storyId, wait.name, wait.at]);
  const openWait = (state: Library) => state.ui?.input === 'pose-set' ? waitKey(state.ui) : undefined;
  const unread = (state: Library, key: string) => (state.poseUploads ?? []).filter(job => waitKey(job) === key).length;
  function counted(userId: string, chat: Chat, count: PoseCount, log: Log) {
    const key = waitKey(count);
    const mine = tallies.get(userId) ?? new Map<string, Tally>();
    tallies.set(userId, mine);
    let tally = mine.get(key);
    if (!tally) {
      const counts: Counts = { storyId: count.storyId, name: count.name, at: count.at, kept: 0, labeled: 0, refused: {}, archives: [] };
      const progress = createProgress<Stage>({ chat, log, rows: { failed: 'pose_set_status_failed' }, render: status => {
        const state = store.read(userId);
        return render(state, 'pose-set-status', { ...pictureInfoOf(userId), poseTally: { ...counts, refused: { ...counts.refused },
          archives: [...counts.archives], unread: unread(state, key), finishing: status.stage === 'finishing', done: status.stage === 'done' } });
      } });
      mine.set(key, tally = { counts, progress });
    }
    tally.counts.kept += count.kept;
    tally.counts.labeled += count.labeled;
    for (const [reason, n] of Object.entries(count.refused) as [PoseRefusal, number][]) tally.counts.refused[reason] = (tally.counts.refused[reason] ?? 0) + n;
    if (count.labels) tally.counts.archives.push(count.labels);
    tally.progress.update({ stage: openWait(store.read(userId)) === key ? 'receiving' : 'finishing' });
  }
  // The counts of `userId`'s whose wait is over: those whose files are all read, taken out to get their last word
  // (`endTally`), while the others say that files of theirs are still being read.
  function closing(userId: string): Tally[] {
    const mine = tallies.get(userId);
    if (!mine) return [];
    const state = store.read(userId);
    const ended: Tally[] = [];
    for (const [key, tally] of mine) {
      if (key === openWait(state)) continue;
      if (unread(state, key)) { tally.progress.update({ stage: 'finishing' }); continue; }
      mine.delete(key);
      ended.push(tally);
    }
    if (!mine.size) tallies.delete(userId);
    return ended;
  }
  async function endTally(tally: Tally, log: Log) {
    await tally.progress.finish({ stage: 'done' });
    log('pose_set_ended', undefined, { poseSetKept: tally.counts.kept,
      poseSetRefused: Object.values(tally.counts.refused).reduce((sum, one) => sum + (one ?? 0), 0) });
  }
  // The captions of pose sets, on this computer, one picture at a time; those a restart left waiting start again.
  const captioner = captionerConfig ? createPoseCaptioner(captionerConfig, { store, log: logFor }) : undefined;
  if (captioner) for (const userId of allowedUsers) if (illustrator?.poseSetFor(userId)) captioner.enqueue(userId);

  // Each reader's queue of pose-set files, read one file at a time in the order they came, apart from the updates that
  // brought them, while the reader's worker runs, and READS_AT_ONCE files at most across readers. A file leaves the queue
  // in the write that keeps its pictures, so that a stop or a restart halfway reads it again and keeps it once, and a
  // restart reads what it left. A file gets UPLOAD_MS to be read once its turn comes, the question to Telegram for its
  // path included: after that its read is cut short, its requests with it, and it is refused as `incomplete`. A stop
  // cuts short the read in flight, and the file stays queued.
  const uploading = new Map<string, Promise<void>>();
  let uploadsStopped = false;
  // The reads under way, which a stop cuts short; how many turns to read are taken, and the workers waiting for one, in
  // the order they asked.
  const reads = new Set<AbortController>();
  let turnsTaken = 0;
  const turnsAwaited: (() => void)[] = [];
  // A turn to read a file: at once while fewer than READS_AT_ONCE are taken, or when one ends (`endTurn`), which hands it
  // on to the worker that has waited longest.
  function readTurn(): Promise<void> {
    if (turnsTaken < READS_AT_ONCE) { turnsTaken++; return Promise.resolve(); }
    return new Promise(resolve => turnsAwaited.push(resolve));
  }
  function endTurn() {
    const next = turnsAwaited.shift();
    if (next) next(); else turnsTaken--;
  }
  // Reads `file` in a turn of its own, cut short once UPLOAD_MS pass or the bot stops.
  async function readInTurn(file: PoseUploadFile): Promise<PoseRead> {
    await readTurn();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), UPLOAD_MS);
    reads.add(controller);
    try { return uploadsStopped ? {} : await readPoseFile(file, controller.signal); }
    finally { clearTimeout(deadline); reads.delete(controller); endTurn(); }
  }
  function readPoseQueue(userId: string) {
    if (uploadsStopped || uploading.has(userId)) return;
    let failed = false;
    uploading.set(userId, (async () => { while (await uploadNext(userId)) { /* the next file */ } })()
      .catch(error => { failed = true; logFor(userId)('pose_upload_failed', fileErrorCode(error)); })
      .finally(() => {
        uploading.delete(userId);
        // A file that came as the last one was read is read as well; after a write that failed, the queue waits for the
        // reader's next file or the next start.
        if (!failed && !uploadsStopped && store.read(userId).poseUploads?.length) readPoseQueue(userId);
      }));
  }
  // Reads the first file of `userId`'s queue and keeps what it holds; says whether to go on.
  async function uploadNext(userId: string): Promise<boolean> {
    if (uploadsStopped) return false;
    const before = store.read(userId);
    const job = before.poseUploads?.[0];
    if (!job) return false;
    const person = personOf(before, job);
    const document = job.file.document as TelegramDocument | undefined;
    // A picture that the set's limits refuse already is not downloaded to be refused.
    const full = person && !(document && isArchive(document)) ? poseSetLimit(before, person, 0) : undefined;
    const read: PoseRead = !person ? {} : full ? { refused: full } : await readInTurn(job.file);
    if (uploadsStopped) return false;
    const log = logFor(userId);
    const kept = store.mutate(userId, state => keptPoseFile(state, userId, job, read));
    if (kept) log(kept.logged.event, undefined, kept.logged.details);
    const chat = createChat(api, userId, chats.get(userId) ?? chats.set(userId, chatMemory()).get(userId));
    if (kept?.count) counted(userId, chat, kept.count, log);
    if (kept?.captions) captioner?.enqueue(userId);
    const ended = closing(userId);
    if (kept?.refusal) await pass(chat, { text: errorText(texts(store.read(userId).language), kept.refusal) }, log);
    for (const tally of ended) await endTally(tally, log);
    return true;
  }
  for (const userId of allowedUsers) if (illustrator?.poseSetFor(userId) && store.read(userId).poseUploads?.length) readPoseQueue(userId);

  // Prepares the compaction of this person's active branch while they read (local/prepare.ts). Their own work: it keeps
  // the GPU like a job, and runs only on a GPU that is already up.
  function prepareNext(userId: string) {
    const log = logFor(userId);
    let release: (() => void) | undefined;
    try {
      if (gpu && gpu.snapshot().status !== 'ready') return;
      release = gpu?.acquire();
    } catch { return; }
    const started = Date.now();
    log('compaction_prepare_started');
    const done = preparedFor(userId).run(store.read(userId), provider, contextConfig, { holder: userId, log })
      .then(() => log('compaction_prepare_finished', undefined, { elapsedMs: Date.now() - started }),
        error => log('compaction_prepare_failed', errorCode(error), { elapsedMs: Date.now() - started }))
      .finally(() => { release?.(); preparing.delete(done); });
    preparing.add(done);
  }

  // Runs the turn and, when the scene has been delivered, says what its picture would be drawn from. The picture
  // itself is not made here: it must not hold the model slot or the GPU of this turn (see `handle`).
  async function generate(userId: string, chat: Chat, job: Job, controller: AbortController, releaseGpu: (() => void) | undefined,
    pictureSignal: AbortSignal, earlier?: Promise<void>): Promise<PictureRequest | undefined> {
    const log = logFor(userId);
    let prepare = false;
    let picture: PictureRequest | undefined;
    let memory: PictureRequest['memory'];
    // The language at the start of the job serves its status message and the labels it stores; later messages read it again.
    const language = store.read(userId).language;
    const labels = texts(language).labels;
    const notices = () => texts(store.read(userId).language).notices;
    // A compaction's status is a passing status line while it runs, and a notice once it has said its last word.
    let statusId: number | undefined;
    const progress = createProgress({ render: status => renderCompaction(status, language), signal: controller.signal, log,
      chat: { edit: chat.edit, send: async screen => { statusId = await chat.show(screen, 'status'); return { message_id: statusId }; } } });
    const finishStatus = async () => {
      const shown = await progress.finish();
      if (statusId !== undefined) chat.mark(statusId, 'notice');
      return shown;
    };
    let compactionStatus: CompactionStatus | undefined;
    const onProgress = (event: CompactionStatus) => {
      compactionStatus = { ...compactionStatus, ...event, automatic: job.kind !== 'compact', job: job.id };
      progress.update(compactionStatus);
    };
    const reportFailure = async (error: unknown) => {
      // Thrown values are not checked: ModelError carries these fields, other errors lack them.
      const failure = error as { code?: string | number; operation?: string };
      if (member(['provider_failed', 'timeout', 'unauthorized', 'model_unavailable', 'unexpected_model'], failure.code)) {
        Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
      }
      log('generation_failed', failure.code, error);
      const retry = job.kind === 'compact' ? '/compact' : '/retry';
      if (failure.operation === 'compact' && compactionStatus?.stage === 'failed') {
        if (!await finishStatus()) await pass(chat, renderCompaction(compactionStatus, language), log);
        return;
      }
      const snapshot = store.read(userId);
      const t = texts(snapshot.language);
      const text = failure.code === 'nothing_to_compact' ? t.notices.nothingToCompactYet(keepScenes)
        : failure.code === 'context_limit' ? t.notices.contextLimit
        : failure.code === 'invalid_memory' || failure.code === 'memory_not_smaller' ? t.notices.compactionUnverified(retry)
        : unavailable(failure) ? t.notices.modelUnavailable
        : t.notices.failed(retry);
      // With the scene's own keyboard, it may be the one Continue in the chat: it stays, as a scene does.
      await safeSend(chat, { text, reply_markup: sceneKeyboard(snapshot) }, log);
    };
    try {
      if (job.kind === 'compact') {
        // compactBranch writes the log rows of a compaction, manual or automatic, with its sizes and counts.
        const result = await inTurn(provider, provider => compactBranch({ store, userId, jobId: job.id, provider,
          config: contextConfig, signal: controller.signal, prepared: preparedFor(userId), onProgress, log, labels }), { holder: userId, work: 'compaction' });
        const completed = store.mutate(userId, state => {
          if (controller.signal.aborted || !jobTarget(state, job.id)) return false;
          state.job = null;
          return true;
        });
        if (!completed) return;
        modelResponded();
        if (!await finishStatus()) await pass(chat, renderCompaction({ ...compactionStatus, stage: 'done', ...result }, language), log);
        return;
      }
      let usage: GenerationResult['usage'];
      // Statuses share the scene's draft. They go out one after another; one already superseded by a newer status is
      // skipped, and none goes out once the scene's text has begun or the turn is over. The text and every later
      // message wait for the status in flight, so a stale status never lands on top of them. A status the same as the
      // last one is not sent again: a start time that moved less than its rounding says nothing new.
      let status = Promise.resolve();
      let latest = '', over = false, queued = false, reading = false;
      const show = (text: string) => {
        if (text === latest) return;
        latest = text;
        status = status.then(() => over || latest !== text ? undefined : chat.status(job.id, text));
      };
      const endStatus = () => { over = true; return status; };
      const outcome = await runTurn({ store, userId, job, provider, config: contextConfig, signal: controller.signal,
        prepared: preparedFor(userId), onProgress, log, labels,
        // The picture reads the memory of the scene, taken in the write that commits it: the job lock goes with that write,
        // and the reader's next request may compact the branch before this turn is over.
        operation: { settle: (state, result) => {
          if (!result.ref) return keepMove(state, job);
          const story = state.stories[result.ref.storyId], id = story.branches[result.ref.branchId]?.memory ?? null;
          memory = { id, chain: memoryChain(story, id) };
        } },
        waiting: (ahead, etaMs) => {
          if (reading) return;
          const t = texts(store.read(userId).language), wait = t.wait;
          if (ahead === null) { reading = true; show(wait.reading); }
          else if (ahead > 0) { queued = true; show(wait.queued(ahead, etaText(t, etaMs))); }
          else if (queued) show(wait.next);
        },
        preview: (state, current, request) => {
          const measured = stats(state, { storyId: current.storyId, branchId: current.branchId });
          // generateScene sets the estimate before it asks for a preview.
          if (measured) measured.request.estimatedTokens = request.estimatedInputTokens!;
          const onText = chat.preview(current.id, scenePrefix(measured, modelInfo, state.language, placeOf(state, current.storyId, current.branchId, current.head, 1)));
          return async delta => {
            if (!over) {
              await endStatus();
              // The turn may have been replaced while the status was in flight.
              if (store.read(userId).job?.id !== job.id) controller.abort();
            }
            // A cancelled turn shows no more text, even from deltas the provider has already received.
            if (controller.signal.aborted) return;
            return onText(delta);
          };
        },
        onGenerated: result => {
          usage = result.usage;
          modelResponded();
          if (result.streamResultMismatch) log('model_result_differs_from_stream');
        },
      });
      await endStatus();
      if (outcome.status === 'gone') return;
      if (outcome.status === 'failed') { await reportFailure(outcome.error); return; }
      const ref = outcome.ref;
      // The next request carries this one's input, its scene and the person's action, so from here it compacts first.
      prepare = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) >= compactionThreshold(contextConfig);
      const snapshot = store.read(userId);
      const node = snapshot.stories[ref.storyId].nodes[ref.nodeId];
      try {
        // Persisted above. An ambiguous response must never trigger a new model run.
        const prefix = scenePrefix(stats(snapshot, { storyId: ref.storyId, checkpointId: ref.checkpointId }), node.modelInfo, snapshot.language,
          placeOf(snapshot, ref.storyId, ref.branchId, ref.nodeId));
        // The picture of the scene before it has its place in the chat before this scene does (`Running`). The model's
        // work is over, so the card is not held up for a slow answer from Telegram.
        if (earlier && illustrator?.enabledFor(userId)) {
          releaseGpu?.();
          await earlier;
        }
        // Bot API results are not validated; the id of the sent message is stored as returned.
        const sent = await chat.final(prefix + node.text, keyboardOf(userId, ref)) as { message_id: number };
        store.mutate(userId, state => {
          const saved = state.stories[ref.storyId]?.nodes[ref.nodeId];
          if (saved) { saved.delivery = 'sent'; saved.messageId = sent.message_id; }
        });
        log('scene_saved_and_sent');
        // The wait for the picture starts here, at the scene the reader is now reading. A scene that was not
        // delivered is not illustrated: the photo would hang under nothing.
        if (illustrator?.enabledFor(userId) && !pictureSignal.aborted) {
          picture = { userId, chat, storyId: ref.storyId, nodeId: ref.nodeId, branchId: ref.branchId,
            memory, sceneMessageId: sent.message_id, sceneAt: Date.now(),
            signal: pictureSignal, log, hold: () => gpu?.acquire(),
            // Work prepared ahead opens a turn of its own that takes this reader's slot and leaves it marked for
            // nobody (local/scheduler.ts `start`), and the description continues the scene that is cached there. So
            // it waits for the description to be over — which is before the drawing, not after it.
            afterDescribe: () => { if (prepare && !controller.signal.aborted) prepareNext(userId); } };
        }
        if (node.truncated) await safeSend(chat, { text: notices().truncated }, log);
      } catch (error) {
        log('scene_delivery_unconfirmed', errorCode(error));
        await safeSend(chat, { text: notices().deliveryUnconfirmed }, log);
      }
    } catch (error) {
      // A failed compaction; a failed scene comes back from runTurn with its job already released.
      const stillCurrent = store.mutate(userId, state => {
        if (state.job?.id !== job.id) return false;
        releaseJob(state);
        return true;
      });
      if (!stillCurrent || controller.signal.aborted) return;
      await reportFailure(error);
    } finally {
      await finishStatus();
      releaseGpu?.();
      if (prepare && !controller.signal.aborted && !picture) prepareNext(userId);
    }
    return picture;
  }

  // The details and the look retold from the description a reader has just written (local/picture.ts `retell`), then
  // the person's card in place of the status line that stood meanwhile, a card that stays (`Plan.lasting`): the new
  // look, or the word that it is still to be retold. Only for a reader who is drawn for, and only while the language model's GPU is up, which it keeps up as a
  // job does and never wakes; the two are otherwise retold before the next picture of the story, and the card says so
  // at once.
  async function retold(userId: string, chat: Chat, { storyId, name }: { storyId: string; name: string }, signal: AbortSignal) {
    const log = logFor(userId);
    let status: number | undefined;
    if (!illustrator?.enabledFor(userId)) log('look_retold', 'pictures_off', { outcome: 'skipped' });
    else {
      let release: (() => void) | undefined;
      let held = true;
      try { release = gpu?.acquire(); }
      catch {
        held = false;
        log('look_retold', 'gpu_not_ready', { outcome: 'skipped' });
      }
      if (held) {
        try {
          try { status = await chat.show({ text: texts(store.read(userId).language).characters.retelling }, 'status'); }
          catch (error) { log('telegram_send_failed', errorCode(error)); }
          await illustrator.retell({ userId, storyId, signal, log });
        } finally { release?.(); }
      }
    }
    const state = store.read(userId);
    const index = state.stories[storyId]?.sheet?.findIndex(one => one.name === name) ?? -1;
    // A person gone meanwhile opens the story's people, and a story gone says so (local/ui.ts).
    const card = render(state, `character:${storyId}:${index}:${personTag(name)}`, pictureInfoOf(userId));
    if (status !== undefined) {
      try { await chat.edit(status, card); chat.keep(status); log('screen_sent'); return; }
      catch (error) {
        // An edit Telegram answered did not land, and the status line goes. One without an answer may have made the
        // line the card, so it stays as any card does, and the card is sent again below.
        if (typeof (error as { code?: unknown }).code !== 'number') chat.keep(status);
        else try { await chat.remove(status); } catch { chat.mark(status, 'notice'); }
      }
    }
    await safeSend(chat, card, log);
  }

  return {
    async handle(update: Update) {
      const from = update.callback_query?.from || update.message?.from;
      const chatInfo = update.callback_query?.message?.chat || update.message?.chat;
      const userId = String(from?.id);
      if (from?.is_bot || chatInfo?.type !== 'private' || String(chatInfo.id) !== userId) return;
      if (!allowedUsers.has(userId)) {
        // Keep only the sender ID/time of an explicit access request. Other
        // unauthorized messages never enter storage, logs or a model prompt.
        if (typeof update.message?.text === 'string' && /^\/start(?:@[A-Za-z0-9_]+)?$/.test(update.message.text.trim())) {
          store.requestAccess(userId);
        }
        return;
      }
      const chat = createChat(api, chatInfo.id, chats.get(userId) ?? chats.set(userId, chatMemory()).get(userId));
      const log = logFor(userId);
      // The notices out when this update came, which it takes away once it is handled (below).
      const noticed = chat.passing('notice');
      if (update.callback_query?.id) {
        try { await api('answerCallbackQuery', { callback_query_id: update.callback_query.id }); } catch {}
      }
      let fileInput: FileInput | undefined;
      let upload: Upload | undefined;
      let poseUpload: PoseUpload | undefined;
      const message = update.message;
      // A photo or a file is a picture of a person while one is awaited, and a file is otherwise a seed file. A photo
      // nobody asked for goes to the write, which answers it as any message without text.
      if (message && (message.document || message.photo !== undefined)) {
        const state = store.read(userId);
        if (state.seen.includes(update.update_id)) return;
        const t = texts(state.language);
        if (state.ui?.input === 'reference') upload = await readUpload(userId, state.ui, message, t);
        else if (state.ui?.input === 'pose-set') poseUpload = { wait: state.ui, file: poseFileOf(message) };
        else if (message.document) {
          if (state.ui?.input !== 'seed') {
            fileInput = { error: refuse(t, 'fileNeedsDraft') };
          } else {
            const draftId = state.ui.draftId;
            try {
              if (!readSeedFile) throw new Error('file_reader_unavailable');
              fileInput = { draftId, text: await readSeedFile(message.document) };
            } catch (error) {
              fileInput = { error: error instanceof UserError ? error : refuse(t, 'fileFailed') };
            }
          }
        }
      }
      const plan = store.mutate(userId, state => {
        if (state.seen.includes(update.update_id)) return null;
        // First contact: nothing was handled or created yet, so Telegram's language is the best guess. A library that
        // already exists keeps what it has; without a stored language it stays Russian (text.ts).
        if (state.language === undefined && !state.seen.length && !state.seq) setLanguage(state, langFromTelegram(from?.language_code));
        state.seen = [...state.seen.slice(-511), update.update_id];
        try { return prepare(state, update, fileInput, pictureInfoOf(userId), upload, poseUpload); }
        catch (error) {
          if (error instanceof UserError) return { screen: { text: errorText(texts(state.language), error) } };
          throw error;
        }
      });
      if (!plan) return;
      // The deletion is written: what the card draws for it stops now, ahead of everything Telegram is asked below.
      if (plan.lostPictures) illustrator?.forgetGone(userId);
      if (plan.logged) log(plan.logged.event, undefined, plan.logged.details);
      if (plan.poseCount) counted(userId, chat, plan.poseCount, log);
      if (plan.poseQueue) readPoseQueue(userId);
      // A wait for a pose set that «✅ Готово», another button or a command ended ends its count as well, once the files
      // sent in it are read.
      for (const tally of closing(userId)) await endTally(tally, log);
      if (plan.portraitKept) illustrator?.portraitKept(userId, plan.portraitKept);
      if (plan.sweep) {
        try { store.sweepPortraits(userId); } catch (error) { log('portraits_unswept', fileErrorCode(error)); }
      }
      let screen = plan.screen;
      if (plan.gpuAction) {
        // simple-serving starts and sleeps its own card, so there is nothing here to start
        // (docs/model-providers.md#simple-serving-our-gateway).
        const notices = texts(store.read(userId).language).notices;
        if (!gpu) screen = { text: providerName === 'simple-serving' ? notices.modelServiceSeparate : notices.gpuNotConfigured };
        else {
          try {
            if (plan.gpuAction === 'pause') gpu.pause(); else gpu.resume();
            void gpu.tick();
          } catch { /* Current controller state is rendered below. */ }
          screen = render(store.read(userId), 'model');
        }
      }
      if (plan.modelStatus) {
        if (gpu) {
          await gpu.tick();
          if (gpu.snapshot().status === 'ready') modelResponded();
          else Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
        } else if (provider.check) {
          try {
            await provider.check({ signal: AbortSignal.timeout(8000) });
            modelResponded();
          } catch {
            Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
          }
        }
        screen = render(store.read(userId), 'model');
      }
      if (plan.cancel) {
        const entry = running.get(userId);
        entry?.controller.abort();
        for (let one = entry?.earlier; one; one = one.earlier) one.picture.abort();
        illustrator?.cancel(userId);
        sampling.get(userId)?.abort();
        varying.get(userId)?.abort();
      }
      // Passing messages (docs/telegram-ui.md#passing-messages). A screen with buttons, answering a button pressed on a
      // passing message, takes that message's place, unless it is to go apart or a scene goes out before it: then it
      // goes below the scene and the pressed message goes. A screen without buttons is a notice, and never takes the
      // place of the screen it answers; a card or a profile goes as a message that stays (`Plan.lasting`). Once all
      // that is out, the notices out when this update came go, and so do the screens of a wait that is over; an open
      // wait's newer screen sent anew takes the place of the ones before it but its first, which says what the wait is
      // for. Only passing messages are ever deleted (`tidy`), and none when the answer did not get out: the update is
      // committed by then, and the screen pressed is how the reader asks again. It is only logged, a scene shown again
      // as well: /last is how the reader asks for that one again.
      const pressed = update.callback_query?.message?.message_id;
      const wait = waitOf(store.read(userId).ui);
      const lasting = !!plan.lasting;
      const kind: Passing = plan.done || !screen?.reply_markup ? 'notice' : 'screen';
      const replaces = !lasting && kind === 'screen' && !plan.apart && chat.replaceable(pressed);
      const inPlace = replaces && !plan.savedText ? pressed : undefined;
      const gone = new Set(noticed);
      if (replaces && plan.savedText) gone.add(pressed!);
      const waits = chat.waits();
      for (const one of waits) if (one.wait !== wait) gone.add(one.id);
      if (screen && !lasting && kind === 'screen' && inPlace === undefined) waits.filter(one => one.wait === wait).slice(1).forEach(one => gone.add(one.id));
      if (inPlace !== undefined) gone.delete(inPlace);
      let delivered = true;
      if (plan.savedText) {
        const { text, modelInfo: shownInfo, shown } = plan.savedText;
        try {
          const snapshot = store.read(userId);
          const place = snapshot.active && placeOf(snapshot, snapshot.active.storyId, snapshot.active.branchId, snapshot.stories[snapshot.active.storyId]?.branches[snapshot.active.branchId]?.head ?? null);
          const sent = await chat.final(scenePrefix(stats(snapshot), shownInfo, snapshot.language, place) + text, keyboardOf(userId, snapshot.active, true)) as { message_id?: unknown } | undefined;
          const messageId = sent?.message_id;
          if (shown && typeof messageId === 'number') store.mutate(userId, state => {
            const node = state.stories[shown.storyId]?.nodes[shown.nodeId];
            if (node) node.shownAs = [...node.shownAs ?? [], messageId].slice(-8);
          });
        } catch (error) {
          delivered = false;
          log('saved_scene_delivery_unconfirmed', errorCode(error));
        }
      }
      if (screen) {
        try {
          if (lasting) await chat.send(screen); else await chat.put(inPlace, screen, kind, kind === 'screen' ? wait : undefined);
          log('screen_sent', undefined, { screen: plan.opened });
        } catch (error) { delivered = false; log('telegram_send_failed', errorCode(error)); }
      }
      // Beside the next updates, as a branch's file below is. A picture that cannot be read or sent leaves the screen
      // alone, which has the same buttons.
      if (plan.presetPhoto) {
        const { file, caption } = plan.presetPhoto;
        const task: Promise<unknown> = (async () => {
          await chat.photo(readReference(store, userId, file).bytes, undefined, caption);
          log('screen_sent', undefined, { screen: plan.opened });
        })().catch(async error => {
          log('telegram_send_failed', errorCode(error));
          await pass(chat, caption, log);
        }).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      // Beside the next updates, as a deletion below is: an upload that takes its time holds up nobody.
      if (plan.exportBranch) {
        const { storyId, branchId } = plan.exportBranch;
        const task: Promise<unknown> = (async () => {
          const file = storyFile(store.read(userId), storyId, branchId);
          await chat.document(Buffer.from(file.text, 'utf8'), file.name, file.caption);
          log('branch_exported', undefined, { sceneCount: file.scenes });
        })().catch(async error => {
          log('telegram_send_failed', errorCode(error));
          await pass(chat, { text: texts(store.read(userId).language).notices.exportFailed }, log);
        }).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      // Beside the next updates and the job this one starts, as the pictures' deletion below is: a chat slow to answer
      // a deletion holds up nobody.
      if (gone.size && delivered) {
        const task: Promise<unknown> = chat.tidy([...gone]).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      // After the deletion screen and apart from it: the reader has seen the deletion whatever Telegram answers, and
      // is told nothing more. It runs beside the next updates, which local/main.ts handles one at a time, so that a
      // chat slow to answer for a hundred messages holds up nobody.
      if (plan.lostPictures?.length) {
        const messageIds = plan.lostPictures;
        const task: Promise<unknown> = chat.removeAll(messageIds)
          .then(removed => log('pictures_removed', undefined, { picturesRemoved: removed, picturesNotRemoved: messageIds.length - removed }))
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      if (plan.sample && illustrator) {
        const t = texts(store.read(userId).language);
        if (sampling.has(userId)) await pass(chat, { text: t.errors.sampleInFlight }, log);
        else {
          const stop = new AbortController();
          sampling.set(userId, stop);
          const task: Promise<unknown> = illustrator.sample({ ...plan.sample, userId, chat, signal: stop.signal, log,
            hold: () => gpu?.acquire() })
            .catch(error => log('turn_task_failed', errorCode(error)))
            .finally(() => {
              if (sampling.get(userId) === stop) sampling.delete(userId);
              inFlight.delete(task);
            });
          inFlight.add(task);
        }
      }
      // A portrait takes the place of a sample: one drawing on request at a time, stopped the same way.
      if (plan.portrait && illustrator) {
        if (sampling.has(userId)) await pass(chat, { text: texts(store.read(userId).language).errors.portraitInFlight }, log);
        else {
          const stop = new AbortController();
          sampling.set(userId, stop);
          const task: Promise<unknown> = illustrator.portrait({ ...plan.portrait, userId, chat, signal: stop.signal, log })
            .catch(error => log('turn_task_failed', errorCode(error)))
            .finally(() => {
              if (sampling.get(userId) === stop) sampling.delete(userId);
              inFlight.delete(task);
            });
          inFlight.add(task);
        }
      }
      // A description the reader wrote is kept whatever the model does with it, and the card that follows says what
      // became of the look. Beside every other request of theirs: it is one call, and their next scene waits for it.
      if (plan.retell) {
        const stop = new AbortController();
        retelling.add(stop);
        const task: Promise<unknown> = retold(userId, chat, plan.retell, stop.signal)
          .catch(error => log('turn_task_failed', errorCode(error)))
          .finally(() => {
            retelling.delete(stop);
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
      // Beside a sample or a portrait, and with nothing held on the language model's card: a variant never asks it
      // anything.
      if (plan.variant && illustrator) {
        if (varying.has(userId)) await pass(chat, { text: texts(store.read(userId).language).errors.variantInFlight }, log);
        else {
          const stop = new AbortController();
          varying.set(userId, stop);
          const task: Promise<unknown> = illustrator.variant({ ...plan.variant, userId, chat, signal: stop.signal, log })
            .catch(error => log('turn_task_failed', errorCode(error)))
            .finally(() => {
              if (varying.get(userId) === stop) varying.delete(userId);
              inFlight.delete(task);
            });
          inFlight.add(task);
        }
      }
      if (plan.job) {
        let releaseGpu: (() => void) | undefined;
        try { releaseGpu = gpu?.acquire(); }
        catch {
          // The plan is not changed after the write, so its job is still set.
          store.mutate(userId, state => { if (state.job?.id === plan.job!.id) releaseJob(state); });
          await pass(chat, { text: texts(store.read(userId).language).notices.gpuPaused }, log);
          return;
        }
        const controller = new AbortController();
        const picture = new AbortController();
        controller.signal.addEventListener('abort', () => picture.abort(), { once: true });
        let settle = () => {};
        const settled = new Promise<void>(done => { settle = done; });
        const earlier = running.get(userId);
        const entry: Running = { controller, picture, settled, earlier };
        running.set(userId, entry);
        // This reader's own previous turn is over, as the job lock saw to, and the picture of its scene goes on behind
        // them (local/picture.ts `illustrate`): only a sample and a variant, which are looks and no more, end here.
        sampling.get(userId)?.abort();
        varying.get(userId)?.abort();
        // The picture is made after the turn's model work is over and its GPU hold released: the second call takes
        // a slot again, and the drawing takes none at all, so neither may sit inside the turn.
        const task: Promise<unknown> = generate(userId, chat, plan.job, controller, releaseGpu, picture.signal, earlier?.settled)
          .then(picture => picture && illustrator?.illustrate(picture))
          // The net under the whole chain, so that one throw cannot take the shutdown of the bot (`idle`) with it.
          // The turn reports its own failures to the reader and the picture its own outcomes, so a row here is
          // something neither of them expected — and on an install with no pictures it is never about one.
          .catch(error => log('turn_task_failed', errorCode(error)))
          .finally(() => {
            if (running.get(userId) === entry) running.delete(userId);
            entry.earlier = undefined;
            settle();
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
    },
    // Removes the places a stopped process kept in the chat for pictures it never finished (`Library.reservedPictures`),
    // the queue they stood for being gone with it, and tells nobody. One left there by a failure that ended the attempt
    // stays recorded for the next start, and one past the 48 hours in which it could go is forgotten here. One a picture or
    // its prompt went into may be that by now and stays in the chat, a line left standing being better than a picture
    // deleted, on record as a picture, so that it goes with its scene.
    async unreserve() {
      for (const { userId, places } of store.reservations()) {
        const log = logFor(userId);
        const chat = createChat(api, Number(userId), chats.get(userId) ?? chats.set(userId, chatMemory()).get(userId));
        const now = Date.now();
        const deletable = places.filter(one => now - one.at < MESSAGE_DELETABLE_MS);
        store.mutate(userId, state => {
          releaseReserved(state, places.filter(one => !deletable.includes(one)).map(one => one.messageId));
          recoverPictures(state, deletable.filter(one => one.delivering).map(({ delivering, ...place }) => place), now);
        });
        const messageIds = deletable.filter(one => !one.delivering).map(one => one.messageId);
        if (!messageIds.length) continue;
        const { removed, left } = await chat.removeEach(messageIds);
        log('pictures_removed', undefined, { picturesRemoved: removed, picturesNotRemoved: messageIds.length - removed });
        store.mutate(userId, state => releaseReserved(state, messageIds.filter(one => !left.includes(one))));
      }
    },
    // Tells the readers whose job ended with the last process (local/store.ts `recover`), with the button that repeats
    // their move. Nothing runs again by itself. A reader no message reached is told at the next start.
    async interrupted(userIds: string[]) {
      for (const userId of userIds) {
        if (!allowedUsers.has(userId)) continue;
        const state = store.read(userId);
        const chat = createChat(api, Number(userId), chats.get(userId) ?? chats.set(userId, chatMemory()).get(userId));
        const log = logFor(userId);
        try {
          await chat.send({ text: texts(state.language).notices.interrupted(state.lostMove ? '/retry' : '/compact'), reply_markup: sceneKeyboard(state) });
          log('screen_sent');
          store.mutate(userId, state => { delete state.jobInterrupted; });
        } catch (error) { log('telegram_send_failed', errorCode(error)); }
      }
    },
    async idle() {
      await Promise.all([...inFlight, ...preparing, ...uploading.values()]);
      await illustrator?.idle();
    },
    async stop() {
      for (const entry of prepared.values()) entry.stop();
      // A job this stop cuts short ends as one the process died under. That comes before the abort, after which a turn
      // lets go of its job and keeps no move, as for the reader's own /cancel; if that write fails, its turn runs on.
      for (const [userId, entry] of running) {
        try { store.mutate(userId, interruptJob); } catch { continue; }
        entry.controller.abort();
      }
      illustrator?.stop();
      for (const stop of sampling.values()) stop.abort();
      for (const stop of varying.values()) stop.abort();
      for (const stop of retelling) stop.abort();
      // The file being read is left in its queue for the next start, its read cut short.
      uploadsStopped = true;
      for (const controller of reads) controller.abort();
      for (const mine of tallies.values()) for (const tally of mine.values()) await tally.progress.close();
      await captioner?.stop();
      await this.idle();
    },
  };
}
