// Writes tokenizers/gemma-4.json.gz and tokenizers/qwen-2.5.json.gz, the vocabularies local/tokenizer.ts counts with.
// Gemma 4 comes out of the GGUF that gpu/manifest.env pins: by default only its metadata, the first few MB of the
// 25 GB file, read with Range requests from Hugging Face; `--gemma file.gguf` reads a local copy instead. Qwen2 comes
// from the three files ComfyUI ships at the revision gpu/image-manifest.env pins, from GitHub or from `--qwen dir`,
// checked against the SHA-256 that manifest pins. Each file is built the way its server builds the tokenizer, must
// give the ids those servers gave for local/tokenizer-probe.json, and only then replaces the one in tokenizers/.
// docs/tokenizers.md#files has the whole story.
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  GEMMA_FILE, GEMMA_TEMPLATE_SHA256, QWEN_FILE, TOKENIZER_FORMAT, comfyTokens, gemmaChatTokens, gemmaTokenizer,
  int32Base64, qwenTokenizer, readTokenizerFile,
} from './tokenizer.ts';
import type { ChatMessage, GemmaData, GemmaTokenizer, QwenData, QwenTokenizer, SpecialToken } from './tokenizer.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export function readManifest(path: string) {
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return values;
}

// GGUF v2/v3 metadata: magic, version, tensor count, key-value count, then the key-value pairs. The tensors that
// follow are not read. `NeedMore` says how far into the file the pairs go, so the caller can fetch that much and
// parse again.
export class NeedMore extends Error {
  readonly bytes: number;
  constructor(bytes: number) { super(`GGUF metadata runs past byte ${bytes}`); this.bytes = bytes; }
}
export type GgufValue = number | bigint | boolean | string | GgufValue[];
export function parseGgufMetadata(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // ignoreBOM keeps a leading U+FEFF, which some tokens have and TextDecoder would otherwise drop.
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let at = 0;
  const need = (length: number) => { if (at + length > bytes.length) throw new NeedMore(at + length); };
  const u32 = () => { need(4); const value = view.getUint32(at, true); at += 4; return value; };
  const size = () => {
    const low = u32(), high = u32();
    if (high >= 2 ** 21) throw new Error('GGUF: a length beyond 2^53');
    return high * 2 ** 32 + low;
  };
  const string = () => {
    const length = size();
    need(length);
    const text = utf8.decode(bytes.subarray(at, at + length));
    at += length;
    return text;
  };
  const value = (type: number): GgufValue => {
    const fixed = (length: number, read: (offset: number) => GgufValue) => { need(length); const result = read(at); at += length; return result; };
    switch (type) {
      case 0: return fixed(1, offset => view.getUint8(offset));
      case 1: return fixed(1, offset => view.getInt8(offset));
      case 2: return fixed(2, offset => view.getUint16(offset, true));
      case 3: return fixed(2, offset => view.getInt16(offset, true));
      case 4: return fixed(4, offset => view.getUint32(offset, true));
      case 5: return fixed(4, offset => view.getInt32(offset, true));
      case 6: return fixed(4, offset => view.getFloat32(offset, true));
      case 7: return fixed(1, offset => view.getUint8(offset) !== 0);
      case 8: return string();
      case 9: {
        const inner = u32(), count = size();
        need(count);
        const values: GgufValue[] = new Array(count);
        for (let i = 0; i < count; i++) values[i] = value(inner);
        return values;
      }
      case 10: return fixed(8, offset => view.getBigUint64(offset, true));
      case 11: return fixed(8, offset => view.getBigInt64(offset, true));
      case 12: return fixed(8, offset => view.getFloat64(offset, true));
      default: throw new Error(`GGUF: unknown value type ${type}`);
    }
  };
  need(24);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'GGUF') throw new Error('Not a GGUF file');
  at = 4;
  const version = u32();
  if (version !== 2 && version !== 3) throw new Error(`GGUF version ${version} is not one this reader knows`);
  size();
  const count = size();
  const metadata = new Map<string, GgufValue>();
  for (let i = 0; i < count; i++) {
    const key = string();
    metadata.set(key, value(u32()));
  }
  return { metadata, length: at };
}

