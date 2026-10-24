import { canonicalize } from "./canonical.ts";
import type { Evidence } from "./evidence.ts";
import { sha256Hex } from "./sha256.ts";
import { normalizeExact } from "./unicode.ts";

/** Profile domain model shared by the local reducer, ImportPlan, exports and the account adapter. */

export const EXTRACTOR_VERSION = "rules/1";

export const SINGLE_SLOTS = ["identity.name", "location.home", "work.role", "work.employer"] as const;
export const MULTI_SLOTS = ["preference.likes", "preference.dislikes", "health.note", "financial.note"] as const;
export const SLOTS = [...SINGLE_SLOTS, ...MULTI_SLOTS] as const;
export type Slot = (typeof SLOTS)[number];

export function isSingleSlot(slot: Slot): boolean {
  return (SINGLE_SLOTS as readonly string[]).includes(slot);
}

export function isSlot(value: unknown): value is Slot {
  return typeof value === "string" && (SLOTS as readonly string[]).includes(value);
}

export type Polarity = "assert" | "deny";
export type ChangeCue = "none" | "move" | "retraction" | "correction";

export const SENSITIVITY_CATEGORIES = ["health", "finance", "intimate", "belief", "minors", "precise_location"] as const;
export type SensitivityCategory = (typeof SENSITIVITY_CATEGORIES)[number];

/** Extractor output: pending atomic candidate with exact evidence. Never written directly. */
export interface Candidate {
  slot: Slot;
  value: string;
  polarity: Polarity;
  changeCue: ChangeCue;
  assertion: string;
  evidence: Evidence;
  ruleId: string;
  extractorVersion: string;
  sensitivity: SensitivityCategory[];
}

/** Immutable assertion revision. value/assertion become null only through erase purge. */
export interface Revision {
  revision: number;
  slot: Slot;
  value: string | null;
  polarity: Polarity;
  changeCue: ChangeCue;
  assertion: string | null;
  userAuthored: boolean;
  ruleId: string | null;
  extractorVersion: string | null;
  createdAt: string;
}

export type ReviewStatus = "pending" | "approved" | "rejected";
export type Lifecycle = "live" | "hidden" | "erased";
export type SupersedeReason = "changed_circumstance" | "corrected_error";

export interface Superseded {
  reason: SupersedeReason;
  groupId: string;
  effectiveDate: string | null;
}

export interface Generation {
  id: string;
  /** Identity from another profile this generation was imported from (portable mapping), else null. */
  origin: { profileId: string; generationId: string; revision?: number } | null;
  revisions: Revision[];
  currentRevision: number;
  review: ReviewStatus;
  approvedRevision: number | null;
  lifecycle: Lifecycle;
  superseded: Superseded | null;
  sensitivity: SensitivityCategory[];
  sensitivityConfirmedRevision: number | null;
  /** Suppression/identity keys for every identity this generation has had (original + edits). */
  aliasKeys: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  scopeNote: string | null;
  createdAt: string;
  /** Old generation whose suppression this generation was explicitly restored from. */
  restoredFrom: string | null;
}

/** Evidence link: quote payload stored per generation link so erase can purge it. */
export interface EvidenceLink {
  linkId: string;
  generationId: string;
  evidenceKey: string;
  /** null after an erase purge. */
  evidence: Evidence | null;
  importId: string | null;
  addedAt: string;
}

export type GroupKind = "move" | "retraction" | "correction" | "changed" | "order_unknown";

export interface GroupMember {
  generationId: string;
  revision: number;
  identityKey: string;
}

export interface GroupResolution {
  decision: "keep_one" | "keep_several" | "reject_all" | "dissolved";
  kept: string[];
  displaced: Record<string, SupersedeReason>;
  scopeNote: string | null;
  effectiveDate: string | null;
  resolvedAt: string;
}

export interface ConflictGroup {
  id: string;
  groupKey: string;
  slot: Slot;
  kind: GroupKind;
  state: "open" | "resolved";
  members: GroupMember[];
  resolution: GroupResolution | null;
}

export type TombstoneMode = "erase" | "hide";

export interface Tombstone {
  id: string;
  generationId: string;
  keys: string[];
  mode: TombstoneMode;
  at: string;
}

export interface RestorationRelation {
  key: string;
  generationId: string;
  restoredFrom: string;
  at: string;
  open: boolean;
}

export interface ImportRecord {
  id: string;
  kind: "source" | "profile";
  fingerprint: string;
  parserVersion: string | null;
  counts: Record<string, number>;
  appliedAt: string;
  undone: boolean;
  /** Generations first created by this import. */
  createdGenerations: string[];
  /** Evidence links added by this import. */
  addedLinks: string[];
}

