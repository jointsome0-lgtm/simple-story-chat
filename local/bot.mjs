import { UserError, id, active, addSeed, newStory, fork, beginJob, commitTurn, saveCheckpoint,
  deleteSeed, deleteBranch, history, context, jobTarget } from '../lib/library.js';
import { normalizeScene } from './prompt.mjs';
import { createChat } from './telegram.mjs';
import { CONTINUE, contextStats, requestStamp } from './context.mjs';
import { generateScene, compactBranch } from './generation.mjs';
import { messageText, seedInput } from './incoming.mjs';
import { SEED_BYTES } from './seed-file.mjs';
import { createProgress } from './progress.mjs';
import { renderCompaction } from './compact-view.mjs';

export function createBot({ store, api, provider, gpu, readSeedFile, render: renderUi, scenePrefix = () => '', sceneKeyboard, allowedUsers, maxOutputTokens,
  contextTokens = 65536, compactAtTokens = 54000, keepScenes = 4, memoryMode = 'plain', repairCoverage = false, model = 'unknown', providerName = 'claude-code', log = () => {} }) {
  const running = new Map();
  const modelInfo = { provider: providerName, model, status: 'configured', checkedAt: null };
  const render = (state, route, details = {}) => renderUi(state, route, { ...details, modelInfo: { ...modelInfo }, gpuInfo: gpu?.snapshot() });
  const requireGpu = () => {
    if (!gpu) return;
    try { gpu.assertReady(); }
    catch { throw new UserError('GPU сейчас не готова. Открой /model: там можно запустить её или проверить состояние. Затем отправь действие снова.'); }
  };
  const modelResponded = () => Object.assign(modelInfo, { status: 'ready', checkedAt: new Date().toISOString() });
  const contextConfig = { maxOutputTokens, contextTokens, compactAtTokens, keepScenes, memoryMode, repairCoverage, model, provider: providerName };
  const stats = (state, selection) => {
    try { return contextStats(state, contextConfig, selection); } catch { return null; }
  };
  const screen = (state, route) => {
    const [name, storyId, checkpointId] = route.split(':');
    const selection = checkpointId ? { storyId, checkpointId } : undefined;
    return render(state, route, { contextStats: name === 'context' || name === 'checkpoint' ? stats(state, selection) : undefined });
  };
  const safeSend = async (chat, screen) => {
    try { await chat.send(screen); log('screen_sent'); } catch (error) { log('telegram_send_failed', error.code); }
  };
  const last = state => {
    const { story, branch, seed } = active(state);
    const node = story.nodes[branch.head];
    return { text: node?.text ?? `${seed.startTime}\n\n${seed.text}`, modelInfo: node?.modelInfo };
  };
  function prepare(state, update, fileInput) {
    let action = update.callback_query?.data;
    if (fileInput?.error) throw fileInput.error;
    if (fileInput && (state.ui?.input !== 'seed' || state.ui.draftId !== fileInput.draftId)) {
      throw new UserError('Черновик изменился во время загрузки. Файл не добавлен; открой /new и отправь его снова.');
    }
    const text = fileInput ? fileInput.text : messageText(update.message);
    if (!action && !fileInput) {
      const command = text?.split(/[\s@]/)[0];
      const current = state.active;
      const commands = {
        '/start': 'view:home', '/menu': 'view:home', '/seeds': 'view:seeds:0',
        '/new': 'new-seed', '/continue': 'continue', '/cancel': 'cancel', '/last': 'last',
        '/context': 'view:context', '/compact': 'compact', '/model': 'view:model',
        '/gpu': 'view:model', '/gpu_pause': 'gpu:pause', '/gpu_start': 'gpu:start',
        '/checkpoints': current ? `view:checkpoints:${current.storyId}:${current.branchId}:0` : 'view:seeds:0',
      };
      action = commands[command];
      if (!action && text?.startsWith('/') && state.ui?.input !== 'seed') return { screen: { text: 'Не знаю такой команды. Открой /menu.' } };
    }
    if (action === 'cancel') {
      const hadJob = !!state.job;
      state.job = null;
      state.ui = null;
      return { cancel: true, screen: { ...render(state, 'home'), text: (hadJob ? 'Операция отменена. Готовые сцены и чекпоинты сохранены.\n\n' : '') + render(state, 'home').text } };
    }
    // Power controls remain available during a seed draft or a model job.
    if (action === 'gpu:pause' || action === 'gpu:start') return { gpuAction: action.slice(4) };
    if (action === 'view:model') return { modelStatus: true };
    // A paste may arrive as many ordinary Telegram messages. Keep the draft
    // open until an explicit, draft-specific save; navigation must not turn
    // later fragments into instructions for a previously active story.
    if (state.ui?.input === 'seed') {
      const draft = state.ui;
      draft.draftId ??= id(state, 'd');
      draft.parts ??= [];
      if (action?.startsWith('save-seed:')) {
        if (action !== `save-seed:${draft.draftId}`) throw new UserError('Эта кнопка относится к другому черновику. Используй «Сохранить сид» под последней принятой частью.');
        try {
          const seed = addSeed(state, seedInput(draft.parts.join('\n\n')));
          state.ui = null;
          return { screen: render(state, `seed:${seed.id}`) };
        } catch (error) {
          if (!(error instanceof UserError)) throw error;
          const view = render(state, 'new-seed');
          return { screen: { ...view, text: error.message + '\n\n' + view.text } };
        }
      }
      if (!action) {
        if (!text) throw new UserError('Пришли следующую часть сида текстом. Когда закончишь, нажми «Сохранить сид». /cancel отменит ввод.');
        if (Buffer.byteLength([...draft.parts, text].join('\n\n'), 'utf8') > SEED_BYTES) {
          throw new UserError('Эта часть превышает общий предел черновика — 256 КиБ текста. Она не добавлена; предыдущие части остаются в черновике. /cancel отменит ввод.');
        }
        draft.parts.push(text);
      }
      return { screen: render(state, 'new-seed') };
    }
    if (action?.startsWith('save-seed:')) throw new UserError('Этот черновик уже сохранён или отменён. Новый сид можно создать через /new.');
    if (action?.startsWith('view:')) {
      const route = action.slice(5);
      state.ui = route.startsWith('delete-seed:') ? { confirm: route.replace('delete-seed:', 'remove-seed:') }
        : route.startsWith('delete-branch:') ? { confirm: route.replace('delete-branch:', 'remove-branch:') } : null;
      return { screen: screen(state, route) };
    }
    if (action === 'last') return { savedText: last(state) };
    if (action === 'new-seed') {
      if (state.job) throw new UserError('Сцена уже пишется. Дождись ответа или нажми /cancel, затем создай сид.');
      state.ui = { input: 'seed', draftId: id(state, 'd'), parts: [] };
      return { screen: render(state, 'new-seed') };
    }
    if (state.job) throw new UserError('Уже выполняется генерация или сжатие. Дождись ответа или нажми /cancel, затем отправь сообщение снова.');
    if (action === 'compact') {
      const { story, branch } = active(state);
      if (context(story, branch).recent.length <= keepScenes) {
        return { screen: { text: `Пока нечего сжимать: последние ${keepScenes} сцены оставляем целиком. Новая сцена не создаётся.` } };
      }
      requireGpu();
      state.ui = null;
      const job = beginJob(state, CONTINUE, Date.now());
      job.kind = 'compact';
      return { job };
    }
    const [verb, a, b] = (action || '').split(':');
    if (verb === 'remove-seed' || verb === 'remove-branch') {
      if (state.ui?.confirm !== action) throw new UserError('Это подтверждение устарело. Открой удаление заново через /seeds.');
      if (verb === 'remove-seed') deleteSeed(state, a);
      else deleteBranch(state, a, b);
      return { screen: render(state, 'seeds:0') };
    }
    if (verb === 'use') {
      const story = state.stories[a];
      if (!story?.branches[b]) throw new UserError('Эта ветка уже удалена. Открой /seeds.');
      state.active = { storyId: a, branchId: b };
      state.ui = null;
      return { savedText: last(state), screen: render(state, `branch:${a}:${b}`) };
    }
    if (verb === 'fork') {
      const branch = fork(state, a, b);
      state.ui = null;
      return { savedText: last(state), screen: render(state, `branch:${a}:${branch.id}`) };
    }
    let input = text;
    if (verb === 'start') {
      requireGpu();
      newStory(state, a);
      input = 'Начни историю из сида. Покажи первую сцену.';
    } else if (action === 'continue') input = CONTINUE;
    else if (action) throw new UserError('Кнопка устарела. Открой /menu.');
    if (!input) return { screen: { text: 'Пока поддерживаются текстовые сообщения. Открой /menu или напиши действие персонажа.' } };
    if (!state.active) return { screen: render(state, 'home') };
    requireGpu();
    state.ui = null;
    state.interrupted = false;
    const job = beginJob(state, input, Date.now());
    return { job };
  }

  async function generate(userId, chat, job, controller, releaseGpu) {
    const progress = createProgress({ chat, render: renderCompaction, signal: controller.signal, log });
    let compactionStatus;
    const onProgress = event => {
      compactionStatus = { ...compactionStatus, ...event, automatic: job.kind !== 'compact' };
      progress.update(compactionStatus);
    };
    try {
      if (job.kind === 'compact') {
        const result = await compactBranch({ store, userId, jobId: job.id, provider,
          config: contextConfig, signal: controller.signal, onProgress });
        const completed = store.mutate(userId, state => {
          if (controller.signal.aborted || !jobTarget(state, job.id)) return false;
          state.job = null;
          return true;
        });
        if (!completed) return;
        modelResponded();
        log('memory_compacted');
        if (!await progress.finish()) await safeSend(chat, renderCompaction({ ...compactionStatus, stage: 'done', ...result }));
        return;
      }
      const { result, request } = await generateScene({ store, userId, jobId: job.id, provider,
        config: contextConfig, signal: controller.signal, onProgress,
        preview: (state, current, request) => {
          const measured = stats(state);
          if (measured) measured.request.estimatedTokens = request.estimatedInputTokens;
          return chat.preview(current.id, scenePrefix(measured, modelInfo));
        },
      });
      if (controller.signal.aborted) return;
      modelResponded();
      if (result.streamResultMismatch) log('model_result_differs_from_stream');
      const ref = store.mutate(userId, state => {
        if (state.job?.id !== job.id) return null;
        const story = state.stories[job.storyId];
        const stamp = requestStamp(request, model, state.job.memory, providerName);
        const fallback = story.nodes[job.head]?.time || state.seeds[story.seedId].startTime;
        const committed = commitTurn(state, job.id, normalizeScene(result.text, fallback), result.finishReason === 'length');
        if (!committed) return null;
        story.nodes[committed.nodeId].usage = result.usage ?? null;
        story.nodes[committed.nodeId].requestContext = stamp;
        story.nodes[committed.nodeId].streamResultMismatch = result.streamResultMismatch ?? false;
        story.nodes[committed.nodeId].modelInfo = { provider: providerName, model };
        const branch = story.branches[job.branchId];
        const checkpoint = saveCheckpoint(state, story, branch, `Сцена ${history(story, branch.head).length}`, 'scene');
        return { ...committed, checkpointId: checkpoint.id };
      });
      if (!ref) return;
      const snapshot = store.read(userId);
      const node = snapshot.stories[ref.storyId].nodes[ref.nodeId];
      try {
        // Persisted above. An ambiguous response must never trigger a new model run.
        const prefix = scenePrefix(stats(snapshot, { storyId: ref.storyId, checkpointId: ref.checkpointId }), node.modelInfo);
        const sent = await chat.final(prefix + node.text, sceneKeyboard(snapshot));
        store.mutate(userId, state => {
          const saved = state.stories[ref.storyId]?.nodes[ref.nodeId];
          if (saved) { saved.delivery = 'sent'; saved.messageId = sent.message_id; }
        });
        log('scene_saved_and_sent');
        if (node.truncated) await safeSend(chat, { text: 'Ответ достиг лимита выходных токенов и мог оборваться. Полученный текст сохранён. /continue продолжит историю.' });
      } catch (error) {
        log('scene_delivery_unconfirmed', error.code);
        await safeSend(chat, { text: 'Сцена сохранена, но доставка не подтверждена. /last покажет её без новой генерации.' });
      }
    } catch (error) {
      const stillCurrent = store.mutate(userId, state => {
        if (state.job?.id !== job.id) return false;
        state.job = null;
        return true;
      });
      if (!stillCurrent || controller.signal.aborted) return;
      if (['provider_failed', 'timeout', 'unauthorized', 'model_unavailable', 'unexpected_model'].includes(error.code)) {
        Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
      }
      log('generation_failed', error.code, error);
      const retry = job.kind === 'compact' ? '/compact' : '/continue';
      const text = error.code === 'nothing_to_compact' ? `Пока нечего сжимать: последние ${keepScenes} сцены оставляем целиком.`
        : error.code === 'context_limit'
        ? 'Сид, накопленная память, последние сцены или новый ввод не помещаются в выбранный порог контекста. Все исходные сцены и чекпоинты сохранены. Можно сократить ввод или открыть другую точку через /checkpoints.'
        : error.code === 'invalid_memory' || error.code === 'memory_not_smaller'
          ? `Сжатие не удалось проверить. Исходные сцены и готовые чекпоинты сохранены. Повторить: ${retry}.`
          : `Не получилось завершить операцию. Готовые сцены и чекпоинты сохранены. Повторить: ${retry}.`;
      if (error.operation === 'compact' && compactionStatus?.stage === 'failed') {
        if (!await progress.finish()) await safeSend(chat, renderCompaction(compactionStatus));
        return;
      }
      await safeSend(chat, { text, reply_markup: sceneKeyboard(store.read(userId)) });
    } finally {
      await progress.finish();
      releaseGpu?.();
    }
  }

  return {
    async handle(update) {
      const from = update.callback_query?.from || update.message?.from;
      const chatInfo = update.callback_query?.message?.chat || update.message?.chat;
      const userId = String(from?.id);
      if (from?.is_bot || chatInfo?.type !== 'private' || String(chatInfo.id) !== userId) return;
      if (!allowedUsers.has(userId)) {
        // Keep only the sender ID/time of an explicit access request. Other
        // unauthorized messages never enter storage, logs or a model prompt.
        if (typeof update.message?.text === 'string' && /^\/start(?:@[A-Za-z0-9_]+)?$/.test(update.message.text.trim())) {
          store.requestAccess(userId);
        }
        return;
      }
      const chat = createChat(api, chatInfo.id);
      if (update.callback_query?.id) {
        try { await api('answerCallbackQuery', { callback_query_id: update.callback_query.id }); } catch {}
      }
      let fileInput;
      if (update.message?.document) {
        const state = store.read(userId);
        if (state.seen.includes(update.update_id)) return;
        if (state.ui?.input !== 'seed') {
          fileInput = { error: new UserError('Чтобы загрузить сид файлом, сначала открой /new. Файл не добавлен в историю.') };
        } else {
          const draftId = state.ui.draftId;
          try {
            if (!readSeedFile) throw new Error('file_reader_unavailable');
            fileInput = { draftId, text: await readSeedFile(update.message.document) };
          } catch (error) {
            fileInput = { error: error instanceof UserError ? error : new UserError('Не удалось прочитать файл. Черновик не изменён; отправь файл ещё раз.') };
          }
        }
      }
      const plan = store.mutate(userId, state => {
        if (state.seen.includes(update.update_id)) return null;
        state.seen = [...state.seen.slice(-511), update.update_id];
        try { return prepare(state, update, fileInput); }
        catch (error) {
          if (error instanceof UserError) return { screen: { text: error.message } };
          throw error;
        }
      });
      if (!plan) return;
      if (plan.gpuAction) {
        if (!gpu) await safeSend(chat, { text: 'Управление арендой GPU пока не настроено. /model покажет текущую модель.' });
        else {
          try {
            if (plan.gpuAction === 'pause') gpu.pause(); else gpu.resume();
            void gpu.tick();
          } catch { /* Current controller state is rendered below. */ }
          await safeSend(chat, render(store.read(userId), 'model'));
        }
      }
      if (plan.modelStatus) {
        if (gpu) {
          await gpu.tick();
          if (gpu.snapshot().status === 'ready') modelResponded();
          else Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
        } else if (provider.check) {
          try {
            await provider.check({ signal: AbortSignal.timeout(8000) });
            modelResponded();
          } catch {
            Object.assign(modelInfo, { status: 'unavailable', checkedAt: new Date().toISOString() });
          }
        }
        await safeSend(chat, render(store.read(userId), 'model'));
      }
      if (plan.cancel) running.get(userId)?.controller.abort();
      if (plan.savedText) {
        const snapshot = store.read(userId);
        try { await chat.final(scenePrefix(stats(snapshot), plan.savedText.modelInfo) + plan.savedText.text, sceneKeyboard(snapshot)); }
        catch (error) { log('saved_scene_delivery_unconfirmed', error.code); }
      }
      if (plan.screen) await safeSend(chat, plan.screen);
      if (plan.job) {
        let releaseGpu;
        try { releaseGpu = gpu?.acquire(); }
        catch {
          store.mutate(userId, state => { if (state.job?.id === plan.job.id) state.job = null; });
          await safeSend(chat, { text: 'GPU перешла на паузу. Открой /model и запусти её; затем отправь действие снова.' });
          return;
        }
        const controller = new AbortController();
        const entry = { controller };
        running.set(userId, entry);
        entry.promise = generate(userId, chat, plan.job, controller, releaseGpu).finally(() => {
          if (running.get(userId) === entry) running.delete(userId);
        });
      }
    },
    async idle() { await Promise.all([...running.values()].map(entry => entry.promise)); },
    async stop() {
      for (const entry of running.values()) entry.controller.abort();
      await this.idle();
    },
  };
}
