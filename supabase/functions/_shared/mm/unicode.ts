/**
 * Unicode helpers. SourceRef offsets are Unicode code points, end exclusive (PLAN §4).
 * JavaScript string indices are UTF-16 code units; never persist them.
 */

const encoder = new TextEncoder();

/** Canonical message text: CRLF and lone CR become LF; everything else is preserved. */
export function canonicalText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/** Convert a UTF-16 index into a code-point index. */
export function utf16ToCodePoint(text: string, utf16Index: number): number {
  return codePointLength(text.slice(0, utf16Index));
}

/** Convert a code-point index into a UTF-16 index; returns -1 when out of range. */
export function codePointToUtf16(text: string, codePointIndex: number): number {
  if (codePointIndex < 0) return -1;
  let cp = 0;
  let i = 0;
  while (i < text.length && cp < codePointIndex) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      i += next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    } else {
      i += 1;
    }
    cp += 1;
  }
  return cp === codePointIndex ? i : -1;
}

/** Slice by code points, end exclusive. Returns null when the range is invalid. */
export function codePointSlice(text: string, start: number, end: number): string | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null;
  const from = codePointToUtf16(text, start);
  const to = codePointToUtf16(text, end);
  if (from < 0 || to < 0) return null;
  return text.slice(from, to);
}

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

export function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * Exact-match / suppression normalization: NFC, locale-independent lowercase,
 * trim and collapsed whitespace. Original wording is kept elsewhere. No NFKC and
 * no accent folding: those only ever produce duplicate suggestions.
 */
export function normalizeExact(value: string): string {
  return value.normalize("NFC").toLowerCase().trim().replace(/\s+/gu, " ");
}

/** Accent-insensitive key used ONLY to suggest possible duplicates for review. */
export function looseSuggestionKey(value: string): string {
  return normalizeExact(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}
