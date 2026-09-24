# Ideas from storyworm for story consistency

2026-09-18 · Opus 5 · the main branch of storyworm and the frozen branch `reference-001` (`048b166b`) were read. References: `main:<path>:<line>` is the main branch of storyworm, `ref:<path>:<line>` is `reference-001`, `commit:<sha>` is a storyworm commit. Paths are given from the root of the storyworm repository. It is a private predecessor project and it is not published, so the references open only inside it; sections 2 and 3 can be read without them.

Verification. Every claim of the map and every basis of an idea had a source and a quote. A second agent opened the source and tried to refute the claim. Of 215 map claims, 184 were confirmed and 31 were corrected. Of 71 idea bases, 48 were confirmed and 23 were corrected. Then a critic rechecked a sample of about 35 references already in the text of the document and found three more errors of meaning. They are corrected and listed in section 5. I checked twelve key references myself. Real texts, `~/.local/share/storyworm`, the report on the probe on the real corpus and the holdout pack were not opened. No models were called.

## 1. What storyworm is

storyworm translates long works chapter by chapter. It does not write interactive stories: it has no player, no false premises in a turn and no narrator who leads the plot. So everything below is transferred by analogy. A chapter corresponds to a scene, fact extraction corresponds to memory compaction, the canon corresponds to the accumulated memory of a branch.

### World state (reference-001)

