# Development status

**Dirty Mode construction — runtime unverified.** Updated 2026-10-24 by S18-INT (Claude).

## Built (source only, statically reviewed by review subagents)

Packages P1–P7 of the promoted plan: bounded parser + evidence + canonical codec; rules/eligibility/sensitivity/groups/review reducer; erase/hide/restore/undo; export predicate/Markdown/prompt/portable v1/versions; local React desk with worker import; account mode (forward-only SQL migration with RPCs, lazy client, consent); synthetic evaluation fixtures, scorer and panel.

## Not run — nothing here has executed

- `npm install` (no lockfile), `tsc` (app or tests), `vitest`, `vite build`, the dev server, any browser.
- The SQL migration has never been applied; RLS, RPC transactions, idempotency and two-user isolation are unverified.
- TypeScript ↔ SQL parity (normalization/lowercasing, JSON escaping, sort order, digest bytes) is unverified; account publication blocks on a digest mismatch by design.
- Evaluation numbers do not exist until the suite or the Evaluation tab is actually run. Labels were written by the same agent as the rules; an independent audit of ≥20% of labels is pending.
- Real ChatGPT exports, large-file memory/cancel behaviour, accessibility, auth recovery/redirect settings and hosting are unverified.

Static checks used: syntax-only parse of `.ts` files (types stripped with Node's built-in, then `node --check`), plus manual/agent source review. `.tsx` files were source-reviewed only. This file does not claim any check passed beyond that.
