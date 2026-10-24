import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalize } from "../../supabase/functions/_shared/mm/canonical.ts";
import type { Evidence } from "../../supabase/functions/_shared/mm/evidence.ts";
import { exportProjection } from "../../supabase/functions/_shared/mm/exporting.ts";
import { candidateFingerprint } from "../../supabase/functions/_shared/mm/reducer.ts";
import { LIMITS } from "../../supabase/functions/_shared/mm/limits.ts";
import {
  emptyProfile,
  renderAssertion,
  type Candidate,
  type ChangeCue,
  type ConflictGroup,
  type EvidenceLink,
  type Generation,
  type GroupKind,
  type Polarity,
  type ProfileState,
  type Revision,
  type SensitivityCategory,
  type Slot,
} from "../../supabase/functions/_shared/mm/model.ts";
import type { PortableProfile } from "../../supabase/functions/_shared/mm/portable.ts";
import { classifyCandidate } from "../../supabase/functions/_shared/mm/sensitivity.ts";
import { sha256Hex } from "../../supabase/functions/_shared/mm/sha256.ts";
import { utf8Length } from "../../supabase/functions/_shared/mm/unicode.ts";
import { versionDigest, type VersionRow } from "../../supabase/functions/_shared/mm/versions.ts";
import type { ActionOutcome, ProfileAction } from "../state/actions.ts";
import { publicConfig } from "./config.ts";

/**
 * Account adapter (PLAN §3/§8/§9). The Supabase client is created lazily, only after the
 * user picks account mode — local mode never imports or initializes it. Writes go only
 * through RPCs with a {request_id, expected_profile_revision, canonical_payload,
 * payload_sha256} envelope; reads are fully paginated and checked against the profile
 * revision so state is never reconciled from a silently truncated or mixed read.
 * Uploads contain candidates, referenced quote spans, IDs, hashes and decisions only.
 */

let clientPromise: Promise<SupabaseClient | null> | null = null;

export function getAccountClient(): Promise<SupabaseClient | null> {
  if (!clientPromise) {
    const config = publicConfig();
    clientPromise = config
      ? import("@supabase/supabase-js").then(({ createClient }) => createClient(config.url, config.anonKey, { auth: { persistSession: true, autoRefreshToken: true } }))
      : Promise.resolve(null);
  }
  return clientPromise;
}

const PAGE = 1000;

async function readAll<T>(client: SupabaseClient, table: string, column: string, value: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from(table).select("*").eq(column, value).range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return rows;
  }
}

async function readIn<T>(client: SupabaseClient, table: string, column: string, values: string[]): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client.from(table).select("*").in(column, chunk).range(from, from + PAGE - 1);
      if (error) throw new Error(`Could not read ${table}: ${error.message}`);
      rows.push(...((data ?? []) as T[]));
      if (!data || data.length < PAGE) break;
    }
  }
  return rows;
}

interface ProfileRow { id: string; revision: number; next_event_seq: number; next_version_seq: number }
interface FactRow {
  id: string; current_revision: number; review: Generation["review"]; approved_revision: number | null; lifecycle: Generation["lifecycle"];
  superseded_reason: "changed_circumstance" | "corrected_error" | null; superseded_group: string | null; superseded_effective: string | null;
  sensitivity: SensitivityCategory[]; sensitivity_confirmed_revision: number | null; first_seen: string | null; last_seen: string | null;
  scope_note: string | null; restored_from: string | null; origin_profile_id: string | null; origin_generation_id: string | null; origin_revision: number | null; created_at: string;
}
interface RevisionRow { fact_id: string; revision: number; slot: Slot; value: string | null; polarity: Polarity; change_cue: ChangeCue; assertion: string | null; user_authored: boolean; rule_id: string | null; extractor_version: string | null; created_at: string }
interface EvidenceRow { id: string; fact_id: string; evidence_key: string; source_digest: string; conversation_id: string; message_id: string; text_sha256: string; start_cp: number; end_cp: number; quote: string | null; quote_sha256: string; parser_version: string; source_time: string | null; import_id: string | null; added_at: string }
interface AliasRow { fact_id: string; key: string }
interface GroupRow { id: string; group_key_hash: string; slot: Slot; kind: GroupKind; state: "open" | "resolved"; resolution: ConflictGroup["resolution"]; created_seq: number }
interface MemberRow { group_id: string; fact_id: string; revision: number; identity_key: string }
interface TombstoneRow { id: string; generation_id: string; mode: "erase" | "hide"; created_at: string }
interface KeyRow { tombstone_id: string; key: string }
interface RelationRow { key: string; fact_id: string; restored_from: string; open: boolean; created_at: string }
interface ImportRow { id: string; kind: "source" | "profile"; fingerprint: string; parser_version: string | null; counts: Record<string, number>; applied_at: string; undone: boolean }
interface OccurrenceRow { import_id: string; kind: "created_fact" | "added_link"; target_id: string }
interface VersionRowDb { id: string; seq: number; label: string; digest: string; include_sensitive: boolean; profile_revision: number; created_at: string }
interface ItemRow { version_id: string; ord: number; fact_id: string; revision: number }
interface EventRow { seq: number; type: string; ids: string[]; counts: Record<string, number> | null; created_at: string }
interface FingerprintRow { fingerprint: string }

