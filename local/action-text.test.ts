import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameRequest } from './illustrate.ts';
import { FACINGS, VARIANT_CHANGES, VARIANT_TOKENS, armsOut, fitsSchema, markerCheck, readClientKey, rolesUnique, runTexts,
  requestCounts, servingModel, smokeRecord, storyDir, textStories, variantRequest } from './action-text.ts';
import type { StoryText, TextsRecord } from './action-text.ts';
import { fakeGateway } from './action-fakes.ts';
import { markerForms, searchBoundary } from './action-boundary.ts';

const temp = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), 'simple-chat-action-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const sheet = [{ name: 'Бранд', look: 'A tall man', outfit: 'wearing leather' }];
const excerpt = { system: 'system', messages: [{ role: 'user' as const, content: 'СИД' }] };
const rows = (list: [string, () => void][]) => {
  for (const [promise, check] of list) {
    try { check(); } catch (error) { assert.fail(`${promise}: ${(error as Error).message}`); }
  }
};

// The variant is the bot's frame request with the doc's changes and no others (docs/action-experiment.md#variant).
test('the variant is the bot\'s instruction with its nine replacements, and its schema adds role and facing', () => {
  const bot = frameRequest(excerpt, sheet);
  const variant = variantRequest(excerpt, sheet);
  const text = variant.messages.at(-1)!.content;
  type Items = { properties: Record<string, { enum?: string[] }>; required: string[] };
  const people = (variant.outputSchema as { properties: { people: { maxItems: number; items: Items } } }).properties.people;
  rows([
    ['every replacement found its text once, and undoing them gives the bot\'s text back', () => {
      const undone = [...VARIANT_CHANGES].reverse().reduce((value, change) => {
        const at = value.indexOf(change.to);
        assert.ok(at >= 0 && value.indexOf(change.to, at + 1) < 0);
        return value.slice(0, at) + change.from + value.slice(at + change.to.length);
      }, text);
      assert.equal(undone, bot.messages.at(-1)!.content);
    }],
    ['the rest of the request is the bot\'s', () => {
      assert.equal(variant.system, bot.system);
      assert.deepEqual(variant.messages.slice(0, -1), bot.messages.slice(0, -1));
    }],
    ['up to six people, role and facing required right after who, facing an enum with other', () => {
      assert.equal(people.maxItems, 6);
      assert.deepEqual(Object.keys(people.items.properties).slice(0, 3), ['who', 'role', 'facing']);
      assert.deepEqual(people.items.required, ['who', 'role', 'facing', 'look', 'clothes', 'state', 'action']);
      assert.deepEqual(people.items.properties.facing.enum, [...FACINGS]);
      assert.ok(FACINGS.includes('other'));
    }],
    ['twice the bot\'s output limit, and the bot\'s own request unchanged', () => {
      assert.equal(variant.maxOutputTokens, VARIANT_TOKENS);
      assert.equal(VARIANT_TOKENS, 2 * bot.maxOutputTokens);
      assert.equal((bot.outputSchema as { properties: { people: { maxItems: number } } }).properties.people.maxItems, 4);
    }],
    ['a role of two to eight words, advice and not checked', () => assert.match(text, /role — поле каждой записи people: 2-8 английских слов/)],
  ]);
});

