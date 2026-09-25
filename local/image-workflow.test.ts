import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The picture lane's graphs are posted to ComfyUI as they are written, on a rented card, with the clock running. These
// checks are the ones that can be made without a GPU: each graph is connected, and it names the files the manifest
// pinned, through the loader type that reads them.
type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, Node>;
// A node's input, and the node and output slot it has to come from.
type Wire = [string, string, string, number];
const isLink = (value: unknown): value is Link =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';

const workflow: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow.json'), 'utf8'));
const qwen: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'));
const qwenEdit: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen-edit.json'), 'utf8'));
// The manifest is read the way the scripts read it — `source` under `set -euo pipefail` — and not by splitting on
// `=`. A value holding an unquoted space parses fine with a splitter and kills both scripts on the rented card.
const sourced = spawnSync('bash', ['-c', 'set -euo pipefail; set -a; . "$1"; set +a; env -0',
  'manifest', resolve('gpu/image-manifest.env')], { encoding: 'utf8' });
const manifest = new Map(sourced.stdout.split('\0').filter(Boolean).map(entry => {
  const at = entry.indexOf('=');
  return [entry.slice(0, at), entry.slice(at + 1)] as const;
}));
// gpu/image-bootstrap.sh in the modes that touch nothing: no download, no clone, no virtual environment. They are the
// checks that would otherwise only fail on a card that bills by the minute.
const bootstrap = (args: string[], environment: Record<string, string>, input = '') =>
  spawnSync('bash', [resolve('gpu/image-bootstrap.sh'), ...args], { encoding: 'utf8', input, env: { ...process.env, ...environment } });
const oneOf = (graph: Graph, type: string, label: string) => {
  const found = Object.values(graph).filter(node => node.class_type === type);
  assert.equal(found.length, 1, `${label}: expected exactly one ${type}`);
  return found[0]!;
};
const idIn = (graph: Graph, type: string) => Object.keys(graph).find(id => graph[id]!.class_type === type)!;

test('the image workflow is a connected API-format graph of core ComfyUI nodes', () => {
  // Every node here is in the pinned ComfyUI core: the Krea graph's are the ones blueprints/Text to Image (Krea-2
  // Turbo).json uses, TextEncodeQwenImage21 and QwenImage21Cache are in comfy_extras/nodes_qwen.py, the loaders and
  // LoadImage in nodes.py. A name off its list means a custom node crept in, which image-serve.sh would refuse.
  const krea = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'EmptyLatentImage',
    'KSampler', 'VAEDecode', 'SaveImage'];
  const qwenCore = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'QwenImage21Cache',
    'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage'];
  const drawn: Wire[] = [['VAEDecode', 'samples', 'KSampler', 0], ['SaveImage', 'images', 'VAEDecode', 0]];
  // One encode node hands Qwen both conditionings, positive from slot 0 and negative from slot 1. Crossing them would
  // draw every picture from the negative prompt and nothing here would say so.
  const conditioned: Wire[] = [['KSampler', 'positive', 'TextEncodeQwenImage21', 0], ['KSampler', 'negative', 'TextEncodeQwenImage21', 1]];
  // The settings each graph was tested at on the card, which the bot and the batch draw at unless told otherwise:
  // Krea 2 Turbo's eight er_sde steps at cfg 1.0, ComfyUI's "no guidance", and the Qwen templates' 25 euler steps, at
  // 16:9. The edit graph samples 16 rows fewer: at `resolution: 0` its encode node rounds a 720-row reference to 704,
  // as Python rounds 22.5, and a canvas of another size shifts the edit.
  const turbo = { steps: 8, cfg: 1, sampler_name: 'er_sde', scheduler: 'simple', denoise: 1, frame: [1280, 720] };
  const template = { ...turbo, steps: 25, sampler_name: 'euler' };
  const rows: [string, Graph, string[], Wire[], typeof turbo][] = [
    // Krea 2 Turbo runs without guidance, and the blueprint still wires a negative made by zeroing the positive.
    ['the Krea graph', workflow, krea, [...drawn, ['ConditioningZeroOut', 'conditioning', 'CLIPTextEncode', 0],
      ['KSampler', 'negative', 'ConditioningZeroOut', 0]], turbo],
    ['the Qwen graph', qwen, qwenCore, [...drawn, ...conditioned, ['KSampler', 'model', 'UNETLoader', 0]], template],
    // The edit graph is the t2i one plus the cache node the template puts between the loader and the sampler.
    ['the Qwen edit graph', qwenEdit, qwenCore, [...drawn, ...conditioned, ['QwenImage21Cache', 'model', 'UNETLoader', 0],
      ['KSampler', 'model', 'QwenImage21Cache', 0]], { ...template, frame: [1280, 704] }],
  ];
  for (const [label, graph, core, wires, settings] of rows) {
    for (const [id, node] of Object.entries(graph)) {
      assert.ok(core.includes(node.class_type), `${label}: ${id} is an unexpected node ${node.class_type}`);
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!isLink(value)) continue;
        assert.ok(graph[value[0]], `${label}: ${id}.${name} points at missing node ${value[0]}`);
        assert.ok(Number.isInteger(value[1]) && value[1] >= 0, `${label}: ${id}.${name} has a bad output slot`);
      }
    }
    for (const [type, input, from, slot] of wires) {
      assert.deepEqual(oneOf(graph, type, label).inputs[input], [idIn(graph, from), slot], `${label}: ${type}.${input}`);
    }
    const { steps, cfg, sampler_name, scheduler, denoise } = oneOf(graph, 'KSampler', label).inputs;
    const { width, height } = oneOf(graph, 'EmptyLatentImage', label).inputs;
    assert.deepEqual({ steps, cfg, sampler_name, scheduler, denoise, frame: [width, height] }, settings, `${label}: its settings`);
  }
});

