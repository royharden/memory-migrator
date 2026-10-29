import { evidenceKey, evidenceShapeErrors } from "./evidence.ts";
import { recomputeGroups } from "./groups.ts";
import {
  appendEvent,
  currentIdentityKey,
  currentRevision,
  identityKey,
  linksFor,
  type Candidate,
  type Ctx,
  type EvidenceLink,
  type Generation,
  type ProfileState,
  type Revision,
  type Tombstone,
  type TombstoneMode,
} from "./model.ts";
import { cloneState, fail, type Result } from "./reducer.ts";

function refuse(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/**
 * Erase / hide / restore / undo (PLAN §6). Erase purges every revision value and
 * exclusively held quote payload of a generation; hide keeps the payload in-app but
 * excludes it from everything portable. Neither is described as secure wiping.
 * Suppression is monotonic: tombstones and keys are never removed.
 */

export interface Dependency {
  generationId: string;
  /** In-app display text (never exported). */
  assertion: string | null;
  sharedLinks: number;
}

/** Other live/hidden generations whose quotes overlap this generation's quote spans. */
export function deletionDependencies(state: ProfileState, id: string): Dependency[] {
  const mine = linksFor(state, id).filter((l) => l.evidence !== null);
  const deps = new Map<string, Dependency>();
  for (const link of Object.values(state.links)) {
    if (link.generationId === id || !link.evidence) continue;
    const other = state.generations[link.generationId];
    if (!other || other.lifecycle === "erased") continue;
    const e = link.evidence;
    const overlaps = mine.some((m) => {
      const me = m.evidence;
      return me !== null && me.conversationId === e.conversationId && me.messageId === e.messageId && me.start < e.end && e.start < me.end;
    });
    if (!overlaps) continue;
    const existing = deps.get(other.id);
    if (existing) existing.sharedLinks += 1;
    else deps.set(other.id, { generationId: other.id, assertion: currentRevision(other).assertion, sharedLinks: 1 });
  }
  return [...deps.values()].sort((a, b) => (a.generationId < b.generationId ? -1 : 1));
}

function cascadeSet(state: ProfileState, id: string): string[] {
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    for (const dep of deletionDependencies(state, next)) {
      if (!seen.has(dep.generationId)) {
        seen.add(dep.generationId);
        queue.push(dep.generationId);
      }
    }
  }
  return [...seen];
}

export interface DeletionReceipt {
  mode: TombstoneMode;
  generationIds: string[];
  tombstoneIds: string[];
  purgedRevisions: number;
  purgedQuotes: number;
  hiddenQuotes: number;
  retainedDependencies: string[];
  closedRestorations: number;
  recomputedGroups: string[];
  redactedVersions: number[];
  invalidatedOutputs: true;
}

export type DeleteResult = { ok: true; state: ProfileState; receipt: DeletionReceipt } | { ok: false; code: string; message: string };

