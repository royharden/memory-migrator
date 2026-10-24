import { canonicalize, canonicalTime } from "./canonical.ts";
import { LIMIT_HINT, LIMITS } from "./limits.ts";
import { sha256Hex } from "./sha256.ts";
import {
  emptySkips,
  PROJECTION_VERSION,
  type CanonicalMessage,
  type CarrierCount,
  type ConversationIndexEntry,
  type ExtractionInput,
  type Issue,
  type ParsedConversation,
  type Selection,
  type ShardInventory,
  type SkipCounts,
} from "./source.ts";
import { canonicalText, codePointLength, hasUnpairedSurrogate, utf8Length } from "./unicode.ts";

/**
 * Bounded ChatGPT JSON parser (PLAN §4). Two passes per shard:
 *   inventoryShard -> lightweight index (no text retained),
 *   extractSelected -> canonical messages for selected conversations only.
 * The caller (browser worker) checks file count/bytes before reading, parses one
 * shard at a time and drops raw/parsed buffers between passes.
 * JSON.parse is not a bounded-depth streaming parser: depth/node limits are
 * enforced after parse and before any walk or extraction.
 */

type JsonRecord = Record<string, unknown>;

const MIN_EPOCH_SECONDS = 946_684_800; // 2000-01-01
const MAX_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01

export class LimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "LimitError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Iterative structural depth check (objects and arrays each add one level). */
export function jsonDepthExceeds(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (typeof current !== "object" || current === null) continue;
    if (depth > max) return true;
    const children = Array.isArray(current) ? current : Object.values(current as JsonRecord);
    for (const child of children) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

/** Accepts an array, a validated { conversations: [...] } wrapper, or one mapped conversation. */
export function coerceConversations(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.conversations)) return data.conversations;
  if (isRecord(data) && isRecord(data.mapping)) return [data];
  return null;
}

function toTime(value: unknown, issues: Issue[], shardIndex: number, conversationId: string, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= MIN_EPOCH_SECONDS && value <= MAX_EPOCH_SECONDS) {
    return canonicalTime(value * 1000);
  }
  issues.push({ code: "invalid_date", shardIndex, conversationId, detail: `${field} is not a usable Unix time; treated as unknown.` });
  return null;
}

type MessageClass =
  | { kind: "none" }
  | { kind: "visible"; role: "user" | "assistant"; text: string; unsupportedParts: number }
  | { kind: "skip"; reason: keyof SkipCounts; unsupportedParts: number; surrogate?: boolean };

const CARRIER_PATHS: Array<{ path: string; category: CarrierCount["category"]; read: (message: JsonRecord) => unknown }> = [
  {
    path: "message.metadata.user_context_message_data.about_user_message",
    category: "about_user",
    read: (m) => (isRecord(m.metadata) && isRecord(m.metadata.user_context_message_data) ? m.metadata.user_context_message_data.about_user_message : undefined),
  },
  {
    path: "message.metadata.user_context_message_data.about_model_message",
    category: "about_model",
    read: (m) => (isRecord(m.metadata) && isRecord(m.metadata.user_context_message_data) ? m.metadata.user_context_message_data.about_model_message : undefined),
  },
  {
    path: "message.content(user_editable_context).user_profile",
    category: "user_profile",
    read: (m) => (isRecord(m.content) && m.content.content_type === "user_editable_context" ? m.content.user_profile : undefined),
  },
  {
    path: "message.content(user_editable_context).user_instructions",
    category: "user_instructions",
    read: (m) => (isRecord(m.content) && m.content.content_type === "user_editable_context" ? m.content.user_instructions : undefined),
  },
];

/** Carrier detection keeps only path/category/count; carrier text is never read into results. */
function carrierHits(message: JsonRecord): CarrierCount["category"][] {
  const hits: CarrierCount["category"][] = [];
  for (const carrier of CARRIER_PATHS) {
    if (nonEmptyString(carrier.read(message))) hits.push(carrier.category);
  }
  return hits;
}

