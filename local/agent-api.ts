// The agent interface (docs/agent-interface.md): plain functions over a separate agent library, shared by the CLI
// (agent-cli.ts) and the MCP server (mcp.ts). It never opens the bot's database. No package import here, so `npm test`
// runs it without `npm install`.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { UserError, addSeed, newStory, fork as forkBranch, history, memoryChain, setLanguage } from '../lib/library.ts';
import type { Branch, Job, Library, SceneNode, Story } from '../lib/library.ts';
import { storyNarration } from './prompt.ts';
import { continueInput, requestBudget } from './context.ts';
import { seedInput } from './incoming.ts';
import { SEED_BYTES } from './seed-file.ts';
import { beginTurn, runTurn } from './turn.ts';
import type { TurnOperation } from './turn.ts';
import type { GenerationConfig } from './generation.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { AgentConfig } from './config.ts';
import { createModel } from './model.ts';
import type { Provider } from './model.ts';
import { createBackgroundClient } from './background.ts';
import { ModelError, errorCode, member, reasonCode, safeErrorDetails } from './model-error.ts';
import type { Log, Reason } from './model-error.ts';
import { Store } from './store.ts';
import { texts } from './text.ts';

export type Status = 'done' | 'running' | 'failed' | 'interrupted' | 'preempted' | 'conflict' | 'stale' | 'busy';
export type AgentResponse = { requestId?: string; status: Status; result?: unknown; reason?: Reason };
type Kind = 'create_seed' | 'start_story' | 'act' | 'fork';
// A receipt: what one request did. Stories and receipts share the database file and its transactions.
type Receipt = {
  userId: string; requestId: string; kind: Kind; payloadHash: string; status: Status;
  result: unknown; reason: Reason | null; jobId: string | null; updatedAt: number;
};
// Receipt fields read back from SQLite; this module is the only writer of the table.
type Row = { user_id: string; request_id: string; kind: Kind; payload_hash: string; status: Status;
  result: string | null; reason: Reason | null; job_id: string | null; updated_at: number };
export type Scene = { sceneId: string; worldTime: string; text: string; truncated: boolean };

const CHECK = { story: /^h\d+$/, branch: /^b\d+$/, checkpoint: /^c\d+$/, seed: /^s\d+$/ };
// Printable ASCII: a client's own key, stored and echoed, never interpreted.
const REQUEST_ID = /^[\x21-\x7e]{1,128}$/;
const INPUT_BYTES = 32 * 1024;
const LABELS = texts('en').labels;
// The bot's model queue ends an agent turn when a person calls (`background_preempted`) or its GPU is paused
// (`background_unavailable`); the client decides whether to ask again.
const PREEMPTED = ['background_preempted', 'background_unavailable'] as const;

class Journal {
  declare db: DatabaseSync;
  constructor(db: DatabaseSync, readOnly: boolean) {
    this.db = db;
    if (!readOnly) db.exec(`CREATE TABLE IF NOT EXISTS operations (user_id TEXT NOT NULL, request_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT, reason TEXT, job_id TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, request_id))`);
  }
  static receipt(row: Row | undefined): Receipt | undefined {
    return row && { userId: row.user_id, requestId: row.request_id, kind: row.kind, payloadHash: row.payload_hash, status: row.status,
      result: row.result === null ? undefined : JSON.parse(row.result), reason: row.reason, jobId: row.job_id, updatedAt: row.updated_at };
  }
  get(userId: string, requestId: string) {
    return Journal.receipt(this.db.prepare('SELECT * FROM operations WHERE user_id = ? AND request_id = ?').get(userId, requestId) as Row | undefined);
  }
  holder(userId: string, jobId: string) {
    return Journal.receipt(this.db.prepare("SELECT * FROM operations WHERE user_id = ? AND job_id = ? AND status = 'running'").get(userId, jobId) as Row | undefined);
  }
  running() {
    return (this.db.prepare("SELECT * FROM operations WHERE status = 'running'").all() as Row[]).map(row => Journal.receipt(row)!);
  }
  // Call inside Store.mutate: the receipt commits or rolls back with the story change.
  put(receipt: Receipt) {
    this.db.prepare(`INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, request_id) DO UPDATE SET
      status = excluded.status, result = excluded.result, reason = excluded.reason, job_id = excluded.job_id, updated_at = excluded.updated_at`)
      .run(receipt.userId, receipt.requestId, receipt.kind, receipt.payloadHash, receipt.status,
        receipt.result === undefined ? null : JSON.stringify(receipt.result), receipt.reason, receipt.jobId, receipt.updatedAt);
  }
}

