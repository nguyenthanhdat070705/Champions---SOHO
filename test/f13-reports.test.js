// Functional 13 — pure-logic unit tests (spec 4 / 12.3). Runs under `node --test`
// with NO database: exercises the metric math, coverage gating, deterministic
// hashing, period presets and CSV export against hand-computed expected values.
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolvePeriod, periodDays, scopeHash, canonicalJson, FORMULA_VERSION, metricLabel,
} from "../server/f13/catalog.js";
import {
  assembleSnapshot, coverageStatus, dimensionsHash, snapshotContentHash, roundVnd,
} from "../server/f13/metrics.js";
import { buildCsv, csvCell } from "../server/f13/export.js";

// ── Period presets (spec RPT-FR-01) ───────────────────────────────────────────
test("resolvePeriod: day/week/month/quarter around 2026-08-16 (Sunday)", () => {
  assert.deepEqual(resolvePeriod("day", "2026-08-16"), { preset: "day", start: "2026-08-16", end: "2026-08-16", label: "Ngày 2026-08-16" });
  const wk = resolvePeriod("week", "2026-08-16"); // Sun → week Mon 10th..Sun 16th
  assert.equal(wk.start, "2026-08-10");
  assert.equal(wk.end, "2026-08-16");
  const mo = resolvePeriod("month", "2026-08-16");
  assert.equal(mo.start, "2026-08-01");
  assert.equal(mo.end, "2026-08-31");
  const q = resolvePeriod("quarter", "2026-08-16"); // Q3 = Jul..Sep
  assert.equal(q.start, "2026-07-01");
  assert.equal(q.end, "2026-09-30");
});

test("periodDays counts inclusive days", () => {
  assert.equal(periodDays("2026-08-16", "2026-08-16"), 1);
  assert.equal(periodDays("2026-08-01", "2026-08-31"), 31);
  assert.equal(periodDays("2026-07-01", "2026-09-30"), 92);
});

// ── Coverage gate — missing must NOT become 0 (spec 4.4 / RPT-05/06) ───────────
test("coverageStatus fractions", () => {
  assert.equal(coverageStatus(0, 0), "complete");   // empty period is fully covered
  assert.equal(coverageStatus(10, 10), "complete");
  assert.equal(coverageStatus(10, 6), "partial");
  assert.equal(coverageStatus(10, 0), "unavailable");
});

// ── The core aggregation (spec 4.1 golden-style check) ─────────────────────────
function sample(overrides = {}) {
  return assembleSnapshot({
    totals: {
      gross: 1_000_000, bill_count: 10, bills_with_items: 6, orders_freshness: null,
      refund: 100_000, cash_collected: 900_000, payments_count: 12, payments_freshness: null,
      cash_in: 600_000, cash_refund: 50_000, qr_in: 400_000, qr_refund: 50_000, ...overrides.totals,
    },
    byDay: overrides.byDay ?? [
      { d: "2026-08-01", gross: 400_000, refund: 0 },
      { d: "2026-08-02", gross: 600_000, refund: 100_000 },
    ],
    topProducts: overrides.topProducts ?? [{ product_id: "p1", name: "Cà phê", revenue: 300_000, qty: 5 }],
    expenseTotal: overrides.expenseTotal ?? { total: 200_000, n: 3, freshness: null },
    expenseByCategory: overrides.expenseByCategory ?? [{ category_id: "c1", category_name: "Mặt bằng", total: 200_000, n: 3 }],
    purchase: overrides.purchase ?? { total: 500_000, n: 2, freshness: null },
    damage: overrides.damage ?? { n: 1, qty: 4, freshness: null },
    periodDayCount: overrides.periodDayCount ?? 3,
    asOf: new Date("2026-08-16T10:00:00Z"),
  });
}
const find = (metrics, code, pred = () => true) => metrics.find((m) => m.metricCode === code && pred(m));

test("assembleSnapshot: sales/expense/estimate exact numbers", () => {
  const { metrics, quality } = sample();
  assert.equal(find(metrics, "sales_gross_revenue").valueVnd, 1_000_000);
  assert.equal(find(metrics, "sales_refund").valueVnd, 100_000);
  assert.equal(find(metrics, "sales_net_revenue").valueVnd, 900_000);
  assert.equal(find(metrics, "sales_bill_count").valueCount, 10);
  assert.equal(find(metrics, "sales_bill_avg").valueVnd, 100_000);
  assert.equal(find(metrics, "sales_by_channel", (m) => m.dimensions.channel === "cash").valueVnd, 550_000);
  assert.equal(find(metrics, "sales_by_channel", (m) => m.dimensions.channel === "qr").valueVnd, 350_000);
  assert.equal(find(metrics, "operating_expense").valueVnd, 200_000);
  assert.equal(find(metrics, "inventory_purchase").valueVnd, 500_000);
  assert.equal(find(metrics, "inventory_damage").valueCount, 1);
  assert.equal(find(metrics, "inventory_damage").dimensions.quantity, 4);
  assert.equal(find(metrics, "cash_collected").valueVnd, 900_000);
  // estimate = net (900k) − operating expense (200k) = 700k; inventory purchase is NOT subtracted
  assert.equal(find(metrics, "operating_result_est").valueVnd, 700_000);
  assert.equal(find(metrics, "operating_result_est").coverageStatus, "complete");
  // daily series present because periodDayCount > 1
  const days = metrics.filter((m) => m.metricCode === "sales_by_day");
  assert.equal(days.length, 2);
  assert.equal(days.find((d) => d.dimensions.date === "2026-08-02").valueVnd, 500_000); // 600k − 100k refund
  // quality: order_items partial (6/10), orders complete
  assert.equal(quality.find((q) => q.sourceType === "order_items").status, "partial");
  assert.equal(quality.find((q) => q.sourceType === "orders").status, "complete");
});

