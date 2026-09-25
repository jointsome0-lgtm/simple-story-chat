# The action measurement

The owner's question, 2026-09-25: in a scene where several people touch, the text model mixes their looks and their
actions up. Does the first picture show the action better when Gemma writes the situation without dwelling on looks,
and portraits carry the looks? And does it help to pick each person's portrait by the side they turn to the camera?

What the run can answer is narrower, and this protocol says so. Gemma still reads a story full of looks, and the bot's
frame already leaves `look` empty for the people of the sheet, so no arm isolates a confusion inside the text model.
The run compares workflows: whether keeping appearance out of the frame's other fields, and handing the looks to
portraits, makes the drawn action better. To tell where a failure comes from, each stage is checked on its own: the
narrator's scene against its target, the sheet against the cast, the prompt's text against the checklist, and the
picture ([judging](#judging)).

The identity run of the same day found that portraits of 704x1280 keep a face but break actions: people turn to the
viewer as in their portraits, and a frame with four of them took 82 s against 15 s without
([the run](identity-experiment.md#result-2026-09-25)). This measurement asks about the action first, on scenes built
for it, and on the bot's own path: the uncensored Gemma writes the scenes and the frames on a rented card through
[simple-serving](model-providers.md#simple-serving-our-gateway), and Qwen-Image 2.1 draws them on another. Nothing of
it has run yet except [stage 1](#stage-1), which wrote the frames of the clean scenes with a hosted Gemma and drew
nothing.

<a id='stage-1'></a>

## Stage 1: the frames without a card

On 2026-09-25 the hosted `openrouter:google/gemma-4-31b-it`, not the heretic, described 13 synthetic stories through
the bot's own adapter: the sheet, the frame on the bot's instruction, and the frame on a variant that asked for the
action while it happens, every participant up to six, and a `view` of each person. It took 39 calls, none retried or
unparsed, 101 630 tokens, about $0.03. The stories, the replies, the prompts and the full review, in Russian, are in
the gitignored `illustrations/action/stage1/`. A Claude session wrote those stories' scenes, not the narrator.

What it found, and what this protocol changes because of it:

- No action went to another person in 26 frames. Grips and body sides mostly followed the scene, with exceptions: a
  daughter holds the father's shoulder and armour where the scene has her arm round his neck, and the patient's right
  and the giant's right wrist became screen sides.
- The bot's limit of four people dropped people in 4 scenes of 13 (the beach, the lineout, the rescue, Gulliver), and
  in three of them the moment still spoke of the whole group. The rule "before or after the complex contact" never
  moved the moment. In the variant every human participant was in the frame's text, but not always as a person of
  their own: Gulliver's three guards shared one entry, and the macaque on the backpack strap dropped out of both
  frames. The creatures were never `people` and never on the sheet.
- Gazes and faces dropped out and grips did not: the father's look back over his shoulder, snarls, laughter.
- The props rule ("name people by a visible feature", "who has empty hands") put appearance into props and moment,
  and declared empty the hands of three people holding the demon.
- "From the waist up" cut a contact twice: a grip under the knees, and a leg wrapped round a leg.
- The sheet lost ages (daughters of 8 and 4 both "young girl"), wrote three guards as one line, kept the creatures
  (jellyfish, macaques) off the sheet, and let the Russian word «рыжая» into one look. Giant and tiny lived only in
  the looks.
- `view`, "which side faces the camera", did not fit 16 of 49 people and could not be decided for 7, and all three
  `back` were wrong. Gemma wrote where a person stands relative to the central figure, not which way they face.
- In the form with portraits, "the person from image N" was never tied to the role words of other lines ("the
  demon", "the flyer").

## The arms

Gemma writes two frames of every scene, one on the bot's instruction and one on [the variant](#variant). Six arms
draw them:

| Arm | The text | References |
| --- | --- | --- |
| A | the bot's frame, assembled by `assemblePrompt` as the bot does | none |
| A+ | the variant, with the sheet's looks | none |
| L | the variant, without the looks of the people who have a portrait | none |
| C | L's text, each of those people named "the person from image N" | their front portraits |
| V | as C | each portrait turned the way the person faces ([views](#views)) |
| T | an edit of L's picture that keeps everything and takes faces and builds from the portraits | L's picture, then C's portraits |

Each pair compares two workflows, and each difference changes more than one thing. No arm here separates them
further, so the mechanisms inside a difference stay open.

- A+ against A is the whole variant: seven changes, a new schema and output limit, a frame written anew, and the
  assembly with role and facing. No single change is measured.
- L against A+ takes the looks out and shortens the text at once. If L gains, leaving the looks out was enough for the
  gain; whether the brevity or the removed conflicts did it stays open.
- C against L adds the portraits and the "image N" wording together. C against A+ is the substitution the owner asks
  about: portraits in place of written looks.
- V against C turns the portraits, and a view is also an edit, which may drift from the front in face, marks and
  detail.
- T against L adds a second generation, conditioned on L's picture, the portraits and an instruction of its own. T
  against C compares two strategies of different cost. Ordinary edit drift is not controlled.
- No arm is compared with the identity run: the scenes, the text model, the assembly, the reference size and the casts
  all differ.

## The set

Eighteen stories: the 13 clean stories of stage 1 and five sharp ones that Gemma writes itself.

- The owner's five: a warrior flees a rockfall with his wife on his back and his daughters in his arms (`flight`);
  three people hold a demon by different parts of his body (`demon`); women close tightly round a young man on a
  beach (`beach`); two giants poke at a traveller (`giants`); a swimmer covered by jellyfish with human faces
  (`jellyfish`).
- Eight scenes of close contact with nothing erotic in them: grappling on a mat (`guard`), a rugby lineout
  (`lineout`), a cheerleading lift (`cheer`), a tango dip (`tango`), macaques robbing a tourist (`monkeys`), a
  stretcher carried by rescuers (`rescue`), a giant tied down by tiny people (`gulliver`), a game of twister
  (`twister`).
- Five sharp scenes, one per theme: a bathhouse, a harem, captivity, an interrogation, a battle with wounds.

A story is a seed and one reader's action, in Russian, as the bot's stories are. The seed names the place, the time
and each person with a name and a look. The narrator writes the opening scene from the seed and the action scene from
the reader's action, through the bot's `generateScene`, and the frames describe the action scene. Two scenes rather
than one, because the sheet's instruction asks for the people who appear in more than one. The clean seeds and
actions are written from stage 1's stories, their `target` and `cast`, and fixed in `examples/action-set.ts` before
any card, each with its target: the contact the moment should hold and the participants it needs. No moment has more
than six participants. Gulliver's cast is cut from seven to six before the set is frozen, two guards instead of
three, each a person of their own. The scenes are not stage 1's: the reader's action says what the moment is, and the
scene is whatever the heretic writes.

Each sharp story is written by the heretic on the same card, in one call, before its flow starts. Its instruction is
the only sharp text a Claude session writes, and it names the theme and nothing more. The harness pins this wording:

> Придумай завязку для интерактивной истории для взрослых на тему «ТЕМА». Все персонажи взрослые, им больше двадцати
> лет. Никакого сексуального насилия и ничего сексуального без согласия. Откровенность и жёсткость допустимы, если
> тема к ним ведёт. Нужны от трёх до шести персонажей с именами и заметно разной внешностью: пол, возраст словом,
> телосложение, волосы, приметы; место и время. Завязка должна подвести к одному моменту, где несколько персонажей
> тесно касаются друг друга: держат, несут, обнимают, моют, связывают или перевязывают. Ответь в JSON: seed,
> завязка в 6-12 строк; action, действие читателя, которое ведёт к этому моменту, одна-две фразы.

A sharp story's target is that instruction's own: one moment where several of its people touch closely. The sharp
stories are [sealed](#sealed).

Whether a scene reached its target is the first thing the judges answer, before any picture exists: whether the
contact happens, whether each participant it needs is in it, and whether the moment can be told apart. A scene that
missed stays in the run as written and is never asked again. The report counts the misses and shows every gate over
the scenes that reached their target beside the main count. A pass those scenes do not repeat is reported as a pass
of the main count alone, never as success on the moments the set was built for.

<a id='text-run'></a>

## The text run

It runs on the text card once simple-serving's smoke has passed whole on that card, by the smoke's own record: every
probe of one plain run, from the gateway's state through the count matrix to its privacy check, not a single
completion. Never before. The stop, the read-back and the resume with a new boot are the rehearsal's, on a card of its
own ([the rentals](#the-rentals)); the text card is never stopped. Every call is the bot's own, through the
`simple-serving` adapter as class `internal`:

1. for a sharp story, its seed and action;
2. the opening scene and the action scene, by `generateScene`, in the harness's own store;
3. the sheet, by `sheetRequest`, read by `sheetOf` as the bot reads it;
4. the bot's frame, by `frameRequest`;
5. the variant frame.

That is 95 calls before retries, 5 seeds and five calls for each of the 18 stories. The gateway's smoke, the marker
check, the retries and the counts the adapter may ask for before it sends are requests on top of these, and the
report gives them apart. Two stories run at once, since the gateway admits two `internal` calls; that is a
provisional limit of its contract, not a measured throughput.

The bot's `askJson` only parses a reply. The harness wraps the provider and records every attempt: its kind, the
tokens in, out and cached (a count the gateway does not give stays unknown, never 0), the gateway's wait, first token
and total, the finish, whether it was the retry, and a code. No text reaches a log or the terminal. Each reply is then
decided by rules fixed now:

- `unparsed`: `askJson`'s second try did not parse either;
- `truncated`: a reply that parsed but finished on `length`;
- `schema`: a reply that parsed and breaks its schema, checked on the raw reply before `sheetOf` could drop an
  entry: a required field missing, a value outside an enum, more than six people, or, in the variant, two
  participants with the same role, compared trimmed and without case;
- `empty_sheet`: a sheet with no entry;
- `failed`: the call failed, with the adapter's code.

A failure takes out what needs its output: a scene or the sheet, the whole story; the bot's frame, arm A; the
variant, A+, L, C, V and T. Nothing is asked again by choice.

<a id='again'></a>
One exception, the owner's of 2026-09-25. On the text cards of that day simple-serving's gateway forbade whitespace
between a schema's tokens, and 5 of the 18 sheets came back with nobody on them
([the note](knowledge/gpu-measurements.md#text-cards-2026-09-25)). Those five sheets are asked once more on a card
whose gateway allows whitespace, with `texts --again` and their ids, and the frame and the variant after them. The
scenes stay as they were written. A sheet's first outcome stays in its story's `text.json` as `earlier` and in
`texts.json` as `again`, and `--again` refuses a story whose sheet did anything else. The pins cannot tell the two
gateways apart, since the whitespace rule is the card's and not the adapter's, so `again` is what names the five.

The run is pinned to the local end of `cli up`'s tunnel, held in the foreground, the served name
`gemma-4-31b-heretic-nvfp4`, a context of 65536, the bot's sampling for this provider, and the instructions and
schemas by their hash. The adapter's timeout is 900 s, the gateway's own wall for `internal`, where the bot's default
is 300. The harness reads `client_key` alone from `~/.config/simple-serving/config.json`, which also holds the control
and Vast keys, and prints none of them.

If the smoke fails, the texts wait for a text card with llama.cpp and the bot's Q6_K, rented with a «да» of its own,
and the harness takes the model from `.env.gpu` as eval's `gpu:<label>` does. The report names the weights either way.
Route A is simple-serving's 4-bit NVFP4 conversion of the same heretic, not the bot's Q6_K; whether it writes stories
as well is eval's question, not this one's.

<a id='variant'></a>

### The variant frame

The variant is the bot's frame instruction with these changes and no others. Its text and schema live in the harness,
pinned by their hash. The bot's own instruction does not change unless [gate 1](#gates) passes and the owner agrees.
Every line of the bot's instruction was read against the changes: the rule of four and its crop, "before or after the
contact", the props example and the empty hands are replaced, and the rule to hide precise contacts is kept for small
objects, as change 7 says.

1. The moment is the main action the scene ends in, while it happens, not before or after it.
2. Every participant of the main action is in `people`, up to six: people, animals and creatures alike, each as an
   entry of their own even when they are alike, so two guards are two entries. People who only watch may be left out.
   Over six, a crop leaves the rest out, and part of a group is never shown as the whole of it.
3. `role`, new and required: two to eight English words, one phrase for one participant, used for nobody else and
   repeated word for word wherever `moment`, `props`, `state` and `action` name that participant. It names their part
   in the moment and their place, with an explicit owner of anything it mentions ("the running father", "the girl in
   the father's left arm", "the rear lifter of the near pod"), and never their appearance or name. Species and scale
   stay in it where they are the scene's premise ("the crouching giant", "the tiny sailor"). Code checks that no two
   participants share a role; the length is advice to the model and is not checked.
4. `facing`, new and required, one of `viewer`, `away`, `screen-left`, `screen-right` and `other`: where the front
   of the person's torso points as the camera sees it. A three-quarter view takes the nearer value, and one exactly
   between two takes the one nearer `viewer`. Lying face up under a camera from above is `viewer`, and face down is
   `away`. `other` is for what the four cannot describe: a creature without a front, or a torso that points up or down
   the picture, as a body lying face up seen from the side. `facing` speaks of the screen alone: body sides stay the
   person's own, as the bot's rule says, so a person in profile turned toward the left of the picture shows the camera
   their own left side. Where the head turns and the eyes look belongs to `action`.
5. No lasting appearance outside `look`: no hair, face, skin, build, age or colour of clothes in `moment`, `shot`,
   `setting`, `objects`, `props`, `role`, `state` or `action`, and clothes only in `clothes`. The action needs some
   words that look like appearance, and they stay: expressions, fresh wounds and dressings, the body parts of a
   contact, and a garment as the place of a grip ("grips his collar"). `props` names each important object once, with
   its state and every holder by role and by where they hold it ("the stretcher, its front handles held by the
   front-left carrier and the front-right carrier"). The example of "the gray-clad woman" and the rule on empty hands
   go.
6. Where the scene says where a person looks or what their face does, it is part of their `action` ("looks back over
   his right shoulder", "snarls"). A face turned away from the viewer keeps where it looks and gets no expression
   nobody could see.
7. The shot keeps the main action's contacts in the picture. The edge of the frame never cuts a limb where it touches
   another participant: no "from the waist up" when knees or legs touch. A body may hide a contact where the scene
   puts it behind that body; the edge may not. The bot's rule to hide precise contacts stays for small objects, a
   blade in a slot or fingers on a button, and does not cover contacts between participants.

In the schema, `people` holds up to six items, and `role` and `facing` are required, `facing` as an enum. The output
limit is 1800 tokens, twice the bot's: stage 1's longest variant reply took 710 with six people before `role` and
`facing` were asked for, and a cut reply is a failure.

### The sheet

The sheet is the bot's own and does not change, since the bot's portraits are drawn from it. Its defects belong to
the pipeline and are measured, never repaired. Code compares it with each clean story's frozen cast, one entry per
person, and with the participants of each sharp story's checklist. The report gives, per scene, the participants of
the moment, how many of them the sheet has, and how many were bound to a portrait. The sheet asks for age in words
made for adults (young adult, middle-aged, elderly), so the daughters of 8 and 4 in `flight` are expected to come out
wrong; the judges' check of the portraits says whether they did.

<a id='assembly'></a>

## Assembly

Code assembles every prompt from the two frames and the sheet, without a card and without a model.

- **The binding manifest** is planned for each variant frame before the card. It lists, in the frame's order with
  the sheet's people moved first, each person's sheet entry by `matchSheet`, the id of the portrait planned for that
  entry, and the slot. A person the sheet does not name, a creature or a stranger of one scene, is not bound and keeps
  the frame's own `look` in every arm. Two people matched to one entry, or one portrait planned for two slots, stops
  the plan with a code, and the scene leaves L, C, V and T, since the plan is what drops L's looks; A and A+ stay.
  The number bound is checked against the sheet's people in the frame. On the card, each portrait's file is checked
  against the plan before a frame that needs it is sent. One manifest decides every variant arm: whose looks L drops,
  and which portraits C, V and T send in which slots. It takes the place of `bindingPlan`, which stops at the first
  person without a portrait and could bind fewer.
- **A** is `assemblePrompt(frame, sheet)`, the bot's frame and nothing else.
- **A+** writes each person as "look, role, facing, clothes, state: action", with the look taken from the sheet as the
  bot takes it. `assemblePrompt` and `withoutLooks` know neither `role` nor `facing`, so this assembler is the
  harness's own, pinned by its hash.
- **L** is the same, without the looks of the people the manifest binds.
- **C** and **V** are L's text, with each bound person's clause beginning "The person from image N, ROLE,", N being
  the slot's number. That ties the image to the role words the other lines use, the tie stage 1 found missing.
- **T** is "Image 1 is the finished picture. Keep everything in it: the place, the light, the framing, every pose,
  grip and contact, and all clothes. Change only the faces, hair, skin and build of these people in image 1, and a
  build only as far as every contact stays where it is:", followed by one clause per bound person, "ROLE takes them
  from the person in image N", with N counted from 2. A person missing from L's picture is still named, and the
  judges' answers show what the edit made of that. T samples from an empty latent at full denoise like every frame,
  so keeping image 1 is an instruction to the model, not a copy of pixels.
- `facing` becomes "body facing the viewer", "back to the viewer", "body turned toward the left of the picture" or
  "body turned toward the right of the picture", which speak of the torso and leave the head and the gaze to the
  action. `other` adds no words.
- Names and ages are stripped as the bot strips them, and the style line ends every frame's prompt.

The assembly prints counts only: words, tokens as the encoder counts them, people per frame and people bound, and the
letters outside the Latin script, which would have caught stage 1's «рыжая».

<a id='views'></a>

## Portraits and views

A front portrait is drawn for each person a manifest binds, by the identity run's recipe
([portraits](identity-experiment.md#portrait-recipe)): the whole figure from the front, in the bot's plain clothes,
before a grey backdrop, on the text-to-image graph at 720x1280, seed 7.

A view is drawn only where a frame needs one. For each bound person whose `facing` is `away`, `screen-left` or
`screen-right`, one view is drawn as an edit of their full-size front, with this prompt and the portraits' style
line:

> Image 1 shows one person. Draw the same person, with the same face, hair, build, marks and clothes, on the same
> plain grey backdrop, the whole body in frame, arms relaxed, now {with the back to the viewer | turned toward the
> left of the picture, seen from the side | turned toward the right of the picture, seen from the side}.

At `resolution` 0 the encode node reads the 720-wide front at 704x1280, so a view is drawn on a canvas of 704x1280,
the size its reference reaches the encoder at: the pinned graph's own note says any other size shifts an edit. A view
is never a mirrored portrait, since a mirror moves a scar or a parting to the other side. Every portrait and view is
drawn once, and none is drawn again or chosen among.

**References reach the encoder at 352x640** in C, V and T, half the identity run's size. Each portrait and view goes
through a scale node of its own to 352x640 on its way to its slot, and the encode node stays at `resolution` 0, so T's
first image, L's picture, keeps the canvas size. One `resolution` for the whole node could not do both. The edit graph
gets a seventh slot for T. `local/image-batch.ts` takes the node on a slot for the file's loader, so the drawing code
learns the scale node: it finds each slot through it, names the file on the loader behind it, drops a whole chain a
frame does not use, and counts the geometry after the scale. The graphs as they are submitted are checked by
[the smoke](#picture-smoke), against [fake-comfy.ts](../local/fake-comfy.ts) in the dry run and then on the card: every
slot sends the file its manifest names, and T's first slot is not scaled. Every picture loses its metadata on the way
to the card and back, as `local/image-batch.ts` already does. The identity run's 704x1280 took 82 s a frame with four
portraits, longer than a reader would wait, and a frame here binds up to six. The results hold for this size and this
recipe: no arm compares sizes, and none is compared with the identity run.

## Drawing

- Every frame is 1280x704, on one edit graph with seven reference slots: six portraits, and L's picture in T. The
  slots a frame does not use leave the graph. A, A+ and L use none, and the identity run's control showed that this
  draws the same file as the bot's text-to-image graph.
- Seed 7 decides, and seed 11 repeats it only if [the time](#time) admits it after seed 7. The order on the card is
  [the smoke](#picture-smoke), the rest of the front portraits, the rest of the views, seed 7 in all arms scene by
  scene, then seed 11 the same way. L is drawn before T of the same scene and seed.
- Where no bound person of a variant frame needs a view, V's inputs equal C's. V is then not drawn, and C's
  picture counts for V.
- A manifest whose plan stopped takes its scene out of L, C, V and T, a failed front out of C, V and T, and a failed
  view out of V. A failed frame is that cell alone, and a T whose L is missing is never submitted. A cell left undrawn
  by the deadline or the admission is `not_submitted`, nobody's failure. Nothing is drawn again, and every file is
  kept.
- Each frame records what the identity run's frames record ([telemetry](identity-experiment.md#telemetry)). The run is
  pinned as that one was ([pins](identity-experiment.md#pins)), with the variant's hash, the views' and T's templates,
  the reference size and the manifests added, and the text run's model and gateway versions beside them.

<a id='picture-smoke'></a>

**The smoke** is the scene with the most bound people, the first in the set's order on a tie, at seed 7: its
portraits, its views and its six arms. It therefore sends the most references any C, V or T of the run will send. If
its frame needs no view, the smoke also draws the first view another scene needs, so that views are timed, and the
main run keeps that view as drawn; if no scene needs one, V is never drawn and gate 4 is inconclusive. Its cells are
the main run's cells of that scene and seed, drawn once. It passes when all of these hold:

- every cell is drawn and none failed;
- the geometry is right: frames 1280x704, fronts 720x1280, views 704x1280, and the scaled references, saved by the
  smoke's graphs as copies, read back at 352x640;
- each submitted graph sends every slot the file its manifest names, and T's first slot is not scaled;
- every picture's phases were heard on the socket, as the identity run's smoke required;
- the card kept at least 2 GiB free at the sampled peak.

When only T's cell fails, T leaves the whole run and the report says so. Any other failure ends the rental. The smoke
checks the mechanics alone: whether views turn, whether T keeps L's action and whether half-size references keep a
face are what the judges measure, on every scene.

<a id='time'></a>

**The time.** The harness takes an absolute end, `--until`, as the identity run did ([one
hour](identity-experiment.md#one-hour)): five minutes before the earlier of the guard's deadline and the operator's
own. Nothing is sent after it, and no job is sent that its price says could not end by then; that is asked once more
right before the job goes out, after its uploads and its socket. Nothing is measured before the smoke, so each of its
cells is priced at the longest a picture may take, its whole wait (`--wait`, five minutes) and three seconds. After
the smoke, the harness prices the rest of seed 7, the portraits and views included, from the smoke's own slowest
times: a portrait by its slowest portrait, a view by its slowest view, a frame without references by its slowest of A,
A+ and L, an edit with k references by its slowest edit with the fewest references at or above k, which is C's or V's,
and T by its T. Those times include the smoke's first, cold loads. Each cell gets its time plus a quarter and three
seconds for the transfers, as the identity run priced them. A kind of cell the smoke did not draw, such as an edit
with more references than any it drew, is priced as its slowest edit, never at nothing. Seed 7 begins only if all of
it can end by `--until`; if it cannot, the rental ends as a smoke result and is never extended. After seed 7, seed 11
is priced the same way and begins only if it fits whole. If it does not, the verdict stands on seed 7 alone, as it
would anyway.

The estimate, from the identity run's 15 s for a frame without references and its 15% more for one full-size
portrait:

| | minutes |
| --- | --- |
| ssh, Qwen's files, torch, the verification and the tunnel, at 300 Mbit/s (the identity run's table) | 14 |
| about 70 fronts at 15 s | 18 |
| about 40 views at 18 s | 12 |
| seed 7: 54 frames without references at 15 s | 14 |
| seed 7: about 33 frames of C and V at 20 to 30 s | 11 to 17 |
| seed 7: 18 frames of T at 25 to 85 s | 8 to 26 |
| seed 11, the same frames again | 33 to 57 |
| the margin before the guard | 5 |

That is 115 to 163 minutes of the guard's 180. T's time is the least known: four portraits of 704x1280 took 82 s in
the identity run and two took about 20 s, and the cause of that jump was not measured. T sends L's picture at
1280x704 and up to six references at 352x640, between those two in pixels.

<a id='judging'></a>

## Judging

The judges are fresh `gpt-6-astra` sessions through `codex exec`, at high reasoning effort in a read-only sandbox,
each started in its own copy of its bundle with its pictures attached, as [the second
panel](identity-experiment.md#second-panel) ran. The model, the effort, each task's text by its hash, and the size
the pictures are attached at are pinned. No task names the arms, shows a prompt of a picture it judges, or states a
hypothesis or a threshold. Four kinds of session work on each scene.

1. **The checklist**, from the narrator's action scene, its target and the sheet, after the text run and before any
   picture exists. It lists:
   - the participants, each with a short handle and the sheet entry that is them, if any;
   - the relations of the moment the scene ends in, each with one subject, one verb and one object, and the body part
     and its side only where the scene gives them. A side the scene does not give is never made up, a contact both
     ways is one relation, and each relation is marked essential or not. The essential ones are the contacts the main
     action is made of; a scene whose text shows none lists none, rather than make one up. Each carries a short quote
     from the scene;
   - the gazes and faces the scene names, the clothes it names for the moment, and the scale where it is a premise;
   - whether the scene reached its target (see [the set](#the-set)), and where the sheet's line for a person
     contradicts the scene.

   Code takes the checklist out, gives every item an id of its own, and stores it; no later session changes it. The
   checklist's words, its handles, relations and quotes, stay with its story, under `sealed/` for a sharp one. What
   the scoring reads is its projection: the ids, the kind of each item, which relations are essential, which
   participant is which sheet entry and so which portrait, and whether the scene reached its target. Only that
   projection leaves a sharp story, never the checklist's own answers block.
2. **The text and the portraits**, after the card: the checklist, the sheet, the prompts of A and A+, the front
   portraits, and each view beside its front with the direction it was asked for. It says which relations, gazes and
   clothes each of the two prompts states; whether each bound person's `facing` fits the moment and the shot; whether
   each front matches its sheet line in face and hair, build and marks; and whether each view is the same person,
   turned the way it was asked.
3. **The pictures**, one session per scene and seed: the action scene, the sheet, the checklist, and that seed's
   pictures, six at most, in an order drawn by code and named by hashes. C's picture, when it stands for V, is shown
   once. For each picture the session first says who is who: each participant present, absent or `unsure`, and
   where, told by their looks and place before any action is scored. Then:
   - each relation, gaze, face, clothes item and scale item: `yes`, `no` or `unsure`. A contact hidden by a body is
     `unsure` unless the picture shows it; a contact the frame's edge cuts off is `no`;
   - a mix-up of each kind: an action done by the wrong person, two people's looks swapped, two people merged into
     one;
   - an anatomy error: a limb too many or missing, bodies merged, a joint bent the way it cannot;
   - for each sheet person present, whether they look as their line says.
4. **The identity**, once session 3's answers are stored: the same pictures and the front portraits of the bound
   people, the same references for every arm. For each picture and each bound person: present or not, and whether the
   face and the build each match the front.

The narrator's scene decides who takes part and what they do; the sheet decides the looks score, and the front
portraits the identity score. A judge who cannot tell who is who in a picture answers `unsure` for that participant,
rather than decide it by the action being scored.

A session sees its pictures together, and it may compare them; nothing here prevents that, so the answers are
comparative judgments. Four clean scenes, picked by code from the set's hash before the run, get a second session 3
at seed 7. The report gives how often the two agree on each kind of item, and which verdicts would change if the
second's answers stood on those four scenes. The repeat never replaces the first, and it covers neither the sharp
scenes nor identity.

Each report ends with its answers as one JSON block, and each kind of session has a schema of its own, pinned by its
hash. The checklist's schema describes the items it lists. The other three take only the ids code gave and values from
their enums, and a block with anything more or anything missing is invalid; the report's prose stays with the report.
A clean scene's report without a valid block gets one fresh session of the same kind, and a second one without counts
as a judge's failure; a sharp scene's goes as [below](#sealed). With both seeds there are 18 checklists before the
picture card, and 94 sessions after it: 18 of text and portraits, 36 of pictures, 36 of identity and 4 repeats. With
seed 7 alone there are 58 after it. The fresh sessions for invalid reports come on top.

<a id='gates'></a>

## The scores and the gates

Each picture gets these scores:

- **contacts**, the main one: the share of its scene's essential relations shown, and **all contacts**, whether every
  one is;
- gazes and faces, clothes and scale, each a share of its own;
- **complete**: every participant present;
- **mix-ups** by kind, and **anatomy**;
- **looks**: the share of the scene's sheet people who are present and look as their line says, counted over all of
  them, so a person missing counts as not;
- **identity**: the share of the scene's bound people who are present with both the face and the build of their
  front, counted over all of them the same way. It says that a picture matches its portraits, not that it matches
  the story's person; the portrait check says how well the portraits match their lines.

A score with nothing to count in a picture, such as scale in a scene without one, gazes in a scene that names none,
or identity in a frame that binds nobody, is `not_applicable`: neither a failure nor `unsure`, and the picture is
left out of that score's mean. A scene whose checklist has no essential relation is out of the contact scores and
stays in the count of cells; no essential relation is ever made up.

An arm's score is the mean over scenes, so a scene with many relations weighs no more than one with few. The report
gives the numerators, the difference between the arms of each pair scene by scene, in how many scenes each arm is
ahead, level and behind, and a 90% interval for each difference from 10 000 resamples of the scenes with a fixed
seed. The gates compare exact values; the report rounds to whole points. It also gives the text audit's share of the
checklists' relations stated in A's and A+'s prompts, and the share of fronts that match their line and of views
judged right.

The gates are fixed before the paid run and counted by code on seed 7, as thresholds for the next decision and not
as proof. At 18 pictures one picture is 5.6 points, and the two seeds share one text and one set of portraits, so they
are not more scenes. A `no` and an `unsure` both count against a picture. "At most n/10 more" means at most
max(1, ⌊n/10⌋) more of the gate's n matched pictures: one at 18 scenes, and still one at the six scenes gate 4 may
have, which is 17% of them. "No more mix-ups" counts the pictures with a mix-up of any kind; the kinds are reported.

- Gates 1, 2, 3 and 5 read the seed-7 scenes where every arm they compare is scored. Each is **inconclusive** when
  fewer than 14 of the 18, or fewer than 10 of the 13 clean ones, are left.
- Gate 4 reads the matched scenes where V was drawn, and its only minimum is 6 of them.
- Each clause counts the gate's matched scenes where its score applies. A gain, a clause that asks for more contacts
  or more identity, needs at least 6 of them, or its gate is inconclusive. Gate 4's two gains are alternatives, each
  with its own safeguard: the gate passes when a branch whose gain has 6 scenes passes and the shared clauses hold,
  fails when a shared clause fails or both branches have 6 scenes and fail, and is inconclusive otherwise. A
  safeguard, a clause that asks for no loss, such as no lower scale, counts whatever scenes it has; with none it is
  `not_applicable` and does not stop a pass, and the report says so.
- The sharp scenes count in every gate as part of the 18. Their own numbers are descriptive, and nothing is claimed
  of the sharp scenes alone.
- An arm that passes must also have a contacts score of at least 50%, the mean over scenes, whatever its gain; with no
  scene to count it in, the gate is inconclusive.

1. **The variant text.** A+ passes against A when its contacts are at least 10 points higher, and it has at least as
   many pictures with all contacts and with every participant, no more mix-ups, at most n/10 more anatomy errors, and
   no lower scale. A pass puts the variant's changes to the owner for the bot's own instruction.
2. **The owner's idea.** C shows the action better than A+ when its contacts are at least 10 points higher, with at
   least as many complete pictures, no more mix-ups, at most n/10 more anatomy errors, and clothes no more than 10
   points lower, so that the portraits' plain clothes do not replace the scene's. If L gains as much against A+,
   leaving the looks out was enough for the gain.
3. **Portraits worth pursuing.** C passes against A+ when its contacts are at most 5 points lower, its identity at
   least 15 points higher and its looks at most 5 lower, with no more mix-ups, at most n/10 fewer complete pictures
   and n/10 more anatomy errors, and clothes no more than 10 points lower.
4. **Views.** Over the scenes where V was drawn, V passes against C when its contacts are at least 5 points higher
   with identity at most 5 lower, or its identity at least 10 points higher with contacts no lower; with no more
   mix-ups, no fewer complete pictures, at most n/10 more anatomy errors, clothes no more than 10 points lower, no
   lower scale, and at least 80% of the views judged the same person turned the way asked.
5. **Two passes.** T passes when its contacts are at most 5 points below L's; it keeps at least 80% of L's shown
   essential relations, the ones shown in both L and T over the ones shown in L, pooled over the scenes, where a
   scene in which L shows none adds nothing and fewer than 10 in all make the clause inconclusive; its identity is at
   least 15 points above L's and at most 5 below C's; and it has no more mix-ups than L, at most n/10 more anatomy
   errors and n/10 fewer complete pictures, clothes no more than 10 points lower and no lower scale.

Each gate is also shown for the clean scenes alone and for the scenes that reached their target, and seed 11's
numbers stand beside seed 7's as a repetition: whether each difference points the same way. Neither changes a
verdict. The times are shown per arm, the median and the slowest of the warm frames against A's. T's time is L's and
its own together, and the time to a reader's first picture with portraits includes the fronts and views a new story
needs. No gate reads the times, and an arm with portraits that passes still needs a time the bot can live with before
it reaches a reader.

<a id='complete-run'></a>

## What the run delivers

The report gives, for each arm, the cells planned, submitted, drawn and scored, and every other cell with its reason:
the text's code, the sheet, a front, a view, a failed draw, a timeout, `not_submitted`, or a judge who gave no valid
answer. The gates read matched scenes, and this count reads every planned cell, so a failure that took a scene out of
a gate still counts against its arm here. Seed 7 is complete when each of its cells is drawn or has its reason. A
sharp scene that no judge answered stays out, and the report says how many.

<a id='sealed'></a>

## The sharp scenes are sealed

[The owner's second exception](improve-loop.md#acceptance-on-gpu) for judging pictures applies. The judge is
`gpt-6-astra`. A report without a valid answers block goes to `gpt-6-sol`, and what both leave unanswered goes to the
owner on a page of their own. The sharp texts go nowhere but the two rented cards and the judges' sessions, and their
pictures are shown to the owner on a gallery page of their own.

Where every piece of a sharp story lives, and what leaves it:

- Everything is under the gitignored `illustrations/action/sealed/`, one directory per story: the store of its text
  run, which the harness keeps there and never in the system's temporary directory; the seed, the scenes, the sheet,
  the frames, the prompts and the manifest; the portraits, views and pictures; the judges' bundles; each judge's
  events, its stderr and its report; the answers; the owner's pages.
- `codex exec` runs with `--ephemeral`, so it keeps no session file of its own, in a working directory inside the
  sealed bundle and with `TMPDIR` in `sealed/tmp`.
- For a sharp story the harness prints its id, `sharp-1` to `sharp-5`, codes from a fixed list, counts and times. An
  error prints its code and the fields that pass `safeErrorDetails`, never a message or a body. After each picture the
  card's record of the job is deleted, as `local/image-batch.ts` does. The file the graph saved stays on the card,
  with its prompt in its text chunks, until the card is destroyed and read back as gone; nothing reads it there but
  the harness's download. No Claude session reads a card's files or logs while a sharp story is on it.
- What leaves `sealed/` is the validated answers, ids and enum values, and the counts made from them.
- The owner added that path to the denies of `.claude/settings.json` on 2026-09-25; only the owner edits that file.
  A deny covers the file tools and not a subprocess, so no Claude session runs a command that reads there: the harness
  is the only reader.

**The boundary test**, before any card: the dry run puts a made-up word into a sharp seed, into the fake model's
replies, into the body of a fake provider error, into the metadata of the fake ComfyUI's pictures, into a fake judge's
prose and into a malformed answers block. Code then searches every file the run wrote outside `sealed/`, the temporary
directory, and the harness's own stdout and stderr, for that word. One hit fails the test. What `codex exec` keeps in
its own files is not checked: the owner decided on 2026-09-25 that the judges read and keep what they are given
without limits, and no Claude session opens `~/.codex`. On the text card, before the five sharp seeds are asked for,
one synthetic story marked sealed, with a made-up name in its seed, goes through the sealed path, and the same search
runs; a hit stops the sharp stories.

## The rentals

Each card needs the owner's explicit «да», with its price and its end, under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). Everything is dry-run before the first of them: the text
flow against scripted fakes of the adapter and against simple-serving's dev launcher, the pictures against
[fake-comfy.ts](../local/fake-comfy.ts), the judging on made-up answers, and the boundary test.

1. **The rehearsal** is simple-serving's first rental: the cheapest card of 16 GB or more, from
   `npm run gpu:rent -- --lane small`, with Gemma 4 E2B from simple-serving's branch `rehearsal-e2b`, which is never
   merged. It runs that README's whole first-rental runbook, the stop, the resume and `smoke --after` included, and
   none of this measurement's texts. It ends with `--destroy` read back as gone, as every card here does.
2. **The text card** is a 5090 with the heretic, rented after the rehearsal and prepared as simple-serving's README
   says for its card, with the trial guard of its contract, which deletes it three hours after its first start; the
   owner's deadline for it is chosen apart, before the creation. The operator watches the card from its creation, and
   it is never stopped and resumed. `up` comes first, then one plain smoke, without `--before` or `--after`, whose last
   probe is its privacy check (its contract's section 15, step 2: a synthetic marker shows up in no log of the engine,
   the proxy or the gateway), then the marker check of the sealed path, then the text run, and then the card is
   deleted with `--destroy` and read back as gone. A stop is not an end: a stopped trial keeps its disk, and its guard
   does not run.
3. **The checklists** are written between the text card and the picture card, from the texts alone.
4. **The picture card** is a 5090 from `npm run gpu:rent -- --lane pictures --qwen only --hours 3`. It is rented only
   when every prompt is assembled and counted and every checklist is stored, and it ends as the identity run's card
   ended ([termination](identity-experiment.md#termination)).

Before the rent dry-runs the estimate is an hour and a half of the text card and up to three hours of the picture
card, about $3 with the downloads. Each dry-run's `session` replaces it before the «да» for that card.

## Not verified without a card

The text cards of 2026-09-25 answered two of these ([the third](knowledge/gpu-measurements.md#text-card-3-2026-09-25)):
vLLM loads route A on the 5090 and simple-serving passes its smoke, 10 of 10 on the third card, and route A's heretic
kept the variant's schema in all 18 stories, each at its first attempt. Still open:

- whether it keeps `facing` better than stage 1's hosted Gemma kept `view`;
- how long an edit takes with six references of 352x640, and with T's seven;
- whether the views keep the person and turn the way they are asked;
- whether references of 352x640 keep a face.

<a id='runbook'></a>

## Runbook

The owner's step is done: on 2026-09-25 the owner added `Read(./illustrations/action/sealed/**)` to the denies of
`.claude/settings.json` ([sealed](#sealed)). Before each card the operator checks that it is still there, and edits
nothing in that file. Everything lives in one directory, `illustrations/action`, whose `sealed/` that deny covers:
every command but `dry-run` refuses another `--dir`, and a link on the way to `sealed/`. Each command but `dry-run`
prints one JSON object a line, of ids, codes, counts and times: a sharp story shows as its id, and an error as the
harness's own refusal or as a class and a code, never as what a parser read. `SIMPLE_SERVING_CHECKOUT` is
simple-serving's checkout, as `npm run test:serving` names it. The runbook, in its order:

```sh
# Before any card: all of it against fakes, then the texts against simple-serving's dev launcher.
dry=$(mktemp -d)
npm run image:action -- dry-run --dir "$dry"    # eleven steps, then "the dry run went as expected"
# In simple-serving's checkout, in a terminal of its own. dev.json holds the dry run's made-up client key.
uv run python -m simple_serving.dev --config "$dry/dev.json" --engine-port 8200 --public-port 8201 --control-port 8202
npm run image:action -- dry-run --dir "$dry" --dev http://127.0.0.1:8201    # reached false, then 13 stories
grep -cF 'illustrations/action/sealed' .claude/settings.json    # before each card: 1 or more
# The text card (the rentals, 2), prepared as simple-serving's README says in "The card". In that checkout, once SSH
# to the card works, `trial` names this card in the configuration, and `up`, in a terminal of its own, holds the tunnel.
uv run python -m simple_serving.cli trial --ssh-host HOST    # HOST: the text card's host in ~/.ssh/config
uv run python -m simple_serving.cli up    # until it says ready
# In a second terminal in that checkout, the plain smoke, into a file of this card's own:
mkdir -p logs; set -o pipefail
uv run python -m simple_serving.smoke | tee logs/smoke-text-card.jsonl    # exit 0, 10 of 10 passed
smoke="$SIMPLE_SERVING_CHECKOUT/logs/smoke-text-card.jsonl"    # back in this checkout, from now on
npm run image:action -- texts --marker --smoke-record "$smoke"    # pass true, before any sharp seed is asked for
npm run image:action -- texts --smoke-record "$smoke"    # complete true, exit 0
# Only for the five sheets of 2026-09-25 (#again), after the marker check on that card:
npm run image:action -- texts --smoke-record "$smoke" --again demon,lineout,cheer,twister,sharp-2    # again 5
npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
# Between the cards:
npm run image:action -- prompts       # the six arms' prompts, fronts and views, as counts
npm run image:action -- checklists    # the checklist sessions; ready true, or a page waits for the owner
npm run image:action -- collect       # once the owner has saved each page's answers; ready true
# The picture card (the rentals, 4), only once ready is true:
SIMPLE_CHAT_RENT_DRY_RUN=1 npm run gpu:rent -- --lane pictures --qwen only --hours 3    # each offer's `session`
npm run gpu:rent -- --lane pictures --qwen only --hours 3    # with the owner's «да»; `rented` names ID and destroyBy
npm run gpu:rent -- --show ID    # present, at once
destroy_by=DESTROY_BY            # from `rented`
# As soon as ssh answers, the guard, as the identity run checked it. A failed guard is the termination at once, and
# the runbook ends there: nothing is copied onto the card or started on it.
guard=$(timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast \
  'flock -n -E 75 /root/.simple-chat-trial-guard.lock true; [ $? -eq 75 ] && cat /root/.simple-chat-trial-deadline')
if [[ $guard =~ ^[1-9][0-9]{0,11}$ ]] && (( guard <= destroy_by )); then
  end=$(( (guard < destroy_by ? guard : destroy_by) - 300 ))    # min(guard, destroy_by) - 300
else
  echo 'failed guard: the termination, and nothing more'
  timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
  exit 1
fi
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only bash /workspace/simple-chat/gpu/image-bootstrap.sh'
# The server and the tunnel, each in a terminal of its own. The server's output is the card's log: it goes nowhere.
ssh -t simple-chat-vast \
  'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 bash /workspace/simple-chat/gpu/image-serve.sh' >/dev/null 2>&1
bash gpu/tunnel.sh --pictures-only simple-chat-vast
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/action/card.txt
npm run image:action -- draw --smoke --until "$end"    # the smoke's verdict; pass false is the termination
npm run image:action -- portraits --until "$end"    # seed 7 priced whole, then the rest of the fronts and views
npm run image:action -- draw --until "$end"    # seed 7 scene by scene, then seed 11 if it fits whole
# The termination, here and after every other ending: we're done, then the destroy whatever the ssh did.
timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'; \
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
# After the card:
npm run image:action -- bundles    # one bundle a session, and those skipped, by reason
npm run image:action -- judge      # the text, pictures, repeat and identity sessions, four at a time
npm run image:action -- collect    # once the owner has saved each page's answers
npm run image:action -- judge      # the identity sessions that waited for those pages
npm run image:action -- report     # report.json, and report.md for the owner
npm run image:action -- gallery    # gallery.html, and sealed/gallery.html for the owner
```

**Before any card**, `dry-run` goes through all of it against fakes: simple-serving's gateway as
[action-fakes.ts](../local/action-fakes.ts) plays it behind the real adapter, [fake-comfy.ts](../local/fake-comfy.ts),
and a judge that writes made-up answers, in a directory of its own with `tmp/` as the temporary directory. A made-up
word goes wherever a sharp story's words would, and into a fake provider error's body, the fake pictures' metadata, a
fake judge's prose and a malformed answers block. On the way it goes through every refusal the paid run relies on:

- the sharp stories held until a marker check has passed, and a check that passes;
- each outcome of [the text run](#text-run) once, `schema` by a shared role and `failed` by a provider error, and a
  retry that parses;
- a finished text run that asks nothing again, and another address refused with `texts.json` byte for byte unchanged;
- the smoke refused while a sharp checklist waits for the owner's page, and the rest refused before the smoke;
- a smoke on the largest scene, whose people all face the viewer, so that it also draws another scene's view and that
  view's front, and V stands on C's picture there;
- the rest of seed 7 refused with five seconds left, before any job is sent;
- a failed front and a failed view, and the cells they take out;
- a resume that draws nothing, and one after a plan changed since `prompts` refused with `draw.json` unchanged;
- judges' reports with valid, invalid and missing blocks: a clean scene's fresh session, a clean judge's failure, sharp
  sessions that go to `gpt-6-sol` and to the owner's page, and an identity session that waits for its pictures' page;
- the report and both galleries;
- the boundary test: the word found inside `sealed/`, and nowhere in the files outside it, those beside `run/`
  included, in the temporary directory or in all it printed, with nothing left unread; and none of the three keys of
  its key file anywhere.

Its made-up answers are drawn from each enum by a hash, so the verdicts it prints mean nothing. The fakes keep the
contracts the harness talks to, and model no card, no model and no judge.

The dry run also leaves `config.json`, a key file of three made-up keys as simple-serving's configuration holds them,
`serving-smoke.jsonl`, a smoke record that passes, and `dev.json`, a service block for simple-serving's dev launcher
with the served name, the context and that client key. With the launcher up, `dry-run --dev` runs the marker check and
the texts in `dev/` beside `run/`, with that key file and that smoke record, through the real gateway in front of its
fake engine: the adapter, the client key read alone, class `internal`, the gateway's times in each `text_attempt`, and
the requests counted apart. The fake engine answers every call with one sentence, so the scenes pass and no sheet
parses: the marker check prints `reached: false`, and `texts` 13 stories whose sheet is `unparsed`, with the five
sharp ones held as `marker_failed`. A marker check that passes there means that a model answered, and `dry-run --dev`
stops before the texts, so that no sharp story is asked for outside `illustrations/action`. Anything else, a refusal
or a failed scene above all, is looked into before any card.

**The text card** follows the rehearsal (the rentals, 1), and is watched and ended as [the rentals](#the-rentals) say.
Until `trial` has run on it, simple-serving's configuration names the rehearsal's card, which is gone: `up` would
reach for that card, and the smoke's privacy check would read no report of this one. The card falls asleep 13 minutes
after our last request (simple-serving's README, "The command"), which would be a stop, so the smoke, the marker check
and the texts follow each other at once, and the destroy follows the texts. The smoke writes into a file of this
card's own, so that no earlier record, the rehearsal's among them, can stand for it.

`texts --marker` prints each attempt, then `marker_check`: `pass`, `reached`, each step's outcome, the files and bytes
searched, what it could not read, and the hits as counts; a directory, a file or a link the search cannot read fails
it as a hit does. `pass: true` lets `texts` ask for the sharp seeds. A hit keeps them out for the rest of the card:
the leak is the harness's, its fix is code, and no code is written on a paid card. `texts` then writes the clean
stories and holds the sharp ones as `marker_failed`, and with 13 scenes at most every gate but the fourth is
inconclusive, so whether the picture card still comes is the owner's question. `reached: false` with no hit is a
synthetic story the model did not take through every step, and a check again is a new story with a new name.

`texts` prints each attempt and each step, then `texts`: the steps by outcome, the stories held back, `requests` (the
calls, the retries, the gateway's checks, the counts before a send and the generations) and `complete`, which exits 0.
An interrupted run resumes where it stopped, and a call with an outcome is never asked again. If the smoke fails, the
texts wait for the fallback card, where `--model gpu:LABEL` takes the model from `.env.gpu` in place of
`--smoke-record`.

**Between the cards**, `prompts` prints the scenes left in each arm, the scenes where V is C's picture, the codes that
took arms out, the fronts and views planned, the most people and bound people in a frame, the manifests' stops, the
letters outside the Latin script, and each arm's longest prompt in words and, with `tokenizers/`, in the encoder's
tokens. `checklists` prints each `session_done`, then the sessions by state and `pictures`: `ready`, `textsDone`,
`promptsCurrent`, and the checklists stored, failed, waiting for the owner and not yet run. A sharp checklist that
both judges left without a valid block gets a page in `sealed/owner/`, named by its story and session; the owner saves
the answers where the page says, and `collect` reads them as strictly as a judge's. A clean checklist whose two
sessions failed is a judge's failure: its scene has no scores, and it does not hold the card back. The picture card is
rented only with `ready: true`, and `portraits` and `draw` refuse without it: the text run complete, the prompts made
from the texts as they are now, so that a text written after `prompts` needs `prompts` again, and no checklist left to
run or waiting for the owner. Each drawing stage also hashes the plan files as it reads them, and refuses them before
anything is asked of the card when that is not the hash `prompts.json` records.

**The picture card** is rented, guarded, watched and ended as the identity run's card was
([operator](identity-experiment.md#operator), [termination](identity-experiment.md#termination)), for three hours.
`draw --smoke` prints each cell, then `smoke`: `pass`, and whether the cells were drawn, on their geometry, with the
right slots, heard on the socket and within the memory. `pass: false` is the termination; a smoke where only T failed
passes with `tOut`, and T leaves the run, also when T's failure is one that stops a run, such as a graph the server
refused, but not when the card could not confirm T's stop, which may leave its job drawing. `portraits` prices the
rest of seed 7 from the smoke's times and prints `admission`: the cells, the minutes they need and the minutes left. A
seed 7 that does not fit stops as `admission` before any job is sent, and the termination follows. `draw` prints each
cell and the admission of seed 11, then `drawn`: the pictures drawn by kind and seed, and the failed and the out by
code. `stopped: admission` after seed 7 is seed 11 that did not fit, and the verdict stands on seed 7;
`stopped: until` is the end that came. Every ending is the termination, and a resume draws nothing again, a cell
whose failure stopped the run included; a picture `draw.json` records whose file is gone is data lost, refused before
anything is drawn and never drawn again. The saved pictures stay on the card until its destroy is read back; the
harness reads no log of the card for a sharp story, and nobody reads the server's output.

**After the card**, no card is needed. `bundles` prints the bundles built and those skipped, by reason. `judge` runs
every session that is ready, four at a time (`--parallel`, and `--kind` for some kinds alone), prints each
`session_done`, and then `judged`: the sessions by kind and state, and the attempts. A session still running after 30
minutes is stopped, killed if it does not stop, and waited for, and its attempt is recorded as `timeout`, an attempt
without answers. A sharp session both judges leave gets a page, as a checklist does, and an identity session waits for
its pictures' answers, so `judge` runs again after `collect`. `report` writes `report.json` and the owner's
`report.md`, and prints the scenes, each gate's verdict on seed 7, over the clean scenes, over the scenes that reached
their target and at seed 11, the repeats, the sharp scenes no judge answered, and whether seed 7 is complete.
`gallery` writes the owner's two pages. No Claude session opens anything under `sealed/`, the pages among them.

The drawing stages also take `--comfy`, `--wait`, `--timeout` and `--tokenizers`, whose defaults the runbook keeps. The
directory holds:

- `texts.json` and `marker.json`, the records of the text run and of the marker check;
- `clean/<id>/` for each clean story, and `sealed/<id>/` for each sharp one and the marker's: its store, `text.json`,
  `plan.json`, `checklist.json`, `portraits/`, `views/`, `pictures/`, `bundles/`, `keys/` and `answers/`;
- `prompts.json`, `checklists.json` with the checklists' projections, and `judging.json`;
- `sessions/`, and `sealed/sessions/` for the sharp scenes: each session's copy of its bundle, its events, its stderr
  and its report; `sealed/tmp/`, their temporary directory; and `sealed/owner/`, the owner's pages;
- `card.txt` and `draw.json`, the card's record and the pictures';
- `report.json`, `report.md`, `gallery.html` and `sealed/gallery.html`.
