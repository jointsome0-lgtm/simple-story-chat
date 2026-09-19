# Plan of experiments over prompts and memory

2026-09-19 · Opus 5 (swarm summary) · analysis only: no code was changed, not a single paid or rate-limited request
was made to any model, no GPU was rented. This is a research note: the numbers marked [M] were taken from local
technical logs, which are not published.

This is a summary of six reconnaissance angles and of the skeptics' verdicts on them. Proposals that the skeptics
refuted are not included here; proposals that were corrected are included with the corrected numbers. Markers:
**[M]** measured (code, `logs/`, counters), **[D]** derived by calculation from measured values, **[A]** an
assumption that must be closed by a measurement.

Files read: `docs/improve-loop.md`, `docs/improve-log.md`, `docs/gpu.md`, `docs/model-providers.md`,
`docs/eval-economics-proposal.md`, `local/eval.ts`, `local/memory-probe.ts`, `local/scene-judge.ts`, `local/llama.ts`,
`local/prompt.ts`, `local/memory.ts`, `local/generation.ts`, `examples/scene-traps.ts`, `gpu/serve.sh`,
`logs/gpu-q6-final-*.jsonl`, `logs/eval.jsonl`. The holdout pack, `data/` and `.env*` were not opened.

## Relation to `docs/eval-economics-proposal.md`

That file was written in parallel and independently. There are few real disagreements, and they are named
explicitly below.

We agree on these points. The unit of pairing and resampling is the **trap**, not the question and not the scene.
The count "105 observations" overstates the precision by a factor of about 1.7. A flat request pool in lab mode is
the first change. A `system` field in the batch file removes the need for a worktree per variant. The judge costs
no money and must run outside the rental window. "Filling up the hour" makes no sense with per-second billing.

We disagree in three places.

1. **Prefill speed.** That file has P ≈ 2300 tokens/s (a fit over six compaction rows from `logs/bot-gpu.jsonl`,
   input 12–39 thousand tokens). My fit over 51 `scene` rows from `logs/gpu-q6-final-*.jsonl` (input 0.7–7.2
   thousand, which is exactly the working range of a batch) gives **P ≈ 1290 tokens/s, D ≈ 39 tokens/s**. For the
   short inputs of a batch my value is correct. Treat the difference as a range of 1300–2300 and do not assume
   that prefill is cheaper than 2.5 s per 6 thousand tokens.
2. **`cachedInputTokens` as "a check of the assumption that the whole lab mode rests on"** (in that file it is an
   item under "do first"). The assumption is already confirmed by the log: the field arrives and is non-zero in 41
   of 51 `scene` rows (the zeros are the first scene and the scenes right after a compaction). It still must be
   printed in `lab_scene`, but this is not a reason for a separate step: I lower it to a part of the check of
   item 1.
3. **Priority of interruptibility.** That file does not have it at all. When you pay for actual time, a normal
   session is 15–25 minutes, and today such a session cannot be recovered: `--resume` silently erases the variant
   scenes that are already written (item 1.4). I put this change in the top three.

---

## 1. Where time, money and precision are lost now

### 1.1 What really costs time on the GPU

**[M]** My fit over 51 scenes from `logs/gpu-q6-final-*.jsonl` (production Gemma 4 31B heretic Q6_K, one slot, KV
`q8_0`): median scene **15.6 s**, median compaction **19.1 s** (n=9, spread 11.9–25.5), scene output median
**591 tokens**, input median **4,668** (maximum 7,219). From this: **decode ≈39 tokens/s**, **prefill ≈1,290
tokens/s**.

**[D]** The decode of one scene is 591/39 ≈ **15 s out of 15.6**, that is **~95 % of a single scene**. Everything
that speeds up decode (the number of busy slots, the KV cache type) acts on 95 % of the bill. Everything that saves
prefill (a shared prefix, a memory bank) acts on the remaining 5 %, plus on rare cold requests.

### 1.2 Slots are underused: 3 requests of 5 are in flight

**[M]** `local/memory-probe.ts:180`: the number of chains equals `Math.max(1, Math.floor(parallel / samples))`, and
each chain sends `samples` requests in one `Promise.all`. With `parallel: 5, samples: 3` this is **one chain and
three requests**, not five. Full occupancy happens only when `samples` divides `parallel`.

**[D]** The measured 8 s per scene were obtained at batch size 3: total decode 591/8 ≈ 74 tokens/s against the
ideal 3 × 39 = 117, so the batching efficiency is 63 %. Going from 3 to 5 requests in flight realistically gives
**5.7–6.5 s** per scene (not 5.0: batching efficiency falls as the number of streams grows), that is
**−20…−30 % of the batch time**.

**[M, refutes the workaround]** "Start three processes with `parallel: 2`" is impossible: `local/llama.ts:192`
throws `unexpected_slots` if `props.total_slots !== lab.parallel`. Every process must declare all slots.

### 1.3 `SYSTEM` variants are run as a full eval from a separate worktree

**[M]** `type Lab` (`memory-probe.ts:63`) knows only `{ key, tail }`, with `tail` ≤ 2000 characters. A variant that
changes `SYSTEM` today needs a git worktree and a full eval with memory compacted again. Batch 3 in the log was run
this way.

**[M]** There is no need to compact again. The compaction request is built in `local/memory.ts` with its own
`SUMMARY_RULES` and does not see the narrator's `SYSTEM`. The recall-question request overwrites `request.system`
with its own text (`memory-probe.ts:233`). In `generation.ts:123-128` the length of `SYSTEM` enters both sides of
the size comparison as the same addend. **A change to `SYSTEM` cannot change either the memory or `score`.**

**[D]** The price of a `SYSTEM` variant in a fair comparison: today ≈11 minutes of GPU per variant-sample
(9 compactions + 3 recall + 22 scenes), that is 5 variants × 3 samples ≈ 165 minutes ≈ **$1.7**, which is more
than half of the remaining credit of $2.7. With a `system` field in the batch file: the same 330 scenes at 8–11 s
each ≈ **55–75 minutes ≈ $0.6–0.75**. The saving is **$0.9–1.1**, not "$1.1–1.3": variants with different `SYSTEM`
lose the shared prefix and each one pays for its own prefill (6 thousand tokens ≈ 2.5–4.6 s at 1290–2300 tokens/s),
so the batch costs **+25…+55 %** more than a batch of tails.

### 1.4 A long batch cannot be recovered — this is the main conflict with per-minute billing

**[M]** `labScenes` is created empty inside the loop over modes (`memory-probe.ts:146`). A trap is skipped if its
**base** scene is present in `current.traps` (:153). `saveLab` (:147-150) overwrites
`lab/<variant>-<sample>/report.json` completely with what the current process has accumulated. After `--resume`,
the very first `saveLab` cuts the variant reports down to the traps written after the resume, **without a single
error**. The judge will then compare variants on different sets of traps.

**[M]** The second break: the recall-question block (`:228-257`) stands **before** `writeTraps(undefined)` (:259),
and `truncated_recall` / `invalid_recall` / `TypeError` go to the outer catch and end the process with exit code 1.
There are **17 after-story traps out of 22** (battle 7 of 12, dance 6 of 6, chess 4 of 4), and a batch runs over
one scenario: for dance and chess one recall failure kills the whole batch.

**[D]** The price of one such failure at $0.6/hour is **$0.4–0.7** (40–60 minutes). A workaround with zero lines
of code exists (copy the `lab/` directory before `--resume` and merge afterwards), but it is manual and easy to
forget while the GPU is running.

### 1.5 Recomputing memory between runs

**[M]** Compactions are 844,278 of 1,892,286 tokens of the paid Gemma channel on 18 September (44.6 %) and 140 of
270 requests (51.9 %). For `openai-small` they are 867,373 of 2,026,057 with a cap of 2,250,000 (the channel is
90 % used).

**[D, correction]** This is the share for runs **without a judge**. In a judged run, 3 compactions ≈ 54 thousand
tokens against 22 scenes × 6–7 thousand ≈ 140 thousand, so compaction is about **25 %**, and "two runs instead of
one" is true only for memory runs. On the GPU, 9 compactions of three scenarios take **≈3 minutes ($0.03)**, not
5–10 minutes per variant: inside one batch the compactions are already shared by all tail variants. A memory bank
saves **between** runs (repeated micro-batches, debugging, a repeat after a failure). More important than money, it
**removes the variance component "different memory in different arms"**, which the log of 19 September itself
recorded as a limitation of the measurement.

