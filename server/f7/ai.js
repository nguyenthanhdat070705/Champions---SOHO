// Functional 07 — receipt-photo AI preview orchestration (spec §11). Persists a
// source_documents record for the capture (content hash → dedup / provenance) and
// asks Gemini for a structured DRAFT. On any AI failure the caller gets
// AI_PREVIEW_FAILED and falls back to the manual form with fields intact (EXP-05 /
// EXP-FR-12). The AI NEVER posts and NEVER concludes tax validity (spec 11.2).
import { DomainError } from "../f3/errors.js";
import { previewExpenseFromImage } from "./gemini.js";
import { ensureReceiptDocument } from "./expenses.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB cap (spec 12.2 size limit)

export async function aiExpensePreview(merchantId, userId, input) {
  const base64 = typeof input?.image === "string" ? input.image.replace(/^data:[^,]+,/, "") : null;
  const mimeType = input?.mimeType || "image/jpeg";
  if (!base64) throw new DomainError("VALIDATION", "Thiếu ảnh.");
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) throw new DomainError("VALIDATION", "Ảnh quá lớn.");

  // Persist the capture first so the draft can be re-attempted manually on the SAME
  // document if the model fails (spec 2.2 / 3.5: keep the file, allow manual entry).
  let doc = null;
  try {
    doc = await ensureReceiptDocument(merchantId, userId, { base64, mimeType });
  } catch {
    doc = null; // document persistence is best-effort; extraction can still run
  }

  const { draft, model } = await previewExpenseFromImage(base64, mimeType);
  return {
    draft,
    documentId: doc?.documentId ?? null,
    contentHash: doc?.contentHash ?? null,
    model,
  };
}
