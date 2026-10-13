import test from 'node:test';
import assert from 'node:assert/strict';
import { messageText, seedInput } from './incoming.ts';
import { addSeed, emptyLibrary, UserError } from '../lib/library.ts';

// A pasted seed is kept whole, plain or rich, or refused with nothing saved; it is never cut silently.
test('unsupported media, blocks, deep trees and merged tables cannot silently lose seed data', () => {
  const plain = 'Маяк\n2026-08-02 20:00\n' + 'Остров. '.repeat(1500);
  const body = 'Синтетическая биография смотрителя. '.repeat(250);
  const rich = { rich_message: { blocks: [
    { type: 'heading', text: { type: 'bold', text: 'Маяк' }, size: 1 },
    { type: 'paragraph', text: { type: 'code', text: '2026-08-02 20:00' } },
    { type: 'paragraph', text: [body, { type: 'italic', text: 'Хвост описания.' }] },
    { type: 'table', cells: [[{ text: 'Параметр' }, { text: 'Значение' }], [{ text: 'Рост' }, { text: '185' }]] },
    { type: 'list', items: [{ label: '1.', blocks: [{ type: 'paragraph', text: 'Любит чинить фонари.' }] }] },
    { type: 'details', summary: 'Неизвестное', blocks: [{ type: 'paragraph', text: 'Причина долголетия неизвестна.' }] },
  ] } };
  const kept: [string, Parameters<typeof messageText>[0], (text: string) => void][] = [
    ['plain text, long, only trimmed', { text: ` ${plain}\n` }, (text) => assert.equal(text, plain.trim())],
    ['a BOM before plain text is not part of the title', { text: `﻿${plain}` },
      (text) => assert.equal(addSeed(emptyLibrary(), seedInput(text)).title, 'Маяк')],
    ['a whole seed in one pre block', { rich_message: { blocks: [{ type: 'pre', text: plain }] } }, (text) => assert.equal(text, plain.trim())],
    ['no message', undefined, (text) => assert.equal(text, '')],
    ['a long rich seed: paragraphs, formatting, tables, lists and collapsed text', rich, (text) => {
      const seed = addSeed(emptyLibrary(), seedInput(text));
      assert.equal(seed.title, 'Маяк');
      assert.equal(seed.startTime, '2026-08-02 20:00');
      assert.ok(seed.text.length > 4096 && seed.text.startsWith(body));
      assert.match(seed.text, /\*Хвост описания\.\*/);
      assert.match(seed.text, /Рост\t185/);
      assert.match(seed.text, /1\. Любит чинить фонари/);
      assert.ok(seed.text.endsWith('Причина долголетия неизвестна.'));
    }],
  ];
  for (const [label, message, check] of kept) check(messageText(message));
  let nested: unknown = 'text';
  for (let i = 0; i < 60; i++) nested = { type: 'bold', text: nested };
  const refused: [string, unknown][] = [
    ['a photo', { type: 'photo', caption: { text: 'some caption' } }],
    ['an unknown block', { type: 'unknown', text: 'hidden data' }],
    ['a tree deeper than the walk goes', { type: 'paragraph', text: nested }],
    ['a merged table cell', { type: 'table', cells: [[{ text: 'merged', colspan: 2 }]] }],
    ['a text over 256 KiB', { type: 'paragraph', text: 'Остров. '.repeat(20000) }],
  ];
  for (const [label, block] of refused) {
    assert.throws(() => messageText({ rich_message: { blocks: [{ type: 'paragraph', text: 'Маяк\n2026-08-02 20:00\nСид.' }, block] } }),
      UserError, label);
  }
});