### 1.6 Wasted work of failed cells

**[M]** In cells that later failed, **255 thousand tokens and 50 compaction requests** were wasted (12.6 % of
tokens, 15.7 % of requests) in one day, 18 September; five runs gave `score` 0. But by code: `invalid_memory` is
172 of the 255 thousand, and this is exactly what the eval counts as a signal ("a mode that did not finish answers
nothing", `eval.ts:136`), and the probe already repeats a compaction up to three times. `invalid_stream` wasted
0 tokens, `provider_failed` is already repeated up to 20 times inside the probe, and `deadline` did not happen
once that day. **The purely recoverable loss is `probe_failed`: 62.8 thousand tokens, 2 cells.** The gain from
`--resume` in eval is four times smaller than claimed. The value is elsewhere: one random failure no longer zeroes
the whole run through `Math.min` over models.

### 1.7 Precision: where we deceive ourselves

- **[D]** The holdout pack's "105 observations" are 35 questions × 3 samples, and the samples of one trap almost
  always give 0/3 or 3/3. The effective sample size is **the number of traps (~30), not 105**. A binomial interval
  over 105 is narrower than the true one by a factor of about **√3 ≈ 1.7**.
- **[M]** The measure is almost degenerate in the expected answer: in `examples/scene-traps.ts` there are
  **25 questions, 24 expect `yes` and exactly one expects `no`** (`seal_early_worked`). A dummy judge that says
  "always yes" gets **24/25 = 0.96**. On the saved corpus of verdicts (240 of them) the real judge scored
  215/240 = 0.896, and "always yes" scored 228/240 = 0.950: **the dumb judge beats the real one**. The judge's
  bias toward "yes" moves `sceneScore` more than any effect after the accepted rule (94 against 93 out of 105).
- **[M]** The judge's own noise has **never** been measured. Only the disagreement between judges is known: 4 of 40.
  **[D]** With a 5 % share of changed verdicts on 105 questions, the sd of the score = 2.2 questions and the sd of
  the difference between two runs = 3.2. So the difference "`rule` 94 against `short` 93" cannot be told from noise
  in principle.
- **[D]** Power (simulation from `eval-economics-proposal.md`, §2.2, I did not recompute it): the current
  35 questions × 3 samples reliably catch only **concentrated** effects from +10 percentage points (pp), that is
  5–6 flipped traps. No budget of samples will prove three flipped traps.
- **[M]** The acceptance rule "`score` or `sceneScore` went up" in `improve-loop.md:39` is conjunctive (the second
  measure did not fall, no model fell, three runs per side). The criticism "it fires in 75 % of cases under the
  null" is **wrong** and is not included in the plan. The real weakness of `Math.min` is different: the minimum
  tracks one model and absorbs its downward tail (log of 18 September: `gpt-5.4-mini` fell from 24–25 to 15 out of
  36 without a probe error), and one such run zeroes the comparison.

### 1.8 The judge: expensive not in money but in its place in the schedule

**[M]** The median per trap for hosted judges is 1.1–1.5 s. For Opus, over 28 intervals, the median is 1.44 s but
the **mean is 5.11 s** (one interval was 101 s). The judge is called **per trap**, not per question: a batch of
5 variants × 3 samples × 22 traps = **330 calls**, and for one scenario (battle) it is 180.

**[D]** 180 calls at the mean of 5.1 s ≈ **15 minutes**. With per-second billing this is zero dollars, **if the
machine is already turned off**: scenes are written to the local disk, `scene-judge.ts` works offline on the saved
report and runs on a subscription. There is one danger: judging without turning the GPU off.

### 1.9 Summary of losses

| Loss | Estimate | Type |
|---|---|---|
| 3 requests in flight out of 5 slots | 20–30 % of batch time, ≈$0.10 per 330 scenes | [D] |
| `SYSTEM` variant through a worktree + full eval | $1.7 against $0.6–0.75 for the same ladder | [D] |
| A batch does not survive `--resume` or a recall failure | $0.4–0.7 per failure | [M] mechanics, [D] price |
| Compacting memory again between runs | ≈3 min ($0.03) per run + an extra variance component | [M]+[D] |
| Recoverable part of failed cells | 62.8 thousand tokens (not 285 thousand) | [M] |
| Precision counted over 105 instead of ~30 traps | intervals narrower than the true ones by a factor of 1.7 | [D] |
| Yes-bias of the judge | the "always yes" baseline = 0.96 against the real 0.896 | [M] |
| Unmeasured judge noise | ±3 pp of unaccounted variance | [D] |
| The GPU waits for the judge | $0.01 per minute of waiting, up to $0.15 per session | [D] |

---

## 2. Statistical protocol of a comparison (follow it literally)

**S0. Before the batch, in writing, in the log.** One hypothesis in one sentence. **One primary measure** (usually
`sceneScore`, mode `plain`) and **one primary model** (the production Gemma on the GPU). The expected direction of
the shift. How many traps the hypothesis can physically flip: this is counted from past `report.json` files without
a model. **If it is fewer than five, the experiment is not run** (§1.7: it cannot be proven with any budget of
samples).

**S1. Unit.** The unit of pairing and resampling is the **trap**. Questions inside one trap share one scene and
are correlated. Samples of one trap are almost deterministic. No McNemar test over "questions" and no binomial
interval over `questions × samples`.

**S2. Pairing on three axes at once.** One memory bank, one list of traps, one judge for all arms of the batch.
Only the text of the variant differs. Arms that were taken with different memory runs or different judges are not
compared.

**S3. Composition of a batch.** The base (empty tail) is always required. Screening: all variants, `samples: 3`,
traps from `only`. Confirmation: the winner against the base, **all** traps, `samples: 5`. Do not take more than
5 samples: power is bought with the number of discriminating traps, not with the number of samples.

**S4. Test.** A permutation test over traps: for each trap take the difference between the pass rates of the two
arms, permute the arm labels **inside the trap**, 10,000 permutations, the statistic is the mean of the
differences, the hypothesis is one-sided. Next to it, a cluster bootstrap over traps: a 95 % CI for the difference
of rates. The conclusion is written as "+16 pp, CI [+8, +23], p < 0.01", not as "74 against 62".

**S5. Required companions of the number** (all are computed by code, without a judge and without a GPU):
- contribution per trap: how many points of the difference each trap gave. This shows whether the effect rests on
  three traps or is spread out;
- **control traps as a separate number** (in the open pack `seal_allowed` gives two questions; `colors_right`,
  `gold_silver`, `count10_pause` are neutral): the winner must not make them fail, otherwise it has simply learned
  to refuse;
- `judgeYesRate` and the "always yes" baseline over the same set of questions (§1.7);
- the share of `truncated` (a truncated scene fails all questions of the trap without a judge call,
  `scene-judge.ts:38`).

**S6. Discard traps that were not written.** `scene-judge.ts:38` sets `pass: false` for all traps of the fixture
that are missing from the report. With `lab.only` the denominator is inflated by phantom failures. The analyzer
must count only the traps that were actually written.

**S7. Order of acceptance.** A closed procedure: screening (a search, p-values are not declared) → confirmation
(permutation test, one pair) → the holdout pack once, with the side declared in advance. Exactly one variant goes
to the holdout pack. Every access to the holdout pack is written to the log as a separate line with a counter: at
α = 0.05 and eight looks, the probability of at least one false win is 0.34.

**S8. What the protocol does not change.** `Math.min` over models in `eval.ts` stays: "the worst model decides" is
the declared goal, not an estimate of the effect (`improve-loop.md:7`). The proposal to take the median of paired
shifts instead of the minimum is **rejected**: under the null hypothesis any statistic goes up in 50 % of runs, and
this is not a defect of the minimum. The rule "at least three runs per side" stays for full eval runs, where memory
is compacted again every time.

**S9. What is not allowed.** Selecting traps by the observed spread between arms and then measuring new variants
on the same data: this is selection on noise (with 3 samples the standard error of a rate is 0.27–0.29).
Discarding traps that "nobody ever passes": `turn15_crates_35`, `turn9_agata_in_dark`, `debt_remainder` are work
for memory and the subject of the next step of the loop. The `only` field is used as a list of **known
discriminating** traps, and the final number of the winner is taken from the confirmation run on all traps.

---

## 3. Ranked list of changes

★ means do first. **[O]** means it requires the owner's decision (a file from the section "What may not change" or
a rule of the loop).

