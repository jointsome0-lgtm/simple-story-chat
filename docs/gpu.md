# GPU rentals and the picture card

How to rent a card on Vast, what the owner asks while it is paid for, how to reach it, and how the picture card runs
and what it keeps. The language card's setup, checks, pause and diagnostics, on this page until 2026-09-25, are in
[llama-cpp.md](llama-cpp.md), and its profile measurement in [llama-measurement.md](llama-measurement.md). The
identity measurement follows [identity-experiment.md](identity-experiment.md). Past prices, downloads and failures
are in [gpu-measurements.md](knowledge/gpu-measurements.md).

## Renting

[rent.mjs](../gpu/rent.mjs) takes one offer that matches the lane's requirements ([the language card](llama-cpp.md#requirements), [the picture card](#picture-card)). It exists because an offer id on Vast lives only a few minutes: a price read out of a list, agreed to, and then used is a price for an offer that no longer exists, so the script searches live and tries its candidates in order until one is taken. `SIMPLE_CHAT_VAST_API_KEY` comes from the environment and is never printed; the public key named in the script is installed by [trial-onstart.sh](../gpu/trial-onstart.sh), which also arms a guard that deletes the instance after three hours, or after the one or two that `--hours 1` or `--hours 2` asks for. The guard is not a platform limit, so every rental can also be reached with the account's key alone: `--show ID` reads it, and `--destroy ID` gives the guard a minute, then deletes it and reads it back until it is gone, or says within five minutes, whatever Vast answers, that it could not confirm that. The ID is always the one `rented` printed.

Run it dry first. That names the offers it would take at their present prices, which is the thing worth agreeing to, and it spends nothing.

```sh
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs
node --env-file-if-exists=.env.gpu gpu/rent.mjs
```

