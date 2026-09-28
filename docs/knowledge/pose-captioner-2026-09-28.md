# Pose captioner, 2026-09-28

Which small open vision model can label a reader's pose pictures on this computer's CPU, once a picture, for pose sets
([telegram-ui.md](../telegram-ui.md#pose-set)): the pose, the side turned to the viewer and the framing, each one label
of a fixed list and nothing else. The question came from the tester through the owner on 2026-09-28: about 80 pose
pictures of one character, unsorted, to be put in as they are. A caption is only what a frame chooses a picture by; the
choice itself is Gemma's, inside the frame description, as [measured the night
before](view-pick-measurements.md#gemma-card-2026-09-28).

<a id='cases'></a>

## What ran

**The pictures.** 218 synthetic pictures (`cases.json`, sha256 `9ec6c276…6d96f`, written by `manifest.py`), all drawn
by our own Qwen graph for the refs stands 1, 3 and 4 (`~/simple-story-chat-runs/2026-09-27/refs-stand`,
`2026-09-28/refs-stand-3`, `refs-stand-4`): 16 fronts and 67 views of five characters, B, H, L, R and T, on a plain
grey backdrop. No cell of those stands is a sharp story's or lies under `sealed/`; the manifest counts them and would
have refused one. Each picture's truth is what its cell asked for, a front standing full length, or a turn in picture
terms (turned three-quarters toward the right of the picture, seen from the side facing its left, from the back, or
sitting turned three-quarters), kept only where the stands' blind GPT-6 Astra judges confirmed it:

- `clean`, 61 pictures: every judge's pass said the turn was as asked (stand 4 was judged twice).
- `partly`, 14: some pass said the turn was there with its angle off. Scored apart.
- `no`, 8: some pass said it was not, or saw more than one person. Left out.

From the clean ones code derived more whose truth follows from the transform, and no one looked at any of them: the
mirror of each of the 33 turned pictures, its side swapped, and two crops of each of the 51 standing ones, to about the
hips (half body) and to the upper chest (head and shoulders), placed by the figure's box on the backdrop. The six crops
of three pictures whose box came out nearly as wide as the picture are scored apart. So the clean set is 190 pictures,
94 of them whole figures (pictures and mirrors): 48 front, 84 three-quarter (43 left, 41 right), 22 profile (8 left,
14 right) and 36 back; 170 standing and 20 sitting; 94 full body, 48 half body and 48 head and shoulders. No picture
walks, lies, kneels or crouches.

**The captioners**, each pinned by revision, its weight file checked against the SHA256 the Hub lists for it, in float32
on this computer's CPU (i5-12400F, 6 cores and 12 threads, 31 GB, torch 2.14.0+cpu, transformers 5.17.0), 6 threads,
one after another. The phrasings were fixed in `labels.py` (sha256 `b12a6cd0…60994`) before any run, and every
captioner answers each axis with one of its labels and nothing else:

| Captioner | Repository at revision | Licence | Size | Asked as |
| --- | --- | --- | --- | --- |
| openjev 0.8B | `AlexWortega/openjev` at `a298f274…`, folder `qwen3.5-0.8b-nli-v2s-long` | MIT | 1.73 GB | an NLI cross-encoder: the picture as the premise ("A picture: <image>"), one statement a label ("The person is turned three-quarters toward the left side of the picture."), the label's log-probability of entailment renormalised over its axis; the picture at about 80K pixels |
| SigLIP 2 so400m | `google/siglip2-so400m-patch14-384` at `e8e48729…` | Apache-2.0 | 4.58 GB | zero-shot: the picture padded to a grey square against two phrases a label, averaged |
| Qwen3.5 0.8B | `Qwen/Qwen3.5-0.8B` at `2fc06364…` | Apache-2.0 | 1.77 GB | a chat model with thinking off: one question with lettered options for each axis, the answer forced to `Pose: <letter>` and so on, each letter read off the logits of the options' letters alone; the picture at about 184K pixels |
| Qwen3.5 2B | `Qwen/Qwen3.5-2B` at `15852e8c…` | Apache-2.0 | 4.57 GB | the same as the 0.8B |

Each picture was also read mirrored, and `flip` adds the mirror's scores to the picture's, the mirror's left and right
swapped back, so that no lean toward one side survives.

<a id='as-they-choose'></a>

## What they chose as they are

The clean pictures, 190, of which 94 whole figures: the pose is scored on those alone, since a crop does not show
whether a person stands. `Turn` is the side without left and right; `group` is the pose set's group
(`local/pose-set.ts` `groupOf`: sitting and walking by the pose, anybody else by the turn), which is what a frame
chooses among.

| Captioner, as it chooses | Pose /94 | Side /190 | Turn /190 | Framing /190 | All three /94 | Group /94 | Front /48 | Three-quarter /84 | Profile /22 | Back /36 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openjev 0.8B | 94 | 116 | 119 | 154 | 40 | 60 | 48 | 20 | 15 | 36 |
| SigLIP 2 so400m | 94 | 95 | 107 | 188 | 32 | 56 | 48 | 7 | 16 | 36 |
| Qwen3.5 0.8B | 86 | 96 | 104 | 105 | 27 | 55 | 48 | 2 | 22 | 32 |
| Qwen3.5 2B | 72 | 114 | 123 | 166 | 21 | 66 | 48 | 17 | 22 | 36 |

Every one of them puts most three-quarter views in front of the viewer: openjev 59 of 84, SigLIP 77, Qwen3.5 2B 49.
Qwen3.5 0.8B puts the rest in profile and takes 8 standing people for sitting or lying; the 2B takes 22 for crouching,
kneeling or lying. SigLIP reads the framing almost perfectly, and openjev puts 35 of the 48 half-body crops elsewhere.
Left and right, where the turn was right: openjev 32 of 35, SigLIP 11 of 23, Qwen3.5 0.8B 16 of 24, the 2B 30 of 39.

<a id='with-a-prior'></a>

## With a prior, on characters it was not fitted on

The captioners rank the three-quarter label far above its place in their first choices, so each side label got a
constant added to its log-score before the choice, one for both three-quarter labels, one for both profiles and one for
the back, the front's none, and each framing label one, the whole figure's none (`calibrate.py`, sha256
`0ff8c4be…7f5a`). The constants are the grid from -6 to 6 by 0.25 that gets the most labels right on four characters
(`accuracy`), or the most of each turn on average (`balanced`, since three-quarter views outnumber profiles four to
one here), and they are scored on the fifth character alone, each in turn: B, H, L, R and T, no picture ever scored by
constants fitted on it. The table has each captioner's best of its four variants (as it is or with the mirror, either
objective) by the group:

| Held out, best variant | Pose /94 | Side /190 | Turn /190 | Framing /190 | All three /94 | Group /94 | Front /48 | Three-quarter /84 | Profile /22 | Back /36 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openjev 0.8B, mirror, balanced | 94 | 155 | 163 | 176 | 83 | 87 | 46 | 62 | 20 | 35 |
| openjev 0.8B, mirror, accuracy | 94 | 142 | 150 | 176 | 77 | 81 | 46 | 63 | 6 | 35 |
| Qwen3.5 0.8B, mirror, accuracy | 89 | 130 | 141 | 164 | 47 | 75 | 46 | 46 | 20 | 29 |
| SigLIP 2 so400m, as it is, accuracy | 94 | 94 | 124 | 188 | 46 | 71 | 21 | 49 | 18 | 36 |
| Qwen3.5 2B, mirror, either | 76 | 142 | 167 | 188 | 42 | 86 | 48 | 69 | 14 | 36 |

Fitted on all five characters, openjev's constants are the same for both objectives: three-quarter 1.25, profile 2.25,
back 0.75, half body 0.5, head and shoulders 0.5. With them the 14 pictures judged only partly turned come out in the
right group 14 times, the right turn 14 times and all three labels 11 times. SigLIP's constants do not carry over: with
them its front falls to 21 of 48 on held-out characters. Qwen3.5 0.8B still takes standing people for sitting. Qwen3.5
2B comes nearest: one whole figure fewer in the right group, the three-quarter turn better (69 of 84 against 62) and the
framing (188 against 176), but the profile worse (14 of 22 against 20) and the pose of 18 standing people wrong, so all
three labels right for 42 whole figures against 83.

<a id='time'></a>

## Time

Median milliseconds a picture on 6 threads, the picture's reading included, with the machine's other work beside it
(the median one-minute load during each run in the last column):

| Captioner | Loading | Plain | Plain, 90th percentile | With the mirror | Load |
| --- | --- | --- | --- | --- | --- |
| openjev 0.8B | 6.5 s | 2210 | 2616 | 4299 | 12.5 |
| SigLIP 2 so400m | 18.0 s | 1472 | 2175 | 2927 | 10.5 |
| Qwen3.5 0.8B | 2.2 s | 2044 | 2802 | 4044 | 9.2 |
| Qwen3.5 2B | 35.2 s | 4282 | 6110 | 8720 | 8.7 |

The most memory each held, measured afterwards by the same runner on the first four pictures (the process's peak
resident size): openjev 0.8B 5.7 GB, SigLIP 2 so400m 4.1 GB, Qwen3.5 0.8B 6.2 GB, Qwen3.5 2B 13.5 GB.

<a id='chosen'></a>

## Chosen

openjev 0.8B, each picture read as it is and mirrored, with the constants fitted on all five characters: the most
pictures in the right group on held-out characters (87 of 94, against 86 for Qwen3.5 2B and 75 and 71 for the others),
all three labels right for 83 whole figures against at most 47, and the right side for 155 of 190 against at most 142,
at about 4.3 s a picture with the mirror, half the 2B's time, and from the smallest download. It ships as
`captioner/caption.py` with its statements and constants pinned; changing one is a new measurement. The 2B, the one
close to it, needs 4.57 GB of weights and 13.5 GB of memory at its peak, against 1.73 GB and 5.7 GB, and it misreads the
pose that the captions a frame chooses by begin with.

It runs beside the bot on this computer's CPU, not on the picture card as `openjev_card.py` would run the 2B and 4B:
the pictures and their captions never leave this computer, a caption is wanted whenever a picture comes and not when a
card is up, no card minute is billed for it, ComfyUI keeps the card's memory, and the bot itself stays without an image
library. A set of 80 costs about five minutes of the CPU once.

**The shipped captioner.** `captioner/caption.py` was run as the bot runs it, with its minimal environment and on four
threads, on all 218 pictures of the measurement by path, one line at a time. Its labels were those the measurement's own
scores give with the same mirror and constants for 215 of the 218; the three that differ are the side of three of the
five pictures whose top two sides were closest (0.0001 to 0.0083 apart in log-score), where four threads add up in
another order than six, and one of them came out wrong where it had been right, two right where they had been wrong. It
answered `unreadable` for a file that is not a picture and for a path that does not exist, and ended when its input did.
With the machine's one-minute load at a median of 4.7, a picture took a median of 3.9 s with its mirror (90th percentile
4.1 s, at most 4.4 s), and the model loaded in 10.9 s. The process held 5.7 GB at its peak, while loading, and 4.0 to
4.4 GB as it captioned, read after each of eight pictures in a run of its own. The bot's own `createPoseCaptioner` then
ran it on six of the pictures in a store of its own, with a weights folder of exactly the six files `captioner/setup.sh`
fetches, whose SHA256 are the ones it pins: six captions in 27 s, the loading included, and five groups formed from
them. Pose and framing were right for all six and the side for four: the full-length front was read as three-quarter
right, and a full-length three-quarter view as front, which then stood for the front group over a true front framed head
and shoulders, since a group's picture is chosen by its stance and framing before its confidence. A group's picture is
only as right as its caption; see the three-quarter limit below.

<a id='limits'></a>

## Limits

- All pictures are our own graph's, of five characters, on a plain grey backdrop; the tester's drawings, in other
  styles and on other grounds, may be read worse, and nothing here says how much.
- Only standing and sitting were drawn, and every sitting picture was turned three-quarters. Walking, lying, kneeling
  and crouching, and the walking group, are unmeasured.
- The three-quarter turn is the weakest label even with the constants: 62 of 84 on held-out characters, most misses
  going to the front. A frame asking for a three-quarter view may then get a front, or find no three-quarter group.
- The constants and the variant were chosen after the raw numbers were seen; the constants are checked on characters
  they were not fitted on, the choice among four variants is not.
- The truth is the stands' prompts as the blind judges confirmed them, one or two passes of one judge model.
- The times are one machine's, with other work beside it, on torch's CPU kernels.

The scripts, rows and logs are in `~/simple-story-chat-runs/2026-09-28/pose-captions/`: `manifest.py` and `cases.json`,
`labels.py`, `fetch.py`, `caption_run.py`, `score.py`, `calibrate.py` and `results/`. The rows hold labels, scores and
times, never a picture.
