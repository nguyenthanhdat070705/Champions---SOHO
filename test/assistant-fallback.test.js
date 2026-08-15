import assert from "node:assert/strict";
import test from "node:test";
import { detectIntent, fallbackAnswer } from "../server/assistant/fallback.js";
import { assembleFacts, factsToText } from "../server/assistant/facts.js";
import { numbersGrounded } from "../server/assistant/numbers.js";
import { resolveSources, resolveActions } from "../server/assistant/registry.js";

const FACTS = assembleFacts({
  store: { display_name: "Tạp hóa Cô Ba", business_model: "retail" },
  today: {
    business_date: "2026-08-15",
    gross: 950000, paid_orders: 3, refund: 250000,
    cash_in: 650000, cash_refund: 250000, qr_in: 300000, qr_refund: 0,
    pending_qr: 1, low_stock_count: 2, open_action_count: 0,
  },
  ordersByDay: [
    { d: "2026-08-15", gross: 950000, orders: 3 },
    { d: "2026-08-14", gross: 100000, orders: 1 },
    { d: "2026-08-08", gross: 200000, orders: 2 },
  ],
  refundsByDay: [{ d: "2026-08-15", refund: 250000 }],
  topProducts: [{ name: "Cà phê", qty: "12.000", revenue: 240000 }],
  lowStock: [{ name: "Nước suối 500ml", on_hand: 2, threshold: 5 }],
  openActions: [{ title: "Kết nối thanh toán cần kiểm tra", severity: "warning", description: null }],
});
const FACTS_TEXT = factsToText(FACTS);

test("detectIntent maps the starter questions correctly", () => {
  assert.equal(detectIntent("Hôm nay bán được bao nhiêu?"), "revenue_today");
  assert.equal(detectIntent("Món nào sắp hết hàng?"), "low_stock");
  assert.equal(detectIntent("Tuần này so với tuần trước thế nào?"), "week_compare");
  assert.equal(detectIntent("Có việc gì cần xử lý không?"), "attention");
});

test("detectIntent flags write-intents (F7-9 not built) and out-of-scope asks", () => {
  assert.equal(detectIntent("Ghi tiền điện hôm nay một triệu hai"), "do_expense");
  assert.equal(detectIntent("Nhập thêm 10 thùng nước"), "do_inventory");
  assert.equal(detectIntent("Xuất hóa đơn đỏ cho khách"), "do_invoice");
  assert.equal(detectIntent("Lợi nhuận tháng này bao nhiêu?"), "unknown");
});

test("every fallback answer for starters is grounded and clean", () => {
  for (const q of [
    "Hôm nay bán được bao nhiêu?",
    "Món nào sắp hết hàng?",
    "Tuần này so với tuần trước thế nào?",
    "Có việc gì cần xử lý không?",
    "Sản phẩm nào bán chạy nhất?",
  ]) {
    const a = fallbackAnswer(FACTS, q);
    assert.ok(a.message.length > 0, q);
    assert.equal(numbersGrounded(a.message, FACTS_TEXT), true, `grounded: ${q}`);
    assert.ok(!/công nợ|chưa thu|phải thu/i.test(a.message), `no forbidden: ${q}`);
    // numeric answers carry a source card
    assert.ok(resolveSources(a.sourceKeys).length >= 1, `has source: ${q}`);
  }
});

test("revenue fallback cites today's net, bill count and cash/QR split", () => {
  const a = fallbackAnswer(FACTS, "Hôm nay bán được bao nhiêu?");
  assert.match(a.message, /700\.000đ/);
  assert.match(a.message, /3 bill/);
  assert.match(a.message, /400\.000đ/); // cash
  assert.match(a.message, /300\.000đ/); // qr
  assert.deepEqual(a.sourceKeys, ["today"]);
});

test("low-stock fallback lists the product with its on-hand", () => {
  const a = fallbackAnswer(FACTS, "Món nào sắp hết hàng?");
  assert.match(a.message, /Nước suối 500ml/);
  assert.match(a.message, /còn 2/);
  assert.equal(resolveSources(a.sourceKeys)[0].route, "/kho");
});

test("write-intent fallback refuses honestly and never claims it acted", () => {
  const a = fallbackAnswer(FACTS, "Ghi chi phí tiền điện");
  assert.equal(a.kind, "refusal");
  assert.match(a.message, /sắp có|đang được xây/);
  assert.ok(!/đã ghi|đã tạo|đã lưu|hoàn tất/i.test(a.message));
});

test("out-of-scope question gets an honest 'chưa đủ dữ liệu'", () => {
  const a = fallbackAnswer(FACTS, "Lợi nhuận tháng này bao nhiêu?");
  assert.match(a.message, /chưa đủ dữ liệu/);
});

test("registry resolves known keys and drops unknown / duplicates", () => {
  assert.deepEqual(resolveSources(["today", "nope", "today"]).map((s) => s.key), ["today"]);
  assert.equal(resolveActions(["create_bill"])[0].route, "/ban-hang");
  assert.equal(resolveActions(["bad_key"]).length, 0);
});
