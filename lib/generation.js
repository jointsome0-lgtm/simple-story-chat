import { context, jobTarget, commitMemory, commitTurn, UserError } from 'lib/library';
import { storyMessages, summaryMessages, parseMemory } from 'lib/prompts';
import { LIMITS } from 'lib/model';

export class Cancelled extends Error {}

export async function generate({ store, model, jobId, onText, limits = LIMITS }) {
  async function load() {
    const target = jobTarget(await store.read(), jobId);
    if (!target) throw new Cancelled();
    return target;
  }
  let target = await load();
  let messages = storyMessages(target.seed, target.story, target.branch, target.job.input);
  const budget = Math.min(limits.input, limits.context - limits.output - limits.margin);
  let count = await model.count(messages);
  // Bound inference cost. Each pass consumes one old prefix, never the recent
  // scenes or the incoming user message. Full source nodes remain archived.
  for (let pass = 0; count > budget && pass < 8; pass++) {
    const { seed, story, branch } = target;
    let old = context(story, branch).recent.slice(0, -limits.keepTurns);
    if (!old.length) throw new UserError('Контекст заполнен памятью, сидом или последними сценами. Ничего не отброшено. Нужны более короткое сообщение или новая история.');
    let summary = summaryMessages(seed, story, branch, old);
    while (await model.count(summary) + limits.summary + limits.margin > limits.context) {
      if (old.length === 1) throw new UserError('Даже одна старая сцена не помещается в запрос сжатия. Архив сохранён.');
      old = old.slice(0, Math.ceil(old.length / 2));
      summary = summaryMessages(seed, story, branch, old);
    }
    await load();
    const result = await model.complete(summary, { summary: true, onText: async () => { await load(); } });
    const delta = parseMemory(result.text, old);
    const saved = await store.mutate(state => commitMemory(state, jobId, old.map(n => n.id), delta));
    if (!saved) throw new Cancelled();
    target = await load();
    messages = storyMessages(target.seed, target.story, target.branch, target.job.input);
    count = await model.count(messages);
  }
  if (count > budget) throw new UserError('Лимит контекста всё ещё превышен. Сохранённые инкременты и архив доступны; генерация остановлена.');
  await load();
  const result = await model.complete(messages, { onText: async text => { await load(); await onText(text); } });
  const saved = await store.mutate(state => commitTurn(state, jobId, result.text, result.truncated));
  if (!saved) throw new Cancelled();
  return { ...saved, ...result, inputTokens: count };
}
