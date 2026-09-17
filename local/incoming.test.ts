import test from 'node:test';
import assert from 'node:assert/strict';
import { messageText, seedInput } from './incoming.ts';
import { addSeed, emptyLibrary, UserError } from '../lib/library.ts';

test('a long rich seed preserves paragraphs, formatting, tables, lists and collapsed text', () => {
  const body = 'Синтетическая биография смотрителя. '.repeat(250);
  const received = messageText({ rich_message: { blocks: [
    { type: 'heading', text: { type: 'bold', text: 'Маяк' }, size: 1 },
    { type: 'paragraph', text: { type: 'code', text: '2026-08-02 20:00' } },
    { type: 'paragraph', text: [body, { type: 'italic', text: 'Хвост описания.' }] },
    { type: 'table', cells: [[{ text: 'Параметр' }, { text: 'Значение' }], [{ text: 'Рост' }, { text: '185' }]] },
    { type: 'list', items: [{ label: '1.', blocks: [{ type: 'paragraph', text: 'Любит чинить фонари.' }] }] },
    { type: 'details', summary: 'Неизвестное', blocks: [{ type: 'paragraph', text: 'Причина долголетия неизвестна.' }] },
  ] } });
  const state = emptyLibrary();
  const seed = addSeed(state, seedInput(received));
  assert.equal(seed.title, 'Маяк');
  assert.equal(seed.startTime, '2026-08-02 20:00');
  assert.ok(seed.text.length > 4096);
  assert.ok(seed.text.startsWith(body));
  assert.match(seed.text, /Рост\t185/);
  assert.match(seed.text, /1\. Любит чинить фонари/);
  assert.ok(seed.text.endsWith('Причина долголетия неизвестна.'));
});

test('ordinary long text is not truncated and whole-seed code blocks also work', () => {
  const text = 'Маяк\n2026-08-02 20:00\n' + 'Остров. '.repeat(1500);
  assert.equal(messageText({ text }), text.trim());
  assert.equal(messageText({ rich_message: { blocks: [{ type: 'pre', text }] } }), text.trim());
  assert.equal(messageText(undefined), '');
});

test('unsupported media, blocks, deep trees and merged tables cannot silently lose seed data', () => {
  let nested: unknown = 'text';
  for (let i = 0; i < 60; i++) nested = { type: 'bold', text: nested };
  for (const block of [
    { type: 'photo', caption: { text: 'some caption' } },
    { type: 'unknown', text: 'hidden data' },
    { type: 'paragraph', text: nested },
    { type: 'table', cells: [[{ text: 'merged', colspan: 2 }]] },
  ]) {
    assert.throws(() => messageText({ rich_message: { blocks: [{ type: 'paragraph', text: 'Маяк\n2026-08-02 20:00\nСид.' }, block] } }), UserError);
  }
});
