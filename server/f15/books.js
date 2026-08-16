// Functional 15 — book READ models (spec §3.2/§3.3/§3.5, FR-05/FR-06). Totals are
// ALWAYS server-computed from immutable posted records; a book line drills down to
// its source receipt (F03/F06/F07 deep-link). A snapshot-aware read pins the
// watermark (created_at <= asOf) so a locked period always renders the exact set
// of records that was frozen — never a later mutation.
import { query } from "../db/pool.js";
import { DomainError } from "../f3/errors.js";
import { BOOKS, BOOK_CODES, bookName, bookShort, RULE_VERSION } from "./mapping.js";

/** Deep-link a source receipt to its owning functional screen (spec §3.3). */
async function resolveSourceRoute(sourceType, sourceId) {
  if (sourceType === "payment") {
    const { rows } = await query(`select order_id from public.payments where id=$1`, [sourceId]);
    return rows[0] ? `/don-hang/${rows[0].order_id}` : null;
  }
  if (sourceType === "refund") {
    const { rows } = await query(`select order_id from public.payment_refunds where id=$1`, [sourceId]);
    return rows[0] ? `/don-hang/${rows[0].order_id}` : null;
  }
  if (sourceType === "purchase_receipt") return `/nhap-hang/${sourceId}`;
  if (sourceType === "expense") return `/chi-phi/${sourceId}`;
  return null;
}
const SOURCE_LABEL = {
  payment: "Bill", refund: "Hoàn tiền", purchase_receipt: "Phiếu nhập", expense: "Chi phí",
};

/**
 * Server-computed totals per book for a period. `watermark` (ISO) pins the record
 * set to created_at <= watermark (snapshot-aware); omit for the live open period.
 * Returns { byBook: {code:{count,total,grossIn,grossOut}}, recordCount, fingerprint }.
 */
export async function bookTotals(merchantId, { start, end, watermark } = {}) {
  const params = [merchantId, start, end];
  let wm = "";
  if (watermark) { params.push(watermark); wm = ` and created_at <= $${params.length}`; }
  const { rows } = await query(
    `select book_code,
            count(*)::int n,
            coalesce(sum(amount_vnd),0)::bigint total,
            coalesce(sum(case when amount_vnd>0 then amount_vnd else 0 end),0)::bigint gross_in,
            coalesce(sum(case when amount_vnd<0 then -amount_vnd else 0 end),0)::bigint gross_out
       from public.accounting_records
      where merchant_id=$1 and status='posted' and business_date>=$2 and business_date<=$3${wm}
      group by book_code`, params);
  const byBook = {};
  let recordCount = 0;
  for (const r of rows) {
    byBook[r.book_code] = {
      count: r.n, total: Number(r.total), grossIn: Number(r.gross_in), grossOut: Number(r.gross_out),
    };
    recordCount += r.n;
  }
  return { byBook, recordCount };
}

/**
 * The immutable record-set fingerprint for a period at a watermark (spec A4 —
 * snapshot content hash over record links). Sorted list of record content hashes.
 */
export async function recordFingerprint(merchantId, { start, end, watermark }) {
  const params = [merchantId, start, end];
  let wm = "";
  if (watermark) { params.push(watermark); wm = ` and created_at <= $${params.length}`; }
  const { rows } = await query(
    `select content_hash from public.accounting_records
      where merchant_id=$1 and status='posted' and business_date>=$2 and business_date<=$3${wm}
      order by content_hash`, params);
  return rows.map((r) => r.content_hash);
}

/** List every configured book with its period total (spec §3.2). */
export async function listBooks(merchantId, period, watermark) {
  const totals = await bookTotals(merchantId, { start: period.start, end: period.end, watermark });
  const books = BOOK_CODES.map((code) => {
    const def = BOOKS[code];
    const t = totals.byBook[code] || { count: 0, total: 0, grossIn: 0, grossOut: 0 };
    return {
      code, name: def.name, short: def.short, legalRef: def.legalRef, order: def.order,
      count: t.count, total: t.total, grossIn: t.grossIn, grossOut: t.grossOut,
    };
  });
  return { books, ruleVersion: RULE_VERSION };
}

