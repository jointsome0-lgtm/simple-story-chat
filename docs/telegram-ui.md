# simple-story-chat Telegram interface

`ui.ts` turns a user's library into plain-text `sendMessage` payloads with inline keyboards. It has no runtime dependencies: its imports from `lib/library.ts` and other local modules are type-only. It reads state defensively, so broken or stale references lead to a recovery screen instead of an exception.

## User paths

- **First run:** /start shows an empty menu that explains what a seed is → «➕ Новый сид» ("New seed") → the instruction screen (one or several messages, then Save) with a sample → the user sends one or more parts → a receipt after each part → «💾 Сохранить сид» ("Save seed", `save-seed:<draftId>`) creates the seed and shows its screen, where «▶️ Начать новую историю» ("Start a new story") starts a story.
- **Seed draft** (`state.ui = {input:'seed', draftId, parts}`): `render(state, 'new-seed')` shows the instructions while `parts` is empty, and a receipt once parts arrive. The receipt shows:
  - «📝 Черновик сида — ещё не сохранён» ("Seed draft — not saved yet");
  - the part count and character count of the parts joined with blank lines (never tokens);
  - that no scenes are written, now or on save.

  It never shows draft text: no title, date, body or filename. The UI does not check the format; on Save the backend's seed parser reports any specific error, and the draft stays open. Buttons: Save (only with a `draftId`) and «🗑 Отменить черновик» ("Discard draft", `cancel`). There is no Menu button, because the backend sends navigation back to this screen while a draft is open; the text says so.
- **Files:** the instructions also offer a `.txt`/`.md` attachment (UTF-8, up to 256 КиБ (KiB) for the whole draft). The file can be complete, with title and date in its first lines, or description only, with title and date sent first as a message. Captions are ignored, and PDF/DOCX are not supported. Each file is one more part with the same receipt and still needs Save. No new state or callbacks.
- **Play:** the menu shows the current story, branch, scene count and world time. To continue, the user just writes a message (speech, action or author direction). «▶️ Продолжить» ("Continue") asks for the next scene with no input, and «📄 Последняя сцена» ("Last scene") shows it again. Scene messages use `sceneKeyboard` to show «Продолжить / Контекст» ("Continue / Context") and «Чекпоинты / Ветки / Меню» ("Checkpoints / Branches / Menu"); while a scene is being written, only «Остановить / Контекст / Меню» ("Stop / Context / Menu") appear.
- **Browse:** Меню ("Menu") → Сиды ("Seeds"; numbered list, 8 per page) → Сид ("Seed"; description, «Начать новую историю», its stories) → История N ("Story N"; its branches, ✅ marks the current one) → Ветка ("Branch"; last scene excerpt, «Играть в этой ветке» ("Play in this branch") or «Продолжить», checkpoints, delete).
- **Rewind/fork:** Ветка → Чекпоинты (newest first, 8 per page) → preview (input + scene text; for a seed checkpoint, the seed) → «🌿 Продолжить отсюда» ("Continue from here"). The screen says the old branch stays unchanged.
- **Story tree and scene log:** История → «🌳 Дерево истории» ("Story tree") draws the story the way a commit graph with tags reads: a scene is a commit, and only the places that mean something are nodes — a memory compaction (🗜), a fork, a checkpoint the author saved (📍), the head of a branch (🌿, ✅ for the active one). A straight run between them is one line with its scene count and the world time of its last scene; the drawing is a `pre` block of at most 40 lines. Under it, and on the branch screen, «📜 Сцены ветки» ("Scenes of the branch") lists every scene of one branch, newest first, 8 per page: number, world time, the names that point at the scene (🌿, 🗜, 📍, ⑂ where another branch leaves the line, ⚠️ for a truncated scene) and the first words of the author's input. Each scene opens its checkpoint preview, where «🌿 Продолжить отсюда» forks.
- **Delete:** «🗑 Удалить сид/ветку» ("Delete seed/branch") opens a confirmation that shows the scope: stories, branches and scenes for a seed. For a branch it shows its checkpoints, the scenes found in no other branch, and how many branches stay. If it is the only branch, it says the whole story will be deleted. «↩️ Не удалять» ("Do not delete") returns to the item. The screen also says that deletion only removes items from the bot's saved library: messages already sent stay in the chat.

