// Sales draft lifecycle (spec 3.5 / 4 / 8 / 11): server-computed preview, draft
// create/update with optimistic version, lock→awaiting_payment with stock
// reservation, and order reads. The backend computes ALL totals; the mobile
// only estimates (FR-04). Every write is scoped to the caller's merchant.
import { createHash } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";
import { DomainError, fail } from "./errors.js";
import { priceCart } from "./pricing.js";
import { orderNumber } from "./numbering.js";
import { writeAudit } from "./audit.js";

// Cashier manual-discount ceiling. merchant_settings has no configurable column
// in the deployed schema, so this is the pilot default (spec 4.4 guardrail):
// a cashier applying a manual discount above this needs owner/manager.
const CASHIER_DISCOUNT_LIMIT_PCT = 20;
const RESERVATION_TTL_MINUTES = 15;

/** Merchant timezone/business-date/receipt-prefix context (spec 3.3). */
export async function getMerchantContext(merchantId) {
  const { rows } = await query(
    `select coalesce(timezone,'Asia/Ho_Chi_Minh') as timezone,
            coalesce(receipt_prefix,'SOHO') as receipt_prefix,
            allow_cash, allow_qr,
            (timezone(coalesce(timezone,'Asia/Ho_Chi_Minh'), now()))::date as business_date
       from public.merchant_settings where merchant_id = $1`,
    [merchantId],
  );
  if (rows.length === 0) {
    // Fall back to defaults if settings row is missing (shouldn't happen post-F1).
    const { rows: d } = await query(
      `select (timezone('Asia/Ho_Chi_Minh', now()))::date as business_date`,
    );
    return { timezone: "Asia/Ho_Chi_Minh", receiptPrefix: "SOHO", allowCash: true, allowQr: true, businessDate: d[0].business_date };
  }
  const r = rows[0];
  return {
    timezone: r.timezone,
    receiptPrefix: r.receipt_prefix,
    allowCash: r.allow_cash,
    allowQr: r.allow_qr,
    businessDate: r.business_date instanceof Date ? r.business_date.toISOString().slice(0, 10) : String(r.business_date),
  };
}

/** sha256 fingerprint of the priced cart so the client can detect changes. */
export function pricingVersion(priced, lineInputs) {
  const canonical = JSON.stringify({
    lines: lineInputs.map((l) => ({ p: l.productId ?? null, u: l.unitPrice, q: l.quantity })),
    total: priced.totalAmount,
    discount: priced.discountAmount,
  });
  return "sha256:" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Resolve cart items to priced lines using CURRENT product prices (for preview
 * and lock recompute) or an explicit unit price (manual lines). Returns
 * { lineInputs, meta } where meta carries the product snapshot per line.
 */
async function resolveLines(client, merchantId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    fail("VALIDATION", "Giỏ hàng trống.");
  }
  const productIds = items.filter((i) => i.productId).map((i) => i.productId);
  const products = new Map();
  if (productIds.length > 0) {
    const { rows } = await client.query(
      `select p.id, p.name, p.sku, p.unit_code, p.sale_price, p.track_inventory,
              p.allow_discount, p.tax_category_code, il.on_hand
         from public.products p
         left join public.inventory_levels il on il.merchant_id = p.merchant_id and il.product_id = p.id
        where p.merchant_id = $1 and p.id = any($2::uuid[])`,
      [merchantId, productIds],
    );
    for (const r of rows) products.set(r.id, r);
  }

  const lineInputs = [];
  const meta = [];
  items.forEach((it, idx) => {
    const qty = Number(it.quantity);
    if (!(qty > 0)) fail("VALIDATION", `Số lượng dòng ${idx + 1} không hợp lệ.`);
    if (it.productId) {
      const p = products.get(it.productId);
      if (!p) fail("VALIDATION", `Sản phẩm không tồn tại (dòng ${idx + 1}).`);
      lineInputs.push({ productId: p.id, unitPrice: Number(p.sale_price), quantity: qty });
      meta.push({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unitCode: p.unit_code,
        unitPrice: Number(p.sale_price),
        trackInventory: p.track_inventory,
        allowDiscount: p.allow_discount,
        taxCategory: p.tax_category_code,
        onHand: p.on_hand == null ? null : Number(p.on_hand),
        note: it.note ?? null,
      });
    } else {
      const name = String(it.name || "").trim();
      const unitPrice = Math.trunc(Number(it.unitPrice));
      if (!name || !(unitPrice >= 0)) fail("VALIDATION", `Dòng thủ công ${idx + 1} thiếu tên/giá.`);
      lineInputs.push({ productId: null, unitPrice, quantity: qty });
      meta.push({
        productId: null,
        name,
        sku: it.sku ?? null,
        unitCode: it.unitCode || "item",
        unitPrice,
        trackInventory: false,
        allowDiscount: true,
        taxCategory: null,
        onHand: null,
        note: it.note ?? null,
      });
    }
  });
  return { lineInputs, meta };
}

