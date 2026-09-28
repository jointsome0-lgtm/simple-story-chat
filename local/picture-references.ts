// The bot's reference experiment. The measured harnesses keep their own prompts, graphs and input uploads.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { poseReference } from '../lib/library.ts';
import type { PictureRecipe, Story } from '../lib/library.ts';
import { referenceSlots, stripPngMetadata, textEncoderOf } from './image-batch.ts';
import type { Comfy, Graph } from './image-batch.ts';
import { assemblePrompt, matchSheet } from './illustrate.ts';
import type { Character, Description } from './illustrate.ts';
import type { Log } from './model-error.ts';
import { clothesStatement } from './picture-clothes.ts';
import { imageFormat } from './reference.ts';
import type { Store } from './store.ts';

export const REFERENCE_VERSION = 'qwen-identity-v1';
type Bound = { name: string; file: string };

// Unlike the old experiment's binding, a missing portrait does not stop later people from getting theirs.
// Every bound clause names its image explicitly, so image order need not be person order.
export function frameReferences(story: Story, description: Description): Bound[] {
  const sheet = story.sheet ?? [], names = sheet.map(one => one.name);
  const bound: Bound[] = [];
  for (const person of description.people ?? []) {
    const name = matchSheet(person.who ?? '', names);
    const one = sheet.find(other => other.name === name);
    const file = one && frameFile(one);
    if (name !== null && file && !bound.some(other => other.name === name)) bound.push({ name, file });
  }
  return bound;
}

// The one picture a frame takes of a person: their front (lib/library.ts `poseReference`), the picture the reader sent
// for it, or else the portrait they kept.
export function frameFile(person: NonNullable<Story['sheet']>[number]) {
  return poseReference(person, 'front')?.file;
}

// With `clothes` (a reader of SIMPLE_CHAT_CLOTHES_USERS), what each bound person wears in the scene comes before the
// words on what the pictures are for (local/picture-clothes.ts), and `clothesStated` counts them.
export function referencePrompt(frame: { description: Description; sheet: Character[] }, bound: Bound[], line: string, clothes = false) {
  const tag = (name: string | null, look: string) => {
    const slot = bound.findIndex(one => one.name === name);
    return slot < 0 ? look : `The person from image ${slot + 1}, ${look}`;
  };
  const names = [...new Set([...frame.sheet.map(one => one.name), ...bound.map(one => one.name)])];
  const sheet = frame.sheet.map(one => ({ ...one, look: tag(one.name, one.look) }));
  const description = { ...frame.description, people: (frame.description.people ?? []).map(one => ({ ...one,
    look: tag(matchSheet(one.who ?? '', names), one.look ?? '') })) };
  const assembled = assemblePrompt(description, sheet, line);
  // ROLE's medium first and identity-only instruction, with the full look left in every clause as in W.
  // The chosen style also stays last, including a reader's own wording. An empty style adds no medium of ours.
  const worn = clothes ? clothesStatement(frame, bound) : undefined;
  const opening = `${line ? `${line} ` : ''}Create a brand-new scene${line ? ' in this medium and style' : ''}. ` + (worn?.text ?? '')
    + 'Use the reference images only as identity sources for the people identified below by image number. '
    + 'Keep each referenced person\'s face, hair, skin, age, body proportions and relative body volumes. '
    + 'Do not slim down, enlarge, age or idealize them. Take nothing else from the references: '
    + 'do not copy their rendering, backdrop, lighting, clothes, standing poses or framing. '
    + 'Use the scene\'s clothes, actions, poses, places, light and relative heights described below. ';
  return { ...assembled, prompt: opening + assembled.prompt,
    ...worn ? { namesStripped: assembled.namesStripped + worn.namesStripped, clothesStated: worn.stated } : {} };
}

type Size = { width: number; height: number };
// Round two's C reference path, attached to the bot's pinned frame graph: cache, VAE and area-scaled references,
// resolution 0. The frame keeps its own empty latent, size, seed and sampler, never image 1's latent. Each reference is
// scaled to its own shape (`referenceScale`), given by its picture's size; where only the graph's shape matters, a
// count of tokens or whether the graph takes references at all, a count does, each then as the bot's portrait.
export function referenceGraph(base: Graph, references: number | Size[]): Graph | undefined {
  const sizes = typeof references === 'number' ? Array.from({ length: references }, () => PORTRAIT) : references;
  const count = sizes.length;
  if (count < 1 || count > 6 || textEncoderOf(base) !== 'qwen_image' || referenceSlots(base).length) return undefined;
  const graph = structuredClone(base);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const positive = sampler?.inputs.positive;
  const encoder = Array.isArray(positive) ? graph[String(positive[0])] : undefined;
  const vae = Object.entries(graph).find(([, node]) => node.class_type === 'VAELoader');
  if (!sampler || encoder?.class_type !== 'TextEncodeQwenImage21' || !vae) return undefined;
  let next = 1;
  const add = (node: Graph[string]) => {
    while (graph[String(next)]) next++;
    const id = String(next++);
    graph[id] = node;
    return [id, 0];
  };
  sampler.inputs.model = add({ class_type: 'QwenImage21Cache', inputs: { model: sampler.inputs.model, device: 'auto', dtype: 'default' } });
  encoder.inputs.vae = [vae[0], 0];
  encoder.inputs.resolution = 0;
  for (let slot = 1; slot <= count; slot++) {
    const image = add({ class_type: 'LoadImage', inputs: { image: '' } });
    encoder.inputs[`images.image_${slot}`] = add({ class_type: 'ImageScale', inputs: {
      image, upscale_method: 'area', ...referenceScale(sizes[slot - 1]), crop: 'disabled',
    } });
  }
  return graph;
}

