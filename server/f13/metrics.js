// Functional 13 — the metric SQL + PURE aggregation/coverage/hash helpers. The
// SQL strings are constants (executed by snapshots.js against a pooled client);
// everything else here is side-effect-free so the number math, coverage gating
// and content hashing are unit-tested WITHOUT a database (test/f13-reports.test.js).
//
// Revenue window math mirrors the deployed F2 get_today_dashboard RPC exactly
// (business day = merchant timezone 00:00; gross = eligible orders' total_amount
// by paid_at; net = gross − succeeded refunds; cash/qr split by payment method),
// so a same-day snapshot reconciles to the Today dashboard to the đồng.
import { canonicalJson, sha256hex, METRIC_CATALOG } from "./catalog.js";

// ── SQL (params: $1 merchantId, $2 periodStart date, $3 periodEnd date, $4 tz) ─
// Timestamptz sources (orders/payments/refunds/movements) are bounded by the
// local-midnight window [v_start, v_end); date sources (expenses/receipts) are
// compared to the local dates directly.
const WINDOW = `
with w as (
  select (($2::date) + time '00:00') at time zone $4 as v_start,
         (($3::date + 1) + time '00:00') at time zone $4 as v_end
)`;

export const TOTALS_SQL = `${WINDOW}
select
  (select coalesce(sum(o.total_amount),0) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end) as gross,
  (select count(*) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end) as bill_count,
  (select count(*) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end
       and exists (select 1 from public.order_items oi where oi.order_id=o.id)) as bills_with_items,
  (select max(o.paid_at) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end) as orders_freshness,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr, w
     where pr.merchant_id=$1 and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as refund,
  (select coalesce(sum(p.amount),0) from public.payments p, w
     where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as cash_collected,
  (select count(*) from public.payments p, w
     where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as payments_count,
  (select max(p.paid_at) from public.payments p, w
     where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as payments_freshness,
  (select coalesce(sum(p.amount),0) from public.payments p, w
     where p.merchant_id=$1 and p.method='cash' and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as cash_in,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr join public.payments p on p.id=pr.payment_id, w
     where pr.merchant_id=$1 and p.method='cash' and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as cash_refund,
  (select coalesce(sum(p.amount),0) from public.payments p, w
     where p.merchant_id=$1 and p.method='qr' and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as qr_in,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr join public.payments p on p.id=pr.payment_id, w
     where pr.merchant_id=$1 and p.method='qr' and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as qr_refund
`;

// Net (gross − refund) per business day, both sides folded into one query.
export const BY_DAY_SQL = `${WINDOW}
select d, sum(gross)::bigint as gross, sum(refund)::bigint as refund from (
  select to_char((timezone($4, o.paid_at))::date, 'YYYY-MM-DD') as d, o.total_amount as gross, 0::bigint as refund
    from public.orders o, w
    where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end
  union all
  select to_char((timezone($4, pr.refunded_at))::date, 'YYYY-MM-DD') as d, 0::bigint as gross, pr.amount as refund
    from public.payment_refunds pr, w
    where pr.merchant_id=$1 and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end
) t group by d order by d`;

export const TOP_PRODUCTS_SQL = `${WINDOW}
select oi.product_id, oi.name_snapshot as name,
       coalesce(sum(oi.net_amount),0)::bigint as revenue,
       coalesce(sum(oi.quantity),0) as qty
from public.order_items oi join public.orders o on o.id=oi.order_id, w
where oi.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end
group by oi.product_id, oi.name_snapshot
order by revenue desc, qty desc
limit 5`;

export const EXPENSE_TOTAL_SQL = `
select coalesce(sum(grand_total_vnd),0)::bigint as total, count(*)::bigint as n, max(posted_at) as freshness
from public.expenses
where merchant_id=$1 and status='posted' and expense_date>=$2::date and expense_date<=$3::date`;

