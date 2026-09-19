# Gemma on a rented GPU

Verified on 17 September 2026 on an RTX 5090 32 GB: CUDA 13, Q4_K_M and Q6_K, a 65536 window and a synthetic input of about 59000 tokens. This is a check of capacity and protocol; whether facts are kept in a story is checked separately.

The bot and SQLite stay on the computer or on a separate server. Only llama.cpp runs on the GPU; the connection goes through SSH. You do not need to move the Telegram token or the story database there. With every request the model server receives the story context that it needs.

## What we run

We use [Gemma 4 31B IT Uncensored Heretic, GGUF](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF), file `Q6_K`, 25 201 484 928 bytes. This is a dense model. The uncensored status stated in the model card does not guarantee narration quality or that facts are kept: this is checked on stories separately.

[manifest.env](../gpu/manifest.env) pins the model revision, the file name, the size and the SHA256, and also the commit of [llama.cpp 0.4.1](https://github.com/ggml-org/llama.cpp/commit/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4). The script verifies the file after the download. A version update is a separate change of the manifest and a repeated check.

For the first run we choose one RTX 5090 with 32 GB VRAM, at least 32 GB RAM and 60 GB of disk. You need a CUDA development image with `nvcc`, CUDA 12.8 or newer and a compatible driver; the build architecture for the 5090 is `120`. An On-demand rental fits a short test without a monthly commitment. The exact price, the disk fee and the traffic fee are checked on the chosen offer. The traffic price on Vast differs between machines by a factor of twenty: from $2.6 to $52 per TB. Downloading the weights (25 GB) on a machine with $39/TB cost about one dollar, which is more than an hour of the rental itself; on a machine with $2.6/TB it costs seven cents. So compare offers by the sum "hour + download", not by the hourly price alone.

The run was done on the image `vastai/base-image:cuda-13.0.3-cudnn-devel-ubuntu24.04-py312-2026-09-07`, digest `sha256:c1d2b5326fae806b04d2c2d97a2b3948d0ccb0026dd3085e9a2ad55e304193f8`, with driver 580.142 and nvcc 13.0.88. The launch was SSH direct, 60 GB of disk, with no published HTTP ports. The CUDA 12.8 template seen earlier does not describe this verified launch.

The configuration of the parent model has 60 layers: 50 with a local window of 1024 and 10 with full attention. We run one slot with a context of 65536, Flash Attention and a Q8 KV cache. We do not enable the full KV cache for the local layers. [Model configuration](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic/blob/main/config.json).

With microbatch 128, Q4 used about 22206 MiB of VRAM and Q6 used 28394 MiB; Q6 had about 4213 MiB left. For an input of 59097 tokens the first text arrived after 33.8 s on Q4 and 38.4 s on Q6. The repeated request used 59093 cached tokens and gave the first text after 5.1 and 4.4 s respectively. These are single measurements, not a guaranteed speed. The long probe found a violation of the instruction about the fixed scene time on the repeated request; the whole run cannot be counted as free of errors.

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

From the project root upload only the scripts:

```sh
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
scp gpu/*.sh gpu/server-log.py gpu/manifest.env simple-chat-vast:/workspace/simple-chat/gpu/
ssh simple-chat-vast
```

The container needs `git`, `cmake`, `ninja`, `curl`, `python3`, a C++ toolchain and a CUDA compiler. For an Ubuntu image you can install the missing packages like this:

```sh
apt-get update
apt-get install -y git cmake ninja-build curl python3 build-essential libssl-dev
bash /workspace/simple-chat/gpu/bootstrap.sh
bash /workspace/simple-chat/gpu/ensure-server.sh
```

`nvcc` must be part of the chosen development image. The host driver is not installed this way. The preparation downloads about 25.2 GB of weights and builds `llama-server`. By default the weights go through `aria2c` with 16 connections (if the image does not have it, the script installs it through `apt-get`; if that fails, the script downloads with a single `curl`). The download runs in the background while `llama-server` is built, and the script waits for it after the build; on an 850 Mbit/s link the weights arrived in six minutes, before the end of the build. `SIMPLE_CHAT_BUILD_JOBS` sets the number of build threads (4 by default). `SIMPLE_CHAT_DOWNLOAD_CONNECTIONS=1..16` changes the number of connections, and `1` brings back the single download. An interrupted parallel download continues from the place where it stopped; SHA256 is verified as before. By default the files are in `/workspace/simple-chat-gpu`; `ensure-server.sh` leaves one process under `flock` after SSH disconnects. In the verified image we had to restore the missing `libisl.so.23` by reinstalling `libisl23 libmpc3 libmpfr6 libgmp10 gcc-13 g++-13 build-essential`, and then configure CMake again with `--fresh`.

It is convenient to watch the preparation from the bot's computer: `ssh -t simple-chat-vast bash /workspace/simple-chat/gpu/progress.sh`. The screen refreshes once every three seconds and shows the downloaded amount of weights, the speed over the last half minute and the remaining time, and for the build it shows the completed steps out of the total number and the remaining time. The script only reads, and it exits by itself when the weights are verified and `llama-server` is built. The link speed stated in the offer promises nothing: on a machine with "1171 Mbit/s" the weights came from Hugging Face at 115 Mbit/s, about half an hour.

The bot writes one scene at a time, and the server starts with one slot by default; the bot's client checks this. The research batch (`memory-probe.ts --lab`) starts the server with `SIMPLE_CHAT_GPU_SLOTS=2..8`: the slots share one KV cache of the same size (`--kv-unified`) for the full-attention layers, but each slot adds its own sliding-window cache, about 425 MiB at q8 (an estimate from the model's layers, not measured). With 5 slots the batch took 8 s per scene against 15 s with one slot; about three requests were in flight at a time, so this is a 1.9x gain rather than 5x. Before the bot returns to the GPU, the server is restarted without this variable.

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

