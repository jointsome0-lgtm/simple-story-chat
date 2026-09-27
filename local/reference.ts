// Pictures of the people of a story's sheet that a reader in the reference experiment sends of their own (the owner,
// 2026-09-27: «мы можем просто добавить фичу менять на свой портрет?»), kept beside the portraits the card drew and
// taken by frames as those are (local/picture-references.ts `frameFile`). A picture is sent for a pose (lib/library.ts
// `POSES`), so far the front alone, which is the portrait, and pinned there, so that a later drawing of the poses leaves
// it.
//
// The bot has no image library, so a picture is not decoded and encoded again: it is taken apart by the structure of
// its format and put together from the parts a picture needs, and nothing else it carried survives — EXIF with the place
// and the camera, XMP, ICC profiles, text chunks, comments, thumbnails, and whatever follows the picture's end, where a
// phone puts a motion photo. A picture the walk does not get through cleanly is refused, never kept as it came. The
// pixels stay as they came, in their own format.
import https from 'node:https';
import { crc32 } from 'node:zlib';
import { UserError } from '../lib/library.ts';
import type { OwnReference, Pose, Story } from '../lib/library.ts';
import { pngSize } from './image-batch.ts';
import { downloadFile } from './seed-file.ts';
import type { HttpsGet, TelegramDocument } from './seed-file.ts';
import type { Store } from './store.ts';
import type { TelegramApi } from './telegram.ts';
import { texts } from './text.ts';

// The most a picture may weigh, as much as Telegram takes a photo at, so that the bot can show it back.
export const REFERENCE_BYTES = 10 * 1024 * 1024;
// A picture's sides, in pixels. The card takes a reference at about 352x640 whatever its shape
// (local/picture-references.ts `referenceScale`), so the shorter side of at least `min` enlarges a square one and a half
// times at most. The longer side of at most `max` keeps it within what Telegram takes as a photo. And the longer side
// is at most `ratio` times the shorter: a person fills too little of a picture more drawn out than that, and the sides
// scaled to multiples of 32 would bend its shape by more than a few hundredths. A picture outside these is refused, never
// cut or stretched to fit.
export const REFERENCE_SIDES = { min: 320, max: 4096, ratio: 2.5 };
// The wait for a picture, from the press of its button.
export const REFERENCE_WAIT_MS = 30 * 60 * 1000;
// A caption's most characters: a few words of English, to match a frame by.
export const CAPTION_CHARS = 80;

type SheetEntry = NonNullable<Story['sheet']>[number];
type Format = OwnReference['format'];
type Picture = { bytes: Uint8Array; format: Format; width: number; height: number };
// A picture as it will be kept, and how many bytes of what came with it went.
export type ReferencePicture = Picture & { strippedBytes: number };
// The same, and whether it came as a photo or as a file, for the log row.
export type ReceivedPicture = ReferencePicture & { sent: 'photo' | 'document' };
const EXTENSIONS = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

// The refusals of a picture, by the key of their message in the interface catalogs (local/text/), where the bot finds
// its translation, and by their code in a log row.
export const REFUSAL_CODES = { referenceType: 'type', referenceBroken: 'broken', referenceSmall: 'small', referenceHuge: 'huge',
  referenceShape: 'shape', referenceTooLarge: 'too_large', referenceIncomplete: 'incomplete', referenceArchive: 'archive' } as const;
export type PictureRefusal = keyof typeof REFUSAL_CODES;
const refusal = (key: PictureRefusal) => new UserError(texts('ru').errors[key], key);

// A caption as it is kept: its runs of spaces and underscores as one space, in printable ASCII with a letter in it, as
// English is written, and at most CAPTION_CHARS long. Anything else is no caption.
export function captionOf(text: string): string | undefined {
  const caption = text.replace(/[\s_]+/g, ' ').trim();
  return caption.length <= CAPTION_CHARS && /^[\x20-\x7e]+$/.test(caption) && /[A-Za-z]/.test(caption) ? caption : undefined;
}

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// The format a file's first bytes say, whatever its name or type said.
export function imageFormat(bytes: Uint8Array): Format | undefined {
  return PNG_SIGNATURE.every((byte, at) => bytes[at] === byte) ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
    : bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' ? 'webp' : undefined;
}

