# The improvement loop for the story system

Working instruction for the assistant that the owner starts to improve prompts and memory. Written on 18 September 2026 by a Fable 5.1 session; the default executor is Opus 5. The state as of that date is recorded in the section "What was verified live": check that section against the code, not the code against that section.

## Goal

The story system must work on any model, not on one model. We look for general principles of prompts and memory that raise the result for models of the Gemma 4 31B class and do not break the other models. Free hosted models serve as a cheap test ground for this; the bot does not run on them.

There are two measures. Both come from `npm run eval`. Both are computed over the worst model in the list, and separately for the modes `plain` and `sgr`:

- `score` — the share of correct answers to fixed questions about memory.
- `sceneScore` (with the flag `--judge claude:claude-opus-5` or `--judge openai:gpt-5.4`, see below about judges) — the share of continuity traps that the model withstood. After the last frozen scene the model writes one scene for each turn from `examples/scene-traps.ts`: the player's turn pushes the model to break an established fact (use a technique before its time, take an item that the hero does not have), states in passing something that did not happen, or, as a control, is allowed; some scenes are written in the middle of the story in reply to an author's message. The judge answers fixed yes/no questions based on the author's facts and the scene text. This measure shows what the first measure does not see: a model can answer correctly how many charges remain and then immediately write a scene with a different number.
How the evaluation, the adapter and the daily limits work is described in [model-providers.md](model-providers.md).

## What may change

- `local/prompt.ts` — the narrator's rules and the assembly of the request.
- `local/memory.ts` — the schema and the instructions for fact extraction, the modes `plain` and `sgr`.
- `local/generation.ts` — only the texts and parameters of compaction; do not touch the order of checks or the atomicity of the memory write.
- Tests for these files, when behaviour changes.

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

## One step of the loop

1. `npm run eval -- usage`. If less than one run remains before the channel limit, finish for today.
2. Baseline: run the eval on the current code, save `--out` to a directory outside the repository. Without a baseline from the same day there is nothing to compare with: the set and the behaviour of the free models change.
3. Read the fields `failedKeys` and `error` in `eval.json` for each model, for memory and for `scene`. Look for what several models fail at once: this is a candidate for a general principle. Record a failure of a single model, but do not fix it with the prompt.
4. State one hypothesis in one sentence and make one edit. Several edits in one step do not let you see which edit worked.
5. `npm test` and `npm run check` must pass.
6. Run the eval with the same list of models and scenarios.
7. Compare with the baseline. The edit is accepted if `score` or `sceneScore` grew by more than the noise (see below), the other measure did not fall, and no model of the main group fell. Commit an accepted edit as a separate commit in the working branch; revert a rejected edit with `git checkout -- <file>`.
8. Record the step in `docs/improve-log.md`: date, hypothesis, what was changed, numbers before and after per model, decision. Record rejected hypotheses too: they save runs for the next executor.

The walk (`npm run eval -- walk`, described in `docs/model-providers.md`) is the second measure: the model writes a story from a seed on its own, with the bot's continue signal or the author's intervention at each step, and a panel of judge models reads every scene for contradictions with what came before. Its `score.walk` is the share of scenes the panel found consistent, for the worst model. It is compared the same way as `sceneScore`, and it needs several walks per side: the story differs from run to run.

The gold tree (`eval walk-gold`, `eval walk-nodes` in `docs/model-providers.md`) is the walk with fixed prefixes: scenes the council accepted, grown from the seed as a tree, so that every model continues from the same accepted story and is judged scene by scene at a known depth. The gate to gold is stricter than the eval's majority, a scene the council could not settle is not gold, and the tree's rendering marks what no person has read. The eval's number and the score by depth come from the same council as the walk; a model on the council still is not measured independently.

## Noise

Memory is generated at temperature 0.2, and OpenAI generates at its own default temperature, so two runs of the same code give different numbers. The spread on `battle` was measured on 18 September (entry in the log): for `gpt-5.4-mini` up to three questions out of eight between runs, for Gemma one question, Ministral is stable. Therefore, on one scenario compare at least three runs per side. An improvement smaller than this spread does not count as an improvement; check a disputed result with a repeated run, do not declare it a win.

## Models

The main group, decisions are made on it:

