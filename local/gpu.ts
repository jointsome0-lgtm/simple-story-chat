import type { Log } from './model-error.ts';
import { ModelError, errorCode, member } from './model-error.ts';
import type { SchedulerOptions } from './scheduler.ts';
import type { RemoteState } from './vast.ts';

export type GpuApi = { read(): Promise<RemoteState>; setState(state: 'running' | 'stopped'): Promise<unknown> };
export type GpuOptions = {
  api: GpuApi;
  // `ensure` and `check` may return a promise; their results are only awaited.
  connection: { ensure(): unknown; close(): void };
  check: (controls: { signal: AbortSignal }) => unknown;
  idleMinutes?: number; now?: () => number; resumeUntil?: number; readyGraceMs?: number; log?: Log;
};
export type GpuStatus = 'unknown' | 'paused' | 'starting' | 'ready' | 'draining' | 'stopping' | 'error';
export type GpuSnapshot = {
  status: GpuStatus; activeJobs: number; idleMinutes: number; checkDegraded: boolean;
  idleRemainingSeconds: number | null; canStart: boolean; canPause: boolean;
  // How many times the instance came back up, so a slot pool knows the model server's caches are empty again. A failing
  // control API ('error') says nothing about the server and does not count.
  starts: number;
};
export type GpuController = ReturnType<typeof createGpu>;
// A pause (from the owner or the idle deadline) or a start (from the owner) until the instance is confirmed
// paused or ready. A pause replaces a pending start.
type Intent = 'none' | 'pause' | 'start';
// A state assignment is repeated at most this often while Vast does not report it.
const WRITE_RETRY_MS = 30000;

