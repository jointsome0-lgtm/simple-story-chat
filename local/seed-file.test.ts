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
  const body = options.body ?? Buffer.from('﻿Маяк\r\n2026-08-02 20:00\r\nОписание.\r\n');
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

// A refusal is a user error that names neither the token nor a secret. Which one it was, and how far the reader got.
async function refusal(label: string, options: Options, document?: TelegramDocument) {
  const f = fixture(options);
  const error = await f.run(document).then(() => null, (error: unknown) => error);
  assert.ok(error instanceof UserError, label);
  assert.doesNotMatch(error.message, /synthetic secret|synthetic-token/, label);
  return { key: error.key, ...f.counts() };
}

test('UTF-8 files preserve long text and Markdown, remove BOM and normalize line endings', async () => {
  assert.equal(await fixture().run(), 'Маяк\n2026-08-02 20:00\nОписание.');
  const text = '# Маяк\n2026-08-02 20:00\n' + '**Синтетический остров.** '.repeat(2000);
  assert.equal(await fixture({ body: Buffer.from(text) }).run({ file_name: 'SEED.TXT' }), text.trim());
});

// A wrong type or a declared oversize is refused before anything is downloaded, a cut file never becomes a partial
// seed, a redirect or a foreign path never takes the download (and the token) elsewhere, and neither bad text nor a
// failed getFile shows the reader a raw error. Columns: the message, then the getFile calls and downloads made.
test('stream limits, truncated transfers, redirects and invalid paths fail without a partial file', async () => {
  const refused: [string, Options, string, number, number, TelegramDocument?][] = [
    ['a .docx', {}, 'fileType', 0, 0, { file_name: 'seed.docx' }],
    ['a message that declares too many bytes', {}, 'fileTooLarge', 0, 0, { file_size: SEED_BYTES + 1 }],
    ['getFile that declares too many bytes', { fileSize: SEED_BYTES + 1 }, 'fileTooLarge', 1, 0],
    ['a stream over the limit', { body: Buffer.alloc(SEED_BYTES + 1, 65), fileSize: 1 }, 'fileTooLarge', 1, 1],
    ['a content-length over the limit', { headers: { 'content-length': String(SEED_BYTES + 1) } }, 'fileTooLarge', 1, 1],
    ['a truncated transfer', { complete: false }, 'fileIncomplete', 1, 1],
    ['a size other than getFile declared', { fileSize: 1 }, 'fileIncomplete', 1, 1],
    ['a redirect', { status: 302 }, 'fileIncomplete', 1, 1],
    ['a path out of the bot\'s files', { path: '../secret' }, 'fileIncomplete', 1, 0],
    ['a path to another host', { path: 'https://example.invalid/file.txt' }, 'fileIncomplete', 1, 0],
    ['bad UTF-8', { body: Buffer.from([0xff, 0xfe, 0x41, 0]) }, 'fileEncoding', 1, 1],
    ['binary data', { body: Buffer.from('title\u0000binary') }, 'fileBinary', 1, 1],
    ['an empty file', { body: Buffer.from(' \n ') }, 'fileBinary', 1, 1],
    ['a failed getFile', { apiError: true }, 'fileIncomplete', 1, 0],
  ];
  for (const [label, options, key, calls, downloads, document] of refused) {
    assert.deepEqual(await refusal(label, options, document), { key, calls, downloads }, label);
  }
});
