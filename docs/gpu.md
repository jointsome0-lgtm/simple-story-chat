# Gemma on a rented GPU

Verified on 17 September 2026 on an RTX 5090 32 GB: CUDA 13, Q4_K_M and Q6_K, a 65536 window and a synthetic input of about 59000 tokens. This is a check of capacity and protocol; whether facts are kept in a story is checked separately.

The bot and SQLite stay on the computer or on a separate server. Only llama.cpp runs on the GPU; the connection goes through SSH. You do not need to move the Telegram token or the story database there. With every request the model server receives the story context that it needs.

## What we run

We use [Gemma 4 31B IT Uncensored Heretic, GGUF](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF), file `Q6_K`, 25 201 484 928 bytes. This is a dense model. The uncensored status stated in the model card does not guarantee narration quality or that facts are kept: this is checked on stories separately.

[manifest.env](../gpu/manifest.env) pins the model revision, the file name, the size and the SHA256, and also the commit of [llama.cpp 0.4.1](https://github.com/ggml-org/llama.cpp/commit/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4). The script verifies the file after the download. A version update is a separate change of the manifest and a repeated check.

For the first run we choose one RTX 5090 with 32 GB VRAM, at least 32 GB RAM and 60 GB of disk. You need a CUDA development image with `nvcc`, CUDA 12.8 or newer and a driver that runs the image's CUDA (the pinned image is CUDA 13, so the offer query asks for a host whose driver runs 13.0; a 570 driver stops at 12.8); the build architecture for the 5090 is `120`. An On-demand rental fits a short test without a monthly commitment. The exact price, the disk fee and the traffic fee are checked on the chosen offer. The traffic price on Vast differs between machines by a factor of twenty: from $2.6 to $52 per TB. Downloading the weights (25 GB) on a machine with $39/TB cost about one dollar, which is more than an hour of the rental itself; on a machine with $2.6/TB it costs seven cents. So compare offers by the sum "hour + download", not by the hourly price alone.

The run was done on the image `vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07`, digest `sha256:c1d2b5326fae806b04d2c2d97a2b3948d0ccb0026dd3085e9a2ad55e304193f8`, with driver 580.142 and nvcc 13.0.88. The launch was SSH direct, 60 GB of disk, with no published HTTP ports. The CUDA 12.8 template seen earlier does not describe this verified launch.

The configuration of the parent model has 60 layers: 50 with a local window of 1024 and 10 with full attention. We run one slot with a context of 65536, Flash Attention and a Q8 KV cache. We do not enable the full KV cache for the local layers. [Model configuration](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic/blob/main/config.json).

With microbatch 128, Q4 used about 22206 MiB of VRAM and Q6 used 28394 MiB; Q6 had about 4213 MiB left. For an input of 59097 tokens the first text arrived after 33.8 s on Q4 and 38.4 s on Q6. The repeated request used 59093 cached tokens and gave the first text after 5.1 and 4.4 s respectively. These are single measurements, not a guaranteed speed. The long probe found a violation of the instruction about the fixed scene time on the repeated request; the whole run cannot be counted as free of errors.

## Renting

[rent.mjs](../gpu/rent.mjs) takes one offer that matches the paragraph above. It exists because an offer id on Vast lives only a few minutes: a price read out of a list, agreed to, and then used is a price for an offer that no longer exists, so the script searches live and tries its candidates in order until one is taken. `SIMPLE_CHAT_VAST_API_KEY` comes from the environment and is never printed; the public key named in the script is installed by [trial-onstart.sh](../gpu/trial-onstart.sh), which also arms a three-hour guard that deletes the instance.

Run it dry first. That names the offers it would take at their present prices, which is the thing worth agreeing to, and it spends nothing.

```sh
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs
node --env-file-if-exists=.env.gpu gpu/rent.mjs
```

A session that runs both lanes may be one machine (`--gpus 2`, or one card with the lanes in turn) or two machines with one card each, which is what the owner chose on 2026-09-22: on that day two whole single-card machines cost less than one two-card machine with the same memory, each lane keeps a machine's RAM to itself, and the two downloads run over two links at once. Rent each lane with its own call; the language machine asks for 60 GB of disk and is priced by Gemma's download, the picture machine for 100 GB and by the image files. The two tunnels are `bash gpu/tunnel.sh ALIAS` for the language machine and `bash gpu/tunnel.sh --pictures-only ALIAS` for the other. Each machine arms its own three-hour guard. Rent the second machine with `--avoid-host` and the first machine's host id: the same box often lists both of its cards, and two rentals on it would share one link, one disk and one failure, which is not the two machines the owner asked for.

```sh
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs --lane text
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs --lane pictures
```

Machines in mainland China are not asked for and are dropped from the answer (`droppedForCountry`): Hugging Face and CivitAI are not reliably reachable from there, and a session is mostly a download.

Offers are sorted by `hour * 2.5 + download`, the cost of the session the instance is billed for, with the measured host first. Offers with fewer than two direct ports are dropped and the count of them is reported: an offer with no ports can only be reached through Vast's proxy. That rule has never yet excluded anything — every 5090 within this price has had ports — so treat it as a guard, not as an explanation of any failure.

### While the cards are paid for

Two cards cost about $1.2 an hour, and Vast bills every minute whether they draw or wait. On the night of 2026-09-23 they waited for long stretches. The agent changed code one change after another, each with tests, a commit and a bot restart, and the cards had nothing to do. An experiment proposed around 23:30 UTC got its script at 01:15 UTC and drew 4 of its 12 pictures before the account's credit ran out. The owner's rules since 2026-09-24:

1. Rent when the work for the cards is ready. Write and dry-run every experiment script before the rental. A dry run needs no card. It assembles the prompts and counts their tokens.
2. Keep the cards busy while they run. Code, tests and commits that the cards do not need go to a subagent in its own worktree, so the agent feeding the cards never stops to do them.
3. Watch the idle time. When the cards have stood idle for more than 10 minutes and no work for them is ready, tell the owner and offer to delete them.

## Preparing the server

After you create the instance, take the address, the SSH port and the user from Vast. Add a local entry to `~/.ssh/config`; the values below are a sample:

```sshconfig
Host simple-chat-vast
    HostName HOST_FROM_VAST
    Port PORT_FROM_VAST
    User root
    IdentityFile ~/.ssh/YOUR_VAST_KEY
    IdentitiesOnly yes
```

On the first `ssh simple-chat-vast` verify the host key. After that the tunnel requires the already known key and does not accept a replaced key automatically.

The public key must be on the Vast **account**, under Account → SSH Keys, before the instance is created. Many machines offer no direct ports (`direct_port_start` 65535 with `direct_port_end` -1), and then the only route is Vast's proxy, `sshN.vast.ai`. The proxy admits account keys alone, so a key placed only inside the container, by an onstart script or by hand, never gets the chance to be used: the connection is closed before the container's own sshd sees it. The symptom is `Connection closed by <address> port <port>` on every attempt, with no mention of authentication. Adding the key to the account fixes a running instance without recreating it.

**An account key is necessary and it is not sufficient.** On 2026-09-20 instance 51669851 refused it with `Permission denied (publickey)` for its whole life. The key was the account's one key (compared body to body), the API answered `SSH key already associated with instance`, the stored onstart still carried the line that writes it into `authorized_keys`, and `ssh -vvv` showed that single key offered and turned down. Detaching and reattaching the key, rebooting the container and twenty minutes of retries all changed nothing, and the container cannot be told to install the key from outside: `PUT /instances/command/{id}/` answers `Invalid command given` to anything outside its own small set (`ls`, `rm`, `du`) and `Execute command only avail on stopped instances` while the instance runs. The rental was deleted unused, and its cause is not known. On 2026-09-22 instance 52079556 (a Taiwan host) refused the same way for an hour, and the container log (`PUT /instances/request_logs/{id}/`, then the `result_url`) named the cause: `Authentication refused: bad ownership or modes for file /root/.ssh/authorized_keys`. The host had written the file as its own user, `vastai_kaalia:docker`, and sshd's StrictModes refuses a key file that root does not own; the onstart script's `chmod 600` cannot change the owner. The repair from outside: stop the instance, `PUT /instances/command/{id}/` with `{"command":"rm /root/.ssh/authorized_keys"}` (the answer's `result_url` shows the output a few seconds later), start it again; the onstart script recreates the file as root and ssh works at once. The script now does that by itself when the file it finds is not root's. A stopped instance is billed for its disk only, and the stop, the command and the start took two minutes.