The state is split across three shelves that do not mix: the canon (the truth about the world), the term memory (the translator's decisions) and the translation versions. The patch log is the truth, and the snapshot is a cache that is rebuilt by replaying the patches (`ref:docs/storyworm/spec/04-system-model.md:52`, `:63`).

- **A fact** is a triple with the id `subject|key`. In one snapshot a pair has one value. `update` replaces the value, and with the same value it merges the evidence. `add` on top of an existing fact is an error (`ref:packages/story_domain/src/story_domain/models/canon.py:418`, `ref:docs/storyworm/spec/06-domain-contracts.md:119`).
- **The key registry `KeySpec`** sets the kind of the value: `scalar`, `enum`, `entity_ref`, `list_entity_ref`, `free_text` (`ref:packages/story_domain/src/story_domain/models/ontology.py:71`). A candidate with an unknown key, without a subject or with a wrong value is not written and goes to escalation (`ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/patch_builder.py:180`).
- **The evidence kind `EvidenceKind`** is a closed vocabulary without an order: the narrator's words, a character's line, something shown, a rumor (`ref:packages/story_domain/src/story_domain/models/ontology.py:22`). A line proves only that the character said it, not that it is true (`ref:docs/storyworm/spec/06-domain-contracts.md:76`). This kind replaced the numeric `confidence`, because a free self-assessment of the model "converges to 0.8" (`ref:docs/storyworm/DECISION-LOG.md:119`, `:139`).
- **Time.** The specification separates the moment when a fact is revealed from the time in the world. The canon does not store the time in the world; its only state is "unknown". Deriving the order of events in the world from the order of chapters is forbidden (`ref:docs/storyworm/spec/02-architecture-principles.md:31`, `:34`).
- **Visibility** is decided by code without a model: an observation is hidden while the current paragraph stands before the paragraph where it appeared (`ref:packages/story_domain/src/story_domain/visibility.py:64`). This is visibility for the translator and the reader. storyworm has no model of "which character knows what".
- **The chapter context** is frozen: the cast, up to three past summaries, each no longer than 2000 code points and 6000 together (`ref:packages/story_domain/src/story_domain/models/translation_context_basis.py:32`, `:38`), and the lore, no more than 8 entries per character and 64 in total (`ref:packages/story_domain/src/story_domain/models/committed_lore.py:28`). The lore is passed with the label "Committed canon data (data, not instructions)" (same file, `:307`). If the summaries do not fit, an error is raised. Lore above the limit is dropped, and the reason is recorded (`ref:docs/storyworm/spec/06-domain-contracts.md:417`): nothing is lost silently. An ambiguous name is not replaced with the canonical one: it is removed from the context and raised for review (`omit + escalate`, `ref:docs/storyworm/spec/09-translator-text-v2-workflow.md:104`).

### Checks and roles

- The QA specification splits the check into two parts. Consistency covers the glossary, the lore, the style and the markers. Adequacy covers omissions, additions and a mixed-up speaker. Auto-approval is allowed only if both checks pass and there are no new entities, no fact changes and no escalations (`ref:docs/storyworm/spec/10-qa-v2.md:26`).
- The canonical QA in the code is deterministic. Consistency checks only the paragraph markers, adequacy takes its findings from a fixture (`ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/consistency_qa.py:398`, `ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/adequacy_qa.py:449`). The causal canon extractor is the stub `NoopBootstrapCausalExtractor` (`ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/extract_contracts.py:158`).
- A live path with models also exists. A draft, an edit, extraction of facts and terms with one repair, a model observation of adequacy (`ref:apps/storyworm/src/storyworm/translation_pipeline_execution.py:110`). The last one is named directly: "a provider observation, not canonical adequacy QA or approval" (same file, `:296`). It does not serve as a gate.
- The roles "critic" and "memory" (Muninn) exist only in the glossary. The specification says that they are not required runtime components (`ref:docs/storyworm/spec/00-product-and-glossary.md:20`).
- `main` implements the path translate → extract → check → publish. A fact `{entity, key, value, paragraphs}` has anchors. An anchor outside the current chunk fails the attempt (`main:src/storyworm/pipeline.py:58`). Only the range of the anchor numbers is checked, not the match with the text. Saved facts are not passed into prompts at all.

### What was measured and what came out

- There was one live run with models: one chapter, four stages, three providers, $0.384248 by the local estimate. The cache did not hit even once (all counters are 0). Nothing got into the canon: candidates and six recorded operator decisions remained (`ref:docs/storyworm/exec-plans/completed/2026-05-18-second-live-e2e-workbench-rehearsal.md:403`, `:678`).
- The cache probe ran on a synthetic prefix and did not prove savings on a real chapter (`ref:docs/storyworm/exec-plans/backlog/2026-05-14-provider-structured-context-cache-adoption.md:281`).
- **Quality and world consistency on a live model were never measured.** The corpus of observed errors (#334) stood in the plan after the live stages (`ref:docs/storyworm/dev-plan.md:76`). The acceptance of v1.5.0 ran on a fake provider, and the document states that it does not declare the version ready (`ref:docs/storyworm/mvp-acceptance-trace.md:14`).
- On fakes these worked: causal visibility, the atomic write of approved memory and the order of gates: an approval before QA gets 409.
- What did not work, by their own records. The demo names as the main gap that a committed patch does not turn into a snapshot that the next chapter reads (`ref:examples/two_chapter_memory_demo.py:639`). The promised chapter promotion gate did not exist (`ref:docs/storyworm/DECISION-LOG.md:51`).

### Why reference-001 is frozen

`commit:247550a8` ("Start main over from GOALS.md; old tree frozen on reference-001") records the size: 124 thousand lines of code, 135 thousand lines of tests, an SDD of 16 sections, 190 exec plans. They decided not to cut it down. There was nothing to migrate, cutting through tests welded to the schema would have become a rewrite, and the repository had already exceeded its own context budget three times over. The SDD went stale because its prose retold the tests. Soft limits were ignored because nothing failed. The new `main` rests on `GOALS.md` and on numbers that CI checks. For us the main thought of this commit is this: a canon made of the system's own extractions will not check itself, so the source text serves as the anchor.

## 2. Candidates

Duplicates from the three lenses (state, narrator, checks) are merged. The rows are sorted by the expected effect on consistency. The error classes are taken from the log entry about traps in the middle of a story (`docs/improve-log.md`): 1 means an impossible premise is carried out, 2 means the place of an item is lost, 3 means arithmetic of time and counters, "kn" means who knows what.

| # | Idea | Source | Class | Transfer | Cost | Main risk | Difference from what was rejected |
|---|---|---|---|---|---|---|---|
| A | A player's claim about the past, about other people's actions and about relationships is a character's line, not a fact of the world; the world and the characters answer from memory, and new content without a contradiction is accepted | `ref:docs/storyworm/spec/06-domain-contracts.md:76`, `ref:docs/storyworm/DECISION-LOG.md:133` | 1, kn | prompt (`SYSTEM`) | +80–120 tokens in the system prompt, no calls | the narrator argues with an honest author's correction; scenes are drier | Does not touch memory. The reverted change spoke about an *action* against a fact, this one speaks about a *premise* in the text of the turn (draw, bridge, alliance, 40 repeats) |
| B | The code computes the availability time: from HH:MM in memory and the turn time it prints «доступно с 08:20; на 08:14 ещё 6 мин» ("available from 08:20; at 08:14 there are 6 more min") | the principle "code decides what is deterministic": `ref:packages/story_domain/src/story_domain/visibility.py:64`, `ref:docs/storyworm/DECISION-LOG.md:46`. Computing world time is our hypothesis: storyworm does not store it | 3, 1 | code without a model (`prompt.ts`) | +20–60 tokens per stamp, no calls | a wrong time parse gives a confident "available" | Memory increments are not summed: one difference of two explicit moments, no accumulation of error |
| C | State slots from a closed vocabulary `subject`+`slot` (who holds it/where, body, available from, version in force) without `counters`; the code canonicalizes the name, prints the last value, and in case of doubt prints both candidates | `ref:packages/story_domain/src/story_domain/models/canon.py:418`, `ref:packages/story_domain/src/story_domain/models/ontology.py:71`, `ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/patch_builder.py:180`, `ref:docs/storyworm/spec/09-translator-text-v2-workflow.md:104` | 2, 1 | memory schema + code | +10–20 tokens per fact at compaction (~5% of the response), +200–600 tokens in the scene prompt | a missed handover gives a wrong summary line | Step (2) from the log: `key` apart from `counters`. There are no sums, so there is no bimodality of `dance` either. A vocabulary instead of free keys |
| D | The basis of a fact from a closed vocabulary: shown / a character said it / plan / cancelled / partial / rumor. The code collects what was cancelled and what was only discussed into a block «НЕ ПРОИСХОДИЛО» ("DID NOT HAPPEN"); only "shown" goes into the counter total | `ref:packages/story_domain/src/story_domain/models/ontology.py:22`, `ref:docs/storyworm/DECISION-LOG.md:119`, `:139` | 1, 3, kn | memory schema + code | +3–6 tokens per fact at compaction, a block of 100–400 tokens | the model will mark something that happened as "discussed"; the block of negations pushes towards refusals | It overlaps with `STATUSES` of the `sgr` mode only partly (`planned`, `cancelled`). The distinction "full / partial / cancelled" moves from the prose of the rules into a field, and the code does the selection |
| E | A reconciliation before the scene in the same call: the affected facts with their source, minutes and remainders as numbers; the code cuts it out before saving | `commit:247550a8` (the anchor is the source text), `ref:docs/storyworm/DECISION-LOG.md:68` (the live prompt is plain text, the model does not see JSON) | 1, 2, 3 | prompt + code | +150–350 output tokens, on the GPU +5–15 s (+15–30% to a scene) | **blocker:** `memory-probe.ts` gives the judge the raw text, the preview streams the reconciliation to the player; the eval needs a change, which is the owner's decision | The reconciliation is not stored: an error spoils one scene, not the whole branch |
| F | The player's turn is an attempt; before the outcome there is an ordered check: skill → place of the item (the last scene outweighs memory) → resource and deadline → body | `ref:docs/storyworm/spec/10-qa-v2.md:8`, `:17`; moving the QA checks into a generator rule is a conclusion of the lens, storyworm does not have this | 1, 2, 3 | prompt | +120–180 tokens in the system prompt | refusals on allowed turns; a long list blurs the format for Gemma | Hypothesis (b) from the log in another form: an order of sources of truth instead of a general ban. First run the baseline of the old change on the corrected story |
| G | Counter completeness: if a scene names the counter's item and a number, and there is no addend, the total is printed as «не менее N» ("at least N"); a follow-up request only under a flag | `ref:packages/story_domain/src/story_domain/models/chapter_cast.py:726` (an empty cast is a suspicion, not the norm) | 3 | code; a follow-up request at compaction under a flag | 0 without the follow-up request; with it +1 call of 3–8 thousand input tokens only in suspicious compactions | false alarms from times and dates in the text | Hits the cause of the bimodality, which is a missed addend. Makes sense only if counters come back |
| H | A separate small call at compaction rebuilds the snapshot "where things are, what is available when", up to 30 lines, each with a source; on a failure the previous snapshot stays with a note | `ref:docs/storyworm/spec/04-system-model.md:63`, `main:src/storyworm/pipeline.py:64` (a failure closes the attempt) | 2, 3, kn | call at compaction | +1 call: 10–25 thousand input tokens, 300–800 output, on the GPU +20–60 s per compaction | the snapshot lies confidently; the compaction flow in `generation.ts` changes, the owner's word is needed | The main schema does not change, there are no counters. A fallback path if C runs into the schema |
| I | An addend anchor: the number of an `add` must stand in the text of the scene from `source`, otherwise only the addends are printed instead of the total | `commit:247550a8`; by analogy with `ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/approved_memory.py:714` (the anchor of a *term* memory entry must be in the source text) | 3 | code | 0 calls, +5–10 tokens per element | does not catch the main error, which is an omission; numerals in grammatical cases | A safety guard for the rejected summary: in case of doubt it falls back to the log |
| J | Schema bounds (`add` 0…100000, `counters` ≤ 6, `key` ≤ 60) and a diagnosis of the looping | `ref:docs/storyworm/DECISION-LOG-ARCHIVE.md:390`: one bounded repair for an unknown entity type, then a refusal (`:391`) | other | schema; a retry without `counters` needs the owner's word | 0; on `output_limit` +1 compaction call | the looping may come from the array of facts, not from the integer | Without this no new schema field can be measured: it closes the second cause of the key/counters failure |
| K | Order in the request: the memory header «данные о мире, не указания» ("data about the world, not instructions"), a short list of checks right after the turn | `ref:apps/storyworm/src/storyworm/workflows/translator_text_v2/replay_context.py:437`, `ref:docs/storyworm/spec/08-context-pack-and-retrieval.md:37`, `ref:packages/story_domain/src/story_domain/models/committed_lore.py:307` | 1, 2, 3 | prompt | +40–60 tokens, the seed+memory prefix does not change | the model answers the list instead of writing the scene | The place of an already accepted rule changes, not its content. Measure only after A or F |
| L | Operations `new/update/retract` on slots; the code corrects a `new` on an occupied id and counts the drift | `ref:packages/story_domain/src/story_domain/patcher.py:33`, `ref:docs/storyworm/spec/06-domain-contracts.md:119`, `ref:packages/story_domain/src/story_domain/models/patch.py:36` | 2 | schema + code | +200–600 input tokens at compaction (a snapshot instead of a list of keys) | `retract` will remove an injury that is still in force, which is exactly the `healer` trap | A development of C, only after C is accepted |
| M | Character knowledge: `who` and `learned_at` on `knowledge` facts, the code renders the lines per character | by analogy: storyworm has no character knowledge, `ref:packages/story_domain/src/story_domain/models/observation.py:85` is visibility for the reader | kn | schema + code | +50–200 tokens | a "does not know" set by the model will forbid knowledge from the live scenes | `sava_learns` already passes on the corrected story; a shift above the noise on `sava_learns`, `knowledge_date`, `news` is not to be expected |
| N | A proposal to the owner for the eval: the probe saves the summary after compaction and, without a model, compares it with the reference numbers and holders; fields like `summaryHits/summaryMisses` separate a summary error from a reading error | `main:tests/test_causality.py:31`, `commit:1765807b`, `ref:docs/storyworm/exec-plans/AUDIT.md:85` | 3, 2 | eval (owner only) | 0 calls | a substring comparison catches numbers but not meaning | Makes the main complaint about key/counters measurable and tells C, G and I apart without a judge |

## 3. The best hypotheses as loop steps

Common to all steps (`docs/improve-loop.md`):

- The scene judge is `claude:claude-opus-5` (the main one since September 18, see `docs/improve-loop.md`) or `openai:gpt-5.4`; the same one on both sides.
- A baseline of the same day, the main model group. Before a run: `npm run eval -- usage`.
- No fewer than three runs per side; the sum over the runs is compared. The noise of Gemma is about one question, for `gpt-5.4-mini` it is up to three out of eight on `battle` (the log, entry "spread on the same code"). The target scene keys are binary, so one run distinguishes nothing.
- The `dance` memory of Gemma with key/counters gave 13, 9, 13, 13, 13, 7 out of 13 (the log, entry "state by keys and counters"). Where `dance` is affected, five runs are needed: three will not tell the two humps apart.
- The holdout pack is run by the owner or by Fable once after acceptance. A drop on it cancels the acceptance.
- The final acceptance is `npm run memory:probe` on the GPU when the owner says so. The hosted Gemma is more optimistic than the uncensored Q6K.

### Step 1. A: the player's premise is a character's line

Hypothesis: if the narrator reads a claim about the past in the player's turn as the words of a character and not as a fact of the world, the correction traps will start to pass, and the allowed turns will stay carried out.

Change: `local/prompt.ts`, only `SYSTEM`. One general rule without scenario details:
- an established fact is changed only by an explicit author's correction;
- new content that does not contradict what is established is accepted;
- if there is no information, the claim is neither confirmed nor refuted.

Keys:
- Shift: `draw_corrected`, `castle_corrected`, `mate_corrected`, `bridge_corrected`, `ally_corrected`, `tango40_corrected`, `partial_corrected`, `samira_corrected`.
- Control: `seal_allowed_worked`, `colors_right`, `gold_silver`, `count10_pause` and all questions of `examples/memory-checks.ts`.

Runs: three per side on all three scenarios for Gemma and `gpt-5.4-mini`. If the difference is 1–2 traps, two more. The change is cheap and does not depend on the memory schema, so it is reasonable to measure it first.

Revert (`git checkout -- local/prompt.ts`):
- the sum of correction traps over three runs grew by less than 2 for both models;
- any control dropped in two runs out of three;
- only one scenario grows (a sign of overfitting);
- a drop on the holdout pack.

### Step 2. B: the code computes the minutes until readiness

Hypothesis: if the code computes "how many minutes until readiness at the turn time" from the moments already recorded, the narrator will stop declaring an ability available before its time and stop making mistakes in the minutes.

Change: `local/prompt.ts`, the memory schema does not change.
- The turn time is taken from the HH:MM prefix in the player's message (the convention is already described in `SYSTEM`), otherwise from `referenceTime`.
- In memory facts with the same date the code finds HH:MM and prints, in the last message, lines like «момент 08:20 — через 6 мин от времени хода» ("moment 08:20: in 6 min from the turn time") with the note «по памяти на конец охваченных сцен» ("by memory as of the end of the covered scenes").
- Different dates and relative deadlines («через час», "in an hour") are not touched.
- If there are few moments in memory, the next step is to add an "available from" field to the schema. That is already a separate step.
- The unit test of the parse must catch "08:08 is not the eighth of August".

Keys:
- Shift: `turn15_seal_not_ready`, `turn15_seal_unused`, `seal_early_worked`, `turn8_seal_unused`.
- Control: `seal_allowed_worked` (at 08:21 with readiness from 08:20 the seal must work), `seal_allowed_charges`, `turn11_three_left`, memory `first_use`, `second_use`, `next_use`.

Runs: `battle` gets four per side for Gemma, three each for `gpt-5.4-mini` and Ministral. It is the only scenario with a minute scale, and all four target keys are binary. `dance` and `chess` get one run per side, only to make sure that nothing broke.

Revert:
- `seal_allowed_worked` dropped at least once;
- the sum over the target keys grew by no more than 1 over three runs;
- the service note got into the prose of a scene at least once;
- the memory questions about moments dropped;
- a drop on the holdout pack.

### Step 3. C: state slots without counters, after the J diagnosis

First the J diagnosis, without acceptance: the same compaction request without `counters`. If `output_limit` is gone, the looping came from them. After that comes C.

Hypothesis: if the current value ("where the item is, what is with the body, what is available, which version is in force") is stored as one overwritable slot from a closed vocabulary and without sums, Gemma will stop losing the place of an item after the second compaction, and `dance` will not become bimodal.

Change:
- `local/memory.ts` (`plain`): a fact with `kind=state` gets the fields `subject` (the name verbatim from the text) and `slot` from the enum `holder`, `condition`, `available_from`, `version`, `remaining`. `remaining` holds only a number named in the text. `counters` are removed, the rules paragraph about keys is shortened to one or two sentences, the length bounds are as in J.
- `local/prompt.ts`: `stateText` groups the last values by `subject`. The code canonicalizes the name: case, ё/е, quotation marks, spaces. If two names differ by one word, both candidates are printed with dates, without a choice.
- `lib/library.ts`: the `Fact` type. The tests go in `local/memory.test.ts`.

Keys:
- Shift: `turn14_dagger_with_tarek`, `dagger_source`, `turn9_left_hand_spared`, `turn15_still_broken`, `healer_still_broken`, `wrist_limits`.
- Control: `seal_allowed_worked`, `b_total_38` (without `counters` the model computes the total again), memory of `battle` (`charges`, `next_use`, `fracture_healed`), all memory of `dance` (13 questions), `compactionRetries`, `invalid_memory`.

Runs: Gemma gets four per side on `battle` and five on `dance`. `gpt-5.4-mini` and Ministral get three each on `battle` and `dance`. `chess` gets three runs as a control. Compare with `HEAD` without key/counters, not with the working tree.

Revert (`git checkout -- local/memory.ts local/prompt.ts lib/library.ts local/memory.test.ts`):
- any run of Gemma on `dance` below 12/13;
- `compactionRetries` above the baseline (before key/counters it was 0 over about 18 compactions, the log);
- `turn14_dagger_with_tarek` passes less often than in three runs out of four;
- a control dropped;
- a drop on the holdout pack.

### Step 4. D: the basis of a fact and the "did not happen" block

Hypothesis: if every fact has a basis from a closed vocabulary, and the code moves what was cancelled and what was only discussed into a separate block, the narrator confirms things that did not happen less often, and the memory questions do not drop.

Change:
- `local/memory.ts` (`plain`): a required enum field `basis` with the values `shown`, `told`, `planned`, `cancelled`, `partial`, `rumor`. It overlaps with `STATUSES` of the `sgr` mode (`actual`, `planned`, `cancelled`, `uncertain`) only partly: `shown` corresponds to `actual`, and there is no `uncertain` here. There is no `other` value either: storyworm gave it up for entity types, because a classification error hides under `other` (`ref:docs/storyworm/DECISION-LOG-ARCHIVE.md:400`).
- `local/prompt.ts`: a label on the fact and the block «НЕ ПРОИСХОДИЛО» at the end of memory. `SYSTEM` does not change.
- If counters come back by that time, only `shown` goes into the total. That is a separate step.

Keys:
- Shift: `draw_corrected`, `castle_corrected`, `mate_corrected`, `bridge_corrected`, `ally_corrected`, `tango40_corrected`, `partial_corrected`. Memory questions: `cancelled_tango`, `partial_repeats`, `partial_clean`, `draw`, `mate`, `variation`, `alliance`, `extra_castle`.
- Control: `seal_allowed_worked`, `colors_right`, `count10_pause`, `gold_silver`, `compactionRetries`.

Runs: three per side on all three scenarios for Gemma, `gpt-5.4-mini` and Ministral. Ministral checks whether a weak model holds one more required field. Measure after step 1: A and D hit the same traps, and otherwise their effects will mix.

Revert:
- a control dropped at least once;
- `invalid_memory` or `compactionRetries` above the baseline;
- the sum of correct memory answers over the runs is below the baseline;
- the correction traps grew by less than 2 over three runs;
- a drop on the holdout pack.

## 4. What not to take from storyworm

| What | Why not to take it | Cost if taken |
|---|---|---|
| A separate critic call for every scene (consistency/adequacy QA by a model) | The canonical QA in reference-001 is deterministic. The model check of adequacy was only an observation on one live run, without a gate and without a measurement of its benefit. For the bot this is a second pass over the same context | +1 call per scene with ~50 thousand input tokens: on one GPU the scene latency roughly doubles |
| Escalation to another role, then to another model family; an open question with two candidates | In `main` this is a goal from `GOALS.md` (`commit:247550a8`), not a verified mechanism. The bot has one model on its own GPU, adult content does not go to hosted APIs, and there is no second family | a second model in GPU memory or a forbidden external call |
| A human in the loop: a review package, approve/reject/defer, candidate cards, a workbench | The owner does not review every compaction. storyworm itself admitted that bare JSON is not fit for a human, and it was building a UI | a UI and a decision queue; compaction waits for a human |
| A patch log with the statuses DRAFT/COMMITTED/REJECTED, hashed versioned contracts, drift checks at every step | The branch memory is already append-only and is written atomically (`local/generation.ts`). This bureaucracy is exactly what bloated reference-001 | code and tests welded to the schema, which is the lesson of their reset |
| Durable authorization, leases, accounting in microdollars, retry limits per line | Daily limits already exist in `local/budget.ts`. The rest is product infrastructure for many users | code that does not affect consistency |
| Causal visibility by paragraph, a disclosure policy, the chapter cast | The bot writes forward: there is no future text, so nothing can leak. The analog "who knows from which moment" is moved into M and is expected to be weak | fields and filters without a purpose |
| Term memory, a surface form policy, translation locks | A layer of the translation task; a story does not have it | — |
| A numeric confidence threshold | The authors themselves call it an uncalibrated middle: the model's self-assessment converges to 0.8 (`ref:docs/storyworm/DECISION-LOG.md:139`) | noise instead of a signal |
| Specification prose on top of tests | storyworm gave it up: the text retold the tests and went stale. For us this is an argument to keep `improve-loop.md` short and to check the rules with the eval | stale documents |

What is worth taking is not a mechanism but a discipline. A claim is no stronger than its weakest evidence (`ref:docs/storyworm/exec-plans/AUDIT.md:85`). Subagent teams are postponed in their development plan, and the payoff there is expected from tests, the schema, adequacy QA and the eval (`ref:docs/storyworm/learning-plan.md:278`). For us, multi-agent work collapses into a prompt rule (A, F), into a schema field (C, D) or into code (B, G, I). An extra call is acceptable only at compaction (H, J) and only after the owner agrees to a change of the flow.

## 5. Verification

First pass. A separate agent checked each claim by file and line. Its verdict was confirmed, corrected, refuted or not confirmed. There were no refuted and no unconfirmed claims; 54 claims were corrected. The corrections that change the meaning:

- "Round 12 requires `e{n}` in the prompt". Round 12 (`commit:1765807b`) compares context sizes by role and call number, and `e{n}` appeared in Round 17 (`commit:e194c82f`).
- "Cost accounting is implemented". In `main` only a test defines it: there is no `/ledger` route, and the test fails.
- "The disclosure policy models who knows what". It says what is visible and from which moment, and it has no "who" axis. So M is a transfer by analogy.
- "The canon keeps two time axes". The time in the world is not stored. B is our hypothesis; only the principle "code decides what is deterministic" is taken from storyworm.
- "The anchor checks the fact against the text" (`main:src/storyworm/pipeline.py:58`). Only the range of paragraph numbers is checked. I requires more than storyworm did.
- "`other` was rejected for the evidence kind". It was rejected for the entity type; in C and D this is a transfer.
- "Any invalid output gets a repair". Only an unknown entity type, one paid call, then a refusal.
- "There are no role prompts". They are hardcoded as strings in the code, and there is more than one translation prompt.
- "The acceptance of v1.5.0 is proven". The document directly states that it does not declare the version ready.
- "A retry only when the sending is proven". The opposite: only when the request definitely did not go out or the response is known (429/5xx).
- "The SDD and the decision log were cancelled for one reason". The SDD was going stale, and the decision log was replaced by git.
- "Six operator decisions were accepted". Six decisions were recorded; the source does not say whether they were approved.

Second pass: the critic rechecked about 35 references in the text of the document. Three claims of the first draft turned out to be wrong, two were imprecise. Everything is corrected above:

- "reference-001 had no model QA". There was a model observation of adequacy (`ref:apps/storyworm/src/storyworm/translation_pipeline_execution.py:296`), but without a gate.
- "The extractor in the code is a stub". Only the causal canon extractor is a stub. On the live run a model extracted the facts and terms, and the result remained as candidates.
- "A context overflow gives an error". This is true only for summaries. Lore above the limit is dropped with a recorded reason.
- The references to the limits of summaries and lore pointed to the wrong file. Corrected to `translation_context_basis.py` and `committed_lore.py:28`.
- "`basis` matches `STATUSES`". The match is only partial.

Ideas B, F, M and N rest on storyworm more weakly than the others and are marked as our own conclusions. The numbers on simple-story-chat are taken from `docs/improve-log.md` and `docs/improve-loop.md` (noise, the bimodality of `dance`, compaction retries, the judge).
