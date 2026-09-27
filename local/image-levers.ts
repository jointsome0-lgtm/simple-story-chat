// The throughput measurement (docs/action-experiment.md#levers): what one change of the picture server at a time buys in
// pictures per card-hour on the base pipeline, Qwen-Image 2.1 at the pinned graphs' 25 steps, the pictures almost the
// same, as the owner asked on 2026-09-27. It draws the pilot's five timed cells (local/image-pilot.ts), flight's front,
// view, A, V and T at seed 7 from round one's own plans, portraits and views, on one card: first on round two's server
// as it is (cu128, comfy-kitchen's Triton backend), then on that server started again with one change, each proven by
// what the server says of itself before any of its cells is drawn:
//   reference      round two's server, no change: what the others are compared with
//   highvram       --highvram: the model kept on the card between jobs. The log says HIGH_VRAM, and has no word of
//                  ComfyUI's dynamic VRAM, which the flag turns off
//   gpu-only       --gpu-only: that, and the text encoder, the VAE and what passes between the nodes on the card too
//   native-malloc  --disable-cuda-malloc: torch's own allocator in place of cudaMallocAsync, as /system_stats names it
//   ck-attention   --use-ck-attention: comfy-kitchen's int8 attention in place of PyTorch's, as the log says
//   cu130          the torch built for CUDA 13 (SIMPLE_CHAT_IMAGE_TORCH=cu130), whose log shows the kitchen's CUDA
//                  backend available and on
// Each flag is one of the pinned ComfyUI's, named in gpu/image-manifest.env and added by gpu/image-serve.sh only when
// SIMPLE_CHAT_IMAGE_LEVER asks for it; cu130's torch is pinned there already. Nothing new is fetched onto the card.
// A command draws one row: the base row on a server without Viggle's nodes, and on one started with them
// (SIMPLE_CHAT_IMAGE_VIGGLE=true) the turbo row, the same cells through Viggle's LoRA in six steps (image-pilot.ts
// `withTurbo`), one picture more a cell. No server draws both, the owner's rule. A row is three passes, each into a
// directory of its own under illustrations/levers:
//   cold   the five cells on round two's path, right after the server's start: what a start costs
//   warm   the same again: the seconds of a cell, and pictures an hour on round two's path
//   queue  the five cells, then the five again with a prompt one token longer, all ten sent at once, so that the card
//          is never idle between two: pictures an hour of the card itself, from its own stamps of each job's start and
//          end, for prompts it has drawn before and for new ones. Triton tunes its kernels for each new length
//          (comfy-kitchen's int8 matmuls are autotuned by m, n and k), which the warm pass never shows
// The pictures of a change are compared with the reference's of the same row pixel by pixel, as ImageMagick's
// `compare` counted the pilot's for triton.html: the share of pixels off by more than 3 per cent, and the PSNR. A
// change is `identical`, `rounding` within what the Triton switch showed (7.1 per cent of the pixels at most, 31 dB at
// least), or `visible`, which needs the owner's eye before it is kept; levers.html puts each cell's pictures side by side.
//   report    what the passes measured, in numbers
//   dry-run   all of it against local/fake-comfy.ts, from a made-up round one
// It draws no sharp story and reads nothing under sealed/. What it prints and keeps is ids, codes, counts, times,
// hashes and pixel differences, never a prompt or a word of a story; the server's log is matched, never kept.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import { CLEANUP_RESERVE_MS, apiGraph, comfyUrl, logLines, serverPins, settled, stageSocket, submitOnStage } from './image-batch.ts';
import type { Comfy, Graph, Outage, Phases, StagedJob } from './image-batch.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeComfyOptions } from './fake-comfy.ts';
import { readManifest } from './tokenizer-extract.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { readJson } from './action-text.ts';
import { ACTION_GRAPH, DRAW_CODES, FRONT_GRAPH, drawPilot, drawStage, pilotGraphs } from './action-draw.ts';
import type { ActionCell, CellRecord } from './action-draw.ts';
import { escapeHtml } from './action-judge.ts';
import { CELL_WORDS, PILOT_SEED, PILOT_STORY, SOURCE_DIR, TIMED, TURBO_RECIPE, VIGGLE, VIGGLE_NODES, decodePng, kitchenLines, kitchenOf, labelOf,
  madeUpRoundOne, ownPins, readSource, safeError, viggleOn, withTurbo } from './image-pilot.ts';
import type { Kitchen, Source } from './image-pilot.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const LEVERS_DIR = join(ROOT, 'illustrations', 'levers');
const MANIFEST = join(ROOT, 'gpu', 'image-manifest.env');
// Round two's directory, which the measurement never writes into.
const RUN_DIR = join(ROOT, 'illustrations', 'action');
const RECORD = 'levers.json';
export const LEVERS_PAGE = 'levers.html';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const graphOf = (file: string): Graph => apiGraph(JSON.parse(readFileSync(file, 'utf8')));
const print = (value: object) => console.log(JSON.stringify(value));

// ---- The changes ----

export type LeverName = 'reference' | 'highvram' | 'gpu-only' | 'native-malloc' | 'ck-attention' | 'cu130';
export const LEVER_NAMES: LeverName[] = ['reference', 'highvram', 'gpu-only', 'native-malloc', 'ck-attention', 'cu130'];
// The changes that are a flag of the server's command line, in the order gpu/image-manifest.env's IMAGE_LEVERS lists
// them; each flag is read from there (`flagsOf`), as gpu/image-serve.sh reads it.
const FLAG_LEVERS: LeverName[] = ['highvram', 'gpu-only', 'native-malloc', 'ck-attention'];
// The two whose log says HIGH_VRAM (comfy/model_management.py:578-579 at the pinned revision), with dynamic VRAM off
// (comfy/cli_args.py:318-321, so main.py:273-302 never says it is on).
const HIGH = new Set<LeverName>(['highvram', 'gpu-only']);
export type Row = 'base' | 'turbo';
const ROWS: Row[] = ['base', 'turbo'];
export type PassKind = 'cold' | 'warm' | 'queue';
const KINDS: PassKind[] = ['cold', 'warm', 'queue'];
export const passName = (lever: LeverName, row: Row, kind: PassKind) => `${lever}-${row}-${kind}`;
const isLever = (value: string): value is LeverName => (LEVER_NAMES as string[]).includes(value);

// Each change's flags, from the manifest: none for the reference and for cu130, whose change is the torch.
function flagsOf(manifest: Record<string, string>): Record<LeverName, string[]> {
  const listed = (manifest.IMAGE_LEVERS ?? '').split(/\s+/).filter(Boolean);
  if (listed.join(' ') !== FLAG_LEVERS.join(' ')) {
    throw new Refusal(`gpu/image-manifest.env lists the changes ${listed.join(', ') || 'none'} in IMAGE_LEVERS, and this measurement knows ${FLAG_LEVERS.join(', ')}`);
  }
  const flags = Object.fromEntries(LEVER_NAMES.map(lever => [lever, [] as string[]])) as Record<LeverName, string[]>;
  for (const lever of FLAG_LEVERS) {
    const flag = manifest[`IMAGE_LEVER_${lever.toUpperCase().replace(/-/g, '_')}`] ?? '';
    if (!/^--[a-z][a-z-]*$/.test(flag)) throw new Refusal(`gpu/image-manifest.env names no flag for ${lever}`);
    flags[lever] = [flag];
  }
  return flags;
}
// The flags gpu/image-serve.sh starts every server with, and those of the Triton backend and of Viggle's node. A server
// with any other is not round two's with one change, and is refused.
const OWN_FLAGS = new Set(['--listen', '--port', '--disable-auto-launch', '--temp-directory', '--disable-metadata', '--disable-all-custom-nodes',
  '--disable-api-nodes', '--preview-method', '--enable-triton-backend', '--whitelist-custom-nodes']);

// ---- What the server says of itself ----

type VramState = 'DISABLED' | 'NO_VRAM' | 'LOW_VRAM' | 'NORMAL_VRAM' | 'HIGH_VRAM' | 'SHARED' | 'other';
const VRAM_STATES = ['DISABLED', 'NO_VRAM', 'LOW_VRAM', 'NORMAL_VRAM', 'HIGH_VRAM', 'SHARED'];
type Attention = 'comfy-kitchen' | 'sage' | 'flash' | 'xformers' | 'pytorch' | 'split' | 'sub-quadratic';
// The attention the pinned server chose, as its log says at its start (comfy/ldm/modules/attention.py:857-885): one of
// these lines, then, under --use-ck-attention, "Using Comfy Kitchen attention" (881) in its place. "Using pytorch
// attention in VAE" is the VAE's (comfy/ldm/modules/diffusionmodules/model.py:334), and is not one of them.
const ATTENTION_LINES: [string, Attention][] = [['Using sage attention', 'sage'], ['Using Flash Attention', 'flash'],
  ['Using xformers attention', 'xformers'], ['Using pytorch attention', 'pytorch'], ['Using split optimization for attention', 'split']];
type Allocator = 'cudaMallocAsync' | 'native' | 'other' | 'none';
// What proves a change, or its absence, kept as enums, booleans and counts, never a line of the log. `seen`: the lines
// of the server's start are still in its log's ring of 300 (app/logger.py): the vram state (comfy/model_management.py:597),
// the attention, and comfy-kitchen's backends (comfy/quant_ops.py:22-43). `fresh`: the log has no job in it after them,
// neither "got prompt" (server.py:1077) nor "Prompt executed in" (main.py:382-384), so that a cold pass is the first
// work of the server. `flags`: the changes' flags on its command line (/system_stats `argv`, server.py:736), and
// `unknownFlags` how many other flags it has beyond gpu/image-serve.sh's own. `allocator`: what torch runs, the tail of
// the card's name on /system_stats (comfy/model_management.py:604-611, server.py:713). `dynamicVram`: the log says
// "DynamicVRAM support detected and enabled" (main.py:302). `viggle`: Viggle's nodes and LoRA, as /object_info lists them.
export type Evidence = { at: string; seen: boolean; fresh: boolean; flags: string[]; unknownFlags: number; triton: boolean; pytorch: string;
  allocator: Allocator; vramState?: VramState; dynamicVram?: boolean; attention?: Attention; kitchen: Kitchen; viggle: { nodes: number; lora: boolean } };

// The messages of the log's entries, one a line, without what the pinned server's logger puts around each (app/logger.py
// `ColoredFormatter`, set on every run: the level's tag, "[INFO] ", and ANSI colours, a line's own colour among them).
const messagesOf = (lines: string[] | undefined) => (lines ?? []).flatMap(line => line.slice(line.indexOf('\u0000') + 1)
  .replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(one => one.replace(/^\[(?:DEBUG|DETAIL|INFO|WARNING|ERROR|CRITICAL)\] /, '').trim()));
