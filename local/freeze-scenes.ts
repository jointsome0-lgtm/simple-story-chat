// Builds examples/frozen/<scenario>.json from scenes written outside the bot: scene-01.md, scene-02.md, ... in one
// directory, one per author turn of the synthetic fixture. The replay probe reads the result like a story-probe run.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Store } from './store.ts';
import { normalizeScene } from './prompt.ts';
import { addSeed, newStory, beginJob, commitTurn, active } from '../lib/library.ts';
import { loadScenario } from './scenarios.ts';

process.umask(0o077);
const { values } = parseArgs({ options: { scenario: { type: 'string' }, scenes: { type: 'string' }, author: { type: 'string' }, pack: { type: 'string' } } });
if (!values.scenario || !values.scenes || !values.author) throw new Error('Use --scenario name --scenes directory --author label [--pack directory]');
const { seed, turns, frozenPath } = await loadScenario(values.scenario, values.pack);
const store = new Store(':memory:');
store.mutate('synthetic', state => newStory(state, addSeed(state, seed).id));
turns.forEach((input, index) => {
  const text = readFileSync(join(resolve(values.scenes!), `scene-${String(index + 1).padStart(2, '0')}.md`), 'utf8');
  store.mutate('synthetic', state => {
    const job = beginJob(state, input, index);
    const { seed: initial, story: current } = active(state);
    const ref = commitTurn(state, job.id, normalizeScene(text, current.nodes[job.head as string]?.time ?? initial.startTime));
    Object.assign(active(state).story.nodes[ref!.nodeId], { probeTurn: index + 1 });
  });
});
const state = store.read('synthetic');
store.close();
mkdirSync(dirname(frozenPath), { recursive: true });
writeFileSync(frozenPath, JSON.stringify({ report: { scenario: values.scenario, model: values.author, provider: 'agent',
  startedAt: new Date().toISOString(), scope: `${turns.length} scenes written outside the bot, no compaction while writing` }, state }, null, 2));
console.log(JSON.stringify({ event: 'frozen', scenario: values.scenario, scenes: turns.length }));
