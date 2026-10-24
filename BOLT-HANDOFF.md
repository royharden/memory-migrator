# Bolt infrastructure handoff: Portable memory migrator

Dirty Mode construction — runtime unverified. No secrets. Inventory of files in this repo. Nothing here has been installed, built, migrated, or opened in a browser.

## Target and readiness

- Repository / branch / prepared revision: local source only. No git repo and no remote were created in the wind-down close-out.
- App root: this directory (`memory-migrator`), the inner folder that would be imported.
- Database: Bolt Database (Supabase-compatible Postgres). Not connected Supabase. Not omitted: profiles, imports, messages, facts, and the audit log are per-user.
- Target: fresh empty database. Do not replace an existing populated database.
- Existing baseline / applied migrations: Unknown. The SQL file is not proof it was applied.
- Hosting: prepare only. No host was chosen.
- Publication: prepare only. Do not publish.
- Bolt action: inspect and prepare only. Provisioning is not authorized by this build.
- Status: implementation present as source, infrastructure pending. Dirty Mode construction — runtime unverified.
- Owner prerequisites: GitHub access if importing later, a Bolt Database connection, and optional extractor secrets. No account was created here.

## Build and connection

| Item | Exact command or configuration name |
|---|---|
| Runtime / package manager | Node >= 20, npm. No lockfile in the repo. |
| Frozen install / dev | Not run. After a lockfile exists: `npm ci` then `npm run dev`. Until then: `npm install` is still outstanding. |
| Build / output | `npm run build` (`tsc --noEmit` then `vite build`). Output directory would be `dist`. Not run. |
| Type/lint/tests | `npm run typecheck`, `npm test` (`vitest run`). Not run. Hand trace only; that is not a pass. |
| Client file / public env names | `src/lib/supabase.ts`. `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. No values. |
| Missing config behavior | Setup text plus an explicit **Use local demo** control. The demo keeps state in the tab and does not invent a cloud session. |

## Database

| Order | Exact migration file | Resources / dependencies | Applied status |
|---|---|---|---|
| 1 | `supabase/migrations/20261023180000_init.sql` | `profiles`, `imports`, `messages`, `facts`, `audit_log`; RLS using `auth.uid()`; new-user profile trigger; private `memory-exports` bucket (50 MB, JSON) and owner object policies | pending |

- Access model: private per signed-in user. No anonymous read or write. Facts are updated in place for review; deletes are tombstones (`status = tombstoned`), not SQL deletes. Audit rows are insert-only.
- Ownership checks: `user_id = auth.uid()` on every policy. Storage object name must start with the user id folder.
- Extensions/RPC permissions/Realtime: Not required. No `pg_cron`, `pg_net`, pgvector, or Realtime publication.
- Seeds: Not required. The labelled sample is a JSON fixture in `src/fixtures/labelled-set.json`, not SQL.
- Retry rule: inspect migration tracking, apply only this pending file, preserve existing data. Do not drop and recreate.

## Functions

| Name / source | Caller + auth | Input / output | Resources + secret names | Deploy config |
|---|---|---|---|---|
| `propose-facts`; `supabase/functions/propose-facts/index.ts` | Signed-in user JWT. Gateway `verify_jwt = true` and `auth.getUser()`. An anon key is not a user. | POST `{ importId }` or `{ dryRun: true, messages }`. Optional `mode`: `rules` (default) or `llm`. Returns `{ facts, conflicts, dropped, events }` or `{ error, message, secret? }`. | Reads `imports` and `messages`. Upserts `facts`. Inserts `audit_log` extract rows. Rules mode uses no provider. LLM mode uses `MEMORY_EXTRACT_API_KEY` and `MEMORY_EXTRACT_URL`. Platform `SUPABASE_URL` and `SUPABASE_ANON_KEY`. No service-role key. | `supabase/config.toml` sets `verify_jwt = true`. Shared code is `supabase/functions/_shared/`. Confirm the deploy bundle includes that folder. |

- CORS/preflight: `OPTIONS` returns 204. `POST` allows `authorization`, `x-client-info`, `apikey`, `content-type`.
- Identity/ownership and abuse controls: the user-scoped client loads the import. Another user's import looks missing. Rules cap: 2000 messages, 20,000 characters each. LLM cap: 30 messages, one fetch, 20 second abort, no retry. Provider quotes that are not an exact slice of the cited user message are dropped.
- Paid API limits: one provider call per LLM request when both secrets exist. Rules mode makes no paid call. Not required for the demo path.
- Webhooks: Not required.
- Platform credentials: `SUPABASE_URL`, `SUPABASE_ANON_KEY` injected for the function. Never copy another project's values.

## Server secrets to enter through settings

| Name | Consumer | Required / optional | Owner source |
|---|---|---|---|
| `MEMORY_EXTRACT_API_KEY` | `propose-facts` LLM mode only | Optional. Rules mode does not read it. | Owner's extractor account. No value in the repo. |
| `MEMORY_EXTRACT_URL` | `propose-facts` LLM mode only | Optional, and required before any LLM call if the key is set. | Owner's extractor endpoint. No default vendor URL. |

Missing-secret behavior: HTTP 503 `{ error: "missing_secret", secret, message }` and no invented facts. Missing `SUPABASE_URL` or `SUPABASE_ANON_KEY` returns 500 `missing_platform_env` and writes nothing.
Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` belong in frontend env. Backend secrets never use a `VITE_` prefix.

