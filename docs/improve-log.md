# Improvement log

Every step of the loop from [improve-loop.md](improve-loop.md): date, hypothesis, change, numbers before and after per model, decision. Rejected hypotheses are recorded too. New entries go on top.

## 2026-09-19 · Opus 5 · the story system in the language of the seed

The owner's task: a user who writes a seed and turns in English, Chinese, Korean or Japanese gets scenes and memory in that language with the same continuity discipline, and Russian gets no worse. Until now the narrator's rules, the memory rules, the headers around the seed and memory, and the two messages the code writes («Начни историю из сида…», «Продолжай историю…») were Russian for every story. The only language rule was «Пиши по-русски, если сид не задаёт другой язык» ("write in Russian unless the seed sets another language").

Hypothesis: with rules and headers in Russian, a model writes a non-Russian story's memory, and some of its scenes, in Russian. The fix is to give each story the prompts of its own language.

Change: `local/story-text/` has one catalog per language. `ru.ts` is the production prompt copied verbatim. `en`, `zh`, `ko` and `ja` are faithful translations: the same rules in the same order, with the language named in the "write in …" clause. `en` is also the fallback for a seed in any other language, and its rules say to follow the seed. `detectStoryLanguage` counts the scripts in the seed's title and body. It runs on every request and nothing is stored. It is separate from the interface language. `estimateTokens` in `context.ts` counts a Han or kana character as four bytes instead of three (details under limitations).

Russian: for a Cyrillic seed, the scene request, the plain memory request and the sgr memory request are byte-for-byte identical to `331f3ec`. This was checked by building all three with the old and the new code on one synthetic story. No Russian eval was run: identical requests can only show the noise, so the result that the holdout pack cannot see a Russian change is by construction.

Measurement pack: `packs/language/` is the open `battle` scenario translated into English (`battle-en`) and Korean (`battle-ko`), including the 16 frozen scenes, by Opus 5 agents (`authors: ["opus-5"]`). Keys and expected answers are unchanged, and `eval ceiling` with `gpt-5.4` is 8/8 on both. The pack is new, unreviewed and not part of the meter. Baseline = `331f3ec` (Russian prompts) and after = this change, both run in parallel on the same pack. Settings: `--mode plain --judge claude:claude-opus-5`, models `claude:claude-haiku-4-5-20251001` and `openai:gpt-5.4-mini`. English ran twice, Korean once. Paid Gemma was not used: its channel was nearly exhausted today.

Memory / scenes (judge), per run:

| model | scenario | before | after |
| --- | --- | --- | --- |
| Haiku 4.5 | battle-en | 8/8, 14/15; failed `provider_failed` | 7/8, 14/15; 8/8, 14/15 |
| Haiku 4.5 | battle-ko | failed `provider_failed` | failed `provider_failed` |
| gpt-5.4-mini | battle-en | 8/8, 12/15; 8/8, 11/15 | 8/8, 11/15; 8/8, 10/15 |
| gpt-5.4-mini | battle-ko | 8/8, 13/15 | 8/8, 12/15 |

Language of the output (majority script of each trap scene and each stored fact; failed runs counted up to where they stopped):

| | before | after |
| --- | --- | --- |
| trap scenes not in the story's language | 11 of 58 (Haiku en 2/12 and 1/5, gpt-5.4-mini en 5/12, Haiku ko 3/5) | 0 of 65 |
| memory runs whose facts are all Russian | 2 of 6 (Haiku en 79 of 79 facts, Haiku ko 57 of 57) | 0 of 6 |

Decision: accepted, but not on the loop's measures. `score` and `sceneScore` do not separate the two sides. The failed scene questions come from the same set on both sides: `healer_still_broken`, `seal_allowed_charges`, `dagger_source`, `turn9_left_hand_spared` and `turn14_dagger_with_tarek`. Their spread is within the known noise of `gpt-5.4-mini` (up to 3 questions). The judge reads Russian as easily as Korean, so a scene written in the wrong language still passes, and the meter does not register the defect this change removes. The gain is the language of the output. With the old prompts, a fifth of the trap scenes and a third of the memories of English and Korean stories were written in Russian. Unlike the other failures, this one is visible to every user. For Russian nothing changes, as shown above.

