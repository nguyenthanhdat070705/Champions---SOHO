// Idempotent bootstrap for the Functional 06 throwaway test merchant.
// Creates (or reuses) soho-crew-test+f6@soho.test, ensures it owns a dedicated
// test merchant, and seeds a couple of tracked-goods products for receiving.
// NEVER touches the two real seeded merchants. Run: node --env-file=.env test/f6-setup.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const F6_EMAIL = "soho-crew-test+f6@soho.test";
export const F6_PASSWORD = "SohoF6Test!2026";
// A second user for cross-tenant RLS tests.
export const F6_OTHER_EMAIL = "soho-crew-test+f6b@soho.test";
export const F6_OTHER_PASSWORD = "SohoF6bTest!2026";
export const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];

async function signInOrUp(sb, email, password) {
  let si = await sb.auth.signInWithPassword({ email, password });
  if (si.error) {
    const su = await sb.auth.signUp({ email, password });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email, password });
    if (si.error) throw new Error("signin-after-signup: " + si.error.message);
  }
  return si.data.session;
}

async function ensureMerchantFor(pool, userId, label, prefix) {
  const mm = await pool.query(
    `select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`,
    [userId],
  );
  let merchantId = mm.rows[0]?.merchant_id ?? null;
  if (merchantId && REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  if (!merchantId) {
    const ins = await pool.query(
      `insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
       values ($1,$2,'household_business','retail','4711','active',$3, now()) returning id`,
      [`Cửa hàng ${label}`, label, userId],
    );
    merchantId = ins.rows[0].id;
    await pool.query(
      `insert into public.merchant_members (merchant_id, user_id, role, status) values ($1,$2,'owner','active') on conflict do nothing`,
      [merchantId, userId],
    );
    await pool.query(
      `insert into public.merchant_settings (merchant_id, timezone, receipt_prefix, allow_cash, allow_qr)
       values ($1,'Asia/Ho_Chi_Minh',$2, true, true) on conflict (merchant_id) do nothing`,
      [merchantId, prefix],
    );
  }
  if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  return merchantId;
}

/** Ensure two named tracked-goods products exist; return their ids. */
async function ensureProducts(pool, merchantId, userId) {
  const wanted = [
    { name: "Nước suối 500ml", sku: "F6-NS500", unit: "chai" },
    { name: "Mì gói Hảo Hảo", sku: "F6-MG", unit: "goi" },
  ];
  const ids = [];
  for (const w of wanted) {
    const ex = await pool.query(`select id from public.products where merchant_id=$1 and sku=$2`, [merchantId, w.sku]);
    if (ex.rows.length) { ids.push(ex.rows[0].id); continue; }
    const p = await pool.query(
      `insert into public.products (merchant_id, name, sku, unit_code, sale_price, product_type, track_inventory, status, search_name, negative_stock_policy, low_stock_threshold)
       values ($1,$2,$3,$4,$5,'goods',true,'active',$6,'block',5) returning id`,
      [merchantId, w.name, w.sku, w.unit, 10000, w.name.toLowerCase()],
    );
    const pid = p.rows[0].id;
    await pool.query(
      `insert into public.inventory_levels (merchant_id, product_id, on_hand, low_stock_threshold) values ($1,$2,0,5)
       on conflict (merchant_id, product_id) do nothing`,
      [merchantId, pid],
    );
    ids.push(pid);
  }
  return ids;
}

export async function ensureF6() {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const session = await signInOrUp(sb, F6_EMAIL, F6_PASSWORD);
  const userId = session.user.id;

  const sb2 = createClient(URL, KEY, { auth: { persistSession: false } });
  const otherSession = await signInOrUp(sb2, F6_OTHER_EMAIL, F6_OTHER_PASSWORD);
  const otherUserId = otherSession.user.id;

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  try {
    const merchantId = await ensureMerchantFor(pool, userId, "Test F6", "F6T");
    const otherMerchantId = await ensureMerchantFor(pool, otherUserId, "Test F6B", "F6B");
    const productIds = await ensureProducts(pool, merchantId, userId);
    return {
      userId, merchantId, token: session.access_token, email: F6_EMAIL, productIds,
      other: { userId: otherUserId, merchantId: otherMerchantId, token: otherSession.access_token, email: F6_OTHER_EMAIL },
    };
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureF6()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
}
