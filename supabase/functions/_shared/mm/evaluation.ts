import { canonicalSha256 } from "./canonical.ts";
import { checkEvidence, messageLookupKey, type Evidence } from "./evidence.ts";
import { emptyProfile, isSlot, EXTRACTOR_VERSION, type Ctx, type Polarity, type SensitivityCategory } from "./model.ts";
import { extractSelected, inventoryShard, mergeInventories, selectConversations } from "./parser.ts";
import { previewCandidateImport } from "./reducer.ts";
import { extractCandidates } from "./rules.ts";
import { classifyText } from "./sensitivity.ts";
import { PARSER_VERSION, type CanonicalMessage, type ParsedConversation } from "./source.ts";
import { normalizeExact, utf16ToCodePoint } from "./unicode.ts";

/**
 * Synthetic extraction + eligibility evaluation (PLAN §12). Runs the real parser,
 * rules and reducer over a frozen fixture and reports raw counts with denominators.
 * Zero denominators are reported as null ("n/a"). Proposed targets are proposals,
 * never results; nothing here is a quality claim unless it was actually executed.
 */

export interface GoldLabel {
  id: string;
  conversationId: string;
  messageId: string;
  quote: string;
  slot: string;
  value: string;
  polarity: Polarity;
  supported: boolean;
  sensitivity: SensitivityCategory[];
  /** V3 pins the exact source occurrence; older regression editions omit it. */
  source?: Evidence;
  assertion?: string;
  eligible?: boolean;
  durable?: boolean;
  groupIds?: string[];
  groupRationale?: string;
}

