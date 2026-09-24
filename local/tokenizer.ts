// Exact token counts for the two models the bot sends text to, computed here instead of asked of their servers.
// Gemma 4 is tokenized the way the pinned llama-server does it (gpu/manifest.env): special tokens first, spaces as
// U+2581, BPE over whole lines by merge rank, bytes for what the vocabulary lacks. The picture lane's text encoders
// (gpu/image-manifest.env) both read ComfyUI's qwen25_tokenizer through transformers' Qwen2Tokenizer: added tokens
// first, NFC, the Qwen2 split, GPT-2 bytes, BPE. The vocabularies are too big for the repository: `npm run tokenizers`
// writes them to tokenizers/ (docs/tokenizers.md), and without those files loadTokenizers answers undefined and the
// bot keeps its estimate.
import { readFileSync } from 'node:fs';
import { endianness } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const TOKENIZER_FORMAT = 'simple-chat-tokenizer/1';
export const GEMMA_FILE = 'gemma-4.json.gz';
export const QWEN_FILE = 'qwen-2.5.json.gz';
// SHA-256 of the chat template in the pinned GGUF, the one gemmaChatPrompt reproduces. Another template is another
// prompt, so the extractor refuses a model that carries a different one and gemmaChatTokens refuses such a file.
export const GEMMA_TEMPLATE_SHA256 = '0a52be69cda5ab8aeb627d6ff51a7b34c7d06afabb6b0f00cf8ee63df16a6315';

// What `npm run tokenizers` writes (local/tokenizer-extract.ts). A list of numbers is little-endian Int32 in base64.
// `merges` is one [left, right, result] triple of token ids per merge, in rank order: both tokenizers merge ids
// rather than strings, which is the same thing because every part and every result of every merge is itself a token
// (the extractor refuses a vocabulary where that does not hold).
type Common = { format: typeof TOKENIZER_FORMAT; source: Record<string, string>; vocabSize: number; merges: string };
export type SpecialToken = { text: string; id: number; plain: boolean };
export type GemmaData = Common & {
  kind: 'gemma4'; bos: number; eos: number; addBos: boolean; addEos: boolean; templateSha256: string;
  // [code point, id] of every token that is one code point; the ids of <0x00>..<0xFF>; [length, id] of every token
  // that is only newlines; the tokens llama.cpp cuts out of the text before BPE, `plain` when it does so even without
  // parse_special (user-defined tokens that are not also control tokens).
  chars: string; bytes: number[]; newlines: [number, number][]; special: SpecialToken[];
};
export type QwenData = Common & {
  // The ids of the 256 byte-level characters, byte 0 first, and the added tokens, which are matched before anything.
  kind: 'qwen2'; bytes: number[]; added: { text: string; id: number }[];
};

export type GemmaTokenizer = {
  kind: 'gemma4'; source: Record<string, string>; bos: number; eos: number; addBos: boolean; addEos: boolean;
  templateSha256: string;
  // `special` is llama.cpp's parse_special: control tokens written in the text become those tokens. Without it only
  // user-defined ones do, as with /tokenize and parse_special false. Neither adds the BOS; gemmaChatTokens does.
  encode(text: string, options?: { special?: boolean }): number[];
  count(text: string, options?: { special?: boolean }): number;
};
export type QwenTokenizer = {
  kind: 'qwen2'; source: Record<string, string>;
  encode(text: string): number[];
  count(text: string): number;
};
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type PictureEncoder = 'qwen_image' | 'krea2';
type Options = { cacheChars?: number };

