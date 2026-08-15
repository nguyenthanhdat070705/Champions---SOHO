// FACTS pack builder for the AI Assistant, scoped to ONE merchant (spec 4.2
// grounding: every number the model may state comes from here, computed by
// deterministic SQL — "model không được tự tổng hợp số liệu"). The window math
// mirrors the deployed F2 get_today_dashboard RPC (business day = Asia/Ho_Chi_Minh
// 00:00; gross counts orders paid today with status in ('paid','refunded'); net =
// gross − succeeded refunds today; cash/qr net split by payment method). See
// test/seed-today-dashboard.sql for the reference re-computation.
//
// The pooler bypasses RLS, so the CALLER (router → auth) must already have
// verified membership; buildFacts always filters by the passed merchantId.
import { formatVnd } from "../f3/format.js";
import { BUSINESS_MODEL_LABELS } from "./labels.js";

// ── SQL ──────────────────────────────────────────────────────────────────────
// Today snapshot (single row), F2-consistent.
const TODAY_SQL = `
with w as (
  select
    ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '00:00') at time zone 'Asia/Ho_Chi_Minh' as v_start,
    ((timezone('Asia/Ho_Chi_Minh', now())::date + 1) + time '00:00') at time zone 'Asia/Ho_Chi_Minh' as v_end
)
select
  to_char(timezone('Asia/Ho_Chi_Minh', now())::date, 'YYYY-MM-DD') as business_date,
  (select coalesce(sum(o.total_amount),0) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end) as gross,
  (select count(*) from public.orders o, w
     where o.merchant_id=$1 and o.status in ('paid','refunded') and o.paid_at>=w.v_start and o.paid_at<w.v_end) as paid_orders,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr, w
     where pr.merchant_id=$1 and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as refund,
  (select coalesce(sum(p.amount),0) from public.payments p, w
     where p.merchant_id=$1 and p.method='cash' and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as cash_in,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr join public.payments p on p.id=pr.payment_id, w
     where pr.merchant_id=$1 and p.method='cash' and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as cash_refund,
  (select coalesce(sum(p.amount),0) from public.payments p, w
     where p.merchant_id=$1 and p.method='qr' and p.status='succeeded' and p.paid_at>=w.v_start and p.paid_at<w.v_end) as qr_in,
  (select coalesce(sum(pr.amount),0) from public.payment_refunds pr join public.payments p on p.id=pr.payment_id, w
     where pr.merchant_id=$1 and p.method='qr' and pr.status='succeeded' and pr.refunded_at>=w.v_start and pr.refunded_at<w.v_end) as qr_refund,
  (select count(*) from public.payments where merchant_id=$1 and method='qr' and status='pending') as pending_qr,
  (select count(*) from public.inventory_levels il join public.products p on p.id=il.product_id
     where il.merchant_id=$1 and p.is_active and p.track_inventory and il.on_hand <= il.low_stock_threshold) as low_stock_count,
  (select count(*) from public.action_items where merchant_id=$1 and status='open') as open_action_count
`;

// Daily gross + order count over the last 14 business days (this week + last week).
const ORDERS_BY_DAY_SQL = `
select to_char((timezone('Asia/Ho_Chi_Minh', o.paid_at))::date, 'YYYY-MM-DD') as d,
       coalesce(sum(o.total_amount),0) as gross, count(*) as orders
from public.orders o
where o.merchant_id=$1 and o.status in ('paid','refunded')
  and o.paid_at >= ((timezone('Asia/Ho_Chi_Minh', now())::date - 13) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
  and o.paid_at <  ((timezone('Asia/Ho_Chi_Minh', now())::date + 1) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
group by 1`;

// Daily succeeded-refund total over the same 14-day window.
const REFUNDS_BY_DAY_SQL = `
select to_char((timezone('Asia/Ho_Chi_Minh', pr.refunded_at))::date, 'YYYY-MM-DD') as d,
       coalesce(sum(pr.amount),0) as refund
from public.payment_refunds pr
where pr.merchant_id=$1 and pr.status='succeeded'
  and pr.refunded_at >= ((timezone('Asia/Ho_Chi_Minh', now())::date - 13) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
  and pr.refunded_at <  ((timezone('Asia/Ho_Chi_Minh', now())::date + 1) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
group by 1`;