export interface EvalDataset {
  id: string;
  split: string;
  export: unknown[];
  labels: GoldLabel[];
  groups: Array<{ id: string; slot: string; members: string[]; reason?: string }>;
  sensitivityCases: Array<{ conversationId: string; messageId: string; categories: SensitivityCategory[] }>;
  eligibility: Array<{ text: string; eligible: boolean }>;
  provenance?: { rulesAtFreeze: string; parserAtFreeze: string; labelReview: string };
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface EvalReport {
  datasetId: string;
  split: string;
  datasetSha256: string;
  parserVersion: string;
  extractorVersion: string;
  conversations: number;
  goldOccurrences: number;
  goldFactsSupported: number;
  goldFactsAll: number;
  predictedOccurrences: number;
  predictedFacts: number;
  overall: Counts;
  perSlot: Record<string, Counts>;
  supportedSlotRecall: number | null;
  wholeCorpusRecall: number | null;
  occurrenceCoverage: { matched: number; total: number; rate: number | null };
  eligibility: Counts & { sentences: number };
  groups: { goldGroups: number; predictedGroups: number; matchedGold: number; correctPredicted: number; precision: number | null; recall: number | null };
  sensitivity: { labelledMisses: number; labelledTotal: number; caseMisses: number; caseTotal: number };
  evidence: { candidates: number; verified: number; failures: number; provenanceCoverage: number | null };
  proposedTargets: { supportedSlotPrecision: number; supportedSlotRecall: number; resolvableEvidence: number };
  limitations: string[];
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function counts(tp: number, fp: number, fn: number): Counts {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

function factKey(slot: string, value: string, polarity: string): string {
  return `${slot}\u0000${normalizeExact(value)}\u0000${polarity}`;
}

interface GoldSpan {
  label: GoldLabel;
  start: number;
  end: number;
}

/** Resolve pinned V3 evidence without running extraction. Never fall back from an
 * invalid pin to a matching quote elsewhere; legacy quotes must be unambiguous. */
export function resolveGoldSpan(label: GoldLabel, messages: Map<string, CanonicalMessage>): GoldSpan | null {
  const message = messages.get(messageLookupKey(label.conversationId, label.messageId));
  if (!message) return null;
  if (label.source) {
    const evidence = label.source;
    if (evidence.conversationId !== label.conversationId || evidence.messageId !== label.messageId || evidence.quote !== label.quote ||
        evidence.sourceTime !== message.sourceTime || checkEvidence(evidence, messages) !== "verified") return null;
    return { label, start: evidence.start, end: evidence.end };
  }
  const at = message.text.indexOf(label.quote);
  if (at < 0 || message.text.indexOf(label.quote, at + 1) >= 0) return null;
  return { label, start: utf16ToCodePoint(message.text, at), end: utf16ToCodePoint(message.text, at + label.quote.length) };
}

function parseDataset(ds: EvalDataset): ParsedConversation[] {
  const inv = inventoryShard(ds.export, 0, ds.id, null);
  const selection = { conversationIds: null, from: null, to: null, includeUnknownDate: true, branchChoices: {} };
  const selected = selectConversations(mergeInventories([inv]), selection);
  return extractSelected(ds.export, 0, selected, selection, { messages: 0, textBytes: 0 }).conversations;
}

function overlap(aStart: number, aEnd: number, g: GoldSpan): number {
  const inter = Math.max(0, Math.min(aEnd, g.end) - Math.max(aStart, g.start));
  return inter / (g.end - g.start);
}

export function evaluate(ds: EvalDataset, ctx: Ctx): EvalReport {
  const conversations = parseDataset(ds);
  const messages = new Map<string, CanonicalMessage>();
  for (const c of conversations) for (const m of c.messages) messages.set(messageLookupKey(m.conversationId, m.messageId), m);

  // V3 spans are pinned and verified; legacy editions require unique quotes.
  const gold: GoldSpan[] = [];
  const limitations: string[] = [];
  for (const label of ds.labels) {
    const span = resolveGoldSpan(label, messages);
    if (!span) {
      limitations.push(`Gold label ${label.id} could not be located in the parsed source.`);
      continue;
    }
    gold.push(span);
  }

  const { candidates } = extractCandidates(conversations);

  // One-to-one occurrence matching: highest overlap first, then stable ids.
  const pairs: Array<{ g: number; p: number; ov: number }> = [];
  candidates.forEach((c, p) => {
    gold.forEach((g, gi) => {
      const l = g.label;
      if (!l.supported || !isSlot(l.slot)) return;
      if (c.slot !== l.slot || c.polarity !== l.polarity || normalizeExact(c.value) !== normalizeExact(l.value)) return;
      if (c.evidence.conversationId !== l.conversationId || c.evidence.messageId !== l.messageId) return;
      if (l.source && c.evidence.sourceDigest !== l.source.sourceDigest) return;
      const ov = overlap(c.evidence.start, c.evidence.end, g);
      if (ov >= 0.5) pairs.push({ g: gi, p, ov });
    });
  });
  pairs.sort((a, b) => b.ov - a.ov || (gold[a.g].label.id < gold[b.g].label.id ? -1 : gold[a.g].label.id > gold[b.g].label.id ? 1 : 0) || a.p - b.p);
  const goldMatched = new Map<number, number>();
  const predMatched = new Map<number, number>();
  for (const pair of pairs) {
    if (goldMatched.has(pair.g) || predMatched.has(pair.p)) continue;
    goldMatched.set(pair.g, pair.p);
    predMatched.set(pair.p, pair.g);
  }

  // Fact-level scoring: repeated identical statements do not inflate scores.
  const goldFacts = new Map<string, { slot: string; supported: boolean; matched: boolean }>();
  gold.forEach((g, gi) => {
    const key = factKey(g.label.slot, g.label.value, g.label.polarity);
    const entry = goldFacts.get(key) ?? { slot: g.label.slot, supported: g.label.supported && isSlot(g.label.slot), matched: false };
    if (goldMatched.has(gi)) entry.matched = true;
    goldFacts.set(key, entry);
  });
  const predFacts = new Map<string, { slot: string; matched: boolean }>();
  candidates.forEach((c, p) => {
    const key = factKey(c.slot, c.value, c.polarity);
    const entry = predFacts.get(key) ?? { slot: c.slot, matched: false };
    if (predMatched.has(p)) entry.matched = true;
    predFacts.set(key, entry);
  });

  const slots = new Set<string>([...[...goldFacts.values()].filter((g) => g.supported).map((g) => g.slot), ...[...predFacts.values()].map((p) => p.slot)]);
  const perSlot: Record<string, Counts> = {};
  for (const slot of [...slots].sort()) {
    const g = [...goldFacts.values()].filter((x) => x.supported && x.slot === slot);
    const p = [...predFacts.values()].filter((x) => x.slot === slot);
    perSlot[slot] = counts(g.filter((x) => x.matched).length, p.filter((x) => !x.matched).length, g.filter((x) => !x.matched).length);
  }
  const supportedGold = [...goldFacts.values()].filter((g) => g.supported);
  const tp = supportedGold.filter((g) => g.matched).length;
  const fp = [...predFacts.values()].filter((p) => !p.matched).length;
  const fn = supportedGold.length - tp;
  const overall = counts(tp, fp, fn);

  // Eligibility: positive = the extractor emits at least one candidate for the sentence.
  let etp = 0, efp = 0, efn = 0;
  ds.eligibility.forEach((item, i) => {
    const conv: ParsedConversation = {
      id: `elig-${i}`,
      title: "eligibility",
      sourceDigest: "0".repeat(64),
      createTime: null,
      updateTime: null,
      messages: [{ sourceDigest: "0".repeat(64), conversationId: `elig-${i}`, messageId: `e${i}`, nodeId: `e${i}`, role: "user", text: item.text, textSha256: "0".repeat(64), sourceTime: null, ordinal: 0 }],
    };
    const emitted = extractCandidates([conv]).candidates.length > 0;
    if (emitted && item.eligible) etp += 1;
    else if (emitted && !item.eligible) efp += 1;
    else if (!emitted && item.eligible) efn += 1;
  });

  // Groups: compare gold groups and predicted groups by their member fact identities.
  // Groups are scored per conversation: each synthetic conversation is its own persona/profile,
  // matching the per-conversation gold groups (a whole fixture is not one person's profile).
  const predictedGroups: string[][] = [];
  for (const conversation of conversations) {
    const own = candidates.filter((c) => c.evidence.conversationId === conversation.id);
    if (own.length === 0) continue;
    const preview = previewCandidateImport(emptyProfile(`eval-${conversation.id}`), own, ctx, PARSER_VERSION);
    if ("error" in preview) {
      limitations.push(preview.error);
      continue;
    }
    for (const group of Object.values(preview.next.groups)) {
      if (group.state !== "open") continue;
      predictedGroups.push(
        group.members
          .map((m) => {
            const rev = preview.next.generations[m.generationId]?.revisions[0];
            return rev && rev.value !== null ? factKey(rev.slot, rev.value, rev.polarity) : "";
          })
          .sort(),
      );
    }
  }
  const labelById = new Map(ds.labels.map((l) => [l.id, l]));
  const goldGroups = ds.groups.map((g) =>
    [...new Set(g.members.map((id) => labelById.get(id)).filter((l): l is GoldLabel => Boolean(l)).map((l) => factKey(l.slot, l.value, l.polarity)))].sort(),
  );
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const matchedGold = goldGroups.filter((g) => predictedGroups.some((p) => same(p, g))).length;
  const correctPredicted = predictedGroups.filter((p) => goldGroups.some((g) => same(p, g))).length;

  // Sensitivity: labelled facts whose matched candidate misses a category, plus whole-message cases.
  let labelledMisses = 0, labelledTotal = 0;
  gold.forEach((g, gi) => {
    if (g.label.sensitivity.length === 0) return;
    labelledTotal += 1;
    const p = goldMatched.get(gi);
    const got = p === undefined ? classifyText(g.label.quote) : candidates[p].sensitivity;
    if (!g.label.sensitivity.every((s) => got.includes(s))) labelledMisses += 1;
  });
  let caseMisses = 0;
  for (const sc of ds.sensitivityCases) {
    const m = messages.get(messageLookupKey(sc.conversationId, sc.messageId));
    const got = m ? classifyText(m.text) : [];
    if (!sc.categories.every((c) => got.includes(c))) caseMisses += 1;
  }

  // Evidence: every candidate must resolve against the attached source.
  const verified = candidates.filter((c) => checkEvidence(c.evidence, messages) === "verified").length;

  limitations.push(
    `Synthetic fixture with ${ds.labels.length} labels in ${conversations.length} conversations: far too small for confidence intervals; treat numbers as smoke indicators.`,
    ds.provenance?.labelReview ?? "Legacy labels and rules were written by the same agent; see the manifest for independent-audit status.",
    "Retrieval benchmarks (and LoCoMo) cannot establish this extractor's quality; none are used.",
    ds.provenance && ds.provenance.rulesAtFreeze === EXTRACTOR_VERSION && ds.provenance.parserAtFreeze === PARSER_VERSION
      ? "This is a revised synthetic smoke split with frozen parser/rule versions. It is not an unseen benchmark; independent label review and quality acceptance are separate."
      : "Legacy or version-mismatched split: do not claim held-out quality. See the manifest and edition history.",
    "Fact identity is counted corpus-wide (identical facts in different conversations count once); conflict groups are scored per conversation.",
    "Sensitivity misses for labels the extractor did not emit are judged on the gold quote's text classification, not on an extracted fact.",
  );

  return {
    datasetId: ds.id,
    split: ds.split,
    datasetSha256: canonicalSha256(ds),
    parserVersion: PARSER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    conversations: conversations.length,
    goldOccurrences: gold.filter((g) => g.label.supported).length,
    goldFactsSupported: supportedGold.length,
    goldFactsAll: goldFacts.size,
    predictedOccurrences: candidates.length,
    predictedFacts: predFacts.size,
    overall,
    perSlot,
    supportedSlotRecall: ratio(tp, supportedGold.length),
    wholeCorpusRecall: ratio(tp, goldFacts.size),
    occurrenceCoverage: { matched: goldMatched.size, total: gold.filter((g) => g.label.supported && isSlot(g.label.slot)).length, rate: ratio(goldMatched.size, gold.filter((g) => g.label.supported && isSlot(g.label.slot)).length) },
    eligibility: { ...counts(etp, efp, efn), sentences: ds.eligibility.length },
    groups: { goldGroups: goldGroups.length, predictedGroups: predictedGroups.length, matchedGold, correctPredicted, precision: ratio(correctPredicted, predictedGroups.length), recall: ratio(matchedGold, goldGroups.length) },
    sensitivity: { labelledMisses, labelledTotal, caseMisses, caseTotal: ds.sensitivityCases.length },
    evidence: { candidates: candidates.length, verified, failures: candidates.length - verified, provenanceCoverage: ratio(verified, candidates.length) },
    proposedTargets: { supportedSlotPrecision: 0.9, supportedSlotRecall: 0.6, resolvableEvidence: 1 },
    limitations,
  };
}
