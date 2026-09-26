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
- `film`, `graphic` and `watercolor`, with the same change of age as `novel`.

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
short look the frames use now.

Round one of the action measurement drew its fronts from the look ([the sheet](action-experiment.md#the-sheet)). In
`flight` both daughters, 8 and 4 in the seed, came out of the sheet as a "young girl", and their fronts drew adult
women: the sheet's rule allowed only the age words of adults (young adult, middle-aged, elderly). Three of that
sheet's four looks named no skin tone. A look of 15 to 25 words has to serve a frame of up to four people, where every
word of it competes with the action; a portrait holds one person and can take far more.

- The sheet (`SHEET` in `local/illustrate.ts`) writes, for each person, `name`, `details`, `look` and `outfit`, in
  that order. `details` comes before `look` in the schema's properties and in its required list, so that the model
  writes the long description first and compresses it in the same answer, as the variant frame of the action
  measurement relies on `role` and `facing` coming right after `who`.
- `details` is English, 50 to 80 words, without names and without clothes, in this order: sex and age as a word,
  with the words of children (small child, child, teenager) beside those of adults, and never a number; skin tone;
  height and build with their proportions; hair, its colour, length, texture and style; the face, its shape, brows,
  eyes and their colour, nose, lips, facial hair and lines; permanent marks with their place and side. What the story
  names comes from the story, and the rest is invented once, plausibly for the story's world, so that the characters
  differ in silhouette, hair and face.
- `look` stays at 15 to 25 words, compressed from `details`: the same age word, skin tone, build, hair and one or two
  marks. The frames use it as before.
- A portrait is drawn from `details` (`portraitText` in `local/image-portraits.ts`), through the same
  `assemblePrompt`, which cuts out names and ages given as numbers. It now cuts out every name of the sheet, since
  the details of one person may name another. A look the reader wrote wins: the edit drops the details, which describe
  the person the reader's words replace, and a sheet written anew keeps the reader's look without them. A sheet
  without details, as every sheet written before this one is, draws its portraits from the look and is not written
  again for them. A kept portrait records the text it was drawn from in its `look` field, and the card calls it a
  portrait of the earlier look once the person's text differs.
- The frame instruction and the portrait's clothes, style and pose stay as they were, but for one rule, changed the
  same day as the owner agreed: the look the frame writes of a person the sheet does not name takes the sheet's age
  words, children's included, and the skin tone, where it allowed an adult's words only. The identity measurement's
  recipe still draws from the look, as its run pinned it ([portrait recipe](identity-experiment.md#portrait-recipe)).

The sheet had the frames' limit of 900 tokens. A synthetic reply of six people at the top of every word range, counted
by Gemma 4's tokenizer (`local/tokenizer.ts`), takes 1102 tokens as compact JSON and 1225 indented, where the sheet
before this took 450 and 555 at the top of its own ranges. With a quarter more words than the ranges allow it takes
1341 and 1464, and with half more, 1570 and 1693. The details cost about 106 tokens a person, 1.32 tokens a word. So the sheet has a limit of
its own, `SHEET_TOKENS`, 1800 as the variant frame has, and the frame keeps 900. A reply that runs away into newlines
still gets its one retry, and now runs up to twice as long before it. The estimate that lets a description far from
the end of the context skip the server's count (`trusted` in `local/picture.ts`) leaves room for those 1800 tokens
of answer.

Round two of the action measurement draws its fronts from the details, and the new instruction changes its pins
([the sheet](action-experiment.md#the-sheet)).

The bot's style line changed the same day, as the owner agreed: `STYLE` in `local/illustrate.ts`, the `novel` preset,
asks for "Naturalistic facial proportions true to each person's age" where it asked for "Naturalistic adult facial
proportions". It ends every frame, after the looks, and with a child's age word now in the sheet, "adult" there would
have given that child an adult's face in every frame. It changes every frame the bot draws in its own style and round
two's pins; the T probe keeps round one's line, to set its variants beside round one's pictures. The `film`,
`graphic` and `watercolor` presets asked for adult faces or anatomy for the same reason and now ask for anatomy and
proportions true to each person's age (`local/picture-style.ts`); `semi` names no age and stays as the owner approved
it.

The owner decided the same day that a portrait is drawn from the reader's `details` exactly as written, in any
language, with no translation; whether the image model follows a Russian description as closely as the same one in
English is checked at the next rental by the T probe's [language test](action-experiment.md#t-probe-lang).

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
