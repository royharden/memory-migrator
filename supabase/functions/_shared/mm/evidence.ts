import { canonicalize } from "./canonical.ts";
import { LIMITS } from "./limits.ts";
import { sha256Hex } from "./sha256.ts";
import { PARSER_VERSION, type CanonicalMessage, type Role } from "./source.ts";
import { codePointLength, codePointSlice, hasUnpairedSurrogate, utf16ToCodePoint } from "./unicode.ts";

/**
 * Quote-level evidence (PLAN §4). Offsets are code points, end exclusive.
 * Evidence proves words occurred in a message; not truth, entailment or authenticity.
 */
export interface Evidence {
  sourceDigest: string;
  conversationId: string;
  messageId: string;
  role: Role;
  textSha256: string;
  start: number;
  end: number;
  quote: string;
  quoteSha256: string;
  parserVersion: string;
  sourceTime: string | null;
}

export type EvidenceCheck = "verified" | "source_not_attached" | "mismatch" | "invalid";

export const SUPPORTED_PARSER_VERSIONS: readonly string[] = [PARSER_VERSION];

/** Unique occurrence identity: digest, conversation, message, text hash and both offsets. */
export function evidenceKey(e: Pick<Evidence, "sourceDigest" | "conversationId" | "messageId" | "textSha256" | "start" | "end">): string {
  return `ev_${sha256Hex(canonicalize([e.sourceDigest, e.conversationId, e.messageId, e.textSha256, e.start, e.end])).slice(0, 40)}`;
}

export type MakeEvidenceResult = { ok: true; evidence: Evidence } | { ok: false; reason: "quote_too_long" | "bad_range" };

/** Build evidence from a UTF-16 match range in a canonical message. Never clips. */
export function makeEvidence(message: CanonicalMessage, sourceDigest: string, utf16Start: number, utf16End: number): MakeEvidenceResult {
  if (utf16Start < 0 || utf16End <= utf16Start || utf16End > message.text.length) return { ok: false, reason: "bad_range" };
  const start = utf16ToCodePoint(message.text, utf16Start);
  const end = utf16ToCodePoint(message.text, utf16End);
  const quote = codePointSlice(message.text, start, end);
  if (quote === null || quote.length === 0) return { ok: false, reason: "bad_range" };
  if (end - start > LIMITS.maxQuoteCodePoints) return { ok: false, reason: "quote_too_long" };
  return {
    ok: true,
    evidence: {
      sourceDigest,
      conversationId: message.conversationId,
      messageId: message.messageId,
      role: message.role,
      textSha256: message.textSha256,
      start,
      end,
      quote,
      quoteSha256: sha256Hex(quote),
      parserVersion: PARSER_VERSION,
      sourceTime: message.sourceTime,
    },
  };
}

/**
 * Shape checks that do not need the source (the server can run the same checks):
 * quote hash, code-point length, range, quote bound and parser version.
 */
export function evidenceShapeErrors(e: Evidence): string[] {
  const errors: string[] = [];
  if (typeof e.quote !== "string" || e.quote.length === 0) errors.push("quote is empty");
  else {
    if (hasUnpairedSurrogate(e.quote)) errors.push("quote has an unpaired surrogate");
    const length = codePointLength(e.quote);
    if (length > LIMITS.maxQuoteCodePoints) errors.push(`quote exceeds ${LIMITS.maxQuoteCodePoints} code points`);
    if (!Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start) errors.push("invalid offsets");
    else if (e.end - e.start !== length) errors.push("offset span does not match quote length");
    if (sha256Hex(e.quote) !== e.quoteSha256) errors.push("quote hash mismatch");
  }
  if (!/^[0-9a-f]{64}$/.test(e.textSha256 ?? "")) errors.push("text hash malformed");
  if (!/^[0-9a-f]{64}$/.test(e.sourceDigest ?? "")) errors.push("source digest malformed");
  if (!SUPPORTED_PARSER_VERSIONS.includes(e.parserVersion)) errors.push(`unsupported parser version ${String(e.parserVersion)}`);
  if (e.role !== "user") errors.push("evidence must come from a user message");
  return errors;
}

/** With a live source attached, verify slice equality and hashes before approval. */
export function checkEvidence(e: Evidence, source: Map<string, CanonicalMessage> | null): EvidenceCheck {
  if (evidenceShapeErrors(e).length > 0) return "invalid";
  if (!source) return "source_not_attached";
  const message = source.get(messageLookupKey(e.conversationId, e.messageId));
  if (!message) return "source_not_attached";
  if (message.textSha256 !== e.textSha256) return "mismatch";
  const slice = codePointSlice(message.text, e.start, e.end);
  return slice === e.quote ? "verified" : "mismatch";
}

export function messageLookupKey(conversationId: string, messageId: string): string {
  return `${conversationId}\u0000${messageId}`;
}
