// Functional 15 — the record builder (spec §1, §7.1 ingest/map atomic boundary,
// FR-01/FR-02/FR-04). Turns verified domain events (F03 payments/refunds, F06/F07
// purchase/expense accounting_events) into immutable `accounting_records` under
// the S-HKD book set. ONE transaction per event: insert the source receipt
// (idempotent on its unique tuple), map it to book lines, link each record to the
// receipt, and — if it lands in an already-locked period — flip that period to
// `attention` (late source, ATD-12). Replays never create a second record: the
// receipt's `ON CONFLICT DO NOTHING` gate means mapping runs exactly once.
import { withTransaction, query } from "../db/pool.js";
import { mapSourceToRecords, contentHash, RULE_VERSION } from "./mapping.js";

const TZ = "Asia/Ho_Chi_Minh";

/** 'YYYY-MM-DD' (Asia/Ho_Chi_Minh) for a timestamptz. */
function localDate(ts) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts));
}
/** 'YYYY-MM-DD' for a pg `date` (returned as a JS Date at LOCAL midnight). */
function dateOnly(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── Event normalisers → the shape mapSourceToRecords expects ───────────────────
function paymentEvent(row) {
  return {
    sourceType: "payment", sourceId: row.id, sourceEventType: "payment.succeeded",
    occurredAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    businessDate: row.paid_at ? localDate(row.paid_at) : null,
    amountVnd: Number(row.amount), method: row.method,
  };
}
function refundEvent(row) {
  return {
    sourceType: "refund", sourceId: row.id, sourceEventType: "refund.succeeded",
    occurredAt: row.refunded_at ? new Date(row.refunded_at).toISOString() : null,
    businessDate: row.refunded_at ? localDate(row.refunded_at) : null,
    amountVnd: Number(row.amount), method: row.method,
  };
}
function expenseEvent(row) {
  return {
    sourceType: "expense", sourceId: row.source_id, sourceEventType: "expense_posted",
    occurredAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    businessDate: dateOnly(row.expense_date) || (row.created_at ? localDate(row.created_at) : null),
    amountVnd: Number(row.amount_vnd), method: null,
  };
}
function purchaseEvent(row) {
  return {
    sourceType: "purchase_receipt", sourceId: row.source_id, sourceEventType: "purchase_received",
    occurredAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    businessDate: dateOnly(row.received_at) || (row.created_at ? localDate(row.created_at) : null),
    amountVnd: Number(row.amount_vnd), method: null,
  };
}

/**
 * Ingest ONE normalized event inside the caller's transaction. Idempotent: a
 * replayed source conflicts on the receipt unique and no records are re-created.
 * Returns { decision:'mapped'|'skipped'|'replayed', receiptId, recordIds }.
 */
export async function ingestEventTx(client, merchantId, ev) {
  const payloadHash = contentHash({
    t: ev.sourceType, id: ev.sourceId, e: ev.sourceEventType,
    a: Math.trunc(Number(ev.amountVnd) || 0), d: ev.businessDate, m: ev.method || null,
  });
  const ins = await client.query(
    `insert into public.accounting_source_receipts
       (merchant_id, source_type, source_id, event_type, source_version, payload_hash, occurred_at, status)
     values ($1,$2,$3,$4,'1',$5,$6,'received')
     on conflict (merchant_id, source_type, source_id, event_type, source_version) do nothing
     returning id`,
    [merchantId, ev.sourceType, ev.sourceId, ev.sourceEventType, payloadHash,
     ev.occurredAt || new Date().toISOString()]);
  if (ins.rows.length === 0) {
    const ex = await client.query(
      `select id from public.accounting_source_receipts
         where merchant_id=$1 and source_type=$2 and source_id=$3 and event_type=$4 and source_version='1'`,
      [merchantId, ev.sourceType, ev.sourceId, ev.sourceEventType]);
    return { decision: "replayed", receiptId: ex.rows[0]?.id ?? null, recordIds: [] };
  }
  const receiptId = ins.rows[0].id;
  const records = mapSourceToRecords(ev);
  const recordIds = [];
  for (const r of records) {
    const ch = contentHash({ book: r.bookCode, type: r.recordType, date: r.businessDate,
      amount: r.amountVnd, dims: r.dimensions, receipt: receiptId });
    const recIns = await client.query(
      `insert into public.accounting_records
         (merchant_id, record_type, book_code, business_date, amount_vnd, dimensions, status, rule_version, content_hash)
       values ($1,$2,$3,$4,$5,$6::jsonb,'posted',$7,$8) returning id`,
      [merchantId, r.recordType, r.bookCode, r.businessDate, r.amountVnd,
       JSON.stringify(r.dimensions), RULE_VERSION, ch]);
    const recordId = recIns.rows[0].id;
    await client.query(
      `insert into public.accounting_record_sources (record_id, source_receipt_id, relation)
       values ($1,$2,'primary')`, [recordId, receiptId]);
    recordIds.push(recordId);
  }
  await client.query(
    `update public.accounting_source_receipts set status=$2 where id=$1`,
    [receiptId, records.length ? "mapped" : "review"]);
  if (records.length && ev.businessDate) {
    // Late source into an already-locked period → attention (§4.3 / ATD-12).
    await client.query(
      `update public.accounting_periods
          set status='attention', row_version=row_version+1
        where merchant_id=$1 and status='locked'
          and $2::date >= period_start and $2::date <= period_end`,
      [merchantId, ev.businessDate]);
  }
  return { decision: records.length ? "mapped" : "skipped", receiptId, recordIds };
}

/** Load every not-yet-ingested confirmed source event in [from,to], normalized. */
async function loadPendingEvents(merchantId, from, to, lim) {
  const tsStart = from ? `${from}T00:00:00+07:00` : "1970-01-01T00:00:00+07:00";
  const tsEnd = to ? `${addDays(to, 1)}T00:00:00+07:00` : "2999-01-01T00:00:00+07:00";
  const payments = await query(
    `select p.id, p.method, p.amount, p.paid_at from public.payments p
      where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=$2 and p.paid_at<$3
        and not exists (select 1 from public.accounting_source_receipts r
           where r.merchant_id=p.merchant_id and r.source_type='payment'
             and r.source_id=p.id and r.event_type='payment.succeeded')
      order by p.paid_at asc limit $4`, [merchantId, tsStart, tsEnd, lim]);
  const refunds = await query(
    `select r.id, r.method, r.amount, r.refunded_at from public.payment_refunds r
      where r.merchant_id=$1 and r.status='succeeded' and r.refunded_at>=$2 and r.refunded_at<$3
        and not exists (select 1 from public.accounting_source_receipts sr
           where sr.merchant_id=r.merchant_id and sr.source_type='refund'
             and sr.source_id=r.id and sr.event_type='refund.succeeded')
      order by r.refunded_at asc limit $4`, [merchantId, tsStart, tsEnd, lim]);
  const expenses = await query(
    `select ae.id, ae.source_id, ae.amount_vnd, ae.created_at, e.expense_date
       from public.accounting_events ae join public.expenses e on e.id=ae.source_id
      where ae.merchant_id=$1 and ae.event_type='expense_posted'
        and e.expense_date>=$2::date and e.expense_date<=$3::date
        and not exists (select 1 from public.accounting_source_receipts r
           where r.merchant_id=ae.merchant_id and r.source_type='expense'
             and r.source_id=ae.source_id and r.event_type='expense_posted')
      order by e.expense_date asc limit $4`,
    [merchantId, from || "1970-01-01", to || "2999-01-01", lim]);
  const purchases = await query(
    `select ae.id, ae.source_id, ae.amount_vnd, ae.created_at, pr.received_at
       from public.accounting_events ae join public.purchase_receipts pr on pr.id=ae.source_id
      where ae.merchant_id=$1 and ae.event_type='purchase_received'
        and pr.received_at>=$2::date and pr.received_at<=$3::date
        and not exists (select 1 from public.accounting_source_receipts r
           where r.merchant_id=ae.merchant_id and r.source_type='purchase_receipt'
             and r.source_id=ae.source_id and r.event_type='purchase_received')
      order by pr.received_at asc limit $4`,
    [merchantId, from || "1970-01-01", to || "2999-01-01", lim]);
  return [
    ...payments.rows.map(paymentEvent),
    ...refunds.rows.map(refundEvent),
    ...expenses.rows.map(expenseEvent),
    ...purchases.rows.map(purchaseEvent),
  ];
}

/**
 * Ingest a BATCH of normalized events in ONE transaction using set-based inserts
 * (a handful of round-trips for the whole chunk instead of ~7 per event). The
 * per-event `ingestEventTx` is still used by the post-commit hooks; this is its
 * bulk equivalent for the on-demand sync. All events passed in are pre-filtered to
 * have no receipt yet, so receipts insert with ON CONFLICT DO NOTHING (a conflict
 * is a rare concurrent double-run → counted as replayed, never a second record).
 */
async function ingestBatchTx(merchantId, evs) {
  const out = { mapped: 0, replayed: 0, skipped: 0, records: 0 };
  if (!evs.length) return out;
  return withTransaction(async (client) => {
    // 1) Bulk-insert source receipts; RETURNING tells us which actually inserted.
    const rcv = [];
    const rcvParams = [];
    evs.forEach((ev, i) => {
      const b = i * 6; // 6 bound params per row ('1' + 'received' are literals)
      const payloadHash = contentHash({
        t: ev.sourceType, id: ev.sourceId, e: ev.sourceEventType,
        a: Math.trunc(Number(ev.amountVnd) || 0), d: ev.businessDate, m: ev.method || null,
      });
      rcv.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},'1',$${b + 5},$${b + 6},'received')`);
      rcvParams.push(merchantId, ev.sourceType, ev.sourceId, ev.sourceEventType, payloadHash,
        ev.occurredAt || new Date().toISOString());
    });
    const insR = await client.query(
      `insert into public.accounting_source_receipts
         (merchant_id, source_type, source_id, event_type, source_version, payload_hash, occurred_at, status)
       values ${rcv.join(",")}
       on conflict (merchant_id, source_type, source_id, event_type, source_version) do nothing
       returning id, source_type, source_id, event_type`, rcvParams);
    // Map natural key → new receipt id. Events not returned lost a concurrent race.
    const receiptOf = new Map();
    for (const r of insR.rows) receiptOf.set(`${r.source_type}:${r.source_id}:${r.event_type}`, r.id);

    // 2) Map each freshly-inserted receipt to its book records (pure, in-memory).
    const recRows = [];        // { receiptId, bookCode, recordType, businessDate, amountVnd, dimensions, contentHash }
    const mappedReceiptIds = [];
    const reviewReceiptIds = [];
    const attentionDates = new Set();
    for (const ev of evs) {
      const receiptId = receiptOf.get(`${ev.sourceType}:${ev.sourceId}:${ev.sourceEventType}`);
      if (!receiptId) { out.replayed++; continue; }
      const records = mapSourceToRecords(ev);
      if (!records.length) { out.skipped++; reviewReceiptIds.push(receiptId); continue; }
      out.mapped++;
      mappedReceiptIds.push(receiptId);
      if (ev.businessDate) attentionDates.add(ev.businessDate);
      for (const r of records) {
        const ch = contentHash({ book: r.bookCode, type: r.recordType, date: r.businessDate,
          amount: r.amountVnd, dims: r.dimensions, receipt: receiptId });
        recRows.push({ receiptId, ...r, contentHash: ch });
      }
    }

    // 3) Bulk-insert records; RETURNING (id, content_hash) links each back to its
    //    receipt (content_hash is unique in a batch — it embeds book+receipt).
    if (recRows.length) {
      const receiptOfHash = new Map(recRows.map((r) => [r.contentHash, r.receiptId]));
      const vals = [];
      const params = [];
      recRows.forEach((r, i) => {
        const b = i * 8;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb,'posted',$${b + 7},$${b + 8})`);
        params.push(merchantId, r.recordType, r.bookCode, r.businessDate, r.amountVnd,
          JSON.stringify(r.dimensions), RULE_VERSION, r.contentHash);
      });
      const insRec = await client.query(
        `insert into public.accounting_records
           (merchant_id, record_type, book_code, business_date, amount_vnd, dimensions, status, rule_version, content_hash)
         values ${vals.join(",")} returning id, content_hash`, params);
      out.records += insRec.rows.length;

      // 4) Bulk-insert record→source links.
      const linkVals = [];
      const linkParams = [];
      insRec.rows.forEach((row, i) => {
        const b = i * 2;
        linkVals.push(`($${b + 1},$${b + 2},'primary')`);
        linkParams.push(row.id, receiptOfHash.get(row.content_hash));
      });
      await client.query(
        `insert into public.accounting_record_sources (record_id, source_receipt_id, relation)
         values ${linkVals.join(",")}`, linkParams);
    }

    // 5) Flip receipt statuses in bulk (mapped vs review).
    if (mappedReceiptIds.length) {
      await client.query(
        `update public.accounting_source_receipts set status='mapped' where id = any($1::uuid[])`,
        [mappedReceiptIds]);
    }
    if (reviewReceiptIds.length) {
      await client.query(
        `update public.accounting_source_receipts set status='review' where id = any($1::uuid[])`,
        [reviewReceiptIds]);
    }

    // 6) Late source into an already-locked period → attention (§4.3 / ATD-12).
    if (attentionDates.size) {
      await client.query(
        `update public.accounting_periods p
            set status='attention', row_version=row_version+1
          where p.merchant_id=$1 and p.status='locked'
            and exists (select 1 from unnest($2::date[]) d
                          where d >= p.period_start and d <= p.period_end)`,
        [merchantId, [...attentionDates]]);
    }
    return out;
  });
}