export function evidenceOf(lines: string[] | undefined, argv: string[], server: Record<string, string>, viggle: { nodes: number; lora: boolean },
  levers: Record<LeverName, string[]>): Evidence {
  const messages = messagesOf(lines);
  const state = messages.map(message => /^Set vram state to: ([A-Z_]+)$/.exec(message)?.[1]).find(Boolean);
  const chosen = messages.includes('Using Comfy Kitchen attention') ? 'comfy-kitchen' as const
    : messages.flatMap(message => message.startsWith('Using sub quadratic optimization for attention') ? ['sub-quadratic' as const]
      : ATTENTION_LINES.filter(([line]) => line === message).map(([, kind]) => kind)).at(-1);
  const triton = argv.includes('--enable-triton-backend') && !argv.includes('--disable-triton-backend');
  const kitchen = kitchenOf(lines, triton);
  const seen = state !== undefined && chosen !== undefined && kitchen.seen;
  const known = new Set(Object.values(levers).flat());
  const flags = argv.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]);
  const tail = /\s:\s*([A-Za-z]+)$/.exec(server.card ?? '')?.[1];
  return { at: new Date().toISOString(), seen, fresh: seen && !messages.some(message => message === 'got prompt' || message.startsWith('Prompt executed in ')),
    flags: [...new Set(flags.filter(flag => known.has(flag)))], unknownFlags: flags.filter(flag => !known.has(flag) && !OWN_FLAGS.has(flag)).length,
    triton, pytorch: server.pytorch ?? '', allocator: tail === undefined ? 'none' : tail === 'cudaMallocAsync' || tail === 'native' ? tail : 'other',
    ...(seen ? { vramState: (VRAM_STATES.includes(state!) ? state : 'other') as VramState, dynamicVram: messages.includes('DynamicVRAM support detected and enabled'),
      attention: chosen } : {}), kitchen, viggle };
}
const cudaOn = (kitchen: Kitchen) => !!kitchen.backends.cuda?.available && !kitchen.backends.cuda.disabled;
// The card's name without the allocator: the one fact of the card a change may move (native-malloc).
const cardName = (card: string | undefined) => (card ?? '').replace(/\s:\s*[A-Za-z]*$/, '');

// Why `evidence` does not prove `lever` on `row`, or nothing when it does. Every change stands on round two's server:
// Triton on, the flags of that change and no other, the torch the manifest pins for it, and Viggle's two nodes and its
// LoRA on the turbo row's server alone. Then the change's own word: the allocator /system_stats names, and, from the
// lines of the start, HIGH_VRAM and no dynamic VRAM for highvram and gpu-only and neither for the others, Comfy
// Kitchen's attention for ck-attention and for no other, and the kitchen's CUDA backend on for cu130.
function unproven(lever: LeverName, row: Row, e: Evidence, flags: string[], torch: string): string | undefined {
  if (!e.triton) return 'it was started without comfy-kitchen\'s Triton backend (SIMPLE_CHAT_IMAGE_TRITON=1), which round two runs with';
  if (e.flags.join(' ') !== flags.join(' ')) {
    return `its command line has ${e.flags.length ? e.flags.join(' ') : 'no change\'s flag'}, and ${lever} is ${flags.length ? flags.join(' ') : 'none of them'}`;
  }
  if (e.unknownFlags) {
    return `its command line has ${e.unknownFlags === 1 ? 'a flag' : `${e.unknownFlags} flags`} that neither gpu/image-serve.sh nor a change adds`;
  }
  if (e.pytorch !== torch) return `it runs torch ${e.pytorch || 'that it does not name'}, and ${lever} draws on ${torch}`;
  if (row === 'turbo' ? !(e.viggle.nodes === VIGGLE_NODES.length && e.viggle.lora) : e.viggle.nodes !== 0) {
    return `it has ${e.viggle.nodes} of Viggle's ${VIGGLE_NODES.length} nodes and the LoRA ${e.viggle.lora ? 'listed' : 'not listed'}: the base row is drawn `
      + 'without the nodes, and the turbo row with both and the LoRA (SIMPLE_CHAT_IMAGE_VIGGLE=true)';
  }
  const allocator = lever === 'native-malloc' ? 'native' : 'cudaMallocAsync';
  if (e.allocator !== allocator) return `/system_stats names the allocator ${e.allocator}, and ${lever} runs on ${allocator}`;
  if (!e.seen) return 'its log no longer holds the lines of its start, which prove the change';
  const triton = e.kitchen.backends.triton;
  if (e.kitchen.tritonImportFailed || !triton?.available || triton.disabled) return 'its log says comfy-kitchen\'s Triton backend did not load';
  if (HIGH.has(lever) !== (e.vramState === 'HIGH_VRAM')) return `its log says the vram state is ${e.vramState}`;
  if (HIGH.has(lever) && e.dynamicVram) return 'its log says dynamic VRAM is on, which --highvram and --gpu-only turn off';
  if ((lever === 'ck-attention') !== (e.attention === 'comfy-kitchen')) return `its log says the attention is ${e.attention}`;
  const cuda = e.kitchen.backends.cuda;
  if (lever === 'cu130' && !cudaOn(e.kitchen)) {
    return `its log does not show comfy-kitchen's CUDA backend available and on (${!cuda ? 'no line of it'
      : `available ${cuda.available}, disabled ${cuda.disabled}${cuda.why ? `, ${cuda.why}` : ''}`})`;
  }
  return undefined;
}
// The first fact of the server, other than the change's own, in which `e` differs from the reference's server of the
// same row: one change at a time.
function otherThanReference(lever: LeverName, e: Evidence, reference: Evidence): string | undefined {
  const facts: [string, unknown, unknown, boolean][] = [
    ['vram state', e.vramState, reference.vramState, HIGH.has(lever)], ['dynamic VRAM', e.dynamicVram, reference.dynamicVram, HIGH.has(lever)],
    ['attention', e.attention, reference.attention, lever === 'ck-attention'],
    ['comfy-kitchen\'s CUDA backend', cudaOn(e.kitchen), cudaOn(reference.kitchen), lever === 'cu130']];
  return facts.find(([, mine, theirs, own]) => !own && mine !== theirs)?.[0];
}

// ---- Pictures compared ----

// Two pictures as ImageMagick 6's `compare -metric AE -fuzz 3%` and `-metric PSNR` count them, which is how the pilot's
// Triton pairs were counted for illustrations/pilot/triton.html (docs/knowledge/gpu-measurements.md#pilot-2026-09-26):
// each colour premultiplied by its pixel's alpha, a pixel off when any of its three colours differs by more than 3 per
// cent of the full scale, and the PSNR over the three colours. It gives compare's counts and dB on those five pairs.
// `pixelsSame` asks for every channel, alpha included, to be the same. `comparable: false`: two that cannot be decoded
// here or differ in size.
export type Compared = { bytesSame: boolean; pixelsSame?: boolean; comparable?: false; off3?: number; off3Share?: number; psnr?: number | null;
  diff?: string };
const colourAt = (picture: NonNullable<ReturnType<typeof decodePng>>, pixel: number, k: number) =>
  picture.pixels[pixel * picture.channels + (picture.channels >= 3 ? k : 0)];
const alphaAt = (picture: NonNullable<ReturnType<typeof decodePng>>, pixel: number) =>
  (picture.channels === 4 || picture.channels === 2 ? picture.pixels[pixel * picture.channels + picture.channels - 1] / 255 : 1);
