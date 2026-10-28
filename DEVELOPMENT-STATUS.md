# Development status

**Dirty Mode construction — runtime unverified.** Updated 2026-10-24 by S18-INT (Claude).

## Built (source only; each package statically reviewed by review subagents — see the outer STATUS.md review log for per-package verdicts)

Packages P1–P7 of the promoted plan: bounded parser + evidence + canonical codec; rules/eligibility/sensitivity/groups/review reducer; erase/hide/restore/undo; export predicate/Markdown/prompt/portable v1/versions; local React desk with worker import; account mode (forward-only SQL migration with RPCs, lazy client, consent); synthetic evaluation fixtures, scorer and panel.

## Not run — nothing here has executed

- `npm install` (no lockfile), `tsc` (app or tests), `vitest`, `vite build`, the dev server, any browser.
- The SQL migration has never been applied; RLS, RPC transactions, idempotency and two-user isolation are unverified.
- TypeScript ↔ SQL parity (normalization/lowercasing, JSON escaping, sort order, digest bytes) is unverified; account publication blocks on a digest mismatch by design.
- Evaluation numbers do not exist until the suite or the Evaluation tab is actually run. The original labels were written by the rules author. Replacement v2 labels were authored separately after the core freeze; an independent audit of ≥20% of labels is pending.
- The original v1 held-out split is **contaminated**: the fixture froze with rules/1, and rules were changed afterwards (now rules/2), including a combining-mark fix motivated by a held-out case and temporary-location/correction fixes overlapping held-out eligibility items. It is retained for regression history. A replacement heldout-v2.json was frozen on 2026-10-28 with current core source hashes and rules/2 before any extractor execution; no tuning or scoring was performed. The new split has 28 labels across six conversations and 40 eligibility sentences. Independent label audit remains pending, and neither split establishes measured quality.
- Real ChatGPT exports, large-file memory/cancel behaviour, accessibility, auth recovery/redirect settings and hosting are unverified.

Static checks used: syntax-only parse of `.ts` files (types stripped with Node's built-in, then `node --check`), plus manual/agent source review. `.tsx` files were source-reviewed only. This file does not claim any check passed beyond that.

## 2026-10-28 — v3 synthetic label revision (owner t98u)

V2 remains unchanged after independent reviewer 0094's RETURN. Active v3 adds
the missing unsupported family/minor fact and explicit intimate relationship case,
plus full pinned source evidence, code-point offsets and group reasons per label.
Scorer resolution verifies those pins and refuses ambiguous legacy quotes. The
manifest freezes current core bytes with rules/2 and chatgpt-json/1; no rules were
tuned and no extractor scoring was run. Four isolated parser/evidence regression
tests and static integrity checks passed. No app install/build, Vitest suite, SQL
or browser validation was performed. Independent v3 review is pending. The old
statements above about v2 pending audit are historical; its audit RETURN and v3
lineage are recorded in the current manifest and fixture README.

Independent v3 audit by reviewer 0094 returned after all 30 labels, five groups,
eight sensitivity cases and 40 eligibility items were inspected. The three prior
label findings are addressed, and freeze/lineage checks passed. Overall verdict
is RETURN for scorer integration: unresolved gold is omitted from denominators
instead of refusing scoring, and absent v3 source pins take legacy lookup fallback.
These issues remain open. The frozen v3 JSON is unchanged; only manifest review
status is updated. No scoring/accuracy or acceptance is claimed.
