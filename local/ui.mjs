// Telegram interface for simple-story-chat: pure functions from a user's library to sendMessage payloads.
// Plain text only (no parse_mode), inline keyboards, callbacks <= 64 UTF-8 bytes.

const LIMIT = 4000; // Telegram allows 4096 characters; keep headroom
const PAGE = 8;
const encoder = new TextEncoder();
const ICON = { start: '🌱', fork: '🌿', scene: '🎬', manual: '📌', compaction: '🗜' };

const EXAMPLE = [
  'Маяк на краю света',
  '2026-08-02 20:00',
  'Северный остров, конец лета. Мира, 27 лет, первый вечер работает смотрительницей маяка. К причалу прибивает пустую лодку с зажжённым фонарём.',
].join('\n');

const DELETE_NOTE = 'Удаляется из сохранённой библиотеки бота, восстановить будет нельзя. Уже отправленные сообщения в этом чате останутся.';

export function render(state, route = 'home', details = {}) {
  try {
    return screen(state ?? {}, String(route ?? 'home'), details ?? {});
  } catch {
    return failure();
  }
}

// Detailed context screen, shown only on request (/context or a Context button).
export function renderContext(stats) {
  try {
    if (!stats || typeof stats !== 'object') {
      return payload(['📏 Контекст: данных пока нет.'], [[btn('🏠 Меню', 'view:home')]]);
    }
    return contextView(stats);
  } catch {
    return failure();
  }
}

// One-line Markdown header above a scene in Telegram. Never saved as narrative or sent to the model.
// `provenance` is the scene's own {provider, model}; without it the scene is not labelled.
// Uses only characters that need no escaping in Markdown flavours.
export function scenePrefix(stats, provenance) {
  try {
    const parts = [];
    if (modelKnown(provenance)) {
      parts.push(`🤖 ${PROVIDER[provenance.provider].short} · ${markdownSafe(line(provenance.model, 60))}`);
    }
    const request = stats?.request?.estimatedTokens;
    const limit = stats?.limitTokens;
    if (known(request) && known(limit) && request >= 0 && limit > 0) {
      const percent = (request / limit) * 100;
      const shown = percent > 0 && percent < 1 ? 'менее 1%' : `≈ ${Math.round(percent)}%`;
      const rough = stats.request.estimateSource === 'usage' ? '' : ', грубая оценка';
      parts.push(`📏 Контекст ${shown}${rough}`);
    }
    return parts.length ? `_${parts.join(' · ')}_\n\n` : '';
  } catch {
    return '';
  }
}

export function sceneKeyboard(state) {
  if (!state) return undefined;
  if (state.job) {
    return keyboard([
      [btn('✖️ Остановить', 'cancel')],
      [btn('📏 Контекст', 'view:context'), btn('🤖 Модель', 'view:model'), btn('🏠 Меню', 'view:home')],
    ]);
  }
  const ref = activeRef(state);
  if (!ref) return undefined;
  const { story, branch } = ref;
  return keyboard([
    [btn('▶️ Продолжить', 'continue'), btn('📏 Контекст', 'view:context'), btn('🤖 Модель', 'view:model')],
    [btn('🔖 Чекпоинты', `view:checkpoints:${story.id}:${branch.id}:0`), btn('🌿 Ветки', `view:story:${story.id}`), btn('🏠 Меню', 'view:home')],
  ]);
}

function failure() {
  return payload(['⚠️ Не получилось показать этот экран.', 'Вернись в меню и попробуй ещё раз.'], [[btn('🏠 Меню', 'view:home')]]);
}

function screen(state, route, details) {
  const [name, ...args] = route.split(':');
  switch (name) {
    case 'home': return home(state, null, details.modelInfo, gpuFor(details));
    case 'model': return modelScreen(details.modelInfo, gpuFor(details));
    case 'seeds': return seedList(state, args[0]);
    case 'seed': return seedScreen(state, args[0], args[1]);
    case 'story': return storyScreen(state, args[0], args[1]);
    case 'branch': return branchScreen(state, args[0], args[1]);
    case 'checkpoints': return checkpointList(state, args[0], args[1], args[2]);
    case 'checkpoint': return checkpointScreen(state, args[0], args[1]);
    case 'context': return args.length ? checkpointContextScreen(state, args[0], args[1], details.contextStats) : currentContextScreen(state, details.contextStats);
    case 'delete-seed': return deleteSeedScreen(state, args[0]);
    case 'delete-branch': return deleteBranchScreen(state, args[0], args[1]);
    case 'new-seed': return newSeedScreen(state);
    default: return home(state, '⚠️ Этот экран больше недоступен. Вот меню.', details.modelInfo, gpuFor(details));
  }
}

// Screens

