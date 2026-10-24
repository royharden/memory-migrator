import { useMemo, useState } from "react";
import { checkEvidence, type EvidenceCheck } from "../../supabase/functions/_shared/mm/evidence.ts";
import { isCurrentClaim, openGroupMembers } from "../../supabase/functions/_shared/mm/groups.ts";
import { deletionDependencies } from "../../supabase/functions/_shared/mm/lifecycle.ts";
import {
  currentRevision,
  identityKey,
  linksFor,
  SENSITIVITY_CATEGORIES,
  type ConflictGroup,
  type Generation,
  type ProfileState,
  type SensitivityCategory,
  type SupersedeReason,
  type TombstoneMode,
} from "../../supabase/functions/_shared/mm/model.ts";
import type { CanonicalMessage } from "../../supabase/functions/_shared/mm/source.ts";
import { codePointSlice, codePointToUtf16 } from "../../supabase/functions/_shared/mm/unicode.ts";
import type { ExtractResponse } from "../import/protocol.ts";
import type { ProfileAction } from "../state/actions.ts";

type ReviewTab = "pending" | "conflicts" | "sensitive" | "approved" | "suppressed" | "other";

interface Props {
  profile: ProfileState;
  sourceMap: Map<string, CanonicalMessage> | null;
  extraction: ExtractResponse | null;
  run: (action: ProfileAction) => Promise<boolean>;
  busy: boolean;
}

const KIND_HELP: Record<ConflictGroup["kind"], string> = {
  move: "A message mentions moving. That is a cue only; you decide.",
  retraction: "One statement asserts something another denies or retracts.",
  correction: "A message looks like a correction (for example “actually” or “X, not Y”).",
  changed: "Different values with different known dates. Dates do not decide which is current.",
  order_unknown: "Different values whose order is unknown or equal. Upload order never decides.",
};

const CHECK_LABEL: Record<EvidenceCheck, string> = {
  verified: "exact match with the attached source",
  source_not_attached: "original source not attached",
  mismatch: "does not match the attached source",
  invalid: "invalid citation",
};

export function ReviewPanel({ profile, sourceMap, extraction, run, busy }: Props) {
  const [tab, setTab] = useState<ReviewTab>("pending");
  const openMembers = useMemo(() => openGroupMembers(profile), [profile]);
  const generations = Object.values(profile.generations);
  const lists: Record<ReviewTab, Generation[]> = {
    pending: generations.filter((g) => isCurrentClaim(g) && g.review === "pending" && !openMembers.has(g.id) && g.sensitivity.length === 0),
    conflicts: [],
    sensitive: generations.filter((g) => g.lifecycle === "live" && g.sensitivity.length > 0 && g.review !== "rejected"),
    approved: generations.filter((g) => g.lifecycle === "live" && g.review === "approved" && !g.superseded),
    suppressed: generations.filter((g) => g.lifecycle !== "live"),
    other: generations.filter((g) => g.lifecycle === "live" && (g.review === "rejected" || g.superseded !== null)),
  };
  const openGroups = Object.values(profile.groups).filter((g) => g.state === "open");
  const counts: Record<ReviewTab, number> = { ...Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])), conflicts: openGroups.length } as Record<ReviewTab, number>;

  const ordinaryPending = lists.pending.map((g) => g.id);

  return (
    <section className="panel stack">
      <nav className="tabs small" aria-label="Review queues">
        {(["pending", "conflicts", "sensitive", "approved", "suppressed", "other"] as ReviewTab[]).map((t) => (
          <button key={t} type="button" className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)}>
            {t === "other" ? "Rejected / superseded" : t[0].toUpperCase() + t.slice(1)} ({counts[t]})
          </button>
        ))}
      </nav>
      {tab === "pending" && ordinaryPending.length > 0 ? (
        <div className="row-actions">
          <button type="button" onClick={() => void run({ kind: "approveSelected", ids: ordinaryPending })} disabled={busy}>
            Approve all {ordinaryPending.length} ordinary pending facts
          </button>
          <span className="muted">Sensitive facts and facts in open conflicts are never bulk-approved.</span>
        </div>
      ) : null}
      {tab === "sensitive" ? (
        <p className="muted">Sensitivity rules miss cases. Review every fact you plan to export, and mark anything sensitive by hand. Sensitive facts appear in an export only after you confirm them and choose to include sensitive facts for that export.</p>
      ) : null}
      {tab === "suppressed" ? (
        <p className="muted">
          {profile.tombstones.length} deletion record(s). Erased facts keep only opaque IDs and hashes so they do not come back on re-import; their text is gone from this profile. Hashes of short values can be guessed, so treat them as pseudonymous, not anonymous.
        </p>
      ) : null}
      {tab === "conflicts"
        ? openGroups.map((group) => <GroupCard key={group.id} group={group} profile={profile} run={run} busy={busy} />)
        : lists[tab].map((g) => <FactCard key={g.id} g={g} profile={profile} sourceMap={sourceMap} extraction={extraction} inOpenGroup={openMembers.has(g.id)} run={run} busy={busy} />)}
      {(tab === "conflicts" ? openGroups.length : lists[tab].length) === 0 ? <p className="muted">Nothing here.</p> : null}
    </section>
  );
}

