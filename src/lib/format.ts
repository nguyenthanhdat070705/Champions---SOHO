// Pure display formatting for the Today dashboard. No side effects.
// Money is stored as bigint đồng (VND, no decimals); we render Vietnamese
// grouping ("3.100.000đ"). Negative amounts render with a leading minus so the
// refund-larger-than-sales case is shown honestly.

const HCM_TZ = "Asia/Ho_Chi_Minh";

/**
 * Format a whole-đồng integer amount as Vietnamese currency, e.g.
 *   3100000  → "3.100.000đ"
 *   0        → "0đ"
 *   -100000  → "-100.000đ"
 * Non-finite / NaN inputs fall back to "0đ" so the UI never shows "NaNđ".
 */
export function formatVnd(amount: number): string {
  if (!Number.isFinite(amount)) return "0đ";
  const n = Math.trunc(amount);
  const neg = n < 0;
  const grouped = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (neg ? "-" : "") + grouped + "đ";
}

/**
 * Short "triệu" phrasing used only where a compact hero label is wanted,
 * e.g. 3100000 → "3,1 triệu". Falls back to full formatVnd below 1 triệu.
 * (The AI/fallback summary uses formatVnd, not this — kept for optional UI use.)
 */
export function formatVndShort(amount: number): string {
  if (!Number.isFinite(amount)) return "0đ";
  const n = Math.trunc(amount);
  if (Math.abs(n) < 1_000_000) return formatVnd(n);
  const millions = n / 1_000_000;
  const text = millions
    .toFixed(1)
    .replace(/\.0$/, "")
    .replace(".", ",");
  return `${text} triệu`;
}

/** ISO timestamp → "HH:MM" in Asia/Ho_Chi_Minh (24h). "" when unparseable. */
export function formatClockVN(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: HCM_TZ,
  }).format(d);
}

/**
 * Business date (a "YYYY-MM-DD" date string, or ISO timestamp) → "Thứ …,
 * dd/mm/yyyy" in Vietnamese. Parsing a bare date is done as local midnight so
 * the weekday is stable regardless of the viewer's clock.
 */
export function formatBusinessDateVN(date: string | null | undefined): string {
  if (!date) return "";
  // A bare YYYY-MM-DD is parsed as UTC by Date; append T00:00 to keep the day.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}