What the instance reported is worth reading carefully before blaming the machine. It showed `direct_port_start` 65535 with `direct_port_end` -1, the empty range, while the offer it was created from advertised twelve direct ports. That range describes the ports **this rental asked for**, not the ones the machine has, and a creation request that names none gets none. So an empty range is not evidence of a proxy-only machine, and filtering offers by `direct_port_count` would not have avoided that rental: every candidate within the price had ports. Whether a rental that asks for a direct port avoids the refusal is untested.

From the project root upload only the scripts. `/workspace` is a convention of some Vast images, not of all of them: the verified CUDA 13 image has one 60 GB overlay on `/` and no `/workspace` at all, so create the directory rather than assume it.

```sh
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast
```

`scp` through the proxy hung with no output and had to be killed; one `tar` over the same SSH session copied the scripts at once.

The container needs `git`, `cmake`, `ninja`, `curl`, `python3`, a C++ toolchain and a CUDA compiler. For an Ubuntu image you can install the missing packages like this:

```sh
apt-get update
apt-get install -y git cmake ninja-build curl python3 build-essential libssl-dev
bash /workspace/simple-chat/gpu/bootstrap.sh
bash /workspace/simple-chat/gpu/ensure-server.sh
```

`nvcc` must be part of the chosen development image. The host driver is not installed this way. The preparation downloads about 25.2 GB of weights and builds `llama-server`. By default the weights go through `aria2c` with 16 connections (if the image does not have it, the script installs it through `apt-get`; if that fails, the script downloads with a single `curl`). The download runs in the background while `llama-server` is built, and the script waits for it after the build; on an 850 Mbit/s link the weights arrived in six minutes, before the end of the build. `SIMPLE_CHAT_BUILD_JOBS` sets the number of build threads; by default it is the container's share of the cores, or fewer if its memory is short (CUDA compilation takes about 2 GiB per job). The share is read from the cgroup, because a container sees the whole machine otherwise: the measured 5090 host reported 256 cores and 454 GiB of free memory to a container that held 30.72 cores and 183 GB. The build is worth no rented minutes of its own as long as it ends before the weights arrive, which is what that default is for. `SIMPLE_CHAT_DOWNLOAD_CONNECTIONS=1..16` changes the number of connections, and `1` brings back the single download. An interrupted parallel download continues from the place where it stopped; SHA256 is verified as before. By default the files are in `/workspace/simple-chat-gpu`; `ensure-server.sh` leaves one process under `flock` after SSH disconnects. In the verified image we had to restore the missing `libisl.so.23` by reinstalling `libisl23 libmpc3 libmpfr6 libgmp10 gcc-13 g++-13 build-essential`, and then configure CMake again with `--fresh`.

It is convenient to watch the preparation from the bot's computer: `ssh -t simple-chat-vast bash /workspace/simple-chat/gpu/progress.sh`. The screen refreshes once every three seconds and shows the downloaded amount of weights, the speed over the last half minute and the remaining time, and for the build it shows the completed steps out of the total number and the remaining time. The script only reads, and it exits by itself when the weights are verified and `llama-server` is built. The link speed stated in the offer promises nothing: on a machine with "1171 Mbit/s" the weights came from Hugging Face at 115 Mbit/s, about half an hour.

The bot writes one scene at a time, and the server starts with one slot by default; the bot's client checks this. The research batch (`memory-probe.ts --lab`) starts the server with `SIMPLE_CHAT_GPU_SLOTS=2..8`: by default each slot gets its own `SIMPLE_CHAT_GPU_CONTEXT` cells for the full-attention layers, and each adds its own sliding-window cache, about 425 MiB at q8 (an estimate from the model's layers, not measured). `SIMPLE_CHAT_GPU_KV_UNIFIED=true` with `SIMPLE_CHAT_GPU_POOL` makes them share one cache instead, which fits more slots into the same memory. With 5 slots the batch took 8 s per scene against 15 s with one slot; about three requests were in flight at a time, so this is a 1.9x gain rather than 5x. Before the bot returns to the GPU, the server is restarted without this variable.

