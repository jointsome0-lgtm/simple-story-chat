import { createHash } from 'node:crypto';
import type { Library } from '../lib/library.ts';
import { active, context } from '../lib/library.ts';
import { inspectMemory, parseMemory, summaryRequest, supplementRequest } from './memory.ts';
import type { GenerationResult, ModelRequest, Provider } from './model.ts';
import type { Log } from './model-error.ts';
import { seedLanguage } from './story-text.ts';

// A compaction computed ahead, while a person reads the last scene: the extraction the next turn would ask for depends
// only on the branch, not on the person's next action. Only the model calls run ahead; checking and saving the memory
// stay with the turn, which takes a result only for an identical request, so a changed branch simply misses. Results
// stay in memory and are never stored.
type Config = { keepScenes?: number; memoryMode?: 'plain' | 'sgr'; repairCoverage?: boolean };
// The branch state a run reads: a turn from any other point cannot use it.
type Point = { storyId: string; branchId: string; head: string | null; memory: string | null };
const POINT = ['storyId', 'branchId', 'head', 'memory'] as const;
// Each entry settles with a result that passed its check, or null: the turn then asks the model itself. `id` numbers the
// runs of this process in the log; `settle` writes the run's one outcome row.
type Run = { controller: AbortController; started: boolean; point: Point; entries: Map<string, Promise<GenerationResult | null>>;
  id: number; settle: (outcome: Outcome) => void };
// What became of a run. `used`: a turn took a result that passed its check, and `memory_compacted` then says whether it
// was saved. `asked_again`: a turn took it and it had failed or did not pass its check. `unstarted`: stopped before it reached the model. `discarded`: it reached the model and no turn
// took it, because the branch point changed or another run replaced it. A run with no row was still waiting at the end.
type Outcome = 'used' | 'asked_again' | 'unstarted' | 'discarded';
let runs = 0;
export type Prepared = ReturnType<typeof createPrepared>;

const keyOf = (request: ModelRequest) => createHash('sha256').update(JSON.stringify(request)).digest('hex');

// One run at a time, for one person's library.
export function createPrepared() {
  let run: Run | null = null;
  function stop() {
    run?.settle(run.started ? 'discarded' : 'unstarted');
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
    take(request: ModelRequest): Promise<GenerationResult | null> | undefined {
      const key = keyOf(request);
      const result = run?.entries.get(key);
      if (!run || !result || !run.started) {
        stop();
        return undefined;
      }
      run.entries.delete(key);
      const { settle } = run;
      void result.then(value => settle(value ? 'used' : 'asked_again'));
      return result;
    },
    // Runs the extraction of the active branch and, if its result misses scenes, the supplement for them, as
    // generation.ts extractAndSave would. The provider is the shared model: the run is one turn of it that yields to
    // anybody but `holder`, whose next turn waits for it. Each request writes its own row with its counts and timings.
    async run(state: Library, provider: Provider, config: Config, { holder, log = () => {} }: { holder?: string; log?: Log } = {}) {
      stop();
      const { story, branch, seed } = active(state);
      const nodes = context(story, branch).recent.slice(0, -(config.keepScenes ?? 4));
      if (!nodes.length) return;
      const turn = provider.openTurn?.({ holder, yields: true });
      // Without a shared model there is no turn to wait behind.
      const id = ++runs;
      let settled = false;
      const current: Run = { controller: new AbortController(), started: !turn, entries: new Map(), id,
        point: { storyId: story.id, branchId: branch.id, head: branch.head, memory: branch.memory },
        // The first outcome stands: a run whose extraction was used is not discarded by the turn that follows.
        settle: outcome => { if (!settled) log('compaction_prepare_outcome', outcome, { prepareRun: id }); settled = true; } };
      run = current;
      const target = { seed, story, branch };
      const lang = seedLanguage(seed);
      const mode = config.memoryMode ?? 'plain';
      const repairs = !!config.repairCoverage && mode === 'plain';
      // A result that would fail its check settles as null, so the turn asks the model again rather than fail.
      const ask = (request: ModelRequest, check: (result: GenerationResult) => void) => {
        const asked = Date.now();
        let waitMs: number | undefined;
        const checked = (turn ?? provider).generate(request, { signal: current.controller.signal,
          onStart: () => { current.started = true; waitMs = Date.now() - asked; } })
          .then(result => {
            log('compaction_prepare_request_completed', undefined, { ...result.timings, prepareRun: id, waitMs, elapsedMs: Date.now() - asked,
              inputTokens: result.usage?.inputTokens ?? undefined, outputTokens: result.usage?.outputTokens ?? undefined });
            try { check(result); return result; } catch { return null; }
          }, () => null);
        current.entries.set(keyOf(request), checked);
        return checked;
      };
      try {
        const result = await ask(summaryRequest(target, nodes, mode), result => {
          if (repairs) inspectMemory(result, nodes, 'plain', lang); else parseMemory(result, nodes, mode, lang);
        });
        if (!result || !repairs) return;
        const draft = inspectMemory(result, nodes, 'plain', lang);
        if (!draft.missingSceneIds.length) return;
        const missing = new Set(draft.missingSceneIds);
        const subset = nodes.filter(node => missing.has(node.id));
        await ask(supplementRequest(target, nodes, draft), extra => { parseMemory(extra, subset, 'plain', lang); });
      } finally {
        turn?.end();
      }
    },
  };
}
