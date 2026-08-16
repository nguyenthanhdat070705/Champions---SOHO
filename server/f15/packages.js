// Functional 15 — tax data package builder (spec §3.6, FR-07, §7.1 build boundary).
// From a LOCKED period snapshot it assembles the quarterly/monthly "tờ khai" data
// set: retail revenue by channel, the 1-tỷ cumulative-year threshold split, and
// the estimated GTGT 1% + TNCN 0.5% on the over-threshold portion — every line
// carrying a source_index + legal note. It is data preparation, NOT a filed
// return and NOT a final tax figure (the UI must label it as such). Deterministic:
// the same snapshot rebuilds byte-identical lines/hash (idempotent on the unique).
import { query } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { resolvePeriod, yearToStart } from "./period-util.js";
import {
  computeThresholdSplit, contentHash, EXEMPT_THRESHOLD_VND,
  RULE_VERSION, CATALOG_CODE, GTGT_RATE, TNCN_RATE,
} from "./mapping.js";

const DEFINITION_CODE = "tax-data-hkd-retail";
const DEFINITION_VERSION = RULE_VERSION;
const DISCLAIMER = "Số liệu chuẩn bị — KHÔNG phải tờ khai đã nộp và KHÔNG phải số thuế phải nộp cuối cùng. Cần kế toán/CQT xác nhận.";

/** Sum of net sales_revenue in [start,end] pinned to the snapshot watermark. */
async function revenueIn(merchantId, start, end, watermark, extraWhere = "", extraParams = []) {
  const params = [merchantId, start, end, watermark, ...extraParams];
  const { rows } = await query(
    `select coalesce(sum(amount_vnd),0)::bigint total, count(*)::int n
       from public.accounting_records
      where merchant_id=$1 and book_code='sales_revenue' and status='posted'
        and business_date>=$2 and business_date<=$3 and created_at<=$4${extraWhere}`, params);
  return { total: Number(rows[0].total), count: rows[0].n };
}

/** Revenue by channel dimension (cash | bank | unknown) for the period. */
async function revenueByChannel(merchantId, start, end, watermark) {
  const { rows } = await query(
    `select coalesce(dimensions->>'channel','unknown') channel,
            coalesce(sum(amount_vnd),0)::bigint total, count(*)::int n
       from public.accounting_records
      where merchant_id=$1 and book_code='sales_revenue' and status='posted'
        and business_date>=$2 and business_date<=$3 and created_at<=$4
      group by 1`, [merchantId, start, end, watermark]);
  const out = { cash: 0, bank: 0, unknown: 0 };
  for (const r of rows) out[r.channel] = (out[r.channel] || 0) + Number(r.total);
  return out;
}

/**
 * Build (or replay) the tax data package for a locked snapshot. Idempotent on the
 * (period_snapshot_id, definition_code, definition_version) unique.
 */
