// Functional 05 pure-logic unit tests (no DB) — variance math, reason rules and
// reversal rules. Part of `npm test` (node --test), so they run WITHOUT DATABASE_URL.
import assert from "node:assert/strict";
import test from "node:test";
import { computeVariance, countPostDelta, summarizeVariances, round3 } from "../server/f5/count-math.js";
import { validateReason, REASON_CODES } from "../server/f5/reasons.js";
import { isReversibleType, reverseDelta, adjustmentDelta } from "../server/f5/rules.js";
import { DomainError } from "../server/f3/errors.js";

// ── Variance math (spec 3.7 / 4.3) ───────────────────────────────────────────
test("computeVariance: delta measured against CURRENT balance (adjustment_to_counted)", () => {
  // system 12, sale of 1 after start (current 11), counted 10 → will change by -1
  const v = computeVariance(12, 11, 10);
  assert.equal(v.variance, -1);
  assert.equal(v.deltaFromExpected, -2); // drift vs snapshot
  assert.equal(v.requiresReason, true);
  assert.equal(v.missing, false);
});

test("computeVariance: null count = missing, no reason required, no movement", () => {
  const v = computeVariance(5, 5, null);
  assert.equal(v.counted, null);
  assert.equal(v.variance, null);
  assert.equal(v.missing, true);
  assert.equal(v.requiresReason, false);
});

test("computeVariance: exact match needs no reason", () => {
  const v = computeVariance(8, 8, 8);
  assert.equal(v.variance, 0);
  assert.equal(v.requiresReason, false);
});

test("countPostDelta: moves balance TO the counted number; null → 0", () => {
  assert.equal(countPostDelta(11, 10), -1);
  assert.equal(countPostDelta(0, 8), 8);
  assert.equal(countPostDelta(5, 5), 0);
  assert.equal(countPostDelta(5, null), 0);
});

test("countPostDelta: fractional units round to numeric(14,3)", () => {
  assert.equal(countPostDelta(1.005, 2.5), 1.495);
  assert.equal(round3(0.1 + 0.2), 0.3);
});

test("summarizeVariances: counts increases/decreases/unchanged/missing/needsReason", () => {
  const lines = [
    computeVariance(10, 10, 12),                     // +2 increase, needs reason
    { ...computeVariance(4, 4, 3), reasonCode: "DAMAGED" }, // -1 decrease, reason present
    computeVariance(2, 2, 2),                         // unchanged
    computeVariance(1, 1, null),                      // missing
  ];
  const s = summarizeVariances(lines);
  assert.equal(s.increases, 1);
  assert.equal(s.decreases, 1);
  assert.equal(s.unchanged, 1);
  assert.equal(s.missing, 1);
  assert.equal(s.counted, 3);
  assert.equal(s.needsReason, 1); // the +2 line has no reasonCode
});

// ── Reason rules (spec 3.3 / 4.2) ────────────────────────────────────────────
test("validateReason: required reason missing → REASON_REQUIRED", () => {
  assert.throws(() => validateReason(null, null, { required: true }),
    (e) => e instanceof DomainError && e.code === "REASON_REQUIRED");
});

test("validateReason: unknown reason → VALIDATION", () => {
  assert.throws(() => validateReason("WHATEVER", null, { required: true }),
    (e) => e instanceof DomainError && e.code === "VALIDATION");
});

test("validateReason: OTHER requires a note", () => {
  assert.throws(() => validateReason("OTHER", "  ", { required: true }),
    (e) => e instanceof DomainError && e.code === "VALIDATION");
  const ok = validateReason("other", "vỡ khi xếp hàng", { required: true });
  assert.equal(ok.reasonCode, "OTHER");
  assert.equal(ok.note, "vỡ khi xếp hàng");
});

test("validateReason: normalises case; optional allows null", () => {
  assert.deepEqual(validateReason("damaged", null, { required: true }), { reasonCode: "DAMAGED", note: null });
  assert.deepEqual(validateReason(null, null, { required: false }), { reasonCode: null, note: null });
});

test("REASON_CODES is the fixed pilot set", () => {
  assert.deepEqual(REASON_CODES, ["DAMAGED", "LOST", "FOUND", "CORRECTION", "OTHER"]);
});

// ── Reversal + adjustment rules (spec 4.2) ───────────────────────────────────
test("isReversibleType: only manual/count adjustments are reversible", () => {
  assert.equal(isReversibleType("manual_adjustment"), true);
  assert.equal(isReversibleType("count_adjustment"), true);
  for (const t of ["sale", "sale_return", "opening", "purchase_receipt", "reversal", "damage_writeoff"]) {
    assert.equal(isReversibleType(t), false, t);
  }
});

test("reverseDelta negates the original exactly", () => {
  assert.equal(reverseDelta(-2), 2);
  assert.equal(reverseDelta(3.5), -3.5);
  assert.equal(reverseDelta(2.001), -2.001);
});

test("adjustmentDelta: direction → signed magnitude", () => {
  assert.equal(adjustmentDelta("increase", 3), 3);
  assert.equal(adjustmentDelta("decrease", 3), -3);
  assert.equal(adjustmentDelta("decrease", 1.5), -1.5);
});
