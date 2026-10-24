import type { AuditEvent, Fact, FactStatus, ParsedMessage } from "./types.ts";

export interface FactRow {
  user_id: string;
  import_id: string | null;
  stable_key: string;
  slot: string;
  value: string;
  statement: string;
  kind: string;
  sensitivity: string;
  confidence: number;
  status: string;
  valid_from: string | null;
  invalid_at: string | null;
  superseded_by_key: string | null;
  source_kind: "mined_history";
  user_edited: boolean;
  confirmation_reason: string | null;
  polarity: string;
  explicit_move: boolean;
  provenance_conversation_id: string;
  provenance_message_id: string;
  provenance_quote: string;
  provenance_start: number;
  provenance_end: number;
  provenance_ordinal: number;
}

export interface MessageRow {
  import_id: string;
  user_id: string;
  conversation_source_id: string;
  conversation_title: string;
  source_message_id: string;
  role: "user" | "assistant";
  body: string;
  created_at_source: string | null;
  ordinal: number;
}

export interface AuditInsert {
  user_id: string;
  stable_key: string;
  action: AuditEvent["action"];
  detail: { text: string; at: string; fact_id: string };
}

export function factToRow(userId: string, importId: string | null, fact: Fact): FactRow {
  return {
    user_id: userId,
    import_id: importId,
    stable_key: fact.id,
    slot: fact.slot,
    value: fact.value,
    statement: fact.statement,
    kind: fact.kind,
    sensitivity: fact.sensitivity,
    confidence: fact.confidence,
    status: fact.status,
    valid_from: fact.validFrom,
    invalid_at: fact.invalidAt,
    superseded_by_key: fact.supersededBy,
    source_kind: "mined_history",
    user_edited: fact.userEdited,
    confirmation_reason: fact.confirmationReason,
    polarity: fact.polarity,
    explicit_move: fact.explicitMove,
    provenance_conversation_id: fact.provenance.conversationId,
    provenance_message_id: fact.provenance.messageId,
    provenance_quote: fact.provenance.quote,
    provenance_start: fact.provenance.start,
    provenance_end: fact.provenance.end,
    provenance_ordinal: fact.provenance.ordinal,
  };
}

export function rowToFact(row: FactRow): Fact {
  return {
    id: row.stable_key,
    slot: row.slot,
    value: row.value,
    statement: row.statement,
    kind: row.kind as Fact["kind"],
    sensitivity: row.sensitivity as Fact["sensitivity"],
    confidence: Number(row.confidence),
    status: row.status as FactStatus,
    validFrom: row.valid_from,
    invalidAt: row.invalid_at,
    supersededBy: row.superseded_by_key,
    sourceKind: "mined_history",
    userEdited: row.user_edited,
    confirmationReason: row.confirmation_reason,
    polarity: row.polarity as Fact["polarity"],
    explicitMove: row.explicit_move,
    provenance: {
      conversationId: row.provenance_conversation_id,
      messageId: row.provenance_message_id,
      quote: row.provenance_quote,
      start: row.provenance_start,
      end: row.provenance_end,
      ordinal: row.provenance_ordinal,
    },
  };
}

export function messageToRow(userId: string, importId: string, message: ParsedMessage): MessageRow {
  return {
    import_id: importId,
    user_id: userId,
    conversation_source_id: message.conversationId,
    conversation_title: message.conversationTitle,
    source_message_id: message.messageId,
    role: message.role,
    body: message.text,
    created_at_source: message.createdAt,
    ordinal: message.ordinal,
  };
}

export function rowToMessage(row: MessageRow): ParsedMessage {
  return {
    conversationId: row.conversation_source_id,
    conversationTitle: row.conversation_title,
    messageId: row.source_message_id,
    role: row.role,
    text: row.body,
    createdAt: row.created_at_source,
    ordinal: row.ordinal,
  };
}

export function eventToRow(userId: string, item: AuditEvent): AuditInsert {
  return {
    user_id: userId,
    stable_key: item.stableKey,
    action: item.action,
    detail: { text: item.detail, at: item.at, fact_id: item.factId },
  };
}

export function rowToEvent(row: {
  id: string;
  created_at: string;
  stable_key: string;
  action: AuditEvent["action"];
  detail: { text?: string; at?: string; fact_id?: string } | null;
}): AuditEvent {
  return {
    id: row.id,
    at: row.detail?.at ?? row.created_at,
    action: row.action,
    factId: row.detail?.fact_id ?? row.stable_key,
    stableKey: row.stable_key,
    detail: row.detail?.text ?? "",
  };
}
