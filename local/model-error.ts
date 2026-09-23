// Provider errors are safe codes, never raw HTTP/CLI output or story text.
const PHASES = ['count_input', 'generate', 'health', 'gpu_read', 'gpu_write', 'ssh_wait', 'ssh_connect', 'ssh_tunnel'] as const;
const OPERATIONS = ['compact', 'scene'] as const;
const MEMORY_REASONS = ['output_limit', 'finish_reason', 'json', 'shape', 'fact', 'source', 'coverage', 'evidence', 'quote', 'conflict'] as const;
const TRANSPORT_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'] as const;
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGPIPE'] as const;
const SSH_REASONS = ['authentication', 'host_key', 'port_in_use', 'connect_timeout', 'connection_refused', 'connection_lost', 'keepalive_timeout', 'network_unreachable', 'other'] as const;
// `agent`: a request through the agent interface (local/agent-api.ts), which has its own library.
const ACTORS = ['owner', 'other', 'agent'] as const;
// Stages of a compaction, as generation.ts reports them.
const STAGES = ['queued', 'extracting', 'validating', 'saving', 'done', 'failed', 'cancelled'] as const;
// Calls of the agent interface, for its log rows.
const AGENT_CALLS = ['create_seed', 'start_story', 'act', 'fork'] as const;
// Which checkpoint drew a picture, by its place in the comparison (local/image-batch.ts). The file name of a
// community checkpoint is not an enum and does not belong in a log row.
const IMAGE_ROLES = ['primary', 'alternate'] as const;
// How a Claude CLI run ended, from the `subtype` of its terminal result (local/claude.ts): the CLI's own verdicts,
// `no_init` when the run never reported its tools, `missing` when it ended without a result, `other` for a subtype
// this list does not know. Together with `exitCode` this tells a stalled CLI from a refused structured output.
export const CLI_RESULTS = ['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd',
  'error_max_structured_output_retries', 'no_init', 'missing', 'other'] as const;
// How one scene's picture ended (local/picture.ts): sent, failed with a code, ended by the reader's next message,
// or not attempted at all because the card was paused. Four words; the scene and the picture stay out.
const OUTCOMES = ['ready', 'failed', 'cancelled', 'skipped'] as const;
// Which style a picture was drawn in (local/picture-style.ts): the bot's own line, a preset, or one of the reader's
// own, whose words and names stay out of the row as the prompt does.
const PICTURE_STYLES = ['standard', 'semi', 'novel', 'film', 'graphic', 'watercolor', 'custom'] as const;
// Why the model's last message ended, as the API names it, for the row of a failed Claude CLI run: `max_tokens` there
// means the run's output cap was hit, which the CLI reports as an error rather than a truncation.
export const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'other'] as const;
// Sizes, counts and durations. Each is kept only as a non-negative safe integer, so none can carry text.
const COUNTS = ['sceneCount', 'missingCount', 'connectionAgeMs', 'factCount', 'repairSceneCount', 'requestBytes',
  'inputBytesBefore', 'inputBytesAfter', 'outputCharacters', 'inputTokens', 'outputTokens', 'elapsedMs',
  // A failed quote check: all quotes, and the failed ones by the loosest comparison that would have matched them.
  'quoteCount', 'quoteWhitespace', 'quoteTypography', 'quotePunctuation', 'quoteOther',
  // One model request: time in the queue and in token counting, then llama-server's own timings (local/model.ts Timings).
  'waitMs', 'countMs', 'cacheTokens', 'promptTokens', 'promptMs', 'predictedTokens', 'predictedMs', 'draftTokens',
  'draftAcceptedTokens', 'slot',
  // Which run of local/prepare.ts a row belongs to, counted from the start of the process.
  'prepareRun',
  // One illustrated scene (docs/illustrations-plan.md): the description call, then the image server from submit to
  // file, and what the reader waits from the end of the scene to the picture. The seed stays out: it is drawn from
  // 0..2^64-1 and is not a safe integer, and so do the prompt, the description and the file name, which are the
  // reader's scene in another form.
  // `pictureSeconds` is the same wait as `pictureAfterSceneMs`, rounded: the plan asks for the seconds from the end
  // of the scene to the picture as a non-negative integer, and that is the number a reader's patience is read in.
  // The three counts of the description are all anybody can see of it: how many people the story's character sheet
  // holds (one for a whole story is almost certainly a wrong sheet), how many names the assembly had to cut out of
  // a field the instruction forbids them in, and how many people reached the prompt with no appearance at all.
  'describeMs', 'imageQueueMs', 'imageMs', 'imageSteps', 'pictureAfterSceneMs', 'pictureSeconds',
  'sheetCharacters', 'namesStripped', 'withoutLook',
  // A sample of styles (local/picture.ts `sample`): how many styles one press of the reader asked for, one on a
  // style's own card and every style of the picker for "all styles".
  'stylesAsked'] as const;

export type ErrorDetails = {
  httpStatus?: number; phase?: typeof PHASES[number]; operation?: typeof OPERATIONS[number];
  memoryReason?: typeof MEMORY_REASONS[number]; transportCode?: typeof TRANSPORT_CODES[number] | 'other';
  exitCode?: number; signal?: typeof SIGNALS[number]; sshReason?: typeof SSH_REASONS[number];
  // Whose request a bot log row belongs to. Only the owner allowed reading the owner's own stories for debugging.
  actor?: typeof ACTORS[number]; automatic?: boolean; agentCall?: typeof AGENT_CALLS[number]; stage?: typeof STAGES[number];
  // A picture: which checkpoint drew it, how it ended, whether the reader's next message ended it before it arrived,
  // in which style, and for a sample of a style whether the scene's frame was still in memory.
  imageRole?: typeof IMAGE_ROLES[number]; outcome?: typeof OUTCOMES[number]; cancelled?: boolean;
  pictureStyle?: typeof PICTURE_STYLES[number]; frameReused?: boolean;
  // A failed Claude CLI run: how it ended and whether the CLI itself called the result an error.
  cliResult?: typeof CLI_RESULTS[number]; cliError?: boolean; stopReason?: typeof STOP_REASONS[number];
} & { [Key in typeof COUNTS[number]]?: number };
export type Log = (event: string, code?: string | number, details?: unknown) => void;

