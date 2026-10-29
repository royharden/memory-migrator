import type { Candidate } from "../../supabase/functions/_shared/mm/model.ts";
import type { ExtractDiagnostics } from "../../supabase/functions/_shared/mm/rules.ts";
import type { ConversationIndexEntry, Issue, ParsedConversation, Selection, ShardInventory, SkipCounts } from "../../supabase/functions/_shared/mm/source.ts";

/** A source shard: a user-chosen File or the built-in synthetic demo text. */
export interface SourceShard {
  name: string;
  size: number;
  file?: File;
  text?: string;
}

export type WorkerRequest =
  | { type: "inventory"; sources: SourceShard[] }
  | { type: "extract"; sources: SourceShard[]; index: ConversationIndexEntry[]; selection: Selection };

export interface InventoryResponse {
  type: "inventory";
  shards: ShardInventory[];
  index: ConversationIndexEntry[];
}

export interface ExtractResponse {
  type: "extract";
  conversations: ParsedConversation[];
  candidates: Candidate[];
  diagnostics: ExtractDiagnostics;
  issues: Issue[];
  skips: SkipCounts;
  retainedMessages: number;
  retainedTextBytes: number;
}

export type WorkerResponse = InventoryResponse | ExtractResponse | { type: "error"; message: string };
