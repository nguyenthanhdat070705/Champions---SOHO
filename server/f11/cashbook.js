// Functional 11 — the cashbook READ + REVIEW + REVERSE service (spec §3, §4.3,
// §7.1, §10). Money totals are ALWAYS server-computed from posted entries (spec
// §7.2 "mobile không gửi giá trị tổng"). Every mutation runs in one pooler
// transaction (the F3/F5/F6 pattern); the caller is authorised (JWT + role) in
// the router before reaching here. Timezone is fixed Asia/Ho_Chi_Minh (+07, no
// DST) so local-day bounds are exact ISO offsets (CBK-10).
import { withTransaction, query } from "../db/pool.js";
import { writeAudit } from "../f3/audit.js";
import { DomainError, fail } from "../f3/errors.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { deterministicUuid } from "../f5/movements.js";
import { postEntryTx } from "./ingest.js";
import {
  ENTRY_TYPES, REASON_CODES, EXCLUDE_REASONS, REVERSAL_REASONS,
  draftIsReady, directionForEntryType, sourceHash, RULE_VERSION,
} from "./mapping.js";

const TZ = "Asia/Ho_Chi_Minh";
const COUNTED_STATUSES = ["posted"]; // totals = posted only (spec §7.2; the
// reversal contra is itself a 'posted' line, so a reversed pair nets to zero
// WITHOUT excluding the original — the original stays immutable & posted, §7.1).

