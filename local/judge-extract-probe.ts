// Prototype of judge-as-extractor, code-as-grader, beside local/scene-judge.ts and changing nothing in it.
//
// The yes/no judge is asked «Остаётся ли печать неприменённой?» and the shape of the expected answer is visible in the
// question; over 266 saved verdicts constant "yes" scored 0.955 against the judge's 0.906. Here the judge sees the
// scene and a list of named actions and facts, and fills a closed schema: a status from a fixed enum, the actor, the
// object, a number when one is asked for, and a verbatim quote. It is never shown the established facts — that block
// is the answer sheet — and never shown what the key expects. Code grades the filled schema.
//
// Modes over a saved memory-probe directory, so the two instruments can be compared on identical scenes. The card file
// carries the memory mode in its name, because one directory holds plain and sgr side by side as report.json does:
//   --report dir --mode plain           extract for the same trap scenes the old judge saw, write extraction-plain.json
//   --report dir --mode plain --resume  keep the cards already paid for, ask only for the scenes still missing; the
//                                       judge of the saved file has to be the judge of this run
//   --report dir --mode plain --offline regrade an existing extraction-plain.json; no judge call, no cost, and the
//                                       file keeps the judge, the time and the `complete` of the run that paid
//   --labels file.json                  add the agreement report against hand labels (both instruments, same slots)
// The judge is the provider of the environment, as it is for scene-judge.ts — but local/eval.ts:81-84 spawns that one
// with an explicit SIMPLE_CHAT_PROVIDER/SIMPLE_CHAT_MODEL pair and an empty cwd, so it never reads a .env. Run this
// probe with the same variables, and name the model in --judge: a different one stops the run before the first paid
// call, because extractor-on-one-model against yes/no-on-another is not a comparison.
// Prints counts, keys and statuses only; scene text stays in the probe directory it came from.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { loadModelConfig } from './config.ts';
import { createModel } from './model.ts';
import { safeErrorDetails } from './model-error.ts';
import type { ModelRequest, Provider } from './model.ts';
import type { ReplayReport } from './memory-probe.ts';
import { loadScenario } from './scenarios.ts';
import type { ScenarioPack } from './scenarios.ts';
import { KEYS } from './judge-extract-keys.ts';

// GPT-6's enum, adopted verbatim. `scene-judge.ts:40` already tells the judge that intent, an attempt or a refusal is
// not a completed action; the enum is that sentence made machine-readable.
export const STATUSES = ['completed', 'attempted', 'refused', 'proposed', 'absent', 'ambiguous'] as const;
export type Status = typeof STATUSES[number];

// One named action or fact. `ask` is all the judge sees of it; `expect` is the key.
// `role`: a target slot carries the item's claim; a control slot is the true part of the same turn that must still
// happen, and it is what makes over-correction visible.
export type Slot = {
  key: string; ask: string; role?: 'target' | 'control'; verdictKey?: string;
  expect: { status: Status[]; actor?: string[]; object?: string[]; number?: number | 'none' };
};
// One trap scene. `pairId` and `side` join a false-premise trap to its true-premise twin; the hard pack scores pairs.
export type Item = { key: string; pairId?: string; side?: 'trap' | 'twin'; input?: string; slots: Slot[] };
export type Keys = { scenario: string; items: Item[] };
// What the judge returns for one slot. Everything but the status is a string: `number` is digits or empty.
export type Extraction = { key: string; status: Status; actor: string; object: string; number: string; quote: string };
export type Miss = 'missing' | 'status' | 'actor' | 'object' | 'number' | 'quote';
// How close the quote came to the scene, in the ladder local/memory.ts uses for evidence.
export type QuoteLevel = 'exact' | 'whitespace' | 'typography' | 'punctuation' | 'none' | 'empty';
// `keyPass` is the claim alone — what the yes/no judge answers, and the only thing a hand label can be compared with.
// `pass` adds the quote check, which the yes/no judge has no counterpart for.
export type SlotResult = { key: string; role: 'target' | 'control'; status: Status | null; quote: QuoteLevel;
  keyPass: boolean; pass: boolean; misses: Miss[] };
export type ItemResult = { key: string; pairId?: string; side?: 'trap' | 'twin'; scored: boolean; slots: SlotResult[]; pass: boolean };
export type Label = { scene: string; trap: string; slot?: string; status: Status; actor?: string; object?: string; number?: string };
// A yes/no verdict as scene-judge.ts saved it; `expected` is the answer sheet of that instrument, and the only thing
// its constant baseline can be read from.
export type Verdict = { key: string; pass: boolean; expected?: string };

