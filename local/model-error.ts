// Provider errors are safe codes, never raw HTTP/CLI output or story text.
const PHASES = ['count_input', 'generate', 'health', 'gpu_read', 'gpu_write', 'ssh_wait', 'ssh_connect', 'ssh_tunnel'] as const;
const OPERATIONS = ['compact', 'scene'] as const;
const MEMORY_REASONS = ['output_limit', 'finish_reason', 'json', 'shape', 'fact', 'source', 'coverage', 'evidence', 'quote', 'conflict'] as const;
const TRANSPORT_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'] as const;
const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGPIPE'] as const;
const SSH_REASONS = ['authentication', 'host_key', 'port_in_use', 'connect_timeout', 'connection_refused', 'connection_lost', 'keepalive_timeout', 'network_unreachable', 'other'] as const;
const ACTORS = ['owner', 'other'] as const;
// Sizes, counts and durations. Each is kept only as a non-negative safe integer, so none can carry text.
const COUNTS = ['sceneCount', 'missingCount', 'connectionAgeMs', 'factCount', 'repairSceneCount', 'requestBytes',
  'inputBytesBefore', 'inputBytesAfter', 'outputCharacters', 'inputTokens', 'outputTokens', 'elapsedMs'] as const;

export type ErrorDetails = {
  httpStatus?: number; phase?: typeof PHASES[number]; operation?: typeof OPERATIONS[number];
  memoryReason?: typeof MEMORY_REASONS[number]; transportCode?: typeof TRANSPORT_CODES[number] | 'other';
  exitCode?: number; signal?: typeof SIGNALS[number]; sshReason?: typeof SSH_REASONS[number];
  // Whose request a bot log row belongs to. Only the owner allowed reading the owner's own stories for debugging.
  actor?: typeof ACTORS[number]; automatic?: boolean;
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
  declare sceneCount?: number; declare missingCount?: number; declare connectionAgeMs?: number;
  // A failed compaction carries its sizes and counts to the log row of the failure.
  declare automatic?: boolean; declare repairSceneCount?: number; declare requestBytes?: number; declare inputBytesBefore?: number;
  declare inputBytesAfter?: number; declare outputCharacters?: number; declare elapsedMs?: number;
  constructor(code: string, details?: unknown) { super(code); this.code = code; Object.assign(this, safeErrorDetails(details)); }
}

// Thrown values are not checked. ModelError and Node system errors carry string codes;
// TelegramError carries an HTTP-like number or a string. Callers compare or sanitize the code.
export function errorCode(error: unknown): string | number | undefined {
  return (error as { code?: string | number }).code;
}
