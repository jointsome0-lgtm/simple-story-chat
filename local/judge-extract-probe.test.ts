import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { traps } from '../examples/scene-traps.ts';
import { KEYS } from './judge-extract-keys.ts';
import { gradeSlot, gradeItem, scorePairs, agreementReport, versusYesNo, readExtraction, readKeys, readLabels,
  extractionRequest, runExtraction, resolveInputs, checkJudge, checkLabels, cardFile } from './judge-extract-probe.ts';
import type { Extraction, Item, ItemResult, Keys, Slot, Status } from './judge-extract-probe.ts';

// A synthetic scene and its card; no story of anybody's is read here.
const SCENE = 'Элин опускает браслет: печать ещё не восстановилась. «Рано», — говорит она и подпирает дверь правым плечом.';
// The same trap written by a narrator that walked into it, for the second memory mode of one probe directory.
const OTHER = 'Элин поднимает руку, и печать вспыхивает красным: страж отброшен к стене.';
// A scene where the seal was allowed and worked, and which names no remaining charges.
const APPLIED = 'Элин поднимает руку, и «Красная печать» бьёт стража. Он замирает и падает.';
const found = (over: Partial<Extraction> = {}): Extraction => ({ key: 'seal_used', status: 'refused', actor: 'Элин',
  object: 'Красная печать', number: '', quote: 'печать ещё не восстановилась', ...over });
const slot = (over: Partial<Slot> = {}): Slot => ({ key: 'seal_used', ask: 'Элин применяет «Красную печать»', expect: { status: ['refused'] }, ...over });
const item = (over: Partial<Item> = {}): Item => ({ key: 'seal_early', slots: [slot()], ...over });
const graded = (side: 'trap' | 'twin', status: Status, over: Partial<ItemResult> = {}): ItemResult =>
  ({ key: `${side}-${status}`, pairId: 'p1', side, scored: true, pass: true,
    slots: [{ key: 'seal_used', role: 'target', status, quote: 'exact', keyPass: true, pass: true, misses: [] }], ...over });

test('a slot requires supported evidence, the right claim and a complete extraction', () => {
  const rows: [Slot, Extraction | undefined, string[]][] = [
    [slot(), found(), []],
    [slot(), found({ status: 'completed' }), ['status']],
    [slot({ expect: { status: ['refused'], actor: ['Тарек'] } }), found(), ['actor']],
    [slot({ expect: { status: ['refused'], number: 3 } }), found(), ['number']],
    [slot({ expect: { status: ['refused'], number: 3 } }), found({ number: 'три' }), []],
    [slot({ expect: { status: ['refused'], number: 'none' } }), found({ number: 'три' }), ['number']],
    [slot(), found({ quote: '  печать   ещё\n не восстановилась ' }), []],
    [slot(), found({ quote: '"Рано", - говорит она' }), []],
    [slot(), found({ quote: 'Рано говорит она' }), ['quote']],
    [slot(), found({ quote: 'печать сгорела дотла' }), ['quote']],
    [slot({ expect: { status: ['absent'] } }), found({ status: 'absent', quote: '' }), []],
    [slot({ expect: { status: ['absent'] } }), found({ status: 'absent' }), ['quote']],
    [slot(), undefined, ['missing']],
  ];
  for (const [key, extraction, misses] of rows) {
    const result = gradeSlot(key, extraction, SCENE);
    assert.deepEqual([result.misses, result.pass], [misses, !misses.length]);
  }
  assert.equal(gradeSlot(slot(), found({ quote: 'invented' }), SCENE).keyPass, true);
  for (const separator of [' ', '\u00a0', '\u202f']) {
    assert.equal(gradeSlot(slot({ expect: { status: ['refused'], number: 1200 } }), found({ number: `1${separator}200` }), SCENE).pass, true);
  }
  assert.deepEqual(readExtraction(JSON.stringify({ items: [found({ status: 'invented' as Status })] })), []);
  assert.throws(() => readExtraction('{"answers":[]}'), { code: 'invalid_extraction' });
});

