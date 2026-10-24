import { canonicalize, canonicalSha256, CODEC_VERSION } from "./canonical.ts";
import { evidenceKey, evidenceShapeErrors, type Evidence } from "./evidence.ts";
import { exportProjection, type ExportOptions } from "./exporting.ts";
import { recomputeGroups } from "./groups.ts";
import { LIMITS } from "./limits.ts";
import {
  appendEvent,
  currentRevision,
  identityKey,
  isSlot,
  isSuppressed,
  openRestoration,
  renderAssertion,
  SENSITIVITY_CATEGORIES,
  uniqueSorted,
  type Ctx,
  type EvidenceLink,
  type Generation,
  type ImportRecord,
  type Polarity,
  type ProfileState,
  type Revision,
  type SensitivityCategory,
  type Slot,
  type TombstoneMode,
} from "./model.ts";
import { cloneState } from "./reducer.ts";
import { classifyCandidate, classifyText, mergeSensitivity } from "./sensitivity.ts";
import { codePointLength, hasUnpairedSurrogate, utf8Length } from "./unicode.ts";

/**
 * Portable profile v1 (PLAN §7/§8). Current eligible facts/revisions only, referenced
 * quote evidence, tombstones and edit-alias hashes. Regenerated from current policy on
 * every download. The checksum detects accidental inconsistency; it is NOT authenticity.
 * Self-described approval/verification/restoration cannot grant authority on import.
 */

export const PROFILE_FORMAT = "memory-migrator.profile";
export const PROFILE_SCHEMA_VERSION = 1;

export interface PortableFact {
  id: string;
  revision: number;
  slot: Slot;
  polarity: Polarity;
  value: string;
  assertion: string;
  userAuthored: boolean;
  sensitivity: SensitivityCategory[];
  scopeNote?: string;
  firstSeen: string | null;
  lastSeen: string | null;
  aliasKeys: string[];
  evidence: Evidence[];
}

export interface PortableTombstone {
  id: string;
  generationId: string;
  keys: string[];
  mode: TombstoneMode;
  at: string;
}

export interface PortableVersion {
  seq: number;
  label: string;
  digest: string;
  createdAt: string;
}

export interface PortableProfile {
  format: typeof PROFILE_FORMAT;
  schemaVersion: 1;
  codecVersion: 1;
  originProfileId: string;
  parserVersions: string[];
  extractorVersions: string[];
  includeSensitive: boolean;
  facts: PortableFact[];
  tombstones: PortableTombstone[];
  versions: PortableVersion[];
  canonicalPayloadSha256: string;
}

const MAX_TOMBSTONES = 10_000;
const MAX_EVIDENCE_PER_FACT = 50;

export interface BuildOptions extends ExportOptions {
  /** Version labels are user content: generated v1/v2 labels unless explicitly included. */
  includeVersionLabels?: boolean;
}

export interface BuiltPortable {
  profile: PortableProfile;
  bytes: string;
  /** Visible notes about bounded content (e.g. quotes beyond the per-fact cap). */
  notices: string[];
  /** Non-empty when the file would exceed a bound; it must not be offered for download. */
  problems: string[];
}

