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
const qwen: Record<string, Node> = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'));
const qwenEdit: Record<string, Node> = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen-edit.json'), 'utf8'));
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

// Qwen-Image 2.1, the opt-in third checkpoint. The same three questions as above, asked of the two graphs
// converted from ComfyUI's own templates: connected, naming the pinned files, and carrying the template's settings.
const qwenNodes = (graph: Record<string, Node>) => Object.values(graph);
const oneOf = (graph: Record<string, Node>, type: string) => {
  const found = qwenNodes(graph).filter(node => node.class_type === type);
  assert.equal(found.length, 1, `expected exactly one ${type}`);
  return found[0]!;
};
const idIn = (graph: Record<string, Node>, type: string) => Object.keys(graph).find(id => graph[id]!.class_type === type)!;

test('the Qwen manifest pins three public files by revision, exact bytes and SHA256', () => {
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.equal(manifest.get('IMAGE_QWEN_NAME'), 'Qwen-Image 2.1');
  assert.equal(manifest.get('IMAGE_QWEN_REPO'), 'Comfy-Org/Qwen-Image-2.1');
  assert.match(manifest.get('IMAGE_QWEN_REVISION')!, /^[0-9a-f]{40}$/);
  for (const part of ['MODEL', 'ENCODER', 'VAE']) {
    assert.match(manifest.get(`IMAGE_QWEN_${part}_SHA256`)!, /^[0-9a-f]{64}$/, `IMAGE_QWEN_${part}_SHA256`);
    assert.ok(Number(manifest.get(`IMAGE_QWEN_${part}_BYTES`)) > 0, `IMAGE_QWEN_${part}_BYTES`);
    // The path inside the repository ends in the file name the graphs load, or image-bootstrap.sh saves one file
    // under the name of another and CLIPLoader picks the transformer.
    assert.ok(manifest.get(`IMAGE_QWEN_${part}_PATH`)!.endsWith('/' + manifest.get(`IMAGE_QWEN_${part}_FILE`)!));
  }
  // int8, both of them: one 32 GB card, and the pairing ComfyUI's own templates ship with. bf16 of these two is
  // 31.8 GB of weights before a single activation, which is the reason written down in the manifest.
  assert.match(manifest.get('IMAGE_QWEN_MODEL_FILE')!, /int8_convrot/);
  assert.match(manifest.get('IMAGE_QWEN_ENCODER_FILE')!, /int8_convrot/);
  assert.ok(Number(manifest.get('IMAGE_QWEN_MODEL_BYTES')) + Number(manifest.get('IMAGE_QWEN_ENCODER_BYTES'))
    + Number(manifest.get('IMAGE_QWEN_VAE_BYTES')) < 20e9, 'the opt-in download stays under 20 GB');
});

test('both Qwen graphs are connected API-format graphs of core ComfyUI nodes', () => {
  // Every name here is in the pinned ComfyUI core: TextEncodeQwenImage21 and QwenImage21Cache in
  // comfy_extras/nodes_qwen.py, the loaders and LoadImage in nodes.py. A name off this list means a custom node.
  const core = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'TextEncodeQwenImage21', 'QwenImage21Cache',
    'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage'];
  for (const graph of [qwen, qwenEdit]) {
    for (const [id, node] of Object.entries(graph)) {
      assert.ok(core.includes(node.class_type), `${id}: unexpected node ${node.class_type}`);
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!isLink(value)) continue;
        assert.ok(graph[value[0]], `${id}.${name} points at missing node ${value[0]}`);
        assert.ok(Number.isInteger(value[1]) && value[1] >= 0, `${id}.${name} has a bad output slot`);
      }
    }
    // One encode node hands out both conditionings, positive from slot 0 and negative from slot 1. Crossing them
    // would draw every picture from the negative prompt and nothing here would say so.
    const encode = idIn(graph, 'TextEncodeQwenImage21');
    assert.deepEqual(oneOf(graph, 'KSampler').inputs['positive'], [encode, 0]);
    assert.deepEqual(oneOf(graph, 'KSampler').inputs['negative'], [encode, 1]);
    assert.deepEqual(oneOf(graph, 'VAEDecode').inputs['samples'], [idIn(graph, 'KSampler'), 0]);
    assert.deepEqual(oneOf(graph, 'SaveImage').inputs['images'], [idIn(graph, 'VAEDecode'), 0]);
  }
  // The edit graph is the t2i one plus the cache node the template puts between the loader and the sampler.
  assert.deepEqual(oneOf(qwenEdit, 'QwenImage21Cache').inputs['model'], [idIn(qwenEdit, 'UNETLoader'), 0]);
  assert.deepEqual(oneOf(qwenEdit, 'KSampler').inputs['model'], [idIn(qwenEdit, 'QwenImage21Cache'), 0]);
  assert.deepEqual(oneOf(qwen, 'KSampler').inputs['model'], [idIn(qwen, 'UNETLoader'), 0]);
});

