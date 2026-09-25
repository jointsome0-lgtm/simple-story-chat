import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { SchedulerOptions } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import { ModelError } from './model-error.ts';
import type { Controls, TurnOptions } from './model.ts';

const turn = () => new Promise(resolve => setImmediate(resolve));
// Whether a promise is still unsettled once everything already under way has run.
async function unsettled(promise: Promise<unknown>) {
  let open = true;
  promise.then(() => { open = false; }, () => { open = false; });
  await turn();
  return open;
}
type Call<T> = { name: string; slot?: number; signal: AbortSignal; finish: (value?: T) => void; fail: () => void; unwind: () => void };
// The model every table runs on. A request is `name` or `name:inputTokens`: a call resolves with its request and
// records its slot, and a count is the tokens its request names, 100 if none. A stopped call ends `unwinds` turns of
// the event loop later, as a server finishes the step in flight and closes the stream; with 'held' the test ends it, as
// it ends the count of a request named 'held …'. The clock and the GPU's answers are the fixture's to set, and each
// hold on the GPU, a probe's lease or an agent turn's, records how often it was let go, in the order they were taken.
function fixture(t: TestContext, options: SchedulerOptions<string> = {}, unwinds: number | 'held' = 0) {
  const calls: Call<string>[] = [], counts: Call<number>[] = [], counted: string[] = [], events: string[] = [];
  const probes: number[] = [], turns: number[] = [];
  const hold = (list: number[]) => () => { const index = list.push(0) - 1; return () => { list[index]++; }; };
  const held = <T>(list: Call<T>[], request: string, signal: AbortSignal, slot?: number) => new Promise<T>((resolve, reject) => {
    list.push({ name: request.split(':')[0], slot, signal, finish: value => resolve(value ?? (request as unknown as T)),
      fail: () => reject(new ModelError('provider_failed')), unwind: () => reject(signal.reason) });
    if (unwinds === 'held') return;
    let left = unwinds;
    const unwind = () => { if (left-- > 0) setImmediate(unwind); else reject(signal.reason); };
    signal.addEventListener('abort', unwind, { once: true });
  });
  const f = { time: 0, allowed: true, canWait: true, start: true, run: true };
  const scheduler = createScheduler({
    generate: (request: string, { signal, slot }: { signal: AbortSignal; slot?: number }) => held(calls, request, signal, slot),
    countInput(request: string, { signal }: { signal: AbortSignal }) {
      counted.push(request.split(':')[0]);
      return request.startsWith('held') ? held(counts, request, signal) : Promise.resolve(Number(request.split(':')[1] ?? 100));
    },
  }, { quietMs: 0, pollMs: 100000, now: () => f.time, backgroundAllowed: () => f.allowed, backgroundCanWait: () => f.canWait,
    agentCanStart: () => f.start, agentCanRun: () => f.run, log: event => { events.push(event); },
    holdBackgroundCall: hold(probes), holdAgentTurn: hold(turns), ...options });
  // A failed assertion must not leave the shutdown waiting for a call nobody ends.
  t.after(() => { for (const call of [...calls, ...counts]) call.unwind(); return scheduler.close(); });
  const started = async (count: number) => { while (calls.length < count) await turn(); };
  // A person's turn with one call in it, and that call's result.
  const open = (holder: string, request: string, turnOptions: TurnOptions = {}) => {
    const opened = scheduler.foreground.openTurn({ holder, ...turnOptions });
    return [opened, opened.generate(request)] as const;
  };
  // One call in a person's turn of its own, run to its end: the slot it ran in.
  const scene = async (holder: string, request = `${holder} scene`, turnOptions: TurnOptions = {}) => {
    const index = calls.length;
    const [opened, result] = open(holder, request, turnOptions);
    await started(index + 1);
    calls[index].finish(); await result; opened.end();
    return calls[index].slot;
  };
  return Object.assign(f, { scheduler, calls, counts, counted, events, probes, turns, started, open, scene });
}
type Fixture = ReturnType<typeof fixture>;
// A case of a table: its label, which its assertions repeat, the scheduler it needs, and what it does there.
type Row = { label: string; options?: SchedulerOptions<string>; unwinds?: number | 'held'; run: (f: Fixture, label: string) => Promise<void> };
const table = (rows: Row[]) => async (t: TestContext) => {
  for (const row of rows) await row.run(fixture(t, row.options, row.unwinds), row.label);
};
// Work prepared ahead for a reader: a picture described from the scene just read continues that scene's prompt.
const PICTURE = { yields: true, sharesPrefix: true } as const;
// Pools: three slots sharing 100000 cells, where each call reserves 1000 of output and no quiet window applies however
// long it is, and a pair where each call reserves 100.
const POOL: SchedulerOptions<string> = { slots: 3, poolTokens: 100000, outputTokens: () => 1000, quietMs: 60000 };
const PAIR: SchedulerOptions<string> = { slots: 2, poolTokens: 100000, outputTokens: () => 100 };

