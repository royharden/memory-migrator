import type { SupabaseClient } from "@supabase/supabase-js";
import { conflictsFromFacts } from "../../supabase/functions/_shared/conflicts.ts";
import { eventToRow, factToRow, messageToRow, rowToEvent, rowToFact } from "../../supabase/functions/_shared/rows.ts";
import type { FactRow } from "../../supabase/functions/_shared/rows.ts";
import type { AuditEvent, Fact, ParsedMessage, ProfileDraft } from "../../supabase/functions/_shared/types.ts";

export interface LoadedDesk {
  facts: Fact[];
  events: AuditEvent[];
  importIds: Record<string, string | null>;
}

export function draftFromStored(facts: Fact[], events: AuditEvent[]): ProfileDraft {
  return { facts, events, conflicts: conflictsFromFacts(facts) };
}

export async function createImport(
  client: SupabaseClient,
  userId: string,
  filename: string,
  conversationCount: number,
  messageCount: number,
  warnings: string[],
  messages: ParsedMessage[],
  rawText: string,
): Promise<{ importId: string; storageWarning: string | null } | { error: string }> {
  const importId = crypto.randomUUID();
  const inserted = await client.from("imports").insert({
    id: importId,
    user_id: userId,
    filename,
    conversation_count: conversationCount,
    message_count: messageCount,
    warnings,
  });
  if (inserted.error) return { error: inserted.error.message };
  if (messages.length > 0) {
    const messageRows = messages.map((message) => messageToRow(userId, importId, message));
    const messagesInserted = await client.from("messages").insert(messageRows);
    if (messagesInserted.error) return { error: messagesInserted.error.message };
  }
  const uploaded = await client.storage.from("memory-exports").upload(
    `${userId}/${importId}.json`,
    new Blob([rawText], { type: "application/json" }),
    { contentType: "application/json", upsert: false },
  );
  return { importId, storageWarning: uploaded.error ? uploaded.error.message : null };
}

export async function invokePropose(
  client: SupabaseClient,
  importId: string,
): Promise<{ ok: true } | { error: string }> {
  const invoked = await client.functions.invoke("propose-facts", {
    body: { mode: "rules", importId },
  });
  if (invoked.error) {
    const data = invoked.data as { message?: string; error?: string } | null;
    const detail = data?.message ?? invoked.error.message;
    return { error: detail };
  }
  const data = invoked.data as { error?: string; message?: string } | null;
  if (data && typeof data.error === "string") return { error: data.message ?? data.error };
  return { ok: true };
}

export async function loadDesk(client: SupabaseClient): Promise<LoadedDesk | { error: string }> {
  const factsResult = await client.from("facts").select("*").order("valid_from", { ascending: true });
  if (factsResult.error) return { error: factsResult.error.message };
  const auditResult = await client.from("audit_log").select("*").order("created_at", { ascending: true });
  if (auditResult.error) return { error: auditResult.error.message };
  const importIds: Record<string, string | null> = {};
  const facts = (factsResult.data ?? []).map((row: FactRow & { import_id: string | null }) => {
    const fact = rowToFact(row);
    importIds[fact.id] = row.import_id ?? null;
    return fact;
  });
  const events = (auditResult.data ?? []).map((row: {
    id: string;
    created_at: string;
    stable_key: string;
    action: AuditEvent["action"];
    detail: { text?: string; at?: string; fact_id?: string } | null;
  }) => rowToEvent(row));
  return { facts, events, importIds };
}

export async function saveFacts(
  client: SupabaseClient,
  userId: string,
  facts: Fact[],
  importIds: Record<string, string | null>,
  events: AuditEvent[],
  alreadySaved: Set<string>,
): Promise<string | null> {
  if (facts.length > 0) {
    const rows = facts.map((fact) => factToRow(userId, importIds[fact.id] ?? null, fact));
    const upserted = await client.from("facts").upsert(rows, { onConflict: "user_id,stable_key" });
    if (upserted.error) return upserted.error.message;
  }
  const fresh = events.filter((item) => !alreadySaved.has(item.id));
  if (fresh.length > 0) {
    const inserted = await client.from("audit_log").insert(fresh.map((item) => eventToRow(userId, item)));
    if (inserted.error) return inserted.error.message;
  }
  return null;
}
