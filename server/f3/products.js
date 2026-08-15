// Functional 04 — catalog service (spec §3–§10). products is the single source of
// truth for current product attributes; order_items snapshot past sales (spec 7.2),
// so editing a product NEVER changes an old bill. Every create/edit runs through the
// privileged pool in ONE transaction (spec 8.1): insert/patch the product, append
// product_price_history on price set/change, post an 'opening' inventory movement for
// tracked goods with an opening quantity, and write an audit row — all-or-nothing.
// Because the pooler bypasses RLS, callers are authorised in router.js (JWT +
// membership/role) before reaching here.
import { getPool, query, withTransaction } from "../db/pool.js";
import { DomainError, fail } from "./errors.js";
import { writeAudit, enqueueOutbox } from "./audit.js";
import { normalizeSearchName, normalizeSku, normalizeBarcode } from "./text.js";
import { createHash } from "node:crypto";

// Units offered in the picker; free-text is still accepted (<=24 chars) so a
// merchant can name an unusual unit, but these cover the pilot set (spec 13.2).
export const KNOWN_UNITS = [
  { code: "item", label: "Cái" }, { code: "chai", label: "Chai" }, { code: "goi", label: "Gói" },
  { code: "kg", label: "Kg" }, { code: "lit", label: "Lít" }, { code: "hop", label: "Hộp" },
  { code: "thung", label: "Thùng" }, { code: "phan", label: "Phần" }, { code: "lan", label: "Lần" }, { code: "bo", label: "Bộ" },
];

// ── Row shape ────────────────────────────────────────────────────────────────
// Shared SELECT so the F3 list, the F4 catalog and detail all return one product
// shape (superset of the original F3 fields — additive, so the POS is unaffected).
export const PRODUCT_SELECT = `
  select p.id, p.merchant_id, p.name, p.search_name, p.product_type, p.sku, p.barcode,
         p.unit_code, p.sale_price, p.category_id, c.name as category_name,
         p.track_inventory, p.allow_discount, p.negative_stock_policy,
         p.low_stock_threshold, p.status, p.is_active, p.row_version,
         p.created_at, p.updated_at,
         il.on_hand, il.low_stock_threshold as inv_low_stock_threshold
    from public.products p
    left join public.product_categories c on c.id = p.category_id
    left join public.inventory_levels il on il.merchant_id = p.merchant_id and il.product_id = p.id`;

