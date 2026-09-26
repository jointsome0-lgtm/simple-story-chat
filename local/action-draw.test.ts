import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { greyPng, startFakeComfy } from './fake-comfy.ts';
import { stripPngMetadata } from './image-batch.ts';
import { writeCardRecord } from './image-identity.ts';
import { planAll } from './action-prompts.ts';
import { storyDir, textStories } from './action-text.ts';
import type { ActionArm, StoryText } from './action-text.ts';
import { drawStage, fileOf, frameKey, pricing } from './action-draw.ts';
import type { DrawIndex } from './action-draw.ts';

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
// not begun, a resume draws nothing again, a failure that stopped the run included, a picture whose file is gone is
// refused as data lost, and plans changed after `prompts` are refused before the record is touched. The fake's jobs
// last until the memory has been sampled while they run, as the smoke asks (fake-comfy.ts `untilSampled`).
test('a seed that cannot end in time is not begun, a resume draws nothing again, and other plans leave the record as it was', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-draw-'));
  const fake = await startFakeComfy({ jobMs: 15, referenceMs: 0, requireUploads: true, untilSampled: true });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  readyRun(root, 'flight');
  const stage = (stage: 'smoke' | 'main', until = Date.now() + 3600000) => drawStage({ stage, root, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
  assert.equal((await stage('smoke')).smoke?.verdict?.pass, true);
  // The smoke drew the whole of seed 7; seed 11's five frames need more than the five seconds left.
  const drawn = fake.jobs.length;
  const short = await stage('main', Date.now() + 5000);
  assert.deepEqual([short.stopped, short.admission?.at(-1)?.seed, fake.jobs.length], ['admission', 11, drawn]);
  // Seed 11's A as a failure that stopped the run, the server's: it keeps its outcome, and the rest is drawn after it.
  const index = JSON.parse(readFileSync(join(root, 'draw.json'), 'utf8')) as DrawIndex;
  index.cells[frameKey('flight', 11, 'A')] = { key: frameKey('flight', 11, 'A'), kind: 'frame', story: 'flight', id: 'flight-s11-A', seed: 11, arm: 'A',
    status: 'failed', code: 'comfy_http_error', references: 0 };
  writeFileSync(join(root, 'draw.json'), JSON.stringify(index));
  await stage('main');
  const all = fake.jobs.length;
  await stage('main');
  assert.deepEqual([all, fake.jobs.length], [drawn + 4, all]);
  const kept = readFileSync(join(root, 'draw.json'));
  const lost = fileOf(root, { kind: 'frame', story: 'flight', id: '', seed: 11, arm: 'L' }), picture = readFileSync(lost);
  rmSync(lost);
  await assert.rejects(stage('main'), /data lost/);
  assert.deepEqual([fake.jobs.length, readFileSync(join(root, 'draw.json')).equals(kept)], [all, true]);
  writeFileSync(lost, picture);
  // A plan changed after `prompts`, whatever prompts.json says: its files are hashed as they are read.
  const planFile = join(storyDir(root, 'flight'), 'plan.json');
  writeFileSync(planFile, JSON.stringify({ ...JSON.parse(readFileSync(planFile, 'utf8')), changed: true }));
  await assert.rejects(stage('main'), /plan\.json changed/);
  assert.ok(readFileSync(join(root, 'draw.json')).equals(kept));
  // A kind of cell the smoke did not draw is never priced at nothing, and a sharp story's pictures are sealed.
  assert.equal(pricing([])({ key: '', kind: 'frame', story: 'flight', id: '', seed: 7, arm: 'T', refs: ['L'], prompt: '' }), Infinity);
  assert.ok(fileOf(root, { kind: 'frame', story: 'sharp-1', id: '', seed: 7, arm: 'A' }).startsWith(join(root, 'sealed', 'sharp-1')));
});

// A dropped connection must neither pay for a picture twice nor lose one unnoticed
// (docs/action-experiment.md#dropped-connection). After the smoke a cell waits for the server within its window, and
// its job goes out once, under the id minted for it; a picture cut on its way down is fetched again whole, and the
// delete of its record follows it. A cell the window kept from the card has no record, for a resume to draw it; one the
// window lost after its submit stops the run under a code of its own, and a resume draws it again under a new id,
// its loss counted. The next job goes out while a picture comes down, and the card never holds two of them.
test('a dropped connection is waited out, no job is sent twice, and a cell lost after its submit is drawn again by a resume', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-drop-'));
  const fake = await startFakeComfy({ jobMs: 40, referenceMs: 0, requireUploads: true, untilSampled: true });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  readyRun(root, 'flight');
  const stage = (stage: 'smoke' | 'main') => drawStage({ stage, root, comfy: fake.url, until: Date.now() + 3600000, pollMs: 10, waitMs: 20000,
    outage: { windowMs: 600, pauseMs: 25 } });
  assert.equal((await stage('smoke')).smoke?.verdict?.pass, true);
  // Seed 11 is A, A+, L, C and T, the jobs after the smoke's. A's submit is answered to nobody and A+'s start is cut,
  // each for less than the window. C goes out once L is over, and after L's delete the network stays down longer than
  // the window: C is lost after its submit, and T, which waits for L's picture, never reaches the card.
  const n = fake.jobs.length;
  fake.options.drops = [{ at: 'prompt', job: n + 1, ms: 150 }, { at: 'start', job: n + 2, ms: 150 }, { at: 'delete', job: n + 3, ms: 1200 }];
  const key = (arm: ActionArm) => frameKey('flight', 11, arm);
  const first = await stage('main');
  assert.deepEqual((['A', 'A+'] as const).map(arm => [first.cells[key(arm)]?.status, (first.cells[key(arm)]?.outageMs ?? 0) > 0]),
    [['drawn', true], ['drawn', true]]);
  const c = first.cells[key('C')];
  assert.deepEqual([first.cells[key('L')]?.status, c?.status, c?.code, (c?.outageMs ?? 0) > 0, first.cells[key('T')], first.error],
    ['drawn', 'failed', 'comfy_connection_lost', true, undefined, 'comfy_connection_lost']);
  // The resume draws C again, its loss counted, and T, whose picture is cut halfway on its way down.
  await fake.whenUp();
  fake.options.drops = [{ at: 'view', job: n + 6, ms: 150 }];
  const second = await stage('main');
  assert.deepEqual([second.cells[key('C')]?.status, second.cells[key('C')]?.lost, second.cells[key('T')]?.status, second.error],
    ['drawn', 1, 'drawn', undefined]);
  const sent = () => fake.calls.filter(call => call.method === 'POST' && call.path === '/prompt').map(call => call.id);
  const tId = sent()[n + 5]!;
  const saved = readFileSync(fileOf(root, { kind: 'frame', story: 'flight', id: '', seed: 11, arm: 'T' }));
  assert.ok(saved.equals(stripPngMetadata(greyPng(1280, 704, n + 6, 9))), 'the picture cut halfway is saved whole, stripped');
  const views = fake.calls.flatMap((call, at) => (call.path === '/view' && call.id === tId ? [at] : []));
  const deleted = fake.calls.findIndex(call => call.method === 'POST' && call.path === '/history' && call.id === tId);
  assert.deepEqual([views.length, deleted > views.at(-1)!], [2, true]);
  // Every job went out once, each under its own id: the smoke's, A to C, then C again and T; never two on the card.
  assert.deepEqual([sent().length, new Set(sent()).size, fake.mostHeld], [n + 6, n + 6, 1]);
});
