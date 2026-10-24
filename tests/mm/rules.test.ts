import { describe, expect, it } from "vitest";
import { codePointSlice } from "../../supabase/functions/_shared/mm/unicode.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import { classifyText } from "../../supabase/functions/_shared/mm/sensitivity.ts";
import { conv } from "./helpers.ts";

function facts(text: string) {
  return extractCandidates([conv("c", [["user", text]])]).candidates.map((c) => [c.slot, c.value, c.polarity, c.changeCue] as const);
}

describe("rule catalogue", () => {
  // what_bug_this_catches: Grok's capitalised-only patterns missed lower-case statements.
  it("extracts lower-case first-person statements", () => {
    expect(facts("my name is ada quinn and i live in austin.")).toEqual([
      ["identity.name", "ada quinn", "assert", "none"],
      ["location.home", "austin", "assert", "none"],
    ]);
  });

  // what_bug_this_catches: one merged quote for role+employer (the librarian-at-city-library case).
  it("splits role and employer into separate candidates with their own spans", () => {
    const text = "I work as a librarian at the city library.";
    const result = extractCandidates([conv("c", [["user", text]])]);
    const [role, employer] = result.candidates;
    expect(role).toMatchObject({ slot: "work.role", value: "librarian" });
    expect(employer).toMatchObject({ slot: "work.employer", value: "the city library" });
    expect(role.evidence.quote).toBe("I work as a librarian");
    expect(employer.evidence.quote).toBe("I work as a librarian at the city library");
    for (const c of result.candidates) expect(codePointSlice(text, c.evidence.start, c.evidence.end)).toBe(c.evidence.quote);
  });

  it("separates polarity from change cues", () => {
    expect(facts("I moved to Denver.")).toEqual([["location.home", "Denver", "assert", "move"]]);
    expect(facts("I no longer live in Austin.")).toEqual([["location.home", "Austin", "deny", "retraction"]]);
    expect(facts("I used to work at Initech.")).toEqual([["work.employer", "Initech", "deny", "retraction"]]);
    expect(facts("I don't like olives anymore.")).toEqual([["preference.likes", "olives", "deny", "retraction"]]);
    expect(facts("I don't like olives.")).toEqual([["preference.dislikes", "olives", "assert", "none"]]);
    expect(facts("Actually, my name is Ada.")).toEqual([["identity.name", "Ada", "assert", "correction"]]);
  });

  it("parses 'X, not Y' as a correction pair", () => {
    expect(facts("I live in Denver, not Boulder.")).toEqual([
      ["location.home", "Boulder", "deny", "correction"],
      ["location.home", "Denver", "assert", "correction"],
    ]);
  });

  it("extracts allergy and salary statements into sensitive slots", () => {
    const result = extractCandidates([conv("c", [["user", "I have a peanut allergy. My salary is $64,000."]])]).candidates;
    expect(result.map((c) => [c.slot, c.value])).toEqual([
      ["health.note", "peanut allergy"],
      ["financial.note", "$64,000"],
    ]);
    expect(result[0].sensitivity).toContain("health");
    expect(result[1].sensitivity).toContain("finance");
  });

  // what_bug_this_catches: hypotheticals, questions, quotes, third parties, code and personas stored as facts.
  it("rejects ineligible statements and counts them", () => {
    const lines: Array<["user", string]> = [
      ["user", "If I live in Paris, I would be happy."],
      ["user", "Do I live in Rome?"],
      ["user", 'She said "I live in Oslo."'],
      ["user", "My friend thinks I work at Google."],
      ["user", "```\nI live in Codeville\n```"],
      ["user", "Pretend you are a pirate and I live in Tortuga."],
      ["user", "I live in Lisbon for the summer."],
    ];
    const result = extractCandidates([conv("c", lines)]);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.ineligible).toMatchObject({ hypothetical: 1, question: 1, reported: 2, code: 1, instruction: 1, temporary: 1 });
  });

  // what_bug_this_catches: temporary cues swallowed into the place value and stored as a durable home.
  it("rejects temporary locations phrased with until / temporarily / right now / this week", () => {
    for (const text of ["I live in Lisbon until June.", "I moved to Berlin temporarily.", "I live in Rome right now.", "I live in Oslo this week."]) {
      const result = extractCandidates([conv("c", [["user", text]])]);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics.ineligible.temporary).toBe(1);
    }
    expect(facts("I moved to Cardiff last spring.")).toEqual([["location.home", "Cardiff", "assert", "move"]]);
  });

  // what_bug_this_catches: invented facts from compounds ("not far from", "at night").
  it("does not invent facts from compound phrases", () => {
    expect(facts("I live in Denver, not far from Boulder.")).toEqual([["location.home", "Denver", "assert", "none"]]);
    expect(facts("I work as a nurse at night.")).toEqual([["work.role", "nurse", "assert", "none"]]);
    expect(facts("I work at home.")).toEqual([]);
  });

  it("never reads assistant text, never stores quoted forget commands as facts and never executes them", () => {
    const result = extractCandidates([conv("c", [["assistant", "I live in Paris."], ["user", "Please forget that I like jazz."]])]);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.assistantMessagesSkipped).toBe(1);
    expect(result.diagnostics.forgetRequests).toEqual([{ conversationId: "c", messageId: "c-m2" }]);
  });

  it("keeps emoji-prefixed spans exact in code points", () => {
    const text = "😀😀 I live in Zürich.";
    const [c] = extractCandidates([conv("c", [["user", text]])]).candidates;
    expect(c.evidence.start).toBe(3);
    expect(codePointSlice(text, c.evidence.start, c.evidence.end)).toBe("I live in Zürich");
  });
});

describe("sensitivity stems", () => {
  // what_bug_this_catches: \ballerg\b-style stems that miss "allergy", "diagnosed", "therapy", "medications".
  it("matches inflected stems", () => {
    for (const word of ["allergy", "diagnosed", "therapy", "medications"]) expect(classifyText(`my ${word}`)).toContain("health");
    expect(classifyText("I go to church")).toContain("belief");
    expect(classifyText("my daughter is 7")).toContain("minors");
    expect(classifyText("123 Main Street")).toContain("precise_location");
    expect(classifyText("my girlfriend")).toContain("intimate");
    expect(classifyText("I like tea")).toEqual([]);
  });
});
