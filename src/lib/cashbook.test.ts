// Functional 11 pure client-helper tests (vitest). Mirrors the server taxonomy so
// the UI never drifts from server/f11/mapping.js.
import { describe, it, expect } from "vitest";
import {
  entryTypeLabel, directionOfEntryType, draftReady, firstMissing,
  signedAmount, ENTRY_TYPE_OPTIONS, METHOD_LABEL,
} from "./cashbook";

describe("cashbook client helpers", () => {
  it("labels entry types and falls back to the raw value", () => {
    expect(entryTypeLabel("sales_receipt")).toBe("Thu bán hàng");
    expect(entryTypeLabel("operating_expense")).toBe("Chi vận hành");
    expect(entryTypeLabel(null)).toBe("—");
    expect(entryTypeLabel("mystery")).toBe("mystery");
  });

  it("pins the direction for each selectable entry type", () => {
    expect(directionOfEntryType("sales_receipt")).toBe("in");
    expect(directionOfEntryType("inventory_purchase")).toBe("out");
    expect(directionOfEntryType("sales_refund")).toBe("out");
    expect(directionOfEntryType("nope")).toBeNull();
  });

  it("every entry-type option has a consistent direction", () => {
    for (const o of ENTRY_TYPE_OPTIONS) {
      expect(directionOfEntryType(o.value)).toBe(o.direction);
    }
  });

  it("draftReady gates on all required fields (mirrors server)", () => {
    const good = { direction: "out" as const, entryType: "operating_expense", amountVnd: 100, occurredAt: "2026-08-16T00:00:00+07:00", paymentMethod: "cash" as const };
    expect(draftReady(good)).toBe(true);
    expect(draftReady({ ...good, amountVnd: 0 })).toBe(false);
    expect(draftReady({ ...good, occurredAt: null })).toBe(false);
    expect(draftReady({ ...good, entryType: "bogus" })).toBe(false);
    expect(draftReady({ ...good, paymentMethod: "unknown" })).toBe(false);
  });

  it("firstMissing points at the first gap, then null when ready", () => {
    expect(firstMissing({})).toBe("loại khoản");
    expect(firstMissing({ entryType: "other_receipt" })).toBe("số tiền");
    expect(firstMissing({ entryType: "other_receipt", amountVnd: 10 })).toBe("ngày");
    expect(firstMissing({ entryType: "other_receipt", amountVnd: 10, occurredAt: "t", paymentMethod: "unknown" })).toBe("phương thức thanh toán");
    expect(firstMissing({ entryType: "other_receipt", amountVnd: 10, occurredAt: "t", paymentMethod: "cash" })).toBeNull();
  });

  it("signedAmount negates outflows", () => {
    expect(signedAmount("in", 100)).toBe(100);
    expect(signedAmount("out", 100)).toBe(-100);
  });

  it("method labels cover the fact vocabulary", () => {
    expect(METHOD_LABEL.cash).toBe("Tiền mặt");
    expect(METHOD_LABEL.transfer).toBe("Chuyển khoản");
    expect(METHOD_LABEL.unknown).toBe("Chưa rõ");
  });
});
