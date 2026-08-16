// Functional 15 — the PURE compliance core (spec §4, §7.2). No DB, no clock: this
// module is unit-tested in isolation (test/f15-taxbooks.test.js). It answers, for
// a verified domain event, "which accounting book line(s) does it become?", and
// it owns the deterministic tax-data math (1-tỷ threshold split, GTGT/TNCN
// estimate) and the canonical CSV/content-hash serialisers.
//
// The compliance catalog (book set + rule table) lives HERE in code because the
// deployed schema has NO per-definition catalog table — only a versioned
// `compliance_catalog_versions` row carrying legal_basis + effective range (seeded
// by server/f15/catalog.js). RULE_VERSION + CATALOG_CODE are stamped onto every
// record and snapshot so a locked period can always be explained at its version.
import { createHash } from "node:crypto";

/** Accounting mapping rule version (spec §7.2 rule_version, stamped per record). */
export const RULE_VERSION = "VN-2026.1";
/** Published compliance-catalog code (S-HKD retail; see server/f15/catalog.js). */
export const CATALOG_CODE = "VN-HKD-2026.1";
/** Catalog scope — hộ kinh doanh bán lẻ (the only pilot profile). */
export const SCOPE_CODE = "hkd-retail";
/** Package/export serializer version — part of the deterministic export key. */
export const FORMAT_VERSION = "1";

/** Revenue exemption threshold: 1 tỷ đồng cumulative per year (NĐ 141/2026). */
export const EXEMPT_THRESHOLD_VND = 1_000_000_000;
/** Estimated tax rates on the taxable (over-threshold) retail revenue. */
export const GTGT_RATE = 0.01;   // GTGT (VAT) 1% — retail goods
export const TNCN_RATE = 0.005;  // TNCN (PIT) 0.5% — retail goods

/**
 * The S-HKD retail book set (mẫu sổ cho hộ kinh doanh, TT 152/2025). Each book is
 * a display view over immutable `accounting_records` keyed by `book_code`. `sign`
 * documents the natural direction; individual records carry a signed amount so a
 * book total is a plain SUM (e.g. sổ doanh thu nets refunds → matches F02/F13).
 */
export const BOOKS = {
  sales_revenue: {
    code: "sales_revenue", recordType: "revenue", order: 1,
    name: "Sổ chi tiết doanh thu bán hàng hóa, dịch vụ",
    short: "Sổ doanh thu", legalRef: "TT 152/2025 — Mẫu S1-HKD",
  },
  cash_book: {
    code: "cash_book", recordType: "cash", order: 2,
    name: "Sổ quỹ tiền mặt",
    short: "Sổ quỹ tiền mặt", legalRef: "TT 152/2025 — Mẫu S-HKD (quỹ)",
  },
  bank_book: {
    code: "bank_book", recordType: "bank", order: 3,
    name: "Sổ tiền gửi ngân hàng (chuyển khoản/QR)",
    short: "Sổ ngân hàng", legalRef: "TT 152/2025 — Mẫu S-HKD (ngân hàng)",
  },
  expenses: {
    code: "expenses", recordType: "expense", order: 4,
    name: "Sổ chi phí sản xuất, kinh doanh",
    short: "Sổ chi phí", legalRef: "TT 152/2025 — Mẫu S-HKD (chi phí)",
  },
  materials_goods: {
    code: "materials_goods", recordType: "purchase", order: 5,
    name: "Sổ chi tiết vật liệu, dụng cụ, sản phẩm, hàng hóa",
    short: "Sổ vật liệu – hàng hóa", legalRef: "TT 152/2025 — Mẫu S-HKD (hàng hóa)",
  },
};

export const BOOK_CODES = Object.values(BOOKS)
  .sort((a, b) => a.order - b.order)
  .map((b) => b.code);

/** Normalise a source payment method → cash | bank | unknown (books split). */
export function channelOf(method) {
  switch (String(method || "").toLowerCase()) {
    case "cash": return "cash";
    case "qr":
    case "transfer":
    case "bank_transfer": return "bank";
    default: return "unknown";
  }
}

/**
 * Deterministic source → accounting record mapping (spec §4.2 source_confirmed
 * level). Returns the ordered list of book lines a single verified event becomes.
 * NEVER guesses: an event whose channel is required-but-unknown (expenses /
 * purchases carry no payment method) is NOT booked into quỹ/ngân hàng — it lands
 * only in its economic book and the cash/bank coverage notes the gap.
 *
 * @param {object} ev normalized event
 *   { sourceType, sourceEventType, businessDate 'YYYY-MM-DD', amountVnd>0, method }
 * @returns {Array<{bookCode, recordType, businessDate, amountVnd, dimensions}>}
 */
