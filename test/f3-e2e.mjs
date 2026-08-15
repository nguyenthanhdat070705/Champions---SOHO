// Live end-to-end verification of the Functional 03 test matrix (spec 13.3).
// This is NOT part of `npm test` (it needs the live Supabase DB + PayOS + the
// running combined server). Run it manually:
//   PORT=3000 node --env-file=.env server/index.js &
//   node --env-file=.env test/f3-e2e.mjs
// It operates ONLY on its own throwaway merchant (soho-crew-test+f3@soho.test);
// it never reads-to-mutate or touches the two real seeded merchants.
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomUUID } from "node:crypto";

const BASE = process.env.F3_BASE || "http://localhost:3000";
const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
const EMAIL = "soho-crew-test+f3@soho.test";
const PASSWORD = "SohoF3Test!2026";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

// ── auth + api helpers ───────────────────────────────────────────────────────
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
let session, token, MID, UID;

async function api(method, path, { body, idem, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function dashboard(tk = token) {
  const authed = createClient(URL, KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${tk}` } } });
  const { data, error } = await authed.rpc("get_today_dashboard", { p_merchant_id: MID, p_business_date: null });
  if (error) throw new Error("dashboard rpc: " + error.message);
  return data;
}

async function movementsFor(orderId) {
  return sql(
    `select im.* from public.inventory_movements im
       where im.reference_id in (select id from public.order_items where order_id=$1)
          or im.reference_id in (select sri.id from public.sales_return_items sri
                                   join public.sales_returns sr on sr.id=sri.return_id where sr.order_id=$1)`,
    [orderId]);
}
async function onHand(productId) {
  const r = await sql(`select on_hand from public.inventory_levels where merchant_id=$1 and product_id=$2`, [MID, productId]);
  return r.length ? Number(r[0].on_hand) : null;
}
async function paymentsFor(orderId) {
  return sql(`select * from public.payments where order_id=$1`, [orderId]);
}

// Create a draft order via server, returns {orderId, version, total}.
async function newOrder(items) {
  const r = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items } });
  if (r.status !== 201) throw new Error("createOrder failed: " + JSON.stringify(r.json));
  return { orderId: r.json.order.id, version: r.json.order.version, total: r.json.order.totalAmount };
}

async function cleanMerchant() {
  // Delete ONLY this test merchant's rows, in FK-safe order.
  const tables = [
    "inventory_movements", "payment_provider_events", "payment_refunds", "payments",
    "sales_return_items", "sales_returns", "order_adjustments", "order_items",
    "inventory_reservations", "receipts", "ai_transaction_suggestions", "e_invoice_jobs",
    "integration_outbox", "audit_logs", "orders", "action_items", "inventory_levels", "products",
  ];
  for (const t of tables) {
    await pool.query(`delete from public.${t} where merchant_id=$1`, [MID]);
  }
}

async function main() {
  const si = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (si.error) throw new Error("signin: " + si.error.message);
  session = si.data.session; token = session.access_token; UID = session.user.id;
  const m = await sql(`select mm.merchant_id from public.merchant_members mm where mm.user_id=$1 and mm.status='active' order by mm.created_at limit 1`, [UID]);
  MID = m[0].merchant_id;
  log(`Test user: ${EMAIL}  userId=${UID}\nTest merchant: ${MID}\nServer: ${BASE}`);

  // Safety: never operate on a real merchant.
  const real = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];
  if (real.includes(MID)) throw new Error("REFUSING: test merchant resolved to a REAL merchant id");

  section("Setup: clean slate + quick-create products (FR-03)");
  await cleanMerchant();
  const mkProd = async (name, price, stock, track = true) => {
    const r = await api("POST", `/v1/merchants/${MID}/products/quick`, {
      idem: randomUUID(),
      body: { name, salePrice: price, unitCode: "item", trackInventory: track, initialStock: stock, lowStockThreshold: 2 },
    });
    if (r.status !== 201) throw new Error("quick-create failed: " + JSON.stringify(r.json));
    return r.json.product;
  };
  const water = await mkProdOrDie(mkProd, "Nước suối", 10000, 20);
  const cake = await mkProdOrDie(mkProd, "Bánh ngọt", 15000, 10);
  const coffee = await mkProdOrDie(mkProd, "Cà phê", 20000, 1); // last-unit for INV-01
  ok("quick-create 3 products", water && cake && coffee, `water on_hand=${await onHand(water.id)}`);

  // ── SALE-01 ────────────────────────────────────────────────────────────────
  section("SALE-01: 1 product cash, exact money");
  {
    const beforeStock = await onHand(water.id);
    const o = await newOrder([{ productId: water.id, quantity: 1 }]);
    const r = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version, cashReceived: o.total } });
    ok("cash finalize 200", r.status === 200, JSON.stringify(r.json));
    ok("payment succeeded", r.json?.status === "succeeded");
    ok("change_due = 0", r.json?.changeDue === 0);
    const ord = await sql(`select status, paid_at from public.orders where id=$1`, [o.orderId]);
    ok("order paid + paid_at set", ord[0].status === "paid" && ord[0].paid_at, ord[0].status);
    ok("stock -1", (await onHand(water.id)) === beforeStock - 1, `${beforeStock} → ${await onHand(water.id)}`);
    const mv = await movementsFor(o.orderId);
    ok("one sale movement", mv.length === 1 && mv[0].movement_type === "sale" && Number(mv[0].quantity_delta) === -1);
  }

  // ── SALE-02 ────────────────────────────────────────────────────────────────
  section("SALE-02: cash, customer pays more → change_due; revenue = total only");
  let sale02Order;
  {
    const o = await newOrder([{ productId: water.id, quantity: 2 }, { productId: cake.id, quantity: 1 }]);
    ok("total = 35.000", o.total === 35000, `total=${o.total}`);
    const r = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version, cashReceived: 50000 } });
    ok("change_due = 15.000", r.json?.changeDue === 15000, JSON.stringify(r.json));
    const pay = await paymentsFor(o.orderId);
    ok("payment.amount = total (not received)", Number(pay[0].amount) === 35000 && Number(pay[0].cash_received) === 50000);
    sale02Order = o.orderId;
  }

  // ── SALE-03 double tap ──────────────────────────────────────────────────────
  section("SALE-03: double-tap cash → one payment / one movement / same response");
  {
    const o = await newOrder([{ productId: cake.id, quantity: 1 }]);
    const idem = randomUUID();
    const body = { merchantId: MID, orderId: o.orderId, expectedVersion: o.version, cashReceived: 15000 };
    const [a, b] = await Promise.all([
      api("POST", "/v1/payments/cash", { idem, body }),
      api("POST", "/v1/payments/cash", { idem, body }),
    ]);
    ok("both 200", a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
    ok("same paymentId", a.json?.paymentId && a.json.paymentId === b.json?.paymentId, `${a.json?.paymentId} / ${b.json?.paymentId}`);
    const pays = await paymentsFor(o.orderId);
    ok("exactly one payment row", pays.length === 1, `rows=${pays.length}`);
    const mv = await movementsFor(o.orderId);
    ok("exactly one movement", mv.length === 1, `rows=${mv.length}`);
  }

  // ── SALE-04 price change ────────────────────────────────────────────────────
  section("SALE-04: price changes before checkout → 409 PRICE_CHANGED, no charge");
  {
    const o = await newOrder([{ productId: water.id, quantity: 1 }]);
    // Change the product price (privileged, our own test merchant's product).
    await pool.query(`update public.products set sale_price=12000, updated_at=now() where id=$1`, [water.id]);
    const r = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version, cashReceived: 20000 } });
    ok("409 PRICE_CHANGED", r.status === 409 && r.json?.code === "PRICE_CHANGED", JSON.stringify(r.json));
    const pays = await paymentsFor(o.orderId);
    ok("no payment created", pays.length === 0);
    // restore price
    await pool.query(`update public.products set sale_price=10000, updated_at=now() where id=$1`, [water.id]);
    await api("POST", `/v1/orders/${o.orderId}/cancel`, { body: { expectedVersion: o.version } });
  }

  // ── INV-01 concurrent last unit ─────────────────────────────────────────────
  section("INV-01: two buyers race for the last unit → one paid, one INSUFFICIENT_STOCK");
  {
    ok("coffee stock = 1 pre", (await onHand(coffee.id)) === 1);
    const o1 = await newOrder([{ productId: coffee.id, quantity: 1 }]);
    const o2 = await newOrder([{ productId: coffee.id, quantity: 1 }]);
    const [a, b] = await Promise.all([
      api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o1.orderId, expectedVersion: o1.version, cashReceived: 20000 } }),
      api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o2.orderId, expectedVersion: o2.version, cashReceived: 20000 } }),
    ]);
    const statuses = [a, b];
    const succeeded = statuses.filter((r) => r.status === 200 && r.json?.status === "succeeded").length;
    const insufficient = statuses.filter((r) => r.status === 409 && r.json?.code === "INSUFFICIENT_STOCK").length;
    ok("exactly one success", succeeded === 1, `succeeded=${succeeded}`);
    ok("exactly one INSUFFICIENT_STOCK", insufficient === 1, `insufficient=${insufficient}`);
    ok("stock now 0 (never negative)", (await onHand(coffee.id)) === 0);
  }

  // ── QR-01 + QR-03 ────────────────────────────────────────────────────────────
  section("QR-01: real PayOS create + dev-simulate confirm → paid once");
  let qrOrder, qrPaymentId, qrRef;
  {
    const o = await newOrder([{ productId: cake.id, quantity: 1 }]);
    qrOrder = o.orderId;
    const r = await api("POST", "/v1/payments/qr", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version } });
    ok("QR create 201 pending", r.status === 201 && r.json?.status === "pending", JSON.stringify({ s: r.status, st: r.json?.status }));
    ok("QR payload present (real PayOS)", !!r.json?.qrPayload, r.json?.qrPayload ? "qrCode len " + r.json.qrPayload.length : "MISSING");
    qrPaymentId = r.json.paymentId;
    const beforeStock = await onHand(cake.id);
    qrRef = "SIMREF-" + Date.now();
    const sim = await api("POST", "/v1/dev/payos/simulate", { body: { paymentId: qrPaymentId, reference: qrRef } });
    ok("simulate confirm handled", sim.status === 200 && sim.json?.status === "succeeded", JSON.stringify(sim.json));
    const ord = await sql(`select status from public.orders where id=$1`, [o.orderId]);
    ok("order paid via webhook path", ord[0].status === "paid");
    ok("stock -1 after QR paid", (await onHand(cake.id)) === beforeStock - 1);
    const pays = await paymentsFor(o.orderId);
    ok("payment succeeded, one row", pays.length === 1 && pays[0].status === "succeeded");
  }

  section("QR-03: duplicate webhook ×5 → one movement, idempotent 2xx");
  {
    for (let i = 0; i < 5; i++) {
      const sim = await api("POST", "/v1/dev/payos/simulate", { body: { paymentId: qrPaymentId, reference: qrRef } });
      ok(`duplicate #${i + 1} returns 2xx`, sim.status === 200);
    }
    const mv = await movementsFor(qrOrder);
    ok("still exactly one sale movement", mv.filter((m) => m.movement_type === "sale").length === 1, `sale movements=${mv.filter((m) => m.movement_type === "sale").length}`);
    const pays = await paymentsFor(qrOrder);
    ok("still one succeeded payment", pays.length === 1 && pays[0].status === "succeeded");
  }

  section("QR-02: wrong amount webhook → not paid + action item");
  {
    const o = await newOrder([{ productId: water.id, quantity: 1 }]);
    const r = await api("POST", "/v1/payments/qr", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version } });
    const sim = await api("POST", "/v1/dev/payos/simulate", { body: { paymentId: r.json.paymentId, amount: 999, reference: "BAD-" + Date.now() } });
    ok("amount mismatch rejected (not paid)", sim.json?.status === "rejected", JSON.stringify(sim.json));
    const ord = await sql(`select status from public.orders where id=$1`, [o.orderId]);
    ok("order NOT paid", ord[0].status !== "paid", ord[0].status);
    const acts = await sql(`select * from public.action_items where merchant_id=$1 and status='open' and action_type='payment_provider'`, [MID]);
    ok("action item raised", acts.length >= 1);
    await api("POST", `/v1/payments/${r.json.paymentId}/cancel`, { body: { reason: "test" } });
  }

  // ── RET-01 restockable ───────────────────────────────────────────────────────
  section("RET-01: return still-sellable item → refund succeeded, stock +qty");
  {
    const beforeStock = await onHand(water.id);
    // sale02Order had 2 water + 1 cake, paid. Return 1 water restockable, cash.
    const oiWater = (await sql(`select id from public.order_items where order_id=$1 and product_id=$2`, [sale02Order, water.id]))[0].id;
    const prev = await api("POST", `/v1/orders/${sale02Order}/returns/preview`, { body: { items: [{ orderItemId: oiWater, quantity: 1, condition: "restockable" }] } });
    ok("return preview refundable", prev.json?.refundTotal === 10000, JSON.stringify(prev.json));
    const r = await api("POST", `/v1/orders/${sale02Order}/returns`, { idem: randomUUID(), body: { items: [{ orderItemId: oiWater, quantity: 1, condition: "restockable" }], reasonCode: "customer_change", refundMethod: "cash" } });
    ok("return 201, refund succeeded", r.status === 201 && r.json?.refundStatus === "succeeded", JSON.stringify(r.json));
    ok("stock +1 (restocked)", (await onHand(water.id)) === beforeStock + 1, `${beforeStock} → ${await onHand(water.id)}`);
    const ref = await sql(`select status, refunded_at from public.payment_refunds where id=$1`, [r.json.refundId]);
    ok("refund row succeeded + refunded_at", ref[0].status === "succeeded" && ref[0].refunded_at);
  }

  // ── RET-02 damaged ────────────────────────────────────────────────────────────
  section("RET-02: return damaged item → refund succeeded, NO restock, damage_writeoff");
  {
    const beforeStock = await onHand(cake.id);
    const oiCake = (await sql(`select id from public.order_items where order_id=$1 and product_id=$2`, [sale02Order, cake.id]))[0].id;
    const r = await api("POST", `/v1/orders/${sale02Order}/returns`, { idem: randomUUID(), body: { items: [{ orderItemId: oiCake, quantity: 1, condition: "damaged" }], reasonCode: "defective", refundMethod: "cash" } });
    ok("return 201 refund succeeded", r.status === 201 && r.json?.refundStatus === "succeeded", JSON.stringify(r.json));
    ok("stock unchanged (not restocked)", (await onHand(cake.id)) === beforeStock, `${beforeStock} → ${await onHand(cake.id)}`);
    const dmg = await sql(`select * from public.inventory_movements where merchant_id=$1 and product_id=$2 and movement_type='damage_writeoff'`, [MID, cake.id]);
    ok("damage_writeoff movement exists", dmg.length >= 1);
  }

  // ── RET-03 pending transfer ────────────────────────────────────────────────────
  section("RET-03: bank_transfer refund pending → dashboard net unchanged until confirm");
  {
    // fresh dedicated paid bill so we can measure net delta cleanly
    const o = await newOrder([{ productId: water.id, quantity: 1 }]);
    await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o.orderId, expectedVersion: o.version, cashReceived: 10000 } });
    const before = await dashboard();
    const oi = (await sql(`select id from public.order_items where order_id=$1`, [o.orderId]))[0].id;
    const r = await api("POST", `/v1/orders/${o.orderId}/returns`, { idem: randomUUID(), body: { items: [{ orderItemId: oi, quantity: 1, condition: "restockable" }], reasonCode: "customer_change", refundMethod: "bank_transfer" } });
    ok("refund pending", r.json?.refundStatus === "pending", JSON.stringify(r.json));
    const mid1 = await dashboard();
    ok("net unchanged while pending", mid1.netSalesAmount === before.netSalesAmount, `before=${before.netSalesAmount} pending=${mid1.netSalesAmount}`);
    const conf = await api("POST", `/v1/refunds/${r.json.refundId}/confirm`, { body: { reference: "MB-TX-123" } });
    ok("confirm 200 succeeded", conf.status === 200 && conf.json?.status === "succeeded", JSON.stringify(conf.json));
    const after = await dashboard();
    ok("net reduced by refund after confirm", after.netSalesAmount === before.netSalesAmount - 10000, `before=${before.netSalesAmount} after=${after.netSalesAmount}`);
  }

  // ── RET-04 over-refund ─────────────────────────────────────────────────────────
  section("RET-04: over-refund qty rejected");
  {
    const oi = (await sql(`select id, quantity from public.order_items where order_id=$1 and product_id=$2`, [sale02Order, water.id]))[0];
    const r = await api("POST", `/v1/orders/${sale02Order}/returns`, { idem: randomUUID(), body: { items: [{ orderItemId: oi.id, quantity: 99, condition: "restockable" }], reasonCode: "customer_change", refundMethod: "cash" } });
    ok("REFUND_EXCEEDS_AVAILABLE", r.status === 409 && r.json?.code === "REFUND_EXCEEDS_AVAILABLE", JSON.stringify(r.json));
  }

  // ── RLS-01 cross-tenant ─────────────────────────────────────────────────────────
  section("RLS-01: cross-tenant read/write blocked");
  {
    const realMerchant = "4e63a397-e811-48b1-86e5-d7fc5ffa9f0e";
    const realOrder = (await sql(`select id from public.orders where merchant_id=$1 limit 1`, [realMerchant]))[0]?.id;
    // write attempt on another tenant's merchant → FORBIDDEN (no mutation happens)
    const w = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: realMerchant, orderId: realOrder, expectedVersion: 1, cashReceived: 1000 } });
    ok("cross-tenant cash → 403 FORBIDDEN", w.status === 403 && w.json?.code === "FORBIDDEN", JSON.stringify({ s: w.status, c: w.json?.code }));
    // read another tenant's order via server → FORBIDDEN
    const rd = await api("GET", `/v1/orders/${realOrder}`);
    ok("cross-tenant order read → 403", rd.status === 403, JSON.stringify({ s: rd.status }));
    // supabase-js select under RLS returns 0 rows
    const authed = createClient(URL, KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data } = await authed.from("orders").select("id").eq("merchant_id", realMerchant).limit(5);
    ok("RLS select of other tenant → 0 rows", (data?.length ?? 0) === 0, `rows=${data?.length ?? 0}`);
  }

  // ── Dashboard reconciliation (DoD) ────────────────────────────────────────────
  section("Dashboard reconciliation: F2 RPC == F3 ledger");
  {
    const snap = await dashboard();
    // Reconstruct the RPC's business-day window: HCM-midnight → +1 day as timestamptz.
    const win = `(timezone('Asia/Ho_Chi_Minh', now()))::date::timestamp at time zone 'Asia/Ho_Chi_Minh'`;
    const winEnd = `(((timezone('Asia/Ho_Chi_Minh', now()))::date::timestamp) + interval '1 day') at time zone 'Asia/Ho_Chi_Minh'`;
    const g = await sql(`select coalesce(sum(total_amount),0) as gross, count(*) as cnt from public.orders where merchant_id=$1 and status in ('paid','refunded') and paid_at >= ${win} and paid_at < ${winEnd}`, [MID]);
    const rf = await sql(`select coalesce(sum(amount),0) as refund from public.payment_refunds where merchant_id=$1 and status='succeeded' and refunded_at >= ${win} and refunded_at < ${winEnd}`, [MID]);
    const gross = Number(g[0].gross), refund = Number(rf[0].refund);
    ok("gross matches", snap.grossSalesAmount === gross, `rpc=${snap.grossSalesAmount} sql=${gross}`);
    ok("refund matches", snap.refundAmount === refund, `rpc=${snap.refundAmount} sql=${refund}`);
    ok("net = gross - refund", snap.netSalesAmount === gross - refund, `rpc=${snap.netSalesAmount}`);
    ok("paid order count matches", snap.paidOrderCount === Number(g[0].cnt), `rpc=${snap.paidOrderCount} sql=${g[0].cnt}`);
    log(`  dashboard: gross=${snap.grossSalesAmount} refund=${snap.refundAmount} net=${snap.netSalesAmount} cash=${snap.cashNetAmount} qr=${snap.qrNetAmount} bills=${snap.paidOrderCount}`);
  }

  log(`\n──────────────────────────────\nRESULT: ${PASS} passed, ${FAIL} failed`);
  await pool.end();
  process.exit(FAIL === 0 ? 0 : 1);
}

async function mkProdOrDie(mkProd, name, price, stock) {
  const p = await mkProd(name, price, stock);
  if (!p?.id) throw new Error("product create failed: " + name);
  return p;
}

main().catch((e) => { console.error("E2E CRASHED:", e); process.exit(2); });
