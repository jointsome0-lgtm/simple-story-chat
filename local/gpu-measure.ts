// Explicitly invoked live measurement of one llama-server profile, for the rented GPU session. No Telegram, no story
// database, no private seeds: the prompts are synthetic and the report holds counters, never text.
// One run measures one server profile and writes `report.json`; `--decide` reads several reports and applies the
// thresholds the owner agreed on (docs/llama-measurement.md#measurement-session).
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadModelConfig } from './config.ts';
import { createLlama } from './llama.ts';
import { createScheduler } from './scheduler.ts';
import { watch } from './gpu-diagnose.ts';
import type { Remote } from './gpu-diagnose.ts';
import { errorCode, ModelError } from './model-error.ts';
import type { ModelRequest, Provider, Timings } from './model.ts';
import { makeRequest } from './prompt.ts';
import { summaryRequest, parseMemory } from './memory.ts';
import { seedLanguage, seedNarration } from './story-text.ts';
import { active, addSeed, beginJob, commitMemory, commitTurn, context, emptyLibrary, history, newStory, validTime } from '../lib/library.ts';
import type { Library } from '../lib/library.ts';

// The take/drop thresholds for the session, agreed by the owner on 2026-09-20. `--decide` reports every number it
// measured beside them, so a borderline result stays the owner's call rather than the script's.
export const THRESHOLDS = {
  // 1. Free video memory at the peak. Less than this risks a failure on a long history.
  freeVramMiB: 1024,
  // 2. The tester's cache survives the work beside it, up to a template boundary. Raised from 32 by the owner on
  // 2026-09-20, after the first live run: on the rented 5090 the tester re-read 1 to 219 tokens of a 39,700-token
  // history, which is the boundary moving under load, not a cache being lost. What this guards against is the
  // failure measured on the RX 580, where the whole history came back; 256 is still two orders below that.
  cacheToleranceTokens: 256,
  // 3. Parallel lanes are worth it only at this much more useful work per hour.
  throughputGain: 1.2,
  // 4. How long the tester's warm scene may take with work beside it. Agreed by the owner on 2026-09-20 in place of a
  // ratio (it was "no more than 1.5x slower"): a person feels seconds, not ratios, and a ratio tightens by itself
  // every time the card gets faster. On the rented 5090 a scene took 3.6 s alone and 6.6 s beside a full load.
  sceneSecondsUnderLoad: 10,
  // 5. How long the tester may wait for the queue.
  waitSeconds: 120,
  // 6. The draft model (MTP) is worth it at this speed-up, and only without a format regression.
  draftSpeedup: 1.2,
} as const;

export type Call = {
  label: string; waitMs: number | null; elapsedMs: number | null; finishReason: string;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
  tokensPerSecond: number | null; formatFailed: boolean; timings?: Timings;
  // Optional only so that old reports remain readable. New measurements always write these, with null for missing observations.
  countMs?: number | null; countQueueMs?: number | null; queueMs?: number | null;
  firstTextFromStartMs?: number | null; firstTextFromRequestMs?: number | null; totalRequestMs?: number | null;
  countedInputTokens?: number | null; decodeTokensPerSecond?: number | null; unattributedMs?: number | null;
  outputCharacters?: number; representative?: boolean; useful?: boolean;
  caseId?: string; cycle?: number; cacheIntent?: 'cold' | 'warm' | 'next' | 'prime';
  cacheObserved?: 'cold' | 'warm' | 'mixed' | 'unknown';
  expectedCacheTokens?: number; expectedPromptTokens?: number; cacheMatched?: boolean | null;
};
export type Phase = {
  seconds: number; tester: Call[]; primers?: Call[]; agent: Call[];
  probes: { completed: number; preempted: number; outputTokens?: number | null };
  // A memory increment counts only after a valid scene uses it. Probes and discarded work never count.
  usefulOutputTokens: number | null; usefulTokensPerHour: number | null; complete?: boolean;
};
export type WorkCase = { id: string; fixture: string; fixtureSha256: string; requestSha256: string;
  targetTokens: number; inputTokens: number; sceneCount: number; outputCharacters: { min: number; max: number };
  previousInputTokens?: number; prefixTokens?: number; previousRequestSha256?: string };
export type Workload = { version: 3; fingerprint: string; cases: WorkCase[]; coldRuns: number; warmRuns: number; nextTurns: boolean;
  compactAtTokens: number; keepScenes: number; memoryMode: 'plain' | 'sgr' };
// Memory of one card, by the driver's own index. A box with two cards runs llama-server on one of them and, this
// session, an image model on the other: one number per card, never one across all of them. `server` records that
// llama-server was seen computing on this card, which is how the verdicts find the cards they are about.
export type Card = { index: number; totalMiB: number | null; usedMiBMax: number | null; freeMiBMin: number | null; server: boolean };
// `card` is the index the memory verdicts are about: the card llama-server was seen on, the tightest of them when it
// was seen on several, and the operator's `--card` only while the driver attributes nothing. It stays null while no
// card has been established, and the memory verdicts then have nothing to be about.
export type Vram = { samples: number; card: number | null; cards: Card[] };
// The shape written before memory was recorded per card: one set of numbers for the whole machine. `--decide` still
// reads those reports, so the fields survive as optional ones rather than as a second type to branch on.
type StoredVram = Vram & Partial<Omit<Card, 'index' | 'server'>>;
export type Report = {
  profile: string; startedAt: string; completedAt?: string; model: string; temperature: number;
  server: { slots: number | null; contextTokens: number | null }; draft: boolean;
  bot: { slots: number; poolTokens: number; sharedCache: boolean; contextTokens: number; maxOutputTokens: number;
    quietMs: number; readSeconds: number; historyTokens: number | null };
  phases: { solo?: Phase; loaded?: Phase }; vram: Vram; error?: string; workload?: Workload;
  plan?: ReturnType<typeof measurementPlan>; smoke?: ReturnType<typeof smokeOutcome>;
};
// `unknown` when a run did not produce the number: a missing VRAM reading or a profile the comparison needs a pair for.
export type Check = { id: number; name: string; verdict: 'pass' | 'fail' | 'unknown'; measured: string; threshold: string };

const report = (value: object) => console.log(JSON.stringify(value));
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};

const number = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

