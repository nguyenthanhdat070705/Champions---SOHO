// Live end-to-end verification of the Functional 05 test matrix (spec 12.3 P0).
// NOT part of `npm test` (needs the live Supabase DB + the running combined
// server). Run:
//   PORT=3009 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &
//   F5_BASE=http://localhost:3009 node --env-file=.env test/f5-e2e.mjs
// Operates ONLY on its own throwaway merchant (soho-crew-test+f5@soho.test).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureF5Merchant, REAL_MERCHANTS } from "./f5-setup.mjs";

const BASE = process.env.F5_BASE || "http://localhost:3009";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let token, MID, UID;
async function api(method, path, { body, idem, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const onHand = async (pid) => Number((await sql(`select coalesce(on_hand,0) c from public.inventory_levels where merchant_id=$1 and product_id=$2`, [MID, pid]))[0]?.c ?? 0);
const moveCount = async (pid, type) => Number((await sql(`select count(*)::int c from public.inventory_movements where merchant_id=$1 and product_id=$2 ${type ? "and movement_type=$3" : ""}`, type ? [MID, pid, type] : [MID, pid]))[0].c);

async function cleanMerchant() {
  const tables = [
    "inventory_movements", "inventory_count_items", "inventory_count_sessions",
    "payment_provider_events", "payment_refunds", "payments",
    "sales_return_items", "sales_returns", "order_adjustments", "order_items",
    "inventory_reservations", "receipts", "ai_transaction_suggestions", "ai_product_suggestions",
    "product_price_history", "integration_outbox", "audit_logs", "orders", "action_items",
    "inventory_levels", "products", "product_categories",
  ];
  for (const t of tables) await pool.query(`delete from public.${t} where merchant_id=$1`, [MID]);
}

async function createGoods(name, opening, price, extra = {}) {
  const r = await api("POST", `/v1/merchants/${MID}/products`, {
    idem: randomUUID(),
    body: { draft_id: randomUUID(), name, productType: "goods", unitCode: "chai", salePrice: price, trackInventory: true, openingQty: opening, ...extra },
  });
  return r.json?.product?.id;
}
async function sellAndPay(pid, qty, idem = randomUUID()) {
  const o = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: pid, quantity: qty }] } });
  const orderId = o.json.order.id;
  const pay = await api("POST", "/v1/payments/cash", { idem, body: { merchantId: MID, orderId, expectedVersion: o.json.order.version, cashReceived: 999999 } });
  return { orderId, pay };
}

