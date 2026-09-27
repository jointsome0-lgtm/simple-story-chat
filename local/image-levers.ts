// The throughput measurement (docs/action-experiment.md#levers, in the order of #card-plan): what one change of the
// picture server at a time buys in pictures per card-hour on the base pipeline, Qwen-Image 2.1 at the pinned graphs' 25
// steps, the pictures almost the same, as the owner asked on 2026-09-27. Every server is round two's (cu128,
// comfy-kitchen's Triton backend) started by gpu/image-serve.sh with environment variables alone, and each step is
// proven by what the server says of itself before any of its cells is drawn:
//   reference  round two's server with TRITON_PRINT_AUTOTUNING=1 and TRITON_CACHE_AUTOTUNING=1: Triton's tuning
//              counted and kept in its cache. What the others are compared with
//   cu130      the torch built for CUDA 13 (SIMPLE_CHAT_IMAGE_TORCH=cu130): the kitchen's CUDA backend runs the int8
//              matmuls, and nothing is tuned
//   attention  the kitchen's INT8 attention through the core ModelAttentionBackend node in every graph, on cu130's
//              server without a restart, or on closing's where cu130 did not draw; then one plain cell
//   closing    the reference again after a restart, reading back the tuning the reference wrote
// A command draws one row: the base row on a server without Viggle's nodes, and on one started with them
// (SIMPLE_CHAT_IMAGE_VIGGLE=true) the turbo row, the same cells through Viggle's LoRA in six steps (image-pilot.ts
// `withTurbo`). No server draws both, the owner's rule. The passes, each into a directory of its own:
//   cold    the pilot's five timed cells (flight's front, view, A, V and T at seed 7) as the first work of a server
//           just started: what a start costs
//   warm    the same again: the seconds of a cell on round two's path
//   stream  eight of round one's clean text-only frames at 1280x704, each of a conditioning length new to the server,
//           at seed 7, then the same eight at seed 11, one job at a time on round two's path: what a new length costs
//           a bot's scene, and pictures an hour from the server's own stamps of each job
//   plain   attention's one cell without the node, which must be the same server's plain picture again
// Per job the harness counts Triton's tuning lines in the card's log, and per pass, over ssh, the tuning files in
// Triton's cache and, at the start, the variables in the server's environment: counts alone, nothing copied. A step's
// pictures are compared with those of its comparison step of the same prompt and seed, pixel by pixel as ImageMagick's
// `compare` counted the pilot's for triton.html: `identical`, `rounding` within what the Triton switch showed, or
// `visible`, which, as `unknown`, needs the owner's eye before it is kept; levers.html puts them side by side.
//   stream    the eight frames chosen from round one's records, before the card
//   report    what the passes measured, in numbers
//   dry-run   all of it against local/fake-comfy.ts, from a made-up round one
// It draws no sharp story and reads nothing under sealed/. What it prints and keeps is ids, codes, counts, times,
// hashes and pixel differences, never a prompt or a word of a story; the server's log is matched, never kept.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32, deflateSync } from 'node:zlib';
import { MARKER_STORY } from '../examples/action-set.ts';
import { apiGraph, comfyUrl, logLines, serverPins } from './image-batch.ts';
import type { Comfy, Graph, Phases } from './image-batch.ts';
import { cardOf, writeCardRecord } from './image-identity.ts';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeComfyOptions } from './fake-comfy.ts';
import { readManifest } from './tokenizer-extract.ts';
import { Refusal, capture, madeUpName, markerForms, searchTree } from './action-boundary.ts';
import { isSharp, readJson, storyDir } from './action-text.ts';
import type { StoryPlan } from './action-prompts.ts';
import { ACTION_GRAPH, FRAME_CANVAS, FRONT_GRAPH, drawPilot, drawStage, frameKey } from './action-draw.ts';
import type { ActionCell, CellRecord, DrawIndex, Heard } from './action-draw.ts';
import { escapeHtml } from './action-judge.ts';
import { CELL_WORDS, PILOT_SEED, PILOT_STORY, SOURCE_DIR, TIMED, TURBO_RECIPE, VIGGLE, VIGGLE_NODES, decodePng, kitchenLines, kitchenOf, labelOf,
  madeUpRoundOne, natural, ownPins, readSource, safeError, viggleOn, withTurbo } from './image-pilot.ts';
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

// ---- The steps ----

export type Step = 'reference' | 'cu130' | 'attention' | 'closing';
export const STEPS: Step[] = ['reference', 'cu130', 'attention', 'closing'];
export type Row = 'base' | 'turbo';
const ROWS: Row[] = ['base', 'turbo'];
export type PassKind = 'cold' | 'warm' | 'stream' | 'plain';
export const passName = (step: Step, row: Row, kind: PassKind) => `${step}-${row}-${kind}`;
const isStep = (value: string): value is Step => (STEPS as string[]).includes(value);
// The passes of each step, in their order: closing draws the stream's first eight alone, whose lengths the reference
// tuned; attention draws on a server that has drawn already, so no cold pass.
const KINDS: Record<Step, PassKind[]> = { reference: ['cold', 'warm', 'stream'], cu130: ['cold', 'warm', 'stream'], closing: ['cold', 'stream'],
  attention: ['warm', 'stream', 'plain'] };
// The attention every graph of the step gets, through the pinned core node (comfy_extras/nodes_model_advanced.py:374-411).
const ATTENTION_NODE = 'ModelAttentionBackend';
const KITCHEN_ATTENTION = 'comfy kitchen attention';
// The flags gpu/image-serve.sh starts every server with, and those of the Triton backend and of Viggle's node. A server
// with any other is not round two's, and is refused.
const OWN_FLAGS = new Set(['--listen', '--port', '--disable-auto-launch', '--temp-directory', '--disable-metadata', '--disable-all-custom-nodes',
  '--disable-api-nodes', '--preview-method', '--enable-triton-backend', '--whitelist-custom-nodes']);
// Triton's switches of tuning (python/triton/knobs.py:374-376 in Triton 3.6.0) and of its cache's place (342-353), counted
// in the server's environment: each row's servers have each switch once and set to 1, or not at all, and no other place
// for the cache than /root/.triton/cache. The base row keeps its tunings there, so that closing can read them back; the
// turbo row tunes every length afresh, as a turbo server just started would, and neither reads nor writes the files
// (autotuner.py:237-240).
export const VARIABLES = ['TRITON_PRINT_AUTOTUNING', 'TRITON_CACHE_AUTOTUNING', 'TRITON_CACHE_DIR', 'TRITON_HOME'] as const;
type Variable = typeof VARIABLES[number];
export type EnvCounts = Record<Variable, { set: number; on: number }>;
const ENVIRONMENT: Record<Row, Record<Variable, number>> = {
  base: { TRITON_PRINT_AUTOTUNING: 1, TRITON_CACHE_AUTOTUNING: 1, TRITON_CACHE_DIR: 0, TRITON_HOME: 0 },
  turbo: { TRITON_PRINT_AUTOTUNING: 1, TRITON_CACHE_AUTOTUNING: 0, TRITON_CACHE_DIR: 0, TRITON_HOME: 0 },
};
export const RESTART_VARIABLES: Record<Row, string> = { base: 'TRITON_PRINT_AUTOTUNING=1 TRITON_CACHE_AUTOTUNING=1', turbo: 'TRITON_PRINT_AUTOTUNING=1' };

// ---- The card over ssh: counts alone ----

// What the card says of its server, over ssh (`simple-chat-vast`, as the runbook reaches it): how many servers run, the
// process id of the one there is, each variable's count in its environment (/proc/<pid>/environ), set and set to 1, and
// the tuning files under Triton's cache. The script prints those numbers and nothing else; a value of the environment
// is read on the card to find the cache and never leaves it.
export type Probe = { servers: number; pid: number; env: EnvCounts; files: number };
export type Prober = () => Promise<Probe>;
export const PROBE_SCRIPT = String.raw`pid=$(pgrep -f '[C]omfyUI/main.py' | head -n 1); echo "servers $(pgrep -fc '[C]omfyUI/main.py')"; echo "pid ${'${pid:-0}'}"; `
  + String.raw`[ -n "$pid" ] || exit 0; for name in ${VARIABLES.join(' ')}; do echo "env $name $(tr '\0' '\n' < /proc/$pid/environ | grep -c "^$name=") `
  + String.raw`$(tr '\0' '\n' < /proc/$pid/environ | grep -cx "$name=1")"; done; home=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^HOME=//p' | head -n 1); `
  + String.raw`echo "files $(find "${'${home:-/root}'}/.triton/cache" -name '*.autotune.json' 2>/dev/null | wc -l)"`;
export function parseProbe(text: string): Probe | undefined {
  const number = (pattern: RegExp) => { const found = pattern.exec(text); return found ? Number(found[1]) : undefined; };
  const servers = number(/^servers (\d+)$/m), pid = number(/^pid (\d+)$/m), files = number(/^files (\d+)$/m);
  const env = Object.fromEntries(VARIABLES.map(name => {
    const found = new RegExp(`^env ${name} (\\d+) (\\d+)$`, 'm').exec(text);
    return [name, found ? { set: Number(found[1]), on: Number(found[2]) } : undefined];
  }));
  if (servers === undefined || pid === undefined) return undefined;
  if (pid === 0) return { servers, pid, env: Object.fromEntries(VARIABLES.map(name => [name, { set: 0, on: 0 }])) as EnvCounts, files: 0 };
  if (files === undefined || Object.values(env).some(one => !one)) return undefined;
  return { servers, pid, env: env as EnvCounts, files };
}
export function sshProber(host: string): Prober {
  return () => new Promise((done, fail) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, PROBE_SCRIPT], { timeout: 30000, maxBuffer: 65536 }, (error, stdout) => {
      const probe = error ? undefined : parseProbe(String(stdout));
      if (probe) done(probe); else fail(new Refusal(`The card did not give its counts over ssh (${host}): nothing is drawn without them`));
    });
  });
}

// ---- What the server says of itself ----

type VramState = 'DISABLED' | 'NO_VRAM' | 'LOW_VRAM' | 'NORMAL_VRAM' | 'HIGH_VRAM' | 'SHARED' | 'other';
const VRAM_STATES = ['DISABLED', 'NO_VRAM', 'LOW_VRAM', 'NORMAL_VRAM', 'HIGH_VRAM', 'SHARED'];
type Attention = 'comfy-kitchen' | 'sage' | 'flash' | 'xformers' | 'pytorch' | 'split' | 'sub-quadratic';
// The attention the pinned server chose at its start (comfy/ldm/modules/attention.py:857-885). "Using pytorch
// attention in VAE" is the VAE's (comfy/ldm/modules/diffusionmodules/model.py:334), and is not one of them.
const ATTENTION_LINES: [string, Attention][] = [['Using sage attention', 'sage'], ['Using Flash Attention', 'flash'],
  ['Using xformers attention', 'xformers'], ['Using pytorch attention', 'pytorch'], ['Using split optimization for attention', 'split']];