// The card llama-server ran on: the only one the memory verdicts are about. A run that never established which card
// that is answers nothing, rather than answering about whichever card happened to be read. Reports from before the
// per-card change carry one reading for the machine and are read as that one card, unnumbered.
export function serverCard(run: Report): { index: number | null; freeMiBMin: number | null } | null {
  const vram = run.vram as StoredVram | undefined;
  if (!vram) return null;
  if (!Array.isArray(vram.cards)) return vram.freeMiBMin === undefined ? null : { index: null, freeMiBMin: vram.freeMiBMin };
  return vram.card === null || vram.card === undefined ? null : vram.cards.find(card => card.index === vram.card) ?? null;
}
// How the measurement reads in a check: `on card N` only once a card was established.
const freeMemory = (run: Report) => {
  const card = serverCard(run);
  return { free: card?.freeMiBMin ?? null, where: card && card.index !== null ? ` on card ${card.index}` : '' };
};
const validScene = (text: string) => validTime(text.split('\n')[0].trim())
  && !/<\/?think>|<\|(?:channel|im_start|im_end)|\[start_header_id\]/i.test(text);

// Clock and provider are the whole timing seam. The same request object crosses countInput and generate so the
// adapter can reuse its prepared body. countMs includes that operation's queue; queueMs adds both queue waits.
export async function measureCall(provider: Provider, request: ModelRequest, { label, signal, now = () => performance.now(),
  inputLimitTokens, range }: { label: string; signal?: AbortSignal; now?: () => number;
    inputLimitTokens?: number; range?: WorkCase['outputCharacters'] }) {
  const requested = now();
  let countStarted: number | null = null, started: number | null = null, first: number | null = null;
  let counted: number | null = null, countMs: number | null = null;
  if (provider.countInput) {
    counted = await provider.countInput(request, { signal, onStart: () => { countStarted ??= now(); } });
    countMs = now() - requested;
    if (inputLimitTokens !== undefined && counted > inputLimitTokens) throw new ModelError('context_limit');
  }
  const queued = now();
  const result = await provider.generate(request, { signal, inputLimitTokens,
    onStart: () => { started ??= now(); }, onText: delta => { if (delta.length && first === null) first = now(); } });
  const finished = now();
  const span = (end: number | null, start: number | null) => end === null || start === null ? null : round(end - start);
  const elapsedMs = span(finished, started);
  const countQueueMs = provider.countInput ? span(countStarted, requested) : 0;
  const generateQueueMs = span(started, queued);
  const queueMs = countQueueMs === null || generateQueueMs === null ? null : round(countQueueMs + generateQueueMs);
  const timing = result.timings;
  const formatFailed = result.finishReason !== 'stop' || !validScene(result.text);
  const call: Call = { label, waitMs: queueMs, elapsedMs, countMs, countQueueMs, queueMs,
    firstTextFromStartMs: span(first, started), firstTextFromRequestMs: span(first, requested),
    totalRequestMs: span(finished, requested), countedInputTokens: counted, finishReason: result.finishReason,
    inputTokens: result.usage?.inputTokens ?? null, cachedInputTokens: result.usage?.cachedInputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null, outputCharacters: result.text.length,
    tokensPerSecond: number(result.usage?.outputTokens) && number(elapsedMs) && elapsedMs > 0
      ? round(result.usage!.outputTokens! * 1000 / elapsedMs) : null,
    decodeTokensPerSecond: number(timing?.predictedTokens) && number(timing?.predictedMs) && timing.predictedMs > 0
      ? round(timing.predictedTokens * 1000 / timing.predictedMs) : null,
    // This signed residual also includes server work outside these timers. It is not a network measurement.
    unattributedMs: number(elapsedMs) && number(timing?.promptMs) && number(timing?.predictedMs)
      ? round(elapsedMs - timing.promptMs - timing.predictedMs) : null,
    // A longer complete response costs more work; it cannot flatter the latency result. Only short scenes are excluded.
    formatFailed, representative: range ? result.text.length >= range.min : false, useful: false,
    cacheObserved: cacheState(timing, counted), ...(timing ? { timings: timing } : {}) };
  return { call, result };
}

export function cacheState(timing: Timings | undefined, input: number | null): NonNullable<Call['cacheObserved']> {
  if (!number(input) || !number(timing?.cacheTokens) || !number(timing?.promptTokens)) return 'unknown';
  const tolerance = THRESHOLDS.cacheToleranceTokens;
  if (timing.cacheTokens === 0 && timing.promptTokens >= input - tolerance) return 'cold';
  if (timing.cacheTokens >= input - tolerance && timing.promptTokens <= tolerance) return 'warm';
  return 'mixed';
}

export function expectCache(call: Call, intent: NonNullable<Call['cacheIntent']>, prefixTokens: number) {
  call.cacheIntent = intent;
  call.expectedCacheTokens = prefixTokens;
  const input = call.countedInputTokens;
  call.expectedPromptTokens = number(input) ? Math.max(0, input - prefixTokens) : undefined;
  call.cacheMatched = number(call.timings?.cacheTokens) && number(call.timings?.promptTokens) && number(call.expectedPromptTokens)
    ? Math.abs(call.timings.cacheTokens - prefixTokens) <= THRESHOLDS.cacheToleranceTokens
      && Math.abs(call.timings.promptTokens - call.expectedPromptTokens) <= THRESHOLDS.cacheToleranceTokens : null;
}

// A planning allowance, not a prediction or an added performance threshold. Ten seconds per call reuses the existing
// warm-generation budget; 30% is left outside this estimate for setup, longer cold prefill and queue variation.
export function measurementPlan({ cases, coldRuns, warmRuns, readSeconds, minutes, smoke = false }:
  { cases: number; coldRuns: number; warmRuns: number; readSeconds: number; minutes: number; smoke?: boolean }) {
  const cycles = cases * coldRuns * (smoke ? 1 : 2);
  const calls = cycles * (1 + warmRuns + (smoke ? 0 : 2));
  const readingSeconds = cycles * (warmRuns + (smoke ? 0 : 1)) * readSeconds;
  const callReserveSeconds = calls * THRESHOLDS.sceneSecondsUnderLoad;
  const plannedSeconds = readingSeconds + callReserveSeconds;
  const budgetSeconds = minutes * 60, maximumPlannedSeconds = Math.floor(budgetSeconds * 0.7);
  return { calls, readingSeconds, callReserveSeconds, plannedSeconds, budgetSeconds, maximumPlannedSeconds,
    fits: plannedSeconds <= maximumPlannedSeconds };
}

// What the scheduler is told about the server, always from the configuration the bot itself runs under. The three
// belong together: with isolated slots (`--kv-unified` off, where `poolTokens` is one whole context) a scheduler
// left to its default would admit calls by size and put more work on a slot than the slot can hold, and the profile
// would measure an admission no bot of this configuration uses.
export const serverShape = (config: { slots: number; poolTokens: number; sharedCache: boolean }) =>
  ({ slots: config.slots, poolTokens: config.poolTokens, sharedCache: config.sharedCache });

