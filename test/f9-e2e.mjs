// Live end-to-end verification of the Functional 09 test matrix (spec 12.3 P0,
// adapted to the MockProvider). NOT part of `npm test` (needs the live Supabase DB +
// the running combined server with SOHO_DEV_ENDPOINTS=1). Run:
//   PORT=3019 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &
//   F9_BASE=http://localhost:3019 node --env-file=.env test/f9-e2e.mjs
// Operates ONLY on its own throwaway merchant (soho-crew-test+f9@soho.test) and uses
// the F5 test merchant as a second tenant for the RLS check.
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureF9Merchant, REAL_MERCHANTS } from "./f9-setup.mjs";
import { ensureF5Merchant } from "./f5-setup.mjs";

const BASE = process.env.F9_BASE || "http://localhost:3019";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let token, MID, UID;
async function api(method, path, { body, idem, token: tk, raw } = {}) {
  const headers = { Authorization: `Bearer ${tk ?? token}` };
  if (!raw) headers["Content-Type"] = "application/json";
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return { status: res.status, text: await res.text() };
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function createGoods(name, opening, price) {
  const r = await api("POST", `/v1/merchants/${MID}/products`, {
    idem: randomUUID(),
    body: { draft_id: randomUUID(), name, productType: "goods", unitCode: "cái", salePrice: price, trackInventory: true, openingQty: opening },
  });
  return r.json?.product?.id;
}
async function makePaidOrder(pid, qty) {
  const o = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: pid, quantity: qty }] } });
  const orderId = o.json.order.id;
  await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId, expectedVersion: o.json.order.version, cashReceived: 999999 } });
  return { orderId, total: o.json.order.totalAmount };
}
async function makeDraftOrder(pid, qty) {
  const o = await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: pid, quantity: qty }] } });
  return o.json.order.id; // unpaid → status 'draft'
}

async function cleanMerchant() {
  const tables = [
    "e_invoice_provider_events", "e_invoice_submissions", "e_invoice_relations", "e_invoice_items", "e_invoices",
    "inventory_movements", "payment_provider_events", "payment_refunds", "payments",
    "order_adjustments", "order_items", "inventory_reservations", "receipts",
    "product_price_history", "integration_outbox", "audit_logs", "orders", "action_items",
    "inventory_levels", "products", "product_categories",
  ];
  for (const t of tables) { try { await pool.query(`delete from public.${t} where merchant_id=$1`, [MID]); } catch { /* table may lack merchant_id (events) */ } }
  // provider events have no merchant_id → clean by invoice join is moot after e_invoices gone.
}

