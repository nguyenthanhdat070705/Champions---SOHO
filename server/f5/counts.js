// Functional 05 — stock counts / kiểm kê (spec 3.5–3.8, 4.3). A session snapshots
// expected_at_start for a scope, collects a physical count per item (optionally
// BLIND so the counter isn't biased, spec 3.5), computes variances at review, and
// posts every count_adjustment in ONE transaction — all-or-nothing so there is no
// half-posted session (spec 3.8 / INV-09). Levels are locked in product_id order
// at post to avoid deadlock (spec 5.1). A posted session is immutable; corrections
// go through a new session or a reversal, never an in-place edit.
import { query, withTransaction, getPool } from "../db/pool.js";
import { fail } from "../f3/errors.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { postMovementTx, round3 } from "./movements.js";
import { validateReason } from "./reasons.js";
import { runIdempotent, bodyHash } from "./idem.js";
import { computeVariance, countPostDelta, summarizeVariances } from "./count-math.js";

/** Resolve a scope to the tracked-goods product ids it covers (spec 3.5). */
async function resolveScopeProducts(client, merchantId, scope) {
  const type = scope?.type || "all";
  const base = `select id from public.products
                 where merchant_id=$1 and product_type='goods' and track_inventory and status <> 'archived'`;
  if (type === "all") {
    const { rows } = await client.query(base, [merchantId]);
    return rows.map((r) => r.id);
  }
  if (type === "category") {
    if (!scope.categoryId) fail("VALIDATION", "Thiếu nhóm hàng cho phạm vi kiểm kho.");
    const { rows } = await client.query(`${base} and category_id=$2`, [merchantId, scope.categoryId]);
    return rows.map((r) => r.id);
  }
  if (type === "products") {
    const ids = Array.isArray(scope.productIds) ? scope.productIds : [];
    if (ids.length === 0) fail("VALIDATION", "Chưa chọn sản phẩm để kiểm kho.");
    const { rows } = await client.query(`${base} and id = any($2::uuid[])`, [merchantId, ids]);
    return rows.map((r) => r.id);
  }
  fail("VALIDATION", "Phạm vi kiểm kho không hợp lệ.");
}

/** POST /inventory-counts — create a counting session with an expected snapshot. */
export async function createCountSession(merchantId, userId, input, idemKey) {
  const name = String(input.name || "").trim().slice(0, 120) || defaultName(input.businessDate);
  const scope = input.scope || { type: "all" };
  const blindCount = input.blindCount !== false; // default ON (spec 3.5)

  const canonical = { name, scope, blindCount };
  const { result, replayed } = await runIdempotent("count-create", idemKey, bodyHash(canonical), async () => {
    return withTransaction(async (client) => {
      const productIds = await resolveScopeProducts(client, merchantId, scope);
      if (productIds.length === 0) fail("VALIDATION", "Phạm vi kiểm kho không có sản phẩm nào.");

      const ins = await client.query(
        `insert into public.inventory_count_sessions
           (merchant_id, name, status, scope, blind_count, started_by, started_at)
         values ($1,$2,'counting',$3,$4,$5, now()) returning id, name, status, blind_count, started_at, row_version`,
        [merchantId, name, JSON.stringify(scope), blindCount, userId],
      );
      const session = ins.rows[0];

      // Snapshot expected_at_start = current on_hand for each product (spec 3.5:
      // the snapshot is kept even if sales/receipts happen afterwards).
      await client.query(
        `insert into public.inventory_count_items (session_id, merchant_id, product_id, expected_at_start)
         select $1, $2, p.id, coalesce(il.on_hand, 0)
           from public.products p
           left join public.inventory_levels il on il.merchant_id=p.merchant_id and il.product_id=p.id
          where p.merchant_id=$2 and p.id = any($3::uuid[])`,
        [session.id, merchantId, productIds],
      );

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "inventory.count_started",
        entityType: "count_session", entityId: session.id,
        after: { name, scope, blindCount, itemCount: productIds.length },
      });

      return {
        id: session.id, name: session.name, status: session.status, blindCount: session.blind_count,
        startedAt: session.started_at, itemCount: productIds.length, rowVersion: Number(session.row_version),
      };
    });
  });
  return { session: result, replayed };
}

function defaultName(businessDate) {
  return businessDate ? `Kiểm kho ${businessDate}` : "Kiểm kho";
}

async function loadSessionRow(client, merchantId, sessionId, forUpdate = false) {
  const { rows } = await client.query(
    `select * from public.inventory_count_sessions where id=$1 and merchant_id=$2 ${forUpdate ? "for update" : ""}`,
    [sessionId, merchantId],
  );
  if (rows.length === 0) fail("COUNT_NOT_FOUND");
  return rows[0];
}

