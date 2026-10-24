import { useMemo, useState } from "react";
import { renderBundle, renderMarkdown, renderPrompt } from "../../supabase/functions/_shared/exportProfile.ts";
import type { Decision } from "../../supabase/functions/_shared/review.ts";
import type { Fact, ProfileDraft } from "../../supabase/functions/_shared/types.ts";

interface DeskProps {
  draft: ProfileDraft | null;
  busy: boolean;
  canExtract: boolean;
  onExtract: () => void;
  onReextract: () => void;
  onDecision: (decision: Decision) => void;
}

function download(filename: string, contents: string, type: string) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function statusLabel(fact: Fact): string {
  if (fact.status === "needs_confirmation") return "Hold";
  if (fact.status === "proposed") return "Review";
  if (fact.status === "confirmed") return "Confirmed";
  if (fact.status === "superseded") return "Superseded";
  return "Removed";
}

export function Desk({ draft, busy, canExtract, onExtract, onReextract, onDecision }: DeskProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const markdown = useMemo(() => (draft ? renderMarkdown(draft.facts, "Memory profile") : ""), [draft]);
  const prompt = useMemo(() => (draft ? renderPrompt(draft.facts) : ""), [draft]);
  const bundle = useMemo(() => (draft ? renderBundle(draft.facts, draft.events) : ""), [draft]);

  return (
    <section className="panel" aria-labelledby="desk-heading">
      <h2 id="desk-heading">Review desk</h2>
      <p className="muted">Source kind is mined history. ChatGPT's saved-memory field is not in this import. Nothing is exported until you confirm it.</p>
      <div className="row-actions">
        <button className="primary" type="button" disabled={!canExtract || busy} onClick={onExtract}>Extract facts</button>
        <button type="button" disabled={!canExtract || !draft || busy} onClick={onReextract}>Extract again</button>
      </div>
      {!draft ? <p>Load an export, then extract. Facts stay empty until that step finishes.</p> : null}
      {draft && draft.conflicts.length > 0 ? (
        <div>
          <h3>Old versus new</h3>
          <ul className="stack-list">
            {draft.conflicts.map((pair) => {
              const older = draft.facts.find((fact) => fact.id === pair.olderId);
              const newer = draft.facts.find((fact) => fact.id === pair.newerId);
              return (
                <li key={`${pair.olderId}-${pair.newerId}`} className="fact fact-hold">
                  <p><strong>{pair.slot}</strong> · {pair.reason.replaceAll("_", " ")}</p>
                  <p>Older: {older?.statement ?? pair.olderId}</p>
                  <p>Newer: {newer?.statement ?? pair.newerId}</p>
                  <div className="row-actions">
                    <button type="button" disabled={busy} onClick={() => onDecision({ type: "keep_newer", olderId: pair.olderId, newerId: pair.newerId })}>Keep newer</button>
                    <button type="button" disabled={busy} onClick={() => onDecision({ type: "keep_older", olderId: pair.olderId, newerId: pair.newerId })}>Keep older</button>
                    <button type="button" disabled={busy} onClick={() => onDecision({ type: "keep_both", olderId: pair.olderId, newerId: pair.newerId })}>Keep both</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {draft ? (
        <ul className="stack-list">
          {draft.facts.map((fact) => (
            <li key={fact.id} className={fact.status === "needs_confirmation" ? "fact fact-hold" : fact.status === "confirmed" ? "fact fact-confirmed" : "fact"}>
              <p>
                <strong>{fact.statement}</strong>
                <span className="tag">{statusLabel(fact)}</span>
                {fact.sensitivity !== "none" ? <span className="tag">{fact.sensitivity}</span> : null}
                {fact.userEdited ? <span className="tag">edited</span> : null}
              </p>
              {fact.status === "tombstoned" ? (
                <p className="muted">Quote omitted. Id {fact.id}</p>
              ) : (
                <blockquote className="quote">"{fact.provenance.quote}" · message {fact.provenance.messageId}</blockquote>
              )}
              {fact.confirmationReason ? <p className="muted">{fact.confirmationReason}</p> : null}
              {fact.status === "proposed" || fact.status === "needs_confirmation" || fact.status === "confirmed" ? (
                <div className="row-actions">
                  {fact.status !== "confirmed" ? (
                    <button type="button" disabled={busy} onClick={() => onDecision({ type: "confirm", factId: fact.id })}>Confirm</button>
                  ) : null}
                  <button type="button" disabled={busy} onClick={() => { setEditingId(fact.id); setEditValue(fact.value); }}>Edit</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => onDecision({ type: "delete", factId: fact.id })}>Delete</button>
                </div>
              ) : null}
              {editingId === fact.id ? (
                <form className="row-actions" onSubmit={(event) => {
                  event.preventDefault();
                  onDecision({ type: "edit", factId: fact.id, value: editValue });
                  setEditingId(null);
                }}>
                  <label>
                    New value
                    <input value={editValue} onChange={(event) => setEditValue(event.target.value)} />
                  </label>
                  <button className="primary" type="submit" disabled={busy}>Save edit</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {draft ? (
        <div>
          <h3>Change log</h3>
          <ol className="log">
            {draft.events.map((item) => (
              <li key={item.id}><span className="tag">{item.action}</span> {item.detail}</li>
            ))}
          </ol>
          <h3>Take it with you</h3>
          <div className="row-actions">
            <button type="button" onClick={() => download("memory-profile.md", markdown, "text/markdown")}>Download Markdown</button>
            <button type="button" onClick={() => download("memory-prompt.txt", prompt, "text/plain")}>Download prompt</button>
            <button type="button" onClick={() => download("memory-profile.json", bundle, "application/json")}>Download bundle</button>
          </div>
          <label>
            Pasteable prompt
            <textarea readOnly value={prompt} rows={8} />
          </label>
        </div>
      ) : null}
    </section>
  );
}
