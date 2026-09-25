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

## What the reader sees

Settled with the owner 2026-09-21. The tester funds the second card by topping up the vast.ai account, so the card
is rented and run by us and story text stays on our side. The picture comes after the text; what the reader needs
is to know how long. So: a status line under the scene while the picture is made, replaced by the picture; the
seconds from the end of the scene to the picture logged as a non-negative integer, and measured in the rental's
last block together with the wait of the next turn. Hosted `medium-turbo` took 9.5–10.3 s a picture over six
pictures [M]; the description call on our card and `Krea-2-Turbo` fp8 on a second card are not measured. What
happens to a picture still in flight when the reader answers is the owner's to decide; cancelling it is the
proposal.

## The licence, read 2026-09-21

Krea 2 Community License Agreement v.1 of 2026-06-22 and the Acceptable Use Policy it incorporates [M, both read
in full]. Not legal advice.

- **Only `Raw` and `Turbo` are downloadable.** The licence names exactly those two variants. `large` and `medium`
  exist as hosted names only, so a card of ours runs `Turbo` or `Raw`, and a hosted `large` picture says nothing
  certain about what our card would draw.
- **The repositories are gated**: a HuggingFace account has to press "Agree" with a name, an e-mail and a company,
  and the bootstrap needs that account's token. That is the owner's act, not a script's.
- Commercial use is allowed below $1M of yearly revenue. Outputs belong to whoever generated them.
- **A deployer must run content filters** (4.2): "reasonable and appropriate" measures against prohibited output,
  with an image classifier, a moderation API or human review given as examples. Not doing so is a breach, and a
  breach ends the licence at once. A bot that draws from free-form stories is a deployment in this sense.
  Owner's decision 2026-09-21: while the bot is tested by the owner and the tester, each of whom sees his own
  pictures, that human review is the measure, and no classifier is added. It comes back when pictures are made
  for people whose pictures neither of them sees.
- The policy forbids sexual content with minors, intimate images of real people, deception about real people, and
  content "obscene or otherwise objectionable under applicable law". It does not forbid adult content as such. The
  test-ground rule stays as it is: nothing adult goes to a hosted API.
- Distribution of the weights needs the licence text, a "Krea" name prefix and a notice file. We do not distribute;
  the pin in a manifest is a reference, not a copy.
- Krea may end the licence for any reason on 30 days' notice, after which the weights must be deleted. A feature
  built on them can be taken away.

## The model, if it gets that far

Krea 2, open weights, released 2026-06-22: a 12.9B diffusion transformer, shipped as `Raw` (undistilled, for
fine-tuning) and `Turbo` (8 steps, about two seconds for a 2K image on consumer hardware) [A — the vendor's
figures, not measured here]. The tester pointed at `Kreamania`, a community fine-tune distributed through CivitAI
and HuggingFace. Any such checkpoint must be pinned the way the language model is pinned in
[gpu/manifest.env](../gpu/manifest.env) — repository, revision, SHA256, size. A community checkpoint on a community
host is exactly the kind of file that changes underneath a project.

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

It is **opt-in**: `SIMPLE_CHAT_IMAGE_QWEN=true`, 17.28 GB on top of the session's download. Off by default because
[rent-plan.ts](../local/rent-plan.ts) prices an offer's traffic from what a default run pulls, and a comparison
nobody asked for should not be in that number. The bytes and the minutes are in [gpu.md](gpu.md).

