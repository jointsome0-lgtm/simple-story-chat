# Agent interface

A way for an AI agent to use the story engine without Telegram. It serves two users:

- **a co-author or player** that runs a live story: seed, turns, branches;
- **a consistency tester** that plays long stories and looks for contradictions, so it can see the memory and the
  checkpoints.

It is not a way into the Telegram libraries of people, and it is not another eval (`npm run eval` measures world
consistency on fixed scenarios, see [eval.md](eval.md)).

A turn runs the same code as the bot: `local/turn.ts` takes the job lock, generates the scene (with automatic
compaction), saves it with its usage and request stamp, and saves the scene's checkpoint. The bot adds Telegram
delivery on top; the agent interface adds receipts.

| File                    | What it is                                                          |
|-------------------------|---------------------------------------------------------------------|
| `local/agent-api.ts`    | The contract as plain functions over the agent library. No packages. |
| `local/agent-cli.ts`    | `npm run --silent agent -- <call> --json '{...}'`: one JSON object on stdout per call. |
| `local/mcp.ts`          | `npm run --silent mcp`: an MCP server over stdio, one tool per call. |

## Privacy: a separate library

The agent interface has its own SQLite file, `data/agents.sqlite` by default (`SIMPLE_CHAT_AGENT_DB_PATH`), and its
own user ids (`agent` by default; `--agent <id>` or `SIMPLE_CHAT_AGENT_ID` for another). It never opens the bot's
database: the loader refuses its path, also through a symlink or a hard link. Use synthetic stories. Technical log rows go to stderr and carry
only codes, enums and counts (`safeErrorDetails` in `local/model-error.ts`), with `actor: agent`; never story text,
prompts or model output. The stories and results themselves are in the agent library, like the bot's are in its own.

## Model access

