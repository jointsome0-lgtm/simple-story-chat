import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SchedulerOptions } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import { createGpu } from './gpu.ts';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t: TestContext, options: SchedulerOptions = {}) {
  const calls: { name: string; finish: () => void; signal: AbortSignal }[] = [];
  // Requests are names, and each call resolves with its own name.
  const provider = { generate(request: string, { signal }: { signal: AbortSignal }) {
    return new Promise<string>((resolve, reject) => {
      const call = { name: request, finish: () => resolve(request), signal };
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      calls.push(call);
    });
  } };
  const scheduler = createScheduler(provider, { quietMs: 0, pollMs: 100000, ...options });
  t.after(() => scheduler.close());
  return { scheduler, calls };
}
test('foreground preempts background and remains FIFO without overlapping work', async t => {
  const f = fixture(t);
  const low = f.scheduler.background.generate('experiment');
  const rejected = assert.rejects(low, { code: 'background_preempted' });
  const first = f.scheduler.foreground.generate('user one');
  const second = f.scheduler.foreground.generate('user two');
  await rejected; await turn();
  assert.deepEqual(f.calls.map(c => c.name), ['experiment', 'user one']);
  f.calls[1].finish(); assert.equal(await first, 'user one'); await turn();
  assert.equal(f.calls[2].name, 'user two');
  f.calls[2].finish(); assert.equal(await second, 'user two');
});
test('quiet window starts after a foreground response; health checks do not reset it', async t => {
  let time = 0;
  const f = fixture(t, { now: () => time, quietMs: 60000 });
  const low = f.scheduler.background.generate('experiment');
  time = 59999; f.scheduler.tick(); assert.equal(f.calls.length, 0);
  const user = f.scheduler.foreground.generate('user');
  time = 70000; f.calls[0].finish(); await user; await turn();
  time = 129999; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  time = 130000; f.scheduler.tick(); assert.equal(f.calls[1].name, 'experiment');
  f.calls[1].finish(); await low;
});
test('paused or draining GPU cancels background and does not acquire or renew a user lease', async t => {
  let allowed = false;
  const f = fixture(t, { backgroundAllowed: () => allowed });
  const low = f.scheduler.background.generate('experiment');
  f.scheduler.tick(); assert.equal(f.calls.length, 0);
  const rejected = assert.rejects(low, { code: 'background_unavailable' });
  allowed = true; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  allowed = false; f.scheduler.tick(); await rejected;
});
test('cancelling a queued request removes it without invoking the provider', async t => {
  const f = fixture(t);
  const first = f.scheduler.foreground.generate('first');
  const controller = new AbortController();
  const pending = f.scheduler.foreground.generate('cancel me', { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  controller.abort(); await rejected;
  f.calls[0].finish(); await first; await turn();
  assert.deepEqual(f.calls.map(c => c.name), ['first']);
});
test('progress distinguishes queued from started and a cancelled queue entry never starts', async t => {
  const f = fixture(t);
  const first = f.scheduler.foreground.generate('first');
  const events: string[] = [];
  const controller = new AbortController();
  const next = f.scheduler.foreground.generate('next', { onQueued: () => events.push('queued'), onStart: () => events.push('started') });
  const cancelled = f.scheduler.foreground.generate('cancelled', { signal: controller.signal,
    onStart: () => assert.fail('cancelled request started') });
  const rejected = assert.rejects(cancelled, { code: 'cancelled' });
  assert.deepEqual(events, ['queued']);
  controller.abort(); await rejected;
  f.calls[0].finish(); await first; await turn();
  assert.deepEqual(events, ['queued', 'started']);
  f.calls[1].finish(); await next;
});
test('a completed background result is discarded if cancellation raced its completion', async t => {
  let finish: ((value: string) => void) | undefined;
  const scheduler = createScheduler({ generate: () => new Promise<string>(resolve => { finish = resolve; }) }, { quietMs: 0 });
  t.after(() => scheduler.close());
  const controller = new AbortController();
  const low = scheduler.background.generate('experiment', { signal: controller.signal });
  const rejected = assert.rejects(low, { code: 'cancelled' });
  controller.abort(); finish!('late response'); await rejected;
});
test('background timeout frees the slot and shutdown cancels both active and queued work', async t => {
  const f = fixture(t, { backgroundTimeoutMs: 10 });
  await assert.rejects(f.scheduler.background.generate('bounded'), { code: 'background_timeout' });
  const first = f.scheduler.foreground.generate('first');
  const queued = f.scheduler.foreground.generate('queued');
  const rejected = [assert.rejects(first, { code: 'cancelled' }), assert.rejects(queued, { code: 'cancelled' })];
  await f.scheduler.close(); await Promise.all(rejected);
  assert.deepEqual(f.calls.map(c => c.name), ['bounded', 'first']);
});
test('real GPU idle countdown expires even while background work is running', async t => {
  let time = 0;
  const stops: string[] = [];
  const gpu = createGpu({ now: () => time, idleMinutes: 15,
    api: { read: async () => ({ actual: 'running', intended: 'running' }), setState: async state => { stops.push(state); } },
    connection: { ensure: async () => {}, close() {} }, check: async () => {} });
  await gpu.tick();
  const f = fixture(t, { now: () => time, backgroundAllowed: () => {
    const state = gpu.snapshot();
    return state.status === 'ready' && state.activeJobs === 0 && (state.idleRemainingSeconds ?? 0) > 100;
  } });
  const low = f.scheduler.background.generate('experiment');
  const rejected = assert.rejects(low, { code: 'background_unavailable' });
  time = 801000; f.scheduler.tick(); await rejected;
  assert.equal(gpu.snapshot().activeJobs, 0);
  assert.equal(gpu.snapshot().idleRemainingSeconds, 99);
  time = 900000; await gpu.tick();
  assert.deepEqual(stops, ['stopped']);
});

test('a provider without a check gets none from the scheduler', async t => {
  const bare = createScheduler({ generate: async () => 'done' });
  t.after(() => bare.close());
  assert.equal('check' in bare.foreground, false);
  const server = createScheduler({ generate: async () => 'done', check: async () => ({ model: 'test-model' }) });
  t.after(() => server.close());
  assert.deepEqual(await server.foreground.check!(), { model: 'test-model' });
});
test('an agent call waits for people and the quiet window, then runs to its end while a person waits', async t => {
  let time = 0;
  const f = fixture(t, { now: () => time, quietMs: 60000 });
  const user = f.scheduler.foreground.generate('user one');
  const agent = f.scheduler.agent.generate('agent turn');
  time = 1000; f.calls[0].finish(); await user; await turn();
  time = 60999; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  time = 61000; f.scheduler.tick(); assert.equal(f.calls[1].name, 'agent turn');
  // A person arrives mid-call: the agent call is not aborted, the person is next.
  const next = f.scheduler.foreground.generate('user two');
  await turn();
  assert.equal(f.calls[1].signal.aborted, false);
  assert.equal(f.calls.length, 2);
  f.calls[1].finish(); assert.equal(await agent, 'agent turn'); await turn();
  assert.equal(f.calls[2].name, 'user two');
  f.calls[2].finish(); await next;
});
test('an agent call preempts a probe, starts only when allowed and stops only when it may not run', async t => {
  let start = false, run = true;
  const f = fixture(t, { agentCanStart: () => start, agentCanRun: () => run });
  const probe = f.scheduler.background.generate('probe');
  const preempted = assert.rejects(probe, { code: 'background_preempted' });
  const agent = f.scheduler.agent.generate('agent turn');
  await preempted; await turn();
  assert.deepEqual(f.calls.map(c => c.name), ['probe']);
  start = true; f.scheduler.tick(); assert.equal(f.calls[1].name, 'agent turn');
  // The start rule turning false (the idle countdown running down) does not stop a running call; a pause does.
  start = false; f.scheduler.tick(); assert.equal(f.calls[1].signal.aborted, false);
  const stopped = assert.rejects(agent, { code: 'background_unavailable' });
  run = false; f.scheduler.tick(); await stopped;
});
test('a turn keeps the slot from its first call until it ends, however long it pauses between calls', async t => {
  let time = 0;
  const f = fixture(t, { now: () => time });
  const owner = f.scheduler.foreground.openTurn();
  const first = owner.generate('owner compaction');
  const tester = f.scheduler.foreground.generate('tester');
  f.calls[0].finish(); await first; await turn();
  // Local work between the steps takes its time; nobody takes the slot meanwhile.
  time = 30000; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  const scene = owner.generate('owner scene');
  await turn();
  assert.equal(f.calls[1].name, 'owner scene');
  f.calls[1].finish(); await scene; await turn();
  assert.equal(f.calls.length, 2);
  owner.end(); await turn();
  assert.equal(f.calls[2].name, 'tester');
  f.calls[2].finish(); await tester;
  // An ended turn takes no more calls.
  await assert.rejects(owner.generate('late'), { code: 'cancelled' });
});
test('an agent turn continues past the quiet window and holds the GPU until it ends', async t => {
  let time = 0, start = true, holds = 0, released = 0;
  const f = fixture(t, { now: () => time, quietMs: 60000, agentCanStart: () => start,
    holdAgentTurn: () => { holds++; return () => { released++; }; } });
  time = 60000;
  const agentTurn = f.scheduler.agent.openTurn();
  // Opening a turn reserves nothing; the first call's actual start does.
  assert.equal(holds, 0);
  const compaction = agentTurn.generate('agent compaction');
  assert.equal(f.calls[0].name, 'agent compaction');
  // A person arrives: the quiet window restarts and the start rule turns false, yet the turn's next call goes first.
  const user = f.scheduler.foreground.generate('user');
  start = false;
  f.calls[0].finish(); await compaction; await turn();
  const scene = agentTurn.generate('agent scene');
  await turn();
  assert.deepEqual(f.calls.map(c => c.name), ['agent compaction', 'agent scene']);
  f.calls[1].finish(); await scene; await turn();
  assert.deepEqual([holds, released], [1, 0]);
  agentTurn.end(); await turn();
  assert.deepEqual([holds, released], [1, 1]);
  assert.equal(f.calls[2].name, 'user');
  f.calls[2].finish(); await user;
});
test('ending a turn between its calls frees the slot at once; ending it during a call stops the call', async t => {
  const f = fixture(t);
  const owner = f.scheduler.foreground.openTurn();
  const first = owner.generate('owner');
  f.calls[0].finish(); await first; await turn();
  const tester = f.scheduler.foreground.generate('tester');
  await turn(); assert.equal(f.calls.length, 1);
  owner.end(); await turn();
  assert.equal(f.calls[1].name, 'tester');
  f.calls[1].finish(); await tester;
  // A lost owner: its running call is stopped and the slot is free.
  const lost = f.scheduler.agent.openTurn();
  const running = lost.generate('agent');
  const stopped = assert.rejects(running, { code: 'cancelled' });
  lost.end(); await stopped;
});
test('a turn that holds the slot without calls for too long is taken as lost', async t => {
  let time = 0;
  const events: string[] = [];
  const f = fixture(t, { now: () => time, turnIdleMs: 60000, log: event => { events.push(event); } });
  const owner = f.scheduler.foreground.openTurn();
  const first = owner.generate('owner');
  f.calls[0].finish(); await first; await turn();
  const tester = f.scheduler.foreground.generate('tester');
  time = 59999; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  time = 60000; f.scheduler.tick(); await turn();
  assert.equal(f.calls[1].name, 'tester');
  assert.ok(events.includes('turn_lost'));
  await assert.rejects(owner.generate('late'), { code: 'cancelled' });
  f.calls[1].finish(); await tester;
});
test('a pausing GPU ends waiting agent calls instead of leaving them queued', async t => {
  let run = true;
  const f = fixture(t, { agentCanStart: () => false, agentCanRun: () => run });
  const waiting = f.scheduler.agent.generate('agent turn');
  const rejected = assert.rejects(waiting, { code: 'background_unavailable' });
  run = false; f.scheduler.tick(); await rejected;
  assert.equal(f.calls.length, 0);
});
