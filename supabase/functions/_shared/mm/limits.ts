/**
 * MVP input and mutation bounds (PLAN §4). These are configuration, not measured
 * capacity claims: large-file performance is unverified.
 */
export const LIMITS = {
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxNodesPerShard: 50_000,
  maxJsonDepth: 64,
  maxRetainedMessages: 2_000,
  maxMessageCodePoints: 20_000,
  maxRetainedTextBytes: 5 * 1024 * 1024,
  maxQuoteCodePoints: 280,
  maxPortableBytes: 1024 * 1024,
  maxMutationBytes: 1024 * 1024,
  maxCandidatesPerImport: 500,
  maxBranchLeavesListed: 20,
  defaultPromptBudget: 2_000,
} as const;

export const LIMIT_HINT =
  "Select fewer conversations or shards, or split the export externally. Large-file performance is unverified.";

export interface FileMeta {
  name: string;
  size: number;
}

export interface BoundsError {
  code: "too_many_files" | "file_too_large" | "total_too_large" | "empty_selection";
  message: string;
}

/** Count/byte checks that must run before any file is read. */
export function checkFileBounds(files: FileMeta[]): BoundsError | null {
  if (files.length === 0) return { code: "empty_selection", message: "Choose at least one JSON file." };
  if (files.length > LIMITS.maxFiles) {
    return {
      code: "too_many_files",
      message: `At most ${LIMITS.maxFiles} JSON files can be loaded together; ${files.length} were chosen. ${LIMIT_HINT}`,
    };
  }
  let total = 0;
  for (const file of files) {
    if (file.size > LIMITS.maxFileBytes) {
      return {
        code: "file_too_large",
        message: `${file.name} is ${formatMiB(file.size)}; the per-file limit is ${formatMiB(LIMITS.maxFileBytes)}. ${LIMIT_HINT}`,
      };
    }
    total += file.size;
  }
  if (total > LIMITS.maxTotalBytes) {
    return {
      code: "total_too_large",
      message: `Selected files total ${formatMiB(total)}; the limit is ${formatMiB(LIMITS.maxTotalBytes)}. ${LIMIT_HINT}`,
    };
  }
  return null;
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
