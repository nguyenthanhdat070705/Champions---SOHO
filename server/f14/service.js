// Functional 14 — "Chốt tiền cuối ngày" SERVICE (spec §7 ownership, §7.1 atomic
// boundaries, §10 API). Every mutation runs in ONE pooler transaction (the
// F3/F5/F11 pattern); the caller is authorised (JWT + role) in the router before
// reaching here, and every read is merchant-scoped (`where merchant_id=$mid`) so
// the pooler's RLS-bypass never leaks across tenants (CLS-12).
//
// Design notes carried from the F14 brief:
//  • Schema is deployed; there is NO closing_previews table and NO DB functions —
//    the preview is built in-memory and bound by a preview_hash the confirm echoes.
//  • Expected cash = Σ(cash payments succeeded) − Σ(cash refunds succeeded) inside
//    the business-day window (merchant timezone). QR is reference-only, never in
//    the drawer total.
//  • A confirmed revision is immutable; a fix is a NEW revision chained via
//    previous_revision_id. Late cash after cut-off → an attention item, never a
//    silent edit of the confirmed revision.
import { withTransaction, query } from "../db/pool.js";
import { writeAudit, enqueueOutbox } from "../f3/audit.js";
import { DomainError, fail } from "../f3/errors.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { deterministicUuid } from "../f5/movements.js";
import {
  POLICY_VERSION, DENOMINATIONS, REASON_CODES, ATTENTION_DECISIONS,
  computeCount, expectedCash, variance, classifyVariance, reasonRequired,
  validateReason, sourceSetHash, previewHash, contentHash, sourceFingerprint,
} from "./closing.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Merchant closing policy snapshot (timezone + business-day start). */
async function merchantPolicy(client, merchantId) {
  const { rows } = await client.query(
    `select coalesce(timezone,'Asia/Ho_Chi_Minh') as timezone,
            coalesce(business_day_start,'00:00'::time) as business_day_start
       from public.merchant_settings where merchant_id=$1`,
    [merchantId],
  );
  if (rows.length) return { timezone: rows[0].timezone, businessDayStart: rows[0].business_day_start };
  return { timezone: "Asia/Ho_Chi_Minh", businessDayStart: "00:00:00" };
}

/** 'YYYY-MM-DD' from a pg date/Date without a timezone shift (local components). */
function isoDate(d) {
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(d).slice(0, 10);
}

/** Server "today" business date in the merchant timezone (spec §4.4 no device tz). */
async function serverBusinessDate(client, tz) {
  const { rows } = await client.query(
    `select to_char((timezone($1, now()))::date, 'YYYY-MM-DD') as d`, [tz],
  );
  return rows[0].d;
}

/**
 * Live cash source facts inside a business-day window (spec §4.1). Cash payments
 * succeeded (in) and cash refunds succeeded (out); QR is fetched separately for
 * reference. The [start,end) bounds honour a non-midnight business_day_start.
 */
async function loadCashSources(client, merchantId, businessDate, tz, businessDayStart) {
  const winStart = `(($1::date) + $2::time) at time zone $3`;
  const winEnd = `(($1::date + 1) + $2::time) at time zone $3`;
  const args = [businessDate, businessDayStart, tz, merchantId];
  const payments = await client.query(
    `select p.id, p.order_id, p.amount, p.paid_at
       from public.payments p
      where p.merchant_id=$4 and p.status='succeeded' and p.method='cash'
        and p.paid_at >= ${winStart} and p.paid_at < ${winEnd}
      order by p.paid_at asc`,
    args,
  );
  const refunds = await client.query(
    `select r.id, r.order_id, r.amount, r.refunded_at
       from public.payment_refunds r
      where r.merchant_id=$4 and r.status='succeeded' and r.method='cash'
        and r.refunded_at >= ${winStart} and r.refunded_at < ${winEnd}
      order by r.refunded_at asc`,
    args,
  );
  const sources = [
    ...payments.rows.map((p) => ({
      sourceType: "payment", sourceId: p.id, eventType: "payment.succeeded",
      direction: "in", paymentMethod: "cash", amountVnd: Number(p.amount),
      occurredAt: p.paid_at, receivedAt: p.paid_at, orderId: p.order_id,
    })),
    ...refunds.rows.map((r) => ({
      sourceType: "refund", sourceId: r.id, eventType: "refund.succeeded",
      direction: "out", paymentMethod: "cash", amountVnd: Number(r.amount),
      occurredAt: r.refunded_at, receivedAt: r.refunded_at, orderId: r.order_id,
    })),
  ];
  return { sources, cashBillCount: payments.rows.length, cashRefundCount: refunds.rows.length };
}

