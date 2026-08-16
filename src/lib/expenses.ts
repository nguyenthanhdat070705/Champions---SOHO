// Functional 07 client helpers — labels + pure math mirroring the server
// (server/f7/money.js is the authority; this is display + input validation only).
import type { ExpenseStatus, PaymentMethod, ExpenseCategory } from "./api";

export const STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: "Bản nháp",
  extracting: "Đang đọc",
  review: "Cần xem",
  ready: "Sẵn sàng",
  posted: "Đã ghi",
  reversed: "Đã đảo",
  cancelled: "Đã bỏ",
};

/** Tone for the status badge (maps to existing chip/badge colours). */
export function statusTone(s: ExpenseStatus): "muted" | "warn" | "ok" | "danger" {
  if (s === "posted") return "ok";
  if (s === "reversed" || s === "cancelled") return "danger";
  if (s === "review" || s === "extracting") return "warn";
  return "muted";
}

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Tiền mặt",
  transfer: "Chuyển khoản",
  other: "Khác",
};

export function paymentLabel(method: PaymentMethod | null, status: string | null): string {
  if (!method) return "Chưa ghi";
  const m = METHOD_LABEL[method];
  if (status === "confirmed") return `${m} · đã xác nhận`;
  return `${m} · chưa xác nhận`;
}

/** The list filter chips (spec 3.1). */
export const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Tất cả" },
  { key: "draft", label: "Nháp" },
  { key: "review", label: "Cần xem" },
  { key: "posted", label: "Đã ghi" },
  { key: "reversed", label: "Đã đảo" },
];

/** Parse a VND string ("1.280.000", "1280000") → integer đồng, or null. */
export function parseVnd(raw: string): number | null {
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Group thousands for a money input display without a currency suffix. */
export function groupVnd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return Math.round(n).toLocaleString("vi-VN");
}

/** YYYY-MM for the current month in Asia/Ho_Chi_Minh. */
export function currentMonth(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit" })
    .format(new Date()).slice(0, 7);
}

/** Today in Asia/Ho_Chi_Minh as YYYY-MM-DD (default expense_date). */
export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date());
}

/** Human month header e.g. "Tháng 8/2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `Tháng ${Number(m)}/${y}`;
}

/**
 * Best-effort match of an AI category-candidate name to one of the merchant's
 * categories (spec 4.2: AI suggests, user confirms — this only PRESELECTS).
 */
export function matchCategoryCandidate(candidates: string[], categories: ExpenseCategory[]): string | null {
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
  for (const cand of candidates) {
    const c = norm(cand);
    const hit = categories.find((cat) => norm(cat.displayName) === c || norm(cat.code) === c);
    if (hit) return hit.id;
  }
  // partial contains
  for (const cand of candidates) {
    const c = norm(cand);
    const hit = categories.find((cat) => norm(cat.displayName).includes(c) || c.includes(norm(cat.displayName)));
    if (hit) return hit.id;
  }
  return null;
}
