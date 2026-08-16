// Idempotent bootstrap for the Functional 14 throwaway test merchants.
// Creates (or reuses) soho-crew-test+f14@soho.test (+f14b for cross-tenant RLS).
// It NEVER touches the two real seeded merchants and only writes to the test
// tenant. `seedCashDay` inserts orders + cash payments + cash refunds (and an
// optional QR bill to prove QR is excluded) with explicit paid_at/refunded_at
// inside a chosen business date window, so expected-cash math is exercised
// WITHOUT the whole F3 sale flow. `cleanClosingDay` wipes the F14 rows for a date
// so the e2e is re-runnable. Run: node --env-file=.env test/f14-setup.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const F14_EMAIL = "soho-crew-test+f14@soho.test";
export const F14B_EMAIL = "soho-crew-test+f14b@soho.test";
export const F14_PASSWORD = "SohoF14Test!2026";
export const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];
const TZ = "Asia/Ho_Chi_Minh";

async function signIn(sb, email) {
  let si = await sb.auth.signInWithPassword({ email, password: F14_PASSWORD });
  if (si.error) {
    const su = await sb.auth.signUp({ email, password: F14_PASSWORD });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email, password: F14_PASSWORD });
    if (si.error) throw new Error("signin-after-signup: " + si.error.message);
  }
  return si.data.session;
}

