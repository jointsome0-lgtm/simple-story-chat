// Draws the assembled prompts of local/illustrate-probe.ts on a rented card and prepares blind review bundles.
// It talks to one ComfyUI server through an ssh tunnel on loopback: POST /prompt, then its websocket and a poll of the
// job's /history record until the job is over, then GET /view. Two rules come from docs/illustrations-plan.md and
// AGENTS.md and are not options:
//   - a picture is derived from somebody's scene, so every PNG we keep is rewritten without its text chunks. ComfyUI
//     puts the whole prompt and workflow into tEXt/iTXt/zTXt, and the server's /history keeps every job until it is
//     cleared. What this harness can reach it clears; what it cannot, the file a node writes, is named at `drawOne`:
//     a preview's goes from the card's RAM seconds later (gpu/image-sweeper.py), a saved one stays with the card.
//   - a review bundle never names the checkpoint that drew a picture; the key stays on our side of the bundle.
// The prompts of the frozen synthetic stories are the only input; no reader's story is drawn here. `--references`
// adds reference portraits for a model that keeps a face across frames (Qwen Image 2.1): they are uploaded under
// the hash of their bytes, so no name reaches the card, and they are stripped on the way like every other picture.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { safeErrorDetails } from './model-error.ts';
import { assemblePrompt, matchSheet } from './illustrate.ts';
import type { Case } from './illustrate-probe.ts';
import type { PictureEncoder } from './tokenizer.ts';

// A checkpoint's place in the comparison. The bot logs this role, never the file name (local/model-error.ts).
export type Role = 'primary' | 'alternate';
// An arm of the identity comparison (docs/illustrations-plan.md). A draws a frame from its text alone, as the bot
// does today; B draws it with the portraits of the people bound to it and the same text; C with the same portraits
// and the text of those people without their appearance, each named by the number of their picture instead.
export type Arm = 'A' | 'B' | 'C';
export const ARMS: Arm[] = ['A', 'B', 'C'];
export type Cell = { caseId: string; checkpoint: string; role: Role; seed: number; arm?: Arm };
// Per-device video memory, as the server reports it while the picture is drawn. `usedMiBMax` counts memory torch
// holds but is not using as free, as ComfyUI does; `occupiedMiBMax`, where the server reports torch's own figures,
// is the card as nvidia-smi sees it, and the caching allocator keeps it near the highest the job needed.
export type Vram = { index: number; totalMiB: number; usedMiBMax: number; occupiedMiBMax?: number };
// Where a job's time went, as far as ComfyUI's websocket shows it (`phasesOf`).
export type Phases = { loadMs?: number; encodeMs?: number; sampleMs?: number; decodeMs?: number; otherMs?: number };
export type Picture = Cell & {
  steps: number; sampler: string; scheduler: string; width: number; height: number;
  // How many reference portraits this frame was drawn with, on a run that has them. A count, not a name: which
  // person it was stays on our side of the card, as `who` does in local/illustrate-probe.ts. `referenceSizes` is the
  // size each one reached the encoder at, after the encode node's resize (`referenceGeometry`), in slot order.
  references?: number; referenceSizes?: [number, number][];
  // The seconds the rental asks for: submit to file. `viewMs` is the download through the tunnel, apart from the card.
  totalMs: number; viewMs: number; vram: Vram[]; bytes: number; sha256: string; file: string;
  // `uploadMs`: the portraits this frame was the first to need, sent before the submit and so not in `totalMs`.
  // `cold`: the job loaded its models rather than finding them in the server's cache; `first`: the first picture of
  // its arm in this run directory. A warm picture is neither. `phases` is missing when the socket did not hear the job.
  uploadMs?: number; cold?: boolean; first?: boolean; phases?: Phases;
  // Samples of video memory taken while the job ran, and the system RAM they saw: QwenImage21Cache on `auto` moves
  // what does not fit the card into RAM instead of failing, so a run without an OOM may still have spilled.
  // `offloads` counts the lines of ComfyUI's own log that say a model was loaded or unloaded only in part.
  vramSamples?: number; ramMiB?: { min: number; max: number }; offloads?: number;
  // The prompt this cell was sent, in characters, and in tokens as the graph's text encoder reads it when a
  // tokenizer is at hand (local/tokenizer.ts).
  promptChars?: number; promptTokens?: number; conditioningTokens?: number;
};
// A cell that did not become a picture. The whole cell is on the row, so a later run that draws it can take its
// failure off again; `httpStatus` is the server's own answer, the one thing that tells a refused graph from a
// tunnel that went down (local/model-error.ts whitelists it). `oom` says the card ran out of video memory.
export type Failure = Cell & { code: string; httpStatus?: number; oom?: boolean };
export type BatchIndex = {
  startedAt: string; completedAt?: string; comfy: { steps: number; sampler: string; scheduler: string; cfg: number; width: number; height: number };
  // The graph this run posted, by name and by its own hash. One run has one workflow, so the Qwen comparison is a
  // second run directory; without this row two directories of one comparison differ in nothing a reader can check,
  // and `comfy` above says which settings that graph was actually filled with.
  workflow?: { file: string; sha256: string };
  // What else the pictures depend on: the files the graph loads and the server's own versions and card. A resume
  // under other pins is refused, as one under another graph is. `arms` marks an identity run; `stopped` says the
  // time budget ended it before its last cell.
  pins?: Record<string, string | number>; arms?: Arm[]; stopped?: 'budget';
  pictures: Picture[]; failures: Failure[]; error?: string;
};
export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
// A portrait per person, by story and by the name on that story's character sheet: what `--references` holds. The
// name selects a file here and goes no further, exactly as `who` selects an appearance line in illustrate-probe.ts.
export type References = Record<string, Record<string, string>>;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// Everything an image needs to be decoded, and nothing that carries text. Colour-management chunks (gAMA, sRGB,
// iCCP) go too: a viewer's default is a smaller loss than a chunk nobody audited.
const KEPT_CHUNKS = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];

// Rewrites a PNG with only the chunks above. Chunks are copied byte for byte, so their CRCs stay valid.
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error('not_a_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (end > bytes.length) throw new Error('truncated_png');
    if (KEPT_CHUNKS.includes(type)) kept.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  if (kept.length < 3) throw new Error('not_a_png');
  return Buffer.concat(kept);
}

// A PNG's size, from the header chunk that always comes first.
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) throw new Error('not_a_png');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// The plain workflow the plan asks for: no LoRA, no upscaler, so a weak picture means a weak prompt. It fits an
// all-in-one checkpoint only — `CheckpointLoaderSimple` reads the `checkpoints` folder and must find the
// transformer, the text encoder and the VAE in the one file. A model published as separate files, Krea 2 Turbo
// among them (a transformer, a Qwen3-VL text encoder and a VAE), is loaded by UNETLoader plus CLIPLoader plus
// VAELoader, and that graph comes from the card: pin it in ComfyUI and pass it with --workflow, exported in API
// format. A run has one workflow, so one --checkpoints list cannot mix the two kinds. With --workflow, node 7 is
// that workflow's business, see the note on `PreviewImage` below.
export function defaultWorkflow(): Graph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'checkpoint.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1344, height: 768, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { seed: 0, steps: 8, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple',
      denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    // Not SaveImage. Whatever node writes the file writes ComfyUI's prompt and workflow into its text chunks, and
    // nothing in the HTTP API deletes a file afterwards; SaveImage would leave that copy in the server's permanent
    // output directory. PreviewImage writes the same picture to the temp directory, which gpu/image-serve.sh keeps
    // in RAM and gpu/image-sweeper.py empties once no job record names the file, and /view serves it the same way,
    // from the type the history entry reports.
    '7': { class_type: 'PreviewImage', inputs: { images: ['6', 0] } },
  };
}

// A graph the bot draws a reader's scene with, with every saving node turned into a preview one. Whatever writes
// the file writes ComfyUI's prompt and the whole workflow into its text chunks, and `SaveImage` writes it into the
// server's permanent output directory, which no route of the HTTP API deletes: the card would keep a copy of a
// picture of somebody's scene until the card itself is gone. `PreviewImage` writes the same picture to the temp
// directory, which no route deletes either, but which gpu/image-serve.sh puts on a tmpfs and gpu/image-sweeper.py
// empties a few seconds after `drawOne` has deleted the job record; `/view` serves it from the type the history
// entry reports, so nothing else about the drawing changes. The graphs pinned on a card end in `SaveImage` — that
// is what the batch harness on a rented card wants, and it draws synthetic scenes; the bot draws a reader's, and
// rewrites it.
export function previewOnly(graph: Graph): Graph {
  return Object.fromEntries(Object.entries(graph).map(([id, node]) => [id, node.class_type === 'SaveImage'
    ? { ...node, class_type: 'PreviewImage', inputs: { images: node.inputs.images } } : node]));
}

export type WorkflowValues = {
  checkpoint: string; prompt: string; negative: string; seed: number; steps: number;
  sampler: string; scheduler: string; width: number; height: number; cfg: number;
  // The reference pictures of this frame, as ComfyUI's own input directory names them. Absent on a run without
  // references, which leaves a pinned graph's reference slots exactly as they were pinned.
  references?: string[];
};
// A failure of the graph itself, told apart from a failure of the server or of the picture: it repeats for every
// cell, so `draw` stops the run on it instead of writing `image_failed` once for each.
const workflowError = (code: `workflow_${string}`, message: string) => Object.assign(new Error(message), { code });

