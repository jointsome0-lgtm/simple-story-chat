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
// Nothing here is stored or logged but counts: not the description, not the prompt, not the bytes. The prompt goes
// to the reader alone, folded under the photo it was drawn from (`foldedPrompt`), as their own. The picture is
// stripped of its PNG text chunks by `drawOne` before it is sent, because ComfyUI writes the whole prompt into
// them, and the card keeps no copy of it for long either: the job record is cleared, and a saving node in the
// workflow is loaded as a preview one (`previewOnly`), whose file is in RAM and is deleted by gpu/image-sweeper.py
// seconds later. The server's node cache still holds the last job in memory until the next one runs (docs/gpu.md,
// "What the card keeps of a picture").
//
// A picture in flight is stopped by the reader's next message and by `/cancel`. It is not offered as a button of
// its own: by the time it is being drawn the job lock is clear, so the bot shows no cancel control, and moving
// around the menus does not stop it either — it ends with the next scene the reader asks for, or with the photo.
//
// A picture goes with its scene. Every photo is recorded in the reader's library as it is sent, and deleting the
// scene with its seed or branch deletes the photo from the chat (local/bot.ts); a picture whose scene is deleted
// while it is being made is not sent at all (`sendKept`). The folded prompt under the photo goes with it the same way.
//
// A portrait of one person of a story's sheet (`portrait`) is drawn on request from their card in the characters'
// screens (local/ui.ts), from their look alone, and goes with its story the same way. The one a reader keeps is a
// file beside the database (local/store.ts), to pick a reference by later; no frame uses it.
import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recordPicture } from '../lib/library.ts';
import type { Library, SceneNode, Story } from '../lib/library.ts';
import type { ImageConfig } from './config.ts';
import { estimateTokens, requestStamp, sameContext } from './context.ts';
import { SAMPLER_DEFAULTS, apiGraph, applyToWorkflow, drawOne, latentSizeOf, previewOnly, referenceSlots, samplerSettingsOf, settled,
  textEncoderOf } from './image-batch.ts';
import type { Comfy, Graph } from './image-batch.ts';
import { STYLE, askJson, assemblePrompt, frameRequest, matchSheet, sheetOf, sheetRequest, sheetWithoutOutfits } from './illustrate.ts';
import type { Character, Description, Excerpt } from './illustrate.ts';
import { portraitDescription } from './image-portraits.ts';
import type { Log } from './model-error.ts';
import { errorCode, safeErrorDetails } from './model-error.ts';
import type { ModelRequest, Provider } from './model.ts';
import { styleChoice, styleLine } from './picture-style.ts';
import type { StyleChoice } from './picture-style.ts';
import { contextParts, storyNarration } from './prompt.ts';
import type { Store } from './store.ts';
import type { Chat, Screen } from './telegram.ts';
import { texts } from './text.ts';
import { qwenPromptTokens } from './tokenizer.ts';
import type { QwenTokenizer } from './tokenizer.ts';
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
// A portrait of one person of a story's sheet (`portrait`), by story and name as their card showed them: the id its
// keep button carries (`keepPortrait`), the caption with that button, and what stands in the chat while it is drawn.
export type PortraitRequest = {
  userId: string; chat: Chat; storyId: string; name: string; candidate: string; caption: Screen; status: string;
  signal: AbortSignal; log: Log;
};
export type Illustrator = ReturnType<typeof createIllustrator>;

// By the time a code reaches a log row it is a word from a closed set (local/main.ts drops anything else), so a
// provider's or a transport's own message can never become one. A Telegram failure keeps its numeric status.
const safeCode = (value: unknown) =>
  typeof value === 'number' ? value : typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : 'picture_failed';

// A description call that was stopped because somebody else needed the model (local/scheduler.ts): a picture is the
// one thing here that may be given up, and giving it up is not a failure of the feature.
const GAVE_WAY = ['background_preempted', 'background_unavailable', 'background_timeout'];

