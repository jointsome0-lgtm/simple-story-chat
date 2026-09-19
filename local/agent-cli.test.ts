import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./agent-cli.ts', import.meta.url));
const SEED = 'Lighthouse\n2026-08-02 20:00\nThe keeper meets a boat.';

// No call here reaches a model: seeds, forks, reads, receipts and a stale act are decided before generation. The run
// starts in an empty directory with no inherited SIMPLE_CHAT_ settings, so no local .env or bot database is read.
function cli(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-agent-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: directory, SIMPLE_CHAT_AGENT_DB_PATH: join(directory, 'agents.sqlite') };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: directory, env, encoding: 'utf8' });
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'one JSON object per call');
    return { response: JSON.parse(lines[0]), code: result.status, stderr: result.stderr };
  };
  return { directory, run };
}

test('the CLI prints one JSON object per call; writers lock the library, readers do not', async t => {
  const { directory, run } = cli(t);
  const unknown = run('read');
  assert.deepEqual(unknown.response, { status: 'failed', reason: 'not_found' });
  const seed = run('create_seed', '--json', JSON.stringify({ requestId: 'seed-1', text: SEED }));
  assert.deepEqual(seed.response, { requestId: 'seed-1', status: 'done', result: { seedId: 's1', title: 'Lighthouse', worldTime: '2026-08-02 20:00' } });
  assert.equal(seed.code, 0);
  assert.deepEqual(run('status', '--json', '{"requestId":"seed-1"}').response, seed.response);
  assert.equal(run('read').response.result.seeds.length, 1);
  assert.equal(run('act', '--json', '{"requestId":"a","storyId":"h9","branchId":"b9","expected":"x"}').response.reason, 'not_found');
  const usage = run('delete');
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Usage/);

  // Another writer holds the lock: a writer is refused, a reader still answers.
  const holder = spawn('flock', [join(directory, 'agents.sqlite.lock'), 'sleep', '3'], { stdio: 'ignore' });
  holder.unref();
  await new Promise(resolve => setTimeout(resolve, 300));
  const locked = run('create_seed', '--json', JSON.stringify({ requestId: 'seed-2', text: SEED }));
  assert.deepEqual(locked.response, { status: 'busy', reason: 'library_locked' });
  assert.equal(locked.code, 1);
  assert.equal(run('status', '--json', '{"requestId":"seed-1"}').response.status, 'done');
});
