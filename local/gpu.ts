import type { Log } from './model-error.ts';
import { ModelError, errorCode, member } from './model-error.ts';
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
  // Agent turns that have started (local/scheduler.ts). They keep the instance from pausing until they end, but unlike
  // a user's job they do not stop or reset the idle countdown.
  let holds = 0;
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
  const busy = () => activeJobs + holds > 0;
  const idleExpired = () => !activeJobs && idleSince !== null && now() - idleSince >= idleMs;
  const stopped = (remote: RemoteState) => member(['stopped', 'exited'], remote.actual) && remote.intended === 'stopped';
  const currentStatus = () => status === 'ready' && checkDegraded && now() - lastReadyAt >= readyGraceMs ? 'error' : status;
  const snapshot = (): GpuSnapshot => ({ status: currentStatus(), activeJobs, idleMinutes,
    checkDegraded: checkDegraded && currentStatus() === 'ready',
    idleRemainingSeconds: idleSince === null || activeJobs ? null : Math.max(0, Math.ceil((idleSince + idleMs - now()) / 1000)),
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
      if (idleSince === null && !stopped(remote)) idleSince = now();
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
  const controller = {
    snapshot, assertReady,
    acquire() {
      assertReady();
      activeJobs++;
      idleSince = null;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeJobs--;
        if (!activeJobs) { idleSince = now(); if (!busy() && wants('pause')) void controller.tick(); }
      };
    },
    // Keeps a started agent turn from being cut off by a pause; the idle countdown goes on.
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (!busy() && wants('pause')) void controller.tick();
      };
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
      idleSince = now(); lastWrite = -Infinity;
    },
    tick(): Promise<GpuSnapshot> {
      if (closed) return Promise.resolve(snapshot());
      pending ??= reconcile().finally(() => { pending = undefined; });
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
