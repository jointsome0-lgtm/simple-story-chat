import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMOKE_PROBES, markerCheck, readClientKey, runTexts, servingModel, textStories } from './action-text.ts';
import { fakeGateway } from './action-fakes.ts';
import { markerForms, searchBoundary } from './action-boundary.ts';

const temp = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'simple-chat-action-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A leak of the file beside it: it also holds the control key and Vast's.
test('the key is the client key alone, and no error says what the file holds', t => {
  const file = join(temp(t), 'config.json');
  writeFileSync(file, JSON.stringify({ client_key: ' client-secret ', control_key: 'control-secret', vast_api_key: 'vast-secret' }));
  assert.equal(readClientKey(file), 'client-secret');
  for (const content of ['{"control_key": "control-secret"', JSON.stringify({ control_key: 'control-secret' }), JSON.stringify({ client_key: 'a\nb control-secret' })]) {
    writeFileSync(file, content);
    assert.throws(() => readClientKey(file), (error: Error) => !/secret/.test(error.message));
  }
});

// A leak nobody sees: a search that misses one form of the word passes a run that leaked it. The word is found as it
// is and \u-escaped both ways, outside sealed/, in the temporary directory and in what was printed.
test('the boundary search finds each form of the word outside sealed/', t => {
  const root = temp(t);
  const word = 'Зурбаганец';
  const [, lower, upper] = markerForms(word).map(form => form.toString('utf8'));
  for (const [file, content] of [['sealed/a/story.txt', word], ['plain.txt', `x ${word} x`], ['lower.json', `"${lower}"`], ['upper.json', `"${upper}"`],
    ['tmp/one.txt', word]]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const found = searchBoundary({ root, tempDir: join(root, 'tmp'), word, output: `line ${lower}` });
  assert.deepEqual([found.pass, found.hits.files.sort(), found.hits.temp, found.hits.output], [false, ['lower.json', 'plain.txt', 'upper.json'], 1, true]);
});

// A leak and the text card's minutes: no sharp story is asked for before a marker check has found its made-up name
// nowhere outside sealed/, a check with a hit keeps them waiting, and a finished run asks for nothing again.
test('the sharp stories wait for a marker check without a hit, and a finished run asks for nothing again', async t => {
  const root = temp(t), dir = join(root, 'run');
  const smoke = join(root, 'smoke.jsonl');
  writeFileSync(smoke, SMOKE_PROBES.map(probe => JSON.stringify({ probe, ok: true })).join('\n'));
  const gateway = fakeGateway({ key: 'k', sharp: ['sharp-1', 'marker'], marker: 'Зурбаганец' });
  // A route that writes what it sends to a file of the run's own level, as a leak would.
  const leaking: typeof gateway.fetch = async (url, init) => {
    if (new URL(url).pathname === '/v1/chat/completions') writeFileSync(join(dir, 'leak.txt'), String(init.body));
    return gateway.fetch(url, init);
  };
  let configs = 0;
  const model = (fetch = gateway.fetch) => servingModel({ key: 'k', configRoot: join(root, `config-${++configs}`), fetch });
  const stories = textStories().filter(story => ['flight', 'sharp-1'].includes(story.id));
  const sharpCalls = () => gateway.calls.filter(call => call.story === 'sharp-1').length;

  const leaked = await markerCheck({ root: dir, model: model(leaking), smoke });
  await runTexts({ root: dir, model: model(), smoke, stories });
  assert.deepEqual([leaked.pass, leaked.hitFiles, sharpCalls()], [false, ['leak.txt'], 0]);
  rmSync(join(dir, 'leak.txt'));
  assert.equal((await markerCheck({ root: dir, model: model(), smoke })).pass, true);
  await runTexts({ root: dir, model: model(), smoke, stories });
  assert.ok(sharpCalls() > 0);
  const calls = gateway.calls.length;
  await runTexts({ root: dir, model: model(), smoke, stories });
  assert.equal(gateway.calls.length, calls);
});
