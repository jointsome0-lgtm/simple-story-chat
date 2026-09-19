// Explicitly invoked live measurement of one llama-server profile, for the rented GPU session. No Telegram, no story
// database, no private seeds: the prompts are synthetic and the report holds counters, never text.
// One run measures one server profile and writes `report.json`; `--decide` reads several reports and applies the
// thresholds the owner agreed on (docs/gpu.md, "Measurement session").
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
import { diagnose } from './gpu-diagnose.ts';
import { errorCode } from './model-error.ts';
import type { GenerationResult, ModelRequest, Timings } from './model.ts';

// The take/drop thresholds for the session, agreed by the owner on 2026-09-20. `--decide` reports every number it
// measured beside them, so a borderline result stays the owner's call rather than the script's.
export const THRESHOLDS = {
  // 1. Free video memory at the peak. Less than this risks a failure on a long history.
  freeVramMiB: 1024,
  // 2. The tester's cache survives the work beside it, up to a template boundary.
  cacheToleranceTokens: 32,
  // 3. Parallel lanes are worth it only at this much more useful work per hour.
  throughputGain: 1.2,
  // 4. How much slower the tester's scene may get with work beside it.
  sceneSlowdown: 1.5,
  // 5. How long the tester may wait for the queue.
  waitSeconds: 120,
  // 6. The draft model (MTP) is worth it at this speed-up, and only without a format regression.
  draftSpeedup: 1.2,
} as const;

