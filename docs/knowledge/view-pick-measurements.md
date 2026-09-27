# View-pick measurements

Dated measurements of how a frame could choose, for each person, the kept reference view that best matches how the
frame shows them: one of the standard poses (lib/library.ts `POSES`) or a reader's own picture. A new measurement gets
a section of its own instead of an edit to an old one. Nothing here is built into the bot, which so far keeps the front
alone and so has nothing to choose.

<a id='openjev-cpu-2026-09-28'></a>

## openjev 0.8B on a CPU against keywords, 2026-09-28

**What ran.** 80 synthetic people in 62 frames (`cases.json`, sha256 `5a9e1c09…3978ec`), each with a canonical English
action that names the pose, the side turned to the viewer and the framing, and 4 to 8 captions of kept views. 55 are
hard: back to the viewer 14, free captions 23 (file names, a reader's words, Russian), lying 9, mirror 6, partly hidden
8, seated in profile 9, with tags overlapping. The right picks were made by construction and checked blind by one GPT-6
Astra session (gpt-6-astra at high, read-only), which agreed on 80 of 80 and called one unclear, a mirror selfie.
openjev (`AlexWortega/openjev` at `a298f274…`, MIT; `qwen3.5-0.8b-nli-v2s-long`, sha256 `cf6d62a3…`) ran on an
i5-12400F in float32 with two phrasings fixed before the run: its own typed decision (`decide`) and one NLI hypothesis
per caption (`nli`). The keywords were written by the same agent as the cases, before any run. Gemma's pick inside the
frame description did not run: hosted Gemma was ruled out that night.

| | All 80 | Hard 55 | Plain 25 | Free captions 23 | Moved when shuffled | Time per pick |
| --- | --- | --- | --- | --- | --- | --- |
| openjev, `decide` | 63 | 47 | 16 | 22 | 0 of 80 | 1.87 s median |
| openjev, `nli` | 65 | 46 | 19 | 21 | 0 of 80 | 0.96 s median |
| keywords | 61 | 38 | 23 | 15 | 5 of 80 (ties) | 0.14 ms |

**What it showed.**

- openjev is weakest where the standard poses differ: the side turned to the viewer among captions of one pose
  (three-quarter taken for front or profile, profile for three-quarter), and kneeling against crouching. The right
  picks of `decide` led the runner-up by a median of 0.017 in probability, those of `nli` by 0.132.
- It is strongest on free captions, 22 of 23 against the keywords' 15, and `decide` placed all 8 partly hidden people.
- The order of the views cannot move its pick: it scores each caption alone (the largest change was 1.3e-6).
- The keywords lose a caption without a pose word («back») to a standing caption turned the wrong way, and free
  captions without their words.

**Limits.** The actions name the side turned to the viewer, which the bot's frame description need not do. The
keywords know the cases' words. The times are one machine's CPU, with other work beside it, on torch's reference
kernels. One blind labeller.

**Not yet run.** Gemma's pick as one more field of the frame description, on a text card through the bot's background
queue (`gemma_card.mts`: 92 calls, 107 with a repeat of the listed order), and the 2B and 4B beside ComfyUI on a
picture card (`openjev_card.py`, which takes its weights off the card whenever ComfyUI has a job, and falls back to the
card's CPU when a size does not fit). Both are ready in `~/simple-story-chat-runs/2026-09-28/openjev/`, with the cases,
the rows and the commands.