const LITTLE_ENDIAN = endianness() === 'LE';
function swap(bytes: Uint8Array) {
  for (let i = 0; i < bytes.length; i += 4) {
    [bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]] = [bytes[i + 3], bytes[i + 2], bytes[i + 1], bytes[i]];
  }
}
export function int32Base64(values: ArrayLike<number>) {
  const bytes = new Uint8Array(Int32Array.from(values).buffer);
  if (!LITTLE_ENDIAN) swap(bytes);
  return Buffer.from(bytes).toString('base64');
}
function int32s(base64: unknown, name: string) {
  if (typeof base64 !== 'string') throw new Error(`Tokenizer data: ${name} is not base64`);
  // A copy, because Buffer.from may hand back a slice of its pool that is not aligned for an Int32Array.
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.length % 4) throw new Error(`Tokenizer data: ${name} is not a list of int32`);
  if (!LITTLE_ENDIAN) swap(bytes);
  return new Int32Array(bytes.buffer);
}
function idList(values: unknown, vocabSize: number, name: string, length?: number) {
  if (!Array.isArray(values) || (length !== undefined && values.length !== length)
    || !values.every(id => Number.isInteger(id) && id >= 0 && id < vocabSize)) throw new Error(`Tokenizer data: bad ${name}`);
  return Int32Array.from(values as number[]);
}
function checkHeader(data: { format?: unknown; kind?: unknown; vocabSize?: unknown }, kind: string) {
  if (data?.format !== TOKENIZER_FORMAT || data.kind !== kind || !Number.isInteger(data.vocabSize) || (data.vocabSize as number) <= 0) {
    throw new Error(`Tokenizer data: not a ${kind} file of ${TOKENIZER_FORMAT}`);
  }
}

// Pair of ids -> rank, the merge's index in the list, by open addressing over typed arrays: half a million pairs in
// about 10 MB, where a Map of them would take several times that.
type Merges = { rank(left: number, right: number): number; result: Int32Array };
function mergeTable(triples: Int32Array, vocabSize: number): Merges {
  const count = triples.length / 3;
  if (!Number.isInteger(count)) throw new Error('Tokenizer data: merges are not triples');
  const left = new Int32Array(count), right = new Int32Array(count), result = new Int32Array(count);
  let size = 16;
  while (size < count * 2) size *= 2;
  const slots = new Int32Array(size), mask = size - 1;
  const hash = (a: number, b: number) => {
    let h = Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x632be5ab, 0x85ebca77);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    return (h ^ (h >>> 12)) & mask;
  };
  for (let rank = 0; rank < count; rank++) {
    const a = triples[rank * 3], b = triples[rank * 3 + 1], c = triples[rank * 3 + 2];
    if (!(a >= 0 && a < vocabSize && b >= 0 && b < vocabSize && c >= 0 && c < vocabSize)) throw new Error('Tokenizer data: merge id out of range');
    left[rank] = a; right[rank] = b; result[rank] = c;
    let slot = hash(a, b);
    while (slots[slot] && !(left[slots[slot] - 1] === a && right[slots[slot] - 1] === b)) slot = (slot + 1) & mask;
    // A pair listed twice keeps its first rank, as llama.cpp's emplace does. The extractor writes no such list.
    if (!slots[slot]) slots[slot] = rank + 1;
  }
  return {
    result,
    rank(a, b) {
      if (a < 0 || b < 0) return -1;
      for (let slot = hash(a, b); ; slot = (slot + 1) & mask) {
        const found = slots[slot];
        if (!found) return -1;
        if (left[found - 1] === a && right[found - 1] === b) return found - 1;
      }
    },
  };
}

