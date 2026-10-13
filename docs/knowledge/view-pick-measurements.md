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

<a id='gemma-card-2026-09-28'></a>

## Gemma inside the frame description, on our card, 2026-09-28

**What ran.** The same 80 people in 62 frames (`cases.json`, sha256 `5a9e1c09…`), each frame twice, from 23:11 to
00:19 UTC. The bot's own frame request (`frameRequest` in local/illustrate.ts at 189918e) carried one more field,
`view`, in each person of `people`, and a rule after the frame's instruction that lists each person's views. The model
was the card's own, gemma-4-31b-heretic-nvfp4 on vLLM 0.30.0 with xgrammar (simple-serving 940471a, MTP 3), asked as
`internal` work beside the live tester, with 1000 output tokens (the frame's 900 and 100 more) and one attempt a call.
The scripts and their rows are `gemma_card.mts`, `view_variants.mts` and `view_position.mts` in
`~/simple-story-chat-runs/2026-09-28/openjev/`; the rows hold numbers and picks, never an answer.

**The runaway.** A call that did not parse had run its JSON into whitespace outside the strings up to the output
limit, in runs of 1082 to 25421 characters. Without `view` the bot's frame request parsed 124 of 124 on the same
frames (median 244 output tokens, at most 345), and POV's four fields, `viewer_in_scene` first and the rest after
`people`, parsed 40 of 40 on the POV stand's frames the same night.

| `view`, and where in the person | Calls unparsed | Frames with one | People right, of those parsed |
| --- | --- | --- | --- |
| enum of the frame's captions, in «», last | 53 of 124, then 42 of 124 | 30, then 32 of 62 | 99 of 102, then 110 of 113 |
| a free string, captions in «», last | 53 of 124 | 32 | 100 of 103 |
| enum, captions in JSON quotes, last | 48 of 124 | 29 | 104 of 109 |
| a free string, JSON quotes, last | 50 of 124 | 33 | 102 of 103 |
| the view's number in a list, last | 12 of 124 | 10 | 143 of 148 |
| enum, right after `who` | 0 of 124 | 0 | 154 of 160 |
| the view's number, right after `who` | 0 of 124 | 0 | 155 of 160 |

In the second run of the enum placed last, each of the 42 runaways began right after the `action` value, 24 at its
closing quote and 18 after the comma that follows it. There the grammar asks for one more key after what the model
takes for the person's last. The quotes around the captions made no difference. Placed right after `who`, the field
cost nothing measurable: a median of 238 and 246 output tokens and 2.4 and 2.8 s a call.

**The picks with the field right after `who`**, per person over both passes: all 96 and 97%, the hard 104 and 106 of
110, the plain 50 and 49 of 50, free captions 46 of 46, back to the viewer 28 of 28, lying 18 of 18, mirror 12 of 12,
partly hidden 16 of 16, Russian captions 8 of 8, and seated in profile 12 and 14 of 18, the one kind it misses. On the
same cases openjev got 63 or 65 of 80 and the keywords 61. `gemma_card.mts`, the first run (enum last, with the bot's
one retry), lost 19 of 62 frames on both attempts and had 58 of 80 people right counting those, and the listed order of
the views moved no pick in 15 frames on three shuffles.

**What it means.** A field added to the frame is not to be the last key of a person: right after `who`, or at the top
level as POV's are, it parsed every time here. With it there, Gemma picks the view inside the description it writes
anyway, with no call of its own, and better than openjev on these cases.

**Limits.** One model on one card and one grammar backend. The rule sits after the frame's instruction as these
scripts put it, not where the bot would. The actions name the side turned to the viewer, as in the openjev run. The
right picks are the cases' author's, checked blind by one Astra session. The calls ran beside the live tester and the
night's other work, so the times are loose.

<a id='jeff-cpu-2026-09-29'></a>

## Jeff 0.8B and 2B on a CPU, 2026-09-29

**What ran.** The same 80 people in 62 frames (`cases.json`, sha256 `5a9e1c09…3978ec`), with the state openjev got,
the person's canonical English action, and their captions as the options, free and Russian ones as they are. Jeff
(`firelex/jeff` at `2c1bfce2…`, MIT), a zero-shot classifier that gives each option a calibrated probability from one
forward pass, ran with Jeff-Qwen3.5-0.8B (`mstrasser/Jeff-Qwen3.5-0.8B` at `d66458d5…`, `model.safetensors` sha256
`94ff26e4…`) and Jeff-Qwen3.5-2B (`mstrasser/Jeff-Qwen3.5-2B` at `30824caa…`, sha256 `a5b0fb73…`), both Apache 2.0,
on the i5-12400F in float32 on 4 threads at nice 19, beside the live bots. Each request was the body of Jeff's
`POST /v1/systemone`, validated and answered by its server's own code with the checkpoint's fitted temperature; ten
sent to a running `jeff-serve` gave the same picks and probabilities. Two phrasings were fixed before the run: one
`choice` question with openjev's question as its instructions and the captions as its options (`choice`), and one
yes/no question per caption, openjev's NLI hypothesis put as a question, P(yes) normalised over the captions (`noul`).
The 2B ran `choice` alone. Each person was asked in the listed order and in the same three shuffled orders. The
scripts, the rows (numbers and picks) and the pins are in `~/simple-story-chat-runs/2026-09-29/jeff/`.

| | All 80 | Hard 55 | Plain 25 | Free captions 23 | Moved when shuffled | Time per pick | Right picks over the runner-up |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Jeff 0.8B, `choice` | 72 | 47 | 25 | 20 | 2 of 80 | 0.76 s median | 0.886 median |
| Jeff 0.8B, `noul` | 70 | 47 | 23 | 20 | 0 of 80 | 2.91 s median | 0.210 median |
| Jeff 2B, `choice` | 73 | 49 | 24 | 21 | 2 of 80 | 1.64 s median | 0.928 median |
| openjev, `decide` | 63 | 47 | 16 | 22 | 0 of 80, one shuffle | 1.87 s median | 0.017 median |
| openjev, `nli` | 65 | 46 | 19 | 21 | 0 of 80, one shuffle | 0.96 s median | 0.132 median |
| keywords | 61 | 38 | 23 | 15 | 5 of 80, one shuffle | 0.14 ms | |
| Gemma, `view` after `who`, each person twice a pass | 154 and 155 of 160 | 104 and 106 of 110 | 50 and 49 of 50 | 46 of 46 | none in 15 frames, three shuffles | no call of its own | |

The openjev and keyword rows are [those of 2026-09-28](#openjev-cpu-2026-09-28), scored again by this run's script
from their own files; Gemma's are the two passes with `view` right after `who` in [the card run](#gemma-card-2026-09-28).

**What it showed.**

- `choice` is right on 72 (0.8B) and 73 (2B) of 80, 90 and 91%, above openjev and the keywords and below Gemma
  inside the frame description (96 and 97%). The 0.8B's whole gain over openjev is in the plain cases, 25 of 25
  against 16 and 19, where openjev mistook the side turned to the viewer within one pose; on the hard cases it only
  matches openjev, 47 of 55, and the 2B reaches 49.
- The two sizes pick alike for 75 of the 80 and miss the same 6: the mirror, riding taken for walking, face down for
  «lying on back», a woman kneeling «facing the viewer» for «full length, facing camera», Russian «на коленях», and a
  woman «behind the bar» for a back view. Most follow a word of the action into a caption that shares it. The 2B
  mends two of the 0.8B's, «profile pic», an avatar, taken for a side view, and a woman on her side with her back to
  the viewer taken for «lying on back», and swaps the screen side of one three-quarter woman. Neither loses on
  framing.
- `noul` (0.8B) loses 10: «behind» read as a back view in three of the 8 partly hidden, the screen side of both
  three-quarter people in one frame swapped, the mirror, «profile pic», riding, a seated man taken for a close-up and
  a hiker seen from behind for a gym mirror selfie. It says yes to a wrong caption for 38 of the 80, so only the
  comparison between captions picks.
- The order moved 2 of 80 `choice` picks in each size, all at probabilities under 0.51, and every shuffled order was
  right on 72 (0.8B) and on 73 or 74 (2B); the right view was found as often listed first as last. `noul` asks each
  caption alone and moved nothing (the largest change was 1.9e-6).
- `choice`'s probability tracks its accuracy. Picks at 0.9 or more were right 44 of 45 times for the 0.8B and 55 of
  56 for the 2B, from 0.7 to 0.9 18 of 21 and 15 of 17, below 0.7 10 of 14 and 3 of 7. A wrong pick can still be sure
  of itself: «profile pic» at 0.95 (0.8B), riding as walking at 0.92 (2B), the back view behind the bar at 0.90 and
  0.86.
- A `choice` call took 0.76 s (0.8B) and 1.64 s (2B) on 4 threads, about 200 input tokens, and barely grows with the
  options (0.75 and 1.61 s at 5, 0.83 and 1.75 s at 8); `noul` takes one pass per caption, 2.91 s for the median of 5
  and 5.07 s at 8. The 0.8B's run, both phrasings in four orders, took 22 minutes, 1.45 CPU-hours and at most
  5.3 GiB of memory; the 2B's `choice` 9.5 minutes, 0.59 CPU-hours and at most 12.9 GiB.

**What it means.** Jeff's `choice` is the best separate pick measured on these cases, under a second on a CPU with
the 0.8B and with a probability that says when to trust it, but neither size reaches Gemma's pick inside the frame
description, which needs no call of its own: 90 and 91% against 96 and 97%, the gap in the hard cases. The 2B gains
one person on the 0.8B for twice the time. So Jeff is not served on the picture card, as the owner and the main session
agreed before the run, and Gemma keeps the pick.

**Limits.** The actions name the side turned to the viewer, which the bot's frame description need not do, as in both
earlier runs. At most 8 options here: the released models take at most 26 in one `choice` question, so a larger set of
pictures needs a shortlist or `noul`, whose time grows with the captions. Jeff's card says English and text only; 4
people have Russian captions. The 2B ran one phrasing. The times are one machine's CPU with other work beside it, on
torch's reference kernels for Qwen3.5. The right picks are the cases' author's, checked blind by one Astra session.
