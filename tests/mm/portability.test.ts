import { describe, expect, it } from "vitest";
import { exportProjection, renderMarkdown, renderPrompt } from "../../supabase/functions/_shared/mm/exporting.ts";
import { deleteGeneration } from "../../supabase/functions/_shared/mm/lifecycle.ts";
import { emptyProfile, type ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { buildPortable, commitProfilePreview, previewProfileImport, validatePortable } from "../../supabase/functions/_shared/mm/portable.ts";
import { approve, commitPreview, confirmSensitive, edit, previewCandidateImport } from "../../supabase/functions/_shared/mm/reducer.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import type { ParsedConversation } from "../../supabase/functions/_shared/mm/source.ts";
import { diffVersions, publishVersion, renderVersion } from "../../supabase/functions/_shared/mm/versions.ts";
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

function idOf(state: ProfileState, value: string): string {
  const g = Object.values(state.generations).find((x) => x.revisions.some((r) => r.value === value));
  if (!g) throw new Error(`no generation ${value}`);
  return g.id;
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

/** Profile with: approved tea, pending jam, rejected-free open Austin/Boston group, unconfirmed allergy. */
function demoState(): ProfileState {
  let state = importConvs(emptyProfile("profile-a"), [
    conv("c1", [["user", "I like tea. I like jam. I live in Austin. I live in Boston. I have a peanut allergy."]]),
  ]);
  state = ok(approve(state, idOf(state, "tea"), ctx)).state;
  return state;
}

function allOutputs(state: ProfileState, includeSensitive: boolean): string {
  const items = exportProjection(state, { includeSensitive });
  return [renderMarkdown(items, { includeSensitive }), renderPrompt(items).text, buildPortable(state, { includeSensitive }).bytes].join("\n");
}

describe("one export predicate", () => {
  // what_bug_this_catches: a format that leaks pending/unresolved/sensitive-held text the others hide.
  it("excludes pending, open-group and unconfirmed sensitive facts from Markdown, prompt and JSON alike", () => {
    const out = allOutputs(demoState(), true);
    expect(out).toContain("Likes tea");
    for (const hidden of ["jam", "Austin", "Boston", "peanut"]) expect(out).not.toContain(hidden);
  });

  it("sensitive facts need per-revision confirmation AND inclusion for this export", () => {
    let state = demoState();
    const allergy = idOf(state, "peanut allergy");
    state = ok(approve(state, allergy, ctx)).state;
    expect(allOutputs(state, true)).not.toContain("peanut");
    state = ok(confirmSensitive(state, allergy, ctx)).state;
    expect(allOutputs(state, false)).not.toContain("peanut");
    expect(allOutputs(state, true)).toContain("peanut");
  });

  it("superseded and edited-but-unapproved facts drop out of current exports", () => {
    let state = demoState();
    const tea = idOf(state, "tea");
    state = ok(edit(state, tea, "green tea", 1, ctx)).state;
    expect(allOutputs(state, false)).not.toContain("tea");
  });

  it("budgets the prompt on whole facts and reports omissions", () => {
    let state = importConvs(emptyProfile("p"), [conv("c1", [["user", "I like tea. I like jam. I like rye bread."]])]);
    for (const value of ["tea", "jam", "rye bread"]) state = ok(approve(state, idOf(state, value), ctx)).state;
    const items = exportProjection(state, { includeSensitive: false });
    const full = renderPrompt(items, 10_000);
    expect(full.included).toHaveLength(3);
    const tight = renderPrompt(items, full.length - 3);
    expect(tight.length).toBeLessThanOrEqual(full.length - 3);
    expect(tight.omitted).toHaveLength(1);
    const assertions = new Set(items.map((i) => `- ${i.revision.assertion}`));
    for (const line of tight.text.split("\n").slice(1)) expect(assertions.has(line)).toBe(true); // whole facts only
  });
});

describe("portable profile v1", () => {
  it("round-trips through strict validation and re-import is a true no-op", () => {
    const state = demoState();
    const { bytes } = buildPortable(state, { includeSensitive: false });
    const validated = validatePortable(bytes);
    if (!validated.ok) throw new Error(validated.errors.join("; "));
    const preview = previewProfileImport(state, validated.profile, ctx);
    expect(preview.noop).toBe(true);
    expect(ok(commitProfilePreview(state, preview)).state).toBe(state);
  });

  // what_bug_this_catches: accepting tampered, unknown-version or extra-field files.
  it("fails closed on tampering, unknown versions and unknown fields", () => {
    const { profile } = buildPortable(demoState(), { includeSensitive: false });
    const tampered = JSON.stringify({ ...profile, facts: profile.facts.map((f) => ({ ...f, value: "coffee" })) });
    expect(validatePortable(tampered).ok).toBe(false);
    expect(validatePortable(JSON.stringify({ ...profile, schemaVersion: 2 })).ok).toBe(false);
    expect(validatePortable(JSON.stringify({ ...profile, approved: true })).ok).toBe(false);
    expect(validatePortable("x".repeat(1024 * 1024 + 1)).ok).toBe(false);
  });

  it("imports into another profile as pending, never approved, with owner remapping", () => {
    const source = demoState();
    const { bytes } = buildPortable(source, { includeSensitive: false });
    const validated = validatePortable(bytes);
    if (!validated.ok) throw new Error("invalid");
    const target = emptyProfile("profile-b");
    const preview = previewProfileImport(target, validated.profile, ctx);
    expect(preview.counts.created).toBe(1);
    const next = ok(commitProfilePreview(target, preview)).state;
    const g = Object.values(next.generations)[0];
    expect(g.review).toBe("pending");
    expect(g.origin).toEqual({ profileId: "profile-a", generationId: idOf(source, "tea") });
    expect(g.id).not.toBe(idOf(source, "tea"));
    // repeat import: no duplicates, no new events
    const again = previewProfileImport(next, validated.profile, ctx);
    expect(again.noop).toBe(true);
  });

  it("unions imported tombstones and shows their effect on local matches before apply", () => {
    let source = demoState();
    source = ok(deleteGeneration(source, idOf(source, "tea"), "erase", "retain", ctx)).state;
    const { bytes } = buildPortable(source, { includeSensitive: false });
    const validated = validatePortable(bytes);
    if (!validated.ok) throw new Error("invalid");
    const local = importConvs(emptyProfile("profile-b"), [conv("x1", [["user", "I like tea."]])]);
    const preview = previewProfileImport(local, validated.profile, ctx);
    expect(preview.tombstoneEffects).toHaveLength(1);
    const next = ok(commitProfilePreview(local, preview)).state;
    expect(Object.values(next.generations).filter((g) => g.lifecycle === "live")).toHaveLength(0);
  });

  it("refuses a stale preview", () => {
    const state = demoState();
    const { bytes } = buildPortable(state, { includeSensitive: false });
    const validated = validatePortable(bytes);
    if (!validated.ok) throw new Error("invalid");
    const target = emptyProfile("profile-b");
    const preview = previewProfileImport(target, validated.profile, ctx);
    const moved = importConvs(target, [conv("y", [["user", "I like jam."]])]);
    expect(commitProfilePreview(moved, preview)).toMatchObject({ ok: false, code: "stale_preview" });
  });
});

describe("versions", () => {
  it("publishes immutable refs, diffs, and redacts after erase with a new rendering digest", () => {
    let state = demoState();
    state = ok(publishVersion(state, { includeSensitive: false }, ctx)).state;
    const jam = idOf(state, "jam");
    state = ok(approve(state, jam, ctx)).state;
    state = ok(publishVersion(state, { includeSensitive: false }, ctx)).state;
    const v1 = renderVersion(state, 1);
    expect(v1?.originalDigestVerifies).toBe(true);
    const diff = diffVersions(state, 1, 2);
    expect(diff?.added.map((r) => r.generationId)).toEqual([jam]);
    state = ok(deleteGeneration(state, idOf(state, "tea"), "erase", "retain", ctx)).state;
    const redacted = renderVersion(state, 1);
    expect(redacted?.redacted).toBe(true);
    expect(redacted?.originalDigestVerifies).toBe(false);
    expect(redacted?.rows[0].text).toBe("[erased]");
    expect(redacted?.renderingDigest).not.toBe(redacted?.version.digest);
    expect(JSON.stringify(state)).not.toContain("Likes tea");
  });

  it("refuses to publish an empty projection", () => {
    expect(publishVersion(emptyProfile("p"), { includeSensitive: false }, ctx)).toMatchObject({ ok: false, code: "empty" });
  });
});
