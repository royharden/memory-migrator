import { canonicalize } from "./canonical.ts";
import { evidenceKey, evidenceShapeErrors } from "./evidence.ts";
import { isCurrentClaim, openGroupMembers, recomputeGroups } from "./groups.ts";
import { LIMITS } from "./limits.ts";
import {
  appendEvent,
  currentRevision,
  identityKey,
  isSuppressed,
  linksFor,
  openRestoration,
  renderAssertion,
  uniqueSorted,
  type Candidate,
  type Ctx,
  type EvidenceLink,
  type Generation,
  type ImportRecord,
  type ProfileState,
  type Revision,
  type SupersedeReason,
} from "./model.ts";
import { classifyCandidate, mergeSensitivity } from "./sensitivity.ts";
import { sha256Hex } from "./sha256.ts";
import { codePointLength } from "./unicode.ts";

/**
 * Local state reducer (PLAN §5, §8). Pure: every function returns a new state.
 * A real change bumps `revision` and appends id-only events; a no-op returns the
 * input state unchanged. The account RPCs implement the same transitions in SQL.
 */

export type Result = { ok: true; state: ProfileState; changed: boolean } | { ok: false; code: string; message: string };

export function fail(code: string, message: string): Result {
  return { ok: false, code, message };
}

function done(before: ProfileState, after: ProfileState): Result {
  return { ok: true, state: after, changed: after !== before };
}

/** Deep copy of plain JSON state (no functions, Maps or undefined-sensitive values). */
export function cloneState(state: ProfileState): ProfileState {
  return JSON.parse(JSON.stringify(state)) as ProfileState;
}