**Licence, accepted for the test.** Qwen Research License (the repository's own `license_name: qwen-research`),
non-commercial, read as what it says on the card and not verified clause by clause here [A]. The owner accepted it
in their own words on 2026-09-22, asked whether they take it for as long as only the owner and the tester use the
bot. It is a narrower permission than Krea's, which allows commercial use below $1M: it makes Qwen a comparison
checkpoint rather than a candidate for a bot that earns money, and if this feature ever reaches people beyond the
owner and the tester, Qwen has to be decided again. The opt-in stays a flag of the session
(`SIMPLE_CHAT_IMAGE_QWEN=true`), off by default, because the default download is what a rental is priced by.

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

**The identity frames are 1280x704, and the portraits are upright.** The encode node of the edit graph is at the
template's `resolution: 0`, which keeps each reference at its own size rounded to a multiple of 32 (Python's
`round(720 / 32)` is 22, not 23). A portrait is drawn on the text-to-image graph's latent turned upright, 720x1280,
because a standing figure in a wide frame gets a third of the pixels, and it reaches the encoder at 704x1280. The node
also hands out an empty latent of the first reference's size, with the warning that sampling has to match it because
"any other size shifts the edit", and the template samples from it through a switch whose other branch is a free-size
canvas. That output stays unwired here. The sampler starts from the graph's own `EmptyLatentImage`, so every frame is
1280x704 whatever its references are, and the run pins `canvas` 1280x704 beside `referenceSize` 704x1280.
`applyToWorkflow` would refuse a sampler latent without a width and a height anyway, rather than draw one size and
record another. The pinned model gives each reference a place of its own in the sequence and centres its grid on the
target (`build_sequence` in `comfy/ldm/qwen_image21/model.py`), so a reference of another shape than the canvas is a
case it is built for. Whether an upright portrait keeps a person as well as a wide one would is not verified. The
node's warning reads as one about an edit shifting against its first picture, and a frame keeps nothing of a portrait
in place, but that is a reading of the source, not a measurement. Neither size is Krea's 1280x720, so a Krea frame
and an identity frame are not the same canvas; the blind page compares Krea against the text-to-image graph, which is.

**The identity runbook, 2026-09-25.** One fixed synthetic set,
[examples/identity-set.ts](../examples/identity-set.ts), written before any card is rented: one story, a sheet of six
people and eight frames, each frame drawn from two seeds in three arms, 48 pictures on one canvas. Each arm goes by
what it is, here, in the report and in the bundle keys (`armIs`):

- **A, text only on the edit graph, 1280x704**: the frame's text, looks included, with every reference slot of the
  edit graph taken out. A matched text-only baseline for B and C, and not the bot, which draws a frame on the
  text-to-image graph; the control below prices that graph;
- **B, the same text and the bound portraits**;
- **C, the bound portraits, their looks replaced by the number of their picture**: the whole look of each bound
  person, build included, becomes "the person from image N". Clothes, state and action stay, and no arm's text holds
  a name.

B against A says whether a portrait helps at all; C against B, whether the look can go once the portrait is there.
**C is the owner's question.** The reference is meant to carry the whole figure, so that a frame need not say every
time that a man is huge and grim as a barbarian: does the build come from the portrait alone? No frame of the set
says who is big or small outside the looks, so in C nothing else can carry it.

What the eight frames cover, each on purpose:

- a very muscular, heavy man and a slight, thin woman, and a very tall man beside a very short one. Both pairs appear
  together in one frame and again in swapped order;
- two women who look alike on purpose, together and swapped;
- one, two and four portraits in a frame;
- a ferryman nobody drew a portrait of, standing between the two women, where the binding stops;
- three frames that change clothes, and a new pose and place in every frame.

The second seed is an independent repeat, never a second chance. A cell that failed, an OOM above all, stays failed:
drawing it again until it comes out would be choosing the picture.

**The portraits carry the figure, by the bot's own recipe.** They are drawn on the card first, by the text-to-image
graph, so that the references are the model's own people and not photographs of anybody. The recipe is the one the
bot draws its portraits with: `PORTRAIT_CLOTHES`, `PORTRAIT_STYLE`, `PORTRAIT_ACTION` and `portraitPrompt` in
[image-portraits.ts](../local/image-portraits.ts), which `local/picture.ts` takes them from. Each portrait is:

- one per person, from that person's sheet line and nothing else;
- the whole body in frame, seen from the front, before a plain grey backdrop;
- standing upright facing the viewer, arms relaxed at the sides;
- in a plain close-fitting white tank top, close-fitting dark grey trousers and plain dark shoes, which show the build
  where a robe or a coat would hide it;
- in a neutral reference style of its own, never a story's, on the upright canvas above.

The run pins the recipe, that is the clothes, the style, the action, the canvas and the text-to-image graph's hash,
so a resume under another one is refused. No expression is asked for. A face told to be calm argues with a look line
that says grim, and a permanent bearing is the look's to carry. No frame dresses anybody as the portraits are
dressed, so in B and C every appearance also asks whether the clothes came from the text or from the portrait. A face
reaches the card once, under the hash of its own bytes. The sheet name picks the file and goes no further: the rule
that no name reaches the image model is unchanged. Portraits pass through `stripPngMetadata` on the way up, as every
picture here passes through it on the way down.

**All six portraits, or no smoke.** Before the smoke the tool checks that all six people have a portrait on the
portrait canvas, that none failed, and that every frame binds exactly the people `IDENTITY_BINDING` in the set names,
in that order, which fixes each frame's number of references. A portrait missing or failed ends the measurement
there, incomplete: no portrait is drawn again, retried or chosen among. Without that check the binding below would
quietly give the two look-alikes no face and much of C its look back.

