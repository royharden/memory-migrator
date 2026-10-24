import { makeEvidence } from "./evidence.ts";
import { EXTRACTOR_VERSION, renderAssertion, type Candidate, type ChangeCue, type Polarity, type Slot } from "./model.ts";
import { classifyCandidate } from "./sensitivity.ts";
import type { CanonicalMessage, ParsedConversation } from "./source.ts";

/**
 * Conservative deterministic extractor over the fixed eight-slot catalogue (PLAN §5).
 * Contract: normalized selected messages -> pending atomic candidates, evidence and
 * diagnostics. It never writes, approves, deletes or resolves groups. Only ordinary
 * user text is read; assistant text is local context only.
 */

export type IneligibleReason = "question" | "hypothetical" | "reported" | "third_party" | "code" | "temporary" | "instruction";
export type AbstainReason = "bad_value" | "quote_too_long" | "ambiguous";

export interface ExtractDiagnostics {
  conversations: number;
  userMessages: number;
  assistantMessagesSkipped: number;
  candidates: number;
  ineligible: Record<IneligibleReason, number>;
  abstained: Record<AbstainReason, number>;
  /** Historical "forget/remove" requests: surfaced for manual review, never executed. IDs only. */
  forgetRequests: Array<{ conversationId: string; messageId: string }>;
}

export interface ExtractResult {
  candidates: Candidate[];
  diagnostics: ExtractDiagnostics;
}

/** Future extractor seam (e.g. a provider-backed adapter in F3). MVP ships only the rules extractor. */
export type Extractor = (conversations: ParsedConversation[]) => ExtractResult;

const END = String.raw`(?=\s+(?:and|but|so|because|since|though|although|while|which|who|where|when|with|for|from|anymore|any more|now|too|as well|these days|instead)\b|\s*[,.;:!?\n"“”()]|\s*$)`;
const ROLE_END = String.raw`(?=\s+(?:at|and|but|so|because|since|though|although|while|which|who|where|when|with|for|from|anymore|any more|now|too|these days)\b|\s*[,.;:!?\n"“”()]|\s*$)`;
// Home values additionally stop before temporary/time cues so TEMPORARY can see them.
const HOME_END = String.raw`(?=\s+(?:and|but|so|because|since|though|although|while|which|who|where|when|with|for|from|anymore|any more|now|too|as well|these days|instead|until|till|temporarily|this|right now|at the moment|on vacation|on holiday|on a trip|on business|last|next|ago)\b|\s*[,.;:!?\n"“”()]|\s*$)`;
const NAME = String.raw`\p{L}[\p{L}\p{M}'’\-]*(?:\s+\p{L}[\p{L}\p{M}'’\-]*){0,3}?`;
const PLACE = String.raw`\p{L}[\p{L}\p{M}\p{N}'’.\- ]{0,60}?`;
const ROLE = String.raw`\p{L}[\p{L}\p{M}\p{N}'’\- ]{0,40}?`;
const ORG = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}'’&.\- ]{0,60}?`;
const THING = String.raw`[\p{L}\p{N}][\p{L}\p{M}\p{N}'’&\- ]{0,60}?`;
const MONEY = String.raw`(?:[$€£]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|thousand|million))?(?:\s(?:dollars|usd|euros|pounds))?`;
const NEG = String.raw`(?:no longer|don['’]?t|do not)`;

interface Emission {
  slot: Slot;
  polarity: Polarity;
  cue: ChangeCue;
  group: string;
  /** Group whose end closes the supporting span (defaults to `group`). */
  spanGroup?: string;
}

interface Rule {
  id: string;
  re: RegExp;
  emit: (m: RegExpMatchArray) => Emission[];
}

function rx(body: string): RegExp {
  return new RegExp(body, "giud");
}

function hasAnymore(m: RegExpMatchArray): boolean {
  return Boolean(m.groups?.any);
}

// Combining marks (\p{M}) stay inside values so decomposed text such as "Zürich" is not cut.
const ANY = String.raw`(?<any>\s+any ?more)?`;

