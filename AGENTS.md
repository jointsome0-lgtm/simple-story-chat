# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true.

## Improving the story system

If the owner asks you to improve prompts or memory, follow [docs/improve-loop.md](docs/improve-loop.md): what may
change, what may not, how one step is measured with `npm run eval`, and when to stop. Past steps are in
`docs/improve-log.md`.

## What this project is

A **Telegram bot for branching interactive stories** that runs locally: Node 24.9+, strict TypeScript executed
without a build step, `node:sqlite`, the ordinary Bot API over long polling. The working code is in `local/`.
Whoever runs the bot brings the model; adapters behind one interface are described in
[docs/model-providers.md](docs/model-providers.md).

- `npm start` runs the bot from `.env`; `npm run start:gpu` swaps in the model connection from `.env.gpu`.
- `npm test` needs no `npm install`, network, Telegram or model. `npm run check` (after `npm install`) type-checks
  `local/`, verifies the generated `lib/library.js` and the syntax of the cloud files.
- `local/*.ts` import each other with explicit `.ts` specifiers and use erasable syntax only. More in
  [local/AGENTS.md](local/AGENTS.md).
- `npm run eval` measures world consistency on synthetic stories; see "Improving the story system" above.

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
| `lib/library.ts`| Pure story-library logic shared by the bot and the cloud draft.   |
| `examples/`     | Synthetic seeds and eval scenarios. Safe to read and to send to models. |
| `gpu/`          | Bootstrap and start scripts for llama.cpp on a rented GPU ([docs/gpu.md](docs/gpu.md)). |
| `docs/`         | Reference docs, the improvement loop and its log.                 |
| `schema.js`, `handlers/`, other `lib/` files | The undeployed Telegram Serverless draft, see below. |
| `data/`, `backups/`, `exports/`, `logs/`, `.env*` | Local state, gitignored. See Privacy above. |
| `.tgcloud/`     | CLI state (credentials, snapshot, cached layout). **Never edit or read from here** — it's gitignored machine state. |

## The cloud draft (not deployed)

`schema.js`, `handlers/` and the hand-written JS in `lib/` are an earlier draft for Telegram's serverless platform
(V8 isolate, `tgcloud` CLI). It is not deployed and the local bot does not use it, apart from the shared
`lib/library.ts`. `lib/library.js` is generated from `lib/library.ts` by `npm run cloud:lib` and stays plain JS; edit
only the `.ts` source and regenerate. The rest of `lib/` and `handlers/` stays hand-written JS.

The platform's rules differ from Node's: modules are imported by bare name (`'schema'`, `'lib/cart'`, `'sdk'`), never
by a relative path or with an extension; there is no filesystem and no npm at runtime; every DB call is async; there
are no foreign keys; drops happen only via `.deprecated('reason')`; deploying never touches the database. Read
[docs/tgcloud-sdk.md](docs/tgcloud-sdk.md) before touching those files.