/** Load items joined with product name/unit + live on_hand. */
async function loadItems(clientOrPool, merchantId, sessionId) {
  const { rows } = await clientOrPool.query(
    `select ci.product_id, ci.expected_at_start, ci.counted_qty, ci.reason_code, ci.note,
            p.name, p.unit_code, coalesce(il.on_hand, 0) as current_on_hand
       from public.inventory_count_items ci
       join public.products p on p.id = ci.product_id
       left join public.inventory_levels il on il.merchant_id=ci.merchant_id and il.product_id=ci.product_id
      where ci.session_id=$1 and ci.merchant_id=$2
      order by lower(p.name)`,
    [sessionId, merchantId],
  );
  return rows;
}

/** Shape an item row for the API; `reveal` shows expected/variance (false = blind). */
function mapItem(r, reveal) {
  const counted = r.counted_qty == null ? null : round3(r.counted_qty);
  const base = {
    productId: r.product_id, name: r.name, unitCode: r.unit_code,
    countedQty: counted, reasonCode: r.reason_code, note: r.note,
  };
  if (!reveal) return base;
  const v = computeVariance(r.expected_at_start, r.current_on_hand, counted);
  return {
    ...base,
    expectedAtStart: round3(r.expected_at_start),
    currentOnHand: round3(r.current_on_hand),
    variance: v.variance,
    deltaFromExpected: v.deltaFromExpected,
    requiresReason: v.requiresReason,
    missing: r.reason_code === "MISSING",
  };
}

/** GET /inventory-counts/:id — session + items (blind while counting). */
export async function getCountSession(merchantId, sessionId) {
  const pool = getPool();
  const s = await loadSessionRow(pool, merchantId, sessionId);
  const rows = await loadItems(pool, merchantId, sessionId);
  const reveal = !(s.status === "counting" && s.blind_count); // blind hides expected until review
  const items = rows.map((r) => mapItem(r, reveal));
  return { session: mapSession(s, rows.length), items, ...(reveal ? { summary: summaryFor(rows) } : {}) };
}

function mapSession(s, itemCount) {
  return {
    id: s.id, name: s.name, status: s.status, blindCount: s.blind_count, scope: s.scope,
    startedAt: s.started_at, postedAt: s.posted_at, rowVersion: Number(s.row_version), itemCount,
  };
}

function summaryFor(rows) {
  const lines = rows.map((r) => ({
    ...computeVariance(r.expected_at_start, r.current_on_hand, r.counted_qty == null ? null : Number(r.counted_qty)),
    reasonCode: r.reason_code,
  }));
  return summarizeVariances(lines);
}

/** PATCH /inventory-counts/:id/items — save entered counts (optimistic on session). */
export async function saveCountItems(merchantId, userId, sessionId, input) {
  const items = Array.isArray(input.items) ? input.items : [];
  return withTransaction(async (client) => {
    const s = await loadSessionRow(client, merchantId, sessionId, true);
    if (!["counting", "review"].includes(s.status)) fail("COUNT_INVALID_STATE");
    if (input.expectedRowVersion != null && Number(s.row_version) !== Number(input.expectedRowVersion)) {
      fail("VERSION_CONFLICT", "Phiên kiểm kho vừa được cập nhật ở nơi khác.");
    }
    for (const it of items) {
      if (!it.productId) continue;
      let countedQty = null;
      let reasonCode = it.reasonCode == null ? null : String(it.reasonCode).toUpperCase().slice(0, 32) || null;
      if (it.missing) {
        countedQty = null;
        reasonCode = "MISSING";
      } else if (it.countedQty != null && it.countedQty !== "") {
        const q = round3(it.countedQty);
        if (!Number.isFinite(q) || q < 0) fail("VALIDATION", "Số đếm phải ≥ 0.");
        countedQty = q;
      }
      const note = it.note == null ? null : String(it.note).trim().slice(0, 500) || null;
      await client.query(
        `update public.inventory_count_items set counted_qty=$1, reason_code=$2, note=$3
          where session_id=$4 and merchant_id=$5 and product_id=$6`,
        [countedQty, reasonCode, note, sessionId, merchantId, it.productId],
      );
    }
    await client.query(
      `update public.inventory_count_sessions set row_version=row_version+1 where id=$1`, [sessionId],
    );
    const rows = await loadItems(client, merchantId, sessionId);
    const reveal = !(s.status === "counting" && s.blind_count);
    return { session: mapSession({ ...s, row_version: Number(s.row_version) + 1 }, rows.length), items: rows.map((r) => mapItem(r, reveal)) };
  });
}

/** POST /inventory-counts/:id/review — reveal variances, move to 'review' (spec 3.7). */
export async function reviewCount(merchantId, userId, sessionId) {
  return withTransaction(async (client) => {
    const s = await loadSessionRow(client, merchantId, sessionId, true);
    if (s.status === "posted") fail("COUNT_ALREADY_POSTED");
    if (!["counting", "review"].includes(s.status)) fail("COUNT_INVALID_STATE");
    if (s.status !== "review") {
      await client.query(`update public.inventory_count_sessions set status='review', row_version=row_version+1 where id=$1`, [sessionId]);
    }
    const rows = await loadItems(client, merchantId, sessionId);
    return {
      session: mapSession({ ...s, status: "review", row_version: Number(s.row_version) + (s.status !== "review" ? 1 : 0) }, rows.length),
      items: rows.map((r) => mapItem(r, true)),
      summary: summaryFor(rows),
    };
  });
}