test('the graph names the files of the source that installed them', () => {
  // The manifest survives the `source` both scripts start with. The two values that hold spaces, read back through
  // bash: unquoted, bash runs `Variant 8` and errexit ends the run.
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.deepEqual([manifest.get('IMAGE_MODEL_NAME'), manifest.get('IMAGE_MODEL_TRIGGER')], ['Kreamania Variant 8', 'Bradhamel art style']);
  // Qwen-Image 2.1, the opt-in third checkpoint: three public files by revision, exact bytes and SHA256.
  assert.deepEqual([manifest.get('IMAGE_QWEN_NAME'), manifest.get('IMAGE_QWEN_REPO')], ['Qwen-Image 2.1', 'Comfy-Org/Qwen-Image-2.1']);
  assert.match(manifest.get('IMAGE_QWEN_REVISION')!, /^[0-9a-f]{40}$/);
  for (const part of ['MODEL', 'ENCODER', 'VAE']) {
    assert.match(manifest.get(`IMAGE_QWEN_${part}_SHA256`)!, /^[0-9a-f]{64}$/, part);
    assert.ok(Number(manifest.get(`IMAGE_QWEN_${part}_BYTES`)) > 0, part);
    // The path inside the repository ends in the file name the graphs load, or image-bootstrap.sh saves one file
    // under the name of another and CLIPLoader picks the transformer.
    assert.ok(manifest.get(`IMAGE_QWEN_${part}_PATH`)!.endsWith('/' + manifest.get(`IMAGE_QWEN_${part}_FILE`)!), part);
  }
  // int8, both of them: one 32 GB card, and the pairing ComfyUI's own templates ship with. bf16 of these two is
  // 31.8 GB of weights before a single activation, which is the reason written down in the manifest.
  assert.match(manifest.get('IMAGE_QWEN_MODEL_FILE')!, /int8_convrot/);
  assert.match(manifest.get('IMAGE_QWEN_ENCODER_FILE')!, /int8_convrot/);
  assert.ok(['MODEL', 'ENCODER', 'VAE'].reduce((sum, part) => sum + Number(manifest.get(`IMAGE_QWEN_${part}_BYTES`)), 0) < 20e9,
    'the opt-in download stays under 20 GB');

  // The Krea graph as image-bootstrap.sh prints it for the source that installed the files. `official` downloads the
  // gated originals under their own names; a graph still naming the ComfyUI repackagings would pass every check on
  // the box and fail inside CLIPLoader at the first picture.
  const printed = (source: string): Graph => {
    const run = bootstrap(['--print-workflow'], { SIMPLE_CHAT_IMAGE_SOURCE: source });
    assert.equal(run.status, 0, `${source}: ${run.stderr}`);
    return JSON.parse(run.stdout);
  };
  const kreaFiles = ['IMAGE_MODEL_FILE', 'IMAGE_ENCODER_FILE', 'IMAGE_VAE_FILE'];
  const qwenFiles = ['IMAGE_QWEN_MODEL_FILE', 'IMAGE_QWEN_ENCODER_FILE', 'IMAGE_QWEN_VAE_FILE'];
  // Both text encoders are a Qwen3-VL, and the loader type says how to read one: `krea2` is Krea 2's twelve-layer
  // tap, and `qwen_image` is what comfy/sd.py dispatches to the Qwen-Image 2.1 text encoder. Either on the other's
  // file loads the wrong tokenizer and draws from noise.
  const rows: [string, Graph, string[], string][] = [
    ['the committed Krea graph', workflow, kreaFiles, 'krea2'],
    ['the Krea graph printed for comfy', printed('comfy'), kreaFiles, 'krea2'],
    ['the Krea graph printed for official', printed('official'), ['IMAGE_MODEL_FILE', 'OFFICIAL_ENCODER_FILE', 'OFFICIAL_VAE_FILE'], 'krea2'],
    ['the Qwen graph', qwen, qwenFiles, 'qwen_image'],
    ['the Qwen edit graph', qwenEdit, qwenFiles, 'qwen_image'],
  ];
  for (const [label, graph, files, type] of rows) {
    const clip = oneOf(graph, 'CLIPLoader', label).inputs;
    assert.deepEqual([oneOf(graph, 'UNETLoader', label).inputs.unet_name, clip.clip_name, oneOf(graph, 'VAELoader', label).inputs.vae_name,
      clip.type], [...files.map(key => manifest.get(key)), type], label);
  }
});