function iso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z") : null;
}

async function loadOnce(client: SupabaseClient): Promise<{ state: ProfileState; revision: number }> {
  const { data: profileRow, error } = await client.from("mm_profiles").select("*").maybeSingle();
  if (error || !profileRow) throw new Error(error?.message ?? "No profile.");
  const p = profileRow as ProfileRow;
  const facts = await readAll<FactRow>(client, "mm_facts", "profile_id", p.id);
  const ids = facts.map((f) => f.id);
  const [revisions, evidence, aliases, groups, tombstones, relations, imports, versions, events, fingerprints] = await Promise.all([
    readIn<RevisionRow>(client, "mm_fact_revisions", "fact_id", ids),
    readIn<EvidenceRow>(client, "mm_fact_evidence", "fact_id", ids),
    readIn<AliasRow>(client, "mm_fact_alias_keys", "fact_id", ids),
    readAll<GroupRow>(client, "mm_conflict_groups", "profile_id", p.id),
    readAll<TombstoneRow>(client, "mm_tombstones", "profile_id", p.id),
    readAll<RelationRow>(client, "mm_restoration_relations", "profile_id", p.id),
    readAll<ImportRow>(client, "mm_imports", "profile_id", p.id),
    readAll<VersionRowDb>(client, "mm_profile_versions", "profile_id", p.id),
    readAll<EventRow>(client, "mm_profile_events", "profile_id", p.id),
    readAll<FingerprintRow>(client, "mm_applied_fingerprints", "profile_id", p.id),
  ]);
  const [members, keys, occurrences, items] = await Promise.all([
    readIn<MemberRow>(client, "mm_conflict_members", "group_id", groups.map((g) => g.id)),
    readIn<KeyRow>(client, "mm_suppression_keys", "tombstone_id", tombstones.map((t) => t.id)),
    readIn<OccurrenceRow>(client, "mm_import_occurrences", "import_id", imports.map((i) => i.id)),
    readIn<ItemRow>(client, "mm_version_items", "version_id", versions.map((v) => v.id)),
  ]);

  const state = emptyProfile(p.id);
  state.revision = p.revision;
  state.nextEventSeq = p.next_event_seq;
  state.nextVersionSeq = p.next_version_seq;
  for (const f of facts) {
    const revs: Revision[] = revisions
      .filter((r) => r.fact_id === f.id)
      .sort((a, b) => a.revision - b.revision)
      .map((r) => ({ revision: r.revision, slot: r.slot, value: r.value, polarity: r.polarity, changeCue: r.change_cue, assertion: r.assertion, userAuthored: r.user_authored, ruleId: r.rule_id, extractorVersion: r.extractor_version, createdAt: iso(r.created_at) ?? "" }));
    state.generations[f.id] = {
      id: f.id,
      origin: f.origin_profile_id && f.origin_generation_id ? { profileId: f.origin_profile_id, generationId: f.origin_generation_id, ...(f.origin_revision ? { revision: f.origin_revision } : {}) } : null,
      revisions: revs,
      currentRevision: f.current_revision,
      review: f.review,
      approvedRevision: f.approved_revision,
      lifecycle: f.lifecycle,
      superseded: f.superseded_reason && f.superseded_group ? { reason: f.superseded_reason, groupId: f.superseded_group, effectiveDate: f.superseded_effective } : null,
      sensitivity: [...f.sensitivity].sort(),
      sensitivityConfirmedRevision: f.sensitivity_confirmed_revision,
      aliasKeys: aliases.filter((a) => a.fact_id === f.id).map((a) => a.key).sort(),
      firstSeen: iso(f.first_seen),
      lastSeen: iso(f.last_seen),
      scopeNote: f.scope_note,
      createdAt: iso(f.created_at) ?? "",
      restoredFrom: f.restored_from,
    };
  }
  for (const e of evidence) {
    const link: EvidenceLink = {
      linkId: e.id,
      generationId: e.fact_id,
      evidenceKey: e.evidence_key,
      evidence: e.quote === null ? null : ({ sourceDigest: e.source_digest, conversationId: e.conversation_id, messageId: e.message_id, role: "user", textSha256: e.text_sha256, start: e.start_cp, end: e.end_cp, quote: e.quote, quoteSha256: e.quote_sha256, parserVersion: e.parser_version, sourceTime: iso(e.source_time) } satisfies Evidence),
      importId: e.import_id,
      addedAt: iso(e.added_at) ?? "",
    };
    state.links[link.linkId] = link;
  }
  for (const g of [...groups].sort((a, b) => a.created_seq - b.created_seq)) {
    state.groups[g.id] = {
      id: g.id,
      groupKey: g.group_key_hash,
      slot: g.slot,
      kind: g.kind,
      state: g.state,
      members: members.filter((m) => m.group_id === g.id).map((m) => ({ generationId: m.fact_id, revision: m.revision, identityKey: m.identity_key })),
      resolution: g.resolution,
    };
  }
  for (const t of tombstones) {
    const tKeys = keys.filter((k) => k.tombstone_id === t.id).map((k) => k.key).sort();
    state.tombstones.push({ id: t.id, generationId: t.generation_id, keys: tKeys, mode: t.mode, at: iso(t.created_at) ?? "" });
    for (const key of tKeys) state.suppression[key] = [...(state.suppression[key] ?? []), t.id];
  }
  state.restorations = relations.map((r) => ({ key: r.key, generationId: r.fact_id, restoredFrom: r.restored_from, at: iso(r.created_at) ?? "", open: r.open }));
  state.imports = imports
    .sort((a, b) => (a.applied_at < b.applied_at ? -1 : 1))
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      fingerprint: i.fingerprint,
      parserVersion: i.parser_version,
      counts: i.counts,
      appliedAt: iso(i.applied_at) ?? "",
      undone: i.undone,
      createdGenerations: occurrences.filter((o) => o.import_id === i.id && o.kind === "created_fact").map((o) => o.target_id),
      addedLinks: occurrences.filter((o) => o.import_id === i.id && o.kind === "added_link").map((o) => o.target_id),
    }));
  state.appliedFingerprints = fingerprints.map((f) => f.fingerprint);
  state.events = events.sort((a, b) => a.seq - b.seq).map((e) => ({ seq: e.seq, type: e.type, ids: e.ids, at: iso(e.created_at) ?? "", ...(e.counts ? { counts: e.counts } : {}) }));
  state.versions = versions
    .sort((a, b) => a.seq - b.seq)
    .map((v) => ({
      seq: v.seq,
      label: v.label,
      createdAt: iso(v.created_at) ?? "",
      digest: v.digest,
      includeSensitive: v.include_sensitive,
      profileRevision: v.profile_revision,
      items: items.filter((i) => i.version_id === v.id).sort((a, b) => a.ord - b.ord).map((i) => ({ generationId: i.fact_id, revision: i.revision })),
    }));
  return { state, revision: p.revision };
}