function bump(state: ProfileState): ProfileState {
  return { ...state, revision: state.revision + 1 };
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

// ---------------------------------------------------------------------------
// Candidate import (source extraction): preview -> explicit approval -> commit
// ---------------------------------------------------------------------------

export interface ImportCounts {
  candidates: number;
  created: number;
  attached: number;
  unchanged: number;
  suppressed: number;
  rejectedKept: number;
  reattachedSuperseded: number;
  invalidEvidence: number;
  openGroups: number;
}

export interface ImportPreview {
  baseRevision: number;
  fingerprint: string;
  importId: string | null;
  counts: ImportCounts;
  /** Fully computed next state; committed only if the profile is still at baseRevision. */
  next: ProfileState;
  noop: boolean;
}

/** Fingerprint of a candidate set: identities + evidence occurrences, order-independent, payload-free. */
export function candidateFingerprint(candidates: Candidate[]): string {
  const rows = candidates.map((c) => `${identityKey(c.slot, c.value, c.polarity)}|${evidenceKey(c.evidence)}`);
  return sha256Hex(canonicalize(uniqueSorted(rows)));
}

function findLiveByKey(state: ProfileState, key: string): Generation | undefined {
  return Object.values(state.generations).find((g) => g.lifecycle === "live" && g.aliasKeys.includes(key));
}

function hasLink(state: ProfileState, generationId: string, key: string): boolean {
  return Object.values(state.links).some((l) => l.generationId === generationId && l.evidenceKey === key);
}

export function previewCandidateImport(state: ProfileState, candidates: Candidate[], ctx: Ctx, parserVersion: string | null): ImportPreview | { error: string } {
  if (candidates.length > LIMITS.maxCandidatesPerImport) {
    return { error: `This import has ${candidates.length} candidates; one import can apply at most ${LIMITS.maxCandidatesPerImport}. Narrow the selection or split it into separate imports.` };
  }
  const counts: ImportCounts = { candidates: candidates.length, created: 0, attached: 0, unchanged: 0, suppressed: 0, rejectedKept: 0, reattachedSuperseded: 0, invalidEvidence: 0, openGroups: 0 };
  const fingerprint = candidateFingerprint(candidates);
  const importId = ctx.newId();
  let draft = cloneState(state);
  const record: ImportRecord = { id: importId, kind: "source", fingerprint, parserVersion, counts: {}, appliedAt: ctx.now, undone: false, createdGenerations: [], addedLinks: [] };

  for (const c of candidates) {
    if (evidenceShapeErrors(c.evidence).length > 0) {
      counts.invalidEvidence += 1; // bad citations never fall back; they are counted
      continue;
    }
    const key = identityKey(c.slot, c.value, c.polarity);
    const ek = evidenceKey(c.evidence);
    const restoration = openRestoration(draft, key);
    let target: Generation | undefined = restoration ? draft.generations[restoration.generationId] : undefined;
    if (!target) {
      if (isSuppressed(draft, key)) {
        counts.suppressed += 1;
        continue;
      }
      target = findLiveByKey(draft, key);
    }
    if (target) {
      if (hasLink(draft, target.id, ek)) {
        counts.unchanged += 1;
        continue;
      }
      const link: EvidenceLink = { linkId: ctx.newId(), generationId: target.id, evidenceKey: ek, evidence: c.evidence, importId, addedAt: ctx.now };
      draft.links[link.linkId] = link;
      record.addedLinks.push(link.linkId);
      // Sensitivity covers every included quote, not the assertion only: a newly
      // attached sensitive quote raises the class and voids earlier confirmation.
      const sensitivity = mergeSensitivity(target.sensitivity, c.sensitivity);
      const raised = sensitivity.length > target.sensitivity.length;
      const updated: Generation = {
        ...target,
        firstSeen: earliest(target.firstSeen, c.evidence.sourceTime),
        lastSeen: latest(target.lastSeen, c.evidence.sourceTime),
        sensitivity,
        sensitivityConfirmedRevision: raised ? null : target.sensitivityConfirmedRevision,
      };
      if (updated.superseded) {
        // A new occurrence of a displaced claim re-enters review: the group reopens; nothing is decided automatically.
        updated.superseded = null;
        updated.approvedRevision = null;
        if (updated.review === "approved") updated.review = "pending";
        counts.reattachedSuperseded += 1;
      }
      if (updated.review === "rejected") counts.rejectedKept += 1;
      draft.generations[target.id] = updated;
      counts.attached += 1;
      continue;
    }
    const id = ctx.newId();
    const revision: Revision = {
      revision: 1,
      slot: c.slot,
      value: c.value,
      polarity: c.polarity,
      changeCue: c.changeCue,
      assertion: c.assertion,
      userAuthored: false,
      ruleId: c.ruleId,
      extractorVersion: c.extractorVersion,
      createdAt: ctx.now,
    };
    draft.generations[id] = {
      id,
      origin: null,
      revisions: [revision],
      currentRevision: 1,
      review: "pending",
      approvedRevision: null,
      lifecycle: "live",
      superseded: null,
      sensitivity: c.sensitivity,
      sensitivityConfirmedRevision: null,
      aliasKeys: [key],
      firstSeen: c.evidence.sourceTime,
      lastSeen: c.evidence.sourceTime,
      scopeNote: null,
      createdAt: ctx.now,
      restoredFrom: null,
    };
    const link: EvidenceLink = { linkId: ctx.newId(), generationId: id, evidenceKey: ek, evidence: c.evidence, importId, addedAt: ctx.now };
    draft.links[link.linkId] = link;
    record.createdGenerations.push(id);
    record.addedLinks.push(link.linkId);
    counts.created += 1;
  }

  if (counts.created + counts.attached === 0 || state.appliedFingerprints.includes(fingerprint)) {
    return { baseRevision: state.revision, fingerprint, importId: null, counts, next: state, noop: true };
  }
  draft = recomputeGroups(draft, ctx);
  counts.openGroups = Object.values(draft.groups).filter((g) => g.state === "open").length;
  record.counts = { ...counts };
  draft.imports = [...draft.imports, record];
  draft.appliedFingerprints = [...draft.appliedFingerprints, fingerprint];
  draft = appendEvent(bump(draft), "import_applied", [importId], ctx.now, { created: counts.created, attached: counts.attached, suppressed: counts.suppressed });
  return { baseRevision: state.revision, fingerprint, importId, counts, next: draft, noop: false };
}

/** Commit a preview only if nothing changed since it was built (stale previews must be rebuilt). */
export function commitPreview(state: ProfileState, preview: ImportPreview): Result {
  if (preview.noop) return done(state, state);
  if (state.revision !== preview.baseRevision) {
    return fail("stale_preview", `The profile changed (revision ${state.revision}, preview built at ${preview.baseRevision}). Build a new preview.`);
  }
  return done(state, preview.next);
}

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------

function liveGeneration(state: ProfileState, id: string): Generation | Result {
  const g = state.generations[id];
  if (!g) return fail("not_found", `No fact ${id}.`);
  if (g.lifecycle !== "live") return fail("not_live", "Hidden or erased facts cannot be reviewed.");
  return g;
}

function isResult(value: Generation | Result): value is Result {
  return "ok" in value;
}

export function hasValidEvidence(state: ProfileState, id: string): boolean {
  return linksFor(state, id).some((link) => link.evidence !== null && evidenceShapeErrors(link.evidence).length === 0);
}

export function approve(state: ProfileState, id: string, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.superseded) return fail("superseded", "This fact was displaced in a resolved conflict.");
  // A rejected fact is outside the claim set; approving it directly would skip group recomputation.
  if (g.review === "rejected") return fail("rejected", "Move this rejected fact back to pending first; conflicts are re-checked then.");
  if (openGroupMembers(state).has(id)) return fail("open_group", "Resolve the conflict group before approving this fact.");
  if (!hasValidEvidence(state, id)) return fail("no_evidence", "A fact needs at least one valid supporting quote before approval.");
  if (g.review === "approved" && g.approvedRevision === g.currentRevision) return done(state, state);
  const generations = { ...state.generations, [id]: { ...g, review: "approved" as const, approvedRevision: g.currentRevision } };
  return done(state, appendEvent(bump({ ...state, generations }), "approve", [id], ctx.now));
}

