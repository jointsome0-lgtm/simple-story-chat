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
import { panel, summarize, judgeFileName, council, findings, crossFileName, auditFileName } from './walk-panel.ts';
import type { JudgeFile, CrossFile, CouncilRow, PanelRow, Vote, AuditFile, Contradiction } from './walk-panel.ts';
import { loadGold, saveGold, pathOf, trunk, addNode, gate, renderGold, goldPaths, trunkTasks } from './walk-gold.ts';
import type { Task } from './walk-gold.ts';
import type { TaskFile } from './walk-step.ts';
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
  judge: { type: 'string' }, judges: { type: 'string' }, minutes: { type: 'string' }, cross: { type: 'boolean', default: false },
  depth: { type: 'string' }, attempts: { type: 'string', default: '4' }, branches: { type: 'string', default: '4' }, grow: { type: 'boolean', default: true } }, allowNegative: true });
// --pack names a directory of scenarios kept outside the repository, so the one who improves the prompts never reads
// them. Its scenarios replace the built-in ones; every pack scenario names its authors.
const pack = values.pack ? resolve(values.pack) : undefined;
// `walk` and `walk-judge` take walk scenarios, which have their own files and loader.
const walking = positionals[0] === 'walk' || positionals[0] === 'walk-judge' || positionals[0] === 'seed-audit' || positionals[0] === 'walk-gold' || positionals[0] === 'walk-nodes';
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
} else if (positionals[0] === 'seed-audit') {
  // Every judge reads the seed of a walk for contradictions and ambiguities; the merged list is written per scenario.
  const judges = (values.judges ?? '').split(',').filter(Boolean);
  if (!judges.length) throw new Error('Use: eval seed-audit --judges <host>:<id>,... [--scenarios a,b] [--pack directory] [--out directory]');
  const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), 'simple-chat-seed-audit-')));
  for (const scenario of scenarios) {
    const directory = join(out, scenario);
    await Promise.all(judges.map(judge => probe('walk-judge.ts', ['--audit-seed', scenario, '--label', judge, '--out', directory, ...packArgs], modelEnv(judge), judge, { scenario, mode: 'seed-audit' })));
    const issues = judges.flatMap(judge => { try { return (JSON.parse(readFileSync(join(directory, auditFileName(judge)), 'utf8')) as AuditFile).issues.map(issue => ({ judge, ...issue })); } catch { return []; } });
    writeFileSync(join(directory, 'issues.json'), JSON.stringify({ scenario, judges, issues }, null, 2));
    console.log(JSON.stringify({ event: 'seed_audit', scenario, out: directory, issues: issues.length, contradictions: issues.filter(issue => issue.kind === 'contradiction').length,
      byJudge: Object.fromEntries(judges.map(judge => [judge, issues.filter(issue => issue.judge === judge).length])) }));
  }
} else if (positionals[0] === 'walk-gold') {
  // The gold tree grows one trunk node at a time: the writer continues the accepted prefix with the walk's next step,
  // the council reads the new scene, and the gate is stricter than the eval's: at most one dissenter in the first
  // round, nothing confirmed and nothing disputed in the second. A rejected scene is kept with its findings and the
  // writer tries again, every second attempt as a repair of the last rejected text. The tree is saved after every node.
  const judges = (values.judges ?? '').split(',').filter(Boolean);
  const minutes = values.minutes ?? '60';
  const attempts = Number(values.attempts);
  if (!values.model || judges.length < 2 || new Set(judges).size !== judges.length || !/^\d{1,3}$/.test(minutes) || !Number.isInteger(attempts) || attempts < 1 || attempts > 8
      || (values.depth !== undefined && !/^\d{1,2}$/.test(values.depth))) throw new Error('Use: eval walk-gold --model <host>:<id> --judges <host>:<id>,... [--scenarios a] [--pack directory] [--depth n] [--attempts 1..8] [--minutes 1..180] [--out directory]');
  const writer = values.model;
  const out = resolve(values.out ?? mkdtempSync(join(tmpdir(), 'simple-chat-gold-')));
  record({ event: 'run_started', models: [writer], scenarios, judges, gold: true });
  const read = <T,>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; } };
  const result: Record<string, { nodes: number; trunk: number; steps: number; attempts: number; rejected: number; stopped?: string }> = {};
  for (const scenario of scenarios) {
    const walk = walks[scenario];
    const paths = goldPaths(root, scenario, pack);
    const tree = loadGold(paths.tree, scenario, walk.seed);
    const target = Math.min(walk.steps.length, values.depth === undefined ? walk.steps.length : Number(values.depth));
    const save = () => { saveGold(paths.tree, tree); writeFileSync(paths.story, renderGold(tree, walk)); };
    let used = 0;
    let stopped: string | undefined;
    // Every trunk node is preceded by the seed or the trunk node before it; a rerun continues where the last one stopped.
    for (let chain = trunk(tree, walk.steps); chain.length < target && !stopped; chain = trunk(tree, walk.steps)) {
      const parent = chain.at(-1) ?? null;
      const depth = chain.length + 1;
      const step = walk.steps[chain.length];
      const prefix = pathOf(tree, parent).map(({ id: _id, ...s }) => s);
      let repair: TaskFile['repair'];
      let accepted = false;
      for (let attempt = 1; attempt <= attempts && !accepted; attempt++) {
        used++;
        const directory = join(out, scenario, `depth-${depth}`, `attempt-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
        mkdirSync(directory, { recursive: true });
        // Odd attempts write afresh, even ones repair the last rejected text with the findings that stood against it.
        const task: TaskFile = { prefix, step, ...(attempt % 2 === 0 && repair ? { repair } : {}) };
        writeFileSync(join(directory, 'task.json'), JSON.stringify(task, null, 2));
        const written = await probe('walk-step.ts', ['--scenario', scenario, '--task', join(directory, 'task.json'), '--out', directory, '--minutes', minutes, ...packArgs], modelEnv(writer), writer, { scenario, mode: 'gold-write' });
        const report = read<WalkReport>(join(directory, 'report.json'));
        const scene = report?.steps.find(s => s.turn === depth);
        if (!scene || written.status !== 0) { stopped = written.code || report?.error || 'probe_failed'; record({ event: 'gold_stopped', scenario, depth, attempt, code: stopped }); break; }
        // The council on the new scene alone: the prefix is gold already.
        const files: Record<string, JudgeFile | null> = {};
        await Promise.all(judges.map(async judgeSpec => {
          await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes, '--only', String(depth)], modelEnv(judgeSpec), writer, { scenario, mode: 'gold-judge', judge: judgeSpec });
          files[judgeSpec] = read<JudgeFile>(join(directory, judgeFileName(judgeSpec)));
        }));
        const byJudge = Object.fromEntries(judges.map(judge => [judge, files[judge]?.verdicts ?? []]));
        const listed = findings(byJudge).filter(f => f.turn === depth);
        const checks: Record<string, CrossFile | null> = {};
        if (listed.length) await Promise.all(judges.map(async judgeSpec => {
          await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes, '--cross', '--only', String(depth)], modelEnv(judgeSpec), writer, { scenario, mode: 'gold-cross', judge: judgeSpec });
          checks[judgeSpec] = read<CrossFile>(join(directory, crossFileName(judgeSpec)));
        }));
        const votes = panel(depth, byJudge)[depth - 1].votes;
        const row = council(depth, byJudge, Object.fromEntries(judges.map(judge => [judge, checks[judge]?.checks ?? []])))[depth - 1];
        // A finding the council confirmed or could not settle stands against the text; a refuted one is forgotten.
        const standing: (Contradiction & { by: string })[] = listed.filter(f => {
          const cast = Object.values(checks).flatMap(c => c?.checks ?? []).filter(c => c.turn === depth && c.finding === f.number);
          return cast.filter(c => c.confirmed).length >= cast.filter(c => !c.confirmed).length;
        }).map(({ turn: _turn, number: _number, ...f }) => f);
        accepted = gate(votes, row);
        const dissent = Object.values(votes).filter(v => v === 'inconsistent').length;
        record({ event: 'gold_attempt', scenario, depth, attempt, repair: !!task.repair, accepted, verdict: row.verdict, dissent, findings: row.findings, confirmed: row.confirmed, disputed: row.disputed, truncated: scene.truncated });
        console.log(JSON.stringify({ event: 'gold_attempt', scenario, depth, attempt, repair: !!task.repair, accepted, verdict: row.verdict, dissent, findings: row.findings, confirmed: row.confirmed, disputed: row.disputed }));
        if (accepted) {
          const id = addNode(tree, { parent, depth, step, input: scene.input, text: scene.text, author: writer, attempts: attempt,
            approved: { at: new Date().toISOString(), judges: judges.filter(judge => votes[judge] !== 'error'), dissent }, read: false });
          save(); record({ event: 'gold_node', scenario, depth, id, attempts: attempt });
        } else {
          tree.rejected.push({ parent, step, text: scene.text, author: writer, at: new Date().toISOString(), findings: standing });
          repair = { text: scene.text, findings: standing };
          save();
        }
      }
      if (!accepted && !stopped) { stopped = 'unaccepted'; record({ event: 'gold_stopped', scenario, depth, attempt: attempts, code: stopped }); }
    }
    const chain = trunk(tree, walk.steps);
    result[scenario] = { nodes: Object.keys(tree.nodes).length, trunk: chain.length, steps: walk.steps.length, attempts: used, rejected: tree.rejected.length, ...(stopped ? { stopped } : {}) };
    console.log(JSON.stringify({ event: 'gold', scenario, tree: paths.tree, ...result[scenario] }));
  }
  writeFileSync(join(out, 'gold-run.json'), JSON.stringify({ at: new Date().toISOString(), writer, judges, result }, null, 2));
  record({ event: 'gold_run', out, result });
} else if (positionals[0] === 'walk-nodes') {
  // The eval over the gold tree: every model continues from the seed and from every trunk node with the trunk's next
  // step, and from up to --branches branch nodes chosen at random, each time through its own memory compaction of the
  // prefix, as the bot would; the council reads each new scene against the gold prefix. A scene that passes the gold
  // gate joins the tree as a branch, whoever wrote it, unless --no-grow. The number is the share of consistent scenes
  // among the decided ones, for the worst model, and every scene carries the depth it was written at.
  const models = (values.models ?? '').split(',').filter(Boolean);
  const judges = (values.judges ?? '').split(',').filter(Boolean);
  const minutes = values.minutes ?? '60';
  const branches = Number(values.branches);
  if (!models.length || judges.length < 2 || new Set(judges).size !== judges.length || !/^\d{1,3}$/.test(minutes) || !Number.isInteger(branches) || branches < 0 || branches > 40) throw new Error('Use: eval walk-nodes --models <host>:<id>,... --judges <host>:<id>,... [--scenarios a] [--pack directory] [--branches 0..40] [--no-grow] [--minutes 1..180] [--out file]');
  const out = resolve(values.out ?? join(mkdtempSync(join(tmpdir(), 'simple-chat-nodes-')), 'walk-nodes.json'));
  const work = join(out, '..', 'walk-nodes-runs');
  record({ event: 'run_started', models, scenarios, judges, nodes: true });
  const read = <T,>(file: string): T | null => { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; } };
  type NodeRow = { parent: string | null; depth: number; kind: 'continue' | 'intervention'; verdict: PanelRow['verdict']; dissent: number; findings: number; confirmed: number; disputed: number;
    accepted: boolean; added?: string; truncated: boolean; error?: string; directory: string };
  const results: Record<string, Record<string, { rows: NodeRow[]; consistent: number; split: number; decided: number; byDepth: Record<number, PanelRow['verdict']> }>> = {};
  for (const scenario of scenarios) {
    const walk = walks[scenario];
    const paths = goldPaths(root, scenario, pack);
    const tree = loadGold(paths.tree, scenario, walk.seed);
    // The tasks are fixed before any model writes, so that every model gets the same prefixes; the branch nodes
    // are drawn once and named in the report.
    const chain = trunk(tree, walk.steps);
    const pool = Object.keys(tree.nodes).filter(id => !chain.includes(id) && tree.nodes[id].depth < walk.steps.length);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const tasks: Task[] = [...trunkTasks(tree, walk.steps), ...pool.slice(0, branches).map(id => ({ parent: id, step: walk.steps[tree.nodes[id].depth] }))];
    if (!tasks.length) throw new Error('No gold tree to continue from; grow one with eval walk-gold');
    const prefixes = tasks.map(task => pathOf(tree, task.parent).map(({ id: _id, ...s }) => s));
    record({ event: 'nodes_tasks', scenario, tasks: tasks.length, trunk: chain.length, branches: Math.min(branches, pool.length) });
    // Models in parallel, each over its tasks in order of depth, so that a task reuses the memory the model built over
    // a shorter prefix of the same path: the compaction request is the same, so the reuse changes nothing but the cost.
    await Promise.all(models.map(async spec => {
      const env = modelEnv(spec);
      const rows: NodeRow[] = [];
      const reports: { texts: string[]; directory: string }[] = [];
      const order = tasks.map((_, i) => i).sort((a, b) => prefixes[a].length - prefixes[b].length);
      for (const index of order) {
        const task = tasks[index];
        const prefix = prefixes[index];
        const depth = prefix.length + 1;
        const directory = join(work, scenario, spec.replace(/[^a-z0-9]+/gi, '-'), `task-${String(index + 1).padStart(2, '0')}-depth-${depth}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'task.json'), JSON.stringify({ prefix, step: task.step } satisfies TaskFile, null, 2));
        // The deepest earlier task of this model whose prefix is the start of this one.
        const from = reports.filter(r => r.texts.length <= prefix.length && r.texts.every((text, k) => text === prefix[k].text)).sort((a, b) => b.texts.length - a.texts.length)[0];
        const written = await probe('walk-step.ts', ['--scenario', scenario, '--task', join(directory, 'task.json'), '--out', directory, '--compact', '--minutes', minutes, ...(from ? ['--from', join(from.directory, 'report.json')] : []), ...packArgs], env, spec, { scenario, mode: 'nodes-write' });
        const report = read<WalkReport>(join(directory, 'report.json'));
        const scene = report?.steps.find(s => s.turn === depth);
        const kind = task.step ? 'intervention' as const : 'continue' as const;
        if (!scene || written.status !== 0) { rows.push({ parent: task.parent, depth, kind, verdict: 'unjudged', dissent: 0, findings: 0, confirmed: 0, disputed: 0, accepted: false, truncated: false, error: written.code || report?.error || 'probe_failed', directory }); continue; }
        reports.push({ texts: prefix.map(s => s.text), directory });
        const files: Record<string, JudgeFile | null> = {};
        await Promise.all(judges.map(async judgeSpec => {
          await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes, '--only', String(depth)], modelEnv(judgeSpec), spec, { scenario, mode: 'nodes-judge', judge: judgeSpec });
          files[judgeSpec] = read<JudgeFile>(join(directory, judgeFileName(judgeSpec)));
        }));
        const byJudge = Object.fromEntries(judges.map(judge => [judge, files[judge]?.verdicts ?? []]));
        const listed = findings(byJudge).filter(f => f.turn === depth);
        const checks: Record<string, CrossFile | null> = {};
        if (listed.length) await Promise.all(judges.map(async judgeSpec => {
          await probe('walk-judge.ts', ['--report', directory, '--label', judgeSpec, '--minutes', minutes, '--cross', '--only', String(depth)], modelEnv(judgeSpec), spec, { scenario, mode: 'nodes-cross', judge: judgeSpec });
          checks[judgeSpec] = read<CrossFile>(join(directory, crossFileName(judgeSpec)));
        }));
        const votes = panel(depth, byJudge)[depth - 1].votes;
        const row = council(depth, byJudge, Object.fromEntries(judges.map(judge => [judge, checks[judge]?.checks ?? []])))[depth - 1];
        const dissent = Object.values(votes).filter(v => v === 'inconsistent').length;
        const accepted = gate(votes, row);
        rows.push({ parent: task.parent, depth, kind, verdict: row.verdict, dissent, findings: row.findings, confirmed: row.confirmed, disputed: row.disputed, accepted, truncated: scene.truncated, directory });
        record({ event: 'node_judged', scenario, depth, kind, verdict: row.verdict, dissent, findings: row.findings, confirmed: row.confirmed, disputed: row.disputed, accepted, model: spec });
        console.log(JSON.stringify({ event: 'node_judged', scenario, model: spec, depth, kind, verdict: row.verdict, dissent, findings: row.findings, confirmed: row.confirmed, disputed: row.disputed, accepted }));
      }
      const decided = rows.filter(r => r.verdict !== 'split').length;
      (results[spec] ??= {})[scenario] = { rows, consistent: rows.filter(r => r.verdict === 'consistent').length, split: rows.length - decided, decided,
        byDepth: Object.fromEntries(rows.filter(r => !r.parent || chain.includes(r.parent)).map(r => [r.depth, r.verdict])) };
    }));
    // Accepted scenes join the tree after every model has written, so no model continues from another's new node.
    if (values.grow) {
      let added = 0;
      for (const spec of models) for (const row of results[spec][scenario].rows) {
        if (!row.accepted) continue;
        const report = read<WalkReport>(join(row.directory, 'report.json'));
        const scene = report?.steps.find(s => s.turn === row.depth);
        if (!scene) continue;
        const votes = panel(row.depth, Object.fromEntries(judges.map(judge => [judge, read<JudgeFile>(join(row.directory, judgeFileName(judge)))?.verdicts ?? []])))[row.depth - 1].votes;
        row.added = addNode(tree, { parent: row.parent, depth: row.depth, step: tasks.find(t => t.parent === row.parent)?.step ?? '', input: scene.input, text: scene.text, author: spec, attempts: 1,
          approved: { at: new Date().toISOString(), judges: judges.filter(judge => votes[judge] !== 'error'), dissent: row.dissent }, read: false });
        added++;
      }
      if (added) { saveGold(paths.tree, tree); writeFileSync(paths.story, renderGold(tree, walk)); }
      record({ event: 'gold_grown', scenario, added, nodes: Object.keys(tree.nodes).length });
    }
  }
  const share = (spec: string) => {
    const decided = scenarios.reduce((sum, scenario) => sum + results[spec][scenario].decided, 0);
    return decided ? scenarios.reduce((sum, scenario) => sum + results[spec][scenario].consistent, 0) / decided : 0;
  };
  const score = { nodes: Math.min(...models.map(share)) };
  const summary = { at: new Date().toISOString(), kind: 'walk-nodes', scenarios, ...(pack ? { pack: true } : {}), judges, minutes: Number(minutes), branches, grow: values.grow, score,
    models: Object.fromEntries(models.map(spec => [spec, { nodes: share(spec), cells: results[spec] }])) };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  record({ event: 'eval', out, score });
  console.log(JSON.stringify({ event: 'eval', out, score, models: Object.fromEntries(models.map(spec => [spec, { nodes: share(spec), cells: Object.fromEntries(scenarios.map(scenario => {
    const { consistent, split, decided, rows, byDepth } = results[spec][scenario];
    return [scenario, { consistent, split, decided, tasks: rows.length, added: rows.filter(r => r.added).length, failed: rows.filter(r => r.error).length, byDepth }];
  })) }])) }));
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
  // A split scene is neither for nor against the model, so it leaves the denominator; a scene nobody judged, or that
  // was never written, still counts against it.
  const share = (spec: string, part: (cell: WalkCell) => number) => {
    const decided = scenarios.reduce((sum, scenario) => sum + cells[spec][scenario].total - cells[spec][scenario].split, 0);
    return decided ? scenarios.reduce((sum, scenario) => sum + part(cells[spec][scenario]), 0) / decided : 0;
  };
  const rate = (spec: string) => share(spec, cell => cell.consistent);
  // `votes` is the same number from the first round alone, for a look at what the council changed.
  const voteRate = (spec: string) => share(spec, cell => cell.votes.consistent);
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
