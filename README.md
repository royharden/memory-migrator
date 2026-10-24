# Portable memory migrator

Turn selected ChatGPT conversations into a profile **you reviewed yourself**: every exported statement carries your approval and an exact quote (code-point offsets + hashes) from one of your own messages. Quotes prove the words occurred — not that they are true.

> **Status: Dirty Mode construction, 2026-10-23/24. Nothing in this repository has been installed, built, run or tested.** Source was written and statically reviewed only. See `DEVELOPMENT-STATUS.md` for exactly what is built and what has not run.

## What it does (as built in source)

- **Local mode** (default): everything stays in the tab's memory; no sign-in, no network. Load `conversations.json` (or up to 10 JSON shards, 10 MiB each / 100 MiB total) or the built-in synthetic demo. ZIP is not supported — unzip first.
- Bounded parsing in a Web Worker: active branch only (`current_node` → parents; never guessed), skipped/unsupported counts, saved-context "carriers" counted but **never imported**, cancel, Clear source.
- Conservative rules over eight slots (name, home, role, employer, likes, dislikes, health note, financial note) with eligibility filters (questions, hypotheticals, quotes, third parties, code, temporary places, personas, forget requests).
- Review: pending queue, full-state conflict groups (keep one / keep several with scope note / reject all), edits as user-authored revisions, sensitivity confirmation, erase (purges text) / hide, monotonic suppression, explicit restore, bounded Undo import, receipts.
- One export rule drives Markdown, a budgeted paste prompt, `profile.v1.json` (canonical bytes + SHA-256 checksum, strict re-import with preview/apply) and named versions with diff/redaction.
- **Account mode** (opt-in, after explicit consent): private persistence in a Supabase-compatible Postgres (Bolt Database) through SECURITY DEFINER RPCs only; uploads contain candidates, quote spans, IDs, hashes and decisions — never raw files, full messages, assistant text or custom instructions.
- Evaluation tab: runs a small synthetic held-out fixture in the browser and shows raw counts. **No quality figures are claimed.**

Large-file performance is unverified. Retrieval benchmarks are not used to claim quality.

## Develop (not yet executed)

```bash
npm install        # no lockfile yet; keep the generated one
npm run typecheck && npm run typecheck:tests
npm run test:mm    # authoritative: the new pipeline tests (constructed, never run)
npm test           # also runs the legacy Grok-era tests in tests/*.test.ts (kept, not maintained)
npm run dev
```

Public env for account mode only: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. No server or provider secrets are needed. Never put a service-role key in a `VITE_` variable.

## Layout

| Path | Role |
|---|---|
| `supabase/functions/_shared/mm/` | Pure pipeline: limits, unicode, sha256, canonical codec, parser, evidence, rules, sensitivity, groups, reducer, lifecycle, exporting, portable, versions, evaluation |
| `src/` | App, Workspace and panels, import worker, account adapter (`src/lib/account.ts`) |
| `supabase/migrations/20261023230000_profile_v1.sql` | Forward-only schema, owner-read RLS, RPCs (not applied) |
| `schemas/profile.v1.schema.json` | Portable file schema |
| `fixtures/synthetic/` | Demo export and the frozen dev/held-out evaluation fixtures (+ generators) |
| `tests/mm/` | Focused behavioural tests (not run) |

Legacy files from the first (Grok) pass — `supabase/functions/_shared/*.ts` outside `mm/`, `src/lib/remote.ts`, `src/components/{Desk,EvalPanel,AuthGate}.tsx`, `tests/*.test.ts`, `supabase/migrations/20261023180000_init.sql` and the disconnected `supabase/functions/propose-facts/` — are kept unchanged and are **not used** by the app. Do not deploy `propose-facts`.

## License

MIT (see `LICENSE`). Prior-art projects were used for ideas only; no code was copied.