// One BPE engine for both models, over scratch arrays that grow to the longest word seen. The symbols of a word are a
// linked list; candidate merges wait in a binary heap keyed rank * 2^32 + position, so the lowest rank goes first and
// of equal ranks the leftmost: the order of llama.cpp's llm_tokenizer_bpe_session and of Hugging Face's
// Word::merge_all. An entry whose pair has changed since it was pushed no longer has its rank and is skipped.
const POSITION = 2 ** 32;
let symbols = new Int32Array(256), before = new Int32Array(256), after = new Int32Array(256), points = new Int32Array(256);
let heap = new Float64Array(512);
let heapSize = 0;
function reserve(length: number) {
  if (length <= symbols.length) return;
  let size = symbols.length;
  while (size < length) size *= 2;
  symbols = new Int32Array(size); before = new Int32Array(size); after = new Int32Array(size); points = new Int32Array(size);
}
function push(key: number) {
  if (heapSize === heap.length) { const grown = new Float64Array(heap.length * 2); grown.set(heap); heap = grown; }
  let i = heapSize++;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent] <= key) break;
    heap[i] = heap[parent];
    i = parent;
  }
  heap[i] = key;
}
function pop() {
  const top = heap[0], last = heap[--heapSize];
  let i = 0;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= heapSize) break;
    if (child + 1 < heapSize && heap[child + 1] < heap[child]) child++;
    if (heap[child] >= last) break;
    heap[i] = heap[child];
    i = child;
  }
  heap[i] = last;
  return top;
}
// Merges symbols[0..length); the survivors are read by walking `after` from 0, which is never merged away.
function bpe(merges: Merges, length: number) {
  heapSize = 0;
  for (let i = 0; i < length; i++) {
    before[i] = i - 1;
    after[i] = i + 1 < length ? i + 1 : -1;
    if (i + 1 < length) {
      const rank = merges.rank(symbols[i], symbols[i + 1]);
      if (rank >= 0) push(rank * POSITION + i);
    }
  }
  while (heapSize) {
    const key = pop();
    const rank = Math.floor(key / POSITION), at = key - rank * POSITION;
    const right = after[at];
    if (symbols[at] < 0 || right < 0 || merges.rank(symbols[at], symbols[right]) !== rank) continue;
    symbols[at] = merges.result[rank];
    symbols[right] = -2;
    const next = after[right];
    after[at] = next;
    if (next >= 0) before[next] = at;
    const previous = before[at];
    if (previous >= 0) {
      const leftRank = merges.rank(symbols[previous], symbols[at]);
      if (leftRank >= 0) push(leftRank * POSITION + previous);
    }
    if (next >= 0) {
      const rightRank = merges.rank(symbols[at], symbols[next]);
      if (rightRank >= 0) push(rightRank * POSITION + at);
    }
  }
}

// Words already tokenized, by text. Both tokenizers cut text into words that are tokenized alone (a Gemma line, a
// Qwen piece), so a word's ids never depend on its neighbours and caching them is exact. Two generations bound the
// memory: when the young one holds `limit` characters of words and ids it becomes the old one, and whatever the old
// one held and nobody asked for since is dropped.
function wordCache(limit: number) {
  type Entry = { key: string; ids: Int32Array };
  let young = new Map<string, Entry>(), old = new Map<string, Entry>(), size = 0;
  const keep = (entry: Entry) => {
    young.set(entry.key, entry);
    size += entry.key.length + entry.ids.length;
    if (size > limit) { old = young; young = new Map(); size = 0; }
  };
  return {
    get(word: string) {
      const entry = young.get(word);
      if (entry) return entry.ids;
      const aged = old.get(word);
      if (!aged) return undefined;
      old.delete(word);
      keep(aged);
      return aged.ids;
    },
    set(word: string, ids: Int32Array) {
      // A word is a slice of a whole prompt, and a slice can keep its parent alive: the key is a flat copy.
      if (word.length <= limit / 4) keep({ key: word.length > 12 ? (' ' + word).slice(1) : word, ids });
      return ids;
    },
  };
}
const DEFAULT_CACHE_CHARS = 1 << 20;

