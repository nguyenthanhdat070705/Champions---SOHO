// Functional 05 — manual adjustments (spec 3.3 / 3.4) and movement reversal
// (spec 3.2 / 4.2). Nobody edits a number directly: every change is an immutable
// movement + a level update in ONE transaction, with a required reason and actor
// (spec 1 principle). Negative stock is BLOCKED (founder decision) — no owner
// override in the MVP. Reversal never touches the original row; it appends an
// opposite 'reversal' movement linked by original_movement_id, and the (product,
// 'reversal', 'movement', original) unique index makes a second reverse conflict.
import { query, withTransaction, getPool } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { postMovementTx, ensureLevel, deterministicUuid, round3, loadTrackedProduct } from "./movements.js";
import { validateReason } from "./reasons.js";
import { runIdempotent, bodyHash } from "./idem.js";
import { isReversibleType, reverseDelta, adjustmentDelta } from "./rules.js";

function normalizeDirection(dir) {
  if (dir !== "increase" && dir !== "decrease") fail("VALIDATION", "Hướng điều chỉnh không hợp lệ.");
  return dir;
}

function normalizeQuantity(q) {
  const n = round3(q);
  if (!Number.isFinite(n) || n <= 0) fail("VALIDATION", "Nhập số lượng lớn hơn 0.");
  return n;
}

/** POST /inventory/adjustments/preview — before/after using the current balance. */
export async function previewAdjustment(merchantId, { productId, direction, quantity, reasonCode, note }) {
  const dir = normalizeDirection(direction);
  const qty = normalizeQuantity(quantity);
  const reason = validateReason(reasonCode, note, { required: false });

  const pool = getPool();
  const prod = await loadTrackedProduct(pool, merchantId, productId);
  const { rows } = await pool.query(
    `select coalesce(on_hand,0) as on_hand, coalesce(row_version,1) as row_version
       from public.inventory_levels where merchant_id=$1 and product_id=$2`,
    [merchantId, productId],
  );
  const before = rows.length ? round3(rows[0].on_hand) : 0;
  const rowVersion = rows.length ? Number(rows[0].row_version) : 1;
  const delta = adjustmentDelta(dir, qty);
  const after = round3(before + delta);

  return {
    productId,
    name: prod.name,
    unitCode: prod.unit_code,
    direction: dir,
    quantity: qty,
    delta,
    before,
    after,
    reasonCode: reason.reasonCode,
    note: reason.note,
    currentVersion: rowVersion,
    wouldBlock: after < 0,
  };
}

/**
 * POST /inventory/adjustments — post a manual adjustment atomically (spec 5.1).
 * `expectedBalanceVersion` is the level row_version the preview was built on: a
 * stale version means the balance moved under the user → 409 INVENTORY_BALANCE_
 * CHANGED with the current snapshot (spec 3.4 / 10.1). Idempotent per key.
 */
export async function postAdjustment(merchantId, userId, role, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const dir = normalizeDirection(input.direction);
  const qty = normalizeQuantity(input.quantity);
  const reason = validateReason(input.reasonCode, input.note, { required: true });
  const delta = adjustmentDelta(dir, qty);
  const expectedVersion = input.expectedBalanceVersion != null ? Number(input.expectedBalanceVersion) : null;

  const canonical = { productId: input.productId, direction: dir, quantity: qty, reasonCode: reason.reasonCode };
  const referenceId = deterministicUuid(`adj:${merchantId}:${idemKey}`);

  const { result, replayed } = await runIdempotent("adjustment", idemKey, bodyHash(canonical), async () => {
    return withTransaction(async (client) => {
      const prod = await loadTrackedProduct(client, merchantId, input.productId);
      await ensureLevel(client, merchantId, input.productId);
      const lvl = await client.query(
        `select on_hand, row_version from public.inventory_levels
           where merchant_id=$1 and product_id=$2 for update`,
        [merchantId, input.productId],
      );
      const current = lvl.rows[0];
      if (expectedVersion != null && Number(current.row_version) !== expectedVersion) {
        throw new DomainError("INVENTORY_BALANCE_CHANGED", undefined, {
          action: "REFRESH_PREVIEW",
          current: { onHand: round3(current.on_hand), rowVersion: Number(current.row_version) },
        });
      }

      const posted = await postMovementTx(client, {
        merchantId, productId: input.productId, movementType: "manual_adjustment",
        delta, referenceType: "adjustment", referenceId,
        reasonCode: reason.reasonCode, note: reason.note, userId,
      });

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "inventory.movement_posted",
        entityType: "product", entityId: input.productId,
        after: {
          movementType: "manual_adjustment", direction: dir, quantity: qty, delta,
          reasonCode: reason.reasonCode, before: posted.previousBalance, after: posted.balanceAfter,
        },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "inventory.adjustment_posted", aggregateId: input.productId,
        payload: { productId: input.productId, movementId: posted.movementId, delta },
      });

      return {
        movementId: posted.movementId,
        productId: input.productId,
        name: prod.name,
        direction: dir,
        quantity: qty,
        delta,
        previousBalance: posted.previousBalance,
        balanceAfter: posted.balanceAfter,
        rowVersion: posted.rowVersion,
        reasonCode: reason.reasonCode,
        note: reason.note,
      };
    });
  });
  return { ...result, replayed };
}

