import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelError, safeErrorDetails } from './model-error.mjs';

test('diagnostics keep only an HTTP status and a known phase, never error text or request data', () => {
  const raw = { httpStatus: 500, phase: 'generate', message: 'PRIVATE_TEXT', body: 'PRIVATE_BODY',
    prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_KEY', url: 'https://private.invalid/' };
  assert.deepEqual(safeErrorDetails(raw), { httpStatus: 500, phase: 'generate' });
  assert.deepEqual(safeErrorDetails({ httpStatus: 'PRIVATE', phase: 'PRIVATE' }), {});
  assert.deepEqual(safeErrorDetails(null), {});
  const error = new ModelError('provider_failed', raw);
  assert.equal(error.message, 'provider_failed');
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE|private/);
});

test('compaction diagnostics expose known reasons, never validation values or raw output', () => {
  assert.deepEqual(safeErrorDetails({ operation: 'compact', memoryReason: 'coverage', text: 'PRIVATE' }),
    { operation: 'compact', memoryReason: 'coverage' });
  assert.deepEqual(safeErrorDetails({ operation: 'PRIVATE', memoryReason: 'PRIVATE' }), {});
});
