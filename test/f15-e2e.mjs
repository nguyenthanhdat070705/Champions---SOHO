// Functional 15 live E2E (spec §12.3 P0). Runs the record-builder → books →
// period-lock → tax-package → export → restatement flow against the REAL DB on a
// throwaway merchant (soho-crew-test+f15, +f15b for RLS). Never touches the two
// real merchants. Requires the combined server running with .env on $PORT:
//   PORT=3015 node --env-file=.env server/index.js &
//   F15_BASE=http://localhost:3015 node --env-file=.env test/f15-e2e.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ensureF15, openPool, seedLateSale, netRevenue, PERIOD, NET_REVENUE,
} from "./f15-setup.mjs";

const BASE = process.env.F15_BASE || "http://localhost:3015";
let ctx;
let pass = 0, fail = 0;

async function api(method, path, { token, body, idem } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const M = () => ctx.merchantId;
const T = () => ctx.token;

/** Clean slate on the throwaway merchant so the run is deterministic: drop all
 *  F15-derived rows + the late-sale source (re-seeded fresh in the restatement step). */
async function cleanup(merchantId) {
  const pool = openPool();
  try {
    await pool.query(`delete from public.accounting_exports where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.tax_data_package_lines where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.tax_data_packages where merchant_id=$1`, [merchantId]);
    await pool.query(`update public.accounting_periods set current_snapshot_id=null where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.accounting_period_snapshots where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.accounting_periods where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.accounting_record_sources s using public.accounting_records r where s.record_id=r.id and r.merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.accounting_records where merchant_id=$1`, [merchantId]);
    await pool.query(`delete from public.accounting_source_receipts where merchant_id=$1`, [merchantId]);
    // Remove the late sale so it is genuinely a post-lock arrival this run.
    await pool.query(`delete from public.payments where merchant_id=$1 and idempotency_key='f15-pay-julylate'`, [merchantId]);
    await pool.query(`delete from public.orders where merchant_id=$1 and order_number like '%julylate'`, [merchantId]);
  } finally { await pool.end(); }
}

async function run() {
  ctx = await ensureF15();
  await cleanup(M());
  console.log(`F15 E2E — merchant ${M()} @ ${BASE}, period ${PERIOD}`);

  // ── Sync (record builder) ──────────────────────────────────────────────────
  await test("ATD-01 sync builds records; replay is idempotent (no new records)", async () => {
    const r1 = await api("POST", `/v1/merchants/${M()}/accounting/sync`, { token: T(), body: { from: "2026-01-01", to: "2026-09-30" } });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.ok(r1.json.mapped + r1.json.replayed >= 5);
    const r2 = await api("POST", `/v1/merchants/${M()}/accounting/sync`, { token: T(), body: { from: "2026-01-01", to: "2026-09-30" } });
    assert.equal(r2.json.mapped, 0, "second sync creates no new records");
    assert.equal(r2.json.records, 0, "no records added on replay");
  });

  // ── Parity + book totals ───────────────────────────────────────────────────
  let overview;
  await test("parity: sổ doanh thu net == payments − refunds (F02/F13 oracle)", async () => {
    const r = await api("GET", `/v1/merchants/${M()}/accounting/overview?period=${PERIOD}`, { token: T() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    overview = r.json;
    const pool = openPool();
    let oracle;
    try { oracle = await netRevenue(pool, M(), "2026-07-01", "2026-07-31"); } finally { await pool.end(); }
    assert.equal(overview.revenueVnd, oracle, `book ${overview.revenueVnd} vs oracle ${oracle}`);
    assert.equal(overview.revenueVnd, NET_REVENUE);
  });

  await test("ATD-04 book totals per S-HKD book are exact + coverage complete", async () => {
    const by = Object.fromEntries(overview.books.map((b) => [b.code, b.total]));
    assert.equal(by.sales_revenue, 300_000_000);
    assert.equal(by.cash_book, 200_000_000);
    assert.equal(by.bank_book, 100_000_000);
    assert.equal(by.expenses, -50_000_000);
    assert.equal(by.materials_goods, 400_000_000);
    assert.equal(overview.coverage.complete, true, JSON.stringify(overview.coverage));
    assert.equal(overview.canLock, true);
  });

  await test("book ledger drills a revenue line to its source route", async () => {
    const r = await api("GET", `/v1/merchants/${M()}/accounting/books/sales_revenue?period=${PERIOD}`, { token: T() });
    assert.equal(r.status, 200);
    assert.ok(r.json.lines.length >= 3);
    const withSource = r.json.lines.find((l) => l.source && l.source.route);
    assert.ok(withSource, "a line has a source deep-link");
    assert.match(withSource.source.route, /^\/don-hang\//);
  });

  // ── Lock (snapshot) ────────────────────────────────────────────────────────
  let snapshotV1, previewHashV1;
  await test("ATD-06/08 preview → lock freezes v1; same key replays same snapshot", async () => {
    const pv = await api("POST", `/v1/merchants/${M()}/accounting/periods/preview`, { token: T(), body: { period: PERIOD } });
    assert.equal(pv.status, 200, JSON.stringify(pv.json));
    assert.equal(pv.json.canLock, true, JSON.stringify(pv.json.blocking));
    assert.equal(pv.json.versionNo, 1);
    previewHashV1 = pv.json.previewHash;
    const idem = randomUUID();
    const body = { period: PERIOD, previewHash: pv.json.previewHash, asOf: pv.json.asOf, responsibilityConfirmed: true };
    const lk = await api("POST", `/v1/merchants/${M()}/accounting/periods/lock`, { token: T(), body, idem });
    assert.equal(lk.status, 201, JSON.stringify(lk.json));
    assert.equal(lk.json.versionNo, 1);
    snapshotV1 = lk.json.snapshotId;
    const again = await api("POST", `/v1/merchants/${M()}/accounting/periods/lock`, { token: T(), body, idem });
    assert.equal(again.json.snapshotId, snapshotV1, "same snapshot on replay");
    assert.equal(again.json.replayed, true);
  });

  await test("ATD-07 lock with a stale preview hash → 409, no new snapshot", async () => {
    const r = await api("POST", `/v1/merchants/${M()}/accounting/periods/lock`, {
      token: T(), idem: randomUUID(),
      body: { period: PERIOD, previewHash: "sha256:staleeeee", asOf: new Date().toISOString(), responsibilityConfirmed: true },
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
  });

  // ── Tax data package ───────────────────────────────────────────────────────
  let packageHash;
  await test("ATD-10 package: 1-tỷ threshold split hand-verified + deterministic", async () => {
    const b1 = await api("POST", `/v1/merchants/${M()}/tax-data/packages`, { token: T(), body: { snapshotId: snapshotV1 }, idem: randomUUID() });
    assert.equal(b1.status, 201, JSON.stringify(b1.json));
    packageHash = b1.json.contentHash;
    const pg = await api("GET", `/v1/merchants/${M()}/tax-data/packages/${b1.json.packageId}`, { token: T() });
    const t = pg.json.package.totals;
    assert.equal(t.revenueVnd, 300_000_000);
    assert.equal(t.priorCumulativeVnd, 900_000_000);
    assert.equal(t.newCumulativeVnd, 1_200_000_000);
    assert.equal(t.taxablePortionVnd, 200_000_000);
    assert.equal(t.exemptPortionVnd, 100_000_000);
    assert.equal(t.gtgtEstimateVnd, 2_000_000);
    assert.equal(t.tncnEstimateVnd, 1_000_000);
    assert.equal(t.totalEstimateVnd, 3_000_000);
    assert.equal(t.channels.cash, 200_000_000);
    assert.equal(t.channels.bank, 100_000_000);
    assert.ok(pg.json.disclaimer.includes("KHÔNG phải"));
    // Rebuild → deterministic same hash, replayed.
    const b2 = await api("POST", `/v1/merchants/${M()}/tax-data/packages`, { token: T(), body: { snapshotId: snapshotV1 }, idem: randomUUID() });
    assert.equal(b2.json.contentHash, packageHash);
    assert.equal(b2.json.replayed, true);
  });

  // ── Export ─────────────────────────────────────────────────────────────────
  await test("ATD-11 export CSV deterministic (same hash) + BOM + revenue in bytes", async () => {
    const e1 = await api("POST", `/v1/merchants/${M()}/accounting/exports`, { token: T(), body: { snapshotId: snapshotV1, scope: { kind: "all_books" }, format: "csv" } });
    assert.equal(e1.status, 201, JSON.stringify(e1.json));
    const e2 = await api("POST", `/v1/merchants/${M()}/accounting/exports`, { token: T(), body: { snapshotId: snapshotV1, scope: { kind: "all_books" }, format: "csv" } });
    assert.equal(e2.json.contentHash, e1.json.contentHash, "byte-stable export");
    assert.equal(e2.json.replayed, true);
    const dl = await fetch(`${BASE}/v1/merchants/${M()}/accounting/exports/${e1.json.exportId}/download`, { headers: { Authorization: `Bearer ${T()}` } });
    assert.equal(dl.status, 200);
    const bytes = new Uint8Array(await dl.arrayBuffer()); // arrayBuffer, not text() (which strips the BOM)
    assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, "UTF-8 BOM bytes");
    const csv = Buffer.from(bytes).toString("utf8");
    assert.ok(csv.includes("300000000") || csv.includes("220000000"), "revenue bytes present");
  });

  // ── Late source → attention → restatement (v2), v1 immutable ────────────────
  let snapshotV1Revenue;
  await test("captures v1 frozen revenue before restatement", async () => {
    const s = await api("GET", `/v1/merchants/${M()}/accounting/snapshots/${snapshotV1}`, { token: T() });
    const rev = (s.json.snapshot.books || []).find((b) => b.code === "sales_revenue");
    snapshotV1Revenue = rev ? rev.total : null;
    assert.equal(snapshotV1Revenue, 300_000_000);
  });

  await test("ATD-12/13 late sale → attention → re-lock v2 (chained); v1 immutable", async () => {
    const pool = openPool();
    try { await seedLateSale(pool, M(), ctx.userId); } finally { await pool.end(); }
    // Sync the late sale into records → it lands in a locked period → attention.
    await api("POST", `/v1/merchants/${M()}/accounting/sync`, { token: T(), body: { from: "2026-07-01", to: "2026-07-31" } });
    const ov = await api("GET", `/v1/merchants/${M()}/accounting/overview?period=${PERIOD}`, { token: T() });
    assert.equal(ov.json.period.status, "attention", "period flips to attention");
    assert.ok(ov.json.lateCount >= 1, "late records detected");
    // Re-preview (new fingerprint) → lock v2.
    const pv = await api("POST", `/v1/merchants/${M()}/accounting/periods/preview`, { token: T(), body: { period: PERIOD } });
    assert.notEqual(pv.json.previewHash, previewHashV1, "fingerprint changed");
    assert.equal(pv.json.versionNo, 2);
    const lk = await api("POST", `/v1/merchants/${M()}/accounting/periods/lock`, {
      token: T(), idem: randomUUID(),
      body: { period: PERIOD, previewHash: pv.json.previewHash, asOf: pv.json.asOf, responsibilityConfirmed: true },
    });
    assert.equal(lk.status, 201, JSON.stringify(lk.json));
    assert.equal(lk.json.versionNo, 2);
    // v1 snapshot unchanged (immutability) + chain preserved.
    const s1 = await api("GET", `/v1/merchants/${M()}/accounting/snapshots/${snapshotV1}`, { token: T() });
    const rev1 = (s1.json.snapshot.books || []).find((b) => b.code === "sales_revenue");
    assert.equal(rev1.total, snapshotV1Revenue, "v1 revenue immutable");
    const list = await api("GET", `/v1/merchants/${M()}/accounting/snapshots?period=${PERIOD}`, { token: T() });
    const v2 = list.json.snapshots.find((s) => s.versionNo === 2);
    assert.equal(v2.previousSnapshotId, snapshotV1, "v2 chains to v1");
    assert.equal(v2.isCurrent, true);
  });

  // ── RLS ────────────────────────────────────────────────────────────────────
  await test("ATD-14 RLS: merchant B cannot read merchant A's overview", async () => {
    const r = await api("GET", `/v1/merchants/${M()}/accounting/overview?period=${PERIOD}`, { token: ctx.tokenB });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    const s = await api("GET", `/v1/merchants/${M()}/accounting/snapshots/${snapshotV1}`, { token: ctx.tokenB });
    assert.equal(s.status, 403);
  });

  await test("ATD-17 catalog is a published reviewed version with legal basis", async () => {
    const r = await api("GET", `/v1/merchants/${M()}/accounting/catalog`, { token: T() });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "published");
    assert.ok(r.json.legalBasis.sources.some((s) => /152\/2025/.test(s.title)));
  });

  console.log(`\nF15 E2E: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error("E2E crashed:", e); process.exit(1); });
