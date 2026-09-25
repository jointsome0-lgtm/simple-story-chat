import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { draw, buildBundles, bundlesOf, applyToWorkflow, defaultWorkflow, drawOne, encoderResolution, latentSizeOf, parseSeeds, phasesOf, pngSize, portraitsFor, referenceGeometry, referenceSlots, samplerSettingsOf, settled, stripPngMetadata, textEncoderOf, REVIEW } from './image-batch.ts';
import type { BatchIndex, Comfy, DrawOptions, Graph, Picture, References } from './image-batch.ts';
import type { Case } from './illustrate-probe.ts';

// A real 2x2 PNG, written here the way ComfyUI writes one: the workflow and the prompt in text chunks beside the pixels.
const RAW = Buffer.from([0, 10, 20, 30, 40, 50, 60, 0, 70, 80, 90, 100, 110, 120]);
const IHDR = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
  return out;
}
const pngWithMetadata = (text: string) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', IHDR),
  chunk('tEXt', Buffer.from(`prompt\0${text}`, 'latin1')),
  chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0', 'latin1'), deflateSync(Buffer.from(text, 'utf8'))])),
  chunk('IDAT', deflateSync(RAW)),
  chunk('iTXt', Buffer.from(`parameters\0\0\0\0\0${text}`, 'latin1')),
  chunk('IEND', Buffer.alloc(0)),
]);
function chunksOf(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: { type: string; data: Buffer }[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    found.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), data: Buffer.from(bytes.subarray(at + 8, at + 8 + length)) });
    at += 12 + length;
  }
  return found;
}

// Whatever text this graph carries, whichever node holds it: Krea has one `text` per CLIPTextEncode, Qwen Image
// 2.1 has `prompt` and `negative_prompt` on one encode node.
const textOf = (graph: Graph) => Object.values(graph)
  .flatMap(node => [node.inputs.text, node.inputs.prompt]).filter(value => typeof value === 'string').join(' ');

// The fake ComfyUI: /prompt, /history, /view, /system_stats, POST /upload/image for reference pictures, and POST
// /history to forget a job. A job finishes on the third poll, so the video-memory sampling inside the wait runs too.
function fakeComfy(options: { failCase?: string; refuse?: number; refuseUpload?: boolean } = {}) {
  const submitted: Graph[] = [];
  const cleared: string[] = [];
  const viewed: string[] = [];
  const uploads: { name: string; type: string; overwrite: string; bytes: Buffer }[] = [];
  const attempts = { prompt: 0 };
  const polls = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/prompt') {
        attempts.prompt++;
        // A graph this build cannot run is refused with a status, and refused again for every cell after it.
        if (options.refuse) { response.statusCode = options.refuse; return response.end(); }
        const graph = (await body()).prompt as Graph;
        submitted.push(graph);
        return json({ prompt_id: `p${submitted.length}`, number: submitted.length });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        cleared.push(...((await body()).delete as string[] ?? []));
        return json({});
      }
      // As ComfyUI's own route: a multipart form with the picture, the target directory and the overwrite flag,
      // answered with the name LoadImage will read it by.
      if (request.method === 'POST' && url.pathname === '/upload/image') {
        if (options.refuseUpload) { response.statusCode = 200; return json({}); }
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(part as Buffer);
        const form = await new Response(Buffer.concat(parts), { headers: { 'content-type': request.headers['content-type']! } }).formData();
        const file = form.get('image') as File;
        uploads.push({ name: file.name, type: String(form.get('type')), overwrite: String(form.get('overwrite')),
          bytes: Buffer.from(await file.arrayBuffer()) });
        return json({ name: file.name, subfolder: '', type: 'input' });
      }
      if (url.pathname === '/system_stats') return json({ devices: [{ index: 0, vram_total: 32 * 1024 * 1024 * 1024, vram_free: 2 * 1024 * 1024 * 1024 }] });
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        const seen = (polls.get(id) ?? 0) + 1;
        polls.set(id, seen);
        if (seen < 3) return json({});
        const graph = submitted[Number(id.slice(1)) - 1];
        const prompt = textOf(graph);
        if (options.failCase && prompt.includes(options.failCase)) return json({ [id]: { status: { completed: false, status_str: 'error' } } });
        // As ComfyUI answers for a PreviewImage node: the picture is in the server's temp area, not its output one.
        return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: `${id}.png`, subfolder: '', type: 'temp' }] } } } });
      }
      if (url.pathname === '/view') {
        viewed.push(String(url.searchParams.get('type')));
        const id = String(url.searchParams.get('filename')).replace('.png', '');
        const graph = submitted[Number(id.slice(1)) - 1];
        response.setHeader('content-type', 'image/png');
        // As ComfyUI does: the whole workflow travels in the PNG's text chunks.
        return response.end(pngWithMetadata(JSON.stringify(graph)));
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  return { server, submitted, cleared, viewed, uploads, attempts, listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

// The same server with the queue ComfyUI really has: one job at a time, in submit order, and a history entry — the
// whole graph in it — only once a job is over, so a delete sent while the card is still drawing removes nothing.
// `/interrupt` stops the job the card is working through, and one given a `prompt_id` only while that is the job it
// names (server.py:1163-1191); the interrupted job is recorded as failed, as ComfyUI records an interrupted prompt.
// `afterQueueRead` runs once, the moment the next read of the queue has been answered, and `onSubmit` once, the
// moment the card has taken the next job and before it answers with the job's id. A `stubborn` card takes an
// interrupt and goes on drawing. `failPolls` answers that many of the next reads of a record with a 500.
function serialComfy(jobMs: number) {
  const prompts = new Map<string, string>();
  const finishAt = new Map<string, number>();
  const history = new Map<string, string>();
  const polls = new Map<string, number>();
  const seen = { submitted: 0, interrupts: 0, queueDeletes: 0, interrupted: [] as string[] };
  let busyUntil = 0, failPolls = 0;
  let afterQueueRead: (() => void) | undefined, onSubmit: (() => void) | undefined, stubborn = false;
  const settle = () => { for (const [id, at] of [...finishAt]) if (Date.now() >= at) { finishAt.delete(id); history.set(id, prompts.get(id)!); } };
  const running = () => [...finishAt.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      settle();
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const graph = (await body()).prompt as Graph;
        const id = `p${++seen.submitted}`;
        prompts.set(id, JSON.stringify(graph));
        busyUntil = Math.max(busyUntil, Date.now()) + jobMs;
        finishAt.set(id, busyUntil);
        const then = onSubmit;
        onSubmit = undefined;
        then?.();
        return json({ prompt_id: id });
      }
      if (request.method === 'POST' && url.pathname === '/interrupt') {
        seen.interrupts++;
        const named = (await body().catch(() => ({})) as { prompt_id?: unknown }).prompt_id;
        const id = running();
        // An interrupted prompt lands in the history too, with the whole graph in it.
        if (id && (named === undefined || named === id) && !stubborn) {
          finishAt.delete(id);
          history.set(id, prompts.get(id)!);
          seen.interrupted.push(id);
          busyUntil = Date.now();
        }
        return json({});
      }
      if (request.method === 'POST' && url.pathname === '/queue') {
        seen.queueDeletes++;
        for (const id of ((await body()).delete as string[]) ?? []) if (id !== running()) finishAt.delete(id);
        return json({});
      }
      // As ComfyUI reports it: the job on the card first, the ones waiting behind it after, each entry an array
      // whose second element is the prompt id.
      if (url.pathname === '/queue') {
        const waiting = [...finishAt.keys()].filter(id => id !== running());
        json({ queue_running: running() ? [[0, running()]] : [], queue_pending: waiting.map((id, at) => [at + 1, id]) });
        const then = afterQueueRead;
        afterQueueRead = undefined;
        return then?.();
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        for (const id of ((await body()).delete as string[]) ?? []) history.delete(id);
        return json({});
      }
      if (url.pathname === '/system_stats') return json({ devices: [{ index: 0, vram_total: 32 * 1024 * 1024 * 1024, vram_free: 2 * 1024 * 1024 * 1024 }] });
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        polls.set(id, (polls.get(id) ?? 0) + 1);
        if (failPolls > 0) { failPolls--; response.statusCode = 500; return response.end(); }
        if (!history.has(id)) return json({});
        if (seen.interrupted.includes(id)) return json({ [id]: { status: { completed: false, status_str: 'error' }, outputs: {} } });
        return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: `${id}.png`, subfolder: '', type: 'temp' }] } } } });
      }
      if (url.pathname === '/view') { response.setHeader('content-type', 'image/png'); return response.end(pngWithMetadata('{}')); }
      response.statusCode = 404;
      response.end();
    })();
  });
  // What the card is still working through, whether or not the harness is waiting for it.
  const onTheCard = () => finishAt.size;
  // The job `id` is done now, as one that was nearly done would be, and the next one takes the card.
  const end = (id: string) => { finishAt.set(id, Date.now()); settle(); };
  return { server, history, polls, seen, settle, onTheCard, end, set afterQueueRead(then: () => void) { afterQueueRead = then; },
    set onSubmit(then: () => void) { onSubmit = then; }, set stubborn(value: boolean) { stubborn = value; },
    set failPolls(count: number) { failPolls = count; },
    listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

const cases: Case[] = [
  { id: 'battle-2', scenario: 'battle', index: 2, scene: 'Сцена про телегу и шину.', sheet: [{ name: 'Элин', look: 'A middle-aged woman in grey' }],
    description: { moment: 'Two figures at a cart', shot: 'Medium shot', setting: 'A salt road', objects: '', props: '', light: 'Morning light', people: [] },
    prompt: 'Medium shot. A salt road. Two figures at a cart. Morning light. Hand-painted.', namesStripped: 0, fromSheet: 0, withoutLook: 0 },
  { id: 'dance-12', scenario: 'dance', index: 12, scene: 'Сцена про комиссию и запись.', sheet: [{ name: 'Сава', look: 'A young man in black' }],
    description: { moment: 'Officials at a monitor', shot: 'Wide shot', setting: 'A hall', objects: '', props: '', light: 'Evening light', people: [] },
    prompt: 'Wide shot. A hall. Officials at a monitor. Evening light. Hand-painted.', namesStripped: 0, fromSheet: 0, withoutLook: 0 },
];

// The identity test: the people of a frame bring their portraits with them. The sheet name picks the file and
// stops there — what reaches the card is a hash, because a portrait is somebody's face.
const identityCases: Case[] = [
  { id: 'battle-2', scenario: 'battle', index: 2, scene: 'Сцена про телегу.', sheet: [{ name: 'Элин', look: 'A middle-aged woman in grey' }],
    description: { moment: 'At a cart', shot: 'Medium shot', setting: 'A salt road', objects: '', props: '', light: 'Morning light',
      people: [{ who: 'Элину', look: '', state: '', action: 'lifts a crate' }] },
    prompt: 'Medium shot. A salt road. At a cart.', namesStripped: 0, fromSheet: 1, withoutLook: 0 },
  { id: 'battle-5', scenario: 'battle', index: 5, scene: 'Сцена про шину.', sheet: [{ name: 'Элин', look: 'A middle-aged woman in grey' }],
    description: { moment: 'At a wheel', shot: 'Wide shot', setting: 'A salt road', objects: '', props: '', light: 'Noon light',
      people: [{ who: 'Элин', look: '', state: '', action: 'kneels at the wheel' },
        { who: 'salt worker', look: 'A young man', state: '', action: 'holds the axle' }] },
    prompt: 'Wide shot. A salt road. At a wheel.', namesStripped: 0, fromSheet: 1, withoutLook: 0 },
];
const elin: References = { battle: { 'Элин': 'elin.png' } };

// The scenes of a run and, given `references`, the portraits file of an identity run with the one portrait it can name.
function corpus(list = cases, references?: References, portrait: Buffer = pngWithMetadata('{}')) {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-batch-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(list));
  if (references) {
    writeFileSync(join(root, 'elin.png'), portrait);
    writeFileSync(join(root, 'references.json'), JSON.stringify(references));
  }
  return root;
}
const options = (root: string, comfy: string) => ({ prompts: join(root, 'prompts'), out: join(root, 'run'), comfy,
  checkpoints: ['kreamania-fp8.safetensors', 'krea-2-turbo.safetensors'], seeds: [7], steps: 8, sampler: 'er_sde',
  scheduler: 'simple', cfg: 1, width: 1344, height: 768, negative: '', minutes: 5, timeoutMs: 10000, waitMs: 10000, pollMs: 1 });