// ── Period math (pure; `now` injectable for tests) ─────────────────────────────
function localDateStr(d) {
  // 'YYYY-MM-DD' in Asia/Ho_Chi_Minh.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return localDateStr2(d);
}
function localDateStr2(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** Resolve a period selector to inclusive local-date bounds + a [start,end) tz range. */
export function computePeriod(period, { from, to, now = new Date() } = {}) {
  const today = localDateStr(now);
  let dStart, dEnd;
  if (period === "today" || !period) { dStart = today; dEnd = today; }
  else if (period === "week") {
    const wd = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    const backToMon = (wd + 6) % 7;
    dStart = addDays(today, -backToMon);
    dEnd = addDays(dStart, 6);
  } else if (period === "month") {
    dStart = `${today.slice(0, 7)}-01`;
    const [y, m] = today.split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    dEnd = `${today.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
  } else if (period === "custom") {
    dStart = from || today; dEnd = to || dStart;
    if (dEnd < dStart) [dStart, dEnd] = [dEnd, dStart];
  } else { dStart = today; dEnd = today; }
  return {
    period: period || "today", dStart, dEnd, timezone: TZ,
    tsStart: `${dStart}T00:00:00+07:00`,
    tsEnd: `${addDays(dEnd, 1)}T00:00:00+07:00`,
  };
}

// ── Source deep-link resolution ────────────────────────────────────────────────
async function batchRoutes(client, links) {
  const byType = { payment: [], refund: [] };
  for (const l of links) if (byType[l.source_type]) byType[l.source_type].push(l.source_id);
  const orderOfPayment = new Map();
  if (byType.payment.length) {
    const { rows } = await client.query(
      `select id, order_id from public.payments where id = any($1::uuid[])`, [byType.payment]);
    for (const r of rows) orderOfPayment.set(r.id, r.order_id);
  }
  const orderOfRefund = new Map();
  if (byType.refund.length) {
    const { rows } = await client.query(
      `select id, order_id from public.payment_refunds where id = any($1::uuid[])`, [byType.refund]);
    for (const r of rows) orderOfRefund.set(r.id, r.order_id);
  }
  return (sourceType, sourceId) => routeFor(sourceType, sourceId, { orderOfPayment, orderOfRefund });
}
function routeFor(sourceType, sourceId, maps = {}) {
  switch (sourceType) {
    case "payment": { const o = maps.orderOfPayment?.get(sourceId); return o ? `/don-hang/${o}` : null; }
    case "refund": { const o = maps.orderOfRefund?.get(sourceId); return o ? `/don-hang/${o}` : null; }
    case "purchase_receipt": return `/nhap-hang/${sourceId}`;
    case "expense": return `/chi-phi/${sourceId}`;
    default: return null;
  }
}
const SOURCE_LABEL = {
  payment: "Bill", refund: "Hoàn tiền", purchase_receipt: "Phiếu nhập",
  expense: "Chi phí", manual: "Ghi tay",
};
async function resolveSource(client, sourceType, sourceId) {
  const route = routeFor(sourceType, sourceId,
    sourceType === "payment"
      ? { orderOfPayment: await oneOrder(client, "payments", sourceId) }
      : sourceType === "refund"
        ? { orderOfRefund: await oneOrder(client, "payment_refunds", sourceId) }
        : {});
  return { sourceType, sourceId, label: SOURCE_LABEL[sourceType] || sourceType, route };
}
async function oneOrder(client, table, id) {
  const { rows } = await client.query(`select id, order_id from public.${table} where id=$1`, [id]);
  const m = new Map();
  if (rows.length) m.set(rows[0].id, rows[0].order_id);
  return m;
}

// ── Summary + coverage (spec §3.1 / §3.8 / FR-09 / FR-10) ──────────────────────
export async function getSummary(merchantId, { period, from, to } = {}) {
  const p = computePeriod(period, { from, to });
  const totals = await query(
    `select direction, entry_type, count(*)::int n, coalesce(sum(amount_vnd),0)::bigint total
       from public.cashbook_entries
      where merchant_id=$1 and status = any($4::text[])
        and occurred_at >= $2 and occurred_at < $3
      group by direction, entry_type`,
    [merchantId, p.tsStart, p.tsEnd, COUNTED_STATUSES]);
  let totalIn = 0, totalOut = 0;
  const byType = {};
  for (const r of totals.rows) {
    const amt = Number(r.total);
    if (r.direction === "in") totalIn += amt; else totalOut += amt;
    byType[r.entry_type] = { direction: r.direction, entryType: r.entry_type,
      label: ENTRY_TYPES[r.entry_type]?.label || r.entry_type, count: r.n, total: amt };
  }
  const cov = await coverage(merchantId, p);
  const reviewOpen = await query(
    `select count(*)::int c from public.cashbook_review_items
       where merchant_id=$1 and status in ('open','ready')`, [merchantId]);
  return {
    period: p.period, from: p.dStart, to: p.dEnd, timezone: p.timezone,
    asOf: new Date().toISOString(),
    totalIn, totalOut, difference: totalIn - totalOut,
    byType: Object.values(byType),
    coverage: cov,
    reviewCount: reviewOpen.rows[0].c,
    ruleVersion: RULE_VERSION,
  };
}

async function coverage(merchantId, p) {
  const { rows } = await query(
    `select
       (select count(*) from public.payments x
          where x.merchant_id=$1 and x.status='succeeded' and x.paid_at>=$2 and x.paid_at<$3)::int as pay_exp,
       (select count(*) from public.payments x
          where x.merchant_id=$1 and x.status='succeeded' and x.paid_at>=$2 and x.paid_at<$3
            and exists (select 1 from public.cashbook_source_links l
               where l.merchant_id=$1 and l.source_type='payment' and l.source_id=x.id))::int as pay_ok,
       (select count(*) from public.payment_refunds x
          where x.merchant_id=$1 and x.status='succeeded' and x.refunded_at>=$2 and x.refunded_at<$3)::int as ref_exp,
       (select count(*) from public.payment_refunds x
          where x.merchant_id=$1 and x.status='succeeded' and x.refunded_at>=$2 and x.refunded_at<$3
            and exists (select 1 from public.cashbook_source_links l
               where l.merchant_id=$1 and l.source_type='refund' and l.source_id=x.id))::int as ref_ok,
       (select count(*) from public.accounting_events x
          where x.merchant_id=$1 and x.event_type in ('purchase_received','expense_posted')
            and x.created_at>=$2 and x.created_at<$3)::int as acc_exp,
       (select count(*) from public.accounting_events x
          where x.merchant_id=$1 and x.event_type in ('purchase_received','expense_posted')
            and x.created_at>=$2 and x.created_at<$3
            and exists (select 1 from public.cashbook_source_links l
               where l.merchant_id=$1 and l.source_id=x.source_id and l.source_event_type=x.event_type))::int as acc_ok,
       (select count(*) from public.accounting_events x
          where x.merchant_id=$1 and x.event_type in ('purchase_received','expense_posted')
            and x.created_at>=$2 and x.created_at<$3
            and exists (select 1 from public.cashbook_review_items ri
               where ri.merchant_id=$1 and ri.event_id=x.id and ri.status in ('open','ready')))::int as acc_rev
     `, [merchantId, p.tsStart, p.tsEnd]);
  const r = rows[0];
  const expected = r.pay_exp + r.ref_exp + r.acc_exp;
  const processed = r.pay_ok + r.ref_ok + r.acc_ok;
  const inReview = r.acc_rev;
  return {
    expected, processed, review: inReview, failed: 0,
    pct: expected > 0 ? Math.round((processed / expected) * 100) : 100,
    complete: expected === processed,
  };
}

// ── Entries list (cursor, spec §3.2 / §10) ─────────────────────────────────────
export async function listEntries(merchantId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
  const statuses = opts.status ? [opts.status] : ["posted"];
  const params = [merchantId, statuses];
  const wh = [`e.merchant_id=$1`, `e.status = any($2::text[])`];
  if (opts.direction === "in" || opts.direction === "out") { params.push(opts.direction); wh.push(`e.direction=$${params.length}`); }
  if (opts.entryType) { params.push(opts.entryType); wh.push(`e.entry_type=$${params.length}`); }
  if (opts.method) { params.push(opts.method); wh.push(`e.payment_method=$${params.length}`); }
  if (opts.from) { params.push(`${opts.from}T00:00:00+07:00`); wh.push(`e.occurred_at >= $${params.length}`); }
  if (opts.to) { params.push(`${addDays(opts.to, 1)}T00:00:00+07:00`); wh.push(`e.occurred_at < $${params.length}`); }
  if (opts.cursor) {
    const [cts, cid] = String(opts.cursor).split("|");
    params.push(cts); params.push(cid);
    wh.push(`(e.occurred_at, e.id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(limit + 1);
  const sql =
    `select e.id, e.direction, e.entry_type, e.amount_vnd, e.occurred_at, e.payment_method,
            e.status, e.created_at,
            l.source_type, l.source_id,
            (adj.id is not null) as reversed,
            adjof.original_entry_id as reverses_entry_id
       from public.cashbook_entries e
       left join public.cashbook_source_links l on l.entry_id=e.id
       left join public.cashbook_adjustments adj on adj.original_entry_id=e.id and adj.merchant_id=e.merchant_id
       left join public.cashbook_adjustments adjof on adjof.adjustment_entry_id=e.id and adjof.merchant_id=e.merchant_id
      where ${wh.join(" and ")}
      order by e.occurred_at desc, e.id desc
      limit $${params.length}`;
  return withTransaction(async (client) => {
    const { rows } = await client.query(sql, params);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const resolve = await batchRoutes(client, page.filter((r) => r.source_type));
    const entries = page.map((r) => mapEntryRow(r, resolve));
    const nextCursor = hasMore ? `${new Date(page[page.length - 1].occurred_at).toISOString()}|${page[page.length - 1].id}` : null;
    return { entries, hasMore, nextCursor };
  });
}

function mapEntryRow(r, resolve) {
  return {
    id: r.id, direction: r.direction, entryType: r.entry_type,
    entryLabel: ENTRY_TYPES[r.entry_type]?.label || r.entry_type,
    amountVnd: Number(r.amount_vnd), occurredAt: new Date(r.occurred_at).toISOString(),
    paymentMethod: r.payment_method, status: r.status,
    reversed: Boolean(r.reversed), reversesEntryId: r.reverses_entry_id || null,
    source: r.source_type ? {
      sourceType: r.source_type, sourceId: r.source_id,
      label: SOURCE_LABEL[r.source_type] || r.source_type,
      route: resolve(r.source_type, r.source_id),
    } : null,
  };
}

// ── Entry detail (spec §3.4) ───────────────────────────────────────────────────
export async function getEntry(merchantId, entryId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.cashbook_entries where id=$1 and merchant_id=$2`, [entryId, merchantId]);
    if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy dòng sổ.");
    const e = rows[0];
    const links = await client.query(
      `select source_type, source_id, source_event_type, source_version, source_hash
         from public.cashbook_source_links where entry_id=$1 and merchant_id=$2`, [entryId, merchantId]);
    const sources = [];
    for (const l of links.rows) {
      const s = await resolveSource(client, l.source_type, l.source_id);
      sources.push({ ...s, sourceEventType: l.source_event_type, sourceVersion: Number(l.source_version) });
    }
    // Adjustment relations: is this reversed, or is it a contra of another entry?
    const asOriginal = await client.query(
      `select adjustment_entry_id, reason, created_by, created_at
         from public.cashbook_adjustments where original_entry_id=$1 and merchant_id=$2`, [entryId, merchantId]);
    const asContra = await client.query(
      `select original_entry_id, reason, created_by, created_at
         from public.cashbook_adjustments where adjustment_entry_id=$1 and merchant_id=$2`, [entryId, merchantId]);
    const timeline = [{ state: "posted", at: new Date(e.created_at).toISOString() }];
    if (asOriginal.rows.length) timeline.push({ state: "reversed", at: new Date(asOriginal.rows[0].created_at).toISOString() });
    return {
      entry: {
        id: e.id, direction: e.direction, entryType: e.entry_type,
        entryLabel: ENTRY_TYPES[e.entry_type]?.label || e.entry_type,
        amountVnd: Number(e.amount_vnd), occurredAt: new Date(e.occurred_at).toISOString(),
        paymentMethod: e.payment_method, status: e.status, ruleVersion: e.rule_version,
        createdAt: new Date(e.created_at).toISOString(),
      },
      sources,
      reversed: asOriginal.rows.length > 0,
      reversalEntryId: asOriginal.rows[0]?.adjustment_entry_id || null,
      reversesEntryId: asContra.rows[0]?.original_entry_id || null,
      reversalReason: asOriginal.rows[0]?.reason || asContra.rows[0]?.reason || null,
      canReverse: e.status === "posted" && asOriginal.rows.length === 0,
      timeline,
    };
  });
}

// ── Review queue (spec §3.3 / §10) ─────────────────────────────────────────────
export async function listReview(merchantId, { status, reasonCode } = {}) {
  const statuses = status ? [status] : ["open", "ready"];
  const params = [merchantId, statuses];
  let extra = "";
  if (reasonCode) { params.push(reasonCode); extra = ` and $${params.length} = any(reason_codes)`; }
  const { rows } = await query(
    `select id, event_id, reason_codes, draft_data, status, row_version, created_at
       from public.cashbook_review_items
      where merchant_id=$1 and status = any($2::text[])${extra}
      order by created_at asc, id asc limit 200`, params);
  return { items: rows.map(mapReviewRow) };
}

function mapReviewRow(r) {
  const d = r.draft_data || {};
  return {
    id: r.id, eventId: r.event_id, status: r.status, rowVersion: Number(r.row_version),
    reasonCodes: r.reason_codes || [],
    reasons: (r.reason_codes || []).map((c) => ({ code: c, label: REASON_CODES[c] || c })),
    ready: draftIsReady(d),
    draft: {
      sourceType: d.sourceType ?? null, sourceId: d.sourceId ?? null,
      sourceLabel: d.sourceLabel ?? SOURCE_LABEL[d.sourceType] ?? null,
      direction: d.direction ?? null, entryType: d.entryType ?? null,
      amountVnd: d.amountVnd ?? null, occurredAt: d.occurredAt ?? null,
      paymentMethod: d.paymentMethod ?? "unknown", note: d.note ?? null,
    },
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function getReview(merchantId, reviewId) {
  const { rows } = await query(
    `select id, event_id, reason_codes, draft_data, status, row_version, created_at
       from public.cashbook_review_items where id=$1 and merchant_id=$2`, [reviewId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy khoản cần xem.");
  const item = mapReviewRow(rows[0]);
  // Resolve the source deep-link for the drill-down.
  if (item.draft.sourceType && item.draft.sourceId && item.draft.sourceType !== "manual") {
    const s = await withTransaction((c) => resolveSource(c, item.draft.sourceType, item.draft.sourceId));
    item.draft.route = s.route;
  }
  return { item };
}

/** Merge editable draft fields; recompute ready/open; optimistic If-Match. */
export async function patchReview(merchantId, userId, reviewId, fields, expectedRowVersion) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.cashbook_review_items where id=$1 and merchant_id=$2 for update`, [reviewId, merchantId]);
    if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy khoản cần xem.");
    const item = rows[0];
    if (!["open", "ready"].includes(item.status)) fail("VALIDATION", "Khoản này không còn ở hàng đợi.");
    if (expectedRowVersion != null && Number(expectedRowVersion) !== Number(item.row_version)) {
      fail("VERSION_CONFLICT", "Khoản này vừa được cập nhật. Vui lòng xem lại.", { currentVersion: Number(item.row_version) });
    }
    const draft = { ...(item.draft_data || {}) };
    if (fields.direction != null) draft.direction = fields.direction;
    if (fields.entryType != null) { draft.entryType = fields.entryType; draft.direction = directionForEntryType(fields.entryType, draft.direction); }
    if (fields.amountVnd != null) draft.amountVnd = Math.trunc(Number(fields.amountVnd));
    if (fields.occurredAt != null) draft.occurredAt = fields.occurredAt;
    if (fields.paymentMethod != null) draft.paymentMethod = fields.paymentMethod;
    if (fields.note !== undefined) draft.note = fields.note;
    const status = draftIsReady(draft) ? "ready" : "open";
    const upd = await client.query(
      `update public.cashbook_review_items
          set draft_data=$3, status=$4, row_version=row_version+1
        where id=$1 and merchant_id=$2 returning row_version`,
      [reviewId, merchantId, JSON.stringify(draft), status]);
    await writeAudit(client, { merchantId, actorUserId: userId, action: "cashbook.reviewed",
      entityType: "cashbook_review_item", entityId: reviewId, before: item.draft_data, after: draft });
    return { ...mapReviewRow({ ...item, draft_data: draft, status, row_version: upd.rows[0].row_version }) };
  });
}

