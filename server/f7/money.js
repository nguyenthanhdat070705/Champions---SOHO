// Functional 07 — expense total math (spec 4.1). The SERVER is the sole authority
// for every total; the client/OCR grand_total is never trusted (spec 1 / EXP-FR-05
// / EXP-02). All money is integer VND (bigint on the wire); quantity is
// numeric(14,3). Pure + unit-tested in test/f7-expenses.test.js.
import { fail } from "../f3/errors.js";

/** numeric(14,3) rounding so JS float math matches the DB column exactly. */
export function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Round a money value to a whole VND đồng (bigint domain). */
export function roundVnd(n) {
  return Math.round(Number(n));
}

function asQty(q) {
  const n = round3(q);
  if (!Number.isFinite(n) || n <= 0) fail("VALIDATION", "Số lượng phải lớn hơn 0.");
  return n;
}

function asVndNonNeg(v, label) {
  const n = roundVnd(v);
  if (!Number.isFinite(n) || n < 0) fail("VALIDATION", `${label} không hợp lệ.`);
  return n;
}

/** line_total = round(quantity × unit_cost) — never the client's number. */
export function lineTotal(quantity, unitCostVnd) {
  return roundVnd(asQty(quantity) * asVndNonNeg(unitCostVnd, "Đơn giá"));
}

/**
 * Normalise a raw item list into server-computed lines. Each input item carries
 * { description, quantity, unitCostVnd, taxAmountVnd?, source?, confidence? }.
 * line_total and tax are recomputed here; any client line_total is discarded.
 */
export function normalizeItems(items) {
  const list = Array.isArray(items) ? items : [];
  return list.map((it, i) => {
    const description = String(it.description ?? "").trim();
    if (!description) fail("VALIDATION", `Dòng ${i + 1} thiếu mô tả.`);
    const quantity = asQty(it.quantity ?? 1);
    const unitCostVnd = asVndNonNeg(it.unitCostVnd ?? it.unit_cost_vnd ?? 0, "Đơn giá");
    const taxAmountVnd = asVndNonNeg(it.taxAmountVnd ?? it.tax_amount_vnd ?? 0, "Thuế");
    return {
      description,
      quantity,
      unitCostVnd,
      lineTotalVnd: lineTotal(quantity, unitCostVnd),
      taxAmountVnd,
      source: typeof it.source === "string" ? it.source : "manual",
      confidence: it.confidence == null ? null : round3(it.confidence),
    };
  });
}

/**
 * The canonical totals for an expense (spec 4.1). Two modes:
 *  - line mode  (items present): subtotal = Σ line_total, tax = Σ item tax,
 *                grand = subtotal + tax.
 *  - single mode (no items): the user typed one amount = grand_total; subtotal =
 *                that amount, tax = the optional header tax reference, grand =
 *                subtotal + tax. (Tax is documentary, not a legal conclusion.)
 * @returns {{ items, subtotalVnd, taxAmountVnd, grandTotalVnd }}
 */
export function computeTotals({ items, amountVnd, headerTaxVnd } = {}) {
  const normItems = normalizeItems(items);
  if (normItems.length > 0) {
    const subtotalVnd = normItems.reduce((s, it) => s + it.lineTotalVnd, 0);
    const taxAmountVnd = normItems.reduce((s, it) => s + it.taxAmountVnd, 0);
    return { items: normItems, subtotalVnd, taxAmountVnd, grandTotalVnd: subtotalVnd + taxAmountVnd };
  }
  const subtotalVnd = asVndNonNeg(amountVnd ?? 0, "Tổng chi");
  const taxAmountVnd = asVndNonNeg(headerTaxVnd ?? 0, "Thuế");
  return { items: [], subtotalVnd, taxAmountVnd, grandTotalVnd: subtotalVnd + taxAmountVnd };
}