test('a written picture keeps its pixels and nothing that ComfyUI wrote beside them', () => {
  const original = pngWithMetadata('{"prompt":"PRIVATE_SCENE_TEXT"}');
  const stripped = stripPngMetadata(original);
  assert.deepEqual(chunksOf(stripped).map(one => one.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(!Buffer.from(stripped).includes('PRIVATE_SCENE_TEXT'));
  assert.ok(stripped.length < original.length);
  // Still a picture: the same pixels, out of an IDAT whose CRC was copied with it.
  assert.deepEqual(inflateSync(chunksOf(stripped).find(one => one.type === 'IDAT')!.data), RAW);
  assert.deepEqual(chunksOf(stripped)[0].data, IHDR);
  assert.throws(() => stripPngMetadata(Buffer.from('not a png at all')), /not_a_png/);
});

// A graph is filled by the role of each node, not by its number, and a workflow pinned on the card is shaped by
// whoever pinned it: one text node may feed both conditionings, and a second node may carry a size of its own.
test('the negative text never lands on the positive node, and the size goes on the sampler\'s own latent', () => {
  const values = { checkpoint: 'k.safetensors', prompt: 'a picture', negative: 'blurry', seed: 11, steps: 8,
    sampler: 'er_sde', scheduler: 'simple', width: 1344, height: 768, cfg: 1 };
  const pinned = (file: string): Graph => JSON.parse(readFileSync(resolve(file), 'utf8'));
  const nodes = (graph: Graph, type: string) => Object.values(graph).filter(node => node.class_type === type);
  const rows: [string, Graph, Partial<typeof values>, object | ((filled: Graph, label: string, graph: Graph) => void)][] = [
    // Its text encoder is the checkpoint's own, which no tokenizer counts for.
    ['the built-in graph', defaultWorkflow(), {}, (filled, label, graph) => assert.deepEqual([filled['1'].inputs.ckpt_name,
      filled['2'].inputs.text, filled['3'].inputs.text, filled['5'].inputs.seed, filled['4'].inputs.width, textEncoderOf(graph)],
    ['k.safetensors', 'a picture', 'blurry', 11, 1344, undefined], label)],
    ['a graph with no sampler', { '1': { class_type: 'SaveImage', inputs: {} } }, {}, /sampler/],
    // Both conditionings on one text node: writing the negative over it sent the card an empty prompt, while the
    // bundle still showed the assembled one, so a judging session would have graded a picture drawn from nothing.
    ['one text node on both conditionings', {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
      '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '5': { class_type: 'KSampler', inputs: { seed: 0, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
    }, {}, (filled, label) => assert.equal(filled['2'].inputs.text, 'a picture', label)],
    // An upscale or pad node keeps the size it was pinned with; only the latent the sampler starts from takes ours.
    ['an upscale node beside the latent', { ...defaultWorkflow(),
      '8': { class_type: 'ImageScale', inputs: { image: ['6', 0], upscale_method: 'lanczos', width: 2688, height: 1536, crop: 'disabled' } } },
    {}, (filled, label) => assert.deepEqual([filled['4'].inputs.width, filled['4'].inputs.height, filled['8'].inputs.width,
      filled['8'].inputs.height], [1344, 768, 2688, 1536], label)],
    // A latent with no size of its own would be drawn at the workflow's size and written down at ours. The graph's
    // own failures carry a code, so `draw` records them as themselves and not as a plain `image_failed`.
    ['a latent with no size', { ...defaultWorkflow(), '4': { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } } },
      {}, { code: 'workflow_no_latent_size' }],
    // gpu/image-workflow.json loads a transformer, a text encoder and a VAE apart, where the built-in graph's
    // CheckpointLoaderSimple would look for one all-in-one file this stack never installs. Its one text node reaches
    // the negative through ConditioningZeroOut, and the assembled prompt has to land on it.
    ['the pinned Krea graph', pinned('gpu/image-workflow.json'), { checkpoint: 'kreamania_variant8_fp8.safetensors', seed: 7,
      width: 1280, height: 720 }, (filled, label, graph) => {
      // The encoder the tokens under a picture are counted for: the type of the CLIPLoader behind the positive prompt.
      assert.deepEqual([latentSizeOf(graph), textEncoderOf(graph)], [{ width: 1280, height: 720 }, 'krea2'], label);
      assert.deepEqual([nodes(filled, 'UNETLoader')[0].inputs.unet_name, nodes(filled, 'KSampler')[0].inputs.seed,
        nodes(filled, 'CLIPTextEncode').map(node => node.inputs.text)], ['kreamania_variant8_fp8.safetensors', 7, ['a picture']], label);
    }],
    // Qwen Image 2.1 takes both conditionings from one node through two inputs. The Krea rule is about the input,
    // not the node: skipping the node would have drawn every Qwen picture from an empty prompt.
    ['the pinned Qwen graph', pinned('gpu/image-workflow-qwen.json'), { checkpoint: 'qwen_image_2.1_int8_convrot.safetensors',
      seed: 7, steps: 25, sampler: 'euler', width: 1280, height: 720 }, (filled, label, graph) => {
      assert.deepEqual([latentSizeOf(graph), samplerSettingsOf(graph), textEncoderOf(graph)],
        [{ width: 1280, height: 720 }, { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1 }, 'qwen_image'], label);
      const [encode] = nodes(filled, 'TextEncodeQwenImage21');
      assert.deepEqual([encode.inputs.prompt, encode.inputs.negative_prompt, nodes(filled, 'UNETLoader')[0].inputs.unet_name],
        ['a picture', 'blurry', 'qwen_image_2.1_int8_convrot.safetensors'], label);
    }],
  ];
  for (const [label, graph, more, expected] of rows) {
    const before = JSON.stringify(graph);
    const fill = () => applyToWorkflow(graph, { ...values, ...more });
    if (typeof expected === 'function') expected(fill(), label, graph);
    else assert.throws(fill, expected, label);
    // The graph handed in is left as it was, so the next cell does not inherit this one's seed.
    assert.equal(JSON.stringify(graph), before, `${label}: the graph handed in was written to`);
  }
});

// A run posts the graph it is given, at the size and settings pinned in it unless the run names others, with the
// portraits of each frame's own people. What would fail every cell after it stops the run before the card is paid.
test('a run draws its graph at the graph\'s own settings with each frame\'s own faces, and stops on what would fail every cell after it', async t => {
  const own = { width: undefined, height: undefined, steps: undefined, sampler: undefined, scheduler: undefined, cfg: undefined };
  const qwen = { ...own, checkpoints: ['qwen_image_2.1_int8_convrot.safetensors'] };
  const [krea, t2i, edit] = ['gpu/image-workflow.json', 'gpu/image-workflow-qwen.json', 'gpu/image-workflow-qwen-edit.json'].map(file => resolve(file));
  const clean = (index: BatchIndex, label: string) => assert.equal(index.failures.length, 0, `${label}: ${JSON.stringify(index.failures)}`);
  // The file ComfyUI's Save menu writes, the UI format ({nodes:[...],links:[...]}), not the API format the harness fills.
  const saved = corpus();
  t.after(() => rmSync(saved, { recursive: true, force: true }));
  writeFileSync(join(saved, 'ui.json'), JSON.stringify({ last_node_id: 71, version: 0.4, links: [],
    nodes: [{ id: 55, type: 'UNETLoader', widgets_values: ['krea2_turbo_fp8_scaled.safetensors'] }] }));
  const rows: [string, { card?: Parameters<typeof fakeComfy>[0]; references?: References; portrait?: Buffer }, Partial<DrawOptions>,
    RegExp | ((index: BatchIndex, comfy: ReturnType<typeof fakeComfy>, label: string) => void)][] = [
    // Without --size the graph's own size is drawn and recorded: the harness default (1344x768) is another resolution
    // and another aspect ratio, and it used to overwrite this one silently.
    ['the pinned Krea graph', {}, { width: undefined, height: undefined, checkpoints: ['kreamania_variant8_fp8.safetensors'], workflow: krea },
      (index, comfy, label) => {
        clean(index, label);
        const latent = Object.values(comfy.submitted[0]).find(node => node.class_type === 'EmptyLatentImage')!;
        assert.deepEqual([index.comfy.width, index.comfy.height, index.pictures.map(picture => [picture.width, picture.height]),
          latent.inputs.width, latent.inputs.height], [1280, 720, [[1280, 720], [1280, 720]], 1280, 720], `${label}: drawn at another size than the graph pins`);
      }],
    // With no --steps and no --sampler the graph's 25 euler steps are drawn and written down. The harness defaults
    // are 8 er_sde, another picture and another number of rented seconds.
    ['the pinned Qwen graph', {}, { ...qwen, workflow: t2i }, (index, comfy, label) => {
      clean(index, label);
      assert.deepEqual(index.comfy, { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 }, label);
      const sampler = Object.values(comfy.submitted[0]).find(node => node.class_type === 'KSampler')!;
      assert.deepEqual([index.workflow!.file, index.pictures.map(picture => picture.steps), sampler.inputs.steps, sampler.inputs.sampler_name],
        ['image-workflow-qwen.json', [25, 25], 25, 'euler'], label);
    }],
    // A graph this build cannot run, or a server that is not answering, fails the same way for every cell after it.
    ['a graph the server refuses', { card: { refuse: 400 } }, {}, (index, comfy, label) => {
      assert.equal(comfy.attempts.prompt, 1, `${label}: the same refusal is not bought four times`);
      assert.deepEqual([index.failures.map(failure => [failure.code, failure.httpStatus]), index.error],
        [[['comfy_http_error', 400]], 'comfy_http_error'], label);
    }],
    // It used to throw a TypeError inside applyToWorkflow and be written down as `image_failed`, once a cell.
    ['a workflow saved in the UI format', {}, { workflow: join(saved, 'ui.json') }, /API format/],
    // A portrait as it comes off the card, with ComfyUI's own text chunks in it. One portrait, two frames: the same
    // face is not paid for twice on a card billed by the minute, and it goes up under the hash of its stripped bytes,
    // so neither the sheet name, the story nor the prompt that drew it is written onto the rented disk.
    ['a frame with a portrait', { references: elin, portrait: pngWithMetadata('{"prompt":"PORTRAIT_PROMPT"}') }, { ...qwen, workflow: edit },
      (index, comfy, label) => {
        clean(index, label);
        assert.equal(comfy.uploads.length, 1, label);
        const [upload] = comfy.uploads;
        assert.deepEqual([upload.type, upload.overwrite], ['input', 'true'], label);
        assert.match(upload.name, /^ref-[0-9a-f]{16}\.png$/, label);
        assert.ok(!upload.name.includes('lin') && !upload.name.includes('battle'), label);
        assert.deepEqual(chunksOf(upload.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND'], label);
        assert.ok(!upload.bytes.includes('PORTRAIT_PROMPT'), label);
        // Both frames name one person the sheet covers; the salt worker has no portrait and takes no slot.
        assert.deepEqual(index.pictures.map(picture => picture.references), [1, 1], label);
        for (const graph of comfy.submitted) {
          const encode = Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21')!;
          assert.deepEqual(Object.keys(encode.inputs).filter(name => name.startsWith('images.')), ['images.image_1'], label);
          assert.equal(graph[(encode.inputs['images.image_1'] as [string, number])[0]].inputs.image, upload.name, label);
          // The slots this frame does not use are gone, loader and input together: a LoadImage left pointing at a
          // file nobody uploaded fails the whole prompt rather than one picture.
          assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length, 1, label);
        }
      }],
    // Pointed at a graph with no slots, a references run would be an ordinary run whose index claimed portraits it
    // never sent.
    ['references on a graph without slots', { references: elin }, { ...qwen, workflow: t2i }, (index, comfy, label) =>
      assert.deepEqual([index.error, index.pictures.length, comfy.submitted.length], ['workflow_too_few_reference_slots', 0, 0], label)],
    // A picture drawn without its reference is an ordinary picture recorded as one that had a face to keep.
    ['an upload the server takes without naming a file', { card: { refuseUpload: true }, references: elin }, { ...qwen, workflow: edit },
      (index, comfy, label) => assert.deepEqual([index.error, comfy.submitted.length], ['comfy_upload_failed', 0], label)],
    // A portrait that is not there fails the whole run before the first cell, without naming the person: inside the
    // loop it would be an unreadable `image_failed` once per frame.
    ['a references file naming a portrait that is not there', { references: { battle: { 'Элин': 'gone.png' } } },
      { ...qwen, workflow: edit }, /portrait for a person of "battle"/],
  ];
  for (const [label, { card, references, portrait }, more, expected] of rows) {
    const comfy = fakeComfy(card);
    const url = await comfy.listen();
    const root = corpus(references ? identityCases : cases, references, portrait);
    t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
    const run = draw({ ...options(root, url), ...more, ...(references ? { references: join(root, 'references.json') } : {}) });
    if (expected instanceof RegExp) await assert.rejects(run, expected, label);
    else expected(await run, comfy, label);
  }
  // The seeds a run draws, as --seeds names them: `Number('')` is 0, and seed 0 is a whole extra pass over every case.
  for (const [seeds, parsed] of [['7', [7]], ['7, 11', [7, 11]], ['7,', [7]], ['', []], ['7,-1', []], ['7,x', []]] as const) {
    assert.deepEqual(parseSeeds(seeds), parsed, `--seeds '${seeds}'`);
  }
});

// One run has one workflow, and a resume into a directory drawn by another one would leave half a comparison under
// one name, with an index.json describing whichever graph ran last.
test('a run directory holds one graph, and a resume with another one is refused by the graph\'s own hash', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  const first = await draw({ ...options(root, url), checkpoints: ['a.safetensors'] });
  assert.equal(first.workflow!.file, '(built-in)');
  await assert.rejects(draw({ ...options(root, url), checkpoints: ['a.safetensors'], width: undefined,
    height: undefined, workflow: resolve('gpu/image-workflow-qwen.json') }), /one run directory holds one graph/);
});

// Which face is whose is carried by the order and by nothing else: the encoder's tokenizer writes its own
// `<image1> <image2> …` block in front of a prompt that never mentions the references, and `assemblePrompt` writes
// one clause per person in the order of `description.people`, which is the order the slots are filled in.
test('a person with no portrait ends the binding instead of moving the next face up a slot', () => {
  const sheet = [{ name: 'Элин', look: 'A middle-aged woman in grey' }, { name: 'Марк', look: 'A young man in brown' }];
  const both: References = { battle: { 'Элин': 'elin.png', 'Марк': 'mark.png' } };
  const frame = (...who: string[]): Case => ({ id: 'battle-7', scenario: 'battle', index: 7, scene: 'Сцена.', sheet,
    description: { moment: 'At a wheel', shot: 'Wide shot', setting: 'A salt road', objects: '', props: '', light: 'Noon',
      people: who.map(name => ({ who: name, look: '', state: '', action: 'stands' })) },
    prompt: 'Wide shot.', namesStripped: 0, fromSheet: who.length, withoutLook: 0 });
  const rows: [string, Case, References, string[]][] = [
    // `who` comes back inflected, and the same matching as the appearance line has to find it.
    ['an inflected name', identityCases[0], elin, ['elin.png']],
    ['a person the sheet does not cover, after one it does', identityCases[1], elin, ['elin.png']],
    ['another story\'s sheet', identityCases[0], { dance: { 'Элин': 'elin.png' } }, []],
    ['no portraits at all', identityCases[0], {}, []],
    ['two people, in the frame\'s order', frame('Марк', 'Элин'), both, ['mark.png', 'elin.png']],
    // Her portrait in `image_1` would be the face the prompt's first clause describes as a young man in brown, and
    // question 5 of the bundle would read that as one person kept.
    ['the first person off the sheet', frame('salt worker', 'Элин'), both, []],
    // A stranger after them takes nothing away: slots 1..N are still people 1..N of the prompt.
    ['a stranger between two people', frame('Элин', 'salt worker', 'Марк'), both, ['elin.png']],
    // The same face twice is not two people either, and skipping the repeat would shift everybody after it.
    ['the same face twice', frame('Элин', 'Элин', 'Марк'), both, ['elin.png']],
    // A person on the sheet the portrait run drew nothing for is the same case as one who is not on it at all.
    ['the first person without a portrait', frame('Марк', 'Элин'), elin, []],
  ];
  for (const [label, one, references, expected] of rows) assert.deepEqual(portraitsFor(one, references), expected, label);
});

// Four slots were one per person the frame schema of local/illustrate-probe.ts admits (`people` is `maxItems: 4`).
// A frame that arrived with more — a schema the provider did not enforce, a prompts.json written by hand — raises
// `workflow_too_few_reference_slots`, which stops the whole run, and widening the graph afterwards changes its hash,
// which the resume guard refuses: the recovery is to redraw the timeboxed run into a fresh directory.
test('the edit graph holds as many faces as a character sheet has people, so one crowded frame cannot end a run', () => {
  const edit: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen-edit.json'), 'utf8'));
  const values = { checkpoint: 'qwen_image_2.1_int8_convrot.safetensors', prompt: 'a picture', negative: '',
    seed: 7, steps: 25, sampler: 'euler', scheduler: 'simple', width: 1280, height: 704, cfg: 1 };
  // Six: the most characters a story's sheet can hold (`maxItems: 6` on the same file's sheet schema), so the
  // graph is never the thing that runs out. A slot nobody fills leaves with its loader and costs nothing.
  const faces = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'];
  const filled = applyToWorkflow(edit, { ...values, references: faces });
  assert.deepEqual(referenceSlots(filled).map(slot => filled[slot.loader].inputs.image), faces);
  assert.throws(() => applyToWorkflow(edit, { ...values, references: [...faces, 'g.png'] }),
    { code: 'workflow_too_few_reference_slots' });
  // The canvas is the graph's own latent, never the one the encode node makes of the first reference: a frame drawn
  // with upright portraits is still 1280x704.
  const upright = applyToWorkflow(edit, { ...values, references: faces.slice(0, 4) });
  assert.deepEqual(latentSizeOf(upright), { width: 1280, height: 704 });
  assert.deepEqual(Object.values(upright).find(node => node.class_type === 'KSampler')!.inputs.latent_image, ['6', 0]);
  assert.equal(upright['6'].class_type, 'EmptyLatentImage');
  // A reference reaches the encoder at the size the pinned node computes (comfy_extras/nodes_qwen.py:99-168), in
  // multiples of 32 and rounding halves as Python does: a 720x1280 portrait at 704x1280.
  assert.deepEqual(referenceGeometry(720, 1280, 0), [704, 1280]);
  assert.deepEqual(referenceGeometry(1280, 720, 1024), [1376, 768]);
  assert.deepEqual(referenceGeometry(2, 2, 0), [32, 32]);
  assert.deepEqual([encoderResolution(edit), textEncoderOf(edit)], [0, 'qwen_image']);
  // The text-to-image graph takes no reference, so it has no size to hand one at.
  assert.equal(encoderResolution(JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'))), undefined);
  assert.deepEqual(pngSize(pngWithMetadata('{}')), { width: 2, height: 2 });
  // A job's time by the kind of node it was spent in: from one node's start to the next one's is the first node's,
  // and the last runs until the job is over.
  const ran = [{ node: '11', at: 0 }, { node: '1', at: 100 }, { node: '5', at: 1100 }, { node: '4', at: 1600 },
    { node: '7', at: 1610 }, { node: '8', at: 9610 }, { node: '9', at: 9900 }];
  assert.deepEqual(phasesOf(edit, ran, 10000), { loadMs: 1100, encodeMs: 500, otherMs: 110, sampleMs: 8000, decodeMs: 290 });
  assert.deepEqual(phasesOf(edit, [], 10), {});
  // Six slots in slot order, each wired to a LoadImage of its own: two slots on one loader would send one face twice
  // and lose a person. The encode node sees the references through the VAE as well: identity comes from the vision
  // tower, the latents keep the pixels, and without the VAE a reference is a caption, not a face.
  const slots = referenceSlots(edit);
  assert.deepEqual(slots.map(slot => slot.key), ['images.image_1', 'images.image_2', 'images.image_3', 'images.image_4',
    'images.image_5', 'images.image_6']);
  const encode = edit[slots[0].node].inputs;
  assert.deepEqual(Object.keys(encode).filter(name => name.startsWith('images.')).sort(), slots.map(slot => slot.key), 'a slot wired to no loader');
  assert.deepEqual([...new Set(slots.map(slot => edit[slot.loader].class_type))], ['LoadImage']);
  assert.equal(new Set(slots.map(slot => slot.loader)).size, slots.length);
  assert.deepEqual(encode.vae, [Object.keys(edit).find(id => edit[id].class_type === 'VAELoader'), 0]);
  // A graph without reference slots has none to find, so a references run cannot be pointed at it by accident.
  assert.deepEqual([referenceSlots(defaultWorkflow()), referenceSlots(JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8')))], [[], []]);
});

// ComfyUI draws one job at a time. A picture abandoned when the wait runs out keeps the card: the next cell queues
// behind it and inherits its seconds, and the abandoned job's history entry — the whole prompt and workflow in it —
// is written when it finishes, which is after the delete of a plain abandon has already run. Whichever way a picture
// ends, its record is deleted, and the picture never waits for the delete.
test('a picture that outlives the wait is stopped on the card and leaves no record behind', async t => {
  // Once what the picture left running has landed, its record is gone, and nothing else of the history was asked
  // for: never a list of all of it, never a clear of all of it, which only the sweeper on the card does.
  const forgotten = async (comfy: ReturnType<typeof pushingComfy>, label: string) => {
    await settled();
    assert.deepEqual([comfy.seen.cleared, comfy.seen.bare], [['p1'], []], `${label}: the record of a job holds the whole prompt`);
  };
  const rows: [string, (label: string) => Promise<void>][] = [
    // Each abandoned job is taken out of the queue and interrupted, so the next cell starts on a card that is free,
    // and nothing of either is still being drawn once the run is over.
    ['pictures that outlive the wait', async label => {
      const comfy = serialComfy(1500);
      const url = await comfy.listen();
      const root = corpus();
      t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
      const index = await draw({ ...options(root, url), checkpoints: ['a.safetensors'], waitMs: 150, pollMs: 10 });
      assert.deepEqual(index.failures.map(failure => failure.code), ['image_timeout', 'image_timeout'], label);
      assert.deepEqual([comfy.seen.interrupts, comfy.seen.queueDeletes, comfy.onTheCard()], [2, 2, 0],
        `${label}: a job the harness gave up on is still the card's`);
      comfy.settle();
      assert.deepEqual([...comfy.history.keys()], [], `${label}: the record of an abandoned job holds the whole prompt`);
    }],
    // Astra's case against the end of a stage: a job of 10 ms whose picture takes 300 ms to come down, 150 ms before
    // the end. The download is cut at the end, the cell stays undrawn and is nobody's failure, and the run stops
    // then, not before the next cell.
    ['a download the end of a stage cuts', async label => {
      const comfy = pushingComfy({ jobMs: 10, viewMs: 300 });
      const url = await comfy.listen();
      const root = corpus();
      t.after(() => { comfy.close(); rmSync(root, { recursive: true, force: true }); });
      const until = Date.now() + 150;
      const cut = await draw({ ...options(root, url), checkpoints: ['a.safetensors'], until, pollMs: 10 });
      const past = Date.now() - until;
      assert.deepEqual([cut.pictures.length, cut.failures.length, cut.stopped, comfy.seen.posted.length, comfy.seen.cleared],
        [0, 0, 'budget', 1, ['p1']], label);
      assert.ok(past < 100, `${label}: the run ended ${past} ms past the end`);
      await forgotten(comfy, label);
    }],
    // A card that takes the interrupt and goes on drawing is looked at until the reserve and not past it: the pause
    // between two looks, five seconds here, ends there too, so the reserve's minute is all a stop can take.
    ['a card that draws on through the interrupt', async label => {
      const comfy = serialComfy(1500);
      const url = await comfy.listen();
      t.after(() => comfy.server.close());
      comfy.stubborn = true;
      const reserve = Date.now() + 1000;
      await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000, end: AbortSignal.timeout(500), reserve: AbortSignal.timeout(1000) },
        defaultWorkflow(), { pollMs: 5000, waitMs: 20000 }), { code: 'out_of_time' }, label);
      const over = Date.now() - reserve;
      assert.deepEqual([comfy.seen.submitted, comfy.seen.interrupts, comfy.seen.interrupted.length], [1, 1, 0], label);
      assert.ok(over < 500, `${label}: the stop went on ${over} ms past the reserve`);
    }],
    // Drawn, with a delete the card takes a second to answer.
    ['a picture drawn', async label => {
      const comfy = pushingComfy({ jobMs: 50, deleteMs: 1000 });
      const url = await comfy.listen();
      t.after(comfy.close);
      const started = performance.now();
      await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
      const took = performance.now() - started;
      assert.ok(took < 800, `${label}: the picture took ${Math.round(took)} ms behind a delete of 1000`);
      assert.deepEqual(comfy.seen.cleared, [], `${label}: the delete is still on its way`);
      await forgotten(comfy, label);
    }],
    ['a picture the card fails', async label => {
      const comfy = pushingComfy({ outcome: 'error', jobMs: 50 });
      const url = await comfy.listen();
      t.after(comfy.close);
      await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 }),
        { code: 'image_failed' }, label);
      await forgotten(comfy, label);
    }],
    // Given up by the caller while the card draws: stopped on the card first, then forgotten.
    ['a picture given up while the card draws it', async label => {
      const comfy = pushingComfy({ jobMs: 60000 });
      const url = await comfy.listen();
      t.after(comfy.close);
      const stop = new AbortController();
      const drawing = drawOne({ baseUrl: url, timeoutMs: 5000, signal: stop.signal }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
      for (let attempt = 0; attempt < 500 && !comfy.seen.said.some(one => one.type === 'execution_start'); attempt++) await delay(2);
      stop.abort();
      await assert.rejects(drawing, { code: 'cancelled' }, label);
      assert.equal(comfy.seen.interrupts, 1, `${label}: the card was told to stop drawing it`);
      await forgotten(comfy, label);
    }],
    // A poll the card answers with an error status while the job is still being drawn: the job is interrupted, and
    // its record deleted once it has been written. A card that takes the interrupt and draws on is a stop nobody can
    // confirm, and the code for it stops the run.
    ['a poll the card answers with an error', async label => {
      const comfy = serialComfy(60000);
      const url = await comfy.listen();
      t.after(() => comfy.server.close());
      comfy.failPolls = 1;
      await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 }),
        { code: 'comfy_http_error' }, label);
      await settled();
      assert.deepEqual([comfy.seen.interrupted, comfy.onTheCard(), [...comfy.history.keys()]], [['p1'], 0, []], label);
      comfy.stubborn = true;
      comfy.failPolls = 1;
      await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 }),
        { code: 'comfy_stop_unconfirmed' }, label);
    }],
  ];
  for (const [label, row] of rows) await row(label);
});