function isCarrierMessage(message: JsonRecord): boolean {
  if (isRecord(message.content) && message.content.content_type === "user_editable_context") return true;
  return isRecord(message.metadata) && isRecord(message.metadata.user_context_message_data);
}

function classifyMessage(raw: unknown): MessageClass {
  if (!isRecord(raw)) return { kind: "none" };
  if (isCarrierMessage(raw)) return { kind: "skip", reason: "carrierMessages", unsupportedParts: 0 };
  if (isRecord(raw.metadata) && raw.metadata.is_visually_hidden_from_conversation === true) {
    return { kind: "skip", reason: "hidden", unsupportedParts: 0 };
  }
  const role = isRecord(raw.author) ? raw.author.role : undefined;
  if (role === "system") return { kind: "skip", reason: "system", unsupportedParts: 0 };
  if (role !== "user" && role !== "assistant") return { kind: "skip", reason: "tool", unsupportedParts: 0 };
  const content = raw.content;
  if (!isRecord(content)) return { kind: "skip", reason: "nonText", unsupportedParts: 0 };
  const type = content.content_type;
  if ((type !== "text" && type !== "multimodal_text") || !Array.isArray(content.parts)) {
    return { kind: "skip", reason: "nonText", unsupportedParts: 0 };
  }
  const strings: string[] = [];
  let unsupportedParts = 0;
  for (const part of content.parts) {
    if (typeof part === "string") strings.push(part);
    else unsupportedParts += 1; // never stringify arbitrary objects
  }
  const text = canonicalText(strings.join("\n"));
  if (text.trim().length === 0) return { kind: "skip", reason: unsupportedParts > 0 ? "nonText" : "empty", unsupportedParts };
  if (hasUnpairedSurrogate(text)) return { kind: "skip", reason: "nonText", unsupportedParts, surrogate: true };
  if (codePointLength(text) > LIMITS.maxMessageCodePoints) return { kind: "skip", reason: "tooLong", unsupportedParts };
  return { kind: "visible", role, text, unsupportedParts };
}

function messageIdFor(raw: unknown, conversationId: string, nodeId: string, role: string, text: string): string {
  if (isRecord(raw) && nonEmptyString(raw.id)) return raw.id;
  // Deterministic content-backed id; never positional.
  return `msg_${sha256Hex(canonicalize({ c: conversationId, n: nodeId, r: role, t: text })).slice(0, 32)}`;
}

/** Well-formed copy for hashing only (lone surrogates -> U+FFFD). */
function wellFormed(text: string): string {
  return hasUnpairedSurrogate(text) ? text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�") : text;
}

interface ProjectionNode {
  id: string;
  parent: string | null;
  message: null | {
    id: string | null;
    role: string | null;
    hidden: boolean;
    contentType: string | null;
    text: string | null;
    time: number | null;
  };
}

/**
 * Versioned canonical conversation projection -> source_digest. Independent of
 * filename, shard order and JSON whitespace. Carrier content is not text-typed and
 * contributes no text.
 */
export function conversationDigest(conversation: JsonRecord, rawId: string | null): string {
  const mapping = isRecord(conversation.mapping) ? conversation.mapping : {};
  const nodes: ProjectionNode[] = Object.keys(mapping)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((nodeId) => {
      const node = mapping[nodeId];
      const parent = isRecord(node) && typeof node.parent === "string" ? wellFormed(node.parent) : null;
      const message = isRecord(node) && isRecord(node.message) ? node.message : null;
      if (!message) return { id: wellFormed(nodeId), parent, message: null };
      const content = isRecord(message.content) ? message.content : null;
      const contentType = content && typeof content.content_type === "string" ? content.content_type : null;
      let text: string | null = null;
      if (!isCarrierMessage(message) && content && (contentType === "text" || contentType === "multimodal_text") && Array.isArray(content.parts)) {
        text = wellFormed(canonicalText(content.parts.filter((p): p is string => typeof p === "string").join("\n")));
      }
      const time = typeof message.create_time === "number" && Number.isFinite(message.create_time) ? Math.floor(message.create_time) : null;
      return {
        id: wellFormed(nodeId),
        parent,
        message: {
          id: nonEmptyString(message.id) ? wellFormed(message.id) : null,
          role: isRecord(message.author) && typeof message.author.role === "string" ? wellFormed(message.author.role) : null,
          hidden: isRecord(message.metadata) && message.metadata.is_visually_hidden_from_conversation === true,
          contentType: contentType ? wellFormed(contentType) : null,
          text,
          time,
        },
      };
    });
  const currentNode = nonEmptyString(conversation.current_node) ? wellFormed(conversation.current_node) : null;
  return sha256Hex(
    canonicalize({ v: PROJECTION_VERSION, conversationId: rawId ? wellFormed(rawId) : null, currentNode, nodes }),
  );
}