### ★1. A flat request pool in lab mode + `ms` and `cachedInputTokens` in the scene row

**What.** In `local/memory-probe.ts`, put the "variant × sample" pairs of **one trap** into one list and keep
exactly `lab.parallel` requests in flight instead of `floor(parallel/samples)` chains. The pool is **inside a
trap**, not across traps: `beginJob` does not allow two jobs at once, and mixing traps would need a rework of the
job handling. In the same change: the fields `inputTokens`, `cachedInputTokens`, `outputTokens`, `ms` in
`progress({event:'lab_scene'})`. Separate the prefill time from the request time (`llama.ts:165-176` makes a
separate POST to tokenize the prompt).

**Gain.** [D] 8 s → 5.7–6.5 s per scene: a batch of 330 scenes goes from 44 to 31–36 minutes, $0.44 → $0.31–0.36.
The fields in the log close the question "is the prefix shared" for good and give the price of any future change
in seconds.
**Effort.** S (half an hour). **Risk.** Low: do not touch the non-lab branch; the behavior of the eval does not
change.
**Check.** The same batch before and after: seconds per scene in `lab_scene`,
`nvidia-smi --query-gpu=utilization.gpu`. For the second and later variants of a trap, `cachedInputTokens` must be
close to `inputTokens`.

### ★2. A `system` field in the batch file (and a fix for the choice of the "official" scene)

**What.** Allow a variant to have `system?: string` next to `tail` (validation as for `tail`). Required
companions: (a) fix `if (!variant.tail) first ??= written[0]` at `memory-probe.ts:175` to
`!variant.tail && !variant.system`, otherwise a `SYSTEM` variant will become the official scene of the report;
(b) store in the batch file a hash of the current `SYSTEM` from `prompt.ts` and fail on a mismatch, otherwise the
copy will silently diverge from the code; (c) keep one request in flight **per variant**, so that each slot keeps
its own prefix. This is a rewrite of both loops, not one line.

**Gain.** [D] A ladder of 5 variants × 3 samples: $1.7 → $0.6–0.75 (§1.3). Also, the confound "different memory in
different arms" disappears: the comparison "rule at the end of the message against rule in `SYSTEM`" becomes paired
for the first time.
**Effort.** M (not "~10 lines"). **Risk.** Medium: loss of the shared prefix, +25…+55 % to the batch time. Do not
mix `system` variants and `tail` variants in one batch: the time becomes unpredictable.
**Check.** A positive control, not a reproduction of a null: the same base, given once as a tail and once as the
`system` field, must give one number; a known effect (the rule at the end of the message) must reproduce in the
same run. Reproducing "31 against 32 out of 45" proves nothing: a broken mechanism would give the same.

### ★3. Make the batch interruptible: merge `lab/` on `--resume` and make recall non-fatal

**What.** At start, read the existing `lab/*/report.json` files into `labScenes` (checking `model` and `scenario`)
and track the finished triples "trap × variant × sample" instead of checking one base scene. Separately: in
`--lab`, make the recall questions optional (`"recall": false`) or non-fatal: write the error code to the report
and go on to write the traps.

**Gain.** This is the reason per-minute billing makes sense at all: a batch can be cut into pieces of 15–20
minutes, the machine can be stopped between them, and the batch can be continued. Today one failure costs
$0.4–0.7 and a full rerun.
**Effort.** S (~40 lines with a test in `local/memory-probe.test.ts`). **Risk.** Low: the change is in the purely
lab path (`--lab` is marked in the code as research). The non-fatal recall **must not** leak into the normal path,
otherwise a memory failure will stop zeroing the cell, and that would be a change to the eval.
**Check.** Write a batch of two traps, interrupt it after the first, continue: `lab/<variant>/report.json` has both
traps, and the judge counts the same number of questions as in an uninterrupted run. Feed in a recall that is
known to break: the batch writes all traps and returns an error code in the report, not exit code 1.

### 4. A read-only batch analyzer `local/lab-stats.ts`

**What.** A new file that only reads finished `lab/<variant>-<sample>/report.json` files and `verdicts`, with not a
single model call. It prints: the permutation test over traps, the cluster bootstrap CI, the contribution of each
trap, separate columns "false premise" and "control", `judgeYesRate` and the "always yes" baseline, the shares of
`truncated`. It must discard traps that are missing from the report (§2, S6). The pairing check is "the `lab/`
directories are inside one probe directory"; `sourceHash` is not suitable for this (it is the same for any two
runs of one scenario).

**Gain.** Turns "74 against 62" into a number with an interval and a p-value. Costs 0 seconds of GPU and
0 requests.
**Effort.** M (~150 lines + a test on a synthetic matrix). **Risk.** Low. The risk is in interpretation: the test
is valid only inside one memory run.
**Check.** A placebo arm, or two arms with the same text under different keys: p must be uniformly distributed and
the CI must cover zero. **There is nothing to apply it to retroactively**: there is not a single `lab/` directory
on the machine (I checked: 45 directories `/tmp/simple-chat-memory-*`, none of them has a `lab/` subdirectory). The
tool works only on future batches.

### 5. Deterministic measures of scene shape (`local/scene-shape.ts`)

**What.** A read-only script over the same reports: characters, paragraphs, sentences, `truncated`, validity of
the timestamp, the share of 5-grams repeated from previous scenes, a rough lexical sign "the narrator objects to
the player". Numbers per variant and per trap. Text output only with an explicit flag and never for `--pack`.

**Gain.** The ongoing experiment about scene length gets its own measure. Length is a continuous value (over
72 Gemma scenes on `battle` the mean is 2056 characters, sd 201, CV 10 %), so a 20 % shift is caught with
**4–8 scenes per side** against 75 judge questions. The descriptive half of the question is already closed **for
free, retroactively**: of 213 saved trap scenes, those longer than 12 paragraphs are Gemma 27/90 (30 %),
`gpt-5.4-mini` 32/66, `ministral` 17/36, `haiku` 7/21. So the `SYSTEM` requirement "no more than 12 paragraphs" is
followed about half of the time. (The opposite claim about the frozen scenes is a counting error on the timestamp
line: of 48 reference scenes none breaks the limit, and they were written by an agent outside the bot, so `SYSTEM`
did not act on them at all.)
**Effort.** S–M. **Risk.** The heuristics for paragraphs and for "corrections" are rough: they are good for
comparing variants and as a signal "look with your own eyes", not as an acceptance measure. Self-repetition **along
the story** is not measured this way at all: in all probe modes the story is committed with frozen scenes, the
model does not write it. Self-repetition lives only in the live log.
**Check.** A manual recount on `examples/frozen/*.json` (battle: 16 scenes, median 2148 characters, 16/16 valid
timestamps, 5-grams median 0.000, maximum 0.0115).

### 6. A bank of ready memory keyed by hash **[O]**

**What.** A flag `--memory <path>` in `--lab`: take ready `state`, `compactions`, `through` from another run's bank
report instead of doing three compactions. The key is `sha256(frozen.json)` + the hash of `local/memory.ts` + the
model + the mode; on a mismatch the bank is rejected. The cacheable request is selected **by shape**
(`outputSchema` with `facts`/`evidence`), not by `purpose`: the recall-question request also has
`purpose: 'memory'`, and caching it would freeze `score`. On a hit, the `compaction_request_completed` row must be
marked "from the bank", otherwise the log will stop matching the ledger.