// `schema` is decided on the raw reply against the request's own schema (docs/action-experiment.md#text-run).
test('a reply breaks its schema by a missing field, an extra one, a value outside an enum, too many people or a shared role', () => {
  const schema = variantRequest(excerpt, sheet).outputSchema as Parameters<typeof fitsSchema>[1];
  const person = (at: number) => ({ who: `p${at}`, role: `the role ${at}`, facing: 'viewer', look: '', clothes: '', state: '', action: 'stands' });
  const frame = (people: object[]) => ({ moment: '', shot: '', setting: '', objects: '', props: '', light: '', people });
  rows([
    ['six people with every field fit', () => assert.equal(fitsSchema(frame([0, 1, 2, 3, 4, 5].map(person)), schema), true)],
    ['seven do not', () => assert.equal(fitsSchema(frame([0, 1, 2, 3, 4, 5, 6].map(person)), schema), false)],
    ['a missing facing does not', () => {
      const { facing: _, ...rest } = person(0);
      assert.equal(fitsSchema(frame([rest]), schema), false);
    }],
    ['a facing outside the enum does not', () => assert.equal(fitsSchema(frame([{ ...person(0), facing: 'left' }]), schema), false)],
    ['a field the schema does not have does not', () => assert.equal(fitsSchema({ ...frame([person(0)]), mood: 'calm' }, schema), false)],
    ['a number where a string belongs does not', () => assert.equal(fitsSchema(frame([{ ...person(0), role: 3 }]), schema), false)],
    ['the bot\'s frame holds four people, not five', () => {
      const bot = frameRequest(excerpt, sheet).outputSchema as Parameters<typeof fitsSchema>[1];
      const plain = (at: number) => ({ who: `p${at}`, look: '', clothes: '', state: '', action: '' });
      assert.equal(fitsSchema(frame([0, 1, 2, 3].map(plain)), bot), true);
      assert.equal(fitsSchema(frame([0, 1, 2, 3, 4].map(plain)), bot), false);
    }],
    ['two roles equal after trim and case are one role twice', () => {
      assert.equal(rolesUnique({ people: [{ role: 'the guard' }, { role: ' The Guard ' }] }), false);
      assert.equal(rolesUnique({ people: [{ role: 'the left guard' }, { role: 'the right guard' }] }), true);
    }],
  ]);
});

test('the key is the client key alone, and no error says what the file holds', t => {
  const dir = temp(t);
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ client_key: ' client-secret ', control_key: 'control-secret', vast_api_key: 'vast-secret' }));
  assert.equal(readClientKey(file), 'client-secret');
  for (const content of ['{"control_key": "control-secret"', JSON.stringify({ control_key: 'control-secret' }), JSON.stringify({ client_key: 'a\nb control-secret' })]) {
    writeFileSync(file, content);
    assert.throws(() => readClientKey(file), (error: Error) => !/secret/.test(error.message));
  }
  assert.throws(() => readClientKey(join(dir, 'missing.json')), /Cannot read/);
});

test('route A starts only on a smoke record where every probe passed, and keeps its versions as names and digits', t => {
  const dir = temp(t);
  const file = join(dir, 'smoke.jsonl');
  const probes = ['state', 'completion', 'fields', 'reasoning', 'finish', 'refusal', 'abort', 'schemas', 'counts'];
  const line = (probe: string, ok = true, extra = {}) => JSON.stringify({ probe, ok, ...extra });
  writeFileSync(file, probes.map(probe => line(probe, true, probe === 'state' ? { versions: { vllm: '0.11.2', note: 'free text here' } } : {})).join('\n'));
  assert.deepEqual(smokeRecord(file), { probes: 9, versions: { vllm: '0.11.2' } });
  writeFileSync(file, probes.map(probe => line(probe, probe !== 'counts')).join('\n'));
  assert.throws(() => smokeRecord(file), /counts/);
  writeFileSync(file, probes.slice(1).map(probe => line(probe)).join('\n'));
  assert.throws(() => smokeRecord(file), /state/);
});

