// Telegram interface for simple-story-chat: pure functions from a user's library to sendMessage payloads.
// Plain text only (no parse_mode), inline keyboards, callbacks <= 64 UTF-8 bytes.

import type { Branch, Checkpoint, Library, Pace, SceneNode, Story } from '../lib/library.ts';
import type { ContextStats } from './context.ts';
import type { GpuStatus } from './gpu.ts';
import type { InlineButton, InlineKeyboard, Screen } from './telegram.ts';
import { STYLE } from './illustrate.ts';
import { portraitFromDetails, portraitText } from './image-portraits.ts';
import { DESCRIPTION_CHARS, LOOK_CHARS, descriptionOf, ownDescription, ownPortraitPrompt, personAt, personTag, wornAt } from './picture.ts';
import { REFERENCE_BYTES, REFERENCE_SIDES } from './reference.ts';
import { POSE_SET_BYTES, POSE_SET_PICTURES, POSE_SET_READER_BYTES, poseGroups, poseSetState } from './pose-set.ts';
import { POSE_SET_REFUSALS } from './model-error.ts';
import type { PoseSetRefusal } from './model-error.ts';
import { ARCHIVE_BYTES } from './pose-archive.ts';
import type { ArchiveLabels } from './pose-archive.ts';
import { seesThrough } from './picture-pov.ts';
import { editableFrom, ownVersions, personKey, sceneOf, sheetAt, versionsOf } from './picture-versions.ts';
import { CHANGES_CHARS, CLOTHES_CHARS, DETAILS_CHARS, fieldsMask, maskFields, profileBlock, profileHash, profileOf, roundTrips } from './profile.ts';
import type { ProfileField } from './profile.ts';
import { OWN_NAME_CHARS, OWN_STYLE_CHARS, OWN_STYLES_MAX, PRESETS, PROMPT_CHARS, lineOf, ownStyle, ownStyles, pickerKeys, presetOf, styleKey } from './picture-style.ts';
import { LANGS, LANGUAGE_BUTTON, REGISTERED, shownLang, texts } from './text.ts';
import type { Messages } from './text.ts';

// Model metadata or scene provenance. Old scenes may lack it and stored values are not trusted.
export type ModelInfo = { provider?: string; model?: string; status?: string; checkedAt?: string | null };
// A GPU controller snapshot. Rendering keeps a fallback for any other status.
export type GpuInfo = {
  status?: GpuStatus; activeJobs?: number | null; idleMinutes?: number; idleRemainingSeconds?: number | null;
  canStart?: boolean; canPause?: boolean;
};
// `pictures`: this reader's scenes are illustrated (local/picture.ts), so the menu offers the picture style.
// `standardStyle`: the bot's own style line, when it draws for anybody.
// `textTokens`: the tokens of one field of a sheet as the picture model reads that text alone, null when unknown.
// `retainsPortraits`: the keep confirmation explains retention for a reader in the reference experiment.
// `references`: the reader is in the reference experiment (local/picture.ts `referencesFor`), so a person's card offers
// to send a portrait of their own; anybody else is shown the card as if they could not.
// `versions`: the reader has versions of the sheet (local/picture.ts `versionsFor`), so the wait for a person's text
// offers to write it «only from this moment», and a person's card says where such an edit holds.
// `poseSet`: the reader has pose sets (local/picture.ts `poseSetFor`), so a person's card offers to send one and says
// that frames take it; a set a person has is shown, with the button that removes it, whatever this says. `poseTally`:
// the pictures of a set counted as they come (local/bot.ts), for the message that counts them: those kept, those of them
// the reader labeled whole in an archive's labels.csv, those refused by reason, and each labels.csv that came, by the
// name of its archive (local/pose-archive.ts `ArchiveLabels`).
// `miniApp`: the Mini App's address, for a reader it serves (local/mini-app.ts), so that the list of a story's characters
// has a button that opens it there.
export type RenderDetails = {
  modelInfo?: ModelInfo | null; gpuInfo?: GpuInfo | null; contextStats?: ContextStats | null; pictures?: boolean; standardStyle?: string;
  textTokens?: (text: string) => number | null;
  retainsPortraits?: boolean; references?: boolean; versions?: boolean; poseSet?: boolean; poseTally?: PoseTally; miniApp?: string;
};
// `unread`: the files of the wait still in the reader's queue; `finishing`: the wait is over, and they are still read.
export type PoseTally = { storyId: string; name: string; at: number; kept: number; labeled: number; refused: Partial<Record<PoseSetRefusal, number>>;
  archives: (ArchiveLabels & { archive: string })[]; unread?: number; finishing?: boolean; done: boolean };
// State is read defensively (docs/telegram-ui.md#renderer), so any library field may be missing.
type State = Partial<Library>;
type Row = (InlineButton | null)[];
type Page<T> = { page: number; pages: number; start: number; items: T[] };

export const LIMIT = 4000; // Telegram allows 4096 characters; keep headroom
const PAGE = 8;
const encoder = new TextEncoder();
const ICON: Record<string, string> = { start: '🌱', fork: '🌿', scene: '🎬', manual: '📌', compaction: '🗜' };
// The paces in the picker's order (lib/library.ts `PACES`).
const PACE_ICON: Record<Pace, string> = { moment: '⚡', scene: '🎬', chapter: '🗓' };

// The interface language is state.language (lib/library.ts); functions that get no state take it as `lang`.
export function render(state?: Library | null, route: string | null = 'home', details: RenderDetails | null = {}): Screen {
  try {
    return screen(state ?? {}, String(route ?? 'home'), details ?? {});
  } catch {
    return failure(texts(state?.language));
  }
}

// Detailed context screen, shown only on request (/context or a Context button).
export function renderContext(stats: ContextStats | null | undefined, lang?: unknown): Screen {
  const t = texts(lang);
  try {
    if (!stats || typeof stats !== 'object') {
      return payload([t.context.none], [[btn(t.buttons.menu, 'view:home')]]);
    }
    return contextView(t, stats);
  } catch {
    return failure(t);
  }
}

// One-line Markdown header above a scene in Telegram. Never saved as narrative or sent to the model.
// `provenance` is the scene's own {provider, model}; without it the scene is not labelled.
// Uses only characters that need no escaping in Markdown flavours.
export function scenePrefix(stats: ContextStats | null | undefined, provenance?: ModelInfo | null, lang?: unknown): string {
  try {
    const t = texts(lang);
    const parts = [];
    if (modelKnown(provenance)) {
      parts.push(`🤖 ${t.model.providers[provenance.provider].short} · ${markdownSafe(line(provenance.model, 60))}`);
    }
    const request = stats?.request?.estimatedTokens;
    const limit = stats?.limitTokens;
    if (known(request) && known(limit) && request >= 0 && limit > 0) {
      const percent = (request / limit) * 100;
      const rough = stats?.request?.estimateSource !== 'usage';
      parts.push(percent > 0 && percent < 1 ? t.scenePrefix.contextBelowOne(rough) : t.scenePrefix.context(Math.round(percent), rough));
    }
    return parts.length ? `_${parts.join(' · ')}_\n\n` : '';
  } catch {
    return '';
  }
}

export function sceneKeyboard(state: Library | null | undefined): InlineKeyboard | undefined {
  if (!state) return undefined;
  const b = texts(state.language).buttons;
  if (state.job) {
    return keyboard([
      [btn(b.stop, 'cancel')],
      [btn(b.context, 'view:context'), btn(b.model, 'view:model'), btn(b.menu, 'view:home')],
    ]);
  }
  const ref = activeRef(state);
  if (!ref) return undefined;
  const { story, branch } = ref;
  return keyboard([
    [btn(b.continue, 'continue'), btn(b.context, 'view:context'), btn(b.model, 'view:model')],
    [btn(b.checkpoints, `view:checkpoints:${story.id}:${branch.id}:0`), btn(b.branches, `view:story:${story.id}`), btn(b.menu, 'view:home')],
  ]);
}

function failure(t: Messages) {
  return payload([t.common.failure, t.common.failureHint], [[btn(t.buttons.menu, 'view:home')]]);
}

function screen(state: State, route: string, details: RenderDetails) {
  const [name, ...args] = route.split(':');
  switch (name) {
    case 'home': return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
    case 'model': return modelScreen(texts(state.language), details.modelInfo, gpuFor(details));
    case 'language': return languageScreen(state);
    case 'pace': return paceScreen(state, args[0]);
    case 'style': return args.length ? styleCard(state, args[0], details) : styleScreen(state, details);
    // Only while the reader is writing a style: otherwise their next message would be taken as a move in the story.
    case 'style-input': return styleInputScreen(state, details);
    // The same for the prompt of a variant of a picture.
    case 'prompt-input': return promptInputScreen(state, details);
    case 'delete-style': return deleteStyleScreen(state, args[0], details);
    case 'sample': return sampleScreen(state, args[0], details);
    case 'characters': return charactersScreen(state, args[0], details);
    case 'character': return characterScreen(state, args[0], args[1], args[2], details);
    // Only while the reader is writing a look or a description, as for a style.
    case 'look-input': return sheetInputScreen(state, 'look', details);
    case 'details-input': return sheetInputScreen(state, 'details', details);
    case 'portrait': return portraitCaption(state, args[0], args[1], args[2], args[3]);
    case 'portrait-kept': return portraitKept(state, args[0], args[1], details.retainsPortraits === true);
    // Only while the reader is writing the prompt of a person's portraits, as for a look.
    case 'portrait-prompt-input': return portraitPromptInputScreen(state, details);
    // Only while the reader is to send a picture of a person of their own (local/reference.ts), as for a look.
    case 'reference-input': return referenceInputScreen(state, details);
    // Only while the reader is to send the pictures of a pose set (local/pose-set.ts), as for a look; the message that
    // counts them as they come; and the question before a set is removed.
    case 'pose-set-input': return poseSetInputScreen(state, details);
    case 'pose-set-status': return poseSetStatus(state, details);
    case 'pose-set-drop': return poseSetDropScreen(state, args[0], args[1], args[2], details);
    // A person's whole profile to copy and send back (local/profile.ts); the same with a line on top when the one the
    // reader edited had changed since (local/bot.ts); the wait for it, as for a look; and what a profile sent back changed.
    case 'profile': return profileScreen(state, args[0], args[1], args[2], details);
    case 'profile-changed': return profileScreen(state, args[0], args[1], args[2], details, texts(state.language).characters.profileChanged);
    case 'profile-input': return profileInputScreen(state, details);
    case 'profile-saved': return profileSaved(state, args[0], args[1], args[2], args[3]);
    case 'seeds': return seedList(state, args[0]);
    case 'seed': return seedScreen(state, args[0], args[1], details.pictures === true);
    case 'story': return storyScreen(state, args[0], args[1], details.pictures === true);
    case 'tree': return treeScreen(state, args[0]);
    case 'log': return logScreen(state, args[0], args[1], args[2]);
    case 'branch': return branchScreen(state, args[0], args[1]);
    case 'checkpoints': return checkpointList(state, args[0], args[1], args[2]);
    case 'checkpoint': return checkpointScreen(state, args[0], args[1]);
    case 'context': return args.length ? checkpointContextScreen(state, args[0], args[1], details.contextStats) : currentContextScreen(state, details.contextStats);
    case 'delete-seed': return deleteSeedScreen(state, args[0]);
    case 'delete-branch': return deleteBranchScreen(state, args[0], args[1]);
    case 'new-seed': return newSeedScreen(state);
    default: return home(state, texts(state.language).home.unknownRoute, details.modelInfo, gpuFor(details), details.pictures === true);
  }
}

