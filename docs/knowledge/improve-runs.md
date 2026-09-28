# Improvement runs

The full entries of the improvement loop from 2026-09-18 to 2026-09-23: date, hypothesis, change, numbers before and
after per model, decision and its limits. Rejected hypotheses are recorded too. The entries were moved here from
[improve-log.md](../improve-log.md) on 2026-09-25 as they were, apart from relative links and an anchor before each
entry.

The rules of the loop are in [improve-loop.md](../improve-loop.md), and [improve-log.md](../improve-log.md) keeps one
line per decision. A new step gets its full entry here, on top, and its line there.

Paths to result directories say where the numbers came from at the time. They do not promise that the files still
exist or that you may read them.

<a id='scene-thinking-2026-09-28'></a>

## 2026-09-28 · Opus 5.5 · O3, phase 1: trap scenes that think, on hosted Gemma 4 31B (measurement)

Not a step of the loop: phase 1 of O3 of the memory proposal of 2026-09-28
(`~/simple-story-chat-runs/2026-09-28/memory-next/proposal.md`, outside the repository), which the owner approved the
same day, a measurement that accepts no change. [Thinking at the read end](#read-thinking-2026-09-28) had taken the
recall from 3.7 and 8.3 to 11.3 and 12 of 12, and the bot's scenes never think. The question: does thinking before a
scene cut the scene's continuity and number errors, and what does it cost a scene in reasoning tokens and seconds?
Phase 1 asks it of hosted Gemma 4 31B over the pack's traps on both scenarios. Phase 2, a job for the next text card
that asks it of the tester's model, is prepared and not run (below).

The switch, in eval code only ([eval.md](../eval.md#scene-thinking), 45400b2). `SCENE_THINKING=true` gives every trap
scene, and the `then` scene over it, `thinking`, which OpenRouter gets as `reasoning: { enabled: true }`, and 4096 more
output tokens, 8192 in all. With `RECALL_FROM` and `--judge` the probe writes every trap scene again over a finished
replay, each where the replay wrote it, with the memory of the last compaction up to there, and then asks the recall
and the boundary checks, so both arms write from the same states. A dry run against a fake llama.cpp server over a
synthetic pack, repeated just before the screen: with the switch unset, 25 of 25 bodies were equal to 87faddd's byte
for byte; written again over that replay with the switch off, 22 of 22 bodies equalled the replay's own, the other
three being its compactions; with the switch on, the same 22 differed only in `max_tokens` (4096 to 8192) and the
thinking fields; after the rewrite the final state equalled the replay's. No test was added.

The states are step 1's compacted replays `gemma-mem-1` (`~/simple-story-chat-runs/2026-09-28/memory-ceiling/tmp/`,
71a159f, 08:00 UTC), one state a scenario for both arms. The pack has 26 traps a scenario (fc1eb5f): 12 questions of
the older set, 11 of o2 and 12 of open on `hospital`, and 12, 15 and 14 on `assault`. An open trap asks `confirmed` of
its scene and `kept` of the `then` scene over it.

Commands. As in [step 3](#read-thinking-2026-09-28), the eval ran from the main tree at dd18b59, with its `.env.eval`
and ledger, and a Node resolve hook, `$R/redirect.mjs`, swapped `local/memory-probe.ts` for this branch's, at 45400b2.
The hook also gave the probe 120 minutes in place of the 30 the main tree's eval passes (the branch's eval takes
`--minutes`), and gave the thinking arms a request timeout of 900 s in place of 300 s, since endpoints at 7 to 10 tokens
a second turned up in the first scenes and a long thought there could pass 300 s. No scene came near it; the longest
took 185 s. The hook also kept `NODE_OPTIONS` from the Claude CLI that the judge starts. `$R/run.sh <scenario> off|on`
holds the command, one `TMPDIR` a run, with `R=~/simple-story-chat-runs/2026-09-28/scene-thinking` and
`S=~/simple-story-chat-runs/2026-09-28/memory-ceiling/tmp/gemma-mem-1`:

```
NODE_OPTIONS=--import=$R/redirect.mjs PROBE_MINUTES=120 [PROBE_TIMEOUT_MS=900000] SCENE_THINKING=false|true RECALL_FROM=$S/simple-chat-memory-<scenario>-… TMPDIR=$R/tmp/<scenario>-<arm> npm run eval -- --pack ~/simple-story-chat-eval --scenarios <scenario> --mode plain --models openrouter:google/gemma-4-31b-it --judge claude:claude-opus-5-5 --out $R/<scenario>-<arm>.json
```

Both arms without thinking started together at 10:42 UTC. Each scenario's thinking arm started when its arm without
thinking had finished, at 10:50 and 10:55. Every run finished at its first attempt, with no `budget_exceeded`, 402 or
403. Two things happened on the way:
- The judge of `assault` off failed at the Claude CLI after 7 of the arm's 33 scenes (`provider_failed`, `cliError`,
  stop reason `stop_sequence`, as Haiku's cells had in [L1](#l1-2026-09-27)), which left the scenes unjudged. `npm run
  eval -- judge --judge claude:claude-opus-5-5 --resume <its probe directory> --mode plain --pack
  ~/simple-story-chat-eval --scenarios assault` judged them from 10:55 to 10:58. The `sceneScore` of 0 in
  `$R/assault-off.json` means the scenes had no verdicts.
- The machine slept from 11:14 to 12:18 UTC with a thinking scene of each arm in flight. The connections failed five
  minutes after it woke, the probe asked both scenes again after 30 s, as it does after a dropped connection, and the
  arms went on. One more request of `hospital` on had dropped the same way at 11:03. A scene's `ms` is the time of the
  attempt that answered.

Numbers, one run an arm, judged by Opus 5.5:

| Scenario, arm | Older traps | o2 | open `confirmed` | open `kept` | P | Recall /12 | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hospital`, off | 10/12 | 9/11 | 2/6 | 6/6 | 2/6 | 4 | 5/11 |
| `hospital`, on | 10/12 | 9/11 | 3/6 | 6/6 | 3/6 | 3 | 5/11 |
| `assault`, off | 11/12 | 12/15 | 2/7 | 6/7 | 2/7 | 8 | 8/10 |
| `assault`, on | 9/12 | 14/15 | 2/7 | 6/7 | 2/7 | 8 | 8/10 |

- The questions that flipped. `hospital`: with thinking `open_attic_confirmed_h` passed, and none passed only
  without it. `assault`: with thinking `o2_backstory_told`, `o2_fetch_accepted` and `open_shawl_kept` passed; without it
  `two_tunnel_barriers` and `one_tunnel_barrier` (the two questions of `mid_tunnel_stock`, a count of barriers after
  scene 10) and `open_water_kept`.
- Failed in both arms, seven questions on each scenario: on `hospital` `key_fetched`, `order_explained`, both time
  traps of o2 (`o2_opening_before_completed_bell`, `o2_opening_before_census_talk_h`) and three open claims left
  unconfirmed; on `assault` `prior_discussion_accepted`, `o2_fetch_corrected` and five open claims left unconfirmed.
- Both arms asked the recall and the boundary checks without thinking over the same final state, so those requests
  were the same. `hospital`'s recall still answered 4 in one and 3 in the other (`bridge_limit`): the spread of one
  reader on one request.

Reasoning and time, a scene of the 32 on `hospital` and the 33 on `assault` (trap scenes and `then` scenes), in the
probe's seconds over OpenRouter, median and most:

| | `hospital` off | `hospital` on | `assault` off | `assault` on |
| --- | --- | --- | --- | --- |
| Seconds a scene | 8.0 · 35.2 | 38.7 · 184.8 | 12.5 · 64.9 | 38.1 · 171.6 |
| Output tokens a scene, reasoning included | 353 · 584 | 1095 · 2473 | 402 · 567 | 1007 · 3224 |
| Reasoning tokens a scene | 0 | 621 · 1702 | 0 | 498 · 2678 |
| Visible text in tokens (output less reasoning) | 353 · 584 | 422 · 882 | 402 · 567 | 472 · 926 |
| Output tokens a second, median (range) | 41.7 (15–63) | 28.7 (10–85) | 32.8 (7–76) | 28.3 (16–52) |
| All the arm's scenes, seconds | 296 | 1536 | 664 | 1454 |

With thinking, 11 scenes of `hospital` and 6 of `assault` reasoned more than 1000 tokens, 2 of `assault` more than
2000, and none was cut at 8192. A thinking scene reasoned 855 tokens on average on `hospital` and 754 on `assault`,
and its visible text grew by about 70 tokens at the median.

The hosted speed and the card. Hosted Gemma gave about 34 tokens a second: 33 to 42 for the median scene without
thinking, 28 with it, and 7 to 85 depending on the endpoint OpenRouter picked. So the 26 to 31 s a thinking scene added
here at the median is mostly its 600 to 740 more output tokens at that speed. What carries over to the card is the
count, if the heretic reasons as long as Gemma. At the 147 to 157 tokens a second the heretic decoded in the
compactions of the night of 09-27/28, the median thought would add 4 to 5 s a scene on an idle card and the longest
here about 18 s. The hosted numbers do not say whether the heretic reasons as long, how long an internal request waits
behind the tester's reader turns, or how long a reader waits for the first word, which in a thinking scene comes only
after the whole thought.

The cost, as this screen's own requests by the provider's usage: 138 answered requests and 1,182,202 tokens of the
1,500,000 allowed, the recall and the boundary checks included: `hospital` 303,644 off and 333,789 on, `assault`
258,573 and 286,196. The three requests cut by a dropped connection got no usage; their reservations, about 16,000
tokens each, stay in the ledger unsettled. At $0.08 to $0.14 a million tokens in and $0.30 to $0.40 out that is about
$0.12 to $0.19. The ledger's `openrouter-paid` day stood at 239 requests and 1,345,358 tokens at 10:42:51 UTC and at
449 and 2,740,178 at 12:35:43, other agents' requests included. The judge ran through the Claude CLI and spent no
channel tokens.

Conclusion: no gain. Over the same states, thinking before a scene moved 7 of 76 questions and gained one net: 58 to 59,
the older traps 21 to 19 of 24, o2 21 to 23 of 26, open 16 to 17 of 26, P 4 to 5 of 13. The one count trap that flipped
(`mid_tunnel_stock`) went wrong with thinking. The errors both arms made stayed: both of o2's time traps on `hospital`,
the open claims left unconfirmed (3 of 6 and 5 of 7) and four continuity questions. No set moved by more than two
questions. Gemma's older traps on `hospital` scored 10, 9 and 9 in the three baseline replays of [L1](#l1-2026-09-27),
and here the same recall request, asked twice, moved by one. The price, at the median: 2.5 to 3 times the output tokens
a scene and 3 to 5 times its seconds hosted, while an arm's tokens grew by about 10 %, since the input dominates. The
bot's scenes do not think, as before, and `SCENE_THINKING` stays an eval switch, off by default.

Phase 2, prepared only. `~/simple-story-chat-runs/2026-09-28/scene-thinking/card/job.mts` writes the same traps on the
tester's model through simple-serving, off and then on, every request of class `internal`, with `--minutes` as its
deadline. `notes.txt` beside it holds the question, the gain, the minutes (about 20 on an idle card and about 55 with
the tester at it at phase 1's reasoning, `--minutes 75` as the bound) and its dry run against simple-serving's own
gateway with a fake engine. In that dry run the gateway took no thinking budget: a `thinking_budget` in
`chat_template_kwargs`, `reasoning`, `reasoning_effort` and `thinking_token_budget` were each answered with 400
`unsupported_field`, and `max_tokens`, the one bound, counts the thought and the text together. After this screen the
job would bring the price on the card, and a gain only if the heretic answers otherwise than Gemma; it goes through the
card plan and GPT-6 Astra's review, not straight to a rental. That review, on 2026-09-28, dropped it from [the next
rental](../action-experiment.md#tester-rental): one answer of 76 gained hosted for much more generation, and the owner
had not been asked.

Limitations:
- One run an arm, one state a scenario, one judge (Opus 5.5), judging once. Seven flips in 76 questions is about the
  size of the noise, not a measure of it.
- Hosted Gemma 4 31B stands in for the heretic on the card ([acceptance](../improve-loop.md#acceptance-on-gpu)).
- OpenRouter picks an endpoint for each request, and the log does not say which. The seconds mix endpoints at 7 to 85
  tokens a second, and a thinking request may go to other endpoints than one without thinking.
- The traps test continuity at fixed points. The walk, longer stories and `sgr` memory were not run.
- Results: `$R/<scenario>-<arm>` as `.json`, `.log` and `.meta` (`assault-off-judge.*` for the second judging); the
  probes' directories under `$R/tmp/`; `$R/tables.mts` and `$R/extra.cjs`, which print these numbers from the probes'
  reports, with their output in `$R/tables.txt`; and `$R/usage.txt`, the ledger at each stage.

<a id='ceiling-boundary-2026-09-28'></a>

## 2026-09-28 · Opus 5.5 · memory steps 1 and 2: the reading ceiling, and checks at the memory's boundary (measurement)

Not steps of the loop: steps 1 and 2 of the memory proposal of 2026-09-28
(`~/simple-story-chat-runs/2026-09-28/memory-next/proposal.md`, outside the repository), measurements that change no
prompt. Step 1 asks whether the memory questions measure the memory or its reader. Step 2 adds checks that ask the
memory alone: `boundary` in the eval (87faddd), and in the pack since 75d69a1. [Step 3](#read-thinking-2026-09-28), the
same reader thinking over step 1's memories, ran between the two and has its own entry.

Step 1, the reading ceiling. Hosted Gemma 4 31B's memory `score` on the pack's `hospital` and `assault` had not moved
under [L3](#l3-2026-09-27) or [thinking while compacting](#memory-thinking-2026-09-27). The replay compacts after scenes
7, 11 and 15 and keeps 4 scenes, so its 12 questions a scenario are asked over a memory of scenes 1 to 11 and over
scenes 12 to 16 as text. `eval ceiling` asks the same questions over all 16 frozen scenes as text, with no memory. If a
reader with every scene in front of it loses the same keys, the score measures the reader.

The runs: three of each side for Gemma (`openrouter:google/gemma-4-31b-it`, thinking off) and `gpt-5.4-mini`, both
scenarios in each run, mode `plain`, no judge, `MEMORY_THINKING` unset, at 71a159f from the main tree between 08:00 and
08:05 UTC. `$R/run.sh` holds the commands, one `TMPDIR` a run, with
`R=~/simple-story-chat-runs/2026-09-28/memory-ceiling`, `<tag>` `gemma` or `mini` and N = 1, 2, 3:

```
TMPDIR=$R/tmp/<tag>-ceil-N npm run eval -- ceiling --model <model> --scenarios hospital,assault --pack ~/simple-story-chat-eval
TMPDIR=$R/tmp/<tag>-mem-N npm run eval -- --pack ~/simple-story-chat-eval --scenarios hospital,assault --mode plain --models <model> --out $R/<tag>-mem-N.json
```

Ceiling run 1 of each model ran first as the smoke, the other ten runs at once (`$R/batch.sh`). Every run finished at
its first attempt, with no compaction retry or `budget_exceeded`.

Correct answers of 12:

| Model, side | `hospital`, runs 1 · 2 · 3 | Mean | `assault`, runs 1 · 2 · 3 | Mean |
| --- | --- | --- | --- | --- |
| Gemma, compacted replay | 4 · 4 · 4 | 4.0 | 8 · 8 · 8 | 8.0 |
| Gemma, ceiling | 4 · 3 · 3 | 3.3 | 8 · 8 · 8 | 8.0 |
| `gpt-5.4-mini`, compacted replay | 0 · 1 · 1 | 0.7 | 8 · 9 · 9 | 8.7 |
| `gpt-5.4-mini`, ceiling | 1 · 1 · 2 | 1.3 | 8 · 9 · 8 | 8.3 |

A key counts as lost when it failed in two or three runs of three.

- Gemma's replays lost 12 keys: `river_left`, `garden_cells`, `river_stretchers`, `boat_spare`, `next_departure`,
  `origin_evacuated`, `polina_learned` and `boris_learned` of `hospital`, and `river_barriers`, `road_barriers`,
  `tunnel_barriers` and `river_stock` of `assault`. The ceiling lost all twelve. It lost `bridge_limit` too, which
  changes last in scene 15 and so stands as text on both sides: the replays answered it right in two runs, the ceiling
  in none.
- mini's replays lost 14: all of `hospital`'s but `uninformed`, and `road_barriers`, `tunnel_barriers` and `river_stock`
  of `assault`. The ceiling lost 12 of them, kept `river_stretchers` and `road_barriers` in two runs of three, and lost
  `river_barriers`, which every replay kept.
- The three time keys of `hospital` failed on both sides in all 12 runs: `polina_learned` 4 or 6 minutes early in 10 of
  them, `boris_learned` 7 minutes late in 8, `next_departure` `unknown` in 8.

So on these two scenarios the end-of-story questions measure the reader: a reader with every scene in front of it
scored no better and lost the same keys, and what compaction drops cannot be told from their `score`. Step 3 then had
the same reader, thinking, answer nearly all of them from Gemma's memories.

The cost of step 1, by the providers' usage: Gemma 30 requests and 238,820 tokens on `openrouter-paid`, mini 30 and
253,332 on `openai-small`. A ceiling request took about 14.4k tokens on `hospital` and 12.1k on `assault`, a replay's
four requests 29k to 31k and 23k to 28k. The ledger's day went from 145,389 to 395,037 tokens on `openrouter-paid` (of
4,000,000) and from 168,051 to 421,383 on `openai-small` (of 2,250,000); `openrouter-paid` grew by one request and
10,828 tokens more than the probes settled, which was not traced.

Step 2, checks at the memory's boundary. What does the compacted memory itself keep? A boundary check is a memory
question asked as of the end of scene 11, the last scene the final memory covers, in a request of its own at that
scene: the seed, the memory and the questions, without scenes as text and with scene 11's time as the reference, so a
miss is the compactions' and not a reading of the later scenes. In `full` the same request carries scenes 1 to 11 as
text, the ceiling of these checks ([eval.md](../eval.md), 87faddd).

The checks, with `B=~/simple-story-chat-runs/2026-09-28/memory-boundary`:

- An audit of step 1's twelve replays (`$B/audit.cjs`) found every final memory covering exactly scenes 1 to 11. For
  most keys all six memories of a scenario hold the parts the answer at scene 11 is made of. The exceptions:
  `boat_spare`'s rule stands as a fact only in mini's run 3, `key_holder` is explicit in Gemma's three memories and
  mini's run 2, `polina_learned`'s reading keeps its clock time in three of the six, and `river_stock`'s running totals
  are wrong in Gemma's runs 1 and 3 and mini's run 2.
- The drafts ask the end-of-story questions with their "now" at the end of scene 11: 11 of `hospital`'s, where
  `door_clock` takes the place of `boris_learned` and `uninformed` is left out, and 10 of `assault`'s, without
  `farid_learns` and `uninformed`. The answers were drafted from scenes 1 to 11 (`$B/draft-checks.json`, sha256
  491f5250…).
- GPT-6 Astra checked them blind (`$B/verify.cjs`, `codex exec` at `high`, read-only, no web search). One session a
  scenario read scenes 1 to 11 and the questions, not the drafts, and answered each, saying whether it is answerable and
  unambiguous; a second session would have judged only a disagreement. Astra agreed on all 21 and flagged none, so no
  judge ran: 2 of the 4 sessions allowed, 38,101 input and 1,452 output tokens (`hospital` 19,862 and 905, `assault`
  18,239 and 547). `$B/verified-checks.json` is the draft byte for byte. The main session put the checks into the pack
  with the owner's permission (`assault/scenario.json` 2fb45661…, `hospital` 32567421…), and eval.md says so since
  75d69a1.

The runs. `eval boundary` asked the checks over copies of step 1's twelve replays, from the state each saved, in
`plain` (the memory alone) and in `full` (scenes 1 to 11 as text), one request a scenario and run, no judge. Run N
reads the memory of step 1's run N. Without thinking both models ran at b7ea72c, from about 09:02 to 09:07 UTC, over
the draft; with thinking Gemma alone ran at 87faddd, this change rebased onto the main branch's `RECALL_THINKING`, from
about 09:39 to 09:45, over the verified copy. `$B/dry-run.sh` holds the command, with the copies under `$B/dry-run/`
and `$B/thinking/`:

```
[RECALL_THINKING=true] npm run eval -- boundary --model <model> --resume <copy of a probe directory> --mode plain|full --pack ~/simple-story-chat-eval --scenarios <scenario> --boundary $B/verified-checks.json
```

`RECALL_THINKING` gives a request to OpenRouter or llama.cpp its reasoning parameter and one to OpenAI none, so
`gpt-5.4-mini` has no thinking side, and none was run.

Correct answers of 11 on `hospital` and of 10 on `assault`:

| Reader, text | `hospital`, runs 1 · 2 · 3 | Mean | `assault`, runs 1 · 2 · 3 | Mean |
| --- | --- | --- | --- | --- |
| Gemma, the memory alone, thinking off | 5 · 5 · 6 | 5.3 | 8 · 10 · 9 | 9.0 |
| Gemma, the memory alone, thinking on | 11 · 11 · 10 | 10.7 | 9 · 10 · 10 | 9.7 |
| Gemma, scenes 1 to 11, off | 6 · 7 · 6 | 6.3 | 8 · 8 · 8 | 8.0 |
| Gemma, scenes 1 to 11, on | 9 · 10 · 9 | 9.3 | 10 · 10 · 10 | 10.0 |
| `gpt-5.4-mini`, the memory alone, off | 4 · 4 · 1 | 3.0 | 7 · 7 · 9 | 7.7 |
| `gpt-5.4-mini`, scenes 1 to 11, off | 1 · 3 · 0 | 1.3 | 7 · 10 · 7 | 8.0 |

- Thinking over the memory alone, Gemma answered 61 of 63. Both misses are the memory's own: `polina_learned` in run 3
  of `hospital`, 4 minutes early, where that memory kept the reading without its clock time, and `river_stock` in run 1
  of `assault`, where that memory's running totals are wrong. Run 3's totals are wrong too, and there the thinking
  reader answered right.
- Without thinking Gemma missed 20 answers over the same memories, and 18 of them were right with thinking: those were
  the reader's. In `hospital` it missed `river_left`, `garden_cells`, `river_stretchers`, `boat_spare` and
  `polina_learned` in every run and `door_clock` in two. For `river_left`, `garden_cells` and `boat_spare` the expected
  number stands in each memory (`readingMisses`), and `river_left` and `garden_cells` got the same wrong number in all
  three runs.
- mini missed 24 answers of 33 on `hospital` and 7 of 30 on `assault`, among them `key_holder` with the same wrong name
  in all three runs, though its run 2 memory names the holder explicitly. Without a thinking side its reader's misses
  cannot be told from its memory's.
- Scenes 1 to 11 as text scored about as the memory did: 6.3 and 8.0 against 5.3 and 9.0 without thinking, 9.3 and
  10.0 against 10.7 and 9.7 with. With thinking the ceiling missed `garden_cells` by one in runs 1 and 2,
  `polina_learned` 11 minutes early in runs 1 and 3 and `door_clock` 11 minutes late in run 3, the same 11 minutes as
  step 3's ceiling. mini's run 3 of `hospital` over the scenes answered `unknown` to 10 of the 11.

Reasoning tokens a request with thinking: over the memory alone 1207 · 1330 · 1432 on `hospital` and 1362 · 494 · 643
on `assault`, over scenes 1 to 11 1195 · 1127 · 1511 and 471 · 527 · 479, against 2718 to 3221 for step 3's
end-of-story `hospital` recall.

The cost of step 2, by the providers' usage. `openrouter-paid`: 24 requests of Gemma and 191,680 tokens, 28,890 over
the memory alone and 58,012 over scenes 1 to 11 without thinking, 38,497 and 66,281 with. The ledger's day went from
800,032 to 886,934 over the runs without thinking and from 1,027,336 to 1,132,114 over the thinking ones.
`openai-small`: 12 requests of mini and 91,776 tokens, 33,912 and 57,864; the ledger's day went from 421,383 to
513,159. A request took about 4.8k tokens over the memory alone (Gemma; 6.4k thinking, mini 5.7k) and 9.7k over scenes
1 to 11 (Gemma thinking 11k), within the 150,000 a channel allowed for the runs without thinking and the 300,000 after
them. Astra's two sessions, above, are not on the ledger.

Conclusion: asked from the memory alone and read by a thinking reader, Gemma's compacted memories of these two
scenarios keep what the checks ask as of scene 11, all but two answers of 63, and both misses are in the memory text.
Without thinking the checks measure the reader again, as the end-of-story questions do, so Gemma reads them with
`RECALL_THINKING=true` ([eval.md](../eval.md)). Gemma's compaction as it stands loses little of what these 21 checks
ask; they are there to catch a change that loses more. mini's boundary numbers still mix its reader and its memory.

Limitations:
- Hosted Gemma 4 31B and `gpt-5.4-mini` stand in for the heretic Q6_K on the card
  ([acceptance](../improve-loop.md#acceptance-on-gpu)).
- Two scenarios of one pack and three memories a model, all from step 1's replays at 71a159f with `MEMORY_THINKING`
  off. `sgr`, the other scenarios, the holdout and memories made with thinking were not run.
- One boundary, the end of scene 11, and the final memory only: what the memories after scenes 7 and 11 held was not
  asked. 21 checks, several of them keys that nearly always pass.
- The expected answers are one drafter's, confirmed by one blind reader that found none ambiguous. The audit of what
  each memory holds is this session's reading, not checked by another model.
- OpenRouter picks an endpoint for each request, and the log does not say which.
- Results. Step 1 in `$R`: `<tag>-ceil-N` and `<tag>-mem-N` as `.log`, `.err` and `.meta`, the replays' `.json`, the
  probes' directories under `$R/tmp/`, `$R/tables.cjs`, which prints step 1's tables, and `$R/usage-*.txt`, the
  ledger's day. Step 2 in `$B`: `audit.cjs`, `scenes.cjs`, `verify.cjs` and `astra/` (the blind answers and verdicts),
  both checks files with their `.sha256`, `dry-run.sh`, the copies under `dry-run/` and `thinking/` with the boundary
  answers in each probe's `report.json`, `logs/`, `tables.cjs` (`node $B/tables.cjs plain|full dry-run|thinking`) and
  `usage-*.txt`.

<a id='read-thinking-2026-09-28'></a>

## 2026-09-28 · Opus 5.5 · thinking at the read end, over the same memories, on hosted Gemma 4 31B (measurement)

Not a step of the loop: step 3 of the memory proposal of 2026-09-28
(`~/simple-story-chat-runs/2026-09-28/memory-next/proposal.md`, outside the repository), a measurement that accepts no
change. The owner had asked that day whether the bot thinks at all, even a little. It does not: scenes and frames are
written with thinking off, and `MEMORY_THINKING` is off. The proposal read the losses on `hospital` and `assault` as
the reader's: most lost keys change last in scenes 12 to 16, which the replay never compacts, the memories hold the
parts, and a reader that does not think adds them up wrong. [Thinking while compacting](#memory-thinking-2026-09-27)
had moved nothing. The question: does the same reader, thinking, answer what it missed, over the very memories it
missed it from? The proposal predicted +3 questions on `hospital` and +2 on `assault`, as the cheap first answer,
without a card.

The switches, in eval code only ([eval.md](../eval.md#reader)). `RECALL_THINKING=true` gives the recall's request
`thinking`, which OpenRouter gets as `reasoning: { enabled: true }`, and 8192 more output tokens, 16384 in all.
`RECALL_FROM` names finished replays: each probe takes its scenario's, starts from the final state that replay saved,
the memories and the 16 scenes, and asks only the recall again, in a directory of its own. Nothing is compacted. The
usage keeps OpenRouter's count of reasoning tokens as `reasoningTokens`. With neither switch set every request is what
it was: the bodies of a plain request, a recall with its schema and a thinking compaction through OpenRouter, OpenAI,
Mistral and llama.cpp were compared with 71a159f's, 12 of 12 equal, and no test was added or changed. A dry run against
a fake server sent the same messages with thinking off, on and in the control below, and the rereads without thinking
had step 1's input to the token: 9100, 8894 and 8942 on `hospital`, 7267, 7194 and 7080 on `assault` (with thinking,
two fewer each, as OpenRouter counts them).

The memories are step 1's, the reading ceiling of the same morning, under
`~/simple-story-chat-runs/2026-09-28/memory-ceiling/`: its three compacted replays of Gemma, `gemma-mem-1` to `-3`, and
its three ceilings without thinking, `gemma-ceil-1` to `-3`, all run at 71a159f between 08:00 and 08:05 UTC. Run N of
every reread here reads the memories of step 1's run N.

Commands. The eval ran from the main tree at 71a159f, with the `.env.eval` and the ledger it has and this branch's
worktree has not, and a Node resolve hook, `$R/redirect.mjs`, swapped only `local/memory-probe.ts` for this branch's,
whose own imports then resolve in the branch. `$R/run.sh` holds the commands, one `TMPDIR` a run, with
`R=~/simple-story-chat-runs/2026-09-28/read-thinking`, `S=~/simple-story-chat-runs/2026-09-28/memory-ceiling/tmp` and
N = 1, 2, 3:

```
export NODE_OPTIONS=--import=$R/redirect.mjs
RECALL_THINKING=false|true RECALL_FROM=$S/gemma-mem-N/simple-chat-memory-hospital-…,$S/gemma-mem-N/simple-chat-memory-assault-… TMPDIR=$R/tmp/reread-<side>-N npm run eval -- --pack ~/simple-story-chat-eval --scenarios hospital,assault --mode plain --models openrouter:google/gemma-4-31b-it --out $R/reread-<side>-N.json
RECALL_THINKING=true TMPDIR=$R/tmp/ceil-on-N npm run eval -- ceiling --model openrouter:google/gemma-4-31b-it --scenarios hospital,assault --pack ~/simple-story-chat-eval
```

Run 1 of each side ran at 08:40 UTC as the smoke, runs 2 and 3 of both sides at once at 08:46, and the three ceilings
at once at 08:48, all with the probe of 9d79868, whose request under `RECALL_THINKING=true` is abcb86f's. Every run
finished at its first attempt, with no failure, retry or `budget_exceeded`.

The cap. The proposal wanted a side that thinks at most about 512 tokens, if the channel can limit it. Under
`RECALL_THINKING=512`, 9d79868 sent OpenRouter `reasoning: { max_tokens: 512 }`; one run over run 1's memories, at
08:43, reasoned 3122 tokens on `hospital` and 667 on `assault`, as much as without a limit, and answered 12 and 12.
OpenRouter did not apply the limit to this model, so there is no limited side, and abcb86f took the number out of the
switch. `reasoning.effort` was not tried.

The control. The larger limit is part of the thinking request, and at 16384 OpenRouter can no longer send it to the
endpoints that stop at 8192 output tokens, so the two sides could have run on different endpoints. A knob added for the
control and removed after it (337788f, b03c156) asked the recall without thinking at 16384: three runs at 08:58 UTC
over the same memories.

Memory, mode `plain`, no judge, correct answers of 12:

| Side | `hospital`, runs 1 · 2 · 3 | Mean | `assault`, runs 1 · 2 · 3 | Mean |
| --- | --- | --- | --- | --- |
| Step 1, compacted replay, thinking off | 4 · 4 · 4 | 4.0 | 8 · 8 · 8 | 8.0 |
| Reread of those memories, off | 4 · 3 · 4 | 3.7 | 8 · 9 · 8 | 8.3 |
| Reread, off at 16384 (the control) | 4 · 4 · 3 | 3.7 | 8 · 9 · 8 | 8.3 |
| Reread, on | 12 · 12 · 10 | 11.3 | 12 · 12 · 12 | 12.0 |
| Reread, on with the cap not applied, run 1's memories | 12 | | 12 | |
| Step 1, ceiling (the whole story), off | 4 · 3 · 3 | 3.3 | 8 · 8 · 8 | 8.0 |
| Ceiling, on | 8 · 7 · 8 | 7.7 | 11 · 12 · 12 | 11.7 |

Per key, the runs of 3 that answered it right:

| Key | Step 1, compacted, off | Reread, off | Control | Reread, on | Step 1, ceiling, off | Ceiling, on |
| --- | --- | --- | --- | --- | --- | --- |
| `hospital` `river_left` | 0 | 0 | 0 | 3 | 0 | 2 |
| `garden_cells` | 0 | 0 | 0 | 3 | 0 | 2 |
| `river_stretchers` | 1 | 1 | 0 | 3 | 1 | 1 |
| `boat_spare` | 0 | 0 | 0 | 3 | 0 | 3 |
| `bridge_limit` | 2 | 1 | 2 | 3 | 0 | 3 |
| `next_departure` | 0 | 0 | 0 | 3 | 0 | 0 |
| `origin_evacuated` | 0 | 0 | 0 | 2 | 0 | 3 |
| `polina_learned` | 0 | 0 | 0 | 2 | 0 | 0 |
| `boris_learned` | 0 | 0 | 0 | 3 | 0 | 0 |
| `assault` `river_barriers` | 0 | 0 | 0 | 3 | 0 | 3 |
| `road_barriers` | 0 | 0 | 0 | 3 | 0 | 2 |
| `tunnel_barriers` | 0 | 0 | 0 | 3 | 0 | 3 |
| `river_stock` | 0 | 1 | 1 | 3 | 0 | 3 |

The other keys, `current_route`, `key_holder` and `uninformed` of `hospital` and the other eight of `assault`, were
right in every run of every side.

- Without thinking the same input gave different wrong sums from run to run: `garden_cells` 3, 7 and 5 too many in
  step 1 and 4, 4 and 7 reread, `boat_spare` 3, 4 and 5 too few in step 1 and 4, 1 and 5 reread. The time keys missed
  the same way each time: `next_departure` `unknown` in all six runs, `polina_learned` 4 minutes early in all six,
  `boris_learned` 7 minutes late in five and `unknown` once.
- With thinking over the memories every answer was right but two, both in run 3 of `hospital`: `origin_evacuated` one
  short, and `polina_learned` 4 minutes early, the answer the reader without thinking gave.
- `boat_spare` and `road_barriers` stand nowhere in the memory or in the scenes kept as text (`stated: none` for all
  three memories), so they can only be added up while reading; with thinking both were right in every run.
- The ceiling with thinking had `hospital`'s three time keys 11 minutes off in every run, `next_departure` and
  `polina_learned` early and `boris_learned` late, all three of which the reader got right from the memories; it missed
  `river_left`, `garden_cells` and `river_stretchers` by one or two in one or two runs, and `assault`'s `road_barriers`
  once, by three. Why the whole story reads worse than the memories here was not looked into.

Reasoning and time. One recall request asks all 12 questions of a scenario, and the seconds are the probe's, from its
start to the answer, over OpenRouter:

| | `hospital` | `assault` |
| --- | --- | --- |
| Reasoning tokens a request, reread on, runs 1 · 2 · 3 | 3221 · 2743 · 2718 | 656 · 808 · 752 |
| The same, ceiling on | 2143 · 1823 · 2038 | 713 · 646 · 636 |
| Output tokens a request, reread off; on | 321; 3757–4491 | 162–326; 1239–1573 |
| Seconds a recall, reread off; on | 7–8; 93–110 | 5–9; 32–49 |
| Seconds a recall, ceiling off; on | 6–15; 76–114 | 6–9; 42–44 |

Over the six thinking rereads a request reasoned 1763 tokens at the median and 3221 at most, about 147 and 268 a
question. A limit of 512 a request, had it held, would have left `hospital` a fifth or a sixth of the reasoning it used
and `assault` about two thirds; what that does to the answers is not measured.

The cost, as this measurement's own requests by the provider's usage: 26 requests and 278,573 tokens of the 500,000
allowed. The rereads without thinking took 6 and 50,254, with it 6 and 65,001, the cap's run 2 and 21,926, the ceilings
with thinking 6 and 90,974, and the control 6 and 50,418. No reservation stayed unsettled. At $0.08 to $0.14 a million
in and $0.30 to $0.40 out, that is about $0.03 to $0.05. The ledger's `openrouter-paid` day stood at 73 requests and
443,184 tokens before the smoke and at 126 and 800,032 after the control, 27 and 78,275 of them other agents'.

Conclusion: the prediction holds, by far. Over the same memories thinking took `hospital` from 4, 3, 4 to 12, 12, 10
and `assault` from 8, 9, 8 to 12, 12, 12, run by run +8, +9 and +6 and +4, +3 and +4, each far beyond Gemma's spread of
one question, and the control without thinking at the same limit stayed where the reread without thinking was. On these
two scenarios Gemma's compacted memories, with the scenes kept as text, hold what the twelve questions need, and the
losses of its memory `score` are its reader's, as the proposal read them. Without thinking the whole story helped no
more than the memories (3.3 on `hospital` against 3.7 and 4.0); with thinking the memories were the better text there
(11.3 against 7.7). The price here is 12 to 14 times the recall's output tokens on `hospital` and 4 to 10 on `assault`,
run by run, and 93 to 110 s for a `hospital` recall against 7 to 8 s. The bot writes scenes and frames without thinking
as before, and `RECALL_THINKING` is an eval switch, off by default. By the proposal, this result makes O3, a scene
that thinks on the card, the next question, and O3 would need scene, walk and latency tests; whether to run them is
the owner's call.

Limitations:
- Hosted Gemma 4 31B stands in for the heretic Q6_K on the card
  ([acceptance](../improve-loop.md#acceptance-on-gpu)), and nobody has seen that model think under the pinned
  llama.cpp. Only a card run, on the owner's word, can say this of the bot's model.
- The recall is the eval's list of questions after the story, all twelve in one request with a schema, not a scene. A
  scene that thinks has to count while it writes, and its first word waits for the thinking; neither was measured.
- Three memories of each scenario, two scenarios, one pack, and the same three memories for every reread side. `sgr`,
  the other scenarios and the holdout were not run, and other memories could hold less than these.
- OpenRouter picks an endpoint for each request, and the log does not say which. The control rules out the change of
  the endpoint pool at 16384, not that a thinking request goes to other endpoints than one without thinking.
- The cap was not applied, so how little thinking keeps the gain is not known.
- Results: `$R/reread-off-N`, `$R/reread-on-N`, `$R/reread-room-N` (the control) and `$R/reread-512-1` as `.json`,
  `.log` and `.meta`; `$R/ceil-on-N.log` and `.meta`; the probes' directories under `$R/tmp/`; `$R/tables.cjs`, which
  prints these tables from the probes' reports; and `$R/usage.txt`, the ledger's day at each stage.

<a id='l2-2026-09-28'></a>

## 2026-09-28 · Opus 5.5 · L2: a compatible claim about an unshown past, confirmed and kept (measurement)

Eval-building under the owner's lift of 2026-09-21 ([the lift](../improve-loop.md#frozen-boundaries)), the last step of
the plan for story consistency, and no longer a change. [O2](#o2-2026-09-27) left the open-world past without a scored
test, since the narrator's rule does not decide it, and the owner chose on 2026-09-27: «Я думаю в eval мы проверяем да.
В боте наверное пока ограничение не ставим же?» ("I think in the eval we check for yes. In the bot we probably set no
restriction for now, right?"). So the eval expects the narrator to confirm a compatible claim about a shared past that
no scene shows, and the story to keep to it a scene later. The plan's L2 clause, a narrator rule, was dropped, and no
prompt changed. If a model of the main group fails, its numbers go to the owner, and so does any prompt change.

What was built.
- The scoring (938e0b7). A trap may carry `set: 'open'`, which `eval.ts` scores apart as `sceneOpen` in a cell and
  `sceneScoreOpen` in the summary, by the worst-model rule; the judge's `judged` event counts it in `openPassed` and
  `openTotal`, and `eval-stats` leaves it out of its legacy instrument. Such a trap may carry `then`: the probe saves the
  trap's scene, commits it in a copy of the story as the bot commits a scene, begins the next job there from the `then`
  input, and the same model writes the next scene; the judge answers the `then` questions with both inputs and both
  scenes before it. The replayed story keeps neither scene, so no other trap sees them.
- The trap (8f7beac), `open_unrecorded_request` in the local pack's `assault`, after the last frozen scene (08:00):
  «08:01. Ян по трубе докладывает Неле, что пересчитал запасные фонари на складе, как она велела ему в 06:52, и просит
  отметить её поручение в журнале.» ("08:01. By tube, Ян reports to Неля that he has counted the spare lanterns at the
  warehouse, as she told him at 06:52, and asks her to log her instruction.") No scene shows or rules out that
  instruction: at 06:48 Неля asked Ян about the stock by the warehouse tube, and at 06:56 she spoke to Рута by another.
  `open_request_confirmed` (yes) asks whether the scene presents the instruction as actually given. Then the model
  writes the next scene from «Неля пересказывает Дане доклад Яна о пересчёте запасных фонарей и упомянутом в нём
  поручении.» ("Неля retells to Дана Ян's report about counting the spare lanterns and the instruction it mentions."),
  and `open_request_kept` (yes) asks whether that scene keeps what the previous one established about the instruction,
  whether it was given, by whom and when; the scene must touch the instruction, and compatible additions are allowed.
  The pack is not pushed.

How it was made. An Opus 5.5 agent drafted the trap, O2's dropped `o2_unrecorded_request` with the owner's expectation,
and checked its premises against the seed and the 16 frozen scenes. It chose spare lanterns over the empty boxes of O2's
version, which carry the ampoules: the ampoules are the scenario's tracked resource, whose accounting rules could give a
narrator a reason of its own to doubt the claim, so that a refusal would not show that the model treats the unrecorded
as false. GPT-6 Astra (`codex exec` at `high`, read-only, a bundle with the scenario, the narrator's request, the judge
and the code) reviewed the trap and the code from 20:17 to 20:20 UTC on 2026-09-27 and answered «freeze with the listed
changes». It kept the premise, the facts and the first question, accepted the lanterns, and corrected the audit:
lanterns also appear in scene 16, and none of the three mentions excludes spares at the warehouse. It accepted the
second question as a check of consistency apart from confirmation, so that a model that refuses the claim and keeps
refusing it fails the first question and passes the second, «provided `sceneOpen = 1/2` is never described as successful
confirmation followed by retention». It rewrote the `then` input, which no longer names a tube, since Дана and Неля are
both at headquarters, and the second question, which now needs the scene to touch the instruction; both stand word for
word. Its three code findings were applied before the freeze: a failure to write the `then` scene, or of the judge's
call on it, fails its own question only, where it would have cost the mode's other traps their verdicts; a resumed probe
writes a missing `then` scene over the saved one; and `then` is accepted in set open only. On the pair with the older
`invented_knowledge`, a claim the record contradicts, it warned: «A failure on the new trap alone cannot establish that
the model universally treats unrecorded events as false. Keep the pair and interpret the actual scenes alongside their
scores.»

Before the freeze, a dry run went through `eval.ts`, the probe, `createModel` and `codex.ts` with a stand-in `codex`
first on PATH, so that no request left the computer, on a scratch copy of the pack with two more open traps that failed
on purpose. The continuation request held the trap's input, then its scene, then the `then` input, and no other trap's
scene; the failed continuation and the failed judge call each failed one question and nothing else; and a resumed
probe wrote only the missing continuation. `npm test` (298 passed, 3 skipped), `npm run check` and `git diff --check`
passed.

The calibration, one run a model, from 8f7beac on 2026-09-28, 00:05:28 to 00:16:54 UTC. A script waited for 00:05 and
started only after checking that the pack's `assault` was the frozen file and that nothing under `local/`, `lib/` or
`examples/` differed from 8f7beac. With `R=~/simple-story-chat-runs/2026-09-27/l2`:

```
TMPDIR=$R/tmp/calib-1 npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault --mode plain --models openrouter:google/gemma-4-31b-it,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001 --judge claude:claude-opus-5-5 --out $R/calib-1.json
```

Every cell finished, with no retry and no failed call. Memory · older scene traps · set o2 · set open:

| Model | `assault` |
| --- | --- |
| Gemma 4 31B | 9/12 · 11/12 · 7/7 · 1/2 |
| `gpt-5.4-mini` | 8/12 · 11/12 · 7/7 · 1/2 |
| Haiku 4.5 | 10/12 · 12/12 · 7/7 · 1/2 |

No model confirmed the claim. Each failed `open_request_confirmed` and passed `open_request_kept`, which by Astra's
condition is not a confirmation kept. In every scene Неля says she gave no such instruction and does not log it:
Gemma's and mini's first find no entry in her log, and Haiku's recalls another order at 06:52. In Gemma's and
Haiku's, Ян then allows that he mixed it up or counted on his own; in mini's, Неля offers to log the count as done
without an order. Every next scene retells the refusal. The pair
Astra asked to read with the trap tells two behaviours apart. mini and Haiku also rejected `invented_knowledge`, in
which Глеб reminds Неля of an early discussion of the collapse that the record contradicts, so both refuse an
unrecorded past whether the record allows it or not. Gemma accepted that discussion (`prior_discussion_accepted`
failed, as in O2) and still refused the compatible instruction, so its answers do not follow the record: it accepts
a past the record contradicts and refuses one the record allows.

The other misses. Older traps: Gemma `prior_discussion_accepted`, mini `one_tunnel_barrier`. Memory: Gemma
`river_barriers` (stated in memory and misread), `road_barriers` and `tunnel_barriers`; mini `road_barriers`,
`tunnel_barriers`, `river_stock` and `ruta_learns`; Haiku `road_barriers` and `river_stock`. Not scored: mini's `then`
scene carries the trap scene's own stamp, 08:01.

Cost, from `npm run eval -- usage` before and after, the day's first use: openrouter-paid 145,389 tokens and
openai-small 168,051, 21 requests each. Haiku and the judge ran on the Claude subscription.

Conclusion: a measurement. The owner's expected behaviour is met by no model of the main group: each refuses the
compatible claim and keeps the refusal a scene later, so every model scores 1/2 and `sceneScoreOpen` is 0.5. mini and
Haiku read the past as closed; Gemma refuses this claim and accepts a contradicted one. The narrator's prompt does not
state the policy (O2's gap), and no prompt changed. A rule that makes the narrator confirm a compatible past is a
prompt change, which goes to the owner first; this calibration is its baseline.

Side measurements on the card's model, apart from the calibration. On 2026-09-27 the owner asked whether the tester's
model, the heretic, behaves like the Gemma arm on the traps, so that the loop's results carry over to it. Two
measurements on two cards answer it. Neither used paid tokens: a card is billed by the minute, and the judges ran on
their subscriptions.

The first is one run on the card's model through llama.cpp. `gemma-4-31b-heretic-q6k` ran on llama-server on the
rented card, with one slot and 65,536 tokens of context, shared with the live tester's bot. The run used `assault` in
`plain` with the traps, from 8f7beac, 21:01 to 21:11 UTC, through the `llama-cpp` provider and `createModel` with the
bot's defaults. Opus 5.5 judged it as in the calibration, from 21:14 to 21:15. `memory-probe.ts` and `scene-judge.ts`
ran directly from an empty directory, with the arguments and the model environment that `eval.ts` gives them, and a
pass-through on this computer timed every call. The card was destroyed on the owner's word right after, so nothing else
ran on it.

| One run, 2026-09-27 | Memory | Older scene traps | Set o2 | Set open |
| --- | --- | --- | --- | --- |
| The card's model, llama.cpp | 8/12 | 11/12 | 7/7 | 0/2 |
| Hosted Gemma 4 31B in [O2](#o2-2026-09-27) | 10/12 | 11/12 | 7/7 | (1/2 in the calibration above) |

The card's model lost `river_barriers`, `road_barriers`, `tunnel_barriers` and `river_stock`, the four that hosted Gemma
lost in runs 1 and 3 of [L3](#l3-2026-09-27)'s baseline and that the same build lost on
[2026-09-22](#scenarios-2026-09-22). `river_barriers` stood in its memory and was misread at recall. Its one older miss,
`prior_discussion_accepted`, is hosted Gemma's in O2 and in the calibration. It refused the open trap's claim. Неля
finds nothing in the log, recalls being busy at 06:52, asks Ян whether it was really her and logs nothing. In the
`then` scene Дана will not log it, and the narration says the instruction did not exist. The judge also failed
`open_request_kept`, without a reason.

Time on the card, from the pass-through:
- 17 scene calls, 16 traps and one `then`, took 6.0 to 14.1 s each, median 8.6 s.
- The scenes wrote 240 to 515 tokens at 49.5 tokens a second.
- Uncached prompts of 3,189 to 6,618 tokens ran at 1,720 to 2,002 tokens a second.
- The three compactions took 17.0, 30.8 and 20.6 s, and the recall 10.6 s.
- Every completed call took at most 0.9 s beyond the server's own prompt and generation time, about the tunnel's round
  trip, so none waited behind the tester's.
- These prompts stayed under 7,200 tokens; a long live story's are larger.

One call timed out:
- Request 20 in the pass-through's log was the first attempt's scene of `mid_wagon_schedule`, after turn 14, with
  `max_tokens` 4096.
- Its token count, request 19, answered at 21:03:40 in 1.2 s.
- Request 20 has no line: the pass-through logs a request when it ends, and the probe closed this one at 21:08:39, at
  the provider's 300 s counted from the token count.
- The next line is the second attempt's health check at 21:08:39.
- The resumed call, request 24 at 21:08:41, found 7,104 of its 7,109 prompt tokens in the server's cache. No earlier
  completed call of the run reached a prefix that long, so the server had processed request 20's prompt. The resumed
  call wrote the scene in 11.2 s.
- A runaway to 4096 tokens at 49.5 tokens a second takes 83 s, 87 s with the prompt, well inside the five minutes. So a
  runaway does not explain the timeout, and the cause is unknown.
- The probe resumed from its saved report. `eval.ts` does not resume a probe and would have scored this cell 0/12 with
  no scene judged.

The second, on the owner's word of the same night, to keep the next card busy, is the heretic through route A,
`serving:heretic` ([our own card](../eval.md#own-card)): simple-serving 940471a in front of vLLM 0.30.0 with
`gemma-4-31b-heretic-nvfp4`, MTP 3, an fp8 KV cache of 151,300 tokens and dense prefix retention. The tester had moved
to this card, and our calls went as class `internal`, which the gateway serves after the readers'. It ran what the
calibration and L1 measure for one model, three runs each: replays of `assault` and `hospital` judged by Opus 5.5, and
walks of the lighthouse trunk judged by Opus 5.5, Fable 5.1 and GPT-6 Astra at `high`, each walk on its own copy of
the pack. From 8f7beac on 2026-09-27, with `D=~/simple-story-chat-runs/2026-09-28/serving`: `assault` run 1 from 23:24:32
to 23:27:57 UTC, runs 2 and 3 at once from 23:34:22 to 23:41:20, then the three `hospital` replays and the three walks
at once, until 23:51:30.

```
TMPDIR=$D/tmp/<run> npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault|hospital --mode plain --models serving:heretic --judge claude:claude-opus-5-5 --out $D/<run>.json
TMPDIR=$D/tmp/walk-N npm run eval -- walk-nodes --pack $D/pack-walk-N --scenarios lighthouse --models serving:heretic --judges claude:claude-opus-5-5,claude:claude-fable-5-1,codex:gpt-6-astra@high --branches 0 --no-grow --max-path-tokens 6200 --out $D/walk-N/walk-nodes.json
```

No call failed: 18 compactions and 6 recalls parsed at the first attempt, with no retry, and 99 trap scenes and 24
walk scenes came back whole; every walk node was decided by all three judges. The whitespace that the card's frame
descriptions run into did not appear in these structured calls.

| Route A, runs 1 · 2 · 3 | Memory | Older scene traps | Set o2 | Set open | Walk, consistent of 8 |
| --- | --- | --- | --- | --- | --- |
| `assault` | 8, 8, 8 | 8, 9, 11 | 7, 7, 7 | 1, 1, 1 | |
| `hospital` | 3, 2, 2 | 8, 6, 8 | 6, 6, 6 | | |
| lighthouse | | | | | 2, 2, 0 |

Beside the main group. On `assault` the calibration above gave Gemma, mini and Haiku 9, 8 and 10 for memory, 11, 11
and 12 for the older traps, 7/7 on set o2 and 1/2 on set open. On `hospital` and the walks,
[L1](#l1-2026-09-27)'s baseline gave, as memory · older traps · o2 · walk:
- Gemma 5, 4, 4 · 10, 9, 9 · 6, 6, 6 · 4, 1, 2;
- mini 2, 1, 0 · 8, 9, 8 · 6, 4, 5 · 1, 0, 1;
- Haiku 7, 7, 5 · 9, 0, 10 · 6, 0, 6 · 0, 0, 2, its run 2 hit by the Claude CLI.

Keys on `assault`:
- Memory: the heretic lost `river_barriers`, `road_barriers`, `tunnel_barriers` and `river_stock` in every run, and
  `river_barriers` was stated in memory and misread.
- Older traps: it missed `prior_discussion_accepted` in every run, the two tunnel-barrier traps in two and
  `gauge_source` in one.

Keys on `hospital`:
- Memory: it lost nine checks in every run and `bridge_limit` in two.
- Older traps: it missed `key_fetched`, `key_in_klim_pocket` and `nazar_knows_in_advance` in every run.
- Set o2: it missed `o2_opening_before_completed_bell` in all three runs, as Gemma's L1 baseline did.

On the open trap it refused the claim in every run, by the empty log. The next scene kept the refusal, so
`open_request_kept` passed and `open_request_confirmed` failed, which by Astra's condition is not a confirmation kept.

Across both builds, the heretic refused the compatible instruction in four runs of four and accepted the contradicted
discussion of `invented_knowledge` in four of four, the pair Gemma showed in the calibration. On the traps it behaves
like the Gemma arm: set o2 and the open pair the same, the older traps and memory at or below Gemma's, and the walks
inside the group's range. Hospital is its weakest scenario: memory 3, 2, 2 against Gemma's 5, 4, 4 in L1, although
hosted Gemma also scored 3/12 in O2 and 3, 4, 3 in L3's baseline, and older traps 8, 6, 8 against 10, 9, 9.

Limitations:
- One trap and one run a model: two yes/no answers a model, and the set's noise is unknown.
- The input asks Неля to log the instruction, and two of the main group's three refusals, and all four of the
  heretic's, rest on her log. The pack's README names this request among the differences from `invented_knowledge`.
- One judge, Opus 5.5. The `then` question passes a refusal kept, by design.
- Russian, `plain` only, `assault` only, one pack. The pack is not pushed.
- The card's model: the llama.cpp run is one run with one resume, and on route A the `hospital` replays and the walks
  ran six at once beside the tester, so no timing from them is comparable.

<a id='l1-2026-09-27'></a>

## 2026-09-27 · Opus 5.5 · L1: the reference stamp as the last scene's opening, in lastMessage (not accepted)

A step of the loop, the second of the plan for story consistency that the owner asked for on 2026-09-27, and the one
[O2](#o2-2026-09-27) gave a target: in O2's calibration all three models of the main group missed
`o2_opening_before_completed_bell`, a scene that opens before an event the last scene completed.

Hypothesis. The narrator anchors a new scene at the reference stamp, which is the last scene's opening, instead of
after what that scene narrated. Saying in `lastMessage` that the stamp is the last scene's opening (before the first
scene, the seed's start) and that, unless the author names a time, the new scene begins no earlier than the end of what
the last scene showed as done, removes contradictions across the scene boundary without other losses.

Change, in `lastMessage` of `local/story-text/ru.ts` only. «Опорная дата и время последней сцены: ${referenceTime}»
("Reference date and time of the last scene") became «Опорная дата и время: ${referenceTime}. Это начало последней
сцены, а до первой сцены — начало истории из сида. Если автор не назвал время, новая сцена начинается не раньше, чем
закончилось всё, что последняя сцена показала совершившимся. Время, лишь названное в словах, планах или обещаниях, от
этого не наступает.» ("Reference date and time: … . This is the start of the last scene, and before the first scene the
start of the story from the seed. If the author named no time, the new scene begins no earlier than everything the last
scene showed as done has ended. A time only named in words, plans or promises does not come about by this.") The
author's message, `narratorRule`, the other four catalogs and the memory stayed as they were. `npm test` and
`npm run check` passed with the edit. It was never committed: the patch is `$RL/l1.ru.diff`, and `ru.ts` is back at
b166918's text.

The rule, written before any run (`$RL/rule.md`, 18:15:59 UTC, sha256 f9491784…). Three runs a side of the main group
(`openrouter:google/gemma-4-31b-it`, `openai:gpt-5.4-mini`, `claude:claude-haiku-4-5-20251001`): a replay of
`hospital` judged by `claude:claude-opus-5-5`, and a walk of the lighthouse gold tree's trunk (`walk-nodes --branches 0
--no-grow --max-path-tokens 6200`, the eight tasks d1 to d8) judged by Opus 5.5, Fable 5.1 and GPT-6 Astra at `high`,
each walk on its own copy of the pack. Four measures for each model and run: M memory (12 checks), S the older scene
traps (12 questions), O set o2 (7 questions, the target among them), W the walk (consistent of decided nodes). A gain
on a measure: every candidate run above the best baseline run; a fall: the candidate mean below the lowest baseline
run. Full success: the runs' worst values gain on one measure and neither they nor any model fall on any; semi-success:
the same with Gemma's gain. Both sides on one UTC day, the baseline first; a provider failure is rerun once, and a
second failure counts as the eval scores it.

Commands, from the repository, with `RL=~/simple-story-chat-runs/2026-09-27/l1`, N = 1, 2, 3 and `$M` the three
models. Each side ran its three replays at once and then its three walks at once, each run with its own `TMPDIR` under
`$RL/tmp` and each walk on a fresh copy of the pack; `npm run eval -- usage` ran before, between and after
(`$RL/side.sh`).

```
TMPDIR=$RL/tmp/<side>-N npm run eval -- --pack ~/simple-story-chat-eval --scenarios hospital --mode plain --models $M --judge claude:claude-opus-5-5 --out $RL/<side>-replay-N.json
TMPDIR=$RL/tmp/<tag>-walk-N npm run eval -- walk-nodes --pack $RL/pack-<tag>-N --scenarios lighthouse --models $M --judges claude:claude-opus-5-5,claude:claude-fable-5-1,codex:gpt-6-astra@high --branches 0 --no-grow --max-path-tokens 6200 --out $RL/<tag>-walk-N/walk-nodes.json
```

- Baseline replays at 06eddc9, 18:16:54 to 18:33:12 UTC. Baseline walks (`base-redo`) at b166918, 19:08:45 to
  19:24:35.
- Candidate replays at b166918 with the edit, 19:25:34 to 19:40:14. Candidate walks (`l1`), 19:40:15 to 19:54:21.
- Haiku's reruns of run 2, alone: the baseline's 18:51:26 to 19:07:10 at 06eddc9, the candidate's 19:54:41 to
  20:09:54 at b166918 with the edit.

What happened outside the rule, in order (`$RL/deviations.md` has each with its time):
1. Baseline replay 2: Haiku's cell ended with `timeout`, the Claude CLI giving no answer for five minutes after its
   third trap scene. Its one rerun failed too, with `provider_failed` from the CLI (exit 1, `cliError`, stop reason
   `stop_sequence`) after the memory questions and before any trap was judged. By the rule it counts as the eval scores
   it: memory 7/12, the traps 0/12 and 0/7 (`no_scenes`). So neither Haiku's nor the worst values' S and O could fall.
2. Every GPT-6 Astra judge call of the first three baseline walks stopped before it reached Codex: `local/config.ts`
   refused the model name `gpt-6-astra@high`, since its check allowed no `@`, and 06eddc9, which added the suffix, had
   been checked with a stub launcher that skips that check. Every node went unjudged by Astra. Those walks were left
   to finish and then discarded (`$RL/discarded/`), and b166918 accepts the suffix for `codex-cli` only. A free check
   ran `walk-judge` over a copy of one finished task with a stand-in `codex` first on PATH that records its arguments
   and fails: the judge started the CLI with `--model gpt-6-astra -c model_reasoning_effort="high"`. The three
   baseline walks ran again at b166918 on fresh copies of the pack, and every node of them was decided by all three
   judges. The replays' code and the walks' code differ only in that check and in docs, which no replay model or judge
   touches.
3. Two of the discarded walks had a Gemma step open from about 18:33 to 19:05 with no event: an OpenRouter stream stayed
   open, the five-minute timeout in `local/llama.ts` did not end it, and walk-step's own 30-minute deadline did, with
   `timeout` in `generate`; walk-nodes then ran the task again. Recorded for the owner, not investigated in this step.
   In the kept walks no model went more than three minutes without an event.
4. Candidate replay 2: Haiku's cell ended with `provider_failed` during its second memory compaction (exit 1,
   `cliError`, stop reason `stop_sequence`, after 147 s), the same CLI error. Its one rerun, alone after the
   candidate walks, passed: memory 4/12, the older traps 10/12, set o2 7/7.

Numbers, per model, runs 1, 2 and 3; † marks a cell taken from Haiku's rerun:

| Model | Side | M (memory /12) | S (older traps /12) | O (set o2 /7) | W (walk nodes /8) |
| --- | --- | --- | --- | --- | --- |
| Gemma 4 31B | baseline | 5, 4, 4 | 10, 9, 9 | 6, 6, 6 | 4/8, 1/8, 2/8 |
| Gemma 4 31B | candidate | 5, 4, 4 | 10, 9, 11 | 7, 6, 7 | 3/8, 3/8, 5/8 |
| gpt-5.4-mini | baseline | 2, 1, 0 | 8, 9, 8 | 6, 4, 5 | 1/8, 0/8, 1/8 |
| gpt-5.4-mini | candidate | 0, 3, 3 | 4, 9, 5 | 5, 5, 6 | 0/8, 1/8, 1/8 |
| Haiku 4.5 | baseline | 7, 7†, 5 | 9, 0†, 10 | 6, 0†, 6 | 0/8, 0/8, 2/8 |
| Haiku 4.5 | candidate | 8, 4†, 6 | 9, 10†, 10 | 7, 7†, 7 | 0/8, 3/8, 1/8 |

M is memory, S the older scene traps, O set o2 (`hospital` replays); W is consistent of decided walk nodes, and
every node on both sides was decided, with no split and no error.

The rule, measure by measure (a gain needs every candidate run above the best baseline run, a fall a candidate mean
below the lowest baseline run):

| Measure | Worst values | Gemma 4 31B | `gpt-5.4-mini` | Haiku 4.5 |
| --- | --- | --- | --- | --- |
| M, of 12 | 2, 1, 0 → 0, 3, 3 | 5, 4, 4 → 5, 4, 4 | 2, 1, 0 → 0, 3, 3 | 7, 7, 5 → 8, 4, 6 |
| S, of 12 | 8, 0, 8 → 4, 9, 5 | 10, 9, 9 → 10, 9, 11 | 8, 9, 8 → 4, 9, 5: **fall** | 9, 0, 10 → 9, 10, 10 |
| O, of 7 | 6, 0, 5 → 5, 5, 6 | 6, 6, 6 → 7, 6, 7 | 6, 4, 5 → 5, 5, 6 | 6, 0, 6 → 7, 7, 7: **gain** |
| W, of 8 | 0, 0, 1 → 0, 1, 1 | 4, 1, 2 → 3, 3, 5 | 1, 0, 1 → 0, 1, 1 | 0, 0, 2 → 0, 3, 1 |

Decision: not accepted. `gpt-5.4-mini` fell on the older traps: 4, 9 and 5 of 12, a mean of 6, below its lowest
baseline run of 8. Nothing else fell. The worst values gained on nothing, and neither did Gemma: its set o2 went from
6, 6 and 6 to 7, 6 and 7, and run 2 did not rise above the best baseline run. Haiku gained on set o2, 7 of 7 in every
run, which the rule does not count for acceptance. `git checkout -- local/story-text/ru.ts` restored the text. The
second rejection in a row, after [L3](#l3-2026-09-27); a third stops the loop for the owner's decision
([the rule](../improve-loop.md#stop-conditions)).

Diagnostics, which decide nothing:
- The target. `o2_opening_before_completed_bell` failed in all 8 judged baseline cells (Haiku's run 2 had no scenes)
  and in 4 of 9 candidate cells: Gemma in run 2 only, mini in every run, Haiku in none.
  `o2_author_minute_kept_h`, an author's named minute that must stand, passed in every judged cell on both sides, so
  the edit did not make the models override the author's time.
- mini's older traps. On the baseline mini lost 11 of 36 questions over three runs, and with the edit 18: `key_fetched`,
  `key_in_klim_pocket` and `nazar_knows_in_advance` in every run (twice each on the baseline), `order_explained`,
  `yard_reopened` and `route_corrected` twice (once each), `cancelled_cargo_used` once (twice), and `fresh_cell_spent`
  and `open_bridge_crossed` once (never). They ask about a key, orders, a route, stock and knowledge; none of them
  concerns when a scene opens. Its run 2 lost 3, as on the baseline, whose runs lost 4, 3 and 4; runs 1 and 3 lost 8
  and 7.
- The walks' findings of kind `time`, as the council counts them (a finding confirmed when more judges confirm than
  refute it), over 24 nodes a model a side: Gemma 34 confirmed in 12 nodes on the baseline and 29 in 8 with the edit,
  mini 48 in 16 and 38 in 15, Haiku 62 in 18 and 33 in 12 (`$RL/timefindings.cjs`).
- No compaction was repeated on either side. Requests repeated after a provider failure (`yielded`): the baseline's
  Gemma once (`provider_failed`) and mini twice (`rate_limited`), the candidate's Gemma nine times and mini three
  times, with the same codes.

The cost, from `npm run eval -- usage`. openrouter-paid went from 1,922,807 tokens at 18:16 UTC to 3,448,668 after the
candidate walks, and openai-small from 517,279 to 2,008,759, against the rule's estimate of about 1.2 million each:

| Part | openrouter-paid | openai-small |
| --- | --- | --- |
| Baseline replays | 522,040 | 556,944 |
| Discarded baseline walks, to 19:08 | 79,970 | 116,110 |
| Baseline walks at b166918, with the discarded walks' tail | 160,855 | 115,615 |
| Candidate replays | 645,714 | 584,761 |
| Candidate walks | 117,282 | 118,050 |
| The step | 1,525,861 | 1,491,480 |

The candidate replays took 124 thousand more openrouter-paid tokens than the baseline's, with nine repeated Gemma
requests to one; the ledger keeps a failed request's reservation, as L3 found. Haiku, the judges and both of Haiku's
reruns ran on the Claude and ChatGPT subscriptions, which the ledger does not count. No limit was reached, and the
day's caps stood at 3.45 of 4 million and 2.01 of 2.25 million after the step.

Conclusion: not accepted. On the target the line worked for two of the three models: Gemma and Haiku opened after the
completed bell in 5 of their 6 runs, where they did in none of their 5 judged baseline runs, and the walks' confirmed
time findings fell for all three, most for Haiku. But mini, which failed the target in every run on both sides, lost
older traps that do not concern time, and by the rule a fall of any model rejects. Three runs cannot say whether mini's
loss comes from the edit or from its own spread: its run 2 kept the baseline's level. A narrower wording, or the same
one with more runs of mini, would be a new step with its own rule, and the plan has none left: L2 is now a measurement,
as the owner decided.

Limitations:
- Three runs a side, `hospital` only for the replays, one question for the target, so a model's target is three
  yes-or-no answers.
- Haiku's run 2 failed on the Claude CLI on both sides, on different operations. On the baseline its rerun failed too,
  so only its memory counted there; on the candidate's side the rerun passed.
- One judge, Opus 5.5, for the replays' traps; three for the walks.
- The baseline replays ran at 06eddc9 and its walks at b166918, which differ in the model name check only.
- Hosted Gemma stands in for the bot's heretic Q6_K, and the log does not say which provider OpenRouter picked.
- Results: `$RL/{base,l1}-replay-N.json` and `-2r.json` with their `.log` and `.err` files, the walks under
  `$RL/{base-redo,l1}-walk-N/` on `$RL/pack-{base-redo,l1}-N`, the usage snapshots `$RL/usage-*.jsonl`, the rule and
  `decide.cjs`, which printed the decision, `table.cjs` and `timefindings.cjs`, and the discarded walks under
  `$RL/discarded/`.

<a id='o2-2026-09-27'></a>

## 2026-09-27 · Opus 5.5 · O2: traps for time across the scene boundary and for an unshown past (measurement)

Eval-building under the owner's lift of 2026-09-21 ([the lift](../improve-loop.md#frozen-boundaries)), step 3 of the
plan for story consistency that GPT-6 Astra ranked that morning. New narrator traps, frozen before any wording is
tested, so that L2 and L1 get a measure on the weakest rows. No prompt and no story changed.

What was built.
- The scoring (f7129fc). A trap may carry `set: 'o2'`. `eval.ts` scores those apart: `sceneO2` in every cell and
  `sceneScoreO2` in the summary, by the same worst-model rule, while `scene` and `sceneScore` keep the older traps
  alone, as the lift asks, so the log's earlier numbers stay comparable. The judge's `judged` event adds `o2Passed` and
  `o2Total`, and `eval-stats` leaves set o2 out of its scene instrument, so its cells of past runs do not change.
  cfa2704 holds the extraction probe's key tests to the older traps.
- The traps (e482457), 15 with 18 questions, 7 expecting `yes` and 11 `no`. `battle`'s four are in
  `examples/scene-traps.ts`; `assault`'s five and `hospital`'s six are in the local pack, whose README says what the
  set is and what it does not test. The pack is not pushed.

| Kind | Questions (scenario, placement, expected) |
| --- | --- |
| Time across the scene boundary, 9 | `o2_seal_early` (battle, end, no), `o2_lock_before_seal_time` (battle, end, yes), `o2_author_minute_kept` (battle, end, yes), `o2_wagons_early` (assault, end, no), `o2_farid_early` (assault, after 10, no), `o2_ampoules_early` and `o2_ampoules_used_early` (assault, after 12, no), `o2_author_minute_kept_h` (hospital, end, yes), `o2_opening_before_completed_bell` (hospital, after 15, no) |
| An unshown past and knowledge where the seed rules them out, 3 | `o2_order_confirmed`, `o2_handover_confirmed` (hospital, end, no), `o2_boris_knows_confirmation` (hospital, after 11, no) |
| Controls, 6 | `o2_rope_taken` (battle, end, yes), `o2_backstory_told` (assault, end, yes), `o2_backstory_rejected` (assault, end, no), `o2_recall_confirmed` (assault, end, yes), `o2_backstory_told_h` (hospital, end, yes), `o2_backstory_rejected_h` (hospital, end, no) |

How they were made. An Opus 5.5 agent drafted 15 traps and checked every premise against the frozen scenes' text.
GPT-6 Astra reviewed the draft (`codex exec` at `high`, read-only, a bundle holding only the files it needed), from
10:57 to 11:04 UTC. It replaced the wording of eleven traps, kept two, dropped `o2_unrecorded_promise` (battle) and
`o2_unrecorded_request` (assault), added `o2_after_completed_bell` and `o2_sealed_report_knowledge` (hospital), and
ended «Do not freeze». Its reason: «the current rules do not unambiguously distinguish acceptable new backstory from
confirmable unrecorded agreements, so the repaired set still lacks a defensible scored test of the open-world
unsupported past that O2 was meant to establish». The review was applied word for word. The author proposed two
deviations on the bell trap: an input without a raised hand, which scene 15 does not show, and a cutoff at 03:31, the
reading of the lagging clock the bell was set by, instead of the civil 03:35, which needs the four-minute lag from
compacted memory. The author asked to freeze the set as scoped. The second review, from 11:07 to 11:08, accepted both
deviations, found no other difference from its text, and answered «Freeze this scoped set with both deviations
accepted; leave L2 unrun pending the owner's policy decision, and proceed with L1 only if calibration demonstrates
usable failures on the boundary traps.»

The gap, recorded in Astra's words: «The open-world unsupported past has no scored test because the current rule
treats past references as character claims while also instructing the narrator to accept compatible new information.
It does not unambiguously determine whether an unrecorded but compatible shared agreement may be confirmed. The
closed-world cases and autobiographical speech controls do not resolve that ambiguity. The owner must choose the
intended behavior before such a test can be scored defensibly.»

The calibration, one run a model, from e482457 on 2026-09-27, 11:23 to 11:54 UTC, with `R=~/simple-story-chat-runs/2026-09-27/o2`:

```
TMPDIR=$R/tmp npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault,hospital,battle --mode plain --models openrouter:google/gemma-4-31b-it,openai:gpt-5.4-mini,claude:claude-haiku-4-5-20251001 --judge claude:claude-opus-5-5 --out $R/calib-1.json
```

mini's `hospital` failed at the health check (`UND_ERR_CONNECT_TIMEOUT`) and was run again once, alone, from 11:31
to 11:35 (`$R/calib-1-mini-hospital.json`); the table shows the second run. Memory · older scene traps · set o2:

| Model | `assault` | `hospital` | `battle` |
| --- | --- | --- | --- |
| Gemma 4 31B | 10/12 · 11/12 · 7/7 | 3/12 · 8/12 · 6/7 | 8/8 · 15/15 · 4/4 |
| `gpt-5.4-mini` | 8/12 · 11/12 · 7/7 | 2/12 · 8/12 · 6/7 | 8/8 · 12/15 · 4/4 |
| Haiku 4.5 | 11/12 · 10/12 · 7/7 | 4/12 · 10/12 · 6/7 | 8/8 · 15/15 · 4/4 |

Each model passed 17 of the 18 o2 questions. All three missed the same one, `o2_opening_before_completed_bell`: after
the scene in which the second bell rang at the washbasin clock's 03:31, each opened the next scene before 03:31. Every
other time question passed, and so did the three on an unshown past or knowledge and all six controls. The run's own
`sceneScoreO2` reads 0.61 because it counts mini's failed first `hospital` cell as zero; with the second run the worst
model's share is 17/18 for each. The older traps' misses: Gemma and mini `prior_discussion_accepted` on `assault`
and `key_fetched`, `order_explained`, `key_in_klim_pocket` and `nazar_knows_in_advance` on `hospital`; mini also
`seal_allowed_charges`, `dagger_source` and `ally_corrected` on `battle`; Haiku `two_tunnel_barriers` and
`one_tunnel_barrier` on `assault` and `order_explained` and `garden_lamp_lit` on `hospital`.

Cost, from `npm run eval -- usage` before and after: openrouter-paid 465,837 tokens for Gemma's three cells, and
openai-small 517,279 for mini's four, the failed one included. Haiku and the judge ran on the Claude subscription.

Conclusion: a measurement. The set was frozen before any wording was tested, and it is scored apart, so the older
numbers stay comparable. On the main group it separates on one question only, which all three models miss: a scene
that opens before an event the last scene completed. That is the gate Astra set for L1, met by one key in one run a
model. L2's gate is not met: every model left the unshown order and handover unconfirmed and kept the sealed report
unread. Its clause targets the open-world past, which has no scored test, and the owner is choosing that policy. The
owner answered the pack's push on 2026-09-27: not now, after L1.

Limitations:
- One run a model. The set's noise is unknown.
- The shared miss is one key. Whether it is a model's error or a reading of the lagging clock is not
  settled by the question: it fails any opening before 03:31.
- The judge is Opus 5.5, one judge, and the trap scenes' stamps are the model's own first line.
- `o2_opening_before_completed_bell` fails only an opening before 03:31: an opening from 03:31 to 03:34 passes though
  the civil time was 03:35.
- Russian, `plain` only, one pack.

<a id='l3-2026-09-27'></a>

## 2026-09-27 · Opus 5.5 · L3: the value after the last change, with its basis, in plain extraction (not accepted)

A step of the loop, and the first of the plan for story consistency that the owner asked for on 2026-09-27. GPT-6
Astra ranked the candidates that day and put L3 first. Its stage A is a screen on hosted Gemma 4 31B alone, and it can
only reject. A pass would have led to stage B on the main group after two answers from the owner. It failed, so the
step ends here.

Hypothesis. The counts that models below the frontier lose are values that no increment states correctly after their
last change. Asking the extractor for that value with its basis, and for the total only when every term is known,
would put the value in memory and raise `score` without false totals. Several models lose these counts at once
([09-22](#scenarios-2026-09-22)), so it would be a general principle and not one model's failure.

Change, in the plain `summaryRules` of `local/story-text/ru.ts` only. «Не вычисляй неизвестное состояние и не
придумывай недостающие шаги.» ("Do not compute an unknown state and do not invent missing steps.") became «Если
newScenes меняют количество, запас, счёт или время, известные из previousMemory или сцен, запиши значение после
последнего изменения одним фактом вместе с основанием: прежнее значение, каждое изменение, итог. Выводи итог, только
когда известны все слагаемые; иначе запиши изменения и что итог неизвестен. Не придумывай недостающие шаги.» ("If
newScenes change a quantity, a stock, a count or a time known from previousMemory or the scenes, write the value after
the last change as one fact with its basis: the previous value, each change, the total. State the total only when
every term is known; otherwise write the changes and that the total is unknown. Do not invent missing steps.")
`sgrRules`, the other four catalogs, the schema and the 4096 cap stayed as they were, and `MEMORY_THINKING` stayed
unset. `npm test` and `npm run check` passed with the edit. It was never committed. The patch is `$R/l3.patch`, and
`ru.ts` is back at 002beee's text.

The gate, written in the step's plan before any run. The step goes on only if every candidate run beats the best
baseline run on the 24 pooled `assault` and `hospital` checks, no `battle`, `chess` or `dance` run falls below that
scenario's lowest baseline run, no key that all three baseline runs kept is lost twice, and the candidate side needs
no more compaction retries.

Commands, from the repository at 002beee, with `R=~/simple-story-chat-runs/2026-09-27/l3` and N = 1, 2, 3. The three
runs of a side ran at once, the baseline from 03:56 to 04:04 UTC and the candidate from 04:07 to 04:17, and
`npm run eval -- usage` ran before, between and after. Each run had its own `TMPDIR` under `$R/tmp`, so every probe
directory belongs to one run.

```
TMPDIR=$R/tmp/base-N npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault,hospital,battle,chess,dance --mode plain --models openrouter:google/gemma-4-31b-it --out $R/base-N.json
TMPDIR=$R/tmp/l3-N npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault,hospital,battle,chess,dance --mode plain --models openrouter:google/gemma-4-31b-it --out $R/l3-N.json
```

The second command ran with the edit. In all three of its runs the first `assault` compaction request was 18,669
bytes, 477 more than the baseline's 18,192, which is the edit's size.

Memory, mode `plain`, no judge:

| Scenario | Baseline, runs 1 · 2 · 3 | L3, runs 1 · 2 · 3 |
| --- | --- | --- |
| `assault` | 8/12 · 9/12 · 8/12 | 8/12 · 8/12 · 8/12 |
| `hospital` | 3/12 · 4/12 · 3/12 | 4/12 · 4/12 · 3/12 |
| `assault` and `hospital` pooled | 11/24 · 13/24 · 11/24 | 12/24 · 12/24 · 11/24 |
| `battle` | 7/8 · 8/8 · 8/8 | 7/8 · 8/8 · 8/8 |
| `chess` | 6/7 · 6/7 · 6/7 | 6/7 · 6/7 · 6/7 |
| `dance` | 12/13 · 13/13 · 10/13 | 10/13 · 13/13 · 13/13 |

The gate, condition by condition:

1. Pooled `assault` and `hospital`. The best baseline run scored 13/24 and the candidate runs 12, 12 and 11, so none
   beat it. Failed. Both sides average 11.7 of 24.
2. No run below its scenario's lowest baseline run. `battle` 7, 8 and 8 against 7, `chess` 6, 6 and 6 against 6,
   `dance` 10, 13 and 13 against 10. Passed.
3. 34 keys passed in all three baseline runs, and no candidate run lost any of them. Passed.
4. Compaction retries. None on either side. Passed.

Keys:
- `assault`: L3 lost `river_barriers`, `road_barriers`, `tunnel_barriers` and `river_stock` in every run. The
  baseline lost the same four in runs 1 and 3 and kept `river_stock` in run 2.
- `hospital`: both sides lost `river_left`, `garden_cells`, `river_stretchers`, `boat_spare`, `next_departure`,
  `origin_evacuated`, `polina_learned` and `boris_learned` in every run. `bridge_limit` was lost in baseline runs 1
  and 3 and in L3 run 3.
- `battle` lost `news` in run 1 of each side, and `chess` lost `fen`, its known ceiling, in every run. `dance` lost
  `b_clean`, `all_clean` and `cancelled_tango` in baseline run 3 and L3 run 1, and `cancelled_tango` alone in baseline
  run 1.
- Six of the lost keys have answers of two digits or more, which `stated` covers. `road_barriers` and `boat_spare`
  stood in no memory in any of the six runs. `river_barriers`, `river_left`, `garden_cells` and `origin_evacuated`
  stood in every memory, and the recall misread them. The rule moved none of the six.

Did Gemma follow the rule? Code counted the memories' facts without printing them. Facts with an equals sign before a
number went from 0 to 11 on `assault` and from 0 to 28 on `hospital`, over three runs a side, and facts with «итог»
("total") from 0 to 2 and from 0 to 8. `battle`, `chess` and `dance` had neither on either side. So the extractor
wrote totals with their basis where the story accumulates, and the two counts that stood in no memory still stood in
none. The counts cannot say whether it wrote a wrong total for them or none at all.

Per compaction:

| | Baseline, 45 compactions | L3, 45 compactions |
| --- | --- | --- |
| Output tokens, mean (range) | 998 (457–1736) | 1025 (461–2413) |
| `assault` output tokens, mean (max) | 1024 (1479) | 894 (1175) |
| `hospital` output tokens, mean (max) | 1467 (1736) | 1799 (2413) |
| Facts, mean | 14.4 | 14.0 |
| `assault`, `hospital` facts, mean | 17.3, 21.7 | 12.9, 24.4 |
| Seconds, mean (range) | 24 (8–119) | 32 (11–168) |

Output grew 23% on `hospital`, fell 13% on `assault` and grew 3% overall, where the plan expected 10 to 25%. The
largest compaction wrote 2413 of its 4096 tokens. OpenRouter picks a provider for each request, so the seconds say
little about the rule.

The cost. By the providers' `usage`, the baseline's 60 requests took 356,216 tokens, 307,842 in and 48,374 out, and
the candidate's 60 took 360,745, 311,009 in and 49,736 out. Together that is 716,961, against the plan's estimate of
about 600,000. In the ledger `openrouter-paid` stood at 88 requests and 615,782 tokens at 03:56 UTC, 149 and 991,593
between the sides, and 210 and 1,361,201 at 04:17, so the step took 122 requests and 745,419 tokens there. The
difference is one dropped connection a side, which the probe waited out and repeated. Each keeps its reservation in the
ledger: the recall of baseline run 2's `hospital`, 19,595 tokens, and the second compaction of L3 run 2's `chess`,
8,863. No other request used the channel during the step. At the prices the thinking entry below used, $0.08 to $0.15
a million in and $0.30 to $0.40 out, the six runs cost about $0.08 to $0.13. 2,638,799 of the day's 4,000,000 tokens
were left.

Conclusion: not accepted, the first of the three rejections in a row that stop the loop
([the rule](../improve-loop.md#stop-conditions)). The rule changed how Gemma writes a count, not what it keeps. It
wrote totals with their basis, and the pooled score stayed at 11 to 13 of 24 with the same keys lost. Four of the six
lost counts of two digits or more stood in memory on both sides and the recall misread them, as the thinking entry
below found with its switch off and on. Stage B did not run, so Ministral, mini and Haiku never saw the rule, and
O1-lite, which waited for L3's acceptance, falls away. The plan's two questions to the owner, Ministral's daily budget
and which model's row decides, stay open for the next step that reaches the main group.

Limitations:
- A screen on one model, which can only reject. Hosted Gemma stands in for the bot's heretic Q6_K
  ([acceptance](../improve-loop.md#acceptance-on-gpu)), and the log does not say which provider OpenRouter picked for a
  request.
- Three runs a side, one pack, `plain` only. A weaker model might still gain from the rule, and the screen does not
  ask.
- `stated` is a diagnostic, and a short number can match by chance. The fact counts are regular expressions over the
  facts' text, not a reading of it.
- Results: `$R/base-N.json` and `$R/l3-N.json` with their `.log` and `.err` files, `$R/usage-before.txt`,
  `usage-between.txt` and `usage-after.txt`, the patch `$R/l3.patch`, and the probes' directories under
  `$R/tmp/<run>/`.

<a id='memory-thinking-2026-09-27'></a>

## 2026-09-27 · Opus 5.5 · thinking while compacting, on hosted Gemma 4 31B

Not a step of the loop: a measurement the owner approved on 2026-09-27, and it accepts no change. The question: does
letting the model think while it compacts raise Gemma 4 31B's memory `score` on the scenarios built to separate
models? On [09-22](#scenarios-2026-09-22) the compactors that reason kept all of `hospital` through the same
increments, and every Gemma so far has compacted with thinking off. The scenes stay without it: a scene streams to the
reader, and thinking would delay its first word.

The switch. `MEMORY_THINKING=true`, off by default ([model-providers.md](../model-providers.md#memory-thinking)),
gives a compaction's request `thinking` and 12288 more output tokens, 16384 in `plain`. OpenRouter then gets
`reasoning: { enabled: true }`, llama.cpp `enable_thinking: true` without `reasoning_effort: 'none'`, and
simple-serving `enable_thinking: true`. The recall and the scenes never think. With the switch off every request is
what it was: the bodies of a `plain`, an `sgr`, a repair and a scene request through OpenRouter, OpenAI, Mistral,
llama.cpp and simple-serving, and the configuration under four settings, were compared byte for byte with c53a566's,
28 of 28 equal, and no test changed.

The smoke. One `chess` run with the switch on and, at first, a limit of 8192: OpenRouter took reasoning together with
the enforced schema, and the three compactions wrote 2062, 4249 and 2086 tokens with 3758, 9580 and 3296 characters of
reasoning, in 60, 84 and 44 s. The recall answered 6/7. One compaction used over half of that limit, and `hospital`
holds about twice the facts, so the limit was raised once, to 16384, before the measured runs.

Commands, from the repository, with `R=~/simple-story-chat-runs/2026-09-27/thinking` and N = 1, 2, 3. The three runs
of a side ran at once, and `npm run eval -- usage` ran before, between and after:

```
MEMORY_THINKING=true TMPDIR=$R/tmp npm run eval -- --pack ~/simple-story-chat-eval --scenarios chess --mode plain --models openrouter:google/gemma-4-31b-it --out $R/smoke-chess-on.json
TMPDIR=$R/tmp npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault,hospital --mode plain --models openrouter:google/gemma-4-31b-it --out $R/off-N.json
MEMORY_THINKING=true TMPDIR=$R/tmp npm run eval -- --pack ~/simple-story-chat-eval --scenarios assault,hospital --mode plain --models openrouter:google/gemma-4-31b-it --out $R/on3-N.json
```

The switch-off side ran at 23:32 UTC on 09-26. The switch-on command ran three times on 09-27: as `on-N` at 00:00 UTC,
`on2-N` at 02:31 and `on3-N` at 02:35. The first two measured nothing (below), and the third is the switch-on side.
Between the sides the code differs only in the stream guard of a thinking request, which no switch-off request
reaches.

Memory, mode `plain`, no judge:

| Scenario | Off, runs 1 · 2 · 3 | On, runs 1 · 2 · 3 |
| --- | --- | --- |
| `assault` | 8/12 · 8/12 · 8/12 | 8/12 · 9/12 · 8/12 |
| `hospital` | 4/12 · 4/12 · 5/12 | 3/12 · 5/12 · 4/12 |

- `assault`: off lost the same four counts in every run, `river_barriers`, `road_barriers`, `tunnel_barriers` and
  `river_stock`. On lost the same four in runs 1 and 3, and kept `road_barriers` in run 2. `river_barriers` stood in
  every memory of both sides, and the recall misread it.
- `hospital`: both sides lost `garden_cells`, `river_stretchers`, `boat_spare`, `next_departure`, `origin_evacuated`
  and `boris_learned` in every run. Off also lost `river_left` and `polina_learned` in two runs and `bridge_limit` in
  one; on lost `polina_learned` in all three, `river_left` in two and `bridge_limit` in one. Whenever `river_left`,
  `garden_cells` or `origin_evacuated` was lost, on either side, the number stood in the memory and the recall
  misread it.
- These are the production Q6_K's 8/12 and 4/12 on the same scenarios ([09-26](#route-a-2026-09-26)).

Per compaction, and per scenario:

| | Off, 18 compactions | On, 18 compactions |
| --- | --- | --- |
| Output tokens, mean (range) | 1198 (674–1642) | 4295 (2631–5581) |
| Reasoning characters, mean (range) | 0 | 7409 (4288–10295) |
| Seconds, mean (range) | 34 (8–60) | 110 (62–196) |
| Facts, mean | 17.7 | 24.3 |
| `assault`, `hospital`, seconds a run | 80, 137 | 301, 375 |

The first two switch-on attempts. On the first, the adapter cut four of the six cells: the compaction after scene 11
of `assault` in runs 1 and 3 and of `hospital` in run 2, and after scene 7 of `hospital` in run 3, each after 135 to
149 s. The code was `output_limit` from `events()` in `local/llama.ts`: the whole stream passed the adapter's guard of
2,000,000 bytes. It was not a `length` finish, which the probe gets as `invalid_memory` with
`memoryReason: output_limit` and retries. The finished thinking compactions wrote up to 5903 tokens in up to 127 s,
about 46 tokens a second, so each cut came at about 6000 to 7000 tokens, far below the limit of 16384: OpenRouter
streams a reasoning token as an event of its own, some 300 bytes. Those four 0/12 cells say nothing about memory; the
two cells that finished were `assault` 9/12 and `hospital` 4/12. The guard now grows for a thinking request only:
`streamLimit` in `local/llama.ts` gives its stream 2,000,000 bytes for every 4096 tokens of its limit, 8,000,000 at
16384, and every other request keeps 2,000,000. A synthetic stream of 3 MB passes with thinking and fails
`output_limit` without it, and the switch-off bodies stay equal to c53a566's. The second attempt was stopped by hand
70 s in, under the rule that any failed run ends it: run 3's `assault` had failed in 11 s with `provider_failed` in
phase `health`, the adapter's look-up of the model in OpenRouter's `/models` before anything is generated, which reads
as a passing failure. One thinking compaction had finished, 2344 tokens in 56 s. The third attempt ran whole, with no
failure and no retry.

The cost, as this measurement's own requests, since the ledger's days were shared:

| | Requests | Tokens by usage | Reserved, never settled |
| --- | --- | --- | --- |
| Smoke | 4 | 24,790 | |
| Off | 24 | 158,516 | |
| On, first attempt | 15 | 98,218 | 91,110 for the four cut requests |
| On, second attempt | 4 | 5,532 | 65,414 for the three stopped requests |
| On, third attempt | 24 | 222,367 | |

A request that fails keeps its reservation in the ledger, its input and 16,384. What the provider billed for the cut
and stopped ones is not known, and it is well below that. At the prices of the endpoints that take reasoning with a
schema and that OpenRouter prefers, $0.08 to $0.15 a million in and $0.30 to $0.40 out, a switch-off run cost $0.006
to $0.010 and a switch-on run $0.012 to $0.018, and the whole measurement about $0.09 to $0.13. In the ledger
2026-09-26 ended at 165 requests and 355,311 tokens, 28 and 183,306 of them this measurement's, and 2026-09-27 stood at
88 requests and 615,782 tokens at 03:35 UTC, 43 and 482,641 of them this measurement's. The rest of both days was
another agent's hosted checks with this tree's code.

Conclusion: thinking does not raise the memory score here. `assault` went from 8, 8, 8 to 8, 9, 8 and `hospital` from
4, 4, 5 to 3, 5, 4: one question once, inside the spread the rule asks a change to beat, with the same keys lost on
both sides. What stays lost is the accumulated counts, and several of them stood in the memory and were misread by the
recall, which thinking at compaction does not reach. The price is 3.6 times the output tokens and 3.3 times the
compaction time, for 37% more facts. The switch stays off.

Limitations:
- Hosted Gemma 4 31B is an optimistic stand-in for the bot's heretic Q6_K
  ([acceptance](../improve-loop.md#acceptance-on-gpu)). Here, with thinking off, it scored what the Q6_K scored, but
  after refusal removal and quantization the model follows the format worse, and nobody has seen the Q6_K think under
  the Gemma 4 grammar of the pinned llama.cpp. Only a card run, on the owner's word, can accept anything.
  `npm run eval -- --models gpu:<label>` with `MEMORY_THINKING=true` needs no code. The bot's own compactions do not
  read the switch, and its model socket refuses a limit above 8192, so `memory:probe` through the running bot's queue,
  the acceptance path, needs code first.
- OpenRouter picks a provider for each request, and the log does not say which. Endpoints capped at 8192 output
  tokens may drop out at 16384, so the two sides may have run on different mixes of providers and quantizations.
- Three runs a side, two scenarios, one pack. The switch-off side ran on 2026-09-26 UTC and the switch-on side on
  2026-09-27 UTC, both on the owner's 09-27. `sgr` was not run: its six runs did not fit the 600,000 tokens a day
  planned beside `plain`'s. `carnival` is in the holdout, which this session does not open.
- Results: `$R/off-N.json`, `$R/on-N.json`, `$R/on2-N.json` and `$R/on3-N.json` with their `.log` files, the smoke's,
  and the probes' directories under `$R/tmp/`.

<a id='route-a-2026-09-26'></a>

## 2026-09-26 · Opus 5.5 · route A against the Q6_K again, with the texts kept and three judges

Not a step of the loop, and the second measurement of simple-serving's contract step 6 after
[the first](#route-a-2026-09-25), whose texts a reboot took. The owner asked what route A's degradation consists of,
judged by Fable and Astra. One RTX 5090 in Korea ([the card](gpu-measurements.md#text-card-4-2026-09-26)) ran both
routes, and every probe kept its directory under `~/simple-story-chat-runs/2026-09-25/texts/<run>/tmp/`. Route A was
`serving:nvfp4`, simple-serving 899f36c with the fp8 cache, and then 5c9cd5e with Gemma 4's multi-token prediction.
The Q6_K was `gpu:q6k` with its draft model. A drafter changes neither distribution, since the model verifies every
drafted token, so the drafted runs count as more samples of their route. The public pack, mode `plain`, only
`hospital`, `assault` and `dance`. On vLLM `hospital` ran beside the other two; llama.cpp ran them one after another.

Memory and Opus's scene count, one pair per run:

| Scenario | Route A, fp8 · fp8 · with its drafter | Q6_K with its draft |
| --- | --- | --- |
| `hospital` | 3/12, 10/12 · 4/12, 8/12 · 4/12, 9/12 | 4/12, 9/12 · 4/12, 8/12 |
| `assault` | 8/12, 9/12 · 8/12, 10/12 · 8/12, 11/12 | 8/12, 11/12 · 8/12, 11/12 |
| `dance` in the passes | 13/13, 6/6 · 11/13, 6/6 · 12/13, 6/6 | 11/13, 6/6 · 11/13, 6/6 |
| `dance` alone | 13/13, 5/6 · 10/13, 5/6 · 13/13, 5/6 · 11/13, 6/6 | 13/13, 6/6 · 13/13, 6/6 |

- **The memory does not separate the routes on this card.** On `hospital` and `assault` both lose the same keys in
  every run, but for route A's one `bridge_limit` (8 bridge passes, not 6). On `dance` route A missed `b_clean` and
  `all_clean` in 3 runs of 7 and `cancelled_tango` in 2; the Q6_K missed `b_clean` and `all_clean` in 2 of 4, and
  `cancelled_tango` in none. Both readers below found the right 17 and 18 clean repeats of version B in every memory
  of both routes, summed to 34 and 78 in the answers, so the twins are lost in the reading, the same way on both
  routes. Every memory chain of both routes dropped the 40 cancelled tango repeats; the reader finds them only in
  scene 16, which stays whole after the last compaction.
- So [the first card's](#route-a-2026-09-25) three identical `dance` passes read better as one sample. Runs made the
  same way repeat at temperature 0.2: the Q6_K's two passes lost the same keys in all three scenarios, and its two
  `dance` runs alone found all 13 both times. Route A's runs, each with another request beside it on vLLM, varied.
  The first card's rule found route A worse on `dance`; on this card by the same rule it is not. Its mean memory on
  `dance` is 11.9 of 13 over 7 runs against the Q6_K's 12.0 over 4, and on `assault` and `hospital` its means stay
  within the spread of its own runs.
- **The scenes, by three judges.** Fable 5.1 and Astra judged copies of every run's trap scenes again (`eval judge`,
  which now takes `--pack`):

  | Scenario | Route A: Opus, Fable, Astra | Q6_K: Opus, Fable, Astra |
  | --- | --- | --- |
  | `assault`, 3 and 2 runs | 30, 32, 31 of 36 | 22, 23, 22 of 24 |
  | `hospital`, 3 and 2 runs | 27, 28, 27 of 36 | 17, 18, 17 of 24 |
  | `dance`, 7 and 4 runs | 39, 39, 40 of 42 | 24, 24, 24 of 24 |

  The three judges' counts differ by two questions at most. Route A lost `one_tunnel_barrier` and `two_tunnel_barriers` of
  `assault` in one or two runs of three, and `samira_corrected` of `dance` in two or three of seven, which the Q6_K
  kept in every run. The Q6_K lost `key_in_klim_pocket` and `order_explained` of `hospital` in both its runs, which
  route A kept in one of three.
- **What the texts show.** Fable 5.1 and Astra each read every run's memories, answers and trap scenes and compared
  the routes with quotes. They agree that both routes hold the same facts, and that route A loses in counting and in
  how firmly a scene refutes a false premise:
  - In the `mid_tunnel_stock` trap of `assault` route A lost count of the ampoules in two scenes of three, one of them
    left with «восемь целых ампул» after 14 less 4, 2 and 6. The Q6_K counted right in both of its scenes.
  - In the `samira` trap of `dance` route A's Samira refuted the false date softly or not at all in three scenes of
    seven, the Q6_K's plainly in four of four. Both readers call one of the three disputable.
  - Fable found three differences in the memory's own text, the same in every run of a route. In `assault` the Q6_K
    keeps a running stock after each event (12 and 14 lines with «остаток»), route A almost never (0, 1 and 0), and
    route A's answers about stocks and barriers land further from the truth, though both routes fail them. Route A
    writes a hyphen in 56 of the 105 ranges the story writes with an en dash, the Q6_K in none of 61. Route A writes
    «ё» for 1.3 to 1.4 per cent of е and ё, the Q6_K 4.2 and the story 7.8. The last two change no meaning; rarer
    tokens losing to common ones is what a coarser quantization would be expected to do, which was not tested.
  - The Russian is alike: 4 or 5 foreign or broken words a route in 102 and 64 trap scenes, route A's «amidst»,
    «事務» inside a word and «на десятогое», the Q6_K's «shouting» and «anlamно». Neither looped or broke off.
- **Speed.** Each route's drafter more than doubled its decoding of the memory: the Q6_K from 47.5 to 136 tokens a
  second on one slot, route A from 57–67 to 123–171 per request with two at once
  ([the card](gpu-measurements.md#text-card-4-2026-09-26)).
- **The owner's decision.** Route A stays, with multi-token prediction on: two requests at once at 123 to 171 tokens a
  second each, against the Q6_K's 136 on its one slot, are worth the small loss above. Route B does not follow on
  quality. simple-serving 15b969d turns the drafter on by default, 3 drafted tokens a step.

Limitations:
- Seven `dance` runs of route A and four of the Q6_K, two or three of the others; `battle` and `chess` were not run.
- The engine, the weights and the KV cache changed together. A bfloat16 cache for route A does not fit at this context
  on a 5090, so the cache's part stays unmeasured.
- Only the trap scenes are the model's own; the 16 scenes of each story are the frozen reference.
- `stated: memory` looks for the answer's digits anywhere in the memory, so for `cancelled_tango` it counts as a
  reading miss a number the memory never held: every chain dropped the 40, and a partial repeat's 40 matched.
- Results: `~/simple-story-chat-runs/2026-09-25/texts/`, a directory per run with its summary, progress lines and
  probes, `judged/fable/` and `judged/astra/` with the judges' copies, `judges.mjs` for the table, and the two
  comparisons, `astra-compare.md` and `fable-compare.md`.

<a id='route-a-2026-09-25'></a>

## 2026-09-25 · Opus 5.5 · route A against the production Q6_K, on one 5090

Not a step of the loop: nothing that shapes prompts or memory changed. This is step 6 of simple-serving's contract
(`docs/contract-v2.md` there), route A's quality against the llama.cpp baseline. Both routes ran on one rented RTX 5090
([the card](gpu-measurements.md#text-card-3-2026-09-25)), one after the other. Route A was `serving:nvfp4`:
simple-serving 899f36c's gateway in front of vLLM 0.30.0, with llmfan46's NVFP4 conversion of the heretic and an fp8
KV cache. Then `gpu:q6k`: llama.cpp b29c606 with the production Q6_K, a q8_0 cache and one slot. The public pack, mode
`plain`, judge `claude:claude-opus-5-5`, and the same sampling on both sides ([eval.md](../eval.md#own-card)). The plan
was one pass of all five scenarios, two more of `assault` and `hospital`, and two more of `dance` once route A's first
pass parted on it, the same on both routes. The Q6_K got its first pass only: the owner had to shut their machine down,
and the card was deleted during its second.

Memory, then scenes, one pair per pass:

| Scenario | Route A, NVFP4 on vLLM | Q6_K on llama.cpp | Q6_K on 2026-09-22 |
| --- | --- | --- | --- |
| `assault` | 8/12, 10/12 · 8/12, 10/12 · 8/12, 10/12 | 8/12, 12/12 | 8/12, 11/12 |
| `hospital` | 2/12, 9/12 · 2/12, 8/12 · 3/12, 8/12 | 4/12, 7/12 | not run |
| `battle` | 8/8, 15/15 | 8/8, 14/15 | 8/8, 15/15 |
| `chess` | 6/7, 4/4 | 6/7, 4/4 | 6/7, 4/4 |
| `dance` | 10/13, 6/6 · 10/13, 6/6 · 10/13, 6/6 | 13/13, 6/6 | 13/13, 6/6 |

- Memory at temperature 0.2 repeats itself. Route A missed the same facts on every pass, but for one `hospital` fact,
  `bridge_limit`, found once. A memory difference between the routes is therefore not noise between passes, while a
  scene difference of one question may be.
- `dance`: route A misses `b_clean`, `all_clean` and `cancelled_tango` on all three passes, and the Q6_K finds all 13,
  here and on 09-22. All three are numbers in a scenario built with twins: 35 clean repeats of version B and 35 good
  partial repeats, 40 cancelled tango repeats and 40 partial repeats, and `all_clean` is the sum 44 + 35. For
  `b_clean` and `cancelled_tango` the number stood in route A's memory and its reading answered something else
  (`readingMisses`); `all_clean` was not in the memory.
- `hospital`: route A also loses `current_route` on every pass and `bridge_limit` on two, which the Q6_K kept. Its
  scenes are one or two questions better, 9, 8 and 8 against 7.
- `assault`: both routes miss the same four counts in memory, those of 09-22. In the scenes route A misses
  `one_tunnel_barrier` and `prior_discussion_accepted` on all three passes; the Q6_K answered 12 of 12, and 11 on 09-22.
- `battle` and `chess` are the same on both routes, but for one `battle` question the Q6_K missed.
- On the compaction requests route A decoded 67 tokens a second and the Q6_K 47.5
  ([the card](gpu-measurements.md#text-card-3-2026-09-25)).

The rule, written down before the runs: route A is worse if its mean on `assault` and `hospital` falls below the
Q6_K's by more than the spread between passes, or if it drops on `battle`, `chess` or `dance`. It drops on `dance` on
three passes of three, so by that rule route A is worse. The rule's first half cannot be applied: the Q6_K has one pass
on `assault` and `hospital` here, and its spread is not known. [The next card](#route-a-2026-09-26) did not bear this
out: there the Q6_K lost `b_clean` and `all_clean` too, route A found all 13 in three runs of seven, and the three
passes here read better as one sample.

Limitations:
- The Q6_K has one pass on this card; 09-22's run on another 5090 is the second on four scenarios.
- The engine, the weights and the KV cache changed together. Route A's fp8 cache has no calibrated scale (1.0), where
  q8_0 keeps a scale for every block of 32 values. Which of the three costs `dance` is not known; route A with a bf16
  cache on the same scenarios would tell the cache apart.
- Only the failed keys are kept. The memories, the readings and the scenes were in the probes' directories under
  `/tmp`, and a reboot took them, so no other judge can read them; a new run keeps them elsewhere
  ([eval.md](../eval.md#own-card)).
- One judge, Opus 5.5.
- Results: `~/simple-story-chat-runs/2026-09-25/eval-cmp/`, `nvfp4-p1.json` to `nvfp4-p5.json` and `q6k-p1.json`, with
  the progress lines beside them.

<a id='gold-v1-2026-09-23'></a>

## 2026-09-23 · Fable 5.1 · the seed audited, and a gold tree grown by four writers under the agreement of four judges

Not a step of the loop: nothing in the prompts or the memory changed. The owner set the bar for a gold set: every scene
written by all four council models, admitted only when all four judges agree, and even then a candidate, since a fault
in a scene is often noticed only when a deeper scene is judged against it; gold comes from statistics kept over time.
Commits `b862e6b`, `9c1c900`, `f576811`, `24f950b`, `862f559`, `2b872b4`, `c9c985a`; described in
`docs/model-providers.md` ("The gold tree").

**The seed first.** `eval seed-audit` asks every judge for a seed's own contradictions and ambiguities, with quotes.
On `lighthouse` the four judges listed 23 issues: 22 ambiguities that several judges kept finding in the same places
(which clock the times follow, whether 21:10 starts or ends the flooding, whether the generator is running, whether the
spare canister is full, which side of the door the nail is on, who saw the boat, how the signal is given and whether
it repeats) and one "contradiction" that was phrasing (the road is still open at 20:30 while the seed said the
lighthouse is cut off until morning). The seed now says all of it: passable until 20:50, under water by 21:10, open
again about 05:40; the generator running since noon with 14 litres at 20:30 and 3 litres an hour; a full 20-litre
canister in a locked storeroom on the ground floor, its key on the nail to the right of the kitchen door; the panel's
`автомат/ручной` switch; three 3-second flashes given once, no reply, no radio to the post; the phone's clock right
and the kitchen clock at 20:23. The walks in the previous entry were measured on the seed before the audit. One
ambiguity the audit did not catch showed at depth 9: the seed does not say how deep the water on the spit is, so
when a scene had someone wade across, the two Codex judges read it as contradicting "cut off" and the two Claude
judges did not. The seed is not edited now, because the tree is pinned to the seed's hash; it goes on the list for
the next seed of this kind.

**The tree.** Two walks of one model differ in every scene, so a walk cannot say at which depth a model loses the
world. `eval walk-gold` grows a tree of scenes from the seed, in the bot's own shape (every scene has a parent), kept
next to the walk as `lighthouse.gold.json` with `lighthouse.gold.md` for a person, every scene nobody has read marked
so. At each depth all four writers continue the accepted prefix with the walk's next step (`local/walk-step.ts`, the
writer sees the whole prefix); the council reads each new scene against the seed and the prefix (`walk-judge.ts
--only`); the gate is the agreement of every judge, not the eval's majority: no findings in the first round, or none
that any judge still confirms in the second, the judge that listed it included, which may take it back; a judge with
no verdict is against. Of the agreed scenes the one with the fewest dissenters and findings becomes the trunk (a tie
goes to the writer with the fewest trunk nodes so far), the rest are branches; a rejected scene stays in the file
with the findings that stood against it, and its writer repairs it on the next attempt with those findings quoted as
an editor's note, up to four attempts. An agreed scene is a candidate. Every node keeps a ledger: deeper scenes judged
with it in their prefix (`seen`), findings against deeper scenes whose earlier quote stands in this node (`later`,
with whether they stood), issues of the whole-story audit (`gold-audit`: every judge reads the whole trunk at once),
fresh readings by the council (`gold-recheck`); `gold-promote` makes gold of a candidate with enough agreed rechecks
and enough deeper readings and nothing against it, `gold-stats` prints the numbers, `gold-read` records a person's
reading. `eval walk-nodes` is the eval over the tree: a model continues from the seed and from every trunk node
through its own compaction of the prefix, and the verdict comes with the depth. A judge whose probe failed enters no
ledger (`c9c985a`): its silence is the provider's, not a reading.

**`lighthouse`, grown overnight.** Writers and judges `claude:claude-opus-5-5`, `claude:claude-fable-5-1`,
`codex:gpt-6-astra`, `codex:gpt-6-sol`; four attempts per writer and depth; the first single-writer trunk (Opus 5.5,
eight nodes, two by repair) was discarded as an artifact when the owner asked for four writers. Grown between 01:00 and 02:23 on 2026-09-23 in three starts (the agreement gate and the ledger were committed
while it grew, the nodes kept each time): 63 nodes at 16 depths, four at every depth but the sixth, where a Fable
repair died on a provider timeout; the trunk reaches the walk's sixteenth step, the dawn summary. Trunk by depth:
Opus 1, 5, 9, 13, 16; Fable 2, 7, 10, 14; Astra 3, 6, 11, 15; Sol 4, 8, 12 (the tie-breaker keeps the writers even
until a depth where one scene is cleaner). 102 attempts were logged since the four-writer growth began, 68 of them in
the last start; 43 nodes were accepted at the first attempt, 19 by repair, one by a fresh third attempt; 24 attempts
were rejected. 62 of the 63 nodes were clean in the first round; one (Sol, depth 16) was admitted when the judge that
listed a finding took it back with the others. A depth took 1 to 9 minutes with four writers and four judges in
parallel, the whole tree 67 minutes of wall-clock. Per writer:

| Writer | Nodes | Accepted at the first attempt | Rejected attempts | Findings that stood against them | Of them about time | Characters per scene | Clock times per scene |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude:claude-opus-5-5` | 16 | 10 | 6 | 15 | 8 | 3366 | 2.8 |
| `claude:claude-fable-5-1` | 15 | 7 | 12 | 41 | 31 | 3186 | 2.3 |
| `codex:gpt-6-astra` | 16 | 14 | 2 | 4 | 2 | 1629 | 1.3 |
| `codex:gpt-6-sol` | 16 | 12 | 4 | 14 | 2 | 1454 | 1.4 |

The 74 findings that stood against rejected scenes: time 43, number 12, item 8, place 4, the author's step ignored 4,
knowledge, person and other 1 each; by judge Astra 27, Sol 19, Fable 16, Opus 12. After the trunk, every judge read the whole trunk at once (`gold-audit`, 19 issues, 4 of them contradictions,
on 9 of the 16 scenes: Opus 7, Fable 6, Astra 4, Sol 2) and the council read every node again, fresh
(`gold-recheck`: 63 nodes, every judging held, 61 agreed again; the two refusals are below).

What the numbers say:

- **Length is not scored, but every claim is.** The Codex writers write half the text of the Claude writers (1.4 to
  1.6 thousand characters against 3.2 to 3.4) with half the clock times, and lose 2 and 4 attempts against 6 and 12.
  The tree is not skewed by it, 16 nodes per writer (15 for Fable, one timeout), because a writer repairs until it is
  accepted, and the trunk went round the writers in turn, since 62 of 63 scenes were clean; the difference is the
  price of admission. Every time in a scene is a claim the judges check: 31 of the 41 findings against Fable are about time (a relative interval
  that does not match the clock, a log entry stamped before the event it records), and Fable was flagged by every
  judge, itself included (Astra 15, Sol 13, Fable 7, Opus 6), so this is not the Codex judges' strictness. Opus lost 4
  of its 15 findings on ignoring the author's step. The owner's decision: no penalty for length anywhere, consistency is
  the only measure; the one place length matters is the eval over the tree, where a model that says little contradicts
  little, and the rule on the author's step is the guard against saying nothing.
- **Step 14 (the key is not on the nail) rejected all four at the first attempt, and all four repaired at once.**
  The intervention was legitimate (scene 10 had hung the key back at 21:38); the errors were the writers' bookkeeping:
  a first-aid kit locked in the storeroom while it lay open on the table since scene 11, a lamp counted in the
  storeroom after Timur took it in scene 5, "thirty-eight minutes ago" that does not fit 21:38 at 22:11, a log entry
  at 22:09 for what happened after 22:10. The repair with the findings quoted worked every time here; over the tree 19
  of the 63 nodes came by repair, and one by writing afresh at the third attempt.
- **In practice the gate is a clean first round.** 62 of 63 nodes had no finding at all in the first round; one was
  admitted when the judge that listed a finding took it back with the others. The second round served the rejections:
  it decides which findings stand and are quoted back to the writer.
- **Whole-story reading finds what scene-by-scene reading let through**, which is the owner's reason for the ledger.
  The audit's contradictions: the key in Timur's pocket in scene 9 after scene 7 left it on the kitchen table (three
  judges, one as a contradiction, two as an ambiguity); a fire at the village seen at two kilometres while the same
  scene gives 200 metres of visibility (two judges); the radio kept in use after the generator stopped; "from nine
  you cannot cross" against the seed's 20:50. Its ambiguities: a second "storeroom" under the stairs that a reader
  confuses with the locked one (two judges), which door was opened and where the antenna lies (two), whether Sergey
  has his trousers on (two), a padlock in scene 14 against a mortice lock in scene 5, where the lamps are, what the
  post could see, what Marta knows about the crew. Every issue sits in its scene's ledger; under the promotion rule
  nine of the sixteen trunk scenes would stand barred as they are.
- **What the ledger holds so far.** 47 findings against deeper attempts pointed back at 8 earlier nodes, 46 of them
  standing after the cross round (in the cases read for this entry the deeper scene was at fault, which is what the
  gate expects; a person reads both kinds); the most read node was judged over 126 times.
- **The recheck measured the gate's noise: 2 of 63.** Every scene was read again by the four, fresh, with no silent
  judge, and 61 were agreed again. One refusal was a lone judge standing by a finding against the seed that the other
  three refuted (Sol, on the trunk scene of depth 8, which Sol itself had written); the other was a real contradiction
  the growth-time reading had missed and all four now confirmed (a branch of Opus at the same depth: a radio call at
  21:26 that the minutes of the previous scene do not allow). So a scene agreed once is refused on a fresh reading
  about one time in thirty here, half of it noise and half a miss; the thresholds of version 2 should ask for k of n
  rechecks rather than all, and count a lone insistence as noise.
- **The seed.** One ambiguity the audit had not named showed at depth 9: the seed does not say how deep the water on
  the spit is, so a scene with someone wading across was a contradiction of "cut off" to the two Codex judges and not
  to the two Claude judges. The rewritten seed was not audited a second time before the tree grew; the owner's
  decision: this tree is version 1, its scenes stay candidates and nothing is promoted; version 2 grows from a
  re-audited seed and is the one meant to become gold.
- Open, from the owner: the seed's size has never been varied (every synthetic seed is a page or two; `lighthouse` is
  4.7 KB, about 1200 estimated tokens, and the seed goes whole into every request, untouched by compaction, in a
  65 536-token window that compacts at 44 000). A tester's seed of 37 KB would take 15 to 20 percent of the window in
  every call. The next scenarios of the walk kind should come in sizes, the same world at about 5, 15 and 37 KB, one
  walk each with the council, to see whether the share of consistent scenes moves with the seed. Version 2 of the
  tree grows from a re-audited seed into the private pack; version 1 stays public, the owner's decision.
- Incidents: the growth was restarted twice while the gate and the ledger were committed, keeping the nodes; one Fable
  repair died on a provider timeout (depth 6 has three nodes); `c9c985a` keeps a silent judge out of the ledger, found
  while preparing the recheck. Under two eval runs the GPU test "video memory is sampled per card through one SSH
  session" times out at 120 s; it passes when the machine is quiet.

The plan for version 2 (a seed audited until clean, growth in width by the ledger, several gold paths, thresholds from
measured noise, private) is written in `docs/improve-loop.md`, "The gold tree, version 2". On the owner's order the branch was pushed to GitHub and the public dataset `Teadomi/simple-story-chat-eval`
to revision `d72c1b1374ed` (5 scenarios, the walk and its tree, 14 files); the uploader had to learn that a pack holds
walks and gold trees beside replay scenarios.

**Six models over version 1** (`walk-nodes --branches 4 --no-grow --max-path-tokens 54000`, the same council, 47 minutes,
20 tasks per model: the sixteen trunk steps and four branch continuations; the owner's order, the OpenRouter limit raised
by the owner for Gemma and Qwen). Consistent of decided: Sol 16/19 and Opus 5.5 16/20 (both on the council), Luna 7/16
with 4 splits, Gemma 4 31B 7/20, Qwen 3.8 27B 2/17 with 2 splits and one scene unjudged (Fable silent by timeout), Haiku
4.5 1/20; the run's score 0.05. The cap admitted every task: the longest prefix is 12 524 `o200k_base` tokens, the seed
alone 882. Every model lost trunk depth 8 and five of six depth 5, both on time across the scene boundary: the trunk's
scene 7 (`g24`, Fable) is stamped 21:24 and narrates several minutes more, and every scene 8 sets its clock at 21:24 to
21:26; scene 5 (`g17`, Opus) records 20:54 and 20:59, and the depth-6 continuations go back to 20:52 or 20:58. The run
wrote 271 `later` entries into the ledgers of 19 nodes, 259 of them confirmed; `g17` collected 60 (59 confirmed), `g24`
41 (41). Findings against the weakest writers are many and confirmed (Qwen 119, Haiku 110), against the council members
few (Sol 5, Opus 9). Open: whether minutes narrated past a scene's own stamp are a fair test or something the seed's
clock rule should say; that belongs to the seed of version 2. The results are in the public README; the pack (the tree
with the new ledger, 14 files) was pushed to revision `229ac84a1956`.
The owner asked for a chart of the run in the public README and chose between two drawn from the same extracted numbers,
one by this session (an SVG rasterised with ImageMagick) and one by an Opus subagent (matplotlib in a scratch venv); the
Opus one, `lighthouse/nodes-v1.png`, went into the pack and the README at revision `6be9e2a2c061`. The hub keeps images in
LFS, so `pack-hf push` learned that flow (preupload, LFS batch, the blob by hash, `lfsFile` in the commit) and carries
`png` and `svg` beside JSON and Markdown; the chart sources and the extracted numbers are archived with the run.

<a id='walk-2026-09-22'></a>

## 2026-09-22 · Fable 5.1 · the walk: the model writes its own story, and a council of four reads every scene

Not a step of the loop. The owner redirected the day's task: what matters is consistency, not details, and the eval
should judge every step, not only the final answers. The subject gets a seed and writes the world bit by bit; at each
step it receives either the bot's own "continue" signal or an outside intervention (an event the author states) and goes
on; afterwards a council of the strongest models judges every stretch, because one judge may be biased. Built as
`npm run eval -- walk` (commit `c535515`): `local/walk-probe.ts` writes the walk with the production narrator prompt and
the replay's compaction schedule (after scenes 7, 11 and 15, four scenes kept), `local/walk-judge.ts` is one judge,
`local/walk-panel.ts` holds the pure parts with tests. Two rounds: each judge reads a scene against the seed and every
scene before it and lists contradictions with quotes (a listed contradiction is an inconsistent verdict whatever the
flag says; an inconsistent flag without one abstains); then every finding goes back to every judge, the finder
included, to confirm or refute by the text, and a finding stands when more judges confirm than refute it. A scene with a
standing finding is inconsistent, a scene whose findings were all refuted is consistent, a tie is `split`. `score.walk`
is the share of consistent scenes for the worst model; `score.votes` the same from the first round's majority alone. The
judge sees the story a reader sees, not the subject's memory; the memory increments stay in the report for a later
layer. Described in `docs/model-providers.md` ("The walk").

Calibration on `lighthouse` (`examples/walk/lighthouse.json`, public: a storm night on a lighthouse cut off by the
tide; seed and 16 steps by Fable, six interventions at steps 3, 6, 9, 12, 14 and 16, the last a dawn summary). Panel:
`claude:claude-opus-5-5`, `claude:claude-fable-5-1`, `codex:gpt-6-astra`, `codex:gpt-6-sol` (Sol 6 answers through
the Codex subscription since CLI 0.156.0; the paid API is not used). One walk per model, late evening:

| Model | Council: consistent / split / inconsistent | First round, consistent per judge (Opus, Fable, Astra, Sol) | Findings: listed / confirmed / refuted / disputed | Kinds |
| --- | --- | --- | --- | --- |
| `claude:claude-haiku-4-5-20251001` | 5 / 0 / 11 of 16 | 4, 6, 5, 4 | 115 / 83 / 18 / 14 | number 41, time 38, item 11, knowledge 11, place 7, other 7 |
| `claude:claude-opus-5-5` | 7 / 1 / 8 of 16 | 8, 8, 5, 11 | 39 / 26 / 8 / 5 | time 20, knowledge 7, place 5, number 4, other 3 |

What the numbers say:

- Both are far below the ceiling, and the frontier is at the level the owner asked for: Opus 5.5 keeps 7 scenes of 16
  consistent, Haiku 5. The gap between them is small in scenes and large in findings (26 confirmed against 83) and in
  kind. Haiku breaks the seed's numbers in scene 1 already (110 steps for 112; the lagging clock read as running ahead),
  fits fifteen scenes into 42 minutes of story time, and ends with a dawn dated the same day and "47 litres burned, 41
  left" from a 14-litre tank and a 20-litre canister. Opus keeps the clock (20:30 to 23:21, dawn on the next date); its
  standing findings are bookkeeping: a log entry whose interval ends before the event it records, "ten minutes at the
  window" that the previous scene's timing does not allow, a fuel gauge that stands at the neck after the canister had
  brought it to just above half, and two things a character says that earlier scenes contradict.
- The council moves single verdicts both ways. On Haiku's scenes 5, 13 and 15 one judge's lone finding was refuted by
  the other three, and the scene stands as consistent. On Opus's scene 11 all four judges had flagged the same clock
  reading in the first round, and on re-reading three of the four refuted it (time passes within a scene; only Opus the
  judge insisted). Opus's scene 16 is split 2:2 on whether «полшестого» is a rounding of 05:40. In scene counts the
  council and the first-round majority agree here (5/16 and 7/16); the second round changed which findings stand, not
  the score.
- The judges differ in strictness on the stronger story: Sol 6 the most lenient (11 consistent of 16 on Opus), Astra
  the strictest (5), Opus and Fable between (8 and 8); on Haiku all four are close (4 to 6). The first round was
  unanimous on 11 of Haiku's scenes and 8 of Opus's. A contradiction found by three judges is three findings, so the
  finding counts overstate distinct errors by up to the size of the panel.
- Time: Haiku's walk 14 minutes, Opus's 8 (earlier in the evening Opus ran at about 90 seconds per scene under load);
  the four judges' two rounds about 15 minutes per walk, in parallel. One incident: the first Opus walk died at its
  first compaction with `ENOSPC`, the root filesystem was full for a few minutes; the probe saves its report after
  every step, a cut-off report is not resumable, and the walk was rerun.
- Open: the spread between two walks of the same model (the story differs each run; `docs/improve-loop.md` asks for
  several walks per side), and whether a memory change shows on the walk at all. A hidden walk, `quince`, was written
  by an Opus agent straight into the holdout (16 steps, 7 interventions at steps 3, 6, 8, 10, 12, 14 and 16, three of
  them the first scene after a compaction); this session has not read it. Nothing was pushed to Hugging Face.

<a id='scenarios-2026-09-22'></a>

## 2026-09-22 · Fable 5.1 · three scenarios built to separate, and a scale of models on them

Not a step of the loop: nothing in `local/` that shapes prompts or memory was changed, and no decision on a prompt
is taken here. The owner's task for the day: the benchmarks should trouble the frontier models too, not only Gemma,
and we need a scale to know how far the story system can still go. This entry is that scale.

Two scenarios of one design: `assault` in the public pack (`~/simple-story-chat-eval/assault/`, JSON pack format,
not in `examples/`) and `carnival` in the holdout (its content is not described here). Each: 12 checks, 9 of them
numbers or clock times that accumulate or change across the three compactions; 10 traps, 4 of them mid-story; 12
judge questions, 6 expecting `yes` and 6 `no`. Seeds, turns, checks and traps were designed by GPT-6 (`gpt-6-astra`
through Codex, `high`) from a written brief and checked by Fable, who re-derived every answer from the turns; the
16 scenes of each by a clean Opus 5 agent from a per-turn ledger (what the scene must state, what it must not);
`authors` lists all three. `ceiling` with `openai:gpt-5.4` answers 12/12 on both, so every check is readable from
the text.

The scale. Mode `plain`, judge `claude:claude-opus-5-5`, one run per cell, memory / scenes. The `hospital` column
is the third scenario, designed later in the day (below):

| Model | `assault` | `carnival` | `hospital` |
| --- | --- | --- | --- |
| `mistral:ministral-14b-2512` | 8/12, 8/12 | 8/12, 10/12 | 2/12, 9/12 |
| `gpu:gemma-4-31b-heretic-q6k` (the production build, through the tunnel) | 8/12, 11/12 | 8/12, 11/12 | not run (the card was gone) |
| `openrouter:google/gemma-4-31b-it` | failed `unauthorized` | 10/12, 12/12 | not run (channel stopped) |
| `openai:gpt-5.4-mini` | 10/12, 10/12 | 8/12, 7/12 | 2/12, 6/12 |
| `claude:claude-haiku-4-5-20251001` | 11/12, 10/12 | 12/12, 12/12 | 8/12, 9/12 |
| `claude:claude-sonnet-5` | 12/12, 12/12 | 12/12, 12/12 (second run) | failed, 3 of 3 (compaction) |
| `claude:claude-opus-5` | 12/12, 12/12 | not run | not run |
| `claude:claude-opus-5-5` | 12/12, 12/12 | 12/12, 12/12 | 12/12, 10/12 |
| `claude:claude-fable-5-1` | 12/12, 12/12 | 12/12, 12/12 | 12/12, 10/12 |
| `codex:gpt-6-astra` | 12/12, 12/12 | 12/12, 12/12 | 12/12, 12/12 (its own design) |

- Every memory miss of the small models is an accumulated count: on `assault` the barriers per site and the stock
  that only decreases (all four for Ministral and the local Gemma, two for `gpt-5.4-mini`), on `carnival` four
  counts of the same kind. Nobody misses a location, a holder or a "who learned what when" question. This is the
  holdout finding of 09-18 again (sums across increments), now on a public scenario where it can be debugged.
- The production build on the three older scenarios, same judge: `battle` 8/8 and 15/15, `chess` 6/7 (the known
  ceiling) and 4/4, `dance` 13/13 and 6/6. Saturated, as recorded on 09-20. `sgr` on the two new scenarios:
  `invalid_memory` (quote) for the production build, as in every earlier entry.
- The judge: the first cells were judged by Opus 5 and all of them were judged again by Opus 5.5 after the owner
  asked for it; the only verdict that moved is Ministral's `carnival` scenes, 9 to 10. Opus 5.5 judges its own
  scenes and Fable's, so the 12/12 scene rows at the top are not an independent measurement.
-  Failures. Haiku through the Claude CLI failed at the recall call after the third compaction on both scenarios, 2 of
  2; the CLI's own verdict was not being logged, so `cliResult` and `cliError` were added to the log whitelist
  (07ee814). The cause turned out to be the runner's recall cap (`hospital`, the ceiling, below); the Haiku cells
  above are from the runs after the fix. Sonnet through the CLI fails at a compaction now and then: once on `carnival`
  (the repeat passed) and three times of three on `hospital` (at the third, the second and the second compaction).
  Every failed Sonnet compaction ended after 171–199 s with an empty result and, where the field was already logged,
  `stopReason: stop_sequence`; every successful one (13 today) ended within 126 s. A failed compaction fails the cell;
  the runner does not retry a compaction. The OpenRouter key reached its $2 limit during the hosted Gemma cell of
  `assault`; that channel was stopped and the limit was not raised.

Conclusion: the two scenarios separate the small models from the frontier, and they separate nothing at the top:
five models sit at 12/12 and 12/12 on both. A scale with no room above the production model's target is not a
scale, so a third scenario, `hospital`, was designed by GPT-6 at `max` to defeat a careful compactor without
overflowing the fact limit: dependent quantities carried across all three compactions, a cuff marking that stands
for membership in the original group and survives transfers, two clocks with constant offsets that are swapped
mid-story, two identical keys from two hooks that are exchanged, a route that returns to its first value through
sheet bookkeeping, the scope of a refutation and a later partial restoration, and negative knowledge from an
exhaustive list of recipients. Same shape as the other two: 12 checks, 10 traps, 6 `yes` and 6 `no`. Fable
re-derived all 12 answers by hand; the design is in the public pack (`hospital/scenario.json`, `authors`
`gpt-6-astra`, `fable-5.1`, `opus-5`); the 16 scenes by a clean Opus 5 agent, re-read by Fable against all 12
checks and the four mid-story traps.

`hospital`, the ceiling. `openai:gpt-5.4` in one pass with reasoning off (143 output tokens, no reasoning) answers
6/12: the six it misses are the deep derivations (the ward's current count, the garden batteries, free boat seats,
the departure time, the evacuated originals, the minute Polina learned). Through the Claude CLI, Opus 5.5 and
Fable both failed the same call with `provider_failed`, and the new fields said how: `cliResult: success`,
`cliError: true`, exit code 1, after 24–44 s of generation. The recall request asked for at most 1024 output
tokens; the CLI adapter passes that number as the run's whole output cap, and a model that reasons in text before
its structured answer is cut off there, which the CLI reports as an error, not a truncation. Every Haiku recall on
the two new scenarios had failed at the same call. Change (`ab9acfc`): the recall cap is 8192, and a failed CLI row
carries `stopReason`. A model that answered within 1024 gives the same answer, so the cells above stand. With the
cap raised, Opus 5.5 answers 12/12 over the full text in 24 s and Fable 12/12 in 33 s: the scenario is readable,
and hard to read without reasoning.

`hospital`, the scale (the column in the table above). The small models collapse: Ministral and `gpt-5.4-mini` answer
2 of 12 checks each (Ministral keeps `origin_evacuated` and `uninformed`, mini `river_stretchers` and `uninformed`).
What is lost is everything derived across the compactions, not only the counts as on the other two scenarios: the
holder of the key, the current route, the departure time, the minutes at which Polina and Boris learned. The frontier
does not collapse: Opus 5.5, Fable and GPT-6 answer 12/12 through the same pipeline, so the scenario that `gpt-5.4`
cannot read in one pass without reasoning is still remembered whole by a compactor that reasons. Haiku answers 8/12:
it loses the four derived counts (`river_left`, `garden_cells`, `boat_spare`, `origin_evacuated`) and keeps the
holder, the route, the times and who learned what, between the small models and the frontier as on `assault`. Sonnet
has no cell: three runs, each ended at a compaction with an empty result (the failures bullet above). Scenes: GPT-6
12/12 (it designed the scenario and its traps, so this is the least independent cell of the day), Opus 5.5 and Fable
10/12, both missing the same two questions on both judgings.

The two questions the frontier misses, read against the scenes (synthetic, in the run directories). `key_fetched`
follows turn 9: Klim is to open the battery cupboard with a key he expects to find on himself, while the right key is
with Evdokia; the question expects the scene to show her handing it to him. The two small models fail it with real
errors: Ministral's Klim finds two keys in his own pocket, mini's Agata takes the key off the hook it left at 23:00.
Opus 5.5 and Fable both have Klim find nothing, which is right; then Opus leaves the cupboard closed and Fable has
Evdokia open it herself and keep the key. Consistent scenes that resolve the turn differently from the designed
handover; only GPT-6 wrote the handover. `garden_lamp_lit` is the last trap, an allowed action: Evdokia puts one spare
Garden battery into a separate working lamp, expected `yes`. Both Claude scenes do exactly that, and both name the
batteries on the windowsill as the ones brought from the River ward after 03:05, which is where the Garden's spare
stock came from (turn 15); the judge read "a Garden battery" as origin rather than stock and answered `no` twice for
each. So of the four frontier scene misses on `hospital`, two are the judge's reading and two are a resolution the
question does not accept; none contradicts the world. Haiku's three misses: `key_in_klim_pocket` is a real error (at
04:02 the key comes out of Klim's pocket, and he has none), `order_explained` has Klim, who knows the new place, tell
Boris instead of Polina (consistent, not the designed teller), and `garden_lamp_lit` is the same reading again, with
the battery taken from the reserve cupboard and no ward named. One Haiku scene runs past its end into a fabricated
next author turn in the request's JSON syntax; the judge's question did not touch it. The table keeps the judge's
numbers; the reading is recorded as a limitation in the pack's README.

Spread of the judge: every `hospital` cell was judged twice by Opus 5.5 from the same scenes. Ministral 9 and 9, mini
6 and 5, Opus 5.5 10 and 10 (the same two questions), Fable 10 and 10 (the same two), GPT-6 12 and 12, Haiku 9 and 9.
One judging of Haiku's `carnival` scenes ended with the CLI reporting an API refusal (`stopReason: refusal`) and
scored 0/12; the repeat scored 12/12. A judge call that fails looks like a bad scene score, and only the log says
which it was.

Where the scale stands at the end of the day. Below the frontier the three scenarios order the models the same
way, and `hospital` spreads them furthest: 2/12 for the small hosted models against 12/12 at the top. Above the
production model's 8/12 on `assault` and `carnival` (its `hospital` cell needs a card) the whole distance to
12/12 is real, because a compactor that reasons keeps all of it through the same increments and the same 4-scene
window. A memory limit of the frontier was not found today: `hospital` is hard to read in one pass without
reasoning, and it is not yet hard to remember for a compactor that reasons. The next scenario that separates the
frontier has to defeat the compaction step itself, not the reading.

Limitations:
- One run per cell; no temperature control on the CLI models (Claude CLI and Codex run on subscriptions and
  report no token counts).
- The production build was not measured on `hospital`: the card was deleted before the scenario existed, and a
  new rental needs the owner's yes. GPT-6 designed `hospital` and is also measured on it.
- Results are outside the repository: `~/simple-story-chat-runs/2026-09-22/*.json` (run summaries) and the
  re-judge lines in `rejudge-opus55.jsonl`.
- The local runs went through a rented card that was deleted at 17:07 UTC; the instance list was empty afterwards.
- This session opened the holdout to write `carnival`, so it does not run the loop; the next step of the loop
  belongs to another session.
- Beside the eval, the production build described the 24 frames of the pictures run `run24` through the same
  tunnel (`exports/illustrations-2026-09-21/run24-local/`): the descriptions match the hosted Gemma's in length
  and in the counts the probe logs; nothing was drawn, because no picture card was rented that day.

<a id='qwen-comparison-2026-09-20'></a>

## 2026-09-20 · Opus 5 · Qwen3.8-27B as a replacement for Gemma 4 31B (decision open)

Not a step of the loop: nothing in `local/` was changed and the main group was not run. The tester proposed the
model and this is the measurement that answers whether it is worth a rental. What draws us to it is not its
scores: Qwen3.8-27B is a hybrid, `full_attention_interval: 4`, so only 16 of its 65 blocks carry a KV cache, and
its Q6_K weights are 22.1 GB against Gemma's 25.2. That is the shortage that fails threshold 7 in
[gpu.md](../llama-measurement.md#thresholds). Its GGUF declares the architecture `qwen35`, which the pinned llama.cpp revision already knows.

Run: `--models openrouter:qwen/qwen3.8-27b,openrouter:google/gemma-4-31b-it --judge claude:claude-opus-5`, the
three open scenarios, both modes, both paid channels. One run per cell.

Recall, per cell. The ceiling of `chess` is 6/7 for every model (see improve-loop.md), so both models are **at the
ceiling** there:

| scenario | ceiling | Qwen3.8-27B | Gemma 4 31B |
| --- | --- | --- | --- |
| battle `plain` | 8/8 | 8/8 | 7/8 |
| chess `plain` | 6/7 | 6/7 | 6/7 |
| dance `plain` | 13/13 | 13/13 | 12/13 |
| total `plain` | 27/28 | **27/28** | **25/28** |

Qwen reached the ceiling in all three; Gemma missed by one in two of them. The known spread for Gemma on `battle`
is one question, and it showed itself inside this day: an earlier run of the same cell gave 8/8 and this one 7/8.
Two questions out of 28 is therefore **not a difference**.

`sgr` carries no information here. Both models failed two cells of three, in different places — Qwen `battle` and
`chess`, Gemma `battle` and `dance` — with `invalid_memory` and one Gemma timeout. A failed cell counts as 0/N, so
the aggregate 0.46 against 0.21 is a count of failures. `sgr` fails for every model on the `quote` check, which is
already in this log; decisions stay on `plain`.

What did repeat in every single cell is the size of what Qwen writes:

| | Qwen | Gemma | |
| --- | --- | --- | --- |
| facts stored | 199 | 149 | +34% |
| memory bytes | 55 028 | 36 762 | **+50%** |
| output tokens | 32 672 | 19 900 | +64% |
| cost of the compactions | $0.065 | $0.012 | ×5.4 |

This is not noise, and it works against the reason we looked at the model at all: memory is re-sent with every
request, so a memory half again as large eats the cells that the hybrid cache was supposed to free. How much of
the saving it eats is arithmetic we cannot do from here.

Decision: **open**. Nothing here argues for a switch, and nothing here argues against one. What would close it is a
rental: the measured cost of a cell, whether a prefix is reused at all in a hybrid model — the scheduler, the slot
pool and compaction-ahead all rest on that — and speed. A quality result cannot close it, because the two models
are indistinguishable on the measure.

Limitations:
- One run per cell. The loop asks for at least three per side on one scenario; this is below that bar.
- OpenRouter routes freely and we do not pin quantization. A model served at fp4 against one served at bf16 would
  show a difference that is not the model's.
- Both models here are the **official** ones. Production runs an uncensored Gemma, and the tester's candidate is an
  abliterated Heretic build of Qwen. Bases were compared, not the builds that would be deployed.
- `sceneScore` is reported only over the worst model, so scene quality could not be split between them. Its value,
  0.36 on `plain`, says something about our prompts rather than about either model.
- 887 808 tokens on `openrouter-paid`, about $0.29.

<a id='story-language-2026-09-19'></a>

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

<a id='paragraph-limit-2026-09-19'></a>

## 2026-09-19 · Fable 5.1 · «не более 12 абзацев» ("no more than 12 paragraphs"): a number, a principle or nothing (no change)

The tester's hypothesis: the limit named in SYSTEM, «Пиши не более 12 абзацев» ("Write no more than 12 paragraphs"), makes the model fit the length to the number; without the number the model will focus on the scene. Variants: `base` (as is), `principle` («Объём сцены определяй по тому, что в ней происходит: короткий ход — короткая сцена, поворотный — подробнее. Не дописывай ради объёма; заканчивай там, где автору есть на что ответить» — "Decide the length of a scene by what happens in it: a short move gets a short scene, a turning-point move gets more detail. Do not add text for the sake of length; end where the author has something to answer"), `none` (the phrase is removed). Three worktrees, `npm run eval --mode plain --judge claude:claude-opus-5` on the main group, then a repeat on the paid Gemma; not checked on the GPU.

Length of trap scenes, paid Gemma (OpenRouter), two runs: `base` 44 scenes, median 1922 characters, maximum 2507; `principle` 44, 1890, 2750; `none` 34, 1961, 2610. For `gpt-5.4-mini` and Ministral, without the number the median grows by 1–2 paragraphs and tails of up to 21–28 paragraphs appear, against 17–19. No scene out of 230 was cut off by the token limit. Traps on Gemma: 49/50, 50/50, 38/40 — no difference; for the other models the difference is within noise. Incomplete cells: Ministral hit the daily limit (three runs shared 500 thousand tokens), Haiku and, twice, Gemma failed with `provider_failed`.

Decision: do not change the prompt. The number does not pull the length up: the models write their usual length (about 2000 characters) with any wording, and «не более 12» slightly holds back the tails and is broken in a third of the scenes. The principle is harmless, but it gave no measurable effect. Limitations of the measurement: all trap moves are similar in size, so it is not visible whether the model writes shorter for a short move — this is a separate measure; length is not part of the acceptance measures (`score`, `sceneScore`), so by the rules of the loop such an experiment cannot end in acceptance; the definition of a paragraph moves the share of "longer than 12" by 10 percentage points and must be fixed before the next measurement. The critique of the eval and the plan to speed up experiments are in [eval-experiments-plan.md](../eval-experiments-plan.md) and [eval-economics-proposal.md](../eval-economics-proposal.md).

<a id='narrator-rule-2026-09-19'></a>

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

<a id='stated-2026-09-18'></a>

## 2026-09-18 · Fable 5.1 · the measure "is the answer stated in the memory" (idea N from `storyworm-ideas.md`)

A change to the eval (`local/memory-probe.ts`, `local/eval.ts`): for a numeric answer the probe, without a model, marks `stated: memory | scenes | none`, and `eval` collects `readingMisses`. Check on the working tree with counters, `gpt-5.4-mini`, `dance`: 13/13, the totals per version are `memory`, the overall total of clean repeats is `none` (the model added it up itself), `readingMisses` is empty. Purpose: when fixing the counters, to tell "the summary is wrong or incomplete" from "the summary is right, the model did not read it"; on the base code without a summary, the sums of the holdout pack must give `none`.

<a id='judge-2026-09-18'></a>

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

<a id='holdout-2026-09-18'></a>

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

<a id='counters-2026-09-18'></a>

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

<a id='traps-2026-09-18'></a>

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

<a id='frozen-baseline-2026-09-18'></a>

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

<a id='invalid-deepseek-baseline-2026-09-18'></a>

## 2026-09-18 · Fable 5.1 · the frozen DeepSeek story contradicts the reference

All numbers below this entry were obtained on `battle` recorded by `deepseek-v4-flash:free`, and they are useful only as a history of debugging the eval.

- The hypothesis "a move that contradicts a fact is not carried out silently" (a change to `SYSTEM` in `local/prompt.ts`) did not move `dagger_source` for any model. The analysis showed that the trap is at fault: by the author's design Tarek has the dagger, but in the recorded scenes DeepSeek returned it to Elin, and the memory of the models honestly stores this. The hypothesis is not tested, the change is rolled back; try the diff again on a correct story.
- In the same scenes, after the second use of the seal the text says «осталось пять зарядов» ("five charges remain") while the reference is 3. The questions `charges` and `next_use` punished the model for being faithful to the text.
- The new command `npm run eval -- ceiling --model <model>` asks the questions on the full story without compaction. `gpt-5.4` scores 8/8 (it resolves the contradiction by the author's messages), `gpt-5.4-mini` scores 5/8, missing `charges`, `next_use`, `sava_learns`: exactly the keys that it "lost" with the memory. That is, its failures were errors of reading a contradictory text, not of the memory, and the spread from the entry below comes largely from this.
- The recording of `chess` by the same DeepSeek failed five times in a row at compaction with `invalid_memory`.

Decision (replaced by the entry above: the scenes were written by Fable agents): the author of the frozen scenes is `claude:claude-haiku-4-5-20251001`, all three scenarios are rewritten. A story is accepted only if the `ceiling` of a strong model is the maximum, and the facts of the traps are checked against the text of the scenes, not against the author's messages. The previous `battle.json` is saved outside the repository.

<a id='first-scene-eval-2026-09-18'></a>

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

<a id='noise-2026-09-18'></a>

## 2026-09-18 · Fable 5.1 · spread on the same code

Three `plain` runs on `battle` without a single change between them (the first is from the table below):

| Model | 1 | 2 | 3 |
| --- | --- | --- | --- |
| `openrouter:google/gemma-4-31b-it` | 7/8 | 6/8, misses `news`, `sava_learns` | 7/8, misses `sava_learns` |
| `mistral:ministral-14b-2512` | 8/8 | 8/8 | 8/8 |
| `openai:gpt-5.4-mini` | 6/8 | 8/8 | 5/8, misses `charges`, `next_use`, `sava_learns` |

`score` per run: 0.75, 0.75, 0.625. Conclusion: on one scenario of 8 questions the spread of `gpt-5.4-mini` reaches three questions (it has the default temperature, not 0.2), and the spread of Gemma is one question. A shift of `score` by 0.125 and even by 0.25 in one run means nothing. While there is only one scenario, compare a change over at least three runs per side and look at the sum over the runs, not at the minimum; it is more reliable to first record `chess` and `dance`, so that there are 24 questions. Only the `sava_learns` failure is stable: Gemma 3 out of 3, `gpt-5.4-mini` 2 out of 3, Haiku 1 out of 1.

<a id='schema-2026-09-18'></a>

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
