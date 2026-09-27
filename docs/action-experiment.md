# The action measurement

The owner's question, 2026-09-25: in a scene where several people touch, the text model mixes their looks and their
actions up. Does the first picture show the action better when Gemma writes the situation without dwelling on looks,
and portraits carry the looks? And does it help to pick each person's portrait by the side they turn to the camera?

What the run can answer is narrower, and this protocol says so. Gemma still reads a story full of looks, and the bot's
frame already leaves `look` empty for the people of the sheet, so no arm isolates a confusion inside the text model.
The run compares workflows: whether keeping appearance out of the frame's other fields, and handing the looks to
portraits, makes the drawn action better. To tell where a failure comes from, each stage is checked on its own: the
narrator's scene against its target, the sheet against the cast, the prompt's text against the checklist, and the
picture ([judging](#judging)).

The identity run of the same day found that portraits of 704x1280 keep a face but break actions: people turn to the
viewer as in their portraits, and a frame with four of them took 82 s against 15 s without
([the run](identity-experiment.md#result-2026-09-25)). This measurement asks about the action first, on scenes built
for it, and on the bot's own path: the uncensored Gemma writes the scenes and the frames on a rented card through
[simple-serving](model-providers.md#simple-serving-our-gateway), and Qwen-Image 2.1 draws them on another.
[Stage 1](#stage-1) wrote the frames of the clean scenes with a hosted Gemma and drew nothing. The first round wrote
its texts on 2026-09-25 and 26 and drew seed 7 on the 26th, with up to six people in a moment; the next one has four
([four](#four)), eight more clean scenes of one to three people ([the set](#the-set)), checklists that count a
touch of one's own body, of a thing and a reflection ([one](#one)), and fronts drawn from the `details` the bot's
sheet now writes of each person, whose new instruction changes the pins ([the sheet](#the-sheet)). Round one's T gave
L's picture back and took nothing from the portraits; [the T probe](#t-probe) tries nine variants of T on a card of
its own, from round one's own pictures, and first on the same card [a clothing test](#t-probe-suit) and
[a language test](#t-probe-lang) of the portraits. After it, on that card, [the pilot](#pilot) times round two's path
and the Triton backend before round two draws.

Round one's results, and what round two changed because of them, are in
[action-measurements.md](knowledge/action-measurements.md#round-one-2026-09-26).

<a id='stage-1'></a>

## Stage 1: the frames without a card

On 2026-09-25 the hosted `openrouter:google/gemma-4-31b-it`, not the heretic, described 13 synthetic stories through
the bot's own adapter: the sheet, the frame on the bot's instruction, and the frame on a variant that asked for the
action while it happens, every participant up to six, and a `view` of each person. It took 39 calls, none retried or
unparsed, 101 630 tokens, about $0.03. The stories, the replies, the prompts and the full review, in Russian, are in
the gitignored `illustrations/action/stage1/`. A Claude session wrote those stories' scenes, not the narrator.

What it found, and what this protocol changes because of it:

- No action went to another person in 26 frames. Grips and body sides mostly followed the scene, with exceptions: a
  daughter holds the father's shoulder and armour where the scene has her arm round his neck, and the patient's right
  and the giant's right wrist became screen sides.
- The bot's limit of four people dropped people in 4 scenes of 13 (the beach, the lineout, the rescue, Gulliver), and
  in three of them the moment still spoke of the whole group. The rule "before or after the complex contact" never
  moved the moment. In the variant every human participant was in the frame's text, but not always as a person of
  their own: Gulliver's three guards shared one entry, and the macaque on the backpack strap dropped out of both
  frames. The creatures were never `people` and never on the sheet.
- Gazes and faces dropped out and grips did not: the father's look back over his shoulder, snarls, laughter.
- The props rule ("name people by a visible feature", "who has empty hands") put appearance into props and moment,
  and declared empty the hands of three people holding the demon.
- "From the waist up" cut a contact twice: a grip under the knees, and a leg wrapped round a leg.
- The sheet lost ages (daughters of 8 and 4 both "young girl"), wrote three guards as one line, kept the creatures
  (jellyfish, macaques) off the sheet, and let the Russian word «рыжая» into one look. Giant and tiny lived only in
  the looks.
- `view`, "which side faces the camera", did not fit 16 of 49 people and could not be decided for 7, and all three
  `back` were wrong. Gemma wrote where a person stands relative to the central figure, not which way they face.
- In the form with portraits, "the person from image N" was never tied to the role words of other lines ("the
  demon", "the flyer").

## The arms

Gemma writes two frames of every scene, one on the bot's instruction and one on [the variant](#variant). Six arms
draw them:

| Arm | The text | References |
| --- | --- | --- |
| A | the bot's frame, assembled by `assemblePrompt` as the bot does | none |
| A+ | the variant, with the sheet's looks | none |
| L | the variant, without the looks of the people who have a portrait | none |
| C | L's text, each of those people named "the person from image N" | their front portraits |
| V | as C | each portrait turned the way the person faces ([views](#views)) |
| T | an edit of L's picture that keeps everything and takes faces and builds from the portraits | L's picture, then C's portraits |

Each pair compares two workflows, and each difference changes more than one thing. No arm here separates them
further, so the mechanisms inside a difference stay open.

- A+ against A is the whole variant: nine changes (seven in round one), a new schema and output limit, a frame
  written anew, and the assembly with role and facing. No single change is measured.
- L against A+ takes the looks out and shortens the text at once. If L gains, leaving the looks out was enough for the
  gain; whether the brevity or the removed conflicts did it stays open.
- C against L adds the portraits and the "image N" wording together. C against A+ is the substitution the owner asks
  about: portraits in place of written looks.
- V against C turns the portraits, and a view is also an edit, which may drift from the front in face, marks and
  detail.
- T against L adds a second generation, conditioned on L's picture, the portraits and an instruction of its own. T
  against C compares two strategies of different cost. Ordinary edit drift is not controlled.
- No arm is compared with the identity run: the scenes, the text model, the assembly, the reference size and the casts
  all differ.

## The set

Twenty-eight stories: the 13 clean stories of stage 1, eight clean ones of one to three people and two of four people
given in measurements added for round two, and five sharp ones that Gemma writes itself. The owner may add up to ten
sharp scenes of their own ([own](#own)). Round one had the first eighteen.

- The owner's five: a warrior flees a rockfall with his wife on his back and his daughters in his arms (`flight`);
  three people hold a demon by different parts of his body (`demon`); women close tightly round a young man on a
  beach (`beach`); two giants poke at a traveller (`giants`); a swimmer covered by jellyfish with human faces
  (`jellyfish`).
- Eight scenes of close contact with nothing erotic in them: grappling on a mat (`guard`), a rugby lineout
  (`lineout`), a cheerleading lift (`cheer`), a tango dip (`tango`), macaques robbing a tourist (`monkeys`), a
  stretcher carried by rescuers (`rescue`), a giant tied down by tiny people (`gulliver`), a game of twister
  (`twister`).
- Eight for round two, which the owner approved on 2026-09-26, so that every count of people in a moment from one to
  four has at least four scenes: a man tracing the scar on his shoulder before a mirror (`mirror`), a climber on a
  boulder (`climber`), a smith at the anvil with tongs and a raised hammer (`smith`), an archer drawing her bow
  (`archer`), an arm-wrestling match (`armwrestle`), a forearm being bandaged (`bandage`), two friends carrying a
  third across a ford on their joined hands (`crossing`), and a boost over a fence (`fence`). By the people their
  targets need, the clean scenes now hold one in four of them, two in four (`guard`, `tango`, `armwrestle`,
  `bandage`), three in four (`giants`, `twister`, `crossing`, `fence`) and four in eleven. A scene of one person has no
  contact between people, so its checklist counts a touch of one's own body or of a thing ([one](#one)).
- Two for round two, which the owner approved on 2026-09-27, of four people each given in measurements, so that the
  figure is tested beside the action. In `gym` four women train side by side, each at an exercise that shows the hips
  and buttocks from the side: a squat with a barbell, a Romanian deadlift, lunges with dumbbells and kettlebell swings.
  Their busts are the Russian sizes 6, 7, 7 and 8, each with its two girths, and their hips and buttocks are graded in
  words the other way, from very wide and very large at the 6 to narrow and smallish at the 8, so that a picture that
  draws one woman larger all over cannot pass; the two sevens are alike in all of it but their hair, and each woman has
  one trait seen from afar. In `huddle` a relay team stacks four right hands before the start: a mother of 44 who looks
  under thirty and her daughter of 22, alike, tall and very fair, with their heights and girths in one table; a man of
  51 who shaved off the beard he wore for twenty years before the race; and a tall thin student. Both are clean:
  sportswear, ordinary training, neutral words for the body. The owner asked on 2026-09-27 that `gym` test the hips
  and buttocks as well as the bust, since one question about the build lets a wrong proportion pass
  ([judging](#proportions)).
- Five sharp scenes, one per theme, with exactly the planned number of characters, all active in the target moment.
  The counts are fixed before the text card: a bathhouse (`sharp-1`, one), a harem (`sharp-2`, four), captivity
  (`sharp-3`, three), an interrogation (`sharp-4`, two), and a battle with wounds (`sharp-5`, four). The bathhouse
  gives a natural moment of washing one's own body or touching a bath object; an interrogation needs two people;
  captivity can put three in one physical action; the harem and the battle can put four in one action. Thus the sharp
  set itself covers one, two, three and four.

A story is a seed and one reader's action, in Russian, as the bot's stories are. The seed names the place, the time
and each person with a name and a look. The narrator writes the opening scene from the seed and the action scene from
the reader's action, through the bot's `generateScene`, and the frames describe the action scene. Two scenes rather
than one, because the sheet's instruction asks for the people who appear in more than one. The first thirteen clean
seeds and actions are written from stage 1's stories, their `target` and `cast`, and the ten of round two as stories
of their own. All are fixed in `examples/action-set.ts` before any card, each with its target: the contact the moment
should hold and the participants it needs. No moment has more than four participants, and no cast more than four
people, the bot's own limit for a frame ([four](#four)). The scenes are not stage 1's: the reader's action says what
the moment is, and the scene is whatever the heretic writes.

Round one reached the target in 5 of 18 action scenes: 1 of 13 clean scenes (`gulliver`) and 4 of 5 sharp scenes.
No sharp scene went unjudged. Those texts, checklists and answers remain round one's record. In round two the five
sharp themes and their planned counts are pinned before a card; no session chooses a count after seeing a story.

Each sharp story is written by the heretic on the same card, in one call, before its flow starts. A Claude or GPT
session writes no sharp story: only this pinned instruction and the theme words. The harness fills `ТЕМА`, `СОСТАВ`
and `МОМЕНТ` from the theme and its planned count:

> Придумай завязку для интерактивной истории для взрослых на тему «ТЕМА». Все персонажи взрослые, им больше двадцати
> лет. Никакого сексуального насилия и ничего сексуального без согласия. Откровенность и жёсткость допустимы, если
> тема к ним ведёт. Всего в истории ровно СОСТАВ: пол, возраст словом, телосложение, волосы, приметы каждого;
> место и время. Названные существа входят в это число, других действующих персонажей нет. Завязка должна подвести к
> одному моменту, где МОМЕНТ. Ответь в JSON: seed, завязка в 6-12 строк; action, действие читателя, которое ведёт к
> этому моменту, одна-две фразы.

`СОСТАВ` is `один персонаж с именем и заметной внешностью`, or `два персонажа`, `три персонажа` or `четыре
персонажа` with `с именами и заметно разной внешностью`. For one, `МОМЕНТ` is
`единственный персонаж касается собственного тела или предмета сцены`. For two to four, it is `КТО тесно касаются
друг друга: держат, несут, обнимают, моют, связывают или перевязывают`, where `КТО` is `оба персонажа`,
`все три персонажа` or `все четыре персонажа`. The checklist target repeats the corresponding
moment: `Один момент, где МОМЕНТ.` It also gives the judge `count: N`; `participants` is `yes` only
when exactly N people take part in that physical action. The one-person target uses the checklist's existing self or
object relation; a mirror is also scored if the scene shows one ([judging](#judging)). The sharp stories are [sealed](#sealed).

<a id='own'></a>

**The owner's own sharp scenes, since 2026-09-26.** Beside the five, the owner may write up to ten sharp scenes into
`illustrations/action/sealed/own.txt`, which git ignores and the owner's deny covers, so no Claude session reads it.
An entry opens with `тема:` and a theme on the same line, then `участников: N` on the next nonblank line; the heretic
writes its seed from the pinned instruction, as it does the five. Or it opens with `сцена:` and a title, then the same
`участников: N` line, the seed's lines, and `действие:` and the reader's action; the owner's own words are the story.
N is 1, 2, 3 or 4: exactly N characters in the whole story, named creatures included, all active in the target
moment, and no other acting characters. A line that starts with `#` is a note, and a blank line is skipped.
The rules are the instruction's: every character an adult over twenty, nothing sexual without consent and no
sexual violence.
For one participant the moment touches their own body or a scene object; for several, all N take part in the contact.
The entries follow the five as `sharp-6` on, in the file's order, with their start time and their count-specific
target, and are sealed as they are. `npm run image:action -- own` counts the themes and the scenes; a
malformed file is refused with a line number and nothing that is on it. The first text run pins the file in
`sealed/own.pin`, and every command after it refuses a file changed since, so the scenes are written before the text
card. Each costs about three and a half minutes of the picture card at each seed, as round one's sharp scenes did at
seed 7, and four judge sessions: the checklist, the text, the pictures and the identity.

Whether a scene reached its target is the first thing the judges answer, before any picture exists: whether the
contact happens in substance, by whatever part of the body ([loosened](#loosened)), whether each participant it needs
is in it, and whether the moment can be told apart. A scene that missed stays in the run as written and is never asked
again. The report counts the misses and shows every gate over the scenes that reached their target beside the main
count. A pass those scenes do not repeat is reported as a pass of the main count alone, never as success on the
moments the set was built for.

<a id='four'></a>

**Four people, since 2026-09-26.** The first round let a moment hold six participants, where the bot's frame holds
four, and wrote its texts and drew its seed 7 that way. After seed 7 the owner cut every scene to four. Of the six
clean stories with more, four lost the people their seeds name last: the beach Оля and Вика, the lineout the Oaks'
lifters Митя and Гоша, so Фёдор now jumps unlifted, the monkeys Бубу, and Gulliver both guards. The rescue lost its
last two carriers, Вадим and Ильдар, so two carriers hold the stretcher, and the jellyfish the twins Пим and Пом,
since one of two twins is no twin. The variant asks for four participants at most, as the bot's frame does, and the
sharp instruction for exactly the planned number of characters, including named creatures, with no other acting
characters and all active in the target moment of each sharp story ([the set](#the-set)). The first round's set and
protocol are those of commit 7e7de76. The cut is the owner's choice, not a finding of the first round: at its seed 7, C lost to A+ on looks by 3 points in the
five clean scenes that bound one to three portraits, by 44 in the four that bound four, and by 8 in the four that
bound six.

<a id='text-run'></a>

## The text run

It runs on the text card once simple-serving's smoke has passed whole on that card, by the smoke's own record: every
probe of one plain run, from the gateway's state through the count matrix to its privacy check, not a single
completion. Never before. The stop, the read-back and the resume with a new boot are the rehearsal's, on a card of its
own ([the rentals](#the-rentals)); the text card is never stopped. Every call is the bot's own, through the
`simple-serving` adapter as class `internal`:

1. for a sharp story, its seed and action;
2. the opening scene and the action scene, by `generateScene`, in the harness's own store;
3. the sheet, by `sheetRequest`, read by `sheetOf` as the bot reads it;
4. the bot's frame, by `frameRequest`;
5. the variant frame;
6. the retelling of the whole sheet, by `retellRequest` ([the sheet](#the-sheet)).

That is 173 calls before retries, 5 seeds and six calls for each of the 28 stories, where round one's 18 took 95;
each of the owner's scenes adds six, and each of their themes seven. The gateway's smoke, the marker check, the retries
and the counts the adapter may ask for before it sends are requests on top of these, and the report gives them apart.
Two stories run at once, since the gateway admits two `internal` calls; that is a provisional limit of its contract,
not a measured throughput.

The bot's `askJson` only parses a reply. The harness wraps the provider and records every attempt: its kind, the
tokens in, out and cached (a count the gateway does not give stays unknown, never 0), the gateway's wait, first token
and total, the finish, whether it was the retry, and a code. No text reaches a log or the terminal. Each reply is then
decided by rules fixed now:

- `unparsed`: `askJson`'s second try did not parse either;
- `truncated`: a reply that parsed but finished on `length`;
- `schema`: a reply that parsed and breaks its schema, checked on the raw reply before `sheetOf` could drop an
  entry: a required field missing, a value outside an enum, more than four people, or, in the variant, two
  participants with the same role, compared trimmed and without case, or, in the retelling, a person of the sheet
  left out or given a digit or a table's bar;
- `empty_sheet`: a sheet with no entry;
- `failed`: the call failed, with the adapter's code.

A failure takes out what needs its output: a scene, the sheet or the retelling, the whole story, since the retold
looks are in every arm's prompt and the retold details draw the fronts; the bot's frame, arm A; the variant, A+, L,
C, V and T. Nothing is asked again by choice.

<a id='again'></a>
One exception, the owner's of 2026-09-25. On the text cards of that day simple-serving's gateway forbade whitespace
between a schema's tokens, and 5 of the 18 sheets came back with nobody on them
([the note](knowledge/gpu-measurements.md#text-cards-2026-09-25)). Those five sheets are asked once more on a card
whose gateway allows whitespace, with `texts --again` and their ids, and the frame and the variant after them. The
scenes stay as they were written. A sheet's first outcome stays in its story's `text.json` as `earlier` and in
`texts.json` as `again`, and `--again` refuses a story whose sheet did anything else. The pins cannot tell the two
gateways apart, since the whitespace rule is the card's and not the adapter's, so `again` is what names the five.

The run is pinned to the local end of `cli up`'s tunnel, held in the foreground, the served name
`gemma-4-31b-heretic-nvfp4`, a context of 65536, the bot's sampling for this provider, and the instructions and
schemas by their hash. The adapter's timeout is 900 s, the gateway's own wall for `internal`, where the bot's default
is 300. The harness reads `client_key` alone from `~/.config/simple-serving/config.json`, which also holds the control
and Vast keys, and prints none of them.

If the smoke fails, the texts wait for a text card with llama.cpp and the bot's Q6_K, rented with a «да» of its own,
and the harness takes the model from `.env.gpu` as eval's `gpu:<label>` does. The report names the weights either way.
Route A is simple-serving's 4-bit NVFP4 conversion of the same heretic, not the bot's Q6_K; whether it writes stories
as well is eval's question, not this one's.

<a id='variant'></a>

### The variant frame

The variant is the bot's frame instruction with these changes and no others. Its text and schema live in the harness,
pinned by their hash. The bot's own instruction does not change unless [gate 1](#gates) passes and the owner agrees.
Every line of the bot's instruction was read against the changes: the rule of four and its crop, "before or after the
contact", the props example and the empty hands are replaced, and the rule to hide precise contacts is kept for small
objects, as change 7 says.

1. The moment is the main action the scene ends in, while it happens, not before or after it.
2. Every participant of the main action is in `people`, up to four: people, animals and creatures alike, each as an
   entry of their own even when they are alike, so two guards are two entries. People who only watch may be left out.
   Over four, a crop leaves the rest out, and part of a group is never shown as the whole of it. The first round had
   six here ([four](#four)).
3. `role`, new and required: two to eight English words, one phrase for one participant, used for nobody else and
   repeated word for word wherever `moment`, `props`, `state` and `action` name that participant. It names their part
   in the moment and their place, with an explicit owner of anything it mentions ("the running father", "the girl in
   the father's left arm", "the rear lifter of the near pod"), and never their appearance or name. Species and scale
   stay in it where they are the scene's premise ("the crouching giant", "the tiny sailor"). Code checks that no two
   participants share a role; the length is advice to the model and is not checked.
4. `facing`, new and required, one of `viewer`, `away`, `screen-left`, `screen-right` and `other`: where the front
   of the person's torso points as the camera sees it. A three-quarter view takes the nearer value, and one exactly
   between two takes the one nearer `viewer`. Lying face up under a camera from above is `viewer`, and face down is
   `away`. `other` is for what the four cannot describe: a creature without a front, or a torso that points up or down
   the picture, as a body lying face up seen from the side. `facing` speaks of the screen alone: body sides stay the
   person's own, as the bot's rule says, so a person in profile turned toward the left of the picture shows the camera
   their own left side. Where the head turns and the eyes look belongs to `action`.
5. No lasting appearance outside `look`: no hair, face, skin, build, age or colour of clothes in `moment`, `shot`,
   `setting`, `objects`, `props`, `role`, `state` or `action`, and clothes only in `clothes`. The action needs some
   words that look like appearance, and they stay: expressions, fresh wounds and dressings, the body parts of a
   contact, and a garment as the place of a grip ("grips his collar"). `props` names each important object once, with
   its state and every holder by role and by where they hold it ("the stretcher, its front handles held by the
   front-left carrier and the front-right carrier"). The example of "the gray-clad woman" and the rule on empty hands
   go.
6. Where the scene says where a person looks or what their face does, it is part of their `action` ("looks back over
   his right shoulder", "snarls"). A face turned away from the viewer keeps where it looks and gets no expression
   nobody could see.
7. The shot keeps the main action's contacts in the picture. The edge of the frame never cuts a limb where it touches
   another participant: no "from the waist up" when knees or legs touch. A body may hide a contact where the scene
   puts it behind that body; the edge may not. The bot's rule to hide precise contacts stays for small objects, a
   blade in a slot or fingers on a button, and does not cover contacts between participants.
8. `clothes` names what a participant leaves bare: a torso, legs or feet with nothing on them are said in so many
   words ("wearing only rolled-up linen trousers, bare-chested and barefoot"), and nothing is bared that the scene
   does not bare. The owner added this on 2026-09-26, for round two. In round one's `demon`, C at seed 7 drew the demon
   in the white tank top of his portrait: the scene dressed him in "a tattered leather skirt and iron bracers" and
   said nothing of his chest, so the reference filled what the text left open. The other three people in that
   picture wore the scene's clothes.
9. The bot's rule to keep who does what, with which hand, and where people and objects touch asks instead for the
   physical interaction of the participants: who acts on whom or on what, with which part of the body (a hand, a
   foot, a knee, a shoulder, the back, the head, the whole body), and against which part of another participant's
   body or which object. The owner asked for it on 2026-09-26, for round two: a rule about hands does not ask for a
   contact made with a foot, a knee or the whole body. The rule gives no example, so that no scene of the set is
   written into it.

In the schema, `people` holds up to four items, the bot's own limit, and `role` and `facing` are required, `facing` as
an enum. The output limit is 1800 tokens, twice the bot's: stage 1's longest variant reply took 710 with six people
before `role` and `facing` were asked for, and a cut reply is a failure.

### The sheet

The sheet is the bot's own, since the bot's portraits are drawn from it, and the harness never changes it on its own.
Its defects belong to the pipeline and are measured, never repaired. Code compares it with each clean story's frozen
cast, one entry per person, and with the participants of each sharp story's checklist. The report gives, per scene,
the participants of the moment, how many of them the sheet has, and how many were bound to a portrait.

Round one's sheet asked for age in words made for adults (young adult, middle-aged, elderly). Both daughters of
`flight`, 8 and 4 in the seed, came out as a "young girl", and their fronts drew adult women; three of that sheet's
four looks named no skin tone. On 2026-09-26 the owner changed the bot's sheet
([portrait details](illustrations-plan.md#portrait-details)): before each look it writes the person's `details`, 50
to 80 words that have the age words of children too, and compresses the look from them. Round two's fronts are drawn
from the details as the bot's portraits are (`portraitText`), and every frame keeps the look. The judges read each
person's look as their line of the sheet, and the check of the fronts reads their details too
([judging](#judging)). The new instruction and schema change the pins, and whether the
daughters now come out as children is the judges' check of the fronts to say. The same day the owner changed the
style line that ends every frame (`STYLE` in `local/illustrate.ts`) from adult faces to faces true to each person's
age, so that the child a look names is not made an adult at the prompt's end. Round two's L, C and T take the new
line, and it changes their pins too; the T probe keeps round one's ([the T probe](#t-probe)). The frame's look of a
person the sheet does not name takes the same age words and the skin tone, which changes the frames' pins as well.
On 2026-09-27 the sheet's details and look took the rules of the reader's look: numbers turned into words, with the
heights where a number becomes tall or short, the age a person looks, the usual hairstyle and each noticeable
proportion in words of its own; and the frame's look of a person the sheet does not name took the age that person
looks ([portrait details](illustrations-plan.md#portrait-details)). The instructions' pin changes again, and with it
the frames', so the check below was asked again before the text card, with `--out` naming a new directory: the first
check's `texts.json` holds the old pins, and a rerun there is refused.

The same day the owner replaced that design with three layers
([three layers](illustrations-plan.md#three-layers)). The sheet takes each person's description from the story, in
the story's language with its numbers and tables as written, and the lasting changes the story made beside it, and
writes no details or look. One retelling of the whole sheet writes both, as the sixth step of the text run and the
last, since the frames take the sheet's names and clothes alone and the looks go into the prompts by code
([assembly](#assembly)). Every person must come back retold in words, or the step fails and takes the story out: a
person without a look would be drawn as somebody the sheet does not name, which is not the picture the arms compare.
Round two's fronts are drawn from the retold details. The instructions, the retelling's among them, and the set with
`gym` and `huddle` change the pins again.

<a id='sheet-check'></a>
Before the text card, a cheap check the owner approved on 2026-09-26 says whether the new instruction is followed at
all: round two's text run for a few clean stories on the hosted `google/gemma-4-31b-it`, through the bot's
OpenAI-compatible adapter as a route of its own, `hosted`, five calls a story. The retelling is not asked there: since
the three layers the descriptions are what it checks, and the retelling is checked on them and on descriptions a
reader would write, apart from it ([the retelling's check](illustrations-plan.md#retell-check)).

```sh
npm run illustrate:probe -- --stories flight,mirror,armwrestle --model openrouter:google/gemma-4-31b-it
```

The key and the daily cap come from `.env.eval` as for the eval ([daily limits](eval.md#daily-limits)), and the texts
go to `illustrations/sheet-check` unless `--out` names another directory. A rerun there asks only what is not there
yet and, as in the text run, never a step that failed. Any id but a clean story's is refused before the first request:
"Adult content is never sent to hosted APIs: the test-ground scenarios stay clean"
([acceptance on GPU](improve-loop.md#acceptance-on-gpu)). Each story gets one line of counts and no word of its text:
the steps' outcomes and attempts, the cut replies, the sheet's people; the words and characters of the descriptions at
the fewest and the most, and how many end in the line of what the story did not say, name a person of the sheet, name
a garment or have changes beside them; the words of `details` and `look`, how many hold a digit, a name or clothes,
how many open with or hold an allowed age word or a child's and how many name a skin tone, where a sheet still has
them; and the same age and skin counts for the people of the frames who are not on the sheet. The hosted Gemma is not
the heretic: a pass says that the instruction can be followed, not that the card's model follows it.

Asked again on 2026-09-27 on that day's rules, 15 calls, every step was ok at its first attempt, with no reply cut.
The sheet held the whole cast of each story, seven people, and no details or look held a digit, a name or clothes.
Each opened with an allowed age word within its first three words, the two daughters of `flight` with a child's
("Slender child girl", "Small child girl"); every details named a skin tone, and six looks of seven, the younger
daughter's none. Six details of seven stayed under the 50 words asked, at 25 to 45, where the first check had four
under at 33 to 47, and three looks of `flight` under 15, at 10 to 14. No frame had a person off the sheet and none of
the three stories gives a height in numbers, so neither the stranger's age nor the heights were asked.

On the three layers the same day the check asked `gym`, `huddle` and `flight`: 15 steps in 17 calls, since a provider
failure stopped `flight`'s opening, and then its action, once each, and each was asked once more. Every step was ok,
and the sheets held the whole cast, twelve people. The descriptions were Russian, with no name and no clothes; the
count of a garment found one, «пояса» in «коса до пояса», a braid down to the waist. Every number went in as the story
wrote it: each `gym` woman's size, girths and height, `huddle`'s rows of the table, Рустам's 167 cm and 92 kg, Лёша's
194 and 74. So did every word about the body, as strongly: «очень широкие», «широкие» and «узкие» hips, «очень
большие», «большие» and «небольшие» buttocks, and Ирина's «выглядит не старше тридцати». `gym` and `flight` ended
each description with what the story left unsaid, as its last sentence rather than a line of its own, so the count of
that line found none; it chose the faces in `gym` and the skin and more in `flight`, and contradicted nothing.
`huddle`'s sheet had no such line, so Рустам's and Лёша's skin was never chosen, and their looks have none. Рустам's
shaved beard was in his changes and in his description, and nobody else had changes. Every outfit was English and
began with "wearing", and `flight`'s daughters had no word for the bust, the hips or the buttocks. Two descriptions
copied a comparison from the story, Ксения's «Силуэт мягче, чем у матери» and Лёша's «Выглядит самым хрупким в
команде», which no retelling carried into a look ([the retelling's check](illustrations-plan.md#retell-check)).

<a id='assembly'></a>

## Assembly

Code assembles every prompt from the two frames and the sheet, without a card and without a model.

- **The binding manifest** is planned for each variant frame before the card. It lists, in the frame's order with
  the sheet's people moved first, each person's sheet entry by `matchSheet`, the id of the portrait planned for that
  entry, and the slot. A person the sheet does not name, a creature or a stranger of one scene, is not bound and keeps
  the frame's own `look` in every arm. Two people matched to one entry, or one portrait planned for two slots, stops
  the plan with a code, and the scene leaves L, C, V and T, since the plan is what drops L's looks; A and A+ stay.
  The number bound is checked against the sheet's people in the frame. On the card, each portrait's file is checked
  against the plan before a frame that needs it is sent. One manifest decides every variant arm: whose looks L drops,
  and which portraits C, V and T send in which slots. It takes the place of `bindingPlan`, which stops at the first
  person without a portrait and could bind fewer.
- **A** is `assemblePrompt(frame, sheet)`, the bot's frame and nothing else.
- **A+** writes each person as "look, role, facing, clothes, state: action", with the look taken from the sheet as the
  bot takes it. `assemblePrompt` and `withoutLooks` know neither `role` nor `facing`, so this assembler is the
  harness's own, pinned by its hash.
- **L** is the same, without the looks of the people the manifest binds.
- **C** and **V** are L's text, with each bound person's clause beginning "The person from image N, ROLE,", N being
  the slot's number. That ties the image to the role words the other lines use, the tie stage 1 found missing.
- **T** is "Image 1 is the finished picture. Keep everything in it: the place, the light, the framing, every pose,
  grip and contact, and all clothes. Change only the faces, hair, skin and build of these people in image 1, and a
  build only as far as every contact stays where it is:", followed by one clause per bound person, "ROLE takes them
  from the person in image N", with N counted from 2. A person missing from L's picture is still named, and the
  judges' answers show what the edit made of that. T samples from an empty latent at full denoise like every frame,
  so keeping image 1 is an instruction to the model, not a copy of pixels.
- `facing` becomes "body facing the viewer", "back to the viewer", "body turned toward the left of the picture" or
  "body turned toward the right of the picture", which speak of the torso and leave the head and the gaze to the
  action. `other` adds no words.
- Names and ages are stripped as the bot strips them, and the style line ends every frame's prompt.

The assembly prints counts only: words, tokens as the encoder counts them, people per frame and people bound, and the
letters outside the Latin script, which would have caught stage 1's «рыжая».

<a id='views'></a>

## Portraits and views

A front portrait is drawn for each person a manifest binds, by the identity run's recipe
([portraits](identity-experiment.md#portrait-recipe)): the whole figure from the front, in the bot's plain clothes,
before a grey backdrop, on the text-to-image graph at 720x1280, seed 7. Since round two its text is the person's
`details`, as the bot's portraits take it ([the sheet](#the-sheet)), where round one took the look.

A view is drawn only where a frame needs one. For each bound person whose `facing` is `away`, `screen-left` or
`screen-right`, one view is drawn as an edit of their full-size front, with this prompt and the portraits' style
line:

> Image 1 shows one person. Draw the same person, with the same face, hair, build, marks and clothes, on the same
> plain grey backdrop, the whole body in frame, arms relaxed, now {with the back to the viewer | turned toward the
> left of the picture, seen from the side | turned toward the right of the picture, seen from the side}.

At `resolution` 0 the encode node reads the 720-wide front at 704x1280, so a view is drawn on a canvas of 704x1280,
the size its reference reaches the encoder at: the pinned graph's own note says any other size shifts an edit. A view
is never a mirrored portrait, since a mirror moves a scar or a parting to the other side. Every portrait and view is
drawn once, and none is drawn again or chosen among.

**References reach the encoder at 352x640** in C, V and T, half the identity run's size. Each portrait and view goes
through a scale node of its own to 352x640 on its way to its slot, and the encode node stays at `resolution` 0, so T's
first image, L's picture, keeps the canvas size. One `resolution` for the whole node could not do both. The edit graph
gets a seventh slot for T. `local/image-batch.ts` takes the node on a slot for the file's loader, so the drawing code
learns the scale node: it finds each slot through it, names the file on the loader behind it, drops a whole chain a
frame does not use, and counts the geometry after the scale. The graphs as they are submitted are checked by
[the smoke](#picture-smoke), against [fake-comfy.ts](../local/fake-comfy.ts) in the dry run and then on the card: every
slot sends the file its manifest names, and T's first slot is not scaled. Every picture loses its metadata on the way
to the card and back, as `local/image-batch.ts` already does. The identity run's 704x1280 took 82 s a frame with four
portraits, longer than a reader would wait, and a frame here binds up to four. The results hold for this size and this
recipe: no arm compares sizes, and none is compared with the identity run.

## Drawing

- Every frame is 1280x704, on one edit graph with seven reference slots: six portraits, and L's picture in T. A frame
  binds four portraits at most, so T sends five at most; the slots a frame does not use leave the graph. A, A+ and L
  use none, and the identity run's control showed that this draws the same file as the bot's text-to-image graph.
- Seed 7 decides, and seed 11 repeats it only if [the time](#time) admits it after seed 7. The order on the card is
  [the smoke](#picture-smoke), the rest of the front portraits, the rest of the views, seed 7 in all arms scene by
  scene, then seed 11 the same way. L is drawn before T of the same scene and seed.
- Where no bound person of a variant frame needs a view, V's inputs equal C's. V is then not drawn, and C's
  picture counts for V.
- A manifest whose plan stopped takes its scene out of L, C, V and T, a failed front out of C, V and T, and a failed
  view out of V. A failed frame is that cell alone, and a T whose L is missing is never submitted. A cell left undrawn
  by the deadline or the admission, or kept from the card by the network ([a dropped
  connection](#dropped-connection)), is `not_submitted`, nobody's failure. Nothing is drawn again but a cell the
  network lost after its submit, and every file is kept.
- Each frame records what the identity run's frames record ([telemetry](identity-experiment.md#telemetry)), as round
  two's path measures it ([the next job at the over](#pipeline)), `outageMs` when it waited for the network, and
  `lost`, how many of its jobs the network lost before this one. The run is pinned as that one was
  ([pins](identity-experiment.md#pins)), with the variant's hash, the views' and T's templates, the reference size and
  the manifests added, the text run's model and gateway versions beside them, and `triton` when the server was started
  with comfy-kitchen's Triton backend ([the pilot](#pilot)).

<a id='one-socket'></a>

**One socket a stage.** The first round opened a websocket to the card for every picture and read the card's log
before and after every clean one, and between two jobs the card stood idle about 4.5 s, a fifth of the wall time. A
drawing stage now opens one socket before its first submit and keeps it to its end. Each job is registered on it
under a prompt id the harness mints and sends with the job, which the pinned server takes as the job's own, and is
dropped from it once its picture is down; a socket that closes is replaced, under a new client id, before the next
submit. A clean cell's log is read once, after its job, and where that read ended stands for the next clean cell's read
before it. The log is read anew after a failure, after a sealed cell and on a new socket, as after a server that
started again. No graph a job sends changes, and nothing else the pictures are drawn from; what the socket saves,
with [the next job at the over](#pipeline), is [the pilot](#pilot)'s to measure. The bot keeps a socket a picture.

<a id='pipeline'></a>

**The next job at the over.** With one socket, the card still stood idle from a job's end to the next submit while
the picture came down, was saved and recorded, and the next cell's new references went up. The owner decided on
2026-09-26 that round two sends each job as soon as the one before it is over, and uploads the next cell's new
references while a job draws. Both break the rule round one drew by, that a picture is saved and recorded before
anything more is asked of the card; the owner approved breaking it for these two and for nothing else. A cell goes:

1. while the job ahead of it draws: its references are checked against their records, after any of them still on its
   way down has come, its new ones are uploaded, and its graph is filled and checked;
2. when the socket says the job ahead is over: that job's last sample of video memory and, for a clean cell, the
   card's log are read in one wait, the cell's price is asked once more, and its job goes out at once;
3. while it draws: the picture ahead comes down, its record on the card is deleted, and it is saved and recorded,
   after the cell before it.

Nothing goes out before the job ahead of it is over, so the card never holds two of our jobs. The estimate, from round
one's gaps: the job at the over saves about a second a cell, some 5 minutes at round one's volume of pictures, and the
uploads 1.5 to 2.3 minutes more; [the pilot](#pilot) measures what it saves. The estimate in [the time](#time) counts
the jobs alone and not the gaps between them, so none of its rows changes: what this saves comes off time that table
never counted. The admission's prices keep each cell's uploads and its three seconds, and so stay on the safe side.
The bot keeps its own path: a socket a picture, and the picture whole before anything more.

Each job's measures stay its own, and some mean a little else than in round one:

- the last sample of video memory is taken at the over, before the next submit, where round one took it once the
  picture was down, so that nothing of the next job lands in this one's maxima;
- `partialModelLoadEvents` counts the partial loads in the log between its read before the job and the one at its
  over ([one socket](#one-socket)): a job's loads come before its over, and the next job's after its submit;
- `totalMs` runs from the submit to the picture on our side, less the time from the over to the download, which went
  to the last sample, the log and the next submit. After the over the pinned server logs the job and, at most once in
  ten seconds, collects its garbage and empties the card's cache, before it takes the next job (main.py
  `prompt_worker`); round one's gap hid that time, and now it falls in the next job's `totalMs`, outside its phases;
- `viewMs` is the download while the next job draws, on the tunnel that job's polls and the next cell's uploads use;
- `uploadMs` is spent while the job ahead draws, off the card's time;
- `outageMs`: a drop may charge two cells at once, the one coming down and the one drawing, each against its own
  window, and the report's times and the gallery's leave both out, as before.

When a picture's download fails once the next job has gone out, that job is followed to its end as any job that went
out, its picture saved and recorded or its failure. The cell whose download failed is recorded first, under its code,
and a code that stops the run lets nothing more go out; a cell the network lost is drawn again by a resume ([a dropped
connection](#dropped-connection)). `--until` and the reserve hold as they did: no job goes out whose price cannot end
by `--until`, and at `--until` the job on the card is stopped within the reserve, and a picture still on its way down
is cut and left undrawn. An outcome that cannot be recorded at all, such as a disk that refuses the write, ends the
stage once every job that went out has its end.

<a id='dropped-connection'></a>

**A dropped connection.** At 01:29 UTC on 2026-09-26 the first round's picture card closed both ssh sessions at once,
the tunnel's and the server's. ComfyUI ran in the foreground of its session and died with it. The stage stopped with
sharp-1's A lost on its way and its A+ failed before its submit, and the rest of seed 7 was drawn on a second card,
whose setup took 29.6 minutes and after which seed 11 no longer fit. A stage now rides out a short drop:

- the server runs detached from any ssh session ([the runbook](#runbook)), so a session that ends takes nothing with it;
- [tunnel.sh](../gpu/tunnel.sh) dials again two seconds after its connection ends ([the tunnel](gpu.md#the-tunnel));
- after the smoke, a cell may lose up to eight minutes to the network, its waits for the server, its requests that
  failed and its searches for its job together, and while it waits it looks at `/queue` every two seconds. That
  leaves two of the ten minutes after which the card's sweeper deletes a finished job's record for the request out
  when the window ran out, a last look of ten seconds at most and the requests that went through, which only a server
  answering slowly could use up. The window ends at `--until` as everything does. The smoke looks once and waits for
  nothing: a drop there fails it, as before. The owner kept the eight minutes on 2026-09-26: the sweeper's ten leave
  the window little room to grow, and waiting costs only while the network is down, where a stop leaves the paid card
  idle until someone resumes.

Only the network failing is waited for, as fetch reports it: a connection refused or reset, a dial that timed out, a
request cut on its way. An HTTP status, a reply that does not parse, the picture's own wait and `--until` end a cell as
they did. Within the window:

- a reference is uploaded again once the server answers, under the same name, since it is the same file;
- the socket is opened again;
- each cell is submitted once. A submit refused at the connect never left, and goes when the server answers. A submit
  whose answer was lost or did not come in time is never sent again: once the server answers, the harness looks for its
  id among the jobs queued and recorded, and follows the job if the card has it. One the card does not have is looked
  for once more after a pause, since its submit may still be on its way through the server;
- a job whose polls fail is followed again once the server answers, and its picture's wait grows by the time waited;
- a picture whose download was cut is asked for again by its file's name, since the graphs' saving node keeps it on
  the card's disk.

A connection that fails again five times over, the server answering between, ends the cell as a window that ran out
does, its job stopped first if the card has one. The record keeps the time a cell lost as `outageMs`, and the report's
times and the gallery's leave such a cell out, since its time holds the wait. When the window runs out, a cell that
never reached the card, before its submit or in an upload, gets no record, and the stage stops with
`comfy_unreachable`, or with `comfy_socket_unavailable` when the server answers and its socket still does not open; a
resume draws that cell. A cell lost after its submit, or whose job the card no longer knows once it answers, as after a
server that started again, fails as `comfy_connection_lost` and stops the run, where the first round's A was
`image_failed`, the code of a picture the card could not draw. A resume draws such a cell again under a new id, as the
owner decided on 2026-09-26: its record counts the jobs of it the network lost (`lost`), their time on the card is in
no row, and the report says how many cells were drawn again after a loss and how many of them are drawn. This replaces
the rule that a lost cell is never drawn again, whose reason was that whether the card draws the same inputs to the
same picture was [the pilot](#pilot)'s open question, so that a second picture could not stand for the first; the
pilot is now to run before round two, and its determinism check answers that question first. A cell that never
reached the card still gets no record, and a resume draws it as before. `draw --smoke` run again likewise draws a
smoke cell the network lost, and judges the smoke anew. The bot's own picture path waits for nothing.

<a id='picture-smoke'></a>

**The smoke** is the scene with the most bound people, the first in the set's order on a tie, at seed 7: its
portraits, its views and its six arms. It therefore sends the most references any C, V or T of the run will send. If
its frame needs no view, the smoke also draws the first view another scene needs, so that views are timed, and the
main run keeps that view as drawn; if no scene needs one, V is never drawn and gate 4 is inconclusive. Its cells are
the main run's cells of that scene and seed, drawn once. It passes when all of these hold:

- every cell is drawn and none failed;
- the geometry is right: frames 1280x704, fronts 720x1280, views 704x1280, and the scaled references, saved by the
  smoke's graphs as copies, read back at 352x640;
- each submitted graph sends every slot the file its manifest names, and T's first slot is not scaled;
- every picture's phases were heard on the socket, as the identity run's smoke required;
- the card kept at least 2 GiB free at the sampled peak.

When only T's cell fails, T leaves the whole run and the report says so. Any other failure ends the rental. The smoke
checks the mechanics alone: whether views turn, whether T keeps L's action and whether half-size references keep a
face are what the judges measure, on every scene.

<a id='time'></a>

**The time.** The harness takes an absolute end, `--until`, as the identity run did ([one
hour](identity-experiment.md#one-hour)): five minutes before the earlier of the guard's deadline and the operator's
own. Nothing is sent after it, and no job is sent that its price says could not end by then; that is asked once more
right before the job goes out, after its uploads and its socket. Nothing is measured before the smoke, so each of its
cells is priced at the longest a picture may take, its whole wait (`--wait`, five minutes) and three seconds. After
the smoke, the harness prices the rest of seed 7, the portraits and views included, from the smoke's own slowest
times: a portrait by its slowest portrait, a view by its slowest view, a frame without references by its slowest of A,
A+ and L, an edit with k references by its slowest edit with the fewest references at or above k, which is C's or V's,
and T by its T. Those times include the smoke's first, cold loads. Each cell gets its time plus a quarter and three
seconds for the transfers, as the identity run priced them. A kind of cell the smoke did not draw, such as an edit
with more references than any it drew, is priced as its slowest edit, never at nothing. Seed 7 begins only if all of
it can end by `--until`; if it cannot, the rental ends as a smoke result and is never extended. After seed 7, seed 11
is priced the same way and begins only if it fits whole. If it does not, the verdict stands on seed 7 alone, as it
would anyway.

The estimate, from the identity run's 15 s for a frame without references and its 15% more for one full-size
portrait:

| | minutes |
| --- | --- |
| ssh, Qwen's files, torch, the verification and the tunnel, at 300 Mbit/s (the identity run's table) | 14 |
| about 78 fronts at 15 s | 20 |
| about 46 views at 18 s | 14 |
| seed 7: 84 frames without references at 15 s | 21 |
| seed 7: about 52 frames of C and V at 20 to 30 s | 17 to 26 |
| seed 7: 28 frames of T at 25 to 85 s | 12 to 40 |
| seed 11, the same frames again | 50 to 87 |
| the margin before the guard | 5 |

That is 153 to 227 minutes of the guard's 180 for round two's 28 stories, where round one's 18 came to 115 to 163, and
the owner's scenes come on top. Without seed 11 it is 103 to 140, so seed 11 fits only toward the fast end, and the
admission after seed 7 decides it as above. Round one's sharp scenes took about three and a half minutes each at seed
7 ([own](#own)), where this table allows a scene three at most; at that pace seed 11 would not fit. The eight new
scenes of 2026-09-26 add 14 to the clean casts and the cut to four took 11 out of them, which kept the fronts and views
about as many as in round one; `gym` and `huddle` add eight fronts and about six views, and with their frames at both
seeds 10 to 16 of the table's minutes. T's time is the least known: four portraits of 704x1280 took 82 s in the
identity run and two took about 20 s, and the cause of that jump was not measured. T sends L's picture at 1280x704
and up to four references at 352x640, between those two in pixels. The rows count the jobs alone: the gaps between
them, which [the next job at the over](#pipeline) shortens, are in none of them, so that change leaves the table as it
was.

<a id='judging'></a>

## Judging

The judges are fresh `gpt-6-astra` sessions through `codex exec`, at high reasoning effort in a read-only sandbox,
each started in its own copy of its bundle with its pictures attached, as [the second
panel](identity-experiment.md#second-panel) ran. The model, the effort, each task's text by its hash, and the size
the pictures are attached at are pinned. No task names the arms, shows a prompt of a picture it judges, or states a
hypothesis or a threshold. Four kinds of session work on each scene.

1. **The checklist**, from the narrator's action scene, its target and the sheet, after the text run and before any
   picture exists. It lists:
   - the participants, each with a short handle and the sheet entry that is them, if any;
   - the relations of the moment the scene ends in, each with one subject, one verb and one object, and the body part
     and its side only where the scene gives them. A side the scene does not give is never made up, a contact both
     ways is one relation, and each relation is marked essential or not. The essential ones are the contacts the main
     action is made of; a scene whose text shows none lists none, rather than make one up. Each carries a short quote
     from the scene. Since round two the object may be the subject, a touch of one's own body, and a touch of a thing
     of the scene is a relation too, in a list of its own ([one](#one));
   - the gazes and faces the scene names, the clothes it names for the moment, each reflection of a participant it
     shows, and the scale where it is a premise;
   - whether the scene reached its target (see [the set](#the-set)), its contact judged in substance
     ([loosened](#loosened)), and where the sheet's line for a person contradicts the scene.

   Code takes the checklist out, gives every item an id of its own, and stores it; no later session changes it. The
   checklist's words, its handles, relations and quotes, stay with its story, under `sealed/` for a sharp one. What
   the scoring reads is its projection: the ids, the kind of each item, which relations are essential and which of
   them are with the subject's own body or a thing, which participant is which sheet entry and so which portrait, and
   whether the scene reached its target. Only that projection leaves a sharp story, never the checklist's own answers
   block.
2. **The text and the portraits**, after the card: the checklist, the sheet, the prompts of A and A+, the front
   portraits, and each view beside its front with the direction it was asked for. It says which relations, gazes,
   clothes and reflections each of the two prompts states; whether each bound person's `facing` fits the moment and
   the shot; whether each front matches its sheet line in face and hair, build and marks; and whether each view is the
   same person, turned the way it was asked. Since round two its sheet also carries each person's `details`, which
   the front was drawn from ([the sheet](#the-sheet)), and a front is checked against them, or against the look where
   there are none, so that the skin, the face and the marks with their sides are checked too. The checklist and the
   pictures keep the look, which is what the frames were given.
3. **The pictures**, one session per scene and seed: the action scene, the sheet, the checklist, and that seed's
   pictures, six at most, in an order drawn by code and named by hashes. C's picture, when it stands for V, is shown
   once. For each picture the session first says who is who: each participant present, absent or `unsure`, and
   where, told by their looks and place before any action is scored. Then:
   - each relation, gaze, face, reflection, clothes item and scale item: `yes`, `no` or `unsure`. A contact hidden by
     a body is `unsure` unless the picture shows it; a contact the frame's edge cuts off is `no`; a reflection is
     `yes` when the picture shows it with the same person in the same pose;
   - a mix-up of each kind: an action done by the wrong person, two people's looks swapped, two people merged into
     one;
   - an anatomy error: a limb too many or missing, bodies merged, a joint bent the way it cannot;
   - for each sheet person present, whether they look as their line says;
   - since round two, each proportion their look names, asked on its own: `yes`, `no` or `not_visible`
     ([proportions](#proportions)).
4. **The identity**, once session 3's answers are stored: the same pictures and the front portraits of the bound
   people, the same references for every arm. For each picture and each bound person: present or not, whether the
   silhouette matches the front, the height, the build and proportions and the outline of the hair, and whether the
   face does ([the silhouette](#silhouette)). Round one asked for the face and the build.

<a id='proportions'></a>

**Each proportion on its own, since 2026-09-27.** The owner asked what becomes of a woman whose look and front give her
large buttocks and whom a picture draws with small ones: «а если например на картине у девушки сгенерится маленькая
попа, хоть на референсах профиля у нее большая?» One question of whether a person looks as their line says answers for
the whole look at best, and round one's identity session found the build matching in about half its answers. So the
pictures session is now asked about each proportion a person's look names, apart: height, build, shoulders, bust,
waist, hips, buttocks, legs and arms. Code finds them in the look by their words (`PROPORTIONS` in
`local/action-judge.ts`) and gives each person's sheet line the parts of the look that name each one, so that the
judge weighs the look's own words, "very wide hips" and not a hip in general; a look that names none adds no question.
Each is `yes`, `no`, or `not_visible` where the picture hides it, cuts it off or shows it from a side where it cannot
be seen, and a small buttock at the right height is then a `no` rather than a matching build. The report gives
`proportions`, the share of the shown ones that are as named, over the people present, per arm and in the pairs; no
gate reads it. The words, the task and the schema are pinned by their hashes. The finder reads "short" as a height
before a comma, an "and", the end or a word for the person, so a look with "short, dark hair" is asked about a height
it does not give, and a proportion in words it does not know is not asked.

<a id='one'></a>

**One person's contacts, since 2026-09-26.** Round one's relations joined two participants, and code refused one of a
participant with themself, so a scene of one person had nothing for the contact scores to count, though its action is
a touch: in `mirror` Глеб's fingers on the scar on his own shoulder, in `archer` Ярослава's fingers on the bowstring.
Round two's checklist keeps `relations` for participants, and one whose object is its own subject is a touch of one's
own body: its `part` names both parts, what touches and what is touched, as "пальцы правой руки; шрам на левом плече"
would for the scar, and its side is that of the part touched. A touch of a thing goes in `object_relations`, with the
thing as the scene names it, the bowstring for the bow, in `thing` where a relation has `object`. The task gives no
example, so that no scene of the set is written into it. Each list's schema has its own field and not the other's, so
no relation names both a participant and a thing, or neither; code also refuses an empty thing and a thing that is a
participant's handle. The two lists take their ids in one run of `r…`, the relations first, and an essential one of
either counts in the contacts exactly as a contact between two people does; the projection marks which are with the
subject's own body or a thing, so the report counts them. A reflection is an item of its own, `m…`: the same person in
the same pose in the mirror, the water or the glass. The text session says whether each prompt names it and the
pictures session whether each picture shows it; the report gives it a line of its own, and it enters neither the
contacts nor a gate. The task and the schema are pinned by their hashes, so the judging commands refuse round one's
directory, and its stored checklists, answers and report are not rewritten; it moves out whole before round two begins
([runbook](#runbook)).

<a id='loosened'></a>

**The target's contact, loosened on 2026-09-26.** Round one's checklists counted 12 of the 13 clean scenes as missing
their target. In 7 of the 12 the participants and the moment were there and only the contact was `no`. In `guard`, for
one, Руслан pushes one palm against Артём's chest where the target says both hands, and Артём's legs wrap Руслан's
hips where it says they cross behind his lower back. For round two the owner loosened that part of the check, and the
same day widened it to any part of the body, as [the variant](#variant)'s ninth change does for the frame: the contact
is the physical interaction of the participants, who acts on whom or on what, with which part of the body (a hand, a
foot, a knee, a shoulder, the back, the head, the whole body), and against which part of their own body or another
participant's, or which object. It is `yes` when that interaction is in substance the target's; the side, which hand,
how many hands and the fine placement do not decide it. The task gives no example, so that no scene of the set is
written into it. The participants and the moment are asked as before. The other five of the twelve, `beach`, `cheer`,
`jellyfish`, `lineout` and `tango`, missed the moment itself, which the loosening does not touch, and they stay
misses. Round one's stored checklists and its report are not rewritten.

<a id='silhouette'></a>

**Identity by the silhouette, since 2026-09-26.** Round one's identity session asked whether each bound person's face
and build matched the front, and the identity score counted a person only where both did. The owner judged on
2026-09-26 that the face matters less than the silhouette, and that the people must do in the picture what the story
wrote; the contacts stay the main score. Round two's identity session asks whether each person is present, whether
their silhouette matches the front, the height, the build and proportions and the outline of the hair, and whether
their face does. The identity score counts a person present with the silhouette of their front, so gates 3, 4 and 5
read the silhouette. The face is reported beside it, per arm and in the pairs, and no gate reads it. The task and the
schema are pinned by their hashes, and round one's stored answers and report are not rewritten.

The narrator's scene decides who takes part and what they do; the sheet decides the looks score, and the front
portraits the identity score. A judge who cannot tell who is who in a picture answers `unsure` for that participant,
rather than decide it by the action being scored.

A session sees its pictures together, and it may compare them; nothing here prevents that, so the answers are
comparative judgments. Four clean scenes, picked by code from the set's hash before the run, get a second session 3
at seed 7. The report gives how often the two agree on each kind of item, and which verdicts would change if the
second's answers stood on those four scenes. The repeat never replaces the first, and it covers neither the sharp
scenes nor identity.

Each report ends with its answers as one JSON block, and each kind of session has a schema of its own, pinned by its
hash. The checklist's schema describes the items it lists. The other three take only the ids code gave and values from
their enums, and a block with anything more or anything missing is invalid; the report's prose stays with the report.
A clean scene's report without a valid block gets one fresh session of the same kind, and a second one without counts
as a judge's failure; a sharp scene's goes as [below](#sealed). With both seeds there are 28 checklists before the
picture card, and 144 sessions after it: 28 of text and portraits, 56 of pictures, 56 of identity and 4 repeats. With
seed 7 alone there are 88 after it. Each of the owner's scenes adds a checklist and five sessions after the card,
three with seed 7 alone. The fresh sessions for invalid reports come on top.

<a id='gates'></a>

## The scores and the gates

Each picture gets these scores:

- **contacts**, the main one: the share of its scene's essential relations shown, a touch of one's own body or of a
  thing among them ([one](#one)), and **all contacts**, whether every one is;
- gazes and faces, clothes and scale, each a share of its own;
- **reflections**, where the scene shows one: how many of its reflection items the picture shows. The report pools
  them per arm on a line of their own; they are not part of the contacts, and no gate reads them;
- **complete**: every participant present;
- **mix-ups** by kind, and **anatomy**;
- **looks**: the share of the scene's sheet people who are present and look as their line says, counted over all of
  them, so a person missing counts as not;
- **identity**: the share of the scene's bound people who are present with the silhouette of their front, the
  height, the build and proportions and the outline of the hair, counted over all of them the same way
  ([the silhouette](#silhouette); round one counted the face and the build both). It says that a picture matches its
  portraits, not that it matches the story's person; the portrait check says how well the portraits match their
  lines;
- **face**: the share of them present with the face of their front, counted the same way. The report gives it beside
  identity, and no gate reads it.

A score with nothing to count in a picture, such as scale in a scene without one, gazes in a scene that names none,
or identity in a frame that binds nobody, is `not_applicable`: neither a failure nor `unsure`, and the picture is
left out of that score's mean. A scene whose checklist has no essential relation is out of the contact scores and
stays in the count of cells; no essential relation is ever made up.

An arm's score is the mean over scenes, so a scene with many relations weighs no more than one with few. The report
gives the numerators, the difference between the arms of each pair scene by scene, in how many scenes each arm is
ahead, level and behind, and a 90% interval for each difference from 10 000 resamples of the scenes with a fixed
seed. The gates compare exact values; the report rounds to whole points. It also gives how many essential relations
the scenes' checklists hold, and how many of them are with the subject's own body or a thing; the text audit's share
of the checklists' relations and reflections stated in A's and A+'s prompts; and the share of fronts that match their
line and of views judged right.

The gates are fixed before the paid run and counted by code on seed 7, as thresholds for the next decision and not
as proof. At 26 pictures one picture is 3.8 points, and the two seeds share one text and one set of portraits, so they
are not more scenes. A `no` and an `unsure` both count against a picture. "At most n/10 more" means at most
max(1, ⌊n/10⌋) more of the gate's n matched pictures: one below 20 scenes, two from 20 to 29, so two at 26, and still
one at the six scenes gate 4 may have, which is 17% of them. "No more mix-ups" counts the pictures with a mix-up of
any kind; the kinds are reported.

- Gates 1, 2, 3 and 5 read the seed-7 scenes where every arm they compare is scored. Each is **inconclusive** when
  fewer than 14 scenes, or fewer than 10 clean ones, are left: minimums fixed when the set had 18 stories and 13
  clean ones, and kept for round two.
- Gate 4 reads the matched scenes where V was drawn, and its only minimum is 6 of them.
- Each clause counts the gate's matched scenes where its score applies. A gain, a clause that asks for more contacts
  or more identity, needs at least 6 of them, or its gate is inconclusive. Gate 4's two gains are alternatives, each
  with its own safeguard: the gate passes when a branch whose gain has 6 scenes passes and the shared clauses hold,
  fails when a shared clause fails or both branches have 6 scenes and fail, and is inconclusive otherwise. A
  safeguard, a clause that asks for no loss, such as no lower scale, counts whatever scenes it has; with none it is
  `not_applicable` and does not stop a pass, and the report says so.
- The sharp scenes count in every gate beside the clean ones. Their own numbers are descriptive, and nothing is
  claimed of the sharp scenes alone.
- An arm that passes must also have a contacts score of at least 50%, the mean over scenes, whatever its gain; with no
  scene to count it in, the gate is inconclusive.

1. **The variant text.** A+ passes against A when its contacts are at least 10 points higher, and it has at least as
   many pictures with all contacts and with every participant, no more mix-ups, at most n/10 more anatomy errors, and
   no lower scale. A pass puts the variant's changes to the owner for the bot's own instruction.
2. **The owner's idea.** C shows the action better than A+ when its contacts are at least 10 points higher, with at
   least as many complete pictures, no more mix-ups, at most n/10 more anatomy errors, and clothes no more than 10
   points lower, so that the portraits' plain clothes do not replace the scene's. If L gains as much against A+,
   leaving the looks out was enough for the gain.
3. **Portraits worth pursuing.** C passes against A+ when its contacts are at most 5 points lower, its identity at
   least 15 points higher and its looks at most 5 lower, with no more mix-ups, at most n/10 fewer complete pictures
   and n/10 more anatomy errors, and clothes no more than 10 points lower.
4. **Views.** Over the scenes where V was drawn, V passes against C when its contacts are at least 5 points higher
   with identity at most 5 lower, or its identity at least 10 points higher with contacts no lower; with no more
   mix-ups, no fewer complete pictures, at most n/10 more anatomy errors, clothes no more than 10 points lower, no
   lower scale, and at least 80% of the views judged the same person turned the way asked.
5. **Two passes.** T passes when its contacts are at most 5 points below L's; it keeps at least 80% of L's shown
   essential relations, the ones shown in both L and T over the ones shown in L, pooled over the scenes, where a
   scene in which L shows none adds nothing and fewer than 10 in all make the clause inconclusive; its identity is at
   least 15 points above L's and at most 5 below C's; and it has no more mix-ups than L, at most n/10 more anatomy
   errors and n/10 fewer complete pictures, clothes no more than 10 points lower and no lower scale.

Each gate is also shown for the clean scenes alone and for the scenes that reached their target, and seed 11's
numbers stand beside seed 7's as a repetition: whether each difference points the same way. Neither changes a
verdict. The times are shown per arm, the median and the slowest of the warm frames against A's. T's time is L's and
its own together, and the time to a reader's first picture with portraits includes the fronts and views a new story
needs. A picture that waited for the network ([a dropped connection](#dropped-connection)) counts for no time. No gate
reads the times, and an arm with portraits that passes still needs a time the bot can live with before it reaches a
reader.

<a id='complete-run'></a>

## What the run delivers

The report gives, for each arm, the cells planned, submitted, drawn and scored, and every other cell with its reason:
the text's code, the sheet, a front, a view, a failed draw, a timeout, `not_submitted`, or a judge who gave no valid
answer. The gates read matched scenes, and this count reads every planned cell, so a failure that took a scene out of
a gate still counts against its arm here. Seed 7 is complete when each of its cells is drawn or has its reason. A
sharp scene that no judge answered stays out, and the report says how many. It also says how many cells a resume drew
again after the network lost a job of theirs, and how many of those are drawn ([a dropped
connection](#dropped-connection)); the jobs lost are in no row.

<a id='sealed'></a>

## The sharp scenes are sealed

[The owner's second exception](improve-loop.md#acceptance-on-gpu) for judging pictures applies. The judge is
`gpt-6-astra`. A report without a valid answers block goes to `gpt-6-sol`, and what both leave unanswered goes to the
owner on a page of their own. The sharp texts go nowhere but the two rented cards and the judges' sessions, and their
pictures are shown to the owner on a gallery page of their own.

Where every piece of a sharp story lives, and what leaves it:

- Everything is under the gitignored `illustrations/action/sealed/`, one directory per story: the store of its text
  run, which the harness keeps there and never in the system's temporary directory; the seed, the scenes, the sheet,
  the frames, the prompts and the manifest; the portraits, views and pictures; the judges' bundles; each judge's
  events, its stderr and its report; the answers; the owner's pages.
- `codex exec` runs with `--ephemeral`, so it keeps no session file of its own, in a working directory inside the
  sealed bundle and with `TMPDIR` in `sealed/tmp`.
- For a sharp story the harness prints its id, `sharp-1` on, codes from a fixed list, counts and times. An
  error prints its code and the fields that pass `safeErrorDetails`, never a message or a body. After each picture the
  card's record of the job is deleted, as `local/image-batch.ts` does. The file the graph saved stays on the card,
  with its prompt in its text chunks, until the card is destroyed and read back as gone; nothing reads it there but
  the harness's download. No Claude session reads a card's files or logs while a sharp story is on it.
- What leaves `sealed/` is the validated answers, ids and enum values, and the counts made from them.
- The owner added that path to the denies of `.claude/settings.json` on 2026-09-25; only the owner edits that file.
  A deny covers the file tools and not a subprocess, so no Claude session runs a command that reads there: the harness
  is the only reader.

**The boundary test**, before any card: the dry run puts a made-up word into a sharp seed, into a theme and a scene of
the owner's file and a malformed entry, into the fake model's replies, into the body of a fake provider error, into
the metadata of the fake ComfyUI's pictures, into a fake judge's prose and into a malformed answers block. Code then
searches every file the run wrote outside `sealed/`, the temporary directory, and the harness's own stdout and stderr,
for that word. One hit fails the test. What `codex exec` keeps in its own files is not checked: the owner decided on
2026-09-25 that the judges read and keep what they are given without limits, and no Claude session opens `~/.codex`.
On the text card, before the five sharp seeds are asked for, one synthetic story marked sealed, with a made-up name in
its seed, goes through the sealed path, and the same search runs; a hit stops the sharp stories.

## The rentals

Each card needs the owner's explicit «да», with its price and its end, under
[the owner's rules](gpu.md#while-the-cards-are-paid-for). Everything is dry-run before the first of them: the text
flow against scripted fakes of the adapter and against simple-serving's dev launcher, the pictures against
[fake-comfy.ts](../local/fake-comfy.ts), the judging on made-up answers, and the boundary test.

1. **The rehearsal** is simple-serving's first rental: the cheapest card of 16 GB or more, from
   `npm run gpu:rent -- --lane small`, with Gemma 4 E2B from simple-serving's branch `rehearsal-e2b`, which is never
   merged. It runs that README's whole first-rental runbook, the stop, the resume and `smoke --after` included, and
   none of this measurement's texts. It ends with `--destroy` read back as gone, as every card here does.
2. **The text card** is a 5090 with the heretic, rented after the rehearsal and prepared as simple-serving's README
   says for its card, with the trial guard of its contract, which deletes it three hours after its first start; the
   owner's deadline for it is chosen apart, before the creation. The operator watches the card from its creation, and
   it is never stopped and resumed. `up` comes first, then one plain smoke, without `--before` or `--after`, whose last
   probe is its privacy check (its contract's section 15, step 2: a synthetic marker shows up in no log of the engine,
   the proxy or the gateway), then the marker check of the sealed path, then the text run, and then the card is
   deleted with `--destroy` and read back as gone. A stop is not an end: a stopped trial keeps its disk, and its guard
   does not run.
3. **The checklists** are written between the text card and the picture card, from the texts alone.
4. **The picture card** is a 5090 from `npm run gpu:rent -- --lane pictures --qwen only --hours 3`. It is rented only
   when every prompt is assembled and counted and every checklist is stored, and it ends as the identity run's card
   ended ([termination](identity-experiment.md#termination)).

Before the rent dry-runs the estimate is an hour and a half of the text card and up to three hours of the picture
card, about $3 with the downloads. Each dry-run's `session` replaces it before the «да» for that card.

## Not verified without a card

The text cards of 2026-09-25 answered two of these ([the third](knowledge/gpu-measurements.md#text-card-3-2026-09-25)):
vLLM loads route A on the 5090 and simple-serving passes its smoke, 10 of 10 on the third card, and route A's heretic
kept the variant's schema in all 18 stories, each at its first attempt. Still open:

- whether it keeps `facing` better than stage 1's hosted Gemma kept `view`;
- how long an edit takes with six references of 352x640, and with T's seven;
- whether the views keep the person and turn the way they are asked;
- whether references of 352x640 keep a face;
- whether a server started detached outlives the ssh session that started it, as it should a hangup of that session's
  terminal, the first round's case; a drop that ends whole session trees on the card would need the server started by
  the card's onstart, as the guard is;
- whether [tunnel.sh](../gpu/tunnel.sh) dials again after a real drop, and whether fetch reports that drop with the
  codes [a dropped connection](#dropped-connection) waits on, which the fake's refused and cut connections give;
- whether the pinned server takes the harness's prompt id as the job's, as its code reads (server.py:1093-1099);
- whether a download beside the next job slows that job or itself, and how long the server's own work after a job,
  now in the next job's time, takes ([the next job at the over](#pipeline));
- [the pilot](#pilot)'s questions: what round two's path saves a cell, whether the card draws the same inputs to the
  same picture, and what the Triton backend changes, if the server uses it at all;
- [the backend measurement](#backend)'s: what comfy-kitchen's CUDA backend on cu130 and torch.compile add on top of
  Triton.

The detached server and the tunnel take a minute of the next picture card to check, and draw nothing: start the
server as the runbook does, but from `ssh -tt simple-chat-vast '…; sleep 600'`, end that ssh here, and see
`/system_stats` answer through the tunnel; then end the tunnel's ssh child here and see the tunnel dial again.

<a id='runbook'></a>

## Runbook

The owner's step is done: on 2026-09-25 the owner added `Read(./illustrations/action/sealed/**)` to the denies of
`.claude/settings.json` ([sealed](#sealed)). Before each card the operator checks that it is still there, and edits
nothing in that file. Everything lives in one directory, `illustrations/action`, whose `sealed/` that deny covers:
every command but `dry-run` refuses another `--dir`, and a link on the way to `sealed/`. Each command but `dry-run`
prints one JSON object a line, of ids, codes, counts and times: a sharp story shows as its id, and an error as the
harness's own refusal or as a class and a code, never as what a parser read. `SIMPLE_SERVING_CHECKOUT` is
simple-serving's checkout, as `npm run test:serving` names it. A new round starts in an empty `illustrations/action`,
since the harness refuses a directory written under other pins. The round before moves out whole to
`illustrations/action-N`, N its number, and only once the owner has added `Read(./illustrations/action-N/sealed/**)`
to the denies. The runbook, in its order:

```sh
# A new round, first: the old one moves out whole once the owner's deny covers its new place (N is 1 for the first).
grep -cF 'illustrations/action-N/sealed' .claude/settings.json    # 1 or more, or it stays where it is
mv illustrations/action illustrations/action-N
# Before any card: all of it against fakes, then the texts against simple-serving's dev launcher.
npm run image:action -- own    # the owner's scenes (#own) as counts; final once the texts run
dry=$(mktemp -d)
npm run image:action -- dry-run --dir "$dry"    # eleven steps, then "the dry run went as expected"
# In simple-serving's checkout, in a terminal of its own. dev.json holds the dry run's made-up client key.
uv run python -m simple_serving.dev --config "$dry/dev.json" --engine-port 8200 --public-port 8201 --control-port 8202
npm run image:action -- dry-run --dir "$dry" --dev http://127.0.0.1:8201    # reached false, then 23 stories
grep -cF 'illustrations/action/sealed' .claude/settings.json    # before each card: 1 or more
# The text card (the rentals, 2), prepared as simple-serving's README says in "The card". In that checkout, once SSH
# to the card works, `trial` names this card in the configuration, and `up`, in a terminal of its own, holds the tunnel.
uv run python -m simple_serving.cli trial --ssh-host HOST    # HOST: the text card's host in ~/.ssh/config
uv run python -m simple_serving.cli up    # until it says ready
# In a second terminal in that checkout, the plain smoke, into a file of this card's own:
mkdir -p logs; set -o pipefail
uv run python -m simple_serving.smoke | tee logs/smoke-text-card.jsonl    # exit 0, 10 of 10 passed
smoke="$SIMPLE_SERVING_CHECKOUT/logs/smoke-text-card.jsonl"    # back in this checkout, from now on
npm run image:action -- texts --marker --smoke-record "$smoke"    # pass true, before any sharp seed is asked for
npm run image:action -- texts --smoke-record "$smoke"    # complete true, exit 0
# Only for the five sheets of 2026-09-25 (#again), after the marker check on that card:
npm run image:action -- texts --smoke-record "$smoke" --again demon,lineout,cheer,twister,sharp-2    # again 5
npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
# Between the cards:
npm run image:action -- prompts       # the six arms' prompts, fronts and views, as counts
npm run image:action -- checklists    # the checklist sessions; ready true, or a page waits for the owner
npm run image:action -- collect       # once the owner has saved each page's answers; ready true
# The picture card (the rentals, 4), only once ready is true:
SIMPLE_CHAT_RENT_DRY_RUN=1 npm run gpu:rent -- --lane pictures --qwen only --hours 3    # each offer's `session`
npm run gpu:rent -- --lane pictures --qwen only --hours 3    # with the owner's «да»; `rented` names ID and destroyBy
npm run gpu:rent -- --show ID    # present, at once
destroy_by=DESTROY_BY            # from `rented`
# As soon as ssh answers, the guard, as the identity run checked it. A failed guard is the termination at once, and
# the runbook ends there: nothing is copied onto the card or started on it.
guard=$(timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast \
  'flock -n -E 75 /root/.simple-chat-trial-guard.lock true; [ $? -eq 75 ] && cat /root/.simple-chat-trial-deadline')
if [[ $guard =~ ^[1-9][0-9]{0,11}$ ]] && (( guard <= destroy_by )); then
  end=$(( (guard < destroy_by ? guard : destroy_by) - 300 ))    # min(guard, destroy_by) - 300
else
  echo 'failed guard: the termination, and nothing more'
  timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
  exit 1
fi
ssh simple-chat-vast 'mkdir -p /workspace/simple-chat/gpu'
tar -cf - -C gpu . | ssh simple-chat-vast 'tar -xf - -C /workspace/simple-chat/gpu'
ssh simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only bash /workspace/simple-chat/gpu/image-bootstrap.sh'
# The server, detached from this session (#dropped-connection): no terminal, a session of its own, one at a time under
# its lock, and a server already running is left as it is. Its output is the card's log: it goes nowhere.
# With comfy-kitchen's Triton backend, SIMPLE_CHAT_IMAGE_TRITON=1, as the owner decided on 2026-09-26 on the pilot's
# numbers and pictures (#pilot); it adds `triton` to the run's pins, so that a resume cannot switch it.
ssh -T simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1'
# The tunnel, in a terminal of its own; after a drop it dials again by itself, and is left to (gpu.md#the-tunnel).
bash gpu/tunnel.sh --pictures-only simple-chat-vast
# Until the server answers through the tunnel; a timeout is a server that did not start, and the termination.
timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 2; done'
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/action/card.txt
# While the card draws, in a terminal of its own: the owner's pages with what is still to come and when.
while sleep 60; do npm run image:action -- gallery --until END; done    # END is "$end"
npm run image:action -- draw --smoke --until "$end"    # the smoke's verdict; pass false is the termination
npm run image:action -- portraits --until "$end"    # seed 7 priced whole, then the rest of the fronts and views
npm run image:action -- draw --until "$end"    # seed 7 scene by scene, then seed 11 if it fits whole
# The termination, here and after every other ending: we're done, then the destroy whatever the ssh did.
timeout 20 ssh -o ConnectTimeout=10 simple-chat-vast 'date +%s > /root/.simple-chat-trial-deadline'; \
  npm run gpu:rent -- --destroy ID    # destroy_confirmed; anything else goes to the owner at once
# After the card:
npm run image:action -- bundles    # one bundle a session, and those skipped, by reason
npm run image:action -- judge      # the text, pictures, repeat and identity sessions, four at a time
npm run image:action -- collect    # once the owner has saved each page's answers
npm run image:action -- judge      # the identity sessions that waited for those pages
npm run image:action -- report     # report.json, and report.md for the owner
npm run image:action -- gallery    # gallery.html, and sealed/gallery.html for the owner
```

**Before any card**, `dry-run` goes through all of it against fakes: simple-serving's gateway as
[action-fakes.ts](../local/action-fakes.ts) plays it behind the real adapter, [fake-comfy.ts](../local/fake-comfy.ts),
and a judge that writes made-up answers, in a directory of its own with `tmp/` as the temporary directory. A made-up
word goes wherever a sharp story's words would, and into a fake provider error's body, the fake pictures' metadata, a
fake judge's prose and a malformed answers block. On the way it goes through every refusal the paid run relies on:

- the sharp stories held until a marker check has passed, and a check that passes;
- each outcome of [the text run](#text-run) once, `schema` by a shared role and `failed` by a provider error, and a
  retry that parses;
- a finished text run that asks nothing again, and another address refused with `texts.json` byte for byte unchanged;
- every planned front drawn from the `details` the fake sheet wrote of its person ([the sheet](#the-sheet));
- the smoke refused while a sharp checklist waits for the owner's page, and the rest refused before the smoke;
- a smoke on the largest scene, whose people all face the viewer, so that it also draws another scene's view and that
  view's front, and V stands on C's picture there;
- the rest of seed 7 refused with five seconds left, before any job is sent;
- a failed front and a failed view, and the cells they take out;
- a resume that draws nothing, and one after a plan changed since `prompts` refused with `draw.json` unchanged;
- a card that never held two jobs at once, each job sent while the picture before it came down;
- judges' reports with valid, invalid and missing blocks: a clean scene's fresh session, a clean judge's failure, sharp
  sessions that go to `gpt-6-sol` and to the owner's page, and an identity session that waits for its pictures' page;
- the report, where the one-person scenes' touches of their own body and of a thing and the mirror scene's
  reflection are counted, and both galleries;
- the boundary test: the word found inside `sealed/`, and nowhere in the files outside it, those beside `run/`
  included, in the temporary directory or in all it printed, with nothing left unread; and none of the three keys of
  its key file anywhere.

Its made-up answers are drawn from each enum by a hash, so the verdicts it prints mean nothing. The fakes keep the
contracts the harness talks to, and model no card, no model and no judge. A fake job lasts until the card's memory has
been sampled while it draws (fake-comfy.ts `untilSampled`), as a card's job of tens of seconds always is: in round
two's order the harness writes the picture before it and `draw.json` while a job draws, which can take longer than a
fake job of milliseconds, and the smoke asks for a sample of every job. [A dropped connection](#dropped-connection) is
`npm test`'s, against the same fake ComfyUI ([action-draw.test.ts](../local/action-draw.test.ts)): a submit answered
to nobody and a job's start cut, each shorter than the window, then a window that runs out after a submit and one that
runs out before one; a resume that draws the lost cell again, its loss counted, and a picture whose download is cut
and fetched again whole; every job sent once, and never two on the card.

The dry run also leaves `config.json`, a key file of three made-up keys as simple-serving's configuration holds them,
`serving-smoke.jsonl`, a smoke record that passes, and `dev.json`, a service block for simple-serving's dev launcher
with the served name, the context and that client key. With the launcher up, `dry-run --dev` runs the marker check and
the texts in `dev/` beside `run/`, with that key file and that smoke record, through the real gateway in front of its
fake engine: the adapter, the client key read alone, class `internal`, the gateway's times in each `text_attempt`, and
the requests counted apart. The fake engine answers every call with one sentence, so the scenes pass and no sheet
parses: the marker check prints `reached: false`, and `texts` 23 stories whose sheet is `unparsed`, with the five
sharp ones held as `marker_failed`. A marker check that passes there means that a model answered, and `dry-run --dev`
stops before the texts, so that no sharp story is asked for outside `illustrations/action`. Anything else, a refusal
or a failed scene above all, is looked into before any card.

**The text card** follows the rehearsal (the rentals, 1), and is watched and ended as [the rentals](#the-rentals) say.
Until `trial` has run on it, simple-serving's configuration names the rehearsal's card, which is gone: `up` would
reach for that card, and the smoke's privacy check would read no report of this one. The card falls asleep 13 minutes
after our last request (simple-serving's README, "The command"), which would be a stop, so the smoke, the marker check
and the texts follow each other at once, and the destroy follows the texts. The smoke writes into a file of this
card's own, so that no earlier record, the rehearsal's among them, can stand for it.

`texts --marker` prints each attempt, then `marker_check`: `pass`, `reached`, each step's outcome, the files and bytes
searched, what it could not read, and the hits as counts; a directory, a file or a link the search cannot read fails
it as a hit does. `pass: true` lets `texts` ask for the sharp seeds. A hit keeps them out for the rest of the card:
the leak is the harness's, its fix is code, and no code is written on a paid card. `texts` then writes the clean
stories and holds the sharp ones as `marker_failed`, and the gates would read the 23 clean scenes alone, so whether
the picture card still comes is the owner's question. `reached: false` with no hit is a synthetic story the model did
not take through every step, and a check again is a new story with a new name.

`texts` prints each attempt and each step, then `texts`: the steps by outcome, the stories held back, `requests` (the
calls, the retries, the gateway's checks, the counts before a send and the generations) and `complete`, which exits 0.
An interrupted run resumes where it stopped, and a call with an outcome is never asked again. If the smoke fails, the
texts wait for the fallback card, where `--model gpu:LABEL` takes the model from `.env.gpu` in place of
`--smoke-record`.

**Between the cards**, `prompts` prints the scenes left in each arm, the scenes where V is C's picture, the codes that
took arms out, the fronts and views planned, the most people and bound people in a frame, the manifests' stops, the
letters outside the Latin script, and each arm's longest prompt in words and, with `tokenizers/`, in the encoder's
tokens. `checklists` prints each `session_done`, then the sessions by state and `pictures`: `ready`, `textsDone`,
`promptsCurrent`, and the checklists stored, failed, waiting for the owner and not yet run. A sharp checklist that
both judges left without a valid block gets a page in `sealed/owner/`, named by its story and session; the owner saves
the answers where the page says, and `collect` reads them as strictly as a judge's. A clean checklist whose two
sessions failed is a judge's failure: its scene has no scores, and it does not hold the card back. The picture card is
rented only with `ready: true`, and `portraits` and `draw` refuse without it: the text run complete, the prompts made
from the texts as they are now, so that a text written after `prompts` needs `prompts` again, and no checklist left to
run or waiting for the owner. Each drawing stage also hashes the plan files as it reads them, and refuses them before
anything is asked of the card when that is not the hash `prompts.json` records.

**The picture card** is rented, guarded, watched and ended as the identity run's card was
([operator](identity-experiment.md#operator), [termination](identity-experiment.md#termination)), for three hours.
`draw --smoke` prints each cell, then `smoke`: `pass`, and whether the cells were drawn, on their geometry, with the
right slots, heard on the socket and within the memory. `pass: false` is the termination; a smoke where only T failed
passes with `tOut`, and T leaves the run, also when T's failure is one that stops a run, such as a graph the server
refused, but not when the card could not confirm T's stop, which may leave its job drawing, nor when the network kept
T from the card or lost it on its way, which says nothing of T. `portraits` prices the rest of seed 7 from the smoke's
times and prints `admission`: the cells, the minutes they need and the minutes left. A seed 7 that does not fit stops
as `admission` before any job is sent, and the termination follows. `draw` prints each cell and the admission of seed
11, then `drawn`: the pictures drawn by kind and seed, and the failed and the out by code. `stopped: admission` after seed 7 is seed 11 that did not fit, and the verdict stands on seed 7;
`stopped: until` is the end that came. A cell that waited for the network shows its `outageMs`, and one the network
kept from the card is `cell_unsent`, with its code. A drop shorter than [the window](#dropped-connection) is no
ending: the tunnel dials again by itself, the stage goes on, and nothing is started again, since a server that starts
again has lost its jobs. A longer one ends the stage with `comfy_unreachable`, `comfy_socket_unavailable` or
`comfy_connection_lost`. Every ending is the termination, and a resume draws nothing again, a cell whose failure
stopped the run included, but for a cell the network lost after its submit, which it draws again; a cell that never
reached the card has no record and is drawn. A picture `draw.json` records whose file is gone is data lost, refused
before anything is drawn and never drawn again. The saved pictures stay on the card until its destroy is read back;
the harness reads no log of the card for a sharp story, and nobody reads the server's output.

**After the card**, no card is needed. `bundles` prints the bundles built and those skipped, by reason. `judge` runs
every session that is ready, four at a time (`--parallel`, and `--kind` for some kinds alone), prints each
`session_done`, and then `judged`: the sessions by kind and state, and the attempts. A session still running after 30
minutes is stopped, killed if it does not stop, and waited for, and its attempt is recorded as `timeout`, an attempt
without answers. A sharp session both judges leave gets a page, as a checklist does, and an identity session waits for
its pictures' answers, so `judge` runs again after `collect`. `report` writes `report.json` and the owner's
`report.md`, and prints the scenes, with their essential relations by kind and their reflection items, each gate's
verdict on seed 7, over the clean scenes, over the scenes that reached their target and at seed 11, the repeats, each
arm's reflections shown at seed 7, the sharp scenes no judge answered, and whether seed 7 is complete. `gallery`
writes the owner's two pages; while the card draws it runs from another terminal as often as wanted, with the stages'
own `--until`. Each cell stands in its place: its picture, the code of a cell that failed or is out, or, for one still
to come, the local time it is expected to end, from the median of the drawn pictures of its kind and arm and the pause
measured between pictures. Above the cells: what is drawing now; the fronts, the views and each seed against the plan,
each with its expected end; the deadline; and whether seed 11 is admitted, expected to fit, or decided after seed 7.
After a stage stopped on an error they show what is left for a resume on a new card, a cell the network lost among it,
and no time. The pages reload themselves every minute until the drawing is over. The clean page shows the sharp scenes
as counts alone. No Claude session opens anything under `sealed/`, the pages among them.

The drawing stages also take `--comfy`, `--wait`, `--timeout` and `--tokenizers`, whose defaults the runbook keeps. The
directory holds:

- `texts.json` and `marker.json`, the records of the text run and of the marker check;
- `clean/<id>/` for each clean story, and `sealed/<id>/` for each sharp one and the marker's: its store, `text.json`,
  `plan.json`, `checklist.json`, `portraits/`, `views/`, `pictures/`, `bundles/`, `keys/` and `answers/`;
- `prompts.json`, `checklists.json` with the checklists' projections, and `judging.json`;
- `sessions/`, and `sealed/sessions/` for the sharp scenes: each session's copy of its bundle, its events, its stderr
  and its report; `sealed/tmp/`, their temporary directory; and `sealed/owner/`, the owner's pages;
- `card.txt` and `draw.json`, the card's record and the pictures';
- `report.json`, `report.md`, `gallery.html` and `sealed/gallery.html`.

<a id='pilot'></a>

## The pilot

`npm run image:pilot` ([image-pilot.ts](../local/image-pilot.ts)) asks the picture card three questions before round
two: what round two's path, [one socket a stage](#one-socket) and [the next job at the over](#pipeline), saves a
cell, whether the card draws the same inputs to the same picture, and what comfy-kitchen's Triton backend changes. It
draws a fixed handful of the first round's clean cells again, from that round's own plans, portraits and views in
`illustrations/action-1`, into `illustrations/pilot`: flight's at seed 7, since flight binds four people, the most a
frame binds now. They are one of each kind of picture the run draws: the first front, the first view, A, C with four
portraits, V with both views among its four, and T with L's picture and four portraits. It draws no sharp story, reads
nothing under `sealed/` and writes nothing into the first round's directory or into `illustrations/action`. It refuses
a first round whose pictures are not the files its `draw.json` records, and a plan of flight's that gives a cell a
prompt of another length or another number of references than the first round's record of it: the first round's own
hash of the plans covers the sealed ones too, which the pilot does not read.

- `draw`, on the server as the first round ran it:
  - the determinism check: C, then A, then C again, whose picture is compared with the first C's. It counts only when
    the socket heard that neither C's sampler was answered from the server's cache, which may keep older jobs on a
    card with more RAM ([what the card keeps](gpu.md#what-the-card-keeps-of-a-picture)): `same`, `different` or
    `inconclusive`;
  - the front, the view, A, V and T three times: the baseline, each cell whole before the next on a socket of its own
    and the log read before and after each job, as the first round drew; the same on round two's path, one socket,
    each job sent at the over of the one before and the next cell's references uploaded while a job draws; and the
    baseline again, which brackets whatever drifts on the card.
- `triton`, once the server has been started again with `SIMPLE_CHAT_IMAGE_TRITON=1`: what the server's log says of
  comfy-kitchen's backends at its start, then the same five cells twice on round two's path, the first pass with
  whatever Triton compiles on its first use.
- `report`, which needs no card: each pass's times by cell, from one cell's record to the next and the job's own, the
  card's idle time in each, the peaks of video memory and RAM, what round two's path saved a cell against the mean of
  the two baselines, the determinism verdict, and Triton's sampler time against round two's path without it, its
  first pass against its second, and its pictures against the baseline's. The idle time is a cell's time less its
  job's on the card, which is its `totalMs` less its download: the baseline downloads with the card idle, and round
  two's path while the next job draws, so that on it the idle time is about the gap from the over before to the
  submit. Before round two's path it was the cell's time less the whole `totalMs`, the download counted as the job's.

Each cell keeps what a drawing stage records, its sha256, whether its sampler came from the cache, and its picture
against the baseline's, the first round's and, in Triton's second pass, the first's: the same bytes, or how many pixels
differ, by how much at most and on average, and the PSNR. A pass is a measurement: one that did not finish, or in
which a cell waited for the network, is drawn again whole, into a new directory and three times at most, and a
finished one is never drawn again. One pilot directory holds one card and one server. `draw` refuses the Triton
backend; `triton` refuses a server not started with it, one whose log says Triton did not load, and a pilot whose
baseline has not finished; and a pin that changed is refused as a drawing stage refuses it. `differsFromRoundOne`
names the pins that differ from the first round's, by name alone. Which kernels comfy-kitchen chose is not visible
from outside the server, since the pinned build logs its dispatch at debug level alone: `dispatchVisible` is false,
and the log's lines at the start say which backends the server found and whether Triton loaded. The sampler's seconds
and the pictures are the evidence of use. Nothing the pilot prints or keeps is a prompt or a word of a story:
`dry-run` draws a made-up first round against [fake-comfy.ts](../local/fake-comfy.ts), goes through both commands,
their refusals and the report, and searches the pilot's directory and all it printed for the scene's made-up word.

**When.** Once, on [the T probe](#t-probe)'s card, after the probe's `draw` and before the termination, with 20
minutes or more left before `--until`, as the owner decided on 2026-09-26: round two then starts its server with the
Triton backend only if the pilot shows it pays ([the runbook](#runbook)), and draws on a path the pilot has timed. The
probe's card is rented under a guard of two hours for both, and billed until its termination ([the T probe's
runbook](#t-probe-suit)). This replaces its place on round two's card, after round two's last `draw` and only when
seed 11 was drawn whole or stopped at its admission, chosen so that its minutes never came out of round two's.
Anywhere else it needs a card of its own and the owner's «да».

**The time**, from the first round's medians at seed 7 and the gaps it left between two jobs, 2.3 s and each
upload:

| | minutes |
| --- | --- |
| `draw`, the determinism check: C, A and C | 1.1 |
| `draw`, the baseline: the front, the view, A, V and T, 88 s of jobs | 1.7 |
| `draw`, round two's path, then the baseline again | 3.3 |
| the server stopped, and started with Triton | 1 |
| `triton`, the first pass: the models loaded again, and whatever Triton compiles and tunes | 3 to 7 |
| `triton`, the second pass | 1.2 to 1.6 |

That is 11 to 16 card-minutes on the T probe's card, $0.09 to $0.13 at the first round's $0.498 an hour; Triton's first
pass is the least known. On a card of its own, a setup of 8 to 30 minutes comes on top, as the first round's two cards
took, and half a minute for the first cold job: 20 to 47 minutes, $0.17 to $0.39.

```sh
npm run image:pilot -- dry-run    # before the card: "the pilot's dry run went as expected"
# On the T probe's card, after the probe's draw, with the server and the tunnel its runbook started and its "$end":
mkdir -p -m 700 illustrations/pilot
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/pilot/card.txt
npm run image:pilot -- draw --until "$end"    # each pass as it ends, then done true and the determinism verdict
# The server again, with comfy-kitchen's Triton backend: stopped as by Ctrl-C, its lock free, then started.
ssh -T simple-chat-vast 'pkill -INT -f "[C]omfyUI/main.py"; for i in $(seq 90); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; exit 1'
ssh -T simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1'
timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 2; done'
npm run image:pilot -- triton --until "$end"    # refused if Triton did not load; then done true
# The termination, as after every ending. After the card:
npm run image:pilot -- report
```

A command that stops prints `done: false` and the pass it stopped in, and run again draws that pass anew and goes on.
`--wait` is ten minutes here, twice a drawing stage's, for Triton's first compile; `--from`, `--dir`, `--timeout` and
`--comfy` keep their defaults. The stop waits for the server's lock rather than its process, since the sweeper beside
it holds the lock a second longer, and a start while the lock is held does nothing.

**Decided.** The pilot ran on the T probe's card on 2026-09-26: the card drew the same inputs to the same bytes,
round two's path saved 3.9 s a cell, and Triton's warm cells were 2.3 times faster, with their details changed
([the numbers](knowledge/gpu-measurements.md#pilot-2026-09-26)). The owner chose Triton on 2026-09-26: round two,
and every test after the pilot, draws with `SIMPLE_CHAT_IMAGE_TRITON=1` ([the runbook](#runbook)). What
comfy-kitchen's CUDA backend and torch.compile add on top of Triton is [the backend measurement](#backend)'s question,
asked in a directory of its own.

<a id='backend'></a>

## The backend measurement

On 2026-09-26 the owner asked what comfy-kitchen's CUDA backend adds on top of Triton, then what torch.compile adds,
and then, as a test, what Viggle's few-step LoRA does to the time and the pictures. On the default torch, cu128, the
pinned server turns the kitchen's CUDA backend off and says so at its start
(comfy/quant_ops.py:22-28). The backend needs torch built for CUDA 13, which [the picture card](gpu.md#cu130)
installs beside the default when asked, and a server started again on it. The same `npm run image:pilot` draws the
pilot's five timed cells: the front, the view, A, V and T of flight at seed 7, from the first round's plans, portraits
and views. Each command draws them cold, then warm, on round two's path, into `illustrations/pilot-cuda`. Every command
needs the Triton backend on. The kitchen prefers its CUDA backend, then Triton, then its eager path, layer by layer, so
on cu130 Triton is what a layer falls back to.

- `reference`, on a server of the default torch with Triton, as round two runs it: what the others are compared with.
  The head test's server is such a server, so it needs no restart.
- `compile`, on the same server right after, with ComfyUI's core `TorchCompileModel` node on the model's way to the
  sampler: after the loader and, in a frame's graph, after `QwenImage21Cache`, so that it compiles the patched model.
  Its one input besides the model, `backend`, is pinned to its default, `inductor`. The node itself asks torch.compile
  for no mode and no fullgraph, leaves `dynamic` to torch, and drops the guards on `transformer_options`
  (comfy_extras/nodes_torch_compile.py and comfy_api/torch_helpers/torch_compile.py at the pinned revision). The first
  pass compiles for each size and each number of references it meets; the second draws on what it compiled.
- `turbo`, a test the owner allowed on 2026-09-26 («в качестве теста можно»), once the server has been started again
  on the default torch with Triton and [Viggle's node](gpu.md#viggle). The same cells, sampled through Viggle's LoRA in
  six steps instead of the reference's 25, each graph changed the way the repository's own ComfyUI workflows use it:
  `ViggleTurboLora` at strength 1.0, which its readme says to keep, takes the loader's model, and in a frame's graph
  `QwenImage21Cache` takes the LoRA's. The `KSampler` gives way to `SamplerCustomAdvanced` with `KSamplerSelect` on
  euler, `BasicGuider` on the same positive conditioning, `RandomNoise` on the cell's seed, and `ViggleTurboSigmas`
  with its six default nodes, fed the cell's latent, whose size shifts them. The reference samples at cfg 1.0, which
  skips the negative prompt (comfy/samplers.py:610), so a step is one call of the model in both. What differs is the
  number of steps and the LoRA's own cost: its node adds the LoRA beside the weights on every call rather than merging
  it, 10 to 25 per cent a step by the readme. A cell that starts from a picture at a denoise below 1 would be left out
  and named in the record, rather than sampled on a cut schedule the LoRA was not distilled for. Both pinned graphs
  sample an `EmptyLatentImage` at denoise 1.0, so no cell of the pilot is left out.
- `cuda`, once the server has been started again on cu130 with Triton. It is refused unless the server's log at its
  start shows the kitchen's CUDA backend available and not disabled, and the refusal gives the kind of reason the log
  gave: an extension missing, one that failed to load a library, no CUDA, or another.
- `cuda-compile`, optional: on that server with the compile node, only when its time is left.
- `report --dir illustrations/pilot-cuda`, which needs no card. Against the reference's warm pass it gives each
  command's warm sampler and cell times, by cell and in all, as ratios; what its cold pass took more a cell than its
  warm one, which in a compile pass is the compiles; its pictures against the reference's, as the same bytes or the
  share of pixels that differ, the largest difference and the PSNR; and its peaks of video memory, cold and warm.
  cuda-compile is set against cuda's warm pass too. Beside the numbers is the evidence: the torch each pass was drawn
  on, as `/system_stats` reported it, and the log's lines on the kitchen's backends for each command. A command that
  did not finish says how its last attempt ended, with each failed cell's code, and whether it was skipped for time.
  `turbo` gets the same times, peaks and cold extra, the LoRA it drew with and the cells it left out, and no pixels:
  its pictures come from another schedule. The owner judges them by eye on `turbo.html`, which `turbo` writes into
  the directory: each cell's reference picture beside turbo's, with both sampler times, over the portraits and views
  the cell took into its slots. The owner's measure: faces roughly like the portraits, and the figure and silhouette
  kept in every cell; exact faces are not required.

One card, and one server for each torch. Each command checks that the server runs the torch
[image-manifest.env](../gpu/image-manifest.env) pins for it, `TORCH_VERSION` for `reference`, `compile` and `turbo`
and `TORCH_CU130_VERSION` for `cuda` and `cuda-compile`. A restart that did not happen, or a server on the other torch, is
refused before anything is drawn, as is a server without Triton or one whose log says Triton did not load. Every
other pin, the card and ComfyUI among them, must stay the same across the directory. `compile`, `turbo` and `cuda`
come after a finished reference, and `cuda-compile` after a finished cuda. No server draws the LoRA's graphs and plain
ones both, the owner's rule after ComfyUI's PRs 16493 and 15734. Each command asks the server's `/object_info` for
Viggle's two nodes before it draws: `turbo` is refused unless the server has both and lists the LoRA among its loras,
every other command is refused on a server that has either. A refused `turbo` leaves the schedule as it was: the
runbook goes on to the restart on cu130. The pilot's directory and this one are never mixed:
each refuses a `pilot.json` that holds the other's passes. The log's lines on the backends are read before anything
is drawn, while the lines of the server's start are still in its log. A later run of the same command that no longer
finds them stands on the earlier read, and `cuda-compile` on cuda's. Which backend ran a layer is logged at debug
level alone, so here too the sampler's seconds and the pictures are the evidence of use.

A compile pass never holds up the card's schedule. A job that fails under it, as the kitchen's int8 layers may break
Inductor, is recorded with its code and ends the pass there, and the runbook goes on to the restart. Each of its jobs
may take ten minutes with the compiles, and no longer: `--wait` is cut to ten minutes under compile. Each pass begins
only with its time left before `--until`, ten minutes for the cold pass and two for the warm, or is skipped and
recorded as skipped. `compile` gets an `--until` nine minutes before the card's "$end", which keeps the two restarts,
`turbo` and `cuda` whole behind it, and `turbo` one five minutes before it, which keeps the restart on cu130 and
`cuda`. A job that fails under the LoRA ends `turbo`'s pass the same way, its code kept.

**The time**, from the pilot's Triton cells ([its numbers](knowledge/gpu-measurements.md#pilot-2026-09-26)) and its
restart:

| | minutes |
| --- | --- |
| the cu130 install and Viggle's two files, in the background beside `reference` and `compile` | 3 to 8 |
| `reference`, cold then warm, on the head test's server | 2 to 2.5 |
| `compile`, the first pass: Inductor's compiles for each size and number of references | 4 to 10 |
| `compile`, the second pass | 1 to 1.5 |
| the server stopped, and started again with Viggle's node | 1 to 1.5 |
| `turbo`, the first pass with the model and the LoRA loaded again, then the second, six steps a cell | 1.5 to 2 |
| the server stopped, and started on cu130 | 1 to 1.5 |
| `cuda`, the first pass with the model loaded again, then the second | 2.5 to 3 |
| `cuda-compile`, optional | 5 to 12 |

That is 13 to 22 card-minutes after the head test, compile's 5 to 12 of them the least known and turbo's 2.5 to 3.5
with its restart, and 5 to 12 more with cuda-compile: $0.11 to $0.18, and up to $0.28 with it, at the first round's
$0.498 an hour; turbo's share is $0.02 to $0.03. Turbo's passes are estimated from the pilot's Triton cells at six
steps of 25 and the readme's 10 to 25 per cent more a step: the text encoder, the references and the decode stay as
they were. A compile that fails or is skipped gives its minutes back, and so does a refused turbo, its restart aside.

```sh
npm run image:pilot -- dry-run    # before the card: "the pilot's dry run went as expected", its steps 5 to 7 this one's
# On the head test's card, after its last job, with the server of the runbook (cu128, Triton), its tunnel and "$end",
# and gpu/ of this commit on the card. The card's record first: the install below writes it again.
mkdir -p -m 700 illustrations/pilot-cuda
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/pilot-cuda/card.txt
# cu130 and Viggle's two files beside the server, in the background (gpu.md#cu130, gpu.md#viggle). pip's cache of the
# default install goes first: the box has 60 GB and the install asks for 13 GiB free. The log's first line is when the
# install began.
ssh -T simple-chat-vast 'cd /workspace/simple-chat-gpu && { ComfyUI/.venv/bin/python -m pip cache purge >/dev/null 2>&1; df -h . | tail -1; date -u +%FT%TZ > cu130-install.log; SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_TORCH=cu130 SIMPLE_CHAT_IMAGE_VIGGLE=true setsid -f nohup bash /workspace/simple-chat/gpu/image-bootstrap.sh </dev/null >>cu130-install.log 2>&1; }'
npm run image:pilot -- reference --until "$end"    # done true, pytorch 2.11.0+cu128
npm run image:pilot -- compile --until $(( end - 540 ))    # done true, or stopped with a code, or skipped: go on
# The install's end, five minutes at most, then when it began and ended and the torch it checked. Its mark is written
# once every file is verified, Viggle's two among them: without it there is neither turbo nor cuda, and the termination.
timeout 300 bash -c 'until ssh -o ConnectTimeout=10 simple-chat-vast "flock -n /workspace/simple-chat-gpu/image-bootstrap.lock true"; do sleep 10; done'
ssh simple-chat-vast 'cd /workspace/simple-chat-gpu && head -1 cu130-install.log && date -u -r ComfyUI/.venv-cu130/simple-chat-ready +%FT%TZ && cat ComfyUI/.venv-cu130/simple-chat-ready || tail -5 cu130-install.log'
# The server again, still on cu128 with Triton, now with Viggle's node: stopped as by Ctrl-C, killed after a minute
# since a compile may hold it, its lock free, then started. A timeout is a server that did not start: go on to the
# restart on cu130.
ssh -T simple-chat-vast 'pkill -INT -f "[C]omfyUI/main.py"; for i in $(seq 60); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; pkill -KILL -f "[C]omfyUI/main.py"; for i in $(seq 30); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; exit 1'
ssh -T simple-chat-vast 'SIMPLE_CHAT_IMAGE_VIGGLE=true SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1'
timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 2; done'
npm run image:pilot -- turbo --until $(( end - 300 ))    # done true with its page, or refused, or stopped with a code: go on
# The server again, on cu130 with Triton and without Viggle's node, the same way. A timeout is a server that did not
# start, and the termination.
ssh -T simple-chat-vast 'pkill -INT -f "[C]omfyUI/main.py"; for i in $(seq 60); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; pkill -KILL -f "[C]omfyUI/main.py"; for i in $(seq 30); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; exit 1'
ssh -T simple-chat-vast 'SIMPLE_CHAT_IMAGE_TORCH=cu130 SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1'
timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 2; done'
npm run image:pilot -- cuda --until "$end"    # refused unless the log shows the CUDA backend on; then done true
npm run image:pilot -- cuda-compile --until "$end"    # done true, or skipped with less than ten minutes left
# The termination, as after every ending. After the card:
npm run image:pilot -- report --dir illustrations/pilot-cuda
```

`--from`, `--dir`, `--wait`, `--timeout` and `--comfy` keep their defaults, as in the pilot: `--dir` is
`illustrations/pilot-cuda` for these five commands. `turbo.html` opens from that directory, since its paths are
relative to it.

**Not known before the card.** The dry run's line for the kitchen's CUDA backend on cu130 is modelled on the pinned
code (`kitchenLines` in [image-pilot.ts](../local/image-pilot.ts)). No card has shown it yet, nor whether the kitchen's
extension loads its CUDA 13 libraries there, cuBLASLt among them; the refusal of `cuda` covers either way. Only the
card says whether Inductor compiles the kitchen's int8 layers, and how often the cells' sizes make it compile again.
The install runs beside `reference` and `compile`, and its pip and its SHA256 checks take CPU and disk that the
compiles need too. The runbook prints when it began and ended, and the reference's warm cells can be read against the
pilot's Triton warm pass, which no install overlapped. Started before the head test instead, it would overlap none of
this measurement.

Nor has a card run Viggle's node at the pinned revision. Its graphs match its pinned file: the inputs' names and the
default six nodes. Only the card says whether its forward hooks fire on the kitchen's int8 layers under Triton,
where its own comment says a fused MLP kernel bypasses them and it adds that branch to the MLP's output instead, and
whether `QwenImage21Cache` works on the model it wraps as on the plain one. A node that fails to import leaves
`/object_info` without it and `turbo` refused; a graph the server rejects fails the first job with its code and ends
the pass. The LoRA's file is fetched from the repository's root, where its readme puts it; the bootstrap's SHA256
check is what says it is the pinned one.

<a id='levers'></a>

## The throughput measurement

On 2026-09-27 the owner set the picture card's next question: more pictures per card-hour from the base pipeline,
Qwen-Image 2.1 at the pinned graphs' 25 steps, with the pictures almost unchanged («основную наверное ускорять»).
Viggle's six steps are not the lever, since the bot does not draw with them; the changes the base keeps are drawn at
their schedule too, as a second row. Round two's defaults do not move: every server of the measurement is round two's,
started by [image-serve.sh](../gpu/image-serve.sh) with environment variables alone, and the kitchen's attention comes
in through a node of the graph. `npm run image:levers` ([image-levers.ts](../local/image-levers.ts)) draws into
`illustrations/levers` from round one's plans, portraits and views. It draws no sharp story, reads nothing under
`sealed/`, and keeps and prints what the pilot does: labels, codes, counts, times, hashes and pixel counts. The order
on a card, what each step may gain, the time and the runbook are [the card plan](#card-plan)'s, after this section.
Pictures move to simple-serving after round two; until then the work is here. The owner's verdict on what it measured
is [at the section's end](#levers-verdict).

**What the records already say**, read on 2026-09-27 from `illustrations/pilot/pilot.json` and
`illustrations/pilot-cuda/pilot.json` ([the backend measurement](#backend), both cards of 2026-09-26), the pictures
counted with this measurement's metric:

- Round two's server, cu128 with Triton, drew the five warm cells in 36.7 s of jobs and 40.0 s from one cell's record to
  the next: about 450 pictures an hour on round two's path.
- It draws the same bytes after another start of the server. The pilot's Triton passes, on the T probe's card, and the
  backend measurement's reference passes, on the head test's card hours later, are the same files, cold and warm.
  A change whose pictures differ from the reference's therefore differs by the change.
- A cell the server had not drawn before took 2.4 to 2.8 s more in the sampler than the same cell drawn again: the view,
  A, V and T of the reference's cold pass, on a server whose models were loaded. On cu130, where the kitchen's CUDA
  backend runs the int8 layers, the same cells took −0.3 to +0.3 s more. The kitchen's Triton matmuls are autotuned by
  their exact m, n and k, six configurations tried on each shape the first time it is met
  (comfy_kitchen/backends/triton/quantization.py:861-870 and 943-952 in comfy-kitchen 0.2.35). That this is the
  cause is read from the code, not measured; the reference's tuning lines count it.
- cu130's warm cells took 0.89 of the reference's time and 0.87 of its sampler's, and differed from its pictures by
  0.37 to 5.95 per cent of the pixels by more than 3 per cent, 32.7 to 43.9 dB: within what the Triton switch showed.
  The pilot's report counts the alpha channel beside the three colours, which lifts its PSNR by 1.25 dB on these RGBA
  pictures; its 33.9 to 45.1 dB are these.
- torch.compile took 1.89 times the reference's time a warm cell, and is left out.

**The steps**, each on a server of its own but attention, which rides on the server before it:

- `reference`: round two's server with `TRITON_PRINT_AUTOTUNING=1 TRITON_CACHE_AUTOTUNING=1`, Triton 3.6.0's own
  switches (python/triton/knobs.py:374-376): every tuning printed into the server's log and kept in Triton's cache.
  What the others are read against, row by row.
- `cu130`: the same with `SIMPLE_CHAT_IMAGE_TORCH=cu130` ([torch for CUDA 13](gpu.md#cu130)), where the kitchen's CUDA
  backend runs the int8 matmuls and nothing is tuned.
- `attention`: `ModelAttentionBackend` at `comfy kitchen attention` in every graph, a core node of the pinned ComfyUI
  (comfy_extras/nodes_model_advanced.py:374-411), on cu130's server without a restart, or on closing's where cu130 did
  not draw; then one cell without the node.
- `closing`: the reference again after a restart, which reads back the tunings the reference wrote.

**The proofs.** Before a step draws, its server must say what it is, or the command is refused and draws nothing:

- `/system_stats`: `--enable-triton-backend` and no flag that image-serve.sh does not add (`argv`, server.py:736),
  the manifest's torch for the step (`pytorch`), and `cudaMallocAsync` ending the card's name
  (comfy/model_management.py:604-611, server.py:713).
- `/object_info`: none of Viggle's two nodes on the base row, both and the LoRA on the turbo row, which is how a
  command knows its row; and for `attention`, the kitchen's attention among the node's options, which it lists only
  where the kernel is available (nodes_model_advanced.py:377-379).
- The lines of the server's start, from its log's last 300 (app/logger.py): the kitchen's Triton backend loaded,
  PyTorch's attention ("Using pytorch attention", comfy/ldm/modules/attention.py:869), and on cu130 the kitchen's CUDA
  backend available and on (comfy/quant_ops.py:22-43). A cold pass also needs no job in the log since the start,
  neither "got prompt" (server.py:1077) nor "Prompt executed in" (main.py:382-384). Where a later command on the same
  server finds its start gone from the ring, the earlier read of the same process stands.
- Over ssh (`--ssh`, `simple-chat-vast` by default), counts alone: one server on the card, and each of
  `TRITON_PRINT_AUTOTUNING`, `TRITON_CACHE_AUTOTUNING`, `TRITON_CACHE_DIR` and `TRITON_HOME` in its environment
  (`/proc/<pid>/environ`) as the row wants it: the first two once and set to 1 on the base row, the first alone on the
  turbo row, the other two at most once and as on the row's reference server. A card that does not answer is
  refused. The tuning files are counted where Triton keeps them: `TRITON_CACHE_DIR`, or `.triton/cache` under
  `TRITON_HOME` or else `HOME` (knobs.py:342-353).
- One change at a time: the vram state, dynamic VRAM, the attention, the place of Triton's cache and the kitchen's
  CUDA backend as the reference's server of the row said them, the step's own torch aside. `closing` needs another
  process than the reference's, and `attention` the process of the step it rides on, once that step has drawn.

**Rows and passes.** A command draws one row, the one its server was started for: the base row on a server without
Viggle's nodes, the turbo row on one started with `SIMPLE_CHAT_IMAGE_VIGGLE=true`, whose cells go through the LoRA in
six steps (`withTurbo` in [image-pilot.ts](../local/image-pilot.ts)). No server draws both, the owner's rule after
ComfyUI's PRs 16493 and 15734. Each row has its own reference, drawn first. The passes, each drawn whole on round two's
path, one job on the card at a time, into a directory of its own under `passes/`:

- `cold`: the pilot's five timed cells, flight's front, view, A, V and T at seed 7, as the first work of a server just
  started. What a start costs: the models' load, and every shape's first tuning.
- `warm`: the same five again: a cell's seconds by phase, and pictures an hour on round two's path.
- `stream`: eight of round one's clean text-only frames at seed 7, each of a conditioning length new to the server,
  then the same eight at seed 11 ([the card plan](#card-plan)). `npm run image:levers -- stream` prints the eight
  before the card. Each job keeps the server's own stamps of its start and its success (execution.py:677-684, 742,
  824), and costs its time and the gap before it.
- `plain`: `attention`'s one cell without the node, which must be the same server's plain picture again.

`reference` and `cu130` draw cold, warm and the stream; `attention` warm, the stream and plain; `closing` cold and the
stream's first eight, all lengths the reference tuned. A pass is drawn again whole on an attempt of its own, three at
most, and a finished pass or step is never drawn again. A pass begins only with its time left before `--until`, or is
skipped and recorded as skipped: four minutes for cold and the stream, two for warm, half a minute for plain. A pass of
`attention` does not count as finished, and the step stops there, where the log says the node fell back to PyTorch's
attention ("Attention backend ... is unavailable", nodes_model_advanced.py:406-408) or where its warm cells are the
plain pictures. A sampler answered from the server's cache ([what the card
keeps](gpu.md#what-the-card-keeps-of-a-picture)) makes a pass's times not comparable, and the report says so.

**The counts.** Per job, the lines Triton's autotuner prints (python/triton/runtime/autotuner.py:246-248) between the
log's reads before and after it, with their keys' m, n and k; the log keeps its last 300 entries, so a read that no
longer reaches back makes that job's count a floor (`tuningFloor`). Per pass, over ssh, the `*.autotune.json` files
under the server's Triton cache before and after. The environment and the log are never copied.

**The pictures.** Each step's warm cells and stream frames are compared with those of its comparison step of the
same prompt and seed: cu130's and closing's with the reference's, attention's with the plain ones of its own server,
cu130's or the reference's. That is 21 pairs a step, and 13 for closing, whose cold cells stand for its warm ones. The
count is ImageMagick's `compare -fuzz 3%` and `-metric PSNR`, as for the pilot's `triton.html`. Every colour is
premultiplied by its pixel's alpha; a pixel is off when one of its three colours differs by more than 3 per cent of
the scale; the PSNR is over the three colours. On the pilot's five Triton pairs it gives compare's counts exactly,
2,717 to 63,875 pixels and 31.31 to 47.21 dB (checked on 2026-09-27). A step is one of:

- `identical`: the same pixels in every pair;
- `rounding`: every pair within what the Triton switch showed, 7.1 per cent of the pixels off by more than 3 per cent
  at most and 31 dB at least;
- `visible`: anything more. It is kept only once the owner has looked, as is an `unknown` one, a pair not compared
  (`needsEye`).

The numbers do not say that the scene and the people are the same; the page puts them in front of the owner.
`levers.html`, which each command writes again as it ends, sets each picture of the comparison step beside the step's
and their difference eight times as bright, black where they agree, row by row, with the verdict and the ratios. It
opens from the directory, since its paths are relative to it.

`report`, which needs no card, gives by row the reference's numbers and each step's:

- whether each pass finished, how the last attempt of one that did not ended, and what proved the step;
- the timed cells by phase, and pictures an hour on round two's path;
- the stream's pictures an hour from the server's stamps, for new lengths (`fresh`, seed 7) and known ones (`known`,
  seed 11), with its tuning lines and tuned jobs;
- the tuning lines and cache files by pass, what the cold pass took more than the warm one, and the peaks of video
  memory;
- against the comparison step, the verdict, the ratios of the sampler's and the jobs' times and of pictures an hour,
  and the pixels by pair; for attention, whether the plain cell after it was the plain picture again (`plainAgain`).

The number nearest the owner's question is `picturesPerHourRatio.streamFresh` on the base row: pictures an hour for
new lengths, against the comparison step's.

Flags left out, each for what it does to this graph: highvram and gpu-only keep the model on the card between jobs and
turn dynamic VRAM off (comfy/model_management.py:578-579, 1106-1110, comfy/cli_args.py:318-321); native-malloc swaps
cudaMallocAsync for torch's own allocator (cuda_malloc.py:90-112); no record gives any of them a cost to remove, and
each moves the memory paths the pictures depend on. `--use-ck-attention` makes a server exit where the kernel is
unavailable (attention.py:883-885), and the node draws the same kernel beside the plain pictures on one server. `--fast`
with autotune turns cudaMallocAsync off and sets cuDNN's benchmark, which reaches the VAE's convolutions alone
(cuda_malloc.py:93, comfy/model_management.py:563-565). fp16 accumulation reaches a linear whose input is fp16 alone
(comfy/ops.py:968-972), and the model draws in bf16 (comfy/supported_models.py:2071). flash-attn, SageAttention and
cublas_ops would each bring a wheel onto the card and need a pin first.

<a id='levers-verdict'></a>

**The owner's verdict**, on 2026-09-27, having looked at `levers.html`: «ну на обычной 25 шагов не вижу разницы», no
difference to see on the base pipeline at its 25 steps. By the numbers both steps were `visible` and waited for that
eye: against the reference, cu130 had 0.37 to 38.1 per cent of the pixels off by more than 3 per cent, and against
cu130 the attention 0.18 to 53.1. cu130 and the kitchen's attention together are therefore the bot's picture path
([the bot's card](gpu.md#bot-card)). On the base row, pictures an hour against the comparison step:

| Step | Against | Known lengths | New lengths | Round two's path |
| --- | --- | --- | --- | --- |
| cu130 | the reference | 1.169x | 1.616x | 1.129x |
| attention | cu130 | 1.154x | 1.149x | 1.158x |
| Together | the reference | 476 to 642 an hour, 1.35x | 343 to 637, 1.86x | 357 to 467, 1.31x |

A scene's prompt is almost always a length the server has not drawn, so for the bot the new lengths are the nearer
number. The turbo row stays out of the decision, and so does the attention on cu128, whose server offered the node too
and which nothing here drew, and on Krea, which nothing here drew either. The experiments keep round two's backend,
cu128 with Triton and no node: image-bootstrap.sh and image-serve.sh keep cu128 as their default, which the runbooks
here take by naming no torch, the cu130 steps of this measurement and of the backend measurement aside, and a run's
pins refuse a resume on another torch or Triton switch, so round two's action runs and figure-age's P run draw where
they drew.

<a id='card-plan'></a>

## The card plan

The order in which [the throughput measurement](#levers) goes on a card, written on 2026-09-27 from four reports on
the pinned sources and the records, the measurement's harness, and a review by gpt-6-astra with a second opinion on
it. None of it has run on a card. It keeps the harness's servers, proofs, pixel metric and page, and cuts three
things. The ten-job `queue` goes: ten jobs sent at once break [the one-job rule](#pipeline) however the server takes
them. highvram, gpu-only and native-malloc go: no record gives them a cost to remove, and each moves the memory paths
the pictures depend on. `--use-ck-attention` gives way to a node of the graph, so that one server draws the kitchen's
attention and its plain pictures. What comes in their place is below, with what the harness does. Nothing here
rents a card: that needs the owner's «да» on the price and the deadline.

The owner's answers of 2026-09-27:

- «выбераем второе»: the measure is pictures per card-hour from the base, Qwen-Image 2.1 at the pinned graphs' 25
  steps, with the pictures almost unchanged, and not one reader's wait.
- «хз, я думаю основную наверное ускорять, а с турбо это как будто распыляет нас... типо ускорили вещи на основе и
  потом сразу на турбо? Или наоборот?» ("Not sure, I think speed up the base; turbo seems to spread us thin. Speed
  things up on the base and then right away on turbo? Or the other way round?"): the base first, then turbo right
  after on the same card, for the changes that came through the base alone. The bot draws the base, and a turbo copy
  of a change the base turns down buys nothing.
- «Можно, но вопрос для ядер, ты же можешь использовать слабые карты blackwell тебе же не обязательно 5090?» ("Fine,
  but for kernel questions you can use weak Blackwell cards, you don't need a 5090, do you?"): whether a kernel loads
  and runs, any sm_120 card can say, though not its seconds nor, until a card shows it, its pixels; this queue has no
  such question left that is worth a card of its own ([the cards](#card-plan-cards)).

**The stream** takes the queue's place: eight of round one's clean text-only frames (A, A+ or L at 1280x704), drawn at
seed 7, then the same eight at seed 11, one job at a time on round two's path ([the next job at the over](#pipeline)).
They are the nearest the round has to a bot's scene, which has a prompt of its own and no reference
([picture.ts](../local/picture.ts)). Round one's `illustrations/action-1/draw.json` holds 39 of them with 38 distinct
conditioning lengths, 204 to 555 tokens. The eight are chosen before the card by round one's key (width, height,
conditioning tokens, reference sizes), distinct from each other and from the five cells', so that each brings a
sequence length new to a server just started. The first eight give what a new prompt costs; the second eight the same
lengths known, the sampler run again since the seed differs. Every picture of the stream is compared with its
comparison step's of the same prompt and seed, so a change is judged on 21 pairs, not 5. Each job keeps the server's own
stamps of its start and end (execution.py:677-684, 742, 824) beside the harness's cycle, so that the card's busy time
and the handover between jobs show apart.

**The queue**, in the order the card runs it. Each server is round two's (`SIMPLE_CHAT_IMAGE_QWEN=only`,
`SIMPLE_CHAT_IMAGE_TRITON=1`) with what its step names on its restart line and nothing more, so round two's pins do not
move: every setting below is off unless that line sets it. The gains are pictures an hour; [E] is read from a record,
[G] is an estimate.

1. `reference`: round two's server, with Triton's tuning counted and kept.
   - Setting: `TRITON_PRINT_AUTOTUNING=1 TRITON_CACHE_AUTOTUNING=1`, Triton 3.6.0's own switches
     (python/triton/knobs.py:374-376), which image-serve.sh hands to ComfyUI with the rest of its environment. The
     first prints every tuning Triton finishes, with its key (m, n, k) and its seconds
     (python/triton/runtime/autotuner.py:246-248). The second writes the winner to a `*.autotune.json` under Triton's
     cache, `/root/.triton/cache`, and reads it there before it tunes again (autotuner.py:39, 170-210, 237-238).
     Nothing comes onto the card.
   - Proof: `/system_stats` gives the manifest's cu128 torch and `--enable-triton-backend`, and the log the kitchen's
     Triton backend; the server's environment holds each variable once, counted over ssh and never printed
     ([the proofs](#levers)). In `report`: each of the stream's first eight jobs adds tuning lines and cache files,
     and its second eight none. The lines are Triton's `print`, which ComfyUI's log keeps as it keeps its own
     (app/logger.py:51-70, 107).
   - Class: identical. The kitchen's int8 matmuls accumulate in int32 (comfy_kitchen/backends/triton/quantization.py:
     912, 994), so whichever tile the tuning picks, the sums are the same. Check, by hand after the card: the five
     warm cells' sha256 in `levers.json` against the backend measurement's reference pictures in
     `illustrations/pilot-cuda/pilot.json`, which were already the same bytes on two cards.
   - Gain: none. It is what the others are read against, and the first count of the tunings a new length pays, on
     which the case for cu130 rests: 2.4 to 2.8 s more in the sampler for a cell new to the server, read from the code
     as tuning and not yet counted ([what the records say](#levers)).
2. `cu130`: the kitchen's CUDA backend runs the int8 layers.
   - Setting: `SIMPLE_CHAT_IMAGE_TORCH=cu130` ([torch for CUDA 13](gpu.md#cu130)), Triton and the two variables as
     in 1. The kitchen tries its backends in the order cuda, triton, eager (comfy_kitchen/registry.py:25, 217-231).
   - Proof: `/system_stats` gives `2.11.0+cu130`; the log gives the kitchen's CUDA backend available and on
     (comfy/quant_ops.py:22-43), as the backend measurement's `cuda` read it. In `report`: the stream's eight new
     lengths add no tuning line and no cache file, so the int8 matmuls did not go to Triton. Which backend ran a layer
     is logged at debug level alone (registry.py:230).
   - Class: rounding, provisionally. The five pairs of 2026-09-26 had 0.37 to 5.95 per cent of the pixels off by more
     than 3 per cent, 32.7 to 43.9 dB over the three colours, as this measurement's metric counted them on 2026-09-27;
     no page has shown them to the owner. Check: every one of the 21 pairs within 7.1 per cent and 31 dB, then the
     owner's eye on `levers.html` for the scene and the people.
   - Gain: [E] +12.7 per cent on the five warm cells (40.3 s a pass to 35.7 s) and +17 per cent on A (5.60 s a cycle
     to 4.78 s), `illustrations/pilot-cuda/pilot.json`. [G] On text-only frames, +17 per cent where the server knows
     the length and up to +57 per cent where every length is new, the bot's case, from A's cycles and its sampler's
     extra for a new length, 2.43 s on cu128 and 0.33 s on cu130, before the bot's own handover and the readers'
     pauses. [G] +24 to +40 per cent a drawing-hour for a session like round two's (+28 to +38 by the second opinion's
     count), the pilot's cycles weighted by round two's cells. A card's setup, the same for either torch since a card
     for the bot installs one, dilutes that a little per paid hour.
3. `attention`: the kitchen's INT8 attention, on 2's server without a restart.
   - Setting: `ModelAttentionBackend` at `comfy kitchen attention` in every graph, on the model before the sampler: a
     core node of the pinned ComfyUI (comfy_extras/nodes_model_advanced.py:374-411). Qwen-Image 2.1's attention then
     rotates q and k and runs on signed int8 q, k and v and unsigned int8 probabilities (comfy/ldm/modules/attention.py:
     604-620, comfy_kitchen/sage_attention.py:538-577; comfy/ldm/qwen_image21/model.py:170, 179). The text encoder
     keeps its attention, and the prefix cache stays on: the override is none of the hooks that turn it off
     (qwen_image21/model.py:321-325). Nothing comes onto the card: the kernel is comfy-kitchen 0.2.35's.
   - Proof: `/object_info` lists `comfy kitchen attention` among the node's options, which it does only where the
     kernel is available (nodes_model_advanced.py:377-379); no job's log has "Attention backend ... is unavailable;
     using PyTorch attention." (406-408); each picture differs from the same server's plain one of the same prompt and
     seed, as int8 attention must; and one plain cell drawn after the pass is the same server's plain bytes again, so
     the node left nothing behind on the server. A kernel that fails fails its job with a code: the wrapper falls back
     to PyTorch's attention only for float32 with low precision off (attention.py:606-607).
   - Class: visible: it changes the arithmetic, not only its rounding. Check: the owner's eye on every pair against
     cu130's plain pictures, whatever the numbers say.
   - Gain: [G] +9 to +14 per cent a session and +8 to +12 per cent on text-only frames on top of cu130, from an
     attention share of the step fitted on two cells and a kernel speed borrowed from another INT8 attention. No
     record times this kernel: it may gain nothing, or lose.
   - If 2 was refused or its server did not start, 3 runs on 4's server instead, on cu128, after 4's passes.
4. `closing`: the reference again after a restart, with the Triton cache 1 wrote.
   - Setting: as 1.
   - Proof: as 1, on another process than 1's. In `report`: the five cells and the stream's first eight, all lengths
     1 tuned, add no tuning line and no cache file: Triton read them back. The key of a file holds Triton's own hash,
     the target's and the environment variables that change a build (autotuner.py:182-190), all as in 1.
   - Class: identical. Check: the verdict against 1 on 13 pairs, its cold cells against 1's warm ones and the
     stream's first eight against 1's. Anything else means the card moved during the run, and every ratio above it
     says so.
   - Gain: [G] nothing within one server's life and nothing for a length never met; after a restart, 2.3 to 2.9 s for
     each length met before, +41 to +52 per cent on such a text-only frame (A's 5.6 s a cycle), on cu128 alone, since
     cu130 does not tune. The bot's server lives a whole rental without a restart, and the files stay on its card, so
     the bot gains next to nothing. Its minutes buy two more things: the run's drift, its known-length times against
     1's, and the one identical way to cut the tuning if the owner turns cu130's pictures down.
5. `reference` on the turbo row: a server with Viggle's node (`SIMPLE_CHAT_IMAGE_VIGGLE=true`), six steps a cell.
   - Setting: `TRITON_PRINT_AUTOTUNING=1` alone, so that it tunes every length afresh, as a turbo server just started
     would. Without the cache variable Triton neither reads nor writes the files (autotuner.py:237-240).
   - Proof: the harness's turbo checks of today (both of Viggle's nodes and the LoRA on `/object_info`), the cu128
     torch, the one variable, and tuning lines for every new length.
   - Class: identical to the backend measurement's turbo pictures if turbo too draws the same bytes on another
     server, which no card has shown yet.
   - Gain: none: turbo's base. The five warm cells took 24.4 s there.
6. `cu130` on the turbo row, then `attention` on it only if 3 finished with the sampler faster than 2's.
   - Setting, proof and check: as 2 and 3 with Viggle's node, against 5's pictures.
   - Class: as 2 and 3.
   - Gain: [G] +5 per cent where the length is known to +60 per cent where it is new, from turbo's A (3.37 s a cycle,
     1.25 s of it sampling, 2.30 s more in the sampler for a new length), with sampling 13.4 per cent shorter and 0.33
     s for a new length, as the base's on cu130. Whether Viggle's node works on cu130 is not known.

**Not on this card.**

- `--cache-lru` (comfy/cli_args.py:142): it would keep seed 7's conditioning for seed 11, identical, about 85 s of a
  two-seed session, 1 to 3 per cent [G], and nothing for the bot, whose prompts differ. It takes a number, and
  image-serve.sh passes no flag with a value. Its hits and its RAM are for the next opted-in two-seed session to show.
  The bot's server would keep more of the readers' prompts with it, which needs the owner's consent. The default
  cache already keeps older jobs on a container with more than 128 GiB of RAM (main.py:323-325), which the rent plan
  does not exclude, and image-serve.sh does not pass `--cache-classic`, which would bound them to the last job
  ([what the card keeps](gpu.md#what-the-card-keeps-of-a-picture)): a question for the owner apart from this plan.
- The next job sent before the telemetry is read: still one job on the card, identical, about 0.8 to 0.9 s a cell
  [G] from a residual the harness computes, not a measured idle. The steps the owner approved read the telemetry
  first ([the next job at the over](#pipeline)), so it is the owner's question; the server's stamps measure it in any
  run.
- Triton's cache carried from one card to the next, or one tile fixed for every length: a file we generate, or code
  of our own, has no official pin.

Dropped, each for its reason: QwenImage21Cache on `gpu`, and on `cpu`, which the owner named as its fallback for T6
and T7 (round two binds four portraits at most and so stops at T5, where the cache already holds, and the bot's frames
have no reference); cuDNN attention (1 to 2 per cent [G], through a node of our own); the per-step copy of the prefix's
k and v, or q, k and v fused (0.9 to 1.8 and 3 to 5 per cent [G], patches to the model outside the pin); NVFP4, FP8
and INT4 weights (visible; no record has FP8 faster than the int8 here, comfy-kitchen 0.2.35 runs INT4 on sm_120
through its int8 path, `comfy_kitchen/backends/cuda/__init__.py:317-324`, and NVFP4 has no official file, only a
converter of our own); EasyCache and the other step caches (they skip the model's evaluations, which is visible, and
Flux's hooks turn Qwen's prefix cache off); a positive-only encode at CFG 1 (a node of our own); torch.compile (69.9 s
a warm pass against 40.3 s, and on cu130 it failed its first cell); batches of more than one picture (another workload
than the pinned one); two servers on one card (the weights twice in 32 GB).

**The harness**, as [the throughput measurement](#levers) describes it, and as its dry run on the fake server checks
it (25 checks and 14 refusals):

- The stream in place of `queue`, on round two's path, one job on the card at a time; `npm run image:levers -- stream`
  chose tango L, giants L, guard A, giants A+, flight A+, monkeys A+, lineout L and lineout A+ on 2026-09-27, 204 to
  555 conditioning tokens, of 37 frames of lengths of their own.
- Per job, the tuning lines between its log reads, as a count and their keys' m, n and k, a floor where the ring no
  longer reached back. Per pass, the count of `*.autotune.json` under the server's Triton cache, and at the start
  each variable's count in the server's environment (`/proc/<pid>/environ`), both over ssh, since the harness reaches
  the server only through the tunnel. Counts only: the environment and the log are never copied. The ssh script was
  checked on 2026-09-27 against a stand-in process here, not on a card.
- `attention` and `closing` as above. The one-change rule holds the variables' counts to the row's settings.
- highvram, gpu-only, native-malloc and ck-attention out of the runbook, and with them `SIMPLE_CHAT_IMAGE_LEVER` out
  of image-serve.sh, image-manifest.env and gpu.md: every server of the queue is round two's gpu/ with environment
  variables.
- cu130's four wheels by sha256 with pip's `--require-hashes` and `--no-deps` ([torch for CUDA 13](gpu.md#cu130)):
  torch 2.11.0+cu130 (96911323), torchvision 0.26.0+cu130 (0f030a9b), torchaudio 2.11.0+cu130 (3fba988f) and the
  cu130 index's triton 3.6.0 (6f5928e6, a build other than PyPI's of the same version), for CPython 3.12, as the
  index listed them on 2026-09-27. What they pull goes on by version, as before: the eleven NVIDIA libraries of
  cuda-toolkit 13.0.2, whose pins end in `.*`, cuDNN 9.19.0.56, cuSPARSELt 0.8.0, NCCL 2.28.9, NVSHMEM 3.4.5,
  cuda-bindings from 13.0.3 to below 14, and ComfyUI's requirements. Their hashes were not read, and cu128's torch
  goes on by version alone too.

<a id='card-plan-cards'></a>

**The cards.** The seconds, the memory and the pictures an hour are the RTX 5090's, and only a 5090 gives them:

- **Round two's picture card**, after round two's draw, the figure-age card test and the body test, on the same
  server, tunnel and `"$end"`, as the pilot ran on the T probe's card. cu130 and Viggle's two files install in the
  background beside the body test, whose pictures are judged and not timed, so their 3 to 8 minutes add next to
  nothing. Each command begins only with its time left before `"$end"`, the base row first. Whether there is room is
  known only there: round two's table gives its jobs 143 to 211 of the guard's 180 minutes with seed 11 and 96 to 130
  without it ([the time](#time)), but at the identity run's 15 s a frame, before Triton made warm cells 2.3 times
  faster ([the pilot](#pilot)).
- **A card of its own**, from `npm run gpu:rent -- --lane pictures --qwen only --hours 2`: the setup of round two's
  card, 8 to 30 minutes as round one's cards took, with Viggle's two files in the same bootstrap, then the cu130
  install alone, 3 to 8, then the queue. That is 29 to 68 minutes, more at the slow end than the 55 an hour's guard
  leaves before `"$end"`, so the guard is two hours, as the T probe's card had. The bill runs to the termination, not
  to the guard, so the longer guard costs nothing unless the termination fails.

A cheap sm_120 card first, an RTX 5060 Ti (`--lane small` takes a card of compute capability 12.0 with 16 GB or more,
at most $0.25 an hour, so not the 12 GB 5070; the 5060 Tis of 2026-09-25 cost $0.146 to $0.189): no. Every GeForce RTX
50 is sm_120, so such a card would say whether the kitchen's attention and Viggle's node launch on cu130 and draw sane
pictures there. The 5090 says it in the first job of each, since a kernel that fails fails its job and ends its pass:
seconds, and at worst an attention pass of bad pictures, 2.5 minutes, about 3 cents. cu130 itself has drawn on a 5090
already. For that answer the small card would pay 20 to 50 minutes of its own with its setup [G], $0.05 to $0.16, and
about 26 GB of downloads, $0.07 to $1.37 at the traffic prices below; its lane refuses `--qwen only`
([rent-plan.ts](../local/rent-plan.ts)), so its price would be counted by hand. Its 16 GB hold Qwen's 17.3 GB only in
part, so its prefix cache takes other paths, and its seconds, its tiles and its pixels do not stand for the 5090's;
`--lane small` also asks for 16 GB of RAM, not the picture lane's 30. It pays where a kernel comes in a new wheel or
needs a build, and this queue has none.

**The time and the price**, estimated from `illustrations/pilot-cuda/pilot.json`: a restart 0.7 to 1.5 minutes (42.7
s between compile's end and turbo's start there); the five cells 57.6 s cold and 40.3 s warm on cu128, 51.4 and 35.7 s
on cu130, 59.6 and 24.4 s under turbo; a text-only frame 5.6 s a cycle on cu128 and 8.0 to 8.4 s when its length is
new, 4.8 to 6.5 s on cu130, 3.4 s under turbo and 5.4 to 5.7 s new.

| step | minutes |
| --- | --- |
| cu130 and Viggle's two files installed, beside the body test on round two's card | 3 to 8, hidden there |
| 1 `reference`: the restart, cold, warm, the stream | 4.3 to 5.4 |
| 2 `cu130`: the first start on cu130, cold, warm, the stream | 3.5 to 9 |
| 3 `attention`: warm and the stream with the node, then one plain cell | 1.7 to 2.5 |
| 4 `closing`: the restart, cold, the stream's first eight | 2.3 to 3.6 |
| 5 turbo `reference`: the restart, cold, warm, the stream | 3.3 to 4.1 |
| 6 turbo `cu130`, and `attention` on it if 3 was faster | 2.7 to 4.9 |
| the queue | 18 to 30 |

The first start on cu130 is the least known: 6.1 minutes passed between turbo's end and cuda's start on 2026-09-26,
and nothing recorded why. The base row, 1 to 4, is 12 to 21 of the minutes and the turbo row 6 to 9. At $0.50 to
$0.65 an hour:

- on round two's card, the queue's 18 to 30 minutes, $0.15 to $0.33, and about 4 GB of downloads, $0.01 to $0.21:
  cu130's torch and its CUDA wheels, 2.7 GB as the index and PyPI listed them on 2026-09-27, ComfyUI's requirements
  again, and Viggle's LoRA, 0.68 GB;
- on a card of its own, 30 to 70 minutes with the setup, the install and the end, $0.25 to $0.76, about $0.02 of
  disk at the $0.017 an hour a 60 GB disk was billed, and about 26 GB of downloads (Qwen's 17.3 GB, the rent plan's
  5 GB for torch and the 4 GB above), $0.07 to $1.37 at the $2.6 to $52 a TB that hosts charge
  ([prices](knowledge/gpu-measurements.md#costs-and-downloads)).

That is $0.16 to $0.54 on round two's card and $0.34 to $2.15 on a card of its own, where the traffic price decides
most of the spread. The rent dry run's `session` replaces the second before the «да».

```sh
npm run image:levers -- dry-run    # before the card: "the throughput measurement's dry run went as expected"
npm run image:levers -- stream     # before the card: the eight frames above, candidates 37, jobs 16
# On round two's picture card, after round two's draw and the figure-age card test, with the server, the tunnel and
# "$end" as they are, and gpu/ of this commit on the card. The card's record first, the body test's and this one's:
# the install below takes it away while it verifies, then writes it again.
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/t-probe-bodies/card.txt
mkdir -p -m 700 illustrations/levers
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/levers/card.txt
# cu130 and Viggle's two files, detached (gpu.md#cu130, gpu.md#viggle), 3 to 8 minutes beside the body test; pip's
# cache of the default install goes first, since the box has 60 GB and the install asks for 13.6 GiB free with
# Viggle's LoRA (image-bootstrap.sh:220-226). Then the body test's draw, as its runbook has it.
ssh -T simple-chat-vast 'cd /workspace/simple-chat-gpu && { ComfyUI/.venv/bin/python -m pip cache purge >/dev/null 2>&1; df -h . | tail -1; date -u +%FT%TZ > cu130-install.log; SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_TORCH=cu130 SIMPLE_CHAT_IMAGE_VIGGLE=true setsid -f nohup bash /workspace/simple-chat/gpu/image-bootstrap.sh </dev/null >>cu130-install.log 2>&1; }'
npm run image:body-test -- draw --until "$end"
# On a card of its own instead: rented, guarded and set up as round two's picture card (#runbook) with --hours 2,
# SIMPLE_CHAT_IMAGE_VIGGLE=true beside SIMPLE_CHAT_IMAGE_QWEN=only in its bootstrap, and no server started; then this
# measurement's record alone, the same install, and the tunnel.
# Either way: the install's end, ten minutes at most, and its mark. Without the mark there is neither cu130 nor the
# turbo row: 1, 4 and 3 on cu128 go on, and the rest is left out.
sleep 15; timeout 600 bash -c 'until ssh -o ConnectTimeout=10 simple-chat-vast "flock -n /workspace/simple-chat-gpu/image-bootstrap.lock true"; do sleep 10; done'
ssh simple-chat-vast 'cd /workspace/simple-chat-gpu && head -1 cu130-install.log && date -u -r ComfyUI/.venv-cu130/simple-chat-ready +%FT%TZ && cat ComfyUI/.venv-cu130/simple-chat-ready || tail -5 cu130-install.log'
# A server of its own for each step: stopped as by Ctrl-C, killed after a minute, its lock free, then started detached
# with round two's settings and the ones given, and waited for through the tunnel, five minutes at most. A server that
# exits at its start frees its lock, and the wait ends there: that step is left out and the next one goes on.
restart() {
  ssh -T simple-chat-vast 'pkill -INT -f "[C]omfyUI/main.py"; for i in $(seq 60); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; pkill -KILL -f "[C]omfyUI/main.py"; for i in $(seq 30); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; exit 1' &&
  ssh -T simple-chat-vast "$* SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1" &&
  timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 5; ! ssh -o ConnectTimeout=10 simple-chat-vast "flock -n /root/.simple-chat-comfy.lock true" || exit 1; done'
}
# The queue, the base row first. Every command stops at "$end" and begins a pass only with its time left.
tune='TRITON_PRINT_AUTOTUNING=1 TRITON_CACHE_AUTOTUNING=1'
restart $tune && npm run image:levers -- reference --until "$end"                            # 1, 4.3 to 5.4 min
restart $tune SIMPLE_CHAT_IMAGE_TORCH=cu130 && npm run image:levers -- cu130 --until "$end"   # 2, 3.5 to 9 min
npm run image:levers -- attention --until "$end"    # 3, 1.7 to 2.5 min, on 2's server; refused where 2 did not draw
restart $tune && npm run image:levers -- closing --until "$end"                              # 4, 2.3 to 3.6 min
npm run image:levers -- attention --until "$end"    # 3 on cu128 where it did not draw on 2's server; else drawn 0
# The turbo row, each server with Viggle's node: 6 is 2.7 to 4.9 minutes with its attention.
restart TRITON_PRINT_AUTOTUNING=1 SIMPLE_CHAT_IMAGE_VIGGLE=true && npm run image:levers -- reference --until "$end"  # 5, 3.3 to 4.1 min
restart TRITON_PRINT_AUTOTUNING=1 SIMPLE_CHAT_IMAGE_VIGGLE=true SIMPLE_CHAT_IMAGE_TORCH=cu130 && npm run image:levers -- cu130 --until "$end"  # 6
npm run image:levers -- attention --until "$end"    # 6's attention; refused unless 3's sampler was faster
# The termination, as after every ending. After the card:
npm run image:levers -- report
```

A command prints `done: true` when its passes all finished, and otherwise the pass it stopped in, a failed cell's
code, or the pass skipped for time. Run again on the same server it draws that pass anew and goes on, but a cold pass
needs a server just started; either way the runbook goes on to the next step. `--from`, `--dir`, `--ssh`, `--wait`,
`--timeout` and `--comfy` keep their defaults. The ssh host must reach the card as root, as the runbook's own do.

**Not known before the card.**

- Whether the kitchen's attention runs Qwen-Image 2.1's shapes and masks, how fast, and whether its pictures keep the
  scene and the people; on cu128 too, where 3 falls back.
- Whether Viggle's node works on cu130, where the CUDA backend, not Triton, runs the int8 layers its hooks wrap.
- Whether Triton reads its files back after the restart: the cache is under `/root/.triton/cache` unless
  `TRITON_CACHE_DIR` or `TRITON_HOME` says otherwise (knobs.py:342-353), and 1 and 4 run the same Triton and
  variables.
- How long the first start on cu130 takes, and whether turbo draws the same bytes on another server.
- Whether pip on the card picks the four cu130 wheels whose hashes the manifest pins: a wheel of another hash stops
  the install, and then there is neither cu130 nor the turbo row.
- Whether the ssh counts read the server's process on the card as they read a stand-in here. A card that does not
  answer them is refused before anything is drawn.
- Whether round two's card has the room, which its admission after seed 7 decides.

<a id='t-probe'></a>

## The T probe

Round one's T gave L's picture back with its edges and colours pushed, and took no face, hair or build from the
portraits. Round two draws T as it is: `T_OPENING`, `tPrompt` and the action graph do not change. The probe keeps
round one's style line, with its adult faces, since it reads T back from round one's prompts and sets its variants
beside round one's pictures ([the sheet](#the-sheet)).
[image-t-probe.ts](../local/image-t-probe.ts) draws nine variants of T from round one's own pictures and portraits of
six clean scenes at seed 7, on one card, with no text card and no new portrait, and writes a page from which the
owner picks: five are one change against T each, `mask` and `mask-each` redraw only the bound people's boxes on L, and
`face` and `face-each` only their heads and hair on A+'s picture ([the masked variants](#t-probe-masks)). Before them
it draws [the clothing test](#t-probe-suit): eight of round one's fronts again in a dark grey suit, and the demon's C
from them. After it comes [the language test](#t-probe-lang): six fronts of three made-up people, each drawn once from
an English description and once from the same description in Russian.

**What round one shows** (seed 7, the 13 clean scenes, their files and their judges' answers):

- The judges scored T as L on every item of every clean scene, contacts, gazes, clothes, looks and identity alike. C
  took looks where T took none: looks 0.03 for T against 0.60 for C, identity 0.01 against 0.34.
- T keeps L's layout, people and faces: three pairs seen side by side (the tango, the guard, the demon), and a
  normalised cross-correlation of T with L of 0.67 to 0.92 on the grey pictures, the sharpening included.
- T is processed. Its fine detail, the mean absolute high-pass of the grey picture, is 3.1 to 9.3 times L's (median
  4.3) and sits at 71 to 109 whatever L's is (8 to 35); C against L stays at 0.88 to 1.17. Saturation and contrast
  rose in all 13, and the lightness moved toward the middle: dark L's came out lighter, bright ones darker. Contrast
  alone raises that measure, so together they show a restyling, not detail added as such.
- A view is also an edit of a picture that lies on its canvas's grid, its front's, and against its front it stays at
  0.99 to 1.16 of fine detail, and in the one pair seen (the twister's second person) it turned the person as asked:
  the grid alone neither forbids a change nor sharpens.
- C, with the same portraits at the same 352x640, took looks: the portraits' size does not keep them out.
- At `resolution` 0 image 1 reaches the encoder at its own 1280x704, the canvas's size: its 80x44 latents take the
  canvas's own centred positions, and they are 3520 tokens against a portrait's 880. The pinned encode node sizes its
  latent output on the first reference "to match with sampling as any other size shifts the edit": a first picture of
  the canvas's size is edited in place.

**What is a guess**: that the grid shared with the canvas, together with an instruction that first says to keep
everything of image 1 and names the change only as "takes them from", has the model copy image 1 and restore it;
whether the sharpening and the colours are that restoration's own, the style line's, or a numerical fault of this
edit path; and how much image 1's 3520 tokens against 880 a portrait weigh in it.

| Variant | The one change against T | Expected on the faces | Risk to the action |
| --- | --- | --- | --- |
| `words` | The prompt: the change first, "Replace the face, hair, skin and build of ROLE in image 1 with those of the person in image N", one sentence a person, then T's caveat on the build and its keep list, without "Image 1 is the finished picture" | the portraits' faces in L's places, if the model edits faces by reference on an image 1 of the canvas's grid at all | low: layout, poses and contacts stay L's |
| `no-style` | T's prompt without the style line | none: it asks whether the style line gives the edges and colours | low, as T |
| `half` | Image 1 through a scale node of its own (area) to 640x352: 880 tokens, one portrait's weight, and no longer cell for cell on the canvas's grid, though still centred on it | the portraits may come through, as they do in C, though L stays a reference | high: the scene is drawn again from L's content, and framing, poses and contacts may move |
| `latent-50` | L as the sampler's start instead of image 1: VAEEncode at denoise 0.50 (σ 0.67, L's latent 0.33); the portraits alone as references from image 1, with C's prompt | faces and hair redrawn toward the portraits inside L's layout; hair colour and length in part | low to medium: hands and small contacts may be redrawn |
| `latent-70` | the same at denoise 0.70 (σ 0.83, L's latent 0.17) | more of the portraits: hair colour and length, the build | medium to high: poses and contacts may move; the framing mostly holds |
| `mask` | `latent-70` redrawing only the regions round the bound people's boxes on L, whose decoded picture is pasted into L's own pixels through them, feathered: outside them the picture is L pixel for pixel | as `latent-70`, inside the boxes alone; the place, the light and everything outside them L's | medium: poses and contacts may move inside the boxes, and a region's edge may show a seam; where the boxes fill most of the frame (the giants 98 %, the twister 89 %) it is nearly `latent-70` |
| `mask-each` | `mask` one bound person a pass, in slot order: that person's region alone, that person's portrait alone as image 1, and round one's L prompt with that person's clause alone begun as C begins it, "The person from image 1, ROLE ..."; each pass starts from the picture of the one before, the first from L | each person from their own portrait, with no mixing between people | as `mask`, and where regions overlap a later pass redraws part of a person already done (the giants' first giant holds the merchant; the flight's father, mother and girls overlap); one job a person |
| `face` | A+'s picture instead of L's, as image 1 and as the sampler's start through VAEEncode at denoise 1.0 inside a mask of the bound people's heads, pasted into A+'s own pixels; a head-and-shoulders crop of each front in the slots from 2; T's prompt with an opening that changes the faces and hair alone | the portraits' faces and hair on A+'s people; poses, contacts, clothes and builds A+'s, drawn without portraits | low for the action, which is A+'s outside the heads; the model may give image 1's faces back, as T gave L's; a seam at a head's region; hair longer than its box stays A+'s; the build does not change. The flight's A+ drew a fifth, unbound child, whose face lies partly in the father's and a girl's head regions |
| `face-each` | `face` one head a pass, in slot order: that head's region alone, that person's crop alone as image 2, and that person's clause alone, "ROLE takes them from the person in image 2"; each pass edits the picture of the one before, the first A+ | each face from its own crop | as `face`, and where head regions overlap a later pass redraws the edge of a neighbour's head; one job a person |

The σ are the pinned model's: its flux shift of mu 0.69, about 2, with KSampler at denoise d running the last 25 of
`int(25 / d)` steps. `wordsPrompt`, `facePrompt`, `probeGraph`, `startFrom`, `cropFrom`, `maskFrom` and `probePrompt`
hold the variants; the page says the same in Russian. The six scenes bind four portraits at most, as round two does,
19 people in all: the flight and the twister (4), the giants (3), the guard and the tango (2), and the demon (4). The
demon replaced the monkeys of the probe's first plan on 2026-09-26, with the owner's approval: the monkeys bound one of
five people, more than round two draws, where the demon binds all four of its own.

<a id='t-probe-masks'></a>

**The masked variants**, which the owner approved on 2026-09-26: T should not remake the whole picture, only the
people's looks. `mask` and `mask-each` redraw only the bound people's regions on L and keep L's pixels everywhere else.
`face` and `face-each` start from the picture whose action scored best and change only its heads and hair: seed 7 on
the demon, the flight, the giants and the guard gave A+ 44 contacts, 54 % build matches and 15 % face matches, L and T
38, 23 % and 0 %, and C 13, 54 % and 31 %. They send a head-and-shoulders crop of each front, since a full-length front
also carries its standing pose and its clothes into the picture: in the demon's C at seed 7 the demon wears the
portrait's white tank top. A+'s pictures of seed 7 are on disk, so nothing new is drawn for the base.

- **Boxes and crops**, marked by eye before any card on round one's clean pictures, drawn onto copies, looked at again
  and adjusted: for each of the 19 bound people a box round the whole person on L and a box round the head and hair on
  A+, and a crop of the front with the head and its hair fully inside and both shoulders, its sides at the reference
  slot's 11:20, so that the scale to 352x640 stretches nothing. A crop wide enough for the shoulders at 11:20 reaches
  the waist or the hips: 352x640 of the 720x1280 front for most people and up to 451x820 for the giant and the demon,
  and a head comes out 1.6 to 2 times as large in the slot as in the whole front. They lie in
  `illustrations/t-probe/boxes.json`, `{ "canvas": "1280x704", "L": { scene: { front: box } }, "A+": { ... },
  "crops": { front: box } }`, each box `[left, top, right, bottom]` with right and bottom exclusive; the file marked on
  2026-09-26 has sha256 9eea99d5c2dd753d…, and like everything under `illustrations/` it is not in git. `draw` requires
  the file and `probe.json` pins its hash, so that nothing changes it once
  drawing starts; before anything is sent, `draw` refuses a masked variant on a scene with a bound person unboxed or a
  box for someone it does not bind, and `face` or `face-each` for a front without a crop or with a crop off its
  picture. `page` draws the boxes, their regions and the crops over L, A+ and the fronts before the card, for the owner
  to check.
- **Regions.** A box with a margin a side, brought out to the latent's 16-pixel grid (Qwen Image 2.1's VAE takes
  1280x704 to 80x44) and kept on the canvas: 48 px for a body, for a build that grows, and 32 px for a head, for the
  hair and the neck. On that grid the pinned `reshape_mask` (comfy/utils.py), a bilinear resize to the latent, gives
  every latent cell exactly 0 or 1. The regions of the six scenes cover 46 to 98 % of the frame for `mask` (the flight
  46, the twister 89, the giants 98, the guard 72, the tango 53, the demon 62) and 8 to 31 % for `face` (20, 17, 31, 14,
  8 and 20).
- **The masks are made on the card from the numbers**, by core nodes of the pinned revision: a SolidMask 0 of the
  canvas, and for each region a SolidMask 1 of its size added at its place by MaskComposite `add`, which clamps where
  two overlap, for the sampler's mask, SetLatentNoiseMask on the start's latent; the same through FeatherMask for the
  paste's, ImageCompositeMasked of the decoded picture into the start's own upload with `resize_source` false, feathered
  24 px in for a body and 16 px for a head, and not on a side at the canvas's edge. Not an uploaded mask: the pinned
  numbers go straight into the nodes, with no PNG writer and no LoadImageMask channel to get right, and
  [fake-comfy.ts](../local/fake-comfy.ts) computes the same masks as comfy_extras/nodes_mask.py, which the dry run
  checks against every region of every job. Where the paste's mask is 0 the saved picture is the start's upload pixel
  for pixel, as long as the server keeps float32 intermediates, as gpu/image-serve.sh runs it.
- **The crops are cut on the card**: each front is uploaded whole and goes through the pinned ImageCrop
  (comfy_extras/nodes_images.py, flagged deprecated at 73c9bad4 and still registered) before its scale node.
- **Denoise**: `mask` and `mask-each` 0.70 inside the regions, `latent-70`'s; `face` and `face-each` 1.0, T's own, so
  that inside a head the start keeps nothing of A+'s face, and image 1, the crop and the pixels round the region guide
  what is drawn there.
- **Prompts.** `mask` sends round one's C, as `latent-70` does. `mask-each` sends round one's L with the pass's clause
  alone begun "The person from image 1, ", or ": " where C has no words ahead of the action, read back from round one's
  C, which is its L with one such head a bound person. `face` sends `FACE_OPENING`, "Image 1 is the finished picture.
  Keep everything in it: the place, the light, the framing, every pose, grip and contact, all clothes, and every body
  and its build. Change only the faces and hair of these people in image 1:", then T's clauses, "ROLE takes them from
  the person in image N" joined by "; ", and the style line; `face-each` the same with the pass's clause alone, bound
  to image 2.
- **Passes.** `mask-each` and `face-each` take a scene's people in slot order, each pass from the picture the one before
  saved, uploaded again. A cell begins only if all its passes can end by `--until`. If the end still comes between two
  passes, `probe.json` records the cell `partial`, and a resume goes on from its last picture, checked byte for byte
  against the record; a pass that fails ends its cell. Every pass's picture is kept, and the page shows each.

GPT-6 (Astra) read the diagnosis, the pinned sources and eleven clean pictures on 2026-09-26. It found the grid a cue
to keep image 1, not a switch into another mode, and with the instruction's weight on keeping and its indirect binding
a credible cause of the copy; C shows that the portraits can carry looks, not that they still can beside L's 3520
tokens; and a latent start is VAEEncode into the sampler, never LatentUpscale, whose /8 would double this latent, with
C's prompt and no reference of L. It does not clear the style line of the sharpening, which is why `no-style` is a
variant, and it would take the latent starts at 0.40 and 0.60 (σ 0.57 and 0.76) and keep 0.75 for later. The probe
takes 0.50 and 0.70, since 0.40 leaves 0.43 of L's latent, which we expect to hold the faces as they are, and one card
should bracket the point where they follow the portraits; a later probe can go between.

<a id='t-probe-suit'></a>

**The clothing test**, which the owner agreed on 2026-09-26, is drawn first on the same card. In round one the demon's
C at seed 7 drew the demon in his portrait's white tank top, where his scene put him in a tattered leather skirt and
iron bracers. The test asks whether a plain dark grey sleeveless suit leaks less into a scene and shows the build as
well as the tank top and trousers do. The owner's first idea, a skin-coloured suit, was turned down: the flight's sheet
holds two children, it reads as nudity, and it fixes a skin tone that may be the wrong one.

- **Eight fronts**, the demon's e1 to e4 and the flight's e1 to e4, drawn as round one drew its fronts, by the front
  graph at 720x1280 and seed 7, from round one's own prompts in the two plan.json with the clothes alone changed:
  `PORTRAIT_CLOTHES`, "wearing a plain close-fitting white tank top, close-fitting dark grey trousers and plain dark
  shoes", becomes the probe's `SUIT_CLOTHES`, "wearing a plain sleeveless close-fitting dark grey full-length one-piece
  athletic suit of matte fabric, covering the torso and legs down to the ankles, and plain dark shoes". That is the
  wording agreed for the test with "full-length" said early and "of matte fabric" added, against a swimsuit's or a
  latex suit's sheen. The look, the action and the style stay round one's. `PORTRAIT_CLOTHES` in
  [image-portraits.ts](../local/image-portraits.ts) does not change: the owner decides after seeing the result. Round
  two's fronts are being moved to a detailed portrait description in the sheet; the test keeps round one's looks, so
  that only the clothes differ.
- **The demon's C at seeds 7 and 11**, from round one's C prompt in the demon's plan.json unchanged, with the four new
  fronts in its slots at 352x640, as round one's C sent its own. Round one drew seed 7 alone, so at 11 the new C has no
  old one beside it, and the page says so.
- **The order**: the demon's four fronts, its C at 7 and at 11, then the flight's four, so that a stop leaves the
  demon's whole where it can. The test is admitted as a whole, before the scenes, since it is small and draws with the
  two graphs round one drew with, ahead of the masked variants' nodes, which are new to the card. A C whose new fronts
  are not all drawn is not sent: it is recorded `out` with `front_failed`, `front_missing` or `reference_mismatch`.
- **Refusals**, before anything is sent: round one's draw.json without its fronts' clothes, style or action; a front
  whose prompt does not carry those clothes once, the action and the style last; round one's fronts drawn under another
  front graph or canvas than today's, where `--scenes` without `suit` draws the scenes alone; and a `probe.json` whose
  test was drawn from other inputs. Its `suit.hash` pins the wording, round one's clothes, the front graph, each front's
  prompt and picture, the C's prompt and fronts, and the seeds.
- **The page** shows the test after the scenes: each of the eight fronts of round one beside its new one, then the
  demon's C of round one beside the new at seed 7, and at seed 11 the new alone under a line saying that round one has
  none.
- **The same seed under another prompt is another picture**: the new fronts may differ from round one's in face, hair
  and pose as well, and the C's comparison carries that beside the clothes.

The test is 10 jobs: eight fronts at round one's median of 15.5 s, and two C's at 20.8 s, the median of round one's C
with four portraits (with two it took 18.2 s): 2.8 minutes, 4.2 at the admission prices and 4.7 with the cold start,
which falls on its first front.

**The result**, drawn on 2026-09-26 (`illustrations/t-probe/suit/`, the `suit` of `probe.json`) and looked at by eye,
with no judge:

- The suit came out as worded on all eight fronts: sleeveless, down to the ankles, dark grey, matte and plain, with no
  zip, logo or sleeve. Faces, hair and poses stayed close to round one's.
- The build shows better than in the tank top and trousers: the legs, the hips and the waist, and the old man's belly.
  The trousers hid the men's legs.
- On the flight's two daughters it reads as a gymnast's suit, not as bare skin.
- It still leaks. The demon's C at seed 7 put him in a dark grey sleeveless top under his leather skirt, where round
  one's C put the white tank top; at seed 11 his chest is bare, as his scene says, with no C of round one to compare.
  One scene at two seeds does not show that the suit leaks less, only that its grey stands out less than the white.
- On the men the close fit outlines the groin.

The owner chose the suit on 2026-09-27. `PORTRAIT_CLOTHES` has been this test's wording since, so round two's fronts and
every portrait the bot draws wear it; a portrait kept before keeps the clothes it records. The probe keeps round one's
clothes as `ROUND_ONE_CLOTHES` for its dry run's made-up round.

<a id='t-probe-lang'></a>

**The language test** comes right after the clothing test on the same card. The owner decided on 2026-09-26 that the
bot draws a portrait from the reader's `details` exactly as written, in any language, with no translation
([portrait details](illustrations-plan.md#portrait-details)). Nothing in the project had sent a Russian description
to the image model before, and the owner agreed to check it at the next rental: does the model draw a portrait from a
Russian description as faithfully as from the same description in English?

- **Six fronts**: the three made-up people of [portrait-languages.ts](../examples/portrait-languages.ts), a girl, an
  elderly man and a young woman, each described once in English and once in Russian, sentence for sentence, in the
  order the sheet writes `details`, with marks on a named side. Each text is drawn as the bot draws a portrait:
  `portraitPrompt` unchanged, the front graph at 720x1280, seed 7. No text holds its person's name, so a person's two
  prompts differ only in the language of the text, and the probe refuses a pair that differs in more. The test draws
  fronts only, no C.
- **The order**: the clothing test, this test, then the scenes. It is admitted as a whole, only if all six can end by
  `--until`. `--scenes lang` names it alone, and without `--scenes` it is drawn with the rest. `probe.json`'s
  `lang.hash` pins the six prompts, the front graph, its canvas and the seed, and `draw` refuses a `probe.json` whose
  test was drawn from other inputs.
- **The page** shows it after the clothing test: for each person the English portrait beside the Russian, both texts
  under them. The owner looks at whether the Russian portrait follows the age, the skin, the build, the hair, the face
  and the marks, their sides included, as closely as the English one. A side is the person's own, as the sheet writes
  it: on a front, the person's left is the viewer's right.

The six were drawn on 2026-09-26 (`illustrations/t-probe/lang`). Two reviewers who read them on 2026-09-27, not the
owner, found the Russian redhead narrower, without her stocky build and her shaved side, the Russian elder fuller and
younger, and the Russian girl older. Each pair differs in more than the language, though: "white" hair and beard in
English are "седые", which allows grey, in Russian; the girl's "a child" has no Russian counterpart; and both redheads
wear the tattoo on the side the text did not ask for. One seed decides nothing about how often it happens. The same
day the owner had a reader's details retold in English before any portrait
([portrait details](illustrations-plan.md#portrait-details)), so the bot no longer draws from a Russian text.

The test is 6 jobs, each priced as one of round one's fronts: `estimate` gives it 1.5 minutes, and 2.4 at the
admission prices. The cold start falls on the clothing test, or on this test's first front where it is drawn alone. The dry run's estimate, at its made-up round's 18.7 s a front, gives it
1.9 minutes and 2.6 at the admission prices.

```sh
npm run image:t-probe -- dry-run     # seven steps, then "the dry run went as expected"
npm run image:t-probe -- estimate    # before the card: 70 cells, 96 jobs, expectedMinutes 29.9, pricedMinutes
                                     # 43.7, the clothing test's 10 of them 2.8 and 4.2 under `suit`, the
                                     # language test's 6 1.5 and 2.4 under `lang`
# boxes.json into illustrations/t-probe, then the page, where the owner checks the boxes and the crops:
npm run image:t-probe -- page        # illustrations/t-probe/index.html
npm run image:pilot -- dry-run       # the pilot's, then "the pilot's dry run went as expected"
# The probe's card, with the owner's «да» on its price and end, a picture card for two hours, the probe and the
# pilot after it: about 49 card minutes and 11 to 16, some 60 to 65 expected (estimates), billed until the termination.
SIMPLE_CHAT_RENT_DRY_RUN=1 npm run gpu:rent -- --lane pictures --qwen only --hours 2    # each offer's `session`
npm run gpu:rent -- --lane pictures --qwen only --hours 2
# The guard, gpu/ onto the card, image-bootstrap.sh, image-serve.sh and the tunnel as in the runbook above, the
# server without SIMPLE_CHAT_IMAGE_TRITON, as the probe and the pilot's `draw` ran, then:
mkdir -p illustrations/t-probe
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/t-probe/card.txt
npm run image:t-probe -- draw --until "$end"    # the clothing test, the language test, then scene by scene;
                                                # `probe` with drawn 54, suit.drawn 10, lang.drawn 6 and exit 0
# The pilot (#pilot), only with 20 minutes or more left before "$end": round two's path, then the Triton backend.
mkdir -p -m 700 illustrations/pilot
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/pilot/card.txt
npm run image:pilot -- draw --until "$end"    # each pass as it ends, then done true and the determinism verdict
# The server again, with comfy-kitchen's Triton backend: stopped as by Ctrl-C, its lock free, then started.
ssh -T simple-chat-vast 'pkill -INT -f "[C]omfyUI/main.py"; for i in $(seq 90); do flock -n /root/.simple-chat-comfy.lock true && exit 0; sleep 1; done; exit 1'
ssh -T simple-chat-vast 'SIMPLE_CHAT_IMAGE_QWEN=only SIMPLE_CHAT_IMAGE_GPU=0 SIMPLE_CHAT_IMAGE_TRITON=1 setsid -f nohup flock -n /root/.simple-chat-comfy.lock bash /workspace/simple-chat/gpu/image-serve.sh </dev/null >/dev/null 2>&1'
timeout 300 bash -c 'until curl -sf -m 5 -o /dev/null http://127.0.0.1:8188/system_stats; do sleep 2; done'
npm run image:pilot -- triton --until "$end"    # refused if Triton did not load; then done true
# The termination, as in the runbook above; then, with no card:
npm run image:t-probe -- page    # illustrations/t-probe/index.html, which `draw` also writes after each test and scene
npm run image:pilot -- report    # the pilot's numbers, for the owner's decision on Triton for round two
```

`draw` takes `--scenes` and `--variants`, comma separated, and the runbook's `--wait`, `--timeout` and `--comfy`;
`--scenes` names `suit` for the clothing test and `lang` for the language test; without `--scenes` both are drawn
with every scene, and `--variants` leaves both alone. Of `illustrations/action-1` it reads `draw.json` and `clean/`
alone, and before anything is sent it refuses a sharp id, the marker and a link on the way, which could lead into
`sealed/`; an L, an A+ or a front that is not the file round one recorded; a ComfyUI revision, weights, graph, T
opening, canvas, reference size, encoder resolution or cache device other than round one's; a `boxes.json` missing,
malformed, short of a bound person's box or crop, or changed since the first draw; a probe directory drawn under other
pins or from other inputs; and a picture `probe.json` records whose file is gone. A scene begins only if all its cells
can end by `--until`, at round one's slowest time of the like job, a quarter more and three seconds, and a resume
draws nothing again.
`illustrations/t-probe` holds `card.txt`, `boxes.json`, `probe.json` (ids, codes, sizes, counts and times, no prompt),
`<scene>/<variant>.png`, `<scene>/<variant>-<pass>.png` for `mask-each` and `face-each`, `suit/<front>.png`,
`suit/demon-s7-C.png`, `suit/demon-s11-C.png`, `lang/<person>-en.png` and `lang/<person>-ru.png`, and `index.html`: for
each scene its portraits with their crops, round one's L with the bodies and A+ with the heads, T and C, the nine
variants, each named by its change, and every pass, then the clothing test old beside new and the language test English
beside Russian with their texts, the pictures linked where they lie.

The estimate, from round one's own times of the same card:

| | minutes |
| --- | --- |
| ssh, Qwen's files, torch, the verification and the tunnel, at 300 Mbit/s (the identity run's table) | 14 |
| the clothing test at round one's medians, its first front cold: eight fronts and the demon's C with four portraits at seeds 7 and 11 | 3 (5 at the admission prices) |
| the language test at round one's median front, warm after the clothing test: six fronts | 2 (under 3 at the admission prices) |
| 54 cells in 80 jobs at round one's medians: T's for `words`, `no-style`, `face` and `face-each`, C's for the rest, with one portrait a pass for `mask-each` and two pictures for `face-each` | 25 (37 at the admission prices) |
| the page, the termination and the margin before the guard | 5 |

About 49 card minutes for the probe; `estimate` gives the draw's three parts together, 70 cells in 96 jobs,
29.9 minutes and 43.7 at the admission prices, of which the language test's 6 are 1.5 and 2.4. `draw` admits the
clothing test as a whole, 10 jobs and 4.7 minutes with the cold start, then the language test as a whole, and a scene
at its own prices, at most 15 jobs and 7 minutes (the flight, the twister and the demon), and what is not admitted
waits for a resume on the next card. [The pilot](#pilot) follows on the same card, 11 to 16 minutes more, when 20
minutes or more are left: about 60 to 65 card minutes expected in all, estimates both, under the guard's two hours.
The card is billed until its termination, not for the two hours. The next rental's plan also holds the card test of
the figure the owner agreed to on 2026-09-27, 34 pictures and about 4 minutes warm
([the card test](illustrations-plan.md#figure-card-test)); [image-figure-test.ts](../local/image-figure-test.ts) draws
it before the body test, and its texts are the retelling's, which passed its check after the one revision the check
allowed.

**Not verified without the card**: whether `words` moves any face while image 1 lies on the canvas's grid; whether
`no-style` takes the edges and colours away; where `half` puts the scene, since its 640x352 is centred on the canvas's
positions at half the scale and may come back smaller or reframed; whether 0.50 changes the faces and 0.70 keeps the
contacts; the VAEEncode start itself, whose wiring alone the fake checks; whether `mask` inside its regions follows the
portraits as `latent-70` would, whether a region's edge shows a seam, and how much a later pass of `mask-each` spoils a
person already done where regions overlap; whether `face` gives image 1's faces back, as T gave L's, whether denoise 1.0
inside a head keeps its angle and expression, whether a crop carries the tank top into the neck, and how hair longer
than its box meets A+'s; that the server keeps float32 intermediates, on which "pixel for pixel" outside the regions
rests; that the server takes the deprecated ImageCrop, where a refusal would come back as `comfy_http_error` 400 and
stop the run at the first `face`, with nothing lost; the times of `half`, the latent starts and the masked variants,
priced from C's and T's; the boxes and the crops, marked by eye; whether the suit comes out sleeveless, full length,
dark grey and plain, with no zip, logo or sleeve the words do not forbid, whether it reads as clothing on the flight's
children, whether the build shows through it as through the tank top, and whether the demon's C carries less of it
into the scene than it carried of the tank top; and whether the probe's card would draw round one's T again, since the
probe draws no T of its own: `probe.json`'s `sameServer` says whether ComfyUI, PyTorch and the card said what they
said to round one.

<a id='body-test'></a>

## The body test

The owner cares more for the silhouette, the height, the build and the proportions, and for the action, than for the
face. On 2026-09-27 the owner agreed to prepare a test of the whole body built like the head test's `p-crop-080`, the
one head variant that moved the faces and hair toward the portraits and still fitted every body in that day's blind
judgment. [image-body-test.ts](../local/image-body-test.ts) cuts each of the 19 bound people of the probe's six clean
scenes out of round one's A+ at seed 7, enlarges the crop, redraws the person with the person's full-length front as
image 1, and pastes the result back into A+. The question: does the front's build come through while A+'s action, its
contacts and the scene's clothes stay? Nothing is drawn before the card.

- **The bodies**: `illustrations/t-probe-bodies/bodies.json`, one box a person round the whole figure on A+, marked by
  eye, each holding the person's head from the probe's `boxes.json`. The script pins its sha256.
- **The crop**: the box with 32 px a side, out to the latent's grid. It takes the most upright canvas whose crop fits
  in the frame, of 576x1024 (the front's 9:16), 672x896, 896x896 and 1024x768, and is scaled bicubic to it, so each
  body gains 1.09 to 2.25 times its pixels a side. The front goes whole, area-scaled to 576x1024 for every body.
- **The masks**: the sampler redraws the region less every other head, the flight's unbound fifth person included. The
  paste goes into A+'s pixels through the region feathered 24 px inward and 8 px away from those heads, so outside the
  region and on the heads kept the picture is A+ pixel for pixel. The other people's limbs inside a region are redrawn
  with it, since the contacts lie there.
- **The prompt**: "The person from image 1", the person's own clause of round one's A+ without its look (the role, the
  facing, the scene's clothes and the action), and round one's style line. The script reads the clause back from round
  one's L, C and A+ and refuses a scene where they disagree.
- **The variants**: every body at denoise 0.65 and 0.80 with round one's front, in the white tank top and trousers,
  and the demon's and the flight's eight at 0.80 with the probe's suit front, to see whether the suit leaks into the
  scene's clothes. Seed 7, 25 steps of euler/simple at CFG 1, as `p-crop-080`.

**Its place** is the picture card after round two's draw and after [the figure-age card
test](illustrations-plan.md#figure-card-test), on the same server, tunnel and `"$end"`, five minutes before the card's
end as the runbook computes it. A body's jobs begin only if all of them can end by `--until` at the admission prices,
the fronts' 38 jobs before the suit's 8, and what is not admitted waits for a resume on a later card. `estimate` gives
46 jobs on four canvases: 6 minutes at the head test's median warm job, 7.3 s, with half a compile, and 15.4 at the
admission prices, its slowest warm job with the margin, 18.1 s, 45 s for the first compile and 15 s for each other
canvas. With 16 minutes or more left before `"$end"` all of it is admitted; the termination keeps the five minutes after
`"$end"`.

```sh
npm run image:body-test -- dry-run     # steps 0 to 14, then "the body test's dry run went as expected"
npm run image:body-test -- estimate    # before the card: 19 bodies, 46 jobs, expectedMinutes 6, pricedMinutes 15.4
npm run image:body-test -- plan        # illustrations/t-probe-bodies/plan.png: regions, crops and masks over A+
# On the card, after round two's draw and the figure-age card test, with the server, the tunnel and "$end" as they are:
ssh simple-chat-vast cat /workspace/simple-chat-gpu/image-verified.txt > illustrations/t-probe-bodies/card.txt
npm run image:body-test -- draw --until "$end"    # body by body; bodies_done with drawn 46 and exit 0
# After the termination, with no card:
npm run image:body-test -- page    # illustrations/t-probe-bodies/index.html, which `draw` also writes after each body
```

`illustrations/t-probe-bodies` holds `bodies.json`, `plan.png`, `card.txt`, `redraws.json` (ids, codes, sizes, times
and each body's crop and region, no prompt), `<scene>/<person>/<variant>.png` and `index.html`: each body's crop of A+
beside its redraws, its front and its suit front, then the whole frames. Its `judge/` holds a blind judgment, not run:
one gpt-6-astra session a scene answers, for each person, whether the build is like the front's, on A+ and on each
redraw; whether the pose, each essential contact of the scene's checklist and the scene's clothes stayed as on A+; and
whether a seam shows. The twister and the tango have no essential contact, and their pose stands for it.

**Not verified without the card**: whether the front's build comes through at either strength with the scene's words
beside it, and whether the front's standing pose comes with it, above all on the canvases whose shape is not the
front's 9:16, where the encoder does not lay the front on the canvas cell for cell; whether the other people's limbs
and the contacts inside a region survive the redraw, above all the flight's father, whose region holds every other
head; whether the tank top or the suit leaks into the scene's clothes; whether the feather hides the seam at a
region's edge and round a head kept; and the times, priced from the head test's. `draw` checks the card's `card.txt`
against round one's pins before it sends anything.
