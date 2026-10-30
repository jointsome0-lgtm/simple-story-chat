// The limits of a pose set's archive (local/pose-archive.ts), where a failure would let an archive past them unnoticed:
// a bomb, names out of the archive, an archive inside it, and a picture over the limit. Synthetic archives only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { ArchiveError, readPoseArchive } from './pose-archive.ts';
import { createPoseCaptioner, keepPoseSetPicture } from './pose-set.ts';
import { Store } from './store.ts';
import { addSeed, newStory } from '../lib/library.ts';

// An archive of `files`, each deflated, or stored where it says so, with the CRC of its bytes unless it gives one, and
// listed at its own bytes unless it gives another file's offset.
function zip(files: { name: string; data: Buffer; stored?: boolean; crc?: number; at?: number }[]): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data, stored, crc, at: listed } of files) {
    const packed = stored ? data : deflateRawSync(data), bytes = Buffer.from(name);
    const header = (size: number, signature: number) => {
      const head = Buffer.alloc(size);
      head.writeUInt32LE(signature, 0);
      const at = size === 30 ? 8 : 10;
      head.writeUInt16LE(stored ? 0 : 8, at);
      head.writeUInt32LE(crc ?? crc32(data), at + 6);
      head.writeUInt32LE(packed.length, at + 10);
      head.writeUInt32LE(data.length, at + 14);
      head.writeUInt16LE(bytes.length, at + 18);
      if (size === 46) head.writeUInt32LE(listed ?? offset, 42);
      return head;
    };
    directory.push(header(46, 0x02014b50), bytes);
    parts.push(header(30, 0x04034b50), bytes, packed);
    offset += 30 + bytes.length + packed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}
async function refused(archive: Buffer) {
  try { await readPoseArchive(archive); } catch (error) { if (error instanceof ArchiveError) return error.code; throw error; }
  return undefined;
}

test('an archive past its limits is refused, whole or picture by picture, and nothing in it is unpacked past them', async () => {
  // A bomb: ten megabytes of zeros weigh ten kilobytes packed. It is no picture and is not unpacked, or its CRC, which
  // is wrong, would have it broken; and two files over the same bytes refuse the archive.
  assert.deepEqual((await readPoseArchive(zip([{ name: 'a.png', data: Buffer.alloc(10 * 1024 * 1024), crc: 0 }]))).pictures, [{ refused: 'type' }]);
  assert.equal(await refused(zip([{ name: 'a.png', data: Buffer.from('x') }, { name: 'b.png', data: Buffer.from('x'), at: 0 }])), 'bomb');
  // Names out of the archive, whichever way they climb.
  for (const name of ['../a.png', 'a/../../a.png', '/a.png', 'C:\\a.png', 'a\\..\\..\\a.png']) {
    assert.equal(await refused(zip([{ name, data: Buffer.from('x') }])), 'unsafe', name);
  }
  // An archive inside is never opened, by its name or by its bytes; a picture over 10 MB is not unpacked, or its CRC,
  // which is wrong, would have it broken; the archive itself is read.
  const inner = zip([{ name: 'a.png', data: Buffer.from('x') }]);
  const archive = await readPoseArchive(zip([{ name: 'inner.zip', data: inner }, { name: 'inner.png', data: inner },
    { name: 'big.png', data: randomBytes(10 * 1024 * 1024 + 1), stored: true, crc: 0 }, { name: 'labels.csv', data: Buffer.from('file,pose\nbig.png,standing\n') }]));
  assert.deepEqual(archive.pictures.map(one => one.refused), ['archive', 'archive', 'too_large']);
  assert.deepEqual(archive.labels, { found: true, rows: 1, unmatched: [], unknown: [] });
});

