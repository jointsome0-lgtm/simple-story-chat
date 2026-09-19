import type { Fact, MemoryVersion, Point, SceneNode, Seed, Story } from '../lib/library.ts';
import { context } from '../lib/library.ts';
import type { ErrorDetails } from './model-error.ts';
import { ModelError, member } from './model-error.ts';
import type { ModelRequest } from './model.ts';
import { narration, seedNarration } from './story-text.ts';
import type { Narration, StoryLang } from './story-text.ts';

// Only the scene fields sent to the model.
type Scene = Pick<SceneNode, 'id' | 'input' | 'text'>;
type Target = { seed: Seed; story: Story; branch: Point };
type Delta = MemoryVersion['delta'];
// A provider result is checked again here, so both fields are read as unknown.
type Output = { text?: unknown; finishReason?: unknown };
type MemoryReason = NonNullable<ErrorDetails['memoryReason']>;

const SUMMARY_TOKENS = 4096;
const FACT_KINDS = ['event', 'state', 'knowledge', 'relationship', 'promise', 'directive', 'uncertainty'] as const;
const invalid: (memoryReason?: MemoryReason, details?: ErrorDetails) => never =
  (memoryReason = 'shape', details) => { throw new ModelError('invalid_memory', { ...details, operation: 'compact', memoryReason }); };

// Extraction reads the scenes of the story, so its rules are written in the language of the seed (story-text.ts).
function plainRequest(target: Target, nodes: Scene[], repair?: { draftFacts: Fact[]; precedingScenes: Scene[] }): ModelRequest {
  const maxFacts = repair ? 200 - repair.draftFacts.length : 200;
  if (maxFacts < 1) invalid('coverage');
  const n = seedNarration(target.seed);
  return {
    system: n.summaryRules + (repair ? '\n' + n.supplementRules(maxFacts) : ''),
    messages: [{ role: 'user', content: JSON.stringify({ seed: target.seed,
      previousMemory: context(target.story, target.branch).memories.map(m => ({ facts: m.delta.facts })),
      ...(repair ?? {}),
      newScenes: nodes.map(({ id, input, text }) => ({ id, input, text })),
    }) }],
    maxOutputTokens: SUMMARY_TOKENS,
    purpose: 'memory',
    outputSchema: {
      type: 'object', required: ['facts'], additionalProperties: false,
      properties: { facts: { type: 'array', minItems: 1, maxItems: maxFacts, items: {
        type: 'object', required: ['kind', 'at', 'text', 'source'], additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: FACT_KINDS },
          at: { type: 'string', minLength: 1, maxLength: 200 },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
          source: { type: 'array', minItems: 1, maxItems: nodes.length,
            items: { type: 'string', enum: nodes.map(node => node.id) } },
        },
      } } },
    },
  };
}

function parsePlain(result: Output, nodes: Scene[]): Delta {
  if (result.finishReason === 'length') invalid('output_limit');
  if (result.finishReason !== 'stop') invalid('finish_reason');
  if (typeof result.text !== 'string') invalid('json');
  // Any JSON value; reading a field of a non-object gives undefined, which fails the checks below.
  let parsed: { facts?: unknown } | null;
  // Haiku can wrap otherwise valid JSON in a single Markdown code block even
  // when asked for JSON alone. Remove only that whole-response wrapper; prose,
  // multiple blocks and malformed/truncated JSON still fail validation.
  const text = result.text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  try { parsed = JSON.parse(fenced ? fenced[1] : text); } catch { invalid('json'); }
  const kinds = new Set<unknown>(FACT_KINDS);
  const allowed = new Set<unknown>(nodes.map(n => n.id));
  if (!Array.isArray(parsed?.facts) || !parsed.facts.length || parsed.facts.length > 200) invalid('shape');
  const facts = parsed.facts.map((f: { kind?: unknown; at?: unknown; text?: unknown; source?: unknown } | null): Fact => {
    if (!f || !kinds.has(f.kind) || typeof f.at !== 'string' || !f.at.trim() || f.at.length > 200
        || typeof f.text !== 'string' || !f.text.trim() || f.text.length > 4000) invalid('fact');
    if (!Array.isArray(f.source) || !f.source.length || f.source.length > nodes.length
        || f.source.some((source: unknown) => !allowed.has(source))) invalid('source');
    // The kind is one of FACT_KINDS and every source is a node id.
    return { kind: f.kind as string, at: f.at, text: f.text, source: [...new Set<string>(f.source)] };
  });
  return { facts };
}

