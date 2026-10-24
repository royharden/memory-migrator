import { useEffect, useRef, useState } from "react";
import { exclusionSummary, exportProjection, renderMarkdown, renderPrompt, type PromptResult } from "../../supabase/functions/_shared/mm/exporting.ts";
import { LIMITS } from "../../supabase/functions/_shared/mm/limits.ts";
import { currentRevision, type ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { buildPortable, previewProfileImport, validatePortable, type PortableProfile, type ProfileImportPreview } from "../../supabase/functions/_shared/mm/portable.ts";
import { makeCtx, type ProfileAction } from "../state/actions.ts";

interface Prepared {
  revision: number;
  includeSensitive: boolean;
  budget: number;
  markdownUrl: string;
  jsonUrl: string;
  prompt: PromptResult;
  factCount: number;
}

interface Props {
  profile: ProfileState;
  run: (action: ProfileAction) => Promise<boolean>;
  busy: boolean;
  /** Called only when the downloaded profile.v1.json holds the complete working state. */
  onPortableSaved: () => void;
}

const REASON_LABEL: Record<string, string> = {
  not_live: "hidden or erased",
  not_approved: "not approved",
  stale_approval: "edited after approval",
  superseded: "superseded",
  suppressed: "suppressed",
  open_group: "in an open conflict",
  no_valid_evidence: "no valid quote",
  sensitive_unconfirmed: "sensitive, not confirmed",
  sensitive_not_included: "sensitive, not included in this export",
  purged: "erased",
};

/** True when nothing outside profile.v1.json would be lost: every live fact is exported, no versions or decisions only held in-app. */
function portableIsComplete(profile: ProfileState, includeSensitive: boolean): boolean {
  const exported = new Set(exportProjection(profile, { includeSensitive }).map((i) => i.generation.id));
  const allLiveExported = Object.values(profile.generations).every((g) => g.lifecycle === "erased" || exported.has(g.id));
  const hasDecisions = Object.values(profile.groups).some((g) => g.state === "resolved" && g.resolution?.decision !== "dissolved");
  return allLiveExported && !hasDecisions && profile.versions.length === 0;
}

export function ExportPanel({ profile, run, busy, onPortableSaved }: Props) {
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const [budget, setBudget] = useState<number>(LIMITS.defaultPromptBudget);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const preparedRef = useRef<Prepared | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  function revoke(p: Prepared | null) {
    if (!p) return;
    URL.revokeObjectURL(p.markdownUrl);
    URL.revokeObjectURL(p.jsonUrl);
  }

  // Any profile change, sensitivity toggle or budget change invalidates prepared downloads.
  useEffect(() => {
    const p = preparedRef.current;
    if (p && (p.revision !== profile.revision || p.includeSensitive !== includeSensitive || p.budget !== budget)) {
      revoke(p);
      preparedRef.current = null;
      setPrepared(null);
    }
  }, [profile.revision, includeSensitive, budget]);

  useEffect(() => () => revoke(preparedRef.current), []);

  function prepare() {
    revoke(preparedRef.current);
    const options = { includeSensitive };
    const items = exportProjection(profile, options);
    const markdown = renderMarkdown(items, options);
    const { bytes } = buildPortable(profile, options);
    const next: Prepared = {
      revision: profile.revision,
      includeSensitive,
      budget,
      markdownUrl: URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" })),
      jsonUrl: URL.createObjectURL(new Blob([bytes], { type: "application/json;charset=utf-8" })),
      prompt: renderPrompt(items, budget),
      factCount: items.length,
    };
    preparedRef.current = next;
    setPrepared(next);
  }

  const summary = exclusionSummary(profile, { includeSensitive });
  const excluded = Object.entries(summary).filter(([, n]) => n > 0);

  return (
    <section className="panel stack">
      <h2>Export</h2>
      <p className="muted">Markdown, the paste prompt and profile.v1.json all use the same rule: only approved, current, conflict-free facts with a valid quote. Sensitive facts appear only if confirmed and included below.</p>
      <label><input type="checkbox" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} /> Include sensitive facts I confirmed (off by default; applies to this export only)</label>
      <label>Prompt budget (Unicode characters) <input type="number" min={100} max={100000} value={budget} onChange={(e) => setBudget(Math.max(100, Number(e.target.value) || LIMITS.defaultPromptBudget))} /></label>
      <p className="muted">The budget is a convenience, not any assistant's real limit.</p>
      {excluded.length > 0 ? <p className="muted">Excluded: {excluded.map(([reason, n]) => `${n} ${REASON_LABEL[reason] ?? reason}`).join(" · ")}.</p> : null}
      <button type="button" className="primary" onClick={prepare}>Prepare downloads</button>
      {prepared ? (
        <div className="report">
          <p>{prepared.factCount} fact(s) included.</p>
          <div className="row-actions">
            <a className="button" href={prepared.markdownUrl} download="memory-profile.md">Download Markdown</a>
            <a className="button" href={prepared.jsonUrl} download="profile.v1.json" onClick={() => { if (portableIsComplete(profile, prepared.includeSensitive)) onPortableSaved(); }}>Download profile.v1.json</a>
          </div>
          <h3>Paste prompt ({prepared.prompt.length} / {prepared.prompt.budget})</h3>
          <textarea readOnly rows={8} value={prepared.prompt.text} aria-label="Paste prompt" />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(prepared.prompt.text).then(
                () => setCopyNote("Copied."),
                () => setCopyNote("Copy failed; select the text and copy it manually."),
              )
            }
          >
            Copy prompt
          </button>
          {copyNote ? <span className="muted"> {copyNote}</span> : null}
          {prepared.prompt.omitted.length > 0 ? (
            <p className="notice">
              Omitted to fit the budget ({prepared.prompt.omitted.length}):{" "}
              {prepared.prompt.omitted.map((id) => (profile.generations[id] ? currentRevision(profile.generations[id]).assertion : id)).join("; ")}. Facts are never cut in half. The Markdown and JSON files still contain them.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="muted">Downloads are rebuilt after every change so a stale file is never offered.</p>
      )}
      <ProfileFileImport profile={profile} run={run} busy={busy} />
    </section>
  );
}

function ProfileFileImport({ profile, run, busy }: { profile: ProfileState; run: (action: ProfileAction) => Promise<boolean>; busy: boolean }) {
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [file, setFile] = useState<PortableProfile | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function choose(list: FileList | null) {
    setPreview(null);
    setErrors([]);
    const file = list?.[0];
    if (!file) return;
    if (file.size > LIMITS.maxPortableBytes) {
      setErrors([`Profile files are limited to 1 MiB; ${file.name} is larger. Bundles are never split silently.`]);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setErrors([`Could not read ${file.name}.`]);
      return;
    }
    const result = validatePortable(text);
    if (!result.ok) {
      setErrors(result.errors.slice(0, 20));
      return;
    }
    setFile(result.profile);
    setPreview(previewProfileImport(profile, result.profile, makeCtx()));
  }

  const stale = preview !== null && preview.baseRevision !== profile.revision;
  return (
    <div className="report">
      <h2>Reopen or merge a profile file</h2>
      <p className="muted">Imported facts arrive as pending. Approval, verification or restore flags inside a file are never trusted. Quotes from a file show “original source not attached”.</p>
      <input
        type="file"
        accept=".json,application/json"
        aria-label="Choose profile.v1.json"
        onChange={(e) => {
          const input = e.target;
          void choose(input.files).finally(() => {
            input.value = ""; // allow choosing the same file again (repeat-import check)
          });
        }}
      />
      {errors.length > 0 ? (
        <ul className="error" role="alert">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
      ) : null}
      {preview ? (
        <>
          {preview.integrityErrors.length > 0 ? <ul className="error">{preview.integrityErrors.map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
          <p>
            Facts in file {preview.counts.facts} · new {preview.counts.created} · same as existing (evidence merged) {preview.counts.sameAttached} · unchanged {preview.counts.unchanged} · proposals {preview.counts.proposals} · suppressed {preview.counts.suppressed} · stale {preview.counts.staleForeign}
          </p>
          <p>
            Deletion records to add {preview.counts.tombstonesAdded}; local facts they will hide {preview.counts.localMatchesHidden}
            {preview.tombstoneEffects.length > 0 ? ` (${preview.tombstoneEffects.map((t) => (profile.generations[t.generationId] ? currentRevision(profile.generations[t.generationId]).assertion : t.generationId)).join("; ")})` : ""}.
          </p>
          {preview.noop ? <p className="muted">Nothing new — applying would change nothing.</p> : null}
          {stale ? <p className="error">The profile changed after this preview; choose the file again.</p> : null}
          <button type="button" className="primary" disabled={busy || stale || preview.noop || preview.integrityErrors.length > 0} onClick={() => file && void run({ kind: "commitProfileImport", preview, profile: file }).then((ok) => ok && setPreview(null))}>
            Apply
          </button>
        </>
      ) : null}
    </div>
  );
}