// Two readers share one card (local/picture.ts), and the job on it may be somebody else's, who is still waiting for
// it. A reader who gives up before the submit puts nothing on the card; one who gives up once the card has taken it,
// while it waits in the queue, takes it out of the queue and stops nothing else. The job being stopped may also end,
// and another reader's take the card, between the read of the queue and the interrupt: an interrupt without an id
// stopped theirs then, and they got the failure line under a scene they never touched. It names its job now.
test('a stop never interrupts another reader\'s job, whether it comes before the submit, in the queue or as their job takes the card', async t => {
  const picture = (url: string, more: Pick<Comfy, 'signal' | 'end' | 'reserve'> = {}) =>
    drawOne({ baseUrl: url, timeoutMs: 5000, ...more }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 });
  const card = async (jobMs: number) => {
    const comfy = serialComfy(jobMs);
    const url = await comfy.listen();
    t.after(() => comfy.server.close());
    const taken = async (count: number) => { for (let attempt = 0; attempt < 500 && comfy.seen.submitted < count; attempt++) await delay(2); };
    return { comfy, url, taken };
  };
  // Their picture, on the card when ours is given up.
  const behind = async () => {
    const { comfy, url, taken } = await card(400);
    const theirs = picture(url);
    await taken(1);
    return { comfy, url, theirs };
  };
  const rows: [string, (label: string) => Promise<{ comfy: ReturnType<typeof serialComfy>; theirs: ReturnType<typeof drawOne> }>][] = [
    ['given up before the submit', async label => {
      const { comfy, url, theirs } = await behind();
      await assert.rejects(picture(url, { signal: AbortSignal.abort() }), { code: 'cancelled' }, label);
      assert.deepEqual([comfy.seen.submitted, comfy.seen.queueDeletes, comfy.seen.interrupts], [1, 0, 0], `${label}: nothing was sent, and nothing stopped`);
      return { comfy, theirs };
    }],
    // Its answer is still read, which is the order `drawOne` keeps on purpose, since a job with no id is a job nobody
    // can stop. A job that never ran writes no record, so none is waited for: ten polls used to run out under every
    // cancelled picture, and `idle()` waited them out.
    ['given up the moment the card took the submit', async label => {
      const { comfy, url, theirs } = await behind();
      const late = new AbortController();
      comfy.onSubmit = () => late.abort();
      await assert.rejects(picture(url, { signal: late.signal }), { code: 'cancelled' }, label);
      assert.deepEqual([comfy.seen.submitted, comfy.seen.queueDeletes, comfy.polls.get('p2') ?? 0], [2, 1, 0],
        `${label}: taken out of the queue, and no record waited for`);
      return { comfy, theirs };
    }],
    // The end of an identity stage, come the moment the card took the submit, is answered the same way, within the
    // reserve.
    ['a stage ended the moment the card took the submit', async label => {
      const { comfy, url, theirs } = await behind();
      const end = new AbortController();
      comfy.onSubmit = () => end.abort();
      await assert.rejects(picture(url, { end: end.signal, reserve: AbortSignal.timeout(60000) }), { code: 'out_of_time' }, label);
      assert.deepEqual([comfy.seen.submitted, comfy.seen.queueDeletes, comfy.polls.get('p2') ?? 0], [2, 1, 0], label);
      return { comfy, theirs };
    }],
    ['stopped as their job takes the card', async label => {
      const { comfy, url, taken } = await card(300);
      const stop = new AbortController();
      const mine = picture(url, { signal: stop.signal });
      await taken(1);
      const theirs = picture(url);
      await taken(2);
      comfy.afterQueueRead = () => comfy.end('p1');
      stop.abort();
      await assert.rejects(mine, { code: 'cancelled' }, label);
      assert.equal(comfy.seen.interrupts, 1, label);
      return { comfy, theirs };
    }],
  ];
  for (const [label, row] of rows) {
    const { comfy, theirs } = await row(label);
    assert.deepEqual(comfy.seen.interrupted, [], `${label}: the interrupt stopped another reader's picture`);
    assert.ok((await theirs).bytes.length > 0, `${label}: the other reader's picture was drawn and delivered`);
    // The stopped job's record, which holds the whole prompt, was waited for where there was one, and deleted.
    await settled();
    comfy.settle();
    assert.deepEqual([...comfy.history.keys()], [], label);
  }
});