export function compared(one: Uint8Array, other: Uint8Array, withDiff = false): { result: Compared; diff?: Buffer } {
  if (sha256(one) === sha256(other)) return { result: { bytesSame: true, pixelsSame: true, off3: 0, off3Share: 0, psnr: null } };
  const a = decodePng(one), b = decodePng(other);
  if (!a || !b || a.width !== b.width || a.height !== b.height) return { result: { bytesSame: false, comparable: false } };
  const count = a.width * a.height, fuzz = (0.03 * 65535) ** 2;
  const rgb = withDiff ? new Uint8Array(count * 3) : undefined;
  let off = 0, squares = 0, same = true;
  for (let pixel = 0; pixel < count; pixel++) {
    const sa = alphaAt(a, pixel), sb = alphaAt(b, pixel);
    if (sa !== sb) same = false;
    let counted = false;
    for (let k = 0; k < 3; k++) {
      const delta = sa * colourAt(a, pixel, k) - sb * colourAt(b, pixel, k);
      if (colourAt(a, pixel, k) !== colourAt(b, pixel, k)) same = false;
      if ((delta * 257) ** 2 > fuzz) counted = true;
      squares += (delta / 255) ** 2;
      if (rgb) rgb[pixel * 3 + k] = Math.min(255, Math.round(Math.abs(delta) * 8));
    }
    if (counted) off++;
  }
  const result: Compared = { bytesSame: false, pixelsSame: same, off3: off, off3Share: Number((off / count).toFixed(6)),
    psnr: squares ? Number((10 * Math.log10(count * 3 / squares)).toFixed(2)) : null };
  return { result, ...(rgb && !same ? { diff: encodePng(a.width, a.height, rgb, 3) } : {}) };
}
// An 8-bit PNG of RGB or RGBA pixels, without filtering: the difference pictures, and the dry run's own.
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 3 | 4): Buffer {
  const stride = width * channels, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A change's pictures against the reference's: `identical`, the same pixels in every cell; `rounding`, every cell
// within what the Triton switch showed on the pilot's cells (0.3 to 7.1 per cent of the pixels off by more than 3 per
// cent, 31 to 47 dB, the scene and the people the same, docs/knowledge/gpu-measurements.md#pilot-2026-09-26);
// `visible`, anything more, which needs the owner's eye before it is kept; `unknown`, a cell not compared.
export type Verdict = 'identical' | 'rounding' | 'visible' | 'unknown';
export const ROUNDING = { off3Share: 0.071, psnr: 31 } as const;
export function verdictOf(cells: (Compared | undefined)[]): Verdict {
  if (!cells.length || cells.some(one => !one || one.comparable === false)) return 'unknown';
  if (cells.every(one => one!.pixelsSame)) return 'identical';
  return cells.every(one => one!.pixelsSame || ((one!.off3Share ?? 1) <= ROUNDING.off3Share && (one!.psnr ?? 0) >= ROUNDING.psnr)) ? 'rounding' : 'visible';
}

// ---- The record ----

// A cell of a cold or warm pass, as the pilot keeps one (image-pilot.ts `PilotCell`): its times, whether the server
// answered its sampler from its cache, its peaks of video memory (as nvidia-smi sees it) and RAM in MiB, and its
// picture against its own row's cold pass and, for a change's warm pass, against the reference's warm one (`diff`: the
// difference picture, eight times as bright, in diff/).
export type LeverCell = { cell: string; status: CellRecord['status'] | 'unsent'; code?: string; references: number; cycleMs?: number; totalMs?: number;
  viewMs?: number; outageMs?: number; phases?: Phases; samplerCached?: boolean; file?: string; sha256?: string; vramMiB?: number; ramMiB?: number;
  vsCold?: Compared; vsReference?: Compared };
// A job of the queue: its round (1 with the warm pass's prompts, 2 with each one token longer), its start after the
// queue's first and its time from the server's own stamps (`execution_start` to `execution_success` in its record,
// execution.py:677-684, 742, 824), the gap before it since the job ahead ended, where the socket heard its phases, and,
// in round 1, its picture against the warm pass's.
export type QueueJob = { cell: string; round: 1 | 2; status: 'drawn' | 'failed' | 'abandoned' | 'unsent'; code?: string; startMs?: number; jobMs?: number;
  gapMs?: number; phases?: Phases; samplerCached?: boolean; file?: string; sha256?: string; vramMiB?: number; vsWarm?: Compared };
// `heldAtOnce`: the jobs the server held, drawing and waiting, once all were sent; `spanMs` from the first job's start
// to the last one's end on the server's clock.
export type LeverPass = { name: string; lever: LeverName; row: Row; kind: PassKind; attempt: number; dir: string; pytorch: string; startedAt: string;
  completedAt: string; ended: 'done' | 'until' | 'stopped'; error?: string; wallMs: number; cells: LeverCell[];
  queue?: { jobs: QueueJob[]; heldAtOnce?: number; spanMs?: number } };
// `pins`: what every pass of the directory shares, the card's name without its allocator and the torch aside, which
// changes move. `evidence`: what proved each change on each row, by `<lever>:<row>`. `skipped`: passes that did not
// begin for too little time before --until.
export type LeverRecord = { story: string; seed: number; source: string; pins?: Record<string, string | number>; differsFromRoundOne?: string[];
  evidence: Record<string, Evidence>; passes: LeverPass[]; skipped?: string[] };

const QUEUE_JOBS = 2 * TIMED.length;
// A cold or warm pass is finished when it drew every cell and none waited for the network; a queue when every job was
// drawn and stamped.
const finished = (pass: LeverPass) => pass.ended === 'done' && (pass.kind === 'queue'
  ? pass.queue?.jobs.length === QUEUE_JOBS && pass.queue.jobs.every(job => job.status === 'drawn' && job.jobMs !== undefined)
  : pass.cells.length === TIMED.length && pass.cells.every(cell => cell.status === 'drawn' && !cell.outageMs));
const lastFinished = (record: LeverRecord, name: string) => record.passes.findLast(pass => pass.name === name && finished(pass));
// A pass whose times are those of the cells: no sampler answered from the server's cache.
const uncached = (pass: LeverPass) => (pass.kind === 'queue' ? pass.queue?.jobs ?? [] : pass.cells).every(one => one.samplerCached === false);
// A pass begins only with this much time left before --until; the queue's from its row's warm pass when there is one.
const NEEDS_MS: Record<PassKind, number> = { cold: 4 * 60000, warm: 2 * 60000, queue: 3 * 60000 };
// A pass that has not finished is drawn again whole, into a new directory; after this many attempts somebody looks first.
const ATTEMPTS = 3;

// ---- The command ----

export type LeverOptions = { dir: string; source: string; comfy: string; until: number; waitMs?: number; timeoutMs?: number; pollMs?: number;
  outage?: { windowMs?: number; pauseMs?: number }; log?: (event: object) => void };

// The measurement's directory is its own: not round one's or inside it, not round two's, and neither a run's nor the
// pilot's.
function guard(dir: string, source: string) {
  const within = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
  if (within(dir, source) || within(source, dir) || within(dir, RUN_DIR)) {
    throw new Refusal('The throughput measurement draws into a directory of its own (--dir), outside round one\'s (--from) and round two\'s illustrations/action');
  }
  for (const name of ['prompts.json', 'texts.json', 'draw.json', 'pilot.json', 'sealed']) {
    if (existsSync(join(dir, name))) throw new Refusal(`${dir} holds ${name}: it is another measurement's directory, not this one's`);
  }
}

// The server's command line, as /system_stats reports it. Only its flags are looked at.
async function argvOf(comfy: Comfy): Promise<string[]> {
  const response = await fetch(`${comfy.baseUrl}/system_stats`, { signal: AbortSignal.any([AbortSignal.timeout(comfy.timeoutMs), ...(comfy.end ? [comfy.end] : [])]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const argv = ((await response.json()) as { system?: { argv?: unknown } }).system?.argv;
  return Array.isArray(argv) ? argv.map(String) : [];
}

type Context = { dir: string; source: Source; card: ReturnType<typeof cardOf>; pins: Record<string, string | number>; comfy: string; until: number;
  options: LeverOptions; log: (event: object) => void; record: LeverRecord; lever: LeverName; row: Row; lora: string;
  samplers: { front: string[]; frame: string[] } };

export async function leverCommand(lever: LeverName, options: LeverOptions) {
  const dir = resolve(options.dir), from = resolve(options.source);
  guard(dir, from);
  const source = readSource(from);
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(dir, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${dir} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says`); }
  const log = options.log ?? (() => undefined);
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: AbortSignal.timeout(Math.max(0, options.until - Date.now())) };
  const unanswered = () => { throw new Refusal('The server did not say what it is on /system_stats and /object_info, or the end (--until) came first; nothing is drawn'); };
  const server = await serverPins(comfy, true).catch(unanswered);
  const argv = await argvOf(comfy).catch(unanswered);
  const manifest = readManifest(MANIFEST), flags = flagsOf(manifest), lora = manifest.IMAGE_VIGGLE_LORA_FILE ?? '';
  const viggle = await viggleOn(comfy, lora).catch(unanswered);
  if (viggle.nodes !== 0 && viggle.nodes !== VIGGLE_NODES.length) {
    throw new Refusal(`The server has ${viggle.nodes} of Viggle's ${VIGGLE_NODES.length} nodes: start it again with SIMPLE_CHAT_IMAGE_VIGGLE=true or without it (docs/action-experiment.md#levers)`);
  }
  const row: Row = viggle.nodes ? 'turbo' : 'base';
  const evidence = evidenceOf(await logLines(comfy), argv, server, viggle, flags);
  const file = join(dir, RECORD);
  const record: LeverRecord = readJson<LeverRecord>(file) ?? { story: PILOT_STORY, seed: PILOT_SEED, source: relative(dir, from), evidence: {}, passes: [] };
  if (record.source !== relative(dir, from)) throw new Refusal(`${file} was drawn from another round one than ${from}`);
  // One card and one build of the server for the whole directory: only the allocator in the card's name and the torch
  // are a change's to move, and the proof below holds each change to its own.
  const pins = { ...ownPins(card, source), ...server };
  const common: Record<string, string | number> = { ...ownPins(card, source), comfyui: server.comfyui, card: cardName(server.card),
    triton: server.triton ?? 'off' };
  const known = record.pins;
  const changed = known && [...new Set([...Object.keys(common), ...Object.keys(known)])].find(key => known[key] !== common[key]);
  if (changed) throw new Refusal(`${file} was drawn under another ${changed}: one directory holds one card and one build of the server`);
  // The change proven by this server's own word, or by an earlier read on this row of a server that says the same of its
  // command line, torch and allocator, when the lines of its start have left the log: a cold pass needs this one's.
  const key = `${lever}:${row}`, torch = manifest[lever === 'cu130' ? 'TORCH_CU130_VERSION' : 'TORCH_VERSION'] ?? '';
  const earlier = record.evidence[key];
  const same = earlier && earlier.flags.join(' ') === evidence.flags.join(' ') && earlier.pytorch === evidence.pytorch
    && earlier.allocator === evidence.allocator && earlier.viggle.nodes === evidence.viggle.nodes && earlier.triton === evidence.triton;
  const why = unproven(lever, row, evidence, flags[lever], torch);
  const standing = !why ? evidence : !evidence.seen && same && !unproven(lever, row, earlier, flags[lever], torch) ? earlier : undefined;
  if (!standing) {
    throw new Refusal(`The server is not ${lever === 'reference' ? 'round two\'s' : `round two's with ${lever}`} for the ${row} row: ${why}. Start it as `
      + 'docs/action-experiment.md#levers says; nothing is drawn');
  }
  const reference = record.evidence[`reference:${row}`];
  if (lever !== 'reference') {
    if (!lastFinished(record, passName('reference', row, 'warm')) || !reference) {
      throw new Refusal(`${lever} is compared with the reference's ${row} row: draw the reference on its own server first`);
    }
    const other = otherThanReference(lever, standing, reference);
    if (other) throw new Refusal(`The server differs from the reference's in its ${other} as well as in ${lever}: one change at a time`);
  }
  record.pins = common;
  record.evidence[key] = standing;
  const dropAllocator = (value: string | number | undefined) => (typeof value === 'string' ? cardName(value) : value);
  record.differsFromRoundOne = Object.keys(common).filter(name => name in source.pins && dropAllocator(source.pins[name]) !== common[name]);
  mkdirSync(join(dir, 'passes'), { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, record);
  save();
  const samplers = (graph: Graph) => Object.keys(graph).filter(id => /Sampler/.test(graph[id].class_type));
  const context: Context = { dir, source, card, pins, comfy: options.comfy, until: options.until, options, log, record, lever, row, lora,
    samplers: { front: samplers(graphOf(FRONT_GRAPH)), frame: samplers(graphOf(ACTION_GRAPH)) } };
  let stopped: string | undefined, skipped: string | undefined;
  for (const kind of KINDS) {
    const name = passName(lever, row, kind);
    if (lastFinished(record, name)) continue;
    // A cold pass is the first work of a server just started, and says what a start costs.
    if (kind === 'cold' && !evidence.fresh) {
      throw new Refusal(`${name} is drawn right after the server's start, and this server ${evidence.seen ? 'has drawn since' : 'no longer has its start in its log'}: `
        + 'start it again (docs/action-experiment.md#levers)');
    }
    const warm = lastFinished(record, passName(lever, row, 'warm'));
    const queued = warm?.cells.reduce((sum, cell) => sum + (cell.totalMs ?? 0), 0);
    const needsMs = kind === 'queue' && queued ? Math.round(queued * 2 * 1.5 + 60000) : NEEDS_MS[kind];
    if (options.until - Date.now() < needsMs) {
      skipped = name;
      record.skipped = [...new Set([...record.skipped ?? [], name])];
      save();
      break;
    }
    let attempt = record.passes.filter(pass => pass.name === name).length + 1;
    while (existsSync(join(dir, 'passes', `${name}-${attempt}`))) attempt++;
    if (attempt > ATTEMPTS) throw new Refusal(`${name} has not finished in ${attempt - 1} attempts: look at them before the card draws it again`);
    const pass = kind === 'queue' ? await drawQueue(context, attempt) : await drawPass(context, kind, attempt);
    record.passes.push(pass);
    save();
    log({ event: 'pass', name, attempt, ended: pass.ended, drawn: kind === 'queue' ? pass.queue?.jobs.filter(job => job.status === 'drawn').length ?? 0
      : pass.cells.filter(cell => cell.status === 'drawn').length, wallMs: pass.wallMs, ...(pass.error ? { error: pass.error } : {}) });
    if (!finished(pass)) { stopped = name; break; }
  }
  writePage(dir, record);
  const last = stopped ? record.passes.findLast(pass => pass.name === stopped) : undefined;
  const failed = last && [...last.cells, ...last.queue?.jobs ?? []].filter(one => one.status === 'failed').map(one => ({ cell: one.cell, code: one.code ?? null }));
  const warm = lastFinished(record, passName(lever, row, 'warm'));
  const verdict = lever !== 'reference' && warm ? verdictOf(warm.cells.map(cell => cell.vsReference)) : undefined;
  return { event: 'levers', lever, row, done: !stopped && !skipped, ...(stopped ? { stopped, ...(last?.error ? { error: last.error } : {}) } : {}),
    ...(failed?.length ? { failed } : {}), ...(skipped ? { skipped, reason: 'too little time before --until' } : {}),
    passes: Object.fromEntries(KINDS.map(kind => [passName(lever, row, kind), lastFinished(record, passName(lever, row, kind)) ? 'finished' : 'not finished'])),
    evidence: evidenceSummary(standing), ...(verdict ? { verdict, needsEye: verdict === 'visible' || verdict === 'unknown' } : {}),
    page: join(dir, LEVERS_PAGE), differsFromRoundOne: record.differsFromRoundOne };
}

const evidenceSummary = (e: Evidence) => ({ flags: e.flags, pytorch: e.pytorch, allocator: e.allocator, vramState: e.vramState ?? null,
  dynamicVram: e.dynamicVram ?? null, attention: e.attention ?? null, triton: e.kitchen.backends.triton ?? null, cuda: e.kitchen.backends.cuda ?? null,
  viggle: e.viggle, seen: e.seen });

// The timed cells in the pilot's order, round one's references as a pass's directory sees them, and the turbo row's
// change of each filled graph.
const timedCells = (source: Source) => TIMED.map(label => source.cells.find(cell => labelOf(cell) === label)!);
const seededFor = (source: Source, root: string) => Object.fromEntries(source.references.map(key => [key, { ...source.roundOne[key],
  file: relative(root, resolve(source.root, source.roundOne[key].file!)) }]));
const turboOf = (context: Context) => (context.row === 'turbo'
  ? { graph: (filled: Graph) => withTurbo(filled, context.lora), recipe: TURBO_RECIPE } : {});
const cellPart = (context: Context, cell: ActionCell) => (cell.kind === 'front' ? context.samplers.front : context.samplers.frame);

// A cold or a warm pass: the five cells on round two's path (local/action-draw.ts `drawPilot`), any failure ending it.
async function drawPass(context: Context, kind: 'cold' | 'warm', attempt: number): Promise<LeverPass> {
  const { dir, source, options, record, lever, row } = context;
  const name = passName(lever, row, kind), root = join(dir, 'passes', `${name}-${attempt}`);
  const cells = timedCells(source);
  const heard = new Map<string, { cycleMs?: number; cached?: string[] }>();
  const startedAt = new Date().toISOString(), began = performance.now();
  let mark = began, last = -1;
  const drawn = await drawPilot({ root, comfy: context.comfy, until: context.until, checkpoint: context.card.model, pins: context.pins,
    plans: [source.plan], cells, seeded: seededFor(source, root), roundTwo: true, stopAtFailure: true, timeoutMs: options.timeoutMs,
    waitMs: options.waitMs, pollMs: options.pollMs, outage: options.outage, log: context.log, ...turboOf(context),
    observe: (cell, _record, cached) => {
      // A cell's cycle is its own only when the cell before it was drawn too; cells are heard in their order.
      const now = performance.now(), at = cells.findIndex(one => one.key === cell.key);
      heard.set(cell.key, { ...(at === last + 1 ? { cycleMs: Math.round(now - mark) } : {}), ...(cached ? { cached } : {}) });
      mark = now;
      last = at;
    } });
  const wallMs = Math.round(performance.now() - began);
  const cold = kind === 'warm' ? lastFinished(record, passName(lever, row, 'cold')) : undefined;
  const reference = kind === 'warm' && lever !== 'reference' ? lastFinished(record, passName('reference', row, 'warm')) : undefined;
  const out = cells.map((cell): LeverCell => {
    const one = drawn.index.cells[cell.key], label = labelOf(cell);
    const base = { cell: label, references: cell.refs.length };
    if (!one) return { ...base, status: 'unsent' };
    if (one.status !== 'drawn' || !one.file) return { ...base, status: one.status, ...(one.code ? { code: one.code } : {}), ...(one.outageMs ? { outageMs: one.outageMs } : {}) };
    const bytes = readFileSync(join(root, one.file));
    const against = (pass: LeverPass | undefined, diff?: string) => {
      const other = pass?.cells.find(each => each.cell === label && each.file);
      if (!other) return undefined;
      const seen = compared(bytes, readFileSync(join(dir, other.file!)), diff !== undefined);
      if (diff && seen.diff) {
        mkdirSync(join(dir, 'diff'), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, diff), seen.diff, { mode: 0o600 });
        seen.result.diff = diff;
      }
      return seen.result;
    };
    const vsCold = against(cold), vsReference = against(reference, join('diff', `${lever}-${row}-${label}.png`));
    const told = heard.get(cell.key), device = one.vram?.[0];
    return { ...base, status: 'drawn', ...(told?.cycleMs === undefined ? {} : { cycleMs: told.cycleMs }), totalMs: one.totalMs, viewMs: one.viewMs,
      ...(one.outageMs ? { outageMs: one.outageMs } : {}), ...(one.phases ? { phases: one.phases } : {}),
      ...(told?.cached ? { samplerCached: cellPart(context, cell).some(id => told.cached!.includes(id)) } : {}),
      file: relative(dir, join(root, one.file)), sha256: one.sha256,
      ...(device ? { vramMiB: device.occupiedMiBMax ?? device.usedMiBMax } : {}), ...(one.ramMiB ? { ramMiB: one.ramMiB.max } : {}),
      ...(vsCold ? { vsCold } : {}), ...(vsReference ? { vsReference } : {}) };
  });
  return { name, lever, row, kind, attempt, dir: relative(dir, root), pytorch: String(context.pins.pytorch ?? ''), startedAt,
    completedAt: new Date().toISOString(), ended: drawn.ended, ...(drawn.index.error ? { error: drawn.index.error } : {}), wallMs, cells: out };
}

// The server's own stamps of a job, from its record (execution.py:677-684 at the pinned revision: each status message
// carries the moment it was sent, in milliseconds of the card's clock), read after the job is over and before `fetch`
// deletes the record; and the nodes it answered from its cache. Nothing else of the record is kept: it holds the prompt.
async function stampsOf(comfy: Comfy, promptId: string) {
  const signals = [AbortSignal.timeout(comfy.timeoutMs), ...(comfy.signal ? [comfy.signal] : []), ...(comfy.end ? [comfy.end] : [])];
  const response = await fetch(`${comfy.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: AbortSignal.any(signals) });
  if (!response.ok) throw Object.assign(new Error('comfy_http_error'), { code: 'comfy_http_error', httpStatus: response.status });
  const entry = ((await response.json()) as Record<string, { status?: { messages?: unknown } } | undefined>)[promptId];
  const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages as unknown[] : [];
  const data = (event: string) => (messages.find(one => Array.isArray(one) && one[0] === event) as [string, Record<string, unknown>] | undefined)?.[1];
  const at = (event: string) => (typeof data(event)?.timestamp === 'number' ? data(event)!.timestamp as number : undefined);
  const cached = data('execution_cached')?.nodes;
  return { start: at('execution_start'), end: at('execution_success'), cached: Array.isArray(cached) ? cached.map(String) : undefined };
}
// How many jobs the server holds, drawing and waiting.
async function heldOn(comfy: Comfy): Promise<number | undefined> {
  try {
    const response = await fetch(`${comfy.baseUrl}/queue`, { signal: AbortSignal.timeout(comfy.timeoutMs) });
    const queue = (await response.json()) as { queue_running?: unknown; queue_pending?: unknown };
    return Array.isArray(queue.queue_running) && Array.isArray(queue.queue_pending) ? queue.queue_running.length + queue.queue_pending.length : undefined;
  } catch { return undefined; }
}
const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DRAW_CODES.includes(code) ? code : code === 'not_admitted' ? 'out_of_time' : 'image_failed';
};

// The queue: the five cells, then the five again with their prompts `attempt` tokens longer (" ." each), a length no
// cell of the pilot has been drawn at on this server, all made ready first, their references uploaded, then all sent
// at once on one socket, so that the card goes from one to the next without waiting for us. Each job is followed in
// turn: over, its stamps read, its picture down and its record deleted. Whatever ends it early, the jobs still on the
// card are taken out of its queue at once, the one being drawn is stopped, and each record is deleted (image-batch.ts
// `stopJob`): nothing is left drawing on a card that bills by the minute.
async function drawQueue(context: Context, attempt: number): Promise<LeverPass> {
  const { dir, source, options, record, lever, row } = context;
  const name = passName(lever, row, 'queue'), root = join(dir, 'passes', `${name}-${attempt}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const cells = timedCells(source), suffix = ' .'.repeat(attempt);
  const planned = [...cells.map(cell => ({ cell, round: 1 as const })), ...cells.map(cell => ({ cell: { ...cell, prompt: cell.prompt + suffix }, round: 2 as const }))];
  const warm = lastFinished(record, passName(lever, row, 'warm'));
  const startedAt = new Date().toISOString(), began = performance.now();
  const abandon = new AbortController();
  const when = (ms: number) => AbortSignal.timeout(Math.max(0, Math.round(ms - Date.now())));
  const comfy: Comfy = { baseUrl: context.comfy, timeoutMs: options.timeoutMs ?? 60000, signal: abandon.signal, end: when(context.until),
    reserve: when(context.until + CLEANUP_RESERVE_MS) };
  const sent: { job: StagedJob; over?: Promise<void>; fetched: boolean }[] = [];
  const jobs: QueueJob[] = planned.map(one => ({ cell: labelOf(one.cell), round: one.round, status: 'unsent' }));
  const stamps: Awaited<ReturnType<typeof stampsOf>>[] = [];
  let ended: LeverPass['ended'] = 'done', error: string | undefined, heldAtOnce: number | undefined;
  // The job the work in hand is for: being sent, or followed. An error there is that job's.
  let at = -1;
  const socket = stageSocket(context.comfy);
  try {
    const ready = await pilotGraphs({ root, comfy: context.comfy, until: context.until, checkpoint: context.card.model, pins: context.pins,
      plans: [source.plan], cells: planned.map(one => one.cell), seeded: seededFor(source, root), timeoutMs: options.timeoutMs, log: context.log,
      ...turboOf(context) });
    // No window through a dropped connection: a queue the network broke is not a measurement, and is drawn again whole.
    for (const [n, one] of ready.entries()) {
      at = n;
      const outage: Outage = { windowMs: 0, pauseMs: 1, spentMs: 0 };
      sent.push({ job: await submitOnStage(comfy, one.graph, { pollMs: options.pollMs, waitMs: options.waitMs ?? 600000, sampleEvery: 1,
        requireSocket: true, admit: () => !abandon.signal.aborted && !comfy.end?.aborted }, { socket, outage }), fetched: false });
    }
    at = -1;
    heldAtOnce = await heldOn(comfy);
    for (const [n, one] of sent.entries()) {
      at = n;
      await (one.over = one.job.untilOver());
      // A sample of video memory at the job's end, while the next job draws: the queue's peak, not this job's own.
      await one.job.lastSample();
      stamps[n] = await stampsOf(comfy, one.job.promptId);
      const drawn = await one.job.fetch();
      one.fetched = true;
      const label = jobs[n].cell, path = join(root, `q${planned[n].round}-${label}.png`);
      writeFileSync(path, drawn.bytes, { mode: 0o600 });
      const other = planned[n].round === 1 ? warm?.cells.find(cell => cell.cell === label && cell.file) : undefined;
      const cached = drawn.cached ?? stamps[n].cached, device = drawn.vram[0];
      const { start, end } = stamps[n];
      jobs[n] = { ...jobs[n], status: 'drawn', ...(start !== undefined && end !== undefined ? { jobMs: end - start } : {}),
        ...(drawn.timing?.phases ? { phases: drawn.timing.phases } : {}),
        ...(cached ? { samplerCached: cellPart(context, planned[n].cell).some(id => cached.includes(id)) } : {}),
        file: relative(dir, path), sha256: sha256(drawn.bytes), ...(device ? { vramMiB: device.occupiedMiBMax ?? device.usedMiBMax } : {}),
        ...(other ? { vsWarm: compared(drawn.bytes, readFileSync(join(dir, other.file!))).result } : {}) };
    }
  } catch (caught) {
    if (caught instanceof Refusal) throw caught;
    ended = comfy.end?.aborted ? 'until' : 'stopped';
    error = codeOf(caught);
    if (at >= 0 && ended === 'stopped') jobs[at] = { ...jobs[at], status: 'failed', code: error };
    // Out of the card's queue first, all at once, so that it starts none of them; then each job followed to its end, the
    // one being drawn stopped, every record deleted.
    abandon.abort();
    const cleanup: Comfy = { baseUrl: comfy.baseUrl, timeoutMs: comfy.timeoutMs, end: comfy.reserve };
    const open = sent.filter(one => !one.fetched).map(one => one.job.promptId);
    if (open.length) {
      await fetch(`${cleanup.baseUrl}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: open }),
        signal: AbortSignal.any([AbortSignal.timeout(cleanup.timeoutMs), ...(cleanup.end ? [cleanup.end] : [])]) }).catch(() => undefined);
    }
    for (const [n, one] of sent.entries()) {
      if (one.fetched) continue;
      const over = await (one.over ??= one.job.untilOver()).then(() => true, () => false);
      if (over) await one.job.fetch().catch(() => undefined);
      if (jobs[n].status === 'unsent') jobs[n] = { ...jobs[n], status: 'abandoned' };
    }
  } finally {
    socket.close();
    await settled();
  }
  // Each job's start after the first one's, and the gap before it since the job ahead ended, on the server's clock.
  const first = stamps[0]?.start;
  jobs.forEach((job, n) => {
    const start = stamps[n]?.start, before = stamps[n - 1]?.end;
    if (start !== undefined && first !== undefined) job.startMs = start - first;
    if (n > 0 && start !== undefined && before !== undefined) job.gapMs = start - before;
  });
  const lastEnd = stamps.at(-1)?.end;
  return { name, lever, row, kind: 'queue', attempt, dir: relative(dir, root), pytorch: String(context.pins.pytorch ?? ''), startedAt,
    completedAt: new Date().toISOString(), ended, ...(error ? { error } : {}), wallMs: Math.round(performance.now() - began), cells: [],
    queue: { jobs, ...(heldAtOnce === undefined ? {} : { heldAtOnce }),
      ...(first !== undefined && lastEnd !== undefined && stamps.length === QUEUE_JOBS ? { spanMs: lastEnd - first } : {}) } };
}

// ---- The report ----

const known = (values: (number | undefined)[]) => values.filter(value => value !== undefined);
const mean = (values: (number | undefined)[]) => {
  const list = known(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : undefined;
};
const sum = (values: (number | undefined)[]) => (values.length && values.every(value => value !== undefined)
  ? values.reduce((total: number, value) => total + value!, 0) : undefined);
const whole = (value: number | undefined) => (value === undefined ? null : Math.round(value));
const ratio = (top: number | undefined, bottom: number | undefined) => (top === undefined || !bottom ? null : Number((top / bottom).toFixed(3)));
const perHour = (count: number, ms: number | undefined) => (!ms ? null : Number((count * 3600000 / ms).toFixed(1)));
const peak = (values: (number | undefined)[]) => (known(values).length ? Math.max(...known(values)) : null);
const byCell = (value: (label: string) => number | null) => Object.fromEntries(TIMED.map(label => [label, value(label)]));

// A queue's pictures an hour, each round's and all ten's: a job costs its own time and the gap before it, and the first
// job of the queue, which has none, the mean gap of the others.
function queueOf(pass: LeverPass | undefined) {
  if (!pass?.queue) return null;
  const jobs = pass.queue.jobs, gaps = known(jobs.slice(1).map(job => job.gapMs)), meanGap = mean(gaps);
  const round = (n: 1 | 2) => jobs.filter(job => job.round === n);
  const cost = (job: QueueJob) => (job.jobMs === undefined ? undefined : job.jobMs + (jobs.indexOf(job) === 0 ? meanGap ?? 0 : job.gapMs ?? meanGap ?? 0));
  const cellMs = (n: 1 | 2) => byCell(label => round(n).find(job => job.cell === label)?.jobMs ?? null);
  const extra = byCell(label => {
    const [before, after] = ([1, 2] as const).map(n => round(n).find(job => job.cell === label)?.jobMs);
    return before === undefined || after === undefined ? null : after - before;
  });
  return { heldAtOnce: pass.queue.heldAtOnce ?? null, comparable: uncached(pass), sameAsWarm: round(1).filter(job => job.vsWarm?.pixelsSame).length,
    meanGapMs: whole(meanGap), maxGapMs: gaps.length ? Math.max(...gaps) : null,
    warm: { picturesPerHour: perHour(round(1).length, sum(round(1).map(cost))), jobMs: cellMs(1) },
    fresh: { picturesPerHour: perHour(round(2).length, sum(round(2).map(cost))), jobMs: cellMs(2),
      extraMs: { ...extra, mean: whole(mean(Object.values(extra).map(value => value ?? undefined))) } },
    all: { picturesPerHour: perHour(jobs.length, pass.queue.spanMs), spanMs: pass.queue.spanMs ?? null } };
}

// One change on one row: whether its passes finished and how the last attempt of each that did not ended, what proved
// it, its warm cells' seconds by phase and pictures an hour on round two's path, what its cold pass took more than its
// warm one, its queue, and its peaks of video memory.
function leverSummary(record: LeverRecord, lever: LeverName, row: Row) {
  const pass = (kind: PassKind) => lastFinished(record, passName(lever, row, kind));
  const cold = pass('cold'), warm = pass('warm'), queue = pass('queue');
  const unfinished = (kind: PassKind) => {
    const name = passName(lever, row, kind), tries = record.passes.filter(one => one.name === name), last = tries.at(-1);
    return { attempts: tries.length, ...(last ? { ended: last.ended, ...(last.error ? { error: last.error } : {}) } : {}),
      ...(record.skipped?.includes(name) ? { skipped: 'too little time before --until' } : {}) };
  };
  const cellIn = (one: LeverPass | undefined, label: string) => one?.cells.find(cell => cell.cell === label);
  const phase = (key: keyof Phases) => byCell(label => whole(cellIn(warm, label)?.phases?.[key]));
  const evidence = record.evidence[`${lever}:${row}`];
  return { finished: Object.fromEntries(KINDS.map(kind => [kind, pass(kind) ? true : unfinished(kind)])),
    evidence: evidence ? evidenceSummary(evidence) : null,
    warm: warm ? { comparable: uncached(warm), totalMs: byCell(label => cellIn(warm, label)?.totalMs ?? null), sampleMs: phase('sampleMs'),
      encodeMs: phase('encodeMs'), loadMs: phase('loadMs'), decodeMs: phase('decodeMs'), cycleMs: byCell(label => cellIn(warm, label)?.cycleMs ?? null),
      picturesPerHour: perHour(warm.cells.length, sum(warm.cells.map(cell => cell.cycleMs))),
      sameAsCold: warm.cells.filter(cell => cell.vsCold?.pixelsSame).length } : null,
    coldExtraMs: cold && warm ? { ...byCell(label => {
      const before = cellIn(cold, label)?.cycleMs, after = cellIn(warm, label)?.cycleMs;
      return before === undefined || after === undefined ? null : before - after;
    }), all: whole(sum(cold.cells.map(cell => cell.cycleMs)) === undefined || sum(warm.cells.map(cell => cell.cycleMs)) === undefined ? undefined
      : sum(cold.cells.map(cell => cell.cycleMs))! - sum(warm.cells.map(cell => cell.cycleMs))!) } : null,
    queue: queueOf(queue),
    vramMiB: { cold: peak(cold?.cells.map(cell => cell.vramMiB) ?? []), warm: peak(warm?.cells.map(cell => cell.vramMiB) ?? []),
      queue: peak(queue?.queue?.jobs.map(job => job.vramMiB) ?? []) } };
}
// A change against the reference on the same row: its verdict on the pictures, and its times as ratios of the
// reference's (below 1 the faster), its pictures an hour as ratios (above 1 the more).
function versus(record: LeverRecord, lever: LeverName, row: Row) {
  const pass = (one: LeverName, kind: PassKind) => lastFinished(record, passName(one, row, kind));
  const warm = pass(lever, 'warm'), reference = pass('reference', 'warm');
  if (!warm || !reference) return null;
  const mine = leverSummary(record, lever, row), theirs = leverSummary(record, 'reference', row);
  const cellIn = (one: LeverPass, label: string) => one.cells.find(cell => cell.cell === label);
  const phaseRatio = (key: keyof Phases) => ({ ...byCell(label => ratio(cellIn(warm, label)?.phases?.[key], cellIn(reference, label)?.phases?.[key])),
    all: ratio(sum(warm.cells.map(cell => cell.phases?.[key])), sum(reference.cells.map(cell => cell.phases?.[key]))) });
  const verdict = verdictOf(warm.cells.map(cell => cell.vsReference));
  return { verdict, needsEye: verdict === 'visible' || verdict === 'unknown', comparable: uncached(warm) && uncached(reference),
    cellRatio: { ...byCell(label => ratio(cellIn(warm, label)?.totalMs, cellIn(reference, label)?.totalMs)),
      all: ratio(sum(warm.cells.map(cell => cell.totalMs)), sum(reference.cells.map(cell => cell.totalMs))) },
    sampleRatio: phaseRatio('sampleMs'), encodeRatio: phaseRatio('encodeMs'), decodeRatio: phaseRatio('decodeMs'),
    picturesPerHourRatio: { path: ratio(mine.warm?.picturesPerHour ?? undefined, theirs.warm?.picturesPerHour ?? undefined),
      queueWarm: ratio(mine.queue?.warm.picturesPerHour ?? undefined, theirs.queue?.warm.picturesPerHour ?? undefined),
      queueFresh: ratio(mine.queue?.fresh.picturesPerHour ?? undefined, theirs.queue?.fresh.picturesPerHour ?? undefined) },
    pixels: Object.fromEntries(warm.cells.map(cell => [cell.cell, cell.vsReference
      ? { off3Percent: cell.vsReference.off3Share === undefined ? null : Number((cell.vsReference.off3Share * 100).toFixed(2)),
        psnr: cell.vsReference.psnr ?? null, pixelsSame: cell.vsReference.pixelsSame ?? null } : null])) };
}

// What the passes measured, by row: the reference, then each change with its verdict and its ratios to the reference.
export function leversReport(dir: string) {
  const record = readJson<LeverRecord>(join(resolve(dir), RECORD));
  if (!record) throw new Refusal(`No ${RECORD} in ${dir}: a change's command writes it`);
  const rows = Object.fromEntries(ROWS.filter(row => record.passes.some(pass => pass.row === row)).map(row => [row, {
    reference: leverSummary(record, 'reference', row),
    levers: Object.fromEntries(LEVER_NAMES.filter(lever => lever !== 'reference' && record.passes.some(pass => pass.lever === lever && pass.row === row))
      .map(lever => [lever, { ...leverSummary(record, lever, row), vsReference: versus(record, lever, row) }])) }]));
  return { event: 'levers_report', differsFromRoundOne: record.differsFromRoundOne ?? [], rows,
    page: existsSync(join(resolve(dir), LEVERS_PAGE)) ? LEVERS_PAGE : null };
}

// ---- The page ----

// Each change's warm pictures beside the reference's of the same row, cell by cell, with their difference eight times as
// bright, for the owner's eye (docs/action-experiment.md#levers): a `visible` change is kept only once the owner has
// looked. A change's warm pass that has not finished is shown as its last attempt drew it, without a verdict. The paths
// are relative, so that the page opens from the directory, and it carries labels, seconds and pixel counts, never a
// prompt or a word of a story.
const LEVER_WORDS: Record<LeverName, string> = {
  reference: 'эталон: сервер раунда два как есть, cu128 и Triton',
  highvram: '--highvram: модель остаётся на карте между заданиями',
  'gpu-only': '--gpu-only: всё на карте, и текстовый энкодер, и VAE, и то, что идёт между узлами',
  'native-malloc': '--disable-cuda-malloc: собственный аллокатор torch вместо cudaMallocAsync',
  'ck-attention': '--use-ck-attention: int8-внимание comfy-kitchen вместо внимания PyTorch',
  cu130: 'torch для CUDA 13 (cu130), с бэкендом CUDA у comfy-kitchen',
};
const VERDICT_WORDS: Record<Verdict, string> = {
  identical: 'те же пиксели',
  rounding: `округление: не больше того, что дал переход на Triton (до ${(ROUNDING.off3Share * 100).toFixed(1)} % пикселей с разницей больше 3 %, `
    + `не меньше ${ROUNDING.psnr} дБ)`,
  visible: 'видно глазом: больше округления, оставлять только после взгляда владельца',
  unknown: 'не сравнить: клетка не нарисована или не читается, нужен взгляд владельца',
};
function writePage(dir: string, record: LeverRecord) {
  const seconds = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} с`);
  const times = (cell: LeverCell | undefined) => `клетка ${seconds(cell?.totalMs)}, сэмплер ${seconds(cell?.phases?.sampleMs)}`;
  const ratioWords = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${value.toFixed(2)}×`);
  const figure = (path: string | undefined, caption: string, missing: string) => {
    const src = path && existsSync(path) ? escapeHtml(relative(dir, path).split(sep).join('/')) : undefined;
    return `<figure>${src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>` : `<div class="box">${escapeHtml(missing)}</div>`}`
      + `<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  const steps = String(Object.values(graphOf(ACTION_GRAPH)).find(node => node.class_type === 'KSampler')?.inputs.steps ?? '—');
  const rowWords: Record<Row, string> = { base: `основа, ${steps} шагов, как рисует раунд два`, turbo: `турбо: LoRA Viggle, ${TURBO_RECIPE.steps} шагов` };
  const rows = ROWS.flatMap(row => {
    const reference = lastFinished(record, passName('reference', row, 'warm'));
    const levers = LEVER_NAMES.filter(lever => lever !== 'reference' && record.passes.some(pass => pass.name === passName(lever, row, 'warm')));
    if (!reference && !levers.length) return [];
    const sections = levers.map(lever => {
      const name = passName(lever, row, 'warm'), done = lastFinished(record, name), shown = done ?? record.passes.findLast(pass => pass.name === name)!;
      const against = versus(record, lever, row), verdict = done ? verdictOf(done.cells.map(cell => cell.vsReference)) : 'unknown';
      const cells = TIMED.map(label => {
        const plain = reference?.cells.find(one => one.cell === label), changed = shown.cells.find(one => one.cell === label);
        const seen = changed?.vsReference;
        const diff = !seen ? figure(undefined, 'разница', 'не сравнить') : seen.pixelsSame ? figure(undefined, 'разница', 'пиксели те же')
          : figure(seen.diff ? join(dir, seen.diff) : undefined, `разница ×8, чёрное совпадает: ${((seen.off3Share ?? 0) * 100).toFixed(2)} % пикселей `
            + `с разницей больше 3 %, ${seen.psnr ?? '—'} дБ`, 'не сравнить');
        return `<h4>${escapeHtml(label)}: ${escapeHtml(CELL_WORDS[label] ?? '')}</h4><div class="row">`
          + figure(plain?.file ? join(dir, plain.file) : undefined, `эталон: ${times(plain)}`, 'эталон не нарисован')
          + figure(changed?.file ? join(dir, changed.file) : undefined, `${lever}: ${times(changed)}`,
            changed?.status === 'failed' ? `не вышла: ${changed.code ?? '—'}` : 'не нарисована')
          + diff + '</div>';
      });
      return `<section><h3>${escapeHtml(LEVER_WORDS[lever])}</h3><p><b>${escapeHtml(VERDICT_WORDS[verdict])}.</b> `
        + `${escapeHtml(done ? `Тёплый проход, попытка ${done.attempt}.` : `Тёплый проход не докончен (${shown.ended}${shown.error ? `, ${shown.error}` : ''}).`)} `
        + `Время клеток против эталона: ${ratioWords(against?.cellRatio.all)}, сэмплера: ${ratioWords(against?.sampleRatio.all)}; картинок в час на пути `
        + `раунда два: ${ratioWords(against?.picturesPerHourRatio.path)}, в очереди: ${ratioWords(against?.picturesPerHourRatio.queueWarm)} со знакомыми `
        + `промптами и ${ratioWords(against?.picturesPerHourRatio.queueFresh)} с новыми.</p>${cells.join('')}</section>`;
    });
    return [`<h2>${escapeHtml(rowWords[row])}</h2><p>Эталон: ${reference ? `тёплый проход, попытка ${reference.attempt}` : 'не нарисован'}.</p>`
      + (sections.length ? sections.join('\n') : '<p>Перемен в этом ряду ещё не рисовали.</p>')];
  });
  writeFileSync(join(dir, LEVERS_PAGE), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Рычаги скорости: каждая перемена против эталона</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}figure{margin:0;
width:calc((100% - 16px) / 3)}img{width:100%;max-height:85vh;object-fit:contain;display:block}.box{display:flex;align-items:center;
justify-content:center;text-align:center;aspect-ratio:16/9;background:#eee;font-size:14px}@media (max-width:640px){figure{width:100%}}</style>
<h1>Рычаги скорости картиночного сервера: каждая перемена против эталона</h1>
<p>Пять клеток пилота на одной карте. Слева эталон: сервер раунда два как есть. Посередине тот же сервер с одной переменой: тот же граф, тот же
промпт, те же слоты и тот же сид. Справа их разница, усиленная в восемь раз: чёрное совпадает. «Округление» не больше того, что дал переход на
Triton; «видно глазом» оставляют только после взгляда владельца. Каждый ряд сравнивается со своим эталоном.</p>
${rows.join('\n')}
`, { mode: 0o600 });
}

// ---- The dry run ----

// The lines of a server's start that prove a change, for a server with `lever`, as the pinned code logs them: the vram
// state (comfy/model_management.py:578-597), the card with its allocator (626), PyTorch's attention and, under
// --use-ck-attention, the kitchen's after it (comfy/ldm/modules/attention.py:869, 881), comfy-kitchen's backends as
// the card logged them on 2026-09-26 (image-pilot.ts `kitchenLines`, whose cu130 lines no card has shown yet), dynamic
// VRAM unless --highvram or --gpu-only turned it off (main.py:273-302), and the VAE's attention, which is not the model's.
const startLines = (lever: LeverName) => [`Set vram state to: ${HIGH.has(lever) ? 'HIGH_VRAM' : 'NORMAL_VRAM'}`,
  `Device: cuda:0 fake card : ${lever === 'native-malloc' ? 'native' : 'cudaMallocAsync'}`, 'Using pytorch attention',
  ...(lever === 'ck-attention' ? ['Using Comfy Kitchen attention'] : []), ...kitchenLines(true, lever === 'cu130' ? 'cu130' : 'cu128'),
  ...(HIGH.has(lever) ? [] : ['DynamicVRAM support detected and enabled']), 'Using pytorch attention in VAE'];
// A line as the pinned server's logger writes it into its log (app/logger.py `ColoredFormatter`): the level's tag in
// its colour, bold from a warning up, and "Prompt executed in" in a green of its own (main.py:382-384).
const asLogged = (line: string) => (line.startsWith('WARNING') ? `\u001b[1m\u001b[33m[WARNING]\u001b[0m ${line}`
  : `\u001b[32m[INFO]\u001b[0m ${line.startsWith('Prompt executed in ') ? `\u001b[32m${line}\u001b[0m` : line}`);
// The flags gpu/image-serve.sh starts every server with, and Triton's.
const SERVE_ARGV = ['/workspace/ComfyUI/main.py', '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch', '--temp-directory',
  '/dev/shm/simple-chat-comfy', '--disable-metadata', '--disable-all-custom-nodes', '--disable-api-nodes', '--preview-method', 'none', '--enable-triton-backend'];

// The metric on pictures made here, whose counts are known: a colour off by 8 of 255 is off by more than 3 per cent and
// one off by 7 is not; colours premultiplied by alpha, so that two pixels both transparent are the same; the PSNR over
// the three colours.
function metricMisses(): string[] {
  const missed: string[] = [];
  const flat = (value: number, channels: 3 | 4, alpha = 255) => {
    const pixels = new Uint8Array(16 * channels);
    for (let at = 0; at < 16; at++) {
      pixels.fill(value, at * channels, at * channels + 3);
      if (channels === 4) pixels[at * channels + 3] = alpha;
    }
    return pixels;
  };
  const png = (pixels: Uint8Array, channels: 3 | 4) => encodePng(4, 4, pixels, channels);
  const a = flat(100, 3), b = flat(100, 3);
  b[0] = 108;
  b[4] = 107;
  b[8] = 0;
  const rgb = compared(png(a, 3), png(b, 3), true);
  if (!(rgb.result.off3 === 2 && rgb.result.psnr === 24.89 && rgb.result.pixelsSame === false && rgb.diff)) missed.push('rgb');
  const c = flat(100, 4, 128), d = flat(100, 4, 128);
  c[3] = 0;
  d[3] = 0;
  d[0] = 200;
  d.fill(120, 4, 7);
  const rgba = compared(png(c, 4), png(d, 4));
  if (!(rgba.result.off3 === 1 && rgba.result.psnr === 40.14 && rgba.result.pixelsSame === false)) missed.push('rgba');
  const back = decodePng(png(b, 3));
  if (!back || back.channels !== 3 || !Buffer.from(back.pixels).equals(Buffer.from(b))) missed.push('round trip');
  if (!compared(png(a, 3), png(a, 3)).result.bytesSame || compared(png(a, 3), encodePng(2, 8, a, 3)).result.comparable !== false) missed.push('same or not');
  const same: Compared = { bytesSame: false, pixelsSame: true }, near: Compared = { bytesSame: false, pixelsSame: false, off3Share: 0.05, psnr: 33 };
  const far: Compared = { bytesSame: false, pixelsSame: false, off3Share: 0.08, psnr: 33 }, dim: Compared = { bytesSame: false, pixelsSame: false, off3Share: 0.01, psnr: 30 };
  if (verdictOf([same, same]) !== 'identical' || verdictOf([same, near]) !== 'rounding' || verdictOf([near, far]) !== 'visible'
    || verdictOf([dim]) !== 'visible' || verdictOf([near, undefined]) !== 'unknown' || verdictOf([{ bytesSame: false, comparable: false }]) !== 'unknown') {
    missed.push('verdicts');
  }
  return missed;
}

// Every command against local/fake-comfy.ts: a made-up round one drawn by the action run's own smoke, then the reference
// on a server started as round two's, then each change on a server started with it, whose pictures follow from their
// graphs and move as `shift` moves them: a little for highvram and cu130 (rounding), not at all for native-malloc and
// gpu-only (identical), a lot for ck-attention (visible). native-malloc's queue fails at its third job and is drawn again,
// gpu-only is skipped once for too little time before --until, and the turbo row draws the reference and highvram on
// servers with Viggle's two nodes. Then `report` and the page. On the way, the refusals the paid measurement relies on,
// and at the end the search for the scene's made-up word in everything it wrote and printed.
export async function leversDryRun(out: string) {
  const dry = resolve(out), source = join(dry, 'round-one'), dir = join(dry, 'levers');
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = capture();
  const say = (line: string) => console.log(line);
  const missed: string[] = [];
  const expect = (holds: boolean, what: string) => { if (!holds) { missed.push(what); say(`   NOT AS EXPECTED: ${what}`); } };
  const refused = async (what: string, work: () => unknown) => {
    try { await work(); expect(false, `${what} refused`); } catch (error) { say(`   ${what}: refused (${JSON.stringify(safeError(error))})`); }
  };
  const word = madeUpName(), until = Date.now() + 2 * 3600000;
  const started: FakeComfyOptions = { jobMs: 15, referenceMs: 0, requireUploads: true, untilSampled: true, marker: word, picturesByGraph: true };
  const manifest = readManifest(MANIFEST), flags = flagsOf(manifest);
  const viggleInfo = { ViggleTurboLora: { input: { required: { model: ['MODEL'], lora_name: [[manifest.IMAGE_VIGGLE_LORA_FILE], {}], strength: ['FLOAT', {}] } } },
    ViggleTurboSigmas: { input: { required: { latent: ['LATENT'], nodes: ['STRING', { default: VIGGLE.nodes }] } } } };
  let fake = await startFakeComfy({ ...started, startupLog: kitchenLines(false) });
  // A server started as gpu/image-serve.sh starts it with SIMPLE_CHAT_IMAGE_LEVER=`lever`, and, with `turbo`, with
  // SIMPLE_CHAT_IMAGE_VIGGLE=true; `flags` in place of the change's own, the lines of its start as the pinned logger
  // writes them, and any knob of the fake over these.
  const serve = async (lever: LeverName, more: FakeComfyOptions & { turbo?: boolean; flags?: string[] } = {}) => {
    const { turbo, flags: own, startupLog, ...knobs } = more;
    await fake.close();
    fake = await startFakeComfy({ ...started, pytorch: manifest[lever === 'cu130' ? 'TORCH_CU130_VERSION' : 'TORCH_VERSION'],
      card: `cuda:0 fake card : ${lever === 'native-malloc' ? 'native' : 'cudaMallocAsync'}`,
      argv: [...SERVE_ARGV, ...(turbo ? ['--whitelist-custom-nodes', manifest.IMAGE_VIGGLE_NODE_FILE] : []), ...(own ?? flags[lever])],
      startupLog: (startupLog ?? startLines(lever)).map(asLogged), ...(turbo ? { objectInfo: viggleInfo } : {}), ...knobs });
  };
  const measure = (lever: LeverName, end = until, at = dir) => leverCommand(lever, { dir: at, source, comfy: fake.url, until: end, pollMs: 10,
    waitMs: 20000, timeoutMs: 10000 });
  const record = () => readJson<LeverRecord>(join(dir, RECORD))!;
  const passOf = (lever: LeverName, row: Row, kind: PassKind) => lastFinished(record(), passName(lever, row, kind));
  const verdict = (lever: LeverName, row: Row = 'base') => {
    const warm = passOf(lever, row, 'warm');
    return warm ? verdictOf(warm.cells.map(cell => cell.vsReference)) : undefined;
  };
  try {
    say(`the throughput measurement's dry run in ${dry}: a made-up round one and local/fake-comfy.ts; no card, no network`);
    const metric = metricMisses();
    say(`0 the metric on pictures made here: ${metric.length ? `wrong in ${metric.join(', ')}` : 'as ImageMagick counts'}`);
    expect(!metric.length, 'the metric counts as ImageMagick\'s compare does');
    madeUpRoundOne(source, word);
    const smoke = await drawStage({ stage: 'smoke', root: source, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
    say(`1 round one: the smoke drew ${Object.values(smoke.cells).filter(one => one.status === 'drawn').length} cells of ${PILOT_STORY}, pass ${smoke.smoke?.verdict?.pass}`);
    expect(smoke.smoke?.verdict?.pass === true, 'round one\'s smoke passes');
    writeCardRecord(join(dir, 'card.txt'));
    const pilot = join(dry, 'pilot');
    mkdirSync(pilot, { recursive: true, mode: 0o700 });
    writeFileSync(join(pilot, 'pilot.json'), '{}');
    writeCardRecord(join(pilot, 'card.txt'));

    await serve('highvram');
    await refused('highvram before the reference', () => measure('highvram'));
    await refused('the pilot\'s directory', () => measure('highvram', until, pilot));
    await refused('a directory inside round one\'s', () => measure('highvram', until, join(source, 'levers')));
    await serve('reference');
    say('   the server started as round two\'s');
    await refused('highvram on the reference\'s server', () => measure('highvram'));
    await refused('cu130 on the reference\'s server', () => measure('cu130'));
    const reference = await measure('reference');
    say(`2 reference: ${JSON.stringify(reference)}`);
    const queue = passOf('reference', 'base', 'queue')?.queue;
    expect(reference.done && KINDS.every(kind => passOf('reference', 'base', kind)) && fake.jobs.length === 20
      && fake.jobs.every(job => job.sampler === 'KSampler' && job.outcome === 'success'), 'the reference draws its twenty jobs, cold, warm and the queue');
    expect((queue?.heldAtOnce ?? 0) >= 2 && fake.mostHeld >= 2, 'the queue\'s jobs wait on the card together');
    expect(queue?.jobs.every(job => job.jobMs !== undefined && job.samplerCached === false && job.sha256) === true
      && queue.jobs.slice(1).every(job => job.gapMs !== undefined) && queue.spanMs !== undefined, 'every job of the queue is stamped by the server');
    expect(queue?.jobs.filter(job => job.round === 1).every(job => job.vsWarm?.pixelsSame) === true
      && queue.jobs.filter(job => job.round === 2).every(job => !queue.jobs.some(one => one.round === 1 && one.sha256 === job.sha256)),
      'the queue\'s first round draws the warm pass\'s pictures, and its second round other prompts');
    expect((['cold', 'warm'] as const).every(kind => passOf('reference', 'base', kind)?.cells.every(cell => cell.samplerCached === false))
      && passOf('reference', 'base', 'warm')?.cells.every(cell => cell.vsCold?.pixelsSame) === true, 'the warm pass draws the cold pass\'s pictures, none from the cache');
    const jobs = fake.jobs.length;
    await measure('reference');
    expect(fake.jobs.length === jobs, 'a finished row draws nothing again');

    await serve('highvram', { startupLog: startLines('reference') });
    await refused('highvram on a server whose log says NORMAL_VRAM', () => measure('highvram'));
    await serve('highvram', { startupLog: [] });
    await refused('highvram on a server whose log has lost its start', () => measure('highvram'));
    await serve('highvram', { flags: ['--highvram', '--disable-cuda-malloc'] });
    await refused('two changes at once', () => measure('highvram'));
    await serve('highvram', { flags: ['--highvram', '--fast'] });
    await refused('a flag no change adds', () => measure('highvram'));
    await serve('highvram', { card: 'cuda:0 another card : cudaMallocAsync' });
    await refused('another card', () => measure('highvram'));
    await serve('highvram', { startupLog: [...startLines('highvram'), 'got prompt', 'Prompt executed in 7.00 seconds'] });
    await refused('a cold pass on a server that has drawn', () => measure('highvram'));
    await serve('gpu-only', { startupLog: [...startLines('gpu-only'), 'DynamicVRAM support detected and enabled'] });
    await refused('gpu-only on a server whose log says dynamic VRAM is on', () => measure('gpu-only'));
    await serve('cu130', { startupLog: startLines('reference') });
    await refused('cu130 on a server whose log shows the CUDA backend off', () => measure('cu130'));
    await serve('reference', { pytorch: manifest.TORCH_CU130_VERSION, startupLog: startLines('cu130') });
    await refused('the reference on the cu130 torch', () => measure('reference'));
    expect(fake.jobs.length === 0, 'nothing is drawn on a server that is refused');

    await serve('highvram', { shift: { every: 20, delta: 5 } });
    const high = await measure('highvram');
    say(`3 highvram: ${JSON.stringify(high)}`);
    expect(high.done && high.verdict === 'rounding' && high.needsEye === false && verdict('highvram') === 'rounding', 'highvram\'s pictures round');
    await serve('native-malloc', { failJobs: [13] });
    const broken = await measure('native-malloc');
    say(`   native-malloc, its queue's third job failing: ${JSON.stringify(broken)}`);
    const brokenQueue = record().passes.findLast(pass => pass.name === 'native-malloc-base-queue')?.queue;
    const left = (await (await fetch(`${fake.url}/queue`)).json()) as { queue_running: unknown[]; queue_pending: unknown[] };
    const ids = fake.calls.filter(call => call.method === 'POST' && call.path === '/prompt' && call.id).map(call => call.id!);
    const records = await Promise.all(ids.map(async id => Object.keys(await (await fetch(`${fake.url}/history/${id}`)).json() as object).length));
    expect(!broken.done && broken.stopped === 'native-malloc-base-queue' && broken.failed?.[0]?.cell === 'A' && broken.failed[0].code === 'image_failed'
      && brokenQueue?.jobs.filter(job => job.status === 'abandoned').length === 7, 'a failed job ends the queue, the rest abandoned');
    expect(!left.queue_running.length && !left.queue_pending.length && records.every(count => count === 0) && ids.length === 20,
      'nothing is left drawing or waiting on the card, and no job\'s record is left');
    const mended = await measure('native-malloc');
    expect(mended.done && verdict('native-malloc') === 'identical' && passOf('native-malloc', 'base', 'queue')?.attempt === 2,
      'native-malloc\'s queue is drawn again whole, and its pictures are the reference\'s');
    await serve('ck-attention', { shift: { every: 4, delta: 40 } });
    const attention = await measure('ck-attention');
    say(`4 ck-attention: ${JSON.stringify(attention)}`);
    expect(attention.done && attention.verdict === 'visible' && attention.needsEye === true, 'ck-attention\'s pictures differ visibly, for the owner\'s eye');
    await serve('cu130', { shift: { every: 50, delta: 9 } });
    const cuda = await measure('cu130');
    expect(cuda.done && cuda.verdict === 'rounding' && passOf('cu130', 'base', 'warm')?.pytorch === manifest.TORCH_CU130_VERSION
      && passOf('cu130', 'base', 'warm')?.cells.every(cell => (cell.vsReference?.off3 ?? 0) > 0) === true, 'cu130 draws on its torch, its pictures round');
    await serve('gpu-only');
    const late = await measure('gpu-only', Date.now() + 3 * 60000);
    say(`   gpu-only three minutes before --until: ${JSON.stringify(late)}`);
    expect(!late.done && late.skipped === 'gpu-only-base-cold' && fake.jobs.length === 0, 'a pass with too little time left is skipped and draws nothing');
    const only = await measure('gpu-only');
    expect(only.done && only.verdict === 'identical', 'gpu-only draws the reference\'s pictures');

    await serve('reference', { turbo: true, objectInfo: { ViggleTurboSigmas: viggleInfo.ViggleTurboSigmas } });
    await refused('a server with one of Viggle\'s nodes', () => measure('reference'));
    await serve('highvram', { turbo: true });
    await refused('highvram on the turbo row before its reference', () => measure('highvram'));
    await serve('reference', { turbo: true });
    say('   the server started again with Viggle\'s nodes, SIMPLE_CHAT_IMAGE_VIGGLE=true');
    const turbo = await measure('reference');
    const paths = fake.jobs.map(job => job.model.join(' < '));
    say(`5 reference, turbo row: ${JSON.stringify(turbo)}`);
    expect(turbo.done && turbo.row === 'turbo' && fake.jobs.length === 20 && fake.jobs.every(job => job.sampler === 'SamplerCustomAdvanced')
      && paths.every(one => one.startsWith('ViggleTurboLora') || one.startsWith('QwenImage21Cache < ViggleTurboLora')), 'the turbo row samples every job through the LoRA');
    await serve('highvram', { turbo: true, shift: { every: 20, delta: 5 } });
    const turboHigh = await measure('highvram');
    expect(turboHigh.done && turboHigh.row === 'turbo' && turboHigh.verdict === 'rounding', 'highvram on the turbo row is compared with the turbo row\'s reference');

    const report = leversReport(dir), base = report.rows.base, fast = report.rows.turbo;
    say(`6 report: ${JSON.stringify(report)}`);
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
    expect(!!base && !!fast && number(base.reference.warm?.picturesPerHour) && number(base.reference.queue?.warm.picturesPerHour)
      && number(base.reference.queue?.fresh.picturesPerHour) && number(base.reference.queue?.fresh.extraMs.mean) && number(base.reference.coldExtraMs?.all)
      && number(fast.reference.queue?.all.picturesPerHour), 'the report has the reference\'s numbers on both rows');
    const verdicts = Object.fromEntries(Object.entries(base?.levers ?? {}).map(([lever, one]) => [lever, one.vsReference?.verdict]));
    expect(JSON.stringify(verdicts) === JSON.stringify({ highvram: 'rounding', 'gpu-only': 'identical', 'native-malloc': 'identical', 'ck-attention': 'visible',
      cu130: 'rounding' }) && fast?.levers.highvram?.vsReference?.verdict === 'rounding' && number(base?.levers.highvram?.vsReference?.cellRatio.all)
      && number(base?.levers.highvram?.vsReference?.picturesPerHourRatio.queueFresh), 'the report has each change\'s verdict and ratios');
    // Six changes drawn on their rows, five cells each: the reference's picture and the change's, and the difference where
    // the pixels differ, in highvram's, ck-attention's and cu130's cells on the base row and highvram's on the turbo row.
    const page = existsSync(join(dir, LEVERS_PAGE)) ? readFileSync(join(dir, LEVERS_PAGE), 'utf8') : '';
    const sources = [...page.matchAll(/src="([^"]+)"/g)].map(match => match[1]);
    const diffs = existsSync(join(dir, 'diff')) ? readdirSync(join(dir, 'diff')).length : 0;
    expect((page.match(/<section>/g) ?? []).length === 6 && diffs === 4 * TIMED.length && sources.length === 6 * TIMED.length * 2 + diffs
      && sources.every(one => existsSync(join(dir, one))), 'the page puts each change\'s pictures beside the reference\'s, with their difference');
    // The word is in round one's plans, which the measurement read; it must be nowhere it wrote or printed.
    const forms = markerForms(word);
    const found = searchTree(dir, forms), inRoundOne = searchTree(source, forms).hits.length;
    const printed = forms.some(form => Buffer.from(output.text(), 'utf8').includes(form));
    const sealed = readdirSync(dry, { recursive: true, withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === 'sealed').length;
    say(`7 boundary: ${found.files} files in the measurement's directory, ${found.unread.length} unread, ${found.hits.length} with the word, which round `
      + `one's plans hold in ${inRoundOne}; printed ${printed}; ${sealed} sealed directories`);
    expect(inRoundOne > 0 && !found.hits.length && !found.unread.length && !printed, 'the scene\'s word nowhere the measurement wrote or printed');
    expect(sealed === 0, 'no sealed directory anywhere');
    say(missed.length ? `the throughput measurement's dry run did NOT go as expected: ${missed.length} of its checks` : 'the throughput measurement\'s dry run went as expected');
    return { pass: !missed.length, missed };
  } finally {
    await fake.close();
    output.stop();
  }
}

// ---- The command line ----

const USAGE = 'Use: image-levers.ts reference|highvram|gpu-only|native-malloc|ck-attention|cu130 --until <epoch seconds, five minutes before the '
  + 'card\'s end> [--dir illustrations/levers] [--from illustrations/action-1] [--wait 600] [--timeout 60] [--comfy http://127.0.0.1:8188], '
  + 'report [--dir], or dry-run [--dir] (docs/action-experiment.md#levers)';
async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '600' }, timeout: { type: 'string', default: '60' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await leversDryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-levers-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  const dir = resolve(values.dir ?? LEVERS_DIR);
  if (command === 'report') return print(leversReport(dir));
  if (!isLever(command)) throw new Refusal(USAGE);
  // `--until` as the action run takes it: the end of the work in epoch seconds, five minutes before the card's end.
  const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
  if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
    || !Number.isInteger(timeout) || timeout < 10) throw new Refusal(USAGE);
  let comfy: string;
  try { comfy = comfyUrl(values.comfy!); } catch { throw new Refusal('--comfy is the tunnelled loopback root of the server, such as http://127.0.0.1:8188'); }
  const result = await leverCommand(command, { dir, source: resolve(values.from ?? SOURCE_DIR), comfy, until, waitMs: wait * 1000,
    timeoutMs: timeout * 1000, log: print });
  print(result);
  if (!result.done) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { await main(process.argv.slice(2)); } catch (error) {
    console.error(JSON.stringify({ event: 'error', ...safeError(error) }));
    process.exitCode = 1;
  }
}
