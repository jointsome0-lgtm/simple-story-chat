# simple-story-chat

Interactive stories in Telegram. A seed sets the world and the character, the model writes a scene, and the user answers with an action, a line of dialogue or an author's instruction. The text appears gradually and supports Markdown. Every scene starts with the date and time inside the world.

The project provides the interface and the generation mechanics: seeds, a tree of branches with checkpoints, continuing from any scene, compaction of old scenes into memory, and an eval that measures whether the system keeps the world consistent. The model is brought by whoever runs the bot: a Claude Code subscription, their own llama.cpp server with any GGUF model (including one on a rented GPU) or, with explicit consent, a hosted API. What to write and how is decided by that person and their model. The bot adds no content filters of its own and does not weaken the ones the model has.

The bot runs locally on Node 24 and SQLite through the ordinary Bot API. The default model is Haiku through an
installed Claude Code. The interface is in Russian, English, Chinese, Korean or Japanese, chosen with `/language`. The
last three were translated by a model and no native speaker has reviewed them yet
([languages](docs/telegram-ui.md#interface-language)). The language of a story is up to its author. Opus 5 designed
and wrote the Telegram interface; the concept was discussed earlier with Fable 5.1.

## Start

You need Linux, Node 24.9+, `flock`, an installed Claude Code with a valid sign-in, and the token of an ordinary
Telegram bot.

```sh
cp -n .env.example .env
chmod 600 .env
# Fill in .env locally.
npm start
```

Then send the bot `/start`. `npm test` needs no `npm install`, network, Telegram or model, and keeps its data in a
temporary directory. `npm run check`, after `npm install`, checks the strict TypeScript types.

## Working instructions

Open the one for the task at hand.

- [Setup, settings and backup](docs/setup.md)
- [Model connections and the consent to a hosted API](docs/model-providers.md)
- [The Telegram interface and pictures](docs/telegram-ui.md)
- [The agent CLI and MCP server](docs/agent-interface.md), for stories without Telegram
- [Renting cards and the picture card](docs/gpu.md)
- [The loop for improving prompts and memory](docs/improve-loop.md), [the eval's commands](docs/eval.md) and
  [the decisions taken](docs/improve-log.md). The open scenarios are published as
  [a dataset](https://huggingface.co/datasets/Teadomi/simple-story-chat-eval) whose card lists the known limitations of
  the scores.
- [llama.cpp on a rented GPU](docs/llama-cpp.md) and [how to compare its profiles](docs/llama-measurement.md), while
  the bot still runs it
- [The identity measurement](docs/identity-experiment.md): its protocol, and the run of 2026-09-25, where neither arm
  with portraits passed
- [The action measurement](docs/action-experiment.md): its protocol, for scenes where several people touch, with
  portraits, views and the bot's own text path; not run yet

## Ideas, measurements and decisions

These pages keep the evidence and the reasons behind decisions. They are dated research, not a list of approved work. Current instructions are linked above.

| Question | Where to look |
| --- | --- |
| Why is the narrator's rule at the end of the request? | [The accepted comparison](docs/knowledge/improve-runs.md#narrator-rule-2026-09-19) |
| Why did counters fail, and what could be tried instead? | [Results and failure modes](docs/knowledge/improve-runs.md#counters-2026-09-18), [ideas A–N](docs/storyworm-ideas.md#candidates) |
| What have we already tried on prompts and memory? | [Decision index](docs/improve-log.md), [full runs](docs/knowledge/improve-runs.md) |
| What do walk and the gold tree measure, and what remains unfinished? | [The first tree and its limits](docs/knowledge/improve-runs.md#gold-v1-2026-09-23), [the owner's v2 decisions](docs/improve-loop.md#gold-v2) |
| How were experiment cost, sample size and noise estimated? | [Cost model](docs/eval-economics-proposal.md#cost-model), [assumptions](docs/eval-economics-proposal.md#power-and-assumptions), [critique](docs/eval-experiments-plan.md#critique) |
| Which proposed optimizations were unsupported or cost more than they saved? | [The experiment plan and its critique](docs/eval-experiments-plan.md#critique) |
| What helped pictures match scenes, and what still went wrong? | [The six description and image steps](docs/illustrations-plan.md#description-steps) |
| Why a fixed style, separate clothes and an editable picture prompt? | [Style decisions](docs/illustrations-plan.md#style-decisions), [clothes](docs/illustrations-plan.md#clothes-decisions), [prompt variants](docs/illustrations-plan.md#prompt-variant-decision) |
| Will a portrait preserve both a face and a figure across scenes? | [The research question](docs/illustrations-plan.md#qwen-choice), [the run of 2026-09-25](docs/identity-experiment.md#result-2026-09-25), [its protocol](docs/identity-experiment.md#identity-runbook) |
| What did GPU measurements establish about cache, pool size and failures? | [GPU measurements and their limits](docs/knowledge/gpu-measurements.md#pool-2026-09-20), [SSH failures](docs/knowledge/gpu-measurements.md#ssh-failures) |
| Which model connections were actually checked, and which were only tested with fakes? | [Dated checks](docs/knowledge/provider-checks.md), [the current gateway boundary](docs/model-providers.md#simple-serving-our-gateway) |

## Limitations

- A 65536 window was checked with an input of about 59K tokens on an RTX 5090. This does not prove that facts survive
  across the whole window ([the check](docs/knowledge/gpu-measurements.md#verified-2026-09-17)).
- Compaction failures are not fully eliminated yet. An error log and progress reporting were added; a repeated check on
  a GPU with several compactions in a row is still unfinished. Switching between GPU instances is not implemented yet.
- The seed, the accumulated memory or the last scenes kept whole can fill the window by themselves; in that case the
  bot stops and keeps the archive ([context and memory](docs/model-providers.md#memory-and-context)).
- The computer and the process must stay on while the bot runs. An interrupted generation does not repeat by itself.

## Privacy

Every allowed Telegram ID has a separate library. The access list is set in `SIMPLE_CHAT_ALLOWED_USER_IDS`; an empty
list does not open the bot to everyone. The bot accepts messages only in private chats.

The owner allowed their own messages to be read for setting up and debugging this bot. The permission does not extend
to the tester or to other users on the access list ([the rule](AGENTS.md#privacy-whose-data-you-may-read)). The tester
reports problems and may send a chosen excerpt; developers and assistants do not open the tester's stories for
diagnosis.

The bot stores messages in order to continue a story and passes the context to the chosen model. `.env`, `data/`,
databases, exports, backups and logs are excluded from Git. Technical logs contain only statuses, error codes, sizes
and counters, without seeds, messages or raw provider answers. A log row about a user request is marked `actor: owner`
or `actor: other`, never with the user ID. The administrator of the machine technically has access to the storage;
this is not end-to-end encryption against the owner of the server.

## License

The code is under [MIT](LICENSE). The synthetic stories and scenarios in `examples/` were written for this project and are distributed under the same terms; in the Hugging Face dataset they are under CC BY 4.0 (the license is stated in the dataset card).
