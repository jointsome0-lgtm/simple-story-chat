# Model connections

Updated 17 September 2026: one generation interface, separate adapters for different ways of calling a model. `claude-code` and `llama-cpp` are implemented. Haiku was checked with a short live call; Gemma Q4_K_M and Q6_K were run on an RTX 5090, including a synthetic input of about 59K tokens. [GPU setup and measurements](gpu.md). The direct `anthropic-api` adapter is not implemented yet.

| Adapter | Example | How it is called |
| --- | --- | --- |
| `llama-cpp` | Gemma 4 on an own or rented GPU | HTTP request to the model server |
| `simple-serving` | A model on our rented GPU behind our own gateway (vLLM) | HTTP request to the gateway |
| `anthropic-api` | Haiku with an API key | HTTP request to Anthropic |
| `claude-code` | Haiku through a Claude account | The official CLI/SDK in a process on a computer or server |
| `openai-compatible` | Gemma 4 on OpenRouter, OpenAI models | HTTP request to a hosted API; by default only synthetic probes |
| `codex-cli` | OpenAI models through a ChatGPT account | The official Codex CLI (`codex exec --json`) in a process on the computer; by default only synthetic probes |

A new way of calling a model is added as a separate adapter. Connecting it does not require changes to the Telegram interface, to the format of saved messages, or to the story continuation logic.

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

## Where the call runs

While the owner's account is on the Telegram Serverless waiting list, the bot is started on a computer with the command `npm start`. It calls Claude Code on the same machine. The working code is in `local/`.

HTTP connections can be called from Telegram Serverless. Claude Code needs a separate process: Serverless has no Node environment and cannot run local commands. If the bot stays in Telegram Serverless, the CLI will need an external process with an authenticated connection. When the bot runs locally, the CLI can be called directly. This difference is inside the model connection.

The story is stored by the application. The provider's session does not become the only place where the dialog is stored. When the connection changes, the application passes the saved messages and checks the available context again. Agent tools are turned off in narrator mode: the task of the call is to return story text.

## Claude Code and tmux

Claude Code with a subscription was chosen for the first run. tmux keeps the local bot process, and for each continuation the adapter starts `claude -p`, passes the assembled dialog through stdin, and reads stdout as `stream-json`. The contents of the tmux screen and the Claude session files are not used as an exchange protocol. The story stays in the application database.

In the installed Claude Code 2.1.273 the flags `--tools ""`, `--safe-mode`, `--strict-mcp-config` and `--no-session-persistence` were checked. They make it possible to turn off the built-in tools, user settings and extensions, to connect no MCP, and to not save the Claude session. In the implementation we explicitly pass an empty MCP configuration and check the tool list in the `system/init` event. We do not use `--bare` with a subscription: this mode turns off OAuth and requires a separate API authorization.

Streaming output is turned on with `--output-format stream-json --verbose --include-partial-messages`. The adapter reads text fragments until the final `result` event and checks for successful completion. The full stream and the raw stderr are not written to the technical logs or to the tmux screen: they may contain story text. Only the process state and safe diagnostic information stay in the terminal. Turning off session saving does not mean that the CLI has no internal diagnostics at all; this must be checked before testing other people's stories.

The adapter is in `local/claude.ts`. It checks the empty tool/MCP lists and the selected model in `system/init`, and also the successful `result` and the process exit. The final story text is assembled from the text parts of the stream: a separate `result.result` may be incomplete. A mismatch is recorded as a safe technical event without text. The timeout is set by `SIMPLE_CHAT_MODEL_TIMEOUT_MS`, 300 seconds by default. Exceeding it returns a separate code `timeout`; an unfinished response does not become a scene or a memory increment. `/cancel` stops the call. The prompt and the dialog are not saved to the technical logs; the CLI diagnostic file is directed to `/dev/null`, session saving and telemetry are turned off. Before passing other people's stories, the behavior of the chosen provider must be checked separately.

