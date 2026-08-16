// Live end-to-end regression for the F3 stale-payment hotfix.
//
// Bug: pressing "Tiếp tục thanh toán" on a NEW cart opened the payment screen
// showing an OLD awaiting_payment bill's total. Root cause: the client reused a
// client_request_id bound to an older order, so the server's idempotent
// createOrder replayed that order (old total) instead of building a new one; the
// payment screen then rendered the stale bill.
//
// This exercises the exact client sequence against the live server + DB:
//   cart A → lock (awaiting) → "Back"/navigate away
//   cart B → "Tiếp tục" → outstanding-bill probe MUST surface bill A (dialog)
//   both dialog choices ("pay that bill" / "cancel it & continue") end on the
//   CORRECT totals — never the stale one.
//
// NOT part of `npm test` (needs the live DB + running server). Run:
//   PORT=3001 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &
//   FIX_BASE=http://localhost:3001 node --env-file=.env test/fix-stale-payment-e2e.mjs
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureFixMerchant, REAL_MERCHANTS } from "./fix-stale-payment-setup.mjs";

const BASE = process.env.FIX_BASE || "http://localhost:3000";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let MID, UID, token;
async function api(method, path, { body, idem, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// The client's proceedToPayment helper, faithfully reproduced against the API.
async function createOrder(reqId, items) {
  const r = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: reqId, items } });
  if (r.status !== 201) throw new Error("createOrder: " + JSON.stringify(r.json));
  return r.json;
}
async function lock(orderId, version) {
  const r = await api("POST", `/v1/orders/${orderId}/lock`, { body: { expectedVersion: version } });
  if (r.status !== 200) throw new Error("lock: " + JSON.stringify(r.json));
  return r.json;
}
async function cancel(orderId, version) {
  const r = await api("POST", `/v1/orders/${orderId}/cancel`, { body: { expectedVersion: version } });
  if (r.status !== 200) throw new Error("cancel: " + JSON.stringify(r.json));
  return r.json;
}
async function outstanding(excludeOrderId) {
  const q = excludeOrderId ? `?excludeOrderId=${encodeURIComponent(excludeOrderId)}` : "";
  const r = await api("GET", `/v1/merchants/${MID}/outstanding-bill${q}`);
  if (r.status !== 200) throw new Error("outstanding: " + JSON.stringify(r.json));
  return r.json;
}

async function cleanMerchant() {
  const tables = [
    "inventory_movements", "payment_provider_events", "payment_refunds", "payments",
    "sales_return_items", "sales_returns", "order_adjustments", "order_items",
    "inventory_reservations", "receipts", "orders",
  ];
  for (const t of tables) await pool.query(`delete from public.${t} where merchant_id=$1`, [MID]);
}

