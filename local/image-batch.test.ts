import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { draw, buildBundles, bundlesOf, applyToWorkflow, defaultWorkflow, parseSeeds, stripPngMetadata, REVIEW } from './image-batch.ts';
import type { Graph, Picture } from './image-batch.ts';
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

// The fake ComfyUI: /prompt, /history, /view, /system_stats, and POST /history to forget a job. A job finishes on the
// third poll, so the video-memory sampling inside the wait runs too.
function fakeComfy(options: { failCase?: string } = {}) {
  const submitted: Graph[] = [];
  const cleared: string[] = [];
  const viewed: string[] = [];
  const polls = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://127.0.0.1');
    const body = async () => { const parts = []; for await (const part of request) parts.push(part as Buffer); return JSON.parse(Buffer.concat(parts).toString('utf8')); };
    const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/prompt') {
        const graph = (await body()).prompt as Graph;
        submitted.push(graph);
        return json({ prompt_id: `p${submitted.length}`, number: submitted.length });
      }
      if (request.method === 'POST' && url.pathname === '/history') {
        cleared.push(...((await body()).delete as string[] ?? []));
        return json({});
      }
      if (url.pathname === '/system_stats') return json({ devices: [{ index: 0, vram_total: 32 * 1024 * 1024 * 1024, vram_free: 2 * 1024 * 1024 * 1024 }] });
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.slice('/history/'.length);
        const seen = (polls.get(id) ?? 0) + 1;
        polls.set(id, seen);
        if (seen < 3) return json({});
        const graph = submitted[Number(id.slice(1)) - 1];
        const prompt = String(graph['2'].inputs.text);
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
  return { server, submitted, cleared, viewed, listen: () => new Promise<string>(done => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))) };
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
  scheduler: 'simple', cfg: 1, width: 1344, height: 768, negative: '', minutes: 5, timeoutMs: 10000, pollMs: 1 });

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
  // A repeat costs rented card time and records nothing, so it is refused before the first picture.
  await assert.rejects(draw({ ...options(root, url), out: join(root, 'twice'), seeds: [7, 7] }), /share one file/);
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
  assert.deepEqual(index.failures, [{ caseId: 'dance-12', role: 'primary', code: 'image_failed' },
    { caseId: 'dance-12', role: 'alternate', code: 'image_failed' }]);
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
