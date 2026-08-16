// Functional 13 — snapshot export (spec 3.8 / 4.2 / RPT-12). The deployed
// `documents` storage bucket accepts ONLY image mime types (image/jpeg|png|webp),
// so a CSV/XLSX cannot be stored there without a migration (out of scope). The
// pilot therefore streams the file directly through an authenticated, membership-
// checked download route while still recording a report_exports row for audit.
// Because the file is REGENERATED deterministically from the immutable snapshot,
// card/drill/export parity + hash stability are guaranteed by construction (the
// export can never drift from the numbers on screen). Repo AGENTS.md documents
// this as a deliberate cut; signed-URL object storage is the post-pilot upgrade.
import { query } from "../db/pool.js";
import { fail } from "../f3/errors.js";
import { getSnapshot } from "./snapshots.js";
import { METRIC_CATALOG } from "./catalog.js";

const BOM = "﻿"; // so Excel opens UTF-8 Vietnamese correctly

/** Escape one CSV cell + neutralize spreadsheet formula injection (spec 12.2). */
export function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // a leading formula char becomes text
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(cells) { return cells.map(csvCell).join(","); }

/**
 * PURE: build the CSV text for a snapshot DTO (the object getSnapshot returns).
 * Money is emitted as raw integer đồng (numeric in Excel, no precision loss).
 */
export function buildCsv(dto) {
  const s = dto.snapshot, sec = dto.sections, cov = dto.coverage;
  const L = [];
  L.push(row(["Báo cáo kinh doanh SoHo (bản chụp — có thể tái lập)"]));
  L.push(row(["Kỳ", s.periodLabel]));
  L.push(row(["Từ", s.periodStart, "Đến", s.periodEnd]));
  L.push(row(["Múi giờ", s.timezone]));
  L.push(row(["Mốc dữ liệu (as_of)", s.asOf]));
  L.push(row(["Phiên bản công thức", s.formulaVersion, "Bản sửa", s.revision]));
  L.push(row(["Mã đối chiếu (content hash)", s.contentHash]));
  L.push(row(["Độ phủ dữ liệu", `${cov.percent}%`, cov.overall]));
  for (const n of cov.notes) L.push(row(["Ghi chú độ phủ", n]));
  L.push("");

  L.push(row(["Nhóm", "Chỉ số", "Giá trị", "Đơn vị", "Độ phủ"]));
  const M = (label, val, unit, coverage) => L.push(row([groupLabel, label, val, unit, coverage || "complete"]));
  let groupLabel = "Bán hàng";
  M("Doanh thu gộp", sec.sales.grossVnd, "VND");
  M("Hoàn tiền", sec.sales.refundVnd, "VND");
  M("Doanh thu thuần", sec.sales.netVnd, "VND");
  M("Số bill", sec.sales.billCount, "bill");
  M("Bill trung bình", sec.sales.billAvgVnd, "VND");
  for (const c of sec.sales.byChannel) M(`Thu theo kênh — ${c.label}`, c.netVnd, "VND");
  groupLabel = "Chi vận hành";
  M("Tổng chi vận hành", sec.expense.totalVnd, "VND", sec.expense.coverage);
  for (const c of sec.expense.byCategory) M(`Chi — ${c.categoryName}`, c.totalVnd, "VND");
  groupLabel = "Mua hàng / Tồn kho";
  M("Nhập hàng (phiếu nhập)", sec.inventory.purchaseVnd, "VND");
  M("Hao hụt / hủy (số lần)", sec.inventory.damageCount, "lần");
  M("Hao hụt / hủy (số lượng)", sec.inventory.damageQty, "đơn vị");
  groupLabel = "Dòng tiền";
  M("Tiền thu (bán hàng)", sec.cashflow.cashCollectedVnd, "VND");
  M("Tiền chi (chi phí đã ghi)", sec.cashflow.expensePaidVnd, "VND");
  M("Chênh lệch tiền (tạm)", sec.cashflow.deltaVnd, "VND");
  groupLabel = "Kết quả tạm tính";
  if (sec.estimate.coverage === "unavailable") {
    L.push(row(["Kết quả tạm tính", "Kết quả vận hành tạm tính", "(chưa đủ dữ liệu)", "", "unavailable"]));
  } else {
    M("Kết quả vận hành tạm tính (ước tính)", sec.estimate.valueVnd, "VND", sec.estimate.coverage);
  }
  L.push("");

  // Top products detail
  if (sec.sales.topProducts.length) {
    L.push(row(["Top sản phẩm", "Hạng", "Tên", "Doanh thu (VND)", "Số lượng", "Độ phủ"]));
    for (const t of sec.sales.topProducts) L.push(row(["Top sản phẩm", t.rank, t.name, t.revenueVnd, t.qty, sec.sales.topCoverage]));
    L.push("");
  }
  // Daily series
  if (sec.sales.byDay.length) {
    L.push(row(["Theo ngày", "Ngày", "Doanh thu thuần (VND)"]));
    for (const d of sec.sales.byDay) L.push(row(["Theo ngày", d.date, d.netVnd]));
    L.push("");
  }

  // Data quality
  L.push(row(["Nguồn dữ liệu", "Đã xử lý", "Kỳ vọng", "Trạng thái", "Vấn đề mở", "Độ mới"]));
  for (const q of cov.sources) L.push(row([q.label, q.processed, q.expected, q.status, q.openIssues, q.freshnessAt || ""]));
  L.push("");

  // Disclosures — the estimate is NOT accounting profit (spec 11.2 / DoD)
  L.push(row(["Lưu ý"]));
  for (const d of METRIC_CATALOG.operating_result_est.disclosures) L.push(row(["", d]));
  L.push(row(["", "Trang Hôm nay là số thời gian thực; Báo cáo là bản chụp theo kỳ có thể tái lập."]));

  return BOM + L.join("\r\n") + "\r\n";
}