export function deleteGeneration(
  state: ProfileState,
  id: string,
  mode: TombstoneMode,
  dependencyChoice: "cascade" | "retain",
  ctx: Ctx,
): DeleteResult {
  const target = state.generations[id];
  if (!target) return refuse("not_found", `No fact ${id}.`);
  if (target.lifecycle === "erased") return refuse("already_erased", "This fact is already erased.");
  if (target.lifecycle === "hidden" && mode === "hide") return refuse("already_hidden", "This fact is already hidden.");

  const deps = deletionDependencies(state, id).map((d) => d.generationId);
  const ids = dependencyChoice === "cascade" ? cascadeSet(state, id).filter((gid) => state.generations[gid].lifecycle !== "erased") : [id];
  const draft = cloneState(state);
  const receipt: DeletionReceipt = {
    mode,
    generationIds: ids,
    tombstoneIds: [],
    purgedRevisions: 0,
    purgedQuotes: 0,
    hiddenQuotes: 0,
    retainedDependencies: dependencyChoice === "retain" ? deps : [],
    closedRestorations: 0,
    recomputedGroups: [],
    redactedVersions: [],
    invalidatedOutputs: true,
  };
  const groupsBefore = JSON.stringify(draft.groups);

  for (const gid of ids) {
    const g = draft.generations[gid];
    const keys = [...new Set([...g.aliasKeys, ...(currentIdentityKey(g) ? [currentIdentityKey(g) as string] : [])])].sort();
    const tombstone: Tombstone = { id: ctx.newId(), generationId: gid, keys, mode, at: ctx.now };
    draft.tombstones.push(tombstone);
    receipt.tombstoneIds.push(tombstone.id);
    for (const key of keys) draft.suppression[key] = [...(draft.suppression[key] ?? []), tombstone.id];

    // Re-delete of a restored generation closes its restoration relation.
    for (const relation of draft.restorations) {
      if (relation.open && relation.generationId === gid) {
        relation.open = false;
        receipt.closedRestorations += 1;
      }
    }

    if (mode === "erase") {
      const purged: Revision[] = g.revisions.map((r) => {
        if (r.value !== null || r.assertion !== null) receipt.purgedRevisions += 1;
        return { ...r, value: null, assertion: null };
      });
      for (const link of Object.values(draft.links)) {
        if (link.generationId === gid && link.evidence !== null) {
          draft.links[link.linkId] = { ...link, evidence: null };
          receipt.purgedQuotes += 1;
        }
      }
      draft.generations[gid] = {
        ...g,
        revisions: purged,
        lifecycle: "erased",
        review: "rejected",
        approvedRevision: null,
        sensitivity: [],
        sensitivityConfirmedRevision: null,
        scopeNote: null,
        superseded: null,
        aliasKeys: keys,
      };
    } else {
      receipt.hiddenQuotes += linksFor(draft, gid).filter((l) => l.evidence !== null).length;
      draft.generations[gid] = { ...g, lifecycle: "hidden", approvedRevision: null, review: g.review === "approved" ? "pending" : g.review, aliasKeys: keys };
    }
    for (const version of draft.versions) {
      if (version.items.some((item) => item.generationId === gid) && !receipt.redactedVersions.includes(version.seq)) receipt.redactedVersions.push(version.seq);
    }
  }

  if (mode === "erase") {
    // Group scope notes are user text that usually names the values: redact them with the erased member.
    for (const group of Object.values(draft.groups)) {
      if (!group.members.some((m) => ids.includes(m.generationId))) continue;
      // Independent of the resolution (it may be null after a reopen): the note was copied onto members.
      if (group.resolution?.scopeNote) draft.groups[group.id] = { ...group, resolution: { ...group.resolution, scopeNote: null } };
      for (const memberId of [...group.members.map((m) => m.generationId), ...(group.resolution?.kept ?? [])]) {
        const member = draft.generations[memberId];
        if (member?.scopeNote) draft.generations[memberId] = { ...member, scopeNote: null };
      }
    }
  }
  let next = recomputeGroups(draft, ctx);
  const groupsAfter = next.groups;
  const before = JSON.parse(groupsBefore) as ProfileState["groups"];
  receipt.recomputedGroups = Object.keys(groupsAfter).filter((gid) => JSON.stringify(before[gid]) !== JSON.stringify(groupsAfter[gid])).sort();
  receipt.redactedVersions.sort((a, b) => a - b);
  next = appendEvent({ ...next, revision: next.revision + 1 }, mode === "erase" ? "erase" : "hide", ids, ctx.now, {
    purgedRevisions: receipt.purgedRevisions,
    purgedQuotes: receipt.purgedQuotes,
    retainedDependencies: receipt.retainedDependencies.length,
    redactedVersions: receipt.redactedVersions.length,
  });
  return { ok: true, state: next, receipt };
}

/**
 * Explicit restore. Creates a NEW pending generation (old UUID stays dead) and an
 * open local restoration relation for the restored identity key. Hidden facts may
 * reuse their retained evidence; erased facts need reselected/reattached evidence
 * whose identity matches one of the old suppression keys.
 */