```
openrouter:google/gemma-4-31b-it,mistral:ministral-14b-2512,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001
```

Gemma here is paid (`openrouter-paid`, limit 600 000 tokens per day, about $0.20): the free Gemma does not enforce the schema and answers 429 for hours. We do not take a model without an enforced schema into the main group: its format is random, and the noise covers any edit.

Control, for the rare full run: `openrouter:deepseek/deepseek-v4-flash-0731:free`. A weak model for checking the clarity of wording: `openrouter:liquid/lfm-2.5-2.6b:free`.

`score` is currently computed as the minimum over all models from `--models`, without division into groups. Therefore run the control models and the weak model with a separate command, otherwise the number will show only the weakest model.

The frozen scenes were written on 18 September by clean Fable 5.1 agents, one agent per scenario, as files `scene-NN.md`; `node local/freeze-scenes.ts --scenario <name> --scenes <directory> --author <label>` builds `examples/frozen/<name>.json` from them. The free DeepSeek is not suitable for this: it led the plot away from the author's messages, and the story contradicted the reference answers. Check a recorded story with `npm run eval -- ceiling --model openai:gpt-5.4`: questions over the full text without compaction must give the maximum, otherwise the story is unusable. `ceiling` of a model from the main group shows that model's own reading ceiling: a failure below the ceiling is the fault of memory, a failure at the ceiling is not. Accepted scenes may not be rewritten without the owner: a new recording invalidates all previous comparisons.

## The holdout pack of scenarios

The open scenarios from `examples/` are visible to whoever improves the prompts, so a rule can be fitted to them without anyone noticing. The holdout pack is stored outside the repository, with the owner: the directory `~/simple-story-chat-holdout/`, a copy in the private Hugging Face dataset `Teadomi/simple-story-chat-holdout`. **Whoever runs the improvement loop does not open this directory**: not `scenario.json`, not the scenes, not the reports of runs on it. They see only the final numbers.

- Format: `<pack>/<scenario>/scenario.json` (seed, 16 turns, `checks`, `facts`, `traps`, `authors`) and `frozen.json`; `local/scenarios.ts` validates it. Scenes are built by `node local/freeze-scenes.ts --pack <pack> --scenario <name> --scenes <directory> --author <label>`.
- Authors: Astra (`gpt-6-astra`) and Fable together, when both are available; otherwise one of them; Opus may also write. Everyone who wrote or edited a scenario adds themselves to `authors`; `eval` carries the authors into the result file. The author of a holdout scenario does not run the improvement loop in the same session.
- Running: `npm run eval -- --pack ~/simple-story-chat-holdout --models … --mode plain --judge claude:claude-opus-5`; `ceiling --pack …` checks the story the same way as an open story. `eval write` is forbidden for a pack.
- Storage: `node local/pack-hf.ts push --pack ~/simple-story-chat-holdout --repo Teadomi/simple-story-chat-holdout` uploads the pack and prints the revision; `pull … --revision <commit>` downloads exactly that revision to another machine (for example, to the GPU). `HF_TOKEN` is in `.env.eval`. The accepted revision as of 18 September: `a24e6c75f29a7499013ea009233c9ab628f1f106`. Numbers are comparable only within one revision; record a new revision in the log.
- The open part (`battle`, `chess`, `dance`) is published in the same format in the public dataset `Teadomi/simple-story-chat-eval`, revision `632a57972119766464167651c3ad8726db8e92f1`; it can be read without a token. The source of truth remains in `examples/`: after editing the open scenarios repeat `node local/pack-hf.ts export --pack ~/simple-story-chat-eval --authors <authors>` and `push`; the owner publishes.
- Since 22 September the public pack also holds scenarios that exist only in pack format: `assault` and `hospital` (see the log). They are run with `--pack ~/simple-story-chat-eval --scenarios assault,hospital`; `export` rewrites only the three `examples/` scenarios and leaves them alone, so the pack directory is their source of truth. They were built to separate: 12 checks, 9 of them numbers that accumulate across the compactions, judge questions balanced 6 `yes` / 6 `no`. The 09-22 entry of the log is the scale of models on them; a model at 12/12 there is at the top of what the eval can currently see.
- The holdout score is run by the owner or by Fable, no more often than once per accepted change: it confirms that the growth on the open scenarios is not fitting. Growth on the open scenarios together with a fall on the holdout scenarios is a reason to revert the change.

