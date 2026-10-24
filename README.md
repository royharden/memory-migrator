# Portable memory migrator

A review desk that turns a ChatGPT export into a portable profile. Each fact keeps the conversation id, message id, and the exact quote it came from. You confirm, edit, or delete before anything is exported.

This repository was built in Dirty Mode. The parser, extractor, conflict rules, and labelled score have been traced by hand. They have not been executed. `npm install` has not been run, and there is no lockfile yet.

## What you can do

1. Load `conversations.json` or sharded `conversations-NNN.json` (unzip the ChatGPT export first). Or load the built-in synthetic sample.
2. Extract explicit self-statements: name, residence, move, job, employer, likes, dislikes, an allergy note, and a salary note. Assistant, system, tool, hidden, and inactive-branch messages are not mined.
3. Review old-versus-new conflicts. An explicit move supersedes the older row and keeps it. Any other clash waits for keep newer, keep older, or keep both.
4. Health, intimate, and financial hits stay out of the export until you confirm them.
5. Edit or delete. Delete writes a tombstone. A later extract does not bring that fact back.
6. Download Markdown, a pasteable prompt of confirmed facts, and a JSON bundle. Tombstones win over a fact with the same id. The bundle is not a MacPaw `.mem` file.
7. Read the hand-labelled precision, recall, and provenance invariant for the synthetic fixture.

The source kind is always mined history. ChatGPT's saved-memory field is not read, because that blob is not reliably present in the export.

## Local demo and saved profile

Without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, choose **Use local demo**. The desk runs in the tab and is discarded on refresh. It does not pretend a database is connected.

With those public values, sign in. Extraction calls the `propose-facts` function, which re-derives facts from the stored messages. The function rejects a missing user session. It does not accept a list of facts from the browser.

LLM mode is optional and off the demo path. It runs only when both `MEMORY_EXTRACT_API_KEY` and `MEMORY_EXTRACT_URL` are set as function secrets. If either is missing, the function returns an error and does not invent facts. Those names must not use a `VITE_` prefix.

## Scripts

From this directory, after a later install:

```bash
npm install
npm test
npm run typecheck
npm run dev
npm run build
```

None of those commands were run for this build.

## Layout

- `supabase/functions/_shared/` is the pure pipeline shared by the app and the tests.
- `supabase/functions/propose-facts/index.ts` is the HTTP shell.
- `supabase/migrations/20261023180000_init.sql` is the Bolt Database migration.
- `src/fixtures/labelled-set.json` is the hand-labelled synthetic chat.
- `BOLT-HANDOFF.md` is the provisioning inventory.

## Limits

The rules engine only sees the patterns listed above. It will miss paraphrases. One export is capped at 2000 messages and 20,000 characters each. LLM mode, if configured later, caps a call at 30 messages and one request. Zip uploads, Claude exports, account erasure, and `.mem` conformance are not in this version.
