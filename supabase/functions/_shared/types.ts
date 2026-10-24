export type FactKind =
  | "identity"
  | "residence"
  | "occupation"
  | "preference"
  | "health"
  | "financial"
  | "other";

export type Sensitivity = "none" | "health" | "intimate" | "financial";

export type FactStatus =
  | "proposed"
  | "confirmed"
  | "needs_confirmation"
  | "superseded"
  | "tombstoned";

export type Polarity = "assert" | "deny" | "move";

export type SourceKind = "mined_history";

export interface Provenance {
  conversationId: string;
  messageId: string;
  quote: string;
  start: number;
  end: number;
  ordinal: number;
}

export interface Fact {
  id: string;
  slot: string;
  value: string;
  statement: string;
  kind: FactKind;
  sensitivity: Sensitivity;
  confidence: number;
  status: FactStatus;
  validFrom: string | null;
  invalidAt: string | null;
  supersededBy: string | null;
  sourceKind: SourceKind;
  userEdited: boolean;
  confirmationReason: string | null;
  polarity: Polarity;
  explicitMove: boolean;
  provenance: Provenance;
}

export interface ParsedMessage {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string | null;
  ordinal: number;
}

export interface ParsedConversation {
  id: string;
  title: string;
  messages: ParsedMessage[];
}

export interface ParseResult {
  conversations: ParsedConversation[];
  messages: ParsedMessage[];
  warnings: string[];
}

export type ConflictReason = "explicit_move" | "unclear_contradiction" | "value_changed";

export interface ConflictPair {
  slot: string;
  olderId: string;
  newerId: string;
  reason: ConflictReason;
}

export type AuditAction = "extract" | "confirm" | "edit" | "delete" | "supersede" | "reject" | "hold";

export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction;
  factId: string;
  stableKey: string;
  detail: string;
}

export interface ProfileDraft {
  facts: Fact[];
  conflicts: ConflictPair[];
  events: AuditEvent[];
}
