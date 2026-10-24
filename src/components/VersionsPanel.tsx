import { useState } from "react";
import type { ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import { diffVersions, renderVersion } from "../../supabase/functions/_shared/mm/versions.ts";
import type { ProfileAction } from "../state/actions.ts";

export function VersionsPanel({ profile, run, busy }: { profile: ProfileState; run: (a: ProfileAction) => Promise<boolean>; busy: boolean }) {
  const [label, setLabel] = useState("");
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const [viewSeq, setViewSeq] = useState<number | null>(null);
  const [revealHidden, setRevealHidden] = useState(false);
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const view = viewSeq !== null ? renderVersion(profile, viewSeq, revealHidden) : null;
  const diff = from !== "" && to !== "" ? diffVersions(profile, from, to) : null;

  return (
    <section className="panel stack">
      <h2>Publish a version</h2>
      <p className="muted">A version records which approved revisions were current, using the same export rule. Labels are your own text; profile files use generated labels (v1, v2…) unless you choose otherwise.</p>
      <div className="row-actions">
        <input aria-label="Version label" placeholder={`v${profile.nextVersionSeq}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        <label><input type="checkbox" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} /> Include confirmed sensitive facts</label>
        <button type="button" className="primary" disabled={busy} onClick={() => void run({ kind: "publish", label, includeSensitive }).then((ok) => ok && setLabel(""))}>Publish</button>
      </div>

      <h2>Versions</h2>
      {profile.versions.length === 0 ? <p className="muted">No versions yet.</p> : null}
      <ul className="versions">
        {profile.versions.map((v) => {
          const rendered = renderVersion(profile, v.seq);
          return (
            <li key={v.seq}>
              <button type="button" className="link" onClick={() => setViewSeq(v.seq)}>{v.label}</button>{" "}
              <span className="muted">
                {v.createdAt} · {v.items.length} fact(s) · digest {v.digest.slice(0, 12)}… {rendered?.redacted ? "· contains redactions (original digest no longer verifies)" : rendered?.originalDigestVerifies ? "· digest verifies" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      {view ? (
        <div className="report">
          <h3>{view.version.label}</h3>
          <label><input type="checkbox" checked={revealHidden} onChange={(e) => setRevealHidden(e.target.checked)} /> Show hidden facts in this private view</label>
          <ul>{view.rows.map((r) => <li key={r.generationId} className={r.status !== "ok" ? "muted" : ""}>{r.text}{r.userAuthored ? " (your wording)" : ""}</li>)}</ul>
          {view.redacted ? <p className="muted">Redacted rendering digest {view.renderingDigest.slice(0, 12)}… (differs from the original).</p> : null}
        </div>
      ) : null}

      {profile.versions.length >= 2 ? (
        <>
          <h2>Compare</h2>
          <div className="row-actions">
            <select aria-label="From version" value={from} onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : "")}>
              <option value="">from…</option>
              {profile.versions.map((v) => <option key={v.seq} value={v.seq}>{v.label}</option>)}
            </select>
            <select aria-label="To version" value={to} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : "")}>
              <option value="">to…</option>
              {profile.versions.map((v) => <option key={v.seq} value={v.seq}>{v.label}</option>)}
            </select>
          </div>
          {diff ? (
            <div className="report">
              <p>Added {diff.added.length} · removed {diff.removed.length} · changed {diff.changed.length} · unchanged {diff.unchanged}</p>
              <ul>
                {diff.added.map((r) => <li key={`a-${r.generationId}`}>+ {r.text}</li>)}
                {diff.removed.map((r) => <li key={`r-${r.generationId}`}>− {r.text}</li>)}
                {diff.changed.map((c) => <li key={`c-${c.after.generationId}`}>~ {c.before.text} → {c.after.text}</li>)}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