export type Call = {
  label: string; waitMs: number; elapsedMs: number; finishReason: string;
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
  tokensPerSecond: number | null; formatFailed: boolean; timings?: Timings;
};
export type Phase = {
  seconds: number; tester: Call[]; agent: Call[]; probes: { completed: number; preempted: number };
  // Work somebody asked for: the tester's scenes and the agent's turns, never the disposable probes.
  usefulOutputTokens: number; usefulTokensPerHour: number;
};
export type Vram = { samples: number; totalMiB: number | null; usedMiBMax: number | null; freeMiBMin: number | null };
export type Report = {
  profile: string; startedAt: string; completedAt?: string; model: string; temperature: number;
  server: { slots: number | null; contextTokens: number | null }; draft: boolean;
  bot: { slots: number; poolTokens: number; contextTokens: number; maxOutputTokens: number; quietMs: number;
    readSeconds: number; historyTokens: number | null };
  phases: { solo?: Phase; loaded?: Phase }; vram: Vram; error?: string;
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

// ---- Verdicts -------------------------------------------------------------------------------------------------
// Checks 1 to 5 are answered by one profile's own two phases; 6 and 7 need a pair of profiles and live in `decide`.
export function verdictOf(run: Report): Check[] {
  const { solo, loaded } = run.phases;
  const checks: Check[] = [];
  const add = (id: number, name: string, measured: string, threshold: string, verdict: Check['verdict']) =>
    checks.push({ id, name, verdict, measured, threshold });
  const free = run.vram.freeMiBMin;
  add(1, 'video memory at the peak', free === null ? 'not read' : `${free} MiB free`,
    `>= ${THRESHOLDS.freeVramMiB} MiB`, free === null ? 'unknown' : free >= THRESHOLDS.freeVramMiB ? 'pass' : 'fail');

  // The tester's cache: every scene after the first re-reads the previous one, whatever ran beside it.
  const kept = (calls: Call[]) => calls.slice(1).map((call, index) => {
    const previous = calls[index].inputTokens;
    if (previous === null || call.cachedInputTokens === null) return null;
    return (call.cachedInputTokens ?? 0) - (previous - THRESHOLDS.cacheToleranceTokens);
  });
  // A loaded phase in which nothing actually ran beside the tester answers none of these: a configuration too tight
  // to admit an agent at all would otherwise pass them all by doing no work.
  const contested = !!loaded && (loaded.agent.length > 0 || loaded.probes.completed > 0);
  const margins = loaded ? kept(loaded.tester).filter((value): value is number => value !== null) : [];
  const worst = contested && margins.length ? Math.min(...margins) : null;
  add(2, 'the tester keeps its cache', worst === null ? (contested ? 'not measured' : 'nothing ran beside the tester') : `${worst} tokens of margin`,
    `>= 0 (tolerance ${THRESHOLDS.cacheToleranceTokens})`, worst === null ? 'unknown' : worst >= 0 ? 'pass' : 'fail');

  const gain = contested && solo && loaded && solo.usefulTokensPerHour > 0 ? loaded.usefulTokensPerHour / solo.usefulTokensPerHour : null;
  add(3, 'useful work per hour beside the tester', gain === null ? (contested ? 'not measured' : 'nothing ran beside the tester') : `${round(gain)}x`,
    `>= ${THRESHOLDS.throughputGain}x`, gain === null ? 'unknown' : gain >= THRESHOLDS.throughputGain ? 'pass' : 'fail');

  const soloScene = solo ? median(solo.tester.map(call => call.elapsedMs)) : null;
  const loadedScene = loaded ? median(loaded.tester.map(call => call.elapsedMs)) : null;
  const slowdown = contested && soloScene && loadedScene ? loadedScene / soloScene : null;
  add(4, 'the tester\'s scene beside other work', slowdown === null ? (contested ? 'not measured' : 'nothing ran beside the tester') : `${round(slowdown)}x slower`,
    `<= ${THRESHOLDS.sceneSlowdown}x`, slowdown === null ? 'unknown' : slowdown <= THRESHOLDS.sceneSlowdown ? 'pass' : 'fail');

  const waits = loaded ? loaded.tester.map(call => call.waitMs) : [];
  const longest = waits.length ? Math.max(...waits) : null;
  add(5, 'the tester\'s longest wait for the queue', longest === null ? 'not measured' : `${round(longest / 1000, 1)} s`,
    `<= ${THRESHOLDS.waitSeconds} s`, longest === null ? 'unknown' : longest / 1000 <= THRESHOLDS.waitSeconds ? 'pass' : 'fail');
  return checks;
}

const testerSpeed = (run: Report) => {
  const speeds = (run.phases.solo?.tester ?? []).map(call => call.tokensPerSecond).filter((value): value is number => value !== null);
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
  const pooled = profiles.filter(entry => entry.slots > 1 && sound(entry));
  const best = pooled.sort((a, b) => (b.usefulTokensPerHour ?? 0) - (a.usefulTokensPerHour ?? 0))[0];
  const single = profiles.find(entry => entry.slots === 1);

  // The draft model: the same slot count with and without it, on the tester's own scenes.
  const withDraft = runs.filter(run => run.draft);
  const pair = withDraft.map(run => ({ run, plain: runs.find(other => !other.draft && other.bot.slots === run.bot.slots) }))
    .find(entry => entry.plain);
  const speedup = pair?.plain && testerSpeed(pair.run) && testerSpeed(pair.plain)
    ? testerSpeed(pair.run)! / testerSpeed(pair.plain)! : null;
  const broke = pair ? formatFailures(pair.run) > 0 : false;
  const draft: Check = { id: 6, name: 'the draft model (MTP)',
    verdict: speedup === null ? 'unknown' : speedup >= THRESHOLDS.draftSpeedup && !broke ? 'pass' : 'fail',
    measured: speedup === null ? 'no pair of profiles to compare' : `${round(speedup)}x${broke ? ', format regressed' : ''}`,
    threshold: `>= ${THRESHOLDS.draftSpeedup}x and no format regression` };

  // Both at once: a profile that is pooled and has the draft model must still leave the memory headroom.
  const both = runs.find(run => run.draft && run.bot.slots > 1);
  const bothFree = both?.vram.freeMiBMin ?? null;
  const together: Check = { id: 7, name: 'the pool and the draft model together',
    verdict: bothFree === null ? 'unknown' : bothFree >= THRESHOLDS.freeVramMiB ? 'pass' : 'fail',
    measured: bothFree === null ? 'not measured' : `${bothFree} MiB free`,
    threshold: `>= ${THRESHOLDS.freeVramMiB} MiB, else the pool is kept and the draft model dropped` };

  return { profiles, draft, together,
    pool: { take: best?.profile ?? null, over: single?.profile ?? null,
      note: best ? (together.verdict === 'fail' ? 'take the pool without the draft model' : 'take the pool')
        : 'no pooled profile passed its own checks; keep one slot' } };
}

// ---- The live run ---------------------------------------------------------------------------------------------
// One synthetic story, padded to a realistic history. Nothing here is a real person's text.
const SYSTEM = 'Это синтетический замер. Пиши кратко по-русски. Начинай ответ с даты 2026-09-20 21:00 на отдельной строке. Не выводи рассуждения или служебные теги.';
const SEED = 'СИД: Смотритель маяка Павел передал ключ от склада Вере 20 сентября в 21:00. Илья этого не видел.';
const FILLER = 'В журнале маяка записано: ветер ровный, волна низкая, обычная вахта.\n';
const NEXT = 'Продолжи сцену одним коротким абзацем, помня, у кого ключ.';
const formatFailedIn = (text: string) => !/^2026-09-20 21:00\s/.test(text) || /<\/?think>|<\|(?:channel|im_start|im_end)|\[start_header_id\]/i.test(text);

async function main(args: string[]) {
  const { values } = parseArgs({ args, options: {
    profile: { type: 'string' }, out: { type: 'string' }, decide: { type: 'string' },
    scenes: { type: 'string', default: '4' }, 'read-seconds': { type: 'string', default: '30' },
    'history-tokens': { type: 'string' }, minutes: { type: 'string', default: '10' },
    draft: { type: 'boolean', default: false }, 'no-vram': { type: 'boolean', default: false },
  } });
  if (values.decide) return void printDecision(resolve(values.decide));
  const scenes = Number(values.scenes), readSeconds = Number(values['read-seconds']), minutes = Number(values.minutes);
  // The tester's history: by default as long as one request may be, or a smaller size to fit several lanes.
  const asked = values['history-tokens'] === undefined ? null : Number(values['history-tokens']);
  if (asked !== null && (!Number.isInteger(asked) || asked < 512 || asked > 131072)) throw new Error('Invalid --history-tokens');
  if (!values.profile || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(values.profile)
    || !Number.isInteger(scenes) || scenes < 2 || scenes > 12
    || !Number.isInteger(readSeconds) || readSeconds < 0 || readSeconds > 600
    || !Number.isInteger(minutes) || minutes < 2 || minutes > 60) {
    throw new Error('Use --profile <name> [--out directory] [--scenes 2..12] [--read-seconds 0..600] [--history-tokens N] [--minutes 2..60] [--draft] [--no-vram], or --decide <directory>');
  }
  const config = loadModelConfig();
  if (config.provider !== 'llama-cpp') throw new Error('gpu_config_required');
  const provider = createLlama(config, { slots: config.slots, poolTokens: config.poolTokens });
  const server = await provider.check() as { slots?: number; contextTokens?: number };
  const directory = resolve(values.out ?? `measurements/${values.profile}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const run: Report = { profile: values.profile, startedAt: new Date().toISOString(), model: config.model,
    temperature: config.temperature, draft: values.draft,
    server: { slots: server.slots ?? null, contextTokens: server.contextTokens ?? null },
    bot: { slots: config.slots, poolTokens: config.poolTokens, contextTokens: config.contextTokens,
      maxOutputTokens: config.maxOutputTokens, quietMs: 60000, readSeconds, historyTokens: asked },
    phases: {}, vram: { samples: 0, totalMiB: null, usedMiBMax: null, freeMiBMin: null } };
  const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(run, null, 2));

  const scheduler = createScheduler(provider, { slots: config.slots, poolTokens: config.poolTokens,
    outputTokens: (request: ModelRequest) => request.maxOutputTokens,
    log: (event, code) => report({ event, ...(code ? { code } : {}) }) });
  const sampler = values['no-vram'] ? undefined : watchVram(run, save);
  const deadline = performance.now() + minutes * 60000;

  // One call through the scheduler: the wait for the queue and the generation are timed apart, because the owner's
  // thresholds ask different questions of them.
  async function measure(label: string, api: { generate: (request: ModelRequest, controls?: object) => Promise<GenerationResult> }, request: ModelRequest, signal?: AbortSignal) {
    const queued = performance.now();
    let startedAt = queued;
    const result = await api.generate(request, { signal, onStart: () => { startedAt = performance.now(); } });
    const elapsedMs = Math.round(performance.now() - startedAt);
    const usage = result.usage ?? null;
    const call: Call = { label, waitMs: Math.round(startedAt - queued), elapsedMs, finishReason: result.finishReason,
      inputTokens: usage?.inputTokens ?? null, cachedInputTokens: usage?.cachedInputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      tokensPerSecond: usage?.outputTokens && elapsedMs > 0 ? round(usage.outputTokens / (elapsedMs / 1000)) : null,
      formatFailed: formatFailedIn(result.text), ...(result.timings ? { timings: result.timings } : {}) };
    report({ event: 'call_measured', ...call });
    return { call, text: result.text };
  }

  // A history the size of a real tester's: padded with filler until the server counts what we asked for.
  async function history(targetTokens: number): Promise<ModelRequest> {
    let repeats = Math.max(1, Math.round(targetTokens / 16));
    let request!: ModelRequest, measured!: number;
    for (let attempt = 0; attempt < 8; attempt++) {
      request = { system: SYSTEM, maxOutputTokens: config.maxOutputTokens,
        messages: [{ role: 'user', content: `${SEED}\n${FILLER.repeat(repeats)}\n${NEXT}` }] };
      measured = await provider.countInput(request);
      if (measured >= targetTokens * 0.97 && measured <= targetTokens) break;
      repeats = Math.max(1, Math.floor(repeats * targetTokens * 0.99 / measured));
    }
    if (!(measured >= targetTokens * 0.97 && measured <= targetTokens)) throw new Error('history_size_failed');
    report({ event: 'history_prepared', inputTokens: measured });
    return request;
  }

  // The tester writes a scene, reads it, writes the next: each call re-reads the one before it, which is what the
  // prefix cache must survive.
  // A cold server reads the whole history once. That one-off belongs to neither phase: without it the solo phase pays
  // a prefill the loaded phase inherits warm, and every comparison between them is off by it.
  async function warmTester() {
    const base = await history(asked ?? Math.min(40000, config.contextTokens - config.maxOutputTokens - 2048));
    const turn = scheduler.foreground.openTurn({ holder: 'measure-tester' });
    try { report({ event: 'warmup_done', ...(await measure('tester_warmup', turn, base)).call }); }
    finally { turn.end(); }
    return base;
  }
  async function tester(base: ModelRequest, calls: Call[]) {
    let messages = base.messages;
    for (let index = 0; index < scenes && performance.now() < deadline; index++) {
      const turn = scheduler.foreground.openTurn({ holder: 'measure-tester' });
      try {
        const { call, text } = await measure(`tester_scene_${index + 1}`, turn, { ...base, messages });
        calls.push(call);
        // Written after every scene: a paid session must be readable while it runs, not only when it ends.
        save();
        messages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: NEXT }];
      } finally { turn.end(); }
      if (index + 1 < scenes) await delay(readSeconds * 1000);
    }
  }

  // Everything that fills the card while the tester reads: agent turns (a compaction and a scene, as the agent
  // interface runs them) and disposable probes.
  async function load(phase: Phase, stopping: AbortSignal) {
    const small = await history(2000);
    const large = await history(asked ?? Math.min(24000, config.contextTokens - config.maxOutputTokens - 2048));
    const agentWork = (async () => {
      while (!stopping.aborted && performance.now() < deadline) {
        const turn = scheduler.agent.openTurn({ holder: 'measure-agent' });
        try {
          phase.agent.push((await measure('agent_compaction', turn, { ...small, purpose: 'memory' }, stopping)).call);
          phase.agent.push((await measure('agent_scene', turn, large, stopping)).call);
        } catch (error) { if (!stopping.aborted) report({ event: 'agent_call_failed', code: errorCode(error) }); }
        finally { turn.end(); }
      }
    })();
    const probing = (async () => {
      while (!stopping.aborted && performance.now() < deadline) {
        try { await scheduler.background.generate(small, { signal: stopping }); phase.probes.completed++; }
        catch { phase.probes.preempted++; }
        await delay(1000);
      }
    })();
    return () => Promise.all([agentWork, probing]);
  }

  const emptyPhase = (): Phase => ({ seconds: 0, tester: [], agent: [], probes: { completed: 0, preempted: 0 },
    usefulOutputTokens: 0, usefulTokensPerHour: 0 });
  const close = (phase: Phase, seconds: number) => {
    phase.seconds = round(seconds, 1);
    phase.usefulOutputTokens = [...phase.tester, ...phase.agent].reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
    phase.usefulTokensPerHour = seconds > 0 ? Math.round(phase.usefulOutputTokens * 3600 / seconds) : 0;
  };

  try {
    // Solo: the tester alone, reading between scenes, so the card idles exactly as it does today.
    report({ event: 'phase_started', phase: 'solo' });
    const solo = emptyPhase();
    run.phases.solo = solo;
    const base = await warmTester();
    let started = performance.now();
    await tester(base, solo.tester);
    close(solo, (performance.now() - started) / 1000);
    save();

    // Loaded: the same tester, with agent turns and probes filling the card while it reads. The tester's cache is
    // warm before the load starts, so the scenes measure what the load does to it.
    report({ event: 'phase_started', phase: 'loaded' });
    const loaded = emptyPhase();
    run.phases.loaded = loaded;
    await warmTester();
    const stopping = new AbortController();
    const settled = await load(loaded, stopping.signal);
    started = performance.now();
    await tester(base, loaded.tester);
    close(loaded, (performance.now() - started) / 1000);
    stopping.abort();
    await settled();
    run.completedAt = new Date().toISOString();
  } catch (error) {
    const code = String(errorCode(error) ?? '');
    run.error = /^[a-z_]{1,50}$/.test(code) ? code : 'measurement_failed';
    process.exitCode = 1;
  } finally {
    sampler?.stop();
    await scheduler.close();
    save();
    report({ event: 'measurement_written', directory, profile: run.profile, error: run.error });
    for (const check of verdictOf(run)) report({ event: 'check', ...check });
  }
}

// Video memory is read on the instance itself; only counters come back (local/gpu-diagnose.ts). Without an SSH host
// there is nothing to read, and check 1 stays unknown rather than becoming a pass.
function watchVram(run: Report, save: () => void) {
  const configured = process.env.SIMPLE_CHAT_GPU_SSH_HOST;
  const host = configured && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configured) ? configured : undefined;
  let stopped = false;
  const loop = (async () => {
    while (!stopped && host) {
      try {
        const seen = await diagnose({ host, events: 1 });
        for (const card of seen.remote?.gpus ?? []) {
          if (card.memoryUsedMiB === undefined || card.memoryTotalMiB === undefined) continue;
          run.vram.samples++;
          run.vram.totalMiB = card.memoryTotalMiB;
          run.vram.usedMiBMax = Math.max(run.vram.usedMiBMax ?? 0, card.memoryUsedMiB);
          const free = card.memoryTotalMiB - card.memoryUsedMiB;
          run.vram.freeMiBMin = Math.min(run.vram.freeMiBMin ?? free, free);
        }
        save();
      } catch (error) { report({ event: 'vram_sample_failed', code: errorCode(error) }); }
      await delay(20000);
    }
  })();
  return { stop() { stopped = true; return loop; } };
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