function home(state, note, modelInfo, gpu) {
  const seedCount = values(state.seeds).length;
  const ref = activeRef(state);
  const lines = note ? [note, ''] : [];
  const rows = [];
  lines.push('🏠 Меню', '');
  if (modelKnown(modelInfo)) {
    lines.push(`🤖 ${PROVIDER[modelInfo.provider].short} · ${line(modelInfo.model, 60)} · ${statusShort(modelInfo)}`);
  }
  if (gpu) lines.push(`🖥 GPU: ${gpuShort(gpu)}`);
  if (modelKnown(modelInfo) || gpu) lines.push('');
  if (state.job) {
    const jobStory = own(state.stories, state.job.storyId);
    const job = jobLabel(state);
    lines.push(
      `⏳ ${job.title}${jobStory ? ` в истории ${storyName(state, jobStory)}` : ''}.`,
      `Меню можно листать; удалять, переключать ветки и запускать новые сцены — ${job.after}.`,
      '',
    );
    rows.push(cancelRow(state));
  }
  if (ref) {
    const { story, branch } = ref;
    lines.push(`📖 Сейчас: ${storyName(state, story)}`, `🌿 Ветка ${quote(branch.name)} · ${progress(story, branch)}`);
    if (!state.job) {
      lines.push('', 'Чтобы продолжить, просто напиши сообщение: реплику, действие героя или указание автора. «Продолжить» — следующая сцена без указаний.');
      rows.push([btn('▶️ Продолжить', 'continue'), branch.head ? btn('📄 Последняя сцена', 'last') : null]);
    } else if (branch.head) {
      rows.push([btn('📄 Последняя сцена', 'last')]);
    }
    rows.push([
      btn('🔖 Чекпоинты', `view:checkpoints:${story.id}:${branch.id}:0`),
      btn('🌿 Ветки', `view:story:${story.id}`),
      btn('📏 Контекст', 'view:context'),
    ]);
  } else if (seedCount) {
    lines.push('История не выбрана.', 'Открой сид, чтобы начать новую историю или вернуться к начатой.');
  } else {
    lines.push(
      'Здесь пока пусто.',
      'Сид — это мир, персонаж и стартовая ситуация. Из одного сида можно начать сколько угодно историй.',
      '',
      'Создай первый сид: пришли описание одним или несколькими сообщениями и сохрани.',
    );
  }
  rows.push([seedCount ? btn(`📚 Сиды (${seedCount})`, 'view:seeds:0') : null, btn('➕ Новый сид', 'new-seed'), btn('🤖 Модель', 'view:model')]);
  return payload(lines, rows);
}

