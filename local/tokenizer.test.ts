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
import type { ChatMessage, GemmaData, PictureEncoder } from './tokenizer.ts';
import {
  NeedMore, buildGemma, buildQwen, byteLevelAlphabet, gemmaInput, parseGgufMetadata, probeFailures, readGgufMetadata,
  readProbe,
} from './tokenizer-extract.ts';
import type { GgufValue, QwenInput } from './tokenizer-extract.ts';

// --- A GGUF written by hand ----------------------------------------------------------------------------------------

type Entry = [string, 'string' | 'u32' | 'bool' | 'strings' | 'i32s', GgufValue];
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
  // An override takes the place of the entry with its key, or comes last.
  return gguf([...new Map([...entries, ...overrides].map(entry => [entry[0], entry])).values()]);
}
const tinyGemmaData = () => buildGemma(gemmaInput(parseGgufMetadata(gemmaFile()).metadata), { from: 'test' });

test('Gemma: special tokens, BPE by rank, lines and runs of newlines, bytes for the rest; the GGUF they come from, the builder\'s refusals and the chat prompt', async () => {
  // The GGUF reader reads the metadata and says how much more it needs.
  const bytes = gemmaFile([['general.name', 'string', '﻿Tiny ✓']]);
  const { metadata, length } = parseGgufMetadata(bytes);
  assert.deepEqual([length, ...['general.name', 'tokenizer.ggml.bos_token_id', 'tokenizer.ggml.add_bos_token'].map(key => metadata.get(key)),
    (metadata.get('tokenizer.ggml.token_type') as number[]).slice(0, 4)], [bytes.length - 64, '﻿Tiny ✓', 2, false, [CONTROL, CONTROL, CONTROL, UNKNOWN]],
  'the metadata, a leading U+FEFF kept');
  assert.throws(() => parseGgufMetadata(bytes.subarray(0, 100)), (error: unknown) => error instanceof NeedMore && error.bytes > 100);
  let reads = 0;
  const source = { name: 'tiny', async read(from: number, to: number) { reads++; return bytes.subarray(from, Math.min(to, bytes.length)); } };
  assert.equal((await readGgufMetadata(source, 32)).metadata.size, metadata.size);
  assert.ok(reads > 1, 'it read more than its first guess');
  await assert.rejects(readGgufMetadata({ name: 'short', read: async (from, to) => bytes.subarray(from, Math.min(to, 200)) }, 32), /ends inside its metadata/);
  assert.throws(() => parseGgufMetadata(new Uint8Array(Buffer.from('GGML' + '\0'.repeat(40)))), /Not a GGUF/);
  // llama.cpp adds the BOS to every Gemma 4 prompt, whatever the file says. <turn|> is an end-of-generation text, so it
  // makes that a control token although the file calls it normal.
  const data = tinyGemmaData(), gemma = gemmaTokenizer(data);
  assert.deepEqual([data.addBos, data.bos, ...['<turn|>', '<|channel>'].map(text => data.special.find(token => token.text === text)?.plain)], [true, 2, false, true]);
  const encodings: [string, string, number[], boolean?][] = [
    ['a b goes first, then ab c', 'abc', [G.abc]], ['the lower rank first, wherever it is', 'bcab', [G.bc, G.ab]], ['of equal ranks the leftmost', 'aaa', [G.aa, G.a]],
    ['a space is U+2581, and a line is one word', 'a b', [G.a, G['▁b']]], ['what the vocabulary lacks is its UTF-8 bytes', 'é', [byte(0xc3), byte(0xa9)]],
    ['a token of one astral character', '😀x', [G['😀'], G.x]], ['a run of newlines that is a token', '\n\n', [G['\n\n']]], ['nothing', '', []],
    ['a run that is not itself a token is merged', '\n\n\n', [G['\n\n'], G['\n']]], ['no merge crosses a line', 'ab\n\nc', [G.ab, G['\n\n'], G.c]],
    // The vocabulary has "﻿a" beside "a": a reader that dropped the BOM would have made them one text, and the build
    // refuses duplicates. No merge makes that token, so the BPE never reaches it.
    ['a BOM before a', '﻿a', [byte(0xef), byte(0xbb), byte(0xbf), G.a]],
    ['a lone surrogate is U+FFFD by the time it is UTF-8', '\ud800', [byte(0xef), byte(0xbf), byte(0xbd)]],
    // Control tokens only with parse_special; user-defined ones always.
    ['a control token with parse_special', '<|turn>ab', [G['<|turn>'], G.ab], true], ['a control token without', '<|turn>ab', [...Buffer.from('<|turn>')].map(byte).concat(G.ab)],
    ['a user-defined token', 'a<|channel>b', [G.a, G['<|channel>'], G.b]], ['two ends', '<turn|><channel|>', [G['<turn|>'], G['<channel|>']], true],
  ];
  for (const [label, text, ids, special] of encodings) assert.deepEqual(gemma.encode(text, { special }), ids, label);
  assert.equal(gemma.count('<|turn>abc<turn|>', { special: true }), 3);
  // The cache changes nothing, however small.
  const cached = gemmaTokenizer(data, { cacheChars: 8 }), texts = ['abc a b', 'bcab\n\naaa', 'é😀 x', 'abc a b', '<|turn>a b<turn|>\n', 'a'.repeat(26) + ' b'];
  for (const text of [...texts, ...texts, ...texts]) {
    for (const special of [true, false]) assert.deepEqual(cached.encode(text, { special }), gemma.encode(text, { special }), `the cache: ${JSON.stringify(text)}`);
  }

  // Finding special tokens left to right cuts the text as llama.cpp does, which takes every special token in turn,
  // longest first, and cuts it out of whatever text is still raw.
  const sequentialCut = (text: string) => data.special.reduce<(string | number)[]>((fragments, special) => fragments.flatMap(fragment => typeof fragment === 'number'
    ? [fragment] : fragment.split(special.text).flatMap((part, at) => at ? [special.id, part] : [part]).filter(part => part !== '')), [text]);
  const pieces = ['a', 'b', 'c', ' ', '\n', '<', '|', '>', 'turn', 'channel', '<|turn>', '<turn|>', '<|channel>', '<channel|>', '<bos>', '<eos>', '<unk>', 'x'];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 2000; i++) {
    let text = '';
    for (let n = Math.floor(random() * 12); n >= 0; n--) text += pieces[Math.floor(random() * pieces.length)];
    assert.deepEqual(gemma.encode(text, { special: true }), sequentialCut(text).flatMap(part => typeof part === 'number' ? [part] : gemma.encode(part)), JSON.stringify(text));
  }

  // The builder refuses what it does not reproduce.
  const named = (names: Record<number, string | undefined>): Entry => ['tokenizer.ggml.tokens', 'strings', gemmaTokens.map(([text], id) => names[id] ?? text)];
  const refusals: [RegExp, Entry][] = [
    [/only gemma4/, ['tokenizer.ggml.model', 'string', 'llama']], [/has the text of token/, named({ 270: 'a' })],
    // A control token whose tail is another's head: which one wins would depend on llama.cpp's unstable sort.
    [/overlaps/, named({ 0: '<bo', 3: 'os>' })], [/byte token for 0/, named({ 8: '<0x00' })],
    [/not a token/, ['tokenizer.ggml.merges', 'strings', ['a q']]], [/strips spaces/, ['general.name', 'string', 'Phi-3 mini']],
  ];
  for (const [refusal, entry] of refusals) assert.throws(() => buildGemma(gemmaInput(parseGgufMetadata(gemmaFile([entry])).metadata), {}), refusal, refusal.source);

  // The Gemma 4 chat prompt the pinned llama-server builds for the bot.
  const model = '<|turn>model\n<|channel>thought\n<channel|>';
  const prompts: [string, ChatMessage[], string][] = [
    ['a system prompt, trimmed', [{ role: 'system', content: ' Be brief.\n' }, { role: 'user', content: 'Hi\t' }], `<|turn>system\nBe brief.<turn|>\n<|turn>user\nHi<turn|>\n${model}`],
    // A model turn loses its thinking; trim is ASCII-only, as the template engine's is.
    ['a model turn', [{ role: 'user', content: ' q ' }, { role: 'assistant', content: '<|channel>plan<channel|> Answer. ' }, { role: 'user', content: 'More' }],
      `<|turn>user\n q <turn|>\n<|turn>model\nAnswer.<turn|>\n<|turn>user\nMore<turn|>\n${model}`],
    // A trailing assistant message is continued after an empty thought, untrimmed.
    ['a trailing assistant message', [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Once upon ' }], `<|turn>user\nGo<turn|>\n${model}Once upon `],
    ['an assistant message alone', [{ role: 'assistant', content: 'x' }], '<|channel>thought\n<channel|>x'], ['no messages', [], model],
  ];
  for (const [label, messages, prompt] of prompts) assert.equal(gemmaChatPrompt(messages), prompt, label);
  assert.throws(() => gemmaChatPrompt([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'assistant', content: 'c' }]), /two assistant messages/);
  // gemmaChatTokens adds the BOS and wants the template it was written for.
  const messages: ChatMessage[] = [{ role: 'user', content: 'abc' }], pinned = gemmaTokenizer({ ...data, templateSha256: GEMMA_TEMPLATE_SHA256 });
  assert.throws(() => gemmaChatTokens(gemma, messages), /another chat template/);
  assert.equal(gemmaChatTokens(pinned, messages), 1 + pinned.count(gemmaChatPrompt(messages), { special: true }));
});

