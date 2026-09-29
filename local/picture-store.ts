// The picture store (docs/action-experiment.md#picture-store): each picture the judging and the stands hand on is kept
// once, under its sha256, and every bundle, session copy and stand that holds it holds a hard link to that file: never
// a copy and never a symlink. A store file is 0444, its directories 0700. No picture path is ever written into, since a
// write through one link would change every bundle that holds the picture: a picture goes to a temporary name beside
// its path and is renamed over whatever was there.
// The store is ~/simple-story-chat-runs/pictures, or SIMPLE_CHAT_PICTURES (the tests' and the dry runs' own), laid out
// <two hex>/<sha256>.<ext>. A picture under a directory named `sealed` is kept in that directory's own store,
// sealed/pictures, and never linked from outside it, so that nothing of a sharp scene leaves sealed/
// (docs/action-experiment.md#sealed).
//   npm run image:pictures -- gc [--store <dir>] [--apply]
//   npm run image:pictures -- migrate --root <dir> [--skip <dir>]... [--store <dir>] [--apply]
// `gc` finds the store's files that nothing else links and that were left alone for an hour, and removes them with
// --apply. `migrate` puts every picture under the root into the store and swaps each copy for a link, by a link under
// a temporary name renamed over the copy. It leaves the --skip directories, every `sealed` and hidden directory, a
// picture changed in the last hour, and a picture whose file has a name outside what it walks, where its mode would
// change too. Without --apply both only count. They print counts and sizes, one JSON object a line: never a name or a
// picture.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

export const PICTURE = /\.(png|jpe?g|webp|gif)$/i;
export const STORE_CODES = ['not_a_file', 'picture_changed', 'store_mismatch', 'not_in_store', 'sealed_outside'];
const fail = (code: string) => Object.assign(new Error(code), { code });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const HOUR = 60 * 60 * 1000;
const temporary = (path: string) => join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);

export const storeRoot = () => resolve(process.env.SIMPLE_CHAT_PICTURES || join(homedir(), 'simple-story-chat-runs', 'pictures'));
// The outermost `sealed` directory a path lies in, if any.
const sealedOf = (path: string) => {
  const parts = resolve(path).split(sep), at = parts.indexOf('sealed');
  return at < 0 ? undefined : parts.slice(0, at + 1).join(sep);
};
export const storeOf = (path: string) => {
  const sealed = sealedOf(path);
  return sealed ? join(sealed, 'pictures') : storeRoot();
};
const storedAt = (store: string, sha: string, ext: string) => join(store, sha.slice(0, 2), `${sha}${ext.toLowerCase()}`);
function same(stored: string, sha: string, size: number) {
  if (lstatSync(stored).size !== size || sha256(readFileSync(stored)) !== sha) throw fail('store_mismatch');
}

