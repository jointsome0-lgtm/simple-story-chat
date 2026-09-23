import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { traps } from '../examples/scene-traps.ts';
import { KEYS } from './judge-extract-keys.ts';
import { quoteLevel, gradeSlot, gradeItem, scorePairs, agreementReport, versusYesNo, readExtraction, readKeys, readLabels,
  extractionRequest, runExtraction, constantBaseline, resolveInputs, checkJudge, checkLabels, numberOf, cardFile, STATUSES } from './judge-extract-probe.ts';
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

test('a quote is verified against the scene with the whitespace and typography tolerance, and nothing below it', () => {
  assert.equal(quoteLevel(SCENE, 'печать ещё не восстановилась'), 'exact');
  assert.equal(quoteLevel(SCENE, '  печать   ещё\n не восстановилась '), 'whitespace');
  assert.equal(quoteLevel(SCENE, '"Рано", - говорит она'), 'typography');
  // Only after punctuation is dropped, which is a retyped line rather than a quote.
  assert.equal(quoteLevel(SCENE, 'Рано говорит она'), 'punctuation');
  assert.equal(quoteLevel(SCENE, 'Элин применяет печать'), 'none');
  assert.equal(quoteLevel(SCENE, '   '), 'empty');
});

test('a slot passes on the status the key allows and fails on the actor, the number or an unsupported quote', () => {
  assert.deepEqual(gradeSlot(slot(), found(), SCENE).misses, []);
  assert.equal(gradeSlot(slot(), found(), SCENE).pass, true);
  assert.deepEqual(gradeSlot(slot(), found({ status: 'completed' }), SCENE).misses, ['status']);
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], actor: ['Тарек'] } }), found(), SCENE).misses, ['actor']);
  // A name the judge spells out in full still matches the key's short form.
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], actor: ['Элин'] } }), found({ actor: 'стражница Элин Вара' }), SCENE).misses, []);
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], number: 3 } }), found({ number: '' }), SCENE).misses, ['number']);
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], number: 'none' } }), found({ number: '' }), SCENE).misses, []);
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], number: 1200 } }), found({ number: '1 200' }), SCENE).misses, []);
  assert.deepEqual(gradeSlot(slot(), found({ quote: 'печать сгорела дотла' }), SCENE).misses, ['quote']);
  // The claim and the quote are separate verdicts: the yes/no judge can only be compared with the first.
  const invented = gradeSlot(slot(), found({ quote: 'печать сгорела дотла' }), SCENE);
  assert.deepEqual([invented.keyPass, invented.pass, invented.quote], [true, false, 'none']);
});

test('`absent` is the one status that needs an empty quote, and a slot the judge skipped is missing, not passed', () => {
  const absent = slot({ expect: { status: ['absent'] } });
  assert.deepEqual(gradeSlot(absent, found({ status: 'absent', quote: '' }), SCENE).misses, []);
  assert.deepEqual(gradeSlot(absent, found({ status: 'absent', quote: 'печать ещё не восстановилась' }), SCENE).misses, ['quote']);
  assert.deepEqual(gradeSlot(slot(), undefined, SCENE).misses, ['missing']);
  assert.equal(gradeSlot(slot(), undefined, SCENE).status, null);
});

test('a scene that was never written or was cut off fails its slots without being scored as a refusal', () => {
  const cut = gradeItem(item({ pairId: 'p1', side: 'trap' }), [], '', false);
  assert.equal(cut.pass, false);
  assert.deepEqual(cut.slots.map(one => one.misses), [['missing']]);
  // The twin was written and carried out, but the trap side is unreadable, so the pair is reported, not rated.
  assert.deepEqual(scorePairs([cut, graded('twin', 'completed')]), {
    pairs: 0, pairPass: 0, strictPass: 0, falseDetected: 0, overCorrected: 0, withControls: 0,
    rates: { pairPass: null, falseDetection: null, overCorrection: null }, unpaired: ['p1'] });
});

test('a pair passes only when the trap is refused and its true-premise twin is carried out', () => {
  const pair = (trap: Status, twin: Status) => scorePairs([graded('trap', trap), graded('twin', twin)]);
  assert.equal(pair('refused', 'completed').pairPass, 1);
  assert.equal(pair('refused', 'refused').pairPass, 0);
  assert.equal(pair('completed', 'completed').pairPass, 0);
  // An evasive scene is not a refusal: silence would otherwise pass every prohibition.
  assert.equal(pair('absent', 'completed').pairPass, 0);
  assert.equal(pair('proposed', 'completed').pairPass, 0);
});

