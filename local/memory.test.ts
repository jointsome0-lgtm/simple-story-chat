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
const result = (data: unknown): GenerationResult => ({ text: JSON.stringify(data), finishReason: 'stop' });
test('SGR keeps cancelled quantities, resolves sources mechanically and stores evidence separately', () => {
  const parsed = parseMemory(result(extraction()), nodes, 'sgr', 'ru');
  assert.match(parsed.facts[0].text, /^Отменено \/ не выполнено: .*40/);
  assert.deepEqual(parsed.facts.map(f => f.source), [['n1'], ['n2']]);
  assert.equal((parsed.sgr!.evidence[2] as { quote: string }).quote, 'Он сыграл 4.Nf3.');
});
test('SGR rejects fabricated quotes, missing scene coverage, ignored conflicts, bad references and partial output', () => {
  // Mutations deliberately break the extraction's shape.
  const mutations: ((d: ReturnType<typeof extraction>) => void)[] = [
    d => { d.evidence[0].quote = '30 повторов'; },
    d => { d.evidence[0].scene = 'n999'; },
    d => { d.evidence[1].id = 'e1'; },
    d => { d.facts.shift(); },
    d => { d.facts[1].evidence = ['e2']; },
    d => { d.facts[0].evidence = ['e999']; },
    d => { d.facts[0].status = 'invented'; },
    d => { d.conflicts[0].resolution = 'unresolved'; },
    d => { (d.facts[0] as Record<string, unknown>).extra = true; },
    d => { (d.facts as unknown[])[1] = null; },
  ];
  for (const mutate of mutations) {
    const data = extraction(); mutate(data);
    assert.throws(() => parseMemory(result(data), nodes, 'sgr', 'ru'), { code: 'invalid_memory' });
  }
  assert.throws(() => parseMemory({ ...result(extraction()), finishReason: 'length' }, nodes, 'sgr', 'ru'), { code: 'invalid_memory' });
});
test('three SGR increments preserve checkpoints, exclude audit quotes from prompts and roll back invalid memory', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.mutate('synthetic', state => newStory(state, addSeed(state, 'Маяк\n2026-08-02 10:00\nСинтетическая история.').id));
  const config = { memoryMode: 'sgr' as const, maxOutputTokens: 4096, contextTokens: 65536, keepScenes: 4 };
  const checkpoints: Checkpoint[] = [];
  for (const count of [7, 4, 4]) {
    const job = store.mutate('synthetic', state => {
      for (let i = 0; i < count; i++) {
        const j = beginJob(state, '40 повторов отменены.', i);
        commitTurn(state, j.id, '2026-08-02 10:00\n\n' + 'Туман закрывает море. '.repeat(150));
      }
      return beginJob(state, 'Дальше.', 100);
    });
    const before = store.read('synthetic');
    const oldNodes = structuredClone(active(before).story.nodes);
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
    assert.equal(chain.length, checkpoints.length + 1);
    assert.equal(chain.at(-1)!.method, 'sgr');
    assert.equal(chain.at(-1)!.usage!.outputTokens, 300);
    assert.deepEqual(story.nodes, oldNodes);
    assert.equal(context(story, branch).recent.length, 4);
    for (const [index, cp] of checkpoints.entries()) assert.equal(context(story, cp).memories.length, index + 1);
    checkpoints.push(Object.values(story.checkpoints).at(-1)!);
    const prompt = makeRequest(after, after.job!, 4096);
    assert.doesNotMatch(JSON.stringify(prompt), /"quote"|"conflicts"|"evidence"/);
    const next = summaryRequest(jobTarget(after, job.id)!, context(story, branch).recent, 'sgr');
    assert.equal(JSON.parse(next.messages[0].content).previousMemory.length, chain.length);
    store.mutate('synthetic', state => { state.job = null; });
  }
  const job = store.mutate('synthetic', state => {
    const j = beginJob(state, 'Ещё сцена.', 1);
    commitTurn(state, j.id, '2026-08-02 10:00\n\nПоследняя сцена.');
    return beginJob(state, 'Дальше.', 2);
  });
  const before = store.read('synthetic');
  await assert.rejects(compactBranch({ store, userId: 'synthetic', jobId: job.id, config,
    provider: { generate: async () => result(extraction()) } }), { code: 'invalid_memory' });
  assert.deepEqual(store.read('synthetic'), before);
});
