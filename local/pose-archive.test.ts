// The limits of a pose set's archive (local/pose-archive.ts), where a failure would let an archive past them unnoticed:
// a bomb, names out of the archive, an archive inside it, and a picture over the limit. Synthetic archives only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { ArchiveError, readPoseArchive } from './pose-archive.ts';

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
function refused(archive: Buffer) {
  try { readPoseArchive(archive); } catch (error) { if (error instanceof ArchiveError) return error.code; throw error; }
  return undefined;
}

test('an archive past its limits is refused, whole or picture by picture, and nothing in it is unpacked past them', () => {
  // A bomb: ten megabytes of zeros weigh ten kilobytes packed. It is no picture and is not unpacked, or its CRC, which
  // is wrong, would have it broken; and two files over the same bytes refuse the archive.
  assert.deepEqual(readPoseArchive(zip([{ name: 'a.png', data: Buffer.alloc(10 * 1024 * 1024), crc: 0 }])).pictures, [{ refused: 'type' }]);
  assert.equal(refused(zip([{ name: 'a.png', data: Buffer.from('x') }, { name: 'b.png', data: Buffer.from('x'), at: 0 }])), 'bomb');
  // Names out of the archive, whichever way they climb.
  for (const name of ['../a.png', 'a/../../a.png', '/a.png', 'C:\\a.png', 'a\\..\\..\\a.png']) {
    assert.equal(refused(zip([{ name, data: Buffer.from('x') }])), 'unsafe', name);
  }
  // An archive inside is never opened, by its name or by its bytes; a picture over 10 MB is not unpacked, or its CRC,
  // which is wrong, would have it broken; the archive itself is read.
  const inner = zip([{ name: 'a.png', data: Buffer.from('x') }]);
  const archive = readPoseArchive(zip([{ name: 'inner.zip', data: inner }, { name: 'inner.png', data: inner },
    { name: 'big.png', data: randomBytes(10 * 1024 * 1024 + 1), stored: true, crc: 0 }, { name: 'labels.csv', data: Buffer.from('file,pose\nbig.png,standing\n') }]));
  assert.deepEqual(archive.pictures.map(one => one.refused), ['archive', 'archive', 'too_large']);
  assert.deepEqual(archive.labels, { found: true, rows: 1, unmatched: [], unknown: [] });
});
