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
import { draw, buildBundles, bundlesOf, applyToWorkflow, defaultWorkflow, drawOne, encoderResolution, latentSizeOf, parseSeeds, phasesOf, pngSize, portraitsFor, referenceGeometry, referenceSlots, samplerSettingsOf, settled, stripPngMetadata, taskMarkdown, textEncoderOf, REVIEW } from './image-batch.ts';
import type { Graph, Picture, References } from './image-batch.ts';
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
// interrupt and goes on drawing.
function serialComfy(jobMs: number) {
  const prompts = new Map<string, string>();
  const finishAt = new Map<string, number>();
  const history = new Map<string, string>();
  const polls = new Map<string, number>();
  const seen = { submitted: 0, interrupts: 0, queueDeletes: 0, interrupted: [] as string[] };
  let busyUntil = 0;
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

function corpus() {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-batch-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(cases));
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

test('the workflow takes the checkpoint, the prompt and the seed by the role of the node, not by its number', () => {
  const filled = applyToWorkflow(defaultWorkflow(), { checkpoint: 'k.safetensors', prompt: 'a picture', negative: 'blurry',
    seed: 11, steps: 8, sampler: 'er_sde', scheduler: 'simple', width: 1344, height: 768, cfg: 1 });
  assert.equal(filled['1'].inputs.ckpt_name, 'k.safetensors');
  assert.equal(filled['2'].inputs.text, 'a picture');
  assert.equal(filled['3'].inputs.text, 'blurry');
  assert.equal(filled['5'].inputs.seed, 11);
  assert.equal(filled['4'].inputs.width, 1344);
  // The template itself is left alone, so the next cell does not inherit this one's seed.
  assert.equal(defaultWorkflow()['5'].inputs.seed, 0);
  assert.throws(() => applyToWorkflow({ '1': { class_type: 'SaveImage', inputs: {} } }, { checkpoint: 'k', prompt: 'p',
    negative: '', seed: 1, steps: 8, sampler: 'er_sde', scheduler: 'simple', width: 512, height: 512, cfg: 1 }), /sampler/);
});

// A workflow pinned on the card is shaped by whoever pinned it: one text node may feed both conditionings, and a
// second node may carry a size of its own.
test('the negative text never lands on the positive node, and the size goes on the sampler\'s own latent', () => {
  const values = { checkpoint: 'k.safetensors', prompt: 'a picture', negative: 'blurry', seed: 11, steps: 8,
    sampler: 'er_sde', scheduler: 'simple', width: 1344, height: 768, cfg: 1 };
  // Both conditionings on one text node: writing the negative over it sent the card an empty prompt, while the
  // bundle still showed the assembled one, so a judging session would have graded a picture drawn from nothing.
  const shared: Graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { seed: 0, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
      denoise: 1, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['4', 0] } },
  };
  assert.equal(applyToWorkflow(shared, values)['2'].inputs.text, 'a picture');
  // An upscale or pad node keeps the size it was pinned with; only the latent the sampler starts from takes ours.
  const upscale: Graph = { ...defaultWorkflow(),
    '8': { class_type: 'ImageScale', inputs: { image: ['6', 0], upscale_method: 'lanczos', width: 2688, height: 1536, crop: 'disabled' } } };
  const filled = applyToWorkflow(upscale, values);
  assert.deepEqual([filled['4'].inputs.width, filled['4'].inputs.height], [1344, 768]);
  assert.deepEqual([filled['8'].inputs.width, filled['8'].inputs.height], [2688, 1536]);
  // A latent with no size of its own would be drawn at the workflow's size and written down at ours. The graph's
  // own failures carry a code, so `draw` records them as themselves and not as a plain `image_failed`.
  const encoded: Graph = { ...defaultWorkflow(), '4': { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } } };
  assert.throws(() => applyToWorkflow(encoded, values), { code: 'workflow_no_latent_size' });
});

// The harness and the graph the rented card is actually posted were written apart, and nothing paired them until
// here. gpu/image-workflow.json loads a transformer, a text encoder and a VAE separately — the built-in graph's
// CheckpointLoaderSimple would look for one all-in-one file this stack never installs — and it was exported at the
// resolution and the settings somebody chose for this checkpoint.
test('the pinned workflow of the picture lane is filled, and keeps the size it was pinned at', async t => {
  const graph: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow.json'), 'utf8'));
  const pinned = latentSizeOf(graph);
  assert.deepEqual(pinned, { width: 1280, height: 720 });
  const filled = applyToWorkflow(graph, { checkpoint: 'kreamania_variant8_fp8.safetensors', prompt: 'a picture',
    negative: 'blurry', seed: 7, steps: 8, sampler: 'er_sde', scheduler: 'simple', ...pinned!, cfg: 1 });
  const node = (type: string) => Object.values(filled).filter(one => one.class_type === type);
  assert.equal(node('UNETLoader')[0].inputs.unet_name, 'kreamania_variant8_fp8.safetensors');
  assert.equal(node('KSampler')[0].inputs.seed, 7);
  // One text node, wired to the positive conditioning and, through ConditioningZeroOut, to the negative one. The
  // assembled prompt has to land on it; a negative written over it would send the card an empty prompt.
  assert.equal(node('CLIPTextEncode').length, 1);
  assert.equal(node('CLIPTextEncode')[0].inputs.text, 'a picture');

  // And the run that posts it: without --size the graph's own size is drawn and recorded. The harness default
  // (1344x768) is a different resolution and a different aspect ratio, and it used to overwrite this one silently.
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  const index = await draw({ ...options(root, url), width: undefined, height: undefined,
    checkpoints: ['kreamania_variant8_fp8.safetensors'], workflow: resolve('gpu/image-workflow.json') });
  assert.equal(index.failures.length, 0, JSON.stringify(index.failures));
  assert.deepEqual([index.comfy.width, index.comfy.height], [1280, 720]);
  assert.deepEqual(index.pictures.map(picture => [picture.width, picture.height]), [[1280, 720], [1280, 720]]);
  const latent = Object.values(comfy.submitted[0]).find(one => one.class_type === 'EmptyLatentImage')!;
  assert.deepEqual([latent.inputs.width, latent.inputs.height], [1280, 720], 'the card drew another size than the graph pins');
});

