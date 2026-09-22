// The pure parts of the walk eval: the judge's request for one scene, the parsed verdict, the panel's decision and the
// compaction schedule. local/walk-probe.ts, local/walk-judge.ts and local/eval.ts share them; nothing here runs a model.
import type { ModelRequest } from './model.ts';

export type Vote = 'consistent' | 'inconsistent' | 'error';
export const KINDS = ['number', 'item', 'place', 'person', 'knowledge', 'time', 'author_step', 'other'] as const;
export type Contradiction = { now: string; before: string; where: string; kind: typeof KINDS[number] };
export type Verdict = { turn: number; verdict: Vote; contradictions: Contradiction[]; code?: string };
// One step of a walk: the bot's own continue signal or the author's intervention, and the scene written for it.
export type Step = { turn: number; kind: 'continue' | 'intervention'; input: string; text: string };
export type JudgeFile = { judge: string; model: string; at: string; verdicts: Verdict[]; error?: string; completedAt?: string };
export type PanelRow = { turn: number; votes: Record<string, Vote>; verdict: 'consistent' | 'inconsistent' | 'split' | 'unjudged' };

// Memory is compacted after scene 7 and every fourth scene after it, as the replay compacts after 7, 11 and 15.
export const compactsAfter = (turn: number) => turn >= 7 && (turn - 7) % 4 === 0;
export const judgeFileName = (label: string) => `walk-judge-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;

const RULES = `Ты один из судей согласованности интерактивной истории. Тебе даны сид, все предыдущие шаги (на каждом шаге вмешательство автора или знак продолжать, и сцена) и новая сцена с её шагом.
Найди в новой сцене противоречия с уже установленным: (а) с явными утверждениями сида и предыдущих сцен: числа и количества, предметы и где они находятся, кто где находится, кто жив, ранен, что умеет, кто что знает и с какого момента, время суток и порядок событий, имена и роли, договорённости и запреты; (б) с вмешательством автора на этом шаге: сцена обязана его учесть. Если оно выполнимо в установленном мире, сцена его исполняет; если оно опирается на то, чего в мире нет или что противоречит установленному, правильно показать попытку и честный исход, поправку или удивление персонажей, а не исполнить буквально. Противоречие (kind author_step) — только когда сцена вмешательство игнорирует или молча меняет его условие.
Не считай противоречием: развитие событий, если сцена показывает или объясняет переход; новые детали, которые ничему прежнему не противоречат; честный ответ мира на невыполнимое вмешательство; ошибочные слова персонажа, если сцена показывает, что он ошибается или не знает; качество и стиль прозы; то, что сцена о чём-то не упоминает. Сомнение толкуй в пользу сцены: противоречие должно опираться на явные слова текста, а не на догадку.
На каждое противоречие приведи короткую цитату из новой сцены (now), короткую цитату из сида, более ранней сцены или шага (before), место этой цитаты (where: «сид», «сцена 3» или «шаг 9») и тип (kind). Если противоречий нет, verdict = consistent и пустой список. Отвечай только JSON по схеме.`;

export function judgeRequest(seed: string, steps: Step[], index: number): ModelRequest {
  const label = (step: Step) => step.kind === 'continue' ? 'знак продолжать' : 'вмешательство автора';
  const block = (step: Step) => `ШАГ ${step.turn} (${label(step)}): ${step.input}\nСЦЕНА ${step.turn}:\n${step.text}`;
  const history = steps.slice(0, index).map(block).join('\n\n');
  const current = steps[index];
  return {
    system: RULES,
    messages: [{ role: 'user', content: `СИД:\n${seed}\n\nИСТОРИЯ ДО НОВОЙ СЦЕНЫ:\n${history || '(новая сцена первая)'}\n\nШАГ ${current.turn} (${label(current)}): ${current.input}\nНОВАЯ СЦЕНА ${current.turn}:\n${current.text}` }],
    // A judge that reasons in text before its answer needs the room; through the Claude CLI the cap is the whole run.
    maxOutputTokens: 8192, purpose: 'memory',
    outputSchema: { type: 'object', required: ['verdict', 'contradictions'], additionalProperties: false, properties: {
      verdict: { type: 'string', enum: ['consistent', 'inconsistent'] },
      contradictions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['now', 'before', 'where', 'kind'], additionalProperties: false, properties: {
        now: { type: 'string', maxLength: 400 }, before: { type: 'string', maxLength: 400 }, where: { type: 'string', maxLength: 60 }, kind: { type: 'string', enum: [...KINDS] } } } } } },
  };
}

// Evidence decides: a reply that lists contradictions is inconsistent whatever its flag says, and a flag without
// evidence is an abstention. A reply without a valid flag is an error of the judge.
export function parseVerdict(text: string): { verdict: Vote; contradictions: Contradiction[] } {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced ? fenced[1] : trimmed) as { verdict?: unknown; contradictions?: unknown };
  const valid = (c: unknown): c is Contradiction => !!c && typeof c === 'object' && typeof (c as Contradiction).now === 'string'
    && typeof (c as Contradiction).before === 'string' && typeof (c as Contradiction).where === 'string' && (KINDS as readonly string[]).includes((c as Contradiction).kind);
  const list = Array.isArray(parsed.contradictions) ? parsed.contradictions.filter(valid).slice(0, 20) : [];
  if (parsed.verdict !== 'consistent' && parsed.verdict !== 'inconsistent') throw Object.assign(new Error(), { code: 'invalid_verdict' });
  return { verdict: list.length ? 'inconsistent' : parsed.verdict === 'inconsistent' ? 'error' : 'consistent', contradictions: list };
}

// The majority of the votes cast decides a scene; an error is an abstention, a tie is split, no vote is unjudged.
export function panel(total: number, byJudge: Record<string, Verdict[]>): PanelRow[] {
  return Array.from({ length: total }, (_, i) => {
    const turn = i + 1;
    const votes = Object.fromEntries(Object.entries(byJudge).map(([judge, list]) => [judge, list.find(v => v.turn === turn)?.verdict ?? 'error']));
    const count = (vote: Vote) => Object.values(votes).filter(v => v === vote).length;
    const [yes, no] = [count('consistent'), count('inconsistent')];
    return { turn, votes, verdict: yes + no === 0 ? 'unjudged' : yes > no ? 'consistent' : no > yes ? 'inconsistent' : 'split' };
  });
}

export function summarize(rows: { turn: number; verdict: PanelRow['verdict'] }[]) {
  const count = (verdict: PanelRow['verdict']) => rows.filter(r => r.verdict === verdict).length;
  const first = rows.find(r => r.verdict === 'inconsistent')?.turn;
  return { total: rows.length, consistent: count('consistent'), split: count('split'), inconsistent: count('inconsistent'), unjudged: count('unjudged'),
    ...(first ? { firstInconsistent: first } : {}) };
}

// The second round, the council: every contradiction listed in the first round is put to every judge with the same
// seed, history and scene, and each judge confirms or refutes it by the text. A finding stands when more judges confirm
// it than refute it; a scene with a standing finding is inconsistent. The judge that listed a finding checks it too and
// may take it back.
export type Finding = Contradiction & { turn: number; by: string; number: number };
export type Check = { turn: number; finding: number; confirmed: boolean; note: string };
export type CrossFile = { judge: string; model: string; at: string; checks: Check[]; error?: string; completedAt?: string };
export type CouncilRow = { turn: number; findings: number; confirmed: number; refuted: number; disputed: number; verdict: PanelRow['verdict'] };

const CROSS_RULES = `Ты один из судей согласованности интерактивной истории. Тебе даны сид, все предыдущие шаги и сцены, новая сцена с её шагом и находки: противоречия, которые в новой сцене нашли судьи (среди них могут быть и твои).
Проверь каждую находку по тексту: цитата now действительно стоит в новой сцене; цитата before действительно стоит там, где указано; и они действительно несовместимы с учётом всего, что случилось между ними. Подтверди (confirmed: true) только настоящее противоречие. Опровергни, если цитаты неточны или вырваны из смысла, если сцена показывает или объясняет переход, если это новая деталь, которая ничему не противоречит, или если вмешательство автора на этом шаге само задало новое положение дел.
Верни только JSON по схеме: в checks ровно одна запись на каждую находку, по её номеру, с коротким объяснением.`;

// The findings of a scene, numbered in the order the judges are given and the order each judge listed them.
export function findings(byJudge: Record<string, Verdict[]>): Finding[] {
  const list: Finding[] = [];
  const turns = [...new Set(Object.values(byJudge).flat().map(v => v.turn))].sort((a, b) => a - b);
  for (const turn of turns) {
    let number = 0;
    for (const [by, verdicts] of Object.entries(byJudge)) {
      for (const c of verdicts.find(v => v.turn === turn)?.contradictions ?? []) list.push({ ...c, turn, by, number: ++number });
    }
  }
  return list;
}

export function crossRequest(seed: string, steps: Step[], index: number, found: Finding[]): ModelRequest {
  const base = judgeRequest(seed, steps, index);
  const lines = found.map(f => `${f.number}. Сейчас: «${f.now}» — Раньше (${f.where}): «${f.before}» — тип: ${f.kind}`);
  return { ...base, system: CROSS_RULES, messages: [{ role: 'user', content: `${base.messages[0].content}\n\nНАХОДКИ:\n${lines.join('\n')}` }],
    outputSchema: { type: 'object', required: ['checks'], additionalProperties: false, properties: { checks: { type: 'array', minItems: found.length, maxItems: found.length,
      items: { type: 'object', required: ['finding', 'confirmed', 'note'], additionalProperties: false, properties: {
        finding: { type: 'integer', minimum: 1, maximum: found.length }, confirmed: { type: 'boolean' }, note: { type: 'string', maxLength: 300 } } } } } } };
}

// Every finding must get exactly one boolean; anything else is the judge's own failure.
export function parseCross(text: string, count: number): { finding: number; confirmed: boolean; note: string }[] {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced ? fenced[1] : trimmed) as { checks?: unknown };
  const checks = Array.isArray(parsed.checks) ? parsed.checks as { finding?: unknown; confirmed?: unknown; note?: unknown }[] : [];
  const result = Array.from({ length: count }, (_, i) => {
    const matching = checks.filter(c => c && typeof c === 'object' && c.finding === i + 1 && typeof c.confirmed === 'boolean');
    if (matching.length !== 1) throw Object.assign(new Error(), { code: 'invalid_cross' });
    return { finding: i + 1, confirmed: matching[0].confirmed as boolean, note: typeof matching[0].note === 'string' ? matching[0].note.slice(0, 300) : '' };
  });
  return result;
}

// A scene without findings keeps the first round's answer. With findings, a finding stands when more judges confirm than
// refute it, falls when more refute, and is disputed on a tie; a scene with no check at all keeps the first round too.
export function council(total: number, byJudge: Record<string, Verdict[]>, crossByJudge: Record<string, Check[]>): CouncilRow[] {
  const found = findings(byJudge);
  const first = panel(total, byJudge);
  return first.map(row => {
    const mine = found.filter(f => f.turn === row.turn);
    const checks = Object.values(crossByJudge).flat().filter(c => c.turn === row.turn);
    if (!mine.length || !checks.length) return { turn: row.turn, findings: mine.length, confirmed: 0, refuted: 0, disputed: mine.length && !checks.length ? mine.length : 0, verdict: row.verdict };
    const status = mine.map(f => {
      const votes = checks.filter(c => c.finding === f.number);
      const [yes, no] = [votes.filter(v => v.confirmed).length, votes.filter(v => !v.confirmed).length];
      return yes > no ? 'confirmed' : no > yes ? 'refuted' : 'disputed';
    });
    const count = (s: string) => status.filter(x => x === s).length;
    return { turn: row.turn, findings: mine.length, confirmed: count('confirmed'), refuted: count('refuted'), disputed: count('disputed'),
      verdict: count('confirmed') ? 'inconsistent' : count('disputed') ? 'split' : 'consistent' };
  });
}

// A seed is audited before it grows anything: an ambiguity in the seed is a false finding later, on every scene.
export type Issue = { kind: 'contradiction' | 'ambiguity'; quote: string; note: string };
export type AuditFile = { judge: string; model: string; at: string; issues: Issue[]; error?: string };
const AUDIT_RULES = `Ты проверяешь сид интерактивной истории: исходное описание мира, из которого модель-рассказчик будет писать сцены, а судьи потом будут искать в сценах противоречия с сидом. Найди в сиде (а) внутренние противоречия: утверждения, которые не могут быть верны одновременно, включая числа, время, места, кто что знает; (б) двусмысленности: места, которые можно прочитать двумя способами так, что судья и рассказчик разойдутся (например, показание часов и реальное время, «сейчас» по каким часам, чей предмет, кто именно знает). Не предлагай улучшений стиля и не придумывай сюжет. На каждую находку приведи короткую точную цитату из сида и одну фразу, в чём проблема. Если сид чист, верни пустой список. Отвечай только JSON по схеме.`;
export function seedAuditRequest(seed: string): ModelRequest {
  return { system: AUDIT_RULES, messages: [{ role: 'user', content: `СИД:\n${seed}` }], maxOutputTokens: 8192, purpose: 'memory',
    outputSchema: { type: 'object', required: ['issues'], additionalProperties: false, properties: { issues: { type: 'array', maxItems: 20, items: { type: 'object',
      required: ['kind', 'quote', 'note'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['contradiction', 'ambiguity'] },
        quote: { type: 'string', maxLength: 300 }, note: { type: 'string', maxLength: 400 } } } } } } };
}
export function parseIssues(text: string): Issue[] {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced ? fenced[1] : trimmed) as { issues?: unknown };
  if (!Array.isArray(parsed.issues)) throw Object.assign(new Error(), { code: 'invalid_audit' });
  return (parsed.issues as Partial<Issue>[]).filter(i => i && (i.kind === 'contradiction' || i.kind === 'ambiguity') && typeof i.quote === 'string' && typeof i.note === 'string')
    .slice(0, 20).map(i => ({ kind: i.kind!, quote: i.quote!.slice(0, 300), note: i.note!.slice(0, 400) }));
}
export const auditFileName = (label: string) => `seed-audit-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;