// Library keys come from the client, so a key such as `constructor` must not reach Object.prototype.
const own = <T>(record: Record<string, T> | undefined, key: string, pattern: RegExp) =>
  record && pattern.test(key) && Object.hasOwn(record, key) ? record[key] : undefined;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
// Opaque to the client: it changes whenever the branch's head or memory does.
export const revision = (story: Story, branch: Branch) => hash([story.id, branch.id, branch.head, branch.memory]).slice(0, 16);
const sequence = (id: string) => Number(id.slice(1));
const scene = (node: SceneNode): Scene => ({ sceneId: node.id, worldTime: node.time, text: node.text, truncated: node.truncated });
const respond = (receipt: Receipt): AgentResponse => ({ requestId: receipt.requestId, status: receipt.status,
  ...(receipt.result === undefined ? {} : { result: receipt.result }), ...(receipt.reason ? { reason: receipt.reason } : {}) });

// The memory versions and their checkpoints that a turn saved after it began: an automatic compaction commits on its
// own, so it stays saved when the scene after it fails. IDs share one counter, so "after the job" is a larger number.
function compactionSince(story: Story, branchId: string, job: Job) {
  const checkpoints = Object.values(story.checkpoints).filter(cp => cp.branchId === branchId && sequence(cp.id) > sequence(job.id)
    && (cp.kind === 'pre-compaction' || cp.kind === 'compaction'));
  if (!checkpoints.length) return undefined;
  const branch = story.branches[branchId];
  return { memoryIds: memoryChain(story, branch.memory).filter(m => sequence(m.id) > sequence(job.id)).map(m => m.id),
    checkpoints: checkpoints.map(cp => ({ checkpointId: cp.id, kind: cp.kind })) };
}
// What stands saved on the branch after a turn that ended without a scene.
function savedPoint(state: Library, base: object, job: Job) {
  const story = state.stories[job.storyId];
  const branch = story?.branches[job.branchId];
  if (!branch) return { ...base, scene: null };
  const compaction = compactionSince(story, branch.id, job);
  return { ...base, scene: null, revision: revision(story, branch), ...(compaction ? { compaction } : {}) };
}

export type AgentOptions = {
  store: Store; provider: Provider; config: GenerationConfig & { provider: string };
  userId?: string; waitSeconds?: number; readOnly?: boolean; log?: Log; now?: () => number;
  onProgress?: (requestId: string, status: CompactionStatus) => void;
};