test('pairs reject constant answers, evasion, missing targets and failed controls', () => {
  const rows: [Status, Status, number, number][] = [
    ['refused', 'completed', 1, 0], ['refused', 'refused', 0, 1],
    ['completed', 'completed', 0, 0], ['absent', 'completed', 0, 0], ['proposed', 'completed', 0, 0],
  ];
  for (const [trap, twin, pass, falseDetection] of rows) {
    const result = scorePairs([graded('trap', trap), graded('twin', twin)]);
    assert.deepEqual([result.pairs, result.pairPass, result.rates.falseDetection], [1, pass, falseDetection]);
  }
  const sloppy = graded('trap', 'refused', { pass: false });
  sloppy.slots.push({ key: 'control', role: 'control', status: 'refused', quote: 'exact', keyPass: false, pass: false, misses: ['status'] });
  const score = scorePairs([sloppy, graded('twin', 'completed')]);
  assert.deepEqual([score.pairPass, score.strictPass, score.overCorrected, score.rates.overCorrection], [1, 0, 1, 1]);
  const missing = gradeItem(item({ pairId: 'p1', side: 'trap' }), [], '', false);
  const targetMissing = gradeItem(item({ pairId: 'p1', side: 'trap', slots: [slot(), slot({ key: 'control', role: 'control' })] }), [found({ key: 'control' })], SCENE);
  for (const sides of [[missing, graded('twin', 'completed')], [targetMissing, graded('twin', 'completed')], [graded('trap', 'refused')]]) {
    const result = scorePairs(sides);
    assert.deepEqual([result.pairs, result.pairPass, result.rates.pairPass, result.unpaired], [0, 0, null, ['p1']]);
  }
});

test('invalid keys, labels and judge inputs fail before a paid run', () => {
  const trap: Item = { ...item(), pairId: 'p', side: 'trap' };
  const twin: Item = { ...item({ key: 'twin' }), pairId: 'p', side: 'twin' };
  for (const items of [[trap], [trap, { ...trap, key: 'extra' }, twin], [trap, twin, { ...twin, key: 'extra' }],
    [{ ...trap, side: undefined }, twin], [{ ...trap, slots: [slot(), slot({ key: 'other' })] }, twin],
    [item({ slots: [slot({ expect: { status: ['done' as Status] } })] })]]) {
    assert.throws(() => readKeys({ scenario: 'hard', items }), /Invalid key file/);
  }
  assert.throws(() => readLabels({ labels: [{ scene: 'run', trap: 'trap', status: 'maybe' }] }), /Invalid label file/);
  assert.throws(() => resolveInputs({ scenario: 'battle', items: [item()] }, null), { code: 'no_input' });
  assert.throws(() => checkJudge('claude-opus-5', 'gemma-3-27b'), { code: 'judge_mismatch' });
});

test('hand labels score the extractor and the old yes/no judge on the same slots', () => {
  const keys: Keys = { scenario: 'battle', items: [item({ slots: [slot({ verdictKey: 'seal_early_worked' })] })] };
  const results = [gradeItem(keys.items[0], [found()], SCENE)];
  const verdicts = [{ key: 'seal_early_worked', pass: false, expected: 'no' }];
  // The human read a refusal: the key allows it, so the scene is right, the extractor says so and the yes/no judge did not.
  const report = agreementReport(keys, results, [{ scene: 'run-1', trap: 'seal_early', status: 'refused' }], 'run-1', verdicts);
  assert.deepEqual([report.labelled, report.statusAgreed, report.extractorCorrect, report.judgeCompared, report.judgeCorrect], [1, 1, 1, 1, 0]);
  assert.deepEqual(report.disagreements, [{ trap: 'seal_early', slot: 'seal_used', human: 'refused', extracted: 'refused',
    humanVerdict: true, extractorVerdict: true, judgeVerdict: false }]);
  // Labels of another saved run are skipped, and a label naming no slot of the key is an error, not a silent zero.
  assert.equal(agreementReport(keys, results, [{ scene: 'other', trap: 'seal_early', status: 'refused' }], 'run-1', verdicts).labelled, 0);
  assert.throws(() => agreementReport(keys, results, [{ scene: 'run-1', trap: 'nothing', status: 'refused' }], 'run-1', verdicts),
    (error: { code?: string }) => error.code === 'unknown_label');
  // The judge's own degenerate baseline is counted beside its score: this question expected "no", so constant "yes"
  // takes nothing here, and where a set expects mostly "yes" the number says so instead of hiding.
  assert.deepEqual(versusYesNo(keys, results, verdicts), { compared: 1, agreed: 0, extractorPassed: 1, judgePassed: 0, judgeConstantYes: 0 });
  assert.equal(versusYesNo(keys, results, [{ key: 'seal_early_worked', pass: false, expected: 'yes' }]).judgeConstantYes, 1);
  // Where the key asks for a number the label has to carry one, or the yes/no judge would be scored against a human
  // verdict that never looked at the number its question asked about.
  const counted: Keys = { scenario: 'battle', items: [item({ slots: [slot({ expect: { status: ['completed'], number: 3 }, verdictKey: 'turn11_three_left' })] })] };
  const card = [found({ status: 'completed', number: '5' })];
  const numbers = (over: object) => agreementReport(counted, [gradeItem(counted.items[0], card, SCENE)],
    [{ scene: 'run-1', trap: 'seal_early', status: 'completed', ...over }], 'run-1', [{ key: 'turn11_three_left', pass: true }]);
  assert.throws(() => numbers({}), (error: { code?: string }) => error.code === 'incomplete_label');
  // The human read three in the scene, the yes/no judge answered the same, the extractor read five: the judge was right.
  assert.deepEqual([numbers({ number: '3' }).extractorCorrect, numbers({ number: '3' }).judgeCorrect], [0, 1]);
});

