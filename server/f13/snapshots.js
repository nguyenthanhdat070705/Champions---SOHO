// Functional 13 — snapshot builder + read/compare/drill-down service. Every
// snapshot is built inside ONE transaction bounded by a per-build-key advisory
// lock (spec 5.1 / 9.4): concurrent builds of the same key collapse to one, a
// rebuild creates a NEW revision that supersedes the old (which stays immutable),
// and the header flips to `ready` only after every metric + quality row is in and
// the content hash is computed. Ready snapshots are never re-valued — a late
// event makes a new revision, never an UPDATE of old numbers (spec 4.2 / 7.1).
import { query, withTransaction } from "../db/pool.js";
import { fail } from "../f3/errors.js";
import { writeAudit } from "../f3/audit.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import {
  FORMULA_VERSION, DEFAULT_TIMEZONE, METRIC_CATALOG, metricLabel,
  resolvePeriod, periodDays, scopeHash, canonicalJson,
} from "./catalog.js";
import {
  TOTALS_SQL, BY_DAY_SQL, TOP_PRODUCTS_SQL, EXPENSE_TOTAL_SQL,
  EXPENSE_BY_CATEGORY_SQL, PURCHASE_SQL, DAMAGE_SQL,
  assembleSnapshot, snapshotContentHash, isKnownMetric,
} from "./metrics.js";

const MAX_PERIOD_DAYS = 92; // spec 12.4 pilot cap (≈ one quarter)

const SOURCE_LABELS = {
  orders: "Đơn hàng (bán)",
  order_items: "Chi tiết dòng bill",
  payments: "Thanh toán",
  expenses: "Chi phí",
  purchase_receipts: "Phiếu nhập",
  inventory_movements: "Điều chỉnh tồn kho",
};

// ── date helpers ──────────────────────────────────────────────────────────────
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(v) {
  // pg returns `date` as a Date at LOCAL midnight — read local components, never
  // toISOString() (would tz-shift the day). Mirrors the F6/F7 dateOnly rule.
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
}
function toIso(v) { return v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : null; }

async function merchantBusinessDate(timezone) {
  const { rows } = await query(`select to_char(timezone($1, now())::date, 'YYYY-MM-DD') as d`, [timezone]);
  return rows[0].d;
}

/** Validate + canonicalize the requested period (spec RPT-FR-01 / RPT_001). */
async function resolveInputPeriod(input) {
  const timezone = input.timezone || DEFAULT_TIMEZONE;
  let start, end, label, preset = null;
  if (input.preset) {
    const bd = await merchantBusinessDate(timezone);
    const p = resolvePeriod(input.preset, bd);
    ({ start, end, label, preset } = p);
  } else if (input.period && input.period.start && input.period.end) {
    start = String(input.period.start); end = String(input.period.end);
    if (!YMD.test(start) || !YMD.test(end)) fail("VALIDATION", "Kỳ báo cáo không hợp lệ (YYYY-MM-DD).");
    label = start === end ? `Ngày ${start}` : `${start} → ${end}`;
  } else {
    fail("VALIDATION", "Thiếu kỳ báo cáo (preset hoặc period).");
  }
  if (start > end) fail("VALIDATION", "Ngày bắt đầu không được sau ngày kết thúc.");
  const days = periodDays(start, end);
  if (days > MAX_PERIOD_DAYS) fail("VALIDATION", `Kỳ tối đa ${MAX_PERIOD_DAYS} ngày.`);
  return { timezone, start, end, label, preset, days };
}

// ── Build ─────────────────────────────────────────────────────────────────────
/**
 * Find an existing ready snapshot for the (merchant, period, tz, scope, formula)
 * or build a new one. `rebuild:true` always creates a fresh revision superseding
 * the prior latest. Idempotency-Key single-flights fast double-taps.
 * @returns { snapshot, ready, created, revision }
 */
