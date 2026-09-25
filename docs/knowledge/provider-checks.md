# Provider checks

Dated checks of the model connections and of the providers' terms, 2026-09-17 to 2026-09-24. They were moved here on
2026-09-25 from [model-providers.md](../model-providers.md), [improve-loop.md](../improve-loop.md) and
[tokenizers.md](../tokenizers.md) as they were written, apart from headings, anchors and link addresses. Each one is
what that version did on that day, not a statement about today. A new check gets a new dated section instead of an
edit to an old one. The contracts in force are in [model-providers.md](../model-providers.md).

Each section says what ran live and what only against a fake. simple-serving has met its contract's shared cases and
the real gateway in front of a fake engine, never vLLM: see
[its section](../model-providers.md#simple-serving-our-gateway).

<a id='claude-cli-2026-09-17'></a>

## Claude Code, 2026-09-17

Updated 17 September 2026: one generation interface, separate adapters for different ways of calling a model. `claude-code` and `llama-cpp` are implemented. Haiku was checked with a short live call; Gemma Q4_K_M and Q6_K were run on an RTX 5090, including a synthetic input of about 59K tokens. [GPU setup and measurements](gpu-measurements.md#verified-2026-09-17). The direct `anthropic-api` adapter is not implemented yet.

Claude Code with a subscription was chosen for the first run.

In the installed Claude Code 2.1.273 the flags `--tools ""`, `--safe-mode`, `--strict-mcp-config` and `--no-session-persistence` were checked. They make it possible to turn off the built-in tools, user settings and extensions, to connect no MCP, and to not save the Claude session. In the implementation we explicitly pass an empty MCP configuration and check the tool list in the `system/init` event. We do not use `--bare` with a subscription: this mode turns off OAuth and requires a separate API authorization.

A subscription connection uses the supported authorization of the specific CLI/SDK. The checked Anthropic page has a clarification: the announced move to separate credits is paused; the Agent SDK and `claude -p`, when authorized through a subscription, continue to use its limits. An API key means a different way of paying. [Anthropic terms](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

We do the initial probe ourselves on Claude Haiku 4.5: one seed and several continuations, a check of the cycle "seed → scene → message → continuation", of streaming output and of saving the dialog. The API identifier is `claude-haiku-4-5-20251001`. [Anthropic models](https://platform.claude.com/docs/en/models/overview).

After our run, the tester checks stories more deeply on Gemma 4 Uncensored. For the GPU, the dense build 31B Heretic Q6_K is used, fixed in the [manifest](../../gpu/manifest.env). Capacity was checked separately from memory quality. The tester reports problems themselves; we do not read their correspondence and do not export it for debugging. The adapters do not write the text of requests, of responses or of raw provider errors to the technical logs. [Tester privacy rules](../../README.md#privacy).

<a id='codex-cli-2026-09-19'></a>

## Codex CLI, 2026-09-19

Checked on 19 September 2026: the set of arguments is accepted by CLI 0.154.0 under `--strict-config`, the key `model_instructions_file` exists. A successful response was not checked live: on that day the account hit the usage limit (`turn.failed`). The format of successful events is taken from the `codex exec --json` documentation and is covered by tests on a fake process; the first live check is `npm run eval -- ceiling --model codex:<model>` on a synthetic scenario.

<a id='hosted-limits-2026-09-18'></a>

## Hosted limits, 2026-09-18

Limits as of 18 September 2026: the free OpenRouter models give 20 requests per minute and 1000 per day if credits of $10 or more have been bought over all time, otherwise 50 per day. [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits). `google/gemma-4-31b-it:free` declares a context of 262144 and the parameters `max_tokens`, `temperature`, `top_p`, `response_format`.

The limits the code sets for itself are in [eval.md](../eval.md#daily-limits).

<a id='cloud-draft'></a>

## The Telegram Serverless draft

Written while the draft existed. The draft (`schema.js`, `handlers/`, the JS in `lib/` and its SDK notes in
`docs/tgcloud-sdk.md`) was removed while the owner's account waits for access; its last version is at commit ea88089.

While the owner's account is on the Telegram Serverless waiting list, the bot is started on a computer with the command `npm start`. It calls Claude Code on the same machine. The working code is in `local/`.

HTTP connections can be called from Telegram Serverless. Claude Code needs a separate process: Serverless has no Node environment and cannot run local commands. If the bot stays in Telegram Serverless, the CLI will need an external process with an authenticated connection. When the bot runs locally, the CLI can be called directly. This difference is inside the model connection.

<a id='eval-verified-2026-09-18'></a>

## What was verified live as of 18 September 2026

- The OpenRouter, OpenAI and Mistral keys in `.env.eval` are accepted by the providers. The daily counter counts.
- OpenRouter: the stream format, disabling reasoning (`reasoning.enabled=false`) on DeepSeek and Gemma, recording the scenes of the `battle` scenario.
- OpenAI: `gpt-5.4-mini` responds, the stream format matched the expected format.
- Mistral: `ministral-14b-2512` responds. `mistral-large-2512` is not available on the Free plan (403), `mistral-small` and `mistral-medium` answered 429 even to a single request.
- Cerebras: 402 on all models, free access is not enabled on the account. Do not use.

- The full `npm run eval` on `battle` passes from scene recording to `score`; the first numbers are in [improve-log.md](improve-runs.md#schema-2026-09-18).
- The memory schema is enforced by the provider in OpenAI, Mistral and the paid Gemma on OpenRouter: with it `plain` passes for all three.
- Claude CLI with a schema (`--json-schema`): Haiku 4.5 passes `plain`. Compaction with a schema takes about two minutes, and `sgr` hits the 300-second timeout: this is a failure of CLI speed, not of memory.
- `sgr` does not pass for any model because of the `quote` check; the analysis is in the log. Until this is solved, decisions are made on `plain`.

- Analysis of a sum failure without a model: for a numeric answer of two or more digits the probe writes `stated` — whether the number is present in the memory message (`memory`), in the scenes that remained as text (`scenes`), or nowhere (`none`). `readingMisses` in the result file are the failed questions whose answer was present in memory: memory is right, reading made the error. A failure with `none` means that the sum had to be added up at answer time. This is a diagnostic, not a score: a short number can match by chance.
- There are two judges: `--judge claude:claude-opus-5` (by subscription, no daily limit; the main judge since 18 September) and `--judge openai:gpt-5.4` (225 thousand tokens per day). Cross-check on 40 questions: 36 matched, in the disagreements Opus is right or stricter (entry in the log). Both sides of one comparison are judged by the same judge; numbers from different judges are not compared.
- Scene eval: the judge `gpt-5.4` was checked by hand (entry in the log); `gpt-5.4-mini` as a judge makes errors on careful reading. Word a question to the judge in the affirmative form. To re-judge finished scenes: `npm run eval -- judge --judge <model> --resume <probe directory> --mode plain`. Traps exist for all three scenarios, in the middle of the story (`afterTurn`) and after it; their facts were checked against the text of the frozen scenes.

- All three scenarios are recorded and pass from replay to `score`. No model answers the `fen` question in `chess` correctly, even over the full text: the maximum there is 6/7.

Not verified: behaviour when the limit is exhausted.

<a id='tokenizer-checks'></a>

## Token counts against the card's servers, 2026-09-24

How `local/tokenizer.ts` was checked before it was committed:

- 1099 synthetic strings (15 synthetic texts in five languages, their paragraphs, picture prompts, edge cases): the
  same ids as the card's llama-server with and without `parse_special`, and as transformers 5.17 and ComfyUI's
  `QwenImage21Tokenizer` and `Krea2Tokenizer` on the card.
- 8 chats, 16 to 5779 tokens: the same rendered prompt, the same ids, and a count equal to `input_tokens`.
- 170,080 random strings against libllama at the pinned revision, about 16.7 million tokens, in both modes.
- 10,014 random strings, some with reference pictures, against transformers 5.17 and ComfyUI's tokenizer classes
  loaded from the pinned sources: the same ids, sequences and kept spans.