export function restoreGeneration(state: ProfileState, oldId: string, reselected: Candidate | null, ctx: Ctx): Result {
  const old = state.generations[oldId];
  if (!old) return fail("not_found", `No fact ${oldId}.`);
  if (old.lifecycle === "live") return fail("not_deleted", "Only hidden or erased facts can be restored.");
  if (state.restorations.some((r) => r.open && r.restoredFrom === oldId)) return fail("already_restored", "This fact already has a live restored copy.");

  let revision: Revision;
  let links: Omit<EvidenceLink, "linkId" | "generationId">[];
  let firstSeen: string | null;
  let lastSeen: string | null;
  if (reselected) {
    const key = identityKey(reselected.slot, reselected.value, reselected.polarity);
    if (!old.aliasKeys.includes(key)) return fail("identity_mismatch", "The reselected text does not match the deleted fact.");
    if (evidenceShapeErrors(reselected.evidence).length > 0) return fail("bad_evidence", "The reselected evidence is not valid.");
    revision = {
      revision: 1,
      slot: reselected.slot,
      value: reselected.value,
      polarity: reselected.polarity,
      changeCue: reselected.changeCue,
      assertion: reselected.assertion,
      userAuthored: false,
      ruleId: reselected.ruleId,
      extractorVersion: reselected.extractorVersion,
      createdAt: ctx.now,
    };
    links = [{ evidenceKey: evidenceKey(reselected.evidence), evidence: reselected.evidence, importId: null, addedAt: ctx.now }];
    firstSeen = reselected.evidence.sourceTime;
    lastSeen = reselected.evidence.sourceTime;
  } else {
    if (old.lifecycle !== "hidden") return fail("evidence_required", "Erased facts need their source text reselected to be restored.");
    const current = currentRevision(old);
    revision = { ...current, revision: 1, createdAt: ctx.now };
    links = linksFor(state, oldId)
      .filter((l) => l.evidence !== null)
      .map((l) => ({ evidenceKey: l.evidenceKey, evidence: l.evidence, importId: null, addedAt: ctx.now }));
    if (links.length === 0) return fail("evidence_required", "The hidden fact has no retained evidence; reselect its source text.");
    firstSeen = old.firstSeen;
    lastSeen = old.lastSeen;
  }

  const key = identityKey(revision.slot, revision.value as string, revision.polarity);
  const clash = Object.values(state.generations).find((g) => g.lifecycle === "live" && g.aliasKeys.includes(key));
  if (clash) return fail("matches_other_fact", "A live fact with the same wording already exists.");

  const draft = cloneState(state);
  const id = ctx.newId();
  const generation: Generation = {
    id,
    origin: null,
    revisions: [revision],
    currentRevision: 1,
    review: "pending",
    approvedRevision: null,
    lifecycle: "live",
    superseded: null,
    // Never lowered by restore: union of the old classification and the reselected quote's.
    sensitivity: [...new Set([...old.sensitivity, ...(reselected?.sensitivity ?? [])])].sort() as Generation["sensitivity"],
    sensitivityConfirmedRevision: null,
    aliasKeys: [key],
    firstSeen,
    lastSeen,
    scopeNote: null,
    createdAt: ctx.now,
    restoredFrom: oldId,
  };
  draft.generations[id] = generation;
  for (const link of links) {
    const linkId = ctx.newId();
    draft.links[linkId] = { ...link, linkId, generationId: id };
  }
  draft.restorations.push({ key, generationId: id, restoredFrom: oldId, at: ctx.now, open: true });
  let next = recomputeGroups(draft, ctx);
  next = appendEvent({ ...next, revision: next.revision + 1 }, "restore", [id, oldId], ctx.now);
  return { ok: true, state: next, changed: true };
}

export interface UndoReceipt {
  importId: string;
  removedGenerations: string[];
  removedLinks: number;
  retainedGenerations: Array<{ generationId: string; reason: string }>;
  retainedLinks: number;
}

