import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLibrary, addSeed, newStory, beginJob, commitTurn, commitMemory, saveCheckpoint, fork } from '../lib/library.ts';
import type { Fact } from '../lib/library.ts';
import { contextStats, estimateTokens, requestBudget, requestStamp, continueInput } from './context.ts';
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

// A checkpoint's request, its sizes and a fork from it are built from its past alone, whatever came after it.
test('a checkpoint sees only its own past: its clock, its memory chain and its scenes, under the same system prefix', () => {
  const { state, story, branch, turns } = fixture();
  for (const [i, time] of ['2026-08-02 20:01', '2026-08-03 08:00', '2026-08-05 17:00'].entries())
    Object.assign(story.nodes[turns[i].nodeId], { time, text: time + '\n\nСинтетическая сцена.' });
  const first = { storyId: story.id, checkpointId: turns[0].checkpointId };
  const past = makeRequest(state, { storyId: story.id, ...story.checkpoints[first.checkpointId], input: '20:08. Продолжай.' }, 4096);
  const current = makeRequest(state, { storyId: story.id, ...branch, input: 'Продолжай.' }, 4096);
  assert.match(past.messages.at(-1)!.content, /2026-08-02 20:01/);
  // The narrator's rule closes the request, after the author's message, where the model follows it.
  assert.match(past.messages.at(-1)!.content, /20:08\. Продолжай\.\n\nПравило рассказчика: [^\n]+$/);
  assert.doesNotMatch(JSON.stringify(past.messages), /2026-08-05/);
  assert.match(current.messages.at(-1)!.content, /2026-08-05 17:00/);
  assert.equal(past.system, current.system);
  const scoped = contextStats(state, config, first);
  assert.deepEqual([scoped.tail.count, contextStats(state, config).tail.count, scoped.memory.count], [1, 3, 0]);
  assert.equal(scoped.prefix.bytes, scoped.seed.bytes);
  const job = beginJob(state, 'После сжатия.', 4);
  // Partial facts: these checks only look for their text.
  commitMemory(state, job.id, turns.slice(0, 2).map(t => t.nodeId), { facts: [{ text: 'Память о двух сценах.' } as Fact] });
  const checkpoint = Object.values(story.checkpoints).at(-1)!;
  const selected = { storyId: story.id, checkpointId: checkpoint.id };
  const before = contextStats(state, config, selected);
  assert.deepEqual([before.memory.count, before.tail.count], [1, 1]);
  assert.ok(before.memory.bytes > 0);
  assert.equal(before.prefix.bytes, before.seed.bytes + before.memory.bytes);
  assert.equal(before.snapshot.bytes, before.prefix.bytes + before.tail.bytes);
  commitMemory(state, job.id, [turns[2].nodeId], { facts: [{ text: 'Будущий инкремент не относится к старой точке.' } as Fact] });
  assert.deepEqual(contextStats(state, config, selected), before);
  assert.equal(contextStats(state, config).memory.count, 2);
  const request = makeRequest(state, { storyId: story.id, ...checkpoint, input: continueInput(state, story.id) }, 4096);
  assert.match(JSON.stringify(request), /Память о двух сценах/);
  assert.doesNotMatch(JSON.stringify(request), /Будущий инкремент/);
  assert.equal(branch.memory, Object.keys(story.memories).at(-1));
  // A fork from the first scene, after both increments, restores that scene's prefix and tail.
  fork(state, story.id, first.checkpointId);
  const forked = contextStats(state, config);
  assert.deepEqual([forked.snapshot, forked.prefix, forked.request.bytes], [scoped.snapshot, scoped.prefix, scoped.request.bytes]);
  // A checkpoint that is gone, or a name the prototype has, selects nothing.
  assert.throws(() => contextStats(state, config, { storyId: story.id, checkpointId: 'missing' }));
  assert.throws(() => contextStats(state, config, { storyId: '__proto__', checkpointId: 'constructor' }));
});

test('sizes match the request, the budget keeps the reply reserve, and measured input counts only for the same model, rules and memory', () => {
  const { state, story, branch, turns } = fixture();
  const point = { storyId: story.id, head: branch.head, memory: branch.memory, input: continueInput(state, story.id) };
  const request = makeRequest(state, point, config.maxOutputTokens);
  const measured = contextStats(state, config);
  assert.equal(measured.request.bytes, Buffer.byteLength(request.system + JSON.stringify({ messages: request.messages }), 'utf8'));
  assert.equal(measured.request.bytes, requestBudget(request, config.contextTokens).inputBytes);
  assert.deepEqual([measured.budget.limitTokens, measured.compaction.thresholdTokens], [61440, 54000]);
  assert.equal(measured.seed.bytes, Buffer.byteLength(JSON.stringify(contextParts(state, point).seed), 'utf8'));
  assert.doesNotMatch(JSON.stringify(request), /inputTokens|outputTokens|estimatedTokens/);
  story.nodes[branch.head!].requestContext = requestStamp(request, config.model, branch.memory);
  assert.deepEqual([contextStats(state, config).request.estimatedTokens, contextStats(state, config).request.estimateSource], [300, 'usage']);
  assert.equal(contextStats(state, { ...config, model: 'other-model' }).request.estimateSource, 'bytes');
  commitMemory(state, beginJob(state, 'Дальше.', 4).id, [Object.keys(story.nodes)[0]], { facts: [{ text: 'Сжатая сцена.' } as Fact] });
  assert.equal(contextStats(state, config).request.estimateSource, 'bytes');
  // A checkpoint shows the usage its scene measured, and nothing where none was measured.
  const first = { storyId: story.id, checkpointId: turns[0].checkpointId };
  assert.deepEqual(contextStats(state, config, first).lastRequest, { inputTokens: 100, outputTokens: 30, totalTokens: 130 });
  delete story.nodes[turns[0].nodeId].usage;
  assert.equal(contextStats(state, config, first).lastRequest, null);
});

test('memory text keeps exact facts and their sources, and a Han or kana character counts as a token', () => {
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
  for (const fact of facts) for (const part of [fact.at, fact.text, ...fact.source]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf(facts[0].text) < text.indexOf(facts[1].text));
  assert.match(text, /Неопределённость:/);
  assert.equal(tail.length, 2);
  assert.equal(JSON.stringify(state), saved);
  const bytes = (value: string) => Math.ceil(Buffer.byteLength(value, 'utf8') / 4);
  // Latin, Cyrillic and Hangul already fit under four bytes per token; Han and kana do not, and count about one each.
  for (const sample of ['The keeper lit the lamp in the tower.', 'Смотритель зажёг лампу на башне.', '등대의 관리인이 등을 켰다.'])
    assert.equal(estimateTokens(sample), bytes(sample), sample);
  assert.deepEqual(['守塔人点亮了灯', '守り手はランプをつけた'].map(estimateTokens), [7, 11]);
  // A Chinese story of the size at which the bot compacts is no longer estimated a fifth short.
  const scene = '守塔人点亮了灯，海湾里的水静止不动。'.repeat(200);
  assert.ok(estimateTokens(scene) > bytes(scene) * 1.3);
});
