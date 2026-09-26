import { randomBytes } from 'node:crypto';
import { UserError, id, active, addSeed, newStory, fork, beginJob,
  deleteSeed, deleteBranch, forgetLostPictures, context, jobTarget, setLanguage } from '../lib/library.ts';
import type { Job, Library, SceneNode } from '../lib/library.ts';
import { storyNarration } from './prompt.ts';
import { createChat } from './telegram.ts';
import type { Chat, InlineKeyboard, Screen, TelegramApi } from './telegram.ts';
import { continueInput, contextStats } from './context.ts';
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
import { renderCompaction } from './compact-view.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { GpuController } from './gpu.ts';
import type { Illustrator, PictureRequest, PortraitRequest, SampleRequest, VariantRequest } from './picture.ts';
import { DETAILS_CHARS, LOOK_CHARS, personAt, personTag } from './picture.ts';
import type { Log } from './model-error.ts';
import { errorCode, member, safeErrorDetails, unavailable } from './model-error.ts';
import type { GenerationResult, Provider } from './model.ts';
import { STYLE } from './illustrate.ts';
import { OWN_STYLE_CHARS, OWN_STYLES_MAX, PROMPT_CHARS, choiceOf, lineOf, ownStyle, ownStyleInput, ownStyles, pickerKeys, styleKey, styleName } from './picture-style.ts';
import type { Store } from './store.ts';
import { fileErrorCode } from './store.ts';
import type { GpuInfo, ModelInfo, RenderDetails } from './ui.ts';
import { isRegistered, langFromTelegram, texts } from './text.ts';
import type { Messages } from './text.ts';

export type BotOptions = {
  store: Store; api: TelegramApi; provider: Provider; gpu?: GpuController;
  // Pictures under the scenes (local/picture.ts), for the readers its own configuration names. Absent by default:
  // without it nothing is described and nothing is drawn.
  illustrator?: Illustrator;
  readSeedFile?: (document: TelegramDocument) => Promise<string>;
  render: (state: Library, route: string, details: RenderDetails) => Screen;
  scenePrefix?: (stats: ContextStats | null, provenance: ModelInfo | undefined, lang?: unknown) => string;
  sceneKeyboard: (state: Library) => InlineKeyboard | undefined;
  allowedUsers: Set<string>; ownerId?: string; maxOutputTokens: number; contextTokens?: number; compactAtTokens?: number; keepScenes?: number;
  memoryMode?: 'plain' | 'sgr'; repairCoverage?: boolean; model?: string; providerName?: string; log?: Log;
};
// Bot API updates are not validated in advance; these are the fields the bot reads.
export type Update = {
  update_id: number;
  message?: IncomingMessage & { from?: Sender; chat?: { id: number; type: string }; document?: TelegramDocument };
  callback_query?: { id?: string; data?: string; from?: Sender; message?: { chat?: { id: number; type: string } } };
};
type Sender = { id: number; is_bot?: boolean; language_code?: string };
// A seed file read before the library write: its text for the draft, or the error to show instead.
type FileInput = { draftId: string; text: string; error?: undefined } | { error: UserError; draftId?: undefined; text?: undefined };
// What to do after the library write; handle acts on each field that is set.
type Plan = {
  screen?: Screen; cancel?: boolean; gpuAction?: string; modelStatus?: boolean;
  savedText?: { text: string; modelInfo: SceneNode['modelInfo'] }; job?: Job;
  // A sample of styles the reader asked for: what to draw, what to say under each picture and while they are drawn
  // (local/picture.ts `sample`).
  sample?: Pick<SampleRequest, 'storyId' | 'branchId' | 'nodeId' | 'styles' | 'status'>;
  // A variant of a picture from the prompt the reader wrote for it (local/picture.ts `variant`).
  variant?: Pick<VariantRequest, 'storyId' | 'nodeId' | 'prompt'>;
  // The messages of the pictures whose scenes a deletion took with it (lib/library.ts `forgetLostPictures`), to be
  // deleted from the chat once the deletion screen is out.
  lostPictures?: number[];
  // A portrait of a person of a story's sheet the reader asked for (local/picture.ts `portrait`).
  portrait?: Pick<PortraitRequest, 'storyId' | 'name' | 'candidate' | 'caption' | 'status'>;
  // The write may have let go of a kept portrait — a deletion, or a portrait kept in its place — whose file goes once
  // it is committed (local/store.ts `sweepPortraits`).
  sweep?: boolean;
  // The id of a portrait this write keeps, let go from memory once the write is committed and not before.
  portraitKept?: string;
  // The person of a story's sheet whose details this write keeps, for their look to be compressed from them and their
  // card shown (`compressed`).
  compress?: { storyId: string; name: string };
};
// One reader's turn, for as long as it can still be cancelled. What it leaves behind — a picture being stopped on
// the other card — outlives the entry and is awaited through `inFlight` instead.
//
// `picture` is the stop of that picture alone. The turn's own controller feeds it — a /cancel or a shutdown ends
// both — but the reader's next message ends only the picture, because by then the turn itself is over in every way
// that matters: the scene is committed, the job lock is clear, and what is left of it is a message being delivered
// and the work it starts afterwards for the reader's next turn.
type Running = { controller: AbortController; picture: AbortController };
// Library IDs are a prefix and a sequence number, as id() in lib/library.ts creates them.
const ID = { seed: /^s\d+$/, story: /^h\d+$/, branch: /^b\d+$/, checkpoint: /^c\d+$/ };
// A refusal in the user's language. The key stays on the error, so it can still be shown in another language.
const refuse = (t: Messages, key: keyof Messages['errors']) => new UserError(t.errors[key], key);
// Errors thrown below the bot (library, seed files, incoming messages) carry Russian text and a catalog key.
const errorText = (t: Messages, error: UserError) =>
  (error.key !== undefined && Object.hasOwn(t.errors, error.key) ? t.errors[error.key as keyof Messages['errors']] : error.message);