export type UndoResult = { ok: true; state: ProfileState; receipt: UndoReceipt } | { ok: false; code: string; message: string };

/** Undo never rewinds a group decision: kept or displaced members of a resolved group stay. */
function inResolvedGroup(state: ProfileState, generationId: string): boolean {
  return Object.values(state.groups).some(
    (g) => g.state === "resolved" && g.resolution !== null && g.resolution.decision !== "dissolved" && g.members.some((m) => m.generationId === generationId),
  );
}

function versionReferenced(state: ProfileState, generationId: string): boolean {
  return state.versions.some((v) => v.items.some((item) => item.generationId === generationId));
}

/**
 * Bounded undo: removes only still-pending generations/occurrences uniquely
 * introduced by the import. Approved facts keep their last supporting evidence;
 * version dependencies, other imports and later edits/restores/deletes survive.
 * Discarded pending noise gets no tombstones. Never rewinds later decisions.
 */
export function undoImport(state: ProfileState, importId: string, ctx: Ctx): UndoResult {
  const record = state.imports.find((r) => r.id === importId);
  if (!record) return refuse("not_found", "No such import.");
  if (record.undone) return refuse("already_undone", "This import was already undone.");
  const draft = cloneState(state);
  const receipt: UndoReceipt = { importId, removedGenerations: [], removedLinks: 0, retainedGenerations: [], retainedLinks: 0 };
  const created = new Set(record.createdGenerations);

  const retain = (gid: string, reason: string) => {
    if (!receipt.retainedGenerations.some((r) => r.generationId === gid)) receipt.retainedGenerations.push({ generationId: gid, reason });
  };

  // Generations first created by this import.
  for (const gid of record.createdGenerations) {
    const g = draft.generations[gid];
    if (!g) continue;
    const otherLinks = linksFor(draft, gid).filter((l) => l.importId !== importId);
    if (g.lifecycle !== "live") retain(gid, "deleted later");
    else if (g.review !== "pending") retain(gid, `reviewed (${g.review})`);
    else if (g.currentRevision !== 1) retain(gid, "edited later");
    else if (versionReferenced(draft, gid)) retain(gid, "referenced by a version");
    else if (g.superseded || g.scopeNote || inResolvedGroup(draft, gid)) retain(gid, "resolved in a conflict group");
    else if (otherLinks.length > 0) retain(gid, "also supported by another import");
    else {
      for (const link of linksFor(draft, gid)) {
        delete draft.links[link.linkId];
        receipt.removedLinks += 1;
      }
      delete draft.generations[gid];
      receipt.removedGenerations.push(gid);
    }
  }

  // Occurrences this import added (to its own retained generations or pre-existing ones).
  for (const linkId of record.addedLinks) {
    const link = draft.links[linkId];
    if (!link) continue;
    const g = draft.generations[link.generationId];
    if (!g || g.lifecycle !== "live") continue; // later hide/erase decisions are preserved
    const remaining = linksFor(draft, g.id).filter((l) => l.linkId !== linkId && l.evidence !== null);
    if (remaining.length === 0) {
      receipt.retainedLinks += 1;
      if (!created.has(g.id)) retain(g.id, "last supporting evidence");
      continue;
    }
    delete draft.links[linkId];
    receipt.removedLinks += 1;
  }

  draft.imports = draft.imports.map((r) => (r.id === importId ? { ...r, undone: true } : r));
  draft.appliedFingerprints = draft.appliedFingerprints.filter((f) => f !== record.fingerprint);
  let next = recomputeGroups(draft, ctx);
  next = appendEvent({ ...next, revision: next.revision + 1 }, "undo_import", [importId], ctx.now, {
    removedGenerations: receipt.removedGenerations.length,
    removedLinks: receipt.removedLinks,
    retainedGenerations: receipt.retainedGenerations.length,
  });
  return { ok: true, state: next, receipt };
}