**Gain.** [D] 3 minutes ($0.03) on every repeated run and micro-batch. The main point: it removes the variance
component "different memory in different arms". On the hosted path it is 45 % of the tokens of a **memory** run and
~25 % of a judged run.
**Effort.** M. **Risk.** Medium and named: the wrong memory, if substituted, silently makes the comparison
worthless. This is why there are hashes and a rejection on a mismatch. The bank for the holdout pack is stored next
to the pack, and the agent that runs the loop does not read it.
**Why it is the owner's decision.** `improve-loop.md:34` requires a baseline from **the same day**: the bank is
legitimate only within one day, or it needs an explicit exception in the rule.
**Check.** Run a batch twice, with a cold bank and a warm bank: the memory facts match byte for byte, and the time
falls by the time of the compactions. Change one letter in `memory.ts`: there must be a miss and a full recompute.

### 7. Judge noise and its yes-bias: three re-judgings and two numbers **[O]**

**What.** (a) Free and without code: `cp -r` the probe directory three times and run
`npm run eval -- judge --resume <copy> --mode plain` three times; count the share of questions where the verdict
changed (`p_flip`). Do the same for the second allowed judge. (b) Print `judgeYesRate` and the constant "always
yes" baseline next to `sceneScore`. This is computed from the `actual` fields that are already saved and needs no
new measurements. (c) For new traps, keep the share of questions with an expected `no` at one third or higher.

**Gain.** `p_flip` is the number without which the rule "at least three runs" gives no protection: at 5 %, a
difference of 1–3 questions out of 105 cannot be proven in principle. The yes-bias is invisible today but costs up
to 0.12 of `sceneScore`, which is more than any effect the loop is looking for now.
**Effort.** S (re-judging), S (numbers in the report). **Risk.** Re-judging measures the noise of the **judge**,
not the noise of the measure. Name it honestly.
**Obstacle [M]:** `eval.ts:203` does not pass `packArgs` to `scene-judge`, so a report on the holdout pack cannot
be re-judged through `eval judge`. A direct call of `local/scene-judge.ts --pack` is needed.
**Why it is the owner's decision.** The judge and `scene-judge.ts` are the eval. A change to the set of questions
is even more so.

### 8. A server profile for batches: one measurement instead of guesses

**What.** Add to `gpu/serve.sh` a variable for the KV type next to the existing `SIMPLE_CHAT_GPU_SLOTS` and
`SIMPLE_CHAT_GPU_UBATCH`, and run a micro-batch once (chess, 4 traps, 2 variants, 3 samples = 24 scenes) on these
configurations: A — as now; B — A + KV `f16`; C — B + client concurrency = the number of slots (item 1);
D — C + `--ubatch-size 512`; then repeat A as a drift control. Write the result to the manifest forever.
Do not touch `--cache-reuse`, `--swa-full`, `--ctx-checkpoints 0`; do not bring back `n>1`.

**Gain.** [A] 1.2–1.8× on decode, that is on 95 % of the cost (§1.1), if the hypothesis about `q8_0`
dequantization at ≥3 slots is true. The ceiling is hard: the measured 39 tokens/s is 55 % of the memory bandwidth
(≈71 tokens/s), so more than 1.8× cannot come from anywhere.
**Effort.** S (script change), 30–35 minutes of GPU and $0.30–0.35 for the measurement, **not 20 minutes**: every
micro-batch pays again for three compactions (~60 s) and a server restart that reads the weights again.
**Blockers [M], without which the measurement will measure the old configuration:** `ensure-server.sh` restarts
nothing (`flock`, the new process silently dies), so the old server must be killed and `/props` checked; the client
checks `n_ctx >= config.contextTokens` (`llama.ts:190`), so ctx cannot be lowered without a change to `.env.gpu`;
when ctx/slots < prompt+output, a configuration without `--kv-unified` does not start at all.
**Check.** A table "configuration → seconds per scene → utilization.gpu → VRAM". The repeat of A must differ from
the first A by less than 10 %.

### 9. `eval` continues a failed cell **[O]**

**What.** `eval.ts:131` starts the probe without `--resume` and in a new `mkdtemp` every time. Create a run
directory with a subdirectory per cell, pass it as `--resume` on a repeat, and repeat a cell 1–2 times for codes
that pass on a repeat (`probe_failed`, `deadline`, transport codes). Write the number of repeats to the final file
next to `compactionRetries`.

**Gain.** [M] The return in tokens is modest (62.8 thousand, §1.6), but one random failure stops zeroing the whole
run through `Math.min`.
**Effort.** M. **Risk.** Repeating a failed cell biases the sample toward lucky attempts. This is why the repeat
counter in the report is required. `invalid_memory` **must not** be repeated: it is a signal of the measure, not
a failure.
**Check.** Kill the probe in the middle of the second scenario and restart eval with the same directory:
`logs/eval.jsonl` has no repeated `compaction_request_*` for compactions that were already computed, and the final
numbers match an uninterrupted run.

### 10. A numeric signal from live play

**What.** In `local/bot.ts`, add to the `scene_saved_and_sent` event: `elapsedMs` (a timer must be added: now only
compaction is timed, `generation.ts:40`), `outputCharacters`, `inputTokens`, `outputTokens`. All four are already
in the whitelist at `local/model-error.ts:11-14`. New fields for the whitelist: `paragraphCount` (integer),
`truncated` (boolean), `dateChanged` (boolean), `promptVersion` (integer). New events: `generation_cancelled` (now
a cancel writes no row at all) and `branch_forked` with `rolledBackScenes`. The latter is the most honest cheap
sign of dissatisfaction with a scene that does not need reading a single line of the story.

**Gain.** Today exactly nothing is known about the quality of live play: `scene_saved_and_sent` has no numeric
field at all. With per-minute billing, `elapsedMs` is directly money.
**Effort.** M. **Risk.** Privacy: only integers, booleans and enums. **`repeatPercent` is deliberately not in this
list**: it is a statistic derived from the text of the tester's story, and it needs the owner's word. `stamped`
(the model put the timestamp itself) is not included: over 213 saved scenes the timestamp is valid in 213 of 213,
so there will be no signal.
**Check.** `npm test`; after one scene, a row with `elapsedMs>0` and `outputCharacters>0`; a grep for Cyrillic in
the new fields gives zero.

### What requires the owner's decision, as a separate list

1. **The memory bank** against the rule "baseline from the same day" (`improve-loop.md:34`) — item 6.
2. **`eval.ts`**: `--resume` of a cell (item 9), a separate number for control traps (`controlScore`), a
   `truncatedScenes` counter, `judgeYesRate`. All of this is the eval.
3. **`scene-judge.ts`**: incremental saving of verdicts (now they are written once at the end, and a failure on
   the ninth trap of twelve throws away all the work), passing `--pack` to `eval judge`.
4. **The set of traps** (`examples/scene-traps.ts`): twins with a **true** premise (there is not one such trap, so a
   false "correction" by the accepted rule is physically not measurable today); a share of questions with an
   expected `no` of one third or higher; an expansion from 25 to ~50 questions in the classes "counters" and "who
   knows what". Any addition resets comparability to zero and requires a new baseline and a new revision of the
   public dataset.
5. **The frequency of access to the holdout pack** and who starts it. Selecting variants on the holdout pack would
   take away the loop's only blind score; a counter of looks is the minimum.
6. **Calibration of the proxy** (§5): 0.8 million tokens is more than the daily cap of the paid Gemma channel, so
   it is either two days or a manual limit, and the agent that runs the loop is forbidden to do that.
7. **The interruptible rate** ($0.25/hour against $0.6) is reasonable only **after** item 3, otherwise a
   preemption silently corrupts the variant reports.
8. **Passing `seed` in `local/llama.ts`**: this is not the eval, but it is the bot's production adapter. At
   temperature 0.8 a common seed by sample index removes part of the variance of the difference. [A] the size is
   not measured.

### What was considered and rejected (so that it is not proposed again)

- **A two-level judge** (a cheap first pass, Opus on disputed cases): a full run is 88 calls of 1.2–1.5 s each,
  free on the subscription. The cheap judges have already hit their daily limits, their errors are correlated (both
  miss a violation), and the requirement of a verbatim quote pushes a weak judge toward "yes", which is exactly the
  bias we defend against. Also, all baselines would have to be taken again.
- **A race of variants with elimination**: with the current 25 questions it saves 17 % of a batch ($0.085) against
  a day of work and a required confirmation run. The point "one third of the samples" does not exist in the code
  (the loop runs with the trap as the outer level).
