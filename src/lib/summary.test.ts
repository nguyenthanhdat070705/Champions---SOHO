import { describe, expect, it } from "vitest";
import {
  containsForbiddenTerms,
  fallbackSummary,
  getSummary,
} from "./summary";
import type { SummaryProvider } from "./summary";
import type { DashboardSnapshot } from "./dashboard";

function snap(over: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    merchantId: "m1",
    businessDate: "2026-08-16",
    grossSalesAmount: 3200000,
    refundAmount: 100000,
    netSalesAmount: 3100000,
    cashNetAmount: 1100000,
    qrNetAmount: 2000000,
    paidOrderCount: 18,
    lowStockCount: 3,
    openActionCount: 1,
    pendingQrCount: 1,
    attentionCount: 5,
    dataFreshAt: "2026-08-16T20:30:00+07:00",
    ...over,
  };
}

describe("fallbackSummary (spec 9.4)", () => {
  it("puts net revenue in the headline and bill count in the summary", () => {
    const r = fallbackSummary(snap());
    expect(r.headline).toBe("Hôm nay: 3.100.000đ");
    expect(r.summary).toContain("18 bill");
    expect(r.status).toBe("fallback");
    expect(r.priorities).toEqual([]);
  });

  it("adds the pending-QR sentence, stating it is not counted as revenue", () => {
    const r = fallbackSummary(snap({ pendingQrCount: 1 }));
    expect(r.summary).toContain("1 giao dịch QR đang chờ xác nhận");
    expect(r.summary).toContain("chưa tính vào doanh thu");
  });

  it("omits the pending-QR sentence when there are none", () => {
    const r = fallbackSummary(snap({ pendingQrCount: 0 }));
    expect(r.summary).toBe("Cửa hàng đã hoàn tất 18 bill.");
    expect(r.summary).not.toContain("QR");
  });

  it("renders a negative net (refund > sales) correctly", () => {
    const r = fallbackSummary(
      snap({ netSalesAmount: -100000, paidOrderCount: 0, pendingQrCount: 0 }),
    );
    expect(r.headline).toBe("Hôm nay: -100.000đ");
    expect(r.summary).toBe("Cửa hàng đã hoàn tất 0 bill.");
  });

  it("never uses the forbidden 'công nợ' / 'chưa thu' language", () => {
    for (const s of [
      snap(),
      snap({ pendingQrCount: 5 }),
      snap({ netSalesAmount: -100000 }),
    ]) {
      const r = fallbackSummary(s);
      expect(containsForbiddenTerms(r.headline)).toBe(false);
      expect(containsForbiddenTerms(r.summary)).toBe(false);
    }
  });
});

describe("containsForbiddenTerms", () => {
  it("flags credit-sale / unpaid terminology", () => {
    expect(containsForbiddenTerms("Khách còn công nợ 50k")).toBe(true);
    expect(containsForbiddenTerms("Số tiền CHƯA THU")).toBe(true);
    expect(containsForbiddenTerms("khoản phải thu")).toBe(true);
  });
  it("passes clean revenue language", () => {
    expect(containsForbiddenTerms("Doanh thu thuần 3.100.000đ")).toBe(false);
  });
});

describe("getSummary (pluggable provider)", () => {
  it("uses the deterministic fallback when no provider is given", async () => {
    const r = await getSummary(snap());
    expect(r.status).toBe("fallback");
    expect(r.headline).toBe("Hôm nay: 3.100.000đ");
  });

  it("uses a valid provider result when supplied", async () => {
    const provider: SummaryProvider = {
      async generate() {
        return {
          headline: "Hôm nay: 3.100.000đ",
          summary: "Ngày bán tốt, QR chiếm phần lớn.",
          priorities: [],
          status: "generated",
        };
      },
    };
    const r = await getSummary(snap(), provider);
    expect(r.status).toBe("generated");
    expect(r.summary).toContain("QR chiếm phần lớn");
  });

  it("falls back when the provider emits a forbidden term", async () => {
    const provider: SummaryProvider = {
      async generate() {
        return {
          headline: "Hôm nay",
          summary: "Khách còn công nợ.",
          priorities: [],
          status: "generated",
        };
      },
    };
    const r = await getSummary(snap(), provider);
    expect(r.status).toBe("fallback");
  });

  it("falls back when the provider throws (AI down / timeout)", async () => {
    const provider: SummaryProvider = {
      async generate() {
        throw new Error("timeout");
      },
    };
    const r = await getSummary(snap(), provider);
    expect(r.status).toBe("fallback");
    expect(r.headline).toBe("Hôm nay: 3.100.000đ");
  });
});