test('always refusing and always complying both score zero on pairs, and refusal shows up as false detection', () => {
  const both = (trap: Status, twin: Status) => [graded('trap', trap), graded('twin', twin),
    { ...graded('trap', trap), key: 'b-trap', pairId: 'p2' }, { ...graded('twin', twin), key: 'b-twin', pairId: 'p2' }];
  const refusing = scorePairs(both('refused', 'refused'));
  assert.deepEqual([refusing.pairs, refusing.pairPass, refusing.rates.falseDetection], [2, 0, 1]);
  const complying = scorePairs(both('completed', 'completed'));
  assert.deepEqual([complying.pairs, complying.pairPass, complying.rates.falseDetection], [2, 0, 0]);
  const right = scorePairs(both('refused', 'completed'));
  assert.deepEqual([right.rates.pairPass, right.rates.falseDetection], [1, 0]);
});

test('a strict pass needs every slot of both sides, and a half pair is reported unpaired rather than scored', () => {
  const sloppy = graded('trap', 'refused');
  sloppy.slots.push({ key: 'wrist_healed', role: 'control', status: 'refused', quote: 'exact', keyPass: false, pass: false, misses: ['status'] });
  sloppy.pass = false;
  const score = scorePairs([sloppy, graded('twin', 'completed')]);
  assert.deepEqual([score.pairPass, score.strictPass], [1, 0]);
  // The control slot is the true half of the same turn: refusing it is over-correction, not caution.
  assert.deepEqual([score.withControls, score.overCorrected, score.rates.overCorrection], [1, 1, 1]);
  assert.deepEqual(scorePairs([graded('trap', 'refused')]).unpaired, ['p1']);
});

test('the request carries the scene, the asks and no established facts, and a closed schema of the fixed statuses', () => {
  const request = extractionRequest([slot(), slot({ key: 'wrist_healed', ask: 'Рука Элин снова работает' })], SCENE, '08:16. Элин применяет печать.');
  assert.match(request.messages[0].content, /СЦЕНА:\nЭлин опускает браслет/);
  assert.match(request.messages[0].content, /seal_used: Элин применяет «Красную печать»\nwrist_healed:/);
  assert.doesNotMatch(request.messages[0].content, /УСТАНОВЛЕННЫЕ ФАКТЫ|остаётся ли|Остаётся ли/);
  assert.equal(request.purpose, 'memory');
  const schema = request.outputSchema as { properties: { items: { minItems: number; maxItems: number;
    items: { properties: { status: { enum: string[] }; key: { enum: string[] } } } } } };
  assert.deepEqual([schema.properties.items.minItems, schema.properties.items.maxItems], [2, 2]);
  assert.deepEqual(schema.properties.items.items.properties.status.enum, [...STATUSES]);
  assert.deepEqual(schema.properties.items.items.properties.key.enum, ['seal_used', 'wrist_healed']);
});

test('a fenced reply is read, an entry with an unknown status is dropped and a reply of the wrong shape fails', () => {
  const card = (items: object[]) => JSON.stringify({ items });
  assert.deepEqual(readExtraction('```json\n' + card([found()]) + '\n```').map(one => one.status), ['refused']);
  assert.deepEqual(readExtraction(card([found({ status: 'invented' as Status }), found({ key: 'other' })])).map(one => one.key), ['other']);
  // Missing strings become empty ones, so the grader sees a card and not a TypeError.
  assert.deepEqual(readExtraction(card([{ key: 'seal_used', status: 'absent' }]))[0], { key: 'seal_used', status: 'absent', actor: '', object: '', number: '', quote: '' });
  assert.throws(() => readExtraction('{"answers":[]}'), (error: { code?: string }) => error.code === 'invalid_extraction');
});