Stories made from the same seed share its title, so they are called «История N» (by creation order) within that seed.

## Interface language

What the bot itself says (screens, buttons, refusals, the compaction status, the command menu) comes from a catalog per language in `local/text/`. The button labels quoted in this document are the Russian ones. Stories are not affected: prompts, memory, the eval and the language a story is written in stay as they were, and the language of a story still comes from its seed and the author's messages.

- `local/text/ru.ts` is the Russian catalog and defines the shape, `Messages`: nested groups by screen, where a value is a string or a function of typed arguments. Plural forms and word order live inside those functions, so the code never glues a sentence from fragments. Comments above the entries tell a translator where a text appears and what it must keep (an emoji at the start, a length, a date format). `local/text/en.ts` is `const en: Messages`.
- `local/text.ts` holds `Lang` (`ru`, `en`, `zh`, `ko`, `ja`), the languages' own names for the picker, `texts(lang)`, `langFromTelegram(code)` and the command lists for `setMyCommands` (English by default, plus one per registered language).
- **To add a language:** write `local/text/<lang>.ts` as `export const <lang>: Messages = { … }` from `ru.ts` and `en.ts`, then import it in `local/text.ts` and add it to `CATALOGS`. A missing or extra key fails `npm run check`; `text.test.ts` renders every screen in every registered language and compares the catalogs' keys, value kinds and function arities.
- The choice is stored as `language` in the user's library. `render`, `sceneKeyboard` read it from the state; `renderContext`, `scenePrefix` and `renderCompaction` take it as an argument. Errors thrown below the bot (library, seed files, incoming messages) carry a catalog key next to their Russian text, and the bot shows `errors[key]` in the user's language.
- **Fallbacks:** a library without `language` predates the choice and is shown in Russian, whatever Telegram reports. A new user (nothing handled and nothing created yet) gets `langFromTelegram(from.language_code)`: `ru`, `zh`, `ko`, `ja` by prefix, anything else or nothing → `en`. A stored language that has no catalog yet is shown in English and switches by itself once its catalog is registered.
- The menu has «🌐 Language», the same label in every language, and `/language` opens the same picker (`view:language`). It lists the registered languages by their own names and marks the one shown; `lang:<code>` stores the choice and shows the menu in it. The picker also works during a seed draft and a model job.
- Stored names are not translated: the labels of checkpoints and branches the bot creates («Сцена 3», “Scene 3”) are written in the interface language of that moment and stay as stored.

## Model and manual compaction

`render(state, route, {modelInfo})` accepts public metadata only: `{provider, model, status, checkedAt}`. Home and `sceneKeyboard` link to `view:model`. The backend refreshes the server check before rendering that screen. The screen shows the selected provider, model, status and check time in UTC; it does not change the deployment. Configured, a past successful check and an unavailable server have distinct labels.

`scenePrefix(stats, provenance)` adds the scene's own `{provider, model}` before its context percentage. The backend stores this metadata with new scenes. Old scenes without provenance keep their unlabelled prefix even after a deployment change. No status, endpoint or credential is included in the narrative prompt.

The idle current-context screen offers `compact`. Historical checkpoints and busy screens do not. The backend preserves the last configured number of scenes, archives originals and creates checkpoints before and after compaction. A compaction job uses `state.job.kind = 'compact'`, and the renderer shows compaction wording while navigation and cancellation remain available.

## Context indicators

