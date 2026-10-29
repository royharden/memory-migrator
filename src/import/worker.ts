import { checkFileBounds } from "../../supabase/functions/_shared/mm/limits.ts";
import { extractSelected, inventoryShard, LimitError, mergeInventories, selectConversations } from "../../supabase/functions/_shared/mm/parser.ts";
import { extractCandidates } from "../../supabase/functions/_shared/mm/rules.ts";
import { sha256Hex } from "../../supabase/functions/_shared/mm/sha256.ts";
import { addSkips, emptySkips, type Issue, type ParsedConversation, type ShardInventory } from "../../supabase/functions/_shared/mm/source.ts";
import type { SourceShard, WorkerRequest, WorkerResponse } from "./protocol.ts";

/**
 * Parsing and rules run here, off the main thread, in both modes. Shards are read
 * sequentially and their raw/parsed buffers dropped before the next one. Cancel =
 * the main thread terminates this worker. No network access happens here.
 */

interface WorkerScope {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

async function readShard(source: SourceShard): Promise<{ text: string; data: unknown } | { error: string }> {
  const text = source.text ?? (source.file ? await source.file.text() : "");
  try {
    return { text, data: JSON.parse(text) as unknown };
  } catch {
    return { error: `${source.name} is not valid JSON.` };
  }
}

function post(message: WorkerResponse): void {
  scope.postMessage(message);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data);
};

async function handle(request: WorkerRequest): Promise<void> {
  try {
    const bounds = checkFileBounds(request.sources.map((s) => ({ name: s.name, size: s.size })));
    if (bounds) {
      post({ type: "error", message: bounds.message });
      return;
    }
    if (request.type === "inventory") {
      const shards: ShardInventory[] = [];
      for (let i = 0; i < request.sources.length; i += 1) {
        const read = await readShard(request.sources[i]);
        if ("error" in read) {
          shards.push({ ...inventoryShard(null, i, request.sources[i].name, null), fatal: { code: "not_json" as const, shardIndex: i, detail: read.error } });
          continue;
        }
        shards.push(inventoryShard(read.data, i, request.sources[i].name, sha256Hex(read.text)));
      }
      post({ type: "inventory", shards, index: mergeInventories(shards) });
      return;
    }

    const selected = selectConversations(request.index, request.selection);
    const conversations: ParsedConversation[] = [];
    const budget = { messages: 0, textBytes: 0 };
    let issues: Issue[] = [];
    let skips = emptySkips();
    const shardIndexes = [...new Set(selected.map((entry) => entry.shardIndex))].sort((a, b) => a - b);
    for (const shardIndex of shardIndexes) {
      const read = await readShard(request.sources[shardIndex]);
      if ("error" in read) throw new LimitError("not_json", read.error);
      const out = extractSelected(read.data, shardIndex, selected, request.selection, budget);
      budget.messages = out.retainedMessages;
      budget.textBytes = out.retainedTextBytes;
      conversations.push(...out.conversations);
      issues = [...issues, ...out.issues];
      skips = addSkips(skips, out.skips);
    }
    const { candidates, diagnostics } = extractCandidates(conversations);
    post({ type: "extract", conversations, candidates, diagnostics, issues, skips, retainedMessages: budget.messages, retainedTextBytes: budget.textBytes });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : "The import worker failed." });
  }
}
