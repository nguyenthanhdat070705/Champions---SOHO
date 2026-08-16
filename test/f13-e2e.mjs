// Functional 13 live E2E (spec 12.3 P0 matrix). NOT part of `npm test` (needs the
// real DB + Supabase auth). Run: node --env-file=.env test/f13-e2e.mjs
//
// Seeds a deterministic "today" on a THROWAWAY test merchant (soho-crew-test+f13),
// never a real merchant, then verifies: hand-computed metric parity, same-day ==
// get_today_dashboard (the deployed F2 RPC), coverage gap on bills-without-items,
// immutable rebuild → new revision, drill-down sum parity, compatible compare,
// CSV export parity, and cross-tenant isolation.
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import assert from "node:assert/strict";
import { findOrBuildSnapshot, getSnapshot, drilldown, compareSnapshots } from "../server/f13/snapshots.js";
import { createExport, getExportFile } from "../server/f13/export.js";
import { closePool } from "../server/db/pool.js";

const URL = process.env.VITE_SUPABASE_URL, KEY = process.env.VITE_SUPABASE_ANON_KEY;
const EMAIL = "soho-crew-test+f13@soho.test", PASSWORD = "SohoF13Test!2026";
const REAL = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 4 });
let pass = 0;
const ok = (name) => { console.log("  ✓", name); pass++; };

async function ensure() {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  let si = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (si.error) { await sb.auth.signUp({ email: EMAIL, password: PASSWORD }); si = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD }); }
  if (si.error) throw new Error("auth: " + si.error.message);
  const userId = si.data.session.user.id;
  const mm = await pool.query(`select merchant_id from public.merchant_members where user_id=$1 and status='active' limit 1`, [userId]);
  let merchantId = mm.rows[0]?.merchant_id ?? null;
  if (merchantId && REAL.includes(merchantId)) throw new Error("REFUSING: resolved a REAL merchant");
  if (!merchantId) {
    const ins = await pool.query(
      `insert into public.merchants (legal_name, display_name, legal_type, business_model, industry_code, status, created_by, onboarding_completed_at)
       values ('Cửa hàng Test F13','Test F13','household_business','retail','4711','active',$1, now()) returning id`, [userId]);
    merchantId = ins.rows[0].id;
    await pool.query(`insert into public.merchant_members (merchant_id, user_id, role, status) values ($1,$2,'owner','active') on conflict do nothing`, [merchantId, userId]);
  }
  if (REAL.includes(merchantId)) throw new Error("REFUSING: real merchant");
  return { sb, userId, merchantId };
}

async function wipe(merchantId) {
  await pool.query(`delete from public.report_snapshot_metrics where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.report_data_quality where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.report_exports where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.report_snapshots where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.payment_refunds where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.payments where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.order_items where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.orders where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.expenses where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.purchase_receipts where merchant_id=$1`, [merchantId]);
  await pool.query(`delete from public.inventory_movements where merchant_id=$1`, [merchantId]);
}

async function product(merchantId, userId, name) {
  const r = await pool.query(`insert into public.products (merchant_id, name, search_name, unit_code, sale_price) values ($1,$2,$2,'cai',0) returning id`, [merchantId, name]);
  await pool.query(`insert into public.inventory_levels (merchant_id, product_id, on_hand) values ($1,$2,100) on conflict (merchant_id,product_id) do update set on_hand=100`, [merchantId, r.rows[0].id]);
  return r.rows[0].id;
}
async function paidOrder(merchantId, userId, tag, total, items /* [{pid,name,qty,price}] */, method) {
  const o = await pool.query(
    `insert into public.orders (merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, paid_at, business_date, client_request_id, cashier_user_id)
     values ($1,$2,'paid',$3,0,$3, now(), (timezone('Asia/Ho_Chi_Minh',now())::date), gen_random_uuid(), $4) returning id`,
    [merchantId, tag, total, userId]);
  const oid = o.rows[0].id;
  let line = 0;
  for (const it of items) {
    line++;
    await pool.query(
      `insert into public.order_items (merchant_id, order_id, line_no, name_snapshot, unit_code_snapshot, unit_price, quantity, gross_amount, net_amount, product_id)
       values ($1,$2,$3,$4,'cai',$5,$6,$7,$7,$8)`,
      [merchantId, oid, line, it.name, it.price, it.qty, it.qty * it.price, it.pid]);
  }
  const pmt = await pool.query(
    `insert into public.payments (merchant_id, order_id, method, status, amount, paid_at, idempotency_key)
     values ($1,$2,$3,'succeeded',$4, now(), $5) returning id`, [merchantId, oid, method, total, tag + "-pmt"]);
  return { oid, paymentId: pmt.rows[0].id };
}