type Allocator = 'cudaMallocAsync' | 'native' | 'other' | 'none';
// What proves a step, kept as enums, booleans and counts, never a line of the log. `seen`: the lines of the server's
// start are still in its log's ring of 300 (app/logger.py): the vram state (comfy/model_management.py:597), the
// attention, and comfy-kitchen's backends (comfy/quant_ops.py:22-43). `fresh`: the log has no job in it after them,
// neither "got prompt" (server.py:1077) nor "Prompt executed in" (main.py:382-384). `unknownFlags`: how many flags its
// command line (/system_stats `argv`, server.py:736) has beyond gpu/image-serve.sh's own. `allocator`: the tail of the
// card's name on /system_stats (comfy/model_management.py:604-611, server.py:713). `viggle`: Viggle's nodes and LoRA, and
// `attentionOption` whether ModelAttentionBackend offers the kitchen's attention, which it does only where the kernel
// is available (nodes_model_advanced.py:377-379), as /object_info lists them. The rest is the card's over ssh (`Probe`).
export type Evidence = { at: string; seen: boolean; fresh: boolean; unknownFlags: number; triton: boolean; pytorch: string; allocator: Allocator;
  vramState?: VramState; dynamicVram?: boolean; attention?: Attention; kitchen: Kitchen; viggle: { nodes: number; lora: boolean };
  attentionOption: boolean } & Probe;

// The messages of the log's entries, one a line, without what the pinned server's logger puts around each (app/logger.py
// `ColoredFormatter`: the level's tag, "[INFO] ", and ANSI colours).
const messagesOf = (lines: string[] | undefined) => (lines ?? []).flatMap(line => line.slice(line.indexOf('\u0000') + 1)
  .replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(one => one.replace(/^\[(?:DEBUG|DETAIL|INFO|WARNING|ERROR|CRITICAL)\] /, '').trim()));
export function evidenceOf(lines: string[] | undefined, argv: string[], server: Record<string, string>, viggle: { nodes: number; lora: boolean },
  attentionOption: boolean, probe: Probe): Evidence {
  const messages = messagesOf(lines);
  const state = messages.map(message => /^Set vram state to: ([A-Z_]+)$/.exec(message)?.[1]).find(Boolean);
  const chosen = messages.includes('Using Comfy Kitchen attention') ? 'comfy-kitchen' as const
    : messages.flatMap(message => message.startsWith('Using sub quadratic optimization for attention') ? ['sub-quadratic' as const]
      : ATTENTION_LINES.filter(([line]) => line === message).map(([, kind]) => kind)).at(-1);
  const triton = argv.includes('--enable-triton-backend') && !argv.includes('--disable-triton-backend');
  const kitchen = kitchenOf(lines, triton);
  const seen = state !== undefined && chosen !== undefined && kitchen.seen;
  const flags = argv.filter(arg => arg.startsWith('--')).map(arg => arg.split('=')[0]);
  const tail = /\s:\s*([A-Za-z]+)$/.exec(server.card ?? '')?.[1];
  return { at: new Date().toISOString(), seen, fresh: seen && !messages.some(message => message === 'got prompt' || message.startsWith('Prompt executed in ')),
    unknownFlags: flags.filter(flag => !OWN_FLAGS.has(flag)).length, triton, pytorch: server.pytorch ?? '',
    allocator: tail === undefined ? 'none' : tail === 'cudaMallocAsync' || tail === 'native' ? tail : 'other',
    ...(seen ? { vramState: (VRAM_STATES.includes(state!) ? state : 'other') as VramState, dynamicVram: messages.includes('DynamicVRAM support detected and enabled'),
      attention: chosen } : {}), kitchen, viggle, attentionOption, ...probe };
}
const cudaOn = (kitchen: Kitchen) => !!kitchen.backends.cuda?.available && !kitchen.backends.cuda.disabled;
const cardName = (card: string | undefined) => (card ?? '').replace(/\s:\s*[A-Za-z]*$/, '');

