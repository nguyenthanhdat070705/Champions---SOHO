-- ============================================================================
-- SoHo Functional 02 — "Trang Hôm nay" dashboard verification seed
-- ----------------------------------------------------------------------------
-- Seeds one fresh test merchant with the transaction/inventory rows for spec
-- §10 test cases MET-01..MET-07 and INV-01/INV-02, so the deployed RPC
-- public.get_today_dashboard(merchant_id, null) can be cross-checked against
-- hand-computed expectations (see the EXPECTED block below).
--
-- RUN (privileged — bypasses RLS; the client cannot INSERT these tables):
--   psql "<connection>" -v merchant_id='<your-test-merchant-uuid>' \
--        -f test/seed-today-dashboard.sql
--
-- ASSUMPTIONS
--   * :merchant_id is a real merchant the test account owns, created by
--     Functional 01 (so merchant_settings exists; MVP default timezone
--     Asia/Ho_Chi_Minh, business_day_start 00:00).
--   * Seed and dashboard verification happen on the SAME Asia/Ho_Chi_Minh
--     calendar day (timestamps are anchored to noon HCM today / yesterday, far
--     from the midnight business-day boundary).
--   * The merchant is otherwise empty (no prior orders/payments/products), so
--     the aggregates below are exactly the seeded contributions.
--   * Idempotent: re-running deletes the SEED-* rows first, then re-inserts.
--
-- ============================================================================
-- EXPECTED get_today_dashboard(:merchant_id, null) AFTER THIS SEED
-- ----------------------------------------------------------------------------
--   grossSalesAmount : 950000     (MET-01 500000 + MET-03 300000 + MET-07 150000)
--   refundAmount     : 250000     (MET-06 100000 + MET-07 150000)
--   netSalesAmount   : 700000     (950000 - 250000)
--   cashNetAmount    : 400000     (cash pay 500000+150000=650000  - cash refund 100000+150000=250000)
--   qrNetAmount      : 300000     (qr pay 300000 - qr refund 0)
--   paidOrderCount   : 3          (O1 paid, O3 paid, O7 refunded — all paid_at TODAY; O6 paid YESTERDAY excluded)
--   lowStockCount    : 2          (PA on_hand=threshold, PC on_hand<threshold; PB untracked & PD healthy excluded)
--   openActionCount  : 0          (no action_items seeded)
--   pendingQrCount   : 1          (MET-02 QR pending)
--   attentionCount   : 3          (lowStock 2 + openActions 0 + pendingQr 1)
--   Invariant checks : cashNet + qrNet = netSales (400000+300000=700000) ✓
--                      netSales = gross - refund (950000-250000=700000)   ✓
--
-- Per-case expectation (spec §10):
--   MET-01 cash paid today            → gross+500000, count+1, cash+500000
--   MET-02 QR pending                 → revenue+0, pendingQr+1 (order not counted)
--   MET-03 QR succeeded today         → gross+300000, count+1, qr+300000 (counted once)
--   MET-04 duplicate QR webhook       → asserted rejected by one_successful_payment_per_order
--   MET-05 cancelled bill             → revenue+0 (nothing)
--   MET-06 refund today, bill yesterday → today gross+0, refund+100000, cash-100000 (net -100000)
--   MET-07 full refund today, bill today → gross+150000, refund+150000, net 0 (cash +150000-150000=0)
--   INV-01 on_hand = threshold        → counts as low stock
--   INV-02 product not tracking kho   → NOT counted as low stock
-- ============================================================================

\set ON_ERROR_STOP on

-- Fixed UUIDs so refunds/duplicate-webhook assertions can reference their rows.
-- (11..=orders, 22..=payments, 33..=refunds, 44..=products)

-- ── Clean any previous run of this seed (idempotent) ────────────────────────
delete from public.payment_refunds
 where merchant_id = :'merchant_id'
   and id in ('33333333-3333-3333-3333-333333330006',
              '33333333-3333-3333-3333-333333330007');
delete from public.payments
 where merchant_id = :'merchant_id'
   and order_id in ('11111111-1111-1111-1111-111111110001',
                    '11111111-1111-1111-1111-111111110002',
                    '11111111-1111-1111-1111-111111110003',
                    '11111111-1111-1111-1111-111111110005',
                    '11111111-1111-1111-1111-111111110006',
                    '11111111-1111-1111-1111-111111110007');
delete from public.orders
 where merchant_id = :'merchant_id'
   and id in ('11111111-1111-1111-1111-111111110001',
              '11111111-1111-1111-1111-111111110002',
              '11111111-1111-1111-1111-111111110003',
              '11111111-1111-1111-1111-111111110005',
              '11111111-1111-1111-1111-111111110006',
              '11111111-1111-1111-1111-111111110007');
delete from public.inventory_levels
 where merchant_id = :'merchant_id'
   and product_id in ('44444444-4444-4444-4444-444444440001',
                      '44444444-4444-4444-4444-444444440002',
                      '44444444-4444-4444-4444-444444440003',
                      '44444444-4444-4444-4444-444444440004');
