import { describe, it, expect } from "vitest";
import { coverageMeta, formatDelta, pctText, barPct, formatQty } from "./reports";

describe("F13 report display helpers", () => {
  it("coverageMeta maps status → label + tone", () => {
    expect(coverageMeta("complete")).toEqual({ label: "Đủ dữ liệu", tone: "good" });
    expect(coverageMeta("partial").tone).toBe("amber");
    expect(coverageMeta("unavailable")).toEqual({ label: "Chưa đủ dữ liệu", tone: "grey" });
  });

  it("formatDelta is signed + neutral", () => {
    expect(formatDelta(0)).toBe("±0đ");
    expect(formatDelta(30000)).toBe("+30.000đ");
    expect(formatDelta(-20000)).toBe("−20.000đ");
  });

  it("pctText never claims infinite growth when base=0", () => {
    expect(pctText(null)).toBe("Không áp dụng");
    expect(pctText(0)).toBe("0%");
    expect(pctText(15)).toBe("+15%");
    expect(pctText(-8)).toBe("−8%");
  });

  it("barPct is clamped and /0-safe", () => {
    expect(barPct(50, 100)).toBe(50);
    expect(barPct(5, 0)).toBe(0);
    expect(barPct(200, 100)).toBe(100);
  });

  it("formatQty drops trailing zeros", () => {
    expect(formatQty(3)).toBe("3");
    expect(formatQty(2.5)).toBe("2.5");
  });
});
