// Functional 15 — period + snapshot service (spec §3.1/§3.7/§3.8, §4.3, §7.1 lock
// boundary, FR-06/FR-08/FR-09/FR-12/FR-13). A period is a logical month/quarter;
// locking it freezes an immutable, versioned snapshot (watermark + coverage +
// content hash). Late sources flip the period to `attention`; a re-lock appends
// version n+1 (chain preserved) — the old snapshot is never mutated.
import { withTransaction, query } from "../db/pool.js";
import { writeAudit } from "../f3/audit.js";
import { DomainError, fail } from "../f3/errors.js";
import { runIdempotent, bodyHash } from "../f5/idem.js";
import { deterministicUuid } from "../f5/movements.js";
import { resolvePeriod } from "./period-util.js";
import { ensureCatalog } from "./catalog.js";
import { bookTotals, recordFingerprint, listBooks } from "./books.js";
import { contentHash, RULE_VERSION, CATALOG_CODE } from "./mapping.js";

/** Resolve (and lazily create) the accounting_periods row for a selector. */
export async function getOrCreatePeriod(merchantId, periodKey) {
  const p = resolvePeriod(periodKey);
  const profileId = deterministicUuid(`f15-profile:${merchantId}`);
  const ins = await query(
    `insert into public.accounting_periods
       (merchant_id, profile_version_id, period_start, period_end, timezone, status)
     values ($1,$2,$3,$4,'Asia/Ho_Chi_Minh','open')
     on conflict (merchant_id, period_start, period_end) do nothing
     returning *`,
    [merchantId, profileId, p.start, p.end]);
  let row = ins.rows[0];
  if (!row) {
    const ex = await query(
      `select * from public.accounting_periods
        where merchant_id=$1 and period_start=$2 and period_end=$3`, [merchantId, p.start, p.end]);
    row = ex.rows[0];
  }
  return { period: p, row };
}

function mapPeriodRow(p, row, snapshot) {
  return {
    id: row.id, key: p.key, kind: p.kind, label: p.label,
    start: p.start, end: p.end, timezone: row.timezone,
    status: row.status, rowVersion: row.row_version,
    currentSnapshotId: row.current_snapshot_id,
    currentVersionNo: snapshot?.version_no ?? null,
  };
}

/**
 * Coverage: expected confirmed sources in the period vs those already ingested
 * (spec §3.11 — publish expected, not just processed). Optionally pinned to a
 * watermark for a snapshot preview.
 */
export async function coverage(merchantId, p, watermark) {
  const params = [merchantId, p.tsStart, p.tsEnd, p.start, p.end];
  // The watermark constrains only the PROCESSED side (was a receipt created by the
  // as_of?). "Expected" = the source event being in the period, regardless of when
  // its receipt was built — so a late source shows as expected-but-unprocessed.
  let wmR = "";
  if (watermark) { params.push(watermark); wmR = ` and r.received_at <= $${params.length}`; }
  const { rows } = await query(
    `select
       (select count(*) from public.payments x
          where x.merchant_id=$1 and x.status='succeeded' and x.paid_at>=$2 and x.paid_at<$3)::int pay_exp,
       (select count(*) from public.payments x
          where x.merchant_id=$1 and x.status='succeeded' and x.paid_at>=$2 and x.paid_at<$3
            and exists (select 1 from public.accounting_source_receipts r
               where r.merchant_id=$1 and r.source_type='payment' and r.source_id=x.id
                 and r.event_type='payment.succeeded'${wmR}))::int pay_ok,
       (select count(*) from public.payment_refunds x
          where x.merchant_id=$1 and x.status='succeeded' and x.refunded_at>=$2 and x.refunded_at<$3)::int ref_exp,
       (select count(*) from public.payment_refunds x
          where x.merchant_id=$1 and x.status='succeeded' and x.refunded_at>=$2 and x.refunded_at<$3
            and exists (select 1 from public.accounting_source_receipts r
               where r.merchant_id=$1 and r.source_type='refund' and r.source_id=x.id
                 and r.event_type='refund.succeeded'${wmR}))::int ref_ok,
       (select count(*) from public.accounting_events x join public.expenses e on e.id=x.source_id
          where x.merchant_id=$1 and x.event_type='expense_posted'
            and e.expense_date>=$4::date and e.expense_date<=$5::date)::int exp_exp,
       (select count(*) from public.accounting_events x join public.expenses e on e.id=x.source_id
          where x.merchant_id=$1 and x.event_type='expense_posted'
            and e.expense_date>=$4::date and e.expense_date<=$5::date
            and exists (select 1 from public.accounting_source_receipts r
               where r.merchant_id=$1 and r.source_type='expense' and r.source_id=x.source_id
                 and r.event_type='expense_posted'${wmR}))::int exp_ok,
       (select count(*) from public.accounting_events x join public.purchase_receipts pr on pr.id=x.source_id
          where x.merchant_id=$1 and x.event_type='purchase_received'
            and pr.received_at>=$4::date and pr.received_at<=$5::date)::int pur_exp,
       (select count(*) from public.accounting_events x join public.purchase_receipts pr on pr.id=x.source_id
          where x.merchant_id=$1 and x.event_type='purchase_received'
            and pr.received_at>=$4::date and pr.received_at<=$5::date
            and exists (select 1 from public.accounting_source_receipts r
               where r.merchant_id=$1 and r.source_type='purchase_receipt' and r.source_id=x.source_id
                 and r.event_type='purchase_received'${wmR}))::int pur_ok
    `, params);
  const r = rows[0];
  // Receipts stuck in review/failed within the period (business-date via records).
  const bad = await query(
    `select count(distinct sr.id)::int c from public.accounting_source_receipts sr
       where sr.merchant_id=$1 and sr.status in ('review','failed')`, [merchantId]);
  const bySource = {
    payments: { expected: r.pay_exp, processed: r.pay_ok },
    refunds: { expected: r.ref_exp, processed: r.ref_ok },
    expenses: { expected: r.exp_exp, processed: r.exp_ok },
    purchases: { expected: r.pur_exp, processed: r.pur_ok },
  };
  const expected = r.pay_exp + r.ref_exp + r.exp_exp + r.pur_exp;
  const processed = r.pay_ok + r.ref_ok + r.exp_ok + r.pur_ok;
  return {
    expected, processed, missing: expected - processed, failed: bad.rows[0].c,
    pct: expected > 0 ? Math.round((processed / expected) * 100) : 100,
    complete: expected === processed, bySource,
  };
}

