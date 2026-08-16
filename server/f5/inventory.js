// Functional 05 — inventory reads (spec 3.1 / 3.2 / 10). All numbers come from the
// ledger + level projection, scoped to the caller's merchant (authorised in the
// router). on_hand is the physical balance; `reserved` is the sum of ACTIVE, non-
// expired QR/order reservations (spec 4.1); `available = on_hand - reserved`. The
// ledger screen resolves each movement's source to a deep-link (bill/return/count)
// so a merchant can always answer "vì sao số tồn thay đổi?".
import { query, getPool } from "../db/pool.js";
import { fail } from "../f3/errors.js";
import { round3, loadTrackedProduct } from "./movements.js";

/** low/zero/negative bucket for a level (spec 2.1 state machine). */
export function stockState(onHand, threshold) {
  const oh = Number(onHand);
  if (oh < 0) return "negative";
  if (oh === 0) return "zero";
  if (Number(threshold) > 0 && oh <= Number(threshold)) return "low";
  return "ok";
}

function mapLevelRow(r) {
  const onHand = round3(r.on_hand);
  const reserved = round3(r.reserved);
  const threshold = r.threshold == null ? 0 : Number(r.threshold);
  return {
    productId: r.id,
    name: r.name,
    sku: r.sku,
    unitCode: r.unit_code,
    onHand,
    reserved,
    available: round3(onHand - reserved),
    lowStockThreshold: threshold,
    rowVersion: Number(r.row_version ?? 1),
    state: stockState(onHand, threshold),
  };
}

const OVERVIEW_SELECT = `
  select p.id, p.name, p.sku, p.unit_code,
         coalesce(il.on_hand, 0) as on_hand,
         coalesce(il.row_version, 1) as row_version,
         coalesce(il.low_stock_threshold, p.low_stock_threshold, 0) as threshold,
         coalesce((select sum(r.quantity) from public.inventory_reservations r
                    where r.merchant_id = p.merchant_id and r.product_id = p.id
                      and r.status = 'active' and r.expires_at > now()), 0) as reserved
    from public.products p
    left join public.inventory_levels il on il.merchant_id = p.merchant_id and il.product_id = p.id`;

const OVERVIEW_WHERE = `p.merchant_id = $1 and p.product_type = 'goods' and p.track_inventory and p.status <> 'archived'`;

/** GET /inventory — tracked-goods overview with search + low/zero/negative filter. */
export async function getInventoryOverview(merchantId, { search, filter, limit, offset } = {}) {
  const params = [merchantId];
  const inner = `${OVERVIEW_SELECT} where ${OVERVIEW_WHERE}`;
  const outerClauses = [];

  if (search && String(search).trim()) {
    const raw = String(search).trim();
    params.push(`%${raw.toLowerCase()}%`); const iName = params.length;
    params.push(raw.toUpperCase()); const iSku = params.length;
    outerClauses.push(`(lower(t.name) like $${iName} or t.sku = $${iSku})`);
  }
  if (filter === "negative") outerClauses.push("t.on_hand < 0");
  else if (filter === "zero") outerClauses.push("t.on_hand = 0");
  else if (filter === "low") outerClauses.push("t.on_hand > 0 and t.threshold > 0 and t.on_hand <= t.threshold");

  const lim = Math.min(Math.max(1, Number(limit) || 200), 500);
  const off = Math.max(0, Number(offset) || 0);
  params.push(lim + 1); const iLim = params.length;
  params.push(off); const iOff = params.length;

  const where = outerClauses.length ? `where ${outerClauses.join(" and ")}` : "";
  const { rows } = await query(
    `with t as (${inner}) select * from t ${where}
       order by (t.on_hand < 0) desc, (t.on_hand = 0) desc,
                (t.threshold > 0 and t.on_hand > 0 and t.on_hand <= t.threshold) desc,
                lower(t.name)
      limit $${iLim} offset $${iOff}`,
    params,
  );
  const hasMore = rows.length > lim;

  // Summary counts (unpaginated) drive the filter chips.
  const { rows: sum } = await query(
    `with t as (${OVERVIEW_SELECT} where ${OVERVIEW_WHERE})
     select count(*)::int as total,
            count(*) filter (where t.on_hand < 0)::int as negative,
            count(*) filter (where t.on_hand = 0)::int as zero,
            count(*) filter (where t.on_hand > 0 and t.threshold > 0 and t.on_hand <= t.threshold)::int as low
       from t`,
    [merchantId],
  );

  return {
    products: rows.slice(0, lim).map(mapLevelRow),
    hasMore,
    nextOffset: hasMore ? off + lim : null,
    summary: sum[0] || { total: 0, negative: 0, zero: 0, low: 0 },
  };
}

