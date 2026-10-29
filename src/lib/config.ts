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
  "Account mode needs the public VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY values (they identify the project; they are not secret keys). Never put a service-role or provider key in a VITE_ variable. Until they are set, use local mode: it keeps everything in this tab and is not saved.";