// A quote must match its scene exactly. For the log only: the loosest comparison under which a failed quote would
// have matched, which tells a model that retypes punctuation from one that paraphrases or invents.
const spaces = (text: string) => text.replace(/\s+/g, ' ').trim();
const typography = (text: string) => spaces(text).replace(/[«»„“”‘’']/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const letters = (text: string) => typography(text).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/g, ' ').trim();
function quoteMiss(source: string, quote: string) {
  return spaces(source).includes(spaces(quote)) ? 'quoteWhitespace' : typography(source).includes(typography(quote)) ? 'quoteTypography'
    : letters(source).includes(letters(quote)) ? 'quotePunctuation' : 'quoteOther';
}

const STATUSES = ['actual', 'planned', 'cancelled', 'uncertain'] as const;

const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength });
const list = (items: object, maxItems: number, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const evidenceId = { type: 'string', pattern: '^e[1-9][0-9]{0,3}$' };
function sgrRequest(target: Target, nodes: Scene[]): ModelRequest {
  const base = plainRequest(target, nodes);
  return { ...base, system: seedNarration(target.seed).sgrRules, maxOutputTokens: 8192, outputSchema: object({
    evidence: list(object({ id: evidenceId, scene: { type: 'string', enum: nodes.map(n => n.id) },
      part: { type: 'string', enum: ['input', 'text'] }, quote: string(1000) }), 400, 1),
    conflicts: list(object({ input: evidenceId, text: evidenceId,
      resolution: { type: 'string', enum: ['author_priority', 'unresolved'] } }), 100),
    facts: list(object({ kind: { type: 'string', enum: FACT_KINDS }, at: string(200),
      status: { type: 'string', enum: STATUSES }, text: string(4000), evidence: list(evidenceId, 40, 1) }), 200, 1),
  }) };
}

function keys<K extends string>(value: unknown, expected: K[]): asserts value is Record<K, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) invalid();
}
const nonempty = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const array = (value: unknown, min: number, max: number): value is unknown[] => Array.isArray(value) && value.length >= min && value.length <= max;
function parseSgr(result: Output, nodes: Scene[], n: Narration): Delta {
  if (result.finishReason === 'length') invalid('output_limit');
  if (result.finishReason !== 'stop') invalid('finish_reason');
  if (typeof result.text !== 'string') invalid('json');
  let data: unknown;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(result.text.trim());
  try { data = JSON.parse(fenced ? fenced[1] : result.text); } catch { invalid('json'); }
  keys(data, ['evidence', 'conflicts', 'facts']);
  if (!array(data.evidence, 1, 400) || !array(data.conflicts, 0, 100) || !array(data.facts, 1, 200)) invalid();
  const sources = new Map<unknown, Scene>(nodes.map(n => [n.id, n]));
  const evidence = new Map<unknown, Record<'id' | 'scene' | 'part' | 'quote', unknown>>();
  const misses = { quoteWhitespace: 0, quoteTypography: 0, quotePunctuation: 0, quoteOther: 0 };
  for (const item of data.evidence) {
    keys(item, ['id', 'scene', 'part', 'quote']);
    // test() converts its argument to a string as well.
    if (!/^e[1-9][0-9]{0,3}$/.test(String(item.id)) || evidence.has(item.id) || !sources.has(item.scene)
        || !member(['input', 'text'] as const, item.part) || !nonempty(item.quote, 1000)) invalid('evidence');
    if (!sources.get(item.scene)![item.part].includes(item.quote)) misses[quoteMiss(sources.get(item.scene)![item.part], item.quote)]++;
    evidence.set(item.id, item);
  }
  if (Object.values(misses).some(Boolean)) invalid('quote', { quoteCount: data.evidence.length, ...misses });
  for (const conflict of data.conflicts) {
    keys(conflict, ['input', 'text', 'resolution']);
    const input = evidence.get(conflict.input);
    const text = evidence.get(conflict.text);
    if (input?.part !== 'input' || text?.part !== 'text' || input.scene !== text.scene
        || !member(['author_priority', 'unresolved'], conflict.resolution)) invalid('conflict');
    // A detected conflict cannot disappear from the final memory silently.
    // Facts are checked below; here a field of a non-object fact reads as undefined.
    const unchecked = data.facts as ({ evidence?: unknown; kind?: unknown } | null)[];
    if (!unchecked.some(f => Array.isArray(f?.evidence) && f.evidence.includes(conflict.input)
        && f.evidence.includes(conflict.text)
        && (conflict.resolution !== 'unresolved' || f.kind === 'uncertainty'))) invalid('conflict');
  }
  const facts = data.facts.map((f): Fact => {
    keys(f, ['kind', 'at', 'status', 'text', 'evidence']);
    if (!member(FACT_KINDS, f.kind) || !member(STATUSES, f.status) || !nonempty(f.at, 200)
        || !nonempty(f.text, 4000) || !array(f.evidence, 1, 40)
        || f.evidence.some(id => !evidence.has(id))) invalid('fact');
    // Evidence scenes were checked to be node ids.
    const source = [...new Set(f.evidence.map(id => evidence.get(id)!.scene as string))];
    // A status becomes a prefix of the stored fact, so it is written in the story's language too; `actual` has none.
    return { kind: f.kind, at: f.at, text: (n.statusLabels[f.status as keyof Narration['statusLabels']] ?? '') + f.text, source };
  });
  // Quotes and extraction stages are kept for audit, not repeated in prompts.
  // `data` has exactly these three fields, each checked to be an array.
  return { facts, sgr: data as { evidence: unknown[]; conflicts: unknown[]; facts: unknown[] } };
}