// One slot: people go in order, a probe gives way to anybody, and an agent's call waits for people but, once started,
// runs to its end. Agents and probes wait for the quiet window after a person's response, and for the GPU.
test('people are served one at a time and in order, and agents and probes wait for them, the quiet window and the GPU', table([
  { label: 'foreground preempts background and remains FIFO without overlapping work', run: async (f, label) => {
    const low = assert.rejects(f.scheduler.background.generate('experiment'), { code: 'background_preempted' }, label);
    const first = f.scheduler.foreground.generate('user one');
    const second = f.scheduler.foreground.generate('user two');
    await low; await turn();
    assert.deepEqual(f.calls.map(c => c.name), ['experiment', 'user one'], label);
    f.calls[1].finish(); assert.equal(await first, 'user one', label); await turn();
    assert.equal(f.calls[2].name, 'user two', label);
    f.calls[2].finish(); assert.equal(await second, 'user two', label);
  } },
  { label: 'quiet window starts after a foreground response; health checks do not reset it', options: { quietMs: 60000 }, run: async (f, label) => {
    const low = f.scheduler.background.generate('experiment');
    f.time = 59999; f.scheduler.tick(); assert.equal(f.calls.length, 0, label);
    const user = f.scheduler.foreground.generate('user');
    f.time = 70000; f.calls[0].finish(); await user; await turn();
    f.time = 129999; f.scheduler.tick(); assert.equal(f.calls.length, 1, label);
    f.time = 130000; f.scheduler.tick(); assert.equal(f.calls[1].name, 'experiment', label);
    f.calls[1].finish(); await low;
  } },
  { label: 'paused or draining GPU cancels background and does not acquire or renew a user lease', run: async (f, label) => {
    f.allowed = false;
    const low = f.scheduler.background.generate('experiment');
    f.scheduler.tick(); assert.equal(f.calls.length, 0, label);
    const rejected = assert.rejects(low, { code: 'background_unavailable' }, label);
    f.allowed = true; f.scheduler.tick(); assert.equal(f.calls.length, 1, label);
    f.allowed = false; f.scheduler.tick(); await rejected;
  } },
  { label: 'an agent call waits for people and the quiet window, then runs to its end while a person waits', options: { quietMs: 60000 },
    run: async (f, label) => {
      const user = f.scheduler.foreground.generate('user one');
      const agent = f.scheduler.agent.generate('agent call');
      f.time = 1000; f.calls[0].finish(); await user; await turn();
      f.time = 60999; f.scheduler.tick(); assert.equal(f.calls.length, 1, label);
      f.time = 61000; f.scheduler.tick(); assert.equal(f.calls[1].name, 'agent call', label);
      // A person arrives mid-call: the agent call is not aborted, the person is next.
      const waits: number[] = [];
      const next = f.scheduler.foreground.generate('user two', { onWait: ahead => { waits.push(ahead); } });
      await turn();
      assert.deepEqual([f.calls[1].signal.aborted, f.calls.length, waits], [false, 2, [1]], label);
      f.calls[1].finish(); assert.equal(await agent, 'agent call', label); await turn();
      assert.equal(f.calls[2].name, 'user two', label);
      f.calls[2].finish(); await next;
    } },
  { label: 'an agent call preempts a probe, starts only when allowed and stops only when it may not run', run: async (f, label) => {
    f.start = false;
    const preempted = assert.rejects(f.scheduler.background.generate('probe'), { code: 'background_preempted' }, label);
    const agent = f.scheduler.agent.generate('agent turn');
    await preempted; await turn();
    assert.deepEqual(f.calls.map(c => c.name), ['probe'], label);
    f.start = true; f.scheduler.tick(); assert.equal(f.calls[1].name, 'agent turn', label);
    // The start rule turning false (a person's job beginning) does not stop a running call; a pause does.
    f.start = false; f.scheduler.tick(); assert.equal(f.calls[1].signal.aborted, false, label);
    const stopped = assert.rejects(agent, { code: 'background_unavailable' }, label);
    f.run = false; f.scheduler.tick(); await stopped;
  } },
  { label: 'a pausing GPU ends waiting agent calls instead of leaving them queued', run: async (f, label) => {
    f.start = false;
    const rejected = assert.rejects(f.scheduler.agent.generate('agent turn'), { code: 'background_unavailable' }, label);
    f.run = false; f.scheduler.tick(); await rejected;
    assert.equal(f.calls.length, 0, label);
  } },
  { label: 'a waiting call hears how many calls are ahead of it, each time the number changes', run: async (f, label) => {
    const heard: Record<string, number[]> = { second: [], third: [] };
    const first = f.scheduler.foreground.generate('first');
    const [second, third] = ['second', 'third'].map(name => f.scheduler.foreground.generate(name, { onWait: ahead => { heard[name].push(ahead); } }));
    assert.deepEqual(heard, { second: [1], third: [2] }, label);
    f.calls[0].finish(); await first; await turn();
    assert.deepEqual(heard, { second: [1], third: [2, 1] }, label);
    f.calls[1].finish(); await second; await turn();
    f.calls[2].finish(); await third; await turn();
    // A turn's own next call goes first while the turn holds the slot, whoever else waits: nothing is ahead of it.
    const owner = f.scheduler.foreground.openTurn();
    const step = owner.generate('owner step');
    const other = f.scheduler.foreground.generate('other', { onWait: () => {} });
    f.calls[3].finish(); await step; await turn();
    const own: number[] = [];
    const next = owner.generate('owner next', { onWait: ahead => { own.push(ahead); } });
    await turn();
    assert.deepEqual([own, f.calls[4].name], [[], 'owner next'], label);
    f.calls[4].finish(); await next; owner.end(); await turn();
    f.calls[5].finish(); await other;
  } },
]));

// However a call is stopped before its result: by its caller while it waits or runs, as it completes, by its turn's
// end or by the shutdown. A call that never ran never reaches the provider.
test('a stopped call ends with the code of whoever stopped it, and a result that comes after the stop is dropped', table([
  { label: 'a cancelled queue entry never starts or reaches the provider, and progress tells queued from started', run: async (f, label) => {
    const events: string[] = [];
    const controller = new AbortController();
    const first = f.scheduler.foreground.generate('first');
    const next = f.scheduler.foreground.generate('next', { onQueued: () => events.push('queued'), onStart: () => events.push('started') });
    const cancelled = f.scheduler.foreground.generate('cancelled', { signal: controller.signal, onStart: () => events.push('cancelled started') });
    assert.deepEqual(events, ['queued'], label);
    controller.abort(); await assert.rejects(cancelled, { code: 'cancelled' }, label);
    f.calls[0].finish(); await first; await turn();
    assert.deepEqual(events, ['queued', 'started'], label);
    f.calls[1].finish(); await next; await turn();
    assert.deepEqual([events, f.calls.map(c => c.name)], [['queued', 'started'], ['first', 'next']], label);
  } },
  // The kinds of abort a person's signal carries, sent once the call runs: the provider sees only the slot's signal,
  // which the scheduler aborts with its own reason, and the call ends with that reason whatever the provider throws.
  ...[undefined, new ModelError('cancelled'), new ModelError('background_preempted'), 'timeout' as const].map((reason): Row => ({
    label: `a person's call stopped by ${reason === 'timeout' ? 'AbortSignal.timeout' : `abort(${reason ? `ModelError('${reason.code}')` : ''})`}`,
    unwinds: 'held', run: async (f, label) => {
      // AbortSignal.timeout does not keep Node alive.
      const alive = setTimeout(() => {}, 1000);
      const controller = new AbortController();
      const signal = reason === 'timeout' ? AbortSignal.timeout(30) : controller.signal;
      const call = f.scheduler.foreground.generate('person', { signal });
      const slot = f.calls[0].signal;
      if (reason === 'timeout') await new Promise(resolve => slot.addEventListener('abort', resolve, { once: true }));
      else controller.abort(reason);
      f.calls[0].fail();
      await assert.rejects(call, { code: 'cancelled' }, label);
      assert.ok(slot !== signal && slot.reason instanceof ModelError, label);
      clearTimeout(alive);
    } })),
  { label: 'a completed background result is discarded if cancellation raced its completion', unwinds: 'held', run: async (f, label) => {
    const controller = new AbortController();
    const low = f.scheduler.background.generate('experiment', { signal: controller.signal });
    controller.abort(); f.calls[0].finish();
    await assert.rejects(low, { code: 'cancelled' }, label);
  } },
  { label: 'background timeout frees the slot and shutdown cancels both active and queued work', options: { backgroundTimeoutMs: 10 },
    run: async (f, label) => {
      await assert.rejects(f.scheduler.background.generate('bounded'), { code: 'background_timeout' }, label);
      const ended = ['first', 'queued'].map(name => assert.rejects(f.scheduler.foreground.generate(name), { code: 'cancelled' }, label));
      await f.scheduler.close(); await Promise.all(ended);
      // The queued call never reached the provider, and a closed scheduler takes no more calls.
      assert.deepEqual(f.calls.map(c => c.name), ['bounded', 'first'], label);
      await assert.rejects(f.scheduler.foreground.generate('closed'), { code: 'cancelled' }, label);
    } },
  { label: 'ending a turn during a call stops the call, and an ended turn takes no more calls', run: async (f, label) => {
    const lost = f.scheduler.agent.openTurn();
    const running = assert.rejects(lost.generate('agent'), { code: 'cancelled' }, label);
    lost.end(); await running;
    await assert.rejects(lost.generate('late'), { code: 'cancelled' }, label);
  } },
]));

