import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingPlan, withoutLooks } from './image-batch.ts';
import type { BatchIndex, References } from './image-batch.ts';
import { buildIdentityBundles, checksOf, drawArms, dryRun, identityCases, identityReport, prepare, smokeOf } from './image-identity.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { IDENTITY_SEEDS, IDENTITY_STORY, identitySheet } from '../examples/identity-set.ts';

// Every person of the sheet has a portrait, as after the portrait run.
const everybody: References = { [IDENTITY_STORY]: Object.fromEntries(identitySheet.map(one => [one.name, `${one.name}.png`])) };
const names = identitySheet.map(one => one.name);
const who = (caseId: string) => identityCases().find(one => one.id === caseId)!.description.people.map(person => person.who);

test('the set holds what the measurement is about, fixed before any card is rented', () => {
  const cases = identityCases();
  assert.equal(cases.length * IDENTITY_SEEDS.length * 3, 48);
  // Its prompts are the bot's own assembly, with every person on the sheet and no name left in them.
  assert.ok(cases.every(one => one.namesStripped === 0 && one.withoutLook === 0));
  assert.ok(cases.every(one => names.every(name => !one.prompt.includes(name))));
  // One, two and four portraits in a frame, and a stranger who stops the binding in the middle of one.
  assert.deepEqual([...new Set(cases.map(one => bindingPlan(one, everybody).length))].sort(), [1, 2, 4]);
  assert.deepEqual(bindingPlan(cases.find(one => one.id === 'troupe-7')!, everybody).map(bound => bound.name), ['Вера']);
  // The heavy man and the slight woman, the tall man and the short one, and the two look-alikes: each pair together
  // in one frame and in the swapped order in another.
  const order = (a: string, b: string) => cases.map(one => who(one.id)).filter(people => people.includes(a) && people.includes(b))
    .map(people => people.indexOf(a) < people.indexOf(b) ? 'ab' : 'ba');
  for (const [a, b] of [['Бран', 'Ива'], ['Тимофей', 'Кузьма'], ['Вера', 'Лада']]) assert.deepEqual([...new Set(order(a, b))].sort(), ['ab', 'ba'], `${a} and ${b}`);
  // Clothes the story changes, and at least twenty transitions a judge can score per arm.
  assert.ok(cases.filter(one => one.description.people.some(person => person.clothes)).length >= 3);
  const transitions = checksOf(cases.map((one, at) => ({ picture: `pic-${at}.png`, one }))).filter(check => check.kind === 'transition');
  assert.ok(transitions.length * IDENTITY_SEEDS.length >= 20, `${transitions.length} transitions per bundle`);
  // No frame says who is big or small outside the looks: in arm C that has to come from the portrait.
  for (const one of cases) {
    const told = JSON.stringify({ ...one.description, people: one.description.people.map(({ look, ...rest }) => rest) });
    assert.ok(!/huge|muscl|slight|lanky|stocky|very tall|very short|\bthin\b|\bbig\b/i.test(told), one.id);
  }
});

test('arm C drops the whole look of the bound people only, and names them by the number of their picture', () => {
  const cases = identityCases();
  const seventh = cases.find(one => one.id === 'troupe-7')!;
  const bound = bindingPlan(seventh, everybody).map(person => person.name);
  const prompt = withoutLooks(seventh, bound);
  const look = (name: string) => identitySheet.find(one => one.name === name)!.look;
  // Вера is bound; the ferryman stopped the binding, so Лада after him keeps her look, and so does he.
  assert.ok(!prompt.includes(look('Вера')) && prompt.includes('The person from image 1'));
  assert.ok(prompt.includes(look('Лада')) && !prompt.includes('image 2'));
  assert.ok(prompt.length < seventh.prompt.length);
  // The swapped pair: the slot numbers follow the frame's order, not the sheet's, and no name reaches the text.
  const fourth = cases.find(one => one.id === 'troupe-4')!;
  const swapped = withoutLooks(fourth, bindingPlan(fourth, everybody).map(person => person.name));
  assert.deepEqual(who('troupe-4'), ['Ива', 'Бран']);
  assert.ok(swapped.indexOf('The person from image 1') < swapped.indexOf('The person from image 2'));
  assert.ok(!swapped.includes(look('Бран')) && !swapped.includes('huge heavy build'));
  assert.ok(names.every(name => !swapped.includes(name)));
  // The clothes the frame gives stay: only the look goes.
  assert.ok(swapped.includes('grey knitted'));
});

