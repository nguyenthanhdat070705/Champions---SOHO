// Centralised server-side env access for Functional 03. The Supabase URL/anon
// key are the same publishable values the client uses (RLS-safe); the server
// uses them only to VALIDATE a caller's JWT via the Auth server. Privileged DB
// access is the pooler (DATABASE_URL), never the anon key.

const FALLBACK_SUPABASE_URL = "https://ugkbcnnaewdfdyibpvdn.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVna2Jjbm5hZXdkZmR5aWJwdmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3Nzk1ODcsImV4cCI6MjEwMjM1NTU4N30.ESEGhkDJscunbSy85kStEOPRxUQtRALPXZpgRIIUXEw";

export function supabaseUrl() {
  return (
    process.env.SUPABASE_URL?.trim() ||
    process.env.VITE_SUPABASE_URL?.trim() ||
    FALLBACK_SUPABASE_URL
  );
}

export function supabaseAnonKey() {
  return (
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    FALLBACK_SUPABASE_ANON_KEY
  );
}

/**
 * Whether dev-only endpoints (the local PayOS webhook simulator) are allowed.
 * NEVER true in production: requires an explicit opt-in AND a non-production
 * NODE_ENV. The real webhook can't reach a laptop, so tests drive confirmation
 * through this simulated path (spec brief G12).
 */
export function devEndpointsEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.SOHO_DEV_ENDPOINTS === "1" || process.env.SOHO_DEV_ENDPOINTS === "true";
}