// A picture into the store, returning its sha256: the file itself is linked in where the store lacks it, else the
// store's file is checked against it, size and hash. The file is left 0444 either way: nothing writes into it again.
export function put(file: string, store = storeOf(file)): string {
  const sealed = sealedOf(file);
  if (sealed && resolve(store) !== join(sealed, 'pictures')) throw fail('sealed_outside');
  const before = lstatSync(file);
  if (!before.isFile()) throw fail('not_a_file');
  const bytes = readFileSync(file), sha = sha256(bytes), stored = storedAt(store, sha, extname(file));
  mkdirSync(dirname(stored), { recursive: true, mode: 0o700 });
  try {
    linkSync(file, stored);
    // Linked, the store's file is this one: the very file that was read, unchanged since.
    const after = lstatSync(stored);
    if (after.ino !== before.ino || after.size !== bytes.length || after.mtimeMs !== before.mtimeMs) {
      unlinkSync(stored);
      throw fail('picture_changed');
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EXDEV') storeBytes(bytes, sha, stored);
    else if (code !== 'EEXIST') throw error;
    else if (lstatSync(stored).ino !== before.ino) same(stored, sha, bytes.length);
  }
  chmodSync(stored, 0o444);
  chmodSync(file, 0o444);
  return sha;
}
// A store file from bytes, whole or not at all: written under a temporary name, linked in and the temporary unlinked.
function storeBytes(bytes: Uint8Array, sha: string, stored: string) {
  if (existsSync(stored)) return same(stored, sha, bytes.length);
  mkdirSync(dirname(stored), { recursive: true, mode: 0o700 });
  const temp = `${stored}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, bytes, { mode: 0o444, flag: 'wx' });
  try {
    chmodSync(temp, 0o444);
    linkSync(temp, stored);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    same(stored, sha, bytes.length);
  } finally { unlinkSync(temp); }
}

// The store's picture at `dst`: nothing where dst is that file already, else a link to it under a temporary name,
// renamed over dst. A copy only where dst is on another file system than the store.
export function place(sha: string, dst: string, ext = extname(dst)): 'kept' | 'linked' | 'copied' {
  const stored = storedAt(storeOf(dst), sha, ext), from = lstatSync(stored, { throwIfNoEntry: false });
  if (!from) throw fail('not_in_store');
  const to = lstatSync(dst, { throwIfNoEntry: false });
  if (to && to.ino === from.ino && to.dev === from.dev) return 'kept';
  const temp = temporary(dst);
  let how: 'linked' | 'copied' = 'linked';
  try { linkSync(stored, temp); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    copyFileSync(stored, temp, constants.COPYFILE_EXCL);
    how = 'copied';
  }
  try { renameSync(temp, dst); } catch (error) { rmSync(temp, { force: true }); throw error; }
  return how;
}
// A picture file at `dst` through the store; `sha`, where given, is what the file must hold.
export function placeFile(file: string, dst: string, sha?: string) {
  const own = put(file, storeOf(dst));
  if (sha !== undefined && own !== sha) throw fail('picture_changed');
  return place(own, dst, extname(file));
}
// A picture made here, as a bundle's crop is, at `dst` through the store.
export function placeBytes(bytes: Uint8Array, dst: string) {
  const sha = sha256(bytes);
  storeBytes(bytes, sha, storedAt(storeOf(dst), sha, extname(dst)));
  return place(sha, dst);
}
// A directory as a session's copy of its bundle: the pictures placed, the rest copied.
export function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name), target = join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile() && PICTURE.test(entry.name)) placeFile(source, target);
    else cpSync(source, target);
  }
}
// A picture written where one may lie already, as the dry runs' tampering does: a new file renamed over the old one.
export function writePicture(path: string, bytes: Uint8Array) {
  const temp = temporary(path);
  writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, path); } catch (error) { rmSync(temp, { force: true }); throw error; }
}
// A store for the length of `work`, as a dry run keeps its pictures in its own directory.
export async function withStore<T>(store: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.SIMPLE_CHAT_PICTURES;
  process.env.SIMPLE_CHAT_PICTURES = store;
  try { return await work(); } finally {
    if (previous === undefined) delete process.env.SIMPLE_CHAT_PICTURES; else process.env.SIMPLE_CHAT_PICTURES = previous;
  }
}

// The store's own files, a crash's temporary ones included: only names the store gives are looked at, so that a wrong
// --store finds nothing to remove.
const STORED = /^([0-9a-f]{64})(\.[a-z0-9]+)?(\.[0-9a-f]{12}\.tmp)?$/;
function* storeFiles(store: string) {
  if (!existsSync(store)) return;
  for (const part of readdirSync(store)) {
    if (!/^[0-9a-f]{2}$/.test(part)) continue;
    for (const name of readdirSync(join(store, part))) {
      const match = STORED.exec(name), path = join(store, part, name);
      if (!match || !name.startsWith(part)) continue;
      const stat = lstatSync(path);
      if (stat.isFile()) yield { path, stat, sha: match[1], ext: match[2] ?? '', temp: match[3] !== undefined };
    }
  }
}
export function gc(store = storeRoot(), apply = false) {
  const counts = { files: 0, bytes: 0, orphans: 0, orphanBytes: 0, removed: 0 };
  for (const { path, stat } of storeFiles(store)) {
    counts.files++;
    counts.bytes += stat.size;
    if (stat.nlink !== 1 || Date.now() - stat.ctimeMs < HOUR) continue;
    counts.orphans++;
    counts.orphanBytes += stat.size;
    if (apply && lstatSync(path).nlink === 1) { unlinkSync(path); counts.removed++; }
  }
  return counts;
}

// Every picture under `root` into the store, and every copy of it swapped for a link (see the head of this file).
export function migrate(root: string, skips: string[], apply: boolean, store = storeOf(root)) {
  const leave = new Set([resolve(store), ...skips.map(one => resolve(one))]), began = Date.now();
  const dirs = { skipped: 0, sealed: 0, hidden: 0 }, files: { path: string; stat: Stats }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (leave.has(path)) dirs.skipped++;
        else if (entry.name === 'sealed') dirs.sealed++;
        else if (entry.name.startsWith('.')) dirs.hidden++;
        else walk(path);
      } else if (entry.isFile() && PICTURE.test(entry.name)) files.push({ path, stat: lstatSync(path) });
    }
  };
  if (!leave.has(resolve(root))) walk(resolve(root));
  const inode = (stat: Stats) => `${stat.dev}:${stat.ino}`;
  // Which file the store holds each picture in, and each walked file's names within the walk.
  const shaOf = new Map<string, string>(), holder = new Map<string, string>(), names = new Map<string, number>(), left = new Map<string, number>();
  for (const one of storeFiles(store)) {
    if (one.temp) continue;
    shaOf.set(inode(one.stat), one.sha);
    holder.set(one.sha + one.ext, inode(one.stat));
  }
  for (const { stat } of files) names.set(inode(stat), (names.get(inode(stat)) ?? 0) + 1);
  const counts = { pictures: files.length, bytes: 0, recent: 0, outside: 0, distinct: 0, distinctBytes: 0, stored: 0, kept: 0, linked: 0,
    freedBytes: 0, failed: {} as Record<string, number>, dirs };
  const seen = new Set<string>();
  for (const { path, stat } of files) {
    counts.bytes += stat.size;
    const at = inode(stat), ext = extname(path).toLowerCase();
    if (began - stat.mtimeMs < HOUR) { counts.recent++; continue; }
    const inStore = shaOf.has(at) && holder.get(shaOf.get(at)! + ext) === at;
    if (!inStore && names.get(at)! < stat.nlink) { counts.outside++; continue; }
    try {
      let sha = shaOf.get(at), how: 'kept' | 'linked' | 'copied';
      if (apply) {
        const again = lstatSync(path);
        if (inode(again) !== at || again.mtimeMs !== stat.mtimeMs || again.size !== stat.size) throw fail('picture_changed');
        if (sha === undefined || !holder.has(sha + ext)) sha = put(path, store);
        const kept = inode(lstatSync(storedAt(store, sha, ext)));
        if (!holder.has(sha + ext) && kept === at) counts.stored++;
        holder.set(sha + ext, kept);
        how = place(sha, path, ext);
      } else {
        sha ??= sha256(readFileSync(path));
        if (!holder.has(sha + ext)) { holder.set(sha + ext, at); counts.stored++; }
        how = holder.get(sha + ext) === at ? 'kept' : 'linked';
      }
      shaOf.set(at, sha);
      if (!seen.has(sha + ext)) { seen.add(sha + ext); counts.distinct++; counts.distinctBytes += stat.size; }
      if (how === 'kept') { counts.kept++; continue; }
      counts.linked++;
      left.set(at, (left.get(at) ?? stat.nlink) - 1);
      if (left.get(at) === 0) counts.freedBytes += stat.size;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOSPC') throw error;
      const name = typeof code === 'string' ? code : 'error';
      counts.failed[name] = (counts.failed[name] ?? 0) + 1;
    }
  }
  return counts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const print = (value: object) => console.log(JSON.stringify(value));
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' }, skip: { type: 'string', multiple: true },
      store: { type: 'string' }, apply: { type: 'boolean', default: false } } });
    const command = positionals[0], apply = values.apply!;
    if (command === 'gc') print({ event: 'gc', apply, ...gc(resolve(values.store ?? storeRoot()), apply) });
    else if (command === 'migrate' && values.root) {
      const root = resolve(values.root);
      print({ event: 'migrate', apply, ...migrate(root, values.skip ?? [], apply, resolve(values.store ?? storeOf(root))) });
    } else {
      console.error('Use: picture-store.ts gc [--store <dir>] [--apply] | migrate --root <dir> [--skip <dir>]... [--store <dir>] [--apply]');
      process.exitCode = 2;
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(JSON.stringify({ event: 'error', code: typeof code === 'string' ? code : 'error' }));
    process.exitCode = 1;
  }
}
