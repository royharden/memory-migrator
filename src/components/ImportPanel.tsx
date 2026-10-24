import { useRef, useState } from "react";
import demo from "../../fixtures/synthetic/demo-export.json";
import { checkFileBounds, LIMITS } from "../../supabase/functions/_shared/mm/limits.ts";
import type { ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { previewCandidateImport, type ImportPreview } from "../../supabase/functions/_shared/mm/reducer.ts";
import { PARSER_VERSION, type ConversationIndexEntry, type Selection } from "../../supabase/functions/_shared/mm/source.ts";
import { utf8Length } from "../../supabase/functions/_shared/mm/unicode.ts";
import type { ExtractResponse, InventoryResponse, SourceShard } from "../import/protocol.ts";
import { runWorker, type RunningJob } from "../import/runWorker.ts";
import { makeCtx, type ProfileAction } from "../state/actions.ts";

interface Props {
  profile: ProfileState;
  extraction: ExtractResponse | null;
  onExtraction: (value: ExtractResponse | null) => void;
  run: (action: ProfileAction) => Promise<boolean>;
  busy: boolean;
}

const STATE_LABEL: Record<ConversationIndexEntry["state"], string> = {
  ok: "ready",
  needs_branch_choice: "choose a branch",
  broken_tree: "broken tree — skipped",
  collision: "id collision — resolve input",
  duplicate: "duplicate — ignored",
  empty: "no visible text",
};

function emptySelection(): Selection {
  return { conversationIds: null, from: null, to: null, includeUnknownDate: true, branchChoices: {} };
}

export function ImportPanel({ profile, extraction, onExtraction, run, busy }: Props) {
  const [sources, setSources] = useState<SourceShard[]>([]);
  const [inventory, setInventory] = useState<InventoryResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection>(emptySelection());
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [job, setJob] = useState<{ label: string; handle: RunningJob<unknown> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function resetDownstream() {
    setInventory(null);
    setSelected(new Set());
    setSelection(emptySelection());
    setPreview(null);
    setPreviewError(null);
    onExtraction(null);
  }

  function clearSource() {
    job?.handle.cancel();
    setJob(null);
    setSources([]);
    resetDownstream();
    if (fileInput.current) fileInput.current.value = "";
  }

  async function startInventory(next: SourceShard[]) {
    const bounds = checkFileBounds(next.map((s) => ({ name: s.name, size: s.size })));
    if (bounds) {
      setError(bounds.message);
      return;
    }
    setError(null);
    setSources(next);
    resetDownstream();
    const handle = runWorker({ type: "inventory", sources: next });
    setJob({ label: "Reading and inventorying files…", handle });
    try {
      const result = await handle.promise;
      setInventory(result);
      setSelected(new Set(result.index.filter((e) => e.state === "ok").map((e) => e.id)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Inventory failed.");
    } finally {
      setJob(null);
    }
  }

  function chooseFiles(list: FileList | null) {
    if (!list) return;
    const files = [...list];
    void startInventory(files.map((file) => ({ name: file.name, size: file.size, file })));
  }

  function loadDemo() {
    const text = JSON.stringify(demo.export);
    void startInventory([{ name: "synthetic-demo.json", size: utf8Length(text), text }]);
  }

  async function extract() {
    if (!inventory) return;
    const effective: Selection = { ...selection, conversationIds: [...selected] };
    setPreview(null);
    setPreviewError(null);
    const handle = runWorker({ type: "extract", sources, index: inventory.index, selection: effective });
    setJob({ label: "Extracting from selected conversations…", handle });
    try {
      const result = await handle.promise;
      onExtraction(result);
      const built = previewCandidateImport(profile, result.candidates, makeCtx(), PARSER_VERSION);
      if ("error" in built) setPreviewError(built.error);
      else setPreview(built);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Extraction failed.");
    } finally {
      setJob(null);
    }
  }

  async function apply() {
    if (!preview || !extraction) return;
    const ok = await run({ kind: "commitCandidateImport", preview, candidates: extraction.candidates, parserVersion: PARSER_VERSION });
    if (ok) setPreview(null);
  }

  const stale = preview !== null && preview.baseRevision !== profile.revision;
  const index = inventory?.index ?? [];
  const carriers = inventory?.shards.flatMap((s) => s.carriers) ?? [];
  const skips = inventory?.shards.reduce(
    (acc, s) => {
      for (const [k, v] of Object.entries(s.skips)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <section className="panel stack">
      <h2>1. Load a ChatGPT export</h2>
      <p className="muted">
        Up to {LIMITS.maxFiles} JSON files (conversations.json or shards), {LIMITS.maxFileBytes / 1024 / 1024} MiB each, {LIMITS.maxTotalBytes / 1024 / 1024} MiB total. ZIP files are not supported yet — unzip and choose conversations.json. Files are read in a background worker in this tab; nothing is uploaded.
      </p>
      <div className="row-actions">
        <input ref={fileInput} type="file" accept=".json,application/json" multiple aria-label="Choose ChatGPT JSON files" onChange={(event) => chooseFiles(event.target.files)} disabled={job !== null} />
        <button type="button" onClick={loadDemo} disabled={job !== null}>Load built-in synthetic demo</button>
        <button type="button" onClick={clearSource} disabled={sources.length === 0 && !job}>Clear source</button>
      </div>
      <p className="muted">Clear source releases the loaded files, the worker and local message context. Your reviewed profile (quotes only) stays. Erasing a fact never rewrites your source files.</p>
      {job ? (
        <p className="notice" role="status">
          {job.label}{" "}
          <button type="button" onClick={() => { job.handle.cancel(); setJob(null); }}>Cancel</button>
        </p>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}

      {inventory ? (
        <>
          <h2>2. Choose conversations</h2>
          {inventory.shards.map((shard) =>
            shard.fatal ? (
              <p key={shard.shardIndex} className="error">{shard.fileName}: {shard.fatal.detail}</p>
            ) : null,
          )}
          <div className="report">
            <p>
              {index.length} conversations found · skipped messages: system {skips?.system ?? 0}, tool {skips?.tool ?? 0}, hidden {skips?.hidden ?? 0}, non-text {skips?.nonText ?? 0}, unsupported parts {skips?.unsupportedParts ?? 0}, off-branch {skips?.offBranch ?? 0}, too long {skips?.tooLong ?? 0}.
            </p>
            {carriers.length > 0 ? (
              <p>
                Saved-context carriers found (<strong>not imported</strong>): {carriers.map((c) => `${c.category} ×${c.count}`).join(", ")}. Their presence does not prove they are your current saved memory.
              </p>
            ) : null}
            {inventory.shards.flatMap((s) => s.issues).length > 0 ? (
              <details>
                <summary>{inventory.shards.flatMap((s) => s.issues).length} diagnostics</summary>
                <ul>
                  {inventory.shards.flatMap((s) => s.issues).map((issue, i) => (
                    <li key={i}>{issue.code}{issue.conversationId ? ` (${issue.conversationId})` : ""}: {issue.detail}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <div className="row-actions">
            <label>From <input type="date" value={selection.from?.slice(0, 10) ?? ""} onChange={(e) => setSelection({ ...selection, from: e.target.value ? `${e.target.value}T00:00:00Z` : null })} /></label>
            <label>To <input type="date" value={selection.to?.slice(0, 10) ?? ""} onChange={(e) => setSelection({ ...selection, to: e.target.value ? `${e.target.value}T23:59:59Z` : null })} /></label>
            <label><input type="checkbox" checked={selection.includeUnknownDate} onChange={(e) => setSelection({ ...selection, includeUnknownDate: e.target.checked })} /> Include conversations with unknown dates</label>
          </div>
          <table className="table">
            <thead>
              <tr><th>Use</th><th>Title</th><th>Date</th><th>Messages (yours)</th><th>Status</th></tr>
            </thead>
            <tbody>
              {index.map((entry) => {
                const selectable = entry.state === "ok" || entry.state === "needs_branch_choice";
                return (
                  <tr key={`${entry.shardIndex}-${entry.id}`}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Use ${entry.title}`}
                        disabled={!selectable}
                        checked={selected.has(entry.id) && selectable}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(entry.id);
                          else next.delete(entry.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>{entry.title}</td>
                    <td>{entry.createTime?.slice(0, 10) ?? "unknown"}</td>
                    <td>{entry.activeVisibleMessages} ({entry.activeUserMessages})</td>
                    <td>
                      {STATE_LABEL[entry.state]}
                      {entry.state === "needs_branch_choice" ? (
                        <select
                          aria-label={`Branch for ${entry.title}`}
                          value={selection.branchChoices[entry.id] ?? ""}
                          onChange={(e) => {
                            const choices = { ...selection.branchChoices };
                            if (e.target.value) choices[entry.id] = e.target.value;
                            else delete choices[entry.id];
                            setSelection({ ...selection, branchChoices: choices });
                          }}
                        >
                          <option value="">skip</option>
                          {entry.branchLeaves.map((leaf) => <option key={leaf} value={leaf}>{leaf}</option>)}
                        </select>
                      ) : null}
                      {entry.stateDetail && entry.state !== "ok" ? <span className="muted"> — {entry.stateDetail}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="button" className="primary" onClick={() => void extract()} disabled={job !== null || selected.size === 0}>Extract from {selected.size} conversation(s)</button>
        </>
      ) : null}

      {extraction ? (
        <div className="report">
          <h2>3. Preview</h2>
          <p>
            Read {extraction.diagnostics.userMessages} of your messages ({extraction.diagnostics.assistantMessagesSkipped} assistant messages used only as local context). {extraction.candidates.length} candidate statements.
            Not stored as facts: question {extraction.diagnostics.ineligible.question}, hypothetical {extraction.diagnostics.ineligible.hypothetical}, quoted/reported {extraction.diagnostics.ineligible.reported}, third party {extraction.diagnostics.ineligible.third_party}, code {extraction.diagnostics.ineligible.code}, temporary {extraction.diagnostics.ineligible.temporary}, instruction {extraction.diagnostics.ineligible.instruction}; abstained {extraction.diagnostics.abstained.bad_value + extraction.diagnostics.abstained.ambiguous + extraction.diagnostics.abstained.quote_too_long}.
          </p>
          {extraction.diagnostics.forgetRequests.length > 0 ? (
            <p className="notice">{extraction.diagnostics.forgetRequests.length} message(s) asked ChatGPT to forget or remove something. They are not executed here; review and erase matching facts yourself if you want.</p>
          ) : null}
          {previewError ? <p className="error" role="alert">{previewError}</p> : null}
          {preview ? (
            <>
              <p>
                New facts {preview.counts.created} · new evidence on existing facts {preview.counts.attached} · unchanged {preview.counts.unchanged} · suppressed by earlier deletion {preview.counts.suppressed} · open conflict groups after apply {preview.counts.openGroups}
              </p>
              {preview.noop ? <p className="muted">Nothing new: applying would change nothing.</p> : null}
              {stale ? <p className="error">The profile changed after this preview was built. Extract again to rebuild it.</p> : null}
              <div className="row-actions">
                <button type="button" className="primary" onClick={() => void apply()} disabled={busy || stale || preview.noop}>Apply as pending facts</button>
                <button type="button" onClick={() => setPreview(null)}>Discard preview</button>
              </div>
              <p className="muted">Everything imported starts as pending. Nothing is approved automatically.</p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