- **Selecting traps by observed spread** and discarding "nobody passes" traps: selection on noise and blindness to
  the work of memory (§2, S9).
- **A table of thresholds instead of the rule "more than the noise"**: the threshold is not a property of (K, m,
  arms) but a function of the observed rates; the permutation test computes it exactly.
- **The median of paired shifts instead of `Math.min`**: it changes the declared goal, not the estimate (§2, S8).
- **A move to vLLM/SGLang or another quant as production**: the production model is published only as GGUF. The
  path through AWQ/FP8 needs ~62 GB of source weights and a separate quantization (≈$1 out of $2.7) and gives a
  **different** model, on which all previous numbers are reset to zero. Q4 is allowed at most as a filter with
  confirmation on Q6, and it costs +17.4 GiB of disk, which conflicts with reducing the disk.

---

## 4. Template of a GPU session with per-minute billing

The unit is a **session of any length with a fixed entry price**. What is optimized is scenes per dollar, not
filling the hour. Four numbers: entry ≈$0.15 (15 minutes of preparation) **plus traffic $0.07–1.00 for 25.2 GB**;
a minute of work $0.01; a minute of idle time also $0.01; a minute of a stopped machine $0.00028.

### Before the session (free, on the bot's machine)

1. The batch files are ready and validated: `screen.json` (all variants, `only`, `samples: 3`) and `confirm.json`
   (the winner against the base, all traps, `samples: 5`). The second file is edited by one line when the winner is
   known.
2. The holdout pack is downloaded in advance (`local/pack-hf.ts pull`), if it is needed; `npm test` and
   `npm run check` have passed.
3. **Dry run**: replay the scenes and build the requests, printing their sizes, **without calling the model**. The
   most expensive rental mistake is a typo in the batch JSON that is found at the tenth minute.
4. The queue is one command (`queue.sh`): the session starts with a launch, not with thinking. Thinking while the
   GPU is running costs $0.01 per minute.
5. Count the scenes in the queue. **Fewer than ≈115 scenes: the session is not justified** (the entry is more than
   half of the bill); the question is postponed and accumulated. It is good from ≈340.
6. Put extra samples of the **base** arm at the end of the queue: this is the cheapest power there is.
7. Choice of machine: compare offers by the sum "rate + traffic", not by the hourly price (`docs/gpu.md`: traffic
   prices differ by a factor of 20). The network link is checked in the first minute with the existing
   `gpu/progress.sh` (it prints Mbit/s and the remainder): below ~300 Mbit/s, delete the instance and take the next
   one; the test costs ~$0.01.

### On the machine

| Minutes | GPU | In parallel on the bot's machine |
|---|---|---|
| −15…0 | bootstrap: the build and the download of weights run at the same time, watch `progress.sh` | check of the link speed in the first minute |
| 0…2 | `model:probe`, `gpu:diagnose --watch 30` | — |
| 2…8 | **only in the first long session**: measurement of the server configuration (§3.8), write the result forever | choice of configuration |
| 8…11 | 9 compactions, writing the memory bank (once per revision of the memory code) | — |
| 11…30 | screening batch | judging of ready `lab/*` directories, 4 processes |
| 30 | **stop the machine** if the analysis takes more than three minutes | the rest of the judging, permutation test, choice of the winner |
| +0…25 | start from the stopped state (~2 min), confirmation batch | judging |
| end | `gpu:diagnose --pull`, then stop or delete | — |

The rule of the session: **only what cannot be done without a GPU runs on the GPU, and only for as long as the
queue runs.** A pause longer than three minutes means a stop, not idle time: idle time is $0.01/min against
$0.00028/min, and even two minutes for a restart pay off.

**Stop or delete.** The threshold = (cost of preparing again) ÷ $0.017 per hour of storage. Preparing again =
$0.15 + traffic. On a machine with cheap traffic, $0.22 → **threshold ≈13 hours**. Counted without traffic (a
machine where traffic costs almost nothing) it is ≈7 hours. On a machine with expensive traffic, $1.13 →
≈66 hours, so deleting such a machine almost never pays off. (This is a disagreement with
`eval-economics-proposal.md`, which names one threshold of 7 hours: it is correct only with free traffic.) The risk
of keeping the machine stopped is that another renter may take the GPU, so a backup offer is chosen in advance.

### After turning off (free)

1. Judge the rest of the `lab/*` directories (in parallel, 4 processes; `scene-judge.ts` needs a fresh copy of the
   directory for every repeated judging, because it overwrites `verdicts`).
2. `lab-stats`: permutation test over traps, CI, contribution per trap, **control traps separately**,
   `judgeYesRate` and the "always yes" baseline, the share of `truncated`.
3. `scene-shape`: paragraphs, characters, truncations, repetitions, over the same reports.
4. The session bill: minutes of rental, the actual Vast bill, scenes, **$ per scene**. Compare with $0.0013 and
   write it down.
5. An entry in `improve-log.md`: the hypothesis, numbers with intervals, the decision, **how many looks at the
   holdout pack were spent**, how many cell repeats happened.

---

## 5. The proxy → GPU funnel and when to trust it

**The original "turn the funnel over: GPU by default" is rejected.** It does not win on price: $2.7 on Vast is a
non-renewable reserve (≈4 hours of GPU, 3–4 sessions forever), and the hosted channels are a renewable daily flow,
in which only one channel of four costs money. A gain of $0.0009 per scene is $0.30 for the whole ladder.

The correct split is **by validity, not by price**:

| Question | Where to measure | Why |
|---|---|---|
| Which of N rule variants is better | **GPU, lab batch** | The production model; no daily cap; pairing on memory, traps and judge. [D] the ceiling of the proxy is ≈90 trap scenes per day on the paid Gemma channel (6.5 thousand tokens per scene out of 600 thousand) |
| Does the change break other model families | Hosted, full eval | The goal of the loop is "work on any model" (`improve-loop.md:7`) |
| Questions about memory and the compaction schema | Hosted | One memory run over three scenarios ≈64 thousand tokens: 9 runs per day |
| Is the wording clear to a weak model | `openrouter:liquid/lfm-2.5-2.6b:free` | Free |
| Is the recorded story usable | `eval ceiling` | Cheap, but **not free**: on 18 September `ceiling` itself hit the limit |
| Acceptance of an accepted change | GPU with production settings | `improve-loop.md:96` |

**When the proxy can be trusted is not known yet, and one measurement closes this.** Run the same ladder of
variants on the hosted Gemma with the same lab code (`--direct` works with any provider) and compute not one number
but a 2×2 table for each trap key: fails on the proxy × fails on the GPU. This gives the sensitivity and the
specificity of the proxy **as a filter**. Write the result as a rule: "the proxy is allowed as a filter for keys
X, Y, Z; the effect size is never transferred from it".

Caveats for this measurement, without which it will not start:

- **[M]** "Take the ladder again on HEAD" is impossible: after commit `9c32c26`, `makeRequest` appends
  `NARRATOR_RULE` unconditionally (`prompt.ts:56`), and the tail of a variant is attached **after** it, so an arm
  "without the addition" does not exist. Either a worktree on the parent of the commit is needed, or the `system`
  field from item 3.2.
- **[M]** Calibrating against batch 3 (31/32/29 out of 45) is impossible: there is no signal there on the
  production side, and agreement of the sign with a null reference is not defined. Calibrate against batch 1
  (62 → 74 out of 75).
- **[M]** 0.8 million tokens is more than the daily cap of the paid channel: **the owner's decision** (§3, owner's
  list, item 6).
- **[D]** The memory of the proxy is built by its own compaction and differs in content from the memory of the
  production model: "the key fails on the proxy" may mean "the fact is not in its memory". For traps with a false
  premise this does not matter; for numeric traps it matters.

**Failure criterion of the funnel, declared in advance:** the keys that the base on the GPU fails 0 of 3
(`healer_still_broken`, `castle_corrected`, `samira_corrected`) must also fail for the base on the proxy. If the
proxy passes them, it is blind to the main class of errors and is not usable as a filter at all.

---

## 6. New measures and a signal from live play

**Measures that are computed by code over scenes that are already paid for** (not a single model call):

