// Functional 07 — expense categories (spec 3.3 / 8.3). Categories are either
// GLOBAL defaults (merchant_id NULL, shared/read-only) or merchant-scoped. The
// short pilot set uses everyday language; tax mapping is back-office config
// (tax_hint), never a legal conclusion shown as fact (spec 12.4 / 11.2).
import { query, withTransaction } from "../db/pool.js";
import { fail } from "../f3/errors.js";

// GLOBAL default set (spec 12.4 "bộ nhóm chi ngắn, ngôn ngữ đời thường").
// code is stable + machine-facing; display_name is what the merchant sees.
export const GLOBAL_CATEGORIES = [
  { code: "purchases", display_name: "Nhập hàng", tax_hint: { deductible_hint: "usually" } },
  { code: "rent", display_name: "Mặt bằng", tax_hint: { deductible_hint: "usually" } },
  { code: "utilities", display_name: "Điện nước", tax_hint: { deductible_hint: "usually" } },
  { code: "payroll", display_name: "Lương", tax_hint: { deductible_hint: "usually" } },
  { code: "shipping", display_name: "Vận chuyển", tax_hint: { deductible_hint: "usually" } },
  { code: "supplies", display_name: "Vật tư – dụng cụ", tax_hint: null },
  { code: "marketing", display_name: "Quảng cáo", tax_hint: null },
  { code: "other", display_name: "Khác", tax_hint: null },
];

let seeded = false;

/**
 * Insert the global defaults once per process if missing. The unique index is
 * (merchant_id, code) but NULL merchant_id rows are distinct under NULL semantics,
 * so we can't rely on ON CONFLICT — guard each insert with a NOT EXISTS instead.
 */
export async function ensureGlobalCategories() {
  if (seeded) return;
  await withTransaction(async (client) => {
    for (const c of GLOBAL_CATEGORIES) {
      await client.query(
        `insert into public.expense_categories (merchant_id, code, display_name, status, tax_hint)
         select null, $1, $2, 'active', $3
         where not exists (
           select 1 from public.expense_categories where merchant_id is null and code = $1)`,
        [c.code, c.display_name, c.tax_hint ? JSON.stringify(c.tax_hint) : null],
      );
    }
  });
  seeded = true;
}

function mapCategory(r) {
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    status: r.status,
    global: r.merchant_id == null,
    taxHint: r.tax_hint ?? null,
  };
}

/** GLOBAL defaults ∪ this merchant's own categories, actives first (spec 10 GET). */
export async function listExpenseCategories(merchantId) {
  await ensureGlobalCategories();
  const { rows } = await query(
    `select id, merchant_id, code, display_name, status, tax_hint
       from public.expense_categories
      where merchant_id is null or merchant_id = $1
      order by (merchant_id is not null), display_name`,
    [merchantId],
  );
  return rows.map(mapCategory);
}

/** Resolve a category id and assert it is visible to this merchant + active. */
export async function loadCategory(client, merchantId, categoryId) {
  const { rows } = await client.query(
    `select id, merchant_id, code, display_name, status
       from public.expense_categories
      where id = $1 and (merchant_id is null or merchant_id = $2)`,
    [categoryId, merchantId],
  );
  if (rows.length === 0) fail("EXPENSE_CATEGORY_NOT_FOUND");
  if (rows[0].status !== "active") fail("VALIDATION", "Nhóm chi đã ngừng dùng.");
  return rows[0];
}