// The server's half of a websocket (RFC 6455), as much of it as a fake ComfyUI needs: the handshake, unmasked text
// frames, and an answer to the client's close. A close left unanswered keeps undici's WebSocket, and with it the test
// process, alive for a minute.
const CLOSE_FRAME = Buffer.from([0x88, 0]);
function acceptSocket(request: IncomingMessage, socket: Duplex) {
  socket.on('error', () => undefined);
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  // The client only ever sends its close frame (opcode 8).
  socket.on('data', (chunk: Buffer) => { if ((chunk[0] & 0x0f) === 8) { if (socket.writable) socket.end(CLOSE_FRAME); else socket.destroy(); } });
  return {
    send(message: object) {
      const data = Buffer.from(JSON.stringify(message), 'utf8');
      // FIN and the text opcode, then the length in seven bits or in sixteen; ComfyUI's messages here are short.
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      if (socket.writable) socket.write(Buffer.concat([head, data]));
    },
    hangUp() { if (socket.writable) socket.end(CLOSE_FRAME); },
  };
}

// ComfyUI with its websocket, as the picture card runs it: a job's messages go to the socket of the client id it was
// submitted with, in the order execution.py and main.py send them — `execution_start`, `executed` with the node's
// output, `execution_success` (or `execution_error`, or `execution_interrupted`), then the record is written, then
// `executing` with no node. `socket` is what the socket does: 'open' hears whatever is sent once it is open; 'late'
// opened after the job began and missed its start; 'silent' is accepted and never spoken to; 'closing' hears the
// start and is hung up on; 'refused' is answered 404. `openMs` holds the handshake back that long, and a job submitted
// meanwhile is told nothing of its start, as by the real server. `quietEnd` leaves out the last message, and `statsMs`,
// `deleteMs` and `viewMs` hold /system_stats, the delete and the picture back that long. With `cache` a graph identical
// to the one the card ran last is answered from its cache, whose output names the earlier job's file, and `sweep`
// deletes a file once no record names it, as gpu/image-sweeper.py does. `dropPolls` closes that many reads of a job's
// record without an answer, as a tunnel does when it drops one. Every /history request that is not one `drawOne` may
// make, a read or a delete of one job by its id, is kept in `bare`.
function pushingComfy(options: { socket?: 'open' | 'late' | 'silent' | 'closing' | 'refused'; openMs?: number;
  outcome?: 'success' | 'error' | 'interrupted'; quietEnd?: boolean; jobMs?: number; statsMs?: number; deleteMs?: number; viewMs?: number;
  cache?: boolean; dropPolls?: number } = {}) {
  const mode = options.socket ?? 'open';
  const records = new Map<string, object>();
  const files = new Set<string>();
  const outputs = new Map<string, string>();
  const graphs: Graph[] = [];
  const clientOf = new Map<string, string>();
  const speakers = new Map<string, ReturnType<typeof acceptSocket>>();
  const upgraded = new Set<Duplex>();
  const seen = { posted: [] as string[], connected: [] as string[], reads: [] as string[], cleared: [] as string[],
    bare: [] as string[], said: [] as { type: string; at: number }[], interrupts: 0 };
  let running: string | undefined;
  let count = 0, dropped = 0;
  let last: { signature: string; file: string } | undefined;
  const tell = (id: string, type: string, data: object = {}) => {
    const speaker = speakers.get(clientOf.get(id)!);
    if (!speaker) return;
    speaker.send({ type, data: { ...data, prompt_id: id } });
    seen.said.push({ type: type === 'executing' && (data as { node?: unknown }).node === null ? 'over' : type, at: performance.now() });
  };
  const finish = (id: string, outcome: 'success' | 'error' | 'interrupted') => {
    if (running !== id) return;
    running = undefined;
    const file = { filename: outputs.get(id)!, subfolder: '', type: 'temp' };
    if (outcome === 'success') {
      tell(id, 'executing', { node: '7' });
      // A socket that opened late missed the start, so what it did hear is not vouched for: here the output it hears
      // names a file /view does not have, and a picture drawn from it fails.
      tell(id, 'executed', { node: '7', output: { images: [mode === 'late' ? { ...file, filename: 'elsewhere.png' } : file] } });
      tell(id, 'execution_success');
    } else tell(id, `execution_${outcome}`, { node_id: '5', node_type: 'KSampler', executed: [] });
    records.set(id, outcome === 'success' ? { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [file] } } }
      : { status: { completed: false, status_str: 'error' }, outputs: {} });
    if (!options.quietEnd) tell(id, 'executing', { node: null });
  };
  const begin = (id: string) => {
    running = id;
    if (mode !== 'late') tell(id, 'execution_start');
    tell(id, 'execution_cached', { nodes: [] });
    tell(id, 'progress', { value: 1, max: 8, node: '5' });
    if (mode === 'closing') { speakers.get(clientOf.get(id)!)?.hangUp(); speakers.delete(clientOf.get(id)!); }
    // Unreferenced, so that a job nobody waits for any more does not keep the test process alive.
    setTimeout(() => finish(id, options.outcome ?? 'success'), options.jobMs ?? 0).unref();
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const asked = await body() as { prompt: Graph; client_id?: unknown };
        const id = `p${++count}`;
        graphs.push(asked.prompt);
        seen.posted.push(String(asked.client_id));
        clientOf.set(id, String(asked.client_id));
        const signature = JSON.stringify(asked.prompt);
        if (!options.cache || last?.signature !== signature) { last = { signature, file: `${id}.png` }; files.add(last.file); }
        outputs.set(id, last.file);
        begin(id);
        return json({ prompt_id: id, number: count });
      }
      if (url.pathname === '/system_stats') {
        await delay(options.statsMs ?? 0);
        return json({ devices: [{ index: 0, vram_total: 32 * 1024 ** 3, vram_free: 2 * 1024 ** 3 }] });
      }
      if (request.method === 'GET' && /^\/history\/p\d+$/.test(url.pathname)) {
        if (dropped < (options.dropPolls ?? 0)) { dropped++; request.socket.destroy(); return; }
        const id = url.pathname.slice('/history/'.length);
        seen.reads.push(id);
        return json(records.has(id) ? { [id]: records.get(id) } : {});
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        const asked = await body() as { delete?: unknown };
        const ids = Array.isArray(asked.delete) ? asked.delete as string[] : [];
        if (Object.keys(asked).join() !== 'delete' || ids.length !== 1 || !clientOf.has(ids[0])) seen.bare.push(`POST ${JSON.stringify(asked)}`);
        await delay(options.deleteMs ?? 0);
        for (const id of ids) { records.delete(id); seen.cleared.push(id); }
        return json({});
      }
      if (url.pathname.includes('history')) { seen.bare.push(`${request.method} ${url.pathname}`); return json({}); }
      if (url.pathname === '/queue' && request.method === 'GET') return json({ queue_running: running ? [[0, running]] : [], queue_pending: [] });
      if (url.pathname === '/queue') { await body(); return json({}); }
      if (url.pathname === '/interrupt') {
        seen.interrupts++;
        const named = (await body().catch(() => ({})) as { prompt_id?: unknown }).prompt_id;
        if (running && (named === undefined || named === running)) finish(running, 'interrupted');
        return json({});
      }
      if (url.pathname === '/view' && files.has(String(url.searchParams.get('filename')))) {
        await delay(options.viewMs ?? 0);
        response.setHeader('content-type', 'image/png');
        return response.end(pngWithMetadata('{"prompt":"PRIVATE_SCENE_TEXT"}'));
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  // Without a listener for it, the upgrade reaches the handler above as a plain request, and /ws is answered 404.
  if (mode !== 'refused') server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    setTimeout(() => {
      if (socket.destroyed) return;
      const speaker = acceptSocket(request, socket);
      const clientId = new URL(request.url!, 'http://127.0.0.1').searchParams.get('clientId') ?? '';
      seen.connected.push(clientId);
      if (mode === 'silent') return;
      // The greeting ComfyUI sends every socket first (server.py:287); it names no job.
      speaker.send({ type: 'status', data: { status: { exec_info: { queue_remaining: running ? 1 : 0 } }, sid: clientId } });
      speakers.set(clientId, speaker);
      socket.on('close', () => { if (speakers.get(clientId) === speaker) speakers.delete(clientId); });
    }, options.openMs ?? 0);
  });
  const over = () => seen.said.find(one => one.type === 'over');
  const sweep = () => {
    const named = new Set([...records.keys()].map(id => outputs.get(id)));
    for (const file of files) if (!named.has(file)) files.delete(file);
  };
  return { seen, over, graphs, sweep,
    listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => { for (const socket of upgraded) socket.destroy(); server.close(); } };
}

