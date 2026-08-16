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

/**
 * On-demand rebuild-sync for a date range (spec brief: "rebuild-sync for a
 * period"). Scans confirmed source rows in [from,to] that have no receipt yet and
 * ingests each. Safe to run repeatedly. Returns per-decision counts.
 */
export async function syncRange(merchantId, { from, to, limit = 5000 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 5000, 1), 20000);
  const counts = { scanned: 0, mapped: 0, replayed: 0, skipped: 0, records: 0 };
  const tsStart = from ? `${from}T00:00:00+07:00` : "1970-01-01T00:00:00+07:00";
  const tsEnd = to ? `${addDays(to, 1)}T00:00:00+07:00` : "2999-01-01T00:00:00+07:00";

  await withTransaction(async (client) => {
    const payments = await client.query(
      `select p.id, p.method, p.amount, p.paid_at from public.payments p
        where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=$2 and p.paid_at<$3
          and not exists (select 1 from public.accounting_source_receipts r
             where r.merchant_id=p.merchant_id and r.source_type='payment'
               and r.source_id=p.id and r.event_type='payment.succeeded')
        order by p.paid_at asc limit $4`, [merchantId, tsStart, tsEnd, lim]);
    const refunds = await client.query(
      `select r.id, r.method, r.amount, r.refunded_at from public.payment_refunds r
        where r.merchant_id=$1 and r.status='succeeded' and r.refunded_at>=$2 and r.refunded_at<$3
          and not exists (select 1 from public.accounting_source_receipts sr
             where sr.merchant_id=r.merchant_id and sr.source_type='refund'
               and sr.source_id=r.id and sr.event_type='refund.succeeded')
        order by r.refunded_at asc limit $4`, [merchantId, tsStart, tsEnd, lim]);
    const expenses = await client.query(
      `select ae.id, ae.source_id, ae.amount_vnd, ae.created_at, e.expense_date
         from public.accounting_events ae join public.expenses e on e.id=ae.source_id
        where ae.merchant_id=$1 and ae.event_type='expense_posted'
          and e.expense_date>=$2::date and e.expense_date<=$3::date
          and not exists (select 1 from public.accounting_source_receipts r
             where r.merchant_id=ae.merchant_id and r.source_type='expense'
               and r.source_id=ae.source_id and r.event_type='expense_posted')
        order by e.expense_date asc limit $4`,
      [merchantId, from || "1970-01-01", to || "2999-01-01", lim]);
    const purchases = await client.query(
      `select ae.id, ae.source_id, ae.amount_vnd, ae.created_at, pr.received_at
         from public.accounting_events ae join public.purchase_receipts pr on pr.id=ae.source_id
        where ae.merchant_id=$1 and ae.event_type='purchase_received'
          and pr.received_at>=$2::date and pr.received_at<=$3::date
          and not exists (select 1 from public.accounting_source_receipts r
             where r.merchant_id=ae.merchant_id and r.source_type='purchase_receipt'
               and r.source_id=ae.source_id and r.event_type='purchase_received')
        order by pr.received_at asc limit $4`,
      [merchantId, from || "1970-01-01", to || "2999-01-01", lim]);

    const evs = [
      ...payments.rows.map(paymentEvent),
      ...refunds.rows.map(refundEvent),
      ...expenses.rows.map(expenseEvent),
      ...purchases.rows.map(purchaseEvent),
    ];
    for (const ev of evs) {
      counts.scanned++;
      const r = await ingestEventTx(client, merchantId, ev);
      if (r.decision === "mapped") { counts.mapped++; counts.records += r.recordIds.length; }
      else if (r.decision === "replayed") counts.replayed++;
      else counts.skipped++;
    }
  });
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