/** Ordered: specific negations first; a later rule cannot reuse a claimed clause start. */
const RULES: Rule[] = [
  // identity.name
  { id: "name.deny", re: rx(String.raw`\bmy name (?:is not|isn['’]t) (?<v>${NAME})${END}`), emit: () => [{ slot: "identity.name", polarity: "deny", cue: "correction", group: "v" }] },
  { id: "name.assert", re: rx(String.raw`\bmy name is (?<v>${NAME})${END}`), emit: () => [{ slot: "identity.name", polarity: "assert", cue: "none", group: "v" }] },
  // location.home
  { id: "home.used_to", re: rx(String.raw`\bi used to (?:live|reside) in (?<v>${PLACE})${HOME_END}`), emit: () => [{ slot: "location.home", polarity: "deny", cue: "retraction", group: "v" }] },
  { id: "home.deny", re: rx(String.raw`\bi ${NEG} (?:live|reside) in (?<v>${PLACE})${HOME_END}${ANY}`), emit: (m) => [{ slot: "location.home", polarity: "deny", cue: m[0].toLowerCase().includes("no longer") || hasAnymore(m) ? "retraction" : "none", group: "v", spanGroup: hasAnymore(m) ? "any" : "v" }] },
  { id: "home.move", re: rx(String.raw`\bi(?:['’]ve| have)?(?: just| recently)? (?:moved|relocated) to (?<v>${PLACE})${HOME_END}`), emit: () => [{ slot: "location.home", polarity: "assert", cue: "move", group: "v" }] },
  { id: "home.assert", re: rx(String.raw`\bi (?:currently |now |still )?(?:live|reside) in (?<v>${PLACE})${HOME_END}`), emit: () => [{ slot: "location.home", polarity: "assert", cue: "none", group: "v" }] },
  // work.role / work.employer
  { id: "role.used_to", re: rx(String.raw`\bi used to work as (?:an? |the )?(?<v>${ROLE})${ROLE_END}`), emit: () => [{ slot: "work.role", polarity: "deny", cue: "retraction", group: "v" }] },
  { id: "role.deny", re: rx(String.raw`\bi ${NEG} work as (?:an? |the )?(?<v>${ROLE})${ROLE_END}${ANY}`), emit: (m) => [{ slot: "work.role", polarity: "deny", cue: m[0].toLowerCase().includes("no longer") || hasAnymore(m) ? "retraction" : "none", group: "v", spanGroup: hasAnymore(m) ? "any" : "v" }] },
  { id: "employer.used_to", re: rx(String.raw`\bi used to work (?:at|for) (?<e>${ORG})${END}`), emit: () => [{ slot: "work.employer", polarity: "deny", cue: "retraction", group: "e" }] },
  { id: "employer.deny", re: rx(String.raw`\bi ${NEG} work (?:at|for) (?<e>${ORG})${END}${ANY}`), emit: (m) => [{ slot: "work.employer", polarity: "deny", cue: m[0].toLowerCase().includes("no longer") || hasAnymore(m) ? "retraction" : "none", group: "e", spanGroup: hasAnymore(m) ? "any" : "e" }] },
  {
    id: "role.assert",
    re: rx(String.raw`\bi work as (?:an? |the )?(?<v>${ROLE})${ROLE_END}(?:\s+at\s+(?<e>${ORG})${END})?`),
    emit: (m) => {
      const out: Emission[] = [{ slot: "work.role", polarity: "assert", cue: "none", group: "v" }];
      if (m.groups?.e) out.push({ slot: "work.employer", polarity: "assert", cue: "none", group: "e" });
      return out;
    },
  },
  { id: "employer.assert", re: rx(String.raw`\bi work (?:at|for) (?<e>${ORG})${END}`), emit: () => [{ slot: "work.employer", polarity: "assert", cue: "none", group: "e" }] },
  // preferences
  { id: "likes.deny", re: rx(String.raw`\bi (?:no longer (?:like|love|enjoy)|don['’]?t (?:like|love|enjoy) (?=.*\bany ?more\b)) ?(?<v>${THING})${END}${ANY}`), emit: (m) => [{ slot: "preference.likes", polarity: "deny", cue: "retraction", group: "v", spanGroup: hasAnymore(m) ? "any" : "v" }] },
  { id: "dislikes.assert", re: rx(String.raw`\bi (?:really )?(?:dislike|hate|can['’]?t stand|don['’]?t like|do not like) (?<v>${THING})${END}`), emit: () => [{ slot: "preference.dislikes", polarity: "assert", cue: "none", group: "v" }] },
  { id: "likes.assert", re: rx(String.raw`\bi (?:really |also )?(?:like|love|enjoy) (?<v>${THING})${END}`), emit: () => [{ slot: "preference.likes", polarity: "assert", cue: "none", group: "v" }] },
  // health.note (explicit allergy statements only)
  { id: "health.deny", re: rx(String.raw`\bi(?:['’]m| am) not (?<v>allergic to ${THING})${END}`), emit: () => [{ slot: "health.note", polarity: "deny", cue: "none", group: "v" }] },
  { id: "health.allergic", re: rx(String.raw`\bi(?:['’]m| am) (?<v>allergic to ${THING})${END}`), emit: () => [{ slot: "health.note", polarity: "assert", cue: "none", group: "v" }] },
  { id: "health.allergy", re: rx(String.raw`\bi have (?:an? |a severe |a mild )?(?<v>[\p{L}\p{N}][\p{L}\p{N}\- ]{0,40}? allergy)${END}`), emit: () => [{ slot: "health.note", polarity: "assert", cue: "none", group: "v" }] },
  // financial.note (explicit salary statements only)
  { id: "finance.salary", re: rx(String.raw`\bmy (?:annual |yearly |monthly )?(?:salary|income) is (?<v>${MONEY})${END}`), emit: () => [{ slot: "financial.note", polarity: "assert", cue: "none", group: "v" }] },
  { id: "finance.earn", re: rx(String.raw`\bi (?:earn|make) (?<v>${MONEY} (?:a|per) (?:year|month))${END}`), emit: () => [{ slot: "financial.note", polarity: "assert", cue: "none", group: "v" }] },
];

