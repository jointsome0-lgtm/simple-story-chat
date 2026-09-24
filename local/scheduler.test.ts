import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SchedulerOptions } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import { ModelError } from './model-error.ts';
import type { Controls } from './model.ts';
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
// The lease keeps the GPU up for the call (gpu.ts `keepAwake`), so it must end exactly once, on every way a call ends.
test("a probe's call holds its lease from the moment the queue takes it until it settles, whichever way it ends", async t => {
  // How often each lease was released, in the order the calls were taken.
  const leases: number[] = [];
  let allowed = true, canWait = true;
  const calls: { name: string; finish: () => void; fail: () => void }[] = [];
  const provider = { generate: (request: string, { signal }: { signal: AbortSignal }) => new Promise<string>((resolve, reject) => {
    calls.push({ name: request, finish: () => resolve(request), fail: () => reject(new ModelError('provider_failed')) });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) };
  const options = { quietMs: 0, pollMs: 100000, backgroundTimeoutMs: 20,
    backgroundAllowed: () => allowed, backgroundCanWait: () => canWait,
    holdBackgroundCall: () => {
      const lease = leases.length;
      leases.push(0);
      return () => { leases[lease]++; };
    } };
  const scheduler = createScheduler(provider, options);
  t.after(() => scheduler.close());
  const done = scheduler.background.generate('done');
  assert.deepEqual(leases, [0]);
  calls[0].finish(); await done;
  const failed = scheduler.background.generate('failed');
  calls[1].fail(); await assert.rejects(failed, { code: 'provider_failed' });
  assert.deepEqual(leases, [1, 1]);
  // Cancelled while it runs, and while it waits: a waiting call holds its lease already.
  const running = new AbortController(), waiting = new AbortController();
  const first = scheduler.background.generate('running', { signal: running.signal });
  const second = scheduler.background.generate('waiting', { signal: waiting.signal });
  assert.deepEqual(leases, [1, 1, 0, 0]);
  waiting.abort(); await assert.rejects(second, { code: 'cancelled' });
  running.abort(); await assert.rejects(first, { code: 'cancelled' });
  assert.deepEqual(leases, [1, 1, 1, 1]);
  // Preempted by a person, whose calls take no lease.
  const probe = scheduler.background.generate('preempted');
  const person = scheduler.foreground.generate('person');
  await assert.rejects(probe, { code: 'background_preempted' }); await turn();
  calls.at(-1)!.finish(); await person;
  await assert.rejects(scheduler.background.generate('slow'), { code: 'background_timeout' });
  assert.deepEqual(leases, [1, 1, 1, 1, 1, 1]);
  // Stopped once probes may not run, refused once they may not wait, and refused before the queue takes it. The queue
  // is empty before anything is awaited, so one that kept a probe fails here instead of hanging the test.
  const stopped = scheduler.background.generate('stopped');
  const refused = scheduler.background.generate('refused');
  allowed = false; canWait = false; scheduler.tick();
  assert.equal(scheduler.snapshot().backgroundQueued, 0);
  await assert.rejects(stopped, { code: 'background_unavailable' });
  await assert.rejects(refused, { code: 'background_unavailable' });
  const notTaken = assert.rejects(scheduler.background.generate('not taken'), { code: 'background_unavailable' });
  assert.equal(scheduler.snapshot().backgroundQueued, 0);
  await notTaken;
  assert.deepEqual(leases, [1, 1, 1, 1, 1, 1, 1, 1]);
  allowed = true; canWait = true;
  // A full queue takes no fifth waiting call; the shutdown ends the running call and the waiting ones.
  const last = ['last', 'waiting 1', 'waiting 2', 'waiting 3', 'waiting 4'].map(name => scheduler.background.generate(name));
  await assert.rejects(scheduler.background.generate('full'), { code: 'queue_full' });
  await scheduler.close();
  for (const call of last) await assert.rejects(call, { code: 'cancelled' });
  await assert.rejects(scheduler.background.generate('closed'), { code: 'cancelled' });
  // In a shared pool a call waits for its size first, and a count that fails ends it.
  const pool = createScheduler({ ...provider, countInput: async () => { throw new ModelError('provider_failed'); } },
    { ...options, slots: 2, poolTokens: 100000, sharedCache: true, outputTokens: () => 100 });
  t.after(() => pool.close());
  await assert.rejects(pool.background.generate('uncounted'), { code: 'provider_failed' });
  assert.deepEqual(leases, Array(14).fill(1));
});

test('a provider without a check gets none from the scheduler', async t => {
  const bare = createScheduler({ generate: async () => 'done' });
  t.after(() => bare.close());
  assert.equal('check' in bare.foreground, false);
  const server = createScheduler({ generate: async () => 'done', check: async () => ({ model: 'test-model' }) });
  t.after(() => server.close());
  assert.deepEqual(await server.foreground.check!(), { model: 'test-model' });
});
// A provider that serves kinds of work apart (local/serving.ts) learns whose each call is, from the queue it came
// through, on every way a call reaches it: through a slot, and in a pool also the count that runs beside the slots and
// the count a shared cache sizes a call by before admitting it. Whatever a caller writes into its own controls.
test('the provider hears the priority and holder of every call, and a caller cannot name its own', async t => {
  for (const { slots, sharedCache } of [{ slots: 1, sharedCache: true }, { slots: 2, sharedCache: true }, { slots: 2, sharedCache: false }]) {
    const seen: string[] = [];
    const heard = (request: string, { priority, holder }: Controls) => { seen.push(`${request} ${priority} ${holder}`); };
    const scheduler = createScheduler({
      generate: async (request: string, controls: Controls) => { heard(request, controls); return request; },
      countInput: async (request: string, controls: Controls) => { heard(`count ${request}`, controls); return 100; },
    }, { quietMs: 0, pollMs: 100000, slots, poolTokens: 100000, sharedCache, outputTokens: () => 100 });
    t.after(() => scheduler.close());
    const claims = { priority: 'foreground', holder: 'someone else' } as const;
    const reader = scheduler.foreground.openTurn({ holder: 'tester' });
    await reader.countInput!('scene', { ...claims, priority: 'background' });
    await reader.generate('scene', { ...claims, priority: 'background' });
    reader.end();
    // The work the bot does ahead for a reader: a picture's description, then a compaction prepared while they read.
    for (const options of [{ sharesPrefix: true }, { yields: true }]) {
      const ahead = scheduler.foreground.openTurn({ holder: 'tester', ...options });
      await ahead.countInput!('ahead', claims);
      await ahead.generate('ahead', claims);
      ahead.end();
    }
    await scheduler.foreground.countInput!('unheld', claims);
    await scheduler.foreground.generate('unheld', claims);
    const agent = scheduler.agent.openTurn();
    await agent.countInput!('agent', claims);
    await agent.generate('agent', claims);
    agent.end();
    await scheduler.background.countInput!('probe', claims);
    await scheduler.background.generate('probe', claims);
    // A shared cache sizes every generation first, with the same word on whose it is; a count is never sized.
    const call = (request: string, whose: string) =>
      [`count ${request} ${whose}`, ...slots > 1 && sharedCache ? [`count ${request} ${whose}`] : [], `${request} ${whose}`];
    assert.deepEqual(seen, [...call('scene', 'foreground tester'), ...call('ahead', 'foreground tester'), ...call('ahead', 'foreground tester'),
      ...call('unheld', 'foreground undefined'), ...call('agent', 'agent undefined'), ...call('probe', 'background undefined')],
    `${slots} slots, ${sharedCache ? 'shared' : 'isolated'}`);
  }
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
  // The start rule turning false (a person's job beginning) does not stop a running call; a pause does.
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
test('a turn that shares its holder\'s prefix yields to that holder too, unlike a prepared compaction', async t => {
  const f = fixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await turn();
  f.calls[0].finish(); await scene; tester.end();
  // `sharesPrefix` alone is work prepared ahead as well: no `yields` is needed for it to give way.
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', sharesPrefix: true });
  const described = picture.generate('picture');
  await turn();
  assert.equal(f.calls[1].name, 'picture');
  // Its holder's own next turn does not wait for it and does not take its result: it wants the slot the picture is in.
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  await stopped; await turn();
  assert.equal(f.calls[2].name, 'tester next');
  f.calls[2].finish(); await next; again.end();
  picture.end();
});
test('a picture runs on no slot but the one its own holder\'s prefix is in, with a single slot as with a pool', async t => {
  const f = fixture(t);
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const scene = owner.generate('owner scene');
  await turn();
  f.calls[0].finish(); await scene; owner.end(); await turn();
  // The one slot holds the owner's prompt now, so there is no prefix of the tester's to continue: the picture would
  // prefill from nothing and evict the owner's cache for work nobody waits for.
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(picture.generate('tester picture'), { code: 'background_unavailable' });
  assert.equal(f.calls.length, 1);
});
test('a prefix-sharing call gives up the slot rather than queue for it, and waits only on a call already stopped', async t => {
  const f = fixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await turn();
  f.calls[0].finish(); await scene; await turn();
  // Its holder's turn holds the slot between its own calls: waiting there is waiting for the work the picture is for.
  const behind = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(behind.generate('picture'), { code: 'background_unavailable' });
  assert.equal(f.calls.length, 1);
  tester.end(); await turn();
  // A call already stopped is on its way out of the slot and leaves the prefix behind it, so the next picture waits
  // that moment out instead of giving up.
  const cut = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const dropped = cut.generate('tester scene again');
  await turn();
  const cancelled = assert.rejects(dropped, { code: 'cancelled' });
  cut.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture again');
  await cancelled; await turn();
  assert.equal(f.calls[2].name, 'picture again');
  f.calls[2].finish(); await described; picture.end();
});

// A pool of slots: requests are `name:inputTokens`, and each call records the slot it ran in. `abortDelay` is how
// many turns of the event loop a stopped call takes to let its slot go: a real server finishes the decode step in
// flight and closes the stream, while a token count the scheduler asked for resolves in a microtask.
function poolFixture(t: TestContext, options: SchedulerOptions<string> = {}, abortDelay = 0) {
  const calls: { name: string; slot?: number; finish: () => void; signal: AbortSignal }[] = [];
  const counted: string[] = [];
  const provider = {
    generate(request: string, { signal, slot }: { signal: AbortSignal; slot?: number }) {
      return new Promise<string>((resolve, reject) => {
        calls.push({ name: request.split(':')[0], slot, finish: () => resolve(request), signal });
        signal.addEventListener('abort', () => {
          let left = abortDelay;
          const unwind = () => (left-- > 0 ? setImmediate(unwind) : reject(signal.reason));
          unwind();
        }, { once: true });
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
test('a picture described from the last scene runs in its holder\'s slot and leaves the scenes in it', async t => {
  const f = poolFixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  assert.equal(f.calls[0].slot, 2);
  f.calls[0].finish(); await scene; tester.end();
  // It continues that very request, so it belongs where the prefix is cached; a compaction prepared ahead, which asks
  // with a prompt of its own, takes slot 0 instead.
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(2);
  assert.equal(f.calls[1].slot, 2);
  f.calls[1].finish(); await described; picture.end();
  // The slot still holds the tester's scenes, with the picture's prompt on top: the next scene goes back to it.
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  await f.started(3);
  assert.equal(f.calls[2].slot, 2);
  f.calls[2].finish(); await next; again.end();
});
test('a picture ends the moment its holder calls again, however much room the pool has', async t => {
  const f = poolFixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(2);
  assert.equal(f.calls[1].slot, 2);
  // Two slots stand free, so the pool keeps the tester waiting for nothing, and the picture ends all the same: their
  // next scene matters more than it and wants that slot, which it gets back.
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  await stopped;
  await f.started(3);
  assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['tester next', 2]);
  f.calls[2].finish(); await next; again.end(); picture.end();
});
test('a person\'s token count in a pool ends the picture in their slot, as their scene does', async t => {
  const f = poolFixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(2);
  assert.equal(f.calls[1].slot, 2);
  // A scene's input is counted before the scene is generated (generation.ts), and a pool counts it outside the slots.
  // The picture standing in that scene's way ends for the count all the same, as it does with a single slot.
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  assert.equal(await again.countInput!('tester next:9000'), 9000);
  await stopped;
  const next = again.generate('tester next:9000');
  await f.started(3);
  assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['tester next', 2]);
  f.calls[2].finish(); await next; again.end(); picture.end();
});
test('the holder waits for the slot a picture is still leaving, rather than take a free one', async t => {
  // A stopped call does not let its slot go the instant it is told to; the next scene is sized before that, in a
  // microtask. Going to another slot then would cost the whole prefill the picture stayed in this one to save.
  const f = poolFixture(t, {}, 2);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  assert.equal(f.calls[0].slot, 2);
  f.calls[0].finish(); await scene; tester.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(2);
  assert.equal(f.calls[1].slot, 2);
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  await stopped;
  await f.started(3);
  assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['tester next', 2]);
  f.calls[2].finish(); await next; again.end(); picture.end();
});
test('a picture leaves its holder one slot in the pool, not two', async t => {
  const f = poolFixture(t, { poolTokens: 40000 }, 2);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester:9000');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture:9000');
  await f.started(2);
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next:9000');
  await stopped;
  await f.started(3);
  f.calls[2].finish(); await next; again.end(); picture.end();
  // A slot the tester never came back to would still hold a reader's whole reserve: 2048 + 15000 + 10000 + 1000 +
  // 1024 leave this agent room beside one such cache, and 12024 less than it needs beside two.
  const agent = f.scheduler.agent.generate('agent:14000');
  await turn(); await turn();
  assert.deepEqual(f.calls.slice(3).map(call => call.name), ['agent']);
  f.calls[3].finish(); await agent;
});
test('a holder waiting for the slot its picture is leaving keeps nobody behind it', async t => {
  const f = poolFixture(t, {}, 2);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  // Another person's compaction, prepared while they read, in a slot the tester does not want.
  const prepared = f.scheduler.foreground.openTurn({ holder: 'owner', yields: true });
  const extraction = prepared.generate('prepared extraction');
  await f.started(2);
  assert.equal(f.calls[1].slot, 0);
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(3);
  assert.equal(f.calls[2].slot, 2);
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next');
  // The tester waits for one slot of the three, and holds up nothing while they wait: a person behind them runs in a
  // free slot, and the compaction prepared for a third person is in nobody's way, so it is not ended for them.
  const guest = f.scheduler.foreground.generate('guest scene');
  await stopped;
  await f.started(5);
  assert.deepEqual(f.calls.slice(3).map(call => [call.name, call.slot]), [['guest scene', 1], ['tester next', 2]]);
  assert.equal(f.calls[1].signal.aborted, false);
  f.calls[1].finish(); await extraction; prepared.end();
  f.calls[3].finish(); await guest;
  f.calls[4].finish(); await next; again.end(); picture.end();
});
test('a picture ended while its own call is still being enqueued takes no place in the queue', async t => {
  const f = poolFixture(t, { slots: 2 });
  const one = f.scheduler.foreground.generate('one');
  const two = f.scheduler.foreground.generate('two');
  await f.started(2);
  const three = f.scheduler.foreground.generate('three');
  await turn(); await turn();
  assert.equal(f.scheduler.snapshot().foregroundQueued, 1);
  // Opening a second picture for the same holder ends the first one, and the person waiting for a slot ends this one
  // in the same breath, before its call is even queued. The call is refused, rather than left waiting for a turn that
  // is over and that nothing would end a second time.
  const first = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const second = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(second.generate('picture'), { code: 'background_preempted' });
  first.end(); second.end();
  // The queues run on: the person who was waiting takes the first slot to come free.
  f.calls[0].finish(); await one;
  await f.started(3);
  assert.equal(f.calls[2].name, 'three');
  f.calls[1].finish(); await two;
  f.calls[2].finish(); await three;
});
test('a picture stays while another person has room and gives way to the one who has none', async t => {
  const f = poolFixture(t, { slots: 2 });
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const scene = owner.generate('owner scene');
  await f.started(1);
  assert.equal(f.calls[0].slot, 1);
  f.calls[0].finish(); await scene; owner.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'owner', yields: true, sharesPrefix: true });
  const described = picture.generate('picture');
  await f.started(2);
  assert.equal(f.calls[1].slot, 1);
  // The picture keeps nobody from the model while a slot is free: another person runs beside it.
  const tester = f.scheduler.foreground.generate('tester');
  await f.started(3);
  assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['tester', 0]);
  assert.equal(f.calls[1].signal.aborted, false);
  // The next person has nowhere to go, and the picture gives way like any work prepared ahead.
  const stopped = assert.rejects(described, { code: 'background_preempted' });
  const guest = f.scheduler.foreground.generate('guest');
  await stopped;
  await f.started(4);
  assert.equal(f.calls[3].name, 'guest');
  f.calls[2].finish(); await tester;
  f.calls[3].finish(); await guest; picture.end();
});
test('a picture gives up when the slot its prefix is in is not to be had', async t => {
  const f = poolFixture(t, { slots: 2 });
  // Nothing of the tester's is cached in any slot: there is no prefix to continue, and waiting for one would only
  // keep the GPU awake for a picture that would still start from nothing.
  const nowhere = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(nowhere.generate('picture'), { code: 'background_unavailable' });
  assert.equal(f.calls.length, 0);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  // Now the slot is the tester's own turn's, between its calls: the picture would queue behind the work it is for.
  const behind = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(behind.generate('picture'), { code: 'background_unavailable' });
  assert.equal(f.calls.length, 1);
  f.calls[0].finish(); await scene; tester.end();
});
test('a prefix-sharing turn of the agent interface gives up at once instead of holding the GPU awake', async t => {
  const f = poolFixture(t);
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester scene');
  await f.started(1);
  assert.equal(f.calls[0].slot, 2);
  f.calls[0].finish(); await scene; tester.end();
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const other = owner.generate('owner scene');
  await f.started(2);
  assert.equal(f.calls[1].slot, 1);
  f.calls[1].finish(); await other; owner.end();
  // The agent interface opens turns with the same options, but agents take no person's slot, and the tester's prefix
  // is in one: this turn could only wait for ever, keeping the GPU from idling (bot.ts `prepareNext`).
  const picture = f.scheduler.agent.openTurn({ holder: 'tester', sharesPrefix: true });
  await assert.rejects(picture.generate('picture'), { code: 'background_unavailable' });
  // The owner's cache is in a slot agents do use, and it is still the owner's: a turn of theirs is refused there too,
  // rather than run where it would cost the owner their reserve.
  const lower = f.scheduler.agent.openTurn({ holder: 'owner', sharesPrefix: true });
  await assert.rejects(lower.generate('owner picture'), { code: 'background_unavailable' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.scheduler.snapshot().agentQueued, 0);
  // It is refused while agents may not start at all, where nothing else would ever look at it again, and in a slot
  // agents do choose from: `place` never reaches it, and no reservation makes it late enough to be taken as lost.
  const g = poolFixture(t, { agentCanStart: () => false });
  const first = g.scheduler.foreground.openTurn({ holder: 'first' });
  const ahead = first.generate('first scene');
  await g.started(1);
  const guest = g.scheduler.foreground.openTurn({ holder: 'guest' });
  const read = guest.generate('guest scene');
  await g.started(2);
  assert.deepEqual(g.calls.map(call => call.slot), [2, 1]);
  g.calls[0].finish(); await ahead; first.end();
  g.calls[1].finish(); await read; guest.end();
  const shut = g.scheduler.agent.openTurn({ holder: 'guest', sharesPrefix: true });
  await assert.rejects(shut.generate('guest picture'), { code: 'background_unavailable' });
  assert.equal(g.calls.length, 2);
});
test('a picture is admitted beside the cache it fills again, and refused beside another reader\'s', async t => {
  const f = poolFixture(t, { poolTokens: 30000 });
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester:12000');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  // A compaction prepared ahead of this size ends here: 2048 margin + 16000 claim + the tester's 13000 cache, 1000
  // output and 1024 of growth exceed 30000. The picture fills that cache again, and its own slot is not counted.
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture:15000');
  await f.started(2);
  assert.equal(f.calls[1].slot, 2);
  f.calls[1].finish(); await described; picture.end();
  const owner = f.scheduler.foreground.openTurn({ holder: 'owner' });
  const other = owner.generate('owner:10000');
  await f.started(3);
  assert.equal(f.calls[2].slot, 1);
  f.calls[2].finish(); await other; owner.end();
  // Another reader's idle cache counts against it as against any work prepared ahead: 2048 + 16000 + 11000 + 1000 +
  // 1024 exceed 30000, and that cache stays until the owner comes back.
  const again = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(again.generate('picture again:15000'), { code: 'background_unavailable' });
});
test('a picture leaves its holder\'s next scene the output room that scene asked for', async t => {
  // `name:inputTokens:outputTokens`, so a description's small output limit tells itself from a scene's.
  const f = poolFixture(t, { slots: 2, poolTokens: 40000, outputTokens: request => Number(request.split(':')[2] ?? 1000) });
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester:10000:4000');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  const described = picture.generate('picture:14000:500');
  await f.started(2);
  assert.equal(f.calls[1].slot, 1);
  f.calls[1].finish(); await described; picture.end();
  // The slot holds 14500 cells now, and the tester's next scene still wants 4000 of output and 1024 of growth beside
  // them: 2048 + 20000 + 19524 exceed 40000, however little the description itself asked to write.
  const agent = f.scheduler.agent.generate('agent:19000:1000');
  await turn(); await turn();
  assert.equal(f.calls.length, 2);
  // With that cache gone the same call fits.
  f.scheduler.forget();
  f.scheduler.tick();
  await f.started(3);
  assert.equal(f.calls[2].name, 'agent');
  f.calls[2].finish(); await agent;
});
test('a picture still queued gives way to its holder\'s own call waiting for room', async t => {
  const f = poolFixture(t, { slots: 2, poolTokens: 30000 });
  const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const scene = tester.generate('tester:2000');
  await f.started(1);
  f.calls[0].finish(); await scene; tester.end();
  const agent = f.scheduler.agent.generate('agent:20000');
  await f.started(2);
  // The tester's next scene does not fit beside the agent's 21000 and waits for it.
  const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
  const next = again.generate('tester next:8000');
  await turn(); await turn();
  assert.equal(f.scheduler.snapshot().foregroundQueued, 1);
  // A picture opened after that call queues behind it and ends for it: the scene is what the tester is waiting for.
  const picture = f.scheduler.foreground.openTurn({ holder: 'tester', yields: true, sharesPrefix: true });
  await assert.rejects(picture.generate('picture:100'), { code: 'background_preempted' });
  f.calls[1].finish(); await agent;
  await f.started(3);
  assert.equal(f.calls[2].name, 'tester next');
  f.calls[2].finish(); await next; again.end();
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
// A provider whose calls see their abort at once but end only when the test ends them, as a request still closing on
// the server does. The count of a request named 'held …' waits for the test as well; any other is 100 tokens at once.
function unwindFixture(t: TestContext, options: SchedulerOptions<string> = {}) {
  type Call<T> = { name: string; signal: AbortSignal; finish: (value: T) => void; unwind: () => void };
  const calls: Call<string>[] = [], counts: Call<number>[] = [];
  const held = <T>(list: Call<T>[], name: string, signal: AbortSignal) => new Promise<T>((resolve, reject) => {
    list.push({ name, signal, finish: resolve, unwind: () => reject(signal.reason) });
  });
  // How often each hold on the GPU was let go, in the order they were taken: a probe's lease and an agent turn's.
  const probes: number[] = [], turns: number[] = [];
  const hold = (list: number[]) => () => {
    const index = list.push(0) - 1;
    return () => { list[index]++; };
  };
  const scheduler = createScheduler({
    generate: (request: string, { signal }: { signal: AbortSignal }) => held(calls, request, signal),
    countInput: (request: string, { signal }: { signal: AbortSignal }) =>
      request.startsWith('held') ? held(counts, request, signal) : Promise.resolve(100),
  }, { pollMs: 100000, slots: 2, poolTokens: 100000, outputTokens: () => 100,
    holdBackgroundCall: hold(probes), holdAgentTurn: hold(turns), ...options });
  // A failed assertion must not leave the shutdown waiting for a call nobody ends.
  t.after(() => { for (const call of [...calls, ...counts]) call.unwind(); return scheduler.close(); });
  return { scheduler, calls, counts, probes, turns };
}
// Whether a promise is still unsettled once everything already under way has run.
async function unsettled(promise: Promise<unknown>) {
  let open = true;
  promise.then(() => { open = false; }, () => { open = false; });
  await turn();
  return open;
}
// What a call holds is let go only once the call has ended (local/gpu.ts), and a call stopped while a shared cache
// counts its size ends only when that count has ended on the server.
test('cancelling a queued call in a pool ends the token count it started, and the call settles after that count', async t => {
  const f = unwindFixture(t);
  const controller = new AbortController();
  const pending = f.scheduler.foreground.generate('held request', { signal: controller.signal });
  await turn();
  controller.abort();
  // The count was under way and is stopped, not left to finish on its own; the call waits for it to end.
  assert.equal(f.counts[0].signal.aborted, true);
  assert.equal(await unsettled(pending), true);
  f.counts[0].unwind();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.deepEqual(f.calls, []);
});
test('a probe stopped while its size is counted keeps its lease until that count has ended, however it is stopped', async t => {
  let canWait = true;
  const f = unwindFixture(t, { backgroundCanWait: () => canWait });
  // Cancelled by whoever asked.
  const controller = new AbortController();
  const cancelled = f.scheduler.background.generate('held cancelled', { signal: controller.signal });
  await turn();
  controller.abort();
  assert.deepEqual([f.counts[0].signal.aborted, await unsettled(cancelled), f.probes], [true, true, [0]]);
  f.counts[0].unwind();
  await assert.rejects(cancelled, { code: 'cancelled' });
  assert.deepEqual(f.probes, [1]);
  // Refused as the GPU pauses: the pause waits for the count as it would for the call.
  const refused = f.scheduler.background.generate('held refused');
  await turn();
  canWait = false; f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().backgroundQueued, 0);
  assert.deepEqual([f.counts[1].signal.aborted, await unsettled(refused), f.probes], [true, true, [1, 0]]);
  f.counts[1].unwind();
  await assert.rejects(refused, { code: 'background_unavailable' });
  assert.deepEqual(f.probes, [1, 1]);
  // Cancelled by the shutdown, which returns only once the count has ended.
  canWait = true;
  const shut = f.scheduler.background.generate('held shut');
  await turn();
  const closed = f.scheduler.close();
  assert.deepEqual([f.counts[2].signal.aborted, await unsettled(closed), await unsettled(shut), f.probes], [true, true, true, [1, 1, 0]]);
  f.counts[2].unwind();
  await closed;
  await assert.rejects(shut, { code: 'cancelled' });
  assert.deepEqual([f.probes, f.calls], [[1, 1, 1], []]);
});
test('an ended agent turn lets the GPU go only once its calls have ended, a count of its own included', async t => {
  const f = unwindFixture(t);
  // Its first call takes a slot, and the GPU with it.
  const agent = f.scheduler.agent.openTurn({ holder: 'agent' });
  const first = agent.generate('first');
  await turn();
  f.calls[0].finish('first'); await first;
  assert.deepEqual(f.turns, [0]);
  // Ended while its next call is sized: the count is stopped, and the GPU is held until it has ended.
  const next = agent.generate('held next');
  await turn();
  agent.end();
  assert.deepEqual([f.counts[0].signal.aborted, await unsettled(next), f.turns], [true, true, [0]]);
  f.counts[0].unwind();
  await assert.rejects(next, { code: 'cancelled' });
  assert.deepEqual(f.turns, [1]);
  // Ended during a call: the call is stopped, and the GPU is held until it has ended.
  const second = f.scheduler.agent.openTurn({ holder: 'agent' });
  const running = second.generate('running');
  await turn();
  second.end();
  assert.deepEqual([f.calls[1].signal.aborted, await unsettled(running), f.turns], [true, true, [1, 0]]);
  f.calls[1].unwind();
  await assert.rejects(running, { code: 'cancelled' });
  assert.deepEqual(f.turns, [1, 1]);
  // Ended while it counts beside the slots: nothing stops that count, and the GPU is held until it has ended.
  const third = f.scheduler.agent.openTurn({ holder: 'agent' });
  const call = third.generate('call');
  await turn();
  f.calls[2].finish('call'); await call;
  const count = third.countInput!('held count');
  third.end();
  assert.deepEqual([await unsettled(count), f.turns], [true, [1, 1, 0]]);
  f.counts[1].finish(4321);
  assert.equal(await count, 4321);
  assert.deepEqual(f.turns, [1, 1, 1]);
});
// A probe's count in a pool runs beside the slots, but it is a probe's call all the same (local/gpu.ts): it waits for
// the GPU as a probe's generation does, holds its lease until it has ended, and stops when the GPU goes away.
test("a probe's count in a pool keeps to the probes' rules beside the slots, and holds its lease until it has ended", async t => {
  let allowed = false, canWait = false;
  const f = unwindFixture(t, { sharedCache: false, backgroundAllowed: () => allowed, backgroundCanWait: () => canWait });
  // While the GPU pauses, it is refused before the queue takes it, and the server hears nothing. That is checked before
  // anything is awaited, so a count sent all the same fails here instead of hanging the test.
  const refused = assert.rejects(f.scheduler.background.countInput!('held refused'), { code: 'background_unavailable' });
  assert.deepEqual([f.counts.length, f.probes], [0, []]);
  await refused;
  // While the GPU is not ready, it waits in the probes' queue and holds its lease from the start.
  canWait = true;
  const waiting = f.scheduler.background.countInput!('held waiting');
  f.scheduler.tick(); await turn();
  assert.deepEqual([f.counts.length, f.scheduler.snapshot().backgroundQueued, f.probes], [0, 1, [0]]);
  // Once a probe may run, it runs at once, though people hold every slot and one more waits for a slot: the count keeps
  // nobody from a slot, so nobody stops it.
  const people = ['owner', 'tester', 'reader'].map(name => f.scheduler.foreground.generate(name));
  allowed = true; f.scheduler.tick(); await turn();
  assert.deepEqual([f.calls.map(call => call.name), f.counts.map(count => count.name)], [['owner', 'tester'], ['held waiting']]);
  assert.equal(f.counts[0].signal.aborted, false);
  f.counts[0].finish(4321);
  assert.equal(await waiting, 4321);
  assert.deepEqual(f.probes, [1]);
  // The GPU going away stops it, and the lease is held until the count has ended.
  const stopped = f.scheduler.background.countInput!('held stopped');
  await turn();
  allowed = false; f.scheduler.tick();
  assert.deepEqual([f.counts[1].signal.aborted, await unsettled(stopped), f.probes], [true, true, [1, 0]]);
  f.counts[1].unwind();
  await assert.rejects(stopped, { code: 'background_unavailable' });
  assert.deepEqual(f.probes, [1, 1]);
  f.calls[0].finish('owner'); f.calls[1].finish('tester');
  await turn();
  f.calls[2].finish('reader');
  assert.deepEqual(await Promise.all(people), ['owner', 'tester', 'reader']);
});
