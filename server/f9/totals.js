// Functional 09 — server-side totals + canonical payload hashing (spec 4.1, 4.2,
// 9.3). The SERVER always recomputes money from the order snapshot; the client or
// AI total is never trusted (INV-03). VN retail prices are tax-INCLUSIVE, so each
// order line's net amount IS the amount the customer paid; the tax is extracted out
// of it. That keeps invoice.total EXACTLY equal to the bill total (reconciles with
// F03) instead of re-grossing and drifting by rounding.
import { createHash } from "node:crypto";
import { resolveLineTax } from "./mapping.js";

/** Integer đồng rounding (VND has no minor unit; amounts are bigint columns). */
export function roundVnd(n) {
  return Math.round(Number(n) || 0);
}

/**
 * Build the invoice line snapshots from order_items. Each order line's inclusive
 * net becomes the line total; tax is extracted at the resolved rate:
 *   tax     = round(lineTotal * rate / (1 + rate))
 *   taxable = lineTotal - tax
 * @param {Array} orderItems rows shaped by F03 loadFullOrderTx (name/unitCode/…)
 * @returns {Array} invoice item snapshots
 */
export function buildInvoiceLines(orderItems) {
  return (orderItems || []).map((it) => {
    const lineTotal = roundVnd(it.netAmount);
    const { taxCode, taxRate } = resolveLineTax(it);
    const taxVnd = taxRate > 0 ? roundVnd((lineTotal * taxRate) / (1 + taxRate)) : 0;
    const taxableVnd = lineTotal - taxVnd;
    const quantity = Number(it.quantity) || 0;
    // Inclusive unit price kept as a snapshot; guarded against divide-by-zero.
    const unitPriceVnd = quantity > 0 ? roundVnd(lineTotal / quantity) : roundVnd(it.unitPrice);
    return {
      orderItemId: it.id,
      description: it.name,
      unit: it.unitCode || "cái",
      quantity,
      unitPriceVnd,
      taxCode,
      taxRate,
      lineTotalVnd: lineTotal,
      taxableVnd,
      taxVnd,
    };
  });
}

/**
 * Sum invoice lines into the header totals (spec 4.1). total = Σ lineTotal (== bill
 * total), tax = Σ tax, subtotal = total − tax (the taxable base).
 * @returns {{ subtotalVnd, taxVnd, totalVnd }}
 */
export function sumInvoiceTotals(lines) {
  let totalVnd = 0;
  let taxVnd = 0;
  for (const l of lines || []) {
    totalVnd += roundVnd(l.lineTotalVnd);
    taxVnd += roundVnd(l.taxVnd);
  }
  return { subtotalVnd: totalVnd - taxVnd, taxVnd, totalVnd };
}

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * The canonical frozen payload — exactly what gets hashed and (conceptually) sent
 * to the provider. Only invoice-defining fields; no timestamps, no server ids that
 * would make an identical invoice hash differently.
 */
export function buildCanonicalPayload({ ruleSetVersion, invoiceKind, seller, buyer, lines, totals }) {
  return {
    ruleSetVersion,
    invoiceKind,
    seller: {
      legalName: seller?.legalName ?? null,
      taxCode: seller?.taxCode ?? null,
      address: seller?.address ?? null,
    },
    buyer: {
      kind: buyer?.kind ?? "individual",
      name: buyer?.name ?? null,
      taxCode: buyer?.taxCode ?? null,
      address: buyer?.address ?? null,
      email: buyer?.email ?? null,
    },
    lines: (lines || []).map((l) => ({
      orderItemId: l.orderItemId,
      description: l.description,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceVnd: l.unitPriceVnd,
      taxCode: l.taxCode,
      taxRate: l.taxRate,
      lineTotalVnd: l.lineTotalVnd,
      taxVnd: l.taxVnd,
    })),
    totals,
  };
}

/** sha256 hex of the canonical payload (spec 9.3 payload_hash). */
export function payloadHashOf(canonicalPayload) {
  return createHash("sha256").update(canonicalize(canonicalPayload)).digest("hex");
}
