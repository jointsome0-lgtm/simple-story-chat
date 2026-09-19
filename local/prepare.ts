import { createHash } from 'node:crypto';
import type { Library } from '../lib/library.ts';
import { active, context } from '../lib/library.ts';
import { inspectMemory, parseMemory, summaryRequest, supplementRequest } from './memory.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';
import { seedLanguage } from './story-text.ts';

// A compaction computed ahead, while a person reads the last scene: the extraction the next turn would ask for depends
// only on the branch, not on the person's next action. Only the model calls run ahead; checking and saving the memory
// stay with the turn, which takes a result only for an identical request, so a changed branch simply misses. Results
// stay in memory and are never stored.
type Config = { keepScenes?: number; memoryMode?: 'plain' | 'sgr'; repairCoverage?: boolean };
// The branch state a run reads: a turn from any other point cannot use it.
type Point = { storyId: string; branchId: string; head: string | null; memory: string | null };
const POINT = ['storyId', 'branchId', 'head', 'memory'] as const;
type Run = { controller: AbortController; started: boolean; point: Point; entries: Map<string, Promise<GenerationResult>> };
export type Prepared = ReturnType<typeof createPrepared>;

const keyOf = (request: ModelRequest) => createHash('sha256').update(JSON.stringify(request)).digest('hex');

// One run at a time, for one person's library.
export function createPrepared() {
  let run: Run | null = null;
  function stop() {
    run?.controller.abort();
    run = null;
  }
  return {
    stop,
    // Called when a turn begins: a run for another story, branch or memory would only hold the model before it.
    keep(point: Point) {
      if (run && POINT.some(field => run!.point[field] !== point[field])) stop();
    },
    // The result prepared for this exact request. A run that has not yet reached the model is stopped instead: the
    // caller's own turn may be holding the model, and the run would wait behind it for ever. So is a run for any other
    // request: the branch has changed and it can no longer be used.
    take(request: ModelRequest): Promise<GenerationResult> | undefined {
      const key = keyOf(request);
      const result = run?.entries.get(key);
      if (!run || !result || !run.started) {
        stop();
        return undefined;
      }
      run.entries.delete(key);
      return result;
    },
    // Runs the extraction of the active branch and, if its result misses scenes, the supplement for them, as
    // generation.ts extractAndSave would. The provider is the shared model: the run is one turn of it.
    async run(state: Library, provider: Provider, config: Config) {
      stop();
      const { story, branch, seed } = active(state);
      const nodes = context(story, branch).recent.slice(0, -(config.keepScenes ?? 4));
      if (!nodes.length) return;
      const turn = provider.openTurn?.();
      // Without a shared model there is no turn to wait behind.
      const current: Run = { controller: new AbortController(), started: !turn, entries: new Map(),
        point: { storyId: story.id, branchId: branch.id, head: branch.head, memory: branch.memory } };
      run = current;
      const target = { seed, story, branch };
      const lang = seedLanguage(seed);
      const ask = (request: ModelRequest) => {
        const key = keyOf(request);
        const result = (turn ?? provider).generate(request, { signal: current.controller.signal,
          onStart: () => { current.started = true; } });
        current.entries.set(key, result);
        // A result that would fail its check is dropped, so the turn asks the model again rather than fail.
        return { result: result.catch(() => null), drop: () => current.entries.delete(key) };
      };
      try {
        const first = ask(summaryRequest(target, nodes, config.memoryMode));
        const result = await first.result;
        if (!result) return;
        if (!config.repairCoverage || (config.memoryMode ?? 'plain') !== 'plain') {
          try { parseMemory(result, nodes, config.memoryMode ?? 'plain', lang); } catch { first.drop(); }
          return;
        }
        let draft: ReturnType<typeof inspectMemory>;
        try { draft = inspectMemory(result, nodes, 'plain', lang); } catch { first.drop(); return; }
        if (!draft.missingSceneIds.length) return;
        const missing = new Set(draft.missingSceneIds);
        const subset = nodes.filter(node => missing.has(node.id));
        const repair = ask(supplementRequest(target, nodes, draft));
        const extra = await repair.result;
        if (!extra) return;
        try { parseMemory(extra, subset, 'plain', lang); } catch { repair.drop(); }
      } finally {
        turn?.end();
      }
    },
  };
}
