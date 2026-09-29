// A pose set sent as a ZIP archive, by a reader who has pose sets (local/pose-set.ts) while the bot waits for their
// pictures, and the labels they give its pictures in a labels.csv beside them (the owner, 2026-09-29, for the tester's
// drawings of a character, which are sorted already). The archive is read in memory as it came and never unpacked on
// this disk. Each picture in it goes the way one sent alone goes (local/reference.ts `strippedReference`), and is kept
// under a name of the bot's own: the names inside serve only to match the rows of labels.csv to the pictures, and
// nothing is ever written under them.
//
// An ordinary ZIP is read: entries stored or deflated, none encrypted, no ZIP64 and no parts. Any other is refused as a
// whole, and so is one of more than ARCHIVE_FILES files, one with a path out of it, and a bomb: entries that share their
// bytes, or that would unpack to more than ARCHIVE_UNPACKED together. An entry is unpacked only up to the size its
// directory declares, and its CRC checked. One over REFERENCE_BYTES, an archive inside the archive, and one that says it
// unpacks to far more than it weighs (`ARCHIVE_RATIO`), which no PNG, JPEG or WebP does, are refused alone without being
// unpacked, the last as no picture. Directories, macOS's __MACOSX and files whose name starts with a dot are skipped.
//
// Reading an archive holds the bot, and every reader's updates with it, no longer than reading one picture does: each
// picture is read in a turn of the event loop of its own and walked through at most ARCHIVE_PICTURE_PARTS chunks or
// segments, labels.csv is read up to LABEL_ROWS rows, and a name or a cell is composed only while it is short
// (`composed`). GPT-6 Astra's review of archives found on 2026-09-29 that archives built for it within every limit
// above held the bot for seconds, and one for minutes.
import https from 'node:https';
import { setImmediate as pause } from 'node:timers/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import { FRAMING_LABELS, POSE_LABELS, SIDE_LABELS, UserError } from '../lib/library.ts';
import type { PoseCaption } from '../lib/library.ts';
import type { ArchiveRefusal } from './model-error.ts';
import { REFERENCE_BYTES, REFUSAL_CODES, strippedReference } from './reference.ts';
import type { PictureRefusal, ReferencePicture } from './reference.ts';
import { downloadFile } from './seed-file.ts';
import type { HttpsGet, TelegramDocument } from './seed-file.ts';
import type { TelegramApi } from './telegram.ts';
import { texts } from './text.ts';

// The most an archive may weigh, as much as the Bot API lets a bot download; a larger one is to be sent in parts.
export const ARCHIVE_BYTES = 20 * 1024 * 1024;
// The most files an archive may hold besides labels.csv, as many as a set holds pictures.
export const ARCHIVE_FILES = 200;
// The most entries its directory may list, the skipped ones among them: a folder zipped on a Mac lists each file twice.
const ARCHIVE_ENTRIES = 1000;
// No picture over 64 KiB unpacks to more than ARCHIVE_RATIO times what it weighs packed: PNG, JPEG and WebP barely pack
// at all. And the most the entries to be unpacked may unpack to together.
const ARCHIVE_RATIO = 20;
const ARCHIVE_UNPACKED = 100 * 1024 * 1024;
// The most chunks or segments the walk of a picture of an archive goes through: a PNG of 10 MB has 1,280 in the 8 KiB
// chunks libpng writes, and 4,096 at most written a row a chunk; one built of empty chunks has hundreds of thousands.
const ARCHIVE_PICTURE_PARTS = 16384;
const LABELS_BYTES = 1024 * 1024;
// The most rows labels.csv may fill, five for each picture an archive may hold; a file with more is not read.
const LABEL_ROWS = 1000;

// Why an archive was refused as a whole, by the code of its log row, and the message the reader gets, by its key in the
// interface catalogs (local/text/): one message covers an archive the bot cannot open for any reason the reader fixes
// by packing it again.
const MESSAGES = { too_large: 'poseArchiveTooLarge', incomplete: 'poseArchiveIncomplete', files: 'poseArchiveFiles',
  encrypted: 'poseArchiveEncrypted', broken: 'poseArchiveUnread', unsupported: 'poseArchiveUnread', bomb: 'poseArchiveUnread',
  unsafe: 'poseArchiveUnread' } as const satisfies Record<ArchiveRefusal, string>;
