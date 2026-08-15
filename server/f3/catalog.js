// Catalog reads + POS quick-create (spec 3.2 / 3.4, FR-02 / FR-03). Reads go
// through the privileged pool but are always scoped to the caller's merchant.
// The full Functional 04 catalog logic lives in products.js; this module keeps the
// thin POS entry points and delegates writes to the SAME atomic core so a
// quick-created product also gets search_name, a price-history row and (for tracked
// goods with opening stock) an 'opening' inventory movement — identical to the full
// create flow.
import { withTransaction } from "../db/pool.js";
import { DomainError } from "./errors.js";
import {
  searchProducts, insertProductTx, mapProductRow, PRODUCT_SELECT, KNOWN_UNITS,
} from "./products.js";
import { normalizeSku, normalizeBarcode } from "./text.js";
import { suggestCategory } from "./ai.js";

const UNIT_CODES = KNOWN_UNITS.map((u) => u.code);

/** GET /v1/products — search/filter the catalog (spec 3.1 / 10). */
export async function listProducts(merchantId, opts = {}) {
  return searchProducts(merchantId, opts);
}

/**
 * Quick-create a minimal product (name/price/unit/track) from the POS. Idempotent
 * against a double-tap: an identical (name, sale_price) created in the last 2 minutes
 * is returned as-is rather than duplicated. Delegates the insert to insertProductTx
 * so it writes search_name + price history + opening movement like the full flow.
 */
export async function quickCreateProduct(merchantId, userId, input) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 160) {
    throw new DomainError("VALIDATION", "Tên hàng cần 1–160 ký tự.");
  }
  const salePrice = Math.trunc(Number(input.salePrice));
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    throw new DomainError("VALIDATION", "Giá bán không hợp lệ.");
  }
  const unitCode = UNIT_CODES.includes(input.unitCode) ? input.unitCode : "item";
  const trackInventory = input.trackInventory !== false;
  const sku = normalizeSku(input.sku);
  const barcode = normalizeBarcode(input.barcode);
  const openingQty = trackInventory ? Math.max(0, Number(input.initialStock) || 0) : 0;
  const lowStockThreshold = trackInventory
    ? (input.lowStockThreshold == null || input.lowStockThreshold === "" ? null : Math.max(0, Number(input.lowStockThreshold) || 0))
    : null;

  return withTransaction(async (client) => {
    const dup = await client.query(
      `${PRODUCT_SELECT}
        where p.merchant_id = $1 and p.name = $2 and p.sale_price = $3
          and p.created_at > now() - interval '2 minutes'
        limit 1`,
      [merchantId, name, salePrice],
    );
    if (dup.rows.length > 0) {
      return { product: mapProductRow(dup.rows[0]), suggestion: suggestCategory(name), idempotentReplay: true };
    }

    let productId;
    try {
      productId = await insertProductTx(client, {
        merchantId, userId, name, productType: "goods", unitCode, salePrice, sku, barcode,
        categoryId: null, trackInventory, lowStockThreshold, allowDiscount: true, openingQty, source: "pos_quick",
      });
    } catch (err) {
      if (err?.code === "23505") throw new DomainError("VALIDATION", "Mã SKU hoặc mã vạch đã tồn tại.");
      throw err;
    }
    const { rows } = await client.query(`${PRODUCT_SELECT} where p.id=$1 and p.merchant_id=$2`, [productId, merchantId]);
    return { product: mapProductRow(rows[0]), suggestion: suggestCategory(name), idempotentReplay: false };
  });
}
