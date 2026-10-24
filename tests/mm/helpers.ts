import type { Ctx } from "../../supabase/functions/_shared/mm/model.ts";
import { sha256Hex } from "../../supabase/functions/_shared/mm/sha256.ts";
import type { CanonicalMessage, ParsedConversation } from "../../supabase/functions/_shared/mm/source.ts";

/** Deterministic context for reducer tests. */
export function testCtx(now = "2026-10-23T12:00:00Z"): Ctx {
  let n = 0;
  return { now, newId: () => `id-${String(++n).padStart(4, "0")}` };
}

/** Build a parsed conversation from user/assistant lines without going through the parser. */
export function conv(id: string, lines: Array<[role: "user" | "assistant", text: string, time?: string | null]>): ParsedConversation {
  const messages: CanonicalMessage[] = lines.map(([role, text, time], index) => ({
    conversationId: id,
    messageId: `${id}-m${index + 1}`,
    nodeId: `${id}-n${index + 1}`,
    role,
    text,
    textSha256: sha256Hex(text),
    sourceTime: time ?? null,
    ordinal: index,
  }));
  return { id, title: id, sourceDigest: sha256Hex(`digest:${id}:${lines.map((l) => l[1]).join("|")}`), createTime: null, updateTime: null, messages };
}
