# The identity measurement

Does a person drawn from a portrait stay recognisable, face and figure, from one frame of a story to the next on
Qwen-Image 2.1? This page is the protocol of the paid hour that answers it, and [the result of its one
run](#result-2026-09-25). The harness and its dry run against a fake ComfyUI were merged on 2026-09-25 (d4ca6a0). The
question and why Qwen was chosen for it are in [illustrations-plan.md](illustrations-plan.md#qwen-choice). A rental
follows [the owner's rules](gpu.md#while-the-cards-are-paid-for).

<a id='result-2026-09-25'></a>

## The run of 2026-09-25

One RTX 5090 on Vast ran the hour on 2026-09-25 from 02:12 to 02:53 UTC. The code was the tree at 833157b, whose
harness is unchanged since d4ca6a0; the set hashes to f5baa31059ca. The rental cost about $0.46: 40.5 minutes at
$0.498 an hour from its creation to the confirmed deletion, and the plan's estimate of $0.12 for the download.

The run is complete by the rule of [a complete run](#complete-run). The smoke passed its geometry, memory and
telemetry checks. The six portraits, all 48 cells (8 frames, 2 seeds, 3 arms) and the three frames of the control were
drawn at the pinned geometry, and none failed. For the three control frames, at seed 7 and 1280x704, A and the bot's
text-to-image graph produced identical PNG files. Each of the six bundles was read by a fresh Claude Fable 5.1 session
that opened only the files of its own bundle, and every item has an answer.

| | A | B | C |
| --- | --- | --- | --- |
| Face kept, of 26 transitions | 88% | 96% | 85% |
| Figure kept, of 26 | 92% | 92% | 85% |
| Both kept, of 26 | 81% | 88% | 69% |
| Pictures with two people mixed up, of 14 | 0 | 0 | 1 |
| Pictures with an action error, of 16 | 0 | 8 | 7 |
| The frames' own changes of clothes shown, of 8 | 8 | 8 | 6 |
| Warm frames: median and slowest, ms | 15258, 16605 | 20290, 83419 | 20603, 82644 |

| Gate | B | C |
| --- | --- | --- |
| 1. Recognition | pass | fail: 85% and 85%, one picture mixed up |
| 2. Against A | fail: 88% against A's 81%, where 15 points above A are needed | fail: 69% |
| 3. Clothes | fail: 8 action errors against A's 0 | fail: 6 of 8, and 7 action errors |
| 4. Time | fail: the slowest frame took 83 s where 33 s is allowed; the median, 1.33 times A's, is within 1.5 | fail: 83 s; the median 1.35 times |
| 5. Memory | pass: no OOM, 9638 MiB free at the tightest frame of four | pass |

**B fails, and C fails.** The owner's decision on what follows is not recorded yet.

What the numbers leave open, and what the run showed besides:

- One judge read each bundle, and the judges did not hold one threshold: two of them said they count a person
  looking the wrong way as an action error. Still, each of the four bundles with portraits has three or four action
  errors and both bundles of A have none. The judges of B and C describe the same failure: people stand facing the
  viewer and look into the lens, as they do in their portraits, instead of reading or rehearsing.
- Every frame of four portraits took about 82 s, about 75 s of it sampling, against about 15 s for the same frames in
  A. One portrait added about 15% and two about 30%. The highest sampled occupied VRAM was 22,471 MiB with four
  references, against 24,455 MiB with two. The cause was not measured.
- The ComfyUI log warned that its optimised CUDA operations need PyTorch built for CUDA 13.0, and the run had 2.11
  built for 12.8. That holds for all three arms.
- What the judges found in the frame text holds for A too, which is how the bot draws. The small marks of the
  character sheet (a mole, freckles, the colour of the eyes, a scar, a braided beard, a crooked nose) were almost
  never drawn, so the two young women of the set were told apart only by their hair and their dresses. A left or right
  hand or shoulder was often mirrored. Two buckets named both in an action and among the objects came out as four.
  People who read or speak looked at the viewer unless the text said where they looked.

The pictures, the bundle keys, the answers and the judges' full reports stay on the owner's computer, in the
gitignored `illustrations/identity/`.

## The protocol

The protocol below is the text of 2026-09-25, moved here from illustrations-plan.md without changes. In order:
[geometry](#geometry), [the set and its three arms](#identity-runbook), [the portraits](#portrait-recipe),
[all six portraits before the smoke](#all-portraits), [binding](#binding), [pins](#pins),
[what each frame records](#telemetry), [the text-to-image control](#control), [judging](#judging),
[the gates](#gates), [a complete run](#complete-run), [the smoke](#smoke), [the hour](#one-hour),
[the operator](#operator), [the termination](#termination), [the commands](#runbook) and
[what is not verified without a card](#not-verified).

<a id='geometry'></a>

**The identity frames are 1280x704, and the portraits are upright.** The encode node of the edit graph is at the
template's `resolution: 0`, which keeps each reference at its own size rounded to a multiple of 32 (Python's
`round(720 / 32)` is 22, not 23). A portrait is drawn on the text-to-image graph's latent turned upright, 720x1280,
because a standing figure in a wide frame gets a third of the pixels, and it reaches the encoder at 704x1280. The node
also hands out an empty latent of the first reference's size, with the warning that sampling has to match it because
"any other size shifts the edit", and the template samples from it through a switch whose other branch is a free-size
canvas. That output stays unwired here. The sampler starts from the graph's own `EmptyLatentImage`, so every frame is
1280x704 whatever its references are, and the run pins `canvas` 1280x704 beside `referenceSize` 704x1280.
`applyToWorkflow` would refuse a sampler latent without a width and a height anyway, rather than draw one size and
record another. The pinned model gives each reference a place of its own in the sequence and centres its grid on the
target (`build_sequence` in `comfy/ldm/qwen_image21/model.py`), so a reference of another shape than the canvas is a
case it is built for. Whether an upright portrait keeps a person as well as a wide one would is not verified. The
node's warning reads as one about an edit shifting against its first picture, and a frame keeps nothing of a portrait
in place, but that is a reading of the source, not a measurement. Neither size is Krea's 1280x720, so a Krea frame
and an identity frame are not the same canvas; the blind page compares Krea against the text-to-image graph, which is.

<a id='identity-runbook'></a>

**The identity runbook, 2026-09-25.** One fixed synthetic set,
[examples/identity-set.ts](../examples/identity-set.ts), written before any card is rented: one story, a sheet of six
people and eight frames, each frame drawn from two seeds in three arms, 48 pictures on one canvas. Each arm goes by
what it is, here, in the report and in the bundle keys (`armIs`):

- **A, text only on the edit graph, 1280x704**: the frame's text, looks included, with every reference slot of the
  edit graph taken out. A matched text-only baseline for B and C, and not the bot, which draws a frame on the
  text-to-image graph; the control below prices that graph;
- **B, the same text and the bound portraits**;
- **C, the bound portraits, their looks replaced by the number of their picture**: the whole look of each bound
  person, build included, becomes "the person from image N". Clothes, state and action stay, and no arm's text holds
  a name.

B against A says whether a portrait helps at all; C against B, whether the look can go once the portrait is there.
**C is the owner's question.** The reference is meant to carry the whole figure, so that a frame need not say every
time that a man is huge and grim as a barbarian: does the build come from the portrait alone? No frame of the set
says who is big or small outside the looks, so in C nothing else can carry it.

What the eight frames cover, each on purpose:

- a very muscular, heavy man and a slight, thin woman, and a very tall man beside a very short one. Both pairs appear
  together in one frame and again in swapped order;
- two women who look alike on purpose, together and swapped;
- one, two and four portraits in a frame;
- a ferryman nobody drew a portrait of, standing between the two women, where the binding stops;
- three frames that change clothes, and a new pose and place in every frame.

The second seed is an independent repeat, never a second chance. A cell that failed, an OOM above all, stays failed:
drawing it again until it comes out would be choosing the picture.

<a id='portrait-recipe'></a>

**The portraits carry the figure, by the bot's own recipe.** They are drawn on the card first, by the text-to-image
graph, so that the references are the model's own people and not photographs of anybody. The recipe is the one the
bot draws its portraits with: `PORTRAIT_CLOTHES`, `PORTRAIT_STYLE`, `PORTRAIT_ACTION` and `portraitPrompt` in
[image-portraits.ts](../local/image-portraits.ts), which `local/picture.ts` takes them from. Each portrait is:

- one per person, from that person's sheet line and nothing else;
- the whole body in frame, seen from the front, before a plain grey backdrop;
- standing upright facing the viewer, arms relaxed at the sides;
- in a plain close-fitting white tank top, close-fitting dark grey trousers and plain dark shoes, which show the build
  where a robe or a coat would hide it;
- in a neutral reference style of its own, never a story's, on the upright canvas above.

The run pins the recipe, that is the clothes, the style, the action, the canvas and the text-to-image graph's hash,
so a resume under another one is refused. No expression is asked for. A face told to be calm argues with a look line
that says grim, and a permanent bearing is the look's to carry. No frame dresses anybody as the portraits are
dressed, so in B and C every appearance also asks whether the clothes came from the text or from the portrait. A face
reaches the card once, under the hash of its own bytes. The sheet name picks the file and goes no further: the rule
that no name reaches the image model is unchanged. Portraits pass through `stripPngMetadata` on the way up, as every
picture here passes through it on the way down.

<a id='all-portraits'></a>

**All six portraits, or no smoke.** Before the smoke the tool checks that all six people have a portrait on the
portrait canvas, that none failed, and that every frame binds exactly the people `IDENTITY_BINDING` in the set names,
in that order, which fixes each frame's number of references. A portrait missing or failed ends the measurement
there, incomplete: no portrait is drawn again, retried or chosen among. Without that check the binding below would
quietly give the two look-alikes no face and much of C its look back.

<a id='binding'></a>

**One binding plan, and slot N is person N of the prompt.** Nothing else says whose face is whose. The encoder's
tokenizer writes its own `<image1> <image2> …` block in front of the prompt. The prompt names people in the order of
`description.people`, and the slots are filled in that order. One plan, `bindingPlan` in
[image-batch.ts](../local/image-batch.ts), says both which portraits a frame sends and whose look arm C drops, so the
two cannot disagree.

The plan stops at the first person of a frame who has no portrait, rather than skipping them. That person may be
somebody off the sheet, a stranger of one scene, or a sheet person the portrait run drew nothing for. Skipping them
would move every later face up a slot and put a portrait against another person's clause. The people after the stop
keep their look in every arm, and `references` in the index counts what was actually bound. C's "image N" is the
slot's number. The swapped frames test whether the model follows that number rather than the order alone.

<a id='pins'></a>

**One canvas, one set of pins.** All three arms, and the control, are drawn at 1280x704, and one run directory holds
one graph and one canvas. The tool refuses portraits of two sizes and a resume under another canvas, other arms,
another prompts file or other pins. It checks all of that before it writes anything, so a refused resume leaves the
run directory byte for byte as it was. A run is pinned to:

- what the card was verified to run: the ComfyUI revision and the SHA256 of each Qwen file, from the bootstrap's own
  record (the runbook below). There is no checkpoint to choose: every stage draws with the transformer that record
  verified, and the tool refuses a `--checkpoint`;
- the portraits' recipe;
- the graph's cache device and resize, the canvas, and the size a portrait reaches the encoder at;
- the set, the portraits and the seeds;
- what the server says of itself: ComfyUI, PyTorch and the card. A server that does not say all three on
  `/system_stats` is refused, never read as saying nothing.

Smaller portraits and a waist-up crop are each a short run of their own after this one, with their own arm A. They
are never a full factorial of sizes, crops and costumes.

<a id='telemetry'></a>

**What each frame records:**

- the reference sizes after the resize, the number of portraits bound, the arm and the seed;
- the time from submit to file, with the upload apart from it, and the encode and sampling phases the websocket
  reports. The server tells a job's start only to a socket that is connected when it starts, so the job is sent once
  the socket is open, two seconds at most. Here a socket that does not open stops the run before the job is sent, as
  a server that refuses a job does, and a resume starts from that cell; the bot's own pictures fall back to the polls
  as before;
- `loaderCacheMiss`: whether any loader node of the job ran rather than being answered from ComfyUI's node cache
  (`execution_cached`). It proves nothing about weights moving to the card, and a model the server offloads and
  brings back inside a job stays inside that job's time;
- `first`: whether the frame is its arm's first. A **warm** frame has no loader cache miss and is not its arm's first;
- the video memory sampled every half second while the job ran, counting torch's reserved pool as occupied: a
  sampled high-water mark, which the true peak can exceed between two samples. Counting the pool narrows that gap
  and does not close it;
- the system RAM, which counts every process on the machine and not ComfyUI alone;
- `partialModelLoadEvents`: the partial loads ComfyUI's own log reports during the job. The cache node on `auto`
  moves what does not fit into RAM rather than failing, so a run without an OOM may still have spilled; a count of 0
  does not prove the models stayed on the card.

The portrait run, and each arm's first frame, are shown apart from the warm frames. The prompt is counted in text
tokens as the encoder reads it, or in characters when `tokenizers/` is missing. C's shorter text is fewer words for
the encoder to read, and no promise of less compute: a reference adds a vision pass and a longer sequence.

<a id='control'></a>

**The text-to-image control.** Arm A is not the bot, so the graph the bot draws with is drawn too, on the same
1280x704 canvas: frames 1, 2 and 3 at the first seed, picked before the run by the rule the arms follow, so one first
frame and two after it. It is drawn once, with nothing chosen among, and only after a complete main set: a main set
with a failed cell gets none, and a control the end cut short is not resumed, which the report says. The report gives
it as cost only, outside every gate: its first frame, and its warm median against A's warm frames of the same scenes.
The bot's own 1280x720 is skipped: one more canvas for one more number.

<a id='judging'></a>

**Judging.** `bundles` writes one bundle per arm and seed under `review/`, and only for a run that has a verdict
(below). A transition compares two frames of one arm, and a session shown the arms side by side would judge the arms.
Bundles and pictures are named by hashes, and the key stays in `keys/`. Every frame is shown with `frame_text`, the
text with all its looks, whichever arm drew it, because arm C's own text would name the arm.

The bundle's `checks.json` is the sheet the gates are counted from:

- **transition**: each sheet person in each pair of frames that follow each other, with `face` and `figure` apart. A
  face kept on a body that lost its build is `figure: no`;
- **picture**: each picture's `action`. Where two people of the sheet share the picture, also `apart` (nobody has
  another's face or figure) and `swap` (nobody took both another's look and clothes);
- **clothes**: each appearance's `clothes`;
- **style**: one answer for the bundle.

Question 5 of TASK.md asks about the style and the people apart, and about the face and the figure apart. Each bundle
goes to a reading session of its own. The session's report ends with its answers as one JSON block, which is saved
as `answers/bundle-N.json` in the run directory for `report` to count. Bundles are built once, because the answers are
read against them.

`image:blind` now deals the arms as contenders of their own. It leaves out any question whose pictures were drawn on
two canvases, and counts them. The identity run is judged by its own bundles all the same.

<a id='gates'></a>

**The gates, fixed before the paid run.** These are Astra's engineering gates of 2026-09-24, as `report` counts them;
their numbers are one table, `CRITERIA` in [image-identity.ts](../local/image-identity.ts). They are thresholds for
the next decision, not a statistical proof. The 26 transitions of an arm are repeated observations of six people, not
26 independent characters. A transition checks that two frames of one arm agree, and the figure against the look; it
does not compare a face with its portrait. So a pass proves no exact transfer of a face from reference to scene, and
a small experiment promises no identity beyond its own set. Each gate is counted for B and for C against A, over all
the arm's bundles. A `no` and an `unsure` both count against the picture. An arm with an item unanswered is
unscored, never passed.

1. **Recognition.** At least 20 transitions; the set gives 13 per seed, 26 per arm. The face is kept (`face`) in at
   least 90% of them, and the figure (`figure`) in at least 90%. No picture mixes two people up (`apart`).
2. **Against A.** The share of transitions that keep both face and figure is at least 15 points above A's. If A is
   at 90% or above, B cannot pass. C passes then only if all three hold: it is at most 5 points below A, its median
   prompt is shorter than A's, and it has no more action errors than A.
3. **Clothes.** The frames' own changes of clothes are Бран's in frame 1, Ива's in frame 4, and Лада's and Вера's in
   frame 6: eight appearances per arm over the two seeds. At least 90% of them show the clothes the frame gives,
   which on this set means all eight, so 7 of 8 fails. No case where a person's identity and clothes carried over to
   another person (`swap`), and no more action errors than A. Every appearance that differs from the neutral
   portrait, changed by the story or not, is shown beside the gate as a number of its own. It gates nothing and does
   not dilute the explicit changes.
4. **Time.** The frames counted are the arm's warm frames, each matched with A's warm frame of the same scene and
   seed. Over them, the arm's median time is at most 1.5× A's, and its slowest at most 2× A's slowest. The portraits,
   the first frames and the control are shown, not counted here. With no matched frame the gate is unmeasured, and
   so it is with one frame of the arm or of A whose job the socket did not hear from its start: that frame is neither
   warm nor cold, and leaving it out could leave out the slowest.
5. **Memory.** No OOM. Every frame of four references is drawn, sampled while it ran, and leaves at least 2 GiB of
   the card free at its sampled peak. A frame of four that failed or was never sampled fails the gate. RAM and partial
   loads are shown, not gated: what they cost is time, and gate 4 counts time.

<a id='complete-run'></a>

**Complete, or no verdict.** An arm passes with all five, and only in a complete run. Complete means all 48 cells
drawn on the right geometry, with no failure, no stop and no error. The right geometry is the file at 1280x704, as
many references as the set binds for its frame (none in A), and each of them at 704x1280. A failed cell stays in the
record as the cell's result, and the set it belongs to is **incomplete**: no gates, no verdict and no bundles,
whatever the surviving cells would say. A run whose smoke or geometry failed gets no verdict either, and neither does
one the end of the rental cut short.

<a id='smoke'></a>

**The smoke** is the frame with one portrait and the frame with four, at the first seed, in all three arms. It passes
only if all of these hold:

- all six cells are drawn and none failed;
- they are on the right geometry;
- they are within the card's memory, by gate 5's rule on its two frames of four;
- they give what gate 4 needs: every picture's phases and loader answer heard on the socket, and a warm frame of B
  and of C matched in A.

Anything less, and the tool refuses the main set in that directory: the measurement ends there and the card is let
go. A fix, such as the cache node off `auto` or smaller portraits, is another run with its own pins.

<a id='one-hour'></a>

**One hour, ended on the wall clock.** The card is rented only with the owner's explicit consent and under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). `gpu/rent.mjs --hours 1` sets the guard of
[trial-onstart.sh](../gpu/trial-onstart.sh), which deletes the machine an hour after the box started, whatever is
running, and which nothing extends. The guard can fail, though. It does not start without the container's key, `curl`
and `flock`; it retries a refused delete forever; it takes its own delete's success for the outcome; and without ssh
nobody can tell it "we're done". So the rental also has an end outside the box, below, and the owner is asked for the
whole paid time, from the creation to a destroy read back as done. For one hour the procedure takes up to 1 h 20 min
20 s at the offer's price: the guard's hour, the quarter of an hour the box is given to start before the guard's clock
does, twenty seconds for "we're done" and five minutes for the destroy to be read back. The traffic comes on top.
That is when the procedure ends, not a cap on the bill: a destroy it cannot read back as done goes to the owner then,
and the machine may bill until the owner deletes it in the console. `gpu/rent.mjs --hours 1 --qwen only` prices each
offer that way, by Qwen's files alone, and its dry run prints the sum as `session`.

The harness takes an absolute end, `--until`: five minutes before the earlier of the guard's deadline and the
operator's own. Nothing is sent to the card after it, and every wait and request of a stage ends there: the socket's
opening, an upload, a poll, a picture's download. A picture that is not in hand with its measurements by then is cut,
even one the card has finished. Its cell stays undrawn and is nobody's failure, and the run stops, incomplete. A job
already submitted gets one minute more, for its id, its stop and the delete of its record, and nothing else does; that
minute ends four minutes before the guard. Once the smoke has timed its frames, no cell is submitted that cannot end
by `--until`. A cell's time is taken from the smoke's slowest frames of one and of four portraits, on a straight line
between them, plus a quarter and three seconds. The main set is priced whole that way before it begins, and so is the
control after it. One that cannot end by `--until` is not begun, and the run ends incomplete rather than half-drawn.
The rental is never extended.

What the hour holds, counted from the guard's start, at the floor the rent filter asks of an offer
(`inet_down` ≥ 300 Mbit/s, [rent-plan.ts](../local/rent-plan.ts)) and at the bootstrap's own floor of 200:

| | minutes at 300 Mbit/s | at 200 Mbit/s | |
|---|---|---|---|
| ssh in, the scripts copied | 2 | 2 | not measured |
| Qwen's three files, 17.28 GB, with `SIMPLE_CHAT_IMAGE_QWEN=only` | 7.7 | 11.5 | |
| torch and its wheels, about 5 GB, on the same link | 2.2 | 3.3 | rent-plan.ts's figure |
| the install: the ComfyUI checkout, pip | - | - | while the files download; any time beyond them is not measured |
| the verification, the server, the tunnel and the card's record | 2 | 2 | not measured |
| 57 cells: 6 portraits, the smoke's 6, the main set's 42, the control's 3 | 41 | 36 | what is left |
| the margin before the guard: a submitted job's minute, the last report, "we're done" | 5 | 5 | `--until` |

That is about 43 seconds a cell at 300 Mbit/s and 38 at 200, with the first loads of the models inside it. The rows
not measured are guesses, not margin: if they run longer, the cells get less. Whether a 25-step frame of four
portraits fits that is the first thing the smoke answers. If it does not, the main set is refused on the smoke's own
numbers. The hour has then bought the smoke's times, which say what a longer rental would need, and that rental is
the owner's decision, never an extension.

<a id='operator'></a>

**The operator** is the Claude session that runs the hour. It keeps the card from the creation until its destroy is
read back as done. During the hour it only runs and watches: the code and its tests are ready before the rental, so a
failure that needs new code ends the hour. The owner's rules apply as written, the 10-minute idle rule included.

- `rented` prints the instance's ID and `destroyBy`: the guard's hour and the quarter of an hour, on the operator's
  clock, counted from just before the create request that succeeded, so however long its answer took. That is the
  operator's own deadline.
- `npm run gpu:rent -- --show ID` reads `present` at once, or the termination follows. It is the path to the rental
  that needs nothing on the box: the account's key, from `.env.gpu` through `node --env-file`, never printed.
- As soon as ssh answers, and no later than a quarter of an hour after the creation, the guard is checked, in twenty
  seconds at most. The runbook's command prints the guard's deadline only while the guard holds its lock, when
  `flock -n -E 75` exits 75, and on no other outcome. Anything but a whole number of seconds no later than `destroyBy`
  is a failed guard: nothing printed, a flock that failed, a deadline file that says something else, a deadline too
  late. The termination follows at once. A flock without `-E` (util-linux before 2.26) prints nothing: a failed guard.

<a id='termination'></a>

**The termination** is one procedure for every ending: a whole run, a failed smoke, a set that cannot end in time, a
bootstrap or ssh that failed, a failed guard, and `destroyBy` itself, which starts it whatever the card is doing.

1. "We're done" over ssh, if ssh works, in twenty seconds at most: the guard deletes the machine within ten seconds.
2. `npm run gpu:rent -- --destroy ID`, with the account's key, as soon as step 1 ends or its twenty seconds run out.
   It takes five minutes at most, on its own monotonic clock from before its first read, whatever Vast answers or
   fails to: every request is cut at twenty seconds or at the time left, the answer's body included, every pause at
   ten seconds or at the time left, and nothing is sent after the five minutes. For its first 60 seconds, the guard's,
   it only reads, every ten seconds. After them, while no read says the instance is gone, it deletes it with the
   account's key, and again every half minute.
3. `destroy_confirmed` ends the rental. Anything else, `destroy_unconfirmed`, `destroy_refused` or no answer, goes to
   the owner at once, with the ID, as a deletion not confirmed that may still be billing, never as "the hour is over".

A stop is not a destroy: a stopped instance keeps its disk, and Vast bills the disk. Nor is the destroy's own
`success` a read-back: only a read that says the instance is gone ends the procedure.

<a id='runbook'></a>

The runbook, in its order:

```sh
npm run image:identity -- dry-run    # before renting: all of it against a fake ComfyUI, with made-up answers
npm run image:identity -- set        # the set and the portraits' prompts, in illustrations/identity
SIMPLE_CHAT_RENT_DRY_RUN=1 npm run gpu:rent -- --lane pictures --hours 1 --qwen only    # each offer's `session`
npm run gpu:rent -- --lane pictures --hours 1 --qwen only    # with the owner's consent; `rented` names ID and destroyBy
npm run gpu:rent -- --show ID    # present, at once
destroy_by=DESTROY_BY            # from `rented`
# As soon as ssh answers. The deadline is printed only on flock's 75, the lock the guard holds. Anything but a whole
# number no later than destroy_by is a failed guard: terminate now. The number is checked before any arithmetic.
guard=$(timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast \
  'flock -n -E 75 /root/.simple-chat-trial-guard.lock true; [ $? -eq 75 ] && cat /root/.simple-chat-trial-deadline')
if [[ $guard =~ ^[1-9][0-9]{0,11}$ ]] && (( guard <= destroy_by )); then end=$(( guard - 300 ))    # min(guard, destroy_by) - 300
else end=0; echo 'failed guard: terminate now'; fi    # 0: a past end that every stage refuses
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only bash /workspace/simple-chat/gpu/image-bootstrap.sh'
# The server on the machine's one card, and the tunnel to it, each in a terminal of its own:
ssh -t simple-chat-vast \
  'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 bash /workspace/simple-chat/gpu/image-serve.sh'
bash gpu/tunnel.sh --pictures-only simple-chat-vast
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/identity/card.txt
npm run image:identity -- portraits --until "$end"
npm run image:identity -- draw --smoke --until "$end"
npm run image:identity -- report
npm run image:identity -- draw --until "$end"    # the main set, then the control
npm run image:identity -- report
# The termination, here and after every other ending: we're done, then the destroy whatever the ssh did.
timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'; \
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
npm run image:identity -- bundles    # no card needed from here on
npm run image:identity -- report     # once answers/ holds every bundle
```

`image-verified.txt` is what the bootstrap wrote once every file was verified: the ComfyUI revision it checked out
and each file's SHA256 as computed on the box. Every drawing stage refuses to start without it, or with a record that
differs from the manifest, and pins the run to it. "We're done" writes the present time into the guard's deadline.
The guard reads that file again every ten seconds and takes an earlier time, never a later one. The drawing stages
also take `--comfy`, `--wait`, `--timeout` and `--tokenizers`, whose defaults the runbook keeps. Everything lives in
one directory, `illustrations/identity` unless `--dir` names another:

- `set/` and `portrait-prompts/`, the prompts;
- `card.txt`, the card's record;
- `portraits/` and `references.json`;
- `run/`, the arms, with `review/`, `keys/` and `answers/`;
- `control/`.

The graphs are the repository's `gpu/image-workflow-qwen.json` and `gpu/image-workflow-qwen-edit.json`. They have one
source and one set of names, so the repository's copy and the box's are the same file.

`dry-run` goes through all of it against [fake-comfy.ts](../local/fake-comfy.ts), with a socket that opens late on
purpose and made-up answers. On the way it goes through every refusal the paid run relies on:

- the main set before the smoke;
- two lost portraits, and after them the smoke and a redraw refused;
- a smoke that fails at one portrait;
- a resume with another set, and the run byte for byte unchanged after it;
- a main set that cannot end in time, and a job the end cuts;
- bundles of a run with no verdict.

Its made-up answers put C at 7 of 8 on gate 3 and B at 8 of 8, so its verdict is "B passes, C fails". The fake keeps
the contract the harness talks to, with delays, failures and telemetry set by hand, and models no card.

<a id='not-verified'></a>

**Not verified without a card**, in the order it would bite:

- how long the image takes to pull and the box to start, which the quarter of an hour before `destroyBy` allows for;
- that the int8 transformer and the int8 encoder load through `UNETLoader` with `weight_dtype: default` and
  `CLIPLoader` with `type: qwen_image` (read from the pinned source, never run);
- that `SIMPLE_CHAT_IMAGE_QWEN=only` prepares and serves a box. It was checked dry: the bootstrap's `--dry-run`, its
  verification step on a synthetic file, and image-serve.sh on a synthetic box;
- how long one 25-step frame takes, which decides whether 57 cells fit the hour at all;
- whether four references of 704x1280, plus the encoder, plus the transformer stay inside 32 GB, and how much the
  cache node on `auto` spills to RAM;
- whether an upright portrait on a wide canvas keeps a person as well as a wide portrait would;
- what a frame of the text-to-image graph costs against A's, which the control prices;
- whether the websocket messages, `/system_stats` and the log ring are what [fake-comfy.ts](../local/fake-comfy.ts)
  says they are, from the pinned source;
- that the account's key may destroy an instance, which `--destroy` learns only when it is used;
- what Vast answers to a read of a destroyed instance. `--destroy` takes only a 404, or a 200 whose record is null,
  for gone, so any other answer ends as a deletion not confirmed and goes to the owner. The fake API of
  [rent-plan.test.ts](../local/rent-plan.test.ts) answers both ways, and a Vast that answers neither would raise a
  false alarm, never a false all-clear.

The fake's numbers are made up and say nothing about the card.