export async function findOrBuildSnapshot(merchantId, userId, input, idemKey) {
  const period = await resolveInputPeriod(input);
  const scope = input.scope && typeof input.scope === "object" ? input.scope : {};
  const sHash = scopeHash(scope);
  const rebuild = input.rebuild === true || input.asOfMode === "rebuild";
  const hash = bodyHash({ merchantId, ...period, sHash, rebuild });

  const { result } = await runIdempotent("f13-build", idemKey, hash, async () => {
    const snapshotId = await withTransaction(async (client) => {
      // Serialize concurrent builds of the same logical key (spec 5.1 / RPT-08).
      await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `${merchantId}|${period.start}|${period.end}|${period.timezone}|${sHash}|${FORMULA_VERSION}`,
      ]);

      const existing = await client.query(
        `select id, revision from public.report_snapshots
           where merchant_id=$1 and period_start=$2 and period_end=$3 and timezone=$4
             and scope_hash=$5 and formula_version=$6 and status='ready'
           order by revision desc limit 1`,
        [merchantId, period.start, period.end, period.timezone, sHash, FORMULA_VERSION],
      );
      const prior = existing.rows[0] || null;
      if (prior && !rebuild) return prior.id; // idempotent: same key → same immutable snapshot

      const revision = prior ? prior.revision + 1 : 1;
      const supersedesId = prior ? prior.id : null;
      const asOf = new Date();

      const ins = await client.query(
        `insert into public.report_snapshots
           (merchant_id, period_start, period_end, timezone, scope, scope_hash,
            formula_version, as_of, status, revision, supersedes_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'building',$9,$10,$11)
         returning id`,
        [merchantId, period.start, period.end, period.timezone, JSON.stringify(scope), sHash,
         FORMULA_VERSION, asOf.toISOString(), revision, supersedesId, userId],
      );
      const id = ins.rows[0].id;

      const params = [merchantId, period.start, period.end, period.timezone];
      const dateParams = [merchantId, period.start, period.end];
      // One transaction client can only run one query at a time — sequential, not
      // Promise.all (pg forbids concurrent queries on the same connection).
      const totals = await client.query(TOTALS_SQL, params);
      const byDay = await client.query(BY_DAY_SQL, params);
      const top = await client.query(TOP_PRODUCTS_SQL, params);
      const expTotal = await client.query(EXPENSE_TOTAL_SQL, dateParams);
      const expCat = await client.query(EXPENSE_BY_CATEGORY_SQL, dateParams);
      const purchase = await client.query(PURCHASE_SQL, dateParams);
      const damage = await client.query(DAMAGE_SQL, params);

      const { metrics, quality } = assembleSnapshot({
        totals: totals.rows[0] || {},
        byDay: byDay.rows,
        topProducts: top.rows,
        expenseTotal: expTotal.rows[0] || {},
        expenseByCategory: expCat.rows,
        purchase: purchase.rows[0] || {},
        damage: damage.rows[0] || {},
        periodDayCount: period.days,
        asOf,
      });

      for (const m of metrics) {
        await client.query(
          `insert into public.report_snapshot_metrics
             (merchant_id, snapshot_id, metric_code, value_vnd, value_count, dimensions, dimensions_hash, coverage_status)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [merchantId, id, m.metricCode, m.valueVnd, m.valueCount, JSON.stringify(m.dimensions), m.dimensionsHash, m.coverageStatus],
        );
      }
      for (const dq of quality) {
        await client.query(
          `insert into public.report_data_quality
             (merchant_id, snapshot_id, source_type, expected_count, processed_count, open_issues, freshness_at, affected_metrics, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [merchantId, id, dq.sourceType, dq.expected, dq.processed, dq.openIssues, dq.freshnessAt, dq.affectedMetrics, dq.status],
        );
      }

      const contentHash = snapshotContentHash(
        { merchantId, periodStart: period.start, periodEnd: period.end, timezone: period.timezone, scopeHash: sHash, formulaVersion: FORMULA_VERSION },
        metrics, quality,
      );
      await client.query(`update public.report_snapshots set status='ready', content_hash=$2 where id=$1`, [id, contentHash]);
      if (supersedesId) {
        // The old snapshot stays immutable (values untouched); only its lifecycle
        // flips to 'superseded' so exactly one 'ready' revision exists per key.
        await client.query(`update public.report_snapshots set status='superseded' where id=$1 and status='ready'`, [supersedesId]);
      }

      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "report.snapshot_ready",
        entityType: "report_snapshot", entityId: id,
        after: { period: `${period.start}..${period.end}`, revision, contentHash, supersedesId },
      });
      return id;
    });

    // Read-after-write must be AFTER commit (fresh connection) — mirrors F07.
    const snapshot = await getSnapshot(merchantId, snapshotId);
    return { snapshot, ready: true, created: true, revision: snapshot.snapshot.revision };
  });

  return result;
}

