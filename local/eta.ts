// Roughly when a waiting reader's request starts (docs/telegram-ui.md#waiting). The bot sees only its own work: its
// model queue (local/scheduler.ts) and its jobs on the picture card (local/picture.ts). It times that work as it ends,
// kind by kind, and gives a start time only once every kind in the way has been timed a few times: until then the
// reader sees the place alone. The times live in memory and start over with the bot.
import type { Messages } from './text.ts';

// A turn of the language model by what it does, and a job on the picture card (`frame`): its steps from start to end.
// `agent` is a turn of the agent interface or of a probe, `other` a call of the model that names no kind.
export type Work = 'scene' | 'compaction' | 'description' | 'retell' | 'agent' | 'other' | 'frame';

// The last durations of a kind the median is taken over, and how many are needed before it is trusted.
const KEEP = 15;
const ENOUGH = 3;
// What is left of work that has run past its usual length: it has not ended yet, so a few seconds more.
const FLOOR_MS = 5000;

export function createDurations() {
  const seen = new Map<Work, number[]>();
  return {
    add(work: Work, ms: number) {
      if (!Number.isFinite(ms) || ms < 0) return;
      const list = seen.get(work) ?? [];
      list.push(ms);
      if (list.length > KEEP) list.shift();
      seen.set(work, list);
    },
    // The median of the last durations of a kind, or nothing before there are enough of them.
    typical(work: Work): number | undefined {
      const list = seen.get(work);
      if (!list || list.length < ENOUGH) return undefined;
      const sorted = [...list].sort((a, b) => a - b), middle = sorted.length >> 1;
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    },
  };
}
export type Durations = ReturnType<typeof createDurations>;

// What is left of work of a kind whose usual length is `typical`, `elapsed` after it began.
export const left = (typical: number, elapsed: number) => Math.max(FLOOR_MS, typical - elapsed);

// When a slot is first free for the request that waits behind `ahead`: each slot is free after its own time (`free`),
// and each request ahead takes the first free slot for its time, in order.
export function startAfter(free: number[], ahead: number[]): number | undefined {
  if (!free.length) return undefined;
  const slots = [...free];
  for (const ms of ahead) {
    const first = slots.indexOf(Math.min(...slots));
    slots[first] += ms;
  }
  return Math.min(...slots);
}

// A start time as the reader is told it: in tens of seconds up to 50, in whole minutes after that. Coarse on purpose:
// the estimate is rough, and a finer one would change the message at every tick.
export function etaText(t: Messages, ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const seconds = Math.max(0, ms) / 1000;
  return seconds <= 50 ? t.wait.seconds(Math.max(10, Math.ceil(seconds / 10) * 10)) : t.wait.minutes(Math.max(1, Math.round(seconds / 60)));
}

// Whether a start time has moved enough to be told again: by 5 s, or by a fifth of itself when that is more. It falls
// as the wait goes on, and a message edited at every tick would run into Telegram's limits on edits.
export const moved = (last: number | undefined, next: number | undefined) =>
  last === undefined || next === undefined ? last !== next : Math.abs(next - last) >= Math.max(5000, last / 5);

// The first place a reader was shown while waiting, and the start time given with it, for a log row: `ahead` and
// `etaSeconds`, both whole numbers (local/model-error.ts `safeErrorDetails`). Nothing when they waited for nobody.
export function waited(shown: { ahead: number; etaMs?: number } | undefined) {
  if (!shown) return {};
  return { ahead: shown.ahead, ...shown.etaMs === undefined ? {} : { etaSeconds: Math.round(shown.etaMs / 1000) } };
}