export interface ProfileEvent {
  seq: number;
  type: string;
  ids: string[];
  at: string;
  counts?: Record<string, number>;
}

export interface VersionItem {
  generationId: string;
  revision: number;
}

export interface VersionRecord {
  seq: number;
  label: string;
  createdAt: string;
  digest: string;
  includeSensitive: boolean;
  profileRevision: number;
  items: VersionItem[];
}

export interface ProfileState {
  profileId: string;
  revision: number;
  generations: Record<string, Generation>;
  links: Record<string, EvidenceLink>;
  groups: Record<string, ConflictGroup>;
  tombstones: Tombstone[];
  /** suppression key -> tombstone ids. Monotonic: keys are never removed. */
  suppression: Record<string, string[]>;
  restorations: RestorationRelation[];
  imports: ImportRecord[];
  appliedFingerprints: string[];
  events: ProfileEvent[];
  versions: VersionRecord[];
  nextEventSeq: number;
  nextVersionSeq: number;
}

export interface Ctx {
  now: string;
  newId: () => string;
}

export function emptyProfile(profileId: string): ProfileState {
  return {
    profileId,
    revision: 0,
    generations: {},
    links: {},
    groups: {},
    tombstones: [],
    suppression: {},
    restorations: [],
    imports: [],
    appliedFingerprints: [],
    events: [],
    versions: [],
    nextEventSeq: 1,
    nextVersionSeq: 1,
  };
}

/**
 * Identity / suppression key: SHA-256 of canonical (subject=user, slot,
 * exact-normalized value, semantic polarity). The profile namespace is NOT hashed in,
 * so keys are portable. Low-entropy values are guessable: pseudonymous, not anonymous.
 */
export function identityKey(slot: Slot, value: string, polarity: Polarity): string {
  return sha256Hex(canonicalize({ subject: "user", slot, value: normalizeExact(value), polarity }));
}

export function currentRevision(g: Generation): Revision {
  const rev = g.revisions.find((r) => r.revision === g.currentRevision);
  if (!rev) throw new Error(`Generation ${g.id} has no current revision ${g.currentRevision}`);
  return rev;
}

export function currentIdentityKey(g: Generation): string | null {
  const rev = currentRevision(g);
  return rev.value === null ? null : identityKey(rev.slot, rev.value, rev.polarity);
}

const ASSERT_TEMPLATES: Record<Slot, (v: string) => string> = {
  "identity.name": (v) => `Name is ${v}`,
  "location.home": (v) => `Lives in ${v}`,
  "work.role": (v) => `Works as ${v}`,
  "work.employer": (v) => `Works at ${v}`,
  "preference.likes": (v) => `Likes ${v}`,
  "preference.dislikes": (v) => `Dislikes ${v}`,
  "health.note": (v) => `Health note: ${v}`,
  "financial.note": (v) => `Financial note: ${v}`,
};

const DENY_TEMPLATES: Record<Slot, (v: string) => string> = {
  "identity.name": (v) => `Name is not ${v}`,
  "location.home": (v) => `Does not live in ${v}`,
  "work.role": (v) => `Does not work as ${v}`,
  "work.employer": (v) => `Does not work at ${v}`,
  "preference.likes": (v) => `Does not like ${v}`,
  "preference.dislikes": (v) => `Does not dislike ${v}`,
  "health.note": (v) => `Health note (denied): ${v}`,
  "financial.note": (v) => `Financial note (denied): ${v}`,
};

export function renderAssertion(slot: Slot, value: string, polarity: Polarity): string {
  return (polarity === "assert" ? ASSERT_TEMPLATES : DENY_TEMPLATES)[slot](value);
}

export function appendEvent(state: ProfileState, type: string, ids: string[], at: string, counts?: Record<string, number>): ProfileState {
  const event: ProfileEvent = { seq: state.nextEventSeq, type, ids, at, ...(counts ? { counts } : {}) };
  return { ...state, events: [...state.events, event], nextEventSeq: state.nextEventSeq + 1 };
}

export function linksFor(state: ProfileState, generationId: string): EvidenceLink[] {
  return Object.values(state.links).filter((link) => link.generationId === generationId);
}

export function isSuppressed(state: ProfileState, key: string): boolean {
  return (state.suppression[key]?.length ?? 0) > 0;
}

export function openRestoration(state: ProfileState, key: string): RestorationRelation | undefined {
  return state.restorations.find((r) => r.open && r.key === key && state.generations[r.generationId]?.lifecycle === "live");
}

export function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}