// The scene of a picture is no longer in its reader's library: they deleted it, with its seed or its branch. That
// ends the picture the way their next message does, without a word; the row keeps this code, so that the two can
// still be told apart. `details` are the counts of a message that had to be taken back (`sendKept`).
const sceneGone = (details?: object) => Object.assign(new Error('scene_gone'), { code: 'scene_gone', ...details });

// The sheet of a story as one frame at `nodeId` starts from: each person in the clothes of the nearest picture above
// it in its own line of the story — the scene itself first, when it was described before — or, with no such
// picture, in the sheet's own outfit. A branch walks its own parents, so a change of clothes in one line of the story
// never reaches another.
export function wornAt(story: Story, nodeId: string, sheet: Character[]): Character[] {
  const worn = new Map<string, string>();
  const seen = new Set<string>();
  for (let id: string | null = nodeId; id && !seen.has(id) && worn.size < sheet.length; id = story.nodes[id]?.parent ?? null) {
    seen.add(id);
    for (const [name, clothes] of Object.entries(story.nodes[id]?.clothes ?? {}))
      if (!worn.has(name) && typeof clothes === 'string' && clothes.trim()) worn.set(name, clothes);
  }
  return sheet.map(character => ({ ...character, outfit: worn.get(character.name) ?? character.outfit ?? '' }));
}

// What a frame says its people of the sheet wear, by sheet name, and how many of them it dresses otherwise than
// they started. A person the frame left without clothes, or named twice, keeps what they had.
export function clothesOf(description: Description, worn: Character[]): { clothes: Record<string, string>; changed: number } {
  const names = worn.map(character => character.name);
  const clothes: Record<string, string> = {};
  let changed = 0;
  for (const person of description.people ?? []) {
    const name = matchSheet(person?.who ?? '', names);
    const value = typeof person?.clothes === 'string' ? person.clothes.trim() : '';
    if (name === null || !value || name in clothes) continue;
    clothes[name] = value;
    if (value !== (worn.find(character => character.name === name)?.outfit ?? '').trim()) changed++;
  }
  return { clothes, changed };
}

// The longest look a reader may write for a person of a sheet (local/bot.ts), in characters: the sheet's own are 15-25
// words, and the room left is the reader's, as for a style of their own.
export const LOOK_CHARS = 400;

// A person of a sheet is their name, apart from spaces and case. One the model renames is somebody new, and what the
// reader made of the old name stays with it: merging two people by a like name would be worse than keeping both.
type SheetEntry = NonNullable<Story['sheet']>[number];
const personKey = (name: string) => name.trim().toLowerCase();

// A button names a person by their place on the sheet and a short hash of their name, never the name itself, within
// Telegram's 64 bytes. A sheet written anew may put somebody else in that place, and the button is then refused
// rather than acting on them: `personAt` finds the person only while the two still agree.
export const personTag = (name: string) => createHash('sha256').update(personKey(name)).digest('hex').slice(0, 8);
export function personAt(story: Story | undefined, index: string | undefined, tag: string | undefined) {
  const person = story && /^\d+$/.test(index ?? '') ? story.sheet?.[Number(index)] : undefined;
  return person && typeof person.name === 'string' && typeof person.look === 'string' && personTag(person.name) === tag
    ? { ...person, index: Number(index) } : undefined;
}

// A sheet written again in place of an older one (`describeFrame`) keeps what the reader made of it: a look they wrote
// themselves and a portrait they kept, under the same name, or with the person on their own if the new sheet lost the
// name. The card shows a portrait as drawn from another look if the new one differs (local/ui.ts).
export function rewrittenSheet(before: SheetEntry[], written: Character[]): SheetEntry[] {
  const old = new Map(before.map(one => [personKey(one.name), one]));
  const kept = written.map(one => {
    const mine = old.get(personKey(one.name));
    return { ...one, ...mine?.edited ? { look: mine.look, edited: true } : {}, ...mine?.portrait ? { portrait: mine.portrait } : {} };
  });
  const names = new Set(written.map(one => personKey(one.name)));
  return [...kept, ...before.filter(one => (one.edited || one.portrait) && !names.has(personKey(one.name))).map(one => ({ ...one, outfit: one.outfit ?? '' }))];
}