async function fullyIssue(pid) {
  const { orderId } = await makePaidOrder(pid, 1);
  const d = await api("POST", `/v1/merchants/${MID}/e-invoices`, { idem: randomUUID(), body: { orderId, buyerKind: "individual" } });
  const invId = d.json.invoice.id;
  await api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/validate`, { body: { expectedVersion: d.json.invoice.rowVersion } });
  const got = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`);
  await api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/submit`, { idem: randomUUID(), body: { expectedVersion: got.json.rowVersion, acknowledgements: { buyer_reviewed: true, amounts_reviewed: true } } });
  return { orderId, invId };
}

async function main() {
  const boot = await ensureF9Merchant();
  MID = boot.merchantId; UID = boot.userId; token = boot.token;
  if (REAL_MERCHANTS.includes(MID)) throw new Error("REFUSING: resolved a REAL merchant id");
  const other = await ensureF5Merchant(); // second tenant for RLS
  log(`Test user: ${boot.email}\nMerchant: ${MID}\nServer: ${BASE}`);

  section("Setup: clean slate + product + paid order");
  await cleanMerchant();
  const pid = await createGoods("Bánh mì", 50, 27000);
  const { orderId, total } = await makePaidOrder(pid, 2);
  ok("paid order created", Boolean(orderId), `total=${total}`);

  // ── INV-01: eligibility — unpaid order cannot create a draft ────────────────
  section("INV-01: only a paid order is eligible");
  {
    const unpaid = await makeDraftOrder(pid, 1);
    const r = await api("POST", `/v1/merchants/${MID}/e-invoices`, { idem: randomUUID(), body: { orderId: unpaid } });
    ok("unpaid → ORDER_NOT_ELIGIBLE", r.status === 409 && r.json?.code === "ORDER_NOT_ELIGIBLE", `${r.status}/${r.json?.code}`);
  }

  // ── Create draft from the paid order; INV-03 totals reconcile ───────────────
  section("Create draft + INV-03 server totals == bill total");
  let invId, ver;
  {
    const r = await api("POST", `/v1/merchants/${MID}/e-invoices`, { idem: randomUUID(), body: { orderId, buyerKind: "individual" } });
    ok("draft created (201)", r.status === 201 && r.json?.invoice?.status === "draft", `${r.status}`);
    invId = r.json.invoice.id; ver = r.json.invoice.rowVersion;
    ok("invoice total == bill total", r.json.invoice.totalVnd === total, `${r.json.invoice.totalVnd} vs ${total}`);
    ok("subtotal + tax == total", r.json.invoice.subtotalVnd + r.json.invoice.taxVnd === r.json.invoice.totalVnd);
  }

  // ── INV-02: concurrency — two devices, one original invoice ─────────────────
  section("INV-02: concurrent create → one original invoice");
  {
    const order2 = await makePaidOrder(pid, 1);
    const [a, b] = await Promise.all([
      api("POST", `/v1/merchants/${MID}/e-invoices`, { idem: randomUUID(), body: { orderId: order2.orderId } }),
      api("POST", `/v1/merchants/${MID}/e-invoices`, { idem: randomUUID(), body: { orderId: order2.orderId } }),
    ]);
    const ids = new Set([a.json?.invoice?.id, b.json?.invoice?.id]);
    ok("both resolve to ONE invoice id", ids.size === 1, [...ids].join(","));
    const cnt = (await sql(`select count(*)::int c from public.e_invoices where order_id=$1 and status not in ('rejected','cancelled')`, [order2.orderId]))[0].c;
    ok("exactly one active original row", cnt === 1, `count=${cnt}`);
  }

  // ── INV-04: buyer MST invalid → validation_failed ──────────────────────────
  section("INV-04: bad buyer MST fails validation");
  {
    await api("PATCH", `/v1/merchants/${MID}/e-invoices/${invId}/buyer`, { body: { buyer: { kind: "organization", name: "Cty X", taxCode: "123" }, expectedVersion: ver } });
    const g = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`);
    const v = await api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/validate`, { body: { expectedVersion: g.json.rowVersion } });
    ok("validate ok=false", v.json?.ok === false && v.json?.invoice?.status === "validation_failed");
    ok("carries BUYER_TAX_ID_INVALID", (v.json?.errors || []).some((e) => e.code === "BUYER_TAX_ID_INVALID"));
  }

  // ── Fix buyer → validate OK → payload_hash set ─────────────────────────────
  section("Validate OK sets payload_hash");
  {
    let g = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`);
    await api("PATCH", `/v1/merchants/${MID}/e-invoices/${invId}/buyer`, { body: { buyer: { kind: "individual", name: "Chị Lan" }, expectedVersion: g.json.rowVersion } });
    g = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`);
    const v = await api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/validate`, { body: { expectedVersion: g.json.rowVersion } });
    ok("validated", v.json?.ok === true && v.json?.invoice?.status === "validated");
    ok("payload_hash present", Boolean(v.json?.invoice?.payloadHash));
  }

  // ── INV-06: submit idempotent (concurrent same key → one submission) ────────
  section("INV-06: concurrent submit → one submission, status submitting");
  {
    const g = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`);
    const idem = randomUUID();
    const body = { expectedVersion: g.json.rowVersion, acknowledgements: { buyer_reviewed: true, amounts_reviewed: true } };
    const [a, b] = await Promise.all([
      api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/submit`, { idem, body }),
      api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/submit`, { idem, body }),
    ]);
    ok("both non-error", a.status < 400 && b.status < 400, `${a.status}/${b.status}`);
    const cnt = (await sql(`select count(*)::int c from public.e_invoice_submissions where invoice_id=$1`, [invId]))[0].c;
    ok("exactly one submission row", cnt === 1, `count=${cnt}`);
    const s = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}/status`);
    ok("status submitting", s.json?.status === "submitting", s.json?.status);
  }

  // ── INV-07: webhook bad signature → no state change ─────────────────────────
  section("INV-07: invalid webhook signature never changes state");
  {
    const ref = (await sql(`select provider_invoice_ref from public.e_invoices where id=$1`, [invId]))[0]?.provider_invoice_ref;
    const evt = { providerEventId: `BAD-${randomUUID()}`, invoiceId: invId, providerRef: ref, eventType: "accepted", occurredAt: new Date().toISOString(), providerCode: "mock" };
    const r = await fetch(BASE + "/v1/webhooks/e-invoice/mock", { method: "POST", headers: { "Content-Type": "application/json", "X-Provider-Signature": "deadbeef" }, body: JSON.stringify(evt) });
    const j = await r.json();
    ok("signatureValid=false, not processed", j.signatureValid === false && j.processed === false, JSON.stringify(j));
    const st = (await sql(`select status from public.e_invoices where id=$1`, [invId]))[0].status;
    ok("still submitting", st === "submitting", st);
  }

  // ── INV-08: duplicate accepted event → one transition ───────────────────────
  section("INV-08: duplicate provider event → one transition (accepted)");
  {
    const eventId = `DUP-${randomUUID()}`;
    const [a, b] = await Promise.all([
      api("POST", "/v1/dev/e-invoice/simulate", { body: { merchantId: MID, invoiceId: invId, decision: "accept", eventId } }),
      api("POST", "/v1/dev/e-invoice/simulate", { body: { merchantId: MID, invoiceId: invId, decision: "accept", eventId } }),
    ]);
    const processed = [a.json, b.json].filter((x) => x?.processed).length;
    const duplicated = [a.json, b.json].filter((x) => x?.duplicated).length;
    ok("one processed, one duplicated", processed === 1 && duplicated === 1, `${processed}/${duplicated}`);
    const st = (await sql(`select status from public.e_invoices where id=$1`, [invId]))[0].status;
    ok("accepted", st === "accepted", st);
    const evc = (await sql(`select count(*)::int c from public.e_invoice_provider_events where invoice_id=$1 and provider_event_id=$2`, [invId, eventId]))[0].c;
    ok("single event row", evc === 1, `count=${evc}`);
  }

  // ── INV-11: artifacts private + downloadable ────────────────────────────────
  section("INV-11: accepted invoice serves XML/PDF artifacts");
  {
    const x = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}/artifacts/xml`, { raw: true });
    ok("XML 200 + placeholder label", x.status === 200 && /TEST PLACEHOLDER/.test(x.text));
    const p = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}/artifacts/pdf`, { raw: true });
    ok("PDF 200", p.status === 200 && /THỬ NGHIỆM/.test(p.text));
  }

  // ── INV-13: relation — adjustment corrective draft off the accepted invoice ──
  section("INV-13: accepted → adjustment relation creates a linked draft");
  {
    const r = await api("POST", `/v1/merchants/${MID}/e-invoices/${invId}/relations`, { idem: randomUUID(), body: { relationType: "adjustment", reason: "sai mã số thuế" } });
    ok("new draft created", r.status === 201 && r.json?.invoice?.status === "draft" && r.json?.invoice?.invoiceKind === "adjustment");
    const rel = (await sql(`select count(*)::int c from public.e_invoice_relations where original_invoice_id=$1 and relation_type='adjustment'`, [invId]))[0].c;
    ok("relation row present", rel === 1, `count=${rel}`);
  }

  // ── INV-12: rejected retry keeps the original submission ────────────────────
  section("INV-12: rejected → retry-draft clone, original kept");
  {
    const p2 = await createGoods("Cà phê", 20, 30000);
    const { invId: rejId } = await fullyIssue(p2);
    await api("POST", "/v1/dev/e-invoice/simulate", { body: { merchantId: MID, invoiceId: rejId, decision: "reject", rejectCode: "BUYER_TAX_ID_INVALID" } });
    const st = (await sql(`select status from public.e_invoices where id=$1`, [rejId]))[0].status;
    ok("original rejected", st === "rejected", st);
    const retry = await api("POST", `/v1/merchants/${MID}/e-invoices/${rejId}/retry-draft`, { idem: randomUUID() });
    ok("retry draft created", retry.status === 201 && retry.json?.invoice?.status === "draft" && retry.json?.invoice?.id !== rejId);
    const origStill = (await sql(`select status from public.e_invoices where id=$1`, [rejId]))[0].status;
    ok("original still rejected (submission kept)", origStill === "rejected");
  }

  // ── INV-14: RLS cross-tenant read is denied ─────────────────────────────────
  section("INV-14: cross-tenant read denied");
  {
    const r = await api("GET", `/v1/merchants/${MID}/e-invoices/${invId}`, { token: other.token });
    ok("other tenant → 403", r.status === 403, `${r.status}`);
  }

  log(`\n──────────\n${PASS} passed, ${FAIL} failed`);
  await pool.end();
  process.exit(FAIL ? 1 : 0);
}

main().catch(async (e) => { console.error("E2E crashed:", e); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });
