// Functional 11 — pure client helpers for the cashbook (labels, method/period
// vocab, small guards). Mirrors server/f11/mapping.js so the UI speaks the same
// taxonomy. No network, no React — unit-tested in cashbook.test.ts.
import type { CashbookDirection, CashbookMethod, CashbookPeriod, CashbookReviewDraft } from "./api";

/** entry_type → Vietnamese label (spec §4.1 taxonomy). */
export const ENTRY_TYPE_LABEL: Record<string, string> = {
  sales_receipt: "Thu bán hàng",
  other_receipt: "Thu khác",
  sales_refund: "Hoàn tiền bán hàng",
  operating_expense: "Chi vận hành",
  inventory_purchase: "Mua hàng nhập kho",
  adjustment: "Điều chỉnh",
};

/** The entry types a person can pick when resolving/creating a draft, by side. */
export const ENTRY_TYPE_OPTIONS: { value: string; label: string; direction: CashbookDirection }[] = [
  { value: "sales_receipt", label: "Thu bán hàng", direction: "in" },
  { value: "other_receipt", label: "Thu khác", direction: "in" },
  { value: "operating_expense", label: "Chi vận hành", direction: "out" },
  { value: "inventory_purchase", label: "Mua hàng nhập kho", direction: "out" },
  { value: "sales_refund", label: "Hoàn tiền bán hàng", direction: "out" },
];

export function entryTypeLabel(t: string | null | undefined): string {
  return (t && ENTRY_TYPE_LABEL[t]) || t || "—";
}
export function directionOfEntryType(t: string | null | undefined): CashbookDirection | null {
  return ENTRY_TYPE_OPTIONS.find((o) => o.value === t)?.direction ?? null;
}

export const METHOD_LABEL: Record<CashbookMethod, string> = {
  cash: "Tiền mặt",
  transfer: "Chuyển khoản",
  other: "Khác",
  unknown: "Chưa rõ",
};
export const METHOD_OPTIONS: { value: CashbookMethod; label: string }[] = [
  { value: "cash", label: "Tiền mặt" },
  { value: "transfer", label: "Chuyển khoản" },
  { value: "other", label: "Khác" },
];

export const REASON_CODE_LABEL: Record<string, string> = {
  missing_date: "Thiếu ngày nghiệp vụ",
  missing_type: "Chưa rõ loại khoản",
  missing_payment_method: "Thiếu phương thức thanh toán",
  needs_payment_confirmation: "Cần xác nhận đã chi tiền",
  abnormal_amount: "Số tiền bất thường",
  source_mismatch: "Số tiền chưa khớp nguồn",
};

export const EXCLUDE_REASON_OPTIONS: { value: string; label: string }[] = [
  { value: "not_cash_movement", label: "Không phải khoản tiền vào/ra" },
  { value: "duplicate", label: "Trùng với khoản đã ghi" },
  { value: "wrong_source", label: "Nguồn không hợp lệ" },
  { value: "other", label: "Lý do khác" },
];

export const REVERSAL_REASON_OPTIONS: { value: string; label: string }[] = [
  { value: "wrong_amount", label: "Sai số tiền" },
  { value: "wrong_classification", label: "Sai phân loại" },
  { value: "duplicate", label: "Ghi trùng" },
  { value: "source_reversed", label: "Nguồn đã bị hủy/đảo" },
  { value: "other", label: "Lý do khác" },
];

export const PERIOD_TABS: { value: CashbookPeriod; label: string }[] = [
  { value: "today", label: "Hôm nay" },
  { value: "week", label: "Tuần" },
  { value: "month", label: "Tháng" },
];

/** Sign a directional amount for display (+ thu / − chi). */
export function signedAmount(direction: CashbookDirection, amount: number): number {
  return direction === "in" ? amount : -amount;
}

/** Does a draft carry everything needed to preview/post? (mirrors server gate) */
export function draftReady(d: Partial<CashbookReviewDraft>): boolean {
  return (
    (d.direction === "in" || d.direction === "out") &&
    typeof d.entryType === "string" && Boolean(ENTRY_TYPE_LABEL[d.entryType]) &&
    Number(d.amountVnd) > 0 &&
    Boolean(d.occurredAt) &&
    (["cash", "transfer", "other"] as string[]).includes(String(d.paymentMethod))
  );
}

/** The first missing field label for a draft, or null when ready. */
export function firstMissing(d: Partial<CashbookReviewDraft>): string | null {
  if (!d.entryType) return "loại khoản";
  if (!(Number(d.amountVnd) > 0)) return "số tiền";
  if (!d.occurredAt) return "ngày";
  if (!d.paymentMethod || d.paymentMethod === "unknown") return "phương thức thanh toán";
  return null;
}