/** Recorded (SoHo-side) QR/transfer money in the window — reference only (§3.4). */
async function loadElectronicRecorded(client, merchantId, businessDate, tz, businessDayStart) {
  const { rows } = await client.query(
    `select coalesce(sum(p.amount),0)::bigint as total, count(*)::int as cnt
       from public.payments p
      where p.merchant_id=$4 and p.status='succeeded' and p.method='qr'
        and p.paid_at >= (($1::date) + $2::time) at time zone $3
        and p.paid_at <  (($1::date + 1) + $2::time) at time zone $3`,
    [businessDate, businessDayStart, tz, merchantId],
  );
  return { recordedQrVnd: Number(rows[0].total), qrCount: rows[0].cnt };
}

/** Route a source to a client deep-link (spec §2.2 drill-down). */
function sourceRoute(s) {
  if (s.sourceType === "payment" || s.sourceType === "refund") {
    return s.orderId ? `/don-hang/${s.orderId}` : null;
  }
  return null;
}

function draftSummary(draft, closing) {
  return {
    id: draft.id, closingId: draft.closing_id, status: draft.status,
    cutOffAt: draft.cut_off_at, sourceSetHash: draft.source_set_hash,
    policyVersion: draft.policy_version, rowVersion: draft.row_version,
    businessDate: isoDate(closing.business_date), timezone: closing.timezone,
  };
}

// ── Prepare (spec §3.2 / §7.1 "Prepare") ─────────────────────────────────────────

/**
 * Create-or-reuse the active draft for (merchant, business_date) and freeze the
 * current cash source set into snapshots. Idempotent: the same business date
 * returns the same active draft (CLS_002). Re-preparing an already-confirmed
 * closing starts a NEW draft (the re-close path → revision n+1).
 */
export async function prepareClosing(merchantId, userId, body = {}) {
  const policy = await withTransaction((c) => merchantPolicy(c, merchantId));
  const tz = policy.timezone;
  return withTransaction(async (client) => {
    const today = await serverBusinessDate(client, tz);
    const businessDate = String(body.businessDate || today).slice(0, 10);
    // Guard: today or earlier only (spec: default today, yesterday allowed; a
    // future date has no committed sources).
    if (businessDate > today) fail("VALIDATION", "Không thể chốt cho ngày trong tương lai.");

    // Upsert the logical closing (unique merchant+business_date).
    await client.query(
      `insert into public.daily_closings (merchant_id, business_date, timezone, status)
       values ($1,$2,$3,'draft')
       on conflict (merchant_id, business_date) do nothing`,
      [merchantId, businessDate, tz],
    );
    const closingRes = await client.query(
      `select * from public.daily_closings where merchant_id=$1 and business_date=$2 for update`,
      [merchantId, businessDate],
    );
    const closing = closingRes.rows[0];

    // Reuse an in-progress draft; otherwise open a fresh one (first close OR re-close).
    let draft = null;
    if (closing.active_draft_id) {
      const d = await client.query(
        `select * from public.closing_drafts where id=$1 and merchant_id=$2 for update`,
        [closing.active_draft_id, merchantId],
      );
      if (d.rows.length && ["preparing", "draft", "review", "ready"].includes(d.rows[0].status)) {
        draft = d.rows[0];
      }
    }
    const cutOffAt = draft ? draft.cut_off_at : new Date();
    if (!draft) {
      const ins = await client.query(
        `insert into public.closing_drafts
           (merchant_id, closing_id, cut_off_at, source_set_hash, policy_version, status, created_by)
         values ($1,$2,now(),'',$3,'draft',$4) returning *`,
        [merchantId, closing.id, POLICY_VERSION, userId],
      );
      draft = ins.rows[0];
    }

    // Freeze current cash sources into snapshots (idempotent on the unique tuple).
    const { sources } = await loadCashSources(client, merchantId, businessDate, tz, policy.businessDayStart);
    for (const s of sources) {
      await client.query(
        `insert into public.closing_source_snapshots
           (merchant_id, draft_id, source_type, source_id, event_type, payment_method, direction, amount_vnd, occurred_at, received_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (draft_id, source_type, source_id, event_type) do nothing`,
        [merchantId, draft.id, s.sourceType, s.sourceId, s.eventType, s.paymentMethod, s.direction, s.amountVnd, s.occurredAt, s.receivedAt],
      );
    }
    const ssh = sourceSetHash(sources);
    if (draft.source_set_hash !== ssh || draft.status === "preparing") {
      const upd = await client.query(
        `update public.closing_drafts set source_set_hash=$1, status='draft', row_version=row_version+1
           where id=$2 returning *`,
        [ssh, draft.id],
      );
      draft = upd.rows[0];
    }
    if (closing.active_draft_id !== draft.id) {
      await client.query(
        `update public.daily_closings set active_draft_id=$1, row_version=row_version+1 where id=$2`,
        [draft.id, closing.id],
      );
    }
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "closing.preparation_started",
      entityType: "closing_draft", entityId: draft.id,
      after: { businessDate, cutOffAt, sourceCount: sources.length, sourceSetHash: ssh },
    });
    // Return the full working view (draft + expected + sources + latest count).
    return draftDetailFromClient(client, merchantId, draft.id);
  });
}

