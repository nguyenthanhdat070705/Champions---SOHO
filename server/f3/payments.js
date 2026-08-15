// Payment finalization — the heart of Functional 03. Every money path runs in a
// single Postgres transaction (spec §8.1): cash finalize and QR-webhook confirm
// each atomically move payment→succeeded + order→paid + inventory movements +
// levels + reservations + receipt + outbox + audit. Idempotency keys and the
// one_successful_payment_per_order index guarantee no double charge (FR-08).
import { getPool, withTransaction } from "../db/pool.js";
import { DomainError, fail, mapPgError } from "./errors.js";
import { writeAudit, enqueueOutbox } from "./audit.js";
import { ensureReceipt } from "./receipts.js";
import { getMerchantContext, lockOrderRow, assertPricesUnchanged } from "./sales.js";
import { createQrRequest, generateOrderCode, getQrRequest, cancelQrRequest } from "./payos.js";
import { generateSuggestionsForOrder } from "./suggestions.js";

const QR_TTL_SECONDS = 10 * 60;

/**
 * Decrement inventory for every tracked line of a paid order and write the
 * immutable sale movements (FR-11), locking each product's level row FOR UPDATE
 * in product-id order to serialize concurrent sales and avoid deadlock/oversell
 * (INV-01). Throws INSUFFICIENT_STOCK if any product can't cover its quantity.
 */
async function applySaleInventory(client, merchantId, orderId, userId) {
  const { rows } = await client.query(
    `select oi.id as item_id, oi.product_id, oi.quantity, oi.name_snapshot
       from public.order_items oi
       join public.products p on p.id = oi.product_id and p.track_inventory
      where oi.order_id = $1
      order by oi.product_id, oi.line_no`,
    [orderId],
  );
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const productIds = [...byProduct.keys()].sort();
  for (const pid of productIds) {
    const lvl = await client.query(
      `select on_hand from public.inventory_levels
        where merchant_id=$1 and product_id=$2 for update`,
      [merchantId, pid],
    );
    let balance = lvl.rows.length ? Number(lvl.rows[0].on_hand) : 0;
    const lines = byProduct.get(pid);
    const totalQty = lines.reduce((a, l) => a + Number(l.quantity), 0);
    if (balance < totalQty) {
      fail("INSUFFICIENT_STOCK", `Không đủ tồn: ${lines[0].name_snapshot}`, { productId: pid, available: balance });
    }
    for (const l of lines) {
      balance = Math.round((balance - Number(l.quantity)) * 1000) / 1000;
      await client.query(
        `insert into public.inventory_movements
           (merchant_id, product_id, movement_type, quantity_delta, balance_after, reference_type, reference_id, created_by)
         values ($1,$2,'sale',$3,$4,'order_item',$5,$6)
         on conflict (product_id, movement_type, reference_type, reference_id) do nothing`,
        [merchantId, pid, -Number(l.quantity), balance, l.item_id, userId],
      );
    }
    await client.query(
      `update public.inventory_levels set on_hand=$1, row_version=row_version+1, updated_at=now()
        where merchant_id=$2 and product_id=$3`,
      [balance, merchantId, pid],
    );
  }
}

/** Mark reservations consumed once the sale movements are written. */
async function consumeReservations(client, orderId) {
  await client.query(
    `update public.inventory_reservations set status='consumed', updated_at=now()
      where order_id=$1 and status='active'`,
    [orderId],
  );
}

/**
 * POST /v1/payments/cash — finalize a cash sale in ONE transaction (spec 5.1).
 * Idempotent on (merchant, Idempotency-Key): a replay returns the same payment
 * without a second charge or movement (SALE-03).
 */