const MAX_ID_LENGTH = 256;

/** Ids must be well-formed (no lone surrogates) and bounded; they are copied into every evidence record. */
function validId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH && !hasUnpairedSurrogate(value);
}

/** First invalid conversation/node/message id in a conversation, or null when all are usable. */
function invalidIdIn(conversation: JsonRecord, id: string): string | null {
  if (!validId(id)) return "conversation id";
  for (const [nodeId, node] of Object.entries(conversation.mapping as JsonRecord)) {
    if (!validId(nodeId)) return "node id";
    if (isRecord(node) && isRecord(node.message) && typeof node.message.id === "string" && node.message.id.length > 0 && !validId(node.message.id)) return "message id";
  }
  return null;
}

function rawConversationId(conversation: JsonRecord): string | null {
  if (nonEmptyString(conversation.id)) return conversation.id;
  if (nonEmptyString(conversation.conversation_id)) return conversation.conversation_id;
  return null;
}

type ChainResult =
  | { ok: true; nodeIds: string[] }
  | { ok: false; code: "missing_current_node" | "current_node_not_found" | "cycle" | "missing_parent" | "branch_choice_invalid"; detail: string };

function leavesOf(mapping: JsonRecord): string[] {
  const referenced = new Set<string>();
  for (const node of Object.values(mapping)) {
    if (isRecord(node) && typeof node.parent === "string") referenced.add(node.parent);
  }
  return Object.keys(mapping)
    .filter((id) => !referenced.has(id))
    .sort();
}

/** Walk current_node (or an explicit leaf choice) through parents, then reverse. Never guesses. */
function activeChain(conversation: JsonRecord, branchChoice: string | undefined): ChainResult {
  const mapping = conversation.mapping as JsonRecord;
  let start: string | null = nonEmptyString(conversation.current_node) ? conversation.current_node : null;
  if (!start) {
    if (!branchChoice) return { ok: false, code: "missing_current_node", detail: "No current_node; choose a branch or skip." };
    if (!leavesOf(mapping).includes(branchChoice)) {
      return { ok: false, code: "branch_choice_invalid", detail: `Chosen branch ${branchChoice} is not a leaf of this conversation.` };
    }
    start = branchChoice;
  }
  if (!isRecord(mapping[start])) return { ok: false, code: "current_node_not_found", detail: `current_node ${start} is not in the mapping.` };
  const chain: string[] = [];
  const seen = new Set<string>();
  let id: string | null = start;
  while (id !== null) {
    if (seen.has(id)) return { ok: false, code: "cycle", detail: `Parent cycle at node ${id}.` };
    seen.add(id);
    const node = mapping[id];
    if (!isRecord(node)) return { ok: false, code: "missing_parent", detail: `Parent node ${id} is missing.` };
    chain.push(id);
    id = typeof node.parent === "string" ? node.parent : null;
  }
  chain.reverse();
  return { ok: true, nodeIds: chain };
}

function newInventory(shardIndex: number, fileName: string, rawSha256: string | null): ShardInventory {
  return { shardIndex, fileName, rawSha256, conversations: [], skips: emptySkips(), carriers: [], issues: [], fatal: null };
}