// Top 5 selling products over the last 7 days (by quantity, then revenue).
const TOP_PRODUCTS_SQL = `
select oi.name_snapshot as name, sum(oi.quantity) as qty, sum(oi.net_amount) as revenue
from public.order_items oi join public.orders o on o.id=oi.order_id
where oi.merchant_id=$1 and o.status in ('paid','refunded')
  and o.paid_at >= ((timezone('Asia/Ho_Chi_Minh', now())::date - 6) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
  and o.paid_at <  ((timezone('Asia/Ho_Chi_Minh', now())::date + 1) + time '00:00') at time zone 'Asia/Ho_Chi_Minh'
group by oi.name_snapshot
order by qty desc, revenue desc
limit 5`;

const LOW_STOCK_SQL = `
select p.name, il.on_hand, il.low_stock_threshold as threshold
from public.inventory_levels il join public.products p on p.id=il.product_id
where il.merchant_id=$1 and p.is_active and p.track_inventory and il.on_hand <= il.low_stock_threshold
order by il.on_hand asc, p.name asc
limit 5`;

const OPEN_ACTIONS_SQL = `
select title, severity, description
from public.action_items
where merchant_id=$1 and status='open'
order by severity asc, detected_at desc
limit 5`;

const STORE_SQL = `select display_name, business_model from public.merchants where id=$1`;

// ── Date helpers (pure calendar math on YYYY-MM-DD, tz-safe) ─────────────────
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
const WEEKDAY_VN = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
function weekdayVN(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return WEEKDAY_VN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
export function formatQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? String(v) : String(v).replace(/\.?0+$/, "");
}

/**
 * Pure assembler: turn raw SQL rows into the FACTS object (derived weekly numbers
 * included). Kept side-effect-free so the SQL→pack shape is unit-testable.
 */
export function assembleFacts({ store, today, ordersByDay, refundsByDay, topProducts, lowStock, openActions }) {
  const businessDate = today.business_date;
  const num = (x) => Number(x || 0);

  const gross = num(today.gross);
  const refund = num(today.refund);
  const cashNet = num(today.cash_in) - num(today.cash_refund);
  const qrNet = num(today.qr_in) - num(today.qr_refund);

  const byDay = new Map();
  for (const r of ordersByDay || []) byDay.set(r.d, { gross: num(r.gross), refund: 0, orders: num(r.orders) });
  for (const r of refundsByDay || []) {
    const e = byDay.get(r.d) || { gross: 0, refund: 0, orders: 0 };
    e.refund = num(r.refund);
    byDay.set(r.d, e);
  }
  const dayNet = (ymd) => {
    const e = byDay.get(ymd);
    return e ? e.gross - e.refund : 0;
  };

  // This-week series (oldest → today) and totals.
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const ymd = addDays(businessDate, -i);
    week.push({ date: ymd, weekday: weekdayVN(ymd), net: dayNet(ymd) });
  }
  const last7Net = week.reduce((s, d) => s + d.net, 0);
  let prev7Net = 0;
  for (let i = 13; i >= 7; i--) prev7Net += dayNet(addDays(businessDate, -i));
  const weekDelta = last7Net - prev7Net;
  const weekPct = prev7Net > 0 ? Math.round((weekDelta / prev7Net) * 100) : null;

  return {
    store: {
      name: store?.display_name || "Cửa hàng",
      businessModel: store?.business_model || null,
      businessModelLabel: store?.business_model ? BUSINESS_MODEL_LABELS[store.business_model] || null : null,
    },
    businessDate,
    today: {
      gross,
      refund,
      net: gross - refund,
      cashNet,
      qrNet,
      paidOrderCount: num(today.paid_orders),
      pendingQrCount: num(today.pending_qr),
      lowStockCount: num(today.low_stock_count),
      openActionCount: num(today.open_action_count),
    },
    yesterday: { date: addDays(businessDate, -1), net: dayNet(addDays(businessDate, -1)) },
    week: {
      series: week,
      last7Net,
      prev7Net,
      deltaAmount: weekDelta,
      deltaPercent: weekPct,
      direction: weekDelta > 0 ? "up" : weekDelta < 0 ? "down" : "flat",
    },
    topProducts: (topProducts || []).map((p) => ({
      name: p.name,
      qty: formatQty(p.qty),
      revenue: num(p.revenue),
    })),
    lowStock: (lowStock || []).map((p) => ({
      name: p.name,
      onHand: num(p.on_hand),
      threshold: num(p.threshold),
    })),
    openActions: (openActions || []).map((a) => ({
      title: a.title,
      severity: a.severity,
      description: a.description || null,
    })),
  };
}