Limitations:
- Haiku's compactions through the CLI failed with `provider_failed` in 3 of 6 runs, on both sides. This is the known CLI timeout, not a memory error.
- One sample per cell for Korean and two for English. Chinese and Japanese were not measured; their catalogs are checked only by `story-text.test.ts`.
- `zh`, `ko` and `ja` have not been reviewed by a native speaker.
- The recall question wrapper in `memory-probe.ts` and the judge's system prompt stay Russian for every pack, so that the meter stays the same.
- Not checked on the GPU model.
- Token estimate: measured against provider-reported input, bytes per token are en 4.9, ru 5.7, ko 4.3, ja 3.9 and zh 3.6 on Gemma 4 31B, and 5.0, 5.8, 4.0, 3.3 and 3.3 on `gpt-5.4-mini`. At bytes/4, a Chinese or Japanese request was estimated 10–20% short. With the default settings, that is enough to reach the compaction threshold only after the context is already full. Only providers without `countInput` are affected, that is, all except llama.cpp. Latin, Cyrillic and Hangul keep the old estimate exactly.

## 2026-09-19 · Fable 5.1 · «не более 12 абзацев» ("no more than 12 paragraphs"): a number, a principle or nothing (no change)

The tester's hypothesis: the limit named in SYSTEM, «Пиши не более 12 абзацев» ("Write no more than 12 paragraphs"), makes the model fit the length to the number; without the number the model will focus on the scene. Variants: `base` (as is), `principle` («Объём сцены определяй по тому, что в ней происходит: короткий ход — короткая сцена, поворотный — подробнее. Не дописывай ради объёма; заканчивай там, где автору есть на что ответить» — "Decide the length of a scene by what happens in it: a short move gets a short scene, a turning-point move gets more detail. Do not add text for the sake of length; end where the author has something to answer"), `none` (the phrase is removed). Three worktrees, `npm run eval --mode plain --judge claude:claude-opus-5` on the main group, then a repeat on the paid Gemma; not checked on the GPU.

Length of trap scenes, paid Gemma (OpenRouter), two runs: `base` 44 scenes, median 1922 characters, maximum 2507; `principle` 44, 1890, 2750; `none` 34, 1961, 2610. For `gpt-5.4-mini` and Ministral, without the number the median grows by 1–2 paragraphs and tails of up to 21–28 paragraphs appear, against 17–19. No scene out of 230 was cut off by the token limit. Traps on Gemma: 49/50, 50/50, 38/40 — no difference; for the other models the difference is within noise. Incomplete cells: Ministral hit the daily limit (three runs shared 500 thousand tokens), Haiku and, twice, Gemma failed with `provider_failed`.

Decision: do not change the prompt. The number does not pull the length up: the models write their usual length (about 2000 characters) with any wording, and «не более 12» slightly holds back the tails and is broken in a third of the scenes. The principle is harmless, but it gave no measurable effect. Limitations of the measurement: all trap moves are similar in size, so it is not visible whether the model writes shorter for a short move — this is a separate measure; length is not part of the acceptance measures (`score`, `sceneScore`), so by the rules of the loop such an experiment cannot end in acceptance; the definition of a paragraph moves the share of "longer than 12" by 10 percentage points and must be fixed before the next measurement. The critique of the eval and the plan to speed up experiments are in [eval-experiments-plan.md](eval-experiments-plan.md) and [eval-economics-proposal.md](eval-economics-proposal.md).

## 2026-09-19 · Fable 5.1 · the narrator's rule at the end of the request; measurement on the production model on a GPU

Hypothesis (ideas A and K from `storyworm-ideas.md`): the narrator accepts the author's false premise («рука уже вылечена» — "the arm is already healed", «мы договорились о ничьей» — "we agreed on a draw") because it obeys the message, not because it forgot the state. The rule «слова о прошлом — речь персонажа, а не факт» ("words about the past are a character's speech, not a fact") must stand where the model reads it last.

Eval: the `--lab` mode in `local/memory-probe.ts`. Every trap scene is written for every variant and sample inside one run, that is, on the same memory. A variant is a text at the end of the last message, so all variants share the request prefix. Model: `gemma-4-31b-heretic-q6k` on a rented RTX 5090, production server settings, except the number of slots (5 instead of 1). Judge: `claude:claude-opus-5`; it does not see the variant. A cell shows "passed/total" over the judge's questions.