// ComfyUI answers a graph identical to the one it ran last from its cache, whose output names the earlier job's file,
// and gpu/image-sweeper.py deletes a preview's file once no record names it.
test('a graph drawn again writes a file of its own, and the one the sweeper took is never asked for', async t => {
  const comfy = pushingComfy({ socket: 'refused', cache: true });
  const url = await comfy.listen();
  t.after(comfy.close);
  const graph = defaultWorkflow();
  await drawOne({ baseUrl: url, timeoutMs: 5000 }, graph, { pollMs: 5, waitMs: 5000 });
  // The first job's record is deleted once its picture is out, and the sweeper takes the file then.
  await settled();
  comfy.sweep();
  // The same frame in the same style: without a key of its own the card answered from its cache with a deleted file.
  assert.ok((await drawOne({ baseUrl: url, timeoutMs: 5000 }, graph, { pollMs: 5, waitMs: 5000 })).bytes.length > 0);
  const [first, second] = comfy.graphs;
  assert.notEqual(first['7'].inputs.nonce, second['7'].inputs.nonce);
  // Nothing else of the graph differs, so the card still takes the sampler's result from its cache.
  const without = (drawn: Graph) => ({ ...drawn, 7: { ...drawn['7'], inputs: { images: drawn['7'].inputs.images } } });
  assert.deepEqual(without(first), graph);
  assert.deepEqual(without(second), graph);
  assert.equal(graph['7'].inputs.nonce, undefined, 'the caller\'s graph is left as it was');
});

