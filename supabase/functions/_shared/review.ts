import { applyConflictPolicy } from "./conflicts.ts";
import { extractFacts, statementFor } from "./extract.ts";
import { auditId, factId } from "./ids.ts";
import { applySensitivity, classifySensitivity } from "./sensitivity.ts";
import type { AuditEvent, ConflictPair, Fact, FactStatus, ParsedMessage, ProfileDraft } from "./types.ts";

export interface ProtectedFact {
  id: string;
  status: FactStatus;
  userEdited: boolean;
}

export type Decision =
  | { type: "confirm"; factId: string }
  | { type: "delete"; factId: string }
  | { type: "edit"; factId: string; value: string }
  | { type: "keep_newer"; olderId: string; newerId: string }
  | { type: "keep_older"; olderId: string; newerId: string }
  | { type: "keep_both"; olderId: string; newerId: string };

function event(
  action: AuditEvent["action"],
  fact: Fact,
  at: string,
  salt: string,
  detail: string,
): AuditEvent {
  return {
    id: auditId(action, fact.id, at, salt),
    at,
    action,
    factId: fact.id,
    stableKey: fact.id,
    detail,
  };
}

function replaceFact(facts: Fact[], factIdToReplace: string, next: Fact): Fact[] {
  return facts.map((fact) => (fact.id === factIdToReplace ? next : fact));
}

function findFact(facts: Fact[], id: string): Fact | undefined {
  return facts.find((fact) => fact.id === id);
}

export function visibleConflicts(facts: Fact[], pairs: ConflictPair[]): ConflictPair[] {
  return pairs.filter((pair) => {
    const older = findFact(facts, pair.olderId);
    const newer = findFact(facts, pair.newerId);
    if (!older || !newer) return false;
    if (older.status === "tombstoned" || newer.status === "tombstoned") return false;
    if (pair.reason === "explicit_move") {
      return older.status === "superseded" && newer.status === "proposed";
    }
    return older.status === "needs_confirmation" || newer.status === "needs_confirmation";
  });
}

export function buildProfile(messages: ParsedMessage[], nowIso: string): ProfileDraft {
  const extracted = extractFacts(messages);
  const conflicted = applyConflictPolicy(extracted);
  const facts = applySensitivity(conflicted.facts);
  const events = facts.map((fact, index) =>
    event("extract", fact, nowIso, String(index), `Extracted ${fact.statement}`),
  );
  return { facts, conflicts: visibleConflicts(facts, conflicted.conflicts), events };
}

function decisionEvent(fact: Fact, at: string, salt: string, detail: string): AuditEvent {
  if (fact.status === "confirmed") return event("confirm", fact, at, salt, detail);
  return event("hold", fact, at, salt, `${detail} Held back: ${fact.confirmationReason ?? "needs confirmation"}.`);
}

function confirmFact(fact: Fact): Fact {
  return { ...fact, status: "confirmed", confirmationReason: null };
}

function holdIfSensitive(fact: Fact): Fact {
  if (fact.sensitivity === "none") return confirmFact(fact);
  return {
    ...fact,
    status: "needs_confirmation",
    confirmationReason: `sensitivity_${fact.sensitivity}`,
    supersededBy: null,
    invalidAt: null,
  };
}

