// Trả hàng / hoàn tiền (spec 6). Returns never delete or edit the original paid
// bill; they create reversing documents with condition, reason, actor and audit
// (FR-13). Money only leaves net revenue when a refund is 'succeeded': cash is
// succeeded immediately; bank_transfer is 'pending' until confirmed (RET-03).
//
// IMPORTANT dashboard-compat note: the deployed F2 get_today_dashboard RPC counts
// gross for orders with status in ('paid','refunded') ONLY — NOT
// 'partially_refunded'. So a partially-refunded bill is kept at status='paid'
// (still in gross; the succeeded refund is subtracted separately) and only a
// FULLY-returned bill is set to 'refunded'. This keeps gross/refund/net
// reconciliation exact (spec MET-06/07) without a schema/RPC change.
import { getPool, withTransaction } from "../db/pool.js";
import { fail } from "./errors.js";
import { allocateLineRefund } from "./pricing.js";
import { returnNumber } from "./numbering.js";
import { writeAudit, enqueueOutbox } from "./audit.js";
import { getMerchantContext } from "./sales.js";

/** Load the paid order + its succeeded payment, or fail. */
async function loadPaidOrder(client, merchantId, orderId) {
  const o = await client.query(
    `select * from public.orders where id=$1 and merchant_id=$2 for update`,
    [orderId, merchantId],
  );
  if (o.rows.length === 0) fail("ORDER_NOT_FOUND");
  const order = o.rows[0];
  if (!["paid", "partially_refunded", "refunded"].includes(order.status)) {
    fail("ORDER_NOT_PAYABLE", "Chỉ trả hàng cho bill đã thanh toán.");
  }
  const pay = await client.query(
    `select id, amount from public.payments where order_id=$1 and status='succeeded' limit 1`,
    [orderId],
  );
  if (pay.rows.length === 0) fail("ORDER_NOT_PAYABLE", "Bill chưa có thanh toán thành công.");
  return { order, payment: pay.rows[0] };
}

/** Prior returned qty per order_item across non-cancelled returns. */
async function priorReturnedQty(client, orderId) {
  const { rows } = await client.query(
    `select sri.order_item_id, coalesce(sum(sri.quantity),0) as qty
       from public.sales_return_items sri
       join public.sales_returns sr on sr.id = sri.return_id
      where sr.order_id=$1 and sr.status in ('pending','completed')
      group by sri.order_item_id`,
    [orderId],
  );
  const m = new Map();
  for (const r of rows) m.set(r.order_item_id, Number(r.qty));
  return m;
}

async function existingRefundSum(client, orderId) {
  const { rows } = await client.query(
    `select coalesce(sum(amount),0) as s from public.payment_refunds
      where order_id=$1 and status in ('pending','succeeded')`,
    [orderId],
  );
  return Number(rows[0].s);
}

/** Compute refundable amount per requested return item (pure allocation). */
async function computeReturnLines(client, orderId, requestItems) {
  const itemsRes = await client.query(
    `select id, product_id, name_snapshot, quantity, net_amount from public.order_items where order_id=$1`,
    [orderId],
  );
  const byId = new Map(itemsRes.rows.map((r) => [r.id, r]));
  const prior = await priorReturnedQty(client, orderId);

  const lines = [];
  for (const req of requestItems) {
    const oi = byId.get(req.orderItemId);
    if (!oi) fail("VALIDATION", "Dòng hàng không thuộc bill này.");
    const soldQty = Number(oi.quantity);
    const priorQty = prior.get(oi.id) || 0;
    const returnQty = Number(req.quantity);
    if (!(returnQty > 0)) fail("VALIDATION", "Số lượng trả phải > 0.");
    if (priorQty + returnQty > soldQty + 1e-9) {
      fail("REFUND_EXCEEDS_AVAILABLE", `Số lượng trả vượt số đã bán (${oi.name_snapshot}).`);
    }
    const refundAmount = allocateLineRefund({
      netAmount: Number(oi.net_amount), originalQty: soldQty, priorReturnedQty: priorQty, returnQty,
    });
    lines.push({
      orderItemId: oi.id, productId: oi.product_id, name: oi.name_snapshot,
      quantity: returnQty, refundAmount, condition: req.condition || "restockable",
      priorQty, soldQty,
    });
  }
  const refundTotal = lines.reduce((a, l) => a + l.refundAmount, 0);
  return { lines, refundTotal };
}

/** POST /v1/orders/:id/returns/preview — refundable amount (spec 11). */
export async function returnsPreview(merchantId, orderId, requestItems) {
  return withTransaction(async (client) => {
    const { payment } = await loadPaidOrder(client, merchantId, orderId);
    const { lines, refundTotal } = await computeReturnLines(client, orderId, requestItems);
    const already = await existingRefundSum(client, orderId);
    const maxRefundable = Number(payment.amount) - already;
    return {
      lines: lines.map((l) => ({ orderItemId: l.orderItemId, name: l.name, quantity: l.quantity, refundAmount: l.refundAmount, condition: l.condition })),
      refundTotal,
      maxRefundable,
      canRefund: refundTotal <= maxRefundable && refundTotal > 0,
    };
  });
}

