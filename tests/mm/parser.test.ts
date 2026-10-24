import { describe, expect, it } from "vitest";
import {
  extractSelected,
  inventoryShard,
  LimitError,
  mergeInventories,
  selectConversations,
} from "../../supabase/functions/_shared/mm/parser.ts";
import type { Selection } from "../../supabase/functions/_shared/mm/source.ts";

type Node = { id: string; parent: string | null; message: unknown };

function msg(id: string, role: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, author: { role }, create_time: 1_700_000_000, content: { content_type: "text", parts: [text] }, ...extra };
}

function conversation(id: string | undefined, nodes: Node[], current: string | undefined, extra: Record<string, unknown> = {}) {
  const mapping: Record<string, Node> = {};
  for (const node of nodes) mapping[node.id] = node;
  return { ...(id ? { id } : {}), title: `T ${id ?? "anon"}`, create_time: 1_700_000_000, mapping, ...(current ? { current_node: current } : {}), ...extra };
}

const branched = conversation(
  "c1",
  [
    { id: "root", parent: null, message: msg("sys", "system", "You are ChatGPT.") },
    { id: "u1", parent: "root", message: msg("u1", "user", "I live in Austin.") },
    { id: "a1", parent: "u1", message: msg("a1", "assistant", "Nice.") },
    { id: "u2-old", parent: "a1", message: msg("u2-old", "user", "I live in Atlantis.") },
    { id: "u2", parent: "a1", message: msg("u2", "user", "I moved to Denver.") },
  ],
  "u2",
);

const allSelection: Selection = { conversationIds: null, from: null, to: null, includeUnknownDate: true, branchChoices: {} };