The server listens only on `127.0.0.1:8080`. You do not need to publish this HTTP port on the internet. Slot snapshots to disk and the additional RAM cache of snapshots are disabled; the ordinary KV cache of the current slot stays in memory.

`server-log.py` saves the start and end time of the model, the exit code or signal and the error categories to `/workspace/simple-chat-gpu/server-events.jsonl`. The original server output is processed only in memory and is not saved: even an error message can contain a part of the request. The llama.cpp level is errors only; logs of prompts, of JSON packets and core dumps are disabled. The file has `0600` permissions and two rotations of 1 MiB each. The error category helps the diagnosis, but by itself it does not prove the cause of the error.

## Connection and check

On the computer with the bot open a separate terminal and run:

```sh
bash gpu/tunnel.sh simple-chat-vast
```

In another terminal, from the project root:

```sh
cp -n .env.gpu.example .env.gpu
chmod 600 .env.gpu
npm run model:probe
npm run model:probe -- --long
```

`.env.gpu` contains the settings of the model and of GPU control and adds to the ordinary `.env`; the bot token and the database path stay in `.env`. Both working files are excluded from git. For your own HTTPS gateway there are `SIMPLE_CHAT_BASE_URL` and `SIMPLE_CHAT_API_KEY`. Unencrypted HTTP is allowed only over loopback. The gateway must pass the routes that are compatible with the stated llama.cpp version, including `/props` and token counting.

The probe does not contact Telegram or the database. It uses an artificial plot and prints only counters and statuses:

- the model name matches, the number of slots and the context size;
- a streamed answer with a date, and no service tags;
- a repeated request with a shared prefix and the number of cached tokens reported by the server;
- a refusal before generation when the input limit is exceeded;
- JSON Schema is followed in spite of a request to answer in plain text;
- a cancellation during the answer and a successful request after it;
- with `--long`, a request of about 60000 input tokens.

`firstTextMs` includes the token counting, the queue and the input processing. `cachedInputTokens: null` means that there is no counter, not that the cache is zero. The probe requires the input prefix to be reused, with a tolerance of 32 tokens at the template boundary; with `--long` the repeat of the long request is checked too. If the cache is not used, the probe ends with an error, although ordinary generation may work. Compare the counters with the time of the repeated request. The presence of a separate `reasoning_content` also ends the probe with an error. A large synthetic request checks capacity and protocol, but not story quality.

During the long probe check the memory on the GPU:

```sh
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv
```

The initial microbatch is 128. After you measure VRAM, you can restart the server with `SIMPLE_CHAT_GPU_UBATCH=512` and compare the same probes; this may speed up the processing of a long input at the cost of memory. The speed values are not known before such a run. For diagnosis look at the categories in `server-events.jsonl`; do not enable saving of the raw output when personal stories are processed.

## Switching the bot

After a successful probe stop the current bot process with Ctrl+C and wait until it ends. Then in the same project:

```sh
npm run start:gpu
```

The same database is used: seeds, branches and checkpoints are available through the same Telegram buttons. When the provider changes, the context measurements of the previous model are not used to calibrate the next request. To return to the settings of the ordinary `.env`, stop the GPU variant and run `npm start`. Do not run two poller processes at the same time.

Before generation the adapter calls `/v1/chat/completions/input_tokens` with the same request body that will go to generation. In the pinned version both routes use one chat template and one tokenizer. If this route is missing, the work stops; a rough estimate does not replace it. [llama.cpp protocol](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/server/README.md).

The one exception saves that call, about a second over the tunnel, where the answer is not in doubt. A scene is sent on the bot's own estimate while that estimate is below 90% of the compaction threshold, if it is anchored on the last scene's measured input, or below 50% if it is not. A picture description is sent on the estimate while that is below 90% of the context less the description's answer reserve. The estimate for a description is the scene's measured input and output plus its instruction. Compaction requests are always counted. The count the server reports with the answer then decides, as before. Over the limit, the answer is dropped with `context_limit` and the branch compacts. A prompt that the server refuses with 400 as longer than its context is counted after all, so it ends the same way (`local/generation.ts`, `local/llama.ts`).

For llama.cpp compaction starts by default at 44000 input tokens, the total context is 65536, and the answer reserve is 4096. At most 12 paragraphs stay in the narrative prompt. The 44000 threshold gives a margin before the technical limit; it does not establish the degradation boundary of Gemma. The battle, chess and dance probes compact the memory manually three times at a much smaller context. They check consecutive compactions, but they do not replace a quality check at 44K.

Compaction passes a JSON Schema to llama.cpp through `response_format`: the format constraint works during generation. Then the code checks that the answer is complete, the references to scenes, the coverage and that the request became smaller. The original JSON is saved, and `local/prompt.ts` turns it into text with dates, fact types and sources, without a second retelling by the model. The seed, the chain of memory increments and the last uncompacted scenes form the context of the selected checkpoint. The structure checks do not confirm that every extracted fact is true.

With `SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE=true` the `plain` mode allows one additional request for missed scenes. By default this repair is turned off, so that memory quality can be checked separately. The additional request receives the draft of facts and the preceding scenes for understanding, but the references in the new facts may point only to the missed scenes. The draft is not saved separately: the whole memory increment passes the common check and is written in one transaction. A repeated miss, a broken connection or a growth of the memory size leaves the original context unchanged. The JSON counter in the progress message shows characters, not tokens.

Q4 and Q6 each went through three artificial stories: a battle, chess and dance, with 16 scenes and three compactions in each. The archives, the source references and the branching were checked; semantic errors remained. Q6 produced a wrong chess FEN, and in the sum of dance repetitions it missed a training session that was present in the memory. A successful save of the JSON does not mean that the model uses it correctly when it continues the story. The inputs of these stories stayed below 8K tokens. Q4 and Q6 had different summarization rules and a different memory representation, so the comparison does not isolate the effect of quantization.

An unfinished stream, a tool call and a mismatch of counters do not become a finished scene. There is no automatic retry of generation after a network error. The total timeout of a GPU call in the example is 10 minutes; there is no separate timeout for an idle stream yet. This is a limit of waiting, not a promise of speed. A cancellation closes the HTTP stream. The probe after a cancellation checks that the slot is available and reports the delay; a successful next answer by itself does not yet prove that the computation on the server stopped immediately.

## Background memory comparison

