// Idempotent bootstrap for the Functional 15 throwaway test merchants.
// Creates (or reuses) soho-crew-test+f15@soho.test (+f15b for cross-tenant RLS)
// and seeds SYNTHETIC source facts into the test tenant ONLY, crafted to cross the
// 1-tỷ cumulative-year threshold in the target month so the tax package numbers
// are hand-verifiable:
//   • June 2026: a 900,000,000₫ cash sale → prior-year cumulative = 900M
//   • July 2026: cash 220M + QR 100M − cash refund 20M → net revenue 300M
//                (cash channel 200M, bank channel 100M), + a 50M expense
//                (expense_posted) + a 400M purchase (purchase_received).
// It NEVER touches the two real seeded merchants. Run: node --env-file=.env test/f15-setup.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
export const F15_EMAIL = "soho-crew-test+f15@soho.test";
export const F15B_EMAIL = "soho-crew-test+f15b@soho.test";
export const F15_PASSWORD = "SohoF15Test!2026";
export const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];
export const PERIOD = "2026-07";
export const PRIOR_CUMULATIVE = 900_000_000;
export const NET_REVENUE = 300_000_000; // 220 + 100 − 20

async function signIn(sb, email) {
  let si = await sb.auth.signInWithPassword({ email, password: F15_PASSWORD });
  if (si.error) {
    const su = await sb.auth.signUp({ email, password: F15_PASSWORD });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email, password: F15_PASSWORD });
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

/** Insert one order + succeeded payment (idempotent). `hex` = 12 hex chars uuid tail. */
async function seedPayment(pool, merchantId, userId, { key, hex, method, amount, paidAt, date }) {
  const tag = merchantId.slice(0, 8);
  const clientReqId = `${tag}-15aa-4aaa-8aaa-${hex}`;
  const ord = await pool.query(
    `insert into public.orders (merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
     values ($1,$2,$3,$4,$5::date,'paid',$6,0,$6,$7)
     on conflict (merchant_id, client_request_id) do update set total_amount = excluded.total_amount, paid_at = excluded.paid_at
     returning id`,
    [merchantId, `F15-${tag}-${key}`, clientReqId, userId, date, amount, paidAt]);
  const orderId = ord.rows[0].id;
  const pay = await pool.query(
    `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, cash_received, change_due, paid_at)
     values ($1,$2,$3,$4,'succeeded',$5,$5,0,$6)
     on conflict (merchant_id, idempotency_key) do update set amount = excluded.amount, paid_at = excluded.paid_at
     returning id`,
    [merchantId, orderId, `f15-pay-${key}`, method, amount, paidAt]);
  return { orderId, paymentId: pay.rows[0].id };
}

async function seedRefund(pool, merchantId, { key, paymentId, orderId, method, amount, refundedAt }) {
  const ref = await pool.query(
    `insert into public.payment_refunds (merchant_id, payment_id, order_id, idempotency_key, method, status, amount, reason_code, refunded_at)
     values ($1,$2,$3,$4,$5,'succeeded',$6,'customer_change',$7)
     on conflict (merchant_id, idempotency_key) do update set amount = excluded.amount
     returning id`,
    [merchantId, paymentId, orderId, `f15-ref-${key}`, method, amount, refundedAt]);
  return ref.rows[0].id;
}

async function seedExpense(pool, merchantId, userId, { key, hex, amount, date }) {
  const tag = merchantId.slice(0, 8);
  const exId = `${tag}-15ee-4eee-8eee-${hex}`;
  await pool.query(
    `insert into public.expenses (id, merchant_id, expense_number, expense_date, created_by)
     values ($1,$2,$3,$4::date,$5) on conflict (id) do nothing`,
    [exId, merchantId, `EXP-${tag}-${key}`, date, userId]);
  await pool.query(
    `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
     values ($1,'expense',$2,'expense_posted',$3,'pending')
     on conflict (source_type, source_id, event_type) do update set amount_vnd = excluded.amount_vnd`,
    [merchantId, exId, amount]);
  return exId;
}

