# How pictures came into the bot

A record of the plan for illustrated scenes, text to image, from its first version on 2026-09-20 to the owner's
decisions of 2026-09-26. Each section is true of its date, and a proposal in it is not a task for today. The tester
asked how text to image fits in at all. The six steps kept running into a second question, whether a person stays
recognisable from one frame to the next, and no confirmed paid run has answered it yet. What the bot does now is
described elsewhere: what the reader gets in [telegram-ui.md](telegram-ui.md#picture-delivery), the picture card in
[gpu.md](gpu.md#picture-card), its licences in [gpu.md](gpu.md#image-licences), and the working protocol of the
identity measurement in [identity-experiment.md](identity-experiment.md#identity-runbook). The header below is the
first version's.

2026-09-20 · Opus 5, corrected and measured 2026-09-21 · Fable 5.1 · three images were generated on a hosted API,
no GPU was rented, no code was changed. Markers as in [eval-experiments-plan.md](eval-experiments-plan.md): **[M]**
measured here, **[D]** derived from measured values, **[A]** an assumption that a measurement must close.

<a id='research-question'></a>

The tester asked for it and offered to fund the Vast budget. What he wants first is modest and worth keeping in
mind: to see **how text to image fits in at all**, not to ship a finished visual novel.

## What is proposed

After the scene exists, a description of it goes to an image model, and the picture travels with the scene.

The description comes from a **second call after the scene**, with structured output, as the tester first sketched.
The first version of this note recommended a field in "the structured output the scene already uses" instead. There
is no such thing: a scene is plain text streamed to the reader as it is written (`local/generation.ts:219`,
`onText`) [M], and only memory, the judge and the probes pass an `outputSchema`. A schema around the scene would end
the streaming. The tester's shape was the right one.

The picture covers the place, the atmosphere and **what people are doing**, by role and action. Not by name.

<a id='description-cost'></a>

## What the second call costs

The first version of this note claimed it costs thousands of tokens of prefill. That was wrong, and the owner caught
it. `cache_prompt: true` is set for llama.cpp (`local/llama.ts:127`) [M]. A call built as a continuation — same
system prompt, same seed, same memory, same scenes, the instruction appended last — shares its prefix with the scene
that just ran. It does not share all of it: the scene was asked for with the narrator's rule attached to the
author's message, and the history stores the message without it (`local/prompt.ts`, `makeRequest` against
`contextParts`), so the prefix parts at the last author message and that message, the scene and the instruction are
prefilled, about a thousand tokens [D]. The next scene parts from the cache at the same place and would have paid
for the message and the scene anyway; whichever call comes first pays, the other reuses it, **if both land in the
same slot** [D]. The thousands appear only if the call carries its own system prompt: then nothing is reused [D].

What remains against it is not tokens:

- It **takes a slot a second time**, 6–23 s on a hosted endpoint for 270–410 output tokens [M, below]. The pool
  holds two or three, and the scheduler counts them (`local/scheduler.ts`).
- The reader has the scene already, so the wait is for the picture only, and it is the image model's wait as well.

<a id='text-identity'></a>

## What survives without reference images, and what does not

The tester says references are unnecessary. For what he is asking for, that is right, and an earlier objection in
this project — that a diffusion model cannot hold a character between scenes — missed his proposal.

- **Place, atmosphere, pose and action hold.** "A figure in a red cloak bent over a broken cart" renders plausibly
  every time [A].
- **Identity does not.** It is a different person each time. For a first version that is acceptable if people are
  described by role and action; it stops being acceptable as soon as a named character is meant to be recognised [A].
- **A recurring place drifts too.** The same tavern looks different on each visit. A seed keyed to the location the
  memory already stores costs nothing and should hold it steadier than free sampling [A].

Describing people by role rather than identity also keeps the feature clear of generated likenesses, which carry
exposure that text does not.

## The first step needs no card

What the tester wants to check — whether a scene yields a good description through structured output — is a
question about **text**. It can be answered on the synthetic stories for a few cents through OpenRouter, without
generating a single image and without renting anything. Only once the descriptions are worth looking at does an
image model become the next expense.

His second suggestion supports this: run the image model plainly, no workflow, no LoRA, no upscaler. That isolates
one variable. A weak picture then means a weak description, not a mis-tuned pipeline.

<a id='description-steps'></a>

## Six steps on 2026-09-21

On 2026-09-21 six steps tried the description on the synthetic stories and then drew from it on a hosted API, each
step starting from what the one before had found. [Step 1](#step-1) asks for the description through structured
output, [step 2](#step-2) draws the first pictures, [step 3](#step-3) assembles the prompt in code from fixed fields,
[step 4](#step-4) tries prompts written by hand, [step 5](#step-5) a larger hosted model, and [step 6](#step-6)
frames chosen for what the image model can draw. The pipeline the bot uses now is in
[telegram-ui.md](telegram-ui.md#picture-pipeline).

<a id='step-1'></a>

## Step 1, measured 2026-09-21

`google/gemma-4-31b-it` through OpenRouter, `plain` histories from `examples/frozen/`, scenes 3, 8, 13 and 16 of
`battle`, `chess` and `dance`. Each request was the scene's own system prompt and history with one instruction
appended and a schema of `moment`, `setting`, `light`, `people[] {look, action}` and, last, `prompt` (English, 40–80
words). 15 calls, 104 632 input and 4 431 output tokens in the 13 that parsed. The script was a throwaway and is not
in the repository. One run per scene, one model, read by one reader: a first look, not a score.

- **13 of 15 parsed** [M]. Both failures were the same scene, and the same fault: valid fields, then newlines until
  the 700-token limit (`finishReason: length`). The same scene parsed on the next two attempts. JSON mode's known
  runaway; it needs one retry and a low output limit, and it must be looked for again under llama.cpp's grammar [A].
- **The rules held in all 13** [M]: English, no names, 59–71 words, two to four people, each with a look and an
  action.
- **What persists in the story persists in the descriptions** [M]. The commander's splinted left wrist, put on in
  scene 3, is in all four battle descriptions; the blue-handled dagger in three of the four; a bracelet she receives
  later is in every description after it. The diagonal beam of sunlight is in all six chess descriptions, the
  coach's grid notebook in three of four dance ones. Nothing asked for this. It is the history doing the work, and
  it is the part of "consistency without references" that text can carry.
- **The model picks a style, and picks a different one each time** [M]: `8k`, `photorealistic`, `anime`, `digital
  art`, `professional photography`, `visual novel style`, in 11 of 13 prompts and never the same set twice. For a
  visual novel this is the defect that matters. The style belongs to us: forbid it in the instruction and append one
  fixed style string to every prompt.
- **An age got through as a number** [M]: "48-year-old" in three of four dance prompts, against the rule that only
  the visible goes in.
- **Chess is a poor subject** [M]: the descriptions are two men at a board by a window, four times, and one names a
  position on the board that no image model will draw. A scene can be not worth a picture; the schema should let
  the model say so (`worth_drawing: boolean`) rather than always produce one [A].

What this does not show: whether these prompts make good pictures, anything about the uncensored build the bot runs,
or anything about adult scenes, which are never sent to a hosted API.

<a id='step-2'></a>

## Step 2, first pictures, 2026-09-21

The instruction was revised on what step 1 showed: no style, technique or quality words; age in words, not numbers;
nothing unreadable to the eye such as board positions; a `worth_drawing` boolean; one retry on a reply that does not
parse. Same model, same twelve scenes.

- **12 of 12 parsed**, one after its retry [M]. No style word and no number in any prompt, 60–74 words [M].
- **`worth_drawing` was true twelve times** [M], the four near-identical chess scenes included. As asked, the field
  separates nothing. It needs the earlier descriptions to compare with, or a rule in code, not the model's opinion.
- **The text drifts on what it was not told to hold** [M]: the commander is "a young woman" in one description and
  "a middle-aged woman commander" in another. Objects the story fixes stay fixed; an age nobody stated does not.

Three of the prompts were drawn by `krea/krea-2-medium-turbo` through OpenRouter's Image API (`POST /api/v1/images`),
16:9, seed 7, with one style sentence appended to every prompt by us. $0.015 and 18.5 s each [M]; $0.045 in all.
The pictures are not in the repository.

A first reading here called the pictures faithful, "every element named in a prompt is in its picture but one
bystander". That was too kind. The owner had the pictures read again by GPT-6 (Codex, a fresh session, read-only,
given the scenes, the descriptions and the prompts but not the first reading), and its element-by-element check is
the one to keep [M, second reader]:

- **The description loses more than the image model does.** In the gate scene the shield-bearer strikes a machine's
  fingers with the edge of his shield; the description turned that into bracing a cart. In the door scene the
  commander is forbidden to load her injured arm and holds the door with her right shoulder; the description
  dropped the prohibition and the picture has her pushing with both palms. In the dance scene the man chairing the
  commission rewinds the recording; the description gave the gesture to a woman, and asked for "a video of
  dancers" where the scene is about one frozen count.
- **Only `prompt` reaches the image model, and it does not carry the other fields.** `light` said cold and
  overcast, the prompt did not, the picture is warm and sunny, and the picture is right by what it was sent. In the
  door scene `people[]` holds one person and the prompt names five. The structure cannot be checked against itself
  before it is sent, and should be assembled in code from the fields rather than written a second time by the model.
- **The description invents.** A bracelet the story only mentions became a glowing one.
- **The image model's own faults** [M]: the dagger lies along the machine's leg rather than in a joint and the grip
  cannot be traced; four distinct people where five were asked for; tangled lower bodies in the crowded frame; two
  near-identical women; pseudo-text on a screen and on papers despite "no text".
- **The style held** across all three [M, both readers]. This is the fix for the defect of step 1.
- **The characters did not** [M]: the shield-bearer wears plate in one picture and a shirt and waistcoat thirteen
  story-minutes later, because one prompt said "in armor" and the other did not; the commander's clothes are fixed
  nowhere. One seed is no evidence of identity. A fixed appearance line per recurring character, kept with the
  memory and repeated verbatim, is the next thing to try, before any reference image.
- Left and right of a body must be written as the character's own, and screen sides separately.

OpenRouter lists Krea 2 as `large` ($0.06 an image), `medium` ($0.03) and `medium-turbo` ($0.015) [M, its pages];
the general `/api/v1/models` list omits image models, which are under `/api/v1/images/models`. Each takes a `seed`
and one reference image. The open weights are `krea/Krea-2-Turbo` and `krea/Krea-2-Raw`: a 26.3 GB transformer in
bf16, an 8.9 GB text encoder and a 0.5 GB VAE [M, HuggingFace file sizes], 35.7 GB together, so a 32 GB card needs
fp8 or the encoder offloaded. Which hosted name the open weights correspond to is not known. Their licence is
`krea-2-community-license`, read below.

**On price the owner was right and the first estimate here was wrong.** A second card at $0.52/h pays for itself
against `medium` from 17 pictures an hour and against `medium-turbo` from 35 [D]; one active reader with a picture
per scene is already there. Hosted is for looking, not for running.

<a id='step-3'></a>

## Step 3, the prompt assembled in code, 2026-09-21

The same three scenes again, with the second reader's points applied. The description lost its `prompt` field:
the model now fills `moment`, `shot`, `setting`, `objects`, `light` and `people[]` with `who`, `state` and
`action`, and code joins them in a fixed order with one style sentence. One more call per story writes a sheet of
recurring characters, a fixed appearance line each, and the assembly puts that line in wherever `who` matches.
Ages written as numbers are stripped. The instruction gained "do not hand an action to another person" and "keep
who is where". Three `medium-turbo` pictures, $0.015 and about 9.5 s each; a fresh clean-context GPT-6 session
checked them element by element against the prompt and the scene, without knowing the first verdict.

**Verdict of the reader: with reservations, no, with reservations.** Not one picture shows its scene's main action.

- **The description stage is now mostly right; the image model is what fails** [M]. Of the contradictions the
  reader found, most are marked as the picture's fault against a correct prompt: the dagger hangs over the cart
  with a visible gap to the wrist joint it was to be driven into; two shields where one was asked for; the bandage
  moves from the commander's left arm to her right between two pictures though both prompts name the side; a man
  who should sit with his heels on the threshold kneels barefoot; a middle-aged official is drawn young.
- **The assembly dropped the one field that mattered** [M]. `moment` was not sent. In the door scene it alone said
  the door is held shut, and the picture has a wide open doorway; `light` asking for daylight "through the
  archway" invited it. The order should be shot, setting, moment, people, objects, light, style, with the shared
  action said once in `moment` and only pose, place and gaze left to each person.
- **The model loses relations, not details** [M]: which hand, where the blade goes, what props the door, who is on
  the monitor. Late items of a 283-word prompt still arrived (the fifth person, the monitor, the papers, the
  style), so length as such is not shown to be the limit; three pictures cannot show where the limit is. Cut
  repetition and spend the words on one contact and the staging.
- **"No lettering" fought the scene**: the frozen count "10" on the monitor is the evidence the scene turns on.
  The style sentence should forbid captions, logos and watermarks and allow numerals the scene asks for.
- **The sheet gives approximate recognition, not identity** [M]. Hair colour and cut, build and the colour of the
  clothes carried over; faces, the cut of the clothes, fittings and armour did not. "Enough to recognise, not
  enough to believe one artist drew from one sheet." The sheet is worth keeping and is not sufficient; a reference
  image is the next thing to try for identity, and the hosted API takes one.
- **The style drifts in faces** [M]: painterly and realistic in the fight, larger eyes and flatter faces in the
  dance, a visible step toward anime. "Consistent facial stylization" names no rule; the replacement names
  proportions, eye size and age lines.
- The description still specifies what the scene does not: a "stone city gate" the excerpt never sets, glowing
  eyes on the guard. The sheet fixes clothes as constant, and clothes change with the scene.

What this says about the feature: a picture that is close but shows the wrong action is worse for a reader than
no picture, and at this point two of three are close and one is wrong. The next round is cheap — reorder the
assembly, send `moment`, the new style sentence, the reader's per-scene wording as a test of what the image model
can follow at all — and its question is whether Krea can draw a stated contact between two things. If it cannot
with a prompt written by hand, no instruction to the describing model will fix it.

<a id='step-4'></a>

## Step 4, prompts written by hand, 2026-09-21

The question of step 3, asked directly: the second reader's own wording for the three scenes, put over the step 3
descriptions by hand, assembled as shot, setting, moment, people, objects, light, style, with the new style
sentence. 249, 369 and 332 words. Three more `medium-turbo` pictures at $0.015 and about 10 s each. A third
clean-context GPT-6 session checked them, listed every relation the prompts state and marked each followed or
not, and compared each picture with its step 3 counterpart without being told which was which.

**Verdict: with reservations, with reservations, no.** Still no picture shows its scene's main action.

- **31 of 70 stated relations were followed** [M, the reader's count]. Followed: that a thing is present, who is
  next to whom, the large left and right of the frame, a door that is closed, a requested numeral ("10" appeared
  once lettering was allowed). Not followed: exact contacts (blade in the joint, shield rim on the fingers, back
  against the door, heels on the threshold, lockpick in the keyhole), whose limb is whose, which person performs
  which action (the mouse went to another official), where the viewer stands relative to a screen, and what the
  screen shows. The guard has three arms. The dancers strike the pose at the door instead of watching it on the
  monitor.
- **Blind comparison with step 3**: the new picture is closer in both fight scenes (one shield, visible splints,
  pouring salt, the closed door) and the older one is closer in the dance scene. Sending `moment` and naming the
  door's state fixed what they were meant to fix.
- **Identity and style as before**: the shield-bearer reads as the same man in different armour, the commander is
  held by hair, grey clothes and the injured arm, faces drift toward cartoon in the dance scene. The injury again
  changed arms.

What follows [D]: this image model, at this size and step count, draws who, where and with what, and does not draw
what is being done to what. A better description cannot buy the second. Two ways forward, not exclusive. Choose
the frame for what can be drawn: the describing call picks a moment that needs no precise contact — the people
and the place just before or after the action — and code refuses frames that depend on one. And find out whether
this is the model or its distilled 8-step variant: the same three prompts through `krea-2-large` cost $0.18, and
on a rented card `Krea-2-Raw` can be set against `Krea-2-Turbo`.

On 2026-09-28 the tester asked the question again for Qwen-Image 2.1 on the bot's card: does a prompt a model writes
whole beat the one code assembles? [The prompt arms probe](action-experiment.md#prompt-arms) is prepared for the next
card.

<a id='step-5'></a>

## Step 5, the larger hosted model, 2026-09-21

The three hand-written prompts of step 4 and the same seed through `krea-2-large`: $0.06 and 27–31 s a picture
[M], against $0.015 and about 10 s for `medium-turbo`. A fourth clean-context GPT-6 session got both sets as
models A and B, unnamed, and marked every stated relation for each.

- **No difference that matters**: `large` followed 49 of 76 relations, `medium-turbo` 46 of 76 [M, the reader's
  count; its list of relations is its own, so the 31 of 70 of step 4 is not the same scale]. By scene 15 to 17,
  16 to 17 and 18 to 12. Neither shows the main action of any scene. Reader's verdicts: three "with reservations"
  for `large`; "no", "with reservations", "no" for `medium-turbo`.
- Each gets right what the other gets wrong. `large`: the lockpick in the keyhole, the mouse under the right hand,
  a screen the dancers can see. `medium-turbo`: one shield, the commander's back against the door. Both duplicate
  shields; the three-armed guard is `medium-turbo`'s.
- `medium-turbo` held style and faces slightly better across its three pictures.

So four times the price and three times the wait buy nothing here, and the failure is the family's, not the
distillation's. The way forward is the first of step 4's two: frames chosen for what this model can draw.

<a id='step-6'></a>

## Step 6, frames chosen for what can be drawn, 2026-09-21

The describing call is told what the image model can and cannot draw and chooses accordingly: the people and the
place just before or after the action, at most four people, whole-body postures, the shared action once in
`moment`, no door or archway as a source of light, nothing relied on a screen to show. Same sheets, same seed,
`medium-turbo`, $0.045. A fifth clean-context GPT-6 session was asked a different question — does the picture
contradict the scene, omission counted apart — and whether a reader who has just read the scene accepts it.

**Verdict: no, with reservations, yes.** The first "yes" of the day.

- **106 stated elements followed, 15 not, 10 not checkable** [M, the reader's count, style included]: 33/6/1,
  40/7/4 and 33/2/5. No extra limbs, no duplicated shields, the door closed, the injury on the right side.
- The "no" is one object: the shield-bearer holds the dagger that the scene has just passed to the commander.
  The description assigned it correctly; the image model moved it. One small object in the wrong hands undoes a
  picture that is otherwise right, because the hand-over is what the scene is about.
- The "with reservations": the scout at the lock looks idle, the healer is barefoot again, and four people shown
  as if they were the whole group of five. The "yes": the monitor seen from behind, the officials inside, the
  couple at the threshold. Turning the screen away from the viewer is the device to keep.
- **One style, and both recurring characters recognised**, the commander "confidently" — the best reading of
  identity so far, with the same sheet as before. Fewer people and calmer poses help identity too.
- A session that by my mistake got the pictures without the texts said what a stranger sees: the pictures are
  clean and less eventful, and the dance one does not tell its episode. Under a scene already read that is
  acceptable; alone it would not be.
- A fault of mine in the assembly: `moment` carried the characters' names to the image model. Names must be
  forbidden in every field, and `look` dropped for people the sheet covers, since the unused text contradicts it.

The reader's wording for the next instruction, in short: one moment, and the state of every prop at that moment
— who holds the weapon, drawn or sheathed, which door is open; each important object one owner and one state,
repeated in one closing sentence; a person who keeps working is described at the work, hands at its height; a
tight shot rather than part of a group shown as all of it; a final self-check of injury side, weapon owner, door
state and counts.

Where this leaves the feature [D]: with the frame chosen this way the pictures stop contradicting the scene in
most of what they show, and one object in the wrong hand is the kind of fault that remains. That is a rate, and
three pictures cannot give it. The next measurement is wider, not deeper: twenty to thirty scenes across all the
synthetic stories, one verdict each, to learn how often a reader would reject the picture. About $0.45 on the
hosted model, or the same on the rented card where the seconds are measured too.

<a id='reader-experience-history'></a>

## What the reader sees (2026-09-21)

Settled with the owner 2026-09-21. The tester funds the second card by topping up the vast.ai account, so the card
is rented and run by us and story text stays on our side. The picture comes after the text; what the reader needs
is to know how long. So: a status line under the scene while the picture is made, replaced by the picture; the
seconds from the end of the scene to the picture logged as a non-negative integer, and measured in the rental's
last block together with the wait of the next turn. Hosted `medium-turbo` took 9.5–10.3 s a picture over six
pictures [M]; the description call on our card and `Krea-2-Turbo` fp8 on a second card are not measured.
What happens to a picture still in flight when the reader answers was the owner's to decide, and cancelling it was
the proposal. The build of 2026-09-22 stops it at the reader's next message and at `/cancel`
([what shipped](#shipped-2026-09-22)). How the bot delivers a picture now is in
[telegram-ui.md](telegram-ui.md#picture-delivery).

## The licence, read 2026-09-21

The Krea 2 Community License Agreement and the Acceptable Use Policy it incorporates were read in full on 2026-09-21,
and the owner decided that day how the bot meets the licence's clause on content filters. The reading and the
decision are kept word for word in [gpu.md](gpu.md#image-licences), where they are the rule for the picture card.

<a id='model-choice'></a>

## The model, if it gets that far

Krea 2, open weights, released 2026-06-22: a 12.9B diffusion transformer, shipped as `Raw` (undistilled, for
fine-tuning) and `Turbo` (8 steps, about two seconds for a 2K image on consumer hardware) [A — the vendor's
figures, not measured here]. The tester pointed at `Kreamania`, a community fine-tune distributed through CivitAI
and HuggingFace. Any such checkpoint must be pinned the way the language model is pinned in
[gpu/manifest.env](../gpu/manifest.env) — repository, revision, SHA256, size. A community checkpoint on a community
host is exactly the kind of file that changes underneath a project.

<a id='qwen-choice'></a>

## Qwen-Image 2.1, a third checkpoint, prepared 2026-09-21

Krea and its fine-tune answer "how good is this picture". Qwen-Image 2.1 is on the box to answer a second question
the six steps above kept running into: **does the same person come back the same in the next frame.** Step 6 got
the best identity reading so far out of a fixed appearance line alone — "the commander, confidently" — and that is
a sheet of words, redescribed from nothing every time. Qwen Image 2.1 takes reference pictures through its edit
path and is built to keep the people in them — its card claims ten, the node carries sixteen slots, and
[image-workflow-qwen-edit.json](../gpu/image-workflow-qwen-edit.json) wires six, the largest cast a story's
character sheet can hold, so that the graph is never the thing that runs out: a frame needing a seventh slot would
end the whole timeboxed run in `workflow_too_few_reference_slots`, and a graph widened afterwards has another hash
than the run directory was opened with. A different mechanism for the same goal, and the only one on the list that
can be tried in the same rented hour.

It is opt-in and off by default, because a rental is priced by the default download and a comparison nobody asked for
should not be in that price. The flag, the 17.28 GB it adds and the `only` mode of the identity measurement are in
[gpu.md](gpu.md#qwen-image). The owner accepted its licence, the Qwen Research License, for the test on 2026-09-22;
the decision and what it rules out are in [gpu.md](gpu.md#image-licences).

**The "Uncensored GGUF" reuploads are not used, and not because of the name.** Checked 2026-09-21 on
`KasugaiSakura/Qwen-Image-2.1-Uncensored-GGUF`: its own card says `base_model_relation: quantized` and "GGUF
quantizations of Qwen/Qwen-Image-2.1 using the original upstream base weights". Its text encoder and its VAE are
the files we pin, by SHA256; its transformer is not that file at all, but five GGUF quantizations, Q4_0 to Q8_0, of
the same base weights. So it is the same model at Q4 to Q8, with a word added to the title; there is no second,
freer set of weights to choose. Using it would also need the ComfyUI-GGUF custom node, and
[image-serve.sh](../gpu/image-serve.sh) starts the server with `--disable-all-custom-nodes` so that a stray clone
cannot change a measurement. Two reasons, either one enough.

**int8, not bf16.** ComfyUI's two official templates ship with the int8 transformer and the int8 encoder as their
own widget values, the three files in bf16 are 32.4 GB of weights on a 32 GB card before a single activation, and
the download is 17.28 GB against 32.4. The full reasoning, including why the w4a8 encoder and the two prompt-enhancer
encoders are refused, is written beside the pins in [image-manifest.env](../gpu/image-manifest.env). The graphs keep
the templates' 25 steps, cfg 1, euler and simple; the upstream card's 40 steps are `--steps 40` away, and the
text-to-image frame is 1280x720 like Krea's, because a blind bundle holding one square picture and one wide one has
already told the rater which model drew which.

**The identity measurement.** Its protocol was written in this section and moved on 2026-09-25, word for word, to
[identity-experiment.md](identity-experiment.md): the geometry of the frames, the synthetic set and its three arms,
the portraits, the gates and the commands of the paid hour. The harness and its dry run against a fake ComfyUI were
merged that day (d4ca6a0). No paid run has been confirmed, so the question this section asks is still open.

## Two constraints that do not bend

**It does not share our card.** The language model holds 22–25 GB of the 32 GB, and [the pool floor](knowledge/gpu-measurements.md#pool-floor) already fails
[threshold 7](llama-measurement.md#thresholds). Krea 2 needs roughly 26 GB at bf16 or 13 at fp8 [A]. A second card, not a second process.

That was the rule on 2026-09-21. How a session runs the two lanes now, on two cards, on one card in turn or on two
machines, is in [gpu.md](gpu.md#renting).

**Story text may not go to the tester's machine.** The rule, with the two honest shapes it leaves, is kept word for
word in [gpu.md](gpu.md#story-text-boundary).

<a id='open-questions'></a>

## What must be measured before any of this is believed

1. ~~Do the descriptions read like something worth drawing?~~ Looked at once, above: yes for scenes with action,
   with the style and the runaway to fix. Not yet repeated, and not yet on the deployed build.
2. Does the second call disturb the scenes that follow — the slot, the cache, the wait of the next turn? On a
   rented card, from `scene_request_completed` timings.
3. Does a plain generation, with a per-location seed and one fixed style string, produce a picture that belongs to
   the scene? The cheapest route is the tester's own machine with these synthetic descriptions: no story of a real
   person is involved.

Where they stand on 2026-09-25, when this page became a record:

1. No wider reading is recorded. Step 6 proposed twenty to thirty scenes across all the synthetic stories, one
   verdict each, and no result of such a run is written down here.
2. Open. The bot logs what would answer it, `scene_request_completed` and `pictureSeconds` in each `picture` row
   ([the log](gpu.md#bot-log)), and no measurement of it is recorded. Nor is the wait from the end of a scene to the
   photo, or how often a card fails or times out under a real reader.
3. Answered in part. Step 6 found pictures that stop contradicting their scene in most of what they show, on three
   hosted pictures, and the rate needs the wider run of item 1. The bot draws with one seed per story, not per
   location ([what shipped](#shipped-2026-09-22)). Whether a person stays recognisable is the question of
   [the identity measurement](identity-experiment.md). In its one run, on 2026-09-25, B kept both face and figure in
   23 of 26 transitions, against A's 21; C kept both in 18. B had action errors in 8 of 16 pictures and C in 7;
   neither arm passed ([the result](identity-experiment.md#result-2026-09-25)).

Tests, and the identity harness with its fake ComfyUI, close none of these.

<a id='shipped-2026-09-22'></a>

## What shipped on 2026-09-22

The feature is in the bot, off by default. `local/illustrate.ts` holds the description step the probe and the bot
now share — the two schemas, the two instructions, the name and age stripping, and `assemblePrompt`; `local/picture.ts`
runs one picture, `local/image-batch.ts` draws it on the card, `local/telegram.ts` gained `sendPhoto` (multipart) and
`deleteMessage`, and `local/config.ts` reads the settings.
The flow it shipped with, from the saved scene to the `picture` row, is the one
[telegram-ui.md](telegram-ui.md#picture-delivery) gives now. The six settings are in [setup.md](setup.md#pictures),
with the reasons above `imageConfig` in `local/config.ts`.

Decisions the plan left open, taken here. The ones about the status line, the reply to the scene and what
stops a picture in flight are rules in [telegram-ui.md](telegram-ui.md#picture-delivery). The reasons for the others
stay here. The character sheet is stored once per story beside its memory
and reused by every later frame, which is what kept a person recognisable in step 6. The seed is derived from the
story id, so one story keeps one visual family and a redraw repeats. Sheet and frame run in one turn with the
prefix shared, so the server pays for the appended instruction alone and the reader's own next scene ends that turn.

A workflow node that saves its
picture is loaded as one that previews it: `SaveImage` writes the picture, with the prompt in its text chunks, into
a directory no route of ComfyUI's API can empty. This paragraph first said that left the card with no copy of a
reader's scene. It did not: the preview's own file stayed in the temp directory until the server restarted. Since
2026-09-23 that directory is in RAM and `gpu/image-sweeper.py` deletes the file seconds after the bot has deleted
the job record; what the card still keeps, and for how long, is in
[gpu.md](gpu.md#what-the-card-keeps-of-a-picture).

What is not measured. All of this has met fakes only — a fake ComfyUI on loopback, a fake Bot API, a fake model —
and never a real card or a real chat. In the tests the drawing is instant, so the seconds in the log rows are the
test's clock and say nothing about a reader's wait; the numbers in "What the reader sees" above are still the
hosted measurement of step 2 plus an assumption about the second card. Nothing in "What must be measured before any
of this is believed" is closed by this commit: the wait from the end of a scene to the photo, what the second call
does to the turn that follows it, and how often a card fails or times out under a real reader are all open, and the
first rental with the tunnel up is what closes them.
Their status on 2026-09-25 is [above](#open-questions).

<a id='style-decisions'></a>

## Picture styles and samples (2026-09-24)

A reader chooses the style of their pictures, keeps a library of their own, and asks for a sample on request only; the
screens are in [telegram-ui.md](telegram-ui.md#picture-styles). The style stays what this plan made it in step 1: the
last sentence of the prompt, never seen by the describing model. `local/picture-style.ts` holds the presets:
- `semi`, the line the owner approved on 2026-09-23;
- `novel`, the `STYLE` the six steps were measured with, its faces true to each person's age instead of adult since
  2026-09-26 ([portrait details](#portrait-details));
- `film`, `graphic` and `watercolor`, with the same change of age as `novel`;
- `empty`, which adds nothing, so that the prompt ends with the scene's description (the owner, 2026-09-27).

A style line ends the prompt as written. Until 2026-09-24 the bot followed it with a tail of its own: natural proportions
and no lettering, which the owner took off because they fought a line that wanted a look of its own, and then that
all people are adults. That sentence went too, the same night: the tester sets styles and tests them by this line,
and a sentence of the bot's after it changed every picture it was compared on. The age of the people moved into
their description, where it belongs: the sheet's `look` and a stranger's `look` in the frame give it as young adult,
middle-aged or elderly (local/illustrate.ts). That part of the prompt is the same in every style of a scene, so it
does not stand between two styles being compared. Every own
style is logged as `custom`, never by its words or its id. A sample reuses the frame of the scene's own picture from
memory, so it costs the picture card alone, and draws it with the story's seed: two samples of one scene differ in
the style sentence only. The row is `picture_sample`, with `frameReused` beside the fields of `picture`.

The first real run, on the owner's test bot and a test story of the owner's own, found two faults that
the fakes had hidden. Both are fixed and each has a test that fails without its fix:
- **A sample could not be described after a restart.** The description ran as the scene's picture does, in the turn
  that shares the scene's prefix, which the scheduler runs only in the slot its reader last used (`sharesPrefix`).
  After a restart, or once another reader's scene has taken that slot, there is no such slot, and the scheduler
  refused the turn (`background_unavailable`). A sample is now described as an ordinary request of its reader: in
  their own slot when it is free, otherwise in the slot that is.
- **A second sample of the same style on the same scene failed with 404.** ComfyUI answered the identical graph from
  its cache, whose output named the earlier job's file, which the sweeper had already deleted. `drawOne` now gives
  the preview node a key of its own per job ([gpu.md](gpu.md#what-the-card-keeps-of-a-picture)).

One more change came from the same run. The first job after ComfyUI's restart lost one status poll while the server
loaded the model (`network`), and the picture was given up although the card finished it. `drawOne` now asks a
dropped poll again, up to three times in a row.

Measured on that run: the text card with MTP decoding, one slot, the picture card with Qwen Image 2.1 at 25 steps.

| What | Time |
|---|---|
| A sample whose frame had to be described again | description 4.7 s, drawing 17.4 s |
| A sample of a reader's own style with the frame reused | drawing 17.6 s, no language-model call |
| Right after each sample, on the card | 0 temp files, 0 history records, nothing on its disk |

<a id='picture-lifecycle-decisions'></a>

## Pictures go with their scenes (2026-09-24)

Deleting a seed or a branch used to leave the pictures of its scenes in the chat.
Since then every photo the bot sends is recorded in the reader's library and leaves the chat with its scene; the
rules are in [telegram-ui.md](telegram-ui.md#deletion). The record keeps the newest 1000 at most because the library
is read and written whole on every update (`recordPicture` in `lib/library.ts`). After `remove-seed` or
`remove-branch`, `forgetLostPictures` takes the pictures whose story or scene is gone out of the list, and
`removeAll` in `local/telegram.ts` deletes them with `deleteMessages`, 100 to a call.
A call that fails is tried message by message with `deleteMessage`: a message Telegram refuses (400) costs
only itself, and any other failure — the network, the rate limit, a chat closed to the bot — ends the attempt.
The removal runs beside the next updates, so the deletion screen neither waits for it nor
changes.

A picture must not arrive after its scene is gone. `sendKept` in `local/picture.ts` looks at the library just
before sending, and records the photo in a write that looks for the scene once more; a deletion that landed while
the photo was on its way is found there, and the photo is deleted at once. Either way the picture ends as cancelled,
without a word, and its row keeps the code `scene_gone`. Before this, a scene deleted while its frame was being
described ended as a failure with a notice to the reader; it is now cancelled the same way. The drawing itself is not
stopped, so a deletion can still cost the card one picture that nobody sees.

One `pictures_removed` row per deletion that took pictures carries `picturesRemoved` and `picturesNotRemoved` beside
`actor`; a photo taken back on its way puts the same two counts into its own `picture` or `picture_sample` row. No
message id, story id or text is logged. All of this has met the fake Bot API only: how a real chat answers a batch
that holds a message just past its 48 hours is not measured, and the message-by-message fallback is there for it.

<a id='clothes-decisions'></a>

## Clothes follow the story (2026-09-24)

Step 3 already saw it: the sheet fixed clothes as constant, and clothes change with the story. On 2026-09-24 the
tester's characters stayed in the clothes of the seed on every picture after the story had dressed them otherwise,
because the sheet line replaced whatever the frame said about a person it covered.

The sheet's `look` now holds only what stays: sex, age as a word, build, hair, face, marks. Its new `outfit` is what
the person wore in the last scene of the history it was written from. Every frame writes `clothes` for each person,
and the prompt puts them after the sheet's `look` (`assemblePrompt`); a person the frame left without clothes wears
the sheet's line. A frame starts from what its people wore before: the instruction lists, for each person of the sheet,
the clothes of the nearest picture above this scene in its own line of the story, or the sheet's `outfit` if there is
none (`wornAt` in `local/picture.ts`). The model is told to repeat that line word for word unless the story changed
it since. What the frame answers is kept on the scene as `clothes`, by sheet name, and is where the next picture below
it starts. A branch walks only its own parents, so a change in one line of the story never dresses another.
The rule as it stands is in [telegram-ui.md](telegram-ui.md#picture-pipeline).

A sheet written before this has clothes inside `look` and no `outfit`. It is written once more at the next picture of
that story, from the history as it stands. The `picture_sheet_written` row then carries `sheetRewritten: true`, and
every `picture` row counts in `clothesChanged` the people of the sheet dressed otherwise than in the picture before.
Nothing of the clothes is logged. How well the model notices a change of clothes that happened several scenes back,
or one that the memory of a compacted story no longer mentions, is not measured yet; the carried line is there so
that such a change is lost only once and not undone later.

<a id='prompt-under-picture'></a>

## The prompt under the picture (2026-09-24)

The tester asked to see the prompt of each picture and how long it is, to tune a style line against it. Every photo,
the scene's own and every sample, now gets a reply right after it: a rich message folded to one line that gives the
prompt's size, which opens to the prompt as plain text that wraps on a phone (`foldedPrompt`, [telegram-ui.md](telegram-ui.md#picture-prompts)). The prompt goes to
the reader of the story it was drawn from and to nobody else; the logs still carry counts alone. The note is sent
through `sendKept` like the photo, so a deletion of the scene takes it out of the chat with the photo. A note that
Telegram refuses costs the note alone and leaves a `picture_prompt_unsent` row with Telegram's code. A photo already
handed to Telegram when the reader's next move or `/cancel` stops its picture goes out with its note all the same
(decided 2026-09-25): it is in the chat either way, and of no use there without the prompt it was drawn from. Nothing
of that picture follows the note, and its row is `ready` with `cancelled: true`.

The size is the prompt's characters and, when the bot is given the picture model's tokenizer (`promptTokens` in the
illustrator's deps), its tokens as the text encoder reads them, with the style line's share: the count of the whole
prompt less the count of the description before the line, so that the token where the two meet is the line's. The
`picture` and `picture_sample` rows carry the same numbers as `promptCharacters`, `pictureTokens` and `styleTokens`.
Until the tokenizer is wired in, the note and the rows give characters alone.
The tokenizer was wired in the same day, as the tokens the graph's text encoder conditions on (`encoderTokens` in
`local/picture.ts`). The note as it is now is in [telegram-ui.md](telegram-ui.md#picture-prompts).

<a id='prompt-variant-decision'></a>

## A variant from the reader's own prompt (2026-09-24)

The owner asked for a way to edit the prompt of the picture after a scene, for tests. The note under a scene's own
picture now has a button that asks for a whole prompt: the reader copies the prompt from the note, edits it and sends
it, and the bot draws it as it came. Nothing is assembled, no name or age is cut out, no style line is added. The
screens are in [telegram-ui.md](telegram-ui.md#picture-variants).

Two prompts compared mean nothing if anything else differs, so a variant is drawn by the recipe of the picture it
varies, never by the configuration of the day. The scene keeps, as `picture`, the seed of its own picture, a hash of
the graph as the bot read it, the checkpoint's file name, and the size, steps, cfg, sampler and scheduler it was drawn
with (`PictureRecipe` in `lib/library.ts`), written in the same write that records the photo (`sendKept` in
`local/picture.ts`). It lives as long as the scene, not as long as the photo's `sentPictures` record, which goes after
the 48 hours in which a bot may delete its message: a variant can be drawn under any scene's picture drawn since
scenes keep it, while the graph and the checkpoint are the same. A picture drawn with a graph or a checkpoint the bot
no longer has is refused with the reason, rather than drawn with another. There is no choice of seed: a new seed
would mix what the words do with what the noise does. Samples get no button and no recipe, because this first
version answers the request about the picture after a scene.

The variant's note gives no style share, which nobody knows for a prompt written whole. A variant changes nothing of
the story, not the sheet, the clothes or the frame kept for samples. What the recipe does not pin, and the rest of
the variant's contract, are in [telegram-ui.md](telegram-ui.md#picture-variants).

<a id='portrait-details'></a>

## Portraits from a longer description (2026-09-26)

The owner decided on 2026-09-26 that a portrait is drawn from a detailed description, which Gemma compresses into the
short look the frames use now. On 2026-09-27 the owner replaced how that description is made and kept with three
layers ([below](#three-layers)): the sheet takes each person's description from the story instead of writing English
details and a look, and one retelling of the whole sheet writes those two. This section keeps the first design, the
reasons for it and the measurements that set the rules the retelling now keeps.

Round one of the action measurement drew its fronts from the look ([the sheet](action-experiment.md#the-sheet)). In
`flight` both daughters, 8 and 4 in the seed, came out of the sheet as a "young girl", and their fronts drew adult
women: the sheet's rule allowed only the age words of adults (young adult, middle-aged, elderly). Three of that
sheet's four looks named no skin tone. A look of 15 to 25 words has to serve a frame of up to four people, where every
word of it competes with the action; a portrait holds one person and can take far more.

- In the first design the sheet (`SHEET` in `local/illustrate.ts`) wrote, for each person, `name`, `details`, `look`
  and `outfit`, in that order. `details` came before `look` in the schema's properties and in its required list, so
  that the model wrote the long description first and compressed it in the same answer, as the variant frame of the
  action measurement relies on `role` and `facing` coming right after `who`. The retelling keeps that order.
- `details` was English, 50 to 80 words, without names, clothes or numbers, in this order: sex and age as a word,
  with the words of children (small child, child, teenager) beside those of adults, and never a number, the age a
  person looks where the story says they look younger or older than their years; skin tone; height and build with
  their proportions, a height, a weight or a measurement the story gives as a number turned into words against an
  ordinary person of the same sex and age, a strong difference in the numbers with "very", and what the story says
  of the body in words as strongly as it says it; hair, its colour, length, texture and usual style; the face, its
  shape, brows, eyes and their colour, nose, lips, facial hair and lines; permanent marks with their place and side.
  What the story named came from the story, and the rest was invented once, plausibly for the story's world, so that
  the characters differ in silhouette, hair and face. A hairstyle that comes and goes stayed out, as injuries and
  things in hand do.
- `look` stayed at 15 to 25 words without numbers, compressed from `details`: the same age word, height and build
  with each noticeable proportion in words of its own rather than one general word (curvy, voluptuous, muscular),
  skin tone, hair and one or two marks. The frames use it as before.
- A portrait is drawn from `details` (`portraitText` in `local/image-portraits.ts`), retold from the description since
  2026-09-27 ([three layers](#three-layers)), through the same `assemblePrompt`, which cuts out names and ages given
  as numbers. It now cuts out every name of the sheet, since the details of one person may name another. A sheet
  written before 2026-09-26 had no details and drew its portraits from the look, and was not written again for them;
  since 2026-09-27 a sheet without the story's changes, which every earlier one is, is written again by the next
  picture. A kept portrait records the text it was drawn from in its `look` field, and the card calls it a portrait of
  the earlier look once the person's text differs.
- The details were also the reader's main text, up to 1000 characters in any language. Each time, one call of the
  language model compressed them into the look again by the sheet's rule for the look (`lookRequest`), and on the
  morning of 2026-09-27 also retold them as English details for the portrait, beside the looks of the sheet's other
  people: prose without markup, names, clothes or numbers, JSON with one retry and at most 900 tokens, an answer with a
  digit or a table's bar refused. It ran right after the edit, so that the card showed the new look, and before the
  next frame where it had not. Since the three layers the reader writes the person's description instead, and the
  retelling of the whole sheet reads it ([three layers](#three-layers)); details a reader wrote before become their
  description.
- The owner decided two more things on 2026-09-26. First, the portrait is drawn from the details as written, in any
  language, with no translation and no call added. Whether the image model follows a Russian description as closely
  as the same one in English is checked at the next rental by the T probe's
  [language test](action-experiment.md#t-probe-lang); `stripAges` in `local/illustrate.ts` knows only English, so an
  age given as a number in another language reaches the portrait. Second, a look the reader writes stays as an
  override (`edited`): the frames take it until the reader writes the details again, whose new look replaces it. It
  keeps the details, which portraits are still drawn from, and a sheet written anew keeps it over the model's new
  look. Since the three layers it stays until the reader writes the description again.
- The owner replaced the first of those on 2026-09-27: a reader's table of measurements, drawn as written, came out
  as lettering on the picture. What the reader writes now reaches a portrait only as the language model retells it in
  English prose, with the look, and never as written.
- The frame instruction and the portrait's clothes, style and pose stay as they were, but for one rule, changed the
  same day as the owner agreed: the look the frame writes of a person the sheet does not name takes the sheet's age
  words, children's included, and the skin tone, where it allowed an adult's words only. Since 2026-09-27, as the
  owner agreed, that word is the age the person looks, never their years, as in the sheet and the retelling. The sheet
  check of that day had no one off the sheet ([its counts](action-experiment.md#sheet-check)), so the frame alone was
  asked of the hosted `google/gemma-4-31b-it` the same day, 3 calls, on a synthetic scene whose ferryman, seventy and
  looking forty-five, is not on the sheet of the two travellers: all three looks gave him "male", "middle-aged" and a
  fair skin, with no digit. The identity measurement's recipe still draws from the look, as its run pinned it
  ([portrait recipe](identity-experiment.md#portrait-recipe)).
- The owner decided on 2026-09-26 that a height, a weight or a body's measurements the reader gives as numbers reach
  the look as words about height, build and proportions, measured against an ordinary person of the same sex and age:
  the look holds no numbers, and a frame keeps a person's build by the look and the portrait alone. Before that rule
  the hosted `google/gemma-4-31b-it` compressed six synthetic descriptions, two samples each. A table of eight
  measurements came out as "young adult, lean build, tall stature", with an age it was not given and no word of the
  shoulders, the waist or the hips; a woman whose chest, waist and hips were 92, 66 and 98 cm as "slim" or "slender
  build"; a man of 192 cm as "heavy build", without "tall". The same check found the rule giving that woman a fair
  skin her details did not name, and a girl of fourteen the look "Teenager", with no word of her sex. So the rule
  names the words of the sex (man, woman, boy, girl) apart from those of the age, and a sex, an age or a skin tone the
  details do not give stays out of the look. With the rule, the same descriptions and samples gave the table "Tall,
  slender man, broad-shouldered, narrow-waisted, long-legged" twice, with no age but a sex it was not given; the
  woman "slender, wide-hipped", still with the fair skin; the man of 192 cm "heavyset, broad-shouldered", still
  without "tall"; and the girl "Teenager girl". No look held a digit, and a description in words alone came out as
  before. A second run of the rule gave the man "tall" twice, so "tall" in two of four looks, and again a sex to the
  table and a fair or light skin to the woman.
- On 2026-09-27 the owner set where a height in numbers becomes a word, against an ordinary adult of the same sex and
  age: a woman is tall from about 175 cm, so one of 170 is not, and a height the text also gives in a word keeps that
  word. A man is tall from 188 cm, on the same step of 10 cm over an ordinary man's 178 as 175 is over an ordinary
  woman's 165; very tall is 18 cm over (183 and 196 cm) and short 10 cm under (155 and 168 cm). `HEIGHTS` in
  `local/illustrate.ts` gives them, with feet and inches beside the centimetres, to the retelling, as it gave them to
  the sheet's details until the three layers. Where the sex cannot be told, the retelling named only what is unusual
  for either sex, which left a table alone empty ([the check](#retell-check)), and since that check it compares with
  an ordinary adult and names no sex. The same day the owner
  allowed the retelling a sex that words about the body leave in no doubt, a beard or a bra size, never one read from
  measurements alone, so a text with no sign of it still gives none; and kept one age word, the age the person looks
  and never the real one, with "looks about N" left to the card test ([below](#figure-card-test)).
- On 2026-09-27 the look's rule named what those runs still got wrong: a sex or a skin tone only where the details
  name it outright, since measurements are not a sex and freckles not a skin tone; height with the build, and "very"
  for a strong difference; the age a person looks where the details give both their years and that age; and the usual
  hairstyle where it changes by the day. On the same descriptions, two samples each, and three new ones, three
  samples each, the hosted Gemma gave the table "Tall, slender, broad-shouldered, narrow-waisted, long-legged" twice,
  with no sex; the woman "woman, young adult, slender, wide-hipped", with no skin tone; the man of 192 cm and the man
  of 6'4" "tall" and "very tall" in all four; a man of 52 who looks 25 "young adult" in all three, where the rule of
  2026-09-26 gave "Middle-aged" in all three; and a boy of six "boy" in all three, where it lost his sex once and gave
  him a fair skin his details did not name in all three. The hard case, 35 years old and looking 22, with a table of
  ten measurements, a body described in words and a bun on busy days, came out as "Young adult woman, very large
  breasts, narrow-waisted, wide-hipped, very fair skin, long wavy copper-red hair, green eyes, freckles on shoulders"
  and twice close to it, with no bun and no digit in any look. Its text names no sex outright, and all three looks
  said "woman" all the same, against the rule: the model read it from the bust, as it no longer did from the table
  alone. None of the three kept the soft limbs without muscle, one gave "average height" and two no height at all.
- The sheet's details and look took the same rules the same day. On a synthetic story that holds the hard case, a
  boatman of 52 who looks 25, 196 cm and 120 kg, and a girl of seven small for her age, the sheet of 2026-09-26 put
  the measurements as numbers into four of its six details of the two measured people, called the boatman
  "middle-aged" in all three samples, and gave the woman's look her market-day bun in all three and a general
  "hourglass" or "curvy" figure in place of her waist and hips. With the rules (five samples) no details held a
  digit; the boatman was "young adult" and "very tall" in all five, and his heavy build, in all five details, reached
  two of the five looks; the woman's look named her bust, waist and hips in all five and her bun in none, while her
  soft limbs and rounded hips stayed in the details alone; and the girl's details kept "small for her age" in all
  five, her looks "small and slender" or "petite". Two drafts, three samples each, show why the rules say what they
  say: without the words for each proportion the woman's look was "tall and very voluptuous" or "very curvy with
  very large breasts" in two of three, and with "very" for any strong difference, not only in numbers, the girl was
  "very small" or "very short" in both her details and her look in two of three. The woman of 170 cm came out "tall"
  in all five sheet looks, where the rule for the look alone gave her "average height" once and no height twice: a
  height near the border goes either way. Round two's pins change with it
  ([the sheet](action-experiment.md#the-sheet)). The retelling of a reader's details took these rules for one
  person, and those of the rule above on the sex, the skin and the age ([asked of a model](#retell-check)); since the
  three layers it takes them for the whole sheet. The sheet check was asked again on these rules on 2026-09-27
  ([its counts](action-experiment.md#sheet-check)).
- Two people of one story whom the reader describes alike (a mother and daughter, both very fair, tall, curvy,
  young-looking, with very light hair: the owner's concern of 2026-09-27) would each be compressed on their own into
  much the same look, and a frame holding both could not tell them apart. The retelling therefore saw the looks of
  the sheet's other people, and since the three layers sees their descriptions too, and names, right after the sex and
  the age, what tells this person apart from one they resemble, and a look is the same words in every frame. It takes
  that from the texts alone: where the texts do not differ, neither do the looks, and the reader's note on the card
  asks for what tells a person apart from afar, such as a hairstyle of their own, which the look keeps as the usual
  one. Since the check below, it asks for what the others lack, in the order hair, height, skin, marks, and for what
  they share after that, in words about this person alone. Whether a frame keeps two such people apart is not
  measured.
<a id='retell-check'></a>
- The retelling was asked of the hosted `google/gemma-4-31b-it` on 2026-09-27, through the bot's adapter and without
  a story, as the card asks it: six synthetic descriptions, three samples each, 18 calls. They were the hard case
  above; a look-alike of nineteen, 176 cm, as fair, with the same narrow waist and wide hips but a small bust, soft
  arms and straight light red-golden hair always in a high ponytail, who saw the hard case's look as the sheet wrote
  it ("Young adult female, tall, very large bust, very narrow waist, very wide hips, fair skin, long copper-red hair"),
  while the hard case saw the look-alike's new look; the table of eight measurements with no sex, age or words; the
  boy of six; the man of 52 who looks 25; and the man of 6'4". No answer held a digit or a bar, the table got no sex
  or age, and every age was the one looked. The hard case was a woman by her bust in all three, as the owner now
  allows, not tall, and her soft limbs stayed in all three retellings; the look-alike was tall in all three, as the
  heights say. But the table came back with both fields empty all three times (`look_missing`), the boy was a "small
  child" with no word of his sex all three times and once got a fair skin, and the man of 6'4" was "very tall" all
  three times where the heights make him tall. Of the pair, the look-alike led with "tall" all three times, which the
  look she saw said too, and her small bust reached none of her looks; the hard case led with her bust once, with her
  narrow waist, which the look-alike's look had too, once, and once with "unlike the other woman she is not tall", a
  look of 31 words that names another person.
  - Revised once, as the check's rules allowed, the text asks for the sex and the age as two words, says that an age
    word is not a sex and fair hair not a skin tone, gives the heights in feet and inches too, says that details and a
    look are never empty, and asks the look-alike rule for what the others' looks lack. The failing cases were asked
    again, 9 calls: the boy was a "boy child" twice with no skin, the man of 6'4" "tall", and the hard case led with
    her "copper-red wavy hair" twice with no comparison, but the look-alike still led with "tall" twice. The table
    came back empty once and as "A person with broad shoulders and a narrow waist" once. The retellings grew terse,
    43 to 46 words where the first text wrote 58 to 77 for the same two women, opening with "Woman young adult"; the
    hard case lost her soft limbs in both, the look-alike her small bust and soft arms in both, and the man of 6'4",
    in 11 words of details, the tattoo his look kept.
  - So each pair's two looks led with different traits (four of four after the revision, four of six before), but
    the rule's own ask, what the other's look lacks, was met by the hard case alone. A table with no sex, age or words
    could still leave a person's look pending before every frame, and the revision that fixed the boy and the heights
    made the retelling lose the build it was made to keep. The replies are synthetic and kept outside the repository.
  - The retelling of the three layers keeps what that revision fixed and changes what it broke or left failing: the
    sex and the age as one ordinary phrase ("a young adult woman"), where two words each of its own gave "Woman young
    adult"; the build with arms and legs named, soft or muscled; a table alone put into words, compared with an
    ordinary adult where the sex cannot be told; people alike led by what the others lack, hair first; and the scale
    of words kept within one sex and one age group ([three layers](#three-layers)).
- The retelling of the three layers was checked on 2026-09-27 on the hosted `google/gemma-4-31b-it`, through the bot's
  adapter, 16 calls: the descriptions the sheet check took from `gym`, three samples, `huddle`, two, and `flight`, one
  ([the sheet check](action-experiment.md#sheet-check)); one of `gym`'s two sevens rewritten as a reader would, in
  English and partly a table, asked alone beside the others' looks, two; the six descriptions of the first check as
  one sheet, three; the hard case and the look-alike each on a sheet of her own, one each, for the card test's pair;
  and a woman whose build is only «фигура как у Грейс Ховард из Zenless Zone Zero», three. `flight`'s call went out
  with nobody on it, since the script read the sheet of a run a provider failure had stopped, and `flight` was asked
  with the revision below. No answer held a digit, a name, a comparison or a person left out, and no child got a word
  for the bust, the hips or the buttocks.
  - It passed where the two sevens got the same words in all three samples, and the reader's seven the words of the
    sheet's, twice, led by her braid; where `huddle`'s women were young adult and tall, the mother's bust a step above
    the daughter's and the daughter's hips a step above the mother's, both led by their hair, and Рустам short and
    heavyset with no beard; where the man of 52 who looks 25 was young adult; where the hard case kept her soft limbs
    and no "tall" and the look-alike her small bust in her details, both led by their hair, in details of 64 to 69
    words; and where the named figure's name reached no look and no details.
  - It failed where the size 6 got a stronger bust word than the sevens in two samples of three ("extremely large"
    over "very large") and the size 8 two intensifiers in all three ("extremely very large"), so that the sizes came
    out in order once; where the size 6's «очень широкие бёдра и очень большие ягодицы» became "extremely" once; where
    the man of 194 cm and the man of 6'4" were "very tall" in all five, though the heights make them tall; where the
    table alone was "a man" in all three, a sex read from measurements; and where the boy of six was "a small child"
    with no word of his sex in all three.
  - Revised once, as the check's rules allow: the people are put in order by a measure before its words are given, on
    a ladder of small, medium, large, very large, extremely large and huge, one intensifier a word; «очень» is very and
    not extremely; each height word's range is closed at both ends; a child's age word takes the sex word after it ("a
    small child, a boy"); no measurements give a sex however male or female they seem, and details and a look with no
    sex open with "a person". The failing cases were asked again, with `flight`, 9 calls. The busts were large, very
    large, very large and extremely large in all three samples, so the sizes 6, 7, 7 and 8 came out apart and in
    order, with no collapse into one word and no "huge"; the hips and buttocks kept the story's words; both tall men
    were tall in all five; the table opened with "A person" in all three, with no age; the boy was "a small child, a
    boy" in all three, with no skin; and `flight`'s daughters were "a child, a girl" and "a small child, a girl", with
    the skin tones of the sheet's line and no word for the bust, the hips or the buttocks. The reader's seven, the pair
    and the named figure were not asked again.
  - What the revision lost or left: the bust became "chest" in two samples of `gym` of three and in one of `huddle` of
    two, a word the image model may take for a man's; the boy's "small for his age" reached none of his three
    retellings, where the first text gave him "short" in all three; the man of 179 cm was "tall" once; `gym`'s women
    were "slender", which their descriptions do not say in words, in the details of all three; and the hard case, 72 kg
    at 170 cm, was "heavyset" in all three, as in two of the first text's three on the same sheet, where on a sheet of
    her own she was "slender". The named figure came out in all three as a tall woman with broad shoulders, a large or
    very large bust, a narrow waist, wide hips and large buttocks, a build the description does not give in words: the
    model put a guess at the character's figure in place of the name. The replies are synthetic and kept outside the
    repository.
- How long a portrait's text may be. The pinned ComfyUI 73c9bad4 cuts none of it: Qwen-Image 2.1's tokenizer has a
  `max_length` of 99999999 and no padding to it (`comfy/text_encoders/qwen3vl.py`, line 151), the tokenizer of
  `comfy/sd1_clip.py` splits a text into batches only past that length (lines 572-674), the encoder drops the
  template's system turn and, unless it is asked to keep them, the pictures' placeholders
  (`comfy/text_encoders/qwen_image21.py`, lines 47-72), and the model numbers every text token it is given
  (`comfy/ldm/qwen_image21/model.py`, lines 265-278). The 512 tokens often quoted for Qwen-Image are the default
  `max_sequence_length` of diffusers' pipeline for the original Qwen-Image, which cuts there and allows up to 1024;
  diffusers' Qwen-Image 2.1 pipeline cuts nothing. Whether the model follows the end of a long text as well as its
  start is not measured. A retelling of at most 200 words, as its rule asks, is at most about 270 of the encoder's
  tokens (150 words of the sheet's English took 205), so a portrait's prompt with its pose, clothes and style (102
  tokens) stays under those 512. The reader's own text never reaches the image model now, so it is limited in
  characters alone, `DESCRIPTION_CHARS` in `local/picture.ts`, 1800, and the characters' card's room for it is given
  under [three layers](#three-layers). Until 2026-09-27 the limit was 1000 characters, drawn as written:
  about 230 tokens of English, 430 of Russian and 880 of Japanese. The hard case is 684 characters and 303 tokens,
  and its portrait as written 413 tokens as the encoder takes it.

The sheet had the frames' limit of 900 tokens. A synthetic reply of six people at the top of every word range, counted
by Gemma 4's tokenizer (`local/tokenizer.ts`), took 1102 tokens as compact JSON and 1225 indented, where the sheet
before the details took 450 and 555 at the top of its own ranges. With a quarter more words than the ranges allow it
took 1341 and 1464, and with half more, 1570 and 1693. The details cost about 106 tokens a person, 1.32 tokens a word.
So the sheet got a limit of its own, `SHEET_TOKENS`, 1800 as the variant frame has, and the frame kept 900; since the
three layers it is 3600 ([three layers](#three-layers)). A reply that runs away into newlines still gets its one
retry, and runs that much longer before it. The estimate that lets a description far from the end of the context skip
the server's count (`trusted` in `local/picture.ts`) leaves room for the answer's limit, whichever it is.

Round two of the action measurement draws its fronts from the details, retold since the three layers, and each new
instruction changes its pins ([the sheet](action-experiment.md#the-sheet)).

The bot's style line changed the same day, as the owner agreed: `STYLE` in `local/illustrate.ts`, the `novel` preset,
asks for "Naturalistic facial proportions true to each person's age" where it asked for "Naturalistic adult facial
proportions". It ends every frame, after the looks, and with a child's age word now in the sheet, "adult" there would
have given that child an adult's face in every frame. It changes every frame the bot draws in its own style and round
two's pins; the T probe keeps round one's line, to set its variants beside round one's pictures. The `film`,
`graphic` and `watercolor` presets asked for adult faces or anatomy for the same reason and now ask for anatomy and
proportions true to each person's age (`local/picture-style.ts`); `semi` names no age and stays as the owner approved
it.

<a id='three-layers'></a>

## Three layers of a person's appearance (2026-09-27)

The owner decided on 2026-09-27 that each person of a story's sheet has three layers of appearance, made along one
path whether the reader writes the first or the sheet takes it from the story:

1. `description`: the person's whole appearance, in any language and form, with its line breaks and tables, up to
   1800 characters (`DESCRIPTION_CHARS` in `local/picture.ts`). The sheet takes it from the story, or the reader writes
   it on the characters' card, and the reader's wins. It never reaches the image model.
2. `details`: English prose for the portrait, at most 200 words, retold from the description and the story's changes.
3. `look`: 15 to 25 words for the frames, retold with the details. The reader may still write it, up to 400
   characters (`LOOK_CHARS`), and a description written later replaces it.

A portrait is drawn from the details (`portraitText` in `local/image-portraits.ts`), and `assemblePrompt` puts the
look into each frame, as before.

**The sheet takes the descriptions from the story.** `SHEET` in `local/illustrate.ts` asks for each person's `name`,
`description`, `changes` and `outfit`. The description is everything the story says of the person's lasting
appearance, as detailed as the story gives it and at most 150 words: the sex, the age and the age the person looks,
the skin, the height and build, the measurements, the hair and its usual style, the face, and the permanent marks with
their place and side. Numbers, measurements and tables go in as the story writes them, and words about the body as
strongly as it says them, with no name and no clothes, and the appearance is the one the story leaves by its last
scene. It is in the story's language: the reader reads it on the card and writes over it there, and the story's own
numbers and words are put into English once, by the retelling, rather than rounded or reworded by the sheet first.

Where the story is silent on the sex, the age a person looks, the skin, the height and build, the hair or the face,
the sheet still chooses, once, plausibly for the story's world and so that the people of the sheet differ in
silhouette, hair and face, and writes the choice as the description's last line, which starts «Не сказано в истории:»
in the story's language. The look of the first design made the same choice once, and every frame repeated it. The
line keeps that, since the choice is now part of the text every retelling reads, and it shows the reader which part of
the description the story never said.

`changes` is one line in the story's language: the lasting changes of appearance the story made (a scar, a new
haircut, a shaved head, dyed hair, a tattoo), which the description holds already, empty when there are none. Wounds
and bandages that heal, dirt, wet hair, things in hand and a hairstyle for one day stay out of both, as clothes do:
they are the frame's to say, scene by scene. The changes are what the story adds on top of a description the reader
wrote. The retelling reads the two together, and where they disagree the description wins (the owner, 2026-09-27).
The card shows the changes under the description, and only the story makes them.

A synthetic reply of six people with descriptions of 150 Russian words, changes of 20 and outfits of 20, counted by
Gemma 4's tokenizer, took 2494 tokens as compact JSON and 2634 indented, and with descriptions of 200 words 3342
indented, so the sheet's limit is 3600 tokens (`SHEET_TOKENS`).

**One retelling for the whole sheet.** `RETELL` and `retellRequest` in `local/illustrate.ts` make one call, with no
story, for everybody on the sheet still to be retold (`lookPending`). Each person is numbered, never named, and shown
with their description, the story's changes and, for somebody not asked this time, the look they have. The answer
gives each person asked `details` and then `look`, in that order in the schema, so that the long text is written
first and the look compressed from it. The rules are those the first design's checks set (above): numbers as words,
heights by `HEIGHTS`, the age a person looks as one age word, a sex only where the text names it or words about the
body leave no doubt, a skin tone only where the text names it, the usual hairstyle, and each noticeable proportion in
words of its own. Two rules need the whole sheet in view:

- Graded words (the owner, 2026-09-27). One measure of people of the same sex and age group is given in the words of
  one absolute scale across the sheet: the same size in the same word, one size more in the next word up ("large",
  "very large", "extremely large"), and never a comparison ("larger than hers", "the largest"), since a look is the
  same words in every frame, beside different people each time. A look carries the word and not the number behind it,
  so other people's looks alone cannot keep that scale, and their descriptions can. Since the check, the retelling
  puts the people in order by the measure before it gives the words, on one ladder (small, medium, large, very large,
  extremely large, huge) with one intensifier a word: without that a size 6 got a stronger word than two sevens, and
  with it `gym`'s four got large, very large, very large and extremely large ([the check](#retell-check)).
- People alike. Right after the sex and the age, each look names what the people it resembles lack, in the order
  hair, height, skin, marks, and what they share, proportions included, after that.

A child or a teenager gets no word for the bust, the hips or the buttocks, in the details or the look, even where the
description has one: their build is their height, how thin or plump they are, their shoulders, arms and legs. The
proportions the rule lists for everybody name those three, so the rule is said apart, and since 2026-09-27, before the
second check ran, a hit fails the sheet's check and the retelling's; neither had one. The sheet's description leaves
them out for a child as well, and so does the look a frame writes of somebody the sheet does not name. The age word is
the age a person looks, so an adult described as looking a teenager loses them too.

One call for the sheet, rather than one per person as the reader's details had: two women of the same size 7 retold in
two calls get whatever word each call picks, and neither call sees the other's number, while one call sees every
number at once. It is also one call per sheet written instead of one per person. An answer with a digit or a table's
bar in a person's details or look is refused for that person (`inWords`), and a person it leaves out stays to be
retold. The limit is 200 tokens and 500 more for each person asked (`RETELL_TOKENS`): details of 200 words and a look
of 25 came to 295 tokens of Gemma 4's tokenizer as compact JSON and 321 indented for one person, and to 1861 indented
for six. One call answers for six people at most, as many as the sheet the model writes, and the rest of a sheet made
longer by the reader's own people wait for the next.

**When people are retold** (`retellPending` in `local/picture.ts`):

- The reader writes a description: that person is retold at once, beside everybody else's description and look, so
  that the card shows the new look (`retell`, the row `look_retold`). The description replaces the reader's own look,
  if they wrote one.
- The sheet is written, or written anew: everybody on it is retold before the frame, in the turn that describes it
  (the row `picture_look_retold`). A sheet written anew keeps the reader's description, their own look and the portrait
  they kept (`rewrittenSheet`).
- A sheet from before the three layers has no changes, and the next picture writes it anew. Details a reader wrote
  before become their description, and until that rewrite a sheet's details stand in for its descriptions
  (`descriptionOf`).
- If the model is off or the call fails, the descriptions stay, the people wait as `lookPending` and the card says so,
  a portrait is drawn from the look meanwhile, and they are retold before the next frame. A person left without a look
  is described in that frame as somebody the sheet does not name.

**Order and cost.** A story's first picture waits for the sheet, the retelling and the frame, one after another. The
sheet and the frame continue the scene's own request, so a server with a prefix cache pays for their instructions
alone. The retelling carries no story, so on a llama.cpp server with one slot the frame after it reads the story's
prefix once more: one more prefill of the story for each sheet written. A reader's edit costs no prefill of the
story, since it runs apart from the frames. For a reader with versions of the sheet
([along the story](telegram-ui.md#along-the-story)), a frame that names a lasting change is followed by one more
retelling, and so by that prefill once more, on the scenes with a change alone; a description the reader writes for
the whole story on a line that has versions costs one more retelling of them, at once or before the line's next frame.

**The card** ([telegram-ui.md](telegram-ui.md#characters)) edits the description and counts it in characters alone,
shows the changes under it, and gives the look and the clothes their tokens as before. The details are folded under
each portrait drawn from them, within its whole prompt, with the prompt's tokens as the picture model reads them
([a portrait's own prompt](telegram-ui.md#portrait-prompt)). Beside a name of 60 characters, a look of 400 and clothes
of 300, a story's title of 18 and no portrait kept, the card in English has room for 2052 characters of description
with no changes and for 1856 with changes of 150, and in Russian for 2154 and 1964; in the reference experiment, whose
card says how the frames take the portrait, for 1868 and 1672, and 1989 and 1801. These are the numbers of 2026-09-28,
after the card came to name the portrait's whole prompt; the 1849, 1653, 1994 and 1805 written here on 2026-09-27
could not be reproduced, the same card before that change giving 2141, 1945, 2233 and 2044, and their setup was not
recorded. A longer card loses its last lines to the clip, those on the point of view and the portrait first, never the
description, which comes first.

**Limits, measured or not:**

- A reader's own look has no limit but its 400 characters (the owner, 2026-09-27). Looks over 25 words are not
  measured: round one's were 15 to 25 words, and in a frame of four, where each look comes before its person's action
  (`assemblePrompt`), a longer one may crowd the action out. The card gives no hint of it.
- A lasting change the story makes after the sheet was written reaches the sheet only when the sheet is written anew,
  which happens to an older sheet and never by itself. For a reader with versions of the sheet (2026-09-28) the frame,
  which reads each new scene anyway, names such a change in a field of its own, and it holds from that scene on down
  its line alone ([along the story](telegram-ui.md#along-the-story)).
- The reader's description wins over a change the story makes later: a braid the reader described stays after the
  story cuts it, until the reader writes the description again. For a reader with versions, a change a frame names
  wins over the description in force above it, since it is later, and the braid goes from that scene on.
- A sheet is the story's, not a branch's: a change taken from one branch reaches the pictures of every branch. So is
  it for a reader with versions, whose sheet is still written once from the history of the story's first illustrated
  scene, on whatever line that was; only the changes named after it, and what they write «only from this moment», hold
  on one line.
- Whether the graded words reach a picture as grades, and whether two people alike stay apart in one frame, is the
  card test's to show ([below](#figure-card-test)).

<a id='figure-card-test'></a>

### The card test at the next rental (plan, 2026-09-27)

The owner agreed on 2026-09-27 that the next rental's plan holds this test. It is a plan only and rents nothing. It
asks what no text check can: whether Qwen-Image 2.1 draws the words of a build as proportions or averages them, whether
a kept front as a reference keeps the build where the words alone do not, whether two alike people stay apart in one
frame, whether "looks about N" moves the age a person looks, whether graded words keep four figures apart, and what a
game character named for a figure does. Its texts are synthetic and fixed before the rental: the hard case and its
look-alike of the [retelling check](#retell-check) stand for a reader's descriptions, and the four women of `gym`
([the set](action-experiment.md#the-set)) for a sheet the story wrote. The retold texts are the check's: the hard
case's details and look, and the pair's looks with each other in view, from the revised text's first sample of the six
people; the pair's looks without, from the first text; and `gym`'s looks from the revised text's second sample, the one
of three that says "breasts" where the other two say "chest". The scenes are written by hand. Every picture is drawn by
the bot's model and recipe, not the pilot's few-step pass.

- 4 fronts: the hard case drawn from its English retelling and from its table as written, seeds 7 and 11. The test
  stops here if no retold front keeps the build.
- 12 frames: three fixed synthetic scenes (a market stall, carrying crates, sweeping a porch), in clothes unlike the
  portrait's, two seeds each, from the look's words alone and from the words with the kept front as a C reference. The
  reference goes forward only if it keeps the build in 6 of 6 where the words alone do not.
- 4 frames: the hard case and the look-alike in one frame, two seeds, from looks retold without the other in view
  and with her. The rule stays if it tells them apart in 2 of 2 where they merge without it. The looks without her
  were each retold on a sheet of her own, two calls of the check's first text.
- 2 fronts, the owner's arm of 2026-09-27: the hard case's retelling with "looks about 22" after its one age word
  (young adult), seeds 7 and 11, beside the retold fronts above, which are the same prompt without it. N is the age the
  person looks, never their years (35 here), and the arm asks which front reads closer to 22.
- 4 frames, the owner's arm of 2026-09-27 on graded words: the four women of `gym` in one frame, seeds 7 and 11, from
  `gym`'s variant frame of the sheet check with their retold looks, once as it is and once with the order stated
  outright after the looks ("from left to right, each woman's bust is larger than the last, the middle two alike"), the
  women placed in that order, the one the frame lists them in. It asks whether the absolute words alone keep the sizes
  6, 7, 7 and 8 apart, and whether the stated order does where they do not; the hips and buttocks, graded the other way,
  stay in the looks of both.
- 8 pictures, the owner's arm of 2026-09-27 on a named figure: one synthetic woman's front by the portrait recipe
  (`portraitPrompt`), from her words alone and from the same words with "with a figure like Grace Howard from Zenless
  Zone Zero", seeds 7, 11 and 13; and the `gym` frame above with that phrase added to one woman's look alone, seeds 7
  and 11. It asks whether the figure moves toward the character's, and whether her face, hair or clothes come with
  it. A page like the pilot's `turbo.html` puts each pair side by side. In the retelling's check the language model
  put a guess at the figure in place of the name ([the check](#retell-check)), so the name reaches the image model
  only in a look a reader writes in English.

That is 34 pictures, 12 fronts, 16 frames from words and 6 with a reference, about 4 minutes warm at the pilot's times
with Triton (a front 6.4 s, a frame 6.1 s, a frame with a reference about 7 s by estimate) and 6 to 9 minutes with the
start. Which pictures keep the build, tell the two apart, read closer to 22, keep the four figures in their order or
move toward the character is for the owner's eye, as the T probe's are. Everything in it stays clean: sportswear and
ordinary training, and neutral words for the body. It is drawn whole and read after: the 12 fronts first, since the
frames with a reference need the kept front, which is fixed before the card as the retold front at seed 7; then the 16
frames from words; then the 6 with the reference. A gate above that fails is read from the page, and the pictures after
it are not judged.

**The harness.** [image-figure-test.ts](../local/image-figure-test.ts) draws the test on the picture card after round
two's draw and before [the body test](action-experiment.md#body-test), on the same server, tunnel and `"$end"`. Its
texts are figure-age's `figure-card-texts.json` of 2026-09-27, the 34 cells in the card order with each exact prompt,
copied before the rental to `illustrations/figure-card/texts.json`. They stay out of the repository as the body test's
`bodies.json` does; the script pins their sha256 and refuses any other file, or one whose cells are not its plan's.
The card order: the 12 fronts on the front graph at 720x1280, then the 16 frames from words on the action graph at
1280x704, then the 6 C frames with `front:hard-retold:s7` as image 1, area-scaled to 352x640 as round two's C, each at
its own seed with the graphs' 25 steps of euler/simple at CFG 1. A cell begins only if it can end by `--until` at its
admission price, the pilot's warm time with Triton a quarter more and 3 s: 11 s a front, 10.7 s a frame from words and
17.1 s a C frame, which takes the pilot's V with four references rather than the 7 s estimated above; the run's first
cell adds 45 s for the compile, and the first cell of each other group 15 s. A C frame whose front failed waits for a
resume, which draws the front first. `estimate` gives 4.4 minutes at the pilot's warm times with half a compile and 8
at the admission prices, so with 9 minutes or more left before `"$end"` all of it is admitted. `cells.json` holds each
cell's key, file, sha256, size and milliseconds and the server's pins, never a prompt, and a resume under other pins or
on another server is refused. `index.html` has a section an arm, the pictures compared side by side a seed, in arm 2
each scene's pair beside the kept front, each prompt folded under its picture, and the risks the texts carry: the
retold text's "heavyset", `gym`'s second sample, the pair's two texts. It gives no scores.

```sh
npm run image:figure-test -- dry-run     # steps 0 to 13, then "the figure test's dry run went as expected"
npm run image:figure-test -- estimate    # before the card: 34 cells, expectedMinutes 4.4, pricedMinutes 8
# On the card, after round two's draw, with the server, the tunnel and "$end" as they are:
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/figure-card/card.txt
npm run image:figure-test -- draw --until "$end"    # cell by cell; figures_done with drawn 34 and exit 0
# Then the body test (action-experiment.md#body-test). After the termination, with no card:
npm run image:figure-test -- page    # illustrations/figure-card/index.html, which `draw` also writes after each cell
```

**Not verified without the card**: the times, since the pilot drew no frame with one reference, and all that the
pictures show. `draw` checks `card.txt` against the manifest before it sends anything.

<a id='blind-review'></a>

## Blind review of pictures

These rules already hold in the code and in the pages named; this section only collects them.

- Neither the page a person opens nor the bundle a clean model session reads names a checkpoint. Pictures get names
  that say nothing, the order under the letters is shuffled for every scene and differently for every rater, and the
  key is written beside the output, never inside it. `score` opens the key and counts (`local/blind-review.ts`).
- A rater's name goes into the seed of the shuffle and into the picture names, so two raters never share an order
  and their files cannot be matched by name.
- A scene drawn by one checkpoint only is left out, and so is one whose pictures were drawn on canvases of different
  sizes: a wide picture beside a narrower one tells the rater which run is which. `mixed` counts those. For the same
  reason Qwen's text-to-image frame is 1280x720 like Krea's ([above](#qwen-choice)).
- Only synthetic scenes are drawn for a review, never a reader's story (`local/blind-review.ts`,
  `local/image-batch.ts`).
- Adult content never goes to a hosted API. The owner's two exceptions, both for judging pictures drawn on the
  rented card, are written out in [improve-loop.md](improve-loop.md#acceptance-on-gpu); read them before a picture
  or a sharp text goes to a hosted model.

From step 2 on, a fresh GPT-6 session read each step's pictures; each step says what it was asked.
The identity measurement builds bundles of its own and decides by its gates:
[judging](identity-experiment.md#judging) and [the gates](identity-experiment.md#gates) are the main copy for it.
