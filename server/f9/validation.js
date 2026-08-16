// Functional 09 — pure validation of seller/buyer/lines (spec 3.3, 3.4, 3.5, 6
// INV-FR-02..05). The server validator is the ONLY authority (spec 4.1, 11.2): AI
// or client input is never accepted as-is. Returns readable Vietnamese errors keyed
// by field so the UI can point the user at exactly what to fix.
import { isValidTaxCode } from "./mapping.js";

/**
 * Vietnamese tax id (MST): 10 digits, or a 13-digit branch form 10 digits + '-' +
 * 3 digits. Spaces are tolerated on input; validate the compact form.
 */
export function isValidTaxId(raw) {
  if (typeof raw !== "string") return false;
  const s = raw.replace(/\s+/g, "");
  return /^\d{10}(-\d{3})?$/.test(s);
}

/** Normalize a tax id to its compact canonical form (or "" if empty). */
export function normalizeTaxId(raw) {
  return typeof raw === "string" ? raw.replace(/\s+/g, "") : "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Seller readiness (spec 3.3). The invoice cannot be issued without a legal name
 * and a valid seller tax id (MST). Missing MST → block + point to Cài đặt.
 * @returns {Array<{field,code,message}>}
 */
export function validateSeller(seller = {}) {
  const errors = [];
  if (!seller.legalName || !String(seller.legalName).trim()) {
    errors.push({ field: "seller.legalName", code: "SELLER_NAME_MISSING", message: "Thiếu tên người bán trên hồ sơ phát hành." });
  }
  if (!seller.taxCode || !isValidTaxId(seller.taxCode)) {
    errors.push({ field: "seller.taxCode", code: "SELLER_TAX_ID_MISSING", message: "Hồ sơ phát hành thiếu mã số thuế hợp lệ. Hãy hoàn tất trong Cài đặt." });
  }
  return errors;
}

/**
 * Buyer rules per kind (spec 3.4). Organization must give a name + valid MST;
 * individual may leave both blank (khách lẻ). Email, if given, must be valid — it
 * is only a delivery channel and never decides acceptance (spec 3.4 rule).
 * @returns {Array<{field,code,message}>}
 */
export function validateBuyer(buyer = {}) {
  const errors = [];
  const kind = buyer.kind === "organization" ? "organization" : "individual";
  if (kind === "organization") {
    if (!buyer.name || !String(buyer.name).trim()) {
      errors.push({ field: "buyer.name", code: "BUYER_NAME_REQUIRED", message: "Nhập tên tổ chức mua hàng." });
    }
    if (!buyer.taxCode || !isValidTaxId(buyer.taxCode)) {
      errors.push({ field: "buyer.taxCode", code: "BUYER_TAX_ID_INVALID", message: "Mã số thuế người mua chưa hợp lệ (10 hoặc 13 số)." });
    }
  } else if (buyer.taxCode && String(buyer.taxCode).trim() && !isValidTaxId(buyer.taxCode)) {
    // Individual supplied an MST anyway — if present it must be well-formed.
    errors.push({ field: "buyer.taxCode", code: "BUYER_TAX_ID_INVALID", message: "Mã số thuế người mua chưa hợp lệ (10 hoặc 13 số)." });
  }
  if (buyer.email && String(buyer.email).trim() && !EMAIL_RE.test(String(buyer.email).trim())) {
    errors.push({ field: "buyer.email", code: "BUYER_EMAIL_INVALID", message: "Email nhận hóa đơn chưa hợp lệ." });
  }
  return errors;
}

/** Every line must resolve to an allowlisted tax code and have valid amounts (INV-05). */
export function validateLines(lines = []) {
  const errors = [];
  if (!lines.length) {
    errors.push({ field: "lines", code: "NO_LINES", message: "Hóa đơn chưa có dòng hàng." });
    return errors;
  }
  lines.forEach((l, i) => {
    if (!isValidTaxCode(l.taxCode)) {
      errors.push({ field: `lines[${i}].taxCode`, code: "TAX_MAPPING_MISSING", message: `Dòng “${l.description || i + 1}” chưa có mã thuế hợp lệ.` });
    }
    if (!(Number(l.quantity) > 0)) {
      errors.push({ field: `lines[${i}].quantity`, code: "LINE_QTY_INVALID", message: `Số lượng dòng “${l.description || i + 1}” không hợp lệ.` });
    }
    if (Number(l.lineTotalVnd) < 0) {
      errors.push({ field: `lines[${i}].lineTotalVnd`, code: "LINE_AMOUNT_INVALID", message: `Thành tiền dòng “${l.description || i + 1}” không hợp lệ.` });
    }
  });
  return errors;
}

/** Spec 12.4 launching cap: at most 100 lines per invoice in the pilot. */
export const MAX_LINES = 100;

/**
 * Aggregate validator (spec 3.5 "Kiểm tra"). Combines seller/buyer/line rules plus
 * the line-count cap. `ok` is true only when there are zero errors.
 * @returns {{ ok: boolean, errors: Array<{field,code,message}> }}
 */
export function validateInvoice({ seller, buyer, lines }) {
  const errors = [
    ...validateSeller(seller),
    ...validateBuyer(buyer),
    ...validateLines(lines),
  ];
  if ((lines || []).length > MAX_LINES) {
    errors.push({ field: "lines", code: "TOO_MANY_LINES", message: `Bản thử nghiệm giới hạn ${MAX_LINES} dòng/hóa đơn.` });
  }
  return { ok: errors.length === 0, errors };
}
