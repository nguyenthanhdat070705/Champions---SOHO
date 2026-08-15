// Supabase connection config.
//
// The anon (publishable) key is client-safe by design — row-level security on
// the Supabase project enforces per-user access. We read from Vite env vars when
// present and otherwise fall back to the known publishable values so a build
// produced without a populated .env (e.g. on Railway) still reaches Supabase.
//
// NEVER put a service_role / secret key here. Only the publishable anon key.

const FALLBACK_SUPABASE_URL = "https://ugkbcnnaewdfdyibpvdn.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVna2Jjbm5hZXdkZmR5aWJwdmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3Nzk1ODcsImV4cCI6MjEwMjM1NTU4N30.ESEGhkDJscunbSy85kStEOPRxUQtRALPXZpgRIIUXEw";

export const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL?.trim() || FALLBACK_SUPABASE_URL;

export const SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || FALLBACK_SUPABASE_ANON_KEY;

export const CONSENT_DOCUMENT_VERSION = "1.0";
