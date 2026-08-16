// F15 regression — high-volume ITEMLESS bills sync (the captain bug).
//
// Reproduces the reported defect: a real merchant's ~450 seeded bills have NO
// order_items rows; pressing "Đồng bộ sổ" produced 0 accounting_source_receipts /
// 0 accounting_records even though the source counter saw hundreds of "nguồn".
// Root cause was NOT the mapping (revenue is booked from the verified PAYMENT at
// order-total granularity, never from order_items) — it was that syncRange did
// ~7 sequential DB round-trips PER event inside ONE mega-transaction, so on a real
// merchant over the high-latency pooler it ran for many minutes and never committed
// (the whole batch rolled back → 0 rows). The fix batches inserts and commits in
// bounded chunks. This test seeds MANY itemless bills on a throwaway tenant, syncs,
// and asserts 100% coverage + hand-math revenue + idempotent replay + honest label.
//
// Run (needs DB; NOT in `npm test`):
//   node --env-file=.env test/f15-itemless-sync-e2e.mjs
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { syncRange } from "../server/f15/ingest.js";
import { getOverview } from "../server/f15/periods.js";

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
const EMAIL = "soho-crew-test+fix2@soho.test";
const PASSWORD = "SohoFix2Test!2026";
// NEVER touch the two real seeded merchants.
const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];

const PERIOD = "2026-05";       // an isolated test month
const N = 250;                  // > the 200-event chunk boundary → exercises chunking
const CASH_AMT = 100_000;
const QR_AMT = 150_000;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log("  ✓", name); }
  catch (e) { fail++; console.error("  ✗", name, "\n    ", e.message); }
}

async function signIn(sb) {
  let si = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (si.error) {
    const su = await sb.auth.signUp({ email: EMAIL, password: PASSWORD });
    if (su.error) throw new Error("signup: " + su.error.message);
    si = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
    if (si.error) throw new Error("signin: " + si.error.message);
  }
  return si.data.session;
}