export function summaryRequest(target: Target, nodes: Scene[], mode = 'plain'): ModelRequest {
  if (mode === 'plain') return plainRequest(target, nodes);
  if (mode === 'sgr') return sgrRequest(target, nodes);
  throw new ModelError('invalid_memory_mode');
}

export function supplementRequest(target: Target, nodes: Scene[], draft: ReturnType<typeof inspectMemory>) {
  const missing = new Set(draft.missingSceneIds);
  const preceding = new Set(nodes.flatMap((node, index) =>
    missing.has(node.id) && index > 0 && !missing.has(nodes[index - 1].id) ? [nodes[index - 1]] : []));
  return plainRequest(target, nodes.filter(node => missing.has(node.id)), {
    draftFacts: draft.delta.facts,
    precedingScenes: [...preceding].map(({ id, input, text }) => ({ id, input, text })),
  });
}
export function parseMemory(result: Output, nodes: Scene[], mode: string, lang: StoryLang): Delta {
  const { delta, missingSceneIds } = inspectMemory(result, nodes, mode, lang);
  if (missingSceneIds.length) invalid('coverage', { sceneCount: nodes.length, missingCount: missingSceneIds.length });
  return delta;
}

// Structurally valid drafts can still miss scenes. Only parseMemory's fully
// covered result may be committed; this inspection supports a bounded repair.
// `lang` is the language of the story: sgr writes a status into the fact, and a fact is read by the narrator.
export function inspectMemory(result: Output, nodes: Scene[], mode: string, lang: StoryLang) {
  const delta = mode === 'plain' ? parsePlain(result, nodes)
    : mode === 'sgr' ? parseSgr(result, nodes, narration(lang)) : null;
  if (!delta) throw new ModelError('invalid_memory_mode');
  const cited = new Set(delta.facts.flatMap(fact => fact.source));
  return { delta, missingSceneIds: nodes.filter(node => !cited.has(node.id)).map(node => node.id) };
}