export async function buildPackage(merchantId, userId, snapshotId, idemKey) {
  const snap = await query(
    `select s.*, p.period_start, p.period_end from public.accounting_period_snapshots s
       join public.accounting_periods p on p.id=s.period_id
      where s.id=$1 and s.merchant_id=$2`, [snapshotId, merchantId]);
  if (!snap.rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy snapshot kỳ.");
  const s = snap.rows[0];
  const watermark = s.source_watermark?.asOf;
  if (!watermark) fail("VALIDATION", "Snapshot thiếu watermark.");

  const start = dateStr(s.period_start), end = dateStr(s.period_end);
  const period = resolvePeriod(start.slice(0, 7)); // month key; quarter still bounded by start/end below
  // Prior cumulative revenue this calendar year (year-start .. day before period start).
  const yts = yearToStart({ year: Number(start.slice(0, 4)), start });
  const prior = (yts.end < yts.start)
    ? { total: 0, count: 0 }
    : await revenueIn(merchantId, yts.start, yts.end, watermark);

  const periodRev = await revenueIn(merchantId, start, end, watermark);
  const channels = await revenueByChannel(merchantId, start, end, watermark);
  const split = computeThresholdSplit(prior.total, periodRev.total);

  const srcIndex = { bookCode: "sales_revenue", periodStart: start, periodEnd: end, watermark, recordCount: periodRev.count };
  const lines = [
    line(1, "revenue_total", "Doanh thu bán hàng, dịch vụ trong kỳ", periodRev.total, srcIndex, "TT 152/2025 — sổ doanh thu"),
    line(2, "revenue_cash", "— Trong đó: thu tiền mặt", channels.cash, { ...srcIndex, channel: "cash" }, "Sổ quỹ tiền mặt"),
    line(3, "revenue_bank", "— Trong đó: chuyển khoản/QR", channels.bank, { ...srcIndex, channel: "bank" }, "Sổ ngân hàng"),
    line(4, "revenue_platform", "— Trong đó: qua sàn TMĐT", 0, { channel: "platform" }, "NĐ 117/2025 — chưa có kênh sàn trong SoHo, để 0"),
    line(5, "revenue_prior_cumulative", "Doanh thu lũy kế từ đầu năm (trước kỳ)", prior.total, { periodStart: yts.start, periodEnd: yts.end, watermark }, "Lũy kế năm dương lịch"),
    line(6, "revenue_new_cumulative", "Doanh thu lũy kế đến hết kỳ", split.newCumulativeVnd, srcIndex, "Cơ sở xét ngưỡng 1 tỷ/năm"),
    line(7, "exempt_portion", "Phần doanh thu trong ngưỡng miễn (≤ 1 tỷ lũy kế)", split.exemptPortionVnd, srcIndex, "NĐ 141/2026 — ngưỡng miễn 1 tỷ/năm"),
    line(8, "taxable_portion", "Phần doanh thu vượt ngưỡng (chịu thuế ước tính)", split.taxablePortionVnd, srcIndex, "NĐ 141/2026 — phần vượt 1 tỷ"),
    line(9, "gtgt_estimate", `Thuế GTGT ước tính (${(GTGT_RATE * 100).toFixed(0)}% × phần vượt)`, split.gtgtEstimateVnd, { basisVnd: split.taxablePortionVnd, rate: GTGT_RATE }, "Ước tính — cần CQT xác nhận"),
    line(10, "tncn_estimate", `Thuế TNCN ước tính (${(TNCN_RATE * 100).toFixed(1)}% × phần vượt)`, split.tncnEstimateVnd, { basisVnd: split.taxablePortionVnd, rate: TNCN_RATE }, "Ước tính — cần CQT xác nhận"),
    line(11, "total_estimate", "Tổng thuế ước tính (GTGT + TNCN)", split.totalEstimateVnd, {}, "Ước tính — không phải số phải nộp cuối cùng"),
  ];
  const totals = {
    revenueVnd: periodRev.total,
    priorCumulativeVnd: prior.total,
    newCumulativeVnd: split.newCumulativeVnd,
    thresholdVnd: EXEMPT_THRESHOLD_VND,
    exemptPortionVnd: split.exemptPortionVnd,
    taxablePortionVnd: split.taxablePortionVnd,
    gtgtEstimateVnd: split.gtgtEstimateVnd,
    tncnEstimateVnd: split.tncnEstimateVnd,
    totalEstimateVnd: split.totalEstimateVnd,
    channels,
  };
  const coverage = s.coverage || {};
  const chash = contentHash({ snapshotId, definitionCode: DEFINITION_CODE, definitionVersion: DEFINITION_VERSION, lines, totals });

  // Idempotent insert (or replay the existing package).
  const ins = await query(
    `insert into public.tax_data_packages
       (merchant_id, period_snapshot_id, definition_code, definition_version, status, coverage, totals, content_hash, created_by)
     values ($1,$2,$3,$4,'ready',$5::jsonb,$6::jsonb,$7,$8)
     on conflict (period_snapshot_id, definition_code, definition_version) do nothing
     returning id`,
    [merchantId, snapshotId, DEFINITION_CODE, DEFINITION_VERSION, JSON.stringify(coverage), JSON.stringify(totals), chash, userId]);
  let packageId = ins.rows[0]?.id;
  let replayed = false;
  if (!packageId) {
    const ex = await query(
      `select id from public.tax_data_packages where period_snapshot_id=$1 and definition_code=$2 and definition_version=$3`,
      [snapshotId, DEFINITION_CODE, DEFINITION_VERSION]);
    packageId = ex.rows[0].id;
    replayed = true;
  } else {
    for (const ln of lines) {
      await query(
        `insert into public.tax_data_package_lines
           (merchant_id, package_id, definition_code, sequence_no, value_json, source_index)
         values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         on conflict (package_id, definition_code, sequence_no) do nothing`,
        [merchantId, packageId, ln.code, ln.sequenceNo, JSON.stringify(ln.valueJson), JSON.stringify(ln.sourceIndex)]);
    }
  }
  return { packageId, replayed, contentHash: chash };
}

function line(seq, code, label, amountVnd, sourceIndex, legalNote) {
  return { sequenceNo: seq, code, valueJson: { label, amountVnd, legalNote }, sourceIndex };
}

/** Read a package + lines for the UI (spec §3.6). */
export async function getPackage(merchantId, packageId) {
  const { rows } = await query(
    `select * from public.tax_data_packages where id=$1 and merchant_id=$2`, [packageId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy gói dữ liệu thuế.");
  const pkg = rows[0];
  const lines = await query(
    `select definition_code, sequence_no, value_json, source_index
       from public.tax_data_package_lines where package_id=$1 order by sequence_no`, [packageId]);
  return {
    package: {
      id: pkg.id, snapshotId: pkg.period_snapshot_id,
      definitionCode: pkg.definition_code, definitionVersion: pkg.definition_version,
      status: pkg.status, coverage: pkg.coverage, totals: pkg.totals,
      contentHash: pkg.content_hash, catalogCode: CATALOG_CODE, ruleVersion: RULE_VERSION,
      createdAt: new Date(pkg.created_at).toISOString(),
    },
    lines: lines.rows.map((l) => ({
      code: l.definition_code, sequenceNo: l.sequence_no,
      label: l.value_json?.label, amountVnd: l.value_json?.amountVnd ?? null,
      legalNote: l.value_json?.legalNote ?? null, sourceIndex: l.source_index,
    })),
    disclaimer: DISCLAIMER,
  };
}

/** Find or build the package for a snapshot (used by the read + export paths). */
export async function getOrBuildPackage(merchantId, userId, snapshotId) {
  const ex = await query(
    `select id from public.tax_data_packages where period_snapshot_id=$1 and definition_code=$2 and definition_version=$3`,
    [snapshotId, DEFINITION_CODE, DEFINITION_VERSION]);
  if (ex.rows.length) return ex.rows[0].id;
  const { packageId } = await buildPackage(merchantId, userId, snapshotId);
  return packageId;
}

export { DEFINITION_CODE, DEFINITION_VERSION, DISCLAIMER };

function dateStr(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
