import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { UserError } from '../lib/library.ts';
import type { HttpsGet, TelegramDocument } from './seed-file.ts';
import { createSeedFileReader, SEED_BYTES } from './seed-file.ts';
import type { TelegramApi } from './telegram.ts';

type Options = { body?: Buffer; apiError?: boolean; path?: string; fileSize?: number; status?: number; headers?: Record<string, string>; complete?: boolean };

function fixture(options: Options = {}) {
  const body = options.body ?? Buffer.from('\ufeffМаяк\r\n2026-08-02 20:00\r\nОписание.\r\n');
  let calls = 0;
  let downloads = 0;
  const api: TelegramApi = async (method, payload) => {
    calls++;
    assert.equal(method, 'getFile');
    assert.deepEqual(payload, { file_id: 'synthetic-id' });
    if (options.apiError) throw new Error('synthetic secret must not escape');
    return { file_path: options.path ?? 'documents/file_1.txt', file_size: options.fileSize ?? body.length };
  };
  const get: HttpsGet = (settings, callback) => {
    downloads++;
    assert.equal(settings.hostname, 'api.telegram.org');
    assert.equal(settings.path, '/file/botsynthetic-token/documents/file_1.txt');
    const response = Object.assign(new PassThrough(), {
      statusCode: options.status ?? 200,
      headers: options.headers ?? {},
      complete: options.complete ?? true,
    });
    const request = Object.assign(new EventEmitter(), { destroy: () => response.destroy() });
    response.on('close', () => request.emit('close'));
    queueMicrotask(() => { callback(response); response.end(body); });
    return request;
  };
  const read = createSeedFileReader('synthetic-token', api, { get });
  const run = (overrides: TelegramDocument = {}) => read({ file_name: 'seed.md', file_id: 'synthetic-id', ...overrides });
  return { run, counts: () => ({ calls, downloads }) };
}

test('UTF-8 files preserve long text and Markdown, remove BOM and normalize line endings', async () => {
  const f = fixture();
  assert.equal(await f.run(), 'Маяк\n2026-08-02 20:00\nОписание.');
  const text = '# Маяк\n2026-08-02 20:00\n' + '**Синтетический остров.** '.repeat(2000);
  assert.equal(await fixture({ body: Buffer.from(text) }).run({ file_name: 'SEED.TXT' }), text.trim());
});

test('wrong type and declared oversize files are rejected before downloading', async () => {
  const f = fixture();
  await assert.rejects(f.run({ file_name: 'seed.docx' }), UserError);
  await assert.rejects(f.run({ file_size: SEED_BYTES + 1 }), UserError);
  assert.deepEqual(f.counts(), { calls: 0, downloads: 0 });
  const oversized = fixture({ fileSize: SEED_BYTES + 1 });
  await assert.rejects(oversized.run(), UserError);
  assert.equal(oversized.counts().downloads, 0);
});

test('stream limits, truncated transfers, redirects and invalid paths fail without a partial file', async () => {
  for (const options of [
    { body: Buffer.alloc(SEED_BYTES + 1, 65), fileSize: 1 },
    { headers: { 'content-length': String(SEED_BYTES + 1) } },
    { complete: false }, { fileSize: 1 }, { status: 302 },
    { path: '../secret' }, { path: 'https://example.invalid/file.txt' },
  ]) await assert.rejects(fixture(options).run(), UserError);
});

test('bad UTF-8, binary data, empty files and network errors never leak raw errors', async () => {
  for (const options of [
    { body: Buffer.from([0xff, 0xfe, 0x41, 0]) },
    { body: Buffer.from('title\u0000binary') },
    { body: Buffer.from(' \n ') }, { apiError: true },
  ]) await assert.rejects(fixture(options).run(), error => {
    assert.ok(error instanceof UserError);
    assert.doesNotMatch(error.message, /synthetic secret|synthetic-token/);
    return true;
  });
});
