// Pure dashboard logic for Functional 02 "Trang Hôm nay": the snapshot shape,
// the priority-item derivation (FR-06), and the zero-state selection (spec 2.2).
// No Supabase / React imports here so it stays trivially unit-testable — the
// data-access lives in db.ts and the rendering in the dashboard/ components.

/**
 * The snapshot returned by the `get_today_dashboard` RPC (spec 7.5 / 8.1).
 * All amounts are whole đồng (bigint in the DB, plain number over JSON — VND
 * daily totals are far below Number.MAX_SAFE_INTEGER).
 */
export interface DashboardSnapshot {
  merchantId: string;
  businessDate: string; // "YYYY-MM-DD"
  grossSalesAmount: number;
  refundAmount: number;
  netSalesAmount: number;
  cashNetAmount: number;
  qrNetAmount: number;
  paidOrderCount: number;
  lowStockCount: number;
  openActionCount: number;
  pendingQrCount: number;
  attentionCount: number;
  dataFreshAt: string; // ISO timestamptz
}

export type ActionSeverity = "critical" | "warning" | "info";

/** DB `action_type` enum (spec 6.6). */
export type ActionType =
  | "payment_provider"
  | "setup_incomplete"
  | "data_sync"
  | "other";

/** An open action_items row, already mapped to camelCase by db.ts. */
export interface OpenAction {
  id: string;
  actionType: ActionType | string;
  severity: ActionSeverity;
  title: string;
  description?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  detectedAt?: string | null;
}

export type PriorityKind = "action" | "pending_qr" | "low_stock";

/** A single "Việc cần xử lý" row, ready to render + navigate. */
export interface PriorityItem {
  key: string;
  kind: PriorityKind;
  severity: ActionSeverity;
  /** P1 (critical) < P2 (warning) < P3 (info) — spec 2.3. */
  priority: 1 | 2 | 3;
  title: string;
  desc: string;
  /** Route to the screen that resolves this item. */
  to: string;
  entityId?: string | null;
}

const SEVERITY_PRIORITY: Record<ActionSeverity, 1 | 2 | 3> = {
  critical: 1,
  warning: 2,
  info: 3,
};

/**
 * Where an action_items row should navigate. Uses action_type as the primary
 * signal (spec 6.6): payment/setup issues resolve in settings, data-sync issues
 * in the orders list. Unknown types fall back to settings.
 */
export function actionNavTarget(actionType: string): string {
  switch (actionType) {
    case "payment_provider":
      return "/cai-dat";
    case "setup_incomplete":
      return "/cai-dat";
    case "data_sync":
      return "/don-hang";
    default:
      return "/cai-dat";
  }
}

/**
 * Build the up-to-3 "Việc cần xử lý" list from the snapshot counts + the open
 * action_items rows (FR-06). Items are ordered by severity (P1→P3); within a
 * severity the original order is preserved (action rows arrive pre-sorted by
 * severity then detected_at desc from db.ts, synthetic QR/stock items append).
 * Only the top `limit` (default 3) are returned.
 */
export function derivePriorityItems(
  snapshot: Pick<DashboardSnapshot, "pendingQrCount" | "lowStockCount">,
  actions: OpenAction[],
  limit = 3,
): PriorityItem[] {
  const items: PriorityItem[] = [];

  for (const a of actions) {
    const severity: ActionSeverity = a.severity ?? "info";
    items.push({
      key: `action:${a.id}`,
      kind: "action",
      severity,
      priority: SEVERITY_PRIORITY[severity] ?? 3,
      title: a.title,
      desc: a.description?.trim() || defaultActionDesc(a.actionType),
      to: actionNavTarget(a.actionType),
      entityId: a.entityId ?? null,
    });
  }

  if (snapshot.pendingQrCount > 0) {
    items.push({
      key: "pending_qr",
      kind: "pending_qr",
      severity: "warning",
      priority: 2,
      title: `${snapshot.pendingQrCount} giao dịch QR đang chờ xác nhận`,
      desc: "Chưa được tính vào doanh thu. Kiểm tra khi có xác nhận.",
      to: "/don-hang",
    });
  }

  if (snapshot.lowStockCount > 0) {
    items.push({
      key: "low_stock",
      kind: "low_stock",
      severity: "info",
      priority: 3,
      title: `${snapshot.lowStockCount} sản phẩm sắp hết hàng`,
      desc: "Kiểm tra tồn kho và nhập thêm hàng.",
      to: "/kho",
    });
  }

  // Stable sort by priority; keep insertion order within a priority band.
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.priority - b.it.priority || a.i - b.i)
    .map(({ it }) => it)
    .slice(0, limit);
}

function defaultActionDesc(actionType: string): string {
  switch (actionType) {
    case "payment_provider":
      return "Kết nối thanh toán cần kiểm tra.";
    case "setup_incomplete":
      return "Hoàn tất thiết lập cửa hàng.";
    case "data_sync":
      return "Dữ liệu cần đồng bộ lại.";
    default:
      return "Cần bạn kiểm tra.";
  }
}

/**
 * Which revenue state the dashboard is in, from the snapshot alone (spec 2.2).
 *  - "has_data"     : real revenue activity today (incl. a refund-only, so net
 *                     may be 0 or negative) → show the numbers.
 *  - "pending_only" : no confirmed revenue yet but a QR is pending → "Chưa có
 *                     doanh thu được xác nhận".
 *  - "fresh"        : nothing has happened today → "Hôm nay chưa có giao dịch".
 * The offline state is orthogonal (driven by the fetch, not the snapshot).
 */
export type RevenueState = "has_data" | "pending_only" | "fresh";

export function selectZeroState(
  s: Pick<
    DashboardSnapshot,
    "grossSalesAmount" | "refundAmount" | "paidOrderCount" | "pendingQrCount"
  >,
): RevenueState {
  const hasRevenueActivity =
    s.grossSalesAmount !== 0 || s.refundAmount !== 0 || s.paidOrderCount > 0;
  if (hasRevenueActivity) return "has_data";
  if (s.pendingQrCount > 0) return "pending_only";
  return "fresh";
}

/**
 * Cash/QR structure as percentages of the (non-negative) confirmed total, for
 * the ratio bar. When there is nothing positive to split, returns 0/0 so the
 * bar renders empty rather than dividing by zero.
 */
export function cashQrSplit(
  s: Pick<DashboardSnapshot, "cashNetAmount" | "qrNetAmount">,
): { cashPct: number; qrPct: number } {
  const cash = Math.max(0, s.cashNetAmount);
  const qr = Math.max(0, s.qrNetAmount);
  const total = cash + qr;
  if (total <= 0) return { cashPct: 0, qrPct: 0 };
  const cashPct = Math.round((cash / total) * 100);
  return { cashPct, qrPct: 100 - cashPct };
}