async function main() {
  const s = await ensureFixMerchant();
  MID = s.merchantId; UID = s.userId; token = s.token;
  log(`Test user: ${s.email}  userId=${UID}\nTest merchant: ${MID}\nServer: ${BASE}`);
  if (REAL_MERCHANTS.includes(MID)) throw new Error("REFUSING: resolved a REAL merchant id");

  section("Setup: clean slate + product Bia 333 @ 20.000đ");
  await cleanMerchant();
  const pr = await api("POST", `/v1/merchants/${MID}/products/quick`, {
    idem: randomUUID(),
    body: { name: "Bia 333", salePrice: 20000, unitCode: "lon", trackInventory: true, initialStock: 100, lowStockThreshold: 2 },
  });
  if (pr.status !== 201) throw new Error("quick-create: " + JSON.stringify(pr.json));
  const bia = pr.json.product;
  ok("product created", !!bia.id);

  // ── ROOT-CAUSE documentation: idempotent replay returns the OLD total ───────
  section("Root cause: reusing a client_request_id replays the old order (stale total)");
  {
    const reqStale = randomUUID();
    const a = await createOrder(reqStale, [{ productId: bia.id, quantity: 1 }]);   // 20.000
    await lock(a.order.id, a.order.version);                                        // → awaiting
    // "New cart" but SAME id (the bug): server replays order A, ignoring 3 units.
    const replay = await createOrder(reqStale, [{ productId: bia.id, quantity: 3 }]);
    ok("createOrder replayed the SAME order", replay.order.id === a.order.id, `id=${replay.order.id}`);
    ok("replayed total is the STALE 20.000 (not 60.000)", replay.order.totalAmount === 20000, `total=${replay.order.totalAmount}`);
    // Cleanup this awaiting bill so it doesn't pollute later probes.
    await cancel(a.order.id, replay.order.version);
  }

  // ── GUARD: outstanding-bill probe surfaces the stale bill (drives the dialog) ─
  section("Guard: cart A locked → new cart B probe surfaces bill A");
  await cleanMerchant();
  let billA;
  {
    const a = await createOrder(randomUUID(), [{ productId: bia.id, quantity: 1 }]); // 20.000
    billA = await lock(a.order.id, a.order.version);
    ok("bill A awaiting_payment", billA.order.status === "awaiting_payment", billA.order.status);
    // New cart B: press Tiếp tục → probe (no current order yet).
    const probe = await outstanding(undefined);
    ok("probe returns bill A (dialog fires)", probe.order && probe.order.id === billA.order.id, `id=${probe.order?.id}`);
    ok("probe shows bill A total 20.000", probe.order?.totalAmount === 20000, `total=${probe.order?.totalAmount}`);
    // Excluding the current order id must NOT self-flag it.
    const selfProbe = await outstanding(billA.order.id);
    ok("excludeOrderId hides the current bill", selfProbe.order === null);
  }

  // ── PATH 1: "Hủy bill đó & tiếp tục giỏ mới" → lock cart B at 60.000 ─────────
  section("Path 1: cancel stale bill, continue new cart → correct total 60.000");
  {
    await cancel(billA.order.id, billA.order.version);       // releases reservations
    const cancelled = await sql(`select status from public.orders where id=$1`, [billA.order.id]);
    ok("bill A cancelled", cancelled[0].status === "cancelled");
    const resv = await sql(`select status from public.inventory_reservations where order_id=$1`, [billA.order.id]);
    ok("bill A reservations released", resv.every((r) => r.status !== "active"), `n=${resv.length}`);
    // Fresh id (what the client does), new cart B = 3 units.
    const b = await createOrder(randomUUID(), [{ productId: bia.id, quantity: 3 }]);
    const lockedB = await lock(b.order.id, b.order.version);
    ok("cart B is a NEW order", lockedB.order.id !== billA.order.id);
    ok("payment total = 60.000 (current cart, not stale 20.000)", lockedB.order.totalAmount === 60000, `total=${lockedB.order.totalAmount}`);
    await cancel(lockedB.order.id, lockedB.order.version); // tidy up
  }

  // ── PATH 2: "Thanh toán bill đó" → pay stale, then new cart keeps its total ──
  section("Path 2: pay the outstanding bill, then new cart locks at its own total");
  {
    await cleanMerchant();
    const c = await createOrder(randomUUID(), [{ productId: bia.id, quantity: 2 }]); // 40.000
    const lockedC = await lock(c.order.id, c.order.version);
    const probe = await outstanding(undefined);
    ok("probe surfaces bill C", probe.order?.id === lockedC.order.id);
    ok("bill C total 40.000", probe.order?.totalAmount === 40000, `total=${probe.order?.totalAmount}`);
    // Choose "pay that bill": finalize cash on C.
    const pay = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: lockedC.order.id, expectedVersion: lockedC.order.version, cashReceived: 40000 } });
    ok("bill C paid", pay.status === 200 && pay.json?.status === "succeeded", JSON.stringify(pay.json));
    // No outstanding bill remains (paid bill is not awaiting).
    const after = await outstanding(undefined);
    ok("no outstanding bill after paying C", after.order === null);
    // The current cart (kept intact) locks under a fresh id at ITS own total.
    const d = await createOrder(randomUUID(), [{ productId: bia.id, quantity: 5 }]); // 100.000
    const lockedD = await lock(d.order.id, d.order.version);
    ok("current cart locks at 100.000 (its own total)", lockedD.order.totalAmount === 100000, `total=${lockedD.order.totalAmount}`);
    await cancel(lockedD.order.id, lockedD.order.version);
  }

  log(`\n──────────── ${PASS} passed, ${FAIL} failed ────────────`);
  await pool.end();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("FATAL:", e); try { await pool.end(); } catch { /* noop */ } process.exit(1); });
