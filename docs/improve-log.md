# Improvement log

One line per step of the loop in [improve-loop.md](improve-loop.md), or measurement beside it, newest first: the
date, the status, the question or the change linked to its full entry in [improve-runs.md](knowledge/improve-runs.md),
and the main result with its limit. A new step gets its full entry there and its line here.

**Accepted**: the change stays in the code. **No change**: measured, and the prompt stayed as it was. **Not
accepted**: tried and reverted. **Measurement**: numbers without a decision on a change. **Open**: a decision still
waits. An open line is unfinished work, not an order to finish it.

- 2026-09-28 · **measurement** · [Memory step 2: checks at the memory's boundary, from the memory alone](knowledge/improve-runs.md#ceiling-boundary-2026-09-28).
  Step 2 of the memory proposal; no prompt changed. The eval gained `boundary` (87faddd), in the pack since 75d69a1: 11
  questions of `hospital` and 10 of `assault` asked as of the end of scene 11 from the final memory alone, each answer
  confirmed blind by GPT-6 Astra. Over step 1's memories hosted Gemma 4 31B answered 5, 5, 6 and 8, 10, 9 without
  thinking and 11, 11, 10 and 9, 10, 10 with it; of its 63 answers with thinking two missed, both where the memory
  text itself is wrong or incomplete. `gpt-5.4-mini`, which the switch cannot make think: 4, 4, 1 and 7, 7, 9. Gemma
  reads the checks with `RECALL_THINKING=true`. Two scenarios, three memories a model, hosted models.
- 2026-09-28 · **measurement** · [Memory step 1: the reading ceiling against the compacted replay](knowledge/improve-runs.md#ceiling-boundary-2026-09-28).
  Step 1 of the memory proposal; no change. The same 12 questions over the whole story as text and over the compacted
  replay, three runs each of hosted Gemma 4 31B and `gpt-5.4-mini` on `hospital` and `assault`: Gemma 3.3 against 4.0
  and 8.0 against 8.0, mini 1.3 against 0.7 and 8.3 against 8.7. The ceiling lost all 12 keys Gemma's replays lost and
  12 of mini's 14, so these questions measure the reader, not what compaction drops. Thinking off, two scenarios.
- 2026-09-28 · **measurement** · [Thinking at the read end, over the same memories](knowledge/improve-runs.md#read-thinking-2026-09-28).
  Step 3 of the memory proposal; no change accepted. The eval's recall asked again over step 1's saved memories of
  hosted Gemma 4 31B, with thinking (`RECALL_THINKING`, `RECALL_FROM`): `hospital` went from 4, 3, 4 to 12, 12, 10 and
  `assault` from 8, 9, 8 to 12, 12, 12, far past the predicted +3 and +2, while the same reread without thinking at
  the thinking request's limit scored as before. Thinking over the whole story: 8, 7, 8 and 11, 12, 12. OpenRouter did
  not apply a reasoning cap; a `hospital` recall reasoned 2718 to 3221 tokens in 93 to 110 s against 7 to 8 s. Hosted
  Gemma, three memories, questions and not scenes; scene thinking on the card is the owner's call.
- 2026-09-28 · **measurement** · [L2: a compatible claim about an unshown past, confirmed and kept](knowledge/improve-runs.md#l2-2026-09-28).
  One trap in set `open`, frozen after GPT-6 Astra's review: the narrator should confirm a compatible claim about a
  shared past that no scene shows and keep to it a scene later. One run a model on `assault`: no model of the main
  group confirmed it, each refused and kept refusing (1/2). mini and Haiku also refuse a past the record contradicts;
  Gemma accepts that one. The heretic on the card did as Gemma in four runs over two builds, and route A's three runs
  of `hospital` and the lighthouse walks put it at or below Gemma. One trap, one run a model; no prompt changed, and a
  rule for the open past would go to the owner first.
- 2026-09-27 · **not accepted** · [L1: the reference stamp as the last scene's opening, in lastMessage](knowledge/improve-runs.md#l1-2026-09-27).
  `lastMessage` said that the stamp is the last scene's opening and that a new scene begins no earlier than what that
  scene completed. Three `hospital` replays and three lighthouse walks a side on the main group: the target, a scene
  that opens before the completed bell, failed in 4 of 9 candidate cells against all 8 judged on the baseline, Gemma
  and Haiku passing it in 5 of 6 runs, but `gpt-5.4-mini` fell on the older traps, 4, 9 and 5 of 12 against a lowest
  baseline run of 8, and Gemma gained on nothing. The second rejection in a row. Haiku's baseline run 2 has no trap
  scenes: the Claude CLI failed it twice.
- 2026-09-27 · **measurement** · [O2: traps for time across the scene boundary and for an unshown past](knowledge/improve-runs.md#o2-2026-09-27).
  15 traps with 18 questions, frozen before any wording was tested and scored apart as `sceneScoreO2`; GPT-6 Astra
  reviewed them twice. One run a model on the main group: each passed 17 of 18, and all three missed the same one, a
  scene that opens before an event the last scene completed. So L1 has its target, thin, and L2's gate is not met;
  the open-world past has no scored test until the owner sets the policy.
- 2026-09-27 · **not accepted** · [L3: the value after the last change, with its basis, in plain extraction](knowledge/improve-runs.md#l3-2026-09-27).
  Stage A, a screen on hosted Gemma 4 31B that can only reject, failed. With the rule the pooled `assault` and
  `hospital` scored 12, 12 and 11 of 24, without it 11, 13 and 11, and every candidate run had to beat 13. Gemma did
  write its totals with their basis, and the same keys were lost; `battle`, `chess` and `dance` held, with no retry on
  either side. The first rejection of three in a row. Three runs a side on Gemma alone, so the other models never saw
  the rule.
- 2026-09-27 · **measurement** · [Thinking while compacting, on hosted Gemma 4 31B](knowledge/improve-runs.md#memory-thinking-2026-09-27).
  No gain. With thinking the memory scored 8, 9 and 8/12 on `assault` and 3, 5 and 4/12 on `hospital`; without it
  8/12 three times and 4, 4 and 5/12. Both sides lost the same keys, and thinking cost 3.6 times the output tokens
  and 3.3 times the compaction time. The first switch-on runs were cut by our own 2 MB stream guard, not by the
  model; the guard now grows for thinking requests. The switch stays off. Hosted Gemma stands in for the heretic
  Q6_K, and the bot would need a card run on the owner's word.
- 2026-09-26 · **accepted** · [Route A against the Q6_K again, with the texts kept and three judges](knowledge/improve-runs.md#route-a-2026-09-26).
  Both routes hold the same facts in memory, and both lose the `dance` twins in the reading, so the first card's three
  passes were one sample. By three judges and two readers route A loses in counting ampoules within a scene and in
  refuting a false date firmly, and its memory writes hyphens for dashes and fewer «ё». Two or three runs a scenario,
  and engine, weights and cache changed together. The owner took route A with its drafter, which serves two
  requests at once, the small loss included; route B does not follow on quality.
- 2026-09-25 · **measurement** · [Route A against the production Q6_K on one 5090](knowledge/improve-runs.md#route-a-2026-09-25).
  On `dance` route A misses the same three numbers on all three passes, twins the scenario was built with, and the
  Q6_K finds them here and on 09-22; by the rule written down before the runs, route A is worse. The Q6_K has one pass
  on this card, engine, weights and KV cache changed together, and the texts are lost. The next card did not bear the
  `dance` result out.
- 2026-09-23 · **measurement** · [A gold tree, version 1](knowledge/improve-runs.md#gold-v1-2026-09-23). The seed was
  audited once, and four writers grew 63 scenes under the agreement of four judges. They are candidates, none promoted.
  The ledgers, a whole-trunk audit and a fresh recheck are recorded: 61 of 63 nodes were agreed again. The rewritten
  seed was not audited again before the tree grew, so version 1 stays a draft; version 2 is a separate set of the
  owner's decisions ([improve-loop.md](improve-loop.md#gold-v2)).
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
