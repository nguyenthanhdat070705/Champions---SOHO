// Functional 11 shared UI: direction badge, source chip (deep-links to the bill/
// receipt), method pill, and small VN date/time formatters for occurred_at.
import { useNavigate } from "react-router-dom";
import { formatVnd } from "../lib/format";
import { METHOD_LABEL } from "../lib/cashbook";
import type { CashbookDirection, CashbookMethod, CashbookSource } from "../lib/api";

export function DirectionBadge({ direction, reversed }: { direction: CashbookDirection; reversed?: boolean }) {
  return (
    <span className={`pill ${direction === "in" ? "pill--in" : "pill--out"}`}>
      {direction === "in" ? "Thu" : "Chi"}{reversed ? " · đã đảo" : ""}
    </span>
  );
}

export function MethodPill({ method }: { method: CashbookMethod }) {
  return <span className="muted tiny">{METHOD_LABEL[method] || method}</span>;
}

/** Signed amount with a leading + / − and VND unit. */
export function SignedAmount({ direction, amount }: { direction: CashbookDirection; amount: number }) {
  return (
    <span className={direction === "in" ? "cbk-amt cbk-amt--in" : "cbk-amt cbk-amt--out"}>
      {direction === "in" ? "+" : "−"}{formatVnd(amount)}
    </span>
  );
}

/** Source chip. Tapping opens the authorized deep-link (bill/receipt). */
export function SourceChip({ source }: { source: CashbookSource | null }) {
  const nav = useNavigate();
  if (!source) return <span className="chip chip--ghost">Ghi tay</span>;
  const clickable = Boolean(source.route);
  return (
    <button
      className={`chip chip--source ${clickable ? "" : "chip--ghost"}`}
      disabled={!clickable}
      onClick={(e) => { e.stopPropagation(); if (source.route) nav(source.route); }}
    >
      {source.label}
    </button>
  );
}

const DATE_FMT = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return DATE_FMT.format(new Date(iso)); } catch { return "—"; }
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return `${DATE_FMT.format(new Date(iso))} ${TIME_FMT.format(new Date(iso))}`; } catch { return "—"; }
}
/** ISO → 'YYYY-MM-DD' in VN tz, for date <input>. */
export function isoToLocalDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch { return ""; }
}
/** 'YYYY-MM-DD' (local date) → ISO instant at VN midday (stable, no TZ drift). */
export function localDateToIso(d: string): string {
  return d ? `${d}T12:00:00+07:00` : "";
}
