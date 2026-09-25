import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMemory, summaryRequest } from './memory.ts';
import { Store } from './store.ts';
import { compactBranch } from './generation.ts';
import { makeRequest } from './prompt.ts';
import type { Checkpoint } from '../lib/library.ts';
import { addSeed, newStory, beginJob, commitTurn, active, context, jobTarget } from '../lib/library.ts';
import type { GenerationResult, ModelRequest } from './model.ts';

const nodes = [
  { id: 'n1', input: 'Запланированы 40 повторов, но все отменены.', text: '2026-08-02 10:00\nТренировку отменили.' },
  { id: 'n2', input: 'Только 3...g6. Не добавляй ходы.', text: '2026-08-02 10:01\nОн сыграл 4.Nf3.' },
];
function extraction() {
  return {
    evidence: [
      { id: 'e1', scene: 'n1', part: 'input', quote: '40 повторов, но все отменены' },
      { id: 'e2', scene: 'n2', part: 'input', quote: 'Только 3...g6. Не добавляй ходы.' },
      { id: 'e3', scene: 'n2', part: 'text', quote: 'Он сыграл 4.Nf3.' },
    ],
    conflicts: [{ input: 'e2', text: 'e3', resolution: 'author_priority' }],
    facts: [
      { kind: 'event', at: '2026-08-02 10:00', status: 'cancelled', text: 'Все запланированные 40 повторов отменены, не выполнены.', evidence: ['e1'] },
      { kind: 'directive', at: '2026-08-02 10:01', status: 'actual', text: 'Автор разрешил только 3...g6; добавленный в продолжении 4.Nf3 ошибочен и не считается сыгранным.', evidence: ['e2', 'e3'] },
    ],
  };
}
// The plain mode has no quotes: a fact names its scenes itself.
const plain = () => ({ facts: [{ kind: 'event', at: '2026-08-02 10:00', text: 'Все 40 повторов отменены.', source: ['n1', 'n1'] },
  { kind: 'directive', at: '2026-08-02 10:01', text: 'Сыграно только 3...g6.', source: ['n2'] }] });
const result = (data: unknown): GenerationResult => ({ text: JSON.stringify(data), finishReason: 'stop' });
const changed = <T>(data: T, mutate: (d: T) => void) => { mutate(data); return result(data); };

// A row breaks one check of the model's output; the refusal names that check, as the failure's log row will.
test('SGR and plain memory keep only facts grounded in every scene of the increment and refuse the rest with a reason', () => {
  const sgr = parseMemory(result(extraction()), nodes, 'sgr', 'ru');
  assert.match(sgr.facts[0].text, /^Отменено \/ не выполнено: .*40/);
  assert.equal(sgr.facts[1].text, extraction().facts[1].text, 'an actual fact has no prefix');
  assert.deepEqual(sgr.facts.map(f => f.source), [['n1'], ['n2']]);
  assert.equal((sgr.sgr!.evidence[2] as { quote: string }).quote, 'Он сыграл 4.Nf3.');
  assert.deepEqual(parseMemory(result(plain()), nodes, 'plain', 'ru').facts.map(f => f.source), [['n1'], ['n2']]);
  const rows: [string, string, GenerationResult, object][] = [
    ['a fabricated quote', 'sgr', changed(extraction(), d => { d.evidence[0].quote = '30 повторов'; }), { memoryReason: 'quote', quoteOther: 1 }],
    ['a quote from a scene outside the increment', 'sgr', changed(extraction(), d => { d.evidence[0].scene = 'n999'; }), { memoryReason: 'evidence' }],
    ['two quotes under one id', 'sgr', changed(extraction(), d => { d.evidence[1].id = 'e1'; }), { memoryReason: 'evidence' }],
    ['a scene no fact covers', 'sgr', changed(extraction(), d => { d.facts.shift(); }), { memoryReason: 'coverage', sceneCount: 2, missingCount: 1 }],
    ['a conflict no fact resolves', 'sgr', changed(extraction(), d => { d.facts[1].evidence = ['e2']; }), { memoryReason: 'conflict' }],
    ['a fact citing an unknown quote', 'sgr', changed(extraction(), d => { d.facts[0].evidence = ['e999']; }), { memoryReason: 'fact' }],
    ['an unknown status', 'sgr', changed(extraction(), d => { d.facts[0].status = 'invented'; }), { memoryReason: 'fact' }],
    ['an unresolved conflict stated as a directive', 'sgr', changed(extraction(), d => { d.conflicts[0].resolution = 'unresolved'; }), { memoryReason: 'conflict' }],
    ['a field outside the schema', 'sgr', changed(extraction(), d => { (d.facts[0] as Record<string, unknown>).extra = true; }), { memoryReason: 'shape' }],
    // Where conflicts are checked, a null fact reads safely as one that resolves nothing.
    ['a null for the fact that resolves the conflict', 'sgr', changed(extraction(), d => { (d.facts as unknown[])[1] = null; }), { memoryReason: 'conflict' }],
    ['output cut off at its limit', 'sgr', { ...result(extraction()), finishReason: 'length' }, { memoryReason: 'output_limit' }],
    ['a fact citing a scene outside the increment', 'plain', changed(plain(), d => { d.facts[0].source = ['n999']; }), { memoryReason: 'source' }],
    ['a scene no fact covers', 'plain', changed(plain(), d => { d.facts.pop(); }), { memoryReason: 'coverage', sceneCount: 2, missingCount: 1 }],
    ['output cut off at its limit', 'plain', { ...result(plain()), finishReason: 'length' }, { memoryReason: 'output_limit' }],
  ];
  for (const [label, mode, output, details] of rows)
    assert.throws(() => parseMemory(output, nodes, mode, 'ru'), { code: 'invalid_memory', ...details }, `${mode}: ${label}`);
});