test('a key file and a label file are validated before anything is graded against them', () => {
  const keys: Keys = { scenario: 'hard', items: [{ key: 'tickets', pairId: 'tickets', side: 'trap', input: 'Дай двенадцать.', slots: [slot()] },
    { key: 'tickets_ok', pairId: 'tickets', side: 'twin', input: 'Дай два.', slots: [slot({ expect: { status: ['completed'] } })] }] };
  assert.deepEqual(readKeys(structuredClone(keys)), keys);
  assert.throws(() => readKeys({ ...keys, items: [{ ...keys.items[0], side: undefined }] }), /Invalid key file/);
  assert.throws(() => readKeys({ ...keys, items: [{ ...keys.items[0], slots: [{ ...slot(), expect: { status: ['done'] } }] }] }), /Invalid key file/);
  assert.deepEqual(readLabels({ labels: [{ scene: 'run-1', trap: 'seal_early', status: 'refused', number: '3' }] }).length, 1);
  assert.throws(() => readLabels({ labels: [{ scene: 'run-1', trap: 'seal_early', status: 'maybe' }] }), /Invalid label file/);
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

test('a failure keeps the cards already paid for, and --resume asks only for the scenes still missing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-extract-resume-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const traps = ['seal_early', 'wrist', 'dagger'].map(key => ({ key, text: SCENE, truncated: false }));
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ scenario: 'battle', sourceHash: 'x', model: 'writer', startedAt: '', scope: '',
    modes: { plain: { preemptions: 0, compactions: [], through: 16, traps, verdicts: [] } } }));
  const keys: Keys = { scenario: 'battle', items: traps.map(trap => item({ key: trap.key })) };
  let calls = 0;
  const provider = { async generate() {
    calls++;
    if (calls === 2) throw Object.assign(new Error(), { code: 'provider_failed' });
    return { text: JSON.stringify({ items: [found()] }), finishReason: 'stop' as const };
  } };
  const base = { directory, mode: 'plain', keys, inputs: {}, model: 'synthetic', provider };
  await assert.rejects(() => runExtraction(base), (error: { code?: string }) => error.code === 'provider_failed');
  const saved = JSON.parse(readFileSync(join(directory, cardFile('plain')), 'utf8'));
  assert.deepEqual([saved.complete, Object.keys(saved.extractions)], [false, ['seal_early']]);
  const report = await runExtraction({ ...base, resume: true });
  // One call before the failure, one that failed, and the two scenes that were still missing.
  assert.deepEqual([calls, report.complete, report.items.length], [4, true, 3]);
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
  assert.deepEqual([extractionRequest([slot()], SCENE, '').maxOutputTokens, extractionRequest(three, SCENE, '').maxOutputTokens], [1024, 2560]);
});

test('a pair is scored on the item\'s own target slot, and a key may not give a paired item two of them', () => {
  const trap: Item = { key: 't', pairId: 'p', side: 'trap', slots: [slot(), slot({ key: 'door' })] };
  const twin: Item = { key: 'w', pairId: 'p', side: 'twin', slots: [slot({ expect: { status: ['completed'] } })] };
  // The judge answered the neighbouring slot and dropped the trap's own claim; the pair is then unreadable.
  const score = scorePairs([gradeItem(trap, [found({ key: 'door' })], SCENE), gradeItem(twin, [found({ status: 'completed' })], SCENE)]);
  assert.deepEqual([score.pairs, score.pairPass, score.unpaired], [0, 0, ['p']]);
  assert.throws(() => readKeys({ scenario: 'battle', items: [trap] }), /Invalid key file/);
  // The same item with the neighbour marked as the control is a legal key, and it is read on `seal_used`.
  const legal: Item = { ...trap, slots: [slot(), slot({ key: 'door', role: 'control' })] };
  assert.deepEqual(readKeys({ scenario: 'battle', items: [legal, twin] }).items.length, 2);
  assert.equal(scorePairs([gradeItem(legal, [found(), found({ key: 'door' })], SCENE), gradeItem(twin, [found({ status: 'completed' })], SCENE)]).pairPass, 1);
});

test('a trap with no player message stops the run instead of showing the judge an empty message', () => {
  const keys: Keys = { scenario: 'battle', items: [item()] };
  // A mistyped --pack leaves no fixture; without the key file's own input the run would buy a card per empty message.
  assert.throws(() => resolveInputs(keys, null), (error: { code?: string }) => error.code === 'no_input');
  assert.deepEqual(resolveInputs({ scenario: 'battle', items: [item({ input: 'Дай двенадцать.' })] }, null), { seal_early: 'Дай двенадцать.' });
  assert.deepEqual(resolveInputs(keys, { traps: [{ key: 'seal_early', input: '08:16. Печать.', questions: [] }], turns: [] }), { seal_early: '08:16. Печать.' });
  assert.deepEqual(resolveInputs(keys, { traps: [{ key: 'seal_early', afterTurn: 1, questions: [] }], turns: ['08:15.', '08:16.'] }), { seal_early: '08:16.' });
});

test('the model the orchestrator names as the judge is checked before the first call is paid for', () => {
  assert.equal(checkJudge(undefined, 'whatever-the-env-holds'), undefined);
  assert.equal(checkJudge('claude-opus-5', 'claude-opus-5'), undefined);
  assert.throws(() => checkJudge('claude-opus-5', 'gemma-3-27b'), (error: { code?: string }) => error.code === 'judge_mismatch');
});