// The API format is `{ "<id>": { class_type, inputs } }`. The file ComfyUI's Save menu writes is the UI format
// (`{nodes:[...], links:[...]}`) and would reach `applyToWorkflow` as a TypeError, recorded as a plain
// `image_failed` once a cell with nothing to say it was the export that was wrong. Checked once, before the loop.
export function apiGraph(value: unknown): Graph {
  const nodes = value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [];
  const shaped = (node: unknown) => typeof (node as Graph[string])?.class_type === 'string'
    && typeof (node as Graph[string])?.inputs === 'object' && (node as Graph[string])?.inputs !== null;
  if (!nodes.length || !nodes.every(shaped)) {
    throw workflowError('workflow_not_api_format', '--workflow must be a ComfyUI graph in API format (Workflow > Export (API)), not the file the Save menu writes');
  }
  return value as Graph;
}

const seedKey = (inputs: Record<string, unknown>) => ('seed' in inputs ? 'seed' : 'noise_seed' in inputs ? 'noise_seed' : null);
const samplerOf = (graph: Graph) => Object.entries(graph).find(([, node]) => seedKey(node.inputs) && 'steps' in node.inputs);
// The node an input of the sampler is wired to. The positive text is the one its positive conditioning comes from;
// the negative one, if any, the other; the size belongs to the latent it starts from.
const linkedTo = (graph: Graph, inputs: Record<string, unknown>, key: string) => {
  const link = inputs[key];
  const id = Array.isArray(link) ? String(link[0]) : null;
  return id && graph[id] ? graph[id] : null;
};

// The size a pinned graph was exported at, which is the size it was tested at on the card. `--size` is optional
// because of this: a workflow that already says 1280x720 must not be redrawn at the harness's own default, which
// is a different resolution and a different aspect ratio, without anybody asking for it.
export function latentSizeOf(graph: Graph): { width: number; height: number } | null {
  const sampler = samplerOf(graph);
  const latent = sampler ? linkedTo(graph, sampler[1].inputs, 'latent_image') : null;
  const { width, height } = (latent?.inputs ?? {}) as { width?: unknown; height?: unknown };
  return typeof width === 'number' && typeof height === 'number' ? { width, height } : null;
}

// The rest of what a pinned graph carries, for the same reason and with the same rule: a graph that says 25 euler
// steps is a graph somebody chose 25 euler steps for. `--steps`, `--sampler`, `--scheduler` and `--cfg` override it;
// a graph that pins none of them falls back to the eight-step Krea settings below, which is what it did before.
export const SAMPLER_DEFAULTS = { steps: 8, sampler: 'er_sde', scheduler: 'simple', cfg: 1 };
export function samplerSettingsOf(graph: Graph): { steps?: number; sampler?: string; scheduler?: string; cfg?: number } {
  const inputs = samplerOf(graph)?.[1].inputs ?? {};
  const count = (value: unknown) => typeof value === 'number' ? value : undefined;
  const name = (value: unknown) => typeof value === 'string' ? value : undefined;
  return { steps: count(inputs.steps), sampler: name(inputs.sampler_name), scheduler: name(inputs.scheduler), cfg: count(inputs.cfg) };
}

// The input a conditioning node takes its words in. Krea's `CLIPTextEncode` has one `text` per conditioning;
// Qwen Image 2.1 encodes both in one node, from `prompt` and `negative_prompt`, and hands out two conditionings.
// Which is which still follows from the sampler input the link arrived on, not from the node's type.
const promptKey = (node: Graph[string], role: 'positive' | 'negative') => {
  const own = role === 'positive' ? 'prompt' : 'negative_prompt';
  return own in node.inputs ? own : 'text' in node.inputs ? 'text' : null;
};

// The reference-picture inputs of an edit graph, in slot order. Qwen Image 2.1 takes each reference on its own
// `images.image_N` input of the encode node (ComfyUI's autogrow inputs), and each of those is wired to a LoadImage
// that names a file in the server's input directory, which is what `--references` uploads.
export function referenceSlots(graph: Graph): { node: string; key: string; loader: string }[] {
  const found: { node: string; key: string; order: number; loader: string }[] = [];
  for (const [node, { inputs }] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(inputs)) {
      const slot = /^images\.image_(\d+)$/.exec(key);
      const loader = Array.isArray(value) ? String(value[0]) : null;
      if (slot && loader && graph[loader] && 'image' in graph[loader].inputs) {
        found.push({ node, key, order: Number(slot[1]), loader });
      }
    }
  }
  return found.sort((a, b) => a.order - b.order).map(({ node, key, loader }) => ({ node, key, loader }));
}

// Python's round(), which takes a half to the even neighbour: ComfyUI rounds 720 / 32 = 22.5 to 22, not 23.
const pyRound = (value: number) => {
  const floor = Math.floor(value), rest = value - floor;
  return rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor;
};
// The size Qwen Image 2.1's encode node hands a reference to the text encoder and the VAE at, as the pinned
// revision computes it (comfy_extras/nodes_qwen.py:99-168): about `resolution` squared at the picture's own aspect,
// or at `resolution` 0 the picture's own size, in multiples of 32 either way. The first reference's size is also the
// latent the node hands out, "to match with sampling as any other size shifts the edit": the canvas of every frame
// that has references, and so of the frames compared with them.
export function referenceGeometry(width: number, height: number, resolution: number): [number, number] {
  const ratio = width / height;
  const [w, h] = resolution > 0
    ? [pyRound(Math.sqrt(resolution * resolution * ratio) / 32) * 32, pyRound(Math.sqrt(resolution * resolution / ratio) / 32) * 32]
    : [pyRound(width / 32) * 32, pyRound(height / 32) * 32];
  return [Math.max(32, w), Math.max(32, h)];
}
// The `resolution` input of the node the reference slots belong to, when the graph has such a node.
export function encoderResolution(graph: Graph): number | undefined {
  const node = referenceSlots(graph)[0]?.node;
  const value = node === undefined ? undefined : graph[node].inputs.resolution;
  return typeof value === 'number' ? value : undefined;
}

// The text encoder a graph conditions its picture with, as local/tokenizer.ts counts for it: the type of the
// CLIPLoader behind the node on the sampler's positive input (Qwen Image 2.1's own node, or Krea's CLIPTextEncode).
// A checkpoint's own CLIP, or a loader of any other type, is no encoder that tokenizer knows.
export function textEncoderOf(graph: Graph): PictureEncoder | undefined {
  const sampler = samplerOf(graph);
  const positive = sampler ? linkedTo(graph, sampler[1].inputs, 'positive') : null;
  const loader = positive ? linkedTo(graph, positive.inputs, 'clip') : null;
  const type = loader?.class_type === 'CLIPLoader' ? loader.inputs.type : undefined;
  return type === 'qwen_image' || type === 'krea2' ? type : undefined;
}

// Fills a graph by the role of each node rather than by its id, so a workflow pinned on the card keeps working as
// long as it samples, loads a checkpoint and encodes text. It throws rather than draw with the wrong seed or prompt.
export function applyToWorkflow(graph: Graph, values: WorkflowValues): Graph {
  const filled: Graph = JSON.parse(JSON.stringify(graph));
  const nodes = Object.entries(filled);
  const sampler = samplerOf(filled);
  const loader = nodes.find(([, node]) => 'ckpt_name' in node.inputs || 'unet_name' in node.inputs);
  if (!sampler || !loader) throw workflowError('workflow_no_sampler_or_loader', 'The workflow needs one sampler node and one node that loads the checkpoint');
  const inputs = sampler[1].inputs;
  inputs[seedKey(inputs)!] = values.seed;
  inputs.steps = values.steps;
  if ('sampler_name' in inputs) inputs.sampler_name = values.sampler;
  if ('scheduler' in inputs) inputs.scheduler = values.scheduler;
  if ('cfg' in inputs) inputs.cfg = values.cfg;
  loader[1].inputs['ckpt_name' in loader[1].inputs ? 'ckpt_name' : 'unet_name'] = values.checkpoint;
  const linked = (key: string) => linkedTo(filled, inputs, key);
  const positive = linked('positive');
  const positiveKey = positive && promptKey(positive, 'positive');
  if (!positive || !positiveKey) throw workflowError('workflow_no_positive_prompt', 'The workflow needs a text node on the sampler\'s positive input');
  positive.inputs[positiveKey] = values.prompt;
  const negative = linked('negative');
  const negativeKey = negative && promptKey(negative, 'negative');
  // One *input* wired to both conditionings: writing the negative over it would send the card an empty prompt while
  // the index and the bundle still showed the assembled one. Qwen's single encode node is not that case — its two
  // conditionings come from two inputs — which is why the same node is only skipped when the input is the same too.
  if (negative && negativeKey && !(negative === positive && negativeKey === positiveKey)) {
    negative.inputs[negativeKey] = values.negative;
  }
  // Only the latent the sampler starts from: a pinned workflow's upscale or pad node has a size of its own, and
  // writing the base size into it would quietly undo what it is there for.
  const latent = linked('latent_image');
  if (!latent || !('width' in latent.inputs) || !('height' in latent.inputs)) {
    throw workflowError('workflow_no_latent_size', 'The sampler\'s latent_image must come from a node with a width and a height, or the picture is drawn at one size and recorded at another');
  }
  latent.inputs.width = values.width;
  latent.inputs.height = values.height;
  // The reference portraits of this frame. The first slots take the uploaded names; the rest leave the graph, input
  // and LoadImage together, because a slot left pointing at a file nobody uploaded fails the whole prompt, and a
  // frame with two people in it is not a frame with four. A run without references leaves a graph as it was pinned.
  const references = values.references;
  if (references) {
    const slots = referenceSlots(filled);
    if (references.length > slots.length) {
      throw workflowError('workflow_too_few_reference_slots',
        `The workflow has ${slots.length} reference slots and a frame of this batch needs ${references.length}`);
    }
    slots.forEach((slot, order) => {
      if (order < references.length) filled[slot.loader].inputs.image = references[order];
      else { delete filled[slot.node].inputs[slot.key]; delete filled[slot.loader]; }
    });
  }
  return filled;
}