/** Compute the entry a review item would post, verifying the live source snapshot
 *  still matches (CBK-04/CBK-05). No commit. */
export async function previewReview(merchantId, reviewId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.cashbook_review_items where id=$1 and merchant_id=$2`, [reviewId, merchantId]);
    if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy khoản cần xem.");
    const item = rows[0];
    const d = item.draft_data || {};
    if (!draftIsReady(d)) fail("VALIDATION", "Còn thiếu thông tin bắt buộc.");
    await assertSourceUnchanged(client, merchantId, d);
    return {
      reviewItemId: reviewId, expectedRowVersion: Number(item.row_version),
      preview: {
        direction: d.direction, entryType: d.entryType,
        entryLabel: ENTRY_TYPES[d.entryType]?.label || d.entryType,
        amountVnd: Number(d.amountVnd), occurredAt: d.occurredAt,
        paymentMethod: d.paymentMethod, ruleVersion: d.ruleVersion || RULE_VERSION,
      },
      impact: { direction: d.direction, amountVnd: Number(d.amountVnd) },
    };
  });
}

/** For source-backed drafts, recompute the source hash from live data. A changed
 *  amount/date since the draft was captured blocks the post (spec §5). */
async function assertSourceUnchanged(client, merchantId, d) {
  if (!d.sourceHash || d.sourceType === "manual") return;
  let live = null;
  if (d.sourceType === "payment") {
    const { rows } = await client.query(`select amount, paid_at, method from public.payments where id=$1 and merchant_id=$2`, [d.sourceId, merchantId]);
    if (rows.length) live = { amountVnd: Number(rows[0].amount), occurredAt: rows[0].paid_at ? new Date(rows[0].paid_at).toISOString() : null, paymentMethod: rows[0].method };
  } else if (d.sourceType === "refund") {
    const { rows } = await client.query(`select amount, refunded_at, method from public.payment_refunds where id=$1 and merchant_id=$2`, [d.sourceId, merchantId]);
    if (rows.length) live = { amountVnd: Number(rows[0].amount), occurredAt: rows[0].refunded_at ? new Date(rows[0].refunded_at).toISOString() : null, paymentMethod: rows[0].method };
  } else if (d.sourceType === "purchase_receipt" || d.sourceType === "expense") {
    const { rows } = await client.query(`select amount_vnd, created_at from public.accounting_events where source_id=$1 and merchant_id=$2 and event_type=$3`, [d.sourceId, merchantId, d.sourceEventType]);
    if (rows.length) live = { amountVnd: Number(rows[0].amount_vnd), occurredAt: rows[0].created_at ? new Date(rows[0].created_at).toISOString() : null, paymentMethod: null };
  }
  if (live) {
    const liveHash = sourceHash({ sourceType: d.sourceType, sourceId: d.sourceId, sourceEventType: d.sourceEventType, ...live });
    if (liveHash !== d.sourceHash) {
      fail("VERSION_CONFLICT", "Dữ liệu nguồn vừa thay đổi. Vui lòng xem lại.", { code: "SOURCE_CHANGED" });
    }
  }
}

/** Post a reviewed item → one entry + source link, mark resolved. Idempotent on
 *  the source-link unique + the Idempotency-Key (spec §7.1 user-confirm). */
export async function postReview(merchantId, userId, reviewId, body = {}, idemKey) {
  const hash = bodyHash({ reviewId, ...body });
  const { result, replayed } = await runIdempotent(`cbk-post:${merchantId}`, idemKey, hash, async () => {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `select * from public.cashbook_review_items where id=$1 and merchant_id=$2 for update`, [reviewId, merchantId]);
      if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy khoản cần xem.");
      const item = rows[0];
      const d = item.draft_data || {};
      if (item.status === "resolved") {
        // Already posted → replay: find the linked entry.
        const link = await client.query(
          `select entry_id from public.cashbook_source_links
             where merchant_id=$1 and source_type=$2 and source_id=$3 and source_event_type=$4`,
          [merchantId, d.sourceType, d.sourceId, d.sourceEventType]);
        return { entryId: link.rows[0]?.entry_id ?? null, status: "posted", alreadyResolved: true };
      }
      if (item.status !== "open" && item.status !== "ready") fail("VALIDATION", "Khoản này không còn ở hàng đợi.");
      if (body.expectedRowVersion != null && Number(body.expectedRowVersion) !== Number(item.row_version)) {
        fail("VERSION_CONFLICT", "Khoản này vừa được cập nhật. Vui lòng xem lại.", { currentVersion: Number(item.row_version) });
      }
      if (!draftIsReady(d)) fail("VALIDATION", "Còn thiếu thông tin bắt buộc để ghi sổ.");
      await assertSourceUnchanged(client, merchantId, d);

      const source = {
        sourceType: d.sourceType, sourceId: d.sourceId, sourceEventType: d.sourceEventType,
        sourceVersion: 1,
        sourceHash: d.sourceHash || sourceHash({ sourceType: d.sourceType, sourceId: d.sourceId, sourceEventType: d.sourceEventType, amountVnd: d.amountVnd, occurredAt: d.occurredAt, paymentMethod: d.paymentMethod }),
      };
      const posted = await postEntryFromDraft(client, merchantId, userId, source, d);
      await client.query(
        `update public.cashbook_review_items set status='resolved', resolved_by=$3, row_version=row_version+1
          where id=$1 and merchant_id=$2`, [reviewId, merchantId, userId]);
      return { entryId: posted.entryId, status: "posted", replayed: posted.replayed };
    });
  });
  return { ...result, replayed: replayed || Boolean(result.alreadyResolved) };
}

async function postEntryFromDraft(client, merchantId, userId, source, d) {
  return postEntryTx(client, {
    merchantId, userId, source,
    entry: {
      direction: d.direction, entryType: d.entryType, amountVnd: Math.trunc(Number(d.amountVnd)),
      occurredAt: d.occurredAt, paymentMethod: d.paymentMethod,
    },
    ruleVersion: d.ruleVersion || RULE_VERSION,
  });
}

export async function excludeReview(merchantId, userId, reviewId, { reasonCode, note, expectedRowVersion } = {}) {
  if (!reasonCode || !EXCLUDE_REASONS[reasonCode]) fail("REASON_REQUIRED", "Vui lòng chọn lý do loại khoản.");
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select * from public.cashbook_review_items where id=$1 and merchant_id=$2 for update`, [reviewId, merchantId]);
    if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy khoản cần xem.");
    const item = rows[0];
    if (!["open", "ready"].includes(item.status)) fail("VALIDATION", "Khoản này không còn ở hàng đợi.");
    if (expectedRowVersion != null && Number(expectedRowVersion) !== Number(item.row_version)) {
      fail("VERSION_CONFLICT", "Khoản này vừa được cập nhật.", { currentVersion: Number(item.row_version) });
    }
    const draft = { ...(item.draft_data || {}), excludeReason: reasonCode, excludeNote: note ?? null };
    await client.query(
      `update public.cashbook_review_items set status='excluded', resolved_by=$3, draft_data=$4, row_version=row_version+1
         where id=$1 and merchant_id=$2`, [reviewId, merchantId, userId, JSON.stringify(draft)]);
    await writeAudit(client, { merchantId, actorUserId: userId, action: "cashbook.excluded",
      entityType: "cashbook_review_item", entityId: reviewId, after: { reasonCode, note: note ?? null } });
    return { reviewId, status: "excluded", reasonCode };
  });
}

