// Functional 11 — the INGEST service (spec §7 "Cashbook service", §7.1 atomic
// boundaries). Turns a verified domain event into EXACTLY one cashbook entry (+
// source link) when data is certain, or one review item when it is not. The
// idempotency backbone is the cashbook_source_links unique tuple (merchant,
// source_type, source_id, source_event_type) for posts and the review_items
// unique (merchant, event_id) for the queue — so replays and concurrent workers
// converge on a single row (CBK-01/CBK-02).
//
// There is no separate event_inbox/outbox worker in the pilot (no queue infra):
// entries are raised (a) in-process post-commit from the F3 payment/refund paths
// and (b) by an on-demand sync scan that fills any gaps (events fired before this
// feature or by other lanes). Both routes are safe to run any number of times.
import { withTransaction } from "../db/pool.js";
import { writeAudit } from "../f3/audit.js";
import { classifySource, sourceHash, RULE_VERSION } from "./mapping.js";

/** Resolve a system actor (merchant owner) for auto-posted entries, since the
 *  source rows do not carry a user id and created_by is NOT NULL FK auth.users. */
async function resolveSystemActor(client, merchantId) {
  const { rows } = await client.query(
    `select user_id from public.merchant_members
       where merchant_id=$1 and status='active'
       order by (role='owner') desc, created_at asc limit 1`,
    [merchantId],
  );
  return rows[0]?.user_id ?? null;
}

/**
 * Post one cashbook entry + its source link atomically, idempotent on the link's
 * unique tuple. A SAVEPOINT guards against leaving an orphan entry when the link
 * already exists (replay/concurrent winner). Returns the entry id + replay flag.
 */
export async function postEntryTx(client, { merchantId, userId, source, entry, ruleVersion = RULE_VERSION }) {
  // Fast replay path: link already present → return its entry.
  const pre = await client.query(
    `select entry_id from public.cashbook_source_links
       where merchant_id=$1 and source_type=$2 and source_id=$3 and source_event_type=$4`,
    [merchantId, source.sourceType, source.sourceId, source.sourceEventType],
  );
  if (pre.rows.length) return { entryId: pre.rows[0].entry_id, replayed: true };

  await client.query("SAVEPOINT cbk_post");
  const ins = await client.query(
    `insert into public.cashbook_entries
       (merchant_id, direction, entry_type, amount_vnd, occurred_at, payment_method, status, rule_version, created_by)
     values ($1,$2,$3,$4,$5,$6,'posted',$7,$8) returning id`,
    [merchantId, entry.direction, entry.entryType, entry.amountVnd, entry.occurredAt,
     entry.paymentMethod, ruleVersion, userId],
  );
  const entryId = ins.rows[0].id;
  const link = await client.query(
    `insert into public.cashbook_source_links
       (merchant_id, entry_id, source_type, source_id, source_event_type, source_version, source_hash)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (merchant_id, source_type, source_id, source_event_type) do nothing
     returning id`,
    [merchantId, entryId, source.sourceType, source.sourceId, source.sourceEventType,
     source.sourceVersion || 1, source.sourceHash],
  );
  if (link.rows.length === 0) {
    // Lost the race: another tx just linked this source. Drop our entry, replay theirs.
    await client.query("ROLLBACK TO SAVEPOINT cbk_post");
    const { rows } = await client.query(
      `select entry_id from public.cashbook_source_links
         where merchant_id=$1 and source_type=$2 and source_id=$3 and source_event_type=$4`,
      [merchantId, source.sourceType, source.sourceId, source.sourceEventType],
    );
    return { entryId: rows[0]?.entry_id ?? null, replayed: true };
  }
  await client.query("RELEASE SAVEPOINT cbk_post");
  await writeAudit(client, {
    merchantId, actorUserId: userId, action: "cashbook.posted",
    entityType: "cashbook_entry", entityId: entryId,
    after: { direction: entry.direction, entryType: entry.entryType, amountVnd: entry.amountVnd, ruleVersion, source },
  });
  return { entryId, replayed: false };
}