// `signal` ends the wait from outside: the bot draws while the reader reads, and a reader who sends the next
// message is not waiting for this picture any more (local/picture.ts). The batch harness passes none.
export type Comfy = { baseUrl: string; timeoutMs: number; signal?: AbortSignal };
type HistoryEntry = { status?: { completed?: boolean; status_str?: string; messages?: unknown };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> };
// The same server without the caller's signal: what stops an abandoned job must still reach the card after that
// signal has fired, or the card would go on drawing a picture nobody waits for (`stopJob`).
const afterAbort = (comfy: Comfy): Comfy => ({ baseUrl: comfy.baseUrl, timeoutMs: comfy.timeoutMs });

const call = async (comfy: Comfy, path: string, init?: RequestInit) => {
  const timeout = AbortSignal.timeout(comfy.timeoutMs);
  const response = await fetch(comfy.baseUrl + path, { ...init, signal: comfy.signal ? AbortSignal.any([comfy.signal, timeout]) : timeout });
  if (!response.ok) throw Object.assign(new Error('comfy_http_error'), { code: 'comfy_http_error', httpStatus: response.status });
  return response;
};

// Used video memory per device and used system RAM, if this server reports them. A ComfyUI without the fields is not
// an error: the rental reads the card directly as well (local/gpu-diagnose.ts). ComfyUI counts what torch holds but
// is not using as free (`vram_free` includes `torch_vram_free`, comfy/model_management.py `get_free_memory`), so
// `usedMiBMax` misses what the allocator keeps between allocations; adding it back gives the card as nvidia-smi
// sees it, which stays near the highest the job has needed until the cache is emptied.
type Stats = { vram: Vram[]; ramMiB?: number };
async function readStats(comfy: Comfy): Promise<Stats> {
  try {
    const stats = await (await call(comfy, '/system_stats')).json() as { system?: { ram_total?: unknown; ram_free?: unknown };
      devices?: { index?: number; vram_total?: number; vram_free?: number; torch_vram_free?: unknown }[] };
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const vram = (stats.devices ?? []).flatMap((device, order) => {
      if (typeof device.vram_total !== 'number' || typeof device.vram_free !== 'number') return [];
      const used = device.vram_total - device.vram_free, held = device.torch_vram_free;
      return [{ index: device.index ?? order, totalMiB: mib(device.vram_total), usedMiBMax: mib(used),
        ...(typeof held === 'number' ? { occupiedMiBMax: mib(used + held) } : {}) }];
    });
    const { ram_total: total, ram_free: free } = stats.system ?? {};
    return { vram, ...(typeof total === 'number' && typeof free === 'number' ? { ramMiB: mib(total - free) } : {}) };
  } catch { return { vram: [] }; }
}

const mergeVram = (into: Vram[], seen: Vram[]) => {
  for (const device of seen) {
    const known = into.find(one => one.index === device.index);
    if (!known) into.push({ ...device });
    else {
      known.usedMiBMax = Math.max(known.usedMiBMax, device.usedMiBMax);
      if (device.occupiedMiBMax !== undefined) known.occupiedMiBMax = Math.max(known.occupiedMiBMax ?? 0, device.occupiedMiBMax);
    }
  }
};

// The memory a job was seen with: the video memory above, how many samples it rests on, and the RAM in use.
type Memory = { vram: Vram[]; samples: number; ramMiB?: { min: number; max: number } };
const mergeStats = (into: Memory, seen: Stats) => {
  if (seen.vram.length) into.samples++;
  mergeVram(into.vram, seen.vram);
  if (seen.ramMiB !== undefined) {
    into.ramMiB = { min: Math.min(into.ramMiB?.min ?? seen.ramMiB, seen.ramMiB), max: Math.max(into.ramMiB?.max ?? 0, seen.ramMiB) };
  }
};

