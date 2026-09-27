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
  the draft while it is open; the text says so. A paste that the client split into several messages is collected in
  order like any other parts. The title and the date stay the first two non-empty lines, and later parts extend the
  description. A rich message counts as its text, with its paragraphs, lists, tables and expandable blocks
  (`local/incoming.ts`). One that holds an attachment, a block the bot does not read or merged table cells is refused
  as a whole, in play as well, and nothing of it is saved. The draft survives a restart.
- **Files:** a `.txt` or `.md` attachment in UTF-8 is one more part, with the same receipt, and still needs Save. The
  whole draft may be up to 256 KiB. A file may hold the whole seed, with title and date in its first lines as in
  [the example](../examples/seed.txt), or the description alone after a message with the title and date. Captions are
  ignored, and PDF and DOCX are not supported.
  The 256 KiB are counted on the bytes received, and a damaged or partly downloaded file leaves the draft as it was.
  Outside seed input a file is not downloaded and does not continue the story.
- **Play:** the menu shows the current story, branch, scene count and world time. A message (speech, action or author
  direction) continues the story, «▶️ Продолжить» ("Continue") asks for the next scene with no input, and
  «📄 Последняя сцена» ("Last scene") shows it again. While a scene is being written, its keyboard has only stop,
  context and menu. /last shows the saved scene without generating it again. A reply that hit the output token limit
  is saved as it came, and a separate message says that it may be cut off. The narrator's rules ask for at most 12
  paragraphs; the bot does not cut a longer scene.
- **Browse:** the seeds, a seed's stories, a story's branches and a branch, 8 to a page. Opening a screen changes
  nothing in the story and generates nothing.

<a id='branching'></a>

### Branches and the story tree

- **Rewind/fork:** Ветка → Чекпоинты (newest first, 8 per page) → preview (input + scene text; for a seed checkpoint, the seed) → «🌿 Продолжить отсюда» ("Continue from here"). The screen says the old branch stays unchanged.
- **Story tree and scene log:** История → «🌳 Дерево истории» ("Story tree") draws the story the way a commit graph
  reads. Only the places that mean something are nodes: a memory compaction (🗜), a fork, a checkpoint the author saved
  (📍) and the head of a branch (🌿, ✅ for the active one). A straight run between them is one line with its scene
  count and the world time of its last scene, in a `pre` block of at most 40 lines. Under it, and on the branch
  screen, «📜 Сцены ветки» ("Scenes of the branch") lists every scene of one branch, newest first, 8 per page: number,
  world time, the names that point at the scene (🌿, 🗜, 📍, ⑂ where another branch leaves the line, ⚠️ for a
  truncated scene) and the first words of the author's input. Each scene opens its checkpoint preview, where
  «🌿 Продолжить отсюда» forks.

Stories made from the same seed share its title, so they are called «История N» (by creation order) within that seed.

<a id='deletion'></a>

### Deleting a seed or a branch

- **Delete:** «🗑 Удалить сид/ветку» ("Delete seed/branch") opens a confirmation that shows the scope: stories, branches and scenes for a seed. For a branch it shows its checkpoints, the scenes found in no other branch, and how many branches stay. If it is the only branch, it says the whole story will be deleted. «↩️ Не удалять» ("Do not delete") returns to the item. The screen also says that the deletion cannot be undone, that the bot removes the pictures of the deleted scenes from this chat if they were sent less than two days ago, and that the texts of the scenes stay in the chat.
  - Every photo the bot sends, a scene's own picture, every sample, every variant and every portrait, is recorded in the library as `sentPictures`: its story, scene, message and the time it was sent. A portrait has no scene and goes with its story (see Characters). So is the prompt folded under a picture (see Picture styles), and the text folded under a portrait, with its story. Telegram lets a bot delete its own message for 48 hours only, so every write drops the older entries and keeps at most the newest 1000.
  - Once the screen after the deletion is out, the bot deletes the pictures whose scene or story is gone, 100 to a `deleteMessages` call, and message by message when a call fails. The reader is told nothing more: whatever Telegram answers, the screen stays as it is. A deleted branch takes only the pictures of the scenes that no other branch has.
  - A picture whose scene is deleted while it is being drawn is not sent, and one already on its way is deleted as soon as it lands.

<a id='picture-delivery'></a>

## Pictures under scenes