// The lease keeps the GPU up for the call (gpu.ts `keepAwake`), so it must end exactly once, on every way a call ends.
// An agent turn's hold lasts from its first call's start until it has ended and its last call has settled. A call
// stopped while the server still works for it, counting its size or unwinding, holds on until that work has ended.
const leases: Row[] = [
  { label: 'done, or failed', run: async (f, label) => {
    const done = f.scheduler.background.generate('done');
    assert.deepEqual(f.probes, [0], label);
    f.calls[0].finish(); await done;
    const failed = f.scheduler.background.generate('failed');
    f.calls[1].fail(); await assert.rejects(failed, { code: 'provider_failed' }, label);
    assert.equal(f.probes.length, 2, label);
  } },
  { label: 'cancelled while it runs, and while it waits: a waiting call holds its lease already', run: async (f, label) => {
    const running = new AbortController(), waiting = new AbortController();
    const first = f.scheduler.background.generate('running', { signal: running.signal });
    const second = f.scheduler.background.generate('waiting', { signal: waiting.signal });
    assert.deepEqual(f.probes, [0, 0], label);
    waiting.abort(); await assert.rejects(second, { code: 'cancelled' }, label);
    running.abort(); await assert.rejects(first, { code: 'cancelled' }, label);
  } },
  { label: 'preempted by a person, whose calls take no lease, or out of time', options: { backgroundTimeoutMs: 20 }, run: async (f, label) => {
    const probe = assert.rejects(f.scheduler.background.generate('preempted'), { code: 'background_preempted' }, label);
    const person = f.scheduler.foreground.generate('person');
    await probe; await turn();
    f.calls.at(-1)!.finish(); await person;
    await assert.rejects(f.scheduler.background.generate('slow'), { code: 'background_timeout' }, label);
    assert.equal(f.probes.length, 2, label);
  } },
  // The queue is empty before anything is awaited, so one that kept a probe fails here instead of hanging the test.
  { label: 'stopped once probes may not run, refused once they may not wait, and refused before the queue takes it', run: async (f, label) => {
    const stopped = f.scheduler.background.generate('stopped');
    const refused = f.scheduler.background.generate('refused');
    f.allowed = false; f.canWait = false; f.scheduler.tick();
    assert.equal(f.scheduler.snapshot().backgroundQueued, 0, label);
    await assert.rejects(stopped, { code: 'background_unavailable' }, label);
    await assert.rejects(refused, { code: 'background_unavailable' }, label);
    const notTaken = assert.rejects(f.scheduler.background.generate('not taken'), { code: 'background_unavailable' }, label);
    assert.equal(f.scheduler.snapshot().backgroundQueued, 0, label);
    await notTaken;
    assert.equal(f.probes.length, 2, label);
  } },
  { label: 'a full queue takes no fifth waiting call; the shutdown ends the running call and the waiting ones', run: async (f, label) => {
    const last = ['last', 'waiting 1', 'waiting 2', 'waiting 3', 'waiting 4'].map(name => f.scheduler.background.generate(name));
    await assert.rejects(f.scheduler.background.generate('full'), { code: 'queue_full' }, label);
    await f.scheduler.close();
    for (const call of last) await assert.rejects(call, { code: 'cancelled' }, label);
    await assert.rejects(f.scheduler.background.generate('closed'), { code: 'cancelled' }, label);
    assert.equal(f.probes.length, 5, label);
  } },
  { label: 'in a shared pool a call waits for its size first, and a count that fails ends it', options: PAIR, unwinds: 'held',
    run: async (f, label) => {
      const uncounted = f.scheduler.background.generate('held uncounted');
      f.counts[0].fail();
      await assert.rejects(uncounted, { code: 'provider_failed' }, label);
      assert.deepEqual([f.calls, f.probes.length], [[], 1], label);
    } },
  // A turn whose owner is gone holds its slot without calling the model: past `turnIdleMs` it is taken as lost, and the
  // slot goes to whoever waits for it. An agent's turn lets the GPU go with it.
  ...([['foreground', 'a person\'s'], ['agent', 'an agent\'s']] as const).map(([priority, whose]): Row => ({
    label: `a turn that holds the slot without calls for too long is taken as lost: ${whose}`, options: { turnIdleMs: 60000 },
    run: async (f, label) => {
      const owner = f.scheduler[priority].openTurn();
      const first = owner.generate('owner');
      f.calls[0].finish(); await first; await turn();
      const tester = f.scheduler.foreground.generate('tester');
      f.time = 59999; f.scheduler.tick(); assert.equal(f.calls.length, 1, label);
      f.time = 60000; f.scheduler.tick(); await turn();
      assert.deepEqual([f.calls[1].name, f.events.includes('turn_lost'), f.turns], ['tester', true, priority === 'agent' ? [1] : []], label);
      await assert.rejects(owner.generate('late'), { code: 'background_unavailable' }, label);
      f.calls[1].finish(); await tester;
    } })),
  { label: 'cancelling a queued call in a pool ends the token count it started, and the call settles after that count', options: PAIR,
    unwinds: 'held', run: async (f, label) => {
      const controller = new AbortController();
      const pending = f.scheduler.foreground.generate('held request', { signal: controller.signal });
      await turn();
      controller.abort();
      // The count was under way and is stopped, not left to finish on its own; the call waits for it to end.
      assert.deepEqual([f.counts[0].signal.aborted, await unsettled(pending)], [true, true], label);
      f.counts[0].unwind();
      await assert.rejects(pending, { code: 'cancelled' }, label);
      assert.deepEqual(f.calls, [], label);
    } },
  // Cancelled by whoever asked; refused as the GPU pauses, which waits for the count as it would for the call; or
  // cancelled by the shutdown, which returns only once the count has ended.
  ...[['cancelled', 'cancelled'], ['refused', 'background_unavailable'], ['shut', 'cancelled']].map(([way, code]): Row => ({
    label: `a probe stopped while its size is counted keeps its lease until that count has ended, however it is stopped: ${way}`,
    options: PAIR, unwinds: 'held', run: async (f, label) => {
      const controller = new AbortController();
      const probe = f.scheduler.background.generate(`held ${way}`, { signal: controller.signal });
      await turn();
      if (way === 'cancelled') controller.abort();
      if (way === 'refused') { f.canWait = false; f.scheduler.tick(); assert.equal(f.scheduler.snapshot().backgroundQueued, 0, label); }
      const closed = way === 'shut' ? f.scheduler.close() : undefined;
      assert.deepEqual([f.counts[0].signal.aborted, await unsettled(closed ?? probe), await unsettled(probe), f.probes],
        [true, true, true, [0]], label);
      f.counts[0].unwind();
      await closed;
      await assert.rejects(probe, { code }, label);
      assert.deepEqual([f.probes, f.calls], [[1], []], label);
    } })),
  { label: 'an ended agent turn lets the GPU go only once its calls have ended, a count of its own included', options: PAIR, unwinds: 'held',
    run: async (f, label) => {
      // Its first call takes a slot, and the GPU with it.
      const agent = f.scheduler.agent.openTurn({ holder: 'agent' });
      const first = agent.generate('first');
      await turn();
      f.calls[0].finish(); await first;
      assert.deepEqual(f.turns, [0], label);
      // Ended while its next call is sized: the count is stopped, and the GPU is held until it has ended.
      const next = agent.generate('held next');
      await turn();
      agent.end();
      assert.deepEqual([f.counts[0].signal.aborted, await unsettled(next), f.turns], [true, true, [0]], label);
      f.counts[0].unwind();
      await assert.rejects(next, { code: 'cancelled' }, label);
      assert.deepEqual(f.turns, [1], label);
      // Ended during a call: the call is stopped, and the GPU is held until it has ended.
      const second = f.scheduler.agent.openTurn({ holder: 'agent' });
      const running = second.generate('running');
      await turn();
      second.end();
      assert.deepEqual([f.calls[1].signal.aborted, await unsettled(running), f.turns], [true, true, [1, 0]], label);
      f.calls[1].unwind();
      await assert.rejects(running, { code: 'cancelled' }, label);
      assert.deepEqual(f.turns, [1, 1], label);
      // Ended while it counts beside the slots: the end does not stop that count, only its caller's signal would, and
      // the GPU is held until the count has ended.
      const third = f.scheduler.agent.openTurn({ holder: 'agent' });
      const call = third.generate('call');
      await turn();
      f.calls[2].finish(); await call;
      const count = third.countInput!('held count');
      third.end();
      assert.deepEqual([await unsettled(count), f.turns], [true, [1, 1, 0]], label);
      f.counts[1].finish(4321);
      assert.equal(await count, 4321, label);
    } },
  // A probe's count in a pool runs beside the slots, but it is a probe's call all the same (local/gpu.ts): it waits for
  // the GPU as a probe's generation does, holds its lease until it has ended, and stops when the GPU goes away.
  { label: 'a probe\'s count in a pool keeps to the probes\' rules beside the slots, and holds its lease until it has ended',
    options: { ...PAIR, sharedCache: false }, unwinds: 'held', run: async (f, label) => {
      // While the GPU pauses, it is refused before the queue takes it, and the server hears nothing. That is checked
      // before anything is awaited, so a count sent all the same fails here instead of hanging the test.
      f.allowed = false; f.canWait = false;
      const refused = assert.rejects(f.scheduler.background.countInput!('held refused'), { code: 'background_unavailable' }, label);
      assert.deepEqual([f.counts.length, f.probes], [0, []], label);
      await refused;
      // While the GPU is not ready, it waits in the probes' queue and holds its lease from the start.
      f.canWait = true;
      const waiting = f.scheduler.background.countInput!('held waiting');
      f.scheduler.tick(); await turn();
      assert.deepEqual([f.counts.length, f.scheduler.snapshot().backgroundQueued, f.probes], [0, 1, [0]], label);
      // Once a probe may run, it runs at once, though people hold every slot and one more waits for a slot: the count
      // keeps nobody from a slot, so nobody stops it.
      const people = ['owner', 'tester', 'reader'].map(name => f.scheduler.foreground.generate(name));
      f.allowed = true; f.scheduler.tick(); await turn();
      assert.deepEqual([f.calls.map(call => call.name), f.counts.map(count => count.name), f.counts[0].signal.aborted],
        [['owner', 'tester'], ['held waiting'], false], label);
      f.counts[0].finish(4321);
      assert.deepEqual([await waiting, f.probes], [4321, [1]], label);
      // The GPU going away stops it, and the lease is held until the count has ended.
      const stopped = f.scheduler.background.countInput!('held stopped');
      await turn();
      f.allowed = false; f.scheduler.tick();
      assert.deepEqual([f.counts[1].signal.aborted, await unsettled(stopped), f.probes], [true, true, [1, 0]], label);
      f.counts[1].unwind();
      await assert.rejects(stopped, { code: 'background_unavailable' }, label);
      f.calls[0].finish(); f.calls[1].finish(); await turn();
      f.calls[2].finish();
      assert.deepEqual(await Promise.all(people), ['owner', 'tester', 'reader'], label);
    } },
  // A probe's wait to start is limited, counted from the moment the queue takes it: the first tick after ten minutes
  // refuses it, so that a GPU that never becomes ready for it (in error, or starting) is not kept up for it indefinitely.
  { label: 'a probe still waiting ten minutes after the queue took it is refused at the next tick', options: { ...PAIR, sharedCache: false },
    unwinds: 'held', run: async (f, label) => {
      f.allowed = false;
      const first = f.scheduler.background.generate('first');
      f.time = 5 * 60000;
      const second = f.scheduler.background.generate('second');
      // A probe's count in a pool waits in the same queue, and as long.
      const count = f.scheduler.background.countInput!('held count');
      f.time = 10 * 60000 - 1; f.scheduler.tick();
      assert.deepEqual([f.scheduler.snapshot().backgroundQueued, f.probes], [3, [0, 0, 0]], label);
      // Each is refused at its own deadline, and lets its lease go at once: nothing of it ran.
      f.time = 10 * 60000; f.scheduler.tick();
      assert.deepEqual([f.scheduler.snapshot().backgroundQueued, f.probes], [2, [1, 0, 0]], label);
      await assert.rejects(first, { code: 'background_timeout' }, label);
      f.time = 15 * 60000; f.scheduler.tick();
      assert.deepEqual([f.scheduler.snapshot().backgroundQueued, f.probes], [0, [1, 1, 1]], label);
      await assert.rejects(second, { code: 'background_timeout' }, label);
      await assert.rejects(count, { code: 'background_timeout' }, label);
      // Only the wait is limited here: a probe that starts in time runs on under its own limit.
      const third = f.scheduler.background.generate('third');
      f.time = 25 * 60000 - 1; f.allowed = true; f.scheduler.tick();
      f.time = 40 * 60000; f.scheduler.tick();
      assert.deepEqual([f.calls.map(call => call.name), f.calls[0].signal.aborted, f.counts], [['third'], false, []], label);
      f.calls[0].finish(); assert.equal(await third, 'third', label);
    } },
];
test("a probe's call holds its lease from the moment the queue takes it until it settles, whichever way it ends", async t => {
  for (const row of leases) {
    const f = fixture(t, row.options, row.unwinds);
    await row.run(f, row.label);
    // Every hold on the GPU that was taken has been let go, and only once.
    assert.ok([...f.probes, ...f.turns].every(count => count === 1), row.label);
  }
});

