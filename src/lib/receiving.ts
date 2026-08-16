// Functional 06 pure client helpers: receipt status labels, the SAME totals math
// as the server (server/f6/receiving-math.js) so the draft screen never drifts,
// and small formatters. Kept pure + dependency-free so it is unit-tested
// (src/lib/receiving.test.ts) and cannot diverge from the server.

export type ReceiptStatus = "draft" | "extracting" | "review" | "ready" | "posted" | "reversed" | "cancelled";

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  draft: "Nháp",
  extracting: "Đang đọc",
  review: "Cần kiểm tra",
  ready: "Sẵn sàng",
  posted: "Đã nhập",
  reversed: "Đã đảo",
  cancelled: "Đã hủy",
};

/** Pill style class per status (reuses the shared pill palette in index.css). */
export function receiptStatusClass(status: ReceiptStatus): string {
  if (status === "posted") return "pill--active";
  if (status === "reversed" || status === "cancelled") return "pill--archived";
  if (status === "ready") return "pill--low";
  return "pill--inactive";
}

/** A receipt is still editable (draft/review/ready) — not yet committed. */
export function isEditable(status: ReceiptStatus): boolean {
  return status === "draft" || status === "review" || status === "ready";
}

export function round3(n: number): number {
  return Math.round(Number(n) * 1000) / 1000;
}

/** line_total = round(quantity × unit_cost) in đồng — identical to the server. */
export function lineTotal(quantity: number, unitCostVnd: number): number {
  const q = round3(quantity);
  const c = Math.max(0, Math.round(Number(unitCostVnd) || 0));
  return Math.round(q * c);
}

export interface ReceiptLineInput { quantity: number; unitCostVnd: number; }

/** subtotal = Σ line_total; grand_total = subtotal + extra_cost (server mirror). */
export function computeTotals(lines: ReceiptLineInput[], extraCostVnd = 0) {
  let subtotal = 0;
  for (const l of lines) subtotal += lineTotal(l.quantity, l.unitCostVnd);
  const extra = Math.max(0, Math.round(Number(extraCostVnd) || 0));
  return { subtotalVnd: subtotal, extraCostVnd: extra, grandTotalVnd: subtotal + extra };
}

/** Trim trailing zeros for display (12.000 → "12", 1.500 → "1.5"). */
export function fmtQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const r = round3(Number(n));
  return Number.isInteger(r) ? String(r) : String(r).replace(/\.?0+$/, "");
}

/** Parse a numeric text field to a positive quantity, or null if blank/invalid. */
export function parseQty(input: string): number | null {
  const s = String(input ?? "").trim().replace(",", ".");
  if (s === "") return null;
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const n = round3(Number(s));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse a VND cost field (digits only) to a non-negative integer, or null. */
export function parseCost(input: string): number | null {
  const s = String(input ?? "").replace(/\D/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
