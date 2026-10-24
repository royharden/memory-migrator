import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { buildProfile, factsToWrite } from "../_shared/review.ts";
import { eventToRow, factToRow, rowToMessage } from "../_shared/rows.ts";
import {
  gateLlm,
  gateRules,
  LLM_TIMEOUT_MS,
  mapProviderPayload,
  sanitizeMessages,
} from "../_shared/propose.ts";
import type { AuditEvent, Fact, FactStatus, ParsedMessage } from "../_shared/types.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function failureBody(result: { error: string; message: string; secret?: string }): Record<string, string> {
  const body: Record<string, string> = { error: result.error, message: result.message };
  if (result.secret) body.secret = result.secret;
  return body;
}

async function loadImportMessages(
  supabase: SupabaseClient,
  importId: string,
): Promise<{ messages: ParsedMessage[] } | { error: string; message: string; status: number }> {
  const owned = await supabase.from("imports").select("id").eq("id", importId).maybeSingle();
  if (owned.error) return { error: "load_failed", message: owned.error.message, status: 400 };
  if (!owned.data) {
    return { error: "not_found", message: "Import not found for this user.", status: 404 };
  }
  const loaded = await supabase
    .from("messages")
    .select("conversation_source_id, conversation_title, source_message_id, role, body, created_at_source, ordinal, import_id, user_id")
    .eq("import_id", importId)
    .order("ordinal", { ascending: true });
  if (loaded.error) return { error: "load_failed", message: loaded.error.message, status: 400 };
  const messages: ParsedMessage[] = [];
  for (const row of loaded.data ?? []) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    messages.push(rowToMessage({
      import_id: row.import_id,
      user_id: row.user_id,
      conversation_source_id: row.conversation_source_id,
      conversation_title: row.conversation_title ?? "",
      source_message_id: row.source_message_id,
      role: row.role,
      body: row.body,
      created_at_source: row.created_at_source,
      ordinal: row.ordinal,
    }));
  }
  return { messages };
}

async function persistFacts(
  supabase: SupabaseClient,
  userId: string,
  importId: string,
  facts: Fact[],
  events: AuditEvent[],
): Promise<{ error: string; message: string } | null> {
  const existing = await supabase.from("facts").select("stable_key, status, user_edited").eq("user_id", userId);
  if (existing.error) return { error: "write_failed", message: existing.error.message };
  const protectedRows = (existing.data ?? []).map((row) => ({
    id: String(row.stable_key),
    status: row.status as FactStatus,
    userEdited: Boolean(row.user_edited),
  }));
  const writable = factsToWrite(protectedRows, facts);
  if (writable.length > 0) {
    const upserted = await supabase.from("facts").upsert(
      writable.map((fact) => factToRow(userId, importId, fact)),
      { onConflict: "user_id,stable_key" },
    );
    if (upserted.error) return { error: "write_failed", message: upserted.error.message };
  }
  const writableIds = new Set(writable.map((fact) => fact.id));
  const auditRows = events
    .filter((item) => item.action === "extract" && writableIds.has(item.factId))
    .map((item) => eventToRow(userId, item));
  if (auditRows.length > 0) {
    const inserted = await supabase.from("audit_log").insert(auditRows);
    if (inserted.error) return { error: "write_failed", message: inserted.error.message };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed", message: "Use POST." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json({
      error: "missing_platform_env",
      message: "SUPABASE_URL and SUPABASE_ANON_KEY must be injected for propose-facts. No facts were written.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({
      error: "unauthorized",
      message: "Sign in and send the user JWT. An anon key is not a user.",
    }, 401);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const userResult = await supabase.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return json({ error: "unauthorized", message: "The session is missing or expired." }, 401);
  }
  const userId = userResult.data.user.id;

  let body: { mode?: unknown; importId?: unknown; dryRun?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json", message: "Request body must be JSON." }, 400);
  }

  const mode = body.mode === "llm" ? "llm" : "rules";
  const dryRun = body.dryRun === true;
  const nowIso = new Date().toISOString();
  let messages: ParsedMessage[] = [];
  let importId: string | null = null;

  if (typeof body.importId === "string" && body.importId.length > 0) {
    importId = body.importId;
    const loaded = await loadImportMessages(supabase, importId);
    if ("error" in loaded) return json({ error: loaded.error, message: loaded.message }, loaded.status);
    messages = loaded.messages;
  } else if (dryRun) {
    const sanitized = sanitizeMessages(body.messages);
    if (!sanitized) {
      return json({
        error: "bad_request",
        message: "Dry run needs a messages array. Client-supplied facts are not accepted.",
      }, 400);
    }
    messages = sanitized;
  } else {
    return json({
      error: "bad_request",
      message: "Send importId, or dryRun true with messages. Client-supplied facts are not accepted.",
    }, 400);
  }

  if (mode === "llm") {
    const gate = gateLlm(
      {
        memoryExtractApiKey: Deno.env.get("MEMORY_EXTRACT_API_KEY") ?? undefined,
        memoryExtractUrl: Deno.env.get("MEMORY_EXTRACT_URL") ?? undefined,
      },
      messages,
    );
    if (!gate.ok) return json(failureBody(gate), gate.status);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await fetch(Deno.env.get("MEMORY_EXTRACT_URL") ?? "", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${Deno.env.get("MEMORY_EXTRACT_API_KEY") ?? ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: messages
            .filter((message) => message.role === "user")
            .map((message) => ({ id: message.messageId, text: message.text })),
        }),
      });
      if (!response.ok) {
        return json({
          error: "provider_http",
          message: `Extractor returned HTTP ${response.status}. No facts were invented.`,
        }, 502);
      }
      const payload: unknown = await response.json();
      const mapped = mapProviderPayload(payload, messages, nowIso);
      if (!mapped.ok) return json(failureBody(mapped), mapped.status);
      if (!dryRun && importId) {
        const written = await persistFacts(supabase, userId, importId, mapped.facts, []);
        if (written) return json(written, 400);
      }
      return json({ facts: mapped.facts, conflicts: [], dropped: mapped.dropped, events: [] }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extractor call failed.";
      return json({ error: "provider_unreachable", message: `${message} No facts were invented.` }, 502);
    } finally {
      clearTimeout(timer);
    }
  }

  const gate = gateRules(messages);
  if (!gate.ok) return json(failureBody(gate), gate.status);
  const draft = buildProfile(messages, nowIso);
  if (!dryRun && importId) {
    const written = await persistFacts(supabase, userId, importId, draft.facts, draft.events);
    if (written) return json(written, 400);
  }
  return json({
    facts: draft.facts,
    conflicts: draft.conflicts,
    dropped: 0,
    events: draft.events,
  }, 200);
});
