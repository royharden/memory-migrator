import { describe, expect, it } from "vitest";
import { deleteGeneration, deletionDependencies, restoreGeneration, undoImport } from "../../supabase/functions/_shared/mm/lifecycle.ts";
import { emptyProfile, type ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { exportProjection } from "../../supabase/functions/_shared/mm/exporting.ts";
import { buildPortable } from "../../supabase/functions/_shared/mm/portable.ts";
import { approve, commitPreview, edit, previewCandidateImport, reject, resolveGroup } from "../../supabase/functions/_shared/mm/reducer.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import type { ParsedConversation } from "../../supabase/functions/_shared/mm/source.ts";
import { conv, testCtx } from "./helpers.ts";

const ctx = testCtx();

function importConvs(state: ProfileState, convs: ParsedConversation[]): { state: ProfileState; importId: string | null } {
  const { candidates } = extractCandidates(convs);
  const preview = previewCandidateImport(state, candidates, ctx, "chatgpt-json/1");
  if ("error" in preview) throw new Error(preview.error);
  const result = commitPreview(state, preview);
  if (!result.ok) throw new Error(result.message);
  return { state: result.state, importId: preview.importId };
}

function idOf(state: ProfileState, value: string): string {
  const g = Object.values(state.generations).find((x) => x.revisions.some((r) => r.value === value));
  if (!g) throw new Error(`no generation ${value}`);
  return g.id;
}

const allergy = [conv("c1", [["user", "I have a peanut allergy."]])];

function ok(r: { ok: true; state: ProfileState } | { ok: false; message: string }): ProfileState {
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

describe("erase", () => {
  // what_bug_this_catches: erase that leaves quote/value text in revisions, links, events or tombstones.
  it("purges every revision value and quote and keeps only opaque metadata", () => {
    const { state } = importConvs(emptyProfile("p"), allergy);
    const id = idOf(state, "peanut allergy");
    const result = deleteGeneration(state, id, "erase", "retain", ctx);
    if (!result.ok) throw new Error(result.message);
    const serialized = JSON.stringify(result.state);
    expect(serialized).not.toContain("peanut");
    expect(result.receipt).toMatchObject({ purgedRevisions: 1, purgedQuotes: 1, invalidatedOutputs: true });
    expect(result.state.tombstones[0].keys).toHaveLength(1);
    expect(result.state.events.at(-1)).toMatchObject({ type: "erase", ids: [id] });
  });

  // what_bug_this_catches: re-extraction resurrecting an erased fact.
  it("suppresses the same fact on re-import and after reload of the same source", () => {
    const first = importConvs(emptyProfile("p"), allergy);
    const erased = deleteGeneration(first.state, idOf(first.state, "peanut allergy"), "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    const again = importConvs(erased.state, [conv("c2", [["user", "I have a peanut allergy."]])]);
    expect(Object.values(again.state.generations).filter((g) => g.lifecycle === "live")).toHaveLength(0);
  });

  it("suppresses edit aliases too", () => {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like green tea."]])]);
    const id = idOf(state, "green tea");
    const edited = edit(state, id, "matcha", 1, ctx);
    if (!edited.ok) throw new Error(edited.message);
    const erased = deleteGeneration(edited.state, id, "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    const back = importConvs(erased.state, [conv("c3", [["user", "I like matcha."], ["user", "I like green tea."]])]);
    expect(Object.values(back.state.generations).filter((g) => g.lifecycle === "live")).toHaveLength(0);
  });

  it("assert(A) and deny(A) have different suppression keys", () => {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin."]])]);
    const erased = deleteGeneration(state, idOf(state, "Austin"), "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    const deny = importConvs(erased.state, [conv("c2", [["user", "I no longer live in Austin."]])]);
    expect(Object.values(deny.state.generations).filter((g) => g.lifecycle === "live")).toHaveLength(1);
  });

  it("reports overlapping-quote dependencies and cascades on request", () => {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I work as a librarian at the city library."]])]);
    const role = idOf(state, "librarian");
    const employer = idOf(state, "the city library");
    expect(deletionDependencies(state, role).map((d) => d.generationId)).toEqual([employer]);
    const retained = deleteGeneration(state, role, "erase", "retain", ctx);
    if (!retained.ok) throw new Error(retained.message);
    expect(retained.receipt.retainedDependencies).toEqual([employer]);
    expect(retained.state.generations[employer].lifecycle).toBe("live");
    const cascaded = deleteGeneration(state, role, "erase", "cascade", ctx);
    if (!cascaded.ok) throw new Error(cascaded.message);
    expect(cascaded.receipt.generationIds.sort()).toEqual([employer, role].sort());
    expect(JSON.stringify(cascaded.state)).not.toContain("librarian");
  });

  it("hide keeps the payload in-app but suppresses re-import", () => {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like jazz."]])]);
    const hidden = deleteGeneration(state, idOf(state, "jazz"), "hide", "retain", ctx);
    if (!hidden.ok) throw new Error(hidden.message);
    expect(JSON.stringify(hidden.state)).toContain("jazz");
    const again = importConvs(hidden.state, [conv("c2", [["user", "I like jazz."]])]);
    expect(Object.values(again.state.generations).filter((g) => g.lifecycle === "live")).toHaveLength(0);
  });
});

// what_bug_this_catches: group keys / scope notes keeping value text after erase.
describe("erase and groups", () => {
  it("leaves no value text in groups after erasing one side of a like/dislike pair", () => {
    let { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like zydeco."], ["user", "I hate zydeco."]])]);
    const group = Object.values(state.groups).find((g) => g.state === "open");
    if (!group) throw new Error("expected a group");
    const ids = group.members.map((m) => m.generationId);
    const kept = resolveGroup(state, group.id, { decision: "keep_several", keep: ids, scopeNote: "zydeco live vs recorded", displaced: {} }, ctx);
    if (!kept.ok) throw new Error(kept.message);
    state = kept.state;
    for (const id of ids) {
      const erased = deleteGeneration(state, id, "erase", "retain", ctx);
      if (!erased.ok) throw new Error(erased.message);
      state = erased.state;
    }
    expect(JSON.stringify(state)).not.toContain("zydeco");
  });

  // what_bug_this_catches: the copied keep_several note surviving on the kept fact that was not erased.
  it("erasing one kept member clears the shared scope note on the surviving kept member", () => {
    let { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Quahog."], ["user", "I live in Boston."]])]);
    const group = Object.values(state.groups).find((g) => g.state === "open");
    if (!group) throw new Error("expected a group");
    const ids = group.members.map((m) => m.generationId);
    const kept = resolveGroup(state, group.id, { decision: "keep_several", keep: ids, scopeNote: "Quahog weekdays, Boston weekends", displaced: {} }, ctx);
    if (!kept.ok) throw new Error(kept.message);
    const erased = deleteGeneration(kept.state, idOf(kept.state, "Quahog"), "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    state = erased.state;
    expect(JSON.stringify(state)).not.toContain("Quahog");
    expect(state.generations[idOf(state, "Boston")].scopeNote).toBeNull();
  });
});

// what_bug_this_catches: the copied note surviving after a reopen (resolution null) and a later erase.
describe("scope notes after reopen and hide", () => {
  function keepBoth(): { state: ProfileState; ids: string[] } {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Quahog."], ["user", "I live in Boston."]])]);
    const group = Object.values(state.groups).find((g) => g.state === "open");
    if (!group) throw new Error("expected a group");
    const ids = group.members.map((m) => m.generationId);
    const r = resolveGroup(state, group.id, { decision: "keep_several", keep: ids, scopeNote: "Quahog weekdays, Boston weekends", displaced: {} }, ctx);
    if (!r.ok) throw new Error(r.message);
    return { state: r.state, ids };
  }

  it("a reopen clears the note; erasing afterwards leaves no erased text", () => {
    const { state } = keepBoth();
    const reopened = importConvs(state, [conv("c2", [["user", "I live in Berlin."]])]).state;
    expect(Object.values(reopened.generations).every((g) => g.scopeNote === null)).toBe(true);
    const erased = deleteGeneration(reopened, idOf(reopened, "Quahog"), "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    expect(JSON.stringify(erased.state)).not.toContain("Quahog");
  });

  // what_bug_this_catches: a rejected or edited co-kept value leaking through the shared note (review #4).
  it("rejecting or editing one kept fact withholds the shared note from the other's exports", () => {
    const { state } = keepBoth();
    const boston = idOf(state, "Boston");
    const quahog = idOf(state, "Quahog");
    const approved = ok(approve(state, boston, ctx));
    const rejected = ok(reject(approved, quahog, ctx));
    expect(exportProjection(rejected, { includeSensitive: false })[0].scopeNote).toBeNull();
    const edited = ok(edit(approved, quahog, "Quahog Harbor", 1, ctx));
    expect(exportProjection(edited, { includeSensitive: false }).find((i) => i.generation.id === boston)?.scopeNote ?? null).toBeNull();
  });

  it("hiding one kept fact keeps the shared note out of exports of the other", () => {
    const { state } = keepBoth();
    const boston = idOf(state, "Boston");
    let next = ok(approve(state, boston, ctx));
    const hidden = deleteGeneration(next, idOf(next, "Quahog"), "hide", "retain", ctx);
    if (!hidden.ok) throw new Error(hidden.message);
    next = hidden.state;
    const items = exportProjection(next, { includeSensitive: false });
    expect(items.map((i) => i.generation.id)).toEqual([boston]);
    expect(items[0].scopeNote).toBeNull();
    expect(buildPortable(next, { includeSensitive: false }).bytes).not.toContain("Quahog");
  });
});

describe("restore", () => {
  // what_bug_this_catches: restore that revives the old UUID or lets stale flags reauthorize it.
  it("creates a new pending generation, attaches later evidence to it, and re-delete resumes suppression", () => {
    const first = importConvs(emptyProfile("p"), allergy);
    const oldId = idOf(first.state, "peanut allergy");
    const erased = deleteGeneration(first.state, oldId, "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    expect(restoreGeneration(erased.state, oldId, null, ctx)).toMatchObject({ ok: false, code: "evidence_required" });
    const [reselected] = extractCandidates([conv("c5", [["user", "I have a peanut allergy."]])]).candidates;
    const restored = restoreGeneration(erased.state, oldId, reselected, ctx);
    if (!restored.ok) throw new Error(restored.message);
    const newId = Object.values(restored.state.generations).find((g) => g.lifecycle === "live")?.id as string;
    expect(newId).not.toBe(oldId);
    expect(restored.state.generations[oldId].lifecycle).toBe("erased");
    expect(restored.state.generations[newId]).toMatchObject({ review: "pending", restoredFrom: oldId });
    const later = importConvs(restored.state, [conv("c6", [["user", "I have a peanut allergy."]])]);
    expect(Object.values(later.state.links).filter((l) => l.generationId === newId)).toHaveLength(2);
    const again = deleteGeneration(later.state, newId, "erase", "retain", ctx);
    if (!again.ok) throw new Error(again.message);
    expect(again.receipt.closedRestorations).toBe(1);
    const after = importConvs(again.state, [conv("c7", [["user", "I have a peanut allergy."]])]);
    expect(Object.values(after.state.generations).filter((g) => g.lifecycle === "live")).toHaveLength(0);
  });

  it("hidden facts can be restored from retained evidence", () => {
    const { state } = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like jazz."]])]);
    const id = idOf(state, "jazz");
    const hidden = deleteGeneration(state, id, "hide", "retain", ctx);
    if (!hidden.ok) throw new Error(hidden.message);
    const restored = restoreGeneration(hidden.state, id, null, ctx);
    expect(restored.ok).toBe(true);
  });
});

describe("undo import", () => {
  // what_bug_this_catches: undo that removes approved facts or rewinds later decisions.
  it("removes only pending facts unique to the import and keeps approved facts' last evidence", () => {
    const a = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea."]])]);
    const tea = idOf(a.state, "tea");
    const ap = approve(a.state, tea, ctx);
    if (!ap.ok) throw new Error(ap.message);
    const b = importConvs(ap.state, [conv("c2", [["user", "I like tea."], ["user", "I like jam."]])]);
    const undo = undoImport(b.state, b.importId as string, ctx);
    if (!undo.ok) throw new Error(undo.message);
    expect(undo.receipt.removedGenerations).toEqual([idOf(b.state, "jam")]);
    expect(undo.state.generations[tea].review).toBe("approved");
    expect(Object.values(undo.state.links).filter((l) => l.generationId === tea)).toHaveLength(1);
    expect(undo.state.tombstones).toHaveLength(0);
    expect(undoImport(undo.state, b.importId as string, ctx)).toMatchObject({ ok: false, code: "already_undone" });
  });

  // what_bug_this_catches: undo deleting the kept member of a resolved conflict ("B instead of A" -> "neither").
  it("keeps facts that took part in a resolved group decision", () => {
    const a = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin."]])]);
    const b = importConvs(a.state, [conv("c2", [["user", "I live in Boston."]])]);
    const group = Object.values(b.state.groups).find((g) => g.state === "open");
    if (!group) throw new Error("expected a group");
    const boston = idOf(b.state, "Boston");
    const resolved = resolveGroup(b.state, group.id, { decision: "keep_one", keep: boston, displaced: { [idOf(b.state, "Austin")]: "changed_circumstance" } }, ctx);
    if (!resolved.ok) throw new Error(resolved.message);
    const undo = undoImport(resolved.state, b.importId as string, ctx);
    if (!undo.ok) throw new Error(undo.message);
    expect(undo.state.generations[boston]).toBeDefined();
    expect(undo.receipt.retainedGenerations).toContainEqual({ generationId: boston, reason: "resolved in a conflict group" });
  });

  it("never removes the last supporting evidence of an approved fact", () => {
    const a = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea."]])]);
    const tea = idOf(a.state, "tea");
    const ap = approve(a.state, tea, ctx);
    if (!ap.ok) throw new Error(ap.message);
    const undo = undoImport(ap.state, a.importId as string, ctx);
    if (!undo.ok) throw new Error(undo.message);
    expect(undo.state.generations[tea]).toBeDefined();
    expect(undo.receipt.retainedGenerations[0]).toMatchObject({ generationId: tea });
  });
});
