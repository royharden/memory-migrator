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
    expect(facts("I live in Denver, not far from Boulder.")).toEqual([]);
    expect(facts("I work as a nurse at night.")).toEqual([["work.role", "nurse", "assert", "none"]]);
    expect(facts("I work at home.")).toEqual([]);
    // "X, not in Y" drops the slot preposition; time/adverb tails abstain; "not anymore" abstains entirely.
    expect(facts("I live in Austin, not in Dallas.")).toEqual([
      ["location.home", "Dallas", "deny", "correction"],
      ["location.home", "Austin", "assert", "correction"],
    ]);
    expect(facts("I work at Acme, not for long.")).toEqual([]);
    expect(facts("I live in Denver, not anymore.")).toEqual([]);
    // what_bug_this_catches: invented or malformed denials and retracted assertions kept (review #3).
    // An unparseable "X, not ..." abstains on the whole statement, X included.
    for (const text of ["I work at Acme, not at the moment.", "I work at Acme, not for much longer.", "I work for Acme, not for free.", "I live in Austin, not Dallas anymore.", "I live in Austin, not Dallas or Houston.", "I work as a nurse, not a doctor like my dad.", "My name is Ada, not kidding."]) {
      expect(facts(text)).toEqual([]);
    }
    expect(facts("I moved to Denver, not Boulder.")).toEqual([
      ["location.home", "Boulder", "deny", "correction"],
      ["location.home", "Denver", "assert", "move"],
    ]);
    expect(facts("I live in Denver, not anymore though.")).toEqual([]);
    expect(facts("I live in Denver, not anymore, sadly.")).toEqual([]);
  });

  // what_bug_this_catches: sentence splitting on decimals/domains/abbreviations producing wrong values.
  it("keeps decimals, domains and common abbreviations inside one sentence", () => {
    expect(facts("My salary is $85.5k.")).toEqual([["financial.note", "$85.5k", "assert", "none"]]);
    expect(facts("I live in St. Louis.")).toEqual([["location.home", "St. Louis", "assert", "none"]]);
    expect(facts("I work at Amazon.com.")).toEqual([["work.employer", "Amazon.com", "assert", "none"]]);
  });

  // what_bug_this_catches: ellipses/closing punctuation inside values and swallowed trailing phrases (review #4).
  it("ends values at ellipses and closing punctuation, and before as/in/on phrases", () => {
    expect(facts("I live in Oslo...")).toEqual([["location.home", "Oslo", "assert", "none"]]);
    expect(facts("I work at Acme…")).toEqual([["work.employer", "Acme", "assert", "none"]]);
    expect(facts("(I live in Oslo.)")).toEqual([["location.home", "Oslo", "assert", "none"]]);
    expect(facts("i live in st. louis.")).toEqual([["location.home", "st. louis", "assert", "none"]]);
    expect(facts("I work at Google as a software engineer.")).toEqual([["work.employer", "Google", "assert", "none"]]);
    expect(facts("I work at Google in London.")).toEqual([["work.employer", "Google", "assert", "none"]]);
    expect(facts("I work as a nurse in Boston.")).toEqual([["work.role", "nurse", "assert", "none"]]);
    expect(facts("I moved to Denver... finally")).toEqual([["location.home", "Denver", "assert", "move"]]);
  });

  // what_bug_this_catches: invented names/preferences and a salary with a trailing comma (review #4).
  it("rejects predicate names, demonstrative preferences and keeps salaries clean", () => {
    expect(facts("My name is actually Ada.")).toEqual([]);
    expect(facts("My name is hard to pronounce.")).toEqual([]);
    expect(facts("I like these suggestions.")).toEqual([]);
    expect(facts("I love where this is going.")).toEqual([]);
    expect(facts("My salary is $64,000, but I want more.")).toEqual([["financial.note", "$64,000", "assert", "none"]]);
    expect(facts("I work as a nurse, not full-time.")).toEqual([]);
    expect(facts("I work at the office.")).toEqual([]);
  });

  // what_bug_this_catches: cues after an ellipsis/comma lost; "St." employers; self-employment as an employer (review #5).
  it("sees temporary/report cues after punctuation, keeps St. employers whole, ignores 'myself'", () => {
    for (const text of ["I live in Lisbon... until June.", "I live in Lisbon… until June.", "I live in Rome... for now.", "I live in Paris... for the summer.", "I moved to Berlin... temporarily.", "I live in Oslo, until June."]) {
      const result = extractCandidates([conv("c", [["user", text]])]);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics.ineligible.temporary).toBe(1);
    }
    expect(facts("I live in Oslo... she said.")).toEqual([]);
    expect(facts("I live in Oslo...and I love it.")).toEqual([["location.home", "Oslo", "assert", "none"]]);
    expect(facts("I work at St. Mary's Hospital.")).toEqual([["work.employer", "St. Mary's Hospital", "assert", "none"]]);
    expect(facts("I work at Mt. Sinai.")).toEqual([["work.employer", "Mt. Sinai", "assert", "none"]]);
    expect(facts("I work for myself.")).toEqual([]);
  });

  // what_bug_this_catches: prefix non-employers, "as ... as" roles, spaced dashes, retractions after punctuation (review #6).
  it("rejects prefix non-employers and comparison roles, stops at dashes, sees 'not' after punctuation", () => {
    expect(facts("I work at least 40 hours a week.")).toEqual([]);
    expect(facts("I work as a nurse at least three days a week.")).toEqual([["work.role", "nurse", "assert", "none"]]);
    expect(facts("I work for free.")).toEqual([]);
    expect(facts("I work for a living.")).toEqual([]);
    expect(facts("I work at Home Depot.")).toEqual([["work.employer", "Home Depot", "assert", "none"]]);
    expect(facts("I work as hard as I can.")).toEqual([]);
    expect(facts("I don't work as hard anymore.")).toEqual([]);
    expect(facts("I work at Google - it's great.")).toEqual([["work.employer", "Google", "assert", "none"]]);
    expect(facts("I live in Denver - not Boulder.")).toEqual([]);
    expect(facts("I live in Denver - not anymore.")).toEqual([]);
    expect(facts("I work at Google... not anymore.")).toEqual([]);
    expect(facts("I work at Google (not anymore).")).toEqual([]);
    expect(facts("I live in Oslo... not anymore.")).toEqual([]);
  });

  // what_bug_this_catches: "--" dashes, times/durations as employers, "as part of"/"as needed" roles (review #7).
  it("handles double-hyphen dashes, time phrases after 'work at', and non-role 'as' phrases", () => {
    expect(facts("I work at Google -- it's great.")).toEqual([["work.employer", "Google", "assert", "none"]]);
    expect(facts("I live in Denver -- not Boulder.")).toEqual([]);
    for (const text of ["I work at 7am so I go to bed early.", "I work at 8am tomorrow.", "I work at 10 tomorrow.", "I work for 12 hours a day.", "I work at 11."]) {
      expect(facts(text)).toEqual([]);
    }
    expect(facts("I work at 3M.")).toEqual([["work.employer", "3M", "assert", "none"]]);
    expect(facts("I work at 7-Eleven.")).toEqual([["work.employer", "7-Eleven", "assert", "none"]]);
    for (const text of ["I work for about 10 hours a day.", "I work for two hours every morning.", "I work for a couple of hours after dinner.", "I work for several hours at a time.", "I work for 8-10 hours a day.", "I work for 10+ hours a day.", "I work for 2–3 hours every morning.", "I work for a while."]) {
      expect(facts(text)).toEqual([]);
    }
    expect(facts("I work at Two Sigma.")).toEqual([["work.employer", "Two Sigma", "assert", "none"]]);
    expect(facts("I work as part of a small team.")).toEqual([]);
    expect(facts("I work as needed.")).toEqual([]);
  });

  // what_bug_this_catches: reported speech with the attribution after the clause.
  it("rejects trailing attributions", () => {
    expect(facts("I live in Oslo, she said.")).toEqual([]);
    expect(facts("'I live in Oslo,' he wrote.")).toEqual([]);
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