const post = (comfy: Comfy, path: string, body?: object) => call(comfy, path, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// What `drawOne` leaves running once it has the picture or has failed: the delete of the job's record and the samples
// of video memory. The picture waits for neither, and nothing of it is dropped either: `settled` waits for all of it.
// The bot waits there once the photo is out (local/picture.ts), so that `idle` and `stop` in local/bot.ts cannot end
// with a delete still on its way; the harness waits before it records a cell, whose video memory it keeps.
const trailing = new Set<Promise<unknown>>();
const leave = (work: Promise<unknown>) => {
  const kept = work.catch(() => undefined);
  trailing.add(kept);
  void kept.finally(() => trailing.delete(kept));
};
export async function settled() { await Promise.all([...trailing]); }

// A reference picture into the server's input directory, where LoadImage reads it by name. The name is the hash of
// the bytes and nothing else: a portrait is a face, and the sheet name it was drawn for must not be written onto
// the rented disk. The bytes are stripped like every other picture here — a portrait comes off this same card and
// carries the prompt that drew it in its text chunks — and the file stays until the card is destroyed.
export async function uploadReference(comfy: Comfy, bytes: Uint8Array): Promise<string> {
  const stripped = stripPngMetadata(bytes);
  const name = `ref-${createHash('sha256').update(stripped).digest('hex').slice(0, 16)}.png`;
  const form = new FormData();
  form.append('image', new Blob([stripped], { type: 'image/png' }), name);
  form.append('overwrite', 'true');
  form.append('type', 'input');
  const answer = await (await call(comfy, '/upload/image', { method: 'POST', body: form }))
    .json() as { name?: string; subfolder?: string };
  if (!answer.name) throw Object.assign(new Error('comfy_upload_failed'), { code: 'comfy_upload_failed' });
  return answer.subfolder ? `${answer.subfolder}/${answer.name}` : answer.name;
}

// The binding plan of a frame: the portraits of its people in the order the prompt names them, each with the sheet
// name it was picked by. `who` is the only described field that carries a name; here it picks a file, the way it
// picks an appearance line in local/illustrate-probe.ts, and goes no further. One plan says both which pictures reach
// the card and whose look arm C may drop (`withoutLooks`), so the two cannot disagree: a person who has a portrait
// file but stands after the binding has stopped is not bound, and keeps their look.
// Slot N is person N of the prompt: the encoder's tokenizer puts its own `<image1> <image2> …` block ahead of the
// prompt, and `assemblePrompt` writes one clause per person in this same order. So the binding stops at the first
// person there is no portrait for — a person the sheet does not cover, or covers without a picture, or one whose
// portrait is already in a slot — rather than skipping them and moving everybody after them up a slot, which would
// put a face against another person's clause. Those later people are drawn from their appearance line alone, which
// is what the whole Krea lane does.
export function bindingPlan(one: Case, references: References): { name: string; file: string }[] {
  const story = references[one.scenario] ?? {};
  const names = (one.sheet ?? []).map(character => character.name);
  const found: { name: string; file: string }[] = [];
  for (const person of one.description?.people ?? []) {
    const matched = matchSheet(person.who ?? '', names);
    const file = matched === null ? undefined : story[matched];
    if (matched === null || !file || found.some(bound => bound.file === file)) break;
    found.push({ name: matched, file });
  }
  return found;
}
export const portraitsFor = (one: Case, references: References): string[] => bindingPlan(one, references).map(bound => bound.file);

// Arm C's prompt: the frame as `assemblePrompt` writes it, with the whole look of each bound person — face, hair,
// build, marks, bearing — replaced by the number of their picture, and everything else kept: clothes, state, action,
// and every person the binding stopped before. The tokenizer names the pictures `<image1>`, `<image2>` ahead of the
// prompt (local/tokenizer.ts `comfyTokens`), so "the person from image 1" points at a picture by the number the
// model sees it under, and no name goes with it.
export function withoutLooks(one: Case, bound: string[]): string {
  const sheet = (one.sheet ?? []).map(character => {
    const slot = bound.indexOf(character.name);
    return slot < 0 ? character : { ...character, look: `The person from image ${slot + 1}` };
  });
  return assemblePrompt(one.description, sheet).prompt;
}

// What the card is drawing now and what waits behind it. A queue entry is an array whose second element is the
// prompt id; a server that answers with anything else, or does not answer at all, is read as an empty queue, and
// then `stopJob` below does the one thing that is safe on an unknown card.
const promptIds = (list: unknown): string[] => (Array.isArray(list) ? list : [])
  .flatMap(one => (Array.isArray(one) && typeof one[1] === 'string' ? [one[1]] : []));
async function readQueue(comfy: Comfy): Promise<{ running: string[]; pending: string[] }> {
  try {
    const seen = await (await call(comfy, '/queue')).json() as { queue_running?: unknown; queue_pending?: unknown };
    return { running: promptIds(seen.queue_running), pending: promptIds(seen.queue_pending) };
  } catch { return { running: [], pending: [] }; }
}

// A picture that outlives the wait is still the card's. ComfyUI runs one job at a time, so the next cell would
// queue behind the abandoned one and inherit its seconds — and the seconds are what the rental is decided on — and
// its history entry, which holds the whole prompt and the workflow, is written when it finishes, which is after the
// delete in `drawOne`'s `finally` has already run. So: out of the queue if it is still waiting, interrupted if it is
// drawing, and then waited for, so that there is a record for the delete to remove.
//
// `/interrupt` carries no id: it stops whatever the card is drawing. With one card and two readers that is somebody
// else's picture as often as ours, and they would get the failure line under a scene they never touched. So the
// queue is read first and the interrupt is sent only while the card says this job is the one it is drawing. A job
// that was still waiting is gone with the delete and will never write a record, so there is nothing to wait for
// either; a card that did not answer the queue is left alone, because a wrong interrupt costs another reader their
// picture and a missed one costs this reader's job a few more seconds of a card we are already paying for.
async function stopJob(comfy: Comfy, promptId: string, pollMs: number) {
  const queue = await readQueue(comfy);
  await post(comfy, '/queue', { delete: [promptId] }).catch(() => undefined);
  if (!queue.running.includes(promptId)) return;
  await call(comfy, '/interrupt', { method: 'POST' }).catch(() => undefined);
  let missing = 0;
  for (let poll = 0; poll < 10; poll++) {
    const seen: Record<string, HistoryEntry> = await call(comfy, `/history/${promptId}`)
      .then(response => response.json() as Promise<Record<string, HistoryEntry>>).catch(() => ({}));
    if (seen[promptId]) return;
    // An interrupted job leaves the queue a moment before its record appears, so one more poll is given to it; a
    // card that then still has neither is writing no record at all, and the rest of the wait would buy nothing.
    const gone = await readQueue(comfy);
    if (![...gone.running, ...gone.pending].includes(promptId) && ++missing > 1) return;
    await delay(pollMs);
  }
}

// One picture: submit, wait until the server has it, download it, forget the job. The elapsed time is measured from
// the submit, which is what the reader waits for; never from a timestamp in the server's own reply. `vram` fills in
// as its samples land, the last of them after the picture: `settled` waits for it.
// A preview node (`previewOnly`) gets a key of its own for every job. ComfyUI answers a graph it has run before from
// its cache, and the cached output names the earlier job's file, which gpu/image-sweeper.py deleted seconds after that
// job: /view answered 404 to the second sample of one style on one scene. The key is part of the node's cache
// signature and of nothing else, since the pinned server hands a node only the inputs it declares: the sampler's result
// still comes from the cache, and only the file is written again.
function freshPreviews(graph: Graph): Graph {
  const nonce = randomUUID();
  return Object.fromEntries(Object.entries(graph).map(([id, node]) =>
    [id, node.class_type === 'PreviewImage' ? { ...node, inputs: { ...node.inputs, nonce } } : node]));
}

// Polls of a job's record that may fail in a row before the picture is given up. The card went on drawing through each:
// the one failure seen, on the first job after a restart, came while the server loaded the model.
const POLL_RETRIES = 3;

// A job as the websocket has told it. ComfyUI sends a client's messages only to a socket that is connected when they
// are sent (server.py:1392), so `started` is what says this socket heard the job from its beginning: one that opened
// later has missed messages, and the `outputs` it heard may not be all of the job's. `cached` is the nodes the server
// answered from its cache (execution.py:770), `ran` each other node with the moment it began (execution.py:496),
// `overAt` the moment the job ended, all on our clock; `oom` says an error was the card running out of memory.
type Told = { started: boolean; succeeded: boolean; over: boolean; outputs: NonNullable<HistoryEntry['outputs']>;
  cached?: string[]; ran: { node: string; at: number }[]; overAt?: number; oom?: boolean };

// Where a job's time went, by the kind of node it was spent in: the time from one node's start to the next one's is
// the first node's. The sampler's share includes moving the model onto the card, which ComfyUI does inside it.
const PHASES: [RegExp, keyof Phases][] = [[/Loader|^LoadImage$/, 'loadMs'], [/TextEncode/, 'encodeMs'], [/Sampler/, 'sampleMs'], [/^VAEDecode/, 'decodeMs']];
export function phasesOf(graph: Graph, ran: { node: string; at: number }[], overAt: number): Phases {
  const phases: Phases = {};
  ran.forEach((step, order) => {
    const key = PHASES.find(([pattern]) => pattern.test(graph[step.node]?.class_type ?? ''))?.[1] ?? 'otherMs';
    phases[key] = (phases[key] ?? 0) + Math.round((ran[order + 1]?.at ?? overAt) - step.at);
  });
  return phases;
}
// An error the card gave because it ran out of memory (comfy/model_management.py `is_oom`). Only this answer is taken
// from the message: the rest of an error carries the node's inputs, which are the prompt.
const outOfMemory = (data: { exception_type?: unknown; exception_message?: unknown }) =>
  /OutOfMemory|out of memory/i.test(`${data.exception_type} ${data.exception_message}`);

// ComfyUI's websocket (`/ws?clientId=`, server.py:269), for one picture: it says when the job is over, so that the
// wait ends then rather than at the next poll. Everything about it is optional. A socket that cannot open, closes early
// or says nothing useful leaves the wait to the polls in `drawOne`, which end it exactly as they did before there was
// a socket. What it carries names the job's file, so none of it is logged, and none of it outlives the job. The line
// numbers here are those of the revision gpu/image-manifest.env pins.
function watchJob(comfy: Comfy) {
  const clientId = randomUUID();
  const jobs = new Map<string, Told>();
  let heard = 0;
  let wake: () => void = () => undefined;
  // `executing` with no node is the one message that means "over": the server sends it once it has written the job's
  // record, whether the job succeeded, failed or was interrupted (main.py:367-374). `execution_success` comes a moment
  // before the record (execution.py:824), so it is noted and the wait goes on until the record is there: a delete
  // sent on it could reach the card first and leave the record behind. An error or an interrupt sends the wait to the
  // record at once, which says what became of the job; an error there need not be the end of it (execution.py:538).
  const notice = () => { heard++; wake(); };
  let socket: WebSocket | undefined;
  try {
    const url = new URL('/ws', comfy.baseUrl);
    url.protocol = 'ws:';
    url.searchParams.set('clientId', clientId);
    socket = new WebSocket(url);
    socket.addEventListener('message', event => {
      let message: { type?: unknown; data?: { prompt_id?: unknown; node?: unknown; output?: unknown; nodes?: unknown;
        exception_type?: unknown; exception_message?: unknown } } | null;
      try { message = typeof event.data === 'string' ? JSON.parse(event.data) : null; } catch { return; }
      const data = message?.data;
      if (!message || !data || typeof data.prompt_id !== 'string') return;
      let job = jobs.get(data.prompt_id);
      if (!job) jobs.set(data.prompt_id, job = { started: false, succeeded: false, over: false, outputs: {}, ran: [] });
      if (message.type === 'execution_start') job.started = true;
      else if (message.type === 'execution_cached' && Array.isArray(data.nodes)) job.cached = data.nodes.map(String);
      else if (message.type === 'executing' && typeof data.node === 'string') job.ran.push({ node: data.node, at: performance.now() });
      else if (message.type === 'executed' && typeof data.node === 'string' && data.output && typeof data.output === 'object') {
        job.outputs[data.node] = data.output as Told['outputs'][string];
      } else if (message.type === 'execution_success') job.succeeded = true;
      else if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
        if (outOfMemory(data)) job.oom = true;
        notice();
      } else if (message.type === 'executing' && data.node === null) { job.over = true; job.overAt = performance.now(); notice(); }
    });
  } catch { socket = undefined; }
  return {
    clientId,
    // How often the socket has had news: `drawOne` compares it across a poll to know whether to wait again.
    get heard() { return heard; },
    // The job's record without a read of it, once the socket has heard the whole job succeed. The record's outputs
    // are the very objects the `executed` messages carried (execution.py:826-834), from a node that ran
    // (execution.py:574-577) and from one the cache answered alike (comfy_execution/asset_enrichment.py:102-115), and
    // a job that succeeded is recorded as completed with `success`. Nothing, whenever the socket cannot vouch for it.
    record(promptId: string): HistoryEntry | undefined {
      const job = jobs.get(promptId);
      return job?.started && job.succeeded && job.over ? { status: { completed: true, status_str: 'success' }, outputs: job.outputs } : undefined;
    },
    // What the socket saw of a whole job: where its time went, and whether it loaded any model rather than finding
    // it in the server's cache. Nothing, when the socket did not hear it from start to end.
    timing(promptId: string, graph: Graph): { phases: Phases; cold?: boolean } | undefined {
      const job = jobs.get(promptId);
      if (!job?.started || job.overAt === undefined) return undefined;
      const loaders = Object.keys(graph).filter(id => /Loader/.test(graph[id].class_type));
      return { phases: phasesOf(graph, job.ran, job.overAt),
        ...(job.cached ? { cold: loaders.some(id => !job.cached!.includes(id)) } : {}) };
    },
    oom: (promptId: string) => jobs.get(promptId)?.oom === true,
    // Until the socket has news, `ms` pass or `signal` fires, whichever comes first.
    wait(ms: number, signal?: AbortSignal) {
      return new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); wake = () => undefined; done(); };
        const timer = setTimeout(finish, ms);
        wake = finish;
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    },
    close() { socket?.close(); },
  };
}
type Watch = ReturnType<typeof watchJob>;

// `sampleEvery` is how many polls pass between two samples of memory: the bot keeps the tunnel quiet, and the harness,
// which measures the card, samples at every poll.
type DrawOneOptions = { pollMs?: number; waitMs?: number; sampleEvery?: number };
export async function drawOne(comfy: Comfy, graph: Graph, options: DrawOneOptions = {}) {
  // Opened before the submit: the card tells a job's news only to a socket that is already there to hear it.
  const watch = watchJob(comfy);
  try { return await drawWatched(comfy, graph, watch, options); }
  finally { watch.close(); }
}

