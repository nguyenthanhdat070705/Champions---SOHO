import { describe, expect, it } from "vitest";
import {
  actionNavTarget,
  cashQrSplit,
  derivePriorityItems,
  selectZeroState,
} from "./dashboard";
import type { DashboardSnapshot, OpenAction } from "./dashboard";

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    merchantId: "m1",
    businessDate: "2026-08-16",
    grossSalesAmount: 0,
    refundAmount: 0,
    netSalesAmount: 0,
    cashNetAmount: 0,
    qrNetAmount: 0,
    paidOrderCount: 0,
    lowStockCount: 0,
    openActionCount: 0,
    pendingQrCount: 0,
    attentionCount: 0,
    dataFreshAt: "2026-08-16T20:30:00+07:00",
    ...over,
  };
}

function action(over: Partial<OpenAction> = {}): OpenAction {
  return {
    id: "a1",
    actionType: "other",
    severity: "info",
    title: "Việc",
    description: null,
    entityType: null,
    entityId: null,
    detectedAt: "2026-08-16T10:00:00+07:00",
    ...over,
  };
}

describe("selectZeroState", () => {
  it("is 'fresh' when nothing happened today", () => {
    expect(selectZeroState(snap())).toBe("fresh");
  });

  it("is 'pending_only' when the only activity is a pending QR", () => {
    expect(selectZeroState(snap({ pendingQrCount: 1 }))).toBe("pending_only");
  });

  it("is 'has_data' when there are paid orders", () => {
    expect(
      selectZeroState(snap({ paidOrderCount: 1, grossSalesAmount: 100000 })),
    ).toBe("has_data");
  });

  it("is 'has_data' for a refund-only day (negative net, no sales)", () => {
    // Refund today for yesterday's bill: gross 0, refund 100k, net -100k.
    expect(
      selectZeroState(
        snap({ refundAmount: 100000, netSalesAmount: -100000 }),
      ),
    ).toBe("has_data");
  });

  it("prefers has_data over pending when both present", () => {
    expect(
      selectZeroState(snap({ paidOrderCount: 2, pendingQrCount: 1 })),
    ).toBe("has_data");
  });
});

describe("derivePriorityItems", () => {
  it("returns an empty list when there is nothing to do", () => {
    expect(derivePriorityItems(snap(), [])).toEqual([]);
  });

  it("synthesizes pending-QR (P2) and low-stock (P3) items with correct routes", () => {
    const items = derivePriorityItems(
      snap({ pendingQrCount: 2, lowStockCount: 3 }),
      [],
    );
    expect(items).toHaveLength(2);
    const qr = items.find((i) => i.kind === "pending_qr")!;
    const stock = items.find((i) => i.kind === "low_stock")!;
    expect(qr.priority).toBe(2);
    expect(qr.to).toBe("/don-hang");
    expect(qr.title).toContain("2");
    expect(stock.priority).toBe(3);
    expect(stock.to).toBe("/kho");
    expect(stock.title).toContain("3");
    // pending QR (P2) sorts before low stock (P3)
    expect(items[0].kind).toBe("pending_qr");
  });

  it("orders by severity: critical action first, then pending QR, then low stock", () => {
    const items = derivePriorityItems(
      snap({ pendingQrCount: 1, lowStockCount: 1 }),
      [action({ id: "crit", severity: "critical", title: "Lỗi kết nối" })],
    );
    expect(items.map((i) => i.kind)).toEqual([
      "action",
      "pending_qr",
      "low_stock",
    ]);
    expect(items[0].priority).toBe(1);
  });

  it("caps the list at the limit (default 3)", () => {
    const actions = [
      action({ id: "a", severity: "critical", title: "A" }),
      action({ id: "b", severity: "warning", title: "B" }),
      action({ id: "c", severity: "info", title: "C" }),
      action({ id: "d", severity: "info", title: "D" }),
    ];
    const items = derivePriorityItems(
      snap({ pendingQrCount: 1, lowStockCount: 1 }),
      actions,
    );
    expect(items).toHaveLength(3);
    // Highest severity survives the cap.
    expect(items[0].title).toBe("A");
  });

  it("respects a custom limit (Xem tất cả)", () => {
    const actions = [
      action({ id: "a", severity: "critical" }),
      action({ id: "b", severity: "warning" }),
    ];
    const items = derivePriorityItems(
      snap({ pendingQrCount: 1, lowStockCount: 1 }),
      actions,
      50,
    );
    expect(items).toHaveLength(4);
  });

  it("uses the action title/description and maps its nav target", () => {
    const items = derivePriorityItems(snap(), [
      action({
        id: "x",
        actionType: "data_sync",
        severity: "critical",
        title: "Dữ liệu chưa đồng bộ",
        description: "Đơn và thanh toán lệch nhau.",
      }),
    ]);
    expect(items[0].title).toBe("Dữ liệu chưa đồng bộ");
    expect(items[0].desc).toBe("Đơn và thanh toán lệch nhau.");
    expect(items[0].to).toBe("/don-hang");
  });

  it("keeps two same-severity actions in their given (severity+time) order", () => {
    const items = derivePriorityItems(snap(), [
      action({ id: "first", severity: "warning", title: "First" }),
      action({ id: "second", severity: "warning", title: "Second" }),
    ]);
    expect(items.map((i) => i.title)).toEqual(["First", "Second"]);
  });
});

describe("actionNavTarget", () => {
  it("maps action types to the right screen", () => {
    expect(actionNavTarget("payment_provider")).toBe("/cai-dat");
    expect(actionNavTarget("setup_incomplete")).toBe("/cai-dat");
    expect(actionNavTarget("data_sync")).toBe("/don-hang");
    expect(actionNavTarget("other")).toBe("/cai-dat");
    expect(actionNavTarget("unknown-future-type")).toBe("/cai-dat");
  });
});

describe("cashQrSplit", () => {
  it("computes complementary percentages summing to 100", () => {
    const { cashPct, qrPct } = cashQrSplit(
      snap({ cashNetAmount: 1100000, qrNetAmount: 2000000 }),
    );
    expect(cashPct + qrPct).toBe(100);
    expect(qrPct).toBeGreaterThan(cashPct);
  });

  it("returns 0/0 when there is nothing positive to split", () => {
    expect(cashQrSplit(snap())).toEqual({ cashPct: 0, qrPct: 0 });
  });

  it("ignores negative components (a fully refunded method)", () => {
    const { cashPct, qrPct } = cashQrSplit(
      snap({ cashNetAmount: -50000, qrNetAmount: 100000 }),
    );
    expect(cashPct).toBe(0);
    expect(qrPct).toBe(100);
  });
});
