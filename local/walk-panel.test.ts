import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeRequest, parseVerdict, panel, summarize, compactsAfter, judgeFileName, findings, crossRequest, parseCross, council, seedAuditRequest, parseIssues, storyAuditRequest, parseStoryIssues, storyAuditFileName } from './walk-panel.ts';

test('the judge of a scene sees the seed, every earlier step and the new scene, and answers by schema', () => {
  const steps = [{ turn: 1, kind: 'continue' as const, input: 'Продолжай.', text: 'Сцена один.' }, { turn: 2, kind: 'intervention' as const, input: 'Гаснет свет.', text: 'Сцена два.' }];
  const request = judgeRequest('Сид.', steps, 1);
  const content = request.messages[0].content;
  assert.ok(content.includes('СИД:\nСид.'));
  assert.ok(content.includes('ШАГ 1 (знак продолжать): Продолжай.\nСЦЕНА 1:\nСцена один.'));
  assert.ok(content.includes('ШАГ 2 (вмешательство автора): Гаснет свет.\nНОВАЯ СЦЕНА 2:\nСцена два.'));
  assert.ok(!content.includes('НОВАЯ СЦЕНА 1'));
  assert.ok(judgeRequest('Сид.', steps, 0).messages[0].content.includes('(новая сцена первая)'));
  assert.equal(request.purpose, 'memory');
  assert.ok(request.outputSchema);
});

test('contradictions decide the verdict, an empty inconsistent verdict abstains, a fenced reply is read', () => {
  assert.deepEqual(parseVerdict('{"verdict":"consistent","contradictions":[]}'), { verdict: 'consistent', contradictions: [] });
  const c = { now: 'a', before: 'b', where: 'сцена 1', kind: 'number' };
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'consistent', contradictions: [c] })).verdict, 'inconsistent');
  assert.equal(parseVerdict('{"verdict":"inconsistent","contradictions":[]}').verdict, 'error');
  assert.equal(parseVerdict('```json\n{"verdict":"inconsistent","contradictions":[' + JSON.stringify(c) + ']}\n```').contradictions.length, 1);
  assert.throws(() => parseVerdict('{"verdict":"maybe","contradictions":[]}'), { code: 'invalid_verdict' });
  // A malformed entry is dropped, so it cannot count as evidence.
  assert.equal(parseVerdict(JSON.stringify({ verdict: 'inconsistent', contradictions: [{ now: 'a' }] })).verdict, 'error');
});

test('the panel decides by majority; a tie is split, an error abstains, no vote is unjudged', () => {
  const v = (turn: number, verdict: 'consistent' | 'inconsistent' | 'error') => ({ turn, verdict, contradictions: [] });
  const rows = panel(4, { a: [v(1, 'consistent'), v(2, 'inconsistent'), v(3, 'consistent')],
    b: [v(1, 'consistent'), v(2, 'inconsistent'), v(3, 'inconsistent')], c: [v(1, 'error'), v(2, 'consistent'), v(3, 'error')] });
  assert.deepEqual(rows.map(r => r.verdict), ['consistent', 'inconsistent', 'split', 'unjudged']);
  assert.deepEqual(rows[3].votes, { a: 'error', b: 'error', c: 'error' });
  assert.deepEqual(summarize(rows), { total: 4, consistent: 1, split: 1, inconsistent: 1, unjudged: 1, firstInconsistent: 2 });
  assert.equal(summarize(panel(1, { a: [v(1, 'consistent')] })).firstInconsistent, undefined);
});

test('compaction after scene 7 and every fourth scene after it; a judge label becomes a file name', () => {
  assert.deepEqual(Array.from({ length: 24 }, (_, i) => i + 1).filter(compactsAfter), [7, 11, 15, 19, 23]);
  assert.equal(judgeFileName('claude:claude-opus-5-5'), 'walk-judge-claude-claude-opus-5-5.json');
});