test('a number the scene spells out is read, and the thousands separators are joined as memory-probe.ts joins them', () => {
  assert.deepEqual([numberOf('3'), numberOf('три'), numberOf('Три заряда'), numberOf('тридцать восемь'), numberOf('второе место')], [3, 3, 3, 38, 2]);
  assert.deepEqual([numberOf(''), numberOf('неизвестно'), numberOf('второе место из трёх')], [null, null, 2]);
  // Both separators, written here as codes for the same reason they are escapes in the source.
  for (const code of [0x20, 0xa0, 0x202f]) assert.equal(numberOf(`1${String.fromCharCode(code)}200`), 1200);
  // The frozen battle scenes write «три заряда» and never «3 заряда», so the word has to pass the key that expects 3.
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], number: 3 } }), found({ number: 'три' }), SCENE).misses, []);
  assert.deepEqual(gradeSlot(slot({ expect: { status: ['refused'], number: 'none' } }), found({ number: 'три' }), SCENE).misses, ['number']);
});

test('a constant answerer is scored on the same slots, and no built-in ask states the answer it expects', () => {
  const alone = constantBaseline([{ item: item(), scene: SCENE }]);
  assert.deepEqual([alone.slots, alone.best.status, alone.best.keyPass, alone.best.pass], [1, 'refused', 1, 1]);
  // The open pack is almost all false premises, so a judge that answers `refused` to everything takes most of it.
  // That is what the number is for: the score of this pack means nothing until it stands above this line.
  const open = Object.values(KEYS).flatMap(keys => keys.items.map(one => ({ item: one, scene: SCENE })));
  const baseline = constantBaseline(open);
  assert.equal(baseline.best.status, 'refused');
  assert.ok(baseline.best.keyPass > baseline.slots / 2, `a constant takes ${baseline.best.keyPass} of ${baseline.slots}`);
  // An ask that asserts what the key expects is the answer sheet again: the slot names the claim, the key judges it.
  for (const keys of Object.values(KEYS)) for (const one of keys.items) for (const slot of one.slots) {
    assert.doesNotMatch(slot.ask, /В сцене сказано|В сцене показано/, `${one.key}/${slot.key}`);
  }
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

test('a pairId names one trap and one twin, so no side of a pack key is dropped from the rate', () => {
  const side = (key: string, which: 'trap' | 'twin'): Item => ({ key, pairId: 'p', side: which, input: 'x',
    slots: [slot(which === 'twin' ? { expect: { status: ['completed'] } } : {})] });
  assert.equal(readKeys({ scenario: 'hard', items: [side('t1', 'trap'), side('w1', 'twin')] }).items.length, 2);
  // Two traps under one id: `scorePairs` takes the first of them and the other falls out of the rate and out of
  // `unpaired` alike, so the pack's headline would be counted over fewer traps than the file holds.
  assert.throws(() => readKeys({ scenario: 'hard', items: [side('t1', 'trap'), side('t2', 'trap'), side('w1', 'twin')] }), /Invalid key file/);
  assert.throws(() => readKeys({ scenario: 'hard', items: [side('t1', 'trap')] }), /Invalid key file/);
  assert.throws(() => readKeys({ scenario: 'hard', items: [side('t1', 'trap'), side('w1', 'twin'), side('w2', 'twin')] }), /Invalid key file/);
});

test('a slot answers exactly one question of the fixture, and both instruments are scored question by question', () => {
  // Folding two questions into one slot credits the yes/no judge with the one it failed: on the scene below it
  // answered `seal_allowed_worked` right and `seal_allowed_charges` wrong, and both belong in the comparison.
  for (const [scenario, keys] of Object.entries(KEYS)) {
    const questions = traps[scenario].traps.flatMap(trap => trap.questions.map(([key]) => key));
    const mapped = keys.items.flatMap(one => one.slots.map(one => one.verdictKey));
    assert.deepEqual([...mapped].sort(), [...questions].sort(), `${scenario} carries every question of the fixture once`);
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

test('every built-in key names a trap of examples/scene-traps.ts and a question that exists', () => {
  for (const [scenario, keys] of Object.entries(KEYS)) {
    const fixture = traps[scenario];
    assert.ok(fixture, `${scenario} has traps`);
    const questions = fixture.traps.flatMap(trap => trap.questions.map(([key]) => key));
    assert.deepEqual(keys.items.map(one => one.key), fixture.traps.map(trap => trap.key), `${scenario} covers every trap`);
    for (const one of keys.items) for (const slot of one.slots) {
      assert.ok(!slot.verdictKey || questions.includes(slot.verdictKey), `${scenario}/${one.key}: ${slot.verdictKey} is a question of the fixture`);
    }
    // The key file is data the judge never sees; the loader's rules still hold for it.
    assert.deepEqual(readKeys(structuredClone(keys)), keys);
  }
});