// --- A Qwen2 vocabulary: the 256 byte-level characters, a few merges, the added tokens at their real ids --------------

const QWEN_ADDED = ['<|endoftext|>', '<|im_start|>', '<|im_end|>', '<|object_ref_start|>', '<|object_ref_end|>', '<|box_start|>', '<|box_end|>',
  '<|quad_start|>', '<|quad_end|>', '<|vision_start|>', '<|vision_end|>', '<|vision_pad|>', '<|image_pad|>', '<|video_pad|>'];
// Byte-level characters at ids 0..255, but "\n" (Ċ) at 198 as in the real vocabulary, so ComfyUI's check finds it.
const swap = (value: number) => value === 10 ? 198 : value === 198 ? 10 : value;
function tinyQwenInput() {
  const vocab: Record<string, number> = Object.fromEntries(byteLevelAlphabet().map((char, value) => [char, swap(value)]));
  const merges: [string, string, number?][] = [['a', 'b'], ['ab', 'c'], ['Ġ', 'a'], ["'", 's'], ['Ċ', 'Ċ'], ['u', 's'], ['e', 'r'], ['us', 'er', 872]];
  merges.forEach(([left, right, id], index) => { vocab[left + right] = id ?? 256 + index; });
  // Fill the vocabulary up to where the added tokens start, as in the real one.
  const used = new Set(Object.values(vocab));
  for (let id = 0; id < 151643; id++) if (!used.has(id)) vocab[`\u{F0000}${id}`] = id;
  const added_tokens_decoder = Object.fromEntries(QWEN_ADDED.map((content, index) => [String(151643 + index),
    { content, lstrip: false, rstrip: false, normalized: false, single_word: false, special: true }]));
  return { vocab, merges: '#version: 0.2\n' + merges.map(([left, right]) => `${left} ${right}\n`).join(''), config: { added_tokens_decoder } };
}
const Q = { ab: 256, abc: 257, "'s": 259, 'ĊĊ': 260, user: 872, nl: 198, space: 32 };
const IM_START = 151644, IM_END = 151645, VISION_START = 151652, VISION_END = 151653, IMAGE_PAD = 151655;
const bytesOf = (text: string) => [...Buffer.from(text, 'utf8')].map(swap);

