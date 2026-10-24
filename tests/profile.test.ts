import { describe, expect, it } from "vitest";
import fixture from "../src/fixtures/labelled-set.json";
import { conflictsFromFacts } from "../supabase/functions/_shared/conflicts.ts";
import { scoreExtraction } from "../supabase/functions/_shared/evaluate.ts";
import type { GoldLabel } from "../supabase/functions/_shared/evaluate.ts";
import { renderMarkdown, renderPrompt } from "../supabase/functions/_shared/exportProfile.ts";
import { parseChatGptExport } from "../supabase/functions/_shared/parseChatGpt.ts";
import { applyDecision, buildProfile, factsToWrite, mergeExtraction } from "../supabase/functions/_shared/review.ts";
import type { Fact, ParsedMessage } from "../supabase/functions/_shared/types.ts";

const labels = fixture.labels as GoldLabel[];
const NOW = "2026-10-23T18:00:00.000Z";

function sampleDraft() {
  const parsed = parseChatGptExport(fixture.export);
  return { parsed, draft: buildProfile(parsed.messages, NOW) };
}

function user(id: string, text: string, ordinal: number, createdAt: string): ParsedMessage {
  return {
    conversationId: "c-test",
    conversationTitle: "Test",
    messageId: id,
    role: "user",
    text,
    createdAt,
    ordinal,
  };
}

describe("labelled extraction", () => {
  it("scores the hand-labelled sample with the provenance invariant", () => {
    const { parsed, draft } = sampleDraft();
    const score = scoreExtraction(draft.facts, labels);
    expect(score.truePositive).toBe(labels.length);
    expect(score.falsePositive).toBe(0);
    expect(score.falseNegative).toBe(0);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.unprovenanced).toBe(0);
    expect(score.provenanceMismatches).toBe(0);
    expect(score.invariantOk).toBe(true);
    for (const fact of draft.facts) {
      const message = parsed.messages.find((item) => item.messageId === fact.provenance.messageId);
      expect(message?.text.slice(fact.provenance.start, fact.provenance.end)).toBe(fact.provenance.quote);
    }
    expect(draft.facts.some((fact) => /Atlantis|Secretville|Tooltown|Paris/.test(fact.value))).toBe(false);
  });

  it("supersedes Austin with the Denver move and holds sensitive facts", () => {
    const { draft } = sampleDraft();
    const austin = draft.facts.find((fact) => fact.value === "Austin");
    const denver = draft.facts.find((fact) => fact.value === "Denver");
    const allergy = draft.facts.find((fact) => fact.slot === "health_note");
    const salary = draft.facts.find((fact) => fact.slot === "financial_note");
    expect(austin?.status).toBe("superseded");
    expect(austin?.supersededBy).toBe(denver?.id);
    expect(denver?.status).toBe("proposed");
    expect(denver?.explicitMove).toBe(true);
    expect(allergy?.status).toBe("needs_confirmation");
    expect(allergy?.sensitivity).toBe("health");
    expect(salary?.sensitivity).toBe("financial");
    expect(draft.conflicts).toEqual([
      expect.objectContaining({ slot: "residence", reason: "explicit_move", olderId: austin?.id, newerId: denver?.id }),
    ]);
    expect(conflictsFromFacts(draft.facts)).toEqual(draft.conflicts);
  });
});

describe("conflicts", () => {
  it("holds two residence claims that are not an explicit move", () => {
    const draft = buildProfile(
      [
        user("m1", "I live in Austin.", 0, "2024-01-01T00:00:00.000Z"),
        user("m2", "I live in Denver.", 1, "2024-06-01T00:00:00.000Z"),
      ],
      NOW,
    );
    expect(draft.conflicts.map((pair) => pair.reason)).toEqual(["value_changed"]);
    expect(draft.facts.every((fact) => fact.status === "needs_confirmation")).toBe(true);
  });

  it("holds an assert and a deny of the same place", () => {
    const draft = buildProfile(
      [
        user("m1", "I live in Austin.", 0, "2024-01-01T00:00:00.000Z"),
        user("m2", "I don't live in Austin.", 1, "2024-06-01T00:00:00.000Z"),
      ],
      NOW,
    );
    expect(draft.conflicts.map((pair) => pair.reason)).toEqual(["unclear_contradiction"]);
    expect(draft.facts).toHaveLength(2);
  });
});

describe("review and export", () => {
  it("does not resurrect a tombstone, and the prompt omits unconfirmed and removed quotes", () => {
    const { draft } = sampleDraft();
    const allergy = draft.facts.find((fact) => fact.slot === "health_note");
    expect(allergy).toBeDefined();
    const removed = applyDecision(draft, { type: "delete", factId: allergy!.id }, NOW);
    const again = mergeExtraction(removed, buildProfile(sampleDraft().parsed.messages, "2026-10-23T19:00:00.000Z"));
    const kept = again.facts.find((fact) => fact.id === allergy!.id);
    expect(kept?.status).toBe("tombstoned");
    const prompt = renderPrompt(again.facts);
    expect(prompt).not.toContain("peanut");
    expect(prompt).not.toContain("64000");
    const markdown = renderMarkdown(again.facts, "Profile");
    expect(markdown).not.toContain("I have a peanut allergy");
    expect(markdown).toContain("quote omitted");
  });

  it("confirms the move, edits a name, and exports only confirmed facts", () => {
    let { draft } = sampleDraft();
    const pair = draft.conflicts[0];
    expect(pair?.reason).toBe("explicit_move");
    draft = applyDecision(draft, { type: "keep_newer", olderId: pair!.olderId, newerId: pair!.newerId }, NOW);
    const name = draft.facts.find((fact) => fact.slot === "name");
    draft = applyDecision(draft, { type: "edit", factId: name!.id, value: "Ada Cole" }, NOW);
    const salary = draft.facts.find((fact) => fact.slot === "financial_note");
    draft = applyDecision(draft, { type: "confirm", factId: salary!.id }, NOW);
    const prompt = renderPrompt(draft.facts);
    expect(prompt).toContain("Lives in Denver");
    expect(prompt).toContain("Name is Ada Cole");
    expect(prompt).toContain("64000");
    expect(prompt).not.toContain("Lives in Austin");
    expect(prompt).not.toContain("Name is Ada Quinn");
    expect(prompt).not.toContain("peanut");
    const edited = draft.facts.find((fact) => fact.value === "Ada Cole");
    expect(edited?.userEdited).toBe(true);
    expect(edited?.status).toBe("confirmed");
    expect(draft.facts.find((fact) => fact.value === "Ada Quinn")?.status).toBe("superseded");
  });

  it("refuses to overwrite a protected fact on a later extract", () => {
    const incoming = [{ id: "f_keep", status: "proposed" }] as Fact[];
    const writable = factsToWrite(
      [
        { id: "f_keep", status: "tombstoned", userEdited: false },
        { id: "f_open", status: "proposed", userEdited: false },
      ],
      [
        { ...incoming[0], id: "f_keep" },
        { id: "f_open", status: "proposed" } as Fact,
      ],
    );
    expect(writable.map((fact) => fact.id)).toEqual(["f_open"]);
  });
});

describe("evaluation invariant", () => {
  it("fails when a fact has no message id", () => {
    const { draft } = sampleDraft();
    const broken: Fact = {
      ...draft.facts[0]!,
      provenance: { ...draft.facts[0]!.provenance, messageId: "", quote: "" },
    };
    const score = scoreExtraction([broken], labels);
    expect(score.invariantOk).toBe(false);
    expect(score.unprovenanced).toBe(1);
    expect(score.truePositive).toBe(0);
  });
});
