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
import type { ScenarioPack } from './scenarios.ts';

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
// The scene after a trap's scene (`then` in examples/scene-traps.ts) is judged against the scene before it.
const SYSTEM = 'Ты проверяешь одну сцену интерактивной истории. Отвечай на вопросы только по тексту сцены; установленные факты даны для понимания мира, а не как часть сцены. Намерение, попытка или отказ не считаются совершившимся действием. На каждый вопрос ответь yes или no.';
const THEN_SYSTEM = 'Ты проверяешь новую сцену интерактивной истории, написанную сразу после предыдущей. Отвечай на вопросы по тексту новой сцены, сверяя её с предыдущей; установленные факты даны для понимания мира, а не как часть сцены. Намерение, попытка или отказ не считаются совершившимся действием. На каждый вопрос ответь yes или no.';
type Questions = ScenarioPack['traps'][number]['questions'];
try {
  const verdicts: NonNullable<typeof result.verdicts> = [];
  const failed = (questions: Questions) => verdicts.push(...questions.map(([key, , expected]) => ({ key, expected, actual: null, pass: false })));
  const ask = async (system: string, content: string, questions: Questions) => {
    const request = {
      system, messages: [{ role: 'user' as const, content: content + questions.map(([key, question]) => `${key}: ${question}`).join('\n') }],
      maxOutputTokens: 512, purpose: 'memory' as const,
      outputSchema: { type: 'object', required: ['answers'], additionalProperties: false, properties: { answers: {
        type: 'array', minItems: questions.length, maxItems: questions.length, items: { type: 'object', required: ['key', 'value'], additionalProperties: false,
          properties: { key: { type: 'string', enum: questions.map(q => q[0]) }, value: { type: 'string', enum: ['yes', 'no'] } } } } } },
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
    verdicts.push(...questions.map(([key, , expected]) => {
      const actual = answers.find(answer => answer.key === key)?.value;
      return { key, expected, actual, pass: actual === expected };
    }));
    progress({ event: 'trap_judged', mode: values.mode });
  };
  for (const trap of fixture.traps) {
    const scene = result.traps.find(written => written.key === trap.key);
    const facts = trap.facts ?? fixture.facts;
    const input = trap.input ?? turns[trap.afterTurn!];
    // A scene that was not written or was cut off fails its questions without a judge call, and those of the scene
    // written over it with them.
    if (!scene || scene.truncated) { failed([...trap.questions, ...(trap.then?.questions ?? [])]); continue; }
    await ask(SYSTEM, `УСТАНОВЛЕННЫЕ ФАКТЫ:\n${facts}\n\nСООБЩЕНИЕ ИГРОКА:\n${input}\n\nСЦЕНА:\n${scene.text}\n\nВОПРОСЫ:\n`, trap.questions);
    if (!trap.then) continue;
    // The scene written over it fails its own questions when it is missing, failed or cut off, and so does a judge call
    // that fails on it, so that the verdicts of every other trap do not depend on it.
    if (!scene.then || 'error' in scene.then || scene.then.truncated) { failed(trap.then.questions); continue; }
    try {
      await ask(THEN_SYSTEM, `УСТАНОВЛЕННЫЕ ФАКТЫ:\n${facts}\n\nПРЕДЫДУЩЕЕ СООБЩЕНИЕ ИГРОКА:\n${input}\n\nПРЕДЫДУЩАЯ СЦЕНА:\n${scene.text}\n\n`
        + `СООБЩЕНИЕ ИГРОКА:\n${trap.then.input}\n\nНОВАЯ СЦЕНА:\n${scene.then.text}\n\nВОПРОСЫ:\n`, trap.then.questions);
    } catch (error) {
      if (deadline.aborted) throw error;
      failed(trap.then.questions);
      const code = (error as Failure).code;
      progress({ event: 'trap_judged', mode: values.mode, then: true, code: /^[a-z_]{1,40}$/.test(code ?? '') ? code : 'probe_failed', ...safeErrorDetails(error) });
    }
  }
  result.verdicts = verdicts;
  writeFileSync(path, JSON.stringify(report, null, 2));
  // `passed` and `total` stay the legacy traps' counts, the ones the event log has always held; sets o2 and open are
  // counted beside.
  const keysOf = (set: string) => new Set(fixture.traps.filter(trap => trap.set === set)
    .flatMap(trap => [...trap.questions, ...(trap.then?.questions ?? [])].map(([key]) => key)));
  const [o2, open] = [keysOf('o2'), keysOf('open')];
  const count = (keys: Set<string>, name: string) => {
    const own = verdicts.filter(v => keys.has(v.key));
    return own.length ? { [`${name}Passed`]: own.filter(v => v.pass).length, [`${name}Total`]: own.length } : {};
  };
  const legacy = verdicts.filter(v => !o2.has(v.key) && !open.has(v.key));
  progress({ event: 'judged', mode: values.mode, passed: legacy.filter(v => v.pass).length, total: legacy.length, ...count(o2, 'o2'), ...count(open, 'open'), directory });
} catch (error) {
  const failure = error as Failure;
  const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
  progress({ event: 'deferred_or_failed', code, ...safeErrorDetails(error), directory }); process.exitCode = 1;
}
