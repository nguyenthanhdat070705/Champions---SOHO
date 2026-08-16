// Functional 14 — "Chốt tiền cuối ngày" PURE logic (spec §4.1 formula, §4.2
// variance, §3.3 count math, §5.1 idempotency hashes). No DB, no ambient clock,
// so it is unit-tested in isolation (test/f14-closing.test.js). The server
// (server/f14/service.js) owns transactions and calls into here for every number
// so the client total is NEVER trusted (CLS-FR-03/04).
import { createHash } from "node:crypto";

/** Policy/rule version stamped onto reasoning; snapshot into the revision. */
export const POLICY_VERSION = "VN-2026.1";

/** VND note denominations offered by the count-by-denomination mode (spec §3.3
 *  "Allowlist VND"). Largest-first for a natural counting order. Coins / tiền lẻ
 *  are out of the pilot cut — use the "nhập tổng" mode for odd amounts. */
export const DENOMINATIONS = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];
const DENOM_SET = new Set(DENOMINATIONS);

/** Count modes (mirrors the cash_counts.mode CHECK). */
export const COUNT_MODES = ["total", "denomination"];

/**
 * Reason catalog for a non-zero variance (spec §3.5 "Reason catalog"; brief:
 * đếm nhầm / chi chưa ghi / thu chưa ghi / khác). `other` requires a note.
 */
export const REASON_CODES = {
  miscount: { label: "Đếm nhầm khi kiểm quỹ", needsNote: false },
  unrecorded_expense: { label: "Có khoản chi chưa ghi nhận", needsNote: false },
  unrecorded_receipt: { label: "Có khoản thu chưa ghi nhận", needsNote: false },
  other: { label: "Lý do khác", needsNote: true },
};

/** Decisions available when resolving a late-source attention item (spec §3.7). */
export const ATTENTION_DECISIONS = {
  reclosed: "Đã chốt lại (tạo bản sửa đổi)",
  dismissed: "Bỏ qua — không thuộc két ngày này",
};

/**
 * Server-authoritative counted total (spec §3.3 rule "Server computed"; the
 * client-summed total is never trusted). Returns { countedTotalVnd, lines } where
 * lines is the normalized denomination_lines jsonb to persist.
 *
 * @param {'total'|'denomination'} mode
 * @param {object} input
 * @param {number} [input.countedTotalVnd]  total-mode: the typed grand total
 * @param {Array<{denominationVnd:number, quantity:number}>} [input.denominations]  denomination-mode
 */
export function computeCount(mode, input = {}) {
  if (!COUNT_MODES.includes(mode)) {
    throw new RangeError("INVALID_COUNT_MODE");
  }
  if (mode === "total") {
    const total = toNonNegInt(input.countedTotalVnd);
    if (total === null) throw new RangeError("INVALID_COUNT_TOTAL");
    return { countedTotalVnd: total, lines: [] };
  }
  // denomination mode
  const raw = Array.isArray(input.denominations) ? input.denominations : [];
  const byDenom = new Map();
  for (const l of raw) {
    const denom = Number(l?.denominationVnd);
    const qty = toNonNegInt(l?.quantity);
    if (!DENOM_SET.has(denom)) throw new RangeError("INVALID_DENOMINATION");
    if (qty === null) throw new RangeError("INVALID_DENOMINATION_QTY");
    if (qty === 0) continue; // skip empty rows
    byDenom.set(denom, (byDenom.get(denom) || 0) + qty);
  }
  const lines = [...byDenom.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([denominationVnd, quantity]) => ({
      denominationVnd,
      quantity,
      lineTotalVnd: denominationVnd * quantity,
    }));
  const countedTotalVnd = lines.reduce((s, l) => s + l.lineTotalVnd, 0);
  return { countedTotalVnd, lines };
}