// Qwen Image 2.1 is the same harness against a different shape of graph: both conditionings come from one node,
// through two inputs, and the settings are the template's own rather than the tester's Krea eight.
test('the pinned Qwen graph takes its prompt and its negative on one node, and is drawn with its own settings', async t => {
  const graph: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'));
  assert.deepEqual(latentSizeOf(graph), { width: 1280, height: 720 });
  assert.deepEqual(samplerSettingsOf(graph), { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1 });
  const filled = applyToWorkflow(graph, { checkpoint: 'qwen_image_2.1_int8_convrot.safetensors', prompt: 'a picture',
    negative: 'blurry', seed: 7, steps: 25, sampler: 'euler', scheduler: 'simple', width: 1280, height: 720, cfg: 1 });
  const encode = Object.values(filled).find(node => node.class_type === 'TextEncodeQwenImage21')!;
  // The Krea rule — never write the negative over the node the positive is on — is about the input, not the node:
  // here one node holds both, and skipping it would have drawn every Qwen picture from an empty prompt.
  assert.equal(encode.inputs.prompt, 'a picture');
  assert.equal(encode.inputs.negative_prompt, 'blurry');
  assert.equal(Object.values(filled).find(node => node.class_type === 'UNETLoader')!.inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors');

  // And the run: with no --steps and no --sampler the graph's 25 euler steps are drawn and written down. The
  // harness defaults are 8 er_sde, which is a different picture and a different number of rented seconds.
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  const index = await draw({ ...options(root, url), width: undefined, height: undefined, steps: undefined,
    sampler: undefined, scheduler: undefined, cfg: undefined, checkpoints: ['qwen_image_2.1_int8_convrot.safetensors'],
    workflow: resolve('gpu/image-workflow-qwen.json') });
  assert.equal(index.failures.length, 0, JSON.stringify(index.failures));
  assert.deepEqual(index.comfy, { steps: 25, sampler: 'euler', scheduler: 'simple', cfg: 1, width: 1280, height: 720 });
  assert.equal(index.workflow!.file, 'image-workflow-qwen.json');
  assert.deepEqual(index.pictures.map(picture => picture.steps), [25, 25]);
  const sampler = Object.values(comfy.submitted[0]).find(node => node.class_type === 'KSampler')!;
  assert.deepEqual([sampler.inputs.steps, sampler.inputs.sampler_name], [25, 'euler']);
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

test('a frame is drawn with the portraits of its own people, each face uploaded once and the empty slots removed', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-identity-'));
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(identityCases));
  // A portrait as it comes off the card: a real PNG with ComfyUI's own text chunks in it.
  writeFileSync(join(root, 'elin.png'), pngWithMetadata('{"prompt":"PORTRAIT_PROMPT"}'));
  writeFileSync(join(root, 'references.json'), JSON.stringify({ battle: { 'Элин': 'elin.png' } } satisfies References));

  const index = await draw({ ...options(root, url), checkpoints: ['qwen_image_2.1_int8_convrot.safetensors'],
    width: undefined, height: undefined, steps: undefined, sampler: undefined, scheduler: undefined, cfg: undefined,
    workflow: resolve('gpu/image-workflow-qwen-edit.json'), references: join(root, 'references.json') });
  assert.equal(index.failures.length, 0, JSON.stringify(index.failures));
  // One portrait, two frames: the same face is not paid for twice on a card billed by the minute.
  assert.equal(comfy.uploads.length, 1);
  const [upload] = comfy.uploads;
  assert.deepEqual([upload.type, upload.overwrite], ['input', 'true']);
  // The name is the hash of the bytes. Neither the sheet name nor the story is written onto the rented disk.
  assert.match(upload.name, /^ref-[0-9a-f]{16}\.png$/);
  assert.ok(!upload.name.includes('lin') && !upload.name.includes('battle'));
  // And the bytes are stripped like every other picture here: the prompt that drew the portrait does not travel.
  assert.deepEqual(chunksOf(upload.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(!upload.bytes.includes('PORTRAIT_PROMPT'));

  // Both frames name one person the sheet covers; the salt worker has no portrait and takes no slot.
  assert.deepEqual(index.pictures.map(picture => picture.references), [1, 1]);
  for (const graph of comfy.submitted) {
    const encode = Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21')!;
    assert.deepEqual(Object.keys(encode.inputs).filter(name => name.startsWith('images.')), ['images.image_1']);
    const loader = (encode.inputs['images.image_1'] as [string, number])[0];
    assert.equal(graph[loader].inputs.image, upload.name);
    // The three slots this frame does not use are gone, loader and input together: a LoadImage left pointing at
    // `reference-2.png`, which nobody uploaded, fails the whole prompt rather than one picture.
    assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length, 1);
  }
});

test('a frame that needs more reference slots than the graph has stops the run instead of dropping a person', async t => {
  const comfy = fakeComfy();
  const url = await comfy.listen();
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-identity-'));
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(identityCases));
  writeFileSync(join(root, 'elin.png'), pngWithMetadata('{}'));
  writeFileSync(join(root, 'references.json'), JSON.stringify({ battle: { 'Элин': 'elin.png' } }));
  // The text-to-image graph has no reference slots at all, and a references run pointed at it would otherwise be
  // an ordinary run whose index claimed portraits it never sent.
  const index = await draw({ ...options(root, url), checkpoints: ['qwen_image_2.1_int8_convrot.safetensors'],
    width: undefined, height: undefined, steps: undefined, sampler: undefined, scheduler: undefined, cfg: undefined,
    workflow: resolve('gpu/image-workflow-qwen.json'), references: join(root, 'references.json') });
  assert.equal(index.error, 'workflow_too_few_reference_slots');
  assert.equal(index.pictures.length, 0);
  assert.equal(comfy.submitted.length, 0, 'the card is not paid for a graph that cannot carry the references');
});

test('an upload the server accepts without naming a file stops the run rather than draw without the face', async t => {
  const comfy = fakeComfy({ refuseUpload: true });
  const url = await comfy.listen();
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-identity-'));
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(identityCases));
  writeFileSync(join(root, 'elin.png'), pngWithMetadata('{}'));
  writeFileSync(join(root, 'references.json'), JSON.stringify({ battle: { 'Элин': 'elin.png' } }));
  const index = await draw({ ...options(root, url), checkpoints: ['q.safetensors'], width: undefined, height: undefined,
    steps: undefined, sampler: undefined, scheduler: undefined, cfg: undefined,
    workflow: resolve('gpu/image-workflow-qwen-edit.json'), references: join(root, 'references.json') });
  // It fails the same way for every cell after it, and a picture drawn without its reference is not the identity
  // test at all — it is an ordinary picture recorded as one that had a face to keep.
  assert.equal(index.error, 'comfy_upload_failed');
  assert.equal(comfy.submitted.length, 0);
});