test('a dry run fetches the files its opt-in asks for and nothing else, and throws away a leftover longer than its pin', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: 'synthetic' };
  const qwenFiles = ['IMAGE_QWEN_MODEL_FILE', 'IMAGE_QWEN_ENCODER_FILE', 'IMAGE_QWEN_VAE_FILE'];
  const part = join(directory, 'ComfyUI/models/vae', `${manifest.get('IMAGE_VAE_FILE')}.part`);
  const rows: [string, string[], Record<string, string>, { status?: number; says?: RegExp; fetched?: string[]; skipped?: string[];
    leftover?: true; input?: string }][] = [
    // Off by default: local/rent-plan.ts prices the session from what a default run downloads, and a run that pulled
    // 17 GB nobody asked for would make that number a lie in the direction that costs money.
    ['the opt-in off', ['--dry-run'], environment, { skipped: qwenFiles }],
    // Additive: Krea is still fetched, so one box draws both and the blind comparison has two checkpoints to compare.
    ['the opt-in on', ['--dry-run'], { ...environment, SIMPLE_CHAT_IMAGE_QWEN: 'true' },
      { fetched: [...qwenFiles, 'IMAGE_MODEL_FILE', 'IMAGE_TURBO_FILE'] }],
    // A value that is not true, false or only is refused rather than read as false.
    ['the opt-in yes', ['--dry-run'], { ...environment, SIMPLE_CHAT_IMAGE_QWEN: 'yes' }, { status: 1 }],
    // `only`, the identity measurement's box: Qwen's three files, 16 GiB, and nothing of Krea's, so no token either.
    ['the opt-in only', ['--dry-run'], { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: '', SIMPLE_CHAT_HF_TOKEN: '',
      SIMPLE_CHAT_IMAGE_QWEN: 'only' }, { says: /^Qwen only, 16 GiB to fetch:/, fetched: qwenFiles,
      skipped: ['IMAGE_MODEL_FILE', 'IMAGE_ENCODER_FILE', 'IMAGE_VAE_FILE', 'IMAGE_TURBO_FILE'] }],
    // There is no Krea graph to print on that box.
    ['the Krea graph asked of a Qwen-only box', ['--print-workflow'], { SIMPLE_CHAT_IMAGE_QWEN: 'only' }, { status: 1 }],
    // `printf 'civitai=%s' "$token"` pipes a secret without leaving a newline in a history file; dropping that last
    // line reported a missing token, which points at the wrong cause and cannot be debugged from the logs.
    ['a token piped without a closing newline', ['--dry-run', '--tokens-stdin'], { SIMPLE_CHAT_GPU_DIR: directory,
      SIMPLE_CHAT_CIVITAI_TOKEN: '' }, { input: 'civitai=synthetic' }],
    // The discarding belongs to this pre-flight, which holds the run's lock and ends before a fetcher exists. Done
    // later, it would take the .part out from under the curl that is writing it.
    ['a leftover longer than the pinned file', ['--dry-run'], environment, { leftover: true }],
  ];
  for (const [label, args, env, expected] of rows) {
    if (expected.leftover) {
      mkdirSync(dirname(part), { recursive: true });
      const file = openSync(part, 'w');
      ftruncateSync(file, Number(manifest.get('IMAGE_VAE_BYTES')) + 1);
      closeSync(file);
    }
    const run = bootstrap(args, env, expected.input);
    assert.equal(run.status, expected.status ?? 0, `${label}: ${run.stderr}`);
    if (expected.says) assert.match(run.stdout, expected.says, label);
    for (const key of expected.fetched ?? []) assert.ok(run.stdout.includes(manifest.get(key)!), `${label}: ${key} is not fetched`);
    for (const key of expected.skipped ?? []) assert.ok(!run.stdout.includes(manifest.get(key)!), `${label}: ${key} is fetched`);
    if (expected.leftover) assert.equal(existsSync(part), false, `${label}: the leftover was kept`);
  }
});