// The whole text run against the fake gateway behind the real adapter: the outcomes, what each takes out, the resume
// and the refusal of other pins, the counts apart from the main calls, and the marker check. Seven stories of the
// eighteen, one per outcome: each story is a database of its own, and its writes wait for the disk.
test('the text run decides every reply by the doc\'s rules, takes out what each failure needs, and asks nothing twice', async t => {
  const root = temp(t);
  const marker = 'Зурбаганец';
  const stories = textStories().filter(story => ['flight', 'demon', 'beach', 'giants', 'jellyfish', 'sharp-1', 'sharp-2'].includes(story.id));
  const faults = { flight: { frame: 'retry' as const }, demon: { frame: 'truncated' as const }, beach: { variant: 'duplicate_roles' as const },
    giants: { variant: 'unparsed' as const }, jellyfish: { sheet: 'empty_sheet' as const }, 'sharp-2': { scene: 'error' as const } };
  const gateway = fakeGateway({ key: 'test-key', sharp: ['sharp-1', 'sharp-2', 'marker'], marker, faults });
  const smoke = join(root, 'smoke.jsonl');
  writeFileSync(smoke, ['state', 'completion', 'fields', 'reasoning', 'finish', 'refusal', 'abort', 'schemas', 'counts'].map(probe => JSON.stringify({ probe, ok: true })).join('\n'));
  const model = (dir: string) => servingModel({ key: 'test-key', configRoot: join(root, dir), fetch: gateway.fetch });
  const dir = join(root, 'run');

  // Before the marker check the clean stories run and the sharp ones wait, unasked.
  const withoutMarker = await runTexts({ root: dir, model: model('config-1'), smoke, stories });
  assert.deepEqual(withoutMarker.skipped, { 'sharp-1': 'marker_missing', 'sharp-2': 'marker_missing' });
  assert.ok(gateway.calls.every(call => !call.story.startsWith('sharp-') && call.story !== 'unknown'));
  const check = await markerCheck({ root: dir, model: model('config-2'), smoke });
  assert.deepEqual([check.pass, check.reached, check.hits], [true, true, { files: 0, temp: 0, output: false }]);
  assert.ok(existsSync(join(storyDir(dir, 'marker'), 'story.sqlite')) && storyDir(dir, 'marker').includes('/sealed/'));

  // After it the rerun asks only for what has no outcome yet: the sharp stories.
  const calls = gateway.calls.length;
  const record: TextsRecord = await runTexts({ root: dir, model: model('config-3'), smoke, stories });
  assert.ok(gateway.calls.length > calls && gateway.calls.slice(calls).every(call => call.story.startsWith('sharp-')));
  const text = (id: string): StoryText => JSON.parse(readFileSync(join(storyDir(dir, id), 'text.json'), 'utf8'));
  rows([
    ['a reply parsed on the retry is ok, and the retry is recorded as one', () => {
      assert.equal(text('flight').steps.frame!.outcome, 'ok');
      assert.deepEqual(record.attempts.filter(row => row.story === 'flight' && row.kind === 'frame').map(row => row.retry), [false, true]);
    }],
    ['a reply cut at the limit is truncated and takes out A alone', () => {
      assert.equal(text('demon').steps.frame!.outcome, 'truncated');
      assert.deepEqual(armsOut(text('demon')), { A: 'frame_truncated' });
    }],
    ['two participants with one role make the variant a schema failure, out of A+, L, C, V and T', () => {
      assert.equal(text('beach').steps.variant!.outcome, 'schema');
      assert.deepEqual(Object.keys(armsOut(text('beach'))), ['A+', 'L', 'C', 'V', 'T']);
    }],
    ['a reply that parses on neither try is unparsed', () => assert.equal(text('giants').steps.variant!.outcome, 'unparsed')],
    ['an empty sheet takes out the whole story before any frame is asked for', () => {
      assert.equal(text('jellyfish').steps.sheet!.outcome, 'empty_sheet');
      assert.equal(text('jellyfish').steps.frame, undefined);
      assert.equal(Object.keys(armsOut(text('jellyfish'))).length, 6);
    }],
    ['a refused call is failed with the adapter\'s code, and the story stops there', () => {
      const failed = text('sharp-2').steps.opening!;
      assert.deepEqual([failed.outcome, failed.code, failed.httpStatus, failed.servingCode], ['failed', 'provider_failed', 500, 'internal_error']);
      assert.equal(text('sharp-2').steps.action, undefined);
    }],
    ['a sharp story writes its seed first, and lives under sealed/', () => {
      assert.equal(text('sharp-1').steps.seed!.outcome, 'ok');
      assert.ok(text('sharp-1').sharp!.seed.includes(marker));
      assert.ok(storyDir(dir, 'sharp-1').includes('/sealed/') && storyDir(dir, 'flight').includes('/clean/'));
    }],
    ['every call is internal, and the checks and counts are apart from the calls', () => {
      assert.deepEqual(Object.keys(gateway.classes), ['internal']);
      const counts = requestCounts(record);
      assert.equal(counts.calls, record.attempts.filter(row => !row.retry).length);
      assert.ok(counts.checks >= 2 && counts.counts > 0 && counts.retries >= 1);
    }],
    ['nothing the run records at its level holds a word of a story', () => {
      const written = readFileSync(join(dir, 'texts.json'), 'utf8') + readFileSync(join(dir, 'marker.json'), 'utf8');
      assert.ok(!written.includes(marker) && !written.includes('Бранд'));
    }],
  ]);

  // A rerun of a finished run asks for nothing, failures included, and a rerun under another model is refused.
  const before = gateway.calls.length;
  const again = await runTexts({ root: dir, model: model('config-4'), smoke, stories });
  assert.equal(gateway.calls.length, before);
  assert.deepEqual(again.stories, record.stories);
  const other = servingModel({ key: 'test-key', configRoot: join(root, 'config-5'), fetch: gateway.fetch });
  other.config.model = 'another-model';
  await assert.rejects(runTexts({ root: dir, model: other, smoke, stories }), /another model/);
});