test('a person the sheet does not cover, or covers without a portrait, is left out rather than given another face', async t => {
  const references: References = { battle: { 'Элин': 'elin.png' } };
  // `who` comes back inflected, and the same matching as the appearance line has to find it.
  assert.deepEqual(portraitsFor(identityCases[0], references), ['elin.png']);
  // Two people, one portrait: the salt worker is not on the sheet and takes no slot.
  assert.deepEqual(portraitsFor(identityCases[1], references), ['elin.png']);
  assert.deepEqual(portraitsFor(identityCases[0], { dance: { 'Элин': 'elin.png' } }), [], 'another story\'s sheet');
  assert.deepEqual(portraitsFor(identityCases[0], {}), []);
  // A references file naming a portrait that is not there fails the whole run before the first cell, and says so
  // without naming the person: inside the loop it would be an unreadable `image_failed` once per frame.
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-image-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'prompts.json'), JSON.stringify(identityCases));
  writeFileSync(join(root, 'references.json'), JSON.stringify({ battle: { 'Элин': 'gone.png' } }));
  await assert.rejects(draw({ ...options(root, 'http://127.0.0.1:1'), width: undefined, height: undefined, steps: undefined,
    sampler: undefined, scheduler: undefined, cfg: undefined, checkpoints: ['q.safetensors'],
    workflow: resolve('gpu/image-workflow-qwen-edit.json'), references: join(root, 'references.json') }),
    /portrait for a person of "battle"/);
  // A graph without reference slots has none to find, and the edit graph's are in slot order.
  assert.deepEqual(referenceSlots(defaultWorkflow()), []);
  const edit: Graph = JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen-edit.json'), 'utf8'));
  assert.deepEqual(referenceSlots(edit).map(slot => slot.key), ['images.image_1', 'images.image_2',
    'images.image_3', 'images.image_4', 'images.image_5', 'images.image_6']);
});

// The encoder each pinned graph conditions with, for the token count under a picture (local/picture.ts `encoderTokens`).
test('the text encoder of a graph is the type of the CLIPLoader behind its positive prompt', () => {
  const graph = (file: string): Graph => JSON.parse(readFileSync(resolve(file), 'utf8'));
  assert.equal(textEncoderOf(graph('gpu/image-workflow.json')), 'krea2');
  assert.equal(textEncoderOf(graph('gpu/image-workflow-qwen.json')), 'qwen_image');
  assert.equal(textEncoderOf(graph('gpu/image-workflow-qwen-edit.json')), 'qwen_image');
  assert.equal(textEncoderOf(defaultWorkflow()), undefined);
});

