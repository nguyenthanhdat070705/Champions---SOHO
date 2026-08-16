import { describe, it, expect } from "vitest";
import {
  renderFacts, sumCounts, isActiveStatus, IGNORE_REASONS,
  IMPACT_LABEL, FAMILY_LABEL, STATUS_LABEL,
} from "./reconciliation";

describe("renderFacts", () => {
  it("formats money fields as đồng and hides raw ids", () => {
    const rows = renderFacts({
      orderId: "abc", orderNumber: "HD-1", orderStatus: "paid",
      totalAmount: 450000, capturedTotal: 0,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.orderId).toBeUndefined(); // hidden
    expect(byKey.orderNumber).toBe("HD-1");
    expect(byKey.totalAmount).toContain("450.000");
    // ordering: number/status before money
    expect(rows[0].key).toBe("orderNumber");
  });

  it("treats diff as money for orders but qty for inventory drift", () => {
    const money = renderFacts({ orderNumber: "HD-2", totalAmount: 200000, capturedTotal: 150000, diff: -50000 });
    expect(money.find((r) => r.key === "diff")!.value).toContain("50.000");
    const qty = renderFacts({ productName: "Cà phê", onHand: 5, ledgerSum: 3, diff: 2 });
    expect(qty.find((r) => r.key === "diff")!.value).toBe("2");
    expect(qty.find((r) => r.key === "onHand")!.value).toBe("5");
  });

  it("returns [] for empty facts", () => {
    expect(renderFacts(null)).toEqual([]);
    expect(renderFacts({})).toEqual([]);
  });
});

describe("helpers", () => {
  it("sumCounts adds a count map", () => {
    expect(sumCounts({ high: 2, medium: 1, low: 0 })).toBe(3);
    expect(sumCounts(null)).toBe(0);
  });
  it("isActiveStatus distinguishes open vs closed", () => {
    expect(isActiveStatus("detected")).toBe(true);
    expect(isActiveStatus("action_pending")).toBe(true);
    expect(isActiveStatus("resolved")).toBe(false);
    expect(isActiveStatus("dismissed")).toBe(false);
  });
  it("has an OTHER dismiss reason that needs a note", () => {
    const other = IGNORE_REASONS.find((r) => r.code === "OTHER");
    expect(other?.needsNote).toBe(true);
  });
  it("exposes Vietnamese labels for impact/family/status", () => {
    expect(IMPACT_LABEL.high).toBe("Nghiêm trọng");
    expect(FAMILY_LABEL.amount_mismatch).toBe("Lệch số tiền");
    expect(STATUS_LABEL.resolved).toBe("Đã xử lý");
  });
});