// The search itself (docs/action-experiment.md#sealed): the word as it is and \u-escaped both ways, in every file but
// those under sealed/, in the temporary directory and in what was printed.
test('the boundary search finds each form of the word outside sealed/, and nothing inside it', t => {
  const root = temp(t);
  const word = 'Зурбаганец';
  const forms = markerForms(word).map(form => form.toString('utf8'));
  const tempDir = join(root, 'tmp');
  for (const [file, content] of [['sealed/a/story.txt', word], ['clean/b/text.json', 'nothing'], ['plain.txt', `x ${word} x`],
    ['lower.json', `"${forms[1]}"`], ['upper.json', `"${forms[2]}"`], ['tmp/one.txt', word], ['tmp/two.txt', 'nothing']]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const found = searchBoundary({ root, tempDir, word, output: 'printed nothing' });
  rows([
    ['three forms, the escaped ones differing in the case of their hexadecimal', () => {
      assert.equal(forms.length, 3);
      assert.ok(forms[1].includes('\\u043d') && forms[2].includes('\\u043D'));
    }],
    ['each form outside sealed/ is a hit, and sealed/ is not searched', () => {
      assert.deepEqual(found.hits.files.sort(), ['lower.json', 'plain.txt', 'upper.json']);
      assert.equal(found.files, 4);
    }],
    ['the temporary directory is searched apart', () => assert.deepEqual([found.tempFiles, found.hits.temp], [2, 1])],
    ['the output is searched too', () => {
      assert.equal(found.hits.output, false);
      assert.equal(searchBoundary({ root, tempDir, word, output: `line ${forms[1]}` }).hits.output, true);
    }],
    ['one hit fails it', () => assert.equal(found.pass, false)],
  ]);
});

test('the marker check fails when the made-up name reaches a file outside sealed/', async t => {
  const root = temp(t);
  // A route that writes what it sends to a file of the run's own level, as a leak would.
  const gateway = fakeGateway({ key: 'k', sharp: [], marker: 'unused' });
  const leaking: typeof gateway.fetch = async (url, init) => {
    if (new URL(url).pathname === '/v1/chat/completions') writeFileSync(join(root, 'run', 'leak.txt'), String(init.body));
    return gateway.fetch(url, init);
  };
  const smoke = join(root, 'smoke.jsonl');
  writeFileSync(smoke, ['state', 'completion', 'fields', 'reasoning', 'finish', 'refusal', 'abort', 'schemas', 'counts'].map(probe => JSON.stringify({ probe, ok: true })).join('\n'));
  const check = await markerCheck({ root: join(root, 'run'), model: servingModel({ key: 'k', configRoot: join(root, 'config'), fetch: leaking }), smoke });
  assert.equal(check.pass, false);
  assert.deepEqual(check.hitFiles, ['leak.txt']);
});