// The picture as it will be kept, or a refusal. Its size comes from its own header.
export function strippedReference(bytes: Uint8Array): ReferencePicture {
  if (bytes.length > REFERENCE_BYTES) throw refusal('referenceTooLarge');
  const format = imageFormat(bytes);
  if (!format) throw refusal('referenceType');
  let picture: Picture;
  // A file cut short, or lying about its lengths, is broken, whatever the reading tripped on.
  try { picture = { png, jpeg, webp }[format](bytes); } catch (error) { throw error instanceof UserError ? error : refusal('referenceBroken'); }
  const { min, max, ratio } = REFERENCE_SIDES;
  const across = Math.min(picture.width, picture.height), along = Math.max(picture.width, picture.height);
  if (across < min) throw refusal('referenceSmall');
  if (along > max) throw refusal('referenceHuge');
  if (along > across * ratio) throw refusal('referenceShape');
  return { ...picture, strippedBytes: Math.max(0, bytes.length - picture.bytes.length) };
}

// A kept picture's size in pixels from its own header (local/picture-references.ts, which scales each reference to its
// own shape): a PNG's header chunk alone, as the bot has always read a portrait the card drew, and a JPEG or a WebP,
// which only a reader sends, walked as it was on its way in.
export function pictureSize(bytes: Uint8Array): { width: number; height: number } {
  const format = imageFormat(bytes);
  if (format === 'png') return pngSize(bytes);
  if (!format) throw refusal('referenceType');
  const { width, height } = { jpeg, webp }[format](bytes);
  return { width, height };
}