// Tokens that are cut out of the text before BPE, found by walking a trie of UTF-16 units from every position that
// can start one, longest match first. For Hugging Face's added tokens that is the definition (an Aho-Corasick
// automaton, leftmost-longest). llama.cpp instead cuts one special token after another, longest first; the two agree
// when no token's tail is another's head, which the extractor checks of every vocabulary it writes.
type Trie = { next: Map<number, Trie>; id: number; plain: boolean };
function trieOf(tokens: readonly { text: string; id: number; plain?: boolean }[]) {
  const root: Trie = { next: new Map(), id: -1, plain: false };
  const starts = new Uint8Array(0x10000);
  for (const token of tokens) {
    let node = root;
    for (let i = 0; i < token.text.length; i++) {
      const unit = token.text.charCodeAt(i);
      let child = node.next.get(unit);
      if (!child) node.next.set(unit, child = { next: new Map(), id: -1, plain: false });
      node = child;
    }
    node.id = token.id;
    node.plain = token.plain ?? true;
    starts[token.text.charCodeAt(0)] |= node.plain ? 3 : 1;
  }
  // Calls found(from, to, id) for every token cut out of `text`, left to right; with plainOnly, only plain ones.
  return (text: string, plainOnly: boolean, found: (from: number, to: number, id: number) => void) => {
    const wanted = plainOnly ? 2 : 1;
    for (let i = 0; i < text.length; i++) {
      if (!(starts[text.charCodeAt(i)] & wanted)) continue;
      let node: Trie | undefined = root, end = -1, id = -1;
      for (let j = i; j < text.length && (node = node.next.get(text.charCodeAt(j))); j++) {
        if (node.id >= 0 && (node.plain || !plainOnly)) { end = j + 1; id = node.id; }
      }
      if (end < 0) continue;
      found(i, end, id);
      i = end - 1;
    }
  };
}

function utf8Bytes(point: number, out: number[], bytes: Int32Array) {
  if (point < 0x80) out.push(bytes[point]);
  else if (point < 0x800) out.push(bytes[0xc0 | (point >> 6)], bytes[0x80 | (point & 63)]);
  else if (point < 0x10000) out.push(bytes[0xe0 | (point >> 12)], bytes[0x80 | ((point >> 6) & 63)], bytes[0x80 | (point & 63)]);
  else out.push(bytes[0xf0 | (point >> 18)], bytes[0x80 | ((point >> 12) & 63)], bytes[0x80 | ((point >> 6) & 63)], bytes[0x80 | (point & 63)]);
}
type Walk = (onIds: (ids: Int32Array) => void, onToken: (id: number) => void) => void;
function collect(walk: Walk) {
  const out: number[] = [];
  walk(ids => { for (let i = 0; i < ids.length; i++) out.push(ids[i]); }, id => out.push(id));
  return out;
}
function total(walk: Walk) {
  let count = 0;
  walk(ids => { count += ids.length; }, () => { count++; });
  return count;
}

