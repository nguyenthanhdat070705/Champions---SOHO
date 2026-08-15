// Functional 05 — the shared inventory movement-posting service (spec §0, §7.1,
// §9.3). inventory_movements is the immutable ledger; inventory_levels.on_hand is
// the fast projection. EVERY quantity change is an append + a level update in ONE
// transaction — nobody UPDATEs on_hand directly (spec 1 principle). F03 (sale/
// return) and F04 (opening) already post their own movement types inline with the
// same shape; this module is the shared core for the NEW F05 movement types
// (manual_adjustment, count_adjustment, reversal) and mirrors that shape exactly.
//
// Callers are authorised in the router (JWT + membership/role) BEFORE reaching
// here, because the pooler bypasses RLS (NFR-04). The level row is always locked
// FOR UPDATE first so concurrent posts serialize and can never oversell (INV-03).
import { createHash } from "node:crypto";
import { DomainError, fail } from "../f3/errors.js";

/** numeric(14,3) rounding so JS float math matches the DB column exactly. */
export function round3(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

/**
 * A stable UUID derived from an arbitrary string seed (RFC-4122 style, version
 * nibble forced to 5). Used to turn an Idempotency-Key into a durable movement
 * reference_id so a retry lands on the SAME (product, type, ref) unique tuple and
 * replays instead of double-posting — even across a server restart (spec 5.1).
 */
export function deterministicUuid(seed) {
  const h = createHash("sha256").update(String(seed)).digest("hex").slice(0, 32);
  // xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx  (version 5, RFC-4122 variant)
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Ensure the level row exists (a product turned trackable after create may lack one). */
export async function ensureLevel(client, merchantId, productId) {
  await client.query(
    `insert into public.inventory_levels (merchant_id, product_id, on_hand, low_stock_threshold)
       values ($1,$2,0,coalesce((select low_stock_threshold from public.products where id=$2),0))
     on conflict (merchant_id, product_id) do nothing`,
    [merchantId, productId],
  );
}

/**
 * Append one movement and update the level, atomically, inside the caller's
 * transaction. Idempotent on (product_id, movement_type, reference_type,
 * reference_id): a duplicate call replays the prior movement and does NOT touch
 * the balance a second time (INV-02, adjustment double-tap).
 *
 * @returns {Promise<{ movementId, balanceAfter, previousBalance, rowVersion, replayed }>}
 */
export async function postMovementTx(client, {
  merchantId, productId, movementType, delta, referenceType, referenceId,
  sourceLineId = null, reasonCode = null, note = null, userId,
  originalMovementId = null, allowNegative = false,
}) {
  const d = round3(delta);
  if (!(Math.abs(d) > 0)) fail("VALIDATION", "Số lượng thay đổi phải khác 0.");

  await ensureLevel(client, merchantId, productId);
  const lvl = await client.query(
    `select on_hand, row_version from public.inventory_levels
       where merchant_id=$1 and product_id=$2 for update`,
    [merchantId, productId],
  );
  const previous = lvl.rows.length ? round3(lvl.rows[0].on_hand) : 0;
  const newBalance = round3(previous + d);
  if (newBalance < 0 && !allowNegative) {
    fail("INSUFFICIENT_STOCK", "Không đủ hàng để giảm.", { available: previous, requested: Math.abs(d) });
  }

  // Append the immutable movement. on-conflict = a same-reference replay.
  const ins = await client.query(
    `insert into public.inventory_movements
       (merchant_id, product_id, movement_type, quantity_delta, balance_after,
        reference_type, reference_id, source_line_id, reason_code, note, created_by, original_movement_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (product_id, movement_type, reference_type, reference_id) do nothing
     returning id, balance_after`,
    [merchantId, productId, movementType, d, newBalance, referenceType, referenceId,
     sourceLineId, reasonCode, note, userId, originalMovementId],
  );

  if (ins.rows.length === 0) {
    // Duplicate reference → the original already applied its delta. Replay it
    // without moving the balance again (idempotent).
    const existing = await client.query(
      `select id, balance_after from public.inventory_movements
        where product_id=$1 and movement_type=$2 and reference_type=$3 and reference_id=$4`,
      [productId, movementType, referenceType, referenceId],
    );
    const row = existing.rows[0];
    return {
      movementId: row?.id ?? null,
      balanceAfter: row ? round3(row.balance_after) : previous,
      previousBalance: previous,
      rowVersion: Number(lvl.rows[0]?.row_version ?? 1),
      replayed: true,
    };
  }

  const upd = await client.query(
    `update public.inventory_levels
        set on_hand=$1, row_version=row_version+1, updated_at=now()
      where merchant_id=$2 and product_id=$3
      returning row_version`,
    [newBalance, merchantId, productId],
  );
  return {
    movementId: ins.rows[0].id,
    balanceAfter: newBalance,
    previousBalance: previous,
    rowVersion: Number(upd.rows[0].row_version),
    replayed: false,
  };
}

/** Load a tracked product (goods + track_inventory) or fail with a clean code. */
export async function loadTrackedProduct(client, merchantId, productId) {
  const { rows } = await client.query(
    `select id, name, unit_code, product_type, track_inventory, negative_stock_policy
       from public.products where id=$1 and merchant_id=$2`,
    [productId, merchantId],
  );
  if (rows.length === 0) throw new DomainError("PRODUCT_NOT_FOUND");
  const p = rows[0];
  if (p.product_type !== "goods" || !p.track_inventory) {
    throw new DomainError("INVENTORY_NOT_TRACKED", undefined, { productId });
  }
  return p;
}
