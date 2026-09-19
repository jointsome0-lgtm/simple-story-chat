import { beginJob, commitTurn, history, saveCheckpoint } from '../lib/library.ts';
import type { Job, Library } from '../lib/library.ts';
import { normalizeScene } from './prompt.ts';
import { requestStamp } from './context.ts';
import { generateScene } from './generation.ts';
import type { CompactionLabels, GenerationConfig } from './generation.ts';
import type { CompactionStatus } from './compact-view.ts';
import type { Log } from './model-error.ts';
import type { GenerateControls, GenerationResult, ModelRequest, Provider } from './model.ts';
import type { Store } from './store.ts';
import type { Prepared } from './prepare.ts';
import { texts } from './text.ts';

// One story turn, from the job lock to the saved scene and its checkpoint. The Telegram bot and the agent interface
// both run it; delivery (messages, previews, SceneNode.delivery) stays with the caller.

// Where a committed scene lives.
export type TurnRef = { storyId: string; branchId: string; nodeId: string; checkpointId: string };
// A receipt kept next to the story change it describes. Both hooks run inside the Store transaction that begins or
// ends the turn, so the receipt can never say a turn committed when it did not, or the reverse. The bot passes none.
export type TurnOperation = {
  begin(state: Library, job: Job): void;
  settle(state: Library, outcome: { ref: TurnRef; error?: undefined } | { error: unknown; ref?: undefined }): void;
};
// `gone`: the job was cancelled or replaced, so nobody waits for this turn's result.
export type TurnOutcome = { status: 'done'; ref: TurnRef } | { status: 'gone' } | { status: 'failed'; error: unknown };

// Called inside Store.mutate. Takes the library's one job lock for a scene on the active branch.
export function beginTurn(state: Library, input: string, now: number, operation?: TurnOperation): Job {
  const job = beginJob(state, input, now);
  operation?.begin(state, job);
  return job;
}

// Runs one scene or compaction operation as a turn of the provider, if it has turns; `end` runs however it finishes.
export async function inTurn<T>(provider: Provider, operation: (provider: Provider) => Promise<T>): Promise<T> {
  const turn = provider.openTurn?.();
  try { return await operation(turn ?? provider); } finally { turn?.end(); }
}

export async function runTurn({ store, userId, job, provider, config, signal, prepared, onProgress, log, labels, preview, waiting, onGenerated, operation }: {
  store: Store; userId: string; job: Job; provider: Provider; config: GenerationConfig & { provider: string }; signal: AbortSignal; prepared?: Prepared;
  onProgress?: (status: CompactionStatus) => void; log?: Log; labels?: CompactionLabels;
  preview?: (state: Library, job: Job, request: ModelRequest) => GenerateControls['onText']; waiting?: (ahead: number | null) => void;
  // Called once the model has answered, before the scene is saved.
  onGenerated?: (result: GenerationResult) => void; operation?: TurnOperation;
}): Promise<TurnOutcome> {
  try {
    // The model calls of the turn end with the scene; saving it needs no model.
    const { result, request } = await inTurn(provider, provider =>
      generateScene({ store, userId, jobId: job.id, provider, config, signal, prepared, onProgress, log, labels, preview, waiting }));
    if (signal.aborted) return { status: 'gone' };
    onGenerated?.(result);
    const ref = store.mutate(userId, state => {
      if (state.job?.id !== job.id) return null;
      const story = state.stories[job.storyId];
      const stamp = requestStamp(request, config.model, state.job.memory, config.provider);
      // A null head (no scenes yet) is never a node id, so the seed start time is used.
      const fallback = story.nodes[job.head as string]?.time || state.seeds[story.seedId].startTime;
      const committed = commitTurn(state, job.id, normalizeScene(result.text, fallback), result.finishReason === 'length');
      if (!committed) return null;
      const node = story.nodes[committed.nodeId];
      node.usage = result.usage ?? null;
      node.requestContext = stamp;
      node.streamResultMismatch = result.streamResultMismatch ?? false;
      node.modelInfo = { provider: config.provider, model: config.model };
      const branch = story.branches[job.branchId];
      const checkpoint = saveCheckpoint(state, story, branch, texts(state.language).labels.scene(history(story, branch.head).length), 'scene');
      const saved = { ...committed, checkpointId: checkpoint.id };
      operation?.settle(state, { ref: saved });
      return saved;
    });
    return ref ? { status: 'done', ref } : { status: 'gone' };
  } catch (error) {
    // The job lock is released here, together with the receipt of the failure. A compaction that committed before
    // the failure stays: it is a saved point of the branch, not part of the lost scene.
    const current = store.mutate(userId, state => {
      if (state.job?.id !== job.id) return false;
      state.job = null;
      if (!signal.aborted) operation?.settle(state, { error });
      return true;
    });
    return !current || signal.aborted ? { status: 'gone' } : { status: 'failed', error };
  }
}