test('the council numbers every listed contradiction per scene, asks about each, and lets the majority of checks decide', () => {
  const c = (now: string) => ({ now, before: 'b', where: 'сцена 1', kind: 'item' as const });
  const v = (turn: number, verdict: 'consistent' | 'inconsistent' | 'error', contradictions = [] as ReturnType<typeof c>[]) => ({ turn, verdict, contradictions });
  const byJudge = { a: [v(1, 'consistent'), v(2, 'inconsistent', [c('x'), c('y')])], b: [v(1, 'consistent'), v(2, 'inconsistent', [c('z')])], d: [v(1, 'error'), v(2, 'consistent')] };
  const found = findings(byJudge);
  assert.deepEqual(found.map(f => [f.turn, f.by, f.number, f.now]), [[2, 'a', 1, 'x'], [2, 'a', 2, 'y'], [2, 'b', 3, 'z']]);
  const steps = [{ turn: 1, kind: 'continue' as const, input: 'i', text: 's1' }, { turn: 2, kind: 'continue' as const, input: 'i', text: 's2' }];
  const request = crossRequest('Сид.', steps, 1, found);
  assert.ok(request.messages[0].content.includes('НАХОДКИ:\n1. Сейчас: «x»'));
  assert.ok(request.messages[0].content.includes('3. Сейчас: «z»'));
  assert.deepEqual(parseCross('{"checks":[{"finding":2,"confirmed":false,"note":"n"},{"finding":1,"confirmed":true,"note":"m"},{"finding":3,"confirmed":true,"note":""}]}', 3).map(x => x.confirmed), [true, false, true]);
  assert.throws(() => parseCross('{"checks":[{"finding":1,"confirmed":true,"note":""}]}', 2), { code: 'invalid_cross' });
  assert.throws(() => parseCross('{"checks":[{"finding":1,"confirmed":"yes","note":""}]}', 1), { code: 'invalid_cross' });
  const check = (finding: number, confirmed: boolean) => ({ turn: 2, finding, confirmed, note: '' });
  // Finding 1: two confirm, one refutes; finding 2: all refute; finding 3: one each and one silent judge → disputed.
  const rows = council(3, byJudge, { a: [check(1, true), check(2, false), check(3, true)], b: [check(1, true), check(2, false), check(3, false)], d: [check(1, false), check(2, false)] });
  assert.deepEqual(rows[1], { turn: 2, findings: 3, confirmed: 1, refuted: 1, disputed: 1, verdict: 'inconsistent' });
  assert.deepEqual(rows[0], { turn: 1, findings: 0, confirmed: 0, refuted: 0, disputed: 0, verdict: 'consistent' });
  assert.equal(rows[2].verdict, 'unjudged');
  // All refuted: the scene is consistent although two judges had flagged it; only disputed: split; no checks at all: the first round stands.
  assert.equal(council(2, byJudge, { a: [check(1, false), check(2, false), check(3, false)], b: [check(1, false), check(2, false), check(3, false)] })[1].verdict, 'consistent');
  assert.equal(council(2, byJudge, { a: [check(1, true), check(2, false), check(3, false)], b: [check(1, false), check(2, false), check(3, false)] })[1].verdict, 'split');
  assert.deepEqual(council(2, byJudge, {})[1], { turn: 2, findings: 3, confirmed: 0, refuted: 0, disputed: 3, verdict: 'inconsistent' });
});

test('the seed audit asks for contradictions and ambiguities with quotes, and drops malformed issues', () => {
  const request = seedAuditRequest('Сид.\n2026-01-01 10:00\nМир.');
  assert.ok(request.messages[0].content.startsWith('СИД:\nСид.'));
  assert.deepEqual(parseIssues('{"issues":[{"kind":"ambiguity","quote":"q","note":"n"},{"kind":"style","quote":"x","note":"y"},{"kind":"contradiction","quote":"a"}]}'),
    [{ kind: 'ambiguity', quote: 'q', note: 'n' }]);
  assert.deepEqual(parseIssues('```json\n{"issues":[]}\n```'), []);
  assert.throws(() => parseIssues('{"nothing":true}'), { code: 'invalid_audit' });
});

test('the story audit puts the seed and every scene in one request and keeps only issues that name a scene', () => {
  const steps = [{ turn: 1, kind: 'continue' as const, input: 'Начни.', text: '2026-01-01 10:05\n\nПервая.' }, { turn: 2, kind: 'intervention' as const, input: 'Гаснет свет.', text: '2026-01-01 10:10\n\nВторая.' }];
  const request = storyAuditRequest('Сид\n2026-01-01 10:00\nМир.', steps);
  assert.match(request.messages[0].content, /СИД:\nСид[\s\S]*ШАГ 1 \(знак продолжать\): Начни\.\nСЦЕНА 1:[\s\S]*ШАГ 2 \(вмешательство автора\): Гаснет свет\.\nСЦЕНА 2:/);
  const issues = parseStoryIssues('```json\n{"issues":[{"kind":"contradiction","scene":2,"quote":"Вторая.","note":"расходится со сценой 1"},{"kind":"ambiguity","scene":3,"quote":"x","note":"нет такой сцены"},{"kind":"style","scene":1,"quote":"x","note":"x"}]}\n```', 2);
  assert.deepEqual(issues, [{ kind: 'contradiction', scene: 2, quote: 'Вторая.', note: 'расходится со сценой 1' }]);
  assert.throws(() => parseStoryIssues('{"verdict":"consistent"}', 2), (e: { code?: string }) => e.code === 'invalid_audit');
  assert.equal(storyAuditFileName('codex:gpt-6-sol'), 'story-audit-codex-gpt-6-sol.json');
});
