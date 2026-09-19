import type { Log } from './model-error.ts';
import { ModelError } from './model-error.ts';
import type { Controls, GenerateControls, Provider, TurnOptions } from './model.ts';

// `foreground`: a person in Telegram. `agent`: a turn of the agent interface (local/agent-api.ts), real work that fills
// the GPU while people read and yields to them. `background`: disposable probes that yield to anyone.
type Priority = 'foreground' | 'agent' | 'background';
// Reasons the scheduler aborts a running call with. The call rejects with the reason, whatever the provider throws.
type AbortCode = 'cancelled' | 'background_preempted' | 'background_timeout' | 'background_unavailable';
// Methods run in the slot always receive its abort signal.
type Slot = { signal: AbortSignal };
// One turn: the model calls from the first of a scene or compaction operation to its end (compaction steps, token
// counting, the scene). Opened by `openTurn`, closed by `end` in the caller's finally. `ended` is the code later calls
// are refused with.
type Turn = { priority: Priority; ended: AbortCode | null; idleSince: number; holder?: string; yields?: boolean };
export type SchedulerOptions = {
  // Agent work starts under `agentCanStart` and is stopped when a person calls or `agentCanRun` turns false.
  backgroundAllowed?: () => boolean; agentCanStart?: () => boolean; agentCanRun?: () => boolean;
  // Called when an agent turn takes the slot; the returned function when the turn lets it go (gpu.ts `hold`).
  holdAgentTurn?: () => () => void;
  // A turn that holds the slot without calling the model this long is taken as lost: an emergency, never a normal end.
  turnIdleMs?: number;
  quietMs?: number; backgroundTimeoutMs?: number; now?: () => number; pollMs?: number; log?: Log;
};
export type Scheduler<Request, Result> = ReturnType<typeof createScheduler<Request, Result>>;
type Item<Request> = {
  priority: Priority; method: 'generate' | 'countInput'; request: Request; controls: GenerateControls; turn: Turn | null;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void; signal: AbortSignal | undefined;
  controller: AbortController; cancel: () => void; done?: Promise<void>; ahead?: number;
};