// Deployment is chosen by the owner in the bot's config, so there is no switch here.
// GPU start/pause is power control for the configured server, not provider selection.
function modelScreen(info, gpu) {
  const rows = [];
  const lines = ['🤖 Модель', ''];
  if (!modelKnown(info)) {
    lines.push('Данных о модели пока нет.');
  } else {
    const llama = info.provider === 'llama-cpp';
    const time = checkedTime(info.checkedAt);
    lines.push(
      `Провайдер: ${PROVIDER[info.provider].full}`,
      `Модель: ${line(info.model, 100)}`,
      llama
        ? 'Это наш сервер модели. Его проверка не измеряет видеокарту, память GPU, скорость и качество текста.'
        : 'Модель работает по подписке Claude, а не на нашем арендованном GPU.',
      '',
    );
    if (info.status === 'ready') {
      lines.push(
        `✅ Последняя успешная проверка или ответ: ${time ?? 'время неизвестно'}.`,
        'Это было верно на тот момент, а не постоянное наблюдение: сейчас модель может уже не отвечать.',
      );
    } else if (info.status === 'unavailable') {
      lines.push(
        `⛔ Недоступна при проверке: ${time ?? 'время неизвестно'}.`,
        'Пока так, новые сцены могут не получиться.',
      );
    } else if (info.status === 'configured') {
      lines.push('⚪ Настроена, но ещё не проверена — готова ли она, неизвестно.');
    } else {
      lines.push('❔ Статус неизвестен.');
    }
  }
  if (gpu) {
    lines.push('', ...gpuLines(gpu));
    rows.push([
      gpu.canStart === true ? btn('▶️ Запустить GPU', 'gpu:start') : null,
      gpu.canPause === true ? btn('⏸ Пауза GPU', 'gpu:pause') : null,
    ]);
  }
  lines.push('', 'Модель выбирается в настройках бота, не в чате.');
  rows.push([btn('🔄 Обновить', 'view:model'), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function gpuLines(gpu) {
  const jobs = jobCount(gpu.activeJobs);
  const lines = ['🖥 GPU — общий для всех пользователей бота'];
  switch (gpu.status) {
    case 'ready': {
      lines.push(`🟢 Работает. Задач модели сейчас: ${jobs ?? 'неизвестно'}.`);
      const idle = known(gpu.idleMinutes) && gpu.idleMinutes > 0 ? `${Math.round(gpu.idleMinutes)} мин` : null;
      if (idle) {
        lines.push(`Автопауза — после ${idle} без задач модели, считая от конца последней сцены или сжатия. Просмотр меню этот отсчёт не сбрасывает.`);
      }
      if (jobs === 0 && known(gpu.idleRemainingSeconds) && gpu.idleRemainingSeconds >= 0) {
        lines.push(`До автопаузы ≈${remaining(gpu.idleRemainingSeconds)}.`);
      }
      break;
    }
    case 'draining':
      lines.push(
        `⏳ Ставится на паузу: ждём, пока закончатся все задачи модели (сейчас: ${jobs ?? 'неизвестно'}).`,
        'Новые сцены и сжатия до паузы не начинаются.',
      );
      break;
    case 'stopping':
      lines.push('⏳ Останавливается. Новые сцены и сжатия пока не начинаются.');
      break;
    case 'paused':
      lines.push(
        '⏸ На паузе: Vast подтвердил остановку.',
        'Работа GPU там больше не оплачивается, но диск оплачивается и дальше.',
      );
      break;
    case 'starting':
      lines.push('⏳ Запускается. Это может занять время: ждём свободную видеокарту на Vast и прогрев модели.');
      break;
    case 'error':
      lines.push('⚠️ Ошибка управления GPU. Это не значит, что он на паузе: он может работать и оплачиваться. Нажми «Обновить».');
      break;
    default:
      lines.push('❔ Состояние GPU неизвестно. Это не значит, что он на паузе или бесплатен. Нажми «Обновить».');
  }
  if (gpu.canPause === true) {
    lines.push('«Пауза GPU» остановит его для всех. Если модель сейчас работает, пауза дождётся конца всех сцен и сжатий.');
  }
  if (gpu.canStart === true) {
    lines.push('«Запустить GPU» тоже может занять время: свободная видеокарта и прогрев модели.');
  }
  lines.push('Истории и чекпоинты хранятся у бота и при паузе не пропадают.');
  return lines;
}

function gpuShort(gpu) {
  const jobs = jobCount(gpu.activeJobs);
  switch (gpu.status) {
    case 'ready': return `работает · задач: ${jobs ?? 'неизвестно'}`;
    case 'draining': return `ставится на паузу, ждёт задач: ${jobs ?? 'неизвестно'}`;
    case 'stopping': return 'останавливается';
    case 'paused': return 'на паузе';
    case 'starting': return 'запускается';
    case 'error': return 'ошибка, открой «Модель» и обнови';
    default: return 'состояние неизвестно, открой «Модель» и обнови';
  }
}

// details.gpuInfo arrives only for a configured Vast GPU; never show controls for the Claude provider.
function gpuFor(details) {
  const gpu = details.gpuInfo;
  if (!gpu || typeof gpu !== 'object') return null;
  if (details.modelInfo?.provider === 'claude-code') return null;
  return gpu;
}

function jobCount(value) {
  return known(value) && value >= 0 ? Math.round(value) : null;
}

function remaining(seconds) {
  return seconds < 60 ? 'меньше минуты' : `${Math.ceil(seconds / 60)} мин`;
}

function seedList(state, rawPage) {
  const seeds = ordered(values(state.seeds));
  if (!seeds.length) {
    return payload(
      ['📚 Сиды', '', 'Сидов пока нет.', 'Сид — это мир, персонаж и стартовая ситуация. Из одного сида можно начать сколько угодно историй.'],
      [[btn('➕ Новый сид', 'new-seed')], [btn('🏠 Меню', 'view:home')]],
    );
  }
  const p = paginate(seeds, rawPage);
  const activeSeed = own(state.stories, state.active?.storyId)?.seedId;
  const lines = [`📚 Сиды: ${seeds.length}`, pageNote(p), ''];
  const rows = [];
  p.items.forEach((seed, i) => {
    const n = p.start + i + 1;
    const stories = storiesOf(state, seed.id).length;
    const summary = stories ? count(stories, 'история', 'истории', 'историй') : 'историй нет';
    lines.push(`${n}. ${quote(seed.title, 60)} · ${summary}${seed.id === activeSeed ? ' · ✅ сейчас' : ''}`);
    rows.push([btn(`${n}. ${line(seed.title, 40) || 'Без названия'}`, `view:seed:${seed.id}`)]);
  });
  lines.push('', 'Выбери сид, чтобы начать историю или открыть начатую.');
  rows.push(pager(p, 'seeds', '⬅️ Предыдущие', 'Следующие ➡️'));
  rows.push([btn('➕ Новый сид', 'new-seed'), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function seedScreen(state, seedId, rawPage) {
  const seed = own(state.seeds, seedId);
  if (!seed) return stale('Сид не найден.');
  const stories = storiesOf(state, seed.id);
  const p = paginate(stories, rawPage);
  const lines = [`🌱 Сид ${quote(seed.title, 100)}`, `Начало в мире: ${seed.startTime ?? '—'}`, '', clip(seed.text, 1200), ''];
  const rows = [];
  if (state.job) {
    lines.push(busyNote(state, 'начать историю или удалить сид'), '');
    rows.push(cancelRow(state));
  } else {
    rows.push([btn('▶️ Начать новую историю', `start:${seed.id}`)]);
  }
  if (stories.length) {
    lines.push(`📖 Истории из этого сида: ${stories.length}`, pageNote(p));
    p.items.forEach((story, i) => {
      const n = p.start + i + 1;
      const current = story.id === state.active?.storyId ? ' · ✅ сейчас' : '';
      const branches = count(values(story.branches).length, 'ветка', 'ветки', 'веток');
      const scenes = count(Object.keys(story.nodes ?? {}).length, 'сцена', 'сцены', 'сцен');
      lines.push(`${n}. История ${n} · ${branches} · ${scenes}${current}`);
      rows.push([btn(`📖 История ${n}`, `view:story:${story.id}`)]);
    });
  } else {
    lines.push('Историй пока нет. «Начать новую историю» создаст её и сразу напишет первую сцену.');
  }
  rows.push(pager(p, `seed:${seed.id}`, '⬅️ Предыдущие', 'Следующие ➡️'));
  if (!state.job) rows.push([btn('🗑 Удалить сид', `view:delete-seed:${seed.id}`)]);
  rows.push([btn('📚 Все сиды', 'view:seeds:0'), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function storyScreen(state, storyId, rawPage) {
  const story = own(state.stories, storyId);
  if (!story) return stale('История не найдена.');
  const seed = own(state.seeds, story.seedId);
  const branches = ordered(values(story.branches));
  const p = paginate(branches, rawPage);
  const lines = [`📖 ${storyName(state, story)}`, `🌿 Ветки: ${branches.length}`, pageNote(p), ''];
  const rows = [];
  p.items.forEach((branch, i) => {
    const n = p.start + i + 1;
    const current = isActive(state, story, branch) ? ' · ✅ сейчас' : '';
    lines.push(`${n}. ${quote(branch.name)} · ${progress(story, branch)}${current}`);
    rows.push([btn(`🌿 ${n}. ${line(branch.name, 40) || 'Без названия'}`, `view:branch:${story.id}:${branch.id}`)]);
  });
  if (!branches.length) lines.push('Веток нет.');
  lines.push('', 'Ветка — отдельная линия событий. Новая появляется, когда продолжаешь историю с чекпоинта; старая остаётся как была.');
  rows.push(pager(p, `story:${story.id}`, '⬅️ Предыдущие', 'Следующие ➡️'));
  rows.push([seed ? btn('🌱 К сиду', `view:seed:${seed.id}`) : null, btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function branchScreen(state, storyId, branchId) {
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!branch) return stale('Ветка не найдена.');
  const current = isActive(state, story, branch);
  const last = own(story.nodes, branch.head);
  const checkpoints = checkpointsOf(story, branch.id).length;
  const lines = [`🌿 Ветка ${quote(branch.name, 60)}`, `📖 ${storyName(state, story)}`, `🎬 ${progress(story, branch)}`];
  if (current) lines.push('✅ Это текущая ветка.');
  if (last) lines.push('', 'Последняя сцена:', clip(sceneBody(last.text), 600));
  const rows = [];
  if (state.job) {
    lines.push('', busyNote(state, 'переключать и удалять ветки'));
    rows.push(cancelRow(state));
    if (current && last) rows.push([btn('📄 Последняя сцена', 'last')]);
  } else if (current) {
    rows.push([btn('▶️ Продолжить', 'continue'), last ? btn('📄 Последняя сцена', 'last') : null]);
  } else {
    lines.push('', 'Выбери ветку, чтобы играть в ней, — покажу её последнюю сцену.');
    rows.push([btn('✅ Играть в этой ветке', `use:${story.id}:${branch.id}`)]);
  }
  rows.push([btn(`🔖 Чекпоинты (${checkpoints})`, `view:checkpoints:${story.id}:${branch.id}:0`)]);
  if (!state.job) rows.push([btn('🗑 Удалить ветку', `view:delete-branch:${story.id}:${branch.id}`)]);
  rows.push([btn('◀️ Все ветки', `view:story:${story.id}`), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function checkpointList(state, storyId, branchId, rawPage) {
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!branch) return stale('Ветка не найдена.');
  const newest = checkpointsOf(story, branch.id).reverse();
  const p = paginate(newest, rawPage);
  const lines = [`🔖 Чекпоинты ветки ${quote(branch.name)}: ${newest.length}`, `📖 ${storyName(state, story)}`, pageNote(p), ''];
  if (newest.length) {
    lines.push('Открой чекпоинт, чтобы перечитать сцену и при желании продолжить с неё в новой ветке. Сверху — самые новые.');
  } else {
    lines.push('Чекпоинтов пока нет — они появляются после каждой сцены.');
  }
  const rows = p.items.map(cp => {
    const time = checkpointTime(state, story, cp);
    return [btn(`${checkpointTitle(cp)}${time ? ` · ${time}` : ''}`, `view:checkpoint:${story.id}:${cp.id}`)];
  });
  rows.push(pager(p, `checkpoints:${story.id}:${branch.id}`, '⬅️ Новее', 'Старше ➡️'));
  rows.push([btn('◀️ К ветке', `view:branch:${story.id}:${branch.id}`), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function checkpointScreen(state, storyId, checkpointId) {
  const story = own(state.stories, storyId);
  const cp = own(story?.checkpoints, checkpointId);
  const branch = own(story?.branches, cp?.branchId);
  if (!branch) return stale('Чекпоинт не найден.');
  const seed = own(state.seeds, story.seedId);
  const node = cp.head ? own(story.nodes, cp.head) : null;

  const header = [checkpointTitle(cp), `🌿 Ветка ${quote(branch.name)} · ${storyName(state, story)}`];
  if (cp.head && cp.head === branch.head && isActive(state, story, branch)) header.push('✅ Это последняя сцена текущей ветки.');

  let body;
  if (!cp.head) {
    body = ['', '🌱 Начало истории, сцен ещё нет.', seed ? `Старт в мире: ${seed.startTime}` : null, '', seed ? seed.text : 'Сид недоступен.'];
  } else if (!node) {
    body = ['', 'Текст сцены недоступен.'];
  } else {
    body = [
      '',
      node.input ? `✍️ Ввод: ${line(node.input, 400)}` : null,
      node.truncated ? '⚠️ Сцена оборвалась при генерации.' : null,
      '',
      node.text ?? '',
    ];
  }

  const rows = [];
  const footer = [''];
  if (state.job) {
    footer.push(busyNote(state, 'продолжить с чекпоинта'));
    rows.push(cancelRow(state));
  } else {
    footer.push(`«Продолжить отсюда» создаст новую ветку с этого момента. Ветка ${quote(branch.name)} останется как есть.`);
    rows.push([btn('🌿 Продолжить отсюда', `fork:${story.id}:${cp.id}`)]);
  }
  const newest = checkpointsOf(story, branch.id).reverse();
  const page = Math.max(0, Math.floor(newest.indexOf(cp) / PAGE));
  rows.push([
    btn('◀️ Чекпоинты', `view:checkpoints:${story.id}:${branch.id}:${page}`),
    btn('📏 Контекст', `view:context:${story.id}:${cp.id}`),
    btn('🏠 Меню', 'view:home'),
  ]);

  // Fit the long scene/seed text into what remains of the message limit.
  const long = body.pop();
  const fixed = [...header, ...body, ...footer].filter(l => l != null).join('\n').length;
  body.push(clip(long, Math.max(200, LIMIT - fixed - 20)));
  return payload([...header, ...body, ...footer], rows);
}

function currentContextScreen(state, stats) {
  const ref = activeRef(state);
  if (!ref) {
    return payload(
      ['📏 Контекст', '', 'История не выбрана. Открой сид и выбери ветку.'],
      [[btn('📚 Сиды', 'view:seeds:0'), btn('🏠 Меню', 'view:home')]],
    );
  }
  const { story, branch } = ref;
  const valid = stats && stats.scope !== 'checkpoint' && stats.storyId === story.id && stats.branchId === branch.id;
  if (valid) return contextView(stats, { state, canCompact: !state.job });
  const lines = ['📏 Контекст текущей ветки', `🌿 ${quote(branch.name)} · ${storyName(state, story)}`, '', 'Данных о размере контекста пока нет.'];
  const rows = [];
  if (state.job) {
    lines.push('', busyNote(state, 'сжать историю'));
  } else {
    lines.push('', compactNote(null));
    rows.push([btn('🗜 Сжать сейчас', 'compact')]);
  }
  rows.push([btn('🔖 Чекпоинты', `view:checkpoints:${story.id}:${branch.id}:0`), btn('🏠 Меню', 'view:home')]);
  return payload(lines, rows);
}

function compactNote(keepScenes) {
  const keep = known(keepScenes) ? `Последние ${count(keepScenes, 'сцена', 'сцены', 'сцен')}` : 'Последние сцены';
  return `🗜 «Сжать сейчас» перескажет старые сцены в память, не дожидаясь порога. ${keep} останутся целиком, исходные сцены сохранятся в архиве, до и после сжатия будут чекпоинты. Новую сцену сжатие не пишет.`;
}

function checkpointContextScreen(state, storyId, checkpointId, stats) {
  const story = own(state.stories, storyId);
  const cp = own(story?.checkpoints, checkpointId);
  if (!cp) return stale('Чекпоинт не найден.');
  if (statsFor(stats, story.id, cp.id)) return contextView(stats);
  return payload(
    [`📏 Контекст: ${checkpointTitle(cp)}`, '', 'Данных о размере этого чекпоинта пока нет.'],
    [[btn('◀️ К чекпоинту', `view:checkpoint:${story.id}:${cp.id}`), btn('🏠 Меню', 'view:home')]],
  );
}

// Only show stats that belong to exactly this checkpoint, never the branch head or another branch.
function statsFor(stats, storyId, checkpointId) {
  return Boolean(stats) && stats.scope === 'checkpoint' && stats.storyId === storyId && stats.checkpointId === checkpointId;
}

function contextView(stats, { state = null, canCompact = false } = {}) {
  const checkpoint = stats.scope === 'checkpoint';
  const lines = [
    `📏 Контекст: ${line(stats.label, 60) || (checkpoint ? 'чекпоинт' : 'текущая ветка')}`,
    checkpoint ? 'Размер на момент этого чекпоинта.' : 'Текущая ветка, последнее сохранённое состояние.',
  ];
  if (state?.job && !checkpoint) {
    lines.push(state.job.kind === 'compact'
      ? '⏳ Идёт сжатие памяти — здесь состояние до него.'
      : '⏳ Сцена, которая сейчас пишется, здесь не учтена.');
  }

  lines.push('', known(stats.limitTokens)
    ? `Окно: ${num(stats.limitTokens)} ток. вместе с ответом${known(stats.reserveTokens) ? `; резерв на ответ ${num(stats.reserveTokens)}` : ''}.`
    : 'Окно: размер неизвестен.');

  const request = stats.request?.estimatedTokens;
  lines.push('');
  if (known(request)) {
    const part = share(request, stats.limitTokens);
    lines.push(`Следующий запрос ≈${num(request)} ток.${part ? ` (≈${part} окна)` : ''}: снимок, правила бота и обычное «Продолжить». Длинный ввод добавит своё.`);
    const source = stats.request.estimateSource;
    if (source === 'usage') lines.push('Оценка сверена с последним измеренным запросом этой линии.');
    else if (source === 'bytes') lines.push('Грубая оценка: байты UTF-8 ÷ 4 плюс запас на служебную часть.');
  } else {
    lines.push('Следующий запрос: оценки нет.');
  }

  const budget = stats.budget;
  if (budget && known(budget.limitTokens)) {
    lines.push(`Бюджет ввода (окно минус резерв): ${known(budget.inputTokens) ? `≈${num(budget.inputTokens)}` : 'неизвестно'} из ${num(budget.limitTokens)} ток.`);
    if (known(budget.remainingTokens)) {
      lines.push(budget.remainingTokens > 0
        ? `Осталось ≈${num(budget.remainingTokens)} ток.`
        : '⚠️ По оценке бюджет ввода уже исчерпан.');
    }
  }
  if (known(request) || known(budget?.limitTokens)) {
    lines.push('Это прогноз, а не точный подсчёт: фактический вход ещё раз проверяется в начале ответа модели, до показа текста.');
  }

  const compaction = stats.compaction;
  if (compaction && known(compaction.thresholdTokens)) {
    const keep = known(compaction.keepScenes)
      ? `; последние ${count(compaction.keepScenes, 'сцена остаётся', 'сцены остаются', 'сцен остаются')} целиком`
      : '';
    lines.push(
      '',
      `Автосжатие: когда вход достигает ≈${num(compaction.thresholdTokens)} ток.${keep}.`,
      'Измеренные токены могут поправить предварительную оценку. До и после сжатия сохраняются чекпоинты, исходные сцены остаются в архиве.',
    );
  }

  const memory = stats.memory;
  const memoryText = known(memory?.count) && memory.count === 0 ? 'пусто, сжатий ещё не было'
    : `${known(memory?.count) ? `${count(memory.count, 'часть', 'части', 'частей')} · ` : ''}${size(memory)}`;
  lines.push(
    '',
    'Снимок (Б — точно; ≈ — байты UTF-8 ÷ 4, не точный подсчёт токенов):',
    `• Сид: ${size(stats.seed)}`,
    `• Память: ${memoryText}`,
    `= Сид + память: ${size(stats.prefix)}`,
    `• Несжатые сцены${known(stats.tail?.count) ? ` (${stats.tail.count})` : ''}: ${size(stats.tail)}`,
    `= Весь снимок: ${size(stats.snapshot)}`,
  );

  lines.push(
    '',
    `Последний запрос (измерено): ${lastRequestText(stats.lastRequest)}`,
    'Вход считается вместе с кэшем; выход может включать скрытые рассуждения модели. Это один запрос, а не расход за всё время и не прогноз следующего.',
  );

  // Compaction is offered only for the live branch while idle, never for a historical checkpoint.
  const compact = canCompact && !checkpoint;
  if (compact) lines.push('', compactNote(stats.compaction?.keepScenes));

  const rows = checkpoint
    ? [[stats.storyId && stats.checkpointId ? btn('◀️ К чекпоинту', `view:checkpoint:${stats.storyId}:${stats.checkpointId}`) : null, btn('🏠 Меню', 'view:home')]]
    : [
      compact ? [btn('🗜 Сжать сейчас', 'compact')] : null,
      [btn('🔄 Обновить', 'view:context'), stats.storyId && stats.branchId ? btn('🔖 Чекпоинты', `view:checkpoints:${stats.storyId}:${stats.branchId}:0`) : null],
      [btn('🏠 Меню', 'view:home')],
    ];
  return payload(lines, rows);
}

function lastRequestText(last) {
  if (!last || ![last.inputTokens, last.outputTokens, last.totalTokens].some(known)) return 'нет измерений';
  const total = known(last.totalTokens) ? last.totalTokens
    : known(last.inputTokens) && known(last.outputTokens) ? last.inputTokens + last.outputTokens : null;
  const measured = value => (known(value) ? num(value) : 'неизвестно');
  return `вход ${measured(last.inputTokens)} · выход ${measured(last.outputTokens)} · всего ${measured(total)}`;
}

function deleteSeedScreen(state, seedId) {
  const seed = own(state.seeds, seedId);
  if (!seed) return stale('Сид не найден.');
  const stories = storiesOf(state, seed.id);
  const branches = stories.reduce((sum, story) => sum + values(story.branches).length, 0);
  const scenes = stories.reduce((sum, story) => sum + Object.keys(story.nodes ?? {}).length, 0);
  const lines = [`🗑 Удалить сид ${quote(seed.title, 60)}?`, ''];
  if (stories.length) {
    lines.push(
      'Вместе с ним навсегда удалятся:',
      `• ${count(stories.length, 'история', 'истории', 'историй')}`,
      `• ${count(branches, 'ветка', 'ветки', 'веток')}`,
      `• ${count(scenes, 'сцена', 'сцены', 'сцен')} и все чекпоинты`,
    );
    if (stories.some(story => story.id === state.active?.storyId)) lines.push('• в том числе текущая история');
  } else {
    lines.push('Историй из этого сида нет — удалится только сам сид.');
  }
  lines.push('', DELETE_NOTE);
  const rows = [];
  if (state.job) {
    lines.push('', busyNote(state, 'удалить сид'));
    rows.push(cancelRow(state));
  } else {
    rows.push([btn(stories.length ? '🗑 Да, удалить всё' : '🗑 Да, удалить сид', `remove-seed:${seed.id}`)]);
  }
  rows.push([btn('↩️ Не удалять', `view:seed:${seed.id}`)]);
  return payload(lines, rows);
}

function deleteBranchScreen(state, storyId, branchId) {
  const story = own(state.stories, storyId);
  const branch = own(story?.branches, branchId);
  if (!branch) return stale('Ветка не найдена.');
  const seed = own(state.seeds, story.seedId);
  const others = values(story.branches).filter(b => b !== branch);
  const checkpoints = checkpointsOf(story, branch.id);
  const kept = reach(story, [...others, ...values(story.checkpoints).filter(cp => cp?.branchId !== branch.id)]);
  const lost = [...reach(story, [branch, ...checkpoints])].filter(nodeId => !kept.has(nodeId)).length;
  const scenes = count(lost, 'сцена', 'сцены', 'сцен');
  const cps = count(checkpoints.length, 'чекпоинт', 'чекпоинта', 'чекпоинтов');

  const lines = [`🗑 Удалить ветку ${quote(branch.name, 60)}?`, `📖 ${storyName(state, story)}`, ''];
  if (!others.length) {
    lines.push(
      'Это единственная ветка, поэтому история удалится целиком:',
      `• ${scenes}`,
      `• ${cps}`,
      '',
      seed ? `Сид ${quote(seed.title)} останется — из него можно начать новую историю.` : null,
    );
  } else {
    const which = lost % 10 === 1 && lost % 100 !== 11 ? 'которой' : 'которых';
    lines.push(
      'Навсегда удалятся:',
      `• ${cps} этой ветки`,
      lost ? `• ${scenes}, ${which} нет в других ветках` : '• сцены останутся: все они есть в других ветках',
      '',
      `Сохранятся: ${count(others.length, 'другая ветка', 'другие ветки', 'других веток')} этой истории.`,
    );
  }
  if (isActive(state, story, branch)) lines.push('', '⚠️ Это текущая ветка — после удаления выбери другую.');
  lines.push('', DELETE_NOTE);
  const rows = [];
  if (state.job) {
    lines.push('', busyNote(state, 'удалить ветку'));
    rows.push(cancelRow(state));
  } else {
    rows.push([btn(others.length ? '🗑 Да, удалить ветку' : '🗑 Да, удалить историю', `remove-branch:${story.id}:${branch.id}`)]);
  }
  rows.push([btn('↩️ Не удалять', `view:branch:${story.id}:${branch.id}`)]);
  return payload(lines, rows);
}

function newSeedScreen(state) {
  const draft = state.ui?.input === 'seed' && Array.isArray(state.ui.parts)
    ? state.ui.parts.filter(part => typeof part === 'string' && part.trim())
    : [];
  if (draft.length) return seedDraftScreen(state.ui.draftId, draft);

  const lines = [
    '➕ Новый сид',
    '',
    'Пришли описание одним или несколькими сообщениями:',
    '1) первая строка — название, до 100 знаков;',
    '2) вторая — дата и время начала в мире: ГГГГ-ММ-ДД ЧЧ:ММ;',
    '3) дальше — мир, персонаж и стартовая ситуация.',
    '',
    'Длинный текст можно разбить на несколько сообщений: всё соберётся в один черновик.',
    '📎 Или приложи файл .txt / .md (UTF-8, до 256 КиБ на весь черновик): целиком, с названием и датой в первых строках, или только описание — тогда название и дату пришли сообщением перед файлом. Подпись к файлу не учитывается, PDF и DOCX не подходят.',
    'Когда отправишь всё, нажми «💾 Сохранить сид». До этого сид не сохраняется и сцены не пишутся.',
    '',
    'Пример:',
    EXAMPLE,
  ];
  if (state.job) lines.push('', state.job.kind === 'compact' ? '⏳ Сжатие памяти, начатое раньше, ещё идёт.' : '⏳ Сцена, начатая раньше, ещё пишется.');
  const result = payload(lines, [[btn('✖️ Отмена', 'cancel')]]);
  // A pre entity makes the example tap-to-copy without parse_mode escaping.
  const offset = result.text.indexOf(EXAMPLE);
  if (offset >= 0) result.entities = [{ type: 'pre', offset, length: EXAMPLE.length }];
  return result;
}

// Receipt after each collected part (message or file): counts only, never any text or filename.
// Format is checked by the backend on Save.
function seedDraftScreen(draftId, parts) {
  const chars = [...parts.join('\n\n')].length;
  return payload([
    '📝 Черновик сида — ещё не сохранён',
    `Получено: ${count(parts.length, 'часть', 'части', 'частей')} · ${count(chars, 'знак', 'знака', 'знаков')}`,
    '',
    'Можно прислать ещё сообщения или файлы .txt / .md — они добавятся к описанию.',
    'Когда отправишь всё, нажми «💾 Сохранить сид». Сцены не пишутся ни сейчас, ни при сохранении — историю можно будет начать отдельно.',
    '',
    'Меню и остальные кнопки снова заработают после сохранения или отмены черновика.',
  ], [
    [draftId ? btn('💾 Сохранить сид', `save-seed:${draftId}`) : null],
    [btn('🗑 Отменить черновик', 'cancel')],
  ]);
}

function stale(message) {
  return payload(
    [`⚠️ ${message}`, 'Возможно, это уже удалено или экран устарел.'],
    [[btn('📚 Сиды', 'view:seeds:0'), btn('🏠 Меню', 'view:home')]],
  );
}

// Domain lookups (tolerant of stale or broken references)

const values = obj => Object.values(obj ?? {});
const own = (obj, key) => (key != null && obj && Object.hasOwn(obj, key) ? obj[key] : undefined);

function activeRef(state) {
  const story = own(state.stories, state.active?.storyId);
  const branch = own(story?.branches, state.active?.branchId);
  return branch ? { story, branch } : null;
}

function isActive(state, story, branch) {
  return state.active?.storyId === story.id && state.active?.branchId === branch.id;
}

function ordered(items) {
  const n = item => {
    const match = /(\d+)$/.exec(String(item?.id ?? ''));
    return match ? Number(match[1]) : Infinity;
  };
  return items
    .map((item, i) => [item, i])
    .sort((a, b) => (n(a[0]) - n(b[0])) || (a[1] - b[1]))
    .map(([item]) => item);
}

function storiesOf(state, seedId) {
  return ordered(values(state.stories).filter(story => story?.seedId === seedId));
}

function storyName(state, story) {
  const n = storiesOf(state, story.seedId).indexOf(story) + 1;
  return `${quote(story.title)}${n ? ` · история ${n}` : ''}`;
}

function chain(story, head) {
  const nodes = [];
  const seen = new Set();
  while (head && !seen.has(head)) {
    const node = own(story.nodes, head);
    if (!node) break;
    seen.add(head);
    nodes.push(node);
    head = node.parent;
  }
  return nodes.reverse();
}

function reach(story, refs) {
  const ids = new Set();
  for (const ref of refs) for (const node of chain(story, ref?.head)) ids.add(node.id);
  return ids;
}

function progress(story, branch) {
  const scenes = chain(story, branch.head).length;
  if (!scenes) return 'сцен пока нет';
  const time = own(story.nodes, branch.head)?.time;
  return `${count(scenes, 'сцена', 'сцены', 'сцен')}${time ? ` · ${time}` : ''}`;
}

function checkpointsOf(story, branchId) {
  return ordered(values(story.checkpoints).filter(cp => cp?.branchId === branchId));
}

function checkpointTitle(cp) {
  return `${ICON[cp.kind] ?? '📌'} ${line(cp.label, 40) || 'Чекпоинт'}`;
}

function checkpointTime(state, story, cp) {
  return cp.head ? own(story.nodes, cp.head)?.time : own(state.seeds, story.seedId)?.startTime;
}

function sceneBody(text) {
  return String(text ?? '').split('\n').slice(1).join('\n').trim();
}

// Text and keyboard helpers

function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() + '…';
}

function line(value, max = 40) {
  return clip(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

function quote(value, max = 40) {
  return `«${line(value, max) || 'без названия'}»`;
}

function count(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
  return `${n} ${word}`;
}

// Missing measurements are shown as unknown, never as 0.
function known(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function num(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function tokens(value) {
  return known(value) ? `≈${num(value)} ток.` : 'токены неизвестны';
}

function bytes(value) {
  return known(value) ? `${num(value)} Б` : 'размер неизвестен';
}

function size(part) {
  return `${bytes(part?.bytes)} · ${tokens(part?.estimatedTokens)}`;
}

function share(part, whole) {
  if (!known(part) || !known(whole) || whole <= 0) return null;
  const percent = (part / whole) * 100;
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
}

function jobLabel(state) {
  return state.job?.kind === 'compact'
    ? { title: 'Идёт сжатие памяти', after: 'после него', cancel: '✖️ Отменить сжатие' }
    : { title: 'Пишется сцена', after: 'после неё', cancel: '✖️ Отменить генерацию' };
}

function busyNote(state, what) {
  const job = jobLabel(state);
  return `⏳ Сейчас ${job.title.toLowerCase()}: ${what} можно будет ${job.after}.`;
}

function cancelRow(state) {
  return [btn(jobLabel(state).cancel, 'cancel')];
}

// Model metadata: {provider, model, status, checkedAt}. Scene provenance carries only {provider, model}.
const PROVIDER = {
  'claude-code': { short: 'Claude Code', full: 'Claude Code по подписке Claude (не наш GPU-сервер)' },
  'llama-cpp': { short: 'наш сервер', full: 'наш сервер модели (llama.cpp)' },
};

function modelKnown(info) {
  return Boolean(info) && Object.hasOwn(PROVIDER, info.provider) && typeof info.model === 'string' && info.model.trim() !== '';
}

function statusShort(info) {
  const time = checkedTime(info.checkedAt);
  if (info.status === 'ready') return time ? `отвечала ${time}` : 'отвечала';
  if (info.status === 'unavailable') return 'недоступна при проверке';
  if (info.status === 'configured') return 'не проверена';
  return 'статус неизвестен';
}

function checkedTime(iso) {
  if (typeof iso !== 'string') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// Scene prefixes may be sent with a Markdown parse mode: keep only letters, digits and spaces
// from the model name and join the rest with a Unicode hyphen, which no Markdown flavour treats specially.
function markdownSafe(value) {
  return value.replace(/[^\p{L}\p{N} ]+/gu, '‐');
}

function paginate(items, raw) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const wanted = /^\d+$/.test(String(raw ?? '')) ? Number(raw) : 0;
  const page = Math.min(wanted, pages - 1);
  const start = page * PAGE;
  return { page, pages, start, items: items.slice(start, start + PAGE) };
}

function pageNote(p) {
  return p.pages > 1 ? `Стр. ${p.page + 1} из ${p.pages}` : null;
}

function pager(p, route, previous, next) {
  return [
    p.page > 0 ? btn(previous, `view:${route}:${p.page - 1}`) : null,
    p.page < p.pages - 1 ? btn(next, `view:${route}:${p.page + 1}`) : null,
  ];
}

function btn(text, data) {
  return encoder.encode(data).length <= 64 ? { text, callback_data: data } : null;
}

function keyboard(rows) {
  const inline_keyboard = rows.filter(Boolean).map(row => row.filter(Boolean)).filter(row => row.length);
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}

function payload(lines, rows) {
  const text = clip(lines.filter(l => l != null).join('\n').trim(), LIMIT);
  const reply_markup = keyboard(rows);
  return reply_markup ? { text, reply_markup } : { text };
}
