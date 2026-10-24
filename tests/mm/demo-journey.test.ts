import { describe, expect, it } from "vitest";
import demo from "../../fixtures/synthetic/demo-export.json";
import { exportProjection, renderMarkdown, renderPrompt } from "../../supabase/functions/_shared/mm/exporting.ts";
import { deleteGeneration } from "../../supabase/functions/_shared/mm/lifecycle.ts";
import { currentRevision, emptyProfile, type ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { extractSelected, inventoryShard, mergeInventories, selectConversations } from "../../supabase/functions/_shared/mm/parser.ts";
import { buildPortable, commitProfilePreview, previewProfileImport, validatePortable } from "../../supabase/functions/_shared/mm/portable.ts";
import { approveSelected, commitPreview, previewCandidateImport, resolveGroup } from "../../supabase/functions/_shared/mm/reducer.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import { PARSER_VERSION } from "../../supabase/functions/_shared/mm/source.ts";
import { publishVersion, renderVersion } from "../../supabase/functions/_shared/mm/versions.ts";
import { testCtx } from "./helpers.ts";

const ctx = testCtx();
const selection = { conversationIds: null, from: null, to: null, includeUnknownDate: true, branchChoices: {} };

function extractDemo() {
  const inv = inventoryShard(demo.export, 0, "synthetic-demo.json", null);
  const selected = selectConversations(mergeInventories([inv]), selection);
  const parsed = extractSelected(demo.export, 0, selected, selection, { messages: 0, textBytes: 0 });
  return { inv, parsed, ...extractCandidates(parsed.conversations) };
}

function importDemo(state: ProfileState): ProfileState {
  const { candidates } = extractDemo();
  const preview = previewCandidateImport(state, candidates, ctx, PARSER_VERSION);
  if ("error" in preview) throw new Error(preview.error);
  const r = commitPreview(state, preview);
  if (!r.ok) throw new Error(r.message);
  return r.state;
}

function idOf(state: ProfileState, value: string): string {
  const g = Object.values(state.generations).find((x) => x.revisions.some((r) => r.value === value) && x.lifecycle === "live");
  if (!g) throw new Error(`no live generation ${value}`);
  return g.id;
}

/** PLAN §2 local journey, steps 1-8, on the built-in synthetic export (constructed, not yet run). */
describe("built-in demo journey (local mode)", () => {
  it("runs inventory -> extract -> review -> erase -> publish -> reopen without leaking held text", () => {
    // Step 2: inventory with carriers counted, not imported; branchless conversation needs a choice.
    const { inv, parsed, candidates } = extractDemo();
    expect(inv.carriers.length).toBeGreaterThan(0);
    expect(inv.conversations.find((c) => c.id === "demo-branchless")?.state).toBe("needs_branch_choice");
    expect(JSON.stringify(parsed)).not.toContain("SYNTHETIC CARRIER");
    expect(JSON.stringify(candidates)).not.toMatch(/Atlantis|Secretville|Tooltown|Paris|Rome|NASA/);

    // Step 3: four full-state groups (name correction, residence move, employer with unknown dates, hiking retraction).
    let state = importDemo(emptyProfile("demo"));
    const groups = Object.values(state.groups).filter((g) => g.state === "open");
    expect(groups.map((g) => g.kind).sort()).toEqual(["correction", "move", "order_unknown", "retraction"]);
    for (const group of groups) {
      const values = group.members.map((m) => currentRevision(state.generations[m.generationId]));
      let decision: Parameters<typeof resolveGroup>[2];
      if (group.kind === "correction") {
        const keep = group.members.find((m) => currentRevision(state.generations[m.generationId]).value === "Ada Quinn" && currentRevision(state.generations[m.generationId]).polarity === "assert")!.generationId;
        decision = { decision: "keep_one", keep, displaced: Object.fromEntries(group.members.filter((m) => m.generationId !== keep).map((m) => [m.generationId, "corrected_error" as const])) };
      } else if (group.kind === "move") {
        const keep = group.members.find((m) => currentRevision(state.generations[m.generationId]).value === "Denver")!.generationId;
        decision = { decision: "keep_one", keep, displaced: Object.fromEntries(group.members.filter((m) => m.generationId !== keep).map((m) => [m.generationId, "changed_circumstance" as const])) };
      } else {
        decision = { decision: "reject_all" };
      }
      expect(values.length).toBeGreaterThanOrEqual(2);
      const r = resolveGroup(state, group.id, decision, ctx);
      if (!r.ok) throw new Error(r.message);
      state = r.state;
    }
    expect(Object.values(state.groups).filter((g) => g.state === "open")).toHaveLength(0);

    // Step 4: bulk approval skips sensitive facts (allergy, salary).
    const bulk = approveSelected(state, Object.keys(state.generations), ctx);
    state = bulk.state;
    const outputs = () => {
      const items = exportProjection(state, { includeSensitive: true });
      return [renderMarkdown(items, { includeSensitive: true }), renderPrompt(items).text, buildPortable(state, { includeSensitive: true }).bytes].join("\n");
    };
    expect(outputs()).toContain("Lives in Denver");
    for (const held of ["peanut", "64,000", "Austin", "Globex", "Initech", "hiking"]) expect(outputs()).not.toContain(held);

    // Step 5: erase the allergy; re-extracting the same source keeps it suppressed.
    const erased = deleteGeneration(state, idOf(state, "peanut allergy"), "erase", "retain", ctx);
    if (!erased.ok) throw new Error(erased.message);
    state = erased.state;
    expect(JSON.stringify(state)).not.toContain("peanut");
    state = importDemo(state);
    expect(Object.values(state.generations).filter((g) => g.lifecycle === "live" && g.revisions.some((r) => r.value === "peanut allergy"))).toHaveLength(0);

    // Step 6-7: publish v1, export JSON, reopen: true no-op.
    const pub = publishVersion(state, { includeSensitive: false }, ctx);
    if (!pub.ok) throw new Error(pub.message);
    state = pub.state;
    expect(renderVersion(state, 1)?.originalDigestVerifies).toBe(true);
    const file = validatePortable(buildPortable(state, { includeSensitive: false }).bytes);
    if (!file.ok) throw new Error(file.errors.join("; "));
    const reopen = previewProfileImport(state, file.profile, ctx);
    expect(reopen.noop).toBe(true);
    expect(commitProfilePreview(state, reopen)).toMatchObject({ ok: true, state });
  });
});
