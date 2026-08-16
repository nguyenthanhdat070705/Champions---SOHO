// Functional 12 — the deterministic reconciliation rule catalog (spec 4.1 / 6
// REC-FR-02). Each rule is a pure description + a SQL detector over the merchant's
// own F03/F05/F06/F07 data (read-only). The engine (engine.js) runs every rule in
// one transaction, fingerprints each match and materialises issues + evidence.
//
// A rule NEVER mutates source data. Impact is a FIXED, explainable property of the
// rule (spec 3.2). Adding a new source (cashbook entries, e-invoices) later is one
// more entry here — the engine is source-agnostic.
//
// Contract per rule:
//   id            stable rule code (part of the fingerprint)
//   family        issue_type bucket (spec 4.1): missing|duplicate|amount_mismatch|
//                 state_mismatch|orphan
//   impact        low|medium|high — deterministic, drives queue ordering
//   title         short Vietnamese label for the issue card
//   explain(f)    human copy for the detail callout, given the evidence facts
//   command       the owner-service handoff command this issue maps to (recorded
//                 as an intent; MVP does NOT auto-execute — evidence-first)
//   actionHint    what tapping "Xử lý" will guide the user to do
//   detectSql     $1=merchantId, $2=as_of → rows of mismatches
//   recheckSql    $1=merchantId, $2=entityId → 0/1 row (live invariant, uses now())
//   map(row)      → { entityKey, source:{type,id,version}, facts, deepLink }
export const RULE_VERSION = "VN-2026.1";

const n = (v) => (v == null ? 0 : Number(v));

/** Deep-link keys the client resolves to a route (mirrors the F10 registry idea). */
function orderLink(id) { return { kind: "order", route: `/don-hang/${id}` }; }
function productLink(id) { return { kind: "product", route: `/ton-kho/${id}` }; }
function receiptLink(id) { return { kind: "receipt", route: `/nhap-hang/${id}` }; }
function expenseLink(id) { return { kind: "expense", route: `/chi-phi/${id}` }; }

