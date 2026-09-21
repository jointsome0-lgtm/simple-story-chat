import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelError, safeErrorDetails } from './model-error.ts';

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

test('bot log rows may name the actor class and carry sizes and counts, never an identifier or text', () => {
  assert.deepEqual(safeErrorDetails({ actor: 'owner', automatic: true, sceneCount: 22, factCount: 41, repairSceneCount: 0, requestBytes: 180000,
    inputBytesBefore: 190000, inputBytesAfter: 61000, outputCharacters: 7400, inputTokens: 38000, outputTokens: 2100, elapsedMs: 91000 }),
  { actor: 'owner', automatic: true, sceneCount: 22, factCount: 41, repairSceneCount: 0, requestBytes: 180000,
    inputBytesBefore: 190000, inputBytesAfter: 61000, outputCharacters: 7400, inputTokens: 38000, outputTokens: 2100, elapsedMs: 91000 });
  assert.deepEqual(safeErrorDetails({ actor: '1', automatic: 'PRIVATE', userId: '1', factCount: 'PRIVATE', requestBytes: -1, elapsedMs: 1.5,
    inputTokens: null, outputCharacters: Number.MAX_SAFE_INTEGER + 1 }), {});
});

test('an illustrated scene logs its durations and the checkpoint role, never the seed, the prompt or the file', () => {
  assert.deepEqual(safeErrorDetails({ imageRole: 'alternate', cancelled: true, describeMs: 6200, imageQueueMs: 40,
    imageMs: 9500, imageSteps: 8, pictureAfterSceneMs: 16000 }),
  { imageRole: 'alternate', cancelled: true, describeMs: 6200, imageQueueMs: 40, imageMs: 9500, imageSteps: 8, pictureAfterSceneMs: 16000 });
  assert.deepEqual(safeErrorDetails({ imageRole: 'kreamania-fp8.safetensors', cancelled: 'PRIVATE',
    imageSeed: 12157665459056928801, prompt: 'PRIVATE_PROMPT', file: 'PRIVATE_PATH', imageMs: -1 }), {});
});
