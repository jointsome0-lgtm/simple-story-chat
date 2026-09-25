import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelError, safeErrorDetails } from './model-error.ts';

// One row per family of the log whitelist: what a row of that family may carry passes as it came, and what it must
// never carry (an identifier, story text, a prompt, a secret, a raw error, a number that is not a safe count) is
// dropped. An enum outside its closed list is dropped, except the two codes that become `other`.
const PRIVATE = { message: 'PRIVATE_TEXT', body: 'PRIVATE_BODY', prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_KEY',
  url: 'https://private.invalid/', userId: '1', text: 'PRIVATE', description: 'PRIVATE_DESCRIPTION', who: 'PRIVATE_NAME',
  file: 'PRIVATE_PATH', imageSeed: 12157665459056928801 };
const kept = (row: object) => [{ ...row, ...PRIVATE }, row] as const;
const rows: [string, readonly [unknown, object]][] = [
  ['an HTTP status and a phase', kept({ httpStatus: 500, phase: 'generate' })],
  ['nothing of an unknown status or phase', [{ httpStatus: 'PRIVATE', phase: 'PRIVATE' }, {}]],
  ['nothing of no value', [null, {}]],
  ['a compaction reason', kept({ operation: 'compact', memoryReason: 'coverage' })],
  ['nothing of an unknown operation or reason', [{ operation: 'PRIVATE', memoryReason: 'PRIVATE' }, {}]],
  ['a compaction stage of an agent', kept({ actor: 'agent', stage: 'extracting' })],
  ['nothing of a stage that is story text', [{ stage: 'a line of the story' }, {}]],
  ['a bot row: the actor class, a flag and counts', kept({ actor: 'owner', automatic: true, sceneCount: 22, factCount: 41,
    repairSceneCount: 0, requestBytes: 180000, inputBytesBefore: 190000, inputBytesAfter: 61000, outputCharacters: 7400,
    inputTokens: 38000, outputTokens: 2100, elapsedMs: 91000 })],
  ['nothing of an id for an actor, text for a flag, or a count that is not a safe integer',
    [{ actor: '1', automatic: 'PRIVATE', factCount: 'PRIVATE', requestBytes: -1, elapsedMs: 1.5, inputTokens: null,
      outputCharacters: Number.MAX_SAFE_INTEGER + 1 }, {}]],
  ['a scene row: the estimate it was sent on beside the count', kept({ estimateTokens: 30120, inputTokens: 30087, waitMs: 0, elapsedMs: 5400 })],
  ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, 'PRIVATE'].map((estimateTokens) =>
    [`nothing of an estimate of ${String(estimateTokens)}`, [{ estimateTokens, countMs: undefined }, {}]] as [string, readonly [unknown, object]]),
  ['a gateway request: its measurements', kept({ waitMs: 3, servingWaitMs: 0, servingFirstTokenMs: 410, servingTotalMs: 5200 })],
  ['nothing of a measurement that is not a count', [{ servingWaitMs: -1, servingFirstTokenMs: 1.5, servingTotalMs: '5200' }, {}]],
  ...['class_not_allowed', 'queue_full', 'internal_error', 'drained', 'engine_unavailable'].map((servingCode) =>
    [`the gateway's code ${servingCode}`, kept({ servingCode })] as [string, readonly [unknown, object]]),
  ['a gateway code outside the contract as other', [{ servingCode: 'PRIVATE_TEXT', httpStatus: 400 }, { servingCode: 'other', httpStatus: 400 }]],
  ['nothing of a gateway code that is not a string', [{ servingCode: { code: 'queue_full' } }, {}]],
  ['a picture: the checkpoint role, a flag and durations', kept({ imageRole: 'alternate', cancelled: true, describeMs: 6200,
    imageQueueMs: 40, imageMs: 9500, imageSteps: 8, pictureAfterSceneMs: 16000 })],
  ['nothing of a checkpoint file, a flag in words or a negative duration',
    [{ imageRole: 'kreamania-fp8.safetensors', cancelled: 'PRIVATE', imageMs: -1 }, {}]],
  ['a picture of a scene: its outcome, whole seconds and counts', kept({ outcome: 'ready', pictureSeconds: 14, sheetCharacters: 4,
    namesStripped: 2, withoutLook: 0, photoMs: 640, photoBytes: 2150000 })],
  ...['failed', 'cancelled', 'skipped'].map((outcome) => [`the outcome ${outcome}`, kept({ outcome })] as [string, readonly [unknown, object]]),
  ['nothing of an outcome, a count or a size that is not one',
    [{ outcome: 'PRIVATE_SCENE', pictureSeconds: -1, sheetCharacters: 1.5, photoMs: -3, photoBytes: '2 MB' }, {}]],
  ...['standard', 'semi', 'novel', 'film', 'graphic', 'watercolor', 'custom'].map((pictureStyle) =>
    [`the style ${pictureStyle}`, kept({ pictureStyle })] as [string, readonly [unknown, object]]),
  ['a sample: whether it reused the frame', kept({ outcome: 'ready', frameReused: false, pictureStyle: 'custom' })],
  ['nothing of a style of the reader\'s own words or id', [{ pictureStyle: 'Charcoal on rough paper', frameReused: 'yes' }, {}]],
  ['nothing of a style id', [{ pictureStyle: 'y12' }, {}]],
  ['a failed CLI run: how it ended and a flag', kept({ cliResult: 'error_max_structured_output_retries', cliError: true, exitCode: 0 })],
  ['nothing of a CLI subtype the list does not know', [{ cliResult: 'PRIVATE', cliError: 'PRIVATE' }, {}]],
  ['a stop reason', kept({ stopReason: 'max_tokens' })],
  ['nothing of a stop reason in words', [{ stopReason: 'PRIVATE_TEXT' }, {}]],
];

test('diagnostics keep only an HTTP status and a known phase, never error text or request data', () => {
  for (const [family, [input, expected]] of rows) {
    assert.deepEqual(safeErrorDetails(input), expected, family);
    assert.doesNotMatch(JSON.stringify(safeErrorDetails(input)), /PRIVATE|private/, family);
  }
  // A ModelError is its code and the whitelisted fields, whatever it was made from.
  const error = new ModelError('provider_failed', { httpStatus: 500, phase: 'generate', ...PRIVATE });
  assert.equal(error.message, 'provider_failed');
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE|private/);
  const refused = new ModelError('rate_limited', { servingCode: 'queue_full', httpStatus: 429, phase: 'generate', body: 'PRIVATE_BODY' });
  assert.deepEqual({ ...refused }, { code: 'rate_limited', servingCode: 'queue_full', httpStatus: 429, phase: 'generate' });
});
