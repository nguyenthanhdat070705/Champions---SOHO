// Functional 15 — compliance catalog bootstrap (spec §3.13, §4.5, FR-15). The
// deployed schema keeps only versioned catalog rows (no per-definition table), so
// the book/field/rule structure lives in server/f15/mapping.js; THIS module seeds
// the ONE published `compliance_catalog_versions` row that pins the legal basis +
// effective range + reviewer metadata a locked snapshot references. Idempotent
// (INSERT … WHERE NOT EXISTS on the unique `code`), cached per process.
import { query } from "../db/pool.js";
import { CATALOG_CODE, SCOPE_CODE, RULE_VERSION, BOOK_CODES, contentHash } from "./mapping.js";

// Effective for the 2026 calendar year (TT 152/2025 in force 01/01/2026).
const EFFECTIVE_RANGE = "[2026-01-01,2027-01-01)";

/** Legal basis pinned to the catalog version (spec §13.1 official sources). */
const LEGAL_BASIS = {
  ruleVersion: RULE_VERSION,
  scope: "Hộ, cá nhân kinh doanh bán lẻ (áp dụng phương pháp khoán/kê khai đơn giản)",
  books: BOOK_CODES,
  sources: [
    { code: "TT-152-2025-TT-BTC", title: "Thông tư 152/2025/TT-BTC — hướng dẫn kế toán cho hộ, cá nhân kinh doanh", effectiveFrom: "2026-01-01", url: "https://vanban.chinhphu.vn/?docid=216533&pageid=27160" },
    { code: "ND-141-2026-ND-CP", title: "Nghị định 141/2026/NĐ-CP — ngưỡng doanh thu miễn 1 tỷ/năm", note: "Doanh thu năm ≤ 1 tỷ được miễn; phần vượt chịu GTGT 1% + TNCN 0,5%." },
    { code: "ND-117-2025-ND-CP", title: "Nghị định 117/2025/NĐ-CP — doanh thu qua sàn thương mại điện tử tách riêng", note: "Chưa có kênh sàn trong SoHo — cột doanh thu sàn để 0 kèm chú thích." },
    { code: "Luat-88-2015-QH13", title: "Luật Kế toán 88/2015/QH13 — nguyên tắc chứng từ, sổ, khóa sổ, lưu trữ" },
  ],
  disclaimer: "Số liệu chuẩn bị, không phải kết luận nghĩa vụ thuế. Cần kế toán/CQT xác nhận trước khi kê khai.",
};

let cachedId = null;

/** Ensure the published catalog row exists; return its uuid (cached). */
export async function ensureCatalog() {
  if (cachedId) return cachedId;
  const existing = await query(
    `select id from public.compliance_catalog_versions where code=$1`, [CATALOG_CODE]);
  if (existing.rows.length) { cachedId = existing.rows[0].id; return cachedId; }
  const hash = contentHash({ code: CATALOG_CODE, scope: SCOPE_CODE, ruleVersion: RULE_VERSION, legalBasis: LEGAL_BASIS });
  const ins = await query(
    `insert into public.compliance_catalog_versions
       (code, status, scope_code, effective_range, legal_basis, content_hash, published_at)
     select $1,'published',$2,$3::daterange,$4::jsonb,$5, now()
      where not exists (select 1 from public.compliance_catalog_versions where code=$1)
     returning id`,
    [CATALOG_CODE, SCOPE_CODE, EFFECTIVE_RANGE, JSON.stringify(LEGAL_BASIS), hash]);
  if (ins.rows.length) { cachedId = ins.rows[0].id; return cachedId; }
  // Lost a race — read the row the winner inserted.
  const again = await query(
    `select id from public.compliance_catalog_versions where code=$1`, [CATALOG_CODE]);
  cachedId = again.rows[0]?.id ?? null;
  return cachedId;
}

/** The published catalog descriptor for the UI (spec §3.13 read-only). */
export async function getCatalog() {
  await ensureCatalog();
  const { rows } = await query(
    `select id, code, status, scope_code, lower(effective_range) as effective_from,
            upper(effective_range) as effective_to, legal_basis, content_hash, published_at
       from public.compliance_catalog_versions where code=$1`, [CATALOG_CODE]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, code: r.code, status: r.status, scopeCode: r.scope_code,
    ruleVersion: RULE_VERSION,
    effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
    legalBasis: r.legal_basis, contentHash: r.content_hash,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  };
}