export function smokeOutcome(calls: Call[]) {
  const cold = calls.find(call => call.cacheIntent === 'cold')?.cacheObserved ?? 'unknown';
  const warm = calls.find(call => call.cacheIntent === 'warm')?.cacheObserved ?? 'unknown';
  return { passed: calls.length === 2 && cold === 'cold' && warm === 'warm', cold, warm };
}

// A second adapter uses this transport for cold calls only. Counting and health requests retain their original bodies.
export const withoutPromptCache = (fetcher: (url: string, init: RequestInit) => Promise<Response>) =>
  (url: string, init: RequestInit) => fetcher(url, new URL(url).pathname.endsWith('/chat/completions')
    && typeof init.body === 'string' ? { ...init, body: JSON.stringify({ ...JSON.parse(init.body), cache_prompt: false }) } : init);

// Repeat whole frozen scenes to control input size. This is a performance replay, not a world-consistency eval.
// The server counts real makeRequest output; no character/token estimate or filler is used.
export async function buildWorkload(frozen: Library, targetTokens: number, maxOutputTokens: number,
  count: (request: ModelRequest) => Promise<number>) {
  const source = active(frozen);
  const scenes = history(source.story, source.branch.head);
  if (!scenes.length) throw new Error('empty_frozen_fixture');
  const build = (size: number) => {
    const state = emptyLibrary();
    const seed = addSeed(state, `${source.seed.title}\n${source.seed.startTime}\n${source.seed.text}`);
    newStory(state, seed.id);
    for (let i = 0; i < size; i++) {
      const scene = scenes[i % scenes.length];
      const job = beginJob(state, scene.input, i);
      commitTurn(state, job.id, scene.text);
    }
    const job = beginJob(state, seedNarration(seed).continueStory, size);
    return { state, request: makeRequest(state, job, maxOutputTokens), sceneCount: size };
  };
  const sized = async (n: number) => { const value = build(n); return { ...value, inputTokens: await count(value.request) }; };
  let best = await sized(0), upper = 1;
  if (best.inputTokens > targetTokens) throw new Error('fixture_seed_exceeds_target');
  while (upper <= 512) {
    const candidate = await sized(upper);
    if (candidate.inputTokens > targetTokens) break;
    best = candidate; upper *= 2;
  }
  if (upper > 512) throw new Error('fixture_target_too_large');
  let lower = best.sceneCount;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2), candidate = await sized(middle);
    if (candidate.inputTokens <= targetTokens) { lower = middle; best = candidate; } else upper = middle;
  }
  if (!best.sceneCount) throw new Error('fixture_scene_exceeds_target');
  const target = active(best.state), last = target.story.nodes[target.branch.head!];
  // The previous turn ends at k-1 and asks for the action stored on scene k. Its last user message contains the
  // narrator rule; the next request stores the raw action and frozen scene, as the bot does. Count their common
  // complete-message prefix with an empty user suffix so the server receives a valid chat template. The existing
  // tolerance covers this small suffix/template boundary, not the added scene.
  const previousRequest = makeRequest(best.state, { ...best.state.job!, head: last.parent, input: last.input }, maxOutputTokens);
  let common = 0;
  while (common < previousRequest.messages.length && JSON.stringify(previousRequest.messages[common]) === JSON.stringify(best.request.messages[common])) common++;
  const prefixTokens = await count({ ...best.request, messages: [...best.request.messages.slice(0, common), { role: 'user', content: '' }] });
  const previousInputTokens = await count(previousRequest);
  const lengths = scenes.map(scene => scene.text.length);
  return { ...best, previousRequest, previousInputTokens, prefixTokens,
    outputCharacters: { min: Math.min(...lengths), max: Math.max(...lengths) } };
}

// Reports expose small samples honestly: count, median and maximum, grouped by history and requested cache state.
export function summaries(calls: Call[]) {
  const groups = new Map<string, Call[]>();
  for (const call of calls) {
    const key = `${call.caseId ?? call.label}:${call.cacheIntent ?? 'other'}`;
    groups.set(key, [...groups.get(key) ?? [], call]);
  }
  const metrics = ['countMs', 'queueMs', 'elapsedMs', 'firstTextFromStartMs', 'firstTextFromRequestMs', 'totalRequestMs',
    'decodeTokensPerSecond', 'unattributedMs', 'inputTokens', 'outputTokens', 'outputCharacters'] as const;
  return [...groups].map(([group, entries]) => ({ group, n: entries.length,
    metrics: Object.fromEntries(metrics.map(metric => {
      const values = entries.map(call => call[metric]).filter(number);
      return [metric, { n: values.length, median: median(values), max: values.length ? Math.max(...values) : null }];
    })) }));
}

// ---- Verdicts -------------------------------------------------------------------------------------------------
function sampleProblem(run: Report, phase: Phase | undefined, checkFormat = true): string | null {
  const plan = run.workload;
  if (plan?.version !== 3) return 'legacy workload; the current request series was not measured';
  if (!phase?.complete) return 'incomplete phase';
  if (phase.tester.length !== plan.cases.length * plan.coldRuns * (1 + plan.warmRuns + (plan.nextTurns ? 1 : 0))) return 'incomplete series';
  for (const cell of plan.cases) for (let cycle = 0; cycle < plan.coldRuns; cycle++) {
    const calls = phase.tester.filter(call => call.caseId === cell.id && call.cycle === cycle);
    if (calls.filter(call => call.cacheIntent === 'cold').length !== 1
      || calls.filter(call => call.cacheIntent === 'warm').length !== plan.warmRuns
      || (plan.nextTurns && calls.filter(call => call.cacheIntent === 'next').length !== 1)) return 'incomplete series';
    if (plan.nextTurns) {
      const primers = phase.primers?.filter(call => call.caseId === cell.id && call.cycle === cycle) ?? [];
      if (primers.length !== 1 || primers[0].cacheObserved !== 'cold'
        || primers[0].countedInputTokens !== cell.previousInputTokens) return 'previous-turn primer was not confirmed';
    }
    for (const call of calls) {
      if (call.countedInputTokens !== cell.inputTokens) return 'input size changed';
      if (call.cacheObserved === 'unknown' || !call.cacheObserved) return 'cache timings unavailable';
      if (call.cacheIntent === 'cold' && call.cacheObserved !== 'cold') return 'cold prefill was not confirmed';
      if (call.cacheIntent === 'next' && (!number(cell.prefixTokens) || call.expectedCacheTokens !== cell.prefixTokens
        || !number(call.expectedPromptTokens))) return 'next-turn prefix was not counted';
      if (call.cacheIntent === 'next' && number(call.timings?.promptTokens) && number(call.expectedPromptTokens)
        && call.timings.promptTokens < call.expectedPromptTokens - THRESHOLDS.cacheToleranceTokens) return 'next-turn prefill was not observed';
      if (!call.representative) return 'scene shorter than the frozen fixture minimum';
      if (checkFormat && call.formatFailed) return 'scene format failed';
    }
  }
  return null;
}

