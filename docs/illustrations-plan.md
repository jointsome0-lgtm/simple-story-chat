# Plan for illustrated scenes (text to image)

2026-09-20 · Opus 5, corrected and measured 2026-09-21 · Fable 5.1 · three images were generated on a hosted API,
no GPU was rented, no code was changed. Markers as in [eval-experiments-plan.md](eval-experiments-plan.md): **[M]**
measured here, **[D]** derived from measured values, **[A]** an assumption that a measurement must close.

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

- **They belong to their scenes** [M, one reader]. The gate, the cart braced by a shield, the bandaged left forearm,
  the blue-hilted dagger in a machine's joint, salt pouring from torn sacks; five people holding a door while one
  kneels at its lock; two women at a monitor showing dancers, the couple in costume in a lit doorway behind them,
  cold screen light against warm hall light. Every element named in a prompt is in its picture but one bystander.
- **One appended sentence held the style** across all three [M]. This is the fix for the defect of step 1.
- **Left and right are lost** [M]: the description puts the bandage on the left wrist and the bracelet on the right,
  the picture puts both on one arm.
- The commander looks like the same person in both battle pictures. With one seed and two samples that is luck
  until shown otherwise [A].

OpenRouter lists Krea 2 as `large` ($0.06 an image), `medium` ($0.03) and `medium-turbo` ($0.015) [M, its pages];
the general `/api/v1/models` list omits image models, which are under `/api/v1/images/models`. Each takes a `seed`
and one reference image. The open weights are `krea/Krea-2-Turbo` and `krea/Krea-2-Raw`: a 26.3 GB transformer in
bf16, an 8.9 GB text encoder and a 0.5 GB VAE [M, HuggingFace file sizes], 35.7 GB together, so a 32 GB card needs
fp8 or the encoder offloaded. Which hosted name the open weights correspond to is not known. Their licence is
`krea-2-community-license` and has not been read.

**On price the owner was right and the first estimate here was wrong.** A second card at $0.52/h pays for itself
against `medium` from 17 pictures an hour and against `medium-turbo` from 35 [D]; one active reader with a picture
per scene is already there. Hosted is for looking, not for running.

## The model, if it gets that far

Krea 2, open weights, released 2026-06-22: a 12.9B diffusion transformer, shipped as `Raw` (undistilled, for
fine-tuning) and `Turbo` (8 steps, about two seconds for a 2K image on consumer hardware) [A — the vendor's
figures, not measured here]. The tester pointed at `Kreamania`, a community fine-tune distributed through CivitAI
and HuggingFace. Any such checkpoint must be pinned the way the language model is pinned in
[gpu/manifest.env](../gpu/manifest.env) — repository, revision, SHA256, size. A community checkpoint on a community
host is exactly the kind of file that changes underneath a project.

## Two constraints that do not bend

**It does not share our card.** The language model holds 22–25 GB of the 32 GB, and the pool floor already fails
threshold 7 (docs/gpu.md). Krea 2 needs roughly 26 GB at bf16 or 13 at fp8 [A]. A second card, not a second process.

**Story text may not go to the tester's machine.** An illustration is made from the text of somebody's scene. The
rule in [AGENTS.md](../AGENTS.md) stands in the other direction already — the tester's own library stays closed even
when his failure is the one being debugged — and funding a card does not make other people's stories his. Two
honest shapes: a rented card we run, or the feature enabled only for his own stories on his own machine. The second
is a clean place to start.

## What must be measured before any of this is believed

1. ~~Do the descriptions read like something worth drawing?~~ Looked at once, above: yes for scenes with action,
   with the style and the runaway to fix. Not yet repeated, and not yet on the deployed build.
2. Does the second call disturb the scenes that follow — the slot, the cache, the wait of the next turn? On a
   rented card, from `scene_request_completed` timings.
3. Does a plain generation, with a per-location seed and one fixed style string, produce a picture that belongs to
   the scene? The cheapest route is the tester's own machine with these synthetic descriptions: no story of a real
   person is involved.
