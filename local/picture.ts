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
// them, and the card keeps no copy of it for long either: the job record is cleared, and a saving node in the
// workflow is loaded as a preview one (`previewOnly`), whose file is in RAM and is deleted by gpu/image-sweeper.py
// seconds later. The server's node cache still holds the last job in memory until the next one runs (docs/gpu.md,
// "What the card keeps of a picture").
//
// A picture in flight is stopped by the reader's next message and by `/cancel`. It is not offered as a button of
// its own: by the time it is being drawn the job lock is clear, so the bot shows no cancel control, and moving
// around the menus does not stop it either — it ends with the next scene the reader asks for, or with the photo.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Library, SceneNode } from '../lib/library.ts';
import type { ImageConfig } from './config.ts';
import { estimateTokens, requestStamp, sameContext } from './context.ts';
import { SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, drawOne, latentSizeOf, previewOnly, samplerSettingsOf, settled } from './image-batch.ts';
import type { Comfy, Graph } from './image-batch.ts';
import { INSTRUCTION_TOKENS, STYLE, askJson, assemblePrompt, frameRequest, sheetOf, sheetRequest } from './illustrate.ts';
import type { Character, Description, Excerpt } from './illustrate.ts';
import type { Log } from './model-error.ts';
import { errorCode, safeErrorDetails } from './model-error.ts';
import type { ModelRequest, Provider } from './model.ts';
import { styleChoice, styleLine } from './picture-style.ts';
import type { StyleChoice } from './picture-style.ts';
import { contextParts, storyNarration } from './prompt.ts';
import type { Store } from './store.ts';
import type { Chat, Screen } from './telegram.ts';
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
// One style of a sample: the line that ends its prompt, the word its log row names it with, and the caption that
// goes under its photo, from the reader's catalog.
export type SampleStyle = { line: string; pictureStyle: StyleChoice; caption: Screen };
// A sample of styles, asked for from a style's card or for all of them from the picker (local/ui.ts): the scene the
// reader is at, drawn once more in each of `styles`, in their order. `status` stands in the chat while they are drawn.
export type SampleRequest = {
  userId: string; chat: Chat; storyId: string; branchId: string; nodeId: string; styles: SampleStyle[];
  status: string; signal: AbortSignal; log: Log;
  hold?: () => (() => void) | undefined;
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
  // The story model as the bot names it in each scene's request stamp, and its context. Without it every description
  // is counted by the server before it is sent (`trusted` below).
  model?: { model: string; provider: string; contextTokens: number };
  // The clock and the poll interval of the picture lane, named here so that a test can run the whole step against a
  // fake ComfyUI in milliseconds. `drawOne` waits for ComfyUI's websocket to say the job is over and polls the job's
  // record beside it; a fake without the socket is answered by the polls alone.
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
  // The line of a reader who has not chosen a style.
  const standard = config.style ?? STYLE;

  // The scene's own request, once more: the same system prompt and the same history up to this scene, so that a
  // server with a prefix cache pays for the appended instruction alone (the plan's "What the second call costs").
  const excerpt = (state: Library, storyId: string, nodeId: string, branchId: string) => {
    const memory = state.stories[storyId].branches[branchId]?.memory ?? null;
    const parts = contextParts(state, { storyId, head: nodeId, memory });
    return { system: storyNarration(state, storyId).system, messages: [...parts.seed, ...parts.memory, ...parts.tail], memory };
  };

  // What the server will count for a description of `node`, without asking it. A description is the scene's own
  // request once more, with the scene appended and an instruction last, and without the narrator's rule that request
  // ended with (local/prompt.ts). That rule, 150 tokens and more in every story language, is longer than what the
  // description adds besides: the chat template's marks around two more messages, and the date line a scene may have
  // been given when it was saved. So the scene's measured input and output plus the instruction's estimate is at least
  // that count. It holds only for the model, provider, memory and system prompt the scene was written with, as a
  // scene's own anchor does (local/context.ts).
  const anchorOf = (node: SceneNode, context: Excerpt & { memory: string | null }) => {
    const input = node.usage?.inputTokens ?? -1;
    const output = node.usage?.outputTokens ?? -1;
    if (!deps.model || !node.requestContext || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return null;
    const stamp = requestStamp({ system: context.system, messages: context.messages, maxOutputTokens: 0 }, deps.model.model, context.memory, deps.model.provider);
    return sameContext(node.requestContext, stamp) ? input + output : null;
  };
  // Far below the limit a description goes without a count of its own (local/llama.ts), which saves a round trip of
  // about a second to the card each; the server's count while it answers still decides. Near the limit, or with no
  // anchor, the server counts first as before. The margin needs no allowance for dense scripts: the scene is counted
  // by the server, and the Russian instruction is counted a third or more over.
  const trusted = (model: Provider, request: ModelRequest, anchor: number | null, instruction: number) => {
    if (anchor !== null && deps.model && model.countInput && anchor + instruction < 0.9 * (deps.model.contextTokens - request.maxOutputTokens)) {
      request.estimatedInputTokens = anchor + instruction;
      request.trustEstimate = true;
    }
    return request;
  };

  // The frame of each reader's latest described scene, in memory only and only until the next one: a sample of a
  // style is drawn from it without asking the language model again. Never stored and never logged.
  const frames = new Map<string, { storyId: string; nodeId: string; description: Description; sheet: Character[] }>();

  // The description of one scene: the story's sheet first if it has none yet, then the frame, both on the language
  // model's card. `sharesPrefix` holds it to the slot where the scene's own request is cached, which is where the
  // picture that follows the scene belongs; a sample asked for later may find that slot gone, after a restart or under
  // another reader's scene, and is described like any request of its reader instead.
  async function describeFrame(userId: string, storyId: string, nodeId: string, branchId: string, signal: AbortSignal, log: Log,
    sharesPrefix: boolean) {
    const state = store.read(userId);
    const story = state.stories[storyId];
    if (!story?.nodes[nodeId]) throw Object.assign(new Error('scene_gone'), { code: 'scene_gone' });
    const context = excerpt(state, storyId, nodeId, branchId);
    const anchor = anchorOf(story.nodes[nodeId], context);
    let sheet: Character[] = [];
    // Both calls continue the request the scene itself was written from, so right after the scene they belong in the
    // slot where that prefix is cached and nowhere else: `sharesPrefix` is the scheduler's word for it, and it also
    // ends this turn the moment its own reader asks for the next scene (local/scheduler.ts).
    const description = await inTurn(provider, async model => {
      // One sheet per story, written from the whole history the first time a scene of it is illustrated and
      // kept beside the story's memory afterwards: every later frame of this story repeats these lines
      // verbatim, which is the only thing that made a character recognisable across pictures (step 6).
      sheet = story.sheet ?? [];
      if (!story.sheet) {
        sheet = sheetOf((await askJson(model, trusted(model, sheetRequest(context), anchor, INSTRUCTION_TOKENS.sheet), { signal })).value);
        store.mutate(userId, saved => { const one = saved.stories[storyId]; if (one && !one.sheet) one.sheet = sheet; });
        log('picture_sheet_written', undefined, { sheetCharacters: sheet.length });
      }
      const names = sheet.map(one => one.name);
      const frame = trusted(model, frameRequest(context, names), anchor, INSTRUCTION_TOKENS.frame + estimateTokens(names.join(', ')));
      return (await askJson(model, frame, { signal })).value as unknown as Description;
    }, sharesPrefix ? { holder: userId, sharesPrefix } : { holder: userId });
    frames.set(userId, { storyId, nodeId, description, sheet });
    return { description, sheet };
  }

  // One frame on the picture card in one style line, with the story's seed: a sample of a style and the scene's own
  // picture differ in their last sentence alone.
  async function drawFrame(storyId: string, frame: { description: Description; sheet: Character[] }, line: string, signal: AbortSignal) {
    const assembled = assemblePrompt(frame.description, frame.sheet, line);
    const comfy: Comfy = { baseUrl: config.url, timeoutMs: config.timeoutMs, signal };
    const filled = applyToWorkflow(graph, { checkpoint: config.checkpoint, prompt: assembled.prompt, negative: '',
      seed: seedOf(storyId), steps, sampler, scheduler, cfg, width: size.width, height: size.height });
    return { assembled, drawn: await drawOne(comfy, filled, { waitMs: config.waitMs, pollMs }) };
  }

  // A status line of its own, not the scene's draft: it has to outlive the message it stands under and be removed
  // by id once the photo is there. A chat that refuses it is no reason to skip the picture.
  async function statusLine(chat: Chat, text: string, log: Log) {
    let status: number | undefined;
    try { status = ((await chat.send({ text })) as { message_id?: number }).message_id; }
    catch (error) { log('picture_status_unsent', errorCode(error)); }
    return async (replacement?: string) => {
      if (status === undefined) return;
      try { await (replacement === undefined ? chat.remove(status) : chat.edit(status, { text: replacement })); } catch { /* a hint, never needed */ }
    };
  }

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
    const clear = await statusLine(chat, t.notices.drawing, log);

    let describeMs = 0;
    let pictureStyle: StyleChoice | undefined;
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
      let frame: { description: Description; sheet: Character[] };
      try { frame = await describeFrame(userId, storyId, nodeId, branchId, signal, log, true); }
      finally { release?.(); described(); }
      describeMs = Math.max(0, now() - describeStarted);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

      // The prompt is assembled from the fields, in the order the readers of step 3 asked for, and ends with one
      // style line: the reader's choice as it stands now, which they may have changed while the description was
      // written, or the bot's own. The names of the sheet select appearance lines and are cut out of every field.
      const reader = store.read(userId);
      pictureStyle = styleChoice(reader, standard);
      const { assembled, drawn } = await drawFrame(storyId, frame, styleLine(reader, standard), signal);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      // The photo hangs under the scene it belongs to, and the status line goes only once the photo is there.
      const photoStarted = now();
      await chat.photo(drawn.bytes, request.sceneMessageId);
      const photoMs = Math.max(0, now() - photoStarted);
      await clear();
      log('picture', undefined, { outcome: 'ready', describeMs, imageMs: drawn.totalMs, imageSteps: steps, photoMs,
        photoBytes: drawn.bytes.length, namesStripped: assembled.namesStripped, withoutLook: assembled.withoutLook,
        pictureStyle, ...elapsed() });
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
        { ...safeErrorDetails(error), outcome, cancelled, describeMs, pictureStyle, ...elapsed() });
    }
  }

  return {
    // Off by default and per reader: the story text of a reader who did not ask for this is never drawn, not even
    // on a card we run (AGENTS.md, and the plan's second constraint).
    enabledFor(userId: string) { return config.users.has(userId); },
    // The line of a reader who has not chosen a style; the picker marks the preset it is (local/ui.ts).
    standardStyle: standard,

    async illustrate(request: PictureRequest): Promise<void> {
      // Runs once, however this ends: the caller has work that waits for the model's slot, not for the picture.
      let told = false;
      const described = () => { if (!told) { told = true; try { request.afterDescribe?.(); } catch { /* the caller's own */ } } };
      try { await drawPicture(request, described); }
      finally {
        described();
        // The delete of the job's record went out before the photo did and nobody waited for it (local/image-batch.ts
        // `settled`); the picture is over once it has arrived as well, so that stopping the bot cannot drop it.
        await settled();
      }
    },

    // A sample of styles (`SampleRequest`). The frame of the scene is the one described for its own picture while
    // the bot still holds it, so that a sample costs the picture card alone; otherwise the scene is described again,
    // as a request of this reader, in their own slot when it is free. Every style is then drawn from that one frame,
    // with the story's seed, and sent the moment it is there. The reader asked for these and waits for them, so a
    // failure is told and ends the rest, which would most likely fail the same way; their next move in the story
    // stops it (local/bot.ts).
    async sample(request: SampleRequest): Promise<void> {
      const { userId, chat, storyId, branchId, nodeId, signal, log, styles } = request;
      if (signal.aborted || !styles.length) return;
      const t = texts(store.read(userId).language);
      const clear = await statusLine(chat, request.status, log);
      // A frame is reused only for the very scene it was described from, and only while that scene still exists.
      const kept = frames.get(userId);
      let frameReused = kept?.storyId === storyId && kept.nodeId === nodeId && !!store.read(userId).stories[storyId]?.nodes[nodeId];
      const stylesAsked = styles.length;
      let describeMs = 0;
      let pictureStyle = styles[0].pictureStyle;
      try {
        let frame: { description: Description; sheet: Character[] } | undefined = frameReused ? kept : undefined;
        if (!frame) {
          let release: (() => void) | undefined;
          try { release = request.hold?.(); }
          catch {
            log('picture_sample', 'gpu_not_ready', { outcome: 'skipped', frameReused, pictureStyle, stylesAsked });
            await clear(t.notices.gpuPaused);
            return;
          }
          const describeStarted = now();
          try { frame = await describeFrame(userId, storyId, nodeId, branchId, signal, log, false); }
          finally { release?.(); }
          describeMs = Math.max(0, now() - describeStarted);
        }
        for (const style of styles) {
          pictureStyle = style.pictureStyle;
          if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          const { assembled, drawn } = await drawFrame(storyId, frame, style.line, signal);
          if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          await chat.photo(drawn.bytes, undefined, style.caption);
          log('picture_sample', undefined, { outcome: 'ready', frameReused, describeMs, imageMs: drawn.totalMs, imageSteps: steps,
            namesStripped: assembled.namesStripped, withoutLook: assembled.withoutLook, pictureStyle, stylesAsked });
          // The styles after the first are drawn from the frame already in hand.
          frameReused = true;
          describeMs = 0;
        }
        await clear();
      } catch (error) {
        const code = errorCode(error);
        const cancelled = signal.aborted || code === 'cancelled';
        const outcome = cancelled ? 'cancelled' : GAVE_WAY.includes(String(code)) ? 'skipped' : 'failed';
        await clear(cancelled ? undefined : t.notices.sampleFailed);
        log('picture_sample', cancelled ? 'cancelled' : safeCode(code),
          { ...safeErrorDetails(error), outcome, cancelled, frameReused, describeMs, pictureStyle, stylesAsked });
      }
      // As under a scene: over once the delete of its job's record has arrived too.
      await settled();
    },
  };
}
