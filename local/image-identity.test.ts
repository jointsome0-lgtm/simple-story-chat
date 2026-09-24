import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingPlan, pngSize, withoutLooks } from './image-batch.ts';
import type { BatchIndex, References } from './image-batch.ts';
import { buildIdentityBundles, cardOf, checksOf, drawStage, dryRun, identityCases, identityReport, pinsOf } from './image-identity.ts';
import { startFakeComfy } from './fake-comfy.ts';
import { readManifest } from './tokenizer-extract.ts';
import { IDENTITY_BINDING, IDENTITY_SEEDS, IDENTITY_STORY, identitySheet } from '../examples/identity-set.ts';

// Every person of the sheet has a portrait, as after the portrait run.
const everybody: References = { [IDENTITY_STORY]: Object.fromEntries(identitySheet.map(one => [one.name, `${one.name}.png`])) };
const names = identitySheet.map(one => one.name);
const who = (caseId: string) => identityCases().find(one => one.id === caseId)!.description.people.map(person => person.who);
const look = (name: string) => identitySheet.find(one => one.name === name)!.look;

test('the set holds what the measurement is about, and arm C drops the looks of the bound people only', () => {
  const cases = identityCases();
  assert.equal(cases.length * IDENTITY_SEEDS.length * 3, 48);
  // Its prompts are the bot's own assembly, with every person on the sheet and no name left in them.
  assert.ok(cases.every(one => one.namesStripped === 0 && one.withoutLook === 0));
  assert.ok(cases.every(one => names.every(name => !one.prompt.includes(name))));
  // One, two and four portraits in a frame, and a stranger who stops the binding in the middle of one: the plan the
  // harness checks before the smoke is this one.
  assert.deepEqual(cases.map(one => bindingPlan(one, everybody).map(bound => bound.name)), cases.map(one => IDENTITY_BINDING[one.id]));
  assert.deepEqual([...new Set(cases.map(one => IDENTITY_BINDING[one.id].length))].sort(), [1, 2, 4]);
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

  // Arm C. Вера is bound; the ferryman stopped the binding, so Лада after him keeps her look, and so does he.
  const seventh = cases.find(one => one.id === 'troupe-7')!;
  const prompt = withoutLooks(seventh, IDENTITY_BINDING['troupe-7']);
  assert.ok(!prompt.includes(look('Вера')) && prompt.includes('The person from image 1'));
  assert.ok(prompt.includes(look('Лада')) && !prompt.includes('image 2'));
  assert.ok(prompt.length < seventh.prompt.length);
  // The swapped pair: the slot numbers follow the frame's order, not the sheet's, and no name reaches the text.
  const fourth = cases.find(one => one.id === 'troupe-4')!;
  const swapped = withoutLooks(fourth, IDENTITY_BINDING['troupe-4']);
  assert.deepEqual(who('troupe-4'), ['Ива', 'Бран']);
  assert.ok(swapped.indexOf('The person from image 1') < swapped.indexOf('The person from image 2'));
  assert.ok(!swapped.includes(look('Бран')) && !swapped.includes('huge heavy build'));
  assert.ok(names.every(name => !swapped.includes(name)));
  // The clothes the frame gives stay: only the look goes.
  assert.ok(swapped.includes('grey knitted'));
});

