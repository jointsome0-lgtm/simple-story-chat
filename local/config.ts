import { readFileSync, realpathSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';

export type Env = NodeJS.Dict<string>;
export type ModelConfig = {
  provider: 'claude-code' | 'codex-cli' | 'llama-cpp' | 'openai-compatible' | 'simple-serving'; model: string; baseUrl: string | undefined; apiKey: string; temperature: number;
  memoryMode: 'plain' | 'sgr'; repairCoverage: boolean; timeoutMs: number; contextTokens: number; maxOutputTokens: number;
  compactAtTokens: number; keepScenes: number;
  // llama.cpp: the server's slots, whether they share one KV cache (`--kv-unified`) and how many cells that is.
  // With isolated slots `poolTokens` is `contextTokens`: one slot holds one request.
  slots: number; poolTokens: number; sharedCache: boolean;
  // Overrides of the daily cap of a hosted API's channel; see budget.ts.
  budget: { requests: number | undefined; tokens: number | undefined };
};
export type GpuConfig = { instanceId: string; apiKey: string; sshHost: string; idleMinutes: number };
// A picture under each scene (docs/illustrations-plan.md), off unless SIMPLE_CHAT_IMAGE_URL is set. `style` is the
// one fixed style line of every prompt; without it the line the six steps were measured with is used
// (local/illustrate.ts `STYLE`). `users` are the Telegram IDs whose scenes may be drawn — nobody by default.
export type ImageConfig = {
  url: string; workflow: string; checkpoint: string; style: string | undefined; users: Set<string>;
  waitMs: number; timeoutMs: number;
};
export type Config = ModelConfig & { gpu: GpuConfig | undefined; images: ImageConfig | undefined; token: string; allowedUsers: Set<string>; ownerId: string; dbPath: string };
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
  try { url = new URL(String(value)); } catch { throw new Error('Set SIMPLE_CHAT_BASE_URL to the model server root'); }
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
  if (provider !== 'claude-code' && provider !== 'codex-cli' && provider !== 'llama-cpp' && provider !== 'openai-compatible'
      && provider !== 'simple-serving') throw new Error('Unsupported SIMPLE_CHAT_PROVIDER');
  // simple-serving is our gateway on the card (local/serving.ts): its root, like llama-server's, is HTTPS or loopback.
  const baseUrl = provider === 'llama-cpp' || provider === 'simple-serving' ? modelBaseUrl(env.SIMPLE_CHAT_BASE_URL)
    : provider === 'openai-compatible' ? apiBaseUrl(env.SIMPLE_CHAT_BASE_URL) : undefined;
  const apiKey = env.SIMPLE_CHAT_API_KEY?.trim() || '';
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid SIMPLE_CHAT_API_KEY');
  // The gateway asks every request for its key, over the tunnel too.
  if (provider === 'simple-serving' && !apiKey) throw new Error('Set SIMPLE_CHAT_API_KEY to the gateway key');
  if (baseUrl?.startsWith('https:') && !apiKey) throw new Error('Set SIMPLE_CHAT_API_KEY for a remote HTTPS server');
  const temperature = Number(env.SIMPLE_CHAT_TEMPERATURE || '0.8');
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('Invalid SIMPLE_CHAT_TEMPERATURE');
  if (provider === 'openai-compatible' && !env.SIMPLE_CHAT_MODEL) throw new Error('Set SIMPLE_CHAT_MODEL for the hosted API');
  // Which models a Codex account may use depends on its plan, so there is no safe default.
  if (provider === 'codex-cli' && !env.SIMPLE_CHAT_MODEL) throw new Error('Set SIMPLE_CHAT_MODEL for the Codex CLI');
  // The gateway serves one model under the name its operator gave it and refuses any other.
  if (provider === 'simple-serving' && !env.SIMPLE_CHAT_MODEL) throw new Error('Set SIMPLE_CHAT_MODEL to the model name the gateway serves');
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
  // A pool (scheduler.ts) needs a server started with the same slots (gpu/serve.sh). By default each slot holds its own
  // request of `contextTokens` and nothing is divided. `SIMPLE_CHAT_GPU_KV_UNIFIED=true` is llama.cpp's `--kv-unified`:
  // the slots then share `SIMPLE_CHAT_POOL_TOKENS` cells and the scheduler admits calls by size. A simple-serving
  // gateway has no slots to place a call in, so over it, as over every other provider, the scheduler runs one lane.
  const slots = provider === 'llama-cpp' ? integer('SIMPLE_CHAT_GPU_SLOTS', 1, 1, 8) : 1;
  const unified = env.SIMPLE_CHAT_GPU_KV_UNIFIED || 'false';
  if (!['true', 'false'].includes(unified)) throw new Error('Invalid SIMPLE_CHAT_GPU_KV_UNIFIED');
  const sharedCache = unified === 'true';
  const poolTokens = slots > 1 && sharedCache ? integer('SIMPLE_CHAT_POOL_TOKENS', contextTokens, contextTokens, 131072) : contextTokens;
  return {
    slots, poolTokens, sharedCache,
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
  // A gateway's card may stop only after the gateway has drained its requests (simple-serving's contract, section 8),
  // which the bot does not do yet. Until then that card is started and stopped by hand.
  if (provider === 'simple-serving') throw new Error('GPU control does not work with simple-serving yet: unset SIMPLE_CHAT_VAST_INSTANCE_ID and run the card by hand');
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

// The picture lane, which is a second card and never this computer's or the language model's (the plan's "Two
// constraints that do not bend": the language model holds 22-25 GB of the 32, and the image model needs its own).
// `SIMPLE_CHAT_IMAGE_URL` is therefore the loopback end of the ssh tunnel to that other machine, as
// `gpu/tunnel.sh --pictures` forwards it (127.0.0.1:8188), and never a published address: a scene is drawn from a
// reader's own text, so it may leave this computer only through a tunnel to a card we run.
//
//   SIMPLE_CHAT_IMAGE_URL=http://127.0.0.1:8188
//   SIMPLE_CHAT_IMAGE_WORKFLOW=gpu/image-workflow-qwen.json   # the graph, in ComfyUI's API format
//   SIMPLE_CHAT_IMAGE_CHECKPOINT=qwen_image_2.1_int8_convrot.safetensors
//   SIMPLE_CHAT_IMAGE_USERS=123456789                         # the readers who get pictures; nobody by default
//   SIMPLE_CHAT_IMAGE_STYLE=...                               # optional; the measured style line is the default
//   SIMPLE_CHAT_IMAGE_WAIT_SECONDS=180                        # optional; how long one picture may take
//
// Without SIMPLE_CHAT_IMAGE_URL nothing is described and nothing is drawn: no second model call, no status line.
// The graphs in gpu/ end in a node that saves the picture into ComfyUI's own output directory, where nothing of
// ours can delete it again; the bot loads such a node as a preview one, so the card keeps no copy of a reader's
// scene (local/image-batch.ts `previewOnly`). The batch harness on a rented card draws synthetic scenes and keeps
// whatever its --workflow says.
//
// The three names of this computer, and one card as the two tunnels name it: a host and a port, with the port the
// scheme implies when the address leaves it out.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const cardOf = (url: URL) =>
  `${LOOPBACK.includes(url.hostname) ? '127.0.0.1' : url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
export function imageConfig(env: Env, directory: string, allowedUsers: Set<string>, modelUrl: string | undefined): ImageConfig | undefined {
  const raw = env.SIMPLE_CHAT_IMAGE_URL?.trim();
  if (!raw) return undefined;
  let url;
  try { url = new URL(raw); } catch { throw new Error('Set SIMPLE_CHAT_IMAGE_URL to the tunnelled ComfyUI root, such as http://127.0.0.1:8188'); }
  if (url.protocol !== 'http:' || !LOOPBACK.includes(url.hostname)
      || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('SIMPLE_CHAT_IMAGE_URL must be a loopback HTTP root: ComfyUI is reached through an ssh tunnel, never published');
  }
  // One card cannot hold both models, and a picture drawn on the language model's card stops the stories while it
  // draws. The two tunnels are two ports on loopback, so the card is the host and the port — and loopback has three
  // spellings, which is why `localhost:8080` and `[::1]:8080` must not pass as a second card for `127.0.0.1:8080`.
  let ownCard: string | undefined;
  try { ownCard = modelUrl ? cardOf(new URL(modelUrl)) : undefined; } catch { ownCard = undefined; }
  if (ownCard && cardOf(url) === ownCard) {
    throw new Error('SIMPLE_CHAT_IMAGE_URL must be the second card\'s tunnel, not the language model\'s own server');
  }
  const workflow = env.SIMPLE_CHAT_IMAGE_WORKFLOW?.trim();
  if (!workflow) throw new Error('Set SIMPLE_CHAT_IMAGE_WORKFLOW to a ComfyUI graph exported in API format, such as gpu/image-workflow-qwen.json');
  const checkpoint = env.SIMPLE_CHAT_IMAGE_CHECKPOINT?.trim();
  // The name of a file in the card's own checkpoints directory: a name, never a path of ours.
  if (!checkpoint || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(checkpoint)) {
    throw new Error('Set SIMPLE_CHAT_IMAGE_CHECKPOINT to the checkpoint file name on the picture card');
  }
  const style = env.SIMPLE_CHAT_IMAGE_STYLE?.trim() || undefined;
  if (style && /[\r\n]/.test(style)) throw new Error('SIMPLE_CHAT_IMAGE_STYLE must be one line');
  // Whose scenes may be drawn. Everyone else reads as before: no status line, no description call, no picture.
  // A reader not on the access list could never have a scene here at all, so a stray ID is a typo, not a wish.
  const users = new Set((env.SIMPLE_CHAT_IMAGE_USERS || '').split(',').map(one => one.trim()).filter(Boolean));
  for (const user of users) {
    if (!/^\d+$/.test(user)) throw new Error('SIMPLE_CHAT_IMAGE_USERS must be numeric Telegram IDs');
    if (!allowedUsers.has(user)) throw new Error('Every SIMPLE_CHAT_IMAGE_USERS entry must be one of SIMPLE_CHAT_ALLOWED_USER_IDS');
  }
  const seconds = Number(env.SIMPLE_CHAT_IMAGE_WAIT_SECONDS || 180);
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 1800) throw new Error('Invalid SIMPLE_CHAT_IMAGE_WAIT_SECONDS');
  // One HTTP request of the picture lane is a submit, a poll or a download through the tunnel, never the drawing
  // itself: it may be short even when a picture may take minutes.
  return { url: url.origin, workflow: resolve(directory, workflow), checkpoint, style, users,
    waitMs: seconds * 1000, timeoutMs: Math.min(60000, seconds * 1000) };
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
  return { ...model, gpu, images: imageConfig(env, directory, allowedUsers, model.baseUrl), token, allowedUsers, ownerId,
    dbPath: resolve(directory, env.SIMPLE_CHAT_DB_PATH || 'data/simple-chat.sqlite') };
}
