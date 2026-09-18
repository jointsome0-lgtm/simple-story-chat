import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, addSeed, newStory, beginJob, commitTurn, commitMemory, saveCheckpoint, fork } from '../lib/library.ts';
import type { Fact } from '../lib/library.ts';
import { contextStats, requestBudget, requestStamp, CONTINUE } from './context.ts';
import { contextParts, makeRequest } from './prompt.ts';

const config = { model: 'test-model', contextTokens: 65536, maxOutputTokens: 4096 };
function fixture() {
  const state = emptyLibrary();
  const seed = addSeed(state, 'Маяк\n2026-08-02 20:00\nСинтетический остров и смотритель.');
  const { story, branch } = newStory(state, seed.id);
  const turns = [];
  for (let i = 1; i <= 3; i++) {
    const job = beginJob(state, `Ввод ${i}.`, i);
    // The job was just begun, so the turn commits.
    const ref = commitTurn(state, job.id, `2026-08-02 20:00\n\nСцена ${i}: ${'лодка '.repeat(i * 10)}`)!;
    story.nodes[ref.nodeId].usage = { inputTokens: i * 100, outputTokens: i * 30, totalTokens: i * 130 };
    turns.push({ ...ref, checkpointId: saveCheckpoint(state, story, branch, `Сцена ${i}`, 'scene').id });
  }
  return { state, story, branch, turns };
}

test('checkpoint size is scoped to its past, and a fork restores the same prefix and tail', () => {
  const { state, story, turns } = fixture();
  const selected = contextStats(state, config, { storyId: story.id, checkpointId: turns[0].checkpointId });
  const current = contextStats(state, config);
  assert.equal(selected.tail.count, 1);
  assert.equal(current.tail.count, 3);
  assert.ok(selected.snapshot.bytes < current.snapshot.bytes);
  assert.equal(selected.memory.count, 0);
  assert.equal(selected.prefix.bytes, selected.seed.bytes);
  assert.deepEqual(selected.lastRequest, { inputTokens: 100, outputTokens: 30, totalTokens: 130 });
  fork(state, story.id, turns[0].checkpointId);
  const forked = contextStats(state, config);
  assert.deepEqual(forked.snapshot, selected.snapshot);
  assert.deepEqual(forked.prefix, selected.prefix);
  assert.equal(forked.request.bytes, selected.request.bytes);
});

test('world clock follows the selected checkpoint and does not change the cacheable system prefix', () => {
  const { state, story, branch, turns } = fixture();
  for (const [i, time] of ['2026-08-02 20:01', '2026-08-03 08:00', '2026-08-05 17:00'].entries()) {
    const node = story.nodes[turns[i].nodeId];
    node.time = time;
    node.text = time + '\n\nСинтетическая сцена.';
  }
  const checkpoint = story.checkpoints[turns[0].checkpointId];
  const past = makeRequest(state, { storyId: story.id, ...checkpoint, input: '20:08. Продолжай.' }, 4096);
  const current = makeRequest(state, { storyId: story.id, ...branch, input: 'Продолжай.' }, 4096);
  assert.match(past.messages.at(-1)!.content, /2026-08-02 20:01/);
  // The narrator's rule closes the request, after the author's message, where the model follows it.
  assert.match(past.messages.at(-1)!.content, /20:08\. Продолжай\.\n\nПравило рассказчика: [^\n]+$/);
  assert.doesNotMatch(JSON.stringify(past.messages), /2026-08-05/);
  assert.match(current.messages.at(-1)!.content, /2026-08-05 17:00/);
  assert.equal(past.system, current.system);
});

test('prefix includes only the checkpoint memory chain and separates unsummarized scenes', () => {
  const { state, story, branch, turns } = fixture();
  const job = beginJob(state, 'После сжатия.', 4);
  // Partial facts: these checks only look for their text.
  commitMemory(state, job.id, turns.slice(0, 2).map(t => t.nodeId), { facts: [{ text: 'Память о двух сценах.' } as Fact] });
  const checkpoint = Object.values(story.checkpoints).at(-1)!;
  const selected = { storyId: story.id, checkpointId: checkpoint.id };
  const before = contextStats(state, config, selected);
  assert.equal(before.memory.count, 1);
  assert.ok(before.memory.bytes > 0);
  assert.equal(before.prefix.bytes, before.seed.bytes + before.memory.bytes);
  assert.equal(before.tail.count, 1);
  assert.equal(before.snapshot.bytes, before.prefix.bytes + before.tail.bytes);
  commitMemory(state, job.id, [turns[2].nodeId], { facts: [{ text: 'Будущий инкремент не относится к старой точке.' } as Fact] });
  assert.deepEqual(contextStats(state, config, selected), before);
  assert.equal(contextStats(state, config).memory.count, 2);
  const request = makeRequest(state, { storyId: story.id, ...checkpoint, input: CONTINUE }, 4096);
  assert.match(JSON.stringify(request), /Память о двух сценах/);
  assert.doesNotMatch(JSON.stringify(request), /Будущий инкремент/);
  assert.equal(branch.memory, Object.keys(story.memories).at(-1));
});

