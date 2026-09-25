import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeComfy } from './fake-comfy.ts';
import { writeCardRecord } from './image-identity.ts';
import { planAll } from './action-prompts.ts';
import { storyDir, textStories } from './action-text.ts';
import type { StoryText } from './action-text.ts';
import { drawStage, fileOf, pricing } from './action-draw.ts';

// One made-up story ready for its pictures: its text as the text run leaves it, with two people of the sheet bound, the
// plans, and the card's record.
function readyRun(root: string, id: string) {
  const ok = { outcome: 'ok' as const, attempts: 1, ms: 1 };
  const sheet = ['Бранд', 'Лиэль'].map((name, at) => ({ name, look: `An adult with hair ${at}`, outfit: `a tunic ${at}` }));
  const scene = { moment: 'They hold on', shot: 'Medium wide shot', setting: 'A room', objects: '', props: '', light: 'Evening' };
  const text: StoryText = { id, pins: '', steps: { opening: ok, action: ok, sheet: ok, frame: ok, variant: ok }, sheet, worn: sheet,
    frame: { ...scene, people: sheet.map(one => ({ who: one.name, look: '', clothes: '', state: '', action: 'holds on' })) },
    variant: { ...scene, people: sheet.map((one, at) => ({ who: one.name, role: `the holder ${at}`, facing: 'viewer' as const, look: '', clothes: '', state: '', action: 'holds on' })) } };
  mkdirSync(storyDir(root, id), { recursive: true });
  writeFileSync(join(storyDir(root, id), 'text.json'), JSON.stringify(text));
  writeFileSync(join(root, 'texts.json'), JSON.stringify({ pins: { route: 'simple-serving', weights: 'made up' } }));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify(planAll(root, textStories())));
  writeCardRecord(join(root, 'card.txt'));
}

// The card bills every minute and a resume must not redraw or lose what is drawn: a seed that cannot end by --until is
// not begun, a resume draws nothing again, and a directory drawn under other pins is refused before its record is
// touched. The fake's jobs take long enough for the memory to be sampled while they run, as the smoke asks.
test('a seed that cannot end in time is not begun, a resume draws nothing again, and other pins leave the record as it was', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-draw-'));
  const fake = await startFakeComfy({ jobMs: 15, referenceMs: 0, requireUploads: true });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  readyRun(root, 'flight');
  const stage = (stage: 'smoke' | 'main', until = Date.now() + 3600000) => drawStage({ stage, root, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
  assert.equal((await stage('smoke')).smoke?.verdict?.pass, true);
  // The smoke drew the whole of seed 7; seed 11's five frames need more than the five seconds left.
  const drawn = fake.jobs.length;
  const short = await stage('main', Date.now() + 5000);
  assert.deepEqual([short.stopped, short.admission?.at(-1)?.seed, fake.jobs.length], ['admission', 11, drawn]);
  await stage('main');
  const all = fake.jobs.length;
  await stage('main');
  assert.deepEqual([all, fake.jobs.length], [drawn + 5, all]);
  const kept = readFileSync(join(root, 'draw.json'));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8')), plans: 'other' }));
  await assert.rejects(stage('main'), /another plans/);
  assert.ok(readFileSync(join(root, 'draw.json')).equals(kept));
  // A kind of cell the smoke did not draw is never priced at nothing, and a sharp story's pictures are sealed.
  assert.equal(pricing([])({ key: '', kind: 'frame', story: 'flight', id: '', seed: 7, arm: 'T', refs: ['L'], prompt: '' }), Infinity);
  assert.ok(fileOf(root, { kind: 'frame', story: 'sharp-1', id: '', seed: 7, arm: 'A' }).startsWith(join(root, 'sealed', 'sharp-1')));
});