// ── Draft detail / count history ────────────────────────────────────────────────

async function draftDetailFromClient(client, merchantId, draftId) {
  const d = await client.query(
    `select d.*, c.business_date, c.timezone, c.status as closing_status, c.current_revision_id
       from public.closing_drafts d join public.daily_closings c on c.id=d.closing_id
      where d.id=$1 and d.merchant_id=$2`,
    [draftId, merchantId],
  );
  if (!d.rows.length) fail("CLOSING_DRAFT_NOT_FOUND");
  const draft = d.rows[0];
  const snaps = await client.query(
    `select * from public.closing_source_snapshots where draft_id=$1 and merchant_id=$2 order by occurred_at asc`,
    [draftId, merchantId],
  );
  const sources = snaps.rows.map((s) => ({
    sourceType: s.source_type, sourceId: s.source_id, eventType: s.event_type,
    direction: s.direction, paymentMethod: s.payment_method, amountVnd: Number(s.amount_vnd),
    occurredAt: s.occurred_at, route: null,
  }));
  // Resolve deep-links (order id) for payment/refund snapshots.
  await attachRoutes(client, merchantId, sources);
  const exp = expectedCash(sources);
  const counts = await client.query(
    `select * from public.cash_counts where draft_id=$1 and merchant_id=$2 order by version_no desc`,
    [draftId, merchantId],
  );
  const latest = counts.rows[0] || null;
  const countedCashVnd = latest ? Number(latest.counted_total_vnd) : null;
  const v = countedCashVnd === null ? null : variance(countedCashVnd, exp.expectedCashVnd);
  return {
    draft: {
      id: draft.id, closingId: draft.closing_id, status: draft.status,
      cutOffAt: draft.cut_off_at, sourceSetHash: draft.source_set_hash,
      policyVersion: draft.policy_version, rowVersion: draft.row_version,
      businessDate: isoDate(draft.business_date), timezone: draft.timezone,
      closingStatus: draft.closing_status, isReclose: Boolean(draft.current_revision_id),
    },
    expected: {
      expectedCashVnd: exp.expectedCashVnd, inflowVnd: exp.inflowVnd, outflowVnd: exp.outflowVnd,
      cashBillCount: sources.filter((s) => s.sourceType === "payment").length,
      cashRefundCount: sources.filter((s) => s.sourceType === "refund").length,
    },
    sources: sources.map((s) => ({
      sourceType: s.sourceType, sourceId: s.sourceId, eventType: s.eventType,
      direction: s.direction, amountVnd: s.amountVnd, occurredAt: s.occurredAt, route: s.route,
    })),
    counts: counts.rows.map(countRow),
    latestCount: latest ? countRow(latest) : null,
    countedCashVnd, variance: v, varianceClass: v === null ? null : classifyVariance(v),
    denominations: DENOMINATIONS,
  };
}

async function attachRoutes(client, merchantId, sources) {
  const orderable = sources.filter((s) => s.sourceType === "payment" || s.sourceType === "refund");
  if (!orderable.length) return;
  const payIds = orderable.filter((s) => s.sourceType === "payment").map((s) => s.sourceId);
  const refIds = orderable.filter((s) => s.sourceType === "refund").map((s) => s.sourceId);
  const map = new Map();
  if (payIds.length) {
    const { rows } = await client.query(
      `select id, order_id from public.payments where merchant_id=$1 and id = any($2::uuid[])`, [merchantId, payIds]);
    for (const r of rows) map.set(`payment:${r.id}`, r.order_id);
  }
  if (refIds.length) {
    const { rows } = await client.query(
      `select id, order_id from public.payment_refunds where merchant_id=$1 and id = any($2::uuid[])`, [merchantId, refIds]);
    for (const r of rows) map.set(`refund:${r.id}`, r.order_id);
  }
  for (const s of sources) {
    const oid = map.get(`${s.sourceType}:${s.sourceId}`);
    s.route = oid ? `/don-hang/${oid}` : null;
  }
}