/** Upsert a review item, idempotent on (merchant, event_id). */
export async function upsertReviewTx(client, { merchantId, eventId, reasonCodes, draft }) {
  const ins = await client.query(
    `insert into public.cashbook_review_items (merchant_id, event_id, reason_codes, draft_data, status)
     values ($1,$2,$3,$4,'open')
     on conflict (merchant_id, event_id) do nothing
     returning id, status`,
    [merchantId, eventId, reasonCodes, JSON.stringify(draft)],
  );
  if (ins.rows.length) return { reviewId: ins.rows[0].id, status: "open", replayed: false };
  const { rows } = await client.query(
    `select id, status from public.cashbook_review_items where merchant_id=$1 and event_id=$2`,
    [merchantId, eventId],
  );
  return { reviewId: rows[0]?.id ?? null, status: rows[0]?.status ?? null, replayed: true };
}

/**
 * Ingest ONE already-loaded source event inside the caller's transaction.
 * `ev` carries the normalized snapshot; `eventId` is the durable inbox key used
 * for the review-items unique. Returns { decision, entryId?|reviewId?, replayed }.
 */
export async function ingestSourceTx(client, merchantId, systemActor, ev) {
  const decision = classifySource(ev);
  if (decision.decision === "skip") return { decision: "skip" };

  const source = {
    sourceType: ev.sourceType, sourceId: ev.sourceId, sourceEventType: ev.sourceEventType,
    sourceVersion: 1, sourceHash: sourceHash(ev),
  };

  if (decision.decision === "post") {
    const r = await postEntryTx(client, {
      merchantId, userId: systemActor, source,
      entry: {
        direction: decision.direction, entryType: decision.entryType,
        amountVnd: decision.amountVnd, occurredAt: decision.occurredAt,
        paymentMethod: decision.paymentMethod,
      },
      ruleVersion: decision.ruleVersion,
    });
    return { decision: "post", entryId: r.entryId, replayed: r.replayed };
  }

  // Review: draft carries everything the resolver needs to preview/post later.
  const r = await upsertReviewTx(client, {
    merchantId, eventId: ev.eventId, reasonCodes: decision.reasonCodes,
    draft: {
      schemaVersion: 1,
      sourceType: ev.sourceType, sourceId: ev.sourceId, sourceEventType: ev.sourceEventType,
      sourceLabel: ev.sourceLabel ?? null, deepLink: ev.deepLink ?? null,
      direction: decision.direction, entryType: decision.entryType,
      amountVnd: decision.amountVnd, occurredAt: decision.occurredAt,
      paymentMethod: decision.paymentMethod, ruleVersion: decision.ruleVersion,
      sourceHash: source.sourceHash,
    },
  });
  return { decision: "review", reviewId: r.reviewId, status: r.status, replayed: r.replayed };
}

// ── Source loaders → normalized event snapshots ────────────────────────────────

function paymentEvent(row) {
  return {
    sourceType: "payment", sourceId: row.id, sourceEventType: "payment.succeeded",
    eventId: row.id, amountVnd: Number(row.amount),
    occurredAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    paymentMethod: row.method, sourceLabel: "Bill", deepLink: "order",
    // deep-link target lives on the source; resolver reads order_id.
    orderId: row.order_id,
  };
}
function refundEvent(row) {
  return {
    sourceType: "refund", sourceId: row.id, sourceEventType: "refund.succeeded",
    eventId: row.id, amountVnd: Number(row.amount),
    occurredAt: row.refunded_at ? new Date(row.refunded_at).toISOString() : null,
    paymentMethod: row.method, sourceLabel: "Hoàn tiền", deepLink: "order",
    orderId: row.order_id,
  };
}
function accountingEvent(row) {
  const sourceType = row.event_type === "expense_posted" ? "expense" : "purchase_receipt";
  return {
    sourceType, sourceId: row.source_id, sourceEventType: row.event_type,
    eventId: row.id, amountVnd: Number(row.amount_vnd),
    occurredAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    paymentMethod: null,
    sourceLabel: row.event_type === "expense_posted" ? "Chi phí" : "Phiếu nhập",
    deepLink: sourceType,
  };
}

// ── Public entrypoints (each opens its own transaction) ────────────────────────

