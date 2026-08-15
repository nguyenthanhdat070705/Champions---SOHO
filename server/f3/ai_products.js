// Functional 04 AI shortcuts orchestration (spec §11). Turns a product-label PHOTO
// into a structured draft (via Gemini) and suggests a category from the name. The
// result ALWAYS lands in a review form — nothing is written to products here. Image
// drafts are recorded in ai_product_suggestions (status pending) and marked
// accepted/rejected on confirm, so we can measure AI-correction rate (KPI 12.5) and
// prove no tax field is ever auto-confirmed (PRD-10).
import { query, withTransaction } from "../db/pool.js";
import { fail } from "./errors.js";
import { writeAudit } from "./audit.js";
import { previewProductFromImage } from "./gemini.js";
import { suggestCategory } from "./ai.js";

// Canonical Vietnamese group labels the deterministic classifier maps to.
const CANON_LABEL = { beverage: "Đồ uống", food: "Đồ ăn", service: "Dịch vụ", other: null };

/**
 * Deterministic category hint from a product name (spec 11 "Gợi ý nhóm"). Only
 * preselect when confident (>=0.75) AND the merchant already has that group.
 */
export async function suggestCategoryForName(merchantId, name) {
  const s = suggestCategory(name || "");
  const label = CANON_LABEL[s.category] ?? null;
  let categoryId = null, matchedName = null;
  if (label) {
    const { rows } = await query(
      `select id, name from public.product_categories where merchant_id=$1 and lower(name)=lower($2) limit 1`,
      [merchantId, label],
    );
    if (rows.length) { categoryId = rows[0].id; matchedName = rows[0].name; }
  }
  return {
    categoryId,
    suggestedName: matchedName ?? label,
    confidence: s.confidence,
    preselect: s.confidence >= 0.75 && categoryId != null,
    reason: s.reason,
  };
}

/** POST /products/ai/preview — image → draft, or name → category hint. */
export async function aiProductPreview(merchantId, userId, body = {}) {
  const draftId = body.draftId || body.draft_id;
  const inputKind = body.inputKind || body.input_kind;
  const { image, mimeType, name } = body;
  if (!draftId) fail("VALIDATION", "Thiếu draft_id.");
  if (inputKind === "category") {
    return { draftId, inputKind, category: await suggestCategoryForName(merchantId, name || "") };
  }
  if (inputKind !== "image") fail("VALIDATION", "Bản này chỉ hỗ trợ nhập bằng ảnh nhãn.");

  const draft = await previewProductFromImage(image, mimeType || "image/jpeg"); // throws AI_PREVIEW_FAILED on provider failure
  const category = await suggestCategoryForName(merchantId, draft.fields.displayName || "");
  const confs = Object.values(draft.fieldConfidence).filter((x) => x != null);
  const overall = confs.length ? Math.min(...confs) : 0.5;
  const payload = { ...draft, category };
  const { rows } = await query(
    `insert into public.ai_product_suggestions (merchant_id, draft_id, input_kind, payload, confidence, status)
     values ($1,$2,'image',$3,$4,'pending') returning id`,
    [merchantId, draftId, JSON.stringify(payload), overall],
  );
  return { suggestionId: rows[0].id, draftId, inputKind: "image", ...draft, category };
}

/** POST /products/ai/:id/confirm — record accept/reject of an AI draft. */
export async function aiConfirmSuggestion(merchantId, userId, suggestionId, { decision, acceptedFields } = {}) {
  const status = decision === "reject" ? "rejected" : "accepted";
  return withTransaction(async (client) => {
    const cur = await client.query(
      `select id, draft_id, status from public.ai_product_suggestions where id=$1 and merchant_id=$2 for update`,
      [suggestionId, merchantId],
    );
    if (cur.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy gợi ý.");
    await client.query(`update public.ai_product_suggestions set status=$1 where id=$2`, [status, suggestionId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "product.ai_confirmed", entityType: "ai_suggestion", entityId: suggestionId,
      after: { decision: status, acceptedFields: acceptedFields ?? null, draftId: cur.rows[0].draft_id },
    });
    return { suggestionId, status };
  });
}
