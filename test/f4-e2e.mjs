// Live end-to-end verification of the Functional 04 test matrix (spec 12.3 P0
// rows). NOT part of `npm test` (needs the live Supabase DB + the running combined
// server). Run:
//   PORT=3007 node --env-file=.env server/index.js &
//   F4_BASE=http://localhost:3007 node --env-file=.env test/f4-e2e.mjs
// Operates ONLY on its own throwaway merchant (soho-crew-test+f4@soho.test); it
// never mutates the two real seeded merchants.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureF4Merchant } from "./f4-setup.mjs";

const BASE = process.env.F4_BASE || "http://localhost:3007";
const REAL_MERCHANTS = ["4e63a397-e811-48b1-86e5-d7fc5ffa9f0e", "830effcb-2d6b-4e99-9b0f-07471755e60d"];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let token, MID, UID;
async function api(method, path, { body, idem, ifMatch, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  if (ifMatch != null) headers["If-Match"] = String(ifMatch);
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function cleanMerchant() {
  const tables = [
    "inventory_movements", "payment_provider_events", "payment_refunds", "payments",
    "sales_return_items", "sales_returns", "order_adjustments", "order_items",
    "inventory_reservations", "receipts", "ai_transaction_suggestions", "ai_product_suggestions",
    "product_price_history", "integration_outbox", "audit_logs", "orders", "action_items",
    "inventory_levels", "products", "product_categories",
  ];
  for (const t of tables) await pool.query(`delete from public.${t} where merchant_id=$1`, [MID]);
}

async function createProduct(body, idem = randomUUID()) {
  return api("POST", `/v1/merchants/${MID}/products`, { idem, body });
}

async function main() {
  const boot = await ensureF4Merchant();
  MID = boot.merchantId; UID = boot.userId; token = boot.token;
  if (REAL_MERCHANTS.includes(MID)) throw new Error("REFUSING: resolved a REAL merchant id");
  log(`Test user: ${boot.email}\nMerchant: ${MID}\nServer: ${BASE}`);

  section("Setup: clean slate");
  await cleanMerchant();
  ok("clean", (await sql(`select count(*)::int c from public.products where merchant_id=$1`, [MID]))[0].c === 0);

  // ── PRD-01 ────────────────────────────────────────────────────────────────
  section("PRD-01: goods + opening stock → 1 product + 1 opening movement");
  let waterId;
  {
    const r = await createProduct({ draft_id: randomUUID(), name: "Nước suối 500ml", productType: "goods", unitCode: "chai", salePrice: 10000, trackInventory: true, openingQty: 24, lowStockThreshold: 5, sku: "NS500" });
    ok("create 201", r.status === 201, JSON.stringify(r.json).slice(0, 120));
    waterId = r.json?.product?.id;
    ok("status active + is_active", r.json?.product?.status === "active" && r.json?.product?.isActive === true);
    ok("onHand = 24", r.json?.product?.onHand === 24);
    const mv = await sql(`select movement_type, quantity_delta, balance_after from public.inventory_movements where product_id=$1`, [waterId]);
    ok("exactly 1 opening movement", mv.length === 1 && mv[0].movement_type === "opening" && Number(mv[0].quantity_delta) === 24 && Number(mv[0].balance_after) === 24, JSON.stringify(mv));
    const ph = await sql(`select price_vnd from public.product_price_history where product_id=$1`, [waterId]);
    ok("1 price-history row = 10000", ph.length === 1 && Number(ph[0].price_vnd) === 10000);
    const sn = await sql(`select search_name from public.products where id=$1`, [waterId]);
    ok("search_name unaccented", sn[0].search_name === "nuoc suoi 500ml", sn[0].search_name);
    const aud = await sql(`select action from public.audit_logs where entity_id=$1 and action='product.created'`, [waterId]);
    ok("audit product.created", aud.length === 1);
  }

  // ── PRD-02 ────────────────────────────────────────────────────────────────
  section("PRD-02: service with track_inventory via API → 422, no insert");
  {
    const before = (await sql(`select count(*)::int c from public.products where merchant_id=$1`, [MID]))[0].c;
    const r = await createProduct({ draft_id: randomUUID(), name: "Giặt ủi", productType: "service", unitCode: "lan", salePrice: 20000, trackInventory: true });
    ok("422", r.status === 422, `${r.status} ${r.json?.code}`);
    ok("code SERVICE_NO_INVENTORY", r.json?.code === "SERVICE_NO_INVENTORY");
    const after = (await sql(`select count(*)::int c from public.products where merchant_id=$1`, [MID]))[0].c;
    ok("no insert", after === before);
  }

  // ── PRD-03 ────────────────────────────────────────────────────────────────
  section("PRD-03: two devices create same barcode → one 201, one 409");
  {
    const barcode = "8938500700" + String(Math.floor(Date.now() / 1000)).slice(-3);
    const [a, b] = await Promise.all([
      createProduct({ draft_id: randomUUID(), name: "Bánh A", productType: "goods", unitCode: "goi", salePrice: 12000, trackInventory: false, barcode }),
      createProduct({ draft_id: randomUUID(), name: "Bánh B", productType: "goods", unitCode: "goi", salePrice: 13000, trackInventory: false, barcode }),
    ]);
    const statuses = [a.status, b.status].sort();
    ok("one 201 one 409", statuses[0] === 201 && statuses[1] === 409, `${a.status}/${b.status}`);
    const conflict = a.status === 409 ? a : b;
    ok("code PRODUCT_BARCODE_CONFLICT", conflict.json?.code === "PRODUCT_BARCODE_CONFLICT");
    ok("existing_product_id present", Boolean(conflict.json?.details?.existing_product_id));
  }

  // ── PRD-04 ────────────────────────────────────────────────────────────────
  section("PRD-04: double-tap same Idempotency-Key + same body → one product_id");
  {
    const idem = randomUUID();
    const body = { draft_id: randomUUID(), name: "Cà phê sữa", productType: "goods", unitCode: "lan", salePrice: 25000, trackInventory: false };
    const [a, b] = await Promise.all([
      api("POST", `/v1/merchants/${MID}/products`, { idem, body }),
      api("POST", `/v1/merchants/${MID}/products`, { idem, body }),
    ]);
    ok("both ok (201/200)", [a.status, b.status].every((s) => s === 200 || s === 201), `${a.status}/${b.status}`);
    ok("same product id", a.json?.product?.id && a.json.product.id === b.json?.product?.id, `${a.json?.product?.id} / ${b.json?.product?.id}`);
    const cnt = (await sql(`select count(*)::int c from public.products where merchant_id=$1 and name='Cà phê sữa'`, [MID]))[0].c;
    ok("exactly one row created", cnt === 1, `count=${cnt}`);
    // same key, DIFFERENT body → 409
    const mism = await api("POST", `/v1/merchants/${MID}/products`, { idem, body: { ...body, salePrice: 30000 } });
    ok("mismatch body → 409", mism.status === 409 && mism.json?.code === "IDEMPOTENCY_PAYLOAD_MISMATCH", `${mism.status} ${mism.json?.code}`);
  }

  // ── PRD-05 ────────────────────────────────────────────────────────────────
  section("PRD-05: edit price → old bill keeps its snapshot");
  {
    // Sell 1 water at 10000 via F3 order+cash, then bump the price to 12000.
    const o = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: waterId, quantity: 1 }] } });
    ok("order created", o.status === 201, JSON.stringify(o.json).slice(0, 120));
    const orderId = o.json.order.id;
    const snapBefore = (await sql(`select unit_price from public.order_items where order_id=$1`, [orderId]))[0];
    ok("order_item snapshot = 10000", Number(snapBefore.unit_price) === 10000);
    const pay = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId, expectedVersion: o.json.order.version, cashReceived: 10000 } });
    ok("paid", pay.json?.status === "succeeded");
    // now edit price
    const cur = await api("GET", `/v1/merchants/${MID}/products/${waterId}`);
    const rv = cur.json.product.rowVersion;
    const upd = await api("PATCH", `/v1/merchants/${MID}/products/${waterId}`, { ifMatch: rv, body: { salePrice: 12000 } });
    ok("price patched", upd.status === 200 && upd.json?.product?.salePrice === 12000, JSON.stringify(upd.json).slice(0, 120));
    const snapAfter = (await sql(`select unit_price from public.order_items where order_id=$1`, [orderId]))[0];
    ok("old bill snapshot UNCHANGED = 10000", Number(snapAfter.unit_price) === 10000);
    const ph = await sql(`select price_vnd from public.product_price_history where product_id=$1 order by effective_from`, [waterId]);
    ok("price history has 10000 then 12000", ph.length === 2 && Number(ph[0].price_vnd) === 10000 && Number(ph[1].price_vnd) === 12000, JSON.stringify(ph.map((x) => Number(x.price_vnd))));
  }

  // ── PRD-06 ────────────────────────────────────────────────────────────────
  section("PRD-06: deactivate → hidden from default POS list");
  {
    const cur = await api("GET", `/v1/merchants/${MID}/products/${waterId}`);
    const st = await api("POST", `/v1/merchants/${MID}/products/${waterId}/status`, { body: { action: "deactivate", expectedVersion: cur.json.product.rowVersion, reason: "hết mùa" } });
    ok("deactivated", st.status === 200 && st.json?.product?.status === "inactive" && st.json?.product?.isActive === false);
    const posList = await api("GET", `/v1/merchants/${MID}/products`); // no status → active only
    ok("not in default POS list", !posList.json.products.some((p) => p.id === waterId));
    const inactiveList = await api("GET", `/v1/merchants/${MID}/products?status=inactive`);
    ok("in inactive filter", inactiveList.json.products.some((p) => p.id === waterId));
    // reactivate for later
    const cur2 = await api("GET", `/v1/merchants/${MID}/products/${waterId}`);
    await api("POST", `/v1/merchants/${MID}/products/${waterId}/status`, { body: { action: "activate", expectedVersion: cur2.json.product.rowVersion } });
  }

  // ── PRD-07 ────────────────────────────────────────────────────────────────
  section("PRD-07: archive a sold product → FK/bill intact");
  {
    const cur = await api("GET", `/v1/merchants/${MID}/products/${waterId}`);
    const st = await api("POST", `/v1/merchants/${MID}/products/${waterId}/status`, { body: { action: "archive", expectedVersion: cur.json.product.rowVersion } });
    ok("archived", st.status === 200 && st.json?.product?.status === "archived");
    const items = await sql(`select oi.id from public.order_items oi where oi.product_id=$1`, [waterId]);
    ok("order_items still reference product", items.length >= 1);
    const stillThere = await sql(`select status from public.products where id=$1`, [waterId]);
    ok("product row not deleted", stillThere.length === 1 && stillThere[0].status === "archived");
    const defList = await api("GET", `/v1/merchants/${MID}/products`);
    ok("archived hidden from default list", !defList.json.products.some((p) => p.id === waterId));
  }

  // ── PRD-08 ────────────────────────────────────────────────────────────────
  section("PRD-08: cross-tenant read blocked (RLS/membership guard)");
  {
    const r = await api("GET", `/v1/merchants/${REAL_MERCHANTS[0]}/products`);
    ok("403 FORBIDDEN on other merchant", r.status === 403 && r.json?.code === "FORBIDDEN", `${r.status} ${r.json?.code}`);
  }

  // ── PRD-12 ────────────────────────────────────────────────────────────────
  section("PRD-12: PATCH with stale row_version → 409 + current snapshot");
  {
    const p = await createProduct({ draft_id: randomUUID(), name: "Trà đào", productType: "goods", unitCode: "lan", salePrice: 30000, trackInventory: false });
    const id = p.json.product.id;
    const rv = p.json.product.rowVersion;
    await api("PATCH", `/v1/merchants/${MID}/products/${id}`, { ifMatch: rv, body: { salePrice: 32000 } }); // bumps to rv+1
    const stale = await api("PATCH", `/v1/merchants/${MID}/products/${id}`, { ifMatch: rv, body: { salePrice: 35000 } });
    ok("409 VERSION_CONFLICT", stale.status === 409 && stale.json?.code === "VERSION_CONFLICT", `${stale.status} ${stale.json?.code}`);
    ok("current snapshot returned", stale.json?.details?.currentProduct?.salePrice === 32000, JSON.stringify(stale.json?.details?.currentProduct?.salePrice));
  }

  // ── PRD-15 ────────────────────────────────────────────────────────────────
  section("PRD-15: change barcode → audit before/after");
  {
    const p = await createProduct({ draft_id: randomUUID(), name: "Kẹo dừa", productType: "goods", unitCode: "goi", salePrice: 5000, trackInventory: false, barcode: "8930000000001" });
    const id = p.json.product.id;
    const upd = await api("PATCH", `/v1/merchants/${MID}/products/${id}`, { ifMatch: p.json.product.rowVersion, body: { barcode: "8930000000999" } });
    ok("barcode patched", upd.status === 200 && upd.json?.product?.barcode === "8930000000999");
    const aud = await sql(`select before_data, after_data from public.audit_logs where entity_id=$1 and action='product.barcode_changed'`, [id]);
    ok("barcode audit before/after", aud.length === 1 && aud[0].before_data.barcode === "8930000000001" && aud[0].after_data.barcode === "8930000000999", JSON.stringify(aud[0] || {}));
  }

  // ── PRD-11 (search) + categories + barcode lookup ─────────────────────────
  section("PRD-11 + categories + barcode lookup");
  {
    const s = await api("GET", `/v1/merchants/${MID}/products?search=${encodeURIComponent("tra dao")}&status=all`);
    ok("unaccented search finds 'Trà đào'", s.json.products.some((p) => p.name === "Trà đào"), `${s.json.products.length} hits`);
    const cat = await api("POST", `/v1/merchants/${MID}/categories`, { body: { name: "Đồ uống" } });
    ok("category created", cat.status === 201 && cat.json?.category?.name === "Đồ uống");
    const dup = await api("POST", `/v1/merchants/${MID}/categories`, { body: { name: "Đồ uống" } });
    ok("double-tap category → replay same id", dup.json?.category?.id === cat.json.category.id && dup.json?.replayed === true);
    const list = await api("GET", `/v1/merchants/${MID}/categories`);
    ok("category listed", list.json.categories.some((c) => c.id === cat.json.category.id));
    const rn = await api("PATCH", `/v1/merchants/${MID}/categories/${cat.json.category.id}`, { body: { name: "Nước giải khát" } });
    ok("category renamed", rn.status === 200 && rn.json?.category?.name === "Nước giải khát");
    // barcode lookup
    const bl = await api("GET", `/v1/merchants/${MID}/products/barcode/8930000000999`);
    ok("barcode lookup finds product", bl.status === 200 && bl.json?.product?.name === "Kẹo dừa");
    const bl404 = await api("GET", `/v1/merchants/${MID}/products/barcode/0000000000000`);
    ok("unknown barcode → 404", bl404.status === 404 && bl404.json?.code === "PRODUCT_NOT_FOUND");
  }

  log(`\n──────── ${PASS} passed, ${FAIL} failed ────────`);
  await pool.end();
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch {} process.exit(1); });
