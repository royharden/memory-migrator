import { useEffect, useMemo, useState, type ReactNode } from "react";
import { messageLookupKey } from "../../supabase/functions/_shared/mm/evidence.ts";
import type { ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import type { CanonicalMessage } from "../../supabase/functions/_shared/mm/source.ts";
import type { ExtractResponse } from "../import/protocol.ts";
import type { ActionOutcome, ActionReceipt, ProfileAction } from "../state/actions.ts";
import { EvaluationPanel } from "./EvaluationPanel.tsx";
import { ExportPanel } from "./ExportPanel.tsx";
import { HistoryPanel } from "./HistoryPanel.tsx";
import { ImportPanel } from "./ImportPanel.tsx";
import { ReceiptView } from "./ReceiptView.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { VersionsPanel } from "./VersionsPanel.tsx";

type Tab = "import" | "review" | "export" | "versions" | "history" | "evaluation";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "import", label: "Import" },
  { id: "review", label: "Review" },
  { id: "export", label: "Export & profile file" },
  { id: "versions", label: "Versions" },
  { id: "history", label: "History" },
  { id: "evaluation", label: "Evaluation" },
];

export interface WorkspaceProps {
  mode: "local" | "account";
  initial: ProfileState;
  perform: (state: ProfileState, action: ProfileAction) => Promise<ActionOutcome>;
  onExit: () => void;
  banner?: ReactNode;
  /** Account mode can refresh state from the server after a conflict. */
  reload?: () => Promise<ProfileState | null>;
}

export function Workspace({ mode, initial, perform, onExit, banner, reload }: WorkspaceProps) {
  const [profile, setProfile] = useState<ProfileState>(initial);
  const [tab, setTab] = useState<Tab>("import");
  const [extraction, setExtraction] = useState<ExtractResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedRevision, setSavedRevision] = useState(initial.revision);

  // Local source context (attached source) for evidence verification and adjacent context.
  const sourceMap = useMemo(() => {
    if (!extraction) return null;
    const map = new Map<string, CanonicalMessage>();
    for (const conversation of extraction.conversations) {
      for (const message of conversation.messages) map.set(messageLookupKey(message.conversationId, message.messageId), message);
    }
    return map;
  }, [extraction]);

  const dirty = mode === "local" && profile.revision !== savedRevision;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function run(action: ProfileAction): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await perform(profile, action);
      if (!outcome.ok) {
        setError(outcome.message);
        return false;
      }
      setProfile(outcome.state);
      setReceipt(outcome.receipt ?? null);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function exit() {
    if (dirty && !window.confirm("Leave local mode? Unsaved local work will be lost unless you downloaded your profile.")) return;
    onExit();
  }

  return (
    <main className="shell">
      <header className="top">
        <p className="eyebrow">Portable memory migrator · {mode === "local" ? "Local mode (memory only)" : "Private account"}</p>
        <h1>Review desk</h1>
        {mode === "local" ? <p>Nothing leaves this tab. Reloading loses unsaved work — download your profile file to keep it.</p> : null}
        <div className="row-actions">
          <button type="button" onClick={exit}>Change mode</button>
          {reload ? (
            <button type="button" onClick={() => void reload().then((next) => next && setProfile(next))} disabled={busy}>
              Reload from account
            </button>
          ) : null}
        </div>
      </header>
      {banner}
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? "tab active" : "tab"} aria-current={t.id === tab ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {receipt ? <ReceiptView receipt={receipt} onDismiss={() => setReceipt(null)} /> : null}
      {dirty ? (
        <p className="notice">
          Unsaved local changes (profile revision {profile.revision}). profile.v1.json keeps only approved, exportable facts and deletion records — pending, rejected and hidden facts, conflict decisions and versions are lost on reload.
        </p>
      ) : null}

      {/* Kept mounted (hidden) so loaded sources, a running worker and Clear source survive tab switches. */}
      <div hidden={tab !== "import"}>
        <ImportPanel profile={profile} extraction={extraction} onExtraction={setExtraction} run={run} busy={busy} />
      </div>
      {tab === "review" ? <ReviewPanel profile={profile} sourceMap={sourceMap} extraction={extraction} run={run} busy={busy} /> : null}
      {tab === "export" ? <ExportPanel profile={profile} run={run} busy={busy} onPortableSaved={() => setSavedRevision(profile.revision)} /> : null}
      {tab === "versions" ? <VersionsPanel profile={profile} run={run} busy={busy} /> : null}
      {tab === "history" ? <HistoryPanel profile={profile} run={run} busy={busy} /> : null}
      {tab === "evaluation" ? <EvaluationPanel /> : null}
    </main>
  );
}
