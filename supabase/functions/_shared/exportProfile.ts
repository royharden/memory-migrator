import type { AuditEvent, Fact } from "./types.ts";

export interface ProfileBundle {
  format: "memory-migrator.profile";
  formatVersion: 1;
  note: string;
  tombstones: string[];
  facts: Fact[];
  audit: AuditEvent[];
}

const BUNDLE_NOTE =
  "Content-derived ids, tombstones applied before additions, and an audit log. Not a MacPaw .mem bundle.";

function tombstoneIds(facts: Fact[]): Set<string> {
  return new Set(facts.filter((fact) => fact.status === "tombstoned").map((fact) => fact.id));
}

export function confirmedFacts(facts: Fact[]): Fact[] {
  const buried = tombstoneIds(facts);
  return facts.filter((fact) => fact.status === "confirmed" && !buried.has(fact.id));
}

function quoteLine(fact: Fact): string {
  const edited = fact.userEdited ? " Edited by the user; the quote is the original source." : "";
  return `Source message ${fact.provenance.messageId} in ${fact.provenance.conversationId}. Quote: "${fact.provenance.quote}".${edited}`;
}

export function renderMarkdown(facts: Fact[], title: string): string {
  const buried = tombstoneIds(facts);
  const confirmed = confirmedFacts(facts);
  const waiting = facts.filter(
    (fact) =>
      !buried.has(fact.id) && (fact.status === "proposed" || fact.status === "needs_confirmation"),
  );
  const superseded = facts.filter((fact) => fact.status === "superseded");
  const removed = facts.filter((fact) => fact.status === "tombstoned");
  const lines = [
    `# ${title}`,
    "",
    "Mined from chat history. This is not the vendor's saved-memory field. Tombstoned ids are omitted from the facts below.",
    "",
    "## Confirmed",
  ];
  if (confirmed.length === 0) lines.push("", "None yet. Confirm a fact to include it.");
  for (const fact of confirmed) {
    lines.push("", `- ${fact.statement}`, `  - ${quoteLine(fact)}`);
  }
  lines.push("", "## Awaiting confirmation");
  if (waiting.length === 0) lines.push("", "None.");
  for (const fact of waiting) {
    const reason = fact.confirmationReason ? ` (${fact.confirmationReason})` : "";
    lines.push("", `- ${fact.statement}${reason}`, `  - ${quoteLine(fact)}`);
  }
  lines.push("", "## Superseded");
  if (superseded.length === 0) lines.push("", "None.");
  for (const fact of superseded) {
    lines.push("", `- ${fact.statement}`, `  - Superseded by ${fact.supersededBy ?? "a later fact"}.`);
  }
  lines.push("", "## Removed");
  if (removed.length === 0) lines.push("", "None.");
  for (const fact of removed) {
    lines.push("", `- ${fact.slot} \`${fact.id}\` (quote omitted)`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderPrompt(facts: Fact[]): string {
  const confirmed = confirmedFacts(facts);
  const lines = [
    "You are assisting one person. Use only the confirmed facts below. Each fact cites a source quote. If a fact is not listed, say you do not know. Do not invent memories.",
    "",
  ];
  if (confirmed.length === 0) {
    lines.push("Confirmed facts: none.");
  }
  for (const fact of confirmed) {
    lines.push(`- ${fact.statement} Source message ${fact.provenance.messageId}. Quote: "${fact.provenance.quote}".`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildBundle(facts: Fact[], events: AuditEvent[]): ProfileBundle {
  const buried = tombstoneIds(facts);
  return {
    format: "memory-migrator.profile",
    formatVersion: 1,
    note: BUNDLE_NOTE,
    tombstones: [...buried],
    facts: facts.filter((fact) => !buried.has(fact.id)),
    audit: events,
  };
}

export function renderBundle(facts: Fact[], events: AuditEvent[]): string {
  return JSON.stringify(buildBundle(facts, events), null, 2);
}
