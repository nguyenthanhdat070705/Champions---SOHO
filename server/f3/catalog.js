// Catalog reads + quick-create (spec 3.2 / 3.4, FR-02 / FR-03). Reads go through
// the privileged pool but are always scoped to the caller's merchant. Writes
// (quick-create) are here because clients are read-only on products under RLS.
import { query, withTransaction } from "../db/pool.js";
import { DomainError } from "./errors.js";
import { writeAudit } from "./audit.js";
import { suggestCategory } from "./ai.js";

const UNIT_CODES = ["item", "chai", "goi", "kg", "lit", "phan", "lan", "cai"];

function mapProduct(r) {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    unitCode: r.unit_code,
    salePrice: Number(r.sale_price),
    trackInventory: r.track_inventory,
    allowDiscount: r.allow_discount,
    isActive: r.is_active,
    categoryId: r.category_id,
    onHand: r.on_hand == null ? null : Number(r.on_hand),
    lowStockThreshold: r.low_stock_threshold == null ? null : Number(r.low_stock_threshold),
  };
}

/** List active products for a merchant, with available quantity (spec 11 GET /v1/products). */
export async function listProducts(merchantId, { search, categoryId, barcode } = {}) {
  const params = [merchantId];
  let where = "p.merchant_id = $1 and p.is_active = true";
  if (barcode) {
    params.push(barcode);
    where += ` and p.barcode = $${params.length}`;
  } else if (search) {
    params.push(`%${search}%`);
    params.push(search);
    where += ` and (p.name ilike $${params.length - 1} or p.sku ilike $${params.length - 1} or p.barcode = $${params.length})`;
  }
  if (categoryId) {
    params.push(categoryId);
    where += ` and p.category_id = $${params.length}`;
  }
  const { rows } = await query(
    `select p.id, p.name, p.sku, p.barcode, p.unit_code, p.sale_price,
            p.track_inventory, p.allow_discount, p.is_active, p.category_id,
            il.on_hand, il.low_stock_threshold
       from public.products p
       left join public.inventory_levels il
         on il.merchant_id = p.merchant_id and il.product_id = p.id
      where ${where}
      order by p.name
      limit 100`,
    params,
  );
  return rows.map(mapProduct);
}

/**
 * Quick-create a minimal product (name/price/unit/track) and, when tracking
 * inventory, its inventory_levels row (spec 3.4). Idempotent against double-tap:
 * an identical (name, sale_price) created in the last 2 minutes is returned as-is
 * rather than duplicated. No AI is required; a deterministic category suggestion
 * is attached for the UI to optionally accept.
 */
export async function quickCreateProduct(merchantId, userId, input) {
  const name = String(input.name || "").trim();
  if (name.length < 1 || name.length > 160) {
    throw new DomainError("VALIDATION", "Tên hàng cần 1–160 ký tự.");
  }
  const salePrice = Math.trunc(Number(input.salePrice));
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    throw new DomainError("VALIDATION", "Giá bán không hợp lệ.");
  }
  const unitCode = UNIT_CODES.includes(input.unitCode) ? input.unitCode : "item";
  const trackInventory = input.trackInventory !== false;
  const sku = input.sku ? String(input.sku).trim() : null;
  const barcode = input.barcode ? String(input.barcode).trim() : null;
  const initialStock = trackInventory ? Math.max(0, Number(input.initialStock) || 0) : 0;
  const lowStockThreshold = trackInventory ? Math.max(0, Number(input.lowStockThreshold) || 0) : 0;

  return withTransaction(async (client) => {
    const dup = await client.query(
      `select p.id, p.name, p.sku, p.barcode, p.unit_code, p.sale_price,
              p.track_inventory, p.allow_discount, p.is_active, p.category_id,
              il.on_hand, il.low_stock_threshold
         from public.products p
         left join public.inventory_levels il
           on il.merchant_id = p.merchant_id and il.product_id = p.id
        where p.merchant_id = $1 and p.name = $2 and p.sale_price = $3
          and p.created_at > now() - interval '2 minutes'
        limit 1`,
      [merchantId, name, salePrice],
    );
    if (dup.rows.length > 0) {
      return { product: mapProduct(dup.rows[0]), suggestion: suggestCategory(name), idempotentReplay: true };
    }

    let inserted;
    try {
      inserted = await client.query(
        `insert into public.products
           (merchant_id, name, sku, barcode, unit_code, sale_price, track_inventory, allow_discount, is_active)
         values ($1,$2,$3,$4,$5,$6,$7,true,true)
         returning id, name, sku, barcode, unit_code, sale_price, track_inventory, allow_discount, is_active, category_id`,
        [merchantId, name, sku, barcode, unitCode, salePrice, trackInventory],
      );
    } catch (err) {
      if (err?.code === "23505") {
        throw new DomainError("VALIDATION", "Mã SKU hoặc mã vạch đã tồn tại.");
      }
      throw err;
    }
    const product = inserted.rows[0];

    if (trackInventory) {
      await client.query(
        `insert into public.inventory_levels (merchant_id, product_id, on_hand, low_stock_threshold)
         values ($1,$2,$3,$4)
         on conflict (merchant_id, product_id) do nothing`,
        [merchantId, product.id, initialStock, lowStockThreshold],
      );
      product.on_hand = initialStock;
      product.low_stock_threshold = lowStockThreshold;
    }

    await writeAudit(client, {
      merchantId,
      actorUserId: userId,
      action: "product.quick_create",
      entityType: "product",
      entityId: product.id,
      after: { name, salePrice, unitCode, trackInventory },
    });

    return { product: mapProduct(product), suggestion: suggestCategory(name), idempotentReplay: false };
  });
}