const VALUE_STOPWORDS = new Set(["it", "that", "this", "them", "him", "her", "you", "your", "when", "how", "what", "to", "being", "there", "here", "i", "me", "my", "so", "very", "a", "an", "the"]);
// "X, not Y" only when Y ends the clause; "not far from Y" and similar compounds abstain.
const CORRECTION_TAIL = new RegExp(String.raw`^,?\s+not\s+(?<y>${PLACE})(?=\s*[.!?;\n]|\s*$)`, "iud");
const NOT_A_TARGET = /^(?:far|too|very|so|quite|exactly|really|just|only|even|yet|that|sure)\b/iu;
// Objects of "at" that are not employers ("I work as a nurse at night").
const NON_ORG = /^(?:night|nights|home|work|the moment|the weekend|weekends|the same time|times|first|least|most|my desk|a desk)$/iu;
const CORRECTION_SLOTS: Slot[] = ["identity.name", "location.home", "work.employer", "work.role"];

const HYPOTHETICAL = /\b(?:if|suppose|supposing|imagine|hypothetically|what if|let['’]s say|would|could|might|wish|unless|in case|maybe|someday|one day)\b/iu;
const REPORTED = /\b(?:said|says|told|tells|think|thinks|thought|believe|believes|claim|claims|claimed|asked|wrote|writes|according to|quote|quoting|heard)\b/iu;
const THIRD_PARTY = /\b(?:he|she|they|his|her|their|my (?:friend|brother|sister|mom|mother|dad|father|boss|colleague|cousin|neighbou?r|roommate|son|daughter|wife|husband|partner))\b/iu;
const INSTRUCTION = /\b(?:pretend|act as|role-?play|you are|you['’]re|for this (?:conversation|chat|session)|assume|in this story|my character|persona|today is)\b/iu;
const TEMPORARY = /^\s*(?:for (?:the|a|this|next|two|a few|a couple of) \p{L}+|this (?:week|weekend|month|summer|winter|semester|year)|temporarily|(?:until|till)\b|on (?:vacation|holiday|a trip|business)|for now|right now|at the moment)/iu;
const FORGET_PREFIX = /\b(?:forget|remove|delete|erase|don['’]t remember)\b/iu;
const FORGET = /\b(?:forget|remove|delete|erase)\b[^.!?\n]{0,40}\b(?:that|my|about|me)\b/iu;
const QUOTE_CHARS = /["“”]/gu;

interface Range {
  start: number;
  end: number;
}

/** Fenced/inline code and quoted-block lines in a message (UTF-16 ranges). */
function codeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  for (const m of text.matchAll(fence)) ranges.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  const inline = /`[^`\n]+`/g;
  for (const m of text.matchAll(inline)) ranges.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  const block = /^(?: {4}|\t|>).*$/gm;
  for (const m of text.matchAll(block)) ranges.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  return ranges;
}

function inRanges(ranges: Range[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

interface Sentence {
  text: string;
  offset: number;
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(/[^.!?\n]+(?:[.!?]+|\n|$)/g)) out.push({ text: m[0], offset: m.index ?? 0 });
  return out;
}

function eligibility(sentence: Sentence, matchStart: number, valueEnd: number, slot: Slot, codes: Range[]): IneligibleReason | null {
  if (inRanges(codes, sentence.offset + matchStart)) return "code";
  if (sentence.text.trimEnd().endsWith("?")) return "question";
  const prefix = sentence.text.slice(0, matchStart);
  if ((prefix.match(QUOTE_CHARS)?.length ?? 0) % 2 === 1) return "reported";
  if (INSTRUCTION.test(sentence.text) || FORGET_PREFIX.test(prefix)) return "instruction";
  if (HYPOTHETICAL.test(prefix)) return "hypothetical";
  if (REPORTED.test(prefix)) return "reported";
  if (THIRD_PARTY.test(prefix)) return "third_party";
  if (slot === "location.home" && TEMPORARY.test(sentence.text.slice(valueEnd))) return "temporary";
  return null;
}

function validValue(slot: Slot, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 2) return false;
  const words = trimmed.split(/\s+/u);
  if (VALUE_STOPWORDS.has(words[0].toLowerCase()) && slot !== "work.employer") return false;
  if (slot === "identity.name" && (words.length > 4 || /\p{N}/u.test(trimmed))) return false;
  if (slot === "work.employer" && words.length === 1 && VALUE_STOPWORDS.has(words[0].toLowerCase())) return false;
  return true;
}

function emptyDiagnostics(): ExtractDiagnostics {
  return {
    conversations: 0,
    userMessages: 0,
    assistantMessagesSkipped: 0,
    candidates: 0,
    ineligible: { question: 0, hypothetical: 0, reported: 0, third_party: 0, code: 0, temporary: 0, instruction: 0 },
    abstained: { bad_value: 0, quote_too_long: 0, ambiguous: 0 },
    forgetRequests: [],
  };
}

function pushCandidate(
  out: Candidate[],
  seen: Set<string>,
  diagnostics: ExtractDiagnostics,
  message: CanonicalMessage,
  digest: string,
  ruleId: string,
  slot: Slot,
  polarity: Polarity,
  cue: ChangeCue,
  value: string,
  absStart: number,
  absEnd: number,
): void {
  const result = makeEvidence(message, digest, absStart, absEnd);
  if (!result.ok) {
    diagnostics.abstained[result.reason === "quote_too_long" ? "quote_too_long" : "ambiguous"] += 1;
    return;
  }
  const dedupe = `${slot}|${polarity}|${value.toLowerCase()}|${result.evidence.start}|${result.evidence.end}|${message.messageId}`;
  if (seen.has(dedupe)) return; // identical occurrence: no-op
  seen.add(dedupe);
  const assertion = renderAssertion(slot, value, polarity);
  out.push({
    slot,
    value,
    polarity,
    changeCue: cue,
    assertion,
    evidence: result.evidence,
    ruleId,
    extractorVersion: EXTRACTOR_VERSION,
    sensitivity: classifyCandidate(slot, [assertion, value, result.evidence.quote]),
  });
}

function extractMessage(message: CanonicalMessage, digest: string, out: Candidate[], seen: Set<string>, diagnostics: ExtractDiagnostics): void {
  const codes = codeRanges(message.text);
  if (FORGET.test(message.text)) diagnostics.forgetRequests.push({ conversationId: message.conversationId, messageId: message.messageId });
  for (const sentence of sentences(message.text)) {
    const claimed = new Set<number>();
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of sentence.text.matchAll(rule.re)) {
        const start = m.index ?? 0;
        if (claimed.has(start)) continue;
        const emissions = rule.emit(m);
        const groups = m.indices?.groups ?? {};
        const firstGroup = groups[emissions[0].group];
        if (!firstGroup) continue;
        claimed.add(start);
        const reason = eligibility(sentence, start, firstGroup[1], emissions[0].slot, codes);
        if (reason) {
          diagnostics.ineligible[reason] += 1;
          continue;
        }
        const actually = /\bactually,?\s*$/iu.test(sentence.text.slice(0, start));
        for (const emission of emissions) {
          const span = groups[emission.group];
          const spanEnd = groups[emission.spanGroup ?? emission.group]?.[1] ?? span?.[1];
          const value = span ? sentence.text.slice(span[0], span[1]).trim() : "";
          if (!span || spanEnd === undefined || !validValue(emission.slot, value)) {
            diagnostics.abstained.bad_value += 1;
            continue;
          }
          if (emission.slot === "work.employer" && NON_ORG.test(value)) {
            diagnostics.abstained.ambiguous += 1;
            continue;
          }
          let cue = emission.cue;
          if (actually && emission.polarity === "assert" && cue === "none") cue = "correction";
          // "X, not Y" -> assert X (correction) + deny Y (correction), one supporting span.
          let tailEnd = spanEnd;
          if (emission.polarity === "assert" && CORRECTION_SLOTS.includes(emission.slot)) {
            const tail = CORRECTION_TAIL.exec(sentence.text.slice(spanEnd));
            const y = tail?.indices?.groups?.y;
            if (tail && y) {
              const denied = sentence.text.slice(spanEnd + y[0], spanEnd + y[1]).trim();
              if (validValue(emission.slot, denied) && !NOT_A_TARGET.test(denied)) {
                // Only an accepted Y turns this into a correction pair.
                tailEnd = spanEnd + y[1];
                cue = "correction";
                pushCandidate(out, seen, diagnostics, message, digest, rule.id + ".not", emission.slot, "deny", "correction", denied, sentence.offset + start, sentence.offset + tailEnd);
              } else {
                diagnostics.abstained.ambiguous += 1;
              }
            }
          }
          pushCandidate(out, seen, diagnostics, message, digest, rule.id, emission.slot, emission.polarity, cue, value, sentence.offset + start, sentence.offset + tailEnd);
        }
      }
    }
  }
}

export const extractCandidates: Extractor = (conversations) => {
  const diagnostics = emptyDiagnostics();
  const candidates: Candidate[] = [];
  for (const conversation of conversations) {
    diagnostics.conversations += 1;
    const seen = new Set<string>();
    for (const message of conversation.messages) {
      if (message.role !== "user") {
        diagnostics.assistantMessagesSkipped += 1;
        continue;
      }
      diagnostics.userMessages += 1;
      extractMessage(message, conversation.sourceDigest, candidates, seen, diagnostics);
    }
  }
  diagnostics.candidates = candidates.length;
  return { candidates, diagnostics };
};