1. **Length and paragraphs**: a continuous measure instead of a binary one: 4–8 scenes per side against 75 judge
   questions (§3.5). The ongoing experiment about length gets its own measure; half of its question is already
   answered retroactively (30–48 % of scenes are longer than 12 paragraphs for four models).
2. **The share of truncations** next to `sceneScore`: a truncation fails all questions of the trap without a
   judge. Today there is no risk: 0 truncations in 152 scenes, median 1989 characters (~745 tokens) with a limit of
   4096, a margin of 5.5×. But a variant "without a length limit" must print this number. It **cannot be checked
   through eval** by lowering the limit: `eval.ts:85` removes all `SIMPLE_CHAT_*` variables from the environment of
   the child process; only a direct call of the probe works.
3. **`judgeYesRate` and the "always yes" baseline** (§1.7): computed from the `actual` fields that are already
   saved.
4. **Control traps as a separate number**: protection against a narrator that has simply started to refuse.
5. **Contribution per trap**: shows whether the effect rests on three traps or is spread out.
6. **Self-repetition**: it can be computed, but **the probe has no data source for it**: in all modes the story is
   committed with frozen scenes, and the model writes only trap scenes from one state. The measure lives only on
   the live log or on a fresh `eval write`.

**A signal from live play** (item 3.10 plus what requires the owner):

- Numbers in `scene_saved_and_sent` and the events `generation_cancelled` / `branch_forked`: a distribution of
  live play, which does not exist at all today.
- **Buttons under a scene (👍/👎 with a reason chosen from an enum)**: the only signal that directly names a
  property that the measure missed. Two corrections to the original proposal. (a) "Rewrite" does **not** reduce to
  the existing `fork`: `commitTurn` sets `branch.head` to the new node **before** the checkpoint is saved, so the
  checkpoint «Сцена N» ("Scene N") points to scene N itself, and a branch from it continues the story instead of
  rewriting it. A new path from `node.parent` is needed. (b) Statistics: with a 👎 share of 20 % against 10 % and
  30 scenes per side, the sd of the difference is ≈9 pp. A "live A/B of prompts" will not work, because the prompt
  version changes together with the stage of the story. The value of the buttons is a generator of hypotheses
  about which measure to build next, not a measure.
- **A register of the tester's error classes**: a row is an error class; the columns are the evidence (the
  tester's words retold as a class, **without quotes or excerpts**), the frequency, whether a trap key exists, the
  established cause class, and the cheapest tier that can answer. Admission rule: a hypothesis does not enter the
  funnel until the cause class of its target keys is established by free means (`eval ceiling` and the field
  `stated: memory|scenes|none`). Half of this is already in `improve-loop.md:60`; the new part is to turn the
  fixture check into an entry filter for a hypothesis.

---

## 7. What remains an assumption and how to close it

| Assumption | How to close it | Price |
|---|---|---|
| Judge noise `p_flip` (it decides whether differences of 1–3 questions can be told apart) | Three re-judgings of one directory on copies, `eval judge` | 0, no code, ~10 minutes |
| Does llama-server keep the variant's prefix in the slot with different `system` | `cachedInputTokens` in `lab_scene` on a micro-batch of 24 scenes | 3 minutes of GPU |
| Does `f16` KV give the promised 1.2–1.8× on decode | Protocol §3.8 (A/B/C/D + repeat of A) | 30–35 minutes of GPU, $0.30–0.35 |
| Real slot occupancy after the flat pool | `nvidia-smi -l 1` + seconds per scene on the same micro-batch | included in the previous one |
| Does the proxy predict the ranks of variants | 2×2 table by keys, §5 | 0.8 million tokens, the owner's decision |
| τ, the spread of the **effect** between independent memory chains | Three chains give an sd with 2 degrees of freedom (the 95 % CI is multiplied by [0.52; 6.28]); a decision needs 5–8 chains | $0.6–0.9, that is 22–33 % of the credit: **first the free `p_flip`**, then decide |
| Does the effect of the rule depend on context length (eval lives below 8K, the tester goes up to 44K) | Contrast `plain` against `full` on the same traps; but the contrast is dirty (both the length and the presence of memory differ), and the gradient is only 1.5–2×, not 4× | ~$0.15 + a worktree without `NARRATOR_RULE` is needed; the conclusion will be about the direction, not the size |
| Concurrency limits of the Claude subscription for the judge | One launch of 4 processes, watch the `rate_limited` codes | 0 |
| Behavior of Vast on preemption of an interruptible instance (pause or deletion) | One run at that rate with the number of preemptions recorded — **only after §3.3** | $0.25/hour |
| Frequency of error classes for the tester | The register (§6); today it cannot be derived from `logs/`: the rows about scenes carry no number at all | 0 |

**The last and the cheapest.** Of the whole list, exactly three things cost not a second of GPU and not a single
paid request: measure the judge noise, print `judgeYesRate` next to `sceneScore`, and compute the shape of the
scenes that are already written. They should be done before the next rental. Otherwise the next rental will again
buy numbers for which it is unknown whether they can be told from noise.

---

## 8. Criticism and open questions

2026-09-19 · Opus 5 (completeness critic) · read only: no code was changed, no model was called, no GPU was rented,
not a single paid or rate-limited request. I checked the text of the plan against `local/memory-probe.ts`,
`local/scene-judge.ts`, `local/eval.ts`, `local/llama.ts`, `local/model-probe.ts`, `local/prompt.ts`,
`local/budget.ts`, `gpu/serve.sh`, `examples/scene-traps.ts`, `docs/improve-log.md`, against the 51 `scene` rows
from `logs/gpu-q6-final-*.jsonl` and against the 45 probe directories `/tmp/simple-chat-memory-*` (synthetic
scenarios: 230 trap scenes, joined with 266 judge verdicts). The holdout pack, `data/` and `.env*` were not opened.
Markers: **[M]** measured again by me, **[D]** derived, **[A]** assumption.

### 8.1 What was confirmed on recount and what was not

| Claim of the plan | Recount |
|---|---|
| §1.1 decode is ~95 % of a scene | **[M] correct.** On 51 rows: D ≈ 39.5 tokens/s, the decode share at the medians is 0.96, the median of `outputTokens/ms` is 36.6 tokens/s |
| §1.7 "always yes" beats the judge | **[M] correct on a larger corpus too:** 266 questions: judge 0.906, "always yes" 0.955, `judgeYesRate` 0.861 |
| §1.7 the set of questions | **[M] correct:** 25 questions, 24 expect `yes`, 1 expects `no`; 22 traps, of which 17 are after-story (battle 12 with 5 `afterTurn`, dance 6, chess 4) |
| §1.4 mechanics of a broken batch | **[M] correct by the code:** `:146` empty `labScenes`, `:153` skip by the base scene, `:147-150` the file is overwritten completely |
| §6.2 zero truncations at the limit | **[M] correct:** 0 of 230 scenes |
| §1.1 P ≈ 1290 tokens/s | **[M] reproduces only as the speed over NON-cached tokens** (see K2) |
| §3.4 "there is nothing to apply it to retroactively" | **[M] wrong:** it is true that there is not a single lab directory, but 32 mode reports contain 245 trap scenes, and 29 of them contain 266 verdicts. The repeatability of the measure, `judgeYesRate`, the share of truncations and the spread per trap can be computed from them today |

### 8.2 The main hole: the funnel has an empty input

The plan describes the comparison protocol and the economics of a session, but nowhere asks **whether there is
anything left to measure on the open pack**. This is computed for free, from the same 45 directories:

**[M]** The spread of `sceneScore` between runs of one code, `plain`, paid Gemma (I do not distinguish the `SYSTEM`
variants of the ongoing experiment, so this is the spread "between any runs of 19 September"):

| model | battle (out of 15) | chess (out of 4) | dance (out of 6) | total out of 25 |
|---|---|---|---|---|
| `openrouter:google/gemma-4-31b-it` | 15, 15, 14, 14, 15, 14 | 4, 4, 4, 4, 4 | 6, 6, 6, 6, 6 | **24–25** |
| `openai:gpt-5.4-mini` | 11, 14, 12 | 4, 4, 4 | 6, 5, 5 | 21–24 |
| `mistral:ministral-14b-2512` | 11, 10, 12 | — | — | — |