/** Manual draft (spec §3.6 / FR-06). Creates a review item; never auto-posts. */
export async function createManualDraft(merchantId, userId, body = {}, idemKey) {
  const hash = bodyHash({ merchantId, ...body });
  const eventId = deterministicUuid(`manual:${merchantId}:${idemKey || hash}`);
  const { result, replayed } = await runIdempotent(`cbk-manual:${merchantId}`, idemKey, hash, async () => {
    const entryType = body.entryType && ENTRY_TYPES[body.entryType] ? body.entryType : null;
    const direction = entryType ? directionForEntryType(entryType, body.direction) : (body.direction || null);
    const draft = {
      schemaVersion: 1, sourceType: "manual", sourceId: eventId, sourceEventType: "manual.created",
      sourceLabel: "Ghi tay", direction, entryType,
      amountVnd: body.amountVnd != null ? Math.trunc(Number(body.amountVnd)) : null,
      occurredAt: body.occurredAt || null,
      paymentMethod: body.paymentMethod || "unknown", note: body.note ?? null,
      ruleVersion: RULE_VERSION,
    };
    const reasons = [];
    if (!draft.entryType) reasons.push("missing_type");
    if (!(Number(draft.amountVnd) > 0)) reasons.push("abnormal_amount");
    if (!draft.occurredAt) reasons.push("missing_date");
    if (draft.paymentMethod === "unknown") reasons.push("missing_payment_method");
    const status = draftIsReady(draft) ? "ready" : "open";
    return withTransaction(async (client) => {
      const ins = await client.query(
        `insert into public.cashbook_review_items (merchant_id, event_id, reason_codes, draft_data, status)
         values ($1,$2,$3,$4,$5)
         on conflict (merchant_id, event_id) do nothing returning id`,
        [merchantId, eventId, reasons, JSON.stringify(draft), status]);
      let id = ins.rows[0]?.id;
      if (!id) {
        const ex = await client.query(`select id from public.cashbook_review_items where merchant_id=$1 and event_id=$2`, [merchantId, eventId]);
        id = ex.rows[0]?.id;
      }
      await writeAudit(client, { merchantId, actorUserId: userId, action: "cashbook.reviewed",
        entityType: "cashbook_review_item", entityId: id, after: { manual: true, draft } });
      return { reviewId: id, status, eventId };
    });
  });
  return { ...result, replayed };
}

