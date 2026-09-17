import { context, validTime } from '../lib/library.js';

const SYSTEM = `Ты соавтор интерактивной истории. Вход содержит сид, накопленную память и хронологический диалог выбранной ветки. Продолжи историю в ответ на последнее сообщение пользователя. Верни только новую сцену.
Пиши по-русски, если сид не задаёт другой язык. Начинай каждую сцену отдельной строкой YYYY-MM-DD HH:MM: это дата и время внутри мира, а не реальные часы. Затем пустая строка и художественный текст в Markdown, без внешнего блока кода. Пиши не более 12 абзацев.
Перед новым сообщением дана опорная дата и время последней сохранённой сцены. Авторское время вида HH:MM меняет часы и минуты, но не дату: 08:08 означает восемь часов восемь минут, не восьмое августа. Дату меняй только при явно показанном переходе на другой день или указании автора. Время в реплике, воспоминании или обещании не переводит часы всей сцены.
Понимай по смыслу реплики, действия персонажа и авторские указания без обязательных тегов. При существенной неоднозначности можно спросить короткое уточнение. Персонажи действуют сами в пределах целей, характера и доступных им знаний. Соблюдай причинность, отношения, обещания, физические ограничения и авторские указания. Слухи и намерения не превращай в факты.
Сид задаёт исходное состояние; последующие события могут его изменить. Продолжай с последней сцены, не пересказывай весь диалог. Не выдумывай реплику пользователя при просьбе продолжать самостоятельно. Явно обозначай ретроспективу и перескок во времени; дата события может отличаться от даты, когда о нём узнали.`;

const FACT_LABELS = { event: 'Событие', state: 'Состояние', knowledge: 'Знание',
  relationship: 'Отношение', promise: 'Обещание', directive: 'Указание', uncertainty: 'Неопределённость' };

// JSON remains the stored source of truth. Rendering never asks a model to
// retell it, reorder events or infer a new state; source IDs remain traceable.
function memoryText(memory, index) {
  return `Инкремент ${index + 1}. Охваченные сцены: ${memory.covered.join(', ')}\n`
    + memory.delta.facts.map(fact => {
      const label = FACT_LABELS[fact.kind] ?? fact.kind ?? 'Факт';
      const time = fact.at ? `[${fact.at}] ` : '';
      const source = fact.source?.length ? ` (источники: ${fact.source.join(', ')})` : '';
      return `${time}${label}: ${fact.text}${source}`;
    }).join('\n');
}

export function contextParts(state, point) {
  const story = state.stories[point.storyId];
  const seed = state.seeds[story.seedId];
  const { memories, recent } = context(story, point);
  return {
    seed: [{ role: 'user', content: `СИД: ${seed.title}\nНачало: ${seed.startTime}\n${seed.text}` }],
    memory: memories.length ? [{ role: 'user', content: 'НАКОПЛЕННАЯ ПАМЯТЬ ВЕТКИ:\n' + memories.map(memoryText).join('\n\n') }] : [],
    tail: recent.flatMap(node => [{ role: 'user', content: node.input }, { role: 'assistant', content: node.text }]),
    memoryCount: memories.length, sceneCount: recent.length,
  };
}

export function makeRequest(state, job, maxOutputTokens) {
  const parts = contextParts(state, job);
  const story = state.stories[job.storyId];
  const referenceTime = story.nodes[job.head]?.time ?? state.seeds[story.seedId].startTime;
  const messages = [
    ...parts.seed, ...parts.memory, ...parts.tail,
    { role: 'user', content: `Опорная дата и время последней сцены: ${referenceTime}\n\nНовое сообщение:\n${job.input}` },
  ];
  return { system: SYSTEM, messages, maxOutputTokens };
}

export function normalizeScene(text, fallbackTime) {
  let value = text.trim();
  const lines = value.split('\n');
  const first = lines[0].replace(/^[#*\s]+|[*\s]+$/g, '');
  if (validTime(first)) { lines[0] = first; value = lines.join('\n'); }
  else value = `${fallbackTime}\n\n${value}`;
  if (!text.trim()) throw new Error('Empty model response');
  return value;
}
