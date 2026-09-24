# Token counts

`local/tokenizer.ts` counts tokens the way the two servers do, without asking them: Gemma 4 as the llama-server of
[manifest.env](../gpu/manifest.env) tokenizes it, and the Qwen2 tokenizer that both picture text encoders of
[image-manifest.env](../gpu/image-manifest.env) read (ComfyUI 0.37, `comfy/text_encoders/qwen25_tokenizer`, through
transformers' `Qwen2Tokenizer`). It is pure TypeScript with no dependencies. The vocabularies are not in the
repository; without them `loadTokenizers` answers `undefined` and the bot keeps its estimate.

- `gemmaChatTokens(gemma, messages)` is the number llama-server reports as `prompt_tokens` for the bot's request
  (`local/llama.ts`: jinja, no tools, `enable_thinking: false`), BOS included. Pass the messages exactly as they go
  into the body. `gemma.encode(text, { special })` is `/tokenize` with `add_special: false`.
- `qwenPromptTokens(qwen, prompt, 'qwen_image' | 'krea2', { images })` gives `prompt`, the prompt's own tokens, and
  `conditioning`, the span of the encoder's output the picture model is conditioned on. `comfyTokens` is the whole
  sequence the encoder runs over. `images` is the number of reference pictures of the edit graph.

## The files

`npm run tokenizers` writes two gzipped JSON files to `tokenizers/` (gitignored):

| File | Size | From |
|---|---|---|
| `gemma-4.json.gz` | 3.6 MB | The metadata of the pinned GGUF: 262144 tokens, their types, 514k merges, the chat template's SHA-256. |
| `qwen-2.5.json.gz` | 1.0 MB | `vocab.json`, `merges.txt` and `tokenizer_config.json` of ComfyUI at `COMFYUI_REVISION`. |

Each file holds the merges as triples of token ids, the byte tokens, the tokens cut out before BPE and a `source`
object with the pin it came from. The format is `simple-chat-tokenizer/1`, described at the top of the runtime.

By default the script reads the first 16 MB of the 25 GB GGUF from Hugging Face with Range requests, after checking
that Hugging Face gives the file the SHA-256 and size of `manifest.env`. It fetches the Qwen files from
raw.githubusercontent.com and checks them against `QWEN_TOKENIZER_*_SHA256` in `image-manifest.env`. From local copies:

```sh
npm run tokenizers -- --gemma /path/to/gemma-4-31B-it-uncensored-heretic-Q6_K.gguf --qwen /path/to/qwen25_tokenizer
npm run tokenizers -- --only qwen --out /tmp/tokenizers
```

A GGUF whose chat template differs from the one `gemmaChatPrompt` reproduces (`GEMMA_TEMPLATE_SHA256`) is refused.
A new file replaces the old one only after it gives the ids in `local/tokenizer-probe.json`. Those ids came from the live
servers on the rented cards (llama-server `/tokenize` and `/v1/chat/completions/input_tokens`, ComfyUI's tokenizer
classes). Do not regenerate them with this code.

## When the counts are exact

For the pinned llama.cpp revision, GGUF and ComfyUI revision. A change to any of them means extracting again, and if
the probe then fails, finding out why.

- Gemma: the chat prompt follows the Gemma 4 template of the GGUF as llama.cpp's jinja engine renders it for the bot's
  request. A trailing assistant message is continued after an empty thought, as llama-server does with
  `prefill_assistant` on. That case comes from the source and was not checked on the card. Two trailing assistant
  messages are an error there and here.
- Qwen: an empty prompt goes to Qwen-Image 2.1 as one space (`TextEncodeQwenImage21` asks for that) and to Krea 2 as
  it is. The card has no textual embeddings, so `embedding:name` loses the name. A prompt that starts with
  `<|im_start|>` is used without the template. The negative prompt is encoded apart and counts the same way.
- Unicode: NFC and the letter and number classes come from Node's ICU, the servers use their own tables. They agree on
  every string tested. A character newer than one of those tables could split differently.
- A lone surrogate is counted as U+FFFD. Both servers refuse a request that contains one.

## Checking a running server

`gemma.encode(text, { special: true })` must equal what `POST /tokenize` returns for
`{"content": text, "add_special": false, "parse_special": true}`. A few strings from the probe are enough to show that
the server has this vocabulary. The same strings with `parse_special: false` should match `gemma.encode(text)`.
`GET /props` gives the `chat_template`, whose SHA-256 must be `GEMMA_TEMPLATE_SHA256`.

## How it was checked

- 1099 synthetic strings (15 synthetic texts in five languages, their paragraphs, picture prompts, edge cases): the
  same ids as the card's llama-server with and without `parse_special`, and as transformers 5.17 and ComfyUI's
  `QwenImage21Tokenizer` and `Krea2Tokenizer` on the card.
- 8 chats, 16 to 5779 tokens: the same rendered prompt, the same ids, and a count equal to `input_tokens`.
- 170,080 random strings against libllama at the pinned revision, about 16.7 million tokens, in both modes.
- 10,014 random strings, some with reference pictures, against transformers 5.17 and ComfyUI's tokenizer classes
  loaded from the pinned sources: the same ids, sequences and kept spans.