export function gemmaTokenizer(data: GemmaData, { cacheChars = DEFAULT_CACHE_CHARS }: Options = {}): GemmaTokenizer {
  checkHeader(data, 'gemma4');
  const { vocabSize } = data;
  const merges = mergeTable(int32s(data.merges, 'merges'), vocabSize);
  const bytes = idList(data.bytes, vocabSize, 'bytes', 256);
  // Code points below 2^16 by table, the rest by map.
  const basic = new Int32Array(0x10000).fill(-1), astral = new Map<number, number>();
  const chars = int32s(data.chars, 'chars');
  for (let i = 0; i + 1 < chars.length; i += 2) {
    const point = chars[i], id = chars[i + 1];
    if (!(point >= 0 && point <= 0x10ffff && id >= 0 && id < vocabSize)) throw new Error('Tokenizer data: bad chars');
    if (point < 0x10000) basic[point] = id; else astral.set(point, id);
  }
  const newlines = new Map<number, number>();
  for (const [length, id] of data.newlines) newlines.set(length, idList([id], vocabSize, 'newlines')[0]);
  if (!data.special.every(token => typeof token.text === 'string' && token.text && Number.isInteger(token.id)
    && token.id >= 0 && token.id < vocabSize)) throw new Error('Tokenizer data: bad special');
  const cut = trieOf(data.special);
  const cache = wordCache(cacheChars);

  function word(text: string) {
    const cached = cache.get(text);
    if (cached) return cached;
    // llama.cpp gives a run of newlines that is itself a token that token, without merging (its PR 21343).
    if (text.charCodeAt(0) === 10 && newlines.has(text.length)) return cache.set(text, Int32Array.of(newlines.get(text.length)!));
    reserve(text.length);
    let length = 0;
    for (let i = 0; i < text.length; length++) {
      const point = text.codePointAt(i)!;
      i += point > 0xffff ? 2 : 1;
      points[length] = point;
      symbols[length] = point < 0x10000 ? basic[point] : astral.get(point) ?? -1;
    }
    bpe(merges, length);
    const out: number[] = [];
    for (let i = 0; i !== -1; i = after[i]) {
      // A symbol that no merge reached and the vocabulary lacks is one code point: its UTF-8 bytes as <0xXX> tokens.
      if (symbols[i] >= 0) out.push(symbols[i]); else utf8Bytes(points[i], out, bytes);
    }
    return cache.set(text, Int32Array.from(out));
  }
  // Text between special tokens: spaces become U+2581, then every line and every run of newlines is a word.
  function raw(text: string, onIds: (ids: Int32Array) => void) {
    const escaped = text.replaceAll(' ', '▁');
    for (let i = 0; i < escaped.length;) {
      let end = i + 1;
      if (escaped.charCodeAt(i) === 10) { while (end < escaped.length && escaped.charCodeAt(end) === 10) end++; }
      else { end = escaped.indexOf('\n', i); if (end < 0) end = escaped.length; }
      onIds(word(escaped.slice(i, end)));
      i = end;
    }
  }
  const walk = (input: string, special: boolean | undefined): Walk => (onIds, onToken) => {
    // What reaches the server is UTF-8, where a lone surrogate has already become U+FFFD.
    const text = input.toWellFormed();
    let from = 0;
    cut(text, !special, (start, end, id) => {
      if (start > from) raw(text.slice(from, start), onIds);
      onToken(id);
      from = end;
    });
    if (from < text.length) raw(text.slice(from), onIds);
  };
  return {
    kind: 'gemma4', source: data.source, bos: data.bos, eos: data.eos, addBos: data.addBos, addEos: data.addEos,
    templateSha256: data.templateSha256,
    encode: (text, options = {}) => collect(walk(text, options.special)),
    count: (text, options = {}) => total(walk(text, options.special)),
  };
}

