import type { ProfileState } from "../../supabase/functions/_shared/mm/model.ts";
import type { ProfileAction } from "../state/actions.ts";

/** Imports (with bounded undo) and the id-only event log. No before/after text is kept. */
export function HistoryPanel({ profile, run, busy }: { profile: ProfileState; run: (a: ProfileAction) => Promise<boolean>; busy: boolean }) {
  return (
    <section className="panel stack">
      <h2>Imports</h2>
      {profile.imports.length === 0 ? <p className="muted">No imports applied yet.</p> : null}
      <ul>
        {[...profile.imports].reverse().map((record) => (
          <li key={record.id}>
            {record.kind === "source" ? "ChatGPT selection" : "Profile file"} · {record.appliedAt} · created {record.createdGenerations.length}, evidence added {record.addedLinks.length}
            {record.undone ? (
              <span className="muted"> · undone</span>
            ) : (
              <>
                {" "}
                <button type="button" disabled={busy} onClick={() => void run({ kind: "undoImport", importId: record.id })}>Undo this import</button>
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">Undo removes only still-pending facts and quotes that this import alone introduced. Approved facts, version references, later edits, restores and deletions are kept.</p>
      <h2>Event log</h2>
      <ol className="events">
        {[...profile.events].reverse().slice(0, 200).map((event) => (
          <li key={event.seq}>
            #{event.seq} {event.at} {event.type} [{event.ids.length} id(s)]
            {event.counts ? ` ${Object.entries(event.counts).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}