/**
 * Enforce discount permissions (spec 4.4 / FR-05): a product with
 * allow_discount=false can't be discounted; a cashier can't apply a manual
 * discount above the ceiling. `adjustments` reference lines by lineNo.
 */
function enforceDiscountPolicy(adjustments, meta, priced, role) {
  for (const adj of adjustments) {
    if (adj.kind === "promotion") continue; // promotion engine not in MVP
    if (adj.scope === "line") {
      const m = meta[adj.lineNo - 1];
      if (m && m.allowDiscount === false) {
        fail("DISCOUNT_NOT_ALLOWED", "Sản phẩm này không cho phép giảm giá.");
      }
    }
    if (role === "cashier") {
      // effective percent of the discount vs its base
      const line = priced.lines[(adj.lineNo || 1) - 1];
      let pct;
      if (adj.kind === "percent") pct = Number(adj.rate) || 0;
      else {
        const base = adj.scope === "line" ? (line ? line.grossAmount : 0) : priced.subtotalAmount - priced.lineDiscountTotal;
        pct = base > 0 ? (100 * (Number(adj.amount) || 0)) / base : 0;
      }
      if (pct > CASHIER_DISCOUNT_LIMIT_PCT) {
        fail("DISCOUNT_NOT_ALLOWED", `Giảm giá vượt trần ${CASHIER_DISCOUNT_LIMIT_PCT}% của thu ngân. Cần quản lý duyệt.`);
      }
    }
  }
}

/** POST /v1/sales/preview — stateless, current prices, all totals from backend. */
export async function preview(merchantId, { items, adjustments = [], role }) {
  return withTransaction(async (client) => {
    const { lineInputs, meta } = await resolveLines(client, merchantId, items);
    const priced = priceCart(lineInputs, adjustments);
    enforceDiscountPolicy(adjustments, meta, priced, role);

    const warnings = [];
    priced.lines.forEach((l, i) => {
      const m = meta[i];
      if (m.trackInventory && m.onHand != null && l.quantity > m.onHand) {
        warnings.push({ code: "LOW_STOCK", lineNo: l.lineNo, productId: m.productId, available: m.onHand });
      }
    });

    return {
      subtotalAmount: priced.subtotalAmount,
      discountAmount: priced.discountAmount,
      totalAmount: priced.totalAmount,
      pricingVersion: pricingVersion(priced, lineInputs),
      lines: priced.lines.map((l, i) => ({ ...l, name: meta[i].name, unitCode: meta[i].unitCode })),
      warnings,
      canCheckout: priced.totalAmount > 0 && warnings.length === 0,
    };
  });
}