export function mapProductRow(r) {
  const prodThreshold = r.low_stock_threshold == null ? null : Number(r.low_stock_threshold);
  const invThreshold = r.inv_low_stock_threshold == null ? null : Number(r.inv_low_stock_threshold);
  return {
    id: r.id,
    name: r.name,
    searchName: r.search_name,
    productType: r.product_type,
    sku: r.sku,
    barcode: r.barcode,
    unitCode: r.unit_code,
    salePrice: Number(r.sale_price),
    categoryId: r.category_id,
    categoryName: r.category_name ?? null,
    trackInventory: r.track_inventory,
    allowDiscount: r.allow_discount,
    negativeStockPolicy: r.negative_stock_policy,
    // `lowStockThreshold` is the EFFECTIVE threshold (product-level wins when set,
    // else the inventory-level one — brief). This keeps the POS/inventory low-stock
    // badge backward-compatible. `productLowStockThreshold` is the raw product-level
    // value (nullable) the edit form prefills from.
    lowStockThreshold: prodThreshold != null ? prodThreshold : invThreshold,
    productLowStockThreshold: prodThreshold,
    status: r.status,
    isActive: r.is_active,
    rowVersion: r.row_version,
    onHand: r.on_hand == null ? null : Number(r.on_hand),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── In-process idempotency (spec 5.1 / 10.3) ─────────────────────────────────
// POST /products carries an Idempotency-Key. A durable key table would need a
// migration (out of scope), so for the single-instance pilot server we single-
// flight by (merchant, key) in memory: a double-tap with the SAME body returns the
// SAME product (PRD-04); the SAME key with a DIFFERENT body is a 409 (spec 5.1).
// Cross-device duplicates are still caught by the DB unique indexes (PRD-03).
const idemStore = new Map(); // `${scope}:${key}` -> { hash, promise, result, expires }
const IDEM_TTL_MS = 15 * 60 * 1000;

function bodyHash(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

async function runIdempotent(scope, key, hash, fn) {
  if (!key) return { result: await fn(), replayed: false };
  const id = `${scope}:${key}`;
  const now = Date.now();
  for (const [k, v] of idemStore) if (v.expires < now) idemStore.delete(k);
  const existing = idemStore.get(id);
  if (existing) {
    if (existing.hash !== hash) fail("IDEMPOTENCY_PAYLOAD_MISMATCH");
    if (existing.result !== undefined) return { result: existing.result, replayed: true };
    const result = await existing.promise;
    return { result, replayed: true };
  }
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // avoid unhandledRejection when no one is waiting
  idemStore.set(id, { hash, promise, result: undefined, expires: now + IDEM_TTL_MS });
  try {
    const result = await fn();
    const e = idemStore.get(id);
    if (e) { e.result = result; e.expires = Date.now() + IDEM_TTL_MS; }
    resolve(result);
    return { result, replayed: false };
  } catch (err) {
    idemStore.delete(id); // a failed attempt may be retried with the same key
    reject(err);
    throw err;
  }
}

// ── Validation helpers (pure) ────────────────────────────────────────────────
export function validateProductInput(input, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has("name")) {
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 120) fail("VALIDATION", "Tên hàng cần 1–120 ký tự.");
    out.name = name;
  }
  if (!partial || has("productType")) {
    const t = input.productType ?? "goods";
    if (t !== "goods" && t !== "service") fail("VALIDATION", "Loại sản phẩm không hợp lệ.");
    out.productType = t;
  }
  if (!partial || has("salePrice")) {
    const p = Math.trunc(Number(input.salePrice));
    if (!Number.isFinite(p) || p < 0) fail("VALIDATION", "Giá phải là số từ 0đ trở lên.");
    out.salePrice = p;
  }
  if (!partial || has("unitCode")) {
    let u = String(input.unitCode ?? "").trim();
    if (u.length > 24) fail("VALIDATION", "Đơn vị quá dài.");
    out.unitCode = u || "item";
  }
  if (has("sku")) out.sku = normalizeSku(input.sku);
  if (has("barcode")) out.barcode = normalizeBarcode(input.barcode);
  if (has("categoryId")) out.categoryId = input.categoryId ? String(input.categoryId) : null;
  if (has("allowDiscount")) out.allowDiscount = input.allowDiscount !== false;
  if (has("trackInventory")) out.trackInventory = Boolean(input.trackInventory);
  if (has("negativeStockPolicy")) {
    const n = input.negativeStockPolicy;
    if (n !== "block" && n !== "allow_owner") fail("VALIDATION", "Chính sách bán âm không hợp lệ.");
    out.negativeStockPolicy = n;
  }
  if (has("lowStockThreshold")) {
    if (input.lowStockThreshold == null || input.lowStockThreshold === "") out.lowStockThreshold = null;
    else {
      const t = Number(input.lowStockThreshold);
      if (!Number.isFinite(t) || t < 0) fail("VALIDATION", "Mức tồn thấp không hợp lệ.");
      out.lowStockThreshold = t;
    }
  }
  if (has("openingQty")) {
    const q = Number(input.openingQty || 0);
    if (!Number.isFinite(q) || q < 0) fail("VALIDATION", "Tồn đầu không hợp lệ.");
    out.openingQty = q;
  }
  return out;
}

/** Enforce the service⇒no-inventory rule up front (spec 4.1, → 422 PRD-02). */
function assertServiceInventory(productType, trackInventory) {
  if (productType === "service" && trackInventory) fail("SERVICE_NO_INVENTORY");
}

// ── Conflict pre-checks (attach existing_product_id for OPEN_EXISTING) ───────
async function findBySku(client, merchantId, sku, exceptId) {
  if (!sku) return null;
  const { rows } = await client.query(
    `select id from public.products where merchant_id=$1 and sku=$2 ${exceptId ? "and id<>$3" : ""} limit 1`,
    exceptId ? [merchantId, sku, exceptId] : [merchantId, sku],
  );
  return rows[0]?.id ?? null;
}
async function findByBarcode(client, merchantId, barcode, exceptId) {
  if (!barcode) return null;
  const { rows } = await client.query(
    `select id from public.products where merchant_id=$1 and barcode=$2 ${exceptId ? "and id<>$3" : ""} limit 1`,
    exceptId ? [merchantId, barcode, exceptId] : [merchantId, barcode],
  );
  return rows[0]?.id ?? null;
}

async function assertCategoryOwned(client, merchantId, categoryId) {
  if (!categoryId) return;
  const { rows } = await client.query(
    `select 1 from public.product_categories where id=$1 and merchant_id=$2`, [categoryId, merchantId],
  );
  if (rows.length === 0) fail("VALIDATION", "Nhóm hàng không hợp lệ.");
}

// ── Shared atomic insert (used by full create AND POS quick-create) ──────────
export async function insertProductTx(client, {
  merchantId, userId, name, productType, unitCode, salePrice, sku, barcode, categoryId,
  trackInventory, negativeStockPolicy = "block", lowStockThreshold = null, allowDiscount = true,
  openingQty = 0, source = "manual",
}) {
  const searchName = normalizeSearchName(name);
  const status = "active";
  const isActive = true;
  // NB: public.products has NO created_by column in the deployed schema (the spec
  // skeleton listed one; the migration dropped it). The actor is captured in the
  // product.created audit row instead.
  const ins = await client.query(
    `insert into public.products
       (merchant_id, name, search_name, product_type, unit_code, sale_price, sku, barcode,
        category_id, track_inventory, allow_discount, negative_stock_policy, low_stock_threshold,
        status, is_active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [merchantId, name, searchName, productType, unitCode, salePrice, sku, barcode, categoryId,
     trackInventory, allowDiscount, negativeStockPolicy, lowStockThreshold, status, isActive],
  );
  const productId = ins.rows[0].id;

  // Price snapshot (spec 8.1 — same transaction as the product).
  await client.query(
    `insert into public.product_price_history (merchant_id, product_id, price_vnd, changed_by)
     values ($1,$2,$3,$4)`,
    [merchantId, productId, salePrice, userId],
  );

  // Tracked goods: create the level row and, when there is opening stock, post an
  // immutable 'opening' movement (spec 3.5 / 5 PRD_007 — never UPDATE qty directly).
  let opening = 0;
  if (productType === "goods" && trackInventory) {
    opening = Math.max(0, Number(openingQty) || 0);
    await client.query(
      `insert into public.inventory_levels (merchant_id, product_id, on_hand, low_stock_threshold)
       values ($1,$2,$3,$4)
       on conflict (merchant_id, product_id) do update set on_hand=excluded.on_hand, row_version=public.inventory_levels.row_version+1, updated_at=now()`,
      [merchantId, productId, opening, lowStockThreshold ?? 0],
    );
    if (opening > 0) {
      await client.query(
        `insert into public.inventory_movements
           (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by, reason_code)
         values ($1,$2,'opening',$3,$3,'product',$2,$4,'opening_stock')
         on conflict (product_id, movement_type, reference_type, reference_id) do nothing`,
        [merchantId, productId, opening, userId],
      );
    }
  }

  await writeAudit(client, {
    merchantId, actorUserId: userId, action: "product.created", entityType: "product", entityId: productId,
    after: { name, productType, salePrice, unitCode, sku, barcode, trackInventory, openingQty: opening, source },
  });
  await enqueueOutbox(client, { merchantId, eventType: "product.created", aggregateId: productId, payload: { productId } });
  return productId;
}

async function loadProductById(client, merchantId, productId) {
  const { rows } = await (client ?? getPool()).query(
    `${PRODUCT_SELECT} where p.id = $1 and p.merchant_id = $2`, [productId, merchantId],
  );
  return rows.length ? mapProductRow(rows[0]) : null;
}

// ── Public: create (spec 3.7 / 10.2 POST /products) ──────────────────────────
export async function createProduct(merchantId, userId, role, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED", "Thiếu Idempotency-Key.");
  const v = validateProductInput(input, { partial: false });
  const productType = v.productType;
  const trackInventory = productType === "service" ? false : (v.trackInventory ?? true);
  assertServiceInventory(productType, input.trackInventory === true ? true : trackInventory);
  // negative-stock 'allow_owner' is owner-only (spec 12.1).
  let negativeStockPolicy = v.negativeStockPolicy ?? "block";
  if (negativeStockPolicy === "allow_owner" && role !== "owner") negativeStockPolicy = "block";

  const canonical = {
    name: v.name, productType, unitCode: v.unitCode, salePrice: v.salePrice,
    sku: v.sku ?? null, barcode: v.barcode ?? null, categoryId: v.categoryId ?? null,
    trackInventory, negativeStockPolicy, lowStockThreshold: v.lowStockThreshold ?? null,
    allowDiscount: v.allowDiscount ?? true, openingQty: trackInventory ? (v.openingQty ?? 0) : 0,
  };

  const { result, replayed } = await runIdempotent("product", idemKey, bodyHash(canonical), async () => {
    try {
      return await withTransaction(async (client) => {
        await assertCategoryOwned(client, merchantId, canonical.categoryId);
        const skuOwner = await findBySku(client, merchantId, canonical.sku);
        if (skuOwner) throw new DomainError("PRODUCT_SKU_CONFLICT", undefined, { field: "sku", action: "OPEN_EXISTING_PRODUCT", existing_product_id: skuOwner });
        const barcodeOwner = await findByBarcode(client, merchantId, canonical.barcode);
        if (barcodeOwner) throw new DomainError("PRODUCT_BARCODE_CONFLICT", undefined, { field: "barcode", action: "OPEN_EXISTING_PRODUCT", existing_product_id: barcodeOwner });

        const productId = await insertProductTx(client, { merchantId, userId, source: input.source || "manual", ...canonical });
        const { rows } = await client.query(`${PRODUCT_SELECT} where p.id=$1 and p.merchant_id=$2`, [productId, merchantId]);
        return mapProductRow(rows[0]);
      });
    } catch (err) {
      // Two devices race past the in-txn pre-check and one hits the unique index
      // (PRD-03). The txn is aborted, so look the winner up on a fresh connection
      // to attach existing_product_id / OPEN_EXISTING for the UI.
      if (err?.code === "23505") {
        const msg = String(err.message || "");
        if (/barcode/.test(msg) && canonical.barcode) {
          const owner = await findByBarcode(getPool(), merchantId, canonical.barcode);
          throw new DomainError("PRODUCT_BARCODE_CONFLICT", undefined, { field: "barcode", action: "OPEN_EXISTING_PRODUCT", existing_product_id: owner });
        }
        if (/sku/.test(msg) && canonical.sku) {
          const owner = await findBySku(getPool(), merchantId, canonical.sku);
          throw new DomainError("PRODUCT_SKU_CONFLICT", undefined, { field: "sku", action: "OPEN_EXISTING_PRODUCT", existing_product_id: owner });
        }
      }
      throw err;
    }
  });
  return { product: result, replayed };
}

// ── Public: search / list (spec 3.1 / 10 GET /products) ──────────────────────
export async function searchProducts(merchantId, {
  search, categoryId, barcode, type, status, includeArchived, limit, offset,
} = {}) {
  const params = [merchantId];
  const clauses = ["p.merchant_id = $1"];

  if (barcode) {
    params.push(String(barcode).trim());
    clauses.push(`p.barcode = $${params.length}`);
  } else {
    // Status filter. No explicit status → active-only (keeps the POS unchanged).
    if (!status) {
      clauses.push("p.is_active = true");
    } else if (status === "all") {
      clauses.push(includeArchived ? "p.status in ('active','inactive','archived')" : "p.status in ('active','inactive')");
    } else if (["active", "inactive", "archived"].includes(status)) {
      params.push(status);
      clauses.push(`p.status = $${params.length}`);
    }
    if (type === "goods" || type === "service") {
      params.push(type);
      clauses.push(`p.product_type = $${params.length}`);
    }
    if (categoryId) {
      params.push(categoryId);
      clauses.push(`p.category_id = $${params.length}`);
    }
    if (search && String(search).trim()) {
      const raw = String(search).trim();
      const norm = normalizeSearchName(raw);
      const sku = normalizeSku(raw);
      params.push(`%${norm}%`); const iNorm = params.length;
      params.push(`%${raw.toLowerCase()}%`); const iName = params.length;
      params.push(sku); const iSku = params.length;
      params.push(raw); const iBarcode = params.length;
      clauses.push(`(p.search_name ilike $${iNorm} or lower(p.name) ilike $${iName} or p.sku = $${iSku} or p.barcode = $${iBarcode})`);
    }
  }

  const lim = Math.min(Math.max(1, Number(limit) || 100), 200);
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim + 1); const iLim = params.length; // fetch one extra to know hasMore
  params.push(off); const iOff = params.length;

  const { rows } = await query(
    `${PRODUCT_SELECT} where ${clauses.join(" and ")}
      order by (p.status='archived'), lower(p.name)
      limit $${iLim} offset $${iOff}`,
    params,
  );
  const hasMore = rows.length > lim;
  return { products: rows.slice(0, lim).map(mapProductRow), hasMore, nextOffset: hasMore ? off + lim : null };
}

// ── Public: detail (spec 3.8 GET /products/:id) ──────────────────────────────
export async function getProductDetail(merchantId, productId) {
  const product = await loadProductById(null, merchantId, productId);
  if (!product) fail("PRODUCT_NOT_FOUND");
  const pool = getPool();
  const [prices, audit, movements] = await Promise.all([
    pool.query(`select price_vnd, effective_from, changed_by from public.product_price_history
                 where merchant_id=$1 and product_id=$2 order by effective_from desc limit 20`, [merchantId, productId]),
    pool.query(`select action, before_data, after_data, actor_user_id, created_at from public.audit_logs
                 where merchant_id=$1 and entity_type='product' and entity_id=$2 order by created_at desc limit 30`, [merchantId, productId]),
    pool.query(`select movement_type, quantity_delta, balance_after, reason_code, created_at from public.inventory_movements
                 where merchant_id=$1 and product_id=$2 order by created_at desc limit 30`, [merchantId, productId]),
  ]);
  return {
    product,
    priceHistory: prices.rows.map((r) => ({ priceVnd: Number(r.price_vnd), effectiveFrom: r.effective_from, changedBy: r.changed_by })),
    auditEvents: audit.rows.map((r) => ({ action: r.action, before: r.before_data, after: r.after_data, actorUserId: r.actor_user_id, createdAt: r.created_at })),
    movements: movements.rows.map((r) => ({ movementType: r.movement_type, quantityDelta: Number(r.quantity_delta), balanceAfter: Number(r.balance_after), reasonCode: r.reason_code, createdAt: r.created_at })),
  };
}

// ── Public: barcode lookup (spec 3.3 GET /products/barcode/:code) ─────────────
export async function lookupByBarcode(merchantId, code) {
  const barcode = normalizeBarcode(code);
  if (!barcode) fail("VALIDATION", "Mã trống.");
  const { rows } = await query(`${PRODUCT_SELECT} where p.merchant_id=$1 and p.barcode=$2 limit 1`, [merchantId, barcode]);
  if (rows.length === 0) fail("PRODUCT_NOT_FOUND");
  return { product: mapProductRow(rows[0]) };
}

// ── Public: update (spec 3.8 / 10 PATCH /products/:id, If-Match row_version) ──
export async function updateProduct(merchantId, userId, role, productId, input, ifMatch) {
  return withTransaction(async (client) => {
    const cur = await client.query(
      `select * from public.products where id=$1 and merchant_id=$2 for update`, [productId, merchantId],
    );
    if (cur.rows.length === 0) fail("PRODUCT_NOT_FOUND");
    const p = cur.rows[0];

    // Optimistic lock (spec 5.1 / PRD-12): stale version → 409 + current snapshot.
    if (ifMatch != null && Number(p.row_version) !== Number(ifMatch)) {
      const snap = await loadProductById(client, merchantId, productId);
      throw new DomainError("VERSION_CONFLICT", "Sản phẩm vừa được người khác sửa.", { currentProduct: snap });
    }

    const v = validateProductInput(input, { partial: true });
    const before = {};
    const after = {};
    const sets = [];
    const args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col}=$${args.length}`); };

    // product_type conversion (goods⇄service). Converting to service forces
    // track_inventory off (spec 2.2 / 4.1); movements are kept, not deleted.
    let productType = p.product_type;
    let trackInventory = p.track_inventory;
    if (v.productType && v.productType !== p.product_type) {
      productType = v.productType;
      before.productType = p.product_type; after.productType = productType;
      set("product_type", productType);
      if (productType === "service") { trackInventory = false; }
    }
    if (Object.prototype.hasOwnProperty.call(v, "trackInventory")) {
      const wanted = productType === "service" ? false : v.trackInventory;
      if (wanted !== p.track_inventory) {
        trackInventory = wanted;
        before.trackInventory = p.track_inventory; after.trackInventory = wanted;
        set("track_inventory", wanted);
      }
    } else if (productType === "service" && p.track_inventory) {
      set("track_inventory", false);
      before.trackInventory = true; after.trackInventory = false;
    }
    assertServiceInventory(productType, trackInventory);

    if (v.name && v.name !== p.name) {
      before.name = p.name; after.name = v.name;
      set("name", v.name); set("search_name", normalizeSearchName(v.name));
    }
    if (Object.prototype.hasOwnProperty.call(v, "categoryId") && v.categoryId !== p.category_id) {
      await assertCategoryOwned(client, merchantId, v.categoryId);
      before.categoryId = p.category_id; after.categoryId = v.categoryId;
      set("category_id", v.categoryId);
    }
    if (v.unitCode && v.unitCode !== p.unit_code) {
      before.unitCode = p.unit_code; after.unitCode = v.unitCode;
      set("unit_code", v.unitCode);
    }
    if (Object.prototype.hasOwnProperty.call(v, "allowDiscount") && v.allowDiscount !== p.allow_discount) {
      before.allowDiscount = p.allow_discount; after.allowDiscount = v.allowDiscount;
      set("allow_discount", v.allowDiscount);
    }
    if (Object.prototype.hasOwnProperty.call(v, "lowStockThreshold")) {
      const curT = p.low_stock_threshold == null ? null : Number(p.low_stock_threshold);
      if (curT !== v.lowStockThreshold) {
        before.lowStockThreshold = curT; after.lowStockThreshold = v.lowStockThreshold;
        set("low_stock_threshold", v.lowStockThreshold);
      }
    }
    if (Object.prototype.hasOwnProperty.call(v, "negativeStockPolicy") && v.negativeStockPolicy !== p.negative_stock_policy) {
      if (v.negativeStockPolicy === "allow_owner" && role !== "owner") fail("FORBIDDEN", "Chỉ chủ cửa hàng mới được bật bán âm.");
      before.negativeStockPolicy = p.negative_stock_policy; after.negativeStockPolicy = v.negativeStockPolicy;
      set("negative_stock_policy", v.negativeStockPolicy);
    }

    // SKU (case-insensitive unique, spec 4.2).
    if (Object.prototype.hasOwnProperty.call(v, "sku") && (v.sku ?? null) !== (p.sku ?? null)) {
      const owner = await findBySku(client, merchantId, v.sku, productId);
      if (owner) throw new DomainError("PRODUCT_SKU_CONFLICT", undefined, { field: "sku", action: "OPEN_EXISTING_PRODUCT", existing_product_id: owner });
      before.sku = p.sku; after.sku = v.sku;
      set("sku", v.sku);
    }
    // Barcode change → conflict check + explicit before/after audit (PRD-15).
    let barcodeChanged = false;
    if (Object.prototype.hasOwnProperty.call(v, "barcode") && (v.barcode ?? null) !== (p.barcode ?? null)) {
      const owner = await findByBarcode(client, merchantId, v.barcode, productId);
      if (owner) throw new DomainError("PRODUCT_BARCODE_CONFLICT", undefined, { field: "barcode", action: "OPEN_EXISTING_PRODUCT", existing_product_id: owner });
      before.barcode = p.barcode; after.barcode = v.barcode;
      set("barcode", v.barcode);
      barcodeChanged = true;
    }

    // Price change → append price history (old bills keep their snapshot, PRD-05).
    let priceChanged = false;
    if (Object.prototype.hasOwnProperty.call(v, "salePrice") && v.salePrice !== Number(p.sale_price)) {
      before.salePrice = Number(p.sale_price); after.salePrice = v.salePrice;
      set("sale_price", v.salePrice);
      priceChanged = true;
    }

    if (sets.length === 0) {
      return { product: await loadProductById(client, merchantId, productId), changed: false };
    }

    args.push(productId); const idIdx = args.length;
    await client.query(
      `update public.products set ${sets.join(", ")}, row_version=row_version+1, updated_at=now()
        where id=$${idIdx}`, args,
    );
    if (priceChanged) {
      await client.query(
        `insert into public.product_price_history (merchant_id, product_id, price_vnd, changed_by)
         values ($1,$2,$3,$4)`, [merchantId, productId, after.salePrice, userId],
      );
    }
    // Keep the inventory-level threshold aligned when the product-level one changes.
    if (Object.prototype.hasOwnProperty.call(after, "lowStockThreshold") && after.lowStockThreshold != null) {
      await client.query(
        `update public.inventory_levels set low_stock_threshold=$1, updated_at=now()
          where merchant_id=$2 and product_id=$3`, [after.lowStockThreshold, merchantId, productId],
      );
    }

    await writeAudit(client, { merchantId, actorUserId: userId, action: "product.updated", entityType: "product", entityId: productId, before, after });
    if (barcodeChanged) {
      await writeAudit(client, { merchantId, actorUserId: userId, action: "product.barcode_changed", entityType: "product", entityId: productId, before: { barcode: before.barcode }, after: { barcode: after.barcode } });
    }
    await enqueueOutbox(client, { merchantId, eventType: "product.updated", aggregateId: productId, payload: { productId, fields: Object.keys(after) } });

    return { product: await loadProductById(client, merchantId, productId), changed: true };
  });
}