async function drawWatched(comfy: Comfy, graph: Graph, watch: Watch, options: DrawOneOptions) {
  // The socket says when the job is over. The polls are what the picture falls back on when it says nothing, and
  // meanwhile they keep the tunnel's connection open for `/view`, where a new one would cost another ssh channel, about
  // 0.3-0.6 s. Half a second does both, and the retries below still span the seconds they always did.
  const pollMs = options.pollMs ?? 500;
  const started = performance.now();
  // The submit itself is never cut short, however early the caller lets go: a job the card has taken and we have no
  // id for is a job nobody can stop, and it would draw a whole picture for a reader who has already left. It is one
  // request to loopback, and the abort is answered on the next line, with an id in hand. It is not repeated either:
  // a submit that failed may still have reached the card.
  const submitted = await (await call(afterAbort(comfy), '/prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: freshPreviews(graph), client_id: watch.clientId }) })).json() as { prompt_id?: string; error?: unknown };
  const promptId = submitted.prompt_id;
  if (!promptId) throw Object.assign(new Error('comfy_rejected_prompt'), { code: 'comfy_rejected_prompt' });
  const memory: Memory = { vram: [], samples: 0 };
  // Video memory is sampled without waiting for the answer, and one request at a time: a card that stops answering
  // would otherwise gather another hanging request every few polls.
  let sampling = false;
  const sampleVram = () => {
    if (sampling) return;
    sampling = true;
    leave(readStats(comfy).then(seen => mergeStats(memory, seen)).finally(() => { sampling = false; }));
  };
  // The delete of the job's record: sent once, whichever way this ends, and never waited for (`settled`).
  let forgotten = false;
  const forget = () => {
    if (forgotten) return;
    forgotten = true;
    leave(post(afterAbort(comfy), '/history', { delete: [promptId] }));
  };
  try {
    const deadline = started + (options.waitMs ?? 600000);
    let entry: HistoryEntry | undefined;
    let failures = 0;
    for (let poll = 0; ; poll++) {
      // Asked before the poll rather than after it: a caller who has let go is answered without another request,
      // and `stopJob` below takes the card off the job it is drawing.
      if (comfy.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      const heard = watch.heard;
      // A socket that heard the whole job succeed has its record already; the poll is for everything else.
      entry = watch.record(promptId);
      if (entry) break;
      let seen: Record<string, HistoryEntry>;
      try {
        seen = await (await call(comfy, `/history/${promptId}`)).json() as Record<string, HistoryEntry>;
        failures = 0;
      } catch (error) {
        // A poll that did not arrive is asked again; one the server answered with an error status is its answer.
        if (comfy.signal?.aborted || (error as { code?: unknown }).code === 'comfy_http_error' || ++failures > POLL_RETRIES
          || performance.now() > deadline) throw error;
        if (watch.heard === heard) await watch.wait(pollMs, comfy.signal);
        continue;
      }
      entry = seen[promptId];
      if (entry?.status?.completed || entry?.status?.status_str === 'error') break;
      if (performance.now() > deadline) throw Object.assign(new Error('image_timeout'), { code: 'image_timeout' });
      // Video memory is sampled while the card works, not after it has freed the weights.
      if (poll % (options.sampleEvery ?? 4) === 0) sampleVram();
      // News that came while the poll was out is acted on at once. A poll is never cut short for it: an aborted
      // request takes its connection with it, and `/view` would pay for a new one.
      if (watch.heard === heard) await watch.wait(pollMs, comfy.signal);
    }
    const image = Object.values(entry.outputs ?? {}).flatMap(output => output.images ?? [])[0];
    if (!image || entry.status?.status_str === 'error') {
      const recorded = Array.isArray(entry.status?.messages) ? entry.status.messages : [];
      const oom = watch.oom(promptId) || recorded.some(message => Array.isArray(message) && message[0] === 'execution_error' && outOfMemory(message[1] ?? {}));
      throw Object.assign(new Error('image_failed'), { code: 'image_failed', ...(oom ? { oom } : {}) });
    }
    const viewStarted = performance.now();
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
    const bytes = new Uint8Array(await (await call(comfy, `/view?${query}`)).arrayBuffer());
    const viewMs = Math.round(performance.now() - viewStarted);
    // The record goes first, on the connection `/view` has just left open, and the last sample after it.
    forget();
    sampleVram();
    // `memory` fills in like `vram` did, the last sample after the picture; `timing` is the socket's account of the job.
    return { bytes: stripPngMetadata(bytes), totalMs: Math.round(performance.now() - started), viewMs, vram: memory.vram, memory,
      timing: watch.timing(promptId, graph) };
  } catch (error) {
    // The wait ran out or the caller let go, but the card did not stop by itself: see `stopJob`. A fetch cut by the
    // signal arrives as an AbortError, so what the signal says is what this failure is called, whatever was thrown.
    const cancelled = comfy.signal?.aborted === true;
    if (cancelled || (error as { code?: string }).code === 'image_timeout') await stopJob(afterAbort(comfy), promptId, pollMs);
    throw cancelled ? Object.assign(new Error('cancelled'), { code: 'cancelled' }) : error;
  } finally {
    // The server keeps the prompt, the workflow and the outputs of every job it has run until history is cleared.
    // This clears the job record, and that is all the API can clear: the file the node wrote stays in ComfyUI's own
    // directory, with its text chunks, and no route deletes it. Beside a server started by gpu/image-serve.sh,
    // gpu/image-sweeper.py deletes a preview's file from RAM a few seconds after this record is gone, and the file
    // and the record both after ten minutes should this delete never arrive. A saving node's file stays until the
    // card goes, which is why the harness, whose graphs save, draws only synthetic scenes. The picture on our disk
    // is stripped. The delete leaves here on every way out, and nothing waits for its answer but `settled`.
    forget();
  }
}

export type DrawOptions = {
  prompts: string; out: string; comfy: string; checkpoints: string[]; seeds: number[];
  // Without a size, or without sampler settings, the graph's own are drawn and recorded: a workflow pinned on the
  // card carries the resolution and the steps it was tested at, and the harness's defaults are not those.
  steps?: number; sampler?: string; scheduler?: string; cfg?: number; width?: number; height?: number;
  // `timeoutMs` is one HTTP request's own timeout; `waitMs` is how long a picture may take, which is a different
  // number by two orders of magnitude and used to be the same one.
  negative: string; minutes: number; timeoutMs: number; waitMs: number; pollMs?: number; workflow?: string;
  // The portraits file of the identity run, read for the paths it names; see `portraitsFor`.
  references?: string; log?: (event: object) => void;
  // An identity run (docs/illustrations-plan.md): every cell once per arm, all on the canvas the portraits set, and
  // a failed cell left as it failed. `only` draws these cases of prompts.json and no others (the smoke); `pins` joins
  // the index; `tokens` counts a prompt as the graph's encoder reads it, with this many pictures ahead of it.
  arms?: Arm[]; only?: string[]; pins?: Record<string, string | number>;
  tokens?: (prompt: string, images: number) => { prompt: number; conditioning: number } | undefined;
};

// A checkpoint name and a case id both become one path component and nothing else: they name a file on our disk, and
// the checkpoint name arrives from the command line, the case id from a JSON file. The extension stays part of the
// name: fp8 and GGUF builds of one checkpoint are published under the same stem, and dropping it made two of them
// share a path (below, `fileOf`, where a shared path would be read as "already drawn").
const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
const fileOf = (cell: Cell) => join('pictures', safeName(cell.checkpoint), `${safeName(cell.caseId)}-s${cell.seed}${cell.arm ? `-${cell.arm}` : ''}.png`);

// Seeds as the command line writes them. An empty part is dropped rather than read as seed 0: `Number('')` is 0, so
// one trailing comma would add a whole extra pass over every case, paid for in rented card time.
export function parseSeeds(value: string): number[] {
  const seeds = value.split(',').map(part => part.trim()).filter(Boolean).map(Number);
  return seeds.every(seed => Number.isInteger(seed) && seed >= 0) && seeds.length ? seeds : [];
}

// One cell of the comparison: this scene, drawn by this checkpoint from this seed, in this arm when the run has arms.
// The role is not part of it — it follows from the checkpoint's place in the list.
const isCell = (one: Cell, other: Cell) => one.caseId === other.caseId && one.checkpoint === other.checkpoint
  && one.seed === other.seed && one.arm === other.arm;

// Codes that say the graph or the server is wrong rather than this picture: every cell after them fails in the same
// way, and on a rental each of those failures is paid for.
const stopsTheRun = (code: string) => code === 'comfy_http_error' || code === 'comfy_rejected_prompt'
  || code === 'comfy_upload_failed' || code.startsWith('workflow_');

// Checkpoint-major order: a switch reloads the whole checkpoint, and an early stop then leaves whole comparable
// blocks rather than a little of each. The arms of one frame follow each other, so a stop leaves whole triples, and
// whatever drifts on the card over an hour drifts under all three alike.
export function cells(cases: Case[], checkpoints: string[], seeds: number[], arms?: Arm[]): Cell[] {
  return checkpoints.flatMap((checkpoint, order) => seeds.flatMap(seed => cases.flatMap(one => {
    const cell = { caseId: one.id, checkpoint, role: (order === 0 ? 'primary' : 'alternate') as Role, seed };
    return arms ? arms.map(arm => ({ ...cell, arm })) : [cell];
  })));
}

// ComfyUI's own log, the last 300 lines of it (/internal/logs/raw, app/logger.py): the one place that says a model
// was loaded onto the card only in part, which is how the server fits what does not fit instead of failing. Only
// those lines are counted, and none is kept: the rest of the log can carry a prompt.
async function logLines(comfy: Comfy): Promise<string[] | undefined> {
  try {
    const seen = await (await call(comfy, '/internal/logs/raw')).json() as { entries?: { t?: unknown; m?: unknown }[] };
    return Array.isArray(seen.entries) ? seen.entries.map(entry => `${entry.t}\u0000${entry.m}`) : undefined;
  } catch { return undefined; }
}
// The partial loads after the last line seen before the job, or in the whole ring when that line has left it.
function offloadsSince(before: string[] | undefined, after: string[] | undefined): number | undefined {
  if (!before || !after) return undefined;
  const last = before.at(-1);
  return after.slice(last === undefined ? 0 : after.lastIndexOf(last) + 1)
    .filter(line => /loaded partially|Unloaded partially/.test(line)).length;
}

// What the server says it is, read once at the start of a run: its version, torch's, and the card's name.
async function serverPins(comfy: Comfy): Promise<Record<string, string>> {
  try {
    const stats = await (await call(comfy, '/system_stats')).json() as {
      system?: { comfyui_version?: unknown; pytorch_version?: unknown }; devices?: { name?: unknown }[] };
    const pins: Record<string, string> = {};
    const keep = (key: string, value: unknown) => { if (typeof value === 'string' && value) pins[key] = value.slice(0, 120); };
    keep('comfyui', stats.system?.comfyui_version);
    keep('pytorch', stats.system?.pytorch_version);
    keep('card', stats.devices?.[0]?.name);
    return pins;
  } catch { return {}; }
}

export async function draw(options: DrawOptions): Promise<BatchIndex> {
  const log = options.log ?? (() => undefined);
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs };
  const cases: Case[] = JSON.parse(readFileSync(join(resolve(options.prompts), 'prompts.json'), 'utf8'));
  if (!cases.length) throw new Error('No assembled prompts to draw');
  const directory = resolve(options.out);
  mkdirSync(join(directory, 'pictures'), { recursive: true, mode: 0o700 });
  // The bundles are built from this copy, so a review directory needs nothing but the run directory.
  copyFileSync(join(resolve(options.prompts), 'prompts.json'), join(directory, 'prompts.json'));
  const graph = apiGraph(options.workflow ? JSON.parse(readFileSync(resolve(options.workflow), 'utf8')) : defaultWorkflow());
  // The size of the run: what `--size` asked for, or what the graph itself says. A workflow pinned on the card was
  // exported at a resolution somebody chose for this checkpoint, and drawing it at the harness's default instead
  // would change the picture and the seconds it takes while the index still called it that workflow's run.
  const pinned = latentSizeOf(graph);
  let width = options.width ?? pinned?.width, height = options.height ?? pinned?.height;
  if (width === undefined || height === undefined) {
    throw workflowError('workflow_no_latent_size', 'The sampler\'s latent_image must come from a node with a width and a height, or give --size');
  }
  // The same rule for the sampler: the flag, then the graph, then the harness's own eight-step settings.
  const settings = samplerSettingsOf(graph);
  const steps = options.steps ?? settings.steps ?? SAMPLER_DEFAULTS.steps;
  const sampler = options.sampler ?? settings.sampler ?? SAMPLER_DEFAULTS.sampler;
  const scheduler = options.scheduler ?? settings.scheduler ?? SAMPLER_DEFAULTS.scheduler;
  const cfg = options.cfg ?? settings.cfg ?? SAMPLER_DEFAULTS.cfg;
  const workflow = { file: options.workflow ? basename(resolve(options.workflow)) : '(built-in)',
    sha256: createHash('sha256').update(JSON.stringify(graph)).digest('hex') };
  // The portraits, read where the file that names them is, so that the file and the pictures move together.
  const referenceRoot = options.references ? dirname(resolve(options.references)) : '';
  const references: References | null = options.references
    ? JSON.parse(readFileSync(resolve(options.references), 'utf8')) : null;
  const uploaded = new Map<string, string>();
  // Every portrait the references file names is checked here rather than at the cell that wanted it: a path that is
  // wrong is wrong for the whole run, and a missing file inside the loop is an unreadable `image_failed` per cell.
  // The story is named because it is a synthetic scenario; the person is not, because the person is a name. Each one
  // is measured as the encode node will resize it, and the index records that size with every frame it goes into.
  const resolution = encoderResolution(graph);
  const sizes = new Map<string, [number, number]>();
  const stories = new Set(cases.map(one => one.scenario));
  const canvases = new Set<string>();
  for (const [story, people] of Object.entries(references ?? {})) {
    for (const portrait of Object.values(people ?? {})) {
      if (typeof portrait !== 'string' || !existsSync(resolve(referenceRoot, portrait))) {
        throw new Error(`The references file names a portrait for a person of "${story}" that is not a file beside it`);
      }
      if (resolution === undefined) continue;
      const size = pngSize(readFileSync(resolve(referenceRoot, portrait)));
      sizes.set(portrait, referenceGeometry(size.width, size.height, resolution));
      if (stories.has(story)) canvases.add(sizes.get(portrait)!.join('x'));
    }
  }
  const arms = options.arms;
  if (arms) {
    // The arms differ in the portraits and in the looks and in nothing else, so all three are drawn on the canvas the
    // portraits set: any of them can be image 1 of some frame, and the canvas has to be that picture's size. Portraits
    // of two sizes are two canvases and so two runs; smaller portraits are a run of their own, with its own arm A.
    if (canvases.size !== 1) {
      throw new Error(canvases.size ? `The portraits reach the encoder at ${[...canvases].join(' and ')}; one run has one canvas`
        : 'An identity run needs --references with the portraits of these frames, and a graph whose encode node takes them');
    }
    const [canvas] = [...canvases];
    [width, height] = canvas!.split('x').map(Number) as [number, number];
    if ((options.width !== undefined && options.width !== width) || (options.height !== undefined && options.height !== height)) {
      throw new Error(`--size asks for another canvas than the portraits set (${canvas}), and any other size shifts the edit`);
    }
    // Arm C has to differ from B by the looks alone, which holds only for a prompt the assembly wrote.
    const edited = cases.find(one => assemblePrompt(one.description, one.sheet).prompt !== one.prompt);
    if (edited) throw new Error(`The prompt of ${edited.id} is not the one assemblePrompt writes; arm C would differ from B in more than the looks`);
  }
  const pins = { ...options.pins, ...await serverPins(comfy) };
  const indexPath = join(directory, 'index.json');
  const index: BatchIndex = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8'))
    : { startedAt: new Date().toISOString(), comfy: { steps, sampler, scheduler, cfg, width, height }, workflow,
      ...(arms ? { arms } : {}), pictures: [], failures: [] };
  // A resume into a directory drawn by another graph would leave half a comparison under one name. The graph's own
  // hash is what says so: the file can be renamed, and the same name can hold a different graph tomorrow. The canvas,
  // the arms and the pins are held to the same rule, since pictures of two canvases are no comparison at all.
  if (index.workflow && index.workflow.sha256 !== workflow.sha256) {
    throw new Error(`${indexPath} was drawn with another workflow (${index.workflow.file}); one run directory holds one graph`);
  }
  if (index.comfy.width !== width || index.comfy.height !== height) {
    throw new Error(`${indexPath} was drawn at ${index.comfy.width}x${index.comfy.height}; one run directory holds one canvas`);
  }
  if (String(index.arms ?? '') !== String(arms ?? '')) throw new Error(`${indexPath} was drawn with other arms; one run directory holds one set`);
  const changed = Object.keys(pins).find(key => index.pins?.[key] !== undefined && index.pins[key] !== pins[key]);
  if (changed) throw new Error(`${indexPath} was drawn under another ${changed}; one run directory holds one set of pins`);
  index.workflow = workflow;
  if (Object.keys(pins).length) index.pins = { ...index.pins, ...pins };
  const save = () => writeFileSync(indexPath, JSON.stringify(index, null, 2));
  const deadline = performance.now() + options.minutes * 60000;

  // Two cells that would write one file are a comparison of a checkpoint with itself: the second is read as already
  // drawn, skipped, and recorded nowhere. A scene named twice in prompts.json, repeated checkpoints or seeds, and
  // names that collide once `safeName` has folded or truncated them all land here — before anything is drawn, not
  // after the card has been paid for — and the file is named, because the cause is not always the obvious one.
  const unknown = options.only?.find(id => !cases.some(one => one.id === id));
  if (unknown) throw new Error(`No case ${unknown} in prompts.json`);
  const plan = cells(options.only ? cases.filter(one => options.only!.includes(one.id)) : cases, options.checkpoints, options.seeds, arms);
  const paths = plan.map(fileOf);
  const shared = paths.find((path, order) => paths.indexOf(path) !== order);
  if (shared) throw new Error(`Two cells would write ${shared}: a scene is in prompts.json twice, or a checkpoint or seed is repeated`);

  for (const cell of plan) {
    const file = fileOf(cell);
    // Resumable: a cell already drawn into this directory is left alone, so a lost session restarts where it stopped.
    if (index.pictures.some(picture => picture.file === file) && existsSync(join(directory, file))) continue;
    // In an identity run a cell's failure is its result, an OOM above all, and drawing it again until it comes out
    // would be choosing the picture. What stopped the whole run was the server or the graph, not the cell: that resumes.
    if (arms && index.failures.some(failure => isCell(failure, cell) && !stopsTheRun(failure.code))) continue;
    if (performance.now() > deadline) { index.stopped = 'budget'; log({ event: 'budget_spent', drawn: index.pictures.length }); break; }
    const one = cases.find(entry => entry.id === cell.caseId)!;
    try {
      // One upload per portrait, not per cell: the same face comes back in every frame of its story, and the card
      // is billed by the minute. A cell whose people have no portraits is drawn without any, from the prompt alone,
      // and so is every cell of arm A. An upload's seconds belong to the frame that needed the portrait first.
      const sent = references && cell.arm !== 'A' ? bindingPlan(one, references) : [];
      let bound: string[] | undefined;
      let uploadMs = 0;
      if (references) {
        bound = [];
        for (const { file: portrait } of sent) {
          let name = uploaded.get(portrait);
          if (name === undefined) {
            const began = performance.now();
            name = await uploadReference(comfy, readFileSync(resolve(referenceRoot, portrait)));
            uploadMs += performance.now() - began;
            uploaded.set(portrait, name);
            log({ event: 'reference_uploaded', uploaded: uploaded.size });
          }
          bound.push(name);
        }
      }
      const prompt = cell.arm === 'C' ? withoutLooks(one, sent.map(person => person.name)) : one.prompt;
      const filled = applyToWorkflow(graph, { checkpoint: cell.checkpoint, prompt, negative: options.negative,
        seed: cell.seed, steps, sampler, scheduler, width, height, cfg, references: bound });
      const first = !index.pictures.some(picture => picture.arm === cell.arm);
      const before = await logLines(comfy);
      const drawn = await drawOne(comfy, filled, { pollMs: options.pollMs, waitMs: options.waitMs, sampleEvery: 1 });
      // The last sample of video memory lands after the picture does, and this cell's row records it.
      await settled();
      const offloads = offloadsSince(before, await logLines(comfy));
      const counted = options.tokens?.(prompt, sent.length);
      mkdirSync(join(directory, 'pictures', safeName(cell.checkpoint)), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, file), drawn.bytes, { mode: 0o600 });
      const picture: Picture = { ...cell, steps, sampler, scheduler,
        ...(bound === undefined ? {} : { references: bound.length, referenceSizes: sent.flatMap(person => sizes.has(person.file) ? [sizes.get(person.file)!] : []) }),
        width, height, totalMs: drawn.totalMs, viewMs: drawn.viewMs, vram: drawn.vram,
        bytes: drawn.bytes.length, sha256: createHash('sha256').update(drawn.bytes).digest('hex'), file,
        ...(uploadMs ? { uploadMs: Math.round(uploadMs) } : {}), first, ...drawn.timing, vramSamples: drawn.memory.samples,
        ...(drawn.memory.ramMiB ? { ramMiB: drawn.memory.ramMiB } : {}), ...(offloads === undefined ? {} : { offloads }),
        promptChars: prompt.length, ...(counted ? { promptTokens: counted.prompt, conditioningTokens: counted.conditioning } : {}) };
      // The index records cells, not attempts: this cell's earlier failure is off the list now that it has its
      // picture, and a cell drawn again (its file lost, say) replaces its own row instead of being dealt twice.
      index.failures = index.failures.filter(failure => !isCell(failure, cell));
      index.pictures = index.pictures.filter(earlier => earlier.file !== file);
      index.pictures.push(picture);
      save();
      log({ event: 'picture_drawn', caseId: cell.caseId, role: cell.role, arm: cell.arm, totalMs: picture.totalMs, viewMs: picture.viewMs,
        references: picture.references, vramUsedMiBMax: Math.max(0, ...drawn.vram.map(device => device.usedMiBMax)) });
    } catch (error) {
      const raw = String((error as { code?: string }).code ?? '');
      const code = /^[a-z_]{1,50}$/.test(raw) ? raw : 'image_failed';
      const { httpStatus } = safeErrorDetails(error);
      const oom = (error as { oom?: unknown }).oom === true;
      index.failures = index.failures.filter(failure => !isCell(failure, cell));
      index.failures.push({ ...cell, code, ...(httpStatus === undefined ? {} : { httpStatus }), ...(oom ? { oom } : {}) });
      save();
      log({ event: 'picture_failed', caseId: cell.caseId, role: cell.role, arm: cell.arm, code, httpStatus, oom });
      // The graph or the server, not this picture: every cell after it fails the same way, and the rental pays for
      // each. The run stops and says why; what is drawn stays, and a rerun into the same directory resumes.
      if (stopsTheRun(code)) { index.error = code; log({ event: 'batch_stopped', code, httpStatus }); break; }
    }
  }
  // A failed cell's delete may still be on its way, and the run is not over before the card has had it.
  await settled();
  index.completedAt = new Date().toISOString();
  save();
  return index;
}

// One judging session's material. The picture names carry nothing: which checkpoint drew which is in the key file,
// which stays outside the bundle.
export type Bundle = { name: string; pictures: { picture: string; source: Picture }[] };

// Pictures are ordered by their own hash, so neither the drawing order nor the checkpoint shows in the naming, and
// then dealt round robin, so every session sees a mix of checkpoints. The same index always gives the same bundles.
export function bundlesOf(pictures: Picture[], count: number): Bundle[] {
  const ordered = [...pictures].sort((a, b) => a.sha256.localeCompare(b.sha256));
  const bundles: Bundle[] = Array.from({ length: count }, (unused, order) => ({ name: `bundle-${order + 1}`, pictures: [] }));
  ordered.forEach((picture, order) => bundles[order % count].pictures.push({ picture: '', source: picture }));
  for (const bundle of bundles) {
    bundle.pictures.forEach((entry, order) => { entry.picture = `pic-${String(order + 1).padStart(2, '0')}.png`; });
  }
  return bundles.filter(bundle => bundle.pictures.length);
}

// Modelled on the task the fifth reading session was given (docs/illustrations-plan.md, step 6), widened from three
// pictures to a bundle: the question is a rate of rejection, and contradiction is counted apart from omission.
// Question 5 asks about the style and about the people apart, and about a face and a figure apart: an even style
// hides changing faces, and a face kept on a body that lost its build is not a person kept. An identity bundle
// (local/image-identity.ts) shows each frame's text with the looks in it, whichever arm drew the picture, and adds
// the sheet of checks the gates are counted from.
export function taskMarkdown(count: number, identity = false): string {
  const text = identity ? 'frame_text' : 'prompt_sent';
  const material = identity
    ? `- \`cases.json\`: для каждой картинки русский текст сцены (\`scene_text_ru\`), \`character_sheet\`, структурное описание и \`frame_text\` — текст кадра со строками внешности из листа. Модель картинок получила либо его, либо его вариант, где внешность части людей заменена их портретом, то есть картинкой того же человека; какой вариант у какой картинки, тебе не сообщают. Судишь всегда против \`frame_text\`;
- \`checks.json\`: лист проверок, о нём в конце.`
    : `- \`cases.json\`: для каждой картинки русский текст сцены (\`scene_text_ru\`), \`character_sheet\`, структурное описание и \`prompt_sent\` — ровно тот текст, который получила модель картинок.`;
  const checks = identity ? `
Лист проверок. У каждой проверки в \`checks.json\` есть \`id\`, \`kind\`, картинки и пункты \`items\`. На каждый пункт ответь \`yes\`, \`no\` или \`unsure\`. \`unsure\` засчитывается против картинки, поэтому ставь его только там, где решить правда нельзя.
- \`transition\`: персонаж \`person\` на картинке \`from\` и на следующей картинке, где он есть, \`to\`. \`face\` — то же лицо: черты, волосы, приметы на лице. \`figure\` — та же фигура, и она совпадает со строкой внешности: телосложение, рост рядом с другими, силуэт, постоянные приметы. Лицо сохранилось, а фигура нет — это \`face: yes\`, \`figure: no\`.
- \`picture\`: одна картинка. \`action\` — каждый человек делает то, что сказано в \`frame_text\`, там, где сказано, и никто не пропал и не добавлен. \`apart\` — ни у кого нет лица или фигуры другого человека из листа. \`swap\` — никто не получил вместе и внешность, и одежду другого человека из листа.
- \`clothes\`: персонаж \`person\` на картинке \`picture\` одет так, как сказано о нём в \`frame_text\`.
- \`style\`: во всех картинках один стиль.

Последним в отчёте дай ответы одним блоком JSON, на все проверки и на все их пункты:
\`\`\`json
{"answers": {"t01": {"face": "yes", "figure": "no"}, "p01": {"action": "yes", "apart": "yes", "swap": "yes"}}}
\`\`\`
` : '';
  return `Ты оцениваешь сгенерированные иллюстрации, их здесь ${count}. Весь материал здесь синтетический, читай и смотри его свободно. Песочница только для чтения: ничего не записывай. Весь отчёт дай последним сообщением, по-русски. Первой строкой отчёта — точное название модели, которой ты работаешь.

Контекст. Телеграм-бот пишет ветвящиеся истории по-русски. После того как сцена написана, второй вызов модели описывает по-английски один кадр этой сцены отдельными полями, а программа собирает из них запрос к модели картинок: план, место, момент, каждый человек (постоянная строка внешности из листа персонажей истории, затем состояние, затем действие), предметы, свет, одно предложение о стиле. Инструкция запрещает имена во всех полях, и программа вырезает из запроса те имена, которые знает по листу персонажей истории; человек, названный только в одной сцене, на лист не попадает, и вырезать его имя нечем. Про модель картинок известно, что она рисует, кто в кадре, где, в какой позе и с чем в руках, и не справляется с точными контактами, с тем, чья это рука, и с содержимым экранов. Поэтому описывающий вызов выбирает кадр, который на это не опирается: люди и место сразу до или сразу после действия, не больше четырёх человек, позы на уровне тела. Читатель получает сначала текст сцены, а под ним картинку. Вопрос в том, годятся ли такие картинки как иллюстрации.

Материал в этом каталоге:
- PNG-файлы с нейтральными именами \`pic-NN.png\`, числом ${count}; какой моделью нарисован каждый, тебе не сообщают, и угадывать это по картинке не надо;
${material}

По каждой картинке отдельно:
1. Против \`${text}\`: каждый названный элемент и каждое отношение — выполнено / не выполнено, несколько слов там, где не выполнено. Итоги числами. Если в \`${text}\` осталось имя человека — назови его: это ошибка сборки запроса, а не модели картинок.
2. Против текста сцены: противоречит ли что-нибудь на картинке сцене (не та сторона травмы, открытая дверь там, где её держат закрытой, не то число щитов, человек делает чужое действие, не то место)? Пропуск — не противоречие: перечисли пропуски отдельно и скажи, важен ли каждый для читателя. Для каждого противоречия: вина описания или вина модели картинок.
3. Дефекты изображения: руки, лица, лишние конечности, анатомия, перспектива, слипшиеся предметы, случайный текст.
4. Хорошо ли описание выбрало кадр? Узнаётся ли момент как именно эта сцена, а не любая сцена этой истории? Если в тексте сцены есть кадр лучше и его можно нарисовать, назови его.

По всем вместе:
5. Стиль и люди — отдельными ответами: ровный стиль ещё не значит, что лица те же.
   а) Стиль: держится ли один стиль во всех картинках? Назови картинки, где он ломается.
   б) Люди: там, где несколько картинок делят персонажа с одинаковой строкой внешности, узнаётся ли он как тот же человек — отдельно по лицу и отдельно по фигуре (телосложение, рост рядом с другими, силуэт, постоянные приметы)? Лицо на месте, а телосложение потеряно — это провал фигуры, а не успех. Не перепутаны ли люди между собой, особенно похожие друг на друга?
6. Что ты изменил бы в инструкции описывающей модели или в сборке запроса. Точные формулировки.
7. По одной строке на картинку: принял бы читатель, только что прочитавший эту сцену, картинку под ней как иллюстрацию? да / с оговорками / нет, и одна главная причина.

Будь конкретен и критичен, ничьи чувства от этого не зависят. Не смягчай находки и не выдумывай дефектов, на которые не можешь показать.
${checks}`;
}

// Writes the bundles and their keys. The bundles go under `review/`, which holds nothing else: a session handed one
// bundle is blind, and so is a session handed the whole of `review/` by a hand that mounted one directory too high.
// The run directory itself is not blind — `pictures/` is named by checkpoint and `keys/` is the answer sheet — and
// it stays on our side. An identity run is bundled by local/image-identity.ts: here its three arms of one frame would
// be dealt as one picture drawn three times, and `prompt_sent` would show arm C's text to the judge.
export const REVIEW = 'review';
export function buildBundles(directory: string, count: number, log: (event: object) => void = () => undefined) {
  const root = resolve(directory);
  const index: BatchIndex = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  if (index.arms) throw new Error('This is an identity run; bundle it with npm run image:identity -- bundles');
  const cases: Case[] = JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8'));
  const bundles = bundlesOf(index.pictures, count);
  mkdirSync(join(root, 'keys'), { recursive: true, mode: 0o700 });
  for (const bundle of bundles) {
    const folder = join(root, REVIEW, bundle.name);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const material = bundle.pictures.map(entry => {
      const one = cases.find(candidate => candidate.id === entry.source.caseId)!;
      copyFileSync(join(root, entry.source.file), join(folder, entry.picture));
      return { picture: entry.picture, scene_text_ru: one.scene, character_sheet: one.sheet, description: one.description, prompt_sent: one.prompt };
    });
    writeFileSync(join(folder, 'cases.json'), JSON.stringify(material, null, 2), { mode: 0o600 });
    writeFileSync(join(folder, 'TASK.md'), taskMarkdown(material.length), { mode: 0o600 });
    writeFileSync(join(root, 'keys', `${bundle.name}.json`), JSON.stringify(bundle.pictures.map(entry => ({
      picture: entry.picture, caseId: entry.source.caseId, checkpoint: entry.source.checkpoint, role: entry.source.role,
      seed: entry.source.seed, file: entry.source.file, sha256: entry.source.sha256 })), null, 2), { mode: 0o600 });
    log({ event: 'bundle_written', bundle: bundle.name, pictures: material.length });
  }
  return bundles;
}

// The server is reached through an ssh tunnel; it is never published, so only a loopback root is accepted.
export function comfyUrl(value: string): string {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set --comfy to the tunnelled ComfyUI root, such as http://127.0.0.1:8188'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search || url.username) {
    throw new Error('--comfy must be a loopback HTTP root: the ComfyUI server is tunnelled, not published');
  }
  return url.origin;
}