Pictures are off by default. Only the readers in `SIMPLE_CHAT_IMAGE_USERS` get them, and each of those must also be on
the access list ([the settings](setup.md#pictures)). For such a reader every scene gets a picture after it:

1. The scene is saved and sent first. Nothing of the picture delays or changes it.
2. A status line of its own goes up under the scene. While ComfyUI's sampler runs, a second line under it shows the
   steps done, «▰▰▰▰▱▱▱▱▱▱ 12/25», as the card's websocket reports them, in an edit at most every 3 s (`statusLine`
   in `local/picture.ts`). While the job waits on the card behind other jobs, the second line shows its place instead
   ([waiting](#waiting)). Before that and before the first step (the description, the model loading) the line stands
   alone. An edit Telegram refuses leaves a `picture_status_failed` row with Telegram's code, and the next one waits
   as long as Telegram asks. No edit lands after the line is removed or rewritten to a failure. A sample, a variant
   and a portrait show the same place and steps under their own lines, and the line of all styles shows each
   picture's in turn.
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

The story's character sheet (`story.sheet`) lists its people, each in three layers since 2026-09-27
([three layers](illustrations-plan.md#three-layers)). The `description` is everything the story says of the person's
lasting appearance, up to 150 words in the story's language: sex, age and the age they look, skin, height and build,
measurements, hair, face and permanent marks, with numbers and tables as the story gives them, and a last line «Не
сказано в истории: …» for what the sheet chose where the story is silent. `changes` holds the lasting changes the story
made along the way, a scar or a haircut, and the `outfit` what the person wore in the last scene of the history the
sheet was written from. The picture model never reads the description. One call of the language model retells the
sheet's descriptions and changes (`retellRequest` in `local/illustrate.ts`) into `details`, up to 200 words of English
prose for a portrait, and the `look`, the same compressed to 15 to 25 words, what tells the person apart from afar. Both
are in words alone: sex and the age the person looks in one ordinary phrase, skin tone, a height given in numbers as tall
or short against an ordinary adult of the same sex, the build and each proportion, hair, face, and permanent marks with
their place and side, with the same measurement in the same word for people of one sex and age group. A frame takes
the look, and a portrait the details ([Characters](#characters)). The reader may write the description, in any
language and form, and it wins over the story's. A sheet written before 2026-09-27 has no changes and is written again
by the next picture, which keeps what the reader wrote. The frame of a scene is a
description in fixed fields (`local/illustrate.ts`) with `clothes` for each person. It starts from what the people
wore before: the clothes of the nearest picture above the scene in its own line of the story, or the sheet's `outfit`,
and the model is told to repeat them unless the story changed them (`wornAt` in `local/picture.ts`). A branch walks
only its own parents, so a change in one line of the story never dresses another. `assemblePrompt` builds the prompt
from the fields in a fixed order: the shot, the setting, the moment, each person's look, clothes, state and action, the
objects, the props and the light, and last one style line. Names and ages are cut out of every field, so no
character's name reaches the image model. Why each part is there is in
[the steps of September](illustrations-plan.md#description-steps).

## Picture styles

Only a reader whose scenes are drawn (`SIMPLE_CHAT_IMAGE_USERS`) has «🎨 Стиль картинок» ("Picture style") in the menu and `/style` in the command list; both open the picker (`view:style`). A style is the last sentence of every picture's prompt (`local/picture-style.ts`) and changes only the pictures still to come. Nothing is drawn by opening a screen.

- **Picker and card:** the bot's own `SIMPLE_CHAT_IMAGE_STYLE` (a button of its own only when it is none of the
  presets), the six presets and the reader's own styles, ✅ on the current one. The sixth, «⬜ Без стиля» ("No style"),
  adds nothing, so the prompt ends with the scene's description (the owner, 2026-09-27). A style's card shows its whole
  prompt in a `pre` block that Telegram copies in one tap, so any style can start one of the reader's own, and the
  empty one's card says its prompt is empty; a deletion asks first and names the style the pictures go back to.
- **Own styles** live in `pictureStyles` in the library, at most 10; `pictureStyle` holds the chosen key.
  «➕ Новый стиль» ("New style") makes the next text message the style, never a move in the story, and any button or
  command, an unknown one included, leaves without a change. A first line of a longer message is the name, cut to 40
  characters. A style has up to 400 characters and becomes the chosen one.
  - The line ends the prompt exactly as written: the bot adds nothing to it, so a reader can set a style and test it word for word. The age of the people is in their own description instead, which is the same in every style of a scene ([the pipeline](#picture-pipeline)).
- **Sample:** the reader's last scene, the head of the active branch, drawn once more in the card's style with the
  story's seed, so only the style differs from the scene's own picture. The frame described for that picture is reused
  while the bot still holds it in memory, and then no language model is called; after a restart the scene is
  described again, as a request of this reader.
  After a graph or checkpoint change, a sample uses the current recipe and, when the reference experiment is on,
  the current kept portraits. A compatible saved recipe keeps its original portrait inputs.
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

- **Prompt under a picture:** every photo, the scene's own, every sample and every variant, gets a reply right after it: a rich message folded to one line, «🖼 Промпт: 243 токена, из них стиль 53 · 1 204 знака» ("Prompt: 243 tokens, 53 of them the style · 1,204 characters"). Opened, it shows the prompt the picture was drawn from as plain text, which wraps to the width of a phone, for the reader to read, copy and tune a style line against (`foldedPrompt` in `local/picture.ts`). It was a code block at first, and on a phone that meant scrolling sideways. A portrait's note holds the text it was drawn from instead ([Characters](#characters)).
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

The note under the variant counts the tokens of that prompt and gives no style share, which nobody knows for a prompt
written whole. The reader's permission, the scene and its recipe are checked when the button is pressed, when the
prompt arrives, before the drawing and before the photo goes out. A variant asks the language model nothing and holds
none of its card, and it changes nothing of the story: not the sheet, the clothes or the frame kept for samples. The
row is `picture_variant`, with `edited: true` beside the counts `picture` has and no word of the prompt. The bot keeps
the prompt in neither its library nor its technical logs, not even while it waits for it. A prompt may have 4000
characters (`PROMPT_CHARS` in `local/picture-style.ts`): at five characters for every escaped `&`, the note still fits
the 32768 of a rich message.

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
- **Card:** the person's description, titled as the story's or the reader's own, the lasting changes the story made
  where it made any, the short look and the clothes. The description, the look and the clothes are each in a `pre`
  block. The description keeps its lines, a table among them, and has its characters alone, since the picture model
  never reads it: the details retold from it are under the portrait with their tokens (the owner, 2026-09-27; see
  Portrait). The look and the clothes each have their size as the picture model reads that text alone: tokens of the
  graph's encoder (`textTokens` in `local/picture.ts`) and characters, or characters alone without the tokenizer. The
  sizes are never added up. The card says that the prompt also holds the description of the scene and the style, that
  its exact size is under the picture, and that the text a portrait is drawn from is under the portrait with its
  tokens. A sheet written before 2026-09-27 shows its details in the description's place until the next picture
  writes it again. A card over the bot's 4000 characters, which keep headroom under Telegram's 4096, loses its last
  lines, the note on the portrait first: a description of 1800 fits beside the rest but for a reader's look of 400
  beside long changes (`DESCRIPTION_CHARS` in `local/picture.ts`).
  - The clothes are the story's and are only shown. For the story being played they are the ones the nearest picture up the active branch dressed the person in, and the card names the branch (`wornAt`). Otherwise, and before any picture dressed them, they are the sheet's own, which the story's pictures started from.
  - «✏️ Изменить описание» ("Edit the description", `details-edit:<storyId>:<index>:<tag>`) makes the next text
    message the description, in any language and form, up to 1800 characters (`DESCRIPTION_CHARS`). Its lines are
    kept, since a table of measurements is lines, with the spaces at their ends and the blank lines past one cut.
    «✏️ Изменить короткую внешность» (`look-edit:…`) does the same for the look, on one line, up to 400. Empty text is
    refused and the bot keeps waiting; any button or command, an unknown one included, leaves without a change. When
    the text arrives the person is found again by story and name, so a sheet written anew without them refuses it. The
    name cannot be changed, and nobody is added or removed.
  - A written description is marked `descriptionEdited`, wins over the one the sheet took from the story, and clears a
    look the reader wrote. «⏳ Пересказываю описание для картинок…» ("Retelling the description for the pictures…")
    then stands while one call of the language model retells it with the changes into the details and the look, beside
    the descriptions and looks of the sheet's other people, and the person's card takes its place with the new look.
    The call holds the model's GPU like a job and never wakes it; it yields to other readers' calls, and the reader's
    own next scene waits for it. If pictures are off, the GPU is paused or the call fails, the description stays, the
    person is marked `lookPending`, and the card says they are not retold yet: the pictures and the portrait take the
    earlier look and details until the next frame of the story retells them first. Details or a look with a digit or a
    table's bar in them are refused (`look_numbers`), and a person the answer leaves out stays to be retold
    (`look_missing`). The row is `look_retold`, or `picture_look_retold` before a frame, with the outcome, the people
    asked and written (`retellPeople`, `retoldPeople`), the characters of the longest description and the words of the
    longest look, never the text.
  - A written look is marked `edited`, keeps the details, and says on the card that it is the reader's own: the frames
    take it until the reader writes the description again, which retells a new look in its place. A sheet written
    again, as one from before 2026-09-27 is by its next picture, keeps the reader's description, the reader's look, the
    portrait and a person with any of them whom the new sheet lost, and everybody on it is retold. A change reaches the next pictures of every branch of the story. The story text, its memory and the pictures already drawn stay as they are, and a picture being drawn at that moment may still show the old look. A sample describes its scene again once a look it was described with has changed. A person is known by their name alone, apart from spaces and case, so identity survives only an unchanged name: one the model renames in that rewrite is somebody new, and the look, portrait and buttons of the old name stay with the old name beside them.
- **Portrait:** «🖼 Портрет» ("Portrait", `portrait:<storyId>:<index>:<tag>`) draws the person from the sheet's text of them alone, to pick a reference by: their details, the English prose retold from their description, or their look until the details are retold, as on a sheet written before 2026-09-26 and for details a reader wrote before 2026-09-27 (`portraitText` in `local/image-portraits.ts`). Every name of the sheet and every age given as a number are cut out of it, as out of a frame. It shows the face and the whole figure: full length from the front, standing and facing the viewer with no expression asked for, in plain close-fitting clothes and a plain style of the bot's own (`portraitPrompt`), so build, height, silhouette and permanent marks can be read. The text-to-image graph draws it with a random seed on the graph's canvas turned upright, the smaller side across and the larger down (720x1280 for a graph of 1280x720), which leaves more of the frame to a figure standing full length. No model is asked, so the card is not held for one. It is a drawing on request like a style sample: one at a time with the samples, in the same slot, with the same status line. A second portrait or sample asked for meanwhile is refused, and the first goes on; a move in the story, /cancel or the bot's stop ends it. A variant has a slot of its own and may be drawn beside it. A photo already handed to Telegram is delivered all the same, with its note, and can be kept: a stop while it is on its way does not take it back, and its `picture_portrait` row is `ready` with `cancelled: true`. It is only for a reader whose scenes are drawn, checked on the press and again before the work. A portrait is not sent if the text it is drawn from changes while it is drawn, as a retelling changes it, or if its story is deleted meanwhile.
  - Right after the photo comes its note, folded to one line as a picture's prompt is: «🖼 Внешность, по которой нарисован портрет: 270 токенов · 1 400 знаков» ("The look this portrait was drawn from: 270 tokens · 1,400 characters"). Opened, it shows the text of the person the portrait was drawn from (`portraitText`): the details retold from the description, or the look. The tokens are those of that text alone as the graph's encoder reads it, which the card does not give the description (the owner, 2026-09-27); the prompt adds the pose, the clothes and the style around it. A caption holds 1024 characters and a retelling of 200 words may not fit, so the note is a rich message of its own, as under every other picture ([limits](#telegram-limits)). It has no button for a variant. It is recorded and deleted with the portrait, and a note Telegram refuses leaves the photo as it is, with a `picture_prompt_unsent` row.
  - Under the photo are «🔄 Ещё вариант» ("Another version", the same prompt with a new seed), «✅ Оставить» ("Keep", `portrait-keep:<candidate>`) and the way back to the card. The bot holds the photo it showed in memory for 30 minutes, one per reader, under the id the keep button carries, and with a single timer that knows the id alone. A newer portrait takes its place, so an older button keeps nothing, and neither does one pressed after the text it was drawn from changed. A kept portrait is let go once its write is committed; if that write is rolled back, the same button keeps it again.
  - Keeping writes exactly that photo, stripped like every picture, as a PNG beside the database: `<db>.portraits/<directory>/<random>.png`. The directory is named by an HMAC of the reader's ID under a key kept in the database; directories are 0700, files 0600. The sheet refers to the file (`portrait`: its name, the recipe it was drawn with as a scene keeps its picture's, its canvas included, the text it was drawn from as `look`, the details or the look, and the clothes and style of its prompt) and never carries the picture. The new file is written before the write that refers to it, and a rollback of that write deletes it again. A file nobody refers to (the one replaced, a deleted story's, or one whose write a stopped process never made) is swept once a write commits, and at start. A reader without a directory has no portraits; a directory that cannot be read is logged as `portraits_unswept` with its errno in lower case (`enotdir`), never the message, which names the path.
  - Kept portraits enter frames only for the owner and explicitly admitted testers when the [reference experiment](setup.md#pictures) is enabled. Other readers' pictures do not use them. Once the text it was drawn from changes, as the retelling of a new description changes it, the card says the portrait is of the earlier look, and nothing is redrawn. The experiment still uses that kept portrait until the reader replaces it. A sheet written again keeps the portrait, and the person with it. Frame recipes retain the portrait files they used, even after replacement, so variants and redraws use the same inputs. The keep confirmation tells experiment readers that a replaced portrait stays on disk while pictures drawn from it still need it for variants; other readers see the ordinary confirmation. Deleting the seed or the story takes its portraits out of the chat and off the disk once no remaining recipe or drawing uses them.

### References

A reader in the [reference experiment](setup.md#pictures), the owner or a tester named for it, may give a person a picture of their own (the owner, 2026-09-27: «мы можем просто добавить фичу менять на свой портрет?»). Nobody else has the button, and their cards, frames and files are as they were.

- **Own portrait:** beside «🖼 Портрет» the card has «📎 Свой портрет» ("Own portrait", `ref-send:<storyId>:<index>:<tag>:front`). It waits half an hour for one picture of the person, sent as a photo or as a PNG, JPEG or WebP file of at most 10 MB, and says what it takes: a drawing, never a photo of a real person, whose shorter side is at least 320 pixels and whose longer side is at most 4096 and at most 2.5 times the shorter (`REFERENCE_SIDES` in `local/reference.ts`). Text meanwhile is answered with what the wait is for, and a button or a command, ↩️ and /cancel among them, ends it. Nothing is downloaded after the half hour or for a reader who lost access; a size Telegram declares over 10 MB is refused before the download, which is a seed file's, in memory and never on the disk (`downloadFile` in `local/seed-file.ts`).
  - A file is the format its first bytes say, whatever its name or type. The picture is not decoded and encoded again: it is taken apart by its format's structure and put together from the parts a picture needs — a PNG's critical chunks, a baseline or progressive JPEG's frame, tables and scans, a still WebP's pixels — so EXIF with the place and the camera, XMP, ICC profiles, text chunks, comments, thumbnails and whatever follows the picture's end all go. A file that walk does not get through is refused, as is an animation, an archive or a picture outside those sides, each with a short message in the reader's language, and the wait stays open for another. A caption in English is kept beside the picture, and any other is not.
  - The picture is kept in its own format beside the portraits, `<db>.portraits/<directory>/<random>.<png|jpg|webp>`, with a kept portrait's modes, rollback and sweep. The sheet refers to it as the person's front pose (`poses.front`: its file, format, size in pixels and time, `source: 'own'` and `pinned`), which stands over the kept portrait: the card names it the reader's own with its size, and frames take it where they took the portrait (`frameFile` in `local/picture-references.ts`). The drawn portrait stays under it, and keeping a newly drawn portrait takes the front back. The confirmation is a kept portrait's, with its line on retention. A frame's recipe pins the file and its hash as it pins a portrait's, so a replaced picture stays on the disk while a variant or a redraw needs it, and is swept once nothing refers to it.
  - A frame takes every reference at its own shape and never stretches it to another: the size its file's header gives is scaled to about the area of 352x640, the shorter side rounded to a multiple of 32 first and the longer following it (`referenceScale`). The bot's portraits of 720x1280 come out at 352x640 as before, a square picture at 480x480, a 3:4 one at 416x544 and a 16:9 one at 640x352.
  - `reference_saved` logs how the picture came (`referenceSent`: `photo` or `document`), its format, its pose (`referencePlace`), the bytes sent and the bytes stripped, and its width and height; `reference_refused` logs the reason alone (`referenceRefusal`: `type`, `broken`, `small`, `huge`, `shape`, `too_large`, `incomplete` or `archive`). Neither has a name, a caption or a file name.

<a id='seen-through-their-eyes'></a>

### Seen through their eyes

A second picture mode, asked for by the owner on 2026-09-27 for a tester («может сделать POV типа у гг истории?», «я бы
не делал такое ограничение, а просто то что он может увидеть глазами, это же реальный POV»). With it on, a frame shows
what one person of the sheet sees from where they stand, given their pose and where they look: whatever of their own
body falls into view (hands, arms, legs, chest or belly when they look down, their clothes, what they hold), their
shadow, and their reflection in a mirror, water or glass. They are never drawn whole from outside. A scene they are not
in is drawn as usual. The code is `local/picture-pov.ts`.

- **Switch:** the card of a reader whose scenes are drawn has «👁 Вид от первого лица» ("First-person view",
  `pov:<storyId>:<index>:<tag>`), which stores the person's sheet name as `story.pov`. A story has one such person at
  most: the same button on another person's card switches to them, and that card's last line names whose eyes the
  frames are seen through now. The person's own card ends with a line on what the frames show and offers «🎥 Обычный
  вид» ("Back to the usual view", `pov-off:…`) instead, which ends the mode only while it is that person's. The list
  marks them with 👁 in place of 👤. The name is compared as the sheet compares names, apart from spaces and case. A
  press draws nothing: the next frame takes it, and a sample describes its scene again if the mode or its person
  changed since the frame it would reuse. A library without `pov` loads and draws as before.
- **Request:** `povRequest` adds the rule after the frame's instruction and four fields to its schema, at the call in
  `local/picture.ts` rather than in `local/illustrate.ts`, whose request builders the action experiment pins by hash
  (`textPins` in `local/action-text.ts`). `viewer_in_scene` comes first, so that the shot and the people are written
  knowing it; `viewer_clothes`, `viewer` and `reflection` come after `people`. The rule names the person once and
  names the last scene by its first ten words. It makes the person the camera rather than a person of the answer:
  never in `people`, never named or called the viewer, a woman, he or she, their actions told through the parts of
  them in view ("hands at the bottom of the frame hold the lantern"), and whoever faces them does it toward the
  camera. `viewer` holds only the parts of their own body they see themselves, cut by the frame's edge and
  foreshortened, with the clothes on those parts and their skin, and no face, hair, figure or age; `reflection` holds
  their reflection when a mirror, water or glass is before their eyes. The shot is first-person from their eye height
  and where they look. The answer's limit grows by 250 tokens. A person with no look on the sheet yet is not seen
  through, and their frames are described and drawn as usual.
- **Prompt:** when the answer says the viewer is in the scene, or lists them among its people anyway, `seenBy` takes
  them out of `people`, under their name or as "the viewer", and puts a first-person clause in place of the shot, the
  camera first and in positive words: «First-person POV shot through the eyes, the camera at eye height: <shot>. <what
  of their body is in view>. <their reflection>». Their look from the sheet is never in it, not even with a
  reflection: with it the pier drew the viewer whole beside the water in two pictures of two (below). Every field
  loses the words "the viewer", should the model write them anyway: their hands become the hands, and they themselves
  the camera. Being part of the shot, the
  clause passes the nets for names and ages, opens the prompt, and in a prompt of the reference experiment follows the
  reference instruction. What the viewer wears is kept for the next picture, as a person's clothes are.
- **The first version** (1d5bd2f, live as 27739b9 from 20:05 UTC on 2026-09-27) put the whole look and the clothes in
  the clause («The viewer's own body and clothes: …»), said the viewer "is never shown whole", and had the model call
  them the viewer in the moment and the props. The tester's first frame with it, which had the references of the two
  other people, was the usual scene from outside with one more person in it («при пове может ничего не меняться просто
  как будто добавляется еще один человек с руками»).
- **References:** the viewer is not among the frame's people, so their kept portrait is never sent as a reference: it
  would pull their whole figure into the frame. The others keep theirs. A reflection is therefore drawn from the
  answer's words alone, without their look, and need not look like them.
- **Row:** `picture` and `picture_sample` rows carry `pov`, true for a frame drawn through the person's eyes and false
  for one drawn as usual because they were not in the scene. A story without such a person leaves it out.
- With the mode off every request, prompt, graph and recipe is byte for byte what it was before the mode came
  (checked on 2026-09-27 by a dry run against 40e11d1 with a fake model and a fake ComfyUI, with and without
  references).
- Checked on 2026-09-27 with six calls to the hosted Gemma 4 31B through OpenRouter, on synthetic scenes after
  `examples/seed.txt`: on the pier the answer kept the viewer out of `people`, left the old man there and filled
  `viewer` with the hand that holds the lantern and the reflection in the water, twice; before a mirror, the one call
  asked before the rule named the last scene, it wrote the reflection with the face and the raised hands. A cutaway
  without the viewer («Тем временем Ефим…») came back as the scene before it, with the viewer, in two answers of two
  until the rule named the last scene by its first words, and then as the cutaway, `viewer_in_scene: false`, drawn as
  usual. These answers were to the first version's rule.
- Checked on the card on 2026-09-27, after the first version failed there, with four synthetic scenes after
  `examples/seed.txt` (the pier with the lantern and the water, the mirror, the workbench, and a second person, Лида,
  whose kept portrait was the synthetic L front of the refs stand and went as a reference), each drawn through the bot's
  Qwen graph at seeds 7 and 11. The frame answers were written to each version's rule, the same content in both, since
  the card's text server had no calls to spare, and two more came from its Gemma under the new rule: the mirror and the
  second person. One fresh gpt-6-astra session at high effort judged the 26 pictures blind. The first version: seen
  from someone's eyes 7 of 8, the viewer seen from outside 6 of 8 (on the pier, the mirror and the workbench, never
  with the second person), the other people as described 2 of 8. This version: 7 of 8, 1 of 8 (the mirror at one seed)
  and 8 of 8. With the card's own answers: 4 of 4, 0 of 4 and 3 of 4. Hands were right in every picture. The look in
  the reflection, tried in between, drew the viewer whole beside the water on the pier in two of two. Not checked: a
  frame with two references, as the tester's was, whether the card's Gemma follows the rule on the pier and the
  workbench, and a reflection that looks like the viewer.

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

`/model` opens the same screen. Checking a server generates no text, and the time of a successful check or reply does
not promise that the server is still up. For Claude Code and Codex CLI the screen names the subscription the model
runs on.

`scenePrefix(stats, provenance)` adds the scene's own `{provider, model}` before its context percentage. The backend stores this metadata with new scenes. Old scenes without provenance keep their unlabelled prefix even after a deployment change. No status, endpoint or credential is included in the narrative prompt.

The idle current-context screen offers `compact`. Historical checkpoints and busy screens do not. The backend preserves the last configured number of scenes, archives originals and creates checkpoints before and after compaction. A compaction job uses `state.job.kind = 'compact'`, and the renderer shows compaction wording while navigation and cancellation remain available.

`/compact` asks for the same compaction without waiting for the threshold. It writes no scene and never compacts the
seed. With no more than the kept number of scenes uncompacted, the bot says that there is nothing to compact yet.

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
  Opening the view calls no model.
- **Labels:** byte sizes are exact, and every token estimate carries «≈». The last request is marked measured, and its
  output may include hidden reasoning. A missing number is shown as unknown, never 0. The model name is not shown.
- **Matching stats:** stats are used only if they match the route: a checkpoint's view needs that checkpoint's, the
  current view the active story and branch. Otherwise the screen says there is no data yet and offers the way back.
  While a scene is being written, the current view notes that the unfinished scene is not counted.

<a id='busy-state'></a>

## Busy state (`state.job`)

Navigation, previews and «Последняя сцена» stay available. Buttons for `start`, `use`, `fork`, `continue` and delete confirmations are left out. Where one would normally appear, the screen says it will be available once the scene is done and shows «✖️ Отменить генерацию» ("Cancel generation", `cancel`). Seed entry stays available. There, the cancel button is the ordinary «✖️ Отмена» ("Cancel"); note that `cancel` also stops a running generation.

<a id='waiting'></a>

## Waiting for a model

The bot shares its models. The language model serves every reader and the agents in turn, and the picture card draws
every reader's pictures and, from the next rental on, an experiment's cells in the gaps, behind the readers' jobs
([the bot's picture card](gpu.md#bot-card)). A reader whose request waits is told their place and, once the bot can
tell, roughly when the request starts; never whose requests are ahead, or when theirs will end.

- **Before a scene** the disappearing draft says «⏳ Очередь к модели: перед вами 2 запроса, начало примерно через
  40 с.» ("Model queue: 2 requests ahead of you, starting in about 40 s"), then «⏳ Подошла ваша очередь.» ("Your turn
  has come") and «📖 Модель читает историю, скоро начнёт писать…» ("The model is reading the story and will start
  writing soon…").
- **A compaction** that waits has a line in its status, «Перед вами в очереди к модели: 1 запрос, начало примерно
  через 2 мин.» ("Ahead of you in the model queue: 1 request, starting in about 2 min").
- **A picture**, a scene's, a sample, a variant or a portrait, that has waited 2 s on the card gets a second line under
  its status line, «⏳ Очередь к модели картинок: перед вами 1 картинка, начало примерно через 20 с.» ("Picture model
  queue: 1 picture ahead of you, starting in about 20 s"): the job the card is drawing and the jobs that go before this
  one, read from the card's queue every 2 s. Once the job starts, the line goes and the steps take its place. The
  frame's description before it waits for the language model and shows no place.

Until the bot has timed enough of its own work, and whenever it cannot tell, the reader sees the place alone, as in
«⏳ Очередь к модели: перед вами 2 запроса.». The start comes from what the bot itself sees (`local/eta.ts`):

- **Its own durations**, in memory, from its work as it ends: a turn of the language model by what it does (a scene,
  a compaction, a frame's description, a retelling of looks, an agent's turn), from the moment it takes a slot to its
  end, and a job on the picture card from the server's own stamps of its start and end. The usual length of a kind is
  the median of its last 15, and a kind timed fewer than 3 times has none. A turn with a failed or refused call is not
  timed, and a restart starts over.
- **Text** (`startIn` in `local/scheduler.ts`): each slot is free once the turn in it has run its usual length, less
  what it has run already. Work that gives way to this reader counts for nothing: a probe, a turn that shares a prefix,
  and work prepared ahead for somebody else. The requests before this one then take the first free slot each for their
  usual length. Only a reader is given a start, and only while every kind of work in the way has a usual length.
- **Pictures** (`statusLine` in `local/picture.ts`): the job the card is drawing counts as one of the bot's usual jobs
  less the time this wait has seen it drawing, whoever's it is, and each job before this one as a whole one.
- What is left of work already running counts as 5 s at least, so work past its usual length still counts as 5 s
  more. The start is rounded up to tens of seconds, from «примерно через 10 с» to 50 s, and to whole minutes after
  that, «примерно через 2 мин». The place and the start are told again when the place changes or the start has moved
  by 5 s, or by a fifth of itself when that is more. A picture's line is edited at once for its first place and its
  first steps and otherwise at most every 3 s, and a draft with the same text is not sent again.

What the start cannot see:

- Work that does not go through this bot: another process on the same language model, a gateway's other users, an
  eval, and above all how long an experiment's cells take on the picture card, where each counts as one of the bot's
  own jobs. A cell drawn larger or in more steps than the bot's pictures makes the start too early.
- Readers who come later: every reader's picture goes to the head of the card's queue and the later of two goes first,
  so a picture's place can grow while it waits. On the language model the readers keep their order.
- A shared cache's admission by size and the choice of a slot by the prefix it holds. A scene's turn includes its
  token count and a compaction before it when there is one, so its usual length mixes both kinds of scene.

A row of a request that waited says what the reader was first told, `ahead` and `etaSeconds`, beside what it took in
fact, `waitMs` in the model queue or `imageQueueMs` on the card ([the bot log](gpu.md#bot-log)).

<a id='telegram-limits'></a>

## Limits of a Telegram message

- Screens are capped at 4000 characters, and a checkpoint preview trims the scene so the fork explanation still fits.
  A button whose callback would exceed 64 bytes is dropped rather than sent broken; with library-generated ids this
  does not happen.
- Scenes are sent in full through `sendRichMessage`, for which Telegram allows up to 32768 UTF-8 characters. This is a Telegram limit in characters, separate from the generation limit in tokens. Ordinary menu messages through `sendMessage` allow up to 4096 characters. [Rich Messages limits](https://core.telegram.org/bots/api#rich-message-limits), [sendMessage](https://core.telegram.org/bots/api#sendmessage).
- The prompt under a picture is a rich message folded to one line, so a long prompt costs the chat one line
  ([the prompt under a picture](#picture-prompts)). So is the text under a portrait, which a caption's 1024 characters
  would not always hold ([Characters](#characters)).
- `new-seed` also returns `entities: [{type:'pre', …}]` around the example, so it can be copied with a tap and needs
  no parse_mode escaping. If the backend only forwards `text` and `reply_markup`, the screen still works.
