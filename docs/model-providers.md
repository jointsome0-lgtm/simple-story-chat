# Model connections

The bot has one generation interface and an adapter for each way of calling a model. `SIMPLE_CHAT_PROVIDER` picks the
adapter, `claude-code` by default, and `local/model.ts` creates it. Which connections were checked live, and when, is
in [provider-checks.md](knowledge/provider-checks.md).

<a id='adapters'></a>

## The adapters

| Adapter | Example | How it is called |
| --- | --- | --- |
| `llama-cpp` | Gemma 4 on an own or rented GPU | HTTP request to the model server |
| `simple-serving` | A model on our rented GPU behind our own gateway (vLLM) | HTTP request to the gateway |
| `claude-code` | Haiku through a Claude account | The official CLI/SDK in a process on a computer or server |
| `openai-compatible` | Gemma 4 on OpenRouter, OpenAI models | HTTP request to a hosted API; by default only synthetic probes |
| `codex-cli` | OpenAI models through a ChatGPT account | The official Codex CLI (`codex exec --json`) in a process on the computer; by default only synthetic probes |

A direct `anthropic-api` adapter, Haiku with an API key over HTTP, is not implemented: `local/config.ts` refuses any
provider outside this table. A new way of calling a model is added as a separate adapter. Connecting it does not require changes to the Telegram interface, to the format of saved messages, or to the story continuation logic.

## Minimal interface

```js
const result = await provider.generate(
  { system, messages, maxOutputTokens, estimatedInputTokens, outputSchema },
  { onText: async (delta) => { /* show the new part of the text */ }, signal, inputLimitTokens },
);
// result: { text, finishReason, usage? }
```

The model, the address and the authorization are set when the adapter is created. A request contains the rules and the dialog messages in the order they were recorded. `onText` receives only new parts of the story text, without service events and without reasoning. A successful result is returned after a confirmed completion; `finishReason` distinguishes a normal end from the response length limit. A broken stream is an error.

Tokens and costs are returned in `usage` when the connection reports them. We do not replace unknown values with zero. Input counting and the check of the available context are done with the means of the specific adapter: they differ between llama.cpp and Anthropic, and the CLI needs a separate check. We do not present an estimate as an exact count. The 64K limit cannot be declared verified for a new connection without such a check.

An adapter may provide `countInput(request, { signal })` for an exact count before the compaction decision, and `check()` to check the server at startup. `local/model.ts` selects the connection; the safe error codes are defined in `local/model-error.ts`.

Errors of unavailability, authorization, context limit and usage limit are converted to a form the application understands. A failure to send the response to Telegram does not start a second generation.

The tests of each adapter check this contract: the dialog passed, the order of the stream parts, the completion and a
broken stream.

<a id='execution'></a>

## Where the call runs

