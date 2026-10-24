import { canonicalSha256, CODEC_VERSION } from "./canonical.ts";
import { exportProjection } from "./exporting.ts";
import { appendEvent, type Ctx, type ProfileState, type VersionRecord } from "./model.ts";
import type { Result } from "./reducer.ts";

/**
 * Named versions (PLAN §7): immutable metadata + ordered (generation, revision) refs;
 * no duplicate snapshot text. The digest covers immutable revision content, so an
 * unredacted version can be re-verified from revisions; after erase/hide the original
 * digest no longer verifies and the redacted rendering gets its own digest.
 * Local publication uses the same projection/codec the account RPC must reproduce.
 */

export interface VersionRow {
  id: string;
  revision: number;
  slot: string;
  polarity: string;
  value: string;
  assertion: string;
  userAuthored: boolean;
}

export function versionDigest(includeSensitive: boolean, rows: VersionRow[]): string {
  return canonicalSha256({ format: "memory-migrator.version", codecVersion: CODEC_VERSION, includeSensitive, items: rows });
}

export function publishVersion(state: ProfileState, input: { label?: string; includeSensitive: boolean }, ctx: Ctx): Result {
  const items = exportProjection(state, { includeSensitive: input.includeSensitive });
  if (items.length === 0) return { ok: false, code: "empty", message: "No approved facts are eligible to publish." };
  const rows: VersionRow[] = items.map(({ generation, revision }) => ({
    id: generation.id,
    revision: revision.revision,
    slot: revision.slot,
    polarity: revision.polarity,
    value: revision.value as string,
    assertion: revision.assertion as string,
    userAuthored: revision.userAuthored,
  }));
  const seq = state.nextVersionSeq;
  const label = input.label?.trim() ? input.label.trim().slice(0, 80) : `v${seq}`;
  const version: VersionRecord = {
    seq,
    label,
    createdAt: ctx.now,
    digest: versionDigest(input.includeSensitive, rows),
    includeSensitive: input.includeSensitive,
    profileRevision: state.revision,
    items: rows.map((r) => ({ generationId: r.id, revision: r.revision })),
  };
  const next = appendEvent(
    { ...state, versions: [...state.versions, version], nextVersionSeq: seq + 1, revision: state.revision + 1 },
    "publish_version",
    [String(seq)],
    ctx.now,
    { items: rows.length },
  );
  return { ok: true, state: next, changed: true };
}

export type RowStatus = "ok" | "hidden" | "erased";

export interface RenderedRow {
  generationId: string;
  revision: number;
  status: RowStatus;
  text: string;
  userAuthored: boolean;
}

export interface RenderedVersion {
  version: VersionRecord;
  rows: RenderedRow[];
  redacted: boolean;
  /** true only when every row is present and recomputes to the stored digest. */
  originalDigestVerifies: boolean;
  /** Digest of this (possibly redacted) rendering. */
  renderingDigest: string;
}

/** Hidden content is masked by default; revealHidden is an explicit private, in-app view. */
export function renderVersion(state: ProfileState, seq: number, revealHidden = false): RenderedVersion | null {
  const version = state.versions.find((v) => v.seq === seq);
  if (!version) return null;
  const rows: RenderedRow[] = [];
  const digestRows: VersionRow[] = [];
  for (const item of version.items) {
    const g = state.generations[item.generationId];
    const rev = g?.revisions.find((r) => r.revision === item.revision);
    if (!g || !rev || rev.value === null || rev.assertion === null || g.lifecycle === "erased") {
      rows.push({ generationId: item.generationId, revision: item.revision, status: "erased", text: "[erased]", userAuthored: false });
      continue;
    }
    if (g.lifecycle === "hidden") {
      rows.push({ generationId: item.generationId, revision: item.revision, status: "hidden", text: revealHidden ? `${rev.assertion} (hidden — private view)` : "[hidden]", userAuthored: rev.userAuthored });
      continue;
    }
    rows.push({ generationId: item.generationId, revision: item.revision, status: "ok", text: rev.assertion, userAuthored: rev.userAuthored });
    digestRows.push({ id: g.id, revision: rev.revision, slot: rev.slot, polarity: rev.polarity, value: rev.value, assertion: rev.assertion, userAuthored: rev.userAuthored });
  }
  const redacted = rows.some((r) => r.status !== "ok");
  const originalDigestVerifies = !redacted && versionDigest(version.includeSensitive, digestRows) === version.digest;
  const renderingDigest = canonicalSha256({
    format: "memory-migrator.version-rendering",
    codecVersion: CODEC_VERSION,
    seq: version.seq,
    rows: rows.map((r) => ({ id: r.generationId, revision: r.revision, status: r.status, text: r.status === "hidden" ? "[hidden]" : r.text })),
  });
  return { version, rows, redacted, originalDigestVerifies, renderingDigest };
}

export interface VersionDiff {
  added: RenderedRow[];
  removed: RenderedRow[];
  changed: Array<{ before: RenderedRow; after: RenderedRow }>;
  unchanged: number;
}

export function diffVersions(state: ProfileState, fromSeq: number, toSeq: number): VersionDiff | null {
  const a = renderVersion(state, fromSeq);
  const b = renderVersion(state, toSeq);
  if (!a || !b) return null;
  const before = new Map(a.rows.map((r) => [r.generationId, r]));
  const after = new Map(b.rows.map((r) => [r.generationId, r]));
  const diff: VersionDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [id, row] of after) {
    const prior = before.get(id);
    if (!prior) diff.added.push(row);
    else if (prior.revision !== row.revision) diff.changed.push({ before: prior, after: row });
    else diff.unchanged += 1;
  }
  for (const [id, row] of before) if (!after.has(id)) diff.removed.push(row);
  return diff;
}
