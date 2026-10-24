export interface PublicConfig {
  url: string;
  anonKey: string;
}

export function publicConfig(): PublicConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export const SETUP_MESSAGE =
  "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to save a profile. MEMORY_EXTRACT_API_KEY and MEMORY_EXTRACT_URL are server secrets and must not use a VITE_ prefix. Until the public values are set, use the local demo. It is not saved.";