function supportCount(profile: ProfileState, id: string): number {
  return new Set(linksFor(profile, id).filter((l) => l.evidence).map((l) => l.evidence?.conversationId)).size;
}

function FactCard({ g, profile, sourceMap, extraction, inOpenGroup, run, busy }: {
  g: Generation;
  profile: ProfileState;
  sourceMap: Map<string, CanonicalMessage> | null;
  extraction: ExtractResponse | null;
  inOpenGroup: boolean;
  run: (action: ProfileAction) => Promise<boolean>;
  busy: boolean;
}) {
  const rev = currentRevision(g);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rev.value ?? "");
  const [showEvidence, setShowEvidence] = useState(false);
  const [deleting, setDeleting] = useState<TombstoneMode | null>(null);
  const [raise, setRaise] = useState<SensitivityCategory | "">("");
  const live = g.lifecycle === "live";
  const links = linksFor(profile, g.id);

  const reselectable = useMemo(() => {
    if (g.lifecycle !== "erased" || !extraction) return null;
    return extraction.candidates.find((c) => g.aliasKeys.includes(identityKey(c.slot, c.value, c.polarity))) ?? null;
  }, [g, extraction]);

  return (
    <article className={`fact ${g.sensitivity.length > 0 ? "sensitive" : ""}`}>
      <header className="fact-head">
        <strong>{rev.assertion ?? "[erased]"}</strong>
        <span className="badges">
          <span className="badge">{rev.slot}</span>
          {rev.polarity === "deny" ? <span className="badge">denial</span> : null}
          {rev.changeCue !== "none" ? <span className="badge">cue: {rev.changeCue}</span> : null}
          {rev.userAuthored ? <span className="badge">your wording</span> : <span className="badge">from your messages</span>}
          {g.sensitivity.map((s) => <span key={s} className="badge warn">{s}</span>)}
          {g.sensitivity.length > 0 && g.sensitivityConfirmedRevision === g.currentRevision ? <span className="badge">sensitive confirmed</span> : null}
          <span className="badge">{g.review}</span>
          {g.lifecycle !== "live" ? <span className="badge warn">{g.lifecycle}</span> : null}
          {g.superseded ? <span className="badge">superseded: {g.superseded.reason.replace("_", " ")}{g.superseded.effectiveDate ? ` (${g.superseded.effectiveDate})` : ""}</span> : null}
          {g.restoredFrom ? <span className="badge">restored</span> : null}
        </span>
      </header>
      <p className="muted">
        Seen in {supportCount(profile, g.id)} conversation(s){g.firstSeen ? `, first ${g.firstSeen.slice(0, 10)}` : ""}{g.lastSeen && g.lastSeen !== g.firstSeen ? `, last ${g.lastSeen.slice(0, 10)}` : ""}. Revision {g.currentRevision}.
        {g.scopeNote ? ` Scope: ${g.scopeNote}.` : ""}
        {g.review === "rejected" && live ? " Rejected facts are excluded but not erased." : ""}
        {inOpenGroup ? " Part of an open conflict — resolve it in Conflicts." : ""}
      </p>

      {live ? (
        <div className="row-actions">
          {g.review !== "approved" || g.approvedRevision !== g.currentRevision ? (
            <button type="button" className="primary" disabled={busy || inOpenGroup || g.superseded !== null} onClick={() => void run({ kind: "approve", id: g.id })}>Approve</button>
          ) : null}
          {g.review !== "rejected" ? <button type="button" disabled={busy || inOpenGroup} onClick={() => void run({ kind: "reject", id: g.id })}>Reject</button> : null}
          <button type="button" disabled={busy} onClick={() => { setDraft(rev.value ?? ""); setEditing(!editing); }}>Edit</button>
          {g.sensitivity.length > 0 && g.sensitivityConfirmedRevision !== g.currentRevision ? (
            <button type="button" disabled={busy} onClick={() => void run({ kind: "confirmSensitive", id: g.id })}>Confirm sensitive fact for export</button>
          ) : null}
          {g.sensitivity.length > 0 ? <button type="button" disabled={busy} onClick={() => void run({ kind: "markNotSensitive", id: g.id })}>Mark not sensitive</button> : null}
          <select aria-label="Mark sensitive" value={raise} onChange={(e) => setRaise(e.target.value as SensitivityCategory | "")}>
            <option value="">Mark sensitive…</option>
            {SENSITIVITY_CATEGORIES.filter((c) => !g.sensitivity.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {raise ? <button type="button" disabled={busy} onClick={() => { void run({ kind: "markSensitive", id: g.id, category: raise }); setRaise(""); }}>Apply</button> : null}
          <button type="button" className="danger" disabled={busy} onClick={() => setDeleting("erase")}>Erase…</button>
          <button type="button" disabled={busy} onClick={() => setDeleting("hide")}>Hide…</button>
        </div>
      ) : (
        <div className="row-actions">
          {g.lifecycle === "hidden" ? <button type="button" disabled={busy} onClick={() => setDeleting("erase")} className="danger">Erase…</button> : null}
          {!profile.restorations.some((r) => r.open && r.restoredFrom === g.id) ? (
            g.lifecycle === "hidden" ? (
              <button type="button" disabled={busy} onClick={() => void run({ kind: "restore", oldId: g.id, reselected: null })}>Restore as a new pending fact</button>
            ) : reselectable ? (
              <button type="button" disabled={busy} onClick={() => void run({ kind: "restore", oldId: g.id, reselected: reselectable })}>Restore from the reselected source text</button>
            ) : (
              <span className="muted">To restore an erased fact, load and extract the source that contains it again; a restore button appears when matching text is found.</span>
            )
          ) : <span className="muted">Restored as a new fact.</span>}
        </div>
      )}

      {editing ? (
        <form className="row-actions" onSubmit={(e) => { e.preventDefault(); void run({ kind: "edit", id: g.id, value: draft, expectedRevision: g.currentRevision }).then((ok) => ok && setEditing(false)); }}>
          <input aria-label="New wording" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={280} />
          <button type="submit" className="primary" disabled={busy}>Save wording</button>
          <span className="muted">Edits become your own wording; approval and sensitive confirmation reset.</span>
        </form>
      ) : null}

      {deleting ? <DeleteDialog g={g} mode={deleting} profile={profile} onCancel={() => setDeleting(null)} run={run} busy={busy} /> : null}

      {links.length > 0 ? (
        <button type="button" className="link" onClick={() => setShowEvidence(!showEvidence)} aria-expanded={showEvidence}>
          {showEvidence ? "Hide" : "Show"} evidence ({links.length})
        </button>
      ) : null}
      {showEvidence ? (
        <ul className="evidence">
          {links.map((link) => {
            if (!link.evidence) return <li key={link.linkId} className="muted">[quote erased]</li>;
            const e = link.evidence;
            const status = checkEvidence(e, sourceMap);
            const message = sourceMap?.get(`${e.conversationId}\u0000${e.messageId}`);
            return (
              <li key={link.linkId}>
                <span className="muted">conversation {e.conversationId} · message {e.messageId}{e.sourceTime ? ` · ${e.sourceTime}` : ""} · {CHECK_LABEL[status]}</span>
                {message && status === "verified" ? <HighlightedMessage text={message.text} start={e.start} end={e.end} /> : <blockquote>{e.quote}</blockquote>}
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

/** Highlights the quote inside the (locally attached) message; React escapes all text. */
function HighlightedMessage({ text, start, end }: { text: string; start: number; end: number }) {
  const from = codePointToUtf16(text, start);
  const to = codePointToUtf16(text, end);
  const quote = codePointSlice(text, start, end);
  if (from < 0 || to < 0 || quote === null) return <blockquote>{text}</blockquote>;
  const before = text.slice(Math.max(0, from - 160), from);
  const after = text.slice(to, to + 160);
  return (
    <blockquote>
      {from > 160 ? "…" : ""}{before}<mark>{quote}</mark>{after}{to + 160 < text.length ? "…" : ""}
    </blockquote>
  );
}

function DeleteDialog({ g, mode, profile, onCancel, run, busy }: { g: Generation; mode: TombstoneMode; profile: ProfileState; onCancel: () => void; run: (a: ProfileAction) => Promise<boolean>; busy: boolean }) {
  const deps = deletionDependencies(profile, g.id);
  const [choice, setChoice] = useState<"cascade" | "retain">("retain");
  return (
    <div className="dialog" role="group" aria-label={mode === "erase" ? "Erase fact" : "Hide fact"}>
      {mode === "erase" ? (
        <p>Erase removes this fact's wording (every revision) and its quotes from this profile, redacts it in version history and blocks it from coming back on re-import. It is not a secure wipe of your device, your source files or copies you already downloaded.</p>
      ) : (
        <p>Hide keeps the text here in the app but excludes it from every export and version, and blocks it on re-import. You can restore it later.</p>
      )}
      {deps.length > 0 ? (
        <fieldset>
          <legend>{deps.length} other fact(s) quote overlapping text from the same message:</legend>
          <ul>{deps.map((d) => <li key={d.generationId}>{d.assertion ?? "[erased]"}</li>)}</ul>
          <label><input type="radio" name={`dep-${g.id}`} checked={choice === "retain"} onChange={() => setChoice("retain")} /> Keep them (their quotes may still contain overlapping words; the receipt will list them)</label>
          <label><input type="radio" name={`dep-${g.id}`} checked={choice === "cascade"} onChange={() => setChoice("cascade")} /> Also {mode} them</label>
        </fieldset>
      ) : null}
      <div className="row-actions">
        <button type="button" className="danger" disabled={busy} onClick={() => void run({ kind: "delete", id: g.id, mode, dependencyChoice: choice }).then((ok) => ok && onCancel())}>
          {mode === "erase" ? "Erase" : "Hide"}
        </button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function GroupCard({ group, profile, run, busy }: { group: ConflictGroup; profile: ProfileState; run: (a: ProfileAction) => Promise<boolean>; busy: boolean }) {
  const members = group.members.map((m) => profile.generations[m.generationId]).filter((g): g is Generation => Boolean(g));
  const [decision, setDecision] = useState<"keep_one" | "keep_several" | "reject_all">("keep_one");
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, SupersedeReason>>({});
  const [scopeNote, setScopeNote] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");

  function submit() {
    if (decision === "reject_all") {
      void run({ kind: "resolveGroup", groupId: group.id, decision: { decision: "reject_all" } });
      return;
    }
    const displaced: Record<string, SupersedeReason> = {};
    for (const m of members) if (!keep.has(m.id)) displaced[m.id] = reasons[m.id];
    if (decision === "keep_one") {
      const [only] = [...keep];
      void run({ kind: "resolveGroup", groupId: group.id, decision: { decision: "keep_one", keep: only, displaced, effectiveDate: effectiveDate || null } });
    } else {
      void run({ kind: "resolveGroup", groupId: group.id, decision: { decision: "keep_several", keep: [...keep], scopeNote, displaced, effectiveDate: effectiveDate || null } });
    }
  }

  const keepValid = decision === "keep_one" ? keep.size === 1 : decision === "keep_several" ? keep.size >= 2 && scopeNote.trim().length > 0 : true;
  const reasonsValid = decision === "reject_all" || members.every((m) => keep.has(m.id) || reasons[m.id]);

  return (
    <article className="fact group">
      <header className="fact-head">
        <strong>Conflict: {group.slot}</strong>
        <span className="badge">{group.kind.replace("_", " ")}</span>
      </header>
      <p className="muted">{KIND_HELP[group.kind]} Nothing is decided automatically; resolve the whole group.</p>
      <div className="row-actions">
        <label><input type="radio" name={`d-${group.id}`} checked={decision === "keep_one"} onChange={() => { setDecision("keep_one"); setKeep(new Set()); }} /> Keep one</label>
        <label><input type="radio" name={`d-${group.id}`} checked={decision === "keep_several"} onChange={() => setDecision("keep_several")} /> Keep several (with a scope note)</label>
        <label><input type="radio" name={`d-${group.id}`} checked={decision === "reject_all"} onChange={() => setDecision("reject_all")} /> Reject all</label>
      </div>
      <ul className="members">
        {members.map((m) => {
          const r = currentRevision(m);
          const kept = keep.has(m.id);
          return (
            <li key={m.id}>
              {decision !== "reject_all" ? (
                <label>
                  <input
                    type={decision === "keep_one" ? "radio" : "checkbox"}
                    name={`k-${group.id}`}
                    checked={kept}
                    onChange={(e) => {
                      const next = decision === "keep_one" ? new Set<string>() : new Set(keep);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      setKeep(next);
                    }}
                  />{" "}
                  keep
                </label>
              ) : null}{" "}
              <strong>{r.assertion}</strong> <span className="muted">({r.changeCue !== "none" ? `cue: ${r.changeCue}, ` : ""}{m.lastSeen ? `last seen ${m.lastSeen.slice(0, 10)}` : "date unknown"}, {supportCount(profile, m.id)} conversation(s))</span>
              {decision !== "reject_all" && !kept ? (
                <select aria-label="Why is this no longer current?" value={reasons[m.id] ?? ""} onChange={(e) => setReasons({ ...reasons, [m.id]: e.target.value as SupersedeReason })}>
                  <option value="">Why not current?</option>
                  <option value="changed_circumstance">It changed (was true then)</option>
                  <option value="corrected_error">It was wrong (correction)</option>
                </select>
              ) : null}
            </li>
          );
        })}
      </ul>
      {decision === "keep_several" ? <input aria-label="Scope note" placeholder="Scope note, e.g. weekdays vs weekends" value={scopeNote} onChange={(e) => setScopeNote(e.target.value)} maxLength={200} /> : null}
      {decision !== "reject_all" ? (
        <label>Effective date (optional, only if you know it) <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></label>
      ) : null}
      <button type="button" className="primary" disabled={busy || !keepValid || !reasonsValid} onClick={submit}>Resolve group</button>
    </article>
  );
}
