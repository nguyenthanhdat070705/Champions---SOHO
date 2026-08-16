// Functional 07 live E2E — spec 12.3 P0 matrix against the real DB + a running
// server. NOT in `npm test` (.mjs, needs DATABASE_URL + the server up).
// Run: F7_BASE=http://localhost:<port> node --env-file=.env test/f7-e2e.mjs
// Uses the throwaway soho-crew-test+f7@soho.test merchant (never a real one).
import assert from "node:assert/strict";
import pg from "pg";
import { ensureF7Merchant, REAL_MERCHANTS } from "./f7-setup.mjs";

const BASE = process.env.F7_BASE || "http://localhost:3000";
const F6_MERCHANT = "ce894ec3-497c-4143-80d0-f332df62f91e"; // another test merchant (cross-tenant)

let pass = 0, fail = 0;
function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, e) { fail++; console.error(`  ✗ ${name}\n      ${e?.message || e}`); }

async function main() {
  const { userId, merchantId, token } = await ensureF7Merchant();
  assert.ok(!REAL_MERCHANTS.includes(merchantId), "must be a throwaway merchant");
  console.log(`F7 e2e on merchant ${merchantId} (base ${BASE})`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

  const call = async (method, path, { body, key, tok } = {}) => {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tok || token}` };
    if (key) headers["Idempotency-Key"] = key;
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; const t = await res.text(); if (t) { try { json = JSON.parse(t); } catch { /* */ } }
    return { status: res.status, json };
  };
  const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  const evCount = async (expenseId, type) => {
    const { rows } = await pool.query(
      `select count(*)::int n from public.accounting_events where source_type='expense' and source_id=$1 and event_type=$2`,
      [expenseId, type]);
    return rows[0].n;
  };

  try {
    // categories (also seeds globals) ----------------------------------------
    const cats = await call("GET", `/v1/merchants/${merchantId}/expense-categories`);
    const utilities = cats.json.categories.find((c) => c.code === "utilities");
    const purchases = cats.json.categories.find((c) => c.code === "purchases");
    try { assert.ok(utilities && purchases, "globals seeded"); ok("GLOBAL categories seeded (Điện nước, Nhập hàng)"); }
    catch (e) { bad("GLOBAL categories seeded", e); }

    // EXP-01 draft creates no accounting event --------------------------------
    let draftId;
    try {
      const r = await call("POST", `/v1/merchants/${merchantId}/expenses`,
        { key: uid(), body: { amountVnd: 50000, categoryId: purchases.id, payeeName: "Nháp test" } });
      assert.equal(r.status, 201);
      draftId = r.json.expense.id;
      assert.equal(r.json.expense.status, "draft");
      assert.equal(await evCount(draftId, "expense_posted"), 0);
      ok("EXP-01 draft saved, no accounting event");
    } catch (e) { bad("EXP-01 draft", e); }

    // EXP-02 server recomputes totals (client cannot inject a total) -----------
    try {
      const r = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: {
        categoryId: purchases.id, payeeName: "Totals test",
        items: [ { description: "A", quantity: 2, unitCostVnd: 15000 }, { description: "B", quantity: 1, unitCostVnd: 40000 } ],
        grand_total_vnd: 999999999, amountVnd: 999999999, // bogus client totals — must be ignored
      } });
      assert.equal(r.json.expense.grandTotalVnd, 70000, "server recomputed grand = Σline");
      ok("EXP-02 server recomputes totals; client total ignored");
    } catch (e) { bad("EXP-02 totals", e); }

    // EXP-03 post a 3-line expense → expense + payment fact + ONE event --------
    let postedId;
    try {
      const c = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: {
        categoryId: purchases.id, payeeName: "Nhà cung cấp A", expenseDate: "2026-08-10",
        items: [ { description: "Gạo", quantity: 2, unitCostVnd: 100000 },
                 { description: "Dầu", quantity: 1, unitCostVnd: 50000 },
                 { description: "Đường", quantity: 3, unitCostVnd: 20000 } ],
      } });
      postedId = c.json.expense.id;
      const p = await call("POST", `/v1/merchants/${merchantId}/expenses/${postedId}/post`,
        { key: uid(), body: { expectedVersion: c.json.expense.rowVersion, paymentFact: { method: "transfer", confirmationStatus: "confirmed" }, duplicateReview: { status: "NOT_DUPLICATE" } } });
      assert.equal(p.status, 201);
      assert.equal(p.json.status, "posted");
      assert.equal(p.json.grandTotalVnd, 310000);
      assert.equal(await evCount(postedId, "expense_posted"), 1);
      const { rows: fact } = await pool.query(`select method, confirmation_status from public.expense_payment_facts where expense_id=$1`, [postedId]);
      assert.equal(fact[0].method, "transfer");
      assert.equal(fact[0].confirmation_status, "confirmed");
      ok("EXP-03 post 3 lines → expense + payment fact + one accounting event");
    } catch (e) { bad("EXP-03 post", e); }

    // EXP-04 validation failure is all-or-nothing (no category → no event) -----
    try {
      const c = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: { amountVnd: 12345, payeeName: "No cat" } });
      const noCat = c.json.expense.id;
      const p = await call("POST", `/v1/merchants/${merchantId}/expenses/${noCat}/post`, { key: uid(), body: {} });
      assert.equal(p.status, 400);
      assert.equal(p.json.code, "CATEGORY_REQUIRED");
      assert.equal(await evCount(noCat, "expense_posted"), 0);
      const { rows } = await pool.query(`select status from public.expenses where id=$1`, [noCat]);
      assert.equal(rows[0].status, "draft", "rolled back to draft");
      ok("EXP-04 failed post rolls back (no event, still draft)");
    } catch (e) { bad("EXP-04 rollback", e); }

    // EXP-05 retry post (double-tap) → no duplicate event ---------------------
    // Unique amount per run so a prior run's posted expense can't trip the
    // duplicate gate (this test is about idempotency, not duplicates).
    try {
      const uniqAmount = 100000 + Math.floor(Math.random() * 900000);
      const c = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: { amountVnd: uniqAmount, categoryId: purchases.id, payeeName: `Retry-${uniqAmount}` } });
      const rid = c.json.expense.id; const k = uid();
      const p1 = await call("POST", `/v1/merchants/${merchantId}/expenses/${rid}/post`, { key: k, body: { expectedVersion: c.json.expense.rowVersion } });
      const p2 = await call("POST", `/v1/merchants/${merchantId}/expenses/${rid}/post`, { key: k, body: { expectedVersion: c.json.expense.rowVersion } });
      assert.equal(p1.json.status, "posted");
      assert.equal(p2.json.status, "posted");
      assert.equal(await evCount(rid, "expense_posted"), 1, "exactly one event after retry");
      ok("EXP-05 post retry is idempotent (one event)");
    } catch (e) { bad("EXP-05 retry", e); }

    // EXP-06 one source → one expense (F06-style event replay) -----------------
    try {
      const sid = uid();
      const a = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: { amountVnd: 42000, categoryId: purchases.id, sourceType: "purchase_receipt", sourceId: sid } });
      const b = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: { amountVnd: 42000, categoryId: purchases.id, sourceType: "purchase_receipt", sourceId: sid } });
      assert.equal(a.json.expense.id, b.json.expense.id, "same source → same expense");
      ok("EXP-06 one source → one expense (dedup on source_uq)");
    } catch (e) { bad("EXP-06 source dedup", e); }

    // EXP-07 duplicate warning on near-identical pair -------------------------
    try {
      const mk = async () => {
        const c = await call("POST", `/v1/merchants/${merchantId}/expenses`, { key: uid(), body: { amountVnd: 1280000, categoryId: utilities.id, payeeName: "Điện lực Miền Nam", expenseDate: "2026-08-12" } });
        return c.json.expense;
      };
      const e1 = await mk();
      await call("POST", `/v1/merchants/${merchantId}/expenses/${e1.id}/post`, { key: uid(), body: { expectedVersion: e1.rowVersion } });
      const e2 = await mk();
      const blocked = await call("POST", `/v1/merchants/${merchantId}/expenses/${e2.id}/post`, { key: uid(), body: { expectedVersion: e2.rowVersion } });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.json.code, "POSSIBLE_DUPLICATE_EXPENSE");
      assert.ok(blocked.json.details.candidates.length >= 1, "candidates returned");
      // proceed anyway → posts + records finding
      const proceed = await call("POST", `/v1/merchants/${merchantId}/expenses/${e2.id}/post`, { key: uid(), body: { expectedVersion: e2.rowVersion, duplicateReview: { status: "NOT_DUPLICATE" } } });
      assert.equal(proceed.json.status, "posted");
      const { rows: findings } = await pool.query(`select count(*)::int n from public.expense_duplicate_findings where expense_id=$1`, [e2.id]);
      assert.ok(findings[0].n >= 1, "duplicate finding recorded");
      ok("EXP-07 duplicate warning fires; proceed records a finding");
    } catch (e) { bad("EXP-07 duplicate", e); }

    // EXP-11 reverse posted → reversal event, original untouched ---------------
    try {
      const before = await pool.query(`select grand_total_vnd from public.expenses where id=$1`, [postedId]);
      const r = await call("POST", `/v1/merchants/${merchantId}/expenses/${postedId}/reverse`, { key: uid(), body: { reason: "Ghi nhầm" } });
      assert.equal(r.json.status, "reversed");
      assert.equal(await evCount(postedId, "expense_reversed"), 1);
      const after = await pool.query(`select status, grand_total_vnd from public.expenses where id=$1`, [postedId]);
      assert.equal(after.rows[0].status, "reversed");
      assert.equal(Number(after.rows[0].grand_total_vnd), Number(before.rows[0].grand_total_vnd), "original total unchanged");
      ok("EXP-11 reverse → reversal event, original preserved");
    } catch (e) { bad("EXP-11 reverse", e); }

    // EXP-12 reverse twice → conflict -----------------------------------------
    try {
      const r = await call("POST", `/v1/merchants/${merchantId}/expenses/${postedId}/reverse`, { key: uid(), body: { reason: "again" } });
      assert.equal(r.status, 409);
      assert.equal(r.json.code, "EXPENSE_ALREADY_REVERSED");
      assert.equal(await evCount(postedId, "expense_reversed"), 1, "still one reversal event");
      ok("EXP-12 double reverse → conflict");
    } catch (e) { bad("EXP-12 double reverse", e); }

    // EXP-13 RLS cross-tenant → 403 -------------------------------------------
    try {
      const r = await call("GET", `/v1/merchants/${F6_MERCHANT}/expenses`, {});
      assert.equal(r.status, 403);
      ok("EXP-13 cross-tenant list → 403 FORBIDDEN");
    } catch (e) { bad("EXP-13 rls", e); }

    // Photo path input validation (missing image → 400, not 500) --------------
    try {
      const r = await call("POST", `/v1/merchants/${merchantId}/expenses/ai/preview`, { body: {} });
      assert.equal(r.status, 400);
      ok("AI preview rejects missing image (400)");
    } catch (e) { bad("AI preview validation", e); }
  } finally {
    await pool.end();
  }

  console.log(`\nF7 e2e: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e crashed:", e); process.exit(1); });