Batch 1, open scenarios (`battle`, `chess`, `dance`), 3 samples, the rule at the end of the message. The working tree at that time contained an unaccepted memory change with counters; it is the same for all variants.

| variant | total out of 75 | `healer_still_broken` | `castle_corrected` | `samira_corrected` | control (allowed action) |
| --- | --- | --- | --- | --- | --- |
| no addition | 62 | 0/3 | 0/3 | 0/3 | all passed |
| `rule` (the accepted text) | 74 | 3/3 | 3/3 | 3/3 | all passed |
| `short` (two phrases) | 74 | 2/3 | 3/3 | 3/3 | all passed |
| `check` (a silent checklist) | 70 | 3/3 | 3/3 | 0/3 | all passed |
| `state` («восстанови состояние» — "restore the state") | 67 | 0/3 | 1/3 | 0/3 | all passed |

Holdout pack (the rule did not see it), 3 samples, the rule at the end of the message; `secrets` and `voyage` ran from a clean tree on the committed memory:

| scenario | questions | no addition | `rule` | `short` |
| --- | --- | --- | --- | --- |
| `ledger` | 33 | 31 | 33 | 32 |
| `secrets` | 36 | 21 | 28 | 28 |
| `voyage` | 36 | 28 | 33 | 33 |
| total | 105 | 80 | 94 | 93 |

No control trap with an allowed action failed. Not closed by any variant: `turn15_crates_35` (a counter sum across compactions, 0/3), `turn9_agata_in_dark` (0/3), `turn12_from_workshop` (0–1/3), `debt_remainder` (the remainder of a debt, 0–2/3) — these are numbers and "who knows what", which is work for the memory, not for the rule.

Batch 3, committed memory code, 5 samples, 8 traps (5 with a false premise, 3 control), the same text in `SYSTEM` instead of the end of the message:

| where the rule is | total out of 45 | `healer` | `castle` | `samira` |
| --- | --- | --- | --- | --- |
| nowhere | 31 | 0/5 | 2/5 | 2/5 |
| `rule` in `SYSTEM` | 32 | 0/5 | 3/5 | 1/5 |
| `short` in `SYSTEM` | 29 out of 44 | 0/5 | 2/5 | 1/5 |

Conclusion: in `SYSTEM`, before thousands of tokens of story, the rule changes nothing; at the end of the request it closes the traps with a false premise and causes no extra refusals. `state` does not help, so the cause is not a forgotten state.

Decision: accepted. `makeRequest` in `local/prompt.ts` appends `NARRATOR_RULE` after the author's message. The request prefix does not change, so the server cache is not harmed. Limitations of the measurement: 3–5 samples per cell; the paired comparison "end of the message against `SYSTEM`" ran on different memory runs; the rule was not measured on the fallback model from `.env`. The unaccepted memory change with counters is put aside in `git stash` and will go as a separate step.

Speed of batches (changes to the eval, not to the prompts): 5 slots with a shared KV cache gave 8 s per scene against 15 s; the extra single scene after a trap is removed. Requesting all samples of a variant in one call with `n` (`generateMany` in `local/llama.ts`, the `many` field in the batch file) is turned off: on the pinned revision of `llama-server`, after such requests the server answered "context size exceeded" to every following request until it was restarted. Reproduced on synthetic requests.

## 2026-09-18 · Fable 5.1 · the measure "is the answer stated in the memory" (idea N from `storyworm-ideas.md`)

A change to the eval (`local/memory-probe.ts`, `local/eval.ts`): for a numeric answer the probe, without a model, marks `stated: memory | scenes | none`, and `eval` collects `readingMisses`. Check on the working tree with counters, `gpt-5.4-mini`, `dance`: 13/13, the totals per version are `memory`, the overall total of clean repeats is `none` (the model added it up itself), `readingMisses` is empty. Purpose: when fixing the counters, to tell "the summary is wrong or incomplete" from "the summary is right, the model did not read it"; on the base code without a summary, the sums of the holdout pack must give `none`.

## 2026-09-18 · Fable 5.1 · Opus 5 as the scene judge

Why: the judge `openai:gpt-5.4` hits the daily limit of 225 thousand tokens, and after 120 requests the scene scoring stops. Opus 5 runs on a subscription (`--judge claude:claude-opus-5`, the `claude-code` provider without tools, the answer follows a JSON schema).

