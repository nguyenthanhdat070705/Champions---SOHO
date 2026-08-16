// Functional 12 — pure client helpers for the reconciliation UI (labels, tones,
// evidence rendering). No network, no React → unit-tested in reconciliation.test.ts.
// Mirrors the server rule families/impacts; the server remains the source of truth.
import { formatVnd } from "./format";
import type { ReconImpact, ReconFamily, ReconIssueStatus } from "./api";

export const IMPACT_LABEL: Record<ReconImpact, string> = {
  high: "Nghiêm trọng", medium: "Cần xem", low: "Nhẹ",
};
/** CSS tone suffix for the impact badge (chip--red / chip--amber / chip--teal). */
export const IMPACT_TONE: Record<ReconImpact, string> = {
  high: "red", medium: "amber", low: "teal",
};
export const IMPACT_ORDER: ReconImpact[] = ["high", "medium", "low"];

export const FAMILY_LABEL: Record<ReconFamily, string> = {
  missing: "Thiếu liên kết",
  duplicate: "Nghi trùng",
  amount_mismatch: "Lệch số tiền",
  state_mismatch: "Lệch trạng thái",
  orphan: "Chứng từ mồ côi",
};
export const FAMILY_DESC: Record<ReconFamily, string> = {
  missing: "Giao dịch thiếu bản ghi đối ứng",
  duplicate: "Một chứng từ dùng cho nhiều bản ghi",
  amount_mismatch: "Số tiền hai bên không khớp",
  state_mismatch: "Trạng thái các nguồn không đồng bộ",
  orphan: "Chứng từ không còn nguồn gốc",
};
/** The families surfaced as cards on the reconciliation centre (spec 3.1). */
export const CENTER_FAMILIES: ReconFamily[] = ["missing", "duplicate", "amount_mismatch", "state_mismatch"];

export const STATUS_LABEL: Record<ReconIssueStatus, string> = {
  detected: "Mới phát hiện",
  in_review: "Đang xem",
  action_pending: "Đang xử lý",
  resolved: "Đã xử lý",
  dismissed: "Đã bỏ qua",
  failed: "Lỗi kiểm tra",
};
export const STATUS_TONE: Record<ReconIssueStatus, string> = {
  detected: "amber", in_review: "blue", action_pending: "blue",
  resolved: "green", dismissed: "muted", failed: "red",
};
export const ACTIVE_STATUSES: ReconIssueStatus[] = ["detected", "in_review", "action_pending", "failed"];
export function isActiveStatus(s: ReconIssueStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}

/** Fixed dismiss-reason allowlist (spec 4.2 / REC-10). OTHER requires a note. */
export const IGNORE_REASONS: { code: string; label: string; needsNote?: boolean }[] = [
  { code: "KNOWN_OK", label: "Đã kiểm tra, không có vấn đề" },
  { code: "DUPLICATE_ISSUE", label: "Trùng với vấn đề khác" },
  { code: "WILL_FIX_LATER", label: "Sẽ xử lý sau" },
  { code: "OTHER", label: "Lý do khác", needsNote: true },
];

const HIDDEN_FACT_KEYS = new Set(["orderId", "productId", "paymentId", "receiptId", "expenseId"]);
const MONEY_KEYS = new Set(["totalAmount", "capturedTotal", "amount", "grandTotalVnd"]);
const QTY_KEYS = new Set(["onHand", "ledgerSum"]);
const DATE_KEYS = new Set(["paidAt", "postedAt", "createdAt", "expiresAt"]);
const FACT_LABEL: Record<string, string> = {
  orderNumber: "Mã bill", receiptNumber: "Số phiếu nhập", expenseNumber: "Số khoản chi",
  productName: "Sản phẩm", orderStatus: "Trạng thái bill", status: "Trạng thái", method: "Hình thức",
  totalAmount: "Tổng bill", capturedTotal: "Đã thu", amount: "Số tiền", grandTotalVnd: "Tổng tiền",
  onHand: "Tồn hiển thị", ledgerSum: "Sổ chuyển động", diff: "Chênh lệch",
  paidAt: "Thời điểm thu", postedAt: "Thời điểm ghi", createdAt: "Tạo lúc", expiresAt: "Hết hạn",
};
/** Order facts are rendered in (money next to money, ids hidden). */
const FACT_ORDER = [
  "orderNumber", "receiptNumber", "expenseNumber", "productName", "orderStatus", "status", "method",
  "totalAmount", "capturedTotal", "amount", "grandTotalVnd", "onHand", "ledgerSum", "diff",
  "paidAt", "postedAt", "createdAt", "expiresAt",
];

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const s = String(v);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(d);
}

export interface FactRow { key: string; label: string; value: string; }

/**
 * Render an evidence/live facts blob into labelled display rows. Money fields use
 * đồng formatting; qty fields are raw; ids are hidden (the deep-link carries them).
 * `diff` formats as money unless the facts describe an inventory drift (onHand set).
 */
export function renderFacts(facts: Record<string, unknown> | null | undefined): FactRow[] {
  if (!facts) return [];
  const isQtyContext = facts.onHand !== undefined || facts.ledgerSum !== undefined;
  const out: FactRow[] = [];
  for (const key of FACT_ORDER) {
    if (!(key in facts) || HIDDEN_FACT_KEYS.has(key)) continue;
    const raw = facts[key];
    if (raw === null || raw === undefined) continue;
    let value: string;
    if (MONEY_KEYS.has(key)) value = formatVnd(Number(raw));
    else if (QTY_KEYS.has(key)) value = String(raw);
    else if (DATE_KEYS.has(key)) value = fmtDate(raw);
    else if (key === "diff") value = isQtyContext ? String(raw) : formatVnd(Number(raw));
    else value = String(raw);
    out.push({ key, label: FACT_LABEL[key] || key, value });
  }
  return out;
}

/** Total active issues across a byImpact/byFamily count map. */
export function sumCounts(map: Record<string, number> | undefined | null): number {
  if (!map) return 0;
  return Object.values(map).reduce((a, b) => a + Number(b || 0), 0);
}
