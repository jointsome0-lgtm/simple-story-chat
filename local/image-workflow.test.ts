import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The picture lane's graph is posted to ComfyUI as it is written, on a rented card, with the clock running. These
// checks are the ones that can be made without a GPU: the graph is connected, it names the files the manifest
// pinned, and it asks for the sampler settings the tester's hosted rounds used.
type Link = [string, number];
type Node = { class_type: string; inputs: Record<string, unknown> };
const isLink = (value: unknown): value is Link =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number';

const workflow: Record<string, Node> = JSON.parse(readFileSync(resolve('gpu/image-workflow.json'), 'utf8'));
// The manifest is read the way the scripts read it — `source` under `set -euo pipefail` — and not by splitting on
// `=`. A value holding an unquoted space parses fine with a splitter and kills both scripts on the rented card.
const sourced = spawnSync('bash', ['-c', 'set -euo pipefail; set -a; . "$1"; set +a; env -0',
  'manifest', resolve('gpu/image-manifest.env')], { encoding: 'utf8' });
const manifest = new Map(sourced.stdout.split('\0').filter(Boolean).map(entry => {
  const at = entry.indexOf('=');
  return [entry.slice(0, at), entry.slice(at + 1)] as const;
}));
const bootstrap = (args: string[], environment: Record<string, string>, input = '') =>
  spawnSync('bash', [resolve('gpu/image-bootstrap.sh'), ...args],
    { encoding: 'utf8', input, env: { ...process.env, ...environment } });
const nodes = Object.values(workflow);
const only = (type: string) => {
  const found = nodes.filter(node => node.class_type === type);
  assert.equal(found.length, 1, `expected exactly one ${type}`);
  return found[0]!;
};
const idOf = (type: string) => Object.keys(workflow).find(id => workflow[id]!.class_type === type)!;
const linkOf = (type: string, name: string): Link => {
  const value = only(type).inputs[name];
  assert.ok(isLink(value), `${type}.${name} is not a link`);
  return value;
};

test('the manifest survives the `source` both scripts start with', () => {
  assert.equal(sourced.status, 0, sourced.stderr);
  // The two values that hold spaces, read back through bash: unquoted, bash runs `Variant 8` and errexit ends the run.
  assert.equal(manifest.get('IMAGE_MODEL_NAME'), 'Kreamania Variant 8');
  assert.equal(manifest.get('IMAGE_MODEL_TRIGGER'), 'Bradhamel art style');
});

test('the image workflow is a connected API-format graph of core ComfyUI nodes', () => {
  // Every node here is in the pinned ComfyUI core (blueprints/Text to Image (Krea-2 Turbo).json uses the same
  // loaders). A name that is not on this list means a custom node crept in, which image-serve.sh would refuse.
  const core = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut',
    'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage'];
  for (const [id, node] of Object.entries(workflow)) {
    assert.ok(core.includes(node.class_type), `${id}: unexpected node ${node.class_type}`);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!isLink(value)) continue;
      const source = workflow[value[0]];
      assert.ok(source, `${id}.${name} points at missing node ${value[0]}`);
      assert.ok(Number.isInteger(value[1]) && value[1] >= 0, `${id}.${name} has a bad output slot`);
    }
  }
  assert.deepEqual(linkOf('VAEDecode', 'samples'), [idOf('KSampler'), 0]);
  assert.deepEqual(linkOf('SaveImage', 'images'), [idOf('VAEDecode'), 0]);
  // Krea 2 Turbo runs without guidance, and the blueprint still wires a negative made by zeroing the positive.
  assert.deepEqual(linkOf('ConditioningZeroOut', 'conditioning'), [idOf('CLIPTextEncode'), 0]);
  assert.deepEqual(linkOf('KSampler', 'negative'), [idOf('ConditioningZeroOut'), 0]);
});

