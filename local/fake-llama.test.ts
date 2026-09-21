import test from 'node:test';
import assert from 'node:assert/strict';
import { startFakeLlama } from './fake-llama.ts';
import { createLlama } from './llama.ts';
import type { ModelRequest } from './model.ts';

// Synthetic prompts only: this server is rehearsal equipment and never sees a story.
const SYSTEM = 'Это синтетический замер. Начинай ответ с даты 2026-09-20 21:00 на отдельной строке.';
const request = (content: string): ModelRequest => ({ system: SYSTEM, maxOutputTokens: 256,
  messages: [{ role: 'user', content }] });
const provider = (baseUrl: string, slots: number, contextTokens = 8192) =>
  createLlama({ baseUrl, model: 'fake-llama', contextTokens }, { slots });

test('the fake server answers the endpoints the provider calls, and its count is the one it streams', async t => {
  const fake = await startFakeLlama({ model: 'fake-llama', slots: 2, contextTokens: 8192, outputTokens: 32 });
  t.after(() => fake.close());
  const llama = provider(fake.baseUrl, 2);
  assert.deepEqual(await llama.check(), { model: 'fake-llama', contextTokens: 8192, slots: 2 });

  const first = request('Синтетическая история. '.repeat(50));
  const counted = await llama.countInput(first);
  const cold = await llama.generate(first, { slot: 0 });
  assert.deepEqual([cold.usage!.inputTokens, cold.usage!.cachedInputTokens], [counted, 0]);
  assert.equal(cold.usage!.outputTokens, 32);
  // The measurer refuses an answer that does not open with the date it asked for; this one obeys.
  assert.match(cold.text, /^2026-09-20 21:00\n/);
  assert.deepEqual([cold.timings!.cacheTokens, cold.timings!.promptTokens, cold.timings!.predictedTokens], [0, counted, 32]);

  // The next call of the same slot re-reads the previous prompt: all of it but the last token is already there.
  const warm = await llama.generate({ ...first, messages: [...first.messages,
    { role: 'assistant', content: cold.text }, { role: 'user', content: 'Дальше.' }] }, { slot: 0 });
  const reused = warm.usage!.cachedInputTokens!;
  assert.ok(reused >= counted - 1, `cached ${reused} of ${counted}`);
  assert.ok(reused < warm.usage!.inputTokens!, 'the last token of a prompt is always read again');
  // Another slot holds another prompt; the caches do not mix.
  const other = await llama.generate(request('Другая история. '.repeat(50)), { slot: 1 });
  assert.equal(other.usage!.cachedInputTokens, 0);
  assert.deepEqual(fake.calls.map(call => call.slot), [0, 0, 1]);
  // Each prompt is counted once before it is generated, recorded here as the generations answered by then: the
  // count above, reused by its own generation, and one for each of the two requests that followed.
  assert.deepEqual(fake.counts, [0, 1, 2]);
});

test('a call that asks for no cache gets none, and a server told to keep none never reports any', async t => {
  const fake = await startFakeLlama({ slots: 1, contextTokens: 4096, outputTokens: 8 });
  const cacheless = await startFakeLlama({ slots: 1, contextTokens: 4096, outputTokens: 8, prefixCache: false });
  t.after(() => Promise.all([fake.close(), cacheless.close()]));
  const send = async (baseUrl: string, cachePrompt: boolean) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Синтетический запрос. '.repeat(20) }],
        max_tokens: 64, stream: false, cache_prompt: cachePrompt }) });
    return await response.json() as { choices: { message: { content: string } }[] };
  };
  await send(fake.baseUrl, true);
  await send(fake.baseUrl, true);
  await send(fake.baseUrl, false);
  assert.equal(fake.calls[0].cachedTokens, 0);
  assert.ok(fake.calls[1].cachedTokens > 0);
  assert.equal(fake.calls[2].cachedTokens, 0);
  await send(cacheless.baseUrl, true);
  await send(cacheless.baseUrl, true);
  assert.deepEqual(cacheless.calls.map(call => call.cachedTokens), [0, 0]);
});

test('a prompt too long for one chunk is decoded whole, so its cache does not break in the middle', async t => {
  const fake = await startFakeLlama({ model: 'fake-llama', slots: 1, contextTokens: 131072, outputTokens: 8 });
  t.after(() => fake.close());
  const llama = provider(fake.baseUrl, 1, 131072);
  // A tester's history is this long, and arrives in many chunks: a Russian character split across two of them
  // decodes as a replacement character, and the prompt stops matching the one the slot holds.
  const long = { ...request('В журнале маяка записано: ветер ровный, волна низкая.\n'.repeat(2500)), maxOutputTokens: 4096 };
  const counted = await llama.countInput(long);
  assert.ok(counted > 30000, `${counted} tokens`);
  await llama.generate(long);
  const again = await llama.generate(long);
  assert.equal(again.usage!.cachedInputTokens, counted - 1);
});

