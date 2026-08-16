// Functional 09 — pure client helpers + types for "Hóa đơn điện tử". Mirrors the
// server (server/f9/*) for display + optimistic checks; the SERVER is always the
// authority on totals, tax and state (spec 4.1). Status labels are HONEST: an invoice
// that is only submitting shows "Đang xử lý", never "Đã phát hành" (spec 3.1 rule).
import { formatVnd } from "./format";

export type InvoiceStatus =
  | "draft" | "validation_failed" | "validated" | "submitting"
  | "accepted" | "rejected" | "adjusted" | "replaced" | "cancelled";

export interface InvoiceListItem {
  id: string; status: InvoiceStatus; invoiceKind: string; totalVnd: number;
  buyerName: string | null; providerInvoiceRef: string | null; orderNumber: string | null; createdAt: string;
}
export interface EligibleOrder {
  id: string; orderNumber: string; totalAmount: number; paidAt: string | null; createdAt: string; itemCount: number;
}
export interface InvoiceSeller { legalName: string | null; displayName?: string | null; taxCode: string | null; address: string | null; }
export interface InvoiceBuyer {
  kind: "individual" | "organization"; name: string | null; taxCode: string | null; address: string | null; email: string | null;
}
export interface InvoiceItem {
  id: string; orderItemId: string; description: string; unit: string; quantity: number;
  unitPriceVnd: number; taxCode: string; taxRate: number; taxLabel: string; lineTotalVnd: number; taxVnd: number;
}
export interface InvoiceSubmission {
  id: string; attemptNo: number; clientRequestId: string; status: string;
  providerCode: string | null; providerMessage: string | null; submittedAt: string | null; createdAt: string;
}
export interface InvoiceEvent {
  providerCode: string; providerEventId: string; eventType: string; occurredAt: string;
  signatureValid: boolean; processedAt: string | null;
}
export interface InvoiceRelation {
  id: string; originalInvoiceId: string; relatedInvoiceId: string | null;
  relationType: string; reason: string; createdAt: string; direction: "outgoing" | "incoming";
}
export interface Invoice {
  id: string; merchantId: string; orderId: string; invoiceKind: string; status: InvoiceStatus;
  sellerSnapshot: InvoiceSeller; buyerSnapshot: InvoiceBuyer;
  subtotalVnd: number; taxVnd: number; totalVnd: number; ruleSetVersion: string;
  payloadHash: string | null; providerInvoiceRef: string | null; rowVersion: number; createdAt: string;
  items: InvoiceItem[]; submissions: InvoiceSubmission[]; events: InvoiceEvent[]; relations: InvoiceRelation[];
}
export interface ValidationError { field: string; code: string; message: string; }
export interface ValidateResult { ok: boolean; errors: ValidationError[]; invoice: Invoice; validationToken?: string; expectedVersion?: number; }

/** Honest status metadata: label + a pill color class (no "Đã gửi" for accepted). */
export const STATUS_META: Record<InvoiceStatus, { label: string; tone: "grey" | "teal" | "blue" | "green" | "amber" | "red" }> = {
  draft: { label: "Nháp", tone: "grey" },
  validation_failed: { label: "Cần sửa", tone: "amber" },
  validated: { label: "Sẵn sàng phát hành", tone: "teal" },
  submitting: { label: "Đang xử lý", tone: "blue" },
  accepted: { label: "Đã phát hành", tone: "green" },
  rejected: { label: "Bị từ chối", tone: "red" },
  adjusted: { label: "Đã điều chỉnh", tone: "grey" },
  replaced: { label: "Đã thay thế", tone: "grey" },
  cancelled: { label: "Đã hủy", tone: "grey" },
};

export const STATUS_TONE_STYLE: Record<string, { background: string; color: string }> = {
  grey: { background: "#eef1f4", color: "#5b6570" },
  teal: { background: "var(--teal-050)", color: "var(--teal-700)" },
  blue: { background: "#e6efff", color: "#2f6bd4" },
  green: { background: "#e3f6ec", color: "#1f9d6b" },
  amber: { background: "var(--amber-050)", color: "var(--amber)" },
  red: { background: "var(--danger-050)", color: "var(--danger)" },
};

/** Filter chips for the list (spec 3.1). "processing" maps to submitting server-side. */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Tất cả" },
  { value: "draft", label: "Nháp" },
  { value: "processing", label: "Đang xử lý" },
  { value: "accepted", label: "Đã phát hành" },
  { value: "rejected", label: "Bị từ chối" },
];

export const RELATION_LABEL: Record<string, string> = {
  retry: "Gửi lại", adjustment: "Điều chỉnh", replacement: "Thay thế", cancellation: "Hủy",
};

/** VN tax id (MST): 10 digits or 10+'-'+3 (branch). Mirrors server validation.js. */
export function isValidTaxId(raw: string): boolean {
  return /^\d{10}(-\d{3})?$/.test((raw || "").replace(/\s+/g, ""));
}

export function normalizeTaxId(raw: string): string {
  return (raw || "").replace(/\s+/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test((raw || "").trim());
}

/** Client-side buyer completeness (the server re-validates; this drives the CTA hint). */
export function buyerBlockingReason(buyer: InvoiceBuyer): string | null {
  if (buyer.kind === "organization") {
    if (!buyer.name || !buyer.name.trim()) return "Nhập tên tổ chức mua hàng.";
    if (!buyer.taxCode || !isValidTaxId(buyer.taxCode)) return "Nhập mã số thuế người mua hợp lệ.";
  } else if (buyer.taxCode && buyer.taxCode.trim() && !isValidTaxId(buyer.taxCode)) {
    return "Mã số thuế chưa hợp lệ.";
  }
  if (buyer.email && buyer.email.trim() && !isValidEmail(buyer.email)) return "Email nhận hóa đơn chưa hợp lệ.";
  return null;
}

/** Seller readiness for the UI checklist (spec 3.3). */
export function sellerReady(seller: InvoiceSeller | null | undefined): boolean {
  return Boolean(seller && seller.legalName && seller.taxCode && isValidTaxId(seller.taxCode));
}

export { formatVnd };
