# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true. For the full SDK reference (db, Bot API, fetch), see
[docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## Improving the story system

If the owner asks you to improve prompts or memory, follow [docs/improve-loop.md](docs/improve-loop.md): what may
change, what may not, how one step is measured with `npm run eval`, and when to stop. Past steps are in
`docs/improve-log.md`.

## What this project is

A **Telegram Mini App bot** running on Telegram's serverless platform. You write
JavaScript modules (database schema, shared library code, update handlers); the
platform runs them in a V8 isolate. The `tgcloud` CLI syncs this local project
with the bot's cloud environment — think `wrangler`/`vercel` + `drizzle-kit`.

There is no server to run locally and no `node_modules` to import from at runtime:
the only things available inside a module are the platform SDK and other modules
in this project.

## Privacy: whose data you may read

The local bot in `local/` stores real people's stories in `data/`. Nested `local/AGENTS.md` is not loaded for every
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
| `schema.js`     | Database schema — tables as **named exports**. One file, at root. |
| `lib/`          | Shared modules. Subdirectories allowed (`lib/internal/util.js`).  |
| `handlers/`     | Update handlers, **one level only**. Names match Telegram Bot API update types (`message`, `callback_query`, …). |
| `docs/`         | Reference docs (this project's, for you). Not deployed.           |
| `.tgcloud/`     | CLI state (credentials, snapshot, cached layout). **Never edit or read from here** — it's gitignored machine state. |

Only `.js` files in `schema.js`, `lib/`, and `handlers/` are deployed. Everything
else (Markdown, config, `.tgcloud/`) is local-only.

`lib/library.js` is generated from `lib/library.ts` by `npm run cloud:lib` and stays
plain JS; edit only the `.ts` source and regenerate. The remaining `lib/` and
`handlers/` files stay hand-written JS for tgcloud.

## Module system — the rules that bite

- **Import by bare module name, never a relative path or file extension.**
  The platform resolves modules by their name in the module space, not by the
  filesystem.
  - ✅ `import { users } from 'schema'`
  - ✅ `import { addItem } from 'lib/cart'`
  - ✅ `import { db, api, fetch } from 'sdk'` / `import { eq, sql } from 'sdk/db'`
  - ❌ `import { users } from './schema'` or `'../schema'` → **won't compile**
  - ❌ `import x from 'lib/cart.js'` → drop the `.js`
- **No filesystem, no npm packages** at runtime. Only `sdk` (and its submodules
  like `sdk/db`) and your own project modules exist.
- A handler module's `export default` is what the platform invokes, with the
  update's **payload** as the first argument — for `handlers/message` that's the
  `Message` (i.e. `update.message`), for `handlers/callback_query` the
  `CallbackQuery`, and so on. The full `Update` (with `update_id`) is on the
  second argument: `ctx.update`.

## Platform SDK (`import … from 'sdk'`)

- **`db`** — the database (query builder + schema DSL). Full API: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
- **`api`** — the Telegram Bot API. `api.<method>({...})` (e.g. `api.sendMessage`,
  `api.getMe`) returns the **unwrapped** result and **throws `BotApiError`** on
  failure (`import { BotApiError } from 'sdk'`; it has `.code`/`.description`/`.parameters`).
- **`fetch`** — outbound HTTP, web-`fetch`-like (`res.status/ok`, `res.json()`,
  `res.text()`, streaming via `for await`, redirects followed).

## Database — the rules that bite

Full API in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). The non-obvious parts:

- **Every DB call is async — always `await`.** `.all()`, `.get()`, `.values()`,
  `.run()`, `db.$count()` and the raw `db.run/all/get` all return Promises.
- **No foreign keys.** `.references()` and `foreignKey()` **throw at declaration**
  — the runtime runs with FKs off, so they'd be silently inert. Enforce integrity
  in application code (delete children before parents, etc.).
- **Drops happen only via `.deprecated('reason')`** on a column/table/index.
  Deleting the declaration does *not* drop anything.
- **Type changes aren't automatic** — do them by hand with `db.run(...)`.

## Deploy & migrate workflow

**Deploying never touches the database.** Schema sync is a separate, explicit step.

The CLI is a local dev-dependency, so run it with `npx tgcloud <command>` (or use
the `npm run` scripts in package.json — e.g. `npm run deploy`):

```
npx tgcloud status     # what changed locally vs the cloud
npx tgcloud push       # deploy modules to the cloud
npx tgcloud migrate    # apply schema.js changes to the database (interactive)
npx tgcloud run <module> [args]   # execute a handler server-side
npx tgcloud pull       # bring the local project in line with the cloud
npx tgcloud login      # link this project to a bot
npx tgcloud webhook    # show the bot's webhook and whether it matches your handlers
```

After you change `schema.js`, `push` reports what the DB *would* change but applies
nothing — run `npx tgcloud migrate` to actually apply it.

The platform manages the bot's webhook for you, derived from your deployed
`handlers/*`, and refreshes it on `push`. If it ever drifts — e.g. someone called
`setWebhook` with the raw bot token — `npx tgcloud webhook` shows the mismatch and
`npx tgcloud webhook sync` repairs it.