// The whole runbook against the fake card, as `npm run image:identity -- dry-run` does it.
test('a dry run draws the set in three arms on one canvas, measures each frame, bundles it blind and counts the gates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const report = await dryRun(root, undefined, line => lines.push(line));
  assert.ok(lines.some(line => /the main set before the smoke: refused/.test(line)), lines.join('\n'));
  assert.ok(lines.some(line => /portraits of two sizes: refused \(.*1280x704 and 640x352; one run has one canvas\)/.test(line)));
  assert.ok(lines.some(line => /cut short: \d+ drawn, stopped budget, verdict incomplete/.test(line)));
  assert.equal(report.drawn, 48);
  assert.equal(report.complete, true);
  assert.ok(report.geometry.pass && report.smoke.pass);

  const run = join(root, 'run');
  const index: BatchIndex = JSON.parse(readFileSync(join(run, 'index.json'), 'utf8'));
  assert.deepEqual(index.arms, ['A', 'B', 'C']);
  assert.equal(new Set(index.pictures.map(picture => picture.file)).size, 48, 'the arm is part of the file');
  assert.deepEqual([index.pins?.cacheDevice, index.pins?.resolution, index.pins?.seeds, index.pins?.comfyui], ['auto', 0, '7,11', 'fake']);
  for (const picture of index.pictures) {
    assert.deepEqual([picture.width, picture.height], [1280, 704]);
    assert.ok(picture.phases?.sampleMs && picture.phases.encodeMs !== undefined, 'the phases are apart');
    assert.equal(picture.cold, false, 'the portrait run left the models loaded');
    assert.ok(picture.vramSamples! > 0 && picture.vram[0].occupiedMiBMax! > picture.vram[0].usedMiBMax);
    assert.ok(picture.ramMiB && picture.offloads !== undefined && picture.promptChars! > 0);
    // A draws without portraits; B and C with the frame's bound people, each at the canvas.
    const one = identityCases().find(entry => entry.id === picture.caseId)!;
    assert.equal(picture.references, picture.arm === 'A' ? 0 : bindingPlan(one, everybody).length);
    assert.ok((picture.referenceSizes ?? []).every(size => size.join('x') === '1280x704'));
    // Four references spill into RAM on the fake card, and its log says so.
    assert.equal(picture.offloads, picture.references === 4 ? 1 : 0);
  }
  assert.deepEqual(index.pictures.filter(picture => picture.first).map(picture => picture.arm), ['A', 'B', 'C']);
  const chars = (arm: string, caseId: string) => index.pictures.find(picture => picture.arm === arm && picture.caseId === caseId && picture.seed === 7)!.promptChars!;
  assert.ok(identityCases().every(one => chars('C', one.id) < chars('B', one.id) && chars('B', one.id) === chars('A', one.id)));

  // Six bundles, one per arm and seed, and nothing in any of them names the arm, the checkpoint or arm C's own text.
  const keys = readdirSync(join(run, 'keys')).map(file => JSON.parse(readFileSync(join(run, 'keys', file), 'utf8')) as { arm: string; seed: number; pictures: unknown[] });
  assert.deepEqual(keys.map(key => `${key.arm}${key.seed}`).sort(), ['A11', 'A7', 'B11', 'B7', 'C11', 'C7']);
  assert.ok(keys.every(key => key.pictures.length === 8));
  for (const bundle of readdirSync(join(run, 'review'))) {
    const folder = join(run, 'review', bundle);
    const readable = ['cases.json', 'checks.json', 'TASK.md'].map(file => readFileSync(join(folder, file), 'utf8')).join('\n');
    assert.ok(!/safetensors|the person from image|"arm"|seed/i.test(readable), bundle);
    const task = readFileSync(join(folder, 'TASK.md'), 'utf8');
    assert.match(task, /Против `frame_text`/);
    assert.ok(!task.includes('prompt_sent'));
    assert.match(task, /Лицо сохранилось, а фигура нет — это `face: yes`, `figure: no`/);
    const checks = JSON.parse(readFileSync(join(folder, 'checks.json'), 'utf8')) as { kind: string; items: string[] }[];
    assert.ok(checks.filter(check => check.kind === 'transition').every(check => check.items.join() === 'face,figure'));
  }
  assert.throws(() => buildIdentityBundles(run), /built once/);

  // The fake answers: A loses the figure on every other transition, C gets a quarter of its clothes unsure.
  const arms = report.arms;
  assert.equal(arms.A.tally!.transitions, 26);
  assert.ok(arms.A.tally!.figure < arms.A.tally!.face);
  assert.deepEqual(report.gates.B.map(gate => gate.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.deepEqual(report.gates.C.map(gate => gate.status), ['pass', 'pass', 'fail', 'pass', 'pass']);
  assert.equal(report.verdict, 'B passes, C fails');
  // A bundle nobody has answered leaves its arm unscored rather than passed.
  rmSync(join(run, 'answers', readdirSync(join(run, 'keys')).find(file => JSON.parse(readFileSync(join(run, 'keys', file), 'utf8')).arm === 'B')!));
  const open = identityReport(run);
  assert.deepEqual(open.gates.B.map(gate => gate.status), ['unscored', 'unscored', 'unscored', 'pass', 'pass']);
  assert.equal(open.verdict, 'B is open, C fails');
  // A resume under other seeds is another comparison, and is refused before the card is asked for anything.
  await assert.rejects(drawArms({ prompts: join(root, 'set'), out: run, references: join(root, 'references.json'),
    comfy: 'http://127.0.0.1:9', minutes: 1, seeds: [7, 13], timeoutMs: 1000 }), /another seeds/);
});

// A card that cannot hold four references is what the smoke is there to find, before the hour goes on the main set.
test('a card out of memory at four references fails the smoke, and the main set is refused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-identity-'));
  const fake = await startFakeComfy({ oomAtReferences: 4 });
  t.after(async () => { await fake.close(); rmSync(root, { recursive: true, force: true }); });
  const { set, references } = await prepare(root, fake.url);
  const run = join(root, 'run');
  const options = { prompts: set, out: run, references, comfy: fake.url, minutes: 5, pollMs: 20, timeoutMs: 10000, waitMs: 60000 };
  const index = await drawArms({ ...options, smoke: true });
  // The frames of four failed as OOM, and each is left as it failed: drawing it again would be choosing the result.
  assert.deepEqual(index.failures.map(failure => [failure.caseId, failure.arm, failure.oom, failure.references]),
    [['troupe-2', 'B', true, 4], ['troupe-2', 'C', true, 4]]);
  assert.equal(index.pictures.length, 4);
  assert.equal(fake.uploads.length, 4, 'one upload per portrait, not per cell: troupe-2 holds troupe-1\'s man and three more');
  const smoke = smokeOf(index, run);
  assert.deepEqual([smoke.drawn, smoke.geometry, smoke.memory, smoke.pass], [true, true, false, false]);
  await assert.rejects(drawArms(options), /after the smoke has passed/);
  const again = await drawArms({ ...options, smoke: true });
  assert.equal(again.failures.length, 2);
  assert.equal(fake.jobs.filter(job => job.references === 4).length, 2, 'the failed cells were not drawn again');
  const report = identityReport(run);
  assert.equal(report.verdict, 'incomplete');
  assert.equal(report.gates.B.find(gate => gate.gate === 5)!.status, 'fail');
});
