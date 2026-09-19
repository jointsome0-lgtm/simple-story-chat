# simple-story-chat

Interactive stories in Telegram. A seed sets the world and the character, the model writes a scene, and the user answers with an action, a line of dialogue or an author's instruction. The text appears gradually and supports Markdown. Every scene starts with the date and time inside the world.

The project provides the interface and the generation mechanics: seeds, a tree of branches with checkpoints, continuing from any scene, compaction of old scenes into memory, and an eval that measures whether the system keeps the world consistent. The model is brought by whoever runs the bot: a Claude Code subscription, their own llama.cpp server with any GGUF model (including one on a rented GPU) or, with explicit consent, a hosted API. What to write and how is decided by that person and their model. The bot adds no content filters of its own and does not weaken the ones the model has.

The bot runs locally on Node 24 and SQLite through the ordinary Bot API. The default model is Haiku through an installed Claude Code. The bot's interface is in Russian; button names below are quoted as they appear, with a translation. Opus 5 designed and wrote the Telegram interface; the concept was discussed earlier with Fable 5.1.

## How to try it

After setup and start, send the bot `/start` or `/menu`.

1. Press **Новый сид** ("New seed"). The bot shows an example: a title, a date and time, then a description of the world and the character. The description can be sent in one message or in several.
2. Wait until all parts are accepted and press **Сохранить сид** ("Save seed"), then **Начать новую историю** ("Start a new story").
3. Answer with ordinary text or press **Продолжить** ("Continue").
4. The **Чекпоинты** ("Checkpoints") button opens the saved scenes. **Продолжить отсюда** ("Continue from here") creates a new branch; the text that follows continues the chosen moment.
5. **Меню → Сиды** ("Menu → Seeds") leads back to other stories and branches. Deleting a seed deletes all its stories from the bot's library. Deleting a branch keeps the other branches. The bot asks for confirmation before deleting; messages already sent to Telegram stay in the chat.

Scenes are saved automatically. `/last` shows the last scene again without calling the model. `/cancel` cancels seed input, generation or compaction. If delivery fails, the finished answer stays in the database; a repeated delivery of the incoming event does not start another model call.

The start of a new scene shows the model and the approximate share of the context that is filled. The **Модель** ("Model") button or `/model` opens the current connection and the result of the server check. Detailed counters are under the **Контекст** ("Context") button or `/context`: the estimate of the next request, the reserve for the answer, and the measured input and output tokens. Output tokens may include the model's internal reasoning. The service line is not saved as part of the scene and is not sent back to the model.

The `/compact` command or the **Сжать сейчас** ("Compact now") button in the context view starts compaction before the automatic threshold. The last four scenes stay whole, the original text is kept, and no new scene is created.

At a checkpoint, the **Контекст** button shows the size of the seed, of the memory increments, of their sum and of the scenes not yet compacted at exactly that point. Sizes in UTF-8 bytes are exact for the serialized parts. Tokens marked `≈` are estimated as bytes / 4, rounded up. This is a rough estimate, not the Haiku tokenizer. Viewing the statistics does not call the model. Exact counters are not available for old scenes that were written before usage was stored.

[Setup and start](docs/setup.md), [example variables](.env.example), [how the interface is built](docs/telegram-ui.md), [model connections](docs/model-providers.md), [Gemma on a GPU](docs/gpu.md).

## Running and checks

You need Linux, Node 24.9+, `flock`, an installed Claude Code with a valid sign-in, and the token of an ordinary Telegram bot.

```sh
cp -n .env.example .env
chmod 600 .env
# Fill in .env locally.
npm start
```

`npm test` checks saving, branching, deletion, isolation of users, repeated events, stream failures, navigation, and that `lib/library.js` matches `lib/library.ts`. `npm run check` (after `npm install`) checks strict TypeScript types, that `lib/library.js` is up to date, and the syntax of the cloud JS. These commands do not call Telegram or a paid model. Test data is created in a temporary directory.

The working code is in `local/`: strict TypeScript that Node 24 runs without a build step. `schema.js`, `handlers/` and the other files in `lib/` belong to an earlier draft for Telegram Serverless; the local bot uses only the pure library logic from `lib/library.ts`. The draft needs `lib/library.js`, which is generated from `lib/library.ts` by `npm run cloud:lib`. The cloud draft is not deployed.

## Limitations

Gemma 4 31B Heretic Q4_K_M and Q6_K were tested on an RTX 5090 32 GB; the GPU profile is set up for Q6_K. An input of about 59K tokens was checked with a 65536 window. This does not prove that facts survive across the whole window. [Measurements and the separate start profile](docs/gpu.md).

Compaction failures are not fully eliminated yet. An error log and progress reporting were added; a repeated check on a GPU with several compactions in a row is still unfinished. Switching between GPU instances is not implemented yet.

Before a continuation, old scenes are compacted automatically if the input reaches the `SIMPLE_CHAT_COMPACT_AT_TOKENS` threshold (44000 by default for llama.cpp and 54000 for Claude Code). The last four scenes stay whole. The model adds a memory increment with dates and references to the source scenes. The JSON is saved as the source record; it enters the request as readable text built by code, without a second retelling. The seed and earlier increments are kept; checkpoints are created before and after compaction. The original scenes are not deleted. If the memory fails validation or does not make the request smaller, it is not applied.