/**
 * On-demand rebuild-sync for a date range (spec brief: "rebuild-sync for a
 * period"). Scans confirmed source rows in [from,to] that have no receipt yet and
 * ingests them in bounded, batched chunks. Safe to run repeatedly and idempotent
 * (the not-yet-ingested filter + receipt unique). Each chunk commits on its own so
 * a large merchant makes durable partial progress instead of one multi-minute
 * transaction that never commits (the real F15 sync bug). A chunk that throws is
 * reported in `errors` and `failed` — never silently swallowed (FR-03 honesty) —
 * and the remaining chunks still run. Returns per-decision counts + any errors.
 */
export async function syncRange(merchantId, { from, to, limit = 5000 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const counts = { scanned: 0, mapped: 0, replayed: 0, skipped: 0, records: 0, failed: 0, errors: [] };
  const evs = await loadPendingEvents(merchantId, from, to, lim);
  const CHUNK = 200; // events per transaction — keeps each txn well under any timeout
  for (let i = 0; i < evs.length; i += CHUNK) {
    const chunk = evs.slice(i, i + CHUNK);
    counts.scanned += chunk.length;
    try {
      const r = await ingestBatchTx(merchantId, chunk);
      counts.mapped += r.mapped; counts.replayed += r.replayed;
      counts.skipped += r.skipped; counts.records += r.records;
    } catch (e) {
      counts.failed += chunk.length;
      const msg = e?.message || String(e);
      if (counts.errors.length < 10) counts.errors.push(msg);
      console.error("F15 syncRange chunk failed", msg);
    }
  }
  return counts;
}

/** Fire-and-forget post-commit hook: never throws into the caller's happy path. */
export async function bestEffortIngest(fn) {
  try { await fn(); } catch (e) { console.error("F15 ingest hook (non-fatal)", e?.message || e); }
}

/** Ingest one payment by id (F03 post-commit hook parity). Opens its own tx. */
export async function ingestPaymentById(merchantId, paymentId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `select id, method, amount, paid_at, status from public.payments where id=$1 and merchant_id=$2`,
      [paymentId, merchantId]);
    if (!rows.length || rows[0].status !== "succeeded") return { decision: "skipped" };
    return ingestEventTx(client, merchantId, paymentEvent(rows[0]));
  });
}