Check: four already scored reports (battle ×2, chess, dance; scenes by Gemma and `gpt-5.4-mini`), 40 questions, the same scenes were given to Opus (`local/scene-judge.ts` on copies). 36 out of 40 matched. The four differences were read by hand:

| Question | `gpt-5.4` | Opus | Who is right |
|---|---|---|---|
| `seal_early_worked` | no | yes | Opus: in the scene the seal worked at 08:16, `gpt-5.4` missed the violation |
| `castle_corrected` | no | yes | Opus: «короткая рокировка была возможна только на бумаге» ("short castling was possible only on paper") — the scene says that castling was not done |
| `turn9_left_hand_spared` | yes | no | disputable, Opus is stricter: the heroine braces her broken arm in a splint as a wedge |
| `draw_corrected` | no | yes | by the letter of the question, Opus (the arbiter says the offer is not in the protocol), but the scene states that Viktor did speak about a draw — the question misses this contradiction |

Decision: Opus 5 is admitted as a judge on equal terms with `gpt-5.4`; it reads no worse and caught an error of the previous judge. Numbers obtained by different judges are not compared with each other: both sides of one comparison are judged by one judge. The question `draw_corrected` must be split into two (not in the protocol; the scene does not state that the offer was made) — together with the next re-recording of the baseline.

## 2026-09-18 · Fable 5.1 · a holdout pack of scenarios with authorship

Why: the open scenarios are read by the one who improves the prompts, and a rule can be fitted to them without noticing. The holdout pack lies outside the repository (`~/simple-story-chat-holdout/`, the private HF dataset `Teadomi/simple-story-chat-holdout`, revision `a24e6c75f29a`, upload and download by `local/pack-hf.ts`); the one who leads the loop does not open it.

Eval: `local/scenarios.ts` loads a scenario from `examples/` or from the pack (`scenario.json` with a required `authors`, 16 turns, `frozen.json` next to it); `--pack` is understood by `eval`, `eval ceiling`, `memory-probe`, `scene-judge`, `freeze-scenes`; the authors go into the result file. Tests: `local/scenarios.test.ts`.

The open part is published as the public dataset `Teadomi/simple-story-chat-eval`, revision `632a57972119` (export by `local/pack-hf.ts export`, published by the owner); the source of truth is `examples/`.

The pack: three scenarios, authors `fable-5.1` (three fresh agents, one per scenario; Astra is not available today and may later review them and add itself as an author). The content is not described here.

| Scenario | Memory questions | Scene questions | Independent reader (Fable, without the reference) | `ceiling` `gpt-5.4-mini` | `ceiling` `gpt-5.4` |
|---|---|---|---|---|---|
| `ledger` | 12 | 11 | 12/12 | 5/12 | 10/12 |
| `secrets` | 12 | 12 | 12/12 | 9/12 after a format fix | the limit was not enough |
| `voyage` | 12 | 12 | 12/12 | 9/12 | the limit was not enough |

Findings: `gpt-5.4-mini` returned names in Latin letters, so «кириллицей, точно как в списке» ("in Cyrillic, exactly as in the list") was added to the questions; `gpt-5.4` added the sale of an unrelated item to the revenue for the goods — the question was made more precise, the scenes were not changed. All `ceiling` failures are sums of 8–14 terms, which the model computes in one answer without reasoning; a reader with a state sheet gets the reference answers and found no contradictions in the texts. Conclusion: for the holdout pack the ceiling of weak models is low, so versions must be compared relative to the `ceiling` of the same model, not to the maximum.

Memory baseline on the pack, `plain`, revision `a24e6c75f29a`, code `a3fc763` (without key/counters):

| Model | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `openrouter:google/gemma-4-31b-it` | 27/36 (9, 10, 8) | 28/36 (10, 9, 9) | 27/36 (10, 9, 8) |
| `openai:gpt-5.4-mini` | 24/36 (6, 7, 11) | 25/36 (8, 8, 9) | 15/36 (0, 7, 8) |

