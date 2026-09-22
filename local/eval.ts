// One number for a change to prompts or memory: the recall of the worst model over frozen synthetic stories.
// `write` has one model write the stories once; the default command replays them through every model's memory.
// Hosted keys come from .env.eval. The probes run in an empty directory, so the bot's .env never reaches them.
import { parseArgs, parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { ReplayReport, ModeReport } from './memory-probe.ts';
import type { WalkReport } from './walk-probe.ts';
import { loadScenario, packScenarios, loadWalk, packWalks } from './scenarios.ts';
import { panel, summarize, judgeFileName, council, findings, crossFileName } from './walk-panel.ts';
import type { JudgeFile, CrossFile, CouncilRow, PanelRow, Vote } from './walk-panel.ts';
import { channelFor, capsFor, readUsage } from './budget.ts';
import { BUDGET_PATH } from './model.ts';

type Env = NodeJS.Dict<string>;
// A cell of the result: one model, one scenario, one memory mode.
// readingMisses: failed numeric questions whose answer stood in the memory message, so the memory was right and the reading was not.
type Cell = { passed: number; total: number; error?: string; failedKeys: string[]; readingMisses?: string[]; scene?: Part; compactionRetries?: number };
// With --judge: the verdicts on the trap scenes this model wrote after the replay.
type Part = { passed: number; total: number; error?: string; failedKeys: string[] };
// A cell of a walk: one model, one walk scenario, with the panel's verdict on every scene and each judge's own counts.
// `directory` is the probe's own directory, so that a judge can be added to the panel with `eval walk-judge`.
// The cell's own numbers are the council's (second round); `votes` is the first round's majority, kept for comparison.
type WalkCell = ReturnType<typeof summarize> & { votes: ReturnType<typeof summarize>; findings: number; confirmed: number; refuted: number; disputed: number;
  truncated: number; error?: string; compactionRetries?: number; directory?: string;
  judges: Record<string, { consistent: number; inconsistent: number; errors: number; error?: string; checks?: number; confirmed?: number; crossError?: string }>;
  rows: (CouncilRow & { votes: PanelRow['votes'] })[] };

const HOSTS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY' },
};
const ALL_MODES = ['plain', 'sgr'] as const;
const root = resolve(import.meta.dirname, '..');
const frozen = join(root, 'examples', 'frozen');
// Every probe event, for `eval watch` in another terminal. Probes print metadata only; logs/ is ignored by Git.
const EVENTS = join(root, 'logs', 'eval.jsonl');
const record = (event: object) => { mkdirSync(join(root, 'logs'), { recursive: true }); appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); };

process.umask(0o077);
const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string' }, models: { type: 'string' },
  scenarios: { type: 'string' }, pack: { type: 'string' }, out: { type: 'string' }, resume: { type: 'string' }, mode: { type: 'string' },
  judge: { type: 'string' }, judges: { type: 'string' }, minutes: { type: 'string' }, cross: { type: 'boolean', default: false } } });
