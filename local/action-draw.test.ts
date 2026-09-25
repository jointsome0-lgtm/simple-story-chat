import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeComfy } from './fake-comfy.ts';
import type { FakeJob } from './fake-comfy.ts';
import { writeCardRecord } from './image-identity.ts';
import { planAll } from './action-prompts.ts';
import { storyDir, textStories } from './action-text.ts';
import type { Facing, StoryText } from './action-text.ts';
import { FREE_MIB, drawStage, pricing, smokeVerdict } from './action-draw.ts';
import type { ActionCell, CellRecord, DrawIndex } from './action-draw.ts';
import { searchTree, markerForms } from './action-boundary.ts';

const rows = (list: [string, () => void][]) => {
  for (const [promise, check] of list) {
    try { check(); } catch (error) { assert.fail(`${promise}: ${(error as Error).message}`); }
  }
};

// A story's text as the text run leaves it, made up: a sheet of `people`, the bot's frame and the variant, each
// person of the sheet in the variant with the facing given.
export function madeUpText(id: string, people: [string, Facing][]): StoryText {
  const ok = { outcome: 'ok' as const, attempts: 1, ms: 1 };
  const sheet = people.map(([name], at) => ({ name, look: `An adult of build ${at + 1} with hair ${at + 1}`, outfit: `wearing a tunic ${at + 1}` }));
  return { id, pins: '', steps: { opening: ok, action: ok, sheet: ok, frame: ok, variant: ok }, sheet, worn: sheet,
    frame: { moment: 'They hold on', shot: 'Medium wide shot', setting: 'A room', objects: '', props: '', light: 'Evening',
      people: people.slice(0, 4).map(([name]) => ({ who: name, look: '', clothes: '', state: '', action: 'holds on' })) },
    variant: { moment: 'They hold on', shot: 'Medium wide shot', setting: 'A room', objects: '', props: '', light: 'Evening',
      people: people.map(([name, facing], at) => ({ who: name, role: `the holder ${at + 1}`, facing, look: '', clothes: '', state: '', action: 'holds on' })) } };
}
// A run directory ready for the pictures: the texts' record, the texts, the plans and the card's record.
export function readyRun(root: string, texts: StoryText[]) {
  for (const text of texts) {
    mkdirSync(storyDir(root, text.id), { recursive: true });
    writeFileSync(join(storyDir(root, text.id), 'text.json'), JSON.stringify(text));
  }
  writeFileSync(join(root, 'texts.json'), JSON.stringify({ pins: { route: 'simple-serving', weights: 'made up', gatewayModel: 'made-up' } }));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify(planAll(root, textStories())));
  writeCardRecord(join(root, 'card.txt'));
}

