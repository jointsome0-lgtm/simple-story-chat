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

<a id='pace'></a>

### Story pace

The tester asked for it and the owner approved it on 2026-09-29. «⏱ Темп: …» ("Pace") on the menu
(`view:pace:<storyId>`) picks the pace of the current story (`pace:<storyId>:<moment|scene|chapter>`), kept as
`Story.pace`:

- «⚡ Миг» ("Moment"): seconds to minutes a turn, in detail and with dialogue, at most 6 paragraphs against the rule's
  12. The turn ends where the hero has to act.
- «🎬 Сцена» ("Scene"): the default and the bot as it was. A story without a pace, in an older library too, has it.
- «🗓 Глава» ("Chapter"): hours to days a turn, told briefly, stopping only at an important fork.

The pace can change at any moment, also while a scene is being written, and counts from the next scene request, so a
story's first scene is always at «Сцена». Under «Миг» and «Глава» a written message is the hero's move: the narrator
shows what came of it and how the world answers, and makes no further decision for the hero (the owner's rule of
2026-09-29). «▶️ Продолжить», /continue, the start of a story and an empty `act` of the agent interface hand the move
to the narrator (`Job.move = 'narrator'`), which may then move the hero itself, in small steps under «Миг». The pace
reaches the model as one clause in the story's language (`Narration.pace` in `local/story-text/`), after the
narrator's rule in the last message. The system prompt, the memory call and every request of «Сцена» stay as they
were: a dry run with a fake model, with written messages, «Продолжить», /continue, compaction and a fork, showed them
byte for byte those of 6cf7206. The clauses are not measured yet; their probe is
~/simple-story-chat-runs/2026-09-29/pace/probe.mts. A scene's header is when the scene starts, so after a «Глава»
turn the menu's world time and the next request's reference time stay at that turn's start.

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