// One controller for the whole bot. A lease spans a complete scene operation,
// including token counting, automatic compaction, generation and persistence.
export function createGpu({ api, connection, check, idleMinutes = 15, now = Date.now,
  resumeUntil = Infinity, readyGraceMs = 30000, log = () => {} }: GpuOptions) {
  const idleMs = idleMinutes * 60000;
  let status: GpuStatus = 'unknown';
  let activeJobs = 0;
  // The rest of the work that keeps the instance up while it lasts (`keepAwake`): an agent's turn from its first call
  // to its end and the end of its last call, a probe's call from the moment the queue takes it until it settles
  // (local/scheduler.ts).
  let awake = 0;
  // The start of the idle interval: null while any work lasts and while the instance is paused.
  let idleSince: number | null = null;
  let intent: Intent = 'none';
  let pending: Promise<GpuSnapshot> | undefined;
  let closed = false;
  let lastWrite = -Infinity;
  let lastReadyAt = -Infinity;
  let checkDegraded = false;
  // pause() and resume() may change the intent while reconcile awaits. It is read through a call, which TypeScript
  // does not narrow, so a check made before an await is not assumed to still hold after it.
  const wants = (value: Intent) => intent === value;
  const busy = () => activeJobs + awake > 0;
  const idleExpired = () => !busy() && idleSince !== null && now() - idleSince >= idleMs;
  const stopped = (remote: RemoteState) => member(['stopped', 'exited'], remote.actual) && remote.intended === 'stopped';
  const currentStatus = () => status === 'ready' && checkDegraded && now() - lastReadyAt >= readyGraceMs ? 'error' : status;
  // The instance was down (or not yet known) since the last time a tick saw it ready.
  let down = true;
  let starts = 0;
  // Counted once per tick, so a state the bot never observed still counts. Only a state that means the instance itself
  // is not running empties the caches: an intention to stop ('stopping', 'draining') leaves the server and its caches
  // in place until the instance actually goes down, and a failing control API ('error') says nothing about either.
  function count() {
    const current = currentStatus();
    if (current === 'ready') {
      if (down) starts++;
      down = false;
    } else if (current === 'paused' || current === 'starting' || current === 'unknown') down = true;
  }
  const snapshot = (): GpuSnapshot => ({ status: currentStatus(), starts, activeJobs, idleMinutes,
    checkDegraded: checkDegraded && currentStatus() === 'ready',
    idleRemainingSeconds: idleSince === null || busy() ? null : Math.max(0, Math.ceil((idleSince + idleMs - now()) / 1000)),
    canStart: !closed && status === 'paused' && now() < resumeUntil,
    canPause: !closed && !wants('pause') && status !== 'paused',
  });
  function assertReady() {
    if (closed || wants('pause') || currentStatus() !== 'ready') throw new ModelError('gpu_not_ready');
  }
  async function reconcile(): Promise<GpuSnapshot> {
    // An unavailable control API must not postpone the local idle deadline.
    if (idleExpired()) intent = 'pause';
    try {
      const remote = await api.read();
      if (closed) return snapshot();
      // An instance found up with nothing to do (at startup, or started outside the bot) idles from now on.
      if (idleSince === null && !busy() && !stopped(remote)) idleSince = now();
      if (idleExpired()) intent = 'pause';
      if (wants('pause')) {
        lastReadyAt = -Infinity;
        if (busy()) { status = 'draining'; return snapshot(); }
        connection.close();
        if (stopped(remote)) {
          status = 'paused'; idleSince = null; intent = 'none';
        } else {
          status = 'stopping';
          // Read back before retrying a state assignment. A successful PUT alone
          // never establishes that billing has stopped.
          if (remote.intended !== 'stopped' && now() - lastWrite >= WRITE_RETRY_MS) {
            lastWrite = now();
            await api.setState('stopped');
          }
        }
        return snapshot();
      }
      if (wants('start') && remote.intended !== 'running') {
        lastReadyAt = -Infinity;
        status = 'starting';
        if (now() - lastWrite >= WRITE_RETRY_MS) { lastWrite = now(); await api.setState('running'); }
        return snapshot();
      }
      if (stopped(remote)) {
        lastReadyAt = -Infinity;
        status = 'paused'; idleSince = null; connection.close();
      } else if (remote.intended === 'stopped') {
        lastReadyAt = -Infinity;
        status = 'stopping';
      } else if (remote.actual === 'running' && remote.intended === 'running') {
        await connection.ensure();
        // Health checks and menu reads do not count as user activity.
        await check({ signal: AbortSignal.timeout(8000) });
        status = wants('pause') ? (busy() ? 'draining' : 'stopping') : 'ready';
        if (status === 'ready') lastReadyAt = now();
        if (wants('start')) intent = 'none';
      } else { lastReadyAt = -Infinity; status = 'starting'; }
      checkDegraded = false;
    } catch (error) {
      if (idleExpired()) intent = 'pause';
      const transient = member(['gpu_api_failed', 'gpu_api_timeout', 'cancelled', 'timeout', 'provider_failed', 'model_unavailable'], errorCode(error));
      checkDegraded = transient && wants('none') && now() - lastReadyAt < readyGraceMs;
      status = checkDegraded ? 'ready' : wants('pause') && busy() ? 'draining' : 'error';
      if (!transient) lastReadyAt = -Infinity;
      log(checkDegraded ? 'gpu_check_deferred' : 'gpu_check_failed', errorCode(error), error);
    }
    return snapshot();
  }
  // The end of one piece of work, once however often it is called. The last one to end starts the idle interval, and
  // a pause that waited for it goes on at once.
  function ending(end: () => void) {
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      end();
      if (busy()) return;
      idleSince = now();
      if (wants('pause')) void controller.tick();
    };
  }
  const controller = {
    snapshot, assertReady,
    acquire() {
      assertReady();
      activeJobs++;
      idleSince = null;
      return ending(() => { activeJobs--; });
    },
    // Work that is not a reader's job keeps the instance up as one does, and a pause waits for it too. It may begin on
    // an instance that is not ready: it neither wakes a paused one nor takes back a pause.
    keepAwake() {
      awake++;
      idleSince = null;
      return ending(() => { awake--; });
    },
    pause() {
      lastReadyAt = -Infinity; checkDegraded = false;
      intent = 'pause';
      status = busy() ? 'draining' : 'stopping';
      lastWrite = -Infinity;
    },
    resume() {
      if (!snapshot().canStart) throw new ModelError('gpu_not_ready');
      intent = 'start'; status = 'starting';
      lastReadyAt = -Infinity; checkDegraded = false;
      idleSince = busy() ? null : now(); lastWrite = -Infinity;
    },
    tick(): Promise<GpuSnapshot> {
      if (closed) return Promise.resolve(snapshot());
      pending ??= reconcile().then(() => { count(); return snapshot(); }).finally(() => { pending = undefined; });
      return pending;
    },
    async close() {
      // Called only after all bot jobs have settled. Best-effort stop remains
      // visible as unconfirmed unless Vast reports the stopped state.
      controller.pause();
      await pending;
      await controller.tick();
      if (status !== 'paused') log('gpu_stop_unconfirmed');
      closed = true;
      connection.close();
    },
  };
  return controller;
}

// How the bot's model queue (local/scheduler.ts) runs on this instance. People come first: probes run only on a ready
// instance while no reader's job runs, and agents start there too, beside people's jobs only in a pool. A started
// agent turn runs on while a pause waits for it. Agent turns and probes' calls keep the instance up while they last;
// while it pauses the queue takes no probe, so that no waiting probe holds the pause back.
export const queueOptions = (gpu: GpuController, { pool }: { pool: boolean }) => ({
  backgroundAllowed: () => {
    const state = gpu.snapshot();
    return state.status === 'ready' && state.activeJobs === 0;
  },
  backgroundCanWait: () => !member(['draining', 'stopping', 'paused'], gpu.snapshot().status),
  agentCanStart: () => {
    const state = gpu.snapshot();
    return state.status === 'ready' && (pool || state.activeJobs === 0);
  },
  agentCanRun: () => member(['ready', 'draining'], gpu.snapshot().status),
  holdAgentTurn: () => gpu.keepAwake(),
  holdBackgroundCall: () => gpu.keepAwake(),
}) satisfies SchedulerOptions;