**[M]** 13 traps out of 22 are passed in **100 %** of the saved runs. There are only nine traps that fail at all,
and four fail noticeably: `turn9` 6/12, `turn14` 7/12, `healer` 8/12, `b_total` 7/9.

Consequences that are not in the plan.

1. **The open pack is saturated.** On the production model the accepted rule gives 74 out of 75 (log); on the
   proxy Gemma it gives 24–25 out of 25. The margin is one question. So **a list of "known discriminating traps"
   for `only` (S3, S9) does not exist today**, and the very first screening batch has nothing to compare against.
   The plan must name the source of `only`: a weakened base from a worktree on the parent of `9c32c26` (then it is
   not a screening of new variants but a retake of the old effect), or weak models, or the holdout pack. But the
   holdout pack is for confirmation, not for search.
2. **The S0 gate ("fewer than five flippable traps: the experiment is not run") cannot be met on the open pack in
   principle:** there are only nine traps that can flip, and five of them already pass almost always. By the plan's
   own rule, no prompt hypothesis is allowed to be run now. This is either a ban on work, or an admission that the
   open pack is exhausted and the next step is memory or an expansion of the pack (**the owner's decision**,
   `examples/scene-traps.ts`).
3. **The reserve of signal is where no GPU is needed.** `gpt-5.4-mini` has 3–4 failed questions out of 25, and
   `ministral` has 3–5 out of 15 on battle alone. S0 ("one primary model: the production Gemma") sends the scarcest
   resource to the arm with the smallest reserve and contradicts S8 and `improve-loop.md:7`, where the worst model
   decides. Before paying for the GPU, one question must be answered: are we looking for a rule for the worst model
   (then the test ground is `ministral` and `gpt-5.4-mini`, for free), or are we tuning the production model (then
   `Math.min` in acceptance is not needed).

### 8.3 Unchecked assumptions presented as closed

**K1. "Variants share the KV prefix" is not checked, and the plan's argument does not work.** The plan (section
"Relation to…", item 2) lowers the priority of `cachedInputTokens` on the grounds that the field "arrives and is
non-zero in 41 of 51 rows". **[M]** These 51 rows are a sequential single-slot run of a story: the median
non-cached input is 846 tokens with a median input of 4,668. This is the cache of **the previous request in the
same slot**, not deduplication of identical prefixes of **parallel** sequences under `--kv-unified`, on which the
whole lab layout rests. The assumption remains [A], and it must be checked exactly as the economist proposed: with
a field in `lab_scene` on the very first micro-batch. Also: `gpu/serve.sh` starts the server with `--no-slots`, so
slot occupancy cannot be seen from the server side. There are no other eyes than `cachedInputTokens`.

**K2. The price of losing the prefix is computed in two incompatible ways.** **[M]** On the same 51 rows, the fit
`t = input/P + output/D` gives P ≈ 3,544 over the raw input and P ≈ 1,287 over the non-cached input. The plan took
the second value but applies it to 6,000 tokens, while the median non-cached input in the data is 846 and the
maximum is 5,395, so this is an extrapolation by a factor of seven. **[M]** A fit with a constant on the same rows:
a fixed **1.67 s** per request (the separate tokenization POST at `llama.ts:170` plus queue and SSH), P ≈ 4,300,
D ≈ 43.6. Under this model a lost prefix costs 1.4 s, not 4.6 s. Also, the range "+25…+55 % to the batch time"
from §1.3 divides seconds of **single-stream** prefill by the **net** scene time in a five-slot batch. The honest
wording is: **from +15 % to +55 %, [A]**. This is enough for the decision "do not mix `system` variants and `tail`
variants", but not enough for planning the budget of a session.

**K3. The scheme of the permutation test is not defined, and the "five traps" gate depends on it.** S4 says "the
arm labels are permuted inside the trap", which can be read in two ways. If **whole arms** are permuted (a sign
flip), the smallest reachable one-sided p equals 2^−d, where d is the number of traps with a non-zero difference:
d = 4 gives 0.0625 (winning is impossible with any effect), d = 5 gives exactly 0.031, and only if **all five**
shifted in one direction and none shifted in the opposite direction. If **samples inside a trap** are permuted
instead, the test stops being a cluster test and directly contradicts S1. The first reading must be written down
explicitly, and the S0 gate must be reworded: "five traps **and none in the opposite direction**", otherwise the
realistic threshold is seven or eight.

**K4. The power calculation is imported as a whole and not recomputed** (the plan marks this honestly, but then
relies on it in S0 and §3.5). The tables of §2.2 of `eval-economics-proposal.md` were computed for K = 35 (the
holdout pack). A screening batch runs over `only` with K = 4…9, and the number "five" was carried over there
without a recount. On the open pack, where 25 questions fall on 22 traps, the distinction "the unit is the trap,
not the question" changes almost nothing; the whole correction by a factor of 1.7 is about samples, and only on
the holdout pack.

### 8.4 Contradictions between items

**P1. ★1 and ★2 are incompatible scheduling policies, and the gain of ★1 does not go to the experiment that is
running.** ★1 asks to keep `parallel` requests in flight, mixing variants inside a trap; ★2(c) asks to keep one
request **per variant**, so that a slot keeps its own prefix. The gain "−20…−30 %" is computed for a batch of
tails, but the nearest task is three `SYSTEM` variants (the experiment about scene length), where ★1 does not
apply at all. The order "★1 first" is justified for a batch that is not in the queue.

**P2. The `first ??=` fix in ★2 brings back the extra scene that was deliberately removed on 19 September.** The
log says: "the extra single scene after a trap is removed". **[M]** Mechanics: `memory-probe.ts:182` takes the
official scene of the report as `first ?? await provider.generate(...)`. The proposed condition
`!variant.tail && !variant.system` **will not be true for any variant in a pure `SYSTEM` batch**, and one more
request will be added per trap, sequential and outside the pool: **[D]** 22 traps × ~15 s ≈ 5.5 minutes and ≈$0.06
per batch, that is half of the gain of ★1. A third way is cheaper and more obvious: make the official scene the
variant with a key declared in advance (`base`), or the first one in the list.

**P3. Streaming judging in parallel with the batch (§4, row "11…30") is incompatible with how the files are
written.** **[M]** `saveLab` (`memory-probe.ts:147-150`) overwrites `lab/<variant>/report.json` completely after
**every sample** with the object `{scenario, model, modes}` **without the `verdicts` field**, and
`scene-judge.ts:65-66` writes the verdicts to the same file. So a judging that starts before the end of the batch:
(a) will count all traps that are not yet written as failures (`scene-judge.ts:38`), (b) will have its verdicts
silently erased by the next `saveLab`. "Ready `lab/*` directories" do not exist in the current layout: a variant
directory is ready only at the end of the batch. Either the judging runs on a **copy** of the directory (as §4
"after turning off" already requires), or streaming judging is a change of the layout (a directory per trap), not
"start 4 processes". In both cases the item in §4 must be rewritten, because now it plans rental minutes for work
that will corrupt the reports.

**P4. §5 cannot finish without ★3, and this is not recorded as a dependency.** **[M]** `local/budget.ts` throws
`budget_exceeded` **before sending** the request, and the retry loop of the probe (`memory-probe.ts:100-112`)
repeats only `rate_limited` and `provider_failed` with a transport code. A batch of 0.8 million tokens is more
than the daily cap, so it will hit the limit **in the middle of the run** and lose everything. So §5 requires ★3
and two days, and two days break S2 (one memory bank, one judge, one batch) and `improve-loop.md:34` (baseline from
the same day).

**P5. The failure criterion of the funnel in §5 contradicts the very first caveat of the same section.** The
criterion: "the keys that the base on the GPU fails 0 of 3 (`healer_still_broken`, `castle_corrected`,
`samira_corrected`) must also fail for the base on the proxy". But the "base" from batch 1 is the arm **without**
`NARRATOR_RULE`, and it does not exist on HEAD (the plan itself says so). **[M]** On the current code the proxy
passes these keys: `castle` 8/8, `samira` 9/9, `healer` 8/12 over the saved runs after 19 September. The criterion
in its current wording cannot be applied: it must be tied to the arm from a worktree on the parent of `9c32c26` or
replaced with another one.