/** Run the SQL and assemble the FACTS pack for one merchant. */
export async function buildFacts(query, merchantId) {
  const [todayR, ordersR, refundsR, topR, lowR, actionsR, storeR] = await Promise.all([
    query(TODAY_SQL, [merchantId]),
    query(ORDERS_BY_DAY_SQL, [merchantId]),
    query(REFUNDS_BY_DAY_SQL, [merchantId]),
    query(TOP_PRODUCTS_SQL, [merchantId]),
    query(LOW_STOCK_SQL, [merchantId]),
    query(OPEN_ACTIONS_SQL, [merchantId]),
    query(STORE_SQL, [merchantId]),
  ]);
  return assembleFacts({
    store: storeR.rows[0] || null,
    today: todayR.rows[0] || {},
    ordersByDay: ordersR.rows,
    refundsByDay: refundsR.rows,
    topProducts: topR.rows,
    lowStock: lowR.rows,
    openActions: actionsR.rows,
  });
}

/**
 * Render the FACTS as a compact Vietnamese text block. This is BOTH what the
 * model sees (grounding) AND the allow-list source for the number post-check — so
 * anything numeric here (formatted money, counts, quantities, dates, %, digits in
 * product names) is automatically a legal number for the reply to cite.
 */
export function factsToText(f) {
  const L = [];
  L.push(`Cửa hàng: ${f.store.name}${f.store.businessModelLabel ? ` (ngành: ${f.store.businessModelLabel})` : ""}`);
  L.push(`Ngày hôm nay: ${f.businessDate}`);
  L.push("");
  L.push("== HÔM NAY ==");
  L.push(`Doanh thu thuần (đã trừ hoàn tiền): ${formatVnd(f.today.net)}`);
  L.push(`Doanh thu gộp: ${formatVnd(f.today.gross)}`);
  L.push(`Hoàn tiền hôm nay: ${formatVnd(f.today.refund)}`);
  L.push(`Số bill đã hoàn tất: ${f.today.paidOrderCount}`);
  L.push(`Tiền mặt: ${formatVnd(f.today.cashNet)} — Chuyển khoản/QR: ${formatVnd(f.today.qrNet)}`);
  L.push(`Giao dịch QR đang chờ xác nhận: ${f.today.pendingQrCount} (chưa tính vào doanh thu)`);
  L.push(`Sản phẩm sắp hết hàng: ${f.today.lowStockCount}`);
  L.push(`Việc cần xử lý đang mở: ${f.today.openActionCount}`);
  L.push("");
  L.push(`Hôm qua (${f.yesterday.date}): doanh thu thuần ${formatVnd(f.yesterday.net)}`);
  L.push("");
  L.push("== 7 NGÀY QUA (mỗi ngày, doanh thu thuần) ==");
  for (const d of f.week.series) L.push(`${d.weekday} ${d.date}: ${formatVnd(d.net)}`);
  L.push(`Tổng 7 ngày này: ${formatVnd(f.week.last7Net)}`);
  L.push(`Tổng 7 ngày trước đó: ${formatVnd(f.week.prev7Net)}`);
  L.push(
    `So với tuần trước: ${f.week.direction === "up" ? "tăng" : f.week.direction === "down" ? "giảm" : "không đổi"} ${formatVnd(Math.abs(f.week.deltaAmount))}${f.week.deltaPercent != null ? ` (${Math.abs(f.week.deltaPercent)}%)` : ""}`,
  );
  L.push("");
  L.push("== TOP SẢN PHẨM BÁN CHẠY (7 ngày) ==");
  if (f.topProducts.length === 0) L.push("(chưa có dữ liệu bán hàng)");
  for (const p of f.topProducts) L.push(`${p.name}: ${p.qty} — doanh thu ${formatVnd(p.revenue)}`);
  L.push("");
  L.push("== SẮP HẾT HÀNG ==");
  if (f.lowStock.length === 0) L.push("(không có sản phẩm nào sắp hết)");
  for (const p of f.lowStock) L.push(`${p.name}: còn ${p.onHand} (ngưỡng ${p.threshold})`);
  L.push("");
  L.push("== VIỆC CẦN XỬ LÝ ==");
  if (f.openActions.length === 0) L.push("(không có việc nào đang mở)");
  for (const a of f.openActions) L.push(`- ${a.title}${a.description ? ` — ${a.description}` : ""}`);
  return L.join("\n");
}