const report = (value: object) => console.log(JSON.stringify(value)); // counts, ids and codes only, never a prompt

async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    prompts: { type: 'string' }, out: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    checkpoints: { type: 'string' }, seeds: { type: 'string', default: '7' }, steps: { type: 'string' },
    sampler: { type: 'string' }, scheduler: { type: 'string' },
    cfg: { type: 'string' }, size: { type: 'string' }, negative: { type: 'string', default: '' },
    minutes: { type: 'string', default: '30' }, timeout: { type: 'string', default: '60' }, wait: { type: 'string', default: '300' },
    workflow: { type: 'string' }, references: { type: 'string' }, bundles: { type: 'string', default: '3' },
  } });
  const command = positionals[0] ?? 'draw';
  // A picture is the reader's scene in another form, so both defaults sit under the directory .gitignore keeps for
  // story data, and they chain: local/illustrate-probe.ts writes illustrations/prompts, this reads it.
  const root = resolve(import.meta.dirname, '..');
  const directory = values.out ? resolve(values.out) : join(root, 'illustrations', 'pictures');
  const prompts = values.prompts ? resolve(values.prompts) : join(root, 'illustrations', 'prompts');
  const bundles = Number(values.bundles);
  if (!['draw', 'bundles'].includes(command) || !Number.isInteger(bundles) || bundles < 1 || bundles > 12) {
    throw new Error('Use: draw --checkpoints a.safetensors,b.safetensors [--prompts directory] [--out directory] [--seeds 7] [--steps 8] [--sampler er_sde] [--scheduler simple] [--size 1280x720] [--cfg 1] [--minutes 30] [--wait 300] [--timeout 60] [--workflow file.json] [--references portraits.json] [--comfy http://127.0.0.1:8188]; or: bundles [--out directory] [--bundles 3]. --wait is the seconds one picture may take and --timeout the seconds one HTTP request may take. Without --size, --steps, --sampler, --scheduler or --cfg the workflow is drawn with its own. The built-in workflow fits an all-in-one checkpoint; a model in separate files (Krea 2 Turbo: transformer, text encoder, VAE) needs --workflow, pinned on the card and exported in API format. --references binds a portrait per person to the reference slots of an edit workflow (gpu/image-workflow-qwen-edit.json); local/image-portraits.ts writes both the portrait prompts and that file.');
  }
  if (command === 'bundles') { buildBundles(directory, bundles, report); return; }
  // No --size means the workflow's own size, so nothing is validated and nothing is passed on: `draw` reads it from
  // the graph. A size that is given is still checked here, before the run opens a directory on the rented card. The
  // sampler settings work the same way, which is why each of them is checked only when it was given.
  const [width, height] = values.size === undefined ? [undefined, undefined] : values.size.split('x').map(Number);
  const seeds = parseSeeds(values.seeds ?? '');
  const checkpoints = (values.checkpoints ?? '').split(',').map(name => name.trim()).filter(Boolean);
  const given = (value: string | undefined) => value === undefined ? undefined : Number(value);
  const numbers = { steps: given(values.steps), cfg: given(values.cfg), minutes: Number(values.minutes),
    timeout: Number(values.timeout), wait: Number(values.wait) };
  const named = (value: string | undefined) => value === undefined || /^[a-z0-9_]{1,40}$/.test(value);
  if (!checkpoints.length || checkpoints.length > 6
    || !seeds.every(seed => seed <= Number.MAX_SAFE_INTEGER) || !seeds.length
    || (values.size !== undefined && ![width, height].every(size => Number.isInteger(size) && size! >= 256 && size! <= 4096))
    || (numbers.steps !== undefined && (!Number.isInteger(numbers.steps) || numbers.steps < 1 || numbers.steps > 100))
    || (numbers.cfg !== undefined && (!Number.isFinite(numbers.cfg) || numbers.cfg < 0 || numbers.cfg > 30))
    || !Number.isInteger(numbers.minutes) || numbers.minutes < 1 || numbers.minutes > 240
    || !Number.isInteger(numbers.timeout) || numbers.timeout < 10 || numbers.timeout > 1800
    || !Number.isInteger(numbers.wait) || numbers.wait < 10 || numbers.wait > 3600
    || !named(values.sampler) || !named(values.scheduler)) {
    throw new Error('Invalid batch options');
  }
  const index = await draw({ prompts, out: directory, comfy: comfyUrl(values.comfy!),
    checkpoints, seeds, steps: numbers.steps, sampler: values.sampler, scheduler: values.scheduler, cfg: numbers.cfg,
    width, height, negative: values.negative ?? '', minutes: numbers.minutes, timeoutMs: numbers.timeout * 1000,
    waitMs: numbers.wait * 1000, workflow: values.workflow, references: values.references, log: report });
  report({ event: 'batch_written', directory, drawn: index.pictures.length, failed: index.failures.length });
  if (index.failures.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
