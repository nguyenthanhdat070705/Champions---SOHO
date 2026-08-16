import { describe, it, expect } from "vitest";
import { parseVnd, groupVnd, paymentLabel, statusTone, matchCategoryCandidate, monthLabel } from "./expenses";
import type { ExpenseCategory } from "./api";

describe("expenses helpers", () => {
  it("parseVnd strips separators to integer đồng", () => {
    expect(parseVnd("1.280.000")).toBe(1280000);
    expect(parseVnd("1280000")).toBe(1280000);
    expect(parseVnd("")).toBeNull();
    expect(parseVnd("abc")).toBeNull();
  });

  it("groupVnd formats vi-VN grouping", () => {
    expect(groupVnd(1280000)).toBe("1.280.000");
    expect(groupVnd(null)).toBe("");
  });

  it("paymentLabel reflects confirmation (never claims 'đã trả' when unconfirmed)", () => {
    expect(paymentLabel("transfer", "confirmed")).toBe("Chuyển khoản · đã xác nhận");
    expect(paymentLabel("cash", "unconfirmed")).toBe("Tiền mặt · chưa xác nhận");
    expect(paymentLabel(null, null)).toBe("Chưa ghi");
  });

  it("statusTone maps posted→ok, reversed→danger", () => {
    expect(statusTone("posted")).toBe("ok");
    expect(statusTone("reversed")).toBe("danger");
    expect(statusTone("draft")).toBe("muted");
  });

  it("matchCategoryCandidate preselects by name/diacritics-insensitive", () => {
    const cats: ExpenseCategory[] = [
      { id: "u", code: "utilities", displayName: "Điện nước", status: "active", global: true, taxHint: null },
      { id: "p", code: "purchases", displayName: "Nhập hàng", status: "active", global: true, taxHint: null },
    ];
    expect(matchCategoryCandidate(["Điện nước"], cats)).toBe("u");
    expect(matchCategoryCandidate(["dien nuoc"], cats)).toBe("u");
    expect(matchCategoryCandidate(["Không rõ"], cats)).toBeNull();
  });

  it("monthLabel is human", () => {
    expect(monthLabel("2026-08")).toBe("Tháng 8/2026");
  });
});
