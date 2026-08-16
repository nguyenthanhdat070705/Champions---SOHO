// Functional 07 pure-logic unit tests (no DB) — total math (spec 4.1) and
// duplicate signals (spec 4.2). Part of `npm test` (node --test), so they run
// WITHOUT DATABASE_URL.
import assert from "node:assert/strict";
import test from "node:test";
import { lineTotal, computeTotals, normalizeItems, round3 } from "../server/f7/money.js";
import {
  normalizePayee, dayDiff, payeeSimilarity, matchSignal, findDuplicates,
} from "../server/f7/duplicates.js";
import { normalizeReceiptDraft } from "../server/f7/gemini.js";
import { DomainError } from "../server/f3/errors.js";

// ── Totals (spec 4.1 / EXP-02: server is the sole authority) ─────────────────
test("lineTotal = round(qty × unit_cost), integer VND", () => {
  assert.equal(lineTotal(3, 12000), 36000);
  assert.equal(lineTotal(2.5, 10000), 25000);
  assert.equal(lineTotal(1.333, 9000), 11997); // 11997.0
});

test("computeTotals line mode: grand = Σline + Σtax; client total ignored", () => {
  const t = computeTotals({
    items: [
      { description: "Gạo", quantity: 2, unitCostVnd: 15000, taxAmountVnd: 0 },
      { description: "Dầu", quantity: 1, unitCostVnd: 40000, taxAmountVnd: 4000 },
    ],
  });
  assert.equal(t.subtotalVnd, 70000);
  assert.equal(t.taxAmountVnd, 4000);
  assert.equal(t.grandTotalVnd, 74000);
  assert.equal(t.items.length, 2);
  assert.equal(t.items[0].lineTotalVnd, 30000);
});

test("computeTotals single mode: amount is grand; optional header tax adds on", () => {
  const t = computeTotals({ amountVnd: 1280000 });
  assert.equal(t.grandTotalVnd, 1280000);
  assert.equal(t.items.length, 0);
  const t2 = computeTotals({ amountVnd: 1000000, headerTaxVnd: 80000 });
  assert.equal(t2.grandTotalVnd, 1080000);
});

test("normalizeItems rejects bad qty / missing description", () => {
  assert.throws(() => normalizeItems([{ description: "", quantity: 1, unitCostVnd: 1 }]), DomainError);
  assert.throws(() => normalizeItems([{ description: "x", quantity: 0, unitCostVnd: 1 }]), DomainError);
  assert.throws(() => normalizeItems([{ description: "x", quantity: 1, unitCostVnd: -5 }]), DomainError);
});

test("round3 matches numeric(14,3)", () => {
  assert.equal(round3(1.2345), 1.235);
  assert.equal(round3(2), 2);
});

// ── Duplicate signals (spec 4.2 / EXP-07) ────────────────────────────────────
test("normalizePayee folds diacritics + case + đ", () => {
  assert.equal(normalizePayee("Điện Lực Miền Nam"), "dien luc mien nam");
  assert.equal(normalizePayee("  CÔNG ty  ABC "), "cong ty abc");
});

test("dayDiff counts whole days, order-independent", () => {
  assert.equal(dayDiff("2026-08-15", "2026-08-16"), 1);
  assert.equal(dayDiff("2026-08-16", "2026-08-15"), 1);
  assert.equal(dayDiff("2026-08-15", "2026-08-15"), 0);
  assert.equal(dayDiff("2026-08-15", "2026-08-18"), 3);
});

test("payeeSimilarity: exact=1, empty=0, partial token Jaccard", () => {
  assert.equal(payeeSimilarity("Điện lực", "dien luc"), 1);
  assert.equal(payeeSimilarity("", "abc"), 0);
  assert.ok(payeeSimilarity("Điện lực Miền Nam", "Điện lực") >= 0.5);
});

test("matchSignal fires on same amount + date±1 + similar payee", () => {
  const target = { id: "t", grandTotalVnd: 1280000, expenseDate: "2026-08-15", payee: "Điện lực Miền Nam" };
  const cand = { id: "c", grandTotalVnd: 1280000, expenseDate: "2026-08-16", payee: "Điện lực Miền Nam" };
  const m = matchSignal(target, cand);
  assert.ok(m);
  assert.equal(m.candidateExpenseId, "c");
});

test("matchSignal does NOT fire on different amount, or far date, or unrelated payee", () => {
  const target = { id: "t", grandTotalVnd: 1280000, expenseDate: "2026-08-15", payee: "Điện lực" };
  assert.equal(matchSignal(target, { id: "c", grandTotalVnd: 999000, expenseDate: "2026-08-15", payee: "Điện lực" }), null);
  assert.equal(matchSignal(target, { id: "c", grandTotalVnd: 1280000, expenseDate: "2026-08-20", payee: "Điện lực" }), null);
  assert.equal(matchSignal(target, { id: "c", grandTotalVnd: 1280000, expenseDate: "2026-08-15", payee: "Chợ Bà Chiểu" }), null);
});

test("matchSignal fires on shared document content hash regardless of payee", () => {
  const target = { id: "t", grandTotalVnd: 500000, expenseDate: "2026-08-15", payee: "", contentHash: "abc123" };
  const cand = { id: "c", grandTotalVnd: 500000, expenseDate: "2026-08-15", payee: "", contentHash: "abc123" };
  const m = matchSignal(target, cand);
  assert.ok(m && m.signals.sameDocument === true);
});

test("matchSignal never flags itself", () => {
  const t = { id: "same", grandTotalVnd: 1, expenseDate: "2026-08-15", payee: "x" };
  assert.equal(matchSignal(t, { ...t }), null);
});

test("findDuplicates returns all fired candidates", () => {
  const target = { id: "t", grandTotalVnd: 1280000, expenseDate: "2026-08-15", payee: "Điện lực" };
  const cands = [
    { id: "a", grandTotalVnd: 1280000, expenseDate: "2026-08-15", payee: "Điện lực" },
    { id: "b", grandTotalVnd: 1280000, expenseDate: "2026-08-14", payee: "Điện lực" },
    { id: "c", grandTotalVnd: 50000, expenseDate: "2026-08-15", payee: "Điện lực" },
  ];
  const out = findDuplicates(target, cands);
  assert.equal(out.length, 2);
});

// ── OCR draft normalisation (spec 11.1) ──────────────────────────────────────
test("normalizeReceiptDraft keeps valid fields, drops junk lines, clamps date", () => {
  const d = normalizeReceiptDraft({
    payee: "  Điện lực  ", expense_date: "2026-08-15", document_number: "HD-001",
    lines: [
      { description: "Tiền điện", quantity: 1, unit_cost_vnd: 1280000 },
      { description: "", quantity: 2, unit_cost_vnd: 500 }, // dropped
    ],
    total_vnd: 1280000, tax_vnd: 0, category_candidates: ["Điện nước", "Khác"], warnings: ["ảnh mờ"],
  });
  assert.equal(d.payee, "Điện lực");
  assert.equal(d.expenseDate, "2026-08-15");
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].source, "ocr");
  assert.deepEqual(d.categoryCandidates, ["Điện nước", "Khác"]);
});

test("normalizeReceiptDraft rejects a bad date to null", () => {
  const d = normalizeReceiptDraft({ payee: "x", expense_date: "hôm qua", lines: [], warnings: [] });
  assert.equal(d.expenseDate, null);
});
