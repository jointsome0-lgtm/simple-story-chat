// Provider errors are safe codes, never raw HTTP/CLI output or story text.
export function safeErrorDetails(value = {}) {
  const result = {};
  if (Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) result.httpStatus = value.httpStatus;
  if (['count_input', 'generate', 'health', 'gpu_read', 'gpu_write', 'ssh_connect', 'ssh_tunnel'].includes(value?.phase)) result.phase = value.phase;
  if (['compact', 'scene'].includes(value?.operation)) result.operation = value.operation;
  if (['output_limit', 'finish_reason', 'json', 'shape', 'fact', 'source', 'coverage', 'evidence', 'quote', 'conflict']
    .includes(value?.memoryReason)) result.memoryReason = value.memoryReason;
  if (typeof value?.transportCode === 'string' && value.transportCode) result.transportCode = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
    .includes(value.transportCode) ? value.transportCode : 'other';
  if (Number.isInteger(value?.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) result.exitCode = value.exitCode;
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGPIPE'].includes(value?.signal)) result.signal = value.signal;
  if (['authentication', 'host_key', 'port_in_use', 'connect_timeout', 'connection_refused', 'connection_lost', 'network_unreachable', 'other']
    .includes(value?.sshReason)) result.sshReason = value.sshReason;
  for (const key of ['sceneCount', 'missingCount', 'connectionAgeMs']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}
export class ModelError extends Error {
  constructor(code, details) { super(code); this.code = code; Object.assign(this, safeErrorDetails(details)); }
}