// `includes` for a value of any type, as a guard for a list of literals (inline or `as const`). It compares
// without conversion, so only the declared parameter type is widened. A widened list such as string[] is
// rejected: its false branch would wrongly exclude every string from the value's type.
type Literal<T> = string extends T ? never : number extends T ? never : T;
export const member = <const T extends string | number>(list: readonly Literal<T>[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

// Any value may be passed, including errors and log arguments; each field is read as unknown and kept only if allowed.
export function safeErrorDetails(value: unknown = {}): ErrorDetails {
  const input = value as { readonly [key: string]: unknown } | null | undefined;
  const result: ErrorDetails = {};
  const httpStatus = input?.httpStatus;
  if (typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  if (member(PHASES, input?.phase)) result.phase = input.phase;
  if (member(OPERATIONS, input?.operation)) result.operation = input.operation;
  if (member(MEMORY_REASONS, input?.memoryReason)) result.memoryReason = input.memoryReason;
  if (typeof input?.transportCode === 'string' && input.transportCode) result.transportCode = member(TRANSPORT_CODES, input.transportCode) ? input.transportCode : 'other';
  const exitCode = input?.exitCode;
  if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) result.exitCode = exitCode;
  if (member(SIGNALS, input?.signal)) result.signal = input.signal;
  if (member(SSH_REASONS, input?.sshReason)) result.sshReason = input.sshReason;
  if (member(ACTORS, input?.actor)) result.actor = input.actor;
  if (typeof input?.automatic === 'boolean') result.automatic = input.automatic;
  if (member(AGENT_CALLS, input?.agentCall)) result.agentCall = input.agentCall;
  if (member(STAGES, input?.stage)) result.stage = input.stage;
  if (member(IMAGE_ROLES, input?.imageRole)) result.imageRole = input.imageRole;
  if (member(OUTCOMES, input?.outcome)) result.outcome = input.outcome;
  if (typeof input?.cancelled === 'boolean') result.cancelled = input.cancelled;
  if (member(PICTURE_STYLES, input?.pictureStyle)) result.pictureStyle = input.pictureStyle;
  if (typeof input?.frameReused === 'boolean') result.frameReused = input.frameReused;
  if (member(CLI_RESULTS, input?.cliResult)) result.cliResult = input.cliResult;
  if (typeof input?.cliError === 'boolean') result.cliError = input.cliError;
  if (member(STOP_REASONS, input?.stopReason)) result.stopReason = input.stopReason;
  for (const key of COUNTS) {
    const count = input?.[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return result;
}
export class ModelError extends Error {
  declare code: string;
  declare httpStatus?: number; declare phase?: ErrorDetails['phase']; declare operation?: ErrorDetails['operation'];
  declare memoryReason?: ErrorDetails['memoryReason']; declare transportCode?: ErrorDetails['transportCode'];
  declare exitCode?: number; declare signal?: ErrorDetails['signal']; declare sshReason?: ErrorDetails['sshReason'];
  declare cliResult?: ErrorDetails['cliResult']; declare cliError?: boolean; declare stopReason?: ErrorDetails['stopReason'];
  declare sceneCount?: number; declare missingCount?: number; declare connectionAgeMs?: number;
  // A failed compaction carries its sizes and counts to the log row of the failure.
  declare automatic?: boolean; declare repairSceneCount?: number; declare requestBytes?: number; declare inputBytesBefore?: number;
  declare inputBytesAfter?: number; declare outputCharacters?: number; declare elapsedMs?: number;
  constructor(code: string, details?: unknown) { super(code); this.code = code; Object.assign(this, safeErrorDetails(details)); }
}

// The `reason` of an agent interface response. Model and transport failures keep their ModelError code; the rest
// belong to the interface itself. Anything else becomes `internal_error`, so no provider text can reach a client.
export const REASONS = ['cancelled', 'context_limit', 'timeout', 'provider_failed', 'unauthorized', 'model_unavailable',
  'unexpected_model', 'rate_limited', 'budget_exceeded', 'queue_full', 'nothing_to_compact', 'invalid_memory', 'memory_not_smaller',
  'output_limit', 'empty_response', 'invalid_response', 'invalid_stream', 'incomplete_stream', 'usage_unavailable', 'unexpected_tools',
  'process_exit', 'network', 'gpu_not_ready', 'background_preempted', 'background_unavailable', 'background_timeout',
  'background_invalid_request', 'background_request_too_large',
  // The agent interface's own reasons.
  'invalid_request', 'seed_format', 'not_found', 'unknown_request', 'request_id_reused', 'job_running', 'library_locked',
  'process_exited', 'shutdown', 'internal_error'] as const;
export type Reason = typeof REASONS[number];
export const reasonCode = (error: unknown): Reason => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return member(REASONS, code) ? code : 'internal_error';
};

// Thrown values are not checked. ModelError and Node system errors carry string codes;
// TelegramError carries an HTTP-like number or a string. Callers compare or sanitize the code.
export function errorCode(error: unknown): string | number | undefined {
  return (error as { code?: string | number }).code;
}