const sameWork = (a: Report, b: Report) => !!a.workload?.fingerprint && a.workload.version === 3
  && b.workload?.version === 3 && a.workload.fingerprint === b.workload.fingerprint
  && a.model === b.model && a.temperature === b.temperature && a.bot.contextTokens === b.bot.contextTokens
  && a.bot.maxOutputTokens === b.bot.maxOutputTokens && a.bot.readSeconds === b.bot.readSeconds;

// Checks 1 to 5 are answered by one profile's own two phases; 6 and 7 need a pair of profiles and live in `decide`.
export function verdictOf(run: Report): Check[] {
  const { solo, loaded } = run.phases;
  const checks: Check[] = [];
  const add = (id: number, name: string, measured: string, threshold: string, verdict: Check['verdict']) =>
    checks.push({ id, name, verdict, measured, threshold });
  const { free, where } = freeMemory(run);
  add(1, 'video memory at the peak', free === null ? 'not read' : `${free} MiB free${where}`,
    `>= ${THRESHOLDS.freeVramMiB} MiB`, free === null ? 'unknown' : free >= THRESHOLDS.freeVramMiB ? 'pass' : 'fail');

  const problem = sampleProblem(run, solo) ?? sampleProblem(run, loaded);
  // A loaded phase in which nothing actually ran beside the tester answers none of these: a configuration too tight
  // to admit an agent at all would otherwise pass them all by doing no work.
  const contested = !problem && !!loaded && (loaded.agent.length > 0 || loaded.probes.completed > 0);
  const missing = problem ?? (contested ? 'not measured' : 'nothing ran beside the tester');
  // Fixed-prefix replay: each warm request must retain the input prepared by its own preceding cold/warm call.
  const margins = (loaded?.tester ?? []).filter(call => call.cacheIntent === 'warm' || call.cacheIntent === 'next').map(call => {
    const expected = call.cacheIntent === 'next' ? call.expectedCacheTokens : call.countedInputTokens;
    const prefill = call.cacheIntent === 'next' ? call.expectedPromptTokens : 0;
    return number(call.timings?.cacheTokens) && number(call.timings?.promptTokens) && number(expected) && number(prefill)
      ? Math.min(call.timings.cacheTokens - (expected - THRESHOLDS.cacheToleranceTokens),
        prefill + THRESHOLDS.cacheToleranceTokens - call.timings.promptTokens) : null;
  }).filter(number);
  const worst = contested && margins.length ? Math.min(...margins) : null;
  add(2, 'the tester keeps its cache', worst === null ? missing : `${worst} tokens of margin`,
    `>= 0 (tolerance ${THRESHOLDS.cacheToleranceTokens})`, worst === null ? 'unknown' : worst >= 0 ? 'pass' : 'fail');

  const gain = contested && number(solo?.usefulTokensPerHour) && number(loaded?.usefulTokensPerHour)
    && solo.usefulTokensPerHour > 0 ? loaded.usefulTokensPerHour / solo.usefulTokensPerHour : null;
  add(3, 'useful work per hour beside the tester', gain === null ? missing : `${round(gain)}x`,
    `>= ${THRESHOLDS.throughputGain}x`, gain === null ? 'unknown' : gain >= THRESHOLDS.throughputGain ? 'pass' : 'fail');

  // The existing budget was measured after warmup. Cold startup and next-turn added prefill are reported separately.
  // Keep the warm history sizes separate too: fast small prompts must not hide slow long ones in a pooled median.
  const warm = loaded?.tester.filter(call => call.cacheIntent === 'warm') ?? [];
  const durations = summaries(warm).map(group => group.metrics.elapsedMs.median).filter(number);
  const sceneSeconds = contested && durations.length && warm.every(call => number(call.elapsedMs))
    ? Math.max(...durations) / 1000 : null;
  add(4, 'the tester\'s scene beside other work',
    sceneSeconds === null ? missing : `${round(sceneSeconds, 1)} s`,
    `each warm replay median <= ${THRESHOLDS.sceneSecondsUnderLoad} s after generation starts`,
    sceneSeconds === null ? 'unknown' : sceneSeconds <= THRESHOLDS.sceneSecondsUnderLoad ? 'pass' : 'fail');

  const waits = loaded?.tester.map(call => call.queueMs).filter(number) ?? [];
  const longest = !problem && waits.length && waits.length === loaded?.tester.length ? Math.max(...waits) : null;
  add(5, 'the tester\'s longest wait for the queue', longest === null ? missing : `${round(longest / 1000, 1)} s`,
    `<= ${THRESHOLDS.waitSeconds} s`, longest === null ? 'unknown' : longest / 1000 <= THRESHOLDS.waitSeconds ? 'pass' : 'fail');
  return checks;
}

// The draft model changes how fast the card writes tokens, so it is judged on the server's own clock. `elapsedMs`
// carries the SSH proxy with it, and that proxy was measured at 1.4 ms one hour and 1.4 s the next: a wall-clock
// speed would compare the tunnel's mood, not the two models.
const testerSpeed = (run: Report) => {
  const speeds = (run.phases.solo?.tester ?? []).map(call => call.decodeTokensPerSecond).filter(number);
  return median(speeds);
};
const formatFailures = (run: Report) => [...run.phases.solo?.tester ?? [], ...run.phases.loaded?.tester ?? [],
  ...run.phases.loaded?.agent ?? []].filter(call => call.formatFailed).length;

export type Decision = { profiles: { profile: string; slots: number; draft: boolean; checks: Check[];
  usefulTokensPerHour: number | null; testerTokensPerSecond: number | null; formatFailures: number }[];
  pool: { take: string | null; over: string | null; note: string };
  draft: Check; together: Check };

