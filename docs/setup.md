# Setup and first test

The bot now runs as a local process on a computer and uses the ordinary Telegram Bot API. The owner's account does not have access to Telegram Serverless yet. You do not need to install Telegram Desktop: the bot is available from the ordinary phone app or from Telegram Web.

## Preparation

1. Create an ordinary bot with `/newbot` in [BotFather](https://t.me/BotFather). Keep its token only on your computer.
2. Copy `.env.example` to `.env` and set the permissions with `chmod 600 .env`.
3. Fill in `TELEGRAM_BOT_TOKEN` and `SIMPLE_CHAT_ALLOWED_USER_IDS`. At first add only your own numeric Telegram ID.
4. For the default connection, install Claude Code and sign in with your subscription through the ordinary CLI login; it does not need an API key. The other connections are set by `SIMPLE_CHAT_PROVIDER` in the table below.
5. Run `npm start` from the project root. It requires Linux, Node 24.9+ and `flock`. The computer must stay on while the bot is running.

`.env` is read at startup; the environment variables of the process take priority. Restart the bot after you change the settings.

After the rename to `simple-story-chat`, the `SIMPLE_CHAT_*` variables, the database path `data/simple-chat.sqlite` and the SSH alias `simple-chat-vast` were kept for compatibility with the existing configuration.

| Variable | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The secret token of the ordinary bot |
| `SIMPLE_CHAT_ALLOWED_USER_IDS` | Numeric IDs separated by commas, no public access |
| `SIMPLE_CHAT_OWNER_ID` | The ID of the owner, who allowed their own messages to be read for debugging; it is not a permission to read other users. It must be on the access list. The bot uses it to mark log rows as `actor: owner`; the other rows get `other` |
| `SIMPLE_CHAT_DB_PATH` | `data/simple-chat.sqlite` by default; you can choose a local path on the computer or on a server |
| `SIMPLE_CHAT_PROVIDER` | `claude-code`, `llama-cpp`, `codex-cli` or `openai-compatible`. The last two send the story to a third-party service, and without the consent below they are suitable only for probes ([details](model-providers.md)) |
| `SIMPLE_CHAT_ALLOW_HOSTED` | Exactly `stories-leave-this-computer`, so that the bot starts with `codex-cli` or `openai-compatible`. Only for your own stories; any other value does not count as consent |
| `SIMPLE_CHAT_MODEL` | `claude-haiku-4-5-20251001` by default; required for `codex-cli` and `openai-compatible` |
| `SIMPLE_CHAT_CONTEXT_TOKENS` | 65536, including the reserve for the reply; the CLI uses a conservative estimate of the input |
| `SIMPLE_CHAT_MAX_OUTPUT_TOKENS` | The maximum size of the reply, 4096 by default |
| `SIMPLE_CHAT_COMPACT_AT_TOKENS` | The threshold for automatic compaction of the input: 44000 for llama.cpp, 54000 for Claude Code and Codex CLI |
| `SIMPLE_CHAT_KEEP_SCENES` | How many of the latest scenes to keep in full, 4 by default |
| `SIMPLE_CHAT_API_KEY`, `SIMPLE_CHAT_BASE_URL` | The key and the root address of llama.cpp or of a hosted API; empty for Claude Code and Codex CLI |
| `SIMPLE_CHAT_MODEL_TIMEOUT_MS` | The timeout of a model call through the CLI or HTTP; 300000 ms by default, 600000 ms in the GPU example |
| `SIMPLE_CHAT_TEMPERATURE` | The temperature of the fiction reply of llama.cpp, 0.8 by default |
| `SIMPLE_CHAT_MEMORY_MODE` | `plain` (the default) or the experimental `sgr` |
| `SIMPLE_CHAT_BUDGET_REQUESTS`, `SIMPLE_CHAT_BUDGET_TOKENS` | Daily limits for `openai-compatible`; without them the values of the channel from the [table](model-providers.md#daily-limits-of-hosted-apis) apply |
| `SIMPLE_CHAT_VAST_INSTANCE_ID`, `SIMPLE_CHAT_VAST_API_KEY` | Optional: the Vast.ai instance that the bot starts and stops by itself ([instructions](gpu.md)) |
| `SIMPLE_CHAT_IMAGE_URL` | Optional: a picture under each scene ([plan](illustrations-plan.md)). Without this variable the feature is off — no second model call, no status line, no picture. It is the loopback end of the ssh tunnel to the card that draws, such as `http://127.0.0.1:8188` (`bash gpu/tunnel.sh --pictures`), never a published address and never the language model's own server: one card cannot hold both models |
| `SIMPLE_CHAT_IMAGE_WORKFLOW` | The ComfyUI graph to draw with, exported in API format (Workflow > Export (API)), such as `gpu/image-workflow-qwen.json`; a relative path is read beside `.env`. The bot loads a saving node as a preview one, so the card keeps no copy of the picture. Required when the URL is set, and checked at startup |
| `SIMPLE_CHAT_IMAGE_CHECKPOINT` | The name of the checkpoint file on the picture card, as its `checkpoints` folder writes it. Required when the URL is set |
| `SIMPLE_CHAT_IMAGE_USERS` | Numeric Telegram IDs separated by commas, all of them from `SIMPLE_CHAT_ALLOWED_USER_IDS`. **Empty by default: nobody gets pictures.** Everybody else reads exactly as before, and their scenes never reach the picture card |
| `SIMPLE_CHAT_IMAGE_STYLE` | Optional: one line, the fixed style sentence at the end of every image prompt. Without it the line the [six steps](illustrations-plan.md) were measured with is used. It is the only part of that prompt written by hand |
| `SIMPLE_CHAT_IMAGE_WAIT_SECONDS` | Optional: how long one picture may take, 180 by default (5 to 1800). A picture that outlives it is stopped on the card; the story is not affected either way |

The `SIMPLE_CHAT_IMAGE_*` variables above belong to the bot on this computer. The picture card has one of its own: `SIMPLE_CHAT_IMAGE_QWEN` is read by [the bootstrap on the card](gpu.md#qwen-image-21-opt-in) and decides which checkpoints it downloads; the bot never reads it.

For Gemma on a rented GPU there are [a separate `.env.gpu` profile and instructions](gpu.md). The `npm run start:gpu` command uses the same Telegram settings and database, and replaces the model connection. First you must prepare the server and pass `npm run model:probe`.

To run the bot in the background you can use tmux:

```sh
tmux new -s simple-story-chat-bot 'npm start'
# Detach: Ctrl+B, then D.
# Return: tmux attach -t simple-story-chat-bot
```

If the session already exists, attach to it; do not start a second instance. `flock` also prevents two processes from working with one database at the same time. To stop: Ctrl+C in the bot session. An unfinished reply is not repeated automatically; the scenes that are already saved remain.

At startup the bot checks that no webhook is set. If a webhook is configured, the bot stops; it does not change somebody else's configuration automatically. Do not use the cloud handler and local polling at the same time. The `tgcloud` commands belong to a separate cloud draft that is not launched yet; you do not need to read or edit `.tgcloud/` by hand.

## First run

Open your bot with the link `https://t.me/<bot_name>` and send `/start`. Press **Новый сид** ("New seed") and copy the example that is shown, or write your own seed after the same pattern. Send all the parts, press **Сохранить сид** ("Save seed"), then **Начать новую историю** ("Start a new story").

Check several continuations: free text, an author's instruction, the **Продолжить** ("Continue") button. Then open **Чекпоинты** ("Checkpoints"), choose an early scene and press **Продолжить отсюда** ("Continue from here"). Write a different action. Through **Ветки** ("Branches") you can return to the original line of events.

Deleting a seed deletes it from the library together with all its stories. Deleting a branch keeps the other branches and the scenes they share. These actions do not erase Telegram messages that were already sent.

If a reply was not delivered, `/last` shows the saved scene without generating it again. `/cancel` cancels the current input, compaction or generation. Before a continuation, when the input token threshold is reached, the bot compacts old scenes into a new memory increment and keeps the last four scenes in full. The threshold and the number of scenes are set by the variables above. The original seed is not compacted. The checkpoints before and after a compaction let you continue from any of these states; all the original scenes remain in the archive.

To compact before the threshold, send `/compact` or press **Сжать сейчас** ("Compact now") in `/context`. No new scene is created. The last four scenes remain in full, and the earlier ones go into the next memory increment. If there are no more than four uncompacted scenes, the bot explains that there is nothing to compact yet. `/cancel` cancels a compaction that is running.

The start of a new reply shows the model that was used and the approximate percentage of the window that is filled. `/context` opens the details of the current branch. For an old checkpoint open **Чекпоинты → the scene you need → Контекст** ("Context"): the sizes refer to the chosen moment, including its seed, memory increments and remaining scenes. A zero number of increments means that there was no compaction yet.

The **Модель** ("Model") button and the `/model` command show the chosen connection. For llama.cpp the bot checks the availability of the server, the model name and the window size without generating text. The time of the check is shown separately: a successful reply does not guarantee that the server stays available. For Claude Code the bot shows the subscription and, if there was a reply already, the time of the last successful call. Old scenes do not get the name of the new model after a switch. The choice of the provider stays in the owner's configuration; the button does not change it.

A long seed can be pasted as one message or as several: the bot collects them in order until you press **Сохранить сид**, also when the client split the paste into parts. After each part the bot shows the number of parts and the total size. The title and the date remain the first two non-empty lines; the following messages extend the description, separated by an empty line. The draft survives a restart and does not switch to the previous story when the menu is opened. `/cancel` cancels the input. The total limit of the draft is 256 KiB of text. Text Rich Messages are supported too: paragraphs, lists, tables and expandable blocks.

In the **Новый сид** mode you can attach a `.txt` or `.md` file in UTF-8. Send the full seed as in the [example](../examples/seed.txt), or first send the title and the date as text and then a file with the description. The caption of the file is not used; PDF and DOCX are not supported. The file is added as one part, and after it you also must press **Сохранить сид**. The 256 KiB limit is checked against the bytes actually received; a damaged or incompletely downloaded file does not change the draft. Outside the seed input mode, files are not downloaded and are not used as continuation commands.

The measured counters of the last request include the input together with the cache, and the output, including the internal reasoning of the model. Restored estimates are marked with `≈`; they are not presented as an exact number of tokens. Old scenes without usage keep access to the size estimate, but not to historical measurements. The limit of the next reply is 4096 output tokens by default; the setting allows from 256 to 8192. The prompt states a maximum of 12 paragraphs with no minimum length, but this is an instruction to the model, not a forced cut of the text. If the model reports that it reached the token limit, the bot saves the text it received and warns about the cut separately.

Scenes are sent in full through `sendRichMessage`, for which Telegram allows up to 32768 UTF-8 characters. This is a Telegram limit in characters, separate from the generation limit in tokens. Ordinary menu messages through `sendMessage` allow up to 4096 characters. [Rich Messages limits](https://core.telegram.org/bots/api#rich-message-limits), [sendMessage](https://core.telegram.org/bots/api#sendmessage).

## Giving access to another person

This section uses our own setup as the example: a tester who writes on a Gemma model on a rented GPU. Connect the model, check that it works and add the tester's ID to the access list. The tester gets a link to the bot and presses Start. The tester does not need the source code, the bot token or an account at the GPU service. The GPU profile uses the verified Gemma 4 31B Q6_K; `/model` shows the model and the state of the rental. If the GPU is stopped, the tester presses «Запустить GPU» ("Start GPU") and waits until it is ready. An ordinary message does not start the rental by itself.

If the tester is not on the access list yet, their personal `/start` command saves only the ID and the time of the request in the private metadata of the database (`access_requests`, no more than 100 senders). Access is not opened automatically. Other messages from such users are not saved and are not passed to the model. The administrator adds the ID to `.env` and restarts the bot; after that the tester opens `/start` or `/menu` again.

We do not open or export the tester's stories for debugging. The tester describes the problem and, if they wish, sends a chosen excerpt. We store the library separately from the public code and back it up on the machine where the bot runs.

## Repeatable scenario tests

`npm run story:probe` creates a separate synthetic story on the model from the configuration. Choose the scenario with `--scenario battle`, `--scenario chess` or `--scenario dance`. For Opus: `npm run story:probe -- --scenario chess --model claude-opus-5`. For a GPU that is already prepared: `node --env-file=.env.gpu local/story-probe.ts --scenario chess`.

Each scenario contains 16 turns, three manual compactions after the seventh, eleventh and fifteenth scenes, a continuation after the third compaction and a final request about the facts that were kept. The originals, the increments and the metrics are written to a separate directory `/tmp/simple-chat-<scenario>-*`; the path is printed at startup. The test does not use the bot database or Telegram. This is a memory check on a small story. Capacity and cache at an input of about 59K tokens are checked separately by `npm run model:probe -- --long`; this probe does not measure the quality of a long story.

In the report you must compare the memory with the scenes themselves: the time and the target of a combat move, the spending of a resource, an injury and its treatment, the handover of an item, the keeping of a promise, the date of an event and the date when the information was received, a cancelled plan and the terms of a truce. Valid JSON and references to all scenes do not prove by themselves that the model kept every fact.

The chess scenario uses the verified moves of the Kasparov–Topalov game of 1999 with fictional characters. [PGN source](https://en.chessbase.com/portals/all/2021/03/throwback-kasparov/kasparov-topalov.pgn), reference positions in `examples/chess-reference.json`. The model gets only the next segment of moves, without the full reference and without a ready final position. The dance scenario uses original move combinations and a fictional contest rulebook; it checks the versions of the moves, the training statistics and the correction of a judge's score.

After a test that stopped, you can continue from the saved scene: `npm run story:probe -- --scenario chess --resume /tmp/simple-chat-chess-XXXXXX`. The old process must have exited. The provider and the model must stay the same. The script does not generate saved scenes again; the unfinished call is executed again. For Claude Code you can set `--effort medium` explicitly; the change is written to the resume report.
