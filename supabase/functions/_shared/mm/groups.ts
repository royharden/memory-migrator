import {
  appendEvent,
  currentIdentityKey,
  currentRevision,
  isSingleSlot,
  type ConflictGroup,
  type Ctx,
  type Generation,
  type GroupKind,
  type GroupMember,
  type ProfileState,
  type Slot,
} from "./model.ts";
import { sha256Hex } from "./sha256.ts";
import { normalizeExact } from "./unicode.ts";

/**
 * Full-state conflict groups (PLAN §5). Recomputed from ALL current claims, never
 * pairwise against the latest upload. Cues and times only label a group; they never
 * decide it. Upload order never determines validity.
 */

/** A generation is a current claim if it is live, not rejected, not superseded and not purged. */
export function isCurrentClaim(g: Generation): boolean {
  if (g.lifecycle !== "live" || g.review === "rejected" || g.superseded) return false;
  return currentRevision(g).value !== null;
}

interface Claim {
  g: Generation;
  slot: Slot;
  target: string;
  polarity: "assert" | "deny";
}

function claimOf(g: Generation): Claim {
  const rev = currentRevision(g);
  return { g, slot: rev.slot, target: normalizeExact(rev.value ?? ""), polarity: rev.polarity };
}

/** Opaque group key: a hash, so stored groups never carry value text (erase must leave none behind). */
function groupKeyOf(claim: Claim): string {
  if (isSingleSlot(claim.slot)) return sha256Hex(claim.slot);
  if (claim.slot === "preference.likes" || claim.slot === "preference.dislikes") return sha256Hex(`preference|${claim.target}`);
  return sha256Hex(`${claim.slot}|${claim.target}`);
}

function incompatible(a: Claim, b: Claim): boolean {
  if (isSingleSlot(a.slot) && a.slot === b.slot) {
    if (a.polarity === "assert" && b.polarity === "assert") return a.target !== b.target;
    if (a.polarity !== b.polarity) return a.target === b.target;
    return false; // deny/deny never conflict
  }
  if (a.target !== b.target) return false;
  if (a.slot === b.slot) return a.polarity !== b.polarity; // assert(X) vs deny(X)
  const pref = new Set([a.slot, b.slot]);
  return pref.has("preference.likes") && pref.has("preference.dislikes") && a.polarity === "assert" && b.polarity === "assert";
}

function kindOf(members: Generation[]): GroupKind {
  const revs = members.map((g) => currentRevision(g));
  if (revs.some((r) => r.changeCue === "move")) return "move";
  if (revs.some((r) => r.changeCue === "correction")) return "correction";
  if (revs.some((r) => r.changeCue === "retraction") || new Set(revs.map((r) => r.polarity)).size > 1) return "retraction";
  const times = members.map((g) => g.lastSeen);
  if (times.every((t) => t !== null) && new Set(times).size === times.length) return "changed";
  return "order_unknown";
}

function memberOf(g: Generation): GroupMember {
  return { generationId: g.id, revision: g.currentRevision, identityKey: currentIdentityKey(g) ?? "" };
}

/** Members of every open group, for the export predicate and approve guard. */
export function openGroupMembers(state: ProfileState): Set<string> {
  const ids = new Set<string>();
  for (const group of Object.values(state.groups)) {
    if (group.state === "open") for (const m of group.members) ids.add(m.generationId);
  }
  return ids;
}

export function recomputeGroups(state: ProfileState, ctx: Ctx): ProfileState {
  const claims = Object.values(state.generations).filter(isCurrentClaim).map(claimOf);
  const byKey = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = groupKeyOf(claim);
    byKey.set(key, [...(byKey.get(key) ?? []), claim]);
  }

  const groups: Record<string, ConflictGroup> = { ...state.groups };
  const latestByKey = new Map<string, ConflictGroup>();
  for (const group of Object.values(groups)) latestByKey.set(group.groupKey, group); // insertion order: last wins
  let next = state;
  const touchedKeys = new Set<string>();

  for (const [key, list] of byKey) {
    const participants = new Map<string, Generation>();
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (incompatible(list[i], list[j])) {
          participants.set(list[i].g.id, list[i].g);
          participants.set(list[j].g.id, list[j].g);
        }
      }
    }
    if (participants.size === 0) continue;
    touchedKeys.add(key);
    const members = [...participants.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const memberRows = members.map(memberOf);
    const existing = latestByKey.get(key);
    if (existing && existing.state === "resolved" && existing.resolution && existing.resolution.decision !== "dissolved") {
      const kept = new Map(existing.members.map((m) => [m.generationId, m.identityKey]));
      const stillAccepted = memberRows.every((m) => existing.resolution?.kept.includes(m.generationId) && kept.get(m.generationId) === m.identityKey);
      if (stillAccepted) continue; // keep_several coexistence remains resolved
      groups[existing.id] = { ...existing, state: "open", members: memberRows, kind: kindOf(members), resolution: null };
      next = appendEvent(next, "group_reopened", [existing.id], ctx.now);
      continue;
    }
    if (existing && existing.state === "open") {
      groups[existing.id] = { ...existing, members: memberRows, kind: kindOf(members) };
      continue;
    }
    const id = ctx.newId();
    groups[id] = { id, groupKey: key, slot: members[0].revisions[0].slot, kind: kindOf(members), state: "open", members: memberRows, resolution: null };
    next = appendEvent(next, "group_opened", [id], ctx.now);
  }

  // Open groups whose incompatibility disappeared (member erased/rejected elsewhere) dissolve.
  for (const group of Object.values(groups)) {
    if (group.state === "open" && !touchedKeys.has(group.groupKey)) {
      groups[group.id] = {
        ...group,
        state: "resolved",
        resolution: { decision: "dissolved", kept: [], displaced: {}, scopeNote: null, effectiveDate: null, resolvedAt: ctx.now },
      };
      next = appendEvent(next, "group_dissolved", [group.id], ctx.now);
    }
  }
  return { ...next, groups };
}