delete from public.products
 where merchant_id = :'merchant_id'
   and id in ('44444444-4444-4444-4444-444444440001',
              '44444444-4444-4444-4444-444444440002',
              '44444444-4444-4444-4444-444444440003',
              '44444444-4444-4444-4444-444444440004');

-- ── Orders (paid_at anchored to noon HCM today / yesterday) ─────────────────
insert into public.orders
  (id, merchant_id, order_number, status, subtotal_amount, discount_amount, total_amount, paid_at)
values
  -- MET-01: cash bill paid today
  ('11111111-1111-1111-1111-111111110001', :'merchant_id', 'SEED-MET01', 'paid',
   500000, 0, 500000,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-02: QR bill still pending (no revenue)
  ('11111111-1111-1111-1111-111111110002', :'merchant_id', 'SEED-MET02', 'payment_pending',
   200000, 0, 200000, null),
  -- MET-03: QR bill succeeded today
  ('11111111-1111-1111-1111-111111110003', :'merchant_id', 'SEED-MET03', 'paid',
   300000, 0, 300000,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-05: cancelled bill (no revenue)
  ('11111111-1111-1111-1111-111111110005', :'merchant_id', 'SEED-MET05', 'cancelled',
   250000, 0, 250000, null),
  -- MET-06: bill PAID YESTERDAY (partial refund arrives today) — stays 'paid'
  ('11111111-1111-1111-1111-111111110006', :'merchant_id', 'SEED-MET06', 'paid',
   400000, 0, 400000,
   ((timezone('Asia/Ho_Chi_Minh', now())::date - 1) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-07: bill paid today, then fully refunded today
  ('11111111-1111-1111-1111-111111110007', :'merchant_id', 'SEED-MET07', 'refunded',
   150000, 0, 150000,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh');

-- ── Payments ────────────────────────────────────────────────────────────────
insert into public.payments
  (id, merchant_id, order_id, method, status, amount, provider, provider_transaction_ref, paid_at)
values
  -- MET-01 cash succeeded today
  ('22222222-2222-2222-2222-222222220001', :'merchant_id',
   '11111111-1111-1111-1111-111111110001', 'cash', 'succeeded', 500000, null, null,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-02 qr pending (no paid_at, no revenue) → drives pendingQrCount
  ('22222222-2222-2222-2222-222222220002', :'merchant_id',
   '11111111-1111-1111-1111-111111110002', 'qr', 'pending', 200000, 'payos', 'SEED-QR-PENDING-02', null),
  -- MET-03 qr succeeded today
  ('22222222-2222-2222-2222-222222220003', :'merchant_id',
   '11111111-1111-1111-1111-111111110003', 'qr', 'succeeded', 300000, 'payos', 'SEED-QR-OK-03',
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-06 cash succeeded YESTERDAY (its refund lands today)
  ('22222222-2222-2222-2222-222222220006', :'merchant_id',
   '11111111-1111-1111-1111-111111110006', 'cash', 'succeeded', 400000, null, null,
   ((timezone('Asia/Ho_Chi_Minh', now())::date - 1) + time '12:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-07 cash succeeded today (fully refunded today)
  ('22222222-2222-2222-2222-222222220007', :'merchant_id',
   '11111111-1111-1111-1111-111111110007', 'cash', 'succeeded', 150000, null, null,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '12:00') at time zone 'Asia/Ho_Chi_Minh');

-- ── Refunds (refunded_at anchored to TODAY) ─────────────────────────────────
insert into public.payment_refunds
  (id, merchant_id, payment_id, order_id, amount, status, reason, provider_refund_ref, refunded_at)
values
  -- MET-06 partial refund today for yesterday's cash bill
  ('33333333-3333-3333-3333-333333330006', :'merchant_id',
   '22222222-2222-2222-2222-222222220006', '11111111-1111-1111-1111-111111110006',
   100000, 'succeeded', 'Trả hàng một phần', null,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '13:00') at time zone 'Asia/Ho_Chi_Minh'),
  -- MET-07 full refund today for today's cash bill
  ('33333333-3333-3333-3333-333333330007', :'merchant_id',
   '22222222-2222-2222-2222-222222220007', '11111111-1111-1111-1111-111111110007',
   150000, 'succeeded', 'Hoàn toàn bộ', null,
   ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '13:00') at time zone 'Asia/Ho_Chi_Minh');

-- ── MET-04: a duplicate QR webhook must NOT create a second succeeded payment.
-- The one_successful_payment_per_order unique index (spec §7.2) guarantees this;
-- assert it here so the seed run proves idempotency rather than just asserting it.
do $$
begin
  insert into public.payments
    (merchant_id, order_id, method, status, amount, provider, provider_transaction_ref, paid_at)
  values
    (:'merchant_id', '11111111-1111-1111-1111-111111110003', 'qr', 'succeeded', 300000,
     'payos', 'SEED-QR-DUP-04', now());
  raise exception 'MET-04 FAILED: a second succeeded payment was allowed for one order';
exception
  when unique_violation then
    raise notice 'MET-04 OK: duplicate succeeded QR payment rejected (idempotent)';
end $$;

-- ── Products + inventory (INV-01 / INV-02, plus two coverage rows) ──────────
insert into public.products (id, merchant_id, name, sku, track_inventory, is_active)
values
  -- INV-01: tracked, active — on_hand = threshold (boundary → LOW)
  ('44444444-4444-4444-4444-444444440001', :'merchant_id', 'Nước suối 500ml', 'SEED-SKU-A', true, true),
  -- INV-02: NOT tracking inventory → must be EXCLUDED from low-stock
  ('44444444-4444-4444-4444-444444440002', :'merchant_id', 'Túi nilon', 'SEED-SKU-B', false, true),
  -- extra: tracked, active, clearly below threshold → LOW (enriches top-3 list)
  ('44444444-4444-4444-4444-444444440003', :'merchant_id', 'Đường trắng 1kg', 'SEED-SKU-C', true, true),
  -- extra: tracked, active, healthy stock → EXCLUDED
  ('44444444-4444-4444-4444-444444440004', :'merchant_id', 'Muối 1kg', 'SEED-SKU-D', true, true);

insert into public.inventory_levels (merchant_id, product_id, on_hand, low_stock_threshold)
values
  (:'merchant_id', '44444444-4444-4444-4444-444444440001', 5, 5),    -- INV-01: equal → LOW
  (:'merchant_id', '44444444-4444-4444-4444-444444440002', 0, 10),   -- INV-02: untracked → excluded
  (:'merchant_id', '44444444-4444-4444-4444-444444440003', 2, 10),   -- LOW (2 < 10)
  (:'merchant_id', '44444444-4444-4444-4444-444444440004', 50, 10);  -- healthy → excluded

-- ============================================================================
-- Direct re-computation of the snapshot (mirrors the RPC window math, but runs
-- under privileged access without the RPC's has_merchant_role check). Compare
-- this row to the EXPECTED block above; the client also verifies via the RPC.
-- Window = [today 00:00 HCM, tomorrow 00:00 HCM) — MVP default business day.
-- ============================================================================
with w as (
  select
    ((timezone('Asia/Ho_Chi_Minh', now())::date) + time '00:00') at time zone 'Asia/Ho_Chi_Minh' as v_start,
    ((timezone('Asia/Ho_Chi_Minh', now())::date + 1) + time '00:00') at time zone 'Asia/Ho_Chi_Minh' as v_end
),
g as (
  select coalesce(sum(total_amount),0) gross, count(*) paid_orders
  from public.orders o, w
  where o.merchant_id = :'merchant_id' and o.status in ('paid','refunded')
    and o.paid_at >= w.v_start and o.paid_at < w.v_end
),
r as (
  select coalesce(sum(amount),0) refund
  from public.payment_refunds pr, w
  where pr.merchant_id = :'merchant_id' and pr.status = 'succeeded'
    and pr.refunded_at >= w.v_start and pr.refunded_at < w.v_end
),
cash as (
  select
    coalesce((select sum(p.amount) from public.payments p, w
              where p.merchant_id = :'merchant_id' and p.method='cash' and p.status='succeeded'
                and p.paid_at >= w.v_start and p.paid_at < w.v_end),0)
  - coalesce((select sum(pr.amount) from public.payment_refunds pr
              join public.payments p on p.id = pr.payment_id, w
              where pr.merchant_id = :'merchant_id' and p.method='cash' and pr.status='succeeded'
                and pr.refunded_at >= w.v_start and pr.refunded_at < w.v_end),0) as cash_net
),
qr as (
  select
    coalesce((select sum(p.amount) from public.payments p, w
              where p.merchant_id = :'merchant_id' and p.method='qr' and p.status='succeeded'
                and p.paid_at >= w.v_start and p.paid_at < w.v_end),0)
  - coalesce((select sum(pr.amount) from public.payment_refunds pr
              join public.payments p on p.id = pr.payment_id, w
              where pr.merchant_id = :'merchant_id' and p.method='qr' and pr.status='succeeded'
                and pr.refunded_at >= w.v_start and pr.refunded_at < w.v_end),0) as qr_net
),
low as (
  select count(*) low_stock
  from public.inventory_levels il
  join public.products pr on pr.id = il.product_id
  where il.merchant_id = :'merchant_id' and pr.is_active and pr.track_inventory
    and il.on_hand <= il.low_stock_threshold
),
pend as (
  select count(*) pending_qr
  from public.payments
  where merchant_id = :'merchant_id' and method='qr' and status='pending'
),
act as (
  select count(*) open_actions
  from public.action_items
  where merchant_id = :'merchant_id' and status='open'
)
select
  g.gross                                  as gross_expected_950000,
  r.refund                                 as refund_expected_250000,
  g.gross - r.refund                       as net_expected_700000,
  cash.cash_net                            as cash_net_expected_400000,
  qr.qr_net                                as qr_net_expected_300000,
  g.paid_orders                            as paid_order_expected_3,
  low.low_stock                            as low_stock_expected_2,
  act.open_actions                         as open_action_expected_0,
  pend.pending_qr                          as pending_qr_expected_1,
  (low.low_stock + act.open_actions + pend.pending_qr) as attention_expected_3
from g, r, cash, qr, low, pend, act;
