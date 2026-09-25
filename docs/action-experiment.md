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
the scenes that reached their target beside the main count.

<a id='text-run'></a>

## The text run

It runs on the text card once simple-serving's first-rental smoke has passed whole, by the smoke's own record: its
contract's section 15, step 1, with the stop, the read-back, the resume with a new boot, the probes and the count
matrix, not a single completion. Never before. Every call is the bot's own, through the `simple-serving` adapter as
class `internal`:

1. for a sharp story, its seed and action;
2. the opening scene and the action scene, by `generateScene`, in the harness's own store;
3. the sheet, by `sheetRequest`, read by `sheetOf` as the bot reads it;
4. the bot's frame, by `frameRequest`;
5. the variant frame.

That is 95 calls before retries, 5 seeds and five calls for each of the 18 stories, and the adapter may count a
request's input before it sends it. Two stories run at once, since the gateway admits two `internal` calls; that is a
provisional limit of its contract, not a measured throughput.

The bot's `askJson` only parses a reply. The harness wraps the provider and records every attempt: its kind, the
tokens in, out and cached (a count the gateway does not give stays unknown, never 0), the gateway's wait, first token
and total, the finish, whether it was the retry, and a code. No text reaches a log or the terminal. Each reply is then
decided by rules fixed now:

- `unparsed`: `askJson`'s second try did not parse either;
- `truncated`: a reply that parsed but finished on `length`;
- `schema`: a reply that parsed and breaks its schema, such as a required field missing, a value outside an enum,
  or more than six people;
- `empty_sheet`: a sheet with no entry;
- `failed`: the call failed, with the adapter's code.