/** Apply inventory effects of a return (spec 6.1). */
async function applyReturnInventory(client, merchantId, lines, returnId, userId) {
  // group by product to lock levels once
  const byProduct = new Map();
  for (const l of lines) {
    if (!l.productId) continue; // manual line, no inventory
    if (!byProduct.has(l.productId)) byProduct.set(l.productId, []);
    byProduct.get(l.productId).push(l);
  }
  const productIds = [...byProduct.keys()].sort();
  for (const pid of productIds) {
    // only tracked products have a level row
    const lvl = await client.query(
      `select il.on_hand from public.inventory_levels il
         join public.products p on p.id = il.product_id and p.track_inventory
        where il.merchant_id=$1 and il.product_id=$2 for update`,
      [merchantId, pid],
    );
    if (lvl.rows.length === 0) continue; // not inventory-tracked
    let balance = Number(lvl.rows[0].on_hand);
    for (const l of byProduct.get(pid)) {
      if (l.condition === "restockable") {
        balance = Math.round((balance + Number(l.quantity)) * 1000) / 1000;
        await client.query(
          `insert into public.inventory_movements
             (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by)
           values ($1,$2,'sale_return',$3,$4,'return_item',$5,$6)
           on conflict (product_id, movement_type, reference_type, reference_id) do nothing`,
          [merchantId, pid, Number(l.quantity), balance, l.returnItemId, userId],
        );
      } else {
        // damaged/expired/other: goods returned then written off — net on_hand
        // unchanged, two honest ledger movements (spec 6.1 "không tăng on_hand").
        const up = Math.round((balance + Number(l.quantity)) * 1000) / 1000;
        await client.query(
          `insert into public.inventory_movements
             (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by)
           values ($1,$2,'sale_return',$3,$4,'return_item',$5,$6)
           on conflict (product_id, movement_type, reference_type, reference_id) do nothing`,
          [merchantId, pid, Number(l.quantity), up, l.returnItemId, userId],
        );
        await client.query(
          `insert into public.inventory_movements
             (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by)
           values ($1,$2,'damage_writeoff',$3,$4,'return_item',$5,$6)
           on conflict (product_id, movement_type, reference_type, reference_id) do nothing`,
          [merchantId, pid, -Number(l.quantity), balance, l.returnItemId, userId],
        );
        // balance stays unchanged
      }
    }
    await client.query(
      `update public.inventory_levels set on_hand=$1, row_version=row_version+1, updated_at=now() where merchant_id=$2 and product_id=$3`,
      [balance, merchantId, pid],
    );
  }
}

/** Is every sold unit of this order now returned? (drives 'refunded' status). */
async function isFullyReturned(client, orderId) {
  const { rows } = await client.query(
    `select oi.id, oi.quantity,
            coalesce((select sum(sri.quantity) from public.sales_return_items sri
                        join public.sales_returns sr on sr.id=sri.return_id
                       where sri.order_item_id=oi.id and sr.status in ('pending','completed')),0) as returned
       from public.order_items oi where oi.order_id=$1`,
    [orderId],
  );
  if (rows.length === 0) return false;
  return rows.every((r) => Number(r.returned) >= Number(r.quantity) - 1e-9);
}

/**
 * POST /v1/orders/:id/returns — create a return + refund in ONE transaction
 * (spec §8.1). Cash refund → succeeded immediately; bank_transfer → pending
 * (revenue unaffected until confirm). Inventory is applied at return time.
 */