// A turn holds its slot from its first call until it ends, so that nobody else's prompt evicts its cache between its
// calls. Work prepared ahead for a reader yields to anybody but that reader, and a picture, which continues the reader's
// own prompt, to that reader too: it runs in their slot or nowhere.
test('a turn keeps its slot between its calls, and work prepared ahead for a reader gives way', table([
  // A provider that serves kinds of work apart (local/serving.ts) learns whose each call is from the queue it came
  // through, on every way a call reaches it: through a slot, and in a pool also the count that runs beside the slots
  // and the count a shared cache sizes a call by before admitting it. Whatever a caller writes into its own controls.
  ...[{ slots: 1, sharedCache: true }, { slots: 2, sharedCache: true }, { slots: 2, sharedCache: false }].map(({ slots, sharedCache }): Row => ({
    label: `the provider hears the priority and holder of every call, and a caller cannot name its own: ${slots} slots, ${
      sharedCache ? 'shared' : 'isolated'}`, run: async (_f, label) => {
      const seen: string[] = [];
      const heard = (request: string, { priority, holder }: Controls) => { seen.push(`${request} ${priority} ${holder}`); };
      const scheduler = createScheduler({
        generate: async (request: string, controls: Controls) => { heard(request, controls); return request; },
        countInput: async (request: string, controls: Controls) => { heard(`count ${request}`, controls); return 100; },
      }, { quietMs: 0, pollMs: 100000, slots, poolTokens: 100000, sharedCache, outputTokens: () => 100 });
      const claims = { priority: 'foreground', holder: 'someone else' } as const;
      // A reader's scene, then the work the bot does ahead for them: a picture's description, and a compaction prepared
      // while they read. Then a call of nobody's, an agent's turn and a probe.
      const readers = [[{}, 'scene', { ...claims, priority: 'background' }], [{ sharesPrefix: true }, 'ahead', claims],
        [{ yields: true }, 'ahead', claims]] as const;
      for (const [options, request, controls] of readers) {
        const opened = scheduler.foreground.openTurn({ holder: 'tester', ...options });
        await opened.countInput!(request, controls); await opened.generate(request, controls); opened.end();
      }
      await scheduler.foreground.countInput!('unheld', claims); await scheduler.foreground.generate('unheld', claims);
      const agent = scheduler.agent.openTurn();
      await agent.countInput!('agent', claims); await agent.generate('agent', claims); agent.end();
      await scheduler.background.countInput!('probe', claims); await scheduler.background.generate('probe', claims);
      await scheduler.close();
      // A shared cache sizes every generation first, with the same word on whose it is; a count is never sized.
      const call = (request: string, whose: string) =>
        [`count ${request} ${whose}`, ...slots > 1 && sharedCache ? [`count ${request} ${whose}`] : [], `${request} ${whose}`];
      assert.deepEqual(seen, [...call('scene', 'foreground tester'), ...call('ahead', 'foreground tester'), ...call('ahead', 'foreground tester'),
        ...call('unheld', 'foreground undefined'), ...call('agent', 'agent undefined'), ...call('probe', 'background undefined')], label);
    } })),
  { label: 'an agent turn holds the slot and the GPU between its calls, and a person waits for its end', options: { quietMs: 60000 },
    run: async (f, label) => {
      f.time = 60000;
      const agentTurn = f.scheduler.agent.openTurn();
      // Opening a turn reserves nothing; the first call's actual start does.
      assert.deepEqual(f.turns, [], label);
      const compaction = agentTurn.generate('agent compaction');
      assert.equal(f.calls[0].name, 'agent compaction', label);
      f.calls[0].finish(); await compaction; await turn();
      // Between the turn's calls a probe does not take the slot.
      const probe = f.scheduler.background.generate('probe');
      await turn(); assert.equal(f.calls.length, 1, label);
      const scene = agentTurn.generate('agent scene');
      await turn();
      assert.deepEqual([f.calls.map(c => c.name), f.turns], [['agent compaction', 'agent scene'], [0]], label);
      // A person arrives: the quiet window restarts, yet the running call goes on, and the turn keeps the slot after it.
      const user = f.scheduler.foreground.generate('user');
      await turn();
      assert.equal(f.calls[1].signal.aborted, false, label);
      f.calls[1].finish(); await scene; await turn();
      assert.equal(f.calls.length, 2, label);
      agentTurn.end(); await turn();
      assert.deepEqual([f.turns, f.calls[2].name, f.events.filter(event => event === 'background_preempted')], [[1], 'user', []], label);
      // The probe stays behind the person.
      f.calls[2].finish(); await user;
      f.time = 200000; f.scheduler.tick(); await turn();
      assert.equal(f.calls[3].name, 'probe', label);
      f.calls[3].finish(); await probe;
    } },
  { label: 'a yielding turn ends when anybody but its holder calls, and its holder waits for it', run: async (f, label) => {
    const [prepared, first] = f.open('tester', 'prepared extraction', { yields: true });
    // Its holder's own turn waits behind it.
    const [tester, count] = f.open('tester', 'tester count');
    await turn();
    assert.equal(f.calls[0].signal.aborted, false, label);
    f.calls[0].finish(); await first; await turn();
    const repair = prepared.generate('prepared repair');
    await turn();
    assert.deepEqual(f.calls.map(call => call.name), ['prepared extraction', 'prepared repair'], label);
    // Another person's call ends it at once.
    const stopped = assert.rejects(repair, { code: 'background_preempted' }, label);
    const owner = f.scheduler.foreground.generate('owner scene');
    await stopped; await turn();
    assert.equal(f.calls[2].name, 'tester count', label);
    f.calls[2].finish(); await count; tester.end(); await turn();
    assert.equal(f.calls[3].name, 'owner scene', label);
    f.calls[3].finish(); await owner; prepared.end();
  } },
  { label: 'a turn that shares its holder\'s prefix yields to that holder too, unlike a prepared compaction', run: async (f, label) => {
    await f.scene('tester');
    // `sharesPrefix` alone is work prepared ahead as well: no `yields` is needed for it to give way.
    const [picture, described] = f.open('tester', 'picture', { sharesPrefix: true });
    await turn();
    assert.equal(f.calls[1].name, 'picture', label);
    // Its holder's own next turn does not wait for it and does not take its result: it wants the slot the picture is in.
    const stopped = assert.rejects(described, { code: 'background_preempted' }, label);
    const [again, next] = f.open('tester', 'tester next');
    await stopped; await turn();
    assert.equal(f.calls[2].name, 'tester next', label);
    f.calls[2].finish(); await next; again.end(); picture.end();
  } },
  { label: 'a picture runs on no slot but the one its own holder\'s prefix is in, with a single slot as with a pool', run: async (f, label) => {
    await f.scene('owner');
    // The one slot holds the owner's prompt now, so there is no prefix of the tester's to continue: the picture would
    // prefill from nothing and evict the owner's cache for work nobody waits for.
    await assert.rejects(f.open('tester', 'tester picture', PICTURE)[1], { code: 'background_unavailable' }, label);
    assert.equal(f.calls.length, 1, label);
  } },
  { label: 'a prefix-sharing call gives up the slot rather than queue for it, and waits only on a call already stopped', run: async (f, label) => {
    const [tester, scene] = f.open('tester', 'tester scene');
    f.calls[0].finish(); await scene; await turn();
    // Its holder's turn holds the slot between its own calls: waiting there is waiting for the work the picture is for.
    await assert.rejects(f.open('tester', 'picture', PICTURE)[1], { code: 'background_unavailable' }, label);
    assert.equal(f.calls.length, 1, label);
    tester.end(); await turn();
    // A call already stopped is on its way out of the slot and leaves the prefix behind it, so the next picture waits
    // that moment out instead of giving up.
    const [cut, dropped] = f.open('tester', 'tester scene again');
    await turn();
    const cancelled = assert.rejects(dropped, { code: 'cancelled' }, label);
    cut.end();
    const [picture, described] = f.open('tester', 'picture again', PICTURE);
    await cancelled; await turn();
    assert.equal(f.calls[2].name, 'picture again', label);
    f.calls[2].finish(); await described; picture.end();
  } },
]));