// Which face is whose is carried by the order and by nothing else: the encoder's tokenizer writes its own
// `<image1> <image2> …` block in front of a prompt that never mentions the references, and `assemblePrompt` writes
// one clause per person in the order of `description.people`, which is the order the slots are filled in.
test('a person with no portrait ends the binding instead of moving the next face up a slot', () => {
  const sheet = [{ name: 'Элин', look: 'A middle-aged woman in grey' }, { name: 'Марк', look: 'A young man in brown' }];
  const references: References = { battle: { 'Элин': 'elin.png', 'Марк': 'mark.png' } };
  const frame = (...who: string[]): Case => ({ id: 'battle-7', scenario: 'battle', index: 7, scene: 'Сцена.', sheet,
    description: { moment: 'At a wheel', shot: 'Wide shot', setting: 'A salt road', objects: '', props: '', light: 'Noon',
      people: who.map(name => ({ who: name, look: '', state: '', action: 'stands' })) },
    prompt: 'Wide shot.', namesStripped: 0, fromSheet: who.length, withoutLook: 0 });
  assert.deepEqual(portraitsFor(frame('Марк', 'Элин'), references), ['mark.png', 'elin.png']);
  // The first person of the frame is off the sheet. Her portrait in `image_1` would be the face the prompt's first
  // clause describes as a young man in brown, and question 5 of the bundle would read that as one person kept.
  assert.deepEqual(portraitsFor(frame('salt worker', 'Элин'), references), []);
  // A stranger after them takes nothing away: slots 1..N are still people 1..N of the prompt.
  assert.deepEqual(portraitsFor(frame('Элин', 'salt worker', 'Марк'), references), ['elin.png']);
  // The same face twice is not two people either, and skipping the repeat would shift everybody after it.
  assert.deepEqual(portraitsFor(frame('Элин', 'Элин', 'Марк'), references), ['elin.png']);
  // A person on the sheet the portrait run drew nothing for is the same case as one who is not on it at all.
  assert.deepEqual(portraitsFor(frame('Марк', 'Элин'), { battle: { 'Элин': 'elin.png' } }), []);
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
  assert.equal(encoderResolution(edit), 0);
  // The text-to-image graph takes no reference, so it has no size to hand one at.
  assert.equal(encoderResolution(JSON.parse(readFileSync(resolve('gpu/image-workflow-qwen.json'), 'utf8'))), undefined);
  assert.deepEqual(pngSize(pngWithMetadata('{}')), { width: 2, height: 2 });
  // A job's time by the kind of node it was spent in: from one node's start to the next one's is the first node's,
  // and the last runs until the job is over.
  const ran = [{ node: '11', at: 0 }, { node: '1', at: 100 }, { node: '5', at: 1100 }, { node: '4', at: 1600 },
    { node: '7', at: 1610 }, { node: '8', at: 9610 }, { node: '9', at: 9900 }];
  assert.deepEqual(phasesOf(edit, ran, 10000), { loadMs: 1100, encodeMs: 500, otherMs: 110, sampleMs: 8000, decodeMs: 290 });
  assert.deepEqual(phasesOf(edit, [], 10), {});
});

// ComfyUI draws one job at a time. A picture abandoned when the wait runs out keeps the card: the next cell queues
// behind it and inherits its seconds, and the abandoned job's history entry — the whole prompt and workflow in it —
// is written when it finishes, which is after the delete of a plain abandon has already run.
test('a picture that outlives the wait is stopped on the card and leaves no record behind', async t => {
  const comfy = serialComfy(1500);
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const index = await draw({ ...options(root, url), checkpoints: ['a.safetensors'], waitMs: 150, pollMs: 10 });
  assert.deepEqual(index.failures.map(failure => failure.code), ['image_timeout', 'image_timeout']);
  // Each abandoned job was taken out of the queue and interrupted, so the next cell started on a card that was free
  // and nothing of either is still being drawn now that the run is over.
  assert.equal(comfy.seen.interrupts, 2);
  assert.equal(comfy.seen.queueDeletes, 2);
  assert.equal(comfy.onTheCard(), 0, 'a job the harness gave up on is still the card\'s');
  comfy.settle();
  assert.deepEqual([...comfy.history.keys()], [], 'the record of an abandoned job holds the whole prompt');

  // Astra's case against the end of a stage: a job of 10 ms whose picture takes 300 ms to come down, 150 ms before the
  // end. The download is cut at the end, the cell stays undrawn and is nobody's failure, and the run stops then, not
  // before the next cell. The job's record is deleted all the same.
  const slow = pushingComfy({ jobMs: 10, viewMs: 300 });
  const slowUrl = await slow.listen();
  t.after(slow.close);
  const until = Date.now() + 150;
  const cut = await draw({ ...options(root, slowUrl), out: join(root, 'cut'), checkpoints: ['a.safetensors'], until, pollMs: 10 });
  const past = Date.now() - until;
  assert.deepEqual([cut.pictures.length, cut.failures.length, cut.stopped, slow.seen.posted.length, slow.seen.cleared], [0, 0, 'budget', 1, ['p1']]);
  assert.ok(past < 100, `the run ended ${past} ms past the end`);

  // A card that takes the interrupt and goes on drawing is looked at until the reserve and not past it: the pause
  // between two looks, five seconds here, ends there too, so the reserve's minute is all a stop can take.
  comfy.stubborn = true;
  const reserve = Date.now() + 1000;
  await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000, end: AbortSignal.timeout(500), reserve: AbortSignal.timeout(1000) },
    defaultWorkflow(), { pollMs: 5000, waitMs: 20000 }), { code: 'out_of_time' });
  const over = Date.now() - reserve;
  assert.deepEqual([comfy.seen.submitted, comfy.seen.interrupts, comfy.seen.interrupted.length], [3, 3, 2]);
  assert.ok(over < 500, `the stop went on ${over} ms past the reserve`);
});