async function insertItemsAndAdjustments(client, merchantId, orderId, userId, lineInputs, meta, adjustments, priced) {
  await client.query(`delete from public.order_adjustments where order_id = $1`, [orderId]);
  await client.query(`delete from public.order_items where order_id = $1`, [orderId]);

  const lineNoToItemId = new Map();
  for (let i = 0; i < priced.lines.length; i++) {
    const l = priced.lines[i];
    const m = meta[i];
    const { rows } = await client.query(
      `insert into public.order_items
        (merchant_id, order_id, product_id, line_no, name_snapshot, sku_snapshot,
         unit_code_snapshot, unit_price, quantity, gross_amount, discount_amount, net_amount,
         tax_category_snapshot, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning id`,
      [merchantId, orderId, m.productId, l.lineNo, m.name, m.sku, m.unitCode,
       l.unitPrice, l.quantity, l.grossAmount, l.discountAmount, l.netAmount, m.taxCategory, m.note],
    );
    lineNoToItemId.set(l.lineNo, rows[0].id);
  }

  for (const adj of adjustments) {
    const orderItemId = adj.scope === "line" ? lineNoToItemId.get(adj.lineNo) : null;
    if (adj.scope === "line" && !orderItemId) continue;
    const computed = priced.adjustments.find(
      (a) => a.scope === adj.scope && a.lineNo === adj.lineNo && a.kind === adj.kind,
    );
    await client.query(
      `insert into public.order_adjustments
        (merchant_id, order_id, order_item_id, scope, kind, rate, amount, promotion_id, rule_snapshot, reason_code, note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [merchantId, orderId, orderItemId, adj.scope, adj.kind,
       adj.kind === "percent" ? adj.rate ?? null : null,
       computed ? computed.amount : (adj.amount ?? 0),
       adj.promotionId ?? null, JSON.stringify(adj.ruleSnapshot ?? {}),
       adj.reasonCode ?? null, adj.note ?? null, userId],
    );
  }
}

/** POST /v1/orders — create (or idempotently return) a draft order. */
export async function createOrder(merchantId, userId, role, input) {
  const clientRequestId = input.clientRequestId;
  if (!clientRequestId) fail("VALIDATION", "Thiếu clientRequestId.");

  return withTransaction(async (client) => {
    const existing = await client.query(
      `select id from public.orders where merchant_id = $1 and client_request_id = $2`,
      [merchantId, clientRequestId],
    );
    if (existing.rows.length > 0) {
      return loadFullOrderTx(client, merchantId, existing.rows[0].id);
    }

    const { lineInputs, meta } = await resolveLines(client, merchantId, input.items);
    const priced = priceCart(lineInputs, input.adjustments || []);
    enforceDiscountPolicy(input.adjustments || [], meta, priced, role);

    const ctx = await getMerchantContext(merchantId);
    const note = input.note ? String(input.note).slice(0, 500) : null;

    let orderId;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await client.query(
          `insert into public.orders
             (merchant_id, order_number, client_request_id, cashier_user_id, status,
              version, business_date, subtotal_amount, discount_amount, total_amount, note)
           values ($1,$2,$3,$4,'draft',1,$5,$6,$7,$8,$9)
           returning id`,
          [merchantId, orderNumber(ctx.businessDate), clientRequestId, userId, ctx.businessDate,
           priced.subtotalAmount, priced.discountAmount, priced.totalAmount, note],
        );
        orderId = rows[0].id;
        break;
      } catch (err) {
        if (err?.code === "23505" && /order_number/.test(err.message)) continue; // regenerate
        throw err;
      }
    }
    if (!orderId) fail("INTERNAL", "Không tạo được mã bill.");

    await insertItemsAndAdjustments(client, merchantId, orderId, userId, lineInputs, meta, input.adjustments || [], priced);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "order.create", entityType: "order", entityId: orderId,
      after: { total: priced.totalAmount },
    });
    return loadFullOrderTx(client, merchantId, orderId);
  });
}

/** PATCH /v1/orders/:id — replace cart on a draft, bumping version. */
export async function updateOrder(merchantId, userId, role, orderId, input) {
  return withTransaction(async (client) => {
    const order = await lockOrderRow(client, merchantId, orderId);
    if (order.status !== "draft") fail("ORDER_NOT_PAYABLE", "Chỉ sửa được bill nháp.");
    if (input.expectedVersion != null && order.version !== input.expectedVersion) {
      fail("VERSION_CONFLICT");
    }
    const { lineInputs, meta } = await resolveLines(client, merchantId, input.items);
    const priced = priceCart(lineInputs, input.adjustments || []);
    enforceDiscountPolicy(input.adjustments || [], meta, priced, role);
    const note = input.note !== undefined ? (input.note ? String(input.note).slice(0, 500) : null) : order.note;

    await client.query(
      `update public.orders set subtotal_amount=$1, discount_amount=$2, total_amount=$3,
              note=$4, version=version+1, updated_at=now() where id=$5`,
      [priced.subtotalAmount, priced.discountAmount, priced.totalAmount, note, orderId],
    );
    await insertItemsAndAdjustments(client, merchantId, orderId, userId, lineInputs, meta, input.adjustments || [], priced);
    return loadFullOrderTx(client, merchantId, orderId);
  });
}

/** SELECT ... FOR UPDATE the order row (or ORDER_NOT_FOUND). */
export async function lockOrderRow(client, merchantId, orderId) {
  const { rows } = await client.query(
    `select * from public.orders where id = $1 and merchant_id = $2 for update`,
    [orderId, merchantId],
  );
  if (rows.length === 0) fail("ORDER_NOT_FOUND");
  return rows[0];
}

/**
 * POST /v1/orders/:id/lock — move a draft to awaiting_payment and reserve stock
 * (spec 3.5 CTA). Recomputes from current prices; a changed snapshot → 409
 * PRICE_CHANGED (spec 4.2). Insufficient stock → 409 INSUFFICIENT_STOCK.
 */
export async function lockOrder(merchantId, userId, orderId, expectedVersion) {
  return withTransaction(async (client) => {
    const order = await lockOrderRow(client, merchantId, orderId);
    if (order.status === "awaiting_payment") return loadFullOrderTx(client, merchantId, orderId);
    if (order.status !== "draft") fail("ORDER_NOT_PAYABLE");
    if (expectedVersion != null && order.version !== expectedVersion) fail("VERSION_CONFLICT");

    await assertPricesUnchanged(client, merchantId, orderId);
    await reserveStock(client, merchantId, orderId, userId);

    await client.query(
      `update public.orders set status='awaiting_payment', version=version+1, updated_at=now() where id=$1`,
      [orderId],
    );
    return loadFullOrderTx(client, merchantId, orderId);
  });
}

/** POST /v1/orders/:id/unlock — release reservations, back to draft (spec 3.7 ←). */
export async function unlockOrder(merchantId, orderId, expectedVersion) {
  return withTransaction(async (client) => {
    const order = await lockOrderRow(client, merchantId, orderId);
    if (order.status === "draft") return loadFullOrderTx(client, merchantId, orderId);
    if (order.status !== "awaiting_payment") fail("ORDER_NOT_PAYABLE");
    if (expectedVersion != null && order.version !== expectedVersion) fail("VERSION_CONFLICT");
    // Only unlock if there's no pending payment holding the order.
    const pend = await client.query(
      `select 1 from public.payments where order_id=$1 and status in ('created','pending') limit 1`,
      [orderId],
    );
    if (pend.rows.length > 0) fail("PAYMENT_PENDING");
    await releaseReservations(client, orderId);
    await client.query(
      `update public.orders set status='draft', version=version+1, updated_at=now() where id=$1`,
      [orderId],
    );
    return loadFullOrderTx(client, merchantId, orderId);
  });
}

/** Compare each line's snapshot unit_price to the product's current sale_price. */
export async function assertPricesUnchanged(client, merchantId, orderId) {
  const { rows } = await client.query(
    `select oi.line_no, oi.name_snapshot, oi.unit_price, p.sale_price
       from public.order_items oi
       join public.products p on p.id = oi.product_id
      where oi.order_id = $1 and oi.product_id is not null`,
    [orderId],
  );
  const changed = rows.filter((r) => Number(r.unit_price) !== Number(r.sale_price));
  if (changed.length > 0) {
    fail("PRICE_CHANGED", undefined, {
      lines: changed.map((r) => ({ lineNo: r.line_no, name: r.name_snapshot, was: Number(r.unit_price), now: Number(r.sale_price) })),
    });
  }
}

/** Create/refresh active reservations for tracked items; guard on_hand. */
export async function reserveStock(client, merchantId, orderId, userId) {
  const { rows } = await client.query(
    `select oi.product_id, oi.quantity, oi.name_snapshot, il.on_hand
       from public.order_items oi
       join public.products p on p.id = oi.product_id and p.track_inventory
       join public.inventory_levels il on il.merchant_id = oi.merchant_id and il.product_id = oi.product_id
      where oi.order_id = $1
      order by oi.product_id
      for update of il`,
    [orderId],
  );
  for (const r of rows) {
    if (Number(r.on_hand) < Number(r.quantity)) {
      fail("INSUFFICIENT_STOCK", `Không đủ tồn: ${r.name_snapshot}`, { productId: r.product_id, available: Number(r.on_hand) });
    }
  }
  for (const r of rows) {
    await client.query(
      `insert into public.inventory_reservations (merchant_id, product_id, order_id, quantity, status, expires_at)
       values ($1,$2,$3,$4,'active', now() + ($5 || ' minutes')::interval)
       on conflict (order_id, product_id) where status='active'
       do update set quantity=excluded.quantity, expires_at=excluded.expires_at, updated_at=now()`,
      [merchantId, r.product_id, orderId, r.quantity, String(RESERVATION_TTL_MINUTES)],
    );
  }
}

export async function releaseReservations(client, orderId) {
  await client.query(
    `update public.inventory_reservations set status='released', updated_at=now()
      where order_id=$1 and status='active'`,
    [orderId],
  );
}

// ── Reads ────────────────────────────────────────────────────────────────────
function mapOrderRow(o) {
  return {
    id: o.id,
    merchantId: o.merchant_id,
    orderNumber: o.order_number,
    clientRequestId: o.client_request_id,
    status: o.status,
    version: o.version,
    businessDate: o.business_date instanceof Date ? o.business_date.toISOString().slice(0, 10) : o.business_date,
    subtotalAmount: Number(o.subtotal_amount),
    discountAmount: Number(o.discount_amount),
    totalAmount: Number(o.total_amount),
    note: o.note,
    paidAt: o.paid_at,
    cancelledAt: o.cancelled_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

async function loadFullOrderTx(clientOrPool, merchantId, orderId) {
  const q = (text, params) => clientOrPool.query(text, params);
  const o = await q(`select * from public.orders where id=$1 and merchant_id=$2`, [orderId, merchantId]);
  if (o.rows.length === 0) fail("ORDER_NOT_FOUND");
  const items = await q(
    `select * from public.order_items where order_id=$1 order by line_no`, [orderId]);
  const adj = await q(
    `select * from public.order_adjustments where order_id=$1`, [orderId]);
  const pays = await q(
    `select id, method, status, amount, cash_received, change_due, provider, provider_payment_id,
            provider_transaction_ref, qr_payload, checkout_url, expires_at, paid_at, created_at
       from public.payments where order_id=$1 order by created_at`, [orderId]);
  const returns = await q(
    `select id, return_number, status, reason_code, refund_total, completed_at, created_at
       from public.sales_returns where order_id=$1 order by created_at`, [orderId]);
  return {
    order: mapOrderRow(o.rows[0]),
    items: items.rows.map((r) => ({
      id: r.id, productId: r.product_id, lineNo: r.line_no, name: r.name_snapshot, sku: r.sku_snapshot,
      unitCode: r.unit_code_snapshot, unitPrice: Number(r.unit_price), quantity: Number(r.quantity),
      grossAmount: Number(r.gross_amount), discountAmount: Number(r.discount_amount), netAmount: Number(r.net_amount),
      note: r.note,
    })),
    adjustments: adj.rows.map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, rate: r.rate == null ? null : Number(r.rate),
      amount: Number(r.amount), reasonCode: r.reason_code, orderItemId: r.order_item_id,
    })),
    payments: pays.rows.map((r) => ({
      id: r.id, method: r.method, status: r.status, amount: Number(r.amount),
      cashReceived: r.cash_received == null ? null : Number(r.cash_received),
      changeDue: r.change_due == null ? null : Number(r.change_due),
      provider: r.provider, providerPaymentId: r.provider_payment_id,
      qrPayload: r.qr_payload, checkoutUrl: r.checkout_url, expiresAt: r.expires_at, paidAt: r.paid_at,
    })),
    returns: returns.rows.map((r) => ({
      id: r.id, returnNumber: r.return_number, status: r.status, reasonCode: r.reason_code,
      refundTotal: Number(r.refund_total), completedAt: r.completed_at, createdAt: r.created_at,
    })),
  };
}

export { loadFullOrderTx };

/** GET /v1/orders/:id — full bill detail. */
export async function getOrder(merchantId, orderId) {
  const { getPool } = await import("../db/pool.js");
  return loadFullOrderTx(getPool(), merchantId, orderId);
}

/** GET /v1/merchants/:id/orders — bill list with day/status filters (spec 3.11). */
export async function listOrders(merchantId, { businessDate, status, limit = 50 } = {}) {
  const params = [merchantId];
  let where = "merchant_id = $1";
  if (businessDate) {
    params.push(businessDate);
    where += ` and business_date = $${params.length}`;
  }
  if (status) {
    params.push(status);
    where += ` and status = $${params.length}`;
  } else {
    where += ` and status <> 'draft'`; // the bill list shows real bills, not drafts
  }
  params.push(Math.min(200, Number(limit) || 50));
  const { rows } = await query(
    `select o.*, (select count(*) from public.order_items oi where oi.order_id=o.id) as item_count,
            (select method from public.payments p where p.order_id=o.id and p.status='succeeded' limit 1) as paid_method
       from public.orders o
      where ${where}
      order by o.created_at desc
      limit $${params.length}`,
    params,
  );
  return rows.map((o) => ({ ...mapOrderRow(o), itemCount: Number(o.item_count), paidMethod: o.paid_method }));
}

/** GET active draft for a cashier (resume, FR-01). */
export async function getActiveDraft(merchantId, userId) {
  const { rows } = await query(
    `select id from public.orders
      where merchant_id=$1 and cashier_user_id=$2 and status='draft'
      order by updated_at desc limit 1`,
    [merchantId, userId],
  );
  if (rows.length === 0) return { order: null };
  const { getPool } = await import("../db/pool.js");
  return loadFullOrderTx(getPool(), merchantId, rows[0].id);
}

/**
 * GET the cashier's outstanding awaiting_payment bill, if any (hotfix guard).
 * Used by the POS "Tiếp tục thanh toán" flow to detect a still-unpaid locked
 * bill BEFORE creating a new one, so we never silently reuse it. Scoped to the
 * caller (merchant + cashier). `excludeOrderId` skips the current live order.
 */
export async function getOutstandingBill(merchantId, userId, excludeOrderId) {
  const params = [merchantId, userId];
  let where = `merchant_id=$1 and cashier_user_id=$2 and status='awaiting_payment'`;
  if (excludeOrderId) { params.push(excludeOrderId); where += ` and id <> $${params.length}`; }
  const { rows } = await query(
    `select id from public.orders where ${where} order by created_at desc limit 1`,
    params,
  );
  if (rows.length === 0) return { order: null };
  const { getPool } = await import("../db/pool.js");
  return loadFullOrderTx(getPool(), merchantId, rows[0].id);
}

/** Cancel a draft/awaiting bill (spec 2.1 cancelled). */
export async function cancelOrder(merchantId, userId, orderId, expectedVersion) {
  return withTransaction(async (client) => {
    const order = await lockOrderRow(client, merchantId, orderId);
    if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
      fail("ORDER_NOT_PAYABLE", "Bill đã thanh toán, không thể hủy.");
    }
    if (order.status === "cancelled") return loadFullOrderTx(client, merchantId, orderId);
    if (expectedVersion != null && order.version !== expectedVersion) fail("VERSION_CONFLICT");
    await releaseReservations(client, orderId);
    await client.query(
      `update public.orders set status='cancelled', cancelled_at=now(), version=version+1, updated_at=now() where id=$1`,
      [orderId],
    );
    await writeAudit(client, { merchantId, actorUserId: userId, action: "order.cancel", entityType: "order", entityId: orderId, before: { status: order.status } });
    return loadFullOrderTx(client, merchantId, orderId);
  });
}

export { CASHIER_DISCOUNT_LIMIT_PCT, RESERVATION_TTL_MINUTES };
