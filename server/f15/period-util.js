// Functional 15 — pure period math (spec §3.1 kỳ tháng/quý, §7.2 timezone). All
// bounds are inclusive local dates in Asia/Ho_Chi_Minh; the [tsStart,tsEnd) pair
// gives exact ISO offsets for timestamp filters. Unit-tested via mapping tests.
const TZ = "Asia/Ho_Chi_Minh";

export function localToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
export function lastDayOfMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Resolve a period selector to bounds. Accepts:
 *   'YYYY-MM'          → that month
 *   'YYYY-Qn'          → that quarter (n=1..4)
 *   undefined          → current month (Asia/Ho_Chi_Minh)
 */
export function resolvePeriod(key, now = new Date()) {
  const k = (key || localToday(now).slice(0, 7)).trim();
  const q = k.match(/^(\d{4})-Q([1-4])$/i);
  if (q) {
    const year = Number(q[1]);
    const qn = Number(q[2]);
    const startMonth = (qn - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const start = `${year}-${String(startMonth).padStart(2, "0")}-01`;
    const end = `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDayOfMonth(year, endMonth)).padStart(2, "0")}`;
    return withTs({ kind: "quarter", key: `${year}-Q${qn}`, year, start, end, label: `Quý ${qn}/${year}` });
  }
  const m = k.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const mo = Number(m[2]);
    const start = `${year}-${String(mo).padStart(2, "0")}-01`;
    const end = `${year}-${String(mo).padStart(2, "0")}-${String(lastDayOfMonth(year, mo)).padStart(2, "0")}`;
    return withTs({ kind: "month", key: `${year}-${String(mo).padStart(2, "0")}`, year, start, end, label: `Tháng ${mo}/${year}` });
  }
  // Fallback: current month.
  return resolvePeriod(undefined, now);
}

/** Bounds for the period from year-start to the day before `start` (cumulative). */
export function yearToStart(period) {
  const year = period.year;
  return { start: `${year}-01-01`, end: prevDay(period.start) };
}
function prevDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function withTs(p) {
  return { ...p, timezone: TZ, tsStart: `${p.start}T00:00:00+07:00`, tsEnd: nextDayTs(p.end) };
}
function nextDayTs(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  const s = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${s}T00:00:00+07:00`;
}