The bot runs on a computer (`npm start`) and every call starts there: `claude-code` and `codex-cli` start their CLI on
the same machine, the other adapters send HTTP requests. The Telegram Serverless draft planned it differently
([its notes](knowledge/provider-checks.md#cloud-draft)).

The story is stored by the application. The provider's session does not become the only place where the dialog is stored. When the connection changes, the application passes the saved messages and checks the available context again. Agent tools are turned off in narrator mode: the task of the call is to return story text.

<a id='claude-code'></a>

## Claude Code and tmux

tmux keeps the local bot process, and for each continuation the adapter starts `claude -p`, passes the assembled dialog through stdin, and reads stdout as `stream-json`. The story stays in the application database.

`local/claude.ts` runs it with `--safe-mode --restricted --tools "" --strict-mcp-config`, an empty `--mcp-config`,
`--no-session-persistence`, `--permission-prompts none`, `--debug-file /dev/null` and
`--output-format stream-json --verbose --include-partial-messages`, with telemetry off. In `system/init` it checks
that the CLI has no tool and no MCP server and runs the model asked for. A request with a schema adds `--json-schema`,
which gives the CLI only its `StructuredOutput` tool. The CLI signs in with the
subscription's ordinary login ([setup](setup.md#running)); the adapter removes the Anthropic keys and addresses, the
bot's `SIMPLE_CHAT_*` settings and `TELEGRAM_BOT_TOKEN` from its environment. We do not use `--bare` with a subscription: this mode turns off OAuth and requires a separate API authorization.

The scene's text is the stream's text parts up to the final `result`, which must report success, and the process
must exit with 0. A separate `result.result` may be incomplete, and a mismatch is logged as a safe event without text.
Neither the stream nor stderr reaches the logs or the tmux screen, as both may hold story text. Turning off session saving does not mean that the CLI has no internal diagnostics at all; this must be checked before testing other people's stories.
The timeout is set by `SIMPLE_CHAT_MODEL_TIMEOUT_MS`, 300 seconds by default. Exceeding it returns a separate code `timeout`; an unfinished response does not become a scene or a memory increment. `/cancel` stops the call.

`usage` holds `inputTokens`, `outputTokens` and `totalTokens` of the last model request, `null` when unknown, and the
input includes the cache. The output count comes from the last `message_delta`; `result.usage` counts only for a
confirmed single response
([Claude Code counters](https://code.claude.com/docs/en/agent-sdk/cost-tracking#read-output-tokens-from-the-result-message)).
At the start of the stream the adapter checks the real input tokens together with the cache; exceeding `inputLimitTokens` stops the call before any text is shown. A large input without counters is not allowed. This is not a local exact tokenizer: the provider may have already started processing the request. The response limit is passed through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. [Claude Code variables](https://code.claude.com/docs/en/env-vars).

<a id='memory-and-context'></a>

## Context and memory

The bot saves the provider's counters with each finished scene, before the scene goes to Telegram. The percentage
before a scene and `/context` measure one checkpoint from its `head` and its `memory` chain: the seed, the memory
increments and the scenes not compacted yet, without future scenes or other branches. A part's token estimate is its
UTF-8 bytes / 4, rounded up, with a Han or kana character counted as four bytes (`local/context.ts`). A request's
estimate starts from the previous request's measured input when the model, the provider, the system prompt and the
memory chain match, and adds the changed bytes / 4. Otherwise it is bytes / 4 plus a reserve of 4096. The estimate
travels as `estimatedInputTokens` and never reaches the model's messages. It is never presented as an exact count:
each adapter checks the real input as its section says.

`local/generation.ts` compacts the old continuous prefix of scenes before a continuation: by default at 54000 input tokens for Claude Code and the Codex CLI and 44000 for the other adapters (`SIMPLE_CHAT_COMPACT_AT_TOKENS`). The last four scenes and the new input are not part of the compacted range. The summarizer returns JSON with facts, time and references to the source scenes, and the provider holds it to the schema while generating (`response_format` over HTTP, `--json-schema`, `--output-schema`). The schema, the references, the coverage of all passed scenes, the full completion of the response and the reduction of the request are checked. The structure check does not prove that the retelling is accurate: the source scenes and the checkpoints before/after stay available. A new memory increment is added to the previous memory atomically and only for a job that is still valid. At most four compactions are allowed per continuation; a summarizer request that is too large is reduced by splitting the old prefix in half, eight attempts at most. A cancellation, a format error and a late response cannot apply unverified memory.
The saved memory stays JSON. `local/prompt.ts` builds from it a text with dates, fact kinds and references, keeping the order of the memory increments and not computing a new state.

`SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE=true` lets `plain` make one more request for the scenes the answer missed. It is
off by default, so that memory quality can be measured on its own. The repair sees the draft of facts and the
preceding scenes, but its new facts may cite only the missed scenes. The whole increment then passes the common check
and is written in one transaction; a second miss, a broken connection or a larger memory leaves the context as it
was. The JSON counter in the progress message shows characters, not tokens.

`SIMPLE_CHAT_MEMORY_MODE` is `plain` by default. The experimental `sgr` (`local/memory.ts`) applies Schema-Guided
Reasoning without an agent framework: the model writes exact quotes from the new scenes, then the contradictions
between the input and the continuation, then facts with an explicit event status, where a plan, a cancellation and an
uncertainty have statuses of their own. The
code checks every quote in its stated source, unique identifiers, the facts' references and the coverage of all
compacted scenes, and a detected conflict must reach the facts. These checks do not prove that the model found all contradictions or understood them correctly. An invalid or unfinished response does not change the memory. The evidence archive is stored with the memory increment, and only the facts go into the next prompts. Old checkpoints are not rewritten.
SGR gets up to 8192 output tokens and `plain` 4096, maximums rather than a length, and the provider's counters are
saved with the memory. Compare it with `plain` on your own
model with the [background probe](llama-cpp.md#background-memory-comparison) before turning it on for users; what the
eval found so far is in [improve-runs.md](knowledge/improve-runs.md#schema-2026-09-18).

### Compaction prepared while the person reads

The extraction depends only on the branch, not on the person's next action. So when a scene's input and output
together reach the compaction threshold, the bot asks the model for the next turn's extraction, and the repair if scenes are
missed, right after sending the scene (`local/prepare.ts`). Nothing is saved then. The next turn takes a prepared
answer only for an identical request and only after the check it would make itself, and then saves it as usual;
otherwise it asks the model. The run holds the GPU like a job, runs only on a ready GPU, and never makes anybody else
wait: any other person's call ends it at once (`background_preempted`). Its own person's next turn waits for a started
run and takes its answers; a run still in the queue, or one for another branch point, is stopped. The answers stay in
the bot's memory, never on disk. The log rows are in [gpu.md](gpu.md#bot-log).

<a id='llama-cpp'></a>

## llama.cpp

`llama-cpp` calls a pinned llama.cpp server over HTTP, through an SSH tunnel or an HTTPS gateway, and asks the server
to count the input unless the bot's estimate is far below the limit. Its contract, the slot pool and the card it runs
on are in [llama-cpp.md](llama-cpp.md#adapter).

## simple-serving: our gateway

`local/serving.ts` calls [simple-serving](https://github.com/jointsome0-lgtm/simple-serving), our own gateway in front of vLLM on a rented card. Its API is fixed by its contract v2 (`docs/contract-v2.md` there). The adapter was added on 24 September 2026 and is tested against the contract's shared cases and against the real gateway in front of its fake engine. It has not met one in front of vLLM yet.

To point the bot at a gateway, set in `.env`:

```sh
SIMPLE_CHAT_PROVIDER=simple-serving
SIMPLE_CHAT_BASE_URL=https://serving.example.com   # the gateway's root, or http://127.0.0.1:<port> through a tunnel
SIMPLE_CHAT_API_KEY=...                            # the bot's key in the gateway's configuration
SIMPLE_CHAT_MODEL=...                              # the name the gateway serves the model under, as /v1/models lists it
```

The address is a root without a path, as for llama.cpp: HTTPS, or HTTP on loopback. The key is the one the gateway's configuration gives the bot. It must allow the classes `reader`, `agent` and `internal` and the naming of cache scopes. It is required on loopback too. It is not the Vast key. The gateway runs on our own card, so the story does not go to a third party and `SIMPLE_CHAT_ALLOW_HOSTED` is not needed.

Every generation and count says whose it is. A reader's turn is class `reader` with a cache scope of its own: an HMAC of the reader's Telegram ID under a secret that the bot makes at each start and never stores. The gateway never sees the ID, and readers never share a cache. After a restart every reader gets a new scope, so their first turn reads the whole prompt again. The compaction prepared while a reader reads and their picture's description are that reader's too. A turn of the agent interface is `agent`: it calls the gateway directly and says so itself. Eval, probes and every other call are `internal`. Neither a request nor a client of the model socket can say whose a call is. A reader's call that names no reader would be a bug, and the bot refuses it before anything is sent, as `unnamed_reader`.

Differences from llama.cpp:

- The bot sends one request at a time. `SIMPLE_CHAT_GPU_SLOTS` and the pool settings do not apply.
- The check reads `/v1/state` (contract `2`, status `ready`, the configured model), then `/v1/models` (the model name, and a context of at least `SIMPLE_CHAT_CONTEXT_TOKENS` that equals the state's `context_tokens`). No text goes to a service that has not passed it: the bot checks it at startup, the agent interface and the probes before their first count or generation, and each of them again before its next call when a check failed or was cancelled. The bot starts while the service is down: a check at startup that finds it not ready, or cannot reach it, is logged as `model_check_deferred`. A wrong key, model, context or contract still stops the start.
- The bot checks this of the stream: every chunk names the model and holds one choice with index 0 or none; the text and the reasoning are strings, and a tool call is refused; one finish, `stop` or `length`, then only the usage chunk with `prompt_tokens` and `completion_tokens`, then `[DONE]`. A stream that breaks one of these fails, and so does one with an error event or without `[DONE]`; its text never becomes a scene.
- A refusal is read by its code only; its body is never kept or logged. `class_not_allowed`, `scope_not_allowed` and `forbidden` become `unauthorized`, `queue_full` becomes `rate_limited`, `starting`, `draining`, `drained` and `engine_unavailable` become `model_unavailable`, and `not_found` becomes `unsupported_server`. `unauthorized`, `context_limit` and `timeout` keep their names, and a `context_limit` compacts the story without a second count. Every other code is `provider_failed`. The log row keeps the gateway's own code as `servingCode`.
- The gateway's measurements go to the log rows as `servingWaitMs`, `servingFirstTokenMs` and `servingTotalMs`, all three or none: they are kept only when each is a whole number of milliseconds and they come in order. They never fail an answer. `waitMs` stays the time in the bot's own queue.

simple-serving runs its own card: the bot never starts or stops it, and refuses to start with this provider while `SIMPLE_CHAT_VAST_INSTANCE_ID` is set. The owner unsets it by hand; `SIMPLE_CHAT_VAST_API_KEY` stays, as `npm run gpu:rent` rents the picture card with it. A reader whose turn finds the service unavailable is told so, without a guess at why or for how long, and `/gpu_start` and `/gpu_pause` say that the model service is started separately. The agent interface calls the gateway directly, as `agent`, even when a model socket answers: that socket would be another bot's. Eval (`--model gpu:<label>`) and the probes with `--direct` call it directly too, as `internal`. The bot sees none of these calls.

The shared cases are pinned in `local/serving-contract/`: an exact copy of `contract/cases-v2.json` and `pin.json` with its commit and SHA-256. `local/serving-contract.test.ts` plays each public step's answer from a fake gateway, and each stream also with its text cut into single characters, joined, and sent a byte at a time: the contract promises no split. To update the cases, copy the file again from a commit of simple-serving, change the pin in the same commit, and correct the counts at the end of the test if they changed. The copy is never edited by hand.

`npm run test:serving` runs the adapter against the real gateway, which simple-serving's dev launcher starts on loopback in front of its fake engine, with the service block of the pinned cases. It checks the state and the contract, a count, a stream with its usage, a refusal, a cancelled stream, and the class and scope the gateway logs for each call, and prints the commits of both checkouts. It needs `SIMPLE_SERVING_CHECKOUT`, a git checkout of simple-serving, and `SIMPLE_SERVING_PYTHON`, the python of an environment with its dependencies (`uv sync` there). Without them it fails rather than pass. It is not part of `npm test`.

<a id='codex-cli'></a>

## Codex CLI: `codex-cli`

`local/codex.ts` starts the installed `codex exec --json` the way `local/claude.ts` starts Claude Code. It signs in
through the CLI's own login (`CODEX_HOME`); the OpenAI keys, address, organization and project, the bot's
`SIMPLE_CHAT_*` settings and `TELEGRAM_BOT_TOKEN` are removed from its environment. `SIMPLE_CHAT_MODEL` is required,
because the models depend on the account's plan.

Codex is an agent with a shell, and the narrator needs none. The request runs with `--ephemeral --ignore-user-config
--ignore-rules --skip-git-repo-check --sandbox read-only` in an empty temporary directory, with web search and every
feature that can act turned off (`FEATURES_OFF` in `local/codex.ts`). The story goes through stdin, and the system
prompt and the schema as files (`model_instructions_file`, `--output-schema`) deleted after the request, so none of
them reaches the process arguments. Any
stream item other than `agent_message`, `reasoning` and the `error` warning ends the request with `unexpected_tools`.

The CLI gives the message whole, so the scene appears in Telegram at once. It has no output token limit:
`finishReason` is always `stop`, and only the general limit of 100 000 characters applies. The server does not confirm
the model name. The input comes from `turn.completed.usage.input_tokens`, which includes the cached part.

The first check of the CLI, on 2026-09-19, reached no successful answer and is in
[provider-checks.md](knowledge/provider-checks.md#codex-cli-2026-09-19). The eval has used the adapter live since: as
a judge of [the walk](knowledge/improve-runs.md#walk-2026-09-22) on 2026-09-22, and as a writer and a judge of
[the gold tree](knowledge/improve-runs.md#gold-v1-2026-09-23) on 2026-09-23.

## Consent to a hosted connection for the bot

`openai-compatible` and `codex-cli` send story text to a third-party service that may store requests and train on them (for free OpenRouter channels and consumer accounts this is the usual condition). Therefore the bot does not start with them. Whoever runs the bot for their own stories and accepts this writes in `.env`, word for word, `SIMPLE_CHAT_ALLOW_HOSTED=stories-leave-this-computer`; any other value, including `1` and `true`, does not count as consent. An instance with other people's stories (the tester) does not get this value. For `openai-compatible`, the daily token limits from `local/budget.ts` also apply in the bot; they are changed by `SIMPLE_CHAT_BUDGET_REQUESTS` and `SIMPLE_CHAT_BUDGET_TOKENS`. `codex-cli` has no local counter: only the subscription limits the spending.

<a id='openai-compatible'></a>

## Hosted APIs: `openai-compatible`

The adapter works with any API in the OpenAI Chat Completions format: `SIMPLE_CHAT_BASE_URL` sets the versioned root (`https://openrouter.ai/api/v1`, `https://api.openai.com/v1`), `SIMPLE_CHAT_API_KEY` and `SIMPLE_CHAT_MODEL` are required. The code is shared with `llama-cpp` and is in `local/llama.ts`. All runs of hosted models from the [log](improve-log.md) were made through it.

Without the [owner's consent](#consent-to-a-hosted-connection-for-the-bot) the connection serves only synthetic
probes: `loadConfig` refuses to start the bot with it, while `story:probe` reads `loadModelConfig` and works.
`memory:probe` reaches it with `--direct`, which calls the provider from the probe's own process instead of the
running bot's queue.

Differences from llama.cpp:

- No input count before generation and no `countInput`: the bot's estimate or bytes / 4 stands until the provider's
  `usage.prompt_tokens` arrives with the answer. Without it the result fails with `usage_unavailable`, over the limit
  with `context_limit`. The text has been shown through `onText` by then, but it does not become a scene.
- The llama.cpp fields (`top_k`, `min_p`, `chat_template_kwargs`, `cache_prompt`) are not sent. `api.openai.com` gets
  `max_completion_tokens` and no temperature, as its current models reject `max_tokens` and a non-standard temperature.
- `outputSchema` goes as a strict `json_schema` `response_format`. OpenRouter also gets `require_parameters`, so that
  a model without structured outputs, such as the free Gemma 4, fails instead of ignoring the schema. The application
  checks the result anyway.
- The model name in the stream is not compared, as a provider answers with its own name, a dated snapshot for example.
  `check()` looks for the model in `/models`.
- Reasoning comes in a separate field and is counted only in characters. A reasoning model spends the answer's limit on
  it and may finish with `length`.

The bot counts a hosted connection's requests and tokens per day as the eval does ([daily limits](eval.md#daily-limits)).
The free tiers' own limits as of 2026-09-18 are in
[provider-checks.md](knowledge/provider-checks.md#hosted-limits-2026-09-18).

<a id='evaluating-changes-npm-run-eval'></a>
<a id='daily-limits-of-hosted-apis'></a>

## Evaluation

`npm run eval`, the walk, the gold tree and the daily limits of hosted APIs are described in [eval.md](eval.md).

Technical sources: [Claude Code streaming output](https://code.claude.com/docs/en/headless#stream-responses), [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting).