test('three SGR increments preserve checkpoints, exclude audit quotes from prompts and roll back invalid memory', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.mutate('synthetic', state => newStory(state, addSeed(state, 'Маяк\n2026-08-02 10:00\nСинтетическая история.').id));
  const config = { memoryMode: 'sgr' as const, maxOutputTokens: 4096, contextTokens: 65536, keepScenes: 4 };
  const checkpoints: Checkpoint[] = [];
  for (const count of [7, 4, 4]) {
    const job = store.mutate('synthetic', state => {
      for (let i = 0; i < count; i++) commitTurn(state, beginJob(state, '40 повторов отменены.', i).id, '2026-08-02 10:00\n\n' + 'Туман закрывает море. '.repeat(150));
      return beginJob(state, 'Дальше.', 100);
    });
    const oldNodes = structuredClone(active(store.read('synthetic')).story.nodes);
    const provider = { async generate(req: ModelRequest) {
      assert.equal(req.maxOutputTokens, 8192);
      const data: { previousMemory: { sgr?: unknown }[]; newScenes: { id: string; input: string }[] } = JSON.parse(req.messages[0].content);
      assert.ok(data.previousMemory.every(m => !m.sgr));
      const extracted = { evidence: data.newScenes.map((n, i) => ({ id: `e${i + 1}`, scene: n.id, part: 'input', quote: n.input })), conflicts: [],
        facts: data.newScenes.map((n, i) => ({ kind: 'event', at: '2026-08-02 10:00', status: 'cancelled', text: '40 повторов не выполнены.', evidence: [`e${i + 1}`] })) };
      return { ...result(extracted), usage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 } };
    } };
    await compactBranch({ store, userId: 'synthetic', jobId: job.id, provider, config });
    const after = store.read('synthetic');
    const { story, branch } = active(after);
    const chain = context(story, branch).memories;
    assert.deepEqual([chain.length, chain.at(-1)!.method, chain.at(-1)!.usage!.outputTokens], [checkpoints.length + 1, 'sgr', 300]);
    assert.deepEqual(story.nodes, oldNodes);
    assert.equal(context(story, branch).recent.length, 4);
    for (const [index, cp] of checkpoints.entries()) assert.equal(context(story, cp).memories.length, index + 1);
    checkpoints.push(Object.values(story.checkpoints).at(-1)!);
    assert.doesNotMatch(JSON.stringify(makeRequest(after, after.job!, 4096)), /"quote"|"conflicts"|"evidence"/);
    const next = summaryRequest(jobTarget(after, job.id)!, context(story, branch).recent, 'sgr');
    assert.equal(JSON.parse(next.messages[0].content).previousMemory.length, chain.length);
    store.mutate('synthetic', state => { state.job = null; });
  }
  const job = store.mutate('synthetic', state => {
    commitTurn(state, beginJob(state, 'Ещё сцена.', 1).id, '2026-08-02 10:00\n\nПоследняя сцена.');
    return beginJob(state, 'Дальше.', 2);
  });
  const before = store.read('synthetic');
  await assert.rejects(compactBranch({ store, userId: 'synthetic', jobId: job.id, config,
    provider: { generate: async () => result(extraction()) } }), { code: 'invalid_memory', memoryReason: 'evidence' });
  assert.deepEqual(store.read('synthetic'), before);
});
