import type { Fact, Sensitivity } from "./types.ts";

const FINANCIAL = /\b(salary|wage|bank account|routing number|social security|\bssn\b|credit card|net worth)\b/i;
const HEALTH = /\b(allerg|diagnos|medication|prescription|therap|pregnant|depression|anxiety|symptom|illness)\b/i;
const INTIMATE = /\b(sexual|sex life|intimacy|\bstd\b|\bhiv\b)\b/i;

export function classifySensitivity(text: string): Sensitivity {
  if (FINANCIAL.test(text)) return "financial";
  if (HEALTH.test(text)) return "health";
  if (INTIMATE.test(text)) return "intimate";
  return "none";
}

export function applySensitivity(facts: Fact[]): Fact[] {
  return facts.map((fact) => {
    if (fact.sensitivity === "none") return fact;
    if (fact.status === "superseded" || fact.status === "tombstoned") return fact;
    const tag = `sensitivity_${fact.sensitivity}`;
    const reason = fact.confirmationReason ? `${fact.confirmationReason}; ${tag}` : tag;
    return { ...fact, status: "needs_confirmation", confirmationReason: reason };
  });
}
