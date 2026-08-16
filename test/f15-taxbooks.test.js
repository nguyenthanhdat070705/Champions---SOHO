// Functional 15 — pure-logic unit tests (spec §4, §6.1, Phụ lục A6). The
// compliance heart: source→book mapping, the 1-tỷ cumulative threshold split, and
// the deterministic CSV serializer. No DB — run under `npm test`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapSourceToRecords, computeThresholdSplit, toCsv, byteHash, contentHash,
  channelOf, BOOK_CODES, EXEMPT_THRESHOLD_VND, GTGT_RATE, TNCN_RATE,
} from "../server/f15/mapping.js";
import { resolvePeriod, yearToStart } from "../server/f15/period-util.js";

describe("F15 mapping — source → book records", () => {
  it("books a cash sale into sổ doanh thu + sổ quỹ tiền mặt", () => {
    const recs = mapSourceToRecords({ sourceType: "payment", sourceEventType: "payment.succeeded", businessDate: "2026-07-10", amountVnd: 100000, method: "cash" });
    assert.equal(recs.length, 2);
    const rev = recs.find((r) => r.bookCode === "sales_revenue");
    const cash = recs.find((r) => r.bookCode === "cash_book");
    assert.equal(rev.amountVnd, 100000);
    assert.equal(rev.dimensions.channel, "cash");
    assert.equal(cash.amountVnd, 100000);
    assert.equal(cash.recordType, "cash");
  });

  it("books a QR sale into sổ doanh thu + sổ ngân hàng (not quỹ)", () => {
    const recs = mapSourceToRecords({ sourceType: "payment", sourceEventType: "payment.succeeded", businessDate: "2026-07-10", amountVnd: 250000, method: "qr" });
    assert.equal(recs.length, 2);
    assert.ok(recs.find((r) => r.bookCode === "bank_book" && r.amountVnd === 250000));
    assert.ok(!recs.find((r) => r.bookCode === "cash_book"));
  });

  it("books a cash refund as a negative revenue + negative cash line", () => {
    const recs = mapSourceToRecords({ sourceType: "refund", sourceEventType: "refund.succeeded", businessDate: "2026-07-11", amountVnd: 30000, method: "cash" });
    assert.equal(recs.find((r) => r.bookCode === "sales_revenue").amountVnd, -30000);
    assert.equal(recs.find((r) => r.bookCode === "cash_book").amountVnd, -30000);
  });

  it("books an expense into sổ chi phí only (no method → no quỹ/ngân hàng split)", () => {
    const recs = mapSourceToRecords({ sourceType: "expense", sourceEventType: "expense_posted", businessDate: "2026-07-12", amountVnd: 50000, method: null });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].bookCode, "expenses");
    assert.equal(recs[0].amountVnd, -50000);
  });

  it("books a purchase receipt into sổ vật liệu–hàng hóa", () => {
    const recs = mapSourceToRecords({ sourceType: "purchase_receipt", sourceEventType: "purchase_received", businessDate: "2026-07-13", amountVnd: 400000, method: null });
    assert.deepEqual(recs.map((r) => r.bookCode), ["materials_goods"]);
    assert.equal(recs[0].amountVnd, 400000);
  });

  it("never guesses: unknown event or non-positive amount → no records", () => {
    assert.deepEqual(mapSourceToRecords({ sourceType: "x", sourceEventType: "y", businessDate: "2026-07-01", amountVnd: 100, method: "cash" }), []);
    assert.deepEqual(mapSourceToRecords({ sourceType: "payment", sourceEventType: "payment.succeeded", businessDate: "2026-07-01", amountVnd: 0, method: "cash" }), []);
    assert.deepEqual(mapSourceToRecords({ sourceType: "payment", sourceEventType: "payment.succeeded", businessDate: null, amountVnd: 100, method: "cash" }), []);
  });

  it("channelOf maps qr/transfer → bank, cash → cash, else unknown", () => {
    assert.equal(channelOf("cash"), "cash");
    assert.equal(channelOf("qr"), "bank");
    assert.equal(channelOf("transfer"), "bank");
    assert.equal(channelOf(null), "unknown");
  });

  it("exposes the five S-HKD retail books", () => {
    assert.deepEqual(BOOK_CODES, ["sales_revenue", "cash_book", "bank_book", "expenses", "materials_goods"]);
  });
});