**One binding plan, and slot N is person N of the prompt.** Nothing else says whose face is whose. The encoder's
tokenizer writes its own `<image1> <image2> …` block in front of the prompt. The prompt names people in the order of
`description.people`, and the slots are filled in that order. One plan, `bindingPlan` in
[image-batch.ts](../local/image-batch.ts), says both which portraits a frame sends and whose look arm C drops, so the
two cannot disagree.

The plan stops at the first person of a frame who has no portrait, rather than skipping them. That person may be
somebody off the sheet, a stranger of one scene, or a sheet person the portrait run drew nothing for. Skipping them
would move every later face up a slot and put a portrait against another person's clause. The people after the stop
keep their look in every arm, and `references` in the index counts what was actually bound. C's "image N" is the
slot's number. The swapped frames test whether the model follows that number rather than the order alone.

**One canvas, one set of pins.** All three arms, and the control, are drawn at 1280x704, and one run directory holds
one graph and one canvas. The tool refuses portraits of two sizes and a resume under another canvas, other arms,
another prompts file or other pins. It checks all of that before it writes anything, so a refused resume leaves the
run directory byte for byte as it was. A run is pinned to:

- what the card was verified to run: the ComfyUI revision and the SHA256 of each Qwen file, from the bootstrap's own
  record (the runbook below). There is no checkpoint to choose: every stage draws with the transformer that record
  verified, and the tool refuses a `--checkpoint`;
- the portraits' recipe;
- the graph's cache device and resize, the canvas, and the size a portrait reaches the encoder at;
- the set, the portraits and the seeds;
- what the server says of itself: ComfyUI, PyTorch and the card. A server that does not say all three on
  `/system_stats` is refused, never read as saying nothing.

Smaller portraits and a waist-up crop are each a short run of their own after this one, with their own arm A. They
are never a full factorial of sizes, crops and costumes.

**What each frame records:**

- the reference sizes after the resize, the number of portraits bound, the arm and the seed;
- the time from submit to file, with the upload apart from it, and the encode and sampling phases the websocket
  reports. The server tells a job's start only to a socket that is connected when it starts, so the job is sent once
  the socket is open, two seconds at most. Here a socket that does not open stops the run before the job is sent, as
  a server that refuses a job does, and a resume starts from that cell; the bot's own pictures fall back to the polls
  as before;
- `loaderCacheMiss`: whether any loader node of the job ran rather than being answered from ComfyUI's node cache
  (`execution_cached`). It proves nothing about weights moving to the card, and a model the server offloads and
  brings back inside a job stays inside that job's time;
- `first`: whether the frame is its arm's first. A **warm** frame has no loader cache miss and is not its arm's first;
- the video memory sampled every half second while the job ran, counting torch's reserved pool as occupied: a
  sampled high-water mark, which the true peak can exceed between two samples. Counting the pool narrows that gap
  and does not close it;
- the system RAM, which counts every process on the machine and not ComfyUI alone;
- `partialModelLoadEvents`: the partial loads ComfyUI's own log reports during the job. The cache node on `auto`
  moves what does not fit into RAM rather than failing, so a run without an OOM may still have spilled; a count of 0
  does not prove the models stayed on the card.

The portrait run, and each arm's first frame, are shown apart from the warm frames. The prompt is counted in text
tokens as the encoder reads it, or in characters when `tokenizers/` is missing. C's shorter text is fewer words for
the encoder to read, and no promise of less compute: a reference adds a vision pass and a longer sequence.

**The text-to-image control.** Arm A is not the bot, so the graph the bot draws with is drawn too, on the same
1280x704 canvas: frames 1, 2 and 3 at the first seed, picked before the run by the rule the arms follow, so one first
frame and two after it. It is drawn once, with nothing chosen among, and only after a complete main set: a main set
with a failed cell gets none, and a control the end cut short is not resumed, which the report says. The report gives
it as cost only, outside every gate: its first frame, and its warm median against A's warm frames of the same scenes.
The bot's own 1280x720 is skipped: one more canvas for one more number.

**Judging.** `bundles` writes one bundle per arm and seed under `review/`, and only for a run that has a verdict
(below). A transition compares two frames of one arm, and a session shown the arms side by side would judge the arms.
Bundles and pictures are named by hashes, and the key stays in `keys/`. Every frame is shown with `frame_text`, the
text with all its looks, whichever arm drew it, because arm C's own text would name the arm.