// Screens

function home(state: State, note: string | null, modelInfo: ModelInfo | null | undefined, gpu: GpuInfo | null, pictures: boolean) {
  const t = texts(state.language);
  const seedCount = values(state.seeds).length;
  const ref = activeRef(state);
  const lines = note ? [note, ''] : [];
  const rows: Row[] = [];
  lines.push(t.home.title, '');
  if (modelKnown(modelInfo)) {
    lines.push(`🤖 ${t.model.providers[modelInfo.provider].short} · ${line(modelInfo.model, 60)} · ${statusShort(t, modelInfo)}`);
  }
  if (gpu) lines.push(t.home.gpu(gpuShort(t, gpu)));
  if (modelKnown(modelInfo) || gpu) lines.push('');
  if (state.job) {
    const jobStory = own(state.stories, state.job.storyId);
    const name = jobStory ? storyName(state, jobStory) : null;
    const compact = state.job.kind === 'compact';
    lines.push(compact ? t.home.compactJob(name) : t.home.sceneJob(name), compact ? t.home.compactJobNote : t.home.sceneJobNote, '');
    rows.push(cancelRow(state));
  }
  if (ref) {
    const { story, branch } = ref;
    lines.push(t.home.current(storyName(state, story)), t.home.branch(quote(t, branch.name), progress(t, story, branch)));
    if (!state.job) {
      lines.push('', t.home.howToContinue);
      rows.push([btn(t.buttons.continue, 'continue'), branch.head ? btn(t.buttons.lastScene, 'last') : null]);
    } else if (branch.head) {
      rows.push([btn(t.buttons.lastScene, 'last')]);
    }
    rows.push([btn(t.pace.button(t.pace.names[paceOf(story)]), `view:pace:${story.id}`)]);
    rows.push([
      btn(t.buttons.checkpoints, `view:checkpoints:${story.id}:${branch.id}:0`),
      btn(t.buttons.branches, `view:story:${story.id}`),
      btn(t.buttons.context, 'view:context'),
    ]);
  } else if (seedCount) {
    lines.push(t.home.noStory, t.home.noStoryHint);
  } else {
    lines.push(t.home.empty, t.common.whatIsSeed, '', t.home.createFirst);
  }
  rows.push([seedCount ? btn(t.buttons.seedsCount(seedCount), 'view:seeds:0') : null, btn(t.buttons.newSeed, 'new-seed'), btn(t.buttons.model, 'view:model')]);
  rows.push([btn(LANGUAGE_BUTTON, 'view:language'), pictures ? btn(t.buttons.pictureStyle, 'view:style') : null,
    pictures && ref ? btn(t.buttons.characters, `view:characters:${ref.story.id}`) : null]);
  return payload(lines, rows);
}

// Languages under their own names, so the screen can be read in any of them.
function languageScreen(state: State) {
  const t = texts(state.language);
  const current = shownLang(state.language);
  return payload([t.language.title, '', t.language.note], [
    ...REGISTERED.map(lang => [btn(`${lang === current ? '✅ ' : ''}${LANGS[lang]}`, `lang:${lang}`)]),
    [btn(t.buttons.menu, 'view:home')],
  ]);
}

// A story's pace (lib/library.ts `Story.pace`), from the menu: what each pace does and who moves the hero, and the three
// to choose from. A press only stores the choice; the next scene request reads it (local/prompt.ts).
function paceScreen(state: State, storyId: string | undefined) {
  const t = texts(state.language);
  const p = t.pace;
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  const current = paceOf(story);
  const paces = Object.keys(PACE_ICON) as Pace[];
  return payload([p.title, `📖 ${storyName(state, story)}`, '', ...paces.map(pace => `${PACE_ICON[pace]} ${p.lines[pace]}`), '', p.move, p.next], [
    paces.map(pace => btn(`${pace === current ? '✅ ' : ''}${PACE_ICON[pace]} ${p.names[pace]}`, `pace:${story.id}:${pace}`)),
    [btn(t.buttons.menu, 'view:home')],
  ]);
}

// The look of the reader's pictures (local/picture-style.ts): the presets, the reader's own styles, and the bot's own
// line when it is not one of the presets. Every style opens its card, and a reader who is drawn for may ask for the
// last scene in all of them at once. A reader who is not drawn for may still choose: the choice waits in their library.
function styleScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const s = t.pictureStyle;
  const standard = details.standardStyle ?? STYLE;
  const current = styleKey(state, standard);
  const own = ownStyles(state);
  const open = (key: string) => btn(`${key === current ? '✅ ' : ''}${styleLabel(t, state, key)}`, `view:style:${key}`);
  return payload([s.title, '', s.current(styleLabel(t, state, current)), '', s.note, details.pictures ? null : '', details.pictures ? null : s.off], [
    ...pickerKeys(state, standard).map(key => [open(key)]),
    own.length < OWN_STYLES_MAX ? [btn(s.add, 'style-new')] : null,
    details.pictures ? [btn(s.sampleAll, 'style-samples')] : null,
    [btn(t.buttons.menu, 'view:home')],
  ]);
}

// A style's name as its button shows it.
function styleLabel(t: Messages, state: State, key: string) {
  const s = t.pictureStyle;
  if (key === 'standard') return s.standard;
  if (Object.hasOwn(PRESETS, key)) return s.presets[key as keyof typeof PRESETS];
  return s.own(line(ownStyle(state, key)?.name, OWN_NAME_CHARS) || t.format.untitled);
}

// One style: the whole line it ends a prompt with, tap-to-copy, so that a reader can start a style of their own from
// any of them; the empty one says that it has none, since a block of no characters has nothing to tap. The sample is
// drawn only when the reader asks for it (local/picture.ts `sample`). A key this library has no style under — a style
// deleted since, or the standard one where a preset stands for it — is the picker.
function styleCard(state: State, key: string, details: RenderDetails) {
  const t = texts(state.language);
  const s = t.pictureStyle;
  const standard = details.standardStyle ?? STYLE;
  const full = lineOf(state, key, standard);
  if (full === null || (key === 'standard' && presetOf(standard))) return styleScreen(state, details);
  const own = ownStyle(state, key);
  const chosen = styleKey(state, standard) === key;
  const result = payload([styleLabel(t, state, key), chosen ? s.chosen : null, '', full ? s.prompt : s.promptEmpty, full || null,
    details.pictures ? null : '', details.pictures ? null : s.off], [
    chosen ? null : [btn(s.choose, `style:${key}`)],
    details.pictures ? [btn(s.sample, `style-sample:${key}`)] : null,
    own ? [btn(s.edit, `style-edit:${key}`), btn(s.remove, `view:delete-style:${key}`)] : null,
    [btn(s.back, 'view:style')],
  ]);
  const offset = full ? result.text.indexOf(full, result.text.indexOf(s.prompt)) : -1;
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: full.length }];
  return result;
}

function deleteStyleScreen(state: State, key: string, details: RenderDetails) {
  const t = texts(state.language);
  const s = t.pictureStyle;
  const own = ownStyle(state, key);
  if (!own) return styleScreen(state, details);
  const standard = details.standardStyle ?? STYLE;
  const chosen = styleKey(state, standard) === key;
  // After the deletion the pictures are drawn in the style a reader who never chose one gets.
  const fallback = quote(t, styleLabel(t, state, presetOf(standard) ?? 'standard'), 60);
  return payload([s.removeTitle(quote(t, own.name, OWN_NAME_CHARS)), chosen ? '' : null, chosen ? s.removeChosen(fallback) : null],
    [[btn(s.removeYes, `remove-style:${key}`)], [btn(s.removeNo, `view:style:${key}`)]]);
}

// Waiting for a style of the reader's own: a new one, or a new version of the one `styleId` names. The next text
// message is kept as it, and any button leaves. Without the wait this is the picker: otherwise the reader's next
// message would be taken for a move in the story.
function styleInputScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const s = t.pictureStyle;
  const ui = state.ui?.input === 'style' ? state.ui : null;
  if (!ui) return styleScreen(state, details);
  if (ui.styleId) {
    const own = ownStyle(state, ui.styleId);
    if (!own) return styleScreen(state, details);
    const result = payload([s.editTitle(quote(t, own.name, OWN_NAME_CHARS)), '', s.editNote(OWN_STYLE_CHARS), '', s.nowText, own.line],
      [[btn(s.backToStyle, `view:style:${own.id}`)]]);
    const offset = result.text.lastIndexOf(own.line);
    if (offset >= 0) result.entities = [{ type: 'pre', offset, length: own.line.length }];
    return result;
  }
  const example = s.exampleText;
  const result = payload([s.newTitle, '', s.inputNote(OWN_STYLE_CHARS, OWN_NAME_CHARS), '', s.example, example, '', s.copyHint],
    [[btn(s.back, 'view:style')]]);
  const offset = result.text.indexOf(example);
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: example.length }];
  return result;
}

// Waiting for the whole prompt of a variant of a picture (local/picture.ts `variant`), which the reader copies from the
// note under it. The next text message is taken as it, and any button leaves. Without the wait this is the menu.
function promptInputScreen(state: State, details: RenderDetails) {
  const v = texts(state.language).variant;
  if (state.ui?.input !== 'prompt') return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  return payload([v.title, '', v.note(PROMPT_CHARS)], [[btn(v.leave, 'view:home')]]);
}

