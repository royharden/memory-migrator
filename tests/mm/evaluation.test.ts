import { describe, expect, it } from "vitest";
import dev from "../../fixtures/synthetic/eval/dev.json";
import heldout from "../../fixtures/synthetic/eval/heldout-v2.json";
import manifest from "../../fixtures/synthetic/eval/manifest.json";
import { evaluate, type EvalDataset } from "../../supabase/functions/_shared/mm/evaluation.ts";
import { testCtx } from "./helpers.ts";

/**
 * Contract tests for the scorer and the frozen fixture. They assert invariants and
 * denominators, NOT quality numbers: no score threshold is asserted until the suite
 * has actually been executed and reported.
 */
describe("synthetic evaluation", () => {
  // what_bug_this_catches: a contaminated legacy fixture must not silently become
  // the active held-out split again.
  it("selects only the replacement split and retains the contaminated edition", () => {
    expect(manifest.activeHeldoutFile).toBe("heldout-v2.json");
    expect(manifest.files["heldout.json"].status).toBe("contaminated-v1-regression-only");
    expect(manifest.files["heldout-v2.json"].rulesAtFreeze).toBe("rules/2");
  });

  for (const [name, data] of [["dev.json", dev], ["heldout-v2.json", heldout]] as const) {
    const ds = data as unknown as EvalDataset;

    // what_bug_this_catches: labels edited after freezing without updating the manifest.
    it(`${name} matches its frozen manifest hash`, () => {
      const report = evaluate(ds, testCtx());
      expect(report.datasetSha256).toBe(manifest.files[name].labelSha256);
    });

    it(`${name} locates every gold quote and reports consistent denominators`, () => {
      const report = evaluate(ds, testCtx());
      expect(report.limitations.filter((l) => l.startsWith("Gold label"))).toEqual([]);
      const { tp, fp, fn } = report.overall;
      expect(tp + fn).toBe(report.goldFactsSupported);
      expect(tp + fp).toBe(report.predictedFacts);
      expect(report.eligibility.sentences).toBe(ds.eligibility.length);
      // every live candidate must resolve exactly against its source
      expect(report.evidence.failures).toBe(0);
    });
  }

  it("splits are conversation-disjoint and meet the minimum sizes", () => {
    const devIds = new Set((dev as unknown as EvalDataset).export.map((c) => (c as { id: string }).id));
    const hoIds = (heldout as unknown as EvalDataset).export.map((c) => (c as { id: string }).id);
    expect(hoIds.some((id) => devIds.has(id))).toBe(false);
    expect(manifest.files["dev.json"].labels + manifest.files["heldout-v2.json"].labels).toBeGreaterThanOrEqual(40);
    expect(manifest.files["dev.json"].conversations + manifest.files["heldout-v2.json"].conversations).toBeGreaterThanOrEqual(8);
    expect(manifest.files["heldout-v2.json"].eligibilitySentences).toBeGreaterThanOrEqual(40);
  });
});