// Two readers share one card (local/picture.ts). A reader who gives up before their picture is submitted puts nothing
// on the card. One who gives up once the card has taken it, while it waits in the queue, must not interrupt anything:
// the job on the card belongs to somebody who is still waiting for it.
test('a picture given up before its submit never reaches the card, and one given up in the queue leaves the one being drawn alone', async t => {
  const comfy = serialComfy(400);
  const url = await comfy.listen();
  t.after(() => comfy.server.close());
  const busy = drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 });
  for (let attempt = 0; attempt < 500 && comfy.seen.submitted < 1; attempt++) await new Promise(next => setTimeout(next, 2));

  const early = new AbortController();
  early.abort();
  await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000, signal: early.signal }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 }),
    { code: 'cancelled' });
  assert.deepEqual([comfy.seen.submitted, comfy.seen.queueDeletes, comfy.seen.interrupts], [1, 0, 0], 'nothing was sent, and nothing stopped');

  // Given up the moment the card has taken the submit: its answer is still read, which is the order `drawOne` keeps on
  // purpose, since a job with no id is a job nobody can stop.
  const late = new AbortController();
  comfy.onSubmit = () => late.abort();
  await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000, signal: late.signal }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 }),
    { code: 'cancelled' });
  assert.equal(comfy.seen.submitted, 2);
  assert.deepEqual(comfy.seen.interrupted, [], 'the card was drawing another reader\'s picture');
  assert.equal(comfy.seen.queueDeletes, 1, 'and the abandoned one was taken out of the queue');
  // A job that never ran writes no record, so nothing is waited for: the ten polls used to run out under every
  // cancelled picture, and `idle()` waited them out.
  assert.equal(comfy.polls.get('p2') ?? 0, 0);
  // The end of an identity stage, come the moment the card took a submit, is answered the same way, within the reserve.
  const end = new AbortController();
  comfy.onSubmit = () => end.abort();
  await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000, end: end.signal, reserve: AbortSignal.timeout(60000) }, defaultWorkflow(),
    { pollMs: 5, waitMs: 5000 }), { code: 'out_of_time' });
  assert.deepEqual([comfy.seen.submitted, comfy.seen.queueDeletes, comfy.polls.get('p3') ?? 0, comfy.seen.interrupted], [3, 2, 0, []]);
  assert.ok((await busy).bytes.length > 0, 'the picture on the card was drawn and delivered');
});

// The job being stopped may end, and another reader's take the card, between the read of the queue and the
// interrupt. An interrupt without an id stopped theirs then, and they got the failure line under a scene they never
// touched; it names its job now, and the card lets the other one be.
test('a stop never interrupts the job that took the card after the queue was read', async t => {
  const comfy = serialComfy(300);
  const url = await comfy.listen();
  t.after(() => comfy.server.close());
  const stop = new AbortController();
  const mine = drawOne({ baseUrl: url, timeoutMs: 5000, signal: stop.signal }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 });
  for (let attempt = 0; attempt < 500 && comfy.seen.submitted < 1; attempt++) await new Promise(next => setTimeout(next, 2));
  const theirs = drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 });
  for (let attempt = 0; attempt < 500 && comfy.seen.submitted < 2; attempt++) await new Promise(next => setTimeout(next, 2));

  comfy.afterQueueRead = () => comfy.end('p1');
  stop.abort();
  await assert.rejects(mine, (error: { code?: string }) => error.code === 'cancelled');
  assert.equal(comfy.seen.interrupts, 1);
  assert.deepEqual(comfy.seen.interrupted, [], 'the interrupt stopped another reader\'s picture');
  assert.ok((await theirs).bytes.length > 0, 'the other reader\'s picture was drawn and delivered');
  // The stopped job's record, which holds the whole prompt, was waited for and deleted.
  await settled();
  comfy.settle();
  assert.deepEqual([...comfy.history.keys()], []);
});

