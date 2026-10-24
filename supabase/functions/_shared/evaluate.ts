import { normalizeValue } from "./ids.ts";
import type { Fact } from "./types.ts";

export interface GoldLabel {
  slot: string;
  value: string;
  messageId: string;
  conversationId?: string;
}

export interface EvalScore {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  unprovenanced: number;
  provenanceMismatches: number;
  invariantOk: boolean;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function scoreExtraction(predicted: Fact[], labels: GoldLabel[]): EvalScore {
  const unprovenanced = predicted.filter((fact) => !fact.provenance.messageId || !fact.provenance.quote).length;
  const usable = predicted.filter((fact) => fact.provenance.messageId && fact.provenance.quote);
  const matchedLabels = new Set<number>();
  const matchedPredictions = new Set<number>();
  let provenanceMismatches = 0;

  for (let index = 0; index < usable.length; index += 1) {
    const fact = usable[index];
    const labelIndex = labels.findIndex((label, labelPosition) => {
      if (matchedLabels.has(labelPosition)) return false;
      return label.slot === fact.slot && normalizeValue(label.value) === normalizeValue(fact.value);
    });
    if (labelIndex === -1) continue;
    const label = labels[labelIndex];
    if (label.messageId !== fact.provenance.messageId) {
      provenanceMismatches += 1;
      continue;
    }
    matchedLabels.add(labelIndex);
    matchedPredictions.add(index);
  }

  const truePositive = matchedPredictions.size;
  const falsePositive = usable.length - truePositive + unprovenanced;
  const falseNegative = labels.length - truePositive;
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
    unprovenanced,
    provenanceMismatches,
    invariantOk: unprovenanced === 0 && provenanceMismatches === 0,
  };
}
