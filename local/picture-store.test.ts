// The picture store (local/picture-store.ts) keeps each picture once and links it from every stand, bundle and session,
// so a write into any of those names would change all of them and the store's file with them: pictures lost without
// anyone noticing. This file is the one check for that risk (local/AGENTS.md). Placing, building over a placed
// picture, a dry run's tampering and the migration change no picture but the one they are meant to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyDir, migrate, placeBytes, placeFile, put, writePicture } from './picture-store.ts';

test('no picture is written through a link, and the store keeps what it was given', t => {
  const dir = mkdtempSync(join(tmpdir(), 'simple-chat-picture-store-')), store = join(dir, 'store');
  process.env.SIMPLE_CHAT_PICTURES = store;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const inode = (path: string) => lstatSync(path).ino;
  const write = (path: string, bytes: Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  const [one, two, three] = ['one', 'two', 'three'].map(word => Buffer.from(`a made-up picture: ${word}`));
  const stand = join(dir, 'stand', 'one.png'), bundle = join(dir, 'bundle'), session = join(dir, 'session');
  const stored = join(store, sha(one).slice(0, 2), `${sha(one)}.png`);
  write(stand, one);
  mkdirSync(bundle);
  assert.equal(put(stand), sha(one));
  placeFile(stand, join(bundle, 'pic-1.png'));
  placeFile(stand, join(bundle, 'pic-2.png'));
  write(join(bundle, 'input.json'), Buffer.from('{}'));
  copyDir(bundle, session);
  assert.deepEqual([stand, join(bundle, 'pic-1.png'), join(session, 'pic-1.png')].map(inode), [inode(stored), inode(stored), inode(stored)]);
  assert.equal(lstatSync(stored).mode & 0o777, 0o444);
  // Over what is placed: another picture's bytes into the bundle, a tampering write into the session, another stand's
  // file, and the session copied again.
  placeBytes(two, join(bundle, 'pic-1.png'));
  writePicture(join(session, 'pic-1.png'), three);
  write(join(dir, 'stand', 'three.png'), three);
  placeFile(join(dir, 'stand', 'three.png'), join(bundle, 'pic-2.png'));
  copyDir(bundle, session);
  assert.deepEqual([stored, stand, join(bundle, 'pic-1.png'), join(bundle, 'pic-2.png'), join(session, 'pic-1.png'), join(session, 'pic-2.png')]
    .map(path => readFileSync(path)), [one, one, two, three, two, three]);
  // The migration: two copies of a picture become links to the store's file, a third changed within the hour is left
  // alone, and every one of them reads as before.
  const runs = join(dir, 'runs'), copies = [join(runs, 'a', 'x.png'), join(runs, 'b', 'y.png')], recent = join(runs, 'c', 'z.png');
  const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const path of copies) { write(path, one); utimesSync(path, earlier, earlier); }
  write(recent, one);
  const counts = migrate(runs, [], true);
  assert.deepEqual([...copies.map(inode), counts.linked, counts.recent], [inode(stored), inode(stored), 2, 1]);
  assert.notEqual(inode(recent), inode(stored));
  assert.deepEqual([stored, ...copies, recent].map(path => readFileSync(path)), [one, one, one, one]);
  for (const part of readdirSync(store)) {
    for (const name of readdirSync(join(store, part))) assert.equal(sha(readFileSync(join(store, part, name))), name.split('.')[0]);
  }
});
