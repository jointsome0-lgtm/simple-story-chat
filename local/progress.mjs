// One status message per compaction. UI writes never delay model streaming,
// overlap one another, or retry an uncertain sendMessage.
export function createProgress({ chat, render, signal, log = () => {}, now = Date.now, intervalMs = 5000 }) {
  let current;
  let startedAt;
  let endedAt;
  let messageId;
  let sendAttempted = false;
  let disabled = false;
  let closed = false;
  let nextAttempt = 0;
  let lastScreen;
  let inFlight;
  let timer;
  let finishing;

  function flush(final = false) {
    if (inFlight) return inFlight;
    if (!current || disabled || (!final && now() < nextAttempt)) return Promise.resolve(false);
    inFlight = Promise.resolve().then(async () => {
      try {
        const screen = render({ ...current, elapsedMs: (endedAt ?? now()) - startedAt });
        const signature = JSON.stringify(screen);
        if (signature === lastScreen) return true;
        if (messageId) await chat.edit(messageId, screen);
        else {
          if (sendAttempted) return false;
          sendAttempted = true;
          const sent = await chat.send(screen);
          if (!Number.isSafeInteger(sent?.message_id)) { disabled = true; return false; }
          messageId = sent.message_id;
        }
        lastScreen = signature;
        log('compaction_status_updated');
        return true;
      } catch (error) {
        // An uncertain initial send cannot safely be sent again. Edits use the
        // known message id and can be tried on a later tick with fresh status.
        if (!messageId) disabled = true;
        nextAttempt = now() + Math.max(intervalMs, (Number(error.retryAfter) || 5) * 1000);
        log('compaction_status_failed', error.code);
        return false;
      } finally { inFlight = undefined; }
    });
    return inFlight;
  }
  function update(event) {
    if (closed) return;
    const first = !current;
    const changedStage = current?.stage !== event.stage;
    current = { ...current, ...event };
    if (first) {
      startedAt = now();
      timer = setInterval(() => { void flush(); }, intervalMs);
      timer.unref?.();
    }
    endedAt = ['done', 'failed', 'cancelled'].includes(event.stage) ? now() : undefined;
    if (first || changedStage) void flush();
  }
  function finish(event) {
    if (finishing) return finishing;
    if (event && current) update(event);
    closed = true;
    clearInterval(timer);
    signal?.removeEventListener('abort', cancelled);
    finishing = (async () => { await inFlight; return flush(true); })();
    return finishing;
  }
  function cancelled() { void finish(current?.stage === 'done' ? undefined : { stage: 'cancelled' }); }
  signal?.addEventListener('abort', cancelled, { once: true });
  return { update, finish };
}
