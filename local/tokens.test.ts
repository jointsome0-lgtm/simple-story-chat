import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenCounter, TOKEN_RULER } from './tokens.ts';

test('the token ruler counts with o200k_base when the package is installed, and reports its absence as null', async t => {
  const count = await tokenCounter();
  assert.equal(TOKEN_RULER, 'o200k_base');
  if (!count) { t.skip('tiktoken is not installed (npm install)'); return; }
  assert.equal(count(''), 0);
  const short = count('Дорога по косе уходит под воду.');
  const long = count('Дорога по косе уходит под воду с приливом в 21:10 и открывается снова около 05:40.');
  assert.ok(short > 0 && long > short);
  // A special token's text is counted as text, not refused.
  assert.ok(count('конец <|endoftext|> текста') > 0);
  // Asked twice, the ruler is loaded once.
  assert.ok(await tokenCounter());
});
