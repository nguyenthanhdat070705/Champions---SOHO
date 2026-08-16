// Functional 08 — pure client helpers for the document box. Mirrors the server
// allowlists (server/f8/types.js) so the UI can validate before uploading and
// render Vietnamese labels/badges. No React, no network → unit-tested.
import type { DocType, DocStatus } from "./api";

/** Storage-bucket limits (must match the deployed `documents` bucket). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ACCEPT_MIME = ["image/jpeg", "image/png", "image/webp"];
/** <input accept> value — image only (the deployed bucket blocks PDF). */
export const ACCEPT_ATTR = ACCEPT_MIME.join(",");

export const DOC_TYPE_OPTIONS: { value: DocType; label: string }[] = [
  { value: "purchase_invoice", label: "Hóa đơn mua vào" },
  { value: "goods_receipt", label: "Phiếu nhập hàng" },
  { value: "expense", label: "Chứng từ chi" },
  { value: "sales_invoice", label: "Hóa đơn bán ra" },
  { value: "other", label: "Khác" },
];

const DOC_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  DOC_TYPE_OPTIONS.map((o) => [o.value, o.label]),
);

export function docTypeLabel(t: DocType | null | undefined): string {
  return t ? (DOC_TYPE_LABELS[t] || "Khác") : "Chưa phân loại";
}

/** Short chip color hint per document type (drives the badge CSS modifier). */
export function docTypeTone(t: DocType | null | undefined): string {
  switch (t) {
    case "purchase_invoice": return "teal";
    case "goods_receipt": return "violet";
    case "expense": return "amber";
    case "sales_invoice": return "blue";
    default: return "grey";
  }
}

export const DOC_STATUS_LABELS: Record<DocStatus, string> = {
  uploading: "Đang tải", processing: "Đang xử lý", review: "Cần xem",
  ready: "Sẵn sàng", quarantined: "Bị cách ly", archived: "Đã lưu trữ", purged: "Đã xóa",
};

export function docStatusLabel(s: DocStatus): string {
  return DOC_STATUS_LABELS[s] || s;
}

/** Human file size (KB/MB) for the metadata card. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** DD/MM/YYYY HH:mm in Asia/Ho_Chi_Minh (matches the rest of the app). */
export function formatDocDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" });
  if (!withTime) return date;
  const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });
  return `${date} ${time}`;
}

export interface MimeCheck { ok: boolean; reason?: string; }

/** Validate a picked file before we bother reading/uploading it. */
export function checkFile(mimeType: string, byteSize: number): MimeCheck {
  if (!ACCEPT_MIME.includes(String(mimeType).toLowerCase())) {
    return { ok: false, reason: "Chỉ dùng ảnh JPG, PNG hoặc WEBP." };
  }
  if (byteSize <= 0) return { ok: false, reason: "Tệp rỗng." };
  if (byteSize > MAX_UPLOAD_BYTES) return { ok: false, reason: "Tệp quá lớn (tối đa 10 MB)." };
  return { ok: true };
}

export const LINK_TYPE_OPTIONS = [
  { value: "primary", label: "Chứng từ chính" },
  { value: "supporting", label: "Bổ trợ" },
  { value: "other", label: "Khác" },
];

export const TARGET_TYPE_OPTIONS = [
  { value: "order", label: "Bill bán hàng" },
  { value: "expense", label: "Khoản chi" },
  { value: "purchase_receipt", label: "Phiếu nhập" },
];

export function linkTypeLabel(t: string): string {
  return LINK_TYPE_OPTIONS.find((o) => o.value === t)?.label || t;
}

/** Read a File into a base64 string (no data: prefix) for the JSON upload body. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || "");
      resolve(res.replace(/^data:[^;]+;base64,/, ""));
    };
    reader.onerror = () => reject(new Error("Không đọc được tệp."));
    reader.readAsDataURL(file);
  });
}