// The whole runbook against the fake card, as `npm run image:identity -- dry-run` does it, with every refusal the paid
// run relies on; then what the report makes of a set that lost a cell, and of a picture on the wrong geometry.
test('a dry run draws the set in three arms on one canvas, refuses what would spoil it, and counts the gates', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines: string[] = [];
  const report = await dryRun(root, undefined, line => lines.push(line));
  const said = (pattern: RegExp) => assert.ok(lines.some(line => pattern.test(line)), `${pattern}\n${lines.join('\n')}`);
  said(/the main set before the smoke: refused/);
  // Two portraits lost: the set ends there, incomplete, and nobody draws them again.
  said(/two portraits failed on the card: 4 drawn, 2 failed/);
  said(/the smoke without all six portraits: refused \(The portraits are not all there: 4 of 6 .*2 failed, 4 of 8 frames bound otherwise/);
  said(/the failed portraits drawn again: refused/);
  // A failed smoke of one portrait.
  said(/a card out of memory at one portrait: 4 cells failed, smoke \{"drawn":false,.*"pass":false\}/);
  said(/the main set after a failed smoke: refused/);
  // A resume that is refused leaves the run as it found it, prompts.json included.
  said(/a resume with another set: refused \(.*another set/);
  said(/the run after that refusal: unchanged, byte for byte/);
  // The end of the rental: a set that cannot fit is not begun, and a job it cuts is nobody's failure.
  said(/a main set that cannot end a minute from now: 0 drawn beyond the smoke, stopped budget/);
  said(/a smoke the end cuts in the middle of a job: 0 drawn, 0 failed, stopped budget, verdict incomplete/);
  said(/bundles of a run the end cut short: refused/);
  assert.deepEqual([report.drawn, report.complete, report.judged, report.geometry.pass, report.smoke.pass], [48, true, true, true, true]);

  // The pins: the bootstrap's record of the card, the portraits' recipe, and the set's own.
  const manifest = readManifest(resolve('gpu/image-manifest.env'));
  const run = join(root, 'run');
  const index: BatchIndex = JSON.parse(readFileSync(join(run, 'index.json'), 'utf8'));
  assert.deepEqual(index.arms, ['A', 'B', 'C']);
  assert.equal(new Set(index.pictures.map(picture => picture.file)).size, 48, 'the arm is part of the file');
  assert.deepEqual([index.pins?.comfyuiRevision, index.pins?.transformer, index.pins?.cacheDevice, index.pins?.resolution, index.pins?.seeds],
    [manifest.COMFYUI_REVISION, manifest.IMAGE_QWEN_MODEL_SHA256, 'auto', 0, '7,11']);
  assert.deepEqual([index.pins?.canvas, index.pins?.referenceSize, index.pins?.portraitCanvas, index.pins?.comfyui], ['1280x704', '704x1280', '720x1280', 'fake']);
  for (const picture of index.pictures) {
    // Upright portraits, a wide frame: the file is 1280x704 whatever the references are, and each reference reaches
    // the encoder at 704x1280.
    assert.deepEqual(pngSize(readFileSync(join(run, picture.file))), { width: 1280, height: 704 });
    assert.equal(picture.references, picture.arm === 'A' ? 0 : IDENTITY_BINDING[picture.caseId].length);
    assert.deepEqual(picture.referenceSizes, Array.from({ length: picture.references! }, () => [704, 1280]));
    // The fake's socket opens late, and every job was still heard from its start: the submit waited for it.
    assert.ok(picture.phases?.sampleMs && picture.loaderCacheMiss !== undefined, 'the socket heard the whole job');
    assert.ok(picture.vramSamples! > 0 && picture.ramMiB && picture.promptChars! > 0);
    // Four references log a partial load on the fake card.
    assert.equal(picture.partialModelLoadEvents, picture.references === 4 ? 1 : 0);
  }
  assert.deepEqual(index.pictures.filter(picture => picture.first).map(picture => picture.arm), ['A', 'B', 'C']);
  const chars = (arm: string, caseId: string) => index.pictures.find(picture => picture.arm === arm && picture.caseId === caseId && picture.seed === 7)!.promptChars!;
  assert.ok(identityCases().every(one => chars('C', one.id) < chars('B', one.id) && chars('B', one.id) === chars('A', one.id)));
  assert.deepEqual([report.control?.drawn, report.control?.warm], [3, 2], 'the control: one first frame and two warm ones');

  // Six bundles, one per arm and seed, and nothing in any of them names the arm, the checkpoint or arm C's own text.
  const keys = readdirSync(join(run, 'keys')).map(file => JSON.parse(readFileSync(join(run, 'keys', file), 'utf8')) as { arm: string; armIs: string; seed: number; pictures: unknown[] });
  assert.deepEqual(keys.map(key => `${key.arm}${key.seed}`).sort(), ['A11', 'A7', 'B11', 'B7', 'C11', 'C7']);
  assert.ok(keys.every(key => key.pictures.length === 8));
  assert.equal(keys.find(key => key.arm === 'A')!.armIs, 'text only on the edit graph, 1280x704');
  for (const bundle of readdirSync(join(run, 'review'))) {
    const folder = join(run, 'review', bundle);
    const readable = ['cases.json', 'checks.json', 'TASK.md'].map(file => readFileSync(join(folder, file), 'utf8')).join('\n');
    assert.ok(!/safetensors|the person from image|"arm"|seed|edit graph/i.test(readable), bundle);
    const task = readFileSync(join(folder, 'TASK.md'), 'utf8');
    assert.match(task, /Против `frame_text`/);
    assert.match(task, /Лицо сохранилось, а фигура нет — это `face: yes`, `figure: no`/);
  }
  assert.throws(() => buildIdentityBundles(root), /built once/);

  // The fake answers. A loses the figure on every other transition. Gate 3 at its boundary: B shows all eight of the
  // frames' own changes of clothes and passes, C is unsure of one, 7 of 8, and fails; the appearances the story does
  // not change, which B misses now and then, are shown beside it and decide nothing.
  const arms = report.arms;
  assert.equal(arms.A.tally!.transitions, 26);
  assert.ok(arms.A.tally!.figure < arms.A.tally!.face);
  const third = (arm: string) => report.gates[arm].find(gate => gate.gate === 3)!;
  assert.match(third('B').detail, /right in 8 of 8, .*every appearance, not gated: 3\d of 38/);
  assert.match(third('C').detail, /right in 7 of 8/);
  assert.deepEqual([third('B').status, third('C').status], ['pass', 'fail']);
  assert.deepEqual(report.gates.B.map(gate => gate.status), ['pass', 'pass', 'pass', 'pass', 'pass']);
  assert.equal(report.verdict, 'B passes, C fails');
  // C against B, split where C's text lost the look (22 transitions) and where the binding stopped and it stayed (4).
  assert.deepEqual([arms.C.tally!.removed.transitions, arms.C.tally!.kept.transitions], [22, 4]);
  // A bundle nobody has answered leaves its arm unscored rather than passed.
  rmSync(join(run, 'answers', readdirSync(join(run, 'keys')).find(file => JSON.parse(readFileSync(join(run, 'keys', file), 'utf8')).arm === 'B')!));
  const open = identityReport(root);
  assert.deepEqual(open.gates.B.map(gate => gate.status), ['unscored', 'unscored', 'unscored', 'pass', 'pass']);
  assert.equal(open.verdict, 'B is open, C fails');

  // Astra's case: one cell of B failed and the rest are there. The failure stays in the record as the cell's result,
  // and the set is incomplete: no gates, no verdict, whatever the survivors would say.
  const whole = readFileSync(join(run, 'index.json'), 'utf8');
  const lost = index.pictures.find(picture => picture.arm === 'B' && picture.caseId === 'troupe-1' && picture.seed === 7)!;
  writeFileSync(join(run, 'index.json'), JSON.stringify({ ...index, pictures: index.pictures.filter(picture => picture !== lost),
    failures: [{ caseId: lost.caseId, checkpoint: lost.checkpoint, role: lost.role, seed: lost.seed, arm: lost.arm, code: 'image_failed' }] }));
  const survivors = identityReport(root);
  assert.deepEqual([survivors.drawn, survivors.failed, survivors.complete, survivors.smoke.pass, survivors.gates, survivors.verdict],
    [47, 1, false, false, {}, 'incomplete']);
  // A frame whose portrait reached the encoder at another size is not the cell the set asked for: incomplete too.
  const warped = { ...index, pictures: index.pictures.map(picture => picture === lost ? { ...picture, referenceSizes: [[720, 1280]] } : picture) };
  writeFileSync(join(run, 'index.json'), JSON.stringify(warped));
  assert.deepEqual([identityReport(root).complete, identityReport(root).verdict], [false, 'incomplete']);
  writeFileSync(join(run, 'index.json'), whole);

  // The failed smoke of the dry run, resumed: every cell of it is done, the failures as much as the pictures, and
  // nothing is drawn again until it comes out.
  const fake = await startFakeComfy();
  t.after(fake.close);
  const again = await drawStage({ stage: 'smoke', dir: join(root, 'aside', 'oom'), comfy: fake.url, until: Date.now() + 60000, pollMs: 20, waitMs: 10000 });
  assert.deepEqual([again.pictures.length, again.failures.length, fake.jobs.length], [2, 4, 0]);
  assert.ok(again.failures.every(failure => failure.oom && failure.arm !== 'A'));

  // The card's record: another revision, or no record at all, refuses every stage; a checkpoint the bootstrap did
  // not verify is pinned by its name, never by the standard transformer's hash.
  const card = join(root, 'card.txt');
  const good = readFileSync(card, 'utf8');
  assert.equal(pinsOf(cardOf(card), 'other.safetensors').transformer, 'unverified other.safetensors');
  writeFileSync(card, good.replace(manifest.COMFYUI_REVISION, 'f'.repeat(40)));
  assert.throws(() => cardOf(card), /differs from gpu\/image-manifest.env in comfyuiRevision;/);
  rmSync(card);
  assert.throws(() => cardOf(card), /No record of the card/);
});