// --pack names a directory of scenarios kept outside the repository, so the one who improves the prompts never reads
// them. Its scenarios replace the built-in ones; every pack scenario names its authors.
const pack = values.pack ? resolve(values.pack) : undefined;
// `walk` and `walk-judge` take walk scenarios, which have their own files and loader.
const walking = positionals[0] === 'walk' || positionals[0] === 'walk-judge';
const scenarios = values.scenarios?.split(',') ?? (pack ? (walking ? packWalks(pack) : packScenarios(pack)) : walking ? ['lighthouse'] : ['battle', 'chess', 'dance']);
// --mode replays one memory mode, for a cheap look at a single failure.
if (values.mode !== undefined && !ALL_MODES.includes(values.mode as 'plain')) throw new Error('Unknown memory mode');
const MODES = values.mode ? [values.mode as typeof ALL_MODES[number]] : ALL_MODES;
if (!scenarios.length) throw new Error('Unknown synthetic scenario');
// The loader throws on a name that is neither built in nor in the pack.
const fixtures = Object.fromEntries(walking ? [] : await Promise.all(scenarios.map(async name => [name, await loadScenario(name, pack)] as const)));
const walks = Object.fromEntries(walking ? await Promise.all(scenarios.map(async name => [name, await loadWalk(name, pack)] as const)) : []);
const checks = Object.fromEntries(scenarios.map(name => [name, fixtures[name]?.checks ?? []]));
const packArgs = pack ? ['--pack', pack] : [];
let keys: Env = {};
try { keys = parseEnv(readFileSync(join(root, '.env.eval'), 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read .env.eval'); }

// "openrouter:google/gemma-4-31b-it:free", "openai:gpt-5.4-mini" or "claude:claude-haiku-4-5-20251001".
function modelEnv(spec: string): Env {
  const [host, model] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
  if (host === 'claude' && model) return { SIMPLE_CHAT_PROVIDER: 'claude-code', SIMPLE_CHAT_MODEL: model };
  // "codex:<model>" goes through the installed Codex CLI and its own sign-in.
  if (host === 'codex' && model) return { SIMPLE_CHAT_PROVIDER: 'codex-cli', SIMPLE_CHAT_MODEL: model };
  // "gpu:<label>" is the owner's own model from .env.gpu, reached through the tunnel that is already open. The rental and
  // SSH settings are not passed on, so a probe never starts, stops or reconnects the GPU. The label only names the run.
  if (host === 'gpu' && model) {
    let gpu: Env = {};
    try { gpu = parseEnv(readFileSync(join(root, '.env.gpu'), 'utf8')); } catch { throw new Error('Cannot read .env.gpu'); }
    const names = ['PROVIDER', 'BASE_URL', 'API_KEY', 'MODEL', 'CONTEXT_TOKENS', 'MAX_OUTPUT_TOKENS', 'MODEL_TIMEOUT_MS', 'TEMPERATURE'];
    return Object.fromEntries(names.map(name => [`SIMPLE_CHAT_${name}`, gpu[`SIMPLE_CHAT_${name}`]]));
  }
  if (!Object.hasOwn(HOSTS, host) || !model) throw new Error('Name a model as <host>:<id>, with host openrouter, openai, cerebras, groq, mistral, claude or gpu');
  const { baseUrl, key } = HOSTS[host as keyof typeof HOSTS];
  const apiKey = process.env[key] || keys[key];
  if (!apiKey) throw new Error(`Set ${key} in .env.eval`);
  // OPENROUTER_FREE_DAILY_REQUESTS, OPENAI_SMALL_DAILY_TOKENS and the like replace the channel's default cap.
  const cap = channelFor(baseUrl, model).toUpperCase().replace('-', '_');
  return { SIMPLE_CHAT_PROVIDER: 'openai-compatible', SIMPLE_CHAT_BASE_URL: baseUrl, SIMPLE_CHAT_API_KEY: apiKey, SIMPLE_CHAT_MODEL: model,
    SIMPLE_CHAT_BUDGET_REQUESTS: keys[`${cap}_DAILY_REQUESTS`], SIMPLE_CHAT_BUDGET_TOKENS: keys[`${cap}_DAILY_TOKENS`] };
}

// Runs a probe and returns its exit code, its directory and its last failure code. Probes print metadata only.
function probe(script: string, args: string[], env: Env, label: string, tags: { scenario: string; mode?: string; judge?: string }) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SIMPLE_CHAT_')));
  const child = spawn(process.execPath, [join(root, 'local', script), ...args],
    { cwd: mkdtempSync(join(tmpdir(), 'simple-chat-eval-cwd-')), env: { ...inherited, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let directory = '';
  let code = '';
  let buffer = '';
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      let event: { event?: string; directory?: string; code?: string };
      try { event = JSON.parse(line); } catch { continue; }
      if (event.directory) directory = event.directory;
      if (event.code) code = event.code;
      console.log(JSON.stringify({ ...event, model: label, directory: undefined }));
      record({ ...event, ...tags, model: label, directory: undefined });
    }
  });
  return new Promise<{ status: number | null; directory: string; code: string }>((done, fail) => {
    child.on('error', fail).on('close', status => done({ status, directory, code }));
  });
}

async function write(spec: string) {
  // Pack stories are written by their authors and frozen with freeze-scenes.ts, never by a model under test.
  if (pack) throw new Error('eval write is for built-in scenarios; freeze a pack with local/freeze-scenes.ts --pack');
  const env = modelEnv(spec);
  mkdirSync(frozen, { recursive: true });
  record({ event: 'run_started', models: [spec], scenarios });
  for (const scenario of scenarios) {
    // --resume continues a failed write of a single scenario from its probe directory.
    let run = await probe('story-probe.ts', ['--scenario', scenario, ...(values.resume ? ['--resume', values.resume] : [])], env, spec, { scenario });
    // A free hosted model allows 20 requests a minute; the probe resumes from its last saved scene.
    for (let attempt = 0; run.status !== 0 && run.code === 'rate_limited' && run.directory && attempt < 10; attempt++) {
      await wait(30000);
      run = await probe('story-probe.ts', ['--scenario', scenario, '--resume', run.directory], env, spec, { scenario });
    }
    if (run.status !== 0) throw new Error(`Writing ${scenario} failed: ${run.code || 'probe_failed'}; resume it with story:probe --resume ${run.directory}`);
    copyFileSync(join(run.directory, 'evidence.json'), join(frozen, `${scenario}.json`));
  }
}

async function replay(spec: string): Promise<Record<string, Record<string, Cell>>> {
  const env = modelEnv(spec);
  const judgeEnv = values.judge ? modelEnv(values.judge) : null;
  const cells: Record<string, Record<string, Cell>> = {};
  for (const scenario of scenarios) {
    cells[scenario] = {};
    // A probe stops at its first failure, so each mode gets its own run and its own error.
    for (const mode of MODES) {
      const run = await probe('memory-probe.ts', ['--direct', '--mode', mode, '--minutes', '30', ...(judgeEnv ? ['--traps'] : []), '--source', fixtures[scenario].frozenPath, ...packArgs], env, spec, { scenario, mode });
      let report: ReplayReport | null = null;
      try { report = JSON.parse(readFileSync(join(run.directory, 'report.json'), 'utf8')); } catch { /* counted as failed below */ }
      const result: ModeReport | undefined = report?.modes[mode];
      const answers = result?.answers ?? [];
      // A mode that did not finish answers nothing: a model that cannot keep a memory scores zero here.
      cells[scenario][mode] = { passed: answers.filter(a => a.pass).length, total: checks[scenario].length,
        failedKeys: checks[scenario].map(([key]) => key).filter(key => !answers.some(a => a.key === key && a.pass)),
        readingMisses: answers.filter(a => !a.pass && a.stated === 'memory').map(a => a.key),
        ...(result?.completedAt ? {} : { error: result?.error ?? (run.code || 'probe_failed') }),
        ...(result?.compactionRetries ? { compactionRetries: result.compactionRetries } : {}) };
      const questions = fixtures[scenario].traps.flatMap(trap => trap.questions.map(([key]) => key));
      if (!judgeEnv || !questions.length) continue;
      // Without a finished replay there are no trap scenes, and every question fails.
      const judged = result?.completedAt ? await probe('scene-judge.ts', ['--report', run.directory, '--mode', mode, ...packArgs], judgeEnv, spec, { scenario, mode }) : null;
      let verdicts: NonNullable<ModeReport['verdicts']> = [];
      try { verdicts = (JSON.parse(readFileSync(join(run.directory, 'report.json'), 'utf8')) as ReplayReport).modes[mode]?.verdicts ?? []; } catch { /* counted as failed below */ }
      cells[scenario][mode].scene = { passed: verdicts.filter(v => v.pass).length, total: questions.length,
        failedKeys: questions.filter(key => !verdicts.some(v => v.key === key && v.pass)),
        ...(judged?.status === 0 ? {} : { error: judged ? judged.code || 'probe_failed' : 'no_scenes' }) };
    }
  }
  return cells;
}

if (positionals[0] === 'watch') {
  // A live table of the current run: the last event of every model, scenario and mode, and today's counters.
  const label = (e: { event?: string; code?: string; passed?: number; total?: number; turn?: number; afterTurn?: number; confirmed?: number; findings?: number }, waits: number) =>
    e.event === 'mode_complete' ? `память ${e.passed}/${e.total}` : e.event === 'judged' ? `сцены ${e.passed}/${e.total}`
      : e.event === 'trap_scene' || e.event === 'trap_judged' ? 'сцены-ловушки' : e.event === 'deferred_or_failed' || e.event === 'failed' ? `сбой: ${e.code}`
      : e.event === 'yielded' ? `ждёт (${e.code}) ×${waits}` : e.event === 'compacted' || e.event === 'compaction' ? `сжатие после сцены ${e.afterTurn}`
        : e.event === 'scene' ? `сцена ${e.turn}` : e.event === 'scene_judged' ? `судья: сцена ${e.turn}` : e.event === 'scene_crossed' ? `консилиум: сцена ${e.turn}`
        : e.event === 'crossed' ? `консилиум: ${e.confirmed} из ${e.findings}` : e.event === 'complete' ? 'записано' : 'идёт';
  for (;;) {
    let lines: string[] = [];
    try { lines = readFileSync(EVENTS, 'utf8').trim().split('\n'); } catch { /* no run yet */ }
    const events = lines.map(line => JSON.parse(line) as { at: string; event: string; model?: string; scenario?: string; mode?: string; judge?: string; score?: object });
    const run = events.slice(events.findLastIndex(e => e.event === 'run_started') + 1);
    const rows = new Map<string, { last: typeof run[number]; waits: number }>();
    for (const e of run) {
      if (!e.model || !e.scenario || e.event === 'model_request') continue;
      const key = `${e.model}  ${e.scenario}  ${e.mode ?? 'write'}${e.judge ? ` ${e.judge}` : ''}`;
      rows.set(key, { last: e, waits: (rows.get(key)?.waits ?? 0) + (e.event === 'yielded' ? 1 : 0) });
    }
    const done = run.findLast(e => e.event === 'eval');
    console.log('\x1b[2J\x1b[H' + `eval · ${new Date().toLocaleTimeString()} · ${done ? 'прогон закончен' : rows.size ? 'прогон идёт' : 'прогонов нет'}\n`);
    for (const [key, { last, waits }] of rows) console.log(`${key.padEnd(72)} ${label(last, waits).padEnd(28)} ${new Date(last.at).toLocaleTimeString()}`);
    if (done) console.log(`\nscore ${JSON.stringify(done.score)}`);
    console.log('\n' + readUsage(BUDGET_PATH).map(u => `${u.channel}: ${u.requests} запросов, ${u.tokens} токенов`).join('\n'));
    await wait(2000);
  }
} else if (positionals[0] === 'usage') {
  const used = readUsage(BUDGET_PATH);
  for (const channel of ['openrouter-free', 'openrouter-paid', 'openai-small', 'openai-large', 'openai-paid', 'cerebras', 'groq', 'mistral']) {
    const cap = channel.toUpperCase().replace('-', '_');
    const number = (value: string | undefined) => value ? Number(value) : undefined;
    console.log(JSON.stringify({ channel, requests: 0, tokens: 0, ...used.find(row => row.channel === channel),
      caps: capsFor(channel, { requests: number(keys[`${cap}_DAILY_REQUESTS`]), tokens: number(keys[`${cap}_DAILY_TOKENS`]) }) }));
  }
} else if (positionals[0] === 'ceiling') {
  // The questions over the whole frozen story, without memory. Below the maximum for a strong model, the story
  // itself contradicts the fixed answers and must be written again before it measures anything.
  if (!values.model) throw new Error('Use: eval ceiling --model <host>:<id> [--scenarios a,b]');
  for (const scenario of scenarios) {
    const run = await probe('memory-probe.ts', ['--direct', '--mode', 'full', '--minutes', '30', '--source', fixtures[scenario].frozenPath, ...packArgs], modelEnv(values.model), values.model, { scenario, mode: 'full' });
    let answers: NonNullable<ModeReport['answers']> = [];
    try { answers = (JSON.parse(readFileSync(join(run.directory, 'report.json'), 'utf8')) as ReplayReport).modes.full?.answers ?? []; } catch { /* reported as failed below */ }
    console.log(JSON.stringify({ event: 'ceiling', scenario, passed: answers.filter(a => a.pass).length, total: checks[scenario].length,
      failedKeys: checks[scenario].map(([key]) => key).filter(key => !answers.some(a => a.key === key && a.pass)), error: run.status === 0 ? undefined : run.code || 'probe_failed' }));
  }
} else if (positionals[0] === 'judge') {
  // Judges the trap scenes of a finished replay again, to compare judges or question wordings on the same scenes.
  if (!values.judge || !values.resume || !values.mode) throw new Error('Use: eval judge --judge <host>:<id> --resume directory --mode plain|sgr');
  await probe('scene-judge.ts', ['--report', values.resume, '--mode', values.mode], modelEnv(values.judge), values.judge, { scenario: 'judge', mode: values.mode });
} else if (positionals[0] === 'walk-judge') {
  // One more judge over a finished walk, for a panel that grew or a judge that failed. Its file lands next to the report.
  if (!values.judge || !values.resume) throw new Error('Use: eval walk-judge --judge <host>:<id> --resume directory [--minutes 1..180] [--cross]');
  await probe('walk-judge.ts', ['--report', values.resume, '--label', values.judge, ...(values.minutes ? ['--minutes', values.minutes] : []), ...(values.cross ? ['--cross'] : [])], modelEnv(values.judge), values.judge, { scenario: 'walk-judge', mode: values.cross ? 'walk-cross' : 'walk-judge' });
} else if (positionals[0] === 'walk') {
  // The walk: every model writes each walk scenario itself, one scene per step, and every judge of the panel reads every
  // scene. The number is the share of scenes the panel's majority found consistent, for the worst model.
  const models = (values.models ?? '').split(',').filter(Boolean);
  const judges = (values.judges ?? '').split(',').filter(Boolean);
  const minutes = values.minutes ?? '60';
  if (!models.length || !judges.length || new Set(judges).size !== judges.length || !/^\d{1,3}$/.test(minutes)) throw new Error('Use: eval walk --models <host>:<id>,... --judges <host>:<id>,... [--scenarios a,b] [--pack directory] [--minutes 1..180] [--out file]');
  record({ event: 'run_started', models, scenarios, judges });
  // Every model walks every scenario, models in parallel, each on its own provider limits.
  const walked = Object.fromEntries(await Promise.all(models.map(async spec => {
    const env = modelEnv(spec);
    const runs: Record<string, { directory: string; code: string; report: WalkReport | null }> = {};
    for (const scenario of scenarios) {
      const run = await probe('walk-probe.ts', ['--scenario', scenario, '--minutes', minutes, ...packArgs], env, spec, { scenario, mode: 'walk' });
      let report: WalkReport | null = null;
      try { report = JSON.parse(readFileSync(join(run.directory, 'report.json'), 'utf8')); } catch { /* counted as failed below */ }
      runs[scenario] = { directory: run.directory, code: run.code, report };
    }
    return [spec, runs] as const;
  })));
  // Every judge reads every walk that has scenes, judges in parallel and each judge's walks one after another. An
  // unfinished walk is judged on the scenes it has; the scenes it lacks count against the model.
  const files: Record<string, Record<string, Record<string, JudgeFile | null>>> = {};
  await Promise.all(judges.map(async judgeSpec => {
    const env = modelEnv(judgeSpec);
    for (const spec of models) for (const scenario of scenarios) {
      const { directory, report } = walked[spec][scenario];
      let file: JudgeFile | null = null;
      if (report?.steps.length) {
        const judged = await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes], env, spec, { scenario, mode: 'walk-judge', judge: judgeSpec });
        try { file = JSON.parse(readFileSync(join(directory, judgeFileName(judgeSpec)), 'utf8')); } catch { /* no verdicts */ }
        if (file && judged.status !== 0) file.error ??= judged.code || 'probe_failed';
      }
      ((files[spec] ??= {})[scenario] ??= {})[judgeSpec] = file;
    }
  }));
  // The council's second round: every finding of the first round goes to every judge, once all first-round files of a
  // walk exist. A walk nobody found anything in needs no second round.
  const crossed: Record<string, Record<string, Record<string, CrossFile | null>>> = {};
  await Promise.all(judges.map(async judgeSpec => {
    const env = modelEnv(judgeSpec);
    for (const spec of models) for (const scenario of scenarios) {
      const { directory, report } = walked[spec][scenario];
      let file: CrossFile | null = null;
      const listed = Object.values(files[spec]?.[scenario] ?? {}).some(f => f?.verdicts.some(v => v.contradictions.length));
      if (report?.steps.length && listed) {
        const run = await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes, '--cross'], env, spec, { scenario, mode: 'walk-cross', judge: judgeSpec });
        try { file = JSON.parse(readFileSync(join(directory, crossFileName(judgeSpec)), 'utf8')); } catch { /* no checks */ }
        if (file && run.status !== 0) file.error ??= run.code || 'probe_failed';
      }
      ((crossed[spec] ??= {})[scenario] ??= {})[judgeSpec] = file;
    }
  }));
  const cells: Record<string, Record<string, WalkCell>> = {};
  for (const spec of models) {
    cells[spec] = {};
    for (const scenario of scenarios) {
      const { directory, code, report } = walked[spec][scenario];
      const verdicts = files[spec]?.[scenario] ?? {};
      const checks = crossed[spec]?.[scenario] ?? {};
      const byJudge = Object.fromEntries(judges.map(judge => [judge, verdicts[judge]?.verdicts ?? []]));
      const votes = panel(walks[scenario].steps.length, byJudge);
      const rows = council(walks[scenario].steps.length, byJudge, Object.fromEntries(judges.map(judge => [judge, checks[judge]?.checks ?? []])))
        .map((row, i) => ({ ...row, votes: votes[i].votes }));
      const count = (file: JudgeFile | null, vote: Vote) => file?.verdicts.filter(v => v.verdict === vote).length ?? 0;
      const sum = (key: 'findings' | 'confirmed' | 'refuted' | 'disputed') => rows.reduce((total, row) => total + row[key], 0);
      cells[spec][scenario] = { ...summarize(rows), votes: summarize(votes), findings: sum('findings'), confirmed: sum('confirmed'), refuted: sum('refuted'), disputed: sum('disputed'),
        truncated: report?.steps.filter(step => step.truncated).length ?? 0,
        ...(report?.completedAt ? {} : { error: report?.error ?? (code || 'probe_failed') }),
        ...(report?.compactionRetries ? { compactionRetries: report.compactionRetries } : {}), ...(directory ? { directory } : {}),
        judges: Object.fromEntries(judges.map(judge => {
          const file = verdicts[judge] ?? null;
          const cross = checks[judge] ?? null;
          return [judge, { consistent: count(file, 'consistent'), inconsistent: count(file, 'inconsistent'), errors: rows.length - count(file, 'consistent') - count(file, 'inconsistent'),
            ...(file && !file.error ? {} : { error: file?.error ?? 'no_verdicts' }),
            ...(cross ? { checks: cross.checks.length, confirmed: cross.checks.filter(c => c.confirmed).length, ...(cross.error ? { crossError: cross.error } : {}) } : {}) }];
        })), rows };
    }
  }
  // The worst model decides, as in the replay; a scene the panel split on or could not judge is not consistent.
  const rate = (spec: string) => scenarios.reduce((sum, scenario) => sum + cells[spec][scenario].consistent, 0) / scenarios.reduce((sum, scenario) => sum + cells[spec][scenario].total, 0);
  // `votes` is the same number from the first round alone, for a look at what the council changed.
  const voteRate = (spec: string) => scenarios.reduce((sum, scenario) => sum + cells[spec][scenario].votes.consistent, 0) / scenarios.reduce((sum, scenario) => sum + cells[spec][scenario].total, 0);
  const score = { walk: Math.min(...models.map(rate)), votes: Math.min(...models.map(voteRate)) };
  const brief = (spec: string) => Object.fromEntries(scenarios.map(scenario => {
    const { consistent, split, inconsistent, unjudged, total, firstInconsistent, findings, confirmed, error, votes } = cells[spec][scenario];
    return [scenario, { consistent, split, inconsistent, unjudged, total, firstInconsistent, findings, confirmed, votes: votes.consistent, error }];
  }));
  const summary = { at: new Date().toISOString(), kind: 'walk', scenarios, ...(pack ? { pack: true } : {}), authors: Object.fromEntries(scenarios.map(name => [name, walks[name].authors])),
    judges, minutes: Number(minutes), score, models: Object.fromEntries(models.map(spec => [spec, { walk: rate(spec), votes: voteRate(spec), cells: cells[spec] }])) };
  const out = resolve(values.out ?? join(mkdtempSync(join(tmpdir(), 'simple-chat-eval-')), 'walk.json'));
  writeFileSync(out, JSON.stringify(summary, null, 2));
  record({ event: 'eval', out, score });
  console.log(JSON.stringify({ event: 'eval', out, score, models: Object.fromEntries(models.map(spec => [spec, { walk: rate(spec), cells: brief(spec) }])) }));
} else if (positionals[0] === 'write') {
  if (!values.model || (values.resume && scenarios.length !== 1)) throw new Error('Use: eval write --model <host>:<id> [--scenarios a,b] [--scenarios a --resume directory]');
  await write(values.model);
} else {
  const models = (values.models ?? '').split(',').filter(Boolean);
  if (!models.length) throw new Error('Use: eval --models <host>:<id>,<host>:<id> [--scenarios a,b] [--mode plain|sgr] [--judge <host>:<id>] [--out file]');
  record({ event: 'run_started', models, scenarios });
  const missing = scenarios.filter(scenario => !existsSync(fixtures[scenario].frozenPath));
  if (missing.length) throw new Error(`No frozen story for ${missing.join(', ')}; run: eval write --model <host>:<id>`);
  // Models answer in parallel, each on its own provider limits.
  const results = Object.fromEntries(await Promise.all(models.map(async spec => [spec, await replay(spec)] as const)));
  const rate = (spec: string, mode: string) => {
    const cells = scenarios.map(scenario => results[spec][scenario][mode]);
    return cells.reduce((sum, cell) => sum + cell.passed, 0) / cells.reduce((sum, cell) => sum + cell.total, 0);
  };
  // The worst model decides, so a change cannot win by pleasing the most obedient one.
  const score = Object.fromEntries(MODES.map(mode => [mode, Math.min(...models.map(spec => rate(spec, mode)))]));
  // The same rule for the judged trap scenes; null when no chosen scenario has traps.
  const sceneRate = (spec: string, mode: string) => {
    const parts = scenarios.flatMap(scenario => results[spec][scenario][mode].scene ?? []);
    return parts.length ? parts.reduce((sum, part) => sum + part.passed, 0) / parts.reduce((sum, part) => sum + part.total, 0) : null;
  };
  const sceneScore = values.judge ? Object.fromEntries(MODES.map(mode => {
    const rates = models.map(spec => sceneRate(spec, mode));
    return [mode, rates.some(value => value === null) ? null : Math.min(...rates as number[])];
  })) : undefined;
  const summary = { at: new Date().toISOString(), scenarios, ...(pack ? { pack: true, authors: Object.fromEntries(scenarios.map(name => [name, fixtures[name].authors])) } : {}), score, sceneScore, judge: values.judge,
    models: Object.fromEntries(models.map(spec => [spec, { ...Object.fromEntries(MODES.map(mode => [mode, rate(spec, mode)])), cells: results[spec] }])) };
  const out = resolve(values.out ?? join(mkdtempSync(join(tmpdir(), 'simple-chat-eval-')), 'eval.json'));
  writeFileSync(out, JSON.stringify(summary, null, 2));
  record({ event: 'eval', out, score, sceneScore });
  console.log(JSON.stringify({ event: 'eval', out, score, sceneScore, models: Object.fromEntries(models.map(spec => [spec, Object.fromEntries(MODES.map(mode => [mode, rate(spec, mode)]))])) }));
}