/**
 * Record an export job for a ready/superseded (immutable) snapshot. Idempotent by
 * (snapshot, export_type): a retry returns the existing job (spec 5.1 export key).
 */
export async function createExport(merchantId, userId, snapshotId, exportType = "csv") {
  if (exportType !== "csv") fail("VALIDATION", "Chỉ hỗ trợ xuất CSV trong bản này.");
  const snap = await query(
    `select id, status from public.report_snapshots where id=$1 and merchant_id=$2`, [snapshotId, merchantId]);
  if (snap.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy báo cáo.");
  if (!["ready", "superseded"].includes(snap.rows[0].status)) fail("VALIDATION", "Báo cáo chưa sẵn sàng để xuất.");

  const existing = await query(
    `select id from public.report_exports where merchant_id=$1 and snapshot_id=$2 and export_type=$3 order by created_at desc limit 1`,
    [merchantId, snapshotId, exportType]);
  if (existing.rows[0]) {
    return { id: existing.rows[0].id, snapshotId, exportType, status: "ready", replayed: true, downloadPath: downloadPath(merchantId, snapshotId, existing.rows[0].id) };
  }
  const ins = await query(
    `insert into public.report_exports (merchant_id, snapshot_id, export_type, status, created_by)
     values ($1,$2,$3,'ready',$4) returning id`, [merchantId, snapshotId, exportType, userId]);
  const id = ins.rows[0].id;
  return { id, snapshotId, exportType, status: "ready", replayed: false, downloadPath: downloadPath(merchantId, snapshotId, id) };
}

function downloadPath(merchantId, snapshotId, exportId) {
  return `/v1/merchants/${merchantId}/reports/snapshots/${snapshotId}/exports/${exportId}/download`;
}

/** Regenerate the CSV for a recorded export from its immutable snapshot. */
export async function getExportFile(merchantId, snapshotId, exportId) {
  const exp = await query(
    `select id, snapshot_id, export_type from public.report_exports where id=$1 and merchant_id=$2 and snapshot_id=$3`,
    [exportId, merchantId, snapshotId]);
  if (exp.rows.length === 0) fail("NOT_FOUND", "Không tìm thấy tệp xuất.");
  const dto = await getSnapshot(merchantId, snapshotId);
  const csv = buildCsv(dto);
  const filename = `bao-cao_${dto.snapshot.periodStart}_${dto.snapshot.periodEnd}_r${dto.snapshot.revision}.csv`;
  return { filename, csv, contentType: "text/csv; charset=utf-8" };
}