export const RULES = [
  // 1 ── A bill marked Paid/Refunded with NO successful payment behind it. The
  // most dangerous mismatch: revenue counted with no money captured (spec 4.1
  // missing). High impact.
  {
    id: "ORDER_PAID_NO_PAYMENT",
    family: "missing",
    impact: "high",
    title: "Bill đã thu nhưng thiếu khoản thu",
    explain: (f) =>
      `Bill ${f.orderNumber} ở trạng thái “${f.orderStatus}” nhưng không có khoản thanh toán thành công nào. Doanh thu đang được tính mà chưa có tiền vào.`,
    command: "create_missing_payment",
    actionHint: "Mở bill để ghi nhận khoản thu còn thiếu hoặc điều chỉnh trạng thái.",
    detectSql: `
      select o.id, o.order_number, o.total_amount, o.status, o.paid_at, o.version
        from public.orders o
       where o.merchant_id = $1 and o.created_at <= $2
         and o.status in ('paid','refunded')
         and not exists (select 1 from public.payments p
                           where p.order_id = o.id and p.status = 'succeeded')`,
    recheckSql: `
      select o.id, o.order_number, o.total_amount, o.status, o.paid_at, o.version
        from public.orders o
       where o.merchant_id = $1 and o.id = $2
         and o.status in ('paid','refunded')
         and not exists (select 1 from public.payments p
                           where p.order_id = o.id and p.status = 'succeeded')`,
    map: (r) => ({
      entityKey: `order:${r.id}`,
      source: { type: "order", id: r.id, version: n(r.version) },
      facts: {
        orderId: r.id, orderNumber: r.order_number, orderStatus: r.status,
        totalAmount: n(r.total_amount), capturedTotal: 0, paidAt: r.paid_at,
      },
      deepLink: orderLink(r.id),
    }),
  },

  // 2 ── A successful payment whose bill is NOT paid/refunded (draft, awaiting,
  // cancelled). Money captured with no revenue recognised (spec 4.1 state_mismatch).
  {
    id: "PAYMENT_ON_UNPAID_ORDER",
    family: "state_mismatch",
    impact: "high",
    title: "Có khoản thu nhưng bill chưa chốt",
    explain: (f) =>
      `Có khoản thu thành công ${f.amount.toLocaleString("vi-VN")}đ nhưng bill ${f.orderNumber} đang ở trạng thái “${f.orderStatus}”. Tiền đã vào mà bill chưa được ghi nhận.`,
    command: "review_payment_state",
    actionHint: "Mở bill để chốt trạng thái hoặc kiểm tra lại khoản thu.",
    detectSql: `
      select p.id, p.order_id, p.amount, p.method, p.paid_at,
             o.order_number, o.status as order_status
        from public.payments p
        join public.orders o on o.id = p.order_id
       where p.merchant_id = $1 and p.created_at <= $2
         and p.status = 'succeeded'
         and o.status not in ('paid','refunded')`,
    recheckSql: `
      select p.id, p.order_id, p.amount, p.method, p.paid_at,
             o.order_number, o.status as order_status
        from public.payments p
        join public.orders o on o.id = p.order_id
       where p.merchant_id = $1 and p.id = $2
         and p.status = 'succeeded'
         and o.status not in ('paid','refunded')`,
    map: (r) => ({
      entityKey: `payment:${r.id}`,
      source: { type: "payment", id: r.id, version: 1 },
      facts: {
        paymentId: r.id, orderId: r.order_id, orderNumber: r.order_number,
        orderStatus: r.order_status, amount: n(r.amount), method: r.method, paidAt: r.paid_at,
      },
      deepLink: orderLink(r.order_id),
    }),
  },

  // 3 ── A paid/refunded bill whose captured payments don't sum to the bill total
  // (spec 4.1 amount_mismatch). The engine shows BOTH numbers; it never picks a
  // "correct" side (spec 4.1 / product decision).
  {
    id: "ORDER_PAYMENT_TOTAL_MISMATCH",
    family: "amount_mismatch",
    impact: "medium",
    title: "Tổng thu lệch tổng bill",
    explain: (f) =>
      `Bill ${f.orderNumber} có tổng ${f.totalAmount.toLocaleString("vi-VN")}đ nhưng tổng đã thu là ${f.capturedTotal.toLocaleString("vi-VN")}đ (lệch ${Math.abs(f.diff).toLocaleString("vi-VN")}đ).`,
    command: "review_payment_amount",
    actionHint: "Đối chiếu khoản thu với tổng bill và điều chỉnh ở đúng bản ghi gốc.",
    detectSql: `
      select o.id, o.order_number, o.total_amount, o.status, o.version,
             coalesce(sum(p.amount) filter (where p.status='succeeded'),0) as captured
        from public.orders o
        left join public.payments p on p.order_id = o.id
       where o.merchant_id = $1 and o.created_at <= $2
         and o.status in ('paid','refunded')
       group by o.id, o.order_number, o.total_amount, o.status, o.version
      having coalesce(sum(p.amount) filter (where p.status='succeeded'),0) > 0
         and coalesce(sum(p.amount) filter (where p.status='succeeded'),0) <> o.total_amount`,
    recheckSql: `
      select o.id, o.order_number, o.total_amount, o.status, o.version,
             coalesce(sum(p.amount) filter (where p.status='succeeded'),0) as captured
        from public.orders o
        left join public.payments p on p.order_id = o.id
       where o.merchant_id = $1 and o.id = $2
         and o.status in ('paid','refunded')
       group by o.id, o.order_number, o.total_amount, o.status, o.version
      having coalesce(sum(p.amount) filter (where p.status='succeeded'),0) > 0
         and coalesce(sum(p.amount) filter (where p.status='succeeded'),0) <> o.total_amount`,
    map: (r) => ({
      entityKey: `order:${r.id}`,
      source: { type: "order", id: r.id, version: n(r.version) },
      facts: {
        orderId: r.id, orderNumber: r.order_number, orderStatus: r.status,
        totalAmount: n(r.total_amount), capturedTotal: n(r.captured),
        diff: n(r.captured) - n(r.total_amount),
      },
      deepLink: orderLink(r.id),
    }),
  },

  // 4 ── Stock on-hand disagrees with the sum of its immutable movement ledger
  // (spec 4.1 amount_mismatch, but on inventory). High impact — stock integrity.
  {
    id: "INVENTORY_LEDGER_DRIFT",
    family: "amount_mismatch",
    impact: "high",
    title: "Tồn kho lệch sổ chuyển động",
    explain: (f) =>
      `“${f.productName || "Sản phẩm"}” đang hiển thị tồn ${f.onHand} nhưng sổ chuyển động cộng lại là ${f.ledgerSum} (lệch ${f.diff}).`,
    command: "post_inventory_adjustment",
    actionHint: "Mở sổ tồn để kiểm kê / điều chỉnh cho khớp sổ chuyển động.",
    // The ledger sum is bounded by as_of ($2) for snapshot consistency; on_hand is
    // the current level (movements after as_of can't exist inside the run txn).
    detectSql: `
      select il.product_id, il.on_hand, il.row_version,
             coalesce(sum(m.quantity_delta),0) as ledger_sum, pr.name as product_name
        from public.inventory_levels il
        left join public.inventory_movements m
               on m.merchant_id = il.merchant_id and m.product_id = il.product_id
              and m.created_at <= $2
        left join public.products pr on pr.id = il.product_id
       where il.merchant_id = $1
       group by il.product_id, il.on_hand, il.row_version, pr.name
      having il.on_hand <> coalesce(sum(m.quantity_delta),0)`,
    recheckSql: `
      select il.product_id, il.on_hand, il.row_version,
             coalesce(sum(m.quantity_delta),0) as ledger_sum, pr.name as product_name
        from public.inventory_levels il
        left join public.inventory_movements m
               on m.merchant_id = il.merchant_id and m.product_id = il.product_id
        left join public.products pr on pr.id = il.product_id
       where il.merchant_id = $1 and il.product_id = $2
       group by il.product_id, il.on_hand, il.row_version, pr.name
      having il.on_hand <> coalesce(sum(m.quantity_delta),0)`,
    map: (r) => ({
      entityKey: `product:${r.product_id}`,
      source: { type: "product", id: r.product_id, version: n(r.row_version) },
      facts: {
        productId: r.product_id, productName: r.product_name,
        onHand: n(r.on_hand), ledgerSum: n(r.ledger_sum), diff: n(r.on_hand) - n(r.ledger_sum),
      },
      deepLink: productLink(r.product_id),
    }),
  },

  // 5 ── A posted purchase receipt with no accounting_event behind it (spec 4.1
  // missing). The receipt raised stock but never handed off to the books.
  {
    id: "RECEIPT_POSTED_NO_EVENT",
    family: "missing",
    impact: "medium",
    title: "Phiếu nhập thiếu bút toán",
    explain: (f) =>
      `Phiếu nhập ${f.receiptNumber} (${f.grandTotalVnd.toLocaleString("vi-VN")}đ) đã ghi nhận nhưng chưa có bút toán kế toán tương ứng.`,
    command: "repost_receipt_event",
    actionHint: "Mở phiếu nhập để kiểm tra và tạo lại bút toán còn thiếu.",
    detectSql: `
      select r.id, r.receipt_number, r.grand_total_vnd, r.status, r.row_version, r.posted_at
        from public.purchase_receipts r
       where r.merchant_id = $1 and r.created_at <= $2
         and r.status = 'posted'
         and not exists (select 1 from public.accounting_events e
                           where e.source_type='purchase_receipt' and e.source_id=r.id
                             and e.event_type='purchase_received')`,
    recheckSql: `
      select r.id, r.receipt_number, r.grand_total_vnd, r.status, r.row_version, r.posted_at
        from public.purchase_receipts r
       where r.merchant_id = $1 and r.id = $2
         and r.status = 'posted'
         and not exists (select 1 from public.accounting_events e
                           where e.source_type='purchase_receipt' and e.source_id=r.id
                             and e.event_type='purchase_received')`,
    map: (r) => ({
      entityKey: `receipt:${r.id}`,
      source: { type: "purchase_receipt", id: r.id, version: n(r.row_version) },
      facts: {
        receiptId: r.id, receiptNumber: r.receipt_number,
        grandTotalVnd: n(r.grand_total_vnd), postedAt: r.posted_at,
      },
      deepLink: receiptLink(r.id),
    }),
  },

  // 6 ── A QR payment stuck pending past its expiry / age. Low impact (housekeeping)
  // but it inflates "đang chờ" and can hide a real capture (spec 4.1 state_mismatch).
  {
    id: "STALE_PENDING_QR",
    family: "state_mismatch",
    impact: "low",
    title: "Mã QR treo quá hạn",
    explain: (f) =>
      `Khoản thu QR ${f.amount.toLocaleString("vi-VN")}đ cho bill ${f.orderNumber} vẫn đang chờ và đã quá hạn. Hãy kiểm tra đã nhận tiền hay chưa.`,
    command: "reconcile_stale_qr",
    actionHint: "Mở bill để đối chiếu trạng thái QR (đã nhận / hủy).",
    detectSql: `
      select p.id, p.order_id, p.amount, p.method, p.created_at, p.expires_at,
             o.order_number, o.status as order_status
        from public.payments p
        join public.orders o on o.id = p.order_id
       where p.merchant_id = $1 and p.status = 'pending'
         and ((p.expires_at is not null and p.expires_at < $2)
              or p.created_at < ($2 - interval '30 minutes'))`,
    recheckSql: `
      select p.id, p.order_id, p.amount, p.method, p.created_at, p.expires_at,
             o.order_number, o.status as order_status
        from public.payments p
        join public.orders o on o.id = p.order_id
       where p.merchant_id = $1 and p.id = $2 and p.status = 'pending'
         and ((p.expires_at is not null and p.expires_at < now())
              or p.created_at < (now() - interval '30 minutes'))`,
    map: (r) => ({
      entityKey: `payment:${r.id}`,
      source: { type: "payment", id: r.id, version: 1 },
      facts: {
        paymentId: r.id, orderId: r.order_id, orderNumber: r.order_number,
        orderStatus: r.order_status, amount: n(r.amount), method: r.method,
        createdAt: r.created_at, expiresAt: r.expires_at,
      },
      deepLink: orderLink(r.order_id),
    }),
  },

  // 7 ── A posted expense with no accounting_event (spec 4.1 missing). Symmetric to
  // rule 5; future-proof for when F07 posts expenses into the books.
  {
    id: "EXPENSE_POSTED_NO_EVENT",
    family: "missing",
    impact: "medium",
    title: "Khoản chi thiếu bút toán",
    explain: (f) =>
      `Khoản chi ${f.expenseNumber} (${f.grandTotalVnd.toLocaleString("vi-VN")}đ) đã ghi nhận nhưng chưa có bút toán kế toán tương ứng.`,
    command: "repost_expense_event",
    actionHint: "Mở khoản chi để kiểm tra và tạo lại bút toán còn thiếu.",
    detectSql: `
      select e.id, e.expense_number, e.grand_total_vnd, e.status, e.row_version, e.posted_at
        from public.expenses e
       where e.merchant_id = $1 and e.created_at <= $2
         and e.status = 'posted'
         and not exists (select 1 from public.accounting_events a
                           where a.source_type='expense' and a.source_id=e.id
                             and a.event_type='expense_posted')`,
    recheckSql: `
      select e.id, e.expense_number, e.grand_total_vnd, e.status, e.row_version, e.posted_at
        from public.expenses e
       where e.merchant_id = $1 and e.id = $2
         and e.status = 'posted'
         and not exists (select 1 from public.accounting_events a
                           where a.source_type='expense' and a.source_id=e.id
                             and a.event_type='expense_posted')`,
    map: (r) => ({
      entityKey: `expense:${r.id}`,
      source: { type: "expense", id: r.id, version: n(r.row_version) },
      facts: {
        expenseId: r.id, expenseNumber: r.expense_number,
        grandTotalVnd: n(r.grand_total_vnd), postedAt: r.posted_at,
      },
      deepLink: expenseLink(r.id),
    }),
  },
];

export const RULES_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));

/** Valid issue families (issue_type allowlist, spec 4.1). */
export const FAMILIES = ["missing", "duplicate", "amount_mismatch", "state_mismatch", "orphan"];
export const IMPACTS = ["low", "medium", "high"];
