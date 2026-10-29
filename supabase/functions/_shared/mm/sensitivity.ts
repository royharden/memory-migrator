import type { SensitivityCategory, Slot } from "./model.ts";
import { uniqueSorted } from "./model.ts";

/**
 * Rule-based sensitivity classification over assertion, value and quote (PLAN §5).
 * Stems use a trailing \w* so "allergy", "diagnosed", "therapy", "medications"
 * all match (fixes the reported trailing-boundary stem failures). Rules miss
 * cases, so the UI offers review-all; classification is never lowered implicitly.
 */
const RULES: Record<SensitivityCategory, RegExp[]> = {
  health: [
    /\b(?:allerg|diagnos|therap|medicat|prescri|depress|anxi|adhd|autis|diabet|cancer|tumou?r|pregnan|disorder|illness|disease|symptom|surger|chemo|asthma|epilep|migraine|insulin|hiv|bipolar|schizo|psychiatr|psycholog|counsel|rehab|addict|disabilit)\w*/iu,
    /\bmental health\b/iu,
  ],
  finance: [
    /\b(?:salar|income|debt|loan|mortgag|bankrupt|wage|paycheck|savings|invest|credit card|credit score|net worth|tax return)\w*/iu,
    /\b(?:earn|make)s? \$?\d/iu,
    /[$€£]\s?\d/u,
    /\b\d[\d,]*(?:\.\d+)?\s?(?:k|thousand|million)?\s(?:dollars|usd|eur|euros|pounds|gbp)\b/iu,
  ],
  intimate: [
    /\b(?:girlfriend|boyfriend|wife|husband|spouse|partner|fianc|divorc|dating|marri|sexual|sex life|affair|gay|lesbian|bisexual|transgender|queer|pregnan)\w*/iu,
  ],
  belief: [
    /\b(?:religio|christian|catholic|muslim|islam|jewish|judais|hindu|buddhis|atheis|agnostic|church|mosque|synagogue|temple|pray|democrat|republican|politic|conservative|liberal|socialis|vote|voting)\w*/iu,
  ],
  minors: [
    /\bmy (?:son|daughter|kids?|child|children|baby|toddler|teen(?:ager)?)\b/iu,
    /\b(?:[1-9]|1[0-7])[- ]year[- ]old\b/iu,
  ],
  precise_location: [
    /\b\d{1,6}\s+(?:[\p{L}'-]+\s+){1,4}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way|place|pl)\b/iu,
    /\b(?:apartment|apt|unit|suite)\s*#?\s*\d+/iu,
    /\b(?:zip|postal)\s*code\b/iu,
    /\b\d{5}(?:-\d{4})?\b/u,
  ],
};

const SLOT_HINTS: Partial<Record<Slot, SensitivityCategory>> = {
  "health.note": "health",
  "financial.note": "finance",
};

export function classifyText(text: string): SensitivityCategory[] {
  const hits: SensitivityCategory[] = [];
  for (const [category, patterns] of Object.entries(RULES) as [SensitivityCategory, RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(text))) hits.push(category);
  }
  return hits;
}

/** Union over every included text (assertion, value, quote) plus the slot hint. */
export function classifyCandidate(slot: Slot, texts: string[]): SensitivityCategory[] {
  const hits = texts.flatMap((text) => classifyText(text));
  const hint = SLOT_HINTS[slot];
  if (hint) hits.push(hint);
  return uniqueSorted(hits);
}

/** Editing never lowers classification automatically: union with the prior set. */
export function mergeSensitivity(previous: SensitivityCategory[], next: SensitivityCategory[]): SensitivityCategory[] {
  return uniqueSorted([...previous, ...next]);
}
