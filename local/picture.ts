// A picture under a scene, in the reader's chat (docs/illustrations-plan.md, "What the reader sees").
//
// It runs after the scene has been saved and sent, never before: the reader has the text, and what is left is the
// wait for the picture. A status line stands under the scene while it is made and is replaced by the photo; if the
// reader answers before it arrives, the picture is dropped, because a picture of the scene before last is worse
// than none. The story is never affected by any of this — a failure here leaves the scene exactly as it was.
//
// Two rules of the plan hold the shape of this file:
//   - the description is a second model call on OUR model, and the prompt for the image model is assembled in code
//     from its fields (local/illustrate.ts). No name of a character reaches the image model.
//   - the picture is drawn on a SECOND card, reached through an ssh tunnel on loopback (local/image-batch.ts).
//     The language model's card is 22-25 GB full; the image model needs its own, and `SIMPLE_CHAT_IMAGE_URL` is
//     checked against the model's own server in local/config.ts.
// Nothing here is stored or logged but counts: not the description, not the prompt, not the bytes. The picture is
// stripped of its PNG text chunks by `drawOne` before it is sent, because ComfyUI writes the whole prompt into
// them, and the card is left with no copy of it either: the job record is cleared and a saving node in the
// workflow is loaded as a preview one, which writes to the directory ComfyUI empties (`previewOnly`).
//
// A picture in flight is stopped by the reader's next message and by `/cancel`. It is not offered as a button of
// its own: by the time it is being drawn the job lock is clear, so the bot shows no cancel control, and moving
// around the menus does not stop it either — it ends with the next scene the reader asks for, or with the photo.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Library } from '../lib/library.ts';
import type { ImageConfig } from './config.ts';
import { SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, drawOne, latentSizeOf, previewOnly, samplerSettingsOf } from './image-batch.ts';
import type { Comfy, Graph } from './image-batch.ts';
import { STYLE, askJson, assemblePrompt, frameRequest, sheetOf, sheetRequest } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { Log } from './model-error.ts';
import { errorCode, safeErrorDetails } from './model-error.ts';
import type { Provider } from './model.ts';
import { contextParts, storyNarration } from './prompt.ts';
import type { Store } from './store.ts';
import type { Chat } from './telegram.ts';
import { texts } from './text.ts';
import { inTurn } from './turn.ts';

// What the bot knows when the scene is on its way out. `sceneAt` is the moment the scene's own message was sent:
// the wait this feature is judged by starts there and ends at the photo.
export type PictureRequest = {
  userId: string; chat: Chat; storyId: string; nodeId: string; branchId: string;
  sceneMessageId: number | undefined; sceneAt: number; signal: AbortSignal; log: Log;
  // The GPU of the language model, held for the description call alone, as local/prepare.ts holds it for work done
  // ahead of need. It throws when the card is paused, and then nothing is described and nothing is drawn.
  hold?: () => (() => void) | undefined;
  // Called once, as soon as the description is over and the language model's slot is free again, whether it
  // answered, failed or was given up. What the drawing that follows needs is on the other card, so the bot starts
  // the reader's next turn's work here rather than after the photo (local/bot.ts `prepareNext`).
  afterDescribe?: () => void;
};
export type Illustrator = ReturnType<typeof createIllustrator>;

// By the time a code reaches a log row it is a word from a closed set (local/main.ts drops anything else), so a
// provider's or a transport's own message can never become one. A Telegram failure keeps its numeric status.
const safeCode = (value: unknown) =>
  typeof value === 'number' ? value : typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'picture_failed';

// A description call that was stopped because somebody else needed the model (local/scheduler.ts): a picture is the
// one thing here that may be given up, and giving it up is not a failure of the feature.
const GAVE_WAY = ['background_preempted', 'background_unavailable', 'background_timeout'];

// One seed per story, from the story's id. Free sampling redraws the world from nothing in every scene; a seed that
// stays put holds a place steadier between visits, and costs nothing (the plan, "What survives without reference
// images"). Which seed it is is never logged: it says nothing a count can say.
const seedOf = (storyId: string) => parseInt(createHash('sha256').update(storyId).digest('hex').slice(0, 8), 16);

