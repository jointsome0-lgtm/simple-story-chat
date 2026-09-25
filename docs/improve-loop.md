# The improvement loop for the story system

Working instruction for the assistant that the owner starts to improve prompts and memory. Written on 18 September
2026 by a Fable 5.1 session, with the owner's later decisions added under their dates. The commands are in
[eval.md](eval.md) and every step so far in [improve-log.md](improve-log.md). What was verified live on 18 September
is in [provider-checks.md](knowledge/provider-checks.md#eval-verified-2026-09-18): check that record against the
code, not the code against that record.

## Goal

The story system must work on any model, not on one model. We look for general principles of prompts and memory that raise the result for models of the Gemma 4 31B class and do not break the other models. Free hosted models serve as a cheap test ground for this; the bot does not run on them.

There are two measures. Both come from `npm run eval`. Both are computed over the worst model in the list, and separately for the modes `plain` and `sgr`:

- `score` — the share of correct answers to fixed questions about memory.
- `sceneScore` (with a `--judge`, see [the judges](#models)) — the share of continuity traps that the model withstood. The
  turns of `examples/scene-traps.ts` push it to break an established fact or state in passing something that did not
  happen, with controls among them, some in the middle of the story. The judge answers fixed yes/no questions based on
  the author's facts and the scene text. This measure shows what the first measure does not see: a model can answer correctly how many charges remain and then immediately write a scene with a different number.

The walk and the gold tree, after the step below, measure consistency on scenes the model writes itself. How the
replay, the walk, the gold tree and the daily limits work is in [eval.md](eval.md).

<a id='change-scope'></a>

## What may change

- `local/prompt.ts` — the narrator's rules and the assembly of the request.
- `local/memory.ts` — the schema and the instructions for fact extraction, the modes `plain` and `sgr`.
- `local/generation.ts` — only the texts and parameters of compaction; do not touch the order of checks or the atomicity of the memory write.
- Tests for these files, when behaviour changes.

<a id='frozen-boundaries'></a>

## What may not change

Editing any item from this list makes the comparison of versions meaningless. If it seems that you cannot do without such an edit, stop and write to the owner.

**Owner's word, 2026-09-21: the freeze is lifted for one purpose, building stronger evals.** The present instruments
saturate: almost every model scores full marks, a constant "yes" outscores the judge, and a change to the prompts
cannot be seen as progress. `local/eval.ts`, `local/scene-judge.ts`, `local/scenarios.ts`, `local/pack-hf.ts`, the
probes and new fixtures may change for that work, including an optional seed for `--lab` runs. It is not a licence
to edit a check because a prompt fails it: within one step of the loop the list below still binds, the old checks
and traps stay as a separately scored legacy set so the log stays readable, and `local/budget.ts`, the limits in
`.env.eval`, the holdout and the privacy rules are not part of the lift.

Measured in Russian only for now: the tester reads Russian, and the other four catalogs in `local/story-text/` wait.
A change to the narrator's rule is made in the catalog, not only in `local/prompt.ts`, which interpolates it.

Who does the work: Opus agents, paired with the local model, for the bulk; Fable and GPT-6 only at the steps that
decide something — a design, a review of core code, a verdict on pictures — because they cost much more.
Opus agents are started at `max` reasoning effort, always; GPT-6 sessions at `high`.

- `examples/memory-checks.ts`, `examples/scene-traps.ts`, `examples/*-probe.ts`, `examples/frozen/` — questions, answers, scenarios and frozen scenes. Describe an error in a check to the owner; do not fix it yourself.
- `local/eval.ts`, `local/scene-judge.ts`, `local/scenarios.ts`, `local/pack-hf.ts`, `local/budget.ts`, the judge model, the limit values in `.env.eval` — the eval and the safety guard.
- The ban on the providers `openai-compatible` and `codex-cli` for the bot without the explicit consent of the instance owner (`SIMPLE_CHAT_ALLOW_HOSTED`) in `local/config.ts`, and the privacy rules from `AGENTS.md`. Do not open `.env`, `.env.eval`, `data/`, `backups/`; get a needed fact from them with code that prints booleans, numbers and sizes.
- The prompt must not be fitted to the known questions: no mentions of seals, bells, chess, dances or other scenario details. A rule must be worded for any story. Fitting is visible when one scenario grows and the other scenarios stay the same.

<a id='one-step'></a>

## One step of the loop

1. `npm run eval -- usage`. If less than one run remains before the channel limit, finish for today.
2. Baseline: run the eval on the current code, save `--out` to a directory outside the repository. Without a baseline from the same day there is nothing to compare with: the set and the behaviour of the free models change.
3. Read the fields `failedKeys` and `error` in `eval.json` for each model, for memory and for `scene`. Look for what several models fail at once: this is a candidate for a general principle. Record a failure of a single model, but do not fix it with the prompt.
4. State one hypothesis in one sentence and make one edit. Several edits in one step do not let you see which edit worked.
5. `npm test` and `npm run check` must pass.
6. Run the eval with the same list of models and scenarios.
7. Compare with the baseline. The edit is accepted if `score` or `sceneScore` grew by more than the noise (see below), the other measure did not fall, and no model of the main group fell. Commit an accepted edit as a separate commit in the working branch; revert a rejected edit with `git checkout -- <file>`.
8. Record the step in full in `docs/knowledge/improve-runs.md`: date, hypothesis, what was changed, numbers before and after per model, decision. Add its line to `docs/improve-log.md`. Record rejected hypotheses too: they save runs for the next executor.

Step 7 reverts this step's own edit and nothing else in the working tree.

The walk (`npm run eval -- walk`, described in [eval.md](eval.md#walk)) is the second measure: the model writes a story from a seed on its own, with the bot's continue signal or the author's intervention at each step, and a panel of judge models reads every scene for contradictions with what came before. Its `score.walk` is the share of scenes the panel found consistent, for the worst model. It is compared the same way as `sceneScore`, and it needs several walks per side: the story differs from run to run.

The gold tree (`eval walk-gold`, `eval walk-nodes` in [eval.md](eval.md#gold-tree)) is the walk with fixed prefixes: scenes the council accepted, grown from the seed as a tree, so that every model continues from the same accepted story and is judged scene by scene at a known depth. The gate is the agreement of every judge, not the eval's majority: a finding one judge stands by keeps a scene out. An agreed scene is a candidate; it becomes gold by its ledger (rechecks, deeper scenes judged over it, the whole-story audit), and the tree's rendering marks what no person has read. The eval's number and the score by depth come from the same council as the walk; a model on the council still is not measured independently.

<a id='gold-v2'></a>

### The gold tree, version 2: the owner's decisions of 2026-09-23

Version 1 (`examples/walk/lighthouse.gold.json`, public, [the log entry of 2026-09-23](knowledge/improve-runs.md#gold-v1-2026-09-23)) is a draft: 63 scenes at 16
depths, every one agreed by four judges once, none promoted. Version 2 is the one meant to become gold, and it is
built differently. Written here so that it is not forgotten when the next seed is made.

- **The seed is audited until the council finds nothing**, and only then does anything grow. Version 1 grew on a seed
  rewritten after one audit and never audited again; the depth of the water over the spit was missing. A seed may be
  any size the model's window allows (it goes whole into every request, untouched by compaction), and the eval
  should have the same world in several sizes, about 5, 15 and 37 KB, to see whether consistency moves with the seed.
- **Growth in width, not one trunk.** At every depth the k best nodes by their ledger (k about 2 or 3) are continued,
  each by all four writers; every agreed scene stays in the tree; no trunk is chosen on the way. The ledger ranks a
  node by what happens below it: how many deeper scenes were judged over it against how many later findings pointed
  back at it, how many attempts its continuations cost (a node that is hard to continue hides a trap: an ambiguity
  the scene itself does not show), the whole-story audit and the fresh rechecks. Gold is the set of nodes whose
  ledger passes the thresholds, and the paths through them are several: different worlds, each consistent with the
  seed and with itself, not with each other. The eval continues from every gold node; the reading for people shows
  several stories with a common beginning.
- **Length is never scored.** Consistency is the only measure; the rule on the author's step guards against saying
  nothing. A writer that puts more claims into a scene pays more attempts, not a penalty.
- **Thresholds come from measured noise, not from guesses.** Version 1's recheck says how often a scene agreed once
  is refused on a fresh reading, and why (a lone judge insisting, or a real finding); the rule should ask for k of n
  rechecks rather than all of them, and count an audit issue only when a second audit repeats it. Version 1's
  numbers are in [the log entry](knowledge/improve-runs.md#gold-v1-2026-09-23).
- **The tree grows without a cap; the eval limits what it measures.** A weaker model is measured on the nodes whose
  path from the seed fits its limit, about 50k tokens counted with tiktoken (`o200k_base`) as the one ruler that does
  not depend on the model under test; the frontier is measured on the whole tree; one limit per run, named in the
  report with the nodes it admitted. Done on 2026-09-23: `gold-stats` writes `pathTokens` into every node and the reading shows it,
  `walk-nodes --max-path-tokens` admits the tasks that fit, the `tiktoken` package (the WASM build of OpenAI's own
  core, the same counts as the Python package) is a dependency of the eval only.
- **Version 2 grows on a private seed into the private pack**, by a session that does not run the improvement loop;
  version 1 stays public. A person reads the gold paths (`eval gold-read`) before anything is called gold.

Status on 2026-09-25. Only the path limit of the fifth item is built. The seed audit until the council finds
nothing, the growth in width, the thresholds from measured noise, the private seed and the reading by a person are
still to do. `seed-audit` and `gold-read` ([eval.md](eval.md)) are the tools for the first and the last.

## Noise

Memory is generated at temperature 0.2, and OpenAI generates at its own default temperature, so two runs of the same code give different numbers. The spread on `battle` was measured on 18 September ([entry in the log](knowledge/improve-runs.md#noise-2026-09-18)): for `gpt-5.4-mini` up to three questions out of eight between runs, for Gemma one question, Ministral is stable. Therefore, on one scenario compare at least three runs per side. An improvement smaller than this spread does not count as an improvement; check a disputed result with a repeated run, do not declare it a win.
Both sides of one comparison are judged by the same judge; numbers from different judges are not compared.

Three runs are a floor, not a proof. Under the counters change of 18 September the paid Gemma scored 13, 9, 13, 13,
13 and 7 out of 13 on `dance`. When it missed one term, the summary stated a wrong value with confidence
([the entry](knowledge/improve-runs.md#counters-2026-09-18)). Three of those runs could have shown only the 13s.

## Models

The main group, decisions are made on it:

```
openrouter:google/gemma-4-31b-it,mistral:ministral-14b-2512,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001
```

Gemma here is paid (`openrouter-paid`, limit 600 000 tokens per day, about $0.20); why the free one was not taken is
in [provider-checks.md](knowledge/provider-checks.md#free-gemma-2026-09-19). We do not take a model without an enforced schema into the main group: its format is random, and the noise covers any edit.

Control, for the rare full run: `openrouter:deepseek/deepseek-v4-flash-0731:free`. A weak model for checking the clarity of wording: `openrouter:liquid/lfm-2.5-2.6b:free`.

`score` is currently computed as the minimum over all models from `--models`, without division into groups. Therefore run the control models and the weak model with a separate command, otherwise the number will show only the weakest model.

On 18 September the main judge was `claude:claude-opus-5`, with `openai:gpt-5.4` beside it; their cross-check is in
[provider-checks.md](knowledge/provider-checks.md#eval-verified-2026-09-18). Word a question to the judge in the
affirmative form.

The frozen scenes were written on 18 September by clean Fable 5.1 agents, one agent per scenario, as files `scene-NN.md`; `node local/freeze-scenes.ts --scenario <name> --scenes <directory> --author <label>` builds `examples/frozen/<name>.json` from them. The free DeepSeek is not suitable for this: it led the plot away from the author's messages, and the story contradicted the reference answers. Check a recorded story with `npm run eval -- ceiling --model openai:gpt-5.4`: questions over the full text without compaction must give the maximum, otherwise the story is unusable. `ceiling` of a model from the main group shows that model's own reading ceiling: a failure below the ceiling is the fault of memory, a failure at the ceiling is not. Accepted scenes may not be rewritten without the owner: a new recording invalidates all previous comparisons.

<a id='holdout'></a>

## The holdout pack of scenarios

The open scenarios from `examples/` are visible to whoever improves the prompts, so a rule can be fitted to them without anyone noticing. The holdout pack is stored outside the repository, with the owner: the directory `~/simple-story-chat-holdout/`, a copy in the private Hugging Face dataset `Teadomi/simple-story-chat-holdout`. **Whoever runs the improvement loop does not open this directory**: not `scenario.json`, not the scenes, not the reports of runs on it. They see only the final numbers.

- Format: `<pack>/<scenario>/scenario.json` (seed, 16 turns, `checks`, `facts`, `traps`, `authors`) and `frozen.json`; `local/scenarios.ts` validates it. Scenes are built by `node local/freeze-scenes.ts --pack <pack> --scenario <name> --scenes <directory> --author <label>`.
- Authors: Astra (`gpt-6-astra`) and Fable together, when both are available; otherwise one of them; Opus may also write. Everyone who wrote or edited a scenario adds themselves to `authors`; `eval` carries the authors into the result file. The author of a holdout scenario does not run the improvement loop in the same session.
- Running: `npm run eval -- --pack ~/simple-story-chat-holdout --models … --mode plain --judge claude:claude-opus-5`; `ceiling --pack …` checks the story the same way as an open story. `eval write` is forbidden for a pack.
- Storage: `node local/pack-hf.ts push --pack ~/simple-story-chat-holdout --repo Teadomi/simple-story-chat-holdout` uploads the pack and prints the revision; `pull … --revision <commit>` downloads exactly that revision to another machine (for example, to the GPU). `HF_TOKEN` is in `.env.eval`. The accepted revision as of 18 September: `a24e6c75f29a7499013ea009233c9ab628f1f106`. Numbers are comparable only within one revision; record a new revision in the log.
- The open part (`battle`, `chess`, `dance`) is published in the same format in the public dataset `Teadomi/simple-story-chat-eval`, revision `632a57972119766464167651c3ad8726db8e92f1`; it can be read without a token. The source of truth remains in `examples/`: after editing the open scenarios repeat `node local/pack-hf.ts export --pack ~/simple-story-chat-eval --authors <authors>` and `push`; the owner publishes.
- Since 22 September the public pack also holds scenarios that exist only in pack format: `assault` and `hospital` (see [the log](knowledge/improve-runs.md#scenarios-2026-09-22)). They are run with `--pack ~/simple-story-chat-eval --scenarios assault,hospital`; `export` rewrites only the three `examples/` scenarios and leaves them alone, so the pack directory is their source of truth. They were built to separate: 12 checks, 9 of them numbers that accumulate across the compactions, judge questions balanced 6 `yes` / 6 `no`. [The 09-22 entry of the log](knowledge/improve-runs.md#scenarios-2026-09-22) is the scale of models on them; a model at 12/12 there is at the top of what the eval can currently see.
- The holdout score is run by the owner or by Fable, no more often than once per accepted change: it confirms that the growth on the open scenarios is not fitting. Growth on the open scenarios together with a fall on the holdout scenarios is a reason to revert the change.

<a id='acceptance-on-gpu'></a>

## Acceptance on the GPU

The bot runs on an uncensored Gemma 4 31B Q6K on its own GPU; hosted models are only a test ground. Hosted Gemma is an optimistic substitute: after refusal removal and quantization the model follows the format worse. An edit counts as finally accepted after `npm run memory:probe` on the GPU through the queue of the running bot. The rental costs money, so only what is already selected is checked on the GPU, once every few steps, and only on the owner's word. Adult content is never sent to hosted APIs: the test-ground scenarios stay clean. The owner has made two exceptions, both for judging pictures. The first, 2026-09-21: the hand-written "sharp" prompt set (battlefield, wounds, an execution, an interrogation, a harem, a bath) is drawn on the rented card only, its prompts are written by hand and never pass a hosted text model, and its pictures may be shown to a GPT-6 session for the blind comparison as long as a picture has no explicit nudity. A picture that has it is judged by the owner alone. The second, 2026-09-25, is for the sharp scenes of the multi-person action test planned that day: the uncensored Gemma writes them itself on the rented text card, with every character an adult and no sexual violence. Their texts and pictures, nudity included, go to a GPT-6 judge session, `codex:gpt-6-astra` first and `codex:gpt-6-sol` where Astra refuses, and the owner judges what both refuse. No Claude session reads those texts, those pictures or the judges' reports on them; code takes only the answers out of the reports.

The Gemma build named above is the bot's production model as of 2026-09-25.

<a id='stop-conditions'></a>

## When to stop and write to the owner

- `budget_exceeded`, `unauthorized` or 402/403 from a provider. Do not raise limits yourself, do not open paid channels.
- Three rejected hypotheses in a row: most likely the bottleneck is not in the prompt but in the checks, the scenarios or the memory schema, and that is the owner's decision.
- An edit from the section "What may not change" is needed.
- A check from `memory-checks.ts` looks wrong or ambiguous.

In the report to the owner: what you tried, numbers before and after per model, what was accepted, what was rejected and why, how many requests were spent.
