import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from './progress.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { Screen } from './telegram.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
const render = (progress: CompactionStatus): Screen => ({ text: JSON.stringify(progress) });
const shown = (screen: Screen) => JSON.parse(screen.text) as CompactionStatus & { elapsedMs: number };

// One message: nothing overlaps a pending send, the end edits it, nothing follows; an uncertain first send is final.
test('progress coalesces streaming updates, serializes edits and finishes on the same message', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const writes: [string, Screen][] = [];
  let release = (): void => assert.fail('send was not called');
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
  assert.deepEqual(writes.map(([kind, screen]) => [kind, shown(screen).stage]), [['send', 'queued'], ['edit', 'done']]);
  t.mock.timers.tick(20000); progress.update({ stage: 'extracting' }); await turn();
  assert.equal(writes.length, 2, 'no edits after completion');
  let attempts = 0; const logs: unknown[][] = [];
  const uncertain = createProgress({ render, log: (...args) => logs.push(args), chat: {
    send: async () => { attempts++; throw Object.assign(new Error('PRIVATE'), { code: 'network' }); },
    edit: async () => assert.fail('no known message to edit'),
  } });
  uncertain.update({ stage: 'queued' }); await turn(); t.mock.timers.tick(30000); await turn();
  assert.equal(await uncertain.finish({ stage: 'done' }), false, 'the failure does not fail the model job');
  assert.equal(attempts, 1, 'an uncertain first send is not repeated');
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});

// A cancel ends the status as cancelled and lets nothing in after it; a committed compaction stays done.
test('elapsed time updates while no model text arrives and cancellation blocks late progress', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100 });
  for (const [label, first, elapsedMs, last] of [['a cancel while the compaction runs', { stage: 'queued' }, 5000, 'cancelled'],
    ['a cancel of the scene after a committed compaction', { stage: 'done', facts: 2 }, 0, 'done']] as const) {
    const writes: Screen[] = [];
    const controller = new AbortController();
    const progress = createProgress({ render, signal: controller.signal, chat: {
      send: async screen => { writes.push(screen); return { message_id: 1 }; }, edit: async (_id, screen) => { writes.push(screen); } } });
    progress.update(first); await turn(); t.mock.timers.tick(5000); await turn();
    assert.equal(shown(writes.at(-1)!).elapsedMs, elapsedMs, label);
    controller.abort(); await progress.finish();
    progress.update({ stage: 'done' }); t.mock.timers.tick(10000); await turn();
    assert.equal(shown(writes.at(-1)!).stage, last, label);
  }
});
