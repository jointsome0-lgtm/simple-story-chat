import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Refusal } from './action-boundary.ts';
import type { DrawIndex } from './action-draw.ts';
import { drawProbe, sceneOf } from './image-t-probe.ts';

// A file of its own because the probe is a path of its own from round one's directory, whose sealed/ the owner's deny
// covers, to illustrations/t-probe, which no deny covers, and on to a rented card: a sealed story it read would be
// drawn there and shown on the owner's open page. So a sharp id, the marker and a clean scene whose directory is a
// link into sealed/ are refused, and before the card's record, round one's record or the server is read. The rest of
// the probe is left to its dry run (npm run image:t-probe -- dry-run).
test('the probe refuses a sealed story, the marker and a link into sealed/, before anything is read or sent', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-t-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'round');
  mkdirSync(join(source, 'sealed', 'sharp-1'), { recursive: true });
  writeFileSync(join(source, 'sealed', 'sharp-1', 'plan.json'), '{}');
  mkdirSync(join(source, 'clean'));
  symlinkSync(join(source, 'sealed', 'sharp-1'), join(source, 'clean', 'tango'));
  const round: DrawIndex = { pins: {}, startedAt: '', cells: {} };
  for (const id of ['sharp-1', 'marker', 'tango']) assert.throws(() => sceneOf(source, round, id), Refusal, id);
  // Nothing listens on port 9, and the probe directory has no card's record: the refusal comes first.
  await assert.rejects(drawProbe({ source, out: join(root, 'probe'), comfy: 'http://127.0.0.1:9', until: Date.now() + 60000, scenes: ['tango', 'sharp-1'] }),
    (error: unknown) => error instanceof Refusal && /sharp-1 is not a clean scene/.test(error.message));
});