describe("F15 threshold split — 1 tỷ cumulative/year (NĐ 141/2026)", () => {
  it("splits the period that crosses the threshold exactly", () => {
    const s = computeThresholdSplit(900_000_000, 300_000_000);
    assert.equal(s.newCumulativeVnd, 1_200_000_000);
    assert.equal(s.taxablePortionVnd, 200_000_000);
    assert.equal(s.exemptPortionVnd, 100_000_000);
    assert.equal(s.gtgtEstimateVnd, Math.round(200_000_000 * GTGT_RATE)); // 2,000,000
    assert.equal(s.tncnEstimateVnd, Math.round(200_000_000 * TNCN_RATE)); // 1,000,000
    assert.equal(s.totalEstimateVnd, 3_000_000);
    assert.equal(s.overThreshold, true);
  });

  it("taxes the whole period once already over the threshold", () => {
    const s = computeThresholdSplit(1_200_000_000, 300_000_000);
    assert.equal(s.taxablePortionVnd, 300_000_000);
    assert.equal(s.exemptPortionVnd, 0);
    assert.equal(s.gtgtEstimateVnd, 3_000_000);
    assert.equal(s.tncnEstimateVnd, 1_500_000);
  });

  it("keeps a fully-below-threshold period exempt", () => {
    const s = computeThresholdSplit(500_000_000, 300_000_000);
    assert.equal(s.taxablePortionVnd, 0);
    assert.equal(s.exemptPortionVnd, 300_000_000);
    assert.equal(s.totalEstimateVnd, 0);
    assert.equal(s.overThreshold, false);
  });

  it("handles the exact-boundary prior cumulative", () => {
    const s = computeThresholdSplit(EXEMPT_THRESHOLD_VND, 100_000_000);
    assert.equal(s.taxablePortionVnd, 100_000_000);
    assert.equal(s.exemptPortionVnd, 0);
  });

  it("is zero-safe", () => {
    const s = computeThresholdSplit(0, 0);
    assert.equal(s.taxablePortionVnd, 0);
    assert.equal(s.totalEstimateVnd, 0);
  });
});

describe("F15 CSV serializer — deterministic, Excel-openable (A6)", () => {
  it("emits a UTF-8 BOM, CRLF rows and quotes special cells", () => {
    const csv = toCsv([["Ngày", "Số tiền (VND)"], ["2026-07-10", 100000], ['a,b', 'c"d']]);
    assert.ok(csv.startsWith("﻿"), "has BOM");
    assert.ok(csv.includes("\r\n"), "CRLF rows");
    assert.ok(csv.includes('"a,b"'));
    assert.ok(csv.includes('"c""d"'));
    assert.ok(csv.includes("100000")); // VND bare integer, no locale separators
  });

  it("is byte-stable → same hash for the same rows", () => {
    const rows = [["x", 1], ["y", 2]];
    assert.equal(byteHash(toCsv(rows)), byteHash(toCsv(rows)));
    assert.notEqual(byteHash(toCsv(rows)), byteHash(toCsv([["x", 1], ["y", 3]])));
  });
});

describe("F15 content hash — canonical, key-order independent", () => {
  it("hashes regardless of object key order", () => {
    assert.equal(contentHash({ a: 1, b: { c: 2, d: 3 } }), contentHash({ b: { d: 3, c: 2 }, a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
  });
});

describe("F15 period math — month/quarter bounds (Asia/Ho_Chi_Minh)", () => {
  it("resolves a month", () => {
    const p = resolvePeriod("2026-07");
    assert.equal(p.kind, "month");
    assert.equal(p.start, "2026-07-01");
    assert.equal(p.end, "2026-07-31");
    assert.equal(p.label, "Tháng 7/2026");
  });

  it("resolves a quarter", () => {
    const p = resolvePeriod("2026-Q3");
    assert.equal(p.kind, "quarter");
    assert.equal(p.start, "2026-07-01");
    assert.equal(p.end, "2026-09-30");
    assert.equal(p.label, "Quý 3/2026");
  });

  it("gets February's last day right (non-leap 2026)", () => {
    assert.equal(resolvePeriod("2026-02").end, "2026-02-28");
  });

  it("computes the prior year-to-start range for cumulative revenue", () => {
    const y = yearToStart(resolvePeriod("2026-07"));
    assert.equal(y.start, "2026-01-01");
    assert.equal(y.end, "2026-06-30");
  });
});