export function buildPortable(state: ProfileState, options: BuildOptions): BuiltPortable {
  const notices: string[] = [];
  const problems: string[] = [];
  const items = exportProjection(state, options).map((item) => {
    if (item.evidence.length <= MAX_EVIDENCE_PER_FACT) return item;
    notices.push(`“${item.revision.assertion}” has ${item.evidence.length} supporting quotes; the file carries the first ${MAX_EVIDENCE_PER_FACT} (the fact itself is complete).`);
    return { ...item, evidence: item.evidence.slice(0, MAX_EVIDENCE_PER_FACT) };
  });
  if (items.length > LIMITS.maxCandidatesPerImport) problems.push(`${items.length} facts exceed the ${LIMITS.maxCandidatesPerImport}-fact limit of one profile file.`);
  const facts: PortableFact[] = items.map(({ generation, revision, evidence }) => ({
    id: generation.id,
    revision: revision.revision,
    slot: revision.slot,
    polarity: revision.polarity,
    value: revision.value as string,
    assertion: revision.assertion as string,
    userAuthored: revision.userAuthored,
    sensitivity: [...generation.sensitivity].sort(),
    ...(generation.scopeNote ? { scopeNote: generation.scopeNote } : {}),
    firstSeen: generation.firstSeen,
    lastSeen: generation.lastSeen,
    aliasKeys: [...generation.aliasKeys].sort(),
    evidence,
  }));
  const tombstones: PortableTombstone[] = state.tombstones
    .map((t) => ({ id: t.id, generationId: t.generationId, keys: [...t.keys].sort(), mode: t.mode, at: t.at }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const versions: PortableVersion[] = state.versions
    .map((v) => ({ seq: v.seq, label: options.includeVersionLabels ? v.label : `v${v.seq}`, digest: v.digest, createdAt: v.createdAt }))
    .sort((a, b) => a.seq - b.seq);
  const body = {
    format: PROFILE_FORMAT,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    codecVersion: CODEC_VERSION,
    originProfileId: state.profileId,
    parserVersions: uniqueSorted(facts.flatMap((f) => f.evidence.map((e) => e.parserVersion))),
    extractorVersions: uniqueSorted(
      items.flatMap(({ generation }) => generation.revisions.map((r) => r.extractorVersion).filter((v): v is string => v !== null)),
    ),
    includeSensitive: options.includeSensitive,
    facts,
    tombstones,
    versions,
  };
  const profile = { ...body, canonicalPayloadSha256: canonicalSha256(body) } as PortableProfile;
  const bytes = canonicalize(profile);
  if (utf8Length(bytes) > LIMITS.maxPortableBytes) problems.push("The profile file would exceed 1 MiB; it is not split silently. Erase or hide facts, or export without sensitive facts.");
  else {
    // Never offer a file our own validator would reject (alias/tombstone key caps, list bounds, future drift).
    const check = validatePortable(bytes);
    if (!check.ok) problems.push(...check.errors.slice(0, 10).map((e) => `The file would fail validation: ${e}`));
  }
  return { profile, bytes, notices, problems };
}

// ---------------------------------------------------------------------------
// Strict validation (fail closed)
// ---------------------------------------------------------------------------

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

type JsonRecord = Record<string, unknown>;

function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(obj: JsonRecord, required: string[], optional: string[], path: string, errors: string[]): void {
  for (const key of required) if (!(key in obj)) errors.push(`${path}.${key} is required`);
  for (const key of Object.keys(obj)) if (!required.includes(key) && !optional.includes(key)) errors.push(`${path}.${key} is not allowed`);
}

function str(v: unknown, path: string, errors: string[], maxCodePoints: number, pattern?: RegExp): v is string {
  if (typeof v !== "string") {
    errors.push(`${path} must be a string`);
    return false;
  }
  if (hasUnpairedSurrogate(v)) errors.push(`${path} has an unpaired surrogate`);
  if (codePointLength(v) > maxCodePoints) errors.push(`${path} is too long`);
  if (pattern && !pattern.test(v)) errors.push(`${path} has an invalid format`);
  return true;
}

function timeOrNull(v: unknown, path: string, errors: string[]): void {
  if (v === null) return;
  str(v, path, errors, 20, TIME);
}

function validateEvidence(e: unknown, path: string, errors: string[]): void {
  if (!isRecord(e)) {
    errors.push(`${path} must be an object`);
    return;
  }
  exactKeys(e, ["sourceDigest", "conversationId", "messageId", "role", "textSha256", "start", "end", "quote", "quoteSha256", "parserVersion", "sourceTime"], [], path, errors);
  str(e.conversationId, `${path}.conversationId`, errors, 256);
  str(e.messageId, `${path}.messageId`, errors, 256);
  str(e.quoteSha256, `${path}.quoteSha256`, errors, 64, HEX64);
  timeOrNull(e.sourceTime, `${path}.sourceTime`, errors);
  if (errors.length === 0) {
    for (const problem of evidenceShapeErrors(e as unknown as Evidence)) errors.push(`${path}: ${problem}`);
  }
}

export type ValidationResult = { ok: true; profile: PortableProfile } | { ok: false; errors: string[] };

/** Never throws: any unexpected failure on hostile input becomes a validation error (fail closed). */
export function validatePortable(text: string): ValidationResult {
  try {
    return validatePortableUnsafe(text);
  } catch (error) {
    return { ok: false, errors: [`The file could not be validated: ${error instanceof Error ? error.message : "unknown error"}.`] };
  }
}

function validatePortableUnsafe(text: string): ValidationResult {
  if (utf8Length(text) > LIMITS.maxPortableBytes) {
    return { ok: false, errors: [`Profile files are limited to ${LIMITS.maxPortableBytes / 1024 / 1024} MiB; this file is larger. Bundles are never split silently.`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["Not valid JSON."] };
  }
  const errors: string[] = [];
  if (!isRecord(data)) return { ok: false, errors: ["Top level must be an object."] };
  exactKeys(
    data,
    ["format", "schemaVersion", "codecVersion", "originProfileId", "parserVersions", "extractorVersions", "includeSensitive", "facts", "tombstones", "versions", "canonicalPayloadSha256"],
    [],
    "$",
    errors,
  );
  if (data.format !== PROFILE_FORMAT) errors.push("Unknown format.");
  if (data.schemaVersion !== PROFILE_SCHEMA_VERSION) errors.push(`Unsupported schemaVersion ${String(data.schemaVersion)}.`);
  if (data.codecVersion !== CODEC_VERSION) errors.push(`Unsupported codecVersion ${String(data.codecVersion)}.`);
  if (errors.length > 0) return { ok: false, errors };
  str(data.originProfileId, "$.originProfileId", errors, 128, ID);
  if (typeof data.includeSensitive !== "boolean") errors.push("$.includeSensitive must be boolean");
  for (const key of ["parserVersions", "extractorVersions"] as const) {
    const list = data[key];
    if (!Array.isArray(list) || list.length > 20) errors.push(`$.${key} must be a short array`);
    else list.forEach((v, i) => str(v, `$.${key}[${i}]`, errors, 64));
  }

  const facts = data.facts;
  if (!Array.isArray(facts)) errors.push("$.facts must be an array");
  else {
    if (facts.length > LIMITS.maxCandidatesPerImport) errors.push(`At most ${LIMITS.maxCandidatesPerImport} facts per profile import.`);
    const ids = new Set<string>();
    facts.forEach((f, i) => {
      const p = `$.facts[${i}]`;
      if (!isRecord(f)) {
        errors.push(`${p} must be an object`);
        return;
      }
      exactKeys(f, ["id", "revision", "slot", "polarity", "value", "assertion", "userAuthored", "sensitivity", "firstSeen", "lastSeen", "aliasKeys", "evidence"], ["scopeNote"], p, errors);
      if (str(f.id, `${p}.id`, errors, 128, ID)) {
        if (ids.has(f.id)) errors.push(`${p}.id duplicates another fact`);
        ids.add(f.id);
      }
      if (!Number.isSafeInteger(f.revision) || (f.revision as number) < 1) errors.push(`${p}.revision must be a positive integer`);
      if (!isSlot(f.slot)) errors.push(`${p}.slot is not supported`);
      if (f.polarity !== "assert" && f.polarity !== "deny") errors.push(`${p}.polarity is not supported`);
      if (str(f.value, `${p}.value`, errors, LIMITS.maxQuoteCodePoints) && f.value.trim().length === 0) errors.push(`${p}.value is empty`);
      if (str(f.assertion, `${p}.assertion`, errors, LIMITS.maxQuoteCodePoints + 40) && f.assertion.trim().length === 0) errors.push(`${p}.assertion is empty`);
      if (typeof f.userAuthored !== "boolean") errors.push(`${p}.userAuthored must be boolean`);
      if (f.scopeNote !== undefined) str(f.scopeNote, `${p}.scopeNote`, errors, 200);
      timeOrNull(f.firstSeen, `${p}.firstSeen`, errors);
      timeOrNull(f.lastSeen, `${p}.lastSeen`, errors);
      if (!Array.isArray(f.sensitivity) || f.sensitivity.some((s) => !(SENSITIVITY_CATEGORIES as readonly unknown[]).includes(s))) errors.push(`${p}.sensitivity is invalid`);
      if (!Array.isArray(f.aliasKeys) || f.aliasKeys.length === 0 || f.aliasKeys.length > 50 || f.aliasKeys.some((k) => typeof k !== "string" || !HEX64.test(k))) {
        errors.push(`${p}.aliasKeys is invalid`);
      } else if (isSlot(f.slot) && (f.polarity === "assert" || f.polarity === "deny") && typeof f.value === "string" && !hasUnpairedSurrogate(f.value) && !f.aliasKeys.includes(identityKey(f.slot, f.value, f.polarity))) {
        errors.push(`${p}.aliasKeys does not include the fact's own identity`);
      }
      if (!Array.isArray(f.evidence) || f.evidence.length === 0 || f.evidence.length > MAX_EVIDENCE_PER_FACT) errors.push(`${p}.evidence must hold 1-${MAX_EVIDENCE_PER_FACT} quotes`);
      else {
        const keys = new Set<string>();
        f.evidence.forEach((e, j) => {
          const before = errors.length;
          validateEvidence(e, `${p}.evidence[${j}]`, errors);
          if (errors.length === before) {
            const k = evidenceKey(e as Evidence);
            if (keys.has(k)) errors.push(`${p}.evidence[${j}] duplicates another quote`);
            keys.add(k);
          }
        });
      }
    });
  }

  const tombstones = data.tombstones;
  if (!Array.isArray(tombstones) || tombstones.length > MAX_TOMBSTONES) errors.push("$.tombstones must be an array");
  else {
    const ids = new Set<string>();
    tombstones.forEach((t, i) => {
      const p = `$.tombstones[${i}]`;
      if (!isRecord(t)) {
        errors.push(`${p} must be an object`);
        return;
      }
      exactKeys(t, ["id", "generationId", "keys", "mode", "at"], [], p, errors);
      if (str(t.id, `${p}.id`, errors, 128, ID)) {
        if (ids.has(t.id)) errors.push(`${p}.id duplicates another tombstone`);
        ids.add(t.id);
      }
      str(t.generationId, `${p}.generationId`, errors, 128, ID);
      if (t.mode !== "erase" && t.mode !== "hide") errors.push(`${p}.mode is invalid`);
      str(t.at, `${p}.at`, errors, 20, TIME);
      if (!Array.isArray(t.keys) || t.keys.length === 0 || t.keys.length > 50 || t.keys.some((k) => typeof k !== "string" || !HEX64.test(k))) errors.push(`${p}.keys is invalid`);
    });
  }

  const versions = data.versions;
  if (!Array.isArray(versions) || versions.length > 1000) errors.push("$.versions must be an array");
  else {
    const seqs = new Set<number>();
    versions.forEach((v, i) => {
      if (isRecord(v) && Number.isSafeInteger(v.seq)) {
        if (seqs.has(v.seq as number)) errors.push(`$.versions[${i}].seq duplicates another version`);
        seqs.add(v.seq as number);
      }
      const p = `$.versions[${i}]`;
      if (!isRecord(v)) {
        errors.push(`${p} must be an object`);
        return;
      }
      exactKeys(v, ["seq", "label", "digest", "createdAt"], [], p, errors);
      if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1) errors.push(`${p}.seq is invalid`);
      str(v.label, `${p}.label`, errors, 80);
      str(v.digest, `${p}.digest`, errors, 64, HEX64);
      str(v.createdAt, `${p}.createdAt`, errors, 20, TIME);
    });
  }

  // Referential integrity: a fact cannot also be tombstoned in the same file.
  if (Array.isArray(facts) && Array.isArray(tombstones)) {
    const factIds = new Set(facts.filter(isRecord).map((f) => f.id));
    tombstones.forEach((t, i) => {
      if (isRecord(t) && factIds.has(t.generationId)) errors.push(`$.tombstones[${i}] targets a fact that is also exported`);
    });
  }
  if (typeof data.canonicalPayloadSha256 !== "string" || !HEX64.test(data.canonicalPayloadSha256)) errors.push("$.canonicalPayloadSha256 is invalid");
  if (errors.length > 0) return { ok: false, errors };
  const { canonicalPayloadSha256, ...body } = data;
  let digest: string;
  try {
    digest = canonicalSha256(body);
  } catch (error) {
    return { ok: false, errors: [`Payload is not canonicalizable: ${(error as Error).message}`] };
  }
  if (digest !== canonicalPayloadSha256) return { ok: false, errors: ["Checksum mismatch: the file is inconsistent or was modified. (A checksum is not proof of authenticity.)"] };
  return { ok: true, profile: data as unknown as PortableProfile };
}

// ---------------------------------------------------------------------------
// ImportPlan: preview against a profile revision, then explicit apply
// ---------------------------------------------------------------------------

export interface ProfileImportCounts {
  facts: number;
  created: number;
  sameAttached: number;
  unchanged: number;
  suppressed: number;
  proposals: number;
  staleForeign: number;
  tombstonesAdded: number;
  localMatchesHidden: number;
  restorationsClosed: number;
  openGroups: number;
}

export interface ProfileImportPreview {
  baseRevision: number;
  fingerprint: string;
  importId: string | null;
  next: ProfileState;
  noop: boolean;
  counts: ProfileImportCounts;
  /** Local facts the imported tombstones will hide (shown before apply). */
  tombstoneEffects: Array<{ generationId: string; tombstoneId: string }>;
  integrityErrors: string[];
}

function mapLocalId(state: ProfileState, originProfileId: string, foreignId: string): string | null {
  if (originProfileId === state.profileId) return state.generations[foreignId] ? foreignId : null;
  const g = Object.values(state.generations).find((x) => x.origin?.profileId === originProfileId && x.origin.generationId === foreignId);
  return g ? g.id : null;
}

function addLinks(draft: ProfileState, generationId: string, evidence: Evidence[], importId: string, ctx: Ctx, record: ImportRecord): number {
  let added = 0;
  for (const e of evidence) {
    const key = evidenceKey(e);
    if (Object.values(draft.links).some((l) => l.generationId === generationId && l.evidenceKey === key)) continue;
    const link: EvidenceLink = { linkId: ctx.newId(), generationId, evidenceKey: key, evidence: e, importId, addedAt: ctx.now };
    draft.links[link.linkId] = link;
    record.addedLinks.push(link.linkId);
    added += 1;
    // Sensitivity applies to every included quote; raising it voids earlier confirmation.
    const g = draft.generations[generationId];
    const merged = mergeSensitivity(g.sensitivity, classifyText(e.quote));
    if (merged.length > g.sensitivity.length) draft.generations[generationId] = { ...g, sensitivity: merged, sensitivityConfirmedRevision: null };
  }
  return added;
}

function earliest(times: Array<string | null>): string | null {
  const known = times.filter((t): t is string => t !== null).sort();
  return known[0] ?? null;
}

function latestOf(times: Array<string | null>): string | null {
  const known = times.filter((t): t is string => t !== null).sort();
  return known.at(-1) ?? null;
}

function newGeneration(draft: ProfileState, fact: PortableFact, origin: Generation["origin"], ctx: Ctx): Generation {
  const revision: Revision = {
    revision: 1,
    slot: fact.slot,
    value: fact.value,
    polarity: fact.polarity,
    changeCue: "none",
    assertion: renderAssertion(fact.slot, fact.value, fact.polarity),
    userAuthored: fact.userAuthored,
    ruleId: null,
    extractorVersion: null,
    createdAt: ctx.now,
  };
  const quotes = fact.evidence.map((e) => e.quote);
  const g: Generation = {
    id: ctx.newId(),
    origin,
    revisions: [revision],
    currentRevision: 1,
    review: "pending", // imported content alone never earns approval
    approvedRevision: null,
    lifecycle: "live",
    superseded: null,
    sensitivity: mergeSensitivity(fact.sensitivity, classifyCandidate(fact.slot, [revision.assertion as string, fact.value, ...quotes])),
    sensitivityConfirmedRevision: null,
    aliasKeys: [identityKey(fact.slot, fact.value, fact.polarity)],
    firstSeen: earliest([fact.firstSeen, ...fact.evidence.map((e) => e.sourceTime)]),
    lastSeen: latestOf([fact.lastSeen, ...fact.evidence.map((e) => e.sourceTime)]),
    scopeNote: null,
    createdAt: ctx.now,
    restoredFrom: null,
  };
  draft.generations[g.id] = g;
  return g;
}

export function previewProfileImport(state: ProfileState, profile: PortableProfile, ctx: Ctx): ProfileImportPreview {
  const counts: ProfileImportCounts = { facts: profile.facts.length, created: 0, sameAttached: 0, unchanged: 0, suppressed: 0, proposals: 0, staleForeign: 0, tombstonesAdded: 0, localMatchesHidden: 0, restorationsClosed: 0, openGroups: 0 };
  const fingerprint = profile.canonicalPayloadSha256;
  const importId = ctx.newId();
  const record: ImportRecord = { id: importId, kind: "profile", fingerprint, parserVersion: null, counts: {}, appliedAt: ctx.now, undone: false, createdGenerations: [], addedLinks: [] };
  const integrityErrors: string[] = [];
  const tombstoneEffects: ProfileImportPreview["tombstoneEffects"] = [];
  let draft = cloneState(state);
  const foreign = profile.originProfileId !== state.profileId;

  // 1. Tombstones first (union), with explicit effect on local matches.
  const knownTombstones = new Set(draft.tombstones.map((t) => `${t.generationId}|${[...t.keys].sort().join(",")}|${t.mode}`));
  for (const t of profile.tombstones) {
    const mapped = mapLocalId(draft, profile.originProfileId, t.generationId) ?? t.generationId;
    const signature = `${mapped}|${[...t.keys].sort().join(",")}|${t.mode}`;
    if (knownTombstones.has(signature)) continue;
    knownTombstones.add(signature);
    const localId = ctx.newId();
    draft.tombstones.push({ id: localId, generationId: mapped, keys: [...t.keys].sort(), mode: t.mode, at: t.at });
    for (const key of t.keys) draft.suppression[key] = [...(draft.suppression[key] ?? []), localId];
    counts.tombstonesAdded += 1;
    for (const g of Object.values(draft.generations)) {
      if (g.lifecycle !== "live" || !g.aliasKeys.some((k) => t.keys.includes(k))) continue;
      const relation = draft.restorations.find((r) => r.open && r.generationId === g.id);
      // A tombstone for the OLD restored-from UUID does not close a local restoration; one for the restored UUID does.
      if (relation && mapped !== g.id) continue;
      if (relation) {
        relation.open = false;
        counts.restorationsClosed += 1;
      }
      draft.generations[g.id] = { ...g, lifecycle: "hidden", approvedRevision: null, review: g.review === "approved" ? "pending" : g.review };
      // Suppress every identity the hidden fact has had (edit aliases), like a local hide would.
      const ownTombstone = ctx.newId();
      draft.tombstones.push({ id: ownTombstone, generationId: g.id, keys: [...g.aliasKeys].sort(), mode: "hide", at: ctx.now });
      for (const key of g.aliasKeys) draft.suppression[key] = [...(draft.suppression[key] ?? []), ownTombstone];
      tombstoneEffects.push({ generationId: g.id, tombstoneId: localId });
      counts.localMatchesHidden += 1;
    }
  }

  // 2. Facts: owner IDs in files never select an account; remap portable identity.
  for (const fact of profile.facts) {
    const key = identityKey(fact.slot, fact.value, fact.polarity);
    const mappedId = mapLocalId(draft, profile.originProfileId, fact.id);
    const mapped = mappedId ? draft.generations[mappedId] : undefined;
    if (mapped && mapped.lifecycle === "live") {
      // Equal id + revision with different content is an integrity error (own files: local revision;
      // foreign files: the origin revision recorded when the fact was first imported).
      const sameRev = foreign
        ? mapped.origin?.revision === fact.revision ? mapped.revisions[0] : undefined
        : mapped.revisions.find((r) => r.revision === fact.revision);
      if (sameRev && sameRev.value !== null && (sameRev.slot !== fact.slot || sameRev.polarity !== fact.polarity || sameRev.value !== fact.value)) {
        integrityErrors.push(`Fact ${fact.id} revision ${fact.revision} differs from the local copy with the same id and revision.`);
        continue;
      }
      const current = currentRevision(mapped);
      const identical = current.value !== null && identityKey(current.slot, current.value, current.polarity) === key;
      if (identical || mapped.aliasKeys.includes(key)) {
        const added = addLinks(draft, mapped.id, fact.evidence, importId, ctx, record);
        if (added > 0) counts.sameAttached += 1;
        else counts.unchanged += 1;
        continue;
      }
      const newer = foreign ? fact.revision > (mapped.origin?.revision ?? 0) : fact.revision > mapped.currentRevision;
      if (newer) {
        // Higher revision: a pending proposal, never an overwrite of accepted local edits.
        const restored = openRestoration(draft, key);
        if (isSuppressed(draft, key) && !restored) {
          counts.suppressed += 1;
          continue;
        }
        // SAME rule: an existing live fact (e.g. an earlier proposal) with this identity just gains evidence.
        const existing = restored ? draft.generations[restored.generationId] : Object.values(draft.generations).find((x) => x.lifecycle === "live" && x.aliasKeys.includes(key));
        if (existing) {
          const added = addLinks(draft, existing.id, fact.evidence, importId, ctx, record);
          if (added > 0) counts.sameAttached += 1;
          else counts.unchanged += 1;
          continue;
        }
        const g = newGeneration(draft, fact, null, ctx);
        addLinks(draft, g.id, fact.evidence, importId, ctx, record);
        record.createdGenerations.push(g.id);
        counts.proposals += 1;
        continue;
      }
      counts.staleForeign += 1;
      continue;
    }
    const restoration = openRestoration(draft, key);
    if (!restoration && isSuppressed(draft, key)) {
      counts.suppressed += 1;
      continue;
    }
    const same = restoration
      ? draft.generations[restoration.generationId]
      : Object.values(draft.generations).find((g) => g.lifecycle === "live" && g.aliasKeys.includes(key));
    if (same) {
      // SAME: keep local wording and any locally granted approval; attach evidence only.
      const added = addLinks(draft, same.id, fact.evidence, importId, ctx, record);
      if (added > 0) counts.sameAttached += 1;
      else counts.unchanged += 1;
      continue;
    }
    const g = newGeneration(draft, fact, foreign ? { profileId: profile.originProfileId, generationId: fact.id, revision: fact.revision } : null, ctx);
    addLinks(draft, g.id, fact.evidence, importId, ctx, record);
    record.createdGenerations.push(g.id);
    counts.created += 1;
  }

  const changed = counts.created + counts.sameAttached + counts.proposals + counts.tombstonesAdded > 0;
  if (integrityErrors.length > 0 || !changed || state.appliedFingerprints.includes(fingerprint)) {
    return { baseRevision: state.revision, fingerprint, importId: null, counts, next: state, noop: integrityErrors.length === 0, tombstoneEffects, integrityErrors };
  }
  draft = recomputeGroups(draft, ctx);
  counts.openGroups = Object.values(draft.groups).filter((g) => g.state === "open").length;
  record.counts = { ...counts };
  draft.imports = [...draft.imports, record];
  draft.appliedFingerprints = [...draft.appliedFingerprints, fingerprint];
  draft = appendEvent({ ...draft, revision: draft.revision + 1 }, "profile_import_applied", [importId], ctx.now, {
    created: counts.created,
    attached: counts.sameAttached,
    tombstones: counts.tombstonesAdded,
    hidden: counts.localMatchesHidden,
  });
  return { baseRevision: state.revision, fingerprint, importId, counts, next: draft, noop: false, tombstoneEffects, integrityErrors };
}

/** Apply a profile ImportPlan only when it is integrity-clean and still based on the current revision. */
export function commitProfilePreview(state: ProfileState, preview: ProfileImportPreview): { ok: true; state: ProfileState } | { ok: false; code: string; message: string } {
  if (preview.integrityErrors.length > 0) return { ok: false, code: "integrity", message: preview.integrityErrors.join(" ") };
  if (preview.noop) return { ok: true, state };
  if (state.revision !== preview.baseRevision) {
    return { ok: false, code: "stale_preview", message: `The profile changed (revision ${state.revision}, preview built at ${preview.baseRevision}). Build a new preview.` };
  }
  return { ok: true, state: preview.next };
}