// ── Public: status change (spec 3.8 / 10 POST /products/:id/status) ──────────
const STATUS_ACTIONS = {
  activate: { to: "active", isActive: true, from: ["inactive"] },
  deactivate: { to: "inactive", isActive: false, from: ["active"] },
  archive: { to: "archived", isActive: false, from: ["active", "inactive"] },
};

export async function changeProductStatus(merchantId, userId, productId, action, { reason, ifMatch } = {}) {
  const spec = STATUS_ACTIONS[action];
  if (!spec) fail("VALIDATION", "Hành động trạng thái không hợp lệ.");
  return withTransaction(async (client) => {
    const cur = await client.query(`select * from public.products where id=$1 and merchant_id=$2 for update`, [productId, merchantId]);
    if (cur.rows.length === 0) fail("PRODUCT_NOT_FOUND");
    const p = cur.rows[0];
    if (ifMatch != null && Number(p.row_version) !== Number(ifMatch)) {
      const snap = await loadProductById(client, merchantId, productId);
      throw new DomainError("VERSION_CONFLICT", "Sản phẩm vừa được người khác sửa.", { currentProduct: snap });
    }
    // Idempotent no-op if already in the target status.
    if (p.status === spec.to) {
      return { product: await loadProductById(client, merchantId, productId), changed: false };
    }
    if (!spec.from.includes(p.status)) {
      fail("VALIDATION", `Không thể ${action === "activate" ? "bật bán lại" : action === "archive" ? "lưu trữ" : "ngừng bán"} từ trạng thái hiện tại.`);
    }
    await client.query(
      `update public.products set status=$1, is_active=$2, row_version=row_version+1, updated_at=now() where id=$3`,
      [spec.to, spec.isActive, productId],
    );
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "product.status_changed", entityType: "product", entityId: productId,
      before: { status: p.status }, after: { status: spec.to, reason: reason ?? null },
    });
    await enqueueOutbox(client, { merchantId, eventType: "product.status_changed", aggregateId: productId, payload: { productId, status: spec.to } });
    return { product: await loadProductById(client, merchantId, productId), changed: true };
  });
}