export class ArchiveError extends UserError {
  declare code: ArchiveRefusal;
  constructor(code: ArchiveRefusal) {
    super(texts('ru').errors[MESSAGES[code]], MESSAGES[code]);
    this.code = code;
  }
}

// The labels a reader gave a picture in labels.csv, those of the three they gave, and whether they marked it as the one
// to stand for pictures with the same labels (`main`).
export type GivenLabels = Partial<Pick<PoseCaption, 'pose' | 'side' | 'framing'>>;
// A picture of the archive, as it will be kept, or its refusal's code (local/reference.ts `REFUSAL_CODES`).
export type ArchivePicture = { picture?: ReferencePicture; refused?: typeof REFUSAL_CODES[PictureRefusal]; given?: GivenLabels; main?: true };
// What became of labels.csv: whether the archive had one, and whether it could be read, with the numbers of its rows as
// a spreadsheet shows them, the header being the first: those that matched no picture, and those with a value the bot
// does not know, whose field the captioner fills.
export type ArchiveLabels = { found: boolean; unread?: boolean; rows: number; unmatched: number[]; unknown: number[] };
export type PoseArchive = { pictures: ArchivePicture[]; labels: ArchiveLabels };

// A text in NFC while it is at most `longest` long, and as it came when longer: composing a run of combining marks takes
// time that grows with its square, and neither a path Windows writes (260) nor a word of a label (64) is longer.
const composed = (text: string, longest: number) => text.length > longest ? text : text.normalize('NFC');
// The words labels.csv may give each label in: the English labels themselves, or the Russian the tester thinks in. Left
// and right are the captioner's: the side of the picture the person faces (lib/library.ts `SIDE_LABELS`). A value is
// compared in lower case, with ё as е, and without its spaces, hyphens and underscores.
const word = (value: string) => composed(value, 64).toLowerCase().replaceAll('ё', 'е').replace(/[\s_\-‐-―]+/g, '');
const words = <T extends string>(labels: readonly T[], russian: string[]) =>
  new Map(labels.flatMap((label, at) => [[word(label), label], [word(russian[at]), label]] as const));
const WORDS = {
  pose: words(POSE_LABELS, ['стоя', 'сидя', 'идёт', 'лёжа', 'на коленях', 'присев']),
  side: words(SIDE_LABELS, ['спереди', 'вполоборота влево', 'вполоборота вправо', 'профиль влево', 'профиль вправо', 'спиной']),
  framing: words(FRAMING_LABELS, ['в полный рост', 'по пояс', 'по плечи']),
};
const MAIN = new Set(['yes', '1', 'да'].map(word));
const NESTED = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cbz|cbr)$/i;

type Entry = { path: string; flags: number; method: number; crc: number; packed: number; size: number; offset: number };

