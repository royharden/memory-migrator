import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20261023180000_init.sql", "utf8");

describe("migration contract", () => {
  it("enables owner-only RLS, requires provenance, and keeps the export bucket private", () => {
    for (const table of ["profiles", "imports", "messages", "facts", "audit_log"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("auth.uid()");
    expect(sql).toContain("provenance_quote text not null");
    expect(sql).toContain("char_length(provenance_quote) > 0");
    expect(sql).toContain("'tombstoned'");
    expect(sql).toContain("'hold'");
    expect(sql).toContain("'memory-exports'");
    expect(sql).toContain("false");
    expect(sql).not.toContain("service_role");
    expect(sql.toLowerCase()).not.toContain("password");
    expect(sql).not.toContain("VITE_");
  });
});