export function createAgentApi({ store, provider, config, userId = 'agent', waitSeconds = 20, readOnly = false,
  log: write = () => {}, now = Date.now, onProgress }: AgentOptions) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error('Invalid agent id');
  const journal = new Journal(store.db, readOnly);
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  // Technical rows only: codes, enums and counts that pass safeErrorDetails, never story text.
  const log: Log = (event, code, details) => write(event, code, { ...safeErrorDetails(details), actor: 'agent' });
  // Stored labels of an agent library are English; the interface language is otherwise irrelevant here.
  const mutate = <T>(fn: (state: Library) => T) => store.mutate(userId, state => {
    if (state.language === undefined && !state.seq) setLanguage(state, 'en');
    return fn(state);
  });
  const fail = (requestId: string | undefined, reason: Reason): AgentResponse => ({ ...(requestId ? { requestId } : {}), status: 'failed', reason });
  const refusal = (): AgentResponse | undefined => readOnly ? fail(undefined, 'library_locked') : undefined;
  const busy = (requestId: string, state: Library): AgentResponse => {
    const holder = state.job && journal.holder(userId, state.job.id);
    return { requestId, status: 'busy', reason: 'job_running', ...(holder ? { result: { runningRequestId: holder.requestId } } : {}) };
  };
  // A stored request answers every retry with the same payload, before any check of the current state.
  const replay = async (receipt: Receipt, payloadHash: string, seconds: number): Promise<AgentResponse> =>
    receipt.payloadHash !== payloadHash ? { requestId: receipt.requestId, status: 'conflict', reason: 'request_id_reused' }
      : receipt.status === 'running' ? wait(receipt.requestId, seconds) : respond(receipt);
  const receiptFor = (requestId: string, kind: Kind, payloadHash: string) =>
    (status: Status, result: unknown, reason: Reason | null = null, jobId: string | null = null): Receipt =>
      ({ userId, requestId, kind, payloadHash, status, result, reason, jobId, updatedAt: now() });

  function operation(make: ReturnType<typeof receiptFor>, base: object): TurnOperation {
    let started: Job;
    return {
      begin(_state, job) { started = job; journal.put(make('running', base, null, job.id)); },
      settle(state, outcome) {
        if (outcome.ref) {
          const story = state.stories[outcome.ref.storyId];
          const branch = story.branches[outcome.ref.branchId];
          const compaction = compactionSince(story, branch.id, started);
          journal.put(make('done', { ...base, scene: scene(story.nodes[outcome.ref.nodeId]), checkpointId: outcome.ref.checkpointId,
            revision: revision(story, branch), ...(compaction ? { compaction } : {}) }, null, started.id));
        } else {
          const reason = reasonCode(outcome.error);
          journal.put(make(member(PREEMPTED, reason) ? 'preempted' : 'failed', savedPoint(state, base, started), reason, started.id));
        }
      },
    };
  }
  function launch(requestId: string, kind: Kind, job: Job, turn: TurnOperation) {
    const controller = new AbortController();
    const started = now();
    log('agent_turn_started', undefined, { agentCall: kind });
    const promise = runTurn({ store, userId, job, provider, config, signal: controller.signal, labels: LABELS, operation: turn, log,
      onProgress: status => { try { onProgress?.(requestId, status); } catch {} } })
      .then(outcome => {
        const elapsedMs = now() - started;
        if (outcome.status === 'done') {
          const usage = store.read(userId).stories[outcome.ref.storyId]?.nodes[outcome.ref.nodeId]?.usage;
          log('agent_turn_completed', undefined, { agentCall: kind, elapsedMs, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
        } else if (outcome.status === 'failed') log('agent_turn_failed', reasonCode(outcome.error), { ...safeErrorDetails(outcome.error), agentCall: kind, elapsedMs });
        else log('agent_turn_abandoned', undefined, { agentCall: kind, elapsedMs });
      // The receipt stays `running`; the next process that opens the library marks it interrupted.
      }, error => log('agent_turn_failed', reasonCode(error), { agentCall: kind }))
      .finally(() => running.delete(requestId));
    running.set(requestId, { controller, promise });
  }
  // Ends running receipts that no process will finish: after a crash (at open) or at a clean shutdown.
  function interrupt(receipt: Receipt, reason: Reason) {
    store.mutate(receipt.userId, state => {
      const current = journal.get(receipt.userId, receipt.requestId);
      if (current?.status !== 'running') return;
      const job = state.job?.id === current.jobId ? state.job : null;
      if (job) state.job = null;
      const base = current.result && typeof current.result === 'object' ? current.result : {};
      // Without the job (it was already gone) the point is the branch as the receipt's base names it.
      const point = job ? savedPoint(state, base, job) : { ...base, scene: null };
      journal.put({ ...current, status: 'interrupted', reason, result: point, updatedAt: now() });
    });
    log('agent_turn_interrupted', reason, { agentCall: receipt.kind });
  }
  async function wait(requestId: string, seconds: number): Promise<AgentResponse> {
    const deadline = now() + seconds * 1000;
    const entry = running.get(requestId);
    if (entry) {
      const timer = new AbortController();
      await Promise.race([entry.promise, delay(seconds * 1000, undefined, { signal: timer.signal }).catch(() => {})]);
      timer.abort();
    }
    // Another process may be the writer: its receipt is polled, never taken over.
    for (;;) {
      const receipt = journal.get(userId, requestId);
      if (!receipt) return fail(requestId, 'unknown_request');
      if (receipt.status !== 'running' || entry || now() >= deadline) return respond(receipt);
      await delay(Math.min(500, deadline - now()));
    }
  }
  const validRequest = (requestId: unknown): requestId is string => typeof requestId === 'string' && REQUEST_ID.test(requestId);
  const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.min(600, Math.max(0, value)) : waitSeconds;

  // A crash leaves `running` receipts behind, of any agent id; no model call is retried for them.
  if (!readOnly) for (const receipt of journal.running()) interrupt(receipt, 'process_exited');

  return {
    createSeed({ requestId, text }: { requestId?: unknown; text?: unknown }): AgentResponse {
      if (!validRequest(requestId) || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > SEED_BYTES) return fail(validRequest(requestId) ? requestId : undefined, 'invalid_request');
      const refused = refusal();
      if (refused) return refused;
      const payloadHash = hash(['create_seed', text]);
      const make = receiptFor(requestId, 'create_seed', payloadHash);
      return mutate(state => {
        const prior = journal.get(userId, requestId);
        if (prior) return prior.payloadHash === payloadHash ? respond(prior) : { requestId, status: 'conflict', reason: 'request_id_reused' };
        let seed;
        try { seed = addSeed(state, seedInput(text)); }
        catch (error) { if (error instanceof UserError) return fail(requestId, 'seed_format'); throw error; }
        const receipt = make('done', { seedId: seed.id, title: seed.title, worldTime: seed.startTime });
        journal.put(receipt);
        return respond(receipt);
      });
    },

    async startStory({ requestId, seedId, wait: waitFor }: { requestId?: unknown; seedId?: unknown; wait?: unknown }): Promise<AgentResponse> {
      if (!validRequest(requestId) || typeof seedId !== 'string') return fail(validRequest(requestId) ? requestId : undefined, 'invalid_request');
      const refused = refusal();
      if (refused) return refused;
      const payloadHash = hash(['start_story', seedId]);
      const make = receiptFor(requestId, 'start_story', payloadHash);
      const prior = journal.get(userId, requestId);
      if (prior) return replay(prior, payloadHash, seconds(waitFor));
      const begun = mutate(state => {
        if (!own(state.seeds, seedId, CHECK.seed)) return { response: fail(requestId, 'not_found') };
        if (state.job) return { response: busy(requestId, state) };
        const { story, branch } = newStory(state, seedId, LABELS);
        const base = { storyId: story.id, branchId: branch.id };
        const turn = operation(make, base);
        const job = beginTurn(state, storyNarration(state, story.id).startStory, now(), turn);
        return { job, turn };
      });
      if (!begun.job) return begun.response;
      launch(requestId, 'start_story', begun.job, begun.turn);
      return wait(requestId, seconds(waitFor));
    },

    async act({ requestId, storyId, branchId, expected, input = '', wait: waitFor }: {
      requestId?: unknown; storyId?: unknown; branchId?: unknown; expected?: unknown; input?: unknown; wait?: unknown;
    }): Promise<AgentResponse> {
      if (!validRequest(requestId) || typeof storyId !== 'string' || typeof branchId !== 'string' || typeof expected !== 'string'
          || typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > INPUT_BYTES) return fail(validRequest(requestId) ? requestId : undefined, 'invalid_request');
      const refused = refusal();
      if (refused) return refused;
      const payloadHash = hash(['act', storyId, branchId, expected, input]);
      const make = receiptFor(requestId, 'act', payloadHash);
      const prior = journal.get(userId, requestId);
      if (prior) return replay(prior, payloadHash, seconds(waitFor));
      const begun = mutate(state => {
        const story = own(state.stories, storyId, CHECK.story);
        const branch = own(story?.branches, branchId, CHECK.branch);
        if (!story || !branch) return { response: fail(requestId, 'not_found') };
        const current = revision(story, branch);
        if (current !== expected) return { response: { requestId, status: 'stale', result: { revision: current } } as AgentResponse };
        if (state.job) return { response: busy(requestId, state) };
        // Empty input is the bot's "continue"; on a branch without scenes it is the bot's "start".
        const text = input.trim() || (branch.head ? continueInput(state, storyId) : storyNarration(state, storyId).startStory);
        state.active = { storyId, branchId };
        const turn = operation(make, {});
        return { job: beginTurn(state, text, now(), turn), turn };
      });
      if (!begun.job) return begun.response;
      launch(requestId, 'act', begun.job, begun.turn);
      return wait(requestId, seconds(waitFor));
    },

    fork({ requestId, storyId, checkpointId }: { requestId?: unknown; storyId?: unknown; checkpointId?: unknown }): AgentResponse {
      if (!validRequest(requestId) || typeof storyId !== 'string' || typeof checkpointId !== 'string') return fail(validRequest(requestId) ? requestId : undefined, 'invalid_request');
      const refused = refusal();
      if (refused) return refused;
      const payloadHash = hash(['fork', storyId, checkpointId]);
      const make = receiptFor(requestId, 'fork', payloadHash);
      return mutate(state => {
        const prior = journal.get(userId, requestId);
        if (prior) return prior.payloadHash === payloadHash ? respond(prior) : { requestId, status: 'conflict', reason: 'request_id_reused' };
        const story = own(state.stories, storyId, CHECK.story);
        if (!story || !own(story.checkpoints, checkpointId, CHECK.checkpoint)) return fail(requestId, 'not_found');
        const branch = forkBranch(state, storyId, checkpointId, LABELS);
        const receipt = make('done', { branchId: branch.id, revision: revision(story, branch) });
        journal.put(receipt);
        return respond(receipt);
      });
    },

    // No side effects. Without a story it lists the library; with one it shows a branch as the narrator's memory has it.
    read({ storyId, branchId, scenes: count = 3, memory = false }: { storyId?: unknown; branchId?: unknown; scenes?: unknown; memory?: unknown } = {}): AgentResponse {
      const state = store.read(userId);
      if (storyId === undefined) {
        return { status: 'done', result: {
          seeds: Object.values(state.seeds).map(seed => ({ seedId: seed.id, title: seed.title, worldTime: seed.startTime })),
          stories: Object.values(state.stories).map(story => ({ storyId: story.id, seedId: story.seedId, title: story.title,
            branches: Object.values(story.branches).map(branch => ({ branchId: branch.id, name: branch.name, revision: revision(story, branch) })) })),
        } };
      }
      if (typeof storyId !== 'string' || (branchId !== undefined && typeof branchId !== 'string')
          || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || typeof memory !== 'boolean') return fail(undefined, 'invalid_request');
      const story = own(state.stories, storyId, CHECK.story);
      // Without a branch: the one the agent used last in this story, else the first.
      const chosen = branchId ?? (state.active?.storyId === storyId ? state.active.branchId : Object.keys(story?.branches ?? {})[0]);
      const branch = own(story?.branches, chosen ?? '', CHECK.branch);
      if (!story || !branch) return fail(undefined, 'not_found');
      const nodes = history(story, branch.head);
      const holder = state.job?.storyId === story.id && state.job.branchId === branch.id ? journal.holder(userId, state.job.id) : undefined;
      return { status: 'done', result: {
        storyId: story.id, seedId: story.seedId, title: story.title, branchId: branch.id, name: branch.name, revision: revision(story, branch),
        sceneCount: nodes.length,
        // The input a scene answered belongs with it: a contradiction may come from the move, not from the narrator.
        scenes: nodes.slice(Math.max(0, nodes.length - count)).map(node => ({ ...scene(node), input: node.input })),
        checkpoints: Object.values(story.checkpoints).filter(cp => cp.branchId === branch.id)
          .map(cp => ({ checkpointId: cp.id, kind: cp.kind, label: cp.label, sceneId: cp.head, memoryId: cp.memory })),
        ...(memory ? { memory: memoryChain(story, branch.memory).map(m => ({ memoryId: m.id, parent: m.parent, cutoff: m.cutoff,
          covered: m.covered, facts: m.delta.facts })) } : {}),
        ...(holder ? { runningRequestId: holder.requestId } : {}),
      } };
    },

    status({ requestId }: { requestId?: unknown }): AgentResponse {
      if (!validRequest(requestId)) return fail(undefined, 'invalid_request');
      const receipt = journal.get(userId, requestId);
      return receipt ? respond(receipt) : fail(requestId, 'unknown_request');
    },

    // Expiry of a wait cancels nothing.
    async wait({ requestId, seconds: value }: { requestId?: unknown; seconds?: unknown }): Promise<AgentResponse> {
      if (!validRequest(requestId)) return fail(undefined, 'invalid_request');
      return wait(requestId, seconds(value));
    },

    // A committed turn stays done: the receipt and the scene were written together, before this could look.
    cancel({ requestId }: { requestId?: unknown }): AgentResponse {
      if (!validRequest(requestId)) return fail(undefined, 'invalid_request');
      const refused = refusal();
      if (refused) return refused;
      const response = mutate(state => {
        const receipt = journal.get(userId, requestId);
        if (!receipt) return fail(requestId, 'unknown_request');
        if (receipt.status !== 'running') return respond(receipt);
        const job = state.job?.id === receipt.jobId ? state.job : null;
        if (job) state.job = null;
        const base = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
        const cancelled: Receipt = { ...receipt, status: 'failed', reason: 'cancelled', updatedAt: now(),
          result: job ? savedPoint(state, base, job) : { ...base, scene: null } };
        journal.put(cancelled);
        return respond(cancelled);
      });
      running.get(requestId)?.controller.abort();
      return response;
    },

    async idle() { await Promise.all([...running.values()].map(entry => entry.promise)); },
    // A clean stop: running turns end as interrupted, with the point they saved.
    async close() {
      for (const requestId of running.keys()) {
        const receipt = journal.get(userId, requestId);
        if (receipt) interrupt(receipt, 'shutdown');
      }
      for (const entry of running.values()) entry.controller.abort();
      await this.idle();
    },
  };
}
export type AgentApi = ReturnType<typeof createAgentApi>;

// The model: the bot's queue when the bot serves one (a GPU run), so its humans keep priority; otherwise the provider
// the bot would use, directly. The model configuration comes from loadAgentConfig, which keeps the hosted consent gate.
// The route is chosen at the first model call of a turn and kept to its end; the next turn checks the queue again, so a
// long-lived MCP server started before the bot goes through its queue once the bot serves one.
export async function agentProvider(config: AgentConfig): Promise<{ provider: Provider; queue: boolean }> {
  let direct: Provider | undefined;
  const directModel = () => direct ??= createModel(config);
  // The bot's queue, if its socket answers now.
  async function queue() {
    if (!existsSync(config.modelSocket) || !lstatSync(config.modelSocket).isSocket()) return null;
    // The time covers waiting behind people and the quiet window, then the call itself under the model's timeout.
    const client = createBackgroundClient({ socketPath: config.modelSocket, model: config.model, work: 'agent', timeoutMs: config.timeoutMs + 600_000 });
    const live = await client.status().then(() => true, (error: unknown) => errorCode(error) !== 'background_unavailable');
    return live ? client : null;
  }
  type Client = NonNullable<Awaited<ReturnType<typeof queue>>>;
  // A turn keeps the route of its first call: a turn that began in the bot's queue ends if the queue goes away, and never
  // goes on as a new direct request; one that began directly stays direct. It opens its control request on its first
  // queued call and holds the bot's slot until `end` closes it.
  type Turn = { ended: () => boolean; route: 'queue' | 'direct' | null; started: () => boolean;
    open: (client: Client, signal?: AbortSignal) => Promise<string> };
  async function route(turn?: Turn) {
    if (turn?.ended()) throw new ModelError('cancelled');
    if (turn?.route === 'direct') return null;
    const client = await queue();
    if (turn?.route === 'queue' && !client) throw new ModelError('background_unavailable');
    if (turn) turn.route = client ? 'queue' : 'direct';
    return client;
  }
  const calls = (turn?: Turn): Provider => ({
    async generate(request, controls = {}) {
      const client = await route(turn);
      if (!client) return directModel().generate(request, controls);
      // Agent work never wakes a stopped GPU and must not wait in the queue for one. A turn that holds the slot keeps
      // the GPU through a pause, which the bot then reports as draining.
      const state = await client.check(controls) as { gpu?: { status?: unknown } };
      if (state.gpu?.status !== 'ready' && !(turn?.started() && state.gpu?.status === 'draining')) throw new ModelError('gpu_not_ready');
      return client.generate(request, { ...controls, turn: turn && await turn.open(client, controls.signal) });
    },
    // The queue does not count input; the estimate the request already carries stands in for it.
    async countInput(request, controls) {
      const model = (await route(turn)) ? null : directModel();
      return model?.countInput ? model.countInput(request, controls) : request.estimatedInputTokens ?? requestBudget(request, config.contextTokens).inputTokens;
    },
  });
  const provider: Provider = { ...calls(),
    openTurn() {
      let channel: ReturnType<Client['openTurn']> | undefined;
      let ended = false;
      const turn: Turn = {
        ended: () => ended, route: null,
        started: () => channel !== undefined,
        async open(client, signal) {
          if (ended) throw new ModelError('cancelled');
          channel ??= client.openTurn(signal);
          return (await channel).id;
        },
      };
      return { ...calls(turn), end() { ended = true; void channel?.then(open => open.close(), () => {}); } };
    },
  };
  return { provider, queue: (await queue()) !== null };
}

export async function openAgent(config: AgentConfig, { userId, readOnly = false, log, onProgress }: {
  userId?: string; readOnly?: boolean; log?: Log; onProgress?: AgentOptions['onProgress'];
} = {}) {
  if (!readOnly) mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  const store = new Store(config.dbPath, { readOnly });
  try {
    const { provider, queue } = readOnly ? { provider: { generate: () => Promise.reject(new ModelError('library_locked')) }, queue: false } : await agentProvider(config);
    const api = createAgentApi({ store, provider, config, userId, readOnly, log, onProgress, waitSeconds: config.waitSeconds });
    return { api, queue, async close() { await api.close(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}

// One process writes one agent library. The command runs again under flock(1), which holds the lock until the command
// exits, crash included; returns true in that command. `onConflict` runs when another process holds the lock.
// --no-fork makes flock exec the command, so a forwarded signal reaches the writer itself and it records the interruption.
// The caller must leave stdin unread: the command reads it.
export function underLock(dbPath: string, script: string, onConflict: () => void): boolean {
  const lock = dbPath + '.lock';
  if (process.env.SIMPLE_CHAT_AGENT_LOCK === lock) return true;
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const child = spawn('flock', ['--nonblock', '--no-fork', '--conflict-exit-code', '75', lock, process.execPath, script, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, SIMPLE_CHAT_AGENT_LOCK: lock } });
  child.once('error', () => { console.error('flock is required'); process.exitCode = 1; });
  child.once('exit', code => {
    if (code === 75) onConflict();
    process.exitCode = code === 75 ? 1 : code ?? 1;
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  return false;
}
