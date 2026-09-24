import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { createApi } from './telegram.ts';
import { createModel } from './model.ts';
import type { GenerationResult, ModelRequest } from './model.ts';
import { createBot } from './bot.ts';
import type { Update } from './bot.ts';
import { fileURLToPath } from 'node:url';
import { createIllustrator, encoderTokens, textTokens } from './picture.ts';
import { loadTokenizers } from './tokenizer.ts';
import { render, scenePrefix, sceneKeyboard } from './ui.ts';
import { commandSets } from './text.ts';
import { createSeedFileReader } from './seed-file.ts';
import { createVast } from './vast.ts';
import { createGpu, queueOptions } from './gpu.ts';
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
  scheduler = createScheduler(rawProvider, { log,
    slots: config.slots, poolTokens: config.poolTokens, sharedCache: config.sharedCache,
    outputTokens: request => request.maxOutputTokens,
    // Without GPU control there is no socket, and no agent or probe work here.
    ...gpu ? queueOptions(gpu, { pool: config.slots > 1 })
      : { backgroundAllowed: () => false, agentCanStart: () => false, agentCanRun: () => false },
  });
  const provider = scheduler.foreground;
  const api = createApi(config.token);
  const me = await api('getMe');
  // Bot API results are not validated; this call returns a WebhookInfo object.
  const webhook = await api('getWebhookInfo') as { url?: string };
  if (webhook.url) throw new Error('webhook_configured');
  store = new Store(config.dbPath);
  store.recover(log);
  if (gpu) background = await serveBackground({ socketPath: config.dbPath + '.model.sock', scheduler,
    status: () => ({ model: config.model, contextTokens: config.contextTokens, gpu: gpu!.snapshot() }) });
  // Pictures under the scenes, if this computer has a second card tunnelled for them (docs/illustrations-plan.md).
  // The graph is read and checked here, at startup: a workflow that is not a ComfyUI API export must fail now and
  // not under the first reader who gets a scene.
  // The note under each picture counts the prompt in the picture model's tokens when `npm run tokenizers` has written
  // the vocabulary (docs/tokenizers.md). A missing or broken file costs the count alone: the note gives characters.
  // The characters' card counts each field of a sheet the same way, on its own.
  const tokenizers = loadTokenizers(fileURLToPath(new URL('../tokenizers', import.meta.url)));
  const counter = (count: typeof encoderTokens) => (graph: Parameters<typeof encoderTokens>[1]) => {
    try {
      const qwen = tokenizers.qwen();
      return qwen && count(qwen, graph);
    } catch (error) { log('tokenizer_unreadable', undefined, error); return undefined; }
  };
  const illustrator = config.images ? createIllustrator(config.images, { store, provider,
    model: { model: config.model, provider: config.provider, contextTokens: config.contextTokens },
    promptTokens: counter(encoderTokens), textTokens: counter(textTokens) }) : undefined;
  if (config.images) log('pictures_configured');
  bot = createBot({ store, api, provider, gpu, illustrator, providerName: config.provider, readSeedFile: createSeedFileReader(config.token, api), render, scenePrefix, sceneKeyboard,
    allowedUsers: config.allowedUsers, ownerId: config.ownerId, maxOutputTokens: config.maxOutputTokens,
    contextTokens: config.contextTokens, compactAtTokens: config.compactAtTokens,
    keepScenes: config.keepScenes, memoryMode: config.memoryMode, repairCoverage: config.repairCoverage, model: config.model, log });
  // Telegram shows the list that matches the language of the user's app, and the first, English one to everyone else.
  for (const commands of commandSets(!!gpu, !!illustrator)) await api('setMyCommands', commands);
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
