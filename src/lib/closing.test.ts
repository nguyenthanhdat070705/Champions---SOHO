import { describe, it, expect } from "vitest";
import {
  DENOMINATIONS, REASON_CODES, reasonLabel, optimisticDenominationTotal,
  classifyVariance, signedVnd, varianceHeadline,
} from "./closing";

describe("F14 client closing helpers", () => {
  it("denomination allowlist mirrors the server (nine notes, largest-first)", () => {
    expect(DENOMINATIONS).toEqual([500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000]);
  });

  it("optimistic total multiplies + sums, ignoring blanks and non-positives", () => {
    const total = optimisticDenominationTotal({ 500000: 5, 100000: 9, 20000: 1, 10000: 0, 5000: -3 });
    expect(total).toBe(2500000 + 900000 + 20000);
  });

  it("classifies variance for colour", () => {
    expect(classifyVariance(0)).toBe("match");
    expect(classifyVariance(20000)).toBe("surplus");
    expect(classifyVariance(-1)).toBe("shortage");
    expect(classifyVariance(null)).toBe(null);
  });

  it("signed VND uses + / − and headline names the state", () => {
    const fmt = (n: number) => `${n}đ`;
    expect(signedVnd(20000, fmt)).toBe("+20000đ");
    expect(signedVnd(-5000, fmt)).toBe("−5000đ");
    expect(signedVnd(0, fmt)).toBe("0đ");
    expect(varianceHeadline(0)).toMatch(/Khớp/);
    expect(varianceHeadline(20000)).toMatch(/Thừa/);
    expect(varianceHeadline(-1)).toMatch(/Thiếu/);
    expect(varianceHeadline(null)).toMatch(/Chưa đếm/);
  });

  it("reason catalog: only 'other' needs a note", () => {
    expect(REASON_CODES.find((r) => r.code === "other")?.needsNote).toBe(true);
    expect(REASON_CODES.find((r) => r.code === "miscount")?.needsNote).toBe(false);
    expect(reasonLabel("unrecorded_receipt")).toMatch(/thu chưa ghi/i);
    expect(reasonLabel(null)).toBe("");
  });
});
