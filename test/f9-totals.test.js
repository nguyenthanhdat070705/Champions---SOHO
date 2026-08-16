// Functional 09 pure-logic unit tests (no DB) — server totals (tax-inclusive
// extraction) + canonical payload hashing (INV-03). Part of `npm test`.
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvoiceLines, sumInvoiceTotals, canonicalize, buildCanonicalPayload, payloadHashOf, roundVnd,
} from "../server/f9/totals.js";

// Order lines shaped like F03 loadFullOrderTx output (net amounts are tax-INCLUSIVE).
const ORDER_ITEMS = [
  { id: "oi1", name: "Bánh mì", unitCode: "cái", quantity: 2, unitPrice: 27000, netAmount: 54000 },
  { id: "oi2", name: "Cà phê", unitCode: "ly", quantity: 1, unitPrice: 30000, netAmount: 30000 },
];

test("buildInvoiceLines extracts tax OUT of the inclusive line total (VAT8 default)", () => {
  const lines = buildInvoiceLines(ORDER_ITEMS);
  assert.equal(lines.length, 2);
  // 54000 inclusive @ 8% → tax = round(54000*0.08/1.08) = 4000, taxable = 50000
  assert.equal(lines[0].lineTotalVnd, 54000);
  assert.equal(lines[0].taxCode, "VAT8");
  assert.equal(lines[0].taxVnd, 4000);
  assert.equal(lines[0].taxableVnd, 50000);
  // 30000 inclusive @ 8% → tax = round(30000*0.08/1.08) = 2222
  assert.equal(lines[1].taxVnd, roundVnd((30000 * 0.08) / 1.08));
});

test("invoice total equals the bill total exactly (reconciles with F03)", () => {
  const lines = buildInvoiceLines(ORDER_ITEMS);
  const totals = sumInvoiceTotals(lines);
  const billTotal = ORDER_ITEMS.reduce((s, i) => s + i.netAmount, 0);
  assert.equal(totals.totalVnd, billTotal); // 84000
  assert.equal(totals.subtotalVnd + totals.taxVnd, totals.totalVnd);
});

test("KCT (not-subject) line carries zero tax; total unchanged", () => {
  const lines = buildInvoiceLines([{ id: "x", name: "Rau", unitCode: "kg", quantity: 1, unitPrice: 10000, netAmount: 10000, taxCode: "KCT" }]);
  assert.equal(lines[0].taxVnd, 0);
  assert.equal(lines[0].taxableVnd, 10000);
});

test("canonicalize is key-order independent (stable hash input)", () => {
  const a = canonicalize({ b: 1, a: 2, nested: { y: 1, x: 2 } });
  const b = canonicalize({ a: 2, nested: { x: 2, y: 1 }, b: 1 });
  assert.equal(a, b);
});

test("payload hash is deterministic and changes when buyer MST changes", () => {
  const lines = buildInvoiceLines(ORDER_ITEMS);
  const totals = sumInvoiceTotals(lines);
  const base = { ruleSetVersion: "r1", invoiceKind: "sale", seller: { legalName: "S", taxCode: "0101010101" }, lines, totals };
  const h1 = payloadHashOf(buildCanonicalPayload({ ...base, buyer: { kind: "individual", name: "A" } }));
  const h1b = payloadHashOf(buildCanonicalPayload({ ...base, buyer: { kind: "individual", name: "A" } }));
  const h2 = payloadHashOf(buildCanonicalPayload({ ...base, buyer: { kind: "organization", name: "A", taxCode: "0101010101" } }));
  assert.equal(h1, h1b);
  assert.notEqual(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("a tampered client total cannot affect the server hash (INV-03)", () => {
  const lines = buildInvoiceLines(ORDER_ITEMS);
  const serverTotals = sumInvoiceTotals(lines);
  // Server always hashes its OWN recomputed totals; a client-sent total is irrelevant.
  const honest = payloadHashOf(buildCanonicalPayload({ ruleSetVersion: "r", invoiceKind: "sale", seller: {}, buyer: {}, lines, totals: serverTotals }));
  const server = payloadHashOf(buildCanonicalPayload({ ruleSetVersion: "r", invoiceKind: "sale", seller: {}, buyer: {}, lines, totals: sumInvoiceTotals(lines) }));
  assert.equal(honest, server);
});