export function createBot({ store, api, provider, gpu, illustrator, readSeedFile, render: renderUi, scenePrefix = () => '', sceneKeyboard, allowedUsers, ownerId = '', maxOutputTokens,
  contextTokens = 65536, compactAtTokens = 54000, keepScenes = 4, memoryMode = 'plain', repairCoverage = false, model = 'unknown', providerName = 'claude-code', log = () => {} }: BotOptions) {
  const running = new Map<string, Running>();
  // One drawing on request at a time per reader, a sample of a style or a portrait (local/picture.ts `sample`,
  // `portrait`). A move in the story, /cancel and the bot's stop end it: the scene's own picture goes first, and a
  // sample is only ever a look.
  const sampling = new Map<string, AbortController>();
  // One variant of a picture at a time per reader (local/picture.ts `variant`), beside that one and ended the same way.
  const varying = new Map<string, AbortController>();
  // The looks being compressed from details readers have just written (`compressed`), as many as they wrote: each is
  // one short call, and only the bot's stop ends one.
  const compressing = new Set<AbortController>();
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
  // Whether this reader's scenes are illustrated, so that their menu offers the picture style, the bot's own style
  // line, and the counter of a text's tokens for the characters' card (local/ui.ts `RenderDetails`).
  const pictureInfoOf = (userId: string) => ({ pictures: illustrator?.enabledFor(userId) ?? false,
    standardStyle: illustrator?.standardStyle, textTokens: illustrator?.textTokens });
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
  // A row about one user's request says whether that user is the owner, never who it is. Only the owner allowed
  // reading the owner's own stories for debugging, so a row without `owner` points at a library that stays closed.
  // With no owner configured every row is `other`.
  const logFor = (userId: string): Log => (event, code, details) =>
    log(event, code, { ...safeErrorDetails(details), actor: userId === ownerId ? 'owner' : 'other' });
  const safeSend = async (chat: Chat, screen: Screen, log: Log) => {
    try { await chat.send(screen); log('screen_sent'); } catch (error) { log('telegram_send_failed', errorCode(error)); }
  };
  const last = (state: Library) => {
    const { story, branch, seed } = active(state);
    // A null head (no scenes yet) is never a node id, so the seed is shown.
    const node = story.nodes[branch.head as string];
    return { text: node?.text ?? `${seed.startTime}\n\n${seed.text}`, modelInfo: node?.modelInfo };
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
  function prepare(state: Library, update: Update, fileInput: FileInput | undefined, pictureInfo: RenderDetails): Plan {
    let action = update.callback_query?.data;
    const t = texts(state.language);
    if (fileInput?.error) throw fileInput.error;
    if (fileInput && (state.ui?.input !== 'seed' || state.ui.draftId !== fileInput.draftId)) throw refuse(t, 'draftChanged');
    const text = fileInput ? fileInput.text : messageText(update.message);
    // Writing a picture style, a look, details or the prompt of a variant ends with any button or command, an unknown
    // command included, so that no later message is kept as one by surprise (/last, /model or /typo would otherwise
    // leave the next move to be taken for one).
    if ((action || text?.startsWith('/')) && member(['style', 'look', 'details', 'prompt'], state.ui?.input)) state.ui = null;
    if (!action && !fileInput) {
      const command = text?.split(/[\s@]/)[0];
      const current = state.active;
      const commands: Record<string, string> = {
        '/start': 'view:home', '/menu': 'view:home', '/seeds': 'view:seeds:0',
        '/new': 'new-seed', '/continue': 'continue', '/cancel': 'cancel', '/last': 'last',
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
      state.job = null;
      state.ui = null;
      const menu = render(state, 'home', pictureInfo);
      return { cancel: true, screen: { ...menu, text: (hadJob ? t.notices.cancelled + '\n\n' : '') + menu.text } };
    }
    // Power controls remain available during a seed draft or a model job.
    if (action === 'gpu:pause' || action === 'gpu:start') return { gpuAction: action.slice(4) };
    if (action === 'view:model') return { modelStatus: true };
    // The language can be changed at any moment, also from a draft: a user who cannot read the screen has to get out.
    if (action === 'view:language' || action?.startsWith('lang:')) {
      const draft = state.ui?.input === 'seed';
      if (!draft) state.ui = null;
      if (action === 'view:language') return { screen: render(state, 'language') };
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
      state.ui = route.startsWith('delete-seed:') ? { confirm: route.replace('delete-seed:', 'remove-seed:') }
        : route.startsWith('delete-branch:') ? { confirm: route.replace('delete-branch:', 'remove-branch:') }
        : route.startsWith('delete-style:') ? { confirm: route.replace('delete-style:', 'remove-style:') } : null;
      return { screen: screen(state, route, pictureInfo) };
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
    if (action?.startsWith('look-edit:') || action?.startsWith('details-edit:') || action?.startsWith('portrait:')) {
      const [verb, storyId, index, tag] = action.split(':');
      const person = ID.story.test(storyId) ? personAt(state.stories[storyId], index, tag) : undefined;
      if (!person) throw refuse(t, 'staleButton');
      if (verb === 'look-edit' || verb === 'details-edit') {
        const input = verb === 'look-edit' ? 'look' : 'details';
        state.ui = { input, storyId, name: person.name };
        return { screen: render(state, `${input}-input`, pictureInfo) };
      }
      if (!pictureInfo.pictures) throw refuse(t, 'portraitOff');
      // Names the portrait for its keep button, so that a button of an earlier one never keeps this one.
      const candidate = randomBytes(4).toString('hex');
      return { portrait: { storyId, name: person.name, candidate, status: t.characters.drawing,
        caption: render(state, `portrait:${storyId}:${index}:${tag}:${candidate}`, pictureInfo) } };
    }
    if (action?.startsWith('portrait-keep:')) {
      if (!pictureInfo.pictures || !illustrator) throw refuse(t, 'portraitOff');
      const kept = illustrator.keepPortrait(String(update.callback_query?.from?.id), action.slice(14), state);
      if (!kept) throw refuse(t, 'portraitStale');
      return { screen: render(state, `portrait-kept:${kept.storyId}:${kept.index}`), sweep: true, portraitKept: action.slice(14) };
    }
    // While a look or details are being written, text is that text: one line, whatever the lines it was sent in. The
    // person is looked for again by name, since the story may be gone or its sheet written anew in the meantime.
    if ((state.ui?.input === 'look' || state.ui?.input === 'details') && !action) {
      const { input, storyId, name } = state.ui;
      const look = input === 'look';
      const written = (text ?? '').replace(/\s+/g, ' ').trim();
      if (!written) throw refuse(t, look ? 'lookNeedsText' : 'detailsNeedsText');
      if ([...written].length > (look ? LOOK_CHARS : DETAILS_CHARS)) throw refuse(t, look ? 'lookTooLong' : 'detailsTooLong');
      state.ui = null;
      const sheet = state.stories[storyId]?.sheet ?? [];
      const index = sheet.findIndex(one => one.name === name);
      if (index < 0) throw refuse(t, look ? 'lookGone' : 'detailsGone');
      // The owner's design of 2026-09-26 (docs/illustrations-plan.md#portrait-details): the details are the person's
      // text, portraits are drawn from them as written (local/image-portraits.ts `portraitText`), and the look the
      // frames take is compressed from them. A look the reader writes overrides that one in the frames alone, until they
      // write the details again: those clear it, and a look is compressed from them once this write is committed.
      if (look) {
        const { lookPending, ...person } = sheet[index];
        sheet[index] = { ...person, look: written, edited: true };
        return { screen: render(state, `character:${storyId}:${index}:${personTag(name)}`, pictureInfo) };
      }
      const { edited, ...person } = sheet[index];
      sheet[index] = { ...person, details: written, detailsEdited: true, lookPending: true };
      return { compress: { storyId, name } };
    }
    if (action === 'last') return { savedText: last(state) };
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
      : verb === 'fork' ? ID.story.test(a) && ID.checkpoint.test(b) : true;
    if (!validIds) throw refuse(t, 'staleButton');
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
      return { savedText: last(state), screen: render(state, `branch:${a}:${b}`) };
    }
    if (verb === 'fork') {
      const branch = fork(state, a, b, t.labels);
      state.ui = null;
      return { savedText: last(state), screen: render(state, `branch:${a}:${branch.id}`) };
    }
    let input = text;
    if (verb === 'start') {
      requireGpu(t);
      const { story } = newStory(state, a, t.labels);
      // Sent to the model and kept as the scene's input, so it follows the language of the seed, not of the menus.
      input = storyNarration(state, story.id).startStory;
    } else if (action === 'continue') input = continueInput(state, active(state).story.id);
    else if (action) throw refuse(t, 'staleButton');
    if (!input) return { screen: { text: t.notices.textOnly } };
    if (!state.active) return { screen: render(state, 'home', pictureInfo) };
    requireGpu(t);
    state.ui = null;
    state.interrupted = false;
    const job = beginTurn(state, input, Date.now());
    return { job };
  }

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
    pictureSignal: AbortSignal): Promise<PictureRequest | undefined> {
    const log = logFor(userId);
    let prepare = false;
    let picture: PictureRequest | undefined;
    // The language at the start of the job serves its status message and the labels it stores; later messages read it again.
    const language = store.read(userId).language;
    const labels = texts(language).labels;
    const notices = () => texts(store.read(userId).language).notices;
    const progress = createProgress({ chat, render: status => renderCompaction(status, language), signal: controller.signal, log });
    let compactionStatus: CompactionStatus | undefined;
    const onProgress = (event: CompactionStatus) => {
      compactionStatus = { ...compactionStatus, ...event, automatic: job.kind !== 'compact' };
      progress.update(compactionStatus);
    };
    const reportFailure = async (error: unknown) => {
      // Thrown values are not checked: ModelError carries these fields, other errors lack them.
      const failure = error as { code?: string | number; operation?: string };
      if (member(['provider_failed', 'timeout', 'unauthorized', 'model_unavailable', 'unexpected_model'], failure.code)) {
        Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
      }
      log('generation_failed', failure.code, error);
      const retry = job.kind === 'compact' ? '/compact' : '/continue';
      if (failure.operation === 'compact' && compactionStatus?.stage === 'failed') {
        if (!await progress.finish()) await safeSend(chat, renderCompaction(compactionStatus, language), log);
        return;
      }
      const snapshot = store.read(userId);
      const t = texts(snapshot.language);
      const text = failure.code === 'nothing_to_compact' ? t.notices.nothingToCompactYet(keepScenes)
        : failure.code === 'context_limit' ? t.notices.contextLimit
        : failure.code === 'invalid_memory' || failure.code === 'memory_not_smaller' ? t.notices.compactionUnverified(retry)
        : unavailable(failure) ? t.notices.modelUnavailable
        : t.notices.failed(retry);
      await safeSend(chat, { text, reply_markup: sceneKeyboard(snapshot) }, log);
    };
    try {
      if (job.kind === 'compact') {
        // compactBranch writes the log rows of a compaction, manual or automatic, with its sizes and counts.
        const result = await inTurn(provider, provider => compactBranch({ store, userId, jobId: job.id, provider,
          config: contextConfig, signal: controller.signal, prepared: preparedFor(userId), onProgress, log, labels }), { holder: userId });
        const completed = store.mutate(userId, state => {
          if (controller.signal.aborted || !jobTarget(state, job.id)) return false;
          state.job = null;
          return true;
        });
        if (!completed) return;
        modelResponded();
        if (!await progress.finish()) await safeSend(chat, renderCompaction({ ...compactionStatus, stage: 'done', ...result }, language), log);
        return;
      }
      let usage: GenerationResult['usage'];
      // Statuses share the scene's draft. They go out one after another; one already superseded by a newer status is
      // skipped, and none goes out once the scene's text has begun or the turn is over. The text and every later
      // message wait for the status in flight, so a stale status never lands on top of them.
      let status = Promise.resolve();
      let latest = '', over = false, queued = false, reading = false;
      const show = (text: string) => {
        latest = text;
        status = status.then(() => over || latest !== text ? undefined : chat.status(job.id, text));
      };
      const endStatus = () => { over = true; return status; };
      const outcome = await runTurn({ store, userId, job, provider, config: contextConfig, signal: controller.signal,
        prepared: preparedFor(userId), onProgress, log, labels,
        waiting: ahead => {
          if (reading) return;
          const wait = texts(store.read(userId).language).wait;
          if (ahead === null) { reading = true; show(wait.reading); }
          else if (ahead > 0) { queued = true; show(wait.queued(ahead)); }
          else if (queued) show(wait.next);
        },
        preview: (state, current, request) => {
          const measured = stats(state);
          // generateScene sets the estimate before it asks for a preview.
          if (measured) measured.request.estimatedTokens = request.estimatedInputTokens!;
          const onText = chat.preview(current.id, scenePrefix(measured, modelInfo, state.language));
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
        const prefix = scenePrefix(stats(snapshot, { storyId: ref.storyId, checkpointId: ref.checkpointId }), node.modelInfo, snapshot.language);
        // Bot API results are not validated; the id of the sent message is stored as returned.
        const sent = await chat.final(prefix + node.text, sceneKeyboard(snapshot)) as { message_id: number };
        store.mutate(userId, state => {
          const saved = state.stories[ref.storyId]?.nodes[ref.nodeId];
          if (saved) { saved.delivery = 'sent'; saved.messageId = sent.message_id; }
        });
        log('scene_saved_and_sent');
        // The wait for the picture starts here, at the scene the reader is now reading. A scene that was not
        // delivered is not illustrated: the photo would hang under nothing.
        if (illustrator?.enabledFor(userId) && !pictureSignal.aborted) {
          picture = { userId, chat, storyId: ref.storyId, nodeId: ref.nodeId, branchId: ref.branchId,
            sceneMessageId: sent.message_id, sceneAt: Date.now(), signal: pictureSignal, log, hold: () => gpu?.acquire(),
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
        state.job = null;
        return true;
      });
      if (!stillCurrent || controller.signal.aborted) return;
      await reportFailure(error);
    } finally {
      await progress.finish();
      releaseGpu?.();
      if (prepare && !controller.signal.aborted && !picture) prepareNext(userId);
    }
    return picture;
  }

  // The look compressed from the details a reader has just written (local/picture.ts `compressLook`), then the person's
  // card in place of the status line that stood meanwhile: the new look, or the word that it is still to be compressed.
  // Only for a reader who is drawn for, and only while the language model's GPU is up, which it keeps up as a job does
  // and never wakes; the look is otherwise compressed before the next picture of the story, and the card says so at once.
  async function compressed(userId: string, chat: Chat, { storyId, name }: { storyId: string; name: string }, signal: AbortSignal) {
    const log = logFor(userId);
    let status: number | undefined;
    if (!illustrator?.enabledFor(userId)) log('look_compressed', 'pictures_off', { outcome: 'skipped' });
    else {
      let release: (() => void) | undefined;
      let held = true;
      try { release = gpu?.acquire(); }
      catch {
        held = false;
        log('look_compressed', 'gpu_not_ready', { outcome: 'skipped' });
      }
      if (held) {
        try {
          try { status = (await chat.send({ text: texts(store.read(userId).language).characters.compressing }) as { message_id?: number }).message_id; }
          catch (error) { log('telegram_send_failed', errorCode(error)); }
          await illustrator.compressLook({ userId, storyId, name, signal, log });
        } finally { release?.(); }
      }
    }
    const state = store.read(userId);
    const index = state.stories[storyId]?.sheet?.findIndex(one => one.name === name) ?? -1;
    // A person gone meanwhile opens the story's people, and a story gone says so (local/ui.ts).
    const card = render(state, `character:${storyId}:${index}:${personTag(name)}`, pictureInfoOf(userId));
    if (status !== undefined) {
      try { await chat.edit(status, card); log('screen_sent'); return; }
      catch { try { await chat.remove(status); } catch { /* a hint, never needed */ } }
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
      const chat = createChat(api, chatInfo.id);
      const log = logFor(userId);
      if (update.callback_query?.id) {
        try { await api('answerCallbackQuery', { callback_query_id: update.callback_query.id }); } catch {}
      }
      let fileInput: FileInput | undefined;
      if (update.message?.document) {
        const state = store.read(userId);
        if (state.seen.includes(update.update_id)) return;
        const t = texts(state.language);
        if (state.ui?.input !== 'seed') {
          fileInput = { error: refuse(t, 'fileNeedsDraft') };
        } else {
          const draftId = state.ui.draftId;
          try {
            if (!readSeedFile) throw new Error('file_reader_unavailable');
            fileInput = { draftId, text: await readSeedFile(update.message.document) };
          } catch (error) {
            fileInput = { error: error instanceof UserError ? error : refuse(t, 'fileFailed') };
          }
        }
      }
      const plan = store.mutate(userId, state => {
        if (state.seen.includes(update.update_id)) return null;
        // First contact: nothing was handled or created yet, so Telegram's language is the best guess. A library that
        // already exists keeps what it has; without a stored language it stays Russian (text.ts).
        if (state.language === undefined && !state.seen.length && !state.seq) setLanguage(state, langFromTelegram(from?.language_code));
        state.seen = [...state.seen.slice(-511), update.update_id];
        try { return prepare(state, update, fileInput, pictureInfoOf(userId)); }
        catch (error) {
          if (error instanceof UserError) return { screen: { text: errorText(texts(state.language), error) } };
          throw error;
        }
      });
      if (!plan) return;
      if (plan.portraitKept) illustrator?.portraitKept(userId, plan.portraitKept);
      if (plan.sweep) {
        try { store.sweepPortraits(userId); } catch (error) { log('portraits_unswept', fileErrorCode(error)); }
      }
      if (plan.gpuAction) {
        // simple-serving starts and sleeps its own card, so there is nothing here to start
        // (docs/model-providers.md#simple-serving-our-gateway).
        const notices = texts(store.read(userId).language).notices;
        if (!gpu) await safeSend(chat, { text: providerName === 'simple-serving' ? notices.modelServiceSeparate : notices.gpuNotConfigured }, log);
        else {
          try {
            if (plan.gpuAction === 'pause') gpu.pause(); else gpu.resume();
            void gpu.tick();
          } catch { /* Current controller state is rendered below. */ }
          await safeSend(chat, render(store.read(userId), 'model'), log);
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
        await safeSend(chat, render(store.read(userId), 'model'), log);
      }
      if (plan.cancel) { running.get(userId)?.controller.abort(); sampling.get(userId)?.abort(); varying.get(userId)?.abort(); }
      if (plan.savedText) {
        const snapshot = store.read(userId);
        try { await chat.final(scenePrefix(stats(snapshot), plan.savedText.modelInfo, snapshot.language) + plan.savedText.text, sceneKeyboard(snapshot)); }
        catch (error) { log('saved_scene_delivery_unconfirmed', errorCode(error)); }
      }
      if (plan.screen) await safeSend(chat, plan.screen, log);
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
        if (sampling.has(userId)) await safeSend(chat, { text: t.errors.sampleInFlight }, log);
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
        if (sampling.has(userId)) await safeSend(chat, { text: texts(store.read(userId).language).errors.portraitInFlight }, log);
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
      // Details the reader wrote are kept whatever the model does with them, and the card that follows says what became
      // of the look. Beside every other request of theirs: it is one short call, and their next scene waits for it.
      if (plan.compress) {
        const stop = new AbortController();
        compressing.add(stop);
        const task: Promise<unknown> = compressed(userId, chat, plan.compress, stop.signal)
          .catch(error => log('turn_task_failed', errorCode(error)))
          .finally(() => {
            compressing.delete(stop);
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
      // Beside a sample or a portrait, and with nothing held on the language model's card: a variant never asks it
      // anything.
      if (plan.variant && illustrator) {
        if (varying.has(userId)) await safeSend(chat, { text: texts(store.read(userId).language).errors.variantInFlight }, log);
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
          store.mutate(userId, state => { if (state.job?.id === plan.job!.id) state.job = null; });
          await safeSend(chat, { text: texts(store.read(userId).language).notices.gpuPaused }, log);
          return;
        }
        const controller = new AbortController();
        const picture = new AbortController();
        controller.signal.addEventListener('abort', () => picture.abort(), { once: true });
        const entry: Running = { controller, picture };
        const earlier = running.get(userId);
        running.set(userId, entry);
        // This reader's own previous turn is over — the job lock saw to that — but its picture may still be on the
        // other card. They have answered, so that picture belongs to a scene they have read past: it is dropped,
        // and the card is told to stop drawing it (local/picture.ts, local/image-batch.ts `stopJob`). Only the
        // picture: the turn behind it may still be delivering a message, and its own controller stands for a scene
        // the reader was never given, which this is not.
        earlier?.picture.abort();
        sampling.get(userId)?.abort();
        varying.get(userId)?.abort();
        // The picture is made after the turn's model work is over and its GPU hold released: the second call takes
        // a slot again, and the drawing takes none at all, so neither may sit inside the turn.
        const task: Promise<unknown> = generate(userId, chat, plan.job, controller, releaseGpu, picture.signal)
          .then(picture => picture && illustrator?.illustrate(picture))
          // The net under the whole chain, so that one throw cannot take the shutdown of the bot (`idle`) with it.
          // The turn reports its own failures to the reader and the picture its own outcomes, so a row here is
          // something neither of them expected — and on an install with no pictures it is never about one.
          .catch(error => log('turn_task_failed', errorCode(error)))
          .finally(() => {
            if (running.get(userId) === entry) running.delete(userId);
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
    },
    async idle() { await Promise.all([...inFlight, ...preparing]); },
    async stop() {
      for (const entry of prepared.values()) entry.stop();
      for (const entry of running.values()) entry.controller.abort();
      for (const stop of sampling.values()) stop.abort();
      for (const stop of varying.values()) stop.abort();
      for (const stop of compressing) stop.abort();
      await this.idle();
    },
  };
}
