# Local prototype

This directory implements the owner-approved local fallback while Telegram Serverless is waitlisted. It runs on Node 24 as native strict TypeScript (`.ts` files with explicit `.ts` import specifiers, erasable syntax only, type-checked by `npm run check`), uses node:sqlite, imports the shared domain from `../lib/library.ts`, and is not deployed by tgcloud.

Do not read `.tgcloud/`. Never print credentials, story text, model prompts, raw model streams or raw provider errors in technical logs. Test with synthetic stories. Each Telegram user's library is separate; bot access does not grant permission to inspect that user's messages.

The owner delegates the native Telegram UI to Opus 5. Integrate its pure renderer here; keep storage, Telegram transport and model invocation separate. Save a completed scene before sending it, deduplicate updates, and never regenerate automatically after an uncertain delivery.

Tests: fewer, not more (the owner, 2026-09-25). A check stays or goes in only where a failure would cost money (a card or a request left running, a loop without a bound), leak something (a key, a story, a prompt, a sealed scene) or lose data without anyone noticing, one check per such risk. The rest is left to tsc, the dry runs and the bot's own use, and a mutant that survives is no reason for a check by itself. A new case goes in as a row of the table for the promise it tests, and a new test file needs a stated reason.