function countRow(c) {
  return {
    id: c.id, versionNo: c.version_no, mode: c.mode,
    countedTotalVnd: Number(c.counted_total_vnd),
    denominationLines: c.denomination_lines || [],
    countedAt: c.counted_at, countedBy: c.counted_by,
  };
}

export async function getDraft(merchantId, draftId) {
  return withTransaction((client) => draftDetailFromClient(client, merchantId, draftId));
}

// ── Save count (spec §3.3 / §7.1 "Save count") ───────────────────────────────────

/**
 * Save an independent count version (spec §3.3 "Đếm lại không ghi đè"). The
 * server computes the total from the denomination lines / typed total; the
 * client sum is never trusted. Idempotent on (draft, client_count_id) → a retry
 * returns the SAME version (CLS_004 replay).
 */
export async function saveCount(merchantId, userId, draftId, body = {}) {
  const clientCountId = String(body.clientCountId || "").trim();
  if (!clientCountId) fail("VALIDATION", "Thiếu clientCountId.");
  const mode = body.mode === "denomination" ? "denomination" : "total";
  let computed;
  try {
    computed = computeCount(mode, body);
  } catch (e) {
    fail("VALIDATION", "Số tiền đếm không hợp lệ (" + e.message + ").");
  }
  return withTransaction(async (client) => {
    const d = await client.query(
      `select * from public.closing_drafts where id=$1 and merchant_id=$2 for update`, [draftId, merchantId]);
    if (!d.rows.length) fail("CLOSING_DRAFT_NOT_FOUND");
    if (d.rows[0].status === "confirmed" || d.rows[0].status === "cancelled") fail("CLOSING_DRAFT_LOCKED");

    // Replay: same client_count_id already stored.
    const existing = await client.query(
      `select * from public.cash_counts where draft_id=$1 and client_count_id=$2`, [draftId, clientCountId]);
    if (existing.rows.length) {
      return draftDetailFromClient(client, merchantId, draftId);
    }
    const nextNo = await client.query(
      `select coalesce(max(version_no),0)+1 as n from public.cash_counts where draft_id=$1`, [draftId]);
    await client.query(
      `insert into public.cash_counts
         (merchant_id, draft_id, client_count_id, version_no, mode, denomination_lines, counted_total_vnd, counted_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [merchantId, draftId, clientCountId, nextNo.rows[0].n, mode, JSON.stringify(computed.lines), computed.countedTotalVnd, userId],
    );
    // Move the draft into 'review' once a count exists (still editable).
    if (d.rows[0].status === "draft") {
      await client.query(`update public.closing_drafts set status='review', row_version=row_version+1 where id=$1`, [draftId]);
    }
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "closing.count_saved",
      entityType: "cash_count", entityId: draftId,
      after: { versionNo: nextNo.rows[0].n, mode, countedTotalVnd: computed.countedTotalVnd },
    });
    return draftDetailFromClient(client, merchantId, draftId);
  });
}

// ── Preview (spec §3.6 / §5.1) ───────────────────────────────────────────────────

/**
 * Build the pre-confirm preview: recompute expected from the frozen snapshots,
 * counted from the chosen (or latest) count, the variance, and a preview_hash
 * the confirm call must echo. If the LIVE source set has drifted from the frozen
 * snapshot (a bill arrived after prepare), the preview is invalid → 409 forcing a
 * re-prepare (CLS-07).
 */
export async function previewClosing(merchantId, draftId, body = {}) {
  const policy = await withTransaction((c) => merchantPolicy(c, merchantId));
  return withTransaction(async (client) => {
    const detail = await draftDetailFromClient(client, merchantId, draftId);
    if (detail.draft.status === "confirmed") fail("CLOSING_ALREADY_CONFIRMED");
    if (detail.draft.status === "cancelled") fail("CLOSING_DRAFT_LOCKED");

    // Source-drift check: does the frozen hash still match live?
    const { sources: live } = await loadCashSources(
      client, merchantId, detail.draft.businessDate, detail.draft.timezone, policy.businessDayStart);
    const liveHash = sourceSetHash(live);
    if (liveHash !== detail.draft.sourceSetHash) {
      fail("CLOSING_SOURCE_CHANGED", undefined, { sourceSetHash: liveHash });
    }

    // Resolve the count version to confirm against.
    let count = detail.latestCount;
    if (body.countVersion != null) {
      count = detail.counts.find((c) => c.versionNo === Number(body.countVersion)) || null;
    }
    if (!count) fail("CLOSING_COUNT_REQUIRED");

    const expected = detail.expected.expectedCashVnd;
    const counted = count.countedTotalVnd;
    const v = variance(counted, expected);
    const need = reasonRequired(v);
    const reasonCode = body.reasonCode || null;
    const reasonNote = body.reasonNote || null;
    const reasonError = validateReason(v, reasonCode, reasonNote);

    const ph = previewHash({
      draftId, sourceSetHash: detail.draft.sourceSetHash, countedCashVnd: counted,
      reasonCode, reasonNote,
    });
    return {
      draftId, closingId: detail.draft.closingId, businessDate: detail.draft.businessDate,
      timezone: detail.draft.timezone, cutOffAt: detail.draft.cutOffAt,
      expectedCashVnd: expected, countedCashVnd: counted, varianceVnd: v,
      varianceClass: classifyVariance(v), reasonRequired: need,
      reasonCode, reasonNote, reasonError,
      countVersion: count.versionNo, sourceSetHash: detail.draft.sourceSetHash,
      draftVersion: detail.draft.rowVersion, previewHash: ph,
      isReclose: detail.draft.isReclose,
      inflowVnd: detail.expected.inflowVnd, outflowVnd: detail.expected.outflowVnd,
    };
  });
}

// ── Confirm (spec §3.7 CTA / §7.1 "Confirm" atomic) ──────────────────────────────

/**
 * Confirm the draft into an immutable revision. Atomic: revision insert + closing
 * pointer + draft lock + audit + outbox. Idempotent: a same-key double-tap or a
 * replay of an already-confirmed draft returns the SAME revision (CLS-08), never a
 * second one. The revision id is deterministic per draft so the replay is durable.
 */
export async function confirmClosing(merchantId, userId, draftId, body = {}, idempotencyKey) {
  if (!idempotencyKey) fail("IDEMPOTENCY_KEY_REQUIRED");
  const hash = bodyHash({ draftId, ...body });
  const policy = await withTransaction((c) => merchantPolicy(c, merchantId));
  const { result, replayed } = await runIdempotent(`f14:confirm:${draftId}`, idempotencyKey, hash, async () => {
    return withTransaction(async (client) => {
      const d = await client.query(
        `select * from public.closing_drafts where id=$1 and merchant_id=$2 for update`, [draftId, merchantId]);
      if (!d.rows.length) fail("CLOSING_DRAFT_NOT_FOUND");
      const draft = d.rows[0];
      const closingRes = await client.query(
        `select * from public.daily_closings where id=$1 and merchant_id=$2 for update`, [draft.closing_id, merchantId]);
      const closing = closingRes.rows[0];

      const revisionId = deterministicUuid(`f14-closing-revision:${draftId}`);
      // Replay: this draft already produced its revision.
      if (draft.status === "confirmed") {
        const rev = await client.query(
          `select id, revision_no, expected_cash_vnd, counted_cash_vnd, variance_vnd
             from public.closing_revisions where id=$1`, [revisionId]);
        const r = rev.rows[0];
        return {
          closingId: closing.id, revisionId, revisionNo: r ? r.revision_no : null,
          expectedCashVnd: r ? Number(r.expected_cash_vnd) : null,
          countedCashVnd: r ? Number(r.counted_cash_vnd) : null,
          varianceVnd: r ? Number(r.variance_vnd) : null, replayed: true,
        };
      }
      if (draft.status === "cancelled") fail("CLOSING_DRAFT_LOCKED");
      if (body.responsibilityConfirmed !== true) fail("CLOSING_CONSENT_REQUIRED");

      // Recompute the frozen source set + guard against drift since preview.
      const snaps = await client.query(
        `select source_type, source_id, event_type, direction, amount_vnd
           from public.closing_source_snapshots where draft_id=$1 and merchant_id=$2`, [draftId, merchantId]);
      const frozen = snaps.rows.map((s) => ({
        sourceType: s.source_type, sourceId: s.source_id, eventType: s.event_type,
        direction: s.direction, amountVnd: Number(s.amount_vnd),
      }));
      const { sources: live } = await loadCashSources(
        client, merchantId, isoDate(closing.business_date), closing.timezone, policy.businessDayStart);
      const liveHash = sourceSetHash(live);
      if (liveHash !== draft.source_set_hash || sourceSetHash(frozen) !== draft.source_set_hash) {
        fail("CLOSING_SOURCE_CHANGED", undefined, { sourceSetHash: liveHash });
      }

      // Counted (chosen or latest) — server-owned.
      let countRes;
      if (body.countVersion != null) {
        countRes = await client.query(
          `select * from public.cash_counts where draft_id=$1 and version_no=$2`, [draftId, Number(body.countVersion)]);
      } else {
        countRes = await client.query(
          `select * from public.cash_counts where draft_id=$1 order by version_no desc limit 1`, [draftId]);
      }
      if (!countRes.rows.length) fail("CLOSING_COUNT_REQUIRED");
      const counted = Number(countRes.rows[0].counted_total_vnd);
      const exp = expectedCash(frozen);
      const expected = exp.expectedCashVnd;
      const v = variance(counted, expected);

      const reasonCode = v !== 0 ? (body.reasonCode || null) : null;
      const reasonNote = v !== 0 ? (body.reasonNote || null) : null;
      const reasonError = validateReason(v, reasonCode, reasonNote);
      if (reasonError) fail(reasonError);

      // Preview hash must echo exactly what we are about to write (CLS-05/07).
      const expectHash = previewHash({
        draftId, sourceSetHash: draft.source_set_hash, countedCashVnd: counted, reasonCode, reasonNote });
      if (String(body.previewHash || "") !== expectHash) {
        fail("CLOSING_PREVIEW_STALE", undefined, { previewHash: expectHash });
      }

      const nextNo = await client.query(
        `select coalesce(max(revision_no),0)+1 as n from public.closing_revisions where closing_id=$1`, [closing.id]);
      const revisionNo = nextNo.rows[0].n;
      const previousRevisionId = closing.current_revision_id || null;
      const ch = contentHash({
        closingId: closing.id, revisionNo, sourceSetHash: draft.source_set_hash,
        expectedCashVnd: expected, countedCashVnd: counted, reasonCode, reasonNote, previousRevisionId });

      await client.query(
        `insert into public.closing_revisions
           (id, merchant_id, closing_id, revision_no, source_set_hash, expected_cash_vnd, counted_cash_vnd,
            reason_code, reason_note, previous_revision_id, confirmed_by, content_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [revisionId, merchantId, closing.id, revisionNo, draft.source_set_hash, expected, counted,
         reasonCode, reasonNote, previousRevisionId, userId, ch],
      );
      await client.query(
        `update public.daily_closings
            set status='confirmed', current_revision_id=$1, active_draft_id=null, row_version=row_version+1
          where id=$2`,
        [revisionId, closing.id],
      );
      await client.query(
        `update public.closing_drafts set status='confirmed', row_version=row_version+1 where id=$1`, [draftId]);

      // Re-close resolves any open late-source attention items on this closing.
      if (previousRevisionId) {
        await client.query(
          `update public.closing_attention_items
              set status='resolved', decision='reclosed', resolved_by=$2, resolved_at=now()
            where closing_id=$1 and status='open'`,
          [closing.id, userId],
        );
      }
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "closing.confirmed",
        entityType: "closing_revision", entityId: revisionId,
        after: { revisionNo, expectedCashVnd: expected, countedCashVnd: counted, varianceVnd: v, reasonCode, contentHash: ch },
      });
      await enqueueOutbox(client, {
        merchantId, eventType: "closing.confirmed", aggregateId: closing.id,
        payload: { revisionId, revisionNo, businessDate: isoDate(closing.business_date), expectedCashVnd: expected, countedCashVnd: counted, varianceVnd: v },
      });
      return {
        closingId: closing.id, revisionId, revisionNo,
        expectedCashVnd: expected, countedCashVnd: counted, varianceVnd: v, replayed: false,
      };
    });
  });
  // A same-key double-tap that hit the in-process cache is a replay even though
  // the cached inner result was produced by the first (non-replay) run.
  return replayed ? { ...result, replayed: true } : result;
}

