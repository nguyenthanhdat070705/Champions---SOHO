// Functional 14 pure-logic unit tests (no DB) — server-side count math, the
// expected-cash formula (direction never inferred from sign), variance + reason
// gates, and the source/preview/content hashes that make confirm idempotent and
// previews staleness-safe. Part of `npm test` (node --test), no DATABASE_URL.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DENOMINATIONS, REASON_CODES, computeCount, expectedCash, variance,
  classifyVariance, reasonRequired, validateReason, sourceSetHash, previewHash,
  contentHash, sourceFingerprint,
} from "../server/f14/closing.js";

// ── Count math is server-authoritative (spec §3.3 / CLS-04) ────────────────────
test("total mode returns the typed total and no lines", () => {
  const r = computeCount("total", { countedTotalVnd: 3420000 });
  assert.equal(r.countedTotalVnd, 3420000);
  assert.deepEqual(r.lines, []);
});

test("denomination mode multiplies + sums server-side (client total ignored)", () => {
  const r = computeCount("denomination", {
    countedTotalVnd: 999, // a lie the client sends — must be ignored
    denominations: [
      { denominationVnd: 500000, quantity: 5 },   // 2.500.000
      { denominationVnd: 100000, quantity: 9 },   //   900.000
      { denominationVnd: 20000, quantity: 1 },    //    20.000
    ],
  });
  assert.equal(r.countedTotalVnd, 2500000 + 900000 + 20000);
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[0].denominationVnd, 500000); // largest-first
  assert.equal(r.lines[0].lineTotalVnd, 2500000);
});

test("denomination mode collapses duplicate denominations and skips zero rows", () => {
  const r = computeCount("denomination", {
    denominations: [
      { denominationVnd: 50000, quantity: 2 },
      { denominationVnd: 50000, quantity: 3 },
      { denominationVnd: 10000, quantity: 0 },
    ],
  });
  assert.equal(r.countedTotalVnd, 50000 * 5);
  assert.equal(r.lines.length, 1);
});

test("denomination mode rejects an off-allowlist note", () => {
  assert.throws(() => computeCount("denomination", { denominations: [{ denominationVnd: 30000, quantity: 1 }] }), /INVALID_DENOMINATION/);
});

test("count rejects negative / fractional quantities and totals", () => {
  assert.throws(() => computeCount("total", { countedTotalVnd: -1 }), /INVALID_COUNT_TOTAL/);
  assert.throws(() => computeCount("total", { countedTotalVnd: 1.5 }), /INVALID_COUNT_TOTAL/);
  assert.throws(() => computeCount("denomination", { denominations: [{ denominationVnd: 1000, quantity: -2 }] }), /INVALID_DENOMINATION_QTY/);
});

test("the allowlist is the nine VND notes, largest-first", () => {
  assert.deepEqual(DENOMINATIONS, [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]);
});

// ── Expected cash formula (spec §4.1 / A3: direction is explicit) ──────────────
test("expected = Σ in − Σ out; sign never inferred from amount", () => {
  const sources = [
    { direction: "in", amountVnd: 3400000 },
    { direction: "out", amountVnd: 120000 },
    { direction: "in", amountVnd: 140000 },
  ];
  const e = expectedCash(sources);
  assert.equal(e.inflowVnd, 3540000);
  assert.equal(e.outflowVnd, 120000);
  assert.equal(e.expectedCashVnd, 3420000);
});

test("empty source set → expected 0", () => {
  assert.equal(expectedCash([]).expectedCashVnd, 0);
});

// ── Variance + reason gate (spec §3.5 / §4.2 / CLS-06) ─────────────────────────
test("variance = counted − expected, classified", () => {
  assert.equal(variance(3420000, 3400000), 20000);
  assert.equal(classifyVariance(20000), "surplus");
  assert.equal(classifyVariance(-5000), "shortage");
  assert.equal(classifyVariance(0), "match");
});

test("reason required only when variance ≠ 0", () => {
  assert.equal(reasonRequired(0), false);
  assert.equal(reasonRequired(-5000), true);
  assert.equal(validateReason(0, null, null), null); // balanced → no reason
  assert.equal(validateReason(20000, null, null), "CLOSING_REASON_REQUIRED");
  assert.equal(validateReason(20000, "miscount", null), null);
});

test("'Khác' reason requires a note", () => {
  assert.equal(validateReason(20000, "other", null), "CLOSING_REASON_NOTE_REQUIRED");
  assert.equal(validateReason(20000, "other", "khách bo thêm"), null);
  assert.ok(REASON_CODES.other.needsNote);
  assert.ok(!REASON_CODES.miscount.needsNote);
});

// ── Hashes (spec §5.1 idempotency / preview staleness) ─────────────────────────
test("source-set hash is order-independent but content-sensitive", () => {
  const a = [
    { sourceType: "payment", sourceId: "p1", eventType: "payment.succeeded", direction: "in", amountVnd: 100 },
    { sourceType: "refund", sourceId: "r1", eventType: "refund.succeeded", direction: "out", amountVnd: 30 },
  ];
  const b = [a[1], a[0]]; // reversed order
  assert.equal(sourceSetHash(a), sourceSetHash(b));
  const c = [...a, { sourceType: "payment", sourceId: "p2", eventType: "payment.succeeded", direction: "in", amountVnd: 50 }];
  assert.notEqual(sourceSetHash(a), sourceSetHash(c));
});

test("preview hash changes with counted, reason, or source set", () => {
  const base = { draftId: "d1", sourceSetHash: "sha256:abc", countedCashVnd: 1000, reasonCode: null, reasonNote: null };
  const h0 = previewHash(base);
  assert.equal(h0, previewHash({ ...base })); // stable
  assert.notEqual(h0, previewHash({ ...base, countedCashVnd: 1001 }));
  assert.notEqual(h0, previewHash({ ...base, reasonCode: "miscount" }));
  assert.notEqual(h0, previewHash({ ...base, sourceSetHash: "sha256:def" }));
});

test("content hash pins revision identity (chain + numbers)", () => {
  const base = { closingId: "c1", revisionNo: 1, sourceSetHash: "sha256:x", expectedCashVnd: 100, countedCashVnd: 100, reasonCode: null, reasonNote: null, previousRevisionId: null };
  const h0 = contentHash(base);
  assert.notEqual(h0, contentHash({ ...base, revisionNo: 2 }));
  assert.notEqual(h0, contentHash({ ...base, previousRevisionId: "r1" }));
  assert.notEqual(h0, contentHash({ ...base, countedCashVnd: 90 }));
});

test("source fingerprint is the late-source dedupe key", () => {
  assert.equal(sourceFingerprint("payment", "p1", "payment.succeeded"), "payment:p1:payment.succeeded");
});