In parentheses: `ledger`, `secrets`, `voyage` out of 12. The noise of Gemma is one question. Out of 26 Gemma failures over three runs, 22 are accumulated sums (in every run: letters, barrels, total mileage and mileage in the restricted mode, fuel, lodging); the rest are dates of "who learned what and when" and a year that must be derived. Gemma passed the questions "who holds the item now" in all runs. One run of `gpt-5.4-mini` gave 0/12 without a probe error — the cause is not investigated. The free Gemma on OpenRouter is not usable for eval: the endpoint answers `unsupported_server` to the response schema.

Conclusion: on the open part the memory of Gemma is almost at the ceiling; on the holdout part the main weakness is sums across increments. The counters must be fixed, not removed.

Remaining: `ceiling` on `gpt-5.4` for `secrets` and `voyage` (the limit resets tomorrow), the baseline of Gemma and Ministral on the pack.

## 2026-09-18 · Fable 5.1 · state by keys and counters that the code adds up (in progress)

Hypothesis: the model makes mistakes not in facts but in deriving "what is true now" from the event log; if the code does the deriving, there will be fewer mistakes. The log of increments stays append-only, earlier increments do not change.

Change (`local/memory.ts`, `local/prompt.ts`, `lib/library.ts`, only the `plain` mode): a fact now has `key` — a permanent name of a tracked quantity (during compaction the model sees the keys already taken in `stateKeys`) — and `add` — a number added to a counter. After the increments, `prompt.ts` prints the summary «состояние на конец охваченных памятью сцен» ("state at the end of the scenes covered by the memory"): for every key the last fact, and for a counter the sum of all `add` values with a breakdown by dates. The summary stands before the live scenes, because they could have changed the state.

An intermediate variant, where the model itself wrote the counter total, is rejected: `gpt-5.4-mini` wrote «25 = прежние 20 + 5 новых» ("25 = the previous 20 + 5 new") where it was 20 + 25, and «все 38 чистые» ("all 38 are clean") instead of 35. The model adds no better during compaction than during reading.

`gpt-5.4-mini`, `dance`, memory: before the change 7–9 out of 13 (its ceiling on the full text is 9), with `add` — 13/13 in one run: a weak model with the memory answers better than on the full text. The second run failed with `invalid_memory (coverage)`: one of the four scenes did not get into any fact. With the change this is 2 failures out of 4 runs against 0 out of 3 before it — possibly the long rules about state distract from covering the scenes; check on Gemma and, if confirmed, shorten the rule or turn on `SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE`.

Further variants of the same day. `add` became an integer (a fractional number gave `output_limit`), then the single number per fact was replaced by a `counters` list with required `subject` and `measure`: with a single number Gemma counted only «всего» ("total") and did not track «чистых» ("clean"), and with a single name field it created one common counter «повторы полные» ("full repeats") for all dances. The probe now repeats a compaction after `invalid_memory` up to two times and writes `compactionRetries`, the same way the owner repeats `/compact`.

Result on the paid Gemma 4 31B, `plain`, the latest version of the change:

| | before the change | after |
| --- | --- | --- |
| `battle`, memory | 8/8, 8/8 | 8/8 in all 4 completed runs |
| `battle`, scenes | 13/15: `turn14_dagger_with_tarek`, `healer_still_broken` | 14, 13, 14, 13 out of 15; `turn14_dagger_with_tarek` passes 4 out of 4; `healer_still_broken` always fails, `ally_corrected` and `bridge_corrected` failed once each |
| `dance`, memory | 12, 13, 13 out of 13 | 13, 9, 13, 13, 13, 7 out of 13 |
| compaction retries | 0 over about 18 compactions | 3 over the last 12 compactions, all `output_limit` with a usual answer size of about 1000 tokens, that is, looping |

`gpt-5.4-mini`, `dance`, memory: before 7–9 out of 13, with a single `add` 13/13 in 7 runs out of 7 completed; with the list of counters 13, 9 and one failure, after the rule about names 13, 13, 13.

Decision: not accepted. For a weak reader, counters in the code are a large gain; for Gemma the location of an item started to hold, but `dance` became bimodal: when Gemma misses one term or confuses a counter, the summary states a wrong value with confidence, and the answer is worse than without the summary. In addition, there is looping during compaction. Next steps: (1) find the cause of the looping (an integer without bounds, or the array; check on the same request without `counters`); (2) separate `key` from `counters` and measure them apart; (3) make the counter summary checkable: print the number of terms and the dates next to the total, and in the rules require a counter for every lesson where a number is named.