// The chunks a picture needs, copied byte for byte once their CRCs are checked: the header first, the palette and its
// transparency, the pixels, and the end, where reading stops. Every ancillary chunk goes — tEXt, iTXt, zTXt, eXIf, iCCP
// and the rest, an animation's among them, which leaves its first frame — and a critical one the bot does not know
// refuses the picture, since its pixels could not be read without it.
const PNG_KEPT = ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'];
function png(bytes: Uint8Array): Picture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  const types: string[] = [];
  for (let at = 8; types.at(-1) !== 'IEND';) {
    if (at + 12 > bytes.length) throw refusal('referenceBroken');
    const length = view.getUint32(at), end = at + 12 + length;
    const type = ascii(bytes, at + 4, 4);
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)
      || crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw refusal('referenceBroken');
    if (PNG_KEPT.includes(type)) kept.push(bytes.subarray(at, end));
    else if (/^[A-Z]/.test(type)) throw refusal('referenceType');
    types.push(type);
    at = end;
  }
  if (types[0] !== 'IHDR' || view.getUint32(8) !== 13 || !types.includes('IDAT')) throw refusal('referenceBroken');
  return { bytes: Buffer.concat(kept), format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

// Baseline and progressive JPEG coded by Huffman, 8 bits in grey or in colour: what cameras, phones and drawing programs
// write, and what Telegram shows. The segments a decoder needs are copied as they are — the frame, the Huffman and
// quantization tables, the restart interval, and each scan with its data — and so are Adobe's 12 bytes, which say
// whether three channels are RGB or YCbCr and nothing else. Every APPn segment (EXIF and XMP in APP1, ICC and MPF in
// APP2, JFIF with its thumbnail, Photoshop's), every comment, and everything after the picture's end go.
function jpeg(bytes: Uint8Array): Picture {
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let size: { width: number; height: number } | undefined;
  let scans = 0;
  let at = 2;
  for (;;) {
    if (bytes[at] !== 0xff) throw refusal('referenceBroken');
    // Any number of fill bytes may come before a marker.
    while (bytes[at + 1] === 0xff) at++;
    const marker = bytes[at + 1];
    if (marker === 0xd9) break;
    // A restart, TEM or a second start stands alone, and belongs nowhere between segments.
    if (marker === undefined || marker <= 0x01 || (marker >= 0xd0 && marker <= 0xd8)) throw refusal('referenceBroken');
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (at + 4 > bytes.length || end < at + 4 || end > bytes.length) throw refusal('referenceBroken');
    if (marker === 0xda) {
      if (!size) throw refusal('referenceBroken');
      // The scan's coded data runs to the next marker other than a restart: a 0xFF inside it is followed by a zero.
      let next = end;
      while (next + 1 < bytes.length && !(bytes[next] === 0xff && bytes[next + 1] !== 0 && (bytes[next + 1] < 0xd0 || bytes[next + 1] > 0xd7))) next++;
      if (next + 1 >= bytes.length) throw refusal('referenceBroken');
      kept.push(bytes.subarray(at, next));
      scans++;
      at = next;
      continue;
    }
    // SOF0 to SOF15, apart from DHT, JPG and DAC among them: lossless, hierarchical and arithmetic frames are refused.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const components = bytes[at + 9];
      if (marker > 0xc2 || bytes[at + 4] !== 8 || (components !== 1 && components !== 3)) throw refusal('referenceType');
      if (size || end !== at + 10 + 3 * components) throw refusal('referenceBroken');
      size = { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
      if (!size.width || !size.height) throw refusal('referenceBroken');
    }
    if ((marker >= 0xc0 && marker <= 0xc2) || marker === 0xc4 || marker === 0xdb || marker === 0xdd
      || (marker === 0xee && end - at === 16 && ascii(bytes, at + 4, 5) === 'Adobe')) kept.push(bytes.subarray(at, end));
    at = end;
  }
  if (!size || !scans) throw refusal('referenceBroken');
  kept.push(Uint8Array.of(0xff, 0xd9));
  return { bytes: Buffer.concat(kept), format: 'jpeg', ...size };
}

// A still WebP, lossy or lossless, written anew around the chunk of its pixels, and for a lossy one with transparency
// the chunk of that too and the header that announces it. ICC, EXIF and XMP chunks go, and so does any other; an
// animation is refused.
function webp(bytes: Uint8Array): Picture {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = 8 + view.getUint32(4, true);
  if (end > bytes.length) throw refusal('referenceBroken');
  const found = new Map<string, Uint8Array>();
  for (let at = 12; at < end; ) {
    const size = at + 8 <= end ? view.getUint32(at + 4, true) : Infinity;
    if (at + 8 + size > end) throw refusal('referenceBroken');
    const type = ascii(bytes, at, 4);
    if (type === 'ANIM' || type === 'ANMF') throw refusal('referenceType');
    if (['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(type) && !found.has(type)) found.set(type, bytes.subarray(at + 8, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  const lossless = found.get('VP8L'), lossy = found.get('VP8 '), alpha = found.get('ALPH'), header = found.get('VP8X');
  let width: number, height: number;
  if (lossless && !lossy) {
    // A signature byte, then the width and height less one in 14 bits each, a flag and a version, which is 0.
    const bits = lossless.length >= 5 && lossless[0] === 0x2f ? (lossless[1] | lossless[2] << 8 | lossless[3] << 16 | lossless[4] << 24) >>> 0 : -1;
    if (bits < 0 || bits >>> 29) throw refusal('referenceBroken');
    [width, height] = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  } else if (lossy && !lossless) {
    // A key frame: its tag's lowest bit clear, the start code, then the width and height in 14 bits each.
    if (lossy.length < 10 || lossy[0] & 1 || lossy[3] !== 0x9d || lossy[4] !== 0x01 || lossy[5] !== 0x2a) throw refusal('referenceBroken');
    [width, height] = [(lossy[6] | lossy[7] << 8) & 0x3fff, (lossy[8] | lossy[9] << 8) & 0x3fff];
  } else throw refusal('referenceBroken');
  // A still picture's canvas is its frame (libwebp refuses one that is not).
  if (header && (header.length < 10 || 1 + (header[4] | header[5] << 8 | header[6] << 16) !== width
    || 1 + (header[7] | header[8] << 8 | header[9] << 16) !== height)) throw refusal('referenceBroken');
  const chunk = (type: string, payload: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(payload.length, 4);
    return Buffer.concat([head, payload, Buffer.alloc(payload.length & 1)]);
  };
  // The extended header of a lossy picture with transparency: the alpha flag, and the canvas less one in 24 bits each.
  const extended = () => {
    const payload = Buffer.alloc(10);
    payload[0] = 0x10;
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
    return chunk('VP8X', payload);
  };
  const body = Buffer.concat(lossless ? [chunk('VP8L', lossless)] : alpha ? [extended(), chunk('ALPH', alpha), chunk('VP8 ', lossy!)] : [chunk('VP8 ', lossy!)]);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write('WEBP', 8, 'latin1');
  return { bytes: Buffer.concat([riff, body]), format: 'webp', width, height };
}

// Bot API PhotoSize, not validated in advance.
type PhotoSize = { file_id?: unknown; file_size?: unknown; width?: unknown; height?: unknown };
const isArchive = (document: TelegramDocument) => /zip/i.test(String(document.mime_type ?? '')) || /\.zip$/i.test(document.file_name ?? '');

// Reads the picture a reader sent while the bot waited for one (local/bot.ts): the largest size of a photo, or a file,
// which is whatever its first bytes say and not what its name or type says. A size Telegram declares over the limit is
// refused before anything is downloaded; the download is seeds' own (local/seed-file.ts), in memory and never on this
// disk; the rest is the picture's (`strippedReference`).
export function createPictureReader(token: string, api: TelegramApi, { get = https.get }: { get?: HttpsGet } = {}) {
  return async (message: { photo?: unknown; document?: TelegramDocument }): Promise<ReceivedPicture> => {
    let file: { id: unknown; size: unknown; sent: ReceivedPicture['sent'] };
    if (Array.isArray(message.photo)) {
      const area = (size: PhotoSize | undefined) => typeof size?.width === 'number' && typeof size.height === 'number' ? size.width * size.height : -1;
      // Telegram sends a photo in several sizes, and the largest is the one to keep.
      const largest = (message.photo as (PhotoSize | undefined)[]).reduce<PhotoSize | undefined>((best, size) => area(size) > area(best) ? size : best, undefined);
      if (!largest) throw refusal('referenceIncomplete');
      file = { id: largest.file_id, size: largest.file_size, sent: 'photo' };
    } else if (message.document) {
      if (isArchive(message.document)) throw refusal('referenceArchive');
      file = { id: message.document.file_id, size: message.document.file_size, sent: 'document' };
    } else throw refusal('referenceType');
    if (typeof file.size === 'number' && file.size > REFERENCE_BYTES) throw refusal('referenceTooLarge');
    const bytes = await downloadFile(token, api, get, file.id, REFERENCE_BYTES,
      { tooLarge: () => refusal('referenceTooLarge'), failed: () => refusal('referenceIncomplete') });
    return { ...strippedReference(bytes), sent: file.sent };
  };
}

// Keeps a picture of `person` in `pose`, pinned there, in the place of what the reader had sent for it, with its English
// caption if it came with one, inside the library write that `person` belongs to. The file is written first and the
// sheet refers to it once that write commits; a rollback deletes it, and the caller sweeps the one it replaced
// (local/store.ts).
export function keepReference(store: Store, userId: string, person: SheetEntry, picture: ReferencePicture, pose: Pose,
  caption: string | undefined, at: number) {
  const { bytes, format, width, height } = picture;
  const own: OwnReference = { source: 'own', file: store.writePortrait(userId, bytes, EXTENSIONS[format]), format, width, height, at,
    pinned: true, ...caption ? { caption } : {} };
  person.poses = { ...person.poses, [pose]: own };
}
