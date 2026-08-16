// Functional 13 — pure client-side display helpers for the Báo cáo screen. No
// side effects; unit-tested in reports.test.ts. All numbers stay integers; only
// formatting happens here. Coverage is a first-class concept: "không có dữ liệu"
// is never shown as 0 (spec 4.4 / 3.7).
import { formatVnd } from "./format";
import type { Coverage } from "./api";

export const REPORT_PRESETS: { v: "day" | "week" | "month" | "quarter"; label: string }[] = [
  { v: "day", label: "Hôm nay" },
  { v: "week", label: "Tuần này" },
  { v: "month", label: "Tháng này" },
  { v: "quarter", label: "Quý này" },
];

/** Badge label + tone for a coverage status (spec 3.7 — show the state honestly). */
export function coverageMeta(status: Coverage): { label: string; tone: "good" | "amber" | "grey" } {
  switch (status) {
    case "complete": return { label: "Đủ dữ liệu", tone: "good" };
    case "partial": return { label: "Chưa đầy đủ", tone: "amber" };
    default: return { label: "Chưa đủ dữ liệu", tone: "grey" };
  }
}

/** Signed money delta, neutral (spec 3.6: no green/red good-bad judgment). */
export function formatDelta(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "±0đ";
  return (n > 0 ? "+" : "−") + formatVnd(Math.abs(n));
}

/** % change text; null base=0 → not-applicable, never "tăng vô hạn" (spec 4.3). */
export function pctText(pct: number | null): string {
  if (pct == null) return "Không áp dụng";
  if (pct === 0) return "0%";
  return (pct > 0 ? "+" : "−") + Math.abs(pct) + "%";
}

/** A relative bar width (0–100) for a value within a max, guarding /0. */
export function barPct(value: number, max: number): number {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Math.abs(value) / max) * 100)));
}

/** "Mốc dữ liệu" line — the as_of timestamp rendered in the merchant timezone. */
export function asOfText(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("vi-VN", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
    }).format(d);
  } catch {
    return iso;
  }
}

/** Format an integer quantity without trailing ".000" (numeric(14,3) columns). */
export function formatQty(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}
