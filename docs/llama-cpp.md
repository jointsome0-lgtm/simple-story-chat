# llama.cpp on a rented GPU

How to run the `llama-cpp` provider: Gemma on a rented card, reached over SSH. This is a working instruction for as
long as the bot offers that provider. Renting, SSH access and ending a rental are in [gpu.md](gpu.md), under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). Comparing server profiles is in
[llama-measurement.md](llama-measurement.md), and the numbers of past rentals are in
[gpu-measurements.md](knowledge/gpu-measurements.md).

<a id='requirements'></a>

## What we run

The bot and SQLite stay on the computer or on a separate server. Only llama.cpp runs on the GPU; the connection goes through SSH. You do not need to move the Telegram token or the story database there. With every request the model server receives the story context that it needs.

We use [Gemma 4 31B IT Uncensored Heretic, GGUF](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF), file `Q6_K`, 25 201 484 928 bytes. This is a dense model. The uncensored status stated in the model card does not guarantee narration quality or that facts are kept: this is checked on stories separately.

[manifest.env](../gpu/manifest.env) pins the model revision, the file name, the size and the SHA256, and also the commit of [llama.cpp 0.4.1](https://github.com/ggml-org/llama.cpp/commit/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4). The script verifies the file after the download. A version update is a separate change of the manifest and a repeated check.

For the first run we choose one RTX 5090 with 32 GB VRAM, at least 32 GB RAM and 60 GB of disk. You need a CUDA development image with `nvcc`, CUDA 12.8 or newer and a driver that runs the image's CUDA (the pinned image is CUDA 13, so the offer query asks for a host whose driver runs 13.0; a 570 driver stops at 12.8); the build architecture for the 5090 is `120`. Choose the offer by the price of the hour and of the
download together, as [gpu.md](gpu.md#renting) describes.

The configuration of the parent model has 60 layers: 50 with a local window of 1024 and 10 with full attention. We run one slot with a context of 65536, Flash Attention and a Q8 KV cache. We do not enable the full KV cache for the local layers. [Model configuration](https://huggingface.co/llmfan46/gemma-4-31B-it-uncensored-heretic/blob/main/config.json).

The launch of 2026-09-17 on this configuration, its video memory and its times are in
[gpu-measurements.md](knowledge/gpu-measurements.md#verified-2026-09-17). They are single measurements, not a
guaranteed speed.

<a id='prepare-server'></a>

## Preparing the server

Rent the machine, reach it over SSH and copy the scripts as [gpu.md](gpu.md#ssh-access) describes. Then:

The container needs `git`, `cmake`, `ninja`, `curl`, `python3`, a C++ toolchain and a CUDA compiler. For an Ubuntu image you can install the missing packages like this:

```sh
apt-get update
apt-get install -y git cmake ninja-build curl python3 build-essential libssl-dev
bash /workspace/simple-chat/gpu/bootstrap.sh
bash /workspace/simple-chat/gpu/ensure-server.sh
```

`nvcc` must come with the development image; the host driver is not installed this way. The bootstrap downloads
about 25.2 GB of weights through `aria2c` with 16 connections while it builds `llama-server`, and waits for the
weights after the build. Without `aria2c` it installs it through `apt-get`, and failing that it downloads with one
`curl`. `SIMPLE_CHAT_DOWNLOAD_CONNECTIONS=1..16` sets the connections. An interrupted download continues where it
stopped, and SHA256 is verified. `SIMPLE_CHAT_BUILD_JOBS` sets the build threads. The default is the container's
share of the cores, read from the cgroup, or fewer when its memory is short (about 2 GiB per CUDA job), so that the
build ends before the weights arrive. The files go to `/workspace/simple-chat-gpu`, and `ensure-server.sh` leaves one
process under `flock` after SSH disconnects. Measured times and the `libisl.so.23` repair the verified image needed
are in [gpu-measurements.md](knowledge/gpu-measurements.md#container-and-build).

`ssh -t simple-chat-vast bash /workspace/simple-chat/gpu/progress.sh` shows the preparation every three seconds: the
weights downloaded, the speed over the last half minute, the build's steps and the time left. It only reads, and it
exits once the weights are verified and `llama-server` is built. The speed an offer states promises nothing
([an example](knowledge/gpu-measurements.md#costs-and-downloads)).

`SIMPLE_CHAT_GPU_DRAFT=true` turns on speculative decoding with the draft model pinned in
[manifest.env](../gpu/manifest.env): the bootstrap fetches it beside the weights, and `serve.sh` starts the server
with it. Without the setting nothing fetches or uses it. On 2026-09-20 it doubled the writing speed on one slot and
did not fit beside a pool of three slots ([the measurement](knowledge/gpu-measurements.md#pool-2026-09-20)).

The server starts with one slot unless told otherwise, and the bot's client checks the number. The research batch
(`memory-probe.ts --lab`) starts it with `SIMPLE_CHAT_GPU_SLOTS=2..8`, each slot with its own
`SIMPLE_CHAT_GPU_CONTEXT` cells and its own sliding-window cache of about 425 MiB at q8 (an estimate from the model's
layers, not measured), unless `SIMPLE_CHAT_GPU_KV_UNIFIED=true` with `SIMPLE_CHAT_GPU_POOL` makes them share one
cache. With 5 slots the batch took 8 s a scene against 15 s with one: about three requests were in flight at a time,
a 1.9x gain rather than 5x. Before the bot returns to the GPU, restart the server with the settings the bot expects.

The server listens only on `127.0.0.1:8080`. You do not need to publish this HTTP port on the internet. Slot snapshots to disk and the additional RAM cache of snapshots are disabled; the ordinary KV cache of the current slot stays in memory.

`server-log.py` saves the start and end time of the model, the exit code or signal and the error categories to `/workspace/simple-chat-gpu/server-events.jsonl`. The original server output is processed only in memory and is not saved: even an error message can contain a part of the request. The llama.cpp level is errors only; logs of prompts, of JSON packets and core dumps are disabled. The file has `0600` permissions and two rotations of 1 MiB each. The error category helps the diagnosis, but by itself it does not prove the cause of the error.

## Connection and check

On the bot's computer, in a terminal of its own:

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

`.env.gpu` holds the model and GPU-control settings on top of `.env`, which keeps the bot token and the database
path; git ignores both. A gateway of your own takes `SIMPLE_CHAT_BASE_URL` and `SIMPLE_CHAT_API_KEY`: HTTPS, or
plain HTTP over loopback only, passing the routes of the pinned llama.cpp version, `/props` and token counting
included.

The probe does not contact Telegram or the database. It uses an artificial plot and prints only counters and statuses:

- the model name matches, the number of slots and the context size;
- a streamed answer with a date, and no service tags;
- a repeated request with a shared prefix and the number of cached tokens reported by the server;
- a refusal before generation when the input limit is exceeded;
- JSON Schema is followed in spite of a request to answer in plain text;
- a cancellation during the answer and a successful request after it;
- with `--long`, a request of about 60000 input tokens.

`firstTextMs` includes the token count, the queue and the input processing. `cachedInputTokens: null` means there is
no counter, not an empty cache. The probe fails when the input prefix is not reused (32 tokens of tolerance at the
template boundary; with `--long`, also on the repeat of the long request) and when a separate `reasoning_content`
appears, although ordinary generation may still work. Compare the counters with the time of the repeated request. A
large synthetic request checks capacity and protocol, not story quality. During the long probe watch the card's
memory:

```sh
nvidia-smi --query-gpu=memory.used,memory.free,utilization.gpu --format=csv
```

The initial microbatch is 128. `SIMPLE_CHAT_GPU_UBATCH=512` is a way to compare, not a measured speed-up: after you
measure VRAM, restart the server with it and run the same probes. For diagnosis read the categories in
`server-events.jsonl`; do not enable saving of the raw output when personal stories are processed.

## Switching the bot

After a successful probe stop the running bot with Ctrl+C, wait until it ends, and run `npm run start:gpu` in the
same project. The database is the same, with its seeds, branches and checkpoints behind the same buttons, but the
previous provider's context measurements do not calibrate the next request. `npm start` goes back to the ordinary
`.env`. Never run two poller processes at the same time.

Before generation [the adapter](#adapter) counts the input on the server. Without the counting route the work stops,
and a rough estimate does not replace it. One exception saves that call, about a second over the tunnel, where the
answer is not in doubt. A scene goes on the bot's own estimate while it is below 90% of the compaction threshold, if
the estimate is anchored on the last scene's measured input, or below 50% if it is not. A picture description goes
on its estimate, the scene's measured input and output plus its instruction, while that is below 90% of the context
less the description's answer reserve. Compaction requests are always counted. When the count the server reports
with the answer is over the limit, the answer is dropped with `context_limit` and the branch compacts
(`local/generation.ts`, `local/llama.ts`).

For llama.cpp compaction starts by default at 44000 input tokens, the total context is 65536, and the answer reserve is 4096. At most 12 paragraphs stay in the narrative prompt. The 44000 threshold gives a margin before the technical limit; it does not establish the degradation boundary of Gemma. The battle, chess and dance probes compact the memory manually three times at a much smaller context. They check consecutive compactions, but they do not replace a quality check at 44K.

Compaction passes its JSON Schema to llama.cpp through `response_format`, so the format constraint works during
generation. What the code checks afterwards and how the memory is saved are the same for every provider:
[model-providers.md](model-providers.md#memory-and-context). The Q4 and Q6 story probes are in
[gpu-measurements.md](knowledge/gpu-measurements.md#production-story-probes); their summarization rules differed, so
they do not isolate quantization.

`.env.gpu.example` gives a GPU call 10 minutes in all, a limit of waiting rather than a promise of speed; there is no
separate timeout for an idle stream yet. A cancellation closes the HTTP stream. The probe after a cancellation checks
that the slot is free and reports the delay, which alone does not prove that the server stopped computing at once.

## Background memory comparison

The bot has one computation queue, `local/scheduler.ts`, and serves user requests in order. A background probe starts
after 60 seconds without user requests. A new user request cancels it, and the probe repeats only its own unfinished
step; user answers are never repeated automatically.

- A background call runs only on a ready GPU with no user jobs, and keeps the GPU up from the moment the queue takes
  it until it ends. Between two calls only the idle interval keeps the GPU up.
- The scheduler cancels a probe request that has waited 10 minutes from the moment the queue took it, or run 90
  seconds, by its next tick. The hold ends once the cancelled request has ended locally, and in a shared pool a
  request cancelled while its size is counted ends only after that count's cleanup. So there is no hard bound in
  seconds on how long a probe request keeps the GPU up; the limits only keep a probe from waiting forever on a GPU
  that never becomes ready.
- The background work never starts a rental and yields to a pause: while the GPU is pausing or paused, the queue stops
  the running call, refuses the waiting ones and takes no new ones. It checks every second.
- With one slot a probe can evict the story cache and delay the first text of the next user answer. A turn, a
  person's or an agent's, keeps the slot from its first call until it ends, so nothing else runs between its
  compaction steps and its scene. A person never cuts off a started turn.
- Agent turns ([agent interface](agent-interface.md#model-access)) have their own queue. They wait for the same quiet
  window, have no 90-second limit and, once started, run to the end, so the GPU works while people read. A person who
  writes meanwhile waits, up to a couple of minutes (the tester agreed to this for the sake of GPU use). Only a
  compaction prepared ahead for one person yields to anyone else's call.
- A started agent turn keeps the GPU up until its last call has ended on the server, the gaps between its calls
  included: a pause waits for it, and the auto-pause counts from then.
- A person waiting for the model sees how many requests are ahead, never whose, in the disappearing draft before a
  scene and in the compaction status. Once the model starts reading the scene request, the draft says so.

<a id='slot-pool'></a>

## Slot pool (off by default)

`SIMPLE_CHAT_GPU_SLOTS=3` in the bot's `.env`, with the server started by `serve.sh` with the same `SIMPLE_CHAT_GPU_SLOTS`, turns the queue into a pool: one call runs in each slot at once. `SIMPLE_CHAT_CONTEXT_TOKENS` stays the limit of one request, and `SIMPLE_CHAT_GPU_CONTEXT` must match it.

The slots divide the card's cache in one of two ways, and the bot and the server must be told the same one:

- **Isolated** (the default, `SIMPLE_CHAT_GPU_KV_UNIFIED` unset or `false`): each slot owns `SIMPLE_CHAT_GPU_CONTEXT` cells, the server is given `slots x context` in all, and nothing can evict anything. The scheduler admits every call that fits one request, because it does.
- **Shared** (`SIMPLE_CHAT_GPU_KV_UNIFIED=true` in both, `SIMPLE_CHAT_POOL_TOKENS` and `SIMPLE_CHAT_GPU_POOL` the same number): the slots share that many cells, `--kv-unified-per-slot` stops one slot from taking more than one request's worth, and the scheduler admits calls by size as described below. Fewer cells buy the same slots, and a short story leaves its room to the others.

**`--no-cache-idle-slots` is what makes either of them work**, and `serve.sh` always passes it. Without it llama.cpp saves an idle slot's cells to the RAM prompt cache on every new task and clears them from the card; with `--cache-ram 0` they are simply gone, and a person loses their whole story cache while they read. This is not a subtlety: on the RX 580 the same load kept the cache with the flag and re-read the history from nothing without it ([the RX 580 run](knowledge/gpu-measurements.md#pool-rx580)).

The bot's check refuses a server with other slots, or one whose slot cannot hold a whole request. The size of a shared pool is not in the server's API at all, so nothing verifies it: the two numbers are the operator's to match.

- A turn's calls go to one slot (`id_slot`), and a holder's next turn goes back to its slot. People take the highest free slot that holds no other person's cache; agents and probes take the lowest and never the highest one. When the cache overflows, llama.cpp evicts idle slots from slot 0 up, so people's caches go last.
- Each call reserves its input, counted by the server beforehand outside the slots, plus its whole output limit, and 2048 cells stay free. A call starts only if its reservation fits beside every running call and every other turn between its calls. An agent's or a probe's call must also leave room for every person's cache with its output limit and 1024 more cells for the next action, so agents never push a person's cache out, between their own calls no more than at their start. A person's call does not count idle caches: the server evicts them. The next call of a started turn does not count the idle caches of other turns, so two turns between their calls never wait for each other; a call larger than the whole pool runs only when the pool holds nothing else.
- Agents and probes start beside people without the quiet window, and an agent turn may start while people's jobs keep the GPU up. A person who cannot be placed, at the start of a turn or between its calls, stops probes and ends another person's prepared compaction, as with one slot; with room nobody yields. An agent kept from the pool by a probe stops it, at the start of its turn and between its calls alike. A prepared compaction waiting for room preempts nothing and keeps nobody behind it: anyone who fits starts beside it. A turn whose next call waits for room keeps its slot: only a silent one is taken as lost.
- A person's or an agent's own token count (a scene counted before it is sent, `local/generation.ts`) runs outside the slots at once, as a call of its turn. Ending the turn does not cancel it: its caller cancels it through its own signal, and an agent turn that has taken the GPU keeps it until the count has ended. The shutdown does not wait for such a count.
- Cancelling or refusing a call that is still waiting for room ends the token count started for it. The call ends only once that count has ended on the server: a probe's call keeps the GPU up until then, and so does an agent turn that ended meanwhile.
- A probe's own token count runs outside the slots too, but by a probe's rules: it runs only when the GPU is ready and there are no user jobs, waits in the probes' queue until then, keeps the GPU up from the moment the queue takes it until it has ended, and is cancelled by the next tick once the GPU is no longer ready or a user job begins. Nobody waiting for a slot stops it: it takes none.
- The GPU snapshot counts the times the instance came back up (`starts`). A pool forgets its reservations then, because that server's caches are empty. A control API that fails and recovers says nothing about the model server and does not count, and neither does an intention to stop the instance that never took effect.

A shared pool has a floor, and the scheduler sets it: every call reserves its input and its whole output limit with
2048 cells kept free, and an agent's call must also leave room for every person's cache. A pool below that floor
evicts the tester's cache, which threshold 2 of [the measurement](llama-measurement.md#thresholds) exists to prevent,
and thresholds 2 and 3 then have to be measured again. The floor depends on the workload: the 73850 and 78970 cells of
2026-09-20 belong to that run, not to every story ([the pool floor](knowledge/gpu-measurements.md#pool-floor)).

<a id='memory-probe'></a>

## The memory probe through the bot

Once the managed GPU profile starts, the bot opens a Unix socket `<database path>.model.sock` with `0600`
permissions. It offers only background generation and the service status, never the story database. Agent turns
reach the model through it, in their own queue ([agent interface](agent-interface.md#model-access)). Use
`memory:probe` for probes: `model:probe` and `story:probe` call the model directly and are not meant to run beside a
working tester.

```bash
npm run memory:probe -- --source /path/to/synthetic/dance/evidence.json --minutes 15
```

The source is the result of `story:probe` for one of the project's synthetic examples. The script compares the seed
and all author inputs, replays the same scenes for `plain` and `sgr`, makes three compactions in each and checks the
answers to questions set in advance; it writes no new scenes. `report.json` in the temporary directory it prints
holds the memory increments, the exact counters, the answers and the expected values. The technical output holds
only metadata.

After a stop you can continue from the saved point:

```bash
npm run memory:probe -- --source /path/to/synthetic/dance/evidence.json --resume /tmp/simple-chat-memory-dance-EXAMPLE --minutes 15
```

The probe is limited to the given time, from 1 to 30 minutes. A busy or stopped GPU can leave it unfinished. This is not a result of a quality check. A comparison needs both modes completed on one source file and one model. Such a run evaluates the whole compaction scheme, including the different output budget; it does not isolate the effect of one SGR instruction and does not check quality at 44K.

<a id='managed-gpu'></a>

## Pause from Telegram

To let the bot pause and start one instance, put its ID in `.env.gpu` as `SIMPLE_CHAT_VAST_INSTANCE_ID`, and a key in
the private `.env.gpu` or `.env` as `SIMPLE_CHAT_VAST_API_KEY`. Make a separate key that may read and change only
this instance. In the verified Vast key interface the `id` constraint `{"id":{"eq":INSTANCE_ID}}` goes under
`api.instance.show` → `GET` → `constraints` and `api.instance.manage` → `PUT` → `constraints`.
`api.instance.destroy` → `DELETE` with the same constraint is needed only by the separate deletion timer: the bot
itself uses GET and PUT and never creates a rental. `CONTAINER_API_KEY` worked inside the container but answered 401
from the bot's computer, so local control does not use it.

`SIMPLE_CHAT_GPU_SSH_HOST` must point to the same instance with a verified host key, and the project's GPU scripts go
to `/workspace/simple-chat/gpu/`. After the bootstrap and the model probe, the managed bot opens the tunnel on local
port 8080 and runs `ensure-server.sh` itself, without `gpu/tunnel.sh`.

«Пауза GPU» ("Pause GPU") and «Запустить GPU» ("Start GPU") in `/model`, or `/gpu_pause` and `/gpu_start`, are shared
by all admitted users. A pause closes the intake of new jobs and waits until the active scenes and compactions end;
one scene holds the GPU through its automatic compaction and the generation after it.

`SIMPLE_CHAT_GPU_IDLE_MINUTES=15` pauses the card 15 minutes after the last work for the model ends:

- A reader's scene or compaction and an agent's turn count from their start to their end, the gaps between their
  requests included.
- A probe through the bot's queue (`npm run memory:probe` without `--direct`) counts request by request, each from the
  moment the queue takes it until it has ended locally, under the limits in
  [Background memory comparison](#background-memory-comparison), which set no hard bound in seconds.
- The timer does not run while any of this lasts and starts again when the last of it ends, so this work keeps the
  card up for as long as it goes on: only the rental's own guard ([Renting](gpu.md#renting)) deletes the instance
  under it.
- `npm run eval` and the probes with `--direct` call the model server directly, and the bot does not see them
  ([eval.md](eval.md#replay-and-scenes)). Its auto-pause can stop the card under them, so run them while the bot is
  stopped or within the idle interval.

A pause from Telegram waits for the readers' jobs and for an agent's turn, but cancels a probe's request within a
second and goes on once that request has ended locally. The check runs every 10 seconds. Viewing the menu and the
status does not reset the timer, and an ordinary message does not start a stopped rental. After an explicit start the
bot waits until the GPU, SSH and the model are available; a free card after a pause is not guaranteed, since Vast may
wait until one is released.

After a successful check the bot keeps the readiness for at most 30 seconds during a
temporary failure of the API or of the model check. Repeated errors do not extend this
period. This way a single failure does not block the next request. A confirmed stop,
a mismatch of the instance or of the model, a manual pause and the expiry of the idle period cancel
the admission at once. The idle period is checked even when the API is unavailable.

What a pause does not stop, the disk above all, and when to delete the machine instead are in
[gpu.md](gpu.md#ending-the-rental). The safe error codes of these checks are described with
[the bot log](gpu.md#bot-log).

<a id='diagnostics'></a>

## Diagnosing connection failures

Start every rental with the logs. On the night before 17 September new SSH connections hung while the model server
kept working, and the server log that could have told why was lost with the instance
([SSH failures](knowledge/gpu-measurements.md#ssh-failures)). Save the bot's own log as [gpu.md](gpu.md#bot-log)
shows. In its `compaction_request_completed` and `scene_request_completed` rows llama-server adds its own timings from
the last stream chunk: `cacheTokens` taken from the cache, `promptTokens` and `promptMs` of the prefill,
`predictedTokens` and `predictedMs` of the decoding, `draftTokens` and `draftAcceptedTokens` with speculative decoding.

### State snapshot

```sh
npm run gpu:diagnose
npm run gpu:diagnose -- --watch 30
```

The command asks the model server over two paths at the same moment: through the port `127.0.0.1:8080` the bot
forwarded, and through a separate SSH session to the server's own loopback. Comparing the two tells SSH from
llama-server. Through the tunnel it repeats the bot's check, `/v1/models` and then `/props` within 8 seconds in all,
so its result compares with the `gpu_check_failed` rows of the bot log; it does not compare the model name and the
context size.

Without flags it takes one snapshot over a new SSH session. `--watch` keeps one session open and takes a snapshot
over it at the interval, 10 to 3600 seconds, until Ctrl+C; it reopens a lost session and records how it ended. During
the last failure new SSH sessions hung while open ones kept working, so start `--watch` at the beginning of the
rental: a snapshot asked for during a failure will most likely show only `ssh_unreachable`. A watch process forgotten
on the instance ends by itself after an hour.

The command changes nothing on the instance and uploads nothing: `gpu/diagnose-remote.py` goes to `python3` through
the same SSH session. It reads neither Telegram, nor the story database, nor the server output. Addresses, raw SSH
errors and arbitrary strings from the remote side do not reach the report. Each snapshot is one line of JSON, also
appended to `logs/gpu-diagnose.jsonl`. The SSH alias is `SIMPLE_CHAT_GPU_SSH_HOST` from `.env.gpu`, or `--host`.

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

Other fields refine the reading:

- `remote.processes.sshd`: `startups` counts the connections sshd has not yet authenticated (from `dropFrom` it drops
  some new ones, at `dropAllAt` all), `unauthenticated` the same by processes, `sessions` the open sessions besides
  the diagnosis's own (the bot's tunnel is one).
- `remote.sockets`: the model port's connections. Growing `established` or `closeWait` with `reading: server` point
  to a llama-server that holds old connections.
- `remote.container`: growing `throttledPeriods` and `throttledSeconds` mean that Vast limits the container's CPU.
  `pressure` is the share of the last 10 seconds spent waiting for CPU, disk or memory, which can hang a new SSH
  session on a healthy network; with `pressure.scope: machine` the kernel gives it only for the whole machine.
- `remote.machine` is the whole machine with other people's containers; `remote.gpus` each card's memory, load and
  temperature, where the driver reports them; `remote.failed` the parts that could not be read.
- `remote.processes.llamaServer[].ageSeconds` shows a restart, `remote.serverEvents.rows` the last events of
  `server-events.jsonl` (25 in a single snapshot, 5 in each `--watch` one), `direct.seconds` how long the separate
  SSH session took.

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

After a failed attempt the bot waits 10, then 20, then 30 seconds before the next ssh start
([why](knowledge/gpu-measurements.md#ssh-failures)). A tunnel that worked for a minute reconnects at once, and a GPU
pause or start resets the delay. While the bot waits, its checks write `gpu_check_failed` with `phase: ssh_wait`,
which means that ssh was not started at that moment.

Before deleting the instance save its server events with `npm run gpu:diagnose -- --pull`, as
[gpu.md](gpu.md#ending-the-rental) asks. The command saves all events of `server-events.jsonl` together with the rotations to `logs/gpu-server-events-DATE.jsonl`. Only the time, the event name, the category, the PID, the exit code and the signal reach the file. Afterwards there is nowhere to get them from.

<a id='adapter'></a>

## The adapter

`local/llama.ts` calls a pinned version of llama.cpp over HTTP through an SSH tunnel or an HTTPS gateway. This is a
llama.cpp adapter, not a promise of compatibility with any OpenAI-like API. At startup it checks the model name, a
number of slots equal to the bot's `SIMPLE_CHAT_GPU_SLOTS` (one unless the [slot pool](#slot-pool) is on), and enough
context in one slot for a whole request.

The count `/v1/chat/completions/input_tokens` and the generation `/v1/chat/completions` receive the same request body. The server applies one chat template to both. Neighboring messages of the same role are merged, reasoning is turned off by template parameters, and separate `reasoning_content` is not shown to the user. Summarization uses a lower temperature than the story response.

Before the generation request is sent, the exact input is checked with a reserve for the output. The `prompt_tokens` reported at the end must match the preliminary count. A request whose caller trusts its estimate (`trustEstimate`, set only far below the limit) is sent without the preliminary count. Its reported `prompt_tokens` replace the estimate and are checked against the same limit after the stream. Without them the result is rejected with `usage_unavailable`. If the server answers such a request with 400, the adapter makes the count it skipped, so that a prompt over the limit becomes `context_limit`. The cache is part of the full input and is not added to it a second time. A break without a completion event, tools, and inconsistent counters are rejected. A cancellation and a timeout close the request; there is no automatic retry. [Pinned server documentation](https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/server/README.md).

Sources: [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server).