- **Scene header** (`scenePrefix(stats)`) is one Markdown line plus a blank line, e.g. `_📏 Контекст ≈ 5%_` ("Context ≈ 5%"). It shows `request.estimatedTokens / limitTokens` rounded; below 1% it says «менее 1%» ("less than 1%"). Unless `estimateSource` is `'usage'`, it adds «, грубая оценка» (", rough estimate"). It has no absolute numbers, and it uses no characters that Markdown would need to escape. With unknown stats it returns `''`. The backend puts it above streaming previews, the final scene and /last. It is never saved as narrative or sent to the model, and the scene's date/time stays the first line below it.
- **Detailed view**, only on request (`view:context` or /context for the current branch, `view:context:STORY:CHECKPOINT` for a checkpoint), shows:
  - the window limit and the reply reserve;
  - the next-request estimate with its share of the window, and where the estimate comes from (checked against the last measured request, or UTF-8 bytes ÷ 4 plus overhead);
  - the input budget (window minus reserve) and what remains of it, with a note that this is a forecast and the actual input is checked again when the model starts answering, before any text is shown;
  - the auto-compaction threshold and how many latest scenes stay verbatim, noting that measured tokens can correct the estimate and that checkpoints are saved before and after compaction;
  - the snapshot breakdown: seed, memory, «Сид + память» ("Seed + memory"), uncompacted scenes, whole snapshot;
  - the last measured request.
- **Where to open it:** «📏 Контекст» is in the menu, in the scene keyboard (also while a scene is being written) and in the checkpoint preview. Checkpoint sizes appear only on the Context screen, never in the preview itself.
- **Labels:** byte sizes are exact («Б», "B" for bytes); every token estimate carries «≈», and component estimates are UTF-8 bytes ÷ 4. The last request is labelled «измерено» ("measured"), and output is called «выход» ("output"; the note says it may include hidden reasoning). Missing numbers are shown as «неизвестно» ("unknown") / «нет измерений» ("no measurements"), never 0. With zero memory parts it says «сжатий ещё не было» ("no compactions yet"). The model name is not shown.
- **Matching stats:** stats are used only if they match the route. For `context:H:C` they need `scope:'checkpoint'` with the same story and checkpoint. For `context` they need a scope other than checkpoint and the active story and branch. Otherwise the screen says there is no data yet and offers the way back (checkpoint or checkpoints + menu). While a scene is being written, the current view notes that the unfinished scene is not counted.

## Busy state (`state.job`)

Navigation, previews and «Последняя сцена» stay available. Buttons for `start`, `use`, `fork`, `continue` and delete confirmations are left out. Where one would normally appear, the screen says it will be available once the scene is done and shows «✖️ Отменить генерацию» ("Cancel generation", `cancel`). Seed entry stays available. There, the cancel button is labelled «Отмена (остановит и сцену)» ("Cancel (will also stop the scene)"), because `cancel` also stops generation.

## Integration notes

- `view:ROUTE` should call `render(state, ROUTE)` with the route as is. Besides the listed routes, pagination adds one **optional page suffix**: `seed:SEED_ID:PAGE` and `story:STORY_ID:PAGE` (stories of a seed, branches of a story). Pages out of range are clamped, and invalid page values count as 0.
- `new-seed` also returns `entities: [{type:'pre', …}]` around the example, so it can be copied with a tap and needs no parse_mode escaping. If the backend only forwards `text` and `reply_markup`, the screen still works.
- Unknown routes show the menu with a note. Missing seeds, stories, branches or checkpoints show «⚠️ … не найден(а)» ("… not found") with «Сиды / Меню» ("Seeds / Menu") buttons. `render` never throws.
- Texts are capped at 4000 characters. A checkpoint preview trims the scene so the fork explanation still fits. A button whose callback would exceed 64 bytes is dropped rather than sent broken; with library-generated ids this does not happen.
- Items are sorted by the numeric suffix of their ids, which is creation order.
- `text.test.ts` does the same crawl for every registered language, see "Interface language".
- `ui.test.ts` (node:test) crawls every screen reachable through `view:` buttons in normal, empty, busy and large libraries. It checks payload limits, the callback protocol, delete scope, stale routes and pagination.