For llama.cpp compaction starts by default at 44000 input tokens, the total context is 65536, and the answer reserve is 4096. At most 12 paragraphs stay in the narrative prompt. The 44000 threshold gives a margin before the technical limit; it does not establish the degradation boundary of Gemma. The battle, chess and dance probes compact the memory manually three times at a much smaller context. They check consecutive compactions, but they do not replace a quality check at 44K.

Compaction passes a JSON Schema to llama.cpp through `response_format`: the format constraint works during generation. Then the code checks that the answer is complete, the references to scenes, the coverage and that the request became smaller. The original JSON is saved, and `local/prompt.ts` turns it into text with dates, fact types and sources, without a second retelling by the model. The seed, the chain of memory increments and the last uncompacted scenes form the context of the selected checkpoint. The structure checks do not confirm that every extracted fact is true.

With `SIMPLE_CHAT_MEMORY_REPAIR_COVERAGE=true` the `plain` mode allows one additional request for missed scenes. By default this repair is turned off, so that memory quality can be checked separately. The additional request receives the draft of facts and the preceding scenes for understanding, but the references in the new facts may point only to the missed scenes. The draft is not saved separately: the whole memory increment passes the common check and is written in one transaction. A repeated miss, a broken connection or a growth of the memory size leaves the original context unchanged. The JSON counter in the progress message shows characters, not tokens.

Q4 and Q6 each went through three artificial stories: a battle, chess and dance, with 16 scenes and three compactions in each. The archives, the source references and the branching were checked; semantic errors remained. Q6 produced a wrong chess FEN, and in the sum of dance repetitions it missed a training session that was present in the memory. A successful save of the JSON does not mean that the model uses it correctly when it continues the story. The inputs of these stories stayed below 8K tokens. Q4 and Q6 had different summarization rules and a different memory representation, so the comparison does not isolate the effect of quantization.

An unfinished stream, a tool call and a mismatch of counters do not become a finished scene. There is no automatic retry of generation after a network error. The total timeout of a GPU call in the example is 10 minutes; there is no separate timeout for an idle stream yet. This is a limit of waiting, not a promise of speed. A cancellation closes the HTTP stream. The probe after a cancellation checks that the slot is available and reports the delay; a successful next answer by itself does not yet prove that the computation on the server stopped immediately.

## Background memory comparison

The bot has one computation queue in `local/scheduler.ts`. User requests are served in order. A background probe starts a computation after 60 seconds without user requests. A new user request cancels the background computation; the probe repeats only its own unfinished step. User answers are not repeated automatically.

One background call is limited to 90 seconds. It is allowed only when the GPU is ready, there are no user jobs and more than 100 seconds remain before the auto-pause. The background work does not start a rental, does not reset the idle timer and yields to a manual pause. The pause and the unavailability are checked every second. The model has one slot, so the background work can evict the story cache and increase the time to the first text of the next user answer. A turn, a person's or an agent's, keeps the model slot from the start of its first call until it ends, so no other turn or probe runs between its compaction steps and its scene and evicts its cache (the compaction and the scene share only a common prefix, so the scene still has its own prefill). A person's turn is never cut off. Agent turns ([agent interface](agent-interface.md#model-access)) have their own queue: they wait for the same quiet window, start only if they can end before the auto-pause and have no 90-second limit, but a person's call ends an agent's whole turn at once: a person never waits for an agent. A started agent turn holds the GPU through a pause without resetting the idle countdown. A person waiting for the model sees how many requests are ahead: before a scene in the disappearing draft the scene then streams into, and in the compaction status. Only the count is shown, never whose requests they are; when the model starts reading the scene request, the draft says so until the text arrives.

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

`compaction_request_completed` and `scene_request_completed` carry numbers only: `waitMs` in the model queue (for a scene, both its token count's and its request's), `countMs` of the token count itself (scene rows), `elapsedMs` of the scene request, and llama-server's own timings from the last stream chunk: `cacheTokens` taken from the cache, `promptTokens` and `promptMs` of the prefill, `predictedTokens` and `predictedMs` of the decoding, `draftTokens` and `draftAcceptedTokens` with speculative decoding. A hosted provider sends no timings.

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
operation. The check runs every 10 seconds. Viewing the menu and the status does not
reset the timer. An ordinary message does not start a stopped rental.
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
