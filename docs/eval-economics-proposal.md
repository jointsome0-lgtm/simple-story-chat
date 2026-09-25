# The economics of experiments on prompts and memory

Status on 2026-09-25. A dated proposal of 2026-09-19, not a plan in force. Its numbers belong to that week: the
production model under llama.cpp on one rented RTX 5090 (Gemma 4 31B heretic Q6_K, one slot, KV `q8_0`, ubatch 128),
Vast rates of $0.5–0.7 an hour, and the hosted channels and the eval of that time. Today's budget and sample sizes do
not follow from them by themselves: another card, model or tariff needs its own measurement, and n = 5 is this note's
estimate, not a rule of [improve-loop.md](improve-loop.md). [eval-experiments-plan.md](eval-experiments-plan.md) was
written beside it, and [its critique](eval-experiments-plan.md#critique-statistics) notes that the power tables of §2.2
were computed for K = 35, the holdout pack, and were not recounted for smaller screening batches. Where a fact cited
here has moved to another page since, the reference points to its new place.

2026-09-19 · Opus 5 (scout) · analysis with no code edits and no paid requests. A research note: numbers marked [M] were taken from local technical logs, which are not published.

Goal: raise eval speed, statistical power and the return per rental dollar. Below, **[M]** measured facts
(from the code and the technical logs in `logs/`) are kept apart from **[D]** facts derived by calculation and from **[A]** assumptions that
still need to be checked.

What I read: `docs/improve-loop.md`, `docs/improve-log.md`, `docs/gpu.md`, `docs/model-providers.md`,
`docs/storyworm-ideas.md`, `local/eval.ts`, `local/memory-probe.ts`, `local/scene-judge.ts`, `local/scenarios.ts`,
`local/prompt.ts`, `local/memory.ts`, `local/generation.ts`, `local/llama.ts`, `local/budget.ts`,
`examples/scene-traps.ts`, `gpu/serve.sh`, `gpu/bootstrap.sh`, and the technical logs `logs/eval.jsonl`,
`logs/bot-gpu.jsonl`. The holdout pack, `data/` and `.env*` were not opened; only counters and codes were taken from the logs.

---

<a id='cost-model'></a>

## 0. The constants everything else is computed from

### The production model on a 5090 (Gemma 4 31B heretic Q6_K, 1 slot, KV q8_0, ubatch 128)

**[M]** Six `compaction_request_completed` rows from `logs/bot-gpu.jsonl` give sets of "input tokens, output
tokens, elapsedMs":

| input | output | time |
|---|---|---|
| 11,876 | 250 | 12.6 s |
| 15,032 | 530 | 19.9 s |
| 19,631 | 724 | 29.1 s |
| 31,079 | 2,164 | 69.5 s |
| 33,112 | 2,357 | 78.7 s |
| 39,267 | 3,207 | 108.2 s |

**[D]** Fitting `t = input/P + output/D` to the first and last rows gives **P ≈ 2300 tok/s on prefill** and
**D ≈ 35 tok/s on decode**. Checked against the other four rows, the difference is at most 8 %.

This gives the main fact of the whole economics: **in one trap scene, decode takes 85–90 % of the time**. The scene input
(seed + memory + 4 scenes + the move) is about 5–7 thousand tokens, which is 2–3 s of prefill; the output is 500–700 tokens, which is 15–20 s
of decode. So everything that saves prefill (a shared KV prefix, a memory bank) affects 10–15 % of the cost, and everything that
speeds up decode (the number of slots, the KV cache type) affects 85 %.

**[A]** The decode ceiling set by memory bandwidth: 1792 GB/s ÷ 25.2 GB of weights ≈ **71 tok/s** at batch 1.
We get 35, which is 49 % of the ceiling.

### What was measured on the batches of 18–19 September

**[M]** 15 s per scene with one slot, 8 s per scene with a 5-slot server ([improve-runs.md](knowledge/improve-runs.md#narrator-rule-2026-09-19), the 19 September entry).

**[D]** But with `samples: 3` and `parallel: 5` the code at `local/memory-probe.ts:180` starts
`Math.max(1, Math.floor(parallel / samples))` = **one** chain, which means **three** simultaneous requests, not five.
So the 8 s per scene were obtained at batch 3, not 5. The aggregate decode speed at batch 3 ≈ 66 tok/s against
an ideal 105 (3 × 35): batching efficiency is 63 %.

### Hosted models

**[M]** From `logs/eval.jsonl` (medians per compaction request):

| model | compaction, s | input, tok. | output, tok. | trap scene, s |
|---|---|---|---|---|
| `openrouter:google/gemma-4-31b-it` | 26.5 (n=133) | 4,901 | 954 | 17.2 |
| `openai:gpt-5.4-mini` | 7.3 (n=119) | 5,440 | 1,385 | 5.9 |
| `mistral:ministral-14b-2512` | 16.9 (n=27) | 6,076 | 1,608 | 7.9 |
| `claude:claude-haiku-4-5` | 29.2 (n=9) | 8,313 | 2,967 | — |

**[M]** The judge (OpenAI in those runs): **1.2 s per trap**, the median over 186 intervals. The latency of Opus 5 through
`claude-code` **has never been measured**; it has a separate cost: a CLI start on every call.

**[M]** Length of a trap scene: median 2017 characters for Gemma (n=84), p90 2287, maximum 2471. Cut-offs at the limit
(`truncated`) over the whole history of the log: **zero out of 152**.

**[M]** Time of a full eval run (from `logs/eval.jsonl`): 3 scenarios, 3 models, `plain`, with the judge: **7.0 min**;
3 scenarios of the holdout pack, 1 model, memory only: **6.1–9.4 min**, 9 compaction requests, ≈50 thousand input + 14 thousand
output tokens.

---

## 1. Where time, money and precision are lost today

### 1.1 Server slots are 40 % underused: the cheapest loss to fix

**[D]** As shown above, with `samples: 3, parallel: 5` three slots out of five are working. The cost of the mistake: 8 s per scene
instead of the expected 5–6. On a batch of 300 scenes this is **10–15 paid minutes**, which is about $0.12 per batch,
almost the entry cost of the rental itself.

The cause is architectural: the chains are split by variant in order to "protect the prefix cache". But there is nothing to protect:
**all tail variants have exactly the same prefix**; the only difference is in the last ~100 tokens of the last
message (`local/memory-probe.ts:167`). So inside one trap all "variant × sample" pairs can be put into
one flat list, with exactly `parallel` requests kept in flight. Cache locality does not suffer from this.

### 1.2 SYSTEM variants are run as a full eval from a separate git worktree: a loss of several times

**[M]** Memory compaction does not depend on the narrator's `SYSTEM`: `summaryRequest` in `local/memory.ts:29` builds its own
system prompt `SUMMARY_RULES`, and `SYSTEM` from `local/prompt.ts:56` goes only into the scene request. So
**an edit to `SYSTEM` cannot change memory**, and there is no reason to compact memory again for every variant.

**[D]** The cost of a SYSTEM variant relative to a tail variant is one extra prefill per scene:
6000 / 2300 ≈ **+2.6 s** on top of 15–20 s of decode, which is **×1.15**, not ×2 and certainly not a full eval.
Today, however, a SYSTEM variant costs: 9 compactions (≈4.5 min of GPU) + all scenes again + all judging again + the loss of pairing,
because each worktree has its own memory sample. The difference between "×1.15" and "a full run per variant" is
the main finding about speed.

The fix is one `system` field in the `--lab` file (this is `local/memory-probe.ts`; the file is **not** on the list of
untouchable files in `improve-loop.md`, which names `eval.ts`, `scene-judge.ts`, `scenarios.ts`, `pack-hf.ts`,
`budget.ts`).

### 1.3 Memory is recomputed where it could be frozen

**[M]** The replay of frozen scenes does not call the model at all: `memory-probe` only mutates the local storage.
Only **3 compactions per scenario and mode** plus one memory question remain paid.

**[D]** On the GPU this is 9 compactions × ≈29 s = **4.4 min** per batch of three scenarios, about $0.04. The time gain
is moderate. But the **precision** gain is larger: today, comparisons from different days use different memory samples, and the log
itself notes this as a limitation of the 19 September measurement ("the paired comparison ran on different memory runs").
A frozen memory bank with the key `sha256(frozen.json) + hash of the memory code + model + mode` removes a whole component
of variance from all prompt comparisons.

The technical base already exists: `report.json` stores `state` (the whole `Library`) and the list of `compactions` for each mode,
and `--resume` picks them up. Only a flag is needed that takes `state` from another report used as the bank.

### 1.4 The judge costs no money but can hold the GPU

**[D]** A batch of 300–500 scenes needs 300–500 judge calls. With a sequential `scene-judge.ts` and even
10 s per call this is 50–80 minutes, more than the generation itself. Billing is per second, so the cost is clear: every minute
that the card waits for the judge costs ≈$0.01. If judging is placed between batches, it costs $0.5–0.8 per session,
twice the cost of the whole machine preparation.

The good news: **judging can be parallelized without a single edit to the eval**. Lab already writes a separate
`lab/<variant>-<sample>/report.json` in the form that `scene-judge.ts` reads (`local/memory-probe.ts:147`).
So it is enough to run N processes of `node local/scene-judge.ts --report lab/<name> --mode plain` in parallel.
The limit is the Claude subscription limits, which are **not measured**.

### 1.5 The "105 questions" measure overstates precision by a factor of three

**[M]** A breakdown of the log numbers: the holdout pack is 33 + 36 + 36 = 105 with three samples, which is **35 questions
(about 30 traps) × 3 samples**. Open batch 1: 75 = 25 questions × 3. Batch 3: 45 = 9 questions × 5.

**[D]** The samples of one trap are not independent observations. In the observed data a trap almost always gives 0/3 or
3/3 (the within-trap correlation is close to 1), so the effective sample size equals **the number of questions, not the number
of questions multiplied by the number of samples**: 35, not 105. A confidence interval computed as binomial over
105 is narrower than the true one by about √3 ≈ 1.7 times.

### 1.6 Pairing does not reduce judge noise

**[M]** The agreement between Opus and `gpt-5.4` is measured: 36 out of 40. The agreement **of Opus with itself on the same scenes has never
been measured**.

**[D]** Pairing protects against memory noise and against differences between traps, but not against judge noise: each variant has its own
scenes, and so its own judge decisions. With a share of changed verdicts f = 5 %, the judge's contribution to the difference between two arms is
about 3 pp, the same order of magnitude as the sampling noise at n = 3. Until f is measured, any edit
with an effect of 5 pp cannot be proven at all.

### 1.7 The hosted test ground costs more than it seems, not in money but in throughput

**[D]** The paid Gemma channel on OpenRouter is 600 thousand tokens per day. One trap scene costs ≈5–7 thousand input +
≈0.7 thousand output ≈ 6.5 thousand tokens. So **the ceiling of the test ground is about 90 trap scenes per day**. The same 90 scenes
on a rented card cost about two cents on top of the entry cost and take twelve minutes.

A conclusion against the original framing of the task: **hosted Gemma is not a "cheap test ground" for comparing scene variants**.
Its value is elsewhere: in checking that a rule does not break other models (`ministral`, `gpt-5.4-mini`, Haiku), and in
cheap memory checks (one memory run over three scenarios = ≈64 thousand tokens, which is 9 runs per day).
For questions like "which of five rule variants is better", the GPU itself is the test ground, and hosting is a portability
check afterwards.

The largest free channel is `openai-small` (2.25 million tokens per day, ≈340 scenes), but `gpt-5.4-mini`
is noisy on 3 questions out of 8 and is not the production model.

### 1.8 Summary of losses in numbers

| Loss | Estimate | Type |
|---|---|---|
| Idle slots (3 of 5) | 30–40 % of generation time, ≈$0.10 per batch of 300 scenes | [D] |
| A SYSTEM variant through a full eval instead of lab | ×4–6 in the cost of a variant | [D] |
| Compacting memory again for every variant/run | 4.4 min (≈$0.04) per batch + an extra component of variance | [D] |
| The card waits for the judge between batches | $0.01 per minute of waiting, $0.5–0.8 per session | [D] |
| Counting precision over 105 instead of 35 | intervals 1.7 times narrower than the true ones | [D] |
| Unmeasured judge noise | ±3 pp of unaccounted variance | [D] |

---

<a id='power-and-assumptions'></a>

## 2. How many samples are needed and which comparison protocol to use

### 2.1 The unit of pairing is the trap, not the question and not the scene

The correct design: for each variant, `n` scenes are written for **the same trap**, from **the same memory**, with the same
judge. Pass rates are compared per trap. The unit resampled by the bootstrap and by the permutation test is the **trap**
(the questions inside a trap share one scene and are correlated).

Accordingly, McNemar over 105 "questions" must not be used: it treats them as independent and overstates significance.
The correct test is a **permutation test over traps**: for each trap take the difference of pass rates
(the pass rate of variant B minus that of A), randomly swap the variant label inside the trap, and compare
the mean. It needs no assumptions and accounts for clustering.

### 2.2 Power calculation

A simulation (4000 repetitions, one-sided α = 0.05; a one-off script in the scratchpad). K is the number of trap questions,
n is the number of samples per trap per variant.

**Case A, "concentrated effect"** (this is exactly what the step accepted on 19 September looked like: d traps move from
≈0.1 to ≈0.9, the rest stay at 0.97 in both arms). Power of the permutation test:

| K | d traps switched | effect | n=1 | n=3 | n=5 |
|---|---|---|---|---|---|
| 35 | 3 | +7 pp | 0.09 | 0.20 | 0.28 |
| 35 | 4 | +9 pp | 0.17 | 0.46 | 0.58 |
| 35 | 5 | +11 pp | 0.32 | 0.68 | 0.89 |
| 35 | 6 | +14 pp | 0.49 | 0.86 | 0.98 |
| 35 | 8 | +18 pp | 0.71 | 0.99 | 1.00 |

Two consequences follow. First: **n = 3 is a reasonable minimum, n = 5 is the saturation point**; beyond that, samples buy almost no
power, because the switch of a trap is almost deterministic anyway. Second: **power is bought with
the number of discriminating traps, not with samples**. No sample budget will prove three switched traps out of 35;
five or six are proven with three samples.

The sign test (on the number of traps that improved against those that got worse) is clearly weaker than the permutation test: at K=35,
d=5, n=3 it gives 0.29 against 0.68. Use the permutation test.

**Case B, "spread effect"**: the very question "tell 80 % from 88 %", if the gain comes a little from every
trap:

| K | n | total scenes per variant | power |
|---|---|---|---|
| 35 | 3 | 105 | 0.43 |
| 35 | 5 | 175 | 0.63 |
| 35 | 8 | 280 | 0.78 |
| 35 | 12 | 420 | 0.94 |
| 50 | 5 | 250 | 0.75 |
| 70 | 5 | 350 | 0.89 |

For comparison: if the 105 questions were independent observations, 0.80 against 0.88 at power 0.8
would need **259 observations per side**, so even in an ideal world 105 is not enough.

**A direct answer to the question of the task.** To tell 80 % from 88 % on the holdout pack with confidence (power 0.8):
with a concentrated effect, **n = 3 and at least 5–6 discriminating traps**, which is 105 scenes per variant;
with a spread effect, **n = 8 with the current 35 questions** (280 scenes per variant) or **n = 5 if the number of
questions is raised to 50** (250 scenes). Today's configuration (35 questions × 3 samples) reliably catches only
concentrated effects of +10 pp and more. That is exactly what it caught on 19 September, and this must be
understood as the limit of the method, not as an accident.

### 2.3 Recommended protocol

1. **Pairing on three axes at once**: the same memory bank, the same list of traps, the same judge
   for both arms. Only the text of the variant may differ.
2. **Fix the sampler seed.** Right now `local/llama.ts` does not pass `seed` at all; the server picks a random one.
   Passing `seed = f(trap key, sample number)`, **the same for all variants**, gives common random numbers:
   the difference between variants stops depending on the random draw of the start of the scene. From experience with the common random
   numbers method, this removes a noticeable part of the variance of the difference for free. **[A]** the size of the gain here is not measured; it
   must be measured in the very first run (two arms with the same text, with the seed and without it).
3. **A two-stage funnel with an honest stop.**
   - Stage 1, screening: only the discriminating traps (`lab.only` can already do this), all variants, n = 3. This is a search;
     no p-values are declared here. Variants that did not beat the baseline are dropped.
   - Stage 2, confirmation: one winner against the baseline, all traps, n = 5, permutation test.
   - Stage 3, the holdout pack: one one-sided test declared in advance. Multiplicity is closed by the fact that
     exactly one variant reaches the holdout pack after stage 2 (a closed procedure), not by applying a correction.
4. **Controls as a separate number.** Traps with an allowed action (`seal_allowed`, `count10`, `colors`) are now
   dissolved in the overall `sceneScore`. The winning rule must not lower them: this is protection against a narrator that
   simply started refusing. In lab this is computed from `report.json` by question keys, without editing `eval.ts`.
5. **Decompose the variance once** and then use the numbers:
   - judge: judge one finished directory twice (`eval judge --resume`, free) and compute the share of
     changed verdicts f;
   - scene: n samples inside a cell, this already exists;
   - memory: 2 different memory samples as a blocking factor in one batch.
   Until these three numbers are known, any "improvement of 4 pp" is talk, not a result.

### 2.4 How not to burn the holdout pack

- Record the number of looks at the holdout pack in `improve-log.md` as an explicit line. At α = 0.05 and eight
  looks, the probability of at least one false win is 0.34.
- The holdout pack serves for confirmation, not for search: one variant reaches it, one that has already won on the open packs.
  This is today's rule in `improve-loop.md`; it is enough, it only has to be followed, and the looks have to be counted.
- If the holdout pack has to be extended (and by the power calculation 50 questions instead of 35 cost less than
  doubling the samples), this is **the owner's decision**: the content of the holdout pack and the scenarios are in the section "What may not change".

---

## 3. Ranked list of changes

Effort estimates: S is up to half an hour, M is half a day, L is a day or more.

### ★ 1. A flat request pool inside a trap (do first)

**What.** In `local/memory-probe.ts`, replace the "chains by variant" with a pool: put the "variant × sample" pairs of one
trap into a list and keep exactly `lab.parallel` requests in flight. All these requests have the same prefix,
so mixing the variants does not harm the cache.

**Gain.** [D] from 3 busy slots to 5: 8 s → 5–6 s per scene, which is **+35–45 % scenes per hour**.
**Effort.** S. **Risk.** Low; the behaviour of the eval does not change, only the order of requests changes.
**How to check.** The same batch before and after: seconds per scene in `lab_scene` and `nvidia-smi` during the run.

### ★ 2. Log `inputTokens` and `cachedInputTokens` in the `lab_scene` row (do first)

**What.** One line at `local/memory-probe.ts:173`: add the fields from `result.usage` to `progress`. These fields already
come from `local/llama.ts` and are already allowed by the whitelist (numbers, not text).

**Gain.** This is the only way to find out **whether the shared prefix between slots works at all**. Today the whole
lab design is built on the assumption "variants share a KV prefix", and it has never been checked: `--kv-unified`
makes a shared pool of cells, but llama.cpp is not required to deduplicate identical prefixes of **parallel**
sequences. If `cachedInputTokens` turns out to be zero for simultaneous requests, the whole layout of a batch
must be different (sequential within a trap, not parallel).

**Effort.** S. **Risk.** Zero. **How to check.** The field itself is the check.

### ★ 3. A `system` field in the `--lab` file and a bank of frozen memory (do first)

**What.** Two related changes to `local/memory-probe.ts`:
- `variants[].system` overrides `request.system` for this variant;
- `--memory <path to report.json>` takes the ready `state`, `compactions`, `through` from the bank instead of doing its own compactions;
  the bank key is written to the report as `sha256(frozen.json)` + hash of `local/memory.ts` + model + mode, and on
  a mismatch the bank is rejected.

**Gain.** [D] A SYSTEM variant no longer needs a git worktree and a full eval: its cost drops to ×1.15 of the cost
of a tail variant. In addition, the variance component "different memory in different arms" disappears, which the 19 September log entry already
recorded as a limitation of the measurement. For the experiment on scene length that is running now, this directly replaces three worktrees
with one batch.

**Effort.** M. **Risk.** Medium: a memory bank tied to a different version of the memory code will silently give a wrong comparison.
Hence the mandatory hash check and the rejection on a mismatch.
**How to check.** Run the "empty tail" variant from the bank and from its own compactions: `score` and the distribution of
`sceneScore` must match within noise.

### 4. Parallel judging, moved outside the rental

**What.** A wrapper (a script, not an edit to the eval): when a `lab/<name>` directory is complete, queue
`node local/scene-judge.ts --report lab/<name> --mode plain`, keep 4–8 processes, write a summary. The GPU then
waits for nobody; the rest of the judging is finished after the machine is switched off.

**Gain.** [D] 15–25 minutes of the card per session, which is $0.15–0.25, the same as the whole machine preparation costs.
**Effort.** S–M. **Risk.** The Claude subscription limits are not measured: start with 4 processes and look at the error codes.
**How to check.** The time from the last scene to the last verdict; the share of `rate_limited` in `logs/eval.jsonl`.

### 5. `llama-batched-bench` once, with the result written to the manifest

**What.** Run the matrix once: batch 1/3/5/8 × KV `q8_0` and `f16` × ubatch 128 and 512, at `pp 6000, tg 600`;
write the chosen configuration to `gpu/manifest.env` or to the log and do not measure it again. Only `serve.sh`;
the eval is not touched.

**When.** Six minutes cost $0.06. They pay off through a speed-up of k on a session of length T: the benefit is T(1−1/k) minutes.
At k = 1.2 the threshold is T ≈ 40 minutes of generation. So the bench is appropriate once, in the first session that has
at least forty minutes of generation, and never after: the answer about the server configuration is long-lived; it must be written down, not
bought again with every rental.

**Rationale.** [D] The aggregate decode speed at batch 3 is 66 tok/s, with an ideal of 105 and a card ceiling of ≈71 per
stream. The previous scout's finding about dequantizing `q8_0` to f16 on every step at ≥3 slots hits exactly decode,
which is 85 % of the cost. Memory allows it: at ctx 65536 the KV with SWA (10 full-attention layers + 50 with a 1024 window)
takes **[D]** ≈1.5 GB in `q8_0` and ≈2.9 GB in `f16`, and by [the measurement](knowledge/gpu-measurements.md#verified-2026-09-17) ≈4.2 GB is free.
`--ubatch-size 512` affects only prefill, which is 10–15 % of the cost, so it is not the first candidate, contrary to
how it sounds.

**Gain.** [A] 1.3–2× on decode, if the dequantization hypothesis is true. Checking it costs $0.07.
**Effort.** S. **Risk.** Low; on failure the previous launch line is restored.
**How to check.** The bench itself and then seconds per scene in a batch.

Do not touch (by the owner's direct word): `--cache-reuse`, `--swa-full`, `--ctx-checkpoints 0`.
Do not bring back `n>1` (`generateMany`): the server failure was reproduced on synthetic data.

### 6. Deterministic scene measures without the judge

**What.** Add numbers computed by code to `lab_scene` and to `traps[]`: the number of paragraphs, the number of characters,
`finishReason`, the share of repeated 5-grams inside the scene and with the previous scene. All of them are integers and enums;
the whitelist in `local/model-error.ts` is extended with no privacy risk.

**Gain.** Three of the four things that matter to the tester and cannot be measured today (length and pace, cut-offs at the limit, repetitions)
become measurable **without a single judge call and without a human reading the text**. The experiment on
"no more than 12 paragraphs" that is running now gets its main measure for free: its question is the distribution of the number of paragraphs, not the judge's
verdict. Also: cut-offs at the limit in the log are **zero out of 152**, so this pain, if the tester speaks about it,
does not come from the eval scenarios, and it has to be caught in the live log (item 7).

**Effort.** S. **Risk.** Zero.
**How to check.** Compute these numbers over the already saved `report.json` files of past batches: the data for comparison
appear at once, without new runs.

### 7. A numeric signal from live play

**What.** In the bot log, add to the `scene_saved_and_sent` event `elapsedMs`, `inputTokens`, `outputTokens`,
`paragraphs`, `finishReason` (an enum) and the flag `branchedFromSameNode`: the player regenerated at once or
left on a branch from the same node. All of these are non-negative integers, booleans and enums; `actor` already tells
the owner from the others, and there are no identifiers.

**Gain.** `branchedFromSameNode` is the most honest cheap proxy for dissatisfaction with a scene that can be obtained
without reading a single line of a story. Today we know exactly nothing about the quality of live play: `scene_saved_and_sent` has not
a single numeric field.

**Effort.** M. **Risk.** Privacy: the new fields are added to the `safeErrorDetails` whitelist as numbers and
enums, no strings.
**How to check.** A week of the log: the distribution of `paragraphs`, the share of `length`, the share of regenerations.

### 8. Measure once how well the test ground predicts the production model

**What.** Take batch 3 (8 traps, 9 questions), the same 3–5 variants, n = 2, run it on hosted Gemma with the same
lab code and compare **the order of the variants and the sign of the differences** with the GPU numbers we already have.

**Cost.** [D] 8 × 5 × 2 = 80 scenes ≈ 520 thousand tokens, exactly one daily limit of the paid channel.
**Gain.** After this we can either trust the test ground as a filter (and save GPU hours) or stop pretending
that it is a filter. Right now this assumption is supported by nothing; `improve-loop.md` directly calls hosted
Gemma an "optimistic substitute", but by how much is not measured.
**Effort.** S (the run), M (a working lab on `openai-compatible` is needed: right now `llamaLab` is created only when
`provider === 'llama-cpp'`, `local/memory-probe.ts:84`; for hosting the `provider.generate` path works, but
`lab.parallel` is not applied).
**How to check.** Agreement of the sign of the difference per trap and the rank correlation of the variants.

---

## 4. A GPU session template

Billing is per second, so the "hour" is the wrong unit. The unit is **a session of any length with a fixed entry
cost**, and what is optimized is not filling the hour but useful scenes per dollar.

### 4.1 Entry arithmetic

**[M]** Entry: either preparation from scratch ≈15 min ≈ **$0.15** (plus traffic for 25 GB of weights, from $0.07 to $1
depending on the machine), or the disk of a stopped instance at **$0.017/hour**, but a stopped machine can be taken by
another renter.

**[D]** At a rate of ≈$0.6/hour (=$0.01/min) and the current 8 s per scene (7.5 scenes/min), the marginal cost of one scene
inside a session is **$0.0013**. So the $0.15 entry equals about **115 scenes**. The share of useful work in the bill
equals `T / (T + 15 min)`:

| session length | scenes | bill | scenes per dollar | share of entry in the bill |
|---|---|---|---|---|
| 15 min | 110 | $0.30 | 370 | 50 % |
| 30 min | 225 | $0.45 | 500 | 33 % |
| 45 min | 340 | $0.60 | 565 | 25 % |
| 90 min | 675 | $1.05 | 640 | 14 % |
| ∞ | — | — | 750 | 0 % |

The curve is flat and has no thresholds: there is no point in "stretching to a full hour". The practical rule:
**a session is justified if the queue holds at least ≈115 scenes of work** (then the entry is at most half of the bill), and it is good at
≈340 (the entry is at most a quarter). A session for thirty scenes costs $0.20 and gives 150 scenes per dollar, five times worse
than the marginal cost; such questions must be accumulated.

After the fixes of §3.1 and §3.5 (5–6 s per scene) the same numbers shift: the entry becomes equal to ≈165 scenes,
and the marginal cost drops to $0.0009.

### 4.2 Three decisions that are now computed, not guessed

1. **Idle against stop.** Idling costs $0.01/min, a stopped machine costs $0.00028/min. Even with two
   minutes for a restart, stopping is cheaper as soon as the pause is **longer than ≈3 minutes**. So: if the queue is empty and you need
   to think, stop the machine, and do not run filler "because the hour is paid anyway". The price of this decision is the risk that the machine
   will be taken.
2. **Stop against delete.** A cold entry costs $0.15, a warm one ≈$0.03. The $0.12 difference pays for the disk
   of a stopped machine for **≈7 hours**. Up to seven hours, keep it stopped; longer, delete it.
   A night of being stopped costs $0.20, a weekend about $1, which is a third of the remaining credit.
3. **Filler.** Extra samples of the baseline variant cost $0.0013 per scene and directly buy test power
   (§2.2). They should be queued not "so that the hour is not wasted" but because this is the cheapest way to narrow
   the interval. But only while the queue is running: keeping the card on for the sake of filler when there is something to think about
   is no longer worth it (item 1).

### 4.3 The shape of a session

Generation and judging are separated not by parallelism but by billing: the judge is free and does not need the card, so
the natural shape is a **sawtooth**.

```
[entry] → screening batch → stop the machine → judging and analysis (20–40 min, $0.01) → start → confirmation batch → stop/delete
```

A pause between batches through a stop costs about one cent instead of $0.20–0.40 of idling and instead of $0.12 for a new
cold entry. Judging of finished directories is still started in parallel with generation (§3.4), so that by
the time of the stop little remains to judge.

### Before the session (free, on the bot machine)

1. Build the batch files in advance: `screen.json` (all variants, `only` is the discriminating traps, `samples: 3`) and
   `confirm.json` (the winner against the baseline, all traps, `samples: 5`). One line of the second file is edited when
   the winner is known.
2. Run `npm test` and `npm run check`.
3. **Dry run.** The most expensive rental mistake is a typo in the batch JSON found in the tenth minute. It is worth
   adding a mode to `memory-probe` that replays the scenes, builds the requests and prints their sizes in bytes **without
   calling the model**. Effort S, pays off the first time.
4. Write the queue as one file `queue.sh`, so that the session starts with `bash queue.sh` and not with thinking:
   thinking next to a running card costs $0.01 per minute.
5. Count how many scenes are in the queue. Fewer than ≈115 means the session is not justified, and the question waits for the next one.
6. Put extra samples of the baseline variant at the end of the queue: by §4.2 this is the cheapest power there is.

### The session

| Minutes | What runs on the GPU | What runs in parallel on the bot machine |
|---|---|---|
| −15…0 (cold entry) | bootstrap: the build and the weights download run at the same time, watch `progress.sh` | download speed check in the first minute (see §5) |
| 0…2 | `model:probe` (sanity check), `gpu:diagnose --watch 30` in a separate terminal | — |
| 2…8 | only in the first long session: `llama-batched-bench`, write the result down for good | choice of the server configuration |
| 8…12 | 9 compactions, writing the memory bank (once per revision of the memory code) | — |
| 12…30 | screening batch: discriminating traps × all variants × 3 samples | judging of finished directories, 4–8 processes |
| 30 | **stop the machine** if the analysis will take more than three minutes | remaining judging, permutation test, choice of the winner |
| +0…25 | start from the stopped state (≈2 min), confirmation batch: the winner against the baseline, all traps × 5 samples | judging |
| end | `gpu:diagnose --pull`, then stop (I will return within 7 hours) or delete | — |

The rule of the session: **only what cannot be done without the GPU runs on the GPU, and only for as long as the queue
runs**. Judging, analysis, statistics and writing the log happen on the bot machine, with the rental stopped or deleted.

### After the session (free)

1. Finish judging the rest.
2. Permutation test over traps, separately for the overall score and separately for the control traps.
3. Deterministic measures (paragraphs, cut-offs, repetitions) over the same `report.json` files.
4. An entry in `improve-log.md`: hypothesis, numbers, decision, **how many looks at the holdout pack were spent**.

---

## 5. Rental economics

**[M]** Billing is per second, not per hour. The rate is $0.5–0.7 per hour. Entry cost: preparation from scratch ≈15 min ≈$0.15,
or the disk of a stopped instance at $0.017/hour, but a stopped machine can be taken by another renter. The remaining
credit is ≈$2.7. The download of the 25 GB of weights has been observed to take both 6 minutes (850 Mbit/s) and half an hour (115 Mbit/s against
an advertised 1171).

**[D]** The remaining credit is enough for about 4 hours of the card. The whole optimization comes down to four numbers: entry $0.15,
a minute of work $0.01, a minute of idling $0.01, a minute of being stopped $0.00028.

1. **Measure scenes per dollar, not how full the hour is.** The table in §4.1: the share of entry in the bill equals `15/(T+15)`.
   The break-even threshold of a session is ≈115 scenes in the queue; the comfortable mode starts at ≈340. There is no reason to stretch a session to a round
   hour, and no reason to cut it off in the middle of the queue.
2. **Accumulate questions into batches.** Each additional session costs $0.15 of entry, which is 5.5 % of the remaining credit. Three
   sessions instead of one are $0.30 extra, which is 230 scenes that will not exist. This is also the value of the dry run
   (§4, item 3): a typo in a batch file found on the card costs not "ten minutes" but a real $0.10 and, if
   the batch was the only reason for the rental, one more entry.
3. **A pause longer than three minutes means a stop, not idling.** Computed in §4.2. This is the only change of habit
   that costs nothing and at once returns $0.20–0.40 per session with an analysis in the middle.
4. **A stopped machine pays off for seven hours.** The difference between a cold and a warm entry is $0.12, at a storage price of
   $0.017/hour. If I return today, stop it; if tomorrow, delete it (a night of being stopped $0.20, a weekend ≈$1).
   When stopping, account for the risk: the machine can be taken, and then the warm entry becomes a cold one anyway.
5. **Checking the channel in the first minute is the best entry optimization.** `progress.sh` already shows the speed over
   the last half minute. Below ~300 Mbit/s, delete the machine and take another one: the test costs $0.01, saves up to 25 minutes
   and up to $0.25. It needs no code, only a rule.
6. **A ready binary instead of a build** (upload `llama-server` and the needed `.so` files to a private HF repository, as is already
   done for the holdout pack through `local/pack-hf.ts`) cuts the entry roughly in half: from $0.15 to $0.07–0.08.
   Risk: a glibc and CUDA mismatch between images; this is covered by the image already being pinned by digest in
   [gpu-measurements.md](knowledge/gpu-measurements.md#verified-2026-09-17). After this, the weights download becomes the dominant part of the preparation, and from then on only item 5 cuts it further.
   The value depends on the number of **cold** entries: with three it is ≈$0.22, with one it is nothing.
   Since items 3 and 4 reduce the number of cold entries, this item should be done last of the six.
7. Do not forget the price of traffic: [gpu-measurements.md](knowledge/gpu-measurements.md#costs-and-downloads) records a spread from $2.6 to $52 per TB, which is from $0.07 to $1 for
   one download of the weights, from half to seven times the cost of the whole preparation. Compare offers by the sum
   "rate + download", as it says there.

---

## 6. Which experiments are worth running at all

**[M]** From the log: on the open scenarios the accepted rule gives 74 out of 75, on the holdout pack 94 out of 105. These are
not fixed by anything: `turn15_crates_35` (a counter sum across compactions), `turn9_agata_in_dark`, `turn12_from_workshop`,
`debt_remainder`. All four are about numbers and "who knows what".

**Conclusion.** The prompt lever is almost used up: the remaining headroom is 11 questions, about 4 traps, and they are not about
the wording of the rule but about memory. So the hypotheses must be ranked like this:

1. **Counters and sums across compactions** (ideas C, J, I from `storyworm-ideas.md`). The largest measured reserve:
   22 of Gemma's 26 failures on the holdout pack are accumulated sums. Cost of a variant: a full replay (9 compactions +
   T × n scenes), **[D]** ≈18 minutes per variant at the current speed, ≈9 after the fixes of §3.
2. **Code computes the availability time** (idea B): a pure `prompt.ts` edit, memory is not compacted again, the memory bank
   works. **[D]** ≈14 minutes per variant, ≈7 after the fixes. It targets error class 3.
3. **The place of an object** (idea C, the `key` part without `counters`): the traps `turn14_dagger_with_tarek`,
   `turn12_from_workshop`.
4. Pure prompt variants of order and wording (idea K): only as a cheap add-on to a batch, not as
   a reason for a separate session: by §4.1 a reason costs $0.15 of entry.

The rule for selecting a hypothesis: before running an experiment, compute from the `report.json` files we already have
**how many traps it can physically switch**. If fewer than five, then by the calculation in §2.2 the experiment cannot be proven
with any sample budget, and it must either be extended (more traps of the same class, which is the owner's decision) or
not be run.

---

## 7. What needs the owner's word

The items below touch the section "What may not change" of `improve-loop.md` and my own restriction not to look
into the holdout pack. I mark this explicitly; the executor of the loop does not do these on its own.

1. **A separate number for the control traps** in `eval.ts` (`controlScore` next to `sceneScore`). In lab it is computed
   without edits, but in the main eval this is an edit to the eval.
2. **Extending the trap set from 35 to ~50 questions**, preferably in the classes "counters" and "who knows what".
   By the power calculation this is cheaper than doubling the samples, and it gives what samples do not give at all.
3. **Splitting the `draw_corrected` question into two**: already recorded in the log on 18 September as a debt; it waits for the baseline
   to be measured again.
4. **A cheap preliminary judge** (Haiku as a filter, Opus only on disputed cases): an edit to `scene-judge.ts`.
   I would not do this: the judge costs no money, and the numbers of different judges would stop being comparable.
5. **Passing `seed` in `local/llama.ts`**: the file is not on the untouchable list, but this is a change to the production adapter,
   not to the eval; it should be agreed, because it changes the behaviour of the bot for the tester.

---

## 8. Three things if there is no time at all

1. A flat request pool in lab (§3.1): half an hour of work, +35–45 % scenes per paid minute.
2. `cachedInputTokens` in the `lab_scene` row (§3.2): five minutes of work; it checks the assumption that
   the whole lab method rests on.
3. A `system` field in the batch file plus the memory bank (§3.3): half a day; it removes the git worktree per variant and a whole
   component of variance; the experiment on scene length that is running now moves to it at once.

And one rule with no code: count precision by the number of traps, not by the number of "questions × samples", and compare
with a permutation test over traps. This costs nothing and at once removes the most expensive kind of mistake: confidence
in an improvement that does not exist.
