# Improvement log

Every step of the loop from [improve-loop.md](improve-loop.md): date, hypothesis, change, numbers before and after per model, decision. Rejected hypotheses are recorded too. New entries go on top.

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

## 2026-09-20 · Opus 5 · Qwen3.8-27B as a replacement for Gemma 4 31B (decision open)

Not a step of the loop: nothing in `local/` was changed and the main group was not run. The tester proposed the
model and this is the measurement that answers whether it is worth a rental. What draws us to it is not its
scores: Qwen3.8-27B is a hybrid, `full_attention_interval: 4`, so only 16 of its 65 blocks carry a KV cache, and
its Q6_K weights are 22.1 GB against Gemma's 25.2. That is the shortage that fails threshold 7 in
[gpu.md](gpu.md). Its GGUF declares the architecture `qwen35`, which the pinned llama.cpp revision already knows.

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