## What was verified live as of 18 September 2026

- The OpenRouter, OpenAI and Mistral keys in `.env.eval` are accepted by the providers. The daily counter counts.
- OpenRouter: the stream format, disabling reasoning (`reasoning.enabled=false`) on DeepSeek and Gemma, recording the scenes of the `battle` scenario.
- OpenAI: `gpt-5.4-mini` responds, the stream format matched the expected format.
- Mistral: `ministral-14b-2512` responds. `mistral-large-2512` is not available on the Free plan (403), `mistral-small` and `mistral-medium` answered 429 even to a single request.
- Cerebras: 402 on all models, free access is not enabled on the account. Do not use.

- The full `npm run eval` on `battle` passes from scene recording to `score`; the first numbers are in [improve-log.md](improve-log.md).
- The memory schema is enforced by the provider in OpenAI, Mistral and the paid Gemma on OpenRouter: with it `plain` passes for all three.
- Claude CLI with a schema (`--json-schema`): Haiku 4.5 passes `plain`. Compaction with a schema takes about two minutes, and `sgr` hits the 300-second timeout: this is a failure of CLI speed, not of memory.
- `sgr` does not pass for any model because of the `quote` check; the analysis is in the log. Until this is solved, decisions are made on `plain`.

- Analysis of a sum failure without a model: for a numeric answer of two or more digits the probe writes `stated` — whether the number is present in the memory message (`memory`), in the scenes that remained as text (`scenes`), or nowhere (`none`). `readingMisses` in the result file are the failed questions whose answer was present in memory: memory is right, reading made the error. A failure with `none` means that the sum had to be added up at answer time. This is a diagnostic, not a score: a short number can match by chance.
- There are two judges: `--judge claude:claude-opus-5` (by subscription, no daily limit; the main judge since 18 September) and `--judge openai:gpt-5.4` (225 thousand tokens per day). Cross-check on 40 questions: 36 matched, in the disagreements Opus is right or stricter (entry in the log). Both sides of one comparison are judged by the same judge; numbers from different judges are not compared.
- Scene eval: the judge `gpt-5.4` was checked by hand (entry in the log); `gpt-5.4-mini` as a judge makes errors on careful reading. Word a question to the judge in the affirmative form. To re-judge finished scenes: `npm run eval -- judge --judge <model> --resume <probe directory> --mode plain`. Traps exist for all three scenarios, in the middle of the story (`afterTurn`) and after it; their facts were checked against the text of the frozen scenes.

- All three scenarios are recorded and pass from replay to `score`. No model answers the `fen` question in `chess` correctly, even over the full text: the maximum there is 6/7.

Not verified: behaviour when the limit is exhausted. The first one who verifies this updates this section.

## Acceptance on the GPU

The bot runs on an uncensored Gemma 4 31B Q6K on its own GPU; hosted models are only a test ground. Hosted Gemma is an optimistic substitute: after refusal removal and quantization the model follows the format worse. An edit counts as finally accepted after `npm run memory:probe` on the GPU through the queue of the running bot. The rental costs money, so only what is already selected is checked on the GPU, once every few steps, and only on the owner's word. Adult content is never sent to hosted APIs: the test-ground scenarios stay clean. The owner's one exception, 2026-09-21, is for judging pictures: the hand-written "sharp" prompt set (battlefield, wounds, an execution, an interrogation, a harem, a bath) is drawn on the rented card only, its prompts are written by hand and never pass a hosted text model, and its pictures may be shown to a GPT-6 session for the blind comparison as long as a picture has no explicit nudity. A picture that has it is judged by the owner alone.

## When to stop and write to the owner

- `budget_exceeded`, `unauthorized` or 402/403 from a provider. Do not raise limits yourself, do not open paid channels.
- Three rejected hypotheses in a row: most likely the bottleneck is not in the prompt but in the checks, the scenarios or the memory schema, and that is the owner's decision.
- An edit from the section "What may not change" is needed.
- A check from `memory-checks.ts` looks wrong or ambiguous.

In the report to the owner: what you tried, numbers before and after per model, what was accepted, what was rejected and why, how many requests were spent.
