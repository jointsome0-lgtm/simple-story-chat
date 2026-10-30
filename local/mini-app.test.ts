// The Mini App's promise, whose failure would show one reader's stories to somebody else (local/mini-app.ts): it
// answers only launch data Telegram signed for this bot within the hour, only to a reader on its list, and from that
// reader's own library alone, a story ID another reader has too included; and it reads no file but one the reader's
// library names in their own directory. A file of its own, since no other test starts this server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Library, PoseSetPicture } from '../lib/library.ts';
import { personTag } from './picture.ts';
import { Store } from './store.ts';
import { initDataKey, initDataUser, serveMiniApp } from './mini-app.ts';

const TOKEN = '123456:synthetic-token';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const NOW = Math.floor(Date.now() / 1000);
const [A, B, C] = ['1001', '1002', '1003'];

// Launch data as Telegram signs it, written from its documentation and not from the code under test: every field but
// `hash`, sorted by name, one `name=value` a line, under HMAC-SHA-256 keyed with that of the token under "WebAppData".
function launch(user: string, { at = NOW, token = TOKEN, unsigned = {} as Record<string, string> } = {}) {
  const fields: Record<string, string> = { query_id: 'AAE-synthetic', auth_date: String(at), signature: 'c3ludGhldGlj',
    user: JSON.stringify({ id: Number(user), first_name: 'Ann Lee', language_code: 'en' }) };
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(Object.keys(fields).sort().map(name => `${name}=${fields[name]}`).join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, ...unsigned, hash }).toString();
}