test('Qwen: added tokens first, NFC, the Qwen2 split, GPT-2 bytes, BPE; the builder\'s refusals, ComfyUI\'s prompts and spans, and a file read when asked', t => {
  const input = tinyQwenInput(), data = buildQwen(input, { from: 'test' }), qwen = qwenTokenizer(data);
  const encodings: [string, string, number[]][] = [
    ['two merges', 'abc', [Q.abc]], ['a b ranks before Ġ a', ' ab', [Q.space, Q.ab]], ['two words', 'ab ab', [Q.ab, Q.space, Q.ab]],
    ['a contraction is a piece of its own', "it's", [105, 116, Q["'s"]]], ["'S is one, 'Ss is not two pieces", "IT'Ss", [73, 84, 39, 83, 115]],
    ['every digit alone', '123', [49, 50, 51]], ['two newlines', '\n\n', [Q['ĊĊ']]], ['the last space of a run goes with the word', 'a  b', [97, Q.space, Q.space, 98]],
    ['NFC', 'é', qwen.encode('é')], ['added tokens first', '<|im_start|>user\n<|im_end|>', [IM_START, Q.user, Q.nl, IM_END]],
    ['a near miss is text', '<|im_start', bytesOf('<|im_start')], ['U+0085', '\u0085', bytesOf('\u0085')],
  ];
  for (const [label, text, ids] of encodings) assert.deepEqual(qwen.encode(text), ids, label);
  assert.equal(qwen.count('<|image_pad|><|image_pad|>'), 2);
  // The builder takes merges.txt as Hugging Face does and refuses what it does not reproduce.
  const refusals: [string, Partial<QwenInput>, RegExp][] = [
    ['a merge of three', { merges: 'a b c\n' }, /not two tokens/], ['a merge twice', { merges: 'a b\na b\n' }, /twice/],
    ['a merge vocab.json lacks', { merges: 'q z\n' }, /not in vocab.json/], ['split_special_tokens', { config: { ...input.config, split_special_tokens: true } }, /not reproduced/],
    ['an added token that strips', { config: { added_tokens_decoder: { '151643': { content: '<|endoftext|>', lstrip: true } } } }, /not reproduced/],
  ];
  for (const [label, change, refusal] of refusals) assert.throws(() => buildQwen({ ...input, ...change }, {}), refusal, label);
  assert.equal(buildQwen({ ...input, merges: input.merges.replaceAll('\n', '\r\n') }, {}).merges, data.merges, 'CRLF');

  // ComfyUI: the template, its escapes and embeddings.
  const [head, tail] = COMFY_TEMPLATES.qwen_image.split('{}');
  const comfy: [string, string, PictureEncoder, number[]][] = [
    ['the template', 'abc', 'qwen_image', qwen.encode(head + 'abc' + tail)],
    // "\(" loses its backslash; "embedding:name" loses the name, since the card has no embeddings.
    // The rest of the words after the name are joined by single spaces, the template's tail among them.
    ['escapes and an embedding', 'x \\(ab\\) embedding:foo abc', 'qwen_image', [...qwen.encode(head + 'x (ab) '), ...qwen.encode('abc<|im_end|> <|im_start|>assistant')]],
    // Python keeps name[len(name.strip(',')):] of a name with commas: the comma after it, or a letter when it led.
    ['a comma after the name', '<|im_start|>a embedding:foo, abc', 'krea2', [...qwen.encode('<|im_start|>a '), ...qwen.encode(', abc')]],
    ['a comma before the name', '<|im_start|>a embedding:,foo x', 'krea2', [...qwen.encode('<|im_start|>a '), ...qwen.encode('o x')]],
    ['a bracket after the name', '<|im_start|>a embedding:foo[b] c', 'krea2', [...qwen.encode('<|im_start|>a '), ...qwen.encode('[b] c')]],
    // A prompt that starts with <|im_start|> is its own template.
    ['its own template', '<|im_start|>user\nab', 'krea2', [IM_START, Q.user, Q.nl, Q.ab]],
  ];
  for (const [label, prompt, encoder, ids] of comfy) assert.deepEqual(comfyTokens(qwen, prompt, encoder), ids, label);
  assert.throws(() => comfyTokens(qwen, '<|im_start|>ab embedding:', 'krea2'), /ComfyUI fails/);
  assert.equal(qwenPromptTokens(qwen, 'ab embedding:', 'qwen_image').prompt, qwen.count('ab '));
  // The span each encoder keeps. Qwen-Image 2.1 keeps everything from the second <|im_start|>: "<|im_start|>user\n",
  // the prompt, and "<|im_end|>\n<|im_start|>assistant\n" (13 tokens here, "assistant" being nine bytes).
  // TextEncodeQwenImage21 sends an empty prompt as one space; CLIPTextEncode for Krea 2 sends it as it is. Krea 2 keeps
  // what follows "<|im_start|>user\n", and when the prompt's first newline merges with the template's, "user" and "\n" stay.
  const after = 1 + 1 + 1 + 9 + 1;
  const spans: [string, string, PictureEncoder, number, number][] = [
    ['Qwen-Image 2.1', 'abc', 'qwen_image', 1, 3 + 1 + after], ['an empty prompt to Qwen-Image 2.1', '', 'qwen_image', 1, 3 + 1 + after],
    ['an empty prompt to Krea 2', '', 'krea2', 0, after], ['Krea 2', 'abc', 'krea2', 1, 1 + after], ['a first newline to Krea 2', '\nabc', 'krea2', 2, 4 + after],
  ];
  for (const [label, prompt, encoder, count, conditioning] of spans) assert.deepEqual(qwenPromptTokens(qwen, prompt, encoder), { prompt: count, conditioning }, label);
  // Reference pictures: "<imageN>" and a vision block each, the picture's own embeddings dropped from the span.
  const [one, two] = [1, 2].map(images => qwenPromptTokens(qwen, 'abc', 'qwen_image', { images }).conditioning);
  assert.equal(one, 3 + 1 + after + qwen.count('<image1>') + 2);
  assert.equal(two, one + qwen.count(' <image2>') + 2);
  assert.deepEqual(comfyTokens(qwen, 'abc', 'qwen_image', { images: 1 }).filter(id => [VISION_START, IMAGE_PAD, VISION_END].includes(id)),
    [VISION_START, IMAGE_PAD, VISION_END]);
  assert.throws(() => comfyTokens(qwen, 'abc', 'krea2', { images: 1 }), /qwen_image only/);

  // loadTokenizers reads a file when asked and answers undefined for a missing one: no tokenizer, never a count of 0.
  const dir = mkdtempSync(join(tmpdir(), 'tokenizers-')), tokenizers = loadTokenizers(dir), gemmaData = tinyGemmaData();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual([tokenizers.gemma(), tokenizers.qwen()], [undefined, undefined], 'no file, no tokenizer');
  writeFileSync(join(dir, GEMMA_FILE), gzipSync(JSON.stringify(gemmaData)));
  writeFileSync(join(dir, QWEN_FILE), gzipSync(JSON.stringify({ format: 'something else' })));
  assert.deepEqual(tokenizers.gemma()?.encode('abc'), [G.abc], 'looked for again after a miss');
  assert.equal(tokenizers.gemma(), tokenizers.gemma(), 'read once');
  assert.throws(() => tokenizers.qwen(), /is not a simple-chat-tokenizer/);
  assert.throws(() => gemmaTokenizer({ ...gemmaData, merges: int32Base64([1, 2]) }), /not triples/);
  assert.throws(() => gemmaTokenizer({ ...gemmaData, format: 'x' } as unknown as GemmaData), new RegExp(TOKENIZER_FORMAT));
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
