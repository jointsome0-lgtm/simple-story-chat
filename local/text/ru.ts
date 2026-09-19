// Russian interface catalog. Its shape is the contract: every other language is a `Messages` with the same keys.
//
// For translators. Translate values only; keys, emoji, /commands, file extensions and «GPU», «JSON», «UTF-8» stay.
// - An argument called `name`, `title`, `story`, `branch` or `seed` arrives already wrapped by `format.quote`.
// - A `string` argument that holds a number is already formatted by `format.number`; a `number` argument is a raw
//   count, there so the entry can pick a plural form. Languages without plurals just print it.
// - A whole sentence is one entry. Never expect the code to glue two entries into a sentence.
// - Texts are plain (no Markdown) unless the comment says otherwise. Buttons: keep under ~30 characters.
// - The interface addresses the user informally and briefly; it never speaks as a character of the story.

const form = (n: number, one: string, few: string, many: string) => {
  const tens = n % 100;
  const ones = n % 10;
  return tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
};
const count = (n: number, one: string, few: string, many: string) => `${n} ${form(n, one, few, many)}`;
const grouped = (n: number, separator: string) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
const lastScenes = (n: number | null) => (n === null ? 'последние сцены' : `последние ${count(n, 'сцена', 'сцены', 'сцен')}`);
const jobs = (n: number | null) => (n === null ? 'неизвестно' : String(n));

