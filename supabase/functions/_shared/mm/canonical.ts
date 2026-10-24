import { hasUnpairedSurrogate } from "./unicode.ts";
import { sha256Hex } from "./sha256.ts";

/**
 * Canonical v1 JSON codec (PLAN §7). UTF-8 without BOM; object keys sorted
 * lexicographically by UTF-16 code unit (field names are ASCII, so this equals
 * byte order); no whitespace; Unicode preserved without normalization; unpaired
 * surrogates rejected; strings escaped exactly as ECMAScript JSON.stringify does
 * (\" \\ \b \f \n \r \t, other C0 controls as lowercase \u00xx; DEL, U+2028 and
 * U+2029 are emitted raw). Safe integers only; no floats, no negative zero.
 * Undefined object fields are omitted; undefined in arrays is rejected.
 * Golden vectors in tests pin this behaviour. This is NOT a JCS/.mem claim.
 */
export const CODEC_VERSION = 1;

export class CanonicalError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
    this.name = "CanonicalError";
  }
}

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export function canonicalize(value: unknown, path = "$"): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalError(path, "only safe integers are allowed");
      if (Object.is(value, -0)) throw new CanonicalError(path, "negative zero is not allowed");
      return String(value);
    case "string":
      if (hasUnpairedSurrogate(value)) throw new CanonicalError(path, "unpaired surrogate");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const parts = value.map((item, index) => {
          if (item === undefined) throw new CanonicalError(`${path}[${index}]`, "undefined array item");
          return canonicalize(item, `${path}[${index}]`);
        });
        return `[${parts.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const parts = keys.map((key) => {
        if (hasUnpairedSurrogate(key)) throw new CanonicalError(path, "unpaired surrogate in key");
        return `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`)}`;
      });
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalError(path, `unsupported type ${typeof value}`);
  }
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** UTC timestamp at second precision with Z, or null for unknown/invalid input. */
export function canonicalTime(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}
