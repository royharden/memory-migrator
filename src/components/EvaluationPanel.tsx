import { useState } from "react";
import dev from "../../fixtures/synthetic/eval/dev.json";
import heldout from "../../fixtures/synthetic/eval/heldout-v2.json";
import manifest from "../../fixtures/synthetic/eval/manifest.json";
import { evaluate, type Counts, type EvalDataset, type EvalReport } from "../../supabase/functions/_shared/mm/evaluation.ts";
import { makeCtx } from "../state/actions.ts";

const DATASETS: Record<"heldout" | "dev", { data: EvalDataset; file: "heldout-v2.json" | "dev.json" }> = {
  heldout: { data: heldout as unknown as EvalDataset, file: "heldout-v2.json" },
  dev: { data: dev as unknown as EvalDataset, file: "dev.json" },
};

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function CountsRow({ label, c }: { label: string; c: Counts }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{c.tp}</td>
      <td>{c.fp}</td>
      <td>{c.fn}</td>
      <td>{pct(c.precision)}</td>
      <td>{pct(c.recall)}</td>
      <td>{pct(c.f1)}</td>
    </tr>
  );
}

/**
 * Runs the real parser/rules/reducer over the frozen synthetic fixture in this tab and
 * shows raw counts with denominators. Numbers appear only after a run; targets are
 * labelled as proposals and never shown as results.
 */
export function EvaluationPanel() {
  const [split, setSplit] = useState<"heldout" | "dev">("heldout");
  const [report, setReport] = useState<EvalReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expectedSha = manifest.files[DATASETS[split].file].labelSha256;
  const frozenRules = manifest.files[DATASETS[split].file].rulesAtFreeze;

  function run() {
    setError(null);
    try {
      setReport(evaluate(DATASETS[split].data, makeCtx()));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Evaluation failed.");
    }
  }

  return (
    <section className="panel stack">
      <h2>Evaluation (synthetic)</h2>
      <p className="muted">
        A small, wholly synthetic, hand-labelled fixture ({manifest.files["heldout-v2.json"].labels} held-out labels in {manifest.files["heldout-v2.json"].conversations} conversations, {manifest.files["heldout-v2.json"].eligibilitySentences} eligibility sentences). It is a smoke check, not a quality benchmark. The replacement split was authored after freezing the current rules, without running or tuning them. The old contaminated split is retained as regression material. An independent label audit is still pending.
      </p>
      <div className="row-actions">
        <label><input type="radio" name="split" checked={split === "heldout"} onChange={() => { setSplit("heldout"); setReport(null); }} /> Held-out split</label>
        <label><input type="radio" name="split" checked={split === "dev"} onChange={() => { setSplit("dev"); setReport(null); }} /> Dev split</label>
        <button type="button" className="primary" onClick={run}>Run evaluation in this tab</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {report ? (
        <div className="report">
          <p>
            Dataset {report.datasetId} · parser {report.parserVersion} · rules {report.extractorVersion}{" "}
            {report.extractorVersion === frozenRules ? (
              "(same rules as at freeze)"
            ) : (
              <strong className="error">(fixture froze with {frozenRules}; rules changed since, do not claim held-out quality)</strong>
            )}{" "}
            · label SHA-256 {report.datasetSha256.slice(0, 12)}…{" "}
            {report.datasetSha256 === expectedSha ? "matches the manifest" : <strong className="error">does NOT match the manifest — labels changed since freezing</strong>}
          </p>
          <p>
            {report.conversations} conversations · gold facts {report.goldFactsSupported} in supported slots ({report.goldFactsAll} including unsupported eligible statements) · predicted facts {report.predictedFacts} ({report.predictedOccurrences} occurrences)
          </p>
          <table className="table">
            <thead><tr><th>Facts</th><th>TP</th><th>FP</th><th>FN</th><th>Precision</th><th>Recall</th><th>F1</th></tr></thead>
            <tbody>
              <CountsRow label="All supported slots" c={report.overall} />
              {Object.entries(report.perSlot).map(([slot, c]) => <CountsRow key={slot} label={slot} c={c} />)}
              <CountsRow label={`Eligibility (${report.eligibility.sentences} sentences)`} c={report.eligibility} />
            </tbody>
          </table>
          <ul>
            <li>Supported-slot recall {pct(report.supportedSlotRecall)}; whole-corpus recall {pct(report.wholeCorpusRecall)}</li>
            <li>Occurrence coverage {report.occurrenceCoverage.matched}/{report.occurrenceCoverage.total} ({pct(report.occurrenceCoverage.rate)})</li>
            <li>Conflict groups: {report.groups.matchedGold}/{report.groups.goldGroups} gold groups found; {report.groups.correctPredicted}/{report.groups.predictedGroups} predicted groups correct (precision {pct(report.groups.precision)}, recall {pct(report.groups.recall)})</li>
            <li>Sensitivity misses: {report.sensitivity.labelledMisses}/{report.sensitivity.labelledTotal} labelled facts, {report.sensitivity.caseMisses}/{report.sensitivity.caseTotal} sensitivity-only cases</li>
            <li>Evidence: {report.evidence.verified}/{report.evidence.candidates} candidates resolve exactly against the source ({report.evidence.failures} failures; coverage {pct(report.evidence.provenanceCoverage)})</li>
          </ul>
          <p className="muted">
            Proposed targets (proposals, not results): supported-slot precision ≥ {report.proposedTargets.supportedSlotPrecision * 100}%, recall ≥ {report.proposedTargets.supportedSlotRecall * 100}%, {report.proposedTargets.resolvableEvidence * 100}% resolvable evidence.
          </p>
          <ul className="muted">{report.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      ) : (
        <p className="muted">No numbers are shown until you run it. Nothing here claims a measured quality.</p>
      )}
    </section>
  );
}
