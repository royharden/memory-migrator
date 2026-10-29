import type { ActionReceipt } from "../state/actions.ts";

/** Deletion / undo receipts: IDs and counts only, never the erased text. */
export function ReceiptView({ receipt, onDismiss }: { receipt: ActionReceipt; onDismiss: () => void }) {
  return (
    <section className="receipt" role="status" aria-live="polite">
      {receipt.type === "delete" ? (
        <>
          <h3>{receipt.receipt.mode === "erase" ? "Erase receipt" : "Hide receipt"}</h3>
          <ul>
            <li>Facts: {receipt.receipt.generationIds.join(", ")}</li>
            <li>Tombstones written: {receipt.receipt.tombstoneIds.length}</li>
            {receipt.receipt.mode === "erase" ? (
              <>
                <li>Revisions purged: {receipt.receipt.purgedRevisions}</li>
                <li>Quotes purged: {receipt.receipt.purgedQuotes}</li>
              </>
            ) : (
              <li>Quotes kept in-app but excluded everywhere portable: {receipt.receipt.hiddenQuotes}</li>
            )}
            <li>
              Retained dependencies (other facts quoting overlapping text):{" "}
              {receipt.receipt.retainedDependencies.length > 0 ? receipt.receipt.retainedDependencies.join(", ") : "none"}
            </li>
            <li>Restorations closed: {receipt.receipt.closedRestorations}</li>
            <li>Conflict groups recomputed: {receipt.receipt.recomputedGroups.length}</li>
            <li>Versions now shown redacted: {receipt.receipt.redactedVersions.length > 0 ? receipt.receipt.redactedVersions.map((v) => `v${v}`).join(", ") : "none"}</li>
            <li>Prepared downloads and previews were invalidated; rebuild them before downloading.</li>
          </ul>
          <p className="muted">Not covered: your source files, files you already downloaded, browser/OS memory and any provider backups.</p>
        </>
      ) : receipt.type === "undo" ? (
        <>
          <h3>Undo import receipt</h3>
          <ul>
            <li>Pending facts removed: {receipt.receipt.removedGenerations.length}</li>
            <li>Evidence links removed: {receipt.receipt.removedLinks}</li>
            <li>
              Kept: {receipt.receipt.retainedGenerations.length}
              {receipt.receipt.retainedGenerations.length > 0 ? ` (${receipt.receipt.retainedGenerations.map((r) => `${r.generationId}: ${r.reason}`).join("; ")})` : ""}
            </li>
            <li>Evidence kept because it was a fact's last support: {receipt.receipt.retainedLinks}</li>
          </ul>
        </>
      ) : (
        <p>Approved {receipt.approved} fact(s); skipped {receipt.skipped} (sensitive, in an open conflict, or without valid evidence).</p>
      )}
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </section>
  );
}