/**
 * Expected cash from the frozen source snapshots (spec §4.1). MVP scope (brief):
 * expected = Σ(cash-in) − Σ(cash-out); opening float and cash movements are a
 * documented cut. Every row must carry an explicit direction ('in'|'out') — the
 * sign is NEVER inferred from the amount (Phụ lục A3).
 *
 * @param {Array<{direction:'in'|'out', amountVnd:number}>} sources
 * @returns {{ expectedCashVnd:number, inflowVnd:number, outflowVnd:number }}
 */
export function expectedCash(sources = []) {
  let inflow = 0;
  let outflow = 0;
  for (const s of sources) {
    const amt = Math.trunc(Number(s.amountVnd) || 0);
    if (s.direction === "in") inflow += amt;
    else if (s.direction === "out") outflow += amt;
  }
  return { expectedCashVnd: inflow - outflow, inflowVnd: inflow, outflowVnd: outflow };
}

/** Signed variance = counted − expected (spec §3.5 "counted - expected"). */
export function variance(countedVnd, expectedVnd) {
  return Math.trunc(Number(countedVnd) || 0) - Math.trunc(Number(expectedVnd) || 0);
}

/** UI classification of a variance for colour/label (spec §3.5 hero state). */
export function classifyVariance(v) {
  if (v === 0) return "match";
  return v > 0 ? "surplus" : "shortage";
}

/** A non-zero variance requires a reason (spec §3.5 "Bắt buộc khi delta !=0"). */
export function reasonRequired(v) {
  return variance(v, 0) !== 0;
}

/** Validate a reason selection against the catalog; returns an error code or null. */
export function validateReason(v, reasonCode, reasonNote) {
  if (!reasonRequired(v)) return null; // no reason needed when balanced
  const def = REASON_CODES[reasonCode];
  if (!def) return "CLOSING_REASON_REQUIRED";
  if (def.needsNote && !String(reasonNote || "").trim()) return "CLOSING_REASON_NOTE_REQUIRED";
  return null;
}

/**
 * Canonical hash of the source SET frozen for a draft (spec §5.1, §3.2
 * source_set_hash → preview invalidation). Order-independent: sources are sorted
 * by their identity tuple so the same set always hashes the same across processes.
 */
export function sourceSetHash(sources = []) {
  const rows = sources
    .map((s) => [s.sourceType, s.sourceId, s.eventType, s.direction, Math.trunc(Number(s.amountVnd) || 0)])
    .sort((a, b) => (a.join("|") < b.join("|") ? -1 : 1));
  return "sha256:" + createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/**
 * Preview hash bound to (draft, source set, counted, reason) — the confirm call
 * must echo it and the server recomputes from the values it will actually write
 * (spec §3.6 "Preview có TTL/hash", §5.1 "Confirm yêu cầu preview_hash"). Any
 * change to source/count/reason yields a different hash → stale preview → 409.
 */
export function previewHash({ draftId, sourceSetHash: ssh, countedCashVnd, reasonCode, reasonNote }) {
  const canonical = JSON.stringify([
    draftId, ssh, Math.trunc(Number(countedCashVnd) || 0),
    reasonCode || "", String(reasonNote || ""),
  ]);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/** Immutable integrity hash of a confirmed revision's content (spec §8.4). */
export function contentHash({ closingId, revisionNo, sourceSetHash: ssh, expectedCashVnd, countedCashVnd, reasonCode, reasonNote, previousRevisionId }) {
  const canonical = JSON.stringify([
    closingId, revisionNo, ssh,
    Math.trunc(Number(expectedCashVnd) || 0), Math.trunc(Number(countedCashVnd) || 0),
    reasonCode || null, String(reasonNote || ""), previousRevisionId || null,
  ]);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/** Stable fingerprint for a late source (spec §5.1 late-source unique tuple). */
export function sourceFingerprint(sourceType, sourceId, eventType) {
  return `${sourceType}:${sourceId}:${eventType}`;
}

function toNonNegInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}
