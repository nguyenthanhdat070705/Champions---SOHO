// Functional 06 pure-logic unit tests (run by `node --test test/*.test.js`).
// Covers the money math the server always recomputes (REC-02 / REC-FR-06) and the
// duplicate-signal scoring (REC-06 / spec 4.3). No DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lineTotal, computeTotals, contentHash, perceptualHash, duplicateLevel, round3,
} from "../server/f6/receiving-math.js";

test("lineTotal = quantity × unit_cost, rounded to đồng", () => {
  assert.equal(lineTotal(48, 6000), 288000);      // spec 1.2 example
  assert.equal(lineTotal(2.5, 10000), 25000);
  assert.equal(lineTotal(1.333, 3000), 3999);     // 3999 (rounded)
  assert.equal(lineTotal(0, 6000), 0);
  assert.equal(lineTotal(3, -100), 0);            // negative cost coerced to 0
});

test("computeTotals sums line totals and adds extra cost", () => {
  const t = computeTotals(
    [{ quantity: 48, unitCostVnd: 6000 }, { quantity: 2, unitCostVnd: 15000 }],
    12000,
  );
  assert.deepEqual(t.lineTotals, [288000, 30000]);
  assert.equal(t.subtotalVnd, 318000);
  assert.equal(t.extraCostVnd, 12000);
  assert.equal(t.grandTotalVnd, 330000);
});

test("computeTotals handles empty lines and defaults extra to 0", () => {
  const t = computeTotals([]);
  assert.equal(t.subtotalVnd, 0);
  assert.equal(t.grandTotalVnd, 0);
  assert.deepEqual(t.lineTotals, []);
});

test("computeTotals never trusts a client-supplied line total", () => {
  // Even if a caller had a wrong per-line number, we recompute from qty × cost.
  const lines = [{ quantity: 10, unitCostVnd: 1000, line_total_vnd: 999999 }];
  const t = computeTotals(lines);
  assert.equal(t.subtotalVnd, 10000);
});

test("round3 matches numeric(14,3)", () => {
  assert.equal(round3(1.2344), 1.234);
  assert.equal(round3(1.2367), 1.237);
  assert.equal(round3(12), 12);
});

test("contentHash is deterministic and differs for different bytes", () => {
  const a = Buffer.from("hello-receipt");
  const b = Buffer.from("hello-receipt");
  const c = Buffer.from("other");
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash(c));
  // Accepts base64 too.
  assert.equal(contentHash(a.toString("base64")), contentHash(a));
});

test("perceptualHash is stable per content and null for empty", () => {
  const a = Buffer.alloc(2048, 7);
  assert.equal(perceptualHash(a), perceptualHash(Buffer.alloc(2048, 7)));
  assert.equal(perceptualHash(Buffer.alloc(0)), null);
});

test("duplicateLevel: exact content hash wins", () => {
  const lvl = duplicateLevel(
    { contentHash: "abc" },
    { contentHash: "abc" },
  );
  assert.equal(lvl, "exact");
});

test("duplicateLevel: matching document number is strong", () => {
  const lvl = duplicateLevel(
    { contentHash: "x", documentNumber: "PN-00018" },
    { contentHash: "y", documentNumber: "pn-00018" },
  );
  assert.equal(lvl, "strong");
});

test("duplicateLevel: supplier+date+total triple is soft", () => {
  const lvl = duplicateLevel(
    { supplier: "Nhà phân phối A", receivedDate: "2026-08-15", totalVnd: 288000 },
    { supplier: "nha phan phoi a", receivedDate: "2026-08-15", totalVnd: 288000 },
  );
  assert.equal(lvl, "soft");
});

test("duplicateLevel: nothing matches → null", () => {
  const lvl = duplicateLevel(
    { contentHash: "x", documentNumber: "A", supplier: "A", receivedDate: "2026-08-01", totalVnd: 1 },
    { contentHash: "y", documentNumber: "B", supplier: "B", receivedDate: "2026-08-02", totalVnd: 2 },
  );
  assert.equal(lvl, null);
});