// A portrait to pick a reference by (`portrait`): the whole figure from the front, so that the build, the height, the
// silhouette and every permanent mark show, in plain close-fitting clothes of the bot's own that hide none of it and
// follow the person into no scene, standing without an expression put on them — a heavy brow or a hard stare is the
// look's to say — and in a plain style of its own, never the reader's. Two portraits of one look differ by the seed.
export const PORTRAIT_CLOTHES = 'wearing a plain close-fitting white tank top, close-fitting dark grey trousers and plain dark shoes';
export const PORTRAIT_STYLE = 'Neutral character reference illustration with natural colors, realistic proportions and clean even rendering, the build, silhouette and permanent marks clearly readable.';
export function portraitPrompt(name: string, look: string) {
  const description = portraitDescription(name);
  description.people = description.people.map(person => ({ ...person, clothes: PORTRAIT_CLOTHES,
    action: 'stands upright facing the viewer, arms relaxed at the sides' }));
  return assemblePrompt(description, [{ name, look, outfit: '' }], PORTRAIT_STYLE);
}
// The portrait a reader was shown last is held for its keep button this long, and only if Telegram would take it as
// a photo at all.
const PORTRAIT_HELD_MS = 30 * 60 * 1000;
const PORTRAIT_BYTES = 10 * 1024 * 1024;

