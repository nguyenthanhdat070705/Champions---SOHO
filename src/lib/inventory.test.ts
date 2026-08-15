import { describe, it, expect } from "vitest";
import {
  computeVariance, round3, fmtQty, fmtDelta, parseQty,
  reasonComplete, reasonOptionsFor, countReadyToPost, movementLabel,
} from "./inventory";

describe("quantity formatting/parsing (numeric(14,3))", () => {
  it("fmtQty trims trailing zeros", () => {
    expect(fmtQty(12)).toBe("12");
    expect(fmtQty(1.5)).toBe("1.5");
    expect(fmtQty(1.0)).toBe("1");
    expect(fmtQty(null)).toBe("—");
  });
  it("fmtDelta signs the value", () => {
    expect(fmtDelta(3)).toBe("+3");
    expect(fmtDelta(-2)).toBe("-2");
    expect(fmtDelta(0)).toBe("0");
  });
  it("parseQty accepts up to 3 decimals, rejects junk/negatives", () => {
    expect(parseQty("12")).toBe(12);
    expect(parseQty("1,5")).toBe(1.5); // comma decimal
    expect(parseQty("0.250")).toBe(0.25);
    expect(parseQty("")).toBeNull();
    expect(parseQty("-1")).toBeNull();
    expect(parseQty("1.2345")).toBeNull(); // too many decimals
    expect(parseQty("abc")).toBeNull();
  });
  it("round3 matches server rounding", () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
  });
});

describe("variance math mirrors the server", () => {
  it("delta is counted − current; drift is counted − expected", () => {
    const v = computeVariance(12, 11, 10);
    expect(v.variance).toBe(-1);
    expect(v.deltaFromExpected).toBe(-2);
    expect(v.requiresReason).toBe(true);
  });
  it("null count is missing and needs no reason", () => {
    const v = computeVariance(5, 5, null);
    expect(v.missing).toBe(true);
    expect(v.requiresReason).toBe(false);
  });
});

describe("reason completeness", () => {
  it("OTHER needs a note, others do not", () => {
    expect(reasonComplete("DAMAGED", null)).toBe(true);
    expect(reasonComplete("OTHER", null)).toBe(false);
    expect(reasonComplete("OTHER", "vỡ")).toBe(true);
    expect(reasonComplete("", null)).toBe(false);
  });
  it("increase vs decrease offer different reasons", () => {
    expect(reasonOptionsFor("increase").map((o) => o.value)).toContain("FOUND");
    expect(reasonOptionsFor("decrease").map((o) => o.value)).toContain("DAMAGED");
    expect(reasonOptionsFor("increase").map((o) => o.value)).not.toContain("DAMAGED");
  });
});

describe("countReadyToPost", () => {
  it("blocks when a variance line lacks a reason", () => {
    expect(countReadyToPost([{ countedQty: 10, variance: -2, reasonCode: null }])).toBe(false);
    expect(countReadyToPost([{ countedQty: 10, variance: -2, reasonCode: "DAMAGED" }])).toBe(true);
  });
  it("matched lines need no reason; requires at least one counted line", () => {
    expect(countReadyToPost([{ countedQty: 5, variance: 0, reasonCode: null }])).toBe(true);
    expect(countReadyToPost([{ countedQty: null, variance: null, reasonCode: null }])).toBe(false);
  });
});

describe("movementLabel", () => {
  it("labels known types, passes through unknown", () => {
    expect(movementLabel("sale")).toBe("Bán hàng");
    expect(movementLabel("count_adjustment")).toBe("Kiểm kê");
    expect(movementLabel("weird")).toBe("weird");
  });
});
