import { ModelError } from './model-error.mjs';

// One controller for the whole bot. A lease spans a complete scene operation,
// including token counting, automatic compaction, generation and persistence.
export function createGpu({ api, connection, check, idleMinutes = 15, now = Date.now,
  resumeUntil = Infinity, readyGraceMs = 30000, log = () => {} }) {
  const idleMs = idleMinutes * 60000;
  let status = 'unknown';
  let activeJobs = 0;
  let idleSince = null;
  let pauseRequested = false;
  let startRequested = false;
  let pending;
  let closed = false;
  let lastWrite = -Infinity;
  let lastReadyAt = -Infinity;
  let checkDegraded = false;
  const stopped = remote => ['stopped', 'exited'].includes(remote.actual) && remote.intended === 'stopped';
  const currentStatus = () => status === 'ready' && checkDegraded && now() - lastReadyAt >= readyGraceMs ? 'error' : status;
  const snapshot = () => ({ status: currentStatus(), activeJobs, idleMinutes,
    checkDegraded: checkDegraded && currentStatus() === 'ready',
    idleRemainingSeconds: idleSince === null || activeJobs ? null : Math.max(0, Math.ceil((idleSince + idleMs - now()) / 1000)),
    canStart: !closed && status === 'paused' && now() < resumeUntil,
    canPause: !closed && !pauseRequested && status !== 'paused',
  });
  function assertReady() {
    if (closed || pauseRequested || currentStatus() !== 'ready') throw new ModelError('gpu_not_ready');
  }
  async function reconcile() {
    // An unavailable control API must not postpone the local idle deadline.
    if (!activeJobs && idleSince !== null && now() - idleSince >= idleMs) pauseRequested = true;
    try {
      const remote = await api.read();
      if (closed) return snapshot();
      if (idleSince === null && !stopped(remote)) idleSince = now();
      if (!activeJobs && idleSince !== null && now() - idleSince >= idleMs) pauseRequested = true;
      if (pauseRequested) {
        lastReadyAt = -Infinity;
        startRequested = false;
        if (activeJobs) { status = 'draining'; return snapshot(); }
        connection.close();
        if (stopped(remote)) {
          status = 'paused'; idleSince = null; pauseRequested = false;
        } else {
          status = 'stopping';
          // Read back before retrying a state assignment. A successful PUT alone
          // never establishes that billing has stopped.
          if (remote.intended !== 'stopped' && now() - lastWrite >= 30000) {
            lastWrite = now();
            await api.setState('stopped');
          }
        }
        return snapshot();
      }
      if (startRequested && remote.intended !== 'running') {
        lastReadyAt = -Infinity;
        status = 'starting';
        if (now() - lastWrite >= 30000) { lastWrite = now(); await api.setState('running'); }
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
        status = pauseRequested ? (activeJobs ? 'draining' : 'stopping') : 'ready';
        if (status === 'ready') lastReadyAt = now();
        startRequested = false;
      } else { lastReadyAt = -Infinity; status = 'starting'; }
      checkDegraded = false;
    } catch (error) {
      if (!activeJobs && idleSince !== null && now() - idleSince >= idleMs) pauseRequested = true;
      const transient = ['gpu_api_failed', 'gpu_api_timeout', 'cancelled', 'timeout', 'provider_failed', 'model_unavailable'].includes(error.code);
      checkDegraded = transient && !pauseRequested && !startRequested && now() - lastReadyAt < readyGraceMs;
      status = checkDegraded ? 'ready' : pauseRequested && activeJobs ? 'draining' : 'error';
      if (!transient) lastReadyAt = -Infinity;
      log(checkDegraded ? 'gpu_check_deferred' : 'gpu_check_failed', error.code, error);
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
        if (!activeJobs) { idleSince = now(); if (pauseRequested) void controller.tick(); }
      };
    },
    pause() {
      lastReadyAt = -Infinity; checkDegraded = false;
      pauseRequested = true; startRequested = false;
      status = activeJobs ? 'draining' : 'stopping';
      lastWrite = -Infinity;
    },
    resume() {
      if (!snapshot().canStart) throw new ModelError('gpu_not_ready');
      startRequested = true; pauseRequested = false; status = 'starting';
      lastReadyAt = -Infinity; checkDegraded = false;
      idleSince = now(); lastWrite = -Infinity;
    },
    tick() {
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
