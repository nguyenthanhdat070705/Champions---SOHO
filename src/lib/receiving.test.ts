import { describe, it, expect } from "vitest";
import {
  lineTotal, computeTotals, fmtQty, parseQty, parseCost, isEditable, receiptStatusClass,
} from "./receiving";

describe("receiving totals (mirror server/f6/receiving-math.js)", () => {
  it("lineTotal rounds to đồng", () => {
    expect(lineTotal(48, 6000)).toBe(288000);
    expect(lineTotal(2.5, 10000)).toBe(25000);
    expect(lineTotal(0, 6000)).toBe(0);
  });
  it("computeTotals sums lines + extra cost", () => {
    const t = computeTotals([{ quantity: 48, unitCostVnd: 6000 }, { quantity: 10, unitCostVnd: 3500 }], 12000);
    expect(t.subtotalVnd).toBe(323000);
    expect(t.grandTotalVnd).toBe(335000);
  });
  it("computeTotals defaults extra to 0", () => {
    expect(computeTotals([{ quantity: 1, unitCostVnd: 1000 }]).grandTotalVnd).toBe(1000);
  });
});

describe("qty/cost parsing", () => {
  it("parseQty accepts positive up to 3 decimals", () => {
    expect(parseQty("48")).toBe(48);
    expect(parseQty("1.5")).toBe(1.5);
    expect(parseQty("1,5")).toBe(1.5);
    expect(parseQty("0")).toBeNull();
    expect(parseQty("")).toBeNull();
    expect(parseQty("-3")).toBeNull();
    expect(parseQty("1.2345")).toBeNull();
  });
  it("parseCost accepts non-negative integers, digits only", () => {
    expect(parseCost("6000")).toBe(6000);
    expect(parseCost("6.000")).toBe(6000);
    expect(parseCost("")).toBeNull();
    expect(parseCost("0")).toBe(0);
  });
  it("fmtQty trims trailing zeros", () => {
    expect(fmtQty(12)).toBe("12");
    expect(fmtQty(1.5)).toBe("1.5");
    expect(fmtQty(null)).toBe("—");
  });
});

describe("status helpers", () => {
  it("isEditable only for draft/review/ready", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("review")).toBe(true);
    expect(isEditable("ready")).toBe(true);
    expect(isEditable("posted")).toBe(false);
    expect(isEditable("reversed")).toBe(false);
    expect(isEditable("cancelled")).toBe(false);
  });
  it("receiptStatusClass maps status → shared pill classes", () => {
    expect(receiptStatusClass("posted")).toBe("pill--active");
    expect(receiptStatusClass("cancelled")).toBe("pill--archived");
    expect(receiptStatusClass("ready")).toBe("pill--low");
    expect(receiptStatusClass("draft")).toBe("pill--inactive");
  });
});
