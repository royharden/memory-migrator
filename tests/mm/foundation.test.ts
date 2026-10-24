import { describe, expect, it } from "vitest";
import { canonicalize, canonicalTime } from "../../supabase/functions/_shared/mm/canonical.ts";
import { checkEvidence, evidenceKey, evidenceShapeErrors, makeEvidence, messageLookupKey } from "../../supabase/functions/_shared/mm/evidence.ts";
import { checkFileBounds, LIMITS } from "../../supabase/functions/_shared/mm/limits.ts";
import { sha256Hex } from "../../supabase/functions/_shared/mm/sha256.ts";
import type { CanonicalMessage } from "../../supabase/functions/_shared/mm/source.ts";
import {
  canonicalText,
  codePointLength,
  codePointSlice,
  hasUnpairedSurrogate,
  normalizeExact,
  utf16ToCodePoint,
} from "../../supabase/functions/_shared/mm/unicode.ts";

describe("sha256", () => {
  // what_bug_this_catches: a hand-written SHA-256 with a padding/length bug.
  it("matches FIPS 180-4 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("unicode", () => {
  // what_bug_this_catches: persisting UTF-16 indices instead of code points (emoji shift offsets).
  it("counts and slices by code point", () => {
    const text = "😀 I live in Zürich";
    expect(codePointLength(text)).toBe(18);
    expect(text.length).toBe(19);
    expect(codePointSlice(text, 2, 6)).toBe("I li");
    expect(utf16ToCodePoint(text, 3)).toBe(2);
    expect(codePointSlice(text, 0, 99)).toBeNull();
  });

  it("keeps combining marks as separate code points without normalizing", () => {
    const decomposed = "Zürich";
    expect(codePointLength(decomposed)).toBe(7);
    expect(codePointSlice(decomposed, 1, 3)).toBe("ü");
  });

  it("canonicalizes CRLF and lone CR to LF only", () => {
    expect(canonicalText("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("detects unpaired surrogates", () => {
    expect(hasUnpairedSurrogate("ok 😀")).toBe(false);
    expect(hasUnpairedSurrogate("bad \ud800")).toBe(true);
    expect(hasUnpairedSurrogate("bad \udc00 x")).toBe(true);
  });

  it("exact normalization is NFC + lowercase + collapsed whitespace, no accent folding", () => {
    expect(normalizeExact("  Zürich   City ")).toBe("zürich city");
    expect(normalizeExact("Zurich")).not.toBe(normalizeExact("Zürich"));
  });
});

describe("canonical codec v1 golden vectors", () => {
  // what_bug_this_catches: key order, whitespace or escape drift between client and server bytes.
  it("sorts keys, omits undefined, has no whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("pins string escapes", () => {
    expect(canonicalize("q\"b\\\b\f\n\r\t\u0001\u001f\u007f é😀")).toBe(
      '"q\\"b\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u007f é😀"',
    );
  });

  it("rejects floats, unsafe integers, negative zero, unpaired surrogates and undefined array items", () => {
    expect(() => canonicalize(1.5)).toThrow();
    expect(() => canonicalize(2 ** 53)).toThrow();
    expect(() => canonicalize(-0)).toThrow();
    expect(() => canonicalize("\ud800")).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
  });

  it("normalizes timestamps to UTC seconds with Z", () => {
    expect(canonicalTime("2026-10-23T12:34:56.789+02:00")).toBe("2026-10-23T10:34:56Z");
    expect(canonicalTime("not a date")).toBeNull();
    expect(canonicalTime(null)).toBeNull();
  });
});

describe("bounds", () => {
  it("checks count and bytes before reading", () => {
    expect(checkFileBounds([])?.code).toBe("empty_selection");
    expect(checkFileBounds(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.json`, size: 1 })))?.code).toBe("too_many_files");
    expect(checkFileBounds([{ name: "big.json", size: LIMITS.maxFileBytes + 1 }])?.code).toBe("file_too_large");
    expect(checkFileBounds([{ name: "ok.json", size: 10 }])).toBeNull();
  });
});

describe("evidence", () => {
  const text = "Hi 😀. My name is Ada Quinn.";
  const digest = sha256Hex("digest");
  const message: CanonicalMessage = {
    sourceDigest: digest,
    conversationId: "c1",
    messageId: "m1",
    nodeId: "m1",
    role: "user",
    text,
    textSha256: sha256Hex(text),
    sourceTime: null,
    ordinal: 0,
  };

  it("builds code-point evidence whose slice and hashes verify against the live source", () => {
    const from = text.indexOf("My name");
    const result = makeEvidence(message, digest, from, text.length - 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.start).toBe(from - 1); // emoji is two UTF-16 units, one code point
    expect(result.evidence.quote).toBe("My name is Ada Quinn");
    expect(evidenceShapeErrors(result.evidence)).toEqual([]);
    const source = new Map([[messageLookupKey("c1", "m1"), message]]);
    expect(checkEvidence(result.evidence, source)).toBe("verified");
    expect(checkEvidence(result.evidence, null)).toBe("source_not_attached");
    // what_bug_this_catches: evidence from one export version "verified" against a different tree version.
    const otherVersion = new Map([[messageLookupKey("c1", "m1"), { ...message, sourceDigest: sha256Hex("other") }]]);
    expect(checkEvidence(result.evidence, otherVersion)).toBe("source_not_attached");
    expect(evidenceKey(result.evidence)).toMatch(/^ev_[0-9a-f]{40}$/);
  });

  // what_bug_this_catches: forged quote text that still carries plausible offsets.
  it("flags a forged quote", () => {
    const result = makeEvidence(message, digest, 0, 2);
    if (!result.ok) throw new Error("unexpected");
    const forged = { ...result.evidence, quote: "Yo" };
    expect(evidenceShapeErrors(forged)).toContain("quote hash mismatch");
    expect(checkEvidence(forged, null)).toBe("invalid");
  });

  it("abstains instead of clipping a quote over 280 code points", () => {
    const long = "a".repeat(300);
    const m = { ...message, text: long, textSha256: sha256Hex(long) };
    expect(makeEvidence(m, digest, 0, 300)).toEqual({ ok: false, reason: "quote_too_long" });
  });
});