test('both Qwen graphs load the files the manifest pins, through the loader type that reads them', () => {
  for (const graph of [qwen, qwenEdit]) {
    assert.equal(oneOf(graph, 'UNETLoader').inputs['unet_name'], manifest.get('IMAGE_QWEN_MODEL_FILE'));
    assert.equal(oneOf(graph, 'CLIPLoader').inputs['clip_name'], manifest.get('IMAGE_QWEN_ENCODER_FILE'));
    assert.equal(oneOf(graph, 'VAELoader').inputs['vae_name'], manifest.get('IMAGE_QWEN_VAE_FILE'));
    // `qwen_image` with a Qwen3-VL-8B encoder is what comfy/sd.py dispatches to the Qwen-Image 2.1 text encoder;
    // Krea's `krea2` on the same file would load the wrong tokenizer and draw from noise.
    assert.equal(oneOf(graph, 'CLIPLoader').inputs['type'], 'qwen_image');
  }
});

test('both Qwen graphs keep the template settings, at the frame each of them samples', () => {
  for (const graph of [qwen, qwenEdit]) {
    const sampler = oneOf(graph, 'KSampler').inputs;
    // image_qwen_image_2_1_t2i.json and its edit twin: 25 steps, cfg 1, euler, simple. The upstream card's 40 is
    // one `--steps 40` away, and neither template sets a shift — Qwen Image 2.1 carries shift 0.69 in its own
    // model class (comfy/supported_models.py), so a shift node here would silently overrule the template.
    assert.equal(sampler['steps'], 25);
    assert.equal(sampler['cfg'], 1.0);
    assert.equal(sampler['sampler_name'], 'euler');
    assert.equal(sampler['scheduler'], 'simple');
    assert.equal(sampler['denoise'], 1.0);
    // ComfyUI folds an empty latent to this model's 1/16 grid; a size off it is silently rounded on the card.
    const latent = oneOf(graph, 'EmptyLatentImage').inputs;
    const width = latent['width'] as number, height = latent['height'] as number;
    assert.equal(width % 16, 0);
    assert.equal(height % 16, 0);
    // The placeholders local/image-batch.ts fills, in the state the graph is committed in: nothing of a previous
    // run left in a file that is posted as it is.
    const encode = oneOf(graph, 'TextEncodeQwenImage21').inputs;
    assert.equal(encode['prompt'], '');
    assert.equal(encode['negative_prompt'], '');
    assert.equal(sampler['seed'], 0);
  }
  // The template's ResolutionSelector asks for one megapixel; the text-to-image lane asks for 16:9, because a
  // blind bundle holding one square picture and one wide one has told the rater which model drew which. Its
  // encode node keeps the template's own `resolution` default, which does nothing at all without references.
  const frame = oneOf(qwen, 'EmptyLatentImage').inputs;
  assert.deepEqual([frame['width'], frame['height']], [1280, 720]);
  assert.equal((frame['width'] as number) * 9, (frame['height'] as number) * 16);
  assert.equal(oneOf(qwen, 'TextEncodeQwenImage21').inputs['resolution'], 1024);
  // The edit graph is 16 rows shorter, and that is the template's own relationship rather than a choice: at
  // `resolution: 0` the encode node keeps each reference at its own size rounded to a multiple of 32, so a
  // 1280x720 portrait out of the graph above becomes 1280x704 — Python's `round(720 / 32)` is 22 and not 23, it
  // rounds a half to the even side — and the node's latent output, "Empty latent on the first reference image's
  // size, to match with sampling as any other size shifts the edit", is that size. The template samples from that
  // output through its `custom_size = off` switch; we cannot, because applyToWorkflow needs the sampler's latent to
  // come from a node with a width and a height, so the EmptyLatentImage carries the same number instead. At the
  // node's default 1024 it would be 1376x768, and a 1280x720 canvas under it is what the template's note warns of.
  const editFrame = oneOf(qwenEdit, 'EmptyLatentImage').inputs;
  assert.equal(oneOf(qwenEdit, 'TextEncodeQwenImage21').inputs['resolution'], 0);
  assert.deepEqual([editFrame['width'], editFrame['height']], [1280, 704]);
});