## Auth, storage, and external steps

- Auth providers/confirmation: email and password in `src/components/AuthGate.tsx`. If sign-up returns no session, the UI says to confirm email and does not invent one.
- Site URL and callback/recovery routes: not built. Set the Bolt Auth Site URL and redirect allowlist after a host exists. There is no password-recovery page.
- Buckets: `memory-exports`, private, 52,428,800 bytes, MIME `application/json`, `text/json`, `text/plain`. Object path `{userId}/{importId}.json`.
- Realtime: Not required.
- Scheduled/long jobs: Not required.
- Outside services: an extractor account only if LLM mode is turned on. The demo path is the rules engine.
- Real integrations: `propose-facts` rules path and Supabase auth/storage/database when provisioned. Explicit demos: **Use local demo** (in-memory, labeled). LLM fetch is implemented and was not called.

## Acceptance checks and receipts

Use synthetic data and authorized accounts. Unexecuted checks stay pending.

| Check | Expected result | Outcome / receipt |
|---|---|---|
| Import/install/build | Frozen install and `npm run build` pass | Pending. No lockfile, no install, no build. |
| Schema | `20261023180000_init.sql` applied on the intended database | Pending. File only. |
| Function round trip | Signed-in `propose-facts` returns the rules contract | Pending. Function was not deployed or invoked. |
| Auth/isolation | No JWT fails. User B cannot read or write user A facts or storage objects. | Pending. Policies are source only. |
| Missing secret | LLM mode without `MEMORY_EXTRACT_API_KEY` returns `missing_secret` and no facts | Pending. Gate is source only. Not invoked. |
| Uploads, if needed | Raw JSON in `memory-exports` is readable only by that user | Pending. Client upload is written. Not executed. |
| Webhooks, if needed | Not required | Not required |
| Jobs, if needed | Not required | Not required |
| Publish, if requested | Not requested | Not run |

## One prompt after GitHub import

### Inspect and prepare only

> Read BOLT-HANDOFF.md and inspect the imported source at the intended branch/revision. Compare proposed resources with implemented files, reconcile unknown migration baselines through read-only history/schema inspection when access is available, and report concrete deployment gaps and owner/external blockers. Preserve the app design and existing database/data. Prepare a reviewable setup plan with actual file/resource names and pending checks. Do not create or change cloud resources, apply migrations, deploy functions, enter secrets, enable schedules, or publish. Do not describe proposed resources or unexecuted checks as complete.