/** Resolve a movement row to a { source } deep-link + human label (spec 3.2). */
function mapMovementRow(r) {
  let source = null;
  switch (r.reference_type) {
    case "order_item":
      if (r.order_id) source = { kind: "order", label: r.order_number, route: `/don-hang/${r.order_id}` };
      break;
    case "return_item":
      if (r.return_order_id) source = { kind: "return", label: r.return_number, route: `/don-hang/${r.return_order_id}` };
      else if (r.return_number) source = { kind: "return", label: r.return_number, route: null };
      break;
    case "count_session":
      if (r.count_session_id) source = { kind: "count", label: r.count_session_name, route: `/ton-kho/kiem-kho/${r.count_session_id}` };
      break;
    case "purchase_receipt":
      if (r.receipt_id) source = { kind: "receipt", label: r.receipt_number, route: `/nhap-hang/${r.receipt_id}` };
      break;
    case "product":
      source = { kind: "opening", label: null, route: null };
      break;
    case "movement":
      source = { kind: "reversal", label: null, route: null };
      break;
    default:
      source = { kind: "adjustment", label: null, route: null };
  }
  return {
    id: r.id,
    movementType: r.movement_type,
    quantityDelta: round3(r.quantity_delta),
    balanceAfter: round3(r.balance_after),
    reasonCode: r.reason_code,
    note: r.note,
    createdAt: r.created_at,
    actorName: r.actor_name || null,
    originalMovementId: r.original_movement_id,
    reversed: Boolean(r.reversed),
    source,
  };
}

const LEDGER_SELECT = `
  select m.id, m.movement_type, m.quantity_delta, m.balance_after, m.reference_type,
         m.reference_id, m.reason_code, m.note, m.created_at, m.created_by, m.original_movement_id,
         o.id as order_id, o.order_number,
         sr.return_number, sro.id as return_order_id,
         cs.id as count_session_id, cs.name as count_session_name,
         pr.id as receipt_id, pr.receipt_number,
         prof.full_name as actor_name,
         exists (select 1 from public.inventory_movements rv
                  where rv.original_movement_id = m.id and rv.movement_type = 'reversal') as reversed
    from public.inventory_movements m
    left join public.order_items oi on m.reference_type = 'order_item' and oi.id = m.reference_id
    left join public.orders o on o.id = oi.order_id
    left join public.sales_return_items sri on m.reference_type = 'return_item' and sri.id = m.reference_id
    left join public.sales_returns sr on sr.id = sri.return_id
    left join public.orders sro on sro.id = sr.order_id
    left join public.inventory_count_sessions cs on m.reference_type = 'count_session' and cs.id = m.reference_id
    left join public.purchase_receipts pr on m.reference_type = 'purchase_receipt' and pr.id = m.reference_id
    left join public.profiles prof on prof.user_id = m.created_by`;

