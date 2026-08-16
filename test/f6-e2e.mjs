// Functional 06 live E2E (spec 12.3 P0 matrix). NOT in `npm test` (needs DB +
// a running server). Run:
//   F6_BASE=http://localhost:<port> node --env-file=.env test/f6-e2e.mjs
// Covers: draft creates no stock (REC-01), server recomputes totals (REC-02),
// atomic post = N movements + exactly 1 accounting event (REC-03), post replay/
// retry no-dup (REC-05 / REC-15), duplicate document hash warns (REC-06), cancel
// leaves no stock change, reverse (REC-11) + reverse-would-go-negative block
// (REC-12), cross-tenant RLS (REC-13), ledger reconciliation stays clean.
import { ensureF6 } from "./f6-setup.mjs";
import pg from "pg";

const BASE = process.env.F6_BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0;
function ok(name, cond, extra = "") { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name} ${extra}`); } }

async function call(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null; const text = await res.text();
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, json };
}

function uuid() { return crypto.randomUUID(); }

async function onHand(pool, merchantId, productId) {
  const { rows } = await pool.query(`select coalesce(on_hand,0) as oh from public.inventory_levels where merchant_id=$1 and product_id=$2`, [merchantId, productId]);
  return rows.length ? Number(rows[0].oh) : 0;
}

async function main() {
  const s = await ensureF6();
  const { merchantId, token, productIds, other } = s;
  const [pA, pB] = productIds;
  const M = (p) => `/v1/merchants/${merchantId}${p}`;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });

  console.log("F6 E2E on merchant", merchantId);
  const startA = await onHand(pool, merchantId, pA);
  const startB = await onHand(pool, merchantId, pB);

  // ── REC-01: create draft → no stock change ──────────────────────────────────
  const c1 = await call("POST", M("/receiving/receipts"), { token, idem: uuid(), body: { supplierName: "NCC Test", receivedAt: new Date().toISOString().slice(0, 10) } });
  ok("REC-01 create draft 201", c1.status === 201, JSON.stringify(c1.json).slice(0, 200));
  const rid = c1.json?.receipt?.id;
  await call("PUT", M(`/receiving/receipts/${rid}/items`), { token, body: { items: [
    { productId: pA, quantity: 48, unitCostVnd: 6000 },
    { productId: pB, quantity: 10, unitCostVnd: 3500 },
  ] } });
  ok("REC-01 stock unchanged while draft", await onHand(pool, merchantId, pA) === startA);

  // ── REC-02: server recomputes totals (ignore a bogus client total) ──────────
  const prev = await call("POST", M(`/receiving/receipts/${rid}/preview`), { token });
  ok("REC-02 subtotal recomputed = 48*6000 + 10*3500 = 323000", prev.json?.totals?.subtotalVnd === 323000, JSON.stringify(prev.json?.totals));

  // ── REC-03: post → 2 movements + exactly 1 accounting event ─────────────────
  const postKey = uuid();
  const p1 = await call("POST", M(`/receiving/receipts/${rid}/post`), { token, idem: postKey });
  ok("REC-03 post 201", p1.status === 201, JSON.stringify(p1.json).slice(0, 200));
  ok("REC-03 two movements", p1.json?.movements?.length === 2);
  ok("REC-03 stock A raised by 48", await onHand(pool, merchantId, pA) === startA + 48);
  ok("REC-03 stock B raised by 10", await onHand(pool, merchantId, pB) === startB + 10);
  const { rows: accRows } = await pool.query(`select count(*)::int c from public.accounting_events where merchant_id=$1 and source_type='purchase_receipt' and source_id=$2 and event_type='purchase_received'`, [merchantId, rid]);
  ok("REC-03 exactly 1 accounting event", accRows[0].c === 1, `got ${accRows[0].c}`);

  // ── REC-05 / REC-15: retry same key + fresh key → no duplicate movements ────
  const p2 = await call("POST", M(`/receiving/receipts/${rid}/post`), { token, idem: postKey });
  ok("REC-05 same-key replay 200", p2.status === 200 && p2.json?.replayed === true);
  const p3 = await call("POST", M(`/receiving/receipts/${rid}/post`), { token, idem: uuid() });
  ok("REC-05 already-posted fresh-key replay (idempotent)", (p3.status === 200 || p3.status === 201) && await onHand(pool, merchantId, pA) === startA + 48, `status ${p3.status}`);
  const { rows: mvRows } = await pool.query(`select count(*)::int c from public.inventory_movements where merchant_id=$1 and reference_type='purchase_receipt' and reference_id=$2`, [merchantId, rid]);
  ok("REC-15 movement count still 2 (no dup)", mvRows[0].c === 2, `got ${mvRows[0].c}`);

  // ── posted is immutable: editing lines is rejected ──────────────────────────
  const editPosted = await call("PUT", M(`/receiving/receipts/${rid}/items`), { token, body: { items: [{ productId: pA, quantity: 1, unitCostVnd: 1 }] } });
  ok("posted receipt immutable (items 409)", editPosted.status === 409, `status ${editPosted.status}`);

  // ── REC-06: duplicate document hash → warned, not re-imported ───────────────
  // Per-run-unique bytes so the test is re-runnable (dedupe is by content hash).
  const basePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const png = Buffer.concat([basePng, Buffer.from(crypto.randomUUID())]).toString("base64");
  const dnum = `PN-DUP-${Date.now()}`;
  const d1 = await call("POST", M("/receiving/documents"), { token, body: { image: png, mimeType: "image/png", documentNumber: dnum } });
  ok("REC-06 first document upload 201", d1.status === 201, JSON.stringify(d1.json).slice(0, 150));
  const d2 = await call("POST", M("/receiving/documents"), { token, body: { image: png, mimeType: "image/png", documentNumber: dnum } });
  ok("REC-06 duplicate hash warned (409 POSSIBLE_DUPLICATE_DOCUMENT)", d2.status === 409 && d2.json?.code === "POSSIBLE_DUPLICATE_DOCUMENT", `status ${d2.status} ${d2.json?.code}`);
  const d3 = await call("POST", M("/receiving/documents"), { token, body: { image: png, mimeType: "image/png", documentNumber: dnum, force: true } });
  ok("REC-06 override with force → 201", d3.status === 201, `status ${d3.status}`);
  // signed URL works for owner
  if (d1.json?.documentId) {
    const urlRes = await call("GET", M(`/receiving/documents/${d1.json.documentId}/url`), { token });
    ok("REC-FR-11 signed URL issued", urlRes.status === 200 && typeof urlRes.json?.url === "string");
    // REC-13: other merchant's user cannot get a URL for this doc
    const cross = await call("GET", M(`/receiving/documents/${d1.json.documentId}/url`), { token: other.token });
    ok("REC-13 cross-tenant document URL denied (403)", cross.status === 403, `status ${cross.status}`);
  }

  // ── cancel draft → no stock change ──────────────────────────────────────────
  const c2 = await call("POST", M("/receiving/receipts"), { token, idem: uuid(), body: { supplierName: "NCC Cancel" } });
  const rid2 = c2.json?.receipt?.id;
  await call("PUT", M(`/receiving/receipts/${rid2}/items`), { token, body: { items: [{ productId: pA, quantity: 5, unitCostVnd: 6000 }] } });
  const beforeCancel = await onHand(pool, merchantId, pA);
  const can = await call("POST", M(`/receiving/receipts/${rid2}/cancel`), { token });
  ok("cancel draft → cancelled", can.json?.status === "cancelled");
  ok("cancel leaves no stock change", await onHand(pool, merchantId, pA) === beforeCancel);

  // ── REC-13: cross-tenant receipt read denied ────────────────────────────────
  const crossGet = await call("GET", M(`/receiving/receipts/${rid}`), { token: other.token });
  ok("REC-13 cross-tenant receipt read denied (403)", crossGet.status === 403, `status ${crossGet.status}`);

  // ── REC-11: reverse a posted receipt (stock still available) ────────────────
  const c3 = await call("POST", M("/receiving/receipts"), { token, idem: uuid(), body: { supplierName: "NCC Reverse" } });
  const rid3 = c3.json?.receipt?.id;
  await call("PUT", M(`/receiving/receipts/${rid3}/items`), { token, body: { items: [{ productId: pB, quantity: 7, unitCostVnd: 3500 }] } });
  await call("POST", M(`/receiving/receipts/${rid3}/preview`), { token });
  await call("POST", M(`/receiving/receipts/${rid3}/post`), { token, idem: uuid() });
  const afterPostB = await onHand(pool, merchantId, pB);
  const revKey = uuid();
  const rev = await call("POST", M(`/receiving/receipts/${rid3}/reverse`), { token, idem: revKey });
  ok("REC-11 reverse posts opposite movement", rev.status === 201 && rev.json?.status === "reversed", JSON.stringify(rev.json).slice(0, 150));
  ok("REC-11 stock B back down by 7", await onHand(pool, merchantId, pB) === afterPostB - 7);
  const revReplay = await call("POST", M(`/receiving/receipts/${rid3}/reverse`), { token, idem: revKey });
  ok("REC-11 reverse replay (no double)", revReplay.status === 200 && revReplay.json?.replayed === true);

  // ── REC-12: reverse that would go negative is blocked ───────────────────────
  const c4 = await call("POST", M("/receiving/receipts"), { token, idem: uuid(), body: { supplierName: "NCC RevNeg" } });
  const rid4 = c4.json?.receipt?.id;
  await call("PUT", M(`/receiving/receipts/${rid4}/items`), { token, body: { items: [{ productId: pA, quantity: 3, unitCostVnd: 6000 }] } });
  await call("POST", M(`/receiving/receipts/${rid4}/post`), { token, idem: uuid() });
  // Sell/consume the stock down below what the receipt added, via a direct adjustment.
  const curA = await onHand(pool, merchantId, pA);
  const adjKey = uuid();
  await call("POST", M("/receiving/receipts"), { token }).catch(() => {}); // noop keep-alive
  const adj = await call("POST", M("/inventory/adjustments"), { token, idem: adjKey, body: { productId: pA, direction: "decrease", quantity: curA, reasonCode: "LOST" } });
  ok("setup: drained stock A to 0 for reverse-negative test", adj.status === 201 || adj.status === 200, `status ${adj.status}`);
  const revNeg = await call("POST", M(`/receiving/receipts/${rid4}/reverse`), { token, idem: uuid() });
  ok("REC-12 reverse blocked when stock already sold (409 RECEIPT_REVERSE_NEGATIVE)", revNeg.status === 409 && revNeg.json?.code === "RECEIPT_REVERSE_NEGATIVE", `status ${revNeg.status} ${revNeg.json?.code}`);

  // ── reconciliation stays clean for the touched products ─────────────────────
  const { rows: recon } = await pool.query(
    `select b.product_id, b.on_hand, coalesce(sum(m.quantity_delta),0) as ledger
       from public.inventory_levels b
       left join public.inventory_movements m on m.merchant_id=b.merchant_id and m.product_id=b.product_id
      where b.merchant_id=$1 and b.product_id = any($2::uuid[])
      group by b.product_id, b.on_hand`,
    [merchantId, [pA, pB]],
  );
  const clean = recon.every((r) => Math.abs(Number(r.on_hand) - Number(r.ledger)) < 1e-9);
  ok("ledger reconciliation clean (balance == Σ movements)", clean, JSON.stringify(recon));

  await pool.end();
  console.log(`\nF6 E2E: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E crashed:", e); process.exit(1); });
