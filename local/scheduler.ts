import type { Log } from './model-error.ts';
import { ModelError } from './model-error.ts';
import type { Controls, GenerateControls, Provider } from './model.ts';

type Priority = 'foreground' | 'background';
// Reasons the scheduler aborts a running call with. The call rejects with the reason, whatever the provider throws.
type AbortCode = 'cancelled' | 'background_preempted' | 'background_timeout' | 'background_unavailable';
// Methods run in the slot always receive its abort signal.
type Slot = { signal: AbortSignal };
export type SchedulerOptions = {
  backgroundAllowed?: () => boolean; quietMs?: number; backgroundTimeoutMs?: number; now?: () => number; pollMs?: number; log?: Log;
};
export type Scheduler<Request, Result> = ReturnType<typeof createScheduler<Request, Result>>;
type Item<Request> = {
  priority: Priority; method: 'generate' | 'countInput'; request: Request; controls: GenerateControls;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void; signal: AbortSignal | undefined;
  controller: AbortController; cancel: () => void; done?: Promise<void>;
};

// One inference slot. Foreground calls are FIFO; disposable background work
// yields on the first foreground call, including token counting.
// Requests and results pass through unread, so their types come from the provider.
export function createScheduler<Request, Result>(provider: {
  generate(request: Request, controls: GenerateControls & Slot): Promise<Result>;
  countInput?(request: Request, controls: Controls & Slot): Promise<number>;
  check?: Provider['check'];
}, { backgroundAllowed = () => true, quietMs = 60000,
  backgroundTimeoutMs = 90000, now = Date.now, pollMs = 1000, log = () => {} }: SchedulerOptions = {}) {
  const foreground: Item<Request>[] = [];
  const background: Item<Request>[] = [];
  let active: Item<Request> | null | undefined;
  let closed = false;
  let lastForeground = now();
  const fail = (code: AbortCode | 'queue_full') => new ModelError(code);
  const snapshot = () => ({ foregroundQueued: foreground.length, backgroundQueued: background.length,
    active: active?.priority ?? null, quietRemainingMs: Math.max(0, lastForeground + quietMs - now()) });
  function rejectQueued(item: Item<Request>, error: ModelError) {
    const queue = item.priority === 'foreground' ? foreground : background;
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.signal?.removeEventListener('abort', item.cancel);
    item.reject(error);
  }
  function stopBackground(code: AbortCode) {
    if (active?.priority === 'background' && !active.controller.signal.aborted) {
      active.controller.abort(fail(code));
      log(code);
    }
  }
  function enqueue(priority: Priority, method: Item<Request>['method'], request: Request, controls: GenerateControls = {}): Promise<unknown> {
    if (closed || controls.signal?.aborted) return Promise.reject(fail('cancelled'));
    const queue = priority === 'foreground' ? foreground : background;
    if (queue.length >= (priority === 'foreground' ? 32 : 4)) return Promise.reject(fail('queue_full'));
    if (priority === 'foreground') {
      lastForeground = now();
      stopBackground('background_preempted');
    }
    return new Promise((resolve, reject) => {
      const item: Item<Request> = { priority, method, request, controls, resolve, reject,
        signal: controls.signal, controller: new AbortController(),
        cancel: () => {
          if (active === item) item.controller.abort(fail('cancelled'));
          else rejectQueued(item, fail('cancelled'));
        } };
      item.signal?.addEventListener('abort', item.cancel, { once: true });
      queue.push(item);
      // Optional observers cannot affect inference or receive request contents.
      try { controls.onQueued?.(); } catch {}
      pump();
    });
  }
  function pump() {
    if (closed || active) return;
    const item = foreground.shift() ?? (now() - lastForeground >= quietMs && backgroundAllowed() ? background.shift() : null);
    if (!item) return;
    active = item;
    const timer = item.priority === 'background'
      ? setTimeout(() => item.controller.abort(fail('background_timeout')), backgroundTimeoutMs) : undefined;
    if (item.priority === 'background') log('background_started');
    item.done = (async () => {
      try {
        try { item.controls.onStart?.(); } catch {}
        // countInput is queued only when the provider has it.
        const result = await provider[item.method]!(item.request, { ...item.controls, signal: item.controller.signal });
        item.controller.signal.throwIfAborted();
        item.resolve(result);
        if (item.priority === 'background') log('background_completed');
      } catch (error) {
        item.reject(item.controller.signal.aborted ? item.controller.signal.reason : error);
      } finally {
        clearTimeout(timer);
        item.signal?.removeEventListener('abort', item.cancel);
        if (item.priority === 'foreground') lastForeground = now();
        active = null;
        pump();
      }
    })();
  }
  function tick() {
    if (!backgroundAllowed()) stopBackground('background_unavailable');
    pump();
  }
  const timer = setInterval(tick, pollMs);
  timer.unref();
  // A queued call settles with the result of the provider method it names.
  const wrap = (priority: Priority) => ({
    check: (controls?: Controls) => provider.check?.(controls),
    ...(provider.countInput ? { countInput: (request: Request, controls?: Controls) => enqueue(priority, 'countInput', request, controls) as Promise<number> } : {}),
    generate: (request: Request, controls?: GenerateControls) => enqueue(priority, 'generate', request, controls) as Promise<Result>,
  });
  return { foreground: wrap('foreground'), background: wrap('background'), snapshot, tick,
    async close() {
      closed = true;
      clearInterval(timer);
      for (const item of [...foreground, ...background]) rejectQueued(item, fail('cancelled'));
      active?.controller.abort(fail('cancelled'));
      await active?.done;
    },
  };
}