// One inference slot. Foreground calls are FIFO; disposable background work
// yields on the first foreground or agent call, including token counting. An agent call waits for the same quiet window
// and yields to the first foreground call: a person never waits for an agent. It has no time limit of its own.
// A turn keeps the slot from the start of its first call until it ends: nobody else's work runs between its compaction
// steps and its scene, and another's prompt never evicts its cache. A person's turn is never cut off; an agent's turn
// ends as a whole with `background_preempted` when a person calls. An ended turn takes no more calls.
// Requests and results pass through unread, so their types come from the provider.
export function createScheduler<Request, Result>(provider: {
  generate(request: Request, controls: GenerateControls & Slot): Promise<Result>;
  countInput?(request: Request, controls: Controls & Slot): Promise<number>;
  check?: Provider['check'];
}, { backgroundAllowed = () => true, agentCanStart = backgroundAllowed, agentCanRun = () => true,
  holdAgentTurn = () => () => {}, turnIdleMs = 60000, quietMs = 60000,
  backgroundTimeoutMs = 90000, now = Date.now, pollMs = 1000, log = () => {} }: SchedulerOptions = {}) {
  const foreground: Item<Request>[] = [];
  const agent: Item<Request>[] = [];
  const background: Item<Request>[] = [];
  const queues = { foreground, agent, background };
  // Open turns that yield to anybody but their holder.
  const yielding = new Set<Turn>();
  let active: Item<Request> | null | undefined;
  // The turn that holds the slot, from the actual start of its first call.
  let reserved: { turn: Turn; release: () => void } | null = null;
  let closed = false;
  let lastForeground = now();
  const fail = (code: AbortCode | 'queue_full') => new ModelError(code);
  const snapshot = () => ({ foregroundQueued: foreground.length, agentQueued: agent.length, backgroundQueued: background.length,
    active: active?.priority ?? null, quietRemainingMs: Math.max(0, lastForeground + quietMs - now()) });
  function rejectQueued(item: Item<Request>, error: ModelError) {
    const queue = queues[item.priority];
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.signal?.removeEventListener('abort', item.cancel);
    item.reject(error);
  }
  // Ends a turn: its waiting calls are refused, its running call is stopped, and the slot is free.
  function endTurn(turn: Turn, code: AbortCode) {
    if (turn.ended) return;
    turn.ended = code;
    yielding.delete(turn);
    for (const item of [...foreground, ...agent].filter(item => item.turn === turn)) rejectQueued(item, fail(code));
    if (active?.turn === turn && !active.controller.signal.aborted) active.controller.abort(fail(code));
    if (reserved?.turn === turn) {
      reserved.release();
      reserved = null;
    }
    pump();
  }
  function take(queue: Item<Request>[], turn: Turn) {
    const index = queue.findIndex(item => item.turn === turn);
    return index < 0 ? undefined : queue.splice(index, 1)[0];
  }
  function stop(priority: 'agent' | 'background', code: AbortCode) {
    if (active?.priority === priority && !active.controller.signal.aborted) {
      active.controller.abort(fail(code));
      log(code);
    }
  }
  // A person's call ends the agent turn that holds the slot and stops a running agent call outside a turn.
  function preemptAgent() {
    if (reserved?.turn.priority === 'agent') {
      log('background_preempted');
      endTurn(reserved.turn, 'background_preempted');
    } else stop('agent', 'background_preempted');
  }
  function enqueue(priority: Priority, method: Item<Request>['method'], request: Request, controls: GenerateControls = {}, turn: Turn | null = null): Promise<unknown> {
    if (turn?.ended) return Promise.reject(fail(turn.ended));
    if (closed || controls.signal?.aborted) return Promise.reject(fail('cancelled'));
    const queue = queues[priority];
    if (queue.length >= (priority === 'foreground' ? 32 : 4)) return Promise.reject(fail('queue_full'));
    if (priority === 'foreground') lastForeground = now();
    if (priority !== 'background') stop('background', 'background_preempted');
    if (priority === 'foreground') {
      preemptAgent();
      for (const other of [...yielding]) if (other !== turn && (!turn || other.holder !== turn.holder)) {
        log('background_preempted');
        endTurn(other, 'background_preempted');
      }
    }
    return new Promise((resolve, reject) => {
      const item: Item<Request> = { priority, method, request, controls, resolve, reject,
        turn,
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
  // Tells every waiting call how many calls go before it: the queues of higher priority, the calls ahead in its own,
  // and the work holding the slot. A turn's own next call goes first while the turn holds the slot.
  function notify() {
    if (closed) return;
    let before = 0;
    for (const queue of [foreground, agent, background]) {
      queue.forEach((item, index) => {
        const own = !!reserved && reserved.turn === item.turn;
        const ahead = own ? (active ? 1 : 0) : before + index + (active || reserved ? 1 : 0);
        if (ahead === item.ahead) return;
        item.ahead = ahead;
        try { item.controls.onWait?.(ahead); } catch {}
      });
      before += queue.length;
    }
  }
  function pump() {
    step();
    notify();
  }
  function step() {
    if (closed || active) return;
    if (reserved && now() - reserved.turn.idleSince >= turnIdleMs) {
      log('turn_lost');
      return endTurn(reserved.turn, 'background_unavailable');
    }
    const quiet = now() - lastForeground >= quietMs;
    // A reserved slot runs only the next call of its turn; an agent's is not held back by the quiet window.
    const item = reserved ? take(foreground, reserved.turn) ?? (agentCanRun() ? take(agent, reserved.turn) : undefined)
      : foreground.shift() ?? (quiet && agent.length && agentCanStart() ? agent.shift() : null)
        ?? (quiet && backgroundAllowed() ? background.shift() : null);
    if (!item) return;
    active = item;
    if (item.turn) {
      reserved ??= { turn: item.turn, release: item.priority === 'agent' ? holdAgentTurn() : () => {} };
      item.turn.idleSince = Infinity;
    }
    const timer = item.priority === 'background'
      ? setTimeout(() => item.controller.abort(fail('background_timeout')), backgroundTimeoutMs) : undefined;
    if (item.priority !== 'foreground') log(`${item.priority}_started`);
    item.done = (async () => {
      try {
        try { item.controls.onStart?.(); } catch {}
        // countInput is queued only when the provider has it.
        const result = await provider[item.method]!(item.request, { ...item.controls, signal: item.controller.signal });
        item.controller.signal.throwIfAborted();
        item.resolve(result);
        if (item.priority !== 'foreground') log(`${item.priority}_completed`);
      } catch (error) {
        item.reject(item.controller.signal.aborted ? item.controller.signal.reason : error);
      } finally {
        clearTimeout(timer);
        item.signal?.removeEventListener('abort', item.cancel);
        if (item.priority === 'foreground') lastForeground = now();
        active = null;
        if (item.turn) item.turn.idleSince = now();
        pump();
      }
    })();
  }
  function tick() {
    if (!backgroundAllowed()) stop('background', 'background_unavailable');
    if (!agentCanRun()) {
      // The GPU is pausing: running and waiting agent calls end, rather than wait for a GPU that will not come back.
      stop('agent', 'background_unavailable');
      for (const item of [...agent]) rejectQueued(item, fail('background_unavailable'));
    }
    pump();
  }
  const timer = setInterval(tick, pollMs);
  timer.unref();
  // A queued call settles with the result of the provider method it names.
  const calls = (priority: Priority, turn: Turn | null) => ({
    // A provider without a check (a CLI) gets none here either: the bot must not report a check that verified nothing.
    ...(provider.check ? { check: (controls?: Controls) => provider.check!(controls) } : {}),
    ...(provider.countInput ? { countInput: (request: Request, controls?: Controls) => enqueue(priority, 'countInput', request, controls, turn) as Promise<number> } : {}),
    generate: (request: Request, controls?: GenerateControls) => enqueue(priority, 'generate', request, controls, turn) as Promise<Result>,
  });
  const wrap = (priority: 'foreground' | 'agent') => ({ ...calls(priority, null),
    // The calls of one turn, until `end`. `end` after a normal finish frees the slot; after a lost owner it also stops
    // the turn's running call.
    openTurn({ holder, yields = false }: TurnOptions = {}) {
      const turn: Turn = { priority, ended: null, idleSince: Infinity, holder, yields };
      if (yields) yielding.add(turn);
      return { ...calls(priority, turn), end: () => endTurn(turn, 'cancelled') };
    },
  });
  return { foreground: wrap('foreground'), agent: wrap('agent'), background: calls('background', null), snapshot, tick,
    async close() {
      closed = true;
      clearInterval(timer);
      reserved?.release();
      reserved = null;
      for (const item of [...foreground, ...agent, ...background]) rejectQueued(item, fail('cancelled'));
      active?.controller.abort(fail('cancelled'));
      await active?.done;
    },
  };
}
