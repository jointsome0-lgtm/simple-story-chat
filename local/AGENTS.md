# Local prototype

This directory implements the owner-approved local fallback while Telegram Serverless is waitlisted. It runs on Node 24 as native strict TypeScript (`.ts` files with explicit `.ts` import specifiers, erasable syntax only, type-checked by `npm run check`), uses node:sqlite, imports the shared domain from `../lib/library.ts`, and is not deployed by tgcloud. The root scaffold's V8/SDK-only restrictions describe the cloud files, not this directory.

Do not read `.tgcloud/`. Never print credentials, story text, model prompts, raw model streams or raw provider errors in technical logs. Test with synthetic stories. Each Telegram user's library is separate; bot access does not grant permission to inspect that user's messages.

The owner delegates the native Telegram UI to Opus 5. Integrate its pure renderer here; keep storage, Telegram transport and model invocation separate. Save a completed scene before sending it, deduplicate updates, and never regenerate automatically after an uncertain delivery.

Tests: a new case goes in as a row of the table for the promise it tests, and a new test file needs a stated reason.
