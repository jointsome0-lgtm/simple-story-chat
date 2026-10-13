import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDir, checklistSchema, judgeSessions } from './action-judge.ts';
import type { Exec } from './action-judge.ts';

// Every session is a paid one, and a sharp scene's report holds its words: a judge that never answers by the schema
// gets two sessions and no more, the loop ends, and a sharp session runs, reports and keeps its temporary files inside
// sealed/, where its owner's page goes too.
test('a session is tried twice at most, and a sharp one runs inside sealed/', async t => {
  const root = mkdtempSync(join(tmpdir(), 'simple-chat-action-judge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const story of ['flight', 'sharp-1']) {
    const dir = bundleDir(root, { story, kind: 'checklist' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'input.json'), '{}');
    writeFileSync(join(dir, 'schema.json'), JSON.stringify(checklistSchema(['e1'])));
  }
  const runs: { story: string; model: string; paths: string[] }[] = [];
  const exec: Exec = async (command, args, options) => {
    const report = args[args.indexOf('-o') + 1];
    runs.push({ story: options.cwd.includes('sharp-1') ? 'sharp-1' : 'flight', model: args[args.indexOf('-m') + 1],
      paths: [options.cwd, report, options.stdout, options.stderr, String(options.env.TMPDIR)] });
    writeFileSync(report, 'A report without its block.');
    return 0;
  };
  const record = await judgeSessions({ root, exec });
  await judgeSessions({ root, exec });
  const sharp = runs.filter(run => run.story === 'sharp-1');
  assert.deepEqual([runs.length, sharp.map(run => run.model), record.sessions['flight/checklist'].state, record.sessions['sharp-1/checklist'].state],
    [4, ['gpt-6-astra', 'gpt-6-sol'], 'failed', 'owner']);
  assert.ok(sharp.every(run => run.paths.every(path => path.startsWith(join(root, 'sealed') + '/'))));
  assert.ok(existsSync(join(root, 'sealed', 'owner', 'sharp-1.checklist.html')));
});