The same model configuration as the bot (`.env`, or `.env.gpu` with the `:gpu` scripts), and the same
[consent gate](model-providers.md#consent-to-a-hosted-connection-for-the-bot): an `openai-compatible` or `codex-cli`
provider needs `SIMPLE_CHAT_ALLOW_HOSTED=stories-leave-this-computer`, exactly as for the bot.

When the bot runs with [GPU control](llama-cpp.md#managed-gpu) it serves its model queue on `<bot database>.model.sock` (`local/background.ts`).
If that socket answers, agent turns go through it in their own queue (`local/scheduler.ts`), between people and
disposable probes:

- people in Telegram go first: an agent call starts only after the bot has been quiet for a minute and the GPU is
  ready. Until then it waits in the queue; the agent's `wait` keeps answering `running`;
- once started, a turn keeps the model to its end, so the GPU does real work while people read: nobody runs between its
  compaction steps and its scene, so a started step is never cut off and another turn's prompt never evicts its cache.
  (The compaction and the scene have different system prompts, so llama.cpp reuses only their common prefix; the turn
  does not make the scene's prefill free.) A person who writes meanwhile waits for the rest of that turn, up to a
  couple of minutes, and sees their place in the queue. The agent holds a
  control request to the bot for the whole turn; when it closes, or the agent process dies, the turn ends, its running
  call stops and a later call under its id is refused. An agent call has no time limit of its own, only the model's
  timeout;
- an agent call stops a running probe;
- a stopped or paused GPU gives `failed` / `gpu_not_ready` at once and is never woken for an agent. A started turn keeps
  the GPU up from its first call to its end, the gaps between its calls included, and past its end until its last call
  has ended on the server: the auto-pause counts from then, and a manual pause waits for it (the bot shows the GPU
  draining). If the GPU stops or fails anyway, the turn ends `preempted` (`background_unavailable`). It is never rerun
  silently; ask again with a new `requestId`.

The queue checks that it serves the configured model, so start the agent with the bot's model configuration
(`npm run agent:gpu`, `npm run mcp:gpu`). Without the socket the agent calls the configured provider directly. With
`simple-serving` it always does, whatever socket answers, checks the service before its first count or generation, and
says each call is an agent's ([model providers](model-providers.md#simple-serving-our-gateway)). The
route is chosen at the first model call of a turn and kept to the turn's end; the next turn checks the queue again, so
an MCP server started before the bot switches to its queue once the bot is up. A turn never changes route midway: if
its queue goes away, it ends `preempted` (`background_unavailable`) rather than go on as a new direct request.

## The contract

Every response has one shape:

```json
{ "requestId": "…", "status": "done|running|failed|interrupted|preempted|conflict|stale|busy", "result": {}, "reason": "code" }
```

`reason` is a code from `REASONS` in `local/model-error.ts`, never provider text. A scene is
`{ sceneId, worldTime, text, truncated }`. `revision` is an opaque hash of the branch's head and memory.

| Call | Arguments | `result` when done |
|------|-----------|--------------------|
| `create_seed` | `requestId, text` | `{ seedId, title, worldTime }` |
| `start_story` | `requestId, seedId, wait?` | `{ storyId, branchId, scene, checkpointId, revision }` |
| `act` | `requestId, storyId, branchId, expected, input?, wait?` | `{ scene, checkpointId, revision, compaction? }` |
| `fork` | `requestId, storyId, checkpointId` | `{ branchId, revision }` |
| `read` | `storyId?, branchId?, scenes?, memory?` | see below |
| `status` | `requestId` | the stored response |
| `wait` | `requestId, seconds?` | the stored response, once it is not `running` or the time is up |
| `cancel` | `requestId` | MCP only; the stored response after cancelling |

- **Seeds** use the bot's parser: title, then the world time as `2026-08-02 20:00`, then the world; up to 256 KiB.
- **`act`**: an empty `input` is the bot's "continue"; on a branch without scenes it is the bot's "start". The story's
  language follows the seed (`local/story-text.ts`).
- **`fork`** starts from a checkpoint, which carries both the head and the memory; a scene id alone would not. Every
  scene has one (`kind: scene`); an automatic compaction adds `pre-compaction` and `compaction` (after compaction);
  there are also `start` and `fork`.
- **`compaction`** in an `act` result lists the memory increments and checkpoints that a compaction saved during the
  turn.
- **`read`** changes nothing. Without `storyId` it lists seeds and stories with their branches and revisions. With it,
  for one branch (the last used, or `branchId`): `revision`, `sceneCount`, the last `scenes` scenes (3 by default),
  each with the `input` it answered, all checkpoints of the branch with `kind`, `label`, `sceneId` and `memoryId`, and
  with `memory: true` the memory increments: `memoryId`, `parent`, `cutoff`, `covered` scene ids and `facts`, each fact
  with the `source` scene ids it comes from.

## Statuses and retries

- `done`: finished; `result` as above.
- `running`: the turn is still generating. `act` and `start_story` wait `wait` seconds (default
  `SIMPLE_CHAT_AGENT_WAIT_SECONDS`, 20), then answer `running`; continue with `wait`.
- `failed`: with a `reason`, such as `context_limit`, `timeout`, `cancelled`, `not_found`, `seed_format`,
  `invalid_request`. A failed turn's `result` names what stays saved: `scene: null`, the `revision`, and a `compaction`
  if one committed before the scene failed.
- `interrupted`: the process stopped during the turn (`shutdown` for a clean stop, `process_exited` after a crash). The
  result names the saved point as for `failed`.
- `preempted`: the GPU was paused under the call; see Model access.
- `stale`: `expected` is not the branch's revision; `result.revision` is the current one. Nothing was generated.
- `busy`: the library already has a running turn (`result.runningRequestId`), or another process holds the library
  (`library_locked`). One agent id runs one turn at a time.
- `conflict`: the `requestId` was used with other arguments.

Each `requestId` is stored with a hash of its arguments. The same key with the same arguments returns the stored
response **before any check of the current state**: a retry after a lost response gets `done`, not `stale`, even though
the branch has moved. `status`, `wait` and a repeated `requestId` never start a generation. `stale`, `busy`, `conflict`
and invalid calls change nothing and are not stored; the key can be used again.

## Lifecycle

- **One writer per library.** A process that writes takes `flock` on `<agent database>.lock` for its whole life; a
  second writer gets `busy` / `library_locked`. `read`, `status` and `wait` from the CLI only read, and may run beside
  the writer.
- **Receipts are atomic with the story.** A receipt is written in the same transaction as the job lock and in the same
  transaction as the committed scene. A cancel that races a commit finds the turn `done` and leaves it so.
- **The MCP server** is long-lived: a turn keeps generating after its `wait` expires, and `cancel` reaches it.
- **The CLI** runs one call. The process that starts a turn is the one that generates it, so `start_story` and `act`
  stay in the foreground until the turn ends (compaction progress on stderr) and never answer `running`. There is no
  `cancel` command: Ctrl-C or SIGTERM stops the turn as `interrupted` / `shutdown`. `wait` from another shell reads the
  receipt and may end with `running` while the writer works.
- **After a crash** the next writer that opens the library marks every `running` receipt `interrupted` /
  `process_exited` and releases the job; no model call is retried.

## Example session

CLI (`--silent` keeps npm's banner off stdout; `--json -` reads the arguments from stdin):

```sh
npm run --silent agent -- create_seed --json '{"requestId":"seed-1","text":"Lighthouse\n2026-08-02 20:00\nA keeper waits for a boat in a storm. The password is NORTH."}'
# {"requestId":"seed-1","status":"done","result":{"seedId":"s1","title":"Lighthouse","worldTime":"2026-08-02 20:00"}}
npm run --silent agent -- start_story --json '{"requestId":"start-1","seedId":"s1"}'
# {"requestId":"start-1","status":"done","result":{"storyId":"h2","branchId":"b3","scene":{…},"checkpointId":"c7","revision":"k3…"}}
npm run --silent agent -- act --json '{"requestId":"act-1","storyId":"h2","branchId":"b3","expected":"k3…","input":"I ask the boatman for the password."}'
npm run --silent agent -- read --json '{"storyId":"h2","scenes":5,"memory":true}'
npm run --silent agent -- fork --json '{"requestId":"fork-1","storyId":"h2","checkpointId":"c7"}'
```

The exit code is 0 for `done` (and `running`), 1 for any other status, 2 for a malformed command line.

MCP for Claude Code, in `.mcp.json` at the repository root (or `claude mcp add story -- node local/mcp.ts` from it):

```json
{ "mcpServers": { "story": { "command": "node", "args": ["local/mcp.ts"] } } }
```

For Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.story]
command = "npm"
args = ["run", "--silent", "--prefix", "/path/to/simple-story-chat", "mcp"]
```

`npm install` first: the MCP server needs its one runtime dependency, `@modelcontextprotocol/sdk`. The server reads
`.env` and resolves the library path from its working directory, so it must start in the repository (`--prefix` does
that for npm). With a GPU run of the bot, use
`node --env-file=.env.gpu local/mcp.ts` so the model matches the bot's queue. While the MCP server runs it is the
library's writer, so CLI writers answer `busy`.
