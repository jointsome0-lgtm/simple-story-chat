import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createGpu, queueOptions } from './gpu.ts';
import type { SchedulerOptions } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import { createVast } from './vast.ts';
import { gpuConfig } from './config.ts';
import { ModelError } from './model-error.ts';

type Await = 'check' | 'ensure' | 'read';
const stopped = { actual: 'exited', intended: 'stopped' };
// A card behind a fake control API and model server, on the test's clock. `hold` keeps reconcile at one of its awaits
// until the test lets it go on or fail there, so the test can act while it waits.
function fixture() {
  let time = 0;
  let remote = { actual: 'running', intended: 'running' };
  let failRead: string | false = false;
  let healthy: string | true = true;
  const writes: string[] = [];
  const held = new Map<Await, Promise<void>>();
  const gpu = createGpu({ now: () => time,
    api: { async read() { await held.get('read'); if (failRead) throw new ModelError(failRead); return { ...remote }; },
      async setState(state) { writes.push(state); remote.intended = state; } },
    connection: { async ensure() { await held.get('ensure'); }, close() {} },
    check: async () => { await held.get('check'); if (healthy !== true) throw new ModelError(healthy); } });
  return { gpu, writes, now: () => time, advance: (ms: number) => { time += ms; }, tick: (ms = 0) => { time += ms; return gpu.tick(); },
    status: () => gpu.snapshot().status, idle: () => gpu.snapshot().idleRemainingSeconds,
    setRemote: (value: typeof remote) => { remote = { ...value }; },
    fail: (code: string | false = 'gpu_api_failed') => { failRead = code; }, health: (code: string | true) => { healthy = code; },
    hold(point: Await) {
      const at = Promise.withResolvers<void>();
      held.set(point, at.promise);
      return { go: () => { held.delete(point); at.resolve(); }, fail: (error: Error) => { held.delete(point); at.reject(error); } };
    } };
}
type Fixture = ReturnType<typeof fixture>;
const turn = () => new Promise(resolve => setImmediate(resolve));
// A row of a table: its label, and what happens to a card the first tick found running, or paused. A `fresh` row
// makes the first tick itself.
type Row = [string, (f: Fixture, label: string, t: TestContext) => Promise<void>, { paused?: boolean; fresh?: boolean }?];
async function run(t: TestContext, rows: Row[]) {
  for (const [label, row, { paused = false, fresh = false } = {}] of rows) {
    const f = fixture();
    if (paused) f.setRemote(stopped);
    if (!fresh) await f.tick();
    await row(f, label, t);
  }
}
// The bot's model queue on this card, with the options local/main.ts gives it. A call runs until the test finishes it
// or the queue stops it. A count, which only a pool makes, sees its abort at once but ends only when the test lets it,
// as a request still closing on the server.
function queue(t: TestContext, f: Fixture, options: SchedulerOptions = {}, pool = false) {
  const calls: { name: string; finish: () => void }[] = [];
  const counts: { signal: AbortSignal; unwind: () => void }[] = [];
  const scheduler = createScheduler({ generate: (request: string, { signal }: { signal: AbortSignal }) => new Promise<string>((resolve, reject) => {
    calls.push({ name: request, finish: () => resolve(request) });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), countInput: (_request: string, { signal }: { signal: AbortSignal }) => new Promise<number>((_resolve, reject) => {
    counts.push({ signal, unwind: () => reject(signal.reason) });
  }) }, { ...queueOptions(f.gpu, { pool }), now: f.now, quietMs: 0, pollMs: 100000, ...options });
  t.after(() => { for (const count of counts) count.unwind(); return scheduler.close(); });
  return { scheduler, calls, counts };
}

test('idle stop waits 15 minutes after the last job; status reads never extend it', t => run(t, [
  ['a reader\'s job', async (f, label) => {
    const release = f.gpu.acquire();
    await f.tick(20 * 60000); assert.deepEqual(f.writes, [], label);
    release();
    await f.tick(14 * 60000); assert.equal(f.idle(), 60, label);
    await f.tick(59999); assert.deepEqual(f.writes, [], label);
    await f.tick(1);
    // A PUT acknowledgement is not a stopped receipt.
    assert.deepEqual([f.status(), f.writes], ['stopping', ['stopped']], label);
    f.setRemote(stopped); await f.tick(); assert.equal(f.status(), 'paused', label);
  }],
  ['other work, which keeps the card up while it lasts', async (f, label) => {
    // Work held when the bot starts: the first tick starts no idle interval.
    const early = f.gpu.keepAwake();
    await f.tick(); assert.deepEqual([f.status(), f.idle()], ['ready', null], label);
    await f.tick(60 * 60000); assert.deepEqual(f.writes, [], label);
    // Nor does the end of a reader's job while other work lasts.
    f.gpu.acquire()(); assert.equal(f.idle(), null, label);
    early(); assert.equal(f.idle(), 15 * 60, label);
    // A release works once: called again, it does not end the work that came after it.
    const next = f.gpu.keepAwake();
    early(); assert.equal(f.idle(), null, label);
    next();
    await f.tick(15 * 60000 - 1); assert.deepEqual(f.writes, [], label);
    await f.tick(1); assert.deepEqual(f.writes, ['stopped'], label);
  }, { fresh: true }],
  // The deadline latches while the control API is down, and a fresh successful check after it does not take it back.
  ['no work, with the control API down at the deadline', async (f, label) => {
    await f.tick(15 * 60000 - 1); assert.equal(f.status(), 'ready', label);
    f.fail(); await f.tick(1); assert.equal(f.status(), 'error', label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    f.fail(false); await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['a start that is still allocating', async (f, label) => {
    f.gpu.resume(); await f.tick();
    await f.tick(15 * 60000); assert.deepEqual(f.writes, ['running', 'stopped'], label);
  }, { paused: true }],
  ['a long eval, whose calls back to back for longer than the interval never drain or pause the card', async (f, label, t) => {
    const q = queue(t, f);
    for (let call = 0; call < 30; call++) {
      const result = q.scheduler.background.generate(`eval ${call}`);
      assert.equal(q.calls.length, call + 1, label);
      // A minute of generation, with the bot's ticks meanwhile.
      await f.tick(60000); q.scheduler.tick();
      assert.deepEqual([f.status(), f.idle()], ['ready', null], `${label}: call ${call}`);
      q.calls[call].finish(); assert.equal(await result, `eval ${call}`, label);
      // The eval sends its next request a moment later; in between only the idle interval keeps the card up.
      await f.tick(50);
    }
    assert.deepEqual([f.status(), f.idle(), f.writes], ['ready', 15 * 60, []], label);
    await f.tick(15 * 60000); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['an agent\'s turn, which keeps the card up through the gaps between its calls', async (f, label, t) => {
    const q = queue(t, f);
    // The card has been idle for 14 minutes when the turn begins: it no longer needs the time to end before the pause.
    await f.tick(14 * 60000);
    const agent = q.scheduler.agent.openTurn();
    for (let call = 0; call < 5; call++) {
      const result = agent.generate(`agent ${call}`);
      assert.equal(q.calls.length, call + 1, label);
      await f.tick(3 * 60000); q.scheduler.tick();
      q.calls[call].finish(); await result;
      // The agent reads the answer and writes its next call.
      await f.tick(50000); q.scheduler.tick();
      assert.deepEqual([f.status(), f.idle(), f.writes], ['ready', null, []], `${label}: call ${call}`);
    }
    agent.end(); assert.equal(f.idle(), 15 * 60, label);
    await f.tick(15 * 60000); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['the last waiting probe, cancelled', async (f, label, t) => {
    const q = queue(t, f, { quietMs: 60000 });
    // A reader's scene has just ended; the eval's call waits for the quiet window.
    const job = f.gpu.acquire();
    const scene = q.scheduler.foreground.generate('scene');
    q.calls[0].finish(); await scene;
    const cancel = new AbortController();
    const probe = q.scheduler.background.generate('eval', { signal: cancel.signal });
    job();
    await f.tick(30000); q.scheduler.tick();
    assert.deepEqual([q.calls.length, f.idle()], [1, null], label);
    const cancelled = assert.rejects(probe, { code: 'cancelled' }, label);
    cancel.abort(); await cancelled;
    assert.equal(f.idle(), 15 * 60, label);
    await f.tick(15 * 60000); assert.deepEqual([q.calls.length, f.writes], [1, ['stopped']], label);
  }],
  // A card whose model server stopped answering is in error, and a probe waiting for it would keep it up for as long
  // as it waited. The queue refuses it at its first tick after ten minutes, and the idle interval runs from there.
  ['a probe waiting on a card in error, refused after ten minutes', async (f, label, t) => {
    const q = queue(t, f);
    f.health('timeout'); await f.tick(31000); assert.equal(f.status(), 'error', label);
    const refused = assert.rejects(q.scheduler.background.generate('eval'), { code: 'background_timeout' }, label);
    await f.tick(10 * 60000 - 1); q.scheduler.tick();
    assert.deepEqual([q.scheduler.snapshot().backgroundQueued, f.idle(), f.writes], [1, null, []], label);
    // The queue is empty before anything is awaited, so a queue that kept the probe fails here instead of hanging.
    f.advance(1); q.scheduler.tick();
    assert.equal(q.scheduler.snapshot().backgroundQueued, 0, label);
    await refused; assert.equal(f.idle(), 15 * 60, label);
    await f.tick(15 * 60000); assert.deepEqual([f.status(), f.writes, q.calls], ['stopping', ['stopped'], []], label);
  }],
]));

test('manual pause drains all users and refuses new jobs without interrupting existing work', t => run(t, [
  ['two readers\' jobs', async (f, label) => {
    const owner = f.gpu.acquire(); const tester = f.gpu.acquire();
    f.gpu.pause(); assert.equal(f.status(), 'draining', label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    await f.tick(); owner(); owner(); await f.tick();
    assert.deepEqual([f.gpu.snapshot().activeJobs, f.writes], [1, []], label);
    tester(); await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['other work, which neither wakes a paused card nor takes back a pause', async (f, label) => {
    const work = f.gpu.keepAwake();
    f.gpu.pause();
    // Work that begins while the pause waits leaves the pause in place, and the pause waits for it too.
    const more = f.gpu.keepAwake();
    await f.tick(); assert.deepEqual([f.status(), f.gpu.snapshot().canPause, f.writes], ['draining', false, []], label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    work(); await f.tick(); assert.deepEqual(f.writes, [], label);
    more(); await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
    f.setRemote(stopped); await f.tick();
    // Work taken on a paused card does not start it: only the owner does.
    const late = f.gpu.keepAwake();
    await f.tick(); await f.tick(); assert.deepEqual([f.status(), f.writes], ['paused', ['stopped']], label);
    late(); f.gpu.resume(); await f.tick(); assert.deepEqual(f.writes, ['stopped', 'running'], label);
  }],
  // A failing control API or an unknown remote state is never reported as a free paused card.
  ['a pause while the control API fails, then an instance offline', async (f, label) => {
    f.gpu.pause(); f.fail(); await f.tick(); assert.equal(f.status(), 'error', label);
    f.fail(false); await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
    f.setRemote({ actual: 'offline', intended: 'stopped' }); await f.tick(); assert.equal(f.status(), 'stopping', label);
    assert.throws(() => f.gpu.resume(), { code: 'gpu_not_ready' }, label);
  }],
  // A pause that arrives while reconcile waits is kept: never 'ready', no new lease, and the next tick stops.
  ...(['check', 'ensure', 'read'] as const).map((point): Row => [`a pause during await ${point}`, async (f, label) => {
    const held = f.hold(point);
    const inflight = f.gpu.tick(); await turn();
    f.gpu.pause(); held.go(); await inflight;
    assert.deepEqual([f.status(), f.gpu.snapshot().canPause], ['stopping', false], label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    // A pause during the read is seen by the same reconcile; later awaits leave the stop to the next tick.
    if (point !== 'read') { assert.deepEqual(f.writes, [], label); await f.tick(); }
    assert.deepEqual(f.writes, ['stopped'], label);
  }]),
  ['a pause during await check with a job held, which drains and stops on its release', async (f, label) => {
    const release = f.gpu.acquire();
    const held = f.hold('check');
    const inflight = f.gpu.tick(); await turn();
    f.gpu.pause(); held.go(); await inflight; assert.equal(f.status(), 'draining', label);
    await f.tick(); assert.deepEqual(f.writes, [], label);
    release(); await turn(); await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['a pause during a failing check, an error at once without the readiness grace', async (f, label) => {
    const held = f.hold('check');
    const inflight = f.gpu.tick(); await turn();
    f.gpu.pause(); held.fail(new ModelError('timeout')); await inflight;
    assert.deepEqual([f.status(), f.gpu.snapshot().checkDegraded], ['error', false], label);
    await f.tick(); assert.deepEqual(f.writes, ['stopped'], label);
  }],
  ['a start overtaken by the idle deadline while the control API is down', async (f, label) => {
    f.gpu.resume(); await f.tick(); assert.deepEqual(f.writes, ['running'], label);
    // The idle deadline latches the pause before the failing read.
    f.fail(); await f.tick(15 * 60000);
    assert.deepEqual([f.status(), f.gpu.snapshot().canPause], ['error', false], label);
    f.fail(false); await f.tick(31000); assert.deepEqual(f.writes, ['running', 'stopped'], label);
    f.setRemote(stopped); await f.tick();
    assert.deepEqual([f.status(), f.gpu.snapshot().canStart], ['paused', true], label);
    await f.tick(); await f.tick();
    assert.deepEqual(f.writes, ['running', 'stopped'], `${label}: the overtaken start must not resurface after the pause completes`);
  }, { paused: true }],
]));

test('an error or an unknown state is taken neither for readiness nor for a stop', t => run(t, [
  ['startup while the control API fails', async (f, label) => {
    f.fail(); await f.tick(); assert.equal(f.status(), 'error', label);
  }, { fresh: true }],
  // Startup, identity mismatch, actual stop and explicit pause cannot use cached readiness.
  ...([['an instance that is not ours', (f: Fixture) => f.fail('gpu_instance_mismatch')],
    ['a model that is not ours', (f: Fixture) => f.health('unexpected_model')], ['an instance stopped', (f: Fixture) => f.setRemote(stopped)],
    ['a pause', (f: Fixture) => { f.gpu.pause(); f.fail(); }]] as const).map(([what, change]): Row => [`no cached readiness after ${what}`, async (f, label) => {
    change(f); await f.tick();
    assert.notEqual(f.status(), 'ready', label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    f.fail(); await f.tick(); assert.notEqual(f.status(), 'ready', label);
  }]),
  ['a paused card at startup, which stays off until the owner starts it', async (f, label) => {
    await f.tick(); assert.deepEqual(f.writes, [], label);
    f.gpu.resume(); assert.equal(f.status(), 'starting', label);
    await f.tick(); await f.tick(); assert.deepEqual(f.writes, ['running'], label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    // Allocated is not ready: the model must answer first.
    f.setRemote({ actual: 'running', intended: 'running' }); f.health('model_unavailable');
    await f.tick(); assert.notEqual(f.status(), 'ready', label);
    f.health(true); await f.tick(); assert.equal(f.status(), 'ready', label);
  }, { paused: true }],
  // Started outside the bot (the Vast console) while paused, and resumed during its health check: the start is consumed.
  ['a resume while an instance started outside is health-checked', async (f, label) => {
    f.setRemote({ actual: 'running', intended: 'running' });
    const held = f.hold('check'); const inflight = f.gpu.tick(); await turn();
    f.gpu.resume(); assert.equal(f.status(), 'starting', label);
    held.go(); await inflight; assert.deepEqual([f.status(), f.writes], ['ready', []], label);
    f.fail(); await f.tick(1000); assert.deepEqual([f.status(), f.gpu.snapshot().checkDegraded], ['ready', true], label);
  }, { paused: true }],
  // A transient failure of the control API or of the model's check keeps recent readiness for 30 seconds at most, even
  // with a recovery check still pending when they end, and is no stop.
  ...(['control', 'health'] as const).map((failure): Row => [`a transient ${failure} failure`, async (f, label) => {
    if (failure === 'control') f.fail(); else f.health('cancelled');
    await f.tick(10000); assert.deepEqual([f.status(), f.gpu.snapshot().checkDegraded], ['ready', true], label);
    f.gpu.acquire()();
    await f.tick(19999); assert.equal(f.status(), 'ready', label);
    f.fail(false); f.health(true); const held = f.hold('check'); const recovering = f.gpu.tick(); await turn();
    f.advance(1); assert.equal(f.status(), 'error', label);
    assert.throws(() => f.gpu.acquire(), { code: 'gpu_not_ready' }, label);
    held.go(); await recovering;
    assert.deepEqual([f.status(), f.gpu.snapshot().checkDegraded, f.writes], ['ready', false, []], label);
  }]),
  // Only an instance that went down empties the model server's caches, which a pool then stops reserving room in.
  ['a restart counted for a real stop, not for a failing control API or a stop taken back', async (f, label) => {
    assert.equal(f.gpu.snapshot().starts, 1, label);
    f.fail(); await f.tick(40000); assert.equal(f.status(), 'error', label);
    f.fail(false); assert.equal((await f.tick(10000)).starts, 1, label);
    // Somebody outside the bot asks Vast to stop the instance and takes it back; it never left 'running'.
    f.setRemote({ actual: 'running', intended: 'stopped' }); assert.equal((await f.tick()).status, 'stopping', label);
    f.setRemote({ actual: 'running', intended: 'running' }); assert.deepEqual([(await f.tick()).starts, f.writes], [1, []], label);
    f.gpu.pause(); await f.tick(); f.setRemote(stopped); await f.tick();
    f.gpu.resume(); await f.tick(); f.setRemote({ actual: 'running', intended: 'running' });
    assert.deepEqual([(await f.tick()).starts, f.writes], [2, ['stopped', 'running']], label);
  }],
]));

test('the owner\'s pause stops the card only after the queue\'s calls and counts have ended', t => run(t, [
  ['an eval\'s running call and the waiting one', async (f, label, t) => {
    const q = queue(t, f);
    const ended = assert.rejects(q.scheduler.background.generate('eval 1'), { code: 'background_unavailable' }, label);
    const refused = assert.rejects(q.scheduler.background.generate('eval 2'), { code: 'background_unavailable' }, label);
    f.gpu.pause(); await f.tick(); assert.deepEqual([f.status(), f.writes], ['draining', []], label);
    // The queue's next tick: probes may no longer run, nor wait. The queue is empty before anything is awaited, so a
    // queue that kept a probe fails here instead of hanging the test.
    q.scheduler.tick(); assert.equal(q.scheduler.snapshot().backgroundQueued, 0, label);
    await ended; await refused;
    // The eval asks again at once, and is refused before its call waits: it keeps nothing up.
    const again = assert.rejects(q.scheduler.background.generate('eval 3'), { code: 'background_unavailable' }, label);
    assert.equal(q.scheduler.snapshot().backgroundQueued, 0, label);
    await again; await f.tick(); assert.deepEqual([f.status(), f.writes], ['stopping', ['stopped']], label);
    f.setRemote(stopped); await f.tick();
    assert.deepEqual([f.status(), q.calls.map(call => call.name)], ['paused', ['eval 1']], label);
  }],
  ['an eval on a model server whose checks fail', async (f, label, t) => {
    const q = queue(t, f);
    const ended = assert.rejects(q.scheduler.background.generate('eval 1'), { code: 'background_unavailable' }, label);
    // The server stops answering its checks. Past the readiness grace the card is in error, and the probe stops.
    f.health('timeout'); await f.tick(31000); assert.equal(f.status(), 'error', label);
    q.scheduler.tick(); await ended;
    // The eval asks again; its call waits for the card to be ready.
    const refused = assert.rejects(q.scheduler.background.generate('eval 2'), { code: 'background_unavailable' }, label);
    await f.tick(60000); q.scheduler.tick();
    assert.deepEqual([f.status(), q.calls.length, f.writes], ['error', 1, []], label);
    // The owner pauses: the pause waits for the waiting call, the queue refuses it, and the pause needs no check.
    f.gpu.pause(); await f.tick(); assert.equal(f.status(), 'draining', label);
    q.scheduler.tick(); assert.equal(q.scheduler.snapshot().backgroundQueued, 0, label);
    await refused; await f.tick(); assert.deepEqual([f.status(), f.writes], ['stopping', ['stopped']], label);
  }],
  // A pool with a shared cache has the server count a call's size before the call waits for room. A probe refused
  // during that count holds the card until the count has ended on the server, so the pause stops the card after it.
  ['a refused probe\'s count in a pool', async (f, label, t) => {
    const q = queue(t, f, { quietMs: undefined, slots: 2, poolTokens: 100000, outputTokens: () => 100 }, true);
    const refused = assert.rejects(q.scheduler.background.generate('eval'), { code: 'background_unavailable' }, label);
    await turn();
    f.gpu.pause(); await f.tick();
    q.scheduler.tick(); assert.equal(q.counts[0].signal.aborted, true, label);
    await f.tick(); assert.deepEqual([f.status(), f.writes], ['draining', []], label);
    q.counts[0].unwind(); await refused;
    await f.tick(); assert.deepEqual([f.status(), f.writes], ['stopping', ['stopped']], label);
  }],
]));

test('Vast adapter is pinned to one instance and discards sensitive response fields', async () => {
  const calls: (RequestInit & { url: string })[] = [];
  const api = createVast({ instanceId: '123', apiKey: 'synthetic-key' }, { fetch: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json(options.method === 'PUT' ? { success: true } : {
      instances: { id: 123, actual_status: 'running', intended_status: 'running', jupyter_token: 'synthetic-private' },
    });
  } });
  assert.deepEqual(await api.read(), { actual: 'running', intended: 'running' });
  await api.setState('stopped');
  assert.deepEqual([calls[1].url, calls[1].redirect, JSON.parse(calls[1].body as string)],
    ['https://console.vast.ai/api/v0/instances/123/', 'error', { state: 'stopped' }]);
  assert.throws(() => api.setState('destroyed'), { code: 'gpu_config' });
  // Another instance's answer is refused, and an HTTP error keeps only its status and whether it read or wrote.
  const answering = (response: () => Response) => createVast({ instanceId: '123', apiKey: 'synthetic-key' }, { fetch: async () => response() });
  await assert.rejects(answering(() => Response.json({ instances: { id: 456 } })).read(), { code: 'gpu_instance_mismatch' });
  const failing = answering(() => new Response('PRIVATE_PROVIDER_BODY', { status: 502 }));
  await assert.rejects(failing.read(), { code: 'gpu_api_failed', phase: 'gpu_read', httpStatus: 502 });
  await assert.rejects(failing.setState('stopped'), { code: 'gpu_api_failed', phase: 'gpu_write', httpStatus: 502 });
  // Power control is opt-in, only for llama.cpp, and its SSH host is an alias rather than an option.
  const env = { SIMPLE_CHAT_VAST_INSTANCE_ID: '123', SIMPLE_CHAT_VAST_API_KEY: 'synthetic' };
  assert.equal(gpuConfig({}, 'claude-code'), undefined);
  assert.throws(() => gpuConfig(env, 'claude-code'));
  assert.equal(gpuConfig(env, 'llama-cpp')!.idleMinutes, 15);
  assert.throws(() => gpuConfig({ ...env, SIMPLE_CHAT_GPU_SSH_HOST: '-oProxyCommand=bad' }, 'llama-cpp'));
});