export async function finalizeCash(merchantId, userId, { orderId, expectedVersion, cashReceived }, idempotencyKey) {
  if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  try {
    return await runFinalizeCash();
  } catch (err) {
    // Concurrency: two same-key requests race past the idempotency SELECT and
    // both try to insert. The loser's unique-violation rolls back; re-read the
    // winner's committed payment and return it as the idempotent replay (SALE-03).
    if (err?.code === "23505" && /idempotency/.test(String(err.message))) {
      const { rows } = await getPool().query(
        `select id, order_id, status, change_due from public.payments where merchant_id=$1 and idempotency_key=$2`,
        [merchantId, idempotencyKey],
      );
      if (rows.length > 0) {
        const p = rows[0];
        return { orderId: p.order_id, paymentId: p.id, status: p.status, changeDue: Number(p.change_due ?? 0), idempotentReplay: true };
      }
    }
    throw err instanceof DomainError ? err : mapPgError(err);
  } finally {
    // Post-paid AI suggestions never block the payment (FR-15).
    generateSuggestionsForOrder(merchantId, orderId).catch(() => {});
  }

  async function runFinalizeCash() {
    return await withTransaction(async (client) => {
      const replayRow = async () => {
        const r = await client.query(
          `select id, order_id, status, change_due from public.payments
            where merchant_id=$1 and idempotency_key=$2`,
          [merchantId, idempotencyKey],
        );
        if (r.rows.length === 0) return null;
        const p = r.rows[0];
        return { orderId: p.order_id, paymentId: p.id, status: p.status, changeDue: Number(p.change_due ?? 0), idempotentReplay: true };
      };

      // 1) Fast-path idempotent replay.
      const early = await replayRow();
      if (early) return early;

      // 2) Lock the order. A concurrent same-key request may have been holding
      // this lock and committed while we waited (double-tap, SALE-03), so re-run
      // the idempotency lookup now that we're serialized behind that commit —
      // returning the SAME payment instead of a spurious ALREADY_SUCCEEDED.
      const order = await lockOrderRow(client, merchantId, orderId);
      const afterLock = await replayRow();
      if (afterLock) return afterLock;

      if (order.status === "paid" || order.status === "partially_refunded" || order.status === "refunded") {
        fail("PAYMENT_ALREADY_SUCCEEDED");
      }
      if (!["draft", "awaiting_payment"].includes(order.status)) fail("ORDER_NOT_PAYABLE");
      if (expectedVersion != null && order.version !== expectedVersion) fail("VERSION_CONFLICT");

      // 3) Recompute price snapshot; reject stale prices (SALE-04).
      await assertPricesUnchanged(client, merchantId, orderId);

      const total = Number(order.total_amount);
      const received = Math.trunc(Number(cashReceived));
      if (!(total > 0)) fail("INVALID_CASH_AMOUNT", "Tổng thanh toán phải lớn hơn 0.");
      if (!(received >= total)) fail("INVALID_CASH_AMOUNT", "Tiền khách đưa phải ≥ tổng thanh toán.");

      // 4) Inventory movements + levels.
      await applySaleInventory(client, merchantId, orderId, userId);

      // 5) Payment succeeded.
      const changeDue = received - total;
      let payment;
      try {
        const { rows } = await client.query(
          `insert into public.payments
             (merchant_id, order_id, idempotency_key, method, status, amount, cash_received, change_due, paid_at)
           values ($1,$2,$3,'cash','succeeded',$4,$5,$6,now())
           returning id, change_due`,
          [merchantId, orderId, idempotencyKey, total, received, changeDue],
        );
        payment = rows[0];
      } catch (err) {
        // Rethrow raw so the outer handler can distinguish an idempotency-key
        // race (→ replay) from an order already paid via a different key
        // (→ PAYMENT_ALREADY_SUCCEEDED). mapPgError handles the latter.
        throw err;
      }

      // 6) Order paid + reservations + receipt + outbox + audit.
      await client.query(
        `update public.orders set status='paid', paid_at=now(), version=version+1, updated_at=now() where id=$1`,
        [orderId],
      );
      await consumeReservations(client, orderId);
      const ctx = await getMerchantContext(merchantId);
      const receipt = await ensureReceipt(client, merchantId, orderId, ctx.receiptPrefix, ctx.businessDate);
      await enqueueOutbox(client, { merchantId, eventType: "order.paid", aggregateId: orderId, payload: { orderId, paymentId: payment.id, method: "cash" } });
      await writeAudit(client, { merchantId, actorUserId: userId, action: "payment.cash.succeeded", entityType: "order", entityId: orderId, after: { total, received, changeDue } });

      return { orderId, paymentId: payment.id, status: "succeeded", changeDue: Number(payment.change_due), receiptId: receipt?.id ?? null };
    });
  }
}

