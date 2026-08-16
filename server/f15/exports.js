// Functional 15 — export artifacts (spec §3.8, FR-10, Phụ lục A6). Serialises a
// LOCKED snapshot's books, or its tax data package, into a deterministic CSV
// (UTF-8 + BOM so Excel opens it; CRLF; VND as bare integers; ISO dates). The same
// snapshot + scope + format_version always produces byte-identical output → a
// stable content hash (ATD-10/ATD-11). An `accounting_exports` row records the
// artifact + hash; the download route regenerates and re-verifies the hash before
// streaming (integrity, no long-lived signed URL stored — the pilot cut).
import { query } from "../db/pool.js";
import { DomainError, fail } from "../f3/errors.js";
import { toCsv, byteHash, bookShort, BOOK_CODES, FORMAT_VERSION, RULE_VERSION, CATALOG_CODE } from "./mapping.js";
import { getPackage, getOrBuildPackage } from "./packages.js";

/** Load a locked snapshot with its period bounds. */
async function loadSnapshot(merchantId, snapshotId) {
  const { rows } = await query(
    `select s.*, p.period_start, p.period_end from public.accounting_period_snapshots s
       join public.accounting_periods p on p.id=s.period_id
      where s.id=$1 and s.merchant_id=$2`, [snapshotId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy snapshot kỳ.");
  return rows[0];
}

function scopeKey(scope) {
  if (scope.kind === "book") return `book-${scope.bookCode}`;
  if (scope.kind === "package") return "package";
  return "all-books";
}

/** Render the deterministic CSV string for a snapshot + scope. */
async function renderCsv(merchantId, userId, snap, scope) {
  const watermark = snap.source_watermark?.asOf;
  const start = dateStr(snap.period_start), end = dateStr(snap.period_end);

  if (scope.kind === "package") {
    const packageId = await getOrBuildPackage(merchantId, userId, snap.id);
    const { package: pkg, lines } = await getPackage(merchantId, packageId);
    const rows = [
      ["Gói dữ liệu thuế", pkg.definitionCode, "phiên bản", pkg.definitionVersion],
      ["Kỳ", `${start} → ${end}`, "as_of", watermark],
      ["Rule/Catalog", RULE_VERSION, CATALOG_CODE, `hash ${pkg.contentHash}`],
      [],
      ["STT", "Chỉ tiêu", "Giá trị (VND)", "Căn cứ"],
      ...lines.map((l) => [l.sequenceNo, l.label, l.amountVnd ?? "", l.legalNote ?? ""]),
    ];
    return toCsv(rows);
  }

  // Book ledger export(s): every posted record in the frozen set.
  const codes = scope.kind === "book" ? [scope.bookCode] : BOOK_CODES;
  const params = [merchantId, start, end, watermark, codes];
  const { rows: recs } = await query(
    `select r.book_code, r.business_date, r.amount_vnd, r.dimensions, r.rule_version,
            sr.source_type, sr.source_id
       from public.accounting_records r
       left join public.accounting_record_sources s on s.record_id=r.id and s.relation='primary'
       left join public.accounting_source_receipts sr on sr.id=s.source_receipt_id
      where r.merchant_id=$1 and r.status='posted' and r.business_date>=$2 and r.business_date<=$3
        and r.created_at<=$4 and r.book_code = any($5)
      order by r.book_code, r.business_date, r.id`, params);
  const rows = [
    ["Sổ kế toán — xuất từ snapshot", snap.id, "as_of", watermark],
    ["Kỳ", `${start} → ${end}`, "Rule", RULE_VERSION],
    [],
    ["Sổ", "Ngày", "Diễn giải", "Số tiền (VND)", "Nguồn", "Mã nguồn"],
    ...recs.map((r) => [
      bookShort(r.book_code), dateStr(r.business_date), flowLabel(r.dimensions),
      Number(r.amount_vnd), r.source_type || "", r.source_id || "",
    ]),
  ];
  return toCsv(rows);
}

/**
 * Create (or replay) an export artifact for a snapshot. Only locked snapshots can
 * be exported. CSV only in the pilot (xlsx/pdf/json are documented cuts).
 */
export async function createExport(merchantId, userId, { snapshotId, scope, format = "csv" } = {}) {
  if (format !== "csv") fail("VALIDATION", "Chỉ hỗ trợ định dạng CSV trong bản thử nghiệm.");
  const sc = scope && scope.kind ? scope : { kind: "all_books" };
  if (sc.kind === "book" && !BOOK_CODES.includes(sc.bookCode)) fail("VALIDATION", "Sổ không hợp lệ.");
  const snap = await loadSnapshot(merchantId, snapshotId);

  const csv = await renderCsv(merchantId, userId, snap, sc);
  const chash = byteHash(csv);
  const objectKey = `f15/${merchantId}/${snapshotId}/${scopeKey(sc)}.v${FORMAT_VERSION}.csv`;

  // Idempotent: an export with the same object_key + hash replays (deterministic).
  const ex = await query(
    `select id, content_hash from public.accounting_exports
       where merchant_id=$1 and period_snapshot_id=$2 and object_key=$3 order by created_at desc limit 1`,
    [merchantId, snapshotId, objectKey]);
  if (ex.rows.length && ex.rows[0].content_hash === chash) {
    return { exportId: ex.rows[0].id, objectKey, contentHash: chash, format, replayed: true };
  }
  const ins = await query(
    `insert into public.accounting_exports
       (merchant_id, package_id, period_snapshot_id, format, format_version, object_key, content_hash, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [merchantId, null, snapshotId, format, FORMAT_VERSION, objectKey, chash, userId]);
  return { exportId: ins.rows[0].id, objectKey, contentHash: chash, format, replayed: false, scope: sc };
}

/** List a snapshot's exports (spec §3.8 file list). */
export async function listExports(merchantId, snapshotId) {
  const { rows } = await query(
    `select id, format, format_version, object_key, content_hash, created_at
       from public.accounting_exports where merchant_id=$1 and period_snapshot_id=$2
      order by created_at desc`, [merchantId, snapshotId]);
  return {
    exports: rows.map((r) => ({
      id: r.id, format: r.format, formatVersion: r.format_version, objectKey: r.object_key,
      contentHash: r.content_hash, createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

/**
 * Regenerate + verify + return the CSV bytes for a download (auth-gated, short
 * request; a stored bucket object + signed URL is the documented pilot cut). A
 * hash mismatch (should never happen — records are immutable) fails closed.
 */
export async function getExportContent(merchantId, userId, exportId) {
  const { rows } = await query(
    `select * from public.accounting_exports where id=$1 and merchant_id=$2`, [exportId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy tệp xuất.");
  const e = rows[0];
  const snap = await loadSnapshot(merchantId, e.period_snapshot_id);
  const scope = e.object_key.includes("/package.")
    ? { kind: "package" }
    : e.object_key.includes("/all-books.")
      ? { kind: "all_books" }
      : { kind: "book", bookCode: e.object_key.split("/book-")[1]?.split(".")[0] };
  const csv = await renderCsv(merchantId, userId, snap, scope);
  if (byteHash(csv) !== e.content_hash) {
    fail("VALIDATION", "Tệp xuất không còn khớp hash. Vui lòng tạo lại.", { code: "EXPORT_HASH_MISMATCH" });
  }
  const filename = `${scopeKey(scope)}-${dateStr(snap.period_start)}.csv`;
  return { filename, contentType: "text/csv; charset=utf-8", body: csv };
}

function flowLabel(dims) {
  switch (dims?.flow) {
    case "sale": return "Doanh thu bán hàng";
    case "sales_return": return "Giảm trừ doanh thu (hoàn tiền)";
    case "receipt": return "Thu tiền bán hàng";
    case "payment": return "Chi hoàn tiền";
    case "expense": return "Chi phí kinh doanh";
    case "purchase": return "Mua hàng nhập kho";
    default: return "";
  }
}
function dateStr(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