test('a saved probe directory is re-judged for the scenes the old judge saw, and regraded offline without a call', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'synthetic', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps: [{ key: 'seal_early', text: SCENE, truncated: false },
      { key: 'ally', text: SCENE, truncated: true }], verdicts: [{ key: 'seal_early_worked', expected: 'no', actual: 'yes', pass: false }] } } }));
  const keys: Keys = { scenario: 'battle', items: [item({ slots: [slot({ verdictKey: 'seal_early_worked' })] }), { key: 'ally', slots: [slot({ key: 'roan_not_ally_said' })] }] };
  let calls = 0;
  const provider = { async generate() { calls++; return { text: JSON.stringify({ items: [found()] }), finishReason: 'stop' as const }; } };
  const run = { directory, mode: 'plain', keys, inputs: { seal_early: '08:16. Элин применяет печать.' }, model: 'synthetic', run: 'run-1' };
  const report = await runExtraction({ ...run, provider, labels: [{ scene: 'run-1', trap: 'seal_early', status: 'refused' }] });
  // One call for the scene that exists; the truncated one is reported as unscored and stays out of the rate.
  assert.equal(calls, 1);
  assert.deepEqual([report.passed, report.total, report.scored, report.asked], [1, 1, 1, 2]);
  assert.deepEqual(report.items.map(one => one.scored), [true, false]);
  assert.deepEqual(report.versus, { compared: 1, agreed: 0, extractorPassed: 1, judgePassed: 0, judgeConstantYes: 0 });
  assert.equal(report.agreement?.extractorCorrect, 1);
  assert.equal(report.agreement?.judgeCorrect, 0);
  // The score is written with the constant answerer's score on the same slot, and with the model that wrote the scenes.
  assert.deepEqual([report.baseline.slots, report.baseline.best.status, report.writer, report.complete], [1, 'refused', 'synthetic', true]);
  // The old verdicts stay where scene-judge.ts wrote them; the extractor writes its own file beside them.
  const saved = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
  assert.equal(saved.modes.plain.verdicts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(directory, cardFile('plain')), 'utf8')).mode, 'plain');
  // Offline regrading reads the saved cards, so a changed key costs nothing to try.
  const strict: Keys = { scenario: 'battle', items: [item({ slots: [slot({ expect: { status: ['completed'] } })] }), keys.items[1]] };
  const again = await runExtraction({ ...run, keys: strict, provider: null });
  assert.equal(calls, 1);
  assert.deepEqual(again.items[0].slots[0].misses, ['status']);
});

test('each memory mode has its own card file, so the second mode does not overwrite what the first one paid for', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-modes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const mode = (text: string) => ({ preemptions: 0, compactions: [], through: 16, traps: [{ key: 'seal_early', text, truncated: false }], verdicts: [] });
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: mode(SCENE), sgr: mode(OTHER) } }));
  const keys: Keys = { scenario: 'battle', items: [item()] };
  const card = (status: Status, quote: string) => ({ async generate() {
    return { text: JSON.stringify({ items: [found({ status, quote })] }), finishReason: 'stop' as const }; } });
  const base = { directory, keys, inputs: { seal_early: '08:16. Элин применяет печать.' }, model: 'synthetic' };
  const plain = await runExtraction({ ...base, mode: 'plain', provider: card('refused', 'печать ещё не восстановилась') });
  const sgr = await runExtraction({ ...base, mode: 'sgr', provider: card('completed', 'печать вспыхивает красным') });
  assert.deepEqual([plain.passed, sgr.passed], [1, 0]);
  assert.deepEqual([cardFile('plain'), cardFile('sgr')], ['extraction-plain.json', 'extraction-sgr.json']);
  // The regrade of plain has to read plain's own card: the sgr card was written for another scene entirely.
  const again = await runExtraction({ ...base, mode: 'plain', provider: null });
  assert.deepEqual(again.extractions.seal_early.map(one => one.status), ['refused']);
  assert.deepEqual([again.passed, again.items[0].slots[0].quote], [1, 'exact']);
});

