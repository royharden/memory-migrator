import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { publicConfig } from "./config.ts";

let cached: SupabaseClient | null | undefined;

export function getSupabase(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const config = publicConfig();
  if (!config) {
    cached = null;
    return null;
  }
  cached = createClient(config.url, config.anonKey);
  return cached;
}