/** Overview screen (spec §3.1) — period state, book totals, coverage, snapshot. */
export async function getOverview(merchantId, periodKey) {
  await ensureCatalog();
  const { period, row } = await getOrCreatePeriod(merchantId, periodKey);
  const snapshot = row.current_snapshot_id
    ? (await query(`select * from public.accounting_period_snapshots where id=$1`, [row.current_snapshot_id])).rows[0]
    : null;
  const watermark = snapshot ? snapshot.source_watermark?.asOf : null;
  const cov = await coverage(merchantId, period, watermark);
  const { books } = await listBooks(merchantId, period, watermark);
  // Late records after the current snapshot's watermark (attention) — recomputed live.
  let lateCount = 0;
  if (snapshot) {
    const late = await query(
      `select count(*)::int c from public.accounting_records
        where merchant_id=$1 and status='posted' and business_date>=$2 and business_date<=$3
          and created_at > $4`, [merchantId, period.start, period.end, snapshot.source_watermark?.asOf]);
    lateCount = late.rows[0].c;
  }
  const revenue = books.find((b) => b.code === "sales_revenue")?.total || 0;
  return {
    period: mapPeriodRow(period, row, snapshot),
    catalog: { code: CATALOG_CODE, ruleVersion: RULE_VERSION },
    coverage: cov,
    books,
    revenueVnd: revenue,
    lateCount,
    canLock: cov.complete && cov.failed === 0 && row.status !== "locked",
    ruleVersion: RULE_VERSION,
    asOf: new Date().toISOString(),
  };
}

/**
 * Build the lock preview (spec §3.7). Pins asOf=now, freezes the record set,
 * computes book totals + coverage + blocking issues + a preview/content hash the
 * lock call must echo back (409 if the world changed since — ATD-07).
 */