export function applyDecision(draft: ProfileDraft, decision: Decision, nowIso: string): ProfileDraft {
  const facts = draft.facts.map((fact) => ({ ...fact }));
  const events = [...draft.events];

  if (decision.type === "confirm") {
    const fact = findFact(facts, decision.factId);
    if (!fact || fact.status === "tombstoned" || fact.status === "superseded") {
      return draft;
    }
    const next = confirmFact(fact);
    events.push(event("confirm", next, nowIso, decision.factId, `Confirmed ${next.statement}`));
    return finish(replaceFact(facts, fact.id, next), events, draft.conflicts);
  }

  if (decision.type === "delete") {
    const fact = findFact(facts, decision.factId);
    if (!fact || fact.status === "tombstoned") return draft;
    const next: Fact = { ...fact, status: "tombstoned", invalidAt: nowIso };
    events.push(event("delete", next, nowIso, decision.factId, `Tombstoned ${fact.slot}`));
    return finish(replaceFact(facts, fact.id, next), events, draft.conflicts);
  }

  if (decision.type === "edit") {
    const fact = findFact(facts, decision.factId);
    const value = decision.value.trim().replace(/\s+/g, " ");
    if (!fact || fact.status === "tombstoned" || value.length < 2) return draft;
    const editedId = factId(fact.slot, value, "assert");
    if (editedId === fact.id) return draft;
    const collision = findFact(facts, editedId);
    if (collision) return draft;
    const sensitivity = classifySensitivity(`${fact.provenance.quote} ${value}`);
    const next: Fact = {
      ...fact,
      id: editedId,
      value,
      statement: statementFor(fact.slot, value),
      sensitivity,
      status: "proposed",
      polarity: "assert",
      explicitMove: false,
      userEdited: true,
      supersededBy: null,
      invalidAt: null,
      validFrom: nowIso,
      confirmationReason: null,
    };
    const held = holdIfSensitive(next);
    const superseded: Fact = {
      ...fact,
      status: "superseded",
      supersededBy: held.id,
      invalidAt: nowIso,
    };
    events.push(event("edit", held, nowIso, "edit", `Edited ${fact.slot} to ${value}`));
    events.push(event("supersede", superseded, nowIso, "edit-old", `Superseded by an edit of ${fact.slot}`));
    const withoutOld = replaceFact(facts, fact.id, superseded);
    const withoutCollision = withoutOld.filter((item) => item.id !== held.id);
    return finish([...withoutCollision, held], events, draft.conflicts);
  }

  if (decision.type === "keep_newer" || decision.type === "keep_older" || decision.type === "keep_both") {
    const older = findFact(facts, decision.olderId);
    const newer = findFact(facts, decision.newerId);
    if (!older || !newer) return draft;
    if (decision.type === "keep_newer") {
      const kept = holdIfSensitive({ ...newer, supersededBy: null, invalidAt: null });
      const dropped: Fact = {
        ...older,
        status: "superseded",
        supersededBy: newer.id,
        invalidAt: nowIso,
      };
      events.push(event("supersede", dropped, nowIso, "keep-newer", `Superseded ${older.slot}`));
      events.push(decisionEvent(kept, nowIso, "keep-newer", `Kept newer ${kept.statement}`));
      return finish(
        facts.map((fact) => {
          if (fact.id === older.id) return dropped;
          if (fact.id === newer.id) return kept;
          return fact;
        }),
        events,
        draft.conflicts,
      );
    }
    if (decision.type === "keep_older") {
      const kept = holdIfSensitive({ ...older, supersededBy: null, invalidAt: null });
      const dropped: Fact = { ...newer, status: "tombstoned", invalidAt: nowIso };
      events.push(event("delete", dropped, nowIso, "keep-older", `Rejected newer ${newer.slot}`));
      events.push(decisionEvent(kept, nowIso, "keep-older", `Kept older ${kept.statement}`));
      return finish(
        facts.map((fact) => {
          if (fact.id === older.id) return kept;
          if (fact.id === newer.id) return dropped;
          return fact;
        }),
        events,
        draft.conflicts,
      );
    }
    const left = holdIfSensitive({ ...older, supersededBy: null, invalidAt: null });
    const right = holdIfSensitive({ ...newer, supersededBy: null, invalidAt: null });
    events.push(decisionEvent(left, nowIso, "keep-both-old", `Kept both values for ${left.slot}`));
    events.push(decisionEvent(right, nowIso, "keep-both-new", `Kept both values for ${right.slot}`));
    return finish(
      facts.map((fact) => {
        if (fact.id === older.id) return left;
        if (fact.id === newer.id) return right;
        return fact;
      }),
      events,
      draft.conflicts,
    );
  }

  return draft;
}

function finish(facts: Fact[], events: AuditEvent[], conflicts: ConflictPair[]): ProfileDraft {
  return { facts, events, conflicts: visibleConflicts(facts, conflicts) };
}

export function factsToWrite(existing: ProtectedFact[], incoming: Fact[]): Fact[] {
  const protectedIds = new Set(
    existing
      .filter(
        (fact) =>
          fact.status === "tombstoned" ||
          fact.status === "confirmed" ||
          fact.status === "superseded" ||
          fact.userEdited,
      )
      .map((fact) => fact.id),
  );
  return incoming.filter((fact) => !protectedIds.has(fact.id));
}

export function mergeExtraction(previous: ProfileDraft, extracted: ProfileDraft): ProfileDraft {
  const existing: ProtectedFact[] = previous.facts.map((fact) => ({
    id: fact.id,
    status: fact.status,
    userEdited: fact.userEdited,
  }));
  const writableIds = new Set(factsToWrite(existing, extracted.facts).map((fact) => fact.id));
  const nextById = new Map<string, Fact>();
  for (const fact of previous.facts) nextById.set(fact.id, fact);
  for (const fact of extracted.facts) {
    if (writableIds.has(fact.id)) nextById.set(fact.id, fact);
  }
  const seenExtracts = new Set(
    previous.events.filter((item) => item.action === "extract").map((item) => item.factId),
  );
  const addedEvents = extracted.events.filter(
    (item) => item.action === "extract" && writableIds.has(item.factId) && !seenExtracts.has(item.factId),
  );
  const facts = [...nextById.values()];
  return {
    facts,
    events: [...previous.events, ...addedEvents],
    conflicts: visibleConflicts(facts, extracted.conflicts),
  };
}