The bundle's `checks.json` is the sheet the gates are counted from:

- **transition**: each sheet person in each pair of frames that follow each other, with `face` and `figure` apart. A
  face kept on a body that lost its build is `figure: no`;
- **picture**: each picture's `action`. Where two people of the sheet share the picture, also `apart` (nobody has
  another's face or figure) and `swap` (nobody took both another's look and clothes);
- **clothes**: each appearance's `clothes`;
- **style**: one answer for the bundle.

Question 5 of TASK.md asks about the style and the people apart, and about the face and the figure apart. Each bundle
goes to a reading session of its own. The session's report ends with its answers as one JSON block, which is saved
as `answers/bundle-N.json` in the run directory for `report` to count. Bundles are built once, because the answers are
read against them.

`image:blind` now deals the arms as contenders of their own. It leaves out any question whose pictures were drawn on
two canvases, and counts them. The identity run is judged by its own bundles all the same.

**The gates, fixed before the paid run.** These are Astra's engineering gates of 2026-09-24, as `report` counts them;
their numbers are one table, `CRITERIA` in [image-identity.ts](../local/image-identity.ts). They are thresholds for
the next decision, not a statistical proof. The 26 transitions of an arm are repeated observations of six people, not
26 independent characters. A transition checks that two frames of one arm agree, and the figure against the look; it
does not compare a face with its portrait. So a pass proves no exact transfer of a face from reference to scene, and
a small experiment promises no identity beyond its own set. Each gate is counted for B and for C against A, over all
the arm's bundles. A `no` and an `unsure` both count against the picture. An arm with an item unanswered is
unscored, never passed.

1. **Recognition.** At least 20 transitions; the set gives 13 per seed, 26 per arm. The face is kept (`face`) in at
   least 90% of them, and the figure (`figure`) in at least 90%. No picture mixes two people up (`apart`).
2. **Against A.** The share of transitions that keep both face and figure is at least 15 points above A's. If A is
   at 90% or above, B cannot pass. C passes then only if all three hold: it is at most 5 points below A, its median
   prompt is shorter than A's, and it has no more action errors than A.
3. **Clothes.** The frames' own changes of clothes are Бран's in frame 1, Ива's in frame 4, and Лада's and Вера's in
   frame 6: eight appearances per arm over the two seeds. At least 90% of them show the clothes the frame gives,
   which on this set means all eight, so 7 of 8 fails. No case where a person's identity and clothes carried over to
   another person (`swap`), and no more action errors than A. Every appearance that differs from the neutral
   portrait, changed by the story or not, is shown beside the gate as a number of its own. It gates nothing and does
   not dilute the explicit changes.
4. **Time.** The frames counted are the arm's warm frames, each matched with A's warm frame of the same scene and
   seed. Over them, the arm's median time is at most 1.5× A's, and its slowest at most 2× A's slowest. The portraits,
   the first frames and the control are shown, not counted here. With no matched frame the gate is unmeasured, and
   so it is with one frame of the arm or of A whose job the socket did not hear from its start: that frame is neither
   warm nor cold, and leaving it out could leave out the slowest.
5. **Memory.** No OOM. Every frame of four references is drawn, sampled while it ran, and leaves at least 2 GiB of
   the card free at its sampled peak. A frame of four that failed or was never sampled fails the gate. RAM and partial
   loads are shown, not gated: what they cost is time, and gate 4 counts time.

**Complete, or no verdict.** An arm passes with all five, and only in a complete run. Complete means all 48 cells
drawn on the right geometry, with no failure, no stop and no error. The right geometry is the file at 1280x704, as
many references as the set binds for its frame (none in A), and each of them at 704x1280. A failed cell stays in the
record as the cell's result, and the set it belongs to is **incomplete**: no gates, no verdict and no bundles,
whatever the surviving cells would say. A run whose smoke or geometry failed gets no verdict either, and neither does
one the end of the rental cut short.

**The smoke** is the frame with one portrait and the frame with four, at the first seed, in all three arms. It passes
only if all of these hold:

- all six cells are drawn and none failed;
- they are on the right geometry;
- they are within the card's memory, by gate 5's rule on its two frames of four;
- they give what gate 4 needs: every picture's phases and loader answer heard on the socket, and a warm frame of B
  and of C matched in A.