export async function previewLock(merchantId, periodKey) {
  await ensureCatalog();
  const { period, row } = await getOrCreatePeriod(merchantId, periodKey);
  const asOfRow = await query(`select now() as now`);
  const asOf = new Date(asOfRow.rows[0].now).toISOString();

  const totals = await bookTotals(merchantId, { start: period.start, end: period.end, watermark: asOf });
  const fp = await recordFingerprint(merchantId, { start: period.start, end: period.end, watermark: asOf });
  const cov = await coverage(merchantId, period, asOf);

  const blocking = [];
  if (!cov.complete) blocking.push({ code: "SOURCES_UNPROCESSED", severity: "blocking", message: `Còn ${cov.missing} nguồn chưa được đồng bộ vào sổ.`, count: cov.missing });
  if (cov.failed > 0) blocking.push({ code: "SOURCES_FAILED", severity: "blocking", message: `Có ${cov.failed} nguồn ở trạng thái cần xem/lỗi.`, count: cov.failed });
  const warnings = [{ code: "METHOD_UNKNOWN_EXPENSE_PURCHASE", severity: "warning", message: "Chi phí và mua hàng chưa có phương thức thanh toán nên không tách vào sổ quỹ/ngân hàng." }];

  const currentVersion = row.current_snapshot_id
    ? (await query(`select version_no from public.accounting_period_snapshots where id=$1`, [row.current_snapshot_id])).rows[0]?.version_no || 0
    : 0;
  const nextVersion = currentVersion + 1;

  const books = Object.entries(totals.byBook).map(([code, t]) => ({ code, total: t.total, count: t.count }))
    .sort((a, b) => a.code.localeCompare(b.code));
  // NB: the content hash is over the FROZEN RECORD SET, NOT asOf — so re-previewing
  // an unchanged period yields the same hash (no spurious restatement), while a late
  // record changes the fingerprint → a genuine new version on re-lock.
  const previewHash = contentHash({
    period: { start: period.start, end: period.end },
    ruleVersion: RULE_VERSION, catalogCode: CATALOG_CODE,
    recordCount: totals.recordCount, recordFingerprint: fp, books,
  });

  return {
    periodId: row.id, period: { key: period.key, label: period.label, start: period.start, end: period.end, timezone: period.timezone },
    asOf, previewHash, versionNo: nextVersion, isRestatement: currentVersion > 0,
    bookTotals: books.map((b) => ({ code: b.code, total: b.total, count: b.count })),
    revenueVnd: totals.byBook.sales_revenue?.total || 0,
    recordCount: totals.recordCount, coverage: cov,
    blocking, warnings, canLock: blocking.length === 0,
    ruleVersion: RULE_VERSION, catalogCode: CATALOG_CODE,
  };
}

/**
 * Lock the period → immutable snapshot (spec §7.1 lock, FR-09). Atomic + idempotent
 * (Idempotency-Key + already-locked replay). Re-verifies the preview hash so a
 * source/catalog change since preview aborts with 409 (ATD-07). A late-source
 * re-lock appends version n+1 with previous_snapshot_id (restatement, FR-13).
 */
export async function lockPeriod(merchantId, userId, periodKey, body = {}, idemKey) {
  const hash = bodyHash({ periodKey, previewHash: body.previewHash, asOf: body.asOf });
  const { result, replayed } = await runIdempotent(`f15-lock:${merchantId}`, idemKey, hash, async () => {
    if (!body.responsibilityConfirmed) fail("VALIDATION", "Vui lòng xác nhận trách nhiệm trước khi khóa kỳ.");
    if (!body.previewHash || !body.asOf) fail("VALIDATION", "Thiếu thông tin xem trước. Vui lòng tạo lại preview.");
    const catalogId = await ensureCatalog();
    const p = resolvePeriod(periodKey);
    const profileId = deterministicUuid(`f15-profile:${merchantId}`);
    const asOf = new Date(body.asOf).toISOString();

    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `select * from public.accounting_periods where merchant_id=$1 and period_start=$2 and period_end=$3 for update`,
        [merchantId, p.start, p.end]);
      let period = rows[0];
      if (!period) {
        const ins = await client.query(
          `insert into public.accounting_periods (merchant_id, profile_version_id, period_start, period_end, timezone, status)
           values ($1,$2,$3,$4,'Asia/Ho_Chi_Minh','open') returning *`,
          [merchantId, profileId, p.start, p.end]);
        period = ins.rows[0];
      }
      // Already locked at this exact preview? → replay the current snapshot.
      if (period.current_snapshot_id) {
        const cur = await client.query(
          `select * from public.accounting_period_snapshots where id=$1`, [period.current_snapshot_id]);
        if (cur.rows[0]?.content_hash === body.previewHash) {
          return { snapshotId: cur.rows[0].id, versionNo: cur.rows[0].version_no, replayed: true };
        }
      }

      // Recompute the frozen set at the supplied asOf and re-verify the hash (ATD-07).
      const totals = await bookTotals(merchantId, { start: p.start, end: p.end, watermark: asOf });
      const fp = await recordFingerprint(merchantId, { start: p.start, end: p.end, watermark: asOf });
      const cov = await coverage(merchantId, { ...p }, asOf);
      const books = Object.entries(totals.byBook).map(([code, t]) => ({ code, total: t.total, count: t.count }))
        .sort((a, b) => a.code.localeCompare(b.code));
      const recomputed = contentHash({
        period: { start: p.start, end: p.end },
        ruleVersion: RULE_VERSION, catalogCode: CATALOG_CODE,
        recordCount: totals.recordCount, recordFingerprint: fp, books,
      });
      if (recomputed !== body.previewHash) {
        fail("VERSION_CONFLICT", "Dữ liệu vừa thay đổi so với bản xem trước. Vui lòng xem lại và tạo preview mới.", { code: "PREVIEW_STALE" });
      }
      if (!cov.complete || cov.failed > 0) {
        fail("VALIDATION", "Còn nguồn chưa xử lý, không thể khóa kỳ.", { code: "BLOCKING_ISSUES", missing: cov.missing, failed: cov.failed });
      }

      const nextNo = (await client.query(
        `select coalesce(max(version_no),0)+1 as n from public.accounting_period_snapshots where period_id=$1`,
        [period.id])).rows[0].n;
      const watermark = { asOf, recordCount: totals.recordCount, books };
      const coverageJson = { ...cov, asOf };
      const snap = await client.query(
        `insert into public.accounting_period_snapshots
           (merchant_id, period_id, version_no, source_watermark, catalog_version_id, rule_version,
            profile_version_id, coverage, content_hash, locked_by, previous_snapshot_id)
         values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10,$11) returning id, version_no`,
        [merchantId, period.id, nextNo, JSON.stringify(watermark), catalogId, RULE_VERSION,
         profileId, JSON.stringify(coverageJson), body.previewHash, userId, period.current_snapshot_id]);
      const snapshotId = snap.rows[0].id;
      await client.query(
        `update public.accounting_periods set status='locked', current_snapshot_id=$2, row_version=row_version+1
          where id=$1`, [period.id, snapshotId]);
      await writeAudit(client, {
        merchantId, actorUserId: userId, action: "accounting.period_locked",
        entityType: "accounting_period_snapshot", entityId: snapshotId,
        after: { periodId: period.id, versionNo: nextNo, contentHash: body.previewHash, revenueVnd: totals.byBook.sales_revenue?.total || 0 },
      });
      return { snapshotId, versionNo: nextNo, replayed: false, contentHash: body.previewHash };
    });
  });
  return { ...result, replayed: replayed || Boolean(result.replayed) };
}