async function seedPurchase(pool, merchantId, userId, { key, hex, amount, date }) {
  const tag = merchantId.slice(0, 8);
  const prId = `${tag}-15cc-4ccc-8ccc-${hex}`;
  await pool.query(
    `insert into public.purchase_receipts (id, merchant_id, receipt_number, received_at, created_by)
     values ($1,$2,$3,$4::date,$5) on conflict (id) do nothing`,
    [prId, merchantId, `PR-${tag}-${key}`, date, userId]);
  await pool.query(
    `insert into public.accounting_events (merchant_id, source_type, source_id, event_type, amount_vnd, review_status)
     values ($1,'purchase_receipt',$2,'purchase_received',$3,'pending')
     on conflict (source_type, source_id, event_type) do update set amount_vnd = excluded.amount_vnd`,
    [merchantId, prId, amount]);
  return prId;
}

/** Seed the base June + July source facts (idempotent). */
export async function seedBase(pool, merchantId, userId) {
  // Prior-year cumulative: a 900M June sale.
  await seedPayment(pool, merchantId, userId, { key: "june01", hex: "000000000601", method: "cash", amount: PRIOR_CUMULATIVE, paidAt: "2026-06-15T03:00:00+07:00", date: "2026-06-15" });
  // July revenue: cash 220M + qr 100M − cash refund 20M = net 300M.
  const cash = await seedPayment(pool, merchantId, userId, { key: "july01", hex: "000000000701", method: "cash", amount: 220_000_000, paidAt: "2026-07-10T04:00:00+07:00", date: "2026-07-10" });
  await seedPayment(pool, merchantId, userId, { key: "july02", hex: "000000000702", method: "qr", amount: 100_000_000, paidAt: "2026-07-11T04:00:00+07:00", date: "2026-07-11" });
  await seedRefund(pool, merchantId, { key: "july03", paymentId: cash.paymentId, orderId: cash.orderId, method: "cash", amount: 20_000_000, refundedAt: "2026-07-12T04:00:00+07:00" });
  await seedExpense(pool, merchantId, userId, { key: "july04", hex: "000000000704", amount: 50_000_000, date: "2026-07-05" });
  await seedPurchase(pool, merchantId, userId, { key: "july05", hex: "000000000705", amount: 400_000_000, date: "2026-07-06" });
}

/** A LATE July sale used to drive the attention/restatement flow (call AFTER lock). */
export async function seedLateSale(pool, merchantId, userId) {
  return seedPayment(pool, merchantId, userId, { key: "julylate", hex: "000000000720", method: "cash", amount: 15_000_000, paidAt: "2026-07-20T04:00:00+07:00", date: "2026-07-20" });
}

/** Net revenue directly from succeeded payments − refunds in a local-date window (parity oracle). */
export async function netRevenue(pool, merchantId, from, to) {
  const tsStart = `${from}T00:00:00+07:00`, tsEnd = `${to}T23:59:59.999+07:00`;
  const pay = await pool.query(
    `select coalesce(sum(amount),0)::bigint s from public.payments where merchant_id=$1 and status='succeeded' and paid_at>=$2 and paid_at<=$3`, [merchantId, tsStart, tsEnd]);
  const ref = await pool.query(
    `select coalesce(sum(amount),0)::bigint s from public.payment_refunds where merchant_id=$1 and status='succeeded' and refunded_at>=$2 and refunded_at<=$3`, [merchantId, tsStart, tsEnd]);
  return Number(pay.rows[0].s) - Number(ref.rows[0].s);
}

export function openPool() {
  return new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
}

export async function ensureF15() {
  const sbA = createClient(URL, KEY, { auth: { persistSession: false } });
  const sbB = createClient(URL, KEY, { auth: { persistSession: false } });
  const sessA = await signIn(sbA, F15_EMAIL);
  const sessB = await signIn(sbB, F15B_EMAIL);
  const pool = openPool();
  try {
    const merchantId = await ensureMerchant(pool, sessA.user.id, "Cửa hàng Test F15", "F15");
    const merchantIdB = await ensureMerchant(pool, sessB.user.id, "Cửa hàng Test F15B", "F5B");
    await seedBase(pool, merchantId, sessA.user.id);
    return {
      merchantId, merchantIdB,
      userId: sessA.user.id, userIdB: sessB.user.id,
      token: sessA.access_token, tokenB: sessB.access_token,
      email: F15_EMAIL, emailB: F15B_EMAIL,
    };
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureF15()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error("setup failed:", e.message); process.exit(1); });
}