/** GET /inventory/:productId — header + ledger timeline + reconciliation flag. */
export async function getProductLedger(merchantId, productId, { limit, before } = {}) {
  const pool = getPool();
  const header = await pool.query(
    `select p.id, p.name, p.sku, p.unit_code,
            coalesce(il.on_hand, 0) as on_hand,
            coalesce(il.row_version, 1) as row_version,
            coalesce(il.low_stock_threshold, p.low_stock_threshold, 0) as threshold,
            p.negative_stock_policy,
            coalesce((select sum(r.quantity) from public.inventory_reservations r
                       where r.merchant_id = p.merchant_id and r.product_id = p.id
                         and r.status = 'active' and r.expires_at > now()), 0) as reserved
       from public.products p
       left join public.inventory_levels il on il.merchant_id = p.merchant_id and il.product_id = p.id
      where p.id = $1 and p.merchant_id = $2 and p.product_type = 'goods' and p.track_inventory`,
    [productId, merchantId],
  );
  if (header.rows.length === 0) fail("INVENTORY_NOT_TRACKED");
  const h = header.rows[0];

  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const params = [merchantId, productId];
  let cursorClause = "";
  if (before) { params.push(before); cursorClause = `and m.created_at < $${params.length}`; }
  params.push(lim + 1);
  const { rows } = await pool.query(
    `${LEDGER_SELECT}
      where m.merchant_id = $1 and m.product_id = $2 ${cursorClause}
      order by m.created_at desc, m.id desc
      limit $${params.length}`,
    params,
  );
  const hasMore = rows.length > lim;
  const movements = rows.slice(0, lim).map(mapMovementRow);

  // Reconciliation: ledger sum vs projected balance for this product (spec 6 FR-12).
  const rec = await pool.query(
    `select coalesce(sum(quantity_delta), 0) as ledger from public.inventory_movements
      where merchant_id = $1 and product_id = $2`,
    [merchantId, productId],
  );
  const ledgerQty = round3(rec.rows[0].ledger);
  const balanceQty = round3(h.on_hand);
  const reserved = round3(h.reserved);

  return {
    product: {
      productId: h.id,
      name: h.name,
      sku: h.sku,
      unitCode: h.unit_code,
      onHand: balanceQty,
      reserved,
      available: round3(balanceQty - reserved),
      lowStockThreshold: h.threshold == null ? 0 : Number(h.threshold),
      rowVersion: Number(h.row_version),
      negativeStockPolicy: h.negative_stock_policy,
      state: stockState(balanceQty, h.threshold),
    },
    movements,
    hasMore,
    nextCursor: hasMore ? movements[movements.length - 1].createdAt : null,
    reconciliation: {
      ledgerQty,
      balanceQty,
      mismatch: Math.abs(ledgerQty - balanceQty) > 1e-9,
    },
  };
}

/**
 * GET /inventory/reconciliation — every tracked product whose projected balance
 * disagrees with the ledger sum (spec 9.4). Read-only: findings only, never auto-
 * fixes (spec 7 "Không auto-fix"). Owner-gated in the router.
 */
export async function getReconciliation(merchantId) {
  const { rows } = await query(
    `select b.product_id, p.name, p.unit_code,
            b.on_hand as balance_qty,
            coalesce(sum(m.quantity_delta), 0) as ledger_qty
       from public.inventory_levels b
       join public.products p on p.id = b.product_id
       left join public.inventory_movements m
         on m.merchant_id = b.merchant_id and m.product_id = b.product_id
      where b.merchant_id = $1
      group by b.product_id, p.name, p.unit_code, b.on_hand
     having b.on_hand <> coalesce(sum(m.quantity_delta), 0)
      order by p.name`,
    [merchantId],
  );
  return {
    findings: rows.map((r) => ({
      productId: r.product_id,
      name: r.name,
      unitCode: r.unit_code,
      balanceQty: round3(r.balance_qty),
      ledgerQty: round3(r.ledger_qty),
      diff: round3(Number(r.balance_qty) - Number(r.ledger_qty)),
    })),
  };
}

export { loadTrackedProduct };