// Reads an archive a reader sent: its pictures, stripped, in the order of its directory, and its labels.csv. Refuses it
// as a whole with an `ArchiveError`, and as `incomplete` once `signal` aborts between two of its pictures.
export async function readPoseArchive(bytes: Buffer, signal?: AbortSignal): Promise<PoseArchive> {
  const { entries, directory } = entriesOf(bytes);
  if (entries.some(entry => unsafe(entry.path))) throw new ArchiveError('unsafe');
  const files = entries.filter(entry => !skipped(entry.path));
  if (files.some(entry => entry.flags & 0x41 || entry.method === 99)) throw new ArchiveError('encrypted');
  if (files.some(entry => entry.method !== 0 && entry.method !== 8)) throw new ArchiveError('unsupported');
  // labels.csv at the root, or in the one folder that holds everything, as a folder zipped whole is. Any other file of
  // that name is no picture either.
  const tops = new Set(files.map(entry => entry.path.includes('/') ? entry.path.slice(0, entry.path.indexOf('/') + 1) : ''));
  const folder = tops.size === 1 ? [...tops][0] : '';
  const labelsFile = files.find(entry => key(entry.path) === key(folder + 'labels.csv'));
  const pictures = files.filter(entry => key(entry.path.split('/').at(-1)!) !== 'labels.csv');
  if (pictures.length > ARCHIVE_FILES) throw new ArchiveError('files');
  // Each entry's data within the archive, before its directory, and apart from every other's: entries sharing their
  // bytes are a bomb as well.
  const ranges = [...pictures, ...labelsFile ? [labelsFile] : []].map(entry => ({ entry, ...dataOf(bytes, entry, directory) }))
    .toSorted((one, other) => one.start - other.start);
  if (ranges.some((one, at) => at && one.entry.offset < ranges[at - 1].end)) throw new ArchiveError('bomb');
  const data = new Map(ranges.map(one => [one.entry, one.start]));
  // What keeps an entry packed: an archive by its name, a size over the limit, or a ratio no picture has.
  const packed = (entry: Entry, limit: number): ArchivePicture['refused'] => NESTED.test(entry.path) ? 'archive'
    : entry.size > limit ? 'too_large' : entry.size > 65536 && entry.size > ARCHIVE_RATIO * entry.packed ? 'type' : undefined;
  const unpacking = [...pictures.filter(entry => !packed(entry, REFERENCE_BYTES)), ...labelsFile && !packed(labelsFile, LABELS_BYTES) ? [labelsFile] : []];
  if (unpacking.reduce((sum, entry) => sum + entry.size, 0) > ARCHIVE_UNPACKED) throw new ArchiveError('bomb');

  const labels: ArchiveLabels = { found: !!labelsFile, rows: 0, unmatched: [], unknown: [] };
  const given = new Map<Entry, { given: GivenLabels; main: boolean }>();
  if (labelsFile) {
    let rows: Row[] | undefined;
    try { rows = packed(labelsFile, LABELS_BYTES) ? undefined : labelRows(unpack(bytes, labelsFile, data.get(labelsFile)!)); }
    catch { rows = undefined; }
    if (!rows) labels.unread = true;
    else {
      labels.rows = rows.length;
      // A row names its picture by its path from labels.csv's folder or from the archive's root, or by its name alone
      // where no other picture has it. One that could name two pictures, by two of these ways or by paths apart only in
      // case, names none.
      const relative = (entry: Entry) => key(entry.path.slice(folder.length));
      const byPath = Map.groupBy(pictures, relative);
      const byRoot = Map.groupBy(pictures, entry => key(entry.path));
      const byName = Map.groupBy(pictures, entry => relative(entry).split('/').at(-1)!);
      for (const row of rows) {
        const file = key(row.file);
        const named = byName.get(file);
        const found = new Set([...byPath.get(file) ?? [], ...byRoot.get(file) ?? [], ...named?.length === 1 ? named : []]);
        const entry = found.size === 1 ? [...found][0] : undefined;
        if (!entry || given.has(entry)) { labels.unmatched.push(row.row); continue; }
        given.set(entry, { given: row.given, main: row.main });
        if (row.unknown) labels.unknown.push(row.row);
      }
    }
  }
  const pictureOf = (entry: Entry): ArchivePicture => {
    const own = given.get(entry);
    const refused = (code: ArchivePicture['refused']) => ({ refused: code });
    const reason = packed(entry, REFERENCE_BYTES);
    if (reason) return refused(reason);
    let unpacked: Buffer;
    try { unpacked = unpack(bytes, entry, data.get(entry)!); } catch { return refused('broken'); }
    if (nested(unpacked)) return refused('archive');
    try {
      const picture = strippedReference(unpacked, ARCHIVE_PICTURE_PARTS);
      return { picture, ...own && Object.keys(own.given).length ? { given: own.given } : {}, ...own?.main ? { main: true as const } : {} };
    } catch (error) {
      const code = error instanceof UserError && error.key !== undefined && Object.hasOwn(REFUSAL_CODES, error.key)
        ? REFUSAL_CODES[error.key as PictureRefusal] : 'broken';
      return refused(code);
    }
  };
  // Each picture in a turn of the event loop of its own, so that the updates that came meanwhile go first.
  const read: ArchivePicture[] = [];
  for (const entry of pictures) {
    await pause();
    if (signal?.aborted) throw new ArchiveError('incomplete');
    read.push(pictureOf(entry));
  }
  return { labels, pictures: read };
}

