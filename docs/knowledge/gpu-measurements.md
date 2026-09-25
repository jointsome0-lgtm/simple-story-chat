# GPU measurements

Measurements and incidents from the rented cards, 2026-09-17 to 2026-09-24, moved here from [gpu.md](../gpu.md) on
2026-09-25. The paragraphs are as they were written, apart from headings, anchors and link addresses;
[simple-serving's rehearsal](#serving-rehearsal-2026-09-25) was written here on its day. Each number is what one run on
one machine saw, not a speed, a price or a capacity to expect. The instructions that rely on them are in
[gpu.md](../gpu.md), [llama-cpp.md](../llama-cpp.md) and [llama-measurement.md](../llama-measurement.md).

<a id='verified-2026-09-17'></a>

## The first launch, 2026-09-17

Verified on 17 September 2026 on an RTX 5090 32 GB: CUDA 13, Q4_K_M and Q6_K, a 65536 window and a synthetic input of about 59000 tokens. This is a check of capacity and protocol; whether facts are kept in a story is checked separately.

The run was done on the image `vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07`, digest `sha256:c1d2b5326fae806b04d2c2d97a2b3948d0ccb0026dd3085e9a2ad55e304193f8`, with driver 580.142 and nvcc 13.0.88. The launch was SSH direct, 60 GB of disk, with no published HTTP ports. The CUDA 12.8 template seen earlier does not describe this verified launch.

With microbatch 128, Q4 used about 22206 MiB of VRAM and Q6 used 28394 MiB; Q6 had about 4213 MiB left. For an input of 59097 tokens the first text arrived after 33.8 s on Q4 and 38.4 s on Q6. The repeated request used 59093 cached tokens and gave the first text after 5.1 and 4.4 s respectively. These are single measurements, not a guaranteed speed. The long probe found a violation of the instruction about the fixed scene time on the repeated request; the whole run cannot be counted as free of errors.

<a id='costs-and-downloads'></a>

## Prices, disks and downloads

`gpu/rent.mjs` tries host 402342 first, and `local/rent-plan.ts` budgets from the prices below. The host and its
$0.519 an hour are the basis the code records in its comments (`local/rent-plan.ts`, lines 9 to 24 at 512d124). The
gpu.md of that time never wrote them down, and they were not checked against a Vast bill for this page.

- One 5090 was quoted at $0.44 to $0.53 an hour from the live list, with host 402342 inside that range at $0.519. Two
  cards in one machine were quoted at $0.89 to $0.96. On 2026-09-24 the ceiling for one card went up to $0.65: the
  only offer left under $0.55 was on a host whose card another tenant was already loading.
- The 60 GB disk of that rental was billed $0.017 an hour, which is $0.207 per GB per month, against the $0.10
  commonly quoted.
- What a stop cost against a deletion is [below](#rental-history).

The exact price, the disk fee and the traffic fee are checked on the chosen offer. The traffic price on Vast differs between machines by a factor of twenty: from $2.6 to $52 per TB. Downloading the weights (25 GB) on a machine with $39/TB cost about one dollar, which is more than an hour of the rental itself; on a machine with $2.6/TB it costs seven cents. So compare offers by the sum "hour + download", not by the hourly price alone.

The link speed stated in the offer promises nothing: on a machine with "1171 Mbit/s" the weights came from Hugging Face at 115 Mbit/s, about half an hour.

A session that runs both lanes may be one machine (`--gpus 2`, or one card with the lanes in turn) or two machines with one card each, which is what the owner chose on 2026-09-22: on that day two whole single-card machines cost less than one two-card machine with the same memory, each lane keeps a machine's RAM to itself, and the two downloads run over two links at once.

<a id='paid-idle-2026-09-23'></a>

## Idle cards on the night of 2026-09-23

Two cards cost about $1.2 an hour, and Vast bills every minute whether they draw or wait. On the night of 2026-09-23 they waited for long stretches. The agent changed code one change after another, each with tests, a commit and a bot restart, and the cards had nothing to do. An experiment proposed around 23:30 UTC got its script at 01:15 UTC and drew 4 of its 12 pictures before the account's credit ran out.

The owner's rules that followed, in force since 2026-09-24, are in
[gpu.md](../gpu.md#while-the-cards-are-paid-for).

## SSH failures

The public key must be on the Vast **account**, under Account → SSH Keys, before the instance is created. Many machines offer no direct ports (`direct_port_start` 65535 with `direct_port_end` -1), and then the only route is Vast's proxy, `sshN.vast.ai`. The proxy admits account keys alone, so a key placed only inside the container, by an onstart script or by hand, never gets the chance to be used: the connection is closed before the container's own sshd sees it. The symptom is `Connection closed by <address> port <port>` on every attempt, with no mention of authentication. Adding the key to the account fixes a running instance without recreating it.

**An account key is necessary and it is not sufficient.** On 2026-09-20 instance 51669851 refused it with `Permission denied (publickey)` for its whole life. The key was the account's one key (compared body to body), the API answered `SSH key already associated with instance`, the stored onstart still carried the line that writes it into `authorized_keys`, and `ssh -vvv` showed that single key offered and turned down. Detaching and reattaching the key, rebooting the container and twenty minutes of retries all changed nothing, and the container cannot be told to install the key from outside: `PUT /instances/command/{id}/` answers `Invalid command given` to anything outside its own small set (`ls`, `rm`, `du`) and `Execute command only avail on stopped instances` while the instance runs. The rental was deleted unused, and its cause is not known. On 2026-09-22 instance 52079556 (a Taiwan host) refused the same way for an hour, and the container log (`PUT /instances/request_logs/{id}/`, then the `result_url`) named the cause: `Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys`. The host had written the file as its own user, `vastai_kaalia:docker`, and sshd's StrictModes refuses a key file that root does not own; the onstart script's `chmod 600` cannot change the owner. The repair from outside: stop the instance, `PUT /instances/command/{id}/` with `{"command":"rm /root/.ssh/authorized_keys"}` (the answer's `result_url` shows the output a few seconds later), start it again; the onstart script recreates the file as root and ssh works at once. The script now does that by itself when the file it finds is not root's. A stopped instance is billed for its disk only, and the stop, the command and the start took two minutes.

What the instance reported is worth reading carefully before blaming the machine. It showed `direct_port_start` 65535 with `direct_port_end` -1, the empty range, while the offer it was created from advertised twelve direct ports. That range describes the ports **this rental asked for**, not the ones the machine has, and a creation request that names none gets none. So an empty range is not evidence of a proxy-only machine, and filtering offers by `direct_port_count` would not have avoided that rental: every candidate within the price had ports. Whether a rental that asks for a direct port avoids the refusal is untested.

In the night before 17 September the model checks and two compactions failed because of SSH. The model server worked without restarts, and the GPU memory was used as usual. New connections through the tunnel hung, and the already open ones continued to pass data. The cause of the hangs was not found at that time. The server log stayed on the instance and was lost together with it. So start the next rental with the logs.

After a failed attempt the bot waits 10, then 20, then 30 seconds each time before a new ssh start. Earlier it started ssh on every 10-second check, and interrupted attempts could pile up on the sshd side. The tools that came out of these nights are in
[llama-cpp.md](../llama-cpp.md#diagnostics).

<a id='container-and-build'></a>

## The container and the build

`/workspace` is a convention of some Vast images, not of all of them: the verified CUDA 13 image has one 60 GB overlay on `/` and no `/workspace` at all, so create the directory rather than assume it.

`scp` through the proxy hung with no output and had to be killed; one `tar` over the same SSH session copied the scripts at once.

Written down between 2026-09-17 and 2026-09-20:

- With `aria2c` downloading beside the build, on an 850 Mbit/s link the weights arrived in six minutes, before the end of the build.
- The build runs as many jobs as the container's share of the cores allows.
  The share is read from the cgroup, because a container sees the whole machine otherwise: the measured 5090 host reported 256 cores and 454 GiB of free memory to a container that held 30.72 cores and 183 GB.
- In the verified image we had to restore the missing `libisl.so.23` by reinstalling `libisl23 libmpc3 libmpfr6 libgmp10 gcc-13 g++-13 build-essential`, and then configure CMake again with `--fresh`.

<a id='production-story-probes'></a>

## Q4 and Q6 on three synthetic stories

Q4 and Q6 each went through three artificial stories: a battle, chess and dance, with 16 scenes and three compactions in each. The archives, the source references and the branching were checked; semantic errors remained. Q6 produced a wrong chess FEN, and in the sum of dance repetitions it missed a training session that was present in the memory. A successful save of the JSON does not mean that the model uses it correctly when it continues the story. The inputs of these stories stayed below 8K tokens. Q4 and Q6 had different summarization rules and a different memory representation, so the comparison does not isolate the effect of quantization.

<a id='pool-2026-09-20'></a>

## The slot pool on a rented RTX 5090, 2026-09-20

The numbered columns are the thresholds of [the measurement session](../llama-measurement.md#thresholds).

These historical results used the earlier short synthetic scene prompt. They do not measure the frozen-story
workload of [the measurement session](../llama-measurement.md#measurement-session). One 32607 MiB card, Gemma 4 31B heretic Q6_K, context 65536, pool 98304 cells, `--kv-unified`. The decision was
`pool-3` over `single`, "take the pool without the draft model".

| Profile | Slots | Draft | Useful tokens/hour | 1: free | 2: cache | 3: gain | 4: scene | 5: wait |
|---------|-------|-------|--------------------|---------|----------|---------|----------|---------|
| pool-3  | 3 | no  | 22215 | 1717 MiB | 223 tokens of margin | 2.52× | 6.5 s | 2.5 s |
| pool-2  | 2 | no  | 18690 | 2141 MiB | 123 tokens of margin | 2.27× | 9.5 s | 6.6 s |
| single  | 1 | no  | 9065  | 4191 MiB | — | — | — | 0 s |
| single-mtp | 1 | yes | 11805 | 3157 MiB | — | — | — | 0 s |
| pool-3-mtp | 3 | yes | — | the server did not start | — | — | — | — |

Fewer slots did not mean a calmer card: `pool-2` was worse than `pool-3` on every axis, waits included. The draft
model doubled the writing speed on one slot (40.5 → 80.8 tokens a second by the server's own timings, 49 to 70 per
cent of draft tokens accepted, no format failures), which is threshold 6; with three slots llama-server died with
`out_of_memory` twelve seconds after each start, which is threshold 7 and why the draft model is off.

Two numbers in this table are read with care. `single`'s throughput carries the SSH proxy inside it — the tunnel was
measured at 1.4 ms one hour and 1.5 s the next, against 1.4 ms for the same call on the instance — so wall-clock
speed compares the tunnel's mood and threshold 6 is judged on the server's timings instead. And the free memory was
computed as total minus used, which hands back the driver's own 498 MiB reserve as headroom that does not exist:
`pool-3`'s 1717 MiB was really about 1219. The harness now asks the card for `memory.free`.

The card is also not always the whole card. Later the same session, with the identical profile running, 1035 MiB were
held by something outside the container: no process in the container had `/dev/nvidia*` open, `--query-compute-apps`
listed only llama-server's 30858 MiB, and the memory survived llama-server exiting. The headroom fell from 1219 MiB
to 217. Who owns that gigabyte was not established — `/proc/driver/nvidia/clients` is absent inside the container and
`dmesg` is unreadable, so neither a driver leak nor a neighbour is proven, and from inside there is no way to take it
back. Whatever a rented GPU reports as total, a profile measured with a gigabyte to spare can lose it.

<a id='pool-floor'></a>

## The pool has a floor, and it is the scheduler's

Shrinking the pool is the obvious answer to a card that lost memory, and it is bounded from below: the scheduler
admits a call only if the pool can hold it, so the pool must cover the tester's history, the output cap and the
margin. For the measured run — 39815 tokens for the tester, 23795 for the agent, a 4096 output cap and 2048 of
margin — that is 73850 cells while the tester is working and 78970 to keep its cache alive while it reads. A pool of
73728 buys video memory with exactly the eviction threshold 2 exists to prevent. Below 78970 the pool is not a
smaller pool, it is a different bargain, and thresholds 2 and 3 have to be measured again to know what it cost.

<a id='pool-rx580'></a>

## The slot pool on an RX 580

On the RX 580 with Gemma 3 1B (3 slots, 12288 cells) a 6.4K-token tester kept its cache through two agent requests beside it and one after it (8 tokens re-read of 6400); the second agent waited for room instead of pushing the tester out. The numbers for the 5090 are in [the session of 2026-09-20](#pool-2026-09-20).

On the RX 580 with Gemma 3 1B, three slots and the same load in each run, the script answered the question the flags raise:

| Server | The tester's cache | Useful work per hour | The tester's scene |
|--------|--------------------|----------------------|--------------------|
| Shared cache, idle slots cleared (llama.cpp's default) | lost, the whole history re-read | 52 300 | 4.6x slower |
| Isolated slots | kept | 87 000 | 1.4x slower |
| Shared cache, `--no-cache-idle-slots` | kept | 91 150 | 1.0x |

The numbers are a small old card's and mean nothing for the 5090; the order between the three does. The measurement that mattered was the first one: without that flag a pool is worse than no pool at all.

## Picture downloads

These are sizes from the pinned manifest and minutes computed from them, not downloads timed on a card. A new rental
counts the files its run actually selects.

A default run downloads the two Krea checkpoints, the encoder and the VAE: 31.46 GB, about 21 minutes at the 200 Mbit/s floor the bootstrap enforces and 4 minutes at 1 Gbit/s. With Gemma's 25.72 GB on the other lane that is 57.18 GB of weights over one shared link, and with the wheels beside them 63.18 GB, which is the number [rent-plan.ts](../../local/rent-plan.ts) prices an offer's traffic by: 42 minutes at the floor, 8 at 1 Gbit/s.

Qwen-Image 2.1 with `SIMPLE_CHAT_IMAGE_QWEN=true` adds:

| | bytes | at 200 Mbit/s | at 1 Gbit/s |
|---|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | 7 256 783 064 | 4.8 min | 58 s |
| `qwen3vl_8b_int8_convrot.safetensors` | 9 350 798 360 | 6.2 min | 75 s |
| `qwen_image_2.1_vae_bf16.safetensors` | 675 509 688 | 27 s | 5 s |
| **together** | **17 283 091 112** (17.28 GB) | **11.5 min** | **2.3 min** |

The session's whole download becomes 80.46 GB, about 54 minutes at 200 Mbit/s and 11 at 1 Gbit/s, and the 150 GB disk the plan rents still holds it with room for torch and the pictures. The link is measured once while the downloads run, and a machine below 200 Mbit/s is meant to be destroyed rather than waited for — with the opt-in on, that decision is worth twelve more minutes than without it.

The same three files in bf16 would be 32.44 GB, which does not fit one 32 GB card anyway; the reasoning is written out in the manifest beside the pins. Nothing of Krea's is replaced, so one prepared box draws both and the blind comparison has something to compare.

<a id='rental-history'></a>

## Stop or delete: what each cost in September 2026

The rental is billed per minute, so a pause longer than two or three minutes is a reason to stop the machine: running costs about $0.01 per minute, and storage of a stopped machine costs $0.017 per hour. But the disk is tied to the host, and while the machine is stopped, another renter can take its card; the storage is still charged during that time. The rule: for a pause inside a work session (up to two or three hours), stop the machine, and if the machine did not come up within a couple of minutes, delete it and take another one, the loss is one cent; for "that is all for today" or when the return time is unknown, delete at once: a preparation from zero on a good link costs about $0.15 and 15 minutes, and a night of storage costs $0.20.

The rule in force is in [gpu.md](../gpu.md#ending-the-rental).

<a id='serving-rehearsal-2026-09-25'></a>

## simple-serving's rehearsal on small cards, 2026-09-25

Before the heretic goes on a 5090, simple-serving ran whole on small cards with Google's Gemma 4 E2B from its branch
`rehearsal-e2b`: vLLM 0.30.0, the gateway of contract v2, and the first-rental runbook of its README. Six cards came
from `npm run gpu:rent -- --lane small`, and each ended with `--destroy` read back as gone. By their minutes at the
hourly price they cost about $0.21 together, traffic fees not counted.

- **RTX A4500, Czechia, host 513248, driver 595.84, $0.124 an hour.** Vast said `running` 3 minutes after the rental,
  and SSH never worked. The direct port closed each of 18 connections in 4 minutes before sshd's greeting, and the
  proxy did not answer. Deleted after about 10 minutes, $0.02. The cause is not known.
- **RTX 5060 Ti, New Jersey, host 87213, driver 595.71.05, $0.189.** Vast answered the card's own container key with
  200 from the card and with 401 from the owner's machine, where `up`, `status` and `sleep` read the instance. Deleted
  after 5 minutes, $0.02. The owner then made a restricted key, and `cli trial` writes only the instance's id and the
  SSH host since simple-serving 50983ac.
- **RTX 5060 Ti, Italy, host 92578, driver 595.80, $0.189.** The preparation took 5 minutes. The card stopped itself
  25 s after `sleep`, the owner's restricted key confirmed the stop and resumed the card, and the gateway was ready
  again within a minute. The smoke passed 6 of its 11 probes, and `refusal`, a pattern with an unclosed group, got 503
  `engine_unavailable` instead of 400. vLLM checks a schema only after its 200 and refuses it with the stream's first
  event, an error the gateway did not read then; it reads that event's `code` since simple-serving 5f9c3d8. Deleted,
  $0.05.
- **RTX A4000, Romania, host 425719, driver 580.159.03, $0.125.** The engine ended about 100 s into its load, and the
  launcher gave up and stopped the card, as it is built to. The reason was only in the card's own log, which went with
  the card. Deleted, $0.03. It was the day's only Ampere card and its only 580 driver, so either may be the cause. The
  small lane takes Blackwell cards only since 8e6aa7b, and the operator now copies the launcher's log to the owner's
  machine while a card loads.
- **RTX 5060 Ti, British Columbia, host 197411, driver 595.71.05, $0.146.** The runbook ran through `abort`. The first
  load took 203 s: weights of 9042 MiB and a KV cache of 645 MiB, which holds 101729 tokens. The card stopped 54 s
  after `sleep`, as `status` and `--show` both read, and was ready 56 s after `up`. `refusal` got 400
  `invalid_request`. `schemas` failed on `frame`, whose answer ran out the bot's 900 tokens with 1668 characters.
  Deleted, $0.04.
- **RTX 5060 Ti, Connecticut, host 348060, driver 595.84, $0.159.** vLLM builds a schema's JSON with xgrammar alone and
  no whitespace between its tokens since simple-serving 1c3a93a. `schemas` passed 12 of 12, `frame` with 646
  characters in 201 tokens, and `counts` and `privacy` passed. The load took 266 s, with the same KV cache. Deleted
  after 17 minutes, $0.05.

Two questions stay open. Whitespace as the cause of `frame`'s overrun rests on one answer at temperature 0.8, and the
smoke's new counts of whitespace and of characters outside ASCII have not yet seen an answer cut short. Why the A4000
did not load is not known; simple-serving's contract already says that CUDA 13 on a 580 driver runs only by
minor-version compatibility.