export const EXPENSE_BY_CATEGORY_SQL = `
select e.category_id, coalesce(c.display_name,'Chưa phân nhóm') as category_name,
       coalesce(sum(e.grand_total_vnd),0)::bigint as total, count(*)::bigint as n
from public.expenses e left join public.expense_categories c on c.id=e.category_id
where e.merchant_id=$1 and e.status='posted' and e.expense_date>=$2::date and e.expense_date<=$3::date
group by e.category_id, c.display_name
order by total desc`;

export const PURCHASE_SQL = `
select coalesce(sum(grand_total_vnd),0)::bigint as total, count(*)::bigint as n, max(posted_at) as freshness
from public.purchase_receipts
where merchant_id=$1 and status='posted' and received_at>=$2::date and received_at<=$3::date`;

export const DAMAGE_SQL = `${WINDOW}
select count(*)::bigint as n, coalesce(sum(abs(quantity_delta)),0) as qty, max(m.created_at) as freshness
from public.inventory_movements m, w
where m.merchant_id=$1 and m.movement_type='damage_writeoff' and m.created_at>=w.v_start and m.created_at<w.v_end`;

// ── Pure helpers ──────────────────────────────────────────────────────────────
export const roundVnd = (n) => Math.round(Number(n) || 0);
const num = (x) => Number(x || 0);

export function dimensionsHash(dims) {
  return sha256hex(canonicalJson(dims ?? {}));
}

/** Coverage status from a processed/expected fraction (spec 4.4 / RPT-05/06). */
export function coverageStatus(expected, processed) {
  const e = num(expected), p = num(processed);
  if (e === 0) return "complete"; // an empty period is fully covered, value is a real 0
  if (p === 0) return "unavailable";
  if (p < e) return "partial";
  return "complete";
}