`usage` contains the normalized `inputTokens`, `outputTokens`, `totalTokens` of the last model request; an unknown value is `null`. The input includes `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens`. The intermediate `assistant.message.usage.output_tokens` is not used as the response length: it is an initial counter. The final value is taken from `message_delta`; its cumulative values are not added together. The aggregated `result.usage` is allowed only as a fallback source for a confirmed single response. [Claude Code counters](https://code.claude.com/docs/en/agent-sdk/cost-tracking#read-output-tokens-from-the-result-message).

The counters are saved with the finished scene before it is sent to Telegram. The percentage before a scene and the `/context` command work separately from the prompt. The size of a checkpoint is computed from its `head` and its `memory` chain; future scenes and neighboring branches are not counted. The prefix consists of the seed plus the memory increments; the full snapshot also includes the scenes that are not compacted yet. Bytes are measured for the serialized parts of the request; the token estimate of individual components equals UTF-8 bytes / 4, rounded up.

The estimate of the whole input relies on the saved measurement of the previous request, if the model, the system prompt and the memory chain match. An estimate of the changed text, by bytes / 4, is added to this measurement. Without a suitable measurement, bytes / 4 plus a 4096 reserve for the CLI is used. The `estimatedInputTokens` field is not serialized into the model messages. At the start of the stream the adapter checks the real input tokens together with the cache; exceeding `inputLimitTokens` stops the call before any text is shown. A large input without counters is not allowed. This is not a local exact tokenizer: the provider may have already started processing the request. The response limit is passed through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. [Claude Code variables](https://code.claude.com/docs/en/env-vars).

`local/generation.ts` compacts the old continuous prefix of scenes before a continuation: by default at 44000 input tokens for llama.cpp and 54000 for Claude Code. The last four scenes and the new input are not part of the compacted range. The summarizer returns JSON with facts, time and references to the source scenes. The schema, the references, the coverage of all passed scenes, the full completion of the response and the reduction of the request are checked. The structure check does not prove that the retelling is accurate: the source scenes and the checkpoints before/after stay available. A new memory increment is added to the previous memory atomically and only for a job that is still valid. At most four compactions are allowed per continuation; a summarizer request that is too large is reduced by splitting the old prefix in half, eight attempts at most. A cancellation, a format error and a late response cannot apply unverified memory.

The optional `outputSchema` field is used by llama.cpp for schema-constrained JSON generation through `response_format`; for Claude Code, for now, there is still the instruction about JSON and the check of the received result. The saved memory stays JSON. `local/prompt.ts` builds from it a text with dates, fact kinds and references, keeping the order of the memory increments and not computing a new state.

`SIMPLE_CHAT_MEMORY_MODE=plain` keeps the previous fact extraction. The experimental `sgr` in `local/memory.ts` sets the sequence `evidence → conflicts → facts`. First the model writes out exact quotes from the new scenes, then it marks contradictions between the input and the continuation, then it forms facts with an explicit event status. A plan, a cancellation and an uncertainty get separate statuses. This is an application of the Schema-Guided Reasoning principle, without installing a separate agent framework.

The code checks every quote in the stated source, the uniqueness of identifiers, the references of the facts and the coverage of all compacted scenes. A detected conflict must get into the final facts. These checks do not prove that the model found all contradictions or understood them correctly. An invalid or unfinished response does not change the memory. The evidence archive is stored with the memory increment, and only the facts go into the next prompts. Old checkpoints are not rewritten.

SGR gets up to 8192 output tokens, ordinary compaction up to 4096. These are maximums, not a set length of the memory increment. The actual provider counters are saved with the memory. Before turning on SGR for users, compare it with the ordinary mode on your own model with the [background probe](gpu.md#background-memory-comparison).

## Subscription and first start

A subscription connection uses the supported authorization of the specific CLI/SDK. The checked Anthropic page has a clarification: the announced move to separate credits is paused; the Agent SDK and `claude -p`, when authorized through a subscription, continue to use its limits. An API key means a different way of paying. [Anthropic terms](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

We do the initial probe ourselves on Claude Haiku 4.5: one seed and several continuations, a check of the cycle "seed → scene → message → continuation", of streaming output and of saving the dialog. The API identifier is `claude-haiku-4-5-20251001`. [Anthropic models](https://platform.claude.com/docs/en/models/overview).

After our run, the tester checks stories more deeply on Gemma 4 Uncensored. For the GPU, the dense build 31B Heretic Q6_K is used, fixed in the [manifest](../gpu/manifest.env). Capacity was checked separately from memory quality. The tester reports problems themselves; we do not read their correspondence and do not export it for debugging. The adapters do not write the text of requests, of responses or of raw provider errors to the technical logs. [Tester privacy rules](../README.md#privacy).

We add other connections through the same interface as needed. The contract is checked on passing the dialog, on the order of the stream parts, on completion and on a broken stream. Checkpoints, branching and automatic compaction use the story library.

## llama.cpp

`local/llama.ts` calls a pinned version of llama.cpp over HTTP through an SSH tunnel or an HTTPS gateway. This is a llama.cpp adapter, not a promise of compatibility with any OpenAI-like API. At startup the model name, a single slot and a sufficient context per slot are checked.

The count `/v1/chat/completions/input_tokens` and the generation `/v1/chat/completions` receive the same request body. The server applies one chat template to both. Neighboring messages of the same role are merged, reasoning is turned off by template parameters, and separate `reasoning_content` is not shown to the user. Summarization uses a lower temperature than the story response.

Before the generation request is sent, the exact input is checked with a reserve for the output. The `prompt_tokens` reported at the end must match the preliminary count. A request whose caller trusts its estimate (`trustEstimate`, set only far below the limit) is sent without the preliminary count. Its reported `prompt_tokens` replace the estimate and are checked against the same limit after the stream. Without them the result is rejected with `usage_unavailable`. If the server answers such a request with 400, the adapter makes the count it skipped, so that a prompt over the limit becomes `context_limit`. The cache is part of the full input and is not added to it a second time. A break without a completion event, tools, and inconsistent counters are rejected. A cancellation and a timeout close the request; there is no automatic retry. [Pinned server documentation](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/server/README.md).

Technical sources: [Claude Code streaming output](https://code.claude.com/docs/en/headless#stream-responses), [Anthropic token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server), [Telegram Serverless SDK](tgcloud-sdk.md).

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
- The check reads `/v1/state` (contract `2`, status `ready`, the configured model), then `/v1/models` (the model name, and a context of at least `SIMPLE_CHAT_CONTEXT_TOKENS` that equals the state's `context_tokens`). The bot starts while the service is down: a check at startup that finds it not ready, or cannot reach it, is logged as `model_check_deferred`, and the first model call checks it again before it runs. A wrong key, model, context or contract still stops the start.
- The bot checks this of the stream: every chunk names the model and holds one choice with index 0 or none; the text and the reasoning are strings, and a tool call is refused; one finish, `stop` or `length`, then only the usage chunk with `prompt_tokens` and `completion_tokens`, then `[DONE]`. A stream that breaks one of these fails, and so does one with an error event or without `[DONE]`; its text never becomes a scene.
- A refusal is read by its code only; its body is never kept or logged. `class_not_allowed`, `scope_not_allowed` and `forbidden` become `unauthorized`, `queue_full` becomes `rate_limited`, `starting`, `draining`, `drained` and `engine_unavailable` become `model_unavailable`, and `not_found` becomes `unsupported_server`. `unauthorized`, `context_limit` and `timeout` keep their names, and a `context_limit` compacts the story without a second count. Every other code is `provider_failed`. The log row keeps the gateway's own code as `servingCode`.
- The gateway's measurements go to the log rows as `servingWaitMs`, `servingFirstTokenMs` and `servingTotalMs`, all three or none: they are kept only when each is a whole number of milliseconds and they come in order. They never fail an answer. `waitMs` stays the time in the bot's own queue.

simple-serving runs its own card: the bot never starts or stops it, and refuses to start with this provider while `SIMPLE_CHAT_VAST_INSTANCE_ID` is set. The owner unsets it by hand; `SIMPLE_CHAT_VAST_API_KEY` stays, as `npm run gpu:rent` rents the picture card with it. A reader whose turn finds the service unavailable is told so, without a guess at why or for how long, and `/gpu_start` and `/gpu_pause` say that the model service is started separately. The agent interface calls the gateway directly, as `agent`, even when a model socket answers: that socket would be another bot's. Eval (`--model gpu:<label>`) and the probes with `--direct` call it directly too, as `internal`. The bot sees none of these calls.

The shared cases are pinned in `local/serving-contract/`: an exact copy of `contract/cases-v2.json` and `pin.json` with its commit and SHA-256. `local/serving-contract.test.ts` plays each public step's answer from a fake gateway, and each stream also with its text cut into single characters, joined, and sent a byte at a time: the contract promises no split. To update the cases, copy the file again from a commit of simple-serving, change the pin in the same commit, and correct the counts at the end of the test if they changed. The copy is never edited by hand.

`npm run test:serving` runs the adapter against the real gateway, which simple-serving's dev launcher starts on loopback in front of its fake engine, with the service block of the pinned cases. It checks the state and the contract, a count, a stream with its usage, a refusal, a cancelled stream, and the class and scope the gateway logs for each call, and prints the commits of both checkouts. It needs `SIMPLE_SERVING_CHECKOUT`, a git checkout of simple-serving, and `SIMPLE_SERVING_PYTHON`, the python of an environment with its dependencies (`uv sync` there). Without them it fails rather than pass. It is not part of `npm test`.

## Codex CLI: `codex-cli`

`local/codex.ts` starts the installed `codex exec --json` the same way `local/claude.ts` starts Claude Code: login goes through the CLI's own authorization (`CODEX_HOME`); `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` are removed from the process environment, so that the request does not go to a different account or a different server. `SIMPLE_CHAT_MODEL` is required: the set of models depends on the plan of the account (on a ChatGPT account, for example, `gpt-5.4-mini` is not available).

Codex is an agent with a shell, and the narrator does not need a shell. The request goes with `--ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check --sandbox read-only`, in an empty temporary directory, with `shell_tool`, `unified_exec`, `apps`, `plugins`, `memories`, `browser_use`, `computer_use`, `image_generation`, `view_image`, `skill_search`, `tool_suggest`, `sleep_tool`, `hooks`, `goals` turned off and `web_search="disabled"`. The system prompt is passed as a file through `model_instructions_file`, the response schema as a file through `--output-schema`; neither the prompt nor the story gets into the process arguments. Any stream item other than `agent_message`, `reasoning` and the `error` warning ends the request with the error `unexpected_tools`. Temporary files are deleted after every request.

Differences from `claude-code`: the CLI gives the message as a whole, so the scene text appears in Telegram all at once, without gradual output; the CLI has no output token limit, `finishReason` is always `stop`, only the general limit of 100 000 characters applies; the server does not confirm the model name. The input is counted from `turn.completed.usage.input_tokens` (the cached part is already inside).

Checked on 19 September 2026: the set of arguments is accepted by CLI 0.154.0 under `--strict-config`, the key `model_instructions_file` exists. A successful response was not checked live: on that day the account hit the usage limit (`turn.failed`). The format of successful events is taken from the `codex exec --json` documentation and is covered by tests on a fake process; the first live check is `npm run eval -- ceiling --model codex:<model>` on a synthetic scenario.

## Consent to a hosted connection for the bot

`openai-compatible` and `codex-cli` send story text to a third-party service that may store requests and train on them (for free OpenRouter channels and consumer accounts this is the usual condition). Therefore the bot does not start with them. Whoever runs the bot for their own stories and accepts this writes in `.env`, word for word, `SIMPLE_CHAT_ALLOW_HOSTED=stories-leave-this-computer`; any other value, including `1` and `true`, does not count as consent. An instance with other people's stories (the tester) does not get this value. For `openai-compatible`, the daily token limits from `local/budget.ts` also apply in the bot; they are changed by `SIMPLE_CHAT_BUDGET_REQUESTS` and `SIMPLE_CHAT_BUDGET_TOKENS`. `codex-cli` has no local counter: only the subscription limits the spending.

## Hosted APIs: `openai-compatible`

The adapter works with any API in the OpenAI Chat Completions format: `SIMPLE_CHAT_BASE_URL` sets the versioned root (`https://openrouter.ai/api/v1`, `https://api.openai.com/v1`), `SIMPLE_CHAT_API_KEY` and `SIMPLE_CHAT_MODEL` are required. The code is shared with `llama-cpp` and is in `local/llama.ts`. All runs of hosted models from the [log](improve-log.md) were made through it.

By default the connection serves only synthetic probes. A hosted provider may save requests and train on them: the free OpenRouter models and the free daily OpenAI quota are given on exactly these conditions. Therefore, without the [owner's consent](#consent-to-a-hosted-connection-for-the-bot), `loadConfig` refuses to start the bot with this provider, while `story:probe` reads `loadModelConfig` and works. `memory:probe` goes through the queue of the running bot and does not work with this connection yet.

Differences from llama.cpp:

- There is no exact input count before generation, and the adapter has no `countInput` method. Before the request, the application's estimate or bytes / 4 applies. After the response, the provider's `usage.prompt_tokens` applies: without it the result is rejected with `usage_unavailable`, and when the limit is exceeded, with `context_limit`. By this moment the text has already been shown through `onText`, but it does not become a scene.
- The llama.cpp fields (`top_k`, `min_p`, `chat_template_kwargs`, `cache_prompt`) are not sent. For `api.openai.com` the response limit is passed as `max_completion_tokens`, and the temperature is not passed: the current OpenAI models reject `max_tokens` and a non-standard temperature.
- `outputSchema` goes as a `response_format` of type `json_schema` with `strict: true`; for OpenRouter, `require_parameters` is added so that the request reaches only an executor that follows the schema. A model without `structured_outputs`, for example the free Gemma 4, fails on such a request instead of ignoring the schema. The application checks the result anyway.
- The model name in the stream is not compared: the provider answers with its own name, for example a dated snapshot. `check()` looks for the model in `/models`.
- Reasoning comes in a separate field (`reasoning` or `reasoning_content`) and is counted only as a number of characters. A reasoning model spends the response limit on it and may finish with `length`.

Limits as of 18 September 2026: the free OpenRouter models give 20 requests per minute and 1000 per day if credits of $10 or more have been bought over all time, otherwise 50 per day. [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits). `google/gemma-4-31b-it:free` declares a context of 262144 and the parameters `max_tokens`, `temperature`, `top_p`, `response_format`.

## Evaluating changes: `npm run eval`

The goal is one number for comparing versions of prompts and memory on several models at once. The keys of the hosted APIs are in `.env.eval` (template `.env.eval.example`); the probes are started in an empty directory, so the bot's `.env` does not reach them.

```
npm run eval -- write --model openrouter:google/gemma-4-31b-it:free
npm run eval -- --models openrouter:google/gemma-4-31b-it:free,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001
```

`write` writes the synthetic stories once through `story:probe` and saves them in `examples/frozen/<scenario>.json`; on `rate_limited` the probe continues from the last saved scene. The main command runs the same frozen scenes through the memory of each model (`memory:probe --direct`, modes `plain` and `sgr`) and compares the answers with `examples/memory-checks.ts`. Models go in parallel, scenarios go one after another.

With `--judge openai:gpt-5.4`, after the memory questions each model writes one scene for each of the trap moves from `examples/scene-traps.ts`, and the judge answers fixed yes/no questions (`local/scene-judge.ts`); the result is `sceneScore` next to `score`. `npm run eval -- judge --judge <model> --resume <probe directory> --mode plain` judges the finished scenes again.

`npm run eval -- watch` in another terminal shows the current run: the last event of each model, scenario and mode, and the spending for the day. Events are written to `logs/eval.jsonl`; they contain codes and counters, without text.

The final `score` for each mode equals the share of correct answers of the worst model: a change cannot win because of the most obedient model. An unfinished mode gives zero answers, and its error code stays in the report. The full report with the failed keys is written to `eval.json`; the path is printed in the last line. The checks are fixed, without a judge model; they do not measure the quality of the prose.

### The walk: `npm run eval -- walk`

The replay measures what a model keeps of a story someone else wrote. The walk measures whether a model keeps its own story straight: from a seed it writes every scene itself, one per step of `examples/walk/<name>.json` (in a pack, `<name>/walk.json`). An empty step is the bot's own continue signal; any other step is the author's intervention, given to the narrator as a player's message. Memory is compacted after scene 7 and every fourth scene after it, as in the replay. Afterwards a panel of judges reads each scene against the seed and everything before it and lists the contradictions it finds, with quotes (`local/walk-judge.ts`). A listed contradiction is an inconsistent verdict whatever the flag says; an inconsistent flag without one is an abstention. Then the council: every contradiction anyone listed goes back to every judge, with the same seed, history and scene, to confirm or refute by the text; the judge that listed it checks it too and may take it back. A finding stands when more judges confirm it than refute it, and a scene with a standing finding is inconsistent; a scene whose findings are all refuted is consistent although a judge had flagged it; a tie on a finding, with nothing confirmed, is `split`; a scene nobody voted on is `unjudged`. `score.walk` is the share of scenes the council found consistent among the scenes it decided (a `split` scene is neither for nor against the model and leaves the denominator; an `unjudged` one still counts against it), for the worst model, and `score.votes` is the same share from the first round's majority alone. An unfinished walk is judged on the scenes it has, and the scenes it lacks count against the model.

```
npm run eval -- walk --models claude:claude-haiku-4-5-20251001,claude:claude-opus-5-5 --judges claude:claude-opus-5-5,claude:claude-fable-5-1,codex:gpt-6-astra --out walk.json
```

Every judge's verdicts with their quotes stay next to the probe's report (`walk-judge-<judge>.json`, the council's checks in `walk-cross-<judge>.json`; the report directory is in the cell), and `npm run eval -- walk-judge --judge <model> --resume <directory>` adds a judge to a finished walk (`--cross` for its second round). Several judges are the point: one judge misreads a quote or has a taste of its own, and a model under test may also sit on the panel, so no scene is judged by one model alone. A walk is not a fixed set of questions: the model writes a different story each run, so compare walks the way the noise section of `docs/improve-loop.md` compares scenes, several runs per side.

A seed is audited before it grows anything: `npm run eval -- seed-audit --judges <models> --scenarios <walk> --out <directory>` asks every judge for the seed's own contradictions and its ambiguities (a time given without saying by which clock, a canister named by its capacity, a nail "right of the door" seen from nowhere), and writes them to `<directory>/<walk>/issues.json` next to one `seed-audit-<judge>.json` per judge. An ambiguity in the seed is a false finding later, on every scene, for or against the model depending on the judge's reading; fix the seed and audit again until the judges have only taste left to list.

### The gold tree: `npm run eval -- walk-gold` and `walk-nodes`

A walk compares whole stories, and two walks of one model differ in every scene. The gold tree fixes the prefixes: a tree of scenes grown from the seed that the council accepted, in the bot's own shape (every scene has a parent), kept next to the walk as `examples/walk/<name>.gold.json` (in a pack, `<name>/gold.json`) with a rendering for people beside it (`.gold.md` / `gold.md`), in which every scene nobody has read yet says so. The trunk follows the walk's steps; a branch is any other accepted continuation of a node.

`npm run eval -- walk-gold --writers <models> --judges <models> --scenarios <walk> [--depth n] [--attempts 1..8] [--out directory]` grows the trunk one depth at a time: every writer (`local/walk-step.ts`) continues the accepted prefix, seen whole, with the walk's next step; the council reads each new scene against the seed and the prefix (`walk-judge.ts --only`), and the gate is not the eval's majority but the agreement of every judge: a scene without findings in the first round, or one whose findings nobody confirms in the second, the judge that listed a finding included, which may take it back. A finding one judge still stands by keeps the scene out, however many refute it, and a judge with no verdict or no checks does not agree. Of the agreed scenes one becomes the trunk, the one with the fewest first-round dissenters and findings, a tie going to the writer with the fewest trunk nodes so far, so that the trunk is not one author's; the other accepted scenes are branches at once. A rejected scene stays in the tree's `rejected` list with the findings that stood against it, and its writer tries again, every second attempt as a repair of its last rejected text with those findings quoted; when no writer passes in `--attempts` rounds the trunk stops there and says so. The tree is saved after every depth, so a stopped run continues where it was. One writer is a gold set of one author's habits; the four strongest available, each judged by all four, is the intended use.

A scene every judge agreed to enters the tree as a **candidate**; it becomes **gold** by its ledger, not by the gate alone. Every node keeps a ledger: how many deeper scenes were judged with the node in their prefix (`seen`), every finding a judge listed against a deeper scene whose earlier quote stands in this node (`later`, with whether the finding stood after the cross round: a refuted one can still mean this node was the one at fault, and a person reads both kinds), every issue the whole-story audit placed in it (`audit`), and every fresh reading by the council (`recheck`). Five commands look after it. `eval gold-audit --judges <models> --scenarios <walk> --out <directory>` gives every judge the whole trunk at once, seed and all scenes, for contradictions between scenes that scene-by-scene reading let through and for the ambiguities the scenes themselves introduce; the merged list lands in `<directory>/<walk>/issues.json` and in the nodes' ledgers. `eval gold-recheck --judges <models> --scenarios <walk> [--nodes g1,g2]` judges every node again, fresh, records the outcome in its ledger and reports how many the judges agree to a second time: the gate's own noise, measured. A judging in which a judge answered nothing (a failed probe, a timeout) is the provider's silence, not a reading: it enters no ledger, a recheck with a silent judge is not held, an attempt refused by silence alone is retried without a repair, and the recheck run stops when every judge is silent. `eval gold-stats` also writes `pathTokens` into every node when the `tiktoken` package is installed (`npm install`; a dependency of the eval only, `npm test` runs without it): the tokens of the seed, the steps and the scenes from the root to the node by one public ruler, OpenAI's `o200k_base`, the same counts as the Python package, so that a dataset can state what a model was asked to read; `walk-nodes --max-path-tokens n` keeps only the tasks whose prefix fits, one limit per run named in the report with the tasks it admitted, so that weaker models are measured on the same nodes and the frontier on the whole tree; the tree itself is never capped. `eval gold-promote --scenarios <walk> [--rechecks 2] [--exposures 8]` makes gold of every candidate with that many agreed rechecks, that many deeper scenes judged over it with no later finding that stood, and nothing from the audit; the thresholds are the flags, and a promoted node stays gold. `eval gold-stats` prints the ledger's numbers, per judge as well: who points at earlier scenes late and how often that stands. `eval gold-read --scenarios <walk> --nodes g1,g2` records that a person has read those scenes; that is kept apart from the rule and shown next to it, because the council is made of models and the writers sit on it.

`npm run eval -- walk-nodes --models <models> --judges <models> --scenarios <walk> [--branches k] [--no-grow] [--max-path-tokens n] [--out file]` is the eval over the tree: every model continues from the seed and from every trunk node with the trunk's next step, and from up to `k` branch nodes drawn at random (named in the report), each time through its own memory compaction of the prefix on the walk's schedule, as the bot would (`walk-step.ts --compact`); a deeper task of the same path reuses the library a shallower one left, the compaction being the same request either way. The council reads each new scene against the gold prefix; `score.nodes` is the share of consistent scenes among the decided ones, for the worst model, and `byDepth` in the report is the verdict at every depth of the trunk, so a model that holds the first seven scenes and loses the ninth is seen losing the ninth. A scene every judge agrees to joins the tree as a branch, whoever wrote it, unless `--no-grow`; so the tree grows with every run, and the next run has more prefixes to draw from. Every model gets the same tasks in one run; between runs the tree has changed, so compare models within a run.

## Daily limits of hosted APIs

Every `openai-compatible` request goes through `local/budget.ts`. The counter is in `eval-usage.sqlite` in the project root and is shared by parallel probes; it holds the day in UTC, the channel name, the number of requests and tokens, without text. `npm run eval -- usage` shows today's spending and the limits in effect.

| Channel | What goes into it | Default limit |
| --- | --- | --- |
| `openrouter-free` | OpenRouter models with `:free` | 900 requests |
| `openrouter-paid` | the other OpenRouter models | closed |
| `openai-small` | mini and nano from the free OpenAI quota | 2 250 000 tokens |
| `openai-large` | large models from the same quota | 225 000 tokens |
| `cerebras` | all Cerebras models | 900 000 tokens |
| `groq` | all Groq models | 900 requests and 180 000 tokens |
| `mistral` | all Mistral models | 500 000 tokens |
| `openai-paid`, `other` | everything else | closed |

The default values are one tenth below the free quotas. A paid channel is closed until a limit is set by hand in `.env.eval` (`OPENROUTER_PAID_DAILY_TOKENS` and similar) or through `SIMPLE_CHAT_BUDGET_REQUESTS` and `SIMPLE_CHAT_BUDGET_TOKENS` when a probe is started directly. Before sending, the input estimate plus the whole response limit is reserved; after the response, the reserve is replaced with the provider's `usage`. A request that failed keeps its reserve: it is unknown whether the provider counted it. Exceeding the limit gives `budget_exceeded` before sending.

This is a local counter: it does not see spending from other computers or from other programs. The hard boundary is set by the provider itself: an OpenRouter key has a credit limit, an OpenAI project has a monthly budget.

