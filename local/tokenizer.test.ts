// The tokenizers on vocabularies small enough to reason about by hand, built through the extractor's own builders
// (and for Gemma through a GGUF written here), then the real vocabularies against the ids the servers gave, when
// `npm run tokenizers` has put them in tokenizers/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  COMFY_TEMPLATES, GEMMA_FILE, GEMMA_TEMPLATE_SHA256, QWEN_FILE, TOKENIZER_FORMAT, comfyTokens, gemmaChatPrompt,
  gemmaChatTokens, gemmaTokenizer, int32Base64, loadTokenizers, qwenPromptTokens, qwenTokenizer,
} from './tokenizer.ts';
import type { GemmaData, QwenData } from './tokenizer.ts';
import {
  NeedMore, buildGemma, buildQwen, byteLevelAlphabet, gemmaInput, parseGgufMetadata, probeFailures, readGgufMetadata,
  readProbe,
} from './tokenizer-extract.ts';
import type { GgufValue } from './tokenizer-extract.ts';

// --- A GGUF written by hand ----------------------------------------------------------------------------------------

type Entry = [string, 'string' | 'u32' | 'i32' | 'bool' | 'strings' | 'i32s', GgufValue];
function gguf(entries: Entry[]) {
  const parts: Buffer[] = [];
  const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); parts.push(b); };
  const u64 = (value: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); parts.push(b); };
  const string = (text: string) => { const bytes = Buffer.from(text, 'utf8'); u64(bytes.length); parts.push(bytes); };
  parts.push(Buffer.from('GGUF'));
  u32(3); u64(0); u64(entries.length);
  for (const [key, type, value] of entries) {
    string(key);
    if (type === 'string') { u32(8); string(value as string); }
    else if (type === 'u32') { u32(4); u32(value as number); }
    else if (type === 'i32') { u32(5); const b = Buffer.alloc(4); b.writeInt32LE(value as number); parts.push(b); }
    else if (type === 'bool') { u32(7); parts.push(Buffer.of(value ? 1 : 0)); }
    else if (type === 'strings') { u32(9); u32(8); u64((value as string[]).length); for (const text of value as string[]) string(text); }
    else { u32(9); u32(5); u64((value as number[]).length); for (const n of value as number[]) { const b = Buffer.alloc(4); b.writeInt32LE(n); parts.push(b); } }
  }
  parts.push(Buffer.alloc(64, 0xee)); // where the tensor infos would start
  return new Uint8Array(Buffer.concat(parts));
}

// --- A Gemma 4 vocabulary of a few dozen tokens --------------------------------------------------------------------

const NORMAL = 1, UNKNOWN = 2, CONTROL = 3, USER_DEFINED = 4, BYTE = 6;
const hex = (byte: number) => `<0x${byte.toString(16).toUpperCase().padStart(2, '0')}>`;
const gemmaTokens: [string, number][] = [
  ['<pad>', CONTROL], ['<eos>', CONTROL], ['<bos>', CONTROL], ['<unk>', UNKNOWN],
  ['<|turn>', CONTROL], ['<turn|>', NORMAL], ['<|channel>', USER_DEFINED], ['<channel|>', USER_DEFINED],
  ...Array.from({ length: 256 }, (_, byte): [string, number] => [hex(byte), BYTE]),
  ['▁', NORMAL], ['a', NORMAL], ['b', NORMAL], ['c', NORMAL], ['ab', NORMAL], ['bc', NORMAL], ['abc', NORMAL],
  ['aa', NORMAL], ['▁b', NORMAL], ['\n', NORMAL], ['\n\n', NORMAL], ['x', NORMAL], ['😀', NORMAL], ['﻿a', NORMAL],
];
const gemmaMerges = ['a b', 'b c', 'ab c', 'a a', '▁ b', '\n \n'];
const G = Object.fromEntries(gemmaTokens.map(([text], id) => [text, id]));
const byte = (value: number) => 8 + value;
function gemmaFile(overrides: Entry[] = []) {
  const entries: Entry[] = [
    ['general.architecture', 'string', 'gemma4'], ['general.name', 'string', 'Tiny'],
    ['tokenizer.ggml.model', 'string', 'gemma4'], ['tokenizer.ggml.pre', 'string', 'gemma4'],
    ['tokenizer.ggml.tokens', 'strings', gemmaTokens.map(([text]) => text)],
    ['tokenizer.ggml.token_type', 'i32s', gemmaTokens.map(([, type]) => type)],
    ['tokenizer.ggml.merges', 'strings', gemmaMerges],
    ['tokenizer.ggml.bos_token_id', 'u32', 2], ['tokenizer.ggml.eos_token_id', 'u32', 1],
    ['tokenizer.ggml.add_bos_token', 'bool', false], ['tokenizer.chat_template', 'string', '{{ messages }}'],
  ];
  for (const [key, type, value] of overrides) {
    const at = entries.findIndex(entry => entry[0] === key);
    if (at >= 0) entries[at] = [key, type, value]; else entries.push([key, type, value]);
  }
  return gguf(entries);
}
const tinyGemmaData = () => buildGemma(gemmaInput(parseGgufMetadata(gemmaFile()).metadata), { from: 'test' });
const tinyGemma = () => gemmaTokenizer(tinyGemmaData());

