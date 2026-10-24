import { describe, expect, it } from "vitest";
import { emptyProfile, type ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import {
  approve,
  approveSelected,
  commitPreview,
  confirmSensitive,
  edit,
  previewCandidateImport,
  reject,
  resolveGroup,
  unreject,
} from "../../supabase/functions/_shared/mm/reducer.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import type { ParsedConversation } from "../../supabase/functions/_shared/mm/source.ts";
import { conv, testCtx } from "./helpers.ts";

const ctx = testCtx();

function importConvs(state: ProfileState, convs: ParsedConversation[]): ProfileState {
  const { candidates } = extractCandidates(convs);
  const preview = previewCandidateImport(state, candidates, ctx, "chatgpt-json/1");
  if ("error" in preview) throw new Error(preview.error);
  const result = commitPreview(state, preview);
  if (!result.ok) throw new Error(result.message);
  return result.state;
}

function byValue(state: ProfileState, value: string) {
  const g = Object.values(state.generations).find((x) => x.revisions.some((r) => r.value === value));
  if (!g) throw new Error(`no generation for ${value}`);
  return g;
}

function openGroups(state: ProfileState) {
  return Object.values(state.groups).filter((g) => g.state === "open");
}

describe("import reconcile", () => {
  // what_bug_this_catches: duplicate facts/evidence/events on a repeated import.
  it("is a true no-op on repeated identical import", () => {
    const source = [conv("c1", [["user", "I live in Austin."]])];
    const once = importConvs(emptyProfile("p"), source);
    const twice = importConvs(once, source);
    expect(twice).toBe(once);
    expect(Object.keys(once.generations)).toHaveLength(1);
    expect(once.events.filter((e) => e.type === "import_applied")).toHaveLength(1);
  });

  it("every new assertion starts pending and stale previews are refused", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea."]])]);
    expect(Object.values(state.generations)[0].review).toBe("pending");
    const { candidates } = extractCandidates([conv("c2", [["user", "I like jam."]])]);
    const preview = previewCandidateImport(state, candidates, ctx, null);
    if ("error" in preview) throw new Error(preview.error);
    const moved = approve(state, Object.keys(state.generations)[0], ctx);
    if (!moved.ok) throw new Error(moved.message);
    expect(commitPreview(moved.state, preview)).toMatchObject({ ok: false, code: "stale_preview" });
  });

  it("keeps an identical rejected reimport rejected", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea."]])]);
    const id = Object.keys(state.generations)[0];
    const r = reject(state, id, ctx);
    if (!r.ok) throw new Error(r.message);
    state = importConvs(r.state, [conv("c2", [["user", "I like tea."]])]);
    expect(state.generations[id].review).toBe("rejected");
    expect(Object.keys(state.generations)).toHaveLength(1);
  });
});

