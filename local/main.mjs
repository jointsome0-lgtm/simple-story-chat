import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.mjs';
import { Store } from './store.mjs';
import { createApi } from './telegram.mjs';
import { createModel } from './model.mjs';
import { createBot } from './bot.mjs';
import { render, scenePrefix, sceneKeyboard } from './ui.mjs';
import { createSeedFileReader } from './seed-file.mjs';
import { createVast } from './vast.mjs';
import { createGpu } from './gpu.mjs';
import { createGpuConnection } from './gpu-connection.mjs';
import { createScheduler } from './scheduler.mjs';
import { serveBackground } from './background.mjs';
import { safeErrorDetails } from './model-error.mjs';

process.umask(0o077);
const log = (event, code, error) => console.log(JSON.stringify({ at: new Date().toISOString(), event,
  ...(typeof code === 'number' || /^[a-z_]{1,40}$/.test(code || '') ? { code } : {}), ...safeErrorDetails(error) }));
let store;
let bot;
let gpu;
let gpuTimer;
let scheduler;
let background;
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; void bot?.stop(); });
try {
  const config = loadConfig();
  const rawProvider = createModel(config);
  if (config.gpu) {
    gpu = createGpu({ api: createVast(config.gpu), connection: createGpuConnection(config.gpu.sshHost, { log }),
      check: controls => rawProvider.check(controls), idleMinutes: config.gpu.idleMinutes, log });
    await gpu.tick();
    gpuTimer = setInterval(() => { void gpu.tick(); }, 10000);
  } else await rawProvider.check?.();
  scheduler = createScheduler(rawProvider, { log,
    backgroundAllowed: () => {
      const state = gpu?.snapshot();
      return state?.status === 'ready' && state.activeJobs === 0 && state.idleRemainingSeconds > 100;
    },
  });
  const provider = scheduler.foreground;
  const api = createApi(config.token);
  const me = await api('getMe');
  const webhook = await api('getWebhookInfo');
  if (webhook.url) throw new Error('webhook_configured');
  store = new Store(config.dbPath);
  store.recover();
  if (gpu) background = await serveBackground({ socketPath: config.dbPath + '.model.sock', scheduler,
    status: () => ({ model: config.model, contextTokens: config.contextTokens, gpu: gpu.snapshot() }) });
  bot = createBot({ store, api, provider, gpu, providerName: config.provider, readSeedFile: createSeedFileReader(config.token, api), render, scenePrefix, sceneKeyboard,
    allowedUsers: config.allowedUsers, maxOutputTokens: config.maxOutputTokens,
    contextTokens: config.contextTokens, compactAtTokens: config.compactAtTokens,
    keepScenes: config.keepScenes, memoryMode: config.memoryMode, repairCoverage: config.repairCoverage, model: config.model, log });
  await api('setMyCommands', { commands: [
    { command: 'menu', description: 'Меню историй' }, { command: 'seeds', description: 'Мои сиды' },
    { command: 'new', description: 'Создать сид' }, { command: 'checkpoints', description: 'Сцены и чекпоинты' },
    { command: 'continue', description: 'Продолжить историю' }, { command: 'last', description: 'Показать последнюю сцену' },
    { command: 'context', description: 'Размер контекста и счётчики токенов' },
    { command: 'compact', description: 'Сжать ранние сцены в память сейчас' },
    { command: 'model', description: 'Текущая модель и подключение' },
    ...(gpu ? [{ command: 'gpu_pause', description: 'Пауза GPU после завершения работы' },
      { command: 'gpu_start', description: 'Запустить арендованную GPU' }] : []),
    { command: 'cancel', description: 'Отменить ввод или генерацию' },
  ] });
  log('bot_ready');
  // This is bot processing, not a developer transcript export. Only authorized
  // private chats reach storage; no incoming text is printed or logged.
  while (!stopped) {
    try {
      const updates = await api('getUpdates', { offset: store.offset(), timeout: 25, limit: 10,
        allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        if (stopped) break;
        await bot.handle(update);
        store.offset(update.update_id + 1);
      }
    } catch (error) {
      log('poll_failed', error.code);
      if (error.code === 401 || error.code === 409) { stopped = true; process.exitCode = 1; }
      else await delay(Math.min(30, error.retryAfter || 3) * 1000);
    }
  }
  await bot.stop();
  log('bot_stopped');
} catch (error) {
  log('startup_failed', error.code || (/^[a-z_]+$/.test(error.message) ? error.message : undefined));
  process.exitCode = 1;
} finally {
  clearInterval(gpuTimer);
  await background?.close();
  await scheduler?.close();
  await gpu?.close();
  store?.close();
}
