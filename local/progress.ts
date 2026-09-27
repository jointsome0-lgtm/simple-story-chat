import type { CompactionStatus } from './compact-view.ts';
import type { Log } from './model-error.ts';
import type { Screen } from './telegram.ts';

type StatusChat = { send(screen: Screen): Promise<unknown>; edit(messageId: number, screen: Screen): Promise<unknown> };
// The rows a status writes: a compaction's every write and failure, a picture's failures alone (local/picture.ts).
type Rows = { updated?: string; failed: string };

// One status message per compaction, or per picture while the card draws it (local/picture.ts `statusLine`). UI
// writes never delay model streaming or drawing, overlap one another, or retry an uncertain sendMessage. A stage, which
// a compaction's status has and a picture's steps do not, goes out the moment it changes, and 'done', 'failed' and
// 'cancelled' stop its clock. `messageId`: a message already in the chat, which the status edits instead of sending
// one of its own.
export function createProgress<S extends object = CompactionStatus>({ chat, render, signal, log = () => {}, now = Date.now,
  intervalMs = 5000, messageId: shown, rows = { updated: 'compaction_status_updated', failed: 'compaction_status_failed' } }: {
  chat: StatusChat; render: (progress: S & { elapsedMs: number }) => Screen; signal?: AbortSignal; log?: Log;
  now?: () => number; intervalMs?: number; messageId?: number; rows?: Rows;
}) {
  const stageOf = (status: S | undefined) => (status as { stage?: unknown } | undefined)?.stage;
  let current: S | undefined;
  let startedAt: number;
  let endedAt: number | undefined;
  let messageId = shown;
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
        const screen = render({ ...current!, elapsedMs: (endedAt ?? now()) - startedAt });
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
        if (rows.updated) log(rows.updated);
        return true;
      } catch (error) {
        // An uncertain initial send cannot safely be sent again. Edits use the
        // known message id and can be tried on a later tick with fresh status.
        if (!messageId) disabled = true;
        const failure = error as { code?: string | number; retryAfter?: unknown };
        nextAttempt = now() + Math.max(intervalMs, (Number(failure.retryAfter) || 5) * 1000);
        log(rows.failed, failure.code);
        return false;
      } finally { inFlight = undefined; }
    });
    return inFlight;
  }
  function update(event: S) {
    if (closed) return;
    const first = !current;
    const changedStage = stageOf(current) !== stageOf(event);
    current = { ...current, ...event };
    if (first) {
      startedAt = now();
      timer = setInterval(() => { void flush(); }, intervalMs);
      timer.unref?.();
    }
    const stage = stageOf(event);
    endedAt = stage === 'done' || stage === 'failed' || stage === 'cancelled' ? now() : undefined;
    if (first || changedStage) void flush();
  }
  function finish(event?: S) {
    if (finishing) return finishing;
    if (event && current) update(event);
    closed = true;
    clearInterval(timer);
    signal?.removeEventListener('abort', cancelled);
    finishing = (async () => { await inFlight; return flush(true); })();
    return finishing;
  }
  // Ends the status with no last write of its own, once the write in flight is over: its caller then removes the
  // message or puts its own text there, as a picture's status line does, and nothing of this lands after it.
  async function close() {
    closed = disabled = true;
    clearInterval(timer);
    signal?.removeEventListener('abort', cancelled);
    await inFlight;
  }
  function cancelled() { void finish(stageOf(current) === 'done' ? undefined : { stage: 'cancelled' } as S); }
  signal?.addEventListener('abort', cancelled, { once: true });
  return { update, finish, close };
}