// The size a reference is scaled to before the encoder, which at resolution 0 takes a picture at its own size in
// multiples of 32 (local/image-batch.ts `referenceGeometry`): the reference's own shape at about the area of the 352x640
// that round two measured the bot's portraits of 720x1280 at, which is what they still come out at. A reference is never
// stretched to another shape: the prompt asks a frame to keep each person's body proportions, and a squeezed reference
// is a slimmer person (the coordinator, 2026-09-27; a square came out 45% narrower at 352x640). The shorter side is
// rounded to 32 first and the longer follows from it, which bends the shape less than rounding both on their own: a
// square is 480x480, 3:4 is 416x544, 16:9 is 640x352.
const PORTRAIT = { width: 720, height: 1280 };
const REFERENCE_AREA = 352 * 640;
export function referenceScale({ width, height }: Size): Size {
  const upright = height >= width, ratio = Math.max(width, height) / Math.min(width, height);
  const across = Math.max(32, Math.round(Math.sqrt(REFERENCE_AREA / ratio) / 32) * 32);
  const along = Math.max(32, Math.round(across * ratio / 32) * 32);
  return upright ? { width: across, height: along } : { width: along, height: across };
}

export function readReference(store: Store, userId: string, file: string) {
  // Recipes name a random file of this reader, never a path, even when a library has been imported or edited.
  const extension = /^[a-f0-9]{32}\.(png|jpg|webp)$/.exec(file)?.[1] as keyof typeof FORMATS | undefined;
  if (!extension) throw new Error('reference_unavailable');
  const stored = readFileSync(join(store.portraits(userId), file));
  // A portrait the card drew is stripped as it always was, so that the hashes recipes pinned before still match. A
  // picture the reader sent was stripped on its way in (local/reference.ts), and is read as it lies, if it still is
  // what its name says.
  const bytes = extension === 'png' ? stripPngMetadata(stored) : stored;
  if (bytes.length > 10 * 1024 * 1024 || imageFormat(bytes) !== FORMATS[extension]) throw new Error('reference_unavailable');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const FORMATS = { png: 'png', jpg: 'jpeg', webp: 'webp' } as const;

export function pinReferences(store: Store, userId: string, bound: Bound[]): NonNullable<PictureRecipe['references']> {
  return { version: REFERENCE_VERSION, portraits: bound.map(({ name, file }) => ({ name, file, sha256: readReference(store, userId, file).sha256 })) };
}

// A blank PNG replaces the private bytes at the same random temp name. ComfyUI has no file-delete route. The
// sweeper caps this folder at ten minutes even if the bot dies or either request's response is lost.
const BLANK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
async function upload(comfy: Comfy, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: `image/${imageFormat(bytes) ?? 'png'}` }), name);
  form.append('overwrite', 'true');
  form.append('type', 'temp');
  form.append('subfolder', 'bot-references');
  const timeout = AbortSignal.timeout(Math.min(comfy.timeoutMs, 15000));
  const response = await fetch(comfy.baseUrl + '/upload/image', { method: 'POST', body: form,
    signal: comfy.signal ? AbortSignal.any([comfy.signal, timeout]) : timeout });
  if (!response.ok) throw new Error('reference_upload_failed');
  const answer = await response.json() as { name?: string; subfolder?: string; type?: string };
  if (answer.name !== name || answer.subfolder !== 'bot-references' || answer.type !== 'temp') throw new Error('reference_upload_failed');
}

export function temporaryReferences(comfy: Comfy, log: Log) {
  const names: string[] = [];
  return {
    // A picture the reader sent goes up in its own format and under its extension; the blank that erases it later is a
    // PNG under the same name, which nothing opens.
    async send(bytes: Uint8Array) {
      comfy.signal?.throwIfAborted();
      const format = imageFormat(bytes);
      const name = `${randomUUID()}.${format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png'}`;
      // Allocate before sending: even a lost upload response needs cleanup, with no retry of the private upload.
      names.push(name);
      await upload(comfy, name, bytes);
      return `bot-references/${name} [temp]`;
    },
    async clear() {
      const allocated = names.splice(0);
      const cleared = await Promise.allSettled(allocated.map(name => upload({ ...comfy, signal: undefined }, name, BLANK)));
      if (allocated.length) log('picture_reference_cleanup', undefined, {
        referenceCount: allocated.length, referenceCleanup: cleared.every(one => one.status === 'fulfilled'),
      });
    },
  };
}
