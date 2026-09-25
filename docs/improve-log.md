# Improvement log

One line per step of the loop in [improve-loop.md](improve-loop.md), or measurement beside it, newest first: the
date, the status, the question or the change linked to its full entry in [improve-runs.md](knowledge/improve-runs.md),
and the main result with its limit. A new step gets its full entry there and its line here.

**Accepted**: the change stays in the code. **No change**: measured, and the prompt stayed as it was. **Not
accepted**: tried and reverted. **Measurement**: numbers without a decision on a change. **Open**: a decision still
waits. An open line is unfinished work, not an order to finish it.

- 2026-09-23 · **measurement** · [A gold tree, version 1](knowledge/improve-runs.md#gold-v1-2026-09-23). The seed was
  audited once, and four writers grew 63 scenes under the agreement of four judges. They are candidates, none promoted:
  the ledger, the recheck's noise and a person's reading are still owed. Version 2 is a separate set of the owner's
  decisions ([improve-loop.md](improve-loop.md#gold-v2)).
- 2026-09-22 · **accepted** · [The walk](knowledge/improve-runs.md#walk-2026-09-22): the model writes its own story
  and a council of four judges reads every scene. One walk each of Haiku and Opus. The spread between two walks of one
  model, and whether a memory change shows on the walk at all, are not known.
- 2026-09-22 · **measurement** · [Three scenarios built to separate, and a scale of models](knowledge/improve-runs.md#scenarios-2026-09-22).
  They order the small models below the frontier and separate nothing at the top; no memory limit of the frontier was
  found. One run per cell, and the production build was not measured on `hospital`. The session that wrote the
  holdout scenario does not run the loop.
- 2026-09-20 · **open** · [Qwen3.8-27B in place of Gemma 4 31B](knowledge/improve-runs.md#qwen-comparison-2026-09-20).
  Indistinguishable on the eval's measures, one run per cell, and the official models rather than the builds that
  would be deployed. A rental would decide the rest: the cost, prefix reuse in a hybrid model, speed.
- 2026-09-19 · **accepted** · [The story system in the language of the seed](knowledge/improve-runs.md#story-language-2026-09-19).
  Scenes and memory stopped drifting into Russian: 11 of 58 trap scenes before, 0 of 65 after. Not on the loop's
  measures; one or two samples per cell, Chinese and Japanese not measured, no native review, not checked on the GPU.
- 2026-09-19 · **no change** · [«не более 12 абзацев» in the narrator's rules](knowledge/improve-runs.md#paragraph-limit-2026-09-19).
  The models write about 2000 characters with any wording, and a principle instead of the number had no measurable
  effect. Length is not a measure of the loop, and how a paragraph is counted moves the share by 10 points.
- 2026-09-19 · **accepted** · [The narrator's rule at the end of the request](knowledge/improve-runs.md#narrator-rule-2026-09-19).
  In `SYSTEM` it changed nothing; after the author's message it closed the traps with a false premise without extra
  refusals, on the production model. 3–5 samples per cell, and the paired comparison ran on different memory runs.
- 2026-09-18 · **accepted** · [`stated` and `readingMisses`](knowledge/improve-runs.md#stated-2026-09-18): the probe
  marks whether a numeric answer is in the memory, in the scenes or nowhere. A diagnostic, not a score.
- 2026-09-18 · **accepted** · [Opus 5 as the scene judge](knowledge/improve-runs.md#judge-2026-09-18). 36 of 40
  verdicts matched `gpt-5.4`, and in the other four Opus was right or stricter. Both sides of one comparison are judged
  by one judge; the question `draw_corrected` mixes two checks and is to be split.
- 2026-09-18 · **accepted** · [A holdout pack with authorship](knowledge/improve-runs.md#holdout-2026-09-18): three
  scenarios outside the repository that whoever runs the loop does not open. On it Gemma's weakness was sums across
  increments. Its call to fix the counters is read with the next entry, which did not accept them; it is not a task now.
- 2026-09-18 · **not accepted** · [State by keys and counters that the code adds up](knowledge/improve-runs.md#counters-2026-09-18),
  headed "in progress" at the time. A weak reader gained much, but Gemma on `dance` went bimodal and compaction started
  looping. The variants tried and the next hypotheses are in the entry.
- 2026-09-18 · **measurement** · [Traps in the middle of the story and traps with a false premise](knowledge/improve-runs.md#traps-2026-09-18).
  The traps went into the eval, judged by `gpt-5.4`. The failures read by hand are of three kinds: an impossible
  premise carried out, an item's current place lost, arithmetic on time and counters. Its hypotheses were not adopted.
- 2026-09-18 · **accepted** · [Reference stories written by Fable agents, a new baseline](knowledge/improve-runs.md#frozen-baseline-2026-09-18).
  Every earlier number belongs to the old stories. On a consistent `battle` every model passes, so the "stable"
  `sava_learns` failure came from a confused story, not from memory.
- 2026-09-18 · **no change** · [The frozen DeepSeek story contradicts the reference](knowledge/improve-runs.md#invalid-deepseek-baseline-2026-09-18).
  The hypothesis tried on it was rolled back untested; `eval ceiling` was added to find the cause. Its decision to rewrite
  the stories with Haiku was replaced by the Fable stories above.
- 2026-09-18 · **measurement** · [The scene eval, the first baseline](knowledge/improve-runs.md#first-scene-eval-2026-09-18):
  `--judge` and the scene traps, one run on `battle`. The numbers stand on the DeepSeek story later found
  contradictory; do not compare them with later ones.
- 2026-09-18 · **measurement** · [Spread on the same code](knowledge/improve-runs.md#noise-2026-09-18). Over three runs
  on `battle`, `gpt-5.4-mini` moves by up to three questions of eight and Gemma by one. On the DeepSeek story, which
  later explained its "stable" `sava_learns` failure.
- 2026-09-18 · **accepted** · [The memory format enforced by the provider](knowledge/improve-runs.md#schema-2026-09-18),
  in the eval and the adapters. `plain` then passed for every model in one run; `sgr` still failed on `quote` or on the
  CLI timeout. A change to the eval, not evidence that a prompt got better.