test('the GGUF reader reads the metadata and says how much more it needs', async () => {
  const bytes = gemmaFile([['general.name', 'string', '﻿Tiny ✓']]);
  const { metadata, length } = parseGgufMetadata(bytes);
  assert.equal(length, bytes.length - 64);
  assert.equal(metadata.get('general.name'), '﻿Tiny ✓', 'a leading U+FEFF is kept');
  assert.equal(metadata.get('tokenizer.ggml.bos_token_id'), 2);
  assert.equal(metadata.get('tokenizer.ggml.add_bos_token'), false);
  assert.deepEqual((metadata.get('tokenizer.ggml.token_type') as number[]).slice(0, 4), [CONTROL, CONTROL, CONTROL, UNKNOWN]);
  assert.throws(() => parseGgufMetadata(bytes.subarray(0, 100)), (error: unknown) => error instanceof NeedMore && error.bytes > 100);
  let reads = 0;
  const source = { name: 'tiny', async read(from: number, to: number) { reads++; return bytes.subarray(from, Math.min(to, bytes.length)); } };
  const read = await readGgufMetadata(source, 32);
  assert.equal(read.metadata.size, metadata.size);
  assert.ok(reads > 1, 'it read more than its first guess');
  await assert.rejects(readGgufMetadata({ name: 'short', read: async (from, to) => bytes.subarray(from, Math.min(to, 200)) }, 32),
    /ends inside its metadata/);
  assert.throws(() => parseGgufMetadata(new Uint8Array(Buffer.from('GGML' + '\0'.repeat(40)))), /Not a GGUF/);
});

test('Gemma: special tokens, BPE by rank, lines and runs of newlines, bytes for the rest', () => {
  const data = tinyGemmaData();
  assert.equal(data.addBos, true, 'llama.cpp adds the BOS to every Gemma 4 prompt, whatever the file says');
  assert.equal(data.bos, 2);
  // <turn|> is an end-of-generation text, so llama.cpp makes it a control token although the file calls it normal.
  assert.ok(data.special.some(token => token.text === '<turn|>' && !token.plain));
  assert.ok(data.special.some(token => token.text === '<|channel>' && token.plain));
  const gemma = gemmaTokenizer(data);
  assert.deepEqual(gemma.encode('abc'), [G.abc], 'a b goes first, then ab c');
  assert.deepEqual(gemma.encode('bcab'), [G.bc, G.ab], 'the lower rank first, wherever it is');
  assert.deepEqual(gemma.encode('aaa'), [G.aa, G.a], 'of equal ranks the leftmost');
  assert.deepEqual(gemma.encode('a b'), [G.a, G['▁b']], 'a space is U+2581, and a line is one word');
  assert.deepEqual(gemma.encode('é'), [byte(0xc3), byte(0xa9)], 'what the vocabulary lacks is its UTF-8 bytes');
  assert.deepEqual(gemma.encode('😀x'), [G['😀'], G.x], 'a token of one astral character');
  assert.deepEqual(gemma.encode('\n\n'), [G['\n\n']]);
  assert.deepEqual(gemma.encode('\n\n\n'), [G['\n\n'], G['\n']], 'a run that is not itself a token is merged');
  assert.deepEqual(gemma.encode('ab\n\nc'), [G.ab, G['\n\n'], G.c], 'no merge crosses a line');
  // The vocabulary has "﻿a" beside "a": a reader that dropped the BOM would have made them one text, and the build
  // refuses duplicates. No merge makes that token, so the BPE never reaches it.
  assert.deepEqual(gemma.encode('﻿a'), [byte(0xef), byte(0xbb), byte(0xbf), G.a]);
  assert.deepEqual(gemma.encode('\ud800'), [byte(0xef), byte(0xbf), byte(0xbd)], 'a lone surrogate is U+FFFD by the time it is UTF-8');
  assert.deepEqual(gemma.encode(''), []);
  // Control tokens only with parse_special; user-defined ones always.
  assert.deepEqual(gemma.encode('<|turn>ab', { special: true }), [G['<|turn>'], G.ab]);
  assert.deepEqual(gemma.encode('<|turn>ab'), [...Buffer.from('<|turn>')].map(byte).concat(G.ab));
  assert.deepEqual(gemma.encode('a<|channel>b'), [G.a, G['<|channel>'], G.b]);
  assert.deepEqual(gemma.encode('<turn|><channel|>', { special: true }), [G['<turn|>'], G['<channel|>']]);
  assert.equal(gemma.count('<|turn>abc<turn|>', { special: true }), 3);
});

