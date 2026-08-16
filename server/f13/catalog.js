// Functional 13 — the metric formula catalog (spec 4.1 / 7.2). The deployed
// schema has NO report_formula_catalog table (it was dropped from the applied
// migration), so the catalog lives here as versioned, reviewed code: one metric
// has a stable code, a Vietnamese display name, a plain-language formula, its
// source functional, a coverage gate and the disclosures that must ride with it
// (spec 10 / 11.2 — a name is never shown apart from its version + limits).
//
// Pure + side-effect-free so it is unit-testable and safe to import from the
// `node --test` suite that runs WITHOUT a database (npm test).
import { createHash } from "node:crypto";

/** The published formula-set version. Every snapshot is stamped with this and
 *  two snapshots are only comparable when their formula_version matches. */
export const FORMULA_VERSION = "VN-2026.1";

/** Canonical timezone for the pilot (spec 12.4 — single tz, VND). */
export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";

// Metric groups drive the report screen tabs (spec 2 / 3).
export const GROUP = {
  SALES: "sales",
  EXPENSE: "expenses",
  INVENTORY: "inventory",
  CASHFLOW: "cashflow",
  ESTIMATE: "estimate",
};

/**
 * The v1 metric catalog. `value` is 'vnd' | 'count'. `dimensional` metrics emit
 * one row per bucket (channel/day/category/rank); scalar metrics emit one row.
 * `mustNotCall` records the label the number is explicitly NOT (spec 4.1) so the
 * UI/AI never mislabels it (e.g. sales revenue is not "tiền đã thu").
 */
export const METRIC_CATALOG = {
  sales_gross_revenue: {
    group: GROUP.SALES, value: "vnd", displayName: "Doanh thu gộp",
    formula: "Tổng total_amount của bill đủ điều kiện (paid/refunded) trong kỳ, theo ngày kinh doanh (paid_at).",
    source: "F03", mustNotCall: "Tiền đã thu",
    disclosures: ["Ghi nhận theo thời điểm thanh toán (paid_at), múi giờ Asia/Ho_Chi_Minh."],
  },
  sales_refund: {
    group: GROUP.SALES, value: "vnd", displayName: "Hoàn tiền",
    formula: "Tổng payment_refunds.amount đã thành công (succeeded) trong kỳ.",
    source: "F03", mustNotCall: "Chi phí",
    disclosures: ["Chỉ tính hoàn tiền đã thành công; hoàn đang chờ không được tính."],
  },
  sales_net_revenue: {
    group: GROUP.SALES, value: "vnd", displayName: "Doanh thu thuần",
    formula: "Doanh thu gộp − Hoàn tiền.",
    source: "F03", mustNotCall: "Lợi nhuận",
    disclosures: ["Là doanh thu bán đã trừ hoàn tiền, chưa trừ chi phí hay giá vốn."],
  },
  sales_bill_count: {
    group: GROUP.SALES, value: "count", displayName: "Số bill",
    formula: "Số bill đủ điều kiện (paid/refunded) trong kỳ.",
    source: "F03", mustNotCall: null, disclosures: [],
  },
  sales_bill_avg: {
    group: GROUP.SALES, value: "vnd", displayName: "Bill trung bình",
    formula: "Doanh thu gộp ÷ Số bill (làm tròn đồng).",
    source: "F03", mustNotCall: null,
    disclosures: ["Bằng 0 khi kỳ chưa có bill."],
  },
  sales_by_channel: {
    group: GROUP.SALES, value: "vnd", dimensional: true, displayName: "Theo kênh thu",
    formula: "Tiền thu thuần theo phương thức (tiền mặt / chuyển khoản-QR) = thu − hoàn, đã thành công.",
    source: "F03", mustNotCall: "Doanh thu bán",
    disclosures: ["Theo phương thức thanh toán thực nhận, không phải doanh thu bán."],
  },
  sales_by_day: {
    group: GROUP.SALES, value: "vnd", dimensional: true, displayName: "Theo ngày",
    formula: "Doanh thu thuần từng ngày trong kỳ (chỉ hiện khi kỳ dài hơn 1 ngày).",
    source: "F03", mustNotCall: null, disclosures: [],
  },
  sales_top_products: {
    group: GROUP.SALES, value: "vnd", dimensional: true, displayName: "Top sản phẩm",
    formula: "5 sản phẩm doanh thu cao nhất theo dòng bill (order_items) trong kỳ.",
    source: "F03", mustNotCall: null,
    disclosures: ["Chỉ tính được từ bill có chi tiết dòng; bill cũ thiếu dòng làm độ phủ giảm."],
  },
  operating_expense: {
    group: GROUP.EXPENSE, value: "vnd", displayName: "Chi vận hành",
    formula: "Tổng grand_total_vnd của khoản chi đã ghi nhận (posted) trong kỳ, theo expense_date.",
    source: "F07", mustNotCall: "Mọi tiền chi",
    disclosures: ["Chỉ gồm khoản chi đã ghi nhận; mua hàng/nhập kho được trình bày riêng."],
  },
  expense_by_category: {
    group: GROUP.EXPENSE, value: "vnd", dimensional: true, displayName: "Chi theo nhóm",
    formula: "Chi đã ghi nhận, gộp theo nhóm chi.",
    source: "F07", mustNotCall: null, disclosures: [],
  },
  inventory_purchase: {
    group: GROUP.INVENTORY, value: "vnd", displayName: "Nhập hàng",
    formula: "Tổng grand_total_vnd của phiếu nhập đã ghi nhận (posted) trong kỳ, theo received_at.",
    source: "F06", mustNotCall: "Chi phí kỳ",
    disclosures: ["Nhập hàng không phải chi phí kỳ và KHÔNG trừ vào kết quả tạm tính."],
  },
  inventory_damage: {
    group: GROUP.INVENTORY, value: "count", displayName: "Hao hụt / hủy",
    formula: "Số bút toán damage_writeoff trong kỳ (kèm tổng số lượng).",
    source: "F05", mustNotCall: null,
    disclosures: ["Chỉ đếm số lần và số lượng; chưa quy ra tiền vì chưa có giá vốn."],
  },
  cash_collected: {
    group: GROUP.CASHFLOW, value: "vnd", displayName: "Tiền thu (bán hàng)",
    formula: "Tổng payments.amount đã thành công (tiền mặt + QR) trong kỳ.",
    source: "F03", mustNotCall: "Số dư ngân hàng",
    disclosures: ["Là tiền thu từ giao dịch SoHo, không phải số dư ngân hàng. Sổ thu–chi đầy đủ (F11) sẽ bổ sung sau."],
  },
  operating_result_est: {
    group: GROUP.ESTIMATE, value: "vnd", displayName: "Kết quả vận hành tạm tính",
    formula: "Doanh thu thuần − Chi vận hành đã ghi.",
    source: "Derived", mustNotCall: "Lợi nhuận kế toán / thuế",
    disclosures: [
      "Đây là số TẠM TÍNH, không phải lợi nhuận kế toán hay cơ sở tính thuế.",
      "Chưa gồm: giá vốn hàng bán (COGS), nhập hàng/tồn kho, khấu hao, thuế, công nợ và điều chỉnh cuối kỳ.",
    ],
  },
};

