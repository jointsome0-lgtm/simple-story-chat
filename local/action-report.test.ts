import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileOf, frameKey } from './action-draw.ts';
import type { CellRecord, DrawIndex } from './action-draw.ts';
import type { StoryPlan } from './action-prompts.ts';
import { storyDir } from './action-text.ts';
import { writeGalleries } from './action-report.ts';

// A leak onto the one page outside sealed/ that is built from the sharp stories' plans and records while the card
// draws, which whoever opens the clean page sees: it shows a sharp story as counts alone, with no id, theme, prompt or
// picture of it, and not the sharp cell drawing now, while the sealed page shows it cell by cell.
test('the clean gallery shows the sharp stories as counts alone while they are drawn', t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const word = 'Зурбаганец';
  const plan = (id: string): StoryPlan => ({ id, arms: { A: { prompt: `${word} stands`, references: [] }, C: { prompt: `${word} holds`, references: [`${id}-e1`] } },
    out: {}, vIsC: true, portraits: [{ id: `${id}-e1`, entry: 'e1', prompt: `${word} alone` }], views: [], counts: {} });
  const cells: Record<string, CellRecord> = {};
  const record = (story: string, arm: 'A' | 'C' | undefined, status: CellRecord['status']) => {
    const cell = { kind: arm ? 'frame' as const : 'front' as const, story, id: arm ? `${story}-s7-${arm}` : `${story}-e1`, seed: 7, ...(arm ? { arm } : {}) };
    const key = arm ? frameKey(story, 7, arm) : `front:${cell.id}`, file = fileOf(root, cell);
    if (status === 'drawn') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'png');
    }
    cells[key] = { key, ...cell, status, references: arm === 'C' ? 1 : 0, ...(status === 'drawn' ? { file: relative(root, file), totalMs: 16000 } : { code: 'image_failed' }) };
  };
  for (const story of ['flight', 'sharp-1']) {
    mkdirSync(storyDir(root, story), { recursive: true });
    writeFileSync(join(storyDir(root, story), 'plan.json'), JSON.stringify(plan(story)));
    record(story, undefined, 'drawn');
  }
  record('flight', 'A', 'drawn');
  record('flight', 'C', 'drawn');
  record('sharp-1', 'A', 'failed');
  // The smoke passed and seed 7 is admitted; sharp-1's C is drawing now.
  const draw: DrawIndex = { pins: {}, startedAt: new Date().toISOString(), cells, admitted: { 7: true },
    smoke: { keys: ['front:flight-e1', frameKey('flight', 7, 'A'), frameKey('flight', 7, 'C')],
      verdict: { pass: true, tOut: false, cells: 3, drawn: true, geometry: true, slots: true, heard: true, memory: true, failing: [] } } };
  writeFileSync(join(root, 'draw.json'), JSON.stringify(draw));
  writeGalleries(root, { until: Date.now() + 3600000 });
  const clean = readFileSync(join(root, 'gallery.html'), 'utf8'), sealed = readFileSync(join(root, 'sealed', 'gallery.html'), 'utf8');
  assert.ok(clean.includes('clean/flight/pictures/s7-A.png') && clean.includes('острая сцена, кадр сида 7'));
  assert.doesNotMatch(clean, /sharp|sealed|Зурбаганец|общественная баня/);
  assert.ok(sealed.includes('sharp-1/portraits/sharp-1-e1.png') && sealed.includes('image_failed') && sealed.includes('рисуется'));
  assert.doesNotMatch(sealed, /Зурбаганец/);
});
