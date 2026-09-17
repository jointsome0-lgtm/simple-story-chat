import { ModelError } from './model-error.mjs';

// One inference slot. Foreground calls are FIFO; disposable background work
// yields on the first foreground call, including token counting.
export function createScheduler(provider, { backgroundAllowed = () => true, quietMs = 60000,
  backgroundTimeoutMs = 90000, now = Date.now, pollMs = 1000, log = () => {} } = {}) {
  const foreground = [];
  const background = [];
  let active;
  let closed = false;
  let lastForeground = now();
  const fail = code => new ModelError(code);
  const snapshot = () => ({ foregroundQueued: foreground.length, backgroundQueued: background.length,
    active: active?.priority ?? null, quietRemainingMs: Math.max(0, lastForeground + quietMs - now()) });
  function rejectQueued(item, error) {
    const queue = item.priority === 'foreground' ? foreground : background;
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.signal?.removeEventListener('abort', item.cancel);
    item.reject(error);
  }
  function stopBackground(code) {
    if (active?.priority === 'background' && !active.controller.signal.aborted) {
      active.controller.abort(fail(code));
      log(code);
    }
  }
  function enqueue(priority, method, request, controls = {}) {
    if (closed || controls.signal?.aborted) return Promise.reject(fail('cancelled'));
    const queue = priority === 'foreground' ? foreground : background;
    if (queue.length >= (priority === 'foreground' ? 32 : 4)) return Promise.reject(fail('queue_full'));
    if (priority === 'foreground') {
      lastForeground = now();
      stopBackground('background_preempted');
    }
    return new Promise((resolve, reject) => {
      const item = { priority, method, request, controls, resolve, reject,
        signal: controls.signal, controller: new AbortController() };
      item.cancel = () => {
        if (active === item) item.controller.abort(fail('cancelled'));
        else rejectQueued(item, fail('cancelled'));
      };
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
      ? setTimeout(() => item.controller.abort(fail('background_timeout')), backgroundTimeoutMs) : null;
    if (item.priority === 'background') log('background_started');
    item.done = (async () => {
      try {
        try { item.controls.onStart?.(); } catch {}
        const result = await provider[item.method](item.request, { ...item.controls, signal: item.controller.signal });
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
  const wrap = priority => ({
    check: controls => provider.check?.(controls),
    ...(provider.countInput ? { countInput: (request, controls) => enqueue(priority, 'countInput', request, controls) } : {}),
    generate: (request, controls) => enqueue(priority, 'generate', request, controls),
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
