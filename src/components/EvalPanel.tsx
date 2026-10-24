import { useMemo } from "react";
import fixture from "../fixtures/labelled-set.json";
import { scoreExtraction } from "../../supabase/functions/_shared/evaluate.ts";
import type { GoldLabel } from "../../supabase/functions/_shared/evaluate.ts";
import { parseChatGptExport } from "../../supabase/functions/_shared/parseChatGpt.ts";
import { buildProfile } from "../../supabase/functions/_shared/review.ts";

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function EvalPanel() {
  const score = useMemo(() => {
    const parsed = parseChatGptExport(fixture.export);
    const draft = buildProfile(parsed.messages, "2026-10-23T00:00:00.000Z");
    return scoreExtraction(draft.facts, fixture.labels as GoldLabel[]);
  }, []);

  return (
    <section className="panel" aria-labelledby="eval-heading">
      <h2 id="eval-heading">Hand-labelled score</h2>
      <p className="muted">
        Synthetic fixture {fixture.id}. {fixture.notes} This measures extraction against the labels, including superseded facts. It is not a retrieval benchmark.
      </p>
      <dl className="score">
        <div><dt>Precision</dt><dd>{percent(score.precision)}</dd></div>
        <div><dt>Recall</dt><dd>{percent(score.recall)}</dd></div>
        <div><dt>F1</dt><dd>{percent(score.f1)}</dd></div>
        <div><dt>True positives</dt><dd>{score.truePositive}</dd></div>
        <div><dt>False positives</dt><dd>{score.falsePositive}</dd></div>
        <div><dt>False negatives</dt><dd>{score.falseNegative}</dd></div>
      </dl>
      <p className={score.invariantOk ? "ok" : "error"}>
        {score.invariantOk
          ? "Provenance invariant holds. Every scored fact has a message id, and each match cites that message."
          : `Provenance invariant failed. Unprovenanced: ${score.unprovenanced}. Message mismatches: ${score.provenanceMismatches}.`}
      </p>
    </section>
  );
}
