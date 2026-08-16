// Functional 11 — the DETERMINISTIC source→cashbook mapping (spec §4.1/§4.2/§4.3).
// This module is PURE (no DB, no time source injected by caller) so it is unit
// tested in isolation (test/f11-cashbook.test.js). It answers one question for a
// verified domain event: "does this become a posted cashbook entry, a review
// item, or nothing?" — and, when posted/queued, with what direction/type/method.
//
// Design for F07/F09: a NEW source is ONE entry in MAPPINGS. Today only payment
// success, refund success and the purchase/expense accounting_events exist; the
// mapping for expense/purchase is built now and simply won't fire until those
// events are created (spec §12.4 "auto v1 = bill paid + expense posted").
import { createHash } from "node:crypto";

/** Mapping taxonomy version, stamped onto every entry (spec §7.2 rule_version). */
export const RULE_VERSION = "VN-2026.1";

/**
 * Entry-type taxonomy (spec §4.1 / §12.4 "taxonomy ngắn"). entry_type is free
 * text in the DB; this is the authoritative allowlist + the fixed direction each
 * type implies. `adjustment` is the only in-or-out type (reversal contra line).
 */
export const ENTRY_TYPES = {
  sales_receipt: { direction: "in", label: "Thu bán hàng" },
  other_receipt: { direction: "in", label: "Thu khác" },
  sales_refund: { direction: "out", label: "Hoàn tiền bán hàng" },
  operating_expense: { direction: "out", label: "Chi vận hành" },
  inventory_purchase: { direction: "out", label: "Mua hàng nhập kho" },
  adjustment: { direction: null, label: "Điều chỉnh" },
};

/** Reason codes for the "Cần xem" queue (spec §3.3 tabs + §4.2). */
export const REASON_CODES = {
  missing_date: "Thiếu ngày nghiệp vụ",
  missing_type: "Chưa rõ loại khoản",
  missing_payment_method: "Thiếu phương thức thanh toán",
  needs_payment_confirmation: "Cần xác nhận đã chi tiền",
  abnormal_amount: "Số tiền bất thường",
  source_mismatch: "Số tiền chưa khớp nguồn",
};

/** Exclusion reasons when a merchant chooses NOT to book a review item. */
export const EXCLUDE_REASONS = {
  not_cash_movement: "Không phải khoản tiền vào/ra",
  duplicate: "Trùng với khoản đã ghi",
  wrong_source: "Nguồn không hợp lệ",
  other: "Lý do khác",
};

/** Reasons attached to a reversal / điều chỉnh (spec §3.7 reason_code). */
export const REVERSAL_REASONS = {
  wrong_amount: "Sai số tiền",
  wrong_classification: "Sai phân loại",
  duplicate: "Ghi trùng",
  source_reversed: "Nguồn đã bị hủy/đảo",
  other: "Lý do khác",
};

/**
 * The source event registry. Keyed by `${source_type}:${source_event_type}`.
 * `methodFrom:'source'` copies the source's own payment method; a literal
 * `method` pins it. `autoPost:false` sends every occurrence to review with the
 * listed reasonCodes — used for money-out events whose "was it actually paid?"
 * is not certain from the source alone (purchase/expense; spec §1.2, §12.4).
 */
export const MAPPINGS = {
  "payment:payment.succeeded": {
    direction: "in", entryType: "sales_receipt", methodFrom: "source", autoPost: true,
    sourceLabel: "Bill", deepLink: "order",
  },
  "refund:refund.succeeded": {
    direction: "out", entryType: "sales_refund", methodFrom: "source", autoPost: true,
    sourceLabel: "Hoàn tiền", deepLink: "order",
  },
  "purchase_receipt:purchase_received": {
    direction: "out", entryType: "inventory_purchase", method: "unknown", autoPost: false,
    reviewReasons: ["needs_payment_confirmation", "missing_payment_method"],
    sourceLabel: "Phiếu nhập", deepLink: "purchase_receipt",
  },
  "expense:expense_posted": {
    direction: "out", entryType: "operating_expense", method: "unknown", autoPost: false,
    reviewReasons: ["missing_payment_method"],
    sourceLabel: "Chi phí", deepLink: "expense",
  },
};

