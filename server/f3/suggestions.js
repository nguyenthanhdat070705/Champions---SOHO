// Post-paid transaction suggestions (spec 12.1 "Sau bill paid"). Runs AFTER the
// payment commits and never on the critical path (FR-15). Deterministic today;
// writes ai_transaction_suggestions rows for lines missing a tax category so a
// human/rule can later confirm. Any failure is swallowed by the caller.
import { withTransaction } from "../db/pool.js";
import { suggestCategory } from "./ai.js";
import { createHash } from "node:crypto";

export async function generateSuggestionsForOrder(merchantId, orderId) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `select oi.id, oi.product_id, oi.name_snapshot, oi.tax_category_snapshot, o.version
         from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.order_id = $1`,
      [orderId],
    );
    for (const it of rows) {
      if (it.tax_category_snapshot) continue; // already categorised
      const s = suggestCategory(it.name_snapshot);
      const sourceHash = "sha256:" + createHash("sha256")
        .update(`${orderId}:${it.id}:${it.name_snapshot}:${it.version}`)
        .digest("hex").slice(0, 32);
      await client.query(
        `insert into public.ai_transaction_suggestions
           (merchant_id, order_id, product_id, source_hash, suggested_category, confidence, reason, needs_review, decision_status, model, prompt_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)
         on conflict (merchant_id, source_hash) do nothing`,
        [merchantId, orderId, it.product_id, sourceHash, s.category, s.confidence, s.reason, s.needsReview, s.model, s.promptVersion],
      );
    }
  });
}