async function main() {
  const { sb, userId, merchantId } = await ensure();
  console.log(`F13 E2E on merchant ${merchantId}`);
  await wipe(merchantId);

  const P1 = await product(merchantId, userId, "Cà phê F13");
  const P2 = await product(merchantId, userId, "Bánh mì F13");
  const ts = Date.now();
  const o1 = await paidOrder(merchantId, userId, `F13-${ts}-1`, 100_000, [{ pid: P1, name: "Cà phê F13", qty: 2, price: 50_000 }], "cash");
  await paidOrder(merchantId, userId, `F13-${ts}-2`, 60_000, [{ pid: P2, name: "Bánh mì F13", qty: 1, price: 60_000 }], "qr");
  await paidOrder(merchantId, userId, `F13-${ts}-3`, 40_000, [], "cash"); // NO items → partial coverage
  // partial refund on o1 (cash) — order stays 'paid' (F3 rule), net drops by 20k
  await pool.query(
    `insert into public.payment_refunds (merchant_id, payment_id, order_id, amount, status, refunded_at, idempotency_key, method, reason_code)
     values ($1,$2,$3,20000,'succeeded', now(), $4, 'cash','customer_return')`, [merchantId, o1.paymentId, o1.oid, `F13-${ts}-rf`]);
  // expenses posted today
  await pool.query(`insert into public.expenses (merchant_id, expense_number, status, expense_date, grand_total_vnd, subtotal_vnd, created_by, posted_at) values ($1,$2,'posted',(timezone('Asia/Ho_Chi_Minh',now())::date),50000,50000,$3, now())`, [merchantId, `EXP-${ts}-1`, userId]);
  await pool.query(`insert into public.expenses (merchant_id, expense_number, status, expense_date, grand_total_vnd, subtotal_vnd, created_by, posted_at) values ($1,$2,'posted',(timezone('Asia/Ho_Chi_Minh',now())::date),30000,30000,$3, now())`, [merchantId, `EXP-${ts}-2`, userId]);
  // purchase receipt posted today
  await pool.query(`insert into public.purchase_receipts (merchant_id, receipt_number, status, received_at, grand_total_vnd, subtotal_vnd, created_by, posted_at) values ($1,$2,'posted',(timezone('Asia/Ho_Chi_Minh',now())::date),500000,500000,$3, now())`, [merchantId, `RCP-${ts}`, userId]);
  // damage writeoff today
  await pool.query(`insert into public.inventory_movements (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by) values ($1,$2,'damage_writeoff',-3,97,'manual',$3,$4)`, [merchantId, P1, o1.oid, userId]);

  // ── Build the day snapshot ──
  const built = await findOrBuildSnapshot(merchantId, userId, { preset: "day" }, "idem-build-1");
  const s = built.snapshot;
  assert.equal(s.snapshot.status, "ready");
  assert.equal(s.snapshot.revision, 1);
  assert.equal(s.sections.sales.grossVnd, 200_000);
  assert.equal(s.sections.sales.refundVnd, 20_000);
  assert.equal(s.sections.sales.netVnd, 180_000);
  assert.equal(s.sections.sales.billCount, 3);
  assert.equal(s.sections.sales.billAvgVnd, Math.round(200_000 / 3));
  assert.equal(s.sections.sales.byChannel.find((c) => c.channel === "cash").netVnd, 120_000);
  assert.equal(s.sections.sales.byChannel.find((c) => c.channel === "qr").netVnd, 60_000);
  assert.equal(s.sections.expense.totalVnd, 80_000);
  assert.equal(s.sections.inventory.purchaseVnd, 500_000);
  assert.equal(s.sections.inventory.damageCount, 1);
  assert.equal(s.sections.inventory.damageQty, 3);
  assert.equal(s.sections.cashflow.cashCollectedVnd, 200_000);
  assert.equal(s.sections.estimate.valueVnd, 100_000); // 180k net − 80k expense (NOT minus purchases)
  ok("RPT-01 hand-computed metrics exact");

  // ── Coverage: bills-without-items → partial (RPT-05/06) ──
  const items = s.coverage.sources.find((q) => q.sourceType === "order_items");
  assert.equal(items.expected, 3);
  assert.equal(items.processed, 2);
  assert.equal(items.status, "partial");
  assert.equal(s.coverage.overall, "partial");
  assert.equal(s.sections.sales.topCoverage, "partial");
  assert.ok(s.coverage.notes.some((n) => /bill cũ thiếu chi tiết dòng/.test(n)), "coverage note present");
  ok("RPT-05/06 coverage gap on bills-without-items, missing≠0");

  // ── Same-day parity vs the deployed F2 get_today_dashboard RPC ──
  const { data: dash, error } = await sb.rpc("get_today_dashboard", { p_merchant_id: merchantId, p_business_date: null });
  if (error) throw new Error("RPC: " + error.message);
  assert.equal(Number(dash.grossSalesAmount), s.sections.sales.grossVnd);
  assert.equal(Number(dash.refundAmount), s.sections.sales.refundVnd);
  assert.equal(Number(dash.netSalesAmount), s.sections.sales.netVnd);
  assert.equal(Number(dash.cashNetAmount), s.sections.sales.byChannel.find((c) => c.channel === "cash").netVnd);
  assert.equal(Number(dash.qrNetAmount), s.sections.sales.byChannel.find((c) => c.channel === "qr").netVnd);
  assert.equal(Number(dash.paidOrderCount), s.sections.sales.billCount);
  ok("same-day snapshot == get_today_dashboard (F2 parity)");

  // ── Idempotency: same key → same snapshot id, no new revision ──
  const again = await findOrBuildSnapshot(merchantId, userId, { preset: "day" }, "idem-build-1");
  assert.equal(again.snapshot.snapshot.id, s.snapshot.id);
  // find-or-build without rebuild also returns the existing ready snapshot
  const found = await findOrBuildSnapshot(merchantId, userId, { preset: "day" }, "idem-build-2");
  assert.equal(found.snapshot.snapshot.id, s.snapshot.id);
  assert.equal(found.snapshot.snapshot.revision, 1);
  ok("RPT-08 idempotent build: one key → one snapshot");

  // ── Drill-down sum parity (RPT-10) ──
  const dd = await drilldown(merchantId, s.snapshot.id, { metric: "sales_net_revenue" });
  assert.equal(dd.totalVnd, 200_000); // sum of eligible bills' totals == gross
  assert.equal(dd.totalCount, 3);
  assert.ok(dd.rows.every((r) => r.route?.startsWith("/don-hang/")));
  const ddExp = await drilldown(merchantId, s.snapshot.id, { metric: "operating_expense" });
  assert.equal(ddExp.totalVnd, 80_000);
  ok("RPT-10 drill-down totals reconcile to metric");

  // ── Rebuild after a new bill → new revision, old immutable (RPT-09) ──
  await paidOrder(merchantId, userId, `F13-${ts}-4`, 30_000, [{ pid: P2, name: "Bánh mì F13", qty: 1, price: 30_000 }], "cash");
  const rebuilt = await findOrBuildSnapshot(merchantId, userId, { preset: "day", rebuild: true }, "idem-rebuild-1");
  assert.equal(rebuilt.snapshot.snapshot.revision, 2);
  assert.equal(rebuilt.snapshot.sections.sales.grossVnd, 230_000);
  assert.equal(rebuilt.snapshot.snapshot.supersedesId, s.snapshot.id);
  // old snapshot values unchanged + status flipped to superseded
  const old = await getSnapshot(merchantId, s.snapshot.id);
  assert.equal(old.sections.sales.grossVnd, 200_000, "old snapshot immutable");
  assert.equal(old.snapshot.status, "superseded");
  assert.ok(old.snapshot.newer && old.snapshot.newer.id === rebuilt.snapshot.snapshot.id, "old points to newer");
  ok("RPT-09 restatement: new revision supersedes, old immutable");

  // ── Compare compatible snapshots (RPT-11) ──
  const cmp = await compareSnapshots(merchantId, s.snapshot.id, rebuilt.snapshot.snapshot.id);
  assert.equal(cmp.compatible, true);
  const g = cmp.rows.find((r) => r.code === "sales_gross_revenue");
  assert.equal(g.baseValue, 200_000);
  assert.equal(g.compareValue, 230_000);
  assert.equal(g.delta, 30_000);
  assert.equal(g.pct, 15);
  ok("RPT-11 compare compatible snapshots with delta + %");

  // ── Export parity (RPT-12) ──
  const exp = await createExport(merchantId, userId, s.snapshot.id, "csv");
  const file = await getExportFile(merchantId, s.snapshot.id, exp.id);
  assert.ok(file.csv.startsWith("﻿"), "CSV BOM");
  assert.match(file.csv, /200000/); // gross
  assert.match(file.csv, /180000/); // net
  assert.match(file.csv, /TẠM TÍNH/);
  const exp2 = await createExport(merchantId, userId, s.snapshot.id, "csv");
  assert.equal(exp2.id, exp.id, "export idempotent by (snapshot,type)");
  ok("RPT-12 export parity + idempotent export job");

  // ── Cross-tenant isolation (RPT-13) ──
  let denied = false;
  try { await getSnapshot(REAL[0], s.snapshot.id); } catch (e) { denied = e.code === "NOT_FOUND"; }
  assert.ok(denied, "cross-tenant getSnapshot blocked");
  ok("RPT-13 cross-tenant snapshot access blocked");

  console.log(`\nF13 E2E: ${pass}/9 checks passed ✅`);
}

main().then(() => closePool()).then(() => pool.end()).then(() => process.exit(0))
  .catch(async (e) => { console.error("\n❌ F13 E2E FAILED:", e.message); console.error(e.stack); try { await closePool(); await pool.end(); } catch {} process.exit(1); });