// Labels must not disappear on import, append or restart, and an overlong manual field must not silently select
// another variant. The pixels are a generated blank square, never a reader's picture.
test('old and extended CSV labels survive append and reload without replacing earlier pictures', { timeout: 5000 }, async t => {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(320); ihdr.writeUInt32BE(320, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(320 * (320 * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
  const read = (csv: string) => readPoseArchive(zip([{ name: 'a.png', data: png, stored: true },
    { name: 'labels.csv', data: Buffer.from(csv), stored: true }]));
  const old = await read('file,pose,side,framing,main\na.png,standing,front,full body,1\n');
  assert.deepEqual(old.labels.unknown, []);
  assert.deepEqual(old.pictures[0].given, { pose: 'standing', side: 'front', framing: 'full body' });
  assert.equal(old.pictures[0].main, true);
  const header = 'file,pose,side,framing,main,specific_pose,pose_details,expression,face_visibility\n';
  const extra = await read(header + 'a.png,all_fours,profile left,full body,0,arched_back,"palms down, back arched",neutral,partial\n');
  const next = extra.pictures[0];
  assert.deepEqual(extra.labels.unknown, []);
  assert.equal(next.given?.pose, 'all_fours');
  assert.equal(next.specificPose, 'arched_back');
  assert.equal(next.poseDetails, 'palms down, back arched');
  assert.equal(next.expression, 'neutral'); assert.equal(next.faceVisibility, 'partial');
  assert.equal(next.main, undefined);
  const limit = await read(header + `a.png,на четвереньках,profile left,full body,0,${'a'.repeat(64)},${'b'.repeat(320)},${'c'.repeat(160)},visible\n`);
  assert.deepEqual(limit.labels.unknown, []);
  assert.equal(limit.pictures[0].given?.pose, 'all_fours');
  assert.equal(limit.pictures[0].poseDetails?.length, 320);
  const over = await read(header + `a.png,all_fours,profile left,full body,0,${'a'.repeat(65)},${'b'.repeat(321)},${'c'.repeat(161)},unknown\n`);
  assert.deepEqual(over.labels.unknown, [2]);
  for (const field of ['specificPose', 'poseDetails', 'expression', 'faceVisibility'] as const) assert.equal(over.pictures[0][field], undefined);
  const expanded = await read(header + `a.png,all_fours,profile left,full body,0,${'\u0344'.repeat(64)},,,\n`);
  assert.deepEqual(expanded.labels.unknown, [2], 'normalisation may expand a field; reject before accepting its row');
  assert.equal(expanded.pictures[0].specificPose, undefined);

  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-pose-labels-'));
  const path = join(directory, 'story.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const storyId = store.mutate('1', state => {
    const { story } = newStory(state, addSeed(state, 'Synthetic room\n2026-09-30 12:00\nAn adult waits in an empty room.').id);
    story.sheet = [{ name: 'Synthetic person', look: 'adult' }];
    keepPoseSetPicture(store, '1', story.sheet[0], old.pictures[0].picture!, 1, old.pictures[0]);
    return story.id;
  });
  const first = store.read('1').stories[storyId].sheet![0].poseSet![0];
  store.mutate('1', state => keepPoseSetPicture(store, '1', state.stories[storyId].sheet![0], next.picture!, 2, next));
  store.close(); store = new Store(path);
  const pictures = store.read('1').stories[storyId].sheet![0].poseSet!;
  assert.equal(pictures.length, 2);
  assert.deepEqual(pictures[0], first);
  assert.equal(pictures[1].caption?.pose, 'all_fours', 'complete manual labels bypass the six-pose captioner');
  assert.equal(pictures[1].given?.pose, 'all_fours');
  for (const field of ['specificPose', 'poseDetails', 'expression', 'faceVisibility'] as const) assert.equal(pictures[1][field], next[field]);
  assert.equal(store.sweepPortraits('1'), 0, 'both old and appended files remain referenced after reload');
  // A six-label captioner may fill missing side/framing, but must not erase a manually supplied seventh pose.
  store.mutate('1', state => keepPoseSetPicture(store, '1', state.stories[storyId].sheet![0], next.picture!, 3,
    { given: { pose: 'all_fours' }, specificPose: 'arched_back' }));
  const output = new PassThrough(), done = Promise.withResolvers<void>();
  let calls = 0;
  const input = new Writable({ write(bytes, _encoding, callback) {
    calls++;
    const { id } = JSON.parse(bytes.toString());
    output.write(JSON.stringify({ id, pose: 'kneeling', side: 'profile left', framing: 'full body', confidence: 0.8 }) + '\n');
    callback();
  }, final(callback) { output.end(); callback(); } });
  const child = Object.assign(new EventEmitter(), { stdin: input, stdout: output, exitCode: null, signalCode: null });
  const captioner = createPoseCaptioner({ python: 'unused', script: 'unused', model: 'unused', threads: 1 }, {
    store, log: () => event => { if (event === 'pose_captioned') done.resolve(); },
    spawnProcess: (() => { queueMicrotask(() => output.write('{"ready":true}\n')); return child; }) as unknown as typeof spawn,
  });
  try {
    captioner.enqueue('1');
    await done.promise;
    const captioned = store.read('1').stories[storyId].sheet![0].poseSet!;
    assert.equal(calls, 1, 'complete legacy/manual labels do not get captioned again');
    assert.deepEqual(captioned[2].caption, { pose: 'all_fours', side: 'profile left', framing: 'full body', confidence: 0.8 });
    assert.equal(captioned[2].specificPose, 'arched_back');
    assert.deepEqual(captioned.slice(0, 2), pictures);
  } finally { await captioner.stop(); }
});