test('a slot serves one request at a time, so more callers than slots have to wait for one', async t => {
  // Two slots, and generation that takes real time: a third caller can only start once one of them is finished.
  const fake = await startFakeLlama({ slots: 2, contextTokens: 8192, outputTokens: 16,
    predictMsPerToken: 10, promptMsPerToken: 0, realTime: true });
  t.after(() => fake.close());
  const llama = provider(fake.baseUrl, 2);
  await Promise.all([0, 1, 2].map(index => llama.generate(request(`Синтетическая сцена ${index}. `.repeat(20)))));
  assert.equal(fake.calls.length, 3);
  // Two started at once and the third queued behind them; a server that answered everything immediately would
  // report no wait at all, and the thresholds about queueing and contention would pass on an idle rehearsal.
  const waits = fake.calls.map(call => call.queuedMs).sort((a, b) => a - b);
  assert.deepEqual(waits.slice(0, 2), [0, 0]);
  assert.ok(waits[2] >= 100, `the third call waited ${waits[2]} ms`);
  assert.deepEqual([...new Set(fake.calls.map(call => call.slot))].sort(), [0, 1]);
});

test('a slot freed for a caller that asked for it by number wakes that caller, not whoever queued first', async t => {
  // The scheduler pins a call to a slot so that its prefix cache stays with its owner, so the fake must free a slot
  // for the caller that asked for that slot. Waking one waiter only would let a waiter for another slot swallow it.
  const fake = await startFakeLlama({ slots: 2, contextTokens: 8192, outputTokens: 400,
    predictMsPerToken: 5, promptMsPerToken: 0, realTime: true });
  t.after(() => fake.close());
  const ended: string[] = [];
  const send = (slot: number, name: string, tokens: number) =>
    fetch(`${fake.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: `Синтетический запрос ${name}. ` }],
        max_tokens: tokens, stream: false, id_slot: slot }) }).then(async response => {
      await response.json();
      ended.push(name);
    });
  // Slot 0 is held for two seconds and slot 1 for a moment; then one caller waits for each of them.
  const running = [send(0, 'long', 400), send(1, 'short', 8)];
  await new Promise(resolve => setTimeout(resolve, 20));
  running.push(send(0, 'after-long', 8));
  await new Promise(resolve => setTimeout(resolve, 5));
  running.push(send(1, 'after-short', 8));
  await Promise.all(running);
  // The caller of slot 1 is served as soon as the short call frees it, without waiting for the long one on slot 0.
  assert.deepEqual(ended, ['short', 'after-short', 'long', 'after-long']);
  const queued = new Map(fake.calls.map(call => [call.slot, call.queuedMs]));
  assert.ok(queued.get(1)! < 1000, `the caller of slot 1 waited ${queued.get(1)} ms`);
});

test('a request that asks for a schema is answered in that schema, so a compaction can be rehearsed', async t => {
  const fake = await startFakeLlama({ slots: 1, contextTokens: 8192, outputTokens: 64 });
  t.after(() => fake.close());
  const llama = provider(fake.baseUrl, 1);
  // The shape of the bot's memory request: the scenes a fact may cite are listed in the schema itself.
  const schema = { type: 'object', required: ['facts'], additionalProperties: false, properties: {
    facts: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object',
      required: ['kind', 'at', 'text', 'source'], additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['event', 'state'] },
        at: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        source: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: ['n1', 'n2', 'n3'] } },
      } } } } };
  const answer = await llama.generate({ ...request('Синтетическая история. '), outputSchema: schema, purpose: 'memory' });
  assert.equal(answer.finishReason, 'stop');
  const parsed = JSON.parse(answer.text) as { facts: { kind: string; at: string; text: string; source: string[] }[] };
  assert.equal(parsed.facts.length, 1);
  assert.equal(parsed.facts[0].kind, 'event');
  assert.ok(parsed.facts[0].at.length > 0 && parsed.facts[0].text.length > 0);
  // Every scene the schema allows is cited: a memory that left one out would be refused for missing coverage.
  assert.deepEqual(parsed.facts[0].source, ['n1', 'n2', 'n3']);
  assert.equal(answer.usage!.outputTokens, Math.ceil(answer.text.length / 4));
});

test('several samples of one prompt read it once, as the research batches ask for them', async t => {
  const fake = await startFakeLlama({ model: 'fake-llama', slots: 4, contextTokens: 4096, outputTokens: 8 });
  t.after(() => fake.close());
  const answers = await provider(fake.baseUrl, 4).generateMany(request('Синтетический сид.'), 3);
  assert.equal(answers.length, 3);
  assert.equal(fake.calls.length, 1);
  assert.equal(answers[0].finishReason, 'stop');
});
