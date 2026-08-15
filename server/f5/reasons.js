// Functional 05 — the fixed adjustment/count reason list (spec 3.3 / 4.2). Kept
// pure + tiny so it is unit-tested and shared by manual adjustments and count
// variances. 'OTHER' forces a free-text note (spec 3.3 "Bắt buộc với Khác").
import { fail } from "../f3/errors.js";

export const REASON_CODES = ["DAMAGED", "LOST", "FOUND", "CORRECTION", "OTHER"];

export const REASON_LABEL = {
  DAMAGED: "Hư hỏng",
  LOST: "Thất thoát / Mất",
  FOUND: "Tìm thấy thêm",
  CORRECTION: "Đếm sai kỳ trước",
  OTHER: "Khác",
};

export function normalizeReason(input) {
  if (input == null) return null;
  const r = String(input).trim().toUpperCase();
  return r || null;
}

/**
 * Validate a reason/note pair. When `required`, a reason must be chosen; a chosen
 * reason must be in the fixed list; 'OTHER' additionally needs a note. Returns the
 * normalised { reasonCode, note }.
 */
export function validateReason(reasonInput, noteInput, { required = true } = {}) {
  const reasonCode = normalizeReason(reasonInput);
  const note = noteInput == null ? null : String(noteInput).trim().slice(0, 500) || null;
  if (!reasonCode) {
    if (required) fail("REASON_REQUIRED");
    return { reasonCode: null, note };
  }
  if (!REASON_CODES.includes(reasonCode)) fail("VALIDATION", "Lý do điều chỉnh không hợp lệ.");
  if (reasonCode === "OTHER" && !note) fail("VALIDATION", "Vui lòng ghi chú lý do khi chọn Khác.");
  return { reasonCode, note };
}
