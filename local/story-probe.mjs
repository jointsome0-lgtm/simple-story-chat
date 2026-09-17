// Explicit, repeatable live test. Reads model config, never the bot database.
import { parseArgs } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { Store } from './store.mjs';
import { loadModelConfig } from './config.mjs';
import { createModel } from './model.mjs';
import { createClaude } from './claude.mjs';
import { generateScene, compactBranch } from './generation.mjs';
import { normalizeScene } from './prompt.mjs';
import { contextStats, requestStamp, CONTINUE } from './context.mjs';
import { addSeed, newStory, beginJob, commitTurn, active, context, history, saveCheckpoint } from '../lib/library.js';

process.umask(0o077);
const { values } = parseArgs({ options: { model: { type: 'string' }, scenario: { type: 'string', default: 'battle' },
  resume: { type: 'string' }, effort: { type: 'string' } } });
if (!['battle', 'chess', 'dance'].includes(values.scenario)) throw new Error('Unknown synthetic scenario');
if (values.effort && !['low', 'medium', 'high'].includes(values.effort)) throw new Error('Unsupported probe effort');
const { seed, turns, recall } = await import(`../examples/${values.scenario}-probe.mjs`);
const directory = values.resume ? resolve(values.resume) : mkdtempSync(join(tmpdir(), `simple-chat-${values.scenario}-`));
if (!basename(directory).startsWith(`simple-chat-${values.scenario}-`)) throw new Error('Resume only a matching synthetic probe directory');
const previous = values.resume ? JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8')) : null;
if (previous && previous.report.scenario !== values.scenario) throw new Error('Scenario mismatch');
const config = { ...loadModelConfig(), dbPath: join(directory, 'synthetic.sqlite') };
config.model = values.model ?? previous?.report.model ?? config.model;
if (previous && (previous.report.model !== config.model || previous.report.provider !== config.provider)) throw new Error('Resume must use the same model and provider');
const provider = values.effort && config.provider === 'claude-code'
  ? createClaude(config, { launch: (command, args, options) => spawn(command, [...args, '--effort', values.effort], options) })
  : createModel(config);
const store = new Store(config.dbPath);
const report = previous?.report ?? { scenario: values.scenario, model: config.model, provider: config.provider, startedAt: new Date().toISOString(),
  scope: `${turns.length} scenes, explicit compaction after scenes 7, 11 and 15, keep four scenes; NOT a 54K/64K stress test`,
  config: { contextTokens: config.contextTokens, maxOutputTokens: config.maxOutputTokens, keepScenes: config.keepScenes }, calls: [], compactions: [] };
const progress = data => console.log(JSON.stringify(data)); // metadata only
const save = () => {
  const state = store.read('synthetic');
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ report, state }, null, 2));
  const { story, branch } = active(state);
  const blocks = [`# Проверка памяти: ${values.scenario}`, `Модель: ${config.model}. ${report.scope}`, '## Сид', seed];
  for (const node of history(story, branch.head)) blocks.push(`## Сцена ${node.probeTurn} · ${node.id}`, `Ввод: ${node.input}`, node.text);
  for (const memory of context(story, branch).memories) blocks.push(`## Инкремент ${memory.id}`, '```json\n' + JSON.stringify(memory, null, 2) + '\n```');
  writeFileSync(join(directory, 'story.md'), blocks.join('\n\n'));
};
if (!previous) store.mutate('synthetic', state => newStory(state, addSeed(state, seed).id));
else {
  const state = store.read('synthetic');
  const { seed: savedSeed } = active(state);
  if (`${savedSeed.title}\n${savedSeed.startTime}\n${savedSeed.text}` !== seed) throw new Error('Synthetic seed changed');
  report.resumes ??= [];
  report.resumes.push({ at: new Date().toISOString(), failedOperation: state.job?.kind ?? 'scene',
    previousError: report.error ?? null, effort: values.effort ?? null });
  delete report.error;
  store.mutate('synthetic', state => { state.job = null; });
}
progress({ event: previous ? 'resumed' : 'started', directory, model: config.model });
async function compactAfter(turn) {
  if (![7, 11, 15].includes(turn) || report.compactions.some(c => c.afterTurn === turn)) return;
  const before = contextStats(store.read('synthetic'), config).request.estimatedTokens;
  const job = store.mutate('synthetic', state => { const j = beginJob(state, CONTINUE, Date.now()); j.kind = 'compact'; return j; });
  const started = Date.now();
  const compacted = await compactBranch({ store, userId: 'synthetic', jobId: job.id, provider, config });
  store.mutate('synthetic', state => { state.job = null; });
  const stats = contextStats(store.read('synthetic'), config);
  const metrics = { event: 'compaction', afterTurn: turn, ms: Date.now() - started,
    beforeEstimatedTokens: before, afterEstimatedTokens: stats.request.estimatedTokens, ...compacted };
  report.compactions.push(metrics); save(); progress(metrics);
}
try {
  await provider.check?.();
  const { story, branch } = active(store.read('synthetic'));
  const lastTurn = Math.max(0, ...history(story, branch.head).map(n => n.probeTurn));
  await compactAfter(lastTurn);
  for (let index = lastTurn; index <= turns.length; index++) {
    const input = index === turns.length ? recall : turns[index];
    const job = store.mutate('synthetic', state => beginJob(state, input, Date.now()));
    const started = Date.now();
    const { result, request } = await generateScene({ store, userId: 'synthetic', jobId: job.id, provider, config });
    store.mutate('synthetic', state => {
      const stamp = requestStamp(request, config.model, state.job.memory, config.provider);
      const { seed: initial, story: current } = active(state);
      const ref = commitTurn(state, job.id, normalizeScene(result.text, current.nodes[job.head]?.time ?? initial.startTime), result.finishReason === 'length');
      const { story, branch } = active(state);
      Object.assign(story.nodes[ref.nodeId], { usage: result.usage, requestContext: stamp, probeTurn: index + 1 });
      saveCheckpoint(state, story, branch, `Сцена ${index + 1}`, 'scene');
    });
    const metrics = { event: 'scene', turn: index + 1, ms: Date.now() - started,
      characters: result.text.length, finishReason: result.finishReason, ...result.usage };
    report.calls.push(metrics); save(); progress(metrics);
    if (result.finishReason === 'length') throw Object.assign(new Error(), { code: 'truncated_scene' });
    await compactAfter(index + 1);
  }
  report.completedAt = new Date().toISOString(); save(); progress({ event: 'complete', directory });
} catch (error) {
  report.error = /^[a-z_]+$/.test(error.code || '') ? error.code : 'probe_failed';
  save(); progress({ event: 'failed', code: report.error, directory }); process.exitCode = 1;
} finally { store.close(); }
