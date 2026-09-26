# Action measurements

The rounds of [the action measurement](../action-experiment.md), one dated section each: when a round ran, on what,
what it counted, and what the next round changed because of it. A new round gets a section of its own instead of an
edit to an old one. The protocol in force is in [action-experiment.md](../action-experiment.md).

A round's files stay on the owner's machine in the gitignored `illustrations/action-N/`, where the runbook moves them
whole before the next round begins ([runbook](../action-experiment.md#runbook)). Each number below names the file it
comes from. `report.md` is the report the harness writes for the owner, in Russian; `report.json` gives its numbers
unrounded. The sharp scenes appear here only as `report.md` counts them.

<a id='round-one-2026-09-26'></a>

## Round one, 2026-09-25/26

**When.** `texts.json` records the texts' start at 20:35 and their end at 21:50 Moscow time on 2026-09-25. By the
files' times, `checklists.json` was last written at 03:19 on 2026-09-26 and the first picture card's `card.txt` at
03:30. That card closed both ssh sessions at 04:29 (01:29 UTC), and a second card drew the rest of seed 7
([a dropped connection](../action-experiment.md#dropped-connection)). `draw.json` was last written at 05:28 and
`report.md` at 05:36.

**Configuration.**

- The set: 18 stories, 13 clean and 5 sharp (`report.md`), with up to six people in a moment. The set and the
  protocol are those of commit 7e7de76 ([four](../action-experiment.md#four)).
- The texts: route A, `gemma-4-31b-heretic-nvfp4`, simple-serving's NVFP4 conversion of the heretic (`report.md`),
  on vLLM 0.30.0 with a context of 65536 and temperature 0.8 (`texts.json`). They were written on the Spanish text
  card, and the five sheets asked again on the third ([the cards](gpu-measurements.md#text-cards-2026-09-25),
  [the third](gpu-measurements.md#text-card-3-2026-09-25)).
- The pictures: ComfyUI 73c9bad4 with the model `qwen_image_2.1_int8_convrot` (sha256 cb74113c…), the text encoder
  `qwen3vl_8b_int8_convrot` (8bfd0f6e…) and the VAE `qwen_image_2.1_vae_bf16` (bb21f747…), as `card.txt` names
  them. References reached the encoder at 352x640 (the pins in `judging.json`). Neither `report.md` nor `card.txt`
  names the picture cards' hosts or prices.
- Seeds: 7 was drawn whole. Seed 11 was never submitted, since after the second card's setup it no longer fit.
- The judges: `gpt-6-astra` at high effort, and `gpt-6-sol` for a sharp report without a valid answers block
  (`report.md`).

**Targets.** 5 of the 18 scenes reached their target: `gulliver` alone of the 13 clean ones, and 4 of the 5 sharp
(`report.md`). Of the 12 clean misses, 7 missed only on the contact and 5 missed the moment itself
([loosened](../action-experiment.md#loosened)). The clean checklists named 59 participants, 50 of them bound to a
portrait: four scenes bound six people, four bound four, and five bound one to three. They held 23 essential
relations, and five clean scenes (`jellyfish`, `cheer`, `tango`, `rescue`, `twister`) held none. So 12 scenes count
in the contact scores, 8 of them clean, and 11 where A or A+ is compared (`checklists.json`, `report.md`).

**The arms at seed 7** (`report.md`). Contacts, gazes and faces, clothes, scale, looks and identity are points, the
mean over the scenes where the score applies. All contacts, complete, mix-ups and anatomy count pictures. Identity
counted a bound person only where both the face and the build matched the front; round two counts the silhouette
([the silhouette](../action-experiment.md#silhouette)).

| Arm | Scenes | Contacts | All contacts | Gazes, faces | Clothes | Scale | Complete | Mix-ups | Anatomy | Looks | Identity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 17 | 42 | 3 | 34 | 74 | 79 | 10 | 7 | 3 | 81 | 25 |
| A+ | 17 | 52 | 3 | 44 | 66 | 64 | 14 | 6 | 1 | 79 | 32 |
| L | 18 | 36 | 2 | 23 | 61 | 43 | 5 | 12 | 4 | 3 | 1 |
| C | 18 | 35 | 2 | 39 | 70 | 64 | 13 | 10 | 2 | 60 | 34 |
| V | 12 | 24 | 0 | 51 | 55 | 50 | 8 | 7 | 1 | 53 | 27 |
| T | 18 | 36 | 2 | 23 | 61 | 43 | 5 | 12 | 4 | 3 | 1 |

**The gates at seed 7** (`report.md`, with the unrounded values of `report.json`). All five fail over all the scenes
and over the clean ones alone. Over the 5 scenes that reached their target they are inconclusive, and at seed 11,
which has no pictures, too.

1. A+ against A, 17 scenes: fails on scale alone, 14 points lower over 7 scenes, all of it from `rescue`, where A+
   lost 100. Its contacts were 10.45 points higher, against the 10 asked, and 52% against the floor of 50.
2. C against A+, 17 scenes: contacts 18 points lower [-34; -6] where 10 higher was asked, 2 fewer complete pictures,
   3 more with a mix-up, and contacts of 34%.
3. C against A+ on the portraits: identity 1 point lower where 15 higher was asked, looks 22 lower where 5 was
   allowed, and the same losses of contacts, complete pictures and mix-ups.
4. V against C, over the 12 scenes where V was drawn, 8 of them clean: contacts and identity both 14 points lower,
   so neither branch passes; 2 fewer complete pictures, clothes 10.4 lower and scale 20 lower. 28 of the 30 views
   were right.
5. T against L, 18 scenes: identity level where 15 higher was asked, and 33 below C's where 5 was allowed; contacts
   of 36%. T kept every one of L's shown essential relations, which `report.md` prints as 1 where it means 100%.

**T against L** (`report.md`). T's row is L's. Every difference between them is 0 with the interval [0; 0] and every
scene level: contacts over 12 scenes, gazes and faces over 15, clothes 16, scale 7, looks 18 and identity 17.
Against C, T's looks were 56 points lower and its identity 33. What round one's T pictures show, and the probe
that draws nine variants from them, are in [the T probe](../action-experiment.md#t-probe).

**Identity and the portraits** (`report.md`). C's identity was 1 point below A+'s, whose pictures had no portraits
([-9; 7], level in 11 of 16 scenes). L was 30 below A+, V 14 below C and T 33 below C. The text session found 58 of
the 70 fronts matching their line of the sheet, 28 of the 30 views the same person turned as asked, and `facing`
fitting the moment and the shot for 51 of 70 people. Of the checklists' 71 relations, A's prompts stated 33 and A+'s
45.

**Delivered** (`report.md`). Seed 7 is complete. L, C and T drew 18 of 18. A and A+ drew 17, each losing one cell to
the drop (`image_failed` and `comfy_socket_unavailable`). V drew 12: in the other 6 no bound person needed a view,
and C's picture stood for V. No sharp scene was left without a judge's answer.

**Times** (`report.md`). The median and the slowest of the warm frames, with the frames counted; T's time includes
its L's. The first picture with portraits includes the fronts and views its scene needed.

| Arm | Warm frames | First picture with portraits |
| --- | --- | --- |
| A, A+ and L | 16 s / 17 s, 16 frames each | |
| C | 18 s / 21 s, 17 | 82 s / 133 s, 18 |
| V | 19 s / 20 s, 11 | 131 s / 198 s, 12 |
| T | 38 s / 74 s, 17 | 100 s / 187 s, 18 |

The 70 fronts took 15 s at the median and 31 s at the slowest, the 30 views 17 s and 19 s.

**The texts** (`report.md`, `texts.json`). 100 calls with no retry, 10 checks of the gateway and 64 counts before a
send, 174 requests in all. The 100 calls include the five sheets that came back empty under the gateway's
whitespace ban and were asked again ([again](../action-experiment.md#again)). Over the 13 clean stories the final
sheets took 68 to 367 output tokens and the bot's frames 223 to 476, both under the bot's limit of 900, and the
variants 244 to 721 of their 1800. Round two's sheet, with the details, has 1800 of its own
([portrait details](../illustrations-plan.md#portrait-details)).

**The judges** (`judging.json`, `report.md`). 76 sessions: 18 checklists, 18 of the text and the portraits, 18 of
the pictures, 4 repeats and 18 of identity, in 81 attempts. Every kind answered at its first attempt but identity,
whose task gave no valid answers block in 6 of its 23 attempts. `lineout`'s identity session gave none twice, so
`lineout` has no identity score. The repeats of four clean scenes agreed on 98 of 99 participants, 73 of 86
relations, 78 of 83 faces and 77 of 99 looks, and would have changed no verdict. The directory also keeps
`judging.json` as it was before two resets, `judging.before-401-reset.json` (01:52) and
`judging.before-outage-reset.json` (02:02), and the sessions of the outage in `sessions-outage-2026-09-26` (02:06),
all three older than `checklists.json` by their times. The stored `judging.json` shows neither: each of its attempts
is `ok` or without a valid block. This page did not read the two copies.

**What round two changed because of it.**

- 12 of the 13 clean scenes missed their target, 7 of them on the contact alone: the contact is now judged in
  substance, by any part of the body ([loosened](../action-experiment.md#loosened)), and the variant asks for the
  participants' physical interaction rather than their hands ([the variant](../action-experiment.md#variant),
  change 9).
- Moments held up to six people, where the bot's frame holds four: after seed 7 the owner cut every scene to four,
  a choice rather than a finding ([four](../action-experiment.md#four)). Eight clean scenes of one to three people
  join the set, so that each count from one to four has at least four scenes
  ([the set](../action-experiment.md#the-set)), and a checklist counts a touch of one's own body, of a thing, and a
  reflection ([one](../action-experiment.md#one)).
- The sheet gave ages in words made for adults, and the fronts of `flight`'s two daughters showed adult women: the
  sheet writes each person's details first, the fronts are drawn from them, and the style line asks for faces true to
  each person's age ([the sheet](../action-experiment.md#the-sheet)). The text session checks each front against the
  details ([judging](../action-experiment.md#judging)).
- The demon's C wore his portrait's tank top: the variant names what a participant leaves bare
  ([the variant](../action-experiment.md#variant), change 8), and the T probe's card tries a dark grey suit for the
  portraits ([the clothing test](../action-experiment.md#t-probe-suit)).
- T gave L's picture back: T is drawn as it was, and [the T probe](../action-experiment.md#t-probe) draws nine
  variants of it on a card of its own.
- Identity asked for the face and the build together: it is counted by the silhouette, as the owner decided, with the
  face reported beside it ([the silhouette](../action-experiment.md#silhouette)).
- The drop stopped the stage and cost seed 11, and between two jobs the card stood idle about 4.5 s: a drawing stage
  rides out a short drop ([a dropped connection](../action-experiment.md#dropped-connection)) and keeps one socket
  ([one socket](../action-experiment.md#one-socket)), whose saving [the pilot](../action-experiment.md#pilot)
  measures.