Anything less, and the tool refuses the main set in that directory: the measurement ends there and the card is let
go. A fix, such as the cache node off `auto` or smaller portraits, is another run with its own pins.

**One hour, ended on the wall clock.** The card is rented only with the owner's explicit consent and under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). `gpu/rent.mjs --hours 1` sets the guard of
[trial-onstart.sh](../gpu/trial-onstart.sh), which deletes the machine an hour after the box started, whatever is
running, and which nothing extends. The guard can fail, though. It does not start without the container's key, `curl`
and `flock`; it retries a refused delete forever; it takes its own delete's success for the outcome; and without ssh
nobody can tell it "we're done". So the rental also has an end outside the box, below, and the owner is asked for the
whole paid time, from the creation to a destroy read back as done. For one hour that is up to 1 h 20 min 20 s at
the offer's price: the guard's hour, the quarter of an hour the box is given to start before the guard's clock does,
twenty seconds for "we're done" and five minutes for the destroy to be read back. The traffic comes on top.
`gpu/rent.mjs --hours 1 --qwen only` prices each offer that way, by Qwen's files alone, and its dry run prints the
sum as `session`.

The harness takes an absolute end, `--until`: five minutes before the earlier of the guard's deadline and the
operator's own. Nothing is sent to the card after it, and every wait and request of a stage ends there: the socket's
opening, an upload, a poll, a picture's download. A picture that is not in hand with its measurements by then is cut,
even one the card has finished. Its cell stays undrawn and is nobody's failure, and the run stops, incomplete. A job
already submitted gets one minute more, for its id, its stop and the delete of its record, and nothing else does; that
minute ends four minutes before the guard. Once the smoke has timed its frames, no cell is submitted that cannot end
by `--until`. A cell's time is taken from the smoke's slowest frames of one and of four portraits, on a straight line
between them, plus a quarter and three seconds. The main set is priced whole that way before it begins, and so is the
control after it. One that cannot end by `--until` is not begun, and the run ends incomplete rather than half-drawn.
The rental is never extended.

What the hour holds, counted from the guard's start, at the floor the rent filter asks of an offer
(`inet_down` ≥ 300 Mbit/s, [rent-plan.ts](../local/rent-plan.ts)) and at the bootstrap's own floor of 200:

| | minutes at 300 Mbit/s | at 200 Mbit/s | |
|---|---|---|---|
| ssh in, the scripts copied | 2 | 2 | not measured |
| Qwen's three files, 17.28 GB, with `SIMPLE_CHAT_IMAGE_QWEN=only` | 7.7 | 11.5 | |
| torch and its wheels, about 5 GB, on the same link | 2.2 | 3.3 | rent-plan.ts's figure |
| the install: the ComfyUI checkout, pip | - | - | while the files download; any time beyond them is not measured |
| the verification, the server, the tunnel and the card's record | 2 | 2 | not measured |
| 57 cells: 6 portraits, the smoke's 6, the main set's 42, the control's 3 | 41 | 36 | what is left |
| the margin before the guard: a submitted job's minute, the last report, "we're done" | 5 | 5 | `--until` |

That is about 43 seconds a cell at 300 Mbit/s and 38 at 200, with the first loads of the models inside it. The rows
not measured are guesses, not margin: if they run longer, the cells get less. Whether a 25-step frame of four
portraits fits that is the first thing the smoke answers. If it does not, the main set is refused on the smoke's own
numbers. The hour has then bought the smoke's times, which say what a longer rental would need, and that rental is
the owner's decision, never an extension.

**The operator** is the Claude session that runs the hour. It keeps the card from the creation until its destroy is
read back as done. During the hour it only runs and watches: the code and its tests are ready before the rental, so a
failure that needs new code ends the hour. The owner's rules apply as written, the 10-minute idle rule included.

- `rented` prints the instance's ID and `destroyBy`: the guard's hour and the quarter of an hour, on the operator's
  clock, counted from just before the create request that succeeded, so however long its answer took. That is the
  operator's own deadline.
- `npm run gpu:rent -- --show ID` reads `present` at once, or the termination follows. It is the path to the rental
  that needs nothing on the box: the account's key, from `.env.gpu` through `node --env-file`, never printed.
- As soon as ssh answers, and no later than a quarter of an hour after the creation, the guard is checked, in twenty
  seconds at most. The runbook's command prints the guard's deadline only while the guard holds its lock, when
  `flock -n -E 75` exits 75, and on no other outcome. Anything but a whole number of seconds no later than `destroyBy`
  is a failed guard: nothing printed, a flock that failed, a deadline file that says something else, a deadline too
  late. The termination follows at once. A flock without `-E` (util-linux before 2.26) prints nothing: a failed guard.