/** Bulk approval affects ordinary (non-sensitive) facts only; sensitive approval is per item. */
export function approveSelected(state: ProfileState, ids: string[], ctx: Ctx): { state: ProfileState; approved: string[]; skipped: string[] } {
  let current = state;
  const approved: string[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const g = current.generations[id];
    if (!g || g.sensitivity.length > 0) {
      skipped.push(id);
      continue;
    }
    const result = approve(current, id, ctx);
    if (result.ok) {
      if (result.changed) approved.push(id);
      current = result.state;
    } else skipped.push(id);
  }
  return { state: current, approved, skipped };
}

/** Rejection excludes but does not erase. */
export function reject(state: ProfileState, id: string, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (openGroupMembers(state).has(id)) return fail("open_group", "Use the conflict group's reject-all or keep decision.");
  if (g.review === "rejected") return done(state, state);
  let next: ProfileState = { ...state, generations: { ...state.generations, [id]: { ...g, review: "rejected", approvedRevision: null } } };
  next = recomputeGroups(next, ctx);
  return done(state, appendEvent(bump(next), "reject", [id], ctx.now));
}

/** Un-reject: back to pending, then full-state groups are recomputed (it may join or open a conflict). */
export function unreject(state: ProfileState, id: string, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.review !== "rejected") return done(state, state);
  let next: ProfileState = { ...state, generations: { ...state.generations, [id]: { ...g, review: "pending", approvedRevision: null } } };
  next = recomputeGroups(next, ctx);
  return done(state, appendEvent(bump(next), "unreject", [id], ctx.now));
}

/**
 * Edit appends a user-authored revision. Approval and sensitive confirmation reset,
 * sensitivity is rechecked without lowering, and the new identity becomes an alias
 * so neither wording can recreate an erased fact.
 */
export function edit(state: ProfileState, id: string, value: string, expectedRevision: number, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.currentRevision !== expectedRevision) return fail("stale_revision", "This fact changed since you opened it. Reload and try again.");
  const trimmed = value.trim();
  if (trimmed.length < 1 || codePointLength(trimmed) > LIMITS.maxQuoteCodePoints) return fail("bad_value", `Wording must be 1-${LIMITS.maxQuoteCodePoints} characters.`);
  const rev = currentRevision(g);
  if (rev.value === trimmed) return done(state, state);
  const key = identityKey(rev.slot, trimmed, rev.polarity);
  const other = Object.values(state.generations).find((o) => o.id !== id && o.lifecycle === "live" && o.aliasKeys.includes(key));
  if (other) return fail("matches_other_fact", "This wording matches another fact. Review that fact instead of merging silently.");
  if (isSuppressed(state, key) && openRestoration(state, key)?.generationId !== id) return fail("suppressed", "This wording matches an erased or hidden fact.");
  const assertion = renderAssertion(rev.slot, trimmed, rev.polarity);
  const revision: Revision = {
    revision: g.currentRevision + 1,
    slot: rev.slot,
    value: trimmed,
    polarity: rev.polarity,
    changeCue: rev.changeCue,
    assertion,
    userAuthored: true,
    ruleId: null,
    extractorVersion: null,
    createdAt: ctx.now,
  };
  const updated: Generation = {
    ...g,
    revisions: [...g.revisions, revision],
    currentRevision: revision.revision,
    review: g.review === "rejected" ? "rejected" : "pending",
    approvedRevision: null,
    sensitivity: mergeSensitivity(g.sensitivity, classifyCandidate(rev.slot, [assertion, trimmed])),
    sensitivityConfirmedRevision: null,
    aliasKeys: uniqueSorted([...g.aliasKeys, key]),
  };
  let next: ProfileState = { ...state, generations: { ...state.generations, [id]: updated } };
  next = recomputeGroups(next, ctx);
  return done(state, appendEvent(bump(next), "edit", [id], ctx.now));
}

