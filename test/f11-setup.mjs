// Idempotent bootstrap for the Functional 11 throwaway test merchants.
// Creates (or reuses) soho-crew-test+f11@soho.test (+f11b for cross-tenant RLS)
// and, for +f11, seeds SYNTHETIC source facts (an order + a succeeded cash
// payment, a succeeded cash refund, and a purchase_received accounting_event) so
// the cashbook ingest/sync can be exercised WITHOUT the whole F3 sale flow. It
// NEVER touches the two real seeded merchants and only writes to the test tenant.
// Run: node --env-file=.env test/f11-setup.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const F11_EMAIL = "soho-crew-test+f11@soho.test";
export const F11B_EMAIL = "soho-crew-test+f11b@soho.test";
export const F11_PASSWORD = "SohoF11Test!2026";
export const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];

async function signIn(sb, email) {
  let si = await sb.auth.signInWithPassword({ email, password: F11_PASSWORD });
  if (si.error) {
    const su = await sb.auth.signUp({ email, password: F11_PASSWORD });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email, password: F11_PASSWORD });
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
       values ($1,'Asia/Ho_Chi_Minh',$2, true, true) on conflict (merchant_id) do nothing`,
      [merchantId, prefix]);
  }
  if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  return merchantId;
}

/** Seed one order + succeeded cash payment + succeeded cash refund + a
 *  purchase_received accounting_event. Idempotent by fixed client_request_id/keys. */
export async function seedSources(pool, merchantId, userId) {
  const tag = merchantId.slice(0, 8); // first uuid group (8 hex chars)
  const clientReqId = `${tag}-1111-4111-8111-111111111101`;
  const receiptId = `${tag}-2222-4222-8222-222222222202`;
  // Order (minimal). occurred_at for entries comes from paid_at/refunded_at.
  const ord = await pool.query(
    `insert into public.orders (merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
     values ($1,$2,$3,$4, (now() at time zone 'Asia/Ho_Chi_Minh')::date, 'paid', 320000, 0, 320000, now())
     on conflict (merchant_id, client_request_id) do update set order_number = excluded.order_number
     returning id`,
    [merchantId, `F11-${tag}-1`, clientReqId, userId]);
  const orderId = ord.rows[0].id;

  const pay = await pool.query(
    `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, cash_received, change_due, paid_at)
     values ($1,$2,$3,'cash','succeeded',320000,320000,0, now())
     on conflict (merchant_id, idempotency_key) do update set amount = excluded.amount
     returning id`,
    [merchantId, orderId, `f11-pay-${tag}`]);
  const paymentId = pay.rows[0].id;

  const ref = await pool.query(
    `insert into public.payment_refunds (merchant_id, payment_id, order_id, idempotency_key, method, status, amount, reason_code, refunded_at)
     values ($1,$2,$3,$4,'cash','succeeded',20000,'customer_change', now())
     on conflict (merchant_id, idempotency_key) do update set amount = excluded.amount
     returning id`,
    [merchantId, paymentId, orderId, `f11-ref-${tag}`]);
  const refundId = ref.rows[0].id;

  // A synthetic purchase receipt id + its purchase_received accounting_event.
  const evt = await pool.query(
    `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
     values ($1,'purchase_receipt',$2,'purchase_received',1280000,'pending')
     on conflict (source_type, source_id, event_type) do update set amount_vnd = excluded.amount_vnd
     returning id`,
    [merchantId, receiptId]);
  const eventId = evt.rows[0].id;

  return { orderId, paymentId, refundId, receiptId, eventId };
}

export async function ensureF11() {
  const sbA = createClient(URL, KEY, { auth: { persistSession: false } });
  const sbB = createClient(URL, KEY, { auth: { persistSession: false } });
  const sessA = await signIn(sbA, F11_EMAIL);
  const sessB = await signIn(sbB, F11B_EMAIL);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  try {
    const merchantId = await ensureMerchant(pool, sessA.user.id, "Cửa hàng Test F11", "F11");
    const merchantIdB = await ensureMerchant(pool, sessB.user.id, "Cửa hàng Test F11B", "F1B");
    const sources = await seedSources(pool, merchantId, sessA.user.id);
    return {
      merchantId, merchantIdB,
      userId: sessA.user.id, userIdB: sessB.user.id,
      token: sessA.access_token, tokenB: sessB.access_token,
      email: F11_EMAIL, emailB: F11B_EMAIL, sources,
    };
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureF11()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
}