test("top-products coverage tracks order_items availability", () => {
  const partial = sample();
  assert.equal(find(partial.metrics, "sales_top_products").coverageStatus, "partial");
  // no bills carry items → no top rows, and order_items coverage is unavailable
  const none = sample({ totals: { bills_with_items: 0 }, topProducts: [] });
  assert.equal(none.metrics.filter((m) => m.metricCode === "sales_top_products").length, 0);
  assert.equal(none.quality.find((q) => q.sourceType === "order_items").status, "unavailable");
});

test("single-day period hides the daily series (spec 3.2)", () => {
  const { metrics } = sample({ periodDayCount: 1 });
  assert.equal(metrics.filter((m) => m.metricCode === "sales_by_day").length, 0);
});

test("missing data is never coerced to 0 for top products", () => {
  // zero bills at all → net revenue is a legitimate 0, but coverage still complete
  const empty = sample({ totals: { gross: 0, bill_count: 0, bills_with_items: 0, refund: 0, cash_collected: 0, payments_count: 0, cash_in: 0, cash_refund: 0, qr_in: 0, qr_refund: 0 }, topProducts: [], byDay: [] });
  assert.equal(find(empty.metrics, "sales_net_revenue").valueVnd, 0);
  assert.equal(empty.quality.find((q) => q.sourceType === "order_items").status, "complete"); // 0/0
});

// ── Deterministic hashing (spec 4.2 / NFR consistency) ─────────────────────────
test("snapshotContentHash is stable + order-independent", () => {
  const header = { merchantId: "m1", periodStart: "2026-08-01", periodEnd: "2026-08-31", timezone: "Asia/Ho_Chi_Minh", scopeHash: scopeHash({}), formulaVersion: FORMULA_VERSION };
  const { metrics, quality } = sample();
  const h1 = snapshotContentHash(header, metrics, quality);
  const shuffled = [...metrics].reverse();
  const h2 = snapshotContentHash(header, shuffled, [...quality].reverse());
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  // a changed number changes the hash
  const changed = metrics.map((m) => (m.metricCode === "sales_gross_revenue" ? { ...m, valueVnd: 999 } : m));
  assert.notEqual(h1, snapshotContentHash(header, changed, quality));
});

test("dimensionsHash + scopeHash are canonical (key-order independent)", () => {
  assert.equal(dimensionsHash({ a: 1, b: 2 }), dimensionsHash({ b: 2, a: 1 }));
  assert.equal(scopeHash({ x: 1, y: 2 }), scopeHash({ y: 2, x: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(roundVnd(100.6), 101);
});

// ── CSV export (spec 12.2 injection-safe + parity) ─────────────────────────────
test("csvCell escapes quotes/commas and neutralizes formula injection", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+84"), "'+84");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell(1000000), "1000000");
});

test("buildCsv includes BOM, key numbers and disclosure", () => {
  const dto = {
    snapshot: { periodLabel: "Tháng 08/2026", periodStart: "2026-08-01", periodEnd: "2026-08-31", timezone: "Asia/Ho_Chi_Minh", asOf: "2026-08-16T10:00:00.000Z", formulaVersion: FORMULA_VERSION, revision: 1, contentHash: "abc123" },
    sections: {
      sales: { grossVnd: 1_000_000, refundVnd: 100_000, netVnd: 900_000, billCount: 10, billAvgVnd: 100_000, byChannel: [{ channel: "cash", label: "Tiền mặt", netVnd: 550_000 }], byDay: [], topProducts: [{ rank: 1, name: "Cà phê", productId: "p1", revenueVnd: 300_000, qty: 5 }], topCoverage: "partial" },
      expense: { totalVnd: 200_000, byCategory: [{ categoryId: "c1", categoryName: "Mặt bằng", totalVnd: 200_000 }], coverage: "complete" },
      inventory: { purchaseVnd: 500_000, damageCount: 1, damageQty: 4 },
      cashflow: { cashCollectedVnd: 900_000, expensePaidVnd: 200_000, deltaVnd: 700_000 },
      estimate: { valueVnd: 700_000, coverage: "complete", formula: "x", disclosures: ["Đây là số TẠM TÍNH, không phải lợi nhuận kế toán hay cơ sở tính thuế."] },
    },
    coverage: { overall: "partial", percent: 60, sources: [{ label: "Chi tiết dòng bill", processed: 6, expected: 10, status: "partial", openIssues: 0, freshnessAt: null }], notes: ["Số liệu phủ 60% — 4 bill cũ thiếu chi tiết dòng (ảnh hưởng Top sản phẩm)."] },
  };
  const csv = buildCsv(dto);
  assert.ok(csv.startsWith("﻿"), "starts with UTF-8 BOM");
  assert.match(csv, /900000/);         // net revenue
  assert.match(csv, /Cà phê/);          // top product
  assert.match(csv, /TẠM TÍNH/);        // estimate disclosure
  assert.match(csv, /Số liệu phủ 60%/); // coverage note
  assert.equal(metricLabel("sales_net_revenue"), "Doanh thu thuần");
});