**The termination** is one procedure for every ending: a whole run, a failed smoke, a set that cannot end in time, a
bootstrap or ssh that failed, a failed guard, and `destroyBy` itself, which starts it whatever the card is doing.

1. "We're done" over ssh, if ssh works, in twenty seconds at most: the guard deletes the machine within ten seconds.
2. `npm run gpu:rent -- --destroy ID`, with the account's key, as soon as step 1 ends or its twenty seconds run out.
   It takes five minutes at most, on its own monotonic clock from before its first read, whatever Vast answers or
   fails to: every request is cut at twenty seconds or at the time left, the answer's body included, every pause at
   ten seconds or at the time left, and nothing is sent after the five minutes. For its first 60 seconds, the guard's,
   it only reads, every ten seconds. After them, while no read says the instance is gone, it deletes it with the
   account's key, and again every half minute.
3. `destroy_confirmed` ends the rental. Anything else, `destroy_unconfirmed`, `destroy_refused` or no answer, goes to
   the owner at once, with the ID, as a deletion not confirmed that may still be billing, never as "the hour is over".

A stop is not a destroy: a stopped instance keeps its disk, and Vast bills the disk. Nor is the destroy's own
`success` a read-back: only a read that says the instance is gone ends the procedure.

The runbook, in its order:

```sh
npm run image:identity -- dry-run    # before renting: all of it against a fake ComfyUI, with made-up answers
npm run image:identity -- set        # the set and the portraits' prompts, in illustrations/identity
SIMPLE_CHAT_RENT_DRY_RUN=1 npm run gpu:rent -- --lane pictures --hours 1 --qwen only    # each offer's `session`
npm run gpu:rent -- --lane pictures --hours 1 --qwen only    # with the owner's consent; `rented` names ID and destroyBy
npm run gpu:rent -- --show ID    # present, at once
destroy_by=DESTROY_BY            # from `rented`
# As soon as ssh answers. The deadline is printed only on flock's 75, the lock the guard holds. Anything but a whole
# number no later than destroy_by is a failed guard: terminate now. The number is checked before any arithmetic.
guard=$(timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast \
  'flock -n -E 75 /root/.simple-chat-trial-guard.lock true; [ $? -eq 75 ] && cat /root/.simple-chat-trial-deadline')
if [[ $guard =~ ^[1-9][0-9]{0,11}$ ]] && (( guard <= destroy_by )); then end=$(( guard - 300 ))    # min(guard, destroy_by) - 300
else end=0; echo 'failed guard: terminate now'; fi    # 0: a past end that every stage refuses
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only bash /workspace/simple-chat/gpu/image-bootstrap.sh'
# The server on the machine's one card, and the tunnel to it, each in a terminal of its own:
ssh -t simple-chat-vast \
  'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 bash /workspace/simple-chat/gpu/image-serve.sh'
bash gpu/tunnel.sh --pictures-only simple-chat-vast
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/identity/card.txt
npm run image:identity -- portraits --until "$end"
npm run image:identity -- draw --smoke --until "$end"
npm run image:identity -- report
npm run image:identity -- draw --until "$end"    # the main set, then the control
npm run image:identity -- report
# The termination, here and after every other ending: we're done, then the destroy whatever the ssh did.
timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'; \
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
npm run image:identity -- bundles    # no card needed from here on
npm run image:identity -- report     # once answers/ holds every bundle
```

`image-verified.txt` is what the bootstrap wrote once every file was verified: the ComfyUI revision it checked out
and each file's SHA256 as computed on the box. Every drawing stage refuses to start without it, or with a record that
differs from the manifest, and pins the run to it. "We're done" writes the present time into the guard's deadline.
The guard reads that file again every ten seconds and takes an earlier time, never a later one. The drawing stages
also take `--comfy`, `--wait`, `--timeout` and `--tokenizers`, whose defaults the runbook keeps. Everything lives in
one directory, `illustrations/identity` unless `--dir` names another:

- `set/` and `portrait-prompts/`, the prompts;
- `card.txt`, the card's record;
- `portraits/` and `references.json`;
- `run/`, the arms, with `review/`, `keys/` and `answers/`;
- `control/`.

The graphs are the repository's `gpu/image-workflow-qwen.json` and `gpu/image-workflow-qwen-edit.json`. They have one
source and one set of names, so the repository's copy and the box's are the same file.