/** Structural checks shared by both passes. Returns the conversation list or a fatal issue. */
function structuralCheck(data: unknown, shardIndex: number): { items: unknown[] } | { fatal: Issue } {
  if (jsonDepthExceeds(data, LIMITS.maxJsonDepth)) {
    return { fatal: { code: "too_deep", shardIndex, detail: `JSON nesting exceeds ${LIMITS.maxJsonDepth} levels. ${LIMIT_HINT}` } };
  }
  const items = coerceConversations(data);
  if (!items) {
    return {
      fatal: {
        code: "unsupported_shape",
        shardIndex,
        detail: "Expected a ChatGPT conversations array, a { conversations: [...] } wrapper, or one conversation with a mapping.",
      },
    };
  }
  let nodes = 0;
  for (const item of items) {
    if (isRecord(item) && isRecord(item.mapping)) nodes += Object.keys(item.mapping).length;
  }
  if (nodes > LIMITS.maxNodesPerShard) {
    return { fatal: { code: "too_many_nodes", shardIndex, detail: `Shard has ${nodes} mapping nodes; the limit is ${LIMITS.maxNodesPerShard}. ${LIMIT_HINT}` } };
  }
  return { items };
}

/** Pass 1: lightweight inventory. Retains no message text. */
export function inventoryShard(data: unknown, shardIndex: number, fileName: string, rawSha256: string | null): ShardInventory {
  const inventory = newInventory(shardIndex, fileName, rawSha256);
  const checked = structuralCheck(data, shardIndex);
  if ("fatal" in checked) {
    inventory.fatal = checked.fatal;
    return inventory;
  }
  const carrierTotals = new Map<CarrierCount["category"], number>();
  checked.items.forEach((item, index) => {
    if (!isRecord(item) || !isRecord(item.mapping)) {
      inventory.issues.push({ code: "skipped_item", shardIndex, detail: `Item ${index + 1} is not a conversation with a mapping; skipped.` });
      return;
    }
    const rawId = rawConversationId(item);
    const sourceDigest = conversationDigest(item, rawId);
    const id = rawId ?? `conv_${sourceDigest.slice(0, 32)}`;
    const mapping = item.mapping;
    const title = typeof item.title === "string" && item.title.trim() ? item.title : "Untitled conversation";
    const entry: ConversationIndexEntry = {
      id,
      title,
      shardIndex,
      sourceDigest,
      createTime: toTime(item.create_time, inventory.issues, shardIndex, id, "create_time"),
      updateTime: toTime(item.update_time, inventory.issues, shardIndex, id, "update_time"),
      nodeCount: Object.keys(mapping).length,
      activeVisibleMessages: 0,
      activeUserMessages: 0,
      state: "ok",
      branchLeaves: [],
      stateDetail: null,
    };

    const badId = invalidIdIn(item, id);
    if (badId) {
      entry.state = "broken_tree";
      entry.stateDetail = `A ${badId} is malformed (lone surrogate or longer than ${MAX_ID_LENGTH} characters); conversation skipped.`;
      inventory.issues.push({ code: "invalid_id", shardIndex, conversationId: id.slice(0, MAX_ID_LENGTH), detail: entry.stateDetail });
      inventory.conversations.push(entry);
      return;
    }

    // Carrier inventory and off-branch counts over all nodes.
    const chain = activeChain(item, undefined);
    const onBranch = new Set(chain.ok ? chain.nodeIds : []);
    const messageIds = new Map<string, string>();
    for (const [nodeId, node] of Object.entries(mapping)) {
      if (!isRecord(node) || !isRecord(node.message)) continue;
      for (const category of carrierHits(node.message)) carrierTotals.set(category, (carrierTotals.get(category) ?? 0) + 1);
      const cls = classifyMessage(node.message);
      if (cls.kind === "visible") {
        const messageId = messageIdFor(node.message, id, nodeId, cls.role, cls.text);
        const fingerprint = `${cls.role}\u0000${cls.text}`;
        const prior = messageIds.get(messageId);
        if (prior !== undefined && prior !== fingerprint) {
          entry.state = "collision";
          entry.stateDetail = `Message id ${messageId} appears with different content.`;
          inventory.issues.push({ code: "message_id_collision", shardIndex, conversationId: id, detail: entry.stateDetail });
        }
        messageIds.set(messageId, fingerprint);
      }
      if (chain.ok && !onBranch.has(nodeId)) {
        if (cls.kind !== "none") inventory.skips.offBranch += 1;
        continue;
      }
      if (!chain.ok) continue;
      if (cls.kind === "visible") {
        entry.activeVisibleMessages += 1;
        if (cls.role === "user") entry.activeUserMessages += 1;
        inventory.skips.unsupportedParts += cls.unsupportedParts;
      } else if (cls.kind === "skip") {
        inventory.skips[cls.reason] += 1;
        inventory.skips.unsupportedParts += cls.unsupportedParts;
        if (cls.reason === "tooLong") {
          inventory.issues.push({ code: "message_too_long", shardIndex, conversationId: id, detail: `A message exceeds ${LIMITS.maxMessageCodePoints} code points and will not be extracted.` });
        }
      }
    }

    if (!chain.ok && entry.state === "ok") {
      if (chain.code === "missing_current_node") {
        entry.state = "needs_branch_choice";
        entry.branchLeaves = leavesOf(mapping).slice(0, LIMITS.maxBranchLeavesListed);
      } else {
        entry.state = "broken_tree";
      }
      entry.stateDetail = chain.detail;
      inventory.issues.push({ code: chain.code, shardIndex, conversationId: id, detail: chain.detail });
    } else if (entry.state === "ok" && entry.activeVisibleMessages === 0) {
      entry.state = "empty";
      entry.stateDetail = "No visible user or assistant text on the active branch.";
    }
    inventory.conversations.push(entry);
  });
  inventory.carriers = [...carrierTotals.entries()].map(([category, count]) => ({
    path: CARRIER_PATHS.find((c) => c.category === category)?.path ?? category,
    category,
    count,
  }));
  return inventory;
}