/** Load with a before/after revision check; retry a bounded number of times, then fail visibly. */
export async function loadProfile(client: SupabaseClient): Promise<ProfileState> {
  const { error } = await client.rpc("mm_ensure_profile");
  if (error) throw new Error(`Could not open your profile: ${error.message}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { state, revision } = await loadOnce(client);
    const { data } = await client.from("mm_profiles").select("revision").maybeSingle();
    if (data && (data as { revision: number }).revision === revision) return state;
  }
  throw new Error("The profile kept changing while loading. Try again.");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function itemFromCandidate(c: Candidate) {
  return { slot: c.slot, value: c.value, polarity: c.polarity, changeCue: c.changeCue, userAuthored: false, ruleId: c.ruleId, extractorVersion: c.extractorVersion, sensitivity: c.sensitivity, evidence: [c.evidence] };
}

function payloadFor(state: ProfileState, action: ProfileAction): { rpc: string; payload: unknown } | { error: string } {
  switch (action.kind) {
    case "commitCandidateImport":
      return { rpc: "mm_apply_import_plan", payload: { kind: "source", fingerprint: candidateFingerprint(action.candidates), parserVersion: action.parserVersion, tombstones: [], items: action.candidates.map(itemFromCandidate) } };
    case "commitProfileImport": {
      const profile: PortableProfile = action.profile;
      return {
        rpc: "mm_apply_import_plan",
        payload: {
          kind: "profile",
          fingerprint: profile.canonicalPayloadSha256,
          parserVersion: null,
          originProfileId: profile.originProfileId,
          tombstones: profile.tombstones.map((t) => ({ id: t.id, generationId: t.generationId, keys: t.keys, mode: t.mode, at: t.at })),
          items: profile.facts.map((f) => ({
            slot: f.slot,
            value: f.value,
            polarity: f.polarity,
            changeCue: "none",
            userAuthored: f.userAuthored,
            ruleId: null,
            extractorVersion: null,
            // imported sensitivity can only raise the class; rules re-run locally too
            sensitivity: [...new Set([...f.sensitivity, ...classifyCandidate(f.slot, [renderAssertion(f.slot, f.value, f.polarity), f.value, ...f.evidence.map((e) => e.quote)])])],
            evidence: f.evidence,
            origin: { profileId: profile.originProfileId, generationId: f.id, revision: f.revision },
          })),
        },
      };
    }
    case "approve":
      return { rpc: "mm_review", payload: { op: "approve", factId: action.id } };
    case "approveSelected":
      return { error: "Bulk approval runs as individual approvals in account mode." };
    case "reject":
      return { rpc: "mm_review", payload: { op: "reject", factId: action.id } };
    case "unreject":
      return { rpc: "mm_review", payload: { op: "unreject", factId: action.id } };
    case "edit": {
      const g = state.generations[action.id];
      const slot = g?.revisions[0]?.slot;
      const sensitivity = slot ? classifyCandidate(slot, [action.value]) : [];
      return { rpc: "mm_review", payload: { op: "edit", factId: action.id, value: action.value, expectedFactRevision: action.expectedRevision, sensitivity } };
    }
    case "confirmSensitive":
      return { rpc: "mm_review", payload: { op: "confirm_sensitive", factId: action.id } };
    case "markNotSensitive":
      return { rpc: "mm_review", payload: { op: "mark_not_sensitive", factId: action.id } };
    case "markSensitive":
      return { rpc: "mm_review", payload: { op: "mark_sensitive", factId: action.id, category: action.category } };
    case "resolveGroup": {
      const d = action.decision;
      const payload =
        d.decision === "reject_all"
          ? { groupId: action.groupId, decision: "reject_all" }
          : { groupId: action.groupId, decision: d.decision, keep: d.decision === "keep_one" ? [d.keep] : d.keep, displaced: d.displaced, scopeNote: d.decision === "keep_several" ? d.scopeNote : null, effectiveDate: d.effectiveDate ?? null };
      return { rpc: "mm_resolve_group", payload };
    }
    case "delete":
      return { rpc: "mm_delete_fact", payload: { factId: action.id, mode: action.mode, dependencyChoice: action.dependencyChoice } };
    case "restore":
      return { rpc: "mm_restore_fact", payload: { oldId: action.oldId, reselected: action.reselected ? itemFromCandidate(action.reselected) : null } };
    case "undoImport":
      return { rpc: "mm_undo_import", payload: { importId: action.importId } };
    case "publish": {
      const rows: VersionRow[] = exportProjection(state, { includeSensitive: action.includeSensitive }).map(({ generation, revision }) => ({
        id: generation.id,
        revision: revision.revision,
        slot: revision.slot,
        polarity: revision.polarity,
        value: revision.value as string,
        assertion: revision.assertion as string,
        userAuthored: revision.userAuthored,
      }));
      if (rows.length === 0) return { error: "No approved facts are eligible to publish." };
      return { rpc: "mm_publish_version", payload: { label: action.label, includeSensitive: action.includeSensitive, expectedDigest: versionDigest(action.includeSensitive, rows) } };
    }
  }
}

async function callRpc(client: SupabaseClient, state: ProfileState, rpc: string, payload: unknown): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string; conflict?: boolean }> {
  const canonical = canonicalize(payload);
  if (utf8Length(canonical) > LIMITS.maxMutationBytes) return { ok: false, message: "This change is larger than 1 MiB. Narrow the selection or split it into separate imports." };
  const envelope = { request_id: crypto.randomUUID(), expected_profile_revision: state.revision, canonical_payload: canonical, payload_sha256: sha256Hex(canonical) };
  const { data, error } = await client.rpc(rpc, { envelope });
  if (error) return { ok: false, message: error.message };
  const result = data as Record<string, unknown>;
  if (result.ok !== true) return { ok: false, message: String(result.message ?? "The server refused the change."), conflict: result.code === "conflict" };
  return { ok: true, result };
}

/** Same ProfileAction contract as local mode; the server is the authority. */
export async function performAccount(client: SupabaseClient, state: ProfileState, action: ProfileAction): Promise<ActionOutcome> {
  if (action.kind === "approveSelected") {
    let current = state;
    let approved = 0;
    let skipped = 0;
    for (const id of action.ids) {
      const g = current.generations[id];
      if (!g || g.sensitivity.length > 0) {
        skipped += 1;
        continue;
      }
      const r = await callRpc(client, current, "mm_review", { op: "approve", factId: id });
      if (r.ok) {
        approved += 1;
        current = await loadProfile(client);
      } else skipped += 1;
    }
    return { ok: true, state: current, receipt: { type: "bulk", approved, skipped } };
  }
  const built = payloadFor(state, action);
  if ("error" in built) return { ok: false, message: built.error };
  const r = await callRpc(client, state, built.rpc, built.payload);
  if (!r.ok) {
    if (r.conflict) return { ok: false, message: `${r.message} Use “Reload from account” to see the latest state; nothing was retried automatically.` };
    return { ok: false, message: r.message };
  }
  const next = await loadProfile(client);
  if (action.kind === "delete") {
    const res = r.result as { mode: "erase" | "hide"; generationIds: string[]; tombstoneIds: string[]; purgedRevisions: number; purgedQuotes: number; retainedDependencies: string[]; redactedVersions: number[] };
    return {
      ok: true,
      state: next,
      receipt: {
        type: "delete",
        receipt: { mode: res.mode, generationIds: res.generationIds, tombstoneIds: res.tombstoneIds, purgedRevisions: res.purgedRevisions, purgedQuotes: res.purgedQuotes, hiddenQuotes: 0, retainedDependencies: res.retainedDependencies, closedRestorations: 0, recomputedGroups: [], redactedVersions: res.redactedVersions, invalidatedOutputs: true },
      },
    };
  }
  if (action.kind === "undoImport") {
    const res = r.result as { importId: string; removedGenerations: string[]; removedLinks: number; retainedGenerations: Array<{ generationId: string; reason: string }>; retainedLinks: number };
    return { ok: true, state: next, receipt: { type: "undo", receipt: res } };
  }
  if (action.kind === "publish") {
    // Client/server golden-byte parity: recompute the digest from the stored revisions.
    const seq = Number(r.result.seq);
    const version = next.versions.find((v) => v.seq === seq);
    if (version) {
      const rows: VersionRow[] = version.items.flatMap((item) => {
        const rev = next.generations[item.generationId]?.revisions.find((x) => x.revision === item.revision);
        return rev && rev.value !== null && rev.assertion !== null ? [{ id: item.generationId, revision: rev.revision, slot: rev.slot, polarity: rev.polarity, value: rev.value, assertion: rev.assertion, userAuthored: rev.userAuthored }] : [];
      });
      if (versionDigest(version.includeSensitive, rows) !== version.digest) {
        return { ok: false, message: `Version ${version.label} was stored, but the browser and server digests disagree, so its digest is NOT verified. Report this; do not rely on the digest.` };
      }
    }
  }
  return { ok: true, state: next };
}
