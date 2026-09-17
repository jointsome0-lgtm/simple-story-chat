import type { CompactionStatus } from './compact-view.ts';
import type { Log } from './model-error.ts';
import type { Screen } from './telegram.ts';

type StatusChat = { send(screen: Screen): Promise<unknown>; edit(messageId: number, screen: Screen): Promise<unknown> };

// One status message per compaction. UI writes never delay model streaming,
// overlap one another, or retry an uncertain sendMessage.
export function createProgress({ chat, render, signal, log = () => {}, now = Date.now, intervalMs = 5000 }: {
  chat: StatusChat; render: (progress: CompactionStatus) => Screen; signal?: AbortSignal; log?: Log;
  now?: () => number; intervalMs?: number;
}) {
  let current: CompactionStatus | undefined;
  let startedAt: number;
  let endedAt: number | undefined;
  let messageId: number | undefined;
  let sendAttempted = false;
  let disabled = false;
  let closed = false;
  let nextAttempt = 0;
  let lastScreen: string | undefined;
  let inFlight: Promise<boolean> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let finishing: Promise<boolean> | undefined;

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
          // The Bot API result is not trusted: without a valid message id there is nothing to edit.
          const sent = await chat.send(screen) as { message_id?: unknown } | null | undefined;
          if (typeof sent?.message_id !== 'number' || !Number.isSafeInteger(sent.message_id)) { disabled = true; return false; }
          messageId = sent.message_id;
        }
        lastScreen = signature;
        log('compaction_status_updated');
        return true;
      } catch (error) {
        // An uncertain initial send cannot safely be sent again. Edits use the
        // known message id and can be tried on a later tick with fresh status.
        if (!messageId) disabled = true;
        const failure = error as { code?: string | number; retryAfter?: unknown };
        nextAttempt = now() + Math.max(intervalMs, (Number(failure.retryAfter) || 5) * 1000);
        log('compaction_status_failed', failure.code);
        return false;
      } finally { inFlight = undefined; }
    });
    return inFlight;
  }
  function update(event: CompactionStatus) {
    if (closed) return;
    const first = !current;
    const changedStage = current?.stage !== event.stage;
    current = { ...current, ...event };
    if (first) {
      startedAt = now();
      timer = setInterval(() => { void flush(); }, intervalMs);
      timer.unref?.();
    }
    endedAt = event.stage === 'done' || event.stage === 'failed' || event.stage === 'cancelled' ? now() : undefined;
    if (first || changedStage) void flush();
  }
  function finish(event?: CompactionStatus) {
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