export const crossFileName = (label: string) => `walk-cross-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;

// The audit of a whole story: the seed and every scene at once, for contradictions between scenes that a judge reading
// one scene at a time may have let through, and for facts the scenes introduce that can be read two ways and would
// divide a judge and a model continuing from the tree.
export type StoryIssue = Issue & { scene: number };
export type StoryAuditFile = { judge: string; model: string; at: string; issues: StoryIssue[]; error?: string };
const STORY_AUDIT_RULES = `Ты проверяешь готовую часть интерактивной истории целиком: сид и все сцены по порядку (на каждом шаге вмешательство автора или знак продолжать, и сцена). Дальше из любой сцены другая модель будет писать продолжение, а судьи будут искать в продолжении противоречия с этим текстом. Найди (а) противоречия: утверждения сцен, несовместимые с сидом или с более ранними сценами, включая числа, время, места, предметы, кто где, кто что знает; (б) неясности, которые сцены вносят в мир: новый факт, который можно прочитать двумя способами (число, время, место, чьё знание), так что рассказчик продолжения и судья разойдутся. Не оценивай стиль, не предлагай сюжет, не повторяй одно и то же под разными цитатами. На каждую находку укажи номер сцены (scene), короткую точную цитату из неё (quote) и одну фразу, в чём проблема (note); для противоречия в note назови, с чем оно расходится (сид или номер сцены). Если чисто, верни пустой список. Отвечай только JSON по схеме.`;
export function storyAuditRequest(seed: string, steps: Step[]): ModelRequest {
  const label = (step: Step) => step.kind === 'continue' ? 'знак продолжать' : 'вмешательство автора';
  const body = steps.map(step => `ШАГ ${step.turn} (${label(step)}): ${step.input}\nСЦЕНА ${step.turn}:\n${step.text}`).join('\n\n');
  return { system: STORY_AUDIT_RULES, messages: [{ role: 'user', content: `СИД:\n${seed}\n\nИСТОРИЯ:\n${body}` }], maxOutputTokens: 16384, purpose: 'memory',
    outputSchema: { type: 'object', required: ['issues'], additionalProperties: false, properties: { issues: { type: 'array', maxItems: 40, items: { type: 'object',
      required: ['kind', 'scene', 'quote', 'note'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['contradiction', 'ambiguity'] }, scene: { type: 'integer', minimum: 1 },
        quote: { type: 'string', maxLength: 300 }, note: { type: 'string', maxLength: 400 } } } } } } };
}
export function parseStoryIssues(text: string, scenes: number): StoryIssue[] {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced ? fenced[1] : trimmed) as { issues?: unknown };
  if (!Array.isArray(parsed.issues)) throw Object.assign(new Error(), { code: 'invalid_audit' });
  return (parsed.issues as Partial<StoryIssue>[]).filter(i => i && (i.kind === 'contradiction' || i.kind === 'ambiguity') && Number.isInteger(i.scene) && i.scene! >= 1 && i.scene! <= scenes && typeof i.quote === 'string' && typeof i.note === 'string')
    .slice(0, 40).map(i => ({ kind: i.kind!, scene: i.scene!, quote: i.quote!.slice(0, 300), note: i.note!.slice(0, 400) }));
}
export const storyAuditFileName = (label: string) => `story-audit-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