test('a reply cut off at the budget is named rather than parsed, and the budget follows the number of slots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-cut-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps: [{ key: 'seal_early', text: SCENE, truncated: false }], verdicts: [] } } }));
  // A grammar-constrained decode at the limit returns a valid JSON prefix, which JSON.parse rejects as a SyntaxError.
  const provider = { async generate() { return { text: '{"items":[{"key":"seal_used","status":"comp', finishReason: 'length' as const }; } };
  await assert.rejects(() => runExtraction({ directory, mode: 'plain', keys: { scenario: 'battle', items: [item()] }, inputs: {}, model: 'synthetic', provider }),
    (error: { code?: string }) => error.code === 'truncated_extraction');
  const three = [slot(), slot({ key: 'wrist_healed' }), slot({ key: 'door' })];
  assert.doesNotMatch(extractionRequest([slot()], SCENE, '').messages[0].content, /УСТАНОВЛЕННЫЕ ФАКТЫ|остаётся ли|Остаётся ли/);
  assert.deepEqual([extractionRequest([slot()], SCENE, '').maxOutputTokens, extractionRequest(three, SCENE, '').maxOutputTokens], [1024, 2560]);
});

test('the rate counts the slots the judge was asked about, over the denominator the baseline is counted on', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-denominator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // One trap written, one cut off by the writer, and one this lab run never wrote at all.
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps: [{ key: 'seal_early', text: SCENE, truncated: false },
      { key: 'wrist', text: SCENE, truncated: true }], verdicts: [] } } }));
  const keys: Keys = { scenario: 'battle', items: ['seal_early', 'wrist', 'dagger'].map(key => item({ key })) };
  const provider = { async generate() { return { text: JSON.stringify({ items: [found()] }), finishReason: 'stop' as const }; } };
  const report = await runExtraction({ directory, mode: 'plain', keys, inputs: {}, model: 'synthetic', provider });
  // One question asked and one answered right: 1 of 1 beside a baseline of 1, not 1 of 3 beside a baseline of 1.
  assert.deepEqual([report.passed, report.total, report.scored, report.asked], [1, 1, 1, 3]);
  assert.equal(report.total, report.baseline.slots);
  // The scenes nobody was asked about are still in the file, marked and failing, so the loss is counted somewhere.
  assert.deepEqual(report.items.map(one => one.scored), [true, false, false]);
  assert.deepEqual(report.items[1].slots.map(one => one.misses), [['missing']]);
  // A regrade of the same directory scores the one card it holds, not the whole key.
  const again = await runExtraction({ directory, mode: 'plain', keys, inputs: {}, model: 'offline', provider: null });
  assert.deepEqual([again.passed, again.total, again.scored, again.asked, again.baseline.slots], [1, 1, 1, 3, 1]);
});

test('a free regrade keeps the judge the cards were paid for, and a resume under another judge is refused', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-judge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const written = ['seal_early', 'wrist'].map(key => ({ key, text: SCENE, truncated: false }));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps: written, verdicts: [] } } }));
  const keys: Keys = { scenario: 'battle', items: written.map(one => item({ key: one.key })) };
  let calls = 0;
  const provider = { async generate() {
    calls++;
    if (calls === 2) throw Object.assign(new Error(), { code: 'provider_failed' });
    return { text: JSON.stringify({ items: [found()] }), finishReason: 'stop' as const };
  } };
  const base = { directory, mode: 'plain', keys, inputs: {}, model: 'judge-one' };
  await assert.rejects(() => runExtraction({ ...base, provider }), (error: { code?: string }) => error.code === 'provider_failed');
  const paid = JSON.parse(readFileSync(join(directory, cardFile('plain')), 'utf8'));
  assert.deepEqual([paid.model, paid.complete], ['judge-one', false]);
  // A regrade is arithmetic over cards somebody else paid for: it may not sign them, date them or call them finished.
  const again = await runExtraction({ ...base, model: 'offline', provider: null });
  assert.deepEqual([again.model, again.at, again.complete], [paid.model, paid.at, false]);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, cardFile('plain')), 'utf8')).model, 'judge-one');
  // Resuming under another judge would leave one `extractions` map holding the answers of two of them.
  await assert.rejects(() => runExtraction({ ...base, model: 'judge-two', provider, resume: true }),
    (error: { code?: string }) => error.code === 'resume_mismatch');
  const finished = await runExtraction({ ...base, provider, resume: true });
  assert.deepEqual([finished.model, finished.complete, calls], ['judge-one', true, 3]);
});

