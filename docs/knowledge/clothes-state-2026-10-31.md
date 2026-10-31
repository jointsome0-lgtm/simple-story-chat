# The clothes probe of 2026-10-31

What a person wears from one frame to the next: whether a torn sleeve, wet cloth, a lost shoe and blood stay on them
until the story ends it, and how the line of clothes should be written. On 39 synthetic scenes in ten tales with 21
people, on hosted Gemma 4 31B through OpenRouter, no card, $0.90. Each number is one chain per format at temperature
0.8, not a rate to expect. The tester's model is another build of the same weights, and no picture was drawn.

The result went into the bot as `local/picture-wear.ts` ([thing by thing](../telegram-ui.md#thing-by-thing)).

## Formats

| Name in the run | What the frame answers first | Verdict |
| --- | --- | --- |
| `now` | nothing: the bot's line, rewritten by each frame | the baseline |
| `new`, `new2` | one prose line, by scenes since the record, with what happened and what it left | second by the key |
| `free2` | the same prose written freely | worse: lines grew, stale states stayed |
| `items2` | a snapshot of things from a list written by hand | the idea, not something the bot could run |
| `rich2` | the same with a phrase for everything together | an undrawable comment, 35 calls for 24 frames against 28 |
| `events` | a list of events by thing, with whose | no gain |
| `items3`, `items4` | the list made by the model from the line | left «trousers with braces» as one thing |
| `items5`, `items6` | the list made by code, each thing on, partly or off | `items6`, with `things` last, is what the bot runs |

## Numbers

| | `now` | `new` | `items6` |
| --- | ---: | ---: | ---: |
| Shown in the frame, tales a to i, 31 scenes | 47/64 | 60/64 | 64/64 |
| Carried to the next frame, same | 38/68 | 66/68 | 68/68 |
| G shows it, same | 19/32 | 31/32 | 32/32 |
| Shown in the frame, tale j, without the one sentence below | not run | 52/53 | 56/56 |
| Mean line, characters, all 39 scenes in the last two columns | 100 | 143 | 239 |
| Output tokens, ordinary and lean frame | 297, 437 | 455, 552 | 775, 998 |
| Answers that ran into blanks and had to be asked twice | 0/62 | 0/78 | 3/78 |

The key is a set of patterns for what each scene must show. Outside tale j it flagged 6 of 40 as extra in `new` and 11
of 40 in `items6`; read by eye, 4 of 40 were real in both, a tunic buttoned over a wound, and the rest false hits. A
blind read of tale j by GPT-6 Astra at `high`, on neutral criteria and with the formats under letters, ranked `items6`,
`rich2`, `new2`, `free2`. It counted 45 errors, 39 of them the one below, which all four formats made; `items6` and
`rich2` made no other.

## What the probe found

- **The one sentence.** «Стас вцепился в подтяжку и дёрнул» does not say whose brace it is. Plain, the sliding trousers
  went to the man who pulled in 5 tries of 5; with a rule on whose a thing is, 5 of 5; with «подтяжку Глеба» in the
  story, 0 of 5. So the error comes from the sentence, and how often the bot's narrator writes such sentences is not
  known.
- **Blanks.** With a field after an empty `"things": []`, JSON mode ran into blanks to the output limit, on the same
  requests each time (one answer: 2500 tokens, 3300 blank characters). `things` last took doubled answers from 9 to 3 of 78.
- **The list has to be code's.** Asked for the list, the model left two things of one line joined whatever it was told.
  A split on commas and a few words took all 21 sheets apart right.
- **Everything off.** In both runs of one scene the model wrote all of somebody's things off and nothing on, for a
  person out of the frame who went home and changed. The port found it: read as nothing on, that line would have drawn
  them naked. Nothing on is now a thing the model has to name, which a synthetic bath house scene did, and such a record
  is otherwise dropped.
- **Back on.** A thing put back on with no word of it kept the phrase of where it had lain: trousers on a man and in his
  locker. It now keeps how it was on them.
- **A sword.** On the owner's question, two synthetic duels with two runs each, 16 frames, a master cutting the clothes
  off an opponent: in one the story says whose they are, in the other it does not and both men wear the same things. In
  all four runs the things went to the right man and the master kept his, and in the first `nothing` came where the
  story said so and not before, and a horse blanket the frame after. The one slip, in both runs of the first: a cloak
  that flew onto the master's shoulders reached his record a frame late. The sentence that failed above has the man who
  acts holding the thing; here the blow lands on the other man.
- **A ban that cost a round.** The first round forbade the body in `how`, on no word of the owner. It made the lines
  poorer and was taken out on the owner's word; wet cloth that clings is a detail like any other.

## The port

`local/picture-wear.ts` was compared with the probe's rules byte by byte on all 78 frames from the kept answers, the
sentence on nothing on set apart: 78 of 78 requests the same, and 170 of 172 lines. One of the two is the record dropped
above, the other a phrase that says the name in words of its own and now follows the name. Of the 643 things of those
answers 594 kept their name word for word, and the one other form of an old thing was its name with a phrase after a
colon, so that names are compared word for word.

Three blind reviews of the code by GPT-6 Astra at `high` found what the comparison could not: a raincoat taken for the
old coat and a dress shirt for the old dress, a coat lost from the line behind «coated with plaster» and a white shirt
behind a phrase on a black one, a viewer with no line left with no clothes, an answer with no snapshot read as nothing
having happened, a `nothing` of no clear state read as nothing on, and a name of dashes taken for a thing. All were
closed before the bot took them.

The reviews also showed that moving a thing back to its owner when it turned up on a second person, a step the port
first had, could take a person's own thing of the same name, whatever the condition. Run live, that step took the
snapped brace back in the one scene where it landed on the wrong man, and mended half of that error: the trousers
stayed wrong. It was taken out, and the case is only counted in the log (`wearCrossed`).

`worn: gone` came last, on the owner's question why a list of things taken off should have a limit when `git rm` needs
none. It is one value and one sentence more than the 78 frames measured. On the 16 frames of the duels the model used it
for shredded things, and on a last live run of three tales, 15 frames, no answer failed to parse and not one of 161
things was called gone, clothes in a locker included. The limit stays for what nothing ends, which has no such event in
a story. The last review pointed at two answers that keep a person as they were, a thing both on and gone, and
everything gone with no `nothing`. Both stay so, since in doubt a person stays dressed.

## Not known

Pictures: a long line may dilute the action, and only a card shows that. The tester's model. Branches and memory
compaction in a long story, how many stories need a list of things taken off, which holds 12 at most, and whether the
model says `gone` in a long story at all.