/**
 * POST /v1/payments/qr — create a dynamic QR payment attempt (spec 5.2). Reserves
 * stock, creates the PayOS request, and returns pending payment data. The bill is
 * NOT paid here — only a verified webhook (or reconcile) does that.
 */
export async function createQrPayment(merchantId, userId, { orderId, expectedVersion }, idempotencyKey) {
  if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED");

  const ctx = await getMerchantContext(merchantId);
  if (!ctx.allowQr) fail("QR_CONNECTION_UNAVAILABLE", "Cửa hàng chưa bật thanh toán QR.");
  if (!process.env.PAYOS_CLIENT_ID?.trim() || !process.env.PAYOS_CHECKSUM_KEY?.trim()) {
    fail("QR_CONNECTION_UNAVAILABLE");
  }

  // Phase 1: reserve + create the internal payment row (created), commit.
  const prepared = await withTransaction(async (client) => {
    const replay = await client.query(
      `select id, order_id, status, amount, qr_payload, checkout_url, provider_payment_id, expires_at
         from public.payments where merchant_id=$1 and idempotency_key=$2`,
      [merchantId, idempotencyKey],
    );
    if (replay.rows.length > 0) return { replay: replay.rows[0] };

    const order = await lockOrderRow(client, merchantId, orderId);
    if (order.status === "paid") fail("PAYMENT_ALREADY_SUCCEEDED");
    if (!["draft", "awaiting_payment"].includes(order.status)) fail("ORDER_NOT_PAYABLE");
    if (expectedVersion != null && order.version !== expectedVersion) fail("VERSION_CONFLICT");
    await assertPricesUnchanged(client, merchantId, orderId);

    // A different pending QR already holds this order.
    const pending = await client.query(
      `select id, idempotency_key from public.payments
        where order_id=$1 and method='qr' and status in ('created','pending')`,
      [orderId],
    );
    if (pending.rows.length > 0 && pending.rows[0].idempotency_key !== idempotencyKey) {
      fail("PAYMENT_PENDING");
    }

    const total = Number(order.total_amount);
    if (!(total > 0)) fail("VALIDATION", "Tổng thanh toán phải lớn hơn 0.");

    // reserve stock (reuse sales helper semantics inline)
    const { reserveStock } = await import("./sales.js");
    await reserveStock(client, merchantId, orderId, userId);
    await client.query(
      `update public.orders set status='awaiting_payment', updated_at=now() where id=$1 and status='draft'`,
      [orderId],
    );

    const { rows } = await client.query(
      `insert into public.payments (merchant_id, order_id, idempotency_key, method, status, amount, provider)
       values ($1,$2,$3,'qr','created',$4,'payos') returning id`,
      [merchantId, orderId, idempotencyKey, total],
    );
    return { paymentId: rows[0].id, orderId, amount: total };
  });

  if (prepared.replay) {
    const r = prepared.replay;
    return { paymentId: r.id, orderId: r.order_id, status: r.status, amount: Number(r.amount), qrPayload: r.qr_payload, checkoutUrl: r.checkout_url, providerPaymentId: r.provider_payment_id, expiresAt: r.expires_at };
  }

  // Phase 2: call PayOS (outside the txn), then persist provider fields.
  const orderCode = generateOrderCode();
  const expiredAtUnix = Math.floor(Date.now() / 1000) + QR_TTL_SECONDS;
  let provider;
  try {
    provider = await createQrRequest({
      orderCode,
      amount: prepared.amount,
      description: `DH${String(orderCode).slice(-7)}`,
      expiredAtUnix,
    });
  } catch (err) {
    // Provider failed: fail the attempt, release the hold, revert to draft.
    await withTransaction(async (client) => {
      await client.query(`update public.payments set status='failed', updated_at=now() where id=$1`, [prepared.paymentId]);
      const { releaseReservations } = await import("./sales.js");
      await releaseReservations(client, prepared.orderId);
      await client.query(`update public.orders set status='draft', updated_at=now() where id=$1 and status='awaiting_payment'`, [prepared.orderId]);
    });
    throw err instanceof DomainError ? err : new DomainError("PROVIDER_ERROR");
  }

  const persisted = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `update public.payments
          set status='pending', provider_payment_id=$1, qr_payload=$2, checkout_url=$3,
              expires_at=to_timestamp($4), updated_at=now()
        where id=$5
        returning id, order_id, status, amount, qr_payload, checkout_url, provider_payment_id, expires_at`,
      [provider.paymentLinkId, provider.qrCode, provider.checkoutUrl, expiredAtUnix, prepared.paymentId],
    );
    await writeAudit(client, { merchantId, actorUserId: userId, action: "payment.qr.created", entityType: "order", entityId: prepared.orderId, after: { paymentLinkId: provider.paymentLinkId, amount: prepared.amount } });
    return rows[0];
  });

  return {
    paymentId: persisted.id, orderId: persisted.order_id, status: persisted.status,
    amount: Number(persisted.amount), qrPayload: persisted.qr_payload, checkoutUrl: persisted.checkout_url,
    providerPaymentId: persisted.provider_payment_id, expiresAt: persisted.expires_at,
    accountName: provider.accountName, accountMasked: provider.accountNumber ? "****" + String(provider.accountNumber).slice(-4) : null,
  };
}