test('the Mini App answers a reader on its list from their own library alone, and only launch data signed for this bot within the hour', async () => {
  const key = initDataKey(TOKEN);
  const checks: [string, string, ReturnType<typeof initDataUser>][] = [
    ['signed for this bot', launch(A), { user: A }],
    ['signed for another bot', launch(A, { token: '654321:other' }), { refusal: 'forged' }],
    ['with the reader changed after signing', launch(A).replace('%3A1001', '%3A1002'), { refusal: 'forged' }],
    ['with a field Telegram did not sign', launch(A, { unsigned: { chat_type: 'private' } }), { refusal: 'forged' }],
    ['signed an hour ago', launch(A, { at: NOW - 3600 }), { user: A }],
    ['signed an hour and a second ago', launch(A, { at: NOW - 3601 }), { refusal: 'expired' }],
    ['five minutes ahead of this clock', launch(A, { at: NOW + 300 }), { user: A }],
    ['further ahead', launch(A, { at: NOW + 301 }), { refusal: 'expired' }],
    ['with a field twice', `${launch(A)}&auth_date=${NOW}`, { refusal: 'malformed' }],
    ['without a hash', launch(A).replace(/&hash=.*/, ''), { refusal: 'malformed' }],
  ];
  for (const [name, initData, expected] of checks) assert.deepEqual(initDataUser(initData, key, NOW * 1000), expected, name);

  const directory = mkdtempSync(join(tmpdir(), 'simple-chat-mini-app-'));
  const path = join(directory, 'db.sqlite');
  const store = new Store(path);
  const logged: unknown[] = [];
  let app: Awaited<ReturnType<typeof serveMiniApp>> | undefined;
  try {
    // A and B each have a story h1 of their own with a person of their own first on its sheet. A's person has a kept
    // portrait. B's library names a link to it in B's directory, its name, which B's directory does not have, and a path.
    const picture = store.writePortrait(A, PNG);
    const linked = `${'c'.repeat(32)}.png`;
    store.writePortrait(B, PNG);
    symlinkSync(join(store.portraits(A), picture), join(store.portraits(B), linked));
    const story = (id: string, title: string, ...people: [string, string?][]) => ({ id, seedId: 's1', title, branches: {},
      checkpoints: {}, nodes: {}, memories: {},
      sheet: people.map(([name, file]) => ({ name, look: `${name}, synthetic`, ...file ? { portrait: { file, width: 1, height: 1 } } : {} })) });
    const stories = (...list: ReturnType<typeof story>[]) => (state: Library) => {
      state.stories = Object.fromEntries(list.map(one => [one.id, one])) as unknown as Library['stories'];
    };
    store.mutate(A, stories(story('h1', 'Alpha', ['Ann', picture]), story('h2', 'Alpha two', ['Abe'])));
    store.mutate(B, stories(story('h1', 'Beta', ['Bea', linked]),
      story('h3', 'Beta three', ['Bo', `../${basename(store.portraits(A))}/${picture}`], ['Bix', picture])));
    store.mutate(C, stories(story('h1', 'Gamma', ['Cy'])));
    const posePicture = (file: string, fields: Partial<PoseSetPicture> = {}): PoseSetPicture => ({
      file, format: 'png', width: 1, height: 1, bytes: PNG.length, at: NOW, ...fields,
    });
    // Six earlier references and four annotated additions stay visible together, including a set whose generation
    // switch is off. Pending and failed labeling do not hide a reader's own stored picture.
    const old = Array.from({ length: 6 }, () => posePicture(store.writePortrait(A, PNG), {
      caption: { pose: 'standing', side: 'front', framing: 'full body', confidence: 0.8 },
    }));
    const additions = Array.from({ length: 4 }, (_, i) => posePicture(store.writePortrait(A, PNG), {
      caption: { pose: 'all_fours', side: 'profile left', framing: 'full body', confidence: 1 },
      given: { pose: 'all_fours', side: 'profile left', framing: 'full body' }, main: i === 0 ? true : undefined,
      specificPose: `variant ${i + 1}`, poseDetails: 'Synthetic bent arms', expression: 'Synthetic smile', faceVisibility: 'partial',
    }));
    const removed = posePicture(store.writePortrait(A, PNG));
    store.mutate(A, state => { state.stories.h1.sheet![0].poseSet = [...old, ...additions,
      posePicture(store.writePortrait(A, PNG)), posePicture(store.writePortrait(A, PNG), { failed: 2 }), removed]; });
    const oversized = store.writePortrait(B, PNG);
    truncateSync(join(store.portraits(B), oversized), 17 * 1024 * 1024);
    store.mutate(B, state => { state.stories.h1.sheet![0].poseSet = [posePicture(linked),
      posePicture(`../${basename(store.portraits(A))}/${picture}`), posePicture('d'.repeat(32) + '.png'), posePicture(oversized)]; });
    app = await serveMiniApp({ dbPath: path, port: 0, key, users: new Set([A, B]), ownerId: A, details: () => ({}),
      log: (...row) => logged.push(row) });

    const get = (target: string, initData?: string, method = 'GET') => new Promise<{ status: number; body: Buffer }>((done, failed) => {
      http.request({ host: '127.0.0.1', port: app!.port, path: target, method, headers: initData ? { authorization: `tma ${initData}` } : {} },
        response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => done({ status: response.statusCode!, body: Buffer.concat(chunks) }));
        }).on('error', failed).end();
    });
    const card = (name: string) => `/api/stories/h1/people/0/${personTag(name)}`;
    const missing = { status: 404, body: '{"error":"not_found"}' };
    const unsigned = { status: 401, body: '{"error":"unauthorized"}' };
    const routes: [string, string, string | undefined, { status: number; body?: string | Buffer; has?: string; lacks?: string }, string?][] = [
      ['no launch data', '/api/stories', undefined, unsigned],
      ['launch data of another bot', '/api/stories', launch(A, { token: '654321:other' }), unsigned],
      ['launch data over an hour old', '/api/stories', launch(A, { at: NOW - 3601 }), unsigned],
      ['a reader off the list', '/api/stories', launch(C), missing],
      ['A\'s stories', '/api/stories', launch(A), { status: 200, has: 'Alpha two', lacks: 'Beta' }],
      ['A\'s h1, which B has too', '/api/stories/h1/people', launch(A), { status: 200, has: 'Ann', lacks: 'Bea' }],
      ['B\'s h1', '/api/stories/h1/people', launch(B), { status: 200, has: 'Bea', lacks: 'Ann' }],
      ['B\'s h3 asked by A', '/api/stories/h3/people', launch(A), missing],
      ['a story nobody has', '/api/stories/h9/people', launch(A), missing],
      ['A\'s card', card('Ann'), launch(A), { status: 200, has: 'Ann', lacks: 'Bea' }],
      ['B\'s person at the same place asked by A', card('Bea'), launch(A), missing],
      ['A\'s picture', `${card('Ann')}/picture`, launch(A), { status: 200, body: PNG }],
      ['A\'s picture asked by B', `${card('Ann')}/picture`, launch(B), missing],
      ['a link in B\'s directory to A\'s picture', `${card('Bea')}/picture`, launch(B), missing],
      ['a path in B\'s library', `/api/stories/h3/people/0/${personTag('Bo')}/picture`, launch(B), missing],
      ['the name of A\'s picture in B\'s library', `/api/stories/h3/people/1/${personTag('Bix')}/picture`, launch(B), missing],
      ['a path in the address', `${card('Ann')}/../../../../../../etc/passwd`, launch(A), missing],
      ['an encoded path in the address', '/api/stories/%2e%2e%2fh1/people', launch(A), missing],
      ['a write', '/api/stories', launch(A), missing, 'POST'],
    ];
    for (const [name, target, initData, expected, method] of routes) {
      const { status, body } = await get(target, initData, method);
      assert.equal(status, expected.status, name);
      if (expected.body !== undefined) assert.deepEqual(body, Buffer.from(expected.body), name);
      if (expected.has) assert.ok(body.includes(expected.has), name);
      if (expected.lacks) assert.ok(!body.includes(expected.lacks), name);
    }
    const gallery = `${card('Ann')}/references`;
    const first = await get(gallery, launch(A));
    assert.equal(first.status, 200);
    const metadata = JSON.parse(first.body.toString());
    assert.equal(metadata.total, 13);
    assert.equal(metadata.pages, 2);
    assert.equal(metadata.references.length, 12);
    assert.deepEqual(metadata.references.slice(0, 6).map((one: { status: string }) => one.status), Array(6).fill('ready'));
    assert.deepEqual(metadata.references.slice(6, 10).map((one: { specificPose: string }) => one.specificPose),
      ['variant 1', 'variant 2', 'variant 3', 'variant 4']);
    assert.deepEqual(metadata.references.slice(10).map((one: { status: string }) => one.status), ['pending', 'failed']);
    assert.deepEqual(metadata.references[6].given, additions[0].given);
    for (const field of ['specificPose', 'poseDetails', 'expression', 'faceVisibility', 'main'] as const) {
      assert.equal(metadata.references[6][field], additions[0][field]);
    }
    assert.ok([...old, ...additions, removed].every(one => !first.body.includes(one.file)), 'metadata exposes no filenames');
    const second = await get(`${gallery}?page=1`, launch(A));
    assert.equal(second.status, 200);
    const last = JSON.parse(second.body.toString()).references[0];
    assert.equal(last.number, 13);
    const ownPicture = `${gallery}/${metadata.references[0].id}/picture`;
    const removedPicture = `${gallery}/${last.id}/picture`;
    store.mutate(A, state => { state.stories.h1.sheet![0].poseSet!.pop(); });
    const badFiles = JSON.parse((await get(`${card('Bea')}/references`, launch(B))).body.toString()).references;
    const referenceRoutes: typeof routes = [
      ['own reference while generation is off', ownPicture, launch(A), { status: 200, body: PNG }],
      ['reference metadata without launch data', gallery, undefined, unsigned],
      ['reference with expired launch data', ownPicture, launch(A, { at: NOW - 3601 }), unsigned],
      ['a reference asked by another reader', ownPicture, launch(B), missing],
      ['foreign reference ID under B\'s own person', `${card('Bea')}/references/${metadata.references[0].id}/picture`, launch(B), missing],
      ['foreign person tag for reference metadata', `${card('Bea')}/references`, launch(A), missing],
      ['another person of A with the reference ID', `/api/stories/h2/people/0/${personTag('Abe')}/references/${metadata.references[0].id}/picture`, launch(A), missing],
      ['reference removed after metadata was read', removedPicture, launch(A), missing],
      ['raw filename instead of opaque ID', `${gallery}/${old[0].file}/picture`, launch(A), missing],
      ['out of range page', `${gallery}?page=99`, launch(A), missing],
      ['duplicate page', `${gallery}?page=0&page=1`, launch(A), missing],
      ...badFiles.map((one: { id: string }, i: number) => [
        ['symlink reference', 'path reference', 'missing reference file', 'oversized reference file'][i],
        `${card('Bea')}/references/${one.id}/picture`, launch(B), missing,
      ] as typeof routes[number]),
    ];
    for (const [name, target, initData, expected] of referenceRoutes) {
      const result = await get(target, initData);
      assert.equal(result.status, expected.status, name);
      assert.deepEqual(result.body, Buffer.from(expected.body!), name);
    }
    store.mutate(A, state => { state.stories.h1.sheet![0].name = 'Ana'; });
    const stalePerson = await get(ownPicture, launch(A));
    assert.equal(stalePerson.status, 404, 'a person changed after metadata was read');
    assert.deepEqual(stalePerson.body, Buffer.from(missing.body));
    // The log says whose request it was only as the owner's or another's.
    assert.ok(logged.length && [A, B, C].every(id => !JSON.stringify(logged).includes(id)));
  } finally {
    await app?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
