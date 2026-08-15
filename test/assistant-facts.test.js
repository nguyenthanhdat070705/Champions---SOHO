import assert from "node:assert/strict";
import test from "node:test";
import { assembleFacts, factsToText, formatQty } from "../server/assistant/facts.js";
import { numbersGrounded } from "../server/assistant/numbers.js";

// Synthetic raw SQL rows (mirrors the seed-today-dashboard expected values so the
// snapshot math is anchored to a known-good reference).
const RAW = {
  store: { display_name: "Tạp hóa Cô Ba", business_model: "retail" },
  today: {
    business_date: "2026-08-15",
    gross: 950000,
    paid_orders: 3,
    refund: 250000,
    cash_in: 650000,
    cash_refund: 250000,
    qr_in: 300000,
    qr_refund: 0,
    pending_qr: 1,
    low_stock_count: 2,
    open_action_count: 0,
  },
  ordersByDay: [
    { d: "2026-08-15", gross: 950000, orders: 3 },
    { d: "2026-08-14", gross: 100000, orders: 1 },
    { d: "2026-08-08", gross: 200000, orders: 2 },
  ],
  refundsByDay: [{ d: "2026-08-15", refund: 250000 }],
  topProducts: [
    { name: "Cà phê", qty: "12.000", revenue: 240000 },
    { name: "Nước suối 500ml", qty: "8.000", revenue: 80000 },
  ],
  lowStock: [{ name: "Nước suối 500ml", on_hand: 2, threshold: 5 }],
  openActions: [],
};

test("formatQty trims trailing zeros but keeps real fractions", () => {
  assert.equal(formatQty("12.000"), "12");
  assert.equal(formatQty("12.500"), "12.5");
  assert.equal(formatQty(3), "3");
  assert.equal(formatQty("0.250"), "0.25");
});

test("assembleFacts: today snapshot matches the F2 window math", () => {
  const f = assembleFacts(RAW);
  assert.equal(f.today.gross, 950000);
  assert.equal(f.today.refund, 250000);
  assert.equal(f.today.net, 700000);
  assert.equal(f.today.cashNet, 400000); // 650000 - 250000
  assert.equal(f.today.qrNet, 300000); // 300000 - 0
  assert.equal(f.today.paidOrderCount, 3);
  assert.equal(f.today.pendingQrCount, 1);
  assert.equal(f.today.lowStockCount, 2);
});

test("assembleFacts: 7-day series + week-over-week is derived correctly", () => {
  const f = assembleFacts(RAW);
  assert.equal(f.week.series.length, 7);
  assert.equal(f.week.series[6].date, "2026-08-15");
  assert.equal(f.week.series[6].net, 700000); // 950000 - 250000
  // last7 = day15 net (700000) + day14 (100000); day08 falls in prev7.
  assert.equal(f.week.last7Net, 800000);
  assert.equal(f.week.prev7Net, 200000);
  assert.equal(f.week.deltaAmount, 600000);
  assert.equal(f.week.deltaPercent, 300);
  assert.equal(f.week.direction, "up");
  assert.equal(f.yesterday.date, "2026-08-14");
  assert.equal(f.yesterday.net, 100000);
});

test("assembleFacts: store + product shaping", () => {
  const f = assembleFacts(RAW);
  assert.equal(f.store.name, "Tạp hóa Cô Ba");
  assert.equal(f.store.businessModelLabel, "Bán lẻ");
  assert.equal(f.topProducts[0].qty, "12"); // "12.000" → "12"
  assert.equal(f.lowStock[0].onHand, 2);
});

test("factsToText renders formatted money and grounds its own numbers", () => {
  const f = assembleFacts(RAW);
  const text = factsToText(f);
  assert.match(text, /700\.000đ/); // net
  assert.match(text, /950\.000đ/); // gross
  assert.match(text, /Tạp hóa Cô Ba/);
  // A reply citing figures from the facts is grounded; an invented one is not.
  assert.equal(numbersGrounded("Hôm nay bán 700.000đ từ 3 bill", text), true);
  assert.equal(numbersGrounded("Hôm nay bán 12.345.678đ", text), false);
});

test("assembleFacts tolerates an empty store (defaults, no throw)", () => {
  const f = assembleFacts({ ...RAW, store: null, topProducts: [], lowStock: [], openActions: [] });
  assert.equal(f.store.name, "Cửa hàng");
  assert.equal(f.store.businessModelLabel, null);
  assert.equal(f.topProducts.length, 0);
});
