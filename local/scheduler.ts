import type { Log } from './model-error.ts';
import { ModelError } from './model-error.ts';
import type { Controls, GenerateControls, Provider, TurnOptions } from './model.ts';

// `foreground`: a person in Telegram. `agent`: a turn of the agent interface (local/agent-api.ts), real work that fills
// the GPU while people read and, once started, is not cut off by them. `background`: disposable probes that yield to anyone.
type Priority = 'foreground' | 'agent' | 'background';
// Reasons the scheduler aborts a running call with. The call rejects with the reason, whatever the provider throws.
type AbortCode = 'cancelled' | 'background_preempted' | 'background_timeout' | 'background_unavailable';
// Methods run in a slot always receive its abort signal; a pool also names the slot.
type Slot = { signal: AbortSignal; slot?: number };
// One turn: the model calls from the first of a scene or compaction operation to its end (compaction steps, token
// counting, the scene). Opened by `openTurn`, closed by `end` in the caller's finally. `ended` is the code later calls
// are refused with.
// `sharesPrefix`: the turn continues its holder's own last request, so it runs in that holder's slot or nowhere.
type Turn = { priority: Priority; ended: AbortCode | null; idleSince: number; holder?: string; yields?: boolean;
  sharesPrefix?: boolean };
export type SchedulerOptions<Request = unknown> = {
  // Agent work starts under `agentCanStart` and is stopped only when `agentCanRun` turns false (the GPU is paused).
  backgroundAllowed?: () => boolean; agentCanStart?: () => boolean; agentCanRun?: () => boolean;
  // Called when an agent turn takes a slot; the returned function when the turn lets it go (gpu.ts `hold`).
  holdAgentTurn?: () => () => void;
  // A turn that holds a slot without calling the model this long is taken as lost: an emergency, never a normal end.
  turnIdleMs?: number;
  quietMs?: number; backgroundTimeoutMs?: number; now?: () => number; pollMs?: number; log?: Log;
  // A pool: the server's slot count and the output limit of a request, which a shared cache reserves in full. One slot
  // (the default) is the plain queue. `sharedCache` is llama.cpp's `--kv-unified`: the slots share `poolTokens` cells
  // and the scheduler admits calls by size. Isolated slots hold one request each and need no admission.
  slots?: number; poolTokens?: number; sharedCache?: boolean; outputTokens?: (request: Request) => number;
};
export type Scheduler<Request, Result> = ReturnType<typeof createScheduler<Request, Result>>;
type Item<Request> = {
  priority: Priority; method: 'generate' | 'countInput'; request: Request; controls: GenerateControls; turn: Turn | null;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void; signal: AbortSignal | undefined;
  controller: AbortController; cancel: () => void; done?: Promise<void>; ahead?: number;
  // In a pool: the input the server counted, and the cache cells the call may fill (input and the whole output limit).
  inputTokens?: number; claim?: number;
};
// One server slot. `claim` is the most cache its last call could leave there; `person` whether that is a person's
// scenes, which work prepared ahead leaves none of; `holder` whose.
type Lane<Request> = {
  id: number; active: Item<Request> | null; reserved: { turn: Turn; release: () => void } | null;
  holder?: string; person: boolean; claim: number; output: number;
};

// Cells a pool keeps free of every claim, for the server's own rounding.
const POOL_MARGIN = 2048;
// A person's next request is longer than the last by their action; the scene's output limit is reserved separately.
const PERSON_GROWTH = 1024;