export function createIllustrator(config: ImageConfig, deps: {
  store: Store; provider: Provider;
  // The clock and the poll interval of the picture lane, named here so that a test can run the whole step against a
  // fake ComfyUI in milliseconds. ComfyUI has no event to wait for; `drawOne` polls its history.
  now?: () => number; pollMs?: number;
}) {
  const { store, provider, now = Date.now, pollMs } = deps;
  // The graph is read once, here, so that a workflow that is not a ComfyUI API export fails when the bot starts
  // rather than under the first reader. Its own size and sampler settings are what it was pinned at on the card,
  // and the bot overrides none of them: this is the graph somebody measured.
  // A saving node becomes a preview one: a graph pinned on the card would otherwise leave a copy of the picture,
  // with the prompt in its text chunks, in a directory the API cannot empty (`previewOnly`). A file that is not
  // there or is not JSON fails under a code of its own: `ENOENT` is upper case and a SyntaxError has no code at
  // all, so the startup row would otherwise say only that something went wrong (local/main.ts).
  let graph: Graph;
  try { graph = previewOnly(apiGraph(JSON.parse(readFileSync(config.workflow, 'utf8')))); }
  catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^workflow_[a-z_]+$/.test(code)) throw error;
    throw Object.assign(new Error('SIMPLE_CHAT_IMAGE_WORKFLOW must name a readable ComfyUI graph exported in API format'),
      { code: 'workflow_unreadable' });
  }
  const latent = latentSizeOf(graph);
  if (!latent) throw new Error('SIMPLE_CHAT_IMAGE_WORKFLOW needs a sampler whose latent_image comes from a node with a width and a height');
  const size = latent;
  const settings = samplerSettingsOf(graph);
  const steps = settings.steps ?? SAMPLER_DEFAULTS.steps;
  const sampler = settings.sampler ?? SAMPLER_DEFAULTS.sampler;
  const scheduler = settings.scheduler ?? SAMPLER_DEFAULTS.scheduler;
  const cfg = settings.cfg ?? SAMPLER_DEFAULTS.cfg;

  // The scene's own request, once more: the same system prompt and the same history up to this scene, so that a
  // server with a prefix cache pays for the appended instruction alone (the plan's "What the second call costs").
  const excerpt = (state: Library, storyId: string, nodeId: string, branchId: string) => {
    const parts = contextParts(state, { storyId, head: nodeId, memory: state.stories[storyId].branches[branchId]?.memory ?? null });
    return { system: storyNarration(state, storyId).system, messages: [...parts.seed, ...parts.memory, ...parts.tail] };
  };

  // One picture, from the status line to the photo. `described` is called the moment the language model is out
  // of it, so that the caller may start the work that was waiting for its slot while the card still draws.
  async function drawPicture(request: PictureRequest, described: () => void): Promise<void> {
    const { userId, chat, storyId, nodeId, branchId, signal, log } = request;
    if (signal.aborted) return;
    const elapsed = () => {
      const waited = Math.max(0, now() - request.sceneAt);
      return { pictureAfterSceneMs: waited, pictureSeconds: Math.round(waited / 1000) };
    };
    const t = texts(store.read(userId).language);
    // A status line of its own, not the scene's draft: it has to outlive the scene's message and be removed by id
    // once the photo is there. A chat that refuses it is no reason to skip the picture.
    let status: number | undefined;
    try { status = ((await chat.send({ text: t.notices.drawing })) as { message_id?: number }).message_id; }
    catch (error) { log('picture_status_unsent', errorCode(error)); }
    const clear = async (text?: string) => {
      if (status === undefined) return;
      try { await (text === undefined ? chat.remove(status) : chat.edit(status, { text })); } catch { /* a hint, never needed */ }
    };

    let describeMs = 0;
    try {
      // The description call, on the language model's card, holding it the way a job holds it and no longer.
      const describeStarted = now();
      let release: (() => void) | undefined;
      try { release = request.hold?.(); }
      catch {
        log('picture', 'gpu_not_ready', { outcome: 'skipped', ...elapsed() });
        await clear();
        return;
      }
      let sheet: Character[] = [];
      let description: Description;
      try {
        const state = store.read(userId);
        const story = state.stories[storyId];
        if (!story?.nodes[nodeId]) throw Object.assign(new Error('scene_gone'), { code: 'scene_gone' });
        const context = excerpt(state, storyId, nodeId, branchId);
        // Both calls continue the request the scene itself was written from, so they belong in the slot where that
        // prefix is cached and nowhere else: `sharesPrefix` is the scheduler's word for it, and it also ends this
        // turn the moment its own reader asks for the next scene (local/scheduler.ts).
        description = await inTurn(provider, async model => {
          // One sheet per story, written from the whole history the first time a scene of it is illustrated and
          // kept beside the story's memory afterwards: every later frame of this story repeats these lines
          // verbatim, which is the only thing that made a character recognisable across pictures (step 6).
          sheet = story.sheet ?? [];
          if (!story.sheet) {
            sheet = sheetOf((await askJson(model, sheetRequest(context), { signal })).value);
            store.mutate(userId, saved => { const one = saved.stories[storyId]; if (one && !one.sheet) one.sheet = sheet; });
            log('picture_sheet_written', undefined, { sheetCharacters: sheet.length });
          }
          return (await askJson(model, frameRequest(context, sheet.map(one => one.name)), { signal }))
            .value as unknown as Description;
        }, { holder: userId, sharesPrefix: true });
      } finally { release?.(); described(); }
      describeMs = Math.max(0, now() - describeStarted);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

      // The prompt is assembled here, from the fields, in the order the readers of step 3 asked for, and ends
      // with our one style line. The names of the sheet select appearance lines and are cut out of every field.
      const assembled = assemblePrompt(description, sheet, config.style ?? STYLE);
      const comfy: Comfy = { baseUrl: config.url, timeoutMs: config.timeoutMs, signal };
      const filled = applyToWorkflow(graph, { checkpoint: config.checkpoint, prompt: assembled.prompt, negative: '',
        seed: seedOf(storyId), steps, sampler, scheduler, cfg, width: size.width, height: size.height });
      const drawn = await drawOne(comfy, filled, { waitMs: config.waitMs, pollMs });
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      // The photo hangs under the scene it belongs to, and the status line goes only once the photo is there.
      await chat.photo(drawn.bytes, request.sceneMessageId);
      await clear();
      log('picture', undefined, { outcome: 'ready', describeMs, imageMs: drawn.totalMs, imageSteps: steps,
        namesStripped: assembled.namesStripped, withoutLook: assembled.withoutLook, ...elapsed() });
    } catch (error) {
      const code = errorCode(error);
      const cancelled = signal.aborted || code === 'cancelled';
      // The scheduler gave the slot to somebody who is waiting for a scene, which is the order the plan asks for:
      // nothing failed, this reader simply gets no picture for this scene.
      const gaveWay = GAVE_WAY.includes(String(code));
      const outcome = cancelled ? 'cancelled' : gaveWay ? 'skipped' : 'failed';
      // A reader who has moved on gets no apology, only their own next scene; a reader still waiting is told once.
      await clear(outcome === 'failed' ? t.notices.pictureFailed : undefined);
      log('picture', cancelled ? 'cancelled' : safeCode(code),
        { ...safeErrorDetails(error), outcome, cancelled, describeMs, ...elapsed() });
    }
  }

  return {
    // Off by default and per reader: the story text of a reader who did not ask for this is never drawn, not even
    // on a card we run (AGENTS.md, and the plan's second constraint).
    enabledFor(userId: string) { return config.users.has(userId); },

    async illustrate(request: PictureRequest): Promise<void> {
      // Runs once, however this ends: the caller has work that waits for the model's slot, not for the picture.
      let told = false;
      const described = () => { if (!told) { told = true; try { request.afterDescribe?.(); } catch { /* the caller's own */ } } };
      try { await drawPicture(request, described); } finally { described(); }
    },
  };
}