// The whole picture run against the fake ComfyUI (docs/action-experiment.md#drawing): three scenes, one of them
// sealed, 35 jobs, which is what takes this test most of its second.
test('the pictures are drawn in the doc\'s order, on the graphs it describes, and refused where it says', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-draw-'));
  // A job takes long enough for the memory to be sampled while it runs, as the smoke asks.
  const fake = await startFakeComfy({ jobMs: 15, referenceMs: 0, requireUploads: true, marker: 'Зурбаганец' });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  readyRun(root, [madeUpText('flight', [['Бранд', 'viewer'], ['Лиэль', 'viewer'], ['Мира', 'other']]),
    madeUpText('demon', [['Верена', 'screen-left'], ['Тимко', 'viewer']]), madeUpText('sharp-1', [['Агата', 'away']])]);
  const stage = (stage: 'smoke' | 'portraits' | 'main', until = Date.now() + 3600000) =>
    drawStage({ stage, root, comfy: fake.url, until, pollMs: 10, waitMs: 20000 });
  // The name a drawn file was uploaded under, and what each job sent and saved.
  const sent = (story: string, file: string) => `ref-${createHash('sha256').update(readFileSync(join(storyDir(root, story), file))).digest('hex').slice(0, 16)}.png`;
  const slots = (job: FakeJob) => job.slots.map(slot => `${slot.file} ${slot.scaled ? `${slot.scaled.width}x${slot.scaled.height}` : 'whole'}`);
  const copies = (job: FakeJob) => job.images.filter(image => image.node !== '9').map(image => `${image.width}x${image.height}`);
  const size = (job: FakeJob) => `${job.width}x${job.height}`;

  await assert.rejects(stage('main'), /after the smoke has passed/);
  const smoke = await stage('smoke');
  const [front1, front2, front3] = ['e1', 'e2', 'e3'].map(entry => sent('flight', `portraits/flight-${entry}.png`));
  rows([
    ['the smoke is the scene with the most bound, with the view another scene needs and that view\'s front, and it passes', () => {
      assert.equal(smoke.smoke!.verdict!.pass, true);
      assert.deepEqual(smoke.smoke!.keys, ['front:flight-e1', 'front:flight-e2', 'front:flight-e3', 'front:demon-e1', 'view:demon-e1-screen-left',
        'frame:flight:s7:A', 'frame:flight:s7:A+', 'frame:flight:s7:L', 'frame:flight:s7:C', 'frame:flight:s7:T']);
    }],
    ['fronts at 720x1280 with no slot, a view at 704x1280 from its whole front', () => {
      assert.deepEqual(fake.jobs.slice(0, 5).map(job => [size(job), ...slots(job)]), [['720x1280'], ['720x1280'], ['720x1280'], ['720x1280'],
        ['704x1280', `${sent('demon', 'portraits/demon-e1.png')} whole`]]);
    }],
    ['A, A+ and L with no slot at all', () => assert.deepEqual(fake.jobs.slice(5, 8).map(job => [size(job), ...slots(job)]), [['1280x704'], ['1280x704'], ['1280x704']])],
    ['C with each front through its own scale node, copied back at 352x640', () => {
      assert.deepEqual([size(fake.jobs[8]), ...slots(fake.jobs[8]), ...copies(fake.jobs[8])],
        ['1280x704', `${front1} 352x640`, `${front2} 352x640`, `${front3} 352x640`, '352x640', '352x640', '352x640']);
    }],
    ['T with L\'s picture whole in the first slot and the fronts scaled after it', () => {
      assert.deepEqual([size(fake.jobs[9]), ...slots(fake.jobs[9]), ...copies(fake.jobs[9])], ['1280x704', `${sent('flight', 'pictures/s7-L.png')} whole`,
        `${front1} 352x640`, `${front2} 352x640`, `${front3} 352x640`, '352x640', '352x640', '352x640']);
      assert.deepEqual(smoke.cells['frame:flight:s7:T'].referenceSizes, [[1280, 704], [352, 640], [352, 640], [352, 640]]);
    }],
  ]);

  // The rest: a seed that cannot end in time is not begun; then a front that fails takes out what needs it.
  const before = fake.jobs.length;
  const short = await stage('main', Date.now() + 5000);
  assert.deepEqual([short.stopped, fake.jobs.length, short.admission?.at(-1)?.admitted], ['admission', before, false]);
  fake.options.failJobs = [before + 2];
  const main = await stage('main');
  const status = (key: string) => main.cells[key] ? `${main.cells[key].status}${main.cells[key].code ? ` ${main.cells[key].code}` : ''}` : 'none';
  const logs = fake.paths.filter(path => path === '/internal/logs/raw').length;
  rows([
    ['both seeds are drawn whole, and V only where a view was needed', () => {
      assert.deepEqual(['frame:demon:s11:V', 'frame:flight:s11:V', 'frame:flight:s11:T', 'frame:sharp-1:s11:L'].map(status), ['drawn', 'none', 'drawn', 'drawn']);
      assert.deepEqual([main.stopped, fake.jobs.length], [undefined, 35]);
    }],
    ['a failed front takes its view, C, V and T out', () => {
      assert.deepEqual(['front:sharp-1-e1', 'view:sharp-1-e1-away', 'frame:sharp-1:s7:C', 'frame:sharp-1:s7:V', 'frame:sharp-1:s7:T', 'frame:sharp-1:s11:T'].map(status),
        ['failed image_failed', 'out front_failed', 'out front_failed', 'out front_failed', 'out front_failed', 'out front_failed']);
    }],
    ['V sends the view where its person turns and the front of the other, both scaled', () => {
      const view = sent('demon', 'views/demon-e1-screen-left.png');
      assert.deepEqual(fake.jobs.filter(job => job.slots[0]?.file === view).map(slots),
        [0, 1].map(() => [`${view} 352x640`, `${sent('demon', 'portraits/demon-e2.png')} 352x640`]));
    }],
    ['no picture keeps the metadata the card wrote into it', () => assert.deepEqual(searchTree(root, markerForms('Зурбаганец')).hits, [])],
    ['the card\'s log is read around clean cells only, and a sharp scene\'s pictures stay sealed', () => {
      assert.equal(logs, 2 * Object.values(main.cells).filter(one => one.status === 'drawn' && !one.story.startsWith('sharp-')).length);
      assert.ok(storyDir(root, 'sharp-1').includes('/sealed/') && existsSync(join(storyDir(root, 'sharp-1'), 'pictures', 's11-A.png')));
    }],
  ]);
  // Nothing is drawn again, and a directory drawn under other pins is refused before its record is touched.
  await stage('main');
  assert.equal(fake.jobs.length, 35);
  const kept = readFileSync(join(root, 'draw.json'));
  writeFileSync(join(root, 'prompts.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(root, 'prompts.json'), 'utf8')), plans: 'other' }));
  await assert.rejects(stage('main'), /another plans/);
  assert.ok(readFileSync(join(root, 'draw.json')).equals(kept));
});

test('the smoke\'s verdict and the prices it sets', () => {
  const cell = (key: string, change: Partial<CellRecord> = {}): CellRecord => {
    const [kind, story, seed, arm] = key.split(':');
    const frame = kind === 'frame';
    const size = kind === 'front' ? [720, 1280] : kind === 'view' ? [704, 1280] : [1280, 704];
    const references = arm === 'C' ? 2 : arm === 'T' ? 3 : kind === 'view' ? 1 : 0;
    return { key, kind: kind as CellRecord['kind'], story, id: key, seed: frame ? Number(seed.slice(1)) : 7, ...(frame ? { arm: arm as CellRecord['arm'] } : {}),
      status: 'drawn', references, width: size[0], height: size[1], totalMs: 1000, slotsRight: true, loaderCacheMiss: false, phases: { sampleMs: 500 },
      vram: [{ index: 0, totalMiB: 32768, usedMiBMax: 20000, occupiedMiBMax: 30000 }], vramSamples: 3,
      copies: arm === 'C' ? [{ node: '31', width: 352, height: 640 }, { node: '32', width: 352, height: 640 }]
        : arm === 'T' ? [{ node: '32', width: 352, height: 640 }, { node: '33', width: 352, height: 640 }] : [], ...change };
  };
  const keys = ['front:s:e1', 'view:s:v', 'frame:s:s7:A', 'frame:s:s7:C', 'frame:s:s7:T'];
  const verdict = (changes: Record<string, Partial<CellRecord>>) => {
    const index = { pins: {}, startedAt: '', cells: Object.fromEntries(keys.map(key => [key, cell(key, changes[key])])) } as DrawIndex;
    return smokeVerdict(index, keys, { width: 720, height: 1280 });
  };
  rows([
    ['all drawn as the doc asks passes', () => assert.deepEqual([verdict({}).pass, verdict({}).tOut], [true, false])],
    ['T alone failing takes T out and passes the rest', () => assert.deepEqual([verdict({ 'frame:s:s7:T': { status: 'failed' } }).pass,
      verdict({ 'frame:s:s7:T': { status: 'failed' } }).tOut], [true, true])],
    ['any other cell failing fails it', () => assert.equal(verdict({ 'frame:s:s7:C': { status: 'failed' } }).pass, false)],
    ['less than 2 GiB free at the sampled peak fails it', () => {
      const tight = verdict({ 'frame:s:s7:A': { vram: [{ index: 0, totalMiB: 32768, usedMiBMax: 20000, occupiedMiBMax: 32768 - FREE_MIB + 1 }] } });
      assert.deepEqual([tight.pass, tight.memory], [false, false]);
    }],
    ['a scaled copy of another size fails the geometry', () => assert.equal(verdict({ 'frame:s:s7:C': { copies: [{ node: '31', width: 704, height: 1280 },
      { node: '32', width: 352, height: 640 }] } }).geometry, false)],
    ['a picture whose phases the socket did not hear fails it', () => assert.equal(verdict({ 'view:s:v': { phases: undefined } }).heard, false)],
  ]);
  const smoke = [cell('front:s:e1', { totalMs: 1000 }), cell('view:s:v', { totalMs: 2000, uploadMs: 400 }), cell('frame:s:s7:A', { totalMs: 500 }),
    cell('frame:s:s7:L', { totalMs: 700 }), cell('frame:s:s7:C', { totalMs: 3000, references: 3 }), cell('frame:s:s7:T', { totalMs: 5000, references: 4 })];
  const price = pricing(smoke);
  const ask = (kind: ActionCell['kind'], arm?: ActionCell['arm'], refs = 0) => price({ key: '', kind, story: 's', id: '', seed: 7, ...(arm ? { arm } : {}),
    refs: Array.from({ length: refs }, () => 'x'), prompt: '' });
  rows([
    ['a front by the slowest front, a view by the slowest view with its upload, a quarter more and three seconds', () => {
      assert.deepEqual([ask('front'), ask('view', undefined, 1)], [1000 * 1.25 + 3000, 2400 * 1.25 + 3000]);
    }],
    ['a frame without references by the slowest of A, A+ and L', () => assert.equal(ask('frame', 'A+'), 700 * 1.25 + 3000)],
    ['an edit by the slowest with the fewest references at or above its own, and past them by the slowest edit', () => {
      assert.deepEqual([ask('frame', 'C', 2), ask('frame', 'V', 5)], [3000 * 1.25 + 3000, 5000 * 1.25 + 3000]);
    }],
    ['T by its T', () => assert.equal(ask('frame', 'T', 2), 5000 * 1.25 + 3000)],
  ]);
});
