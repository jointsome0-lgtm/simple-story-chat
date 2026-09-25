# Evaluating changes: `npm run eval`

`npm run eval` compares versions of prompts and memory on several models at once, on synthetic stories. When a change
may be made and how one step is measured is in [improve-loop.md](improve-loop.md); this page holds the commands and
what their numbers mean. The keys of the hosted APIs are in `.env.eval` (template `.env.eval.example`), which an
assistant does not open ([the rule](improve-loop.md#frozen-boundaries)). The probes run in an empty directory, so the
bot's `.env` does not reach them.

<a id='replay-and-scenes'></a>

## Replay and scenes

```
npm run eval -- --models openrouter:google/gemma-4-31b-it:free,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001
```

The replay runs the frozen scenes of `examples/frozen/<scenario>.json` through the memory of each model
(`memory:probe --direct`, modes `plain` and `sgr`) and compares the answers with `examples/memory-checks.ts`. Models
go in parallel, scenarios one after another. `npm run eval -- write --model <model>` recorded those scenes once
through `story:probe`, continuing from the last saved scene on `rate_limited`; the accepted fixtures change only as
[improve-loop.md](improve-loop.md#frozen-boundaries) allows.

With `--judge openai:gpt-5.4`, after the memory questions each model writes one scene for each trap move of
`examples/scene-traps.ts`, and the judge answers fixed yes/no questions (`local/scene-judge.ts`). The result is
`sceneScore` next to `score`. `npm run eval -- judge --judge <model> --resume <probe directory> --mode plain` judges
the finished scenes again.

`score` for each mode is the share of correct answers of the worst model, so a change cannot win because of the most
obedient model. An unfinished mode gives zero answers, and its error code stays in the report. The full report with
the failed keys goes to `eval.json`, whose path is the last line printed. The checks are fixed, without a judge
model, and do not measure the quality of the prose.

`npm run eval -- watch` in another terminal shows the current run: the last event of each model, scenario and mode,
and the day's spending. The events go to `logs/eval.jsonl`, as codes and counters without text.

<a id='diagnostics'></a>

## Diagnostics

A failed sum can be analysed without a model. For a numeric answer of two or more digits the probe writes `stated`: whether the number is present in the memory message (`memory`), in the scenes that remained as text (`scenes`), or nowhere (`none`). `readingMisses` in the result file are the failed questions whose answer was present in memory: memory is right, reading made the error. A failure with `none` means that the sum had to be added up at answer time. This is a diagnostic, not a score: a short number can match by chance.

<a id='walk'></a>

## The walk: `npm run eval -- walk`

The replay measures what a model keeps of a story someone else wrote. The walk measures whether a model keeps its own story straight: from a seed it writes every scene itself, one per step of `examples/walk/<name>.json` (in a pack, `<name>/walk.json`). An empty step is the bot's own continue signal; any other step is the author's intervention, given to the narrator as a player's message. Memory is compacted after scene 7 and every fourth scene after it, as in the replay. Afterwards a panel of judges reads each scene against the seed and everything before it and lists the contradictions it finds, with quotes (`local/walk-judge.ts`). A listed contradiction is an inconsistent verdict whatever the flag says; an inconsistent flag without one is an abstention. Then the council: every contradiction anyone listed goes back to every judge, with the same seed, history and scene, to confirm or refute by the text; the judge that listed it checks it too and may take it back. A finding stands when more judges confirm it than refute it, and a scene with a standing finding is inconsistent; a scene whose findings are all refuted is consistent although a judge had flagged it; a tie on a finding, with nothing confirmed, is `split`; a scene nobody voted on is `unjudged`. `score.walk` is the share of scenes the council found consistent among the scenes it decided (a `split` scene is neither for nor against the model and leaves the denominator; an `unjudged` one still counts against it), for the worst model, and `score.votes` is the same share from the first round's majority alone. An unfinished walk is judged on the scenes it has, and the scenes it lacks count against the model.

```
npm run eval -- walk --models claude:claude-haiku-4-5-20251001,claude:claude-opus-5-5 --judges claude:claude-opus-5-5,claude:claude-fable-5-1,codex:gpt-6-astra --out walk.json
```

Every judge's verdicts with their quotes stay next to the probe's report (`walk-judge-<judge>.json`, the council's checks in `walk-cross-<judge>.json`; the report directory is in the cell), and `npm run eval -- walk-judge --judge <model> --resume <directory>` adds a judge to a finished walk (`--cross` for its second round). Several judges are the point: one judge misreads a quote or has a taste of its own, and a model under test may also sit on the panel, so no scene is judged by one model alone. A walk is not a fixed set of questions: the model writes a different story each run, so compare walks the way [the noise section](improve-loop.md#noise) compares scenes, several runs per side.

<a id='seed-audit'></a>

## Seed audit

A seed is audited before it grows anything: `npm run eval -- seed-audit --judges <models> --scenarios <walk> --out <directory>` asks every judge for the seed's own contradictions and its ambiguities (a time given without saying by which clock, a canister named by its capacity, a nail "right of the door" seen from nowhere), and writes them to `<directory>/<walk>/issues.json` next to one `seed-audit-<judge>.json` per judge. An ambiguity in the seed is a false finding later, on every scene, for or against the model depending on the judge's reading; fix the seed and audit again until the judges have only taste left to list.

<a id='gold-tree'></a>

## The gold tree

A walk compares whole stories, and two walks of one model differ in every scene. The gold tree fixes the prefixes: a tree of scenes grown from the seed that the council accepted, in the bot's own shape (every scene has a parent), kept next to the walk as `examples/walk/<name>.gold.json` (in a pack, `<name>/gold.json`) with a rendering for people beside it (`.gold.md` / `gold.md`), in which every scene nobody has read yet says so. The trunk follows the walk's steps; a branch is any other accepted continuation of a node.

The commands below built version 1, the public tree `examples/walk/lighthouse.gold.json` of 2026-09-23: 63 scenes,
none promoted ([the run](knowledge/improve-runs.md#gold-v1-2026-09-23)). Version 2 is decided and not yet built,
except the path length limit; its rules are in [improve-loop.md](improve-loop.md#gold-v2), and the promotion defaults
here are not its measured thresholds.

| `npm run eval --` | What it does |
| --- | --- |
| `walk-gold --writers <models> --judges <models> --scenarios <walk> [--depth n] [--attempts 1..8] [--out directory]` | Grows the trunk one depth at a time. |
| `gold-audit --judges <models> --scenarios <walk> --out <directory>` | Gives every judge the whole trunk at once, seed and all scenes, for contradictions between scenes that scene-by-scene reading let through and for the ambiguities the scenes themselves introduce. |
| `gold-recheck --judges <models> --scenarios <walk> [--nodes g1,g2]` | Judges every node again, fresh, and reports how many the judges agree to a second time: the gate's own noise, measured. |
| `gold-promote --scenarios <walk> [--rechecks 2] [--exposures 8]` | Makes gold of the candidates that pass. |
| `gold-stats` | Prints the ledger's numbers, per judge as well: who points at earlier scenes late and how often that stands. Writes `pathTokens`. |
| `gold-read --scenarios <walk> --nodes g1,g2` | Records that a person has read those scenes. |
| `walk-nodes --models <models> --judges <models> --scenarios <walk> [--branches k] [--no-grow] [--max-path-tokens n] [--out file]` | The eval over the tree. |

`walk-gold` grows the trunk one depth at a time: every writer (`local/walk-step.ts`) continues the accepted prefix, seen whole, with the walk's next step; the council reads each new scene against the seed and the prefix (`walk-judge.ts --only`), and the gate is not the eval's majority but the agreement of every judge: a scene without findings in the first round, or one whose findings nobody confirms in the second, the judge that listed a finding included, which may take it back. A finding one judge still stands by keeps the scene out, however many refute it, and a judge with no verdict or no checks does not agree. Of the agreed scenes one becomes the trunk, the one with the fewest first-round dissenters and findings, a tie going to the writer with the fewest trunk nodes so far, so that the trunk is not one author's; the other accepted scenes are branches at once. A rejected scene stays in the tree's `rejected` list with the findings that stood against it, and its writer tries again, every second attempt as a repair of its last rejected text with those findings quoted; when no writer passes in `--attempts` rounds the trunk stops there and says so. The tree is saved after every depth, so a stopped run continues where it was. One writer is a gold set of one author's habits; the four strongest available, each judged by all four, is the intended use.

A scene every judge agreed to enters the tree as a **candidate**; it becomes **gold** by its ledger, not by the gate alone. Every node keeps a ledger: how many deeper scenes were judged with the node in their prefix (`seen`), every finding a judge listed against a deeper scene whose earlier quote stands in this node (`later`, with whether the finding stood after the cross round: a refuted one can still mean this node was the one at fault, and a person reads both kinds), every issue the whole-story audit placed in it (`audit`), and every fresh reading by the council (`recheck`). The audit's merged list lands in
`<directory>/<walk>/issues.json` and in the nodes' ledgers, and a recheck records its outcome in each node's ledger.
A judging in which a judge answered nothing (a failed probe, a timeout) is the provider's silence, not a reading: it enters no ledger, a recheck with a silent judge is not held, an attempt refused by silence alone is retried without a repair, and the recheck run stops when every judge is silent.

`gold-promote` makes gold of every candidate with that many agreed rechecks, that many deeper scenes judged over it with no later finding that stood, and nothing from the audit; the thresholds are the flags, and a promoted node stays gold. `gold-read` records that a person has read those scenes; that is kept apart from the rule and shown next to it, because the council is made of models and the writers sit on it.

`gold-stats` also writes `pathTokens` into every node when the `tiktoken` package is installed (`npm install`; a dependency of the eval only, `npm test` runs without it): the tokens of the seed, the steps and the scenes from the root to the node by one public ruler, OpenAI's `o200k_base`, the same counts as the Python package, so that a dataset can state what a model was asked to read; `walk-nodes --max-path-tokens n` keeps only the tasks whose prefix fits, one limit per run named in the report with the tasks it admitted, so that weaker models are measured on the same nodes and the frontier on the whole tree; the tree itself is never capped.

`walk-nodes` is the eval over the tree: every model continues from the seed and from every trunk node with the trunk's next step, and from up to `k` branch nodes drawn at random (named in the report), each time through its own memory compaction of the prefix on the walk's schedule, as the bot would (`walk-step.ts --compact`); a deeper task of the same path reuses the library a shallower one left, the compaction being the same request either way. The council reads each new scene against the gold prefix; `score.nodes` is the share of consistent scenes among the decided ones, for the worst model, and `byDepth` in the report is the verdict at every depth of the trunk, so a model that holds the first seven scenes and loses the ninth is seen losing the ninth. A scene every judge agrees to joins the tree as a branch, whoever wrote it, unless `--no-grow`; so the tree grows with every run, and the next run has more prefixes to draw from. Every model gets the same tasks in one run; between runs the tree has changed, so compare models within a run.

<a id='daily-limits'></a>

## Daily limits of hosted APIs

Every `openai-compatible` request goes through `local/budget.ts`. The counter is in `eval-usage.sqlite` in the project root and is shared by parallel probes; it holds the day in UTC, the channel name, the number of requests and tokens, without text. `npm run eval -- usage` shows today's spending and the limits in effect.

| Channel | What goes into it | Default limit |
| --- | --- | --- |
| `openrouter-free` | OpenRouter models with `:free` | 900 requests |
| `openrouter-paid` | the other OpenRouter models | closed |
| `openai-small` | mini and nano from the free OpenAI quota | 2 250 000 tokens |
| `openai-large` | large models from the same quota | 225 000 tokens |
| `cerebras` | all Cerebras models | 900 000 tokens |
| `groq` | all Groq models | 900 requests and 180 000 tokens |
| `mistral` | all Mistral models | 500 000 tokens |
| `openai-paid`, `other` | everything else | closed |

The default values are one tenth below the free quotas. A paid channel is closed until a limit is set by hand in `.env.eval` (`OPENROUTER_PAID_DAILY_TOKENS` and similar) or through `SIMPLE_CHAT_BUDGET_REQUESTS` and `SIMPLE_CHAT_BUDGET_TOKENS` when a probe is started directly. Before sending, the input estimate plus the whole response limit is reserved; after the response, the reserve is replaced with the provider's `usage`. A request that failed keeps its reserve: it is unknown whether the provider counted it. Exceeding the limit gives `budget_exceeded` before sending.

This is a local counter: it does not see spending from other computers or from other programs. The hard boundary is set by the provider itself: an OpenRouter key has a credit limit, an OpenAI project has a monthly budget.
