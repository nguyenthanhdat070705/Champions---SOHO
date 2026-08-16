// Functional 15 — shared client bits: period choices for the selector.
export interface PeriodChoice { key: string; label: string; }

/** The last three months + the current quarter (Asia/Ho_Chi_Minh, browser clock). */
export function periodChoices(now = new Date()): PeriodChoice[] {
  const out: PeriodChoice[] = [];
  const y = now.getFullYear();
  const m0 = now.getMonth(); // 0-based
  for (let i = 0; i < 3; i++) {
    const d = new Date(y, m0 - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: `Th ${d.getMonth() + 1}/${d.getFullYear()}` });
  }
  const q = Math.floor(m0 / 3) + 1;
  out.push({ key: `${y}-Q${q}`, label: `Quý ${q}/${y}` });
  return out;
}