// ── Reads: list / detail / revisions ─────────────────────────────────────────────

export async function listClosings(merchantId, { from, to } = {}) {
  const policy = await withTransaction((c) => merchantPolicy(c, merchantId));
  const today = (await query(`select to_char((timezone($1, now()))::date,'YYYY-MM-DD') as d`, [policy.timezone])).rows[0].d;
  const lo = from || subtractDays(today, 30);
  const hi = to || today;
  const { rows } = await query(
    `select c.*, r.expected_cash_vnd, r.counted_cash_vnd, r.variance_vnd, r.revision_no, r.confirmed_at,
            (select count(*) from public.closing_attention_items a where a.closing_id=c.id and a.status='open')::int as open_attention
       from public.daily_closings c
       left join public.closing_revisions r on r.id=c.current_revision_id
      where c.merchant_id=$1 and c.business_date between $2 and $3
      order by c.business_date desc`,
    [merchantId, lo, hi],
  );
  return {
    today, timezone: policy.timezone, from: lo, to: hi,
    closings: rows.map((c) => ({
      id: c.id, businessDate: isoDate(c.business_date), timezone: c.timezone, status: c.status,
      currentRevisionId: c.current_revision_id, activeDraftId: c.active_draft_id,
      revisionNo: c.revision_no || null,
      expectedCashVnd: c.expected_cash_vnd == null ? null : Number(c.expected_cash_vnd),
      countedCashVnd: c.counted_cash_vnd == null ? null : Number(c.counted_cash_vnd),
      varianceVnd: c.variance_vnd == null ? null : Number(c.variance_vnd),
      confirmedAt: c.confirmed_at || null, openAttention: c.open_attention,
    })),
  };
}