// ComfyUI as the picture card runs it: a graph identical to the one it ran last is answered from the cache, whose output
// names the earlier job's file, and gpu/image-sweeper.py deletes a preview's file once no record names it (`sweep`).
// `dropPolls` closes that many polls of a job's record without an answer, as a tunnel does when it drops one.
function cachingComfy(options: { dropPolls?: number } = {}) {
  const graphs: Graph[] = [];
  const files = new Set<string>();
  const outputs = new Map<string, string>();
  const history = new Map<string, string>();
  let last: { signature: string; file: string } | null = null;
  let dropped = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const graph = (await body()).prompt as Graph;
        graphs.push(graph);
        const id = `p${graphs.length}`;
        const signature = JSON.stringify(graph);
        if (last?.signature !== signature) { last = { signature, file: `${id}.png` }; files.add(last.file); }
        outputs.set(id, last.file);
        history.set(id, last.file);
        return json({ prompt_id: id });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        for (const id of ((await body()).delete as string[]) ?? []) history.delete(id);
        return json({});
      }
      if (url.pathname === '/system_stats') return json({});
      if (url.pathname.startsWith('/history/')) {
        if (dropped < (options.dropPolls ?? 0)) { dropped++; request.socket.destroy(); return; }
        const id = url.pathname.slice('/history/'.length);
        if (!history.has(id)) return json({});
        return json({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { 7: { images: [{ filename: outputs.get(id), subfolder: '', type: 'temp' }] } } } });
      }
      if (url.pathname === '/view' && files.has(String(url.searchParams.get('filename')))) {
        response.setHeader('content-type', 'image/png');
        return response.end(pngWithMetadata('{}'));
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  const sweep = () => { for (const file of [...files]) if (![...history.values()].includes(file)) files.delete(file); };
  return { server, graphs, sweep, listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
}

test('a graph drawn again writes a file of its own, and the one the sweeper took is never asked for', async t => {
  const comfy = cachingComfy();
  const url = await comfy.listen();
  t.after(() => comfy.server.close());
  const graph = defaultWorkflow();
  await drawOne({ baseUrl: url, timeoutMs: 5000 }, graph, { pollMs: 5, waitMs: 5000 });
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

test('a poll the tunnel drops is asked again, and a card that stops answering still ends the picture', async t => {
  const flaky = cachingComfy({ dropPolls: 3 });
  const url = await flaky.listen();
  t.after(() => flaky.server.close());
  assert.ok((await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 })).bytes.length > 0);
  const gone = cachingComfy({ dropPolls: 4 });
  const goneUrl = await gone.listen();
  t.after(() => gone.server.close());
  await assert.rejects(drawOne({ baseUrl: goneUrl, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 5, waitMs: 5000 }));
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
// `deleteMs` and `viewMs` hold /system_stats, the delete and the picture back that long. Every /history request that
// is not one `drawOne` may make, a read or a delete of one job by its id, is kept in `bare`.
function pushingComfy(options: { socket?: 'open' | 'late' | 'silent' | 'closing' | 'refused'; openMs?: number;
  outcome?: 'success' | 'error' | 'interrupted'; quietEnd?: boolean; jobMs?: number; statsMs?: number; deleteMs?: number; viewMs?: number } = {}) {
  const mode = options.socket ?? 'open';
  const records = new Map<string, object>();
  const files = new Set<string>();
  const clientOf = new Map<string, string>();
  const speakers = new Map<string, ReturnType<typeof acceptSocket>>();
  const upgraded = new Set<Duplex>();
  const seen = { posted: [] as string[], connected: [] as string[], reads: [] as string[], cleared: [] as string[],
    bare: [] as string[], said: [] as { type: string; at: number }[], interrupts: 0 };
  let running: string | undefined;
  let count = 0;
  const tell = (id: string, type: string, data: object = {}) => {
    const speaker = speakers.get(clientOf.get(id)!);
    if (!speaker) return;
    speaker.send({ type, data: { ...data, prompt_id: id } });
    seen.said.push({ type: type === 'executing' && (data as { node?: unknown }).node === null ? 'over' : type, at: performance.now() });
  };
  const finish = (id: string, outcome: 'success' | 'error' | 'interrupted') => {
    if (running !== id) return;
    running = undefined;
    const file = { filename: `${id}.png`, subfolder: '', type: 'temp' };
    if (outcome === 'success') {
      tell(id, 'executing', { node: '7' });
      // A socket that opened late missed the start, so what it did hear is not vouched for: here the output it hears
      // names a file /view does not have, and a picture drawn from it fails.
      tell(id, 'executed', { node: '7', output: { images: [mode === 'late' ? { ...file, filename: 'elsewhere.png' } : file] } });
      tell(id, 'execution_success');
      files.add(file.filename);
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
        const clientId = String((await body() as { client_id?: unknown }).client_id);
        const id = `p${++count}`;
        seen.posted.push(clientId);
        clientOf.set(id, clientId);
        begin(id);
        return json({ prompt_id: id, number: count });
      }
      if (url.pathname === '/system_stats') {
        await delay(options.statsMs ?? 0);
        return json({ devices: [{ index: 0, vram_total: 32 * 1024 ** 3, vram_free: 2 * 1024 ** 3 }] });
      }
      if (request.method === 'GET' && /^\/history\/p\d+$/.test(url.pathname)) {
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
  return { seen, over,
    listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => { for (const socket of upgraded) socket.destroy(); server.close(); } };
}

// The poll interval is ten seconds in the tests below that time the wait, so that nothing but the socket can end it
// in time.
test('the socket\'s word that a job is over ends the wait at once, and a socket that heard all of it spares a read', async t => {
  const comfy = pushingComfy({ jobMs: 150 });
  const url = await comfy.listen();
  t.after(comfy.close);
  const drawn = await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
  const late = performance.now() - comfy.over()!.at;
  assert.ok(late < 100, `the picture came ${Math.round(late)} ms after the card said the job was over`);
  // One read of the record, right after the submit. The outputs the socket heard are the record's own, so the record
  // is not read again once the job is over.
  assert.deepEqual(comfy.seen.reads, ['p1']);
  assert.deepEqual(chunksOf(drawn.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(!Buffer.from(drawn.bytes).includes('PRIVATE_SCENE_TEXT'));
  // The socket listens under the client id the job was submitted with, or it would hear nothing of it.
  assert.equal(comfy.seen.posted.length, 1);
  assert.deepEqual(comfy.seen.connected, comfy.seen.posted);
  await settled();
  assert.deepEqual(comfy.seen.cleared, ['p1']);
  assert.deepEqual(comfy.seen.bare, []);
  // A socket that opens late, as one through a tunnel may: the submit waits for it, so the job is still heard from
  // its start, and the picture knows where its time went and whether its loaders ran.
  const slow = pushingComfy({ jobMs: 50, openMs: 300 });
  const slowUrl = await slow.listen();
  t.after(slow.close);
  const heard = await drawOne({ baseUrl: slowUrl, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
  assert.equal(heard.timing?.loaderCacheMiss, true);
  assert.deepEqual(slow.seen.reads, ['p1']);
  // Astra's cases, each well inside the socket's 300 ms: a cancel, the end of a stage, and the caller's whole wait.
  // Each ends the wait for the socket then, and nothing is submitted.
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  for (const [comfy, waitMs, code] of [[{ signal: stop.signal }, 20000, 'cancelled'], [{ end: AbortSignal.timeout(80) }, 20000, 'out_of_time'],
    [{}, 80, 'image_timeout']] as const) {
    const began = performance.now();
    await assert.rejects(drawOne({ baseUrl: slowUrl, timeoutMs: 5000, ...comfy }, defaultWorkflow(), { pollMs: 10000, waitMs }), { code });
    assert.ok(performance.now() - began < 200, `${code}: ${Math.round(performance.now() - began)} ms`);
  }
  assert.equal(slow.seen.posted.length, 1, 'nothing reached the card after the first picture');
});

test('a socket that opened after the job began is not taken at its word for the outputs: the record is read', async t => {
  const comfy = pushingComfy({ socket: 'late', jobMs: 150 });
  const url = await comfy.listen();
  t.after(comfy.close);
  // The output it heard names a file the card does not have; drawn from it, the picture would be a 404.
  const drawn = await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
  const late = performance.now() - comfy.over()!.at;
  assert.ok(late < 100, `the picture came ${Math.round(late)} ms after the card said the job was over`);
  assert.deepEqual(comfy.seen.reads, ['p1', 'p1']);
  assert.deepEqual(chunksOf(drawn.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND']);
  await settled();
  assert.deepEqual(comfy.seen.cleared, ['p1']);
  assert.deepEqual(comfy.seen.bare, []);
});

test('a socket that is refused, says nothing or hangs up leaves the picture to the polls, as before the socket', async t => {
  for (const socket of ['refused', 'silent', 'closing'] as const) {
    const comfy = pushingComfy({ socket, jobMs: 100 });
    const url = await comfy.listen();
    t.after(comfy.close);
    const started = performance.now();
    const drawn = await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 20, waitMs: 5000 });
    // A poll every 20 ms finds a job of 100 ms in about that; waiting on a socket with nothing to say would not.
    const took = performance.now() - started;
    assert.ok(took < 1000, `${socket}: the picture took ${Math.round(took)} ms`);
    assert.deepEqual(chunksOf(drawn.bytes).map(one => one.type), ['IHDR', 'IDAT', 'IEND'], socket);
    assert.equal(comfy.seen.connected.length, socket === 'refused' ? 0 : 1, socket);
    assert.equal(comfy.over(), undefined, `${socket}: the card told the socket nothing of the end`);
    assert.ok(comfy.seen.reads.length > 1, `${socket}: the polls found the record`);
    await settled();
    assert.deepEqual(comfy.seen.cleared, ['p1'], socket);
    assert.deepEqual(comfy.seen.bare, [], socket);
  }
  // A run that measures the card (`requireSocket`) fails the cell instead, before anything reaches the card.
  const refused = pushingComfy({ socket: 'refused' });
  const url = await refused.listen();
  t.after(refused.close);
  await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { requireSocket: true }), { code: 'comfy_socket_unavailable' });
  assert.deepEqual(refused.seen.posted, []);
});

test('a slow /system_stats holds up nothing, and its answer joins the video memory when it lands', async t => {
  // No socket, so the wait is the polls', and a sample waited for inside it would hold the next poll back.
  const comfy = pushingComfy({ socket: 'refused', jobMs: 100, statsMs: 1500 });
  const url = await comfy.listen();
  t.after(comfy.close);
  const started = performance.now();
  const drawn = await drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10, waitMs: 5000 });
  const took = performance.now() - started;
  assert.ok(took < 1000, `the picture took ${Math.round(took)} ms behind a /system_stats of 1500`);
  assert.deepEqual(drawn.vram, [], 'nothing has answered yet');
  await settled();
  assert.deepEqual(drawn.vram, [{ index: 0, totalMiB: 32768, usedMiBMax: 30720 }]);
});

test('the job\'s record is deleted whichever way the picture ends, and the picture never waits for the delete', async t => {
  // Drawn, with a delete the card takes a second to answer.
  const drawnComfy = pushingComfy({ jobMs: 50, deleteMs: 1000 });
  const drawnUrl = await drawnComfy.listen();
  t.after(drawnComfy.close);
  const started = performance.now();
  await drawOne({ baseUrl: drawnUrl, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
  const took = performance.now() - started;
  assert.ok(took < 800, `the picture took ${Math.round(took)} ms behind a delete of 1000`);
  assert.deepEqual(drawnComfy.seen.cleared, [], 'the delete is still on its way');
  await settled();
  assert.deepEqual(drawnComfy.seen.cleared, ['p1']);

  // Failed on the card.
  const failing = pushingComfy({ outcome: 'error', jobMs: 50 });
  const failingUrl = await failing.listen();
  t.after(failing.close);
  await assert.rejects(drawOne({ baseUrl: failingUrl, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 }),
    { code: 'image_failed' });
  await settled();
  assert.deepEqual(failing.seen.cleared, ['p1']);

  // Given up by the caller while the card draws: stopped on the card first, as before, then forgotten.
  const slow = pushingComfy({ jobMs: 60000 });
  const slowUrl = await slow.listen();
  t.after(slow.close);
  const stop = new AbortController();
  const drawing = drawOne({ baseUrl: slowUrl, timeoutMs: 5000, signal: stop.signal }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 });
  for (let attempt = 0; attempt < 500 && !slow.seen.said.some(one => one.type === 'execution_start'); attempt++) await delay(2);
  stop.abort();
  await assert.rejects(drawing, { code: 'cancelled' });
  assert.equal(slow.seen.interrupts, 1, 'the card was told to stop drawing it');
  await settled();
  assert.deepEqual(slow.seen.cleared, ['p1']);
  // Never a list of the whole history, and never a clear of all of it: only the sweeper on the card reads that.
  for (const one of [drawnComfy, failing, slow]) assert.deepEqual(one.seen.bare, []);
});

test('an error or an interrupt on the socket sends the wait to the record at once, and the record says how it ended', async t => {
  for (const outcome of ['error', 'interrupted'] as const) {
    // Without the closing `executing` message, so that only the error itself can end a ten-second wait in time.
    const comfy = pushingComfy({ outcome, quietEnd: true, jobMs: 100 });
    const url = await comfy.listen();
    t.after(comfy.close);
    await assert.rejects(drawOne({ baseUrl: url, timeoutMs: 5000 }, defaultWorkflow(), { pollMs: 10000, waitMs: 20000 }),
      { code: 'image_failed' });
    const late = performance.now() - comfy.seen.said.find(one => one.type === `execution_${outcome}`)!.at;
    assert.ok(late < 100, `${outcome}: the failure came ${Math.round(late)} ms after the card's word`);
    assert.deepEqual(comfy.seen.reads, ['p1', 'p1'], outcome);
    await settled();
    assert.deepEqual(comfy.seen.cleared, ['p1'], outcome);
    assert.deepEqual(comfy.seen.bare, [], outcome);
  }
});

// The file ComfyUI's Save menu writes is the UI format ({nodes:[...],links:[...]}), not the API format the harness
// fills. It used to throw a TypeError inside applyToWorkflow and be written down as `image_failed`, once a cell.
test('a workflow saved in the UI format is refused by name before anything is drawn', async t => {
  const root = corpus();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'ui.json'), JSON.stringify({ last_node_id: 71, version: 0.4, links: [],
    nodes: [{ id: 55, type: 'UNETLoader', widgets_values: ['krea2_turbo_fp8_scaled.safetensors'] }] }));
  await assert.rejects(draw({ ...options(root, 'http://127.0.0.1:1'), workflow: join(root, 'ui.json') }), /API format/);
});

// A graph this build cannot run, or a server that is not answering, fails the same way for every cell after it.
test('a graph the server refuses stops the run and keeps the status it was refused with', async t => {
  const comfy = fakeComfy({ refuse: 400 });
  const url = await comfy.listen();
  const root = corpus();
  t.after(() => { comfy.server.close(); rmSync(root, { recursive: true, force: true }); });

  const index = await draw(options(root, url));
  assert.equal(comfy.attempts.prompt, 1, 'the same refusal is not bought four times');
  assert.equal(index.failures.length, 1);
  assert.equal(index.failures[0].code, 'comfy_http_error');
  assert.equal(index.failures[0].httpStatus, 400);
  assert.equal(index.error, 'comfy_http_error');
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

test('an empty part of --seeds is not the seed zero', () => {
  assert.deepEqual(parseSeeds('7'), [7]);
  assert.deepEqual(parseSeeds('7, 11'), [7, 11]);
  // `Number('')` is 0, and seed 0 is a whole extra pass over every case.
  assert.deepEqual(parseSeeds('7,'), [7]);
  assert.deepEqual(parseSeeds(''), []);
  assert.deepEqual(parseSeeds('7,-1'), []);
  assert.deepEqual(parseSeeds('7,x'), []);
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
