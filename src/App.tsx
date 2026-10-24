import { useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { parseChatGptExport, parseChatGptFiles } from "../supabase/functions/_shared/parseChatGpt.ts";
import { RULES_MAX_MESSAGES } from "../supabase/functions/_shared/propose.ts";
import { applyDecision, buildProfile, mergeExtraction } from "../supabase/functions/_shared/review.ts";
import type { Decision } from "../supabase/functions/_shared/review.ts";
import type { ParsedMessage, ProfileDraft } from "../supabase/functions/_shared/types.ts";
import { AuthGate } from "./components/AuthGate.tsx";
import { Desk } from "./components/Desk.tsx";
import { EvalPanel } from "./components/EvalPanel.tsx";
import fixture from "./fixtures/labelled-set.json";
import { createImport, draftFromStored, invokePropose, loadDesk, saveFacts } from "./lib/remote.ts";
import { getSupabase } from "./lib/supabase.ts";

type Mode = "choose" | "local" | "account";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function App() {
  const client = getSupabase();
  const [mode, setMode] = useState<Mode>("choose");
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [conversationCount, setConversationCount] = useState(0);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [filename, setFilename] = useState("");
  const [rawText, setRawText] = useState("");
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [importIds, setImportIds] = useState<Record<string, string | null>>({});
  const [savedEventIds, setSavedEventIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (mode !== "account" || !client || !session) return;
    let active = true;
    void loadDesk(client).then((loaded) => {
      if (!active) return;
      if ("error" in loaded) {
        setError(loaded.error);
        return;
      }
      setImportIds(loaded.importIds);
      setSavedEventIds(new Set(loaded.events.map((item) => item.id)));
      setDraft(loaded.facts.length === 0 ? null : draftFromStored(loaded.facts, loaded.events));
    });
    return () => {
      active = false;
    };
  }, [mode, client, session]);

  function rememberParsed(nextMessages: ParsedMessage[], count: number, nextWarnings: string[], name: string, raw: string) {
    setMessages(nextMessages);
    setConversationCount(count);
    setWarnings(nextWarnings);
    setFilename(name);
    setRawText(raw);
    setDraft(null);
    setError(null);
    setStorageWarning(null);
  }

  function loadSample() {
    const parsed = parseChatGptExport(fixture.export);
    rememberParsed(
      parsed.messages,
      parsed.conversations.length,
      parsed.warnings,
      "synthetic-labelled-v1.json",
      JSON.stringify(fixture.export),
    );
  }

  async function loadFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const documents: unknown[] = [];
    const names: string[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name} is over 10 MB. Split the export before loading it.`);
        return;
      }
      names.push(file.name);
      try {
        documents.push(JSON.parse(await file.text()) as unknown);
      } catch {
        setError(`${file.name} is not JSON.`);
        return;
      }
    }
    try {
      const parsed = parseChatGptFiles(documents);
      rememberParsed(parsed.messages, parsed.conversations.length, parsed.warnings, names.join(", "), JSON.stringify(documents));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read the export.");
    }
  }

  async function refreshAccount(current: SupabaseClient) {
    const loaded = await loadDesk(current);
    if ("error" in loaded) {
      setError(loaded.error);
      return;
    }
    setImportIds(loaded.importIds);
    setSavedEventIds(new Set(loaded.events.map((item) => item.id)));
    setDraft(draftFromStored(loaded.facts, loaded.events));
  }

  async function extract() {
    if (messages.length > RULES_MAX_MESSAGES) {
      setError(`This export has ${messages.length} messages. The cap is ${RULES_MAX_MESSAGES}.`);
      return;
    }
    setError(null);
    if (mode === "local") {
      setDraft(buildProfile(messages, new Date().toISOString()));
      return;
    }
    if (!client || !session) {
      setError("Sign in before saving an extract.");
      return;
    }
    setBusy(true);
    const created = await createImport(
      client,
      session.user.id,
      filename || "export.json",
      conversationCount,
      messages.length,
      warnings,
      messages,
      rawText,
    );
    if ("error" in created) {
      setBusy(false);
      setError(created.error);
      return;
    }
    setImportId(created.importId);
    setStorageWarning(created.storageWarning);
    const proposed = await invokePropose(client, created.importId);
    if ("error" in proposed) {
      setBusy(false);
      setError(`The import is stored, but propose-facts did not finish: ${proposed.error}`);
      return;
    }
    await refreshAccount(client);
    setBusy(false);
  }

  async function reextract() {
    if (!draft) return;
    if (mode === "local") {
      setDraft(mergeExtraction(draft, buildProfile(messages, new Date().toISOString())));
      return;
    }
    if (!client || !importId) {
      setError("Extract once while signed in before running extraction again.");
      return;
    }
    setBusy(true);
    const proposed = await invokePropose(client, importId);
    if ("error" in proposed) {
      setBusy(false);
      setError(proposed.error);
      return;
    }
    await refreshAccount(client);
    setBusy(false);
  }

  async function onDecision(decision: Decision) {
    if (!draft) return;
    const next = applyDecision(draft, decision, new Date().toISOString());
    if (mode === "local") {
      setDraft(next);
      return;
    }
    if (!client || !session) {
      setError("Sign in to save this change.");
      return;
    }
    const nextImportIds = { ...importIds };
    for (const fact of next.facts) {
      if (!(fact.id in nextImportIds)) nextImportIds[fact.id] = importId;
    }
    setBusy(true);
    const saved = new Set(savedEventIds);
    const writeError = await saveFacts(client, session.user.id, next.facts, nextImportIds, next.events, saved);
    setBusy(false);
    if (writeError) {
      setError(writeError);
      return;
    }
    for (const item of next.events) saved.add(item.id);
    setSavedEventIds(saved);
    setImportIds(nextImportIds);
    setDraft(next);
  }

  async function signOut() {
    if (!client) return;
    const result = await client.auth.signOut();
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setMode("choose");
    setDraft(null);
    setMessages([]);
    setImportId(null);
  }

  const step = messages.length === 0 ? "Load" : !draft ? "Extract" : draft.conflicts.length > 0 ? "Resolve" : "Export";

  return (
    <div className="shell">
      <header className="top">
        <p className="eyebrow">S18</p>
        <h1>Portable memory migrator</h1>
        <p>Turn a ChatGPT export into a profile you can correct and carry out. Every fact keeps a quote and a message id.</p>
      </header>
      <main className="layout">
        <ol className="steps">
          {["Load", "Extract", "Resolve", "Export"].map((label) => (
            <li key={label} className={label === step ? "current" : undefined}>{label}</li>
          ))}
        </ol>
        {mode === "choose" ? (
          <AuthGate
            client={client}
            onLocalDemo={() => {
              setMode("local");
              setError(null);
            }}
            onSignedIn={() => {
              setMode("account");
              setError(null);
            }}
          />
        ) : (
          <>
            <p className={mode === "local" ? "banner banner-local" : "banner banner-account"}>
              {mode === "local"
                ? "Local demo. Nothing is written to a database. Refreshing clears this session."
                : `Signed in as ${session?.user.email ?? "this user"}. Review actions save to your facts table.`}
              {mode === "account" ? (
                <button type="button" onClick={() => void signOut()}>Sign out</button>
              ) : null}
            </p>
            <section className="panel">
              <h2>Load an export</h2>
              <div className="row-actions">
                <button type="button" className="primary" onClick={loadSample}>Load labelled sample</button>
                <label className="file">
                  JSON files
                  <input
                    type="file"
                    accept="application/json,.json"
                    multiple
                    onChange={(event) => void loadFiles(event.target.files)}
                  />
                </label>
              </div>
              <p className="muted">
                {messages.length === 0
                  ? "Unzip a ChatGPT export and choose conversations.json or conversations-NNN.json. Zip files are not read here."
                  : `${filename}: ${conversationCount} conversation${conversationCount === 1 ? "" : "s"}, ${messages.length} visible messages.`}
                {mode === "account" && messages.length > 0
                  ? " Extract adds them to your saved profile. Tombstoned facts stay buried."
                  : ""}
              </p>
              {warnings.length > 0 ? (
                <ul>
                  {warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </section>
            {error ? <p className="error" role="alert">{error}</p> : null}
            {storageWarning ? (
              <p className="notice">The import rows were saved. The raw file upload did not: {storageWarning}</p>
            ) : null}
            <Desk
              draft={draft}
              busy={busy}
              canExtract={messages.length > 0}
              onExtract={() => void extract()}
              onReextract={() => void reextract()}
              onDecision={(decision) => void onDecision(decision)}
            />
          </>
        )}
        <EvalPanel />
      </main>
    </div>
  );
}
