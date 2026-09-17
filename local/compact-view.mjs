// Telegram status for one compaction job: a single message edited in place as the stage changes.
// Plain text only (no parse_mode). Shows real stage and elapsed time; never a percentage, ETA,
// memory text, fact preview, raw error or an unrecognised stage/reason value.

const STEPS = [
  ['queued', 'очередь'],
  ['extracting', 'извлечение'],
  ['validating', 'проверка'],
  ['saving', 'сохранение'],
];

const NOW = {
  queued: 'ждёт своей очереди',
  extracting: 'модель извлекает память из сцен',
  validating: 'проверяем структуру памяти и ссылки на сцены',
  saving: 'сохраняем память и чекпоинт',
};

const REASON = {
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
};

const SAFE = 'Память из этой попытки не сохранена. Исходные сцены и чекпоинты целы.';

export function renderCompaction(progress) {
  try {
    return view(progress && typeof progress === 'object' ? progress : {});
  } catch {
    return payload(['🗜 Сжатие памяти', 'Не получилось показать статус. Проверь «Контекст».'], [[btn('📏 Контекст', 'view:context')]]);
  }
}

function view(p) {
  const automatic = p.automatic === true;
  const elapsed = duration(p.elapsedMs);
  const scenes = whole(p.scenes);
  const kept = whole(p.keptScenes);
  const keptText = kept != null ? `последние ${count(kept, 'сцена', 'сцены', 'сцен')}` : 'последние сцены';
  const retry = automatic ? 'Повторить: /continue' : 'Повторить: /compact';

  if (Object.hasOwn(NOW, p.stage)) {
    const lines = [
      automatic ? '🗜 Сжатие памяти перед новой сценой' : '🗜 Сжатие памяти',
      `⏳ Сейчас: ${NOW[p.stage]}`,
      steps(p.stage),
      elapsed ? `Прошло: ${elapsed}` : null,
    ];
    if (scenes != null) lines.push(`Сцен в этом сжатии: ${scenes}; ${keptText} не трогаем.`);
    const repair = whole(p.repairScenes);
    if (repair > 0) lines.push(`↩️ Дополнительное извлечение пропущенных сцен: ${repair}.`);
    const chars = whole(p.outputCharacters);
    if (chars != null && chars > 0 && p.stage !== 'queued') lines.push(`${repair > 0 ? 'Дополнительный JSON' : 'JSON памяти'}: ${count(chars, 'символ', 'символа', 'символов')}`);
    lines.push('', 'Сообщение обновляется по ходу работы.');
    return payload(lines, [
      [btn(automatic ? '✖️ Отменить' : '✖️ Отменить сжатие', 'cancel')],
      [btn('📏 Контекст', 'view:context'), btn('🤖 Модель', 'view:model')],
    ]);
  }

  if (p.stage === 'done') {
    const facts = whole(p.facts);
    const summary = [
      scenes != null ? `Пересказано сцен: ${scenes}` : null,
      facts != null ? `фактов в памяти: ${facts}` : null,
    ].filter(Boolean).join(', ');
    const lines = [
      `✅ Сжатие готово${elapsed ? ` · ${elapsed}` : ''}`,
      summary ? `${summary}.` : null,
      whole(p.repairScenes) > 0 ? `Пропущенные сцены (${whole(p.repairScenes)}) дополнены; проверка ссылок пройдена.` : null,
      `${capital(keptText)} остались как были. Исходные сцены сохранены, до и после сжатия есть чекпоинты.`,
    ];
    if (automatic) lines.push('', 'История продолжается: дальше пишется новая сцена.');
    return payload(lines, [[btn('📏 Контекст', 'view:context'), btn('🏠 Меню', 'view:home')]]);
  }

  if (p.stage === 'failed') {
    const reason = Object.hasOwn(REASON, p.reason) ? REASON[p.reason] : null;
    return payload([
      `⚠️ Сжатие не получилось${elapsed ? ` · ${elapsed}` : ''}`,
      reason ? `Причина: ${reason}.` : null,
      SAFE,
      retry,
    ], [[btn('📏 Контекст', 'view:context'), btn('🤖 Модель', 'view:model')]]);
  }

  if (p.stage === 'cancelled') {
    return payload([
      `✖️ Сжатие отменено${elapsed ? ` · ${elapsed}` : ''}`,
      SAFE,
      retry,
    ], [[btn('📏 Контекст', 'view:context'), btn('🏠 Меню', 'view:home')]]);
  }

  // Unrecognised or missing stage: say nothing about progress and offer no cancel.
  return payload(
    ['🗜 Сжатие памяти', 'Состояние сжатия неизвестно. Проверь «Контекст».'],
    [[btn('📏 Контекст', 'view:context'), btn('🏠 Меню', 'view:home')]],
  );
}

function steps(stage) {
  const current = STEPS.findIndex(([id]) => id === stage);
  return STEPS.map(([, label], i) => `${i < current ? '✅' : i === current ? '⏳' : '▫️'} ${label}`).join(' → ');
}

function duration(ms) {
  if (!known(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
}

function known(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function whole(value) {
  return known(value) && value >= 0 ? Math.round(value) : null;
}

function count(n, one, few, many) {
  const tens = n % 100;
  const ones = n % 10;
  const word = tens >= 11 && tens <= 14 ? many : ones === 1 ? one : ones >= 2 && ones <= 4 ? few : many;
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ${word}`;
}

function capital(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function btn(text, data) {
  return { text, callback_data: data };
}

function payload(lines, rows) {
  const text = lines.filter(line => line != null).join('\n').trim();
  return { text, reply_markup: { inline_keyboard: rows.map(row => row.filter(Boolean)).filter(row => row.length) } };
}