// A pool of llama-server slots runs a call in each slot at once. People take the highest slots, which llama.cpp evicts
// last; agents and probes never take the highest one, and a holder goes back to the slot its cache is in. Token
// counting runs beside the slots. Whoever the pool keeps waiting stops the probes in the way, and a person also ends
// other people's work prepared ahead.
test('a pool runs a call in each slot: people in the highest, agents and probes below, each holder back in its own', table([
  // Isolated slots hold one request each, so a call the shared-cache arithmetic would never admit runs at once, and
  // nothing is sized before it.
  ...[{ label: 'a pool runs calls side by side, gives a person the highest slot and keeps a holder in its slot', options: POOL, size: '' },
    { label: 'isolated slots run side by side without counting tokens or dividing a cache', size: ':60000',
      options: { ...POOL, sharedCache: false, poolTokens: 1000 } },
  ].map(({ label, options, size }): Row => ({ label, options, run: async (f, label) => {
    const tester = f.scheduler.foreground.openTurn({ holder: 'tester' });
    const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
    // No quiet window: an agent and a probe run beside the person at once.
    const done = [tester.generate(`tester scene${size}`), agentTurn.generate(`agent scene${size}`), f.scheduler.background.generate(`probe${size}`)];
    await f.started(3);
    assert.deepEqual([f.calls.map(call => [call.name, call.slot]), f.scheduler.snapshot().activeCount, f.counted.length],
      [[['tester scene', 2], ['agent scene', 0], ['probe', 1]], 3, options.sharedCache === false ? 0 : 3], label);
    for (const call of f.calls) call.finish();
    await Promise.all(done); tester.end(); agentTurn.end();
    // The next turns go back to the same slots, where their caches are.
    assert.equal(await f.scene('tester', 'tester next'), 2, label);
  } })),
  { label: 'a compaction prepared ahead leaves its holder\'s scenes in their slot, and the next scene goes back to them', options: POOL,
    run: async (f, label) => {
      // Another system prompt, so nothing of the scenes would survive it: it takes the lowest slot that keeps nobody's.
      // With other people's scenes in every other slot it costs its holder's own, never theirs, and leaves it nobody's.
      const steps = [['tester', 'tester scene', 2, false], ['tester', 'prepared extraction', 0, true], ['tester', 'tester next', 2, false],
        ['owner', 'owner scene', 1, false], ['guest', 'guest scene', 0, false], ['tester', 'prepared again', 2, true],
        ['tester', 'tester after', 2, false], ['owner', 'owner next', 1, false]] as const;
      for (const [holder, request, slot, yields] of steps) assert.equal(await f.scene(holder, request, { yields }), slot, `${label}: ${request}`);
    } },
  { label: 'a pool counts tokens outside its slots, even while every slot is busy', options: { ...POOL, slots: 2 }, run: async (f, label) => {
    const busy = [f.scheduler.agent.generate('agent'), f.scheduler.foreground.generate('tester')];
    await f.started(2);
    assert.equal(await f.scheduler.foreground.countInput!('count:4321'), 4321, label);
    assert.ok(f.counted.includes('count'), label);
    f.calls[0].finish(); f.calls[1].finish(); await Promise.all(busy);
  } },
  { label: 'a person waiting for an isolated slot still stops a probe holding it', options: { ...POOL, sharedCache: false, slots: 2 },
    run: async (f, label) => {
      const probe = f.scheduler.background.generate('probe');
      const [owner, first] = f.open('owner', 'owner:100');
      await f.started(2);
      // Both slots are busy, so the next person has nowhere to go until the probe gives way.
      const preempted = assert.rejects(probe, { code: 'background_preempted' }, label);
      const tester = f.scheduler.foreground.generate('tester:100');
      await preempted; await f.started(3);
      assert.equal(f.calls[2].name, 'tester', label);
      f.calls[2].finish(); await tester;
      f.calls[1].finish(); await first; owner.end();
    } },
  { label: 'a person kept from a pool stops probes and another person\'s yielding turn', options: { ...POOL, slots: 2 }, run: async (f, label) => {
    const probe = f.scheduler.background.generate('probe');
    const [prepared, extraction] = f.open('owner', 'prepared', { yields: true });
    await f.started(2);
    assert.deepEqual(f.calls.map(call => [call.name, call.slot]), [['probe', 0], ['prepared', 1]], label);
    const stopped = [probe, extraction].map(call => assert.rejects(call, { code: 'background_preempted' }, label));
    const tester = f.scheduler.foreground.generate('tester');
    await Promise.all(stopped); await f.started(3);
    assert.equal(f.calls[2].name, 'tester', label);
    f.calls[2].finish(); await tester; prepared.end();
  } },
  { label: 'with room in a pool nobody yields to a person', options: POOL, run: async (f, label) => {
    const [ahead, kept] = f.open('owner', 'prepared', { yields: true });
    const person = f.scheduler.foreground.generate('tester');
    await f.started(2);
    assert.equal(f.calls[0].signal.aborted, false, label);
    f.calls[1].finish(); await person;
    f.calls[0].finish(); await kept; ahead.end();
  } },
  { label: 'an agent kept by a probe in a pool stops it, and a turn waiting for room is not lost', options: { ...POOL, slots: 2, turnIdleMs: 60000 },
    run: async (f, label) => {
      const probe = f.scheduler.background.generate('probe');
      await f.started(1);
      const preempted = assert.rejects(probe, { code: 'background_preempted' }, label);
      const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
      const call = agentTurn.generate('agent call');
      await preempted; await f.started(2);
      assert.equal(f.calls[1].name, 'agent call', label);
      f.calls[1].finish(); await call;
      // A turn whose next call waits for a busy pool keeps its slot; only a silent one is lost.
      const [person, scene] = f.open('tester', 'tester:100');
      await f.started(3);
      const next = agentTurn.generate('agent next:99000');
      f.time = 120000; f.scheduler.tick(); await turn();
      assert.equal(f.calls.length, 3, label);
      f.calls[2].finish(); await scene; person.end();
      agentTurn.end();
      await assert.rejects(next, { code: 'cancelled' }, label);
    } },
  { label: 'an agent between its own calls stops a probe that leaves it no room', options: { ...POOL, poolTokens: 65536 }, run: async (f, label) => {
    const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
    const small = agentTurn.generate('agent small:1000');
    await f.started(1);
    f.calls[0].finish(); await small;
    const probe = f.scheduler.background.generate('probe:40000');
    await f.started(2);
    // The turn holds its slot, so nothing but the probe stands between it and the model.
    const preempted = assert.rejects(probe, { code: 'background_preempted' }, label);
    const big = agentTurn.generate('agent big:30000');
    await preempted; await f.started(3);
    assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['agent big', 0], label);
    f.calls[2].finish(); await big; agentTurn.end();
  } },
]));