test('Gemma: the cache changes nothing, however small', () => {
  const data = tinyGemmaData();
  const plain = gemmaTokenizer(data), tiny = gemmaTokenizer(data, { cacheChars: 8 });
  const texts = ['abc a b', 'bcab\n\naaa', 'é😀 x', 'abc a b', '<|turn>a b<turn|>\n', 'aaaaaaaaaaaaaaaaaaaaaaaaaa b'];
  for (let round = 0; round < 3; round++) {
    for (const text of texts) {
      assert.deepEqual(tiny.encode(text, { special: true }), plain.encode(text, { special: true }));
      assert.deepEqual(tiny.encode(text), plain.encode(text));
    }
  }
});

// llama.cpp's own way: every special token in turn, longest first, cut out of whatever text is still raw.
function sequentialCut(text: string, specials: { text: string; id: number }[]) {
  let fragments: (string | number)[] = [text];
  for (const special of specials) {
    fragments = fragments.flatMap(fragment => {
      if (typeof fragment === 'number') return [fragment];
      const out: (string | number)[] = [];
      let from = 0;
      for (let at = fragment.indexOf(special.text); at >= 0; at = fragment.indexOf(special.text, from)) {
        if (at > from) out.push(fragment.slice(from, at));
        out.push(special.id);
        from = at + special.text.length;
      }
      if (from < fragment.length) out.push(fragment.slice(from));
      return out;
    });
  }
  return fragments;
}

test('Gemma: finding special tokens left to right cuts the text as llama.cpp does', () => {
  const data = tinyGemmaData();
  const gemma = gemmaTokenizer(data);
  const pieces = ['a', 'b', 'c', ' ', '\n', '<', '|', '>', 'turn', 'channel', '<|turn>', '<turn|>', '<|channel>', '<channel|>', '<bos>', '<eos>', '<unk>', 'x'];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 2000; i++) {
    let text = '';
    for (let n = Math.floor(random() * 12); n >= 0; n--) text += pieces[Math.floor(random() * pieces.length)];
    const want = sequentialCut(text, data.special).flatMap(part => typeof part === 'number' ? [part] : gemma.encode(part));
    assert.deepEqual(gemma.encode(text, { special: true }), want, JSON.stringify(text));
  }
});

test('Gemma: the builder refuses what it does not reproduce', () => {
  const build = (overrides: Entry[]) => buildGemma(gemmaInput(parseGgufMetadata(gemmaFile(overrides)).metadata), {});
  const tokens = gemmaTokens.map(([text]) => text);
  assert.throws(() => build([['tokenizer.ggml.model', 'string', 'llama']]), /only gemma4/);
  assert.throws(() => build([['tokenizer.ggml.tokens', 'strings', tokens.map((text, id) => id === 270 ? 'a' : text)]]), /has the text of token/);
  // A control token whose tail is another's head: which one wins would depend on llama.cpp's unstable sort.
  assert.throws(() => build([['tokenizer.ggml.tokens', 'strings', tokens.map((text, id) => id === 0 ? '<bo' : id === 3 ? 'os>' : text)]]), /overlaps/);
  assert.throws(() => build([['tokenizer.ggml.tokens', 'strings', tokens.map((text, id) => id === 8 ? '<0x00' : text)]]), /byte token for 0/);
  assert.throws(() => build([['tokenizer.ggml.merges', 'strings', ['a q']]]), /not a token/);
  assert.throws(() => build([['general.name', 'string', 'Phi-3 mini']]), /strips spaces/);
});

// --- The chat template ---------------------------------------------------------------------------------------------

