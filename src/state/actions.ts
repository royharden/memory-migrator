import { canonicalTime } from "../../supabase/functions/_shared/mm/canonical.ts";
import { deleteGeneration, restoreGeneration, undoImport, type DeletionReceipt, type UndoReceipt } from "../../supabase/functions/_shared/mm/lifecycle.ts";
import type { Candidate, Ctx, ProfileState, SensitivityCategory, TombstoneMode } from "../../supabase/functions/_shared/mm/model.ts";
import { commitProfilePreview, type PortableProfile, type ProfileImportPreview } from "../../supabase/functions/_shared/mm/portable.ts";
import {
  approve,
  approveSelected,
  commitPreview,
  confirmSensitive,
  edit,
  markNotSensitive,
  markSensitive,
  reject,
  resolveGroup,
  unreject,
  type GroupDecision,
  type ImportPreview,
} from "../../supabase/functions/_shared/mm/reducer.ts";
import { publishVersion } from "../../supabase/functions/_shared/mm/versions.ts";

/**
 * Every state change the UI can request. Local mode applies it with the pure reducer;
 * account mode sends the same action to the matching RPC (src/lib/account.ts).
 */
export type ProfileAction =
  | { kind: "commitCandidateImport"; preview: ImportPreview; candidates: Candidate[]; parserVersion: string }
  | { kind: "commitProfileImport"; preview: ProfileImportPreview; profile: PortableProfile }
  | { kind: "approve"; id: string }
  | { kind: "approveSelected"; ids: string[] }
  | { kind: "reject"; id: string }
  | { kind: "unreject"; id: string }
  | { kind: "edit"; id: string; value: string; expectedRevision: number }
  | { kind: "confirmSensitive"; id: string }
  | { kind: "markNotSensitive"; id: string }
  | { kind: "markSensitive"; id: string; category: SensitivityCategory }
  | { kind: "resolveGroup"; groupId: string; decision: GroupDecision }
  | { kind: "delete"; id: string; mode: TombstoneMode; dependencyChoice: "cascade" | "retain" }
  | { kind: "restore"; oldId: string; reselected: Candidate | null }
  | { kind: "undoImport"; importId: string }
  | { kind: "publish"; label: string; includeSensitive: boolean };

export type ActionReceipt = { type: "delete"; receipt: DeletionReceipt } | { type: "undo"; receipt: UndoReceipt } | { type: "bulk"; approved: number; skipped: number };

export type ActionOutcome = { ok: true; state: ProfileState; receipt?: ActionReceipt } | { ok: false; message: string };

export function makeCtx(): Ctx {
  return { now: canonicalTime(new Date()) as string, newId: () => crypto.randomUUID() };
}

export function applyLocal(state: ProfileState, action: ProfileAction, ctx: Ctx = makeCtx()): ActionOutcome {
  const wrap = (r: { ok: true; state: ProfileState } | { ok: false; message: string }): ActionOutcome => (r.ok ? { ok: true, state: r.state } : { ok: false, message: r.message });
  switch (action.kind) {
    case "commitCandidateImport":
      return wrap(commitPreview(state, action.preview));
    case "commitProfileImport":
      return wrap(commitProfilePreview(state, action.preview));
    case "approve":
      return wrap(approve(state, action.id, ctx));
    case "approveSelected": {
      const r = approveSelected(state, action.ids, ctx);
      return { ok: true, state: r.state, receipt: { type: "bulk", approved: r.approved.length, skipped: r.skipped.length } };
    }
    case "reject":
      return wrap(reject(state, action.id, ctx));
    case "unreject":
      return wrap(unreject(state, action.id, ctx));
    case "edit":
      return wrap(edit(state, action.id, action.value, action.expectedRevision, ctx));
    case "confirmSensitive":
      return wrap(confirmSensitive(state, action.id, ctx));
    case "markNotSensitive":
      return wrap(markNotSensitive(state, action.id, ctx));
    case "markSensitive":
      return wrap(markSensitive(state, action.id, action.category, ctx));
    case "resolveGroup":
      return wrap(resolveGroup(state, action.groupId, action.decision, ctx));
    case "delete": {
      const r = deleteGeneration(state, action.id, action.mode, action.dependencyChoice, ctx);
      return r.ok ? { ok: true, state: r.state, receipt: { type: "delete", receipt: r.receipt } } : { ok: false, message: r.message };
    }
    case "restore":
      return wrap(restoreGeneration(state, action.oldId, action.reselected, ctx));
    case "undoImport": {
      const r = undoImport(state, action.importId, ctx);
      return r.ok ? { ok: true, state: r.state, receipt: { type: "undo", receipt: r.receipt } } : { ok: false, message: r.message };
    }
    case "publish":
      return wrap(publishVersion(state, { label: action.label, includeSensitive: action.includeSensitive }, ctx));
  }
}
