import { describe, expect, it } from "vitest";
import {
  formatVnd,
  formatVndShort,
  formatClockVN,
  formatBusinessDateVN,
} from "./format";

describe("formatVnd", () => {
  it("groups thousands with periods and appends đ", () => {
    expect(formatVnd(3100000)).toBe("3.100.000đ");
    expect(formatVnd(2000000)).toBe("2.000.000đ");
    expect(formatVnd(1100000)).toBe("1.100.000đ");
    expect(formatVnd(150000)).toBe("150.000đ");
    expect(formatVnd(999)).toBe("999đ");
    expect(formatVnd(1000)).toBe("1.000đ");
  });

  it("formats zero", () => {
    expect(formatVnd(0)).toBe("0đ");
  });

  it("renders negative amounts (refund > sales) with a leading minus", () => {
    expect(formatVnd(-100000)).toBe("-100.000đ");
    expect(formatVnd(-1)).toBe("-1đ");
    expect(formatVnd(-2500000)).toBe("-2.500.000đ");
  });

  it("truncates any fractional part (amounts are whole đồng)", () => {
    expect(formatVnd(1000.99)).toBe("1.000đ");
    expect(formatVnd(-1000.99)).toBe("-1.000đ");
  });

  it("is safe against NaN / Infinity", () => {
    expect(formatVnd(NaN)).toBe("0đ");
    expect(formatVnd(Infinity)).toBe("0đ");
  });

  it("handles large daily totals", () => {
    expect(formatVnd(123456789)).toBe("123.456.789đ");
  });
});

describe("formatVndShort", () => {
  it("uses triệu phrasing at/above 1 million", () => {
    expect(formatVndShort(3100000)).toBe("3,1 triệu");
    expect(formatVndShort(2000000)).toBe("2 triệu");
  });
  it("falls back to full format below 1 million", () => {
    expect(formatVndShort(150000)).toBe("150.000đ");
    expect(formatVndShort(0)).toBe("0đ");
  });
});

describe("formatClockVN", () => {
  it("renders HH:MM in Asia/Ho_Chi_Minh", () => {
    // 2026-08-16T20:30:04+07:00 → 20:30 in HCM
    expect(formatClockVN("2026-08-16T20:30:04+07:00")).toBe("20:30");
    // 13:30 UTC == 20:30 HCM (+7)
    expect(formatClockVN("2026-08-16T13:30:00Z")).toBe("20:30");
  });
  it("returns empty string for missing / bad input", () => {
    expect(formatClockVN(null)).toBe("");
    expect(formatClockVN(undefined)).toBe("");
    expect(formatClockVN("not-a-date")).toBe("");
  });
});

describe("formatBusinessDateVN", () => {
  it("renders a Vietnamese long date for a bare YYYY-MM-DD", () => {
    const s = formatBusinessDateVN("2026-08-16");
    expect(s).toContain("16");
    expect(s).toContain("2026");
  });
  it("returns empty string for missing input", () => {
    expect(formatBusinessDateVN(null)).toBe("");
    expect(formatBusinessDateVN("")).toBe("");
  });
});
