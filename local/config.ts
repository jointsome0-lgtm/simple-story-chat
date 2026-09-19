import { readFileSync, realpathSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';

export type Env = NodeJS.Dict<string>;
export type ModelConfig = {
  provider: 'claude-code' | 'codex-cli' | 'llama-cpp' | 'openai-compatible'; model: string; baseUrl: string | undefined; apiKey: string; temperature: number;
  memoryMode: 'plain' | 'sgr'; repairCoverage: boolean; timeoutMs: number; contextTokens: number; maxOutputTokens: number;
  compactAtTokens: number; keepScenes: number;
  // Overrides of the daily cap of a hosted API's channel; see budget.ts.
  budget: { requests: number | undefined; tokens: number | undefined };
};
export type GpuConfig = { instanceId: string; apiKey: string; sshHost: string; idleMinutes: number };
export type Config = ModelConfig & { gpu: GpuConfig | undefined; token: string; allowedUsers: Set<string>; ownerId: string; dbPath: string };
// The agent interface (docs/agent-interface.md): its own library file, and the bot's model queue if the bot serves one.
// `agentId` names the library inside that file when the client does not pass one.
export type AgentConfig = ModelConfig & { dbPath: string; modelSocket: string; waitSeconds: number; agentId: string | undefined };

function environment(directory: string, inherited: Env): Env {
  let file: Env = {};
  try { file = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read local configuration'); }
  return { ...file, ...inherited };
}

export function modelBaseUrl(value: string | undefined): string {
  let url;
  // URL converts its argument to a string, so a missing value fails here too.
  try { url = new URL(String(value)); } catch { throw new Error('Set SIMPLE_CHAT_BASE_URL to the llama.cpp server root'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('SIMPLE_CHAT_BASE_URL must be an HTTPS root or loopback HTTP root without credentials');
  }
  return url.origin;
}

// The versioned root of a hosted API, such as https://openrouter.ai/api/v1. Unlike the llama.cpp root it has a path.
export function apiBaseUrl(value: string | undefined): string {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Set SIMPLE_CHAT_BASE_URL to the API root, such as https://openrouter.ai/api/v1'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:') {
    throw new Error('SIMPLE_CHAT_BASE_URL must be an HTTPS API root without credentials');
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function modelConfig(env: Env): ModelConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const provider = env.SIMPLE_CHAT_PROVIDER || 'claude-code';
  if (provider !== 'claude-code' && provider !== 'codex-cli' && provider !== 'llama-cpp' && provider !== 'openai-compatible') throw new Error('Unsupported SIMPLE_CHAT_PROVIDER');
  const baseUrl = provider === 'llama-cpp' ? modelBaseUrl(env.SIMPLE_CHAT_BASE_URL)
    : provider === 'openai-compatible' ? apiBaseUrl(env.SIMPLE_CHAT_BASE_URL) : undefined;
  const apiKey = env.SIMPLE_CHAT_API_KEY?.trim() || '';
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid SIMPLE_CHAT_API_KEY');
  if (baseUrl?.startsWith('https:') && !apiKey) throw new Error('Set SIMPLE_CHAT_API_KEY for a remote HTTPS server');
  const temperature = Number(env.SIMPLE_CHAT_TEMPERATURE || '0.8');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('Invalid SIMPLE_CHAT_TEMPERATURE');
  if (provider === 'openai-compatible' && !env.SIMPLE_CHAT_MODEL) throw new Error('Set SIMPLE_CHAT_MODEL for the hosted API');
  // Which models a Codex account may use depends on its plan, so there is no safe default.
  if (provider === 'codex-cli' && !env.SIMPLE_CHAT_MODEL) throw new Error('Set SIMPLE_CHAT_MODEL for the Codex CLI');
  const model = env.SIMPLE_CHAT_MODEL || (provider === 'llama-cpp' ? 'gemma-4-31b-heretic-q6k' : 'claude-haiku-4-5-20251001');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/.test(model)) throw new Error('Invalid SIMPLE_CHAT_MODEL');
  const contextTokens = integer('SIMPLE_CHAT_CONTEXT_TOKENS', 65536, 8192, 65536);
  const memoryMode = env.SIMPLE_CHAT_MEMORY_MODE || 'plain';
  if (memoryMode !== 'plain' && memoryMode !== 'sgr') throw new Error('Invalid SIMPLE_CHAT_MEMORY_MODE');
  const repairCoverage = env.SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE || 'false';
  if (!['true', 'false'].includes(repairCoverage)) throw new Error('Invalid SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE');
  const maxOutputTokens = integer('SIMPLE_CHAT_MAX_OUTPUT_TOKENS', 4096, 256, 8192);
  const maxInput = contextTokens - Math.max(maxOutputTokens, memoryMode === 'sgr' ? 8192 : 4096);
  if (maxInput < 2048) throw new Error('Output reserve leaves too little input context');
  return {
    provider, model, baseUrl, apiKey, temperature, memoryMode, repairCoverage: repairCoverage === 'true',
    timeoutMs: integer('SIMPLE_CHAT_MODEL_TIMEOUT_MS', 300000, 1000, 1800000),
    contextTokens, maxOutputTokens,
    compactAtTokens: integer('SIMPLE_CHAT_COMPACT_AT_TOKENS', Math.min(provider === 'claude-code' || provider === 'codex-cli' ? 54000 : 44000, maxInput), 2048, maxInput),
    keepScenes: integer('SIMPLE_CHAT_KEEP_SCENES', 4, 1, 20),
    budget: { requests: env.SIMPLE_CHAT_BUDGET_REQUESTS ? integer('SIMPLE_CHAT_BUDGET_REQUESTS', 0, 0, 1e9) : undefined,
      tokens: env.SIMPLE_CHAT_BUDGET_TOKENS ? integer('SIMPLE_CHAT_BUDGET_TOKENS', 0, 0, 1e12) : undefined },
  };
}

export function loadModelConfig(directory = process.cwd(), inherited: Env = process.env): ModelConfig {
  return modelConfig(environment(directory, inherited));
}

export function gpuConfig(env: Env, provider: string): GpuConfig | undefined {
  if (!env.SIMPLE_CHAT_VAST_INSTANCE_ID?.trim()) return undefined;
  const instanceId = env.SIMPLE_CHAT_VAST_INSTANCE_ID.trim();
  const apiKey = env.SIMPLE_CHAT_VAST_API_KEY?.trim();
  const sshHost = env.SIMPLE_CHAT_GPU_SSH_HOST || 'simple-chat-vast';
  const idleMinutes = Number(env.SIMPLE_CHAT_GPU_IDLE_MINUTES || 15);
  if (provider !== 'llama-cpp' || !/^[1-9]\d*$/.test(instanceId)
      || !apiKey || /[\r\n]/.test(apiKey) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sshHost)
      || !Number.isSafeInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 120) {
    throw new Error('Invalid GPU control configuration');
  }
  return { instanceId, apiKey, sshHost, idleMinutes };
}

// A hosted API or a consumer Codex account may log requests and train on them. By default they serve synthetic probes
// and never the bot's real stories; the one who runs the bot may accept that for their own stories in so many words.
// The agent interface asks the same: an agent co-author may be given real text as easily as a Telegram user.
function requireHostedConsent(model: ModelConfig, env: Env) {
  if ((model.provider === 'openai-compatible' || model.provider === 'codex-cli') && env.SIMPLE_CHAT_ALLOW_HOSTED !== 'stories-leave-this-computer') {
    throw new Error(`The ${model.provider} provider is for synthetic probes only; SIMPLE_CHAT_ALLOW_HOSTED=stories-leave-this-computer lets the bot use it`);
  }
}

// The path with every symlink resolved, for the part of it that exists.
function canonical(path: string): string {
  try { return realpathSync(path); } catch {}
  const parent = dirname(path);
  return parent === path ? path : join(canonical(parent), basename(path));
}
// One file under two names: a symlink, a symlinked directory or a hard link. Only metadata is read, never the file.
function sameFile(a: string, b: string) {
  if (canonical(a) === canonical(b)) return true;
  try {
    const [x, y] = [statSync(a), statSync(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

// No Telegram token or access list: the agent interface never opens the bot's database. It only needs the bot's
// database path to find the model queue the bot serves next to it (local/background.ts).
export function loadAgentConfig(directory = process.cwd(), inherited: Env = process.env): AgentConfig {
  const env = environment(directory, inherited);
  const model = modelConfig(env);
  requireHostedConsent(model, env);
  const waitSeconds = Number(env.SIMPLE_CHAT_AGENT_WAIT_SECONDS || 20);
  if (!Number.isSafeInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) throw new Error('Invalid SIMPLE_CHAT_AGENT_WAIT_SECONDS');
  const botDb = resolve(directory, env.SIMPLE_CHAT_DB_PATH || 'data/simple-chat.sqlite');
  const dbPath = resolve(directory, env.SIMPLE_CHAT_AGENT_DB_PATH || 'data/agents.sqlite');
  if (sameFile(dbPath, botDb)) throw new Error('SIMPLE_CHAT_AGENT_DB_PATH must not be the bot database');
  return { ...model, dbPath, modelSocket: botDb + '.model.sock', waitSeconds, agentId: env.SIMPLE_CHAT_AGENT_ID || undefined };
}

export function loadConfig(directory = process.cwd(), inherited: Env = process.env): Config {
  const env = environment(directory, inherited);
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Set TELEGRAM_BOT_TOKEN in .env');
  const allowedUsers = new Set((env.SIMPLE_CHAT_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!allowedUsers.size || [...allowedUsers].some(id => !/^\d+$/.test(id))) throw new Error('Set numeric SIMPLE_CHAT_ALLOWED_USER_IDS in .env');
  const model = modelConfig(env);
  requireHostedConsent(model, env);
  const gpu = gpuConfig(env, model.provider);
  if (gpu && model.baseUrl !== 'http://127.0.0.1:8080') throw new Error('Managed GPU requires the local SSH tunnel on port 8080');
  // The bot log marks the owner's rows with this ID. A mistyped one would mark them as someone else's without a word.
  const ownerId = env.SIMPLE_CHAT_OWNER_ID?.trim() || '';
  if (ownerId && !allowedUsers.has(ownerId)) throw new Error('SIMPLE_CHAT_OWNER_ID must be one of SIMPLE_CHAT_ALLOWED_USER_IDS');
  return { ...model, gpu, token, allowedUsers, ownerId,
    dbPath: resolve(directory, env.SIMPLE_CHAT_DB_PATH || 'data/simple-chat.sqlite') };
}