/**
 * Cross-shard identity: same id + same digest -> later copy is a duplicate no-op;
 * same id + different digest -> every copy is a collision requiring input resolution.
 */
export function mergeInventories(shards: ShardInventory[]): ConversationIndexEntry[] {
  const all = shards.flatMap((shard) => shard.conversations);
  const byId = new Map<string, ConversationIndexEntry[]>();
  for (const entry of all) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
  const result: ConversationIndexEntry[] = [];
  for (const entries of byId.values()) {
    const digests = new Set(entries.map((e) => e.sourceDigest));
    if (digests.size > 1) {
      for (const entry of entries) {
        result.push({ ...entry, state: "collision", stateDetail: `Conversation id ${entry.id} appears in several files with different content. Remove one file to continue.` });
      }
      continue;
    }
    entries.forEach((entry, index) => {
      result.push(index === 0 ? entry : { ...entry, state: "duplicate", stateDetail: "Identical copy of a conversation in an earlier file; ignored." });
    });
  }
  return result;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Normalizes an inclusive bound: date-only -> start/end of that UTC day; otherwise canonical UTC seconds. */
export function normalizeBound(bound: string | null, edge: "from" | "to"): string | null {
  if (!bound) return null;
  if (DATE_ONLY.test(bound)) return edge === "from" ? `${bound}T00:00:00Z` : `${bound}T23:59:59Z`;
  return canonicalTime(bound);
}

function inDateRange(entry: ConversationIndexEntry, selection: Selection): boolean {
  const time = entry.createTime ?? entry.updateTime;
  if (!time) return selection.includeUnknownDate;
  const from = normalizeBound(selection.from, "from");
  const to = normalizeBound(selection.to, "to");
  if (from && time < from) return false;
  if (to && time > to) return false;
  return true;
}

/** Selection happens after inventory and before any text is retained. */
export function selectConversations(index: ConversationIndexEntry[], selection: Selection): ConversationIndexEntry[] {
  const wanted = selection.conversationIds ? new Set(selection.conversationIds) : null;
  return index.filter((entry) => {
    if (wanted && !wanted.has(entry.id)) return false;
    const branchOk = entry.state === "ok" || (entry.state === "needs_branch_choice" && Boolean(selection.branchChoices[entry.id]));
    return branchOk && inDateRange(entry, selection);
  });
}

export interface RetentionBudget {
  messages: number;
  textBytes: number;
}

/**
 * Pass 2: re-read one shard and retain canonical active-branch messages for the
 * selected conversations of that shard. Throws LimitError rather than truncating.
 */
export function extractSelected(
  data: unknown,
  shardIndex: number,
  selected: ConversationIndexEntry[],
  selection: Selection,
  budget: RetentionBudget,
): ExtractionInput {
  const out: ExtractionInput = { conversations: [], retainedMessages: budget.messages, retainedTextBytes: budget.textBytes, issues: [], skips: emptySkips() };
  const checked = structuralCheck(data, shardIndex);
  if ("fatal" in checked) throw new LimitError(checked.fatal.code, checked.fatal.detail);
  const wanted = new Map(selected.filter((e) => e.shardIndex === shardIndex).map((e) => [e.id, e]));
  if (wanted.size === 0) return out;
  for (const item of checked.items) {
    if (!isRecord(item) || !isRecord(item.mapping)) continue;
    const rawId = rawConversationId(item);
    const digest = conversationDigest(item, rawId);
    const id = rawId ?? `conv_${digest.slice(0, 32)}`;
    const entry = wanted.get(id);
    if (!entry || entry.sourceDigest !== digest) continue;
    wanted.delete(id);
    const chain = activeChain(item, selection.branchChoices[id]);
    if (!chain.ok) {
      out.issues.push({ code: chain.code, shardIndex, conversationId: id, detail: chain.detail });
      continue;
    }
    const mapping = item.mapping;
    const messages: CanonicalMessage[] = [];
    for (const nodeId of chain.nodeIds) {
      const node = mapping[nodeId] as JsonRecord;
      const cls = classifyMessage(node.message);
      if (cls.kind !== "visible") continue;
      const bytes = utf8Length(cls.text);
      if (out.retainedMessages + 1 > LIMITS.maxRetainedMessages) {
        throw new LimitError("too_many_messages", `Selection retains more than ${LIMITS.maxRetainedMessages} visible messages. ${LIMIT_HINT}`);
      }
      if (out.retainedTextBytes + bytes > LIMITS.maxRetainedTextBytes) {
        throw new LimitError("too_much_text", `Selection retains more than ${LIMITS.maxRetainedTextBytes / (1024 * 1024)} MiB of text. ${LIMIT_HINT}`);
      }
      out.retainedMessages += 1;
      out.retainedTextBytes += bytes;
      messages.push({
        sourceDigest: digest,
        conversationId: id,
        messageId: messageIdFor(node.message, id, nodeId, cls.role, cls.text),
        nodeId,
        role: cls.role,
        text: cls.text,
        textSha256: sha256Hex(cls.text),
        sourceTime: toTime(isRecord(node.message) ? node.message.create_time : null, out.issues, shardIndex, id, "message.create_time"),
        ordinal: messages.length,
      });
    }
    out.conversations.push({ id, title: entry.title, sourceDigest: digest, createTime: entry.createTime, updateTime: entry.updateTime, messages });
  }
  // Never drop a selected conversation silently (file changed between passes or vanished).
  for (const entry of wanted.values()) {
    out.issues.push({ code: "changed_since_inventory", shardIndex, conversationId: entry.id, detail: "This conversation changed or disappeared since the inventory; it was not extracted. Load the files again." });
  }
  return out;
}