async function ensureMerchant(pool, userId, name, prefix) {
  const mm = await pool.query(
    `select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`, [userId]);
  let merchantId = mm.rows[0]?.merchant_id ?? null;
  if (merchantId && REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: test user resolved to a REAL merchant id");
  if (!merchantId) {
    const ins = await pool.query(
      `insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
       values ($1,$2,'household_business','retail','4711','active',$3, now()) returning id`,
      [name, name, userId]);
    merchantId = ins.rows[0].id;
    await pool.query(
      `insert into public.merchant_members (merchant_id, user_id, role, status) values ($1,$2,'owner','active') on conflict do nothing`,
      [merchantId, userId]);
    await pool.query(
      `insert into public.merchant_settings (merchant_id, timezone, receipt_prefix, allow_cash, allow_qr)
       values ($1,$2,$3, true, true) on conflict (merchant_id) do nothing`,
      [merchantId, TZ, prefix]);
  }
  if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  return merchantId;
}

/** Delete every F14 row for (merchant, business_date) so the e2e is re-runnable. */
export async function cleanClosingDay(pool, merchantId, businessDate) {
  const cl = await pool.query(`select id from public.daily_closings where merchant_id=$1 and business_date=$2`, [merchantId, businessDate]);
  for (const c of cl.rows) {
    const drafts = await pool.query(`select id from public.closing_drafts where closing_id=$1`, [c.id]);
    for (const d of drafts.rows) {
      await pool.query(`delete from public.cash_counts where draft_id=$1`, [d.id]);
      await pool.query(`delete from public.closing_source_snapshots where draft_id=$1`, [d.id]);
    }
    await pool.query(`delete from public.closing_attention_items where closing_id=$1`, [c.id]);
    // Break the current_revision_id FK before deleting revisions.
    await pool.query(`update public.daily_closings set current_revision_id=null, active_draft_id=null where id=$1`, [c.id]);
    await pool.query(`delete from public.closing_revisions where closing_id=$1`, [c.id]);
    await pool.query(`delete from public.closing_drafts where closing_id=$1`, [c.id]);
    await pool.query(`delete from public.daily_closings where id=$1`, [c.id]);
  }
}

/** Delete the seeded money rows for a business date so a re-run reseeds cleanly. */
export async function cleanMoneyDay(pool, merchantId, businessDate) {
  const ords = await pool.query(`select id from public.orders where merchant_id=$1 and business_date=$2`, [merchantId, businessDate]);
  for (const o of ords.rows) {
    await pool.query(`delete from public.payment_refunds where order_id=$1`, [o.id]);
    await pool.query(`delete from public.payments where order_id=$1`, [o.id]);
    await pool.query(`delete from public.orders where id=$1`, [o.id]);
  }
}

/**
 * Seed cash bills / refunds (+ optional QR bill) for a business date. Timestamps
 * land at local noon of `businessDate` so they fall inside the day window.
 * Returns the created ids. `tag` disambiguates order/idempotency keys per call.
 */
export async function seedCashDay(pool, merchantId, userId, businessDate, { bills = [], refunds = [], qr = [], tag = "a" } = {}) {
  const at = `(($1::date) + time '12:00') at time zone '${TZ}'`;
  const out = { bills: [], refunds: [], qr: [] };
  let i = 0;
  for (const amount of bills) {
    i++;
    const ord = await pool.query(
      `insert into public.orders (merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
       values ($2,$3,gen_random_uuid(),$4,$1,'paid',$5,0,$5, ${at}) returning id`,
      [businessDate, merchantId, `F14-${tag}-b${i}-${businessDate}`, userId, amount]);
    const pay = await pool.query(
      `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, cash_received, change_due, paid_at)
       values ($2,$3,$4,'cash','succeeded',$5,$5,0, ${at}) returning id`,
      [businessDate, merchantId, ord.rows[0].id, `f14-${tag}-pay-b${i}-${businessDate}`, amount]);
    out.bills.push({ orderId: ord.rows[0].id, paymentId: pay.rows[0].id, amount });
  }
  i = 0;
  for (const amount of refunds) {
    i++;
    // Attach the refund to the first bill's payment if present, else a fresh one.
    let paymentId = out.bills[0]?.paymentId;
    let orderId = out.bills[0]?.orderId;
    if (!paymentId) {
      const ord = await pool.query(
        `insert into public.orders (merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
         values ($2,$3,gen_random_uuid(),$4,$1,'paid',$5,0,$5, ${at}) returning id`,
        [businessDate, merchantId, `F14-${tag}-ro${i}-${businessDate}`, userId, amount]);
      orderId = ord.rows[0].id;
      const pay = await pool.query(
        `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, paid_at)
         values ($2,$3,$4,'cash','succeeded',$5, ${at}) returning id`,
        [businessDate, merchantId, orderId, `f14-${tag}-rp${i}-${businessDate}`, amount]);
      paymentId = pay.rows[0].id;
    }
    const ref = await pool.query(
      `insert into public.payment_refunds (merchant_id, payment_id, order_id, idempotency_key, method, status, amount, reason_code, refunded_at)
       values ($2,$3,$4,$5,'cash','succeeded',$6,'customer_return', ${at}) returning id`,
      [businessDate, merchantId, paymentId, orderId, `f14-${tag}-ref${i}-${businessDate}`, amount]);
    out.refunds.push({ refundId: ref.rows[0].id, amount });
  }
  i = 0;
  for (const amount of qr) {
    i++;
    const ord = await pool.query(
      `insert into public.orders (merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
       values ($2,$3,gen_random_uuid(),$4,$1,'paid',$5,0,$5, ${at}) returning id`,
      [businessDate, merchantId, `F14-${tag}-q${i}-${businessDate}`, userId, amount]);
    const pay = await pool.query(
      `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, paid_at)
       values ($2,$3,$4,'qr','succeeded',$5, ${at}) returning id`,
      [businessDate, merchantId, ord.rows[0].id, `f14-${tag}-qr${i}-${businessDate}`, amount]);
    out.qr.push({ orderId: ord.rows[0].id, paymentId: pay.rows[0].id, amount });
  }
  return out;
}

export async function ensureF14() {
  const sbA = createClient(URL, KEY, { auth: { persistSession: false } });
  const sbB = createClient(URL, KEY, { auth: { persistSession: false } });
  const sessA = await signIn(sbA, F14_EMAIL);
  const sessB = await signIn(sbB, F14B_EMAIL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  try {
    const merchantId = await ensureMerchant(pool, sessA.user.id, "Cửa hàng Test F14", "F14");
    const merchantIdB = await ensureMerchant(pool, sessB.user.id, "Cửa hàng Test F14B", "F1B");
    return {
      merchantId, merchantIdB,
      userId: sessA.user.id, userIdB: sessB.user.id,
      token: sessA.access_token, tokenB: sessB.access_token,
      email: F14_EMAIL, emailB: F14B_EMAIL,
    };
  } finally {
    await pool.end();
  }
}

export function makePool() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureF14()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
}