A session that runs both lanes may be one machine (`--gpus 2`, or one card with the lanes in turn) or two machines
with one card each, which the owner chose on 2026-09-22 ([why](knowledge/gpu-measurements.md#costs-and-downloads)).
Rent each lane with its own call; the language machine asks for 60 GB of disk and is priced by Gemma's download, the picture machine for 100 GB and by the image files. The two tunnels are `bash gpu/tunnel.sh ALIAS` for the language machine and `bash gpu/tunnel.sh --pictures-only ALIAS` for the other. Each machine arms its own three-hour guard. Rent the second machine with `--avoid-host` and the first machine's host id: the same box often lists both of its cards, and two rentals on it would share one link, one disk and one failure, which is not the two machines the owner asked for.

```sh
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs --lane text
SIMPLE_CHAT_RENT_DRY_RUN=1 node --env-file-if-exists=.env.gpu gpu/rent.mjs --lane pictures
```

Machines in mainland China are not asked for and are dropped from the answer (`droppedForCountry`): Hugging Face and CivitAI are not reliably reachable from there, and a session is mostly a download.

Offers are sorted by `hour * 2.5 + download`, the cost of the session the instance is billed for, with the measured host first. With `--hours`, the session is those hours and 20 minutes 20 seconds more: the quarter of an hour of start before the guard's clock begins, and after it twenty seconds of "we're done" and the five minutes a destroy is given to be read back. `--qwen only` prices a picture machine by the Qwen files alone, which is what `SIMPLE_CHAT_IMAGE_QWEN=only` pulls, and asks for 60 GB of disk instead of 100: a host prices its disk by the hour, and the cheapest 5090 on 2026-09-25 charged $0.87 per GB a month. A picture machine's RAM floor is 30 GB, not the language lane's 32: a 32 GB share can report 31.2 GB. The dry run prints each offer's sum as `session`. Offers with fewer than two direct ports are dropped and the count of them is reported: an offer with no ports can only be reached through Vast's proxy. That rule has never yet excluded anything — every 5090 within this price has had ports — so treat it as a guard, not as an explanation of any failure.

### While the cards are paid for

Vast bills every minute whether the cards draw or wait. The owner's rules since 2026-09-24, written after a night when they mostly waited ([what happened](knowledge/gpu-measurements.md#paid-idle-2026-09-23)):

1. Rent when the work for the cards is ready. Write and dry-run every experiment script before the rental. A dry run needs no card. It assembles the prompts and counts their tokens.
2. Keep the cards busy while they run. Code, tests and commits that the cards do not need go to a subagent in its own worktree, so the agent feeding the cards never stops to do them.
3. Watch the idle time. When the cards have stood idle for more than 10 minutes and no work for them is ready, tell the owner and offer to delete them.

## SSH access

After you create the instance, take the address, the SSH port and the user from Vast. `npm run gpu:rent -- --show ID` prints the first two without the console: `ssh.direct` is the machine's address and the port Vast maps to the container's 22, and `ssh.proxy` is Vast's proxy, which admits only the account's keys. Add a local entry to `~/.ssh/config`; the values below are a sample:

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

If the key is still refused, read [SSH failures](knowledge/gpu-measurements.md#ssh-failures) before retrying. One
host wrote `authorized_keys` as its own user, which sshd refuses; the onstart script now repairs that by itself, and
the page gives the repair from outside. An empty direct port range on the instance is not proof of a proxy-only
machine.

From the project root upload only the scripts, and create `/workspace` rather than assume it: not every image has it.

```sh
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast
```

Copy with `tar` over SSH as above: `scp` hung through the proxy. What comes next depends on the lane:
[the language card](llama-cpp.md#prepare-server) or [the picture card](#picture-card).

<a id='picture-card'></a>

## The picture card

The picture card runs ComfyUI: [image-bootstrap.sh](../gpu/image-bootstrap.sh) prepares it from
[image-manifest.env](../gpu/image-manifest.env), [image-serve.sh](../gpu/image-serve.sh) starts it on loopback, and
`npm run image:batch` draws the frames of the synthetic stories through the tunnel. `image-serve.sh` takes card 1 by
default, the second card beside a language server; a picture machine of its own passes `SIMPLE_CHAT_IMAGE_GPU=0`.
The tunnel to such a machine is `bash gpu/tunnel.sh --pictures-only ALIAS`. The bot's settings for pictures are in
[setup.md](setup.md#pictures) and what the reader gets in [telegram-ui.md](telegram-ui.md#picture-delivery); why any
of this exists is in [illustrations-plan.md](illustrations-plan.md).

The tester pointed at `Kreamania`, a community fine-tune distributed through CivitAI
and HuggingFace. Any such checkpoint must be pinned the way the language model is pinned in
[gpu/manifest.env](../gpu/manifest.env) — repository, revision, SHA256, size. A community checkpoint on a community
host is exactly the kind of file that changes underneath a project.

A default run downloads the two Krea checkpoints, the encoder and the VAE, 31.46 GB, and
[rent-plan.ts](../local/rent-plan.ts) prices an offer's traffic by the files a session pulls. Count the files the
run actually selects; the sizes and minutes of each set are in
[picture downloads](knowledge/gpu-measurements.md#picture-downloads).

<a id='qwen-image'></a>

### Qwen-Image 2.1, opt-in

`SIMPLE_CHAT_IMAGE_QWEN=true` adds a third checkpoint, pinned in the same manifest and verified by the same code path. It is off by default because the traffic term above is the default run's, and a session that has not asked for this comparison should not pay for it.

```sh
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-bootstrap.sh --dry-run   # names the files, downloads nothing
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-bootstrap.sh
SIMPLE_CHAT_IMAGE_QWEN=true bash /workspace/simple-chat/gpu/image-serve.sh
```

It adds 17.28 GB of int8 files ([sizes, and why not bf16](knowledge/gpu-measurements.md#picture-downloads)). Its
licence allows a test, not a product: [image licences](#image-licences).

The bootstrap writes two graphs beside the Krea one: `image-workflow-qwen.json` draws frames, `image-workflow-qwen-edit.json` takes reference portraits. One run has one workflow, so Qwen is its own `image:batch` run directory, and `npm run image:blind -- build --run a,b --out <directory>` reads several of them.

`SIMPLE_CHAT_IMAGE_QWEN=only` fetches Qwen's three files and nothing of Krea's, Turbo included, so it needs no CivitAI or Hugging Face token: 17.28 GB, 7.7 minutes at the 300 Mbit/s the rent filter asks of an offer. `image-serve.sh` with the same setting starts ComfyUI for Qwen alone. It is the box of the [identity measurement](identity-experiment.md), which draws nothing else; the default and `true` are unchanged. Whatever it fetched, once every file is verified the bootstrap writes `image-verified.txt` beside them: the ComfyUI revision it checked out and each file's SHA256 as computed on the box. The identity harness is pinned to that record, so it is copied off the card before the first job.

### What the card keeps of a picture

A picture of a reader's scene passes through three places on the card, and each is emptied without a restart:

- **The job record** in `/history`, which holds the whole prompt and the workflow. The bot deletes it as soon as it has the picture (`drawOne` in [image-batch.ts](../local/image-batch.ts)).
- **The file** the preview node writes and `/view` hands to the bot. `drawOne` gives the preview node a key of its own for every job. Without it, a graph identical to the last one was answered from ComfyUI's cache, whose output named the earlier job's file, already swept: `/view` answered 404 to the second sample of one style on one scene, found on 2026-09-24. The key changes only that node's cache signature: the sampler's result still comes from the cache, and the repeat took 4–5 s against 17 s. No route of ComfyUI's API deletes the file, so [image-serve.sh](../gpu/image-serve.sh) puts the temp directory in RAM, at `/dev/shm/simple-chat-comfy` with mode 0700, and refuses to start when `/dev/shm` is not a writable tmpfs. [image-sweeper.py](../gpu/image-sweeper.py) runs beside the server, reads `/history` once a second and deletes a file no record names once the file is 5 s old, a few seconds after the bot's delete. Any file older than 10 minutes goes whatever names it, and so does a record whose job ended 10 minutes ago, left by a bot that died between the drawing and its delete. While `/history` cannot be read only the 10-minute rule applies. The sweeper stops by itself when the server does; its rows in the server's log are counts and codes.
- **The server's memory.** ComfyUI caches each node's output for the next job, keyed by the node's inputs, so the last job's conditioning, latent and decoded picture, and its prompt inside the keys, stay in RAM until the next job has run its first node or the server stops. `POST /free` would clear them, but at the pinned revision it cannot do that without unloading the models, and every picture would then pay a cold start: 26.3 s against 17.2 s warm. That is accepted.

The last point holds for one job only because of the card's size. The pinned build's default cache, the RAM-pressure one, drops the entries a new job does not use only while free RAM is under a threshold, which is the container's RAM capped at 128 GiB. The current card's container has 120 GiB, so free RAM is always under it and older jobs go at once. On a container with more they would stay until RAM runs short, and `--cache-classic` in `image-serve.sh` would bound them to the last job again. None of this reaches a disk only because the container cannot swap: the current card's `/sys/fs/cgroup/memory.swap.max` is 0, although its host has a swap device, and a container that may swap can put the tmpfs there too.

`output/` keeps what the batch harness saved and `input/` its reference portraits, synthetic scenes only, until the card is destroyed. A server started before the sweeper existed wrote its previews to `ComfyUI/temp` on the disk, which the sweeper does not watch: empty that once by hand.

Every PNG the bot takes from the card is rewritten without its text chunks, which hold the whole prompt and workflow
(`stripPngMetadata` in [image-batch.ts](../local/image-batch.ts)).

<a id='image-licences'></a>

## Licences of the picture models

What the owner read and decided, with the dates. This is a recorded reading and the owner's decision, not a fresh
legal review.

### Krea 2, read 2026-09-21

Krea 2 Community License Agreement v.1 of 2026-06-22 and the Acceptable Use Policy it incorporates [M, both read
in full]. Not legal advice.

- **Only `Raw` and `Turbo` are downloadable.** The licence names exactly those two variants. `large` and `medium`
  exist as hosted names only, so a card of ours runs `Turbo` or `Raw`, and a hosted `large` picture says nothing
  certain about what our card would draw.
- **The repositories are gated**: a HuggingFace account has to press "Agree" with a name, an e-mail and a company,
  and the bootstrap needs that account's token. That is the owner's act, not a script's.
- Commercial use is allowed below $1M of yearly revenue. Outputs belong to whoever generated them.
- **A deployer must run content filters** (4.2): "reasonable and appropriate" measures against prohibited output,
  with an image classifier, a moderation API or human review given as examples. Not doing so is a breach, and a
  breach ends the licence at once. A bot that draws from free-form stories is a deployment in this sense.
  Owner's decision 2026-09-21: while the bot is tested by the owner and the tester, each of whom sees his own
  pictures, that human review is the measure, and no classifier is added. It comes back when pictures are made
  for people whose pictures neither of them sees.
- The policy forbids sexual content with minors, intimate images of real people, deception about real people, and
  content "obscene or otherwise objectionable under applicable law". It does not forbid adult content as such. The
  test-ground rule stays as it is: nothing adult goes to a hosted API.
- Distribution of the weights needs the licence text, a "Krea" name prefix and a notice file. We do not distribute;
  the pin in a manifest is a reference, not a copy.
- Krea may end the licence for any reason on 30 days' notice, after which the weights must be deleted. A feature
  built on them can be taken away.

### Qwen-Image 2.1, accepted 2026-09-22

**Licence, accepted for the test.** Qwen Research License (the repository's own `license_name: qwen-research`),
non-commercial, read as what it says on the card and not verified clause by clause here [A]. The owner accepted it
in their own words on 2026-09-22, asked whether they take it for as long as only the owner and the tester use the
bot. It is a narrower permission than Krea's, which allows commercial use below $1M: it makes Qwen a comparison
checkpoint rather than a candidate for a bot that earns money, and if this feature ever reaches people beyond the
owner and the tester, Qwen has to be decided again. The opt-in stays a flag of the session
(`SIMPLE_CHAT_IMAGE_QWEN=true`), off by default, because the default download is what a rental is priced by.

<a id='story-text-boundary'></a>

## Story text on a rented card

**Story text may not go to the tester's machine.** An illustration is made from the text of somebody's scene. The
rule in [AGENTS.md](../AGENTS.md) stands in the other direction already — the tester's own library stays closed even
when his failure is the one being debugged — and funding a card does not make other people's stories his. Two
honest shapes: a rented card we run, or the feature enabled only for his own stories on his own machine. The second
is a clean place to start.

SSH protects the data in transit. The administrator of the rented host still controls the machine on which the prompt is processed; take this into account when you choose a place for personal stories.

Adult content never goes to a hosted API. The owner's two exceptions, both for judging pictures drawn on the rented
card, are narrow and written out in [improve-loop.md](improve-loop.md#acceptance-on-gpu); read them before sending
any picture or sharp text to a hosted model. Consent to a hosted text connection for the bot is in
[model-providers.md](model-providers.md#consent-to-a-hosted-connection-for-the-bot).

## Bot log

The bot writes technical events to stdout. Without a redirect they are lost together with the terminal.

```sh
mkdir -p logs && chmod 700 logs
npm run start:gpu 2>&1 | tee -ai logs/bot-gpu.jsonl
```

The `-i` flag is required. Ctrl+C goes to the whole pipeline, and an ordinary `tee` ends before the bot. Then the rows about the shutdown, including the GPU stop request, do not reach the file. The `logs/` directory is excluded from git.

Every row about a user request carries the `actor` field: `owner` for the owner from `SIMPLE_CHAT_OWNER_ID`, `other`
for everyone else, and `agent` for a request through the agent interface. The ID does not reach the log. The label
shows whose failure it was without opening anyone's library; the `other` rows belong to stories that must not be
read ([the privacy rules](../AGENTS.md#privacy-whose-data-you-may-read)). Only the fields of the whitelist in
`local/model-error.ts` reach a row.

Manual and automatic compaction write the same events:

| Event | When |
| --- | --- |
| `compaction_request_started` | Before every request to the model. This is an extraction, a retry with half of the scenes after `context_limit`, or a repair request for missed scenes. |
| `compaction_request_completed` | The model answered. The row has the `inputTokens` and `outputTokens` of this request, `waitMs` in the queue and llama-server's timings (below). |
| `compaction_request_prepared` | Instead of `completed`: the answer was prepared while the person read (below). |
| `memory_compacted` | The memory is saved. The row has `factCount`, `inputBytesBefore` and `inputBytesAfter`. |

A failed compaction writes one `generation_failed` row with `operation: compact` and the same numbers:

- `automatic` is `true` for a compaction that started by itself before a scene.
- `sceneCount` is the scenes the attempt compacts; after `context_limit` the bot repeats the request with half of
  them. `repairSceneCount` is the missed scenes a repair request asked for, zero for the first request.
- `requestBytes` is the size of the request, `outputCharacters` the characters of the answer that had arrived, and
  `inputBytesBefore` and `inputBytesAfter` the size of the next scene's request before and after compaction (they
  also come with `memory_not_smaller`).
- `elapsedMs` counts from the start of the compaction; one request lasts from its `started` row to its `completed`.

The failure row tells where the request broke. `provider_failed` with `outputCharacters: 0` means that the connection was lost before the first character of the answer, while the server processed the input; it does not tell why the connection was lost. A non-zero value means a break in the middle of the answer. `memoryReason: coverage` comes with `sceneCount` and `missingCount`, that is, with the number of requested and missed scenes. If `repairSceneCount` is greater than zero in that row, it was the repair request that failed, and `sceneCount` counts only its scenes.

A compaction prepared while the person reads ([the contract](model-providers.md#memory-and-context)) writes
`compaction_prepare_started`, then `compaction_prepare_finished` or `compaction_prepare_failed` with `elapsedMs`, and
one `compaction_prepare_request_completed` per request, whether its answer is used or not. Another person's call ends
it with `background_preempted`. One `compaction_prepare_outcome` row per run, with its number `prepareRun`, says what
became of it: `used`, `asked_again`, `unstarted` or `discarded` (`local/prepare.ts`).

`compaction_request_completed` and `scene_request_completed` carry numbers only: `waitMs` in the model queue,
`estimateTokens`, the bot's estimate of a scene request before any count, `countMs` of the token count (absent when
the scene went on its estimate) and `elapsedMs`. llama-server adds its own timings
([llama-cpp.md](llama-cpp.md#diagnostics)); a hosted provider sends none.

A `picture` row ends each scene's picture: `outcome` (`ready`, `failed`, `cancelled`, or `skipped` when the card was
not ready), `describeMs` of the description call, `imageMs` on the image server from submit to file, `photoMs` and
`photoBytes` of the upload to Telegram, and `pictureSeconds`, what the reader waited from the end of the scene.
`namesStripped`, `withoutLook` and `clothesChanged` count what the prompt assembly did, and `promptCharacters`,
`pictureTokens` and `styleTokens` give the prompt's size. Samples, variants and portraits write `picture_sample`,
`picture_variant` and `picture_portrait`. No prompt, description or file name reaches a row.

A technical error contains a safe code, the HTTP status if one was received,
the stage and the known transport code; unknown transport codes are marked
as `other`. For SSH the process exit, the signal and a fixed category of the
connection error are saved. A timeout of the model check differs from a cancellation by the user.
The texts of prompts, of scenes, of server errors and the request addresses do not reach the log.
The old general code `provider_failed` does not allow you to recover the exact cause
of a past failure or to draw a conclusion about content filtering.

`npm run memory:probe` writes the same rows for synthetic compactions, with the time in each row and no scene text, facts or identifiers.

## Ending the rental

«На паузе» ("Paused") is shown only after Vast confirms the stop.
An API error does not mean that the payment stopped. The disk is paid for
separately during a pause; check the rate on the instance card.

The rule: for a pause inside a work session (up to two or three hours), stop the machine, and if the machine did not come up within a couple of minutes, delete it and take another one; for "that is all for today" or when the return time is unknown, delete at once. The rental is billed per
minute and a stopped machine's disk still costs; what each choice cost in September 2026 is in
[the rental history](knowledge/gpu-measurements.md#rental-history).

Stopping the model process or the SSH tunnel does not end the rental. The managed bot requests the stop through the API on a correct shutdown, but the result must be confirmed in Vast. The instance must be stopped or deleted on the side of the service; after a stop the disk storage is still paid for. Before the deletion check where the files that you need are, and save the server log through `npm run gpu:diagnose -- --pull`. In the described scheme the stories are on the bot's machine, and the GPU has the weights, which are downloaded again, and the build. [Vast billing rules](https://docs.vast.ai/guides/instances/pricing).

`gpu/trial-onstart.sh` is meant only for a one-time run on artificial stories. As a Vast onstart script it saves the initial deadline and requests the deletion of its own instance after three hours, or after the one or two that `gpu/rent.mjs --hours` asked for; a repeated start does not extend the deadline. The guard reads the deadline file again every ten seconds and takes an earlier time, never a later one, so `ssh ALIAS 'date +%s > /root/.simple-chat-trial-deadline'` ends the rental within ten seconds: the "we're done" of the [identity runbook](identity-experiment.md#termination). It uses only the `CONTAINER_API_KEY` issued to this instance. You can pass `SIMPLE_CHAT_SSH_PUBLIC_KEY` to add a public key only inside this container. The script is not a Vast money limit: a disconnected container does not run its timer, and a network failure can delay the deletion. An external check that the rental ended is needed: `npm run gpu:rent -- --destroy ID` with the account's key, which deletes the instance if it is still there after the guard's minute and reads it back until it is gone. The identity runbook ends every rental with it. Do not use such a template for permanent work with data.

The managed bot's [idle timer](llama-cpp.md#managed-gpu) works while the computer with the bot is on and has access to the Vast API.
A correct shutdown of the bot also requests the GPU stop; an emergency power-off
of the computer does not guarantee this. A limited test needs a separate deletion
deadline for the instance and a check that it was carried out. Stories and checkpoints are
in the local database and do not depend on the pause.
