import { factId } from "./ids.ts";
import { applyConflictPolicy } from "./conflicts.ts";
import { kindForSlot, statementFor } from "./extract.ts";
import { applySensitivity, classifySensitivity } from "./sensitivity.ts";
import type { Fact, ParsedMessage, Sensitivity } from "./types.ts";

export const RULES_MAX_MESSAGES = 2000;
export const RULES_MAX_CHARS = 20000;
export const LLM_MAX_MESSAGES = 30;
export const LLM_TIMEOUT_MS = 20000;

export interface ProposeEnv {
  memoryExtractApiKey?: string;
  memoryExtractUrl?: string;
}

export type GateFailure = {
  ok: false;
  status: number;
  error: string;
  message: string;
  secret?: string;
};

export type GateResult = { ok: true } | GateFailure;

function tooLong(messages: ParsedMessage[]): GateFailure | null {
  const huge = messages.find((message) => message.text.length > RULES_MAX_CHARS);
  if (!huge) return null;
  return {
    ok: false,
    status: 400,
    error: "message_too_long",
    message: `Message ${huge.messageId} exceeds ${RULES_MAX_CHARS} characters. No facts were created.`,
  };
}

export function sanitizeMessages(value: unknown): ParsedMessage[] | null {
  if (!Array.isArray(value)) return null;
  const messages: ParsedMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.messageId !== "string" || typeof record.text !== "string") return null;
    if (record.role !== "user" && record.role !== "assistant") return null;
    messages.push({
      conversationId: typeof record.conversationId === "string" ? record.conversationId : "dry-run",
      conversationTitle: typeof record.conversationTitle === "string" ? record.conversationTitle : "",
      messageId: record.messageId,
      role: record.role,
      text: record.text,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
      ordinal: typeof record.ordinal === "number" ? record.ordinal : messages.length,
    });
  }
  return messages;
}

export function gateRules(messages: ParsedMessage[]): GateResult {
  if (messages.length > RULES_MAX_MESSAGES) {
    return {
      ok: false,
      status: 400,
      error: "too_many_messages",
      message: `Rules extraction accepts up to ${RULES_MAX_MESSAGES} messages. No facts were created.`,
    };
  }
  return tooLong(messages) ?? { ok: true };
}

export function gateLlm(env: ProposeEnv, messages: ParsedMessage[]): GateResult {
  if (!env.memoryExtractApiKey) {
    return {
      ok: false,
      status: 503,
      error: "missing_secret",
      secret: "MEMORY_EXTRACT_API_KEY",
      message: "LLM extraction needs the server secret MEMORY_EXTRACT_API_KEY. No facts were invented.",
    };
  }
  if (!env.memoryExtractUrl) {
    return {
      ok: false,
      status: 503,
      error: "missing_secret",
      secret: "MEMORY_EXTRACT_URL",
      message: "LLM extraction needs the server secret MEMORY_EXTRACT_URL. No request was sent.",
    };
  }
  if (messages.length > LLM_MAX_MESSAGES) {
    return {
      ok: false,
      status: 400,
      error: "too_many_messages",
      message: `LLM extraction accepts up to ${LLM_MAX_MESSAGES} messages per call. Narrow the import. No request was sent.`,
    };
  }
  return tooLong(messages) ?? { ok: true };
}

function isSensitivity(value: string): value is Sensitivity {
  return value === "none" || value === "health" || value === "intimate" || value === "financial";
}

export function mapProviderPayload(
  payload: unknown,
  messages: ParsedMessage[],
  nowIso: string,
): { ok: true; facts: Fact[]; dropped: number } | GateFailure {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { facts?: unknown }).facts)) {
    return {
      ok: false,
      status: 502,
      error: "provider_contract",
      message: "The extractor response did not contain a facts array. No facts were invented.",
    };
  }
  const items = (payload as { facts: unknown[] }).facts;
  const built: Fact[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") {
      dropped += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    const slot = typeof record.slot === "string" ? record.slot.trim() : "";
    const value = typeof record.value === "string" ? record.value.trim() : "";
    const messageId = typeof record.messageId === "string" ? record.messageId : "";
    const quote = typeof record.quote === "string" ? record.quote : "";
    const message = messages.find((candidate) => candidate.messageId === messageId && candidate.role === "user");
    const start = message && quote ? message.text.indexOf(quote) : -1;
    if (!slot || !value || !message || start < 0 || message.text.slice(start, start + quote.length) !== quote) {
      dropped += 1;
      continue;
    }
    const hinted = typeof record.sensitivity === "string" && isSensitivity(record.sensitivity)
      ? record.sensitivity
      : "none";
    const sensitivity = hinted === "none" ? classifySensitivity(quote) : hinted;
    built.push({
      id: factId(slot, value, "assert"),
      slot,
      value,
      statement: statementFor(slot, value),
      kind: kindForSlot(slot),
      sensitivity,
      confidence: 0.5,
      status: "proposed",
      validFrom: message.createdAt ?? nowIso,
      invalidAt: null,
      supersededBy: null,
      sourceKind: "mined_history",
      userEdited: false,
      confirmationReason: null,
      polarity: "assert",
      explicitMove: false,
      provenance: {
        conversationId: message.conversationId,
        messageId: message.messageId,
        quote,
        start,
        end: start + quote.length,
        ordinal: message.ordinal,
      },
    });
  }
  const conflicted = applyConflictPolicy(built);
  return { ok: true, facts: applySensitivity(conflicted.facts), dropped };
}
