# Measuring a llama.cpp profile

How to compare llama-server profiles on a rented card (slots, a shared pool, the draft model), and the thresholds the
owner agreed for choosing one. This is a working instruction while the `llama-cpp` provider is in use. The server
comes from [llama-cpp.md](llama-cpp.md#prepare-server), a rental follows
[the owner's rules](gpu.md#while-the-cards-are-paid-for), and the one comparison so far, on 2026-09-20, is in
[gpu-measurements.md](knowledge/gpu-measurements.md#pool-2026-09-20). The method was moved here from gpu.md on
2026-09-25. Its one edit is the link to the RX 580 numbers, which moved to the knowledge page.

## Measurement session

<a id='compare-profiles'></a>

`npm run gpu:measure -- --profile <name>` measures one running server profile and writes
`measurements/<name>/report.json`. `npm run gpu:measure -- --decide measurements` compares saved reports.
Run it only during an authorized GPU session. Reports contain counts, timings and fixture hashes, never story text.

Start with `npm run gpu:measure -- --smoke --profile smoke-<name>`. This runs one small case, one cold call and one
warm call, without reading pauses, agents or probes, under a two-minute budget. It prints the observed cache states
and exits unsuccessfully unless they are `cold` then `warm`. This checks the running server's treatment of
`cache_prompt:false` and subsequent reuse before committing to a full measurement. The default target is 4,000;
`--history-tokens` may choose a smaller target and `--fixture` may choose one fixture. Smoke results do not choose a profile.

The workload uses `makeRequest` and the checked-in synthetic stories in `examples/frozen/`. The default is `battle`;
`--fixture chess`, `--fixture dance` and `--fixture all` select the others. Whole frozen scenes are repeated until the
server's real `countInput` reaches the largest complete history below each target: about 4,000, 24,000 and 43,000
input tokens. The report records the actual count, scene count, request hash, fixture hash, and the fixture's minimum
and maximum scene lengths. This is a performance replay; repeated scenes do not test story consistency.

The selected `compactAtTokens`, memory mode and kept-scene count are recorded. A target at or above the configured
compaction threshold is refused; use `--history-tokens N` to select a smaller single target. The default llama.cpp
threshold is 44,000, but the measurement uses the loaded configuration. Scene output uses the bot's ordinary prompt
and output allowance. An output shorter than the frozen fixture's minimum makes the workload checks unknown;
a short response cannot establish that full scenes meet the time budget. A longer complete response remains valid:
it costs more work, so it cannot flatter the time result. The fixture maximum is recorded for comparison only.
An output cut off at the token limit still fails the format check.

Both phases replay identical branch points. Generated output is measured and discarded, so the history does not
grow past the selected size. In `solo`, only the tester runs. In `loaded`, agent turns and disposable probes run
beside it. An agent turn extracts memory with `summaryRequest`, validates it with `parseMemory`, commits it to a
synthetic clone and requests the next scene from that memory. The increment must shorten the request. Its output
tokens count as useful only when the following valid scene uses it; probes, failed scenes and abandoned increments
do not count. Completed probes record their output-token total separately; an unavailable count remains null.
This load does not exercise the bot's complete automatic-compaction retry/repair path.

Each size has `--cold-runs 2` cycles by default. A cycle forces a cold generation with `cache_prompt:false`, then
replays the identical request for `--scenes 1` warm call, after `--read-seconds 15`. The switch prevents prompt
reuse in that request's slot; it does not clear the whole server. See llama.cpp's
[cache-prompt branch](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/server/server-context.cpp#L2892-L3000).
Every call records both its intended and observed cache condition. Cold requires zero cached tokens and full
prefill within the existing 256-token tolerance; warm requires the prefix retained with at most 256 tokens of
prefill. Missing `cacheTokens` or `promptTokens` leaves the condition unknown. Warm calls that lose the cache fail
retention. Cold calls whose cold prefill cannot be confirmed cannot validate a profile.

That identical warm replay is the best case, a lower bound on the work of a normal turn. Each cycle also measures
`next`: it independently primes the branch through scene k-1, waits for reading, then requests the branch through
the frozen scene k. The previous request includes the last action and narrator rule; the next contains the stored
raw action and scene, exactly as `makeRequest` renders them. The primer's generated alternative is discarded, so
every profile receives the same frozen next scene. The primer is recorded separately and earns no useful tokens.

The server counts both requests and their common complete-message prefix. The prefix count includes an empty user
suffix to make a valid chat template; the existing 256-token tolerance covers that small template boundary.
`expectedCacheTokens`, `expectedPromptTokens` and `cacheMatched` show whether the observed mixed prefill matches
the expected new remainder. Lost prefix tokens fail retention. Missing counters, an unconfirmed primer, or an
unexpectedly absent new prefill leave the checks unknown. This measures one controlled transition below the
compaction threshold, not an indefinitely growing story.

The report separates `countMs`, the full token-count operation, from `countQueueMs`, its dispatch wait.
`queueMs` sums the counting and generation dispatch waits. `elapsedMs` starts when generation is dispatched.
`firstTextFromStartMs` and `firstTextFromRequestMs` end at the first nonempty `onText` delta, while
`totalRequestMs` ends at the completed response. The first delta is observed in the local adapter; Telegram's
draft cadence and delivery are outside this measurement. `decodeTokensPerSecond` uses server decode time.
`unattributedMs` is generation wall time minus server prefill and decode time, a signed residual which also includes
server work outside those timers. It is not an isolated measurement of the tunnel. Missing observations are `null`.

Summaries show sample count, median and maximum separately for each history size and cold, warm or next condition.
The 10-second generation gate applies only to warm replay medians. Cold and next timings remain visible separately;
a passing warm replay does not establish the response time of an ordinary next turn.

Before contacting the model, the script prints a plan and rejects one that uses more than 70% of the selected budget.
The planning allowance is reading pauses plus 10 seconds per model call, reusing the existing warm-generation
budget. This is an allowance, not a measured duration; cold prefill and setup can take longer. With the defaults,
three sizes and two cycles in each of two phases make 48 calls including primers, six minutes of reading and eight
minutes of call allowance: 14 of the 30 minutes. The remaining time is available for setup, longer cold prefill and
queue variation. Larger fixture/cycle selections need shorter pauses or a larger explicit budget and may still time out.
The 30-minute default budget covers setup, counts, queues, reading waits and both phases. Expiry aborts pending work
and saves a partial report. Incomplete series cannot pass. Cross-profile comparisons require the same workload
fingerprint, model, prompt configuration and reading cadence; draft comparisons also require the same slot/pool
configuration. Legacy short-prompt reports remain readable, but cannot establish the new workload checks.
An unreachable server or interrupted run is not proof of a VRAM shortage. Without measured insufficient headroom,
the combined pool/draft memory check stays unknown. A pending read-only VRAM sample can take up to 30 seconds to
finish during cleanup; the budget has already cancelled model work.

<a id='thresholds'></a>

The owner's thresholds, agreed on 20 September 2026 and encoded in `THRESHOLDS` in `local/gpu-measure.ts`:

| # | What is decided | Threshold |
|---|-----------------|-----------|
| 1 | Free video memory at the peak | at least 1 GiB |
| 2 | The tester's cache while others work | kept, 256 tokens of tolerance |
| 3 | Useful work per hour with lanes beside the tester | at least 1.2× |
| 4 | Warm replay beside other work, from dispatch to completion | each history's warm median at most 10 seconds; excludes counting and queues; cold/next reported separately |
| 5 | The tester's longest total dispatch wait | counting queue plus generation queue at most 120 seconds |
| 6 | The draft model's server decode speed | at least 1.2× in each matching history/cache series, without a format regression |
| 7 | The pool and the draft model do not fit together | keep the pool, drop the draft model |

No budget for cold startup, first text, total request time, or minimum absolute decode speed has been agreed.
The script reports those measurements without assigning new pass/fail numbers. The 10-second gate concerns warm
generation time after dispatch; it is not a claim about first visible text or total user wait.

Checks 1 to 5 are answered by one profile's two phases. Checks 6 and 7 compare profiles, so they need a pair that differs only by the draft model. Video memory is read on the instance over SSH (`SIMPLE_CHAT_GPU_SSH_HOST`); without it check 1 stays `unknown` and never becomes a pass. Check 6 verifies the scene format, the way `model:probe` does; it does not judge the prose, which is what `npm run eval` is for. A profile whose own checks did not all pass is not taken, however much work it does.

Thresholds 2 and 4 were reshaped by the owner on 2026-09-20, after the first live run and before the reports were
re-read. The cache tolerance was 32 tokens, which the tester crossed by re-reading 1 to 219 tokens of a 39,700-token
history: that is the template boundary moving under load, not a cache being lost, and the failure it guards against
(the whole history coming back, as measured on [the RX 580](knowledge/gpu-measurements.md#pool-rx580)) is two orders of magnitude larger. Threshold 4 was
"no more than 1.5× slower", a ratio; a person waits in seconds, and a ratio tightens by itself every time the card
gets faster, so the same experience would fail the check on better hardware.