function revisionRow(r) {
  return {
    id: r.id, revisionNo: r.revision_no, sourceSetHash: r.source_set_hash,
    expectedCashVnd: Number(r.expected_cash_vnd), countedCashVnd: Number(r.counted_cash_vnd),
    varianceVnd: Number(r.variance_vnd), varianceClass: classifyVariance(Number(r.variance_vnd)),
    reasonCode: r.reason_code, reasonNote: r.reason_note, reasonLabel: r.reason_code ? (REASON_CODES[r.reason_code]?.label || r.reason_code) : null,
    previousRevisionId: r.previous_revision_id, confirmedBy: r.confirmed_by, confirmedAt: r.confirmed_at,
    contentHash: r.content_hash,
  };
}

export async function getClosing(merchantId, closingId) {
  return withTransaction(async (client) => {
    const cRes = await client.query(
      `select * from public.daily_closings where id=$1 and merchant_id=$2`, [closingId, merchantId]);
    if (!cRes.rows.length) fail("CLOSING_NOT_FOUND");
    const closing = cRes.rows[0];
    const revsRes = await client.query(
      `select * from public.closing_revisions where closing_id=$1 and merchant_id=$2 order by revision_no desc`,
      [closingId, merchantId]);
    const revisions = revsRes.rows.map(revisionRow);
    const current = revisions.find((r) => r.id === closing.current_revision_id) || null;
    const attnRes = await client.query(
      `select * from public.closing_attention_items where closing_id=$1 and merchant_id=$2 order by status='open' desc, id`,
      [closingId, merchantId]);
    const attentionItems = attnRes.rows.map(attentionRow);

    // Live late-source count (read-only) — the badge appears before a scan write.
    let liveLate = [];
    if (current) {
      liveLate = await computeLateSources(client, merchantId, closing, current.id);
    }
    return {
      closing: {
        id: closing.id, businessDate: isoDate(closing.business_date), timezone: closing.timezone,
        status: closing.status, currentRevisionId: closing.current_revision_id,
        activeDraftId: closing.active_draft_id, rowVersion: closing.row_version,
      },
      current, revisions, attentionItems,
      lateSources: liveLate,
      openAttentionCount: attentionItems.filter((a) => a.status === "open").length,
    };
  });
}