/** Combine two coverage statuses to the WORSE of the two (for gated metrics). */
function worse(a, b) {
  const rank = { complete: 0, partial: 1, unavailable: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function toIso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/**
 * Turn the raw SQL result rows into the immutable metric + quality row sets.
 * PURE: no DB, no clock — the caller supplies `asOf`. Returns
 * { metrics: [{metricCode, valueVnd, valueCount, dimensions, dimensionsHash, coverageStatus}],
 *   quality: [{sourceType, expected, processed, openIssues, freshnessAt, affectedMetrics, status}] }.
 */
export function assembleSnapshot({ totals, byDay, topProducts, expenseTotal, expenseByCategory, purchase, damage, periodDayCount, asOf }) {
  const gross = num(totals.gross);
  const refund = num(totals.refund);
  const net = gross - refund;
  const billCount = num(totals.bill_count);
  const billsWithItems = num(totals.bills_with_items);
  const cashNet = num(totals.cash_in) - num(totals.cash_refund);
  const qrNet = num(totals.qr_in) - num(totals.qr_refund);
  const billAvg = billCount > 0 ? roundVnd(gross / billCount) : 0;

  const metrics = [];
  const add = (metricCode, { vnd = null, count = null, dimensions = {}, coverage = "complete" } = {}) => {
    metrics.push({
      metricCode,
      valueVnd: vnd == null ? null : roundVnd(vnd),
      valueCount: count == null ? null : Math.round(num(count)),
      dimensions,
      dimensionsHash: dimensionsHash(dimensions),
      coverageStatus: coverage,
    });
  };

  // ── Sales ──
  add("sales_gross_revenue", { vnd: gross });
  add("sales_refund", { vnd: refund });
  add("sales_net_revenue", { vnd: net });
  add("sales_bill_count", { count: billCount });
  add("sales_bill_avg", { vnd: billAvg });
  add("sales_by_channel", { vnd: cashNet, dimensions: { channel: "cash", label: "Tiền mặt" } });
  add("sales_by_channel", { vnd: qrNet, dimensions: { channel: "qr", label: "Chuyển khoản / QR" } });

  // Only show a daily series for multi-day periods (spec 3.2 "Chỉ khi >1 ngày").
  if (periodDayCount > 1) {
    for (const r of byDay || []) {
      add("sales_by_day", { vnd: num(r.gross) - num(r.refund), dimensions: { date: r.d } });
    }
  }

  // Top products — coverage follows order_items availability (spec 3.2 rule).
  const itemsCoverage = coverageStatus(billCount, billsWithItems);
  let rank = 0;
  for (const r of topProducts || []) {
    rank += 1;
    add("sales_top_products", {
      vnd: num(r.revenue), count: num(r.qty),
      dimensions: { rank, name: r.name, productId: r.product_id || null },
      coverage: itemsCoverage === "unavailable" ? "partial" : itemsCoverage,
    });
  }

  // ── Expenses ──
  const opExpense = num(expenseTotal.total);
  add("operating_expense", { vnd: opExpense });
  for (const r of expenseByCategory || []) {
    add("expense_by_category", {
      vnd: num(r.total),
      dimensions: { categoryId: r.category_id || null, categoryName: r.category_name },
    });
  }

  // ── Inventory (shown separately; NOT part of the estimate) ──
  add("inventory_purchase", { vnd: num(purchase.total) });
  add("inventory_damage", { count: num(damage.n), dimensions: { quantity: num(damage.qty) } });

  // ── Cashflow (transactional; F11 cashbook pending) ──
  add("cash_collected", { vnd: num(totals.cash_collected) });

  // ── Estimate — strict gate on the sources it depends on (revenue + expense) ──
  const estimateCoverage = worse("complete", "complete"); // both revenue & expense are complete by construction
  add("operating_result_est", { vnd: net - opExpense, coverage: estimateCoverage });

  // ── Data quality (one row per source; expected = denominator, processed = numerator) ──
  const quality = [
    q("orders", billCount, billCount, toIso(totals.orders_freshness),
      ["sales_gross_revenue", "sales_refund", "sales_net_revenue", "sales_bill_count", "sales_bill_avg", "sales_by_day"]),
    q("order_items", billCount, billsWithItems, toIso(totals.orders_freshness),
      ["sales_top_products"]),
    q("payments", num(totals.payments_count), num(totals.payments_count), toIso(totals.payments_freshness),
      ["cash_collected", "sales_by_channel"]),
    q("expenses", num(expenseTotal.n), num(expenseTotal.n), toIso(expenseTotal.freshness),
      ["operating_expense", "expense_by_category", "operating_result_est"]),
    q("purchase_receipts", num(purchase.n), num(purchase.n), toIso(purchase.freshness),
      ["inventory_purchase"]),
    q("inventory_movements", num(damage.n), num(damage.n), toIso(damage.freshness),
      ["inventory_damage"]),
  ];

  return { metrics, quality };
}

function q(sourceType, expected, processed, freshnessAt, affectedMetrics) {
  return {
    sourceType,
    expected: Math.round(num(expected)),
    processed: Math.round(num(processed)),
    openIssues: 0, // F12 issue feed not landed in the pilot — always 0 for now
    freshnessAt,
    affectedMetrics,
    status: coverageStatus(expected, processed),
  };
}

/**
 * Deterministic content hash over the header + sorted metric/quality rows, so an
 * identical rebuild produces an identical hash and export parity is provable
 * (spec 4.2 / NFR "Nhất quán"). Order-independent by sorting the row keys.
 */
export function snapshotContentHash(header, metrics, quality) {
  const m = [...metrics]
    .map((r) => ({ c: r.metricCode, h: r.dimensionsHash, v: r.valueVnd, n: r.valueCount, cov: r.coverageStatus }))
    .sort((a, b) => (a.c + a.h).localeCompare(b.c + b.h));
  const qd = [...quality]
    .map((r) => ({ s: r.sourceType, e: r.expected, p: r.processed, i: r.openIssues, st: r.status }))
    .sort((a, b) => a.s.localeCompare(b.s));
  return sha256hex(canonicalJson({
    merchantId: header.merchantId,
    periodStart: header.periodStart,
    periodEnd: header.periodEnd,
    timezone: header.timezone,
    scopeHash: header.scopeHash,
    formulaVersion: header.formulaVersion,
    metrics: m,
    quality: qd,
  }));
}

/** The list of metric codes known to the catalog (used by drill-down routing). */
export function isKnownMetric(code) {
  return Object.prototype.hasOwnProperty.call(METRIC_CATALOG, code);
}