// The whole session's answer: which slot count to run, whether the draft model earns its memory, and what to drop
// when both do not fit. A profile is a candidate only if its own five checks passed.
export function decide(runs: Report[]): Decision {
  const profiles = runs.map(run => ({ profile: run.profile, slots: run.bot.slots, draft: run.draft,
    checks: verdictOf(run), usefulTokensPerHour: run.phases.loaded?.usefulTokensPerHour ?? null,
    testerTokensPerSecond: testerSpeed(run), formatFailures: formatFailures(run) }));
  const sound = (entry: Decision['profiles'][number]) => entry.checks.every(check => check.verdict === 'pass');
  const candidates = runs.filter((_, index) => sound(profiles[index]));
  const compatible = candidates.every(run => sameWork(candidates[0], run));
  const pooled = profiles.filter(entry => compatible && entry.slots > 1 && sound(entry));
  const best = pooled.sort((a, b) => (b.usefulTokensPerHour ?? 0) - (a.usefulTokensPerHour ?? 0))[0];
  const single = profiles.find(entry => entry.slots === 1 && (!best
    || sameWork(runs.find(run => run.profile === best.profile)!, runs.find(run => run.profile === entry.profile)!)));

  // The draft model: the same slot count with and without it, on the tester's own scenes.
  const withDraft = runs.filter(run => run.draft);
  // A draft run whose server never started has no scenes to time, and it must not stand in for one that does: the
  // pool with the draft model sorts before the single slot, and taking it left this check unanswered while the
  // measurement that answered it sat in the same directory. What that run knows is threshold 7's business, below.
  const pair = withDraft.map(run => ({ run, plain: runs.find(other => !other.draft && sameWork(run, other)
    && other.bot.slots === run.bot.slots && other.bot.poolTokens === run.bot.poolTokens
    && other.bot.sharedCache === run.bot.sharedCache && other.server.contextTokens === run.server.contextTokens) }))
    .find(entry => entry.plain && !sampleProblem(entry.run, entry.run.phases.solo, false)
      && !sampleProblem(entry.plain, entry.plain.phases.solo));
  const speeds = (run: Report) => summaries(run.phases.solo?.tester ?? [])
    .map(group => ({ group: group.group, expected: group.n, ...group.metrics.decodeTokensPerSecond }));
  const ratios = pair?.plain ? speeds(pair.run).map(group => {
    const plain = speeds(pair.plain!).find(other => other.group === group.group);
    return number(group.median) && number(plain?.median) && plain.median > 0
      && group.n === group.expected && plain.n === plain.expected && group.n === plain.n
      ? group.median / plain.median : null;
  }) : [];
  const speedup = ratios.length && ratios.every(number) ? Math.min(...ratios) : null;
  const broke = pair ? formatFailures(pair.run) > 0 : false;
  const draft: Check = { id: 6, name: 'the draft model (MTP)',
    verdict: broke ? 'fail' : speedup === null ? 'unknown' : speedup >= THRESHOLDS.draftSpeedup ? 'pass' : 'fail',
    measured: speedup === null ? (broke ? 'format regressed' : 'no pair of profiles to compare') : `${round(speedup)}x${broke ? ', format regressed' : ''}`,
    threshold: `>= ${THRESHOLDS.draftSpeedup}x and no format regression` };

  // Both at once: a profile that is pooled and has the draft model must still leave the memory headroom.
  const both = runs.find(run => run.draft && run.bot.slots > 1);
  const { free: bothFree, where: bothWhere } = both ? freeMemory(both) : { free: null, where: '' };
  // Failure to reach the server is not evidence of exhausted memory. A partial run may establish a shortage,
  // but it cannot establish sufficient headroom at a peak it never reached.
  const bothFailed = both?.error ?? null;
  const together: Check = { id: 7, name: 'the pool and the draft model together',
    verdict: bothFree !== null && bothFree < THRESHOLDS.freeVramMiB ? 'fail'
      : bothFailed || !both || sampleProblem(both, both.phases.loaded) || bothFree === null ? 'unknown' : 'pass',
    measured: bothFailed ? `measurement incomplete (${bothFailed})` : bothFree === null ? 'not measured' : `${bothFree} MiB free${bothWhere}`,
    threshold: `>= ${THRESHOLDS.freeVramMiB} MiB, else the pool is kept and the draft model dropped` };

  return { profiles, draft, together,
    pool: { take: best?.profile ?? null, over: single?.profile ?? null,
      note: !compatible ? 'incompatible workloads; compare reports from the same measurement plan'
        : best ? (together.verdict === 'fail' ? 'take the pool without the draft model' : 'take the pool')
        : 'no pooled profile passed its own checks; keep one slot' } };
}

// One agent turn uses a validated memory increment in its next scene. A failed or interrupted turn earns no
// useful memory tokens. The state is a private clone of a frozen performance fixture, never a person's library.
export async function measureAgentTurn(provider: Provider, original: Library,
  options: { keepScenes: number; memoryMode: 'plain' | 'sgr'; maxOutputTokens: number; contextTokens: number;
    range: WorkCase['outputCharacters']; signal?: AbortSignal }, record: (call: Call) => void) {
  const state = structuredClone(original), target = active(state);
  const nodes = context(target.story, target.branch).recent.slice(0, -options.keepScenes);
  if (!nodes.length) throw new ModelError('nothing_to_compact');
  const job = state.job ?? beginJob(state, seedNarration(target.seed).continueStory, 0);
  const extraction = summaryRequest(target, nodes, options.memoryMode);
  const memory = await measureCall(provider, extraction, { label: 'agent_compaction', signal: options.signal,
    inputLimitTokens: options.contextTokens - extraction.maxOutputTokens });
  record(memory.call);
  const delta = parseMemory(memory.result, nodes, options.memoryMode, seedLanguage(target.seed));
  memory.call.formatFailed = false;
  const before = JSON.stringify(makeRequest(state, job, options.maxOutputTokens)).length;
  if (!commitMemory(state, job.id, nodes.map(node => node.id), delta)) throw new ModelError('cancelled');
  const request = makeRequest(state, job, options.maxOutputTokens);
  if (JSON.stringify(request).length >= before) throw new ModelError('memory_not_smaller');
  const scene = await measureCall(provider, request, { label: 'agent_scene', signal: options.signal,
    inputLimitTokens: options.contextTokens - options.maxOutputTokens, range: options.range });
  record(scene.call);
  if (!scene.call.formatFailed && scene.call.representative) memory.call.useful = scene.call.useful = true;
}

export function closePhase(phase: Phase, seconds: number) {
  phase.seconds = round(seconds, 1);
  const useful = [...phase.tester, ...phase.agent].filter(call => call.useful);
  phase.usefulOutputTokens = useful.every(call => number(call.outputTokens))
    ? useful.reduce((sum, call) => sum + call.outputTokens!, 0) : null;
  phase.usefulTokensPerHour = seconds > 0 && phase.usefulOutputTokens !== null
    ? Math.round(phase.usefulOutputTokens * 3600 / seconds) : null;
}