test('the Qwen edit graph offers a reference slot per person a character sheet can hold', () => {
  const encode = oneOf(qwenEdit, 'TextEncodeQwenImage21');
  const slots = Object.keys(encode.inputs).filter(name => name.startsWith('images.'));
  // Six, the sheet's own `maxItems` in local/illustrate-probe.ts: its frame schema admits four people, but a frame
  // that arrives with more ends the whole run in `workflow_too_few_reference_slots`, and a graph widened after that
  // has another hash than the run directory was opened with. The node itself takes sixteen.
  assert.deepEqual(slots.sort(), ['images.image_1', 'images.image_2', 'images.image_3', 'images.image_4',
    'images.image_5', 'images.image_6']);
  for (const slot of slots) {
    const link = encode.inputs[slot];
    assert.ok(isLink(link), `${slot} is not wired to a loader`);
    assert.equal(qwenEdit[link[0]]!.class_type, 'LoadImage');
  }
  // The encoder sees the references as well as the VAE: identity comes from the vision tower, the latents keep
  // the pixels. Without the VAE the references are a caption, not a face.
  assert.deepEqual(encode.inputs['vae'], [idIn(qwenEdit, 'VAELoader'), 0]);
  // Every loader is its own slot; two slots on one file would send the same face twice and lose a person.
  const loaders = slots.map(slot => (encode.inputs[slot] as Link)[0]);
  assert.equal(new Set(loaders).size, slots.length);
  // The t2i graph has no slots at all, so a `--references` run cannot be pointed at it by accident.
  assert.equal(Object.keys(oneOf(qwen, 'TextEncodeQwenImage21').inputs).filter(name => name.startsWith('images.')).length, 0);
});

test('the opt-in is off by default and adds the three Qwen files when it is on', t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment = { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: 'synthetic' };
  const files = [manifest.get('IMAGE_QWEN_MODEL_FILE')!, manifest.get('IMAGE_QWEN_ENCODER_FILE')!, manifest.get('IMAGE_QWEN_VAE_FILE')!];
  // Off: local/rent-plan.ts prices the session from what a default run downloads, and a run that pulled 17 GB
  // nobody asked for would make that number a lie in the direction that costs money.
  const off = bootstrap(['--dry-run'], environment);
  assert.equal(off.status, 0, off.stderr);
  for (const file of files) assert.ok(!off.stdout.includes(file), `${file} is downloaded without the opt-in`);
  const on = bootstrap(['--dry-run'], { ...environment, SIMPLE_CHAT_IMAGE_QWEN: 'true' });
  assert.equal(on.status, 0, on.stderr);
  for (const file of files) assert.ok(on.stdout.includes(file), `${file} is missing with the opt-in`);
  // Additive: Krea is still fetched, so one box draws both and the blind comparison has two checkpoints to compare.
  assert.ok(on.stdout.includes(manifest.get('IMAGE_MODEL_FILE')!));
  assert.ok(on.stdout.includes(manifest.get('IMAGE_TURBO_FILE')!));
  const refused = bootstrap(['--dry-run'], { ...environment, SIMPLE_CHAT_IMAGE_QWEN: 'yes' });
  assert.equal(refused.status, 1, 'a value that is not true, false or only is refused rather than read as false');
  // `only`, the identity measurement's box: Qwen's three files, 16 GiB, and nothing of Krea's, so no token either.
  const alone = bootstrap(['--dry-run'], { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: '', SIMPLE_CHAT_HF_TOKEN: '',
    SIMPLE_CHAT_IMAGE_QWEN: 'only' });
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /^Qwen only, 16 GiB to fetch:/);
  for (const file of files) assert.ok(alone.stdout.includes(file), `${file} is missing with only`);
  for (const key of ['IMAGE_MODEL_FILE', 'IMAGE_ENCODER_FILE', 'IMAGE_VAE_FILE', 'IMAGE_TURBO_FILE']) {
    assert.ok(!alone.stdout.includes(manifest.get(key)!), `${key} is fetched with only`);
  }
  assert.equal(bootstrap(['--print-workflow'], { SIMPLE_CHAT_IMAGE_QWEN: 'only' }).status, 1, 'there is no Krea graph to print');
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
  // The discarding belongs to this pre-flight, which holds the run's lock and ends before a fetcher exists. Done
  // later, it would take the .part out from under the curl that is writing it.
  const run = bootstrap(['--dry-run'], { SIMPLE_CHAT_GPU_DIR: directory, SIMPLE_CHAT_CIVITAI_TOKEN: 'synthetic' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(part), false);
});