/** GET /v1/payments/:id — canonical status, with optional provider reconcile. */
export async function getPaymentStatus(merchantId, paymentId, { reconcile = false } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `select id, order_id, method, status, amount, cash_received, change_due, provider,
            provider_payment_id, provider_transaction_ref, qr_payload, checkout_url, expires_at, paid_at
       from public.payments where id=$1 and merchant_id=$2`,
    [paymentId, merchantId],
  );
  if (rows.length === 0) fail("PAYMENT_NOT_FOUND");
  let p = rows[0];

  // Expire a stale pending QR (spec 5.3 expired).
  if (p.status === "pending" && p.expires_at && new Date(p.expires_at).getTime() < Date.now()) {
    await withTransaction(async (client) => {
      const cur = await client.query(`select status from public.payments where id=$1 for update`, [paymentId]);
      if (cur.rows[0]?.status === "pending") {
        await client.query(`update public.payments set status='expired', updated_at=now() where id=$1`, [paymentId]);
        const { releaseReservations } = await import("./sales.js");
        await releaseReservations(client, p.order_id);
        await client.query(`update public.orders set status='draft', updated_at=now() where id=$1 and status='awaiting_payment'`, [p.order_id]);
      }
    });
    p = { ...p, status: "expired" };
  }

  // Server-to-server reconcile ("Đã chuyển khoản"): never trusts the client.
  if (reconcile && p.status === "pending" && p.provider_payment_id) {
    try {
      const prov = await getQrRequest(p.provider_payment_id);
      if (prov && String(prov.status).toUpperCase() === "PAID") {
        const result = await confirmQrPayment({
          provider: "payos", paymentLinkId: p.provider_payment_id, amount: Number(p.amount),
          reference: prov.transactions?.[0]?.reference || `reconcile-${paymentId}`,
          eventType: "payment.paid.reconcile", signatureValid: true,
        });
        if (result.status === "succeeded") p = { ...p, status: "succeeded", paid_at: new Date().toISOString() };
      }
    } catch {
      // reconcile is best-effort; canonical DB status still returned
    }
  }

  return {
    paymentId: p.id, orderId: p.order_id, method: p.method, status: p.status, amount: Number(p.amount),
    changeDue: p.change_due == null ? null : Number(p.change_due),
    qrPayload: p.qr_payload, checkoutUrl: p.checkout_url, expiresAt: p.expires_at, paidAt: p.paid_at,
  };
}

