# Plan for illustrated scenes (text to image)

2026-09-20 · Opus 5 · a proposal, not a result: no image was generated, no GPU was rented for this, no code was
changed. Markers as in [eval-experiments-plan.md](eval-experiments-plan.md): **[M]** measured here, **[D]** derived
from measured values, **[A]** an assumption that a measurement must close.

The tester asked for it and offered to fund the Vast budget. What he wants first is modest and worth keeping in
mind: to see **how text to image fits in at all**, not to ship a finished visual novel.

## What is proposed

After the scene exists, a description of it goes to an image model, and the picture travels with the scene.

The description comes from the **structured output the scene already uses**, as one more field, placed last in the
schema so the model writes it having written the scene. The tester's own first sketch was a second call after
generation; the arguments against it are below, and they are not the ones first given.

The picture covers the place, the atmosphere and **what people are doing**, by role and action. Not by name.

## Why a second call is not obviously expensive, and what is actually wrong with it

The first version of this note claimed a second call costs thousands of tokens of prefill. That was wrong, and the
owner caught it. `cache_prompt: true` is set for llama.cpp (`local/llama.ts:127`) [M]. A second call built as a
continuation — same system prompt, same memory, same history, the request appended at the end — shares its whole
prefix with the call that just ran, and the scene's own tokens are already in the slot's cache because the slot just
generated them. Only the appended instruction needs prefill, on the order of tens of tokens [D]. The thousands
appear only if the second call carries its own system prompt: then the prefix diverges at the first token and
nothing is reused [D].

What remains against a second call is not tokens:

- It adds a **round trip after the scene is finished**, when the reader is already waiting for the picture.
- It **takes a slot a second time**. The pool holds two or three, and the scheduler counts them (`local/scheduler.ts`).

Both disappear with a field in the existing schema, which is why that is the recommendation.

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

1. Do the descriptions produced as a schema field read like something worth drawing? Text only, no card.
2. Does the extra field cost the scene anything — length, discipline, the memory rules? Measured by the existing
   eval, against the same scenarios.
3. Only then: does a plain generation, with a per-location seed, produce a picture that belongs to the scene?