// The prompt of a picture as a rich message folded to one line, `summary`, which the reader opens to read or copy it
// (docs/telegram-ui.md). It is Telegram's rich HTML with the prompt as plain text, which wraps to the width of a
// phone: a code block does not, and the first one sent this way was read by scrolling sideways. Escaping the three
// characters HTML gives a meaning to keeps anything a description holds from being read as a tag.
export function foldedPrompt(summary: string, prompt: string): string {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<details><summary>${escape(summary)}</summary>${escape(prompt)}</details>`;
}

// One seed per story, from the story's id. Free sampling redraws the world from nothing in every scene; a seed that
// stays put holds a place steadier between visits, and costs nothing (the plan, "What survives without reference
// images"). Which seed it is is never logged: it says nothing a count can say.
const seedOf = (storyId: string) => parseInt(createHash('sha256').update(storyId).digest('hex').slice(0, 8), 16);

// How many tokens of a prompt the picture model is conditioned on, counted as the graph's text encoder counts them
// (local/tokenizer.ts, docs/tokenizers.md): the prompt, the few tokens of the encoder's template that stay, and six
// for each reference picture of an edit graph. Undefined for a graph whose encoder that tokenizer does not know.
export function encoderTokens(qwen: QwenTokenizer, graph: Graph): ((prompt: string) => number) | undefined {
  const encoder = textEncoderOf(graph);
  const images = referenceSlots(graph).length;
  return encoder ? prompt => qwenPromptTokens(qwen, prompt, encoder, { images }).conditioning : undefined;
}

// How many tokens one text is on its own, as the same encoder tokenizes it: a field of a sheet on the characters' card
// (local/ui.ts), which is part of a prompt and not one, so that no template is counted with it.
export function textTokens(qwen: QwenTokenizer, graph: Graph): ((text: string) => number) | undefined {
  const encoder = textEncoderOf(graph);
  return encoder ? text => qwenPromptTokens(qwen, text, encoder).prompt : undefined;
}

export function createIllustrator(config: ImageConfig, deps: {
  store: Store; provider: Provider;
  // The story model as the bot names it in each scene's request stamp, and its context. Without it every description
  // is counted by the server before it is sent (`trusted` below).
  model?: { model: string; provider: string; contextTokens: number };
  // The clock and the poll interval of the picture lane, named here so that a test can run the whole step against a
  // fake ComfyUI in milliseconds. `drawOne` waits for ComfyUI's websocket to say the job is over and polls the job's
  // record beside it; a fake without the socket is answered by the polls alone.
  now?: () => number; pollMs?: number;
  // A counter of a prompt's tokens as the text encoder of the graph read below takes them (`encoderTokens`), for the
  // note under each photo and its log row (`promptSize`). Asked once, at startup; without an answer the note gives
  // the prompt's characters alone.
  promptTokens?: (graph: Graph) => ((prompt: string) => number) | undefined;
  // The same for one field of a sheet on its own (`textTokens`), for the characters' card.
  textTokens?: (graph: Graph) => ((text: string) => number) | undefined;
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
  const promptTokens = deps.promptTokens?.(graph);
  const fieldTokens = deps.textTokens?.(graph);
  // A kept portrait names the graph it was drawn with by this, as it stood after the bot loaded it.
  const graphHash = createHash('sha256').update(JSON.stringify(graph)).digest('hex').slice(0, 16);
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
  const trusted = (model: Provider, request: ModelRequest, anchor: number | null) => {
    const instruction = estimateTokens(request.messages.at(-1)?.content ?? '');
    if (anchor !== null && deps.model && model.countInput && anchor + instruction < 0.9 * (deps.model.contextTokens - request.maxOutputTokens)) {
      request.estimatedInputTokens = anchor + instruction;
      request.trustEstimate = true;
    }
    return request;
  };

  // The frame of each reader's latest described scene, in memory only and only until the next one: a sample of a
  // style is drawn from it without asking the language model again. Never stored and never logged.
  const frames = new Map<string, { storyId: string; nodeId: string; description: Description; sheet: Character[] }>();
  // The portrait each reader was shown last, for its keep button (`keepPortrait`), with the look it shows: in memory
  // only, one per reader, until the next one, the keep, a delivery that failed, or PORTRAIT_HELD_MS. That one timer
  // is cleared with it, and knows the reader and the id alone, so that the map is the only holder of the picture: a
  // timer that held it would keep every picture replaced or kept alive for the whole half hour.
  type Candidate = { id: string; storyId: string; name: string; look: string; seed: number; bytes: Uint8Array; at: number };
  const candidates = new Map<string, Candidate & { timer: ReturnType<typeof setTimeout> }>();
  function letGo(userId: string, id?: string) {
    const held = candidates.get(userId);
    if (!held || (id !== undefined && held.id !== id)) return;
    clearTimeout(held.timer);
    candidates.delete(userId);
  }
  function hold(userId: string, candidate: Candidate) {
    letGo(userId);
    const { id } = candidate;
    const timer = setTimeout(() => letGo(userId, id), PORTRAIT_HELD_MS);
    timer.unref();
    candidates.set(userId, { ...candidate, timer });
  }

  // The description of one scene: the story's sheet first if it has none yet, then the frame, both on the language
  // model's card. `sharesPrefix` holds it to the slot where the scene's own request is cached, which is where the
  // picture that follows the scene belongs; a sample asked for later may find that slot gone, after a restart or under
  // another reader's scene, and is described like any request of its reader instead.
  async function describeFrame(userId: string, storyId: string, nodeId: string, branchId: string, signal: AbortSignal, log: Log,
    sharesPrefix: boolean) {
    const state = store.read(userId);
    const story = state.stories[storyId];
    if (!story?.nodes[nodeId]) throw sceneGone();
    const context = excerpt(state, storyId, nodeId, branchId);
    const anchor = anchorOf(story.nodes[nodeId], context);
    let sheet: Character[] = [];
    // Both calls continue the request the scene itself was written from, so right after the scene they belong in the
    // slot where that prefix is cached and nowhere else: `sharesPrefix` is the scheduler's word for it, and it also
    // ends this turn the moment its own reader asks for the next scene (local/scheduler.ts).
    const description = await inTurn(provider, async model => {
      // One sheet per story, written from the whole history the first time a scene of it is illustrated and
      // kept beside the story's memory afterwards: every later frame of this story repeats these lines
      // verbatim, which is the only thing that made a character recognisable across pictures (step 6). A sheet
      // from before clothes left it is written once more, from the history as it stands now.
      const older = !!story.sheet && sheetWithoutOutfits(story.sheet);
      if (!story.sheet || older) {
        const written = sheetOf((await askJson(model, trusted(model, sheetRequest(context), anchor), { signal })).value);
        store.mutate(userId, saved => {
          const one = saved.stories[storyId];
          if (one && (!one.sheet || sheetWithoutOutfits(one.sheet))) one.sheet = rewrittenSheet(one.sheet ?? [], written);
        });
        log('picture_sheet_written', undefined, { sheetCharacters: written.length, sheetRewritten: older });
      }
      sheet = wornAt(story, nodeId, store.read(userId).stories[storyId]?.sheet ?? []);
      return (await askJson(model, trusted(model, frameRequest(context, sheet), anchor), { signal })).value as unknown as Description;
    }, sharesPrefix ? { holder: userId, sharesPrefix } : { holder: userId });
    // What the sheet's people wear in this frame is what the next picture below this scene starts from.
    const worn = clothesOf(description, sheet);
    if (Object.keys(worn.clothes).length) store.mutate(userId, saved => {
      const node = saved.stories[storyId]?.nodes[nodeId];
      if (node) node.clothes = { ...node.clothes, ...worn.clothes };
    });
    frames.set(userId, { storyId, nodeId, description, sheet });
    return { description, sheet, clothesChanged: worn.changed };
  }

  // The size of a prompt that ends with the style `line`: its characters, and, with a tokenizer, its tokens and how
  // many of them the line adds to the description before it. The tokens of the line alone would miss the one where
  // the description's last word meets it. It is counted once the photo is in the chat, so a tokenizer that fails
  // costs the counts alone and never the picture.
  const promptSize = (prompt: string, line: string) => {
    const promptCharacters = [...prompt].length;
    try {
      if (promptTokens) {
        const pictureTokens = promptTokens(prompt);
        const described = promptTokens(prompt.slice(0, prompt.length - line.length).trimEnd());
        return { promptCharacters, pictureTokens, styleTokens: Math.max(0, pictureTokens - described) };
      }
    } catch { /* the characters alone */ }
    return { promptCharacters };
  };

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

  // A message of a picture — the photo, and the prompt folded under it — goes out only while its scene is in the
  // reader's library, and is recorded there the moment it is sent, so that deleting the scene deletes it too
  // (local/bot.ts). A deletion that lands while it is on its way finds no record of it yet; the record then finds no
  // scene, and the message is taken back at once. The two writes of the library cannot interleave, so one of them
  // always sees the other. A portrait has no scene and goes with its story. Resolves to the id of the message.
  async function sendKept(request: { userId: string; chat: Chat; storyId: string; nodeId?: string },
    send: () => Promise<number | undefined>) {
    const { userId, chat, storyId, nodeId } = request;
    const there = (state: Library) => !!state.stories[storyId] && (nodeId === undefined || !!state.stories[storyId].nodes[nodeId]);
    if (!there(store.read(userId))) throw sceneGone();
    const messageId = await send();
    // A message whose id did not come back can be neither recorded nor taken back.
    if (messageId === undefined) return undefined;
    const kept = store.mutate(userId, state => {
      if (!there(state)) return false;
      recordPicture(state, { storyId, nodeId, messageId, at: now() });
      return true;
    });
    if (kept) return messageId;
    let removed = 0;
    try { await chat.remove(messageId); removed = 1; } catch { /* counted in the row */ }
    throw sceneGone({ picturesRemoved: removed, picturesNotRemoved: 1 - removed });
  }

  // The prompt of a photo, folded under it. The photo is what the reader waited for: a note that does not go out
  // costs them the note alone and is told by a row of its own, unless its scene is gone, which ends the picture.
  async function sendPrompt(request: { userId: string; chat: Chat; storyId: string; nodeId: string; log: Log },
    photo: number | undefined, prompt: string, size: { promptCharacters: number; pictureTokens?: number; styleTokens?: number }) {
    const t = texts(store.read(request.userId).language);
    const summary = t.notices.promptSummary(size.promptCharacters, size.pictureTokens ?? null, size.styleTokens ?? null);
    try { await sendKept(request, () => request.chat.note(foldedPrompt(summary, prompt), photo)); }
    catch (error) {
      if (errorCode(error) === 'scene_gone') throw error;
      request.log('picture_prompt_unsent', errorCode(error));
    }
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
      let frame: { description: Description; sheet: Character[]; clothesChanged: number };
      try { frame = await describeFrame(userId, storyId, nodeId, branchId, signal, log, true); }
      finally { release?.(); described(); }
      describeMs = Math.max(0, now() - describeStarted);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });

      // The prompt is assembled from the fields, in the order the readers of step 3 asked for, and ends with one
      // style line: the reader's choice as it stands now, which they may have changed while the description was
      // written, or the bot's own. The names of the sheet select appearance lines and are cut out of every field.
      const reader = store.read(userId);
      pictureStyle = styleChoice(reader, standard);
      const line = styleLine(reader, standard);
      const { assembled, drawn } = await drawFrame(storyId, frame, line, signal);
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      // The photo hangs under the scene it belongs to, and the status line goes only once the photo is there; the
      // prompt follows it, folded.
      const photoStarted = now();
      const photo = await sendKept(request, () => chat.photo(drawn.bytes, request.sceneMessageId));
      const photoMs = Math.max(0, now() - photoStarted);
      await clear();
      const size = promptSize(assembled.prompt, line);
      await sendPrompt(request, photo, assembled.prompt, size);
      log('picture', undefined, { outcome: 'ready', describeMs, imageMs: drawn.totalMs, imageSteps: steps, photoMs,
        photoBytes: drawn.bytes.length, namesStripped: assembled.namesStripped, withoutLook: assembled.withoutLook,
        clothesChanged: frame.clothesChanged, pictureStyle, ...size, ...elapsed() });
    } catch (error) {
      const code = errorCode(error);
      const cancelled = signal.aborted || code === 'cancelled' || code === 'scene_gone';
      // The scheduler gave the slot to somebody who is waiting for a scene, which is the order the plan asks for:
      // nothing failed, this reader simply gets no picture for this scene.
      const gaveWay = GAVE_WAY.includes(String(code));
      const outcome = cancelled ? 'cancelled' : gaveWay ? 'skipped' : 'failed';
      // A reader who has moved on gets no apology, only their own next scene; a reader still waiting is told once.
      await clear(outcome === 'failed' ? t.notices.pictureFailed : undefined);
      log('picture', signal.aborted ? 'cancelled' : safeCode(code),
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
      // A frame is reused only for the very scene it was described from, only while that scene still exists, and only
      // while its people have the looks it was described with: a look the reader edited since is described anew, and
      // so is one edited while that frame was still being described.
      const kept = frames.get(userId);
      const story = store.read(userId).stories[storyId];
      let frameReused = kept?.storyId === storyId && kept.nodeId === nodeId && !!story?.nodes[nodeId]
        && kept.sheet.every(one => story.sheet?.find(other => other.name === one.name)?.look === one.look);
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
          const photo = await sendKept(request, () => chat.photo(drawn.bytes, undefined, style.caption));
          const size = promptSize(assembled.prompt, style.line);
          await sendPrompt(request, photo, assembled.prompt, size);
          log('picture_sample', undefined, { outcome: 'ready', frameReused, describeMs, imageMs: drawn.totalMs, imageSteps: steps,
            namesStripped: assembled.namesStripped, withoutLook: assembled.withoutLook, pictureStyle, stylesAsked, ...size });
          // The styles after the first are drawn from the frame already in hand.
          frameReused = true;
          describeMs = 0;
        }
        await clear();
      } catch (error) {
        const code = errorCode(error);
        const cancelled = signal.aborted || code === 'cancelled' || code === 'scene_gone';
        const outcome = cancelled ? 'cancelled' : GAVE_WAY.includes(String(code)) ? 'skipped' : 'failed';
        await clear(cancelled ? undefined : t.notices.sampleFailed);
        log('picture_sample', signal.aborted ? 'cancelled' : safeCode(code),
          { ...safeErrorDetails(error), outcome, cancelled, frameReused, describeMs, pictureStyle, stylesAsked });
      }
      // As under a scene: over once the delete of its job's record has arrived too.
      await settled();
    },

    // The tokens of one field of a sheet as the picture model's text encoder takes that text alone, or null without a
    // tokenizer for it (the characters' card, local/ui.ts).
    textTokens(text: string): number | null {
      try { return fieldTokens ? fieldTokens(text) : null; } catch { return null; }
    },

    // A portrait of one person of a story's sheet (`PortraitRequest`), drawn again with a new seed each time the reader
    // asks, from their look alone (`portraitPrompt`). It needs no description, so it neither wakes nor holds the
    // language model's card: it waits for the picture card alone. The one sent last is held for its keep button; one
    // whose person, story or look is gone by the time it is drawn is not sent. The reader's next move in the story
    // stops it, as it stops a sample (local/bot.ts), and a failure is told, since they wait for it.
    async portrait(request: PortraitRequest): Promise<void> {
      const { userId, chat, storyId, name, signal, log } = request;
      // The button is offered only to a reader who is drawn for, and that is asked again where the work starts.
      if (signal.aborted || !config.users.has(userId)) return;
      const t = texts(store.read(userId).language);
      const clear = await statusLine(chat, request.status, log);
      const lookNow = () => store.read(userId).stories[storyId]?.sheet?.find(one => one.name === name)?.look;
      try {
        const look = lookNow();
        if (look === undefined) throw sceneGone();
        const seed = randomInt(2 ** 32);
        const comfy: Comfy = { baseUrl: config.url, timeoutMs: config.timeoutMs, signal };
        const drawn = await drawOne(comfy, applyToWorkflow(graph, { checkpoint: config.checkpoint, prompt: portraitPrompt(name, look).prompt,
          negative: '', seed, steps, sampler, scheduler, cfg, width: size.width, height: size.height }), { waitMs: config.waitMs, pollMs });
        if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        if (lookNow() !== look) throw sceneGone();
        // Held before it is sent, so that its button finds it however soon it is pressed, and let go if it never
        // arrives. The one shown before goes either way: its button keeps nothing once a newer one is shown.
        if (drawn.bytes.length <= PORTRAIT_BYTES) hold(userId, { id: request.candidate, storyId, name, look, seed, bytes: drawn.bytes, at: now() });
        else letGo(userId);
        const photoStarted = now();
        try { await sendKept({ userId, chat, storyId }, () => chat.photo(drawn.bytes, undefined, request.caption)); }
        catch (error) {
          letGo(userId, request.candidate);
          throw error;
        }
        const photoMs = Math.max(0, now() - photoStarted);
        await clear();
        log('picture_portrait', undefined, { outcome: 'ready', imageMs: drawn.totalMs, imageSteps: steps, photoMs, photoBytes: drawn.bytes.length });
      } catch (error) {
        const code = errorCode(error);
        const cancelled = signal.aborted || code === 'cancelled' || code === 'scene_gone';
        await clear(cancelled ? undefined : t.characters.portraitFailed);
        log('picture_portrait', signal.aborted ? 'cancelled' : safeCode(code),
          { ...safeErrorDetails(error), outcome: cancelled ? 'cancelled' : 'failed', cancelled });
      }
      await settled();
    },

    // Keeps the portrait a reader was shown under `candidateId`, inside the library write that `state` belongs to: the
    // file is written first and the sheet refers to it once that write commits; the caller sweeps the file it replaced
    // afterwards (local/store.ts). Only the very portrait that button came with is kept, only while it is held, and only
    // while its person still has the look it shows. Returns where that person is on the sheet, or null for a stale button.
    keepPortrait(userId: string, candidateId: string, state: Library) {
      const held = candidates.get(userId);
      if (!held || held.id !== candidateId || now() - held.at > PORTRAIT_HELD_MS) return null;
      const sheet = state.stories[held.storyId]?.sheet ?? [];
      const index = sheet.findIndex(one => one.name === held.name);
      if (index < 0 || sheet[index].look !== held.look) return null;
      sheet[index].portrait = { file: store.writePortrait(userId, held.bytes), seed: held.seed, look: held.look, clothes: PORTRAIT_CLOTHES,
        style: PORTRAIT_STYLE, graph: graphHash, checkpoint: config.checkpoint, at: now() };
      letGo(userId);
      return { storyId: held.storyId, index };
    },
  };
}