// transformers' PRETOKENIZE_REGEX for Qwen2, run by Oniguruma in Hugging Face tokenizers. Oniguruma's \s is Unicode
// White_Space, which has U+0085 and lacks U+FEFF where JavaScript's \s is the other way round, so it is spelled out;
// the case-insensitive contractions are too, with U+017F, the long s that case-folds to s.
const WHITE = '\\t\\n\\v\\f\\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const QWEN_SPLIT = new RegExp(`'[sS\\u017f]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}`
  + `| ?[^${WHITE}\\p{L}\\p{N}]+[\\r\\n]*|[${WHITE}]*[\\r\\n]+|[${WHITE}]+(?![^${WHITE}])|[${WHITE}]+`, 'gu');

export function qwenTokenizer(data: QwenData, { cacheChars = DEFAULT_CACHE_CHARS }: Options = {}): QwenTokenizer {
  checkHeader(data, 'qwen2');
  const merges = mergeTable(int32s(data.merges, 'merges'), data.vocabSize);
  const bytes = idList(data.bytes, data.vocabSize, 'bytes', 256);
  if (!data.added.every(token => typeof token.text === 'string' && token.text && Number.isInteger(token.id) && token.id >= 0
    && token.id < data.vocabSize)) {
    throw new Error('Tokenizer data: bad added');
  }
  const cut = trieOf(data.added);
  const cache = wordCache(cacheChars);
  const encoder = new TextEncoder();

  function piece(text: string) {
    const cached = cache.get(text);
    if (cached) return cached;
    const utf8 = encoder.encode(text);
    reserve(utf8.length);
    for (let i = 0; i < utf8.length; i++) symbols[i] = bytes[utf8[i]];
    bpe(merges, utf8.length);
    const out: number[] = [];
    for (let i = 0; i !== -1; i = after[i]) out.push(symbols[i]);
    return cache.set(text, Int32Array.from(out));
  }
  // Text between added tokens: NFC, then the split, whose every match (and any gap between matches, though the
  // pattern leaves none) is a piece.
  function raw(text: string, onIds: (ids: Int32Array) => void) {
    const normal = text.normalize('NFC');
    let last = 0;
    for (const match of normal.matchAll(QWEN_SPLIT)) {
      if (match.index > last) onIds(piece(normal.slice(last, match.index)));
      onIds(piece(match[0]));
      last = match.index + match[0].length;
    }
    if (last < normal.length) onIds(piece(normal.slice(last)));
  }
  const walk = (input: string): Walk => (onIds, onToken) => {
    const text = input.toWellFormed();
    let from = 0;
    cut(text, false, (start, end, id) => {
      if (start > from) raw(text.slice(from, start), onIds);
      onToken(id);
      from = end;
    });
    if (from < text.length) raw(text.slice(from), onIds);
  };
  return {
    kind: 'qwen2', source: data.source,
    encode: text => collect(walk(text)),
    count: text => total(walk(text)),
  };
}

// The jinja `trim` of llama.cpp's template engine is C isspace in the C locale: ASCII whitespace only.
const isSpace = (code: number) => code === 32 || (code >= 9 && code <= 13);
function trimAscii(text: string) {
  let start = 0, end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start++;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
// The template's strip_thinking: of every part between <channel|> markers, only what precedes a <|channel>.
function stripThinking(text: string) {
  let result = '';
  for (const part of text.split('<channel|>')) result += part.includes('<|channel>') ? part.split('<|channel>')[0] : part;
  return trimAscii(result);
}
function renderTurns(messages: readonly ChatMessage[], generation: boolean) {
  let out = '';
  let rest = messages;
  if (messages[0]?.role === 'system') {
    out += '<|turn>system\n' + trimAscii(messages[0].content) + '<turn|>\n';
    rest = messages.slice(1);
  }
  rest.forEach((message, index) => {
    const role = message.role === 'assistant' ? 'model' : message.role;
    // A model message after an assistant one continues that turn: the template writes no second header for it.
    if (!(role === 'model' && rest[index - 1]?.role === 'assistant')) out += '<|turn>' + role + '\n';
    out += (role === 'model' ? stripThinking(message.content) : trimAscii(message.content)) + '<turn|>\n';
  });
  // enable_thinking false (the bot's request and serve.sh both say so) closes an empty thought channel.
  return generation ? out + '<|turn>model\n<|channel>thought\n<channel|>' : out;
}
// The prompt llama-server builds from these messages for the bot's request (local/llama.ts bodyFor: jinja, no tools,
// enable_thinking false): the Gemma 4 template of the pinned GGUF as common/chat.cpp renders it, less the <bos> it
// strips because the tokenizer adds one. A trailing assistant message is prefilled, as common/parsers/gemma4.cpp does
// with prefill_assistant on (the server's default): the turns before it, then its text after an empty thought.
export function gemmaChatPrompt(messages: readonly ChatMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return renderTurns(messages, true);
  if (messages.at(-2)?.role === 'assistant') throw new Error('llama-server refuses two assistant messages at the end of the list');
  const head = renderTurns(messages.slice(0, -1), false);
  return head + (head.endsWith('<turn|>\n') ? '<|turn>model\n' : '') + '<|channel>thought\n<channel|>' + last.content;
}
// What /v1/chat/completions/input_tokens and the stream's prompt_tokens say for these messages: the prompt tokenized
// with parse_special, plus the BOS (and an EOS, for a model that wants one) the server adds. Pass the messages exactly
// as they go into the body, after local/llama.ts has joined neighbours of the same role. The tokens of every line are
// cached inside the tokenizer, so a request that repeats the history of the one before is counted in milliseconds.
export function gemmaChatTokens(tokenizer: GemmaTokenizer, messages: readonly ChatMessage[]) {
  if (tokenizer.templateSha256 !== GEMMA_TEMPLATE_SHA256) throw new Error('This Gemma tokenizer came from a model with another chat template');
  return Number(tokenizer.addBos) + tokenizer.count(gemmaChatPrompt(messages), { special: true }) + Number(tokenizer.addEos);
}

// ComfyUI 0.37 (comfy/text_encoders/qwen_image21.py and krea2.py): the conditioning template of each encoder. Both
// default to thinking=True, so neither appends the empty <think> block of qwen3vl.py.
export const COMFY_TEMPLATES: Record<PictureEncoder, string> = {
  qwen_image: '<|im_start|>system\nComprehend and analyze the provided prompt.<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n',
  krea2: '<|im_start|>system\nDescribe the image by detailing the color, shape, size, texture, quantity, text, spatial '
    + 'relationships of the objects and background:<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n',
};
const VISION_BLOCK = '<|vision_start|><|image_pad|><|vision_end|>';
// The ids ComfyUI's encoders compare against, written into its source as numbers.
const IM_START = 151644, USER = 872, NEWLINE = 198, PAD = 151643, IMAGE_PAD = 151655;
// Python's str.isspace, which is what \s and split() mean in ComfyUI.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const EMBEDDING_SPLIT = new RegExp(`(?<=[${PY_SPACE}])embedding:`, 'u');
const PY_WORDS = new RegExp(`[^${PY_SPACE}]+`, 'gu');
// sd1_clip.SDTokenizer.tokenize_with_weights with weights disabled, as Qwen3VLTokenizer calls it: "\(" and "\)" lose
// their backslash, the text is cut before every "embedding:" that follows whitespace, and each part is tokenized
// alone. The server's tokenizer has an embeddings directory with no embeddings in it (gpu/image-bootstrap.sh installs
// none), so a part that names one loses the name, and the rest of its words are joined by single spaces.
function comfyText(tokenizer: QwenTokenizer, text: string, alone = false) {
  const unescaped = text.replaceAll('\\)', '\0\u0001').replaceAll('\\(', '\0\u0002')
    .replaceAll('\0\u0001', ')').replaceAll('\0\u0002', '(');
  const [first, ...rest] = unescaped.split(EMBEDDING_SPLIT);
  const out: number[] = [];
  for (let part of [first, ...rest.map(tail => 'embedding:' + tail)]) {
    if (part === '') continue;
    if (part.startsWith('embedding:')) {
      const words = part.slice('embedding:'.length).match(PY_WORDS) ?? [];
      // Python's split()[0] fails on nothing. Inside the template that takes a prompt that starts with <|im_start|>
      // and ends so; a prompt counted alone just loses the empty name.
      if (!words.length) {
        if (alone) continue;
        throw new Error('ComfyUI fails on a prompt that starts with <|im_start|> and ends with "embedding:"');
      }
      let name = words[0] ?? '', leftover = words.slice(1).join(' ');
      const bracket = /[<[]/.exec(name);
      if (bracket) {
        leftover = name.slice(bracket.index) + (leftover ? ' ' + leftover : '');
        name = name.slice(0, bracket.index);
      }
      // Python keeps name[len(name.strip(',')):], counted in code points, whichever end the commas were at.
      const points = [...name], kept = [...name.replace(/^,+|,+$/g, '')];
      if (kept.length < points.length) leftover = `${points.slice(kept.length).join('')} ${leftover}`;
      if (leftover === '') continue;
      part = leftover;
    }
    for (const id of tokenizer.encode(part)) out.push(id);
  }
  return out;
}
// The text each graph hands the encoder. The Qwen graphs encode with TextEncodeQwenImage21, which asks for
// prevent_empty_text (an empty prompt is sent as one space); the Krea graph encodes with CLIPTextEncode, which does not.
const encoderText = (prompt: string, encoder: PictureEncoder) => encoder === 'qwen_image' && prompt === '' ? ' ' : prompt;
// Qwen3VLTokenizer.tokenize_with_weights for one picture prompt: the whole sequence the encoder runs over. `images`
// reference pictures (TextEncodeQwenImage21 with images, the edit graph) put "<imageN>" and a vision block per picture
// before the prompt. A prompt that starts with <|im_start|> is taken as a template of its own, and an empty sequence
// is padded to one token.
export function comfyTokens(tokenizer: QwenTokenizer, prompt: string, encoder: PictureEncoder, { images = 0 } = {}) {
  if (!Number.isInteger(images) || images < 0 || (images && encoder !== 'qwen_image')) throw new Error('Reference images go with qwen_image only');
  const text = encoderText(prompt, encoder);
  const references = Array.from({ length: images }, (_, index) => `<image${index + 1}>${VISION_BLOCK}`).join(' ');
  const [head, tail] = COMFY_TEMPLATES[encoder].split('{}');
  const ids = comfyText(tokenizer, text.startsWith('<|im_start|>') ? text : head + references + text + tail);
  return ids.length ? ids : [PAD];
}
// How many tokens a picture prompt is: `prompt` for its own text as ComfyUI tokenizes it, `conditioning` for the span
// of the encoder's output the picture model is conditioned on. Qwen-Image 2.1 drops everything before the second
// <|im_start|>, and with reference images (the edit graph, which gives the node a VAE) each picture's embeddings too,
// whatever their size; Krea 2 drops everything up to the second <|im_start|> and, when the next two tokens are "user"
// and "\n", those too. For a plain prompt that is prompt + 8 and prompt + 5 (less whatever the prompt's first or
// last characters merge into), and each reference picture adds 6 to Qwen-Image's: "<imageN>" is 4 tokens (" <" after
// the first) and its vision start and end stay. The graphs' negative prompt is encoded apart and counted the same way.
export function qwenPromptTokens(tokenizer: QwenTokenizer, prompt: string, encoder: PictureEncoder, { images = 0 } = {}) {
  const ids = comfyTokens(tokenizer, prompt, encoder, { images });
  const starts = ids.flatMap((id, index) => id === IM_START ? [index] : []);
  let from: number, dropped = 0;
  if (encoder === 'qwen_image') {
    from = starts.length > 1 ? starts[1] : 0;
    // ComfyUI swaps the first `images` <|image_pad|> tokens for the pictures and drops those spans after the cut.
    let pictures = 0;
    ids.forEach((id, index) => { if (id === IMAGE_PAD && pictures++ < images && index >= from) dropped++; });
  } else {
    let end = starts.length ? starts[Math.min(starts.length, 2) - 1] : -1;
    if (ids.length > end + 3 && ids[end + 1] === USER && ids[end + 2] === NEWLINE) end += 3;
    // Python's out[:, :, -1:] when there was no <|im_start|> at all: the last token alone.
    from = end < 0 ? Math.max(0, ids.length + end) : Math.min(end, ids.length);
  }
  return { prompt: comfyText(tokenizer, encoderText(prompt, encoder), true).length, conditioning: ids.length - from - dropped };
}

export function readTokenizerFile(path: string): GemmaData | QwenData {
  const data = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
  if (data?.format !== TOKENIZER_FORMAT) throw new Error(`${path} is not a ${TOKENIZER_FORMAT} file`);
  return data;
}
// The two tokenizers from `dir` (tokenizers/ at the repository root), each read the first time it is asked for. A
// missing file answers undefined and is looked for again on the next call; a broken one throws.
export function loadTokenizers(dir: string, options: Options = {}) {
  let gemma: GemmaTokenizer | undefined, qwen: QwenTokenizer | undefined;
  const read = (file: string) => {
    try { return readTokenizerFile(join(dir, file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  return {
    gemma(): GemmaTokenizer | undefined {
      const data = gemma ? undefined : read(GEMMA_FILE);
      if (data) gemma = gemmaTokenizer(data as GemmaData, options);
      return gemma;
    },
    qwen(): QwenTokenizer | undefined {
      const data = qwen ? undefined : read(QWEN_FILE);
      if (data) qwen = qwenTokenizer(data as QwenData, options);
      return qwen;
    },
  };
}
