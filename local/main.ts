import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { createApi } from './telegram.ts';
import { createModel } from './model.ts';
import type { GenerationResult, ModelRequest } from './model.ts';
import { createBot } from './bot.ts';
import type { Update } from './bot.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { commandSets } from './text.ts';
import { createSeedFileReader } from './seed-file.ts';
import { createVast } from './vast.ts';
import { createGpu } from './gpu.ts';
import type { GpuController } from './gpu.ts';
import { createGpuConnection } from './gpu-connection.ts';
import { createScheduler } from './scheduler.ts';
import type { Scheduler } from './scheduler.ts';
import { serveBackground } from './background.ts';
import type { Log } from './model-error.ts';
import { safeErrorDetails } from './model-error.ts';

// Thrown values are not checked: startup and polling failures are Error objects,
// and Telegram, model and GPU errors add a code (Telegram errors also a retry delay).
type Failure = Error & { code?: string | number; retryAfter?: number };

process.umask(0o077);
const log: Log = (event, code, error) => console.log(JSON.stringify({ at: new Date().toISOString(), event,
  ...(typeof code === 'number' || /^[a-z_]{1,40}$/.test(code || '') ? { code } : {}), ...safeErrorDetails(error) }));
let store: Store | undefined;
let bot: ReturnType<typeof createBot> | undefined;
// Set once during startup and never cleared, so closures created after that use it directly.
let gpu: GpuController | undefined;
let gpuTimer: NodeJS.Timeout | undefined;
let scheduler: Scheduler<ModelRequest, GenerationResult> | undefined;
let background: Awaited<ReturnType<typeof serveBackground>> | undefined;
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; void bot?.stop(); });
try {
  const config = loadConfig();
  const rawProvider = createModel(config);
  if (config.gpu) {
    // GPU control is configured only for llama.cpp, which has a health check.
    gpu = createGpu({ api: createVast(config.gpu), connection: createGpuConnection(config.gpu.sshHost, { log }),
      check: controls => rawProvider.check!(controls), idleMinutes: config.gpu.idleMinutes, log });
    await gpu.tick();
    // An instance that came back up runs a server with empty caches, which a pool must stop reserving room for.
    let starts = gpu.snapshot().starts;
    gpuTimer = setInterval(() => { void gpu!.tick().then(state => {
      if (state.starts === starts) return;
      starts = state.starts;
      scheduler?.forget();
    }); }, 10000);
  } else await rawProvider.check?.();
  const pool = config.slots > 1;
  scheduler = createScheduler(rawProvider, { log,
    slots: config.slots, poolTokens: config.poolTokens, sharedCache: config.sharedCache,
    outputTokens: request => request.maxOutputTokens,
    backgroundAllowed: () => {
      const state = gpu?.snapshot();
      // Without an idle deadline (null) background work is not allowed.
      return state?.status === 'ready' && state.activeJobs === 0 && (state.idleRemainingSeconds ?? 0) > 100;
    },
    // An agent turn holds the GPU through the idle countdown, so it starts only if it can end before it, and never extends it.
    // In a pool it also starts beside people's jobs, which keep the GPU up anyway.
    agentCanStart: () => {
      const state = gpu?.snapshot();
      return state?.status === 'ready' && (pool && state.activeJobs > 0
        || state.activeJobs === 0 && (state.idleRemainingSeconds ?? 0) > config.timeoutMs / 1000 + 100);
    },
    // Without GPU control there is no socket and no agent work here. A started agent turn holds the GPU, which then
    // drains instead of pausing under it; a stopped or failing GPU stops the turn.
    agentCanRun: () => ['ready', 'draining'].includes(gpu?.snapshot().status ?? ''),
    holdAgentTurn: () => gpu ? gpu.hold() : () => {},
  });
  const provider = scheduler.foreground;
  const api = createApi(config.token);
  const me = await api('getMe');
  // Bot API results are not validated; this call returns a WebhookInfo object.
  const webhook = await api('getWebhookInfo') as { url?: string };
  if (webhook.url) throw new Error('webhook_configured');
  store = new Store(config.dbPath);
  store.recover();
  if (gpu) background = await serveBackground({ socketPath: config.dbPath + '.model.sock', scheduler,
    status: () => ({ model: config.model, contextTokens: config.contextTokens, gpu: gpu!.snapshot() }) });
  bot = createBot({ store, api, provider, gpu, providerName: config.provider, readSeedFile: createSeedFileReader(config.token, api), render, scenePrefix, sceneKeyboard,
    allowedUsers: config.allowedUsers, ownerId: config.ownerId, maxOutputTokens: config.maxOutputTokens,
    contextTokens: config.contextTokens, compactAtTokens: config.compactAtTokens,
    keepScenes: config.keepScenes, memoryMode: config.memoryMode, repairCoverage: config.repairCoverage, model: config.model, log });
  // Telegram shows the list that matches the language of the user's app, and the first, English one to everyone else.
  for (const commands of commandSets(!!gpu)) await api('setMyCommands', commands);
  log('bot_ready');
  // This is bot processing, not a developer transcript export. Only authorized
  // private chats reach storage; no incoming text is printed or logged.
  while (!stopped) {
    try {
      // Bot API results are not validated; this call returns a list of updates.
      const updates = await api('getUpdates', { offset: store.offset(), timeout: 25, limit: 10,
        allowed_updates: ['message', 'callback_query'] }) as Update[];
      for (const update of updates) {
        if (stopped) break;
        await bot.handle(update);
        store.offset(update.update_id + 1);
      }
    } catch (error) {
      const failure = error as Failure;
      log('poll_failed', failure.code);
      if (failure.code === 401 || failure.code === 409) { stopped = true; process.exitCode = 1; }
      else await delay(Math.min(30, failure.retryAfter || 3) * 1000);
    }
  }
  await bot.stop();
  log('bot_stopped');
} catch (error) {
  const failure = error as Failure;
  log('startup_failed', failure.code || (/^[a-z_]+$/.test(failure.message) ? failure.message : undefined));
  process.exitCode = 1;
} finally {
  clearInterval(gpuTimer);
  await background?.close();
  await scheduler?.close();
  await gpu?.close();
  store?.close();
}