export const ru = {
  format: {
    // Token and byte counts, thousands apart. The no-break space keeps a number on one line.
    number: (n: number) => grouped(n, ' '),
    // Quotation marks around a seed, story or branch name.
    quote: (text: string) => `«${text}»`,
    // Inside the quotation marks when a name is empty.
    untitled: 'без названия',
    // On a button when a seed or branch name is empty.
    untitledButton: 'Без названия',
    // A missing value in a line of numbers.
    unknown: 'неизвестно',
  },

  // "N things" with the noun in the right form. Used in lists, after a bullet or between « · » separators.
  count: {
    scenes: (n: number) => count(n, 'сцена', 'сцены', 'сцен'),
    stories: (n: number) => count(n, 'история', 'истории', 'историй'),
    branches: (n: number) => count(n, 'ветка', 'ветки', 'веток'),
    checkpoints: (n: number) => count(n, 'чекпоинт', 'чекпоинта', 'чекпоинтов'),
    // Parts of a seed draft or of the compacted memory.
    parts: (n: number) => count(n, 'часть', 'части', 'частей'),
    // Characters of text in a seed draft.
    characters: (n: number) => count(n, 'знак', 'знака', 'знаков'),
  },

  // Elapsed time of a compaction. `ss` and `mm` arrive zero-padded.
  duration: {
    seconds: (s: number) => `${s} с`,
    minutes: (m: number, ss: string) => `${m} мин ${ss} с`,
    hours: (h: number, mm: string) => `${h} ч ${mm} мин`,
  },

  // Buttons that appear on several screens.
  buttons: {
    menu: '🏠 Меню',
    continue: '▶️ Продолжить',
    // Under a scene that is being written.
    stop: '✖️ Остановить',
    lastScene: '📄 Последняя сцена',
    context: '📏 Контекст',
    model: '🤖 Модель',
    checkpoints: '🔖 Чекпоинты',
    branches: '🌿 Ветки',
    seeds: '📚 Сиды',
    seedsCount: (n: number) => `📚 Сиды (${n})`,
    newSeed: '➕ Новый сид',
    refresh: '🔄 Обновить',
    compactNow: '🗜 Сжать сейчас',
    cancelScene: '✖️ Отменить генерацию',
    cancelCompaction: '✖️ Отменить сжатие',
    toCheckpoint: '◀️ К чекпоинту',
    // Pager of a list sorted by creation.
    previous: '⬅️ Предыдущие',
    next: 'Следующие ➡️',
    // Answer «no» on both delete confirmations.
    keep: '↩️ Не удалять',
  },

  // Marks and notes shared by several screens.
  common: {
    // After « · » in a list line: this item is the one being played.
    current: '✅ сейчас',
    page: (page: number, pages: number) => `Стр. ${page} из ${pages}`,
    // `title` is the quoted seed title; stories of one seed are told apart by number.
    storyName: (title: string, n: number) => `${title} · история ${n}`,
    // Where a branch's scene count would be.
    noScenes: 'сцен пока нет',
    // Second line of every «not found» screen.
    staleHint: 'Возможно, это уже удалено или экран устарел.',
    // Shown when a screen could not be drawn at all.
    failure: '⚠️ Не получилось показать этот экран.',
    failureHint: 'Вернись в меню и попробуй ещё раз.',
    whatIsSeed: 'Сид — это мир, персонаж и стартовая ситуация. Из одного сида можно начать сколько угодно историй.',
  },

  // A model job is running, so the action of this screen has to wait. One whole sentence per job and action.
  busy: {
    scene: {
      startOrDeleteSeed: '⏳ Сейчас пишется сцена: начать историю или удалить сид можно будет после неё.',
      switchOrDeleteBranch: '⏳ Сейчас пишется сцена: переключать и удалять ветки можно будет после неё.',
      fork: '⏳ Сейчас пишется сцена: продолжить с чекпоинта можно будет после неё.',
      compact: '⏳ Сейчас пишется сцена: сжать историю можно будет после неё.',
      deleteSeed: '⏳ Сейчас пишется сцена: удалить сид можно будет после неё.',
      deleteBranch: '⏳ Сейчас пишется сцена: удалить ветку можно будет после неё.',
    },
    compact: {
      startOrDeleteSeed: '⏳ Сейчас идёт сжатие памяти: начать историю или удалить сид можно будет после него.',
      switchOrDeleteBranch: '⏳ Сейчас идёт сжатие памяти: переключать и удалять ветки можно будет после него.',
      fork: '⏳ Сейчас идёт сжатие памяти: продолжить с чекпоинта можно будет после него.',
      compact: '⏳ Сейчас идёт сжатие памяти: сжать историю можно будет после него.',
      deleteSeed: '⏳ Сейчас идёт сжатие памяти: удалить сид можно будет после него.',
      deleteBranch: '⏳ Сейчас идёт сжатие памяти: удалить ветку можно будет после него.',
    },
  },

  home: {
    title: '🏠 Меню',
    // Above the menu when a button led to a screen that no longer exists.
    unknownRoute: '⚠️ Этот экран больше недоступен. Вот меню.',
    // `status` is one of gpu.short.
    gpu: (status: string) => `🖥 GPU: ${status}`,
    // `story` is common.storyName, or null when the story of the job is gone.
    sceneJob: (story: string | null) => `⏳ Пишется сцена${story ? ` в истории ${story}` : ''}.`,
    compactJob: (story: string | null) => `⏳ Идёт сжатие памяти${story ? ` в истории ${story}` : ''}.`,
    sceneJobNote: 'Меню можно листать; удалять, переключать ветки и запускать новые сцены — после неё.',
    compactJobNote: 'Меню можно листать; удалять, переключать ветки и запускать новые сцены — после него.',
    current: (story: string) => `📖 Сейчас: ${story}`,
    // `progress` is count.scenes with the world time, or common.noScenes.
    branch: (name: string, progress: string) => `🌿 Ветка ${name} · ${progress}`,
    // Names the Continue button.
    howToContinue: 'Чтобы продолжить, просто напиши сообщение: реплику, действие героя или указание автора. «Продолжить» — следующая сцена без указаний.',
    noStory: 'История не выбрана.',
    noStoryHint: 'Открой сид, чтобы начать новую историю или вернуться к начатой.',
    empty: 'Здесь пока пусто.',
    createFirst: 'Создай первый сид: пришли описание одним или несколькими сообщениями и сохрани.',
  },

  language: {
    title: '🌐 Язык интерфейса',
    note: 'Меняется только язык меню и сообщений бота. Язык историй задают сид и твои сообщения.',
  },

  model: {
    title: '🤖 Модель',
    noData: 'Данных о модели пока нет.',
    // `short` goes into the menu line and into the Markdown header above a scene: letters, digits and spaces only.
    providers: {
      'claude-code': { short: 'Claude Code', full: 'Claude Code по подписке Claude (не наш GPU-сервер)' },
      'llama-cpp': { short: 'наш сервер', full: 'наш сервер модели (llama.cpp)' },
      'codex-cli': { short: 'Codex', full: 'Codex CLI по подписке ChatGPT (не наш GPU-сервер)' },
      'openai-compatible': { short: 'размещённый API', full: 'размещённый API в формате OpenAI (не наш GPU-сервер)' },
    },
    provider: (full: string) => `Провайдер: ${full}`,
    name: (model: string) => `Модель: ${model}`,
    // Where the model runs and where the story text goes, one note per provider.
    notes: {
      'claude-code': 'Модель работает по подписке Claude, а не на нашем арендованном GPU.',
      'llama-cpp': 'Это наш сервер модели. Его проверка не измеряет видеокарту, память GPU, скорость и качество текста.',
      'codex-cli': 'Модель работает по подписке ChatGPT, а не на нашем арендованном GPU. Текст истории уходит стороннему сервису.',
      'openai-compatible': 'Модель работает у стороннего провайдера, а не на нашем арендованном GPU. Текст истории уходит стороннему сервису.',
    },
    // `time` is «2026-08-02 20:00 UTC» or null.
    ready: (time: string | null) => `✅ Последняя успешная проверка или ответ: ${time ?? 'время неизвестно'}.`,
    readyNote: 'Это было верно на тот момент, а не постоянное наблюдение: сейчас модель может уже не отвечать.',
    unavailable: (time: string | null) => `⛔ Недоступна при проверке: ${time ?? 'время неизвестно'}.`,
    unavailableNote: 'Пока так, новые сцены могут не получиться.',
    configured: '⚪ Настроена, но ещё не проверена — готова ли она, неизвестно.',
    unknown: '❔ Статус неизвестен.',
    footer: 'Модель выбирается в настройках бота, не в чате.',
    // Status at the end of the menu line «🤖 provider · model · status».
    short: {
      ready: (time: string | null) => (time ? `отвечала ${time}` : 'отвечала'),
      unavailable: 'недоступна при проверке',
      configured: 'не проверена',
      unknown: 'статус неизвестен',
    },
  },

  // The rented GPU on the model screen. `jobs` is the number of running model jobs, null when unknown.
  gpu: {
    title: '🖥 GPU — общий для всех пользователей бота',
    ready: (n: number | null) => `🟢 Работает. Задач модели сейчас: ${jobs(n)}.`,
    autoPause: (minutes: number) => `Автопауза — после ${minutes} мин без задач модели, считая от конца последней сцены или сжатия. Просмотр меню этот отсчёт не сбрасывает.`,
    untilPause: (minutes: number) => `До автопаузы ≈${minutes} мин.`,
    untilPauseSoon: 'До автопаузы ≈меньше минуты.',
    draining: (n: number | null) => `⏳ Ставится на паузу: ждём, пока закончатся все задачи модели (сейчас: ${jobs(n)}).`,
    drainingNote: 'Новые сцены и сжатия до паузы не начинаются.',
    stopping: '⏳ Останавливается. Новые сцены и сжатия пока не начинаются.',
    // Vast is the GPU rental service.
    paused: '⏸ На паузе: Vast подтвердил остановку.',
    pausedNote: 'Работа GPU там больше не оплачивается, но диск оплачивается и дальше.',
    starting: '⏳ Запускается. Это может занять время: ждём свободную видеокарту на Vast и прогрев модели.',
    // Names the Refresh button.
    error: '⚠️ Ошибка управления GPU. Это не значит, что он на паузе: он может работать и оплачиваться. Нажми «Обновить».',
    unknown: '❔ Состояние GPU неизвестно. Это не значит, что он на паузе или бесплатен. Нажми «Обновить».',
    // Name the Pause GPU and Start GPU buttons.
    pauseHint: '«Пауза GPU» остановит его для всех. Если модель сейчас работает, пауза дождётся конца всех сцен и сжатий.',
    startHint: '«Запустить GPU» тоже может занять время: свободная видеокарта и прогрев модели.',
    storageNote: 'Истории и чекпоинты хранятся у бота и при паузе не пропадают.',
    start: '▶️ Запустить GPU',
    pause: '⏸ Пауза GPU',
    // After «🖥 GPU: » in the menu. The last two name the Model button.
    short: {
      ready: (n: number | null) => `работает · задач: ${jobs(n)}`,
      draining: (n: number | null) => `ставится на паузу, ждёт задач: ${jobs(n)}`,
      stopping: 'останавливается',
      paused: 'на паузе',
      starting: 'запускается',
      error: 'ошибка, открой «Модель» и обнови',
      unknown: 'состояние неизвестно, открой «Модель» и обнови',
    },
  },

  seeds: {
    title: '📚 Сиды',
    titleCount: (n: number) => `📚 Сиды: ${n}`,
    none: 'Сидов пока нет.',
    // In a list line, where the number of stories would be.
    noStories: 'историй нет',
    hint: 'Выбери сид, чтобы начать историю или открыть начатую.',
  },

  seed: {
    notFound: 'Сид не найден.',
    title: (name: string) => `🌱 Сид ${name}`,
    // `time` is the world time «2026-08-02 20:00» or «—».
    start: (time: string) => `Начало в мире: ${time}`,
    startStory: '▶️ Начать новую историю',
    stories: (n: number) => `📖 Истории из этого сида: ${n}`,
    // A story in the list of its seed; the button is the same with an emoji.
    story: (n: number) => `История ${n}`,
    storyButton: (n: number) => `📖 История ${n}`,
    // Names the Start a new story button.
    noStories: 'Историй пока нет. «Начать новую историю» создаст её и сразу напишет первую сцену.',
    delete: '🗑 Удалить сид',
    all: '📚 Все сиды',
  },

  story: {
    notFound: 'История не найдена.',
    branches: (n: number) => `🌿 Ветки: ${n}`,
    none: 'Веток нет.',
    hint: 'Ветка — отдельная линия событий. Новая появляется, когда продолжаешь историю с чекпоинта; старая остаётся как была.',
    tree: '🌳 Дерево истории',
    toSeed: '🌱 К сиду',
  },

  // The story drawn as a tree in a monospaced block: keep the marks short.
  tree: {
    root: '🌱 начало',
    // A straight run of scenes; `until` is the world time of its last scene as «02.08 20:30», or null.
    run: (n: number, until: string | null) => `${count(n, 'сцена', 'сцены', 'сцен')}${until ? ` до ${until}` : ''}`,
    more: (n: number) => `… и ещё ${n}`,
    compaction: '🗜 сжатие памяти',
    // In place of an empty branch name or checkpoint label.
    branch: 'ветка',
    checkpoint: 'чекпоинт',
    legend: '🌿 ветка · 🗜 сжатие памяти · 📍 твой чекпоинт · ✅ здесь ты сейчас. Участок без развилок и отметок свёрнут в одну строку; время — в мире истории. Каждая сцена участка — в журнале ветки ниже.',
    // Button; `branch` is the plain branch name, up to 30 characters, not quoted.
    scenes: (branch: string) => `📜 Сцены: ${branch}`,
    toStory: '📖 К истории',
  },

  // Scenes of one branch, newest first.
  log: {
    title: (name: string) => `📜 Сцены ветки ${name}`,
    summary: (n: number) => `${count(n, 'сцена', 'сцены', 'сцен')}, новые сверху`,
    // Marks after a scene's time.
    compaction: '🗜 сжатие',
    truncated: '⚠️ обрыв',
    // On a button when the scene has no author input.
    scene: 'сцена',
    none: 'Сцен пока нет.',
    hint: 'Открой сцену, чтобы прочитать её или продолжить с неё новой веткой.',
    newer: '⬆️ Новее',
    older: 'Старше ⬇️',
    tree: '🌳 Дерево',
    toBranch: '🌿 К ветке',
  },

  branch: {
    notFound: 'Ветка не найдена.',
    title: (name: string) => `🌿 Ветка ${name}`,
    isCurrent: '✅ Это текущая ветка.',
    lastScene: 'Последняя сцена:',
    pickHint: 'Выбери ветку, чтобы играть в ней, — покажу её последнюю сцену.',
    play: '✅ Играть в этой ветке',
    scenes: '📜 Сцены ветки',
    checkpoints: (n: number) => `🔖 Чекпоинты (${n})`,
    delete: '🗑 Удалить ветку',
    all: '◀️ Все ветки',
  },

  checkpoints: {
    title: (name: string, n: number) => `🔖 Чекпоинты ветки ${name}: ${n}`,
    hint: 'Открой чекпоинт, чтобы перечитать сцену и при желании продолжить с неё в новой ветке. Сверху — самые новые.',
    none: 'Чекпоинтов пока нет — они появляются после каждой сцены.',
    newer: '⬅️ Новее',
    older: 'Старше ➡️',
    toBranch: '◀️ К ветке',
  },

  checkpoint: {
    notFound: 'Чекпоинт не найден.',
    // In place of an empty label.
    untitled: 'Чекпоинт',
    branch: (name: string, story: string) => `🌿 Ветка ${name} · ${story}`,
    isHead: '✅ Это последняя сцена текущей ветки.',
    atStart: '🌱 Начало истории, сцен ещё нет.',
    start: (time: string) => `Старт в мире: ${time}`,
    seedMissing: 'Сид недоступен.',
    textMissing: 'Текст сцены недоступен.',
    // `text` is what the author wrote before the scene.
    input: (text: string) => `✍️ Ввод: ${text}`,
    truncated: '⚠️ Сцена оборвалась при генерации.',
    // Names the Continue from here button.
    forkNote: (name: string) => `«Продолжить отсюда» создаст новую ветку с этого момента. Ветка ${name} останется как есть.`,
    fork: '🌿 Продолжить отсюда',
    back: '◀️ Чекпоинты',
  },

  context: {
    title: '📏 Контекст',
    // `label` is a branch name or a checkpoint label, not quoted.
    titleOf: (label: string) => `📏 Контекст: ${label}`,
    // In place of an empty label.
    checkpoint: 'чекпоинт',
    branch: 'текущая ветка',
    none: '📏 Контекст: данных пока нет.',
    noStory: 'История не выбрана. Открой сид и выбери ветку.',
    currentBranch: '📏 Контекст текущей ветки',
    noData: 'Данных о размере контекста пока нет.',
    noCheckpointData: 'Данных о размере этого чекпоинта пока нет.',
    atCheckpoint: 'Размер на момент этого чекпоинта.',
    atBranch: 'Текущая ветка, последнее сохранённое состояние.',
    duringCompaction: '⏳ Идёт сжатие памяти — здесь состояние до него.',
    duringScene: '⏳ Сцена, которая сейчас пишется, здесь не учтена.',
    // «ток.» is short for tokens.
    window: (limit: string, reserve: string | null) => `Окно: ${limit} ток. вместе с ответом${reserve ? `; резерв на ответ ${reserve}` : ''}.`,
    windowUnknown: 'Окно: размер неизвестен.',
    // `share` is «12%» or «<1%», or null. Names the Continue button.
    nextRequest: (tokens: string, share: string | null) => `Следующий запрос ≈${tokens} ток.${share ? ` (≈${share} окна)` : ''}: снимок, правила бота и обычное «Продолжить». Длинный ввод добавит своё.`,
    nextRequestUnknown: 'Следующий запрос: оценки нет.',
    estimateFromUsage: 'Оценка сверена с последним измеренным запросом этой линии.',
    estimateFromBytes: 'Грубая оценка: байты UTF-8 ÷ 4 плюс запас на служебную часть.',
    // `input` is null when unknown.
    budget: (input: string | null, limit: string) => `Бюджет ввода (окно минус резерв): ${input ? `≈${input}` : 'неизвестно'} из ${limit} ток.`,
    remaining: (tokens: string) => `Осталось ≈${tokens} ток.`,
    exhausted: '⚠️ По оценке бюджет ввода уже исчерпан.',
    forecastNote: 'Это прогноз, а не точный подсчёт: фактический вход ещё раз проверяется в начале ответа модели, до показа текста.',
    // `keep` is how many latest scenes stay verbatim, null when unknown.
    autoCompaction: (threshold: string, keep: number | null) => `Автосжатие: когда вход достигает ≈${threshold} ток.${keep === null ? '' : `; последние ${count(keep, 'сцена остаётся', 'сцены остаются', 'сцен остаются')} целиком`}.`,
    autoCompactionNote: 'Измеренные токены могут поправить предварительную оценку. До и после сжатия сохраняются чекпоинты, исходные сцены остаются в архиве.',
    // «Б» is bytes.
    snapshot: 'Снимок (Б — точно; ≈ — байты UTF-8 ÷ 4, не точный подсчёт токенов):',
    bytes: (n: string) => `${n} Б`,
    bytesUnknown: 'размер неизвестен',
    tokens: (n: string) => `≈${n} ток.`,
    tokensUnknown: 'токены неизвестны',
    // `size` is «bytes · tokens» built from the four entries above.
    seed: (size: string) => `• Сид: ${size}`,
    memory: (size: string) => `• Память: ${size}`,
    memoryEmpty: 'пусто, сжатий ещё не было',
    prefix: (size: string) => `= Сид + память: ${size}`,
    tail: (scenes: number | null, size: string) => `• Несжатые сцены${scenes === null ? '' : ` (${scenes})`}: ${size}`,
    whole: (size: string) => `= Весь снимок: ${size}`,
    // Each argument is a formatted number or format.unknown.
    lastRequest: (input: string, output: string, total: string) => `Последний запрос (измерено): вход ${input} · выход ${output} · всего ${total}`,
    lastRequestNone: 'Последний запрос (измерено): нет измерений',
    lastRequestNote: 'Вход считается вместе с кэшем; выход может включать скрытые рассуждения модели. Это один запрос, а не расход за всё время и не прогноз следующего.',
    // Must start with 🗜. Names the Compact now button. `keep` as in autoCompaction.
    compactNote: (keep: number | null) => `🗜 «Сжать сейчас» перескажет старые сцены в память, не дожидаясь порога. ${keep === null ? 'Последние сцены' : `Последние ${count(keep, 'сцена', 'сцены', 'сцен')}`} останутся целиком, исходные сцены сохранятся в архиве, до и после сжатия будут чекпоинты. Новую сцену сжатие не пишет.`,
  },

  // One Markdown line above a scene: letters, digits, spaces and «≈ % ,» only, nothing Markdown would read as markup.
  scenePrefix: {
    context: (percent: number, rough: boolean) => `📏 Контекст ≈ ${percent}%${rough ? ', грубая оценка' : ''}`,
    contextBelowOne: (rough: boolean) => `📏 Контекст менее 1%${rough ? ', грубая оценка' : ''}`,
  },

  // Both delete confirmations.
  deletion: {
    note: 'Удаляется из сохранённой библиотеки бота, восстановить будет нельзя. Уже отправленные сообщения в этом чате останутся.',
    seedTitle: (name: string) => `🗑 Удалить сид ${name}?`,
    // Heads a bulleted list of count.stories, count.branches and scenesAndCheckpoints.
    withSeed: 'Вместе с ним навсегда удалятся:',
    scenesAndCheckpoints: (n: number) => `${count(n, 'сцена', 'сцены', 'сцен')} и все чекпоинты`,
    includesCurrent: 'в том числе текущая история',
    onlySeed: 'Историй из этого сида нет — удалится только сам сид.',
    confirmAll: '🗑 Да, удалить всё',
    confirmSeed: '🗑 Да, удалить сид',
    branchTitle: (name: string) => `🗑 Удалить ветку ${name}?`,
    // Heads a bulleted list of count.scenes and count.checkpoints.
    onlyBranch: 'Это единственная ветка, поэтому история удалится целиком:',
    seedStays: (name: string) => `Сид ${name} останется — из него можно начать новую историю.`,
    // Heads a bulleted list of the next two or three entries.
    forever: 'Навсегда удалятся:',
    checkpointsOfBranch: (n: number) => `${count(n, 'чекпоинт', 'чекпоинта', 'чекпоинтов')} этой ветки`,
    scenesOnlyHere: (n: number) => `${count(n, 'сцена', 'сцены', 'сцен')}, ${n % 10 === 1 && n % 100 !== 11 ? 'которой' : 'которых'} нет в других ветках`,
    scenesStay: 'сцены останутся: все они есть в других ветках',
    kept: (n: number) => `Сохранятся: ${count(n, 'другая ветка', 'другие ветки', 'других веток')} этой истории.`,
    isCurrent: '⚠️ Это текущая ветка — после удаления выбери другую.',
    confirmBranch: '🗑 Да, удалить ветку',
    confirmStory: '🗑 Да, удалить историю',
  },

  newSeed: {
    title: '➕ Новый сид',
    // The date format in step 2 is fixed: YYYY-MM-DD HH:MM in the letters of your language. Names the Save seed button.
    steps: [
      'Пришли описание одним или несколькими сообщениями:',
      '1) первая строка — название, до 100 знаков;',
      '2) вторая — дата и время начала в мире: ГГГГ-ММ-ДД ЧЧ:ММ;',
      '3) дальше — мир, персонаж и стартовая ситуация.',
      '',
      'Длинный текст можно разбить на несколько сообщений: всё соберётся в один черновик.',
      '📎 Или приложи файл .txt / .md (UTF-8, до 256 КиБ на весь черновик): целиком, с названием и датой в первых строках, или только описание — тогда название и дату пришли сообщением перед файлом. Подпись к файлу не учитывается, PDF и DOCX не подходят.',
      'Когда отправишь всё, нажми «💾 Сохранить сид». До этого сид не сохраняется и сцены не пишутся.',
    ].join('\n'),
    exampleLabel: 'Пример:',
    // Three lines a user can copy: a title, a date exactly in this format, a short synthetic description.
    example: [
      'Маяк на краю света',
      '2026-08-02 20:00',
      'Северный остров, конец лета. Мира, 27 лет, первый вечер работает смотрительницей маяка. К причалу прибивает пустую лодку с зажжённым фонарём.',
    ].join('\n'),
    compactRunning: '⏳ Сжатие памяти, начатое раньше, ещё идёт.',
    sceneRunning: '⏳ Сцена, начатая раньше, ещё пишется.',
    cancel: '✖️ Отмена',
  },

  // Receipt after each part of a seed draft. Names the Save seed button.
  draft: {
    title: '📝 Черновик сида — ещё не сохранён',
    received: (parts: number, characters: number) => `Получено: ${count(parts, 'часть', 'части', 'частей')} · ${count(characters, 'знак', 'знака', 'знаков')}`,
    more: 'Можно прислать ещё сообщения или файлы .txt / .md — они добавятся к описанию.',
    saveHint: 'Когда отправишь всё, нажми «💾 Сохранить сид». Сцены не пишутся ни сейчас, ни при сохранении — историю можно будет начать отдельно.',
    menuNote: 'Меню и остальные кнопки снова заработают после сохранения или отмены черновика.',
    save: '💾 Сохранить сид',
    discard: '🗑 Отменить черновик',
  },

  // Status of a memory compaction: one message edited in place. Every title must start with its emoji (🗜 ✅ ⚠️ ✖️):
  // tests and the owner's eye find the message by it.
  compact: {
    title: '🗜 Сжатие памяти',
    titleAutomatic: '🗜 Сжатие памяти перед новой сценой',
    now: {
      queued: '⏳ Сейчас: ждёт своей очереди',
      extracting: '⏳ Сейчас: модель извлекает память из сцен',
      validating: '⏳ Сейчас: проверяем структуру памяти и ссылки на сцены',
      saving: '⏳ Сейчас: сохраняем память и чекпоинт',
    },
    // One word each: they stand in a row «✅ queue → ⏳ extraction → ▫️ check → ▫️ saving».
    steps: { queued: 'очередь', extracting: 'извлечение', validating: 'проверка', saving: 'сохранение' },
    // `time` is one of duration.
    elapsed: (time: string) => `Прошло: ${time}`,
    // `kept` is how many latest scenes stay verbatim, null when unknown.
    scope: (scenes: number, kept: number | null) => `Сцен в этом сжатии: ${scenes}; ${lastScenes(kept)} не трогаем.`,
    repair: (scenes: number) => `↩️ Дополнительное извлечение пропущенных сцен: ${scenes}.`,
    memoryJson: (characters: number) => `JSON памяти: ${grouped(characters, ' ')} ${form(characters, 'символ', 'символа', 'символов')}`,
    extraJson: (characters: number) => `Дополнительный JSON: ${grouped(characters, ' ')} ${form(characters, 'символ', 'символа', 'символов')}`,
    live: 'Сообщение обновляется по ходу работы.',
    cancelAutomatic: '✖️ Отменить',
    done: (time: string | null) => `✅ Сжатие готово${time ? ` · ${time}` : ''}`,
    summary: (scenes: number, facts: number) => `Пересказано сцен: ${scenes}, фактов в памяти: ${facts}.`,
    summaryScenes: (scenes: number) => `Пересказано сцен: ${scenes}.`,
    summaryFacts: (facts: number) => `фактов в памяти: ${facts}.`,
    repaired: (scenes: number) => `Пропущенные сцены (${scenes}) дополнены; проверка ссылок пройдена.`,
    kept: (kept: number | null) => `${kept === null ? 'Последние сцены' : `Последние ${count(kept, 'сцена', 'сцены', 'сцен')}`} остались как были. Исходные сцены сохранены, до и после сжатия есть чекпоинты.`,
    continues: 'История продолжается: дальше пишется новая сцена.',
    failed: (time: string | null) => `⚠️ Сжатие не получилось${time ? ` · ${time}` : ''}`,
    cancelled: (time: string | null) => `✖️ Сжатие отменено${time ? ` · ${time}` : ''}`,
    // `reason` is one of reasons below.
    reason: (reason: string) => `Причина: ${reason}.`,
    reasons: {
      output_limit: 'пересказ не уместился в лимит ответа модели',
      finish_reason: 'модель оборвала ответ',
      json: 'модель ответила не в нужном формате',
      shape: 'ответ модели не прошёл проверку структуры',
      fact: 'один из фактов не прошёл проверку',
      source: 'факт сослался на сцену не из этого сжатия',
      coverage: 'пересказ охватил не все сцены',
      evidence: 'ссылки на свидетельства не прошли проверку',
      quote: 'цитата не нашлась в исходной сцене',
      conflict: 'обнаруженное противоречие не оформлено по схеме',
      memory_not_smaller: 'память получилась не короче исходных сцен',
      provider_failed: 'модель недоступна или вернула ошибку',
      timeout: 'модель не ответила вовремя',
      context_limit: 'сцены не поместились в контекст модели',
    },
    safe: 'Память из этой попытки не сохранена. Исходные сцены и чекпоинты целы.',
    // `command` is /continue or /compact.
    retry: (command: string) => `Повторить: ${command}`,
    // Both name the Context button.
    unknown: 'Состояние сжатия неизвестно. Проверь «Контекст».',
    failure: 'Не получилось показать статус. Проверь «Контекст».',
  },

  // Short replies of the bot outside the screens.
  notices: {
    unknownCommand: 'Не знаю такой команды. Открой /menu.',
    // Above the menu after /cancel stopped a model job.
    cancelled: 'Операция отменена. Готовые сцены и чекпоинты сохранены.',
    // `keep` is the configured number of latest scenes that are never compacted.
    nothingToCompact: (keep: number) => `Пока нечего сжимать: последние ${keep} сцены оставляем целиком. Новая сцена не создаётся.`,
    nothingToCompactYet: (keep: number) => `Пока нечего сжимать: последние ${keep} сцены оставляем целиком.`,
    textOnly: 'Пока поддерживаются текстовые сообщения. Открой /menu или напиши действие персонажа.',
    truncated: 'Ответ достиг лимита выходных токенов и мог оборваться. Полученный текст сохранён. /continue продолжит историю.',
    deliveryUnconfirmed: 'Сцена сохранена, но доставка не подтверждена. /last покажет её без новой генерации.',
    contextLimit: 'Сид, накопленная память, последние сцены или новый ввод не помещаются в выбранный порог контекста. Все исходные сцены и чекпоинты сохранены. Можно сократить ввод или открыть другую точку через /checkpoints.',
    // `command` is /continue or /compact.
    compactionUnverified: (command: string) => `Сжатие не удалось проверить. Исходные сцены и готовые чекпоинты сохранены. Повторить: ${command}.`,
    failed: (command: string) => `Не получилось завершить операцию. Готовые сцены и чекпоинты сохранены. Повторить: ${command}.`,
    gpuNotConfigured: 'Управление арендой GPU пока не настроено. /model покажет текущую модель.',
    gpuPaused: 'GPU перешла на паузу. Открой /model и запусти её; затем отправь действие снова.',
  },

  // Refusals shown as a plain message. The key is what the code throws; keep the group flat, strings only.
  errors: {
    seedFormat: 'Нужны название (до 100 знаков), дата в формате 2026-08-02 20:00 и описание мира, каждое с новой строки.',
    seedGone: 'Сид уже удалён.',
    pickBranch: 'Выбери ветку истории через /seeds.',
    pickStory: 'Выбери историю или чекпоинт через /seeds.',
    checkpointGone: 'Чекпоинт уже удалён.',
    branchGone: 'Ветка уже удалена.',
    branchGoneOpenSeeds: 'Эта ветка уже удалена. Открой /seeds.',
    jobRunning: 'Продолжение уже готовится. /cancel отменит его, если запрос завис.',
    sceneTime: 'Модель не указала корректные дату и время. Ответ не записан; отправь продолжение ещё раз.',
    busy: 'Уже выполняется генерация или сжатие. Дождись ответа или нажми /cancel, затем отправь сообщение снова.',
    busyNewSeed: 'Сцена уже пишется. Дождись ответа или нажми /cancel, затем создай сид.',
    staleButton: 'Кнопка устарела. Открой /menu.',
    staleConfirmation: 'Это подтверждение устарело. Открой удаление заново через /seeds.',
    gpuNotReady: 'GPU сейчас не готова. Открой /model: там можно запустить её или проверить состояние. Затем отправь действие снова.',
    unsupportedContent: 'В сообщении есть неподдерживаемое содержимое. Пришли сид или продолжение текстом без вложений. Ничего не сохранено.',
    draftChanged: 'Черновик изменился во время загрузки. Файл не добавлен; открой /new и отправь его снова.',
    // Names the Save seed button.
    otherDraft: 'Эта кнопка относится к другому черновику. Используй «Сохранить сид» под последней принятой частью.',
    draftNeedsText: 'Пришли следующую часть сида текстом. Когда закончишь, нажми «Сохранить сид». /cancel отменит ввод.',
    draftTooLarge: 'Эта часть превышает общий предел черновика — 256 КиБ текста. Она не добавлена; предыдущие части остаются в черновике. /cancel отменит ввод.',
    draftClosed: 'Этот черновик уже сохранён или отменён. Новый сид можно создать через /new.',
    fileNeedsDraft: 'Чтобы загрузить сид файлом, сначала открой /new. Файл не добавлен в историю.',
    fileFailed: 'Не удалось прочитать файл. Черновик не изменён; отправь файл ещё раз.',
    fileIncomplete: 'Не удалось прочитать файл целиком. Черновик не изменён; отправь файл ещё раз.',
    fileTooLarge: 'Файл слишком большой. Предел файла и всего черновика — 256 КиБ текста.',
    fileType: 'Пришли текстовый файл .txt или .md в кодировке UTF-8. PDF и DOCX пока не поддерживаются.',
    fileEncoding: 'Не удалось прочитать UTF-8. Сохрани файл как UTF-8 и отправь снова; черновик не изменён.',
    fileBinary: 'Нужен непустой текстовый файл .txt или .md без двоичных данных. Черновик не изменён.',
  },

  // Names the bot gives to branches and checkpoints it creates. They are stored with the story and keep the language
  // they were written in. Up to ~20 characters: they appear on buttons and in the tree.
  labels: {
    firstBranch: 'Начало',
    seedCheckpoint: 'Сид',
    // A branch forked from the checkpoint labelled `from`.
    forkBranch: (from: string) => `От ${from}`,
    forkCheckpoint: 'Точка развилки',
    scene: (n: number) => `Сцена ${n}`,
    beforeCompaction: 'До сжатия',
    afterCompaction: 'После сжатия',
  },

  // Descriptions in Telegram's command menu, 1–256 characters, no emoji needed.
  commands: {
    menu: 'Меню историй',
    seeds: 'Мои сиды',
    new: 'Создать сид',
    checkpoints: 'Сцены и чекпоинты',
    continue: 'Продолжить историю',
    last: 'Показать последнюю сцену',
    context: 'Размер контекста и счётчики токенов',
    compact: 'Сжать ранние сцены в память сейчас',
    model: 'Текущая модель и подключение',
    language: 'Язык интерфейса',
    gpu_pause: 'Пауза GPU после завершения работы',
    gpu_start: 'Запустить арендованную GPU',
    cancel: 'Отменить ввод или генерацию',
  },
};

export type Messages = typeof ru;
