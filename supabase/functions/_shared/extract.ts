import { factId } from "./ids.ts";
import { classifySensitivity } from "./sensitivity.ts";
import type { Fact, FactKind, ParsedMessage, Polarity, Sensitivity } from "./types.ts";

interface Pattern {
  slot: string;
  kind: FactKind;
  confidence: number;
  polarity: Polarity;
  explicitMove: boolean;
  source: string;
  flags: string;
  sensitivityHint?: Sensitivity;
  statement: (value: string) => string;
}

/** Narrow patterns on purpose. They favor precision over a general paraphrase of the chat. */
const PATTERNS: Pattern[] = [
  {
    slot: "name",
    kind: "identity",
    confidence: 0.92,
    polarity: "assert",
    explicitMove: false,
    source: "\\bmy name is\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b",
    flags: "g",
    statement: (value) => `Name is ${value}`,
  },
  {
    slot: "residence",
    kind: "residence",
    confidence: 0.88,
    polarity: "assert",
    explicitMove: false,
    source: "\\bi (?:live|reside) in\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b",
    flags: "g",
    statement: (value) => `Lives in ${value}`,
  },
  {
    slot: "residence",
    kind: "residence",
    confidence: 0.9,
    polarity: "move",
    explicitMove: true,
    source: "\\bi (?:moved|relocated) to\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b",
    flags: "g",
    statement: (value) => `Lives in ${value}`,
  },
  {
    slot: "residence",
    kind: "residence",
    confidence: 0.84,
    polarity: "deny",
    explicitMove: false,
    source: "\\bi (?:don't|do not) live in\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\b",
    flags: "g",
    statement: (value) => `Does not live in ${value}`,
  },
  {
    slot: "job_title",
    kind: "occupation",
    confidence: 0.86,
    polarity: "assert",
    explicitMove: false,
    source: "\\bi work as (?:a |an )?([A-Za-z][A-Za-z ]{1,40}?)(?=\\s+at\\b|\\s+and\\b|[.,;]|$)",
    flags: "gi",
    statement: (value) => `Works as ${value}`,
  },
  {
    slot: "employer",
    kind: "occupation",
    confidence: 0.84,
    polarity: "assert",
    explicitMove: false,
    source: "\\bi work at\\s+([^.,;]{2,80}?)(?=\\s+and\\b|[.,;]|$)",
    flags: "gi",
    statement: (value) => `Works at ${value}`,
  },
  {
    slot: "likes",
    kind: "preference",
    confidence: 0.7,
    polarity: "assert",
    explicitMove: false,
    source: "\\bi (?:like|love|prefer)\\s+([^.,;]{2,80}?)(?=\\s+and\\b|[.,;]|$)",
    flags: "gi",
    statement: (value) => `Likes ${value}`,
  },
  {
    slot: "dislikes",
    kind: "preference",
    confidence: 0.7,
    polarity: "assert",
    explicitMove: false,
    source: "\\bi (?:don't|do not) (?:like|want)\\s+([^.,;]{2,80}?)(?=\\s+and\\b|[.,;]|$)",
    flags: "gi",
    statement: (value) => `Dislikes ${value}`,
  },
  {
    slot: "health_note",
    kind: "health",
    confidence: 0.8,
    polarity: "assert",
    explicitMove: false,
    sensitivityHint: "health",
    source: "\\bi have (?:a |an )?([a-z0-9][a-z0-9 ]{0,40}?allergy)\\b",
    flags: "gi",
    statement: (value) => `Health note: ${value}`,
  },
  {
    slot: "financial_note",
    kind: "financial",
    confidence: 0.86,
    polarity: "assert",
    explicitMove: false,
    sensitivityHint: "financial",
    source: "\\bmy salary is\\s+\\$?([0-9][0-9,]*)\\b",
    flags: "gi",
    statement: (value) => `Financial note: ${value}`,
  },
];

export function kindForSlot(slot: string): FactKind {
  switch (slot) {
    case "name":
      return "identity";
    case "residence":
      return "residence";
    case "job_title":
    case "employer":
      return "occupation";
    case "likes":
    case "dislikes":
      return "preference";
    case "health_note":
      return "health";
    case "financial_note":
      return "financial";
    default:
      return "other";
  }
}

export function statementFor(slot: string, value: string): string {
  switch (slot) {
    case "name":
      return `Name is ${value}`;
    case "residence":
      return `Lives in ${value}`;
    case "job_title":
      return `Works as ${value}`;
    case "employer":
      return `Works at ${value}`;
    case "likes":
      return `Likes ${value}`;
    case "dislikes":
      return `Dislikes ${value}`;
    case "health_note":
      return `Health note: ${value}`;
    case "financial_note":
      return `Financial note: ${value}`;
    default:
      return `${slot}: ${value}`;
  }
}

export function extractFacts(messages: ParsedMessage[]): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const pattern of PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      for (const match of message.text.matchAll(regex)) {
        const captured = match[1];
        if (!captured) continue;
        const value = captured.trim().replace(/\s+/g, " ");
        if (value.length < 2) continue;
        const quote = match[0];
        const start = match.index ?? 0;
        const end = start + quote.length;
        if (message.text.slice(start, end) !== quote) continue;
        const id = factId(pattern.slot, value, pattern.polarity);
        if (seen.has(id)) continue;
        seen.add(id);
        const fromQuote = classifySensitivity(quote);
        const sensitivity = fromQuote === "none" && pattern.sensitivityHint ? pattern.sensitivityHint : fromQuote;
        facts.push({
          id,
          slot: pattern.slot,
          value,
          statement: pattern.statement(value),
          kind: pattern.kind,
          sensitivity,
          confidence: pattern.confidence,
          status: "proposed",
          validFrom: message.createdAt,
          invalidAt: null,
          supersededBy: null,
          sourceKind: "mined_history",
          userEdited: false,
          confirmationReason: null,
          polarity: pattern.polarity,
          explicitMove: pattern.explicitMove,
          provenance: {
            conversationId: message.conversationId,
            messageId: message.messageId,
            quote,
            start,
            end,
            ordinal: message.ordinal,
          },
        });
      }
    }
  }
  return facts;
}