describe("full-state groups", () => {
  // what_bug_this_catches: pairwise latest-only conflicts that drop the third value.
  it("groups all incompatible values of a single slot across imports", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin.", "2024-01-01T00:00:00Z"]])]);
    state = importConvs(state, [conv("c2", [["user", "I live in Boston.", "2024-03-01T00:00:00Z"]])]);
    state = importConvs(state, [conv("c3", [["user", "I moved to Denver.", "2024-06-01T00:00:00Z"]])]);
    const groups = openGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
    expect(groups[0].kind).toBe("move");
  });

  // what_bug_this_catches: individual approval bypassing an open conflict.
  it("blocks individual approval of an open group member", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin. I live in Boston."]])]);
    expect(approve(state, byValue(state, "Austin").id, ctx)).toMatchObject({ ok: false, code: "open_group" });
  });

  it("A -> B -> A keeps three occurrences and unknown times give order_unknown", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin."], ["user", "I live in Boston."], ["user", "I live in Austin."]])]);
    const austin = byValue(state, "Austin");
    expect(Object.values(state.links).filter((l) => l.generationId === austin.id)).toHaveLength(2);
    expect(openGroups(state)[0].kind).toBe("order_unknown");
  });

  it("resolves the whole group, records reasons, and reopens only for a new incompatible member", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin."], ["user", "I moved to Denver."]])]);
    const group = openGroups(state)[0];
    const austin = byValue(state, "Austin").id;
    const denver = byValue(state, "Denver").id;
    expect(resolveGroup(state, group.id, { decision: "keep_one", keep: denver, displaced: {} }, ctx)).toMatchObject({ ok: false, code: "bad_decision" });
    const resolved = resolveGroup(state, group.id, { decision: "keep_one", keep: denver, displaced: { [austin]: "changed_circumstance" } }, ctx);
    if (!resolved.ok) throw new Error(resolved.message);
    state = resolved.state;
    expect(state.generations[austin].superseded?.reason).toBe("changed_circumstance");
    expect(state.generations[austin].superseded?.effectiveDate).toBeNull();
    expect(openGroups(state)).toHaveLength(0);
    // identical evidence again: no reopen
    state = importConvs(state, [conv("c1", [["user", "I live in Austin."], ["user", "I moved to Denver."]])]);
    expect(openGroups(state)).toHaveLength(0);
    // new incompatible member reopens the same group
    state = importConvs(state, [conv("c9", [["user", "I live in Chicago."]])]);
    const reopened = openGroups(state);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(group.id);
  });

  // what_bug_this_catches: approving a rejected fact re-entering the claim set without a conflict group.
  it("approving a rejected fact requires un-reject, which re-checks conflicts", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I live in Austin."]])]);
    const austin = byValue(state, "Austin").id;
    const r = reject(state, austin, ctx);
    if (!r.ok) throw new Error(r.message);
    state = importConvs(r.state, [conv("c2", [["user", "I live in Boston."]])]);
    expect(approve(state, austin, ctx)).toMatchObject({ ok: false, code: "rejected" });
    const u = unreject(state, austin, ctx);
    if (!u.ok) throw new Error(u.message);
    expect(openGroups(u.state)).toHaveLength(1);
    expect(approve(u.state, austin, ctx)).toMatchObject({ ok: false, code: "open_group" });
  });

  it("keep_several requires a scope note and stays resolved", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I work at Acme."], ["user", "I work at Globex."]])]);
    const group = openGroups(state)[0];
    const ids = group.members.map((m) => m.generationId);
    expect(resolveGroup(state, group.id, { decision: "keep_several", keep: ids, scopeNote: " ", displaced: {} }, ctx)).toMatchObject({ ok: false });
    const r = resolveGroup(state, group.id, { decision: "keep_several", keep: ids, scopeNote: "two part-time jobs", displaced: {} }, ctx);
    if (!r.ok) throw new Error(r.message);
    state = r.state;
    expect(openGroups(state)).toHaveLength(0);
    expect(approve(state, ids[0], ctx).ok).toBe(true);
  });

  it("assert/deny of the same preference conflicts; like vs dislike conflicts", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like olives."], ["user", "I no longer like olives."], ["user", "I hate olives."]])]);
    const groups = openGroups(state);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });
});

describe("edits and sensitivity", () => {
  it("edit appends a user-authored revision, resets approval and keeps the original attribution", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like green tea."]])]);
    const id = Object.keys(state.generations)[0];
    const a = approve(state, id, ctx);
    if (!a.ok) throw new Error(a.message);
    const e = edit(a.state, id, "matcha", 1, ctx);
    if (!e.ok) throw new Error(e.message);
    state = e.state;
    const g = state.generations[id];
    expect(g.revisions.map((r) => [r.value, r.userAuthored])).toEqual([["green tea", false], ["matcha", true]]);
    expect(g.review).toBe("pending");
    expect(g.approvedRevision).toBeNull();
    expect(g.aliasKeys).toHaveLength(2);
    expect(edit(state, id, "chai", 1, ctx)).toMatchObject({ ok: false, code: "stale_revision" });
  });

  it("refuses to edit into another live fact's identity", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea."], ["user", "I like jam."]])]);
    expect(edit(state, byValue(state, "tea").id, "JAM", 1, ctx)).toMatchObject({ ok: false, code: "matches_other_fact" });
  });

  // what_bug_this_catches: editing a sensitive fact to bypass its confirmation.
  it("edits never lower sensitivity and invalidate prior confirmation", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I have a peanut allergy."]])]);
    const id = Object.keys(state.generations)[0];
    const c = confirmSensitive(state, id, ctx);
    if (!c.ok) throw new Error(c.message);
    const e = edit(c.state, id, "nuts", 1, ctx);
    if (!e.ok) throw new Error(e.message);
    state = e.state;
    expect(state.generations[id].sensitivity).toContain("health");
    expect(state.generations[id].sensitivityConfirmedRevision).toBeNull();
  });

  it("bulk approval skips sensitive facts", () => {
    const state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea. I have a peanut allergy."]])]);
    const result = approveSelected(state, Object.keys(state.generations), ctx);
    expect(result.approved).toEqual([byValue(state, "tea").id]);
    expect(result.skipped).toEqual([byValue(state, "peanut allergy").id]);
  });
});