export type ByteSource = { name: string; read(from: number, to: number): Promise<Uint8Array> };
export function fileSource(path: string): ByteSource {
  return {
    name: basename(path),
    async read(from, to) {
      const buffer = Buffer.alloc(to - from);
      const fd = openSync(path, 'r');
      try {
        let done = 0;
        for (let got = 1; got > 0 && done < buffer.length; done += got) got = readSync(fd, buffer, done, buffer.length - done, from + done);
        return buffer.subarray(0, done);
      } finally { closeSync(fd); }
    },
  };
}
function httpSource(url: string, name: string): ByteSource {
  return {
    name,
    async read(from, to) {
      const response = await fetch(url, { headers: { Range: `bytes=${from}-${to - 1}` } });
      if (response.status === 416) return new Uint8Array(0);
      if (response.status !== 206) throw new Error(`${name}: a Range request came back ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
// Reads as much of the file as its metadata takes: a first guess, then whatever the parser says is missing.
export async function readGgufMetadata(source: ByteSource, first = 8 << 20) {
  let bytes = new Uint8Array(0), want = first;
  for (;;) {
    if (want > bytes.length) {
      const more = await source.read(bytes.length, want);
      if (!more.length) throw new Error(`${source.name} ends inside its metadata`);
      const grown = new Uint8Array(bytes.length + more.length);
      grown.set(bytes);
      grown.set(more, bytes.length);
      bytes = grown;
    }
    try { return { ...parseGgufMetadata(bytes), read: bytes.length }; }
    catch (error) {
      if (!(error instanceof NeedMore)) throw error;
      if (error.bytes > 1 << 30) throw new Error(`${source.name}: metadata of more than 1 GB is not a tokenizer`);
      want = Math.max(error.bytes, bytes.length * 2);
    }
  }
}

// llama.cpp's token types and the attributes it derives from them (src/llama-vocab.cpp at the pinned revision).
const UNKNOWN = 1, NORMAL = 4, CONTROL = 8, USER_DEFINED = 16, BYTE = 32;
const ATTR_OF_TYPE: Record<number, number> = { 0: 0, 1: NORMAL, 2: UNKNOWN, 3: CONTROL, 4: USER_DEFINED, 5: 2, 6: BYTE };
// The texts llama.cpp promotes to control tokens (and end-of-generation ones) whatever the file says.
const DETECTED = {
  eot: ['<|eot_id|>', '<|im_end|>', '<|end|>', '<end_of_turn>', '<|endoftext|>', '<|end_of_text|>', '<EOT>', '_<EOT>',
    '[EOT]', '<｜end▁of▁sentence｜>', '<end_of_utterance>'],
  eom: ['<|eom_id|>'],
  fimPre: ['<|fim_prefix|>', '<fim-prefix>', '<fim_prefix>', '<｜fim▁begin｜>', '<PRE>', '▁<PRE>', '<|code_prefix|>', '<|prefix|>'],
  fimSuf: ['<|fim_suffix|>', '<fim-suffix>', '<fim_suffix>', '<｜fim▁hole｜>', '<SUF>', '▁<SUF>', '<|code_suffix|>', '<|suffix|>'],
  fimMid: ['<|fim_middle|>', '<fim-middle>', '<fim_middle>', '<｜fim▁end｜>', '<MID>', '▁<MID>', '<|code_middle|>', '<|middle|>'],
  fimPad: ['<|fim_pad|>', '<fim-pad>', '<fim_pad>', '<PAD>', '[PAD]'],
  fimRep: ['<|fim_repo|>', '<|repo_name|>', '<fim-repo>', '<REPO>', '<reponame>'],
  fimSep: ['<|file_sep|>'],
};
const END_OF_GENERATION = ['<|eot_id|>', '<|im_end|>', '<|end|>', '<|return|>', '<|call|>', '<|flush|>', '<|calls|>',
  '<end_of_turn>', '<|endoftext|>', '</s>', '<|eom_id|>', '<EOT>', '_<EOT>', '[EOT]', '[EOS]', '<|end_of_text|>',
  '<end_of_utterance>', '<eos>', '<turn|>', '<|tool_response>', '<｜end▁of▁sentence｜>', '[e~['];
const ALWAYS_USER_DEFINED = ['<|channel|>', '<|message|>', '<|start|>', '<|constrain|>'];
const ID_KEYS = {
  bos: ['tokenizer.ggml.bos_token_id'], eos: ['tokenizer.ggml.eos_token_id'], eot: ['tokenizer.ggml.eot_token_id'],
  eom: ['tokenizer.ggml.eom_token_id'], fimPre: ['tokenizer.ggml.fim_pre_token_id', 'tokenizer.ggml.prefix_token_id'],
  fimSuf: ['tokenizer.ggml.fim_suf_token_id', 'tokenizer.ggml.suffix_token_id'],
  fimMid: ['tokenizer.ggml.fim_mid_token_id', 'tokenizer.ggml.middle_token_id'],
  fimPad: ['tokenizer.ggml.fim_pad_token_id'], fimRep: ['tokenizer.ggml.fim_rep_token_id'], fimSep: ['tokenizer.ggml.fim_sep_token_id'],
};
type IdName = keyof typeof ID_KEYS;

export type GemmaInput = {
  model: string; pre?: string; name?: string; architecture?: string; tokens: string[]; types?: ArrayLike<number>;
  merges: string[]; ids: Partial<Record<IdName, number>>; addBos?: boolean; addEos?: boolean; template: string;
};
export function gemmaInput(metadata: Map<string, GgufValue>): GemmaInput {
  const text = (key: string) => { const found = metadata.get(key); return typeof found === 'string' ? found : undefined; };
  const strings = (key: string) => {
    const found = metadata.get(key);
    if (!Array.isArray(found) || !found.every(item => typeof item === 'string')) throw new Error(`GGUF: ${key} is not a list of strings`);
    return found as string[];
  };
  const types = metadata.get('tokenizer.ggml.token_type');
  if (types !== undefined && !(Array.isArray(types) && types.every(item => typeof item === 'number'))) throw new Error('GGUF: bad token_type');
  const ids: Partial<Record<IdName, number>> = {};
  for (const [name, keys] of Object.entries(ID_KEYS) as [IdName, string[]][]) {
    for (const key of keys) { const found = metadata.get(key); if (typeof found === 'number') ids[name] = found; }
  }
  const flag = (key: string) => { const found = metadata.get(key); return typeof found === 'boolean' ? found : undefined; };
  return {
    model: text('tokenizer.ggml.model') ?? '', pre: text('tokenizer.ggml.pre'), name: text('general.name'),
    architecture: text('general.architecture'), tokens: strings('tokenizer.ggml.tokens'), types: types as number[] | undefined,
    merges: strings('tokenizer.ggml.merges'), ids, addBos: flag('tokenizer.ggml.add_bos_token'),
    addEos: flag('tokenizer.ggml.add_eos_token'), template: text('tokenizer.chat_template') ?? '',
  };
}

// A token whose tail is some special token's head (itself included) could be cut two ways, and which way llama.cpp
// cuts it would depend on the order its unstable sort left equal lengths in. None of Gemma's are like that.
function overlap(texts: readonly string[]) {
  const heads = new Set<string>();
  for (const text of texts) for (let i = 1; i < text.length; i++) heads.add(text.slice(0, i));
  for (const text of texts) for (let i = 1; i < text.length; i++) if (heads.has(text.slice(i))) return text;
  return undefined;
}

// llama.cpp's llama_vocab::impl::load for tokenizer.ggml.model "gemma4", as far as tokenizing depends on it.
export function buildGemma(input: GemmaInput, source: Record<string, string>): GemmaData {
  if (input.model !== 'gemma4') throw new Error(`tokenizer.ggml.model is "${input.model}", and only gemma4 is reproduced`);
  const name = (input.name ?? '').toLowerCase();
  if (['phi-3', 'phi3', 'modern-bert'].some(part => name.includes(part))
    || ['jina-v2-de', 'jina-v2-es', 'jina-v2-code'].some(part => (input.pre ?? '').includes(part))
    || ['nomic-bert-moe', 'jina-bert-v3'].some(part => (input.architecture ?? '').includes(part))) {
    throw new Error('llama.cpp strips spaces around special tokens for a model of this name, which is not reproduced');
  }
  const texts = input.tokens.map((text, id) => text === '' ? `[EMPTY_${id}]` : text);
  const count = texts.length;
  const byText = new Map<string, number>();
  texts.forEach((text, id) => {
    if (byText.has(text)) throw new Error(`Token ${id} has the text of token ${byText.get(text)}, which llama.cpp refuses`);
    byText.set(text, id);
  });
  if (input.types && input.types.length < count) throw new Error('Fewer token types than tokens');
  const attrs = Int32Array.from(texts, (_, id) => input.types ? ATTR_OF_TYPE[input.types[id]] ?? 0 : NORMAL);
  const ids: Partial<Record<IdName, number>> = {};
  for (const [key, id] of Object.entries(input.ids) as [IdName, number][]) if (id >= 0 && id < count) ids[key] = id;
  for (const [key, candidates] of Object.entries(DETECTED) as [IdName, string[]][]) {
    if (ids[key] !== undefined) continue;
    const found = candidates.filter(text => byText.has(text));
    if (found.length > 1) throw new Error(`Several ${key} tokens (${found.join(' ')}): llama.cpp takes the first its hash map yields`);
    if (found.length) { ids[key] = byText.get(found[0])!; attrs[ids[key]!] |= CONTROL; }
  }
  const endOfGeneration = new Set<number>();
  for (const key of ['fimPad', 'fimRep', 'fimSep'] as const) if (ids[key] !== undefined) endOfGeneration.add(ids[key]!);
  for (const text of END_OF_GENERATION) {
    const id = byText.get(text);
    if (id !== undefined) { endOfGeneration.add(id); attrs[id] |= CONTROL; }
  }
  for (const text of ALWAYS_USER_DEFINED) { const id = byText.get(text); if (id !== undefined) attrs[id] = USER_DEFINED; }
  for (const key of ['eos', 'eot', 'eom'] as const) if (ids[key] !== undefined) endOfGeneration.add(ids[key]!);
  const ending = (text: string) => [...endOfGeneration].find(id => texts[id] === text);
  const has = (...candidates: string[]) => candidates.some(text => ending(text) !== undefined);
  if (has('<|end|>') && ((has('<|return|>') && has('<|call|>', '<|calls|>')) || (has('<|call|>', '<|calls|>') && has('<|flush|>')))) {
    attrs[ending('<|end|>')!] = USER_DEFINED;
  }
  if (has('<|tool_response>') && has('</s>')) attrs[ending('</s>')!] = NORMAL;

  const special: SpecialToken[] = [];
  for (let id = 0; id < count; id++) {
    if (attrs[id] & (CONTROL | USER_DEFINED | UNKNOWN)) special.push({ text: texts[id], id, plain: !(attrs[id] & (CONTROL | UNKNOWN)) });
  }
  special.sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text) || a.id - b.id);
  const overlapping = overlap(special.map(token => token.text));
  if (overlapping) throw new Error(`Special token ${JSON.stringify(overlapping)} overlaps another; their order would matter`);

  const triples: number[] = [];
  const seen = new Set<number>();
  input.merges.forEach((merge, rank) => {
    // llama.cpp splits at the first space after the first byte, and ranks a line without one as the pair ("", ""),
    // which no symbol matches.
    const space = merge.indexOf(' ', 1);
    if (space < 0) return;
    const [left, right] = [merge.slice(0, space), merge.slice(space + 1)];
    const ids = [byText.get(left), byText.get(right), byText.get(left + right)];
    if (ids.includes(undefined)) throw new Error(`Merge ${rank} (${JSON.stringify(merge)}) involves a string that is not a token`);
    const key = ids[0]! * count + ids[1]!;
    if (seen.has(key)) return;
    seen.add(key);
    triples.push(ids[0]!, ids[1]!, ids[2]!);
  });
  const chars: number[] = [];
  texts.forEach((text, id) => {
    const point = text.codePointAt(0)!;
    if (text.length === (point > 0xffff ? 2 : 1)) chars.push(point, id);
  });
  const bytes = Array.from({ length: 256 }, (_, byte) => {
    const id = byText.get(`<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`);
    if (id === undefined) throw new Error(`The vocabulary lacks the byte token for ${byte}`);
    return id;
  });
  const newlines = texts.flatMap((text, id) => /^\n+$/.test(text) ? [[text.length, id] as [number, number]] : []);
  if (ids.bos === undefined) throw new Error('No BOS token, which llama.cpp adds to every Gemma 4 prompt');
  if (input.addEos && ids.eos === undefined) throw new Error('add_eos_token without an EOS token');
  return {
    format: TOKENIZER_FORMAT, kind: 'gemma4', source, vocabSize: count, bos: ids.bos, eos: ids.eos ?? -1,
    // llama.cpp turns add_bos on for every GEMMA4 vocabulary (its PR 21500), whatever the file says.
    addBos: true, addEos: input.addEos ?? false, templateSha256: sha256(input.template), merges: int32Base64(triples),
    chars: int32Base64(chars), bytes, newlines, special,
  };
}

// GPT-2's bytes_to_unicode: printable Latin-1 bytes stand for themselves, the rest are moved to U+0100 onward.
export function byteLevelAlphabet() {
  const kept = (byte: number) => (byte >= 0x21 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xac) || (byte >= 0xae && byte <= 0xff);
  let moved = 0;
  return Array.from({ length: 256 }, (_, byte) => String.fromCodePoint(kept(byte) ? byte : 256 + moved++));
}
type AddedConfig = { content: string; lstrip?: boolean; rstrip?: boolean; normalized?: boolean; single_word?: boolean; special?: boolean };
export type QwenInput = {
  vocab: Record<string, number>; merges: string;
  config: { added_tokens_decoder?: Record<string, AddedConfig>; split_special_tokens?: boolean; add_prefix_space?: boolean;
    add_bos_token?: boolean; add_eos_token?: boolean };
};
// transformers 5's Qwen2Tokenizer over Hugging Face tokenizers' BPE.from_file, as ComfyUI loads qwen25_tokenizer/.
export function buildQwen(input: QwenInput, source: Record<string, string>): QwenData {
  const { config } = input;
  if (config.split_special_tokens || config.add_prefix_space || config.add_bos_token || config.add_eos_token) {
    throw new Error('tokenizer_config.json asks for split_special_tokens, add_prefix_space or added BOS/EOS, which are not reproduced');
  }
  const vocab = new Map(Object.entries(input.vocab));
  const lines = input.merges.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const triples: number[] = [];
  const seen = new Set<string>();
  lines.map(line => line.replace(/\r$/, '')).filter(line => !line.startsWith('#version')).forEach((line, rank) => {
    const parts = line.split(' ');
    if (parts.length !== 2) throw new Error(`merges.txt line ${rank + 1} is not two tokens`);
    const ids = [vocab.get(parts[0]), vocab.get(parts[1]), vocab.get(parts[0] + parts[1])];
    if (ids.includes(undefined)) throw new Error(`Merge ${rank} (${JSON.stringify(line)}) involves a string that is not in vocab.json`);
    // Hugging Face keeps the last rank of a pair listed twice, llama.cpp the first; neither is written here.
    if (seen.has(line)) throw new Error(`merges.txt lists ${JSON.stringify(line)} twice`);
    seen.add(line);
    triples.push(ids[0]!, ids[1]!, ids[2]!);
  });
  const bytes = byteLevelAlphabet().map((char, byte) => {
    const id = vocab.get(char);
    if (id === undefined) throw new Error(`vocab.json lacks the byte-level character for ${byte}`);
    return id;
  });
  const added = Object.entries(config.added_tokens_decoder ?? {}).map(([id, token]) => {
    if (token.lstrip || token.rstrip || token.single_word || token.normalized) {
      throw new Error(`Added token ${JSON.stringify(token.content)} strips, matches whole words or is normalized, which is not reproduced`);
    }
    return { text: token.content, id: Number(id) };
  }).sort((a, b) => a.id - b.id);
  // tokenizers numbers added tokens after the model's vocabulary in the order they are added, so the ids the config
  // gives them hold only when they follow on from it.
  if (added.some((token, index) => token.id !== vocab.size + index || vocab.has(token.text))) {
    throw new Error('The added tokens do not follow on from vocab.json');
  }
  const vocabSize = vocab.size + added.length;
  return {
    format: TOKENIZER_FORMAT, kind: 'qwen2', source, vocabSize, merges: int32Base64(triples), bytes, added,
  };
}

// local/tokenizer-probe.json: synthetic strings and chats with the ids and counts the pinned servers gave for them.
export type Probe = {
  cases: { text: string; gemma: number[]; gemmaSpecial?: number[]; qwen: number[]; qwenImage: number[]; krea2: number[] }[];
  chats: { messages: ChatMessage[]; count: number }[];
};
export const readProbe = (): Probe => JSON.parse(readFileSync(new URL('./tokenizer-probe.json', import.meta.url), 'utf8'));
export function probeFailures(probe: Probe, gemma?: GemmaTokenizer, qwen?: QwenTokenizer) {
  const failures: string[] = [];
  const compare = (what: string, got: readonly number[], want: readonly number[]) => {
    let at = 0;
    while (at < got.length && at < want.length && got[at] === want[at]) at++;
    if (at < got.length || at < want.length) failures.push(`${what}: ${got.length} ids against ${want.length}, first difference at ${at}`);
  };
  probe.cases.forEach((item, index) => {
    if (gemma) {
      compare(`case ${index} gemma`, gemma.encode(item.text), item.gemma);
      compare(`case ${index} gemma special`, gemma.encode(item.text, { special: true }), item.gemmaSpecial ?? item.gemma);
    }
    if (qwen) {
      compare(`case ${index} qwen`, qwen.encode(item.text), item.qwen);
      compare(`case ${index} qwen_image`, comfyTokens(qwen, item.text, 'qwen_image'), item.qwenImage);
      compare(`case ${index} krea2`, comfyTokens(qwen, item.text, 'krea2'), item.krea2);
    }
  });
  if (gemma) {
    probe.chats.forEach((chat, index) => {
      const count = gemmaChatTokens(gemma, chat.messages);
      if (count !== chat.count) failures.push(`chat ${index}: ${count} tokens against ${chat.count}`);
    });
  }
  return failures;
}

async function gemmaData(file: string | undefined, manifest: Record<string, string>) {
  const pin = `${manifest.MODEL_REPO}@${manifest.MODEL_REVISION}/${manifest.MODEL_FILE}`;
  let source: ByteSource;
  let origin: Record<string, string>;
  if (file) {
    source = fileSource(file);
    origin = { gguf: basename(file), bytes: String(statSync(file).size) };
  } else {
    const url = `https://huggingface.co/${manifest.MODEL_REPO}/resolve/${manifest.MODEL_REVISION}/${manifest.MODEL_FILE}`;
    // The file is 25 GB and only its first MB are read, so its identity is what Hugging Face says of it: the LFS
    // hash and size in the headers of the redirect, which have to be the ones the manifest pins.
    const head = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const linked = head.headers.get('x-linked-etag')?.replaceAll('"', ''), size = head.headers.get('x-linked-size');
    if (linked !== manifest.MODEL_SHA256 || size !== manifest.MODEL_BYTES) {
      throw new Error(`Hugging Face describes ${pin} as sha256 ${linked ?? 'unknown'}, ${size ?? 'unknown'} bytes; `
        + `gpu/manifest.env pins ${manifest.MODEL_SHA256}, ${manifest.MODEL_BYTES}`);
    }
    source = httpSource(url, pin);
    origin = { gguf: pin, sha256: linked, bytes: size };
  }
  const started = performance.now();
  const { metadata, read } = await readGgufMetadata(source);
  console.log(`${source.name}: ${metadata.size} metadata keys in the first ${(read / 2 ** 20).toFixed(1)} MB, `
    + `${Math.round(performance.now() - started)} ms`);
  const data = buildGemma(gemmaInput(metadata), { ...origin, llamaCpp: manifest.LLAMA_CPP_REVISION });
  if (data.templateSha256 !== GEMMA_TEMPLATE_SHA256) {
    throw new Error(`This GGUF's chat template has sha256 ${data.templateSha256}, and gemmaChatPrompt in local/tokenizer.ts `
      + `reproduces ${GEMMA_TEMPLATE_SHA256}: port the new template there and change the constant with it`);
  }
  return data;
}

const QWEN_FILES = { vocab: 'vocab.json', merges: 'merges.txt', config: 'tokenizer_config.json' } as const;
async function qwenData(dir: string | undefined, manifest: Record<string, string>) {
  const repository = /github\.com\/([^/]+\/[^/.]+)/.exec(manifest.COMFYUI_REPO ?? '')?.[1];
  const path = manifest.QWEN_TOKENIZER_PATH;
  if (!repository || !manifest.COMFYUI_REVISION || !path) throw new Error('gpu/image-manifest.env pins no ComfyUI tokenizer');
  const texts = {} as Record<keyof typeof QWEN_FILES, string>;
  const hashes: Record<string, string> = {};
  for (const [key, file] of Object.entries(QWEN_FILES) as [keyof typeof QWEN_FILES, string][]) {
    let bytes: Uint8Array;
    if (dir) bytes = readFileSync(join(dir, file));
    else {
      const url = `https://raw.githubusercontent.com/${repository}/${manifest.COMFYUI_REVISION}/${path}/${file}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${file}: GitHub answered ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    const pinned = manifest[`QWEN_TOKENIZER_${key.toUpperCase()}_SHA256`];
    const digest = sha256(bytes);
    if (digest !== pinned) throw new Error(`${file} has sha256 ${digest}, and gpu/image-manifest.env pins ${pinned}`);
    texts[key] = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    hashes[`${key}Sha256`] = digest;
  }
  return buildQwen({ vocab: JSON.parse(texts.vocab), merges: texts.merges, config: JSON.parse(texts.config) },
    { files: `${repository}@${manifest.COMFYUI_REVISION}/${path}`, ...hashes });
}

// Writes next to the target, checks the written file against the probe, and only then puts it in place.
function install(dir: string, file: string, data: GemmaData | QwenData, probe: Probe) {
  const target = join(dir, file), draft = `${target}.${process.pid}.tmp`;
  const packed = gzipSync(JSON.stringify(data), { level: 9 });
  writeFileSync(draft, packed);
  try {
    const started = performance.now();
    const read = readTokenizerFile(draft);
    const failures = read.kind === 'gemma4' ? probeFailures(probe, gemmaTokenizer(read)) : probeFailures(probe, undefined, qwenTokenizer(read as QwenData));
    if (failures.length) {
      throw new Error(`${file} does not give the ids the server gave for local/tokenizer-probe.json:\n  ${failures.slice(0, 20).join('\n  ')}`
        + (failures.length > 20 ? `\n  and ${failures.length - 20} more` : ''));
    }
    renameSync(draft, target);
    console.log(`${file}: ${(packed.length / 2 ** 20).toFixed(1)} MB, vocabulary ${data.vocabSize}, `
      + `probe of ${probe.cases.length} strings${read.kind === 'gemma4' ? ` and ${probe.chats.length} chats` : ''} identical `
      + `(${Math.round(performance.now() - started)} ms)`);
  } finally {
    rmSync(draft, { force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { gemma: { type: 'string' }, qwen: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' } },
  });
  if (values.only && values.only !== 'gemma' && values.only !== 'qwen') throw new Error('--only takes gemma or qwen');
  const out = resolve(values.out ?? join(ROOT, 'tokenizers'));
  mkdirSync(out, { recursive: true });
  const probe = readProbe();
  if (values.only !== 'qwen') {
    const data = await gemmaData(values.gemma, readManifest(join(ROOT, 'gpu/manifest.env')));
    install(out, GEMMA_FILE, data, probe);
  }
  if (values.only !== 'gemma') {
    const data = await qwenData(values.qwen, readManifest(join(ROOT, 'gpu/image-manifest.env')));
    install(out, QWEN_FILE, data, probe);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
