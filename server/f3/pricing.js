// Pure pricing math for Functional 03 (spec 4.1 / 4.2 / 4.3). No I/O — this is
// unit-tested in server/f3/pricing.test.js and is the single source of truth
// used by the preview endpoint, the cash/QR finalize transaction, and the
// return/refund allocation. Money is integer đồng (VND). Quantities are
// numeric(14,3) and may be fractional (kg/lít). All rounding happens here with
// one rule so mobile estimates and the DB agree exactly (FR-04).

/** Round to whole đồng with a single, consistent rule (half away from zero). */
export function roundVnd(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** Clamp a value to [lo, hi]. */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Parse a quantity (number or numeric string) to a finite number ≥ 0. */
export function toQty(q) {
  const n = typeof q === "number" ? q : Number(q);
  if (!Number.isFinite(n) || n < 0) return 0;
  // clamp to 3 decimals (numeric(14,3))
  return Math.round(n * 1000) / 1000;
}

/**
 * The computed amount of one discount adjustment against a base (đồng).
 *  - percent: round(base * rate/100), rate clamped to [0,100]
 *  - fixed / promotion: the given amount
 * The result is clamped to [0, base] by the caller when summing.
 */
export function adjustmentAmount(adj, base) {
  if (adj.kind === "percent") {
    const rate = clamp(Number(adj.rate) || 0, 0, 100);
    return roundVnd((base * rate) / 100);
  }
  const amount = Math.max(0, Math.trunc(Number(adj.amount) || 0));
  return amount;
}

/**
 * Largest-remainder apportionment of `total` across integer weights so the
 * parts are non-negative integers summing EXACTLY to `total`. Used to spread an
 * order-level discount across lines by net weight (spec 4.3), which keeps
 * per-line refund allocation correct later.
 */
export function apportion(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const n = weights.length;
  if (total <= 0 || sum <= 0 || n === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  // distribute the remaining đồng to the largest fractional parts
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const parts = floors.slice();
  for (let k = 0; k < order.length && remainder > 0; k++) {
    parts[order[k].i] += 1;
    remainder -= 1;
  }
  return parts;
}

/**
 * @typedef {{ productId?: string|null, unitPrice: number, quantity: number|string }} PriceLineInput
 * @typedef {{ scope:'line'|'order', kind:'fixed'|'percent'|'promotion', rate?:number, amount?:number, lineNo?:number, reasonCode?:string }} PriceAdjustmentInput
 */

/**
 * Price a full cart (spec 4.1). Returns per-line gross/discount/net (with the
 * order-level discount already allocated into each line's discount_amount so
 * that Σ net = totalAmount), the bill totals, and each adjustment with its
 * computed đồng amount for the order_adjustments audit rows.
 *
 * `lines` are 1-indexed by position → line_no = index + 1. Line adjustments
 * target a line via `lineNo`.
 *
 * @param {PriceLineInput[]} lines
 * @param {PriceAdjustmentInput[]} [adjustments]
 */
export function priceCart(lines, adjustments = []) {
  const priced = lines.map((ln, idx) => {
    const lineNo = idx + 1;
    const qty = toQty(ln.quantity);
    const unitPrice = Math.max(0, Math.trunc(Number(ln.unitPrice) || 0));
    const grossAmount = roundVnd(unitPrice * qty);
    return { lineNo, unitPrice, quantity: qty, grossAmount, lineDiscount: 0 };
  });

  const computedAdjustments = [];

  // 1) Line-scope discounts, clamped so a line never goes below zero.
  for (const adj of adjustments) {
    if (adj.scope !== "line") continue;
    const target = priced.find((p) => p.lineNo === adj.lineNo);
    if (!target) continue;
    const remaining = target.grossAmount - target.lineDiscount;
    const amount = clamp(adjustmentAmount(adj, target.grossAmount), 0, remaining);
    target.lineDiscount += amount;
    computedAdjustments.push({ ...adj, amount, computedAmount: amount });
  }

  const subtotalAmount = priced.reduce((a, p) => a + p.grossAmount, 0);
  const lineDiscountTotal = priced.reduce((a, p) => a + p.lineDiscount, 0);

  // Base eligible for the order-level discount = subtotal after line discounts.
  const orderBase = subtotalAmount - lineDiscountTotal;

  // 2) Order-scope discounts, summed and clamped to the order base.
  let orderDiscountAmount = 0;
  for (const adj of adjustments) {
    if (adj.scope !== "order") continue;
    const remaining = orderBase - orderDiscountAmount;
    const amount = clamp(adjustmentAmount(adj, orderBase), 0, remaining);
    orderDiscountAmount += amount;
    computedAdjustments.push({ ...adj, amount, computedAmount: amount });
  }

  // 3) Allocate the order discount across lines by net weight so Σ net = total.
  const weights = priced.map((p) => p.grossAmount - p.lineDiscount);
  const alloc = apportion(orderDiscountAmount, weights);

  const outLines = priced.map((p, i) => {
    const allocatedOrderDiscount = alloc[i];
    const discountAmount = p.lineDiscount + allocatedOrderDiscount;
    const netAmount = p.grossAmount - discountAmount;
    return {
      lineNo: p.lineNo,
      unitPrice: p.unitPrice,
      quantity: p.quantity,
      grossAmount: p.grossAmount,
      lineDiscount: p.lineDiscount,
      allocatedOrderDiscount,
      discountAmount,
      netAmount,
    };
  });

  const discountAmount = lineDiscountTotal + orderDiscountAmount;
  const totalAmount = subtotalAmount - discountAmount;

  return {
    subtotalAmount,
    lineDiscountTotal,
    orderDiscountAmount,
    discountAmount,
    totalAmount,
    lines: outLines,
    adjustments: computedAdjustments,
  };
}

/**
 * Refund amount for returning `returnQty` units of one order line, using
 * cumulative rounding against the line's net so repeated partial returns never
 * drift past the line net (spec 4.3 "refund dùng net allocated"). Caller must
 * ensure priorReturnedQty + returnQty ≤ originalQty.
 *
 * @param {{ netAmount:number, originalQty:number|string, priorReturnedQty:number|string, returnQty:number|string }} p
 */
export function allocateLineRefund({ netAmount, originalQty, priorReturnedQty, returnQty }) {
  const Q = toQty(originalQty);
  const prior = toQty(priorReturnedQty);
  const q = toQty(returnQty);
  if (Q <= 0 || q <= 0) return 0;
  const after = Math.min(Q, prior + q);
  const refundAfter = roundVnd((netAmount * after) / Q);
  const refundPrior = roundVnd((netAmount * Math.min(Q, prior)) / Q);
  return Math.max(0, refundAfter - refundPrior);
}