export async function getRevisions(merchantId, closingId) {
  const { rows } = await query(
    `select * from public.closing_revisions where closing_id=$1 and merchant_id=$2 order by revision_no desc`,
    [closingId, merchantId]);
  return { revisions: rows.map(revisionRow) };
}

function attentionRow(a) {
  return {
    id: a.id, closingId: a.closing_id, revisionId: a.revision_id, status: a.status,
    sourceFingerprint: a.source_fingerprint, sourceRef: a.source_ref || {},
    impactVnd: Number(a.impact_vnd), decision: a.decision,
    resolvedBy: a.resolved_by, resolvedAt: a.resolved_at,
  };
}

// ── Late sources (spec §3.7 / §7.1 "Late source") ───────────────────────────────

/**
 * Live set-difference: cash sources currently in the window that are NOT in ANY
 * snapshot of this closing's drafts → a late source (spec §1.2, §5.1). Read-only;
 * the persist step is scanLateSources().
 */
async function computeLateSources(client, merchantId, closing, currentRevisionId) {
  const policy = await merchantPolicy(client, merchantId);
  const { sources } = await loadCashSources(
    client, merchantId, isoDate(closing.business_date), closing.timezone, policy.businessDayStart);
  const snapped = await client.query(
    `select s.source_type, s.source_id, s.event_type
       from public.closing_source_snapshots s
       join public.closing_drafts d on d.id=s.draft_id
      where d.closing_id=$1 and s.merchant_id=$2`,
    [closing.id, merchantId]);
  const seen = new Set(snapped.rows.map((r) => `${r.source_type}:${r.source_id}:${r.event_type}`));
  await attachRoutes(client, merchantId, sources);
  return sources
    .filter((s) => !seen.has(`${s.sourceType}:${s.sourceId}:${s.eventType}`))
    .map((s) => ({
      sourceType: s.sourceType, sourceId: s.sourceId, eventType: s.eventType,
      direction: s.direction, amountVnd: s.amountVnd, occurredAt: s.occurredAt,
      route: s.route, revisionId: currentRevisionId,
      fingerprint: sourceFingerprint(s.sourceType, s.sourceId, s.eventType),
    }));
}

