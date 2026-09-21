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

test('several samples of one prompt read it once, as the research batches ask for them', async t => {
  const fake = await startFakeLlama({ model: 'fake-llama', slots: 4, contextTokens: 4096, outputTokens: 8 });
  t.after(() => fake.close());
  const answers = await provider(fake.baseUrl, 4).generateMany(request('Синтетический сид.'), 3);
  assert.equal(answers.length, 3);
  assert.equal(fake.calls.length, 1);
  assert.equal(answers[0].finishReason, 'stop');
});