/** List a period's snapshot version chain (spec §3.9 restatement history). */
export async function listSnapshots(merchantId, periodKey) {
  const { period, row } = await getOrCreatePeriod(merchantId, periodKey);
  const { rows } = await query(
    `select id, version_no, source_watermark, coverage, content_hash, rule_version, locked_by, locked_at, previous_snapshot_id
       from public.accounting_period_snapshots where period_id=$1 order by version_no desc`, [row.id]);
  return {
    period: mapPeriodRow(period, row, null),
    snapshots: rows.map((s) => ({
      id: s.id, versionNo: s.version_no, asOf: s.source_watermark?.asOf || null,
      recordCount: s.source_watermark?.recordCount ?? null, coverage: s.coverage,
      contentHash: s.content_hash, ruleVersion: s.rule_version,
      lockedBy: s.locked_by, lockedAt: new Date(s.locked_at).toISOString(),
      previousSnapshotId: s.previous_snapshot_id, isCurrent: s.id === row.current_snapshot_id,
    })),
  };
}

/** One snapshot with its frozen book totals (spec §3.9 read pinned version). */
export async function getSnapshot(merchantId, snapshotId) {
  const { rows } = await query(
    `select s.*, p.period_start, p.period_end, p.timezone, p.current_snapshot_id
       from public.accounting_period_snapshots s join public.accounting_periods p on p.id=s.period_id
      where s.id=$1 and s.merchant_id=$2`, [snapshotId, merchantId]);
  if (!rows.length) throw new DomainError("NOT_FOUND", "Không tìm thấy snapshot kỳ.");
  const s = rows[0];
  return {
    snapshot: {
      id: s.id, periodId: s.period_id, versionNo: s.version_no,
      periodStart: dateStr(s.period_start), periodEnd: dateStr(s.period_end), timezone: s.timezone,
      asOf: s.source_watermark?.asOf || null, watermark: s.source_watermark,
      coverage: s.coverage, contentHash: s.content_hash, ruleVersion: s.rule_version,
      catalogCode: CATALOG_CODE, lockedBy: s.locked_by, lockedAt: new Date(s.locked_at).toISOString(),
      previousSnapshotId: s.previous_snapshot_id, isCurrent: s.id === s.current_snapshot_id,
      books: s.source_watermark?.books || [],
    },
  };
}

function dateStr(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
