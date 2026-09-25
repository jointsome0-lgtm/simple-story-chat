# simple-story-chat Telegram interface

What the bot promises a reader. The routes, labels and callbacks are in the code (`local/ui.ts`, `local/text/`); this
page keeps when an action is allowed and what it never does.

<a id='renderer'></a>

`ui.ts` turns a user's library into plain-text `sendMessage` payloads with inline keyboards. It has no runtime dependencies: its imports from `lib/library.ts` and other local modules are type-only. It reads state defensively, so broken or stale references lead to a recovery screen instead of an exception.

`view:ROUTE` calls `render(state, ROUTE)` with the route as is, and a page suffix out of range is clamped. An unknown
route shows the menu with a note, and a missing seed, story, branch or checkpoint shows «⚠️ … не найден(а)» ("… not
found") with the way back; `render` never throws. Items are sorted by the numeric suffix of their ids, which is
creation order. `ui.test.ts` crawls every screen reachable through `view:` buttons in normal, empty, busy and large
libraries for the payload limits, the callback protocol, delete scope, stale routes and pagination, and `text.test.ts`
does the same in every registered language.

## User paths

- **First run:** /start shows an empty menu that explains what a seed is. «➕ Новый сид» ("New seed") opens the
  instructions with a sample, the user sends the seed in one or more parts and gets a receipt after each, and
  «💾 Сохранить сид» ("Save seed", `save-seed:<draftId>`) creates the seed and shows its screen. No scene is written
  until «▶️ Начать новую историю» ("Start a new story") there.
- **Seed draft** (`state.ui = {input:'seed', draftId, parts}`): the receipt says the draft is not saved yet, gives the
  part count and the characters of the parts joined with blank lines (never tokens), and says that no scenes are
  written, now or on save. It never shows draft text: no title, date, body or filename. The backend's seed parser
  checks the format on Save and names any error, and the draft stays open. The screen has Save and
  «🗑 Отменить черновик» ("Discard draft", `cancel`) and no Menu button, because the backend sends navigation back to
  the draft while it is open; the text says so.
- **Files:** a `.txt` or `.md` attachment in UTF-8 is one more part, with the same receipt, and still needs Save. The
  whole draft may be up to 256 KiB. A file may hold the whole seed, with title and date in its first lines, or the
  description alone after a message with the title and date. Captions are ignored, and PDF and DOCX are not supported.
- **Play:** the menu shows the current story, branch, scene count and world time. A message (speech, action or author
  direction) continues the story, «▶️ Продолжить» ("Continue") asks for the next scene with no input, and
  «📄 Последняя сцена» ("Last scene") shows it again. While a scene is being written, its keyboard has only stop,
  context and menu.
- **Browse:** the seeds, a seed's stories, a story's branches and a branch, 8 to a page. Opening a screen changes
  nothing in the story and generates nothing.

<a id='branching'></a>

### Branches and the story tree

- **Rewind/fork:** Ветка → Чекпоинты (newest first, 8 per page) → preview (input + scene text; for a seed checkpoint, the seed) → «🌿 Продолжить отсюда» ("Continue from here"). The screen says the old branch stays unchanged.
- **Story tree and scene log:** История → «🌳 Дерево истории» ("Story tree") draws the story the way a commit graph
  reads. Only the places that mean something are nodes: a memory compaction (🗜), a fork, a checkpoint the author saved
  (📍) and the head of a branch (🌿, ✅ for the active one). A straight run between them is one line with its scene
  count and the world time of its last scene, in a `pre` block of at most 40 lines. «📜 Сцены ветки» ("Scenes of the
  branch") lists one branch's scenes, newest first, 8 to a page, with those marks, ⑂ where another branch leaves, ⚠️
  for a truncated scene, and the first words of the author's input. Each scene opens its checkpoint preview, where
  «🌿 Продолжить отсюда» forks.

Stories made from the same seed share its title, so they are called «История N» (by creation order) within that seed.

<a id='deletion'></a>

### Deleting a seed or a branch

- **Delete:** «🗑 Удалить сид/ветку» ("Delete seed/branch") opens a confirmation that shows the scope: stories, branches and scenes for a seed. For a branch it shows its checkpoints, the scenes found in no other branch, and how many branches stay. If it is the only branch, it says the whole story will be deleted. «↩️ Не удалять» ("Do not delete") returns to the item. The screen also says that the deletion cannot be undone, that the bot removes the pictures of the deleted scenes from this chat if they were sent less than two days ago, and that the texts of the scenes stay in the chat.
  - Every photo the bot sends, a scene's own picture, every sample, every variant and every portrait, is recorded in the library as `sentPictures`: its story, scene, message and the time it was sent. A portrait has no scene and goes with its story (see Characters). So is the prompt folded under a picture (see Picture styles). Telegram lets a bot delete its own message for 48 hours only, so every write drops the older entries and keeps at most the newest 1000.
  - Once the screen after the deletion is out, the bot deletes the pictures whose scene or story is gone, 100 to a `deleteMessages` call, and message by message when a call fails. The reader is told nothing more: whatever Telegram answers, the screen stays as it is. A deleted branch takes only the pictures of the scenes that no other branch has.
  - A picture whose scene is deleted while it is being drawn is not sent, and one already on its way is deleted as soon as it lands.

<a id='picture-delivery'></a>

## Pictures under scenes

Pictures are off by default. Only the readers in `SIMPLE_CHAT_IMAGE_USERS` get them, and each of those must also be on
the access list ([the settings](setup.md#pictures)). For such a reader every scene gets a picture after it:

1. The scene is saved and sent first. Nothing of the picture delays or changes it.
2. A status line of its own goes up under the scene.
3. On the language model's card, in one scheduler turn that shares the scene's prefix and holds the GPU no longer than
   a job would, the bot writes the story's character sheet if it has none, then the frame of this scene
   ([from the sheet to the prompt](#picture-pipeline)). When that card is not ready, or the scheduler gives the slot to
   somebody waiting for a scene, the picture is skipped.
4. The prompt is assembled in code, and ComfyUI on the picture card draws it through the loopback tunnel with the
   story's seed, derived from the story id, so one story keeps one visual family and a redraw repeats.
5. The PNG is stripped of its text chunks, which hold the whole prompt and workflow (`stripPngMetadata` in
   `local/image-batch.ts`), and the photo goes out as a reply to its scene, with no caption. The status line goes once
   the photo is there, and the prompt follows it, folded ([the prompt under a picture](#picture-prompts)).
6. One `picture` row records the outcome ([the log](gpu.md#bot-log)).

A failure or a busy card leaves the story exactly as it was. The status line is rewritten to one line only when the
picture really failed: a reader who has moved on gets no apology. The reader's next message and `/cancel` stop a
picture in flight. Moving around the menus does not, and there is no cancel button, because by then the job lock is
clear. Every photo is recorded with its scene and leaves the chat with it ([deletion](#deletion)). What the card keeps
of a picture, and for how long, is in [gpu.md](gpu.md#what-the-card-keeps-of-a-picture); why pictures are made this
way is in [illustrations-plan.md](illustrations-plan.md).

<a id='picture-pipeline'></a>

### From the sheet to the prompt

The story's character sheet (`story.sheet`) lists its people. Each has a `look` of what stays, sex, age as a word
(young adult, middle-aged or elderly), build, hair, face and marks, and an `outfit`, what they wore in the last scene
of the history the sheet was written from. The frame of a scene is a description in fixed fields (`local/illustrate.ts`)
with `clothes` for each person. It starts from what the people wore before: the clothes of the nearest picture above
the scene in its own line of the story, or the sheet's `outfit`, and the model is told to repeat them unless the story
changed them (`wornAt` in `local/picture.ts`). A branch walks only its own parents, so a change in one line of the
story never dresses another. `assemblePrompt` builds the prompt from the fields in a fixed order: the shot, the
setting, the moment, each person's look, clothes, state and action, the objects, the props and the light, and last one
style line. Names and ages are cut out of every field, so no character's name reaches the image model. Why each part
is there is in [the steps of September](illustrations-plan.md#description-steps).

## Picture styles

Only a reader whose scenes are drawn (`SIMPLE_CHAT_IMAGE_USERS`) has «🎨 Стиль картинок» ("Picture style") in the menu and `/style` in the command list; both open the picker (`view:style`). A style is the last sentence of every picture's prompt (`local/picture-style.ts`) and changes only the pictures still to come. Nothing is drawn by opening a screen.

- **Picker and card:** the bot's own `SIMPLE_CHAT_IMAGE_STYLE` (a button of its own only when it is none of the
  presets), the five presets and the reader's own styles, ✅ on the current one. A style's card shows its whole prompt
  in a `pre` block that Telegram copies in one tap, so any style can start one of the reader's own; a deletion asks
  first and names the style the pictures go back to.
- **Own styles** live in `pictureStyles` in the library, at most 10; `pictureStyle` holds the chosen key.
  «➕ Новый стиль» ("New style") makes the next text message the style, never a move in the story, and any button or
  command, an unknown one included, leaves without a change. A first line of a longer message is the name, cut to 40
  characters. A style has up to 400 characters and becomes the chosen one.
  - The line ends the prompt exactly as written: the bot adds nothing to it, so a reader can set a style and test it word for word. The age of the people is in their own description instead, which is the same in every style of a scene ([the pipeline](#picture-pipeline)).
- **Sample:** the reader's last scene, the head of the active branch, drawn once more in the card's style with the
  story's seed, so only the style differs from the scene's own picture. The frame described for that picture is reused
  while the bot still holds it in memory, and then no language model is called; after a restart the scene is
  described again, as a request of this reader.
  «🎨 Рисую пример…» stands while it is drawn, and the photo comes with the style's name and, unless it is the chosen
  style, the choose button. One sample at a time per reader: the reader's next move, /cancel or a new job stops it. A
  sample is refused while pictures are off, while a scene is being written, before the first scene, and while another
  sample is drawn.
- **All styles:** the same sample in every style of the picker, in its order, from one frame and the story's seed.
  Each photo goes out as soon as it is drawn, with its caption and choose button, under one status line that says how
  many are coming. It counts as one sample and is refused and stopped by the same rules; a style that fails ends the
  rest, and each picture's row carries `stylesAsked`. Every style costs the picture card a full drawing, about 17 s on
  the card of 2026-09-24 ([measured](illustrations-plan.md#style-decisions)).

<a id='picture-prompts'></a>

### The prompt under a picture

- **Prompt under a picture:** every photo, the scene's own, every sample and every variant, gets a reply right after it: a rich message folded to one line, «🖼 Промпт: 243 токена, из них стиль 53 · 1 204 знака» ("Prompt: 243 tokens, 53 of them the style · 1,204 characters"). Opened, it shows the prompt the picture was drawn from as plain text, which wraps to the width of a phone, for the reader to read, copy and tune a style line against (`foldedPrompt` in `local/picture.ts`). It was a code block at first, and on a phone that meant scrolling sideways.
  - The tokens are the ones the graph's text encoder conditions the picture on, Qwen Image 2.1's or Krea 2's: the prompt and the few tokens of the encoder's template that stay (`encoderTokens` in `local/picture.ts`, [tokenizers.md](tokenizers.md)). The style's share is what the style line adds to the description before it. Without `tokenizers/qwen-2.5.json.gz` (`npm run tokenizers`), or for a graph with another encoder, the line gives the characters alone.
  - The note is deleted with its photo when their scene is. A note Telegram refuses leaves the photo as it is, and the reader is told nothing; the log gets a `picture_prompt_unsent` row.
  - A photo already on its way to Telegram when the reader's next move or /cancel stops its picture goes out with its note all the same, and nothing of that picture follows the note. Its log row is `ready` with `cancelled: true`.

The owner decided the last rule on 2026-09-25, because such a photo is in the chat either way and of no use there
without the prompt it was drawn from ([the record](illustrations-plan.md#prompt-under-picture)). The note is a rich
message ([limits](#telegram-limits)).

<a id='picture-variants'></a>

### A variant from the reader's own prompt

- **Variant with the reader's own prompt:** the note under a scene's own picture, not the photo and not a sample's note, has «✏️ Изменить промпт и нарисовать вариант» ("Edit the prompt and draw a variant", `prompt-edit:<storyId>:<nodeId>`, which stays well inside the 64 bytes of a button's data). It sets `ui = {input:'prompt', storyId, nodeId}` and asks for the whole prompt, style included, up to 4000 characters, copied from the note and edited. The next text message is that prompt, never a move; any button or command, an unknown one included, leaves. The bot keeps the prompt in neither its library nor its technical logs. Telegram keeps the reader's message and the note under the variant, and the picture card holds the job as long as it holds any picture's ([gpu.md](gpu.md#what-the-card-keeps-of-a-picture)).
  - The prompt is drawn as it came: nothing is assembled, cut out or appended. It is drawn with the recipe the scene keeps of its own picture (`picture` on the scene, written with the photo's record): its seed, size, steps, cfg, sampler and scheduler. So a variant can be drawn under any scene's picture drawn since scenes keep it, for as long as the scene is kept, while the graph and the checkpoint are the ones it was drawn with. A picture drawn with a graph or checkpoint the bot no longer has is refused with the reason, rather than drawn with another; so is one whose scene is gone.
  - «🎨 Рисую вариант…» stands while it is drawn. The variant is a photo of its own under the same scene, with its prompt folded under it: the tokens are those of that prompt, with no style share. Its note has the same button, and it is deleted with the scene like the first.
  - The language model is not asked or held, and nothing of the story changes. One variant at a time per reader; the reader's next move, /cancel or a new job stops it, and a failure is told once and not retried. The button, and the prompt when it arrives, are refused while pictures are off and while a scene is being written.

The reader's permission, the scene and its recipe are checked when the button is pressed, when the prompt arrives,
before the drawing and before the photo goes out. The row is `picture_variant`, with `edited: true` beside the counts
`picture` has and no word of the prompt. A prompt may have 4000 characters (`PROMPT_CHARS` in
`local/picture-style.ts`): at five characters for every escaped `&`, the note still fits the 32768 of a rich message.

The recipe pins the request and not the card: the graph with the file names in it, the checkpoint's name, the seed,
the size and the sampler settings. The card's software, and weights replaced under the same file name, are not in it,
and after a change to either the same recipe can draw a different picture.

## Characters

The story's first picture writes its sheet ([from the sheet to the prompt](#picture-pipeline)). Only a reader whose
scenes are drawn has «👤 Персонажи» ("Characters", `view:characters:<storyId>`): beside each story on the seed screen,
beside the story tree, and beside the style in the menu for the story being played. The button is there before the
sheet is, and the list then says the people come with the story's first illustration. Opening a screen writes and
draws nothing.

- **List:** each person's name and the start of their look, and a button per person (`view:character:<storyId>:<index>:<tag>`). A button names a person by their place on the sheet and `<tag>`, the first 8 hex digits of a SHA-256 of their name (`personTag` in `local/picture.ts`), never the name itself. A sheet written anew may put somebody else in that place, and a button of the earlier person is then refused rather than acting on the new one: the card button opens the list, and the edit and portrait buttons say the button is stale.
- **Card:** the whole look and the clothes, each in a `pre` block, each with its size as the picture model reads that
  text alone: tokens of the graph's encoder (`textTokens` in `local/picture.ts`) and characters, or characters alone
  without the tokenizer. The two sizes are never added up. The card says that the prompt also holds the description of
  the scene and the style, and that its exact size is under the picture.
  - The clothes are the story's and are only shown. For the story being played they are the ones the nearest picture up the active branch dressed the person in, and the card names the branch (`wornAt`). Otherwise, and before any picture dressed them, they are the sheet's own, which the story's pictures started from.
  - «✏️ Изменить внешность» ("Edit the look", `look-edit:<storyId>:<index>:<tag>`) makes the next text message the
    look, on one line, up to 400 characters. Empty text is refused and the bot keeps waiting; any button or command,
    an unknown one included, leaves without a change. When the look arrives the person is found again by story and
    name, so a sheet written anew without them refuses it. The name cannot be changed, and nobody is added or removed.
  - An edited look is marked `edited`, and the rewrite of a sheet from before clothes left it keeps it. It reaches the next pictures of every branch of the story. The story text, its memory and the pictures already drawn stay as they are, and a picture being drawn at that moment may still show the old look. A sample describes its scene again once a look it was described with has changed. A person is known by their name alone, apart from spaces and case, so identity survives only an unchanged name: one the model renames in that rewrite is somebody new, and the look, portrait and buttons of the old name stay with the old name beside them.
- **Portrait:** «🖼 Портрет» ("Portrait", `portrait:<storyId>:<index>:<tag>`) draws the person from the look alone, to pick a reference by. It shows the face and the whole figure: full length from the front, standing and facing the viewer with no expression asked for, in plain close-fitting clothes and a plain style of the bot's own (`portraitPrompt` in `local/image-portraits.ts`), so build, height, silhouette and permanent marks can be read. The text-to-image graph draws it with a random seed on the graph's canvas turned upright, the smaller side across and the larger down (720x1280 for a graph of 1280x720), which leaves more of the frame to a figure standing full length. No model is asked, so the card is not held for one. It is a drawing on request like a style sample: one at a time with the samples, in the same slot, with the same status line. A second portrait or sample asked for meanwhile is refused, and the first goes on; a move in the story, /cancel or the bot's stop ends it. A variant has a slot of its own and may be drawn beside it. A portrait has no prompt under it, and so no button for a variant. A photo already handed to Telegram is delivered all the same and can be kept: a stop while it is on its way does not take it back, and its `picture_portrait` row is `ready` with `cancelled: true`. It is only for a reader whose scenes are drawn, checked on the press and again before the work. A portrait whose look changes, or whose story is deleted, while it is drawn is not sent.
  - Under the photo are «🔄 Ещё вариант» ("Another version", the same prompt with a new seed), «✅ Оставить» ("Keep", `portrait-keep:<candidate>`) and the way back to the card. The bot holds the photo it showed in memory for 30 minutes, one per reader, under the id the keep button carries, and with a single timer that knows the id alone. A newer portrait takes its place, so an older button keeps nothing, and neither does one pressed after the look changed. A kept portrait is let go once its write is committed; if that write is rolled back, the same button keeps it again.
  - Keeping writes exactly that photo, stripped like every picture, as a PNG beside the database: `<db>.portraits/<directory>/<random>.png`. The directory is named by an HMAC of the reader's ID under a key kept in the database; directories are 0700, files 0600. The sheet refers to the file (`portrait`: its name, the recipe it was drawn with as a scene keeps its picture's, its canvas included, and the look, clothes and style of its prompt) and never carries the picture. The new file is written before the write that refers to it, and a rollback of that write deletes it again. A file nobody refers to (the one replaced, a deleted story's, or one whose write a stopped process never made) is swept once a write commits, and at start. A reader without a directory has no portraits; a directory that cannot be read is logged as `portraits_unswept` with its errno in lower case (`enotdir`), never the message, which names the path.
  - A kept portrait is not used in the story's pictures. Once the look changes the card says the portrait is of the earlier look, and nothing is redrawn. The rewrite of a sheet from before clothes left it keeps the portrait, and the person with it. Deleting the seed or the story takes the portraits out of the chat and off the disk.

## Interface language

What the bot itself says (screens, buttons, refusals, the compaction status, the command menu) comes from a catalog per language in `local/text/`. The button labels quoted in this document are the Russian ones. The language of a story is a separate choice, made by its seed, not by this picker: see [story language](#story-language).

- `local/text/ru.ts` is the Russian catalog and defines the shape, `Messages`: nested groups by screen, where a value
  is a string or a function of typed arguments. Plural forms and word order live inside those functions, so the code
  never glues a sentence from fragments, and comments above the entries tell a translator what a text must keep.
  `local/text.ts` holds `Lang`, the languages' own names for the picker, `texts(lang)`, `langFromTelegram(code)` and
  the command lists for `setMyCommands`.
- Registered now: `ru` (the original), `en`, `zh` (Simplified), `ko`, `ja`. The last three were translated by a model from `ru.ts` and `en.ts` and have not been reviewed by a native speaker; each file starts with its glossary, so a reviewer can fix a term in one place.
- **To add a language:** write `local/text/<lang>.ts` as `export const <lang>: Messages = { … }` from `ru.ts` and `en.ts`, then import it in `local/text.ts` and add it to `CATALOGS`. A missing or extra key fails `npm run check`; `text.test.ts` renders every screen in every registered language and compares the catalogs' keys, value kinds and function arities.
- The choice is stored as `language` in the user's library. Errors thrown below the bot carry a catalog key next to
  their Russian text, and the bot shows them in the user's language.
- **Fallbacks:** a library without `language` predates the choice and is shown in Russian, whatever Telegram reports. A new user (nothing handled and nothing created yet) gets `langFromTelegram(from.language_code)`: `ru`, `zh`, `ko`, `ja` by prefix, anything else or nothing → `en`. A stored language that has no catalog yet is shown in English and switches by itself once its catalog is registered.
- «🌐 Language», the same label in every language, and `/language` open the picker (`view:language`), which lists the
  registered languages by their own names and works during a seed draft and a model job too.
- Stored names are not translated: the labels of checkpoints and branches the bot creates («Сцена 3», “Scene 3”) are written in the interface language of that moment and stay as stored.

## Story language

Everything the model reads and writes — the narrator's rules, the memory extraction rules, the headers around the seed and the accumulated memory, and the two messages the code itself sends («Начни историю из сида», «Продолжай историю…») — comes from a catalog per language in `local/story-text/`. Interface language and story language are independent: a user with Korean menus who writes a Russian seed gets Russian scenes, and the other way round.

- The seed decides. `detectStoryLanguage` in `local/story-text.ts` counts the scripts of the seed's title and body: Cyrillic is `ru`, Hangul `ko`, kana (with any Han) `ja`, Han without kana `zh`, anything else `en`. Counting, not the first letter, so a quoted name in another script changes nothing. The choice is derived on every request, never stored, so old libraries need no migration and the request prefix stays stable for a server-side cache.
- `en` is also the fallback for a seed in a language without a catalog: its rules tell the narrator to follow the language of the seed, so a Spanish or German seed gets Spanish or German scenes from English rules.
- `local/story-text/ru.ts` is the production prompt measured by the improvement loop and defines the shape, `Narration`; it may change only through [improve-loop.md](improve-loop.md). The other four are faithful translations of it — same rules, same order — with the language named in the "write in …" clause. `zh`, `ko` and `ja` have not been reviewed by a native speaker.
- **To add a language:** write `local/story-text/<lang>.ts` as `export const <lang>: Narration = { … }`, add it to `StoryLang` and `CATALOGS` in `local/story-text.ts`, and give `detectStoryLanguage` a rule for its script. `story-text.test.ts` compares the catalogs' keys and checks that each keeps the untranslatable parts: the scene format `YYYY-MM-DD HH:MM`, the JSON field names, the enum values and the evidence ids.
- The token estimate counts a Han or kana character as four bytes
  ([context and memory](model-providers.md#memory-and-context)); the measurements behind it are in
  [improve-runs.md](knowledge/improve-runs.md#story-language-2026-09-19).

<a id='model-and-compaction'></a>

## Model and manual compaction

`render(state, route, {modelInfo})` accepts public metadata only: `{provider, model, status, checkedAt}`. Home and `sceneKeyboard` link to `view:model`. The backend refreshes the server check before rendering that screen. The screen shows the selected provider, model, status and check time in UTC; it does not change the deployment. Configured, a past successful check and an unavailable server have distinct labels.

`scenePrefix(stats, provenance)` adds the scene's own `{provider, model}` before its context percentage. The backend stores this metadata with new scenes. Old scenes without provenance keep their unlabelled prefix even after a deployment change. No status, endpoint or credential is included in the narrative prompt.

The idle current-context screen offers `compact`. Historical checkpoints and busy screens do not. The backend preserves the last configured number of scenes, archives originals and creates checkpoints before and after compaction. A compaction job uses `state.job.kind = 'compact'`, and the renderer shows compaction wording while navigation and cancellation remain available.

## Context indicators

- **Scene header** (`scenePrefix(stats)`): one Markdown line and a blank line above a scene, e.g. `_📏 Контекст ≈ 5%_`
  ("Context ≈ 5%"), the next request's estimate over the window, «менее 1%» ("less than 1%") below 1%, and
  «, грубая оценка» (", rough estimate") unless the estimate is anchored on a measured request. It has no absolute
  numbers and nothing Markdown would need escaped, and with unknown stats it is empty. It stands above streaming
  previews, the final scene and /last, is never saved as narrative or sent to the model, and the scene's date and time
  stay the first line below it.
- **Detailed view**, only on request (/context, or «📏 Контекст» in the menu, the scene keyboard and a checkpoint's
  preview): the window and the reply reserve; the next request's estimate and where it comes from; the input budget
  and what remains of it, a forecast, since the real input is checked again when the model starts answering, before
  any text is shown; the compaction threshold and how many scenes stay verbatim; the sizes of the seed, the memory,
  the uncompacted scenes and the whole snapshot; and the last measured request. Checkpoint sizes appear only here.
- **Labels:** byte sizes are exact, and every token estimate carries «≈». The last request is marked measured, and its
  output may include hidden reasoning. A missing number is shown as unknown, never 0. The model name is not shown.
- **Matching stats:** stats are used only if they match the route: a checkpoint's view needs that checkpoint's, the
  current view the active story and branch. Otherwise the screen says there is no data yet and offers the way back.
  While a scene is being written, the current view notes that the unfinished scene is not counted.

<a id='busy-state'></a>

## Busy state (`state.job`)

Navigation, previews and «Последняя сцена» stay available. Buttons for `start`, `use`, `fork`, `continue` and delete confirmations are left out. Where one would normally appear, the screen says it will be available once the scene is done and shows «✖️ Отменить генерацию» ("Cancel generation", `cancel`). Seed entry stays available. There, the cancel button is the ordinary «✖️ Отмена» ("Cancel"); note that `cancel` also stops a running generation.

<a id='telegram-limits'></a>

## Limits of a Telegram message

- Screens are capped at 4000 characters, and a checkpoint preview trims the scene so the fork explanation still fits.
  A button whose callback would exceed 64 bytes is dropped rather than sent broken; with library-generated ids this
  does not happen.
- Scenes are sent in full through `sendRichMessage`, for which Telegram allows up to 32768 UTF-8 characters. This is a Telegram limit in characters, separate from the generation limit in tokens. Ordinary menu messages through `sendMessage` allow up to 4096 characters. [Rich Messages limits](https://core.telegram.org/bots/api#rich-message-limits), [sendMessage](https://core.telegram.org/bots/api#sendmessage).
- The prompt under a picture is a rich message folded to one line, so a long prompt costs the chat one line
  ([the prompt under a picture](#picture-prompts)).
- `new-seed` also returns `entities: [{type:'pre', …}]` around the example, so it can be copied with a tap and needs
  no parse_mode escaping. If the backend only forwards `text` and `reply_markup`, the screen still works.