With the first variant of the change (a summary without `add`), the scenes of `gpt-5.4-mini`: `dance` 5/6 → 6/6, `chess` 2/4 → 4/4, `battle` 12/14 → 11/15; one run each, not distinguishable within noise. The main check — Gemma on `battle` (the dagger, the seal deadline) — waits for the daily limit.

## 2026-09-18 · Fable 5.1 · traps in the middle of the story and traps with a false premise; judge `gpt-5.4`

The owner's goal is a consistent world, so the scene eval is extended: `afterTurn` writes a scene for an author's message in the middle of the story (after compactions), and the final traps state in passing something that did not happen (the bridge burned, Roan is an ally, forty repeats are done, a draw was offered). There are traps for all three scenarios: 15, 6 and 4 questions.

Judge: `gpt-5.4-mini` makes mistakes on careful reading (out of five failures checked by hand, one is false; one more failure was missed). `gpt-5.4` decided both cases correctly; out of three differences between the two judges, two are in its favor, and the third is an ambiguous scene. The judge is now `openai:gpt-5.4`; the cost is about 25 thousand tokens per model and run, out of 225 thousand free tokens per day. After the check, the question `castle_corrected` was fixed and `turn15_seal_not_ready` was added.

`plain`, one run, judge `gpt-5.4` (the scenes of `gpt-5.4-mini` were judged before `turn15_seal_not_ready` was added):

| Model | `battle` | `dance` | `chess` |
| --- | --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 13/15: `turn14_dagger_with_tarek`, `healer_still_broken` | 6/6 | not run: daily limit |
| `openai:gpt-5.4-mini` | 12/14: `dagger_source`, `healer_still_broken` | 5/6: `b_total_38` | 2/4: `draw_corrected`, `castle_corrected` |

The failures were read by hand; all are real. Three kinds of errors, each one in both models or in both scenarios:

1. The narrator carries out an impossible premise of the player. «Сава вправляет кость» ("Sava sets the bone") — with both Gemma and `gpt-5.4-mini` the scout, who by the seed does not heal, sets the fracture, and Elin braces herself with both arms. The same with «предлагал ничью» ("offered a draw"): the arbiter confirms a conversation that did not happen.
2. The current location of an item is lost. With Gemma, after the second compaction Tarek «оставил кинжал у решётки» ("left the dagger at the grate"), although he has had the dagger since 08:05 and he checked this at 08:09. The memory stores the handover events, not the current state «кинжал у Тарека» ("Tarek has the dagger").
3. Arithmetic on time and counters. `gpt-5.4-mini` at 08:14 declares the seal available (six minutes remain until 08:20), Gemma at 08:13 says «девять минут» ("nine minutes") instead of seven; Vera counts 48 repeats of version B instead of 38.

Hypotheses in decreasing order of expected benefit: (a) a "current state" block in the memory — where every item is, remainders and totals of counters, availability deadlines, injuries — rewritten at every compaction, and not only an event log (closes 2 and 3); (b) a rule for the narrator to check the player's move against what is established and to show an obstacle (closes 1; the diff was already tried on an unusable story); the control for both — the trap `seal_allowed` and the memory questions must not fail.

Spending for the day at this point: the paid Gemma 481 thousand out of 600 thousand, Mistral is almost used up; comparative runs start tomorrow.

## 2026-09-18 · Fable 5.1 · reference stories written by Fable agents, a new baseline

On the owner's word all three stories were written again: one fresh Fable 5.1 agent per scenario, with a state sheet and a check against the reference questions; the recording by Haiku is stopped. The scene files are built by `local/freeze-scenes.ts`. All numbers in the entries below belong to the old story and are not compared with these.

`ceiling` (questions on the full text without compaction):

| Scenario | `gpt-5.4` | `gpt-5.4-mini` |
| --- | --- | --- |
| `battle` | 8/8 | 8/8 |
| `chess` | 6/7, misses `fen` | 5/7, misses `fen`, `extra_a3` |
| `dance` | 13/13 | 9/13, misses `a_repeats`, `a_clean`, `b_repeats`, `b_clean` |

`fen` requires playing through 87 half-moves in the head; no model gets it, so the real maximum of `chess` is 6/7. The agent checked the moves in the scenes against the reference game with a script.

Baseline, `plain`, one run, judge `openai:gpt-5.4-mini`:

| Model | `battle` | `battle` scenes | `chess` | `dance` |
| --- | --- | --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 8/8 | 5/5 | 6/7, `fen` | 12/13, `cancelled_tango` |
| `mistral:ministral-14b-2512` | 8/8 | 4/5, `seal_allowed_charges` | 6/7, `fen` | 9/13, `a_repeats`, `a_clean`, `all_repeats`, `all_clean` |
| `openai:gpt-5.4-mini` | 8/8 | 5/5 | 4/7, `fen`, `extra_a3`, `extra_castle` | 7/13, all six sums |

`score` 0.68, `sceneScore` 0.8.

- On a consistent story `battle` passes for every model, including `sava_learns`: the "stable failure" from the earlier entries was a result of a confused story, not of the memory. Drop the hypothesis about "who learned what and when".
- The `plain` memory of Gemma is almost at the ceiling (26/28, and one of the misses is a dead question). There is nothing to win here with a prompt.
- The real weakness is sums across several scenes in `dance`: `gpt-5.4-mini` fails them on the full text too, that is, this is the reader's arithmetic, not a loss of facts. A candidate for a general principle for the memory: store countable quantities as a running total (the new value and what it was made of), not as scattered events. Check on `dance`, and watch that `battle` and `chess` do not fall.
- Traps exist only for `battle`, and almost all of them pass: to tell changes apart, harder traps are needed, and traps for the other scenarios.
- Spending for the day: Mistral 453 thousand out of 500 thousand tokens, do not run it again today; the paid Gemma 294 thousand out of 600 thousand.

## 2026-09-18 · Fable 5.1 · the frozen DeepSeek story contradicts the reference

All numbers below this entry were obtained on `battle` recorded by `deepseek-v4-flash:free`, and they are useful only as a history of debugging the eval.