/**
 * Persist late sources as attention items against the current revision and flip
 * the closing to 'attention' when any are open (spec §3.7, CLS-10). Idempotent on
 * the (revision_id, source_fingerprint) unique — the SAME event yields exactly one
 * attention item (CLS-FR-11).
 */
export async function scanLateSources(merchantId, userId, closingId) {
  return withTransaction(async (client) => {
    const cRes = await client.query(
      `select * from public.daily_closings where id=$1 and merchant_id=$2 for update`, [closingId, merchantId]);
    if (!cRes.rows.length) fail("CLOSING_NOT_FOUND");
    const closing = cRes.rows[0];
    if (!closing.current_revision_id) return { detected: 0, items: [] };

    const late = await computeLateSources(client, merchantId, closing, closing.current_revision_id);
    let detected = 0;
    for (const s of late) {
      const impact = s.direction === "in" ? s.amountVnd : -s.amountVnd;
      const ins = await client.query(
        `insert into public.closing_attention_items
           (merchant_id, closing_id, revision_id, source_fingerprint, source_ref, impact_vnd, status)
         values ($1,$2,$3,$4,$5,$6,'open')
         on conflict (revision_id, source_fingerprint) do nothing returning id`,
        [merchantId, closing.id, closing.current_revision_id, s.fingerprint,
         JSON.stringify({ sourceType: s.sourceType, sourceId: s.sourceId, eventType: s.eventType, amountVnd: s.amountVnd, occurredAt: s.occurredAt, route: s.route }),
         impact],
      );
      if (ins.rows.length) detected++;
    }
    const openRes = await client.query(
      `select count(*)::int as n from public.closing_attention_items where closing_id=$1 and status='open'`, [closing.id]);
    const open = openRes.rows[0].n;
    const nextStatus = open > 0 ? "attention" : "confirmed";
    if (closing.status !== nextStatus && (closing.status === "confirmed" || closing.status === "attention")) {
      await client.query(
        `update public.daily_closings set status=$1, row_version=row_version+1 where id=$2`, [nextStatus, closing.id]);
    }
    if (detected > 0) {
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "closing.late_source_detected",
        entityType: "daily_closing", entityId: closing.id, after: { detected, open },
      });
    }
    const items = (await client.query(
      `select * from public.closing_attention_items where closing_id=$1 and merchant_id=$2 order by status='open' desc, id`,
      [closing.id, merchantId])).rows.map(attentionRow);
    return { detected, open, status: nextStatus, items };
  });
}

/**
 * Resolve an attention item WITHOUT a re-close (dismiss): the source is judged not
 * to belong to this drawer/day (spec §3.7 "Không tính"). Re-closing is the other
 * resolution path and happens through confirm. Flips the closing back to
 * 'confirmed' when no open items remain.
 */
export async function resolveAttention(merchantId, userId, attentionId, body = {}) {
  const decision = body.decision === "dismissed" ? "dismissed" : null;
  if (!decision) fail("VALIDATION", "Chỉ hỗ trợ quyết định 'dismissed' ở đây; chốt lại để tạo bản sửa đổi.");
  return withTransaction(async (client) => {
    const aRes = await client.query(
      `select * from public.closing_attention_items where id=$1 and merchant_id=$2 for update`, [attentionId, merchantId]);
    if (!aRes.rows.length) fail("CLOSING_ATTENTION_NOT_FOUND");
    const a = aRes.rows[0];
    if (a.status !== "open") return { attentionId, status: a.status, replayed: true };
    await client.query(
      `update public.closing_attention_items
          set status='dismissed', decision=$2, resolved_by=$3, resolved_at=now() where id=$1`,
      [attentionId, body.note ? `dismissed:${String(body.note).slice(0, 200)}` : "dismissed", userId]);
    const openRes = await client.query(
      `select count(*)::int as n from public.closing_attention_items where closing_id=$1 and status='open'`, [a.closing_id]);
    if (openRes.rows[0].n === 0) {
      await client.query(
        `update public.daily_closings set status='confirmed', row_version=row_version+1
           where id=$1 and status='attention'`, [a.closing_id]);
    }
    await writeAudit(client, {
      merchantId, actorUserId: userId, action: "closing.late_source_dismissed",
      entityType: "closing_attention_item", entityId: attentionId, after: { decision } });
    return { attentionId, status: "dismissed", openRemaining: openRes.rows[0].n };
  });
}

function subtractDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