// A path to match by: its separators as `/`, without a leading `./`, composed and in lower case.
const key = (path: string) => composed(path.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, ''), 260).toLowerCase();
// Out of the archive: from the root, from a drive, or up a folder.
const unsafe = (path: string) => path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..');
// Skipped: a folder, macOS's __MACOSX, and a file or a folder whose name starts with a dot; `.` alone is the folder
// itself, which some tools write before every name as `./`.
const skipped = (path: string) => {
  const parts = path.split('/').filter(part => part !== '.');
  return path.endsWith('/') || parts[0] === '__MACOSX' || parts.some(part => part.startsWith('.'));
};
// An archive, by its first bytes: ZIP, RAR, 7z, gzip, bzip2 or xz.
const nested = (bytes: Uint8Array) => [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x52, 0x61, 0x72, 0x21], [0x37, 0x7a, 0xbc, 0xaf],
  [0x1f, 0x8b], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58]].some(magic => magic.every((byte, at) => bytes[at] === byte));

// The entries the archive's central directory lists, and where that directory starts.
function entriesOf(bytes: Buffer): { entries: Entry[]; directory: number } {
  const u16 = (at: number) => bytes.readUInt16LE(at), u32 = (at: number) => bytes.readUInt32LE(at);
  // Its end record: the last 22 bytes before a comment of at most 64 KiB, which runs to the end of the file.
  let end = -1;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) throw new ArchiveError('broken');
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  // ZIP64 puts its locator before the end record and all ones in its fields; an archive in parts numbers its disks.
  if ((end >= 20 && u32(end - 20) === 0x07064b50) || count === 0xffff || size === 0xffffffff || start === 0xffffffff
    || u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) throw new ArchiveError('unsupported');
  if (count > ARCHIVE_ENTRIES) throw new ArchiveError('files');
  if (start + size > end) throw new ArchiveError('broken');
  const entries: Entry[] = [];
  for (let at = start; entries.length < count;) {
    if (at + 46 > start + size || u32(at) !== 0x02014b50) throw new ArchiveError('broken');
    const names = u16(at + 28), extras = u16(at + 30), next = at + 46 + names + extras + u16(at + 32);
    if (next > start + size) throw new ArchiveError('broken');
    const entry = { flags: u16(at + 8), method: u16(at + 10), crc: u32(at + 16), packed: u32(at + 20), size: u32(at + 24), offset: u32(at + 42) };
    if (entry.packed === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff || u16(at + 34) === 0xffff) throw new ArchiveError('unsupported');
    entries.push({ ...entry, path: nameOf(bytes.subarray(at + 46, at + 46 + names), entry.flags, bytes.subarray(at + 46 + names, at + 46 + names + extras)).replaceAll('\\', '/') });
    at = next;
  }
  return { entries, directory: start };
}

// An entry's name: UTF-8 when its flag or Info-ZIP's Unicode Path field says so, or when it reads as UTF-8, as a Mac
// writes it without the flag; otherwise the DOS code page of a Russian Windows, which Explorer writes it in.
const utf8 = new TextDecoder('utf-8', { fatal: true });
function nameOf(raw: Uint8Array, flags: number, extra: Uint8Array): string {
  for (let at = 0; at + 4 <= extra.length; at += 4 + (extra[at + 2] | extra[at + 3] << 8)) {
    const field = extra.subarray(at + 4, at + 4 + (extra[at + 2] | extra[at + 3] << 8));
    if ((extra[at] | extra[at + 1] << 8) === 0x7075 && field.length > 5 && field[0] === 1
      && Buffer.from(field.subarray(1, 5)).readUInt32LE(0) === crc32(raw)) {
      try { return utf8.decode(field.subarray(5)); } catch {}
    }
  }
  try { return utf8.decode(raw); } catch {}
  return new TextDecoder(flags & 0x800 ? 'utf-8' : 'ibm866').decode(raw);
}