The bot has one computation queue in `local/scheduler.ts`. User requests are served in order. A background probe starts a computation after 60 seconds without user requests. A new user request cancels the background computation; the probe repeats only its own unfinished step. User answers are not repeated automatically.

One background call is limited to 90 seconds. It runs only when the GPU is ready and there are no user jobs. It keeps the GPU up from the moment the queue takes it until it ends, so the auto-pause never comes while an eval sends its calls one after another; between two calls only the idle interval keeps the GPU up. The background work never starts a rental and yields to a pause: while the GPU is pausing or paused, the queue stops the running call, refuses the waiting ones and takes no new ones. The pause and the unavailability are checked every second. The model has one slot, so the background work can evict the story cache and increase the time to the first text of the next user answer. A turn, a person's or an agent's, keeps the model slot from the start of its first call until it ends, so no other turn or probe runs between its compaction steps and its scene and evicts its cache (the compaction and the scene share only a common prefix, so the scene still has its own prefill). A started turn is never cut off by a person. Agent turns ([agent interface](agent-interface.md#model-access)) have their own queue: they wait for the same quiet window and have no 90-second limit. Once started, an agent turn runs to its end, so the GPU does real work while people read; a person who writes meanwhile waits for it, up to a couple of minutes (the tester agreed to this for the sake of GPU use). Only a compaction prepared ahead for one person yields to anyone else's call. A started agent turn keeps the GPU up from its first call to its end, the gaps between its calls included: a pause waits for it, and the auto-pause counts from its end. A person waiting for the model sees how many requests are ahead: before a scene in the disappearing draft the scene then streams into, and in the compaction status. Only the count is shown, never whose requests they are; when the model starts reading the scene request, the draft says so until the text arrives.

### Slot pool (off by default)

`SIMPLE_CHAT_GPU_SLOTS=3` in the bot's `.env`, with the server started by `serve.sh` with the same `SIMPLE_CHAT_GPU_SLOTS`, turns the queue into a pool: one call runs in each slot at once. `SIMPLE_CHAT_CONTEXT_TOKENS` stays the limit of one request, and `SIMPLE_CHAT_GPU_CONTEXT` must match it.

The slots divide the card's cache in one of two ways, and the bot and the server must be told the same one:

- **Isolated** (the default, `SIMPLE_CHAT_GPU_KV_UNIFIED` unset or `false`): each slot owns `SIMPLE_CHAT_GPU_CONTEXT` cells, the server is given `slots x context` in all, and nothing can evict anything. The scheduler admits every call that fits one request, because it does.
- **Shared** (`SIMPLE_CHAT_GPU_KV_UNIFIED=true` in both, `SIMPLE_CHAT_POOL_TOKENS` and `SIMPLE_CHAT_GPU_POOL` the same number): the slots share that many cells, `--kv-unified-per-slot` stops one slot from taking more than one request's worth, and the scheduler admits calls by size as described below. Fewer cells buy the same slots, and a short story leaves its room to the others.

**`--no-cache-idle-slots` is what makes either of them work**, and `serve.sh` always passes it. Without it llama.cpp saves an idle slot's cells to the RAM prompt cache on every new task and clears them from the card; with `--cache-ram 0` they are simply gone, and a person loses their whole story cache while they read. This is not a subtlety: on the RX 580 the same load kept the cache with the flag and re-read the history from nothing without it.

The bot's check refuses a server with other slots, or one whose slot cannot hold a whole request. The size of a shared pool is not in the server's API at all, so nothing verifies it: the two numbers are the operator's to match.

- A turn's calls go to one slot (`id_slot`), and a holder's next turn goes back to its slot. People take the highest free slot that holds no other person's cache; agents and probes take the lowest and never the highest one. When the cache overflows, llama.cpp evicts idle slots from slot 0 up, so people's caches go last.
- Each call reserves its input, counted by the server beforehand outside the slots, plus its whole output limit, and 2048 cells stay free. A call starts only if its reservation fits beside every running call and every other turn between its calls. An agent's or a probe's call must also leave room for every person's cache with its output limit and 1024 more cells for the next action, so agents never push a person's cache out, between their own calls no more than at their start. A person's call does not count idle caches: the server evicts them. The next call of a started turn does not count the idle caches of other turns, so two turns between their calls never wait for each other; a call larger than the whole pool runs only when the pool holds nothing else.
- Agents and probes start beside people without the quiet window, and an agent turn may start while people's jobs keep the GPU up. A person who cannot be placed, at the start of a turn or between its calls, stops probes and ends another person's prepared compaction, as with one slot; with room nobody yields. An agent kept from the pool by a probe stops it, at the start of its turn and between its calls alike. A prepared compaction waiting for room preempts nothing and keeps nobody behind it: anyone who fits starts beside it. A turn whose next call waits for room keeps its slot: only a silent one is taken as lost.
- Cancelling a call that is still waiting for room ends the token count started for it.
- The GPU snapshot counts the times the instance came back up (`starts`). A pool forgets its reservations then, because that server's caches are empty. A control API that fails and recovers says nothing about the model server and does not count, and neither does an intention to stop the instance that never took effect.

On the RX 580 with Gemma 3 1B (3 slots, 12288 cells) a 6.4K-token tester kept its cache through two agent requests beside it and one after it (8 tokens re-read of 6400); the second agent waited for room instead of pushing the tester out. The numbers for the 5090 come from the measurement session.

### Measurement session

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

Thresholds 2 and 4 were reshaped by the owner on 2026-09-20, after the first live run and before the reports were
re-read. The cache tolerance was 32 tokens, which the tester crossed by re-reading 1 to 219 tokens of a 39,700-token
history: that is the template boundary moving under load, not a cache being lost, and the failure it guards against
(the whole history coming back, as measured on the RX 580 below) is two orders of magnitude larger. Threshold 4 was
"no more than 1.5× slower", a ratio; a person waits in seconds, and a ratio tightens by itself every time the card
gets faster, so the same experience would fail the check on better hardware.

#### Measured on a rented RTX 5090, 2026-09-20

These historical results used the earlier short synthetic scene prompt. They do not measure the frozen-story
workload described above. One 32607 MiB card, Gemma 4 31B heretic Q6_K, context 65536, pool 98304 cells, `--kv-unified`. The decision was
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

#### The pool has a floor, and it is the scheduler's

Shrinking the pool is the obvious answer to a card that lost memory, and it is bounded from below: the scheduler
admits a call only if the pool can hold it, so the pool must cover the tester's history, the output cap and the
margin. For the measured run — 39815 tokens for the tester, 23795 for the agent, a 4096 output cap and 2048 of
margin — that is 73850 cells while the tester is working and 78970 to keep its cache alive while it reads. A pool of
73728 buys video memory with exactly the eviction threshold 2 exists to prevent. Below 78970 the pool is not a
smaller pool, it is a different bargain, and thresholds 2 and 3 have to be measured again to know what it cost.

On the RX 580 with Gemma 3 1B, three slots and the same load in each run, the script answered the question the flags raise:

| Server | The tester's cache | Useful work per hour | The tester's scene |
|--------|--------------------|----------------------|--------------------|
| Shared cache, idle slots cleared (llama.cpp's default) | lost, the whole history re-read | 52 300 | 4.6x slower |
| Isolated slots | kept | 87 000 | 1.4x slower |
| Shared cache, `--no-cache-idle-slots` | kept | 91 150 | 1.0x |

The numbers are a small old card's and mean nothing for the 5090; the order between the three does. The measurement that mattered was the first one: without that flag a pool is worse than no pool at all.

Checks 1 to 5 are answered by one profile's two phases. Checks 6 and 7 compare profiles, so they need a pair that differs only by the draft model. Video memory is read on the instance over SSH (`SIMPLE_CHAT_GPU_SSH_HOST`); without it check 1 stays `unknown` and never becomes a pass. Check 6 verifies the scene format, the way `model:probe` does; it does not judge the prose, which is what `npm run eval` is for. A profile whose own checks did not all pass is not taken, however much work it does.

After the managed GPU profile starts, the bot creates a Unix socket `<database path>.model.sock` with `0600` permissions. Only background generation and the service status are available in it. The story database is not available through it. For these probes use `memory:probe`; the earlier `model:probe` and `story:probe` contact the model directly and are not meant to run at the same time as a working tester.

```bash
npm run memory:probe -- --source /path/to/synthetic/dance/evidence.json --minutes 15
```

The source must be the result of `story:probe` for one of the synthetic examples of the project. The script compares the seed and all author inputs, reproduces the same scenes for `plain` and `sgr`, performs three compactions for each and checks the answers to questions that were set in advance. It does not generate new narrative scenes. The file `report.json` in the printed temporary directory contains the memory increments, the exact counters, the answers and the expected values. The technical output has only metadata.

After a stop you can continue from the saved point:

```bash
npm run memory:probe -- --source /path/to/synthetic/dance/evidence.json --resume /tmp/simple-chat-memory-dance-EXAMPLE --minutes 15
```

The probe is limited to the given time, from 1 to 30 minutes. A busy or stopped GPU can leave it unfinished. This is not a result of a quality check. A comparison needs both modes completed on one source file and one model. Such a run evaluates the whole compaction scheme, including the different output budget; it does not isolate the effect of one SGR instruction and does not check quality at 44K.

## The picture card

The second card of a two-card rental runs ComfyUI instead of llama.cpp: [image-bootstrap.sh](../gpu/image-bootstrap.sh) prepares it from [image-manifest.env](../gpu/image-manifest.env), [image-serve.sh](../gpu/image-serve.sh) starts it on loopback with `CUDA_VISIBLE_DEVICES=1`, and `npm run image:batch` draws the frames of the synthetic stories through the tunnel. Why any of this exists is in [illustrations-plan.md](illustrations-plan.md); what follows is only what a rental has to know.

A default run downloads the two Krea checkpoints, the encoder and the VAE: 31.46 GB, about 21 minutes at the 200 Mbit/s floor the bootstrap enforces and 4 minutes at 1 Gbit/s. With Gemma's 25.72 GB on the other lane that is 57.18 GB of weights over one shared link, and with the wheels beside them 63.18 GB, which is the number [rent-plan.ts](../local/rent-plan.ts) prices an offer's traffic by: 42 minutes at the floor, 8 at 1 Gbit/s.

### Qwen-Image 2.1, opt-in

`SIMPLE_CHAT_IMAGE_QWEN=true` adds a third checkpoint, pinned in the same manifest and verified by the same code path. It is off by default because the traffic term above is the default run's, and a session that has not asked for this comparison should not pay for it.

```sh
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-bootstrap.sh --dry-run   # names the files, downloads nothing
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-bootstrap.sh
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-serve.sh
```

What it adds:

| | bytes | at 200 Mbit/s | at 1 Gbit/s |
|---|---|---|---|
| `qwen_image_2.1_int8_convrot.safetensors` | 7 256 783 064 | 4.8 min | 58 s |
| `qwen3vl_8b_int8_convrot.safetensors` | 9 350 798 360 | 6.2 min | 75 s |
| `qwen_image_2.1_vae_bf16.safetensors` | 675 509 688 | 27 s | 5 s |
| **together** | **17 283 091 112** (17.28 GB) | **11.5 min** | **2.3 min** |

The session's whole download becomes 80.46 GB, about 54 minutes at 200 Mbit/s and 11 at 1 Gbit/s, and the 150 GB disk the plan rents still holds it with room for torch and the pictures. The link is measured once while the downloads run, and a machine below 200 Mbit/s is meant to be destroyed rather than waited for — with the opt-in on, that decision is worth twelve more minutes than without it.

The same three files in bf16 would be 32.44 GB, which does not fit one 32 GB card anyway; the reasoning is written out in the manifest beside the pins. Nothing of Krea's is replaced, so one prepared box draws both and the blind comparison has something to compare.

The bootstrap writes two graphs beside the Krea one: `image-workflow-qwen.json` draws frames, `image-workflow-qwen-edit.json` takes reference portraits. One run has one workflow, so Qwen is its own `image:batch` run directory, and `npm run image:blind -- build --run a,b --out <directory>` reads several of them.

### What the card keeps of a picture

A picture of a reader's scene passes through three places on the card, and each is emptied without a restart:

- **The job record** in `/history`, which holds the whole prompt and the workflow. The bot deletes it as soon as it has the picture (`drawOne` in [image-batch.ts](../local/image-batch.ts)).
- **The file** the preview node writes and `/view` hands to the bot. `drawOne` gives the preview node a key of its own for every job. Without it, a graph identical to the last one was answered from ComfyUI's cache, whose output named the earlier job's file, already swept: `/view` answered 404 to the second sample of one style on one scene, found on 2026-09-24. The key changes only that node's cache signature: the sampler's result still comes from the cache, and the repeat took 4–5 s against 17 s. No route of ComfyUI's API deletes the file, so [image-serve.sh](../gpu/image-serve.sh) puts the temp directory in RAM, at `/dev/shm/simple-chat-comfy` with mode 0700, and refuses to start when `/dev/shm` is not a writable tmpfs. [image-sweeper.py](../gpu/image-sweeper.py) runs beside the server, reads `/history` once a second and deletes a file no record names once the file is 5 s old, a few seconds after the bot's delete. Any file older than 10 minutes goes whatever names it, and so does a record whose job ended 10 minutes ago, left by a bot that died between the drawing and its delete. While `/history` cannot be read only the 10-minute rule applies. The sweeper stops by itself when the server does; its rows in the server's log are counts and codes.
- **The server's memory.** ComfyUI caches each node's output for the next job, keyed by the node's inputs, so the last job's conditioning, latent and decoded picture, and its prompt inside the keys, stay in RAM until the next job has run its first node or the server stops. `POST /free` would clear them, but at the pinned revision it cannot do that without unloading the models, and every picture would then pay a cold start: 26.3 s against 17.2 s warm. That is accepted.

The last point holds for one job only because of the card's size. The pinned build's default cache, the RAM-pressure one, drops the entries a new job does not use only while free RAM is under a threshold, which is the container's RAM capped at 128 GiB. The current card's container has 120 GiB, so free RAM is always under it and older jobs go at once. On a container with more they would stay until RAM runs short, and `--cache-classic` in `image-serve.sh` would bound them to the last job again. None of this reaches a disk only because the container cannot swap: the current card's `/sys/fs/cgroup/memory.swap.max` is 0, although its host has a swap device, and a container that may swap can put the tmpfs there too.

`output/` keeps what the batch harness saved and `input/` its reference portraits, synthetic scenes only, until the card is destroyed. A server started before the sweeper existed wrote its previews to `ComfyUI/temp` on the disk, which the sweeper does not watch: empty that once by hand.

## Diagnosing connection failures

In the night before 17 September the model checks and two compactions failed because of SSH. The model server worked without restarts, and the GPU memory was used as usual. New connections through the tunnel hung, and the already open ones continued to pass data. The cause of the hangs was not found at that time. The server log stayed on the instance and was lost together with it. So start the next rental with the logs.

### Bot log

The bot writes technical events to stdout. Without a redirect they are lost together with the terminal.

```sh
mkdir -p logs && chmod 700 logs
npm run start:gpu 2>&1 | tee -ai logs/bot-gpu.jsonl
```

The `-i` flag is required. Ctrl+C goes to the whole pipeline, and an ordinary `tee` ends before the bot. Then the rows about the shutdown, including the GPU stop request, do not reach the file. The `logs/` directory is excluded from git.

### Compaction rows

Every row about a user request carries the `actor` field. For the owner from `SIMPLE_CHAT_OWNER_ID` it equals `owner`, for everyone else `other`. The ID does not reach the log. The label shows whose failure it was, and for this you do not need to open anyone's library. The `other` rows belong to stories that must not be read.

Manual and automatic compaction write the same events:

| Event | When |
| --- | --- |
| `compaction_request_started` | Before every request to the model. This is an extraction, a retry with half of the scenes after `context_limit`, or a repair request for missed scenes. |
| `compaction_request_completed` | The model answered. The row has the `inputTokens` and `outputTokens` of this request, `waitMs` in the queue and llama-server's timings (below). |
| `compaction_request_prepared` | Instead of `completed`: the answer was prepared while the person read (below). |
| `memory_compacted` | The memory is saved. The row has `factCount`, `inputBytesBefore` and `inputBytesAfter`. |

Earlier a successful automatic compaction left no row in the log. A failure still writes one `generation_failed` row with `operation: compact`, and now it has the same numbers.

- `automatic` equals `true` if the compaction started by itself before a scene.
- `sceneCount` shows how many scenes the attempt compacts. After `context_limit` the bot repeats the request with half of the scenes, and the number in the next row is smaller.
- `repairSceneCount` shows how many missed scenes the bot asked for in the repair request. For the first request it is zero.
- `requestBytes` contains the size of the request to the model in bytes.
- `outputCharacters` shows how many characters of the answer had arrived when the row was written.
- `elapsedMs` is counted from the start of the compaction. The duration of one request equals the time difference between its `started` and `completed` rows.

### Where the time of a request goes

`compaction_request_completed` and `scene_request_completed` carry numbers only: `waitMs` in the model queue (for a scene, both its token count's and its request's), `estimateTokens`, the bot's estimate of the scene request before any count, and `countMs` of the token count itself (scene rows; absent when the scene was sent on its estimate), `elapsedMs` of the scene request, and llama-server's own timings from the last stream chunk: `cacheTokens` taken from the cache, `promptTokens` and `promptMs` of the prefill, `predictedTokens` and `predictedMs` of the decoding, `draftTokens` and `draftAcceptedTokens` with speculative decoding. A hosted provider sends no timings.

### Compaction prepared while the person reads

The extraction a compaction sends depends only on the branch, not on the person's next action. So when a scene's input and output together reach the compaction threshold, the bot asks the model for the next turn's extraction (and repair, if scenes are missed) right after sending the scene, while the person reads (`local/prepare.ts`). Nothing is saved then: the next turn takes a prepared answer only for an identical request and checks and saves it as usual, so a changed branch simply asks the model again. The rows are `compaction_prepare_started` and `compaction_prepare_finished` / `compaction_prepare_failed` with `elapsedMs`, and one `compaction_prepare_request_completed` per request with its counts and timings, whether the answer is used later or not. An answer is handed to the turn only after it passes the same check the turn would make; otherwise the turn asks the model itself. The run holds the GPU like a job and runs only on a GPU that is ready. It never makes anybody else wait: a call of any other person ends it at once (`background_preempted`). Its own person's next turn waits for a started run and takes its answers; a run still waiting in the queue, or one for another branch point, is stopped instead. The answers stay in the bot's memory, never on disk.
- `inputBytesBefore` and `inputBytesAfter` contain the size of the request for the next scene before and after compaction. The `memory_not_smaller` error comes with them too.

The failure row tells where the request broke. `provider_failed` with `outputCharacters: 0` means that the connection was lost before the first character of the answer, while the server processed the input. A non-zero value means a break in the middle of the answer. `memoryReason: coverage` comes with `sceneCount` and `missingCount`, that is, with the number of requested and missed scenes. If `repairSceneCount` is greater than zero in that row, it was the repair request that failed, and `sceneCount` counts only its scenes.

`npm run memory:probe` writes the same rows for synthetic compactions and puts the time into each of its rows. These rows contain no scene text, no facts and no identifiers. Only the fields from the whitelist in `local/model-error.ts` pass into the log.

### State snapshot

```sh
npm run gpu:diagnose
npm run gpu:diagnose -- --watch 30
```

At one and the same moment the command asks the model server over two paths. The first path goes through port `127.0.0.1:8080`, which the bot forwarded. The second path opens a separate SSH session and contacts the server on its own loopback. The comparison answers the question of the past failure: is SSH at fault, or llama-server.

Through the tunnel the command repeats the bot's check: `/v1/models`, then `/props`, with a total deadline of 8 seconds. So its result can be compared with the `gpu_check_failed` events in the bot log. It does not compare the model name and the context size.

Without flags the command makes one snapshot through a new SSH session. With `--watch` it opens one session, keeps it open and receives a snapshot over it every 30 seconds until you press Ctrl+C. The interval can be set from 10 to 3600 seconds. Last time new SSH sessions hung too, and the already open ones continued to work. So `--watch` must be started at the beginning of the rental, before a failure. A snapshot requested during a failure will most likely show only `ssh_unreachable`.

The command changes nothing on the instance and does not require uploading files. The script `gpu/diagnose-remote.py` is passed to `python3` through the same SSH session. The command does not read Telegram, the story database or the server output. Addresses, raw SSH errors and arbitrary strings from the remote side do not reach the report. Every snapshot is printed as one line of JSON and is appended to `logs/gpu-diagnose.jsonl`. The SSH alias is taken from `SIMPLE_CHAT_GPU_SSH_HOST` in `.env.gpu`, as for the bot. A different alias is set through `--host`. `--watch` opens a lost session again and records how it ended. A watch process forgotten on the instance ends by itself after one hour.

The conclusion is written in the `reading` field:

| `reading` | What happened |
| --- | --- |
| `ok` | The check passed over both paths. The duration of the answers is written in the `seconds` fields. |
| `no_tunnel` | Nothing listens on local port 8080. The bot is not running, the GPU is paused or the tunnel is reconnecting. |
| `ssh_path` | The server answers on its own side, but there is no answer through the tunnel. This is how the failure of 17 September looked. Look in the sshd of the instance, the Vast proxy or the network. |
| `server` | llama-server did not pass the check even on its own loopback, where every answer is given 5 seconds. |
| `ssh_unreachable` | The separate SSH session did not open or broke. The cause is written in `direct.sshReason` and `direct.exitCode`. |
| `ssh_stalled` | The `--watch` session is open, but the next snapshot did not arrive in time. This means that the already open connections stalled too, which did not happen on 17 September. |
| `unclear` | The session opened, but there is no report. Most often the instance has no `python3`. |

The other fields refine the conclusion:

- `remote.processes.sshd.startups` shows how many SSH connections have not yet passed authentication, by the count of sshd itself. Starting from `dropFrom` sshd drops a part of new connections, and at `dropAllAt` it drops all of them. `unauthenticated` counts the same connections by processes. `sessions` counts open sessions without the diagnosis's own session. The bot's tunnel gives one.
- `remote.sockets` counts the TCP connections of the model port on the instance. A growth of `established` or `closeWait` with `reading: server` points to a llama-server that holds old connections.
- `remote.container` shows the limits of the container itself. Growing `throttledPeriods` and `throttledSeconds` mean that Vast limits the CPU of the container. `pressure` shows what share of the last 10 seconds the processes waited for CPU, disk or memory. With such waiting a new SSH session can hang although the network is fine. If `pressure.scope` equals `machine`, the kernel gives these numbers only for the whole machine together with other people's containers.
- `remote.machine` refers to the whole rented machine together with other people's containers.
- `remote.gpus` contains the memory, the load and the temperature of each card. Values that the driver does not report are omitted.
- `remote.failed` lists the parts of the snapshot that could not be read. The other parts arrive as usual.
- `remote.processes.llamaServer[].ageSeconds` shows whether the server was restarted.
- `remote.serverEvents.rows` contains the last events from `server-events.jsonl`: 25 in a single snapshot and 5 in every `--watch` snapshot.
- `direct.seconds` shows how long the separate SSH session lasts.

### At the beginning of the rental

Three checks take a couple of minutes and change nothing.

1. After the bot starts, run `npm run gpu:diagnose -- --watch 30` in a separate terminal and leave it until the end of the rental. The first snapshot must show `ok`.
2. Find out whether SSH goes directly or through the Vast proxy:

   ```sh
   ssh -G simple-chat-vast | grep -Ei '^(hostname|port|proxyjump|proxycommand) '
   ```

   A name of the form `sshN.vast.ai` means a proxy. A direct connection goes to the IP of the machine. The output contains an address, do not save it into the project.
3. Check the path to the SSH host. Put the `hostname` from the previous step in place of `HOST`.

   ```sh
   tracepath -n HOST
   ping -M do -s 1472 -c 5 HOST
   ping -M do -s 1400 -c 5 HOST
   ping -M do -s 1300 -c 5 HOST
   ```

   Losses at 1472 with success at the smaller sizes mean an MTU problem on the path. The analysis of the past failure considers it unlikely, but does not rule it out. If no size passes, the host does not answer ping and the check tells nothing.

### During a failure

Do not restart anything while `--watch` writes snapshots: they are the very goal of the rental. Next to them look at the `gpu_connection_closed` events in the bot log. They show how each ssh process ended: `connectionAgeMs`, `exitCode`, `signal` and `sshReason`. The start moment of the process equals the event time minus `connectionAgeMs`.

- `keepalive_timeout` means that the server did not answer the ssh checks for 45 seconds: `ServerAliveInterval=15` and three misses. The connection hung, but nobody closed it.
- `connection_lost` means that the connection was closed or reset by the remote side or by a node on the path.
- `port_in_use` or `authentication` right after the start mean a busy local port 8080 or an authentication refusal.

After a failed attempt the bot waits 10, then 20, then 30 seconds each time before a new ssh start. Earlier it started ssh on every 10-second check, and interrupted attempts could pile up on the sshd side. A tunnel that worked for a minute reconnects at once. A GPU pause and a GPU start reset the delay. While the bot waits, its checks write `gpu_check_failed` with `phase: ssh_wait`. Such a row means that ssh was not started at that moment.

### Before deleting the instance

```sh
npm run gpu:diagnose -- --pull
```

The command saves all events of `server-events.jsonl` together with the rotations to `logs/gpu-server-events-DATE.jsonl`. Only the time, the event name, the category, the PID, the exit code and the signal reach the file. After the instance is deleted, there will be nowhere to get them from.

## Ending the rental

### Pause from Telegram

To control a specific instance, put its ID in `.env.gpu` as
`SIMPLE_CHAT_VAST_INSTANCE_ID`, and the key in the private `.env.gpu` or `.env` as
`SIMPLE_CHAT_VAST_API_KEY`. Create a separate key with the rights to read and change
only this instance. In our run `CONTAINER_API_KEY` worked inside the
container, but from the bot's computer it returned 401; it was not used for
local control.

In the verified Vast key interface the `id` constraints are set under the HTTP method:
`api.instance.show` → `GET` → `constraints`, `api.instance.manage` → `PUT` →
`constraints`; the constraint value is `{"id":{"eq":INSTANCE_ID}}`. The right
`api.instance.destroy` → `DELETE` with the same constraint is needed only by the separate
deletion timer. The bot itself uses GET/PUT and does not create new rentals.

The SSH alias `SIMPLE_CHAT_GPU_SSH_HOST` must point to the same instance with a
verified host key. Put the project's GPU scripts in
`/workspace/simple-chat/gpu/`. The managed bot opens the tunnel on local
port 8080 by itself and runs `ensure-server.sh`; a separate `gpu/tunnel.sh` is not
needed in this case. First run the bootstrap and the model probe.

The buttons «Пауза GPU» ("Pause GPU") and «Запустить GPU» ("Start GPU") appear in `/model`; the same actions are available
through `/gpu_pause` and `/gpu_start`. The control is shared by all admitted
users. The pause waits until all active scenes and compactions end, and it closes
the intake of new jobs. One scene holds the GPU both during the automatic
compaction and during the generation that follows it.

`SIMPLE_CHAT_GPU_IDLE_MINUTES=15` sets an auto-pause 15 minutes after the last
work for the model ends. A reader's scene or compaction and an agent's turn count
from their start to their end, the gaps between their requests included; an eval or
a probe counts request by request, each from the moment the bot's queue takes it.
The timer does not run while any of this work lasts and starts again when the last
of it ends, so our own work keeps the card up for as long as it goes on: only the
rental's own guard (see [Renting](#renting)) stops the card under it. A pause from
Telegram waits for the readers' jobs and for an agent's turn, but stops an eval's
request within a second. The check runs every 10 seconds. Viewing the menu and the
status does not reset the timer. An ordinary message does not start a stopped rental.
After an explicit start the bot waits until the GPU, SSH and the model are available. A free card
after a pause is not guaranteed: Vast may wait until it is released.

«На паузе» ("Paused") is shown only after Vast confirms the stop.
An API error does not mean that the payment stopped. The disk is paid for
separately during a pause; check the rate on the instance card.

After a successful check the bot keeps the readiness for at most 30 seconds during a
temporary failure of the API or of the model check. Repeated errors do not extend this
period. This way a single failure does not block the next request. A confirmed stop,
a mismatch of the instance or of the model, a manual pause and the expiry of the idle period cancel
the admission at once. The idle period is checked even when the API is unavailable.

A technical error contains a safe code, the HTTP status if one was received,
the stage and the known transport code; unknown transport codes are marked
as `other`. For SSH the process exit, the signal and a fixed category of the
connection error are saved. A timeout of the model check differs from a cancellation by the user.
The texts of prompts, of scenes, of server errors and the request addresses do not reach the log.
The old general code `provider_failed` does not allow you to recover the exact cause
of a past failure or to draw a conclusion about content filtering.

The timer works while the computer with the bot is on and has access to the Vast API.
A correct shutdown of the bot also requests the GPU stop; an emergency power-off
of the computer does not guarantee this. A limited test needs a separate deletion
deadline for the instance and a check that it was carried out. Stories and checkpoints are
in the local database and do not depend on the pause.

### Deletion

The rental is billed per minute, so a pause longer than two or three minutes is a reason to stop the machine: running costs about $0.01 per minute, and storage of a stopped machine costs $0.017 per hour. But the disk is tied to the host, and while the machine is stopped, another renter can take its card; the storage is still charged during that time. The rule: for a pause inside a work session (up to two or three hours), stop the machine, and if the machine did not come up within a couple of minutes, delete it and take another one, the loss is one cent; for "that is all for today" or when the return time is unknown, delete at once: a preparation from zero on a good link costs about $0.15 and 15 minutes, and a night of storage costs $0.20.

Stopping the model process or the SSH tunnel does not end the rental. The managed bot requests the stop through the API on a correct shutdown, but the result must be confirmed in Vast. The instance must be stopped or deleted on the side of the service; after a stop the disk storage is still paid for. Before the deletion check where the files that you need are, and save the server log through `npm run gpu:diagnose -- --pull`. In the described scheme the stories are on the bot's machine, and the GPU has the weights, which are downloaded again, and the build. [Vast billing rules](https://docs.vast.ai/guides/instances/pricing).

`gpu/trial-onstart.sh` is meant only for a one-time run on artificial stories. As a Vast onstart script it saves the initial deadline and requests the deletion of its own instance after three hours; a repeated start does not extend the deadline. It uses only the `CONTAINER_API_KEY` issued to this instance. You can pass `SIMPLE_CHAT_SSH_PUBLIC_KEY` to add a public key only inside this container. The script is not a Vast money limit: a disconnected container does not run its timer, and a network failure can delay the deletion. An external check that the rental ended is needed. Do not use such a template for permanent work with data.

SSH protects the data in transit. The administrator of the rented host still controls the machine on which the prompt is processed; take this into account when you choose a place for personal stories.
