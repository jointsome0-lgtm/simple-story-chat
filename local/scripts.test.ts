// A tool nobody can name is a tool the next session runs from memory. So every file here with a command line of its
// own is reached through `npm run`, and the name and the flags of a run live in package.json, where a doc, a runbook
// and a review can all point at the same text. A script has to run a file that is there, and a probe which builds its
// own configuration is never handed the bot's `.env` by a helpful `--env-file`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scripts: Record<string, string> = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).scripts;
// The file each script runs, as node is handed it: the flags of the script are not part of the path.
const targets = new Map(Object.entries(scripts).flatMap(([name, command]) => {
  const file = /\b(?:local|gpu|lib)\/[\w.-]+\.(?:ts|mjs)\b/.exec(command)?.[0];
  return file ? [[file, name] as const] : [];
}));

// A tool is a file that knows it was run, not imported, by one of the two guards this repository uses. Renting is the
// one outside local/, and the one where a forgotten flag costs money rather than time.
test('every npm script names a file that is there, and every tool with a command line of its own has one', () => {
  for (const [file, name] of targets) assert.ok(existsSync(resolve(file)), `${name} runs ${file}, which does not exist`);
  const tools = readdirSync(resolve('local')).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')
    && /^if \(import\.meta\.main\)|^if \(process\.argv\[1\] === fileURLToPath\(import\.meta\.url\)\)/m.test(readFileSync(resolve('local', name), 'utf8')));
  assert.ok(tools.length >= 8, `only ${tools.length} entry points were recognised; the guards changed`);
  for (const file of [...tools.map(name => `local/${name}`), 'gpu/rent.mjs']) assert.ok(targets.has(file), `${file} has a command line and no npm script`);
});

// Both probes resolve their key from `.env.eval` and load their model configuration from an empty directory, so the
// bot's own model, database and token cannot reach them. An `--env-file=.env` on the script would undo that from
// outside the file, and the probe would go on reporting the model it thought it was given.
test('a probe that builds its own environment is not handed the bot one', () => {
  for (const file of ['local/illustrate-probe.ts', 'local/judge-extract-probe.ts']) {
    const name = targets.get(file);
    assert.ok(name, `${file} has no npm script`);
    assert.ok(!scripts[name]!.includes('--env-file'), `${name} reads an environment file this probe must build itself`);
  }
});