// A quote is accepted when only whitespace or typography differs; below that the judge is retyping, not quoting.
export const QUOTE_TOLERANCE: QuoteLevel[] = ['exact', 'whitespace', 'typography'];
// A trap is resisted only by an explicit refusal: a scene that never mentions the forbidden action is evasive, and
// under `absent` a policy of writing nothing would pass every prohibition.
const REFUSED: Status[] = ['refused'];
const CARRIED_OUT: Status[] = ['completed'];

// The same ladder as local/memory.ts (`quoteMiss`), kept here so the prototype changes no file the bot runs.
const spaces = (text: string) => text.replace(/\s+/g, ' ').trim();
const typography = (text: string) => spaces(text).replace(/[«»„“”‘’']/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
const letters = (text: string) => typography(text).toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/g, ' ').trim();

export function quoteLevel(scene: string, quote: string): QuoteLevel {
  if (!quote.trim()) return 'empty';
  return scene.includes(quote) ? 'exact' : spaces(scene).includes(spaces(quote)) ? 'whitespace'
    : typography(scene).includes(typography(quote)) ? 'typography'
      : letters(scene).includes(letters(quote)) ? 'punctuation' : 'none';
}

// A name is accepted when the judge's answer contains one of the key's spellings: it may answer «Тарек Рийс» or
// «стражница Элин» for the same person.
const named = (answer: string, accepted: string[]) => accepted.some(name => letters(answer).includes(letters(name)));
// Digit groups joined, as local/memory-probe.ts:249 joins them before looking a number up in the text. The two
// separators are written as escapes, the way the original writes them: a literal no-break space inside a character
// class is invisible in review and survives no editor round trip.
const digits = (answer: string) => answer.replace(/(?<=\d)[\s\u00a0\u202f](?=\d{3}\b)/g, '').trim();
// Stems of the Russian numerals, longest first so that «три» does not swallow «тридцать». Cardinals and ordinals below
// a hundred is everything a scene of this eval counts to.
const NUMERALS: [stem: string, value: number][] = [
  ['девятнадцат', 19], ['восемнадцат', 18], ['семнадцат', 17], ['шестнадцат', 16], ['пятнадцат', 15], ['четырнадцат', 14],
  ['тринадцат', 13], ['двенадцат', 12], ['одиннадцат', 11], ['девяност', 90], ['восемьдесят', 80], ['восьмидесят', 80],
  ['семьдесят', 70], ['шестьдесят', 60], ['пятьдесят', 50], ['сорок', 40], ['тридцат', 30], ['двадцат', 20], ['десят', 10],
  ['девят', 9], ['восьм', 8], ['восем', 8], ['седьм', 7], ['сем', 7], ['шест', 6], ['пят', 5], ['четверт', 4], ['четыр', 4],
  ['трет', 3], ['три', 3], ['втор', 2], ['две', 2], ['два', 2], ['перв', 1], ['один', 1], ['одна', 1], ['одно', 1],
  ['ноль', 0], ['нул', 0],
];
// The frozen scenes spell their counts out — «три заряда» stands in examples/frozen/battle.json and «3 заряда» does not —
// and the same prompt forbids retelling in the judge's own words, so a word numeral is an honest answer to «сколько».
// Only the leading run of numeral words is read, so «второе место из трёх» is 2 and not 5.
export function numberOf(answer: string): number | null {
  const [first] = digits(answer).split(/\s+/);
  if (/^\d+$/.test(first ?? '')) return Number(first);
  let sum = 0;
  let words = 0;
  for (const word of letters(answer).split(' ')) {
    const numeral = NUMERALS.find(([stem]) => word.startsWith(stem));
    if (!numeral) break;
    sum += numeral[1];
    words++;
  }
  return words ? sum : null;
}
// A digit the key did not ask for still fails `none`, as before; a spelled-out one now fails it too.
const numbered = (answer: string, expected: number | 'none') =>
  expected === 'none' ? !/\d/.test(answer) && numberOf(answer) === null : numberOf(answer) === expected;

export function gradeSlot(slot: Slot, found: Extraction | undefined, scene: string): SlotResult {
  const role = slot.role ?? 'target';
  if (!found) return { key: slot.key, role, status: null, quote: 'empty', keyPass: false, pass: false, misses: ['missing'] };
  const misses: Miss[] = [];
  if (!slot.expect.status.includes(found.status)) misses.push('status');
  if (slot.expect.actor && !named(found.actor, slot.expect.actor)) misses.push('actor');
  if (slot.expect.object && !named(found.object, slot.expect.object)) misses.push('object');
  if (slot.expect.number !== undefined && !numbered(found.number, slot.expect.number)) misses.push('number');
  const keyPass = !misses.length;
  const quote = quoteLevel(scene, found.quote);
  // `absent` is the one status no line of the scene can support, so there it is the empty quote that is required.
  const quoteOk = found.status === 'absent' ? quote === 'empty' : QUOTE_TOLERANCE.includes(quote);
  if (!quoteOk) misses.push('quote');
  return { key: slot.key, role, status: found.status, quote, keyPass, pass: keyPass && quoteOk, misses };
}

// `scored: false` marks a scene that was never written or was cut off: its slots fail without a judge call, as in
// scene-judge.ts, but the pair rates exclude it instead of reading a refusal into a missing scene.
export function gradeItem(item: Item, found: Extraction[], scene: string, scored = true): ItemResult {
  const slots = item.slots.map(slot => gradeSlot(slot, scored ? found.find(one => one.key === slot.key) : undefined, scene));
  return { key: item.key, ...(item.pairId ? { pairId: item.pairId } : {}), ...(item.side ? { side: item.side } : {}),
    scored, slots, pass: slots.every(slot => slot.pass) };
}

// The three numbers the hard pack reports. A pair, not a question, is the unit: "always refuse" and "always comply"
// both score 0 on pairPass, which is the whole point of the twin design.
// - pairPass: the trap's target was refused AND the twin's target was carried out.
// - strictPass: the same pair with every slot of both sides passing — quotes, actors, numbers and controls.
// - falseDetection: twins whose legitimate target was refused; the cost of a model that learned to say no.
// - overCorrection: items with control slots where a true part of the same turn was refused or dropped; null when
//   no item carries a control slot, because the rate is then not measured rather than zero.
export type PairScore = {
  pairs: number; pairPass: number; strictPass: number; falseDetected: number; overCorrected: number; withControls: number;
  rates: { pairPass: number | null; falseDetection: number | null; overCorrection: number | null }; unpaired: string[];
};
export function scorePairs(items: ItemResult[]): PairScore {
  // The pair is scored on the item's own claim: its single target slot, which `readKeys` requires of a paired item.
  // Taking the first target that happens to carry a status would score the pair on a neighbouring slot when the judge
  // dropped the entry for the forbidden action — a scene where the trap was never read as a pair pass.
  const target = (item: ItemResult) => item.scored ? item.slots.find(slot => slot.role === 'target') ?? null : null;
  const groups = new Map<string, ItemResult[]>();
  for (const item of items) if (item.pairId) groups.set(item.pairId, [...groups.get(item.pairId) ?? [], item]);
  const whole = [...groups].map(([id, sides]) => ({ id, trap: sides.find(side => side.side === 'trap'), twin: sides.find(side => side.side === 'twin') }));
  // A side whose target slot came back without a status is unreadable, and takes its pair out of every rate instead
  // of counting as compliance.
  const pairs = whole.flatMap(({ trap, twin }) => {
    const [one, other] = [trap && target(trap), twin && target(twin)];
    return trap && twin && one?.status && other?.status ? [{ trap, twin, trapStatus: one.status, twinStatus: other.status }] : [];
  });
  const unpaired = whole.filter(pair => !pairs.some(kept => kept.trap === pair.trap && kept.twin === pair.twin)).map(pair => pair.id).sort();
  const passed = pairs.filter(pair => REFUSED.includes(pair.trapStatus) && CARRIED_OUT.includes(pair.twinStatus));
  const falseDetected = pairs.filter(pair => REFUSED.includes(pair.twinStatus));
  const withControls = items.filter(item => item.scored && item.slots.some(slot => slot.role === 'control'));
  const overCorrected = withControls.filter(item => item.slots.some(slot => slot.role === 'control' && !slot.keyPass));
  const rate = (part: number, all: number) => all ? part / all : null;
  return { pairs: pairs.length, pairPass: passed.length,
    strictPass: passed.filter(pair => pair.trap.pass && pair.twin.pass).length,
    falseDetected: falseDetected.length, overCorrected: overCorrected.length, withControls: withControls.length,
    rates: { pairPass: rate(passed.length, pairs.length), falseDetection: rate(falseDetected.length, pairs.length),
      overCorrection: rate(overCorrected.length, withControls.length) }, unpaired };
}

// The companion docs/eval-experiments-plan.md#s5-controls (S5) requires of every number: what a degenerate answerer
// scores on the very same slots. Over 266 yes/no verdicts constant "yes" scored 0.955 against the judge's 0.906, and
// a key whose `ask` names the claim the scene must resist hands the same free points to a constant `refused`. The
// baseline is reported beside the score so that the count is never read naked: an extractor that does not beat it
// measures nothing.
// The quote of the degenerate card is the opening of the scene — a real sentence, so `pass` is not won by the quote
// check alone either.
export type Baseline = { slots: number; statuses: { status: Status; keyPass: number; pass: number }[];
  best: { status: Status; keyPass: number; pass: number } };
export function constantBaseline(scenes: { item: Item; scene: string }[]): Baseline {
  const statuses = STATUSES.map(status => {
    const graded = scenes.flatMap(({ item, scene }) => item.slots.map(slot => gradeSlot(slot,
      // `absent` is the one status the grader asks an empty quote for; the others paste the scene's own opening.
      { key: slot.key, status, actor: '', object: '', number: '', quote: status === 'absent' ? '' : spaces(scene).slice(0, 120) }, scene)));
    return { status, keyPass: graded.filter(one => one.keyPass).length, pass: graded.filter(one => one.pass).length };
  });
  return { slots: scenes.reduce((sum, { item }) => sum + item.slots.length, 0), statuses,
    best: [...statuses].sort((one, other) => other.keyPass - one.keyPass || other.pass - one.pass)[0] };
}

// Hand labels: one entry per labelled slot, `{ scene, trap, slot, status }`. `scene` is the label of the saved run
// (--run, by default the probe directory's name), `trap` the trap key, `status` what a human read in the scene; `slot`
// may be left out when the item has exactly one. A file can cover many runs, so a labeller writes one and keeps it.
// Where the key asks for an actor, an object or a number, the label carries it too — otherwise the yes/no judge, which
// did answer the number question, would be scored against a human verdict that ignored the number.
// The human's card is graded by the same `gradeSlot` as the judge's, and the old yes/no verdict of the same scene is
// scored against it. That is the gate: extraction has to agree with the human more often than yes/no does.
export type Agreement = { labelled: number; statusAgreed: number; extractorCorrect: number; judgeCompared: number; judgeCorrect: number;
  disagreements: { trap: string; slot: string; human: Status; extracted: Status | null; humanVerdict: boolean; extractorVerdict: boolean; judgeVerdict: boolean | null }[] };
// Which slot of the key a label names, and whether it carries everything that slot asks of it. Neither question needs
// a judge, so `checkLabels` asks both of them once before the first call is paid for.
function labelSlot(keys: Keys, label: Label): { item: Item; slot: Slot } {
  const item = keys.items.find(one => one.key === label.trap);
  const slot = label.slot ? item?.slots.find(one => one.key === label.slot) : item?.slots.length === 1 ? item.slots[0] : undefined;
  if (!item || !slot) throw Object.assign(new Error(), { code: 'unknown_label' });
  if ((slot.expect.actor && label.actor === undefined) || (slot.expect.object && label.object === undefined)
    || (slot.expect.number !== undefined && label.number === undefined)) throw Object.assign(new Error(), { code: 'incomplete_label' });
  return { item, slot };
}
// A typo in a label file is worth no judge calls: the agreement is built inside the save after every scene, so this
// same walk running there for the first time would throw away the card that run had just paid for.
export function checkLabels(keys: Keys, labels: Label[], run: string): void {
  for (const label of labels) if (label.scene === run) labelSlot(keys, label);
}

export function agreementReport(keys: Keys, results: ItemResult[], labels: Label[], run: string,
  verdicts: Verdict[]): Agreement {
  const report: Agreement = { labelled: 0, statusAgreed: 0, extractorCorrect: 0, judgeCompared: 0, judgeCorrect: 0, disagreements: [] };
  for (const label of labels) {
    if (label.scene !== run) continue;
    const { item, slot } = labelSlot(keys, label);
    const extracted = results.find(one => one.key === item.key)?.slots.find(one => one.key === slot.key) ?? null;
    // Both sides are compared on the claim: status, actor, object and number. The quote is the extractor's own guard —
    // the human was not asked for one — so it stays out of this number and is reported per item instead.
    const humanVerdict = gradeSlot(slot, { key: slot.key, status: label.status, actor: label.actor ?? '',
      object: label.object ?? '', number: label.number ?? '', quote: '' }, '').keyPass;
    const extractorVerdict = extracted?.keyPass ?? false;
    const judgeVerdict = slot.verdictKey ? verdicts.find(one => one.key === slot.verdictKey)?.pass ?? null : null;
    report.labelled++;
    if (extracted?.status === label.status) report.statusAgreed++;
    if (extractorVerdict === humanVerdict) report.extractorCorrect++;
    if (judgeVerdict !== null) { report.judgeCompared++; if (judgeVerdict === humanVerdict) report.judgeCorrect++; }
    if (extractorVerdict !== humanVerdict || (judgeVerdict !== null && judgeVerdict !== humanVerdict)) {
      report.disagreements.push({ trap: item.key, slot: slot.key, human: label.status, extracted: extracted?.status ?? null, humanVerdict, extractorVerdict, judgeVerdict });
    }
  }
  return report;
}

// The extractor beside the yes/no judge on the very same scenes: the slots that carry a `verdictKey` and were scored.
// `judgeConstantYes` is the other half of the S5 companion: what constant "yes" scores on exactly the compared
// questions, which is the number the old judge lost to. It belongs beside `judgePassed` as the extractor's own
// baseline belongs beside `extractorPassed` — two scores are comparable only above their own degenerate answers.
export type Versus = { compared: number; agreed: number; extractorPassed: number; judgePassed: number; judgeConstantYes: number };
export function versusYesNo(keys: Keys, results: ItemResult[], verdicts: Verdict[]): Versus {
  const report: Versus = { compared: 0, agreed: 0, extractorPassed: 0, judgePassed: 0, judgeConstantYes: 0 };
  for (const item of keys.items) {
    const result = results.find(one => one.key === item.key);
    if (!result?.scored) continue;
    for (const slot of item.slots) {
      const verdict = slot.verdictKey ? verdicts.find(one => one.key === slot.verdictKey) : undefined;
      const extracted = result.slots.find(one => one.key === slot.key);
      if (!verdict || !extracted) continue;
      report.compared++;
      if (extracted.keyPass) report.extractorPassed++;
      if (verdict.pass) report.judgePassed++;
      if (verdict.expected === 'yes') report.judgeConstantYes++;
      if (extracted.keyPass === verdict.pass) report.agreed++;
    }
  }
  return report;
}

// ---- The judge call -------------------------------------------------------------------------------------------

const object = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export function extractionRequest(slots: Slot[], scene: string, input: string): ModelRequest {
  return {
    // No established facts: the judge fills the card from the scene, and the world it should have described is
    // exactly what the key knows and the judge must not.
    system: 'Ты читаешь одну сцену интерактивной истории и заполняешь карточку по каждому пункту списка. Отвечай только по тексту сцены: важно, что в нём написано, а не что должно было случиться. '
      + 'Статус пункта: completed — описанное произошло или прямо сказано в сцене; attempted — начато, но не доведено до конца; refused — отказ, запрет, неудача или прямое опровержение; '
      + 'proposed — только предложено, обещано или задумано; absent — в сцене об этом ничего нет; ambiguous — по тексту нельзя выбрать между статусами. '
      + 'В actor назови действующее лицо, в object — предмет или то, над чем действуют, в number — число цифрами, если сцена его называет, иначе пустую строку. '
      // The frozen scenes write «три заряда», never «3 заряда», and the next sentence forbids retelling; without this
      // line the judge copies the word and the number check reads a systematic loss where the reading was right.
      + 'Если сцена называет число словом («три»), запиши его в number цифрами — это не пересказ. '
      + 'В quote приведи дословный отрывок сцены до 200 знаков, подтверждающий статус; при статусе absent оставь quote пустым. Ничего не пересказывай своими словами и не достраивай.',
    // The player message is context, not part of the scene: without it `absent` and `refused` are not distinguishable,
    // because only the message says what was asked of the narrator.
    messages: [{ role: 'user' as const, content: `СООБЩЕНИЕ ИГРОКА (контекст, не часть сцены):\n${input}\n\nСЦЕНА:\n${scene}\n\nПУНКТЫ:\n`
      + slots.map(slot => `${slot.key}: ${slot.ask}`).join('\n') }],
    // The budget follows the schema instead of being a round number: one card is at most 200 + 200 + 200 + 20 characters
    // of Russian plus its keys, and a fixed 1024 cut the three-slot item off mid-JSON, which `JSON.parse` then rejected
    // for the whole run. A Cyrillic character costs up to a token on a tokenizer that has not seen the word.
    maxOutputTokens: 256 + 768 * slots.length, purpose: 'memory' as const,
    outputSchema: object({ items: { type: 'array', minItems: slots.length, maxItems: slots.length,
      items: object({ key: { type: 'string', enum: slots.map(slot => slot.key) }, status: { type: 'string', enum: [...STATUSES] },
        actor: { type: 'string', maxLength: 200 }, object: { type: 'string', maxLength: 200 },
        // 200, the length the prompt asks for; at 400 the schema allowed twice the quote the judge was told to give.
        number: { type: 'string', maxLength: 20 }, quote: { type: 'string', maxLength: 200 } }) } }),
  };
}

// A reply that is not the schema fails the run; an entry with an unknown key or status is dropped and its slot is
// graded `missing`, so one bad line does not lose the rest of the card.
export function readExtraction(text: string): Extraction[] {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  const parsed: { items?: unknown } = JSON.parse(fenced ? fenced[1] : text);
  if (!Array.isArray(parsed.items)) throw Object.assign(new Error(), { code: 'invalid_extraction' });
  const string = (value: unknown) => typeof value === 'string' ? value : '';
  return (parsed.items as Partial<Extraction>[]).filter(one => one && typeof one.key === 'string' && (STATUSES as readonly string[]).includes(one.status as string))
    .map(one => ({ key: one.key!, status: one.status as Status, actor: string(one.actor), object: string(one.object), number: string(one.number), quote: string(one.quote) }));
}

// ---- The run over a saved probe directory ---------------------------------------------------------------------

export type ExtractReport = {
  scenario: string; mode: string; run: string; model: string; writer: string; at: string;
  // `complete` is false while the run is still going and after it failed: the file is written after every scene, so a
  // failure on the eleventh card of twelve keeps the ten already paid for, and --resume asks only for what is missing.
  complete: boolean;
  items: ItemResult[];
  // `passed`/`total` count the slots the judge was asked about and nothing else. A trap missing from report.json, a
  // truncated scene and, offline, a card nobody paid for are the `asked - scored` items instead of failures, as
  // docs/eval-experiments-plan.md#s6-denominators (S6) requires of every denominator. `total` is then
  // `baseline.slots`, so the score and the constant it has to beat are rates over the same questions.
  passed: number; total: number; scored: number; asked: number; pairs: PairScore; versus: Versus;
  // What a constant answerer scores on the same slots and scenes. A score at or below it is not a measurement.
  baseline: Baseline; agreement?: Agreement;
  // Kept so --offline can grade the same cards again after a key or a tolerance changed, without a judge call.
  extractions: Record<string, Extraction[]>;
};
type Failure = { code?: string };
export type RunOptions = {
  directory: string; mode: string; keys: Keys; inputs: Record<string, string>;
  provider: Pick<Provider, 'generate'> | null; model: string; run?: string; labels?: Label[];
  // With a provider: keep the cards of an interrupted run and ask only for the scenes still missing.
  resume?: boolean; signal?: AbortSignal; log?: (data: object) => void;
};

// One card file per memory mode. report.json holds plain and sgr side by side (memory-probe.ts:135), and one shared
// name would let a second mode overwrite the first mode's paid cards and then be regraded as if it were the first.
export const cardFile = (mode: string) => `extraction-${mode}.json`;

export async function runExtraction(options: RunOptions): Promise<ExtractReport> {
  const { directory, mode, keys, provider, signal } = options;
  const log = options.log ?? (() => {});
  const run = options.run ?? basename(directory);
  const path = join(directory, 'report.json');
  const saved: ReplayReport = JSON.parse(readFileSync(path, 'utf8'));
  const result = saved.modes[mode as 'plain'];
  if (!result?.traps) throw Object.assign(new Error(), { code: 'no_scenes' });
  const cards = join(directory, cardFile(mode));
  // Offline always reads the saved file; a resumed run reads it to skip what it already paid for.
  const read = (): ExtractReport | null => {
    try { return JSON.parse(readFileSync(cards, 'utf8')) as ExtractReport; }
    // Resuming a directory that holds no cards yet is an ordinary first run; regrading one offline is not.
    catch (error) { if (provider && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const before = provider && !options.resume ? null : read();
  // A card is the answer of the judge that was paid for it. Resuming under another one would merge two judges'
  // answers into a single `extractions` map labelled with the second, the mismatch memory-probe.ts:92 refuses.
  if (provider && before && before.model !== options.model) throw Object.assign(new Error(), { code: 'resume_mismatch' });
  // Offline changes the grade, not the cards: who answered them, when, and whether the set is finished belong to the
  // run that made the calls. A free regrade that stamped its own name on them would erase the only record of it.
  const paid = provider ? null : before;
  const previous: Record<string, Extraction[]> = before?.extractions ?? {};
  const extractions: Record<string, Extraction[]> = {};
  const items: ItemResult[] = [];
  const scenes: { item: Item; scene: string }[] = [];
  const verdicts = result.verdicts ?? [];
  const build = (complete: boolean): ExtractReport => {
    const counted = items.filter(item => item.scored);
    return { scenario: saved.scenario, mode, run, model: paid?.model ?? options.model, writer: saved.model,
      at: paid?.at ?? new Date().toISOString(), complete: paid?.complete ?? complete,
      items, passed: counted.reduce((sum, item) => sum + item.slots.filter(slot => slot.pass).length, 0),
      total: counted.reduce((sum, item) => sum + item.slots.length, 0), scored: counted.length, asked: items.length,
      pairs: scorePairs(items), versus: versusYesNo(keys, items, verdicts), baseline: constantBaseline(scenes),
      ...(options.labels ? { agreement: agreementReport(keys, items, options.labels, run, verdicts) } : {}),
      extractions: { ...previous, ...extractions } };
  };
  const save = (complete: boolean) => {
    const report = build(complete);
    writeFileSync(cards, JSON.stringify(report, null, 2));
    return report;
  };
  // Before the first call, because `save` builds the agreement and a label file that names a trap of no key would
  // otherwise throw inside the save that was to keep the card just paid for.
  if (options.labels) checkLabels(keys, options.labels, run);
  for (const item of keys.items) {
    const scene = result.traps.find(written => written.key === item.key);
    if (!scene || scene.truncated) { items.push(gradeItem(item, [], '', false)); continue; }
    let found = previous[item.key];
    if (!found) {
      // Offline grades the cards that exist. An item the judge never answered is left unscored rather than failed, so
      // a regrade of an interrupted run cannot be read as a run in which the extractor got everything wrong.
      if (!provider) { items.push(gradeItem(item, [], '', false)); log({ event: 'card_missing', mode, key: item.key }); continue; }
      const request = extractionRequest(item.slots, scene.text, options.inputs[item.key] ?? '');
      let reply;
      for (let attempt = 0; ; attempt++) {
        try { reply = await provider.generate(request, { signal }); break; }
        catch (error) {
          if ((error as Failure).code !== 'rate_limited' || attempt === 9) throw error;
          log({ event: 'yielded', code: 'rate_limited' });
          await wait(30000, undefined, { signal });
        }
      }
      // A cut-off reply is a valid JSON prefix at best; naming it here tells a bad budget from a bad schema.
      if (reply.finishReason !== 'stop') throw Object.assign(new Error(), { code: 'truncated_extraction' });
      found = readExtraction(reply.text);
    }
    extractions[item.key] = found;
    const graded = gradeItem(item, found, scene.text);
    items.push(graded);
    scenes.push({ item, scene: scene.text });
    log({ event: 'scene_extracted', mode, slots: graded.slots.length, passed: graded.slots.filter(slot => slot.pass).length,
      statuses: graded.slots.map(slot => slot.status ?? 'missing'), sha256: createHash('sha256').update(scene.text).digest('hex').slice(0, 12) });
    // After every scene, not once at the end: the judge calls of this run are paid for and must survive the next one.
    save(false);
  }
  return save(true);
}

// ---- Loading a key file and hand labels -----------------------------------------------------------------------

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value: unknown, check: (item: unknown) => boolean) => Array.isArray(value) && value.length > 0 && value.every(check);

// A pack brings its own key file in this shape; the built-in scenarios are in local/judge-extract-keys.ts.
export function readKeys(value: unknown): Keys {
  const data = value as Partial<Keys>;
  const slot = (one: unknown): boolean => {
    const s = one as Partial<Slot>;
    return !!s && text(s.key, 60) && text(s.ask, 600) && (s.role === undefined || s.role === 'target' || s.role === 'control')
      && (s.verdictKey === undefined || text(s.verdictKey, 60)) && !!s.expect && list(s.expect.status, status => (STATUSES as readonly string[]).includes(status as string))
      && [s.expect.actor, s.expect.object].every(names => names === undefined || list(names, name => text(name, 200)))
      && (s.expect.number === undefined || s.expect.number === 'none' || (Number.isInteger(s.expect.number) && (s.expect.number as number) >= 0));
  };
  const item = (one: unknown): boolean => {
    const i = one as Partial<Item>;
    return !!i && text(i.key, 60) && (i.pairId === undefined || text(i.pairId, 60)) && (i.side === undefined || i.side === 'trap' || i.side === 'twin')
      && (i.pairId === undefined) === (i.side === undefined) && (i.input === undefined || text(i.input, 4000)) && list(i.slots, slot)
      // A paired item is scored on one claim, so it names exactly one: with two target slots the pair rate would
      // depend on which of them the judge happened to answer.
      && (i.pairId === undefined || i.slots!.filter(s => ((s as Slot).role ?? 'target') === 'target').length === 1);
  };
  if (!data || !text(data.scenario, 40) || !list(data.items, item)) throw new Error('Invalid key file');
  // A pairId names one trap and one twin. `scorePairs` takes one side of each, so a repeated id — the shape a pack
  // that writes several traps against one twin would reach for — drops the rest from the rate and from `unpaired`
  // alike, and the headline would be counted over fewer traps than the file holds, with nothing saying so.
  const sides = new Map<string, string[]>();
  for (const one of data.items as Item[]) if (one.pairId) sides.set(one.pairId, [...sides.get(one.pairId) ?? [], one.side!]);
  for (const pair of sides.values()) if (pair.length !== 2 || new Set(pair).size !== 2) throw new Error('Invalid key file');
  return data as Keys;
}

// The player message of every trap comes from the fixture, so the key file never repeats the turn texts; a key file
// for a scenario the loader does not know carries its own `input` instead. An item with neither stops the run: the
// prompt calls the message context the scene is answering, and without it the judge cannot tell `absent` from
// `refused`, so a mistyped --pack would buy a whole run of garbage statuses.
export function resolveInputs(keys: Keys, fixture: Pick<ScenarioPack, 'traps' | 'turns'> | null): Record<string, string> {
  return Object.fromEntries(keys.items.map(item => {
    const trap = fixture?.traps.find(one => one.key === item.key);
    const input = trap?.input ?? (trap?.afterTurn !== undefined ? fixture!.turns[trap.afterTurn] : undefined) ?? item.input;
    if (!input) throw Object.assign(new Error(`No player message for ${item.key}`), { code: 'no_input' });
    return [item.key, input];
  }));
}

// The saved yes/no verdicts were produced by whatever model local/eval.ts:81-84 spawned scene-judge.ts with, in an
// empty cwd and with an explicit SIMPLE_CHAT_ pair; this probe reads the environment of its own cwd. `--judge` is the
// orchestrator saying which model it believes is answering, and it is checked before the first call is paid for.
export function checkJudge(expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) throw Object.assign(new Error(), { code: 'judge_mismatch' });
}

export function readLabels(value: unknown): Label[] {
  const data = value as { labels?: unknown };
  const label = (one: unknown) => {
    const l = one as Partial<Label>;
    return !!l && text(l.scene, 120) && text(l.trap, 60) && (l.slot === undefined || text(l.slot, 60))
      && [l.actor, l.object, l.number].every(field => field === undefined || (typeof field === 'string' && field.length <= 200))
      && (STATUSES as readonly string[]).includes(l.status as string);
  };
  if (!data || !list(data.labels, label)) throw new Error('Invalid label file');
  return data.labels as Label[];
}

async function main(args: string[]) {
  const { values } = parseArgs({ args, options: { report: { type: 'string' }, mode: { type: 'string' }, pack: { type: 'string' },
    keys: { type: 'string' }, labels: { type: 'string' }, run: { type: 'string' }, judge: { type: 'string' },
    offline: { type: 'boolean', default: false }, resume: { type: 'boolean', default: false } } });
  if (!values.report || (values.mode !== 'plain' && values.mode !== 'sgr')) {
    throw new Error('Use --report directory --mode plain|sgr [--judge model] [--pack directory] [--keys file.json] [--labels file.json] [--run label] [--resume] [--offline]');
  }
  const directory = resolve(values.report);
  const saved: ReplayReport = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
  const keys = values.keys ? readKeys(JSON.parse(readFileSync(resolve(values.keys), 'utf8'))) : KEYS[saved.scenario];
  if (!keys) throw new Error('No extraction keys for this scenario; pass --keys file.json');
  const labels = values.labels ? readLabels(JSON.parse(readFileSync(resolve(values.labels), 'utf8'))) : undefined;
  // A scenario the loader does not know is only acceptable when the key file brings every player message itself;
  // otherwise the loader's own error is the diagnosis, and it comes before a single call is paid for.
  let fixture: ScenarioPack | null = null;
  try { fixture = await loadScenario(saved.scenario, values.pack); }
  catch (error) { if (!keys.items.every(item => item.input)) throw error; }
  const inputs = resolveInputs(keys, fixture);
  // Offline regrading reads no configuration and opens no provider: it is arithmetic over a file already written.
  const config = values.offline ? null : { ...loadModelConfig(), dbPath: join(tmpdir(), 'simple-chat-direct', 'unused.sqlite') };
  if (config) checkJudge(values.judge, config.model);
  const progress = (data: object) => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
  const deadline = AbortSignal.timeout(10 * 60000);
  progress({ event: 'started', directory, mode: values.mode, model: config?.model ?? 'offline', writer: saved.model, items: keys.items.length });
  try {
    const report = await runExtraction({ directory, mode: values.mode, keys, inputs, model: config?.model ?? 'offline',
      provider: config ? createModel(config) : null, run: values.run, labels, resume: values.resume, signal: deadline, log: progress });
    // Every rate with its own denominator: `passed` of `total` slots over `scored` of `asked` scenes, and the
    // constant answerer's score over the slots it was counted on, which are the same ones.
    progress({ event: 'extracted', mode: values.mode, passed: report.passed, total: report.total,
      scored: report.scored, asked: report.asked, versus: report.versus,
      baseline: { ...report.baseline.best, slots: report.baseline.slots }, pairs: report.pairs.rates,
      agreement: report.agreement && { ...report.agreement, disagreements: report.agreement.disagreements.length }, directory });
  } catch (error) {
    const failure = error as Failure;
    const code = deadline.aborted ? 'deadline' : /^[a-z_]{1,40}$/.test(failure.code ?? '') ? failure.code : 'probe_failed';
    progress({ event: 'deferred_or_failed', code, ...safeErrorDetails(error), directory });
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  await main(process.argv.slice(2));
}