// ── Reverse / điều chỉnh (spec §3.7 / §4.3 / §7.1) ─────────────────────────────
export async function reverseEntry(merchantId, userId, entryId, body = {}, idemKey) {
  const reasonCode = body.reasonCode;
  if (!reasonCode || !REVERSAL_REASONS[reasonCode]) fail("REASON_REQUIRED", "Vui lòng chọn lý do điều chỉnh.");
  const note = (body.note || "").trim();
  const reason = note ? `${reasonCode}: ${note}` : reasonCode;
  const hash = bodyHash({ entryId, reasonCode, note });
  const { result, replayed } = await runIdempotent(`cbk-reverse:${merchantId}`, idemKey, hash, async () => {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `select * from public.cashbook_entries where id=$1 and merchant_id=$2 for update`, [entryId, merchantId]);
      if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy dòng sổ.");
      const orig = rows[0];
      if (orig.status !== "posted") fail("VALIDATION", "Chỉ dòng đã ghi mới có thể điều chỉnh.");
      // Already reversed? → replay the existing relation (CBK-006, one reversal).
      const existing = await client.query(
        `select adjustment_entry_id from public.cashbook_adjustments
           where merchant_id=$1 and original_entry_id=$2`, [merchantId, entryId]);
      if (existing.rows.length) {
        return { originalEntryId: entryId, reversalEntryId: existing.rows[0].adjustment_entry_id, alreadyReversed: true };
      }
      const oppositeDir = orig.direction === "in" ? "out" : "in";
      await client.query("SAVEPOINT cbk_rev");
      const ins = await client.query(
        `insert into public.cashbook_entries
           (merchant_id, direction, entry_type, amount_vnd, occurred_at, payment_method, status, rule_version, created_by)
         values ($1,$2,'adjustment',$3,$4,$5,'posted',$6,$7) returning id`,
        [merchantId, oppositeDir, orig.amount_vnd, orig.occurred_at, orig.payment_method, orig.rule_version, userId]);
      const contraId = ins.rows[0].id;
      const rel = await client.query(
        `insert into public.cashbook_adjustments (merchant_id, original_entry_id, adjustment_entry_id, reason, created_by)
         values ($1,$2,$3,$4,$5)
         on conflict (merchant_id, original_entry_id) do nothing returning id`,
        [merchantId, entryId, contraId, reason, userId]);
      if (rel.rows.length === 0) {
        // Concurrent reversal won → drop our contra, replay theirs.
        await client.query("ROLLBACK TO SAVEPOINT cbk_rev");
        const ex = await client.query(
          `select adjustment_entry_id from public.cashbook_adjustments where merchant_id=$1 and original_entry_id=$2`, [merchantId, entryId]);
        return { originalEntryId: entryId, reversalEntryId: ex.rows[0]?.adjustment_entry_id ?? null, alreadyReversed: true };
      }
      await client.query("RELEASE SAVEPOINT cbk_rev");
      await writeAudit(client, { merchantId, actorUserId: userId, action: "cashbook.reversed",
        entityType: "cashbook_entry", entityId: entryId,
        after: { reversalEntryId: contraId, reason, originalDirection: orig.direction, amountVnd: Number(orig.amount_vnd) } });
      return { originalEntryId: entryId, reversalEntryId: contraId, alreadyReversed: false };
    });
  });
  return { ...result, replayed: replayed || Boolean(result.alreadyReversed) };
}

export { REASON_CODES, EXCLUDE_REASONS, REVERSAL_REASONS };