A failure takes out what needs its output: a scene or the sheet, the whole story; the bot's frame, arm A; the
variant, A+, L, C, V and T. A variant frame that gives two people one role takes T out of that scene, because T's
instruction names people by role. Nothing is asked again by choice.

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
3. `role`, new and required: two to six English words, one phrase for one participant, used for nobody else and
   repeated word for word wherever `moment`, `props`, `state` and `action` name that participant. It names their part
   in the moment and their place, with an explicit owner of anything it mentions ("the running father", "the girl in
   the father's left arm", "the rear lifter of the near pod"), and never their appearance or name. Species and scale
   stay in it where they are the scene's premise ("the crouching giant", "the tiny sailor").
4. `facing`, new and required, one of `viewer`, `away`, `screen-left` and `screen-right`: where the front of the
   person's torso points as the camera sees it. A three-quarter view takes the nearer value, and one exactly between
   two takes the one nearer `viewer`. Lying face up under a camera from above is `viewer`, and face down is `away`.
   `facing` speaks of the screen alone: body sides stay the person's own, as the bot's rule says, and where the head
   turns and the eyes look belongs to `action`.
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

- **The binding manifest** is written for each variant frame before anything is drawn. It lists, in the frame's order
  with the sheet's people moved first, each person's sheet entry by `matchSheet`, their portrait and their slot. A
  person the sheet does not name, a creature or a stranger of one scene, is not bound and keeps the frame's own `look`
  in every arm. Two people matched to one entry, an entry without a portrait, or one portrait in two slots stops the
  manifest with a code, and the scene leaves C, V and T. The number bound is checked against the sheet's people in the
  frame before the card. One manifest decides every variant arm: whose looks L drops, and which portraits C, V and T
  send in which slots. It takes the place of `bindingPlan`, which stops at the first person without a portrait and
  could bind fewer.
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
- `facing` becomes "facing the viewer", "with the back to the viewer", "turned toward the left of the picture" or
  "turned toward the right of the picture".
- Names and ages are stripped as the bot strips them, and the style line ends every frame's prompt.

The assembly prints counts only: words, tokens as the encoder counts them, people per frame and people bound, and the
letters outside the Latin script, which would have caught stage 1's «рыжая».

<a id='views'></a>

## Portraits and views

A front portrait is drawn for each person a manifest binds, by the identity run's recipe
([portraits](identity-experiment.md#portrait-recipe)): the whole figure from the front, in the bot's plain clothes,
before a grey backdrop, on the text-to-image graph at 720x1280, seed 7.

A view is drawn only where a frame needs one. For each bound person whose `facing` is not `viewer`, one view is drawn
as an edit of their full-size front, with this prompt and the portraits' style line:

> Image 1 shows one person. Draw the same person, with the same face, hair, build, marks and clothes, on the same
> plain grey backdrop, the whole body in frame, arms relaxed, now {with the back to the viewer | turned toward the
> left of the picture, seen from the side | turned toward the right of the picture, seen from the side}.

At `resolution` 0 the encode node reads the 720-wide front at 704x1280, so a view is drawn on a canvas of 704x1280,
the size its reference reaches the encoder at: the pinned graph's own note says any other size shifts an edit. A view
is never a mirrored portrait, since a mirror moves a scar or a parting to the other side. Every portrait and view is
drawn once, and none is drawn again or chosen among.

**References reach the encoder at 352x640** in C, V and T, half the identity run's size. Each portrait and view goes
through a scale node of its own to 352x640 on its way to its slot, and the encode node stays at `resolution` 0, so
T's first image, L's picture, keeps the canvas size. One `resolution` for the whole node could not do both. The edit
graph gets a seventh slot for T. Every picture loses its metadata on the way to the card and back, as
`local/image-batch.ts` already does. The identity run's 704x1280 took 82 s a frame with four portraits, longer than a
reader would wait, and a frame here binds up to six. The results hold for this size and this recipe: no arm compares
sizes, and none is compared with the identity run.

## Drawing

- Every frame is 1280x704, on one edit graph with seven reference slots: six portraits, and L's picture in T. The
  slots a frame does not use leave the graph. A, A+ and L use none, and the identity run's control showed that this
  draws the same file as the bot's text-to-image graph.
- Seed 7 decides, and seed 11 repeats it only if [the time](#time) admits it after seed 7. The order on the card is
  [the smoke](#picture-smoke), the rest of the front portraits, the rest of the views, seed 7 in all arms scene by
  scene, then seed 11 the same way. L is drawn before T of the same scene and seed.
- Where every bound person of a variant frame faces the viewer, V's inputs equal C's. V is then not drawn, and C's
  picture counts for V.
- A failed front takes its scene out of C, V and T, and a failed view out of V. A failed frame is that cell alone,
  and a T whose L is missing is never submitted. A cell left undrawn by the deadline or the admission is
  `not_submitted`, nobody's failure. Nothing is drawn again, and every file is kept.
- Each frame records what the identity run's frames record ([telemetry](identity-experiment.md#telemetry)). The run is
  pinned as that one was ([pins](identity-experiment.md#pins)), with the variant's hash, the views' and T's templates,
  the reference size and the manifests added, and the text run's model and gateway versions beside them.

<a id='picture-smoke'></a>

**The smoke** is the scene with the most bound people, at seed 7: its portraits, its views and its six arms. Its
cells are the main run's cells of that scene and seed, drawn once. It passes when all of these hold:

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

**The time.** The harness takes an absolute end, `--until`, as the identity run did
([one hour](identity-experiment.md#one-hour)): five minutes before the earlier of the guard's deadline and the
operator's own. Nothing is sent after it. After the smoke, the harness prices the rest of seed 7, the portraits and
views included, from the smoke's slowest times for each kind of cell: text to image, an edit by its number of
references, and T. Each cell gets that time plus a quarter and three seconds. Seed 7 begins only if all of it can end
by `--until`; if it cannot, the rental ends as a smoke result and is never extended. After seed 7, seed 11 is priced
the same way and begins only if it fits whole. If it does not, the verdict stands on seed 7 alone, as it would anyway.

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
   - the participants, each with an id, a short handle and the sheet entry that is them, if any;
   - the relations of the moment the scene ends in, each with an id, one subject, one verb and one object, and the
     body part and its side only where the scene gives them. A side the scene does not give is never made up, a
     contact both ways is one relation, and each relation is marked essential or not. The essential ones are the
     contacts the main action is made of, at least one per scene. Each carries a short quote from the scene;
   - the gazes and faces the scene names, the clothes it names for the moment, and the scale where it is a premise;
   - whether the scene reached its target (see [the set](#the-set)), and where the sheet's line for a person
     contradicts the scene.

   Code takes the checklist out and stores it, and no later session changes it.
2. **The text and the portraits**, after the card: the checklist, the sheet, the prompts of A and A+, the front
   portraits, and each view beside its front with the direction it was asked for. It says which relations, gazes and
   clothes each of the two prompts states; whether each bound person's `facing` fits the moment and the shot; whether
   each front matches its sheet line in face and hair, build and marks; and whether each view is the same person,
   turned the way it was asked.
3. **The pictures**, one session per scene and seed: the action scene, the sheet, the checklist, and that seed's
   pictures, six at most, in an order drawn by code and named by hashes. C's picture, when it stands for V, is shown
   once. For each picture the session first says who is who: each participant present or not, and where, told by
   their looks and place before any action is scored. Then:
   - each relation, gaze, face, clothes item and scale item: `yes`, `no` or `unsure`. A contact hidden by a body is
     `unsure` unless the picture shows it; a contact the frame's edge cuts off is `no`;
   - a mix-up of each kind: an action done by the wrong person, two people's looks swapped, two people merged into
     one;
   - an anatomy error: a limb too many or missing, bodies merged, a joint bent the way it cannot;
   - for each sheet person present, whether they look as their line says.
4. **The identity**, once session 3's answers are stored: the same pictures and the front portraits of the bound
   people, the same references for every arm. For each picture and each bound person: present or not, and whether the
   face and the build each match the front.

A session sees its pictures together, and it may compare them; nothing here prevents that. Four clean scenes, picked
by code from the set's hash before the run, get a second session 3 at seed 7, to show how far two judges differ. It
is reported and never replaces the first.

Each report ends with its answers as one JSON block. Code takes the block out and checks it against a strict schema:
the ids it was given, values from the enums, and nothing else. A block with anything more or anything missing is
invalid, and the report's prose stays with the report. With both seeds that is 18 checklists, 18 sessions of text and
portraits, 36 of pictures, 36 of identity and 4 repeats: 112 sessions after the card has gone.

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
  front, counted over all of them the same way.

An arm's score is the mean over scenes, so a scene with many relations weighs no more than one with few. The report
gives the numerators, the difference between the arms of each pair scene by scene, in how many scenes each arm is
ahead, level and behind, and a 90% interval for each difference from 10 000 resamples of the scenes with a fixed
seed. The gates compare exact values; the report rounds to whole points. It also gives the text audit's share of the
checklists' relations stated in A's and A+'s prompts, and the share of fronts that match their line and of views
judged right.

The gates are fixed before the paid run and counted by code on seed 7, as thresholds for the next decision and not
as proof. At 18 pictures one picture is 5.6 points, and the two seeds share one text and one set of portraits, so they
are not more scenes. A `no` and an `unsure` both count against a picture. "At most n/10 more" means at most a tenth of
the gate's n matched pictures, rounded down, and never less than one. Each gate reads the seed-7 scenes where every
arm it compares is scored, and it is **inconclusive** when fewer than 14 of the 18, or fewer than 10 of the 13 clean
ones, are left; gate 4 needs 6 scenes where V was drawn. An arm that passes must also show at least half of the
essential contacts, whatever its gain.

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
4. **Views.** Over the scenes where V was drawn, V passes against C when its contacts are at least 5 points higher,
   or its identity at least 10 points higher with contacts no lower; with no more mix-ups, no fewer complete
   pictures, at most n/10 more anatomy errors, and at least 80% of the views judged the same person turned the way
   asked.
5. **Two passes.** T passes when its contacts are at most 5 points below L's, its pictures show at least 80% of the
   essential relations L's pictures showed, counted together over the scenes, its identity is at least 15 points
   above L's and at most 5 below C's, with no more mix-ups than L and at most n/10 more anatomy errors.

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
  error prints its code and the fields that pass `safeErrorDetails`, never a message or a body. The card's copy of
  each picture job is deleted after the picture, as `local/image-batch.ts` does.
- What leaves `sealed/` is the validated answers, ids and enum values, and the counts made from them.
- Before the text run the owner adds that path to the denies of `.claude/settings.json`, which only the owner edits.
  A deny covers the file tools and not a subprocess, so no Claude session runs a command that reads there: the harness
  is the only reader.

**The boundary test**, before any card: the dry run puts a made-up word into a sharp seed, into the fake model's
replies, into the body of a fake provider error, into the metadata of the fake ComfyUI's pictures, into a fake judge's
prose and into a malformed answers block. Code then searches every file the run wrote outside `sealed/`, the
temporary directory, and the harness's own stdout and stderr, for that word. One hit fails the test. On the text card,
before the five sharp seeds are asked for, one synthetic story marked sealed, with a made-up name in its seed, goes
through the sealed path, and the same search runs; a hit stops the sharp stories.

## The rentals

Each card needs the owner's explicit «да», with its price and its end, under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). Everything is dry-run before the first of them: the text
flow against scripted fakes of the adapter and against simple-serving's dev launcher, the pictures against
[fake-comfy.ts](../local/fake-comfy.ts), the judging on made-up answers, and the boundary test.

1. **The text card** is simple-serving's first rental, a 5090 rented as its README says for that rental, with a trial
   guard of two hours and its own rules. The operator watches it from its creation. The gateway's smoke comes first,
   then the marker check, then the text run, and then the card is deleted with `--destroy` and read back as gone. The
   gateway's stop is not an end: a stopped trial keeps its disk, and its guard does not run.
2. **The checklists** are written between the two cards, from the texts alone.
3. **The picture card** is a 5090 from `npm run gpu:rent -- --lane pictures --qwen only --hours 3`. It is rented only
   when every prompt is assembled and counted and every checklist is stored, and it ends as the identity run's card
   ended ([termination](identity-experiment.md#termination)).

Before the rent dry-runs the estimate is an hour and a half of the text card and up to three hours of the picture
card, about $3 with the downloads. Each dry-run's `session` replaces it before the «да» for that card.

## Not verified without a card

- that vLLM loads route A on the 5090 and that simple-serving passes its smoke;
- whether route A's heretic keeps the variant's schema, and keeps `facing` better than stage 1's hosted Gemma kept
  `view`;
- how long an edit takes with six references of 352x640, and with T's seven;
- whether the views keep the person and turn the way they are asked;
- whether references of 352x640 keep a face.