/** Human label for a metric code (falls back to the code). */
export function metricLabel(code) {
  return METRIC_CATALOG[code]?.displayName || code;
}

// ── Canonical period presets (pure calendar math on YYYY-MM-DD) ───────────────
function ymd(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toISOString().slice(0, 10);
}
function parseYmd(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return { y, m: m - 1, d };
}

/** Number of inclusive days in [start, end]. */
export function periodDays(start, end) {
  const a = parseYmd(start), b = parseYmd(end);
  const ms = Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Resolve a preset (day|week|month|quarter) around a business date (YYYY-MM-DD,
 * already in the merchant timezone) into a canonical {start, end, label, preset}.
 * "week" = Monday→Sunday containing the date; "quarter" = the 3-month quarter.
 */
export function resolvePeriod(preset, businessDate) {
  const { y, m, d } = parseYmd(businessDate);
  if (preset === "day") {
    return { preset, start: businessDate, end: businessDate, label: `Ngày ${businessDate}` };
  }
  if (preset === "week") {
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0=Sun..6=Sat
    const backToMon = (dow + 6) % 7;
    const start = new Date(Date.UTC(y, m, d - backToMon));
    const end = new Date(Date.UTC(y, m, d - backToMon + 6));
    const s = start.toISOString().slice(0, 10), e = end.toISOString().slice(0, 10);
    return { preset, start: s, end: e, label: `Tuần ${s} → ${e}` };
  }
  if (preset === "month") {
    const start = ymd(y, m, 1);
    const end = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    return { preset, start, end, label: `Tháng ${String(m + 1).padStart(2, "0")}/${y}` };
  }
  if (preset === "quarter") {
    const q = Math.floor(m / 3);
    const start = ymd(y, q * 3, 1);
    const end = new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10);
    return { preset, start, end, label: `Quý ${q + 1}/${y}` };
  }
  throw new Error(`unknown preset ${preset}`);
}

/** Stable, order-independent hash of the scope object (spec 5.1 build key). */
export function scopeHash(scope) {
  return sha256hex(canonicalJson(scope ?? {}));
}

/** Deterministic JSON with sorted keys so hashes are input-order independent. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function sha256hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}