// The caption and the buttons of a sample of a style (local/picture.ts `sample`), as they stand when it is asked for.
function sampleScreen(state: State, key: string, details: RenderDetails) {
  const t = texts(state.language);
  const s = t.pictureStyle;
  const chosen = styleKey(state, details.standardStyle ?? STYLE) === key;
  return payload([s.sampleCaption(styleLabel(t, state, key))], [chosen ? null : [btn(s.choose, `style:${key}`)], [btn(s.back, 'view:style')]]);
}

// Deployment is chosen by the owner in the bot's config, so there is no switch here.
// GPU start/pause is power control for the configured server, not provider selection.
function modelScreen(t: Messages, info: ModelInfo | null | undefined, gpu: GpuInfo | null) {
  const rows: Row[] = [];
  const lines = [t.model.title, ''];
  if (!modelKnown(info)) {
    lines.push(t.model.noData);
  } else {
    const time = checkedTime(info.checkedAt);
    lines.push(t.model.provider(t.model.providers[info.provider].full), t.model.name(line(info.model, 100)), t.model.notes[info.provider], '');
    if (info.status === 'ready') lines.push(t.model.ready(time), t.model.readyNote);
    else if (info.status === 'unavailable') lines.push(t.model.unavailable(time), t.model.unavailableNote);
    else if (info.status === 'configured') lines.push(t.model.configured);
    else lines.push(t.model.unknown);
  }
  if (gpu) {
    lines.push('', ...gpuLines(t, gpu));
    rows.push([
      gpu.canStart === true ? btn(t.gpu.start, 'gpu:start') : null,
      gpu.canPause === true ? btn(t.gpu.pause, 'gpu:pause') : null,
    ]);
  }
  lines.push('', t.model.footer);
  rows.push([btn(t.buttons.refresh, 'view:model'), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function gpuLines(t: Messages, gpu: GpuInfo) {
  const jobs = jobCount(gpu.activeJobs);
  const lines = [t.gpu.title];
  switch (gpu.status) {
    case 'ready': {
      lines.push(t.gpu.ready(jobs));
      if (known(gpu.idleMinutes) && gpu.idleMinutes > 0) lines.push(t.gpu.autoPause(Math.round(gpu.idleMinutes)));
      if (jobs === 0 && known(gpu.idleRemainingSeconds) && gpu.idleRemainingSeconds >= 0) {
        lines.push(gpu.idleRemainingSeconds < 60 ? t.gpu.untilPauseSoon : t.gpu.untilPause(Math.ceil(gpu.idleRemainingSeconds / 60)));
      }
      break;
    }
    case 'draining': lines.push(t.gpu.draining(jobs), t.gpu.drainingNote); break;
    case 'stopping': lines.push(t.gpu.stopping); break;
    case 'paused': lines.push(t.gpu.paused, t.gpu.pausedNote); break;
    case 'starting': lines.push(t.gpu.starting); break;
    case 'error': lines.push(t.gpu.error); break;
    default: lines.push(t.gpu.unknown);
  }
  if (gpu.canPause === true) lines.push(t.gpu.pauseHint);
  if (gpu.canStart === true) lines.push(t.gpu.startHint);
  lines.push(t.gpu.storageNote);
  return lines;
}

function gpuShort(t: Messages, gpu: GpuInfo) {
  const jobs = jobCount(gpu.activeJobs);
  switch (gpu.status) {
    case 'ready': return t.gpu.short.ready(jobs);
    case 'draining': return t.gpu.short.draining(jobs);
    case 'stopping': return t.gpu.short.stopping;
    case 'paused': return t.gpu.short.paused;
    case 'starting': return t.gpu.short.starting;
    case 'error': return t.gpu.short.error;
    default: return t.gpu.short.unknown;
  }
}

// details.gpuInfo arrives only for a configured Vast GPU; never show controls for the Claude provider.
function gpuFor(details: RenderDetails) {
  const gpu = details.gpuInfo;
  if (!gpu || typeof gpu !== 'object') return null;
  if (details.modelInfo?.provider === 'claude-code') return null;
  return gpu;
}

function jobCount(value: unknown) {
  return known(value) && value >= 0 ? Math.round(value) : null;
}

function seedList(state: State, rawPage: string | undefined) {
  const t = texts(state.language);
  const seeds = ordered(values(state.seeds));
  if (!seeds.length) {
    return payload(
      [t.seeds.title, '', t.seeds.none, t.common.whatIsSeed],
      [[btn(t.buttons.newSeed, 'new-seed')], [btn(t.buttons.menu, 'view:home')]],
    );
  }
  const p = paginate(seeds, rawPage);
  const activeSeed = own(state.stories, state.active?.storyId)?.seedId;
  const lines = [t.seeds.titleCount(seeds.length), pageNote(t, p), ''];
  const rows: Row[] = [];
  p.items.forEach((seed, i) => {
    const n = p.start + i + 1;
    const stories = storiesOf(state, seed.id).length;
    const summary = stories ? t.count.stories(stories) : t.seeds.noStories;
    lines.push(`${n}. ${quote(t, seed.title, 60)} · ${summary}${seed.id === activeSeed ? ` · ${t.common.current}` : ''}`);
    rows.push([btn(`${n}. ${line(seed.title, 40) || t.format.untitledButton}`, `view:seed:${seed.id}`)]);
  });
  lines.push('', t.seeds.hint);
  rows.push(pager(p, 'seeds', t.buttons.previous, t.buttons.next));
  rows.push([btn(t.buttons.newSeed, 'new-seed'), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

// `pictures`: each story offers the people its pictures draw (`charactersScreen`).
function seedScreen(state: State, seedId: string | undefined, rawPage: string | undefined, pictures: boolean) {
  const t = texts(state.language);
  const seed = own(state.seeds, seedId);
  if (!seed) return stale(t, t.seed.notFound);
  const stories = storiesOf(state, seed.id);
  const p = paginate(stories, rawPage);
  const lines: (string | null)[] = [t.seed.title(quote(t, seed.title, 100)), t.seed.start(seed.startTime ?? '—'), '', clip(seed.text, 1200), ''];
  const rows: Row[] = [];
  if (state.job) {
    lines.push(busyNote(state, 'startOrDeleteSeed'), '');
    rows.push(cancelRow(state));
  } else {
    rows.push([btn(t.seed.startStory, `start:${seed.id}`)]);
  }
  if (stories.length) {
    lines.push(t.seed.stories(stories.length), pageNote(t, p));
    p.items.forEach((story, i) => {
      const n = p.start + i + 1;
      const current = story.id === state.active?.storyId ? ` · ${t.common.current}` : '';
      const branches = t.count.branches(values(story.branches).length);
      const scenes = t.count.scenes(Object.keys(story.nodes ?? {}).length);
      lines.push(`${n}. ${t.seed.story(n)} · ${branches} · ${scenes}${current}`);
      rows.push([btn(t.seed.storyButton(n), `view:story:${story.id}`), pictures ? btn(t.buttons.characters, `view:characters:${story.id}`) : null]);
    });
  } else {
    lines.push(t.seed.noStories, pictures ? t.characters.none : null);
  }
  rows.push(pager(p, `seed:${seed.id}`, t.buttons.previous, t.buttons.next));
  if (!state.job) rows.push([btn(t.seed.delete, `view:delete-seed:${seed.id}`)]);
  rows.push([btn(t.seed.all, 'view:seeds:0'), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function storyScreen(state: State, storyId: string | undefined, rawPage: string | undefined, pictures: boolean) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  const seed = own(state.seeds, story.seedId);
  const branches = ordered(values(story.branches));
  const p = paginate(branches, rawPage);
  const lines = [`📖 ${storyName(state, story)}`, t.story.branches(branches.length), pageNote(t, p), ''];
  const rows: Row[] = [];
  p.items.forEach((branch, i) => {
    const n = p.start + i + 1;
    const current = isActive(state, story, branch) ? ` · ${t.common.current}` : '';
    lines.push(`${n}. ${quote(t, branch.name)} · ${progress(t, story, branch)}${current}`);
    rows.push([btn(`🌿 ${n}. ${line(branch.name, 40) || t.format.untitledButton}`, `view:branch:${story.id}:${branch.id}`)]);
  });
  if (!branches.length) lines.push(t.story.none);
  lines.push('', t.story.hint);
  rows.push(pager(p, `story:${story.id}`, t.buttons.previous, t.buttons.next));
  rows.push([btn(t.story.tree, `view:tree:${story.id}`), pictures ? btn(t.buttons.characters, `view:characters:${story.id}`) : null]);
  rows.push([seed ? btn(t.story.toSeed, `view:seed:${seed.id}`) : null, btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

// The people of a story's sheet (local/picture.ts): who its pictures draw, and from what look. A sheet is written with
// the story's first picture, never on a press here, so a story without one says when it comes. A reader the Mini App
// serves may open the same list there.
function charactersScreen(state: State, storyId: string | undefined, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  const sheet = charactersOf(state, story);
  return payload([c.title(storyName(state, story)), '', sheet.length ? c.note : c.none, sheet.length ? '' : null,
    ...sheet.map((one, n) => `${n + 1}. ${line(one.name, 40)} — ${line(one.summary, 90)}`)], [
    ...sheet.map(one => [btn(`${one.viewer ? '👁' : '👤'} ${line(one.name, 30) || t.format.untitledButton}`, `view:character:${personRef(story, one)}`)]),
    details.miniApp ? [appButton(t.miniApp.open, `${details.miniApp}/?story=${encodeURIComponent(story.id)}`)] : null,
    [btn(c.toStory, `view:story:${story.id}`), btn(t.buttons.menu, 'view:home')],
  ]);
}

// The people of a story's sheet as the list of them shows them, here and in the Mini App (local/mini-app.ts): each at
// their place on the sheet, with their look, or their description where they have no look, as they are at the scene the
// reader stands at in this story (local/picture-versions.ts), as their card shows them, and whether the story's frames
// are seen through their eyes.
export function charactersOf(state: State, story: Story) {
  const here = sheetAt(story, sceneOf(state, story.id));
  return people(story).map(one => {
    const now = here[one.index] ?? one;
    return { ...one, summary: now.look || descriptionOf(now), viewer: seesThrough(story, one.name) };
  });
}

// One person (docs/illustrations-plan.md#three-layers): their description, the story's changes to it, the look and the
// clothes, tap-to-copy, where an edited look reaches, and the portrait kept to pick a reference by, which a reader in
// the reference experiment may send a picture of their own for (local/reference.ts). The description is
// the person's text, the story's or the reader's own, which the details a portrait is drawn from and the look are
// retold from (local/bot.ts). It has its characters alone, since the picture model never reads it: the whole prompt of
// a portrait, the details in it, is folded under the portrait with its tokens (local/picture.ts `portrait`). The look and
// the clothes each have their size as the picture model counts that text alone (never their sum: a prompt takes names
// and ages out of them, joins them with the scene and adds the style). The card says when the look is the reader's own
// instead, or not retold yet. Both have a button to write them, the description also for a person who has none yet.
// The changes and the clothes are the story's to make, and the card only shows them: for the active story the clothes
// the next pictures of the active branch start from, those of its latest picture or those the reader wrote there
// (local/picture.ts `wornAt`), the sheet's own otherwise. The reader may change them, with every other field, in the
// whole profile (`profileScreen`). A prompt the reader wrote for the person's portraits is said to be theirs, with a
// button to go back to the bot's own.
function characterScreen(state: State, storyId: string | undefined, rawIndex: string | undefined, tag: string | undefined,
  details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  // A button of somebody whose place on the sheet another person took since opens the list, not that other person.
  const found = personAt(story, rawIndex, tag);
  if (!found) return charactersScreen(state, story.id, details);
  const { person, described, descriptionTitle, descriptionSize, changes, along, lookSize, whose, clothes, clothesTitle, clothesSize,
    portrait, source, frames, viewer, pov, prompt } = characterCard(state, story, found, details);
  // A set of the person's pictures in many poses (local/pose-set.ts): how many and how heavy, those still without a
  // caption, how the captioned ones were sorted, and whether frames take them now.
  const set = person.poseSet?.length ? poseSetState(person) : undefined;
  const groups = set ? poseGroups(person) : [];
  const poses = !set ? [] : ['', c.poseSetLine(set.count, POSE_SET_PICTURES, megabytes(set.bytes)),
    ...set.pending || set.failed ? [c.poseSetCaptions(set.pending, set.failed)] : [],
    ...groups.length ? [c.poseSetGroups(groups.map(one => ({ name: c.poseGroupNames[one.group], count: one.count })))] : [],
    details.poseSet && details.pictures ? c.poseSetFrames : c.poseSetUnused];
  const result = payload([c.cardTitle(line(person.name, 60), storyName(state, story)), '',
    ...described ? [descriptionTitle, described, descriptionSize, ''] : [],
    ...changes ? [c.changes, changes, ''] : [], ...along ? [along, ''] : [],
    c.look, person.look, lookSize, whose, '',
    ...clothes ? [clothesTitle, clothes, clothesSize] : [c.noClothes], c.clothesNote, '',
    c.sizeNote, '', details.versions ? c.scopeVersions : c.scope, portrait === null ? null : '', portrait, source, frames, ...poses,
    pov === null ? null : '', pov], [
    [btn(c.editDetails, `details-edit:${personRef(story, person)}`)],
    [btn(c.edit, `look-edit:${personRef(story, person)}`)],
    [btn(c.profile, `view:profile:${personRef(story, person)}`)],
    details.pictures ? [btn(c.portrait, `portrait:${personRef(story, person)}`),
      details.references ? btn(c.ownPortrait, `ref-send:${personRef(story, person)}:front`) : null] : null,
    details.pictures && prompt !== undefined ? [btn(c.defaultPrompt, `portrait-default:${personRef(story, person)}`)] : null,
    (details.pictures && details.poseSet) || set ? [details.pictures && details.poseSet ? btn(c.poseSet, `pose-set:${personRef(story, person)}`) : null,
      set ? btn(c.poseSetDrop, `pose-set-drop:${personRef(story, person)}`) : null] : null,
    details.pictures ? [btn(viewer ? c.povOff : c.povOn, `${viewer ? 'pov-off' : 'pov'}:${personRef(story, person)}`)] : null,
    [btn(c.back, `view:characters:${story.id}`)],
  ]);
  const pre = (text: string, after: string) => {
    const offset = result.text.indexOf(text, result.text.indexOf(after) + after.length);
    return text && offset >= 0 ? [{ type: 'pre' as const, offset, length: text.length }] : [];
  };
  result.entities = [...described ? pre(described, descriptionTitle) : [], ...pre(person.look, c.look), ...clothes ? pre(clothes, clothesTitle) : []];
  return result;
}

// What a person's card says of them, in the chat (`characterScreen`) and in the Mini App (local/mini-app.ts): each field
// with its title and size, and the lines on their portrait and on the frames seen through their eyes. `picture` is the
// one the portrait's line speaks of, a picture of the reader's own or the portrait they kept.
export function characterCard(state: State, story: Story, found: NonNullable<ReturnType<typeof personAt>>, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ref = activeRef(state);
  const branch = ref?.story === story && ref.branch.head ? ref.branch : null;
  // The person as they are at the scene the reader stands at, with the versions of its line (local/picture-versions.ts),
  // and how many times their look changed along it; elsewhere, as the sheet has them.
  const person = { ...sheetAt(story, branch?.head)[found.index] ?? found, index: found.index };
  const changed = branch ? versionsOf(story, branch.head, person.name) : 0;
  const worn = branch ? wornAt(story, branch.head!, [{ ...person, outfit: '' }])[0].outfit ?? '' : '';
  const clothes = worn || (typeof person.outfit === 'string' ? person.outfit : '');
  const clothesTitle = worn ? c.clothesOfBranch(quote(t, branch!.name)) : c.clothesAtStart;
  const size = (text: string) => {
    let tokens: number | null = null;
    try { tokens = details.textTokens?.(text) ?? null; } catch { /* unknown, as without a tokenizer */ }
    return [tokens, [...text].length] as const;
  };
  const described = descriptionOf(person).trim();
  const descriptionTitle = c.description(ownDescription(person));
  const changes = person.changes?.trim() ?? '';
  // A kept portrait records the text it was drawn from, the person's details or, until they are retold, the look
  // (`portraitText`), and the card names which of the two a portrait is drawn from now. With a prompt the reader wrote
  // for the person (`ownPortraitPrompt`) a portrait is drawn from that alone, and the one kept is current only if it was
  // drawn from the very same prompt; without one, only if it was drawn from the bot's own around the text the person
  // has now. A picture of the reader's own in its place was drawn from nothing of the kind (local/reference.ts).
  const fromDetails = portraitFromDetails(person);
  const mine = details.references ? person.poses?.front : undefined;
  const prompt = ownPortraitPrompt(person);
  const kept = person.portrait;
  const portrait = mine ? c.ownPortraitKept(mine.width, mine.height)
    : prompt !== undefined ? (!kept ? (details.pictures ? c.promptPortraitNone : null)
      : kept.ownPrompt && kept.prompt === prompt ? c.promptPortraitKept : c.promptPortraitStale)
    : kept ? (kept.ownPrompt ? c.portraitOfOwnPrompt(fromDetails) : kept.look === portraitText(person) ? c.portraitKept(fromDetails) : c.portraitStale(fromDetails))
    : details.pictures ? c.portraitNone(fromDetails) : null;
  // Where portraits come from while the reader's own prompt is the person's, and how the frames take a drawn portrait
  // where they do: both said under the portrait's line. A picture of the reader's own has no prompt to edit.
  const source = portrait !== null && prompt !== undefined ? c.ownPrompt : null;
  const frames = details.references && portrait !== null && !mine ? c.portraitFrames : null;
  const whose = person.edited ? c.lookOwn : person.lookPending ? c.lookPending : null;
  // The frames seen through this person's eyes, or through another's (local/picture-pov.ts): a line last on the card,
  // the first a long card loses, since the button says it too, and the button that switches it.
  const viewer = seesThrough(story, person.name);
  const other = people(story).find(one => seesThrough(story, one.name));
  const pov = !details.pictures ? null : viewer ? c.povNote : other ? c.povOther(line(other.name, 60)) : null;
  return { person, described, descriptionTitle, descriptionSize: c.descriptionSize([...described].length), changes,
    along: changed ? c.along(changed) : null, lookSize: c.lookSize(...size(person.look)), whose, clothes, clothesTitle,
    clothesSize: clothes ? c.clothesSize(...size(clothes)) : null, portrait, source, frames, viewer, pov, prompt, picture: mine ?? kept };
}

// Waiting for a look or a description the reader writes for the person `state.ui` names, with the text as it is now to
// copy in one tap, where there is one. Without the wait this is the menu: otherwise the reader's next message would be
// taken for a move in the story. A look the reader writes keeps the details retold from the description, which the
// portraits are still drawn from (local/bot.ts), and the wait for it says so where there are any. Portraits drawn from a
// prompt the reader wrote for the person read neither text, and the wait says that instead.
function sheetInputScreen(state: State, input: 'look' | 'details', details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ui = state.ui?.input === input ? state.ui : null;
  const story = own(state.stories, ui?.storyId);
  const person = story && people(story).find(one => one.name === ui?.name);
  if (!story || !person) return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  const look = input === 'look';
  // For a reader who has versions of the sheet, where the text lands (local/picture-versions.ts `landEdit`): the whole
  // story, where it takes the place of what they wrote «only from this moment», or, as they chose here, the scene they
  // stood at then and those after it. The text shown now is the one it replaces: the sheet's, or the person's at that
  // scene. A scene another line goes on from, or another branch stands at, offers the whole story alone, and says why.
  const scope = details.versions ? editableFrom(state, story.id) : undefined;
  const from = details.versions && ui?.from !== undefined && Object.hasOwn(story.nodes, ui.from) ? ui.from : undefined;
  const shown = from === undefined ? person : { ...sheetAt(story, from)[person.index] ?? person, index: person.index };
  const now = look ? shown.look : descriptionOf(shown).trim();
  const promptOwn = ownPortraitPrompt(person) !== undefined;
  const keeps = look && !promptOwn && portraitFromDetails(shown);
  const branch = activeRef(state)?.branch;
  const replaced = details.versions && from === undefined ? ownVersions(story, person.name) : 0;
  const where = !details.versions ? [] : from !== undefined ? ['', c.scopeHere(quote(t, branch?.name ?? ''), look)]
    : ['', c.scopeAll(look), ...replaced ? [c.scopeReplaces(replaced)] : [], ...scope?.shared ? [c.scopeShared] : []];
  const result = payload([(look ? c.editTitle : c.detailsTitle)(line(person.name, 60), storyName(state, story)), '',
    look ? c.editNote(LOOK_CHARS) : c.detailsNote(DESCRIPTION_CHARS), ...keeps ? ['', c.editKeepsDetails] : [], ...promptOwn ? ['', c.ownPromptKeeps] : [],
    ...where, ...now ? ['', c.nowText, now] : []],
    [details.versions && from !== undefined ? [btn(c.scopeAllButton, 'edit-scope:all')] : null,
      details.versions && from === undefined && scope && !scope.shared ? [btn(c.scopeHereButton, 'edit-scope:here')] : null,
      [btn(c.backToCard, `view:character:${personRef(story, person)}`)]]);
  const offset = now ? result.text.lastIndexOf(now) : -1;
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: now.length }];
  return result;
}

// A person's whole profile as one block to tap, copy, edit and send back (local/profile.ts): every field, in the
// reader's language, and «✏️» for the wait that takes it back, whose button carries the fields shown and a hash of their
// text. It is one message or nothing: one over the bot's 4000 characters leaves out the reader's prompt for the
// portraits, which the note under a portrait drawn from it has, then the description too, which the card shows and has
// a button for, and at last shows no block at all, never one clipped. A block that would not read back as it is shown,
// one of a sheet the next picture writes anew, and one of a person whose look changed along the branch being played,
// shown as at its last scene (local/profile.ts `versioned`), are shown without the button, with a line on why. `notice`
// goes on top: the profile the reader edited had changed since.
function profileScreen(state: State, storyId: string | undefined, rawIndex: string | undefined, tag: string | undefined, details: RenderDetails,
  notice?: string) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  const person = personAt(story, rawIndex, tag);
  if (!person) return charactersScreen(state, story.id, details);
  const ref = personRef(story, person);
  const profile = profileOf(state, story, person);
  const title = c.profileTitle(line(person.name, 60), storyName(state, story));
  const back = [btn(c.backToCard, `view:character:${ref}`)];
  const fits: ProfileField[][] = [profile.present, profile.present.filter(field => field !== 'prompt'),
    profile.present.filter(field => field !== 'prompt' && field !== 'description')];
  for (const [n, fields] of fits.entries()) {
    if (n && fields.length === fits[n - 1].length) continue;
    const block = profileBlock(person.name, profile, fields, state.language);
    const editable = !profile.older && !profile.versioned && roundTrips(block, person.name, profile, fields);
    const notes = [profile.older ? c.profileOlder : profile.versioned ? c.profileVersions : editable ? null : c.profileUnreadable,
      profile.present.includes('prompt') && !fields.includes('prompt') ? c.profileNoPrompt : null,
      fields.includes('description') ? null : c.profileNoDescription].filter(note => note !== null);
    const lines = [title, ...notice ? ['', notice] : [], ...notes.length ? ['', ...notes] : [], '', block, ...editable ? ['', c.profileHint] : []];
    if (lines.join('\n').length > LIMIT) continue;
    const result = payload(lines, [editable ? [btn(c.profileEdit, `profile-edit:${ref}:${fieldsMask(fields)}:${profileHash(person.name, profile, fields)}`)] : null, back]);
    const offset = result.text.indexOf(block);
    if (offset >= 0) result.entities = [{ type: 'pre', offset, length: block.length }];
    return result;
  }
  return payload([title, ...notice ? ['', notice] : [], '', c.profileTooLong], [back]);
}

// Waiting for the profile the reader sends back (local/bot.ts), which they copy from the message above: what it may
// change and how, the limit of each field, where changed clothes go, and the way out. Without the wait this is the menu,
// as for a look.
function profileInputScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ui = state.ui?.input === 'profile' ? state.ui : null;
  const story = own(state.stories, ui?.storyId);
  const person = story && people(story).find(one => one.name === ui?.name);
  if (!story || !person) return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  const branch = profileOf(state, story, person).clothesAt === null ? null : activeRef(state)?.branch;
  return payload([c.profileEditTitle(line(person.name, 60), storyName(state, story)), '',
    c.profileEditNote(DESCRIPTION_CHARS, CHANGES_CHARS, DETAILS_CHARS, LOOK_CHARS, CLOTHES_CHARS, PROMPT_CHARS), '',
    branch ? c.profileClothesBranch(quote(t, branch.name)) : c.profileClothesStart, '', c.profileLeave],
    [[btn(c.backToCard, `view:character:${personRef(story, person)}`)]]);
}

// What a profile sent back changed, by the headings of the fields in `mask` (local/profile.ts `fieldsMask`), or that it
// changed nothing, with the ways to the profile and to the card. A description retold for it follows as the card.
function profileSaved(state: State, storyId: string | undefined, rawIndex: string | undefined, tag: string | undefined, mask: string | undefined) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  const person = story && personAt(story, rawIndex, tag);
  if (!story || !person) return stale(t, t.story.notFound);
  const fields = maskFields(mask) ?? [];
  const ref = personRef(story, person);
  return payload([fields.length ? c.profileSaved(line(person.name, 60), fields.map(field => c.profileHeadings[field]).join(', ')) : c.profileUnchanged],
    [[btn(c.profile, `view:profile:${ref}`)], [btn(c.backToCard, `view:character:${ref}`)]]);
}

// Waiting for a picture the reader sends of the person `state.ui` names, to keep as their portrait (local/reference.ts).
// Without the wait, or for a reader outside the reference experiment, this is the menu, as for a look.
function referenceInputScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ui = state.ui?.input === 'reference' ? state.ui : null;
  const story = own(state.stories, ui?.storyId);
  const person = story && people(story).find(one => one.name === ui?.name);
  if (!story || !person || !details.references) return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  const { min, max } = REFERENCE_SIDES;
  return payload([c.ownPortraitTitle(line(person.name, 60), storyName(state, story)), '',
    c.ownPortraitNote(min, max, REFERENCE_BYTES / 1024 / 1024), ...person.portrait || person.poses?.front ? ['', c.ownPortraitReplaces] : []],
    [[btn(c.backToCard, `view:character:${personRef(story, person)}`)]]);
}

// Waiting for the pictures of the pose set of the person `state.ui` names (local/pose-set.ts), one by one or in albums,
// until the reader says they are done. Without the wait, or for a reader without pose sets, this is the menu, as for a
// look.
function poseSetInputScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ui = state.ui?.input === 'pose-set' ? state.ui : null;
  const story = own(state.stories, ui?.storyId);
  const person = story && people(story).find(one => one.name === ui?.name);
  if (!story || !person || !details.poseSet) return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  const { min, max } = REFERENCE_SIDES;
  const held = person.poseSet?.length ?? 0;
  return payload([c.poseSetTitle(line(person.name, 60), storyName(state, story)), '',
    c.poseSetNote(min, max, REFERENCE_BYTES / 1024 / 1024, POSE_SET_PICTURES, POSE_SET_BYTES / 1024 / 1024, POSE_SET_READER_BYTES / 1024 / 1024,
      ARCHIVE_BYTES / 1024 / 1024),
    ...held ? ['', c.poseSetHeld(held)] : []],
    [[btn(c.poseSetDone, `pose-set-done:${personRef(story, person)}`)], [btn(c.backToCard, `view:character:${personRef(story, person)}`)]]);
}

// The message that counts the pictures of a pose set as they are read (local/bot.ts): those kept, those refused and why,
// how many files are still to be read, and how many the set holds now, with «✅ Готово» under it until the reader is
// done, and after that, while files are still read, that its last word is to come. Once an archive with labels.csv came,
// how many the reader labeled and how many are left to the captioner, and for each labels.csv the rows that matched no
// picture or had a value the bot does not know, or that it could not be read. The person is found by the key a sheet
// written again keeps (local/picture.ts `rewrittenSheet`).
function poseSetStatus(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const tally = details.poseTally;
  const story = own(state.stories, tally?.storyId);
  const person = story && tally && people(story).find(one => personKey(one.name) === personKey(tally.name));
  if (!tally || !story || !person) return payload([c.poseSetTitle(line(tally?.name ?? '', 60), '…'), '', c.poseSetKept(tally?.kept ?? 0)], []);
  const refused = POSE_SET_REFUSALS.flatMap(reason => tally.refused[reason] ? [{ reason: c.poseSetReasons[reason], count: tally.refused[reason]! }] : []);
  const ref = personRef(story, person);
  const archives = tally.archives ?? [];
  const labels = !archives.length ? [] : [c.poseSetLabeled(tally.labeled ?? 0, tally.kept - (tally.labeled ?? 0)),
    ...archives.flatMap(one => one.unread ? [c.poseSetLabelsUnread(line(one.archive, 40))]
      : one.unmatched.length || one.unknown.length ? [c.poseSetRows(line(one.archive, 40), rowList(one.unmatched), rowList(one.unknown))] : [])];
  return payload([c.poseSetTitle(line(person.name, 60), storyName(state, story)), '', c.poseSetKept(tally.kept),
    ...refused.length ? [c.poseSetRefused(refused)] : [], ...labels, ...tally.unread ? [c.poseSetUnread(tally.unread)] : [],
    c.poseSetHolds(person.poseSet?.length ?? 0, POSE_SET_PICTURES), '',
    tally.done ? c.poseSetEnded : tally.finishing ? c.poseSetFinishing : c.poseSetMore],
    [tally.done || tally.finishing ? [btn(c.backToCard, `view:character:${ref}`)] : [btn(c.poseSetDone, `pose-set-done:${ref}`)]]);
}

// Row numbers of labels.csv as a message lists them: the first twenty, and how many more.
const rowList = (rows: number[]) => rows.length > 20 ? `${rows.slice(0, 20).join(', ')}… (+${rows.length - 20})` : rows.join(', ');

// Before every picture of a person's pose set goes: how many, and that frames already drawn with them keep them.
function poseSetDropScreen(state: State, storyId: string | undefined, rawIndex: string | undefined, tag: string | undefined,
  details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  const person = story && personAt(story, rawIndex, tag);
  if (!story || !person) return stale(t, t.story.notFound);
  const ref = personRef(story, person);
  if (!person.poseSet?.length) return characterScreen(state, story.id, rawIndex, tag, details);
  return payload([c.poseSetDropTitle(line(person.name, 60), storyName(state, story)), '', c.poseSetDropNote(person.poseSet.length)],
    [[btn(c.poseSetDropConfirm, `pose-set-dropped:${ref}`)], [btn(c.backToCard, `view:character:${ref}`)]]);
}

// Waiting for the whole prompt of the portraits of the person `state.ui` names (local/bot.ts), which the reader copies
// from the note under a portrait of them, as for a variant of a scene's picture. Without the wait this is the menu, as
// for a look.
function portraitPromptInputScreen(state: State, details: RenderDetails) {
  const t = texts(state.language);
  const c = t.characters;
  const ui = state.ui?.input === 'portrait-prompt' ? state.ui : null;
  const story = own(state.stories, ui?.storyId);
  const person = story && people(story).find(one => one.name === ui?.name);
  if (!story || !person) return home(state, null, details.modelInfo, gpuFor(details), details.pictures === true);
  return payload([c.promptTitle(line(person.name, 60), storyName(state, story)), '', c.promptNote(PROMPT_CHARS)],
    [[btn(t.variant.leave, `view:character:${personRef(story, person)}`)]]);
}

// The caption and the buttons of a portrait (local/picture.ts `portrait`): another one, keeping this one by the id it
// was drawn under, and the way back to its person.
function portraitCaption(state: State, storyId: string | undefined, rawIndex: string | undefined, tag: string | undefined,
  candidate: string | undefined) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  const person = story && personAt(story, rawIndex, tag);
  if (!story || !person) return stale(t, t.story.notFound);
  // Asked for where it is drawn (local/bot.ts), so the prompt the person has then is the one it is drawn from.
  return payload([(ownPortraitPrompt(person) === undefined ? c.caption : c.ownCaption)(line(person.name, 60))], [
    [btn(c.again, `portrait:${personRef(story, person)}`), candidate ? btn(c.keep, `portrait-keep:${candidate}`) : null],
    [btn(c.backToCard, `view:character:${personRef(story, person)}`)],
  ]);
}

function portraitKept(state: State, storyId: string | undefined, rawIndex: string | undefined, retainsPortraits: boolean) {
  const t = texts(state.language);
  const c = t.characters;
  const story = own(state.stories, storyId);
  const person = story && people(story).find(one => String(one.index) === rawIndex);
  if (!story || !person) return stale(t, t.story.notFound);
  return payload([c.kept(line(person.name, 60)), ...retainsPortraits ? ['', c.retention] : []],
    [[btn(c.backToCard, `view:character:${personRef(story, person)}`)]]);
}

// The story as a tree: scenes point at their parents, a branch or a checkpoint marks a scene. A straight run of scenes
// is one line, so the drawing shows only where the story forks and what stands at each place.
const TREE_LINES = 40;
function treeScreen(state: State, storyId: string | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  if (!story) return stale(t, t.story.notFound);
  const children = new Map<string | null, SceneNode[]>();
  for (const node of ordered(values(story.nodes))) {
    const parent = node.parent && own(story.nodes, node.parent) ? node.parent : null;
    children.set(parent, [...children.get(parent) ?? [], node]);
  }
  const marks = (head: string | null) => [
    ...ordered(values(story.branches)).filter(branch => (branch.head ?? null) === head).map(branch => `🌿 ${line(branch.name, 18) || t.tree.branch}${isActive(state, story, branch) ? ' ✅' : ''}`),
    // Every scene gets an automatic checkpoint. The drawing names the places that mean something: where memory was
    // compacted and what the author saved. A fork needs no mark, the drawing shows it.
    ...(values(story.checkpoints).some(cp => cp.kind === 'compaction' && (cp.head ?? null) === head) ? [t.tree.compaction] : []),
    ...ordered(values(story.checkpoints)).filter(cp => cp.kind === 'manual' && (cp.head ?? null) === head).map(cp => `📍 ${line(cp.label, 18) || t.tree.checkpoint}`),
  ];
  const drawn: string[] = [];
  const seen = new Set<string>();
  const draw = (parent: string | null, prefix: string) => {
    const starts = children.get(parent) ?? [];
    starts.forEach((start, index) => {
      const lastChild = index === starts.length - 1;
      // Walk the run until the story forks, ends, or something marks the scene.
      let node = start;
      let scenes = 1;
      seen.add(node.id);
      while ((children.get(node.id) ?? []).length === 1 && !marks(node.id).length && !seen.has(children.get(node.id)![0].id)) {
        node = children.get(node.id)![0];
        seen.add(node.id);
        scenes++;
      }
      const time = /^\d{4}-(\d\d)-(\d\d) (\d\d:\d\d)$/.exec(node.time);
      drawn.push(`${prefix}${lastChild ? '└─' : '├─'} ${t.tree.run(scenes, time ? `${time[2]}.${time[1]} ${time[3]}` : null)}${marks(node.id).map(mark => ` · ${mark}`).join('')}`);
      draw(node.id, `${prefix}${lastChild ? '  ' : '│ '}`);
    });
  };
  draw(null, '');
  const shown = drawn.length > TREE_LINES ? [...drawn.slice(0, TREE_LINES), t.tree.more(drawn.length - TREE_LINES)] : drawn;
  const tree = [`${t.tree.root}${marks(null).map(mark => ` · ${mark}`).join('')}`, ...shown].join('\n');
  const result: Screen = payload([`🌳 ${storyName(state, story)}`, '', tree, '', t.tree.legend],
    [...ordered(values(story.branches)).slice(0, PAGE).map(branch => [btn(`${t.tree.scenes(line(branch.name, 30) || t.tree.branch)}${isActive(state, story, branch) ? ' ✅' : ''}`, `view:log:${story.id}:${branch.id}:0`)]),
      [btn(t.tree.toStory, `view:story:${story.id}`), btn(t.buttons.menu, 'view:home')]]);
  // A pre entity keeps the drawing monospaced without parse_mode escaping. Offsets are UTF-16 units, as in a JS string.
  const offset = result.text.indexOf(tree);
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: tree.length }];
  return result;
}

// The scenes of one branch, newest first, the way a commit log reads: a scene is a commit, and branches, compactions and
// saved checkpoints are the names that point at it. Every scene has its automatic checkpoint, so every line opens.
function logScreen(state: State, storyId: string | undefined, branchId: string | undefined, rawPage: string | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!story || !branch) return stale(t, t.branch.notFound);
  const scenes = chain(story, branch.head).map((node, index) => ({ node, number: index + 1 })).reverse();
  const p = paginate(scenes, rawPage);
  const checkpoints = ordered(values(story.checkpoints));
  // Where every other branch leaves this line: the last scene the two have in common.
  const onLine = new Set(scenes.map(scene => scene.node.id));
  const forks = new Map<string, string[]>();
  for (const other of ordered(values(story.branches))) {
    if (other.id === branch.id) continue;
    let last: string | null = null;
    for (const scene of chain(story, other.head)) { if (!onLine.has(scene.id)) break; last = scene.id; }
    if (last && last !== branch.head) forks.set(last, [...forks.get(last) ?? [], other.name]);
  }
  const lines: (string | null)[] = [`${t.log.title(quote(t, branch.name))}${isActive(state, story, branch) ? ` · ${t.common.current}` : ''}`, storyName(state, story),
    t.log.summary(scenes.length), pageNote(t, p), ''];
  const rows: Row[] = [];
  for (const { node, number } of p.items) {
    const here = checkpoints.filter(cp => cp.head === node.id);
    const names = [
      node.id === branch.head ? `🌿 ${line(branch.name, 18)}` : null,
      ...(forks.get(node.id) ?? []).map(name => `⑂ ${line(name, 18)}`),
      here.some(cp => cp.kind === 'compaction') ? t.log.compaction : null,
      ...here.filter(cp => cp.kind === 'manual').map(cp => `📍 ${line(cp.label, 18)}`),
      node.truncated ? t.log.truncated : null,
    ].filter(Boolean);
    const words = line(node.input, 48) || line(sceneBody(node.text), 48);
    lines.push(`${number}. ${node.time}${names.length ? ` · ${names.join(' · ')}` : ''}`, `   ✍️ ${words || '—'}`);
    const cp = here.find(item => item.kind === 'manual') ?? here.find(item => item.kind === 'scene') ?? here[0];
    if (cp) rows.push([btn(`${number}. ${line(node.input, 28) || t.log.scene}`, `view:checkpoint:${story.id}:${cp.id}`)]);
  }
  if (!scenes.length) lines.push(t.log.none);
  lines.push('', t.log.hint);
  rows.push(pager(p, `log:${story.id}:${branch.id}`, t.log.newer, t.log.older));
  rows.push([btn(t.log.tree, `view:tree:${story.id}`), btn(t.log.toBranch, `view:branch:${story.id}:${branch.id}`), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function branchScreen(state: State, storyId: string | undefined, branchId: string | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!story || !branch) return stale(t, t.branch.notFound);
  const current = isActive(state, story, branch);
  const last = own(story.nodes, branch.head);
  const checkpoints = checkpointsOf(story, branch.id).length;
  const lines = [t.branch.title(quote(t, branch.name, 60)), `📖 ${storyName(state, story)}`, `🎬 ${progress(t, story, branch)}`];
  if (current) lines.push(t.branch.isCurrent);
  if (last) lines.push('', t.branch.lastScene, clip(sceneBody(last.text), 600));
  const rows: Row[] = [];
  if (state.job) {
    lines.push('', busyNote(state, 'switchOrDeleteBranch'));
    rows.push(cancelRow(state));
    if (current && last) rows.push([btn(t.buttons.lastScene, 'last')]);
  } else if (current) {
    rows.push([btn(t.buttons.continue, 'continue'), last ? btn(t.buttons.lastScene, 'last') : null]);
  } else {
    lines.push('', t.branch.pickHint);
    rows.push([btn(t.branch.play, `use:${story.id}:${branch.id}`)]);
  }
  rows.push([btn(t.branch.scenes, `view:log:${story.id}:${branch.id}:0`), btn(t.branch.checkpoints(checkpoints), `view:checkpoints:${story.id}:${branch.id}:0`)]);
  if (!state.job) rows.push([btn(t.branch.delete, `view:delete-branch:${story.id}:${branch.id}`)]);
  rows.push([btn(t.branch.all, `view:story:${story.id}`), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function checkpointList(state: State, storyId: string | undefined, branchId: string | undefined, rawPage: string | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!story || !branch) return stale(t, t.branch.notFound);
  const newest = checkpointsOf(story, branch.id).reverse();
  const p = paginate(newest, rawPage);
  const lines = [t.checkpoints.title(quote(t, branch.name), newest.length), `📖 ${storyName(state, story)}`, pageNote(t, p), ''];
  lines.push(newest.length ? t.checkpoints.hint : t.checkpoints.none);
  const rows: Row[] = p.items.map(cp => {
    const time = checkpointTime(state, story, cp);
    return [btn(`${checkpointTitle(t, cp)}${time ? ` · ${time}` : ''}`, `view:checkpoint:${story.id}:${cp.id}`)];
  });
  rows.push(pager(p, `checkpoints:${story.id}:${branch.id}`, t.checkpoints.newer, t.checkpoints.older));
  rows.push([btn(t.checkpoints.toBranch, `view:branch:${story.id}:${branch.id}`), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function checkpointScreen(state: State, storyId: string | undefined, checkpointId: string | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  const cp = own(story?.checkpoints, checkpointId);
  const branch = own(story?.branches, cp?.branchId);
  if (!story || !cp || !branch) return stale(t, t.checkpoint.notFound);
  const seed = own(state.seeds, story.seedId);
  const node = cp.head ? own(story.nodes, cp.head) : null;

  const header = [checkpointTitle(t, cp), t.checkpoint.branch(quote(t, branch.name), storyName(state, story))];
  if (cp.head && cp.head === branch.head && isActive(state, story, branch)) header.push(t.checkpoint.isHead);

  let body: (string | null)[];
  if (!cp.head) {
    body = ['', t.checkpoint.atStart, seed ? t.checkpoint.start(seed.startTime) : null, '', seed ? seed.text : t.checkpoint.seedMissing];
  } else if (!node) {
    body = ['', t.checkpoint.textMissing];
  } else {
    body = [
      '',
      node.input ? t.checkpoint.input(line(node.input, 400)) : null,
      node.truncated ? t.checkpoint.truncated : null,
      '',
      node.text ?? '',
    ];
  }

  const rows: Row[] = [];
  const footer = [''];
  if (state.job) {
    footer.push(busyNote(state, 'fork'));
    rows.push(cancelRow(state));
  } else {
    footer.push(t.checkpoint.forkNote(quote(t, branch.name)));
    rows.push([btn(t.checkpoint.fork, `fork:${story.id}:${cp.id}`)]);
  }
  const newest = checkpointsOf(story, branch.id).reverse();
  const page = Math.max(0, Math.floor(newest.indexOf(cp) / PAGE));
  rows.push([
    btn(t.checkpoint.back, `view:checkpoints:${story.id}:${branch.id}:${page}`),
    btn(t.buttons.context, `view:context:${story.id}:${cp.id}`),
    btn(t.buttons.menu, 'view:home'),
  ]);

  // Fit the long scene/seed text into what remains of the message limit.
  const long = body.pop();
  const fixed = [...header, ...body, ...footer].filter(l => l != null).join('\n').length;
  body.push(clip(long, Math.max(200, LIMIT - fixed - 20)));
  return payload([...header, ...body, ...footer], rows);
}

function currentContextScreen(state: State, stats: ContextStats | null | undefined) {
  const t = texts(state.language);
  const ref = activeRef(state);
  if (!ref) {
    return payload(
      [t.context.title, '', t.context.noStory],
      [[btn(t.buttons.seeds, 'view:seeds:0'), btn(t.buttons.menu, 'view:home')]],
    );
  }
  const { story, branch } = ref;
  const valid = stats && stats.scope !== 'checkpoint' && stats.storyId === story.id && stats.branchId === branch.id;
  if (valid) return contextView(t, stats, { state, canCompact: !state.job });
  const lines = [t.context.currentBranch, `🌿 ${quote(t, branch.name)} · ${storyName(state, story)}`, '', t.context.noData];
  const rows: Row[] = [];
  if (state.job) {
    lines.push('', busyNote(state, 'compact'));
  } else {
    lines.push('', t.context.compactNote(null));
    rows.push([btn(t.buttons.compactNow, 'compact')]);
  }
  rows.push([btn(t.buttons.checkpoints, `view:checkpoints:${story.id}:${branch.id}:0`), btn(t.buttons.menu, 'view:home')]);
  return payload(lines, rows);
}

function checkpointContextScreen(state: State, storyId: string | undefined, checkpointId: string | undefined, stats: ContextStats | null | undefined) {
  const t = texts(state.language);
  const story = own(state.stories, storyId);
  const cp = own(story?.checkpoints, checkpointId);
  if (!story || !cp) return stale(t, t.checkpoint.notFound);
  if (statsFor(stats, story.id, cp.id)) return contextView(t, stats);
  return payload(
    [t.context.titleOf(checkpointTitle(t, cp)), '', t.context.noCheckpointData],
    [[btn(t.buttons.toCheckpoint, `view:checkpoint:${story.id}:${cp.id}`), btn(t.buttons.menu, 'view:home')]],
  );
}

// Only show stats that belong to exactly this checkpoint, never the branch head or another branch.
function statsFor(stats: ContextStats | null | undefined, storyId: string, checkpointId: string): stats is ContextStats {
  return !!stats && stats.scope === 'checkpoint' && stats.storyId === storyId && stats.checkpointId === checkpointId;
}

function contextView(t: Messages, stats: ContextStats, { state = null, canCompact = false }: { state?: State | null; canCompact?: boolean } = {}) {
  const c = t.context;
  const num = t.format.number;
  const size = (part: { bytes?: unknown; estimatedTokens?: unknown } | null | undefined) =>
    `${known(part?.bytes) ? c.bytes(num(part.bytes)) : c.bytesUnknown} · ${known(part?.estimatedTokens) ? c.tokens(num(part.estimatedTokens)) : c.tokensUnknown}`;
  const checkpoint = stats.scope === 'checkpoint';
  const lines = [
    c.titleOf(line(stats.label, 60) || (checkpoint ? c.checkpoint : c.branch)),
    checkpoint ? c.atCheckpoint : c.atBranch,
  ];
  if (state?.job && !checkpoint) lines.push(state.job.kind === 'compact' ? c.duringCompaction : c.duringScene);

  lines.push('', known(stats.limitTokens)
    ? c.window(num(stats.limitTokens), known(stats.reserveTokens) ? num(stats.reserveTokens) : null)
    : c.windowUnknown);

  const request = stats.request?.estimatedTokens;
  lines.push('');
  if (known(request)) {
    lines.push(c.nextRequest(num(request), share(request, stats.limitTokens)));
    const source = stats.request.estimateSource;
    if (source === 'usage') lines.push(c.estimateFromUsage);
    else if (source === 'bytes') lines.push(c.estimateFromBytes);
  } else {
    lines.push(c.nextRequestUnknown);
  }

  const budget = stats.budget;
  if (budget && known(budget.limitTokens)) {
    lines.push(c.budget(known(budget.inputTokens) ? num(budget.inputTokens) : null, num(budget.limitTokens)));
    if (known(budget.remainingTokens)) lines.push(budget.remainingTokens > 0 ? c.remaining(num(budget.remainingTokens)) : c.exhausted);
  }
  if (known(request) || known(budget?.limitTokens)) lines.push(c.forecastNote);

  const compaction = stats.compaction;
  if (compaction && known(compaction.thresholdTokens)) {
    lines.push('', c.autoCompaction(num(compaction.thresholdTokens), known(compaction.keepScenes) ? compaction.keepScenes : null), c.autoCompactionNote);
  }

  const memory = stats.memory;
  const memoryText = known(memory?.count) && memory.count === 0 ? c.memoryEmpty
    : `${known(memory?.count) ? `${t.count.parts(memory.count)} · ` : ''}${size(memory)}`;
  lines.push(
    '',
    c.snapshot,
    c.seed(size(stats.seed)),
    c.memory(memoryText),
    c.prefix(size(stats.prefix)),
    c.tail(known(stats.tail?.count) ? stats.tail.count : null, size(stats.tail)),
    c.whole(size(stats.snapshot)),
  );

  const last = stats.lastRequest;
  if (!last || ![last.inputTokens, last.outputTokens, last.totalTokens].some(known)) lines.push('', c.lastRequestNone, c.lastRequestNote);
  else {
    const total = known(last.totalTokens) ? last.totalTokens
      : known(last.inputTokens) && known(last.outputTokens) ? last.inputTokens + last.outputTokens : null;
    const measured = (value: unknown) => (known(value) ? num(value) : t.format.unknown);
    lines.push('', c.lastRequest(measured(last.inputTokens), measured(last.outputTokens), measured(total)), c.lastRequestNote);
  }

  // Compaction is offered only for the live branch while idle, never for a historical checkpoint.
  const compact = canCompact && !checkpoint;
  if (compact) lines.push('', c.compactNote(known(stats.compaction?.keepScenes) ? stats.compaction.keepScenes : null));

  const rows: (Row | null)[] = checkpoint
    ? [[stats.storyId && stats.checkpointId ? btn(t.buttons.toCheckpoint, `view:checkpoint:${stats.storyId}:${stats.checkpointId}`) : null, btn(t.buttons.menu, 'view:home')]]
    : [
      compact ? [btn(t.buttons.compactNow, 'compact')] : null,
      [btn(t.buttons.refresh, 'view:context'), stats.storyId && stats.branchId ? btn(t.buttons.checkpoints, `view:checkpoints:${stats.storyId}:${stats.branchId}:0`) : null],
      [btn(t.buttons.menu, 'view:home')],
    ];
  return payload(lines, rows);
}

function deleteSeedScreen(state: State, seedId: string | undefined) {
  const t = texts(state.language);
  const d = t.deletion;
  const seed = own(state.seeds, seedId);
  if (!seed) return stale(t, t.seed.notFound);
  const stories = storiesOf(state, seed.id);
  const branches = stories.reduce((sum, story) => sum + values(story.branches).length, 0);
  const scenes = stories.reduce((sum, story) => sum + Object.keys(story.nodes ?? {}).length, 0);
  const lines = [d.seedTitle(quote(t, seed.title, 60)), ''];
  if (stories.length) {
    lines.push(d.withSeed, `• ${t.count.stories(stories.length)}`, `• ${t.count.branches(branches)}`, `• ${d.scenesAndCheckpoints(scenes)}`);
    if (stories.some(story => story.id === state.active?.storyId)) lines.push(`• ${d.includesCurrent}`);
  } else {
    lines.push(d.onlySeed);
  }
  lines.push('', d.note);
  const rows: Row[] = [];
  if (state.job) {
    lines.push('', busyNote(state, 'deleteSeed'));
    rows.push(cancelRow(state));
  } else {
    rows.push([btn(stories.length ? d.confirmAll : d.confirmSeed, `remove-seed:${seed.id}`)]);
  }
  rows.push([btn(t.buttons.keep, `view:seed:${seed.id}`)]);
  return payload(lines, rows);
}

function deleteBranchScreen(state: State, storyId: string | undefined, branchId: string | undefined) {
  const t = texts(state.language);
  const d = t.deletion;
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!story || !branch) return stale(t, t.branch.notFound);
  const seed = own(state.seeds, story.seedId);
  const others = values(story.branches).filter(b => b !== branch);
  const checkpoints = checkpointsOf(story, branch.id);
  const kept = reach(story, [...others, ...values(story.checkpoints).filter(cp => cp?.branchId !== branch.id)]);
  const lost = [...reach(story, [branch, ...checkpoints])].filter(nodeId => !kept.has(nodeId)).length;

  const lines: (string | null)[] = [d.branchTitle(quote(t, branch.name, 60)), `📖 ${storyName(state, story)}`, ''];
  if (!others.length) {
    lines.push(d.onlyBranch, `• ${t.count.scenes(lost)}`, `• ${t.count.checkpoints(checkpoints.length)}`, '',
      seed ? d.seedStays(quote(t, seed.title)) : null);
  } else {
    lines.push(d.forever, `• ${d.checkpointsOfBranch(checkpoints.length)}`, `• ${lost ? d.scenesOnlyHere(lost) : d.scenesStay}`, '', d.kept(others.length));
  }
  if (isActive(state, story, branch)) lines.push('', d.isCurrent);
  lines.push('', d.note);
  const rows: Row[] = [];
  if (state.job) {
    lines.push('', busyNote(state, 'deleteBranch'));
    rows.push(cancelRow(state));
  } else {
    rows.push([btn(others.length ? d.confirmBranch : d.confirmStory, `remove-branch:${story.id}:${branch.id}`)]);
  }
  rows.push([btn(t.buttons.keep, `view:branch:${story.id}:${branch.id}`)]);
  return payload(lines, rows);
}

function newSeedScreen(state: State) {
  const t = texts(state.language);
  const ui = state.ui;
  if (ui?.input === 'seed' && Array.isArray(ui.parts)) {
    const draft = ui.parts.filter(part => typeof part === 'string' && part.trim());
    if (draft.length) return seedDraftScreen(t, ui.draftId, draft);
  }

  const example = t.newSeed.example;
  const lines = [t.newSeed.title, '', t.newSeed.steps, '', t.newSeed.exampleLabel, example];
  if (state.job) lines.push('', state.job.kind === 'compact' ? t.newSeed.compactRunning : t.newSeed.sceneRunning);
  const result = payload(lines, [[btn(t.newSeed.cancel, 'cancel')]]);
  // A pre entity makes the example tap-to-copy without parse_mode escaping.
  const offset = result.text.indexOf(example);
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: example.length }];
  return result;
}

// Receipt after each collected part (message or file): counts only, never any text or filename.
// Format is checked by the backend on Save.
function seedDraftScreen(t: Messages, draftId: string, parts: string[]) {
  const chars = [...parts.join('\n\n')].length;
  return payload([t.draft.title, t.draft.received(parts.length, chars), '', t.draft.more, t.draft.saveHint, '', t.draft.menuNote], [
    [draftId ? btn(t.draft.save, `save-seed:${draftId}`) : null],
    [btn(t.draft.discard, 'cancel')],
  ]);
}

function stale(t: Messages, message: string) {
  return payload(
    [`⚠️ ${message}`, t.common.staleHint],
    [[btn(t.buttons.seeds, 'view:seeds:0'), btn(t.buttons.menu, 'view:home')]],
  );
}

// Domain lookups (tolerant of stale or broken references)

const values = <T>(obj: Record<string, T> | null | undefined): T[] => Object.values(obj ?? {});
const own = <T>(obj: Record<string, T> | null | undefined, key: string | null | undefined) => (key != null && obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

function activeRef(state: State) {
  const story = own(state.stories, state.active?.storyId);
  const branch = own(story?.branches, state.active?.branchId);
  return story && branch ? { story, branch } : null;
}

function isActive(state: State, story: Story, branch: Branch) {
  return state.active?.storyId === story.id && state.active?.branchId === branch.id;
}

function ordered<T extends { id: string }>(items: T[]) {
  const n = (item: T) => {
    const match = /(\d+)$/.exec(String(item?.id ?? ''));
    return match ? Number(match[1]) : Infinity;
  };
  return items
    .map((item, i): [T, number] => [item, i])
    .sort((a, b) => (n(a[0]) - n(b[0])) || (a[1] - b[1]))
    .map(([item]) => item);
}

function storiesOf(state: State, seedId: string) {
  return ordered(values(state.stories).filter(story => story?.seedId === seedId));
}

// The people of a story's sheet with a name and a look, each at its own place on the sheet, which is what the
// characters' buttons carry (local/bot.ts).
function people(story: Story) {
  return (Array.isArray(story.sheet) ? story.sheet : []).flatMap((one, index) =>
    typeof one?.name === 'string' && typeof one.look === 'string' ? [{ ...one, index }] : []);
}
// A person as the buttons name them (local/picture.ts `personTag`).
function personRef(story: Story, person: { name: string; index: number }) {
  return `${story.id}:${person.index}:${personTag(person.name)}`;
}

// A stored pace that is not one of the others is «Сцена», as a story without one.
function paceOf(story: Story): Pace {
  return story.pace === 'moment' || story.pace === 'chapter' ? story.pace : 'scene';
}

export function storyName(state: State, story: Story) {
  const t = texts(state.language);
  const n = storiesOf(state, story.seedId).indexOf(story) + 1;
  return n ? t.common.storyName(quote(t, story.title), n) : quote(t, story.title);
}

function chain(story: Story, head: string | null | undefined) {
  const nodes = [];
  const seen = new Set();
  while (head && !seen.has(head)) {
    const node = own(story.nodes, head);
    if (!node) break;
    seen.add(head);
    nodes.push(node);
    head = node.parent;
  }
  return nodes.reverse();
}

function reach(story: Story, refs: (Branch | Checkpoint)[]) {
  const ids = new Set<string>();
  for (const ref of refs) for (const node of chain(story, ref?.head)) ids.add(node.id);
  return ids;
}

function progress(t: Messages, story: Story, branch: Branch) {
  const scenes = chain(story, branch.head).length;
  if (!scenes) return t.common.noScenes;
  const time = own(story.nodes, branch.head)?.time;
  return `${t.count.scenes(scenes)}${time ? ` · ${time}` : ''}`;
}

function checkpointsOf(story: Story, branchId: string) {
  return ordered(values(story.checkpoints).filter(cp => cp?.branchId === branchId));
}

function checkpointTitle(t: Messages, cp: Checkpoint) {
  return `${ICON[cp.kind] ?? '📌'} ${line(cp.label, 40) || t.checkpoint.untitled}`;
}

function checkpointTime(state: State, story: Story, cp: Checkpoint) {
  return cp.head ? own(story.nodes, cp.head)?.time : own(state.seeds, story.seedId)?.startTime;
}

function sceneBody(text: unknown) {
  return String(text ?? '').split('\n').slice(1).join('\n').trim();
}

// Text and keyboard helpers

function clip(value: unknown, max: number) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() + '…';
}

function line(value: unknown, max = 40) {
  return clip(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

// Bytes as whole megabytes, a started one counted.
const megabytes = (bytes: number) => Math.ceil(bytes / 1024 / 1024);

function quote(t: Messages, value: unknown, max = 40) {
  return t.format.quote(line(value, max) || t.format.untitled);
}

// Missing measurements are shown as unknown, never as 0.
function known(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function share(part: unknown, whole: unknown) {
  if (!known(part) || !known(whole) || whole <= 0) return null;
  const percent = (part / whole) * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function busyNote(state: State, action: keyof Messages['busy']['scene']) {
  return texts(state.language).busy[state.job?.kind === 'compact' ? 'compact' : 'scene'][action];
}

function cancelRow(state: State): Row {
  const b = texts(state.language).buttons;
  return [btn(state.job?.kind === 'compact' ? b.cancelCompaction : b.cancelScene, 'cancel')];
}

// Model metadata: {provider, model, status, checkedAt}. Scene provenance carries only {provider, model}.
// Provider names are in the catalog; its keys are the providers the interface knows.
type ProviderId = keyof Messages['model']['providers'];

function modelKnown(info: ModelInfo | null | undefined): info is ModelInfo & { provider: ProviderId; model: string } {
  return !!info && info.provider !== undefined && Object.hasOwn(texts('ru').model.providers, info.provider) && typeof info.model === 'string' && info.model.trim() !== '';
}

function statusShort(t: Messages, info: ModelInfo) {
  if (info.status === 'ready') return t.model.short.ready(checkedTime(info.checkedAt));
  if (info.status === 'unavailable') return t.model.short.unavailable;
  if (info.status === 'configured') return t.model.short.configured;
  return t.model.short.unknown;
}

function checkedTime(iso: unknown) {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Scene prefixes may be sent with a Markdown parse mode: keep only letters, digits and spaces
// from the model name and join the rest with a Unicode hyphen, which no Markdown flavour treats specially.
function markdownSafe(value: string) {
  return value.replace(/[^\p{L}\p{N} ]+/gu, '‐');
}

function paginate<T>(items: T[], raw: unknown): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const wanted = /^\d+$/.test(String(raw ?? '')) ? Number(raw) : 0;
  const page = Math.min(wanted, pages - 1);
  const start = page * PAGE;
  return { page, pages, start, items: items.slice(start, start + PAGE) };
}

function pageNote(t: Messages, p: Page<unknown>) {
  return p.pages > 1 ? t.common.page(p.page + 1, p.pages) : null;
}

function pager(p: Page<unknown>, route: string, previous: string, next: string): Row {
  return [
    p.page > 0 ? btn(previous, `view:${route}:${p.page - 1}`) : null,
    p.page < p.pages - 1 ? btn(next, `view:${route}:${p.page + 1}`) : null,
  ];
}

function btn(text: string, data: string): InlineButton | null {
  return encoder.encode(data).length <= 64 ? { text, callback_data: data } : null;
}

// Opens the Mini App at `url` (local/mini-app.ts) instead of asking the bot for a screen.
function appButton(text: string, url: string): InlineButton {
  return { text, web_app: { url } };
}

function keyboard(rows: (Row | null)[]): InlineKeyboard | undefined {
  const inline_keyboard = rows.filter(row => !!row).map(row => row.filter(button => !!button)).filter(row => row.length);
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}

function payload(lines: (string | null | undefined)[], rows: (Row | null)[]): Screen {
  const text = clip(lines.filter(l => l != null).join('\n').trim(), LIMIT);
  const reply_markup = keyboard(rows);
  return reply_markup ? { text, reply_markup } : { text };
}