`dry-run` goes through all of it against [fake-comfy.ts](../local/fake-comfy.ts), with a socket that opens late on
purpose and made-up answers. On the way it goes through every refusal the paid run relies on:

- the main set before the smoke;
- two lost portraits, and after them the smoke and a redraw refused;
- a smoke that fails at one portrait;
- a resume with another set, and the run byte for byte unchanged after it;
- a main set that cannot end in time, and a job the end cuts;
- bundles of a run with no verdict.

Its made-up answers put C at 7 of 8 on gate 3 and B at 8 of 8, so its verdict is "B passes, C fails". The fake keeps
the contract the harness talks to, with delays, failures and telemetry set by hand, and models no card.

**Not verified without a card**, in the order it would bite:

- how long the image takes to pull and the box to start, which the quarter of an hour before `destroyBy` allows for;
- that the int8 transformer and the int8 encoder load through `UNETLoader` with `weight_dtype: default` and
  `CLIPLoader` with `type: qwen_image` (read from the pinned source, never run);
- that `SIMPLE_CHAT_IMAGE_QWEN=only` prepares and serves a box. It was checked dry: the bootstrap's `--dry-run`, its
  verification step on a synthetic file, and image-serve.sh on a synthetic box;
- how long one 25-step frame takes, which decides whether 57 cells fit the hour at all;
- whether four references of 704x1280, plus the encoder, plus the transformer stay inside 32 GB, and how much the
  cache node on `auto` spills to RAM;
- whether an upright portrait on a wide canvas keeps a person as well as a wide portrait would;
- what a frame of the text-to-image graph costs against A's, which the control prices;
- whether the websocket messages, `/system_stats` and the log ring are what [fake-comfy.ts](../local/fake-comfy.ts)
  says they are, from the pinned source;
- that the account's key may destroy an instance, which `--destroy` learns only when it is used;
- what Vast answers to a read of a destroyed instance. `--destroy` takes only a 404, or a 200 whose record is null,
  for gone, so any other answer ends as a deletion not confirmed and goes to the owner. The fake API of
  [rent-plan.test.ts](../local/rent-plan.test.ts) answers both ways, and a Vast that answers neither would raise a
  false alarm, never a false all-clear.

The fake's numbers are made up and say nothing about the card.

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

## What shipped on 2026-09-22

The feature is in the bot, off by default. `local/illustrate.ts` holds the description step the probe and the bot
now share — the two schemas, the two instructions, the name and age stripping, and `assemblePrompt`; `local/picture.ts`
runs one picture, `local/image-batch.ts` draws it on the card, `local/telegram.ts` gained `sendPhoto` (multipart) and
`deleteMessage`, and `local/config.ts` reads the settings. The flow: the scene is saved and sent, a status line goes
up under it, the character sheet is written once per story and the frame of this scene after it — both in one
scheduler turn that shares the scene's prefix, on the language model's card, holding its GPU no longer than a job
would — then the prompt is assembled in code, ComfyUI draws it over the loopback tunnel, the PNG is stripped of its
text chunks, the photo replaces the status line, and one `picture` row records the outcome, the whole seconds the
reader waited and three counts. A failure or a card that is busy leaves the story exactly as it was.

The six settings are `SIMPLE_CHAT_IMAGE_URL`, `_WORKFLOW`, `_CHECKPOINT`, `_USERS`, `_STYLE` and `_WAIT_SECONDS`,
documented row by row in [setup.md](setup.md) and, with the reasons, above `imageConfig` in `local/config.ts`.
Without the URL there is no second call, no status line and no picture; `_USERS` is empty by default, so nobody is
drawn until an ID is written there, and every ID must also be on the access list. The URL must be loopback and must
not be the language model's own server.

Decisions the plan left open, taken here. The status line is a message of its own, deleted once the photo is there
and rewritten to one line only when the picture really failed — a reader who has moved on gets no apology. The photo
is sent as a reply to its own scene, with no caption. The character sheet is stored once per story beside its memory
and reused by every later frame, which is what kept a person recognisable in step 6. The seed is derived from the
story id, so one story keeps one visual family and a redraw repeats. Sheet and frame run in one turn with the
prefix shared, so the server pays for the appended instruction alone and the reader's own next scene ends that turn.
A picture in flight is stopped by the reader's next message and by `/cancel`; moving around the menus does not stop
it, and no cancel button is offered, because by then the job lock is already clear. A workflow node that saves its
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

