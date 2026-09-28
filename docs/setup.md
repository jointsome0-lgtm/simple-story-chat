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
| `SIMPLE_CHAT_SHEET_VERSION_USERS` | Optional: numeric Telegram IDs separated by commas, all of them from `SIMPLE_CHAT_IMAGE_USERS`. **Empty by default.** Their frames name the lasting changes the story makes to a person's look, which then hold from that scene on down its line, and they may write a person's text «only from this moment» ([along the story](telegram-ui.md#along-the-story)). Everybody else's frames are as before |
| `SIMPLE_CHAT_POSE_SET_USERS` | Optional: numeric Telegram IDs separated by commas, all of them from `SIMPLE_CHAT_IMAGE_REFERENCE_USERS`. **Empty by default.** They may give a person up to 100 pictures, which a small model on this computer sorts by pose, and each frame takes the one that fits ([pose sets](#pose-sets)). Everybody else's frames are as before |

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

The `SIMPLE_CHAT_IMAGE_*` variables above belong to the bot on this computer. The picture card has its own: `SIMPLE_CHAT_IMAGE_QWEN` is read by [the bootstrap on the card](gpu.md#qwen-image) and decides which checkpoints it downloads, and `SIMPLE_CHAT_IMAGE_TORCH` which torch it installs and the server runs, cu130 on [the bot's card](gpu.md#bot-card); the bot never reads them. Before each picture it asks the server whether to draw with the kitchen's attention.

`SIMPLE_CHAT_IMAGE_REFERENCES=true` enables the kept-portrait experiment for `SIMPLE_CHAT_OWNER_ID`. It is
`false` by default. To admit a tester as well, put their Telegram ID in `SIMPLE_CHAT_IMAGE_REFERENCE_USERS`, a
comma-separated list that is empty by default. Every listed ID must already be in `SIMPLE_CHAT_IMAGE_USERS`.
The owner must also be in `SIMPLE_CHAT_IMAGE_USERS`; readers outside the experiment always get ordinary frames.
Keep `SIMPLE_CHAT_IMAGE_WORKFLOW=gpu/image-workflow-qwen.json`. The bot adds the reference nodes to Qwen's graph
only when a permitted reader's frame contains somebody with a kept portrait. Missing portraits leave those people's words
unchanged, and a frame with no portraits uses the ordinary prompt and graph. Other models draw ordinary frames.
Set the variable in the bot's launch environment or its chosen local profile, then restart the bot. Its readers may
also send a picture of a person of their own, which frames take in the kept portrait's place
([references](telegram-ui.md#references)).

The experiment keeps each person's full appearance and build words, names the chosen medium first, and asks Qwen
to take identity alone from the portraits. It sends each whole portrait at its own shape, scaled to about the area of
352x640 with sides in multiples of 32: the bot's portraits of 720x1280 at 352x640, a square picture at 480x480, never
one stretched to another shape. The frame keeps its usual canvas, seed and sampler settings. This combines C's reference path with proposed wording; its pictures have not
been judged. The owner should compare faces, builds, relative heights, scene poses and clothes, and the chosen style.

A frame's recipe pins its ordered portrait files and hashes. Variants and redraws, including style samples, reuse
those files after the reader keeps a new portrait. Old recipes remain text-only. Turning the setting off disables
references on those paths too. A missing or changed file, failed upload or explicit graph rejection falls back to
an ordinary drawing and records why. An uncertain submission or failure after acceptance does not start a second
job. Variants still draw the whole prompt the reader supplied, including any image numbers in it.

Before enabling this on a card, install this branch's `gpu/image-sweeper.py` and launch through `gpu/image-serve.sh`.
Portraits, drawn or the reader's own, use the RAM temp directory and are blanked after the job; the disk-backed input
upload used by experiments is never used here. See [the retention rules](gpu.md#what-the-card-keeps-of-a-picture). With the experiment enabled, the
`picture_references` row gives `referenceCount`, `referenceAttempted` and `pictureReferences`: `used`, `not_allowed`,
`no_portrait`, `legacy`, `unsupported_graph`, `unavailable`, `upload_failed` or `graph_rejected`.
`picture_reference_cleanup` gives the number of uploaded files and `referenceCleanup`, whether every blank overwrite
was acknowledged. Neither row contains a name, path, hash, portrait or prompt. A failed cleanup leaves the sweeper's
ten-minute cap in force.

<a id='pose-sets'></a>

#### Pose sets

`SIMPLE_CHAT_POSE_SET_USERS` gives readers of the reference experiment pose sets ([what a reader gets](telegram-ui.md#pose-set)):
up to 100 pictures of a person, sent at once, captioned by pose on this computer and sorted into six groups at most, of
which each frame takes the one whose pose fits. Every listed ID must be in `SIMPLE_CHAT_IMAGE_REFERENCE_USERS`, the
owner's too. A set works only while `SIMPLE_CHAT_IMAGE_REFERENCES=true` and `SIMPLE_CHAT_PROVIDER` is `llama-cpp` or
`simple-serving`, since the captions go into each frame's request and no hosted API is to see them; otherwise a reader's
sets stay and can be removed, and frames do not take them. With the list empty nothing changes for anybody.

Pose sets are switched off by taking the reader off the list, or emptying it, and restarting: their sets stay, and new
frames do not take them, while a variant or a style sample of a frame drawn with a set's picture still takes it, as its
recipe says. Going back to code from before pose sets costs the readers their sets: its first start deletes the sets'
files, all but those frames were drawn with, and it drops a person's set when it writes a sheet again. Back up first
([Backup and restore](#backup-and-restore)) if the pictures are to be kept.

The captioner runs beside the bot, on this computer's CPU, and the bot starts and ends it itself. Install it once, in
the tree the bot's code runs from:

```sh
bash captioner/setup.sh
```

The bot looks for `captioner/.venv`, `captioner/caption.py` and `models/pose-captioner` beside its own `local/`, not in
the directory it is started in, which holds `.env` and the data: a bot started in the main tree with its code from a
worktree finds the captioner the worktree has.

It makes a CPU-only Python environment in `captioner/.venv` (Python 3.14, torch 2.14.0, transformers 5.17.0, Pillow
12.3.0, all pinned) and downloads openjev 0.8B (`AlexWortega/openjev` at revision
`a298f274886c4676c42f1a4262401b6aa9653e6d`, MIT) into `models/pose-captioner`: six files, 1.73 GB, each checked
against its SHA256 before it is kept. It needs uv and about 3.5 GB of disk with the environment. Without it the pictures
are kept and wait uncaptioned, the bot logs `pose_captioner_failed` with `captioner_unavailable` and tries again every
ten minutes, and frames take nobody's set until their pictures are captioned; nothing else is affected.

The captioner reads each picture from the reader's directory beside the database and answers with three labels and a
number; it opens no connection, gets none of the bot's environment, and runs niced on four threads. It takes about 4 s
of the CPU a picture, once, and about 4 GB of memory while it runs (5.7 GB at its peak as it loads), and ends a minute
after the last picture. It runs here rather than on the picture card: the pictures and their captions never leave this
computer, no card is rented or woken for them, the card's memory stays ComfyUI's, and the bot itself gets no image
library. What it was chosen by, and its limits, are in [the measurement](knowledge/pose-captioner-2026-09-28.md).

The limits: 100 pictures and 300 MB a person, 600 MB a reader, and each picture as a picture of the reader's own
([references](telegram-ui.md#references)): a drawing, PNG, JPEG or WebP, at most 10 MB, the shorter side at least 320
pixels, the longer at most 4096 and 2.5 times the shorter, with its metadata stripped. Frames take the chosen picture
with the experiment's instruction unchanged, which tells the picture model to take identity alone from a reference; what
a fitting pose does to the pictures has not been measured.

### Backup and restore

The database is the file at `SIMPLE_CHAT_DB_PATH`. The portraits readers keep lie beside it in `<path>.portraits/`, and only the database says whose each one is: a backup takes both, copied while the bot is stopped, so that no portrait is kept or swept in between.
A picture a reader sends as a person's own portrait lies there too, in the format it came in and stripped of its metadata on its way in, and is kept and swept as a portrait is: while the sheet or a recipe refers to it, and no longer. So do the pictures of a [pose set](#pose-sets), up to 600 MB a reader.
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
