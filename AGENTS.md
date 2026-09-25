# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true.

## Improving the story system

If the owner asks you to improve prompts or memory, follow [docs/improve-loop.md](docs/improve-loop.md): what may
change, what may not, how one step is measured with [`npm run eval`](docs/eval.md), and when to stop. Past steps are
in [docs/improve-log.md](docs/improve-log.md).

When you delegate: Opus subagents run at `max` reasoning effort, GPT-6 (codex) sessions at `high`; Fable and GPT-6
are kept for the steps that decide something. The owner's rule, 2026-09-21; details in the same document.

## What this project is

A **Telegram bot for branching interactive stories** that runs locally: Node 24.9+, strict TypeScript executed
without a build step, `node:sqlite`, the ordinary Bot API over long polling. The working code is in `local/`.
Whoever runs the bot brings the model; adapters behind one interface are described in
[docs/model-providers.md](docs/model-providers.md).

- `npm start` runs the bot from `.env`; `npm run start:gpu` swaps in the model connection from `.env.gpu`.
- Rented cards bill every minute, working or idle. Before renting, read the owner's rules in
  [docs/gpu.md](docs/gpu.md#while-the-cards-are-paid-for).
- `npm test` needs no `npm install`, network, Telegram or model. `npm run check` (after `npm install`) type-checks
  `local/` and `lib/`.
- `local/*.ts` import each other with explicit `.ts` specifiers and use erasable syntax only. More in
  [local/AGENTS.md](local/AGENTS.md).

## Reading the project docs

Read the working instructions for the task at hand; they are not a startup reading list. Start with the relevant heading or index and open the sections you need.

README links both working instructions and the owner's knowledge pages. Research plans, ideas and past measurements are read for a specific question. Their dates, configurations and unresolved limits matter. A historical note does not authorize a new rental, a higher budget or a publication, and does not override current rules.

When shortening a document, keep useful evidence, ideas and reasons accessible through ordinary links. Remove a substantive passage only when its replacement is identified or its error is explained. Do not move history into code comments or automatic imports to make a size count smaller.

| Task | Read |
| --- | --- |
| Setup, settings, access, backup | [setup.md](docs/setup.md) |
| A model adapter, hosted consent | [model-providers.md](docs/model-providers.md), [llama-cpp.md](docs/llama-cpp.md) |
| Telegram screens and pictures | [telegram-ui.md](docs/telegram-ui.md) |
| The agent CLI and MCP server | [agent-interface.md](docs/agent-interface.md) |
| A rental, the picture card, image privacy | [gpu.md](docs/gpu.md), from [the owner's rules](docs/gpu.md#while-the-cards-are-paid-for) |
| Prompts, memory, the eval | [improve-loop.md](docs/improve-loop.md), [eval.md](docs/eval.md) |
| The identity or a llama.cpp experiment | [identity-experiment.md](docs/identity-experiment.md), [llama-measurement.md](docs/llama-measurement.md) |

## Privacy: whose data you may read

The bot stores real people's stories in `data/`. Nested `local/AGENTS.md` is not loaded for every
assistant, so the rule lives here too.

- **Only the owner's stories may be read, and only to debug the bot.** The owner's Telegram ID is
  `SIMPLE_CHAT_OWNER_ID` in `.env`. Nobody else on the access list gave that permission. The tester's library stays
  closed even when the tester's failure is the one under investigation: the tester describes the problem and may send
  an excerpt.
- **Do not open `data/`, `backups/`, `.env` or `.env.gpu`** with file tools, `sqlite3` or a throwaway script. When you
  need a fact from them, write code that prints booleans, counts and sizes, never values. Example: whether
  `SIMPLE_CHAT_OWNER_ID` is set and is on the access list.
- **Diagnose from the technical logs in `logs/`.** A row is an event, a code and the fields that pass
  `safeErrorDetails` in `local/model-error.ts`. A row about a user request carries `actor: owner` or `actor: other`,
  never an ID. Add a new log field to that whitelist first, as an enum, a boolean or a non-negative integer.
- Test with synthetic stories. Never print credentials, story text, prompts, raw model output or raw provider errors.

`.claude/settings.json` denies the file tools these paths. It cannot see inside a subprocess, so the rule above still
applies there.

## Layout

| Path            | What it is                                                        |
|-----------------|-------------------------------------------------------------------|
| `local/`        | The bot: Telegram transport, storage, model adapters, memory, UI, eval and probes, with tests next to the code. |
| `local/agent-api.ts`, `agent-cli.ts`, `mcp.ts` | The agent interface: CLI and MCP server over a separate agent library ([docs/agent-interface.md](docs/agent-interface.md)). |
| `lib/library.ts`| Pure story-library logic: the library's types and the operations on it. |
| `examples/`     | Synthetic seeds and eval scenarios. Safe to read and to send to models. |
| `gpu/`          | Renting a card and setting up llama.cpp or ComfyUI on it ([docs/gpu.md](docs/gpu.md), [docs/llama-cpp.md](docs/llama-cpp.md)). |
| `docs/`         | Working instructions and the research notes that the README lists. |
| `docs/knowledge/` | Dated measurements, checks and the full records of past steps. |
| `data/`, `backups/`, `exports/`, `logs/`, `.env*` | Local state, gitignored. See Privacy above. |
| `.tgcloud/`     | CLI state (credentials, snapshot, cached layout). **Never edit or read from here** — it's gitignored machine state. |

## Telegram Serverless

The owner's account is on the waiting list for Telegram's serverless platform. The draft for it (`schema.js`,
`handlers/`, the JS in `lib/`, `docs/tgcloud-sdk.md`) was removed while there is no access; its last version is at
commit ea88089, to bring back from there.