export async function createReturn(merchantId, userId, orderId, input, idempotencyKey) {
  if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const method = input.refundMethod === "bank_transfer" ? "bank_transfer" : "cash";
  const reasonCode = String(input.reasonCode || "customer_change").slice(0, 64);

  return withTransaction(async (client) => {
    // idempotent replay
    const replay = await client.query(
      `select id, return_id, status, amount from public.payment_refunds where merchant_id=$1 and idempotency_key=$2`,
      [merchantId, idempotencyKey],
    );
    if (replay.rows.length > 0) {
      const r = replay.rows[0];
      return { refundId: r.id, returnId: r.return_id, refundStatus: r.status, refundAmount: Number(r.amount), idempotentReplay: true };
    }

    const { order, payment } = await loadPaidOrder(client, merchantId, orderId);
    const { lines, refundTotal } = await computeReturnLines(client, orderId, input.items || []);
    if (!(refundTotal > 0)) fail("VALIDATION", "Chưa chọn hàng để trả.");

    const already = await existingRefundSum(client, orderId);
    if (refundTotal + already > Number(payment.amount) + 1e-9) {
      fail("REFUND_EXCEEDS_AVAILABLE");
    }

    const ctx = await getMerchantContext(merchantId);
    const refundSucceeded = method === "cash";
    const returnStatus = refundSucceeded ? "completed" : "pending";

    // sales_returns
    let returnRow;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await client.query(
          `insert into public.sales_returns
             (merchant_id, order_id, return_number, status, reason_code, note, refund_total, created_by, completed_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, return_number`,
          [merchantId, orderId, returnNumber(ctx.businessDate), returnStatus, reasonCode,
           input.note ?? null, refundTotal, userId, refundSucceeded ? new Date().toISOString() : null],
        );
        returnRow = rows[0];
        break;
      } catch (err) {
        if (err?.code === "23505" && /return_number/.test(err.message)) continue;
        throw err;
      }
    }
    if (!returnRow) fail("INTERNAL", "Không tạo được mã trả hàng.");

    // sales_return_items
    for (const l of lines) {
      const { rows } = await client.query(
        `insert into public.sales_return_items (merchant_id, return_id, order_item_id, quantity, condition, refund_amount)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [merchantId, returnRow.id, l.orderItemId, l.quantity, l.condition, l.refundAmount],
      );
      l.returnItemId = rows[0].id;
    }

    // inventory
    await applyReturnInventory(client, merchantId, lines, returnRow.id, userId);

    // refund
    const { rows: refRows } = await client.query(
      `insert into public.payment_refunds
         (merchant_id, payment_id, order_id, return_id, idempotency_key, method, status, amount, reason_code, note, refunded_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, status`,
      [merchantId, payment.id, orderId, returnRow.id, idempotencyKey, method,
       refundSucceeded ? "succeeded" : "pending", refundTotal, reasonCode, input.note ?? null,
       refundSucceeded ? new Date().toISOString() : null],
    );
    const refund = refRows[0];

    // order status: only when the refund succeeded AND fully returned → 'refunded'
    if (refundSucceeded && (await isFullyReturned(client, orderId))) {
      await client.query(`update public.orders set status='refunded', updated_at=now() where id=$1`, [orderId]);
    }

    await enqueueOutbox(client, { merchantId, eventType: "order.returned", aggregateId: orderId, payload: { orderId, returnId: returnRow.id, refundId: refund.id, refundTotal, method } });
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "return.create", entityType: "order", entityId: orderId,
      before: { status: order.status }, after: { returnId: returnRow.id, refundTotal, method, refundStatus: refund.status },
    });

    return {
      returnId: returnRow.id, returnNumber: returnRow.return_number, refundId: refund.id,
      refundStatus: refund.status, refundAmount: refundTotal, method,
      lines: lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity, refundAmount: l.refundAmount, condition: l.condition })),
    };
  });
}

/**
 * POST /v1/refunds/:id/confirm — mark a pending bank_transfer refund succeeded
 * (spec 3.12 "Xác nhận đã hoàn tiền"). Only now does net revenue drop (RET-03).
 */
export async function confirmRefund(merchantId, userId, refundId, reference) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.payment_refunds where id=$1 and merchant_id=$2 for update`,
      [refundId, merchantId],
    );
    if (rows.length === 0) fail("NOT_FOUND", "Không tìm thấy khoản hoàn.");
    const r = rows[0];
    if (r.status === "succeeded") {
      return { refundId, status: "succeeded", orderId: r.order_id, idempotentReplay: true };
    }
    if (r.status !== "pending") fail("VALIDATION", "Khoản hoàn không ở trạng thái chờ.");

    await client.query(
      `update public.payment_refunds set status='succeeded', refunded_at=now(), provider_refund_ref=$2 where id=$1`,
      [refundId, reference ? String(reference).slice(0, 120) : null],
    );
    if (r.return_id) {
      await client.query(`update public.sales_returns set status='completed', completed_at=now() where id=$1`, [r.return_id]);
    }
    if (await isFullyReturned(client, r.order_id)) {
      await client.query(`update public.orders set status='refunded', updated_at=now() where id=$1`, [r.order_id]);
    }
    await enqueueOutbox(client, { merchantId, eventType: "refund.succeeded", aggregateId: r.order_id, payload: { refundId, orderId: r.order_id, amount: Number(r.amount) } });
    await writeAudit(client, { merchantId, actorUserId: userId, action: "refund.confirm", entityType: "refund", entityId: refundId, after: { reference, amount: Number(r.amount) } });
    return { refundId, status: "succeeded", orderId: r.order_id, amount: Number(r.amount) };
  });
}

/** List returns/refunds for an order (bill detail). */
export async function listReturns(merchantId, orderId) {
  const pool = getPool();
  const returns = await pool.query(
    `select sr.*, (select json_agg(json_build_object(
         'orderItemId', sri.order_item_id, 'quantity', sri.quantity,
         'condition', sri.condition, 'refundAmount', sri.refund_amount))
       from public.sales_return_items sri where sri.return_id=sr.id) as items,
       (select json_agg(json_build_object('id', pr.id, 'method', pr.method, 'status', pr.status, 'amount', pr.amount))
          from public.payment_refunds pr where pr.return_id=sr.id) as refunds
       from public.sales_returns sr where sr.merchant_id=$1 and sr.order_id=$2 order by sr.created_at`,
    [merchantId, orderId],
  );
  return returns.rows.map((r) => ({
    id: r.id, returnNumber: r.return_number, status: r.status, reasonCode: r.reason_code,
    refundTotal: Number(r.refund_total), completedAt: r.completed_at, createdAt: r.created_at,
    items: r.items || [], refunds: r.refunds || [],
  }));
}