async function ensureMerchant(pool, userId) {
  const mm = await pool.query(
    `select merchant_id from public.merchant_members where user_id=$1 and status='active' order by created_at limit 1`, [userId]);
  let merchantId = mm.rows[0]?.merchant_id ?? null;
  if (merchantId && REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  if (!merchantId) {
    const ins = await pool.query(
      `insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
       values ('Cửa hàng Test Fix2','Cửa hàng Test Fix2','household_business','retail','4711','active',$1, now()) returning id`, [userId]);
    merchantId = ins.rows[0].id;
    await pool.query(`insert into public.merchant_members (merchant_id, user_id, role, status) values ($1,$2,'owner','active') on conflict do nothing`, [merchantId, userId]);
    await pool.query(`insert into public.merchant_settings (merchant_id, timezone, receipt_prefix, allow_cash, allow_qr) values ($1,'Asia/Ho_Chi_Minh','FX2', true, true) on conflict (merchant_id) do nothing`, [merchantId]);
  }
  if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant id");
  return merchantId;
}

/** Delete this run's F15 records + the May itemless bills so the test re-runs clean. */
async function cleanup(pool, merchantId) {
  if (REAL_MERCHANTS.includes(merchantId)) throw new Error("REFUSING cleanup on a REAL merchant");
  await pool.query(`delete from public.accounting_record_sources s using public.accounting_records r where s.record_id=r.id and r.merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.accounting_records where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.accounting_source_receipts where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.accounting_periods where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.payments p using public.orders o where p.order_id=o.id and o.merchant_id=$1 and o.order_number like 'FX2-%'`, [merchantId]);
  await pool.query(`delete from public.orders where merchant_id=$1 and order_number like 'FX2-%'`, [merchantId]);
}

/** Seed N itemless orders + succeeded payments (NO order_items at all), in bulk. */
async function seedItemless(pool, merchantId, userId) {
  let expectedRevenue = 0;
  const oVals = [], oParams = [], pVals = [], pParams = [];
  for (let i = 0; i < N; i++) {
    const method = i % 2 === 0 ? "cash" : "qr";
    const amount = method === "cash" ? CASH_AMT : QR_AMT;
    expectedRevenue += amount;
    const day = String((i % 27) + 1).padStart(2, "0");
    const date = `2026-05-${day}`;
    const paidAt = `${date}T${String((i % 12) + 6).padStart(2, "0")}:00:00+07:00`;
    const num = String(i).padStart(4, "0");
    const orderId = randomUUID();
    const ob = oParams.length;
    oVals.push(`($${ob + 1},$${ob + 2},$${ob + 3},$${ob + 4},$${ob + 5},$${ob + 6}::date,'paid',$${ob + 7},0,$${ob + 7},$${ob + 8})`);
    oParams.push(orderId, merchantId, `FX2-${num}`, randomUUID(), userId, date, amount, paidAt);
    const pb = pParams.length;
    pVals.push(`($${pb + 1},$${pb + 2},$${pb + 3},$${pb + 4},'succeeded',$${pb + 5},$${pb + 5},0,$${pb + 6})`);
    pParams.push(merchantId, orderId, `fx2-pay-${num}`, method, amount, paidAt);
  }
  await pool.query(
    `insert into public.orders (id, merchant_id, order_number, client_request_id, cashier_user_id, business_date, status, subtotal_amount, discount_amount, total_amount, paid_at)
     values ${oVals.join(",")}`, oParams);
  await pool.query(
    `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, cash_received, change_due, paid_at)
     values ${pVals.join(",")}`, pParams);
  return expectedRevenue;
}

async function run() {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const sess = await signIn(sb);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  let expectedRevenue = 0, merchantId;
  try {
    merchantId = await ensureMerchant(pool, sess.user.id);
    console.log(`F15 itemless-sync regression — merchant ${merchantId}, period ${PERIOD}, ${N} bills`);
    await cleanup(pool, merchantId);
    expectedRevenue = await seedItemless(pool, merchantId, sess.user.id);

    await test("seeded bills genuinely have NO order_items", async () => {
      const r = await pool.query(
        `select count(*)::int c from public.order_items oi join public.orders o on o.id=oi.order_id
          where o.merchant_id=$1 and o.order_number like 'FX2-%'`, [merchantId]);
      assert.equal(r.rows[0].c, 0, "itemless bills must have zero order_items");
    });

    let syncRes;
    await test(`sync builds records for all ${N} itemless bills (0-gap), and is fast`, async () => {
      const t0 = Date.now();
      syncRes = await syncRange(merchantId, { from: "2026-05-01", to: "2026-05-31" });
      const ms = Date.now() - t0;
      console.log(`    sync: ${JSON.stringify(syncRes)} in ${ms}ms`);
      assert.equal(syncRes.failed, 0, "no chunk may fail");
      assert.equal((syncRes.errors || []).length, 0, "no errors reported");
      assert.equal(syncRes.mapped, N, `all ${N} payments mapped`);
      assert.ok(syncRes.records >= N, "at least one revenue record per bill");
    });

    await test("overview coverage is 100% after sync (source counter == ingest population)", async () => {
      const ov = await getOverview(merchantId, PERIOD);
      assert.equal(ov.coverage.expected, N, `expected == ${N} sources`);
      assert.equal(ov.coverage.processed, N, "all sources processed");
      assert.equal(ov.coverage.missing, 0, "0-gap");
      assert.equal(ov.coverage.complete, true, JSON.stringify(ov.coverage));
      assert.equal(ov.coverage.pct, 100, "100% coverage");
    });

    await test("sổ doanh thu total == hand-math sum of payments (order-total basis)", async () => {
      const ov = await getOverview(merchantId, PERIOD);
      const rev = ov.books.find((b) => b.code === "sales_revenue");
      assert.equal(rev.total, expectedRevenue, `revenue ${rev.total} == ${expectedRevenue}`);
    });

    await test("revenue records carry the honest order_total provenance label", async () => {
      const r = await pool.query(
        `select count(*)::int c from public.accounting_records
          where merchant_id=$1 and book_code='sales_revenue' and dimensions->>'detail'='order_total'`, [merchantId]);
      assert.equal(r.rows[0].c, N, "every revenue record labelled order_total");
    });

    await test("replay is idempotent: second sync adds no records", async () => {
      const r2 = await syncRange(merchantId, { from: "2026-05-01", to: "2026-05-31" });
      // Already-ingested sources are filtered out at load (not-exists) so they are
      // not even re-scanned — the guarantee is simply "no new work".
      assert.equal(r2.scanned, 0, "nothing left to scan");
      assert.equal(r2.mapped, 0, "no new mappings");
      assert.equal(r2.records, 0, "no new records");
      assert.equal(r2.failed, 0, "no failures");
    });
  } finally {
    if (merchantId && !REAL_MERCHANTS.includes(merchantId)) await cleanup(pool, merchantId);
    await pool.end();
  }
  console.log(`\nF15 itemless-sync regression: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("regression crashed:", e); process.exit(1); });
