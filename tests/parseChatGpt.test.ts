import { describe, expect, it } from "vitest";
import fixture from "../src/fixtures/labelled-set.json";
import { parseChatGptExport, parseChatGptFiles } from "../supabase/functions/_shared/parseChatGpt.ts";

describe("parseChatGptExport", () => {
  it("walks the active branch and skips hidden, system, tool, and off-branch nodes", () => {
    const parsed = parseChatGptExport(fixture.export);
    expect(parsed.messages.map((message) => message.messageId)).toEqual(["m1", "a1", "m2", "a2", "m3"]);
    expect(parsed.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    const blob = parsed.messages.map((message) => message.text).join("\n");
    expect(blob).not.toContain("Atlantis");
    expect(blob).not.toContain("Secretville");
    expect(blob).not.toContain("Tooltown");
    expect(blob).not.toContain("You are ChatGPT.");
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
  });

  it("warns and skips a mapped conversation that has no current_node", () => {
    const parsed = parseChatGptExport([
      {
        id: "bare",
        mapping: {
          root: {
            id: "root",
            parent: null,
            message: {
              id: "u",
              author: { role: "user" },
              content: { parts: ["I live in Nowhere."] },
            },
          },
        },
      },
    ]);
    expect(parsed.messages).toEqual([]);
    expect(parsed.warnings.some((warning) => warning.includes("current_node"))).toBe(true);
  });

  it("reads a linear messages array", () => {
    const parsed = parseChatGptExport({
      id: "lin",
      title: "Linear",
      messages: [
        {
          id: "u1",
          author: { role: "user" },
          content: { parts: ["Hello from a flat list."] },
          create_time: 1700000000,
        },
      ],
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toBe("Hello from a flat list.");
    expect(parsed.messages[0]?.createdAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("rejects a document that is not an export", () => {
    expect(() => parseChatGptExport("nope")).toThrow(/Expected a ChatGPT/);
  });

  it("keeps the first copy when shards repeat a conversation id", () => {
    const parsed = parseChatGptFiles([fixture.export, fixture.export]);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.warnings.some((warning) => warning.includes("c1"))).toBe(true);
  });
});