// A picture continues its holder's last scene, so it runs in the slot that scene's prompt is cached in, or not at all:
// anywhere else it would prefill from nothing and evict somebody's cache. It gives way to its holder's next call and to
// any person the pool keeps waiting, and it never waits for ever for a slot it cannot have.
test('a picture in a pool runs in its holder\'s slot or nowhere, and gives way to its holder and to people kept waiting', table([
  // Its holder's next call ends it, for a count as for a scene and however free the pool, and goes back to that slot,
  // waiting the moments out while the picture leaves it.
  ...[
    { label: 'a picture described from the last scene runs in its holder\'s slot and leaves the scenes in it', finishes: true },
    { label: 'a picture ends the moment its holder calls again, however much room the pool has' },
    { label: 'a person\'s token count in a pool ends the picture in their slot, as their scene does', next: 'tester next:9000', counts: true },
    { label: 'the holder waits for the slot a picture is still leaving, rather than take a free one', unwinds: 2 },
    { label: 'a picture leaves its holder one slot in the pool, not two', poolTokens: 40000, unwinds: 2, scene: 'tester:9000',
      picture: 'picture:9000', next: 'tester next:9000', after: async (f: Fixture, label: string) => {
        // A slot the tester never came back to would still hold a reader's whole reserve: 2048 + 15000 + 10000 + 1000 +
        // 1024 leave this agent room beside one such cache, and 12024 less than it needs beside two.
        const agent = f.scheduler.agent.generate('agent:14000');
        await turn(); await turn();
        assert.deepEqual(f.calls.slice(3).map(call => call.name), ['agent'], label);
        f.calls[3].finish(); await agent;
      } },
  ].map((row): Row => ({ label: row.label, options: { ...POOL, poolTokens: row.poolTokens ?? 100000 }, unwinds: row.unwinds,
    run: async (f, label) => {
      assert.equal(await f.scene('tester', row.scene), 2, label);
      const [picture, described] = f.open('tester', row.picture ?? 'picture', PICTURE);
      await f.started(2);
      assert.equal(f.calls[1].slot, 2, label);
      // Finished, or ended by its holder's next call, it leaves the tester's scenes in the slot, and that call goes back there.
      if (row.finishes) { f.calls[1].finish(); await described; picture.end(); }
      const stopped = row.finishes || assert.rejects(described, { code: 'background_preempted' }, label);
      const again = f.scheduler.foreground.openTurn({ holder: 'tester' });
      if (row.counts) { assert.equal(await again.countInput!(row.next!), 9000, label); await stopped; }
      const next = again.generate(row.next ?? 'tester next');
      await stopped; await f.started(3);
      assert.deepEqual([f.calls[2].name, f.calls[2].slot], ['tester next', 2], label);
      f.calls[2].finish(); await next; again.end(); picture.end();
      await row.after?.(f, label);
    } })),
  { label: 'a holder waiting for the slot its picture is leaving keeps nobody behind it', options: POOL, unwinds: 2, run: async (f, label) => {
    await f.scene('tester');
    // Another person's compaction, prepared while they read, in a slot the tester does not want.
    const [prepared, extraction] = f.open('owner', 'prepared extraction', { yields: true });
    await f.started(2);
    const [picture, described] = f.open('tester', 'picture', PICTURE);
    await f.started(3);
    assert.deepEqual([f.calls[1].slot, f.calls[2].slot], [0, 2], label);
    const stopped = assert.rejects(described, { code: 'background_preempted' }, label);
    const [again, next] = f.open('tester', 'tester next');
    // The tester waits for one slot of the three, and holds up nothing while they wait: a person behind them runs in a
    // free slot, and the compaction prepared for a third person is in nobody's way, so it is not ended for them.
    const guest = f.scheduler.foreground.generate('guest scene');
    await stopped; await f.started(5);
    assert.deepEqual([f.calls.slice(3).map(call => [call.name, call.slot]), f.calls[1].signal.aborted],
      [[['guest scene', 1], ['tester next', 2]], false], label);
    f.calls[1].finish(); await extraction; prepared.end();
    f.calls[3].finish(); await guest;
    f.calls[4].finish(); await next; again.end(); picture.end();
  } },
  { label: 'a picture ended while its own call is still being enqueued takes no place in the queue', options: { ...POOL, slots: 2 },
    run: async (f, label) => {
      const people = ['one', 'two'].map(name => f.scheduler.foreground.generate(name));
      await f.started(2);
      const three = f.scheduler.foreground.generate('three');
      await turn(); await turn();
      assert.equal(f.scheduler.snapshot().foregroundQueued, 1, label);
      // Opening a second picture for the same holder ends the first one, and the person waiting for a slot ends this one
      // in the same breath, before its call is even queued. The call is refused, rather than left waiting for a turn
      // that is over and that nothing would end a second time.
      const first = f.scheduler.foreground.openTurn({ holder: 'tester', ...PICTURE });
      const second = f.scheduler.foreground.openTurn({ holder: 'tester', ...PICTURE });
      await assert.rejects(second.generate('picture'), { code: 'background_preempted' }, label);
      first.end(); second.end();
      // The queues run on: the person who was waiting takes the first slot to come free.
      f.calls[0].finish(); await f.started(3);
      assert.equal(f.calls[2].name, 'three', label);
      f.calls[1].finish(); f.calls[2].finish();
      await Promise.all([...people, three]);
    } },
  { label: 'a picture stays while another person has room and gives way to the one who has none', options: { ...POOL, slots: 2 },
    run: async (f, label) => {
      assert.equal(await f.scene('owner'), 1, label);
      const [picture, described] = f.open('owner', 'picture', PICTURE);
      await f.started(2);
      // The picture keeps nobody from the model while a slot is free: another person runs beside it.
      const tester = f.scheduler.foreground.generate('tester');
      await f.started(3);
      assert.deepEqual([f.calls[1].slot, f.calls[2].name, f.calls[2].slot, f.calls[1].signal.aborted], [1, 'tester', 0, false], label);
      // The next person has nowhere to go, and the picture gives way like any work prepared ahead.
      const stopped = assert.rejects(described, { code: 'background_preempted' }, label);
      const guest = f.scheduler.foreground.generate('guest');
      await stopped; await f.started(4);
      assert.equal(f.calls[3].name, 'guest', label);
      f.calls[2].finish(); f.calls[3].finish(); await Promise.all([tester, guest]); picture.end();
    } },
  { label: 'a picture gives up when the slot its prefix is in is not to be had', options: { ...POOL, slots: 2 }, run: async (f, label) => {
    // Nothing of the tester's is cached in any slot: there is no prefix to continue, and waiting for one would only
    // keep the GPU awake for a picture that would still start from nothing.
    await assert.rejects(f.open('tester', 'picture', PICTURE)[1], { code: 'background_unavailable' }, label);
    assert.equal(f.calls.length, 0, label);
    const [tester, scene] = f.open('tester', 'tester scene');
    await f.started(1);
    // Now the slot is the tester's own turn's: the picture would queue behind the work it is for.
    await assert.rejects(f.open('tester', 'picture', PICTURE)[1], { code: 'background_unavailable' }, label);
    assert.equal(f.calls.length, 1, label);
    f.calls[0].finish(); await scene; tester.end();
  } },
  { label: 'a prefix-sharing turn of the agent interface gives up at once instead of holding the GPU awake', options: POOL,
    run: async (f, label) => {
      assert.deepEqual([await f.scene('tester'), await f.scene('owner')], [2, 1], label);
      // The agent interface opens turns with the same options, but agents take no person's slot, and the tester's prefix
      // is in one: this turn could only wait for ever, keeping the GPU from idling (bot.ts `prepareNext`).
      const picture = f.scheduler.agent.openTurn({ holder: 'tester', sharesPrefix: true });
      await assert.rejects(picture.generate('picture'), { code: 'background_unavailable' }, label);
      // The owner's cache is in a slot agents do use, and it is still the owner's: a turn of theirs is refused there too,
      // rather than run where it would cost the owner their reserve.
      const lower = f.scheduler.agent.openTurn({ holder: 'owner', sharesPrefix: true });
      await assert.rejects(lower.generate('owner picture'), { code: 'background_unavailable' }, label);
      assert.deepEqual([f.calls.length, f.scheduler.snapshot().agentQueued], [2, 0], label);
    } },
  // It is refused while agents may not start at all, where nothing else would ever look at it again, and in a slot
  // agents do choose from: `place` never reaches it, and no reservation makes it late enough to be taken as lost.
  { label: 'a prefix-sharing turn of the agent interface gives up at once while agents may not start', options: POOL, run: async (f, label) => {
    f.start = false;
    assert.deepEqual([await f.scene('first'), await f.scene('guest')], [2, 1], label);
    const shut = f.scheduler.agent.openTurn({ holder: 'guest', sharesPrefix: true });
    await assert.rejects(shut.generate('guest picture'), { code: 'background_unavailable' }, label);
    assert.equal(f.calls.length, 2, label);
  } },
  { label: 'a picture is admitted beside the cache it fills again, and refused beside another reader\'s', options: { ...POOL, poolTokens: 30000 },
    run: async (f, label) => {
      await f.scene('tester', 'tester:12000');
      // A compaction prepared ahead of this size ends here: 2048 margin + 16000 claim + the tester's 13000 cache, 1000
      // output and 1024 of growth exceed 30000. The picture fills that cache again, and its own slot is not counted.
      assert.equal(await f.scene('tester', 'picture:15000', PICTURE), 2, label);
      assert.equal(await f.scene('owner', 'owner:10000'), 1, label);
      // Another reader's idle cache counts against it as against any work prepared ahead: 2048 + 16000 + 11000 + 1000 +
      // 1024 exceed 30000, and that cache stays until the owner comes back.
      await assert.rejects(f.open('tester', 'picture again:15000', PICTURE)[1], { code: 'background_unavailable' }, label);
    } },
  // `name:inputTokens:outputTokens`, so a description's small output limit tells itself from a scene's.
  { label: 'a picture leaves its holder\'s next scene the output room that scene asked for', options: { ...POOL, slots: 2, poolTokens: 40000,
    outputTokens: request => Number(request.split(':')[2] ?? 1000) }, run: async (f, label) => {
    await f.scene('tester', 'tester:10000:4000');
    assert.equal(await f.scene('tester', 'picture:14000:500', PICTURE), 1, label);
    // The slot holds 14500 cells now, and the tester's next scene still wants 4000 of output and 1024 of growth beside
    // them: 2048 + 20000 + 19524 exceed 40000, however little the description itself asked to write.
    const agent = f.scheduler.agent.generate('agent:19000:1000');
    await turn(); await turn();
    assert.equal(f.calls.length, 2, label);
    // With that cache gone the same call fits.
    f.scheduler.forget(); f.scheduler.tick();
    await f.started(3);
    assert.equal(f.calls[2].name, 'agent', label);
    f.calls[2].finish(); await agent;
  } },
  { label: 'a picture still queued gives way to its holder\'s own call waiting for room', options: { ...POOL, slots: 2, poolTokens: 30000 },
    run: async (f, label) => {
      await f.scene('tester', 'tester:2000');
      const agent = f.scheduler.agent.generate('agent:20000');
      await f.started(2);
      // The tester's next scene does not fit beside the agent's 21000 and waits for it.
      const [again, next] = f.open('tester', 'tester next:8000');
      await turn(); await turn();
      assert.equal(f.scheduler.snapshot().foregroundQueued, 1, label);
      // A picture opened after that call queues behind it and ends for it: the scene is what the tester is waiting for.
      await assert.rejects(f.open('tester', 'picture:100', PICTURE)[1], { code: 'background_preempted' }, label);
      f.calls[1].finish(); await agent; await f.started(3);
      assert.equal(f.calls[2].name, 'tester next', label);
      f.calls[2].finish(); await next; again.end();
    } },
]));

