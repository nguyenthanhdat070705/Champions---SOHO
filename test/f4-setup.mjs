// Idempotent bootstrap for the Functional 04 throwaway test merchant.
// Creates (or reuses) the auth account soho-crew-test+f4@soho.test and ensures it
// owns a dedicated test merchant. NEVER touches the two real seeded merchants.
// Run: node --env-file=.env test/f4-setup.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const F4_EMAIL = "soho-crew-test+f4@soho.test";
export const F4_PASSWORD = "SohoF4Test!2026";
const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];

export async function ensureF4Merchant() {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  let si = await sb.auth.signInWithPassword({ email: F4_EMAIL, password: F4_PASSWORD });
  if (si.error) {
    const su = await sb.auth.signUp({ email: F4_EMAIL, password: F4_PASSWORD });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email: F4_EMAIL, password: F4_PASSWORD });
    if (si.error) throw new Error("signin-after-signup: " + si.error.message);
  }
  const session = si.data.session;
  const userId = session.user.id;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  try {
    const mm = await pool.query(
      `select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`,
      [userId],
    );
    let merchantId = mm.rows[0]?.merchant_id ?? null;
    if (merchantId && REAL_MERCHANTS.includes(merchantId)) {
      throw new Error("REFUSING: f4 test user resolved to a REAL merchant id");
    }
    if (!merchantId) {
      const ins = await pool.query(
        `insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
         values ($1,$2,'household_business','retail','4711','active',$3, now()) returning id`,
        ["Cửa hàng Test F4", "Test F4", userId],
      );
      merchantId = ins.rows[0].id;
      await pool.query(
        `insert into public.merchant_members (merchant_id, user_id, role, status)
         values ($1,$2,'owner','active')
         on conflict do nothing`,
        [merchantId, userId],
      );
    }
    if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
    return { userId, merchantId, token: session.access_token, email: F4_EMAIL };
  } finally {
    await pool.end();
  }
}

// When run directly, print the ids.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureF4Merchant()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
}