// Why `e` does not prove `step` on `row` with `torch`, or nothing when it does. Every server stands on round two's:
// Triton on, the flags of gpu/image-serve.sh and no other, cudaMallocAsync, Viggle's two nodes and its LoRA on the turbo
// row's server alone, the kitchen's Triton backend loaded, one server on the card, and the row's variables in its
// environment. Then the step's own word: the kitchen's CUDA backend on for cu130's torch, and the kitchen's attention
// among ModelAttentionBackend's options for attention.
function unproven(step: Step, row: Row, e: Evidence, torch: string): string | undefined {
  if (!e.triton) return 'it was started without comfy-kitchen\'s Triton backend (SIMPLE_CHAT_IMAGE_TRITON=1), which round two runs with';
  if (e.unknownFlags) return `its command line has ${e.unknownFlags === 1 ? 'a flag' : `${e.unknownFlags} flags`} that gpu/image-serve.sh does not add`;
  if (e.pytorch !== torch) return `it runs torch ${e.pytorch || 'that it does not name'}, and ${step} draws on ${torch}`;
  if (row === 'turbo' ? !(e.viggle.nodes === VIGGLE_NODES.length && e.viggle.lora) : e.viggle.nodes !== 0) {
    return `it has ${e.viggle.nodes} of Viggle's ${VIGGLE_NODES.length} nodes and the LoRA ${e.viggle.lora ? 'listed' : 'not listed'}: the base row is drawn `
      + 'without the nodes, and the turbo row with both and the LoRA (SIMPLE_CHAT_IMAGE_VIGGLE=true)';
  }
  if (e.allocator !== 'cudaMallocAsync') return `/system_stats names the allocator ${e.allocator}, and round two runs on cudaMallocAsync`;
  if (e.servers !== 1 || !e.pid) return `the card runs ${e.servers} servers`;
  const wrong = VARIABLES.find(name => e.env[name].set !== ENVIRONMENT[row][name] || e.env[name].on !== (name.endsWith('AUTOTUNING') ? ENVIRONMENT[row][name] : 0));
  if (wrong) {
    return `its environment holds ${wrong} ${e.env[wrong].set} times (${e.env[wrong].on} set to 1), and the ${row} row's servers are started with `
      + `${RESTART_VARIABLES[row]} and no other of ${VARIABLES.join(', ')}`;
  }
  if (!e.seen) return 'its log no longer holds the lines of its start, which prove the step';
  const triton = e.kitchen.backends.triton;
  if (e.kitchen.tritonImportFailed || !triton?.available || triton.disabled) return 'its log says comfy-kitchen\'s Triton backend did not load';
  if (e.attention !== 'pytorch') return `its log says the attention is ${e.attention}, and round two starts with PyTorch's`;
  const cuda = e.kitchen.backends.cuda;
  if (torch.includes('cu130') && !cudaOn(e.kitchen)) {
    return `its log does not show comfy-kitchen's CUDA backend available and on (${!cuda ? 'no line of it'
      : `available ${cuda.available}, disabled ${cuda.disabled}${cuda.why ? `, ${cuda.why}` : ''}`})`;
  }
  if (step === 'attention' && !e.attentionOption) return `its ${ATTENTION_NODE} does not offer ${KITCHEN_ATTENTION} (comfy_extras/nodes_model_advanced.py:377-379)`;
  return undefined;
}
// The first fact of the server, other than the torch's own, in which `e` differs from the reference's server of the
// same row: one change at a time.
function otherThanReference(e: Evidence, reference: Evidence): string | undefined {
  const facts: [string, unknown, unknown, boolean][] = [['vram state', e.vramState, reference.vramState, false],
    ['dynamic VRAM', e.dynamicVram, reference.dynamicVram, false], ['attention', e.attention, reference.attention, false],
    ['comfy-kitchen\'s CUDA backend', cudaOn(e.kitchen), cudaOn(reference.kitchen), e.pytorch !== reference.pytorch]];
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
// A step's pictures against its comparison step's: `identical`, the same pixels in every pair; `rounding`, every pair
// within what the Triton switch showed on the pilot's cells (0.3 to 7.1 per cent of the pixels off by more than 3 per
// cent, 31 to 47 dB, the scene and the people the same, docs/knowledge/gpu-measurements.md#pilot-2026-09-26);
// `visible`, anything more, which needs the owner's eye before it is kept; `unknown`, a pair not compared.
export type Verdict = 'identical' | 'rounding' | 'visible' | 'unknown';
export const ROUNDING = { off3Share: 0.071, psnr: 31 } as const;
export function verdictOf(cells: (Compared | undefined)[]): Verdict {
  if (!cells.length || cells.some(one => !one || one.comparable === false)) return 'unknown';
  if (cells.every(one => one!.pixelsSame)) return 'identical';
  return cells.every(one => one!.pixelsSame || ((one!.off3Share ?? 1) <= ROUNDING.off3Share && (one!.psnr ?? 0) >= ROUNDING.psnr)) ? 'rounding' : 'visible';
}

// ---- The stream ----

// A cell's key in round one's sense, what makes its sequence lengths: its canvas, its conditioning tokens and its
// references' sizes. Two cells of one key are one length to Triton's tuning.
const lengthKey = (one: CellRecord) => `${one.width}x${one.height}:${one.conditioningTokens}:${JSON.stringify(one.referenceSizes ?? [])}`;
export const STREAM_SIZE = 8;
export const STREAM_SEEDS = [PILOT_SEED, 11];
const STREAM_PREFIX = 'stream:';
export const streamLabel = (cell: ActionCell) => `${cell.story}:${cell.arm}:s${cell.seed}`;
export type Stream = { cells: ActionCell[]; plans: StoryPlan[]; chosen: { story: string; arm: string; conditioningTokens: number }[]; candidates: number };
// The stream's eight, from round one's own records: clean text-only frames (A, A+ or L) at 1280x704 that round one
// drew at seed 7 under clean/, each of a length of its own and none of the timed cells', spread over the lengths by
// their order; their prompts from their stories' plans, which must be the ones round one drew from. Nothing under
// sealed/ is read, and no sharp story or the marker check's is taken.
export function chooseStream(source: Source): Stream {
  const index = readJson<DrawIndex>(join(source.root, 'draw.json'));
  if (!index) throw new Refusal(`No draw.json in ${source.root}: the stream is chosen from round one's records`);
  const clean = join(source.root, 'clean') + sep;
  const timed = new Set(TIMED.map(label => source.cells.find(cell => labelOf(cell) === label)!).map(cell => source.roundOne[natural(cell)])
    .filter(Boolean).map(lengthKey));
  const byKey = new Map<string, CellRecord>();
  for (const one of Object.values(index.cells).sort((a, b) => a.key.localeCompare(b.key))) {
    if (one.kind !== 'frame' || !one.arm || !['A', 'A+', 'L'].includes(one.arm) || one.status !== 'drawn' || one.seed !== PILOT_SEED || one.references !== 0
      || one.width !== FRAME_CANVAS.width || one.height !== FRAME_CANVAS.height || typeof one.conditioningTokens !== 'number'
      || isSharp(one.story) || one.story === MARKER_STORY.id || !one.file || !resolve(source.root, one.file).startsWith(clean)) continue;
    if (timed.has(lengthKey(one)) || byKey.has(lengthKey(one))) continue;
    byKey.set(lengthKey(one), one);
  }
  const candidates = [...byKey.values()].sort((a, b) => a.conditioningTokens! - b.conditioningTokens! || a.key.localeCompare(b.key));
  if (candidates.length < STREAM_SIZE) {
    throw new Refusal(`Round one has ${candidates.length} clean text-only frames of lengths of their own, and the stream takes ${STREAM_SIZE}`);
  }
  const picked = Array.from({ length: STREAM_SIZE }, (_, k) => candidates[Math.round(k * (candidates.length - 1) / (STREAM_SIZE - 1))]);
  const plans = new Map<string, StoryPlan>();
  const cells: ActionCell[] = [];
  for (const seed of STREAM_SEEDS) {
    for (const one of picked) {
      const dir = storyDir(source.root, one.story);
      if (dir.split(/[\\/]/).includes('sealed')) throw new Refusal('The stream draws clean cells alone');
      const plan = plans.get(one.story) ?? readJson<StoryPlan>(join(dir, 'plan.json'));
      const arm = plan?.arms[one.arm!];
      if (!plan || !arm || arm.references.length || arm.prompt.length !== one.promptChars) {
        throw new Refusal(`${one.story}'s plan.json in ${source.root} is not the one round one drew its ${one.arm} from`);
      }
      plans.set(one.story, plan);
      cells.push({ key: STREAM_PREFIX + frameKey(one.story, seed, one.arm!), kind: 'frame', story: one.story, id: `${one.story}-s${seed}-${one.arm}`, seed,
        arm: one.arm, refs: [], prompt: arm.prompt });
    }
  }
  return { cells, plans: [...plans.values()], chosen: picked.map(one => ({ story: one.story, arm: one.arm!, conditioningTokens: one.conditioningTokens! })),
    candidates: candidates.length };
}

// ---- The record ----

// A cell of a pass, as the pilot keeps one: its times on our side, its phases as the socket heard them, whether the
// server answered its sampler from its cache, its peaks of video memory and RAM in MiB, the server's own stamps of the
// job's start and success (`jobMs` between them, `gapMs` since the job ahead of it in the pass ended), and the log
// between the reads before and after its job: Triton's tuning lines and their keys' m, n and k (`tuningFloor` when the
// ring no longer reached back, so that the count is a floor), and the attention node's fallback lines.
export type LeverCell = { cell: string; seed: number; status: CellRecord['status'] | 'unsent'; code?: string; references: number; cycleMs?: number;
  totalMs?: number; viewMs?: number; outageMs?: number; phases?: Phases; samplerCached?: boolean; file?: string; sha256?: string; vramMiB?: number;
  ramMiB?: number; jobMs?: number; gapMs?: number; tuning?: number; tuningFloor?: true; keys?: number[][]; fallback?: number };
// `files`: the tuning files in Triton's cache before and after the pass, over ssh.
export type LeverPass = { name: string; step: Step; row: Row; kind: PassKind; attempt: number; dir: string; pytorch: string; startedAt: string;
  completedAt: string; ended: 'done' | 'until' | 'stopped'; error?: string; wallMs: number; cells: LeverCell[]; files?: { before?: number; after?: number } };
// `pins`: what every pass of the directory shares. `evidence`: what proved each step on each row, by `<step>:<row>`.
// `pairs`: each step's pictures against its comparison step's, by `<step>:<row>` and cell. `skipped`: passes that did
// not begin for too little time before --until. `stream`: the eight frames, as chosen.
export type LeverRecord = { story: string; seed: number; source: string; pins?: Record<string, string | number>; differsFromRoundOne?: string[];
  stream?: Stream['chosen']; evidence: Record<string, Evidence>; passes: LeverPass[]; pairs?: Record<string, Record<string, Compared>>;
  plainAgain?: Record<string, Compared>; skipped?: string[] };

const expectedCells = (step: Step, kind: PassKind) => (kind === 'stream' ? STREAM_SIZE * (step === 'closing' ? 1 : STREAM_SEEDS.length)
  : kind === 'plain' ? 1 : TIMED.length);
// A pass is finished when it drew every cell and none waited for the network.
const finished = (pass: LeverPass) => pass.ended === 'done' && pass.cells.length === expectedCells(pass.step, pass.kind)
  && pass.cells.every(cell => cell.status === 'drawn' && !cell.outageMs);
const lastFinished = (record: LeverRecord, name: string) => record.passes.findLast(pass => pass.name === name && finished(pass));
const stepDone = (record: LeverRecord, step: Step, row: Row) => KINDS[step].every(kind => lastFinished(record, passName(step, row, kind)));
// A pass whose times are those of the cells: no sampler answered from the server's cache.
const uncached = (pass: LeverPass) => pass.cells.every(one => one.samplerCached === false);
// A pass begins only with this much time left before --until.
const NEEDS_MS: Record<PassKind, number> = { cold: 4 * 60000, warm: 2 * 60000, stream: 4 * 60000, plain: 30000 };
// A pass that has not finished is drawn again whole, into a new directory; after this many attempts somebody looks first.
const ATTEMPTS = 3;
// The step whose pictures a step's are compared with, on the same row: the reference for cu130 and closing, and for
// attention the same server's plain pictures, cu130's on cu130 and the reference's on cu128, which closing holds to.
const comparisonOf = (step: Step, pytorch: string, cu130: string): Step | undefined => (step === 'reference' ? undefined
  : step === 'attention' && pytorch === cu130 ? 'cu130' : 'reference');
// Attention rides on the server of this step: cu130's where the server runs cu130, closing's on the base row's cu128.
const hostOf = (row: Row, pytorch: string, cu130: string): Step => (pytorch === cu130 ? 'cu130' : row === 'base' ? 'closing' : 'reference');

// ---- The command ----

export type LeverOptions = { dir: string; source: string; comfy: string; until: number; probe: Prober; waitMs?: number; timeoutMs?: number;
  pollMs?: number; outage?: { windowMs?: number; pauseMs?: number }; log?: (event: object) => void };

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
// Whether the server's ModelAttentionBackend offers the kitchen's attention, by /object_info (the V3 schema's combo,
// `["COMBO", { options }]`, or a list of options first, as older nodes list them).
async function attentionOffered(comfy: Comfy): Promise<boolean> {
  const response = await fetch(`${comfy.baseUrl}/object_info/${ATTENTION_NODE}`, { signal: AbortSignal.any([AbortSignal.timeout(comfy.timeoutMs), ...(comfy.end ? [comfy.end] : [])]) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const input = ((await response.json()) as Record<string, { input?: { required?: Record<string, unknown> } } | undefined>)[ATTENTION_NODE]?.input?.required?.attention;
  const options = Array.isArray(input) ? (Array.isArray(input[0]) ? input[0] : (input[1] as { options?: unknown } | undefined)?.options) : undefined;
  return Array.isArray(options) && options.includes(KITCHEN_ATTENTION);
}
// A graph with the kitchen's attention on the model the sampler takes, or the guider's where a SamplerCustomAdvanced
// samples (the turbo row), under a node id of its own.
export function withAttention(graph: Graph): Graph {
  const out: Graph = JSON.parse(JSON.stringify(graph));
  const sampler = Object.values(out).find(node => node.class_type === 'KSampler' || node.class_type === 'SamplerCustomAdvanced');
  const guider = sampler && Array.isArray(sampler.inputs.guider) ? out[String(sampler.inputs.guider[0])] : undefined;
  const holder = sampler && 'model' in sampler.inputs ? sampler : guider;
  if (!holder || !Array.isArray(holder.inputs.model)) throw new Refusal('The graph has no sampler or guider that takes a model');
  const id = String(Math.max(0, ...Object.keys(out).map(Number).filter(Number.isFinite)) + 1);
  out[id] = { class_type: ATTENTION_NODE, inputs: { model: holder.inputs.model, attention: KITCHEN_ATTENTION } };
  holder.inputs.model = [id, 0];
  return out;
}

type Context = { dir: string; source: Source; stream: Stream; card: ReturnType<typeof cardOf>; pins: Record<string, string | number>; comfy: string;
  until: number; options: LeverOptions; log: (event: object) => void; record: LeverRecord; step: Step; row: Row; lora: string;
  samplers: { front: string[]; frame: string[] } };

// What a step's command prints at its end: whether its passes all finished, how the last one ended where one did not,
// what proved the step, and its verdict against its comparison step once both have drawn.
export type LeverResult = { event: 'levers'; step: Step; row: Row; done: boolean; drawn?: number; why?: string; stopped?: string; error?: string;
  failed?: { cell: string; code: string | null }[]; skipped?: string; reason?: string; passes?: Record<string, string>;
  evidence?: ReturnType<typeof evidenceSummary>; against?: Step; verdict?: Verdict; pairs?: number; needsEye?: boolean; plainAgain?: boolean; page: string;
  differsFromRoundOne?: string[] };

export async function leverCommand(step: Step, options: LeverOptions): Promise<LeverResult> {
  const dir = resolve(options.dir), from = resolve(options.source);
  guard(dir, from);
  const source = readSource(from);
  const stream = chooseStream(source);
  let card: ReturnType<typeof cardOf>;
  try { card = cardOf(join(dir, 'card.txt')); }
  catch { throw new Refusal(`card.txt in ${dir} is missing or differs from gpu/image-manifest.env: copy image-verified.txt off the card as the runbook says`); }
  const log = options.log ?? (() => undefined);
  const comfy: Comfy = { baseUrl: options.comfy, timeoutMs: options.timeoutMs ?? 60000, end: AbortSignal.timeout(Math.max(0, options.until - Date.now())) };
  const unanswered = () => { throw new Refusal('The server did not say what it is on /system_stats and /object_info, or the end (--until) came first; nothing is drawn'); };
  const server = await serverPins(comfy, true).catch(unanswered);
  const argv = await argvOf(comfy).catch(unanswered);
  const manifest = readManifest(MANIFEST), lora = manifest.IMAGE_VIGGLE_LORA_FILE ?? '';
  const viggle = await viggleOn(comfy, lora).catch(unanswered);
  const offered = await attentionOffered(comfy).catch(unanswered);
  if (viggle.nodes !== 0 && viggle.nodes !== VIGGLE_NODES.length) {
    throw new Refusal(`The server has ${viggle.nodes} of Viggle's ${VIGGLE_NODES.length} nodes: start it again with SIMPLE_CHAT_IMAGE_VIGGLE=true or without it (docs/action-experiment.md#card-plan)`);
  }
  const row: Row = viggle.nodes ? 'turbo' : 'base';
  const file = join(dir, RECORD);
  const record: LeverRecord = readJson<LeverRecord>(file) ?? { story: PILOT_STORY, seed: PILOT_SEED, source: relative(dir, from), evidence: {}, passes: [] };
  if (record.source !== relative(dir, from)) throw new Refusal(`${file} was drawn from another round one than ${from}`);
  if (record.stream && JSON.stringify(record.stream) !== JSON.stringify(stream.chosen)) throw new Refusal(`${file} drew another stream than round one gives now`);
  // A step that has drawn on this row draws nothing again, on whatever server.
  if (stepDone(record, step, row)) return { event: 'levers', step, row, done: true, drawn: 0, why: `${step} has drawn on the ${row} row already`, page: join(dir, LEVERS_PAGE) };
  const probe = await options.probe();
  const evidence = evidenceOf(await logLines(comfy), argv, server, viggle, offered, probe);
  // One card and one build of the server for the whole directory: only the torch is a step's to move.
  const pins = { ...ownPins(card, source), ...server };
  const common: Record<string, string | number> = { ...ownPins(card, source), comfyui: server.comfyui, card: cardName(server.card), triton: server.triton ?? 'off' };
  const known = record.pins;
  const changed = known && [...new Set([...Object.keys(common), ...Object.keys(known)])].find(key => known[key] !== common[key]);
  if (changed) throw new Refusal(`${file} was drawn under another ${changed}: one directory holds one card and one build of the server`);
  const cu128 = manifest.TORCH_VERSION ?? '', cu130 = manifest.TORCH_CU130_VERSION ?? '';
  const torch = step === 'cu130' ? cu130 : step === 'attention' && evidence.pytorch === cu130 ? cu130 : cu128;
  // The step proven by this server's own word, or by an earlier read of the same server, the same process on the card,
  // when the lines of its start have left the log: a cold pass needs this one's. Attention's earlier read is that of the
  // step whose server it draws on.
  const key = `${step}:${row}`;
  const earlier = record.evidence[key] ?? (step === 'attention' ? record.evidence[`${hostOf(row, evidence.pytorch, cu130)}:${row}`] : undefined);
  const why = unproven(step, row, evidence, torch);
  const same = earlier && earlier.pid === evidence.pid && earlier.pytorch === evidence.pytorch && earlier.viggle.nodes === evidence.viggle.nodes;
  const standing = !why ? evidence : !evidence.seen && same && !unproven(step, row, { ...earlier, ...probe, attentionOption: offered }, torch)
    ? { ...earlier, ...probe, attentionOption: offered } : undefined;
  if (!standing) {
    throw new Refusal(`The server is not ${step === 'reference' ? 'round two\'s' : `round two's for ${step}`} on the ${row} row: ${why}. Start it as `
      + 'docs/action-experiment.md#card-plan says; nothing is drawn');
  }
  const reference = record.evidence[`reference:${row}`];
  if (step !== 'reference') {
    if (!reference || !stepDone(record, 'reference', row)) throw new Refusal(`${step} is compared with the reference's ${row} row: draw the reference on its own server first`);
    const other = otherThanReference(standing, reference);
    if (other) throw new Refusal(`The server differs from the reference's in its ${other} as well as in its torch: one change at a time`);
  }
  if (step === 'closing' && standing.pid === reference?.pid) throw new Refusal('closing is the reference after a restart: start the server again first');
  if (step === 'attention') {
    // Its passes are one server's: a step begun on one torch is not finished on the other.
    const began = record.passes.find(pass => pass.step === 'attention' && pass.row === row);
    if (began && began.pytorch !== standing.pytorch) {
      throw new Refusal(`attention began on the ${row} row's ${began.pytorch} server, and its passes are not mixed with this one's`);
    }
    const host = hostOf(row, standing.pytorch, cu130), hosted = record.evidence[`${host}:${row}`];
    if (!hosted || hosted.pid !== standing.pid || !stepDone(record, host, row)) {
      throw new Refusal(`attention draws on ${host}'s server of the ${row} row once ${host} has drawn, without a restart: this server is not that one`);
    }
    if (row === 'turbo') {
      const base = versus(record, 'attention', 'base');
      if (!base || !((base.sampleRatio.all ?? 1) < 1)) throw new Refusal('attention on the turbo row follows the base row\'s only when its sampler was faster there');
    }
  }
  record.pins = common;
  record.stream = stream.chosen;
  record.evidence[key] = standing;
  const dropAllocator = (value: string | number | undefined) => (typeof value === 'string' ? cardName(value) : value);
  record.differsFromRoundOne = Object.keys(common).filter(name => name in source.pins && dropAllocator(source.pins[name]) !== common[name]);
  mkdirSync(join(dir, 'passes'), { recursive: true, mode: 0o700 });
  const save = () => writeJson(file, record);
  save();
  const samplers = (graph: Graph) => Object.keys(graph).filter(id => /Sampler/.test(graph[id].class_type));
  const context: Context = { dir, source, stream, card, pins, comfy: options.comfy, until: options.until, options, log, record, step, row, lora,
    samplers: { front: samplers(graphOf(FRONT_GRAPH)), frame: samplers(graphOf(ACTION_GRAPH)) } };
  let stopped: string | undefined, skipped: string | undefined, files: number | undefined = standing.files;
  for (const kind of KINDS[step]) {
    const name = passName(step, row, kind);
    if (lastFinished(record, name)) continue;
    if (kind === 'cold' && !evidence.fresh) {
      throw new Refusal(`${name} is drawn right after the server's start, and this server ${evidence.seen ? 'has drawn since' : 'no longer has its start in its log'}: `
        + 'start it again (docs/action-experiment.md#card-plan)');
    }
    if (options.until - Date.now() < NEEDS_MS[kind]) {
      skipped = name;
      record.skipped = [...new Set([...record.skipped ?? [], name])];
      save();
      break;
    }
    let attempt = record.passes.filter(pass => pass.name === name).length + 1;
    while (existsSync(join(dir, 'passes', `${name}-${attempt}`))) attempt++;
    if (attempt > ATTEMPTS) throw new Refusal(`${name} has not finished in ${attempt - 1} attempts: look at them before the card draws it again`);
    const pass = await drawPass(context, kind, attempt);
    const after = await options.probe().then(one => one.files, () => undefined);
    pass.files = { before: files, ...(after === undefined ? {} : { after }) };
    files = after;
    // The kitchen's attention that fell back to PyTorch's, or that drew the plain pictures, is not the step.
    const fell = pass.cells.some(cell => cell.fallback);
    const plain = step === 'attention' && kind === 'warm' && finished(pass) && pass.cells.every(cell => {
      const other = lastFinished(record, passName(comparisonOf(step, standing.pytorch, cu130)!, row, 'warm'))?.cells.find(one => one.cell === cell.cell);
      return !!other?.sha256 && other.sha256 === cell.sha256;
    });
    if (fell || plain) Object.assign(pass, { ended: 'stopped', error: fell ? 'attention_fallback' : 'attention_plain' });
    record.passes.push(pass);
    save();
    log({ event: 'pass', name, attempt, ended: pass.ended, drawn: pass.cells.filter(cell => cell.status === 'drawn').length, wallMs: pass.wallMs,
      tuning: pass.cells.reduce((sum, cell) => sum + (cell.tuning ?? 0), 0), ...(pass.files ? { files: pass.files } : {}), ...(pass.error ? { error: pass.error } : {}) });
    if (!finished(pass)) { stopped = name; break; }
  }
  const comparison = comparisonOf(step, standing.pytorch, cu130);
  if (comparison) record.pairs = { ...record.pairs, [key]: pairsOf(dir, record, step, row, comparison) };
  if (step === 'attention') {
    const again = lastFinished(record, passName('attention', row, 'plain'))?.cells[0];
    const theirs = lastFinished(record, passName(comparison!, row, 'warm'))?.cells.find(one => one.cell === again?.cell);
    if (again?.file && theirs?.file) record.plainAgain = { ...record.plainAgain, [key]: compared(readFileSync(join(dir, again.file)), readFileSync(join(dir, theirs.file))).result };
  }
  save();
  writePage(dir, record);
  const last = stopped ? record.passes.findLast(pass => pass.name === stopped) : undefined;
  const failed = last?.cells.filter(one => one.status === 'failed').map(one => ({ cell: one.cell, code: one.code ?? null }));
  const verdict = comparison && stepDone(record, step, row) ? verdictOf(Object.values(record.pairs?.[key] ?? {})) : undefined;
  return { event: 'levers', step, row, done: !stopped && !skipped, ...(stopped ? { stopped, ...(last?.error ? { error: last.error } : {}) } : {}),
    ...(failed?.length ? { failed } : {}), ...(skipped ? { skipped, reason: 'too little time before --until' } : {}),
    passes: Object.fromEntries(KINDS[step].map(kind => [passName(step, row, kind), lastFinished(record, passName(step, row, kind)) ? 'finished' : 'not finished'])),
    evidence: evidenceSummary(standing), ...(comparison ? { against: comparison } : {}),
    ...(verdict ? { verdict, pairs: Object.keys(record.pairs?.[key] ?? {}).length, needsEye: verdict === 'visible' || verdict === 'unknown' } : {}),
    ...(record.plainAgain?.[key] ? { plainAgain: record.plainAgain[key].pixelsSame === true } : {}),
    page: join(dir, LEVERS_PAGE), differsFromRoundOne: record.differsFromRoundOne };
}

const evidenceSummary = (e: Evidence) => ({ pytorch: e.pytorch, allocator: e.allocator, vramState: e.vramState ?? null, dynamicVram: e.dynamicVram ?? null,
  attention: e.attention ?? null, triton: e.kitchen.backends.triton ?? null, cuda: e.kitchen.backends.cuda ?? null, viggle: e.viggle,
  attentionOption: e.attentionOption, seen: e.seen, pid: e.pid, env: e.env, files: e.files });

// The timed cells in the pilot's order, round one's references as a pass's directory sees them.
const timedCells = (source: Source) => TIMED.map(label => source.cells.find(cell => labelOf(cell) === label)!);
const seededFor = (source: Source, root: string) => Object.fromEntries(source.references.map(key => [key, { ...source.roundOne[key],
  file: relative(root, resolve(source.root, source.roundOne[key].file!)) }]));
const cellPart = (context: Context, cell: ActionCell) => (cell.kind === 'front' ? context.samplers.front : context.samplers.frame);
const labelFor = (cell: ActionCell) => (cell.key.startsWith(STREAM_PREFIX) ? streamLabel(cell) : labelOf(cell));
// Triton's tuning lines among a job's log lines, each a print of the autotuner (python/triton/runtime/autotuner.py:246-248
// in Triton 3.6.0) that ComfyUI's log keeps as it keeps its own (app/logger.py:51-70), with its key's numbers alone, and
// the attention node's fallback (comfy_extras/nodes_model_advanced.py:406-408).
export function tuningOf(lines: string[] | undefined) {
  const entries = (lines ?? []).map(line => line.slice(line.indexOf('\u0000') + 1).replace(/\u001b\[[0-9;]*m/g, ''));
  const tunings = entries.filter(entry => /^(?:\[[A-Z]+\] )?Triton autotuning for function /.test(entry));
  const keys = tunings.map(entry => (/with key as \(([^)]*)\)/.exec(entry)?.[1] ?? '').split(',').map(part => part.trim()).filter(part => /^\d+$/.test(part))
    .slice(0, 3).map(Number));
  return { tuning: tunings.length, keys, fallback: entries.filter(entry => /Attention backend '.*' is unavailable; using PyTorch attention\./.test(entry)).length };
}

// A pass on round two's path (local/action-draw.ts `drawPilot`), any failure ending it: the timed cells, the stream, or
// attention's one plain cell; on the turbo row through Viggle's LoRA, and for attention with the kitchen's attention.
async function drawPass(context: Context, kind: PassKind, attempt: number): Promise<LeverPass> {
  const { dir, source, options, step, row } = context;
  const name = passName(step, row, kind), root = join(dir, 'passes', `${name}-${attempt}`);
  const cells = kind === 'stream' ? context.stream.cells.slice(0, expectedCells(step, 'stream'))
    : kind === 'plain' ? timedCells(source).filter(cell => labelOf(cell) === 'A') : timedCells(source);
  const noded = step === 'attention' && kind !== 'plain';
  const turbo = (filled: Graph) => (row === 'turbo' ? withTurbo(filled, context.lora) : filled);
  const heard = new Map<string, { cycleMs?: number; cached?: string[]; heard: Heard }>();
  const startedAt = new Date().toISOString(), began = performance.now();
  let mark = began, last = -1;
  const drawn = await drawPilot({ root, comfy: context.comfy, until: context.until, checkpoint: context.card.model, pins: context.pins,
    plans: kind === 'stream' ? context.stream.plans : [source.plan], cells, seeded: kind === 'stream' ? {} : seededFor(source, root), roundTwo: true,
    stopAtFailure: true, timeoutMs: options.timeoutMs, waitMs: options.waitMs, pollMs: options.pollMs, outage: options.outage, log: context.log,
    graph: filled => (noded ? withAttention(turbo(filled)) : turbo(filled)), ...(row === 'turbo' ? { recipe: TURBO_RECIPE } : {}),
    observe: (cell, _record, cached, told) => {
      // A cell's cycle is its own only when the cell before it was drawn too; cells are heard in their order.
      const now = performance.now(), at = cells.findIndex(one => one.key === cell.key);
      heard.set(cell.key, { ...(at === last + 1 ? { cycleMs: Math.round(now - mark) } : {}), ...(cached ? { cached } : {}), heard: told });
      mark = now;
      last = at;
    } });
  const out = cells.map((cell, n): LeverCell => {
    const one = drawn.index.cells[cell.key], label = labelFor(cell);
    const base = { cell: label, seed: cell.seed, references: cell.refs.length };
    if (!one) return { ...base, status: 'unsent' };
    if (one.status !== 'drawn' || !one.file) return { ...base, status: one.status, ...(one.code ? { code: one.code } : {}), ...(one.outageMs ? { outageMs: one.outageMs } : {}) };
    const told = heard.get(cell.key), stamps = told?.heard.stamps, before = n > 0 ? heard.get(cells[n - 1].key)?.heard.stamps : undefined;
    const tuned = told?.heard.logged ? tuningOf(told.heard.logged) : undefined, device = one.vram?.[0];
    return { ...base, status: 'drawn', ...(told?.cycleMs === undefined ? {} : { cycleMs: told.cycleMs }), totalMs: one.totalMs, viewMs: one.viewMs,
      ...(one.outageMs ? { outageMs: one.outageMs } : {}), ...(one.phases ? { phases: one.phases } : {}),
      ...(told?.cached ? { samplerCached: cellPart(context, cell).some(id => told.cached!.includes(id)) } : {}),
      file: relative(dir, join(root, one.file)), sha256: one.sha256,
      ...(device ? { vramMiB: device.occupiedMiBMax ?? device.usedMiBMax } : {}), ...(one.ramMiB ? { ramMiB: one.ramMiB.max } : {}),
      ...(stamps ? { jobMs: stamps.end - stamps.start } : {}), ...(stamps && before ? { gapMs: stamps.start - before.end } : {}),
      ...(tuned ? { tuning: tuned.tuning, keys: tuned.keys, fallback: tuned.fallback, ...(told?.heard.whole === false ? { tuningFloor: true as const } : {}) } : {}) };
  });
  return { name, step, row, kind, attempt, dir: relative(dir, root), pytorch: String(context.pins.pytorch ?? ''), startedAt,
    completedAt: new Date().toISOString(), ended: drawn.ended, ...(drawn.index.error ? { error: drawn.index.error } : {}),
    wallMs: Math.round(performance.now() - began), cells: out };
}

// A step's pictures against its comparison step's of the same prompt and seed, with the difference picture where the
// pixels differ: the warm cells against the warm ones (closing's cold ones, since closing draws no warm pass), and the
// stream's frames against the stream's.
function pairsOf(dir: string, record: LeverRecord, step: Step, row: Row, comparison: Step): Record<string, Compared> {
  const pairs: Record<string, Compared> = {};
  const mine = (kind: PassKind) => lastFinished(record, passName(step, row, kind));
  for (const [kind, theirs] of [[step === 'closing' ? 'cold' : 'warm', 'warm'], ['stream', 'stream']] as [PassKind, PassKind][]) {
    const pass = mine(kind), other = lastFinished(record, passName(comparison, row, theirs));
    for (const cell of pass?.cells ?? []) {
      const against = other?.cells.find(one => one.cell === cell.cell && one.file);
      if (!cell.file || !against) continue;
      const seen = compared(readFileSync(join(dir, cell.file)), readFileSync(join(dir, against.file!)), true);
      if (seen.diff) {
        const diff = join('diff', `${step}-${row}-${cell.cell.replace(/[^A-Za-z0-9+_-]/g, '_')}.png`);
        mkdirSync(join(dir, 'diff'), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, diff), seen.diff, { mode: 0o600 });
        seen.result.diff = diff;
      }
      pairs[cell.cell] = seen.result;
    }
  }
  return pairs;
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
const ratio = (top: number | null | undefined, bottom: number | null | undefined) => (top === undefined || top === null || !bottom ? null : Number((top / bottom).toFixed(3)));
const perHour = (count: number, ms: number | undefined) => (!ms ? null : Number((count * 3600000 / ms).toFixed(1)));
const peak = (values: (number | undefined)[]) => (known(values).length ? Math.max(...known(values)) : null);
const byCell = (cells: LeverCell[], value: (cell: LeverCell) => number | null | undefined) => Object.fromEntries(cells.map(cell => [cell.cell, value(cell) ?? null]));

// The stream's jobs at one seed: pictures an hour from the server's stamps, each job costing its time and the gap
// before it (the first job of the pass, which has none, the mean gap of the others), and from our cycles; the tuning
// lines and whether any count is a floor.
function streamPart(pass: LeverPass, seed: number) {
  const cells = pass.cells.filter(cell => cell.seed === seed), gaps = known(pass.cells.slice(1).map(cell => cell.gapMs)), meanGap = mean(gaps);
  const cost = (cell: LeverCell) => (cell.jobMs === undefined ? undefined : cell.jobMs + (cell.gapMs ?? meanGap ?? 0));
  return { jobs: cells.length, picturesPerHour: perHour(cells.length, sum(cells.map(cost))), cyclePicturesPerHour: perHour(cells.length, sum(cells.map(cell => cell.cycleMs))),
    jobMs: whole(mean(cells.map(cell => cell.jobMs))), sampleMs: whole(mean(cells.map(cell => cell.phases?.sampleMs))),
    meanGapMs: whole(mean(cells.map(cell => cell.gapMs))), tuning: cells.reduce((total, cell) => total + (cell.tuning ?? 0), 0),
    tunedJobs: cells.filter(cell => (cell.tuning ?? 0) > 0).length, tuningFloor: cells.some(cell => cell.tuningFloor) };
}
// One step on one row: whether its passes finished and how the last attempt of each that did not ended, what proved it,
// its timed cells' seconds by phase, the stream's pictures an hour for new lengths and known ones, Triton's tunings and
// files by pass, and its peaks of video memory.
function stepSummary(record: LeverRecord, step: Step, row: Row) {
  const pass = (kind: PassKind) => lastFinished(record, passName(step, row, kind));
  const unfinished = (kind: PassKind) => {
    const name = passName(step, row, kind), tries = record.passes.filter(one => one.name === name), last = tries.at(-1);
    return { attempts: tries.length, ...(last ? { ended: last.ended, ...(last.error ? { error: last.error } : {}) } : {}),
      ...(record.skipped?.includes(name) ? { skipped: 'too little time before --until' } : {}) };
  };
  const timed = pass(step === 'closing' ? 'cold' : 'warm'), cold = pass('cold'), stream = pass('stream');
  const phase = (key: keyof Phases) => byCell(timed?.cells ?? [], cell => whole(cell.phases?.[key]));
  const evidence = record.evidence[`${step}:${row}`];
  return { finished: Object.fromEntries(KINDS[step].map(kind => [kind, pass(kind) ? true : unfinished(kind)])),
    evidence: evidence ? evidenceSummary(evidence) : null,
    timed: timed ? { pass: timed.kind, comparable: uncached(timed), totalMs: byCell(timed.cells, cell => cell.totalMs), sampleMs: phase('sampleMs'),
      encodeMs: phase('encodeMs'), decodeMs: phase('decodeMs'), cycleMs: byCell(timed.cells, cell => cell.cycleMs),
      picturesPerHour: perHour(timed.cells.length, sum(timed.cells.map(cell => cell.cycleMs))) } : null,
    coldExtraMs: cold && step !== 'closing' && pass('warm') ? whole((sum(cold.cells.map(cell => cell.cycleMs)) ?? NaN) - (sum(pass('warm')!.cells.map(cell => cell.cycleMs)) ?? NaN)) : null,
    stream: stream ? { comparable: uncached(stream), fresh: streamPart(stream, STREAM_SEEDS[0]), ...(step === 'closing' ? {} : { known: streamPart(stream, STREAM_SEEDS[1]) }) } : null,
    tuning: Object.fromEntries(KINDS[step].map(kind => [kind, pass(kind) ? { lines: pass(kind)!.cells.reduce((total, cell) => total + (cell.tuning ?? 0), 0),
      floor: pass(kind)!.cells.some(cell => cell.tuningFloor), filesBefore: pass(kind)!.files?.before ?? null, filesAfter: pass(kind)!.files?.after ?? null } : null])),
    vramMiB: Object.fromEntries(KINDS[step].map(kind => [kind, peak(pass(kind)?.cells.map(cell => cell.vramMiB) ?? [])])) };
}
// A step against its comparison step on the same row: its verdict on the pairs, and its times as ratios of the other's
// (below 1 the faster), its pictures an hour as ratios (above 1 the more).
function versus(record: LeverRecord, step: Step, row: Row) {
  const evidence = record.evidence[`${step}:${row}`];
  const comparison = evidence && comparisonOf(step, evidence.pytorch, record.evidence[`cu130:${row}`]?.pytorch ?? '\u0000');
  if (!comparison || !stepDone(record, step, row) || !stepDone(record, comparison, row)) return null;
  const mine = stepSummary(record, step, row), theirs = stepSummary(record, comparison, row);
  const cells = (one: Step, kind: PassKind) => lastFinished(record, passName(one, row, kind))?.cells ?? [];
  const timedKind: PassKind = step === 'closing' ? 'cold' : 'warm';
  const pairs = [...cells(step, timedKind).map(cell => [cell, cells(comparison, 'warm').find(one => one.cell === cell.cell)] as const),
    ...cells(step, 'stream').map(cell => [cell, cells(comparison, 'stream').find(one => one.cell === cell.cell)] as const)];
  const total = (pick: (cell: LeverCell) => number | undefined) => ratio(sum(pairs.map(([cell]) => pick(cell))), sum(pairs.map(([, other]) => other && pick(other))));
  const verdict = verdictOf(Object.values(record.pairs?.[`${step}:${row}`] ?? {}));
  return { against: comparison, verdict, pairs: Object.keys(record.pairs?.[`${step}:${row}`] ?? {}).length, needsEye: verdict === 'visible' || verdict === 'unknown',
    ...(record.plainAgain?.[`${step}:${row}`] ? { plainAgain: record.plainAgain[`${step}:${row}`].pixelsSame === true } : {}),
    sampleRatio: { all: total(cell => cell.phases?.sampleMs) }, jobRatio: { all: total(cell => cell.jobMs) },
    picturesPerHourRatio: { path: ratio(mine.timed?.picturesPerHour, theirs.timed?.picturesPerHour),
      streamFresh: ratio(mine.stream?.fresh.picturesPerHour, theirs.stream?.fresh.picturesPerHour),
      streamKnown: ratio(mine.stream?.known?.picturesPerHour, theirs.stream?.known?.picturesPerHour) },
    pixels: Object.fromEntries(Object.entries(record.pairs?.[`${step}:${row}`] ?? {}).map(([cell, one]) => [cell,
      { off3Percent: one.off3Share === undefined ? null : Number((one.off3Share * 100).toFixed(2)), psnr: one.psnr ?? null, pixelsSame: one.pixelsSame ?? null }])) };
}
// What the passes measured, by row: the reference, then each step with its verdict and its ratios.
export function leversReport(dir: string) {
  const record = readJson<LeverRecord>(join(resolve(dir), RECORD));
  if (!record) throw new Refusal(`No ${RECORD} in ${dir}: a step's command writes it`);
  const rows = Object.fromEntries(ROWS.filter(row => record.passes.some(pass => pass.row === row)).map(row => [row, Object.fromEntries(STEPS
    .filter(step => record.passes.some(pass => pass.step === step && pass.row === row))
    .map(step => [step, { ...stepSummary(record, step, row), vs: versus(record, step, row) }]))]));
  return { event: 'levers_report', stream: record.stream ?? [], differsFromRoundOne: record.differsFromRoundOne ?? [], rows,
    page: existsSync(join(resolve(dir), LEVERS_PAGE)) ? LEVERS_PAGE : null };
}

// ---- The page ----

// Each step's pictures beside its comparison step's of the same prompt and seed, with their difference eight times as
// bright, for the owner's eye: a `visible` step is kept only once the owner has looked. The paths are relative, so
// that the page opens from the directory, and it carries labels, seconds and pixel counts, never a prompt or a word of
// a story.
const STEP_WORDS: Record<Step, string> = {
  reference: 'эталон: сервер раунда два, cu128 и Triton, со счётом тюнинга',
  cu130: 'torch для CUDA 13 (cu130): int8-умножения на CUDA-бэкенде кухни, без тюнинга Triton',
  attention: 'INT8-внимание кухни через узел ModelAttentionBackend, на том же сервере',
  closing: 'эталон после перезапуска, с кэшем тюнинга Triton от эталона',
};
const VERDICT_WORDS: Record<Verdict, string> = {
  identical: 'те же пиксели',
  rounding: `округление: не больше того, что дал переход на Triton (до ${(ROUNDING.off3Share * 100).toFixed(1)} % пикселей с разницей больше 3 %, `
    + `не меньше ${ROUNDING.psnr} дБ)`,
  visible: 'видно глазом: больше округления, оставлять только после взгляда владельца',
  unknown: 'не сравнить: клетка не нарисована или не читается, нужен взгляд владельца',
};
function writePage(dir: string, record: LeverRecord) {
  const seconds = (ms: number | undefined) => (ms === undefined ? 'нет' : `${(ms / 1000).toFixed(1)} с`);
  const ratioWords = (value: number | null | undefined) => (value === null || value === undefined ? 'нет' : `${value.toFixed(2)}×`);
  const figure = (path: string | undefined, caption: string, missing: string) => {
    const src = path && existsSync(path) ? escapeHtml(relative(dir, path).split(sep).join('/')) : undefined;
    return `<figure>${src ? `<a href="${src}"><img src="${src}" loading="lazy" alt=""></a>` : `<div class="box">${escapeHtml(missing)}</div>`}`
      + `<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  const steps = String(Object.values(graphOf(ACTION_GRAPH)).find(node => node.class_type === 'KSampler')?.inputs.steps ?? '?');
  const rowWords: Record<Row, string> = { base: `основа, ${steps} шагов, как рисует раунд два`, turbo: `турбо: LoRA Viggle, ${TURBO_RECIPE.steps} шагов` };
  const rows = ROWS.flatMap(row => {
    const shown = STEPS.filter(step => step !== 'reference' && record.passes.some(pass => pass.step === step && pass.row === row));
    if (!shown.length && !record.passes.some(pass => pass.row === row)) return [];
    const sections = shown.map(step => {
      const against = versus(record, step, row), pairs = record.pairs?.[`${step}:${row}`] ?? {};
      const comparison = against?.against ?? 'reference';
      const mine = (kind: PassKind) => lastFinished(record, passName(step, row, kind)) ?? record.passes.findLast(pass => pass.name === passName(step, row, kind));
      const theirs = (kind: PassKind) => lastFinished(record, passName(comparison, row, kind));
      const cells = [...(mine(step === 'closing' ? 'cold' : 'warm')?.cells.map(cell => [cell, theirs('warm')?.cells.find(one => one.cell === cell.cell)] as const) ?? []),
        ...(mine('stream')?.cells.map(cell => [cell, theirs('stream')?.cells.find(one => one.cell === cell.cell)] as const) ?? [])];
      const figures = cells.map(([cell, other]) => {
        const seen = pairs[cell.cell];
        const diff = !seen ? figure(undefined, 'разница', 'не сравнить') : seen.pixelsSame ? figure(undefined, 'разница', 'пиксели те же')
          : figure(seen.diff ? join(dir, seen.diff) : undefined, `разница ×8, чёрное совпадает: ${((seen.off3Share ?? 0) * 100).toFixed(2)} % пикселей `
            + `с разницей больше 3 %, ${seen.psnr ?? 'нет'} дБ`, 'не сравнить');
        const label = CELL_WORDS[cell.cell] ? `${cell.cell}: ${CELL_WORDS[cell.cell]}` : `${cell.cell}: кадр без портретов из потока`;
        return `<h4>${escapeHtml(label)}</h4><div class="row">`
          + figure(other?.file ? join(dir, other.file) : undefined, `${comparison}: ${seconds(other?.totalMs)}, сэмплер ${seconds(other?.phases?.sampleMs)}`, 'не нарисована')
          + figure(cell.file ? join(dir, cell.file) : undefined, `${step}: ${seconds(cell.totalMs)}, сэмплер ${seconds(cell.phases?.sampleMs)}`,
            cell.status === 'failed' ? `не вышла: ${cell.code ?? 'без кода'}` : 'не нарисована')
          + diff + '</div>';
      });
      const verdict = against?.verdict ?? 'unknown';
      return `<section><h3>${escapeHtml(STEP_WORDS[step])}</h3><p><b>${escapeHtml(VERDICT_WORDS[verdict])}.</b> `
        + `${escapeHtml(`Против шага ${comparison}, пар ${Object.keys(pairs).length}. Сэмплер: ${ratioWords(against?.sampleRatio.all)}; картинок в час на пути `
          + `раунда два: ${ratioWords(against?.picturesPerHourRatio.path)}, в потоке: ${ratioWords(against?.picturesPerHourRatio.streamFresh)} с новыми длинами и `
          + `${ratioWords(against?.picturesPerHourRatio.streamKnown)} со знакомыми.`)}</p>${figures.join('')}</section>`;
    });
    return [`<h2>${escapeHtml(rowWords[row])}</h2>` + (sections.length ? sections.join('\n') : '<p>В этом ряду нарисован только эталон.</p>')];
  });
  writeFileSync(join(dir, LEVERS_PAGE), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Скорость картиночного сервера: каждый шаг против своего эталона</title>
<style>body{font-family:sans-serif;margin:8px;line-height:1.4}.row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}figure{margin:0;
width:calc((100% - 16px) / 3)}img{width:100%;max-height:85vh;object-fit:contain;display:block}.box{display:flex;align-items:center;
justify-content:center;text-align:center;aspect-ratio:16/9;background:#eee;font-size:14px}@media (max-width:640px){figure{width:100%}}</style>
<h1>Скорость картиночного сервера: каждый шаг против своего эталона</h1>
<p>Пять клеток пилота и поток из восьми кадров первого раунда при сидах 7 и 11, на одной карте. Слева картинка эталона шага, посередине та же
картинка после перемены: тот же граф, тот же промпт и тот же сид. Справа их разница, усиленная в восемь раз: чёрное совпадает. «Округление» не больше
того, что дал переход на Triton; «видно глазом» оставляют только после взгляда владельца. Каждый ряд сравнивается со своим эталоном.</p>
${rows.join('\n')}
`, { mode: 0o600 });
}

// ---- The dry run ----

// The lines of a server's start as the pinned code logs them: the vram state, the card with its allocator, PyTorch's
// attention, comfy-kitchen's backends as the card logged them on 2026-09-26 (image-pilot.ts `kitchenLines`, whose
// cu130 lines no card has shown yet), dynamic VRAM, and the VAE's attention, which is not the model's.
const startLines = (torch: 'cu128' | 'cu130') => ['Set vram state to: NORMAL_VRAM', 'Device: cuda:0 fake card : cudaMallocAsync', 'Using pytorch attention',
  ...kitchenLines(true, torch), 'DynamicVRAM support detected and enabled', 'Using pytorch attention in VAE'];
// A line as the pinned server's logger writes it into its log (app/logger.py `ColoredFormatter`).
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
  const probe = parseProbe(['servers 1', 'pid 4242', ...VARIABLES.map((name, at) => `env ${name} ${at < 2 ? 1 : 0} ${at < 2 ? 1 : 0}`), 'files 12'].join('\n'));
  if (probe?.pid !== 4242 || probe.files !== 12 || probe.env.TRITON_CACHE_AUTOTUNING.on !== 1 || parseProbe('pid 1\nservers 1') !== undefined) missed.push('probe');
  return missed;
}

// Round one's frames for the stream, made up beside the made-up flight: ten clean stories with an A, an A+ and an L each
// at 1280x704, no reference and a conditioning length of its own, one of them the length of flight's A, drawn and
// recorded as round one records them, `word` in every prompt.
function madeUpStream(root: string, word: string) {
  const file = join(root, 'draw.json'), index = readJson<DrawIndex>(file)!;
  const flightA = Object.values(index.cells).find(one => one.story === PILOT_STORY && one.arm === 'A' && one.seed === PILOT_SEED)!;
  for (let at = 0; at < 10; at++) {
    const id = `made-up-${at}`, arms: StoryPlan['arms'] = {};
    for (const [n, arm] of (['A', 'A+', 'L'] as const).entries()) {
      const prompt = `A made-up frame ${at} ${arm} at ${word}${' and more'.repeat(at * 3 + n)}.`;
      arms[arm] = { prompt, references: [] };
      const key = frameKey(id, PILOT_SEED, arm), picture = join(root, 'clean', id, `${key.replace(/[^A-Za-z0-9+_-]/g, '_')}.png`);
      mkdirSync(join(root, 'clean', id), { recursive: true, mode: 0o700 });
      const bytes = encodePng(4, 4, new Uint8Array(48).fill(at * 20 + n), 3);
      writeFileSync(picture, bytes);
      index.cells[key] = { key, kind: 'frame', story: id, id: `${id}-s${PILOT_SEED}-${arm}`, seed: PILOT_SEED, arm, status: 'drawn', file: relative(root, picture),
        sha256: sha256(bytes), width: FRAME_CANVAS.width, height: FRAME_CANVAS.height, references: 0, referenceSizes: [], promptChars: prompt.length,
        conditioningTokens: at === 0 && n === 0 ? flightA.conditioningTokens ?? 300 : 200 + at * 30 + n * 7 };
    }
    writeFileSync(join(root, 'clean', id, 'plan.json'), JSON.stringify({ id, arms, out: {}, vIsC: false, portraits: [], views: [], counts: {} }));
  }
  if (flightA.conditioningTokens === undefined) index.cells[flightA.key] = { ...flightA, conditioningTokens: 300 };
  writeFileSync(file, JSON.stringify(index));
}

// Every command against local/fake-comfy.ts: a made-up round one drawn by the action run's own smoke, with made-up
// frames for the stream; the reference on a server started as round two's with Triton's two switches, which tunes each
// length it meets once and keeps the tunings in a cache that outlives it; cu130 on a server that tunes nothing and draws
// a little otherwise (rounding); attention on cu130's server, its node falling back once and then drawing otherwise
// (visible), faster; closing on a server started again with the reference's cache, which tunes nothing and draws the
// reference's pictures; then the turbo row's reference, cu130 and attention on servers with Viggle's two nodes, one of
// its passes skipped once for too little time. Then `report` and the page. On the way, the refusals the paid
// measurement relies on, and at the end the search for the scene's made-up word in everything it wrote and printed.
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
  const manifest = readManifest(MANIFEST);
  const viggleInfo = { ViggleTurboLora: { input: { required: { model: ['MODEL'], lora_name: [[manifest.IMAGE_VIGGLE_LORA_FILE], {}], strength: ['FLOAT', {}] } } },
    ViggleTurboSigmas: { input: { required: { latent: ['LATENT'], nodes: ['STRING', { default: VIGGLE.nodes }] } } } };
  const attentionInfo = (offered: boolean) => ({ [ATTENTION_NODE]: { input: { required: { model: ['MODEL', {}],
    attention: ['COMBO', { options: ['pytorch attention', ...(offered ? [KITCHEN_ATTENTION] : [])] }] } } } });
  // The card: its cache of tunings, which outlives a server, and the server's process and environment as ssh counts them.
  const cache = new Set<string>();
  let pid = 100, env: Record<Variable, number> = { ...ENVIRONMENT.base }, servers = 1, reachable = true;
  const probe: Prober = async () => {
    if (!reachable) throw new Refusal('The card did not give its counts over ssh (made up): nothing is drawn without them');
    return { servers, pid, env: Object.fromEntries(VARIABLES.map(name => [name, { set: env[name], on: env[name] }])) as EnvCounts, files: cache.size };
  };
  let fake = await startFakeComfy({ ...started, startupLog: kitchenLines(false) });
  // A server started as the runbook's restart starts it: round two's, with `torch`, with Viggle's nodes on the turbo
  // row, the row's variables in its environment, a new process, and any knob of the fake over these.
  const serve = async (torch: 'cu128' | 'cu130', row: Row, more: FakeComfyOptions & { variables?: Record<Variable, number>; flags?: string[] } = {}) => {
    const { variables, flags, startupLog, ...knobs } = more;
    await fake.close();
    pid++;
    env = variables ?? { ...ENVIRONMENT[row] };
    fake = await startFakeComfy({ ...started, pytorch: manifest[torch === 'cu130' ? 'TORCH_CU130_VERSION' : 'TORCH_VERSION'], card: 'cuda:0 fake card : cudaMallocAsync',
      argv: [...SERVE_ARGV, ...(row === 'turbo' ? ['--whitelist-custom-nodes', manifest.IMAGE_VIGGLE_NODE_FILE] : []), ...(flags ?? [])],
      startupLog: (startupLog ?? startLines(torch)).map(asLogged), objectInfo: { ...(row === 'turbo' ? viggleInfo : {}), ...attentionInfo(true) },
      autotune: { tunes: torch === 'cu128', print: env.TRITON_PRINT_AUTOTUNING > 0, ...(env.TRITON_CACHE_AUTOTUNING ? { files: cache } : {}) }, ...knobs });
  };
  const measure = (step: Step, end = until, at = dir) => leverCommand(step, { dir: at, source, comfy: fake.url, until: end, probe, pollMs: 10,
    waitMs: 20000, timeoutMs: 10000 });
  const record = () => readJson<LeverRecord>(join(dir, RECORD))!;
  const passOf = (step: Step, row: Row, kind: PassKind) => lastFinished(record(), passName(step, row, kind));
  const lines = (step: Step, row: Row, kind: PassKind) => passOf(step, row, kind)?.cells.map(cell => cell.tuning ?? -1) ?? [];
  try {
    say(`the throughput measurement's dry run in ${dry}: a made-up round one and local/fake-comfy.ts; no card, no network`);
    const metric = metricMisses();
    say(`0 the metric on pictures made here and the card's counts: ${metric.length ? `wrong in ${metric.join(', ')}` : 'as ImageMagick counts, and as ssh prints them'}`);
    expect(!metric.length, 'the metric counts as ImageMagick\'s compare does, and the counts parse');
    madeUpRoundOne(source, word);
    const smoke = await drawStage({ stage: 'smoke', root: source, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
    say(`1 round one: the smoke drew ${Object.values(smoke.cells).filter(one => one.status === 'drawn').length} cells of ${PILOT_STORY}, pass ${smoke.smoke?.verdict?.pass}`);
    expect(smoke.smoke?.verdict?.pass === true, 'round one\'s smoke passes');
    madeUpStream(source, word);
    const chosen = chooseStream(readSource(source));
    say(`   the stream: ${chosen.chosen.map(one => `${one.story} ${one.arm} ${one.conditioningTokens}`).join(', ')} of ${chosen.candidates} lengths`);
    expect(chosen.cells.length === 16 && new Set(chosen.chosen.map(one => one.conditioningTokens)).size === 8 && chosen.candidates === 29
      && !chosen.chosen.some(one => one.story === 'made-up-0' && one.arm === 'A'), 'the stream takes eight lengths of their own, none a timed cell\'s');
    writeCardRecord(join(dir, 'card.txt'));
    const pilot = join(dry, 'pilot');
    mkdirSync(pilot, { recursive: true, mode: 0o700 });
    writeFileSync(join(pilot, 'pilot.json'), '{}');
    writeCardRecord(join(pilot, 'card.txt'));

    await serve('cu130', 'base');
    await refused('cu130 before the reference', () => measure('cu130'));
    await refused('the pilot\'s directory', () => measure('cu130', until, pilot));
    await refused('a directory inside round one\'s', () => measure('cu130', until, join(source, 'levers')));
    await serve('cu128', 'base', { variables: { ...ENVIRONMENT.base, TRITON_CACHE_AUTOTUNING: 0 } });
    await refused('the reference without Triton\'s cache switch', () => measure('reference'));
    await serve('cu128', 'base', { flags: ['--highvram'] });
    await refused('the reference with a flag gpu/image-serve.sh does not add', () => measure('reference'));
    await serve('cu128', 'base', { startupLog: startLines('cu130'), pytorch: manifest.TORCH_CU130_VERSION });
    await refused('the reference on the cu130 torch', () => measure('reference'));
    await serve('cu128', 'base');
    servers = 2;
    await refused('two servers on the card', () => measure('reference'));
    servers = 1;
    reachable = false;
    await refused('a card that does not answer over ssh', () => measure('reference'));
    reachable = true;
    expect(fake.jobs.length === 0 && cache.size === 0, 'nothing is drawn on a server that is refused');

    say('   the server started as round two\'s with TRITON_PRINT_AUTOTUNING=1 TRITON_CACHE_AUTOTUNING=1');
    const reference = await measure('reference');
    say(`2 reference: ${JSON.stringify(reference)}`);
    const stream = passOf('reference', 'base', 'stream');
    expect(reference.done && KINDS.reference.every(kind => passOf('reference', 'base', kind)) && fake.jobs.length === 26
      && fake.jobs.every(job => job.sampler === 'KSampler' && job.outcome === 'success'), 'the reference draws its 26 jobs, cold, warm and the stream');
    const tuned = lines('reference', 'base', 'stream');
    expect(lines('reference', 'base', 'cold').every(count => count > 0) && lines('reference', 'base', 'warm').every(count => count === 0)
      && tuned.slice(0, 8).every(count => count === 2) && tuned.slice(8).every(count => count === 0), 'each new length tunes, once, and a known one does not');
    expect(stream?.files?.after === stream?.files?.before! + 16 && cache.size === 26, 'Triton\'s cache holds a file for each tuning, counted over ssh');
    expect(stream?.cells.every(cell => cell.jobMs !== undefined && cell.samplerCached === false && cell.sha256) === true
      && stream.cells.slice(1).every(cell => cell.gapMs !== undefined), 'every job of the stream is stamped by the server');
    expect(passOf('reference', 'base', 'warm')?.cells.every((cell, at) => cell.sha256 === passOf('reference', 'base', 'cold')?.cells[at].sha256) === true,
      'the warm pass draws the cold pass\'s pictures');
    const jobs = fake.jobs.length;
    await measure('reference');
    expect(fake.jobs.length === jobs, 'a finished step draws nothing again');
    await refused('closing on the reference\'s server, without a restart', () => measure('closing'));

    await serve('cu130', 'base', { startupLog: startLines('cu128') });
    await refused('cu130 on a server whose log shows the CUDA backend off', () => measure('cu130'));
    await serve('cu130', 'base', { shift: { every: 50, delta: 9 }, jobMs: 30 });
    const cuda = await measure('cu130');
    say(`3 cu130: ${JSON.stringify(cuda)}`);
    expect(cuda.done && cuda.verdict === 'rounding' && cuda.pairs === 21 && passOf('cu130', 'base', 'warm')?.pytorch === manifest.TORCH_CU130_VERSION
      && [...lines('cu130', 'base', 'cold'), ...lines('cu130', 'base', 'stream')].every(count => count === 0), 'cu130 draws on its torch, tunes nothing, and its 21 pairs round');

    fake.options.objectInfo = attentionInfo(false);
    await refused('attention where the node does not offer the kitchen\'s', () => measure('attention'));
    fake.options.objectInfo = attentionInfo(true);
    fake.options.attentionFallback = true;
    const fell = await measure('attention');
    say(`   attention falling back to PyTorch's: ${JSON.stringify(fell)}`);
    expect(!fell.done && fell.error === 'attention_fallback', 'attention that falls back ends its pass');
    fake.options.attentionFallback = false;
    fake.options.attentionJobMs = 5;
    const attention = await measure('attention');
    say(`4 attention on cu130's server: ${JSON.stringify(attention)}`);
    const attentionJobs = fake.jobs.filter(job => job.model[0] === ATTENTION_NODE).length;
    expect(attention.done && attention.verdict === 'visible' && attention.needsEye === true && attention.pairs === 21 && attention.against === 'cu130'
      && attention.plainAgain === true && attentionJobs === 26, 'attention draws with the node, visibly, and the plain cell after it is cu130\'s again');
    const again = fake.jobs.length;
    await measure('attention');
    expect(fake.jobs.length === again, 'attention draws once');

    await serve('cu128', 'base');
    say('   the server started again as the reference\'s, its cache of tunings kept');
    const closing = await measure('closing');
    say(`5 closing: ${JSON.stringify(closing)}`);
    expect(closing.done && closing.verdict === 'identical' && closing.pairs === 13 && [...lines('closing', 'base', 'cold'), ...lines('closing', 'base', 'stream')]
      .every(count => count === 0) && passOf('closing', 'base', 'stream')?.files?.after === 26, 'closing reads the tunings back and draws the reference\'s pictures');
    const twice = await measure('attention');
    expect(twice.done && twice.drawn === 0, 'attention does not draw again on closing\'s server once it drew on cu130\'s');

    await serve('cu128', 'turbo', { objectInfo: { ViggleTurboSigmas: viggleInfo.ViggleTurboSigmas, ...attentionInfo(true) } });
    await refused('a server with one of Viggle\'s nodes', () => measure('reference'));
    await serve('cu128', 'turbo', { variables: ENVIRONMENT.base });
    await refused('the turbo row with the cache switch on', () => measure('reference'));
    await serve('cu128', 'turbo');
    const turbo = await measure('reference');
    say(`6 reference, turbo row: ${JSON.stringify(turbo)}`);
    const paths = fake.jobs.map(job => job.model.join(' < '));
    expect(turbo.done && turbo.row === 'turbo' && fake.jobs.length === 26 && fake.jobs.every(job => job.sampler === 'SamplerCustomAdvanced')
      && paths.every(one => one.startsWith('ViggleTurboLora') || one.startsWith('QwenImage21Cache < ViggleTurboLora'))
      && lines('reference', 'turbo', 'stream').slice(0, 8).every(count => count === 2) && cache.size === 26, 'the turbo row samples through the LoRA and tunes afresh, keeping nothing');
    await serve('cu130', 'turbo', { shift: { every: 50, delta: 9 }, jobMs: 30 });
    const late = await measure('cu130', Date.now() + 3 * 60000);
    say(`   cu130 on the turbo row three minutes before --until: ${JSON.stringify(late)}`);
    expect(!late.done && late.skipped === 'cu130-turbo-cold' && fake.jobs.length === 0, 'a pass with too little time left is skipped and draws nothing');
    const turboCuda = await measure('cu130');
    expect(turboCuda.done && turboCuda.verdict === 'rounding' && turboCuda.row === 'turbo', 'cu130 on the turbo row is compared with the turbo row\'s reference');
    fake.options.attentionJobMs = 5;
    const turboAttention = await measure('attention');
    expect(turboAttention.done && turboAttention.verdict === 'visible' && turboAttention.against === 'cu130', 'attention on the turbo row after the base\'s was faster');

    const report = leversReport(dir), base = report.rows.base, fast = report.rows.turbo;
    say(`7 report: ${JSON.stringify(report)}`);
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
    expect(!!base && !!fast && number(base.reference.timed?.picturesPerHour) && number(base.reference.stream?.fresh.picturesPerHour)
      && number(base.reference.stream?.known?.picturesPerHour) && base.reference.stream?.fresh.tunedJobs === 8 && base.reference.stream.known?.tuning === 0
      && number(base.reference.coldExtraMs) && number(fast.reference.stream?.fresh.picturesPerHour), 'the report has the reference\'s numbers on both rows');
    const verdicts = Object.fromEntries(Object.entries(base ?? {}).map(([step, one]) => [step, one.vs?.verdict ?? null]));
    expect(JSON.stringify(verdicts) === JSON.stringify({ reference: null, cu130: 'rounding', attention: 'visible', closing: 'identical' })
      && fast?.cu130?.vs?.verdict === 'rounding' && number(base?.cu130?.vs?.picturesPerHourRatio.streamFresh) && (base?.attention?.vs?.sampleRatio.all ?? 1) < 1,
    'the report has each step\'s verdict and ratios');
    const page = existsSync(join(dir, LEVERS_PAGE)) ? readFileSync(join(dir, LEVERS_PAGE), 'utf8') : '';
    const sources = [...page.matchAll(/src="([^"]+)"/g)].map(match => match[1]);
    const diffs = existsSync(join(dir, 'diff')) ? readdirSync(join(dir, 'diff')).length : 0;
    expect((page.match(/<section>/g) ?? []).length === 5 && diffs === 4 * 21 && sources.length === 2 * (4 * 21 + 13) + diffs
      && sources.every(one => existsSync(join(dir, one))), 'the page puts each step\'s pictures beside its comparison\'s, with their difference');
    // The word is in round one's plans, which the measurement read; it must be nowhere it wrote or printed.
    const forms = markerForms(word);
    const found = searchTree(dir, forms), inRoundOne = searchTree(source, forms).hits.length;
    const printed = forms.some(form => Buffer.from(output.text(), 'utf8').includes(form));
    const sealed = readdirSync(dry, { recursive: true, withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name === 'sealed').length;
    say(`8 boundary: ${found.files} files in the measurement's directory, ${found.unread.length} unread, ${found.hits.length} with the word, which round `
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

const USAGE = 'Use: image-levers.ts reference|cu130|attention|closing --until <epoch seconds, five minutes before the card\'s end> [--dir illustrations/levers] '
  + '[--from illustrations/action-1] [--ssh simple-chat-vast] [--wait 600] [--timeout 60] [--comfy http://127.0.0.1:8188], stream [--from], report [--dir], '
  + 'or dry-run [--dir] (docs/action-experiment.md#card-plan)';
async function main(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    dir: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' }, comfy: { type: 'string', default: 'http://127.0.0.1:8188' },
    wait: { type: 'string', default: '600' }, timeout: { type: 'string', default: '60' }, ssh: { type: 'string', default: 'simple-chat-vast' },
  } });
  const command = positionals[0] ?? '';
  if (command === 'dry-run') {
    const result = await leversDryRun(values.dir ?? mkdtempSync(join(tmpdir(), 'simple-chat-levers-dry-')));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  const dir = resolve(values.dir ?? LEVERS_DIR);
  if (command === 'report') return print(leversReport(dir));
  if (command === 'stream') {
    const chosen = chooseStream(readSource(resolve(values.from ?? SOURCE_DIR)));
    return print({ event: 'levers_stream', chosen: chosen.chosen, candidates: chosen.candidates, jobs: chosen.cells.length });
  }
  if (!isStep(command)) throw new Refusal(USAGE);
  // `--until` as the action run takes it: the end of the work in epoch seconds, five minutes before the card's end.
  const until = Number(values.until) * 1000, wait = Number(values.wait), timeout = Number(values.timeout);
  if (!Number.isInteger(until) || until <= Date.now() || until > Date.now() + 3 * 3600000 || !Number.isInteger(wait) || wait < 10
    || !Number.isInteger(timeout) || timeout < 10 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.ssh!)) throw new Refusal(USAGE);
  let comfy: string;
  try { comfy = comfyUrl(values.comfy!); } catch { throw new Refusal('--comfy is the tunnelled loopback root of the server, such as http://127.0.0.1:8188'); }
  const result = await leverCommand(command, { dir, source: resolve(values.from ?? SOURCE_DIR), comfy, until, probe: sshProber(values.ssh!), waitMs: wait * 1000,
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