**P6. The memory bank and the base arm are judged by different rules.** Item 6 declares it legitimate to take
**memory** from another run by hash, while §2 S3 requires writing the **base arm** again in every batch. But if
matching hashes make the memory comparable, then the base scenes written on the same memory, by the same code and
the same model, are comparable to exactly the same degree. The base is 1/N of every batch: **[D]** with five
variants, a cache of the base arm saves 20 % of all scenes, which is several times more than the $0.03 from the
memory bank. Either both are legitimate (then the plan gets a bank of base scenes with one fresh sample for drift),
or neither is.

**P7. The shape measures cannot end in a decision.** §3.5 and §6 introduce length, paragraphs and repetitions as
the measure of the ongoing experiment, but `improve-loop.md:39` accepts a change only by `score` or `sceneScore`.
The experiment about scene length in its current form can neither win nor lose. This is **the owner's decision**
(a new acceptance measure), and it is not in the owner's list of §3.

### 8.5 What costs more than it gains at our volumes

- **§3.8, measurement of the server configuration: 30–35 minutes and $0.30–0.35 with $2.7 remaining.** **[D]** The
  remainder is ~4.5 hours of GPU, of which 2–2.5 hours will go to generation over three sessions. A decode speedup
  of 1.3× returns 35–45 minutes (~$0.35–0.45), a speedup of 1.2× returns 20–25 minutes ($0.20–0.25). So the
  measurement pays back one to one at best, and this is under a hypothesis marked [A]. Cheaper and more exact:
  `llama-batched-bench` (it is named in the findings of the previous scout, but §3.8 does not use it). It does not
  pay for three compactions, for a probe restart, or for the `n_ctx` check in the client, and it gives a matrix
  "batch × KV type × ubatch" in minutes. The A/B/C/D protocol through micro-batches costs five times more for the
  same numbers.
- **Item 9 (`--resume` of an eval cell, effort M)** returns 62.8 thousand tokens, which is 3 % of the daily cap of
  one channel.
- **Item 10 (signal from live play, effort M)**: by the plan's own calculation the sd of the difference at
  30 scenes per side is ≈9 pp, and live play on the GPU over the whole remaining credit will amount to a few dozen
  scenes. `elapsedMs` is "directly money" only while the GPU is rented, that is a handful of hours over the whole
  history of the project.
- **Item 4 (the analyzer `local/lab-stats.ts`, ~150 lines + a test)**: with credit left for 3–4 batches, the
  permutation test is cheaper to compute with a one-off script in the scratchpad over the same files (the power
  simulation was computed this way), and a file in the repository can be added when there are more batches.
- **The price of the plan itself.** Ten items are several days of work against a total saving that, by the plan's
  own numbers, is less than $1.5, that is less than the remaining credit. With one tester and three or four
  sessions "forever", the order of §3 must be reversed: first the free things (§7), then ★3 (interruptibility is
  the only thing that makes per-minute billing useful), and only then the speedups.

### 8.6 Forgotten cheap moves

**D1. `--mode plain` in every eval run.** **[M]** `eval.ts:46`: without `--mode`, **both** modes are run, but
decisions are made on `plain`, because `sgr` does not pass the `quote` check for any model
(`improve-loop.md:84`). Half of the tokens of every run go to a mode on which no decisions are made. Zero lines of
code, only a flag, and this is the largest saving on the hosted channel of all those named in the plan.

**D2. The seed as a lab parameter, not as a change to the bot.** The plan sent `seed` to the owner's list as "a
change to the production adapter". If the field is optional and only `--lab` sets it, the behavior of the bot does
not change by a single bit: without the field the server takes its own seed, as now. Common random numbers at
temperature 0.8 (`llama.ts:104,111`) are the cheapest change to the variance of the difference, and it is blocked
by a formality. (Formally `llama.ts` is still the production adapter, so it is **the owner's decision**, but the
question must be asked in exactly this form.)

**D3. The run-to-run spread is already on disk** (§8.2) and can be computed before a rental. It also shows that
the rule "at least three runs per side" (`improve-loop.md:44`) is calibrated on `gpt-5.4-mini`: for Gemma on the
open scenarios the spread is ±0.5 of a question, for `gpt-5.4-mini` it is 3 questions out of 15. One rule for all
models either overpays or underpays.

**D4. The definition of a paragraph must be fixed before it becomes a measure.** **[M]** Over the same 230 scenes,
the share "longer than 12 paragraphs" equals **44 %** if all blocks are counted, and **34 %** if the timestamp line
is not counted. The plan builds the conclusion "the requirement is followed about half of the time" on a parser
that itself moves the answer by 10 pp. The definition (whether the timestamp is counted, whether a one-line remark
is counted) must be written in §3.5 before the first number.

**D5. The link between scene length and `sceneScore` can be checked for free — and it has been checked.** **[M]**
The within-model correlation between scene length and the share of passed questions over 230 scenes equals
**−0.03**. By median split: Gemma 1.000 against 0.962, `gpt-5.4-mini` 0.853 against 0.878, `ministral` 0.652
against 0.818. So in the observed range (1.2–4.0 thousand characters) no mechanical inflation of `sceneScore`
through shorter scenes is visible. This should be declared **before** the experiment about length: otherwise any
shift will be blamed on it, and it does not exist.

**D6. The sanity check in the session template will fail.** **[M]** `model-probe.ts:21` creates the client without
`slots`, and `llama.ts:192` throws `unexpected_slots` if `props.total_slots !== 1`. In §4, `model:probe` stands at
minute 0–2, that is on a server already started with five slots for the batch. Either the probe gets the number of
slots, or its place is taken by a micro-batch of one trap. Now this is a guaranteed few minutes of paid confusion.

### 8.7 What the plan does not have at all

1. **Acceptance and the holdout pack are not built into the session.** `improve-loop.md:96` requires a run on the
   GPU, and S7 requires one run on the holdout pack. **[D]** This is another ~90–105 scenes (12–15 minutes,
   $0.12–0.15) plus 9 compactions, and they are neither in the table of §4 nor in the bill of §5. A session
   "screening + confirmation" does not fit them. Either a third session is needed, or an explicit decision that the
   holdout score runs in a separate rental.
2. **The risk of a broken SSH tunnel is not in the register.** The only documented expensive rental failure
   (`docs/gpu.md`, the night of 17 September: new SSH sessions hung, compactions failed) is absent from §1.9 and
   §3, although a batch of 330 scenes goes through one tunnel with **two** requests per scene (`llama.ts:170`
   counts tokens with a separate POST). ★3 is the cure, but it is worded around recall and a manual stop; a
   transport break must be added to the check of ★3.
3. **What the agent that runs the loop does when a hypothesis is not confirmed.** `improve-loop.md:101` (three
   rejections in a row → the owner) is not written into the protocol of §2, and with a margin of one question
   (§8.2) this is the most likely outcome of the next batches.
4. **Comparability between rentals.** The plan fixes the server configuration "forever in the manifest", but
   nowhere says that numbers from different machines (another GPU, another driver, another build) are not compared
   with each other, unlike the revision of the holdout pack, for which such a rule exists.
5. **What exactly is written to the log after a batch.** §4 lists five points of the entry, but does not require
   saving the batch files themselves (`screen.json`, `confirm.json`) and the hash of `SYSTEM` and of the code.
   Without them, a week later it is impossible to say what exactly was compared, and a retake costs a new rental.

### 8.8 The order I would set instead of §3

**[D]** By the price per unit of removed uncertainty, not by the size of the saving.

1. **Free, today, no code:** the run-to-run spread and `judgeYesRate`/"always yes" over the 45 directories (§8.2,
   already computed); the judge's `p_flip` with three re-judgings of copies; `--mode plain` in the runs (D1).
2. **Answer the question of §8.2**: where a measurable difference is left at all. Without this answer any rental
   buys numbers at the ceiling.
3. **★3, interruptibility**: the only thing that makes per-minute billing useful, and a precondition of §5.
4. **★1 + `cachedInputTokens`/`ms` in `lab_scene`**, and together with them close K1 on the very first micro-batch.
5. **★2 `system`**, with the official scene by the `base` key instead of the condition from P2.
6. Everything else, after item 2 shows what to measure.