// ---- The live run ---------------------------------------------------------------------------------------------
async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    profile: { type: 'string' }, out: { type: 'string' }, decide: { type: 'string' },
    scenes: { type: 'string', default: '1' }, 'cold-runs': { type: 'string', default: '2' },
    fixture: { type: 'string', default: 'battle' }, 'read-seconds': { type: 'string', default: '15' },
    'history-tokens': { type: 'string' }, minutes: { type: 'string', default: '30' },
    draft: { type: 'boolean', default: false }, 'no-vram': { type: 'boolean', default: false }, smoke: { type: 'boolean', default: false },
    // Which card the memory verdicts are about, and how often it is read. The cards llama-server is seen computing
    // on decide; `--card` answers for a driver that attributes no process, and is reported when the driver's own
    // attribution contradicts it. The sampler is fast by default: a recorded out-of-memory arrived twelve seconds
    // after a start (docs/knowledge/gpu-measurements.md#pool-2026-09-20), which a slow one misses entirely.
    card: { type: 'string' }, 'vram-seconds': { type: 'string', default: '2' },
  } });
  if (values.decide) return void printDecision(resolve(values.decide));
  const profile = values.profile ?? (values.smoke ? 'smoke' : undefined);
  const warmRuns = values.smoke ? 1 : Number(values.scenes), coldRuns = values.smoke ? 1 : Number(values['cold-runs']);
  const readSeconds = values.smoke ? 0 : Number(values['read-seconds']), minutes = values.smoke ? 2 : Number(values.minutes);
  const asked = values['history-tokens'] === undefined ? null : Number(values['history-tokens']);
  const card = values.card === undefined ? null : Number(values.card);
  const vramSeconds = Number(values['vram-seconds']);
  const bounded = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!profile || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(profile)
    || !bounded(warmRuns, 1, 12) || !bounded(coldRuns, 1, 12) || !bounded(readSeconds, 0, 600)
    || !bounded(minutes, 2, 60) || (asked !== null && !bounded(asked, 512, 131072))
    || (card !== null && !bounded(card, 0, 15)) || !bounded(vramSeconds, 1, 120)
    || !['battle', 'chess', 'dance', 'all'].includes(values.fixture)) {
    throw new Error('Use --smoke, or --profile <name> [--fixture battle|chess|dance|all] [--cold-runs 1..12] [--scenes 1..12] [--read-seconds 0..600] [--history-tokens N] [--minutes 2..60] [--draft] [--card 0..15] [--vram-seconds 1..120] [--no-vram], or --decide <directory>');
  }
  if (values.smoke && (values.fixture === 'all' || (asked !== null && asked > 4000))) throw new Error('smoke_requires_one_small_case');
  const targets = asked !== null ? [asked] : values.smoke ? [4000] : [4000, 24000, 43000];
  const names = values.fixture === 'all' ? ['battle', 'chess', 'dance'] : [values.fixture];
  const plan = measurementPlan({ cases: names.length * targets.length, coldRuns, warmRuns, readSeconds, minutes, smoke: values.smoke });
  report({ event: 'measurement_plan', ...plan });
  if (!plan.fits) throw new Error('measurement_plan_exceeds_budget: reduce --read-seconds, --cold-runs, --scenes or cases, or increase --minutes');
  const config = loadModelConfig();
  if (config.provider !== 'llama-cpp') throw new Error('gpu_config_required');
  // This fixed-prefix experiment stays below automatic compaction. A lower configured threshold needs an explicit
  // smaller target; silently clipping it would make the profile incomparable with the other reports.
  if (targets.some(target => target >= config.compactAtTokens || target > config.contextTokens - config.maxOutputTokens)) {
    throw new Error('measurement_target_reaches_compaction_threshold');
  }
  const warm = createLlama(config, { slots: config.slots });
  const cold = createLlama(config, { slots: config.slots, fetch: withoutPromptCache(globalThis.fetch) });
  const coldRequests = new WeakSet<ModelRequest>();
  const adapter = (request: ModelRequest) => coldRequests.has(request) ? cold : warm;
  const provider: Provider = { check: controls => warm.check(controls),
    countInput: (request, controls) => adapter(request).countInput(request, controls),
    generate: (request, controls) => adapter(request).generate(request, controls) };
  const directory = resolve(values.out ?? `measurements/${profile}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run: Report = { profile, plan, startedAt: new Date().toISOString(), model: config.model,
    temperature: config.temperature, draft: values.draft, server: { slots: null, contextTokens: null },
    bot: { slots: config.slots, poolTokens: config.poolTokens, sharedCache: config.sharedCache,
      contextTokens: config.contextTokens, maxOutputTokens: config.maxOutputTokens,
      quietMs: 60000, readSeconds, historyTokens: asked },
    phases: {}, vram: { samples: 0, card, cards: [] } };
  const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(run, null, 2));
  const budget = new AbortController();
  const budgetTimer = setTimeout(() => budget.abort(new ModelError('budget_exceeded')), minutes * 60000);
  const signal = budget.signal;
  const scheduler = createScheduler(provider, { ...serverShape(config),
    outputTokens: (request: ModelRequest) => request.maxOutputTokens,
    log: (event, code) => report({ event, ...(code ? { code } : {}) }) });
  const sampler = values['no-vram'] ? undefined : watchVram(run, save, vramSeconds, card);
  try {
    const server = await warm.check({ signal });
    run.server = { slots: server.slots ?? null, contextTokens: server.contextTokens ?? null };
    const workloads: (Awaited<ReturnType<typeof buildWorkload>> & { description: WorkCase })[] = [];
    for (const fixture of names) {
      const raw = readFileSync(new URL(`../examples/frozen/${fixture}.json`, import.meta.url), 'utf8');
      const frozen = (JSON.parse(raw) as { state: Library }).state;
      for (const targetTokens of targets) {
        signal.throwIfAborted();
        const work = await buildWorkload(frozen, targetTokens, config.maxOutputTokens,
          request => warm.countInput(request, { signal }));
        const description: WorkCase = { id: `${fixture}-${targetTokens}`, fixture, fixtureSha256: hash(raw),
          requestSha256: hash(JSON.stringify(work.request)), targetTokens, inputTokens: work.inputTokens,
          sceneCount: work.sceneCount, outputCharacters: work.outputCharacters,
          prefixTokens: work.prefixTokens, previousInputTokens: work.previousInputTokens,
          previousRequestSha256: hash(JSON.stringify(work.previousRequest)) };
        workloads.push({ ...work, description });
        report({ event: 'history_prepared', ...description });
      }
    }
    const workload = { version: 3 as const, cases: workloads.map(work => work.description), coldRuns, warmRuns, nextTurns: !values.smoke,
      compactAtTokens: config.compactAtTokens, keepScenes: config.keepScenes, memoryMode: config.memoryMode };
    run.workload = { ...workload, fingerprint: hash(JSON.stringify({ ...workload, model: config.model,
      temperature: config.temperature, contextTokens: config.contextTokens,
      maxOutputTokens: config.maxOutputTokens, readSeconds })) };
    save();
    // The small case supplies disposable probes. Agent turns rotate through every case that has something to compact.
    const agentWorkloads = workloads.filter(work => work.sceneCount > config.keepScenes);
    if (!values.smoke && !agentWorkloads.length) throw new Error('no_compactable_fixture');
    const load = (phase: Phase, stopping: AbortSignal) => {
      const agent = (async () => {
        let index = 0;
        while (!stopping.aborted) {
          const work = agentWorkloads[index++ % agentWorkloads.length];
          const turn = scheduler.agent.openTurn({ holder: 'measure-agent' });
          try {
            await measureAgentTurn(turn, work.state, { ...config, signal: stopping, range: work.outputCharacters },
              call => { phase.agent.push(call); });
          } catch (error) {
            if (!stopping.aborted) report({ event: 'agent_call_failed', code: errorCode(error) ?? 'measurement_failed' });
          } finally { turn.end(); save(); }
          try { await delay(1000, undefined, { signal: stopping }); } catch { break; }
        }
      })();
      const probes = (async () => {
        while (!stopping.aborted) {
          try {
            const result = await scheduler.background.generate(structuredClone(workloads[0].request), { signal: stopping });
            phase.probes.completed++;
            phase.probes.outputTokens = number(phase.probes.outputTokens) && number(result.usage?.outputTokens)
              ? phase.probes.outputTokens + result.usage.outputTokens : null;
          } catch { phase.probes.preempted++; }
          try { await delay(1000, undefined, { signal: stopping }); } catch { break; }
        }
      })();
      return Promise.all([agent, probes]);
    };
    const phases: ('solo' | 'loaded')[] = values.smoke ? ['solo'] : ['solo', 'loaded'];
    for (const name of phases) {
      const phase: Phase = { seconds: 0, tester: [], primers: [], agent: [], probes: { completed: 0, preempted: 0, outputTokens: 0 },
        usefulOutputTokens: null, usefulTokensPerHour: null, complete: false };
      run.phases[name] = phase;
      report({ event: 'phase_started', phase: name });
      const started = performance.now();
      const stopping = new AbortController();
      const loadSignal = AbortSignal.any([signal, stopping.signal]);
      const loading = name === 'loaded' ? load(phase, loadSignal) : Promise.resolve();
      try {
        for (const work of workloads) for (let cycle = 0; cycle < coldRuns; cycle++) {
          const measure = async (intent: NonNullable<Call['cacheIntent']>) => {
            signal.throwIfAborted();
            const request = structuredClone(intent === 'prime' ? work.previousRequest : work.request);
            if (intent === 'cold' || intent === 'prime') coldRequests.add(request);
            const turn = scheduler.foreground.openTurn({ holder: 'measure-tester' });
            try {
              const { call } = await measureCall(turn, request, { label: intent === 'prime' ? 'tester_prime' : 'tester_scene', signal,
                inputLimitTokens: config.compactAtTokens - 1, range: work.outputCharacters });
              expectCache(call, intent, intent === 'next' ? work.prefixTokens : intent === 'warm' ? work.inputTokens : 0);
              Object.assign(call, { caseId: work.description.id, cycle,
                useful: intent !== 'prime' && !call.formatFailed && call.representative });
              (intent === 'prime' ? phase.primers! : phase.tester).push(call);
              closePhase(phase, (performance.now() - started) / 1000);
              report({ event: 'call_measured', ...call });
              save();
            } finally { turn.end(); }
          };
          // Replay for the best-case prefix measurement; then prime k-1 independently and request k for a real
          // next-turn prefix change. Both phases use the same frozen scene k, not an earlier generated alternative.
          await measure('cold');
          for (let index = 0; index < warmRuns; index++) {
            await delay(readSeconds * 1000, undefined, { signal });
            await measure('warm');
          }
          if (!values.smoke) {
            await measure('prime');
            await delay(readSeconds * 1000, undefined, { signal });
            await measure('next');
          }
        }
        phase.complete = true;
      } finally {
        stopping.abort();
        await loading;
        closePhase(phase, (performance.now() - started) / 1000);
        for (const summary of summaries(phase.tester)) report({ event: 'series_measured', phase: name, ...summary });
        report({ event: 'phase_completed', phase: name, complete: phase.complete, probes: phase.probes,
          usefulTokensPerHour: phase.usefulTokensPerHour });
        save();
      }
    }
    if (values.smoke) {
      run.smoke = smokeOutcome(run.phases.solo?.tester ?? []);
      report({ event: 'smoke_checked', ...run.smoke });
      if (!run.smoke.passed) { run.error = 'smoke_cache_failed'; process.exitCode = 1; }
    }
  } catch (error) {
    const code = String(errorCode(error) ?? (error instanceof Error ? error.message : ''));
    run.error = signal.aborted ? 'budget_exceeded' : /^[a-z_]{1,50}$/.test(code) ? code : 'measurement_failed';
    process.exitCode = 1;
  } finally {
    clearTimeout(budgetTimer);
    await sampler?.stop();
    await scheduler.close();
    run.completedAt = new Date().toISOString();
    save();
    report({ event: 'measurement_written', directory, profile: run.profile, error: run.error });
    if (values.smoke && !run.smoke) { run.smoke = smokeOutcome(run.phases.solo?.tester ?? []); save(); report({ event: 'smoke_checked', ...run.smoke }); }
    if (!values.smoke) for (const check of verdictOf(run)) report({ event: 'check', ...check });
  }
}

// One snapshot of the cards folded into the run: each card keeps its own peak and its own minimum, and a snapshot
// that read at least one card counts as one sample. A card the driver numbers itself is kept under that number; an
// older driver query without one is taken in the order it came. `named` is the operator's `--card`, if any.
export function recordCards(vram: Vram, remote: { gpus: Remote['gpus']; processes?: Remote['processes'] } | undefined,
  named: number | null = null) {
  if (!remote) return vram;
  let read = false;
  const pids = new Set((remote.processes?.llamaServer ?? []).map(process => process.pid).filter(number));
  remote.gpus.forEach((seen, position) => {
    const index = seen.index ?? position;
    let card = vram.cards.find(entry => entry.index === index);
    // Every card the driver reports has an entry, counters or no counters: a card whose memory could not be read is
    // still a card, and a two-card box whose second card answered nothing must not pass for a box with one.
    if (!card) {
      card = { index, totalMiB: null, usedMiBMax: null, freeMiBMin: null, server: false };
      vram.cards.push(card);
      vram.cards.sort((a, b) => a.index - b.index);
    }
    // A card that held llama-server once counts as one of its cards for the rest of the run: `nvidia-smi` lists the
    // compute processes of this moment, and a card is not given back because the peak has passed.
    card.server ||= seen.pids.some(pid => pids.has(pid));
    if (seen.memoryUsedMiB === undefined || seen.memoryTotalMiB === undefined) return;
    read = true;
    card.totalMiB = seen.memoryTotalMiB;
    card.usedMiBMax = Math.max(card.usedMiBMax ?? 0, seen.memoryUsedMiB);
    // The driver keeps a reserve of its own, and this output counts it in neither used nor free: subtracting used
    // from total hands that reserve back as headroom we do not have. It was 498 MiB on the measured 5090, against a
    // threshold of 1024. A driver too old to report free memory is read the old way rather than not at all.
    const free = seen.memoryFreeMiB ?? seen.memoryTotalMiB - seen.memoryUsedMiB;
    card.freeMiBMin = Math.min(card.freeMiBMin ?? free, free);
  });
  // Which card the verdicts are about: the one llama-server was seen computing on, and the tightest of them when it
  // was seen on several — nothing starts the server on a single device, and llama.cpp spreads a model over every
  // visible card by default, so the card that runs out first is the one that ends the run. A card the driver could
  // not read counts as the tightest of all, because an unread card cannot be declared roomy. A box with one card
  // leaves no room for doubt even before the server appears on it; on a box with several and nothing attributed the
  // operator's `--card` is the only answer, and without it check 1 stays unknown rather than reporting about the
  // image model's card.
  const hosts = vram.cards.filter(card => card.server);
  vram.card = hosts.length
    ? hosts.reduce((tightest, card) => (card.freeMiBMin ?? -1) < (tightest.freeMiBMin ?? -1) ? card : tightest).index
    : named !== null ? named : vram.cards.length === 1 ? vram.cards[0].index : null;
  if (read) vram.samples++;
  return vram;
}

// Video memory is read on the instance itself; only counters come back (local/gpu-diagnose.ts). Without an SSH host
// there is nothing to read, and check 1 stays unknown rather than becoming a pass.
// The interval is the operator's (`--vram-seconds`) and a couple of seconds by default: memory runs out in seconds
// under load, and a slow sampler leaves a fatal peak unread. That cadence is affordable only through the watcher's
// one long-lived session: a login per sample would be thirty a minute, and the bot was backed off from far fewer
// because they piled up on sshd (docs/knowledge/gpu-measurements.md#ssh-failures). The window before a profile starts
// — the server's own start — still belongs to `npm run gpu:diagnose -- --watch` (docs/llama-cpp.md#diagnostics).
function watchVram(run: Report, save: () => void, seconds: number, named: number | null) {
  const configured = process.env.SIMPLE_CHAT_GPU_SSH_HOST;
  const host = configured && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configured) ? configured : undefined;
  if (!host) return undefined;
  const stopping = new AbortController();
  let failures = 0, told = -Infinity, mismatched = false;
  // The cards and the processes on them, and nothing else: no retained server events, no loopback probes on the
  // instance and no probe of the forwarded port, which is the path whose latency thresholds 4 and 5 are about.
  // A session that is lost is reopened at the pace the bot uses, not once per interval: reconnecting every two
  // seconds is the pile-up on sshd the bot itself was backed off from.
  const loop = watch({ host, every: seconds, events: 0, parts: 'gpus,processes', probeTunnel: false, retryMs: 20000,
    signal: stopping.signal }, snapshot => {
    // A sampler that reads nothing leaves check 1 `unknown` at the end of a paid block. The operator hears about it
    // while the block is still running, and then no more than once a minute however long the failure lasts.
    if (!snapshot.remote) {
      failures++;
      if (performance.now() - told >= 60000) {
        told = performance.now();
        report({ event: 'vram_sample_failed', code: snapshot.direct.failure ?? 'no_reading', reading: snapshot.reading, failures });
      }
      return;
    }
    recordCards(run.vram, snapshot.remote, named);
    // A card named by hand that the driver's own attribution contradicts: the pids decide, and the operator is told
    // once, rather than reading a confident verdict about a card llama-server never computed on.
    if (named !== null && !mismatched && run.vram.card !== null && run.vram.card !== named) {
      mismatched = true;
      report({ event: 'vram_card_mismatch', named, card: run.vram.card });
    }
    save();
  }).catch(error => { report({ event: 'vram_sample_failed', code: errorCode(error) }); });
  return { stop() { stopping.abort(); return loop; } };
}

function printDecision(directory: string) {
  const runs: Report[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = entry.isDirectory() ? join(directory, entry.name, 'report.json')
      : entry.name.endsWith('.json') ? join(directory, entry.name) : null;
    if (!path) continue;
    try { runs.push(JSON.parse(readFileSync(path, 'utf8')) as Report); } catch {}
  }
  if (!runs.length) throw new Error('No measurement reports found');
  const decision = decide(runs.sort((a, b) => a.profile.localeCompare(b.profile)));
  for (const entry of decision.profiles) {
    report({ event: 'profile', profile: entry.profile, slots: entry.slots, draft: entry.draft,
      usefulTokensPerHour: entry.usefulTokensPerHour, testerTokensPerSecond: entry.testerTokensPerSecond,
      formatFailures: entry.formatFailures });
    for (const check of entry.checks) report({ event: 'check', profile: entry.profile, ...check });
    const source = runs.find(run => run.profile === entry.profile)!;
    for (const phase of ['solo', 'loaded'] as const) for (const summary of summaries(source.phases[phase]?.tester ?? [])) {
      report({ event: 'series_measured', profile: entry.profile, phase, ...summary });
    }
  }
  report({ event: 'check', ...decision.draft });
  report({ event: 'check', ...decision.together });
  report({ event: 'decision', ...decision.pool });
  // A fingerprint of the exact reports the decision was read from, so it can be repeated.
  report({ event: 'decision_fingerprint',
    sha256: createHash('sha256').update(runs.map(entry => `${entry.profile}:${entry.startedAt}`).join('|')).digest('hex').slice(0, 16) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