describe("inventory and active branch", () => {
  // what_bug_this_catches: abandoned branch text leaking into extraction.
  it("walks current_node and ignores off-branch nodes", () => {
    const inv = inventoryShard([branched], 0, "a.json", null);
    expect(inv.fatal).toBeNull();
    expect(inv.conversations[0]).toMatchObject({ id: "c1", state: "ok", activeVisibleMessages: 3, activeUserMessages: 2 });
    expect(inv.skips.system).toBe(1);
    expect(inv.skips.offBranch).toBe(1);
    const selected = selectConversations(mergeInventories([inv]), allSelection);
    const out = extractSelected([branched], 0, selected, allSelection, { messages: 0, textBytes: 0 });
    const texts = out.conversations[0].messages.map((m) => m.text);
    expect(texts).toEqual(["I live in Austin.", "Nice.", "I moved to Denver."]);
    expect(texts).not.toContain("I live in Atlantis.");
  });

  // what_bug_this_catches: guessing the newest leaf when current_node is missing.
  it("requires an explicit branch choice when current_node is missing", () => {
    const noCurrent = conversation("c2", [
      { id: "r", parent: null, message: null },
      { id: "x", parent: "r", message: msg("x", "user", "I like tea.") },
      { id: "y", parent: "r", message: msg("y", "user", "I like coffee.") },
    ], undefined);
    const inv = inventoryShard([noCurrent], 0, "a.json", null);
    expect(inv.conversations[0].state).toBe("needs_branch_choice");
    expect(inv.conversations[0].branchLeaves).toEqual(["x", "y"]);
    expect(selectConversations(inv.conversations, allSelection)).toHaveLength(0);
    const chosen = { ...allSelection, branchChoices: { c2: "y" } };
    const selected = selectConversations(inv.conversations, chosen);
    const out = extractSelected([noCurrent], 0, selected, chosen, { messages: 0, textBytes: 0 });
    expect(out.conversations[0].messages.map((m) => m.text)).toEqual(["I like coffee."]);
  });

  it("diagnoses cycles and missing parents as broken trees", () => {
    const cyclic = conversation("c3", [
      { id: "a", parent: "b", message: msg("a", "user", "x") },
      { id: "b", parent: "a", message: msg("b", "user", "y") },
    ], "a");
    const orphan = conversation("c4", [{ id: "a", parent: "ghost", message: msg("a", "user", "x") }], "a");
    const inv = inventoryShard([cyclic, orphan], 0, "a.json", null);
    expect(inv.conversations.map((c) => c.state)).toEqual(["broken_tree", "broken_tree"]);
    expect(inv.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["cycle", "missing_parent"]));
  });

  // what_bug_this_catches: positional conv_0 ids that change when shard order changes.
  it("derives content-backed ids for missing conversation/message ids, independent of order", () => {
    const anonA = conversation(undefined, [{ id: "n1", parent: null, message: { author: { role: "user" }, content: { content_type: "text", parts: ["I like tea."] } } }], "n1");
    const anonB = conversation(undefined, [{ id: "n1", parent: null, message: msg("m", "user", "I like jam.") }], "n1");
    const first = inventoryShard([anonA, anonB], 0, "a.json", null).conversations.map((c) => c.id);
    const second = inventoryShard([anonB, anonA], 0, "b.json", null).conversations.map((c) => c.id);
    expect(first[0]).toMatch(/^conv_[0-9a-f]{32}$/);
    expect(new Set(first)).toEqual(new Set(second));
    const sel = selectConversations(inventoryShard([anonA], 0, "a.json", null).conversations, allSelection);
    const out = extractSelected([anonA], 0, sel, allSelection, { messages: 0, textBytes: 0 });
    expect(out.conversations[0].messages[0].messageId).toMatch(/^msg_[0-9a-f]{32}$/);
  });

  // what_bug_this_catches: silently overwriting a conversation that changed between shards.
  it("treats same id + same content as duplicate and same id + different content as collision", () => {
    const changed = conversation("c1", [{ id: "u1", parent: null, message: msg("u1", "user", "I live in Paris.") }], "u1");
    const dup = mergeInventories([inventoryShard([branched], 0, "a.json", null), inventoryShard([branched], 1, "b.json", null)]);
    expect(dup.map((c) => c.state)).toEqual(["ok", "duplicate"]);
    const col = mergeInventories([inventoryShard([branched], 0, "a.json", null), inventoryShard([changed], 1, "b.json", null)]);
    expect(col.map((c) => c.state)).toEqual(["collision", "collision"]);
    expect(selectConversations(col, allSelection)).toHaveLength(0);
  });

  it("digest ignores JSON whitespace and key order", () => {
    const reparsed = JSON.parse(JSON.stringify(branched, null, 2));
    const reordered = { mapping: reparsed.mapping, current_node: reparsed.current_node, id: reparsed.id, title: "Other title", create_time: reparsed.create_time };
    const a = inventoryShard([branched], 0, "a.json", null).conversations[0].sourceDigest;
    const b = inventoryShard([reordered], 3, "z.json", null).conversations[0].sourceDigest;
    expect(a).toBe(b);
  });

  // what_bug_this_catches: carrier text (custom instructions / about-user) leaking into candidates.
  it("counts carriers by path only and never extracts them", () => {
    const secret = "SECRET-CARRIER-TEXT";
    const withCarrier = conversation("c5", [
      { id: "r", parent: null, message: { id: "r", author: { role: "user" }, content: { content_type: "user_editable_context", user_profile: secret, user_instructions: secret } } },
      { id: "h", parent: "r", message: msg("h", "user", secret, { metadata: { user_context_message_data: { about_user_message: secret, about_model_message: secret } } }) },
      { id: "u", parent: "h", message: msg("u", "user", "I like tea.") },
    ], "u");
    const inv = inventoryShard([withCarrier], 0, "a.json", null);
    expect(inv.carriers.map((c) => c.category).sort()).toEqual(["about_model", "about_user", "user_instructions", "user_profile"]);
    expect(JSON.stringify(inv)).not.toContain(secret);
    const sel = selectConversations(inv.conversations, allSelection);
    const out = extractSelected([withCarrier], 0, sel, allSelection, { messages: 0, textBytes: 0 });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.conversations[0].messages.map((m) => m.text)).toEqual(["I like tea."]);
  });

  it("skips hidden, tool and non-text parts without stringifying objects", () => {
    const mixed = conversation("c6", [
      { id: "h", parent: null, message: msg("h", "user", "hidden", { metadata: { is_visually_hidden_from_conversation: true } }) },
      { id: "t", parent: "h", message: msg("t", "tool", "tool output") },
      { id: "i", parent: "t", message: { id: "i", author: { role: "user" }, content: { content_type: "multimodal_text", parts: [{ asset_pointer: "file://x" }, "I like jam."] } } },
      { id: "c", parent: "i", message: { id: "c", author: { role: "assistant" }, content: { content_type: "code", text: "print(1)" } } },
    ], "c");
    const inv = inventoryShard([mixed], 0, "a.json", null);
    expect(inv.skips).toMatchObject({ hidden: 1, tool: 1, nonText: 1, unsupportedParts: 1 });
    const sel = selectConversations(inv.conversations, allSelection);
    const out = extractSelected([mixed], 0, sel, allSelection, { messages: 0, textBytes: 0 });
    expect(out.conversations[0].messages.map((m) => m.text)).toEqual(["I like jam."]);
    expect(JSON.stringify(out)).not.toContain("asset_pointer");
  });

  it("treats invalid dates as unknown with a diagnostic", () => {
    const badDate = conversation("c7", [{ id: "u", parent: null, message: msg("u", "user", "I like tea.") }], "u", { create_time: -5, update_time: "soon" });
    const inv = inventoryShard([badDate], 0, "a.json", null);
    expect(inv.conversations[0].createTime).toBeNull();
    expect(inv.issues.filter((i) => i.code === "invalid_date")).toHaveLength(2);
    expect(selectConversations(inv.conversations, { ...allSelection, includeUnknownDate: false })).toHaveLength(0);
  });

  it("rejects unsupported shapes and excessive depth", () => {
    expect(inventoryShard({ foo: 1 }, 0, "a.json", null).fatal?.code).toBe("unsupported_shape");
    let deep: unknown = "x";
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(inventoryShard(deep, 0, "a.json", null).fatal?.code).toBe("too_deep");
  });

  it("refuses to retain more than the message budget instead of truncating", () => {
    const sel = selectConversations(inventoryShard([branched], 0, "a.json", null).conversations, allSelection);
    expect(() => extractSelected([branched], 0, sel, allSelection, { messages: 1_999, textBytes: 0 })).toThrow(LimitError);
  });
});