/**
 * POST /inventory/movements/:id/reverse — append an opposite 'reversal' movement
 * (spec 4.2 / INV-12). The original row is never edited. A double-tap with the
 * SAME Idempotency-Key replays; a fresh reverse of an already-reversed movement is
 * 409 MOVEMENT_ALREADY_REVERSED. The idem key is stamped into source_line_id so
 * replay survives a server restart (there is no durable idempotency table).
 */
export async function reverseMovement(merchantId, userId, role, movementId, input, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const reason = validateReason(input.reasonCode ?? "CORRECTION", input.note, { required: false });
  const idemMarker = deterministicUuid(`rev:${merchantId}:${idemKey}`);

  return withTransaction(async (client) => {
    const orig = await client.query(
      `select id, product_id, movement_type, quantity_delta, reason_code
         from public.inventory_movements where id=$1 and merchant_id=$2`,
      [movementId, merchantId],
    );
    if (orig.rows.length === 0) fail("MOVEMENT_NOT_FOUND");
    const m = orig.rows[0];
    if (!isReversibleType(m.movement_type)) fail("MOVEMENT_NOT_REVERSIBLE");

    // Serialize concurrent reverses of the same product on the level lock first.
    await ensureLevel(client, merchantId, m.product_id);
    await client.query(
      `select 1 from public.inventory_levels where merchant_id=$1 and product_id=$2 for update`,
      [merchantId, m.product_id],
    );

    // Already reversed? Same idem key → replay; different request → conflict.
    const existing = await client.query(
      `select id, source_line_id, quantity_delta, balance_after from public.inventory_movements
        where original_movement_id=$1 and movement_type='reversal'`,
      [movementId],
    );
    if (existing.rows.length > 0) {
      const ex = existing.rows[0];
      if (ex.source_line_id === idemMarker) {
        return {
          movementId: ex.id, originalMovementId: movementId, productId: m.product_id,
          delta: round3(ex.quantity_delta), balanceAfter: round3(ex.balance_after), replayed: true,
        };
      }
      fail("MOVEMENT_ALREADY_REVERSED");
    }

    const revDelta = reverseDelta(m.quantity_delta);
    const posted = await postMovementTx(client, {
      merchantId, productId: m.product_id, movementType: "reversal",
      delta: revDelta, referenceType: "movement", referenceId: movementId,
      sourceLineId: idemMarker, originalMovementId: movementId,
      reasonCode: reason.reasonCode, note: reason.note, userId,
    });

    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "inventory.movement_reversed",
      entityType: "product", entityId: m.product_id,
      before: { originalMovementId: movementId, originalDelta: round3(m.quantity_delta) },
      after: { movementId: posted.movementId, delta: revDelta, reasonCode: reason.reasonCode, balanceAfter: posted.balanceAfter },
    });
    await enqueueOutbox(client, {
      merchantId, eventType: "inventory.movement_reversed", aggregateId: m.product_id,
      payload: { productId: m.product_id, originalMovementId: movementId, movementId: posted.movementId },
    });

    return {
      movementId: posted.movementId,
      originalMovementId: movementId,
      productId: m.product_id,
      delta: revDelta,
      previousBalance: posted.previousBalance,
      balanceAfter: posted.balanceAfter,
      rowVersion: posted.rowVersion,
      replayed: false,
    };
  });
}
