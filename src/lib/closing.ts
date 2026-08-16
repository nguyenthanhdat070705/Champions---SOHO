// Functional 14 client mirror (spec §3). Pure helpers for the "Chốt tiền cuối
// ngày" screens: the denomination allowlist, reason catalog, an OPTIMISTIC client
// count total (the server recomputes and is authoritative — this only drives the
// live hero while typing), and variance formatting. Unit-tested in closing.test.ts.

/** VND note denominations, largest-first (mirrors server closing.js). */
export const DENOMINATIONS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];

export type ClosingReasonCode = "miscount" | "unrecorded_expense" | "unrecorded_receipt" | "other";
export interface ReasonDef { code: ClosingReasonCode; label: string; needsNote: boolean; }
export const REASON_CODES: ReasonDef[] = [
  { code: "miscount", label: "Đếm nhầm khi kiểm quỹ", needsNote: false },
  { code: "unrecorded_expense", label: "Có khoản chi chưa ghi nhận", needsNote: false },
  { code: "unrecorded_receipt", label: "Có khoản thu chưa ghi nhận", needsNote: false },
  { code: "other", label: "Lý do khác", needsNote: true },
];
export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "";
  return REASON_CODES.find((r) => r.code === code)?.label ?? code;
}

export type CountMode = "total" | "denomination";
export type VarianceClass = "match" | "surplus" | "shortage" | null;

/** Optimistic client total for the denomination grid (server re-verifies). */
export function optimisticDenominationTotal(quantities: Record<number, number>): number {
  let total = 0;
  for (const denom of DENOMINATIONS) {
    const q = quantities[denom];
    if (Number.isFinite(q) && q > 0) total += denom * Math.trunc(q);
  }
  return total;
}

export function classifyVariance(v: number | null): VarianceClass {
  if (v === null || v === undefined) return null;
  if (v === 0) return "match";
  return v > 0 ? "surplus" : "shortage";
}

/** "+20.000đ" / "−5.000đ" / "0đ" style, given a variance and a VND formatter. */
export function signedVnd(v: number, fmt: (n: number) => string): string {
  if (v === 0) return fmt(0);
  return (v > 0 ? "+" : "−") + fmt(Math.abs(v));
}

export function varianceHeadline(v: number | null): string {
  if (v === null) return "Chưa đếm tiền";
  if (v === 0) return "Khớp — không lệch";
  return v > 0 ? "Thừa quỹ" : "Thiếu quỹ";
}

// ── API response types ───────────────────────────────────────────────────────
export interface ClosingListItem {
  id: string; businessDate: string; timezone: string;
  status: "draft" | "ready" | "confirmed" | "attention";
  currentRevisionId: string | null; activeDraftId: string | null;
  revisionNo: number | null;
  expectedCashVnd: number | null; countedCashVnd: number | null; varianceVnd: number | null;
  confirmedAt: string | null; openAttention: number;
}
export interface ClosingListResult { today: string; timezone: string; from: string; to: string; closings: ClosingListItem[]; }

export interface ClosingSource {
  sourceType: string; sourceId: string; eventType: string;
  direction: "in" | "out"; amountVnd: number; occurredAt: string; route: string | null;
}
export interface ClosingCount {
  id: string; versionNo: number; mode: CountMode; countedTotalVnd: number;
  denominationLines: { denominationVnd: number; quantity: number; lineTotalVnd: number }[];
  countedAt: string; countedBy: string;
}
export interface DraftDetail {
  draft: {
    id: string; closingId: string; status: string; cutOffAt: string; sourceSetHash: string;
    policyVersion: string; rowVersion: number; businessDate: string; timezone: string;
    closingStatus: string; isReclose: boolean;
  };
  expected: { expectedCashVnd: number; inflowVnd: number; outflowVnd: number; cashBillCount: number; cashRefundCount: number };
  sources: ClosingSource[];
  counts: ClosingCount[]; latestCount: ClosingCount | null;
  countedCashVnd: number | null; variance: number | null; varianceClass: VarianceClass;
  denominations: number[];
}
export interface ClosingPreview {
  draftId: string; closingId: string; businessDate: string; timezone: string; cutOffAt: string;
  expectedCashVnd: number; countedCashVnd: number; varianceVnd: number; varianceClass: VarianceClass;
  reasonRequired: boolean; reasonCode: string | null; reasonNote: string | null; reasonError: string | null;
  countVersion: number; sourceSetHash: string; draftVersion: number; previewHash: string;
  isReclose: boolean; inflowVnd: number; outflowVnd: number;
}
export interface ClosingConfirmResult {
  closingId: string; revisionId: string; revisionNo: number | null;
  expectedCashVnd: number | null; countedCashVnd: number | null; varianceVnd: number | null; replayed: boolean;
}
export interface ClosingRevision {
  id: string; revisionNo: number; sourceSetHash: string;
  expectedCashVnd: number; countedCashVnd: number; varianceVnd: number; varianceClass: VarianceClass;
  reasonCode: string | null; reasonNote: string | null; reasonLabel: string | null;
  previousRevisionId: string | null; confirmedBy: string; confirmedAt: string; contentHash: string;
}
export interface ClosingAttentionItem {
  id: string; closingId: string; revisionId: string;
  status: "open" | "resolved" | "dismissed";
  sourceFingerprint: string; sourceRef: Record<string, unknown>;
  impactVnd: number; decision: string | null; resolvedBy: string | null; resolvedAt: string | null;
}
export interface ClosingDetail {
  closing: {
    id: string; businessDate: string; timezone: string; status: string;
    currentRevisionId: string | null; activeDraftId: string | null; rowVersion: number;
  };
  current: ClosingRevision | null; revisions: ClosingRevision[];
  attentionItems: ClosingAttentionItem[];
  lateSources: (ClosingSource & { fingerprint: string; revisionId: string })[];
  openAttentionCount: number;
}