test('the Gemma 4 chat prompt the pinned llama-server builds for the bot', () => {
  assert.equal(gemmaChatPrompt([{ role: 'system', content: ' Be brief.\n' }, { role: 'user', content: 'Hi\t' }]),
    '<|turn>system\nBe brief.<turn|>\n<|turn>user\nHi<turn|>\n<|turn>model\n<|channel>thought\n<channel|>');
  // A model turn loses its thinking; trim is ASCII-only, as the template engine's is.
  assert.equal(gemmaChatPrompt([{ role: 'user', content: ' q ' }, { role: 'assistant', content: '<|channel>plan<channel|> Answer. ' },
    { role: 'user', content: 'More' }]),
  '<|turn>user\n q <turn|>\n<|turn>model\nAnswer.<turn|>\n<|turn>user\nMore<turn|>\n<|turn>model\n<|channel>thought\n<channel|>');
  // A trailing assistant message is continued after an empty thought, untrimmed.
  assert.equal(gemmaChatPrompt([{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Once upon ' }]),
    '<|turn>user\nGo<turn|>\n<|turn>model\n<|channel>thought\n<channel|>Once upon ');
  assert.equal(gemmaChatPrompt([{ role: 'assistant', content: 'x' }]), '<|channel>thought\n<channel|>x');
  assert.throws(() => gemmaChatPrompt([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }]),
    /two assistant messages/);
  assert.equal(gemmaChatPrompt([]), '<|turn>model\n<|channel>thought\n<channel|>');
});

test('gemmaChatTokens adds the BOS and wants the template it was written for', () => {
  const data = tinyGemmaData();
  const messages = [{ role: 'user' as const, content: 'abc' }];
  assert.throws(() => gemmaChatTokens(gemmaTokenizer(data), messages), /another chat template/);
  const gemma = gemmaTokenizer({ ...data, templateSha256: GEMMA_TEMPLATE_SHA256 });
  assert.equal(gemmaChatTokens(gemma, messages), 1 + gemma.count(gemmaChatPrompt(messages), { special: true }));
});

// --- A Qwen2 vocabulary: the 256 byte-level characters, a few merges, the added tokens at their real ids --------------

const QWEN_ADDED = ['<|endoftext|>', '<|im_start|>', '<|im_end|>', '<|object_ref_start|>', '<|object_ref_end|>', '<|box_start|>',
  '<|box_end|>', '<|quad_start|>', '<|quad_end|>', '<|vision_start|>', '<|vision_end|>', '<|vision_pad|>', '<|image_pad|>',
  '<|video_pad|>'];
function tinyQwenInput() {
  // Byte-level characters at ids 0..255, but "\n" (Ċ) at 198 as in the real vocabulary, so ComfyUI's check finds it.
  const alphabet = byteLevelAlphabet();
  const vocab: Record<string, number> = {};
  alphabet.forEach((char, value) => { vocab[char] = value === 10 ? 198 : value === 198 ? 10 : value; });
  let next = 256;
  const merges: string[] = [];
  const merge = (left: string, right: string, id?: number) => { merges.push(`${left} ${right}`); vocab[left + right] = id ?? next++; };
  merge('a', 'b'); merge('ab', 'c'); merge('Ġ', 'a'); merge("'", 's'); merge('Ċ', 'Ċ'); merge('u', 's'); merge('e', 'r');
  merge('us', 'er', 872);
  // Fill the vocabulary up to where the added tokens start, as in the real one.
  const used = new Set(Object.values(vocab));
  for (let id = 0; id < 151643; id++) if (!used.has(id)) vocab[`\u{F0000}${id}`] = id;
  const config = {
    added_tokens_decoder: Object.fromEntries(QWEN_ADDED.map((content, index) => [String(151643 + index),
      { content, lstrip: false, rstrip: false, normalized: false, single_word: false, special: true }])),
  };
  return { vocab, merges: '#version: 0.2\n' + merges.join('\n') + '\n', config };
}
let tinyQwenCache: QwenData | undefined;
const tinyQwenData = () => tinyQwenCache ??= buildQwen(tinyQwenInput(), { from: 'test' });
const Q = { ab: 256, abc: 257, "'s": 259, 'ĊĊ': 260, user: 872, nl: 198, space: 32 };
const IM_START = 151644, IM_END = 151645, VISION_START = 151652, VISION_END = 151653, IMAGE_PAD = 151655;
const bytesOf = (text: string) => [...Buffer.from(text, 'utf8')].map(value => value === 10 ? 198 : value === 198 ? 10 : value);

test('Qwen: added tokens first, NFC, the Qwen2 split, GPT-2 bytes, BPE', () => {
  const qwen = qwenTokenizer(tinyQwenData());
  assert.deepEqual(qwen.encode('abc'), [Q.abc]);
  assert.deepEqual(qwen.encode(' ab'), [Q.space, Q.ab], 'a b ranks before Ġ a');
  assert.deepEqual(qwen.encode('ab ab'), [Q.ab, Q.space, Q.ab]);
  assert.deepEqual(qwen.encode("it's"), [105, 116, Q["'s"]], 'a contraction is a piece of its own');
  assert.deepEqual(qwen.encode("IT'Ss"), [73, 84, 39, 83, 115], "'S is one, 'Ss is not two pieces");
  assert.deepEqual(qwen.encode('123'), [49, 50, 51], 'every digit alone');
  assert.deepEqual(qwen.encode('\n\n'), [Q['ĊĊ']]);
  assert.deepEqual(qwen.encode('a  b'), [97, Q.space, Q.space, 98], 'the last space of a run goes with the word');
  assert.deepEqual(qwen.encode('é'), qwen.encode('é'), 'NFC');
  assert.deepEqual(qwen.encode('<|im_start|>user\n<|im_end|>'), [IM_START, Q.user, Q.nl, IM_END]);
  assert.deepEqual(qwen.encode('<|im_start'), bytesOf('<|im_start'), 'a near miss is text');
  assert.deepEqual(qwen.encode('\u0085'), bytesOf('\u0085'));
  assert.equal(qwen.count('<|image_pad|><|image_pad|>'), 2);
});

test('Qwen: the builder takes merges.txt as Hugging Face does and refuses what it does not reproduce', () => {
  const input = tinyQwenInput();
  assert.throws(() => buildQwen({ ...input, merges: 'a b c\n' }, {}), /not two tokens/);
  assert.throws(() => buildQwen({ ...input, merges: 'a b\na b\n' }, {}), /twice/);
  assert.throws(() => buildQwen({ ...input, merges: 'q z\n' }, {}), /not in vocab.json/);
  assert.throws(() => buildQwen({ ...input, config: { ...input.config, split_special_tokens: true } }, {}), /not reproduced/);
  const stripping = { '151643': { content: '<|endoftext|>', lstrip: true } };
  assert.throws(() => buildQwen({ ...input, config: { added_tokens_decoder: stripping } }, {}), /not reproduced/);
  assert.equal(buildQwen({ ...input, merges: input.merges.replaceAll('\n', '\r\n') }, {}).merges, tinyQwenData().merges);
});

// --- ComfyUI's picture prompts -------------------------------------------------------------------------------------

test('ComfyUI: the template, its escapes and embeddings, and the span each encoder keeps', () => {
  const qwen = qwenTokenizer(tinyQwenData());
  const [head, tail] = COMFY_TEMPLATES.qwen_image.split('{}');
  assert.deepEqual(comfyTokens(qwen, 'abc', 'qwen_image'), qwen.encode(head + 'abc' + tail));
  // "\(" loses its backslash; "embedding:name" loses the name, since the card has no embeddings.
  // The rest of the words after the name are joined by single spaces, the template's tail among them.
  assert.deepEqual(comfyTokens(qwen, 'x \\(ab\\) embedding:foo abc', 'qwen_image'),
    [...qwen.encode(head + 'x (ab) '), ...qwen.encode('abc<|im_end|> <|im_start|>assistant')]);
  // Python keeps name[len(name.strip(',')):] of a name with commas: the comma after it, or a letter when it led.
  assert.deepEqual(comfyTokens(qwen, '<|im_start|>a embedding:foo, abc', 'krea2'), [...qwen.encode('<|im_start|>a '), ...qwen.encode(', abc')]);
  assert.deepEqual(comfyTokens(qwen, '<|im_start|>a embedding:,foo x', 'krea2'), [...qwen.encode('<|im_start|>a '), ...qwen.encode('o x')]);
  assert.deepEqual(comfyTokens(qwen, '<|im_start|>a embedding:foo[b] c', 'krea2'), [...qwen.encode('<|im_start|>a '), ...qwen.encode('[b] c')]);
  // A prompt that starts with <|im_start|> is its own template.
  assert.deepEqual(comfyTokens(qwen, '<|im_start|>user\nab', 'krea2'), [IM_START, Q.user, Q.nl, Q.ab]);
  assert.throws(() => comfyTokens(qwen, '<|im_start|>ab embedding:', 'krea2'), /ComfyUI fails/);
  assert.equal(qwenPromptTokens(qwen, 'ab embedding:', 'qwen_image').prompt, qwen.count('ab '));

  // Qwen-Image 2.1 keeps everything from the second <|im_start|>: "<|im_start|>user\n", the prompt, and
  // "<|im_end|>\n<|im_start|>assistant\n" (13 tokens here, "assistant" being nine bytes).
  const after = 1 + 1 + 1 + 9 + 1;
  assert.deepEqual(qwenPromptTokens(qwen, 'abc', 'qwen_image'), { prompt: 1, conditioning: 3 + 1 + after });
  // TextEncodeQwenImage21 sends an empty prompt as one space; CLIPTextEncode for Krea 2 sends it as it is.
  assert.deepEqual(qwenPromptTokens(qwen, '', 'qwen_image'), { prompt: 1, conditioning: 3 + 1 + after });
  assert.deepEqual(qwenPromptTokens(qwen, '', 'krea2'), { prompt: 0, conditioning: after });
  // Krea 2 keeps what follows "<|im_start|>user\n".
  assert.deepEqual(qwenPromptTokens(qwen, 'abc', 'krea2'), { prompt: 1, conditioning: 1 + after });
  // ... and when the prompt's first newline merges with the template's, "user" and "\n" stay.
  assert.deepEqual(qwenPromptTokens(qwen, '\nabc', 'krea2'), { prompt: 2, conditioning: 4 + after });
  // Reference pictures: "<imageN>" and a vision block each, the picture's own embeddings dropped from the span.
  const one = qwenPromptTokens(qwen, 'abc', 'qwen_image', { images: 1 }).conditioning;
  const two = qwenPromptTokens(qwen, 'abc', 'qwen_image', { images: 2 }).conditioning;
  assert.equal(one, 3 + 1 + after + qwen.count('<image1>') + 2);
  assert.equal(two, one + qwen.count(' <image2>') + 2);
  assert.deepEqual(comfyTokens(qwen, 'abc', 'qwen_image', { images: 1 }).filter(id => [VISION_START, IMAGE_PAD, VISION_END].includes(id)),
    [VISION_START, IMAGE_PAD, VISION_END]);
  assert.throws(() => comfyTokens(qwen, 'abc', 'krea2', { images: 1 }), /qwen_image only/);
});

// --- Files ---------------------------------------------------------------------------------------------------------

test('loadTokenizers reads a file when asked and answers undefined for a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokenizers-'));
  try {
    const tokenizers = loadTokenizers(dir);
    assert.equal(tokenizers.gemma(), undefined);
    writeFileSync(join(dir, GEMMA_FILE), gzipSync(JSON.stringify(tinyGemmaData())));
    assert.deepEqual(tokenizers.gemma()?.encode('abc'), [G.abc], 'looked for again after a miss');
    assert.equal(tokenizers.gemma(), tokenizers.gemma(), 'read once');
    assert.equal(tokenizers.qwen(), undefined);
    writeFileSync(join(dir, QWEN_FILE), gzipSync(JSON.stringify({ format: 'something else' })));
    assert.throws(() => tokenizers.qwen(), /is not a simple-chat-tokenizer/);
    const broken: GemmaData = { ...tinyGemmaData(), merges: int32Base64([1, 2]) };
    assert.throws(() => gemmaTokenizer(broken), /not triples/);
    assert.throws(() => gemmaTokenizer({ ...tinyGemmaData(), format: 'x' } as unknown as GemmaData), new RegExp(TOKENIZER_FORMAT));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real vocabularies, when `npm run tokenizers` has written them: the ids the pinned servers gave for the probe.
const ROOT_TOKENIZERS = resolve('tokenizers');
for (const [file, kind] of [[GEMMA_FILE, 'gemma'], [QWEN_FILE, 'qwen']] as const) {
  const present = existsSync(join(ROOT_TOKENIZERS, file));
  test(`tokenizers/${file} gives the servers' ids for local/tokenizer-probe.json`, { skip: !present && `no tokenizers/${file}; npm run tokenizers writes it` }, () => {
    const tokenizers = loadTokenizers(ROOT_TOKENIZERS);
    const failures = kind === 'gemma' ? probeFailures(readProbe(), tokenizers.gemma()) : probeFailures(readProbe(), undefined, tokenizers.qwen());
    assert.deepEqual(failures, []);
  });
}
