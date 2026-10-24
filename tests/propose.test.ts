import { describe, expect, it } from "vitest";
import { gateLlm, mapProviderPayload } from "../supabase/functions/_shared/propose.ts";
import type { ParsedMessage } from "../supabase/functions/_shared/types.ts";

const message: ParsedMessage = {
  conversationId: "c1",
  conversationTitle: "t",
  messageId: "m1",
  role: "user",
  text: "My name is Ada Quinn.",
  createdAt: "2024-01-01T00:00:00.000Z",
  ordinal: 0,
};

describe("propose gate", () => {
  it("refuses LLM mode when the key is missing and does not ask for a URL yet", () => {
    const result = gateLlm({}, [message]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.secret).toBe("MEMORY_EXTRACT_API_KEY");
      expect(result.message).toContain("No facts were invented");
    }
  });

  it("refuses LLM mode when the URL is missing", () => {
    const result = gateLlm({ memoryExtractApiKey: "present" }, [message]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.secret).toBe("MEMORY_EXTRACT_URL");
  });

  it("drops provider facts whose quotes are not in the cited message", () => {
    const mapped = mapProviderPayload(
      {
        facts: [
          { slot: "name", value: "Ada Quinn", messageId: "m1", quote: "My name is Ada Quinn." },
          { slot: "residence", value: "Paris", messageId: "m1", quote: "I live in Paris." },
        ],
      },
      [message],
      "2026-10-23T18:00:00.000Z",
    );
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.dropped).toBe(1);
      expect(mapped.facts).toHaveLength(1);
      expect(mapped.facts[0]?.provenance.messageId).toBe("m1");
      expect(mapped.facts[0]?.provenance.quote).toBe("My name is Ada Quinn.");
    }
  });

  it("rejects a payload that is not the contract", () => {
    const mapped = mapProviderPayload({ summary: "Ada likes libraries" }, [message], "2026-10-23T18:00:00.000Z");
    expect(mapped.ok).toBe(false);
    if (!mapped.ok) expect(mapped.error).toBe("provider_contract");
  });
});