/** Normalise a source payment method (payments/refunds are cash|qr) → the
 *  cashbook fact vocabulary cash|transfer|other|unknown (spec §4.2). */
export function mapPaymentMethod(sourceMethod) {
  switch (String(sourceMethod || "").toLowerCase()) {
    case "cash": return "cash";
    case "qr":
    case "transfer":
    case "bank_transfer": return "transfer";
    case "other": return "other";
    default: return "unknown";
  }
}

export function lookupMapping(sourceType, sourceEventType) {
  return MAPPINGS[`${sourceType}:${sourceEventType}`] || null;
}

/**
 * Classify a verified source event into a cashbook decision. Never guesses:
 * missing/insufficient data downgrades an auto-post to review, and an unknown
 * event type is skipped (not this feature's concern).
 *
 * @param {object} ev
 * @param {string} ev.sourceType          e.g. 'payment'
 * @param {string} ev.sourceEventType     e.g. 'payment.succeeded'
 * @param {number|null} ev.amountVnd      absolute amount (bigint-safe number)
 * @param {string|null} ev.occurredAt     ISO instant of the business event
 * @param {string|null} ev.paymentMethod  source method (cash|qr|…) when known
 * @returns {{decision:'post'|'review'|'skip', direction?, entryType?, paymentMethod?, amountVnd?, occurredAt?, reasonCodes?, ruleVersion:string}}
 */
export function classifySource(ev) {
  const map = lookupMapping(ev.sourceType, ev.sourceEventType);
  if (!map) return { decision: "skip", ruleVersion: RULE_VERSION };

  const paymentMethod = map.methodFrom === "source"
    ? mapPaymentMethod(ev.paymentMethod)
    : (map.method || "unknown");
  const amountVnd = Number.isFinite(Number(ev.amountVnd)) ? Math.trunc(Number(ev.amountVnd)) : null;
  const occurredAt = ev.occurredAt || null;

  // Completeness gate (spec §4.2). Any failure → review, never a guessed post.
  const reasons = new Set(map.reviewReasons || []);
  if (!(amountVnd > 0)) reasons.add("abnormal_amount");
  if (!occurredAt) reasons.add("missing_date");
  if (paymentMethod === "unknown") reasons.add("missing_payment_method");

  const base = {
    direction: map.direction,
    entryType: map.entryType,
    paymentMethod,
    amountVnd,
    occurredAt,
    ruleVersion: RULE_VERSION,
  };

  if (map.autoPost && reasons.size === 0) {
    return { decision: "post", ...base };
  }
  return { decision: "review", ...base, reasonCodes: [...reasons] };
}

/**
 * Canonical SHA-256 of the source snapshot used to detect a source change
 * between preview and post (spec §5 CBK_004/CBK_005, §12.2). Field order is
 * fixed so the hash is stable across processes.
 */
export function sourceHash(ev) {
  const canonical = JSON.stringify([
    ev.sourceType, ev.sourceId, ev.sourceEventType,
    Number(ev.amountVnd) || 0, ev.occurredAt || null, ev.paymentMethod || null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** True when a review item's draft is complete enough to preview/post. */
export function draftIsReady(draft) {
  return (
    (draft?.direction === "in" || draft?.direction === "out") &&
    typeof draft?.entryType === "string" && Boolean(ENTRY_TYPES[draft.entryType]) &&
    Number(draft?.amountVnd) > 0 &&
    Boolean(draft?.occurredAt) &&
    ["cash", "transfer", "other", "unknown"].includes(draft?.paymentMethod)
  );
}

/** The direction implied by an entry type, or the draft's explicit direction. */
export function directionForEntryType(entryType, fallback) {
  const t = ENTRY_TYPES[entryType];
  return t && t.direction ? t.direction : fallback;
}