export async function ingestPaymentById(merchantId, paymentId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select id, order_id, method, amount, paid_at, status from public.payments
         where id=$1 and merchant_id=$2`, [paymentId, merchantId]);
    if (!rows.length || rows[0].status !== "succeeded") return { decision: "skip" };
    const actor = await resolveSystemActor(client, merchantId);
    return ingestSourceTx(client, merchantId, actor, paymentEvent(rows[0]));
  });
}

export async function ingestRefundById(merchantId, refundId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select id, order_id, method, amount, refunded_at, status from public.payment_refunds
         where id=$1 and merchant_id=$2`, [refundId, merchantId]);
    if (!rows.length || rows[0].status !== "succeeded") return { decision: "skip" };
    const actor = await resolveSystemActor(client, merchantId);
    return ingestSourceTx(client, merchantId, actor, refundEvent(rows[0]));
  });
}

export async function ingestAccountingEventById(merchantId, eventId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select id, source_type, source_id, event_type, amount_vnd, review_status, created_at
         from public.accounting_events where id=$1 and merchant_id=$2`, [eventId, merchantId]);
    if (!rows.length) return { decision: "skip" };
    const actor = await resolveSystemActor(client, merchantId);
    return ingestSourceTx(client, merchantId, actor, accountingEvent(rows[0]));
  });
}

/**
 * On-demand gap fill (spec brief "sync endpoint"). Scans recent unlinked source
 * rows across payments / refunds / accounting_events and ingests each. Safe to
 * run repeatedly — already-handled rows are skipped by the NOT EXISTS guards and
 * the idempotent inserts. Returns per-decision counts.
 */
export async function syncMerchant(merchantId, { limit = 500 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const counts = { scanned: 0, posted: 0, review: 0, replayed: 0, skipped: 0 };

  await withTransaction(async (client) => {
    const actor = await resolveSystemActor(client, merchantId);

    const payments = await client.query(
      `select p.id, p.order_id, p.method, p.amount, p.paid_at, p.status
         from public.payments p
        where p.merchant_id=$1 and p.status='succeeded'
          and not exists (select 1 from public.cashbook_source_links l
             where l.merchant_id=p.merchant_id and l.source_type='payment'
               and l.source_id=p.id and l.source_event_type='payment.succeeded')
        order by p.paid_at desc nulls last limit $2`, [merchantId, lim]);

    const refunds = await client.query(
      `select r.id, r.order_id, r.method, r.amount, r.refunded_at, r.status
         from public.payment_refunds r
        where r.merchant_id=$1 and r.status='succeeded'
          and not exists (select 1 from public.cashbook_source_links l
             where l.merchant_id=r.merchant_id and l.source_type='refund'
               and l.source_id=r.id and l.source_event_type='refund.succeeded')
        order by r.refunded_at desc nulls last limit $2`, [merchantId, lim]);

    const events = await client.query(
      `select e.id, e.source_type, e.source_id, e.event_type, e.amount_vnd, e.review_status, e.created_at
         from public.accounting_events e
        where e.merchant_id=$1 and e.event_type in ('purchase_received','expense_posted')
          and not exists (select 1 from public.cashbook_review_items ri
             where ri.merchant_id=e.merchant_id and ri.event_id=e.id)
          and not exists (select 1 from public.cashbook_source_links l
             where l.merchant_id=e.merchant_id and l.source_id=e.source_id
               and l.source_event_type=e.event_type)
        order by e.created_at desc limit $2`, [merchantId, lim]);

    const evs = [
      ...payments.rows.map(paymentEvent),
      ...refunds.rows.map(refundEvent),
      ...events.rows.map(accountingEvent),
    ];
    for (const ev of evs) {
      counts.scanned++;
      const r = await ingestSourceTx(client, merchantId, actor, ev);
      if (r.decision === "post") { r.replayed ? counts.replayed++ : counts.posted++; }
      else if (r.decision === "review") { r.replayed ? counts.replayed++ : counts.review++; }
      else counts.skipped++;
    }
  });
  return counts;
}

/** Fire-and-forget post-commit hook: never throws into the caller's happy path
 *  (the sync scan + unique indexes are the durable backstop). */
export async function bestEffortIngest(fn) {
  try { await fn(); } catch (e) { console.error("F11 ingest hook (non-fatal)", e?.message || e); }
}