/**
 * POST /v1/payments/:id/cancel — cancel a still-pending QR (spec 5.3 / QR-04).
 * If a webhook already marked it succeeded, paid wins → PAYMENT_ALREADY_SUCCEEDED.
 */
export async function cancelPayment(merchantId, userId, paymentId, reason) {
  // Try provider cancel first (best-effort), but the DB row is canonical.
  const pre = await getPool().query(
    `select provider_payment_id, status from public.payments where id=$1 and merchant_id=$2`,
    [paymentId, merchantId],
  );
  if (pre.rows.length === 0) fail("PAYMENT_NOT_FOUND");
  if (pre.rows[0].status === "pending" && pre.rows[0].provider_payment_id) {
    await cancelQrRequest(pre.rows[0].provider_payment_id, reason || "user_cancel");
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.payments where id=$1 and merchant_id=$2 for update`,
      [paymentId, merchantId],
    );
    if (rows.length === 0) fail("PAYMENT_NOT_FOUND");
    const p = rows[0];
    if (p.status === "succeeded") fail("PAYMENT_ALREADY_SUCCEEDED");
    if (["cancelled", "expired", "failed"].includes(p.status)) {
      return { paymentId, status: p.status, orderId: p.order_id };
    }
    await client.query(`update public.payments set status='cancelled', updated_at=now() where id=$1`, [paymentId]);
    const { releaseReservations } = await import("./sales.js");
    await releaseReservations(client, p.order_id);
    await client.query(
      `update public.orders set status='draft', version=version+1, updated_at=now()
        where id=$1 and status='awaiting_payment'`,
      [p.order_id],
    );
    await writeAudit(client, { merchantId, actorUserId: userId, action: "payment.qr.cancelled", entityType: "payment", entityId: paymentId, before: { status: p.status } });
    return { paymentId, status: "cancelled", orderId: p.order_id };
  });
}

/**
 * Confirm a QR payment from a verified provider event (webhook or dev-simulate or
 * reconcile). Idempotent: duplicate events (QR-03) record once and never create a
 * second movement; a cancelled/expired row is not resurrected (cancel won the
 * lock — QR-04, no double charge). Amount mismatch → recorded, not paid (QR-02).
 * `created_by` for confirm-time movements is the order's original cashier.
 */
export async function confirmQrPayment(event) {
  const { paymentLinkId, amount, reference, eventType = "payment.paid", signatureValid = true, provider = "payos" } = event;
  const pool = getPool();

  // Locate the payment by provider link id.
  const found = await pool.query(
    `select p.*, o.cashier_user_id from public.payments p
       join public.orders o on o.id = p.order_id
      where p.provider = $1 and p.provider_payment_id = $2`,
    [provider, String(paymentLinkId)],
  );
  if (found.rows.length === 0) {
    return { handled: false, reason: "payment_not_found" };
  }
  const payment0 = found.rows[0];
  const merchantId = payment0.merchant_id;
  const orderId = payment0.order_id;
  const cashier = payment0.cashier_user_id;

  try {
    return await withTransaction(async (client) => {
      // Record the provider event (idempotent on provider_event_id = reference).
      const evt = await client.query(
        `insert into public.payment_provider_events
           (merchant_id, payment_id, provider, provider_event_id, event_type, payload_hash, signature_valid)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (provider, provider_event_id) where provider_event_id is not null
         do nothing returning id`,
        [merchantId, payment0.id, provider, reference || null, eventType, hashRef(reference, amount), signatureValid],
      );
      const isNewEvent = evt.rows.length > 0;

      // Lock the payment; decide canonical outcome.
      const locked = await client.query(`select * from public.payments where id=$1 for update`, [payment0.id]);
      const p = locked.rows[0];

      if (p.status === "succeeded") {
        // Duplicate webhook after success → 2xx, no second movement (QR-03).
        if (isNewEvent) {
          await client.query(`update public.payment_provider_events set processed_at=now() where id=$1`, [evt.rows[0].id]);
        }
        return { handled: true, status: "succeeded", orderId, paymentId: p.id, duplicate: true };
      }
      if (["cancelled", "expired", "failed"].includes(p.status)) {
        // Cancel/expire won the race → do NOT resurrect (no double charge, QR-04).
        return { handled: true, status: p.status, orderId, paymentId: p.id, ignored: true };
      }

      // Signature / amount checks (QR-02).
      if (!signatureValid || Number(amount) !== Number(p.amount)) {
        await client.query(
          `update public.payment_provider_events set processed_at=now(), error_code=$2 where id = coalesce($1, id)`,
          [isNewEvent ? evt.rows[0].id : null, !signatureValid ? "BAD_SIGNATURE" : "AMOUNT_MISMATCH"],
        );
        await raiseActionItem(client, merchantId, "payment_provider", "critical",
          "Giao dịch QR không khớp", `Webhook amount ${amount} ≠ ${p.amount}`, "payment", p.id,
          `qr-mismatch-${p.id}`);
        return { handled: true, status: "rejected", orderId, paymentId: p.id, reason: !signatureValid ? "bad_signature" : "amount_mismatch" };
      }

      // Apply inventory; on shortfall, still pay (money arrived) + data_sync action.
      try {
        await applySaleInventory(client, merchantId, orderId, cashier);
      } catch (invErr) {
        if (invErr instanceof DomainError && invErr.code === "INSUFFICIENT_STOCK") {
          await raiseActionItem(client, merchantId, "data_sync", "warning",
            "Tồn kho lệch sau thanh toán QR", "Bill đã thu tiền nhưng tồn không đủ để trừ.", "order", orderId,
            `qr-stock-${orderId}`);
        } else {
          throw invErr;
        }
      }

      let paid;
      try {
        const upd = await client.query(
          `update public.payments
              set status='succeeded', paid_at=now(), provider_transaction_ref=$2, updated_at=now()
            where id=$1 returning id, change_due`,
          [p.id, reference || null],
        );
        paid = upd.rows[0];
      } catch (err) {
        throw mapPgError(err);
      }
      await client.query(
        `update public.orders set status='paid', paid_at=now(), version=version+1, updated_at=now()
          where id=$1 and status <> 'paid'`,
        [orderId],
      );
      await consumeReservations(client, orderId);
      if (isNewEvent) {
        await client.query(`update public.payment_provider_events set processed_at=now() where id=$1`, [evt.rows[0].id]);
      }
      const ctx = await getMerchantContext(merchantId);
      await ensureReceipt(client, merchantId, orderId, ctx.receiptPrefix, ctx.businessDate);
      await enqueueOutbox(client, { merchantId, eventType: "order.paid", aggregateId: orderId, payload: { orderId, paymentId: p.id, method: "qr" } });
      await writeAudit(client, { merchantId, actorUserId: cashier, action: "payment.qr.succeeded", entityType: "order", entityId: orderId, after: { amount: Number(p.amount), reference } });

      return { handled: true, status: "succeeded", orderId, paymentId: p.id };
    });
  } catch (err) {
    throw mapPgError(err);
  } finally {
    generateSuggestionsForOrder(merchantId, orderId).catch(() => {});
  }
}

function hashRef(reference, amount) {
  return `ref:${reference || "none"}:amt:${amount}`;
}

/** Upsert an open action_item (dedup by fingerprint per merchant, spec 6.6). */
async function raiseActionItem(client, merchantId, type, severity, title, description, entityType, entityId, fingerprint) {
  await client.query(
    `insert into public.action_items
       (merchant_id, action_type, severity, title, description, entity_type, entity_id, status, fingerprint)
     values ($1,$2,$3,$4,$5,$6,$7,'open',$8)
     on conflict (merchant_id, fingerprint) where status='open' do nothing`,
    [merchantId, type, severity, title, description, entityType, entityId, fingerprint],
  );
}

export { applySaleInventory };
