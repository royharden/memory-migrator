# Bolt infrastructure handoff: Portable memory migrator

Dirty Mode construction — runtime unverified. No secrets. Updated 2026-10-24 (S18-INT rebuild). The previous version of this file is in git history (baseline commit `bf48dc9`).

## Target and readiness

- Repository: local git only (`main`), no remote. Nothing pushed or published.
- App root: this directory (inner `memory-migrator`).
- Database: **Bolt Database** (Supabase-compatible Postgres + Auth) — intended, not provisioned. If a real connection already exists, preserve it; do not create a second project or replace a populated target.
- Bolt action now: **inspect and prepare only.** Git import, provisioning and publication are separate, not-yet-authorized actions.

## Build

| Item | Value | State |
|---|---|---|
| Runtime / package manager | Node >= 20, npm | no lockfile yet |
| Install | `npm install` once (then keep lockfile; `npm ci` afterwards) | not run |
| Checks | `npm run typecheck`, `npm run typecheck:tests`, `npm run test:mm` | not run |
| Build / output | `npm run build` → static `dist/` (single page, no client routes) | not run |
| Public env (account mode only) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | names only |

Local mode needs no env and makes no network requests.

## Database resources (constructed / pending / verified)

| Resource | State |
|---|---|
| `supabase/migrations/20261023180000_init.sql` (legacy Grok baseline) | constructed earlier; **apply history unknown**; bytes preserved |
| `supabase/migrations/20261023230000_profile_v1.sql` (forward-only: revokes legacy writes/raw-upload policies, adds `mm_*` tables, owner-read RLS, SECURITY DEFINER RPCs) | constructed; not applied |
| RPCs: `mm_ensure_profile`, `mm_apply_import_plan`, `mm_review`, `mm_resolve_group`, `mm_delete_fact`, `mm_restore_fact`, `mm_undo_import`, `mm_publish_version` | constructed; not executed |
| Storage buckets | **none used by the MVP.** But applying the ordered migrations creates one: `init.sql` inserts the legacy `memory-exports` bucket and policies, and the forward migration then leaves it read/delete-only (no uploads). On a fresh target this is an empty unused bucket; removing it needs a separate, explicitly approved migration. |
| Edge functions | **none for MVP**. `supabase/functions/propose-facts` is legacy, disconnected — **do not deploy**; if already deployed in a target, disable it |
| Realtime, cron, vectors, paid/external APIs | none |

Before applying: inspect the target's real migration history read-only. The forward migration expects the legacy tables from `init.sql` to exist (it revokes their grants and drops their write policies), so on a fresh target both files run in order — which also creates the empty `memory-exports` bucket noted above. If `init.sql` was already applied, apply only the forward migration on top. If the owner wants no legacy objects on a fresh target, that needs a separately approved rewrite of the baseline, not done here.

## Auth settings to confirm later

Email/password sign-up, email confirmation, password recovery (`resetPasswordForEmail` redirects to the site origin), Site URL and redirect allow-list for the eventual host.

## Deferred validation (owner of each: next authorized validation phase)

Install + typecheck + tests + build; TS↔SQL digest/normalization parity (golden vectors); RLS with anonymous and two real users; concurrent delete/import, stale revisions, idempotent retry and payload-mismatch; erase residue search across every table and the request log; version publish/redaction; network inspection (local mode zero requests, account mode quotes only); auth recovery/session refresh without losing edits; accessibility and XSS checks; large-file memory/cancel measurements; independent audit of ≥20% of evaluation labels.

## Bolt prompt (inspect and prepare only)

> Import this repository for inspection only. Do not provision, migrate, deploy or publish. Report: the target database's existing migration history (read-only), whether `memory-exports` storage or a `propose-facts` function already exists, and what the static build would need. Wait for explicit approval before any change.