- **Prompt under a picture:** every photo, the scene's own, every sample and every variant, gets a reply right after it: a rich message folded to one line, «🖼 Промпт: 243 токена, из них стиль 53 · 1 204 знака» ("Prompt: 243 tokens, 53 of them the style · 1,204 characters"). Opened, it shows the prompt the picture was drawn from as plain text, which wraps to the width of a phone, for the reader to read, copy and tune a style line against (`foldedPrompt` in `local/picture.ts`). It was a code block at first, and on a phone that meant scrolling sideways. A portrait's note holds its whole prompt too, the bot's own or the reader's ([a portrait's own prompt](#portrait-prompt)).
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
  where it made any, the short look and the clothes. The list and the card show the person as they are at the scene
  the reader stands at in the story being played, and as the sheet has them elsewhere; the card says in one line how
  many times their look changed along that line, where it did ([along the story](#along-the-story)). The description, the look and the clothes are each in a `pre`
  block. The description keeps its lines, a table among them, and has its characters alone, since the picture model
  never reads it: the details retold from it are in the portrait's prompt, which is under the portrait with its tokens
  (the owner, 2026-09-27; see Portrait). The look and the clothes each have their size as the picture model reads that
  text alone: tokens of the graph's encoder (`textTokens` in `local/picture.ts`) and characters, or characters alone
  without the tokenizer. The sizes are never added up. The card says that the prompt also holds the description of the
  scene and the style, that its exact size is under the picture, and that the whole prompt of a portrait, with the
  clothes, backdrop and pose, is under the portrait with its tokens and can be edited. A sheet written before
  2026-09-27 shows its details in the description's place until the next picture
  writes it again. A card over the bot's 4000 characters, which keep headroom under Telegram's 4096, loses its last
  lines, those on the point of view and the portrait first: a description of 1800 fits beside the rest but for a
  reader's look of 400 beside long changes, up to the 300 a [profile sent back](#profile) may write, or in the
  reference experiment beside changes of 150 or a portrait prompt of the reader's own (`DESCRIPTION_CHARS` in
  `local/picture.ts`). With every field at its limit the description, the look and the clothes still stay whole.
  - The clothes are the story's, and the card has no button for them: they change in the [whole profile](#profile). For the story being played they are the ones the next pictures of the active branch start from, those the nearest picture up the branch dressed the person in or the reader wrote there, and the card names the branch (`wornAt`). Otherwise, and before any picture dressed them, they are the sheet's own, which the story's pictures started from.
  - «📋 Профиль целиком» ("Whole profile", `view:profile:<storyId>:<index>:<tag>`) sends every field of the person in one block to copy, edit and send back ([the whole profile](#profile)).
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
    portrait and a person with any of them whom the new sheet lost, and everybody on it is retold. A change reaches the next pictures of every branch of the story, unless a reader with
    versions of the sheet wrote it «only from this moment» ([along the story](#along-the-story)). The story text, its memory and the pictures already drawn stay as they are, and a picture being drawn at that moment may still show the old look. A sample describes its scene again once a look it was described with has changed. A person is known by their name alone, apart from spaces and case, so identity survives only an unchanged name: one the model renames in that rewrite is somebody new, and the look, portrait and buttons of the old name stay with the old name beside them.
- **Portrait:** «🖼 Портрет» ("Portrait", `portrait:<storyId>:<index>:<tag>`) draws the person, to pick a reference by, from the bot's own prompt around the sheet's text of them, or from the whole prompt the reader wrote for them ([a portrait's own prompt](#portrait-prompt)). The sheet's text is their details, the English prose retold from their description, or their look until the details are retold, as on a sheet written before 2026-09-26 and for details a reader wrote before 2026-09-27 (`portraitText` in `local/image-portraits.ts`). Every name of the sheet and every age given as a number are cut out of it, as out of a frame. The bot's prompt shows the face and the whole figure: full length from the front on a plain grey backdrop, standing and facing the viewer with no expression asked for, in even frontal light, in a close-fitting dark grey one-piece suit and plain dark shoes (`PORTRAIT_CLOTHES`, the T probe's suit, chosen on 2026-09-27) and a plain style of the bot's own (`portraitPrompt`), so build, height, silhouette and permanent marks can be read. None of it is hidden: all of it is in the note under the portrait, to copy and edit. The text-to-image graph draws it with a random seed on the graph's canvas turned upright, the smaller side across and the larger down (720x1280 for a graph of 1280x720), which leaves more of the frame to a figure standing full length. No model is asked, so the card is not held for one. It is a drawing on request like a style sample: one at a time with the samples, in the same slot, with the same status line. A second portrait or sample asked for meanwhile is refused, and the first goes on; a move in the story, /cancel or the bot's stop ends it. A variant has a slot of its own and may be drawn beside it. A photo already handed to Telegram is delivered all the same, with its note, and can be kept: a stop while it is on its way does not take it back, and its `picture_portrait` row is `ready` with `cancelled: true`. It is only for a reader whose scenes are drawn, checked on the press and again before the work. A portrait is not sent if its person or its story is deleted meanwhile, nor one of the bot's own prompt whose text of the person changes while it is drawn, as a retelling changes it.
  - Right after the photo comes its note, folded to one line as the prompt under a scene's picture is: «🖼 Промпт: 312 токенов, из них стиль 27 · 1 560 знаков». Opened, it shows the whole prompt the portrait was drawn from, as the picture model got it: the bot's own, with the shot, the backdrop, the moment, the person's text with the clothes and the pose, the light and the style, or the reader's own as it came. The tokens are those of that prompt as the graph's encoder reads it, and the style's share is that of the bot's style line (`PORTRAIT_STYLE`); a prompt the reader wrote has none, as a variant's has none. A caption holds 1024 characters and a prompt of 4000 does not fit, so the note is a rich message of its own, as under every other picture ([limits](#telegram-limits)). It has «✏️ Изменить промпт и нарисовать вариант» ([a portrait's own prompt](#portrait-prompt)). It is recorded and deleted with the portrait, and a note Telegram refuses leaves the photo as it is, with a `picture_prompt_unsent` row. Until then the note held the person's text alone, and the rest of the prompt was nowhere to be seen.
  - Under the photo are «🔄 Ещё вариант» ("Another version", the same prompt with a new seed), «✅ Оставить» ("Keep", `portrait-keep:<candidate>`) and the way back to the card. The bot holds the photo it showed in memory for 30 minutes, one per reader, under the id the keep button carries, and with a single timer that knows the id alone. A newer portrait takes its place, so an older button keeps nothing, and neither does one of the bot's own prompt pressed after the text it was drawn from changed. One drawn from the reader's own prompt read no text of the person, and is kept while the person is on the sheet. A kept portrait is let go once its write is committed; if that write is rolled back, the same button keeps it again.
  - Keeping writes exactly that photo, stripped like every picture, as a PNG beside the database: `<db>.portraits/<directory>/<random>.png`. The directory is named by an HMAC of the reader's ID under a key kept in the database; directories are 0700, files 0600. The sheet refers to the file (`portrait`: its name, the recipe it was drawn with as a scene keeps its picture's, its canvas included, the text it was drawn from as `look`, the details or the look, the clothes and style of its prompt, and the whole prompt as `prompt`; one drawn from the reader's own prompt has `ownPrompt: true` and an empty look, clothes and style, whatever it says of them being in `prompt`) and never carries the picture. One kept before portraits showed their whole prompt has no `prompt`. The new file is written before the write that refers to it, and a rollback of that write deletes it again. A file nobody refers to (the one replaced, a deleted story's, or one whose write a stopped process never made) is swept once a write commits, and at start. A reader without a directory has no portraits; a directory that cannot be read is logged as `portraits_unswept` with its errno in lower case (`enotdir`), never the message, which names the path.
  - Kept portraits enter frames only for the owner and explicitly admitted testers when the [reference experiment](setup.md#pictures) is enabled. Other readers' pictures do not use them. For those who do, the card of a person with a drawn portrait kept, or none yet, says that the frames are told to take only the face and figure from it and not to copy its clothes, which may still show through and can be changed in its prompt. Once the text it was drawn from changes, as the retelling of a new description changes it, the card says the portrait is of the earlier look, and nothing is redrawn. The experiment still uses that kept portrait until the reader replaces it. A sheet written again keeps the portrait, and the person with it. Frame recipes retain the portrait files they used, even after replacement, so variants and redraws use the same inputs. The keep confirmation tells experiment readers that a replaced portrait stays on disk while pictures drawn from it still need it for variants; other readers see the ordinary confirmation. Deleting the seed or the story takes its portraits out of the chat and off the disk once no remaining recipe or drawing uses them.

<a id='profile'></a>

### The whole profile

The owner, 2026-09-28: «почему при нажатии персонажа нельзя добавить текущий профиль в сообщение маркдаун…». A tester
still could not edit a person whole: the changes and the clothes had no edit at all, and every other field its own
button and wait. The code is `local/profile.ts`.

- **Show:** «📋 Профиль целиком» ("Whole profile", `view:profile:<storyId>:<index>:<tag>`) on the card sends one
  message: its title, and the profile in one `pre` block to copy with a tap, in a simple Markdown shape. `# <name>`
  comes first, then a `## <heading>` and the text of each field: the description, the lasting changes, the English
  details for the portrait, the short look, the clothes, and the portrait's own prompt where the person has one ([a
  portrait's own prompt](#portrait-prompt)). `# Конец профиля` ("End of profile") comes last. The headings are in the
  reader's language. Each field is as the card has it: the description with its lines and the others on one line, the
  clothes of the branch being played (`wornAt`), and details a reader wrote before 2026-09-27 as the description they
  stood for, beside empty details.
- **Fit:** the profile is one message or none, never clipped. Over the bot's 4000 characters it leaves out the prompt,
  with a line saying that a portrait drawn from it brings it in its note, to edit there; then the description too,
  with a line pointing to the card's own button; and at last it shows no block, only a line pointing to the card.
  Every field at its limit (a name of 60, a description of 1800, changes of 300, details of 1500, a look of 400,
  clothes of 300 and a prompt of 4000) leaves the other four, in 3241 characters in Russian, 3200 in English and 2879
  to 2964 in Chinese, Korean and Japanese. With a name and a story title of 60 each, the six fields fit whole while
  they hold 3496 characters together in Russian, 3520 in English and 3651 to 3698 in the other three. A message counts
  a character outside the Basic Multilingual Plane twice, and a profile of those at every limit shows no block.
- **Edit:** under the block is «✏️ Изменить профиль» ("Edit the profile",
  `profile-edit:<storyId>:<index>:<tag>:<fields>:<hash>`, 44 bytes with a story id of seven characters and an index of
  two). `<fields>` names the fields the message showed, as a hexadecimal mask, and `<hash>` is the first 8 hex digits
  of a SHA-256 of the name, of where new clothes would go and of the text of those fields. It sets
  `ui = {input:'profile', storyId, name, fields, hash}` and says what may change, each field's limit, where the clothes go
  and how to leave. The next text message is the profile sent back, never a move, and any button or command, an
  unknown one included, leaves without a change. The button of a profile that has changed since its message, as a
  retelling or a new picture's clothes change it, shows the profile as it is now and waits for nothing. A sheet older
  than the three layers, which the story's next picture writes anew without the changes, details and clothes written
  into it, is only shown, with a line saying so, and so is a profile a field of which has a line that starts with `#`,
  which could not come back as it went. So is the profile of a person whose look changed along the branch being played
  ([along the story](#along-the-story)): it shows them as the card does at the branch's last scene, and its line says
  that a profile sent back would write for the whole story and points to the card's own edits, which can be made only
  from this moment. Its button pressed, or a profile sent back, after such a change counts as a changed profile.
- **Reading it back:** the text is taken whole or not at all. It runs from the first heading that is no field's, `#`
  and the person's name, apart from spaces and case, to the first end line after it. The lines around the two are left
  out, so a copy of the whole message, its title above the block and the hint under it, reads as the block alone, but
  a heading among them is refused as another profile, or a part of one, so two profiles in one message are refused.
  Telegram splits a message over 4096 characters, and then one part lacks the end line and the other the name, so both
  are refused. Between the two come the fields the message showed, each once, under their headings in any of the five
  languages, case and a colon at the end aside, with nothing above the first. A line that starts with `#` and a space
  is a heading, and one the bot does not know is refused with the line quoted. The description and the prompt keep
  their lines, with the spaces at their ends and the blank lines past one cut, as the card's wait for a description
  has them, and the other fields are one line each. A refusal says what to fix, and the bot keeps waiting.
- **Saving:** only a field whose text differs from the person's by more than its spaces, its line breaks and its
  Unicode normalization (`changedFields`) is written. A client may send non-breaking spaces back, join blank lines or
  turn a table's spaces into tabs; a field that differs by that alone stays as the person has it, since writing it
  would make an untouched description the reader's own and retell it over a look the reader wrote. A changed field is
  written exactly as it came, within its limit: the description 1800 (`DESCRIPTION_CHARS`), the changes 300, the
  details 1500, the look 400 (`LOOK_CHARS`), the clothes 300 and the prompt 4000 (`PROMPT_CHARS`). Only the changes
  and the prompt may be emptied, and an emptied prompt drops the reader's own, so that portraits are the bot's again.
  A field over its limit, or emptied where it may not be, is refused and nothing is written. The name cannot be
  changed. The answer names the fields that changed, or says nothing did, with the ways to the profile and to the
  card. A person gone from the sheet meanwhile, or a profile that has changed since its message (the hash), ends the
  wait with nothing written; the second shows the profile as it is now, since the fields sent back unchanged would
  otherwise write what it said then over what it says now.
- **Retelling:** a new description or new changes are retold into the details and the look as a description written on
  the card is, with the same status line and the card after it, unless the same message wrote new details: those are
  the reader's, nothing retells over them, and a retelling still to come for the person goes (`lookPending`), so that
  one already asked finds it gone and writes nothing. A new look in the same message is the reader's (`edited`), which
  the retelling keeps. A new description or new changes without a new look replace a look the reader wrote before, as
  on the card. New details or a new look alone retell nothing.
- **Clothes:** edited clothes go into the scene at the head of the branch being played (its node's `clothes`), which
  the next pictures of the branch start from (`wornAt`) until a frame dresses the person otherwise. A branch that
  splits off at an earlier scene never walks through that one and keeps its own; one that goes on from that very
  scene, forked there before or after, starts from the reader's where no picture of its own dressed the person since.
  A frame of that scene being described meanwhile leaves the reader's clothes as they are and writes its own only for
  the others (`describeFrame`). For a story not being played, or a branch with no scene yet, they are the sheet's own
  `outfit`, which the story's pictures start from where no scene dressed the person otherwise. The wait says which of
  the two it is.
- **Rows:** `profile_edited` has the outcome (`ready`, or `skipped` when nothing changed), a boolean per field
  (`profileDescription`, `profileChanges`, `profileDetails`, `profileLook`, `profileClothes`, `profilePrompt`),
  whether the person is retold (`profileRetell`), how much of the profile the message showed (`profileFit`: `whole`,
  `no_prompt` or `no_description`), where new clothes went (`profileClothesAt`: `scene` or `sheet`), and the
  characters of the whole text (`profileCharacters`) and of each field it changed (`descriptionCharacters`,
  `changesCharacters`, `detailsCharacters`, `lookCharacters`, `clothesCharacters`, `promptCharacters`).
  `profile_refused` has the reason (`profileRefusal`: `gone`, `changed`, `no_text`, `incomplete`, `name`, `heading`,
  `sections`, `outside`, `empty` or `too_long`) and the characters of the text. Neither has a word of the profile.

<a id='portrait-prompt'></a>

### A portrait's own prompt

The owner, 2026-09-27: «почему я не могу поправить части с серым боди? Ты что-ли где закрепил это... убери это и дай
возможность редактировать то все поле то... зачем эти скрытые зависимости то». The grey suit stays the bot's default,
a recipe chosen on purpose, and is now in plain sight under every portrait, and the reader's to change.

- **Edit:** the note under a portrait has «✏️ Изменить промпт и нарисовать вариант» (`portrait-edit:<storyId>:<index>:<tag>:<seed>:<recipe>`, 53 bytes with a story id of seven characters, an index of two and a seed of ten digits; a longer one leaves the note without the button). It names the person as the card's buttons do, the portrait's seed, and `<recipe>`, the first 8 hex digits of a SHA-256 of the graph's hash and the checkpoint's name: a portrait's recipe is the graph's own but for its seed and its upright canvas, so nothing else needs keeping. It sets `ui = {input:'portrait-prompt', storyId, name, seed, recipe}` and asks for the whole prompt, up to 4000 characters, copied from the note and edited; the next text message is that prompt, never a move, and any button or command, an unknown one included, leaves. A button or a prompt whose `<recipe>` is no longer the bot's is refused with the variant's reason, since the same seed would draw another picture. Empty text or a longer one leaves the wait open, as for a variant, and a person the sheet no longer has refuses the prompt.
- **Variant:** the prompt is drawn as it came, nothing assembled, cut out or appended, with the seed and the upright canvas of the portrait whose note it was, so the prompt is all that differs. It is a portrait like any other: the same status line and slot, the same stops, the caption «🖼 Портрет: <name>. Нарисован по твоему промпту.» with «🔄 Ещё вариант» and «✅ Оставить», and a note of its own with the prompt and the same button.
- **The person keeps it:** the prompt sent is kept on the sheet as the person's `portraitPrompt`, in the write that asks for the variant. From then on «🔄 Ещё вариант» and «🖼 Портрет» draw it word for word with a new seed each time, whatever the description, the retelling or the look say: none of them is in it, and no retelling is waited for. The card then says «✍️ Портреты рисуются по твоему промпту слово в слово…» and has «↩️ Обычный промпт» (`portrait-default:<storyId>:<index>:<tag>`), which drops the prompt, so that the next portrait is the bot's own again. The wait for a look or a description says that it does not change such portraits. A sheet written again keeps the prompt, and a person with one whom the new sheet lost. A library without the field is drawn from the bot's prompt as before.
- **Which kept portrait is current:** the one drawn from what «🖼 Портрет» would draw from now. While the person has a prompt of the reader's, that is a portrait kept with `ownPrompt` and that very `prompt`, which the card calls «🖼 Портрет сохранён: нарисован по твоему нынешнему промпту.»; any other, the bot's or one of an earlier prompt, is «🖼 Сохранённый портрет нарисован не по нынешнему промпту.». Without one, a portrait of the bot's prompt is current while its `look` is the person's text, as before, and one of the reader's prompt is «🖼 Сохранённый портрет нарисован по твоему прежнему промпту…». Nothing is redrawn either way, and the reference experiment's frames take the kept portrait whatever the card says of it, as before.
- The `picture_portrait` row has `ownPrompt`, true for a portrait of the reader's prompt and false for the bot's, and the prompt's size (`promptCharacters`, and with the tokenizer `pictureTokens` and, for the bot's prompt, `styleTokens`); never a word of it. The bot keeps the prompt in the reader's library, on the sheet and in a kept portrait, as it keeps their description, and never in its technical logs.

### References

A reader in the [reference experiment](setup.md#pictures), the owner or a tester named for it, may give a person a picture of their own (the owner, 2026-09-27: «мы можем просто добавить фичу менять на свой портрет?»). Nobody else has the button, and their cards, frames and files are as they were.

- **Own portrait:** beside «🖼 Портрет» the card has «📎 Свой портрет» ("Own portrait", `ref-send:<storyId>:<index>:<tag>:front`). It waits half an hour for one picture of the person, sent as a photo or as a PNG, JPEG or WebP file of at most 10 MB, and says what it takes: a drawing, never a photo of a real person, whose shorter side is at least 320 pixels and whose longer side is at most 4096 (`REFERENCE_SIDES` in `local/reference.ts`). A picture whose longer side is over 2.5 times the shorter was refused until 2026-09-28; since the owner's decision that day it is kept, and each frame's graph pads it to 2.5 with grey along its long sides on the card, where any other picture's graph is as it was (`referencePad` in `local/picture-references.ts`). Text meanwhile is answered with what the wait is for, and a button or a command, ↩️ and /cancel among them, ends it. Nothing is downloaded after the half hour or for a reader who lost access; a size Telegram declares over 10 MB is refused before the download, which is a seed file's, in memory and never on the disk (`downloadFile` in `local/seed-file.ts`).
  - A file is the format its first bytes say, whatever its name or type. The picture is not decoded and encoded again: it is taken apart by its format's structure and put together from the parts a picture needs — a PNG's critical chunks, a baseline or progressive JPEG's frame, tables and scans, a still WebP's pixels — so EXIF with the place and the camera, XMP, ICC profiles, text chunks, comments, thumbnails and whatever follows the picture's end all go. A file that walk does not get through is refused, as is an animation, an archive or a picture outside those sides, each with a short message in the reader's language, and the wait stays open for another. A caption in English is kept beside the picture, and any other is not.
  - The picture is kept in its own format beside the portraits, `<db>.portraits/<directory>/<random>.<png|jpg|webp>`, with a kept portrait's modes, rollback and sweep. The sheet refers to it as the person's front pose (`poses.front`: its file, format, size in pixels and time, `source: 'own'` and `pinned`), which stands over the kept portrait: the card names it the reader's own with its size, and frames take it where they took the portrait (`frameFile` in `local/picture-references.ts`). The drawn portrait stays under it, and keeping a newly drawn portrait takes the front back. The confirmation is a kept portrait's, with its line on retention. A frame's recipe pins the file and its hash as it pins a portrait's, so a replaced picture stays on the disk while a variant or a redraw needs it, and is swept once nothing refers to it.
  - A frame takes every reference at its own shape and never stretches it to another: the size its file's header gives is scaled to about the area of 352x640, the shorter side rounded to a multiple of 32 first and the longer following it (`referenceScale`). The bot's portraits of 720x1280 come out at 352x640 as before, a square picture at 480x480, a 3:4 one at 416x544 and a 16:9 one at 640x352.
  - `reference_saved` logs how the picture came (`referenceSent`: `photo` or `document`), its format, its pose (`referencePlace`), the bytes sent and the bytes stripped, and its width and height; `reference_refused` logs the reason alone (`referenceRefusal`: `type`, `broken`, `small`, `huge`, `too_large`, `incomplete` or `archive`, and in rows from before 2026-09-28 `shape`). Neither has a name, a caption or a file name.

<a id='pose-set'></a>

### Pose sets

The tester, 2026-09-28, through the owner: about 80 pose pictures of one character, unsorted, to be put in as they are, since a LoRA is too dear to train. A reader named in `SIMPLE_CHAT_POSE_SET_USERS` ([setup](setup.md#pose-sets)), which takes only readers of the reference experiment and is empty by default, may give a person a set of pictures, and each frame then takes the one whose pose fits. The set works only while the reader's frames take references at all and while the story model is our own, `llama-cpp` or `simple-serving`, since the captions go into each frame's request. With the list empty every screen, request, graph, Telegram call and log row is as before (dry runs against 71a159f and against 101690f, below). The code is `local/pose-set.ts`, `local/pose-archive.ts` and `captioner/caption.py`.

- **Upload:** the card has «🗂 Картинки поз» ("Pose pictures", `pose-set:<storyId>:<index>:<tag>`). It waits for pictures of the person, one by one or in albums, as photos or PNG, JPEG or WebP files, and takes each as «📎 Свой портрет» takes one ([references](#references)): a drawing and never a photo of a real person, the same sides and 10 MB, the same walk that strips the metadata, and an animation or a file that walk does not get through refused; a ZIP archive is read as below. One more drawn out than 2.5 to 1 is kept and padded with grey in each frame's graph, as an own portrait is. A set holds 200 pictures and 600 MB, and all of a reader's sets together 1 GB (`POSE_SET_PICTURES`, `POSE_SET_BYTES`, `POSE_SET_READER_BYTES`), as the owner set them on 2026-09-29 for the tester's 50 and more drawings of a character; they were 100, 300 MB and 600 MB before. A picture past a limit is refused, and the set stays as it is.
  - A photo or a file is not read in the update that brought it. It goes into the reader's queue (`poseUploads` in their library) as Telegram described it, in the write that marks the update handled, and the update ends there (`queuedPoseUpload`). Each reader's queue is read apart from the updates, one file at a time in the order they came (`uploadNext`), and two files at most at once across readers (`READS_AT_ONCE`), so that the downloads of an album or an archive hold up nobody's requests, the owner's among them: the poll loop hands the updates over one by one, and it used to wait while each picture was downloaded inside its update. A file leaves the queue in the write that keeps its pictures, so a stop or a restart halfway reads it again and keeps it once, and the next start reads what was left, for a reader who has pose sets then; for one who has not, the queue waits unread. A file gets 45 s once its turn comes (`UPLOAD_MS`), Telegram's answer with its path included: after that its read is cut short, the question to Telegram or the download with it, and the file is refused as `incomplete`. A stop cuts short the read under way the same way, and its file stays queued. A queue as long as a set can be takes no more: the next file is refused as `full`, unread, and starts the queue's reading again if a write that failed had stopped it. A file whose set was removed meanwhile goes with it, and one whose person left the story's sheet is dropped; a person is known by their name apart from spaces and case, as a sheet written again knows them, so a name spelled anew keeps its files.
  - No picture gets a message of its own, since an album of forty would be forty messages. One message counts them as they are read, sent at the first and edited at most every five seconds: «Принято: 12. Не принято: 2 (слишком мала: 1, не картинка: 1). В наборе 12 из 200.», with «✅ Готово» (`pose-set-done:…`) under it. That button, any other, a command, or half an hour after the last file (`POSE_SET_WAIT_MS`) ends the wait. The message then says the captions come in the background; while files sent in the wait are still being read, it says how many and that its last word is to come, «Ещё загружаются: 3. … Дозагружаю присланное; итог появится в этом сообщении.», with the card's button under it, and it gets that word with the last of them. Text meanwhile is answered with what the wait is for. The count is kept in memory, one a wait: after a restart the next file read starts a new one.
  - Each picture is kept as a picture of the reader's own is, `<db>.portraits/<directory>/<random>.<png|jpg|webp>`, with its rollback and sweep, and the sheet lists it in the person's `poseSet` with its format, size in pixels, bytes and time, and later its caption. A sheet written again keeps the set, and a person with one whom the new sheet lost.
- **Archives:** the tester keeps a character's drawings sorted, and labels them in a table (the owner, 2026-09-29), so the wait takes a ZIP archive as well (`local/pose-archive.ts`), from a reader on the list alone; for anybody else, and in the wait for an own portrait, an archive is refused as before. An archive may weigh 20 MB (`ARCHIVE_BYTES`), the most the Bot API lets a bot download: one Telegram declares larger is refused before a byte is fetched, with a message to split it. It is read in memory and never unpacked on the disk, its entries stored or deflated, each inflated never past the size its directory declares and checked against it and its CRC. It is refused whole, with a message of its own, when it is encrypted (`encrypted`), ZIP64, in parts or packed another way (`unsupported`), broken (`broken`), holds more than 200 files besides labels.csv (`files`, `ARCHIVE_FILES`), has a path out of it, by `..`, a leading `/` or a drive (`unsafe`), or is a bomb (`bomb`): entries that share their bytes, or that would unpack to more than 100 MB together. Directories, `__MACOSX` and names that start with a dot are skipped; a `./` before a name, which some tools write before every name, is the archive's own folder and hides nothing. Every other file is a picture sent alone: the same walk, sides and padding, 10 MB checked on its declared size before it is unpacked, the same limits and the same count, with its refusal's reason; an archive inside is refused as `archive` and never opened, and an entry of more than 64 KiB that says it unpacks to more than 20 times its packed size, which no PNG, JPEG or WebP does, is refused as `type` and never unpacked, so that one bomb, or one uncompressed file among the pictures, costs itself alone. Each picture is read in a turn of the event loop of its own, so that an archive holds the bot, and every reader's updates with it, no longer than one of its pictures does, and a read cut short, at its deadline or by a stop, ends between two pictures as a download cut short ends; and its walk goes through 16,384 chunks or segments at most (`ARCHIVE_PICTURE_PARTS`), where a PNG of 10 MB has 1,280 in the 8 KiB chunks libpng writes and 4,096 at most written a row a chunk, so that one made of empty chunks is refused as `broken`. Each picture is kept under a name of the bot's own; the names inside serve only to match labels.csv's rows, and nothing is ever written under them. An archive's pictures are kept in one library write, the one that takes it out of the queue, so a restart halfway keeps none of them, and the next start reads it again.
  - **labels.csv**, at the archive's root or in the one folder that holds everything, as a folder zipped whole: UTF-8 with or without a BOM, or Windows' Cyrillic, which Excel saves a plain CSV in; cells apart by commas or semicolons, whichever the header has more of, quoted as a spreadsheet quotes them. The header names the columns, in any order: `file`, and any of `pose`, `side`, `framing` and `main`; without `file`, or with more than 1,000 rows filled (`LABEL_ROWS`), five for each picture an archive may hold, the file is not read. `file` is the picture's path from labels.csv's folder or from the archive's root, or its name alone where no other picture has it, compared in lower case and in NFC, so that a name a Mac wrote decomposed matches; a path over 260 characters or a value over 64 is compared as it came, since composing a run of combining marks takes time that grows with its square. A row that could name two pictures, by two of these ways or by paths apart only in case, names none and is counted among the rows without a picture. A value is the captioner's label in English or one of the tester's Russian words, compared without case, spaces, hyphens or the dots of ё: pose `стоя`, `сидя`, `идёт`, `лёжа`, `на коленях`, `присев`; side `спереди`, `вполоборота влево`, `вполоборота вправо`, `профиль влево`, `профиль вправо`, `спиной`; framing `в полный рост`, `по пояс`, `по плечи`. Left and right are the captioner's, the side of the picture the person faces. An empty or unknown value leaves its field to the captioner, and a picture with all three never goes to it: its caption is the reader's from the start, with a confidence of 1. The picture keeps the labels its reader gave (`given`), which its caption keeps over the captioner's, so each label's source is known. `main` (`yes`, `1` or `да`) marks the picture to stand for its group before the others, the owner's stand-in until the pictures are sorted finer; after it the order below applies. [setup](setup.md#pose-sets) has an example.
  - The counting message adds, once a labels.csv came, how many pictures came labeled and how many go to the captioner, and for each labels.csv, by its archive's name, the rows that matched no picture and those with a value the bot does not know, as a spreadsheet numbers them with the header first, or that it could not be read: «Подписаны в labels.csv: 3; подпишет модель: 6. labels.csv в mira.zip: нет картинки для строк 6; в строках 5 есть значения, которых бот не знает, — эти поля подпишет модель.»
- **Captions:** each picture is captioned once, in the background, by openjev 0.8B on this computer's CPU (`createPoseCaptioner`): its pose (standing, sitting, walking, lying, kneeling or crouching), the side it turns to the viewer (front, three-quarter left or right, profile left or right, or back; left and right are the sides of the picture it faces) and its framing (full body, half body, or head and shoulders), with a confidence. It is the captioner chosen on 2026-09-28 ([the measurement](knowledge/pose-captioner-2026-09-28.md)): on 190 pictures of the refs stands it put 87 of 94 whole figures in the right group and got the turn of 163 of the 190, each character scored with constants fitted on the others, and all three labels right for 83 of the 94. Qwen3.5 2B put 86 in the right group but misread the pose of 18 standing people, at twice the time and more than twice the memory, and SigLIP 2 and Qwen3.5 0.8B put 71 and 75. The bot starts it when a picture waits for a caption and ends it a minute after the last, so a set of 80 takes about five minutes of the CPU once, at about 4 s a picture, and nothing after. It runs niced, on four threads, offline and with none of the bot's environment, so no token or key reaches it, and reads each picture by its path in the reader's own directory; it answers with the labels alone, and an answer that is not labels is no caption. A picture gets two tries, the second at the end of the queue: one it cannot read stays uncaptioned and out of every group, and the card counts it. A captioner that does not start, as one never installed, or whose process ends or stalls on three pictures in a row, leaves the pictures waiting, and is started again ten minutes later or at the bot's next start, which queues every picture still waiting. A new process starts only once the last is gone, killed if it has not left ten seconds after its input closed, so two models never share the memory; and a caption is written to its picture by the picture's file, so a sheet written again in the meantime, with a name spelled anew, does not lose it. No picture and no caption leaves this computer for it.
- **Groups:** a set is sorted by its captions into six groups at most (`poseGroups`): front, three-quarter, profile and back, by the side of a person who stands, kneels, crouches or lies, and sitting and walking, by the pose. Each group has one picture to stand for it, and the others are kept and never sent: one its reader marked `main` in labels.csv over any other, then a standing person over a kneeling, crouching or lying one, the whole figure over half of it and the head alone, since a reference carries the person's build as well as their face, then the surest caption, then the earliest sent. Its caption, in the words the view pick was measured with (`standing, three-quarter left`, `sitting, front`, `head and shoulders, front`), is what a frame chooses by, so a frame chooses among six at most however many pictures there are.
- **Frame:** when the story's sheet has people with groups, the frame's description gets one more field, `view`, right after `who` in each person of `people`: an enum of every group's caption and the empty string, with 100 more output tokens and a rule after the frame's instruction that lists each person's captions (`poseRequest`). It is added at the call in `local/picture.ts` and not in `local/illustrate.ts`, which the action experiment pins. The field, its place and its rule, word for word, are the variant measured on the card on 2026-09-28 with synthetic frames: right after `who` the card's Gemma never ran its JSON away in 248 calls and picked the right view for 154 and 155 of 160 people, where the same field as a person's last key ran away in 34 to 43% of the calls ([view pick](knowledge/view-pick-measurements.md#gemma-card-2026-09-28)). That measurement had the bot's frame request alone, without what it gets for some readers: the lasting changes of versions of the sheet, and POV's fields. A field of POV's that goes right after `who` as well, `place`, follows it: `who`, `view`, `place`.
  - The picked group's picture is the person's one reference (`frameReferences` in `local/picture-references.ts`): at the refs stands 3 and 4, a front and a view of each person together drew extra people in 3 of 6 frames of two. A person with no group picked, by the empty string or by a caption not theirs, has their front: the picture the reader sent for it, else the set's front, else the portrait they kept. The viewer of a first-person frame is not asked about and has none. The field never reaches the stored frame, and the recipe pins the chosen file as it pins a portrait, so a variant or a redraw takes the same picture, whatever the switch says by then. The `picture` row counts the people with groups (`poseSetPeople`) and those the frame picked one for (`poseViewsPicked`).
- **Card:** a person with a set shows «🗂 Картинки поз: 94 из 200, 212 МБ.», how many wait for a caption and how many failed, «По позам: спереди 30, вполоборота 41, …», and whether frames take them now. «🗑 Убрать картинки поз» (`pose-set-drop:…`) asks first and then removes the whole set; the pictures frames were drawn with stay on the disk while a variant or a redraw needs them, and go once nothing does. The button is there whatever the switch says now, so that nobody is left with pictures they cannot remove: a reader taken off the list, or whose story model is hosted, sees the set, a line saying frames do not take it now, and that button alone. A set is the reader's own, in their library and their directory, and no card, button or frame of anybody else's reaches it.
- **Rows:** `pose_set_saved` has how a picture came, its format, the bytes sent and stripped, its size in pixels and the set's count after it (`poseSetCount`); `pose_set_refused` the reason alone (`poseSetRefusal`: a reason of `reference_refused`, or `full`, `person_bytes` or `reader_bytes`); `pose_set_ended` how many the wait kept and refused (`poseSetKept`, `poseSetRefused`); `pose_captioned` whether the picture got a caption and the time, or `caption_refused`, never the labels, which are what the reader's picture shows; `pose_captioner_failed` its code (`captioner_unavailable`, `captioner_timeout`, `captioner_exited` or `captioner_protocol`); `pose_set_dropped` the count; `pose_upload_dropped` a queued file whose person left the sheet before it was read, and nothing else; `pose_upload_failed` the code of a read of the queue that failed, after which the queue waits for the reader's next file, one refused as past the full queue included, or the next start; `pose_archive_saved` how many pictures of an archive were kept and refused, how many of those kept had all three labels from labels.csv (`poseLabeled`) and how many were marked main (`poseMain`), whether labels.csv was there and read (`poseLabels`: `none`, `read` or `unread`), its rows (`poseLabelRows`) and those that matched no picture or had an unknown value (`poseRowsUnmatched`, `poseRowsUnknown`), and the set's count after it; `pose_archive_refused` why an archive was refused whole (`poseArchiveRefusal`: `too_large`, `incomplete`, `files`, `encrypted`, `broken`, `unsupported`, `bomb` or `unsafe`). None has a name, a file, a path, a label or a picture.
- **Checked** on 2026-09-28 by a dry run of the bot, its store, screens, picture reader and picture code, with a fake Telegram, a fake model, a fake ComfyUI and a fake captioner that speaks the real one's protocol, on synthetic pictures: 101 pictures sent, 100 kept and the 101st refused as full, a small picture, an archive and a text file refused with no message of their own, the files stripped, the captioner given nothing of the bot's environment, a picture it could not read tried twice, a captioner whose process ended on every picture left alone after three, six groups with the right pictures standing for them, `view` right after `who` and before a `place`, the sitting group's bytes sent for a person the answer placed sitting and the front's for one it left empty, another reader's buttons reaching nothing of the set, the set shown and removable but unused once the reader was switched off, and every field of every row on the whitelist. With the list empty the new code and 71a159f gave the same hashes of 10 requests, 3 graphs, 37 Telegram calls and 26 rows. Apart from it, a real process that closed its input once it was ready, as a captioner gone between pictures leaves its pipe, cost that picture its two tries and left the bot running.
- **Checked again** on 2026-09-29, with the two commits brought onto 101690f, the line the live bot ran then, with the sheet versions and the whole-profile edit. The dry run above passed its 44 checks there, and a second one over the sheet versions passed 60: pictures in albums, eleven refused, each with its reason (small, shape, huge, archive, type, too large, broken, incomplete, full, a person's bytes and a reader's), and one message counting them; `lasting_changes` first and `view` right after `who` in one request, with both rules; a lasting change, a whole-profile edit, a sheet written again and a look «only from this moment» each leaving the set as it was; the picked group's bytes sent and pinned; a variant and a style sample taking the pinned picture, and a variant after the set was removed too; the reader's own front before the set's when no view was picked; and no row with a word of a story, a look, a path or a caption's label. With the list empty the branch and 101690f gave the same hashes of requests, graphs, Telegram calls and rows in three dry runs, ComfyUI's random upload names and nonce apart: the one above (10, 3, 37 and 26), the sheet versions' own (19, 10, 98 and 50 with them off, 27, 12, 131 and 74 with them on, and 2, 1, 9 and 5 on a library 101690f wrote), and one with a reader's own portrait, variants, style samples, a whole-profile edit and a sheet written again (21, 11, 98 and 69, and 22, 11, 98 and 72 with versions on). With the list naming one reader and a captioner configured, two others off it, one with pictures and no references as the owner has, one in the reference experiment, got 101690f's 20 requests, 10 graphs, 104 Telegram calls and 84 rows; the only difference was the answer to a pose-set button no screen offers them, «Картинки поз тебе сейчас недоступны» in place of «Кнопка устарела». The real captioner, installed by `captioner/setup.sh` from uv's cache with the weights already on disk and started from a directory other than the code's, as the live bot starts, captioned one synthetic picture of the refs stands in 29 s with its load. After GPT-6 Astra's review the same day, with fake processes: one that closed its answers and ignored its closed input was killed ten seconds on and the next started only once it was gone, where before the next had started at once beside it; a caption that came back after its person's name was spelled anew reached its picture; and a stop while the next waited started none. The real captioner, on the reviewed code, captioned the same picture in 11 s, 5.6 GB at its peak.
- **Archives checked** on 2026-09-29, by a dry run with the same fakes and synthetic archives: an album of three kept; one archive, a folder zipped on a Mac with its `__MACOSX` twins and a `.DS_Store`, and a labels.csv with a BOM, semicolons, English and Russian words and a name in NFD, kept its six pictures under the bot's own names and refused a picture over 10 MB and a text file, each by its reason; its three pictures labeled whole never reached the captioner, the two labeled in part got the captioner's label for what they lacked and kept the reader's for the rest, the picture marked main stood for the front over one labeled the same before it, and the count said 3 labeled and 6 for the captioner, row 6 without a picture and row 5 with a value the bot does not know; a bomb of one file was counted as no picture and not unpacked; an archive declared over 20 MB was refused before a byte was fetched, and one whose two files shared their bytes as a bomb, each with its message, and the wait stood; no row had a name, a file or a label. One test (`local/pose-archive.test.ts`) refuses a bomb's file without unpacking it, two files over the same bytes, five names out of an archive, an archive inside one by its name and by its bytes, and a picture over 10 MB before it is unpacked. Archives written by Info-ZIP, by Python and by a streaming writer with data descriptors were read; Info-ZIP streaming from a pipe writes ZIP64, and was refused. With the list empty the branch and 101690f gave the same hashes again: 10 requests, 3 graphs, 37 Telegram calls and 26 rows; 21, 11, 98 and 69, and 22, 11, 98 and 72 with versions on; the sheet versions' three runs; and, for readers off the list while it names one, 20, 10, 104 and 84, and 20, 10, 108 and 90 with a ZIP sent outside any wait and in the wait for an own portrait, which refuses it as ever. With the list on the earlier dry runs passed their 44 and 62 checks, where a ZIP that is none is now refused whole in a message of its own instead of being counted as `archive`.
- **Queue checked** on 2026-09-29, by a dry run with the same fakes and a fake Telegram whose downloads take as long as a file is told to. Behind an album of five whose downloads took 1.5 s each, the owner's `/start`, handed over after it as the poll loop hands the updates over, was answered in 82 ms, where 6a81e91, which read each picture inside its update, answered it in 7,598 ms; the album's updates were handled in 15 to 68 ms, each file queued in the write that marked its update handled, and read in the order it came. An update delivered twice was kept once. «✅ Готово» with three files unread answered with the card at once; the count said «Ещё загружаются: 3» and that its last word was to come, under the card's button, and then gave it with all nine, and `pose_set_ended` came once. A stop while a file was being read kept nothing of it and left all three queued, and the next start read them, each once and in order, in a message of its own. Removing the set took its queued files with it, and the file being read was not kept; a person renamed meanwhile had their two files dropped, with rows that name nothing. A queue of 200 refused the next file as full at once, unread, and a queue of 200 files Telegram could not give was read through in 1.6 s, each refused. No row had a field off the whitelist. With the list empty the branch and 101690f gave the same hashes again in all the runs above, and with the list on the earlier dry runs passed their 44, 62, 23 and 7 checks.
- **Queue checked again** on 2026-09-29, after GPT-6 Astra's third review of pose sets found that a name spelled anew by a sheet written again dropped its queued files, that the deadline left the question to Telegram and the download running, past a stop and the store's closing, and that a file refused as past a full queue did not start a queue a failed write had stopped. The same dry run, with a Telegram whose downloads end when destroyed and whose getFile may never answer, passed 21 checks where a99608b failed 5 of them: a stop cut the download under way at once, where a99608b waited 0.9 s for it, and left its file queued; two files whose person's name became « МИРА » were kept and counted under the person's card; a file whose path Telegram never gave had its question cut at 45 s and was refused as incomplete, and the next was read; a write that failed stopped the queue, and the next file, refused as past the full queue, started it again and all 200 were read; three readers' albums of three were read two files at a time, in 3.1 s, each in order. With the owner's `/start` handed over every 100 ms, as the poll loop hands updates over, while an album of ten whose downloads took 1.5 s each was read, the owner's 167 updates waited 6 ms at the median and 32 ms at most, where 6a81e91 kept them 7.0 s at the median and 14.8 s at most; every 50 ms while an archive of 20.2 MB, fourteen noisy pictures of 600 by 800, was downloaded in 4 s and read, the owner's 175 updates waited 6 ms at the median and 12 to 18 ms at most in four runs, the longest the reading held the bot being 48 to 54 ms, where 6a81e91 kept them up to 3.8 s. With the list empty the branch and 101690f gave the same hashes again in all the runs above, and with the list on the earlier dry runs passed their 44, 62, 23 and 7 checks. Real Telegram timings were not measured.
- **Archives checked again** on 2026-09-29, after GPT-6 Astra's review of archives, 6a81e91's reader with the queue's reading of it, found seven things. Archives built within every limit above held the bot, and every reader's updates with it: a hundred empty files named with 32,000 combining marks each were still being read after 120 s, since composing such a run takes time that grows with its square; ten PNGs of 10 MB made of 750,000 empty chunks each, zipped in 6.2 MB, held it 4.1 s and took 722 MB; and a stored labels.csv of 524,280 rows took 534 ms and 297 MB, and the counting message kept every row number of every such archive. A row could label the wrong picture unnoticed: `a.png` for a row naming `A.png` beside it, and `outer/outer/a.png` for one naming `outer/a.png` from the root. And an archive whose names all began with `./` gave no pictures and no labels, without a word. These five are answered above, before archives are switched on, as the review asked. The other two wait, as it ranked them: the ratio that refuses a file as a bomb also refuses a real PNG whose pixels are stored uncompressed, which ZIP packs 487 times, and a name an old Windows wrote in a code page other than the Russian one, CP437's `é.png` among them, is read as CP866 and matches no row. Throwaway scripts on synthetic archives, f7b2cc5 against the branch: the hundred names, cut at 60 s on f7b2cc5, took 47 ms and were refused as no picture; a header cell of 300,000 marks, cut at 60 s, 33 ms; ten PNGs of empty chunks, which held the bot 4.3 s and took 333 MB, were refused as broken in 184 ms, holding it 26 ms at most, and ten JPEGs of 10 MB of empty segments, which held it 2.8 s, in 180 ms and 33 ms; the 524,280 rows, 422 ms and 303 MB, were not read, in 4 ms, and 1 MB of empty rows took 22 to 44 ms and 9 MB at most instead of 77 to 176 ms and up to 258 MB; 1,000 rows filled were read and 1,001 not, so that the counting message keeps 1,000 row numbers an archive at most, until its wait ends; both rows that could name two pictures named none and were counted without a picture, while a name alone that one picture has and a path from labels.csv's folder where two pictures share a name still matched; the archive of `./` names kept its picture with its label; real PNGs cut in 4,096 and in 1,280 chunks were kept; ten noisy PNGs of 1.9 MB held the bot 5 ms at most instead of 23; and a read cut short between two pictures ended as `incomplete`. The archive at the limits, 200 PNGs that unpack to 95 MB, was read in 109 to 139 ms as before and written in 37 ms, and the archives of Info-ZIP, Python and a streaming writer were read as before. With the owner's `/start` every 50 ms while the archive of 20.2 MB was downloaded and read, on a machine busier than at the runs above, the owner's updates waited 6 to 29 ms at the median and 12 to 298 ms at most in nine runs of the branch, and 6 to 30 ms and 14 to 324 ms in five runs of f7b2cc5 taken in turn with five of them, which had given 12 to 18 ms at most on a quieter one: its fourteen ordinary pictures hold the bot a few milliseconds each on either, and the spread was the machine's. With the list empty the branch and 101690f gave the same hashes again in all the runs above, and with the list on the earlier dry runs passed their 44, 62, 23 and 7 checks. A picture sent alone, into a pose set or as an own portrait as at 101690f, is still walked through all its chunks: one of 10 MB made of empty ones holds the bot about 0.5 s once, and a JPEG of empty segments takes about 450 MB meanwhile. Archives from Windows' Explorer, macOS's Finder or 7-Zip were not tried.
- **Not checked:** what the pictures gain. Round one of the action measurement scored its views (V) 14 points below C on contacts and identity, with views that were edits of a portrait and may have drifted, so whether a fitting pose helps is open, and the switch stays per reader. The reference instruction still tells the picture model to take identity alone from a reference and not to copy its standing pose or framing; it was not changed. The combined schema, `view` and then POV's `place`, has not been asked of the card's Gemma. The captioner was measured on our own graph's pictures of five characters on a plain grey backdrop, standing and sitting, never walking, lying, kneeling or crouching; the tester's drawings may be read worse, and its weakest turn is the three-quarter, 62 of 84 on held-out characters.

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

<a id='what-they-wear'></a>

### What they wear

The tester, 2026-09-28: «если персонаж голый, то он и должен быть голым, если он в одежде, то он и должен быть в
одежде, а не в бодди из референса». Every kept portrait wears the bot's dark grey suit ([a portrait's own
prompt](#portrait-prompt)). The frame's rule asks for a phrase of clothes that begins with wearing and says nothing of
bare skin, and a frame with references gives the scene's clothes only in each person's clause, after the reference
wording and the look. For the readers named in `SIMPLE_CHAT_CLOTHES_USERS` alone ([setup](setup.md)), in
`local/picture-clothes.ts`:

- **The frame's rule:** its sentence on `clothes` becomes the action experiment's change 8 word for word ([the variant
  frame](action-experiment.md#variant)): bare skin named outright («wearing only rolled-up linen trousers,
  bare-chested and barefoot») and nothing bared that the scene does not bare. One sentence follows it, since the
  tester also saw a person the story leaves naked drawn in the clothes of their profile: a person with nothing on is
  «wearing nothing», and `clothes` is never left empty. An empty `clothes` gives the person the outfit they wore before
  the scene, in this picture (`assemblePrompt`, and the words before the references below) and in the next ones, since
  the frame then records no clothes for them (`clothesOf` and `wornAt` in `local/picture.ts`). The schema stays as it
  is, and the sentences are replaced at the call, since `local/illustrate.ts` is pinned (`textPins` in
  `local/action-text.ts`).
- **Before the reference wording:** a frame with reference pictures says what each referenced person wears in this
  scene, in the order of the pictures, right after «Create a brand-new scene…» and before «Use the reference images
  only…»: «The person from image 3 in this scene: wearing only rolled-up canvas trousers, bare-chested and barefoot.»
  These are the clothes the assembly gives the person, the frame's or else the sheet's outfit, through the same nets
  for names and ages, and the person's clause keeps them too. A frame without references changes by the rule alone.
- **Row:** the `picture` and `picture_sample` rows of such a frame carry `clothesStated`, how many people's clothes
  came before the reference wording.

The rule came to the tester's line on 2026-09-29, after the owner approved it at about 13:05 UTC, without the places
of a frame seen through someone's eyes that came with it on the tester stand's line. With the list empty, and with it
naming only a reader who writes nothing, every model request, graph with its uploads, Telegram call and row is
01abf78's: a dry run that day with a fake model, a fake ComfyUI that takes uploads and a fake Telegram, over a story of
three people of whom two had the reader's own fronts, gave 12 requests, 6 graphs, 56 calls and 44 rows the same for a
frame with no reference yet, a frame with both, its style sample, a variant, and a second reader's two frames. With
the reader on the list it passed 18 checks. The two frame requests are 01abf78's with the rule in place of the bot's
sentence and the same schema. The frame with both references and its sample say «The person from image 1 in this
scene: wearing a grey wool coat. The person from image 2 in this scene: wearing nothing.» right before «Use the
reference images only…», and their rows carry `clothesStated` 2. The frame with no reference yet, the variant and the
man bound to no picture get no such words. The second reader's requests, graphs, calls and rows stay 01abf78's, and
nothing of the story reaches a row. The pose sets' and the sheet versions' dry runs give 01abf78's outputs as before.
No picture has been drawn with the rule on this line.

<a id='along-the-story'></a>

### Along the story

The tester, 2026-09-28: «версонировать персонажей каким то образом в каждый момент истории или на чекпоинтах»; the
owner: «Делай». A lasting change the story makes to a person's look, a haircut, a scar, dyed hair, reaches the picture
of the scene where it happens and of every later scene on that line. A picture on another branch, or after going back
to a checkpoint before the change, shows the person as they were there. The code is `local/picture-versions.ts`.

- **Where it lives:** the sheet stays each person as the story's first scene has them. A version is written only where
  something changes, on that scene (`SceneNode.appearance`, by sheet name): the lasting changes a frame of the scene
  named, one line each in the story's language; a description or a look the reader wrote «only from this moment»; and
  the details and the look retold from what is in force there, with a hash of what they were retold from. A person at
  any scene is the sheet with the versions of the line down to it, the nearest last, as the clothes are found (`sheetAt`
  beside `wornAt`). A branch, a checkpoint and going back to one need nothing of their own, and deleting a branch takes
  the versions of its own scenes with them and nothing else. Only text varies: the portrait, the pictures the reader
  sent and a portrait's own prompt are the person's, on the sheet, for the whole story, and the portrait files are
  swept by the sheet as before. A story without versions is drawn from its sheet exactly as before.
- **Who:** versions are read for every reader, but only readers named in `SIMPLE_CHAT_SHEET_VERSION_USERS`, each of
  them a picture reader, have frames that name changes and the choice «only from this moment» ([setup](setup.md)).
  With nobody named every frame request, prompt, graph, recipe and message is byte for byte 189918e's: a dry run with
  a fake model, a fake ComfyUI and a fake Telegram on 2026-09-28 gave the same apart from ComfyUI's per-job nonce, on a new
  library and on one 189918e wrote.
- **The frame names a change:** such a reader's frame request gets `lasting_changes`, at the top level and first in
  the answer, and a rule after the instruction that lists each person's look and changes as the frame has them
  (`changesRequest`). It asks for the lasting changes the story made in the last scene or before it that neither shows:
  hair cut, shaved, grown, dyed or gone grey, a beard shaved or grown, a scar, a tattoo, a lost eye, finger or hand.
  Not clothes, jewellery or what is in hand; not what washes off or passes (wet, dirty or tousled hair, blood, bruises,
  fresh wounds and bandages, a blush, tears, a hairstyle for once), a pose or a mood; not where the look merely
  disagrees with the story; not a change the person's changes list already; when in doubt, none. The field is never
  the last key of a person: `view` there ran away into whitespace in 42 answers of 124 on the card on 2026-09-28, every
  one right after `action`, and in none of 124 right after `who`, and the point of view's top-level fields in none of
  40. The answer's limit grows by 150 tokens. A change named for a person of the sheet other than the point of view's
  viewer, three at most for one scene and 200 characters each, and not one they have already, is written as a version
  of the scene, and those people are retold at once, so that this very frame draws it: one more call of the language
  model, on a scene with a change alone. It carries no story, so on a server with one slot the next request of the
  story reads its prefix once more. A retelling that fails leaves the person pending, as on the sheet, and the next
  frame of the line tries again.
- **What wins is what is later.** A change a frame named wins over the description in force above it, the story's or
  the reader's: the retelling gets those later changes after its pinned rule, with a rule that they win
  (`laterRequest`). A description the reader wrote «only from this moment» wins over the changes above it, as the
  reader's description wins over the sheet's changes (the owner, 2026-09-27). A look the reader wrote stays in the
  frames until they write a description, whatever the story changes meanwhile, as on the sheet.
- **The reader's edits:** such a reader's wait for a description or a look says the edit is for the whole story, on
  every branch, and has «📍 Только с этого момента» ("Only from this moment", `edit-scope:here`). It keeps the scene
  the reader stands at in the wait (`ui.from`), and the wait then says the edit is for that scene of the branch and
  every scene after it, with «🌐 Для всей истории» (`edit-scope:all`) to go back. The choice is on the wait, before the
  text, so that the text is taken in one message as ever and the bot never holds it while asking. At a scene another
  branch goes on from, as right after going back to a checkpoint, it is not offered, since the version would reach that
  branch's later scenes too, and the wait says so until the next scene. An edit for the whole story lands on the sheet
  as before, and takes the place of what the reader wrote «only from this moment» anywhere in the story, which the wait
  counts: a description takes the place of their descriptions and looks, and a look of their looks, and is written
  beside a description of theirs, whose retold look would otherwise stand there. So it holds in every scene of every
  line, and the changes the story made stay and are retold over it. `landEdit` decides where an edit lands. The
  [whole profile](#profile) does not call it yet and writes as before, for the whole story; the profile of a person
  with a version on the reader's line is only shown, as the card shows them there.
- **Card, list and portrait:** each person is as they are at the scene the reader stands at in that story, the head of
  the branch being played, and as the sheet has them elsewhere. The card adds «📜 По ходу истории внешность менялась 2
  раза…» where the look changed along that line, a count of the scenes that changed it. A portrait is drawn from the
  person at that scene, and the card calls a kept one current only while it was drawn from what they have there.
- **Rows:** `sheet_version_written` (`versionSource` `story` or `reader`, `versionField` `change`, `description` or
  `look`, `versionPeople`, `storyVersions`), `sheet_versions_cleared` when an edit for the whole story took the place of
  some (`versionsCleared`), `picture_version_retold` before a frame and `version_retold` after an edit, with the
  retelling's fields, and `lastingChanges` on the `picture` row of such a reader. Never a word of a change, a
  description or a look.
- **Older code:** 189918e reads a library with versions, draws from its sheet and keeps the versions as they are when
  it writes (the same dry run).
- **Checked** on 2026-09-28 with 29 calls to the hosted Gemma 4 31B through OpenRouter on synthetic scenes. The frame
  kept its fields in every answer and named the haircut, the scar that stayed, the dyed hair, the shaved beard, the
  tattoo and a haircut two scenes back, 2 of 2 each, and nothing for wet hair, blood and a bandage, for a look that
  merely disagrees with the story or for plaits for a feast, 2 of 2 each. It named a change the person's changes
  already had, while their look did not show it yet, in 2 answers of 2, until the rule said not to: then 0 of 1, 0 of
  1 with the look retold, and the two haircuts still 1 of 1 each. The retelling, 5 calls: a later haircut made the hair
  short. A dyed-hair change above a description of chestnut hair with a scar after it, and a shave for the second of
  two people, each failed a check stricter than the rule once (a hair colour named, the shave said in words); the
  second answers, read for words alone, had the scar and no red but no hair colour, and the beard gone and the first
  person's long chestnut hair kept. The retellings took 1.9 to 3.1 s there, which is not the card.
- **Not built, or not known:** the sheet is still written once, from the history of the first illustrated scene, on
  whatever line that was. A change is written at the first scene whose frame names it, so a scene between, drawn later,
  names it again, and the person counts it once. A look the reader wrote hides the changes, as on the sheet. The
  point of view's viewer is not in the field. The reference experiment's frames take the kept portrait whatever look it
  shows, as before, so a portrait drawn after the haircut on one branch lends its hair to another. A version that is
  out of date is retold before the next frame of its line, or at the reader's scene after an edit, and a card elsewhere
  says the person is pending until then. The card's Gemma has not answered the field yet: the probe for the next
  rental is ~/simple-story-chat-runs/2026-09-28/sheet-versions/run.mts.

<a id='mini-app'></a>

## Mini App

A first step, read-only (2026-09-29): a page inside Telegram with the reader's stories, a story's characters and one
person's card, to see whether that is handier than the chat's screens. It is served only where the owner sets it up
([setup](setup.md#mini-app)) and only to the readers of `SIMPLE_CHAT_MINI_APP_USERS`. It changes nothing: editing,
drawing and playing stay in the chat. The server is `local/mini-app.ts`, the page `local/mini-app/`.

- **Button:** a listed reader's list of a story's characters has «📱 Открыть в мини-приложении» ("Open in the Mini App"),
  a `web_app` button to `<url>/?story=<storyId>`, which opens the page at that story's characters with the list of
  stories under it. Nobody else's screens change. Telegram shows such a button in a private chat only.
- **Screens:** the stories, the one being played first and then the newest, with their branches, scenes and
  characters; a story's characters as the chat's list has them; a person's card with the chat card's fields and lines
  (`characterCard` in `local/ui.ts`), less those about its buttons. The picture its portrait line speaks of, the
  reader's own in the reference experiment or else the kept portrait, is full width, and a tap shows it whole.
  Telegram's Back button goes back one screen. The words are the reader's interface language, from the bot's catalogs.
- **Access:** each request carries the launch data Telegram signed (`Authorization: tma <initData>`), checked against
  the key derived from the bot token in constant time (`initDataUser`). Launch data over an hour old
  (`INIT_DATA_SECONDS`) or more than five minutes ahead of this clock is refused as a forged one is, with 401, and the
  page asks to reopen it from the chat. The reader is the one the signed data names, never one an address names, and
  the answer comes from that reader's library through a read-only connection of the server's own. A reader off the
  list, anything missing and anything of another reader's answer alike: 404 with the same body. A picture comes with
  the same header and is shown from memory; its file is the one the reader's library names, in the reader's own
  directory, a plain file under 16 MB, read by `readReference`. Requests past the server's bounds
  ([setup](setup.md#mini-app)) answer 429, and the page offers to try again.
- **Page:** plain HTML, CSS and JavaScript, no build. Telegram's `telegram-web-app.js` is its only outside address: no
  fonts, no analytics. Its policy lets it run its own and Telegram's scripts, fetch from its own address alone and be
  framed by Telegram Web alone, and it takes the colours of the reader's theme (`--tg-theme-*`). The page keeps the
  launch data in memory; Telegram's script keeps its launch parameters in the window's session storage, as for any
  Mini App. No Telegram client has opened it yet: it was checked in headless Chrome with synthetic launch data.
- **Log:** `mini_app_ready`, or `mini_app_failed` with an errno, at start; `mini_app_served` (`stories`, `characters`,
  `card`, `picture`) and `mini_app_refused` (`no_init_data`, `malformed`, `forged`, `expired`, `not_listed`,
  `missing`, `picture_unavailable`, `library_too_large`, `busy`), with `actor` once the reader is known, each row at
  most once a minute.

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
- A person's whole profile is one message or none, never clipped: over 4000 characters it leaves out the prompt, then
  the description, and a profile sent back over 4096 arrives in parts, each of which is refused
  ([the whole profile](#profile)).
