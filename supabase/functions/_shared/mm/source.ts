/** Source-side types: parsed ChatGPT conversations, diagnostics and the import report (PLAN §4). */

export const PARSER_VERSION = "chatgpt-json/1";
export const PROJECTION_VERSION = 1;

export type Role = "user" | "assistant";

/** A visible, supported user/assistant message on the active branch. Text is canonical (LF only). */
export interface CanonicalMessage {
  conversationId: string;
  messageId: string;
  nodeId: string;
  role: Role;
  text: string;
  textSha256: string;
  sourceTime: string | null;
  /** Position within the active branch of its conversation (visible messages only). */
  ordinal: number;
}

export type ConversationState =
  | "ok"
  | "needs_branch_choice"
  | "broken_tree"
  | "collision"
  | "duplicate"
  | "empty";

/** Lightweight per-conversation inventory row kept between shard reads. No message text. */
export interface ConversationIndexEntry {
  id: string;
  title: string;
  shardIndex: number;
  sourceDigest: string;
  createTime: string | null;
  updateTime: string | null;
  nodeCount: number;
  activeVisibleMessages: number;
  activeUserMessages: number;
  state: ConversationState;
  /** Leaf node IDs offered when current_node is missing (bounded list). */
  branchLeaves: string[];
  stateDetail: string | null;
}

export interface ParsedConversation {
  id: string;
  title: string;
  sourceDigest: string;
  createTime: string | null;
  updateTime: string | null;
  messages: CanonicalMessage[];
}

export type IssueCode =
  | "not_json"
  | "unsupported_shape"
  | "too_many_nodes"
  | "too_deep"
  | "missing_current_node"
  | "current_node_not_found"
  | "cycle"
  | "missing_parent"
  | "conversation_collision"
  | "duplicate_conversation"
  | "message_id_collision"
  | "invalid_date"
  | "message_too_long"
  | "skipped_item"
  | "branch_choice_invalid";

export interface Issue {
  code: IssueCode;
  shardIndex: number;
  conversationId?: string;
  detail: string;
}

export interface SkipCounts {
  system: number;
  tool: number;
  hidden: number;
  nonText: number;
  unsupportedParts: number;
  empty: number;
  carrierMessages: number;
  offBranch: number;
  tooLong: number;
}

export interface CarrierCount {
  path: string;
  category: "about_user" | "about_model" | "user_profile" | "user_instructions";
  count: number;
}

export interface ShardInventory {
  shardIndex: number;
  fileName: string;
  /** Local diagnostic only; never the identity of a conversation. */
  rawSha256: string | null;
  conversations: ConversationIndexEntry[];
  skips: SkipCounts;
  carriers: CarrierCount[];
  issues: Issue[];
  fatal: Issue | null;
}

export interface Selection {
  conversationIds: string[] | null;
  /** Inclusive ISO date bounds on conversation source time. */
  from: string | null;
  to: string | null;
  includeUnknownDate: boolean;
  /** Explicit leaf choice for conversations without current_node. */
  branchChoices: Record<string, string>;
}

export interface ExtractionInput {
  conversations: ParsedConversation[];
  retainedMessages: number;
  retainedTextBytes: number;
  issues: Issue[];
  skips: SkipCounts;
}

export function emptySkips(): SkipCounts {
  return {
    system: 0,
    tool: 0,
    hidden: 0,
    nonText: 0,
    unsupportedParts: 0,
    empty: 0,
    carrierMessages: 0,
    offBranch: 0,
    tooLong: 0,
  };
}

export function addSkips(target: SkipCounts, source: SkipCounts): SkipCounts {
  const out = { ...target };
  for (const key of Object.keys(out) as (keyof SkipCounts)[]) out[key] += source[key];
  return out;
}