- The hypothesis "a move that contradicts a fact is not carried out silently" (a change to `SYSTEM` in `local/prompt.ts`) did not move `dagger_source` for any model. The analysis showed that the trap is at fault: by the author's design Tarek has the dagger, but in the recorded scenes DeepSeek returned it to Elin, and the memory of the models honestly stores this. The hypothesis is not tested, the change is rolled back; try the diff again on a correct story.
- In the same scenes, after the second use of the seal the text says «осталось пять зарядов» ("five charges remain") while the reference is 3. The questions `charges` and `next_use` punished the model for being faithful to the text.
- The new command `npm run eval -- ceiling --model <model>` asks the questions on the full story without compaction. `gpt-5.4` scores 8/8 (it resolves the contradiction by the author's messages), `gpt-5.4-mini` scores 5/8, missing `charges`, `next_use`, `sava_learns`: exactly the keys that it "lost" with the memory. That is, its failures were errors of reading a contradictory text, not of the memory, and the spread from the entry below comes largely from this.
- The recording of `chess` by the same DeepSeek failed five times in a row at compaction with `invalid_memory`.

Decision (replaced by the entry above: the scenes were written by Fable agents): the author of the frozen scenes is `claude:claude-haiku-4-5-20251001`, all three scenarios are rewritten. A story is accepted only if the `ceiling` of a strong model is the maximum, and the facts of the traps are checked against the text of the scenes, not against the author's messages. The previous `battle.json` is saved outside the repository.

## 2026-09-18 · Fable 5.1 · the scene eval, the first baseline

A change to the eval, not to the prompts: `--judge`, `examples/scene-traps.ts`, `local/scene-judge.ts`. Scenario `battle`, mode `plain`, judge `openai:gpt-5.4-mini`, one run.

| Model | memory | scenes | scene failures |
| --- | --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 7/8 | 4/5 | `dagger_source` |
| `mistral:ministral-14b-2512` | 8/8 | 3/5 (a separate run) | `seal_allowed_charges`, `dagger_source` |
| `openai:gpt-5.4-mini` | 7/8 | 3/5 | `seal_allowed_charges`, `dagger_source` |

- All three fail `dagger_source`: the player writes that the heroine draws a dagger which, by the established facts, another character has, and the narrator silently carries it out. The memory is not the cause here; the fact is in it. A candidate for a general principle for `local/prompt.ts`: a player's move that contradicts an established fact is not carried out silently — the scene shows an obstacle. The control trap `seal_allowed` must stay green with this, otherwise the narrator has simply started to refuse.
- Two out of three fail `seal_allowed_charges`: after the allowed third use, the scene names the previous remainder of charges. At the same time both answer the memory question about the charges correctly: knowing a fact and recalculating it in a scene are different skills.
- In the second run Ministral lost the connection on the trap scenes (`provider_failed`, `UND_ERR_SOCKET`) and got 0/5 with `no_scenes`; its row is taken from the first run. The probe now repeats a request after a dropped connection.

## 2026-09-18 · Fable 5.1 · spread on the same code

Three `plain` runs on `battle` without a single change between them (the first is from the table below):

| Model | 1 | 2 | 3 |
| --- | --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 7/8 | 6/8, misses `news`, `sava_learns` | 7/8, misses `sava_learns` |
| `mistral:ministral-14b-2512` | 8/8 | 8/8 | 8/8 |
| `openai:gpt-5.4-mini` | 6/8 | 8/8 | 5/8, misses `charges`, `next_use`, `sava_learns` |

`score` per run: 0.75, 0.75, 0.625. Conclusion: on one scenario of 8 questions the spread of `gpt-5.4-mini` reaches three questions (it has the default temperature, not 0.2), and the spread of Gemma is one question. A shift of `score` by 0.125 and even by 0.25 in one run means nothing. While there is only one scenario, compare a change over at least three runs per side and look at the sum over the runs, not at the minimum; it is more reliable to first record `chess` and `dance`, so that there are 24 questions. Only the `sava_learns` failure is stable: Gemma 3 out of 3, `gpt-5.4-mini` 2 out of 3, Haiku 1 out of 1.

## 2026-09-18 · Fable 5.1 · the memory format is enforced by the provider

This is a change to the eval and the adapters, not to the prompts. Scenario `battle`, the scenes are recorded by DeepSeek V4 Flash.

Without an enforced schema (only the "any JSON" mode and a description of the format in the prompt) the results were not reproducible: `gpt-5.4-mini` in `plain` gave 8/8 in the first run and `invalid_memory (shape)` in the second on the same code; `ministral-14b` failed with `shape` both times; `sgr` did not pass for any model, including Haiku. The free `gemma-4-31b-it:free` ended with `retry_limit` both times: the upstream answered 429 for more than ten minutes.

Change: `outputSchema` is passed as structured output (`json_schema`, strict) to OpenAI, Mistral and OpenRouter, and to the Claude CLI through `--json-schema`. OpenRouter must choose an endpoint that enforces the schema, so the free Gemma 4 now refuses explicitly; the paid `google/gemma-4-31b-it` is used instead.

| Model | `plain` | `sgr` |
| --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 7/8, misses `sava_learns` | `invalid_memory (quote)` |
| `mistral:ministral-14b-2512` | 8/8 | `invalid_memory (quote)` |
| `openai:gpt-5.4-mini` | 6/8, misses `charges`, `sava_learns` | `invalid_memory (quote)` |
| `claude:claude-haiku-4-5-20251001` | 7/8, misses `sava_learns` | `timeout` |

`score`: `plain` 0.75, `sgr` 0. One run, the noise is not measured. Haiku ran as a separate run; with the schema through `--json-schema` the CLI spends about two minutes on a compaction, and the `sgr` request did not fit into the 300-second timeout.

Open questions for the next step:

- `sgr` passes the structure check for all models and fails on `quote`: the evidence did not match the scene text word for word. The kind of mismatch is measured (the counters `quoteCount`, `quoteWhitespace`, `quoteTypography`, `quotePunctuation`, `quoteOther` in the failure row): for `gpt-5.4-mini`, out of 40 quotes 36 are verbatim, 1 differs in punctuation, 3 differ in something else; for Gemma, out of 20 quotes 12 are verbatim, and the other 8 are "other". Whitespace and typography are not at fault even once, so normalizing the comparison will not help: the models paraphrase, change the form of a word or join pieces together. One non-verbatim quote now throws away the whole increment. Candidates: drop non-verbatim quotes and the facts that rest only on them, with a threshold for the reject rate; allow a quote with a gap if both parts are verbatim; require in the prompt a short continuous fragment without changing the form of the words.
- Three models out of four fail `sava_learns` in `plain`: a candidate for a general principle about who learned what and when.