// ── Categories (spec 8.2 / 10 GET|POST /categories, PATCH /categories/:id) ────
export async function listCategories(merchantId) {
  const { rows } = await query(
    `select c.id, c.name, c.sort_order,
            (select count(*) from public.products p where p.category_id=c.id and p.is_active) as active_count
       from public.product_categories c where c.merchant_id=$1 order by c.sort_order, lower(c.name)`,
    [merchantId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, activeCount: Number(r.active_count) }));
}

export async function createCategory(merchantId, userId, name) {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 60) fail("VALIDATION", "Tên nhóm cần 1–60 ký tự.");
  return withTransaction(async (client) => {
    // Quick-create is naturally idempotent on name: a double-tap returns the row.
    const dup = await client.query(`select id, name, sort_order from public.product_categories where merchant_id=$1 and name=$2`, [merchantId, n]);
    if (dup.rows.length > 0) {
      const r = dup.rows[0];
      return { category: { id: r.id, name: r.name, sortOrder: r.sort_order, activeCount: 0 }, replayed: true };
    }
    const ins = await client.query(
      `insert into public.product_categories (merchant_id, name, created_by) values ($1,$2,$3) returning id, name, sort_order`,
      [merchantId, n, userId],
    );
    await writeAudit(client, { merchantId, actorUserId: userId, action: "category.created", entityType: "category", entityId: ins.rows[0].id, after: { name: n } });
    const r = ins.rows[0];
    return { category: { id: r.id, name: r.name, sortOrder: r.sort_order, activeCount: 0 }, replayed: false };
  });
}

export async function renameCategory(merchantId, userId, categoryId, name) {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 60) fail("VALIDATION", "Tên nhóm cần 1–60 ký tự.");
  return withTransaction(async (client) => {
    const cur = await client.query(`select name from public.product_categories where id=$1 and merchant_id=$2 for update`, [categoryId, merchantId]);
    if (cur.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy nhóm hàng.");
    if (cur.rows[0].name === n) return { category: { id: categoryId, name: n } };
    const dup = await client.query(`select 1 from public.product_categories where merchant_id=$1 and name=$2 and id<>$3`, [merchantId, n, categoryId]);
    if (dup.rows.length > 0) fail("CATEGORY_NAME_CONFLICT");
    await client.query(`update public.product_categories set name=$1, updated_at=now() where id=$2`, [n, categoryId]);
    await writeAudit(client, { merchantId, actorUserId: userId, action: "category.renamed", entityType: "category", entityId: categoryId, before: { name: cur.rows[0].name }, after: { name: n } });
    return { category: { id: categoryId, name: n } };
  });
}
