import type { Evidence } from "./evidence.ts";
import { evidenceKey, evidenceShapeErrors } from "./evidence.ts";
import { openGroupMembers } from "./groups.ts";
import { LIMITS } from "./limits.ts";
import {
  currentRevision,
  isSuppressed,
  linksFor,
  openRestoration,
  type Generation,
  type ProfileState,
  type Revision,
  type Slot,
} from "./model.ts";
import { codePointLength } from "./unicode.ts";

/**
 * ONE export predicate (PLAN §5/§7) drives Markdown, prompt, portable JSON, previews
 * and version publication: current approved revision; structurally valid evidence;
 * not rejected/superseded/hidden/erased/suppressed; no open affected group; sensitive
 * only when confirmed for this revision AND included for this export.
 */
export interface ExportOptions {
  includeSensitive: boolean;
}

export type ExclusionReason =
  | "not_live"
  | "not_approved"
  | "stale_approval"
  | "superseded"
  | "suppressed"
  | "open_group"
  | "no_valid_evidence"
  | "sensitive_unconfirmed"
  | "sensitive_not_included"
  | "purged";

export interface ProjectionItem {
  generation: Generation;
  revision: Revision;
  evidence: Evidence[];
}

function validEvidence(state: ProfileState, id: string): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const link of linksFor(state, id)) {
    if (!link.evidence || evidenceShapeErrors(link.evidence).length > 0) continue;
    const key = evidenceKey(link.evidence);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link.evidence);
  }
  return out.sort(compareEvidence);
}

/** Evidence sorts by its compound identity. */
export function compareEvidence(a: Evidence, b: Evidence): number {
  const ka = [a.sourceDigest, a.conversationId, a.messageId, a.textSha256];
  const kb = [b.sourceDigest, b.conversationId, b.messageId, b.textSha256];
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return a.start - b.start || a.end - b.end;
}

export function exclusionReason(state: ProfileState, g: Generation, options: ExportOptions, openMembers = openGroupMembers(state)): ExclusionReason | null {
  if (g.lifecycle !== "live") return "not_live";
  const rev = currentRevision(g);
  if (rev.value === null || rev.assertion === null) return "purged";
  if (g.review !== "approved") return "not_approved";
  if (g.approvedRevision !== g.currentRevision) return "stale_approval";
  if (g.superseded) return "superseded";
  const suppressedKey = g.aliasKeys.find((key) => isSuppressed(state, key) && openRestoration(state, key)?.generationId !== g.id);
  if (suppressedKey) return "suppressed";
  if (openMembers.has(g.id)) return "open_group";
  if (validEvidence(state, g.id).length === 0) return "no_valid_evidence";
  if (g.sensitivity.length > 0) {
    if (g.sensitivityConfirmedRevision !== g.currentRevision) return "sensitive_unconfirmed";
    if (!options.includeSensitive) return "sensitive_not_included";
  }
  return null;
}

/** The eligible projection, ordered by generation id. */
export function exportProjection(state: ProfileState, options: ExportOptions): ProjectionItem[] {
  const openMembers = openGroupMembers(state);
  return Object.values(state.generations)
    .filter((g) => exclusionReason(state, g, options, openMembers) === null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((generation) => ({ generation, revision: currentRevision(generation), evidence: validEvidence(state, generation.id) }));
}

export function exclusionSummary(state: ProfileState, options: ExportOptions): Record<ExclusionReason, number> {
  const counts = {
    not_live: 0,
    not_approved: 0,
    stale_approval: 0,
    superseded: 0,
    suppressed: 0,
    open_group: 0,
    no_valid_evidence: 0,
    sensitive_unconfirmed: 0,
    sensitive_not_included: 0,
    purged: 0,
  } satisfies Record<ExclusionReason, number>;
  const openMembers = openGroupMembers(state);
  for (const g of Object.values(state.generations)) {
    const reason = exclusionReason(state, g, options, openMembers);
    if (reason) counts[reason] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Markdown and paste prompt (rendered only from the projection)
// ---------------------------------------------------------------------------

const SECTION_ORDER: Array<{ title: string; slots: Slot[] }> = [
  { title: "Identity", slots: ["identity.name"] },
  { title: "Home", slots: ["location.home"] },
  { title: "Work", slots: ["work.role", "work.employer"] },
  { title: "Preferences", slots: ["preference.likes", "preference.dislikes"] },
  { title: "Health (sensitive, included by choice)", slots: ["health.note"] },
  { title: "Finances (sensitive, included by choice)", slots: ["financial.note"] },
];

function mdEscape(text: string): string {
  return text.replace(/[\\`*_{}[\]<>#|]/g, (c) => `\\${c}`);
}

export function renderMarkdown(items: ProjectionItem[], options: ExportOptions): string {
  const lines: string[] = [
    "# Portable memory profile",
    "",
    "Every statement below was reviewed and approved by me. Quotes show the exact words in my own ChatGPT messages; they show the words occurred, not that they are true.",
    options.includeSensitive ? "Sensitive facts I confirmed are included in this copy." : "Sensitive facts are not included in this copy.",
    "",
  ];
  for (const section of SECTION_ORDER) {
    const inSection = items.filter((item) => section.slots.includes(item.revision.slot));
    if (inSection.length === 0) continue;
    lines.push(`## ${section.title}`, "");
    for (const item of inSection) {
      const wording = item.revision.userAuthored ? " _(my edited wording)_" : " _(wording from my messages)_";
      const scope = item.generation.scopeNote ? ` — scope: ${mdEscape(item.generation.scopeNote)}` : "";
      lines.push(`- ${mdEscape(item.revision.assertion as string)}${wording}${scope}`);
      for (const e of item.evidence) {
        lines.push(`  - conversation \`${mdEscape(e.conversationId)}\`, message \`${mdEscape(e.messageId)}\`${e.sourceTime ? `, ${e.sourceTime}` : ""}:`);
        for (const quoteLine of e.quote.split("\n")) lines.push(`    > ${mdEscape(quoteLine)}`);
      }
    }
    lines.push("");
  }
  if (items.length === 0) lines.push("_No approved facts are eligible for export._", "");
  return lines.join("\n");
}

export interface PromptResult {
  text: string;
  length: number;
  budget: number;
  included: string[];
  omitted: string[];
}

const PROMPT_HEADER = "Background about me that I reviewed myself. Use it when relevant; ask if something seems out of date.";

/**
 * Paste prompt: reviewed statements only, no quotes or IDs. Whole facts in section
 * priority order until the user-set code-point budget (counted on the final text,
 * header included) is reached; facts are never split.
 */
export function renderPrompt(items: ProjectionItem[], budget: number = LIMITS.defaultPromptBudget): PromptResult {
  const ordered = SECTION_ORDER.flatMap((section) => items.filter((item) => section.slots.includes(item.revision.slot)));
  let text = PROMPT_HEADER;
  const included: string[] = [];
  const omitted: string[] = [];
  if (codePointLength(text) > budget) return { text: "", length: 0, budget, included, omitted: ordered.map((i) => i.generation.id) };
  for (const item of ordered) {
    const scope = item.generation.scopeNote ? ` (${item.generation.scopeNote})` : "";
    const candidate = `${text}\n- ${item.revision.assertion}${scope}`;
    if (codePointLength(candidate) <= budget) {
      text = candidate;
      included.push(item.generation.id);
    } else omitted.push(item.generation.id);
  }
  return { text, length: codePointLength(text), budget, included, omitted };
}
