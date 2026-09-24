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

// A scene request's row (local/generation.ts): the estimate beside the server's count, and the count's own duration
// only when the count was made.
test('a scene row carries the estimate it was sent on as a count, and nothing else in its place', () => {
  assert.deepEqual(safeErrorDetails({ estimateTokens: 30120, inputTokens: 30087, waitMs: 0, elapsedMs: 5400 }),
    { estimateTokens: 30120, inputTokens: 30087, waitMs: 0, elapsedMs: 5400 });
  assert.deepEqual(safeErrorDetails({ estimateTokens: 'PRIVATE', countMs: undefined }), {});
  for (const estimateTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) assert.deepEqual(safeErrorDetails({ estimateTokens }), {});
});

// A request through a simple-serving gateway (local/serving.ts): its own three measurements beside the bot's queue,
// and the gateway's code of a refusal as a word of the contract's list, never the body it came in.
test('a gateway request logs its measurements as counts and its refusal as a code of a closed list', () => {
  assert.deepEqual(safeErrorDetails({ waitMs: 3, servingWaitMs: 0, servingFirstTokenMs: 410, servingTotalMs: 5200 }),
    { waitMs: 3, servingWaitMs: 0, servingFirstTokenMs: 410, servingTotalMs: 5200 });
  assert.deepEqual(safeErrorDetails({ servingWaitMs: -1, servingFirstTokenMs: 1.5, servingTotalMs: '5200' }), {});
  for (const servingCode of ['class_not_allowed', 'queue_full', 'internal_error', 'drained', 'engine_unavailable']) {
    assert.equal(safeErrorDetails({ servingCode }).servingCode, servingCode);
  }
  assert.deepEqual(safeErrorDetails({ servingCode: 'PRIVATE_TEXT', httpStatus: 400 }), { servingCode: 'other', httpStatus: 400 });
  assert.deepEqual(safeErrorDetails({ servingCode: { code: 'queue_full' } }), {});
  const error = new ModelError('rate_limited', { servingCode: 'queue_full', httpStatus: 429, phase: 'generate', body: 'PRIVATE_BODY' });
  assert.deepEqual({ ...error }, { code: 'rate_limited', servingCode: 'queue_full', httpStatus: 429, phase: 'generate' });
});

test('an illustrated scene logs its durations and the checkpoint role, never the seed, the prompt or the file', () => {
  assert.deepEqual(safeErrorDetails({ imageRole: 'alternate', cancelled: true, describeMs: 6200, imageQueueMs: 40,
    imageMs: 9500, imageSteps: 8, pictureAfterSceneMs: 16000 }),
  { imageRole: 'alternate', cancelled: true, describeMs: 6200, imageQueueMs: 40, imageMs: 9500, imageSteps: 8, pictureAfterSceneMs: 16000 });
  assert.deepEqual(safeErrorDetails({ imageRole: 'kreamania-fp8.safetensors', cancelled: 'PRIVATE',
    imageSeed: 12157665459056928801, prompt: 'PRIVATE_PROMPT', file: 'PRIVATE_PATH', imageMs: -1 }), {});
});

// The row the bot writes for one reader's picture (local/picture.ts): how it ended, how long they waited, and the
// three counts that are all anybody may know about the description.
test('a picture of a scene ends in one of four words, with whole seconds and counts beside it', () => {
  assert.deepEqual(safeErrorDetails({ outcome: 'ready', pictureSeconds: 14, sheetCharacters: 4, namesStripped: 2, withoutLook: 0,
    photoMs: 640, photoBytes: 2150000 }),
    { outcome: 'ready', pictureSeconds: 14, sheetCharacters: 4, namesStripped: 2, withoutLook: 0, photoMs: 640, photoBytes: 2150000 });
  for (const outcome of ['failed', 'cancelled', 'skipped']) assert.equal(safeErrorDetails({ outcome }).outcome, outcome);
  assert.deepEqual(safeErrorDetails({ outcome: 'PRIVATE_SCENE', pictureSeconds: -1, sheetCharacters: 1.5,
    description: 'PRIVATE_DESCRIPTION', who: 'PRIVATE_NAME', photoMs: -3, photoBytes: '2 MB' }), {});
});

// A picture names its style by a word of a closed set: every style of a reader's own is `custom`, and neither its
// words nor its id reach a log. A sample of a style also says whether the scene's frame was drawn again as it was.
test('a picture names its style by a word of a closed set, and a sample says whether it reused the frame', () => {
  for (const pictureStyle of ['standard', 'semi', 'novel', 'film', 'graphic', 'watercolor', 'custom']) {
    assert.equal(safeErrorDetails({ pictureStyle }).pictureStyle, pictureStyle);
  }
  assert.deepEqual(safeErrorDetails({ outcome: 'ready', frameReused: false, pictureStyle: 'custom' }), { outcome: 'ready', frameReused: false, pictureStyle: 'custom' });
  assert.deepEqual(safeErrorDetails({ pictureStyle: 'Charcoal on rough paper', frameReused: 'yes' }), {});
  assert.deepEqual(safeErrorDetails({ pictureStyle: 'y12' }), {});
});

test('a failed CLI run logs how it ended as an enum and a flag, never a subtype the list does not know', () => {
  assert.deepEqual(safeErrorDetails({ cliResult: 'error_max_structured_output_retries', cliError: true, exitCode: 0 }),
    { cliResult: 'error_max_structured_output_retries', cliError: true, exitCode: 0 });
  assert.deepEqual(safeErrorDetails({ cliResult: 'PRIVATE', cliError: 'PRIVATE' }), {});
  assert.deepEqual(safeErrorDetails({ stopReason: 'max_tokens' }), { stopReason: 'max_tokens' });
  assert.deepEqual(safeErrorDetails({ stopReason: 'PRIVATE_TEXT' }), {});
});