// The poll interval is ten seconds in the rows that time the wait (`ten`), so that nothing but the socket can end it
// in time. Every row's card is its own, and every picture drawn is stripped.
test('the wait for a picture ends on the socket\'s word or on the polls, whatever the socket, the tunnel or /system_stats do', async t => {
  const ten = { pollMs: 10000, waitMs: 20000 };
  const rows: [string, Parameters<typeof pushingComfy>[0], { pollMs: number; waitMs: number; requireSocket?: boolean;
    signals?: () => Pick<Comfy, 'signal' | 'end'> }, { fails?: object; word?: string; within?: number; reads?: string[] | 'polled';
    connected?: boolean; posted?: number; timed?: boolean; vram?: boolean }][] = [
    // The socket's word that the job is over ends the wait at once. It listens under the client id the job was
    // submitted with, or it would hear nothing of it, and the outputs it heard are the record's own: the record is
    // read once, right after the submit, and not again once the job is over.
    ['a socket that hears the whole job', { jobMs: 150 }, ten, { word: 'over', reads: ['p1'], connected: true }],
    // A socket that opens late, as one through a tunnel may: the submit waits for it, so the job is still heard from
    // its start, and the picture knows where its time went and whether its loaders ran.
    ['a socket that opens late', { jobMs: 50, openMs: 300 }, ten, { reads: ['p1'], timed: true }],
    // Astra's cases, each well inside the socket's 300 ms: each ends the wait for the socket then, and nothing is
    // submitted.
    ['a cancel while the socket opens', { openMs: 300 }, { ...ten, signals: () => ({ signal: AbortSignal.timeout(20) }) },
      { fails: { code: 'cancelled' }, within: 200, posted: 0 }],
    ['the end of a stage while the socket opens', { openMs: 300 }, { ...ten, signals: () => ({ end: AbortSignal.timeout(80) }) },
      { fails: { code: 'out_of_time' }, within: 200, posted: 0 }],
    ['a wait the socket uses up', { openMs: 300 }, { ...ten, waitMs: 80 }, { fails: { code: 'image_timeout' }, within: 200, posted: 0 }],
    // A socket that opened after the job began is not taken at its word for the outputs: the one it heard names a file
    // the card does not have, and the record is read.
    ['a socket that opened after the job began', { socket: 'late', jobMs: 150 }, ten, { word: 'over', reads: ['p1', 'p1'] }],
    // A socket that is refused, says nothing or hangs up leaves the picture to the polls, as before the socket: a poll
    // every 20 ms finds a job of 100 ms in about that, and waiting on a socket with nothing to say would not.
    ['a socket refused', { socket: 'refused', jobMs: 100 }, { pollMs: 20, waitMs: 5000 }, { within: 1000, reads: 'polled', connected: false }],
    ['a socket that says nothing', { socket: 'silent', jobMs: 100 }, { pollMs: 20, waitMs: 5000 }, { within: 1000, reads: 'polled', connected: true }],
    ['a socket that hangs up', { socket: 'closing', jobMs: 100 }, { pollMs: 20, waitMs: 5000 }, { within: 1000, reads: 'polled', connected: true }],
    // A run that measures the card (`requireSocket`) fails the cell instead, before anything reaches the card.
    ['a socket refused to a run that measures the card', { socket: 'refused' }, { ...ten, requireSocket: true },
      { fails: { code: 'comfy_socket_unavailable' }, posted: 0 }],
    // No socket, so the wait is the polls', and a sample of video memory waited for inside it would hold the next poll
    // back. Its answer joins the video memory when it lands.
    ['a slow /system_stats', { socket: 'refused', jobMs: 100, statsMs: 1500 }, { pollMs: 10, waitMs: 5000 }, { within: 1000, vram: true }],
    // Without the closing `executing` message, so that only the error itself can end a ten-second wait in time. The
    // record, read then, says how the job ended.
    ['an error on the socket', { outcome: 'error', quietEnd: true, jobMs: 100 }, ten,
      { fails: { code: 'image_failed' }, word: 'execution_error', reads: ['p1', 'p1'] }],
    ['an interrupt on the socket', { outcome: 'interrupted', quietEnd: true, jobMs: 100 }, ten,
      { fails: { code: 'image_failed' }, word: 'execution_interrupted', reads: ['p1', 'p1'] }],
    // A poll the tunnel drops is asked again, and a card that stops answering still ends the picture.
    ['three polls the tunnel drops', { socket: 'refused', dropPolls: 3 }, { pollMs: 5, waitMs: 5000 }, { reads: ['p1'] }],
    ['a card that stops answering the polls', { socket: 'refused', dropPolls: 4 }, { pollMs: 5, waitMs: 5000 }, { fails: Error, reads: [] }],
  ];
  for (const [label, card, wait, expected] of rows) {
    const comfy = pushingComfy(card);
    const url = await comfy.listen();
    t.after(comfy.close);
    const began = performance.now();
    const drawing = drawOne({ baseUrl: url, timeoutMs: 5000, ...wait.signals?.() }, defaultWorkflow(), wait);
    let drawn: Awaited<typeof drawing> | undefined;
    if (expected.fails) await assert.rejects(drawing, expected.fails, label);
    else drawn = await drawing;
    const ended = performance.now();
    if (expected.vram) assert.deepEqual(drawn?.vram, [], `${label}: nothing has answered yet`);
    if (drawn) {
      assert.deepEqual(chunksOf(drawn.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND'], label);
      assert.ok(!Buffer.from(drawn.bytes).includes('PRIVATE_SCENE_TEXT'), label);
    }
    const word = comfy.seen.said.find(one => one.type === expected.word);
    if (expected.word) assert.ok(ended - word!.at < 100, `${label}: the wait ended ${Math.round(ended - word!.at)} ms after the card's word`);
    if (expected.within) assert.ok(ended - began < expected.within, `${label}: the wait took ${Math.round(ended - began)} ms`);
    if (expected.reads === 'polled') {
      assert.ok(comfy.seen.reads.length > 1 && comfy.over() === undefined, `${label}: the polls found the record, and the socket heard no end`);
    } else if (expected.reads) assert.deepEqual(comfy.seen.reads, expected.reads, label);
    if (expected.connected !== undefined) assert.deepEqual(comfy.seen.connected, expected.connected ? comfy.seen.posted : [], label);
    if (expected.timed) assert.equal(drawn?.timing?.loaderCacheMiss, true, label);
    assert.equal(comfy.seen.posted.length, expected.posted ?? 1, label);
    await settled();
    if (expected.vram) assert.deepEqual(drawn?.vram, [{ index: 0, totalMiB: 32768, usedMiBMax: 30720 }], label);
    assert.deepEqual([comfy.seen.cleared, comfy.seen.bare], [expected.posted === 0 ? [] : ['p1'], []], label);
  }
});

// index.json is the record of the cells, not of the attempts: a cell drawn on the second run is not also a failure,
// and a cell drawn twice is not two pictures — `bundles` would deal one picture into two neutral names.
test('a resume forgets the failure of a cell it has drawn, and records no cell twice', async t => {
  const failing = fakeComfy({ failCase: 'A hall' });
  const comfy = fakeComfy();
  const [failingUrl, url] = [await failing.listen(), await comfy.listen()];
  const root = corpus();
  t.after(() => { failing.server.close(); comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const first = await draw({ ...options(root, failingUrl), checkpoints: ['a.safetensors'] });
  assert.equal(first.pictures.length, 1);
  assert.equal(first.failures.length, 1);
  const second = await draw({ ...options(root, url), checkpoints: ['a.safetensors'] });
  assert.equal(second.pictures.length, 2);
  assert.deepEqual(second.failures, [], 'a cell that has its picture is not a failure of the run');

  // A picture lost from the disk while index.json keeps its row: the cell is drawn again and replaces that row.
  rmSync(join(root, 'run', second.pictures[0].file));
  const third = await draw({ ...options(root, url), checkpoints: ['a.safetensors'] });
  assert.equal(third.pictures.length, 2);
  assert.equal(new Set(third.pictures.map(picture => picture.file)).size, 2);
  assert.equal(buildBundles(join(root, 'run'), 1)[0].pictures.length, 2);
});

test('the batch draws every cell, records the seconds and video memory, and clears the server history', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const index = await draw(options(root, url));
  assert.equal(index.pictures.length, 4);
  assert.equal(index.failures.length, 0);
  // Checkpoint-major: an early stop leaves whole comparable blocks.
  assert.deepEqual(index.pictures.map(picture => picture.role), ['primary', 'primary', 'alternate', 'alternate']);
  assert.deepEqual(comfy.submitted.map(graph => graph['1'].inputs.ckpt_name),
    ['kreamania-fp8.safetensors', 'kreamania-fp8.safetensors', 'krea-2-turbo.safetensors', 'krea-2-turbo.safetensors']);
  assert.equal(comfy.submitted[0]['2'].inputs.text, cases[0].prompt);
  assert.equal(comfy.submitted[0]['5'].inputs.seed, 7);
  for (const picture of index.pictures) {
    assert.ok(picture.totalMs >= 0 && picture.viewMs >= 0);
    assert.deepEqual(picture.vram, [{ index: 0, totalMiB: 32768, usedMiBMax: 30720 }]);
    const written = readFileSync(join(root, 'run', picture.file));
    assert.deepEqual(chunksOf(written).map(one => one.type), ['IHDR', 'IDAT', 'IEND']);
    assert.ok(!written.includes('Medium shot') && !written.includes('ckpt_name'));
    assert.equal(picture.bytes, written.length);
  }
  // The job record is cleared from the server. Its own copy of the picture is not ours to delete over the API, so
  // it is asked for in the server's temp area, which ComfyUI empties itself, and the card is wiped when it goes.
  assert.deepEqual(comfy.cleared, ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(comfy.viewed, ['temp', 'temp', 'temp', 'temp']);
  assert.equal(defaultWorkflow()['7'].class_type, 'PreviewImage');

  // A second run is a resume: the cells that have their file are not drawn again.
  const again = await draw(options(root, url));
  assert.equal(comfy.submitted.length, 4);
  assert.equal(again.pictures.length, 4);
});

// Two builds of one checkpoint are published under the same stem (.safetensors and .gguf). Sharing a file made the
// second one read as already drawn and skipped, and a comparison run then compared a checkpoint with itself.
test('checkpoints that differ only in their extension are both drawn, and a repeated cell is refused', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const index = await draw({ ...options(root, url), checkpoints: ['flux-dev.safetensors', 'flux-dev.gguf'] });
  assert.equal(index.pictures.length, 4);
  assert.equal(new Set(index.pictures.map(picture => picture.file)).size, 4);
  assert.deepEqual(comfy.submitted.map(graph => graph['1'].inputs.ckpt_name),
    ['flux-dev.safetensors', 'flux-dev.safetensors', 'flux-dev.gguf', 'flux-dev.gguf']);
  // A repeat costs rented card time and records nothing, so it is refused before the first picture, by the file the
  // two cells would share: a scene named twice in prompts.json reads like a repeated checkpoint or seed otherwise.
  await assert.rejects(draw({ ...options(root, url), out: join(root, 'twice'), seeds: [7, 7] }),
    /pictures\/kreamania-fp8\.safetensors\/battle-2-s7\.png/);
  assert.equal(comfy.submitted.length, 4);
});

test('a cell the server fails is recorded by its code and the batch goes on', async t => {
  const comfy = fakeComfy({ failCase: 'A hall' });
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const index = await draw(options(root, url));
  assert.equal(index.pictures.length, 2);
  // The cell is on the row, so a later run that draws it can take its failure off again.
  assert.deepEqual(index.failures, [
    { caseId: 'dance-12', checkpoint: 'kreamania-fp8.safetensors', role: 'primary', seed: 7, code: 'image_failed' },
    { caseId: 'dance-12', checkpoint: 'krea-2-turbo.safetensors', role: 'alternate', seed: 7, code: 'image_failed' }]);
  // A picture the server failed to draw is not a reason to stop: the next checkpoint may draw it.
  assert.equal(index.error, undefined);
  // A failed job is forgotten by the server as well.
  assert.equal(comfy.cleared.length, 4);
});

test('a review bundle names no checkpoint, and the key that does stays outside it', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  await draw(options(root, url));

  const bundles = buildBundles(join(root, 'run'), 2);
  assert.deepEqual(bundles.map(bundle => bundle.name), ['bundle-1', 'bundle-2']);
  // The bundles have a parent of their own: mounting it for a judging session shows bundles and nothing else, while
  // the run directory beside it names the checkpoints in `pictures/` and answers them in `keys/`.
  assert.deepEqual(readdirSync(join(root, 'run', REVIEW)).sort(), ['bundle-1', 'bundle-2']);
  assert.ok(readdirSync(join(root, 'run')).includes('keys'));
  for (const bundle of bundles) {
    const folder = join(root, 'run', REVIEW, bundle.name);
    const files = readdirSync(folder).sort();
    assert.deepEqual(files, ['TASK.md', 'cases.json', 'pic-01.png', 'pic-02.png']);
    const readable = files.filter(name => !name.endsWith('.png')).map(name => readFileSync(join(folder, name), 'utf8')).join('\n');
    for (const name of ['kreamania', 'krea-2-turbo', 'safetensors', 'seed']) assert.ok(!readable.includes(name), `${name} is in ${bundle.name}`);
    const material = JSON.parse(readFileSync(join(folder, 'cases.json'), 'utf8')) as { picture: string; scene_text_ru: string; prompt_sent: string }[];
    assert.deepEqual(material.map(one => one.picture), ['pic-01.png', 'pic-02.png']);
    assert.ok(material.every(one => one.scene_text_ru.startsWith('Сцена') && one.prompt_sent.endsWith('Hand-painted.')));
    assert.match(readFileSync(join(folder, 'TASK.md'), 'utf8'), /^Ты оцениваешь сгенерированные иллюстрации, их здесь 2\./);
    // The task states what the assembly does about names, not an absolute the assembly cannot hold, and asks for a
    // name that got through: a session told names cannot be there is the one reader primed to skip one.
    const task = readFileSync(join(folder, 'TASK.md'), 'utf8');
    assert.ok(!task.includes('Имена до модели картинок не доходят'));
    assert.match(task, /Если в `prompt_sent` осталось имя/);
    // Question 5 asks about the style and the people apart, and about a face and a figure apart: an even style
    // hides changing faces, and a face on a body that lost its build is no person kept.
    assert.match(task, /а\) Стиль: держится ли один стиль/);
    assert.match(task, /б\) Люди: .*отдельно по лицу и отдельно по фигуре/);
    assert.match(task, /Лицо на месте, а телосложение потеряно — это провал фигуры/);
    assert.ok(!task.includes('checks.json'), 'the sheet of checks belongs to an identity bundle');
    // Each session sees both checkpoints, so no bundle is about one of them.
    const key = JSON.parse(readFileSync(join(root, 'run', 'keys', `${bundle.name}.json`), 'utf8')) as { checkpoint: string }[];
    assert.equal(new Set(key.map(one => one.checkpoint)).size, 2);
    assert.ok(!existsSync(join(folder, `${bundle.name}.json`)));
  }
});

test('bundles are dealt by the picture\'s own hash, so neither the drawing order nor the checkpoint shows', () => {
  const picture = (sha256: string, checkpoint: string): Picture => ({ caseId: 'battle-2', checkpoint, role: 'primary', seed: 7,
    steps: 8, sampler: 'er_sde', scheduler: 'simple', width: 1344, height: 768, totalMs: 1000, viewMs: 10, vram: [],
    bytes: 100, sha256, file: `pictures/${checkpoint}/battle-2-s7.png` });
  const made = bundlesOf([picture('dd', 'a'), picture('aa', 'b'), picture('cc', 'a'), picture('bb', 'b')], 2);
  assert.deepEqual(made.map(bundle => bundle.pictures.map(entry => entry.source.sha256)), [['aa', 'cc'], ['bb', 'dd']]);
  assert.deepEqual(made.map(bundle => bundle.pictures.map(entry => entry.picture)), [['pic-01.png', 'pic-02.png'], ['pic-01.png', 'pic-02.png']]);
  assert.equal(bundlesOf([], 3).length, 0);
});