test('serialized sizes match the request and token budgets include the reply reserve', () => {
  const { state, story, branch } = fixture();
  const point = { storyId: story.id, head: branch.head, memory: branch.memory, input: CONTINUE };
  const request = makeRequest(state, point, config.maxOutputTokens);
  const budget = requestBudget(request, config.contextTokens);
  const measured = contextStats(state, config);
  assert.equal(measured.request.bytes, Buffer.byteLength(request.system + JSON.stringify({ messages: request.messages }), 'utf8'));
  assert.equal(measured.budget.limitTokens, 61440);
  assert.equal(measured.request.bytes, budget.inputBytes);
  assert.equal(measured.compaction.thresholdTokens, 54000);
  const parts = contextParts(state, point);
  assert.equal(measured.seed.bytes, Buffer.byteLength(JSON.stringify(parts.seed), 'utf8'));
  assert.doesNotMatch(JSON.stringify(request), /inputTokens|outputTokens|estimatedTokens/);
});

test('memory text preserves exact facts and provenance without changing the stored JSON', () => {
  const { state, story, branch, turns } = fixture();
  const job = beginJob(state, 'После сжатия.', 4);
  const facts = [
    { kind: 'event', at: '2026-08-02 20:03', text: 'Ада потратила 2 заряда: 6 → 4. Повтор через 90 с.', source: [turns[0].nodeId] },
    { kind: 'knowledge', at: '2026-08-02 20:05', text: 'В 20:05 Борис узнал о событии 20:03. Вариант 24.Rxd4 обсуждали, но не сыграли.', source: [turns[1].nodeId] },
    { kind: 'uncertainty', at: '2026-08-02 20:05', text: 'Местонахождение ключа неизвестно.', source: [turns[1].nodeId] },
  ];
  commitMemory(state, job.id, turns.slice(0, 2).map(t => t.nodeId), { facts });
  const saved = JSON.stringify(state);
  const { memory, tail } = contextParts(state, { storyId: story.id, ...branch });
  const text = memory[0].content;
  assert.doesNotMatch(text, /"facts"|"source"|"kind"/);
  for (const fact of facts) {
    assert.ok(text.includes(fact.at));
    assert.ok(text.includes(fact.text));
    for (const source of fact.source) assert.ok(text.includes(source));
  }
  assert.ok(text.indexOf(facts[0].text) < text.indexOf(facts[1].text));
  assert.match(text, /Неопределённость:/);
  assert.equal(tail.length, 2);
  assert.equal(JSON.stringify(state), saved);
});

test('input estimates use measured input only for the same model, rules and memory', () => {
  const { state, story, branch } = fixture();
  const point = { storyId: story.id, head: branch.head, memory: branch.memory, input: CONTINUE };
  const request = makeRequest(state, point, config.maxOutputTokens);
  story.nodes[branch.head!].requestContext = requestStamp(request, config.model, branch.memory);
  assert.equal(contextStats(state, config).request.estimatedTokens, 300);
  assert.equal(contextStats(state, config).request.estimateSource, 'usage');
  assert.equal(contextStats(state, { ...config, model: 'other-model' }).request.estimateSource, 'bytes');
  const job = beginJob(state, 'Дальше.', 4);
  commitMemory(state, job.id, [Object.keys(story.nodes)[0]], { facts: [{ text: 'Сжатая сцена.' } as Fact] });
  assert.equal(contextStats(state, config).request.estimateSource, 'bytes');
});

test('older checkpoints without usage remain unknown, and stale references are rejected', () => {
  const { state, story, turns } = fixture();
  delete story.nodes[turns[0].nodeId].usage;
  assert.equal(contextStats(state, config, { storyId: story.id, checkpointId: turns[0].checkpointId }).lastRequest, null);
  assert.throws(() => contextStats(state, config, { storyId: story.id, checkpointId: 'missing' }));
  assert.throws(() => contextStats(state, config, { storyId: '__proto__', checkpointId: 'constructor' }));
});
