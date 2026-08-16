// Functional 08 — pure constants + validators for the document box (spec 4.2 / 12.4).
// No DB or network here so it is trivially unit-testable (test/f8-documents.test.js).
// The deployed `documents` storage bucket only allows image/jpeg|png|webp and caps
// files at 10 MB (introspected, not re-derivable — see AGENTS.md F8 notes). PDF is
// therefore NOT accepted for standalone upload on this deployment.
import { fail } from "../f3/errors.js";

/** Storage bucket limits (must match the deployed `documents` bucket exactly). */
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];
const EXT_BY_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Confirmed document classes (spec 12.4 — four classes + Khác). */
export const DOCUMENT_TYPES = ["purchase_invoice", "goods_receipt", "expense", "sales_invoice", "other"];
export const DOCUMENT_TYPE_LABELS = {
  purchase_invoice: "Hóa đơn mua vào",
  goods_receipt: "Phiếu nhập hàng",
  expense: "Chứng từ chi",
  sales_invoice: "Hóa đơn bán ra",
  other: "Khác",
};

/** Link semantics (spec 4.3 / 8.4). */
export const LINK_TYPES = ["primary", "supporting", "other"];

/** Document lifecycle states (spec 2.1). Free-text column; enforced here. */
export const DOC_STATUSES = ["uploading", "processing", "review", "ready", "quarantined", "archived", "purged"];
/** States a normal member may open / get a signed URL for (spec 2.2 / DOC-10). */
export const VIEWABLE_STATUSES = ["review", "ready", "archived"];

/**
 * Business-record types a document can link to, mapped to the table used to
 * verify the target exists + the client deep-link route + the human number
 * column (spec 3.7 / 4.3). Only `order` deep-links to a page that exists today;
 * expense/purchase_receipt routes belong to sibling lanes (F6/F7) and resolve
 * once those land — non-breaking until then.
 */
export const TARGET_TYPES = {
  order: { table: "orders", route: (id) => `/don-hang/${id}`, numberCol: "order_number", label: "Bill" },
  expense: { table: "expenses", route: (id) => `/chi-phi/${id}`, numberCol: "expense_number", label: "Chi phí" },
  purchase_receipt: { table: "purchase_receipts", route: (id) => `/nhap-hang/${id}`, numberCol: "receipt_number", label: "Phiếu nhập" },
};

export function extForMime(mime) {
  return EXT_BY_MIME[mime] || "bin";
}

/** Validate + normalize the requested MIME, or fail with the spec DOC_001 code. */
export function requireAllowedMime(mime) {
  const m = String(mime || "").toLowerCase().trim();
  if (!ALLOWED_MIME.includes(m)) {
    fail("DOCUMENT_MIME_UNSUPPORTED");
  }
  return m;
}

/** Validate byte size (>0, ≤ bucket cap), or fail (DOC_002). */
export function requireAllowedSize(byteSize) {
  const n = Number(byteSize);
  if (!Number.isFinite(n) || n <= 0) fail("VALIDATION", "Tệp rỗng hoặc không hợp lệ.");
  if (n > MAX_BYTES) fail("DOCUMENT_TOO_LARGE");
  return n;
}

/** Coerce an incoming document_type to the allowlist; unknown/blank → 'other' (a hint, spec 3.2). */
export function normalizeDocumentType(t) {
  const v = String(t || "").toLowerCase().trim();
  return DOCUMENT_TYPES.includes(v) ? v : null;
}

/** Validate a link_type against the allowlist (spec 8.4). */
export function requireLinkType(t) {
  const v = String(t || "").toLowerCase().trim();
  if (!LINK_TYPES.includes(v)) fail("VALIDATION", "Loại liên kết không hợp lệ.");
  return v;
}

/** Validate a target_type against the allowlist. */
export function requireTargetType(t) {
  const v = String(t || "").toLowerCase().trim();
  if (!TARGET_TYPES[v]) fail("VALIDATION", "Loại nghiệp vụ không hỗ trợ.");
  return v;
}

/** Deep-link route for a resolved (targetType, targetId), or null if unknown. */
export function targetRoute(targetType, targetId) {
  const t = TARGET_TYPES[targetType];
  return t ? t.route(targetId) : null;
}