// Where an entry's packed bytes start and end, after its local header, all of it before the central directory.
function dataOf(bytes: Buffer, entry: Entry, directory: number): { start: number; end: number } {
  if (entry.offset + 30 > directory || bytes.readUInt32LE(entry.offset) !== 0x04034b50) throw new ArchiveError('broken');
  const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
  if (start + entry.packed > directory) throw new ArchiveError('broken');
  return { start, end: start + entry.packed };
}

// An entry unpacked, never past the size its directory declares, and checked against that size and its CRC.
function unpack(bytes: Buffer, entry: Entry, start: number): Buffer {
  const packed = bytes.subarray(start, start + entry.packed);
  const unpacked = entry.method === 0 ? packed : entry.size ? inflateRawSync(packed, { maxOutputLength: entry.size }) : Buffer.alloc(0);
  if (unpacked.length !== entry.size || crc32(unpacked) !== entry.crc) throw new Error('archive_entry_broken');
  return unpacked;
}

// The rows of labels.csv: UTF-8, its BOM allowed, or else Windows' Cyrillic, which Excel saves a plain CSV in; cells
// apart by a comma or a semicolon, whichever the header has more of, and quoted as a spreadsheet quotes them. The
// header names the columns, in any order: `file`, and any of `pose`, `side`, `framing` and `main`. Without a `file`
// column, or with more than LABEL_ROWS rows filled, it gives none. A row with no cell filled is none either.
type Row = { row: number; file: string; given: GivenLabels; main: boolean; unknown: boolean };
function labelRows(bytes: Uint8Array): Row[] | undefined {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  let text: string;
  try { text = utf8.decode(body); } catch { text = new TextDecoder('windows-1251').decode(body); }
  const first = text.split(/\r\n|\n|\r/, 1)[0];
  const records = cells(text, (first.split(';').length > first.split(',').length ? ';' : ','));
  const head = records.next();
  const header = head.done ? [] : head.value.map(word);
  const at = { file: header.indexOf('file'), pose: header.indexOf('pose'), side: header.indexOf('side'), framing: header.indexOf('framing'),
    main: header.indexOf('main') };
  if (at.file < 0) return undefined;
  const rows: Row[] = [];
  let row = 1;
  for (const record of records) {
    row++;
    if (record.every(cell => !cell.trim())) continue;
    if (rows.length === LABEL_ROWS) return undefined;
    const given: GivenLabels = {};
    let unknown = false;
    for (const field of ['pose', 'side', 'framing'] as const) {
      const value = record[at[field]]?.trim();
      if (!value) continue;
      const label = WORDS[field].get(word(value));
      if (label) Object.assign(given, { [field]: label }); else unknown = true;
    }
    rows.push({ row, file: record[at.file] ?? '', given, main: MAIN.has(word(record[at.main] ?? '')), unknown });
  }
  return rows;
}
// The rows of a CSV text one at a time, each as its cells.
function* cells(text: string, separator: string): Generator<string[], void> {
  let row: string[] = [], cell = '', quoted = false;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[at + 1] === '"') { cell += '"'; at++; }
      else quoted = false;
    } else if (char === '"' && !cell) quoted = true;
    else if (char === separator) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      yield [...row, cell];
      row = []; cell = '';
      if (char === '\r' && text[at + 1] === '\n') at++;
    } else cell += char;
  }
  if (cell || row.length) yield [...row, cell];
}

// Reads an archive a reader sent while the bot waited for a pose set (local/bot.ts): a size Telegram declares over the
// limit is refused before anything is downloaded, and the download is seeds' own (local/seed-file.ts), in memory.
export function createPoseArchiveReader(token: string, api: TelegramApi, { get = https.get }: { get?: HttpsGet } = {}) {
  return async (document: TelegramDocument, signal?: AbortSignal): Promise<PoseArchive> => {
    if (typeof document.file_size === 'number' && document.file_size > ARCHIVE_BYTES) throw new ArchiveError('too_large');
    const bytes = await downloadFile(token, api, get, document.file_id, ARCHIVE_BYTES,
      { tooLarge: () => new ArchiveError('too_large'), failed: () => new ArchiveError('incomplete') }, signal);
    return readPoseArchive(bytes, signal);
  };
}
