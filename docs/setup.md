# Setup and first test

The bot runs as a local process on a computer and uses the ordinary Telegram Bot API. You do not need to install
Telegram Desktop: the bot is available from the ordinary phone app or from Telegram Web.

## Preparation

1. Create an ordinary bot with `/newbot` in [BotFather](https://t.me/BotFather). Keep its token only on your computer.
2. Copy `.env.example` to `.env` and set the permissions with `chmod 600 .env`.
3. Fill in `TELEGRAM_BOT_TOKEN` and `SIMPLE_CHAT_ALLOWED_USER_IDS`. At first add only your own numeric Telegram ID.
4. For the default connection, install Claude Code and sign in with your subscription through the ordinary CLI login; it does not need an API key. The other connections are set by `SIMPLE_CHAT_PROVIDER` in the table below.
5. Run `npm start` from the project root. It requires Linux, Node 24.9+ and `flock`. The computer must stay on while the bot is running.

After the rename to `simple-story-chat`, the `SIMPLE_CHAT_*` variables, the database path `data/simple-chat.sqlite` and the SSH alias `simple-chat-vast` were kept for compatibility with the existing configuration.

## Settings

The variables go in `.env`, and [.env.example](../.env.example) is the starting point for it.

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The secret token of the ordinary bot |
| `SIMPLE_CHAT_ALLOWED_USER_IDS` | Numeric IDs separated by commas, no public access |
| `SIMPLE_CHAT_OWNER_ID` | The ID of the owner, who allowed their own messages to be read for debugging; it is not a permission to read other users. It must be on the access list. The bot uses it to mark log rows as `actor: owner`; the other rows get `other` |
| `SIMPLE_CHAT_DB_PATH` | `data/simple-chat.sqlite` by default; you can choose a local path on the computer or on a server. The portraits readers keep lie beside it ([backup](#backup-and-restore)) |
| `SIMPLE_CHAT_PROVIDER` | `claude-code`, `llama-cpp`, `simple-serving`, `codex-cli` or `openai-compatible`. `claude-code` by default. `simple-serving` is our own gateway on a rented card ([details](model-providers.md#simple-serving-our-gateway)). More in [model settings](#model-settings) |
| `SIMPLE_CHAT_ALLOW_HOSTED` | Exactly `stories-leave-this-computer`, so that the bot starts with `codex-cli` or `openai-compatible`. Only for your own stories; any other value does not count as consent |
| `SIMPLE_CHAT_MODEL` | `claude-haiku-4-5-20251001` by default; required for `codex-cli`, `openai-compatible` and `simple-serving` |
| `SIMPLE_CHAT_CONTEXT_TOKENS` | 65536, including the reserve for the reply; the CLI uses a conservative estimate of the input |
| `SIMPLE_CHAT_MAX_OUTPUT_TOKENS` | The maximum size of the reply, 4096 by default, from 256 to 8192 |
| `SIMPLE_CHAT_COMPACT_AT_TOKENS` | The input threshold of automatic compaction: 54000 for Claude Code and Codex CLI, 44000 for the others |
| `SIMPLE_CHAT_KEEP_SCENES` | How many of the latest scenes to keep in full, 4 by default |
| `SIMPLE_CHAT_API_KEY`, `SIMPLE_CHAT_BASE_URL` | The key and the root address of llama.cpp, of our gateway or of a hosted API; empty for Claude Code and Codex CLI. The gateway (`simple-serving`) needs its key even over a tunnel |
| `SIMPLE_CHAT_MODEL_TIMEOUT_MS` | The timeout of a model call through the CLI or HTTP; 300000 ms by default, 600000 ms in the GPU example |
| `SIMPLE_CHAT_TEMPERATURE` | The temperature of a fiction reply over HTTP, 0.8 by default; `api.openai.com` gets none |
| `SIMPLE_CHAT_MEMORY_MODE` | `plain` (the default) or the experimental `sgr` ([context and memory](model-providers.md#memory-and-context)) |
| `SIMPLE_CHAT_BUDGET_REQUESTS`, `SIMPLE_CHAT_BUDGET_TOKENS` | Daily limits for `openai-compatible`; without them the channel's [defaults](eval.md#daily-limits) apply |
| `SIMPLE_CHAT_VAST_INSTANCE_ID`, `SIMPLE_CHAT_VAST_API_KEY` | Optional: the Vast.ai instance that the bot starts and stops by itself, with `llama-cpp` only ([instructions](llama-cpp.md#managed-gpu)) |
| `SIMPLE_CHAT_IMAGE_URL` | Optional: the loopback end of the tunnel to the picture card, such as `http://127.0.0.1:8188`. Without it there are no pictures ([pictures](#pictures)) |
| `SIMPLE_CHAT_IMAGE_WORKFLOW` | The ComfyUI graph to draw with, exported in API format (Workflow > Export (API)), such as `gpu/image-workflow-qwen.json`; a relative path is read beside `.env`. Required when the URL is set, and checked at startup ([pictures](#pictures)) |
| `SIMPLE_CHAT_IMAGE_CHECKPOINT` | The name of the checkpoint file on the picture card, as its `checkpoints` folder writes it. Required when the URL is set |
| `SIMPLE_CHAT_IMAGE_USERS` | Numeric Telegram IDs separated by commas, all of them from `SIMPLE_CHAT_ALLOWED_USER_IDS`. **Empty by default: nobody gets pictures.** Everybody else reads exactly as before, and their scenes never reach the picture card |
| `SIMPLE_CHAT_IMAGE_STYLE` | Optional: one line, the [picture style](telegram-ui.md#picture-styles) of a reader who has not chosen another; by default the line the [six steps](illustrations-plan.md#description-steps) were measured with |
| `SIMPLE_CHAT_IMAGE_WAIT_SECONDS` | Optional: how long one picture may take, 180 by default (5 to 1800). A picture that outlives it is stopped on the card; the story is not affected either way |

### Model settings

What each adapter does and needs is in [model-providers.md](model-providers.md#adapters). `codex-cli` and
`openai-compatible` send the story to a third-party service, and without `SIMPLE_CHAT_ALLOW_HOSTED` they are suitable
only for probes ([consent](model-providers.md#consent-to-a-hosted-connection-for-the-bot)).

For Gemma on a rented GPU there are [a separate `.env.gpu` profile and instructions](llama-cpp.md). The `npm run start:gpu` command uses the same Telegram settings and database, and replaces the model connection. First you must prepare the server and pass `npm run model:probe`.

### Pictures

What a reader gets is in [telegram-ui.md](telegram-ui.md#picture-delivery). Without `SIMPLE_CHAT_IMAGE_URL` the feature is off — no second model call, no status line, no picture.
The URL is the loopback end of the ssh tunnel to the card that draws, such as `http://127.0.0.1:8188` (`bash gpu/tunnel.sh --pictures`), never a published address and never the language model's own server: one card cannot hold both models.
A picture machine of its own is reached with `bash gpu/tunnel.sh --pictures-only ALIAS`.

The bot turns every saving node of `SIMPLE_CHAT_IMAGE_WORKFLOW` into a preview one, so that no reader's picture
reaches the card's `output/` folder. The card still holds each picture for a while as a job record, a temp file and
the server's cache, and each is emptied on its own schedule:
[what the card keeps of a picture](gpu.md#what-the-card-keeps-of-a-picture).

The `SIMPLE_CHAT_IMAGE_*` variables above belong to the bot on this computer. The picture card has one of its own: `SIMPLE_CHAT_IMAGE_QWEN` is read by [the bootstrap on the card](gpu.md#qwen-image) and decides which checkpoints it downloads; the bot never reads it.

### Backup and restore

The database is the file at `SIMPLE_CHAT_DB_PATH`. The portraits readers keep lie beside it in `<path>.portraits/`, and only the database says whose each one is: a backup takes both, copied while the bot is stopped, so that no portrait is kept or swept in between.
Restore both from the same backup, also while the bot is stopped: at startup the bot deletes every portrait file that
its library does not refer to (`sweepPortraits` in `local/store.ts`).

## Running

`.env` is read at startup; the environment variables of the process take priority. Restart the bot after you change the settings.

To run the bot in the background you can use tmux:

```sh
tmux new -s simple-story-chat-bot 'npm start'
# Detach: Ctrl+B, then D.
# Return: tmux attach -t simple-story-chat-bot
```

If the session already exists, attach to it; do not start a second instance. `flock` also prevents two processes from working with one database at the same time. To stop: Ctrl+C in the bot session. An unfinished reply is not repeated automatically; the scenes that are already saved remain.

At startup the bot checks that no webhook is set. If a webhook is configured, the bot stops; it does not change somebody else's configuration automatically.

## First run

Open your bot with the link `https://t.me/<bot_name>` and send `/start`. Press **Новый сид** ("New seed") and copy the example that is shown, or write your own seed after the same pattern. Send all the parts, press **Сохранить сид** ("Save seed"), then **Начать новую историю** ("Start a new story").

Check several continuations: free text, an author's instruction, the **Продолжить** ("Continue") button. Then open **Чекпоинты** ("Checkpoints"), choose an early scene and press **Продолжить отсюда** ("Continue from here"). Write a different action. Through **Ветки** ("Branches") you can return to the original line of events.

Every screen and command, `/last`, `/cancel`, `/compact`, `/context` and `/model` among them, is described in
[telegram-ui.md](telegram-ui.md#user-paths), and the limits of a Telegram message in
[its last section](telegram-ui.md#telegram-limits).

<a id='access'></a>

## Giving access to another person

This section uses our own setup as the example: a tester who writes on a Gemma model on a rented GPU. Connect the model, check that it works and add the tester's ID to the access list. The tester gets a link to the bot and presses Start. The tester does not need the source code, the bot token or an account at the GPU service. `/model` shows the model and the state of the rental.
If the GPU is stopped, the tester presses «Запустить GPU» ("Start GPU") there; an ordinary message does not start it
([pause from Telegram](llama-cpp.md#managed-gpu)).

If the tester is not on the access list yet, their personal `/start` command saves only the ID and the time of the request in the private metadata of the database (`access_requests`, no more than 100 senders). Access is not opened automatically. Other messages from such users are not saved and are not passed to the model. The administrator adds the ID to `.env` and restarts the bot; after that the tester opens `/start` or `/menu` again.

We do not open or export the tester's stories for debugging. The tester describes the problem and, if they wish, sends a chosen excerpt. We store the library separately from the public code and back it up on the machine where the bot runs.

Access to the bot gives nobody permission to read another person's library, the owner included. Only the owner's own
stories may be read, and only to debug the bot ([privacy](../AGENTS.md#privacy-whose-data-you-may-read)).

<a id='synthetic-checks'></a>

## Repeatable scenario tests

`npm run story:probe` creates a separate synthetic story on the model from the configuration, without the bot's database or Telegram. Choose the scenario with `--scenario battle`, `--scenario chess` or `--scenario dance`. For Opus: `npm run story:probe -- --scenario chess --model claude-opus-5`. For a GPU that is already prepared: `node --env-file=.env.gpu local/story-probe.ts --scenario chess`.

Each scenario has 16 turns, manual compactions after the seventh, eleventh and fifteenth scenes, a continuation and a
final question about the facts kept; the originals, the increments and the metrics go to the printed
`/tmp/simple-chat-<scenario>-*`. It checks memory on a small story. Capacity and cache at about 59K input tokens are
for `npm run model:probe -- --long` ([llama-cpp.md](llama-cpp.md#connection-and-check)).

Compare the memory with the scenes themselves: the time and the target of a combat move, the spending of a resource, an injury and its treatment, the handover of an item, the keeping of a promise, the date of an event and the date when the information was received, a cancelled plan and the terms of a truce. Valid JSON and references to all scenes do not prove by themselves that the model kept every fact.

The chess scenario plays the Kasparov–Topalov game of 1999 with fictional characters
([PGN](https://en.chessbase.com/portals/all/2021/03/throwback-kasparov/kasparov-topalov.pgn), positions in
`examples/chess-reference.json`) and shows the model only the next moves. The dance scenario, under a fictional
rulebook, checks versions of moves, training statistics and a judge's corrected score.

`npm run story:probe -- --scenario chess --resume /tmp/simple-chat-chess-XXXXXX` continues a stopped test from its
saved scene once the old process has exited, on the same provider and model; only the unfinished call runs again.
For Claude Code, `--effort medium` can be set, and the resume report records it.

The eval's commands are in [eval.md](eval.md).
