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
  const agent = f.scheduler.agent.generate('agent call');
  time = 1000; f.calls[0].finish(); await user; await turn();
  time = 60999; f.scheduler.tick(); assert.equal(f.calls.length, 1);
  time = 61000; f.scheduler.tick(); assert.equal(f.calls[1].name, 'agent call');
  // A person arrives mid-call: the agent call is not aborted, the person is next.
  const waits: number[] = [];
  const next = f.scheduler.foreground.generate('user two', { onWait: ahead => { waits.push(ahead); } });
  await turn();
  assert.equal(f.calls[1].signal.aborted, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(waits, [1]);
  f.calls[1].finish(); assert.equal(await agent, 'agent call'); await turn();
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
test('an agent turn holds the slot and the GPU between its calls, and a person waits for its end', async t => {
  let time = 0, holds = 0, released = 0;
  const events: string[] = [];
  const f = fixture(t, { now: () => time, quietMs: 60000, log: event => { events.push(event); },
    holdAgentTurn: () => { holds++; return () => { released++; }; } });
  time = 60000;
  const agentTurn = f.scheduler.agent.openTurn();
  // Opening a turn reserves nothing; the first call's actual start does.
  assert.equal(holds, 0);
  const compaction = agentTurn.generate('agent compaction');
  assert.equal(f.calls[0].name, 'agent compaction');
  f.calls[0].finish(); await compaction; await turn();
  // Between the turn's calls a probe does not take the slot.
  const probe = f.scheduler.background.generate('probe');
  await turn(); assert.equal(f.calls.length, 1);
  const scene = agentTurn.generate('agent scene');
  await turn();
  assert.deepEqual(f.calls.map(c => c.name), ['agent compaction', 'agent scene']);
  assert.deepEqual([holds, released], [1, 0]);
  // A person arrives: the quiet window restarts, yet the running call goes on and the turn keeps the slot.
  const user = f.scheduler.foreground.generate('user');
  await turn();
  assert.equal(f.calls[1].signal.aborted, false);
  f.calls[1].finish(); await scene; await turn();
  assert.equal(f.calls.length, 2);
  agentTurn.end(); await turn();
  assert.deepEqual([holds, released], [1, 1]);
  assert.equal(f.calls[2].name, 'user');
  assert.equal(events.filter(event => event === 'background_preempted').length, 0);
  // The probe stays behind the person.
  f.calls[2].finish(); await user;
  time = 200000; f.scheduler.tick(); await turn();
  assert.equal(f.calls[3].name, 'probe');
  f.calls[3].finish(); await probe;
});
test('a person waits for an agent turn that is between its calls', async t => {
  const f = fixture(t);
  const agentTurn = f.scheduler.agent.openTurn();
  const first = agentTurn.generate('agent compaction');
  f.calls[0].finish(); await first; await turn();
  const user = f.scheduler.foreground.generate('user');
  await turn();
  assert.equal(f.calls.length, 1);
  const scene = agentTurn.generate('agent scene');
  await turn();
  assert.equal(f.calls[1].name, 'agent scene');
  f.calls[1].finish(); await scene;
  agentTurn.end(); await turn();
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
  await assert.rejects(owner.generate('late'), { code: 'background_unavailable' });
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
test('a waiting call hears how many calls are ahead of it, each time the number changes', async t => {
  const f = fixture(t);
  const heard: Record<string, number[]> = { second: [], third: [] };
  const first = f.scheduler.foreground.generate('first');
  const second = f.scheduler.foreground.generate('second', { onWait: ahead => { heard.second.push(ahead); } });
  const third = f.scheduler.foreground.generate('third', { onWait: ahead => { heard.third.push(ahead); } });
  assert.deepEqual(heard, { second: [1], third: [2] });
  f.calls[0].finish(); await first; await turn();
  assert.deepEqual(heard, { second: [1], third: [2, 1] });
  f.calls[1].finish(); await second; await turn();
  f.calls[2].finish(); await third; await turn();
  // A turn's own next call goes first while the turn holds the slot, whoever else waits.
  const owner = f.scheduler.foreground.openTurn();
  const step = owner.generate('owner step');
  const other = f.scheduler.foreground.generate('other', { onWait: () => {} });
  f.calls[3].finish(); await step; await turn();
  const own: number[] = [];
  const next = owner.generate('owner next', { onWait: ahead => { own.push(ahead); } });
  await turn();
  assert.deepEqual(own, []);
  f.calls[4].finish(); await next;
  owner.end(); await turn();
  f.calls[5].finish(); await other;
});
test('a yielding turn ends when anybody but its holder calls, and its holder waits for it', async t => {
  const f = fixture(t);
  const prepared = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true });
  const first = prepared.generate('prepared extraction');
  // Its holder's own turn waits behind it.
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const count = tester.generate('tester count');
  await turn();
  assert.equal(f.calls[0].signal.aborted, false);
  f.calls[0].finish(); await first; await turn();
  const repair = prepared.generate('prepared repair');
  await turn();
  assert.deepEqual(f.calls.map(call => call.name), ['prepared extraction', 'prepared repair']);
  // Another person's call ends it at once.
  const stopped = assert.rejects(repair, { code: 'background_preempted' });
  const owner = f.scheduler.foreground.generate('owner scene');
  await stopped; await turn();
  assert.equal(f.calls[2].name, 'tester count');
  f.calls[2].finish(); await count; tester.end(); await turn();
  assert.equal(f.calls[3].name, 'owner scene');
  f.calls[3].finish(); await owner;
  prepared.end();
});

// A pool of slots: requests are `name:inputTokens`, and each call records the slot it ran in.
function poolFixture(t: TestContext, options: SchedulerOptions<string> = {}) {
  const calls: { name: string; slot?: number; finish: () => void; signal: AbortSignal }[] = [];
  const counted: string[] = [];
  const provider = {
    generate(request: string, { signal, slot }: { signal: AbortSignal; slot?: number }) {
      return new Promise<string>((resolve, reject) => {
        calls.push({ name: request.split(':')[0], slot, finish: () => resolve(request), signal });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    async countInput(request: string) { counted.push(request.split(':')[0]); return Number(request.split(':')[1] ?? 100); },
  };
  const scheduler = createScheduler(provider, { quietMs: 60000, pollMs: 100000, slots: 3, poolTokens: 100000,
    outputTokens: () => 1000, ...options });
  t.after(() => scheduler.close());
  const started = async (count: number) => { while (calls.length < count) await turn(); };
  return { scheduler, calls, counted, started };
}
test('a pool runs calls side by side, gives a person the highest slot and keeps a holder in its slot', async t => {
  const f = poolFixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
  // No quiet window: an agent and a probe run beside the person at once.
  const agentScene = agentTurn.generate('agent scene');
  const probe = f.scheduler.background.generate('probe');
  await f.started(3);
  assert.deepEqual(f.calls.map(call => [call.name, call.slot]), [['tester scene', 2], ['agent scene', 0], ['probe', 1]]);
  assert.equal(f.scheduler.snapshot().activeCount, 3);
  f.calls[0].finish(); await scene; tester.end();
  f.calls[1].finish(); await agentScene; agentTurn.end();
  f.calls[2].finish(); await probe;
  // The next turns go back to the same slots, where their caches are.
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  await f.started(4);
  assert.equal(f.calls[3].slot, 2);
  f.calls[3].finish(); await next; again.end();
});
test('a compaction prepared ahead leaves its holder\'s scenes in their slot, and the next scene goes back to them', async t => {
  const f = poolFixture(t);
  const run = async (name: string, options: { holder: string; yields?: boolean }) => {
    const opened = f.scheduler.foreground.openTurn(options);
    const result = opened.generate(name);
    await f.started(f.calls.length + 1);
    const call = f.calls.at(-1)!;
    call.finish(); await result; opened.end();
    return call.slot;
  };
  assert.equal(await run('tester scene', { holder: 'tester' }), 2);
  // Another system prompt, so nothing of the scenes would survive it: it takes the lowest slot that keeps nobody's.
  assert.equal(await run('prepared extraction', { holder: 'tester', yields: true }), 0);
  // The slot of the extraction is not the holder's: the scene goes where the scenes are.
  assert.equal(await run('tester next', { holder: 'tester' }), 2);
  // With other people's scenes in every other slot it costs its holder's own, never theirs.
  assert.equal(await run('owner scene', { holder: 'owner' }), 1);
  assert.equal(await run('guest scene', { holder: 'guest' }), 0);
  assert.equal(await run('prepared again', { holder: 'tester', yields: true }), 2);
  // The scenes are gone from that slot and it is nobody's now; the others still keep theirs.
  assert.equal(await run('tester after', { holder: 'tester' }), 2);
  assert.equal(await run('owner next', { holder: 'owner' }), 1);
});
test('a compaction prepared ahead that people\'s idle caches leave no room for ends, rather than wait for ever', async t => {
  const f = poolFixture(t, { poolTokens: 30000 });
  // While the scene runs, its claim is what is in the way, and that ends: the extraction waits.
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester:12000');
  await f.started(1);
  const prepared = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true });
  // 2048 margin + 16000 claim + the scene's 13000 exceed 30000.
  const extraction = prepared.generate('prepared:15000');
  extraction.catch(() => {});
  await turn(); await turn();
  assert.equal(f.calls.length, 1);
  assert.equal(f.scheduler.snapshot().foregroundQueued, 1);
  // The finished scene leaves an idle cache, 13000 with 1000 output and 1024 of growth. That stays until the tester
  // comes back, so the extraction would wait for ever and keep the GPU awake: it ends instead.
  f.calls[0].finish(); await scene; tester.end();
  await assert.rejects(extraction, { code: 'background_unavailable' });
  assert.equal(f.scheduler.snapshot().foregroundQueued, 0);
  await assert.rejects(prepared.generate('prepared supplement:100'), { code: 'background_unavailable' });
  // The next scene runs in the slot of the scenes.
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next:13000');
  await f.started(2);
  assert.deepEqual([f.calls[1].name, f.calls[1].slot], ['tester next', 2]);
  f.calls[1].finish(); await next; again.end();
  // A supplement that no longer fits, after an extraction that did, ends the same way.
  const g = poolFixture(t, { poolTokens: 30000 });
  const owner = g.scheduler.foreground.generate('owner:12000');
  await g.started(1);
  g.calls[0].finish(); await owner;
  const ahead = g.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const first = ahead.generate('prepared small:5000');
  await g.started(2);
  g.calls[1].finish(); await first;
  await assert.rejects(ahead.generate('prepared supplement:15000'), { code: 'background_unavailable' });
});
test('an agent waits while its claim would crowd out a person\'s cache; a person is admitted beside it', async t => {
  const f = poolFixture(t, { poolTokens: 20000 });
  const tester = f.scheduler.foreground.generate('tester:10000');
  await f.started(1);
  f.calls[0].finish(); await tester;
  // 2048 margin + 7000 claim + the tester's 11000 cache, 1000 output and 1024 of growth exceed 20000.
  const agent = f.scheduler.agent.generate('agent:6000');
  await turn(); await turn();
  assert.equal(f.calls.length, 1);
  // Another person does not count idle caches: llama.cpp evicts them for a running call. It spares the tester's slot.
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const scene = owner.generate('owner:5000');
  await f.started(2);
  assert.deepEqual([f.calls[1].name, f.calls[1].slot], ['owner', 1]);
  f.calls[1].finish(); await scene; owner.end();
  // After a server restart the caches are gone and the agent fits.
  f.scheduler.forget();
  f.scheduler.tick();
  await f.started(3);
  assert.equal(f.calls[2].name, 'agent');
  f.calls[2].finish(); await agent;
});
test('a person kept from a pool stops probes and another person\'s yielding turn; with room nobody yields', async t => {
  const f = poolFixture(t, { slots: 2 });
  const probe = f.scheduler.background.generate('probe');
  const prepared = f.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const extraction = prepared.generate('prepared');
  await f.started(2);
  assert.deepEqual(f.calls.map(call => [call.name, call.slot]), [['probe', 0], ['prepared', 1]]);
  const stopped = [assert.rejects(probe, { code: 'background_preempted' }), assert.rejects(extraction, { code: 'background_preempted' })];
  const tester = f.scheduler.foreground.generate('tester');
  await Promise.all(stopped);
  await f.started(3);
  assert.equal(f.calls[2].name, 'tester');
  f.calls[2].finish(); await tester;
  prepared.end();

  const g = poolFixture(t);
  const ahead = g.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const kept = ahead.generate('prepared');
  const person = g.scheduler.foreground.generate('tester');
  await g.started(2);
  assert.equal(g.calls[0].signal.aborted, false);
  g.calls[1].finish(); await person;
  g.calls[0].finish(); await kept; ahead.end();
});
test('a pool counts tokens outside its slots, even while every slot is busy', async t => {
  const f = poolFixture(t, { slots: 2 });
  const agent = f.scheduler.agent.generate('agent');
  const tester = f.scheduler.foreground.generate('tester');
  await f.started(2);
  assert.equal(await f.scheduler.foreground.countInput!('count:4321'), 4321);
  assert.ok(f.counted.includes('count'));
  f.calls[0].finish(); f.calls[1].finish(); await agent; await tester;
});
test('two turns between their calls in a pool do not wait for each other\'s room', async t => {
  const f = poolFixture(t, { poolTokens: 12000 });
  const a = f.scheduler.agent.openTurn({ holder: 'a' });
  const b = f.scheduler.agent.openTurn({ holder: 'b' });
  const first = [a.generate('a compaction:3000'), b.generate('b compaction:3000')];
  await f.started(2);
  f.calls[0].finish(); f.calls[1].finish(); await Promise.all(first);
  // Each scene with the other's cache would exceed 12000; running calls alone do not.
  const scenes = [a.generate('a scene:4000'), b.generate('b scene:4000')];
  await f.started(3);
  assert.deepEqual(f.calls.slice(2).map(call => call.name), ['a scene']);
  f.calls[2].finish(); await scenes[0]; a.end();
  await f.started(4);
  f.calls[3].finish(); await scenes[1]; b.end();
});
test('a pool keeps a person\'s room from an agent between its own calls', async t => {
  const f = poolFixture(t, { poolTokens: 98304 });
  const person = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = person.generate('tester:48000');
  await f.started(1);
  f.calls[0].finish(); await scene; person.end();
  const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
  const small = agentTurn.generate('agent small:1000');
  await f.started(2);
  f.calls[1].finish(); await small;
  // Between its calls the agent asks for a request that would leave the tester's cache no room.
  const big = agentTurn.generate('agent big:54000');
  await turn(); await turn();
  assert.equal(f.calls.length, 2);
  agentTurn.end();
  await assert.rejects(big, { code: 'cancelled' });
});
test('a person waiting for room in a pool ends another\'s yielding turn between its own calls', async t => {
  const f = poolFixture(t, { poolTokens: 65536 });
  const prepared = f.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const extraction = prepared.generate('prepared:41000');
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const count = tester.generate('tester count:1000');
  await f.started(2);
  f.calls[1].finish(); await count;
  const stopped = assert.rejects(extraction, { code: 'background_preempted' });
  const scene = tester.generate('tester scene:31000');
  await stopped;
  await f.started(3);
  assert.equal(f.calls[2].name, 'tester scene');
  f.calls[2].finish(); await scene; tester.end(); prepared.end();
});
test('an agent kept by a probe in a pool stops it, and a turn waiting for room is not lost', async t => {
  let time = 0;
  const f = poolFixture(t, { slots: 2, now: () => time, turnIdleMs: 60000 });
  const probe = f.scheduler.background.generate('probe');
  await f.started(1);
  const preempted = assert.rejects(probe, { code: 'background_preempted' });
  const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
  const call = agentTurn.generate('agent call');
  await preempted;
  await f.started(2);
  assert.equal(f.calls[1].name, 'agent call');
  f.calls[1].finish(); await call;
  // A turn whose next call waits for a busy pool keeps its slot; only a silent one is lost.
  const person = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = person.generate('tester:100');
  await f.started(3);
  const next = agentTurn.generate('agent next:99000');
  time = 120000; f.scheduler.tick(); await turn();
  assert.equal(f.calls.length, 3);
  f.calls[2].finish(); await scene; person.end();
  agentTurn.end();
  await assert.rejects(next, { code: 'cancelled' });
});
test('an agent between its own calls stops a probe that leaves it no room', async t => {
  const f = poolFixture(t, { poolTokens: 65536 });
  const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
  const small = agentTurn.generate('agent small:1000');
  await f.started(1);
  f.calls[0].finish(); await small;
  const probe = f.scheduler.background.generate('probe:40000');
  await f.started(2);
  // The turn holds its slot, so nothing but the probe stands between it and the model.
  const preempted = assert.rejects(probe, { code: 'background_preempted' });
  const big = agentTurn.generate('agent big:30000');
  await preempted;
  await f.started(3);
  assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['agent big', 0]);
  f.calls[2].finish(); await big; agentTurn.end();
});
test('a yielding turn waiting for room in a pool keeps nobody behind it', async t => {
  const f = poolFixture(t, { poolTokens: 65536 });
  const agent = f.scheduler.agent.generate('agent:40000');
  await f.started(1);
  const prepared = f.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const first = prepared.generate('prepared small:1000');
  await f.started(2);
  f.calls[1].finish(); await first;
  // Its next call does not fit beside the agent, and a turn that yields preempts nobody to make room for itself.
  const next = prepared.generate('prepared big:30000');
  await turn(); await turn();
  assert.equal(f.calls.length, 2);
  // A person who does fit is not kept waiting by it.
  const tester = f.scheduler.foreground.generate('tester:1000');
  await f.started(3);
  assert.equal(f.calls[2].name, 'tester');
  assert.equal(f.calls[0].signal.aborted, false);
  f.calls[2].finish(); await tester;
  f.calls[0].finish(); await agent;
  await f.started(4);
  f.calls[3].finish(); await next; prepared.end();
});
test('isolated slots run side by side without counting tokens or dividing a cache', async t => {
  // Each slot holds its own request, so a call the shared-cache arithmetic would never admit runs at once.
  const f = poolFixture(t, { sharedCache: false, poolTokens: 1000 });
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene:60000');
  const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
  const agentScene = agentTurn.generate('agent scene:60000');
  const probe = f.scheduler.background.generate('probe:60000');
  await f.started(3);
  assert.deepEqual(f.calls.map(call => [call.name, call.slot]), [['tester scene', 2], ['agent scene', 0], ['probe', 1]]);
  // Nothing was sized: an isolated slot asks the server for no count before the call.
  assert.deepEqual(f.counted, []);
  f.calls[0].finish(); await scene; tester.end();
  f.calls[1].finish(); await agentScene; agentTurn.end();
  f.calls[2].finish(); await probe;
});
test('a person waiting for an isolated slot still stops a probe holding it', async t => {
  const f = poolFixture(t, { sharedCache: false, slots: 2 });
  const probe = f.scheduler.background.generate('probe');
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const first = owner.generate('owner:100');
  await f.started(2);
  // Both slots are busy, so the next person has nowhere to go until the probe gives way.
  const preempted = assert.rejects(probe, { code: 'background_preempted' });
  const tester = f.scheduler.foreground.generate('tester:100');
  await preempted;
  await f.started(3);
  assert.equal(f.calls[2].name, 'tester');
  f.calls[2].finish(); await tester;
  f.calls[1].finish(); await first; owner.end();
});
test('cancelling a queued call in a pool ends the token count it started', async t => {
  let release: ((value: number) => void) | undefined;
  const aborted: string[] = [];
  const scheduler = createScheduler({
    generate: (request: string) => new Promise<string>(() => {}),
    countInput: (request: string, { signal }: { signal: AbortSignal }) => new Promise<number>((resolve, reject) => {
      if (request.startsWith('slow')) { release = resolve; signal.addEventListener('abort', () => { aborted.push(request); reject(signal.reason); }, { once: true }); }
      else resolve(100);
    }),
  }, { slots: 2, poolTokens: 100000, outputTokens: () => 100, pollMs: 100000 });
  t.after(() => scheduler.close());
  const controller = new AbortController();
  const pending = scheduler.foreground.generate('slow request', { signal: controller.signal });
  await turn();
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.deepEqual(aborted, ['slow request']);
  // The count was under way and was stopped, not left to finish on its own.
  assert.equal(typeof release, 'function');
});
