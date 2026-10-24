import { normalizeValue } from "./ids.ts";
import type { ConflictPair, Fact } from "./types.ts";

const SINGULAR_SLOTS = new Set(["name", "residence", "job_title", "employer"]);

function compareFacts(a: Fact, b: Fact): number {
  const left = a.validFrom ?? "";
  const right = b.validFrom ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return a.provenance.ordinal - b.provenance.ordinal;
}

function dedupe(sorted: Fact[]): Fact[] {
  const seen = new Set<string>();
  const kept: Fact[] = [];
  for (const fact of sorted) {
    const key = `${fact.polarity}|${normalizeValue(fact.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...fact });
  }
  return kept;
}

function resolveSlot(slot: string, group: Fact[]): { facts: Fact[]; conflicts: ConflictPair[] } {
  const facts = dedupe([...group].sort(compareFacts));
  const conflicts: ConflictPair[] = [];
  const moves = facts.filter((fact) => fact.polarity === "move");
  const latestMove = moves.length > 0 ? moves[moves.length - 1] : null;

  if (latestMove) {
    const earlier = facts.filter(
      (fact) =>
        fact.id !== latestMove.id &&
        compareFacts(fact, latestMove) < 0 &&
        normalizeValue(fact.value) !== normalizeValue(latestMove.value),
    );
    const previous = earlier.length > 0 ? earlier[earlier.length - 1] : null;
    if (previous) {
      conflicts.push({
        slot,
        olderId: previous.id,
        newerId: latestMove.id,
        reason: "explicit_move",
      });
    }
    const earlierIds = new Set(earlier.map((fact) => fact.id));
    return {
      conflicts,
      facts: facts.map((fact) => {
        if (!earlierIds.has(fact.id)) return fact;
        return {
          ...fact,
          status: "superseded",
          supersededBy: latestMove.id,
          invalidAt: latestMove.validFrom,
        };
      }),
    };
  }

  const asserts = facts.filter((fact) => fact.polarity === "assert");
  const denies = facts.filter((fact) => fact.polarity === "deny");
  const flagged = new Map<string, string>();

  for (const deny of denies) {
    const match = asserts.find((fact) => normalizeValue(fact.value) === normalizeValue(deny.value));
    if (!match) continue;
    const older = compareFacts(match, deny) <= 0 ? match : deny;
    const newer = older.id === match.id ? deny : match;
    conflicts.push({ slot, olderId: older.id, newerId: newer.id, reason: "unclear_contradiction" });
    flagged.set(older.id, "unclear_contradiction");
    flagged.set(newer.id, "unclear_contradiction");
  }

  const distinctAsserts = new Set(asserts.map((fact) => normalizeValue(fact.value)));
  if (asserts.length >= 2 && distinctAsserts.size >= 2) {
    conflicts.push({
      slot,
      olderId: asserts[0].id,
      newerId: asserts[asserts.length - 1].id,
      reason: "value_changed",
    });
    for (const fact of asserts) flagged.set(fact.id, "value_changed");
  }

  return {
    conflicts,
    facts: facts.map((fact) => {
      const reason = flagged.get(fact.id);
      if (!reason || fact.status === "superseded" || fact.status === "tombstoned") return fact;
      return {
        ...fact,
        status: "needs_confirmation",
        confirmationReason: reason,
      };
    }),
  };
}

export function conflictsFromFacts(facts: Fact[]): ConflictPair[] {
  const slots = ["name", "residence", "job_title", "employer"];
  const pairs: ConflictPair[] = [];
  for (const slot of slots) {
    const group = facts
      .filter((fact) => fact.slot === slot && fact.status !== "tombstoned")
      .sort(compareFacts);
    const newer = [...group].reverse().find((fact) => fact.explicitMove && fact.status === "proposed");
    if (newer) {
      const older = [...group].reverse().find((fact) => fact.status === "superseded" && fact.supersededBy === newer.id);
      if (older) {
        pairs.push({ slot, olderId: older.id, newerId: newer.id, reason: "explicit_move" });
      }
    }
    const held = group.filter((fact) => {
      const reason = fact.confirmationReason ?? "";
      return (
        fact.status === "needs_confirmation" &&
        (reason.includes("value_changed") || reason.includes("unclear_contradiction"))
      );
    });
    if (held.length >= 2) {
      const reason = (held[0].confirmationReason ?? "").includes("unclear_contradiction")
        ? "unclear_contradiction"
        : "value_changed";
      pairs.push({
        slot,
        olderId: held[0].id,
        newerId: held[held.length - 1].id,
        reason,
      });
    }
  }
  return pairs;
}

export function applyConflictPolicy(input: Fact[]): { facts: Fact[]; conflicts: ConflictPair[] } {
  const passthrough = input.filter((fact) => !SINGULAR_SLOTS.has(fact.slot)).map((fact) => ({ ...fact }));
  const grouped = new Map<string, Fact[]>();
  for (const fact of input) {
    if (!SINGULAR_SLOTS.has(fact.slot)) continue;
    const list = grouped.get(fact.slot) ?? [];
    list.push(fact);
    grouped.set(fact.slot, list);
  }
  const facts = [...passthrough];
  const conflicts: ConflictPair[] = [];
  for (const [slot, group] of grouped) {
    const resolved = resolveSlot(slot, group);
    facts.push(...resolved.facts);
    conflicts.push(...resolved.conflicts);
  }
  return { facts, conflicts };
}
