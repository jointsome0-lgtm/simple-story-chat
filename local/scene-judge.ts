// Judges the trap scenes of one memory-probe report: fixed yes/no questions, answered from the author's facts and the
// scene alone. The judge is the configured provider, not the model that wrote the scenes. Prints counts and keys only.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import { safeErrorDetails } from './model-error.ts';
import type { ReplayReport } from './memory-probe.ts';
import { loadScenario } from './scenarios.ts';

// Codes are read from ModelError or Node errors, which use strings.
type Failure = { code?: string };
type Verdict = { key?: unknown; value?: unknown };

process.umask(0o077);
const { values } = parseArgs({ options: { report: { type: 'string' }, mode: { type: 'string' }, pack: { type: 'string' } } });
if (!values.report || (values.mode !== 'plain' && values.mode !== 'sgr')) throw new Error('Use --report directory --mode plain|sgr [--pack directory]');
const directory = resolve(values.report);
const path = join(directory, 'report.json');
const report: ReplayReport = JSON.parse(readFileSync(path, 'utf8'));
const fixture = await loadScenario(report.scenario, values.pack);
const { turns } = fixture;
const result = report.modes[values.mode];
if (!result?.traps) throw new Error('No trap scenes in this report');
const config = { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') };
const judge = createModel(config);
const deadline = AbortSignal.timeout(10 * 60000);
const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
progress({ event: 'started', directory, model: config.model });
try {
  const verdicts: NonNullable<typeof result.verdicts> = [];
  for (const trap of fixture.traps) {
    const scene = result.traps.find(written => written.key === trap.key);
    // A scene that was not written or was cut off fails its questions without a judge call.
    if (!scene || scene.truncated) { verdicts.push(...trap.questions.map(([key, , expected]) => ({ key, expected, actual: null, pass: false }))); continue; }
    const request = {
      system: 'Ты проверяешь одну сцену интерактивной истории. Отвечай на вопросы только по тексту сцены; установленные факты даны для понимания мира, а не как часть сцены. Намерение, попытка или отказ не считаются совершившимся действием. На каждый вопрос ответь yes или no.',
      messages: [{ role: 'user' as const, content: `УСТАНОВЛЕННЫЕ ФАКТЫ:\n${trap.facts ?? fixture.facts}\n\nСООБЩЕНИЕ ИГРОКА:\n${trap.input ?? turns[trap.afterTurn!]}\n\nСЦЕНА:\n${scene.text}\n\nВОПРОСЫ:\n`
        + trap.questions.map(([key, question]) => `${key}: ${question}`).join('\n') }],
      maxOutputTokens: 512, purpose: 'memory' as const,
      outputSchema: { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: {
        type: 'array', minItems: trap.questions.length, maxItems: trap.questions.length, items: { type: 'object', required: ['key', 'value'], additionalProperties: false,
          properties: { key: { type: 'string', enum: trap.questions.map(q => q[0]) }, value: { type: 'string', enum: ['yes', 'no'] } } } } } },
    };
    let reply;
    for (let attempt = 0; ; attempt++) {
      try { reply = await judge.generate(request, { signal: deadline }); break; }
      catch (error) {
        if ((error as Failure).code !== 'rate_limited' || attempt === 9) throw error;
        progress({ event: 'yielded', code: 'rate_limited' });
        await wait(30000, undefined, { signal: deadline });
      }
    }
    const parsed: { answers?: unknown } = JSON.parse(reply.text);
    const answers = Array.isArray(parsed.answers) ? parsed.answers as Verdict[] : [];
    verdicts.push(...trap.questions.map(([key, , expected]) => {
      const actual = answers.find(answer => answer.key === key)?.value;
      return { key, expected, actual, pass: actual === expected };
    }));
    progress({ event: 'trap_judged', mode: values.mode });
  }
  result.verdicts = verdicts;
  writeFileSync(path, JSON.stringify(report, null, 2));
  progress({ event: 'judged', mode: values.mode, passed: verdicts.filter(v => v.pass).length, total: verdicts.length, directory });
} catch (error) {
  const failure = error as Failure;
  const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
  progress({ event: 'deferred_or_failed', code, ...safeErrorDetails(error), directory }); process.exitCode = 1;
}