/** Book ledger — records in the period for one book, newest first (spec §3.3). */
export async function bookLedger(merchantId, bookCode, period, { watermark, limit } = {}) {
  if (!BOOKS[bookCode]) throw new DomainError("NOT_FOUND", "Không tìm thấy sổ.");
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const params = [merchantId, bookCode, period.start, period.end];
  let wm = "";
  if (watermark) { params.push(watermark); wm = ` and r.created_at <= $${params.length}`; }
  params.push(lim);
  const { rows } = await query(
    `select r.id, r.record_type, r.business_date, r.amount_vnd, r.dimensions, r.status,
            r.rule_version, r.created_at,
            s.source_receipt_id, sr.source_type, sr.source_id
       from public.accounting_records r
       left join public.accounting_record_sources s on s.record_id=r.id and s.relation='primary'
       left join public.accounting_source_receipts sr on sr.id=s.source_receipt_id
      where r.merchant_id=$1 and r.book_code=$2 and r.status='posted'
        and r.business_date>=$3 and r.business_date<=$4${wm}
      order by r.business_date desc, r.created_at desc, r.id desc
      limit $${params.length}`, params);
  const lines = [];
  for (const r of rows) {
    lines.push({
      id: r.id, recordType: r.record_type,
      businessDate: dateStr(r.business_date), amountVnd: Number(r.amount_vnd),
      dimensions: r.dimensions || {}, status: r.status, ruleVersion: r.rule_version,
      source: r.source_type ? {
        sourceType: r.source_type, sourceId: r.source_id,
        label: SOURCE_LABEL[r.source_type] || r.source_type,
        route: await resolveSourceRoute(r.source_type, r.source_id),
      } : null,
      description: describe(r.record_type, r.dimensions),
    });
  }
  const totalRow = lines.reduce((a, l) => a + l.amountVnd, 0);
  const def = BOOKS[bookCode];
  return {
    book: { code: bookCode, name: def.name, short: def.short, legalRef: def.legalRef },
    period: { key: period.key, label: period.label, start: period.start, end: period.end, timezone: period.timezone },
    lines, total: totalRow, count: lines.length, ruleVersion: RULE_VERSION,
  };
}

/** One record + its full source/timeline for the drill-down (spec §3.5). */
export async function recordDetail(merchantId, recordId) {
  const { rows } = await query(
    `select * from public.accounting_records where id=$1 and merchant_id=$2`, [recordId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy dòng sổ.");
  const r = rows[0];
  const srcs = await query(
    `select s.relation, sr.source_type, sr.source_id, sr.event_type, sr.source_version,
            sr.payload_hash, sr.occurred_at, sr.status
       from public.accounting_record_sources s
       join public.accounting_source_receipts sr on sr.id=s.source_receipt_id
      where s.record_id=$1`, [recordId]);
  const sources = [];
  for (const s of srcs.rows) {
    sources.push({
      relation: s.relation, sourceType: s.source_type, sourceId: s.source_id,
      eventType: s.event_type, sourceVersion: s.source_version,
      label: SOURCE_LABEL[s.source_type] || s.source_type,
      route: await resolveSourceRoute(s.source_type, s.source_id),
      occurredAt: s.occurred_at ? new Date(s.occurred_at).toISOString() : null,
      status: s.status,
    });
  }
  // Adjustment chain (replaces_id).
  const replaced = r.replaces_id
    ? (await query(`select id, amount_vnd, content_hash from public.accounting_records where id=$1`, [r.replaces_id])).rows[0]
    : null;
  return {
    record: {
      id: r.id, recordType: r.record_type, bookCode: r.book_code,
      bookName: bookName(r.book_code), bookShort: bookShort(r.book_code),
      businessDate: dateStr(r.business_date), amountVnd: Number(r.amount_vnd),
      dimensions: r.dimensions || {}, status: r.status, ruleVersion: r.rule_version,
      catalogCode: undefined, replacesId: r.replaces_id, contentHash: r.content_hash,
      description: describe(r.record_type, r.dimensions),
      createdAt: new Date(r.created_at).toISOString(),
    },
    sources,
    replaces: replaced ? { id: replaced.id, amountVnd: Number(replaced.amount_vnd) } : null,
  };
}

function describe(recordType, dims) {
  const flow = dims?.flow;
  switch (flow) {
    case "sale": return "Doanh thu bán hàng";
    case "sales_return": return "Giảm trừ doanh thu (hoàn tiền)";
    case "receipt": return "Thu tiền bán hàng";
    case "payment": return "Chi hoàn tiền";
    case "expense": return "Chi phí kinh doanh";
    case "purchase": return "Mua hàng nhập kho";
    default: return bookName(recordType);
  }
}
function dateStr(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