The total window is set to 65536 tokens including the answer. The advance estimate uses the last measured input of the same branch, model and prompt version. Without such a measurement it uses UTF-8 bytes / 4 plus a reserve of 4096. This is an estimate: the adapter also checks Claude's actual input at the start of the answer, before any text is shown. If the threshold is already reached, the adapter aborts that call and starts compaction. The provider may already have started processing the input by then. The seed, the accumulated memory or the last scenes kept whole can fill the window by themselves; in that case the bot stops and keeps the archive.

With a llama.cpp connection, the input is counted by the server's tokenizer before generation and before the compaction decision. Viewing `/context` still does not call the model server and shows estimates. Measurements from a previous provider do not calibrate requests of a new connection.

The bot accepts ordinary text, text Rich Messages and `.txt` / `.md` files in UTF-8. The seed format is: title, world date, description. A file can hold the whole seed as in the [example](examples/seed.txt), or only the description if the title and the date were sent before it in a separate message. A file's caption is not used. PDF and DOCX are not supported.

Seed parts accumulate in a draft until **Сохранить сид** is pressed, with empty lines between them. The draft survives a restart; the menu and the continue buttons do not leave input mode. `/cancel` deletes the draft. The total limit of a draft is 256 KiB of text. Text Rich Messages may contain paragraphs, lists, tables and collapsible blocks; unsupported attachments and complex merged cells are rejected as a whole. A file read error does not add the file partially and does not start the model.

While the bot runs on a computer, the computer and the process must stay on. The library survives a restart. An interrupted generation does not repeat by itself.

For work on memory there is an experimental mode `SIMPLE_CHAT_MEMORY_MODE=sgr` and a [background comparison with ordinary compaction](docs/gpu.md#background-memory-comparison). Probes work on synthetic scenes, yield to user requests and do not extend the GPU's working time. By default the bot uses `plain`.

## Models

Model connections are separate adapters behind one interface ([docs/model-providers.md](docs/model-providers.md)). By default the bot writes stories through an installed Claude Code with a subscription (`claude-code`) or through your own llama.cpp server (`llama-cpp`), for example on a rented GPU — [how to set it up](docs/gpu.md). The build verified on our own card is Gemma 4 31B Heretic Q6_K on an RTX 5090; any other GGUF model that `llama-server` can run will also do. Codex CLI with a ChatGPT subscription (`codex-cli`) and hosted APIs in the OpenAI format — OpenRouter, OpenAI, Mistral and others (`openai-compatible`) — by default serve only the eval on synthetic stories: such a service may keep requests, and users' stories are private. For your own stories they are opened by the exact consent string `SIMPLE_CHAT_ALLOW_HOSTED=stories-leave-this-computer` in `.env`.

## Eval and benchmark

`npm run eval` measures whether the system keeps the world continuous. After a recorded synthetic story, the model answers questions about memory and writes scenes for trap turns that push it to break what was established. A judge model grades the scenes by yes/no questions. The design is in [docs/model-providers.md](docs/model-providers.md), the procedure for working on prompts and memory is in [docs/improve-loop.md](docs/improve-loop.md), and the history of changes with numbers is in [docs/improve-log.md](docs/improve-log.md).

The benchmark data lives separately, on Hugging Face. The open part (the `battle`, `chess` and `dance` scenarios from `examples/` in pack format) is the public dataset [Teadomi/simple-story-chat-eval](https://huggingface.co/datasets/Teadomi/simple-story-chat-eval); its card lists the known limitations of the scores. The hidden part used to accept changes is not published: whoever improves the prompts must not see it. Your own pack is connected with the `--pack <directory>` flag; `node local/pack-hf.ts` uploads and downloads packs.

## Privacy

Every allowed Telegram ID has a separate library. The access list is set in `SIMPLE_CHAT_ALLOWED_USER_IDS`; an empty list does not open the bot to everyone. The bot accepts messages only in private chats.

The owner allowed their own messages to be read for setting up and debugging this bot. The owner's ID is stored only locally in `SIMPLE_CHAT_OWNER_ID`. The permission does not extend to the tester or to other users on the access list. The tester reports problems and may send a chosen excerpt; developers and assistants do not open the tester's stories for diagnosis.

The bot stores messages in order to continue a story and passes the context to the chosen model. Data and keys are not part of the public source code: `.env`, `data/`, databases, exports, backups and logs are excluded from Git. Technical logs contain only statuses, error codes, sizes and counters, without seeds, messages or raw provider answers. A log row about a user request is marked `actor: owner` or `actor: other`. The user ID does not get into the logs. The administrator of the machine technically has access to the storage; this is not end-to-end encryption against the owner of the server.

[Telegram Bot API](https://core.telegram.org/bots/api), [Claude Code streaming output](https://code.claude.com/docs/en/headless).

## License

The code is under [MIT](LICENSE). The synthetic stories and scenarios in `examples/` were written for this project and are distributed under the same terms; in the Hugging Face dataset they are under CC BY 4.0 (the license is stated in the dataset card).
