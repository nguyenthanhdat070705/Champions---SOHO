// Live end-to-end verification of the Functional 11 test matrix (spec 12.3 P0).
// NOT part of `npm test` (needs the live Supabase DB + the running combined
// server). Run:
//   PORT=3011 SOHO_DEV_ENDPOINTS=1 node --env-file=.env server/index.js &
//   F11_BASE=http://localhost:3011 node --env-file=.env test/f11-e2e.mjs
// Operates ONLY on its own throwaway merchants (soho-crew-test+f11/+f11b).
import pg from "pg";
import { randomUUID } from "node:crypto";
import { ensureF11, seedSources, REAL_MERCHANTS } from "./f11-setup.mjs";

const BASE = process.env.F11_BASE || "http://localhost:3011";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = (t, p) => pool.query(t, p).then((r) => r.rows);

let PASS = 0, FAIL = 0;
const log = (...a) => console.log(...a);
function ok(name, cond, extra = "") { if (cond) { PASS++; log(`  ✅ ${name}${extra ? " — " + extra : ""}`); } else { FAIL++; log(`  ❌ ${name}${extra ? " — " + extra : ""}`); } }
function section(t) { log(`\n=== ${t} ===`); }

let token, tokenB, MID, MIDB, UID;
async function api(method, path, { body, idem, token: tk } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tk ?? token}` };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

const linkCount = async (mid, type, sid) =>
  Number((await sql(`select count(*)::int c from public.cashbook_source_links where merchant_id=$1 and source_type=$2 and source_id=$3`, [mid, type, sid]))[0].c);
const entryCount = async (mid) => Number((await sql(`select count(*)::int c from public.cashbook_entries where merchant_id=$1`, [mid]))[0].c);

async function cleanCashbook(mid) {
  await pool.query(`delete from public.cashbook_adjustments where merchant_id=$1`, [mid]);
  await pool.query(`delete from public.cashbook_source_links where merchant_id=$1`, [mid]);
  await pool.query(`delete from public.cashbook_review_items where merchant_id=$1`, [mid]);
  await pool.query(`delete from public.cashbook_entries where merchant_id=$1`, [mid]);
}
async function cleanSales(mid) {
  for (const t of ["payment_refunds", "payments", "sales_return_items", "sales_returns",
    "order_items", "inventory_reservations", "receipts", "orders", "accounting_events",
    "inventory_movements", "inventory_levels", "product_price_history", "products"]) {
    await pool.query(`delete from public.${t} where merchant_id=$1`, [mid]);
  }
}

async function main() {
  const boot = await ensureF11();
  MID = boot.merchantId; MIDB = boot.merchantIdB; UID = boot.userId; token = boot.token; tokenB = boot.tokenB;
  if (REAL_MERCHANTS.includes(MID) || REAL_MERCHANTS.includes(MIDB)) throw new Error("REFUSING to run against a real merchant");
  log(`F11 merchant ${MID} (B=${MIDB})`);

  // Deterministic known state: wipe cashbook + sales artifacts, then reseed the
  // synthetic sources (1 cash payment 320k, 1 cash refund 20k, 1 purchase 1280k).
  await cleanCashbook(MID);
  await cleanSales(MID);
  const src = await seedSources(pool, MID, UID);

  // ── CBK-01/02: replay & concurrency-safe ingest via sync ───────────────────
  section("CBK-01/02 Replay & sync idempotency");
  await api("POST", `/v1/merchants/${MID}/cashbook/sync`, { body: {} });
  ok("payment → exactly one 'in' link", (await linkCount(MID, "payment", src.paymentId)) === 1);
  ok("refund → exactly one 'out' link", (await linkCount(MID, "refund", src.refundId)) === 1);
  const revAfterSync = await sql(`select id, status, reason_codes from public.cashbook_review_items where merchant_id=$1 and event_id=$2`, [MID, src.eventId]);
  ok("purchase accounting_event → one review item (NOT auto-posted)", revAfterSync.length === 1, revAfterSync[0]?.status);
  // Hammer sync repeatedly → still one of each.
  for (let i = 0; i < 5; i++) await api("POST", `/v1/merchants/${MID}/cashbook/sync`, { body: {} });
  ok("5× sync → still one payment link", (await linkCount(MID, "payment", src.paymentId)) === 1);
  ok("5× sync → still one refund link", (await linkCount(MID, "refund", src.refundId)) === 1);
  ok("5× sync → still one review item", (await sql(`select count(*)::int c from public.cashbook_review_items where merchant_id=$1 and event_id=$2`, [MID, src.eventId]))[0].c === 1);

  // ── Directions & entry types (spec §4.1) ───────────────────────────────────
  section("Direction / entry-type mapping");
  const payEntry = (await sql(`select e.direction, e.entry_type, e.amount_vnd, e.payment_method from public.cashbook_entries e join public.cashbook_source_links l on l.entry_id=e.id where l.source_type='payment' and l.source_id=$1`, [src.paymentId]))[0];
  ok("payment entry is in/sales_receipt/cash 320000", payEntry?.direction === "in" && payEntry?.entry_type === "sales_receipt" && Number(payEntry?.amount_vnd) === 320000 && payEntry?.payment_method === "cash");
  const refEntry = (await sql(`select e.direction, e.entry_type, e.amount_vnd from public.cashbook_entries e join public.cashbook_source_links l on l.entry_id=e.id where l.source_type='refund' and l.source_id=$1`, [src.refundId]))[0];
  ok("refund entry is out/sales_refund 20000", refEntry?.direction === "out" && refEntry?.entry_type === "sales_refund" && Number(refEntry?.amount_vnd) === 20000);

  // ── CBK-10 Timezone: today's summary includes today's payment ──────────────
  section("CBK-10 Summary totals (period=today, hand-computed)");
  let sum = (await api("GET", `/v1/merchants/${MID}/cashbook/summary?period=today`)).json;
  ok("summary totalIn = 320000", sum.totalIn === 320000, `got ${sum.totalIn}`);
  ok("summary totalOut = 20000 (refund only; purchase still in review)", sum.totalOut === 20000, `got ${sum.totalOut}`);
  ok("summary difference = 300000", sum.difference === 300000, `got ${sum.difference}`);
  ok("coverage shows the purchase in review", sum.coverage.review >= 1 && sum.reviewCount >= 1, `review=${sum.coverage.review}`);
  ok("coverage not complete (purchase unposted)", sum.coverage.complete === false);

  // ── CBK-03 Review → post (the purchase, out/inventory_purchase) ─────────────
  section("Review resolve → post (atomic, idempotent)");
  const reviewId = revAfterSync[0].id;
  // Fill the missing payment method, then post.
  const patched = (await api("PATCH", `/v1/merchants/${MID}/cashbook/review/${reviewId}`, { body: { paymentMethod: "transfer", expectedRowVersion: 1 } })).json;
  ok("patch review → ready", patched.ready === true && patched.status === "ready");
  const idem = randomUUID();
  const posted = (await api("POST", `/v1/merchants/${MID}/cashbook/review/${reviewId}/post`, { idem, body: { expectedRowVersion: patched.rowVersion } })).json;
  ok("post review → entry created", Boolean(posted.entryId));
  ok("purchase → one 'out' inventory_purchase link", (await linkCount(MID, "purchase_receipt", src.receiptId)) === 1);
  // Re-post with SAME idem key → replay, no second entry.
  const before = await entryCount(MID);
  const rePost = (await api("POST", `/v1/merchants/${MID}/cashbook/review/${reviewId}/post`, { idem, body: { expectedRowVersion: patched.rowVersion } })).json;
  ok("re-post same key → replay, no new entry", (await entryCount(MID)) === before, `entries=${before}`);
  ok("re-post reports replayed", rePost.replayed === true);
  // Post again fresh key on a resolved item → still the same entry (source-link unique).
  const rePost2 = (await api("POST", `/v1/merchants/${MID}/cashbook/review/${reviewId}/post`, { idem: randomUUID(), body: {} })).json;
  ok("post resolved item again → same entry, no dup", (await entryCount(MID)) === before && rePost2.entryId === posted.entryId);

  // Summary now includes the purchase.
  sum = (await api("GET", `/v1/merchants/${MID}/cashbook/summary?period=today`)).json;
  ok("summary totalOut now 1300000 (20000 + 1280000)", sum.totalOut === 1300000, `got ${sum.totalOut}`);
  ok("coverage complete after posting purchase", sum.coverage.complete === true, `pct=${sum.coverage.pct}`);

  // ── CBK-07 Reverse: opposite entry + one-reversal guard ────────────────────
  section("CBK-07 Reverse (opposite entry, one reversal)");
  const payEntryId = (await sql(`select entry_id from public.cashbook_source_links where source_type='payment' and source_id=$1`, [src.paymentId]))[0].entry_id;
  const cntBeforeRev = await entryCount(MID);
  const rev1 = (await api("POST", `/v1/merchants/${MID}/cashbook/entries/${payEntryId}/reverse`, { idem: randomUUID(), body: { reasonCode: "wrong_amount", note: "test reversal" } })).json;
  ok("reverse → contra entry created", Boolean(rev1.reversalEntryId) && (await entryCount(MID)) === cntBeforeRev + 1);
  const contra = (await sql(`select direction, entry_type, amount_vnd from public.cashbook_entries where id=$1`, [rev1.reversalEntryId]))[0];
  ok("contra is out/adjustment 320000 (opposite of the in)", contra.direction === "out" && contra.entry_type === "adjustment" && Number(contra.amount_vnd) === 320000);
  // Reverse again → same reversal, no second contra (one-reversal guard).
  const rev2 = (await api("POST", `/v1/merchants/${MID}/cashbook/entries/${payEntryId}/reverse`, { idem: randomUUID(), body: { reasonCode: "wrong_amount", note: "again" } })).json;
  ok("second reverse → same reversal, no new entry", rev2.reversalEntryId === rev1.reversalEntryId && (await entryCount(MID)) === cntBeforeRev + 1);
  const adjCount = (await sql(`select count(*)::int c from public.cashbook_adjustments where merchant_id=$1 and original_entry_id=$2`, [MID, payEntryId]))[0].c;
  ok("exactly one adjustment relation for the original", adjCount === 1);
  // A reversed 'in' offset by the 'out' contra → net difference unchanged for that pair.
  sum = (await api("GET", `/v1/merchants/${MID}/cashbook/summary?period=today`)).json;
  ok("after reversal, the payment's net effect is offset (in 320k + out 320k)", sum.totalIn === 320000 && sum.totalOut === 1300000 + 320000, `in=${sum.totalIn} out=${sum.totalOut}`);
  // detail says canReverse=false now
  const detail = (await api("GET", `/v1/merchants/${MID}/cashbook/entries/${payEntryId}`)).json;
  ok("detail marks the entry reversed, canReverse=false", detail.reversed === true && detail.canReverse === false);

  // ── Manual draft → post ────────────────────────────────────────────────────
  section("Manual draft → review → post");
  const md = (await api("POST", `/v1/merchants/${MID}/cashbook/manual-drafts`, { idem: randomUUID(), body: { entryType: "other_receipt", amountVnd: 50000, occurredAt: new Date().toISOString(), paymentMethod: "cash" } })).json;
  ok("manual draft created (ready)", Boolean(md.reviewId) && md.status === "ready");
  const mdItem = (await api("GET", `/v1/merchants/${MID}/cashbook/review/${md.reviewId}`)).json;
  const mdPost = (await api("POST", `/v1/merchants/${MID}/cashbook/review/${md.reviewId}/post`, { idem: randomUUID(), body: { expectedRowVersion: mdItem.item.rowVersion } })).json;
  ok("manual draft posts an 'in' other_receipt entry", Boolean(mdPost.entryId));

  // ── CBK-12 RLS: cross-tenant is denied ─────────────────────────────────────
  section("CBK-12 RLS cross-tenant");
  const xSum = await api("GET", `/v1/merchants/${MID}/cashbook/summary?period=today`, { token: tokenB });
  ok("merchant B cannot read A's summary (403)", xSum.status === 403, `status ${xSum.status}`);
  const xEntries = await api("GET", `/v1/merchants/${MID}/cashbook/entries`, { token: tokenB });
  ok("merchant B cannot list A's entries (403)", xEntries.status === 403);
  const xReverse = await api("POST", `/v1/merchants/${MID}/cashbook/entries/${payEntryId}/reverse`, { token: tokenB, idem: randomUUID(), body: { reasonCode: "duplicate" } });
  ok("merchant B cannot reverse A's entry (403)", xReverse.status === 403);

  // ── Post-commit hook: a REAL cash sale raises an 'in' entry with no sync ────
  section("Post-commit hook (real cash sale → cashbook entry)");
  const prod = (await api("POST", `/v1/merchants/${MID}/products`, { idem: randomUUID(), body: { draft_id: randomUUID(), name: "Nước suối", productType: "goods", unitCode: "chai", salePrice: 10000, trackInventory: true, openingQty: 100 } })).json;
  const pid = prod?.product?.id;
  const order = (await api("POST", `/v1/merchants/${MID}/orders`, { body: { clientRequestId: randomUUID(), items: [{ productId: pid, quantity: 2 }] } })).json;
  const payRes = await api("POST", "/v1/payments/cash", { idem: randomUUID(), body: { merchantId: MID, orderId: order.order.id, expectedVersion: order.order.version, cashReceived: 20000 } });
  ok("cash sale succeeded", payRes.json?.status === "succeeded");
  const hookLink = await linkCount(MID, "payment", payRes.json.paymentId);
  ok("post-commit hook raised the 'in' entry WITHOUT a sync call", hookLink === 1, `links=${hookLink}`);

  // ── Immutability: no PATCH route on posted entries ─────────────────────────
  section("CBK-08 Immutability");
  const patchEntry = await api("PATCH", `/v1/merchants/${MID}/cashbook/entries/${payEntryId}`, { body: { amountVnd: 1 } });
  ok("no PATCH endpoint for a posted entry (404)", patchEntry.status === 404, `status ${patchEntry.status}`);

  log(`\n──────── F11 e2e: ${PASS} passed, ${FAIL} failed ────────`);
  await pool.end();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error("E2E ERROR:", e); try { await pool.end(); } catch {} process.exit(1); });