// ── Read (one call powers the whole report screen) ─────────────────────────────
export async function getSnapshot(merchantId, snapshotId) {
  const head = await query(
    `select * from public.report_snapshots where id=$1 and merchant_id=$2`, [snapshotId, merchantId]);
  if (head.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy báo cáo.");
  const h = head.rows[0];

  const [metricsR, qualityR, newerR] = await Promise.all([
    query(`select metric_code, value_vnd, value_count, dimensions, dimensions_hash, coverage_status
             from public.report_snapshot_metrics where snapshot_id=$1`, [snapshotId]),
    query(`select source_type, expected_count, processed_count, open_issues, freshness_at, affected_metrics, status
             from public.report_data_quality where snapshot_id=$1`, [snapshotId]),
    // A newer revision for the same logical key → offer "Xem bản mới" (spec 2.2).
    query(`select id, revision from public.report_snapshots
             where merchant_id=$1 and period_start=$2 and period_end=$3 and timezone=$4
               and scope_hash=$5 and formula_version=$6 and revision>$7 and status in ('ready','superseded')
             order by revision desc limit 1`,
      [merchantId, isoDate(h.period_start), isoDate(h.period_end), h.timezone, h.scope_hash, h.formula_version, h.revision]),
  ]);

  return toDto(h, metricsR.rows, qualityR.rows, newerR.rows[0] || null);
}

/** PURE-ish DTO assembly from DB rows → the grouped report contract. */
function toDto(h, metricRows, qualityRows, newer) {
  const byCode = new Map();
  for (const r of metricRows) {
    const arr = byCode.get(r.metric_code) || [];
    arr.push(r);
    byCode.set(r.metric_code, arr);
  }
  const scalar = (code) => {
    const row = (byCode.get(code) || [])[0];
    return row ? { vnd: numOrNull(row.value_vnd), count: numOrNull(row.value_count), coverage: row.coverage_status } : null;
  };
  const dimRows = (code) => (byCode.get(code) || []).map((r) => ({ ...r.dimensions, valueVnd: numOrNull(r.value_vnd), valueCount: numOrNull(r.value_count), coverage: r.coverage_status }));

  const gross = scalar("sales_gross_revenue"), refund = scalar("sales_refund"), net = scalar("sales_net_revenue");
  const billCount = scalar("sales_bill_count"), billAvg = scalar("sales_bill_avg");
  const channels = dimRows("sales_by_channel").map((d) => ({ channel: d.channel, label: d.label, netVnd: d.valueVnd ?? 0 }));
  const byDay = dimRows("sales_by_day").map((d) => ({ date: d.date, netVnd: d.valueVnd ?? 0 })).sort((a, b) => a.date.localeCompare(b.date));
  const topRows = dimRows("sales_top_products").map((d) => ({ rank: d.rank, name: d.name, productId: d.productId ?? null, revenueVnd: d.valueVnd ?? 0, qty: Number(d.valueCount ?? 0) })).sort((a, b) => a.rank - b.rank);

  const opExpense = scalar("operating_expense");
  const byCategory = dimRows("expense_by_category").map((d) => ({ categoryId: d.categoryId ?? null, categoryName: d.categoryName, totalVnd: d.valueVnd ?? 0 })).sort((a, b) => b.totalVnd - a.totalVnd);
  const purchase = scalar("inventory_purchase");
  const damage = scalar("inventory_damage");
  const damageQty = (byCode.get("inventory_damage") || [])[0]?.dimensions?.quantity ?? 0;
  const cash = scalar("cash_collected");
  const estimate = scalar("operating_result_est");

  // Coverage summary
  const sources = qualityRows.map((r) => ({
    sourceType: r.source_type, label: SOURCE_LABELS[r.source_type] || r.source_type,
    expected: Number(r.expected_count), processed: Number(r.processed_count),
    openIssues: Number(r.open_issues), status: r.status,
    freshnessAt: toIso(r.freshness_at), affectedMetrics: r.affected_metrics || [],
  }));
  const items = sources.find((s) => s.sourceType === "order_items");
  const percent = items && items.expected > 0 ? Math.round((100 * items.processed) / items.expected) : 100;
  const overall = sources.every((s) => s.status === "complete") ? "complete" : "partial";
  const notes = [];
  if (items && items.expected > 0 && items.processed < items.expected) {
    notes.push(`Số liệu phủ ${percent}% — ${items.expected - items.processed} bill cũ thiếu chi tiết dòng (ảnh hưởng Top sản phẩm).`);
  }

  const topCoverage = topRows[0]?.coverage || (items ? items.status : "complete");

  return {
    snapshot: {
      id: h.id, merchantId: h.merchant_id,
      periodStart: isoDate(h.period_start), periodEnd: isoDate(h.period_end),
      periodLabel: periodLabelOf(isoDate(h.period_start), isoDate(h.period_end)),
      timezone: h.timezone, scope: h.scope, scopeHash: h.scope_hash,
      formulaVersion: h.formula_version, asOf: toIso(h.as_of), status: h.status,
      revision: h.revision, supersedesId: h.supersedes_id, contentHash: h.content_hash,
      createdAt: toIso(h.created_at), isLatest: h.status === "ready",
      newer: newer ? { id: newer.id, revision: newer.revision } : null,
    },
    sections: {
      sales: {
        grossVnd: gross?.vnd ?? 0, refundVnd: refund?.vnd ?? 0, netVnd: net?.vnd ?? 0,
        billCount: billCount?.count ?? 0, billAvgVnd: billAvg?.vnd ?? 0,
        byChannel: channels, byDay, topProducts: topRows, topCoverage,
      },
      expense: { totalVnd: opExpense?.vnd ?? 0, byCategory, coverage: opExpense?.coverage ?? "complete" },
      inventory: { purchaseVnd: purchase?.vnd ?? 0, damageCount: damage?.count ?? 0, damageQty: Number(damageQty) },
      cashflow: {
        cashCollectedVnd: cash?.vnd ?? 0, expensePaidVnd: opExpense?.vnd ?? 0,
        deltaVnd: (cash?.vnd ?? 0) - (opExpense?.vnd ?? 0),
      },
      estimate: {
        valueVnd: estimate?.vnd ?? 0, coverage: estimate?.coverage ?? "complete",
        formula: METRIC_CATALOG.operating_result_est.formula,
        disclosures: METRIC_CATALOG.operating_result_est.disclosures,
      },
    },
    coverage: { overall, percent, sources, notes },
    metrics: metricRows.map((r) => ({
      code: r.metric_code, label: metricLabel(r.metric_code),
      valueVnd: numOrNull(r.value_vnd), valueCount: numOrNull(r.value_count),
      dimensions: r.dimensions, coverage: r.coverage_status,
    })),
  };
}

function numOrNull(v) { return v == null ? null : Number(v); }
function periodLabelOf(start, end) {
  if (start === end) return `Ngày ${start}`;
  return `${start} → ${end}`;
}

// ── List (history + compare picker) ────────────────────────────────────────────
export async function listSnapshots(merchantId, { limit = 30 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const { rows } = await query(
    `select s.id, s.period_start, s.period_end, s.timezone, s.scope_hash, s.formula_version,
            s.as_of, s.status, s.revision, s.content_hash, s.created_at,
            (select value_vnd from public.report_snapshot_metrics m
               where m.snapshot_id=s.id and m.metric_code='sales_net_revenue' limit 1) as net_vnd
       from public.report_snapshots s
      where s.merchant_id=$1 and s.status in ('ready','superseded')
      order by s.period_end desc, s.as_of desc
      limit $2`, [merchantId, lim]);
  return {
    snapshots: rows.map((r) => ({
      id: r.id, periodStart: isoDate(r.period_start), periodEnd: isoDate(r.period_end),
      periodLabel: periodLabelOf(isoDate(r.period_start), isoDate(r.period_end)),
      timezone: r.timezone, scopeHash: r.scope_hash, formulaVersion: r.formula_version,
      asOf: toIso(r.as_of), status: r.status, revision: r.revision,
      contentHash: r.content_hash, createdAt: toIso(r.created_at),
      netVnd: numOrNull(r.net_vnd), days: periodDays(isoDate(r.period_start), isoDate(r.period_end)),
    })),
  };
}

// ── Compare two compatible snapshots (spec 3.6 / 4.3 / RPT-11) ──────────────────
const COMPARE_METRICS = [
  "sales_gross_revenue", "sales_net_revenue", "sales_refund", "sales_bill_count",
  "sales_bill_avg", "operating_expense", "inventory_purchase", "cash_collected", "operating_result_est",
];

export async function compareSnapshots(merchantId, baseId, compareId) {
  const [a, b] = await Promise.all([loadForCompare(merchantId, baseId), loadForCompare(merchantId, compareId)]);
  const reasons = [];
  if (a.timezone !== b.timezone) reasons.push("Khác múi giờ.");
  if (a.scope_hash !== b.scope_hash) reasons.push("Khác phạm vi (scope).");
  if (a.formula_version !== b.formula_version) reasons.push("Khác phiên bản công thức.");
  if (a.days !== b.days) reasons.push(`Khác độ dài kỳ (${a.days} vs ${b.days} ngày).`);
  if (reasons.length > 0) {
    return { compatible: false, reasons, base: a.header, compare: b.header };
  }
  const rows = COMPARE_METRICS.filter((c) => METRIC_CATALOG[c]?.value === "vnd" || c === "sales_bill_count").map((code) => {
    const isCount = METRIC_CATALOG[code]?.value === "count";
    const bv = isCount ? Number(a.scalarCount(code) ?? 0) : Number(a.scalar(code) ?? 0);
    const cv = isCount ? Number(b.scalarCount(code) ?? 0) : Number(b.scalar(code) ?? 0);
    const delta = cv - bv;
    const pct = bv !== 0 ? Math.round((100 * delta) / bv) : null; // null when base=0 (spec 4.3)
    return { code, label: metricLabel(code), valueType: isCount ? "count" : "vnd", baseValue: bv, compareValue: cv, delta, pct };
  });
  return { compatible: true, base: a.header, compare: b.header, rows };
}

async function loadForCompare(merchantId, id) {
  const head = await query(`select * from public.report_snapshots where id=$1 and merchant_id=$2`, [id, merchantId]);
  if (head.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy báo cáo để so sánh.");
  const h = head.rows[0];
  const m = await query(`select metric_code, value_vnd, value_count, dimensions_hash from public.report_snapshot_metrics where snapshot_id=$1`, [id]);
  const scalarMap = new Map();
  const countMap = new Map();
  for (const r of m.rows) {
    // scalar rows carry the empty-dimensions hash
    if (r.value_vnd != null && !scalarMap.has(r.metric_code)) scalarMap.set(r.metric_code, Number(r.value_vnd));
    if (r.value_count != null && !countMap.has(r.metric_code)) countMap.set(r.metric_code, Number(r.value_count));
  }
  return {
    timezone: h.timezone, scope_hash: h.scope_hash, formula_version: h.formula_version,
    days: periodDays(isoDate(h.period_start), isoDate(h.period_end)),
    header: {
      id: h.id, periodLabel: periodLabelOf(isoDate(h.period_start), isoDate(h.period_end)),
      periodStart: isoDate(h.period_start), periodEnd: isoDate(h.period_end), asOf: toIso(h.as_of), revision: h.revision,
    },
    scalar: (code) => scalarMap.get(code) ?? 0,
    scalarCount: (code) => countMap.get(code) ?? 0,
  };
}

// ── Drill-down: source records behind a metric, bounded by the snapshot (spec 7.1) ─
export async function drilldown(merchantId, snapshotId, opts = {}) {
  const head = await query(`select * from public.report_snapshots where id=$1 and merchant_id=$2`, [snapshotId, merchantId]);
  if (head.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy báo cáo.");
  const h = head.rows[0];
  const metric = String(opts.metric || "sales_net_revenue");
  if (!isKnownMetric(metric)) fail("VALIDATION", "Chỉ số không hợp lệ.");
  const start = isoDate(h.period_start), end = isoDate(h.period_end), tz = h.timezone;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const winParams = [merchantId, start, end, tz];

  // Sales-family metrics → the eligible bills behind them.
  if (metric.startsWith("sales_") && metric !== "sales_top_products") {
    const filters = [];
    const p = [...winParams];
    if (metric === "sales_by_day" && opts.date) { p.push(opts.date); filters.push(`to_char((timezone($4, o.paid_at))::date,'YYYY-MM-DD')=$${p.length}`); }
    let methodJoin = "";
    if (metric === "sales_by_channel" && opts.channel) {
      p.push(opts.channel);
      methodJoin = `and exists (select 1 from public.payments pm where pm.order_id=o.id and pm.method=$${p.length} and pm.status='succeeded')`;
    }
    const rowsQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select o.id, o.order_number, o.paid_at, o.total_amount
        from public.orders o, w
       where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end
         ${filters.length ? "and " + filters.join(" and ") : ""} ${methodJoin}
       order by o.paid_at desc limit ${limit}`, p);
    const totalQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select coalesce(sum(o.total_amount),0)::bigint as sum, count(*)::int as n
        from public.orders o, w
       where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end
         ${filters.length ? "and " + filters.join(" and ") : ""} ${methodJoin}`, p);
    return dd(metric, totalQ.rows[0], rowsQ.rows.map((r) => ({
      id: r.id, label: r.order_number, at: toIso(r.paid_at), amountVnd: Number(r.total_amount), route: `/don-hang/${r.id}`,
    })));
  }

  if (metric === "sales_top_products") {
    const p = [...winParams];
    let prodFilter = "";
    if (opts.productId) { p.push(opts.productId); prodFilter = `and oi.product_id=$${p.length}`; }
    const rowsQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select oi.product_id, oi.name_snapshot as name, sum(oi.quantity) as qty, sum(oi.net_amount)::bigint as revenue
        from public.order_items oi join public.orders o on o.id=oi.order_id, w
       where oi.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end ${prodFilter}
       group by oi.product_id, oi.name_snapshot order by revenue desc limit ${limit}`, p);
    const total = rowsQ.rows.reduce((s, r) => s + Number(r.revenue), 0);
    return dd(metric, { sum: total, n: rowsQ.rows.length }, rowsQ.rows.map((r) => ({
      id: r.product_id, label: r.name, qty: Number(r.qty), amountVnd: Number(r.revenue),
      route: r.product_id ? `/ton-kho/${r.product_id}` : null,
    })));
  }

  if (metric === "operating_expense" || metric === "expense_by_category" || metric === "operating_result_est") {
    const p = [merchantId, start, end];
    let catFilter = "";
    if (metric === "expense_by_category" && opts.categoryId) { p.push(opts.categoryId); catFilter = `and e.category_id=$${p.length}`; }
    else if (metric === "expense_by_category" && opts.categoryId === null) { catFilter = `and e.category_id is null`; }
    const rowsQ = await query(`
      select e.id, e.expense_number, e.expense_date, e.grand_total_vnd, e.payee_name_snapshot
        from public.expenses e
       where e.merchant_id=$1 and e.status='posted' and e.expense_date>=$2::date and e.expense_date<=$3::date ${catFilter}
       order by e.expense_date desc, e.created_at desc limit ${limit}`, p);
    const totalQ = await query(`
      select coalesce(sum(grand_total_vnd),0)::bigint as sum, count(*)::int as n from public.expenses e
       where e.merchant_id=$1 and e.status='posted' and e.expense_date>=$2::date and e.expense_date<=$3::date ${catFilter}`, p);
    return dd(metric, totalQ.rows[0], rowsQ.rows.map((r) => ({
      id: r.id, label: r.expense_number || r.payee_name_snapshot || "Khoản chi", at: isoDate(r.expense_date),
      amountVnd: Number(r.grand_total_vnd), route: `/chi-phi/${r.id}`,
    })));
  }

  if (metric === "inventory_purchase") {
    const p = [merchantId, start, end];
    const rowsQ = await query(`
      select id, receipt_number, received_at, grand_total_vnd, supplier_name_snapshot
        from public.purchase_receipts
       where merchant_id=$1 and status='posted' and received_at>=$2::date and received_at<=$3::date
       order by received_at desc limit ${limit}`, p);
    const totalQ = await query(`
      select coalesce(sum(grand_total_vnd),0)::bigint as sum, count(*)::int as n from public.purchase_receipts
       where merchant_id=$1 and status='posted' and received_at>=$2::date and received_at<=$3::date`, p);
    return dd(metric, totalQ.rows[0], rowsQ.rows.map((r) => ({
      id: r.id, label: r.receipt_number || r.supplier_name_snapshot || "Phiếu nhập", at: isoDate(r.received_at),
      amountVnd: Number(r.grand_total_vnd), route: `/nhap-hang/${r.id}`,
    })));
  }

  if (metric === "inventory_damage") {
    const rowsQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select m.id, m.product_id, m.quantity_delta, m.created_at, m.reason_code, p.name
        from public.inventory_movements m join public.products p on p.id=m.product_id, w
       where m.merchant_id=$1 and m.movement_type='damage_writeoff' and m.created_at>=w.v_start and m.created_at<w.v_end
       order by m.created_at desc limit ${limit}`, winParams);
    return dd(metric, { sum: 0, n: rowsQ.rows.length }, rowsQ.rows.map((r) => ({
      id: r.id, label: r.name, at: toIso(r.created_at), qty: Number(r.quantity_delta),
      route: `/ton-kho/${r.product_id}`,
    })));
  }

  if (metric === "cash_collected") {
    const rowsQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select p.id, p.method, p.amount, p.paid_at, p.order_id
        from public.payments p, w
       where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end
       order by p.paid_at desc limit ${limit}`, winParams);
    const totalQ = await query(`
      with w as (select (($2::date)+time '00:00') at time zone $4 as v_start, (($3::date+1)+time '00:00') at time zone $4 as v_end)
      select coalesce(sum(p.amount),0)::bigint as sum, count(*)::int as n from public.payments p, w
       where p.merchant_id=$1 and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end`, winParams);
    return dd(metric, totalQ.rows[0], rowsQ.rows.map((r) => ({
      id: r.id, label: r.method === "cash" ? "Tiền mặt" : "Chuyển khoản/QR", at: toIso(r.paid_at),
      amountVnd: Number(r.amount), route: r.order_id ? `/don-hang/${r.order_id}` : null,
    })));
  }

  fail("VALIDATION", "Chưa hỗ trợ drill-down cho chỉ số này.");
}

function dd(metric, total, rows) {
  const totalVnd = Number(total?.sum || 0);
  const totalCount = Number(total?.n || 0);
  return {
    metric, label: metricLabel(metric),
    totalVnd, totalCount,
    rows,
    truncated: rows.length < totalCount,
  };
}