export function confirmSensitive(state: ProfileState, id: string, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.sensitivity.length === 0) return fail("not_sensitive", "This fact is not marked sensitive.");
  if (g.sensitivityConfirmedRevision === g.currentRevision) return done(state, state);
  const generations = { ...state.generations, [id]: { ...g, sensitivityConfirmedRevision: g.currentRevision } };
  return done(state, appendEvent(bump({ ...state, generations }), "confirm_sensitive", [id], ctx.now));
}

/** Lowering classification is explicit and logged. */
export function markNotSensitive(state: ProfileState, id: string, ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.sensitivity.length === 0) return done(state, state);
  const generations = { ...state.generations, [id]: { ...g, sensitivity: [], sensitivityConfirmedRevision: null } };
  return done(state, appendEvent(bump({ ...state, generations }), "sensitivity_lowered", [id], ctx.now));
}

/** Mark a fact sensitive by hand (rules miss cases). */
export function markSensitive(state: ProfileState, id: string, category: Generation["sensitivity"][number], ctx: Ctx): Result {
  const g = liveGeneration(state, id);
  if (isResult(g)) return g;
  if (g.sensitivity.includes(category)) return done(state, state);
  const generations = { ...state.generations, [id]: { ...g, sensitivity: uniqueSorted([...g.sensitivity, category]), sensitivityConfirmedRevision: null } };
  return done(state, appendEvent(bump({ ...state, generations }), "sensitivity_raised", [id], ctx.now));
}

export type GroupDecision =
  | { decision: "keep_one"; keep: string; displaced: Record<string, SupersedeReason>; effectiveDate?: string | null }
  | { decision: "keep_several"; keep: string[]; scopeNote: string; displaced: Record<string, SupersedeReason>; effectiveDate?: string | null }
  | { decision: "reject_all" };

/** Resolve a whole group. Displaced members record changed_circumstance or corrected_error. */
export function resolveGroup(state: ProfileState, groupId: string, input: GroupDecision, ctx: Ctx): Result {
  const group = state.groups[groupId];
  if (!group) return fail("not_found", "No such conflict group.");
  if (group.state !== "open") return fail("not_open", "This group is already resolved.");
  const memberIds = group.members.map((m) => m.generationId);
  const generations = { ...state.generations };
  let kept: string[] = [];
  let displaced: Record<string, SupersedeReason> = {};
  let scopeNote: string | null = null;
  const effectiveDate = input.decision === "reject_all" ? null : (input.effectiveDate ?? null);
  if (effectiveDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return fail("bad_date", "Effective date must be YYYY-MM-DD or empty.");

  if (input.decision === "reject_all") {
    for (const id of memberIds) generations[id] = { ...generations[id], review: "rejected", approvedRevision: null };
  } else {
    kept = [...new Set(input.decision === "keep_one" ? [input.keep] : input.keep)];
    if (input.decision === "keep_several") {
      if (kept.length < 2) return fail("bad_decision", "Keep several needs at least two facts.");
      scopeNote = input.scopeNote.trim();
      if (!scopeNote) return fail("bad_decision", "Keep several needs a scope note (for example 'weekdays vs weekends').");
    }
    if (kept.some((id) => !memberIds.includes(id))) return fail("bad_decision", "Kept facts must belong to the group.");
    displaced = Object.fromEntries(Object.entries(input.displaced).filter(([id]) => memberIds.includes(id) && !kept.includes(id)));
    for (const id of memberIds) {
      if (kept.includes(id)) continue;
      const reason = displaced[id];
      if (reason !== "changed_circumstance" && reason !== "corrected_error") {
        return fail("bad_decision", "Every displaced fact needs a reason: changed circumstance or corrected error.");
      }
      generations[id] = { ...generations[id], superseded: { reason, groupId, effectiveDate }, approvedRevision: null, review: generations[id].review === "approved" ? "pending" : generations[id].review };
    }
    if (scopeNote) for (const id of kept) generations[id] = { ...generations[id], scopeNote };
  }
  const resolvedGroup = {
    ...group,
    state: "resolved" as const,
    members: group.members.map((m) => ({ ...m, revision: generations[m.generationId].currentRevision })),
    resolution: { decision: input.decision, kept, displaced, scopeNote, effectiveDate, resolvedAt: ctx.now },
  };
  let next: ProfileState = { ...state, generations, groups: { ...state.groups, [groupId]: resolvedGroup } };
  next = recomputeGroups(next, ctx);
  return done(state, appendEvent(bump(next), "group_resolved", [groupId, ...memberIds], ctx.now));
}

/** Convenience views for the UI. */
export function pendingIds(state: ProfileState): string[] {
  return Object.values(state.generations).filter((g) => g.lifecycle === "live" && g.review === "pending" && isCurrentClaim(g)).map((g) => g.id);
}