## Picture styles and samples (2026-09-24)

A reader chooses the style of their pictures, keeps a library of their own, and asks for a sample on request only; the
screens are in [telegram-ui.md](telegram-ui.md#picture-styles). The style stays what this plan made it in step 1: the
last sentence of the prompt, never seen by the describing model. `local/picture-style.ts` holds the presets:
- `semi`, the line the owner approved on 2026-09-23;
- `novel`, the `STYLE` the six steps were measured with;
- `film`, `graphic` and `watercolor`.

The same file keeps the rules for a reader's own line: 400 characters under a name of 40, at most 10 in a library.
The line ends the prompt as written. Until 2026-09-24 the bot followed it with a tail of its own: natural proportions
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

## Pictures go with their scenes (2026-09-24)

Deleting a seed or a branch used to leave the pictures of its scenes in the chat. Now every photo the bot sends — a
scene's own picture and every sample, the all-styles batch included — is recorded in the reader's library as
`sentPictures`: story, scene, message id and the time it was sent (`recordPicture` in `lib/library.ts`). Telegram
lets a bot delete its own message for 48 hours only, so every write drops the older entries, and the newest 1000 are
kept at most, because the library is read and written whole on every update.

After `remove-seed` or `remove-branch`, `forgetLostPictures` takes the pictures whose story or scene is gone out of
the list. Once the deletion screen is out, `removeAll` in `local/telegram.ts` deletes them with `deleteMessages`, 100
to a call. A call that fails is tried message by message with `deleteMessage`: a message Telegram refuses (400) costs
only itself, and any other failure — the network, the rate limit, a chat closed to the bot — ends the attempt. The
reader is told nothing, and the removal runs beside the next updates, so the deletion screen neither waits for it nor
changes. A deleted branch takes only the pictures of the scenes that no other branch has.

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

A sheet written before this has clothes inside `look` and no `outfit`. It is written once more at the next picture of
that story, from the history as it stands. The `picture_sheet_written` row then carries `sheetRewritten: true`, and
every `picture` row counts in `clothesChanged` the people of the sheet dressed otherwise than in the picture before.
Nothing of the clothes is logged. How well the model notices a change of clothes that happened several scenes back,
or one that the memory of a compacted story no longer mentions, is not measured yet; the carried line is there so
that such a change is lost only once and not undone later.

## The prompt under the picture (2026-09-24)

The tester asked to see the prompt of each picture and how long it is, to tune a style line against it. Every photo,
the scene's own and every sample, now gets a reply right after it: a rich message folded to one line that gives the
prompt's size, which opens to the prompt as plain text that wraps on a phone (`foldedPrompt`, docs/telegram-ui.md). The prompt goes to
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

## A variant from the reader's own prompt (2026-09-24)

The owner asked for a way to edit the prompt of the picture after a scene, for tests. The note under a scene's own
picture now has a button that asks for a whole prompt: the reader copies the prompt from the note, edits it and sends
it, and the bot draws it as it came. Nothing is assembled, no name or age is cut out, no style line is added. The
screens are in [telegram-ui.md](telegram-ui.md#picture-styles).

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

The recipe pins the request and not the card: the graph with the file names in it, the checkpoint's name, the seed,
the size and the sampler settings. The card's software, and weights replaced under the same file name, are not in it,
and after a change to either the same recipe can draw a different picture.

The variant goes under the same scene as a photo of its own. The note under it counts the tokens of that prompt and
gives no style share, which nobody knows for a prompt written whole. It was drawn by the scene's recipe, so its note
has the same button, and it leaves the chat with the scene. The reader's permission, the scene and its recipe are
checked when the button is pressed, when the prompt arrives, before the drawing and before the photo goes out. A
variant asks the language model nothing and holds none of its card, and it changes nothing of the story: not the
sheet, the clothes or the frame kept for samples. The reader's next move stops it, and a failure is told once and
never tried again. The row is `picture_variant`, with `edited: true` beside the counts `picture` has and no word of
the prompt. The bot keeps the prompt in neither its library nor its technical logs, not even while it waits for it.
Telegram keeps the reader's message and the note under the variant, and the card holds the job as long as it holds
any picture's ([gpu.md](gpu.md#what-the-card-keeps-of-a-picture)). A prompt may have 4000 characters
(`PROMPT_CHARS` in `local/picture-style.ts`): at five characters for every escaped `&`, the note still fits the 32768
of a rich message.
