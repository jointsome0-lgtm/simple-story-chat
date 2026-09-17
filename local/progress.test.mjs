import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from './progress.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const render = progress => ({ text: JSON.stringify(progress) });

test('progress coalesces streaming updates, serializes edits and finishes on the same message', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const writes = [];
  let release;
  const progress = createProgress({ render, chat: {
    send: screen => { writes.push(['send', screen]); return new Promise(resolve => { release = () => resolve({ message_id: 42 }); }); },
    edit: async (id, screen) => { assert.equal(id, 42); writes.push(['edit', screen]); },
  } });
  progress.update({ stage: 'queued' }); await turn();
  for (let i = 0; i < 500; i++) progress.update({ stage: 'extracting', outputCharacters: i });
  t.mock.timers.tick(20000); await turn();
  assert.equal(writes.length, 1, 'stream and timer cannot overlap a pending send');
  const finished = progress.finish({ stage: 'done', facts: 3 });
  release(); assert.equal(await finished, true);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1][1].text).stage, 'done');
  t.mock.timers.tick(20000); progress.update({ stage: 'extracting' }); await turn();
  assert.equal(writes.length, 2, 'no edits after completion');
});

test('elapsed time updates while no model text arrives and cancellation blocks late progress', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100 });
  const writes = [];
  const controller = new AbortController();
  const progress = createProgress({ render, signal: controller.signal, chat: {
    send: async screen => { writes.push(screen); return { message_id: 1 }; },
    edit: async (id, screen) => { writes.push(screen); },
  } });
  progress.update({ stage: 'queued' }); await turn();
  t.mock.timers.tick(5000); await turn();
  assert.equal(JSON.parse(writes.at(-1).text).elapsedMs, 5000);
  controller.abort(); await progress.finish();
  progress.update({ stage: 'done' }); t.mock.timers.tick(10000); await turn();
  assert.equal(JSON.parse(writes.at(-1).text).stage, 'cancelled');
});

test('an uncertain initial Telegram send is not repeated and cannot fail the model job', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  let attempts = 0;
  const logs = [];
  const progress = createProgress({ render, log: (...args) => logs.push(args), chat: {
    send: async () => { attempts++; throw Object.assign(new Error('PRIVATE'), { code: 'network' }); },
    edit: async () => assert.fail('no known message to edit'),
  } });
  progress.update({ stage: 'queued' }); await turn();
  t.mock.timers.tick(30000); await turn();
  assert.equal(await progress.finish({ stage: 'done' }), false);
  assert.equal(attempts, 1);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});

test('cancelling subsequent scene generation does not relabel already committed memory as cancelled', async () => {
  const writes = [];
  const controller = new AbortController();
  const progress = createProgress({ render, signal: controller.signal, chat: {
    send: async screen => { writes.push(screen); return { message_id: 1 }; },
    edit: async (id, screen) => { writes.push(screen); },
  } });
  progress.update({ stage: 'done', facts: 2 }); await turn();
  controller.abort(); await progress.finish();
  assert.equal(JSON.parse(writes.at(-1).text).stage, 'done');
});