async function main() {
  const boot = await ensureF5Merchant();
  MID = boot.merchantId; UID = boot.userId; token = boot.token;
  if (REAL_MERCHANTS.includes(MID)) throw new Error("REFUSING: resolved a REAL merchant id");
  log(`Test user: ${boot.email}\nMerchant: ${MID}\nServer: ${BASE}`);

  section("Setup: clean slate + products");
  await cleanMerchant();
  const waterId = await createGoods("Nước suối 500ml", 12, 10000, { sku: "NS500", lowStockThreshold: 5 });
  const breadId = await createGoods("Bánh mì", 1, 15000);
  const coffeeId = await createGoods("Cà phê lon", 0, 20000);
  ok("water opening 12", (await onHand(waterId)) === 12);
  ok("opening movement count = 1 (water)", (await moveCount(waterId, "opening")) === 1);
  ok("coffee opening 0 → no opening movement", (await moveCount(coffeeId)) === 0);

  // ── INV-01: paid sale → exactly one 'sale' movement, correct qty ───────────
  section("INV-01: paid sale decrements by one movement");
  {
    const { orderId } = await sellAndPay(waterId, 2);
    const mv = await sql(`select quantity_delta, balance_after from public.inventory_movements m
                           join public.order_items oi on oi.id=m.reference_id
                          where m.merchant_id=$1 and m.movement_type='sale' and oi.order_id=$2`, [MID, orderId]);
    ok("one sale movement", mv.length === 1 && Number(mv[0].quantity_delta) === -2 && Number(mv[0].balance_after) === 10, JSON.stringify(mv));
    ok("water on_hand = 10", (await onHand(waterId)) === 10);
  }

  // ── INV-02: duplicate finalize (same key) → no double decrement ────────────
  section("INV-02: same-key double finalize → one movement, one decrement");
  {
    const o = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: waterId, quantity: 1 }] } });
    const orderId = o.json.order.id; const ver = o.json.order.version; const idem = randomUUID();
    const [a, b] = await Promise.all([
      api("POST", "/v1/payments/cash", { idem, body: { merchantId: MID, orderId, expectedVersion: ver, cashReceived: 999999 } }),
      api("POST", "/v1/payments/cash", { idem, body: { merchantId: MID, orderId, expectedVersion: ver, cashReceived: 999999 } }),
    ]);
    ok("both succeeded", a.json?.status === "succeeded" && b.json?.status === "succeeded", `${a.status}/${b.status}`);
    const cnt = (await sql(`select count(*)::int c from public.inventory_movements m join public.order_items oi on oi.id=m.reference_id where oi.order_id=$1 and m.movement_type='sale'`, [orderId]))[0].c;
    ok("exactly one sale movement", cnt === 1, `count=${cnt}`);
    ok("water on_hand = 9", (await onHand(waterId)) === 9);
  }

  // ── INV-03: two concurrent sales race the last item ────────────────────────
  section("INV-03: concurrent sales race last bread → one success, one INSUFFICIENT_STOCK");
  {
    const o1 = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: breadId, quantity: 1 }] } });
    const o2 = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: breadId, quantity: 1 }] } });
    const [p1, p2] = await Promise.all([
      api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o1.json.order.id, expectedVersion: o1.json.order.version, cashReceived: 999999 } }),
      api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: o2.json.order.id, expectedVersion: o2.json.order.version, cashReceived: 999999 } }),
    ]);
    const oks = [p1, p2].filter((p) => p.json?.status === "succeeded").length;
    const stock = [p1, p2].filter((p) => p.status === 409 && p.json?.code === "INSUFFICIENT_STOCK").length;
    ok("exactly one success", oks === 1, `${p1.status}/${p2.status}`);
    ok("exactly one INSUFFICIENT_STOCK", stock === 1, `${p1.json?.code}/${p2.json?.code}`);
    ok("bread on_hand = 0 (no oversell)", (await onHand(breadId)) === 0);
    ok("bread sale movements = 1", (await moveCount(breadId, "sale")) === 1);
  }

  // ── ADJ-preview ────────────────────────────────────────────────────────────
  section("Adjustment preview: before/after");
  let waterVersion;
  {
    const r = await api("POST", `/v1/merchants/${MID}/inventory/adjustments/preview`, { body: { productId: waterId, direction: "decrease", quantity: 3, reasonCode: "DAMAGED" } });
    ok("preview before=9 after=6", r.status === 200 && r.json.before === 9 && r.json.after === 6, JSON.stringify(r.json));
    waterVersion = r.json.currentVersion;
  }

  // ── ADJ idempotency: double-tap same key → one movement ────────────────────
  section("Adjustment idempotency: same-key double-tap → one movement");
  {
    const idem = randomUUID();
    const body = { productId: waterId, direction: "decrease", quantity: 2, reasonCode: "DAMAGED", note: null };
    const [a, b] = await Promise.all([
      api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem, body }),
      api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem, body }),
    ]);
    ok("both ok", [a.status, b.status].every((s) => s === 200 || s === 201), `${a.status}/${b.status}`);
    ok("same movement id", a.json.movementId && a.json.movementId === b.json.movementId, `${a.json.movementId}/${b.json.movementId}`);
    ok("one manual_adjustment movement", (await moveCount(waterId, "manual_adjustment")) === 1);
    ok("water on_hand = 7", (await onHand(waterId)) === 7);
  }

  // ── ADJ version conflict → 409 INVENTORY_BALANCE_CHANGED ────────────────────
  section("Adjustment version conflict: stale expectedBalanceVersion → 409");
  {
    // bump the balance so the old version is stale
    await api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem: randomUUID(), body: { productId: waterId, direction: "increase", quantity: 1, reasonCode: "FOUND" } });
    const stale = await api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem: randomUUID(), body: { productId: waterId, direction: "decrease", quantity: 1, reasonCode: "DAMAGED", expectedBalanceVersion: waterVersion } });
    ok("409 INVENTORY_BALANCE_CHANGED", stale.status === 409 && stale.json?.code === "INVENTORY_BALANCE_CHANGED", `${stale.status} ${stale.json?.code}`);
    ok("current snapshot returned", stale.json?.details?.current?.onHand === 8, JSON.stringify(stale.json?.details?.current));
  }

  // ── ADJ negative block ─────────────────────────────────────────────────────
  section("Adjustment negative block: decrease below 0 → 409 INSUFFICIENT_STOCK");
  {
    const before = await onHand(waterId);
    const r = await api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem: randomUUID(), body: { productId: waterId, direction: "decrease", quantity: 9999, reasonCode: "LOST" } });
    ok("409 INSUFFICIENT_STOCK", r.status === 409 && r.json?.code === "INSUFFICIENT_STOCK", `${r.status} ${r.json?.code}`);
    ok("on_hand unchanged", (await onHand(waterId)) === before);
  }

  // ── ADJ reason required ────────────────────────────────────────────────────
  section("Adjustment reason required");
  {
    const r = await api("POST", `/v1/merchants/${MID}/inventory/adjustments`, { idem: randomUUID(), body: { productId: waterId, direction: "decrease", quantity: 1 } });
    ok("400 REASON_REQUIRED", r.status === 400 && r.json?.code === "REASON_REQUIRED", `${r.status} ${r.json?.code}`);
  }

  // ── REVERSAL ───────────────────────────────────────────────────────────────
  section("Reversal: restore balance, original untouched, double-reverse blocked");
  {
    const adj = (await sql(`select id, quantity_delta from public.inventory_movements where merchant_id=$1 and product_id=$2 and movement_type='manual_adjustment' order by created_at limit 1`, [MID, waterId]))[0];
    const before = await onHand(waterId);
    const idem = randomUUID();
    const rev = await api("POST", `/v1/merchants/${MID}/inventory/movements/${adj.id}/reverse`, { idem, body: { reasonCode: "CORRECTION" } });
    ok("reversal posted", (rev.status === 200 || rev.status === 201) && rev.json.movementId, `${rev.status}`);
    ok("balance restored by +2", (await onHand(waterId)) === before + 2, `before ${before}`);
    const orig = (await sql(`select quantity_delta from public.inventory_movements where id=$1`, [adj.id]))[0];
    ok("original movement untouched", Number(orig.quantity_delta) === Number(adj.quantity_delta));
    // same-key replay
    const replay = await api("POST", `/v1/merchants/${MID}/inventory/movements/${adj.id}/reverse`, { idem, body: { reasonCode: "CORRECTION" } });
    ok("same-key replay → same movement", replay.json?.movementId === rev.json.movementId && replay.json?.replayed === true, JSON.stringify({ s: replay.status, r: replay.json?.replayed }));
    // different key second reverse → conflict
    const dbl = await api("POST", `/v1/merchants/${MID}/inventory/movements/${adj.id}/reverse`, { idem: randomUUID(), body: { reasonCode: "CORRECTION" } });
    ok("double reverse → 409 MOVEMENT_ALREADY_REVERSED", dbl.status === 409 && dbl.json?.code === "MOVEMENT_ALREADY_REVERSED", `${dbl.status} ${dbl.json?.code}`);
    // reversing a sale is not allowed
    const saleMv = (await sql(`select id from public.inventory_movements where merchant_id=$1 and movement_type='sale' limit 1`, [MID]))[0];
    const bad = await api("POST", `/v1/merchants/${MID}/inventory/movements/${saleMv.id}/reverse`, { idem: randomUUID(), body: {} });
    ok("reverse sale → 422 MOVEMENT_NOT_REVERSIBLE", bad.status === 422 && bad.json?.code === "MOVEMENT_NOT_REVERSIBLE", `${bad.status} ${bad.json?.code}`);
  }

  // ── COUNT: blind, review, post atomic, blank≠0, post-once ──────────────────
  section("Stock count: blind → review → post atomic (INV-09/10)");
  {
    const create = await api("POST", `/v1/merchants/${MID}/inventory-counts`, { idem: randomUUID(), body: { name: "KK1", blindCount: true, scope: { type: "products", productIds: [coffeeId, waterId] } } });
    ok("session created counting", create.status === 201 && create.json.session.status === "counting", JSON.stringify(create.json).slice(0, 120));
    const sid = create.json.session.id;
    const blindGet = await api("GET", `/v1/merchants/${MID}/inventory-counts/${sid}`);
    ok("blind hides expected while counting", blindGet.json.items.every((i) => i.expectedAtStart === undefined), JSON.stringify(blindGet.json.items[0]));
    // count coffee = 8 (variance +8), leave water uncounted (blank ≠ 0)
    await api("PATCH", `/v1/merchants/${MID}/inventory-counts/${sid}/items`, { body: { items: [{ productId: coffeeId, countedQty: 8, reasonCode: "FOUND" }] } });
    const review = await api("POST", `/v1/merchants/${MID}/inventory-counts/${sid}/review`, {});
    ok("review reveals expected+variance", review.json.items.some((i) => i.productId === coffeeId && i.expectedAtStart === 0 && i.variance === 8), JSON.stringify(review.json.summary));
    const coffeeBefore = await onHand(coffeeId);
    const post = await api("POST", `/v1/merchants/${MID}/inventory-counts/${sid}/post`, { idem: randomUUID(), body: {} });
    ok("post ok, 1 line", (post.status === 200 || post.status === 201) && post.json.postedLines === 1, JSON.stringify(post.json).slice(0, 120));
    ok("coffee on_hand = 8", (await onHand(coffeeId)) === 8, `was ${coffeeBefore}`);
    ok("coffee count_adjustment movement +8", (await moveCount(coffeeId, "count_adjustment")) === 1);
    ok("water NOT adjusted (blank ≠ 0)", (await moveCount(waterId, "count_adjustment")) === 0);
    // post again → already posted
    const again = await api("POST", `/v1/merchants/${MID}/inventory-counts/${sid}/post`, { idem: randomUUID(), body: {} });
    ok("second post → 409 COUNT_ALREADY_POSTED", again.status === 409 && again.json?.code === "COUNT_ALREADY_POSTED", `${again.status} ${again.json?.code}`);
  }

  // ── COUNT reason required blocks post (all-or-nothing) ──────────────────────
  section("Stock count: variance without reason blocks the whole post");
  {
    const create = await api("POST", `/v1/merchants/${MID}/inventory-counts`, { idem: randomUUID(), body: { name: "KK2", scope: { type: "products", productIds: [coffeeId] } } });
    const sid = create.json.session.id;
    await api("PATCH", `/v1/merchants/${MID}/inventory-counts/${sid}/items`, { body: { items: [{ productId: coffeeId, countedQty: 3 }] } }); // variance, no reason
    const before = await onHand(coffeeId);
    const post = await api("POST", `/v1/merchants/${MID}/inventory-counts/${sid}/post`, { idem: randomUUID(), body: {} });
    ok("post → 400 REASON_REQUIRED", post.status === 400 && post.json?.code === "REASON_REQUIRED", `${post.status} ${post.json?.code}`);
    ok("coffee on_hand unchanged (rollback)", (await onHand(coffeeId)) === before);
    const st = (await sql(`select status from public.inventory_count_sessions where id=$1`, [sid]))[0].status;
    ok("session not posted", st !== "posted", st);
    await api("POST", `/v1/merchants/${MID}/inventory-counts/${sid}/cancel`, {});
  }

  // ── Ledger deep-links ──────────────────────────────────────────────────────
  section("Ledger: source deep-links + reconciliation flag");
  {
    const led = await api("GET", `/v1/merchants/${MID}/inventory/${waterId}`);
    ok("ledger has sale→order source", led.json.movements.some((m) => m.movementType === "sale" && m.source?.kind === "order" && m.source?.route), JSON.stringify(led.json.movements.find((m) => m.movementType === "sale")?.source));
    ok("ledger reconciliation clean for water", led.json.reconciliation.mismatch === false, JSON.stringify(led.json.reconciliation));
    const cled = await api("GET", `/v1/merchants/${MID}/inventory/${coffeeId}`);
    ok("coffee ledger has count→count source", cled.json.movements.some((m) => m.movementType === "count_adjustment" && m.source?.kind === "count"), JSON.stringify(cled.json.movements.map((m) => m.source?.kind)));
  }

  // ── Overview + low filter ──────────────────────────────────────────────────
  section("Overview list + filters");
  {
    const ov = await api("GET", `/v1/merchants/${MID}/inventory`);
    ok("overview lists tracked goods with available", ov.json.products.some((p) => p.productId === waterId && typeof p.available === "number"), JSON.stringify(ov.json.summary));
    const low = await api("GET", `/v1/merchants/${MID}/inventory?filter=zero`);
    ok("zero filter finds bread", low.json.products.some((p) => p.productId === breadId), low.json.products.map((p) => p.name).join(","));
  }

  // ── RLS cross-tenant ───────────────────────────────────────────────────────
  section("RLS: cross-tenant read blocked");
  {
    const r = await api("GET", `/v1/merchants/${REAL_MERCHANTS[0]}/inventory`);
    ok("403 FORBIDDEN on other merchant", r.status === 403 && r.json?.code === "FORBIDDEN", `${r.status} ${r.json?.code}`);
  }

  // ── Reconciliation clean (final integrity gate) ────────────────────────────
  section("Reconciliation: ledger == balance after all tests");
  {
    const rec = await api("GET", `/v1/merchants/${MID}/inventory/reconciliation`);
    ok("no reconciliation findings", rec.status === 200 && rec.json.findings.length === 0, JSON.stringify(rec.json.findings));
    // direct SQL double-check
    const bad = await sql(
      `select b.product_id from public.inventory_levels b
         left join public.inventory_movements m on m.merchant_id=b.merchant_id and m.product_id=b.product_id
        where b.merchant_id=$1 group by b.product_id, b.on_hand
       having b.on_hand <> coalesce(sum(m.quantity_delta),0)`, [MID]);
    ok("SQL: every level == ledger sum", bad.length === 0, `${bad.length} mismatched`);
  }

  log(`\n──────── ${PASS} passed, ${FAIL} failed ────────`);
  await pool.end();
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL", e); try { await pool.end(); } catch {} process.exit(1); });
