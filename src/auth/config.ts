/**
 * Where the account service lives. Both values come from the build's
 * environment (`.env.local`, see `.env.example`). With either one missing
 * there are no accounts at all: the app is guest-only and shows no sign-in.
 */

export interface AccountConfig {
  url: string;
  /** The public ("anon") key. Safe in the browser; the database's access rules do the protecting. */
  anonKey: string;
}

/** The account service's address and key, or null when accounts are switched off. */
export function accountConfig(env: Record<string, unknown> = import.meta.env): AccountConfig | null {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const url = text(env.VITE_SUPABASE_URL);
  const anonKey = text(env.VITE_SUPABASE_ANON_KEY);
  if (!url || !anonKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return { url, anonKey };
}
