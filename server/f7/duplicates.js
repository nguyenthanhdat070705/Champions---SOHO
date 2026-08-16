// Functional 07 — duplicate signal detection (spec 4.2 / EXP-FR-07 / EXP-07).
// Signals only create CANDIDATES; policy decides block/override and the human
// confirms (spec 4.2: "AI/hash không tự merge"). A candidate fires on: same
// merchant + same grand_total + expense_date within ±1 day + a similar payee (or
// the same source document content hash). Pure + unit-tested.

/** Fold Vietnamese diacritics + case + spacing so "Điện Lực" ~ "dien luc". */
export function normalizePayee(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-day difference between two 'YYYY-MM-DD' strings (abs). */
export function dayDiff(a, b) {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Infinity;
  return Math.abs(Math.round((da - db) / 86_400_000));
}

/**
 * Payee similarity in [0,1]: token Jaccard on normalised words. Empty payees are
 * treated as "unknown" → 0 similarity (so amount+date alone never auto-flag; the
 * payee has to actually corroborate, unless the document hash matches).
 */
export function payeeSimilarity(a, b) {
  const na = normalizePayee(a);
  const nb = normalizePayee(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : round4(inter / union);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export const DAY_WINDOW = 1;
export const PAYEE_THRESHOLD = 0.5;

/**
 * Decide whether `candidate` is a duplicate signal for `target`.
 * Both are { grandTotalVnd, expenseDate, payee, contentHash? }.
 * @returns {null | { candidateExpenseId, signals }}
 */
export function matchSignal(target, candidate) {
  if (candidate.id === target.id) return null;
  const sameAmount = Number(candidate.grandTotalVnd) === Number(target.grandTotalVnd);
  const dd = dayDiff(target.expenseDate, candidate.expenseDate);
  const withinWindow = dd <= DAY_WINDOW;
  const sim = payeeSimilarity(target.payee, candidate.payee);
  const sameDoc = Boolean(
    target.contentHash && candidate.contentHash && target.contentHash === candidate.contentHash,
  );

  // A shared source document is a strong standalone signal.
  if (sameDoc) {
    return { candidateExpenseId: candidate.id, signals: { sameDocument: true, contentHash: target.contentHash, amountMatch: sameAmount, dayDiff: dd } };
  }
  if (sameAmount && withinWindow && sim >= PAYEE_THRESHOLD) {
    return {
      candidateExpenseId: candidate.id,
      signals: { amountMatch: true, dayDiff: dd, payeeSimilarity: sim, grandTotalVnd: Number(target.grandTotalVnd) },
    };
  }
  return null;
}

/** Run matchSignal over a candidate set; return the fired signals. */
export function findDuplicates(target, candidates) {
  const out = [];
  for (const c of candidates || []) {
    const m = matchSignal(target, c);
    if (m) out.push(m);
  }
  return out;
}
