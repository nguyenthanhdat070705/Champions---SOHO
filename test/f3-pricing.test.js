import assert from "node:assert/strict";
import test from "node:test";
import {
  priceCart,
  allocateLineRefund,
  apportion,
  roundVnd,
  adjustmentAmount,
} from "../server/f3/pricing.js";

test("roundVnd rounds half away from zero", () => {
  assert.equal(roundVnd(2.5), 3);
  assert.equal(roundVnd(2.4), 2);
  assert.equal(roundVnd(0), 0);
});

test("plain cart: gross = unit_price × quantity, total = subtotal (spec 4.1)", () => {
  const r = priceCart([
    { productId: "w", unitPrice: 10000, quantity: 2 },
    { productId: "c", unitPrice: 15000, quantity: 1 },
  ]);
  assert.equal(r.subtotalAmount, 35000);
  assert.equal(r.discountAmount, 0);
  assert.equal(r.totalAmount, 35000);
  assert.equal(r.lines[0].netAmount, 20000);
  assert.equal(r.lines[1].netAmount, 15000);
});

test("line percent discount (spec 4.3: 2×10.000, -10% → net 18.000)", () => {
  const r = priceCart(
    [{ productId: "w", unitPrice: 10000, quantity: 2 }],
    [{ scope: "line", kind: "percent", rate: 10, lineNo: 1 }],
  );
  assert.equal(r.lines[0].grossAmount, 20000);
  assert.equal(r.lines[0].discountAmount, 2000);
  assert.equal(r.lines[0].netAmount, 18000);
  assert.equal(r.totalAmount, 18000);
});

test("order fixed discount (spec 4.3: subtotal 100.000 − 15.000 → 85.000)", () => {
  const r = priceCart(
    [
      { unitPrice: 40000, quantity: 1 },
      { unitPrice: 60000, quantity: 1 },
    ],
    [{ scope: "order", kind: "fixed", amount: 15000, reasonCode: "LOYAL" }],
  );
  assert.equal(r.subtotalAmount, 100000);
  assert.equal(r.discountAmount, 15000);
  assert.equal(r.totalAmount, 85000);
  // Σ net == total, allocated by weight (40/60)
  assert.equal(r.lines[0].netAmount + r.lines[1].netAmount, 85000);
  assert.equal(r.lines[0].discountAmount, 6000);
  assert.equal(r.lines[1].discountAmount, 9000);
});

test("discount never drives a line or total below zero", () => {
  const r = priceCart(
    [{ unitPrice: 10000, quantity: 1 }],
    [
      { scope: "line", kind: "fixed", amount: 999999, lineNo: 1 },
      { scope: "order", kind: "fixed", amount: 999999 },
    ],
  );
  assert.equal(r.lines[0].netAmount, 0);
  assert.equal(r.totalAmount, 0);
  assert.ok(r.discountAmount <= r.subtotalAmount);
});

test("apportion distributes exactly with largest remainder", () => {
  const parts = apportion(10, [1, 1, 1]); // 3.33 each
  assert.equal(parts.reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(parts, [4, 3, 3]);
});

test("adjustmentAmount: percent of base rounds; fixed passes through", () => {
  assert.equal(adjustmentAmount({ kind: "percent", rate: 10 }, 20000), 2000);
  assert.equal(adjustmentAmount({ kind: "fixed", amount: 5000 }, 20000), 5000);
  assert.equal(adjustmentAmount({ kind: "percent", rate: 150 }, 100), 100); // clamped to 100%
});

test("fractional quantity (kg) rounds line gross once", () => {
  const r = priceCart([{ unitPrice: 45000, quantity: "1.250" }]); // 56250
  assert.equal(r.lines[0].grossAmount, 56250);
  assert.equal(r.totalAmount, 56250);
});

test("refund allocation: cumulative rounding never exceeds line net", () => {
  // line net 18000 over qty 2 → each unit ~9000
  assert.equal(
    allocateLineRefund({ netAmount: 18000, originalQty: 2, priorReturnedQty: 0, returnQty: 1 }),
    9000,
  );
  // returning the second unit gets the remainder, total == net
  const first = allocateLineRefund({ netAmount: 18001, originalQty: 2, priorReturnedQty: 0, returnQty: 1 });
  const second = allocateLineRefund({ netAmount: 18001, originalQty: 2, priorReturnedQty: 1, returnQty: 1 });
  assert.equal(first + second, 18001);
});

test("refund allocation caps returnQty at remaining", () => {
  const full = allocateLineRefund({ netAmount: 30000, originalQty: 3, priorReturnedQty: 2, returnQty: 5 });
  // only 1 unit remained → ~10000
  assert.equal(full, 10000);
});