test('the image workflow loads the files the manifest pins', () => {
  assert.equal(only('UNETLoader').inputs['unet_name'], manifest.get('IMAGE_MODEL_FILE'));
  assert.equal(only('CLIPLoader').inputs['clip_name'], manifest.get('IMAGE_ENCODER_FILE'));
  assert.equal(only('VAELoader').inputs['vae_name'], manifest.get('IMAGE_VAE_FILE'));
  // The text encoder is a Qwen3-VL the loader has to be told to read as Krea 2's twelve-layer tap.
  assert.equal(only('CLIPLoader').inputs['type'], 'krea2');
});

test('the image workflow asks for the tester eight-step settings at 16:9', () => {
  const sampler = only('KSampler').inputs;
  assert.equal(sampler['steps'], 8);
  // cfg 1.0 is ComfyUI's way of saying "no guidance", which is the official `--cfg 0` for the Turbo checkpoint.
  assert.equal(sampler['cfg'], 1.0);
  assert.equal(sampler['sampler_name'], 'er_sde');
  assert.equal(sampler['scheduler'], 'simple');
  assert.equal(sampler['denoise'], 1.0);
  const latent = only('EmptyLatentImage').inputs;
  const width = latent['width'] as number, height = latent['height'] as number;
  assert.equal(width % 16, 0);
  assert.equal(height % 16, 0);
  assert.equal(width * 9, height * 16);
  assert.ok(width * height >= 800_000 && width * height <= 1_200_000, 'about one megapixel');
});

// The rest drives gpu/image-bootstrap.sh itself, in the two modes that touch nothing: no download, no clone, no
// virtual environment. They are the checks that would otherwise only fail on a card that bills by the minute.
test('the graph names the files of the source that installed them', () => {
  for (const [source, encoder, vae] of [['comfy', 'IMAGE_ENCODER_FILE', 'IMAGE_VAE_FILE'],
    ['official', 'OFFICIAL_ENCODER_FILE', 'OFFICIAL_VAE_FILE']] as const) {
    const printed = bootstrap(['--print-workflow'], { SIMPLE_CHAT_IMAGE_SOURCE: source });
    assert.equal(printed.status, 0, printed.stderr);
    const graph: Record<string, Node> = JSON.parse(printed.stdout);
    const input = (type: string, name: string) =>
      Object.values(graph).find(node => node.class_type === type)!.inputs[name];
    assert.equal(input('UNETLoader', 'unet_name'), manifest.get('IMAGE_MODEL_FILE'));
    // `official` downloads the gated originals under their own names; a graph still naming the ComfyUI
    // repackagings would pass every check on the box and fail inside CLIPLoader at the first picture.
    assert.equal(input('CLIPLoader', 'clip_name'), manifest.get(encoder));
    assert.equal(input('VAELoader', 'vae_name'), manifest.get(vae));
  }
});

test('a token piped without a closing newline is still read', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // `printf 'civitai=%s' "$token"` is how a secret is piped without leaving a newline in a history file; dropping
  // that last line reported a missing token, which points at the wrong cause and cannot be debugged from the logs.
  const run = bootstrap(['--dry-run', '--tokens-stdin'], { SIMPLE_CHAT_GPU_DIR: directory }, 'civitai=synthetic');
  assert.equal(run.status, 0, run.stderr);
});

test('a leftover longer than the pinned file is discarded before the downloads start', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const part = join(directory, 'ComfyUI/models/vae', `${manifest.get('IMAGE_VAE_FILE')}.part`);
  mkdirSync(dirname(part), { recursive: true });
  const file = openSync(part, 'w');
  ftruncateSync(file, Number(manifest.get('IMAGE_VAE_BYTES')) + 1);
  closeSync(file);
  // The discarding belongs to this pre-flight, which ends before a fetcher or the speed guard exists. Done beside
  // the guard, it would shrink the directory the guard is measuring, and a negative rate ends every download.
  const run = bootstrap(['--dry-run'], { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: 'synthetic' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(part), false);
});
