// Functional 05 pure client helpers: reason/movement labels, the SAME variance
// math as the server (server/f5/count-math.js) so the review screen never drifts,
// quantity formatting/parsing with unit precision, and small validators. Kept pure
// + dependency-free so it is unit-tested (src/lib/inventory.test.ts).
import type { StockState } from "./api";

// ── Reason codes (spec 3.3 / 4.2 — mirror server/f5/reasons.js) ──────────────
export const REASON_CODES = ["DAMAGED", "LOST", "FOUND", "CORRECTION", "OTHER"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_LABEL: Record<string, string> = {
  DAMAGED: "Hư hỏng",
  LOST: "Thất thoát / Mất",
  FOUND: "Tìm thấy thêm",
  CORRECTION: "Đếm sai kỳ trước",
  OTHER: "Khác",
  MISSING: "Chưa thấy hàng",
};

/** Reason options an INCREASE vs a DECREASE offers (FOUND only makes sense for +). */
export function reasonOptionsFor(direction: "increase" | "decrease"): { value: ReasonCode; label: string }[] {
  const all: ReasonCode[] = direction === "increase"
    ? ["FOUND", "CORRECTION", "OTHER"]
    : ["DAMAGED", "LOST", "CORRECTION", "OTHER"];
  return all.map((v) => ({ value: v, label: REASON_LABEL[v] }));
}

/** True when a reason/note pair is complete enough to post (OTHER needs a note). */
export function reasonComplete(reasonCode: string | null | undefined, note: string | null | undefined): boolean {
  if (!reasonCode) return false;
  if (reasonCode === "OTHER") return Boolean(note && note.trim());
  return true;
}

// ── Movement labels (spec 3.2) ───────────────────────────────────────────────
export const MOVEMENT_LABEL: Record<string, string> = {
  opening: "Tồn đầu kỳ",
  sale: "Bán hàng",
  sale_return: "Khách trả hàng",
  purchase_receipt: "Nhập hàng",
  damage_writeoff: "Hàng hỏng / hủy",
  manual_adjustment: "Điều chỉnh tay",
  count_adjustment: "Kiểm kê",
  reversal: "Đảo bút toán",
};

export function movementLabel(type: string): string {
  return MOVEMENT_LABEL[type] ?? type;
}

export const STATE_LABEL: Record<StockState, string> = {
  ok: "Còn hàng", low: "Sắp hết", zero: "Hết hàng", negative: "Âm kho",
};

// ── Quantity formatting / parsing (numeric(14,3)) ────────────────────────────
export function round3(n: number): number {
  return Math.round(Number(n) * 1000) / 1000;
}

/** Trim trailing zeros for display (12.000 → "12", 1.500 → "1.5"). */
export function fmtQty(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const r = round3(Number(n));
  return Number.isInteger(r) ? String(r) : String(r).replace(/\.?0+$/, "");
}

/** Signed quantity for a ledger row: "+3" / "-2" / "0". */
export function fmtDelta(n: number): string {
  const r = round3(n);
  return (r > 0 ? "+" : "") + fmtQty(r);
}

/** Parse a numeric text field to a non-negative quantity, or null if blank/invalid. */
export function parseQty(input: string): number | null {
  const s = String(input ?? "").trim().replace(",", ".");
  if (s === "") return null;
  if (!/^\d+(\.\d{0,3})?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? round3(n) : null;
}

// ── Variance math (mirror server/f5/count-math.js) ───────────────────────────
const EPS = 1e-9;

export interface Variance { counted: number | null; variance: number | null; deltaFromExpected: number | null; requiresReason: boolean; missing: boolean; }

export function computeVariance(expectedAtStart: number, currentOnHand: number, countedQty: number | null): Variance {
  if (countedQty == null) return { counted: null, variance: null, deltaFromExpected: null, requiresReason: false, missing: true };
  const counted = round3(countedQty);
  const variance = round3(counted - round3(currentOnHand));
  const deltaFromExpected = round3(counted - round3(expectedAtStart));
  return { counted, variance, deltaFromExpected, requiresReason: Math.abs(variance) > EPS, missing: false };
}

/** Does every variance line have the reason it needs to be postable? */
export function countReadyToPost(lines: { variance?: number | null; reasonCode?: string | null; note?: string | null; countedQty?: number | null }[]): boolean {
  let anyCounted = false;
  for (const l of lines) {
    if (l.countedQty == null) continue;
    anyCounted = true;
    if (l.variance != null && Math.abs(l.variance) > EPS && !reasonComplete(l.reasonCode, l.note)) return false;
  }
  return anyCounted;
}