/**
 * POST /inventory-counts/:id/post — post every variance in ONE transaction
 * (spec 3.8 / INV-09). Locks levels in product_id order (spec 5.1). Items with no
 * count (null / missing) are skipped — a blank is never treated as 0 (INV-10). A
 * variance line without a reason rolls back the whole post (spec 3.7).
 */
export async function postCount(merchantId, userId, role, sessionId, idemKey) {
  if (!idemKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const { result, replayed } = await runIdempotent("count-post", idemKey, bodyHash({ sessionId }), async () => {
    return withTransaction(async (client) => {
      const s = await loadSessionRow(client, merchantId, sessionId, true);
      if (s.status === "posted") fail("COUNT_ALREADY_POSTED");
      if (!["counting", "review"].includes(s.status)) fail("COUNT_INVALID_STATE");

      // Deterministic lock order = product_id ascending (spec 5.1).
      const { rows } = await client.query(
        `select ci.product_id, ci.expected_at_start, ci.counted_qty, ci.reason_code, ci.note
           from public.inventory_count_items ci
          where ci.session_id=$1 and ci.merchant_id=$2 and ci.counted_qty is not null
          order by ci.product_id`,
        [sessionId, merchantId],
      );

      const adjustments = [];
      for (const it of rows) {
        // Lock the level, read the CURRENT balance, and adjust TO the counted qty.
        const lvl = await client.query(
          `select coalesce(on_hand,0) as on_hand from public.inventory_levels
             where merchant_id=$1 and product_id=$2 for update`,
          [merchantId, it.product_id],
        );
        const currentOnHand = lvl.rows.length ? round3(lvl.rows[0].on_hand) : 0;
        const delta = countPostDelta(currentOnHand, it.counted_qty);
        if (Math.abs(delta) < 1e-9) continue; // matched → no movement

        // A real variance MUST carry a reason (spec 3.7 "Bắt buộc delta !=0").
        if (it.reason_code === "MISSING" || !it.reason_code) {
          fail("REASON_REQUIRED", "Có dòng lệch chưa chọn lý do.", { productId: it.product_id });
        }
        validateReason(it.reason_code, it.note, { required: true });

        const posted = await postMovementTx(client, {
          merchantId, productId: it.product_id, movementType: "count_adjustment",
          delta, referenceType: "count_session", referenceId: sessionId,
          sourceLineId: it.product_id, reasonCode: it.reason_code, note: it.note, userId,
        });
        adjustments.push({
          productId: it.product_id, delta, before: posted.previousBalance,
          after: posted.balanceAfter, reasonCode: it.reason_code,
        });
      }

      await client.query(
        `update public.inventory_count_sessions
            set status='posted', posted_by=$2, posted_at=now(), row_version=row_version+1
          where id=$1`,
        [sessionId, userId],
      );
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "inventory.count_posted",
        entityType: "count_session", entityId: sessionId,
        after: { adjustments, postedLines: adjustments.length },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "inventory.count_posted", aggregateId: sessionId,
        payload: { sessionId, postedLines: adjustments.length },
      });

      return { sessionId, status: "posted", postedLines: adjustments.length, adjustments };
    });
  });
  return { ...result, replayed };
}

/** POST /inventory-counts/:id/cancel — abandon a session (spec 2.1 cancelled). */
export async function cancelCountSession(merchantId, userId, sessionId) {
  return withTransaction(async (client) => {
    const s = await loadSessionRow(client, merchantId, sessionId, true);
    if (s.status === "posted") fail("COUNT_ALREADY_POSTED");
    if (s.status === "cancelled") return { sessionId, status: "cancelled" };
    await client.query(`update public.inventory_count_sessions set status='cancelled', row_version=row_version+1 where id=$1`, [sessionId]);
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "inventory.count_cancelled",
      entityType: "count_session", entityId: sessionId, before: { status: s.status },
    });
    return { sessionId, status: "cancelled" };
  });
}

/** GET /inventory-counts — recent sessions (list screen). */
export async function listCountSessions(merchantId, { limit } = {}) {
  const lim = Math.min(Math.max(1, Number(limit) || 30), 100);
  const { rows } = await query(
    `select s.id, s.name, s.status, s.blind_count, s.started_at, s.posted_at,
            (select count(*) from public.inventory_count_items ci where ci.session_id=s.id)::int as item_count
       from public.inventory_count_sessions s
      where s.merchant_id=$1
      order by s.created_at desc
      limit $2`,
    [merchantId, lim],
  );
  return {
    sessions: rows.map((r) => ({
      id: r.id, name: r.name, status: r.status, blindCount: r.blind_count,
      startedAt: r.started_at, postedAt: r.posted_at, itemCount: r.item_count,
    })),
  };
}