// A shared cache admits a call only with room for its claim beside every running call and every other turn between
// its calls and, unless it is a person's scene, beside every person's idle cache with room for their next request:
// llama.cpp evicts idle caches for a running call, but work done ahead of need is not worth anybody's scenes.
test('a pool admits a call only with room for it, keeps people\'s caches from work done ahead, and ends such work that never fits', table([
  { label: 'a compaction prepared ahead that people\'s idle caches leave no room for ends, rather than wait for ever',
    options: { ...POOL, poolTokens: 30000 }, run: async (f, label) => {
      // While the scene runs, its claim is what is in the way, and that ends: the extraction waits.
      const [tester, scene] = f.open('tester', 'tester:12000');
      await f.started(1);
      // 2048 margin + 16000 claim + the scene's 13000 exceed 30000.
      const [prepared, extraction] = f.open('tester', 'prepared:15000', { yields: true });
      const ended = assert.rejects(extraction, { code: 'background_unavailable' }, label);
      await turn(); await turn();
      assert.deepEqual([f.calls.length, f.scheduler.snapshot().foregroundQueued], [1, 1], label);
      // The finished scene leaves an idle cache, 13000 with 1000 output and 1024 of growth. That stays until the tester
      // comes back, so the extraction would wait for ever and keep the GPU awake: it ends instead.
      f.calls[0].finish(); await scene; tester.end();
      await ended;
      assert.equal(f.scheduler.snapshot().foregroundQueued, 0, label);
      await assert.rejects(prepared.generate('prepared supplement:100'), { code: 'background_unavailable' }, label);
      // The next scene runs in the slot of the scenes.
      assert.equal(await f.scene('tester', 'tester next:13000'), 2, label);
    } },
  { label: 'a supplement prepared ahead that no longer fits, after an extraction that did, ends the same way',
    options: { ...POOL, poolTokens: 30000 }, run: async (f, label) => {
      const owner = f.scheduler.foreground.generate('owner:12000');
      await f.started(1);
      f.calls[0].finish(); await owner;
      const [ahead, first] = f.open('owner', 'prepared small:5000', { yields: true });
      await f.started(2);
      f.calls[1].finish(); await first;
      await assert.rejects(ahead.generate('prepared supplement:15000'), { code: 'background_unavailable' }, label);
    } },
  { label: 'an agent waits while its claim would crowd out a person\'s cache; a person is admitted beside it',
    options: { ...POOL, poolTokens: 20000 }, run: async (f, label) => {
      const tester = f.scheduler.foreground.generate('tester:10000');
      await f.started(1);
      f.calls[0].finish(); await tester;
      // 2048 margin + 7000 claim + the tester's 11000 cache, 1000 output and 1024 of growth exceed 20000.
      const agent = f.scheduler.agent.generate('agent:6000');
      await turn(); await turn();
      assert.equal(f.calls.length, 1, label);
      // Another person does not count idle caches: llama.cpp evicts them for a running call. It spares the tester's slot.
      assert.equal(await f.scene('owner', 'owner:5000'), 1, label);
      // After a server restart the caches are gone and the agent fits.
      f.scheduler.forget(); f.scheduler.tick();
      await f.started(3);
      assert.equal(f.calls[2].name, 'agent', label);
      f.calls[2].finish(); await agent;
    } },
  { label: 'two turns between their calls in a pool do not wait for each other\'s room', options: { ...POOL, poolTokens: 12000 },
    run: async (f, label) => {
      const [a, b] = ['a', 'b'].map(holder => f.scheduler.agent.openTurn({ holder }));
      const first = [a.generate('a compaction:3000'), b.generate('b compaction:3000')];
      await f.started(2);
      f.calls[0].finish(); f.calls[1].finish(); await Promise.all(first);
      // Each scene with the other's cache would exceed 12000; running calls alone do not.
      const scenes = [a.generate('a scene:4000'), b.generate('b scene:4000')];
      await f.started(3);
      assert.deepEqual(f.calls.slice(2).map(call => call.name), ['a scene'], label);
      f.calls[2].finish(); await scenes[0]; a.end();
      await f.started(4);
      f.calls[3].finish(); await scenes[1]; b.end();
    } },
  { label: 'a pool keeps a person\'s room from an agent between its own calls', options: { ...POOL, poolTokens: 98304 }, run: async (f, label) => {
    await f.scene('tester', 'tester:48000');
    const agentTurn = f.scheduler.agent.openTurn({ holder: 'agent' });
    const small = agentTurn.generate('agent small:1000');
    await f.started(2);
    f.calls[1].finish(); await small;
    // Between its calls the agent asks for a request that would leave the tester's cache no room.
    const big = agentTurn.generate('agent big:54000');
    await turn(); await turn();
    assert.equal(f.calls.length, 2, label);
    agentTurn.end();
    await assert.rejects(big, { code: 'cancelled' }, label);
  } },
  { label: 'a person waiting for room in a pool ends another\'s yielding turn between its own calls', options: { ...POOL, poolTokens: 65536 },
    run: async (f, label) => {
      const [prepared, extraction] = f.open('owner', 'prepared:41000', { yields: true });
      const [tester, count] = f.open('tester', 'tester count:1000');
      await f.started(2);
      f.calls[1].finish(); await count;
      const stopped = assert.rejects(extraction, { code: 'background_preempted' }, label);
      const scene = tester.generate('tester scene:31000');
      await stopped; await f.started(3);
      assert.equal(f.calls[2].name, 'tester scene', label);
      f.calls[2].finish(); await scene; tester.end(); prepared.end();
    } },
  { label: 'a yielding turn waiting for room in a pool keeps nobody behind it', options: { ...POOL, poolTokens: 65536 }, run: async (f, label) => {
    const agent = f.scheduler.agent.generate('agent:40000');
    await f.started(1);
    const [prepared, first] = f.open('owner', 'prepared small:1000', { yields: true });
    await f.started(2);
    f.calls[1].finish(); await first;
    // Its next call does not fit beside the agent, and a turn that yields preempts nobody to make room for itself.
    const next = prepared.generate('prepared big:30000');
    await turn(); await turn();
    assert.equal(f.calls.length, 2, label);
    // A person who does fit is not kept waiting by it.
    const tester = f.scheduler.foreground.generate('tester:1000');
    await f.started(3);
    assert.deepEqual([f.calls[2].name, f.calls[0].signal.aborted], ['tester', false], label);
    f.calls[2].finish(); await tester;
    f.calls[0].finish(); await agent;
    await f.started(4);
    f.calls[3].finish(); await next; prepared.end();
  } },
]));