// Foreground calls are FIFO; disposable background work yields on the first foreground or agent call that it keeps
// from the model, including token counting. An agent call waits for the same quiet window but, once started, runs to its
// end under the provider's own timeout: the GPU does not idle while people read, and a person may wait for the rest of an
// agent's turn. A turn that yields (a compaction prepared ahead) ends as a whole with `background_preempted` when anyone
// but its holder is kept waiting by it.
// A turn keeps its slot from the start of its first call until it ends: nobody else's work runs there between its
// compaction steps and its scene, and another's prompt never evicts its cache. An ended turn takes no more calls.
// A yielding turn that shares its holder's prompt prefix (a picture described from the scene just read) runs in that
// holder's own slot, where the prefix is cached, or not at all; its holder's own next call ends it as well, and then
// waits for the slot it is leaving rather than prefill from nothing in another.
// With one slot, a person's call stops probes and ends yielding turns at once. A pool runs a call in each slot at once:
// people take the highest slots, which llama.cpp evicts last; agents and probes never take the highest one and need
// room for the people's caches as well as for their own claim. Token counting runs outside the slots there.
// Requests and results pass through unread, so their types come from the provider and `outputTokens`.
export function createScheduler<Request, Result>(provider: {
  generate(request: Request, controls: GenerateControls & Slot): Promise<Result>;
  countInput?(request: Request, controls: Controls & Slot): Promise<number>;
  check?: Provider['check'];
}, { backgroundAllowed = () => true, agentCanStart = backgroundAllowed, agentCanRun = () => true,
  holdAgentTurn = () => () => {}, turnIdleMs = 60000, quietMs = 60000,
  backgroundTimeoutMs = 90000, now = Date.now, pollMs = 1000, log = () => {},
  slots = 1, poolTokens = 0, sharedCache = true, outputTokens = () => 0 }: SchedulerOptions<Request> = {}) {
  const pool = slots > 1;
  // Only a shared cache has to be divided. With isolated slots a call that fits one request fits its own slot, so
  // nothing is admitted by size and no token count is asked for before the call.
  const admits = pool && sharedCache;
  const foreground: Item<Request>[] = [];
  const agent: Item<Request>[] = [];
  const background: Item<Request>[] = [];
  const queues = { foreground, agent, background };
  const lanes: Lane<Request>[] = Array.from({ length: slots }, (_, id) => ({ id, active: null, reserved: null, person: false, claim: 0, output: 0 }));
  // Agents and probes leave the highest slot to people.
  const shared = pool ? lanes.slice(0, -1) : lanes;
  // Open turns that yield to anybody but their holder.
  const yielding = new Set<Turn>();
  let closed = false;
  let lastForeground = now();
  const fail = (code: AbortCode | 'queue_full') => new ModelError(code);
  const laneOf = (turn: Turn | null) => turn ? lanes.find(lane => lane.reserved?.turn === turn) : undefined;
  const free = (lane: Lane<Request>) => !lane.active && !lane.reserved;
  // The one slot a prefix-sharing turn may use: the slot that holds its holder's own last request. Anywhere else it
  // would prefill from nothing and evict a cache for work nobody is waiting for.
  const prefixLane = (turn: Turn) =>
    turn.holder === undefined ? undefined : lanes.find(lane => lane.holder === turn.holder);
  // A stopped prefix-sharing call still unwinding in its holder's slot: the server finishes the step in flight and
  // closes the stream before the slot is free, while the holder's next scene is counted in a microtask. That scene
  // waits those moments out instead of starting elsewhere, which would throw away the cache the picture kept for it.
  const leaving = (holder: string | undefined) => holder !== undefined && lanes.some(lane =>
    lane.holder === holder && !!lane.active?.turn?.sharesPrefix && lane.active.controller.signal.aborted);
  const running = () => lanes.flatMap(lane => lane.active ? [lane.active] : []);
  const snapshot = () => {
    const active = running();
    return { foregroundQueued: foreground.length, agentQueued: agent.length, backgroundQueued: background.length,
      active: (['foreground', 'agent', 'background'] as const).find(priority => active.some(item => item.priority === priority)) ?? null,
      activeCount: active.length, quietRemainingMs: Math.max(0, lastForeground + quietMs - now()) };
  };
  function rejectQueued(item: Item<Request>, error: unknown) {
    const queue = queues[item.priority];
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.signal?.removeEventListener('abort', item.cancel);
    // The call never ran, but a pool may already be counting its input: that count ends with it.
    if (!item.controller.signal.aborted) item.controller.abort(error);
    item.reject(error);
  }
  // Ends a turn: its waiting calls are refused, its running call is stopped, and its slot is free.
  function endTurn(turn: Turn, code: AbortCode) {
    if (turn.ended) return;
    turn.ended = code;
    yielding.delete(turn);
    for (const item of [...foreground, ...agent].filter(item => item.turn === turn)) rejectQueued(item, fail(code));
    const lane = laneOf(turn);
    if (lane?.active?.turn === turn && !lane.active.controller.signal.aborted) lane.active.controller.abort(fail(code));
    if (lane) {
      lane.reserved!.release();
      lane.reserved = null;
    }
    pump();
  }
  function stop(priority: 'agent' | 'background', code: AbortCode) {
    for (const item of running()) if (item.priority === priority && !item.controller.signal.aborted) {
      item.controller.abort(fail(code));
      log(code);
    }
  }
  const preempt = (ends: (other: Turn) => boolean) => {
    for (const other of [...yielding]) if (ends(other)) {
      log('background_preempted');
      endTurn(other, 'background_preempted');
    }
  };
  // A person kept from the model ends the yielding turns of anybody else, and a prefix-sharing one of their own too:
  // that turn sits in the very slot their call wants, and its result is nothing they wait for.
  const yieldTo = (turn: Turn | null) =>
    preempt(other => other !== turn && (!!other.sharesPrefix || !turn || other.holder !== turn.holder));
  // A prefix-sharing turn ends as soon as its holder calls again, however free the pool is: their next scene matters
  // more than the picture, `yieldTo` would reach it only once the pool kept them waiting, and they share a slot.
  const endSharedSlot = (turn: Turn | null) =>
    preempt(other => other !== turn && !!other.sharesPrefix && other.holder === turn?.holder);
  function enqueue(priority: Priority, method: Item<Request>['method'], request: Request, controls: GenerateControls = {}, turn: Turn | null = null): Promise<unknown> {
    if (turn?.ended) return Promise.reject(fail(turn.ended));
    if (closed || controls.signal?.aborted) return Promise.reject(fail('cancelled'));
    // A pool counts tokens beside the running calls: the count reads no cache and fills none.
    if (pool && method === 'countInput') {
      try { controls.onStart?.(); } catch {}
      return provider.countInput!(request, { ...controls, signal: controls.signal ?? new AbortController().signal });
    }
    const queue = queues[priority];
    if (queue.length >= (priority === 'foreground' ? 32 : 4)) return Promise.reject(fail('queue_full'));
    if (priority === 'foreground') {
      lastForeground = now();
      // A picture prepared in this caller's own slot stands in the way of their next call wherever the pool stands.
      endSharedSlot(turn);
    }
    if (!pool) {
      if (priority !== 'background') stop('background', 'background_preempted');
      if (priority === 'foreground') yieldTo(turn);
    }
    return new Promise((resolve, reject) => {
      const item: Item<Request> = { priority, method, request, controls, resolve, reject,
        turn,
        signal: controls.signal, controller: new AbortController(),
        cancel: () => {
          if (running().includes(item)) item.controller.abort(fail('cancelled'));
          else rejectQueued(item, fail('cancelled'));
        } };
      item.signal?.addEventListener('abort', item.cancel, { once: true });
      queue.push(item);
      // Optional observers cannot affect inference or receive request contents.
      try { controls.onQueued?.(); } catch {}
      // A shared cache admits a call by its size, which the server counts first.
      if (admits) {
        if (!provider.countInput) item.inputTokens = 0;
        else provider.countInput(request, { signal: item.controller.signal }).then(tokens => {
          item.inputTokens = tokens;
          pump();
        }, error => { if (queue.includes(item)) { rejectQueued(item, error); pump(); } });
      }
      pump();
    });
  }
  // The free slot a call goes to: its holder's last one, else the highest for a person and the lowest for anyone else,
  // sparing slots that keep another person's cache while there are others. A yielding turn (a compaction prepared
  // ahead) asks with another system prompt and would evict its own holder's scenes from their slot, so it takes the
  // lowest slot that keeps nobody's scenes, and its holder's own only when there is no such slot. One that shares its
  // holder's prompt prefix has the opposite need: that holder's slot, free, or no slot at all.
  function pick(item: Item<Request>) {
    const open = (item.priority === 'foreground' ? lanes : shared).filter(free);
    const holder = item.turn?.holder;
    const own = open.find(lane => holder !== undefined && lane.holder === holder);
    if (item.turn?.sharesPrefix) return own;
    if (item.turn?.yields) return open.find(lane => !lane.person) ?? own ?? open[0];
    // A picture of this caller's own, stopped for this very call, is leaving their slot: no other slot is worth the
    // prefill it saves them, so they take none.
    if (!own && leaving(holder)) return undefined;
    const order = item.priority === 'foreground' ? [...open].reverse() : open;
    return own ?? order.find(lane => !lane.person) ?? order[0];
  }
  // Whether the pool has room for the call's claim beside every running call, every other turn between its calls and,
  // unless the call is a person's scene, every person's cache with room for its next request: work done ahead of need
  // is not worth anybody's scenes, its own holder's included. llama.cpp evicts the other idle
  // caches. The next call of a started turn does not count the idle caches of other turns: two turns between their calls
  // must not wait for each other, and the server evicts an idle cache rather than fail a running call. It still leaves
  // people their room: an agent must not grow into a person's cache between its own calls either. A prefix-sharing call
  // runs in its holder's own slot, which `other !== lane` leaves out: it fills those cells again rather than beside them.
  function admit(item: Item<Request>, lane: Lane<Request>) {
    if (!admits) return true;
    if (item.inputTokens === undefined) return false;
    const continuing = !!item.turn && lane.reserved?.turn === item.turn;
    let used = POOL_MARGIN + item.inputTokens + outputTokens(item.request);
    let alone = true;
    for (const other of lanes) if (other !== lane) {
      if (other.active) used += other.active.claim ?? 0;
      else if ((item.priority !== 'foreground' || item.turn?.yields) && other.person) used += other.claim + other.output + PERSON_GROWTH;
      else if (other.reserved && !continuing) used += other.claim;
      else continue;
      alone = false;
    }
    // A call too large for the pool runs when the pool holds nothing else, rather than wait for ever.
    return used <= poolTokens || alone;
  }
  // Work prepared ahead that will never run, and would keep the GPU from going idle while it waited (bot.ts
  // `prepareNext`). A prefix-sharing call is worth nothing outside its holder's slot and must never queue behind its
  // own holder's next scene there, so anything but a call already stopped in that slot ends it. Otherwise: a yielding
  // call that the people's idle caches alone leave no room for. Running calls end and turns between their calls end,
  // but an idle cache stays until its person comes back, so such a call would wait for ever.
  function hopeless(item: Item<Request>) {
    const turn = item.turn;
    if (!turn?.yields) return false;
    const lane = laneOf(turn) ?? pick(item);
    if (!lane && turn.sharesPrefix) {
      const slot = prefixLane(turn);
      return !slot || !!slot.reserved || !slot.active?.controller.signal.aborted;
    }
    if (!admits || !lane || item.inputTokens === undefined) return false;
    let used = POOL_MARGIN + item.inputTokens + outputTokens(item.request);
    for (const other of lanes) if (other !== lane && !other.active && other.person) used += other.claim + other.output + PERSON_GROWTH;
    return used > poolTokens;
  }
  // Tells every waiting call how many calls go before it: the queues of higher priority, the calls ahead in its own,
  // and the work holding the slots it may use. A turn's own next call goes first while the turn holds its slot.
  function notify() {
    if (closed) return;
    let before = 0;
    for (const queue of [foreground, agent, background]) {
      queue.forEach((item, index) => {
        const lane = laneOf(item.turn);
        const ahead = lane ? (lane.active ? 1 : 0)
          : before + index + ((item.priority === 'foreground' ? lanes : shared).some(free) ? 0 : 1);
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
  // A call a shared cache has not sized yet is waiting for its own count, not for anybody else. Isolated slots ask
  // for no count, so there is nothing to wait for.
  const counted = (item: Item<Request>) => !admits || item.inputTokens !== undefined;
  function step() {
    if (closed) return;
    const waiting = (turn: Turn) => foreground.find(item => item.turn === turn) ?? agent.find(item => item.turn === turn);
    // A turn whose owner is gone holds its slot without calling; one waiting for room in the pool is not lost.
    for (const lane of lanes) if (!lane.active && lane.reserved && now() - lane.reserved.turn.idleSince >= turnIdleMs
      && !waiting(lane.reserved.turn)) {
      log('turn_lost');
      return endTurn(lane.reserved.turn, 'background_unavailable');
    }
    // Work done ahead of need that can never be admitted ends here, so that its owner lets the GPU go. The agent
    // interface opens turns with the same options, and one of its prefix-sharing turns can never run at all: agents
    // take no person's slot, and a person's slot is the only one such a turn may have.
    const stuck = foreground.find(hopeless) ?? agent.find(hopeless);
    if (stuck) {
      log('background_unavailable');
      return endTurn(stuck.turn!, 'background_unavailable');
    }
    // A reserved slot runs only the next call of its turn; an agent's is not held back by the quiet window. A turn kept
    // waiting there clears its own way below, unless it yields: such a turn preempts nothing and keeps nobody behind it.
    let held: Item<Request> | undefined;
    let heldAgent: Item<Request> | undefined;
    for (const lane of lanes) if (!lane.active && lane.reserved) {
      const turn = lane.reserved.turn;
      const item = turn.priority === 'agent' && !agentCanRun() ? undefined : waiting(turn);
      if (!item) continue;
      if (admit(item, lane)) start(item, lane);
      else if (turn.yields) continue;
      else if (item.priority === 'foreground') held ??= item;
      else if (item.priority === 'agent') heldAgent ??= item;
    }
    const quiet = pool || now() - lastForeground >= quietMs;
    // Calls of turns that hold a slot wait for it above; the rest go in order while a slot has room for them. A yielding
    // call that does not fit keeps nobody behind it waiting.
    const place = (queue: Item<Request>[], allowed: () => boolean) => {
      for (const item of [...queue]) {
        if (laneOf(item.turn)) continue;
        if (!allowed()) return item;
        const lane = pick(item);
        if (lane && admit(item, lane)) start(item, lane);
        else if (!item.turn?.yields) return item;
      }
      return undefined;
    };
    const kept = held ?? place(foreground, () => true);
    if (kept) {
      // A person kept from the model stops the probes and the yielding turns of others that stand in the way; one whose
      // input is still being counted is not kept by them yet.
      if (pool && counted(kept)) {
        stop('background', 'background_preempted');
        yieldTo(kept.turn);
      }
      return;
    }
    // An agent kept from the model by a probe stops it: a probe is disposable, an agent turn is not. A started turn
    // waiting for its own next call counts here too, and no longer asks whether an agent may start.
    const keptAgent = heldAgent ?? place(agent, () => quiet && agentCanStart());
    if (pool && keptAgent && counted(keptAgent)) stop('background', 'background_preempted');
    place(background, () => quiet && backgroundAllowed());
  }
  function start(item: Item<Request>, lane: Lane<Request>) {
    queues[item.priority].splice(queues[item.priority].indexOf(item), 1);
    lane.active = item;
    if (item.turn) {
      lane.reserved ??= { turn: item.turn, release: item.priority === 'agent' ? holdAgentTurn() : () => {} };
      item.turn.idleSince = Infinity;
    }
    // Whose prompt the slot holds from now on, with one slot as with a pool: a prefix-sharing call belongs to the
    // slot its own holder's prefix is in, so the marking has to be there to be found. What a yielding turn leaves is
    // no use to its holder's next scene, which must not follow it there — unless it shares the prefix: such a call
    // extends the scenes instead of replacing them, so the slot stays its holder's. A probe leaves nobody's.
    const shares = !!item.turn?.sharesPrefix;
    lane.holder = item.turn?.yields && !shares ? undefined : item.turn?.holder;
    if (pool) {
      const output = outputTokens(item.request);
      item.claim = (item.inputTokens ?? 0) + output;
      // The room kept in a shared slot for its holder's next output stays the room their own scene asked for: a
      // description writes a line or two, and their next scene must still fit where the picture ran.
      const scene = item.priority === 'foreground' && (shares || !item.turn?.yields);
      Object.assign(lane, { claim: item.claim, output: shares ? lane.output : output, person: scene });
    }
    const timer = item.priority === 'background'
      ? setTimeout(() => item.controller.abort(fail('background_timeout')), backgroundTimeoutMs) : undefined;
    if (item.priority !== 'foreground') log(`${item.priority}_started`);
    item.done = (async () => {
      try {
        try { item.controls.onStart?.(); } catch {}
        // countInput is queued only when the provider has it.
        const result = await provider[item.method]!(item.request, { ...item.controls, signal: item.controller.signal,
          ...(pool ? { slot: lane.id } : {}) });
        item.controller.signal.throwIfAborted();
        item.resolve(result);
        if (item.priority !== 'foreground') log(`${item.priority}_completed`);
      } catch (error) {
        item.reject(item.controller.signal.aborted ? item.controller.signal.reason : error);
      } finally {
        clearTimeout(timer);
        item.signal?.removeEventListener('abort', item.cancel);
        if (item.priority === 'foreground') lastForeground = now();
        lane.active = null;
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
    openTurn({ holder, yields = false, sharesPrefix = false }: TurnOptions = {}) {
      // A call that continues its holder's last request is prepared ahead of need too, so it yields like the rest.
      const turn: Turn = { priority, ended: null, idleSince: Infinity, holder, yields: yields || sharesPrefix, sharesPrefix };
      if (turn.yields) yielding.add(turn);
      return { ...calls(priority, turn), end: () => endTurn(turn, 'cancelled') };
    },
  });
  return { foreground: wrap('foreground'), agent: wrap('agent'), background: calls('background', null), snapshot, tick,
    // The server restarted with empty caches: the claims of idle slots are gone.
    forget() {
      for (const lane of lanes) if (!lane.active && !lane.reserved) Object.assign(lane, { claim: 0, output: 0, person: false, holder: undefined });
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const lane of lanes) {
        lane.reserved?.release();
        lane.reserved = null;
      }
      for (const item of [...foreground, ...agent, ...background]) rejectQueued(item, fail('cancelled'));
      const active = running();
      for (const item of active) item.controller.abort(fail('cancelled'));
      await Promise.all(active.map(item => item.done));
    },
  };
}