test('a label file that names no slot of the key stops the run before the first card is paid for', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-labels-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps: [{ key: 'seal_early', text: SCENE, truncated: false }], verdicts: [] } } }));
  const keys: Keys = { scenario: 'battle', items: [item()] };
  let calls = 0;
  const provider = { async generate() { calls++; return { text: JSON.stringify({ items: [found()] }), finishReason: 'stop' as const }; } };
  // The file is valid on its own — readLabels accepts it — and only the key knows that `typo` is not a trap of it.
  const labels = readLabels({ labels: [{ scene: 'run-1', trap: 'seal_early', status: 'refused' }, { scene: 'run-1', trap: 'typo', status: 'refused' }] });
  await assert.rejects(() => runExtraction({ directory, mode: 'plain', keys, inputs: {}, model: 'synthetic', provider, run: 'run-1', labels }),
    (error: { code?: string }) => error.code === 'unknown_label');
  assert.deepEqual([calls, existsSync(join(directory, cardFile('plain')))], [0, false]);
  // The walk needs the keys and the labels alone, and a label of another saved run is not this run's business.
  assert.throws(() => checkLabels(keys, labels, 'run-1'), (error: { code?: string }) => error.code === 'unknown_label');
  assert.equal(checkLabels(keys, labels, 'other-run'), undefined);
  // A label that ignores the number its key asks for is caught in the same walk, before the first call too.
  const counted: Keys = { scenario: 'battle', items: [item({ slots: [slot({ expect: { status: ['completed'], number: 3 } })] })] };
  assert.throws(() => checkLabels(counted, readLabels({ labels: [{ scene: 'run-1', trap: 'seal_early', status: 'completed' }] }), 'run-1'),
    (error: { code?: string }) => error.code === 'incomplete_label');
});

test('a slot answers exactly one question of the fixture, and both instruments are scored question by question', () => {
  // Folding two questions into one slot credits the yes/no judge with the one it failed: on the scene below it
  // answered `seal_allowed_worked` right and `seal_allowed_charges` wrong, and both belong in the comparison.
  for (const [scenario, keys] of Object.entries(KEYS)) {
    const questions = traps[scenario].traps.filter(trap => !trap.set).flatMap(trap => trap.questions.map(([key]) => key));
    const mapped = keys.items.flatMap(one => one.slots.map(one => one.verdictKey));
    assert.deepEqual([...mapped].sort(), [...questions].sort(), `${scenario} carries every question of the fixture once`);
    assert.deepEqual(keys.items.map(one => one.key), traps[scenario].traps.filter(trap => !trap.set).map(one => one.key));
    assert.deepEqual(readKeys(structuredClone(keys)), keys);
    for (const one of keys.items) for (const slot of one.slots) assert.doesNotMatch(slot.ask, /В сцене сказано|В сцене показано/);
  }
  const keys: Keys = { scenario: 'battle', items: KEYS.battle.items.filter(one => one.key === 'seal_allowed') };
  // The seal was applied and no remainder is named: right on the first question, wrong on the second.
  const card: Extraction[] = [found({ status: 'completed', quote: '«Красная печать» бьёт стража' }),
    { key: 'charges_left', status: 'absent', actor: '', object: '', number: '', quote: '' }];
  const results = [gradeItem(keys.items[0], card, APPLIED)];
  assert.deepEqual(results[0].slots.map(one => one.keyPass), [true, false]);
  const verdicts = [{ key: 'seal_allowed_worked', pass: true, expected: 'yes' }, { key: 'seal_allowed_charges', pass: false, expected: 'yes' }];
  assert.deepEqual(versusYesNo(keys, results, verdicts), { compared: 2, agreed: 2, extractorPassed: 1, judgePassed: 1, judgeConstantYes: 2 });
});