export function mapSourceToRecords(ev) {
  const amount = Math.trunc(Number(ev.amountVnd) || 0);
  const date = ev.businessDate;
  if (!date || !(amount > 0)) return [];
  const key = `${ev.sourceType}:${ev.sourceEventType}`;
  const channel = channelOf(ev.method);

  switch (key) {
    case "payment:payment.succeeded": {
      const out = [rec("sales_revenue", "revenue", date, amount, { flow: "sale", channel })];
      if (channel === "cash") out.push(rec("cash_book", "cash", date, amount, { flow: "receipt", channel }));
      else if (channel === "bank") out.push(rec("bank_book", "bank", date, amount, { flow: "receipt", channel }));
      return out;
    }
    case "refund:refund.succeeded": {
      // Refund is a giảm trừ doanh thu → negative revenue line + negative cash/bank.
      const out = [rec("sales_revenue", "revenue", date, -amount, { flow: "sales_return", channel })];
      if (channel === "cash") out.push(rec("cash_book", "cash", date, -amount, { flow: "payment", channel }));
      else if (channel === "bank") out.push(rec("bank_book", "bank", date, -amount, { flow: "payment", channel }));
      return out;
    }
    case "expense:expense_posted":
      // Chi phí — method unknown from the accounting_event, so no quỹ/ngân hàng split (§4.2).
      return [rec("expenses", "expense", date, -amount, { flow: "expense", channel: "unknown" })];
    case "purchase_receipt:purchase_received":
      // Mua hàng nhập kho — increases hàng hóa book at cost.
      return [rec("materials_goods", "purchase", date, amount, { flow: "purchase", channel: "unknown" })];
    default:
      return [];
  }
}

function rec(bookCode, recordType, businessDate, amountVnd, dimensions) {
  return { bookCode, recordType, businessDate, amountVnd, dimensions };
}

/**
 * 1-tỷ threshold split (NĐ 141/2026), cumulative-per-year. Given the revenue
 * booked in prior periods of the same year and this period's revenue, returns how
 * much of THIS period's revenue is exempt vs taxable (over threshold) and the
 * GTGT/TNCN estimate on the taxable part. Pure + hand-verifiable (§ spec ví dụ).
 *
 * taxableThisPeriod = max(0, newCum-T) - max(0, priorCum-T)
 * so the period that crosses the threshold is split exactly.
 */
export function computeThresholdSplit(priorCumulativeVnd, periodRevenueVnd) {
  const prior = Math.max(0, Math.trunc(Number(priorCumulativeVnd) || 0));
  const period = Math.max(0, Math.trunc(Number(periodRevenueVnd) || 0));
  const newCum = prior + period;
  const T = EXEMPT_THRESHOLD_VND;
  const taxable = Math.max(0, newCum - T) - Math.max(0, prior - T);
  const exempt = period - taxable;
  const gtgt = Math.round(taxable * GTGT_RATE);
  const tncn = Math.round(taxable * TNCN_RATE);
  return {
    priorCumulativeVnd: prior,
    periodRevenueVnd: period,
    newCumulativeVnd: newCum,
    thresholdVnd: T,
    exemptPortionVnd: exempt,
    taxablePortionVnd: taxable,
    overThreshold: newCum > T,
    gtgtEstimateVnd: gtgt,
    tncnEstimateVnd: tncn,
    totalEstimateVnd: gtgt + tncn,
  };
}

/** Canonical SHA-256 of an arbitrary value (stable key order) — content hashing. */
export function contentHash(value) {
  return "sha256:" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Deterministic JSON with sorted object keys (arrays keep order). */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/**
 * Deterministic CSV (spec Phụ lục A6): UTF-8 with a BOM so Excel opens it
 * correctly, CRLF rows, VND as bare integers (no locale separators/ambiguity),
 * dates as ISO. Same rows in → byte-identical out (100% same hash, ATD-11).
 */
export function toCsv(rows) {
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  return "﻿" + body + "\r\n";
}
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** SHA-256 of a UTF-8 string's bytes (export byte-hash, A6 Integrity). */
export function byteHash(str) {
  return "sha256:" + createHash("sha256").update(Buffer.from(str, "utf8")).digest("hex");
}

export const bookName = (code) => BOOKS[code]?.name || code;
export const bookShort = (code) => BOOKS[code]?.short || code;
