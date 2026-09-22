// Judges every scene of one walk report: the judge sees the seed, every earlier step and the new scene, and lists the
// contradictions it finds. With --cross it runs the council's second round instead: every contradiction listed by any
// judge of the panel is put to this judge to confirm or refute by the text. The judge is the configured provider, not
// the model that wrote the scenes. Several judges write separate files next to the report; local/eval.ts combines
// them. Prints counts and codes only.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import type { ModelRequest } from './model.ts';
import { safeErrorDetails } from './model-error.ts';
import type { WalkReport } from './walk-probe.ts';
import { judgeRequest, parseVerdict, judgeFileName, findings, crossRequest, parseCross, crossFileName, seedAuditRequest, parseIssues, auditFileName } from './walk-panel.ts';
import type { JudgeFile, CrossFile, Verdict, AuditFile } from './walk-panel.ts';
import { loadWalk } from './scenarios.ts';

// Codes are read from ModelError or Node errors, which use strings.
type Failure = { code?: string };

process.umask(0o077);
const { values } = parseArgs({ options: { report: { type: 'string' }, label: { type: 'string' }, minutes: { type: 'string', default: '90' }, cross: { type: 'boolean', default: false },
  'audit-seed': { type: 'string' }, pack: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' } } });
// --only judges one scene of the report: the new scene of a gold attempt, whose prefix the council accepted already.
const only = values.only === undefined ? undefined : Number(values.only);
if (only !== undefined && (!Number.isInteger(only) || only < 1)) throw new Error('--only takes a scene number');
const minutes = Number(values.minutes);
if ((!values.report && !values['audit-seed']) || !values.label || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('Use --report directory --label <host>:<id> [--minutes 1..180] [--cross] [--only scene], or --audit-seed <walk> --label <host>:<id> --out directory [--pack directory]');
// With --audit-seed there is no report: the seed of the named walk is read instead, and the file goes to --out.
const directory = resolve(values.report ?? values.out ?? '.');
const report: WalkReport = values.report ? JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')) : { scenario: '', model: '', provider: '', startedAt: '', seed: '', authors: [], steps: [], compactions: [] };
const config = { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') };
const judge = createModel(config);
const deadline = AbortSignal.timeout(minutes * 60000);
const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
// A busy upstream is waited out; any other failure ends the run.
async function generate(request: ModelRequest) {
  for (let attempt = 0; ; attempt++) {
    try { return await judge.generate(request, { signal: deadline }); }
    catch (error) {
      if ((error as Failure).code !== 'rate_limited' || attempt === 9) throw error;
      progress({ event: 'yielded', code: 'rate_limited' });
      await wait(30000, undefined, { signal: deadline });
    }
  }
}
const read = <T,>(path: string, empty: T): T => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : empty;
const finish = (code: string, file: { error?: string }, save: () => void) => {
  file.error = code; save();
  progress({ event: 'deferred_or_failed', code, directory }); process.exitCode = 1;
};
const codeOf = (error: unknown) => deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test((error as Failure).code ?? '') ? (error as Failure).code! : 'probe_failed';

if (values['audit-seed']) {
  // The seed audit: contradictions and ambiguities of the seed itself, before it grows a gold tree.
  const fixture = await loadWalk(values['audit-seed'], values.pack);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, auditFileName(values.label));
  const file: AuditFile = { judge: values.label, model: config.model, at: new Date().toISOString(), issues: [] };
  const save = () => writeFileSync(path, JSON.stringify(file, null, 2));
  progress({ event: 'started', directory, model: config.model, audit: true });
  try {
    await judge.check?.({ signal: deadline });
    const reply = await generate(seedAuditRequest(fixture.seed));
    file.issues = parseIssues(reply.text); save();
    progress({ event: 'seed_audited', issues: file.issues.length, contradictions: file.issues.filter(i => i.kind === 'contradiction').length, truncated: reply.finishReason !== 'stop', directory });
  } catch (error) { finish(codeOf(error), file, save); progress({ event: 'failure_details', ...safeErrorDetails(error) }); }
} else if (!values.cross) {
  const path = join(directory, judgeFileName(values.label));
  // A rerun keeps the verdicts already given and asks again only where the judge itself had failed.
  const file = read<JudgeFile>(path, { judge: values.label, model: config.model, at: new Date().toISOString(), verdicts: [] });
  file.model = config.model; delete file.error; delete file.completedAt;
  const save = () => writeFileSync(path, JSON.stringify(file, null, 2));
  const count = (vote: Verdict['verdict']) => file.verdicts.filter(v => v.verdict === vote).length;
  progress({ event: 'started', directory, model: config.model, scenes: report.steps.length });
  try {
    await judge.check?.({ signal: deadline });
    for (let index = 0; index < report.steps.length; index++) {
      const { turn } = report.steps[index];
      const given = file.verdicts.find(v => v.turn === turn);
      if ((given && !given.code) || (only !== undefined && turn !== only)) continue;
      const reply = await generate(judgeRequest(report.seed, report.steps, index));
      let verdict: Verdict;
      try { verdict = { turn, ...parseVerdict(reply.text) }; }
      catch (error) {
        // A reply that is not the JSON asked for is the judge's own failure: an abstention that carries its code.
        verdict = { turn, verdict: 'error', contradictions: [], code: (error as Failure).code === 'invalid_verdict' ? 'invalid_verdict' : 'unparsed_verdict' };
      }
      file.verdicts = [...file.verdicts.filter(v => v.turn !== turn), verdict].sort((a, b) => a.turn - b.turn);
      save(); progress({ event: 'scene_judged', turn, verdict: verdict.verdict, contradictions: verdict.contradictions.length,
        kinds: verdict.contradictions.map(c => c.kind), judgeCode: verdict.code, truncated: reply.finishReason !== 'stop' });
    }
    file.completedAt = new Date().toISOString(); save();
    progress({ event: 'judged', passed: count('consistent'), total: only === undefined ? report.steps.length : 1, inconsistent: count('inconsistent'), errors: count('error'), directory });
  } catch (error) { finish(codeOf(error), file, save); progress({ event: 'failure_details', ...safeErrorDetails(error) }); }
} else {
  // The second round reads every judge's first-round file in the directory, this judge's own included.
  const byJudge: Record<string, Verdict[]> = {};
  for (const name of readdirSync(directory).filter(name => /^walk-judge-.*\.json$/.test(name)).sort()) {
    const other = read<JudgeFile>(join(directory, name), { judge: name, model: '', at: '', verdicts: [] });
    byJudge[other.judge] = other.verdicts;
  }
  const found = findings(byJudge);
  const path = join(directory, crossFileName(values.label));
  // A rerun keeps the scenes already checked; a scene whose checks failed to parse is asked again.
  const file = read<CrossFile>(path, { judge: values.label, model: config.model, at: new Date().toISOString(), checks: [] });
  file.model = config.model; delete file.error; delete file.completedAt;
  const save = () => writeFileSync(path, JSON.stringify(file, null, 2));
  const turns = [...new Set(found.map(f => f.turn))].filter(turn => only === undefined || turn === only);
  progress({ event: 'started', directory, model: config.model, scenes: report.steps.length, findings: found.length, judges: Object.keys(byJudge).length, cross: true });
  try {
    if (turns.length) await judge.check?.({ signal: deadline });
    let failed = 0;
    for (const turn of turns) {
      if (file.checks.some(c => c.turn === turn)) continue;
      const index = report.steps.findIndex(step => step.turn === turn);
      const mine = found.filter(f => f.turn === turn);
      if (index < 0) continue;
      const reply = await generate(crossRequest(report.seed, report.steps, index, mine));
      let checks;
      try { checks = parseCross(reply.text, mine.length); }
      catch { failed++; progress({ event: 'scene_crossed', turn, findings: mine.length, judgeCode: 'invalid_cross', truncated: reply.finishReason !== 'stop' }); continue; }
      file.checks.push(...checks.map(c => ({ turn, ...c })));
      save(); progress({ event: 'scene_crossed', turn, findings: mine.length, confirmed: checks.filter(c => c.confirmed).length, truncated: reply.finishReason !== 'stop' });
    }
    file.completedAt = new Date().toISOString(); save();
    progress({ event: 'crossed', scenes: turns.length, findings: found.length, confirmed: file.checks.filter(c => c.confirmed).length, failed, directory });
  } catch (error) { finish(codeOf(error), file, save); progress({ event: 'failure_details', ...safeErrorDetails(error) }); }
}
